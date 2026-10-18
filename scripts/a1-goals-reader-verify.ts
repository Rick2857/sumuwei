/**
 * A1 / **WP2 reader 门（第一面）**：`goals_commitments` 的**计数映射**与只读边界。
 *
 * ============================================================================
 *  本门证什么、**不**证什么
 * ============================================================================
 * ```text
 * 证：① 计数映射按**既有判据**（`isGoalTerminal` + `commitment.status === 'active'`）逐组合成立
 *        —— 6 个目标状态 × 7 种承诺情形，**穷举**测
 *     ② `null` 与 0 **可分**：没有承诺的行**不**计入任何承诺计数（不会被算成"已结清 0 个"这种混淆）
 *     ③ 只读边界（结构）：reader 只 import `listGoalStates`；**不**出现写侧三函数
 *     ④ 边界（结构）：reader **不**在 `admin-ports/**`（端口目录不许 import 持久层）
 *     ⑤ 端口契约：把 reader 装进 `createGoalsCommitmentsPort` ⇒ 四个计数是真数、无 `unavailable`
 * 不证：**真库读数**（本门不碰数据库）—— 那要装配根注入真 `db` 之后另取读数（见交接单 §5/§7）
 * ```
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GoalRowState } from '../src/kernel/contracts/goal.ts'
import { GOAL_STATUSES, COMMITMENT_STATUSES } from '../src/kernel/contracts/goal.ts'
import { countGoalRows } from '../src/infrastructure/admin-readers/goals-commitments.ts'
import { createGoalsCommitmentsPort } from '../src/infrastructure/admin-ports/goals-commitments.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const READER = 'src/infrastructure/admin-readers/goals-commitments.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

/** 造一行（只有计数关心的两个字段；其余用最小占位） */
const row = (status: string, commitment: string | null): GoalRowState =>
  ({
    goal: { status } as GoalRowState['goal'],
    commitment: commitment === null ? null : ({ status: commitment } as GoalRowState['commitment']),
  })

// ---------------------------------------------------------------------------
// 1. 映射：6 个目标状态（承诺 null）—— 穷举
// ---------------------------------------------------------------------------

const terminal = ['completed', 'cancelled', 'superseded']
for (const status of GOAL_STATUSES) {
  const counts = countGoalRows([row(status, null)])
  const shouldBeTerminal = terminal.includes(status)
  check(`映射 goal=${status} ⇒ ${shouldBeTerminal ? 'completedGoals' : 'openGoals'}`,
    shouldBeTerminal ? counts.completedGoals === 1 && counts.openGoals === 0 : counts.openGoals === 1 && counts.completedGoals === 0,
    JSON.stringify(counts))
  check(`映射 goal=${status} 且无承诺 ⇒ 两个承诺计数都**不**动（null 不等于"已结清 0"）`,
    counts.openCommitments === 0 && counts.settledCommitments === 0, JSON.stringify(counts))
}

// ---------------------------------------------------------------------------
// 2. 映射：6 个承诺状态（目标固定 active）—— 穷举
// ---------------------------------------------------------------------------

for (const status of COMMITMENT_STATUSES) {
  const counts = countGoalRows([row('active', status)])
  check(`映射 commitment=${status} ⇒ ${status === 'active' ? 'openCommitments' : 'settledCommitments'}`,
    status === 'active' ? counts.openCommitments === 1 && counts.settledCommitments === 0 : counts.settledCommitments === 1 && counts.openCommitments === 0,
    JSON.stringify(counts))
}

check('映射 expired 与 broken **不合并**（都进 settled，但那是"已结清"这一格的两个成员，不是同义）',
  countGoalRows([row('active', 'expired')]).settledCommitments === 1 &&
  countGoalRows([row('active', 'broken')]).settledCommitments === 1, '两者都应 1')

// ---------------------------------------------------------------------------
// 3. 合计与空集
// ---------------------------------------------------------------------------

