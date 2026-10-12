/**
 * Goal **提案契约**（M10 WP4 / ADR-076 §7.2 · §7.3 · `D07` · `D28`）。
 *
 * ============================================================================
 *  这个文件是什么、不是什么
 * ============================================================================
 *  · **是**：模型（或固定 provider）被允许产出的**有界**形状 —— 一个闭集操作 +
 *    原文 span + 可选字段 + 歧义原因；以及**严格**的结构校验器。
 *  · **不是**：授权 / 持久化 / 完成判定。放行口在 `policies/goal-validator.ts`，
 *    它看的是 `GoalProposal`（程序侧），**不是**本文件的 `GoalProposalDraft`。
 *
 * ============================================================================
 *  四条硬边界（都是判据，不是注释）
 * ============================================================================
 * ① **闭集**：操作、字段名、枚举值都在受控登记表里。未知字段 / 未知枚举
 *    ⇒ **非法输出**（`invalid`），**不当** `none`（计划 §7.2 第 1 条：
 *    "非法输出记录为 invalid，不当 none" —— 把故障读成"她没提目标"是最坏的失败模式）。
 * ② **不得编造 id**：草案里**没有** `goalId` / `userId` / `eventId` / `evidenceId`
 *    这些"程序事实"字段的位置 —— 候选目标只能从**程序给定**的集合里选
 *    （`candidateGoalIds`），且选了不存在的 id ⇒ `goal_proposal_goal_not_found`。
 * ③ **span 必须是原话范围**：`0 ≤ start < end ≤ 原话码点长度`，且**不**接受
 *    "生成文字替代原文证明"（草案不携带任何文本，只有坐标 —— 文本一律由调用方
 *    从原话里切，因此"用生成的字当证据"在**类型上**不可能）。
 * ④ **采纳必须能定位提议**（`D28`）：`character_proposed` 必须同时给出
 *    `proposedByAssistantEventId` 与两个 span（提议侧 + 采纳侧）；
 *    跨轮无法唯一定位 ⇒ `clarify`，**不得**猜。
 *
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 */

import {
  COMMITMENT_SCOPE_MAX_CODEPOINTS,
  GOAL_PRIORITIES,
  isGoalOrigin,
  isGoalPriority,
  type GoalOrigin,
  type GoalPriority,
  type GoalSuccessCriterion,
} from './goal.ts'

/** 草案 schema 版本（改形状必须升版本） */
export const GOAL_PROPOSAL_SCHEMA_VERSION = 'goal-proposal@2'
/** 历史单目标草案继续可读；批量完成只属于 @2。 */
export const GOAL_PROPOSAL_LEGACY_SCHEMA_VERSION = 'goal-proposal@1'
export const GOAL_COMPLETION_MAX_TARGETS = 12

/**
 * 模型可产出的**操作闭集**。
 *
 * ⚠️ 它与 `GoalOperation`（领域操作）**不是一个东西**：
 *   · 本闭集描述"用户这句话想做什么"，含 `none` / `query` / `clarify` 三个
 *     **不产生领域事件**的值；
 *   · `GoalOperation` 描述"要写哪个领域事件"。
 * 两者的映射在 `app/goal/understanding.ts`（一处），**不**在契约层混同。
 */
export type GoalProposalOperation =
  | 'none'
  | 'create'
  | 'revise'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'report_complete'
  | 'query'
  | 'clarify'

export const GOAL_PROPOSAL_OPERATIONS: readonly GoalProposalOperation[] = [
  'none',
  'create',
  'revise',
  'pause',
  'resume',
  'cancel',
  'report_complete',
  'query',
  'clarify',
]

export function isGoalProposalOperation(value: unknown): value is GoalProposalOperation {
  return typeof value === 'string' && (GOAL_PROPOSAL_OPERATIONS as readonly string[]).includes(value)
}

/** 需要写领域事件的操作（其余三个 `none` / `query` / `clarify` 不写） */
export const GOAL_PROPOSAL_WRITING_OPERATIONS: readonly GoalProposalOperation[] = [
  'create',
  'revise',
  'pause',
  'resume',
  'cancel',
  'report_complete',
]

/** 取消的三种细分原因（与领域 `GoalCancelReason` 的**子集**对应） */
export type GoalProposalCancelKind = 'user_cancel' | 'user_waived' | 'explicit_forget'

