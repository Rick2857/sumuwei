/**
 * Goal / Commitment 契约（M10 WP3 / ADR-076 §4.1–§4.5）。
 *
 * ============================================================================
 *  这个文件是什么、不是什么
 * ============================================================================
 *  · **是**：目标与承诺的**字段闭集**、状态闭集、操作词表（`D21`：领域自持）、
 *    身份派生（`D05`）、criterion 闭集（§4.5）、依赖分类（§4.6）、
 *    13 个事件的 payload 形状与**结构校验**（registry 用）。
 *  · **不是**：状态机放行（在 `policies/goal-validator.ts`）、折叠（在
 *    `projections/goal.ts`）、读写（在 `infrastructure/persistence/goal-store.ts`）。
 *
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 *
 * ============================================================================
 *  三条与既有域刻意不同的地方（都来自 ADR-076）
 * ============================================================================
 * ① **操作词表自持**（`D21`）：`GoalOperation` / `CommitmentOperation` 是**本域**的闭集，
 *    **不**扩展 `ProposalOperation`（依据 `memory-validator.ts:82` 的既有裁定：
 *    往共享词表里加值"会影响所有认知模块的语义"）。
 * ② **一个 Goal 一行，承诺住在行里**（`D03`）：投影行 `goal:<goalId>` 的 state 是
 *    `{ goal, commitment }`。事件历史**仍然分开**记录目标变化与承诺变化 ——
 *    不许拿 `GOAL_COMPLETED` 推算 `COMMITMENT_FULFILLED`。
 * ③ **没有 `GOAL_ORIGIN`**（`D23`）：cutover 是**结构性**的（只在当轮合法请求上创建）。
 *    绊线：任何扫描不得回溯 conversation events；若引入窗口扫描，必须同时加
 *    `GOAL_ORIGIN` + 重放守卫 + 新 ADR。
 */

import type { CommitmentId, ConversationEventId, GoalId, Timestamp } from './ids.ts'
import type { EntityRef } from './entity.ts'
import { entityLabel } from './entity.ts'
import { stableMaterial } from './memory.ts'
/* 泛型助手（今天住在 belief.ts）：只为 id 有界，不作安全用途 */
import { fnv1aHex } from './belief.ts'

// ---------------------------------------------------------------------------
// 闭集：状态 / 来源 / 优先级
// ---------------------------------------------------------------------------

/** 目标状态（ADR-076 §4.1 / 计划 §5.1） */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled' | 'superseded'

export const GOAL_STATUSES: readonly GoalStatus[] = [
  'active',
  'paused',
  'blocked',
  'completed',
  'cancelled',
  'superseded',
]

/** **终态**：不可迁移（除了"新身份"这条唯一的出路） */
export const GOAL_TERMINAL_STATUSES: readonly GoalStatus[] = [
  'completed',
  'cancelled',
  'superseded',
]

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === 'string' && (GOAL_STATUSES as readonly string[]).includes(value)
}

export function isGoalTerminal(status: GoalStatus): boolean {
  return GOAL_TERMINAL_STATUSES.includes(status)
}

/** 承诺状态（ADR-076 §4.2） */
export type CommitmentStatus =
  | 'active'
  | 'fulfilled'
  | 'broken'
  | 'cancelled'
  | 'superseded'
  /**
   * **到期**（M10.1 追加，ADR-086 `D07`）。
   *
   * ⚠️ 它与 `broken` **不是**一回事：`broken` 是"**失约**"（需要可判定的规则 + 违反证据）；
   *    `expired` 只是"**截止时间过去了**"——**不含**任何指控。
   */
  | 'expired'

export const COMMITMENT_STATUSES: readonly CommitmentStatus[] = [
  'active',
  'fulfilled',
  'broken',
  'cancelled',
  'superseded',
  'expired',
]

export const COMMITMENT_TERMINAL_STATUSES: readonly CommitmentStatus[] = [
  'fulfilled',
  'broken',
  'cancelled',
  'superseded',
  'expired',
]

export function isCommitmentStatus(value: unknown): value is CommitmentStatus {
  return typeof value === 'string' && (COMMITMENT_STATUSES as readonly string[]).includes(value)
}

export function isCommitmentTerminal(status: CommitmentStatus): boolean {
  return COMMITMENT_TERMINAL_STATUSES.includes(status)
}

/**
 * 来源（ADR-076 `D02`）：谁提出的。
 *
 * ⚠️ 它**不是**授权：`character_proposed` **必须**关联采纳证据才能正式激活
 * （计划 §5.1）。未采纳的提议**不**属于状态机（`D28`：提议不是持久实体）。
 */
export type GoalOrigin = 'user_requested' | 'character_proposed'

export const GOAL_ORIGINS: readonly GoalOrigin[] = ['user_requested', 'character_proposed']

export function isGoalOrigin(value: unknown): value is GoalOrigin {
  return typeof value === 'string' && (GOAL_ORIGINS as readonly string[]).includes(value)
}

/** 优先级（ADR-076 §4.1）：**只由用户显式指定**；不凭情绪 / 亲密度升降 */
export type GoalPriority = 'normal' | 'high'

export const GOAL_PRIORITIES: readonly GoalPriority[] = ['normal', 'high']

