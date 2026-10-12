/**
 * M10.1 WP2 —— **约定 → 目标提案**（构造器；纯函数）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 * 把 WP1 已经**校验通过**的 `AcceptedAgreement`（双方合意、出处可解析）变成
 * **M10 形状的提案草案**（`GoalProposalDraft`）：
 *   · `operation = 'create'`，`statement` = 约定内容；
 *   · `origin` 按**谁提出**映射：她提出 ⇒ `character_proposed`（并带 `proposedByAssistantEventId`
 *     + `proposalSpan`）；用户提出 ⇒ `user_requested`；
 *   · `commitment` = 随目标一并接受的承诺（`scope` = 判据文本 · `acceptanceEventIds` = 两条引用）。
 * ```
 *
 * ============================================================================
 *  ⚠️ 一条**硬边界**（这条决定了 R-26 那类约定现在能不能被记下来）
 * ============================================================================
 * ```text
 * v1 的承诺**只正式接受两类可观察判据**（`goal-validator.ts` 的 `COMMITMENT_ACCEPTABLE_CRITERIA`）：
 *     `conversation_output` / `action_result` —— 都是**程序能观测**的东西。
 * 而"明天十点二十五楼下见"这种约定的判据是"**他到没到**"，只能靠**用户报告**
 *     ⇒ 它**不在**闭集内 ⇒ 本构造器**拒绝**（具名理由 `criterion_not_representable`），
 *        **不**伪造一个"看起来能观测"的判据。
 * ⇒ 换句话说：**(A) 让"承诺"这条路通了，但 R-26 那类约定还需要一次判据闭集的裁定**
 *    （见 `docs/m10.1/M10.1-WP2-Finding.md` 与 ADR-086 §0.4）。
 * ```
 *
 * ⚠️ 纯编排：不 import SQL / 框架 / `node:*`，不读时钟（`now` 由调用方给），无副作用。
 */

import {
  GOAL_COMMITMENT_DRAFT_MAX_ACCEPTANCE_REFS,
  type GoalProposalDraft,
} from '../../contracts/goal-proposal.ts'
import {
  COMMITMENT_SCOPE_MAX_CODEPOINTS,
  GOAL_STATEMENT_MAX_CODEPOINTS,
} from '../../contracts/goal.ts'
import { codepointLength, type AcceptedAgreement } from '../../contracts/agreement-input.ts'
import type { GoalPriority, GoalSuccessCriterion } from '../../contracts/goal.ts'
import { COMMITMENT_ACCEPTABLE_CRITERIA } from '../../policies/goal-validator.ts'

/**
 * **正式接受**的承诺判据 —— **直接从放行口的闭集派生**（单一来源，不留第二份清单）。
 *
 * ⚠️ 2026-10-02 按用户裁定 `(U-03-a)`：闭集里加入 **`user_report`** ⇒ "双方约定"那类
 *    （判据是"他到没到"、只能由**对方报告**结清）现在**可以**成为承诺。
 *    语义与边界见 [`ADR-076`](../../../docs/adr/ADR-076-m10-goals-and-commitments.md) 的修订节。
 */
export const AGREEMENT_REPRESENTABLE_CRITERION_KINDS: readonly GoalSuccessCriterion['kind'][] =
  COMMITMENT_ACCEPTABLE_CRITERIA as readonly GoalSuccessCriterion['kind'][]

/** 具名拒绝理由（闭集） */
export const AGREEMENT_PROPOSAL_REJECT_REASONS = [
  'statement_too_long',
  'scope_too_long',
  'too_many_acceptance_refs',
  'criterion_not_representable',
  'missing_span',
] as const
export type AgreementProposalRejectReason = (typeof AGREEMENT_PROPOSAL_REJECT_REASONS)[number]

export interface BuildAgreementProposalInput {
  readonly agreement: AcceptedAgreement
  readonly characterId: string
  /** 本操作依据的原话范围（调用方从**接受那条**对话事件切出来） */
  readonly span: { readonly start: number; readonly end: number }
  /** 提议侧的原话范围；生产窗口按提议原文计算。 */
  readonly proposalSpan?: { readonly start: number; readonly end: number }
  readonly proposalId: string
  readonly processor: string
  readonly processorVersion: string
  readonly now: number
  /**
   * **程序可观察**的判据。
   *
   * ⚠️ 调用方**必须**给（它需要知道"这条约定用什么可观测的东西结清"）；
   *    它**不是**从约定正文里猜出来的 —— 猜就是把"看起来能观测"当成事实。
   */
  readonly criterion?: GoalSuccessCriterion
  readonly priority?: GoalPriority
}

