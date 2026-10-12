/**
 * M9.5 WP6 —— **语义信号与相关性口径**（ADR-074 的 D25/D26；纯函数）。
 *
 * ============================================================================
 *  它存在的理由：WP1 量到的一件事，把"用绝对阈值"这条路堵死了
 * ============================================================================
 * ```text
 * WP1 的 `bridge-to-wp0`（3 条记忆 × 5 条问句）实测余弦：
 *   有目标的四条问句，目标余弦  0.8452 … 0.8896
 *   **负控**（无目标）的头名余弦 **0.8284**，而它的三个候选几乎并排
 *   （0.8284 / 0.8280 / 0.8224，**跨度只有 0.006**）
 * ⇒ 目标与负控的头名只差 **0.017**。于是：
 *     · 「余弦 ≥ 0.8 就算相关」**会**把负控召回进来 —— 那不是"宁可多召回"，
 *       而是把"她没告诉过我"变成"她告诉过我"（计划 §9.2 与 §18 都点名禁止）；
 *     · 而"**有没有明显领跑者**"这个量，在两侧是分开的：
 *         有目标：头名 − 次名 = 0.012 … 0.091（目标即头名）
 *         负控  ：头名 − 次名 = **0.0004**（几乎并排）
 * ⇒ D26 因此冻结：**禁止绝对余弦阈值**；相关性必须同时看词面分量、语义分量与**相对间隔**。
 * ```
 *
 * ⚠️ 本模块**不**导出任何绝对余弦阈值常量 —— 那是**刻意的**：
 *    `pnpm m9.5:retrieval:verify` 会断言"不存在这样一个常量"，
 *    免得将来有人"顺手加一个"。
 * ⚠️ 阈值与权重**不在这里**：它们由开发集 + 验证集校准后在验收契约 §2 冻结（D26 第 ② 条）。
 *    本模块只提供**信号**，不提供"及格线"。
 */

// ---------------------------------------------------------------------------
// 检索策略版本（D25 第 ③ 条：兼容靠版本化，不靠就地改语义）
// ---------------------------------------------------------------------------

/*
 * ⚠️ 类型与常量**定义在契约层**（`contracts/recall.ts`）：`MemoryRetrievalQuery` 要用它，
 *    而 `kernel/recall/**` 不许反向依赖 `kernel/app/**`（依赖方向单向）。
 *    ⇒ 本模块**重导出**它们，既有调用方不需要改 import 路径。
 */
/* 本模块内部要用这个类型 ⇒ 显式 import（`export { type X }` 不会把它带进作用域） */
import type { SemanticUnavailableReason } from '../../contracts/recall.ts'

export {
  DEFAULT_RETRIEVAL_POLICY_VERSION,
  RETRIEVAL_POLICY_VERSIONS,
  SEMANTIC_UNAVAILABLE_REASONS,
  isRetrievalPolicyVersion,
  semanticParticipates,
  type RetrievalPolicyVersion,
} from '../../contracts/recall.ts'
/* 原因类型同样定义在契约层（语义探针端口要用它）⇒ 从本模块重导出，调用方不必改路径 */
export type { SemanticUnavailableReason }

export interface SemanticSignalInput {
  /** capability 报告说"可用"吗 */
  readonly available: boolean
  /** 本次**实际**得到的语义分数（没有就是 undefined） */
  readonly score?: number
  /** 派生索引的维度（与模型清单不符时不可用） */
  readonly indexDimension?: number
  /** 模型清单声明的维度 */
  readonly modelDimension?: number
  readonly generationMatches?: boolean
  readonly timedOut?: boolean
  readonly modelPresent?: boolean
}

export type SemanticSignal =
  | { readonly kind: 'available'; readonly score: number }
  | { readonly kind: 'unavailable'; readonly reason: SemanticUnavailableReason }

/**
 * **R3 的机器形态**：`available === true` 但**没有真实分数** ⇒ 判**不可用**（`missing_score`）。
 *
 * ```text
 * 为什么这条必须有：附录 C 的 R3 说得直白 ——
 *   "只把通道加进枚举、或只把能力报告改成 available，会得到一个**永不参与**、
 *    却在 trace 里看起来已启用 的通道 —— 这种伪启用正负控都测不出来。"
 * 于是这里把"标志"与"分数"绑成同一件事：**没有分数就不许说可用**。
 * ```
 */
