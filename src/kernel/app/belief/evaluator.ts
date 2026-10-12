/**
 * Belief 交互评估器 —— **确定性规则提案器**（M9 WP3 / ADR-070 D05·D07）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * Bounded Processor：输入一段事件窗口 + 该槽位的当前状态（累计 + 现存信念），
 * 按冻结规则表（`patterns.ts`，belief-inferred-rules@1）产出：
 *
 *   · `BELIEF_EVIDENCE_NOTED`——每条**合格**且**命中**详略信号的用户事件
 *     一根（记录"这根线索被看见了"；不表示已形成——ADR-070 §4.2）；
 *   · `BELIEF_FORMED`——(槽位, 值) 的合并累计跨过阈值（≥3 独立根 · 跨 ≥2
 *     会话）且**无同值现存信念**时一次；
 *   · `BELIEF_REINFORCED`——同值现存信念 + **去重后非空**的新根时一次。
 *
 * 与 M7/M8 评估器的结构性差异（都来自 ADR-070 的裁定）：
 *   · **证据按 (槽位, 值) 分组累计**：value 不进**信念槽位键**（D03，冲突
 *     检测用），但 detailed 的证据不支持 concise——混值累计会形成不连贯
 *     命题。累计投影键 = `beliefEvidenceProjectionTypeOf(slotKey + '|' + value)`。
 *   · **跨窗口状态由调用方喂入**（`slotState`）：评估器是纯函数，不读投影；
 *     重启后从 `belief:evidence` 投影恢复，不靠无限尾窗（ADR-070 §3.4）。
 *   · **abstain 是一等输出**：每条合格但未命中的事件都有**具名理由**
 *     （守卫 id / 无信号 / 双值冲突），可审计、可回归（计划 §13 WP3）。
 *   · **同值冲突不静默**：现存 detailed + 新证据 concise 跨阈值 ⇒ 照提
 *     FORMED（冲突是真实信号）——生命周期（DISPUTED/SUPERSEDED）归
 *     WP4 Validator + WP5，评估器不猜。
 *
 * 纪律（与 memory / relationship / affect extractor 同源）：
 *   · **只提案，不落库**——放行归 `policies/belief-validator.ts`（WP4）；
 *   · **允许返回空**（"这批事件不推动信念"是正常结论）；
 *   · **幂等**：同一 (窗口, slotState) 重复调用产出语义相同的提案——
 *     FORMED 的 beliefId 由 `makeBeliefId(characterId, slotKey, formationKey)`
 *     派生，formationKey = 形成时合并根的最大 sequence（确定性）；
 *   · **证据资格四条**（与 affect 同构）：`user_message` + `ESTABLISHED` +
 *     active user + 切换后；**会话维度缺失 = 失败关闭**（不形成、不累计，
 *     具名 abstain `missing_conversation_dimension`——视图的可选字段被
 *     旧构造点漏填时宁可少形成也不猜会话）。
 *
 * 依赖方向：app → contracts（本文件不 import 基础设施；纯函数可测）。
 */
import type {
  BeliefId,
  CharacterId,
  ConversationEventId,
  EntityId,
  ProcessorVersion,
} from '../../contracts/ids.ts'
import type { EntityRef, PerspectiveOwnerId } from '../../contracts/entity.ts'
import { sourceQualificationOf } from '../../contracts/attribution.ts'
import type { ProcessorContext, ProcessorEventView } from '../../contracts/processor.ts'
import type { DomainProposal } from '../../contracts/proposal.ts'
import { createProposal } from '../../contracts/proposal.ts'
import { BELIEF_EVIDENCE_NOTED, BELIEF_FORMED, BELIEF_REINFORCED } from '../../contracts/domain-event.ts'
import {
  BELIEF_INFERRED_MIN_CONVERSATIONS,
  BELIEF_INFERRED_MIN_ROOTS,
  BELIEF_INFERRED_PREDICATE,
  BELIEF_INFERRED_RULE_ID,
  BELIEF_INFERRED_SCOPE,
  BELIEF_INFERRED_WINDOW_LIMIT,
  BELIEF_PROJECTION_PREFIX,
  beliefEvidenceProjectionTypeOf,
  beliefEvidenceQualifies,
  beliefInferredThresholdMet,
  beliefSlotKeyOf,
  makeBeliefId,
  type BeliefEvidenceAccumulation,
  type BeliefEvidenceNotedPayload,
  type BeliefEvidencePolicy,
  type BeliefFormedPayload,
  type BeliefInferredValue,
  type BeliefProposition,
  type BeliefReinforcedPayload,
} from '../../contracts/belief.ts'
import {
  BELIEF_INFERRED_RULES_VERSION,
  judgeExplanationDetail,
  type BeliefAbstainReason,
} from './patterns.ts'

