/**
 * DomainProposal —— **"我认为应该这么理解"**，而不是事实。
 *
 * ============================================================================
 *  铁律 4：LLM 只能提出状态变化，不能直接修改 canonical state
 * ============================================================================
 *
 *     Proposal  ≠ Event
 *     Proposal  ≠ Memory
 *     Proposal  ≠ State
 *
 * 唯一合法的变更链是：
 *
 *     Proposal → Validator → DomainEvent → Reducer → Projection
 *
 * 因此模型再聪明，也只是"提出解释的人"；真正拥有苏沐薇状态的是 Character Kernel。
 *
 * 本文件同时定义了未来所有认知模块共用的基类语义——
 * `MemoryCandidate` / `RelationshipImpactProposal` / `AffectImpactProposal` /
 * `BeliefProposal` / `GoalProposal` / `ReflectionProposal` 全部继承同一形状。
 */

import {
  KernelError,
  type CharacterId,
  type ConversationEventId,
  type DomainEventId,
  type ProposalId,
  type ProcessorVersion,
  newProposalId,
} from './ids.ts'
import type { DomainEventScope, DomainEventType } from './domain-event.ts'
import { storySourceRefOf, type StorySourceRef } from './source-authority.ts'

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/**
 * 提案指向的操作类型。
 *
 * 它进幂等键（plan 第 34 节：`character + processor + version + source + operation`），
 * 因此**必须是受控枚举**：自由字符串会让"重试"和"新操作"无法区分。
 */
export type ProposalOperation =
  | 'signal' // 诊断信号（M2.5 唯一在用）
  | 'create' // 新建一条认知
  | 'update' // 同一条认知内容变化，身份不变
  | 'supersede' // 新认知取代旧认知（旧条留痕、不再是现状）
  | 'retract' // 认知被撤回（承认自己之前说错了）
  | 'delete' // 显式遗忘
  | 'merge' // 多条合成一条
  | 'reinforce' // 已有认知得到新证据（不改变内容）
  /**
   * M4：标记为"存在矛盾证据、系统还判不了"（计划书第 33 / 82 节的 `MARK_DISPUTED`）。
   *
   * ============================================================================
   *  为什么不能复用 `update`（这个值存在的**唯一**理由）
   * ============================================================================
   * `operation` 会进幂等键（见 `job.ts` 的 `computeIdempotencyKey()` 第五个分量）。
   * 若用 `update` 表达"标记争议"，那么
   *
   *     同一批事件 + 同一 processor 版本 + operation='update'
   *
   * 会让「标记为争议」与「普通内容更新」算出**同一个幂等键**，
   * 于是"重试"与"新操作"再也区分不开 ——
   * 而这正是 `proposal.ts` 开头写明"必须是受控枚举"的原因。
   *
   * M4 的审计（`docs/m4/compatibility-audit.md` §6 F3）确认过：
   * 计划书第 49 节的六个 `PolicyDecision` 里，
   * 只有 `MARK_DISPUTED` 没有对应的 `operation`。
   */
  | 'dispute'

/** 提案生命周期（plan 第 20 节）。M2.5 不强制持久化全部提案，但接口必须支持 */
export type ProposalStatus = 'created' | 'accepted' | 'rejected' | 'failed'

// ---------------------------------------------------------------------------
// 提案
// ---------------------------------------------------------------------------

/**
 * 一个 Processor 希望在 Domain 上生效的**单个**变化。
 *
 * 之所以是"一组"而不是"一个"：未来的 Memory Extractor 一轮对话常常
 * 同时产出多条候选（一条 fact + 一条 preference + 一条 episode），
 * 它们共享同一个语义判断上下文，应当作为一个提案被整体校验。
 */
export interface ProposedDomainEvent {
  type: DomainEventType
  operation: ProposalOperation
  /** 已经是 DomainEvent 形状的 payload（Processor 负责结构转换） */
  payload: unknown
  /**
   * M3.5（计划书第 42 节）：这条领域事件声称自己描述的是什么范围。
   *
   * 缺省 = `CHARACTER_INTERNAL`（当前唯一合法的值）。
   * 它的存在不是为了"多一个开关"，而是为了让**越界这件事可被机器发现**：
   * 未来有人想借角色变化历史记一条世界事实，Validator 会直接拒掉整个提案，
   * 而不是让那条记录悄悄进库（append-only，写进去就撤不回来）。
   */
  scope?: DomainEventScope

