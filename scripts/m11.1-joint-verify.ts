import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m111-joint', { keep: false })
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createM4Harness } from './m4-harness.ts'
import { createM10TurnHarness, fixedProvider, deterministicRuntime } from './m10-harness.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { listGoalStates } from '../src/infrastructure/persistence/goal-store.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { orderGoalsForFocus } from '../src/kernel/app/goal/invalidation.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { commitmentFactRowsOf } from '../src/kernel/app/goal/commitment-facts.ts'
import { runConfiguredReflectionTail } from '../src/infrastructure/runtime/reflection-runtime.ts'
import { readUsableAdaptiveSelfStates, readCurrentReflectionFactPack } from '../src/infrastructure/runtime/reflection-current-state.ts'
import { createLateWriteFence } from '../src/kernel/app/reflection/late-write-fence.ts'
import { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } from '../src/kernel/contracts/reflection.ts'
import { GOAL_PROPOSAL_SCHEMA_VERSION } from '../src/kernel/contracts/goal-proposal.ts'
import { goalProposalOf } from '../src/kernel/policies/goal-validator.ts'
import { draftToProgramProposal, goalSpanFingerprint } from '../src/kernel/app/goal/understanding.ts'
import { buildAgreementProposal } from '../src/kernel/app/agreement/proposal.ts'
import { validateAgreementDraft } from '../src/kernel/contracts/agreement-input.ts'
import { createGoalReflectionQueue } from '../src/infrastructure/runtime/goal-reflection-queue.ts'
import { runConfiguredAgreementTail } from '../src/infrastructure/runtime/agreement-runtime.ts'
import { AGREEMENT_PROCESSOR, AGREEMENT_PROCESSOR_VERSION, recoverRunningAgreementJobs } from '../src/infrastructure/runtime/agreement-scheduler.ts'
import { REFLECTION_PROCESSOR } from '../src/infrastructure/runtime/reflection-scheduler.ts'
import { REFLECTION_PROCESSOR_VERSION } from '../src/infrastructure/runtime/reflection-runner.ts'
import { getWatermark, listJobs, markJobRunning } from '../src/infrastructure/persistence/job-store.ts'
import { AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION } from '../src/kernel/contracts/agreement-model-draft.ts'
import { sql } from 'drizzle-orm'

