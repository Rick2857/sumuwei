/**
 * Goal Reducer —— 把 `GOAL_*` / `COMMITMENT_*` 事件折叠成目标投影行（M10 WP3 / ADR-076 §4.4）。
 *
 * ============================================================================
 *  与 belief 的**结构性差异**：一族多行，但**一个目标只有一行**
 * ============================================================================
 * 信念域是三种行（origin / belief / evidence）。本域只有**一种**行：
 *
 *     goal:<goalId>   → GoalRowState = { goal: GoalState, commitment: CommitmentState | null }
 *
 * **承诺住在目标行里**（ADR-076 `D03`）：一条 Goal 当前至多一个正式承诺，
 * 因此不需要第二条行、也不需要双表事务。但**事件历史仍然分开**：
 * `COMMITMENT_*` 与 `GOAL_*` 各自记，不许拿 `GOAL_COMPLETED` 推算
 * `COMMITMENT_FULFILLED`。
 *
 * ---------------------------------------------------------------------------
 *  折叠语义（放行口是业务规则，这里是**重放安全**的确定性折叠）
 * ---------------------------------------------------------------------------
 *   CREATED       建行；同 id 重放 = no-op（幂等，不覆盖）
 *   REVISED       仅非终态接受；改字段 + goal.revision + 1
 *   PAUSED        active → paused
 *   RESUMED       paused / blocked → active（清 preservedStatus / blockedReason）
 *   BLOCKED       active / paused → blocked（保留 preservedStatus）
 *   COMPLETED     非终态 → completed
 *   CANCELLED     非终态 → cancelled（记 cancelReason 与 forbiddenSourceEventIds）
 *   SUPERSEDED    本行 → superseded（终态）
 *   ACCEPTED      承诺建行（目标非终态时）
 *   FULFILLED     active 承诺 → fulfilled（终态）
 *   BROKEN        active 承诺 → broken（终态）
 *   CANCELLED     非终态承诺 → cancelled（终态）
 *   SUPERSEDED    本行承诺 → superseded（终态）
 *
 * 三条禁令照旧：不调 LLM、不读挂钟（时间一律 `event.createdAt`）、不写库。
 * 语义违规（非法边）在放行口已挡；折叠层对**孤儿事件**（引用不存在的 goalId）
 * 与**终态重放**按 no-op 处理 —— 重放可能从事件流中段开始，行存在性由 store
 * 编排保证，这里不炸。
 */

import type { DomainEvent } from '../contracts/index.ts'
import type { DomainEventId } from '../contracts/ids.ts'
import {
  COMMITMENT_ACCEPTED,
  COMMITMENT_BROKEN,
  COMMITMENT_CANCELLED,
  COMMITMENT_EXPIRED,
  COMMITMENT_FULFILLED,
  COMMITMENT_SUPERSEDED,
  GOAL_BLOCKED,
  GOAL_CANCELLED,
  GOAL_COMPLETED,
  GOAL_CREATED,
  GOAL_PAUSED,
  GOAL_REVISED,
  GOAL_RESUMED,
  GOAL_SUPERSEDED,
} from '../contracts/domain-event.ts'
import {
  goalRowKeyOf,
  isCommitmentTerminal,
  isGoalTerminal,
  type CommitmentAcceptedPayload,
  type CommitmentBrokenPayload,
  type CommitmentCancelledPayload,
  type CommitmentExpiredPayload,
  type CommitmentFulfilledPayload,
  type CommitmentState,
  type CommitmentSupersededPayload,
  type GoalBlockedPayload,
  type GoalCancelledPayload,
  type GoalCompletedPayload,
  type GoalCreatedPayload,
  type GoalPausedPayload,
  type GoalRevisedPayload,
  type GoalResumedPayload,
  type GoalRowState,
  type GoalState,
  type GoalSupersededPayload,
} from '../contracts/goal.ts'

