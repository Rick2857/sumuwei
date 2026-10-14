/**
 * AffectSemanticCommitPort —— worker `commitOutcome` 端口的**生产实现**（M8.5 WP7）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 把一个语义终态变成持久事实的**唯一生产通道**：
 *
 * ```text
 * AffectSemanticCommitInput（worker 给的：source + 可选 impact + 两份回执）
 *   → 构造单目标 DomainProposal（AFFECT_IMPACT，语义 payload）
 *   → validateAffectProposal（唯一放行口：资格三层 + 精确增量 + SOURCE_ANCHORED）
 *   → applyAcceptedEvents（事件 + 终结闸行**同一事务**——M85-D20）
 * ```
 *
 * 三种结局（与 worker 端口契约一一对应）：
 * · `committed` —— 放行口接受：IMPACT 事件 + 闸行（`receipt` = COMMITTED 编码）同事务落库。
 * · `rejected`  —— 放行口拒绝：**零事件**，但闸行照落（`fallbackReceipt` =
 *   TERMINAL_FAILED 编码）+ 拒码闭集回传。source 永不悬空：拒绝也是终态，
 *   不会在下一次 tick 被重新评估烧模型（确定性拒绝 ⇒ 重评必然再拒）。
 * · `no_impact` —— 无 impact 输入：accepted=[] + 闸行（`receipt` = NO_IMPACT 编码）。
 *
 * ---------------------------------------------------------------------------
 *  纪律
 * ---------------------------------------------------------------------------
 * · **不绕过放行口**：IMPACT 一律走 `validateAffectProposal`——与 M8 词形路径
 *   同一唯一放行口（ADR-066 §5），语义路径没有特权入口。
 * · **拒码闭集**：`rejectionCodes` 只回传 `AFFECT_REJECTION_CODES` 登记过的码
 *   （放行口只产登记码）；message 正文不回传 worker（trace 纪律）。
 * · **不抛**：放行口拒绝是正常结果；真正的异常（DB 故障）向上传播由
 *   worker 的失败关闭语义收口（tick 不抛，计数进结局）。
 * · 幂等键由**放行口**推导（`idempotencyKeyForAffectEvent`——一个概念一处
 *   实现）；本层不自己拼键。
 */
import type {
  AffectSemanticCommitInput,
  AffectSemanticCommitOutcome,
} from './semantic-worker.ts'
import { AFFECT_SEMANTIC_WORKER_NAME } from './semantic-worker.ts'
import {
  AFFECT_SEMANTIC_EVALUATOR_NAME,
  AFFECT_SEMANTIC_EVALUATOR_VERSION,
  AFFECT_SEMANTIC_POLICY_VERSION,
  AFFECT_SEMANTIC_WORKER_PROCESSOR,
  affectSemanticFinalizedGateKey,
  type AffectSemanticImpactPayload,
} from '../../contracts/affect-semantic.ts'
import {
  AFFECT_IMPACT,
  AFFECT_IMPACT_PROPOSAL_TYPE,
  DOMAIN_EVENT_SCOPE,
  createProposal,
  type AffectState,
  type CharacterId,
  type ConversationEventId,
  type DomainEventRegistry,
} from '../../contracts/index.ts'
import type { TrustedOriginReading } from '../../contracts/attribution.ts'
import { validateAffectProposal } from '../../policies/affect-validator.ts'
import type { AcceptedDomainEvent } from '../../policies/validator.ts'

// ---------------------------------------------------------------------------
// 依赖端口（装配层注入；本层不认识 SQL——与 M8 job 的 validatorDeps 同形状）
// ---------------------------------------------------------------------------

/** 证据查找：与 AffectValidatorDeps.evidence 同形状（放行口资格复核要读 type/trustedOrigin） */
export interface AffectSemanticEvidenceLookup {
  findEvents(
    ids: readonly ConversationEventId[]
  ): Promise<
    {
      id: ConversationEventId
      characterId: CharacterId
      sequence: number
      type: string
      trustedOrigin?: TrustedOriginReading
    }[]
  >
}

/** 落库端口：applyAcceptedEvents 的形状（事件 + extras 同事务；WP6 第一批机制） */
export interface AffectSemanticApplyPort {
  (
    accepted: readonly AcceptedDomainEvent[],
    extras: readonly {
      idempotencyKey: string
      processor: string
      processorVersion: string
      operation: string
    }[],
    now: number
  ): Promise<{
    createdCount: number
    deduplicatedCount: number
    extraRecordedCount: number
  }>
}

