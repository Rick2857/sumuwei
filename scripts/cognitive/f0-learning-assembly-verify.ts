/**
 * F0 **学习装配**的离线门（**零模型请求**）。
 *
 * 证明的是 v2 装配（世界×臂隔离、不赠送规则、开原生观察）确实让学习**发生在被测序列里**：
 * ① `train:false` 的床位**开局没有合格规则**；
 * ② 连续任务的真实执行反馈会**积累**证据并在**资格政策**要求时**形成**合格规则；
 * ③ 规则**跨任务保留**（同一床位内状态连续）⇒ "迁移/消费"才有载体；
 * ④ **候选覆盖写检查**的判定边界。
 *
 * ⚠️ 本门**不**证明任何收益，只证明装配让学习真的发生。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createObservingFilePlanningBed } from './file-planning-bed.ts'
import { poolCoversGoal } from './f0-learning-core.ts'
import { createSimulationPlanning } from '../../src/infrastructure/runtime/simulation-planning.ts'
import type { TaskPlan, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'

const cases = ['no-gift-rule', 'learning-chain', 'state-continuity', 'coverage-check', 'c-arm-cold-start', 'runner-writes-fields']

if (process.argv.includes('--list-cases')) { console.log(cases.join('\n')); process.exit(0) }
const selected = process.argv[process.argv.indexOf('--case') + 1]
assert.ok(cases.includes(selected), `unknown_case:${String(selected)}`)

let checks = 0
/** 轨迹摘要（并进最后一行 ⇒ 场景门会把成功用例的摘要也显示出来）。 */
let trajectory = ''
const ok = (label: string, condition: boolean, detail = '') => { assert.ok(condition, detail === '' ? label : label + ': ' + detail); checks += 1 }

/** 占位规划器：写目标内容再读回（**不调用模型**，只驱动真实执行与观察）。 */
function placeholder(path: string, content: string): TaskPlannerPort {
  return { id: 'offline-placeholder', endpointHost: 'offline', async plan() {
    return { ok: true, requestCount: 1, plan: { goal: 'offline', done: true, steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path } },
    ] } }
  } }
}

