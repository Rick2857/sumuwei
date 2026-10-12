/**
 * M9.5 WP6 —— **混合候选的合并、排序与截断**（D25/D26 的落地；纯函数）。
 *
 * ============================================================================
 *  它修的是 WP0 定位到的那一层（层④候选范围）
 * ============================================================================
 * ```text
 * WP0 的 S4 实测（隔离库、零模型）：
 *   目标记忆「我在写毕业论文」+ 问句「我现在在写什么？」（ADR-059 已修的那条）
 *     N=0   → 候选 1 · 合格 1 · **选中 1**   ✅
 *     N=50  → 扫描 51 · **候选 50** · 合格 50 · **选中 0** · 目标**不在候选池** ❌
 *   机制（读源码）：候选按 `recordedAt` 降序 → `slice(0, candidateLimit)`，
 *     而 lexical 命中**只加通道标签、不参与排序**。
 *   ⇒ 一条完美的命中，只要比最新的 50 条旧，就在资格层**之前**被丢掉。
 *
 * 于是本模块做三件事，而且**只做**这三件：
 *   ① `mergeChannelHits`   —— 按 **Memory ID** 合并通道（多通道命中 ≠ 多条记忆）
 *   ② `orderCandidates`    —— 版本化排序：
 *        `lexical-recency@1`（现状）= 新近度降序 + id 升序兜底（**off 必须逐字节等价**）
 *        `hybrid-relevance@1`     = **相关性降序**（词面 + 语义 + 相对间隔）
 *   ③ `truncateCandidates` —— **排序之后**才截断（D25 第 ①② 条）
 * ```
 *
 * ============================================================================
 *  三条不可越的边界
 * ============================================================================
 * ```text
 * · **不判资格**：本模块看不到 status / owner / 根证据 —— 那些由 eligibility 做。
 *   把资格藏进排序正是计划 §7.2 明令禁止的（门会因为永远收不到坏候选而空过）。
 * · **不发明冻结数字**：权重与门槛是**注入的**，且策略自带 `calibrated` 标志。
 *   本模块只提供一个 `PROVISIONAL` 默认（**明确标注未校准**），免得"顺手冻结"。
 * · **不用绝对余弦阈值**（D26）：见 `semantic-signal.ts` 的说明与实测。
 */
import type { RecallChannel } from '../../contracts/recall.ts'
import {
  type RetrievalPolicyVersion,
  type RankedScore,
  relativeMarginOf,
  semanticSignalOf,
} from './semantic-signal.ts'

// ---------------------------------------------------------------------------
// ① 按 Memory ID 合并通道
// ---------------------------------------------------------------------------

export interface ChannelHit {
  readonly memoryId: string
  readonly channel: RecallChannel
  /** 这一通道给出的原始分数（词面命中数 / 语义余弦 / 新近度）；缺省 0 */
  readonly score?: number
}

export interface MergedCandidate {
  readonly memoryId: string
  /** 命中它的通道集合（**去重**；顺序稳定） */
  readonly channels: readonly RecallChannel[]
  /** 按通道取**最大值**（同一通道多次出现时） */
  readonly channelScores: Readonly<Partial<Record<RecallChannel, number>>>
}

/**
 * 合并通道命中。
 *
 * ⚠️ 计划 §9.1 第 4 条：「按 Memory ID 合并通道与证据，**不把多通道命中当多条 Memory**」。
 *    同理 §2.3：「同一条 Memory 被十个相似问法命中，不是十份独立证据」。
 *    ⇒ 本函数的返回条数 = **不同 memoryId 的个数**（这是可断言的硬性质）。
 */