export function isGoalPriority(value: unknown): value is GoalPriority {
  return typeof value === 'string' && (GOAL_PRIORITIES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// 闭集：操作词表（D21 —— 领域自持，不扩展 ProposalOperation）
// ---------------------------------------------------------------------------

/**
 * Goal 的领域操作词表。
 *
 * ⚠️ **不要**把它塞进 `ProposalOperation`：那个共享词表的值会进**所有**认知模块的
 * 幂等键推导（见 `memory-validator.ts:82` 的登记）。本域用 `idempotencyKeyForGoalEvent`
 * 的 `unit` 作第五分量，与 `idempotencyKeyForBeliefEvent` 逐字同形。
 */
export type GoalOperation =
  | 'create'
  | 'revise'
  | 'pause'
  | 'resume'
  | 'block'
  | 'complete'
  | 'cancel'
  | 'supersede'

export const GOAL_OPERATIONS: readonly GoalOperation[] = [
  'create',
  'revise',
  'pause',
  'resume',
  'block',
  'complete',
  'cancel',
  'supersede',
]

export function isGoalOperation(value: unknown): value is GoalOperation {
  return typeof value === 'string' && (GOAL_OPERATIONS as readonly string[]).includes(value)
}

/** Commitment 的领域操作词表 */
export type CommitmentOperation = 'accept' | 'fulfill' | 'break' | 'cancel' | 'supersede'

export const COMMITMENT_OPERATIONS: readonly CommitmentOperation[] = [
  'accept',
  'fulfill',
  'break',
  'cancel',
  'supersede',
]

export function isCommitmentOperation(value: unknown): value is CommitmentOperation {
  return typeof value === 'string' && (COMMITMENT_OPERATIONS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// 闭集：criterion（§4.5 —— 三个 kind，与三种达成依据一一对应）
// ---------------------------------------------------------------------------

/**
 * 成功条件的闭集。
 *
 * ⚠️ **不接受**"一段 LLM 判断达成"的自由文本（计划 §5.1）。
 * ⚠️ 依据准入是**一对一**：`completionBasis === criterion.kind`（无例外）⇒
 *    机器可判的两类**不能**被用户一句话改判（"算了，就当完成了吧" = `cancel`，见 §4.5）。
 */
export type GoalSuccessCriterion =
  | { kind: 'user_report' }
  | { kind: 'conversation_output'; structure: ConversationOutputStructure }
  | {
      kind: 'action_result'
      capability: string
      operation: string
      require: 'executed_succeeded'
    }

export type ConversationOutputStructure =
  | { kind: 'item_count'; count: number }
  | { kind: 'marker_set'; markers: string[] }

export const GOAL_CRITERION_KINDS: readonly GoalSuccessCriterion['kind'][] = [
  'user_report',
  'conversation_output',
  'action_result',
]

/** 达成依据（`completionBasis`）—— 与 criterion kind **同名同集**（一对一） */
export type GoalCompletionBasis = GoalSuccessCriterion['kind']

export const GOAL_COMPLETION_BASES: readonly GoalCompletionBasis[] = GOAL_CRITERION_KINDS

/** `item_count` 的有界范围（`2..7`：至少要能"拆成几项"，且不给无限列举开口子） */
export const CONVERSATION_OUTPUT_ITEM_MIN = 2
export const CONVERSATION_OUTPUT_ITEM_MAX = 7
/** `marker_set` 的条数上界 */
export const CONVERSATION_OUTPUT_MARKER_MAX = 5

// ---------------------------------------------------------------------------
// 闭集：依赖分类与原因
// ---------------------------------------------------------------------------

/**
 * 依赖的三类（ADR-076 §4.6）。失效处置**完全不同**，因此必须在类型上分开。
 */
export type GoalDependencyClass = 'root_evidence' | 'necessary_premise' | 'optional_background'

export const GOAL_DEPENDENCY_CLASSES: readonly GoalDependencyClass[] = [
  'root_evidence',
  'necessary_premise',
  'optional_background',
]

/** 一类依赖引用（Memory / Belief —— 形状在 `goal-reference.ts`） */
export type GoalDependencyTarget =
  | { kind: 'memory'; memoryId: string }
  | { kind: 'belief'; beliefId: string }

export interface GoalDependency {
  class: GoalDependencyClass
  target: GoalDependencyTarget
}

/** `blocked` 的具名原因（**不含**任何被忘取值 —— §5 第 1 条） */
export type GoalBlockedReason =
  | 'necessary_premise_invalid'
  | 'capability_unavailable'
  | 'revision_required'
  /**
   * **WP5 追加**：依赖**读不到**（`unavailable` / 撤销集有具名缺口）。
   *
   * ⚠️ 它与 `necessary_premise_invalid` 刻意分开：那个是"我们读到了，它不作数了"，
   *    这个是"我们**读不到**，因此无法证明它作数"。两者的用户措辞与排查方向不同，
   *    合并会让"数据读失败"看起来像"用户的依据真的废了"。
   *    而且它**只**导致 `blocked`（可恢复），**绝不**导致 `cancelled` ——
   *    因为读失败是暂时的，不能拿它销毁一个合法目标。
   */
  | 'dependency_unavailable'

export const GOAL_BLOCKED_REASONS: readonly GoalBlockedReason[] = [
  'necessary_premise_invalid',
  'capability_unavailable',
  'revision_required',
  'dependency_unavailable',
]

/** `cancelled` 的具名原因（ADR-076 §4.4 / §5） */
export type GoalCancelReason =
  | 'user_cancel'
  | 'user_waived'
  | 'explicit_forget'
  | 'root_evidence_withdrawn'
  /** 目标被取消（承诺事件用：约定随目标一起结束） */
  | 'goal_cancelled'
  /**
   * **WP5 追加（关闭 `L-M10-08`）**：目标被**实质替代**，挂在它上面的承诺随之作废。
   *
   * ⚠️ 为什么不"顺延到新目标"：承诺是对**旧对象 / 旧成功条件**答应的，
   *    顺延等于在用户没有重新同意的情况下**重新划定**一个正式义务 ——
   *    那正是 §4.2 禁止的（"采纳路径的范围不得超出原提议"、重新约定必须显式）。
   *    新目标若需要承诺，双方**重新** `COMMITMENT_ACCEPTED`（新身份）。
   */
  | 'goal_superseded'

export const GOAL_CANCEL_REASONS: readonly GoalCancelReason[] = [
  'user_cancel',
  'user_waived',
  'explicit_forget',
  'root_evidence_withdrawn',
  'goal_cancelled',
  'goal_superseded',
]

/** **读侧遮蔽**的触发原因（§5 第 5 条：这两条任一命中 ⇒ 整项退出普通上下文） */
export function cancelReasonTriggersContentMask(reason: GoalCancelReason): boolean {
  return reason === 'explicit_forget'
}

// ---------------------------------------------------------------------------
// 有界字段（§4.1 的字段闭集；它们是**第一道**防线，payload 上限是第二道）
// ---------------------------------------------------------------------------

export const GOAL_STATEMENT_MAX_CODEPOINTS = 500
export const GOAL_NEXT_STEP_MAX_CODEPOINTS = 300
export const COMMITMENT_SCOPE_MAX_CODEPOINTS = 300
export const GOAL_CONTEXT_REF_MAX_CODEPOINTS = 128
export const GOAL_SOURCE_REFS_MAX = 8
export const GOAL_DEPENDENCIES_MAX = 16
export const COMMITMENT_COMPLETION_REFS_MAX = 8

/** 码点数（**不是** UTF-16 长度：emoji / 代理对不能算两个） */
export function codePointLength(text: string): number {
  return [...text].length
}

// ---------------------------------------------------------------------------
// 身份派生（D05 —— 材料清单是判据的一部分）
// ---------------------------------------------------------------------------

/**
 * `goalId` 的派生材料。
 *
 * 两条反例为什么被**结构性**排除（不是靠约定）：
 * ```text
 * 同内容重新设立 ⇒ 新身份     ：`acceptanceSourceEventId` 是新那一轮的对话事件 ⇒ 材料不同
 * 同一操作重复投递 ⇒ 幂等     ：三元组 (来源事件, 操作, 内容指纹) 全同 ⇒ 同一 id 与同一幂等键
 * 同轮两次不同内容 ⇒ 不撞键   ：`statementFingerprint` 在材料里
 * ```
 */
export interface GoalIdMaterial {
  characterId: string
  owner: EntityRef
  targetEntity?: EntityRef
  contextRef?: string
  origin: GoalOrigin
  /** 有界目标描述（**原文不进程**；只有它的指纹进程） */
  statement: string
  /** 受理来源：用户明确设立 / 明确采纳的**那条**对话事件 */
  acceptanceSourceEventId: string
  operation: 'create'
}

/**
 * 目标描述的稳定指纹。
 *
 * ⚠️ 导出它，是为了让**放行口能重算 id**（见 `goal-validator.ts` 的
 *    `GOAL_CREATED` 分支）：提案里的 `goalId` 一律被**重写**为程序算出的值，
 *    因此"模型编造 goalId"在结构上不可能（计划 §7.2 的硬要求）。
 */
export function goalStatementFingerprint(statement: string): string {
  return fnv1aHex(statement)
}

/** 由 owner + 受理来源事件 + 操作身份派生（**不只用内容文本哈希**） */
export function makeGoalId(material: GoalIdMaterial): GoalId {
  const canonical = stableMaterial({
    characterId: material.characterId,
    owner: entityLabel(material.owner),
    targetEntity: material.targetEntity === undefined ? null : entityLabel(material.targetEntity),
    contextRef: material.contextRef ?? null,
    origin: material.origin,
    statementFingerprint: goalStatementFingerprint(material.statement),
    acceptanceSourceEventId: material.acceptanceSourceEventId,
    operation: material.operation,
  })
  return `gol:${material.characterId}:${fnv1aHex(canonical)}` as GoalId
}

export interface CommitmentIdMaterial {
  characterId: string
  goalId: string
  actor: EntityRef
  beneficiary: EntityRef
  /** 承诺范围（**原文不进程**；只有它的指纹进程） */
  scope: string
  acceptanceSourceEventId: string
}

/** 承诺范围的稳定指纹（与目标描述同一手法） */
export function commitmentScopeFingerprint(scope: string): string {
  return fnv1aHex(scope)
}

export function makeCommitmentId(material: CommitmentIdMaterial): CommitmentId {
  const canonical = stableMaterial({
    characterId: material.characterId,
    goalId: String(material.goalId),
    actor: entityLabel(material.actor),
    beneficiary: entityLabel(material.beneficiary),
    scopeFingerprint: commitmentScopeFingerprint(material.scope),
    acceptanceSourceEventId: material.acceptanceSourceEventId,
  })
  return `cmt:${material.characterId}:${fnv1aHex(canonical)}` as CommitmentId
}

// ---------------------------------------------------------------------------
// 投影行（D03 / D24：一族多行，每 Goal 一行，承诺住在行里）
// ---------------------------------------------------------------------------

export const GOAL_PROJECTION_PREFIX = 'goal:' as const

/** 每 Goal 一个有界投影行：`goal:<goalId>` */
export function goalRowKeyOf(goalId: string): string {
  return `${GOAL_PROJECTION_PREFIX}${String(goalId)}`
}

/** 行键是否属于本域（store 的族读取与 rebuild 用它，**不用** SQL 前缀条件） */
export function isGoalRowKey(projectionType: string): boolean {
  return String(projectionType).startsWith(GOAL_PROJECTION_PREFIX)
}

// ---------------------------------------------------------------------------
// 状态形状（§4.1 / §4.2）
// ---------------------------------------------------------------------------

/** 时间三分离（§4.9）：记录时间 / 发生时间 / 截止时间 + 解析依据 */
export interface GoalTime {
  recordedAt: Timestamp
  occurredAt?: Timestamp
  dueAt?: Timestamp
  /** `dueAt` 的**解析依据**（用户原话的时区 / 相对时间口径） */
  dueBasis?: string
  timezone?: string
}

/** 来源引用（正文**不**复制进 trace；这里只有引用与指纹） */
export interface GoalSourceRef {
  conversationEventId: ConversationEventId
  /** 原话范围（程序校验过：span 必须是原话范围） */
  span?: { start: number; end: number }
  fingerprint: string
}

/** 目标的当前状态（投影行 state.goal 的 canonical 形状） */
export interface GoalState {
  goalId: GoalId
  characterId: string
  owner: EntityRef
  targetEntity?: EntityRef
  contextRef?: string
  origin: GoalOrigin
  sourceRefs: GoalSourceRef[]
  /** 目标状态每次正式转换 +1；写入带 `expectedRevision` */
  revision: number
  statement: string
  successCriterion: GoalSuccessCriterion
  status: GoalStatus
  /** `blocked` 时的**原状态**（恢复时要回到哪里） */
  preservedStatus?: GoalStatus
  blockedReason?: GoalBlockedReason
  cancelReason?: GoalCancelReason
  priority: GoalPriority
  dependencies: GoalDependency[]
  nextStep?: string
  time: GoalTime
  supersedesGoalId?: GoalId
  /** 遗忘时禁止再用的来源事件（`explicit_forget` 时**非空**；复用 M9 的 B28 机制） */
  forbiddenSourceEventIds?: string[]
  /** 最近一次完成 / 取消事件的摘要（审计用；**不含**正文） */
  lastEventAt?: Timestamp
}

/** 承诺的当前状态（投影行 state.commitment；`null` = 该 Goal 当前没有承诺） */
export interface CommitmentState {
  commitmentId: CommitmentId
  goalId: GoalId
  actor: EntityRef
  beneficiary: EntityRef
  scope: string
  acceptedAt: Timestamp
  acceptanceRefs: GoalSourceRef[]
  criterion: GoalSuccessCriterion
  status: CommitmentStatus
  completionRefs: GoalSourceRef[]
  /** 与 `goal.revision` **各自独立** */
  revision: number
  /** `fulfilled` / `broken` 的依据类型（§4.5 的一对一映射） */
  completionBasis?: GoalCompletionBasis
  /** `broken` 的规则 id（需要可判定的承诺规则 + 违反证据） */
  violationRuleId?: string
  lastEventAt?: Timestamp
}

/** 一条 Goal 投影行的 state（D03：承诺住在行里） */
export interface GoalRowState {
  goal: GoalState
  commitment: CommitmentState | null
}

// ---------------------------------------------------------------------------
// 事件 payload（§4.3 —— 13 个）
// ---------------------------------------------------------------------------

/** 事件 payload 的公共分量：每条 Goal 域事件都自带 characterId（跨角色过滤的判据） */
interface GoalEventBase {
  characterId: string
}

export interface GoalCreatedPayload extends GoalEventBase {
  /** 首版**完整快照**（reducer 必须能从零建出记录） */
  goal: GoalState
  mutation: 'explicit'
}

export interface GoalRevisedPayload extends GoalEventBase {
  goalId: string
  expectedRevision: number
  /** 变更过的字段名（闭集判据在放行口；这里只要求非空字符串数组） */
  changed: string[]
  statement?: string
  priority?: GoalPriority
  nextStep?: string
  dependencies?: GoalDependency[]
  reason: string
}

export interface GoalPausedPayload extends GoalEventBase {
  goalId: string
  expectedRevision: number
  reason: string
}

export interface GoalResumedPayload extends GoalEventBase {
  goalId: string
  expectedRevision: number
  /** 恢复时的**依赖复核读数**（可用 / 丢弃计数；不含正文） */
  recheck: { hard: number; soft: number; dropped: number }
}

export interface GoalBlockedPayload extends GoalEventBase {
  goalId: string
  expectedRevision: number
  reasonCode: GoalBlockedReason
  /** 非敏感说明（**不得**含被忘取值） */
  note?: string
}

export interface GoalCompletedPayload extends GoalEventBase {
  goalId: string
  expectedRevision: number
  basis: GoalCompletionBasis
  evidenceRefs: GoalSourceRef[]
}

export interface GoalCancelledPayload extends GoalEventBase {
  goalId: string
  expectedRevision: number
  reason: GoalCancelReason
  /**
   * `reason === 'explicit_forget'` 时必须**非空**：新的 `create` 的来源命中即拒
   * （M9 的 B28 机制逐字复用；旧根禁用不因内容再次出现而解除）。
   */
  forbiddenSourceEventIds?: string[]
}

export interface GoalSupersededPayload extends GoalEventBase {
  goalId: string
  supersededByGoalId: string
  expectedRevision: number
  reason: string
}

export interface CommitmentAcceptedPayload extends GoalEventBase {
  goalId: string
  /** 首版完整快照 */
  commitment: CommitmentState
  expectedGoalRevision: number
}

export interface CommitmentFulfilledPayload extends GoalEventBase {
  commitmentId: string
  goalId: string
  expectedRevision: number
  /** 完成依据引用（`fulfilled` 时**非空**） */
  resultRefs: GoalSourceRef[]
  basis: GoalCompletionBasis
}

export interface CommitmentBrokenPayload extends GoalEventBase {
  commitmentId: string
  goalId: string
  expectedRevision: number
  violationRefs: GoalSourceRef[]
  ruleId: string
}

export interface CommitmentCancelledPayload extends GoalEventBase {
  commitmentId: string
  goalId: string
  expectedRevision: number
  reason: GoalCancelReason
}

export interface CommitmentSupersededPayload extends GoalEventBase {
  commitmentId: string
  goalId: string
  supersededByCommitmentId: string
  expectedRevision: number
  reason: string
}

/**
 * **到期**（M10.1 追加；ADR-086 `D07`）。
 *
 * ⚠️ **刻意没有** `reason` / `violationRuleId` / 任何"谁没做到"的字段：
 *    到期是**时间事实**，不是**指控**。要指控必须走 `COMMITMENT_BROKEN`
 *    （它要求可判定的规则 + 违反证据）。
 *    `basis` 是**闭集**（目前只有一个值）：它把"到期只能由截止时间过去触发"写成机器判据，
 *    防止以后有人往这条事件里塞别的语义。
 */
export interface CommitmentExpiredPayload extends GoalEventBase {
  commitmentId: string
  goalId: string
  expectedRevision: number
  /** **到期**发生的时刻（程序时钟） */
  expiredAt: Timestamp
  /** 已经过去的那个截止时间（= 承诺的 `dueAt`；**必有值**，没有截止就谈不上到期） */
  dueAt: Timestamp
  /** 到期的**唯一**依据（闭集） */
  basis: 'due_at_passed'
}

/** 到期的依据闭集（改它 = 改语义，必须同时改 ADR-086 `D07`） */
export const COMMITMENT_EXPIRY_BASES: readonly CommitmentExpiredPayload['basis'][] = [
  'due_at_passed',
]

// ---------------------------------------------------------------------------
// 事件类型常量（登记表在 domain-event.ts —— 与 Memory/Belief 同一模式）
// ---------------------------------------------------------------------------

export const GOAL_DOMAIN_EVENT_TYPE_NAMES = {
  created: 'GOAL_CREATED',
  revised: 'GOAL_REVISED',
  paused: 'GOAL_PAUSED',
  resumed: 'GOAL_RESUMED',
  blocked: 'GOAL_BLOCKED',
  completed: 'GOAL_COMPLETED',
  cancelled: 'GOAL_CANCELLED',
  superseded: 'GOAL_SUPERSEDED',
  commitmentAccepted: 'COMMITMENT_ACCEPTED',
  commitmentFulfilled: 'COMMITMENT_FULFILLED',
  commitmentBroken: 'COMMITMENT_BROKEN',
  commitmentCancelled: 'COMMITMENT_CANCELLED',
  commitmentSuperseded: 'COMMITMENT_SUPERSEDED',
  commitmentExpired: 'COMMITMENT_EXPIRED',
} as const

/**
 * 事件 → payload 上限（§4.3 的冻结值）。
 *
 * ⚠️ 这些是**第二道**防线：第一道是放行口的字段上界（`statement` ≤500 码点等）。
 *    因此"payload 太大"与"字段不合法"是两个**可区分**的拒绝码。
 */
export const GOAL_EVENT_MAX_PAYLOAD_BYTES: Readonly<Record<string, number>> = {
  GOAL_CREATED: 16384,
  GOAL_REVISED: 4096,
  GOAL_PAUSED: 4096,
  GOAL_RESUMED: 4096,
  GOAL_BLOCKED: 4096,
  GOAL_COMPLETED: 8192,
  GOAL_CANCELLED: 8192,
  GOAL_SUPERSEDED: 4096,
  COMMITMENT_ACCEPTED: 8192,
  COMMITMENT_FULFILLED: 8192,
  COMMITMENT_BROKEN: 4096,
  COMMITMENT_CANCELLED: 4096,
  COMMITMENT_SUPERSEDED: 4096,
  COMMITMENT_EXPIRED: 4096,
}

// ---------------------------------------------------------------------------
// payload 结构校验（registry 用）
// ---------------------------------------------------------------------------

function requireObject(payload: unknown, eventType: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`${eventType} payload 必须是对象`)
  }
  return payload as Record<string, unknown>
}

function requireNonEmptyString(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): string {
  const value = object[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${eventType} payload.${field} 必须是非空字符串`)
  }
  return value
}

function requireFiniteNumber(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): number {
  const value = object[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${eventType} payload.${field} 必须是有限数字`)
  }
  return value
}

function requirePositiveInteger(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): number {
  const value = requireFiniteNumber(object, field, eventType)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${eventType} payload.${field} 必须是 ≥1 的整数`)
  }
  return value
}

function requireEntityRef(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): EntityRef {
  const value = object[field]
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${eventType} payload.${field} 必须是 EntityRef`)
  }
  const ref = value as Record<string, unknown>
  if (typeof ref.kind !== 'string' || typeof ref.id !== 'string') {
    throw new Error(`${eventType} payload.${field} 必须是 { kind, id }`)
  }
  return value as EntityRef
}

