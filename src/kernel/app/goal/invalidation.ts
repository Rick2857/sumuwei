/**
 * Goal **失效传播 / 遗忘遮蔽 / 冲突处理**（M10 WP5 / ADR-076 §4.6 · §5 · §6.4）。
 *
 * ============================================================================
 *  三类依赖的处置（§4.6 —— 它们**必须**不同，所以在这里被分开判定）
 * ============================================================================
 * ```text
 * root_evidence        失效 ⇒ 目标**失去使用资格**：读侧立即整项遮蔽 + 写侧记撤回原因
 *                            （不得再说"你答应过"）—— 只在**确定**失效时（见下）
 * necessary_premise    失效 ⇒ blocked + 具名原因；用户确认前不自动重新执行
 * optional_background  失效 ⇒ **只丢引用**、重新规划，目标本身保留
 * ```
 *
 * ---------------------------------------------------------------------------
 *  "确定"与"读不到"是两件事（这条是 WP5 最要紧的一处）
 * ---------------------------------------------------------------------------
 * ```text
 * 确定失效（forgotten / root_missing / revision_changed / status_not_usable）
 *     ⇒ 才有资格触发 cancel / block
 * 读不到（unavailable / withdrawn_incomplete）
 *     ⇒ 一律降级为 **blocked('dependency_unavailable')**，**绝不** cancel
 * ```
 * 理由：读失败是**暂时**的。拿一次读失败去 `cancel` 一个合法目标，等于让一次
 * 数据库抖动销毁用户的约定 —— 而"宁过遮不漏"在这里**不适用**：
 * 遮蔽是**读侧**动作（可逆），cancel 是**写侧**事实（append-only、不可逆）。
 *
 * ---------------------------------------------------------------------------
 *  读侧遮蔽**独立于写侧**（§4.6 的双保险）
 * ---------------------------------------------------------------------------
 * `goalContentMustBeMasked()` 是**纯函数**：只看"当前撤销集"与"这一行"，
 * **不要求**任何取消事件已经被写下。因此写侧失败 / 后台没跑 / 正在重建时，
 * 失效内容仍然进不了上下文。
 *
 * ⚠️ 纯函数 + 纯判定：不 import SQL / 框架 / `node:*`，不读时钟。
 */

import {
  type GoalBlockedReason,
  type GoalCancelReason,
  type GoalDependency,
  type GoalDependencyClass,
  type GoalState,
} from '../../contracts/goal.ts'
import type { ReferenceRejectionReason, ReferenceUsability } from '../../contracts/goal-reference.ts'

// ---------------------------------------------------------------------------
// 一条依赖的当前读数
// ---------------------------------------------------------------------------

export interface GoalDependencyReading {
  readonly dependency: GoalDependency
  /** 该依赖此刻**能不能用**（来自 WP2 的 `recheckGoalDependencies`，逐条对应） */
  readonly usability: ReferenceUsability
}

/**
 * **确定**失效的原因集合。
 *
 * ⚠️ 它与"读不到"分开，是 §4.6 与 §5 的落点（见文件头）。这张表是**唯一**判据：
 *    任何"什么算确定"的判断都必须走 `isCertainInvalidation()`。
 */
export const CERTAIN_INVALIDATION_REASONS: readonly ReferenceRejectionReason[] = [
  'forgotten',
  'root_missing',
  'revision_changed',
  'status_not_usable',
  'foreign',
  'overlaid',
]

/** 读不到（失败关闭的方向是**可逆**的 blocked，不是 cancel） */
export const UNRESOLVED_INVALIDATION_REASONS: readonly ReferenceRejectionReason[] = [
  'unavailable',
  'withdrawn_incomplete',
]

export function isCertainInvalidation(reason: ReferenceRejectionReason): boolean {
  return CERTAIN_INVALIDATION_REASONS.includes(reason)
}

export function isUnresolvedInvalidation(reason: ReferenceRejectionReason): boolean {
  return UNRESOLVED_INVALIDATION_REASONS.includes(reason)
}

// ---------------------------------------------------------------------------
// 处置结论（**五态**，每一态都带具名理由与受影响集合）
// ---------------------------------------------------------------------------

