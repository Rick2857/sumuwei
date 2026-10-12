/**
 * Relationship 评估器——**确定性规则提案器**（M7 WP3 / ADR-064 D-4 裁定 (C) + 附录 A）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * Slow Path Processor：输入一段事件窗口，按**已冻结**的规则集
 * （ADR-064 附录 A：R-1 陪伴累积 · R-2 显式正反馈 · R-3 显式负面 ·
 * R-4 修复/撤回 · R-5 长程里程碑）产出 `RELATIONSHIP_IMPACT` 提案。
 *
 * 纪律（与 memory extractor 同源）：
 *   · **只提案，不落库**——放行归 WP4 的 Validator（计划 §5 WP3 出口：
 *     "提案不得直接落库"）；
 *   · **允许返回空**（"这批对话不推动关系"是正常结论——大多数窗口如此）；
 *   · **必须幂等**：同一 (窗口, processor, version) 重复调用产出语义相同的提案
 *     （幂等键的领域推导见本文件 `idempotencyKeyForRelationshipImpact`，
 *     WP4 接线时用它换掉通用 `idempotencyKeyFor`）；
 *   · 证据资格是**唯一入口**：只有 `user_message` 且
 *     `sourceQualificationOf === 'ESTABLISHED'` 的消息进规则输入
 *     （ADR-064 D-3 Tier 1；她的生成/工具/未确立归因在这里就被丢弃，
 *     与 RuleBasedMemoryExtractor 跳过非用户消息是同一结构性保证）。
 *
 * 依赖方向：app → contracts（本文件不 import 基础设施；纯函数可测）。
 */
import {
  KernelError,
  type CharacterId,
  type ConversationEventId,
  type DomainEventId,
  type ProcessorVersion,
} from '../../contracts/ids.ts'
import type { EntityRef, EntityRelationKey } from '../../contracts/entity.ts'
import { sourceQualificationOf } from '../../contracts/attribution.ts'
import type { ProcessorContext, ProcessorEventView } from '../../contracts/processor.ts'
import type { DomainProposal, ProposalOperation } from '../../contracts/proposal.ts'
import { createProposal } from '../../contracts/proposal.ts'
import { RELATIONSHIP_IMPACT } from '../../contracts/domain-event.ts'
import {
  RELATIONSHIP_IMPACT_PROPOSAL_TYPE,
  relationshipDeltaWithinBounds,
  relationshipDayOf,
  type RelationshipImpactPayload,
} from '../../contracts/relationship.ts'
import { matchRelationshipPatterns, type RelationshipPatternMatch } from './patterns.ts'

// ---------------------------------------------------------------------------
// 组件身份
// ---------------------------------------------------------------------------

export const RELATIONSHIP_EVALUATOR_NAME = 'relationship-evaluator'
export const RELATIONSHIP_EVALUATOR_VERSION = 'relationship-evaluator@1' as ProcessorVersion

// ---------------------------------------------------------------------------
// 输入契约（Job 层在 WP4 构建；这里只定义形状）
// ---------------------------------------------------------------------------

/** R-5 里程碑计数（账本派生，确定性；窗口前/窗口后各一份） */
export interface RelationshipMilestoneCounters {
  /** 累计 ESTABLISHED 用户消息数（每 100 条一个里程碑） */
  qualifiedMessageTotal: { prior: number; after: number }
  /** 累计活跃自然日数（每 30 日一个里程碑） */
  activeDayTotal: { prior: number; after: number }
}

export interface RelationshipEvaluationInput {
  characterId: CharacterId
  /** 视角拥有者（关系键的 owner；kind 用于审计） */
  owner: EntityRef
  /** 窗口内事件（已按 sequence 升序） */
  views: readonly ProcessorEventView[]
  /**
   * R-4 的触发前置：在案（未被取代）的 R-3 `RELATIONSHIP_IMPACT` 域事件 id，
   * **按目标用户键控**（在案是 per-关系的——user-2 的指控不能给 user-1 的修复放行），
   * 每个数组按时间升序（末尾 = 最新）。缺键 = 该目标当前无在案指控。
   */
  activeAccusations: Readonly<Record<string, readonly DomainEventId[]>>
  /**
   * R-5 里程碑计数，按目标用户 id 键控（Job 从账本派生）。
   * 缺键 = 该目标无计数 ⇒ R-5 不触发（失败关闭，不猜）。
   */
  milestones: Readonly<Record<string, RelationshipMilestoneCounters>>
}

/** 提案的审计 payload（"它当时凭什么这么建议"；不进 DomainEvent） */
export interface RelationshipProposalAudit {
  ruleId: string
  /** 幂等单元：r1=自然日 ISO · r2/r3/r4=window · r5=里程碑标签 */
  unit: string
  targetUserId: string
  matchedEventIds: ConversationEventId[]
  matchedPatterns: { patternId: string; sentence: string }[]
  /** 无指控在案时修复模式被忽略的说明（进 trace，不产生提案） */
  note?: string
}

