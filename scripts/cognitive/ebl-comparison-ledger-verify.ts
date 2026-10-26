/**
 * 比较结论**落 EBL 账本**的门（2026-10-22 · 认知能力建设计划 P2 第 4 步）
 *
 * ============================================================================
 *  它验什么
 * ============================================================================
 *  集成架构 §4 的接线契约：「真实观察 → EBL：比较与结算」要求带上
 *  「事前测试身份、对应**预测/规则/模型版本**、真实 action/result/readback 引用、
 *    实际条件、**独立根**、执行/完整性/**排除原因**与规则影响标记」
 *  「**mismatch 先作待审异常**；条件成立且观察合格才可结算 counterexample；
 *    **缺失与传输故障分列**」
 *
 *  ⇒ 本门在**真 Gateway + 真文件**上验四件事：
 *    ① 结算记录里带着「**比的是哪一版模型 / 哪条规则 / 哪个对象**」；
 *    ② 结算挂在**事前登记的测试**上（身份对得上）；
 *    ③ 独立根在案（结算不是"凭观察说了算"）；
 *    ④ **读失败（缺失/传输故障）⇒ 不结算、不反驳**（规则**不被挂起**）
 *       —— 「没读成」与「读得不一样」是**两件事**。
 *
 *  ⚠️ 零模型调用、零出网、真实库从未被打开。
 * ============================================================================
 */

