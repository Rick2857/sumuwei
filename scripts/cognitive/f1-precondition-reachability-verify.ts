/**
 * **ADR-151 R1 的可达性门**（有界条件观察 + F1 任务入口）。
 *
 * 隔离 PostgreSQL · 真实 Gateway · 真实文件 · **零模型请求**。
 *
 * 它证明的是**从任务入口开始**的那条链（不靠预置 trace）：
 * ```text
 * 两行精确请求
 *   ⇒ 正式装配 createSimulationPlanning 认出"新入口"并给出**任务局部只读范围**
 *     ⇒ 任务环（授权 + 预算 + 唯一 Gateway）第 1 轮：**一次**真实条件读
 *       ⇒ 下一轮：六行真值表 ⇒ 条件被违反 ⇒ 否决 ⇒ 目标不达成 / 条件成立 ⇒ 真的写成功
 * ```
 * ⚠️ 两类规则都经 **C2 真实形成链**取得（不手工赠送合格快照）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'
import { isolateDatabase } from '../../src/dev/sandbox.ts'

if (process.env.LG_F1_R1_PG_CHILD !== '1') {
  process.env.LG_F1_R1_PG_CHILD = '1'
  const simAdminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  if (simAdminUrl !== '') {
    await runPreparedPgGateInInstance(simAdminUrl, 'f1-precondition-reachability', 'scripts/cognitive/f1-precondition-reachability-verify.ts')
  } else {
    await runPreparedPgGate('f1-precondition-reachability', 'scripts/cognitive/f1-precondition-reachability-verify.ts')
  }
  process.exit(0)
}
const sandbox = isolateDatabase('f1-precondition-reachability', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

import { createM4Harness } from '../m4-harness.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, EBL_TOOL_ENVIRONMENT } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { makeEblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import {
  contentFingerprint, createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries,
} from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS, SANDBOX_FILE_WRITE } from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { runTask } from '../../src/kernel/action/task-loop.ts'
import { applyBoundedObservation, createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import type { TaskPlan, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { sandboxWriteFamilyScope } from '../../src/kernel/contracts/write-family.ts'
import { SANDBOX_CONDITION_RECEIPT_PREFIX } from '../../src/kernel/contracts/write-precondition.ts'
import { actionFailure, ActionFailureError } from '../../src/kernel/action/errors.ts'
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'
import { parsePreconditionTaskEntry } from '../../src/infrastructure/runtime/precondition-entry.ts'
import { explicitFileGoal, createSimulationPlanning } from '../../src/infrastructure/runtime/simulation-planning.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { createActionIntentDetector } from '../../src/kernel/action/intent-detector.ts'
import type { SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { exec } from '../../src/infrastructure/persistence/db.ts'
import { sql } from 'drizzle-orm'

const checks: string[] = []
function check(name: string, pass: unknown, detail = '') {
  assert.ok(pass, name)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const FAMILY = 'f1/a'
const GUARD = 'f1-guard.txt'
const LOCKED = 'locked'
const READY = 'ready'
const TARGET = 'f1/a/o.txt'
const CONTENT = 'r1-main-content'
const DECLARATION = { familyId: FAMILY, conditionPath: GUARD, mustNotEqual: LOCKED }

const entryText = (target = TARGET, marker = GUARD, content = CONTENT) =>
  `只操作相对路径 ${target}。写入以下 JSON 字符串解码后的精确内容，再读回核对："${content}"\n允许本任务额外只读条件标记 ${marker}，最多一次。`

const output = resolve('artifacts/local/f1-precondition-reachability', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
const fsRoot = mkdtempSync(resolve(output, 'files-'))
const h = await createM4Harness({ label: 'f1-precondition-reachability', userId: 'Alex' })
try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const fsOptions = { root: fsRoot, staging }
  let guardFailOpen = false
  const guardedWrite: CapabilityAdapter = {
    capabilityId: SANDBOX_FILE_WRITE,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const guard = readFileSync(resolve(fsRoot, GUARD), 'utf8').trim()
      if (guard === LOCKED && !guardFailOpen) {
        throw new ActionFailureError(actionFailure('validation_failed', '守卫拒绝写入：前置条件被违反'))
      }
      return createSandboxWriteAdapter({ root: fsRoot, staging, conditionPaths: [GUARD] }).execute(input)
    },
  }
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fsOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger: createActionLedgerStore(h.db),
    adapters: [createSandboxReadAdapter({ root: fsRoot, staging, conditionPaths: [GUARD] }), guardedWrite],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'f1-r1-test', executorAdapterId: 'sandbox-filesystem' } })
  const authorizations = createTaskAuthorizationRegistry()
  const knownDirectories = () => [FAMILY]
  const observer = createEblTaskObserver(h.db, h.userId, { knownDirectories, preconditions: [DECLARATION] })
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const ledger = createActionLedgerStore(h.db)
  const initiatorFor = (event: { id: string }) => attestActionInitiatorFromCausalOrigin({ adapterId: 'f1-r1-test',
    causalSource: correlationSourceFromConversationEvent({ adapterId: 'f1-r1-test', triggeringEvent: triggeringConversationEventOf(event as never) }) })

  /** 形成规则用的普通任务（观察者开着）。 */
  let taskIndex = 0
  async function plainTask(input: { target: string; guard: string; content?: string; failOpen?: boolean }) {
    taskIndex += 1
    const index = taskIndex
    writeFileSync(resolve(fsRoot, GUARD), input.guard)
    guardFailOpen = input.failOpen === true
    const evidence = await h.recordUserEvidence(`隔离任务 ${index}：${input.target}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `task ${index}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = initiatorFor(evidence.event)
    let planned = false
    const content = input.content ?? `c-${String(index)}`
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: observer,
      planner: { id: 'f1-r1-offline', endpointHost: 'offline', async plan() {
        const steps = planned ? [] : [
          // ⚠️ C2 的形成要求"同一任务里**先**读到条件标记，再那次写"。
          { capability: 'sandbox.file.read', operation: 'read', args: { path: GUARD } },
          { capability: 'sandbox.file.write', operation: 'write', args: { path: input.target, content } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path: input.target } },
        ]
        planned = true
        return { ok: true, requestCount: 1, plan: { goal: 'x', done: true, steps } }
      } } }, { characterId, traceId: asTraceId(`f1-r1-task-${index}`), authorization, text: `task ${index}` })
    return { result, evidence, content }
  }
  /** 候选来源：一份写+读候选（内容与入口声明的指纹一致）。 */
  function candidatePlanner(goalPath: string, content = CONTENT): TaskPlannerPort {
    const plan: TaskPlan = { goal: 'goal', done: true, steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: goalPath, content } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: goalPath } },
    ] }
    return { id: 'r1-candidates', endpointHost: 'offline', async plan() {
      return { ok: true, requestCount: 1, plan, candidates: [plan] }
    } }
  }
  /** 探针规划器（用来验任务环的范围闸；只给一个给定计划）。 */
  function probePlanner(plan: TaskPlan): TaskPlannerPort {
    let done = false
    return { id: 'r1-probe', endpointHost: 'offline', async plan() {
      const steps = done ? [] : plan.steps
      done = true
      return { ok: true, requestCount: 1, plan: { ...plan, steps } }
    } }
  }
  const readCount = async (traceId: string, path: string) => Number((await exec(h.db, sql`select count(distinct action_id)::int as count
    from character_action_events where character_id = ${String(characterId)} and trace_id = ${traceId}
    and capability = 'sandbox.file.read' and operation = 'read' and payload->'target'->>'canonicalId' = ${path}`,
  'r1 read count'))[0]?.count ?? 0)
  const writeCount = async (traceId: string, path: string) => Number((await exec(h.db, sql`select count(distinct action_id)::int as count
    from character_action_events where character_id = ${String(characterId)} and trace_id = ${traceId}
    and capability = 'sandbox.file.write' and operation = 'write' and event_type = 'ACTION_SUCCEEDED'
    and payload->'target'->>'canonicalId' = ${path}`, 'r1 write count'))[0]?.count ?? 0)

  // -------------------------------------------------------------------------
  // ① 入口解析（形状闭集与拒绝语义）
  // -------------------------------------------------------------------------
  const parsedOk = parsePreconditionTaskEntry(entryText())
  check('入口：两行精确请求被认成新入口', parsedOk.kind === 'entry'
    && parsedOk.entry.targetPath === TARGET && parsedOk.entry.conditionPath === GUARD)
  check('入口：目标内容指纹与既有指纹口径一致',
    parsedOk.kind === 'entry' && parsedOk.entry.expectedFingerprint === contentFingerprint(CONTENT))
  for (const [label, text] of [
    ['绝对路径', entryText('/f1/a/o.txt')],
    ['盘符', entryText('C:/f1/a/o.txt')],
    ['反斜线', entryText('f1\\a\\o.txt')],
    ['穿越', entryText('f1/../a/o.txt')],
    ['四层目录', entryText('a/b/c/d/e.txt')],
    ['空段', entryText('f1//a/o.txt')],
    ['扁平目标', entryText('o.txt')],
    ['glob', entryText('f1/a/*.txt')],
    ['条件=目标', entryText(TARGET, TARGET)],
    ['多余行', `${entryText()}\n多余`],
    ['坏 JSON', `只操作相对路径 ${TARGET}。写入以下 JSON 字符串解码后的精确内容，再读回核对：notjson\n允许本任务额外只读条件标记 ${GUARD}，最多一次。`],
  ] as const) {
    check(`入口：${label} ⇒ 明确拒绝（不截半执行）`, parsePreconditionTaskEntry(text).kind === 'rejected')
  }
  check('入口：没有第二行子句 ⇒ 交给旧入口',
    parsePreconditionTaskEntry(`只操作相对路径 o.txt。写入以下 JSON 字符串解码后的精确内容，再读回核对："hello"`).kind === 'not_applicable')
  check('旧入口：仍只认扁平单行，且不接受两行请求',
    explicitFileGoal(`只操作相对路径 o.txt。写入以下 JSON 字符串解码后的精确内容，再读回核对："hello"`)?.path === 'o.txt'
    && explicitFileGoal(entryText()) === undefined)

  // -------------------------------------------------------------------------
  // ② 装配分流（开关 + 族声明 + 标记路径一致性）
  // -------------------------------------------------------------------------
  const planning = (enabled: boolean, declarations: readonly unknown[] = [DECLARATION], onSelection?: (v: SimulationPlanSelection) => void) =>
    createSimulationPlanning({ db: h.db, characterId, activeUserId: h.userId, registry, facts: { encoding: 'utf8' },
      modelVersion: 'r1-verify@1', candidatePlanner: candidatePlanner(TARGET),
      precondition: { enabled, knownDirectories, declarations: declarations as never },
      ...(onSelection === undefined ? {} : { onSelection }) })
  check('装配：开关关 ⇒ 两行请求不被新入口接受', await planning(false)(entryText()) === undefined)
  // 修补 ①：族/标记不匹配**不是**"未配置"，而是**明确拒绝**（外层零动作、不回退）。
  const mismatch = await planning(true)(entryText(TARGET, 'other.txt'))
  check('装配：标记与声明不符 ⇒ **明确拒绝**（不是"未配置"）',
    mismatch?.entryRejected === 'entry_condition_not_declared', String(mismatch?.entryRejected))
  const undeclared = await planning(true, [{ familyId: 'f1/b', conditionPath: GUARD, mustNotEqual: LOCKED }])(entryText())
  check('装配：族没有声明 ⇒ **明确拒绝**',
    undeclared?.entryRejected === 'entry_family_undeclared', String(undeclared?.entryRejected))

  // -------------------------------------------------------------------------
  // ③ 规则形成（C2 真实链）：读回规则 + 族规则
  // -------------------------------------------------------------------------
  for (const name of ['r1', 'r2', 'r3']) await plainTask({ target: `f1/a/${name}.txt`, guard: READY })
  const readbackClaimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'readback_matches', expected: true, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT,
    conditions: { encoding: 'utf8' }, formation: { kind: 'action', id: 'shape' } }).id
  check('形成：读回规则经真实链取得资格（模拟规划器的前提）',
    (await store.get(readbackClaimId))?.status === 'validated', String((await store.get(readbackClaimId))?.status))
  await plainTask({ target: 'f1/a/p1.txt', guard: LOCKED })
  await plainTask({ target: 'f1/a/p2.txt', guard: READY })
  await plainTask({ target: 'f1/a/p3.txt', guard: LOCKED })
  await plainTask({ target: 'f1/a/p4.txt', guard: LOCKED })
  const familyClaimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(FAMILY),
    environment: EBL_TOOL_ENVIRONMENT, conditions: { condition_path: GUARD, must_not_equal: LOCKED },
    formation: { kind: 'action', id: 'shape' } }).id
  check('形成：族规则经真实 C2 链取得资格',
    (await store.get(familyClaimId))?.status === 'validated', String((await store.get(familyClaimId))?.status))
  /*
   * ⚠️ 装配的正向读数必须**在规则形成之后**取：模拟规划器要求已有合格的读回规则
   *    （ADR-151 R1 §4：旧门槛**保留**，缺它就走普通规划）。
   */
  const config = await planning(true)(entryText())
  check('装配：新入口 + 任务局部只读范围（目标 / 标记 / 最多一次）',
    config !== undefined && config.entryKind === 'precondition_two_line'
    && config.boundedObservation?.targetPath === TARGET && config.boundedObservation?.conditionPath === GUARD
    && config.boundedObservation?.maxReads === 1,
    JSON.stringify(config?.boundedObservation ?? null))

  /** 跑一次"从入口开始"的主链任务。 */
  async function mainChain(input: { traceId: string; guard: string; label: string })
    : Promise<{ selection: SimulationPlanSelection[]; result: Awaited<ReturnType<typeof runTask>>; authorization: ReturnType<typeof authorizations.issue> }> {
    writeFileSync(resolve(fsRoot, GUARD), input.guard)
    const selection: SimulationPlanSelection[] = []
    const config = await planning(true, [DECLARATION], value => selection.push(value))(entryText())
    assert.ok(config !== undefined && config.boundedObservation !== undefined, 'main chain config')
    const evidence = await h.recordUserEvidence(`R1 主链：${input.label}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: entryText(),
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1',
      budget: { maxActions: 8, maxPlans: 4, deadlineMs: 600_000 } })
    applyBoundedObservation(authorization, config!.boundedObservation)
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence: initiatorFor(evidence.event), riskBudgetOverride: 'R1' }),
      planner: config!.planner, ruleSnapshot: config!.ruleSnapshot, epistemic: observer },
      { characterId, traceId: asTraceId(input.traceId), authorization, text: entryText() })
    return { selection, result, authorization }
  }

  // -------------------------------------------------------------------------
  // ④ 主链 A：标记 locked ⇒ 一轮观察 · 下一轮否决 · 目标不达成 · 没有那次写
  // -------------------------------------------------------------------------
  // 目标要先有"上一次写入"的效果（模拟规划器的读回预期来自它），内容与入口声明一致。
  await plainTask({ target: TARGET, guard: READY, content: CONTENT })
  const mainA = await mainChain({ traceId: 'f1-r1-main-locked', guard: LOCKED, label: 'locked' })
  check('主链 A：观察者零失败（异常没有被吞掉）', (mainA.result.epistemicFailures ?? 0) === 0)
  const observationA = mainA.selection.find(value => value.conditionObservation !== undefined)
  check('主链 A：第 1 轮是**程序安排的一次条件读**（入口授权范围内）',
    observationA?.conditionObservation?.path === GUARD, String(observationA?.conditionObservation?.path))
  check('主链 A：这一次读**真的经 Gateway 执行了**（账本里一次，带受信回执）',
    await readCount('f1-r1-main-locked', GUARD) === 1)
  check('主链 A：任务授权里**只记了 1 次**尝试', mainA.authorization.boundedObservation?.attempts === 1)
  const vetoA = mainA.selection.find(value => value.preconditionVeto !== undefined)?.preconditionVeto
  check('主链 A：下一轮**否决**（六行真值表的"被违反"那一行）',
    vetoA?.decision === 'veto' && vetoA.reason === 'precondition_violated', String(vetoA?.reason))
  check('主链 A：否决读数带条件来源与观测值',
    vetoA?.observedValue === LOCKED && typeof vetoA.conditionSource === 'string' && vetoA.conditionSource.length > 0)
  check('主链 A：全部候选被否决 ⇒ 回退 goal_unproven', vetoA?.fallback === 'goal_unproven')
  check('主链 A：**没有**那次写（账本里没有成功的目标写）',
    await writeCount('f1-r1-main-locked', TARGET) === 0)
  check('主链 A：任务**没有**报完成', mainA.result.stopped !== 'done', String(mainA.result.stopped))

  // -------------------------------------------------------------------------
  // ⑤ 主链 B：标记 ready ⇒ 一轮观察 · 下一轮不否决 · 真的写成功
  // -------------------------------------------------------------------------
  const mainB = await mainChain({ traceId: 'f1-r1-main-ready', guard: READY, label: 'ready' })
  check('主链 B：观察者零失败', (mainB.result.epistemicFailures ?? 0) === 0)
  check('主链 B：同样先做一次条件读', await readCount('f1-r1-main-ready', GUARD) === 1)
  const vetoB = mainB.selection.find(value => value.preconditionVeto !== undefined)?.preconditionVeto
  check('主链 B：条件成立 ⇒ **不否决**',
    vetoB?.decision === 'no_veto' && vetoB.reason === 'condition_not_violated', String(vetoB?.reason))
  check('主链 B：写**真的执行了**（账本里一次成功的目标写）',
    await writeCount('f1-r1-main-ready', TARGET) === 1)
  check('主链 B：目标文件内容与请求逐字一致',
    readFileSync(resolve(fsRoot, TARGET), 'utf8') === CONTENT)
  check('主链 B：任务报完成（目标达成）', mainB.result.stopped === 'done', String(mainB.result.stopped))

  // -------------------------------------------------------------------------
  // ⑥ 范围闸：越界与"只读一次"都由**任务环**挡（不是规划器自述）
  // -------------------------------------------------------------------------
  const evidenceScope = await h.recordUserEvidence('R1 范围闸')
  const authScope = authorizations.issue({ conversationKey: String(evidenceScope.event.conversationId), originalText: entryText(),
    triggeringEventId: String(evidenceScope.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1',
    budget: { maxActions: 6, maxPlans: 3, deadlineMs: 600_000 } })
  applyBoundedObservation(authScope, { targetPath: TARGET, conditionPath: GUARD, maxReads: 1 })
  const outOfScope = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
    invocationFor: () => ({ initiatorEvidence: initiatorFor(evidenceScope.event), riskBudgetOverride: 'R1' }),
    planner: probePlanner({ goal: 'probe', done: true, steps: [
      { capability: 'sandbox.file.read', operation: 'read', args: { path: 'f1/a/other.txt' } },
    ] }) }, { characterId, traceId: asTraceId('f1-r1-scope-out'), authorization: authScope, text: entryText() })
  check('范围闸：读**别的路径** ⇒ 这一步不执行（observation_out_of_scope）',
    outOfScope.steps.some(step => step.droppedReason === 'observation_out_of_scope')
    || outOfScope.steps.some(step => step.failureCode !== undefined && step.status === 'not_found'))
  check('范围闸：越界那次读没有落到受信标记上', await readCount('f1-r1-scope-out', GUARD) === 0)
  check('范围闸：授权拒绝**第二次**条件读（计数在只读次数上限处失败）',
    authorizations.noteConditionRead(authScope.taskId) === false || authScope.boundedObservation?.attempts === 1)
  check('范围闸：写标记被拒（条件标记由受信侧拥有）', await (async () => {
    const evidence = await h.recordUserEvidence('R1 写标记')
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: 'x',
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write'], maxRiskLevel: 'R1' })
    writeFileSync(resolve(fsRoot, GUARD), READY)
    const before = readFileSync(resolve(fsRoot, GUARD), 'utf8')
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence: initiatorFor(evidence.event), riskBudgetOverride: 'R1' }),
      planner: probePlanner({ goal: 'probe', done: true, steps: [
        { capability: 'sandbox.file.write', operation: 'write', args: { path: GUARD, content: LOCKED } },
      ] }) }, { characterId, traceId: asTraceId('f1-r1-write-marker'), authorization, text: 'x' })
    const after = readFileSync(resolve(fsRoot, GUARD), 'utf8')
    return result.steps.some(step => step.failureCode === 'permission_denied') && after === before
  })())

  // -------------------------------------------------------------------------
  // ⑦ 预算：动作不够 ⇒ 不观察、不写、不假完成
  // -------------------------------------------------------------------------
  writeFileSync(resolve(fsRoot, GUARD), LOCKED)
  const selectionBudget: SimulationPlanSelection[] = []
  const configBudget = await planning(true, [DECLARATION], value => selectionBudget.push(value))(entryText())
  assert.ok(configBudget !== undefined && configBudget.boundedObservation !== undefined, 'budget config')
  const evidenceBudget = await h.recordUserEvidence('R1 预算')
  const authBudget = authorizations.issue({ conversationKey: String(evidenceBudget.event.conversationId), originalText: entryText(),
    triggeringEventId: String(evidenceBudget.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1',
    budget: { maxActions: 1, maxPlans: 2, deadlineMs: 600_000 } })
  applyBoundedObservation(authBudget, configBudget.boundedObservation)
  const budgetResult = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
    invocationFor: () => ({ initiatorEvidence: initiatorFor(evidenceBudget.event), riskBudgetOverride: 'R1' }),
    planner: configBudget.planner, ruleSnapshot: configBudget.ruleSnapshot },
    { characterId, traceId: asTraceId('f1-r1-budget'), authorization: authBudget, text: entryText() })
  check('预算：动作不够时**不假完成**（没写目标）', budgetResult.stopped !== 'done'
    && await writeCount('f1-r1-budget', TARGET) === 0, String(budgetResult.stopped))

  // -------------------------------------------------------------------------
  // ⑧ 条件标记归属仍受信（回执只在账本里，且来自真实读动作）
  // -------------------------------------------------------------------------
  const receipts = await exec(h.db, sql`select count(distinct action_id)::int as count from character_action_events
    where character_id = ${String(characterId)} and payload::text like ${'%' + SANDBOX_CONDITION_RECEIPT_PREFIX + '%'}`,
  'r1 receipts')
  check('受信回执只出现在动作账本里（可核）', Number(receipts[0]?.count ?? 0) > 0, String(receipts[0]?.count))

  // -------------------------------------------------------------------------
  // ⑨ **从真实 ActionTurn 的入口验收**（修补 ① 的点：外层回退与范围传递）
  // -------------------------------------------------------------------------
  const actionCount = async (traceId: string) => Number((await exec(h.db, sql`select count(*)::int as count
    from character_action_events where character_id = ${String(characterId)} and trace_id = ${traceId}`,
  'r1 action count'))[0]?.count ?? 0)
  /** 一个真的 ActionTurn（只差 `task` 那一段由调用方给）。 */
  const makeTurn = (taskOptions: NonNullable<Parameters<typeof createActionTurnPort>[0]['task']>): ReturnType<typeof createActionTurnPort> =>
    createActionTurnPort({ gateway, detector: createActionIntentDetector(), registry,
      attribution: { adapterId: 'f1-r1-test' }, task: taskOptions })
  const taskBase = () => ({
    authorizations, staging, resolveTarget,
    capabilitiesFor: () => ['sandbox.file.write', 'sandbox.file.read'],
    riskLevelFor: () => 'R1' as const,
    planner: probePlanner({ goal: 'probe', done: true, steps: [] }),
  })

  // ⑨a 非法两行请求 ⇒ **零动作**（不许退回普通规划 / 单动作）
  const turnReject = makeTurn({ ...taskBase(),
    configurePlanning: text => createSimulationPlanning({ db: h.db, characterId, activeUserId: h.userId, registry,
      facts: { encoding: 'utf8' }, modelVersion: 'r1-verify@1', candidatePlanner: candidatePlanner(TARGET),
      precondition: { enabled: true, knownDirectories, declarations: [DECLARATION] } })(text)})
  const evidenceReject = await h.recordUserEvidence('R1 入口拒绝')
  const rejectedTrace = 'f1-r1-entry-rejected'
  const rejected = await turnReject.handleTurn({ characterId, traceId: asTraceId(rejectedTrace),
    text: entryText('/f1/a/o.txt'), eventId: String(evidenceReject.event.id),
    conversationKey: String(evidenceReject.event.conversationId), speaker: { kind: 'user', id: String(h.userId) } })
  check('入口拒绝：外层结果是 not_applicable（不是"未配置"的错误回退）',
    rejected.kind === 'not_applicable', String(rejected.kind))
  check('入口拒绝：外层如实给出拒绝原因（闭集码，不含原话）',
    typeof (rejected as { rule?: string }).rule === 'string'
    && ((rejected as { rule?: string }).rule ?? '').startsWith('entry_rejected:'),
    String((rejected as { rule?: string }).rule))
  check('入口拒绝：**零动作**（账本里没有任何这条 trace 的动作事件）', await actionCount(rejectedTrace) === 0)

  // ⑨b 合法请求 + **没有合格规则** ⇒ 范围约束**仍然**存在（独立于规则资格）
  //     ⚠️ 用一个没有任何命题的角色 ⇒ 读回规则一条都选不中。
  const otherCharacter = h.kernel.characterId
  const emptyCharacter = 'chr:f1-r1-empty' as typeof otherCharacter
  const probeFallback = probePlanner({ goal: 'probe', done: true, steps: [
    { capability: 'sandbox.file.read', operation: 'read', args: { path: 'f1/a/other.txt' } },
  ] })
  const configNoRule = await createSimulationPlanning({ db: h.db, characterId: emptyCharacter, activeUserId: h.userId,
    registry, facts: { encoding: 'utf8' }, modelVersion: 'r1-verify@1', candidatePlanner: candidatePlanner(TARGET),
    precondition: { enabled: true, knownDirectories, declarations: [DECLARATION] } })(entryText(), probeFallback)
  check('无合格规则：装配仍返回（不退化成"未配置"）', configNoRule !== undefined)
  check('无合格规则：规划器退回任务自己的（fallback）', configNoRule?.planner === probeFallback)
  check('无合格规则：**范围仍然挂着**（独立于规则资格）',
    configNoRule?.boundedObservation?.conditionPath === GUARD && configNoRule?.boundedObservation?.targetPath === TARGET)
  const turnNoRule = makeTurn({ ...taskBase(), planner: probeFallback,
    configurePlanning: text => createSimulationPlanning({ db: h.db, characterId: emptyCharacter, activeUserId: h.userId,
      registry, facts: { encoding: 'utf8' }, modelVersion: 'r1-verify@1', candidatePlanner: candidatePlanner(TARGET),
      precondition: { enabled: true, knownDirectories, declarations: [DECLARATION] } })(text, probeFallback)})
  const evidenceNoRule = await h.recordUserEvidence('R1 无合格规则')
  const noRuleTrace = 'f1-r1-no-rule'
  await turnNoRule.handleTurn({ characterId, traceId: asTraceId(noRuleTrace), text: entryText(),
    eventId: String(evidenceNoRule.event.id), conversationKey: String(evidenceNoRule.event.conversationId),
    speaker: { kind: 'user', id: String(h.userId) } })
  check('无合格规则：越界读**没有**落到账本（任务环范围闸生效）',
    await readCount(noRuleTrace, 'f1/a/other.txt') === 0)

  // ⑨c 同任务**重复挂载**：计数不重置、范围不许换（修补 ②）
  check('重复挂载：同范围 ⇒ 接受且计数**保持**（不会因重新配置多一次读）',
    applyBoundedObservation(mainA.authorization, { targetPath: TARGET, conditionPath: GUARD, maxReads: 1 }) === true
    && mainA.authorization.boundedObservation?.attempts === 1)
  check('重复挂载：不同范围 ⇒ **拒绝更换**（范围仍是第一次挂上的那份）',
    applyBoundedObservation(mainA.authorization, { targetPath: 'f1/a/x.txt', conditionPath: 'other.txt', maxReads: 1 }) === false
    && mainA.authorization.boundedObservation?.targetPath === TARGET
    && mainA.authorization.boundedObservation?.conditionPath === GUARD)

  // ⑨d 第二次条件读：**明确被拒**，且不产生任何额外账本动作
  const readsBefore = await readCount('f1-r1-main-locked', GUARD)
  const secondAttempt = authorizations.noteConditionRead(mainA.authorization.taskId)
  const readsAfter = await readCount('f1-r1-main-locked', GUARD)
  check('第二次条件读：**明确被拒**（严格 false，不是"或"）', secondAttempt === false, String(secondAttempt))
  check('第二次条件读：**没有**额外账本动作（读次数不变）',
    readsBefore === 1 && readsAfter === readsBefore, `${String(readsBefore)}→${String(readsAfter)}`)
  void otherCharacter

  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres',
    evidenceKind: 'real_gateway_real_files_offline_planner', measured_count: checks.length, checks,
    productionOpened: false, modelCalls: 0, humanAcceptance: 'NOT RUN' }, null, 2))
  console.log(`F1 步骤D 可达性门（R1）：${String(checks.length)}/${String(checks.length)}；${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally { await h.stop() }
