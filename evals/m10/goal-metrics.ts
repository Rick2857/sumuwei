/**
 * M10 —— 语义评测的**度量机**（WP10 用；本文件是**唯一**一份实现）。
 *
 * ============================================================================
 *  为什么把它单独成一个文件
 * ============================================================================
 * WP10 有两个调用方，而它们**必须**用同一套算术：
 * ```text
 * scripts/m10-semantic-dry.ts  离线干跑：喂**已知答案**，验算术算的是它说的东西
 * （WP10 的真模型门）           真模型：喂真预测，出**可公布**的读数
 * ```
 * 若两处各写一份，"干跑过了"与"真跑对了"就是两件不同的事 —— 而 M10 已经在
 * `applyGoalRows` 上吃过一次"同一件事有两份实现"的亏（`m10:e2e` 与 harness 各一份接线）。
 *
 * ⚠️ **纯函数**：不 import SQL / 框架 / `node:*`。输入输出都是普通数据。
 *
 * ---------------------------------------------------------------------------
 *  两条会计纪律（写在最前面，因为它们最容易在"报数字"的压力下被放松）
 * ---------------------------------------------------------------------------
 * ```text
 * ① **分母必须与分子一起报**：每个类的 precision/recall/F1 都带自己的 support；
 *    macro-F1 只在**金标里出现过的类**上取平均，并报出"取平均的类数"
 *    ⇒ "语料里只有 3 条 query"这件事在读数上**看得见**，不会藏进一个漂亮的均值
 * ② **关键错误单独记账**：误建承诺 / 假兑现**不进**准确率的分子分母，
 *    它们是**否决项**（WP10 出口原文："存在关键误建承诺或假兑现即不得进入生产候选"）
 * ```
 */

/** 预测空间 = 语料 `byOperation` 的闭集（顺序即报告顺序） */
export const GOAL_METRIC_LABELS = [
  'none',
  'clarify',
  'create',
  'revise',
  'pause',
  'resume',
  'cancel',
  'report_complete',
  'query',
] as const

export type GoalMetricLabel = (typeof GOAL_METRIC_LABELS)[number]

/** **写操作**：会把状态改掉的那些（误判成它们的代价比误判成 `none` 大） */
export const GOAL_WRITE_OPERATIONS: readonly GoalMetricLabel[] = [
  'create',
  'revise',
  'pause',
  'resume',
  'cancel',
]

export interface LabelledCase {
  readonly caseId: string
  readonly layer: string
  readonly sourceText: string
  readonly gold: GoalMetricLabel
}

/** 混淆矩阵：**稀疏**（只记非零格），但 `rowTotals` 覆盖全部金标类 */
export interface ConfusionMatrix {
  readonly cells: ReadonlyMap<string, number>
  readonly rowTotals: ReadonlyMap<GoalMetricLabel, number>
  readonly columnTotals: ReadonlyMap<GoalMetricLabel, number>
  readonly total: number
}

function cellKey(gold: string, predicted: string): string {
  return `${gold}\u0000${predicted}`
}

export function confusionOf(
  cases: readonly LabelledCase[],
  predicted: readonly GoalMetricLabel[],
): ConfusionMatrix {
  if (cases.length !== predicted.length) {
    throw new Error(
      `m10-metrics：金标 ${String(cases.length)} 条与预测 ${String(predicted.length)} 条不等长`,
    )
  }
  const cells = new Map<string, number>()
  const rowTotals = new Map<GoalMetricLabel, number>()
  const columnTotals = new Map<GoalMetricLabel, number>()
  for (let index = 0; index < cases.length; index += 1) {
    const gold = cases[index]!.gold
    const guess = predicted[index]!
    const key = cellKey(gold, guess)
    cells.set(key, (cells.get(key) ?? 0) + 1)
    rowTotals.set(gold, (rowTotals.get(gold) ?? 0) + 1)
    columnTotals.set(guess, (columnTotals.get(guess) ?? 0) + 1)
  }
  return { cells, rowTotals, columnTotals, total: cases.length }
}

export function cellOf(matrix: ConfusionMatrix, gold: string, predicted: string): number {
  return matrix.cells.get(cellKey(gold, predicted)) ?? 0
}

export function accuracyOf(matrix: ConfusionMatrix): number {
  if (matrix.total === 0) return 0
  let hits = 0
  for (const label of GOAL_METRIC_LABELS) hits += cellOf(matrix, label, label)
  return hits / matrix.total
}

export interface PerClassMetric {
  readonly label: GoalMetricLabel
  /** 金标里这个类有几条 —— **分母必须与 F1 一起报** */
  readonly support: number
  /** 被判成这个类的有几条 */
  readonly predicted: number
  readonly precision: number
  readonly recall: number
  readonly f1: number
}