export type GoalInvalidationDecision =
  /** 没有任何依赖失效 ⇒ **什么都不做**（正控：不得过度触发） */
  | { readonly kind: 'none'; readonly reason: 'no_invalid_dependency' }
  /** 根证据确定失效 ⇒ 目标失去使用资格 */
  | {
      readonly kind: 'cancel'
      readonly reason: Extract<GoalCancelReason, 'root_evidence_withdrawn'>
      readonly affected: readonly GoalDependency[]
    }
  /** 必要前提确定失效 ⇒ blocked */
  | {
      readonly kind: 'block'
      readonly reasonCode: Extract<GoalBlockedReason, 'necessary_premise_invalid'>
      readonly affected: readonly GoalDependency[]
    }
  /** 读不到 / 撤销集有缺口 ⇒ blocked（**可逆**；不是 cancel） */
  | {
      readonly kind: 'block'
      readonly reasonCode: Extract<GoalBlockedReason, 'dependency_unavailable'>
      readonly affected: readonly GoalDependency[]
    }
  /** 只有可选背景失效 ⇒ 丢引用、重新规划；目标保留 */
  | {
      readonly kind: 'revise_drop_references'
      readonly dropped: readonly GoalDependency[]
    }

/**
 * 三类依赖的处置判定（**纯函数**）。
 *
 * 判定优先级（越靠前越"目标还能不能立得住"）：
 * ```text
 * ① 根证据**确定**失效      ⇒ cancel       （目标失去使用资格）
 * ② 根证据**读不到**        ⇒ block(dependency_unavailable)
 * ③ 必要前提**确定**失效    ⇒ block(necessary_premise_invalid)
 * ④ 必要前提**读不到**      ⇒ block(dependency_unavailable)
 * ⑤ 只有可选背景失效        ⇒ revise_drop_references
 * ⑥ 没有失效                ⇒ none
 * ```
 *
 * ⚠️ 优先级是判据的一部分：**根证据压过必要前提**（前者是"这个目标根本不该存在"，
 *    后者是"它现在做不了"）。把它们并列会让同一个世界状态给出两种结论。
 */
export function decideGoalInvalidation(
  readings: readonly GoalDependencyReading[],
): GoalInvalidationDecision {
  const invalid = readings.filter((reading) => !reading.usability.usable)
  if (invalid.length === 0) {
    return { kind: 'none', reason: 'no_invalid_dependency' }
  }

  const withReason = invalid.map((reading) => ({
    reading,
    reason: (reading.usability as { usable: false; reason: ReferenceRejectionReason }).reason,
  }))

  const byClass = (cls: GoalDependencyClass): typeof withReason =>
    withReason.filter((entry) => entry.reading.dependency.class === cls)

  const rootCertain = byClass('root_evidence').filter((e) => isCertainInvalidation(e.reason))
  if (rootCertain.length > 0) {
    return {
      kind: 'cancel',
      reason: 'root_evidence_withdrawn',
      affected: rootCertain.map((e) => e.reading.dependency),
    }
  }

  const rootUnresolved = byClass('root_evidence').filter((e) => isUnresolvedInvalidation(e.reason))
  if (rootUnresolved.length > 0) {
    return {
      kind: 'block',
      reasonCode: 'dependency_unavailable',
      affected: rootUnresolved.map((e) => e.reading.dependency),
    }
  }

  const premiseCertain = byClass('necessary_premise').filter((e) =>
    isCertainInvalidation(e.reason),
  )
  if (premiseCertain.length > 0) {
    return {
      kind: 'block',
      reasonCode: 'necessary_premise_invalid',
      affected: premiseCertain.map((e) => e.reading.dependency),
    }
  }

  const premiseUnresolved = byClass('necessary_premise').filter((e) =>
    isUnresolvedInvalidation(e.reason),
  )
  if (premiseUnresolved.length > 0) {
    return {
      kind: 'block',
      reasonCode: 'dependency_unavailable',
      affected: premiseUnresolved.map((e) => e.reading.dependency),
    }
  }

  /* 只剩可选背景（或未知分类的失效）⇒ 丢引用 */
  return {
    kind: 'revise_drop_references',
    dropped: withReason.map((e) => e.reading.dependency),
  }
}

/**
 * 能力条件不满足 ⇒ `blocked('capability_unavailable')`（计划 §5.2）。
 *
 * ⚠️ 它与依赖失效**分开**：依赖是"依据没了"，能力是"这件事现在做不到"。
 *    两者的用户措辞不同，且能力恢复后**不需要**重新确认依据。
 */
export function decideCapabilityAvailability(input: {
  readonly requiredCapability: string | undefined
  readonly availableCapabilities: readonly string[]
}): { readonly kind: 'none' } | { readonly kind: 'block'; readonly reasonCode: 'capability_unavailable' } {
  if (input.requiredCapability === undefined) return { kind: 'none' }
  if (input.availableCapabilities.includes(input.requiredCapability)) return { kind: 'none' }
  return { kind: 'block', reasonCode: 'capability_unavailable' }
}

// ---------------------------------------------------------------------------
// 读侧遮蔽（**独立于写侧**）
// ---------------------------------------------------------------------------