export const GOAL_PROPOSAL_CANCEL_KINDS: readonly GoalProposalCancelKind[] = [
  'user_cancel',
  'user_waived',
  'explicit_forget',
]

/** 歧义 / 非法输出的**具名原因**（可读回，不合并） */
export type GoalDraftRejectionReason =
  | 'not_an_object'
  | 'schema_version_missing_or_unknown'
  | 'unknown_field'
  | 'operation_missing_or_unknown'
  | 'span_missing_or_out_of_range'
  | 'span_not_in_source'
  | 'candidate_goal_not_provided'
  | 'adoption_reference_missing'
  | 'field_missing_for_operation'
  | 'field_present_for_operation'
  | 'enum_value_unknown'
  | 'text_too_long'
  | 'commitment_draft_invalid'

export const GOAL_DRAFT_REJECTION_REASONS: readonly GoalDraftRejectionReason[] = [
  'not_an_object',
  'schema_version_missing_or_unknown',
  'unknown_field',
  'operation_missing_or_unknown',
  'span_missing_or_out_of_range',
  'span_not_in_source',
  'candidate_goal_not_provided',
  'adoption_reference_missing',
  'field_missing_for_operation',
  'field_present_for_operation',
  'enum_value_unknown',
  'text_too_long',
  'commitment_draft_invalid',
]

/** 每个原因的**可达性事实**（沿用 `memory-record-status.ts` / `goal-reference.ts` 的纪律） */
export interface GoalDraftRejectionFact {
  readonly reachable: boolean
  readonly producer: string
  readonly blocker?: string
}

export const GOAL_DRAFT_REJECTION_FACTS: Readonly<
  Record<GoalDraftRejectionReason, GoalDraftRejectionFact>
> = {
  not_an_object: { reachable: true, producer: 'validateGoalProposalDraft · 顶层不是对象' },
  schema_version_missing_or_unknown: {
    reachable: true,
    producer: 'validateGoalProposalDraft · 缺 schemaVersion 或值不等',
  },
  unknown_field: { reachable: true, producer: 'validateGoalProposalDraft · 出现闭集外的字段名' },
  operation_missing_or_unknown: {
    reachable: true,
    producer: 'validateGoalProposalDraft · operation 不在闭集',
  },
  span_missing_or_out_of_range: {
    reachable: true,
    producer: 'validateGoalProposalDraft · span 缺失 / start≥end / 超出原话长度',
  },
  span_not_in_source: {
    reachable: true,
    producer: 'validateGoalProposalDraft · span 落在原话之外（与长度上限分开的两个原因）',
  },
  candidate_goal_not_provided: {
    reachable: true,
    producer: 'validateGoalProposalDraft · targetGoalId 不在程序给的候选集合里',
  },
  adoption_reference_missing: {
    reachable: true,
    producer: 'validateGoalProposalDraft · character_proposed 缺提议侧引用或采纳 span',
  },
  field_missing_for_operation: {
    reachable: true,
    producer: 'validateGoalProposalDraft · 该操作必需的字段缺失',
  },
  field_present_for_operation: {
    reachable: true,
    producer: 'validateGoalProposalDraft · 该操作不应带的字段出现了（防"顺手多写一个"）',
  },
  enum_value_unknown: { reachable: true, producer: 'validateGoalProposalDraft · 枚举值不在闭集' },
  text_too_long: { reachable: true, producer: 'validateGoalProposalDraft · 自由文本超过上界' },
  commitment_draft_invalid: {
    reachable: true,
    producer: 'validateGoalProposalDraft · 承诺草案形状非法（不是对象 / scope 空白 / criterion 不是对象）',
  },
}

// ---------------------------------------------------------------------------
// 草案形状
// ---------------------------------------------------------------------------

/** 原话里的一个**坐标**（**不含文本** —— 文本一律由调用方从原话切） */
export interface SourceSpan {
  readonly start: number
  readonly end: number
}

/**
 * 草案。
 *
 * ⚠️ 刻意**没有** `goalId` / `userId` / `sourceEventId` / `evidenceId`：
 *    模型不能编造程序事实（计划 §7.2）。它只能：
 *      · 用 `targetGoalId` 从**程序给的候选集**里选一个；
 *      · 用 `span` 指出**哪几个字**是它的依据（文本由调用方切）。
 */
