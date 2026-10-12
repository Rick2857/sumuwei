/**
 * M10 WP2 —— **Goal 依赖引用的契约**（ADR-076 `D25` / §4.6）。
 *
 * ============================================================================
 *  这个文件要解决的问题
 * ============================================================================
 * M9.5 交给 M10 的两个 fixture（`src/kernel/app/recall/handoff-fixtures.ts`）
 * 暴露了两处**结构性**缺口（WP0 基线报告 §3 的 Q1）：
 *
 * ```text
 * ① `referencesFromOutcome()` 把 `sourceRevision` **固定为 1**
 *    ⇒ 那不是"真实版本"，只是 fixture 层的常量。
 * ② `recheckReferences()` 只调用消费者传入的 `stillValid()` 回调
 *    ⇒ 它自身不查库、不比版本；"复核"这个名字不构成证明。
 * ```
 *
 * ⇒ 本文件给出**真的**引用形状：引用携带**捕获时**的真实 revision（或投影版本），
 *    复核把当前读数与它比对，并给出**具名**的拒绝原因。
 *
 * ============================================================================
 *  三条从既有裁定继承来的硬性质
 * ============================================================================
 * ① **失败关闭**：读不到 ⇒ `unavailable`。它**不是** `usable`，
 *    也**不是** `root_missing`（"不知道"与"没有"是两件事 ——
 *    见 `contracts/memory-record-status.ts` 的 `state_unknown` 同款立场）。
 * ② **缺口具名、不合并**（M9.1 `D19` / ADR-055 `D-55e`）：撤销集有具名缺口时，
 *    它有自己的原因 `withdrawn_incomplete`，不并进 `forgotten`，也不并进 `unavailable`。
 * ③ **必要前提与可选背景在类型上就分开**（ADR-076 `D09` / §4.6）：
 *    `inferred` / `tentative` / `disputed` 的引用**可以**作可选背景，
 *    **不可以**作硬前提 —— 这一点由 `ReferenceUsability` 的 `as` 字段表达，
 *    而不是靠调用方记得去查 `epistemicKind`。
 *
 * ⚠️ 本文件是**纯契约 + 纯函数**：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 */

import type { BeliefEpistemicKind, BeliefStatus, BeliefSupportLevel } from './belief.ts'
import type { EntityRef } from './entity.ts'
import { entityLabel } from './entity.ts'

// ---------------------------------------------------------------------------
// 引用形状（ADR-076 D25）
// ---------------------------------------------------------------------------

/**
 * 指向**一条 Memory 记录**的引用。
 *
 * ⚠️ `sourceRevision` 是**捕获时**从记录上读到的真实 `revision`
 *    （`memory-store.ts` 的行映射读它、折叠时递增）。
 *    它是"事后是否变了"的比对基准 —— **不是**一个可以写死的常量。
 *
 * ⚠️ 只有 id / 版本 / 证据指针，**没有正文**：引用的用途是"能不能用这件东西"，
 *    不是"这件东西说了什么"。
 */
export interface MemoryReference {
  readonly memoryId: string
  /** 捕获时的真实记录版本 */
  readonly sourceRevision: number
  /** 支撑该记录的根证据 id（用于遗忘遮蔽判定） */
  readonly evidenceIds: readonly string[]
}

/**
 * 指向**一条 Belief 投影行**的引用。
 *
 * ⚠️ `projectionRevision` 是投影**行**的 `revision`（`CharacterProjection.revision`），
 *    不是 `BeliefState` 里的字段 —— 后者没有这个值（WP0 基线报告 §3 的 Q2）。
 *
 * ⚠️ `epistemicKind` / `supportLevel` / `status` **必须随行**（M9 → M10 交接 §2 第 5 条）：
 *    下游不许把 `inferred` / `disputed` 压成确定事实。
 */
