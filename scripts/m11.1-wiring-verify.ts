import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m111-wiring', { keep: false })
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createM4Harness, M4_T0 } from './m4-harness.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { runReflectionWindow } from '../src/infrastructure/runtime/reflection-runner.ts'
import { readCurrentReflectionFactPack, readUsableAdaptiveSelfStates } from '../src/infrastructure/runtime/reflection-current-state.ts'
import { invalidateReflectionSources } from '../src/infrastructure/runtime/reflection-invalidation.ts'
import { createLateWriteFence } from '../src/kernel/app/reflection/late-write-fence.ts'
import { latestDomainEventSequence, readReflectionWindowEvents } from '../src/infrastructure/persistence/reflection-input-source.ts'
import { appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { listReflectionRecords } from '../src/infrastructure/persistence/reflection-store.ts'
import { listAdaptiveSelfStates } from '../src/infrastructure/persistence/adaptive-self-store.ts'
import { renderAdaptiveSelfSection } from '../src/kernel/context/adaptive-self-sections.ts'
import { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } from '../src/kernel/contracts/reflection.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { getTrace } from '../src/infrastructure/persistence/trace-store.ts'
import { readReflectionSourceSnapshot } from '../src/infrastructure/persistence/reflection-source-read.ts'
import type { RawDb } from '../src/infrastructure/persistence/db.ts'
import { sql } from 'drizzle-orm'
import { sourceClassOfActor } from '../src/kernel/contracts/reflection-input.ts'
import { expandLineage } from '../src/kernel/app/reflection/lineage.ts'
import { createReflectionLineageLookup } from '../src/infrastructure/persistence/reflection-lineage-read.ts'
import { planReflectionWindow } from '../src/kernel/app/reflection/job.ts'

const checks: { caseId: string; pass: boolean; observed: unknown }[] = []
const check = (caseId: string, pass: boolean, observed: unknown) => checks.push({ caseId, pass, observed })
const started = new Date().toISOString()
let clock = M4_T0

async function main() {
  const h = await createM4Harness({ label: 'm111-wiring' })
  const characterId = h.kernel.characterId
  async function seed(caseId: string, roots: number, sessions: number, triggers = 1) {
    const watermark = await latestDomainEventSequence(h.db, characterId)
    const ids: string[] = []
    const recorders = Array.from({ length: sessions }, (_, session) => new ConversationRecorder({
      db: h.db, characterId, conversationId: asConversationId(`${caseId}-s-${session}`),
      dryRun: false, userId: h.userId, userName: 'Alex', characterName: '苏沐薇', transport: 'm111-wiring',
      attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    }))
    for (let i = 0; i < roots; i++) {
      const evidence = await recorders[i % sessions]!.recordUserMessage('隔离用反馈：对象含糊时先核对。', Math.floor(i / sessions) + 1)
      ids.push(String(evidence.event!.id))
    }
    for (let i = 0; i < triggers; i++) await appendDomainEvent(h.db, characterId, {
      type: 'GOAL_COMPLETED', operation: 'm111-wiring-fixture', payload: { goalId: `goal:${caseId}`, basis: 'user_report', expectedRevision: 1 },
      sourceConversationEventIds: ids as never, idempotencyKey: `m111-wiring:${caseId}:${i}`, processor: 'm111-wiring', processorVersion: 'm111-wiring@1', scope: 'CHARACTER_INTERNAL',
    }, ++clock)
    return { watermark, ids }
  }
  const draft = (call: ReflectionDraftCall, support = call.handles.map(handle => handle.id)) => ({
    schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION, focusQuestion: '对象含糊时是否先核对？', explanation: '候选解释，不是外部事实。',
    supportHandles: support, counterHandles: [], scope: REFLECTION_DRAFT_SCOPE, suggestedSlot: 'clarify_when_ambiguous',
  })
  const provider = { name: 'm111-wiring-offline', version: 'm111-wiring@1', async call(call: ReflectionDraftCall) { return draft(call) } }
  async function compile(budget: number, adaptiveEnabled = true) {
    const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
      recorder: h.recorder, conversationSequence: h.nextTurnSequence, recentLimit: 16, slowPathEnabled: false,
      userId: h.userId, recallBudget: { ...DEFAULT_CONTEXT_BUDGET, adaptiveSelfTokens: budget },
    })
    const turn = await gateway.beginTurn('隔离入口：帮我核对当前对象。')
    const packet = await gateway.compileTurn({ turn, currentInput: '隔离入口：帮我核对当前对象。', recentLines: [],
      ...(adaptiveEnabled ? { buildAdaptiveSelfStates: () => readUsableAdaptiveSelfStates(h.db, characterId, h.userId),
        buildReflectionFactPack: () => readCurrentReflectionFactPack(h.db, characterId, h.userId) } : {}),
    })
    await gateway.completeTurn({ turn, replyText: '（离线占位回复，本门只测packet与trace）', modelDurationMs: 0 })
    const trace = await getTrace(h.db, turn.traceId)
    return { traceId: String(turn.traceId), refs: packet.sections.filter(row => row.id === 'adaptive-self').flatMap(row => row.sourceRefs ?? []), traceKinds: trace?.steps.map(step => step.kind) ?? [],
      factState: trace?.steps.find(step => step.kind === 'adaptive_self_context')?.attributes.fact_state }
  }
  async function run(caseId: string, roots: number, sessions: number, extra = {}, triggers = 1) {
    const fixture = await seed(caseId, roots, sessions, triggers)
    const outcome = await runReflectionWindow(h.db, { characterId, activeUserId: h.userId, watermark: fixture.watermark, adaptiveEnabled: true, provider, now: () => ++clock, ...extra })
    const record = (await listReflectionRecords(h.db, characterId)).find(row => row.reflectionId === outcome.reflectionId)
    return { outcome, record: record === undefined ? undefined : { reflectionId: record.reflectionId, status: record.status, rootCount: record.rootCount, conversationCount: record.conversationCount, roots: record.roots }, fixture }
  }
  let cleanClose = false
  try {
    const same = await run('same-root', 1, 1, {}, 3)
    check('same-root', same.outcome.kind === 'rejected' && same.record?.rootCount === 1, same)
    const single = await run('single-session', 3, 1)
    check('single-session', single.outcome.kind === 'rejected' && single.record?.conversationCount === 1, single)
    const selection = await run('model-selected-one', 3, 2, {
      provider: { ...provider, async call(call: ReflectionDraftCall) { return draft(call, call.handles.filter(handle => handle.kind === 'conversation_event').slice(0, 1).map(handle => handle.id)) } },
    })
    check('model-selected-one', selection.outcome.kind === 'rejected' && selection.record?.rootCount === 1, selection)
    const noAdjust = await run('adaptive-off', 3, 2, { adaptiveEnabled: false })
    check('adaptive-off', noAdjust.outcome.kind === 'accepted' && noAdjust.outcome.eventsWritten === 2 && (await listAdaptiveSelfStates(h.db, characterId)).every(state => state.level === 'baseline'), noAdjust)
    const conflict = await run('direct-conflict', 3, 2, { unresolvedConflict: true })
    check('direct-conflict', conflict.outcome.kind === 'rejected', conflict)
    let providedConversationCount: number | undefined
    let providedConversationIds: string[] = []
    const legal = await run('legal', 3, 2, { provider: { ...provider, async call(call: ReflectionDraftCall) {
      providedConversationCount = call.sourceConversationCount
      providedConversationIds = call.window.filter(entry => entry.kind === 'conversation_event').map(entry => entry.conversationId ?? '')
      return draft(call)
    } } })
    check('provider-source-conversations-from-native-lineage', providedConversationCount === 2, { providedConversationCount })
    check('provider-session-metadata-from-native-conversation-rows', providedConversationIds.length === 3 &&
      new Set(providedConversationIds).size === 2 && providedConversationIds.every(id => id === 'legal-s-0' || id === 'legal-s-1'),
      { entries: providedConversationIds.length, sessions: new Set(providedConversationIds).size })
    check('legal-nonzero', legal.outcome.kind === 'accepted' && legal.outcome.eventsWritten === 3 && legal.record?.rootCount === 3 && legal.record?.conversationCount === 2, legal)
    const states = await readUsableAdaptiveSelfStates(h.db, characterId, h.userId)
    const unavailable = new Proxy(h.db, { get(target, key) {
      if (key === 'execute') return async () => { throw new Error('controlled-source-read-unavailable') }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as RawDb
    const recordsBeforeUnavailable = (await listReflectionRecords(h.db, characterId)).map(r => r.status)
    check('current-read-unavailable-blocks-without-retraction', (await readUsableAdaptiveSelfStates(unavailable, characterId, h.userId)).every(s => s.level !== 'enhanced') &&
      JSON.stringify((await listReflectionRecords(h.db, characterId)).map(r => r.status)) === JSON.stringify(recordsBeforeUnavailable), { injected: 'read-failure', permanentWrites: 0 })
    const sourceTimes: number[] = []
    for (let i = 0; i < 40; i++) {
      const start = performance.now()
      await readReflectionSourceSnapshot(h.db, characterId, legal.fixture.ids.map(id => ({ id, kind: 'conversation_event' })), { activeUserId: h.userId })
      sourceTimes.push(performance.now() - start)
    }
    sourceTimes.sort((a, b) => a - b)
    check('local-source-read-p95', sourceTimes[37]! <= 50, { samples: 40, p95Ms: sourceTimes[37], scale: { roots: 3, conversations: 2 }, machine: process.platform, node: process.version, limitation: 'Small isolated fixture; no production-scale extrapolation.' })
    const section = renderAdaptiveSelfSection({ states, maxTokens: 800, quantify: text => [...text].length })
    check('legal-injection', section.some(row => (row.sourceRefs?.length ?? 0) > 0), section.map(row => ({ id: row.id, refs: row.sourceRefs })))
    const actualPacket = await compile(800)
    check('gateway-actual-packet-and-trace', actualPacket.refs.length > 0 && actualPacket.traceKinds.includes('adaptive_self_context'), actualPacket)
    check('gateway-current-fact-pack-active', actualPacket.factState === 'active', actualPacket)
    const frontTimes: { baselineMs: number; enabledMs: number; additionalMs: number }[] = []
    for (let i = 0; i < 20; i++) {
      const baselineAt = performance.now()
      await compile(300, false)
      const baselineMs = performance.now() - baselineAt
      const enabledAt = performance.now()
      await compile(300, true)
      const enabledMs = performance.now() - enabledAt
      frontTimes.push({ baselineMs, enabledMs, additionalMs: Math.max(0, enabledMs - baselineMs) })
    }
    const additional = frontTimes.map(t => t.additionalMs).sort((a, b) => a - b)
    check('front-added-p95-actual-gateway', additional[18]! <= 100, { samples: 20, p95AdditionalMs: additional[18], pairs: frontTimes,
      scale: { validEnhancedSlots: 1, roots: 3, conversations: 2, budget: 300 }, limitation: 'Paired isolated gateway timings, includes completeTurn; no large-production-scale SLA claim.' })
    const offPacket = await compile(800, false)
    check('gateway-adaptive-off', offPacket.refs.length === 0, offPacket)
    const zeroPacket = await compile(0)
    check('gateway-budget-zero', zeroPacket.refs.length === 0, zeroPacket)
    check('zero-budget', renderAdaptiveSelfSection({ states, maxTokens: 0, quantify: text => [...text].length }).length === 0, { budget: 0 })
    check('wrong-user-scope', (await readUsableAdaptiveSelfStates(h.db, characterId, 'other-user')).every(state => state.level !== 'enhanced'), { expectedEnhanced: 0 })
    const source = legal.fixture.ids[0]!
    const memory = await h.commitAndFold(h.makeCandidate('person_fact', { kind: 'claim', subject: h.user, predicate: 'm111.wiring.preference', value: '先核对' } as never, { sourceRefs: [{ kind: 'conversation_event', id: source }] }), ++clock)
    if (memory === null) throw new Error('source memory rejected')
    const forget = await h.recordUserEvidence('忘掉那条偏好。')
    await h.applyStateChange('retract', String(forget.event.id), { memoryId: memory.id, reason: 'explicit_forget' }, ++clock)
    const blocked = await readUsableAdaptiveSelfStates(h.db, characterId, h.userId)
    check('same-turn-forget-block', blocked.every(state => state.level !== 'enhanced'), { enhancedCount: blocked.filter(state => state.level === 'enhanced').length })
    const forgottenPacket = await compile(800)
    check('gateway-forgotten-final-refs-zero', forgottenPacket.refs.length === 0, forgottenPacket)
    check('gateway-forgotten-fact-pack-not-active', forgottenPacket.factState !== 'active', forgottenPacket)
    const invalidationFence = createLateWriteFence()
    const invalidated = await invalidateReflectionSources(h.db, characterId, invalidationFence, h.userId)
    const repeatedInvalidation = await invalidateReflectionSources(h.db, characterId, invalidationFence, h.userId)
    const invalidatedRecord = (await listReflectionRecords(h.db, characterId)).find(row => row.reflectionId === legal.outcome.reflectionId)
    check('permanent-invalidation-idempotent', invalidated >= 2 && repeatedInvalidation === 0 && invalidatedRecord?.status === 'retracted', { invalidated, repeatedInvalidation, recordStatus: invalidatedRecord?.status })
    const pending = await seed('forget-during-model', 3, 2)
    const duringMemory = await h.commitAndFold(h.makeCandidate('person_fact', { kind: 'claim', subject: h.user, predicate: 'm111.pending.preference', value: '核对' } as never, { sourceRefs: [{ kind: 'conversation_event', id: pending.ids[0]! }] }), ++clock)
    if (duringMemory === null) throw new Error('pending source rejected')
    const stale = await runReflectionWindow(h.db, { characterId, activeUserId: h.userId, watermark: pending.watermark, adaptiveEnabled: true, provider: {
      ...provider, async call(call) {
        const event = await h.recordUserEvidence('忘掉新的那条偏好。')
        await h.applyStateChange('retract', String(event.event.id), { memoryId: duringMemory.id, reason: 'explicit_forget' }, ++clock)
        return draft(call)
      },
    } })
    check('forget-during-model', stale.kind === 'rejected' && stale.eventsWritten <= 2, stale)
    const countBefore = (await domainEventsFor(h.db, characterId)).length
    const duplicate = await runReflectionWindow(h.db, { characterId, activeUserId: h.userId, watermark: selection.fixture.watermark, provider, adaptiveEnabled: true })
    // Other windows are now present; terminal identity of the original record must still be rejected.
    const original = (await listReflectionRecords(h.db, characterId)).find(row => row.reflectionId === selection.outcome.reflectionId)
    check('terminal-not-reversed', original?.status === 'rejected', { originalStatus: original?.status, duplicateKind: duplicate.kind, eventsBefore: countBefore })
    const disputed = await seed('stored-conflict', 3, 2)
    const conflictMemory = await h.commitAndFold(h.makeCandidate('person_fact', { kind: 'claim', subject: h.user, predicate: 'm111.conflict.preference', value: '核对' } as never, { sourceRefs: [{ kind: 'conversation_event', id: disputed.ids[0]! }] }), ++clock)
    if (conflictMemory === null) throw new Error('conflict fixture rejected')
    const conflictEvidence = await h.recordUserEvidence('那条偏好存在争议。')
    await h.applyStateChange('dispute', String(conflictEvidence.event.id), { memoryId: conflictMemory.id, reason: 'user_dispute' }, ++clock)
    const storedConflict = await runReflectionWindow(h.db, { characterId, activeUserId: h.userId, watermark: disputed.watermark, adaptiveEnabled: true, provider })
    check('persisted-direct-conflict-without-override', storedConflict.kind === 'rejected', storedConflict)
    const version = await seed('version-during-model', 3, 2)
    const versionMemory = await h.commitAndFold(h.makeCandidate('person_fact', { kind: 'claim', subject: h.user, predicate: 'm111.version.preference', value: '核对' } as never, { sourceRefs: [{ kind: 'conversation_event', id: version.ids[0]! }] }), ++clock)
    if (versionMemory === null) throw new Error('version fixture rejected')
    const versionOutcome = await runReflectionWindow(h.db, { characterId, activeUserId: h.userId, watermark: version.watermark, adaptiveEnabled: true, provider: {
      ...provider, async call(call) {
        const event = await h.recordUserEvidence('这条偏好需要重新核实。')
        await h.applyStateChange('dispute', String(event.event.id), { memoryId: versionMemory.id, reason: 'user_dispute' }, ++clock)
        return draft(call)
      },
    } })
    check('derived-source-revision-during-model-no-stale-write', versionOutcome.kind === 'rejected' && versionOutcome.eventsWritten === 0, versionOutcome)
    const bounded = await seed('bounded-window', 3, 2)
    const throughSequence = await latestDomainEventSequence(h.db, characterId)
    const later = await seed('after-window', 1, 1)
    const boundedResult = await runReflectionWindow(h.db, { characterId, activeUserId: h.userId, watermark: bounded.watermark, throughSequence, adaptiveEnabled: true, provider })
    const boundedRecord = (await listReflectionRecords(h.db, characterId)).find(r => r.reflectionId === boundedResult.reflectionId)
    check('scheduler-input-upper-bound', boundedRecord?.rootCount === 3 && boundedRecord.roots.every(id => !later.ids.includes(id)), { throughSequence, rootCount: boundedRecord?.rootCount })
    const beforeReplay = (await domainEventsFor(h.db, characterId)).length
    const replay = await runReflectionWindow(h.db, { characterId, activeUserId: h.userId, watermark: bounded.watermark, throughSequence, adaptiveEnabled: true,
      provider: { ...provider, async call() { throw new Error('duplicate input must not request a second model call') } } })
    check('same-input-identity-preserved-before-model', replay.eventsWritten === 0 && replay.reflectionId === boundedResult.reflectionId && (await domainEventsFor(h.db, characterId)).length === beforeReplay, replay)
    const promptEvidence = await h.recordUserEvidence('来源控制：这条仅用于核对助手输出身份。')
    const assistant = await h.recorder.recordAssistantMessage({ text: '来源控制：我先问过对象。', conversationSequence: h.nextTurnSequence(),
      characterSequence: promptEvidence.assistantSequence, replyToEventId: promptEvidence.event.id })
    if (!assistant) throw new Error('assistant control was not recorded')
    const ownOutput = await readReflectionSourceSnapshot(h.db, characterId, [{ id: String(assistant.id), kind: 'conversation_event' }], { activeUserId: h.userId })
    check('assistant-own-output-readable-with-confirmed-origin', ownOutput.usable, { rootCount: ownOutput.roots.length })
    // Controlled corrupted presenter row in an isolated DB, retaining original attested origin.
    await h.db.execute(sql`update conversation_events set actor_id = 'another-character' where id = ${String(assistant.id)}`)
    const mismatch = await readReflectionSourceSnapshot(h.db, characterId, [{ id: String(assistant.id), kind: 'conversation_event' }], { activeUserId: h.userId })
    check('assistant-presenter-origin-mismatch-blocked', !mismatch.usable, mismatch.sourceVerdicts)
    await h.db.execute(sql`update conversation_events set actor_id = ${String(characterId)} where id = ${String(assistant.id)}`)
    check('assistant-origin-control-restored', (await readReflectionSourceSnapshot(h.db, characterId, [{ id: String(assistant.id), kind: 'conversation_event' }], { activeUserId: h.userId })).usable, { repairedFixtureOnly: true })
    const assistantLineage = await expandLineage(createReflectionLineageLookup(h.db, { characterId }), [{ id: String(assistant.id), kind: 'conversation_event' }], { characterId: String(characterId) })
    check('native-character-labelled-as-assistant-not-user', sourceClassOfActor(assistant.actorType) === 'assistant_speech' && assistantLineage.classCounts.assistant_speech === 1 && assistantLineage.classCounts.user_statement === 0,
      { actor: assistant.actorType, classes: assistantLineage.classCounts })
    const assistantWatermark = await latestDomainEventSequence(h.db, characterId)
    await appendDomainEvent(h.db, characterId, { type: 'GOAL_COMPLETED', operation: 'm111-assistant-trigger-control',
      payload: { goalId: 'goal:assistant-only-control', basis: 'user_report', expectedRevision: 1 }, sourceConversationEventIds: [assistant.id],
      idempotencyKey: 'm111-assistant-only-control', processor: 'm111-wiring', processorVersion: 'm111-wiring@1', scope: 'CHARACTER_INTERNAL' }, ++clock)
    const assistantLatest = await latestDomainEventSequence(h.db, characterId)
    const assistantPlan = planReflectionWindow({ watermark: assistantWatermark, latest: assistantLatest,
      events: await readReflectionWindowEvents(h.db, characterId, assistantWatermark, assistantLatest, 50) })
    check('native-character-only-trigger-skips-and-advances-window', assistantPlan.eligible.length === 0 && assistantPlan.skipped.some(row => row.reason === 'assistant_speech_not_eligible') && assistantPlan.toSequence === assistantLatest,
      { from: assistantWatermark, to: assistantPlan.toSequence, eligible: assistantPlan.eligible.length, skipped: assistantPlan.skipped })
    const skippedResult = await runReflectionWindow(h.db, { characterId, activeUserId: h.userId, watermark: assistantWatermark,
      throughSequence: assistantLatest, eligibleDomainEventIds: assistantPlan.eligible.map(event => event.id), adaptiveEnabled: true,
      provider: { ...provider, async call() { throw new Error('skipped assistant trigger must not call model') } } })
    check('skipped-trigger-excluded-from-runner-input', skippedResult.eventsWritten === 0, skippedResult)
  } finally { await h.stop(); cleanClose = true }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'm111-wiring', headShort: head })
  const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
  const paths = ['scripts/m11.1-wiring-verify.ts', 'src/infrastructure/runtime/reflection-runtime.ts', 'src/infrastructure/runtime/reflection-runner.ts', 'src/infrastructure/persistence/reflection-input-source.ts', 'src/kernel/app/reflection/job.ts', 'src/infrastructure/runtime/reflection-current-state.ts', 'src/infrastructure/runtime/reflection-invalidation.ts', 'src/infrastructure/persistence/reflection-source-read.ts', 'docs/m11.1/M11.1-Acceptance-Contract.md']
  writeM11Manifest(dir, { runId, wp: 'M11.1-WP2', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'wiring', phases: ['positive', 'negative', 'recovery'], supersedes: null,
    counts: { total: checks.length, passed: checks.filter(row => row.pass).length, failed: checks.filter(row => !row.pass).length }, started, ended: new Date().toISOString(), cleanClose, environment: 'isolated-offline', plannedRequests: 0, actualRequests: 0, capabilityImpact: 'NONE', sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  })
  console.log(JSON.stringify({ runId, checks: checks.map(({ caseId, pass }) => ({ caseId, pass })), cleanClose }, null, 2))
  process.exit(checks.every(row => row.pass) ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