const mixed: GoalRowState[] = [
  row('active', null), row('active', 'active'), row('paused', 'fulfilled'),
  row('blocked', 'expired'), row('completed', 'active'), row('cancelled', 'broken'), row('superseded', null),
]
const totals = countGoalRows(mixed)
/* ⚠️ 逐个数清（第一版我手数成 3/4/2/3，门判红）：
   open = active(null) + active(active) + paused(fulfilled) + blocked(expired) = 4
   completed = completed + cancelled + superseded = 3
   openCommitments = active + active = 2 ；settled = fulfilled + expired + broken = 3 */
check('合计：openGoals=4 / completedGoals=3 / openCommitments=2 / settledCommitments=3',
  totals.openGoals === 4 && totals.completedGoals === 3 && totals.openCommitments === 2 && totals.settledCommitments === 3,
  JSON.stringify(totals))
check('空集 ⇒ 四个计数都是 0（**这是真 0**：读到了、确实没有）', JSON.stringify(countGoalRows([])) === JSON.stringify({ openGoals: 0, completedGoals: 0, openCommitments: 0, settledCommitments: 0 }), JSON.stringify(countGoalRows([])))

// ---------------------------------------------------------------------------
// 4. 只读边界 + 目录边界（结构判据）
// ---------------------------------------------------------------------------

const text = readFileSync(resolve(ROOT, READER), 'utf8')
/*
 * ⚠️ **先剥注释再找**（本仓库同型踩坑第四次，见 `L-QQP-09`）：
 *    第一版直接 `text.includes('applyGoalRows')` ⇒ 被**我自己的注释**（"写侧…一律不碰"）判红。
 *    判据只许落在**结构**上：这里只留 import 语句与代码行。
 */
const codeOnly = text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
check('只读：reader import 了既有只读入口 `listGoalStates`', /import \{ listGoalStates \}/.test(codeOnly), '应在')
for (const forbidden of ['applyGoalRows', 'rebuildGoalProjections', 'foldGoalRows']) {
  check(`只读：reader 的**代码**里不出现写侧/重算入口 \`${forbidden}\``, !codeOnly.includes(forbidden), `${forbidden} 不应出现在代码里`)
}
check('判据是活的（剥注释这一步真的生效）', codeOnly.length < text.length && !codeOnly.includes('一律不碰'), '剥注释后长度应更小')
check('不重算：reader **不** import 折叠模块（`projections/goal`）',
  !/from '[^']*projections\/goal\.ts'/.test(codeOnly), '不应 import')
check('边界：reader 不在 `admin-ports/**`（端口目录不许 import 持久层）',
  !READER.includes('admin-ports') && /from '\.\.\/persistence\/goal-store\.ts'/.test(codeOnly), '应在 admin-readers/ 且 import 持久层')

// ---------------------------------------------------------------------------
// 5. 端口契约：把 reader 装进去 ⇒ 真数、无 unavailable
// ---------------------------------------------------------------------------

const port = createGoalsCommitmentsPort({
  reader: { counts: async () => countGoalRows(mixed) },
  now: () => new Date('2026-10-14T00:00:00.000Z'),
})
const payload = await port()
check('契约：装上 reader ⇒ 四个计数是真数且**没有** `unavailable`',
  (payload.items[0] as Record<string, unknown>).openGoals === 4 && payload.unavailable === undefined,
  JSON.stringify(payload))
const bare = await createGoalsCommitmentsPort({})()
check('对照：**不装** reader ⇒ 四个 `null` + 具名 `unavailable`（两条路径必须可分）',
  (bare.items[0] as Record<string, unknown>).openGoals === null && (bare.unavailable ?? []).length === 4,
  JSON.stringify(bare))

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 goals_commitments reader：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 本门**不碰数据库**：真库读数要等装配根注入真 `db`（交接单 §5/§7）；今天真服务里该面仍是如实 `unavailable`。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