export function perClassOf(matrix: ConfusionMatrix): readonly PerClassMetric[] {
  const out: PerClassMetric[] = []
  for (const label of GOAL_METRIC_LABELS) {
    const support = matrix.rowTotals.get(label) ?? 0
    const predicted = matrix.columnTotals.get(label) ?? 0
    const truePositive = cellOf(matrix, label, label)
    /* ⚠️ 分母为 0 时**不**返回 0：返回 0 会让"这个类没被预测过"看起来像"全错"。
       约定：没有依据的比率是 `Number.NaN`，由调用方决定怎么呈现（本节用 support 过滤）。 */
    const precision = predicted === 0 ? Number.NaN : truePositive / predicted
    const recall = support === 0 ? Number.NaN : truePositive / support
    const f1 =
      Number.isNaN(precision) || Number.isNaN(recall) || precision + recall === 0
        ? Number.NaN
        : (2 * precision * recall) / (precision + recall)
    out.push({ label, support, predicted, precision, recall, f1 })
  }
  return out
}

export interface MacroF1 {
  readonly value: number
  /** **取平均的类数**（金标里出现过的类）—— 与 value 一起报 */
  readonly classesAveraged: number
  readonly labelsAveraged: readonly GoalMetricLabel[]
}

/**
 * macro-F1 —— **只在金标里出现过的类上取平均**。
 *
 * ⚠️ 为什么不是"全部 9 个类"：语料里 `query` 只有 17 条、`resume` 只有 4 条；
 *    把没出现过的类按 0 计入平均，会让均值取决于**语料的分层设计**，
 *    而不是系统的表现。⇒ 取平均的范围必须**显式报出来**（`classesAveraged`），
 *    让读者能自己判断"这个均值是几个类撑起来的"。
 */
export function macroF1Of(matrix: ConfusionMatrix): MacroF1 {
  const present = perClassOf(matrix).filter(
    (metric) => metric.support > 0 && !Number.isNaN(metric.f1),
  )
  if (present.length === 0) {
    return { value: Number.NaN, classesAveraged: 0, labelsAveraged: [] }
  }
  const sum = present.reduce((acc, metric) => acc + metric.f1, 0)
  return {
    value: sum / present.length,
    classesAveraged: present.length,
    labelsAveraged: present.map((metric) => metric.label),
  }
}

/** 按层（六层语义）分解 —— 每层都带自己的分母 */
export function perLayerOf(
  cases: readonly LabelledCase[],
  predicted: readonly GoalMetricLabel[],
): readonly { layer: string; total: number; hits: number; accuracy: number }[] {
  const layers = [...new Set(cases.map((item) => item.layer))].sort()
  const out: { layer: string; total: number; hits: number; accuracy: number }[] = []
  for (const layer of layers) {
    let total = 0
    let hits = 0
    for (let index = 0; index < cases.length; index += 1) {
      if (cases[index]!.layer !== layer) continue
      total += 1
      if (cases[index]!.gold === predicted[index]) hits += 1
    }
    out.push({ layer, total, hits, accuracy: total === 0 ? Number.NaN : hits / total })
  }
  return out
}

/**
 * **关键错误**（否决项，不进准确率）：
 * ```text
 * falseCreate    金标是 `none` / `clarify`（**没有**任何写入授权）却预测了写操作
 *                ⇒ "误建承诺" —— 把随口一说变成正式目标
 * falseFulfill   金标不是 `report_complete` 却预测了它 ⇒ "假兑现"
 * ```
 */
export interface CriticalErrors {
  readonly falseCreate: readonly { caseId: string; gold: string; predicted: string }[]
  readonly falseFulfill: readonly { caseId: string; gold: string; predicted: string }[]
}

export function criticalErrorsOf(
  cases: readonly LabelledCase[],
  predicted: readonly GoalMetricLabel[],
): CriticalErrors {
  const falseCreate: { caseId: string; gold: string; predicted: string }[] = []
  const falseFulfill: { caseId: string; gold: string; predicted: string }[] = []
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index]!
    const guess = predicted[index]!
    if (
      (item.gold === 'none' || item.gold === 'clarify') &&
      GOAL_WRITE_OPERATIONS.includes(guess)
    ) {
      falseCreate.push({ caseId: item.caseId, gold: item.gold, predicted: guess })
    }
    if (item.gold !== 'report_complete' && guess === 'report_complete') {
      falseFulfill.push({ caseId: item.caseId, gold: item.gold, predicted: guess })
    }
  }
  return { falseCreate, falseFulfill }
}

/** 一份完整读数（干跑与真跑共用同一个返回形状 —— 这是"同一套算术"的可执行形式） */
export interface SemanticReading {
  readonly total: number
  readonly accuracy: number
  readonly macroF1: MacroF1
  readonly perClass: readonly PerClassMetric[]
  readonly perLayer: readonly { layer: string; total: number; hits: number; accuracy: number }[]
  readonly critical: CriticalErrors
  /** 被 `none` 这个类解释掉的比例 —— "猜多数类"的基线，必须与准确率一起看 */
  readonly majorityBaseline: number
}

export function readSemantic(
  cases: readonly LabelledCase[],
  predicted: readonly GoalMetricLabel[],
): SemanticReading {
  const matrix = confusionOf(cases, predicted)
  const perClass = perClassOf(matrix)
  const majoritySupport = Math.max(0, ...perClass.map((metric) => metric.support))
  return {
    total: matrix.total,
    accuracy: accuracyOf(matrix),
    macroF1: macroF1Of(matrix),
    perClass,
    perLayer: perLayerOf(cases, predicted),
    critical: criticalErrorsOf(cases, predicted),
    majorityBaseline: matrix.total === 0 ? Number.NaN : majoritySupport / matrix.total,
  }
}