export type GoalMaskingReason = 'explicit_forget' | 'withdrawn_source'

export type GoalMaskingVerdict =
  | { readonly mask: true; readonly reason: GoalMaskingReason; readonly hits: readonly string[] }
  | { readonly mask: false }

export interface GoalMaskingInput {
  /** 这一行的**当前**状态（可能是 active —— 遮蔽**不要求**取消事件已经写下） */
  readonly goal: GoalState
  /** 当前撤销集（M9.1 `D16` 端口给出的事件 id 集合） */
  readonly withdrawnEventIds: ReadonlySet<string>
}

/**
 * 这一项目标的正文**是否必须退出普通上下文**（§5 第 5 条的两个触发条件）。
 *
 * ```text
 * ① 它的最近一次取消原因是 `explicit_forget`（"忘掉这项目标"）
 * ② 它的**任一**来源事件落在**当前**撤销集里
 * ```
 *
 * ⚠️ 触发条件②**不依赖**任何取消事件：一个仍然 `active`、但来源被撤的目标
 *    照样被遮蔽。这是"读侧立即遮蔽"与"写侧最终收敛"之间的**唯一**保证 ——
 *    若遮蔽要靠写侧先跑，那么写侧失败的那一轮就会泄漏（M9 的 F-1 同族缺陷）。
 *
 * ⚠️ 它**不**声称"忘掉 = 物理擦除"（append-only 审计照旧）；它回答的是
 *    "这一项能不能进普通上下文与普通查询"。
 */
export function goalContentMustBeMasked(input: GoalMaskingInput): GoalMaskingVerdict {
  if (input.goal.cancelReason === 'explicit_forget') {
    return { mask: true, reason: 'explicit_forget', hits: [] }
  }
  const hits = input.goal.sourceRefs
    .map((ref) => String(ref.conversationEventId))
    .filter((id) => input.withdrawnEventIds.has(id))
  if (hits.length > 0) {
    return { mask: true, reason: 'withdrawn_source', hits }
  }
  return { mask: false }
}

/**
 * 一项目标是否**还能进普通上下文**（遮蔽的补集；调用方不必自己取反）。
 *
 * ⚠️ 与 `goalContentMustBeMasked` 共用同一份判定 —— 两处各写一遍"什么算可用"
 *    迟早漂移（`qualification-read.ts` 文件头登记过同一条教训）。
 */
export function goalUsableInOrdinaryContext(input: GoalMaskingInput): boolean {
  return !goalContentMustBeMasked(input).mask
}

// ---------------------------------------------------------------------------
// 旧根禁用（"不因内容再次出现而解除"）
// ---------------------------------------------------------------------------

/**
 * 一次新的 `create` 的来源是否被**任何既有目标**的禁用根挡住（M9 的 B28 机制）。
 *
 * ⚠️ 它**只看来源事件 id**，不看内容：这正是"旧根禁用不因内容再次出现而解除"的
 *    可执行形式 —— 用户换个说法重述同一件事，仍然被挡住；而**新的独立来源**
 *    （新的一轮里的新事件）自然不在集合里，因此可以建立新身份。
 */
export function forbiddenRootHits(
  existingGoals: readonly GoalState[],
  incomingSourceEventIds: readonly string[],
): string[] {
  const forbidden = new Set<string>()
  for (const goal of existingGoals) {
    for (const id of goal.forbiddenSourceEventIds ?? []) forbidden.add(String(id))
  }
  return incomingSourceEventIds.map(String).filter((id) => forbidden.has(id))
}

/** 禁用根集合的并集（给 trace / 开发者面用；**只有 id**） */
export function forbiddenRootsOf(existingGoals: readonly GoalState[]): string[] {
  const out = new Set<string>()
  for (const goal of existingGoals) {
    for (const id of goal.forbiddenSourceEventIds ?? []) out.add(String(id))
  }
  return [...out].sort()
}

// ---------------------------------------------------------------------------
// 冲突处理（§6.4）
// ---------------------------------------------------------------------------

export type GoalConflictKind =
  /** 同一对象上的同一件事被要求了**两种不同的机器可判成功条件** */
  | 'same_subject_statement_different_criterion'
  /** 同一对象上的同一件事同时存在**两个 active 目标**，且来源权威不同 */
  | 'same_subject_statement_duplicate_active'

export interface GoalConflictVerdict {
  readonly conflict: boolean
  readonly kind?: GoalConflictKind
  readonly detail?: string
}

function normalizedStatement(goal: GoalState): string {
  return goal.statement.trim().replace(/\s+/g, '')
}

function subjectKeyOf(goal: GoalState): string {
  return goal.targetEntity === undefined
    ? '(no-target)'
    : `${goal.targetEntity.kind}:${String(goal.targetEntity.id)}`
}