export interface BeliefReference {
  readonly beliefId: string
  readonly projectionRevision: number
  readonly epistemicKind: BeliefEpistemicKind
  readonly supportLevel: BeliefSupportLevel
  readonly status: BeliefStatus
  /**
   * 支撑该信念的**根事件** id（遗忘遮蔽与"本轮刚失效的根"判定的输入）。
   *
   * ⚠️ 它必须在引用里：同轮 overlay 要回答"这条信念的**根**刚刚失效了吗"，
   *    而那时**不能再读一次库**（那正是"持有旧授权快照"的反面，也是
   *    M9 §5.3 要求 overlay 是纯函数的原因）。引用不带证据指针 ⇒
   *    那一支判定在类型上就写不出来。
   */
  readonly evidenceRootIds: readonly string[]
  /** 该信念依赖的 Memory id（同轮 Memory 失效 overlay 的输入） */
  readonly dependsOnMemoryIds: readonly string[]
}

/** 一条 Goal 依赖（v1 只有两类来源；`root_evidence` 是 Goal 自身来源，不走这里） */
export type GoalDependencyRef =
  | { readonly kind: 'memory'; readonly memoryId: string }
  | { readonly kind: 'belief'; readonly beliefId: string }

/** 依赖的稳定键（去重、计数、trace 都用它；**不含正文**） */
export function dependencyKeyOf(dep: GoalDependencyRef): string {
  return dep.kind === 'memory' ? `memory:${dep.memoryId}` : `belief:${dep.beliefId}`
}

// ---------------------------------------------------------------------------
// 拒绝原因：闭集 + 可达性事实（沿用 `memory-record-status.ts` 的既有纪律）
// ---------------------------------------------------------------------------

/**
 * 引用不可用的**具名原因**（闭集）。
 *
 * 顺序即**判定优先级**（见 `inputs.ts` 的 `recheckGoalDependencies`）：
 * 越靠前的原因越"确定"，越靠后的越"派生"。
 */
export type ReferenceRejectionReason =
  /** 读端口失败 / 状态不可用 —— **失败关闭**（不是 usable，也不是"不存在"） */
  | 'unavailable'
  /** 记录 / 投影行**不存在** */
  | 'root_missing'
  /** 存在，但 owner / subject **跨角色** */
  | 'foreign'
  /** 引用的证据落在**当前撤销集**里（遗忘泄漏轴；必须遮蔽） */
  | 'forgotten'
  /** 撤销集**有具名缺口** ⇒ 无法证明"未被遗忘"（失败关闭，宁过遮不漏） */
  | 'withdrawn_incomplete'
  /** 投影 / 记录版本已变 ⇒ 这个指针是旧快照，**不得**继续用 */
  | 'revision_changed'
  /** 当前状态不可用（retracted / superseded / 未知状态） */
  | 'status_not_usable'
  /**
   * **本轮程序结果**刚把它的依赖作废（同轮 overlay）。
   *
   * 与 `forgotten` 刻意分开：`forgotten` 是"**已持久**的撤销集里有它"，
   * 这一条是"**本轮**刚发生、写侧可能还没收敛"。两者都是不可用，
   * 但原因不同 —— 合并会让"读侧即刻遮蔽是否真的独立于写侧"无法被机器检查。
   * （与 M9 的 `applyInvalidationOverlay` → `overlaid` 是同一个理由、同一套词汇。）
   */
  | 'overlaid'

export const REFERENCE_REJECTION_REASONS: readonly ReferenceRejectionReason[] = [
  'unavailable',
  'root_missing',
  'foreign',
  'forgotten',
  'withdrawn_incomplete',
  'revision_changed',
  'status_not_usable',
  'overlaid',
]

/**
 * 每个原因的**可达性事实**。
 *
 * 为什么要有这张表：把"表达得了但永远出不来"的值静默留在枚举里，
 * 是这个仓库反复登记过的那类损失（见 `memory-record-status.ts` /
 * `contracts/recall.ts` 的同名做法）。今天没有生产者的原因必须**具名写下来**。
 *
 * ⚠️ WP2 的七个原因**全部**由生产端口可达，且各自有正控 / 负控用例
 *    （`scripts/m10-inputs-verify.ts` 的 `I3` / `I5` / `I6` / `I8` / `I9` / `I12`）。
 */
