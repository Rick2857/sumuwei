/**
 * M10 —— Goal 折叠的**独立 oracle**（`U-14` 的落成）。
 *
 * ============================================================================
 *  它为什么存在
 * ============================================================================
 * `src/kernel/projections/goal.ts` 的 `foldGoalRowsInMemory` 是**铁律 ②**的核心：
 * "投影是派生的"这句话的全部重量都压在它上面。而它到今天为止只被
 * **手写预期**（`m10:test` 的 L/X/R 三组谓词）复核过 —— 那些谓词与 reducer
 * **出自同一支笔**，于是"作者把规格读错了"这类错误在两边同时出现。
 *
 * 本文件是**第二份实现**，刻意采用**不同的形状**：
 *
 * ```text
 * 被测（reducer）  命令式：switch 事件类型 → 就地改行；终态判断散在每个 case 里
 * 本 oracle        声明式：一张 (状态 × 事件) → 目标状态的**转移表** +
 *                          每行**从头重放**；"能不能转"由表回答，不由 if 回答
 * ```
 *
 * ---------------------------------------------------------------------------
 *  它**能**抓什么、**不能**抓什么（这条必须写在最前面）
 * ---------------------------------------------------------------------------
 * ```text
 * 能   实现层面的滑落：某条边少加了 revision、终态判断漏了一个状态、
 *      字段效果写错、某些事件在某个状态下被静默接受
 * 不能 **规格层面的误读** —— 我也写了 reducer，所以两处会把同一句话读错
 *      ⇒ 它的证据强度**低于**"第二个人独立实现"，登记为 `L-M10-52`
 * ```
 * ⚠️ 因此它**不**替代 `m10:test` 的手写预期，而是**与之并列**：
 *    手写预期钉住"这一条边该去哪个状态"，oracle 钉住"**所有**组合都被决定了"。
 *
 * ⚠️ 纯函数 + 纯数据：不 import SQL / 框架 / `node:*`。
 */

import {
  COMMITMENT_STATUSES,
  GOAL_STATUSES,
  isCommitmentTerminal,
  isGoalTerminal,
  type CommitmentState,
  type GoalRowState,
  type GoalState,
} from '../../src/kernel/contracts/goal.ts'
import {
  COMMITMENT_ACCEPTED,
  COMMITMENT_BROKEN,
  COMMITMENT_CANCELLED,
  COMMITMENT_FULFILLED,
  COMMITMENT_SUPERSEDED,
  GOAL_BLOCKED,
  GOAL_CANCELLED,
  GOAL_COMPLETED,
  GOAL_CREATED,
  GOAL_PAUSED,
  GOAL_RESUMED,
  GOAL_REVISED,
  GOAL_SUPERSEDED,
} from '../../src/kernel/contracts/domain-event.ts'
import type { DomainEvent } from '../../src/kernel/contracts/index.ts'

// ---------------------------------------------------------------------------
// 转移表（**从契约写**，不是从 reducer 抄）
// ---------------------------------------------------------------------------

/** 目标状态的**合法后继**：`null` = 该事件在这个状态下是 **no-op**（按规格） */
export type GoalTransition = GoalState['status'] | null

/**
 * `(当前状态, 事件类型) → 目标状态` 的**全表**。
 *
 * ⚠️ "全表"是判据的一部分：**每一个组合都必须有一个条目**（哪怕值是 `null`）。
 *    `null` 表示"按规格这是 no-op"，而**缺条目**表示"没人决定过" ——
 *    两者的区别正是本表存在的理由（缺条目时 reducer 的 `default` 或某个 `if`
 *    会替规格做决定，而那是个隐性判断）。
 */
export const GOAL_TRANSITION_TABLE: Readonly<Record<string, Readonly<Record<string, GoalTransition>>>> = {
  active: {
    [GOAL_PAUSED]: 'paused',
    [GOAL_BLOCKED]: 'blocked',
    [GOAL_RESUMED]: null, // 已经 active，恢复是 no-op
    [GOAL_REVISED]: 'active',
    [GOAL_COMPLETED]: 'completed',
    [GOAL_CANCELLED]: 'cancelled',
    [GOAL_SUPERSEDED]: 'superseded',
  },
  paused: {
    [GOAL_PAUSED]: null, // 已经 paused
    [GOAL_BLOCKED]: 'blocked',
    [GOAL_RESUMED]: 'active',
    [GOAL_REVISED]: 'paused',
    [GOAL_COMPLETED]: 'completed',
    [GOAL_CANCELLED]: 'cancelled',
    [GOAL_SUPERSEDED]: 'superseded',
  },
  blocked: {
    [GOAL_PAUSED]: null, // 受阻不是"暂停"；要改状态得先恢复（转移表只认显式边）
    [GOAL_BLOCKED]: null,
    [GOAL_RESUMED]: 'active',
    [GOAL_REVISED]: 'blocked',
    [GOAL_COMPLETED]: 'completed',
    [GOAL_CANCELLED]: 'cancelled',
    [GOAL_SUPERSEDED]: 'superseded',
  },
  completed: {},
  cancelled: {},
  superseded: {},
}