export function semanticSignalOf(input: SemanticSignalInput): SemanticSignal {
  if (input.modelPresent === false) return { kind: 'unavailable', reason: 'model_missing' }
  if (input.generationMatches === false) return { kind: 'unavailable', reason: 'generation_mismatch' }
  if (
    input.indexDimension !== undefined &&
    input.modelDimension !== undefined &&
    input.indexDimension !== input.modelDimension
  ) {
    return { kind: 'unavailable', reason: 'dimension_mismatch' }
  }
  if (input.timedOut === true) return { kind: 'unavailable', reason: 'timeout' }
  if (!input.available) return { kind: 'unavailable', reason: 'not_indexed' }
  if (input.score === undefined) return { kind: 'unavailable', reason: 'missing_score' }
  if (!Number.isFinite(input.score)) return { kind: 'unavailable', reason: 'non_finite_score' }
  return { kind: 'available', score: input.score }
}

// ---------------------------------------------------------------------------
// 相对间隔信号（D26 第 ② 条：绝对阈值之外还必须看它）
// ---------------------------------------------------------------------------

export interface RankedScore {
  readonly memoryId: string
  readonly score: number
}

export interface RelativeMargin {
  readonly topScore: number
  readonly secondScore: number | null
  /** 头名 − 次名（只有一个候选时为 `null`） */
  readonly margin: number | null
  /** 全体分数的跨度（头名 − 末名）—— 负控的"并排"靠它识别 */
  readonly spread: number
  readonly candidateCount: number
}

/**
 * 计算相对间隔。**它不判断"够不够相关"** —— 那是契约 §2 冻结的阈值与权重的职责。
 * 本函数只把"有没有明显领跑者"变成一个可读的数。
 */
export function relativeMarginOf(scores: readonly RankedScore[]): RelativeMargin {
  if (scores.length === 0) {
    return { topScore: Number.NaN, secondScore: null, margin: null, spread: 0, candidateCount: 0 }
  }
  const sorted = [...scores].sort((a, b) => b.score - a.score)
  const topScore = (sorted[0] as RankedScore).score
  const secondScore = sorted.length > 1 ? (sorted[1] as RankedScore).score : null
  const lastScore = (sorted[sorted.length - 1] as RankedScore).score
  return {
    topScore,
    secondScore,
    margin: secondScore === null ? null : Number((topScore - secondScore).toFixed(6)),
    spread: Number((topScore - lastScore).toFixed(6)),
    candidateCount: scores.length,
  }
}

/** 供门使用的**证据锚点**：WP1 `bridge-to-wp0` 的实测余弦（逐字取自那一次的证据档）。 */
export const WP1_BRIDGE_READINGS: Readonly<Record<string, readonly RankedScore[]>> = {
  'q-a': [
    { memoryId: 'project.background.active', score: 0.879334 },
    { memoryId: 'food.avoid.general', score: 0.83711 },
    { memoryId: 'education.institution', score: 0.829488 },
  ],
  'q-b': [
    { memoryId: 'project.background.active', score: 0.845153 },
    { memoryId: 'education.institution', score: 0.833021 },
    { memoryId: 'food.avoid.general', score: 0.80477 },
  ],
  'q-c': [
    { memoryId: 'education.institution', score: 0.868863 },
    { memoryId: 'project.background.active', score: 0.846871 },
    { memoryId: 'food.avoid.general', score: 0.80351 },
  ],
  'q-d': [
    { memoryId: 'food.avoid.general', score: 0.88958 },
    { memoryId: 'project.background.active', score: 0.798849 },
    { memoryId: 'education.institution', score: 0.785094 },
  ],
  'q-e-negative-control': [
    { memoryId: 'food.avoid.general', score: 0.828446 },
    { memoryId: 'project.background.active', score: 0.828013 },
    { memoryId: 'education.institution', score: 0.822446 },
  ],
}

/**
 * **为什么不能用绝对阈值**的可复核演示：给它一个绝对阈值，它会接受哪些？
 * （本函数只用于**展示** D26 的必要性；生产路径**不得**调用它。）
 */
export function absoluteThresholdWouldAccept(
  scores: readonly RankedScore[],
  absolute: number
): readonly string[] {
  return scores.filter((item) => item.score >= absolute).map((item) => item.memoryId)
}
