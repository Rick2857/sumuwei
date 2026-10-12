/**
 * M9.6 WP2 —— **统计口径**（计划 §7 / §7.1 / 契约 §8–§9）。
 *
 * ============================================================================
 *  三条纪律（本仓真实事故换来的）
 * ============================================================================
 * ```text
 * ① **分母为 0 ⇒ NOT RUN**，不是 0%、不是 PASS。
 *    `hashes_checked=0 / mismatches=0` 与"全部一致"在输出上长得一样（AGENTS.md §6.8）。
 * ② 每个量都**显式带** numerator / denominator ⇒ 读者能看见分母是什么。
 * ③ 随机性必须**可复现**：bootstrap 用**固定种子的 PRNG**，不用 `Math.random`。
 *    否则同一批数据两次运行会给出不同区间，"重复运行逐字节相同"就没了。
 * ```
 */

/** 任何标量量都带自己的分母；`notRun` 为真时 `value` 必须为 `null` */
export interface Metric {
  readonly numerator: number
  readonly denominator: number
  readonly value: number | null
  readonly notRun: boolean
}

export function ratio(numerator: number, denominator: number): Metric {
  if (denominator <= 0) return { numerator, denominator, value: null, notRun: true }
  return { numerator, denominator, value: numerator / denominator, notRun: false }
}

const fmt = (metric: Metric): string =>
  metric.value === null
    ? `NOT RUN (分母 ${String(metric.denominator)}）`
    : `${metric.value.toFixed(4)} (${String(metric.numerator)}/${String(metric.denominator)})`

export const describeMetric = fmt

export interface LabeledCase {
  readonly predicted: string
  readonly gold: string
}

/** 单标签准确率 */
export function accuracy(cases: readonly LabeledCase[]): Metric {
  const hit = cases.filter((item) => item.predicted === item.gold).length
  return ratio(hit, cases.length)
}

export interface MultiLabelCase {
  readonly predicted: readonly string[]
  readonly gold: readonly string[]
}

export interface MacroF1 {
  readonly macroF1: Metric
  readonly perLabel: Readonly<Record<string, { readonly precision: Metric; readonly recall: Metric; readonly f1: Metric }>>
  /** 金标里**一次都没出现**的标签数 ⇒ 该标签的 F1 无定义，不参与宏平均 */
  readonly labelsWithoutGold: readonly string[]
}

/**
 * 多标签 macro-F1：每个标签当作一个二分类问题。
 * ⚠️ 金标中从不出现的标签，其 recall 分母为 0 ⇒ 该标签 F1 **不参与**宏平均
 *    （把无定义当 0 会凭空压低分数，是"错分母"的一种）。
 */
export function macroF1(cases: readonly MultiLabelCase[], labels: readonly string[]): MacroF1 {
  const perLabel: Record<string, { precision: Metric; recall: Metric; f1: Metric }> = {}
  const labelsWithoutGold: string[] = []
  const usable: number[] = []

  for (const label of labels) {
    let tp = 0
    let fp = 0
    let fn = 0
    for (const item of cases) {
      const predicted = item.predicted.includes(label)
      const gold = item.gold.includes(label)
      if (predicted && gold) tp += 1
      else if (predicted && !gold) fp += 1
      else if (!predicted && gold) fn += 1
    }
    const precision = ratio(tp, tp + fp)
    const recall = ratio(tp, tp + fn)
    let f1: Metric
    if (precision.notRun || recall.notRun) {
      f1 = { numerator: 0, denominator: 0, value: null, notRun: true }
    } else {
      const p = precision.value as number
      const r = recall.value as number
      f1 =
        p + r === 0
          ? { numerator: 0, denominator: 1, value: 0, notRun: false }
          : { numerator: 2 * p * r, denominator: p + r, value: (2 * p * r) / (p + r), notRun: false }
    }
    perLabel[label] = { precision, recall, f1 }
    if (recall.notRun) labelsWithoutGold.push(label)
    else if (!f1.notRun && f1.value !== null) usable.push(f1.value)
  }

  const macroF1Metric: Metric =
    usable.length === 0
      ? { numerator: 0, denominator: 0, value: null, notRun: true }
      : {
          numerator: usable.reduce((sum, value) => sum + value, 0),
          denominator: usable.length,
          value: usable.reduce((sum, value) => sum + value, 0) / usable.length,
          notRun: false,
        }
  return { macroF1: macroF1Metric, perLabel, labelsWithoutGold }
}