// ---------------------------------------------------------------------------
// 冻结规则常量（ADR-064 附录 A；改任何值 = 回 ADR 裁定）
// ---------------------------------------------------------------------------

export const RELATIONSHIP_RULES = {
  r1: { trustDelta: 0, closenessDelta: 0.02, minMessages: 10, minDays: 2 },
  r2: { trustDelta: 0.02, closenessDelta: 0.02 },
  r3: { trustDelta: -0.05, closenessDelta: -0.02 },
  r4: { trustDelta: 0.03, closenessDelta: 0 },
  r5: { closenessDelta: 0.03, messageMilestone: 100, activeDayMilestone: 30 },
} as const

/** 自然日 = UTC+8 固定偏移（合同助手 `relationshipDayOf`；确定性优先，不引 TZ 库） */
function dayOf(timestamp: number): string {
  return relationshipDayOf(timestamp)
}

// ---------------------------------------------------------------------------
// 幂等键：见 `policies/relationship-validator.ts` 的
// `idempotencyKeyForRelationshipEvent`（memory 先例：领域键推导住在放行口；
// policies 不 import app——评估器不算键，Validator 算）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 证据分组
// ---------------------------------------------------------------------------

interface QualifiedGroup {
  targetUserId: string
  messages: ProcessorEventView[]
}

/**
 * 把窗口事件按"合格证据"分组：`user_message` + `ESTABLISHED` 资格，
 * 按内容来源用户分组（多用户对话各自成组——关系是 per-target 的）。
 */
export function qualifiedEvidenceGroups(
  views: readonly ProcessorEventView[],
): QualifiedGroup[] {
  const byTarget = new Map<string, ProcessorEventView[]>()
  for (const view of views) {
    if (view.type !== 'user_message') continue
    if (sourceQualificationOf(view.trustedOrigin) !== 'ESTABLISHED') continue
    const originator = view.trustedOrigin?.contentOriginator
    if (originator === undefined || originator.state !== 'KNOWN') continue // ESTABLISHED 必然 KNOWN；防御性收窄
    byTarget.set(originator.value.id, [...(byTarget.get(originator.value.id) ?? []), view])
  }
  return [...byTarget.entries()].map(([targetUserId, messages]) => ({ targetUserId, messages }))
}

// ---------------------------------------------------------------------------
// 评估器
// ---------------------------------------------------------------------------

interface RuleHit {
  ruleId: 'r2' | 'r3' | 'r4a' | 'r4b'
  messages: ProcessorEventView[]
  patterns: RelationshipPatternMatch[]
}

function groupHits(messages: readonly ProcessorEventView[]): {
  r2: RuleHit | undefined
  r3: RuleHit | undefined
  r4a: RuleHit | undefined
  r4b: RuleHit | undefined
} {
  const buckets: Record<'r2' | 'r3' | 'r4a' | 'r4b', ProcessorEventView[]> = {
    r2: [],
    r3: [],
    r4a: [],
    r4b: [],
  }
  const patterns: Record<'r2' | 'r3' | 'r4a' | 'r4b', RelationshipPatternMatch[]> = {
    r2: [],
    r3: [],
    r4a: [],
    r4b: [],
  }
  for (const message of messages) {
    for (const match of matchRelationshipPatterns(message.content)) {
      buckets[match.ruleId].push(message)
      patterns[match.ruleId].push(match)
    }
  }
  const hit = (ruleId: 'r2' | 'r3' | 'r4a' | 'r4b'): RuleHit | undefined =>
    buckets[ruleId].length > 0
      ? { ruleId, messages: [...new Set(buckets[ruleId])], patterns: patterns[ruleId] }
      : undefined
  return { r2: hit('r2'), r3: hit('r3'), r4a: hit('r4a'), r4b: hit('r4b') }
}

