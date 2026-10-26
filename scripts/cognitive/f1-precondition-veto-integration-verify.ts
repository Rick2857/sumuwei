/**
 * **ADR-151 步骤 D 的门**：写前置条件的**消费否决**（隔离 PostgreSQL · 零模型请求）。
 *
 * 它证明的是**产品侧**那条链真的跑得起来：
 * ```text
 * 真实 C2 形成链（条件读 + 被守卫以 validation_failed 拒绝的写 ⇒ 族作用域命题取得资格）
 *        ↓
 * 消费：产品模拟规划器在**本任务**的受信条件观测上做否决判定
 *        ↓
 * 否决 ⇒ 全部候选被否决 ⇒ **不记成目标达成**（goal_unproven）
 *        ↓
 * 条件成立 / 条件未知 / 异族 / 规则未合格（挂起）⇒ **不否决**（回默认顺序）
 *        ↓
 * Gateway 执行：产品规划器选出的计划真的在真实沙箱里落地（真实文件 + 真实账本）
 *        ↓
 * 规划后、执行前：规则被挂起 ⇒ 依赖它的计划被拒（verifyPlanRulesStillUsable）
 * ```
 *
 * ⚠️ 守卫是**场景侧**注入（本门自己的写适配器）：产品行为一字未改。
 * ⚠️ 条件值只来自**本任务**账本里的受信读回执（`sandbox-condition@1:`），不来自夹具变量。
 * ⚠️ 本门**不**声称任何收益；**不**激活任何开关。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'
import { isolateDatabase } from '../../src/dev/sandbox.ts'

if (process.env.LG_F1_PRECONDITION_PG_CHILD !== '1') {
  process.env.LG_F1_PRECONDITION_PG_CHILD = '1'
  /*
   * ⚠️ **仿真内没有 docker CLI** ⇒ 宿主模式那套"自己起一次性容器"用不了。
   *    ⇒ 仿真里改用**同一个专用隔离实例**（`LG_SIM_PGTEST_ADMIN_URL`），
   *      准备阶段逐条相同（显式迁移 + 身份核对 + `lg_test_` 前缀）。
   */
  const simAdminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  if (simAdminUrl !== '') {
    await runPreparedPgGateInInstance(simAdminUrl, 'f1-precondition-veto-integration', 'scripts/cognitive/f1-precondition-veto-integration-verify.ts')
  } else {
    await runPreparedPgGate('f1-precondition-veto-integration', 'scripts/cognitive/f1-precondition-veto-integration-verify.ts')
  }
  process.exit(0)
}
const sandbox = isolateDatabase('f1-precondition-veto-integration', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

import { createM4Harness } from '../m4-harness.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, EBL_TOOL_ENVIRONMENT } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { EBL_EVENT, makeEblClaim, type EblState } from '../../src/kernel/contracts/epistemic-belief.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import {
  contentFingerprint, createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries,
} from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS, SANDBOX_FILE_WRITE } from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { runTask, type TaskRunOutcome } from '../../src/kernel/action/task-loop.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { domainEventsFor, countDomainEvents } from '../../src/infrastructure/persistence/event-store.ts'
import { exec } from '../../src/infrastructure/persistence/db.ts'
import { sandboxWriteFamilyScope, familyOfWriteTarget } from '../../src/kernel/contracts/write-family.ts'
import { SANDBOX_CONDITION_RECEIPT_PREFIX, type WritePreconditionDeclaration } from '../../src/kernel/contracts/write-precondition.ts'
import { actionFailure, ActionFailureError } from '../../src/kernel/action/errors.ts'
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'
import type { TaskPlan, TaskPlannerOutcome, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import { createSimulationTaskPlanner, type SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { evaluatePreconditionVeto } from '../../src/infrastructure/runtime/precondition-veto.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { verifyPlanRulesStillUsable } from '../../src/kernel/contracts/cognitive-collaboration.ts'

const checks: string[] = []
function check(name: string, pass: unknown, detail = '') {
  assert.ok(pass, `${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const FAMILY = 'f1/a'
/** 第二个族：用来做"**异族 ⇒ 不否决**"的负控。 */
const FAMILY_OTHER = 'f1/b'
const GUARD = 'f1-guard.txt'
const LOCKED = 'locked'
const READY = 'ready'
/** 受信的族前置条件声明（**受信侧**给出；不来自模型）。 */
const DECLARATION: WritePreconditionDeclaration = { familyId: FAMILY, conditionPath: GUARD, mustNotEqual: LOCKED }
const DECLARATION_OTHER: WritePreconditionDeclaration = { familyId: FAMILY_OTHER, conditionPath: GUARD, mustNotEqual: LOCKED }
/** 目标路径（**落在族内** ⇒ 否决才够得着）。 */
const GOAL = 'f1/a/goal.txt'
const GOAL_CONTENT = '步骤D 目标内容'

const output = resolve('artifacts/local/f1-precondition-veto-integration', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
const fsRoot = mkdtempSync(resolve(output, 'files-'))
const h = await createM4Harness({ label: 'f1-precondition-veto-integration', userId: 'Alex' })
try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const fsOptions = { root: fsRoot, staging }
  /*
   * ⚠️ **场景侧守卫**：只有它会让写以 `validation_failed` 结束。
   *    它**不在**产品里（产品行为一字未改），也**不**替产品做判断。
   */
  let guardFailOpen = false
  const guardedWrite: CapabilityAdapter = {
    capabilityId: SANDBOX_FILE_WRITE,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const guard = readFileSync(resolve(fsRoot, GUARD), 'utf8').trim()
      if (guard === LOCKED && !guardFailOpen) {
        throw new ActionFailureError(actionFailure('validation_failed', '守卫拒绝写入：前置条件被违反'))
      }
      return createSandboxWriteAdapter({ root: fsRoot, staging }).execute(input)
    },
  }
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fsOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger: createActionLedgerStore(h.db),
    adapters: [
      createSandboxReadAdapter({ root: fsRoot, staging, conditionPaths: [GUARD] }),
      guardedWrite,
    ],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'f1-precondition-test', executorAdapterId: 'sandbox-filesystem' } })
  const authorizations = createTaskAuthorizationRegistry()
  const knownDirectories = (): readonly string[] => [FAMILY]
  const observer = createEblTaskObserver(h.db, h.userId, { knownDirectories, preconditions: [DECLARATION] })
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const snapshotPort = createEblRuleSnapshotPort(h.db, characterId, h.userId)

  type Step = { capability: string; operation: string; args: Record<string, unknown> }
  let taskIndex = 0
  /**
   * 跑一个**真实**任务（真实 Gateway · 真实文件 · 真实账本 · 真实观察者）。
   *
   * ⚠️ 计划器缺省是**离线**的（一次计划）；场景 ⑧ 会把**产品**模拟规划器装进来。
   */
  async function task(input: {
    label: string
    guard: string
    failOpen?: boolean
    steps: readonly Step[]
    planner?: TaskPlannerPort
  }): Promise<{ result: TaskRunOutcome; traceId: string }> {
    taskIndex += 1
    const index = taskIndex
    writeFileSync(resolve(fsRoot, GUARD), input.guard)
    guardFailOpen = input.failOpen === true
    const evidence = await h.recordUserEvidence(`隔离任务 ${index}：${input.label}`)
    const traceId = asTraceId(`f1-veto-task-${index}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `task ${index}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'f1-precondition-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'f1-precondition-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    /*
     * ⚠️ 计划器**只给一次**真正的步骤：写被守卫拒绝后任务环会**重规划**，
     *    而失败的那一步会被原样再试一次（那不是我们要测的东西）⇒ 第二次起给空计划。
     *    （与 C2 门逐字同形：否则同一个 trace 里会多出好几次条件读，
     *    "一次条件读只背一次写"的纪律也就测不到了。）
     */
    let planned = false
    const offlinePlanner: TaskPlannerPort = { id: 'f1-veto-offline', endpointHost: 'offline', async plan() {
      const steps = planned ? [] : input.steps
      planned = true
      return { ok: true, requestCount: 1, plan: { goal: 'precondition', done: true, steps } }
    } }
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: observer,
      ruleSnapshot: snapshotPort,
      planner: input.planner ?? offlinePlanner,
    }, { characterId, traceId, authorization, text: `task ${index}` })
    return { result, traceId: String(traceId) }
  }
  /** 观察者抛出的错**不许**被吞掉：任务环只把它记成一个计数器。 */
  function assertObserverClean(label: string, result: { epistemicFailures?: number }): void {
    check(`${label}：观察者零失败（没有被吞掉的异常）`, (result.epistemicFailures ?? 0) === 0, String(result.epistemicFailures ?? 0))
  }

  // ---------------------------------------------------------------------------
  // 计划器驱动：**产品**模拟规划器 + 固定离线候选源
  // ---------------------------------------------------------------------------
  interface Candidate { readonly id: string; readonly plan: TaskPlan }
  /** 两条**写**候选：目标路径相同、内容相同、步数不同（⇒ 两条都合格、都能被逐个辨认）。 */
  function writeCandidates(path: string, content: string): Candidate[] {
    return [
      { id: 'short', plan: { goal: 'write-and-read-back', done: true, steps: [
        { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
        { capability: 'sandbox.file.read', operation: 'read', args: { path } },
      ] } },
      { id: 'long', plan: { goal: 'write-twice-and-read-back', done: true, steps: [
        { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
        { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
        { capability: 'sandbox.file.read', operation: 'read', args: { path } },
      ] } },
    ]
  }
  /** 直接驱动**产品**模拟规划器（离线候选源，零模型请求）。 */
  async function planWith(input: {
    traceId: string
    candidates: readonly Candidate[]
    path: string
    content: string
    declarations?: readonly WritePreconditionDeclaration[]
    knownDirectories?: () => readonly string[]
    enabled?: boolean
    /** ⚠️ **完全不接**前置条件（缺省 ⇒ 行为逐字不变的那一档）。 */
    omitPrecondition?: boolean
  }): Promise<{ outcome: TaskPlannerOutcome; selections: SimulationPlanSelection[] }> {
    const selections: SimulationPlanSelection[] = []
    const planner = createSimulationTaskPlanner({
      db: h.db, characterId, activeUserId: h.userId,
      modelVersion: 'simulation-task-planner@1', facts: { encoding: 'utf8' },
      registry, goal: { path: input.path, expectedFingerprint: contentFingerprint(input.content) },
      candidateSource: { id: 'f1-veto-offline-candidates', endpointHost: 'offline',
        async propose() { return { candidates: input.candidates.map(item => item.plan), requestCount: 1 } } },
      ...(input.omitPrecondition === true ? {} : { precondition: { enabled: input.enabled !== false,
        knownDirectories: input.knownDirectories ?? knownDirectories,
        declarations: input.declarations ?? [DECLARATION] } }),
      onSelection: (selection) => { selections.push(selection) },
    })
    const outcome = await planner.plan({ task: `写入 ${input.path} 并读回核对`, traceId: input.traceId,
      executed: [], failures: [], remainingActions: 10,
      allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'] })
    return { outcome, selections }
  }
  /** 被否决候选的**身份**集合（按候选内容辨认，不按位置）。 */
  function vetoedIdentities(record: { vetoedCandidateIds: readonly string[] } | undefined, candidates: readonly Candidate[]): string[] {
    return (record?.vetoedCandidateIds ?? []).map(id => candidates[Number(id)]?.id ?? `?${id}`).sort()
  }
  /** 一次规划结果的"可比部分"（失败码或选出的步骤；不带上带时间戳的模拟报告）。 */
  function planStepsOf(outcome: TaskPlannerOutcome): unknown {
    return outcome.ok ? outcome.plan.steps : { failure: outcome.failure }
  }

  // ---------------------------------------------------------------------------
  // ⓪ 前置：模拟规划器需要一条**当前合格**的 `sandbox_readback` 规则
  //    （它驱动模拟报告；只有族规则 ⇒ 规划器在否决之前就 `no_rule`）。
  //    ⇒ 先跑三个"写完再读回"的任务把它**真实地**形成出来
  //      （形成那次**不算**证据 ⇒ 要三个任务才取得资格，与既有 EBL 门同口径）。
  // ---------------------------------------------------------------------------
  const readbackClaimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'readback_matches', expected: true, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT,
    conditions: { encoding: 'utf8' }, formation: { kind: 'action', id: 'readback-shape-only' } }).id
  const readbackOne = await task({ label: '读回规则一：写 f1/a/rb1.txt 再读回', guard: READY, steps: [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/rb1.txt', content: '回读一' } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: 'f1/a/rb1.txt' } },
  ] })
  assertObserverClean('读回规则一', readbackOne.result)
  const readbackTwo = await task({ label: '读回规则二：写 f1/a/rb2.txt 再读回', guard: READY, steps: [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/rb2.txt', content: '回读二' } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: 'f1/a/rb2.txt' } },
  ] })
  assertObserverClean('读回规则二', readbackTwo.result)
  const readbackThree = await task({ label: '读回规则三：写 f1/a/rb3.txt 再读回', guard: READY, steps: [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/rb3.txt', content: '回读三' } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: 'f1/a/rb3.txt' } },
  ] })
  assertObserverClean('读回规则三', readbackThree.result)
  const readbackState = await store.get(readbackClaimId)
  check('读回命题（sandbox_readback）在三个任务后取得资格（模拟规划器需要它）',
    readbackState?.status === 'validated', String(readbackState?.status))
  check('读回命题的证据落在两个不同 binding 上',
    new Set((readbackState?.evidence ?? []).filter(item => item.verdict === 'support')
      .map(item => readbackState?.tests.find(test => test.id === item.testId)?.bindingKey)).size === 2)

  // ---------------------------------------------------------------------------
  // ① **形成（真实 C2 链）**：条件读 + 被守卫拒绝的写 ⇒ 族作用域命题取得资格
  // ---------------------------------------------------------------------------
  const preconditionClaimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(FAMILY), environment: EBL_TOOL_ENVIRONMENT,
    conditions: { condition_path: GUARD, must_not_equal: LOCKED },
    formation: { kind: 'action', id: 'formation-shape-only' } }).id
  const preconditionContext = { subjectId: h.userId, scope: sandboxWriteFamilyScope(FAMILY),
    environment: EBL_TOOL_ENVIRONMENT, conditions: { condition_path: GUARD, must_not_equal: LOCKED } }

  const formation = await task({ label: '形成：读条件标记后写 f1/a/o1.txt（守卫拒绝）', guard: LOCKED, steps: [
    { capability: 'sandbox.file.read', operation: 'read', args: { path: GUARD } },
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/o1.txt', content: '内容-1' } },
  ] })
  assertObserverClean('形成', formation.result)
  check('形成那次：写真的被守卫以 validation_failed 拒绝',
    formation.result.steps[1]?.status === 'rejected' && formation.result.steps[1]?.failureCode === 'validation_failed',
    JSON.stringify(formation.result.steps[1]))
  check('形成链走的是真实 C2 路径（命题 pending ⇒ 已形成但还没资格）',
    (await store.get(preconditionClaimId))?.status === 'pending', String((await store.get(preconditionClaimId))?.status))

  const supportOne = await task({ label: '支持一：读条件标记后写 f1/a/o2.txt（守卫拒绝）', guard: LOCKED, steps: [
    { capability: 'sandbox.file.read', operation: 'read', args: { path: GUARD } },
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/o2.txt', content: '内容-2' } },
  ] })
  assertObserverClean('支持一', supportOne.result)
  const control = await task({ label: '对照：读条件标记后写 f1/a/o3.txt（守卫放行）', guard: READY, steps: [
    { capability: 'sandbox.file.read', operation: 'read', args: { path: GUARD } },
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/o3.txt', content: '内容-3' } },
  ] })
  assertObserverClean('对照', control.result)
  check('对照真的写成功了（条件未违反）', control.result.steps[1]?.status === 'success', JSON.stringify(control.result.steps[1]))
  const supportTwo = await task({ label: '支持二：读条件标记后写 f1/a/o4.txt（守卫拒绝）', guard: LOCKED, steps: [
    { capability: 'sandbox.file.read', operation: 'read', args: { path: GUARD } },
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/o4.txt', content: '内容-4' } },
  ] })
  assertObserverClean('支持二', supportTwo.result)

  const qualified = await store.get(preconditionClaimId)
  check('真实 C2 链：两个独立 binding 的支持 + 一个对照 ⇒ 命题取得资格（validated）',
    qualified?.status === 'validated', String(qualified?.status))
  check('合格后规则在同族同条件下可用', await store.usable(preconditionClaimId, preconditionContext))
  check('证据落在两个不同 binding 上（族内不同对象）',
    new Set((qualified?.evidence ?? []).filter(item => item.verdict === 'support')
      .map(item => qualified?.tests.find(test => test.id === item.testId)?.bindingKey)).size === 2)
  check('对照被记成 inconclusive（不是支持，也不是反例）',
    (qualified?.evidence ?? []).some(item => item.verdict === 'inconclusive'
      && item.observation.complete === true && item.observation.value === undefined))
  check('没有"已登记未结算"的测试',
    (qualified?.tests ?? []).every(test => (qualified?.evidence ?? []).some(item => item.testId === test.id)))
  const ledger = createActionLedgerStore(h.db)
  const lockedReceipt = (await ledger.getEventsByActionId(characterId, formation.result.steps[0]?.actionId as never))
    .find(event => event.type === 'ACTION_SUCCEEDED')?.payload.evidence as { ref?: string }[] | undefined
  check('受信条件值只出现在账本里的读回执中（locked）',
    lockedReceipt?.map(item => item.ref).find(ref => ref?.startsWith(SANDBOX_CONDITION_RECEIPT_PREFIX))
      === `${SANDBOX_CONDITION_RECEIPT_PREFIX}${LOCKED}`)
  const lockedReadActionId = String(formation.result.steps[0]?.actionId)
  const readyReadActionId = String(control.result.steps[0]?.actionId)

  // ---------------------------------------------------------------------------
  // ② **消费 ⇒ 正确否决**：条件在本任务里被观测为 locked ⇒ 否决
  // ---------------------------------------------------------------------------
  const candidates = writeCandidates(GOAL, GOAL_CONTENT)
  const veto = await planWith({ traceId: formation.traceId, candidates, path: GOAL, content: GOAL_CONTENT })
  const vetoSelection = veto.selections[0]
  const vetoRecord = vetoSelection?.preconditionVeto
  check('条件被违反 ⇒ 规划器**不选**计划（失败，不是"目标达成"）', veto.outcome.ok === false, JSON.stringify(veto.outcome))
  check('规划器的结论是 goal_unproven（全部候选被否决 ⇒ 不记成达成）', vetoSelection?.reason === 'goal_unproven', String(vetoSelection?.reason))
  check('否决读数：decision = veto', vetoRecord?.decision === 'veto', String(vetoRecord?.decision))
  check('否决读数：reason = precondition_violated', vetoRecord?.reason === 'precondition_violated', String(vetoRecord?.reason))
  check('否决读数：规则 id 与版本都填上了（内容寻址）',
    typeof vetoRecord?.ruleId === 'string' && vetoRecord.ruleId !== '' &&
    typeof vetoRecord?.ruleVersion === 'string' && vetoRecord.ruleVersion !== '', `${String(vetoRecord?.ruleId)} / ${String(vetoRecord?.ruleVersion)}`)
  check('否决读数：条件来源是那次受信读的动作 id', vetoRecord?.conditionSource === lockedReadActionId,
    `${String(vetoRecord?.conditionSource)} vs ${lockedReadActionId}`)
  check('否决读数：观测到的条件值是 locked', vetoRecord?.observedValue === LOCKED, String(vetoRecord?.observedValue))
  check('否决读数：被否决的候选都被记下来了（两条写候选）',
    (vetoRecord?.vetoedCandidateIds.length ?? 0) === candidates.length, JSON.stringify(vetoRecord?.vetoedCandidateIds))
  check('否决读数：回退是 goal_unproven（**不**记成目标达成）', vetoRecord?.fallback === 'goal_unproven', String(vetoRecord?.fallback))
  const vetoProbe = await evaluatePreconditionVeto({ enabled: true, db: h.db, characterId, activeUserId: h.userId,
    targetPath: GOAL, traceId: formation.traceId, knownDirectories, declarations: [DECLARATION] })
  check('否决读面（evaluatePreconditionVeto）给出同一个结论：veto / precondition_violated',
    vetoProbe.decision.veto === true && vetoProbe.decision.reason === 'precondition_violated', JSON.stringify(vetoProbe.decision))

  // ---------------------------------------------------------------------------
  // ③ **条件成立 ⇒ 不否决**：同一族、同一规则，条件被观测为 ready
  // ---------------------------------------------------------------------------
  const ready = await planWith({ traceId: control.traceId, candidates, path: GOAL, content: GOAL_CONTENT })
  const readyRecord = ready.selections[0]?.preconditionVeto
  check('条件成立 ⇒ 规划器照样选计划', ready.outcome.ok === true, JSON.stringify(ready.outcome))
  check('条件成立 ⇒ 不否决', readyRecord?.decision === 'no_veto', String(readyRecord?.decision))
  check('条件成立 ⇒ 理由是 condition_not_violated', readyRecord?.reason === 'condition_not_violated', String(readyRecord?.reason))
  check('条件成立 ⇒ 观测到的条件值是 ready（来自本任务的受信读）',
    readyRecord?.observedValue === READY && readyRecord?.conditionSource === readyReadActionId,
    `${String(readyRecord?.observedValue)} / ${String(readyRecord?.conditionSource)}`)

  // ---------------------------------------------------------------------------
  // ④ **候选置换无关**：否决不依赖候选的位置
  // ---------------------------------------------------------------------------
  const permuted = await planWith({ traceId: formation.traceId, candidates: [...candidates].reverse(), path: GOAL, content: GOAL_CONTENT })
  const permutedRecord = permuted.selections[0]?.preconditionVeto
  check('候选顺序置换后否决结论不变（还是 veto / goal_unproven）',
    permuted.selections[0]?.reason === 'goal_unproven' && permutedRecord?.decision === 'veto' &&
    permutedRecord?.reason === 'precondition_violated', String(permuted.selections[0]?.reason))
  check('候选顺序置换后被否决的候选**集合**不变（按候选身份比，不按位置）',
    JSON.stringify(vetoedIdentities(permutedRecord, [...candidates].reverse()))
      === JSON.stringify(vetoedIdentities(vetoRecord, candidates)), JSON.stringify(vetoedIdentities(permutedRecord, [...candidates].reverse())))

  // ---------------------------------------------------------------------------
  // ⑤ **条件未知 ⇒ 不否决**：本任务没有受信条件读
  // ---------------------------------------------------------------------------
  const unknown = await planWith({ traceId: readbackOne.traceId, candidates, path: GOAL, content: GOAL_CONTENT })
  const unknownRecord = unknown.selections[0]?.preconditionVeto
  check('条件未知 ⇒ 不否决（不猜）', unknownRecord?.decision === 'no_veto', String(unknownRecord?.decision))
  check('条件未知 ⇒ 理由是 condition_unknown', unknownRecord?.reason === 'condition_unknown', String(unknownRecord?.reason))
  check('条件未知 ⇒ 计划照样被选中', unknown.outcome.ok === true && unknown.selections[0]?.reason === 'selected',
    `${String(unknown.outcome.ok)} / ${String(unknown.selections[0]?.reason)}`)

  // ---------------------------------------------------------------------------
  // ⑥ **异族 ⇒ 不否决**：目标落在另一个族 / 只声明了另一个族
  // ---------------------------------------------------------------------------
  const otherFamilyTarget = await planWith({ traceId: formation.traceId, candidates: writeCandidates('f1/b/goal.txt', GOAL_CONTENT),
    path: 'f1/b/goal.txt', content: GOAL_CONTENT,
    knownDirectories: (): readonly string[] => [FAMILY, FAMILY_OTHER] })
  check('异族目标 ⇒ 不否决', otherFamilyTarget.selections[0]?.preconditionVeto?.decision !== 'veto',
    String(otherFamilyTarget.selections[0]?.preconditionVeto?.decision))
  check('异族目标 ⇒ 计划照样被选中（没有被规则挡住）',
    otherFamilyTarget.outcome.ok === true && otherFamilyTarget.selections[0]?.reason === 'selected',
    `${String(otherFamilyTarget.outcome.ok)} / ${String(otherFamilyTarget.selections[0]?.reason)}`)
  const otherFamilyDeclaration = await planWith({ traceId: formation.traceId, candidates, path: GOAL, content: GOAL_CONTENT,
    declarations: [DECLARATION_OTHER] })
  check('只声明了别的族 ⇒ 不否决', otherFamilyDeclaration.selections[0]?.preconditionVeto?.decision !== 'veto',
    String(otherFamilyDeclaration.selections[0]?.preconditionVeto?.decision))
  check('只声明了别的族 ⇒ 计划照样被选中', otherFamilyDeclaration.outcome.ok === true,
    String(otherFamilyDeclaration.outcome.ok))
  const otherFamilyProbe = await evaluatePreconditionVeto({ enabled: true, db: h.db, characterId, activeUserId: h.userId,
    targetPath: GOAL, traceId: formation.traceId, knownDirectories, declarations: [DECLARATION_OTHER] })
  check('异族读面的理由是"没有当前合格的族规则"（rule_not_qualified，不是 veto）',
    otherFamilyProbe.decision.veto === false && otherFamilyProbe.decision.reason === 'rule_not_qualified',
    JSON.stringify(otherFamilyProbe.decision))

  // ---------------------------------------------------------------------------
  // ⚠️ **下面的编号不按先后顺序**，因为**顺序本身是断言的一部分**：
  //    ⑩（开关关闭）必须在**规则还合格**时跑（那时关开关真的改变了行为）；
  //    ⑧（Gateway 执行）必须在**规则被挂起之前**跑；
  //    ⑦（挂起 ⇒ 不否决）必须**最后**跑（它把规则废掉）。
  // ---------------------------------------------------------------------------
  // ⑩ **开关关闭 ⇒ 旧行为逐字保持**：同一个受信条件（locked）、同一批候选，
  //    一次**关开关**、一次**完全不接**前置条件 ⇒ 两边结论逐字一致，且都**不否决**。
  //    （此时规则仍合格、条件仍被违反 ⇒ 关掉开关真的改变了行为。）
  // ---------------------------------------------------------------------------
  const switchedOff = await planWith({ traceId: formation.traceId, candidates, path: GOAL, content: GOAL_CONTENT, enabled: false })
  const absent = await planWith({ traceId: formation.traceId, candidates, path: GOAL, content: GOAL_CONTENT, omitPrecondition: true })
  check('开关关闭 ⇒ 不否决（连否决读数都没有）', switchedOff.selections[0]?.preconditionVeto === undefined,
    JSON.stringify(switchedOff.selections[0]?.preconditionVeto))
  check('开关关闭 ⇒ 计划照样被选中（旧的默认顺序行为）',
    switchedOff.outcome.ok === true && switchedOff.selections[0]?.reason === 'selected',
    `${String(switchedOff.outcome.ok)} / ${String(switchedOff.selections[0]?.reason)}`)
  check('完全不接前置条件 ⇒ 不否决（连否决读数都没有）', absent.selections[0]?.preconditionVeto === undefined,
    JSON.stringify(absent.selections[0]?.preconditionVeto))
  check('开关关闭与完全不接：结论逐字一致（同一结果、同一理由、同一选中项）',
    switchedOff.outcome.ok === absent.outcome.ok &&
    switchedOff.selections[0]?.reason === absent.selections[0]?.reason &&
    switchedOff.selections[0]?.selectedIndex === absent.selections[0]?.selectedIndex,
    `${String(switchedOff.outcome.ok)} / ${String(switchedOff.selections[0]?.reason)} / ${String(switchedOff.selections[0]?.selectedIndex)}`)
  check('开关关闭与完全不接：选出的计划逐字一致',
    JSON.stringify(planStepsOf(switchedOff.outcome)) === JSON.stringify(planStepsOf(absent.outcome)),
    JSON.stringify(planStepsOf(switchedOff.outcome)))

  // ---------------------------------------------------------------------------
  // ⑧ **Gateway 执行**：产品规划器选出的计划真的在真实沙箱里落地
  //    ⚠️ ⑧a：**产品**模拟规划器**直接**作为任务规划器（一次计划 ⇒ 写 + 读回）。
  //    ⑧b：**先读条件标记**（同一任务、同一个 trace）⇒ 再由产品模拟规划器选计划
  //        ⇒ 这一次的条件值是**本任务**的受信观测（ready）⇒ 真的走"消费"这条路。
  // ---------------------------------------------------------------------------
  const executedOnly = await task({ label: '执行（纯产品规划器）', guard: READY, steps: [],
    planner: (() => {
      const selections: SimulationPlanSelection[] = []
      const planner = createSimulationTaskPlanner({
        db: h.db, characterId, activeUserId: h.userId,
        modelVersion: 'simulation-task-planner@1', facts: { encoding: 'utf8' },
        registry, goal: { path: GOAL, expectedFingerprint: contentFingerprint(GOAL_CONTENT) },
        candidateSource: { id: 'f1-veto-offline-candidates', endpointHost: 'offline',
          async propose() { return { candidates: writeCandidates(GOAL, GOAL_CONTENT).map(item => item.plan), requestCount: 1 } } },
        precondition: { enabled: true, knownDirectories, declarations: [DECLARATION] },
        onSelection: (selection) => { selections.push(selection) },
      })
      return planner
    })() })
  assertObserverClean('执行（纯产品规划器）', executedOnly.result)
  check('⑧a：产品规划器选出的计划真的在真实沙箱里执行了（写步骤成功）',
    executedOnly.result.steps.some(step => step.capability === 'sandbox.file.write' && step.status === 'success'),
    JSON.stringify(executedOnly.result.steps))
  check('⑧a：目标文件真的落盘了（内容逐字一致）',
    existsSync(resolve(fsRoot, GOAL)) && readFileSync(resolve(fsRoot, GOAL), 'utf8') === GOAL_CONTENT)

  const executionSelections: SimulationPlanSelection[] = []
  const productPlanner = createSimulationTaskPlanner({
    db: h.db, characterId, activeUserId: h.userId,
    modelVersion: 'simulation-task-planner@1', facts: { encoding: 'utf8' },
    registry, goal: { path: GOAL, expectedFingerprint: contentFingerprint(GOAL_CONTENT) },
    candidateSource: { id: 'f1-veto-offline-candidates', endpointHost: 'offline',
      async propose() { return { candidates: writeCandidates(GOAL, GOAL_CONTENT).map(item => item.plan), requestCount: 1 } } },
    precondition: { enabled: true, knownDirectories, declarations: [DECLARATION] },
    onSelection: (selection) => { executionSelections.push(selection) },
  })
  let firstRound = true
  const compositePlanner: TaskPlannerPort = { id: 'f1-veto-composite', endpointHost: 'offline', async plan(input) {
    if (firstRound) {
      firstRound = false
      return { ok: true, requestCount: 1, plan: { goal: '读取条件标记', done: false,
        steps: [{ capability: 'sandbox.file.read', operation: 'read', args: { path: GUARD } }] } }
    }
    return productPlanner.plan(input)
  } }
  const executed = await task({ label: '执行（本任务先读条件标记，再由产品规划器选计划）', guard: READY, steps: [], planner: compositePlanner })
  assertObserverClean('执行（本任务先读条件标记）', executed.result)
  const executionRecord = executionSelections[0]?.preconditionVeto
  check('⑧b：产品规划器在这一轮真的做了消费判定（读数存在）', executionRecord !== undefined, JSON.stringify(executionSelections[0]))
  check('⑧b：本任务观测到的条件值是 ready（来自本任务的受信读）',
    executionRecord?.observedValue === READY, String(executionRecord?.observedValue))
  check('⑧b：条件成立 ⇒ 不否决（decision = no_veto / condition_not_violated）',
    executionRecord?.decision === 'no_veto' && executionRecord?.reason === 'condition_not_violated',
    `${String(executionRecord?.decision)} / ${String(executionRecord?.reason)}`)
  check('⑧b：产品规划器选中了计划（这一轮没有 goal_unproven）',
    executionSelections[0]?.reason === 'selected', String(executionSelections[0]?.reason))
  check('⑧b：写步骤真的成功了', executed.result.steps.some(step => step.capability === 'sandbox.file.write' && step.status === 'success'),
    JSON.stringify(executed.result.steps))
  check('⑧b：目标文件真的落盘了（内容逐字一致）',
    existsSync(resolve(fsRoot, GOAL)) && readFileSync(resolve(fsRoot, GOAL), 'utf8') === GOAL_CONTENT)
  check('⑧b：目标路径在族内（族是身份的一部分）', familyOfWriteTarget({ path: GOAL, knownDirectories: knownDirectories() }) === FAMILY,
    String(familyOfWriteTarget({ path: GOAL, knownDirectories: knownDirectories() })))

  // ---------------------------------------------------------------------------
  // ⑦ **未合格 / 已撤回 ⇒ 不否决**：真实反例（守卫 locked 却写成功）⇒ 既有 suspended 路径
  // ---------------------------------------------------------------------------
  /*
   * ⚠️ **先**把"计划依赖这条规则"的依赖声明取出来（**规则还合格的时候**），
   *    后面用同一份依赖声明去核对"规则被挂起之后"计划是否被拒。
   */
  const dependencySnapshot = await snapshotPort.current(preconditionClaimId)
  const dependency = { claimId: preconditionClaimId, ruleVersion: String(dependencySnapshot?.ruleVersion ?? ''),
    evidenceFingerprint: String(dependencySnapshot?.evidenceFingerprint ?? '') }
  const beforeVerdict = await verifyPlanRulesStillUsable({ dependencies: [dependency], snapshot: snapshotPort })
  check('规则挂起前：依赖它的计划仍然可用', beforeVerdict.ok === true, JSON.stringify(beforeVerdict))
  const counterexample = await task({ label: '反例：守卫 locked 但写成功（failOpen）', guard: LOCKED, failOpen: true, steps: [
    { capability: 'sandbox.file.read', operation: 'read', args: { path: GUARD } },
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/o9.txt', content: '内容-9' } },
  ] })
  assertObserverClean('反例', counterexample.result)
  check('反例：守卫 locked 时写真的成功了',
    counterexample.result.steps[1]?.status === 'success', JSON.stringify(counterexample.result.steps[1]))
  const suspendedState = await store.get(preconditionClaimId)
  check('真实反例命中 ⇒ 命题被挂起（既有 suspended 路径）', suspendedState?.status === 'suspended', String(suspendedState?.status))
  check('反例被如实记账（verdict = counterexample）',
    (suspendedState?.evidence ?? []).some(item => item.verdict === 'counterexample'))
  const suspended = await planWith({ traceId: formation.traceId, candidates, path: GOAL, content: GOAL_CONTENT })
  check('规则被挂起 ⇒ 不否决（未合格/已撤回不消费）',
    suspended.selections[0]?.preconditionVeto?.decision !== 'veto',
    String(suspended.selections[0]?.preconditionVeto?.decision))
  check('规则被挂起 ⇒ 计划被选中（不再被规则挡住）',
    suspended.outcome.ok === true && suspended.selections[0]?.reason === 'selected',
    `${String(suspended.outcome.ok)} / ${String(suspended.selections[0]?.reason)}`)
  const suspendedProbe = await evaluatePreconditionVeto({ enabled: true, db: h.db, characterId, activeUserId: h.userId,
    targetPath: GOAL, traceId: formation.traceId, knownDirectories, declarations: [DECLARATION] })
  check('挂起后否决读面的理由是 rule_not_qualified（不是 veto）',
    suspendedProbe.decision.veto === false && suspendedProbe.decision.reason === 'rule_not_qualified',
    JSON.stringify(suspendedProbe.decision))

  // ---------------------------------------------------------------------------
  // ⑨ **规划后、执行前规则失效**：依赖这条规则的计划必须被拒
  // ---------------------------------------------------------------------------
  check('规则挂起后：快照如实显示这条规则当前不合格',
    (await snapshotPort.current(preconditionClaimId))?.usable === false,
    String((await snapshotPort.current(preconditionClaimId))?.status))
  const afterVerdict = await verifyPlanRulesStillUsable({ dependencies: [dependency], snapshot: snapshotPort })
  check('规则挂起后：依赖它的计划被拒（ok = false）', afterVerdict.ok === false, JSON.stringify(afterVerdict))

  // ---------------------------------------------------------------------------
  // ⑩ 账本里能查到：条件标记读回执 + EBL 生命周期事件
  // ---------------------------------------------------------------------------
  const receipts = await exec(h.db, sql`select count(*)::int as count from character_action_events
    where character_id = ${String(characterId)} and payload->'evidence' is not null
    and payload::text like ${'%' + SANDBOX_CONDITION_RECEIPT_PREFIX + '%'}`, 'F1 condition receipts')
  check('条件标记回执落在动作账本里（可核）', Number(receipts[0]?.count) > 0, String(receipts[0]?.count))
  const kinds = (await domainEventsFor(h.db, characterId, { type: EBL_EVENT }))
    .map(event => (event.payload as { command: { kind: string } }).command.kind)
  check('既有 EBL 生命周期四步都走过（propose/register/settle/review）',
    ['propose', 'register', 'settle', 'review'].every(kind => kinds.includes(kind)), kinds.join(','))

  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres',
    evidenceKind: 'real_gateway_real_files_offline_planner', measured_count: checks.length, checks,
    productionOpened: false, modelCalls: 0, humanAcceptance: 'NOT RUN' }, null, 2))
  console.log(`F1 步骤D 集成门（消费否决）：${String(checks.length)}/${String(checks.length)}；${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally { await h.stop() }
