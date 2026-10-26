/** Isolated PostgreSQL + real Gateway/filesystem, offline planner. No model or production access. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sql } from 'drizzle-orm'
import { runPreparedPgGate, runPreparedPgGateInInstance } from './postgresql/test-harness.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'

if (process.env.LG_EBL_PG_CHILD !== '1') {
  process.env.LG_EBL_PG_CHILD = '1'
  /*
   * ⚠️ **仿真内没有 docker CLI** ⇒ 宿主模式那套"自己起一次性容器"用不了。
   *    ⇒ 仿真里改用**同一个专用隔离实例**（`LG_SIM_PGTEST_ADMIN_URL`），
   *      准备阶段逐条相同（显式迁移 + 身份核对 + `lg_test_` 前缀）。
   *    宿主模式（不给那个变量）**逐字保留**既有行为。
   */
  const simAdminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  if (simAdminUrl !== '') {
    await runPreparedPgGateInInstance(simAdminUrl, 'epistemic-belief', 'scripts/epistemic-belief-pg-verify.ts')
  } else {
    await runPreparedPgGate('epistemic-belief', 'scripts/epistemic-belief-pg-verify.ts')
  }
  process.exit(0)
}
const sandbox = isolateDatabase('epistemic-belief', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

import { createM4Harness } from './m4-harness.ts'
import { createEblStore } from '../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, eblReadbackRef, EBL_TOOL_ENVIRONMENT, EBL_HUMAN_ENVIRONMENT } from '../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createEblTaskObserver, observeEblFeedback } from '../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { EBL_EVENT, EBL_POLICY, makeEblClaim, type EblState } from '../src/kernel/contracts/epistemic-belief.ts'
import { createActionGateway } from '../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import { createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries } from '../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS } from '../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../src/kernel/action/action-request.ts'
import { runTask, type EblTaskObserver } from '../src/kernel/action/task-loop.ts'
import { createTaskAuthorizationRegistry } from '../src/kernel/action/task-authorization.ts'
import { asTraceId, asConversationId, asCharacterId } from '../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../src/kernel/contracts/attribution.ts'
import { domainEventsFor, countDomainEvents } from '../src/infrastructure/persistence/event-store.ts'
import { exec } from '../src/infrastructure/persistence/db.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { createEblRuleSnapshotPort } from '../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import {
  selectUsableRules,
  verifyBaselineBeforeCommit,
  verifyPlanRulesStillUsable,
} from '../src/kernel/contracts/cognitive-collaboration.ts'
import { captureEblEvidenceSources } from './epistemic-belief-evidence.ts'

if (process.argv.includes('--recover-probe')) {
  const target = new URL(process.env.LG_TEST_PG_URL ?? '')
  /*
   * ⚠️ "我连的是**测试库**、不是生产库"这条自保断言。
   *
   * 主机名用**闭集**（`LG_TEST_PG_ALLOWED_HOSTS`，由 harness 给出它刚祝福过的主机）；
   * 缺省只有回环（宿主模式），仿真里额外含隔离实例的服务名 `pgtest`。
   * ⇒ 不是"任何主机名都行"。
   */
  const allowedHosts = (process.env.LG_TEST_PG_ALLOWED_HOSTS ?? '127.0.0.1,localhost')
    .split(',').map(host => host.trim()).filter(host => host !== '')
  assert.ok(allowedHosts.includes(target.hostname) && /^\/lg_test_[a-z0-9_]+$/.test(target.pathname))
  const { default: pg } = await import('pg')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const pool = new pg.Pool({ connectionString: target.toString() })
  try {
    const char = asCharacterId(process.env.LG_EBL_TEST_CHARACTER!)
    const fresh = createEblStore(drizzle(pool) as never, char, createEblSourceReader(process.env.LG_EBL_TEST_USER!))
    const id = process.env.LG_EBL_TEST_CLAIM!
    const state = (await fresh.get(id))!
    assert.equal(state.status, 'validated')
    assert.equal(await fresh.usable(id, { subjectId: state.claim.subjectId, scope: state.claim.scope,
      environment: state.claim.environment, conditions: state.claim.conditions }), false)
    await fresh.recover(id)
    assert.equal((await fresh.get(id))?.status, 'suspended')
    console.log('PASS fresh process rechecks then settles interrupted readback')
  } finally { await pool.end() }
  process.exit(0)
}

