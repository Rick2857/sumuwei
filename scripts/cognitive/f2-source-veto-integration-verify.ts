/** R2: real files -> Gateway ledger -> native EBL -> per-candidate source veto. Zero model calls. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'
import { isolateDatabase } from '../../src/dev/sandbox.ts'

if (process.env.LG_F2_SOURCE_PG_CHILD !== '1') {
  process.env.LG_F2_SOURCE_PG_CHILD = '1'
  const admin = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  if (admin) await runPreparedPgGateInInstance(admin, 'f2-source-veto', 'scripts/cognitive/f2-source-veto-integration-verify.ts')
  else await runPreparedPgGate('f2-source-veto', 'scripts/cognitive/f2-source-veto-integration-verify.ts')
  process.exit(0)
}
const sandbox = isolateDatabase('f2-source-veto', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

import { createM4Harness } from '../m4-harness.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import { contentFingerprint, createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS, SANDBOX_FILE_WRITE } from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { runTask } from '../../src/kernel/action/task-loop.ts'
import type { TaskPlan, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, EBL_TOOL_ENVIRONMENT } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { readWriteSourceReceipts } from '../../src/infrastructure/persistence/write-source-read.ts'
import { makeEblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
import { sandboxWriteFamilyScope } from '../../src/kernel/contracts/write-family.ts'
import { writePreconditionConditions } from '../../src/kernel/contracts/write-precondition.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { evaluateCandidatePreconditionVeto } from '../../src/infrastructure/runtime/precondition-veto.ts'
import { buildTransitionRule } from '../../src/infrastructure/runtime/world-model-transition.ts'
import { createSimulationTaskPlanner } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { actionFailure, ActionFailureError } from '../../src/kernel/action/errors.ts'
import type { CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'

const output = resolve('artifacts/local/f2-source-veto', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
const root = mkdtempSync(resolve(output, 'files-'))
const FAMILY = 'f2/a', GUARD = 'f2-guard.txt'
mkdirSync(resolve(root, FAMILY), { recursive: true })
const declaration = { familyId: FAMILY, conditionPath: GUARD, mustNotEqual: 'stale' }
const writeSources = (path: string) => [
  { kind: 'cache' as const, path: path.replace(/\.txt$/, '.cache') },
  { kind: 'authoritative' as const, path: path.replace(/\.txt$/, '.src') },
]
const h = await createM4Harness({ label: 'f2-source-veto', userId: 'Alex' })
const checks: string[] = []
function check(name: string, value: unknown) { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`) }
try {
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const fs = { root, staging, conditionPaths: [GUARD] }
  const writeAdapter = createSandboxWriteAdapter(fs)
  const guarded: CapabilityAdapter = { capabilityId: SANDBOX_FILE_WRITE, async execute(input) {
    const path = String(input.args.path)
    const value = typeof input.args.content === 'string' ? input.args.content : staging.read(String(input.args.payloadRef))
    const content = typeof value === 'string' ? value : value?.kind === 'text' ? value.text : undefined
    if (path.endsWith('.txt') && content !== readFileSync(resolve(root, path.replace(/\.txt$/, '.src')), 'utf8')) {
      throw new ActionFailureError(actionFailure('validation_failed', 'Content differs from the authoritative source'))
    }
    return writeAdapter.execute(input)
  } }
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fs), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger: createActionLedgerStore(h.db), adapters: [createSandboxReadAdapter(fs), guarded],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'f2-source-test', executorAdapterId: 'sandbox-filesystem' } })
  const authorizations = createTaskAuthorizationRegistry()
  const sourceOptions = { knownDirectories: () => [FAMILY], writeSources }
  const observer = createEblTaskObserver(h.db, h.userId, { ...sourceOptions, preconditions: [declaration] })
  const store = createEblStore(h.db, h.kernel.characterId, createEblSourceReader(h.userId, sourceOptions))
  const snapshots = createEblRuleSnapshotPort(h.db, h.kernel.characterId, h.userId, sourceOptions)
  const read = (path: string) => ({ capability: 'sandbox.file.read', operation: 'read', args: { path } })
  const write = (path: string, content: string) => ({ capability: 'sandbox.file.write', operation: 'write', args: { path, content } })
  let ordinal = 0
  const prepare = (name: string, stale: boolean) => {
    const path = `${FAMILY}/${name}.txt`, auth = `auth-${name}`, cache = stale ? `old-${name}` : auth
    writeFileSync(resolve(root, path.replace(/\.txt$/, '.cache')), cache)
    writeFileSync(resolve(root, path.replace(/\.txt$/, '.src')), auth)
    writeFileSync(resolve(root, GUARD), stale ? 'stale' : 'fresh')
    return { path, auth, cache }
  }
  async function task(plans: readonly TaskPlan[], planner?: TaskPlannerPort, trace?: string) {
    const n = ++ordinal
    const evidence = await h.recordUserEvidence(`F2 isolated task ${n}`)
    const traceId = asTraceId(trace ?? `f2-source-${n}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `F2 ${n}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'f2-source-test', causalSource:
      correlationSourceFromConversationEvent({ adapterId: 'f2-source-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    let index = 0
    const offline: TaskPlannerPort = { id: 'f2-fixed', endpointHost: 'offline', async plan() {
      const plan = plans[index++]
      return plan ? { ok: true, requestCount: 1, plan } : { ok: false, requestCount: 0, failure: 'call_failed' }
    } }
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget, epistemic: observer, ruleSnapshot: snapshots,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }), planner: planner ?? offline },
    { characterId: h.kernel.characterId, traceId, authorization, text: `F2 ${n}` })
    check(`task ${n}: observer has no swallowed failures`, (result.epistemicFailures ?? 0) === 0)
    return { result, traceId: String(traceId) }
  }
  // Formation is not support. Two subsequent failures and a later control are required.
  for (let n = 1; n <= 6; n++) {
    const object = prepare(`learn-${n}`, n <= 3)
    const { result } = await task([{ goal: 'copy source', done: true, steps: [read(GUARD), read(object.path.replace(/\.txt$/, '.cache')),
      write(object.path, object.cache), read(object.path)] }])
    check(`learning ${n}: real content truth`, n <= 3
      ? !existsSync(resolve(root, object.path)) && result.results.some(item => item.result.error?.code === 'validation_failed')
      : readFileSync(resolve(root, object.path), 'utf8') === object.auth)
    if (n === 3) check('two supports without a control remain unusable', !(await snapshots.list())
      .some(item => item.predicate === 'write_precondition_holds' && item.usable))
  }
  const claimId = makeEblClaim({ characterId: String(h.kernel.characterId), subjectId: h.userId, domain: 'tool', predicate: 'write_precondition_holds',
    expected: true, scope: sandboxWriteFamilyScope(FAMILY), environment: EBL_TOOL_ENVIRONMENT,
    conditions: writePreconditionConditions(declaration, 'cache'), formation: { kind: 'action', id: 'shape-only' } }).id
  const state = await store.get(claimId)
  check('native EBL qualifies a cache-scoped rule using distinct bindings and control', state?.status === 'validated')
  const snapshot = await snapshots.current(claimId)
  assert.ok(snapshot)
  const translated = buildTransitionRule(snapshot)
  check('translation preserves learned source scope', 'rule' in translated && translated.rule.sourceScope === 'cache')

  const object = prepare('holdout', true)
  const observed = await task([{ goal: 'read sources', done: true, steps: [read(GUARD), ...writeSources(object.path).map(source => read(source.path))] }])
  const input = { enabled: true, db: h.db, characterId: h.kernel.characterId, activeUserId: h.userId, targetPath: object.path,
    traceId: observed.traceId, knownDirectories: () => [FAMILY], declarations: [declaration], writeSources }
  const candidates = [
    { id: 'cache', writeFingerprints: [contentFingerprint(object.cache)] },
    { id: 'auth', writeFingerprints: [contentFingerprint(object.auth)] },
    { id: 'unknown', writeFingerprints: [contentFingerprint('not observed')] },
  ]
  const veto = await evaluateCandidatePreconditionVeto(input, candidates)
  check('new object: only cache candidate is vetoed', JSON.stringify(veto.vetoedIds) === '["cache"]')
  check('source attribution uses actual read bytes', veto.attributions.map(item => item.attribution).join(',') === 'cache,authoritative,unknown')
  check('candidate permutation preserves content-based veto', JSON.stringify((await evaluateCandidatePreconditionVeto(input, [...candidates].reverse())).vetoedIds) === '["cache"]')
  check('switch off preserves old behavior', (await evaluateCandidatePreconditionVeto({ ...input, enabled: false }, candidates)).vetoedIds.length === 0)
  check('switch off never invokes the source provider', (await evaluateCandidatePreconditionVeto({ ...input, enabled: false,
    writeSources: () => { throw new Error('source provider must not run') } }, candidates)).vetoedIds.length === 0)
  check('another trace cannot borrow receipts', (await evaluateCandidatePreconditionVeto({ ...input, traceId: 'unexecuted' }, candidates)).vetoedIds.length === 0)
  check('another user cannot borrow receipts', (await evaluateCandidatePreconditionVeto({ ...input, activeUserId: 'Other' }, candidates)).vetoedIds.length === 0)
  check('wrong family cannot consume', (await evaluateCandidatePreconditionVeto({ ...input, targetPath: 'other/a/o.txt', knownDirectories: () => ['other/a'] }, candidates)).vetoedIds.length === 0)
  const unknownCondition = await task([{ goal: 'sources only', done: true, steps: writeSources(object.path).map(source => read(source.path)) }])
  check('unknown condition does not veto', (await evaluateCandidatePreconditionVeto({ ...input, traceId: unknownCondition.traceId }, candidates)).vetoedIds.length === 0)

  // The production simulation planner consumes the same reader and filter (no mock snapshot).
  const selections: unknown[] = []
  const planner = createSimulationTaskPlanner({ db: h.db, characterId: h.kernel.characterId, activeUserId: h.userId,
    modelVersion: 'f2-r2-gate', facts: { encoding: 'utf8' }, registry,
    goal: { path: object.path, expectedFingerprint: contentFingerprint(object.cache) },
    precondition: { enabled: true, knownDirectories: () => [FAMILY], declarations: [declaration], writeSources },
    candidateSource: { id: 'offline', endpointHost: 'offline', async propose() { return { requestCount: 1,
      candidates: [{ goal: 'candidate', done: true, steps: [write(object.path, object.cache), read(object.path)] }] } } },
    onSelection: selection => selections.push(selection) })
  const planned = await planner.plan({ task: 'probe', traceId: observed.traceId, executed: [], failures: [], remainingActions: 4,
    allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'] })
  check('production planner removes the real cache-backed candidate', !planned.ok && JSON.stringify(selections).includes('precondition_violated'))

  const ambiguous = prepare('ambiguous', false)
  const ambiguousReads = await task([{ goal: 'read both identical sources', done: true,
    steps: [read(GUARD), ...writeSources(ambiguous.path).map(source => read(source.path))] }])
  const ambiguousVeto = await evaluateCandidatePreconditionVeto({ ...input, targetPath: ambiguous.path, traceId: ambiguousReads.traceId },
    [{ id: 'same', writeFingerprints: [contentFingerprint(ambiguous.auth)] }])
  check('identical observed sources remain unknown', ambiguousVeto.attributions[0]?.attribution === 'unknown' && ambiguousVeto.vetoedIds.length === 0)

  // R4 is not installed here: deliberately exercise the read-side defense against a source mutation.
  writeFileSync(resolve(root, GUARD), 'stale')
  const mutated = await task([{ goal: 'invalidate earlier source read', done: true, steps: [read(GUARD),
    read(object.path.replace(/\.txt$/, '.cache')), write(object.path.replace(/\.txt$/, '.cache'), 'changed source')] }])
  const mutationVeto = await evaluateCandidatePreconditionVeto({ ...input, traceId: mutated.traceId }, candidates)
  check('source write after read invalidates its receipt', mutationVeto.attributions[0]?.attribution === 'unknown' && mutationVeto.vetoedIds.length === 0)

  const transfer = prepare('transfer', true)
  let transferRound = 0
  let transferVeto: string[] = []
  const transferPlanner: TaskPlannerPort = { id: 'f2-fixed-consumer', endpointHost: 'offline', async plan(input) {
    if (transferRound++ === 0) return { ok: true, requestCount: 1,
      plan: { goal: 'observe real sources', done: false, steps: [read(GUARD), ...writeSources(transfer.path).map(source => read(source.path))] } }
    const evaluated = await evaluateCandidatePreconditionVeto({ enabled: true, db: h.db, characterId: h.kernel.characterId,
      activeUserId: h.userId, targetPath: transfer.path, traceId: input.traceId,
      knownDirectories: () => [FAMILY], declarations: [declaration], writeSources }, [
      { id: 'cache', writeFingerprints: [contentFingerprint(transfer.cache)] },
      { id: 'auth', writeFingerprints: [contentFingerprint(transfer.auth)] },
    ])
    transferVeto = evaluated.vetoedIds
    const content = transferVeto.includes('cache') ? transfer.auth : transfer.cache
    return { ok: true, requestCount: 1, plan: { goal: 'write chosen source and verify', done: true,
      steps: [write(transfer.path, content), read(transfer.path)] } }
  } }
  const transferred = await task([], transferPlanner)
  check('coupled chain: learned veto selects source, then actual write and readback succeed',
    JSON.stringify(transferVeto) === '["cache"]' && readFileSync(resolve(root, transfer.path), 'utf8') === transfer.auth
    && transferred.result.results.at(-1)?.result.effect?.fingerprint === contentFingerprint(transfer.auth))

  // Recovery uses a viable alternative; failure is not mistaken for terminal no-progress.
  const recovered = prepare('recover', true)
  const recovery = await task([
    { goal: 'try cache', done: false, steps: [read(GUARD), read(recovered.path.replace(/\.txt$/, '.cache')), write(recovered.path, recovered.cache)] },
    { goal: 'recover from source', done: true, steps: [read(recovered.path.replace(/\.txt$/, '.src')), write(recovered.path, recovered.auth), read(recovered.path)] },
  ])
  check('ordinary path retains recovery after failed write', recovery.result.results.some(item => item.result.error?.code === 'validation_failed')
    && readFileSync(resolve(root, recovered.path), 'utf8') === recovered.auth)
  check('read side does not invent receipts without execution', (await readWriteSourceReceipts(h.db, { characterId: String(h.kernel.characterId),
    activeUserId: h.userId, traceId: 'unexecuted', declarations: writeSources(object.path) })).length === 0)
  await store.commit(claimId, { kind: 'withdraw' })
  check('withdrawal immediately prevents source veto', (await evaluateCandidatePreconditionVeto(input, candidates)).vetoedIds.length === 0)
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ checks, realModelRequests: 0,
    boundary: 'R2 only: runTask/Gateway/native EBL and production planner; not ActionTurn, F2 authorization or full F2 experiment' }, null, 2))
  console.log(`F2 source-veto integration: ${checks.length} checks passed; real model requests=0`)
} finally { await h.stop() }