/** 本 reducer 会处理的全部事件类型（13 个） */
export const GOAL_HANDLED_EVENT_TYPES: readonly string[] = [
  GOAL_CREATED,
  GOAL_REVISED,
  GOAL_PAUSED,
  GOAL_RESUMED,
  GOAL_BLOCKED,
  GOAL_COMPLETED,
  GOAL_CANCELLED,
  GOAL_SUPERSEDED,
  COMMITMENT_ACCEPTED,
  COMMITMENT_FULFILLED,
  COMMITMENT_BROKEN,
  COMMITMENT_CANCELLED,
  COMMITMENT_EXPIRED,
  COMMITMENT_SUPERSEDED,
]

/** 改折叠算法必须升版本（投影行的 reducer_version 拒绝跨版本追加） */
export const GOAL_REDUCER_VERSION = 'goal-fold@1'

/** 投影类型（`CharacterProjection.projectionType` 的前缀即族名） */
export const GOAL_PROJECTION_TYPE_PREFIX = 'goal:'

function payloadOf<T>(event: DomainEvent): T | undefined {
  return event.payload as T | undefined
}

/** 事件是否属于本 Character（形状不对按"不是我的"处理） */
export function goalEventTargets(event: DomainEvent, characterId: string): boolean {
  const payload = payloadOf<{ characterId?: string }>(event)
  if (payload === undefined) return false
  return String(payload.characterId) === String(characterId)
}

/**
 * 一个事件命中哪一行。
 *
 * ⚠️ **`GOAL_CREATED` 是例外**：它的 payload 把 id 嵌在 `goal.goalId` 里
 *    （首版完整快照的形状），其余 12 种事件都带**顶层** `goalId`。
 *    这条不对称在 WP3 的实现里被踩过一次 —— 症状是"建目标的事件折不出行"，
 *    而且**不报错**（`goalRowKeyFromEvent` 返回 undefined ⇒ 静默跳过）。
 *    因此这里显式分派，并且由门的 `R3` 检查"每个事件都命中一行"把它钉住。
 */
export function goalRowKeyFromEvent(event: DomainEvent): string | undefined {
  if (!(GOAL_HANDLED_EVENT_TYPES as readonly string[]).includes(event.type)) return undefined
  if (event.type === GOAL_CREATED) {
    const payload = payloadOf<GoalCreatedPayload>(event)
    const goalId = payload?.goal?.goalId
    if (goalId === undefined) return undefined
    return goalRowKeyOf(String(goalId))
  }
  const payload = payloadOf<{ goalId?: string }>(event)
  if (payload?.goalId === undefined) return undefined
  return goalRowKeyOf(payload.goalId)
}

// ---------------------------------------------------------------------------
// 纯折叠
// ---------------------------------------------------------------------------

/** 行不存在时不建行（孤儿事件 / 终态重放一律 no-op） */
function withGoal(
  state: GoalRowState | undefined,
  next: (goal: GoalState) => GoalState,
): GoalRowState | undefined {
  if (state === undefined) return undefined
  return { ...state, goal: next(state.goal) }
}

function withCommitment(
  state: GoalRowState | undefined,
  next: (commitment: CommitmentState) => CommitmentState,
): GoalRowState | undefined {
  if (state === undefined || state.commitment === null) return undefined
  return { ...state, commitment: next(state.commitment) }
}

/**
 * 单行折叠。`state === undefined` = 该目标尚无行（只有 CREATED / ACCEPTED
 * 里的 CREATED 能建行；其余对不存在的行 = no-op）。
 */
