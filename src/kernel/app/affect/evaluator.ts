/**
 * Affect 评估器——**确定性规则提案器**（M8 WP3 / ADR-066 M8-D03 + §4）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * Bounded Processor：输入一段事件窗口，按**已冻结**的规则表
 * （affect-rules@1：A-GRATITUDE · A-REPAIR · A-WARM-CONTACT · A-COMFORT ·
 * A-HOSTILE · A-REJECTION · A-URGENT）产出 `AFFECT_TOUCH` / `AFFECT_IMPACT` 提案。
 *
 * 与 M7 评估器的**结构性差异**（都来自 ADR-066 的裁定）：
 *   · **逐事件提案，不按窗口聚合**（M8-D08：一次用户事件至多 1 TOUCH + 1 主导
 *     IMPACT）。M7 的 r2/r3 是"窗口内命中即一次"，M8 的情绪是"每句话都算数"——
 *     但一次只有**一个主导**规则能改轴（不叠加）。
 *   · **TOUCH 与 IMPACT 是两个独立提案**：touch = "合格交互已消费"（结构性事实），
 *     impact = "主导规则命中"（规则判断）。规则表出 bug 不该把交互本身
 *     一起拒掉（touch 被拒 = 事件未消费 = 下次重提；impact 被拒 = 只是不改轴）。
 *   · **单 active user**（M8-D11）：不做 per-target 分组——非 active user 的事件
 *     直接不进规则输入（fail-closed 在 Validator 再挡一遍）。
 *
 * 纪律（与 memory / relationship extractor 同源）：
 *   · **只提案，不落库**——放行归 `policies/affect-validator.ts`；
 *   · **允许返回空**（"这批事件不推动情绪"是正常结论——比如全是她的回复）；
 *   · **必须幂等**：同一 (窗口, processor, version) 重复调用产出语义相同的提案
 *     （幂等键的领域推导在 Validator——policies 不 import app，一个概念一处实现）；
 *   · 证据资格是**唯一入口**：`user_message` + `ESTABLISHED` + active user +
 *     切换后（M8-D05），四条全过才进规则输入。
 *
 * 依赖方向：app → contracts（本文件不 import 基础设施；纯函数可测）。
 */
import { KernelError, type CharacterId, type ConversationEventId, type ProcessorVersion } from '../../contracts/ids.ts'
import { sourceQualificationOf } from '../../contracts/attribution.ts'
import type { ProcessorContext, ProcessorEventView } from '../../contracts/processor.ts'
import type { DomainProposal } from '../../contracts/proposal.ts'
import { createProposal } from '../../contracts/proposal.ts'
import { AFFECT_IMPACT, AFFECT_TOUCH } from '../../contracts/domain-event.ts'
import {
  AFFECT_IMPACT_PROPOSAL_TYPE,
  AFFECT_RULES_VERSION,
  AFFECT_TOUCH_PROPOSAL_TYPE,
  MAX_AFFECT_DELTA_PER_EVENT,
  affectDeltaWithinBounds,
  isAffectImpactRuleId,
  type AffectEvidencePolicy,
  type AffectImpactPayload,
  type AffectTouchPayload,
} from '../../contracts/affect.ts'
import {
  AFFECT_RULE_DELTAS,
  dominantAffectRuleFamily,
  type AffectPatternMatch,
} from './patterns.ts'

// ---------------------------------------------------------------------------
// 组件身份
// ---------------------------------------------------------------------------

export const AFFECT_EVALUATOR_NAME = 'affect-evaluator'
export const AFFECT_EVALUATOR_VERSION = 'affect-evaluator@1' as ProcessorVersion

// ---------------------------------------------------------------------------
// 输入契约（Job 层构建；这里只定义形状）
// ---------------------------------------------------------------------------

export interface AffectEvaluationInput {
  characterId: CharacterId
  /** 窗口内事件（已按 sequence 升序） */
  views: readonly ProcessorEventView[]
  /** 资格判定的配置面（与 Validator 同一口径——ADR-066 §3） */
  policy: AffectEvidencePolicy
}

/** 提案的审计 payload（"它当时凭什么这么建议"；不进 DomainEvent） */
export interface AffectProposalAudit {
  kind: 'touch' | 'impact'
  sourceEventId: ConversationEventId
  /** impact 专用：主导规则 + 命中词形 */
  ruleId?: string
  matchedPatternId?: string
  note?: string
}

// ---------------------------------------------------------------------------
// 冻结规则自检（规则表被改坏 = 宁可失败也不产出非法提案）
// ---------------------------------------------------------------------------

/**
 * 启动级自检：冻结 delta 表的每个值都必须在单事件上限内。
 * 违规 = 规则表被人改坏（ADR-066 §4.1 的机器保证）——直接抛，
 * 不产出任何提案（失败关闭优先于"少影响一次"）。
 */