import 'dotenv/config'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const sandbox = isolateDatabase('ebl-comparison-ledger', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

const output = resolve('artifacts/local/ebl-comparison-ledger', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'RUNNING', backend: 'postgres' }))
const fsRoot = mkdtempSync(resolve(output, 'files-'))
const h = await createM4Harness({ label: 'ebl-comparison-ledger', userId: 'Alex' })

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
    attribution: { decisionPointAdapterId: 'ecl-test', executorAdapterId: 'sandbox-filesystem' } })
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

  /** 跑一个任务；`fault` = 读之前把文件删掉（制造"读失败"） */
  async function runPlan (index: number, plan: { goal: string; steps: Array<{ capability: string; operation: string; args: Record<string, unknown> }> }, options: { forecast: boolean; fault?: boolean }) {
    const evidence = await h.recordUserEvidence(`结算 ${index}：${plan.goal}`)
    const traceId = asTraceId(`ecl-task-${index}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `task ${index}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'ecl-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'ecl-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    const hook = {
      before: async (input: Parameters<typeof observer.before>[0]) => {
        const observed = await observer.before(input)
        /*
         * ⚠️ 故障注入：**登记之后、执行之前**把文件删掉 ⇒
         *    ① 事前登记的测试**已经**在案（⇒ 它会停在"待结算"）；
         *    ② 这次读**真的失败**（缺失）⇒ 没有读回事实 ⇒ **不结算、不反驳**。
         */
        if (options.fault === true && input.request.capability === 'sandbox.file.read') {
          rmSync(resolve(fsRoot, prepared), { force: true })
        }
        return observed
      },
      after: async (input: Parameters<typeof observer.after>[0]) => { await observer.after(input) },
    }
    return await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: hook,
      ...(options.forecast ? { forecast: { port: forecastPort, deadlineMs: 5_000 } } : {}),
      planner: { id: 'ecl-fixed-offline', endpointHost: 'offline', async plan() {
        return { ok: true, requestCount: 1, plan: { goal: plan.goal, done: true, steps: plan.steps } }
      } } }, { characterId, traceId, authorization, text: `task ${index}` })
  }

  // ① 先把 EBL 命题**做合格**（三次真"写进去 → 读回来"）
  for (const index of [1, 2, 3]) {
    const path = `sample-${String(index)}.txt`
    const evidence = await h.recordUserEvidence(`命题 ${index}：写文件后读回。`)
    const traceId = asTraceId(`ecl-claim-${String(index)}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `claim ${String(index)}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'ecl-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'ecl-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: { before: input => observer.before(input), after: input => observer.after(input) },
      planner: { id: 'ecl-claim-offline', endpointHost: 'offline', async plan() {
        return { ok: true, requestCount: 1, plan: { goal: 'roundtrip', done: true, steps: [
          { capability: 'sandbox.file.write', operation: 'write', args: { path, content: `UTF-8 验证 ${String(index)}\n` } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path } },
        ] } }
      } } }, { characterId, traceId, authorization, text: `claim ${String(index)}` })
    const ref = eblReadbackRef(result.steps[0]!.actionId!, result.steps[1]!.actionId!, String(evidence.event.id))
    claimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool', predicate: 'readback_matches',
      expected: true, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' }, formation: ref }).id
  }
  check('EBL 命题**当前合格**（结算的前提）', (await store.get(claimId))?.status === 'validated',
    String((await store.get(claimId))?.status))

  // ② 准备对象（写一次），让模型有"上一次写入"可绑定
  const seed = await runPlan(4, {
    goal: '准备对象',
    steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: prepared, content: '准备好的内容\n' } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
    ],
  }, { forecast: false })
  check('准备对象：真写 + 真读都成功', seed.steps.length === 2 && seed.steps.every(step => step.status === 'success'))

  /*
   * ③ 带模型跑一次"写 + 读"⇒
   *    · EBL 侧：**同一个任务**里的写→读会**事前登记**一个测试并**结算**它；
   *    · 模型侧：这个路径**上一次**写入的内容指纹就是它的预期
   *      （本任务又写了一次 ⇒ 世界动了 ⇒ 模型预期被**反驳**）。
   *    ⇒ 于是"结算"与"模型被反驳"**同时**出现，且结算里带着"比的是哪一版"。
   */
  const settled = await runPlan(5, {
    goal: '改写后再读（带模型）',
    steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: prepared, content: '被改过的内容\n' } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
    ],
  }, { forecast: true })
  check('③ 带模型：这一步被核对了（比较结论存在）',
    (settled.comparisons ?? []).length > 0, JSON.stringify(settled.comparisons ?? []))

  const stateAfter = await store.get(claimId)
  const latest = stateAfter?.evidence.at(-1)
  check('③ 结算落账本：带上了**模型版本**', latest?.model?.modelVersion === 'world-model-transition@1',
    String(latest?.model?.modelVersion))
  check('③ 结算落账本：带上了**规则版本**（是哪条规则的哪一版）',
    typeof latest?.model?.ruleVersion === 'string' && latest.model.ruleVersion !== '',
    String(latest?.model?.ruleVersion))
  check('③ 结算落账本：带上了**参数绑定摘要**（比的是哪个对象）',
    typeof latest?.model?.parameterBindingDigest === 'string' && latest.model.parameterBindingDigest !== '',
    String(latest?.model?.parameterBindingDigest))
  check('③ 结算挂在**事前登记的测试**上（身份对得上）',
    typeof latest?.testId === 'string' && stateAfter?.tests.some(test => test.id === latest.testId) === true,
    `testId=${String(latest?.testId)}`)
  check('③ 独立根在案（结算不是"凭观察说了算"）',
    (latest?.observation.rootIds.length ?? 0) > 0, String(latest?.observation.rootIds.length ?? 0))
  check('③ **EBL 侧**的结算是"读回与本次写入一致"（support）',
    latest?.verdict === 'support', String(latest?.verdict))
  const mismatchAction = settled.comparisons?.find(item => item.verdict === 'mismatch')?.actualSourceRef
  const mismatchSettlement = stateAfter?.evidence.find(item => item.testId === mismatchAction)
  check('预测 mismatch 单独入账，不能覆盖原生 support 或挂起信念',
    mismatchSettlement?.model?.forecastVerdict === 'mismatch' && mismatchSettlement.verdict === 'support' && stateAfter?.status !== 'suspended')
  check('③ **模型侧**的结论是"被反驳"（mismatch）—— 两个口径**各说各的**，都入账',
    (settled.comparisons ?? []).some(item => item.verdict === 'mismatch'),
    JSON.stringify(settled.comparisons ?? []))

  // ④ **读失败**（文件在读之前被删）⇒ 不结算、不反驳、规则**不被挂起**
  const beforeEvidence = (await store.get(claimId))?.evidence.length ?? 0
  const failed = await runPlan(6, {
    goal: '读一个被删掉的对象（缺失）',
    steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: prepared, content: '再来一次\n' } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
    ],
  }, { forecast: true, fault: true })
  const afterFailure = await store.get(claimId)
  check('④ 读失败：这次读**真的失败了**', failed.steps.some(step => step.status !== 'success'),
    failed.steps.map(step => `${step.capability}.${step.operation}=${String(step.status)}`).join(' | '))
  check('④ 读失败：**没有**新的结算（缺失不是"读得不一样"）',
    (afterFailure?.evidence.length ?? 0) === beforeEvidence,
    `${String(beforeEvidence)} → ${String(afterFailure?.evidence.length ?? 0)}`)
  check('④ 读失败：规则**仍然合格**（没被挂起 —— 缺失与反驳分列）',
    afterFailure?.status === 'validated', String(afterFailure?.status))
  check('④ 读失败：核对结论**不是** mismatch（不可判）',
    (failed.comparisons ?? []).every(item => item.verdict !== 'mismatch'),
    JSON.stringify(failed.comparisons ?? []))

  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres',
    evidenceKind: 'real_gateway_real_files_offline_planner', measured_count: checks.length, checks,
    productionOpened: false, modelCalls: 0, humanAcceptance: 'NOT RUN' }, null, 2))
  console.log(`比较落账本：${checks.length}/${checks.length}; ${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally {
  await h.stop()
  await resetPluginSqlConnection()
}