export interface ReferenceRejectionFact {
  readonly reachable: boolean
  /** 谁产它（源码坐标 / 机制名） */
  readonly producer: string
  /** `reachable: false` 时必须写明"为什么今天出不来" */
  readonly blocker?: string
}

export const REFERENCE_REJECTION_FACTS: Readonly<
  Record<ReferenceRejectionReason, ReferenceRejectionFact>
> = {
  unavailable: {
    reachable: true,
    producer: 'inputs.ts · recheckGoalDependencies 的 try/catch（端口抛错 ⇒ 全体 unavailable）',
  },
  root_missing: {
    reachable: true,
    producer: 'inputs.ts · 端口返回 undefined（记录 / 投影行不存在）',
  },
  foreign: {
    reachable: true,
    producer: 'inputs.ts · owner / subject 与 policy.characterId 不等',
  },
  forgotten: {
    reachable: true,
    producer: 'inputs.ts · 证据 id ∈ withdrawn.withdrawnEventIds（撤销集，M9.1 D16 端口）',
  },
  withdrawn_incomplete: {
    reachable: true,
    producer: 'inputs.ts · withdrawn.ok === false（具名缺口，M9.1 D19 失败关闭分级）',
  },
  revision_changed: {
    reachable: true,
    producer: 'inputs.ts · 当前 revision ≠ reference.sourceRevision / projectionRevision',
  },
  status_not_usable: {
    reachable: true,
    producer: 'inputs.ts · 当前 status ∉ 可用集合（见 USABLE_* 常量）',
  },
  overlaid: {
    reachable: true,
    producer: 'inputs.ts · applyGoalInvalidationOverlay（本轮程序结果刚作废的依赖 id）',
  },
}

/** 今天可达的原因（其余的是**登记在案的未实现**，不是"已实现"） */
export function reachableReferenceRejectionReasons(): ReferenceRejectionReason[] {
  return REFERENCE_REJECTION_REASONS.filter(
    (reason) => REFERENCE_REJECTION_FACTS[reason].reachable,
  )
}

/** 程序用语（中文；**不含任何用户内容**）——进 trace 与开发者面，不进 prompt 正文 */
export const REFERENCE_REJECTION_LABEL: Readonly<Record<ReferenceRejectionReason, string>> = {
  unavailable: '依赖读数不可用（失败关闭）',
  root_missing: '依赖对象不存在',
  foreign: '依赖对象属于其他角色/主体',
  forgotten: '依赖证据已被遗忘请求作废',
  withdrawn_incomplete: '撤销集不完整，无法证明未被遗忘',
  revision_changed: '依赖版本已变化（旧引用失效）',
  status_not_usable: '依赖当前状态不可用',
  overlaid: '依赖已在本轮被程序结果作废（同轮遮蔽）',
}

// ---------------------------------------------------------------------------
// 可用性判定（三态：硬前提 / 仅可选背景 / 不可用）
// ---------------------------------------------------------------------------

/**
 * 复核结论。
 *
 * ```text
 * { usable: true,  as: 'hard' }  可以作**必要前提**
 * { usable: true,  as: 'soft' }  只可以作**可选规划背景**（带标签）
 * { usable: false, reason }      不可用（具名原因）
 * ```
 *
 * ⚠️ `hard` / `soft` 的区分**不是**风格问题：ADR-076 §4.6 规定
 *    "必要事实前提失效 ⇒ blocked"、"可选规划偏好失效 ⇒ 只丢引用"。
 *    若这一层只回一个布尔，调用方就必须自己再查一次 `epistemicKind` /
 *    `status` 才能决定走哪条路 —— 而那正是"两处各判一遍、迟早漂移"的形状。
 */
export type ReferenceUsability =
  | { readonly usable: true; readonly as: 'hard' | 'soft' }
  | { readonly usable: false; readonly reason: ReferenceRejectionReason }

/** 可以作**硬前提**的 Memory 状态（只有当前有效的那一种） */
export const HARD_USABLE_MEMORY_STATUSES: readonly string[] = ['active']

/**
 * 可以作**可选背景**的 Memory 状态。
 *
 * `disputed`（存在矛盾证据、系统判不了）可以当背景，**不可以**当硬前提 ——
 * 与 Belief 的 `disputed` 同一条纪律（ADR-076 §4.6 / `G21`）。
 */
