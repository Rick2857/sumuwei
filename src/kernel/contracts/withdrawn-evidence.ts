/**
 * 撤销证据契约（M9.1 / ADR-072 D16/D17/D19）—— F-1「遗忘后入模泄漏」的修复面。
 *
 * ============================================================================
 *  这里放什么
 * ============================================================================
 *  · `withdrawnSetCore`：撤销集计算的**纯核**（D16 的语义权威——生产端口
 *    `src/infrastructure/persistence/withdrawn-evidence.ts` 是它的薄读适配器；
 *    WP2 量具 `scripts/m9.1-fixtures.ts` 也 import 同一份——单一事实源，
 *    「参考语义与生产语义一致」由共享代码直接保证，不靠对照测试转述）。
 *  · 类型与失败关闭分级（D19）：缺口**具名**、不静默、不合并（D-55e）。
 *
 * ============================================================================
 *  为什么在 contracts
 * ============================================================================
 *  它是纯函数：输入记录快照与原因表，输出集合——不查库、不猜测、无副作用。
 *  消费方（turn-gateway 的遮蔽判定、infrastructure 的读端口、量具）都只依赖
 *  这一份语义。
 */
import type { EvidenceRef } from './memory.ts'

/** 撤回原因分类（D17 分轮处理的判据；原因只在 MEMORY_RETRACTED 事件 payload——WP0 实测） */
export type WithdrawnReason = 'explicit_forget' | 'explicit_correction' | 'audit'

export interface WithdrawnSetResult {
  /** false = 存在具名缺口（数据不完整）；调用方按 D19 决定降级动作 */
  ok: boolean
  /** 被撤事件 id 集合（去重） */
  withdrawnEventIds: string[]
  /** 事件 id → 原因分类（占位与 trace 用） */
  byReason: Record<string, WithdrawnReason>
  /** 具名缺口（不静默、不合并——D-55e） */
  gaps: string[]
  /** 处理的 retracted 记录数（计数自检 measured_count > 0） */
  measuredCount: number
}

export interface WithdrawnRecordInput {
  id: string
  canonicalKey?: string
  sourceRefs: EvidenceRef[]
}

/** 同槽 superseded 记录（按 canonicalKey 分组） */
export type SupersededBySlot = Map<string, WithdrawnRecordInput[]>

export const WITHDRAWN_CHAIN_LIMIT = 20

/**
 * 撤销集计算（纯核）。
 *
 * D17：`explicit_forget` ⇒ 自身 sourceRefs ∪ 同槽 superseded 链全部 sourceRefs
 * （T11：整段偏好史）；`explicit_correction` / `audit` ⇒ 仅自身（T17：更正史保留）。
 * 失败关闭分级（ADR-072 D19 + 契约 P11）：
 *   · reason 不可得（数据不完整）⇒ 按 `explicit_forget` 最宽遮蔽处理 + 具名缺口
 *     （泄漏是 severe 轴：宁过遮不漏；误伤由 P05/P06 正控钉住）
 *   · sourceRefs 为空（孤儿）⇒ 该记录贡献零事件 + 具名缺口（不伪装覆盖）
 *   · 链超界 ⇒ 截断 + 具名缺口（不静默）
 */
export function withdrawnSetCore(input: {
  retracted: WithdrawnRecordInput[]
  reasonById: Map<string, WithdrawnReason | undefined>
  supersededBySlot: SupersededBySlot
  chainLimit?: number
}): WithdrawnSetResult {
  const chainLimit = input.chainLimit ?? WITHDRAWN_CHAIN_LIMIT
  const withdrawn = new Set<string>()
  const byReason: Record<string, WithdrawnReason> = {}
  const gaps: string[] = []

  const addRefs = (refs: EvidenceRef[], reason: WithdrawnReason): void => {
    for (const ref of refs) {
      withdrawn.add(ref.id)
      byReason[ref.id] = reason
    }
  }

  for (const record of input.retracted) {
    const stored = input.reasonById.get(record.id)
    const reason: WithdrawnReason = stored ?? 'explicit_forget'
    if (stored === undefined) gaps.push(`reason_missing:${record.id}（按 explicit_forget 最宽处理）`)
    if (record.sourceRefs.length === 0) {
      gaps.push(`orphan_no_sources:${record.id}（该记录贡献零被撤事件）`)
      continue
    }
    addRefs(record.sourceRefs, reason)
    if (reason === 'explicit_forget' && record.canonicalKey !== undefined) {
      const chain = input.supersededBySlot.get(record.canonicalKey) ?? []
      if (chain.length > chainLimit) {
        gaps.push(`chain_truncated:${record.canonicalKey}:${String(chain.length)}>${String(chainLimit)}`)
      }
      for (const link of chain.slice(0, chainLimit)) addRefs(link.sourceRefs, reason)
    }
  }

  return {
    ok: gaps.length === 0,
    withdrawnEventIds: [...withdrawn],
    byReason,
    gaps,
    measuredCount: input.retracted.length,
  }
}