export function mergeChannelHits(hits: readonly ChannelHit[]): readonly MergedCandidate[] {
  const byId = new Map<string, { channels: Set<RecallChannel>; scores: Partial<Record<RecallChannel, number>> }>()
  for (const hit of hits) {
    const entry = byId.get(hit.memoryId) ?? { channels: new Set<RecallChannel>(), scores: {} }
    entry.channels.add(hit.channel)
    const previous = entry.scores[hit.channel]
    const next = hit.score ?? 0
    entry.scores[hit.channel] = previous === undefined ? next : Math.max(previous, next)
    byId.set(hit.memoryId, entry)
  }
  return [...byId.entries()]
    .map(([memoryId, entry]) => ({
      memoryId,
      channels: [...entry.channels].sort() as RecallChannel[],
      channelScores: entry.scores,
    }))
    .sort((a, b) => (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0))
}

// ---------------------------------------------------------------------------
// ② 版本化排序
// ---------------------------------------------------------------------------

/**
 * 排序用的一条候选。**它不带 status/owner** —— 那是刻意的（见文件头）。
 */
export interface OrderableCandidate {
  readonly memoryId: string
  /** 新近度（越大越新）；legacy 策略**只看它** */
  readonly recency: number
  /** 词面分数（命中片段数之类，原样来自 M4.1 的实现） */
  readonly lexical: number
  /**
   * 语义分量：`null` 表示**本次没有得到真实分数**。
   * 按 D26-④/R3，`null` **不得**被当成 0 参与（否则"伪启用"会看起来像"分数很低"）。
   */
  readonly semantic: number | null
}

export interface HybridRelevancePolicy {
  readonly version: 'hybrid-relevance@1'
  /**
   * 是否已由**开发/验证集校准并冻结**（契约 §2）。
   * ⚠️ 出厂默认是 **false**：在没校准之前不许把它当冻结值用。
   */
  readonly calibrated: boolean
  readonly weights: { readonly lexical: number; readonly semantic: number; readonly margin: number }
  /**
   * 相关性门槛（作用在**组合分数**上，不是原始余弦）。
   * `minMargin` 为 `null` 表示"不设间隔要求"。
   */
  readonly relevanceGate: { readonly minCombined: number; readonly minMargin: number | null }
}

/**
 * **冻结的混合召回策略**（M9.5 `L-M95-18` 用户裁定 **甲**：**维持等权即冻结**，2026-09-28）。
 *
 * ```text
 * 用户原话（第 52 轮）："calibrated=false 保持；完成开发集参数比较、独立验证集确认及旧强项回归后，
 *   在正式盲测前冻结策略参数并改为 true。此标志不代表盲测通过或获准生产激活。"
 * 三步**已齐**：① `m9.5:calibration@1`（dev 对照）· ② `m9.5:validation@1`（**独立 val** 确认）
 *   ③ `m9.5:legacy-strength@1`（旧强项回归）。
 * 「有限词面权重校准」（`m9.5:lexical-calibration@1`）= **NOT MET**（自然场景等权已满分 ⇒ 无改善空间）
 *   ⇒ 用户裁定 **甲**：**维持等权** ⇒ 冻结值就是下面的 `{ lexical: 1, semantic: 1, margin: 0.5 }`
 *   （**一个数字都没改**）。
 * ⚠️ **该标志不代表盲测通过，也不代表获准生产激活**（用户逐字）。
 * ⚠️ `m9.5:retrieval@1` **同时**断言"标志为 true"与"权重等于上面的冻结值"
 *    ⇒ 单改标志或单改权重**都会**被门抓住（不许静默改冻结值）。
 * ```
 */