export interface GoalProposalDraft {
  readonly schemaVersion: typeof GOAL_PROPOSAL_SCHEMA_VERSION | typeof GOAL_PROPOSAL_LEGACY_SCHEMA_VERSION
  readonly operation: GoalProposalOperation
  /** 本操作依据的**原话范围**（必填） */
  readonly span: SourceSpan

  // --- 只有部分操作需要的字段（闭集；不该带的带了 = 拒绝）------------------
  /** `revise` / `pause` / `resume` / `cancel` / `report_complete` / `query`：从候选集里选 */
  readonly targetGoalId?: string
  /** `report_complete` / `query`：明确的目标集合，与 targetGoalId 互斥。 */
  readonly targetGoalIds?: readonly string[]
  /** `create`：目标描述（受 §4.1 的 500 码点上界约束） */
  readonly statement?: string
  /** `create`：来源（`user_requested` / `character_proposed`） */
  readonly origin?: GoalOrigin
  /** `create` + `character_proposed`：提议来自哪条**已落库**的 assistant 事件 */
  readonly proposedByAssistantEventId?: string
  /** `create` + `character_proposed`：提议侧的原文范围（采纳侧是 `span`） */
  readonly proposalSpan?: SourceSpan
  /** `create`：优先级（缺省 `normal`） */
  readonly priority?: GoalPriority
  /** `revise`：改了哪几项（闭集在放行口） */
  readonly changed?: readonly string[]
  /** `revise`：新的当前步骤 */
  readonly nextStep?: string
  /** `cancel`：取消的细分原因 */
  readonly cancelKind?: GoalProposalCancelKind
  /** `clarify`：为什么要澄清（非空；**不含**被忘取值） */
  readonly clarifyReason?: string
  /**
   * `create`：随目标**一并接受**的一条承诺（**M10.1 追加**；可选）。
   *
   * ⚠️ 为什么要有它：M10 交付了承诺的**契约与放行口**，但**提案侧从来没有表达它的字段**
   *    ⇒ `COMMITMENT_ACCEPTED` 在生产里没有生产者（详见 `docs/m10.1/M10.1-WP2-Finding.md`）。
   *    本字段是那条断链的**唯一**接入点：它出现在 `create` 的提案里，
   *    `app/goal/understanding.ts` 据此**追加**一个 `COMMITMENT_ACCEPTED` target。
   *
   * ⚠️ 边界：`commitmentId` / `goalId` **不在这里**（由放行口按材料算，模型编不了）；
   *    判据（`criterion`）必须落在放行口的闭集内（v1 只正式接受两类可观察承诺）。
   */
  readonly commitment?: GoalCommitmentDraft
}

/**
 * `create` 时随目标一并接受的**承诺草案**（M10.1 追加）。
 *
 * ⚠️ 有界：`scope` 受 `COMMITMENT_SCOPE_MAX_CODEPOINTS` 约束；`acceptanceEventIds`
 *    非空且有上界（"双方接受"这件事**必须有出处**）。
 */
export interface GoalCommitmentDraft {
  /** 承诺范围（有界；原文不进程，只有指纹进程） */
  readonly scope: string
  /** 判据（闭集在放行口：v1 只正式接受两类可观察承诺 + M10.1 追加的 `user_report`） */
  readonly criterion: GoalSuccessCriterion
  /**
   * **接受**这件事的依据（**程序侧**构造器填；模型面**不许**写）。
   *
   * ⚠️ **M10.1 / R-29 起它是可选的**，因为同一个类型有两个调用方，而它们的资格不同：
   * ```text
   * · **程序侧**（`buildAgreementProposal`）：它手里有协议的两条出处 ⇒ 填非空 id 列表
   *   （"双方接受这件事有出处"）。这是**默认**路径。
   * · **模型面**（`validateGoalProposalDraft` 放行的草案）：模型**编不了 id**
   *   ⇒ 内层闭集 `GOAL_COMMITMENT_DRAFT_FIELDS` 里**没有**它，出现即 `unknown_field`；
   *   映射层（`understanding.ts`）改用**程序事实**——本轮那条用户事件（`sourceRef`）。
   * ⇒ 写成"可选"是**如实的类型**：模型面产出的草案里它就是不存在，而不是"忘了填"。
   * ```
   */
  readonly acceptanceEventIds?: readonly string[]
  /*
   * ⚠️ **刻意没有** `dueAt` / `dueBasis`（M10.1 起草时加过，**已撤回**）。
   *
   *    理由：`m10:test` 的 **G36** 断言"目标域**生产侧**里没有任何一处写 `dueAt`"
   *    —— 那是"**不猜日期**"的**结构性**判据。草案是**模型产出**的东西，
   *    给它一个日期字段就等于**让模型提议日期** ⇒ 直接破掉 G36 的意图。
   *    ⇒ 截止时间只存在于**程序侧**的 `GoalState.time.dueAt`（今天**没有任何生产路径**会设置它 ——
   *      这本身是 M10 的既有状态，见 `docs/m10.1/M10.1-WP3-Handoff.md` 的 `U-04`）。
   *      到期机制只**读**它，不产生它。
   */
}