function requireEnum<T extends string>(
  object: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  eventType: string,
): T {
  const value = object[field]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `${eventType} payload.${field} 必须是 ${allowed.join(' | ')}（收到 ${JSON.stringify(value)}）`,
    )
  }
  return value as T
}

function requireStringArray(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): string[] {
  const value = object[field]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${eventType} payload.${field} 必须是字符串数组`)
  }
  return value as string[]
}

function requireOptionalStringArray(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): string[] | undefined {
  if (object[field] === undefined) return undefined
  return requireStringArray(object, field, eventType)
}

/**
 * criterion 的结构校验（§4.5 的闭集 + 参数边界）。
 *
 * ⚠️ 参数越界在这里被拒（`item_count` 必须 2..7、`marker_set` 1..5 条且非空）——
 *    它们是**参数**校验，不是业务规则。
 */
export function validateGoalCriterion(value: unknown, eventType: string): GoalSuccessCriterion {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${eventType} criterion 必须是对象`)
  }
  const object = value as Record<string, unknown>
  const kind = object.kind
  if (kind === 'user_report') return { kind: 'user_report' }
  if (kind === 'conversation_output') {
    const structure = object.structure
    if (typeof structure !== 'object' || structure === null) {
      throw new Error(`${eventType} criterion.structure 必须是对象`)
    }
    const spec = structure as Record<string, unknown>
    if (spec.kind === 'item_count') {
      const count = spec.count
      if (
        typeof count !== 'number' ||
        !Number.isInteger(count) ||
        count < CONVERSATION_OUTPUT_ITEM_MIN ||
        count > CONVERSATION_OUTPUT_ITEM_MAX
      ) {
        throw new Error(
          `${eventType} criterion.structure.count 必须是 ${CONVERSATION_OUTPUT_ITEM_MIN}..${CONVERSATION_OUTPUT_ITEM_MAX} 的整数`,
        )
      }
      return { kind: 'conversation_output', structure: { kind: 'item_count', count } }
    }
    if (spec.kind === 'marker_set') {
      const markers = spec.markers
      if (
        !Array.isArray(markers) ||
        markers.length === 0 ||
        markers.length > CONVERSATION_OUTPUT_MARKER_MAX ||
        markers.some((m) => typeof m !== 'string' || m.trim() === '')
      ) {
        throw new Error(
          `${eventType} criterion.structure.markers 必须是 1..${CONVERSATION_OUTPUT_MARKER_MAX} 个非空字符串`,
        )
      }
      return {
        kind: 'conversation_output',
        structure: { kind: 'marker_set', markers: markers as string[] },
      }
    }
    throw new Error(`${eventType} criterion.structure.kind 必须是 item_count | marker_set`)
  }
  if (kind === 'action_result') {
    const capability = requireNonEmptyString(object, 'capability', `${eventType}.criterion`)
    const operation = requireNonEmptyString(object, 'operation', `${eventType}.criterion`)
    if (object.require !== 'executed_succeeded') {
      throw new Error(`${eventType} criterion.require 必须是 executed_succeeded`)
    }
    return { kind: 'action_result', capability, operation, require: 'executed_succeeded' }
  }
  throw new Error(
    `${eventType} criterion.kind 必须是 ${GOAL_CRITERION_KINDS.join(' | ')}（收到 ${JSON.stringify(kind)}）`,
  )
}