if (selected === 'no-gift-rule') {
  const bed = await createObservingFilePlanningBed('f0-gate-no-gift')
  try {
    ok('no_rule_at_start', (await bed.usableRules()).length === 0)
    ok('rule_undefined_at_start', bed.rule === undefined)
  } finally { await bed.stop() }
} else if (selected === 'learning-chain' || selected === 'state-continuity') {
  const bed = await createObservingFilePlanningBed(`f0-gate-${selected}`)
  try {
    const usable0 = (await bed.usableRules()).length
    ok('start_without_rule', usable0 === 0)
    const before: number[] = []
    const after: number[] = []
    for (let index = 0; index < 3; index += 1) {
      const path = `learned-${index}.txt`
      before.push((await bed.usableRules()).length)
      const outcome = await bed.run(placeholder(path, `content-${index}`), { text: `write ${path} then read back`, observe: true })
      after.push((await bed.usableRules()).length)
      ok(`task${index}_executed`, outcome.results.length === 2 && outcome.results.every(item => item.result.status === 'success'))
      ok(`task${index}_no_epistemic_failure`, (outcome.epistemicFailures ?? 0) === 0)
    }
    // ⚠️ **只断言恒等式与不变量，不猜资格阈值**（阈值由轨迹**测**出来，不写死）。
    // ① 状态在任务之间**连续**：第 i 个任务开始时的规则数 == 第 i-1 个任务结束时的规则数。
    ok('state_carries_across_tasks', before.slice(1).every((value, index) => value === after[index]))
    // ② 规则在**被测序列内**形成（开始时没有、结束时已有）⇒ 规则是被观察形成的，不是被赠送的。
    ok('rule_formed_within_the_sequence', after[after.length - 1] >= 1)
    // ③ 形成后**保持**。
    ok('rule_persists_to_the_end', after[after.length - 1] >= after[Math.max(0, after.length - 2)])
    console.log(`formation trajectory (usable rules before->after per task): ${before.map((value, index) => `${value}->${after[index]}`).join(' ')}`)
    const counts = await bed.counts()
    ok('rule_has_evidence', counts.evidence >= 2)
    // ⚠️ **不做"新床位为空"的对照**：同一个隔离库里的第二个床位**共用同一个库**
    //    （`isolateDatabase` 用的是同一个 `LG_TEST_PG_URL`）⇒ 那个"对照"会看到前一个床位的规则，
    //    是无效对照。真正的"开局为空"由上面的 `start_without_rule` 断言承担。
  } finally { await bed.stop() }
} else if (selected === 'coverage-check') {
  const goal = { path: 'f0/a/task-1.txt', content: 'exact-bytes' }
  const write = (path: string, content: string): TaskPlan => ({ goal: 'g', done: true, steps: [
    { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path } },
  ] })
  const writeOnly = (path: string, content: string): TaskPlan => ({ goal: 'g', done: true, steps: [
    { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
  ] })
  const readFirst = (path: string, content: string): TaskPlan => ({ goal: 'g', done: true, steps: [
    { capability: 'sandbox.file.read', operation: 'read', args: { path } },
    { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
  ] })
  ok('covers_exact', poolCoversGoal([write(goal.path, goal.content)], goal))
  ok('rejects_wrong_content', !poolCoversGoal([write(goal.path, `${goal.content} `)], goal))
  ok('rejects_wrong_path', !poolCoversGoal([write('f0/b/other.txt', goal.content)], goal))
  ok('rejects_write_without_read', !poolCoversGoal([writeOnly(goal.path, goal.content)], goal))
  ok('rejects_read_before_write', !poolCoversGoal([readFirst(goal.path, goal.content)], goal))
  ok('covers_when_one_of_three_does', poolCoversGoal([write('f0/b/x.txt', 'x'), writeOnly(goal.path, goal.content), write(goal.path, goal.content)], goal))
} else if (selected === 'c-arm-cold-start') {
  // ---------------------------------------------------------------------------
  // **C 臂完整链**（零模型）：无资格 → 普通规划（照常执行）→ 观察积累 → 资格形成
  //                    → 模拟参与选择 → 规则撤回后**恢复普通规划**。
  //
  // ⚠️ 这条链**必须走生产入口** `createSimulationPlanning`：无合格规则时它返回 undefined
  //    ⇒ 外层继续普通规划；直接调模拟规划器会 `no_rule` 失败且**不执行动作** ⇒ 冷启动死锁。
  // ---------------------------------------------------------------------------
  const bed = await createObservingFilePlanningBed('f0-gate-c-cold-start')
  try {
    const modes: string[] = []
    const taskLines: string[] = []
    const rulesBefore: number[] = []
    const rulesAfter: number[] = []
    const texts: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const path = `f0-t${String(index + 1)}-cold.txt`
      const content = `cold-${index}`
      // 任务文本必须能被生产的 `explicitFileGoal` 解析（路径语法受约束）。
      const text = `只操作相对路径 ${path}。写入以下 JSON 字符串解码后的精确内容，再读回核对：${JSON.stringify(content)}。`
      texts.push(text)
      const pool: TaskPlan[] = [
        { goal: 'g', done: true, steps: [
          { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path } },
        ] },
      ]
      const ordinary: TaskPlannerPort = { id: 'offline-pool', endpointHost: 'offline', async plan() {
        // ⚠️ 必须同时给 `candidates`：生产入口要的是**候选数组**（`invalid_output` 就是缺它）。
        return { ok: true, requestCount: 1, plan: pool[0]!, candidates: pool }
      } }
      const production = createSimulationPlanning({
        ...bed.modelOptions, registry: bed.registry, candidatePlanner: ordinary,
      })
      rulesBefore.push((await bed.usableRules()).length)
      const planned = await production(text)
      const mode = planned === undefined ? 'ordinary' : 'simulation'
      modes.push(mode)
      // ⚠️ 捕获**计划结果**（含失败原因）⇒ 模拟接管后为什么没动作，必须看得见。
      let planFailure = 'none'
      const planner: TaskPlannerPort = planned === undefined
        ? ordinary
        : { id: planned.planner.id, endpointHost: planned.planner.endpointHost, async plan(input) {
          const outcome = await planned.planner.plan(input)
          if (!outcome.ok) planFailure = String(outcome.failure ?? 'unknown')
          return outcome
        } }
      const outcome = await bed.run(planner, { text, observe: true })
      const line = `t${index}[mode=${mode} results=${String(outcome.results.length)} stopped=${outcome.stopped} statuses=${outcome.results.map(item => item.result.status).join('+') || 'none'} planFailure=${planFailure}]`
      taskLines.push(line)
      // ⚠️ **普通模式下必须真的执行了动作**（否则观察不会积累 ⇒ 规则永远形成不了 ⇒ 冷启动死锁）。
      if (mode === 'ordinary') {
        ok(`cold_task${index}_ordinary_executed`, outcome.results.length === 2 && outcome.results.every(item => item.result.status === 'success'))
      }
      ok(`cold_task${index}_no_epistemic_failure`, (outcome.epistemicFailures ?? 0) === 0)
      rulesAfter.push((await bed.usableRules()).length)
    }
    trajectory = `modes=${modes.join(' ')} rules=${rulesBefore.map((value, index) => `${value}->${rulesAfter[index]}`).join(' ')} tasks=${taskLines.join(' ')}`
    ok('starts_ordinary', modes[0] === 'ordinary')
    ok('ordinary_mode_actually_executed_actions', modes.filter(mode => mode === 'ordinary').length >= 1)
    ok('rule_formed_during_the_sequence', rulesAfter[rulesAfter.length - 1] >= 1)
    ok('simulation_engages_after_qualification', modes.includes('simulation'))
    // **规则撤回** ⇒ 恢复普通规划（负控）。
    const rule = (await bed.usableRules())[0]
    ok('rule_available_to_withdraw', rule !== undefined)
    await bed.store.commit(rule!.claimId, { kind: 'withdraw' })
    ok('withdrawn_rule_not_usable', (await bed.usableRules()).length === 0)
    const path = 'f0-t9-cold.txt'
    const content = 'cold-8'
    const text = `只操作相对路径 ${path}。写入以下 JSON 字符串解码后的精确内容，再读回核对：${JSON.stringify(content)}。`
    const pool: TaskPlan[] = [{ goal: 'g', done: true, steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path } },
    ] }]
    const ordinary: TaskPlannerPort = { id: 'offline-pool', endpointHost: 'offline', async plan() {
      return { ok: true, requestCount: 1, plan: pool[0]! }
    } }
    const production = createSimulationPlanning({ ...bed.modelOptions, registry: bed.registry, candidatePlanner: ordinary })
    const planned = await production(text)
    ok('after_withdrawal_back_to_ordinary', planned === undefined)
    const outcome = await bed.run(planned?.planner ?? ordinary, { text, observe: true })
    ok('ordinary_still_executes_after_withdrawal', outcome.results.length === 2 && outcome.results.every(item => item.result.status === 'success'))
  } finally { await bed.stop() }
} else if (selected === 'runner-writes-fields') {
  // ---------------------------------------------------------------------------
  // **真实运行器路径**的字段验收（离线、零模型请求）：
  // 起一个 `--arm C --world f0-world-a` 的**子进程**（离线模式、固定候选池），
  // 然后检查它写出的单元读数里**真的**有：规划模式、实际选中编号、选择理由、
  // 规则资格快照、同池不执行对照、预算停止字段。
  // ---------------------------------------------------------------------------
  const evidenceRoot = resolve('artifacts/local/f0-learning')
  mkdirSync(evidenceRoot, { recursive: true })
  // 封存清单的**预算值**必须被运行器采用 ⇒ 门里放一份最小清单。
  const sealPath = resolve(evidenceRoot, 'sealed-manifest.json')
  const previous = existsSync(sealPath) ? readFileSync(sealPath, 'utf8') : undefined
  writeFileSync(sealPath, JSON.stringify({
    kind: 'f0-learning@3',
    budget: { tokenBudget: { maxCompletionTokensPerRequest: 1600, maxTotalTokens: 250000 },
      maxRequests: 72, sequenceModelRequests: 72, sequenceWallClockMs: 7200000 },
  }))
  const child = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs',
    'scripts/cognitive/f0-learning-live.ts', '--arm', 'C', '--world', 'f0-world-a'], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, F0_OFFLINE_MODE: '1', F0_ALLOW_OFFLINE: '1' },
  })
  if (previous === undefined) { try { rmSync(sealPath, { force: true }) } catch { /* keep */ } } else { writeFileSync(sealPath, previous) }
  ok('runner_child_exited_ok', child.status === 0, `child_status=${String(child.status)} stderr=${String(child.stderr ?? '').slice(-400)} stdout=${String(child.stdout ?? '').slice(-400)}`)
  const unitPath = resolve(evidenceRoot, 'unit-f0-world-a-C.json')
  ok('runner_wrote_unit_report', existsSync(unitPath))
  const unit = JSON.parse(readFileSync(unitPath, 'utf8')) as {
    offline: boolean; tasks: Array<{ planningMode: string; selectedIndex?: number; selectionReason?: string;
      usableRuleIds?: string[]; counterfactualOnOwnPool?: { A: number; B: number }; usableRulesBefore: number; usableRulesAfter: number }>
    budgetStop?: string; unrunTasks: string[]
  }
  ok('unit_marked_offline', unit.offline === true)
  ok('unit_has_eight_tasks', unit.tasks.length === 8)
  const simulationTasks = unit.tasks.filter(item => item.planningMode === 'simulation')
  ok('simulation_mode_engaged', simulationTasks.length >= 1)
  const first = simulationTasks[0]!
  ok('simulation_task_records_selected_index', typeof first.selectedIndex === 'number')
  ok('simulation_task_records_selection_reason', typeof first.selectionReason === 'string' && first.selectionReason.length > 0)
  ok('simulation_task_records_rule_snapshot', Array.isArray(first.usableRuleIds) && first.usableRuleIds.length >= 1)
  ok('simulation_task_records_same_pool_counterfactual', first.counterfactualOnOwnPool !== undefined
    && typeof first.counterfactualOnOwnPool.A === 'number' && typeof first.counterfactualOnOwnPool.B === 'number')
  ok('unit_records_budget_fields', Array.isArray(unit.unrunTasks))
  trajectory = `runner fields: selected=${String(first.selectedIndex)} reason=${String(first.selectionReason)} rules=${(first.usableRuleIds ?? []).length} counterfactual=${JSON.stringify(first.counterfactualOnOwnPool)}`
}

console.log(`F0 学习装配离线门[${selected}]：${String(checks)} 项检查全部通过（零模型请求）。${trajectory}`)
