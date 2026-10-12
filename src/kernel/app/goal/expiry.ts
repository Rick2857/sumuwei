/**
 * M10.1 WP3 —— **到期规划器**（纯函数；**确定性**、**不调模型**）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 * 给定（目标 + 承诺）的当前状态与**程序时钟**，找出"**截止时间已过、仍未结清**"的承诺，
 * 为每一条产出一个 `COMMITMENT_EXPIRED` 的提案 target。
 *
 * ⚠️ 三条硬边界（ADR-086 `D07`）：
 *   ① **到期 ≠ 失约**：载荷里**没有** reason / violationRuleId 之类字段 ——
 *      到期是"时间过去了"，不是"谁没做到"。要指控必须走 `COMMITMENT_BROKEN`
 *      （它要求可判定的规则 + 违反证据）。
 *   ② **截止时间在目标上**（实测：`CommitmentState` **没有** `dueAt`；截止时间只在
 *      `GoalState.time.dueAt`。M10 里目标与承诺 1:1 ⇒ "承诺到期" = 它所属目标的截止时间过去了）。
 *      没有截止时间 ⇒ **不产出**（不得凭空到期）。
 *   ③ **不读挂钟**：`now` 由调用方给（与 M10 的 `recordedAt` 同一条纪律）。
 * ```
 *
 * ⚠️ 纯函数：不 import SQL / 框架 / `node:*`，无副作用；同一输入两次 ⇒ 结果逐字段相同。
 */

import type { GoalRowState } from '../../contracts/goal.ts'
import type { ProposedDomainEvent } from '../../contracts/proposal.ts'

/** 一条被判定为"已到期"的承诺 */
export interface PlannedCommitmentExpiry {
  readonly goalId: string
  readonly commitmentId: string
  /** 已经过去的那个截止时间（= 目标的 `time.dueAt`） */
  readonly dueAt: number
  /** 承诺的当前 revision（乐观锁） */
  readonly expectedRevision: number
  /**
   * 这条到期事件应当引用的**对话来源**（= 该承诺的接受依据事件）。
   *
   * ⚠️ 为什么必须有：M10 的放行口要求**每个目标操作都引用对话来源**（否则 `goal_source_missing`）。
   *    到期虽然由**时钟**触发，但它**关于**那条承诺 ⇒ 引用"这条承诺当初是怎么被接受的"
   *    才是正确的出处（而不是"凭空到期"）。
   */
  readonly sourceEventIds: readonly string[]
  /** 提案 target（放行口会再校验一遍） */
  readonly target: ProposedDomainEvent
}

export interface PlanCommitmentExpiriesInput {
  readonly characterId: string
  /** 当前的（目标 + 承诺）状态；调用方从投影读出 */
  readonly rows: readonly GoalRowState[]
  /** **程序**时钟（本模块不读挂钟） */
  readonly now: number
}

/**
 * 规划到期。**顺序稳定**（按 `dueAt` 再按 `commitmentId`）—— 幂等与可复现都靠它。
 */
export function planCommitmentExpiries(
  input: PlanCommitmentExpiriesInput,
): readonly PlannedCommitmentExpiry[] {
  const planned: PlannedCommitmentExpiry[] = []

  for (const row of input.rows) {
    const commitment = row.commitment
    if (commitment === null) continue
    /* 只有**未结清**的承诺才谈得上到期（终态是幂等边界，不重复推进 revision） */
    if (commitment.status !== 'active') continue
    const dueAt = row.goal.time?.dueAt
    /* 没有截止时间 ⇒ 不产出（不得凭空到期） */
    if (dueAt === undefined) continue
    /* 截止时间**已过**（严格小于：正好等于 now 时不算过 —— 边界写清楚，别靠直觉） */
    if (!(dueAt < input.now)) continue

    planned.push({
      goalId: String(row.goal.goalId),
      commitmentId: String(commitment.commitmentId),
      dueAt,
      expectedRevision: commitment.revision,
      /* 出处 = 这条承诺的接受依据（放行口要求非空；空 ⇒ 放行口会拒，失败关闭） */
      sourceEventIds: commitment.acceptanceRefs.map((ref) => String(ref.conversationEventId)),
      target: {
        type: 'COMMITMENT_EXPIRED',
        operation: 'create',
        payload: {
          characterId: input.characterId,
          commitmentId: String(commitment.commitmentId),
          goalId: String(row.goal.goalId),
          expectedRevision: commitment.revision,
          expiredAt: input.now,
          dueAt,
          basis: 'due_at_passed',
        },
        scope: 'CHARACTER_INTERNAL',
      },
    })
  }

  return planned.sort((left, right) =>
    left.dueAt === right.dueAt
      ? left.commitmentId.localeCompare(right.commitmentId)
      : left.dueAt - right.dueAt,
  )
}

/**
 * 到期载荷的**字段闭集**（判据用）。
 *
 * ⚠️ 它存在的意义是**失败关闭**：以后若有人往这条事件里加 `reason` / `blame` 之类字段，
 *    `m10.1:expiry:verify` 会**当场变红** —— "到期不是指控"因此是可执行的约束，
 *    而不是一句注释。
 */
export const COMMITMENT_EXPIRED_PAYLOAD_KEYS: readonly string[] = [
  'characterId',
  'commitmentId',
  'goalId',
  'expectedRevision',
  'expiredAt',
  'dueAt',
  'basis',
]