export const PROVISIONAL_HYBRID_POLICY: HybridRelevancePolicy = {
  version: 'hybrid-relevance@1',
  calibrated: true,
  /*
   * ============================================================================
   *  ★ M9.5 / `D-5` **取值变更**（2026-10-01，用户裁定；`ADR-083` + `ADR-084`）
   * ============================================================================
   * ```text
   * 变更：`lexical` **1 → 1.5**（`semantic` 与 `margin` **不动**）
   * 依据：用户当轮规则 —— 扫 `{1, 1.25, 1.5, 2}`，取**同时满足全部对抗场景的最小值** ✓
   *   实测（`scripts/m9.5-d5-scan.ts`，**用真实函数现算强度**，判定看**截断后的实际选择**）：
   *     · 片段 2 字时代：**没有任何值达标**（A1 要 ≈w>1.47 · A5 要 ≈w<1.125 ⇒ 无交集）
   *     · `ADR-084` 把 CJK 片段改成 **3 字** 之后：
   *         w=1 ❌ · w=1.25 ❌ · **w=1.5 ✅ 全部满足** · w=2 ✅
   *       ⇒ **最小达标值 = 1.5** ⇒ 冻结它（**不取 2**）✓
   * ⚠️ **为什么必须显式记在这里**：`m9.5:retrieval@1` 那道门锁的是**机制**
   *    （R3 伪启用 / D26 禁绝对阈值 / 策略版本化），**不锁这个数值** ⇒
   *    **改权重不会被任何门拦下** ⇒ 不写下来就是**静默改参数** ✗
   * ⚠️ **回滚**：把这个数改回 `1`（一行）✓；语义与索引**都不受影响**（读时计算 ✓）
   * ⚠️ **不主张**：真库 `active` 记忆 1 条 ⇒ 排序**今天排不出差别**；收益受体量限制 ✓
   * ```
   */
  weights: { lexical: 1.5, semantic: 1, margin: 0.5 },
  relevanceGate: { minCombined: 0.5, minMargin: null },
}

export interface OrderedCandidate {
  readonly memoryId: string
  /** 组合相关性（legacy 策略下 = 新近度） */
  readonly relevance: number
  /** 该条在本次排序里用到的分量（可解释性；trace 只记数不记正文） */
  readonly parts: { readonly lexical: number; readonly semantic: number | null; readonly margin: number | null }
}

/**
 * 组合相关性。**没有任何绝对余弦阈值**（D26）：
 * `semantic` 只以**分数**形式进入，且必须**先**通过 `semanticSignalOf`（无分数即不可用）。
 */
export function combinedRelevance(
  candidate: OrderableCandidate,
  margin: number | null,
  policy: HybridRelevancePolicy
): number {
  const signal = semanticSignalOf({ available: candidate.semantic !== null, ...(candidate.semantic !== null ? { score: candidate.semantic } : {}) })
  const semanticPart = signal.kind === 'available' ? signal.score * policy.weights.semantic : 0
  const marginPart = margin === null ? 0 : margin * policy.weights.margin
  return Number((candidate.lexical * policy.weights.lexical + semanticPart + marginPart).toFixed(6))
}

/**
 * 版本化排序。**这是 D25 的核心那一处**。
 *
 * ```text
 * lexical-recency@1：recency 降序，同刻按 memoryId 升序（= 现状的稳定排序）
 * hybrid-relevance@1：相关性降序，同分按 memoryId 升序（**稳定 tie-break**）
 *                     相关性 = 词面 + 语义（有真实分数时才计入）+ 相对间隔
 * ```
 */