// ---------------------------------------------------------------------------
// 组件身份
// ---------------------------------------------------------------------------

export const BELIEF_INTERACTION_EVALUATOR_NAME = 'belief-interaction-evaluator'
export const BELIEF_INTERACTION_EVALUATOR_VERSION = 'belief-interaction-evaluator@1' as ProcessorVersion

// ---------------------------------------------------------------------------
// 输入契约（Job 层构建；这里只定义形状）
// ---------------------------------------------------------------------------

/**
 * 证据资格判定的配置面 —— **contracts 单源**（`contracts/belief.ts`；
 * 评估器与 Validator 共用同一口径，ADR-070 §3.3/§3.4）。
 * 这里 re-export 供既有导入方（Job 层 / 门）继续从本文件拿。
 */
export type { BeliefEvidencePolicy } from '../../contracts/belief.ts'

/** 槽位当前状态（Job 层从投影读出喂入；评估器不读投影） */
export interface BeliefSlotSnapshot {
  /** 该槽位现存的 active 信念（有则形成路径让位于强化/冲突路径） */
  activeBelief?: {
    beliefId: BeliefId
    value: BeliefInferredValue
    rootIds: readonly ConversationEventId[]
  }
  /** 该 (槽位, 值) 的待累计状态（来自 belief:evidence 投影；可能没有） */
  accumulation?: BeliefEvidenceAccumulation
}

export interface BeliefEvaluationInput {
  characterId: CharacterId
  /** 视角所有者（v1 恒 = characterId；契约层独立以保 perspective 语义） */
  perspectiveOwnerId: PerspectiveOwnerId
  /** 信念主体（v1 恒 = active user） */
  subject: EntityRef
  /** 窗口内事件（已按 sequence 升序） */
  views: readonly ProcessorEventView[]
  policy: BeliefEvidencePolicy
  slotState?: BeliefSlotSnapshot
}

/** 提案的审计 payload（"它当时凭什么这么建议"；不进 DomainEvent） */
export interface BeliefProposalAudit {
  kind: 'evidence' | 'formed' | 'reinforced'
  sourceEventId?: ConversationEventId
  patternId?: string
  note?: string
}

/** 合格但未形成证据的具名弃权（一等输出：可审计、可回归） */
export interface BeliefAbstention {
  sourceEventId: ConversationEventId
  reason: BeliefAbstainReason | 'missing_conversation_dimension'
  guardId?: string
}

export interface BeliefEvaluationOutcome {
  proposals: DomainProposal<BeliefProposalAudit>[]
  abstentions: BeliefAbstention[]
  /** 本窗口记下的新证据根数（measured_count 纪律的载体） */
  notedCount: number
}

// ---------------------------------------------------------------------------
// 证据筛选（资格四条 + 会话维度失败关闭）
// ---------------------------------------------------------------------------

/**
 * 窗口内的**合格信念证据候选**：资格四条走 contracts 单源
 * （`beliefEvidenceQualifies`——评估器与 Validator 共用同一口径）。
 *
 * 会话维度缺失的合格事件**不进候选**（由调用处记具名 abstain——
 * `missing_conversation_dimension`，失败关闭：不形成、不累计、不猜）。
 */
export function qualifiedBeliefEvidence(
  views: readonly ProcessorEventView[],
  policy: BeliefEvidencePolicy,
): { qualified: ProcessorEventView[]; missingConversation: ProcessorEventView[] } {
  const qualified: ProcessorEventView[] = []
  const missingConversation: ProcessorEventView[] = []
  for (const view of views) {
    if (!beliefEvidenceQualifies(
      {
        id: view.id,
        sequence: view.sequence,
        type: view.type,
        actorId: view.actorId,
        trustedOrigin: view.trustedOrigin,
      },
      policy,
    )) {
      continue
    }
    if (view.conversationId === undefined) {
      missingConversation.push(view)
      continue
    }
    qualified.push(view)
  }
  return { qualified, missingConversation }
}

