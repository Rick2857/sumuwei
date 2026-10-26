/**
 * 短程模拟 · **机器门**（2026-10-22 · 认知能力建设计划 P2 第 6 步）
 *
 * ============================================================================
 *  它验什么
 * ============================================================================
 *  计划 §3 P2 第 6 步：「加入**有上限**的多步候选比较；在**未覆盖状态或冲突**处返回
 *  **未知**，**模拟轨迹不写成真实经历**。」
 *  集成架构 §3：「Simulation 使用**模型状态副本**，**不调用真实工具**，
 *  也不把模拟分支写成真实经历。」
 *
 *  ⇒ 门在**真 Gateway + 真文件**上造出真实状态，然后：
 *    ① 模拟跑在**副本**上（输入状态**逐字不变**）；
 *    ② 模拟**不调真实工具**（适配器调用计数 = 0）、**真实账本不长**（模拟不是经历）；
 *    ③ 多步候选路径**可比**（两条都走完，且逐步读数在案）；
 *    ④ **未覆盖**的状态 ⇒ `unknown`（**不编结论**）；
 *    ⑤ **冲突** ⇒ `conflict`（**不用后一次覆盖前一次**）；
 *    ⑥ **有上限**：超步数 ⇒ 截断并**如实说**（不是"算完了"）。
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
import {
  simulateTransitionPaths,
  validateSimulationAction,
  type SimulationAction,
} from '../../src/kernel/contracts/world-model-simulation.ts'
import type { ObservedTransitionState } from '../../src/kernel/contracts/world-model-transition.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import {
  createSandboxReadAdapter,
  createSandboxWriteAdapter,
  listSandboxEntries,
} from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS } from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { runTask } from '../../src/kernel/action/task-loop.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { contentFingerprint } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, eblReadbackRef, EBL_TOOL_ENVIRONMENT } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { buildTransitionRule, simulateCurrentTransition } from '../../src/infrastructure/runtime/world-model-transition.ts'
import { makeEblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'

const checks: string[] = []
function check (name: string, pass: unknown, detail = ''): void {
  assert.ok(pass, name)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const sandbox = isolateDatabase('short-range-simulation', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

const output = resolve('artifacts/local/short-range-simulation', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'RUNNING', backend: 'postgres' }))
const fsRoot = mkdtempSync(resolve(output, 'files-'))
const h = await createM4Harness({ label: 'short-range-simulation', userId: 'Alex' })

try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const fsOptions = { root: fsRoot, staging }
  const ledger = createActionLedgerStore(h.db)
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fsOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })

  /*
   * ⚠️ **会计数的适配器**：模拟如果偷偷调了真实工具，这里会露出来。
   *    （真实工具 = 真的改文件；模拟只许在副本上推演。）
   */
  let adapterCalls = 0
  const countingRead = createSandboxReadAdapter(fsOptions)
  const countingWrite = createSandboxWriteAdapter(fsOptions)
  const gateway = createActionGateway({ registry, ledger,
    adapters: [
      { ...countingRead, async execute(input) { adapterCalls += 1; return countingRead.execute(input) } },
      { ...countingWrite, async execute(input) { adapterCalls += 1; return countingWrite.execute(input) } },
    ],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'srs-test', executorAdapterId: 'sandbox-filesystem' } })
  const authorizations = createTaskAuthorizationRegistry()
  const observer = createEblTaskObserver(h.db, h.userId)
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const snapshotPort = createEblRuleSnapshotPort(h.db, characterId, h.userId)
  let claimId = ''

  /** 真写一个文件，拿到它的内容指纹（**真实经历**） */
  async function writeReal (index: number, path: string, content: string): Promise<string> {
    const evidence = await h.recordUserEvidence(`模拟夹具 ${String(index)}：写 ${path}。`)
    const traceId = asTraceId(`srs-task-${String(index)}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `write ${path}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'srs-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'srs-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: { before: input => observer.before(input), after: input => observer.after(input) },
      planner: { id: 'srs-write', endpointHost: 'offline', async plan() {
        return { ok: true, requestCount: 1, plan: { goal: 'write', done: true, steps: [
          { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path } },
        ] } }
      } } }, { characterId, traceId, authorization, text: `write ${path}` })
    check(`夹具：真写读 ${path} 成功`, result.steps.length === 2 && result.steps.every(step => step.status === 'success'))
    const formation = eblReadbackRef(result.steps[0]!.actionId!, result.steps[1]!.actionId!, String(evidence.event.id))
    claimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool', predicate: 'readback_matches',
      expected: true, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' }, formation }).id
    return contentFingerprint(content)
  }

  // ① 真实状态：两个对象各写一次
  const fingerprintA = await writeReal(1, 'a.txt', 'A 的内容\n')
  const fingerprintB = await writeReal(2, 'b.txt', 'B 的内容\n')
  await writeReal(3, 'qualification.txt', '第三条独立观察\n')
  const currentSnapshot = await snapshotPort.current(claimId)
  assert.ok(currentSnapshot)
  const translation = buildTransitionRule(currentSnapshot)
  assert.ok('rule' in translation)
  const rule = translation.rule
  check('模拟采用真实读回支持的当前合格规则', currentSnapshot.usable === true)
  const callsBefore = adapterCalls
  const recordsBefore = (await ledger.listRecords({ characterId, limit: 500 })).length

  const initialState: ObservedTransitionState = {
    actions: (await ledger.listRecords({ characterId, limit: 500 })).reverse().map(record => ({
      actionId: String(record.actionId), capability: record.capability, operation: record.operation,
      status: String(record.status), effects: {
        ...(record.target?.canonicalId === undefined ? {} : { path: String(record.target.canonicalId) }),
        ...(record.effect?.fingerprint === undefined ? {} : { contentFingerprint: String(record.effect.fingerprint) }),
      },
    })),
    facts: { encoding: 'utf8', 'fingerprint:a.txt': fingerprintA, 'fingerprint:b.txt': fingerprintB },
  }
  const stateBefore = JSON.stringify(initialState)

  const readOf = (path: string): SimulationAction => validateSimulationAction({
    capability: 'sandbox.file.read', operation: 'read', arguments: { path },
  })

  // ② 多步候选比较：两条路径
  const report = simulateTransitionPaths({
    rule,
    initialState,
    candidates: [
      { id: 'path-read-a-twice', actions: [readOf('a.txt'), readOf('a.txt')] },
      { id: 'path-read-b', actions: [readOf('b.txt')] },
    ],
  })

  check('② 模拟报告标明自己**不是经历**', report.simulation === true)
  check('② 两条候选路径都**比过了**', report.comparedPaths === 2 && report.traces.length === 2, `比较了 ${String(report.comparedPaths)} 条`)
  check('② 两条路径都**走完**（多步）', report.traces.every(trace => trace.outcome === 'completed'),
    report.traces.map(trace => `${trace.id}=${trace.outcome}`).join(' | '))
  check('② 第一条路径真的走了**两步**', (report.traces[0]?.steps.length ?? 0) === 2 &&
    report.traces[0]?.steps.every(step => step.outcome === 'applied') === true)
  check('② 逐步读数在案（可检查）', (report.traces[0]?.steps[0]?.expectation?.predicate ?? '') === 'same_content_fingerprint',
    String(report.traces[0]?.steps[0]?.expectation?.predicate))

  // ③ 副本：输入状态**逐字不变**
  check('③ 模拟跑在**副本**上（输入状态逐字不变）', JSON.stringify(initialState) === stateBefore)

  // ④ 不调真实工具、真实账本不长（模拟不是经历）
  check('④ 模拟**没有调用真实工具**（适配器调用计数不变）', adapterCalls === callsBefore,
    `${String(callsBefore)} → ${String(adapterCalls)}`)
  const recordsAfter = (await ledger.listRecords({ characterId, limit: 500 })).length
  check('④ 模拟**没有写进真实账本**（不是经历）', recordsAfter === recordsBefore,
    `${String(recordsBefore)} → ${String(recordsAfter)} 条记录`)

  // ⑤ 未覆盖的状态 ⇒ unknown（不编结论）
  const uncovered = simulateTransitionPaths({
    rule,
    initialState,
    candidates: [{ id: 'read-never-written', actions: [readOf('never-written.txt')] }],
  })
  check('⑤ 未覆盖的状态 ⇒ **unknown**（不编结论）',
    uncovered.traces[0]?.outcome === 'unknown' && uncovered.traces[0]?.steps[0]?.outcome === 'unknown',
    String(uncovered.traces[0]?.steps[0]?.detail))
  check('⑤ 未覆盖时整体结论也是 unknown（不是 compared）', uncovered.outcome === 'unknown', uncovered.outcome)

  // ⑥ 冲突 ⇒ conflict（不用后一次覆盖前一次）
  const conflicted = simulateTransitionPaths({
    rule,
    initialState: {
      actions: [
        ...initialState.actions,
        { actionId: 'sim-write-a2', capability: 'sandbox.file.write', operation: 'write', status: 'success', effects: { path: 'a.txt', contentFingerprint: 'ffffffffffffffff' } },
      ],
      facts: initialState.facts,
    },
    candidates: [{ id: 'read-conflicted', actions: [readOf('a.txt')] }],
  })
  check('⑥ 同一对象两个不同指纹 ⇒ **conflict**（不用后一次覆盖前一次）',
    conflicted.traces[0]?.outcome === 'conflict' && conflicted.traces[0]?.steps[0]?.outcome === 'conflict',
    String(conflicted.traces[0]?.steps[0]?.detail))
  check('⑥ 冲突诊断保留，整体比较结论为 unknown', conflicted.outcome === 'unknown', conflicted.outcome)

  // ⑦ 有上限：超步数 ⇒ 截断并如实说
  const bounded = simulateTransitionPaths({
    rule,
    initialState,
    candidates: [{ id: 'too-long', actions: [readOf('a.txt'), readOf('a.txt'), readOf('a.txt'), readOf('a.txt'), readOf('a.txt')] }],
    maxSteps: 2,
  })
  check('⑦ 超过步数上限 ⇒ 截断并**如实说**（不是"算完了"）',
    bounded.traces[0]?.outcome === 'unknown' && bounded.traces[0].steps.at(-1)?.detail.includes('上限') === true,
    String(bounded.traces[0]?.steps.at(-1)?.detail))
  check('⑦ 预算被写进报告（上限可查）', bounded.budget.maxSteps === 2 && bounded.budget.maxPaths === 8,
    JSON.stringify(bounded.budget))

  // ⑧ 路径数上限
  const manyPaths = simulateTransitionPaths({
    rule,
    initialState,
    candidates: Array.from({ length: 5 }, (_, index) => ({ id: `p${String(index)}`, actions: [readOf('a.txt')] })),
    maxPaths: 2,
  })
  check('⑧ 超过路径上限 ⇒ 截断且**如实标记**',
    manyPaths.truncated === true && manyPaths.comparedPaths === 2,
    `比较了 ${String(manyPaths.comparedPaths)} / 截断=${String(manyPaths.truncated)}`)

  check('步数截断也必须标记覆盖不完整', bounded.truncated === true)
  for (const limit of [NaN, Infinity, 1.5, 0, -1]) {
    assert.throws(() => simulateTransitionPaths({
      rule, initialState,
      candidates: [{ id: 'invalid-budget', actions: [readOf('a.txt')] }], maxSteps: limit,
    }), { code: 'simulation_bad_budget' })
    assert.throws(() => simulateTransitionPaths({
      rule, initialState, candidates: [], maxPaths: limit,
    }), { code: 'simulation_bad_budget' })
  }
  check('非法预算不能绕过步数或路径上限', true)
  check('没有候选路径不能声称已完成比较', simulateTransitionPaths({
    rule, initialState, candidates: [],
  }).outcome === 'unknown')
  check('同名 read 操作不能套用到其他能力', simulateTransitionPaths({
    rule, initialState,
    candidates: [{ id: 'wrong-capability', actions: [{ ...readOf('a.txt'), capability: 'other.read' }] }],
  }).outcome === 'unknown')
  const failedWrite = {
    actions: [{ actionId: 'failed-write', capability: 'sandbox.file.write', operation: 'write',
      status: 'failed', effects: { path: 'failed.txt', contentFingerprint: 'uncommitted' } }], facts: { encoding: 'utf8' },
  }
  check('失败写入不能被模拟成已知成功状态', simulateTransitionPaths({
    rule, initialState: failedWrite,
    candidates: [{ id: 'failed-write', actions: [readOf('failed.txt')] }],
  }).outcome === 'unknown')
  const rewrite = simulateTransitionPaths({
    rule, initialState,
    candidates: [{ id: 'rewrite', actions: [
      { capability: 'sandbox.file.write', operation: 'write', arguments: { path: 'a.txt', contentFingerprint: 'new-fingerprint' } },
      readOf('a.txt'),
    ] }],
  })
  check('正常顺序改写后，读回预测使用新指纹', rewrite.outcome === 'compared' &&
    rewrite.traces[0]?.steps[1]?.expectation?.expectedFingerprint === 'new-fingerprint')
  assert.throws(() => validateSimulationAction({ capability: 'sandbox.file.read', operation: 'read',
    arguments: { path: 'a.txt', code: 'untrusted' } }), { code: 'simulation_action_bad_arguments' })
  check('闭集参数拒绝额外代码字段', true)
  assert.throws(() => validateSimulationAction({ ...readOf('a.txt'), code: 'untrusted' }),
    { code: 'simulation_action_unknown_field' })
  check('闭集动作拒绝额外顶层字段', true)

  const simulationInput = { snapshot: snapshotPort, claimId, initialState,
    visible: { subjectId: h.userId, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT },
    candidates: [{ id: 'qualified', actions: [readOf('a.txt')] }],
  }
  const qualified = await simulateCurrentTransition(simulationInput)
  check('运行时模拟按当前资格构造规则，并保留规则版本与来源指纹', qualified.ok &&
    qualified.report.rule.version === currentSnapshot.ruleVersion &&
    qualified.report.rule.binding.evidenceFingerprint === currentSnapshot.evidenceFingerprint && qualified.report.outcome === 'compared')
  const unknownConditions = await simulateCurrentTransition({ ...simulationInput, initialState: { ...initialState, facts: {} } })
  check('运行时条件未知时拒绝推演', !unknownConditions.ok && unknownConditions.reason === 'condition_unknown')
  const wrongSubject = await simulateCurrentTransition({ ...simulationInput, visible: { ...simulationInput.visible, subjectId: 'other-user' } })
  check('其他主体不能借用当前规则模拟', !wrongSubject.ok && wrongSubject.reason === 'subject_mismatch')
  const wrongEnvironment = await simulateCurrentTransition({ ...simulationInput, visible: { ...simulationInput.visible, environment: 'other-environment' } })
  check('环境版本变化不继承模拟资格', !wrongEnvironment.ok && wrongEnvironment.reason === 'environment_mismatch')
  await store.commit(claimId, { kind: 'withdraw' })
  const withdrawn = await simulateCurrentTransition(simulationInput)
  check('来源撤回后，即使旧规则与旧报告仍在，也不得开始新模拟', !withdrawn.ok && withdrawn.reason === 'not_usable')
  check('撤回不改写旧模拟报告', qualified.ok && qualified.report.rule.version === currentSnapshot.ruleVersion)
  check('包含所有模拟和拒用负控后仍未新增真实工具调用或动作账本',
    adapterCalls === callsBefore && (await ledger.listRecords({ characterId, limit: 500 })).length === recordsBefore)

  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres',
    evidenceKind: 'real_gateway_real_files_offline_planner', measured_count: checks.length, checks,
    productionOpened: false, modelCalls: 0, humanAcceptance: 'NOT RUN' }, null, 2))
  console.log(`短程模拟：${checks.length}/${checks.length}; ${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally {
  await h.stop()
  await resetPluginSqlConnection()
}
