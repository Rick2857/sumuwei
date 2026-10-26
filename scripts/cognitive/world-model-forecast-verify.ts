/**
 * 世界模型 → **任务环核对链**的接线门（2026-10-21 · 认知能力建设计划 P2 第 3 步）
 *
 * ============================================================================
 *  它验什么
 * ============================================================================
 *  计划 §3 P2 第 3 步：「把该模型的结果交给现有任务规划/核对链，
 *  **记录实际改变了什么**；**不能以 `predictionChanged` 计数代替接线证据**。」
 *
 *  ⇒ 门在**真 Gateway + 真文件**上跑两个**真实**的任务：
 *    ① **相符**：读回的内容与模型预期一致 ⇒ 核对结论 `match`，
 *       且结论里带着**模型版本 / 规则版本 / 规则依赖**；
 *    ② **不符**：计划在读之前**又写了一次**同一个对象 ⇒ 世界动了
 *       ⇒ 模型的预期被**反驳** ⇒ **这一步被丢弃**、计划**停下**
 *       ⇒ 任务的行为**真的变了**（不是"多了一个计数"）。
 *
 *  ⚠️ 关键判据：**行为差异**（步骤被丢弃 / `forecast_check_refuted`），
 *    不是 `epistemicPredictions` 的计数。
 *  ⚠️ 零模型调用、零出网、真实库从未被打开。
 * ============================================================================
 */

import 'dotenv/config'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ⚠️ 必须在任何会碰数据库的 import 之前（见 src/dev/sandbox.ts 的说明）
import { isolateDatabase, resetPluginSqlConnection } from '../../src/dev/sandbox.ts'

