/*
 * F2 受信准备读调度门（纯函数 · 零模型请求 · 零数据库）。
 *
 * 证明（用户裁定 A 的落实）：
 *  ① 第一次规划 ⇒ **程序生成**单步读**权威源**的计划，`requestCount = 0`（不产生模型请求）
 *  ② 已读过（本任务读过权威源且成功）⇒ **交回**后续规划器（不再自己出计划）
 *  ③ 读的路径一定是**权威源**（不是缓存源、不是标记）
 *  ④ 未成功（失败/没读）⇒ **仍然**出准备读计划（不把失败当已读）
 *  ⑤ 它**不预赠规则资格**：计划里只有一个读动作，没有任何写/否决/规则字段
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createF2PrepReadPlanner } from '../../src/infrastructure/runtime/simulation-planning.ts'
import type { TaskPlannerInput, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'

const OUT_DIR = resolve('artifacts/local/f2-prep-read')
const SOURCE = 'f1/a/obj-01.src'
const CACHE = 'f1/a/obj-01.cache'

const checks: Array<{ label: string, pass: boolean, detail: string }> = []
const check = (label: string, pass: boolean, detail = ''): void => {
  checks.push({ label, pass, detail })
  assert.ok(pass, `${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/*
 * ⚠️ **`executed` 行的真实格式**（2026-10-26 由**真实 ActionTurn 闭环门**查出）：
 *     `task-loop.ts` 拼的是 `${能力}.${操作} ${引用}=${状态}` ⇒ 沙箱读是
 *     **`sandbox.file.read.read path=<路径>=success`（两个点：能力 id 本身自带一个点）**。
 *     本门第一版用的是 `sandbox.file.read path=…=success`（**单点、缺操作**）—— 那种行
 *     **从不出现**在真实环里 ⇒ 门绿、真实链第一步之后就**认不出"已经读过"**（实测停在 no_progress）。
 *     ⇒ 现在夹具用**真实格式**，并加一条反例：假的单点行**不算**读过（失败关闭）。
 */
const readLine = (path: string, status = 'success'): string => `sandbox.file.read.read path=${path}=${status}`

const input = (executed: string[]): TaskPlannerInput => ({
  task: 'F2 任务', executed, failures: [], remainingActions: 8,
  allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'],
} as never)

const afterCalls: string[] = []
const after: TaskPlannerPort = {
  id: 'after@1', endpointHost: 'none',
  async plan () {
    afterCalls.push('after')
    return { ok: true as const, requestCount: 0, plan: { goal: 'after', done: false, steps: [] } }
  },
}
const planner = createF2PrepReadPlanner({ prepReadPath: SOURCE, after })

// ① 第一次 ⇒ 单步读权威源、零模型请求
const first = await planner.plan(input([]))
check('① 第一次规划 ⇒ 单步读**权威源**、requestCount=0（不产生模型请求）',
  first.ok === true && first.requestCount === 0 &&
  first.plan.steps.length === 1 &&
  first.plan.steps[0]!.capability === 'sandbox.file.read' && first.plan.steps[0]!.operation === 'read' &&
  (first.plan.steps[0]!.args as { path?: string }).path === SOURCE)
check('③ 读的路径是权威源（不是缓存源）',
  first.ok === true && (first.plan.steps[0]!.args as { path?: string }).path !== CACHE)
check('⑤ 计划里只有一个读动作：没有写、没有否决/规则字段（不预赠资格）',
  first.ok === true && first.plan.steps.length === 1 && first.plan.steps[0]!.operation === 'read' &&
  !('sourceScope' in first.plan) && !('veto' in first.plan))

// ④ 读**失败**（非 success）⇒ 仍然出准备读计划
const afterFail = await createF2PrepReadPlanner({ prepReadPath: SOURCE, after })
  .plan(input([readLine(SOURCE, 'target_not_found')]))
check('④ 读失败（非 success）⇒ 仍出准备读计划（不把失败当已读）',
  afterFail.ok === true && afterFail.plan.steps.length === 1 &&
  (afterFail.plan.steps[0]!.args as { path?: string }).path === SOURCE)

// ② 已成功读过 ⇒ 交回后续规划器
afterCalls.length = 0
const second = await planner.plan(input([readLine(SOURCE), 'sandbox.file.write.write path=f1/a/o.txt=success']))
check('② 已成功读过权威源 ⇒ 交回后续规划器（且不再自己出读计划）',
  second.ok === true && second.plan.goal === 'after' && afterCalls.length === 1 && second.plan.steps.length === 0)

// ②b **真实格式**才认：单点假行（上一版夹具的格式）**不算**读过（失败关闭）
const legacyFormat = await createF2PrepReadPlanner({ prepReadPath: SOURCE, after })
  .plan(input([`sandbox.file.read path=${SOURCE}=success`]))
check('②b 只有**真实** executed 格式才算读过（旧的单点夹具行 ⇒ 仍要准备读）',
  legacyFormat.ok === true && legacyFormat.plan.steps.length === 1 &&
  (legacyFormat.plan.steps[0]!.args as { path?: string }).path === SOURCE)

// ③b 缓存源读过不算"已读权威源"
const cachedOnly = await createF2PrepReadPlanner({ prepReadPath: SOURCE, after })
  .plan(input([readLine(CACHE)]))
check('③b 只读过**缓存源** ⇒ 仍需准备读（真值必须来自权威源）',
  cachedOnly.ok === true && cachedOnly.plan.steps.length === 1 &&
  (cachedOnly.plan.steps[0]!.args as { path?: string }).path === SOURCE)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(resolve(OUT_DIR, 'verification.json'), `${JSON.stringify({
  schema: 'f2-prep-read-gate@1',
  status: 'PASS',
  checks,
  boundaries: [
    '本门是**纯函数**门（零模型、零数据库、零文件系统）',
    '它证明准备读的**调度语义**；**不**证明它已接进真实 ActionTurn 闭环（那是本批剩余项）',
    '准备读占 1 动作 / 1 规划轮的预算扣减发生在任务环，不在此门内验证',
  ],
}, null, 2)}\n`, 'utf8')
console.log(`F2 受信准备读门：${String(checks.length)} 项检查全部通过（零模型请求）`)
for (const item of checks) console.log(`PASS ${item.label}${item.detail === '' ? '' : ` — ${item.detail}`}`)