/** 某个正类的召回（分母 = 金标为正的条数） */
export function recallFor(cases: readonly MultiLabelCase[], label: string): Metric {
  const gold = cases.filter((item) => item.gold.includes(label))
  const hit = gold.filter((item) => item.predicted.includes(label)).length
  return ratio(hit, gold.length)
}

/** 某个负类的假阳性率（分母 = 金标为负的条数） */
export function falsePositiveRateFor(cases: readonly MultiLabelCase[], label: string): Metric {
  const negative = cases.filter((item) => !item.gold.includes(label))
  const wrong = negative.filter((item) => item.predicted.includes(label)).length
  return ratio(wrong, negative.length)
}

/* ===========================================================================
 *  区间估计（确定性）
 * ========================================================================= */

/** Wilson 区间：小样本下比正态近似稳。`n = 0` ⇒ `null`（NOT RUN），**不**返回 [0,1] */
export function wilsonInterval(successes: number, total: number, z = 1.96): { readonly low: number; readonly high: number } | null {
  if (total <= 0) return null
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / denominator
  const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) }
}

/** mulberry32：小、确定、够用的 PRNG（**不**用 `Math.random`） */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * **成对** bootstrap 的准确率差区间（计划 §7 G3：95% 下界 ≥ −3 个百分点）。
 * ⚠️ 按 **case** 重采样 —— 同一题的三次响应**不是**三个独立样本（计划 §6.2）。
 */
export function pairedBootstrapDiff(
  candidateCorrect: readonly number[],
  baselineCorrect: readonly number[],
  options: { readonly iterations?: number; readonly seed?: number } = {}
): { readonly meanDiff: number; readonly low: number; readonly high: number; readonly n: number; readonly iterations: number } | null {
  const n = candidateCorrect.length
  if (n === 0 || baselineCorrect.length !== n) return null
  const iterations = options.iterations ?? 2_000
  const random = mulberry32(options.seed ?? 0x9e6)
  const diffs: number[] = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let candidateSum = 0
    let baselineSum = 0
    for (let index = 0; index < n; index += 1) {
      const pick = Math.floor(random() * n)
      candidateSum += candidateCorrect[pick] as number
      baselineSum += baselineCorrect[pick] as number
    }
    diffs.push(candidateSum / n - baselineSum / n)
  }
  diffs.sort((a, b) => a - b)
  const at = (q: number): number => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor(q * diffs.length)))] as number
  const observed = candidateCorrect.reduce((s, v) => s + v, 0) / n - baselineCorrect.reduce((s, v) => s + v, 0) / n
  return { meanDiff: observed, low: at(0.025), high: at(0.975), n, iterations }
}

/* ===========================================================================
 *  校准（只在**有明确金标**的分类概率上用；confidence 不进这里）
 * ========================================================================= */

export interface ProbabilityCase {
  /** 模型给正确类别的概率 ∈ [0,1] */
  readonly probability: number
  /** 金标：1 = 该判定正确，0 = 错误 */
  readonly outcome: 0 | 1
}

export function brierScore(cases: readonly ProbabilityCase[]): Metric {
  if (cases.length === 0) return { numerator: 0, denominator: 0, value: null, notRun: true }
  const total = cases.reduce((sum, item) => sum + (item.probability - item.outcome) ** 2, 0)
  return { numerator: total, denominator: cases.length, value: total / cases.length, notRun: false }
}