export function reduceGoalRow(
  state: GoalRowState | undefined,
  event: DomainEvent,
): GoalRowState | undefined {
  switch (event.type) {
    case GOAL_CREATED: {
      const payload = payloadOf<GoalCreatedPayload>(event)
      if (payload === undefined) return state
      // 同 id 重放 = no-op（幂等：不得覆盖已发生的后续转换）
      if (state !== undefined) return state
      return { goal: payload.goal, commitment: null }
    }

    case GOAL_REVISED: {
      const payload = payloadOf<GoalRevisedPayload>(event)
      if (payload === undefined) return state
      return withGoal(state, (goal) => {
        if (isGoalTerminal(goal.status)) return goal
        const next: GoalState = {
          ...goal,
          revision: goal.revision + 1,
          lastEventAt: event.createdAt,
        }
        if (payload.statement !== undefined) next.statement = payload.statement
        if (payload.priority !== undefined) next.priority = payload.priority
        if (payload.nextStep !== undefined) next.nextStep = payload.nextStep
        if (payload.dependencies !== undefined) next.dependencies = [...payload.dependencies]
        return next
      })
    }

    case GOAL_PAUSED: {
      const payload = payloadOf<GoalPausedPayload>(event)
      if (payload === undefined) return state
      return withGoal(state, (goal) => {
        if (goal.status !== 'active') return goal
        return { ...goal, status: 'paused', revision: goal.revision + 1, lastEventAt: event.createdAt }
      })
    }

    case GOAL_RESUMED: {
      const payload = payloadOf<GoalResumedPayload>(event)
      if (payload === undefined) return state
      return withGoal(state, (goal) => {
        if (goal.status !== 'paused' && goal.status !== 'blocked') return goal
        const next: GoalState = {
          ...goal,
          status: 'active',
          revision: goal.revision + 1,
          lastEventAt: event.createdAt,
        }
        delete next.preservedStatus
        delete next.blockedReason
        return next
      })
    }

    case GOAL_BLOCKED: {
      const payload = payloadOf<GoalBlockedPayload>(event)
      if (payload === undefined) return state
      return withGoal(state, (goal) => {
        if (goal.status !== 'active' && goal.status !== 'paused') return goal
        return {
          ...goal,
          status: 'blocked',
          preservedStatus: goal.status,
          blockedReason: payload.reasonCode,
          revision: goal.revision + 1,
          lastEventAt: event.createdAt,
        }
      })
    }

    case GOAL_COMPLETED: {
      const payload = payloadOf<GoalCompletedPayload>(event)
      if (payload === undefined) return state
      return withGoal(state, (goal) => {
        if (isGoalTerminal(goal.status)) return goal
        return {
          ...goal,
          status: 'completed',
          revision: goal.revision + 1,
          lastEventAt: event.createdAt,
        }
      })
    }

    case GOAL_CANCELLED: {
      const payload = payloadOf<GoalCancelledPayload>(event)
      if (payload === undefined) return state
      return withGoal(state, (goal) => {
        if (isGoalTerminal(goal.status)) return goal
        const next: GoalState = {
          ...goal,
          status: 'cancelled',
          cancelReason: payload.reason,
          revision: goal.revision + 1,
          lastEventAt: event.createdAt,
        }
        /*
         * ⚠️ 这里**不**顺带取消承诺：`GOAL_CANCELLED` 与 `COMMITMENT_CANCELLED`
         * 是**两条**事件，各记各的（审计要能分别回答"目标为什么结束"与
         * "承诺为什么结束"）。"必须在同一提案里同时产生两条"是**放行口**的
         * 判据（见 `commitmentNeedsCancellation`）——折叠层不替它做决定。
         */
        if (payload.forbiddenSourceEventIds !== undefined) {
          next.forbiddenSourceEventIds = [...payload.forbiddenSourceEventIds]
        }
        return next
      })
    }

    case GOAL_SUPERSEDED: {
      const payload = payloadOf<GoalSupersededPayload>(event)
      if (payload === undefined) return state
      return withGoal(state, (goal) => {
        if (isGoalTerminal(goal.status)) return goal
        return {
          ...goal,
          status: 'superseded',
          revision: goal.revision + 1,
          lastEventAt: event.createdAt,
        }
      })
    }

    case COMMITMENT_ACCEPTED: {
      const payload = payloadOf<CommitmentAcceptedPayload>(event)
      if (payload === undefined) return state
      if (state === undefined) return state
      // 终态目标不接受新承诺（放行口已挡；折叠层重放安全）
      if (isGoalTerminal(state.goal.status)) return state
      return { ...state, commitment: payload.commitment }
    }

    case COMMITMENT_FULFILLED: {
      const payload = payloadOf<CommitmentFulfilledPayload>(event)
      if (payload === undefined) return state
      return withCommitment(state, (commitment) => {
        if (commitment.status !== 'active') return commitment
        return {
          ...commitment,
          status: 'fulfilled',
          completionRefs: [...payload.resultRefs],
          completionBasis: payload.basis,
          revision: commitment.revision + 1,
          lastEventAt: event.createdAt,
        }
      })
    }

    case COMMITMENT_BROKEN: {
      const payload = payloadOf<CommitmentBrokenPayload>(event)
      if (payload === undefined) return state
      return withCommitment(state, (commitment) => {
        if (commitment.status !== 'active') return commitment
        return {
          ...commitment,
          status: 'broken',
          completionRefs: [...payload.violationRefs],
          violationRuleId: payload.ruleId,
          revision: commitment.revision + 1,
          lastEventAt: event.createdAt,
        }
      })
    }

    case COMMITMENT_CANCELLED: {
      const payload = payloadOf<CommitmentCancelledPayload>(event)
      if (payload === undefined) return state
      return withCommitment(state, (commitment) => {
        if (isCommitmentTerminal(commitment.status)) return commitment
        return {
          ...commitment,
          status: 'cancelled',
          revision: commitment.revision + 1,
          lastEventAt: event.createdAt,
        }
      })
    }

    case COMMITMENT_SUPERSEDED: {
      const payload = payloadOf<CommitmentSupersededPayload>(event)
      if (payload === undefined) return state
      return withCommitment(state, (commitment) => {
        if (String(commitment.commitmentId) !== String(payload.commitmentId)) return commitment
        if (isCommitmentTerminal(commitment.status)) return commitment
        return {
          ...commitment,
          status: 'superseded',
          revision: commitment.revision + 1,
          lastEventAt: event.createdAt,
        }
      })
    }

    /*
     * ⚠️ **M10.1 追加**（ADR-086 `D07`）：到期 ⇒ 终态 `expired`。
     *    · 与 `cancelled`/`superseded` 同构（都只改状态与 revision，**不改** `scope`/`criterion`）
     *      —— 到期**不抹掉**"她曾经承担过什么"；
     *    · 已是终态 ⇒ 幂等返回（不重复推进 revision）；
     *    · ⚠️ **不写**任何"失约"字段：到期是时间事实（要指控走 `COMMITMENT_BROKEN`）。
     */
    case COMMITMENT_EXPIRED: {
      const payload = payloadOf<CommitmentExpiredPayload>(event)
      if (payload === undefined) return state
      return withCommitment(state, (commitment) => {
        if (String(commitment.commitmentId) !== String(payload.commitmentId)) return commitment
        if (isCommitmentTerminal(commitment.status)) return commitment
        return {
          ...commitment,
          status: 'expired',
          revision: commitment.revision + 1,
          lastEventAt: event.createdAt,
        }
      })
    }

    default:
      return state
  }
}

