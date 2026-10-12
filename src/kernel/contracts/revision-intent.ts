/**
 * M11 **跨域待审修订与失效**（ADR-085 `D07` · `D12` · `D13` · §5）。
 *
 * ============================================================================
 *  两条时间尺度，必须分开
 * ============================================================================
 * ```text
 * 当前轮（同步）：资格过滤 —— 支持源被忘掉/撤回/版本漂移 ⇒ **立刻**不可用（不等后台）
 * 后台（异步）：追加失效事件 + 更新投影 —— 把"为什么失效"落成可审计的记录
 * ```
 * ⚠️ 顺序不可颠倒（`D12`）：只做后台那一步 = 在窗口里继续用一个**已被遗忘的依据**作答。
 *
 * ============================================================================
 *  三条硬边界
 * ============================================================================
 * ① **修订是"提议"，不是"提交"**（`D13`）：`RevisionIntent` 里**没有** proposal 正文 ——
 *    目标领域的提案形状由该领域定义，M11 不替它造。
 * ② **越界不进待审面**：域必须是闭集里的一个；目标版本必须**真的**等于期望版本。
 * ③ **失败关闭**：拿不到某条根的资格读数 ⇒ 当**不可用**处理（不是"当作合格"）。
 */

import type { AdaptiveSelfSlot } from './adaptive-self.ts'

// ---------------------------------------------------------------------------
// 跨域待审意图
// ---------------------------------------------------------------------------

export type RevisionTargetDomain = 'memory' | 'belief' | 'goal' | 'commitment'

export const REVISION_TARGET_DOMAINS: readonly RevisionTargetDomain[] = [
  'memory',
  'belief',
  'goal',
  'commitment',
]

export function isRevisionTargetDomain(value: unknown): value is RevisionTargetDomain {
  return typeof value === 'string' && (REVISION_TARGET_DOMAINS as readonly string[]).includes(value)
}

/** 一条**待审**修订意图（只读面；由反思记录里的 `revisionIntent` 派生） */
export interface PendingRevisionIntent {
  readonly reflectionId: string
  /** 反思当时的结论（只有 pending / accepted 的记录才进待审面） */
  readonly reflectionStatus: string
  readonly domain: RevisionTargetDomain
  readonly targetId: string
  readonly expectedRevision: number
}

export type RevisionIntentCheckReason =
  | 'domain_not_allowed'
  | 'target_missing'
  | 'revision_changed'
  | 'intent_has_proposal_body'

export const REVISION_INTENT_CHECK_REASONS: readonly RevisionIntentCheckReason[] = [
  'domain_not_allowed',
  'target_missing',
  'revision_changed',
  'intent_has_proposal_body',
]

export type RevisionIntentCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RevisionIntentCheckReason; readonly detail: string }

/** 目标领域的**当前**读数（由该领域的只读面给出；M11 不自己算） */
export interface RevisionTargetReading {
  readonly exists: boolean
  readonly currentRevision: number
}

// ---------------------------------------------------------------------------
// 资格与失效
// ---------------------------------------------------------------------------

/** 一条根的资格读数（**各域既有资格链**的产物；M11 只消费） */
export interface RootUsabilityReading {
  readonly rootId: string
  readonly usable: boolean
  /** 不可用时的具名原因（闭集见验收契约 §3.3 的「资格 / 版本」族） */
  readonly reason?:
    | 'source_forgotten'
    | 'source_retracted'
    | 'source_version_changed'
    | 'source_privacy_masked'
    | 'unavailable'
}

export type SourceBlockReason =
  | 'source_forgotten'
  | 'source_retracted'
  | 'source_version_changed'
  | 'source_privacy_masked'
  | 'unavailable'

/** 当前轮里"这条反思 / 这个槽还能不能用" */
export type SameTurnUsability =
  | { readonly usable: true }
  | { readonly usable: false; readonly reason: SourceBlockReason; readonly at: string; readonly detail: string }

/** 失效事件的**确定性**形状（幂等键的第 5 个分量由它派生） */
export interface InvalidationPlan {
  readonly reflectionId: string
  readonly cause: Exclude<SourceBlockReason, 'unavailable' | 'source_privacy_masked'>
  readonly causeEventId: string
}

export type InvalidationOutcome =
  | { readonly kind: 'invalidate'; readonly plan: InvalidationPlan }
  | { readonly kind: 'no_change'; readonly reason: string; readonly detail: string }

/** 槽位状态 + 它的根（当前轮过滤的输入） */
export interface AdaptiveSelfUsabilityInput {
  readonly slot: AdaptiveSelfSlot
  readonly roots: readonly string[]
  readonly rootVerdicts: readonly RootUsabilityReading[]
}

export type AdaptiveSelfUsability =
  | { readonly slot: AdaptiveSelfSlot; readonly usable: true }
  | {
      readonly slot: AdaptiveSelfSlot
      readonly usable: false
      readonly reason: SourceBlockReason
      readonly at: string
      readonly detail: string
    }
