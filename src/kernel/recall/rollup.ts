/**
 * M6 / ADR-050 —— Rolling Summary 的**选择逻辑**（纯函数，领域层）。
 *
 * ============================================================================
 *  它回答一个问题
 * ============================================================================
 * ```text
 *   在**有界窗口**里，哪些早期用户发言可以进这一轮的 prompt，按什么顺序，
 *   装不下时先丢谁，以及**为什么**没选某一条？
 * ```
 *
 * 与 `selector.ts`（记忆召回）是**两条不同的链**：
 *   · `selector.ts`  她**此刻想起**什么（长期记忆，按相关性/权威排序）
 *   · 本文件        她**早期说过**什么（本会话原文，按时间顺序，逐字）
 * 两者不互相替代，也不共享排序（ADR-050 §3.5 的关系表）。
 *
 * ============================================================================
 *  三条硬性质（都有机器判据）
 * ============================================================================
 *  ① **零写入**：本模块只读入参与出参，不 import 任何写路径，不产生副作用。
 *  ② **逐字**：item 正文只允许换行归一化（`normalizeRollupExcerpt`），
 *     门用**相等断言**把关，因此"改一个标点"也会失败。
 *  ③ **失败关闭**：读不到受信归因、类型不对、资格不是 ESTABLISHED、来源已失效
 *     ⇒ 该条**不入选**并记理由。**绝不**回落到 `actorType` 或"随手拼几条旧句子"。
 *
 * ⚠️ 本文件**不** import `../contracts/` 以外的东西（与 `recall/` 的既有方向一致）。
 */

import {
  buildRollupItem,
  classifyRollupSource,
  emptyRollupRejections,
  renderRollupBlock,
  renderRollupEntry,
  ROLLUP_SELECTOR_VERSION,
  type RollupItem,
  type RollupRejectionCode,
  type RollupRejectionCounts,
  type RollupSourceFacts,
} from '../contracts/rollup.ts'

/** token 量化器（基础设施注入；缺省按字符估算，与 `ContextCompiler` / `selector.ts` 的缺省一致） */
export type RollupTokenQuantifier = (text: string) => number

export interface SelectRollupInput {
  /** 本轮的会话（角色 × 用户）。跨会话来源会被 `out_of_scope` 拒掉 */
  readonly conversationId: string
  /**
   * 候选来源（**只读**，按任意顺序给都行 —— 内部会排序）。
   *
   * 调用方负责做"有界"的读取；但本函数**不信任**这一点：它自己再按
   * `scanCeiling` 截断并如实标 `coverageTruncated`。
   */
  readonly sources: readonly RollupSourceFacts[]
  /** 每条来源的 owner 判定（由读取层给出，**不由本层猜**） */
  readonly sourceOwnerMatches?: (facts: RollupSourceFacts) => boolean
  /** Recent Conversation 窗口内的来源 id：**Recent 优先**，摘要不重复同一来源 */
  readonly recentSourceEventIds: readonly string[]
  /** 扫描上限（决定性；超限必须如实暴露，不许静默补齐） */
  readonly scanCeiling: number
  /** 摘要额度（`ContextBudget.rollupTokens`）。0 = 关闭 ⇒ 产出空块 */
  readonly budgetTokens: number
  readonly quantifier?: RollupTokenQuantifier
}

export interface RollupSelection {
  /** 注入用的数据块。**空选择时是空串** —— 这是"prompt 与基线逐字节相同"的机制 */
  readonly blockText: string
  /** 进 Trace 的来源引用（**不含正文**） */
  readonly sourceRefs: readonly string[]
  readonly items: readonly RollupItem[]
  /** 覆盖的序列范围；空选择时为 `null`（"覆盖了什么"必须能说清楚） */
  readonly coveredSequenceRange: { readonly from: number; readonly to: number } | null
  /** 实际进入判定的来源条数（范围自检：它必须 > 0，否则是 MEASUREMENT INVALID） */
  readonly scannedEventCount: number
  /** 有资格但因**预算**未入选的条数（如实降级，不静默） */
  readonly omittedEligibleCount: number
  /** 与 Recent 窗口重叠而被跳过的条数（已有原文在上下文里，不属于"拒绝"） */
  readonly skippedByRecentWindow: number
  /** 扫描上限截断（`true` = 覆盖**不足**，必须写进报告） */
  readonly coverageTruncated: boolean
  readonly rejections: RollupRejectionCounts
  readonly selectorVersion: string
  /** `quantifier(blockText)` —— **估算的就是注入的**（同一个 blockText） */
  readonly estimatedTokens: number
}

