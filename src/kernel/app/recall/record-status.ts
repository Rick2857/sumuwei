/**
 * M6.1 WP4 / ADR-055 `D-55e`：**从程序事实构造记录状态**。
 *
 * ============================================================================
 *  它把"这一轮到底发生过什么"变成五个**不可互相折叠**的情形
 * ============================================================================
 * 用户 2026-09-24 的裁定（照录）：
 *
 *     检索失败、预算裁剪、未检索、已遗忘，也不能统一渲染成同一种"没有记忆"。
 *
 * 因此这里**不造判据**：原因一律取自既有的程序事实 ——
 *   · `RecallDecisionRecord.metrics.exclusionHistogram`（各排除理由命中的条数）
 *   · `metrics.droppedByBudget` / `metrics.droppedByContextBudget`（两种预算裁剪）
 *   · `selectedIds.length`（**编译之后**真正进上下文的条数）
 *   · 网关给出的三条"没检索"缺省与捕获到的检索失败
 *
 * ⚠️ 本文件是**纯函数**：不读时钟、不碰数据库、不写任何东西。
 */

import type { MemoryRecordStatus, MemoryRecordStatusReason } from '../../contracts/memory-record-status.ts'
import type { NotSearchedCause } from '../../contracts/memory-record-status.ts'
import {
  recordStatusReasonOfExclusion,
  type RecallExclusionReason,
} from '../../contracts/recall.ts'
import type { RecallDecisionRecord } from '../../recall/record.ts'

/**
 * 这一轮**检索阶段**的三种结局。
 *
 * ⚠️ 三条缺省与"失败"必须分开：把"没查"渲染成"没有记录"，正是 R-2 要修的那件事。
 */
export type RecallAttempt =
  | { readonly status: 'ran'; readonly record: RecallDecisionRecord }
  | { readonly status: 'not_searched'; readonly cause: NotSearchedCause }
  | { readonly status: 'failed'; readonly reason: string }

function emptyDetail(): MemoryRecordStatus['detail'] {
  return {
    droppedByBudgetCount: 0,
    notRelevantCount: 0,
    ineligibleCounts: { forgotten: 0, superseded: 0, unconfirmed: 0, orphaned: 0 },
    ineligibleSlots: {},
    droppedByContextBudget: false,
  }
}

/**
 * 从"检索结局"构造记录状态。
 *
 * `record` 必须是**已经过 `applyContextReality()` 修正**的那一份：
 * `selectedIds` 在那之后表示"实际进上下文"，而状态行要说的正是这件事。
 */
export function buildMemoryRecordStatus(attempt: RecallAttempt): MemoryRecordStatus {
  if (attempt.status === 'not_searched') {
    return {
      reasons: ['not_searched'],
      includedCount: 0,
      detail: { ...emptyDetail(), notSearchedCause: attempt.cause },
    }
  }

  if (attempt.status === 'failed') {
    return {
      reasons: ['search_failed'],
      includedCount: 0,
      detail: { ...emptyDetail(), searchFailedReason: attempt.reason },
    }
  }

  const record = attempt.record
  const metrics = record.metrics
  const histogram = metrics.exclusionHistogram

  /*
   * 归并：**逐条读直方图**，再用契约里的标签映射翻译成状态原因。
   *
   * ⚠️ 这里**一个排除理由字面量都不写**：`m5:verify` 的静态锁（AT2.1）要求
   *    这些字符串只出现在契约与纯召回层 —— 判定层出现它们就是"第二套资格判定"的开端。
   */
  const merged = new Map<
    MemoryRecordStatusReason,
    { count: number; slots: Set<string> }
  >()
  for (const [reason, count] of Object.entries(histogram)) {
    if (count <= 0) continue
    const mapped = recordStatusReasonOfExclusion(reason as RecallExclusionReason)
    if (mapped === undefined) continue
    const entry = merged.get(mapped) ?? { count: 0, slots: new Set<string>() }
    entry.count += count
    /*
     * 槽位从**候选**里取（`decisions` 只记 `memoryId` + 理由，没有 `canonicalKey`），
     * 而候选明细可能被截断（`RECALL_RECORD_MAX_CANDIDATES`）—— 取不到槽位时
     * 渲染器会**拒绝**用那句带指称的话（宁可不说，也不要一句没有指称的断言）。
     */
    for (const decision of record.decisions) {
      if (decision.reason !== reason) continue
      const candidate = record.candidates.find((item) => item.memoryId === decision.memoryId)
      if (candidate?.canonicalKey !== undefined) entry.slots.add(candidate.canonicalKey)
    }
    merged.set(mapped, entry)
  }

  const reasons = [...merged.keys()]
  /*
   * 整段被上下文预算丢掉（`metrics.droppedByContextBudget`）也是一种"预算裁剪"：
   * 它**不是**排除理由，因此要从这里单独补进原因列表（去重后）。
   */
  const droppedByContextBudget = metrics.droppedByContextBudget === true
  if (metrics.droppedByBudget > 0 || droppedByContextBudget) {
    if (!reasons.includes('dropped_by_budget')) reasons.push('dropped_by_budget')
  }
  const countOf = (reason: MemoryRecordStatusReason): number => merged.get(reason)?.count ?? 0
  const slotsOf = (reason: MemoryRecordStatusReason): string[] =>
    [...(merged.get(reason)?.slots ?? [])].sort()

  return {
    reasons,
    includedCount: record.selectedIds.length,
    detail: {
      droppedByBudgetCount: metrics.droppedByBudget,
      notRelevantCount: countOf('no_relevant'),
      ineligibleCounts: {
        forgotten: countOf('ineligible:forgotten'),
        superseded: countOf('ineligible:superseded'),
        /*
         * ⚠️ `ineligible:unconfirmed` **今天不可达**，因此这里恒为 0 且**没有**产出路径：
         *    `RecallExclusionReason` 里没有"来源未确立"这一档（`UNCONFIRMED_ORIGIN`
         *    只影响渲染后缀，不产生排除理由）。它的可达性登记在
         *    `MEMORY_RECORD_STATUS_REASON_FACTS`，并由 L1 的"预留原因不得被产出"守着。
         */
        unconfirmed: 0,
        orphaned: countOf('ineligible:orphaned'),
      },
      ineligibleSlots: {
        ...(countOf('ineligible:forgotten') > 0
          ? { 'ineligible:forgotten': slotsOf('ineligible:forgotten') }
          : {}),
        ...(countOf('ineligible:superseded') > 0
          ? { 'ineligible:superseded': slotsOf('ineligible:superseded') }
          : {}),
      },
      droppedByContextBudget,
    },
  }
}
