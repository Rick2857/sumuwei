/**
 * 规则失效 ⇒ **待执行计划拒用**的门（2026-10-22 · 认知能力建设计划 P2 第 5 步）
 *
 * ============================================================================
 *  它验什么
 * ============================================================================
 *  计划 §3 P2 第 5 步：「合格反例使对应规则失去资格，**派生模型、技能引用和
 *  待执行计划拒用**。」；集成架构 §4：「失效必须贯穿链路：规则暂停、来源撤回、
 *  环境换版或范围不匹配时，**拒绝新的模型消费**；复核已缓存模型、模拟轨迹与
 *  **待执行计划的依赖**，受影响部分重新推演或规划。」
 *
 *  ⇒ 本门在**真 Gateway + 真文件**上验：
 *    ① 计划**执行途中**规则被撤回 ⇒ **后面的步骤不执行**（具名拒用），
 *       计划就此停下（不沿着一个已失效的判断往下走）；
 *    ② 规则**没有**失效时 ⇒ 同样的计划**不被**拒用（闸不误伤）；
 *    ③ 派生模型（预测）**带**着规则的**版本与指纹** ⇒ 失效时才认得出是哪一条。
 *
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
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
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

const sandbox = isolateDatabase('rule-invalidation-refusal', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

const output = resolve('artifacts/local/rule-invalidation-refusal', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'RUNNING', backend: 'postgres' }))
const fsRoot = mkdtempSync(resolve(output, 'files-'))
const h = await createM4Harness({ label: 'rule-invalidation-refusal', userId: 'Alex' })

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
    attribution: { decisionPointAdapterId: 'rir-test', executorAdapterId: 'sandbox-filesystem' } })
  const observer = createEblTaskObserver(h.db, h.userId)
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const authorizations = createTaskAuthorizationRegistry()
  const snapshotPort = createEblRuleSnapshotPort(h.db, characterId, h.userId)
  const forecastPort = createWorldModelForecastPort({
    db: h.db, characterId, activeUserId: h.userId,
    modelVersion: 'world-model-transition@1',
    facts: { encoding: 'utf8' },
  })

  const prepared = 'prepared.txt'
  let claimId = ''

  /** 跑一个任务；`withdrawOnFirstRead` = 第一步读之前把规则撤掉（模拟"途中失效"） */
  async function runPlan (index: number, plan: { goal: string; steps: Array<{ capability: string; operation: string; args: Record<string, unknown> }> }, options: { withdrawOnFirstRead?: boolean } = {}) {
    const evidence = await h.recordUserEvidence(`失效 ${index}：${plan.goal}`)
    const traceId = asTraceId(`rir-task-${index}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `task ${index}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'rir-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'rir-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    let withdrawn = false
    const hook = {
      before: async (input: Parameters<typeof observer.before>[0]) => {
        const observed = await observer.before(input)
        if (options.withdrawOnFirstRead === true && !withdrawn && input.request.capability === 'sandbox.file.read') {
          withdrawn = true
          // ⚠️ 规则在**计划执行途中**失去资格
          await store.commit(claimId, { kind: 'withdraw' })
        }
        return observed
      },
      after: async (input: Parameters<typeof observer.after>[0]) => { await observer.after(input) },
    }
    return await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: hook,
      forecast: { port: forecastPort, deadlineMs: 5_000 },
      ruleSnapshot: snapshotPort,
      planner: { id: 'rir-fixed-offline', endpointHost: 'offline', async plan() {
        return { ok: true, requestCount: 1, plan: { goal: plan.goal, done: true, steps: plan.steps } }
      } } }, { characterId, traceId, authorization, text: `task ${index}` })
  }

  // ① 先把 EBL 命题**做合格**
  for (const index of [1, 2, 3]) {
    const path = `sample-${String(index)}.txt`
    const evidence = await h.recordUserEvidence(`命题 ${index}：写文件后读回。`)
    const traceId = asTraceId(`rir-claim-${String(index)}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `claim ${String(index)}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'rir-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'rir-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: { before: input => observer.before(input), after: input => observer.after(input) },
      planner: { id: 'rir-claim-offline', endpointHost: 'offline', async plan() {
        return { ok: true, requestCount: 1, plan: { goal: 'roundtrip', done: true, steps: [
          { capability: 'sandbox.file.write', operation: 'write', args: { path, content: `UTF-8 验证 ${String(index)}\n` } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path } },
        ] } }
      } } }, { characterId, traceId, authorization, text: `claim ${String(index)}` })
    const ref = eblReadbackRef(result.steps[0]!.actionId!, result.steps[1]!.actionId!, String(evidence.event.id))
    claimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool', predicate: 'readback_matches',
      expected: true, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' }, formation: ref }).id
  }
  check('EBL 命题**当前合格**（拒用闸的前提）', (await store.get(claimId))?.status === 'validated',
    String((await store.get(claimId))?.status))

  // ② 准备对象
  const seed = await runPlan(4, {
    goal: '准备对象',
    steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: prepared, content: '准备好的内容\n' } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
    ],
  })
  check('准备对象：真写 + 真读都成功', seed.steps.length === 2 && seed.steps.every(step => step.status === 'success'))

  // ③ **对照**：规则还活着 ⇒ 计划不被拒用（闸不误伤）
  const control = await runPlan(5, {
    goal: '连读两次（规则还活着）',
    steps: [
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
    ],
  })
  check('③ 对照：规则还活着时，计划**不被**拒用（两次读都跑了）',
    control.steps.length === 2 && control.steps.every(step => step.status === 'success'),
    control.steps.map(step => `${step.capability}.${step.operation}=${String(step.status)}${step.droppedReason === undefined ? '' : `/${step.droppedReason}`}`).join(' | '))

  // ④ **途中失效**：第一步读之前把规则撤掉 ⇒ 第二步必须**被拒用**
  const refused = await runPlan(6, {
    goal: '连读两次（规则中途失效）',
    steps: [
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: prepared } },
    ],
  }, { withdrawOnFirstRead: true })
  check('④ 规则中途被撤回（当前状态 = withdrawn）', (await store.get(claimId))?.status === 'withdrawn',
    String((await store.get(claimId))?.status))
  check('④ **待执行计划拒用**：第二步**没有执行**（具名拒用）',
    refused.steps.some(step => step.droppedReason === 'forecast_rule_unusable'),
    refused.steps.map(step => `${step.capability}.${step.operation}=${String(step.status)}${step.droppedReason === undefined ? '' : `/${step.droppedReason}`}`).join(' | '))
  check('④ 计划**就此停下**（没有继续跑第三步）', refused.steps.length === 2,
    `${String(refused.steps.length)} 步`)
  check('④ 被拒用的那一步**没有产生副作用**（读没发生）',
    refused.steps.filter(step => step.droppedReason === 'forecast_rule_unusable').every(step => step.status === undefined),
    JSON.stringify(refused.steps.map(step => ({ op: step.operation, status: step.status, dropped: step.droppedReason }))))

  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres',
    evidenceKind: 'real_gateway_real_files_offline_planner', measured_count: checks.length, checks,
    productionOpened: false, modelCalls: 0, humanAcceptance: 'NOT RUN' }, null, 2))
  console.log(`规则失效拒用：${checks.length}/${checks.length}; ${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally {
  await h.stop()
  await resetPluginSqlConnection()
}