function bump(counts: RollupRejectionCounts, code: RollupRejectionCode): RollupRejectionCounts {
  return { ...counts, [code]: counts[code] + 1 }
}

/**
 * 选择 + 渲染（一次性产出"要注入的那段文本"）。
 *
 * 为什么渲染在选择里完成：与 `selectMemoryContext` 同一条纪律 ——
 * **token 预算算的就是注入的那份文本**。如果让调用方各自渲染一遍，
 * 两者迟早分家，表现是"预算看起来守住了、实际超了"。
 */
export function selectRollup(input: SelectRollupInput): RollupSelection {
  const quantifier = input.quantifier ?? ((text: string) => Math.ceil(text.length / 2))
  const ownerMatches = input.sourceOwnerMatches ?? (() => true)
  const recent = new Set(input.recentSourceEventIds.map((id) => String(id)))

  // 决定性排序：sequence 升序，同序号按 eventId 的 ordinal 升序（不依赖输入顺序）
  const ordered = [...input.sources].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence
    const left = String(a.eventId)
    const right = String(b.eventId)
    return left < right ? -1 : left > right ? 1 : 0
  })

  const scanned = ordered.slice(0, Math.max(input.scanCeiling, 0))
  const coverageTruncated = ordered.length > scanned.length

  let rejections = emptyRollupRejections()
  const eligible: RollupSourceFacts[] = []
  let skippedByRecentWindow = 0

  for (const facts of scanned) {
    const verdict = classifyRollupSource(facts, {
      sameConversation: facts.conversationId === input.conversationId,
      sameOwner: ownerMatches(facts),
    })
    if (!verdict.eligible) {
      rejections = bump(rejections, verdict.code)
      continue
    }
    // Recent 优先：同一来源已经在上下文里有**原文**，摘要里再出现一次是纯浪费预算
    if (recent.has(String(facts.eventId))) {
      skippedByRecentWindow += 1
      continue
    }
    eligible.push(facts)
  }

  /*
   * 预算：逐条试装，**每次都重新渲染整块**再去量化。
   *
   * 为什么不按"每条的成本相加"：量化器不保证可加（分隔符、header、四舍五入），
   * 而预算这条性质必须按**实际要注入的那段文本**判定。条数有界（≤ scanCeiling），
   * 因此 O(n²) 的代价换的是"估算即注入"，值得。
   */
  const kept: RollupItem[] = []
  let omittedEligibleCount = 0
  for (const facts of eligible) {
    const candidate = buildRollupItem(facts)
    const trial = renderRollupBlock([...kept, candidate])
    if (quantifier(trial) > input.budgetTokens) {
      omittedEligibleCount += 1
      continue
    }
    kept.push(candidate)
  }

  const blockText = renderRollupBlock(kept)
  const coveredSequenceRange =
    kept.length === 0
      ? null
      : { from: kept[0]!.sequence, to: kept[kept.length - 1]!.sequence }

  return {
    blockText,
    sourceRefs: kept.map((item) => `cev:${String(item.sourceEventId)}`),
    items: kept,
    coveredSequenceRange,
    scannedEventCount: scanned.length,
    omittedEligibleCount,
    skippedByRecentWindow,
    coverageTruncated,
    rejections,
    selectorVersion: ROLLUP_SELECTOR_VERSION,
    estimatedTokens: quantifier(blockText),
  }
}

/** 单条渲染（供门与开发者面对照"预算算的那一行"就是注入的那一行"） */
export { renderRollupEntry }