/** 承诺草案的接受引用上界 */
export const GOAL_COMMITMENT_DRAFT_MAX_ACCEPTANCE_REFS = 4

/**
 * 字段名 → "哪些操作允许带它"。
 *
 * ⚠️ 这张表是**双向**判据：必需字段缺失与**不该带的字段出现**都拒绝。
 *    只判前者会让"模型顺手多写一个字段"静默通过 —— 而那个字段很可能
 *    正是它想偷偷绕过的东西（例如在 `pause` 上带 `statement` 试图改描述）。
 */
export const GOAL_DRAFT_FIELD_ALLOWLIST: Readonly<
  Record<string, readonly GoalProposalOperation[]>
> = {
  schemaVersion: GOAL_PROPOSAL_OPERATIONS,
  operation: GOAL_PROPOSAL_OPERATIONS,
  span: GOAL_PROPOSAL_OPERATIONS,
  targetGoalId: ['revise', 'pause', 'resume', 'cancel', 'report_complete', 'query'],
  targetGoalIds: ['report_complete', 'query'],
  /*
   * ⚠️ **`statement` 必须同时允许 `create` 与 `revise`**（WP9-B 的长轨迹门抓到）。
   *
   * 内核的 `GOAL_REVISABLE_FIELDS` **包含 `'statement'`**，映射层 `revise` 分支
   * 也**已经**会读 `draft.statement` —— 但第一版这张表只允许 `create` 带它。
   * 后果不是"拒绝了一个坏输入"，而是**"用户要求改描述"这件事在草案层根本无法表达**：
   * 模型只能产出一个被结构校验判死的草案 ⇒ 200 轮轨迹里 10 次修订**全部**
   * 停在 `invalid_output`。
   *
   * ⇒ 契约自己**不自洽**：可修订字段里有它，可携带字段里没有它。
   *    修法是让这张表与内核一致（`pause` 上带 `statement` **仍然**被拒 —— 见 `C10`）。
   */
  statement: ['create', 'revise'],
  origin: ['create'],
  proposedByAssistantEventId: ['create'],
  proposalSpan: ['create'],
  priority: ['create', 'revise'],
  changed: ['revise'],
  nextStep: ['create', 'revise'],
  cancelKind: ['cancel'],
  clarifyReason: ['clarify'],
  /*
   * ⚠️ **M10.1 / R-29**：`commitment` 原先**不在**这张表里 ⇒ `validateGoalProposalDraft` 的闭集检查
   *    对任何带它的模型草案判 `unknown_field` ⇒ **"她提出并接受一条承诺"在契约层无法表达**
   *    （`GoalProposalDraft.commitment` 的注释却把它写成"那条断链的**唯一**接入点"）。
   *    形状与 `statement` 那次（见上面 👆）**同族**：类型里有、可携带字段表里没有。
   *    修法：只允许 `create` 带它（`revise` 带上仍被 `field_present_for_operation` 拒）。
   */
  commitment: ['create'],
}

/**
 * **模型面**承诺草案的字段闭集（`commitment` 对象的内部字段）。
 *
 * ⚠️ 它**小于** `GoalCommitmentDraft`：后者还带 `acceptanceEventIds`，那是**程序侧构造器**
 *    （`buildAgreementProposal`）该填的 —— "双方接受这件事有出处"**是程序事实**，
 *    模型写 id 就是编造程序事实（计划 §7.2）⇒ 模型面出现 `acceptanceEventIds`（或任何内层闭集外字段）
 *    一律 `unknown_field`，**不静默丢弃**（失败关闭）。
 */
export const GOAL_COMMITMENT_DRAFT_FIELDS = ['scope', 'criterion'] as const