/** 分箱**预先固定**（契约 §9）；样本稀疏时如实标出每箱计数 */
export function expectedCalibrationError(  cases: readonly ProbabilityCase[],
  bins = 10
): { readonly ece: Metric; readonly bins: readonly { readonly low: number; readonly high: number; readonly count: number; readonly meanProbability: number | null; readonly meanOutcome: number | null }[] } {
  if (cases.length === 0) {
    return { ece: { numerator: 0, denominator: 0, value: null, notRun: true }, bins: [] }
  }
  const rows = [] as { low: number; high: number; count: number; meanProbability: number | null; meanOutcome: number | null }[]
  let weightedGapSum = 0
  for (let index = 0; index < bins; index += 1) {
    const low = index / bins
    const high = (index + 1) / bins
    const bucket = cases.filter((item) =>
      index === bins - 1 ? item.probability >= low && item.probability <= high : item.probability >= low && item.probability < high
    )
    if (bucket.length === 0) {
      rows.push({ low, high, count: 0, meanProbability: null, meanOutcome: null })
      continue
    }
    const meanProbability = bucket.reduce((sum, item) => sum + item.probability, 0) / bucket.length
    const meanOutcome = bucket.reduce((sum, item) => sum + item.outcome, 0) / bucket.length
    /* ECE = Σ (n_bin / N) · |acc_bin − conf_bin| ⇒ 分子记 Σ n_bin·|gap|，分母记 N */
    weightedGapSum += bucket.length * Math.abs(meanProbability - meanOutcome)
    rows.push({ low, high, count: bucket.length, meanProbability, meanOutcome })
  }
  return {
    ece: { numerator: weightedGapSum, denominator: cases.length, value: weightedGapSum / cases.length, notRun: false },
    bins: rows,
  }
}

/* ===========================================================================
 *  端到端结局记账（计划 §7 的分母纪律）
 * ========================================================================= */

/** 一个 case 的**端到端**结局 */
export type CaseOutcome =
  /** 拿到**格式合法**的响应（**即使预测是空集**也算法法测量 —— 合法空集不是空转） */
  | 'measured'
  /** 形状/协议违规（`invalid_output`） */
  | 'invalid_output'
  /** 传输/配置/身份问题（`unavailable`） */
  | 'unavailable'

export interface OutcomeCase {
  readonly outcome: CaseOutcome
  /** 仅 `measured` 有意义：该 case 的语义判定是否正确 */
  readonly predictedCorrect?: boolean
}

export interface OutcomeAccounting {
  readonly measured: number
  readonly invalidOutput: number
  readonly unavailable: number
  /** **主分母**：全部 case（端到端失败也算） */
  readonly endToEndDenominator: number
  /** ★ 主读数：失败计入分母、且计为错误 */
  readonly endToEndAccuracy: Metric
  /** 附列：只看有效响应；**不能替代**主读数 */
  readonly validOnlyAccuracy: Metric
  /** 完整合法输出率 = measured / 全部 */
  readonly outputValidRate: Metric
}

/**
 * ★ 计划 §7 逐字：「传输失败和非法输出**按端到端任务失败计入全量分母**；
 * 只看有效响应的语义指标**可另列**，但不能替代主读数。」
 *
 * ⚠️ 「全部失败 ⇒ 零错误」是这里最危险的自欺：安全零错误必须**同时**满足
 * 正例召回与实际有效响应要求。`outputValidRate` 就是把这件事显式化的那一列。
 */
export function accountOutcomes(cases: readonly OutcomeCase[]): OutcomeAccounting {
  const measured = cases.filter((item) => item.outcome === 'measured')
  const invalidOutput = cases.filter((item) => item.outcome === 'invalid_output').length
  const unavailable = cases.filter((item) => item.outcome === 'unavailable').length
  const correct = measured.filter((item) => item.predictedCorrect === true).length
  return {
    measured: measured.length,
    invalidOutput,
    unavailable,
    endToEndDenominator: cases.length,
    endToEndAccuracy: ratio(correct, cases.length),
    validOnlyAccuracy: ratio(correct, measured.length),
    outputValidRate: ratio(measured.length, cases.length),
  }
}
