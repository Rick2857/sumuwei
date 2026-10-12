import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, sep } from 'node:path'
const [mode, sandboxId, inputPath, outputPath, arm = 'A', controlFlag = ''] = process.argv.slice(2)
if (!sandboxId || !/^[a-z0-9-]+$/.test(sandboxId)) throw new Error('Isolated worker identity required')
const sandbox = isolateDatabase('m111-behavior', { runId: sandboxId, keep: true })
const local = resolve('artifacts/m11.1/local')
if (!inputPath || !outputPath || ![inputPath, outputPath].every(path => resolve(path).startsWith(local + sep))) throw new Error('Private worker files required')
const control = controlFlag === 'control'
if (!control && process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Test model wrapper required')
import { createM4Harness } from './m4-harness.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { createLateWriteFence } from '../src/kernel/app/reflection/late-write-fence.ts'
import { runConfiguredReflectionTail } from '../src/infrastructure/runtime/reflection-runtime.ts'
import { createOpenAiReflectionDraftProvider } from '../src/infrastructure/model/openai-reflection.ts'
import { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } from '../src/kernel/contracts/reflection.ts'
import { appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { listReflectionRecords } from '../src/infrastructure/persistence/reflection-store.ts'
import { listAdaptiveSelfStates } from '../src/infrastructure/persistence/adaptive-self-store.ts'
import { invalidateReflectionSources } from '../src/infrastructure/runtime/reflection-invalidation.ts'
import { readCurrentReflectionFactPack, readUsableAdaptiveSelfStates } from '../src/infrastructure/runtime/reflection-current-state.ts'
import { getConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { getTrace } from '../src/infrastructure/persistence/trace-store.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { callModelText } from '../src/infrastructure/runtime/adapters.ts'
import { applyResponseTruthPolicy } from '../src/kernel/app/memory/response-truth.ts'
import { applyActionClaimGuard } from '../src/kernel/action/claim-guard.ts'
import { applyCommitmentClaimGuard, commitmentWriteFacts } from '../src/kernel/app/goal/claim-guard.ts'
import { applyExternalEvidenceReplyPolicy, searchFactOf } from '../src/kernel/action/external-evidence-reply.ts'
import { applySearchNeedReplyPolicy, searchNeedDiagnosticsOf } from '../src/kernel/action/search-need-reply.ts'
import { openM111ModelBatch } from './m11.1-model-batch.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'

interface Input {
  caseId: string; slot: string; class: string; preparation: string[]; followup: string; round: number
  semanticSha256: string; behaviorSha256: string; rootIds?: string[]; memoryId?: string; baselineFingerprint?: string
}
async function main() {
  const input = JSON.parse(readFileSync(inputPath!, 'utf8')) as Input
  if (input.slot === 'recheck_goal_before_next_step') throw new Error('Goal slot requires M10.1 WP4 integration; this collector covers the other two slots')
  const h = await createM4Harness({ label: `m111-pair-${input.caseId}-r${input.round}` })
  const fence = createLateWriteFence(), abort = new AbortController()
  const batch = control ? undefined : openM111ModelBatch({ semantic: input.semanticSha256, behavior: input.behaviorSha256 })
  const actualProvider = createOpenAiReflectionDraftProvider()
  let preparationRequests = 0
  const provider = { name: control ? 'offline-behavior-control' : actualProvider.name, version: actualProvider.version,
    promptVersion: control ? 'm111-offline-control-prompt@1' : actualProvider.promptVersion,
    async call(call: ReflectionDraftCall) {
      if (control) return { schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION, scope: REFLECTION_DRAFT_SCOPE,
        focusQuestion: '如何处理含糊对象或更正？', explanation: '隔离控制候选，不是正式模型输出。',
        supportHandles: call.handles.map(row => row.id), counterHandles: [], suggestedSlot: input.slot }
      const finish = await batch!.reserveWhenAvailable(mode === 'short' ? 'short' : 'preparation', `${input.caseId}:r${input.round}:${arm}`)
      preparationRequests++
      try { const result = await actualProvider.call(call); finish('returned'); return result }
      catch (error) { finish('transport_failed'); throw error }
    },
  }
  const tick = (reflectionEnabled: boolean, adaptiveEnabled: boolean) => runConfiguredReflectionTail(h.db, {
    characterId: h.kernel.characterId, activeUserId: h.userId, reflectionEnabled, adaptiveEnabled, provider, fence, signal: abort.signal,
  })
  let output: unknown
  let cleanClose = false
  try {
    if (mode === 'seed' || mode === 'short') {
      await tick(true, true) // Establish the isolated open boundary before new feedback.
      const roots: string[] = []
      const recorders = [0, 1].map(i => new ConversationRecorder({ db: h.db, characterId: h.kernel.characterId,
        conversationId: asConversationId(`${input.caseId}-r${input.round}-preparation-${i}`), dryRun: false,
        userId: h.userId, userName: 'Alex', characterName: '苏沐薇', transport: 'm111-behavior-synthetic-console',
        attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
      }))
      for (let i = 0; i < 3; i++) {
        const recorder = recorders[i % 2]!
        const recorded = await recorder.recordUserMessage(input.preparation[i]!, input.class === 'authority' ? Math.floor(i / 2) * 2 + 1 : Math.floor(i / 2) + 1)
        if (!recorded.event) throw new Error('Preparation root missing')
        if (input.class === 'authority') {
          const own = await recorder.recordAssistantMessage({ text: '我自行推测用户已经完成了；没有用户报告作为依据。',
            conversationSequence: Math.floor(i / 2) * 2 + 2, characterSequence: recorded.assistantSequence!, replyToEventId: recorded.event.id })
          roots.push(String(own!.id))
        } else roots.push(String(recorded.event.id))
      }
      let memoryId: string | undefined
      if (input.class === 'withdrawn') {
        const memory = await h.commitAndFold(h.makeCandidate('person_fact', { kind: 'claim', subject: h.user, predicate: 'm111.behavior.old.feedback', value: '先核对对象或更正' } as never,
          { sourceRefs: [{ kind: 'conversation_event', id: roots[0]! }] }), Date.now())
        if (!memory) throw new Error('Withdrawn-source preparation was not accepted')
        memoryId = String(memory.id)
      }
      // Fixture trigger links real recorded experiences. It does not assert an actual Goal lifecycle.
      await appendDomainEvent(h.db, h.kernel.characterId, { type: 'GOAL_COMPLETED', operation: 'm111-behavior-fixture-trigger',
        payload: { goalId: `goal:synthetic-trigger:${input.caseId}`, basis: 'user_report', expectedRevision: 1 }, sourceConversationEventIds: roots as never,
        idempotencyKey: `m111-behavior-trigger:${input.caseId}`, processor: 'm111-behavior-fixture', processorVersion: 'm111-behavior@1', scope: 'CHARACTER_INTERNAL' })
      output = { rootIds: roots, memoryId, sandboxDirectory: sandbox.dir }
      if (mode === 'short') {
        const scheduling = await tick(true, true)
        const records = await listReflectionRecords(h.db, h.kernel.characterId)
        output = { ...(output as Record<string, unknown>), scheduling, preparationRequests,
          records, states: await listAdaptiveSelfStates(h.db, h.kernel.characterId),
          formatValid: records.length === 1, actualRoots: records[0]?.rootCount, actualConversations: records[0]?.conversationCount,
          promptVersion: records[0]?.generatedBy.promptVersion, modelVersion: records[0]?.generatedBy.modelVersion }
      }
    } else if (mode === 'arm' && ['A', 'B', 'C'].includes(arm)) {
      const beforeEvents = await domainEventsFor(h.db, h.kernel.characterId)
      const scheduling = await tick(arm !== 'A', arm === 'C')
      if (input.class === 'withdrawn') {
        const forget = await h.recordUserEvidence('明确遗忘旧反馈及依赖它的调整。')
        await h.applyStateChange('retract', String(forget.event.id), { memoryId: input.memoryId!, reason: 'explicit_forget' }, Date.now())
        await invalidateReflectionSources(h.db, h.kernel.characterId, fence, h.userId)
      }
      const followupRecorder = new ConversationRecorder({ db: h.db, characterId: h.kernel.characterId,
        conversationId: asConversationId(`${input.caseId}-r${input.round}-${arm}-holdout`), dryRun: false,
        userId: h.userId, userName: 'Alex', characterName: '苏沐薇', transport: 'm111-behavior-holdout',
        attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()] })
      const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
        recorder: followupRecorder, conversationSequence: () => 1, recentLimit: 16, slowPathEnabled: false,
        userId: h.userId, recallBudget: { ...DEFAULT_CONTEXT_BUDGET, adaptiveSelfTokens: arm === 'C' ? 300 : 0 } })
      const turn = await gateway.beginTurn(input.followup)
      const packet = await gateway.compileTurn({ turn, currentInput: input.followup, recentLines: [],
        ...(arm === 'C' ? { buildAdaptiveSelfStates: () => readUsableAdaptiveSelfStates(h.db, h.kernel.characterId, h.userId),
          buildReflectionFactPack: () => readCurrentReflectionFactPack(h.db, h.kernel.characterId, h.userId) } : {}) })
      const prompt = gateway.promptFor(packet)
      let reply = '', durationMs = 0, completed = false
      const finish = control ? undefined : await batch!.reserveWhenAvailable('behavior', `${input.caseId}:r${input.round}:${arm}`)
      let modelReturned = false
      try {
        const response = control ? { text: '（离线运行器控制回复，不用于行为评分）', durationMs: 0 } : await callModelText(h.runtime, prompt)
        finish?.('returned'); modelReturned = true
        const memoryTruth = applyResponseTruthPolicy({ result: turn.memoryWriteResult, replyText: response.text })
        /*
         * `LV2-D11` ②：**自主行为这一条回复链也接同一道守卫**。
         * 这条链**没有目标回合**（`compileTurn` 不传 `runGoalTurn`）⇒ `goalWriteReality` 为空
         * ⇒ `commitmentWritten = false`、`anythingWritten` 只由记忆写入决定 ——
         * 于是"她主动说『记下了 / 说定了』而什么都没写"同样会被替换成如实句。
         * ⚠️ 不接它，同一个缺陷会在**自主**那条路上留着（与 lv2-harness 同一条教训）。
         */
        const commitmentTruth = applyCommitmentClaimGuard({
          ...commitmentWriteFacts(turn.goalWriteReality),
          anythingWritten:
            turn.memoryWriteResult?.kind === 'written' ||
            turn.memoryWriteResult?.kind === 'already_applied' ||
            (turn.goalWriteReality?.eventsCommitted ?? 0) > 0,
          replyText: memoryTruth.replyText,
        })
        const actionTruth = applyActionClaimGuard({ results: turn.actionResults?.flatMap(row => row.result ? [row.result] : []), replyText: commitmentTruth.replyText })
        const search = searchFactOf(turn.actionResults)
        const evidenceTruth = applyExternalEvidenceReplyPolicy({ ...(search ? { search } : {}),
          ...(turn.externalEvidenceInContext ? { reality: turn.externalEvidenceInContext } : {}), replyText: actionTruth.replyText })
        reply = applySearchNeedReplyPolicy({ ...searchNeedDiagnosticsOf(turn.actionResults), searchState: evidenceTruth.state, replyText: evidenceTruth.replyText }).replyText
        durationMs = response.durationMs
        await gateway.completeTurn({ turn, replyText: reply, modelDurationMs: durationMs })
        completed = true
      } catch { if (!modelReturned) finish?.('transport_failed') }
      const trace = await getTrace(h.db, turn.traceId)
      const afterEvents = await domainEventsFor(h.db, h.kernel.characterId)
      const previousIds = new Set(beforeEvents.map(row => String(row.id)))
      const rootIds = input.rootIds!
      const rootEvents = await Promise.all(rootIds.map(id => getConversationEvent(h.db, id as never)))
      output = { caseId: `${input.caseId}:r${input.round}:${arm}`, corpusCaseId: input.caseId, pairId: `${input.caseId}:r${input.round}`, arm,
        slot: input.slot, legal: input.class === 'legal', class: input.class, round: input.round, scenario: input.followup,
        reply, rawPrompt: prompt, replySha256: createHash('sha256').update(reply).digest('hex'), traceId: String(turn.traceId), trace,
        baselineFingerprint: input.baselineFingerprint, databaseId: sandboxId,
        rootIds, conversationIds: [...new Set(rootEvents.flatMap(row => row ? [String(row.conversationId)] : []))],
        eventIds: afterEvents.filter(row => !previousIds.has(String(row.id))).map(row => String(row.id)),
        packetRefs: packet.sections.filter(row => row.id === 'adaptive-self').flatMap(row => row.sourceRefs ?? []),
        records: await listReflectionRecords(h.db, h.kernel.characterId), states: await listAdaptiveSelfStates(h.db, h.kernel.characterId),
        scheduling, preparationRequests, dialogueRequests: control ? 0 : 1, completed, liveReply: !control && completed,
        topic: input.class === 'legal' ? '合法行为调整' : input.class === 'withdrawn' ? '来源失效' : input.class === 'authority' ? '事实归属与越界' : '拒收与新候选',
        score: null, limitation: 'Synthetic fixture trigger; other state evaluators disabled. Goal-slot/M10.1 interaction is not covered.' }
    } else throw new Error('Unknown behavior worker mode')
  } finally { fence.close(); abort.abort(); await h.stop(); cleanClose = true }
  writeFileSync(outputPath!, JSON.stringify({ ...(output as Record<string, unknown>), cleanClose }, null, 2) + '\n')
  process.exit(0)
}
main().catch(() => { writeFileSync(outputPath!, JSON.stringify({ completed: false, cleanClose: false, workerFailure: true })); process.exit(1) })