/** 承诺状态的合法后继（`null` = no-op） */
export const COMMITMENT_TRANSITION_TABLE: Readonly<
  Record<string, Readonly<Record<string, CommitmentState['status'] | null>>>
> = {
  active: {
    [COMMITMENT_FULFILLED]: 'fulfilled',
    [COMMITMENT_BROKEN]: 'broken',
    [COMMITMENT_CANCELLED]: 'cancelled',
    [COMMITMENT_SUPERSEDED]: 'superseded',
    [COMMITMENT_ACCEPTED]: null, // 已经有承诺了，重放 no-op
  },
  fulfilled: {},
  broken: {},
  cancelled: {},
  superseded: {},
}

/** 终态应当**没有**出边（表里是空对象）—— 这条本身就是判据 */
export const TERMINAL_GOAL_STATUSES_IN_TABLE = GOAL_STATUSES.filter((status) =>
  isGoalTerminal(status),
)
export const TERMINAL_COMMITMENT_STATUSES_IN_TABLE = COMMITMENT_STATUSES.filter((status) =>
  isCommitmentTerminal(status),
)

/** 表里某一格的值（`undefined` = **缺条目**，那是缺陷不是 no-op） */
export function goalTransitionOf(status: string, eventType: string): GoalTransition | undefined {
  return GOAL_TRANSITION_TABLE[status]?.[eventType]
}

export function commitmentTransitionOf(
  status: string,
  eventType: string,
): CommitmentState['status'] | null | undefined {
  return COMMITMENT_TRANSITION_TABLE[status]?.[eventType]
}

/** 表是否**全**：每个状态 × 每个"作用于目标"的事件都有条目 */
export function goalTableGaps(): string[] {
  const goalEvents = [
    GOAL_PAUSED,
    GOAL_BLOCKED,
    GOAL_RESUMED,
    GOAL_REVISED,
    GOAL_COMPLETED,
    GOAL_CANCELLED,
    GOAL_SUPERSEDED,
  ]
  const gaps: string[] = []
  for (const status of GOAL_STATUSES) {
    for (const eventType of goalEvents) {
      /* 终态按规格**没有**出边 ⇒ 空对象是"全"的（每一条都是"不该发生"） */
      if (isGoalTerminal(status)) continue
      if (goalTransitionOf(status, eventType) === undefined) gaps.push(`${status}×${eventType}`)
    }
  }
  return gaps
}

export function commitmentTableGaps(): string[] {
  const commitmentEvents = [
    COMMITMENT_FULFILLED,
    COMMITMENT_BROKEN,
    COMMITMENT_CANCELLED,
    COMMITMENT_SUPERSEDED,
    COMMITMENT_ACCEPTED,
  ]
  const gaps: string[] = []
  for (const status of COMMITMENT_STATUSES) {
    for (const eventType of commitmentEvents) {
      if (isCommitmentTerminal(status)) continue
      if (commitmentTransitionOf(status, eventType) === undefined) gaps.push(`${status}×${eventType}`)
    }
  }
  return gaps
}

// ---------------------------------------------------------------------------
// oracle 的行键（**独立**推导，不复用 `goalRowKeyFromEvent`）
// ---------------------------------------------------------------------------

/**
 * 从事件推导行键 —— **独立**实现。
 *
 * ⚠️ 刻意**不**调 `goalRowKeyFromEvent`：那会把"被测对象"变成"判据的一部分"。
 *    （WP3 真实踩过的缺陷就在这里：`GOAL_CREATED` 的 id 嵌在 `payload.goal.goalId`，
 *    而其余事件带顶层 `goalId`。若 oracle 复用它，那个不对称就永远测不出来。）
 */
export function oracleRowKey(event: DomainEvent): string | undefined {
  const payload = event.payload as Record<string, unknown> | undefined
  if (payload === undefined) return undefined
  if (event.type === GOAL_CREATED) {
    const goal = payload.goal as { goalId?: unknown } | undefined
    const id = goal?.goalId
    return typeof id === 'string' ? `goal:${id}` : undefined
  }
  const id = payload.goalId
  return typeof id === 'string' ? `goal:${id}` : undefined
}

// ---------------------------------------------------------------------------
// oracle 的单行重放（声明式：查表 → 应用字段效果）
// ---------------------------------------------------------------------------

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
/**
 * 把一条事件作用到一行上（**纯函数**）。`undefined` = 这一行还不存在且
 * 这条事件建不了行（no-op）。
 */