export interface AffectSemanticCommitDeps {
  readonly characterId: CharacterId
  /** 唯一 active user（M8-D11 口径；资格判定配置面） */
  readonly activeUserId: string
  readonly allowedUserIds?: readonly string[]
  readonly registry: DomainEventRegistry
  readonly evidence: AffectSemanticEvidenceLookup
  readonly processed: { hasProcessed(idempotencyKey: string): Promise<boolean> }
  readonly affect: { getAffectState(characterId: CharacterId): Promise<AffectState | undefined> }
  readonly apply: AffectSemanticApplyPort
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 造 worker `commitOutcome` 端口的生产实现。
 *
 * 装配（WP8 进 main.ts；WP7 门在隔离库注入真函数）：
 * `evidence` = 账本按 id 查事件（含受信读数派生）；
 * `processed` = `hasProcessedOperation`；`affect` = `getAffectProjection`；
 * `apply` = `applyAcceptedEvents(db, characterId, …, [affectReducerV2For(characterId)], …)`。
 */
export function createAffectSemanticCommitPort(
  deps: AffectSemanticCommitDeps
): (input: AffectSemanticCommitInput) => Promise<AffectSemanticCommitOutcome> {
  return async (input: AffectSemanticCommitInput): Promise<AffectSemanticCommitOutcome> => {
    const gateKey = affectSemanticFinalizedGateKey(input.source.sourceEventId)
    const gateExtra = {
      idempotencyKey: gateKey,
      processor: AFFECT_SEMANTIC_WORKER_NAME,
      processorVersion: AFFECT_SEMANTIC_WORKER_PROCESSOR,
      operation: input.receipt,
    }

    // ---- 无 IMPACT 的终态：零事件 + 闸行（NO_IMPACT / EXPIRED / …）----
    if (input.impact === undefined) {
      const applied = await deps.apply([], [gateExtra], input.now)
      return { kind: 'no_impact', extraRecordedCount: applied.extraRecordedCount }
    }

    // ---- 有 IMPACT：走唯一放行口（不绕过）----
    // 提案的 operation 用受控枚举 'update'（M8 evaluator 先例）；领域幂等串
    // （affect-semantic-impact:<family>:<id>）由放行口内部推导进键，不进提案。
    const payload: AffectSemanticImpactPayload = {
      characterId: deps.characterId,
      sourceEventId: input.source.sourceEventId,
      sourceSequence: input.source.sourceSequence,
      ruleId: input.impact.family,
      ruleVersion: AFFECT_SEMANTIC_POLICY_VERSION,
      delta: input.impact.delta,
      // 与 M8 词形 IMPACT 同一来源类别（交互推导——语义改变的是"识别方式"，不是"来源事实"）
      originKind: 'INTERACTION_DERIVED',
      evaluatorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
      proposalId: '',
      sourceAt: input.impact.sourceAt,
      timingKind: 'SOURCE_ANCHORED',
    }
    const proposal = createProposal({
      characterId: deps.characterId,
      proposalType: AFFECT_IMPACT_PROPOSAL_TYPE,
      sourceConversationEventIds: [input.source.sourceEventId],
      payload: {
        kind: 'semantic-impact',
        sourceEventId: input.source.sourceEventId,
        family: input.impact.family,
      },
      targetEvents: [
        {
          type: AFFECT_IMPACT,
          operation: 'update',
          payload,
          scope: DOMAIN_EVENT_SCOPE,
        },
      ],
      processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
      processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
    })
    // payload.proposalId 指回提案 id（审计自包含；createProposal 之后才知道 id——M8 先例）
    ;(payload as { proposalId: string }).proposalId = proposal.proposalId

    const outcome = await validateAffectProposal(
      {
        registry: deps.registry,
        evidence: deps.evidence,
        processed: deps.processed,
        affect: deps.affect,
        policy: { activeUserId: deps.activeUserId, allowedUserIds: deps.allowedUserIds },
      },
      proposal
    )

    if (!outcome.accepted) {
      // 放行口拒绝：零事件，但闸行照落（fallbackReceipt）——拒绝也是终态，
      // source 不悬空；拒码闭集回传（message 不出放行口）。
      const applied = await deps.apply(
        [],
        [{ ...gateExtra, operation: input.fallbackReceipt }],
        input.now
      )
      return {
        kind: 'rejected',
        rejectionCodes: outcome.rejected.map((r) => r.code),
        extraRecordedCount: applied.extraRecordedCount,
      }
    }

    const applied = await deps.apply(outcome.acceptedEvents, [gateExtra], input.now)
    return {
      kind: 'committed',
      createdCount: applied.createdCount,
      deduplicatedCount: applied.deduplicatedCount,
      extraRecordedCount: applied.extraRecordedCount,
    }
  }
}