const checks: string[] = []
const sourceSnapshot = captureEblEvidenceSources()
function check(name: string, pass: unknown, detail = '') { assert.ok(pass, name); checks.push(name); console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`) }
const output = resolve('artifacts/local/epistemic-belief-lifecycle', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'RUNNING', backend: 'postgres' }))
const fsRoot = mkdtempSync(resolve(output, 'files-'))
const h = await createM4Harness({ label: 'epistemic-belief', userId: 'Alex' })
try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const fsOptions = { root: fsRoot, staging }
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fsOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger: createActionLedgerStore(h.db),
    adapters: [createSandboxReadAdapter(fsOptions), createSandboxWriteAdapter(fsOptions)],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'ebl-pg-test', executorAdapterId: 'sandbox-filesystem' } })
  const observer = createEblTaskObserver(h.db, h.userId)
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const authorizations = createTaskAuthorizationRegistry()
  const anchors: string[] = []
  const refs: ReturnType<typeof eblReadbackRef>[] = []
  let claimId = ''
  async function task(index: number, fault = false, enabled = true, loseSettlement = false) {
    const evidence = await h.recordUserEvidence(`隔离任务 ${index}：写文件后读回，测试标记。`)
    anchors.push(String(evidence.event.id))
    const traceId = asTraceId(`ebl-real-task-${index}`)
    const path = `sample-${index}.txt`
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `task ${index}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'ebl-pg-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'ebl-pg-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    const hook: EblTaskObserver = { before: input => observer.before(input), after: async input => {
      if (fault && input.request.capability === 'sandbox.file.write' && input.result.status === 'success') {
        // Deliberate external-state drift inside this gate's owned sandbox, not a fake readback result.
        writeFileSync(resolve(fsRoot, path), 'changed after writing', 'utf8')
      }
      if (!(loseSettlement && input.request.capability === 'sandbox.file.read')) await observer.after(input)
    } }
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }), ...(enabled ? { epistemic: hook } : {}),
      planner: { id: 'ebl-fixed-offline', endpointHost: 'offline', async plan() {
        return { ok: true, requestCount: 1, plan: { goal: 'roundtrip', done: true, steps: [
          { capability: 'sandbox.file.write', operation: 'write', args: { path, content: 'UTF-8 验证\n' } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path } },
        ] } }
      } } }, { characterId, traceId, authorization, text: `task ${index}` })
    check(`task ${index}: genuine authorized Gateway write/read succeeded`, result.steps.length === 2 && result.steps.every(step => step.status === 'success'))
    check(`task ${index}: lifecycle observer has no hidden failures`, !enabled || result.epistemicFailures === 0)
    const ref = eblReadbackRef(result.steps[0].actionId!, result.steps[1].actionId!, String(evidence.event.id)); refs.push(ref)
    claimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool', predicate: 'readback_matches', expected: true,
      scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' }, formation: ref }).id
    return result
  }
  check('both EBL switches default off', !readKernelFlags({}).epistemicBeliefEnabled && !readKernelFlags({}).epistemicBeliefHumanShadow)
  const disabled = await task(0, false, false)
  check('disabled path emits no EBL events or new outcome fields', await countDomainEvents(h.db, characterId, EBL_EVENT) === 0
    && !('epistemicPredictions' in disabled) && !('epistemicFailures' in disabled))
  const enabled = await task(1)
  check('observer adds no planner calls or tool actions', enabled.plansUsed === disabled.plansUsed && enabled.actionsUsed === disabled.actionsUsed)
  check('first occurrence only forms pending hypothesis', (await store.get(claimId))?.status === 'pending')
  await task(2)
  check('one independent later test cannot validate', (await store.get(claimId))?.status === 'pending')
  await task(3)
  check('two independent tasks and bindings validate', (await store.get(claimId))?.status === 'validated')
  const context = { subjectId: h.userId, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' } }
  check('native source recheck grants authority in supported scope', await store.usable(claimId, context))
  const before = await store.get(claimId)
  assert.deepEqual(await store.rebuild(claimId), before)
  check('rebuild is equal to incremental PostgreSQL state', true)

  // -------------------------------------------------------------------------
  // P1 续：EBL → 协作契约的**快照适配器**（读的是**真实 EBL 状态**，不是夹具）
  // -------------------------------------------------------------------------
  const snapshotPort = createEblRuleSnapshotPort(h.db, characterId, h.userId)
  const validatedSnapshot = await snapshotPort.current(claimId)
  check('协作快照：已验证的规则可读且**合格**',
    validatedSnapshot?.usable === true && validatedSnapshot.status === 'validated',
    `status=${String(validatedSnapshot?.status)} usable=${String(validatedSnapshot?.usable)}`)
  check('协作快照：规则版本 = 命题 id（内容寻址 ⇒ id 变了就是规则变了）',
    validatedSnapshot?.ruleVersion === claimId)
  check('协作快照：主体 / 范围 / 环境 / 政策 与命题一致',
    validatedSnapshot?.subjectId === h.userId &&
    validatedSnapshot.scope === 'sandbox_readback' &&
    validatedSnapshot.environment === EBL_TOOL_ENVIRONMENT &&
    validatedSnapshot.policy === EBL_POLICY,
    `${String(validatedSnapshot?.subjectId)} / ${String(validatedSnapshot?.scope)} / ${String(validatedSnapshot?.policy)}`)
  check('协作快照：证据指纹非空（证据动过就会变）',
    typeof validatedSnapshot?.evidenceFingerprint === 'string' && validatedSnapshot.evidenceFingerprint.length > 0,
    String(validatedSnapshot?.evidenceFingerprint).slice(0, 12))
  const toolBaseline = {
    claimId,
    claimVersion: validatedSnapshot!.claimVersion,
    ruleVersion: validatedSnapshot!.ruleVersion,
    evidenceFingerprint: validatedSnapshot!.evidenceFingerprint,
  }
  const toolExpected = { subjectId: h.userId, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT }
  check('提交前复核：基准一致 ⇒ 放行',
    verifyBaselineBeforeCommit({ baseline: toolBaseline, current: validatedSnapshot, expected: toolExpected }).ok)
  const wrongSubject = verifyBaselineBeforeCommit({ baseline: toolBaseline, current: validatedSnapshot,
    expected: { ...toolExpected, subjectId: 'someone-else' } })
  check('提交前复核：主体不同 ⇒ 拒（subject_mismatch）',
    !wrongSubject.ok && wrongSubject.reason === 'subject_mismatch', wrongSubject.ok ? '竟然放行了' : wrongSubject.detail)
  const staleFingerprint = verifyBaselineBeforeCommit({ baseline: { ...toolBaseline, evidenceFingerprint: 'fp-stale' },
    current: validatedSnapshot, expected: toolExpected })
  check('提交前复核：证据指纹不同 ⇒ 拒（version_conflict）',
    !staleFingerprint.ok && staleFingerprint.reason === 'version_conflict', staleFingerprint.ok ? '竟然放行了' : staleFingerprint.detail)
  const planVerdict = await verifyPlanRulesStillUsable({
    dependencies: [{ claimId, ruleVersion: toolBaseline.ruleVersion, evidenceFingerprint: toolBaseline.evidenceFingerprint }],
    snapshot: snapshotPort,
  })
  check('执行前复核：依赖的规则仍可用 ⇒ 放行', planVerdict.ok, planVerdict.ok ? '' : planVerdict.detail)
  // P2 第一步：规则选择（只从**当前合格**的规则里选，条件未知要单列）
  const allSnapshots = await snapshotPort.list()
  check('协作快照：能列出**当前**的全部命题（读的是投影，不是全库检索）',
    allSnapshots.length > 0, `${String(allSnapshots.length)} 条`)
  const toolSelection = selectUsableRules({
    snapshots: allSnapshots,
    visible: { subjectId: h.userId, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' } },
  })
  check('规则选择：在**真实可见状态**下选出合格的规则',
    toolSelection.selected.length === 1 && toolSelection.selected[0]?.claimId === claimId,
    `选中 ${String(toolSelection.selected.length)} / ${String(allSnapshots.length)}`)
  check('规则选择：不适用的命题**逐条给出原因**（不是被静默丢掉）',
    toolSelection.skipped.length === allSnapshots.length - toolSelection.selected.length,
    toolSelection.skipped.map(item => `${item.claimId}:${item.reason}`).join(' | '))
  const afterValidation = await task(4)
  check('validated rule changes pre-action prediction', afterValidation.epistemicPredictions === 1)
  const applied = await store.get(claimId)
  check('rule-guided success excluded from independent support', applied?.evidence.at(-1)?.independent === false)
  await task(5, true, true, true)
  check('crash between real result and settlement leaves an auditable pending test', (await store.get(claimId))?.status === 'validated')
  check('unsettled readback cannot leave stale authority after restart', !(await store.usable(claimId, context)))
  const resumed = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs',
    'scripts/epistemic-belief-pg-verify.ts', '--recover-probe'], { windowsHide: true, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, LG_EBL_TEST_CHARACTER: String(characterId), LG_EBL_TEST_USER: h.userId, LG_EBL_TEST_CLAIM: claimId } })
  assert.equal(resumed.status, 0, resumed.stderr)
  check('fresh OS process recovers interrupted settlement from PostgreSQL only', resumed.stdout.includes('PASS fresh process'))
  const afterCounterexample = await task(6)
  check('recovery settles actual readback counterexample and suspends rule', (await store.get(claimId))?.status === 'suspended')
  check('next real consumer cannot reuse refuted rule', afterCounterexample.epistemicPredictions === 0)
  check('new successes cannot outvote an unresolved counterexample', (await store.get(claimId))?.status === 'suspended')
  // P1 续：反例之后，**依赖这条规则的计划**必须不能继续沿用（执行前复核）
  const suspendedSnapshot = await snapshotPort.current(claimId)
  check('协作快照：被反例挂起的规则**不再合格**',
    suspendedSnapshot?.usable === false && suspendedSnapshot.status === 'suspended',
    `status=${String(suspendedSnapshot?.status)} usable=${String(suspendedSnapshot?.usable)}`)
  const planAfterCounterexample = await verifyPlanRulesStillUsable({
    dependencies: [{ claimId, ruleVersion: toolBaseline.ruleVersion, evidenceFingerprint: toolBaseline.evidenceFingerprint }],
    snapshot: snapshotPort,
  })
  check('执行前复核：规则失效后**依赖它的计划不能继续沿用**',
    !planAfterCounterexample.ok, planAfterCounterexample.ok ? '竟然放行了' : planAfterCounterexample.detail)
  const count = await countDomainEvents(h.db, characterId, EBL_EVENT)
  const prior = (await domainEventsFor(h.db, characterId, { type: EBL_EVENT })).find(event => (event.payload as { command: { kind: string } }).command.kind === 'propose')!
  const proposal = prior.payload as { command: { kind: 'propose'; claim: EblState['claim'] } }
  await store.commit(claimId, proposal.command)
  check('repeated proposal is idempotent in persistent event stream', await countDomainEvents(h.db, characterId, EBL_EVENT) === count)
  check('foreign subject cannot consume rule', !(await store.usable(claimId, { ...context, subjectId: 'someone-else' })))
  const beforeConcurrent = await countDomainEvents(h.db, characterId, EBL_EVENT)
  const registration = { kind: 'register' as const, test: { id: 'concurrent', episodeId: 'future-episode',
    bindingKey: 'future-binding', designId: 'future-design', targetId: 'future-target', source: eblReadbackRef('future-write', 'future-read', anchors.at(-1)!),
    anchor: { kind: 'conversation' as const, id: anchors.at(-1)! } } }
  await Promise.all([store.commit(claimId, registration), store.commit(claimId, registration), store.commit(claimId, registration)])
  check('concurrent PostgreSQL writers append one registration', await countDomainEvents(h.db, characterId, EBL_EVENT) === beforeConcurrent + 1)

  // Isolated row-level source revocation tests: real memory lifecycle references an EBL anchor.
  const memory = await h.commitAndFold(h.makeCandidate('person_fact', { kind: 'claim', subject: h.user, predicate: 'education.institution', value: 'isolated-fixture' },
    { sourceRefs: [{ kind: 'conversation_event', id: anchors[2] }] }), Date.now())
  // Memory fixture validity is a separate prerequisite; do not silently skip invalidation measurement.
  check('memory dependency fixture created', memory !== null)
  if (memory) {
    await h.applyStateChange('retract', anchors.at(-1)!, { memoryId: String(memory.id), reason: 'explicit_forget' }, Date.now())
    const invalid = await createEblSourceReader(h.userId)(h.db, refs[2], (await store.get(claimId))!.claim, false)
    check('native source read sees withdrawn support immediately', invalid?.usable === false)
  }

  // Human shadow uses actual qualified user events + the reviewed bounded style adapter, no model.
  const recorder = new ConversationRecorder({ db: h.db, characterId, conversationId: asConversationId('ebl-human-shadow-session'),
    dryRun: false, userId: h.userId, userName: 'fixture', characterName: 'fixture', transport: 'ebl-pg-test',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()] })
  const feedback = async (text: string, sequence: number, sourceRecorder = recorder) => {
    const result = await sourceRecorder.recordUserMessage(text, sequence)
    assert.ok(result.event)
    await observeEblFeedback(h.db, characterId, h.userId, String(result.event.id))
    return String(result.event.id)
  }
  await recorder.recordUserMessage('下面讨论技术讲解与算法。', 1)
  const first = await feedback('以后请先给结论，少讲铺垫。', 2)
  const human = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'interpersonal', predicate: 'explanation_detail',
    expected: 'concise', scope: 'technical_explanation', environment: EBL_HUMAN_ENVIRONMENT,
    conditions: { scene: 'technical_explanation' }, formation: { kind: 'conversation', id: first } })
  check('human feedback can form separate shadow hypothesis', (await store.get(human.id))?.status === 'pending')
  await feedback('以后请先给结论，少讲铺垫。', 3)
  check('human feedback settles only an earlier registered test', (await store.get(human.id))?.evidence.length === 1)
  const beforeTurnException = await store.get(human.id)
  await feedback('这次请详细解释。', 4)
  check('H2 current-turn exception neither confirms nor refutes long-term inference',
    JSON.stringify(await store.get(human.id)) === JSON.stringify(beforeTurnException))
  const nextRecorder = new ConversationRecorder({ db: h.db, characterId, conversationId: asConversationId('ebl-human-next-session'),
    dryRun: false, userId: h.userId, userName: 'fixture', characterName: 'fixture', transport: 'ebl-pg-test',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()] })
  await nextRecorder.recordUserMessage('下面讨论技术讲解与算法。', 1)
  const correctedAt = await feedback('你理解错了，我一般更需要详细解释。', 2, nextRecorder)
  check('opposite explicit feedback suspends old interpretation', (await store.get(human.id))?.status === 'suspended')
  const corrected = (await store.get(human.id))!
  check('H3 direct correction works in a new episode without a pre-registered experiment',
    corrected.corrections?.length === 1 && corrected.corrections[0].ref.id === correctedAt
    && corrected.evidence.length === 1 && corrected.formation.ref.id === first)
  const eventCount = await countDomainEvents(h.db, characterId, EBL_EVENT)
  await observeEblFeedback(h.db, characterId, h.userId, correctedAt)
  check('repeated human feedback event is idempotent', await countDomainEvents(h.db, characterId, EBL_EVENT) === eventCount)
  assert.deepEqual(await store.rebuild(human.id), corrected)
  check('direct correction rebuild preserves prior evidence and separate correction', true)
  const detailed = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'interpersonal', predicate: 'explanation_detail',
    expected: 'detailed', scope: 'technical_explanation', environment: EBL_HUMAN_ENVIRONMENT,
    conditions: { scene: 'technical_explanation' }, formation: { kind: 'conversation', id: correctedAt } })
  await feedback('我以前喜欢详细，现在更喜欢简短。', 3, nextRecorder)
  check('H4 current preference change suspends old rule without rewriting its past formation',
    (await store.get(detailed.id))?.status === 'suspended' && (await store.get(detailed.id))?.formation.ref.id === correctedAt)
  const beforeThirdParty = await countDomainEvents(h.db, characterId, EBL_EVENT)
  await feedback('她说她更喜欢详细的讲解。', 4, nextRecorder)
  check('unbound third-party report is never stored as current user preference', await countDomainEvents(h.db, characterId, EBL_EVENT) === beforeThirdParty)
  check('human shadow never grants behavior authority', !(await store.usable(human.id, { subjectId: h.userId,
    scope: human.scope, environment: human.environment, conditions: human.conditions })))
  const oldBeliefs = await exec(h.db, sql`select count(*)::int as count from character_projections where character_id = ${String(characterId)} and projection_type like 'belief:%'`, 'EBL legacy separation')
  check('EBL does not rewrite legacy M9 projections', Number(oldBeliefs[0]?.count) === 0)
  await store.commit(human.id, { kind: 'withdraw' })
  // P1 续：撤回后的快照要**说清为什么**不可用（source_withdrawn，不是笼统的 not_usable）
  const withdrawnSnapshot = await snapshotPort.current(human.id)
  check('协作快照：撤回后原因 = source_withdrawn',
    withdrawnSnapshot?.usable === false && withdrawnSnapshot.invalidatedReason === 'source_withdrawn',
    `status=${String(withdrawnSnapshot?.status)} reason=${String(withdrawnSnapshot?.invalidatedReason)}`)
  const { id: humanId, policy: humanPolicy, ...humanInput } = human
  const forbiddenAttempt = makeEblClaim({ ...humanInput, predecessor: humanId, expected: 'detailed', formation: { kind: 'conversation', id: first } })
  assert.equal(await store.get(forbiddenAttempt.id), undefined)
  await assert.rejects(() => store.commit(forbiddenAttempt.id, { kind: 'propose', claim: forbiddenAttempt }), /formation_source/)
  check('withdrawn roots cannot form a different new claim', true)
  assert.ok(checks.length > 0)
  assert.ok(sourceSnapshot.measured_files > 0)
  assert.deepEqual(captureEblEvidenceSources(), sourceSnapshot, 'tested EBL sources changed during the gate')
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres', evidenceKind: 'real_gateway_real_files_offline_planner',
    measured_count: checks.length, checks, ...sourceSnapshot, productionOpened: false, modelCalls: 0, humanAcceptance: 'NOT RUN' }, null, 2))
  console.log(`EBL PostgreSQL: ${checks.length}/${checks.length}; ${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks, error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally { await h.stop() }
