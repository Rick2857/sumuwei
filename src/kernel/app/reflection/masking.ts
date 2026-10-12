/**
 * M11 WP8 —— **遮蔽判定的唯一来源**（ADR-085 §6.3 · `D07` · §5.2）。
 *
 * ============================================================================
 *  为什么必须只有一份
 * ============================================================================
 * 既有纪律逐字：「两处各写一遍『什么算可用』迟早漂移」—— 而漂移的那一侧
 * 就是**泄漏**的那一侧。M9 的 F-1 泄漏正是从"开发者面比聊天少一道资格检查"开始的。
 * ⇒ 对话侧与开发者面**共用** `reflectionContentMustBeMasked()`。
 *
 * ============================================================================
 *  三条判据
 * ============================================================================
 * ① **整条被撤回** ⇒ 遮蔽（`retracted_reflection`）：撤回意味着"整项退出普通查询"。
 * ② **任一根被遗忘/撤回** ⇒ 遮蔽（`withdrawn_source`），并把命中的根 id 记下来（**只有 id**）。
 * ③ **遮蔽与"读不到"分开**：`unavailable` 只是这一轮读不到，**不**构成遮蔽
 *    （否则一次查询失败会让一条正常的反思在开发者面里消失，而那是**另一种**错误）。
 *
 * ⚠️ 纯函数：没有 SQL、没有 `node:*`、不读时钟。
 */

import type { RootUsabilityReading } from '../../contracts/revision-intent.ts'

export type ReflectionMaskingReason = 'retracted_reflection' | 'withdrawn_source'

export type ReflectionMaskingVerdict =
  | { readonly mask: true; readonly reason: ReflectionMaskingReason; readonly hits: readonly string[] }
  | { readonly mask: false }

export interface ReflectionMaskingInput {
  /** 反思当前状态（`pending` / `accepted` / `rejected` / `retracted`） */
  readonly status: string
  /** 它依据的原始根 */
  readonly roots: readonly string[]
  /** 每条根的资格读数（各域既有资格链的产物） */
  readonly rootVerdicts: readonly RootUsabilityReading[]
}

/** **唯一**的遮蔽判定 */
export function reflectionContentMustBeMasked(
  input: ReflectionMaskingInput
): ReflectionMaskingVerdict {
  if (input.status === 'retracted') {
    return { mask: true, reason: 'retracted_reflection', hits: [] }
  }
  const byId = new Map(input.rootVerdicts.map((reading) => [reading.rootId, reading]))
  const hits = input.roots
    .filter((root) => {
      const reading = byId.get(root)
      if (reading === undefined) return false // 读不到 ≠ 遮蔽（判据 ③）
      if (reading.usable) return false
      return reading.reason === 'source_forgotten' || reading.reason === 'source_retracted'
    })
    .sort()
  if (hits.length > 0) return { mask: true, reason: 'withdrawn_source', hits }
  return { mask: false }
}
