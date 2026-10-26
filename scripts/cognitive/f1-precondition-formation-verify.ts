/**
 * **ADR-151 步骤 C2 的门**：写前置条件的**形成来源**接线（隔离 PostgreSQL · 零模型请求）。
 *
 * 它证明的是**产品侧**那条链真的跑得起来：
 * ```text
 * 受信族声明 + 受信条件读（账本里的读回执）
 *        ↓
 * 写被守卫以 `validation_failed` 拒绝
 *        ↓
 * 观察者提出**族作用域**命题（`write_precondition_holds`）
 *        ↓
 * 预登记测试 → 结算 → 复核（≥2 binding / ≥2 episode / ≥2 design + **≥1 对照**）
 *        ↓
 * 反例（条件被违反却写成功）⇒ 既有 `suspended` 路径
 * ```
 *
 * ⚠️ 守卫是**场景侧**注入（本门自己的写适配器）：产品行为一字未改。
 * ⚠️ 条件值只来自**账本里的读回执**（`sandbox-condition@1:`），不来自夹具变量。
 * ⚠️ 本门**不**声称任何收益；**不**激活任何开关。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
    await runPreparedPgGateInInstance(simAdminUrl, 'f1-precondition-formation', 'scripts/cognitive/f1-precondition-formation-verify.ts')
  } else {
    await runPreparedPgGate('f1-precondition-formation', 'scripts/cognitive/f1-precondition-formation-verify.ts')
  }
  process.exit(0)
}
const sandbox = isolateDatabase('f1-precondition-formation', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

import { createM4Harness } from '../m4-harness.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, EBL_TOOL_ENVIRONMENT } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { EBL_EVENT, makeEblClaim, type EblState } from '../../src/kernel/contracts/epistemic-belief.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import {
  createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries,
} from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS, SANDBOX_FILE_WRITE } from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { runTask } from '../../src/kernel/action/task-loop.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { domainEventsFor, countDomainEvents } from '../../src/infrastructure/persistence/event-store.ts'
import { exec } from '../../src/infrastructure/persistence/db.ts'
import { sandboxWriteFamilyScope } from '../../src/kernel/contracts/write-family.ts'
import { SANDBOX_CONDITION_RECEIPT_PREFIX } from '../../src/kernel/contracts/write-precondition.ts'
import { actionFailure, ActionFailureError } from '../../src/kernel/action/errors.ts'
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'

const checks: string[] = []
function check(name: string, pass: unknown, detail = '') {
  assert.ok(pass, name)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const FAMILY = 'f1/a'
/** 第二个族：用来做"**没有对照 ⇒ 不给资格**"的负控。 */
const FAMILY_NO_CONTROL = 'f1/c'
const GUARD = 'f1-guard.txt'
const LOCKED = 'locked'
const READY = 'ready'
/** 受信的族前置条件声明（**受信侧**给出；不来自模型）。 */
const DECLARATION = { familyId: FAMILY, conditionPath: GUARD, mustNotEqual: LOCKED }
const DECLARATION_NO_CONTROL = { familyId: FAMILY_NO_CONTROL, conditionPath: GUARD, mustNotEqual: LOCKED }