import { createM4Harness } from '../m4-harness.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, eblReadbackRef, EBL_TOOL_ENVIRONMENT } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { createWorldModelForecastPort } from '../../src/infrastructure/runtime/world-model-forecast.ts'
import { makeEblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import { createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS } from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { runTask } from '../../src/kernel/action/task-loop.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'

const checks: string[] = []
function check (name: string, pass: unknown, detail = ''): void {
  assert.ok(pass, name)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const sandbox = isolateDatabase('world-model-forecast', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

const output = resolve('artifacts/local/world-model-forecast', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'RUNNING', backend: 'postgres' }))
const fsRoot = mkdtempSync(resolve(output, 'files-'))
const h = await createM4Harness({ label: 'world-model-forecast', userId: 'Alex' })

try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const fsOptions = { root: fsRoot, staging }
  const ledger = createActionLedgerStore(h.db)
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fsOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger,
    adapters: [createSandboxReadAdapter(fsOptions), createSandboxWriteAdapter(fsOptions)],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'wmf-test', executorAdapterId: 'sandbox-filesystem' } })
  const observer = createEblTaskObserver(h.db, h.userId)
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const authorizations = createTaskAuthorizationRegistry()
  const forecastPort = createWorldModelForecastPort({
    db: h.db, characterId, activeUserId: h.userId,
    modelVersion: 'world-model-transition@1',
    facts: { encoding: 'utf8' },
  })

  const prepared = 'prepared.txt'
  let claimId = ''

  /** 跑一个任务（计划由调用方给），返回任务的读数 */
  async function runPlan (index: number, plan: { goal: string; steps: Array<{ capability: string; operation: string; args: Record<string, unknown> }> }, withForecast: boolean) {
    const evidence = await h.recordUserEvidence(`接线 ${index}：${plan.goal}`)
    const traceId = asTraceId(`wmf-task-${index}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `task ${index}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'wmf-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'wmf-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    return await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: { before: input => observer.before(input), after: input => observer.after(input) },
      ...(withForecast ? { forecast: { port: forecastPort, deadlineMs: 5_000 } } : {}),
      planner: { id: 'wmf-fixed-offline', endpointHost: 'offline', async plan() {
        return { ok: true, requestCount: 1, plan: { goal: plan.goal, done: true, steps: plan.steps } }
      } } }, { characterId, traceId, authorization, text: `task ${index}` })
  }

  // ① 先把 EBL 命题**做合格**（三次真"写进去 → 读回来"）
  for (const index of [1, 2, 3]) {
    const path = `sample-${String(index)}.txt`
    const evidence = await h.recordUserEvidence(`命题 ${index}：写文件后读回。`)
    const traceId = asTraceId(`wmf-claim-${String(index)}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `claim ${String(index)}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'wmf-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'wmf-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: { before: input => observer.before(input), after: input => observer.after(input) },
      planner: { id: 'wmf-claim-offline', endpointHost: 'offline', async plan() {
        return { ok: true, requestCount: 1, plan: { goal: 'roundtrip', done: true, steps: [
          { capability: 'sandbox.file.write', operation: 'write', args: { path, content: `UTF-8 验证 ${String(index)}\n` } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path } },
        ] } }
      } } }, { characterId, traceId, authorization, text: `claim ${String(index)}` })
    const ref = eblReadbackRef(result.steps[0]!.actionId!, result.steps[1]!.actionId!, String(evidence.event.id))
    claimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool', predicate: 'readback_matches',
      expected: true, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' }, formation: ref }).id
  }
  check('EBL 命题**当前合格**（模型的资格来源）', (await store.get(claimId))?.status === 'validated',
    String((await store.get(claimId))?.status))

  // ② 把"准备好的对象"写出来（模型的观察来源）
  const seed = await runPlan(4, {
    goal: '准备对象',
    steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: prepared, content: '准备好的内容\n' } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
    ],
  }, false)
  check('准备对象：真写 + 真读都成功',
    seed.steps.length >= 2 && seed.steps.every(step => step.status === 'success'),
    seed.steps.map(step => `${step.capability}.${step.operation}=${String(step.status)}`).join(' | '))

  // ③ **相符**：模型预期"读回 == 上次写入" ⇒ 核对结论 match
  const matched = await runPlan(5, {
    goal: '读回准备好的对象',
    steps: [{ capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } }],
  }, true)
  const matchComparison = matched.comparisons?.[0]
  // 诊断行：**为什么没有核对**要能一眼看出来（失败码 / 比较读数）
  console.log(`  （读数：forecastFailureCode=${String(matched.forecastFailureCode ?? '无')} · comparisons=${JSON.stringify(matched.comparisons ?? [])}）`)
  check('③ 相符：模型预期进了**核对链**（不是只被计数）',
    matchComparison !== undefined && matchComparison.verdict === 'match',
    JSON.stringify(matchComparison ?? null))
  check('③ 相符：结论带着**模型版本**（比的是哪一版模型）',
    matchComparison?.modelVersion === 'world-model-transition@1', String(matchComparison?.modelVersion))
  check('③ 相符：结论带着**规则版本与规则依赖**（是哪条规则）',
    typeof matchComparison?.refutedRuleVersion === 'undefined' &&
    Array.isArray(matchComparison?.ruleDependencies) && matchComparison.ruleDependencies.length === 1,
    JSON.stringify(matchComparison?.ruleDependencies ?? []))
  check('③ 相符：任务**照常走完**（预测不扩权，也不拦路）',
    matched.steps.length === 1 && matched.steps[0]?.status === 'success')

  const unbound = await forecastPort.forecast({
    goal: '没有目标绑定', candidateSteps: [{ capability: 'sandbox.file.read', operation: 'read' }],
    state: [], remainingActions: 1, remainingModelCalls: 1,
    producedAt: Date.now(), inputRevision: 'unbound-negative-control', deadlineMs: 5_000,
  })
  check('缺少目标绑定时不能随意借用账本里的对象', !unbound.ok && unbound.failure === 'no_applicable_rule')

  const multipleTargets = await runPlan(8, {
    goal: '依次读回两个内容不同的对象',
    steps: [
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: 'sample-1.txt' } },
    ],
  }, true)
  check('同能力不同对象：两步都按各自目标核对成功',
    multipleTargets.comparisons?.length === 2 && multipleTargets.comparisons.every(item => item.verdict === 'match'),
    JSON.stringify(multipleTargets.comparisons ?? []))
  check('同能力不同对象：核对结论对应不同计划步',
    multipleTargets.comparisons?.[0]?.planStepIndex === 0 && multipleTargets.comparisons?.[1]?.planStepIndex === 1)

  // ④ **不符**：计划在读之前**又写了一次**同一个对象 ⇒ 世界动了 ⇒ 预期被反驳
  //    ⚠️ 计划**有三步**：第三步（再一次读）只有在前面核对通过时才会跑。
  //    ⇒ 被反驳 ⇒ 这一轮**停下** ⇒ 任务环**重新规划**（这就是"行为真的变了"）。
  const refuted = await runPlan(6, {
    goal: '改写后再读',
    steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: prepared, content: '被改过的内容\n' } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
    ],
  }, true)
  const refutedComparison = refuted.comparisons?.find(item => item.verdict === 'mismatch')
  console.log(`  （读数：forecastFailureCode=${String(refuted.forecastFailureCode ?? '无')} · comparisons=${JSON.stringify(refuted.comparisons ?? [])} · steps=${refuted.steps.map(step => `${step.capability}.${step.operation}=${String(step.status)}${step.droppedReason === undefined ? '' : `/${step.droppedReason}`}`).join(' | ')}）`)
  check('④ 不符：世界变了 ⇒ 模型的预期被**反驳**（mismatch）',
    refutedComparison !== undefined, JSON.stringify(refuted.comparisons ?? []))
  check('④ 不符：结论指名了**被反驳的规则版本**',
    typeof refutedComparison?.refutedRuleVersion === 'string' && refutedComparison.refutedRuleVersion !== '',
    String(refutedComparison?.refutedRuleVersion))
  check('④ 不符：被反驳 ⇒ 这一轮**停下并重新规划**（不沿着已被证伪的判断往下走）',
    refuted.plansUsed > 1,
    `plansUsed=${String(refuted.plansUsed)}`)

  // ⑤ **对照**：**同一个计划**、没有模型 ⇒ 一口气跑完、没有任何核对
  //    ⇒ ④ 与 ⑤ 的差异**只能**归因于"模型进了核对链"。
  const control = await runPlan(7, {
    goal: '改写后再读（对照：没有模型）',
    steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: prepared, content: '对照内容\n' } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
    ],
  }, false)
  check('⑤ 对照：没有模型时，同一个计划**一口气跑完**（一轮规划）',
    control.plansUsed === 1 && control.steps.length === 3,
    `plansUsed=${String(control.plansUsed)} · steps=${String(control.steps.length)}`)
  check('⑤ 对照：没有模型时**没有任何核对**（证明 ④ 的差异来自模型）',
    (control.comparisons ?? []).length === 0,
    JSON.stringify(control.comparisons ?? []))
  check('⑤ 对照：**有模型时被反驳过的那一轮**确实多规划了一轮（行为真的变了）',
    refuted.plansUsed > control.plansUsed,
    `有模型 plansUsed=${String(refuted.plansUsed)} · 对照 plansUsed=${String(control.plansUsed)}`)

  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres',
    evidenceKind: 'real_gateway_real_files_offline_planner', measured_count: checks.length, checks,
    productionOpened: false, modelCalls: 0, humanAcceptance: 'NOT RUN' }, null, 2))
  console.log(`预测接线：${checks.length}/${checks.length}; ${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally {
  await h.stop()
  await resetPluginSqlConnection()
}