  /**
   * **M11（ADR-085 `D25`）**：这条领域事件**由哪些已提交的领域事件派生而来**。
   *
   * 为什么需要它：M11 的反思是**派生结论**。若不记录派生链，同一份原始经历
   * 经 Memory → Belief → Reflection 会被读成三份独立支持（Reflection 自我强化）。
   * 字段本身在 M2.5 就已经预留在 `DomainEvent` / `NewDomainEvent` 上，但**从未被
   * 写入过**（`event-store.ts` 一直写 `null`）—— 本里程碑把这条链**贯通**。
   *
   * 契约（Validator 在写入前逐条检查，失败关闭）：
   *   · 数组非空、元素非空字符串、**无重复**（结构检查在 `createProposal`）；
   *   · 每个父事件**必须已存在**、**同 character**；
   *   · ⇒ 父事件的序号必然**小于**本次新事件将要分配的序号（"早于"由此成立）；
   *   · 因此**新事件不可能制造环**（边只向后指）；环检测是**读旧数据**时 resolver 的职责。
   *
   * 缺省（`undefined`）= 旧调用者的形状 ⇒ 写入 `null`，**不补写历史事件**。
   */
  causedByDomainEventIds?: DomainEventId[]
}

export interface DomainProposal<TRawPayload = unknown> {
  proposalId: ProposalId

  characterId: CharacterId

  /** 提案种类（如 `diagnostic-signal`、未来的 `memory-candidate`） */
  proposalType: string

  /**
   * 证据来源：**必须是真实对话事件**。
   * 空数组是合法的（有些提案确实不引用对话，例如系统维护类），
   * 但那类提案在 M2.5 不存在——M2.5 的 Validator 要求至少一条。
   */
  sourceConversationEventIds: ConversationEventId[]

  /**
   * **S8 / ADR-093 `D03`**：这次提案引用了**哪几次故事经历**（可选，只追加）。
   *
   * ```text
   * 缺省（不写这个字段）= 没有故事来源 —— 与 S8 之前**逐字相同**
   * 有值              = 每条都必须可解析（storySourceRefOf 的读回自检）
   * ```
   *
   * ⚠️ 它**不**减轻 `sourceConversationEventIds` 的语义：后者仍然只指对话事件（`S8-A05`）。
   */
  sourceStoryRefs?: StorySourceRef[]

  /**
   * Processor 的**语义产出**（建议内容本身）。
   *
   * 与 `targetEvents[].payload` 的区别：这是"建议"，可以包含 confidence、
   * 自然语言解释、LLM 原始结构化输出等不进 DomainEvent 的东西，
   * 保留下来是为了审计（"它当时凭什么这么建议"）。
   */
  payload: TRawPayload

  /** 校验通过后要真正写入的领域事件（只含进 DomainEvent 的字段） */
  targetEvents: ProposedDomainEvent[]

  /** 0..1。缺失表示该 Processor 不表达置信度（例如纯规则信号） */
  confidence?: number

  /** 产生提案的组件名与版本（版本独立于应用版本） */
  processor: string
  processorVersion: ProcessorVersion

  /** 生命周期状态；Validator 通过后置为 accepted */
  status: ProposalStatus

  createdAt: number
}

export interface NewProposal<TRawPayload = unknown> {
  characterId: CharacterId
  proposalType: string
  sourceConversationEventIds: ConversationEventId[]
  /** S8：故事来源引用（可选，只追加；见 `DomainProposal.sourceStoryRefs`） */
  sourceStoryRefs?: StorySourceRef[]
  payload: TRawPayload
  targetEvents: ProposedDomainEvent[]
  confidence?: number
  processor: string
  processorVersion: ProcessorVersion
  createdAt?: number
}