const output = resolve('artifacts/local/f1-precondition-formation', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
const fsRoot = mkdtempSync(resolve(output, 'files-'))
const h = await createM4Harness({ label: 'f1-precondition-formation', userId: 'Alex' })
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
  let guardFailureCode: 'validation_failed' | 'permission_denied' = 'validation_failed'
  const guardedWrite: CapabilityAdapter = {
    capabilityId: SANDBOX_FILE_WRITE,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const guard = readFileSync(resolve(fsRoot, GUARD), 'utf8').trim()
      if (guard === LOCKED && !guardFailOpen) {
        throw new ActionFailureError(actionFailure(guardFailureCode, '守卫拒绝写入：前置条件被违反'))
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
  const knownDirectories = () => [FAMILY, FAMILY_NO_CONTROL]
  const observer = createEblTaskObserver(h.db, h.userId, { knownDirectories, preconditions: [DECLARATION, DECLARATION_NO_CONTROL] })
  /** ⚠️ **没有受信声明**的观察者（**观察者仍在** ⇒ 负控不是空的）。 */
  const silentObserver = createEblTaskObserver(h.db, h.userId, { knownDirectories, preconditions: [] })
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))

  let taskIndex = 0
  async function task(input: {
    target: string
    guard: string
    content?: string
    readGuard?: boolean
    failOpen?: boolean
    failureCode?: 'validation_failed' | 'permission_denied'
    secondTarget?: string
    silent?: boolean
  }) {
    taskIndex += 1
    const index = taskIndex
    writeFileSync(resolve(fsRoot, GUARD), input.guard)
    guardFailOpen = input.failOpen === true
    guardFailureCode = input.failureCode ?? 'validation_failed'
    const evidence = await h.recordUserEvidence(`隔离任务 ${index}：读条件标记再写入 ${input.target}。`)
    const traceId = asTraceId(`f1-precondition-task-${index}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `task ${index}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'f1-precondition-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'f1-precondition-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    const readGuard = input.readGuard !== false
    /*
     * ⚠️ 计划器**只给一次**真正的步骤：写失败后任务环会**重规划**，
     *    而失败的那一步会被原样再试一次（那不是我们要测的东西）⇒ 第二次起给空计划。
     */
    let planned = false
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: input.silent === true ? silentObserver : observer,
      planner: { id: 'f1-precondition-offline', endpointHost: 'offline', async plan() {
        const steps = planned
          ? []
          : [...(readGuard ? [{ capability: 'sandbox.file.read', operation: 'read', args: { path: GUARD } }] : []),
            { capability: 'sandbox.file.write', operation: 'write', args: { path: input.target, content: input.content ?? `内容-${String(index)}` } },
            ...(input.secondTarget === undefined ? [] : [{ capability: 'sandbox.file.write', operation: 'write', args: { path: input.secondTarget, content: `内容-${String(index)}-b` } }])]
        planned = true
        return { ok: true, requestCount: 1, plan: { goal: 'precondition', done: true, steps } }
      } } }, { characterId, traceId, authorization, text: `task ${index}` })
    return { result, anchor: String(evidence.event.id) }
  }
  /** 观察者抛出的错**不许**被吞掉：任务环只把它记成一个计数器。 */
  function assertObserverClean(label: string, result: { epistemicFailures?: number }): void {
    check(`${label}：观察者零失败（没有被吞掉的异常）`, (result.epistemicFailures ?? 0) === 0, String(result.epistemicFailures ?? 0))
  }
  /** 没有"已登记未结算"的测试（否则这条命题再也过不了 review）。 */
  function assertNoStuckTest(label: string, state: EblState | undefined): void {
    const tests = state?.tests ?? []
    check(`${label}：没有"已登记未结算"的测试`, tests.every(test =>
      (state?.evidence ?? []).some(item => item.testId === test.id)
      || (state?.closedTests ?? []).some(item => item.testId === test.id)), `${String(tests.length)} 个测试`)
  }

  const expectedScope = sandboxWriteFamilyScope(FAMILY)
  const expectedConditions = { condition_path: GUARD, must_not_equal: LOCKED }
  const expectedClaimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'write_precondition_holds', expected: true, scope: expectedScope, environment: EBL_TOOL_ENVIRONMENT,
    conditions: expectedConditions, formation: { kind: 'action', id: 'formation-shape-only' } }).id
  const noControlClaimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(FAMILY_NO_CONTROL),
    environment: EBL_TOOL_ENVIRONMENT, conditions: expectedConditions, formation: { kind: 'action', id: 'formation-shape-only' } }).id
  const context = { subjectId: h.userId, scope: expectedScope, environment: EBL_TOOL_ENVIRONMENT, conditions: expectedConditions }

  // ---------------------------------------------------------------------------
  // ① 观察者在场、但**没有受信声明** ⇒ 形成链**不触发**（既有行为逐字不变）
  // ---------------------------------------------------------------------------
  const silent = await task({ target: 'f1/a/silent.txt', guard: LOCKED, silent: true })
  assertObserverClean('无声明', silent.result)
  check('没有受信声明时**观察者仍在**但不产生任何 EBL 事件',
    await countDomainEvents(h.db, characterId, EBL_EVENT) === 0)
  check('没有受信声明时写仍按真实结果结束', silent.result.steps.length === 2, JSON.stringify(silent.result.steps))

  // ---------------------------------------------------------------------------
  // ② 受信条件读的回执**只**来自账本里的读动作
  // ---------------------------------------------------------------------------
  const ledger = createActionLedgerStore(h.db)
  const first = await task({ target: 'f1/a/o1.txt', guard: LOCKED })
  assertObserverClean('形成', first.result)
  const events = (await domainEventsFor(h.db, characterId, { type: 'EPISTEMIC_BELIEF_RECORDED' }))
  check('第一次失败只形成 pending 命题（还没有资格）', (await store.get(expectedClaimId))?.status === 'pending',
    String((await store.get(expectedClaimId))?.status))
  check('命题的 scope 带族（族是身份的一部分）', (await store.get(expectedClaimId))?.claim.scope === expectedScope, expectedScope)
  check('命题的 conditions 是闭集两个键', JSON.stringify((await store.get(expectedClaimId))?.claim.conditions) === JSON.stringify(expectedConditions))
  check('命题 id 是内容寻址（族 + 条件 ⇒ 同一个 id）', (await store.get(expectedClaimId))?.claim.id === expectedClaimId, expectedClaimId)
  check('形成的那次观察**不是**证据（形成 ≠ 证据）', (await store.get(expectedClaimId))?.evidence.length === 0)
  const readEvents = await ledger.getEventsByActionId(characterId, first.result.steps[0].actionId as never)
  const receipt = (readEvents.find(event => event.type === 'ACTION_SUCCEEDED')?.payload.evidence as { ref?: string }[] | undefined)
    ?.map(item => item.ref).find(ref => ref?.startsWith(SANDBOX_CONDITION_RECEIPT_PREFIX))
  check('受信条件值只出现在账本里的读回执中', receipt === `${SANDBOX_CONDITION_RECEIPT_PREFIX}${LOCKED}`, String(receipt))
  check('形成事件落在账本里', events.some(event => (event.payload as { command: { kind: string } }).command.kind === 'propose'))

  // ---------------------------------------------------------------------------
  // ③ **一个任务里两次写** ⇒ 条件读只用一次 ⇒ 不得留下结算不了的测试
  // ---------------------------------------------------------------------------
  const twoWrites = await task({ target: 'f1/a/o2.txt', guard: LOCKED, secondTarget: 'f1/a/o2b.txt' })
  assertObserverClean('同一任务两次写', twoWrites.result)
  assertNoStuckTest('同一任务两次写', await store.get(expectedClaimId))
  check('同一任务里的第二次写没有多出证据（一次条件读只背一次写）',
    (await store.get(expectedClaimId))?.evidence.length === 1, String((await store.get(expectedClaimId))?.evidence.length ?? 0))
  check('只有一个支持时仍不合格（还缺对照）', (await store.get(expectedClaimId))?.status === 'pending',
    String((await store.get(expectedClaimId))?.status))
  check('只有一个支持时规则还不可用', !(await store.usable(expectedClaimId, context)))

  // ---------------------------------------------------------------------------
  // ④ 对照（条件未违反时写成功）—— 必须在命题形成**之后**才登记得下来
  // ---------------------------------------------------------------------------
  const control = await task({ target: 'f1/a/o3.txt', guard: READY })
  assertObserverClean('对照', control.result)
  const afterControl = await store.get(expectedClaimId)
  check('对照被记成 inconclusive（不是支持，也不是反例）',
    afterControl?.evidence.some(item => item.verdict === 'inconclusive' && item.observation.complete === true
      && item.observation.value === undefined) === true)
  check('有了一个对照、还只有一个支持时仍不合格', afterControl?.status === 'pending', String(afterControl?.status))
  check('此时规则还不可用', !(await store.usable(expectedClaimId, context)))

  // ---------------------------------------------------------------------------
  // ⑤ 两个独立 binding 的支持 ⇒ 取得资格（复用既有政策口径）
  // ---------------------------------------------------------------------------
  const twoSupports = await task({ target: 'f1/a/o4.txt', guard: LOCKED })
  assertObserverClean('第二个支持', twoSupports.result)
  const qualified = await store.get(expectedClaimId)
  check('两个独立 binding + 一个对照 ⇒ 取得资格', qualified?.status === 'validated', String(qualified?.status))
  check('合格后规则在同族同条件下可用', await store.usable(expectedClaimId, context))
  check('异族 scope 不消费（族是身份的一部分）',
    !(await store.usable(expectedClaimId, { ...context, scope: sandboxWriteFamilyScope('f1/b') })))
  check('证据落在两个不同 binding 上',
    new Set((qualified?.evidence ?? []).filter(item => item.verdict === 'support')
      .map(item => qualified?.tests.find(test => test.id === item.testId)?.bindingKey)).size === 2)
  assertNoStuckTest('取得资格后', qualified)
  assert.deepEqual(await store.rebuild(expectedClaimId), qualified)
  check('重建投影与增量状态一致', true)

  // ---------------------------------------------------------------------------
  // ⑥ **负控**：两个支持但**没有对照** ⇒ 不给资格（"≥1 对照"这条口径真的在起作用）
  // ---------------------------------------------------------------------------
  await task({ target: `${FAMILY_NO_CONTROL}/n1.txt`, guard: LOCKED })
  await task({ target: `${FAMILY_NO_CONTROL}/n2.txt`, guard: LOCKED })
  await task({ target: `${FAMILY_NO_CONTROL}/n3.txt`, guard: LOCKED })
  const noControl = await store.get(noControlClaimId)
  const noControlSupports = (noControl?.evidence ?? []).filter(item => item.verdict === 'support').length
  check('没有对照的族拿到了两个支持，但**资格**被"≥1 对照"口径挡住',
    noControlSupports >= 2 && noControl?.status === 'pending', `supports=${String(noControlSupports)} status=${String(noControl?.status)}`)
  check('没有对照 ⇒ 规则不可用', !(await store.usable(noControlClaimId,
    { ...context, scope: sandboxWriteFamilyScope(FAMILY_NO_CONTROL) })))

  // ---------------------------------------------------------------------------
  // ⑦ 失败码分流：别的失败码**一律不算**证据（也不推翻既有资格）
  // ---------------------------------------------------------------------------
  const beforeRouting = await countDomainEvents(h.db, characterId, EBL_EVENT)
  const routing = await task({ target: 'f1/a/o6.txt', guard: LOCKED, failureCode: 'permission_denied' })
  assertObserverClean('排除码', routing.result)
  const afterRouting = await store.get(expectedClaimId)
  check('排除码的失败被记成 excluded（不是支持）',
    afterRouting?.evidence.some(item => item.verdict === 'excluded') === true)
  check('排除码的失败不改变已取得的资格', afterRouting?.status === 'validated', String(afterRouting?.status))
  check('排除码的失败仍然落进账本（可核）', await countDomainEvents(h.db, characterId, EBL_EVENT) > beforeRouting)

  // ---------------------------------------------------------------------------
  // ⑧ 没有受信条件读 ⇒ 归因不了（不猜）
  // ---------------------------------------------------------------------------
  const beforeNoRead = (await store.get(expectedClaimId))?.evidence.length ?? 0
  const noRead = await task({ target: 'f1/a/o7.txt', guard: LOCKED, readGuard: false })
  assertObserverClean('没有条件读', noRead.result)
  const afterNoRead = await store.get(expectedClaimId)
  check('没有条件读就没有新增证据（归因不了，不猜）', (afterNoRead?.evidence.length ?? 0) === beforeNoRead,
    `${String(beforeNoRead)} → ${String(afterNoRead?.evidence.length ?? 0)}`)

  // ---------------------------------------------------------------------------
  // ⑨ 反例：条件被违反却写成功 ⇒ 既有 `suspended` 路径
  // ---------------------------------------------------------------------------
  const counter = await task({ target: 'f1/a/o8.txt', guard: LOCKED, failOpen: true })
  assertObserverClean('反例', counter.result)
  const refuted = await store.get(expectedClaimId)
  check('反例命中 ⇒ 命题被挂起（既有 suspended 路径）', refuted?.status === 'suspended', String(refuted?.status))
  check('挂起后规则不可用', !(await store.usable(expectedClaimId, context)))
  check('反例被如实记账（verdict=counterexample）',
    refuted?.evidence.some(item => item.verdict === 'counterexample') === true)
  const afterRefute = await task({ target: 'f1/a/o9.txt', guard: LOCKED })
  assertObserverClean('反例之后', afterRefute.result)
  check('反例之后新的成功不能把它顶回合格', (await store.get(expectedClaimId))?.status === 'suspended',
    String((await store.get(expectedClaimId))?.status))

  // ---------------------------------------------------------------------------
  // ⑩ 未声明的族**不**形成任何命题（族只来自受信事实）
  // ---------------------------------------------------------------------------
  const beforeOtherFamily = await countDomainEvents(h.db, characterId, EBL_EVENT)
  const otherFamily = await task({ target: 'f1/b/other.txt', guard: LOCKED })
  assertObserverClean('未声明的族', otherFamily.result)
  check('未声明的族不产生任何 EBL 事件（族只来自受信事实）',
    await countDomainEvents(h.db, characterId, EBL_EVENT) === beforeOtherFamily)
  check('未声明的族没有自己的命题',
    (await store.get(makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
      predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope('f1/b'),
      environment: EBL_TOOL_ENVIRONMENT, conditions: expectedConditions,
      formation: { kind: 'action', id: 'other-family-shape' } }).id)) === undefined)

  // ---------------------------------------------------------------------------
  // ⑪ 账本里能查到：条件标记读回执 + 全部 EBL 事件
  // ---------------------------------------------------------------------------
  const receipts = await exec(h.db, sql`select count(*)::int as count from character_action_events
    where character_id = ${String(characterId)} and payload->'evidence' is not null
    and payload::text like ${'%' + SANDBOX_CONDITION_RECEIPT_PREFIX + '%'}`, 'F1 condition receipts')
  check('条件标记回执落在动作账本里（可核）', Number(receipts[0]?.count) > 0, String(receipts[0]?.count))
  const kinds = (await domainEventsFor(h.db, characterId, { type: EBL_EVENT }))
    .map(event => (event.payload as { command: { kind: string } }).command.kind)
  check('既有 EBL 生命周期四步都走过（propose/register/settle/review）',
    ['propose', 'register', 'settle', 'review'].every(kind => kinds.includes(kind)), kinds.join(','))

  // ---------------------------------------------------------------------------
  // ⑫ **条件标记的归属**：代理写过它 ⇒ 它的值不再由受信侧控制 ⇒ 这一族的条件观测作废
  // ---------------------------------------------------------------------------
  const agentMarkerWrite = await task({ target: GUARD, guard: LOCKED, content: LOCKED, failOpen: true })
  assertObserverClean('代理写条件标记', agentMarkerWrite.result)
  const markerWrites = await exec(h.db, sql`select count(distinct action_id)::int as count from character_action_events
    where character_id = ${String(characterId)} and capability = 'sandbox.file.write' and operation = 'write'
    and payload->'target'->>'canonicalId' = ${GUARD}`, 'F1 marker provenance')
  check('代理写条件标记这件事本身落在动作账本里（归属检查的前提成立）',
    Number(markerWrites[0]?.count) === 1, String(markerWrites[0]?.count))
  const supportsOf = (state: EblState | undefined) => (state?.evidence ?? []).filter(item => item.verdict === 'support').length
  const beforeForge = supportsOf(await store.get(noControlClaimId))
  const forged = await task({ target: `${FAMILY_NO_CONTROL}/forge.txt`, guard: LOCKED })
  assertObserverClean('标记被代理写过之后', forged.result)
  check('代理写过条件标记之后**不再**产生新的前置条件支持（标记的值不再由受信侧控制）',
    supportsOf(await store.get(noControlClaimId)) === beforeForge,
    `${String(beforeForge)} → ${String(supportsOf(await store.get(noControlClaimId)))}`)
  check('代理写过条件标记之后那次观察也**不算对照**（不 witnessed ⇒ 不计入对照口径）',
    (await store.get(noControlClaimId))?.evidence.every(item =>
      !(item.verdict === 'inconclusive' && item.observation.witnessed && item.observation.complete
        && item.observation.value === undefined)) === true)

  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres',
    evidenceKind: 'real_gateway_real_files_offline_planner', measured_count: checks.length, checks,
    productionOpened: false, modelCalls: 0, humanAcceptance: 'NOT RUN' }, null, 2))
  console.log(`F1 步骤C2 门（形成来源·接线）：${String(checks.length)}/${String(checks.length)}；${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally { await h.stop() }
