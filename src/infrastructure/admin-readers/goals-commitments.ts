/**
 * A1 / **WP2：`goals_commitments` 的真数据源 reader**（缺口：四个计数今天如实 `unavailable`）。
 *
 * ============================================================================
 *  它遵守的三条（`ADR-135` `D01`/`D07`）
 * ============================================================================
 * ```text
 * ① **复用既有读法**：只调 `goal-store.ts` 的 `listGoalStates(db, characterId)`（只读）
 *    —— 写侧（`applyGoalRows` / `rebuildGoalProjections` / `foldGoalRows`）**一律不碰**
 * ② **不重算**：不跑折叠、不推导状态；只把既有投影行的**既有状态**数出来
 * ③ **计数规则写在这里**（下方 `countGoalRows` 的注释），免得将来没人能核
 * ```
 *
 * ⚠️ 本文件**故意**放 `admin-readers/`（不是 `admin-ports/`）：
 *    `a1:query:verify` 的依赖边界判据禁止 `admin/**` 与 `admin-ports/**` import 持久层 ——
 *    端口只吃**注入的 reader**，真要读库的那一层单独一个目录，于是"页面不新建第二套真相"仍可判。
 */
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { isGoalTerminal, type GoalRowState } from '../../kernel/contracts/goal.ts'
import type { RawDb } from '../persistence/db.ts'
import { listGoalStates } from '../persistence/goal-store.ts'
import type { GoalsCommitmentsReader } from '../admin-ports/goals-commitments.ts'

/** 四个计数（与冻结清单的字段名逐字一致） */
export interface GoalCommitmentCounts {
  openGoals: number
  completedGoals: number
  openCommitments: number
  settledCommitments: number
}

/**
 * **计数规则**（`2026-10-14` 按既有枚举/判据核对后定死；改这里必须同时改本注释）：
 *
 * ```text
 * openGoals           = !isGoalTerminal(goal.status)                 ⇒ active | paused | blocked
 * completedGoals      = isGoalTerminal(goal.status)                  ⇒ completed | cancelled | superseded
 *   ⚠️ 字段名是 `completedGoals`，但按既有判据 `isGoalTerminal()` 它数的是"**已终结**"
 *      （含 cancelled / superseded）—— 这条命名差异是**故意的**：冻结清单的字段名不改，
 *      语义以 `isGoalTerminal` 为准。页面若想区分"真的完成"，那是**另一个**字段的事（要改清单）。
 * openCommitments     = commitment !== null && commitment.status === 'active'
 * settledCommitments  = commitment !== null && commitment.status !== 'active'
 *                       ⇒ fulfilled | broken | cancelled | superseded | expired
 *   ⚠️ `expired`（到期）与 `broken`（失约，需规则+证据）**不是**一回事（`ADR-086` `D07`）；
 *      这里只分"未结清 / 已结清"，**不**合并也不区分二者（区分需要新字段 ⇒ 改冻结清单）。
 * ```
 *
 * ⚠️ **纯函数**：只吃投影行，不碰数据库 ⇒ 门可以把它按 6×7 组合测全。
 */
export function countGoalRows(rows: readonly GoalRowState[]): GoalCommitmentCounts {
  let openGoals = 0
  let completedGoals = 0
  let openCommitments = 0
  let settledCommitments = 0
  for (const row of rows) {
    if (isGoalTerminal(row.goal.status)) completedGoals += 1
    else openGoals += 1
    if (row.commitment !== null) {
      if (row.commitment.status === 'active') openCommitments += 1
      else settledCommitments += 1
    }
  }
  return { openGoals, completedGoals, openCommitments, settledCommitments }
}

/**
 * 建 reader（**只读**）。
 *
 * ⚠️ `db` 由装配根注入：本模块**不**开库、不读环境、不碰生产库。
 * ⚠️ 抛错一律**向上抛**（由端口转成"如实 unavailable"）——**不**吞成 0（0 会被读成"她没有承诺"）。
 */
export function createGoalsCommitmentsReader(input: {
  readonly db: RawDb
  readonly characterId: CharacterId
}): GoalsCommitmentsReader {
  return {
    counts: async () => countGoalRows(await listGoalStates(input.db, input.characterId)),
  }
}