function buildImpactProposal(input: {
  characterId: CharacterId
  owner: EntityRef
  targetUserId: string
  ruleId: string
  unit: string
  operation: ProposalOperation
  delta: { trust: number; closeness: number }
  sources: readonly ProcessorEventView[]
  patterns: readonly RelationshipPatternMatch[]
  supersedes?: { domainEventId: DomainEventId; reason: string }
  note?: string
}): DomainProposal<RelationshipProposalAudit> {
  const key: EntityRelationKey = { owner: input.owner.id, target: input.targetUserId as EntityRelationKey['target'] }
  const payload: RelationshipImpactPayload = {
    key,
    targetKind: 'user',
    delta: input.delta,
    ruleId: input.ruleId,
    unit: input.unit,
    originKind: 'INTERACTION_DERIVED',
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  }
  return createProposal<RelationshipProposalAudit>({
    characterId: input.characterId,
    proposalType: RELATIONSHIP_IMPACT_PROPOSAL_TYPE,
    sourceConversationEventIds: input.sources.map((s) => s.id),
    payload: {
      ruleId: input.ruleId,
      unit: input.unit,
      targetUserId: input.targetUserId,
      matchedEventIds: input.sources.map((s) => s.id),
      matchedPatterns: input.patterns.map((p) => ({ patternId: p.patternId, sentence: p.sentence })),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
    targetEvents: [
      {
        type: RELATIONSHIP_IMPACT,
        operation: input.operation,
        payload,
      },
    ],
    processor: RELATIONSHIP_EVALUATOR_NAME,
    processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
  })
}

/**
 * 确定性规则评估器（生产实现；无模型调用——规则集是冻结判据，
 * 语义覆盖面的扩展走 ADR-064 D-4 预留的 LLM evaluator 位，不在本类里加启发式）。
 */
export class RuleBasedRelationshipEvaluator {
  readonly name = RELATIONSHIP_EVALUATOR_NAME
  readonly version = RELATIONSHIP_EVALUATOR_VERSION

  async process(
    input: RelationshipEvaluationInput,
    _context: ProcessorContext,
  ): Promise<DomainProposal<RelationshipProposalAudit>[]> {
    // 冻结规则表自检：任何 delta 超界 = 规则表被改坏，宁可失败也不产出非法提案
    assertRelationshipRulesWithinBounds()

    const proposals: DomainProposal<RelationshipProposalAudit>[] = []

    for (const group of qualifiedEvidenceGroups(input.views)) {
      const hits = groupHits(group.messages)
      const accusations = input.activeAccusations[group.targetUserId] ?? []
      const accusationInCase = accusations.length > 0
      const accusationInWindow = hits.r3 !== undefined

      // ---- R-2 显式正反馈（同窗口多次命中只计一次）----
      if (hits.r2 !== undefined) {
        proposals.push(
          buildImpactProposal({
            characterId: input.characterId,
            owner: input.owner,
            targetUserId: group.targetUserId,
            ruleId: 'r2',
            unit: 'window',
            operation: 'update',
            delta: { trust: RELATIONSHIP_RULES.r2.trustDelta, closeness: RELATIONSHIP_RULES.r2.closenessDelta },
            sources: hits.r2.messages,
            patterns: hits.r2.patterns,
          }),
        )
      }

      // ---- R-3 显式负面（closeness 刻意不清零；命中窗口停计 R-1）----
      if (hits.r3 !== undefined) {
        proposals.push(
          buildImpactProposal({
            characterId: input.characterId,
            owner: input.owner,
            targetUserId: group.targetUserId,
            ruleId: 'r3',
            unit: 'window',
            operation: 'update',
            delta: { trust: RELATIONSHIP_RULES.r3.trustDelta, closeness: RELATIONSHIP_RULES.r3.closenessDelta },
            sources: hits.r3.messages,
            patterns: hits.r3.patterns,
          }),
        )
      }

      // ---- R-4 修复/撤回（无 R-3 在案不触发——冻结规则）----
      const repair = hits.r4a ?? hits.r4b
      if (repair !== undefined && (accusationInCase || accusationInWindow)) {
        const retraction = hits.r4b
        const supersedes =
          retraction !== undefined && accusationInCase
            ? {
                // 多条在案时撤回最新的（被撤回的通常是最近那次指控）
                domainEventId: accusations[accusations.length - 1],
                reason: '用户明确撤回指控（R-4b：第一人称承认误判）',
              }
            : undefined
        proposals.push(
          buildImpactProposal({
            characterId: input.characterId,
            owner: input.owner,
            targetUserId: group.targetUserId,
            ruleId: 'r4',
            unit: 'window',
            // 撤回形走 supersede（旧 IMPACT 留痕、不再驱动投影）；纯修复走 update
            operation: supersedes !== undefined ? 'supersede' : 'update',
            delta: { trust: RELATIONSHIP_RULES.r4.trustDelta, closeness: RELATIONSHIP_RULES.r4.closenessDelta },
            sources: repair.messages,
            patterns: repair.patterns,
            ...(supersedes !== undefined ? { supersedes } : {}),
            note:
              supersedes !== undefined
                ? '撤回指控：部分恢复（不满血），被撤回的指控事件经 supersede 链留痕'
                : '修复：部分恢复（不满血，计划 §6 场景 4）',
          }),
        )
      }

      // ---- R-1 陪伴累积（无 R-3 命中 · ≥10 条 · 跨 ≥2 自然日；按日计单元）----
      if (!accusationInWindow) {
        const byDay = new Map<string, ProcessorEventView[]>()
        for (const message of group.messages) {
          const day = dayOf(message.createdAt)
          byDay.set(day, [...(byDay.get(day) ?? []), message])
        }
        const qualifies =
          group.messages.length >= RELATIONSHIP_RULES.r1.minMessages &&
          byDay.size >= RELATIONSHIP_RULES.r1.minDays
        if (qualifies) {
          for (const [day, dayMessages] of byDay) {
            proposals.push(
              buildImpactProposal({
                characterId: input.characterId,
                owner: input.owner,
                targetUserId: group.targetUserId,
                ruleId: 'r1',
                unit: day,
                operation: 'update',
                delta: { trust: RELATIONSHIP_RULES.r1.trustDelta, closeness: RELATIONSHIP_RULES.r1.closenessDelta },
                sources: dayMessages,
                patterns: [],
                note: `陪伴累积单元：${day}（窗口合格：${String(group.messages.length)} 条 / ${String(byDay.size)} 日）`,
              }),
            )
          }
        }
      }

      // ---- R-5 长程里程碑（两条独立轨道：每 100 条 / 每 30 活跃日）----
      const counters = input.milestones[group.targetUserId]
      if (counters !== undefined) {
        const messageMilestones =
          Math.floor(counters.qualifiedMessageTotal.after / RELATIONSHIP_RULES.r5.messageMilestone) -
          Math.floor(counters.qualifiedMessageTotal.prior / RELATIONSHIP_RULES.r5.messageMilestone)
        for (let i = 1; i <= messageMilestones; i += 1) {
          const milestoneNumber =
            Math.floor(counters.qualifiedMessageTotal.prior / RELATIONSHIP_RULES.r5.messageMilestone) + i
          proposals.push(
            buildImpactProposal({
              characterId: input.characterId,
              owner: input.owner,
              targetUserId: group.targetUserId,
              ruleId: 'r5-messages',
              unit: `messages-${String(milestoneNumber * RELATIONSHIP_RULES.r5.messageMilestone)}`,
              operation: 'update',
              delta: { trust: 0, closeness: RELATIONSHIP_RULES.r5.closenessDelta },
              sources: group.messages,
              patterns: [],
              note: `长程陪伴里程碑：累计合格消息 ${String(milestoneNumber * RELATIONSHIP_RULES.r5.messageMilestone)} 条`,
            }),
          )
        }
        const dayMilestones =
          Math.floor(counters.activeDayTotal.after / RELATIONSHIP_RULES.r5.activeDayMilestone) -
          Math.floor(counters.activeDayTotal.prior / RELATIONSHIP_RULES.r5.activeDayMilestone)
        for (let i = 1; i <= dayMilestones; i += 1) {
          const milestoneNumber =
            Math.floor(counters.activeDayTotal.prior / RELATIONSHIP_RULES.r5.activeDayMilestone) + i
          proposals.push(
            buildImpactProposal({
              characterId: input.characterId,
              owner: input.owner,
              targetUserId: group.targetUserId,
              ruleId: 'r5-days',
              unit: `days-${String(milestoneNumber * RELATIONSHIP_RULES.r5.activeDayMilestone)}`,
              operation: 'update',
              delta: { trust: 0, closeness: RELATIONSHIP_RULES.r5.closenessDelta },
              sources: group.messages,
              patterns: [],
              note: `长程陪伴里程碑：累计活跃 ${String(milestoneNumber * RELATIONSHIP_RULES.r5.activeDayMilestone)} 日`,
            }),
          )
        }
      }
    }

    return proposals
  }
}

/** 防御性自检：delta 必须在冻结界内（评估器产出前最后一道；超界 = 规则表被改坏） */
export function assertRelationshipRulesWithinBounds(): void {
  const checks: Array<[string, { trust: number; closeness: number }]> = [
    ['r1', { trust: RELATIONSHIP_RULES.r1.trustDelta, closeness: RELATIONSHIP_RULES.r1.closenessDelta }],
    ['r2', { trust: RELATIONSHIP_RULES.r2.trustDelta, closeness: RELATIONSHIP_RULES.r2.closenessDelta }],
    ['r3', { trust: RELATIONSHIP_RULES.r3.trustDelta, closeness: RELATIONSHIP_RULES.r3.closenessDelta }],
    ['r4', { trust: RELATIONSHIP_RULES.r4.trustDelta, closeness: RELATIONSHIP_RULES.r4.closenessDelta }],
    ['r5', { trust: 0, closeness: RELATIONSHIP_RULES.r5.closenessDelta }],
  ]
  for (const [ruleId, delta] of checks) {
    if (!relationshipDeltaWithinBounds(delta)) {
      throw new KernelError(
        'validation_error',
        'relationship_rule_delta_out_of_bounds',
        `冻结规则 ${ruleId} 的 delta 超出单事件上限——规则表被改坏，拒绝产出提案`,
      )
    }
  }
}