export type BuildAgreementProposalResult =
  | { readonly ok: true; readonly draft: GoalProposalDraft }
  | { readonly ok: false; readonly reason: AgreementProposalRejectReason; readonly detail: string }

export function buildAgreementProposal(input: BuildAgreementProposalInput): BuildAgreementProposalResult {
  const { agreement } = input

  if (codepointLength(agreement.content) > GOAL_STATEMENT_MAX_CODEPOINTS) {
    return {
      ok: false,
      reason: 'statement_too_long',
      detail: `约定内容 ${String(codepointLength(agreement.content))} 码点 > 目标描述上界 ${String(GOAL_STATEMENT_MAX_CODEPOINTS)}`,
    }
  }
  if (codepointLength(agreement.criterion) > COMMITMENT_SCOPE_MAX_CODEPOINTS) {
    return {
      ok: false,
      reason: 'scope_too_long',
      detail: `判据文本 ${String(codepointLength(agreement.criterion))} 码点 > 承诺范围上界 ${String(COMMITMENT_SCOPE_MAX_CODEPOINTS)}`,
    }
  }
  const acceptanceIds = [agreement.proposedByEventId, agreement.acceptedByEventId]
  if (acceptanceIds.length > GOAL_COMMITMENT_DRAFT_MAX_ACCEPTANCE_REFS) {
    return {
      ok: false,
      reason: 'too_many_acceptance_refs',
      detail: `接受引用 ${String(acceptanceIds.length)} 条 > 上界 ${String(GOAL_COMMITMENT_DRAFT_MAX_ACCEPTANCE_REFS)}`,
    }
  }
  if (
    input.span.start < 0 ||
    input.span.end <= input.span.start
  ) {
    return { ok: false, reason: 'missing_span', detail: '缺少有效的原话范围（`span`）' }
  }
  if (input.criterion === undefined) {
    return {
      ok: false,
      reason: 'criterion_not_representable',
      detail:
        '调用方没有给出**程序可观察**的判据 —— 不猜（"他到没到"这种只能靠用户报告的判据' +
        '不在 v1 承诺闭集内，见 ADR-086 §0.4）',
    }
  }
  if (!AGREEMENT_REPRESENTABLE_CRITERION_KINDS.includes(input.criterion.kind)) {
    return {
      ok: false,
      reason: 'criterion_not_representable',
      detail:
        `判据 ${input.criterion.kind} 不在 v1 正式接受的闭集内` +
        `（只接受 ${AGREEMENT_REPRESENTABLE_CRITERION_KINDS.join(' / ')}）`,
    }
  }

  /*
   * `origin` 按**谁提出**映射：
   *   · 她提出 + 用户接受 ⇒ `character_proposed`（放行口要求带 `proposedByAssistantEventId`，
   *     并据此判"提议确实来自已落库的 assistant 事件"）；
   *   · 用户提出 + 她接受 ⇒ `user_requested`。
   */
  const characterProposed = agreement.proposedBy === 'character'
  const draft: GoalProposalDraft = {
    schemaVersion: 'goal-proposal@1',
    operation: 'create',
    span: { start: input.span.start, end: input.span.end },
    statement: agreement.content,
    origin: characterProposed ? 'character_proposed' : 'user_requested',
    ...(characterProposed
      ? {
          proposedByAssistantEventId: agreement.proposedByEventId,
          proposalSpan: { ...(input.proposalSpan ?? input.span) },
        }
      : {}),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    commitment: {
      scope: agreement.criterion,
      criterion: input.criterion,
      acceptanceEventIds: acceptanceIds,
      /*
       * ⚠️ **不带日期**（M10.1 WP3 的修订）：草案里刻意**没有** `dueAt` / `dueBasis`
       *    —— `m10:test` 的 **G36** 断言"目标域生产侧没有任何一处写 `dueAt`"，
       *    那是"**不猜日期**"的结构性判据；草案是**模型产出**的，给它日期字段
       *    等于让模型提议日期。
       *    ⇒ 约定里读到的"明天十点二十五"目前**只**作为**读数**留在约定记录里，
       *      **不**变成任何程序侧截止时间（见 `M10.1-WP3-Handoff.md` 的 `U-04`）。
       */
    },
  }
  return { ok: true, draft }
}