/**
 * **模型面**承诺草案允许的判据（`criterion.kind`）。
 *
 * ⚠️ 它是放行口闭集 `COMMITMENT_ACCEPTABLE_CRITERIA` 的**真子集**，刻意**更窄**：
 * ```text
 * · `action_result` 要模型给出 `capability` / `operation` —— 那是**程序能力名**
 *   （模型编一个不存在的能力就是编造程序事实）；且它的兑现判定要**真实动作结果**。
 * · `conversation_output` 要 `structure`（`item_count` / `marker_set`）—— 那是**可核对的程序物**。
 * ⇒ 这两档仍由**程序侧构造器**（`buildAgreementProposal`，判决在 WP2 的识别面）产生，
 *   **不从模型面进**。模型面只表达"这是一条约定，判据由**对方报告**确认"。
 * ```
 * ⚠️ 这**没有**收窄放行口：`COMMITMENT_ACCEPTABLE_CRITERIA` 一个字没改（那是 M10.1 的 `U-03-a` 裁定）。
 */
export const GOAL_COMMITMENT_DRAFT_CRITERIA = ['user_report'] as const

/**
 * 每个操作**必需**的字段（其余可缺省）。
 *
 * ⚠️ **`span` 对每个操作都必需** —— 这一点原先**只有校验器**在要求
 *    （`validateGoalProposalDraft` 里 `if (!isSpan(object.span)) reject(...)` 是**无条件**的），
 *    而这张表把它漏了（写成 `none: []` 之类）⇒ **契约自己不自洽**。
 *
 * ```text
 * 后果（实测，2026-09-30 语义门）：提示词是**从这张表派生**的 ⇒ 它没告诉模型 span 必填
 *   ⇒ 模型对 `none` 不给 span ⇒ 被校验器判 `span_missing_or_out_of_range` ⇒ **invalid**
 *   ⇒ 一轮 12 条里 7 次失败**全是这一类**（提示词与契约不同步的典型形状，与 WP9-B 那次同族）。
 * ⇒ 修法：把"校验器一直在要求的事"写进表里 ⇒ 提示词**同一次改动就跟着变**。
 * ```
 */
export const GOAL_DRAFT_REQUIRED_FIELDS: Readonly<
  Record<GoalProposalOperation, readonly string[]>
> = {
  /* `span` 是**每个操作**都要的（证据坐标：草案不携带文本，只有坐标 —— 见文件头硬边界 ③） */
  none: ['span'],
  create: ['span', 'statement', 'origin'],
  revise: ['span', 'targetGoalId'],
  pause: ['span', 'targetGoalId'],
  resume: ['span', 'targetGoalId'],
  cancel: ['span', 'targetGoalId', 'cancelKind'],
  report_complete: ['span'],
  /*
   * ⚠️ **`query` 不要求 `targetGoalId`** —— 这是 **2026-09-30 用户裁定**的一处**语义扩张**
   *    （在此之前它要求 `['targetGoalId']`）。
   *
   * ```text
   * 起因（F1，实测）：`query` 原先**必须**指出问的是**哪一条**目标，而
   *   "我们都有哪些目标来着"这类**列清单**的问题**没有单条目标**
   *   ⇒ 模型**表达不出来** ⇒ 只能退成 `clarify`（实测两次：clarify / none，都不是 query）
   *   ⇒ 一条**正当的用户提问**在草案层被结构性挡死。
   * 依据：`query` 走 `GOAL_NON_WRITING_OPERATIONS` 分支，产出的 fact 只有
   *   `{outcome:'query', operation, candidateCount}` —— **没有任何消费者读 `targetGoalId`**
   *   ⇒ "必须指明哪一条"是一条**纸面约束**，它唯一的实际效果就是挡住真实提问。
   * ```
   *
   * **语义（现在写清楚，免得下一个人以为是 bug）**：
   * ```text
   * 给了 `targetGoalId` ⇒ 问**那一条**的状态（仍必须落在程序给定的候选集里 —— 见下面的候选集检查）
   * 没给                ⇒ 问**清单**（"我有哪些目标"）
   * ```
   *
   * ⚠️ **它不改变任何用户可见行为**（今天没有消费者读它）；
   *    "她真的把目标念一遍"是**另一条链**（回复组装），不在这里，也**没有**因此被实现。
   */
  query: ['span'],
  clarify: ['span', 'clarifyReason'],
}