/**
 * 目标被取消时，其 active 承诺是否应**同步取消**。
 *
 * 折叠层不直接做这件事（`GOAL_CANCELLED` 与 `COMMITMENT_CANCELLED` 是**两条**
 * 事件，各记各的）；这个谓词给**放行口**用：它必须在同一个提案里同时产生两条
 * 事件，否则就是"已取消目标仍被履行"的孤儿约定（`G13`）。
 */
export function commitmentNeedsCancellation(commitment: CommitmentState | null): boolean {
  return commitment !== null && commitment.status === 'active'
}

// ---------------------------------------------------------------------------
// 纯内存折叠（**唯一**的折叠循环；store 与门/重放对账共用它）
// ---------------------------------------------------------------------------

/** 折叠缓存的一行（`revision` / `lastDomainEvent*` 是**行级**元数据） */
export interface GoalFoldEntry {
  projectionType: string
  revision: number
  state: GoalRowState
  lastDomainEventId?: DomainEventId
  lastDomainEventSequence?: number
  changed: boolean
}

/**
 * 把一批事件折叠进缓存（纯内存、确定性）。
 *
 * ⚠️ 这是**唯一**的折叠循环：`infrastructure/persistence/goal-store.ts` 的
 *    apply / rebuild 与门里的重放对账都调它。两处各写一份循环就等于给
 *    "apply 与 rebuild 走同一条路径"这句承诺留了一个可以漂移的复制品。
 */