/** 来源引用数组的结构校验（`sourceRefs` / `resultRefs` / `acceptanceRefs` / `evidenceRefs`） */
export function validateGoalSourceRefs(value: unknown, eventType: string, field: string): GoalSourceRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`${eventType} payload.${field} 必须是数组`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${eventType} payload.${field}[${String(index)}] 必须是对象`)
    }
    const ref = entry as Record<string, unknown>
    const conversationEventId = requireNonEmptyString(ref, 'conversationEventId', `${eventType}.${field}[${String(index)}]`)
    const fingerprint = requireNonEmptyString(ref, 'fingerprint', `${eventType}.${field}[${String(index)}]`)
    const out: GoalSourceRef = {
      conversationEventId: conversationEventId as ConversationEventId,
      fingerprint,
    }
    if (ref.span !== undefined) {
      const span = ref.span as Record<string, unknown>
      if (
        typeof span.start !== 'number' ||
        typeof span.end !== 'number' ||
        !Number.isInteger(span.start) ||
        !Number.isInteger(span.end) ||
        span.start < 0 ||
        span.end < span.start
      ) {
        throw new Error(`${eventType} payload.${field}[${String(index)}].span 非法`)
      }
      out.span = { start: span.start, end: span.end }
    }
    return out
  })
}

/** 依赖数组的结构校验（三类闭集 + 目标闭集 + 上界） */
export function validateGoalDependencies(value: unknown, eventType: string): GoalDependency[] {
  if (!Array.isArray(value)) {
    throw new Error(`${eventType} payload.dependencies 必须是数组`)
  }
  if (value.length > GOAL_DEPENDENCIES_MAX) {
    throw new Error(
      `${eventType} payload.dependencies 超过 ${GOAL_DEPENDENCIES_MAX} 条上界（收到 ${value.length}）`,
    )
  }
  return value.map((entry, index) => {
    const where = `${eventType}.dependencies[${String(index)}]`
    if (typeof entry !== 'object' || entry === null) throw new Error(`${where} 必须是对象`)
    const item = entry as Record<string, unknown>
    const cls = item.class
    if (
      typeof cls !== 'string' ||
      !(GOAL_DEPENDENCY_CLASSES as readonly string[]).includes(cls)
    ) {
      throw new Error(`${where}.class 必须是 ${GOAL_DEPENDENCY_CLASSES.join(' | ')}`)
    }
    const target = item.target
    if (typeof target !== 'object' || target === null) throw new Error(`${where}.target 必须是对象`)
    const spec = target as Record<string, unknown>
    if (spec.kind === 'memory') {
      return {
        class: cls as GoalDependencyClass,
        target: { kind: 'memory', memoryId: requireNonEmptyString(spec, 'memoryId', where) },
      }
    }
    if (spec.kind === 'belief') {
      return {
        class: cls as GoalDependencyClass,
        target: { kind: 'belief', beliefId: requireNonEmptyString(spec, 'beliefId', where) },
      }
    }
    throw new Error(`${where}.target.kind 必须是 memory | belief`)
  })
}

/** `GoalState` 快照的结构校验（`GOAL_CREATED` 用） */
export function validateGoalStateSnapshot(value: unknown, eventType: string): GoalState {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${eventType} payload.goal 必须是对象`)
  }
  const object = value as Record<string, unknown>
  const status = object.status
  if (!isGoalStatus(status)) {
    throw new Error(`${eventType} payload.goal.status 必须是 ${GOAL_STATUSES.join(' | ')}`)
  }
  const origin = object.origin
  if (!isGoalOrigin(origin)) {
    throw new Error(`${eventType} payload.goal.origin 必须是 ${GOAL_ORIGINS.join(' | ')}`)
  }
  const priority = object.priority
  if (!isGoalPriority(priority)) {
    throw new Error(`${eventType} payload.goal.priority 必须是 ${GOAL_PRIORITIES.join(' | ')}`)
  }
  const statement = requireNonEmptyString(object, 'statement', `${eventType}.goal`)
  if (codePointLength(statement) > GOAL_STATEMENT_MAX_CODEPOINTS) {
    throw new Error(
      `${eventType} payload.goal.statement 超过 ${GOAL_STATEMENT_MAX_CODEPOINTS} 码点（收到 ${codePointLength(statement)}）`,
    )
  }
  return {
    goalId: requireNonEmptyString(object, 'goalId', `${eventType}.goal`) as GoalId,
    characterId: requireNonEmptyString(object, 'characterId', `${eventType}.goal`),
    owner: requireEntityRef(object, 'owner', `${eventType}.goal`),
    ...(object.targetEntity !== undefined
      ? { targetEntity: requireEntityRef(object, 'targetEntity', `${eventType}.goal`) }
      : {}),
    ...(object.contextRef !== undefined
      ? { contextRef: requireNonEmptyString(object, 'contextRef', `${eventType}.goal`) }
      : {}),
    origin,
    sourceRefs: validateGoalSourceRefs(object.sourceRefs, `${eventType}.goal`, 'sourceRefs'),
    revision: requirePositiveInteger(object, 'revision', `${eventType}.goal`),
    statement,
    successCriterion: validateGoalCriterion(object.successCriterion, `${eventType}.goal`),
    status,
    ...(object.preservedStatus !== undefined && isGoalStatus(object.preservedStatus)
      ? { preservedStatus: object.preservedStatus }
      : {}),
    ...(object.blockedReason !== undefined
      ? {
          blockedReason: requireEnum(
            object,
            'blockedReason',
            GOAL_BLOCKED_REASONS,
            `${eventType}.goal`,
          ),
        }
      : {}),
    ...(object.cancelReason !== undefined
      ? { cancelReason: requireEnum(object, 'cancelReason', GOAL_CANCEL_REASONS, `${eventType}.goal`) }
      : {}),
    priority,
    dependencies: validateGoalDependencies(object.dependencies ?? [], `${eventType}.goal`),
    ...(object.nextStep !== undefined
      ? { nextStep: requireNonEmptyString(object, 'nextStep', `${eventType}.goal`) }
      : {}),
    time: ((): GoalTime => {
      const time = object.time
      if (typeof time !== 'object' || time === null) {
        throw new Error(`${eventType} payload.goal.time 必须是对象`)
      }
      const spec = time as Record<string, unknown>
      const recordedAt = spec.recordedAt
      if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) {
        throw new Error(`${eventType} payload.goal.time.recordedAt 必须是有限数字`)
      }
      const out: GoalTime = { recordedAt }
      for (const field of ['occurredAt', 'dueAt'] as const) {
        const v = spec[field]
        if (v === undefined) continue
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new Error(`${eventType} payload.goal.time.${field} 必须是有限数字`)
        }
        out[field] = v
      }
      for (const field of ['dueBasis', 'timezone'] as const) {
        const v = spec[field]
        if (v === undefined) continue
        if (typeof v !== 'string' || v.trim() === '') {
          throw new Error(`${eventType} payload.goal.time.${field} 必须是非空字符串`)
        }
        out[field] = v
      }
      /*
       * ⚠️ **`dueAt` 有值 ⇒ `dueBasis` 必须有值**（M10 WP11 轮次补上）。
       *
       * 这是把**契约 §3 的 `G36` 判据**落到结构校验里，逐字：
       * 「**澄清**，不猜日期；`dueBasis` 与解析依据**可查**」。
       *
       * 此前这一条**没有被强制**：一个 `dueAt` 可以不带任何解析依据地落库 ⇒
       * "这个日期是怎么来的"**查不到** ⇒ `G36` 的后半句在实现里不成立。
       * 门 `m10:test` 的 `C10` 用**真的**校验函数把它测出来了（那是真发现，不是门的缺陷）。
       *
       * 三条性质保证这次收紧**不会误伤**：
       * ```text
       * ① 它**更严**，不放松任何既有判据；
       * ② 目标域**生产侧没有任何一处**写 `dueAt`（门 `C9` 是这条的判据）
       *    ⇒ 今天不存在会被它拒掉的真实事件；
       * ③ 它只约束**新写入**的事件；已落库的事件不受影响（`validateGoalStateSnapshot`
       *    在写路径与读回路径上都跑，而读回路径的数据本来就满足它）。
       * ```
       * ⇒ 它**实现**契约，而**没有**改契约（`DESIGN FROZEN` 的语义一字未动）。
       */
      if (out.dueAt !== undefined && out.dueBasis === undefined) {
        throw new Error(
          `${eventType} payload.goal.time.dueAt 有值时必须同时给出 dueBasis` +
            '（G36：日期的解析依据必须可查 —— 不许"不猜日期"却把猜的结果落库）',
        )
      }
      return out
    })(),
    ...(object.supersedesGoalId !== undefined
      ? { supersedesGoalId: requireNonEmptyString(object, 'supersedesGoalId', `${eventType}.goal`) as GoalId }
      : {}),
    ...(object.forbiddenSourceEventIds !== undefined
      ? { forbiddenSourceEventIds: requireStringArray(object, 'forbiddenSourceEventIds', `${eventType}.goal`) }
      : {}),
    ...(object.lastEventAt !== undefined
      ? { lastEventAt: requireFiniteNumber(object, 'lastEventAt', `${eventType}.goal`) }
      : {}),
  }
}