// ---------------------------------------------------------------------------
// 提案构造
// ---------------------------------------------------------------------------

function buildEvidenceProposal(input: {
  characterId: CharacterId
  perspectiveOwnerId: PerspectiveOwnerId
  subject: EntityRef
  view: ProcessorEventView
  value: BeliefInferredValue
  patternId: string
  traceId?: string
}): DomainProposal<BeliefProposalAudit> {
  const payload: BeliefEvidenceNotedPayload = {
    characterId: input.characterId,
    perspectiveOwnerId: input.perspectiveOwnerId,
    subject: input.subject,
    predicate: BELIEF_INFERRED_PREDICATE,
    scopeKey: BELIEF_INFERRED_SCOPE,
    value: input.value,
    rootEventId: input.view.id,
    rootSequence: input.view.sequence,
    conversationId: String(input.view.conversationId),
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULES_VERSION,
  }
  return createProposal<BeliefProposalAudit>({
    characterId: input.characterId,
    proposalType: `${BELIEF_PROJECTION_PREFIX}evidence-noted`,
    sourceConversationEventIds: [input.view.id],
    payload: { kind: 'evidence', sourceEventId: input.view.id, patternId: input.patternId },
    targetEvents: [{ type: BELIEF_EVIDENCE_NOTED, operation: 'create', payload }],
    processor: BELIEF_INTERACTION_EVALUATOR_NAME,
    processorVersion: BELIEF_INTERACTION_EVALUATOR_VERSION,
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  })
}

function buildFormedProposal(input: {
  characterId: CharacterId
  perspectiveOwnerId: PerspectiveOwnerId
  subject: EntityRef
  slotKey: string
  value: BeliefInferredValue
  combinedRoots: ConversationEventId[]
  combinedConversations: string[]
  formationKey: string
  traceId?: string
}): DomainProposal<BeliefProposalAudit> {
  const beliefId = makeBeliefId(input.characterId, input.slotKey, input.formationKey)
  const proposition: BeliefProposition = {
    predicate: BELIEF_INFERRED_PREDICATE,
    scopeKey: BELIEF_INFERRED_SCOPE,
    value: input.value,
  }
  const payload: BeliefFormedPayload = {
    characterId: input.characterId,
    beliefId,
    perspectiveOwnerId: input.perspectiveOwnerId,
    subject: input.subject,
    proposition,
    epistemicKind: 'inferred',
    supportLevel: 'tentative',
    evidenceRootIds: input.combinedRoots,
    // B-INFERRED 无 Memory 依赖（空集合用 undefined，不用 []——结构校验器纪律）
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULES_VERSION,
  }
  return createProposal<BeliefProposalAudit>({
    characterId: input.characterId,
    proposalType: `${BELIEF_PROJECTION_PREFIX}formed`,
    sourceConversationEventIds: input.combinedRoots,
    payload: { kind: 'formed', note: `formationKey=${input.formationKey}` },
    targetEvents: [{ type: BELIEF_FORMED, operation: 'create', payload }],
    processor: BELIEF_INTERACTION_EVALUATOR_NAME,
    processorVersion: BELIEF_INTERACTION_EVALUATOR_VERSION,
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  })
}

function buildReinforcedProposal(input: {
  characterId: CharacterId
  beliefId: BeliefId
  newRootIds: ConversationEventId[]
  traceId?: string
}): DomainProposal<BeliefProposalAudit> {
  const payload: BeliefReinforcedPayload = {
    characterId: input.characterId,
    beliefId: input.beliefId,
    newRootIds: input.newRootIds,
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULES_VERSION,
  }
  return createProposal<BeliefProposalAudit>({
    characterId: input.characterId,
    proposalType: `${BELIEF_PROJECTION_PREFIX}reinforced`,
    sourceConversationEventIds: input.newRootIds,
    payload: { kind: 'reinforced', note: `newRoots=${String(input.newRootIds.length)}` },
    targetEvents: [{ type: BELIEF_REINFORCED, operation: 'reinforce', payload }],
    processor: BELIEF_INTERACTION_EVALUATOR_NAME,
    processorVersion: BELIEF_INTERACTION_EVALUATOR_VERSION,
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  })
}

