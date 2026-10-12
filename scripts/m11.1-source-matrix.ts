import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m111-source-matrix', { keep: false })
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { createM4Harness, M4_T0 } from './m4-harness.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'
import { readReflectionSourceSnapshot } from '../src/infrastructure/persistence/reflection-source-read.ts'
import { insertProjection, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { listBeliefsByStatus } from '../src/infrastructure/persistence/belief-store.ts'
import { seedBeliefOrigin, maybeRunBeliefMemoryReconciliation } from '../src/infrastructure/runtime/belief-scheduler.ts'
import { listJobs } from '../src/infrastructure/persistence/job-store.ts'
import type { LineageHandle } from '../src/kernel/contracts/reflection-lineage.ts'
import type { BeliefState } from '../src/kernel/contracts/belief.ts'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'

async function main() {
  const started = new Date().toISOString()
  const h = await createM4Harness({ label: 'm111-source-matrix' })
  const characterId = h.kernel.characterId
  const checks: { caseId: string; pass: boolean; observed: unknown }[] = []
  const check = (caseId: string, pass: boolean, observed: unknown) => checks.push({ caseId, pass, observed })
  const read = (handles: readonly LineageHandle[]) => readReflectionSourceSnapshot(h.db, characterId, handles, { activeUserId: h.userId })
  let cleanClose = false
  try {
    const recorder = new ConversationRecorder({ db: h.db, characterId, conversationId: asConversationId('m111-source-matrix-session'),
      dryRun: false, userId: h.userId, userName: 'Alex', characterName: '苏沐薇', transport: 'm111-source-matrix',
      attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()] })
    const evidence = await recorder.recordUserMessage('隔离来源资格样本：对象不明时先核对。', 1)
    if (!evidence.event) throw new Error('native evidence not recorded')
    const root = String(evidence.event.id)
    const memory = await h.commitAndFold(h.makeCandidate('preference', { kind: 'claim', subject: h.user,
      predicate: 'm111.source.preference', value: '先核对' }, { sourceRefs: [{ kind: 'conversation_event', id: root }] }), M4_T0 + 1)
    if (!memory) throw new Error('native memory positive control rejected')
    const memoryHandles: LineageHandle[] = [{ kind: 'memory', id: String(memory.id) }]
    const positiveMemory = await read(memoryHandles)
    check('native-memory-positive', positiveMemory.usable, { nativeValidatorAndReducer: true, snapshot: positiveMemory })
    // Each corruption changes only the named field in an isolated fixture, retaining its qualified original root.
    await h.db.execute(sql`update memory_records set owner_kind = 'user', owner_id = 'other-user' where id = ${String(memory.id)}`)
    check('memory-foreign-owner', !(await read(memoryHandles)).usable, { isolatedCorruption: 'owner' })
    await h.db.execute(sql`update memory_records set owner_kind = 'character', owner_id = ${String(characterId)} where id = ${String(memory.id)}`)
    await h.db.execute(sql`update memory_subject_links set subject_id = 'other-user' where memory_id = ${String(memory.id)} and subject_kind = 'user'`)
    check('memory-foreign-subject', !(await read(memoryHandles)).usable, { isolatedCorruption: 'subjects' })
    await h.db.execute(sql`update memory_subject_links set subject_id = ${h.userId} where memory_id = ${String(memory.id)} and subject_kind = 'user'`)
    await h.db.execute(sql`update memory_records set valid_until = '1' where id = ${String(memory.id)}`)
    check('memory-expired', !(await read(memoryHandles)).usable, { isolatedCorruption: 'validUntil' })
    await h.db.execute(sql`update memory_records set valid_until = null where id = ${String(memory.id)}`)
    for (const status of ['disputed', 'superseded', 'retracted']) {
      await h.db.execute(sql`update memory_records set status = ${status} where id = ${String(memory.id)}`)
      const snapshot = await read(memoryHandles)
      check(`memory-${status}`, !snapshot.usable || (status === 'disputed' && snapshot.unresolvedConflict), { usable: snapshot.usable, conflict: snapshot.unresolvedConflict })
    }
    await h.db.execute(sql`update memory_records set status = 'active' where id = ${String(memory.id)}`)
    check('memory-controls-restored', (await read(memoryHandles)).usable, { restoredFixtureOnly: true })
    // This projection is explicitly a read-side fixture, not a claim of native Belief lifecycle validation.
    const belief: BeliefState = { beliefId: 'blf:m111-source-fixture' as never, perspectiveOwnerId: characterId as never,
      subject: h.user, proposition: { predicate: 'm111.source.preference', value: '先核对', scopeKey: 'general' },
      epistemicKind: 'reported', status: 'active', supportLevel: 'supported', evidenceRefs: [evidence.event.id],
      evidenceRootIds: [evidence.event.id], dependsOnMemoryIds: [memory.id], ruleId: 'm111-controlled-read-fixture', ruleVersion: 'fixture@1' }
    const projectionType = `belief:${belief.beliefId}`
    await insertProjection(h.db, { characterId, projectionType, revision: 1, reducerVersion: 'controlled-fixture@1', state: belief, updatedAt: M4_T0 + 2 })
    const beliefHandles: LineageHandle[] = [{ kind: 'belief', id: String(belief.beliefId) }]
    const setBelief = async (state: BeliefState) => h.db.execute(sql`update character_projections set state = ${JSON.stringify(state)}::jsonb where character_id = ${String(characterId)} and projection_type = ${projectionType}`)
    check('belief-read-fixture-positive', (await read(beliefHandles)).usable, { controlledProjection: true, nativeMemoryDependency: true })
    for (const status of ['disputed', 'superseded', 'retracted'] as const) {
      await setBelief({ ...belief, status })
      const snapshot = await read(beliefHandles)
      check(`belief-${status}`, !snapshot.usable || (status === 'disputed' && snapshot.unresolvedConflict), { usable: snapshot.usable, conflict: snapshot.unresolvedConflict })
    }
    await setBelief({ ...belief, subject: { kind: 'user', id: 'other-user' } as never })
    check('belief-foreign-subject', !(await read(beliefHandles)).usable, { isolatedCorruption: 'subject' })
    await setBelief({ ...belief, perspectiveOwnerId: 'other-character' as never })
    check('belief-foreign-perspective', !(await read(beliefHandles)).usable, { isolatedCorruption: 'perspectiveOwnerId' })
    await setBelief({ ...belief, proposition: { ...belief.proposition, validTo: 1 as never } })
    check('belief-expired', !(await read(beliefHandles)).usable, { isolatedCorruption: 'validTo' })
    await setBelief(belief)
    await h.db.execute(sql`update memory_records set authority = 'MODEL_INFERENCE', epistemic_status = 'inferred' where id = ${String(memory.id)}`)
    check('belief-current-memory-qualification', !(await read(beliefHandles)).usable, { isolatedCorruption: 'reported dependency qualification' })
    await h.db.execute(sql`update memory_records set authority = ${memory.authority}, epistemic_status = ${memory.epistemicStatus} where id = ${String(memory.id)}`)
    check('belief-controls-restored', (await read(beliefHandles)).usable, { restoredFixtureOnly: true })
    // Native lifecycle evidence is separate from the SQL/read-side controls above.
    let nativeClock = M4_T0 + 1000
    await seedBeliefOrigin(h.db, { characterId, activationId: 'm111-source-native-origin', now: ++nativeClock })
    const nativeEvidence = await recorder.recordUserMessage('以后技术问题先给简短结论。', 2)
    if (!nativeEvidence.event) throw new Error('native lifecycle evidence missing')
    const nativeMemory = await h.commitAndFold(h.makeCandidate('preference', { kind: 'claim', subject: h.user,
      predicate: 'preference.answer_length', value: 'concise_summary', qualifiers: { context: 'technical' } },
    { sourceRefs: [{ kind: 'conversation_event', id: String(nativeEvidence.event.id) }] }), ++nativeClock)
    if (!nativeMemory) throw new Error('native lifecycle memory rejected')
    const nativeHandles: LineageHandle[] = [{ kind: 'memory', id: String(nativeMemory.id) }]
    check('native-lifecycle-memory-active', (await read(nativeHandles)).usable, { memoryId: String(nativeMemory.id), validatorAndReducer: true })
    const reconcile = async () => {
      for (let page = 0; page < 20; page++) {
        const result = await maybeRunBeliefMemoryReconciliation(h.db, { characterId, now: ++nativeClock })
        if (result.kind === 'no_tail') return
      }
      throw new Error('native belief reconciliation did not exhaust its bounded fixture')
    }
    await reconcile()
    const nativeBelief = (await listBeliefsByStatus(h.db, characterId, ['active'])).find(row =>
      row.epistemicKind === 'reported' && row.dependsOnMemoryIds.map(String).includes(String(nativeMemory.id)))
    if (!nativeBelief) throw new Error('native reported belief positive control did not form')
    const nativeBeliefHandles: LineageHandle[] = [{ kind: 'belief', id: String(nativeBelief.beliefId) }]
    const nativeEvents = await domainEventsFor(h.db, characterId)
    check('native-reported-belief-validator-event-reducer', (await read(nativeBeliefHandles)).usable && nativeEvents.some(event =>
      event.type === 'BELIEF_FORMED' && (event.payload as { beliefId?: string }).beliefId === String(nativeBelief.beliefId)),
      { beliefId: String(nativeBelief.beliefId), memoryId: String(nativeMemory.id), rawProjectionInsert: false })
    const disputeEvidence = await recorder.recordUserMessage('这条技术回答偏好有争议，先不要据它决定。', 3)
    if (!disputeEvidence.event) throw new Error('native dispute evidence missing')
    await h.applyStateChange('dispute', String(disputeEvidence.event.id), { memoryId: nativeMemory.id,
      conflictingMemoryIds: [], reason: '用户明确争议' }, ++nativeClock)
    const disputedMemory = await read(nativeHandles)
    const disputedBelief = await read(nativeBeliefHandles)
    check('native-memory-dispute-and-dependent-belief-block', (!disputedMemory.usable || disputedMemory.unresolvedConflict) &&
      (!disputedBelief.usable || disputedBelief.unresolvedConflict), { memoryConflict: disputedMemory.unresolvedConflict, beliefConflict: disputedBelief.unresolvedConflict })
    const restoreEvidence = await recorder.recordUserMessage('争议已澄清，恢复这条技术回答偏好。', 4)
    if (!restoreEvidence.event) throw new Error('native restore evidence missing')
    await h.applyStateChange('restore', String(restoreEvidence.event.id), { memoryId: nativeMemory.id, reason: '用户澄清争议' }, ++nativeClock)
    check('native-explicit-memory-restore-requalifies-dependency', (await read(nativeHandles)).usable && (await read(nativeBeliefHandles)).usable,
      { explicitValidatorAction: true, automaticRevival: false })
    const forgetEvidence = await recorder.recordUserMessage('忘掉这条技术回答偏好。', 5)
    if (!forgetEvidence.event) throw new Error('native forget evidence missing')
    await h.applyStateChange('retract', String(forgetEvidence.event.id), { memoryId: nativeMemory.id, reason: 'explicit_forget' }, ++nativeClock)
    check('native-forget-blocks-memory-and-belief-before-worker', !(await read(nativeHandles)).usable && !(await read(nativeBeliefHandles)).usable,
      { nativeMemoryStatus: (await h.store.get(nativeMemory.id))?.status, reconciliationAlreadyRun: false })
    await reconcile()
    const terminalBelief = (await listBeliefsByStatus(h.db, characterId, ['retracted'])).find(row => row.beliefId === nativeBelief.beliefId)
    check('native-forget-belief-event-projection-job', terminalBelief !== undefined && (await domainEventsFor(h.db, characterId)).some(event =>
      event.type === 'BELIEF_RETRACTED' && (event.payload as { beliefId?: string }).beliefId === String(nativeBelief.beliefId)) &&
      (await listJobs(h.db, characterId)).some(job => job.status === 'completed' && job.processor.includes('belief')),
      { terminalStatus: terminalBelief?.status, validatorAndReducer: true })
    const eventCountBefore = (await domainEventsFor(h.db, characterId)).length
    await reconcile()
    check('native-terminal-repeat-is-idempotent', (await domainEventsFor(h.db, characterId)).length === eventCountBefore && !(await read(nativeBeliefHandles)).usable,
      { eventsAdded: (await domainEventsFor(h.db, characterId)).length - eventCountBefore })
    const oldEvidence = await recorder.recordUserMessage('旧状态样本。', 6)
    const newEvidence = await recorder.recordUserMessage('状态已变为新值。', 7)
    if (!oldEvidence.event || !newEvidence.event) throw new Error('native supersede evidence missing')
    const createState = (value: string, rootId: string) => h.commitAndFold(h.makeCandidate('person_fact', { kind: 'claim', subject: h.user,
      predicate: 'm111.native.state', value }, { sourceRefs: [{ kind: 'conversation_event', id: rootId }] }), ++nativeClock)
    const oldState = await createState('old', String(oldEvidence.event.id))
    const newState = await createState('new', String(newEvidence.event.id))
    if (!oldState || !newState) throw new Error('native supersede positive control rejected')
    check('native-supersede-positive-before-change', (await read([{ kind: 'memory', id: String(oldState.id) }])).usable,
      { oldMemoryId: String(oldState.id) })
    await h.applyStateChange('supersede', String(newEvidence.event.id), { memoryId: oldState.id, supersededBy: newState.id,
      validUntil: nativeClock, reason: '用户报告状态变化' }, ++nativeClock)
    check('native-supersede-old-blocked-new-usable', !(await read([{ kind: 'memory', id: String(oldState.id) }])).usable &&
      (await read([{ kind: 'memory', id: String(newState.id) }])).usable, { oldStatus: (await h.store.get(oldState.id))?.status })
  } finally { await h.stop(); cleanClose = true }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'm111-source-matrix', headShort: head })
  const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
  const paths = ['scripts/m11.1-source-matrix.ts', 'src/infrastructure/persistence/reflection-source-read.ts', 'src/infrastructure/persistence/reflection-lineage-read.ts',
    'src/kernel/app/belief/eligibility.ts', 'src/kernel/recall/eligibility.ts', 'scripts/m4-harness.ts', 'src/kernel/policies/memory-validator.ts',
    'src/infrastructure/persistence/memory-store.ts', 'src/infrastructure/runtime/belief-scheduler.ts', 'src/kernel/policies/belief-validator.ts',
    'src/infrastructure/persistence/belief-store.ts', 'docs/m11.1/M11.1-Acceptance-Contract.md']
  writeM11Manifest(dir, { runId, wp: 'M11.1-WP2', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'current-derived-source-controls', phases: ['positive', 'negative', 'recovery'], supersedes: null,
    started, ended: new Date().toISOString(), counts: { total: checks.length, passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length },
    cleanClose, environment: 'isolated-offline', plannedRequests: 0, actualRequests: 0, capabilityImpact: 'NONE',
    verdict: checks.every(c => c.pass) ? 'PARTIAL' : 'FAIL',
    limitation: 'Read-side controls plus native Memory/reported-Belief lifecycle. Expiry is a read-side control only; creation has no validUntil proposal field. Inferred-Belief and the full capture/generation/commit/consumer matrix remain uncovered; G1 remains PARTIAL.',
    sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) })
  console.log(JSON.stringify({ runId, checks: checks.map(({ caseId, pass }) => ({ caseId, pass })), cleanClose }, null, 2))
  process.exit(checks.every(c => c.pass) ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