/** `CommitmentState` 快照的结构校验（`COMMITMENT_ACCEPTED` 用） */
export function validateCommitmentStateSnapshot(value: unknown, eventType: string): CommitmentState {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${eventType} payload.commitment 必须是对象`)
  }
  const object = value as Record<string, unknown>
  const status = object.status
  if (!isCommitmentStatus(status)) {
    throw new Error(`${eventType} payload.commitment.status 必须是 ${COMMITMENT_STATUSES.join(' | ')}`)
  }
  const scope = requireNonEmptyString(object, 'scope', `${eventType}.commitment`)
  if (codePointLength(scope) > COMMITMENT_SCOPE_MAX_CODEPOINTS) {
    throw new Error(
      `${eventType} payload.commitment.scope 超过 ${COMMITMENT_SCOPE_MAX_CODEPOINTS} 码点（收到 ${codePointLength(scope)}）`,
    )
  }
  return {
    commitmentId: requireNonEmptyString(object, 'commitmentId', `${eventType}.commitment`) as CommitmentId,
    goalId: requireNonEmptyString(object, 'goalId', `${eventType}.commitment`) as GoalId,
    actor: requireEntityRef(object, 'actor', `${eventType}.commitment`),
    beneficiary: requireEntityRef(object, 'beneficiary', `${eventType}.commitment`),
    scope,
    acceptedAt: requireFiniteNumber(object, 'acceptedAt', `${eventType}.commitment`),
    acceptanceRefs: validateGoalSourceRefs(
      object.acceptanceRefs,
      `${eventType}.commitment`,
      'acceptanceRefs',
    ),
    criterion: validateGoalCriterion(object.criterion, `${eventType}.commitment`),
    status,
    completionRefs: validateGoalSourceRefs(
      object.completionRefs ?? [],
      `${eventType}.commitment`,
      'completionRefs',
    ),
    revision: requirePositiveInteger(object, 'revision', `${eventType}.commitment`),
    ...(object.completionBasis !== undefined
      ? {
          completionBasis: requireEnum(
            object,
            'completionBasis',
            GOAL_COMPLETION_BASES,
            `${eventType}.commitment`,
          ),
        }
      : {}),
    ...(object.violationRuleId !== undefined
      ? { violationRuleId: requireNonEmptyString(object, 'violationRuleId', `${eventType}.commitment`) }
      : {}),
    ...(object.lastEventAt !== undefined
      ? { lastEventAt: requireFiniteNumber(object, 'lastEventAt', `${eventType}.commitment`) }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// 逐事件的 payload 校验器（registry 注册用）
// ---------------------------------------------------------------------------

export function validateGoalCreatedPayload(payload: unknown): GoalCreatedPayload {
  const eventType = 'GOAL_CREATED'
  const object = requireObject(payload, eventType)
  if (object.mutation !== 'explicit') {
    throw new Error(`${eventType} payload.mutation 必须是 explicit（v1 只有显式路径）`)
  }
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    goal: validateGoalStateSnapshot(object.goal, eventType),
    mutation: 'explicit',
  }
}

export function validateGoalRevisedPayload(payload: unknown): GoalRevisedPayload {
  const eventType = 'GOAL_REVISED'
  const object = requireObject(payload, eventType)
  const changed = requireStringArray(object, 'changed', eventType)
  if (changed.length === 0) {
    throw new Error(`${eventType} payload.changed 必须非空（没有变化就不该发修订事件）`)
  }
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    changed,
    ...(object.statement !== undefined
      ? { statement: requireNonEmptyString(object, 'statement', eventType) }
      : {}),
    ...(object.priority !== undefined
      ? { priority: requireEnum(object, 'priority', GOAL_PRIORITIES, eventType) }
      : {}),
    ...(object.nextStep !== undefined
      ? { nextStep: requireNonEmptyString(object, 'nextStep', eventType) }
      : {}),
    ...(object.dependencies !== undefined
      ? { dependencies: validateGoalDependencies(object.dependencies, eventType) }
      : {}),
    reason: requireNonEmptyString(object, 'reason', eventType),
  }
}

export function validateGoalPausedPayload(payload: unknown): GoalPausedPayload {
  const eventType = 'GOAL_PAUSED'
  const object = requireObject(payload, eventType)
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    reason: requireNonEmptyString(object, 'reason', eventType),
  }
}

export function validateGoalResumedPayload(payload: unknown): GoalResumedPayload {
  const eventType = 'GOAL_RESUMED'
  const object = requireObject(payload, eventType)
  const recheck = object.recheck
  if (typeof recheck !== 'object' || recheck === null) {
    throw new Error(`${eventType} payload.recheck 必须是对象（恢复必须带依赖复核读数）`)
  }
  const spec = recheck as Record<string, unknown>
  const counts = {} as { hard: number; soft: number; dropped: number }
  for (const field of ['hard', 'soft', 'dropped'] as const) {
    const value = spec[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`${eventType} payload.recheck.${field} 必须是 ≥0 的整数`)
    }
    counts[field] = value
  }
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    recheck: counts,
  }
}

export function validateGoalBlockedPayload(payload: unknown): GoalBlockedPayload {
  const eventType = 'GOAL_BLOCKED'
  const object = requireObject(payload, eventType)
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    reasonCode: requireEnum(object, 'reasonCode', GOAL_BLOCKED_REASONS, eventType),
    ...(object.note !== undefined ? { note: requireNonEmptyString(object, 'note', eventType) } : {}),
  }
}

export function validateGoalCompletedPayload(payload: unknown): GoalCompletedPayload {
  const eventType = 'GOAL_COMPLETED'
  const object = requireObject(payload, eventType)
  const basis = requireEnum(object, 'basis', GOAL_COMPLETION_BASES, eventType)
  const evidenceRefs = validateGoalSourceRefs(object.evidenceRefs, eventType, 'evidenceRefs')
  if (evidenceRefs.length === 0) {
    throw new Error(`${eventType} payload.evidenceRefs 必须非空（完成必须带依据）`)
  }
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    basis,
    evidenceRefs,
  }
}

export function validateGoalCancelledPayload(payload: unknown): GoalCancelledPayload {
  const eventType = 'GOAL_CANCELLED'
  const object = requireObject(payload, eventType)
  const reason = requireEnum(object, 'reason', GOAL_CANCEL_REASONS, eventType)
  const forbidden = requireOptionalStringArray(object, 'forbiddenSourceEventIds', eventType)
  if (reason === 'explicit_forget' && (forbidden === undefined || forbidden.length === 0)) {
    throw new Error(
      `${eventType}：reason=explicit_forget 时 forbiddenSourceEventIds 必须**非空**` +
        '（否则"忘掉"不产生任何禁用根，旧根会因内容再次出现而复活 —— M9 的 B28 同款）',
    )
  }
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    reason,
    ...(forbidden !== undefined ? { forbiddenSourceEventIds: forbidden } : {}),
  }
}

export function validateGoalSupersededPayload(payload: unknown): GoalSupersededPayload {
  const eventType = 'GOAL_SUPERSEDED'
  const object = requireObject(payload, eventType)
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    supersededByGoalId: requireNonEmptyString(object, 'supersededByGoalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    reason: requireNonEmptyString(object, 'reason', eventType),
  }
}

export function validateCommitmentAcceptedPayload(payload: unknown): CommitmentAcceptedPayload {
  const eventType = 'COMMITMENT_ACCEPTED'
  const object = requireObject(payload, eventType)
  const commitment = validateCommitmentStateSnapshot(object.commitment, eventType)
  if (commitment.acceptanceRefs.length === 0) {
    throw new Error(`${eventType} payload.commitment.acceptanceRefs 必须非空（承担必须有受理证据）`)
  }
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    commitment,
    expectedGoalRevision: requirePositiveInteger(object, 'expectedGoalRevision', eventType),
  }
}

export function validateCommitmentFulfilledPayload(payload: unknown): CommitmentFulfilledPayload {
  const eventType = 'COMMITMENT_FULFILLED'
  const object = requireObject(payload, eventType)
  const resultRefs = validateGoalSourceRefs(object.resultRefs, eventType, 'resultRefs')
  if (resultRefs.length === 0) {
    throw new Error(`${eventType} payload.resultRefs 必须非空（兑现必须有真实结果）`)
  }
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    commitmentId: requireNonEmptyString(object, 'commitmentId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    resultRefs,
    basis: requireEnum(object, 'basis', GOAL_COMPLETION_BASES, eventType),
  }
}

export function validateCommitmentBrokenPayload(payload: unknown): CommitmentBrokenPayload {
  const eventType = 'COMMITMENT_BROKEN'
  const object = requireObject(payload, eventType)
  const violationRefs = validateGoalSourceRefs(object.violationRefs, eventType, 'violationRefs')
  if (violationRefs.length === 0) {
    throw new Error(
      `${eventType} payload.violationRefs 必须非空（"失约"必须有可判定的违反证据 —— 不得由超时推定）`,
    )
  }
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    commitmentId: requireNonEmptyString(object, 'commitmentId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    violationRefs,
    ruleId: requireNonEmptyString(object, 'ruleId', eventType),
  }
}

export function validateCommitmentCancelledPayload(payload: unknown): CommitmentCancelledPayload {
  const eventType = 'COMMITMENT_CANCELLED'
  const object = requireObject(payload, eventType)
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    commitmentId: requireNonEmptyString(object, 'commitmentId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    reason: requireEnum(object, 'reason', GOAL_CANCEL_REASONS, eventType),
  }
}

/**
 * **到期**的载荷校验（M10.1）。
 *
 * ⚠️ 它**只**接受闭集里的 `basis`，且要求 `dueAt` / `expiredAt` 都是正整数时间戳 ——
 *    "没有截止时间就谈不上到期"因此是**结构上**成立的，而不是靠调用方自觉。
 */
export function validateCommitmentExpiredPayload(payload: unknown): CommitmentExpiredPayload {
  const eventType = 'COMMITMENT_EXPIRED'
  const object = requireObject(payload, eventType)
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    commitmentId: requireNonEmptyString(object, 'commitmentId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    expiredAt: requirePositiveInteger(object, 'expiredAt', eventType),
    dueAt: requirePositiveInteger(object, 'dueAt', eventType),
    basis: requireEnum(object, 'basis', COMMITMENT_EXPIRY_BASES, eventType),
  }
}

export function validateCommitmentSupersededPayload(payload: unknown): CommitmentSupersededPayload {
  const eventType = 'COMMITMENT_SUPERSEDED'
  const object = requireObject(payload, eventType)
  return {
    characterId: requireNonEmptyString(object, 'characterId', eventType),
    commitmentId: requireNonEmptyString(object, 'commitmentId', eventType),
    goalId: requireNonEmptyString(object, 'goalId', eventType),
    supersededByCommitmentId: requireNonEmptyString(
      object,
      'supersededByCommitmentId',
      eventType,
    ),
    expectedRevision: requirePositiveInteger(object, 'expectedRevision', eventType),
    reason: requireNonEmptyString(object, 'reason', eventType),
  }
}