async function main() {
  const started = new Date().toISOString()
  const h = await createM4Harness({ label: 'm111-joint' })
  const characterId = h.kernel.characterId
  const goals = createM10TurnHarness({ db: h.db, characterId, userId: h.userId })
  const checks: { caseId: string; pass: boolean; observed: unknown }[] = []
  const check = (caseId: string, pass: boolean, observed: unknown) => checks.push({ caseId, pass, observed })
  const recorder = (conversation: string) => new ConversationRecorder({ db: h.db, characterId, conversationId: asConversationId(conversation),
    dryRun: false, userId: h.userId, userName: 'Alex', characterName: '苏沐薇', transport: 'm111-joint-controlled-console',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()] })
  const prepRecorders = [recorder('m111-joint-source-1'), recorder('m111-joint-source-2')]
  const sequence = [0, 0]
  const record = async (text: string, session = 0) => {
    const row = await prepRecorders[session]!.recordUserMessage(text, ++sequence[session]!)
    if (!row.event) throw new Error('native user source not recorded')
    return row
  }
  const turn = async (text: string, raw: unknown, session = 0) => {
    const source = await record(text, session)
    return goals.turn({ currentInput: text, sourceEventId: String(source.event!.id), now: Date.now(), provider: fixedProvider(raw), runtime: deterministicRuntime() })
  }
  const fence = createLateWriteFence(), abort = new AbortController()
  const tick = () => runConfiguredReflectionTail(h.db, { characterId, activeUserId: h.userId, reflectionEnabled: true, adaptiveEnabled: true,
    fence, signal: abort.signal, provider: { name: 'm111-joint-offline', version: 'controlled@1', async call(call) {
      return { schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION, focusQuestion: '做下一步前是否复核当前目标？', explanation: '隔离联调候选，不计语义或行为评分。',
        supportHandles: call.handles.map(handle => handle.id), counterHandles: [], scope: REFLECTION_DRAFT_SCOPE, suggestedSlot: 'recheck_goal_before_next_step' }
    } } })
  let cleanClose = false
  try {
    await tick() // Establish the real scheduler cutover before adding controlled native Goal events.
    for (let i = 0; i < 3; i++) {
      const text = `隔离目标${i}：整理一页提纲`
      const created = await turn(text, { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'create', span: { start: 0, end: [...text].length }, statement: text, origin: 'user_requested' }, i % 2)
      const row = (await goals.listStates()).find(row => row.goal.statement === text)
      if (!row) throw new Error(`native goal create failed: ${created.outcome}`)
      const report = `隔离目标${i}已完成。下次给行动建议前请先复核当前目标。`
      const completed = await turn(report, { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'report_complete', span: { start: 0, end: [...report].length }, targetGoalId: String(row.goal.goalId) }, i % 2)
      check(`native-goal-lifecycle-${i}`, created.outcome === 'accepted' && completed.outcome === 'accepted', { create: created.outcome, complete: completed.outcome })
    }
    const agreementText = '隔离约定：一起核对旧提纲'
    const proposed = await record(agreementText)
    const accepted = await prepRecorders[0]!.recordAssistantMessage({ text: '接受，一起核对旧提纲。', conversationSequence: ++sequence[0]!,
      characterSequence: proposed.assistantSequence!, replyToEventId: proposed.event!.id })
    if (!accepted) throw new Error('native agreement acceptance source missing')
    const agreement = validateAgreementDraft({ kind: 'mutual_agreement', content: agreementText, criterion: '由对方报告旧提纲核对完成',
      proposedByEventId: String(proposed.event!.id), acceptedByEventId: String(accepted.id) }, { entries: [
      { id: String(proposed.event!.id), actorType: 'user', sequence: 1, text: agreementText, masked: false },
      { id: String(accepted.id), actorType: 'character', sequence: 2, text: '接受，一起核对旧提纲。', masked: false },
    ], facts: { entryCount: 2, characterCount: 1, userCount: 1, windowTruncated: false } })
    if (!agreement.ok) throw new Error(`native agreement fixture rejected: ${agreement.reason}`)
    const built = buildAgreementProposal({ agreement: agreement.value, characterId: String(characterId), span: { start: 0, end: [...agreementText].length },
      proposalId: 'm111-joint-agreement', processor: 'm111-joint-controlled', processorVersion: 'controlled@1', now: Date.now(), criterion: { kind: 'user_report' } })
    if (!built.ok) throw new Error(built.reason)
    const programDraft = await goals.turn({ currentInput: agreementText, sourceEventId: String(proposed.event!.id), now: Date.now(), provider: fixedProvider(built.draft), runtime: deterministicRuntime() })
    check('model-parser-rejects-program-only-acceptance-ids', programDraft.outcome === 'invalid_output' && programDraft.trace.proposal.rejectionReason === 'unknown_field', { outcome: programDraft.outcome })
    const modelDraft = { ...built.draft, commitment: { scope: built.draft.commitment!.scope, criterion: built.draft.commitment!.criterion } }
    const modelSource = await record(agreementText)
    const acceptedTurn = await goals.turn({ currentInput: agreementText, sourceEventId: String(modelSource.event!.id), now: Date.now(), provider: fixedProvider(modelDraft), runtime: deterministicRuntime() })
    check('ordinary-goal-parser-accepts-bridge-draft', acceptedTurn.outcome === 'accepted', { outcome: acceptedTurn.outcome, trace: acceptedTurn.trace })
    // Program-only references enter through the validated direct bridge; model drafts cannot supply them.
    const mapped = draftToProgramProposal(built.draft, { characterId: String(characterId), sourceEventId: String(proposed.event!.id), proposalId: 'm111-native-bridge',
      processor: 'm111-joint-controlled', processorVersion: 'controlled@1', candidates: [], sourceText: agreementText, now: Date.now() })
    if (!mapped.proposal) throw new Error('bridge did not map a native proposal')
    const bridge = await goals.applyProposal(mapped.proposal, Date.now())
    const old = (await goals.listStates()).find(row => row.goal.statement === agreementText)
    check('native-delivered-bridge-create-and-commit', bridge.accepted && old?.commitment?.status === 'active', { outcome: bridge, commitment: old?.commitment?.status })
    if (!old?.commitment) throw new Error(`native bridge commitment was not admitted: ${JSON.stringify(bridge)}`)
    const report = await record('旧提纲核对已经完成。')
    const sourceId = String(report.event!.id)
    const closed = await goals.applyProposal(goalProposalOf({ proposalId: 'm111-joint-fulfill', operation: 'complete', characterId: String(characterId),
      processor: 'm111-joint-controlled', processorVersion: 'controlled@1', sourceConversationEventIds: [sourceId], sourceQualifications: [{ eventId: sourceId, qualification: 'ESTABLISHED' }],
      targets: [
        { type: 'GOAL_COMPLETED', operation: 'update', scope: 'CHARACTER_INTERNAL', payload: { characterId: String(characterId), goalId: String(old.goal.goalId), expectedRevision: old.goal.revision, basis: 'user_report',
          evidenceRefs: [{ conversationEventId: sourceId, span: { start: 0, end: [...'旧提纲核对已经完成。'].length }, fingerprint: goalSpanFingerprint('旧提纲核对已经完成。') }] } },
        { type: 'COMMITMENT_FULFILLED', operation: 'update', scope: 'CHARACTER_INTERNAL', payload: { characterId: String(characterId), goalId: String(old.goal.goalId), commitmentId: String(old.commitment.commitmentId),
          expectedRevision: old.commitment.revision, basis: 'user_report', resultRefs: [{ conversationEventId: sourceId, fingerprint: goalSpanFingerprint('旧提纲核对已经完成。') }] } },
      ] }), Date.now())
    check('native-commitment-closed', closed.accepted && (await goals.goalById(String(old.goal.goalId)))?.commitment?.status === 'fulfilled', closed)
    const newText = '当前新目标：准备新展览的入口介绍'
    const created = await turn(newText, { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'create', span: { start: 0, end: [...newText].length }, statement: newText, origin: 'user_requested' })
    check('native-new-current-goal', created.outcome === 'accepted', { outcome: created.outcome })
    const beforeReflection = JSON.stringify(await goals.listStates())
    await tick()
    check('native-reflection-three-roots-two-sessions', (await readUsableAdaptiveSelfStates(h.db, characterId, h.userId)).some(state => state.level === 'enhanced' && state.slot === 'recheck_goal_before_next_step'), { nativeTriggers: (await domainEventsFor(h.db, characterId)).filter(row => String(row.type) === 'GOAL_COMPLETED').length })
    check('reflection-did-not-reopen-closed-commitment', JSON.stringify(await goals.listStates()) === beforeReflection && (await goals.goalById(String(old.goal.goalId)))?.commitment?.status === 'fulfilled', { goalWritesByReflection: 0 })
    for (const bits of ['000', '100', '010', '001', '110', '101', '011', '111']) {
      const budgets = { goalTokens: bits[0] === '1' ? 300 : 0, commitmentTokens: bits[1] === '1' ? 300 : 0, adaptiveSelfTokens: bits[2] === '1' ? 300 : 0 }
      const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot, recorder: recorder(`m111-joint-budget-${bits}`),
        conversationSequence: () => 1, userId: h.userId, slowPathEnabled: false, recentLimit: 16,
        recallBudget: { ...DEFAULT_CONTEXT_BUDGET, ...budgets }, commitmentFactRows: async () => commitmentFactRowsOf(await listGoalStates(h.db, characterId)) })
      const incoming = await gateway.beginTurn('请给当前新目标的下一步。')
      const packet = await gateway.compileTurn({ turn: incoming, currentInput: '请给当前新目标的下一步。', recentLines: [],
        runGoalTurn: async info => ({ turn: await goals.turn({ ...info, now: Date.now(), provider: fixedProvider({ schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'query', span: { start: 0, end: 2 } }), runtime: deterministicRuntime() }),
          contextState: { ordered: orderGoalsForFocus((await goals.listStates()).map(row => row.goal)).ordered.map(goal => ({ goal, rowKey: `goal:${String(goal.goalId)}` })), withdrawnEventIds: new Set<string>() } }),
        buildAdaptiveSelfStates: () => readUsableAdaptiveSelfStates(h.db, characterId, h.userId), buildReflectionFactPack: () => readCurrentReflectionFactPack(h.db, characterId, h.userId),
      })
      await gateway.completeTurn({ turn: incoming, replyText: '（离线联调占位，不计真实行为）', modelDurationMs: 0 })
      const section = (id: string) => packet.sections.find(row => row.id === id)
      const observed = { goal: !!section('goal-state'), commitment: !!section('commitment-state'), adaptive: !!section('adaptive-self') }
      check(`three-independent-budgets-${bits}`, observed.goal === (bits[0] === '1') && observed.commitment === (bits[1] === '1') && observed.adaptive === (bits[2] === '1'), { budgets, observed })
      if (bits === '111') check('final-packet-current-goal-and-closed-boundary', section('goal-state')?.content.includes(newText) === true && section('commitment-state')?.content.includes('已结清') === true &&
        section('commitment-state')?.content.includes('不要再提') === true, { goalRefs: section('goal-state')?.sourceRefs, commitmentRefs: section('commitment-state')?.sourceRefs, adaptiveRefs: section('adaptive-self')?.sourceRefs })
    }
    const queue = createGoalReflectionQueue(fence)
    const agreementTick = (provider: any) => runConfiguredAgreementTail(h.db, { characterId, activeUserId: h.userId,
      enabled: true, provider, fence, signal: abort.signal })
    const noAgreement = { name: 'a12-control', version: 'offline@1', async call() { return { schemaVersion: AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION, kind: 'none' } } }
    await agreementTick(noAgreement)
    let replayProvider: any
    for (const mode of ['agreement-fails', 'reflection-fails', 'both-success'] as const) {
      for (let i = 0; i < 3; i++) {
        const statement = `A12 ${mode} ${i}：复核提纲`
        await turn(statement, { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'create', span: { start: 0, end: [...statement].length }, statement, origin: 'user_requested' }, i % 2)
        const current = (await goals.listStates()).find(row => row.goal.statement === statement)!
        const report = `A12 ${mode} ${i}已完成，下次建议前先复核目标。`
        await turn(report, { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'report_complete', span: { start: 0, end: [...report].length }, targetGoalId: String(current.goal.goalId) }, i % 2)
      }
      const content = `A12 ${mode}：一起核对资料`
      const user = await record(content)
      await prepRecorders[0]!.recordAssistantMessage({ text: `接受，${content}。`, conversationSequence: ++sequence[0]!, characterSequence: user.assistantSequence!, replyToEventId: user.event!.id })
      const beforeA = await getWatermark(h.db, characterId, AGREEMENT_PROCESSOR, AGREEMENT_PROCESSOR_VERSION)
      const beforeR = await getWatermark(h.db, characterId, REFLECTION_PROCESSOR, REFLECTION_PROCESSOR_VERSION)
      let active = 0, maxActive = 0
      const order: string[] = []
      const call = async (name: string, work: () => unknown) => {
        active++; maxActive = Math.max(maxActive, active); order.push(`${name}:start`)
        try { await Promise.resolve(); return work() } finally { active--; order.push(`${name}:end`) }
      }
      const reflection = queue.run(() => runConfiguredReflectionTail(h.db, { characterId, activeUserId: h.userId, reflectionEnabled: true, adaptiveEnabled: true,
        fence, signal: abort.signal, provider: { name: 'a12-reflection', version: 'offline@1', async call(input) {
          return call('reflection', () => {
            if (mode === 'reflection-fails') throw new Error('injected_reflection_provider_failure')
            return { schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION, scope: REFLECTION_DRAFT_SCOPE, focusQuestion: '是否先复核目标？', explanation: '隔离控制。',
              supportHandles: input.handles.map(handle => handle.id), counterHandles: [], suggestedSlot: 'recheck_goal_before_next_step' }
          })
        } } }))
      replayProvider = { ...noAgreement, async call(input: any) {
        return call('agreement', () => {
          if (mode === 'agreement-fails') throw new Error('injected_agreement_provider_failure')
          const proposed = input.window.entries.findLast((entry: any) => entry.text === content)
          const accepted = input.window.entries.findLast((entry: any) => entry.actorType === 'character')
          return { schemaVersion: AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION, kind: 'mutual_agreement', content, criterion: '由用户报告资料核对完成',
            proposedBySeq: proposed.sequence, acceptedBySeq: accepted.sequence }
        })
      } }
      const agreement = queue.run(() => agreementTick(replayProvider))
      const [r, a] = await Promise.all([reflection, agreement])
      const afterA = await getWatermark(h.db, characterId, AGREEMENT_PROCESSOR, AGREEMENT_PROCESSOR_VERSION)
      const afterR = await getWatermark(h.db, characterId, REFLECTION_PROCESSOR, REFLECTION_PROCESSOR_VERSION)
      check(`a12-${mode}-ordered-provider-calls`, maxActive === 1 && order.join(',') === 'reflection:start,reflection:end,agreement:start,agreement:end', { maxActive, order })
      check(`a12-${mode}-independent-agreement-watermark`, mode === 'agreement-fails' ? a?.kind === 'failed' && afterA?.processedThroughSequence === beforeA?.processedThroughSequence : a?.kind === 'ran' && afterA!.processedThroughSequence > beforeA!.processedThroughSequence, { before: beforeA?.processedThroughSequence, after: afterA?.processedThroughSequence, outcome: a?.kind })
      check(`a12-${mode}-independent-reflection-watermark`, mode === 'reflection-fails' ? r?.scheduling?.kind === 'failed' && afterR?.processedThroughSequence === beforeR?.processedThroughSequence : r?.scheduling?.kind === 'ran' && afterR!.processedThroughSequence > beforeR!.processedThroughSequence, { before: beforeR?.processedThroughSequence, after: afterR?.processedThroughSequence, outcome: r?.scheduling?.kind })
    }
    const completedJob = (await listJobs(h.db, characterId)).findLast(job => job.processor === AGREEMENT_PROCESSOR && job.status === 'completed')!
    // Copy-only crash injection after durable business writes: the next exclusive opener recovers only its abandoned lane.
    await h.db.execute(sql`update character_jobs set status = 'pending', started_at = null, finished_at = null where id = ${String(completedJob.id)}`)
    await h.db.execute(sql`update processor_watermarks set processed_through_sequence = ${completedJob.sourceFromSequence} where character_id = ${String(characterId)} and processor = ${AGREEMENT_PROCESSOR}`)
    await markJobRunning(h.db, completedJob.id, Date.now())
    const reflectionJobsBefore = JSON.stringify((await listJobs(h.db, characterId)).filter(job => job.processor === REFLECTION_PROCESSOR))
    const recovered = await recoverRunningAgreementJobs(h.db, characterId, Date.now(), fence)
    check('a12-exclusive-open-recovers-only-abandoned-agreement-jobs', recovered === 1 && reflectionJobsBefore === JSON.stringify((await listJobs(h.db, characterId)).filter(job => job.processor === REFLECTION_PROCESSOR)), { recovered })
    const beforeReplay = (await domainEventsFor(h.db, characterId)).length
    const replayed = await runConfiguredAgreementTail(h.db, { characterId, activeUserId: h.userId, enabled: true, provider: replayProvider,
      fence, signal: abort.signal, now: Date.now() + 60_001 })
    check('a12-recovery-keeps-durable-business-events-unique', replayed.kind === 'ran' && replayed.result === 'already_applied' && (await domainEventsFor(h.db, characterId)).length === beforeReplay, { beforeReplay, outcome: replayed.kind })
    const closeUser = await record('A12关闭控制：一起核对资料。')
    await prepRecorders[0]!.recordAssistantMessage({ text: '接受，一起核对资料。', conversationSequence: ++sequence[0]!, characterSequence: closeUser.assistantSequence!, replyToEventId: closeUser.event!.id })
    const closingQueue = createGoalReflectionQueue(fence)
    let release!: () => void, startedClosing!: () => void, queuedCalls = 0
    const providerStarted = new Promise<void>(resolve => { startedClosing = resolve })
    const returned = new Promise<void>(resolve => { release = resolve })
    const late = closingQueue.run(() => agreementTick({ ...noAgreement, async call(input: any) { startedClosing(); await returned; return replayProvider.call(input) } }))
    const queued = closingQueue.run(async () => { queuedCalls++; return tick() })
    await providerStarted
    fence.close(); abort.abort(); release()
    const [lateResult] = await Promise.all([late, queued])
    check('a12-close-refuses-queued-provider-and-late-business-write', queuedCalls === 0 && lateResult?.kind === 'cancelled' && (await domainEventsFor(h.db, characterId)).length === beforeReplay, { queuedCalls, outcome: lateResult?.kind })
    const mainSource = readFileSync('src/main.ts', 'utf8')
    check('a12-main-uses-the-tested-queue-for-both-workers', mainSource.includes('this.goalReflectionQueue.run(() => runConfiguredReflectionTail') && mainSource.includes('this.goalReflectionQueue.run(() => runConfiguredAgreementTail') && mainSource.includes('this.drainAgreementTail(true)'), { actualProductionAssembly: true })
  } finally { fence.close(); abort.abort(); await h.stop(); cleanClose = true }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'm111-joint', headShort: head }), dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
  const paths = ['scripts/m11.1-joint-verify.ts', 'scripts/m10-harness.ts', 'src/kernel/app/goal/commitment-facts.ts', 'src/kernel/app/goal/turn.ts', 'src/kernel/app/turn-gateway.ts',
    'src/kernel/app/agreement/proposal.ts', 'src/kernel/contracts/agreement-input.ts', 'src/kernel/contracts/goal-proposal.ts', 'src/kernel/app/goal/understanding.ts', 'src/kernel/policies/goal-validator.ts',
    'src/infrastructure/runtime/reflection-runtime.ts', 'src/infrastructure/runtime/reflection-runner.ts', 'src/infrastructure/persistence/reflection-source-read.ts', 'docs/m11.1/M11.1-Acceptance-Contract.md',
    'src/main.ts', 'src/infrastructure/runtime/goal-reflection-queue.ts', 'src/infrastructure/runtime/agreement-runtime.ts', 'src/infrastructure/runtime/agreement-scheduler.ts', 'src/infrastructure/runtime/agreement-runner.ts']
  writeM11Manifest(dir, { runId, wp: 'M11.1-WP3', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'native-goal-commitment-context-controls', phases: ['native-lifecycle', 'budget-matrix'], supersedes: null,
    started, ended: new Date().toISOString(), counts: { total: checks.length, passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length },
    verdict: checks.every(c => c.pass) ? 'PASS' : 'FAIL', cleanClose, environment: 'isolated-offline', plannedRequests: 0, actualRequests: 0, capabilityImpact: 'NONE',
    jointCoverage: ['native-goal-model-and-program-interfaces', 'native-commitment-settlement', 'budget-eight-combinations', 'a12-production-queue', 'independent-watermarks', 'provider-failures', 'exclusive-open-recovery', 'close-fence'],
    limitation: 'G11 mechanical production assembly and actual packets, controlled providers. Real behavior and the 200-dialogue mixed chain remain separate G6/G8 requirements.',
    sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) })
  console.log(JSON.stringify({ runId, checks: checks.map(({ caseId, pass }) => ({ caseId, pass })), cleanClose }, null, 2))
  process.exit(checks.every(c => c.pass) ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