export const SOFT_USABLE_MEMORY_STATUSES: readonly string[] = ['active', 'disputed']

/** 可以作**硬前提**的 Belief：(kind, status) 都在允许集合里 */
export const HARD_USABLE_BELIEF_KINDS: readonly BeliefEpistemicKind[] = ['reported']
export const HARD_USABLE_BELIEF_STATUSES: readonly BeliefStatus[] = ['active']

/** 可以作**可选背景**的 Belief：(kind, status) 都在允许集合里 */
export const SOFT_USABLE_BELIEF_KINDS: readonly BeliefEpistemicKind[] = ['reported', 'inferred']
export const SOFT_USABLE_BELIEF_STATUSES: readonly BeliefStatus[] = ['active', 'disputed']

/**
 * Memory 状态的可用档位（`undefined` = 不可用）。
 *
 * 纯函数：只吃状态字符串，不读库。
 */
export function memoryStatusUsability(status: string): 'hard' | 'soft' | undefined {
  if (HARD_USABLE_MEMORY_STATUSES.includes(status)) return 'hard'
  if (SOFT_USABLE_MEMORY_STATUSES.includes(status)) return 'soft'
  return undefined
}

/**
 * Belief (kind, status) 的可用档位（`undefined` = 不可用）。
 *
 * ⚠️ `inferred` **永远**最多是 `soft`（ADR-076 `D06` / `G20`）：
 *    M9 的 inferred 是 `tentative`，把推测当硬前提就是计划 §7.1 明确禁止的
 *    "把推断当授权"的兄弟形态。
 */
export function beliefUsability(
  epistemicKind: BeliefEpistemicKind,
  status: BeliefStatus,
): 'hard' | 'soft' | undefined {
  if (
    HARD_USABLE_BELIEF_KINDS.includes(epistemicKind) &&
    HARD_USABLE_BELIEF_STATUSES.includes(status)
  ) {
    return 'hard'
  }
  if (
    SOFT_USABLE_BELIEF_KINDS.includes(epistemicKind) &&
    SOFT_USABLE_BELIEF_STATUSES.includes(status)
  ) {
    return 'soft'
  }
  return undefined
}

/** 这条复核结论能不能作**必要前提**（供 §4.6 的"必要依赖失效 ⇒ blocked"直接用） */
export function usableAsNecessaryPremise(usability: ReferenceUsability): boolean {
  return usability.usable && usability.as === 'hard'
}

/** 这条复核结论能不能作**可选规划背景** */
export function usableAsOptionalBackground(usability: ReferenceUsability): boolean {
  return usability.usable
}

/** 便捷构造：不可用（带具名原因） */
export function unusable(reason: ReferenceRejectionReason): ReferenceUsability {
  return { usable: false, reason }
}

/** 便捷构造：可用（带档位） */
export function usable(as: 'hard' | 'soft'): ReferenceUsability {
  return { usable: true, as }
}

// ---------------------------------------------------------------------------
// 身份隔离（ADR-076 §4.6 的"owner / target"复核项）
// ---------------------------------------------------------------------------

/**
 * 两个 `EntityRef` 是不是同一个（**id 与 kind 都必须相等**）。
 *
 * 刻意在本文件重写一个比较器而**不**调用 `entityRefEquals`：
 * 后者要求两边的 `kind` 都是**已登记**的 `EntityKind`，而这里的输入来自
 * 存储行（`ownerId` / `subjectKeys` 是裸字符串对）。
 * 比较用的是与 `entityLabel` **逐字同形**的 `${kind}:${id}` —— 单一形状，
 * 不引入第二种表示。
 */
export function sameEntityKey(a: EntityRef, kind: string, id: string): boolean {
  return entityLabel(a) === `${kind}:${id}`
}

/** 一组 subject 键里有没有命中给定实体（用于"主体隔离"判定） */
export function subjectKeysInclude(subjectKeys: readonly string[], ref: EntityRef): boolean {
  return subjectKeys.includes(entityLabel(ref))
}