/**
 * 构造提案。
 *
 * 这里只做**结构性**检查（该有的字段没有、confidence 越界），
 * 业务规则的检查全部归 Validator —— 否则校验逻辑会散落在各处，
 * 出现"某个 Processor 自己放行自己"的情况。
 */
export function createProposal<TRawPayload>(
  input: NewProposal<TRawPayload>
): DomainProposal<TRawPayload> {
  if (input.processor.trim() === '') {
    throw new KernelError('validation_error', 'processor_missing', '提案缺少 processor 名称')
  }
  if (input.processorVersion.trim() === '') {
    throw new KernelError(
      'validation_error',
      'processor_version_missing',
      '提案缺少 processorVersion（版本必须独立于应用版本）'
    )
  }
  if (input.targetEvents.length === 0) {
    throw new KernelError(
      'validation_error',
      'proposal_without_target',
      '提案没有任何 targetEvents：无法生效的提案应当在 Processor 内部就被丢弃'
    )
  }
  if (
    input.confidence !== undefined &&
    (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
  ) {
    throw new KernelError(
      'validation_error',
      'bad_confidence',
      `confidence 必须在 [0,1]，收到 ${String(input.confidence)}`
    )
  }

  /*
   * M11（ADR-085 `D25`）：派生链的**结构**检查放在这里，语义检查（父是否存在 / 同角色）
   * 归 Validator —— 与"结构性 vs 业务规则"的既有分工一致。
   *
   * ⚠️ 空数组**不是**"没有派生"的表达方式：没有派生就**不写这个字段**（写 null）。
   *    允许空数组会让"派生自零个东西"与"没有这个字段"在库里长得一样，
   *    而那正是 D05 去重与 D10 门槛赖以成立的前提。
   */
  for (const target of input.targetEvents) {
    const parents = target.causedByDomainEventIds
    if (parents === undefined) continue
    if (!Array.isArray(parents) || parents.length === 0) {
      throw new KernelError(
        'validation_error',
        'caused_by_malformed',
        `${target.type} 的 causedByDomainEventIds 必须是非空数组（没有派生就省略该字段）`
      )
    }
    const seen = new Set<string>()
    for (const parent of parents) {
      if (typeof parent !== 'string' || parent.trim() === '') {
        throw new KernelError(
          'validation_error',
          'caused_by_malformed',
          `${target.type} 的 causedByDomainEventIds 含非字符串或空元素：${JSON.stringify(parent)}`
        )
      }
      if (seen.has(parent)) {
        throw new KernelError(
          'validation_error',
          'caused_by_duplicate',
          `${target.type} 的 causedByDomainEventIds 含重复元素：${parent}（重复的父事件不能多计一次）`
        )
      }
      seen.add(parent)
    }
  }

  return {
    proposalId: newProposalId(),
    characterId: input.characterId,
    proposalType: input.proposalType,
    sourceConversationEventIds: [...input.sourceConversationEventIds],
    /*
     * S8：故事引用**逐条读回自检**（不是原样透传）。
     * 缺省 ⇒ 不写这个字段（旧调用方行为逐字不变，`S8-A18`）。
     */
    ...(input.sourceStoryRefs === undefined || input.sourceStoryRefs.length === 0
      ? {}
      : {
          sourceStoryRefs: input.sourceStoryRefs.map((ref) =>
            storySourceRefOf({ sourceId: ref.sourceId, experienceScope: ref.experienceScope })
          ),
        }),
    payload: input.payload,
    targetEvents: input.targetEvents.map((t) => ({ ...t })),
    confidence: input.confidence,
    processor: input.processor,
    processorVersion: input.processorVersion,
    status: 'created',
    createdAt: input.createdAt ?? Date.now(),
  }
}

/** 校验结果：通过则返回"待写入的领域事件"（仍无 id / sequence） */
export interface ValidationOutcome {
  proposalId: ProposalId
  accepted: ProposedDomainEvent[]
  rejected: ProposalRejection[]
}

export interface ProposalRejection {
  type: DomainEventType
  code: string
  message: string
}

export const hasAcceptedWork = (outcome: ValidationOutcome): boolean =>
  outcome.accepted.length > 0