/** 自由文本的上界（与领域字段上界同源；这里只是"非法输出"的第一道闸） */
export const GOAL_DRAFT_STATEMENT_MAX_CODEPOINTS = 500
export const GOAL_DRAFT_CLARIFY_MAX_CODEPOINTS = 200

// ---------------------------------------------------------------------------
// 严格结构校验（**唯一**的草案放行点）
// ---------------------------------------------------------------------------

export type GoalDraftVerdict =
  | { readonly ok: true; readonly draft: GoalProposalDraft }
  | { readonly ok: false; readonly reason: GoalDraftRejectionReason; readonly detail: string }

export interface GoalDraftValidationInput {
  /** 本轮原话（用于 span 范围判定；**只读**，不进任何输出） */
  readonly sourceText: string
  /** 跨轮采纳时的提议原文；普通理解链由程序提供，与本轮接受原文分别校验。 */
  readonly proposalSourceText?: string
  /** **程序给定**的候选目标 id（模型只能从中选） */
  readonly candidateGoalIds: readonly string[]
}

function codePointLength(text: string): number {
  return [...text].length
}

function isSpan(value: unknown): value is SourceSpan {
  if (typeof value !== 'object' || value === null) return false
  const span = value as Record<string, unknown>
  return (
    typeof span.start === 'number' &&
    typeof span.end === 'number' &&
    Number.isInteger(span.start) &&
    Number.isInteger(span.end)
  )
}

/**
 * 校验一个草案。
 *
 * 顺序（越靠前越"结构"，越靠后越"语义"）：
 * 对象 → 版本 → 字段名闭集 → 操作闭集 → span 范围 → 字段的"该带不该带" → 枚举 → 上界
 * → 候选集 → 采纳引用。
 */