function criterionKeyOf(goal: GoalState): string {
  const criterion = goal.successCriterion
  if (criterion.kind === 'conversation_output') {
    return criterion.structure.kind === 'item_count'
      ? `conversation_output:item_count:${String(criterion.structure.count)}`
      : `conversation_output:marker_set:${criterion.structure.markers.join(',')}`
  }
  if (criterion.kind === 'action_result') {
    return `action_result:${criterion.capability}:${criterion.operation}`
  }
  return 'user_report'
}

/**
 * 两项目标**是否冲突且无法唯一决定**（§6.4）。
 *
 * v1 只判两类（**可机器判定**的）：
 * ```text
 * ① 同对象 + 同描述 + **不同**的机器可判 criterion ⇒ 同一件事被要求了两种成功条件
 * ② 同对象 + 同描述 + 两个都 active      ⇒ 同一件事有两个活着的记录
 * ```
 * 其余一切"看起来冲突"的情况**不**在这里猜 —— 它们属于 WP10 的语义评测
 * （登记为限制：`L-M10-14`）。
 *
 * ⚠️ 判定必须**对称**（`detect(a,b) === detect(b,a)`）：不对称的冲突判定会让
 *    "先看哪一项"改变结论，而那正是 §4.10 要避免的。
 */
export function detectGoalConflict(a: GoalState, b: GoalState): GoalConflictVerdict {
  if (String(a.goalId) === String(b.goalId)) return { conflict: false }
  if (subjectKeyOf(a) !== subjectKeyOf(b)) return { conflict: false }
  if (normalizedStatement(a) !== normalizedStatement(b)) return { conflict: false }
  if (normalizedStatement(a) === '') return { conflict: false }

  const aMachine = a.successCriterion.kind !== 'user_report'
  const bMachine = b.successCriterion.kind !== 'user_report'
  if (aMachine && bMachine && criterionKeyOf(a) !== criterionKeyOf(b)) {
    return {
      conflict: true,
      kind: 'same_subject_statement_different_criterion',
      detail: `同一件事被要求了两种成功条件：${criterionKeyOf(a)} vs ${criterionKeyOf(b)}`,
    }
  }
  if (a.status === 'active' && b.status === 'active') {
    return {
      conflict: true,
      kind: 'same_subject_statement_duplicate_active',
      detail: '同一件事同时存在两个 active 目标',
    }
  }
  return { conflict: false }
}

/** 一场冲突里涉及的全部目标 id（升序；**两条记录都保留**，不合并、不删除） */
export function conflictMembers(goals: readonly GoalState[]): string[] {
  const seen = new Set<string>()
  for (let i = 0; i < goals.length; i += 1) {
    for (let j = i + 1; j < goals.length; j += 1) {
      if (detectGoalConflict(goals[i]!, goals[j]!).conflict) {
        seen.add(String(goals[i]!.goalId))
        seen.add(String(goals[j]!.goalId))
      }
    }
  }
  return [...seen].sort()
}

/**
 * 多目标的**确定性**排序（§4.10 的规则，落到可执行形式）。
 *
 * ```text
 * ① 本轮明确点名（`namedGoalIds`）
 * ② 本轮明确续接且唯一（`continuedGoalId`）
 * ③ 高优先级
 * ④ 其余
 * 同分按 **goalId 升序**（稳定，不依赖输入顺序）
 * ```
 *
 * ⚠️ 暂停 / 终态 / 受阻的目标**不参与**（它们不得伪装成仍可执行）；
 *    但"没被选中"与"不存在"是两件事 —— 调用方要如实报"有 N 项因状态不可执行被排除"。
 */
export function orderGoalsForFocus(
  goals: readonly GoalState[],
  input: { readonly namedGoalIds?: readonly string[]; readonly continuedGoalId?: string } = {},
): { readonly ordered: GoalState[]; readonly excludedByState: string[] } {
  const excludedByState = goals
    .filter((goal) => goal.status !== 'active')
    .map((goal) => String(goal.goalId))
    .sort()
  const runnable = goals.filter((goal) => goal.status === 'active')
  const named = new Set((input.namedGoalIds ?? []).map(String))

  const rank = (goal: GoalState): number => {
    if (named.has(String(goal.goalId))) return 0
    if (input.continuedGoalId !== undefined && String(goal.goalId) === String(input.continuedGoalId)) {
      return 1
    }
    if (goal.priority === 'high') return 2
    return 3
  }

  const ordered = [...runnable].sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    return String(a.goalId) < String(b.goalId) ? -1 : String(a.goalId) > String(b.goalId) ? 1 : 0
  })
  return { ordered, excludedByState }
}