export function orderCandidates(input: {
  readonly candidates: readonly OrderableCandidate[]
  readonly policyVersion: RetrievalPolicyVersion
  readonly hybridPolicy?: HybridRelevancePolicy
}): readonly OrderedCandidate[] {
  const { candidates, policyVersion } = input
  if (policyVersion === 'lexical-recency@1') {
    return [...candidates]
      .sort((a, b) =>
        b.recency === a.recency ? (a.memoryId < b.memoryId ? -1 : 1) : b.recency - a.recency
      )
      .map((candidate) => ({
        memoryId: candidate.memoryId,
        relevance: candidate.recency,
        parts: { lexical: candidate.lexical, semantic: candidate.semantic, margin: null },
      }))
  }

  const policy = input.hybridPolicy ?? PROVISIONAL_HYBRID_POLICY
  /*
   * 相对间隔：按**当前这批候选**的语义分数算（头名 − 次名）。
   * ⚠️ 它是**批次内相对量**，不是绝对阈值 —— D26 第 ② 条。
   */
  const withSemantic = candidates.filter((candidate) => candidate.semantic !== null)
  const marginTop = relativeMarginOf(
    withSemantic.map((candidate) => ({ memoryId: candidate.memoryId, score: candidate.semantic as number }))
  )
  const marginFor = (candidate: OrderableCandidate): number | null =>
    candidate.semantic === null || marginTop.margin === null
      ? null
      : candidate.semantic === marginTop.topScore
        ? marginTop.margin
        : 0

  return [...candidates]
    .map((candidate) => {
      const margin = marginFor(candidate)
      return {
        memoryId: candidate.memoryId,
        relevance: combinedRelevance(candidate, margin, policy),
        recency: candidate.recency,
        parts: { lexical: candidate.lexical, semantic: candidate.semantic, margin },
      }
    })
    /*
     * ⚠️ tie-break 顺序是**有意的**：相关性 → **新近度** → id。
     *
     * 为什么中间那一级必须是新近度：hybrid 下大多数候选的 `lexical` 是 0
     * ⇒ 它们相关性**并列**；若直接掉到 id 升序，就等于把"最近的排在后面"，
     * 比 legacy 还糟（legacy 至少把最近的放前面）。
     * ⇒ 加新近度作第二关键字，既让"相关性高的"排在前面，又保住原来的兜底语义。
     * 末级用 id 保证**稳定**（同样的输入给同样的选择）。
     */
    .sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance
      if (b.recency !== a.recency) return b.recency - a.recency
      return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0
    })
    .map((item) => ({ memoryId: item.memoryId, relevance: item.relevance, parts: item.parts }))
}

// ---------------------------------------------------------------------------
// ③ 排序**之后**才截断（D25 第 ①② 条）
// ---------------------------------------------------------------------------

export interface TruncationResult {
  readonly kept: readonly OrderedCandidate[]
  readonly dropped: readonly OrderedCandidate[]
  readonly limit: number
  readonly droppedOldestKeptNewest: boolean
}

/**
 * 截断。**必须在排序之后调用** —— 这正是 WP0 那个缺口的修法：
 * 现状是"先按新近度截断"，本函数要求"先按相关性排序，再截断"。
 *
 * `droppedOldestKeptNewest` 是一个**可断言的自查**：如果被丢掉的**全都比留下的新**，
 * 说明调用方很可能又走回了"新近度优先"（legacy 行为），值得在门里盯着。
 */
export function truncateCandidates(
  ordered: readonly OrderedCandidate[],
  limit: number
): TruncationResult {
  const safeLimit = Math.max(0, Math.floor(limit))
  const kept = ordered.slice(0, safeLimit)
  const dropped = ordered.slice(safeLimit)
  const maxKept = kept.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...kept.map((item) => item.relevance))
  const minDropped = dropped.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...dropped.map((item) => item.relevance))
  return { kept, dropped, limit: safeLimit, droppedOldestKeptNewest: minDropped > maxKept }
}

/** 便捷组合：合并 → 排序 → 截断（**顺序固定**，调用方不能调换）。 */
export function selectCandidates(input: {
  readonly hits: readonly ChannelHit[]
  readonly orderables: readonly OrderableCandidate[]
  readonly policyVersion: RetrievalPolicyVersion
  readonly limit: number
  readonly hybridPolicy?: HybridRelevancePolicy
}): { readonly merged: readonly MergedCandidate[]; readonly truncation: TruncationResult } {
  const merged = mergeChannelHits(input.hits)
  const ordered = orderCandidates({
    candidates: input.orderables,
    policyVersion: input.policyVersion,
    ...(input.hybridPolicy !== undefined ? { hybridPolicy: input.hybridPolicy } : {}),
  })
  return { merged, truncation: truncateCandidates(ordered, input.limit) }
}