export function validateGoalProposalDraft(
  raw: unknown,
  input: GoalDraftValidationInput,
): GoalDraftVerdict {
  const reject = (
    reason: GoalDraftRejectionReason,
    detail: string,
  ): GoalDraftVerdict => ({ ok: false, reason, detail })

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return reject('not_an_object', '草案必须是 JSON 对象')
  }
  const object = raw as Record<string, unknown>

  if (object.schemaVersion !== GOAL_PROPOSAL_SCHEMA_VERSION && object.schemaVersion !== GOAL_PROPOSAL_LEGACY_SCHEMA_VERSION) {
    return reject(
      'schema_version_missing_or_unknown',
      `schemaVersion 必须是 ${GOAL_PROPOSAL_SCHEMA_VERSION}（收到 ${JSON.stringify(object.schemaVersion)}）`,
    )
  }

  const allowedTop = new Set(Object.keys(GOAL_DRAFT_FIELD_ALLOWLIST))
  for (const key of Object.keys(object)) {
    if (!allowedTop.has(key)) {
      return reject('unknown_field', `闭集外的字段：${key}`)
    }
  }

  if (!isGoalProposalOperation(object.operation)) {
    return reject(
      'operation_missing_or_unknown',
      `operation 必须是 ${GOAL_PROPOSAL_OPERATIONS.join(' | ')}（收到 ${JSON.stringify(object.operation)}）`,
    )
  }
  const operation = object.operation
  if (object.schemaVersion === GOAL_PROPOSAL_LEGACY_SCHEMA_VERSION && object.targetGoalIds !== undefined) {
    return reject('unknown_field', '历史 @1 草案不支持 targetGoalIds')
  }
  if (operation === 'report_complete' && (object.targetGoalId === undefined) === (object.targetGoalIds === undefined)) {
    return reject('field_missing_for_operation', 'report_complete 必须且只能提供 targetGoalId 或 targetGoalIds')
  }
  if (object.targetGoalId !== undefined && object.targetGoalIds !== undefined) {
    return reject('field_present_for_operation', '单项与批量目标范围不能同时提供')
  }

  /* ---- 字段的"该带不该带"（双向）---- */
  const required = GOAL_DRAFT_REQUIRED_FIELDS[operation]
  for (const field of required) {
    if (object[field] === undefined) {
      return reject('field_missing_for_operation', `${operation} 必需字段缺失：${field}`)
    }
  }
  for (const [field, ops] of Object.entries(GOAL_DRAFT_FIELD_ALLOWLIST)) {
    if (object[field] === undefined) continue
    if (!ops.includes(operation)) {
      return reject(
        'field_present_for_operation',
        `${operation} 不应带字段 ${field}（允许的操作：${ops.join('/')}）`,
      )
    }
  }

  /* ---- span ---- */
  if (!isSpan(object.span)) {
    return reject('span_missing_or_out_of_range', 'span 必须是 { start, end } 整数对')
  }
  const span = object.span
  const sourceLength = codePointLength(input.sourceText)
  if (span.start < 0 || span.end <= span.start) {
    return reject('span_missing_or_out_of_range', `span 非法：${String(span.start)}..${String(span.end)}`)
  }
  if (span.end > sourceLength) {
    return reject(
      'span_not_in_source',
      `span 越出原话范围：end=${String(span.end)} > 原话长度 ${String(sourceLength)}`,
    )
  }
  if (object.proposalSpan !== undefined) {
    if (!isSpan(object.proposalSpan)) {
      return reject('span_missing_or_out_of_range', 'proposalSpan 必须是 { start, end } 整数对')
    }
    const proposalSpan = object.proposalSpan
    const proposalLength = codePointLength(input.proposalSourceText ?? input.sourceText)
    if (
      proposalSpan.start < 0 ||
      proposalSpan.end <= proposalSpan.start ||
      proposalSpan.end > proposalLength
    ) {
      return reject(
        'span_not_in_source',
        `proposalSpan 越出提议原话范围：${String(proposalSpan.start)}..${String(proposalSpan.end)} / ${String(proposalLength)}`,
      )
    }
  }

  /* ---- 枚举 ---- */
  if (object.origin !== undefined && !isGoalOrigin(object.origin)) {
    return reject('enum_value_unknown', `origin 非法：${JSON.stringify(object.origin)}`)
  }
  if (object.priority !== undefined && !isGoalPriority(object.priority)) {
    return reject(
      'enum_value_unknown',
      `priority 必须是 ${GOAL_PRIORITIES.join(' | ')}（收到 ${JSON.stringify(object.priority)}）`,
    )
  }
  if (
    object.cancelKind !== undefined &&
    !(GOAL_PROPOSAL_CANCEL_KINDS as readonly string[]).includes(String(object.cancelKind))
  ) {
    return reject('enum_value_unknown', `cancelKind 非法：${JSON.stringify(object.cancelKind)}`)
  }

  /* ---- 上界 ---- */
  if (object.statement !== undefined) {
    if (typeof object.statement !== 'string' || object.statement.trim() === '') {
      return reject('field_missing_for_operation', 'statement 必须是非空字符串')
    }
    if (codePointLength(object.statement) > GOAL_DRAFT_STATEMENT_MAX_CODEPOINTS) {
      return reject(
        'text_too_long',
        `statement 超过 ${String(GOAL_DRAFT_STATEMENT_MAX_CODEPOINTS)} 码点`,
      )
    }
  }
  if (object.nextStep !== undefined) {
    if (typeof object.nextStep !== 'string' || object.nextStep.trim() === '') {
      return reject('field_missing_for_operation', 'nextStep 必须是非空字符串')
    }
  }
  if (object.clarifyReason !== undefined) {
    if (typeof object.clarifyReason !== 'string' || object.clarifyReason.trim() === '') {
      return reject('field_missing_for_operation', 'clarifyReason 必须是非空字符串')
    }
    if (codePointLength(object.clarifyReason) > GOAL_DRAFT_CLARIFY_MAX_CODEPOINTS) {
      return reject('text_too_long', 'clarifyReason 超过上界')
    }
  }
  if (object.changed !== undefined) {
    if (
      !Array.isArray(object.changed) ||
      object.changed.length === 0 ||
      object.changed.some((f) => typeof f !== 'string' || f.trim() === '')
    ) {
      return reject('field_missing_for_operation', 'changed 必须是非空字符串数组')
    }
  }

  /* -------------------------------------------------------------------------
   * 承诺草案（**M10.1 / R-29 的修复**：闭集表原先漏了 `commitment`）
   *
   * ⚠️ 这里定的是**模型面**的承诺字段集（`GOAL_COMMITMENT_DRAFT_FIELDS`），它**小于**
   *    `GoalCommitmentDraft`（后者还带 `acceptanceEventIds`，那是**程序侧构造器**
   *    `buildAgreementProposal` 才该填的东西）。**接受这件事的出处由程序给** ——
   *    模型写 id = 编造程序事实（计划 §7.2），所以内层闭集外的字段一律 `unknown_field`。
   * ----------------------------------------------------------------------- */
  if (object.commitment !== undefined) {
    const commitment = object.commitment
    if (typeof commitment !== 'object' || commitment === null || Array.isArray(commitment)) {
      return reject('commitment_draft_invalid', 'commitment 必须是对象')
    }
    for (const key of Object.keys(commitment)) {
      if (!(GOAL_COMMITMENT_DRAFT_FIELDS as readonly string[]).includes(key)) {
        return reject(
          'unknown_field',
          `承诺草案闭集外的字段：${key}（接受这件事的出处由程序给，模型编不了 id）`,
        )
      }
    }
    const scope = (commitment as Record<string, unknown>).scope
    if (typeof scope !== 'string' || scope.trim() === '') {
      return reject('commitment_draft_invalid', 'commitment.scope 必须是非空字符串')
    }
    if (codePointLength(scope) > COMMITMENT_SCOPE_MAX_CODEPOINTS) {
      return reject(
        'text_too_long',
        `commitment.scope 超过 ${String(COMMITMENT_SCOPE_MAX_CODEPOINTS)} 码点`,
      )
    }
    const criterion = (commitment as Record<string, unknown>).criterion
    if (typeof criterion !== 'object' || criterion === null || Array.isArray(criterion)) {
      return reject('commitment_draft_invalid', 'commitment.criterion 必须是对象')
    }
    const criterionKind = (criterion as Record<string, unknown>).kind
    if (!(GOAL_COMMITMENT_DRAFT_CRITERIA as readonly string[]).includes(String(criterionKind))) {
      return reject(
        'enum_value_unknown',
        `commitment.criterion.kind 非法：${JSON.stringify(criterionKind)}` +
          `（模型面只接受 ${GOAL_COMMITMENT_DRAFT_CRITERIA.join(' / ')}；` +
          '其余判据要程序能力名/结构，属**程序侧构造器**的面）',
      )
    }
  }

  /* ---- 候选集（模型只能从程序给的里面选）---- */
  if (object.targetGoalIds !== undefined) {
    if (!Array.isArray(object.targetGoalIds) || object.targetGoalIds.length === 0 ||
      object.targetGoalIds.length > GOAL_COMPLETION_MAX_TARGETS ||
      object.targetGoalIds.some(id => typeof id !== 'string' || id.trim() === '') ||
      new Set(object.targetGoalIds).size !== object.targetGoalIds.length) {
      return reject('field_missing_for_operation', `targetGoalIds 必须是 1–${GOAL_COMPLETION_MAX_TARGETS} 个不重复的候选 id`)
    }
    if (object.targetGoalIds.some(id => !input.candidateGoalIds.includes(id as string))) {
      return reject('candidate_goal_not_provided', 'targetGoalIds 含未提供的候选目标')
    }
  }
  if (object.targetGoalId !== undefined) {
    if (typeof object.targetGoalId !== 'string') {
      return reject('field_missing_for_operation', 'targetGoalId 必须是字符串')
    }
    if (!input.candidateGoalIds.includes(object.targetGoalId)) {
      return reject(
        'candidate_goal_not_provided',
        `targetGoalId=${object.targetGoalId} 不在程序给定的候选集合里（集合大小 ${String(input.candidateGoalIds.length)}）`,
      )
    }
  }

  /* ---- 采纳必须能定位提议（D28）---- */
  if (object.origin === 'character_proposed') {
    if (
      typeof object.proposedByAssistantEventId !== 'string' ||
      object.proposedByAssistantEventId.trim() === ''
    ) {
      return reject(
        'adoption_reference_missing',
        'character_proposed 必须给出 proposedByAssistantEventId（提议所在的那条已落库事件）',
      )
    }
    if (object.proposalSpan === undefined) {
      return reject(
        'adoption_reference_missing',
        'character_proposed 必须同时给出 proposalSpan（提议侧）与 span（采纳侧）；' +
          '跨轮无法唯一定位时应当 clarify，而不是猜',
      )
    }
  }

  return { ok: true, draft: object as unknown as GoalProposalDraft }
}

/** 便捷：只问"合不合法"（门与报告用） */
export function goalDraftIsValid(raw: unknown, input: GoalDraftValidationInput): boolean {
  return validateGoalProposalDraft(raw, input).ok
}