// ---------------------------------------------------------------------------
// 评估器
// ---------------------------------------------------------------------------

interface NotedRoot {
  view: ProcessorEventView
  value: BeliefInferredValue
  patternId: string
}

/**
 * 确定性规则评估器（生产实现；无模型调用——D07：LLM evaluator 是未来
 * 版本位，输出仍是 proposal、过同一 Validator，不在本类里加启发式）。
 *
 * 判序（冻结）：
 *   1. 资格四条筛入 + 会话维度失败关闭；
 *   2. 每条候选过 `judgeExplanationDetail`（守卫先行 → 正控首中即停 →
 *      双值冲突具名回退）；silent ⇒ abstention（具名理由）；
 *   3. 命中 ⇒ EVIDENCE_NOTED 一根；
 *   4. 按 (槽位, 值) 合并累计（现有 + 新，去重；窗口 ≤50 的"最近"口径：
 *      只取最近 50 根参与阈值判定——旧根不失效，只是不再推动形成）；
 *   5. 同值现存信念：**新根即强化**（REINFORCED，去重后非空才提；阈值闸
 *      不适用——信念已存在）；无新根 ⇒ 幂等静默；
 *   6. 无现存（或异值现存）：阈值达成才 FORMED（formationKey = 合并根
 *      最大 sequence）；**异值现存 ⇒ 照提 FORMED**（冲突是真实信号；
 *      DISPUTED/SUPERSEDED 的生命周期归 WP4 Validator + WP5，不猜）。
 */
export class RuleBasedBeliefEvaluator {
  readonly name = BELIEF_INTERACTION_EVALUATOR_NAME
  readonly version = BELIEF_INTERACTION_EVALUATOR_VERSION