export function assertAffectRulesWithinBounds(): void {
  for (const [ruleId, delta] of Object.entries(AFFECT_RULE_DELTAS)) {
    if (!affectDeltaWithinBounds(delta)) {
      throw new KernelError(
        'validation_error',
        'affect_delta_out_of_bounds',
        `冻结规则表被改坏：${ruleId} 的 delta (${String(delta.deltaValence)},${String(delta.deltaArousal)}) ` +
          `超出单事件上限 ${String(MAX_AFFECT_DELTA_PER_EVENT)}（ADR-066 §4.1）`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 证据筛选（资格四条：user_message + ESTABLISHED + active user + 切换后）
// ---------------------------------------------------------------------------

/**
 * 窗口内的**合格情绪证据**：`user_message` + `sourceQualificationOf === 'ESTABLISHED'`
 * + 归因主体 = active user（M8-D11）+ `sequence > cutoverSequence`（M8-D05）。
 *
 * 她的生成 / 工具 / 系统 / 外部证据 / 未确立归因 / 其他用户 / 切换前历史
 * 在这里就被丢弃（Validator 会再挡一遍——两层都判，防装配错误）。
 */
export function qualifiedAffectEvidence(
  views: readonly ProcessorEventView[],
  policy: AffectEvidencePolicy,
): ProcessorEventView[] {
  const qualified: ProcessorEventView[] = []
  for (const view of views) {
    if (view.type !== 'user_message') continue
    if (sourceQualificationOf(view.trustedOrigin) !== 'ESTABLISHED') continue
    const originator = view.trustedOrigin?.contentOriginator
    if (originator === undefined || originator.state !== 'KNOWN') continue // ESTABLISHED 必然 KNOWN；防御性收窄
    if (originator.value.id !== policy.activeUserId) continue
    if (policy.cutoverSequence !== null && view.sequence <= policy.cutoverSequence) continue
    qualified.push(view)
  }
  return qualified
}

// ---------------------------------------------------------------------------
// 提案构造（touch 与 impact 分立——见文件头结构性差异）
// ---------------------------------------------------------------------------

function buildTouchProposal(input: {
  characterId: CharacterId
  view: ProcessorEventView
  traceId?: string
}): DomainProposal<AffectProposalAudit> {
  const payload: AffectTouchPayload = {
    characterId: input.characterId,
    sourceEventId: input.view.id,
    sourceSequence: input.view.sequence,
    originKind: 'INTERACTION_DERIVED',
    evaluatorVersion: AFFECT_EVALUATOR_VERSION,
    proposalId: '',
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  }
  const proposal = createProposal<AffectProposalAudit>({
    characterId: input.characterId,
    proposalType: AFFECT_TOUCH_PROPOSAL_TYPE,
    sourceConversationEventIds: [input.view.id],
    payload: { kind: 'touch', sourceEventId: input.view.id },
    targetEvents: [{ type: AFFECT_TOUCH, operation: 'update', payload }],
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
  })
  // payload.proposalId 指回提案 id（审计自包含；createProposal 之后才知道 id）
  ;(payload as { proposalId: string }).proposalId = proposal.proposalId
  return proposal
}

function buildImpactProposal(input: {
  characterId: CharacterId
  view: ProcessorEventView
  dominant: AffectPatternMatch
  traceId?: string
}): DomainProposal<AffectProposalAudit> {
  const delta = AFFECT_RULE_DELTAS[input.dominant.ruleId]
  const payload: AffectImpactPayload = {
    characterId: input.characterId,
    sourceEventId: input.view.id,
    sourceSequence: input.view.sequence,
    ruleId: input.dominant.ruleId,
    ruleVersion: AFFECT_RULES_VERSION,
    delta,
    originKind: 'INTERACTION_DERIVED',
    evaluatorVersion: AFFECT_EVALUATOR_VERSION,
    proposalId: '',
    matchedPatternId: input.dominant.patternId,
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  }
  const proposal = createProposal<AffectProposalAudit>({
    characterId: input.characterId,
    proposalType: AFFECT_IMPACT_PROPOSAL_TYPE,
    sourceConversationEventIds: [input.view.id],
    payload: {
      kind: 'impact',
      sourceEventId: input.view.id,
      ruleId: input.dominant.ruleId,
      matchedPatternId: input.dominant.patternId,
    },
    targetEvents: [{ type: AFFECT_IMPACT, operation: 'update', payload }],
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
  })
  ;(payload as { proposalId: string }).proposalId = proposal.proposalId
  return proposal
}

// ---------------------------------------------------------------------------
// 评估器
// ---------------------------------------------------------------------------

/**
 * 确定性规则评估器（生产实现；无模型调用——LLM evaluator 是 ADR-066 M8-D03
 * 预留的 M8.1 位，输出仍是 proposal、过同一 Validator，不在本类里加启发式）。
 *
 * 每条合格用户事件：
 *   1. 产一个 TOUCH 提案（M8-D07：中性交互也要消费锚点）；
 *   2. 若命中冻结规则表的主导规则（M8-D09 全序取一条），追加一个 IMPACT 提案。
 */
export class RuleBasedAffectEvaluator {
  readonly name = AFFECT_EVALUATOR_NAME
  readonly version = AFFECT_EVALUATOR_VERSION

  async process(
    input: AffectEvaluationInput,
    _context: ProcessorContext,
  ): Promise<DomainProposal<AffectProposalAudit>[]> {
    // 冻结规则表自检：任何 delta 超界 = 规则表被改坏，宁可失败也不产出非法提案
    assertAffectRulesWithinBounds()

    const proposals: DomainProposal<AffectProposalAudit>[] = []
    for (const view of qualifiedAffectEvidence(input.views, input.policy)) {
      proposals.push(buildTouchProposal({ characterId: input.characterId, view }))
      const dominant = dominantAffectRuleFamily(view.content)
      if (dominant !== undefined && isAffectImpactRuleId(dominant.ruleId)) {
        proposals.push(
          buildImpactProposal({ characterId: input.characterId, view, dominant }),
        )
      }
      // 无主导规则 ⇒ 只 touch（A-NEUTRAL-TOUCH 语义；A-UNCERTAIN 是未来语义
      // 评估器的具名回退，v1 恒不产生 impact——M8-D09）
    }
    return proposals
  }
}