export function foldGoalRowsInMemory(
  cache: Map<string, GoalFoldEntry>,
  events: readonly DomainEvent[],
): void {
  for (const event of events) {
    const key = goalRowKeyFromEvent(event)
    if (key === undefined) continue
    const entry = cache.get(key)
    /*
     * ==========================================================================
     *  ⚠️ 幂等闸（`F-WP5-10`，2026-10-13）—— 这条事件**已经折过**就跳过
     * ==========================================================================
     *  判据：`event.sequence <= 该行已折到的序号`。
     *
     *  没有这道闸时：把**全部历史**喂给增量折叠，会让每个历史事件**每次提交**都被重折一次
     *  ⇒ `entry.revision += 1` 每次都加 ⇒ `revision` 变成"**提交次数**的函数"而不是
     *  "**事件数**的函数"。实测（源快照，19 行里 18 行）：存的 52 / 全量重放只有 4，
     *  Δ合计 563。
     *
     *  ⚠️ **与 `applyMemoryEvent` 的既有闸同源**：那边按 `(memory_id, domain_event_id)`
     *     判"已经折叠过 ⇒ 不重复 reduce（否则 revision 会叠加，而 Replay 会算不出来）"。
     *     目标域缺的就是这一条 —— 补上它，两个域的折叠语义才一致。
     *
     *  ⚠️ **为什么修在这里，而不是只修调用方**：
     *     `agreement-runner` 的 `already_applied` 那一支（`eventsWritten: 0`）是**修复/追赶**路径
     *     —— 它的全部意义就是"事件已落库但投影可能落后 ⇒ 再折一遍追上去"。
     *     若把调用方改成"只喂这一批"，那一支的折叠输入会变成**空集** ⇒ **追赶能力消失**
     *     （崩在"事件已写、投影未写"之间就再也补不回来）。
     *     ⇒ 修在闸上：**喂全部历史仍然安全**，追赶保留，膨胀消失。
     *
     *  ⚠️ 两条路径不受影响：重建（cache 从空开始 ⇒ `entry === undefined`）与
     *     `replayGoalRows`（同样是空 cache）。
     */
    if (
      entry !== undefined &&
      entry.lastDomainEventSequence !== undefined &&
      event.sequence <= entry.lastDomainEventSequence
    ) {
      continue
    }
    const next = reduceGoalRow(entry?.state, event)
    if (next === undefined) continue
    if (entry === undefined) {
      cache.set(key, {
        projectionType: key,
        revision: 1,
        state: next,
        lastDomainEventId: event.id,
        lastDomainEventSequence: event.sequence,
        changed: true,
      })
    } else {
      entry.state = next
      entry.revision += 1
      entry.lastDomainEventId = event.id
      entry.lastDomainEventSequence = event.sequence
      entry.changed = true
    }
  }
}

/** 纯重放：事件序列 → `行键 → 行状态`（不碰 SQL；门与对账用） */
export function replayGoalRows(events: readonly DomainEvent[]): Map<string, GoalRowState> {
  const cache = new Map<string, GoalFoldEntry>()
  foldGoalRowsInMemory(cache, events)
  const out = new Map<string, GoalRowState>()
  for (const [key, entry] of cache) out.set(key, entry.state)
  return out
}