export function oracleApplyEvent(
  state: GoalRowState | undefined,
  event: DomainEvent,
): GoalRowState | undefined {
  const payload = (event.payload ?? {}) as Record<string, unknown>

  /* --- 建行：只有 GOAL_CREATED 能建；已存在 ⇒ no-op（幂等） --- */
  if (event.type === GOAL_CREATED) {
    if (state !== undefined) return state
    const goal = payload.goal as GoalState | undefined
    if (goal === undefined) return state
    return { goal, commitment: null }
  }

  /*
   * --- 其余**目标**事件：行不存在 ⇒ no-op；查表决定去哪个状态 ---
   *
   * ⚠️ 分派判据是 `GOAL_` **前缀**，不是 `GOAL_HANDLED_EVENT_TYPES`。
   *    那条封闭集里**既有**目标事件**也有**承诺事件（它是"折叠层认哪些事件"），
   *    所以拿它当"这是不是目标事件"用会让**承诺事件走进目标分支** ⇒
   *    `goalTransitionOf` 查不到 ⇒ 静默 no-op ⇒ 承诺永远停在 `active`。
   *
   *    这是本 oracle 的**第一版真实缺陷**，而且正是 O1（与 reducer 的等价对照）
   *    抓出来的 —— 一份形状不同的第二实现，最大的价值就是先抓**自己**。
   */
  if (typeof event.type === 'string' && event.type.startsWith('GOAL_')) {
    if (state === undefined) return state
    const goal = state.goal
    const target = goalTransitionOf(goal.status, event.type)
    if (target === undefined) return state // 缺条目 ⇒ oracle 不猜（由 O2 报缺口）
    if (target === null) return state // 按规格 no-op ⇒ **revision 不动**

    const next: GoalState = {
      ...goal,
      status: target,
      revision: goal.revision + 1,
      lastEventAt: event.createdAt,
    }
    if (event.type === GOAL_REVISED) {
      if (payload.statement !== undefined) next.statement = payload.statement as string
      if (payload.priority !== undefined) next.priority = payload.priority as GoalState['priority']
      if (payload.nextStep !== undefined) next.nextStep = payload.nextStep as string
      if (payload.dependencies !== undefined) {
        next.dependencies = [...(payload.dependencies as GoalState['dependencies'])]
      }
    }
    if (event.type === GOAL_BLOCKED) {
      next.preservedStatus = goal.status
      next.blockedReason = payload.reasonCode as GoalState['blockedReason']
    }
    if (event.type === GOAL_RESUMED) {
      delete next.preservedStatus
      delete next.blockedReason
    }
    if (event.type === GOAL_CANCELLED) {
      next.cancelReason = payload.reason as GoalState['cancelReason']
      if (payload.forbiddenSourceEventIds !== undefined) {
        next.forbiddenSourceEventIds = [...(payload.forbiddenSourceEventIds as string[])]
      }
    }
    return { ...state, goal: next }
  }

  /* --- 承诺事件 --- */
  if (event.type === COMMITMENT_ACCEPTED) {
    if (state === undefined) return state
    /* 终态目标不接受新承诺（表里终态无出边） */
    if (isGoalTerminal(state.goal.status)) return state
    const commitment = payload.commitment as CommitmentState | undefined
    if (commitment === undefined) return state
    return { ...state, commitment }
  }

  if (state === undefined || state.commitment === null) return state
  const commitment = state.commitment
  const target = commitmentTransitionOf(commitment.status, event.type)
  if (target === undefined) return state
  if (target === null) return state

  /*
   * `COMMITMENT_SUPERSEDED` 多一道 id 匹配（它要说明"被谁替代"）——
   * 从契约的 payload 读，不从 reducer 抄。
   */
  if (event.type === COMMITMENT_SUPERSEDED) {
    const expectedId = payload.commitmentId
    if (typeof expectedId === 'string' && expectedId !== String(commitment.commitmentId)) {
      return state
    }
  }

  const nextCommitment: CommitmentState = {
    ...commitment,
    status: target,
    revision: commitment.revision + 1,
    lastEventAt: event.createdAt,
  }
  if (event.type === COMMITMENT_FULFILLED) {
    nextCommitment.completionRefs = [...((payload.resultRefs ?? []) as CommitmentState['completionRefs'])]
    nextCommitment.completionBasis = payload.basis as CommitmentState['completionBasis']
  }
  if (event.type === COMMITMENT_BROKEN) {
    nextCommitment.completionRefs = [
      ...((payload.violationRefs ?? []) as CommitmentState['completionRefs']),
    ]
    nextCommitment.violationRuleId = payload.ruleId as string
  }
  void num
  return { ...state, commitment: nextCommitment }
}

/** 把一串事件折成 `行键 → 行`（**每行从头重放**，与 reducer 的增量折叠形状不同） */
export function oracleFold(events: readonly DomainEvent[]): Map<string, GoalRowState> {
  const byRow = new Map<string, DomainEvent[]>()
  for (const event of events) {
    const key = oracleRowKey(event)
    if (key === undefined) continue
    const bucket = byRow.get(key) ?? []
    bucket.push(event)
    byRow.set(key, bucket)
  }
  const out = new Map<string, GoalRowState>()
  for (const [key, bucket] of byRow) {
    let state: GoalRowState | undefined
    for (const event of bucket) state = oracleApplyEvent(state, event)
    if (state !== undefined) out.set(key, state)
  }
  return out
}

