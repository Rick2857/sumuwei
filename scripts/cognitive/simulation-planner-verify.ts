import 'dotenv/config'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFilePlanningBed, scoreFileTask } from './file-planning-bed.ts'
import { createSimulationTaskPlanner, type SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { contentFingerprint } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import type { TaskPlan, TaskPlannerInput } from '../../src/kernel/action/task-plan.ts'

const bed = await createFilePlanningBed('simulation-planner')
const checks: string[] = []
const check = (name: string, condition: unknown) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`) }
try {
  const path = 'goal.txt', content = 'the explicit task value'
  const goal = { path, expectedFingerprint: contentFingerprint(content) }
  const write = (value: string) => ({ capability: 'sandbox.file.write', operation: 'write', args: { path, content: value } })
  const read = { capability: 'sandbox.file.read', operation: 'read', args: { path } }
  const candidates: TaskPlan[] = [
    { goal: 'model says done, but wrong bytes', done: true, steps: [write('wrong'), read] },
    { goal: 'unnecessary intermediate write', done: true, steps: [write('intermediate'), write(content), read] },
    { goal: 'write then verify', done: true, steps: [write(content), read] },
  ]
  const input: TaskPlannerInput = { task: 'write explicit value and read it back', executed: [], failures: [],
    remainingActions: 4, allowedCapabilities: bed.allowed }
  let lastSelection: SimulationPlanSelection | undefined
  const makePlanner = (plans = candidates, extra = {}) => createSimulationTaskPlanner({ ...bed.modelOptions,
    registry: bed.registry, goal,
    candidateSource: { id: 'fixture', endpointHost: 'offline', async propose() { return { candidates: plans, requestCount: 1 } } },
    onSelection: selection => { lastSelection = selection }, ...extra,
  })
  const before = await bed.counts()
  const selected = await makePlanner().plan(input)
  check('选择目标可核对且步骤最少的候选，不信模型 done', selected.ok && lastSelection?.selectedIndex === 2)
  check('选路没有真实工具调用、动作或新 EBL 证据', JSON.stringify(await bed.counts()) === JSON.stringify(before))
  check('所选预期带真实规则身份、版本与证据指纹', selected.ok && selected.simulation?.dependency.claimId === bed.rule.claimId &&
    selected.simulation.dependency.evidenceFingerprint === bed.rule.evidenceFingerprint)
  check('模拟后的读回预期是新写入内容，不是旧账本的取值', selected.ok &&
    selected.simulation?.forecast.steps[0]?.check.kind === 'effect_fingerprint_matches' &&
    selected.simulation.forecast.steps[0].check.expectedFingerprint === goal.expectedFingerprint)
  const wrong = await makePlanner([candidates[0]!]).plan(input)
  check('没有目标可核对路径时不选路', !wrong.ok && lastSelection?.reason === 'goal_unproven')
  const unknown = await makePlanner([{ goal: 'unknown read', done: true, steps: [read] }]).plan(input)
  check('未知起始状态不被当作完成', !unknown.ok && lastSelection?.reason === 'goal_unproven')
  const budget = await makePlanner().plan({ ...input, remainingActions: 1 })
  check('候选超过剩余行动预算时拒绝，不截断假装完成', !budget.ok && lastSelection?.reason === 'budget')
  check('候选路径超过 8 条时拒绝', !(await makePlanner(Array.from({ length: 9 }, () => candidates[2]!)).plan(input)).ok)
  check('单路径超过 4 步时拒绝', !(await makePlanner([{ ...candidates[2]!, steps: Array.from({ length: 5 }, () => read) }]).plan(input)).ok)
  check('条件未知时不借用规则', !(await makePlanner(candidates, { facts: {} }).plan(input)).ok && lastSelection?.reason === 'no_rule')
  check('模型未获授权的动作不能进入候选', !(await makePlanner([{ goal: 'forged', done: true,
    steps: [{ capability: 'web.search', operation: 'search', args: { query: 'unrelated' } }] }]).plan(input)).ok)
  check('候选不能夹带另一个对象的写入', !(await makePlanner([{ ...candidates[2]!,
    steps: [{ ...write(content), args: { path: 'other.txt', content } }, read] }]).plan(input)).ok)

  const executed = await bed.run(makePlanner())
  check('真实任务执行的是选中的两步，没有执行被淘汰路径', executed.results.length === 2 &&
    executed.results.every(item => item.result.status === 'success') && (await bed.counts()).adapterCalls === before.adapterCalls + 2)
  check('真实文件内容达到目标', readFileSync(resolve(bed.root, path), 'utf8') === content)
  check('模拟选路的预期进入真实核对链', executed.comparisons?.some(item => item.verdict === 'match') === true)
  check('程序目标成立不依赖模型 done 提示或停止原因', scoreFileTask({ ...executed, stopped: 'budget_plans' },
    { root: bed.root, path, content }).achieved)
  const noRead = scoreFileTask({ ...executed, results: executed.results.filter(item => item.request.capability !== 'sandbox.file.read') },
    { root: bed.root, path, content })
  check('只有文件正确而没有真实读回时仍不算达成，并识别假完成', !noRead.achieved && noRead.falseCompletion)
  check('不能借另一个对象的真实读回证明目标成立', !scoreFileTask(executed,
    { root: bed.root, path: 'training-1.txt', content: 'training-1' }).achieved)

  const missingSnapshot = await bed.run({ id: 'cached', endpointHost: 'offline', async plan() { return selected } }, { snapshot: false })
  check('模拟依赖没有当前资格读面时拒绝执行', missingSnapshot.results.length === 0 && missingSnapshot.planRejectedCode === 'simulation_rule_unusable')
  const drift = await bed.run(makePlanner(), { after: async ({ request }) => {
    if (request.capability === 'sandbox.file.write') writeFileSync(resolve(bed.root, path), 'external drift')
  } })
  check('模拟预测与真实读回不符时保留 mismatch，不宣布完成', drift.comparisons?.some(item => item.verdict === 'mismatch') && drift.stopped !== 'done')
  const mid = await bed.run(makePlanner(), { after: async ({ request }) => {
    if (request.capability === 'sandbox.file.write') await bed.store.commit(bed.rule.claimId, { kind: 'withdraw' })
  } })
  check('执行中规则撤回，后续读操作不执行', mid.results.length === 1 && mid.steps.some(step => step.droppedReason === 'simulation_rule_unusable'))
  const callsBeforeStale = (await bed.counts()).adapterCalls
  const stale = await bed.run({ id: 'cached', endpointHost: 'offline', async plan() { return selected } })
  check('缓存选路在来源撤回后不能重新执行', stale.results.length === 0 && (await bed.counts()).adapterCalls === callsBeforeStale)
  check('撤回后不得进行新选路', !(await makePlanner().plan(input)).ok && lastSelection?.reason === 'no_rule')
  writeFileSync(resolve(bed.output, 'verification.json'), JSON.stringify({ status: 'PASS', checks, measured_count: checks.length,
    modelCalls: 0, productionOpened: false, backend: 'postgres', execution: 'serversim' }, null, 2))
} catch (error) {
  writeFileSync(resolve(bed.output, 'verification.json'), JSON.stringify({ status: 'FAIL', checks, error: String(error) }, null, 2))
  throw error
} finally { await bed.stop() }