  async process(
    input: BeliefEvaluationInput,
    _context: ProcessorContext,
  ): Promise<BeliefEvaluationOutcome> {
    const slotKey = beliefSlotKeyOf({
      perspectiveOwnerId: input.perspectiveOwnerId,
      subject: input.subject,
      predicate: BELIEF_INFERRED_PREDICATE,
      scopeKey: BELIEF_INFERRED_SCOPE,
    })

    const { qualified, missingConversation } = qualifiedBeliefEvidence(input.views, input.policy)
    const abstentions: BeliefAbstention[] = missingConversation.map((view) => ({
      sourceEventId: view.id,
      reason: 'missing_conversation_dimension' as const,
    }))

    // ---- 逐事件判定：命中记根，silent 记具名弃权 ---------------------------
    const noted: NotedRoot[] = []
    for (const view of qualified) {
      const verdict = judgeExplanationDetail(view.content)
      if (verdict.value === undefined) {
        abstentions.push({
          sourceEventId: view.id,
          reason: verdict.abstainReason ?? 'no_style_signal',
          ...(verdict.guardId !== undefined ? { guardId: verdict.guardId } : {}),
        })
        continue
      }
      noted.push({ view, value: verdict.value, patternId: verdict.patternId ?? 'unknown' })
    }

    // ---- EVIDENCE_NOTED：每根一提案（记录层；去重归投影/Validator） --------
    const proposals: DomainProposal<BeliefProposalAudit>[] = noted.map((root) =>
      buildEvidenceProposal({
        characterId: input.characterId,
        perspectiveOwnerId: input.perspectiveOwnerId,
        subject: input.subject,
        view: root.view,
        value: root.value,
        patternId: root.patternId,
      }),
    )

    // ---- 按 (槽位, 值) 分组合并累计，判定 FORMED / REINFORCED --------------
    const byValue = new Map<BeliefInferredValue, NotedRoot[]>()
    for (const root of noted) {
      const list = byValue.get(root.value)
      if (list === undefined) {
        byValue.set(root.value, [root])
      } else {
        list.push(root)
      }
    }

    for (const [value, roots] of byValue) {
      const accumulation =
        input.slotState?.accumulation !== undefined && input.slotState.accumulation.value === value
          ? input.slotState.accumulation
          : undefined

      // 合并根：现有累计 + 新根，按 id 去重（INV-M9-04/08）
      const seen = new Set<string>(accumulation?.rootIds.map(String) ?? [])
      const combinedRoots: ConversationEventId[] = accumulation
        ? [...accumulation.rootIds]
        : []
      const newRootIds: ConversationEventId[] = []
      for (const root of roots) {
        if (!seen.has(String(root.view.id))) {
          seen.add(String(root.view.id))
          combinedRoots.push(root.view.id)
          newRootIds.push(root.view.id)
        }
      }
      const combinedConversations = mergeUnique(
        accumulation?.conversationIds ?? [],
        roots.map((r) => String(r.view.conversationId)),
      )

      // 窗口 ≤50 的"最近"口径：只取最近 50 根参与阈值判定（旧根不失效）
      const windowedRoots = combinedRoots.slice(-BELIEF_INFERRED_WINDOW_LIMIT)
      const windowedConversations = mergeUnique(
        accumulation?.conversationIds ?? [],
        // 窗口内根的会话（从 combinedRoots 窗口切片反查——新根的会话在 roots 里）
        windowedRoots
          .filter((id) => roots.some((r) => String(r.view.id) === String(id)))
          .map((id) => String(roots.find((r) => String(r.view.id) === String(id))!.view.conversationId)),
      )

      const activeBelief = input.slotState?.activeBelief
      if (activeBelief !== undefined && activeBelief.value === value) {
        // 同值现存：**新根即强化**——不需要重新跨阈值（信念已存在；阈值闸
        // 只管 FORMED）。去重后非空才提；空 = 幂等静默。
        const genuinelyNew = newRootIds.filter(
          (id) => !activeBelief.rootIds.some((r) => String(r) === String(id)),
        )
        if (genuinelyNew.length > 0) {
          proposals.push(
            buildReinforcedProposal({
              characterId: input.characterId,
              beliefId: activeBelief.beliefId,
              newRootIds: genuinelyNew,
            }),
          )
        }
        continue
      }

      // FORMED 路径：阈值闸在这里（≥3 独立根 · 跨 ≥2 会话）
      const thresholdMet = beliefInferredThresholdMet({
        rootIds: windowedRoots,
        conversationIds: windowedConversations,
      })
      if (!thresholdMet) continue

      // 无现存（或异值现存——冲突信号照提，生命周期归 Validator/WP5）
      const formationKey = String(
        Math.max(...windowedRoots.map((id) => Number(String(id).split(':').pop() ?? 0))),
      )
      proposals.push(
        buildFormedProposal({
          characterId: input.characterId,
          perspectiveOwnerId: input.perspectiveOwnerId,
          subject: input.subject,
          slotKey,
          value,
          combinedRoots: windowedRoots,
          combinedConversations: windowedConversations,
          formationKey,
        }),
      )
    }

    return { proposals, abstentions, notedCount: noted.length }
  }
}

function mergeUnique(existing: readonly string[], additions: readonly string[]): string[] {
  const seen = new Set<string>(existing)
  const out = [...existing]
  for (const item of additions) {
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

/**
 * 累计投影键（(槽位, 值) 复合——value 不进**信念槽位键**，但进**累计键**：
 * detailed 的证据不支持 concise，混值累计会形成不连贯命题）。
 */
export function beliefEvidenceKeyOf(slotKey: string, value: BeliefInferredValue): string {
  return `${slotKey}|${value}`
}

/** 累计投影类型（Job 层读投影用；与 WP4 reducer 写侧同一函数） */
export function beliefEvidenceProjectionTypeForKey(evidenceKey: string): string {
  return beliefEvidenceProjectionTypeOf(evidenceKey)
}

// 冻结阈值重导出（Job/测试用；单一语义源）
export {
  BELIEF_INFERRED_MIN_CONVERSATIONS,
  BELIEF_INFERRED_MIN_ROOTS,
  BELIEF_INFERRED_WINDOW_LIMIT,
}
