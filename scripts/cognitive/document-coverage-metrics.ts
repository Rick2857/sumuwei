/**
 * 开发用覆盖度**候选指标**与**负控**（2026-10-23 · P2.1 第四批）
 *
 * ⚠️ 这是**开发期量具**，不进入生产：它用来回答"哪个指标有区分力"，
 *    而不是"覆盖率是多少"。没有区分力的指标**舍弃**，不靠调阈值掩盖。
 *
 * ⚠️ 三类负控（P2.1 提案 §2 D6）：
 *    · **删除关键内容** —— 真实缺失，指标**必须**察觉；
 *    · **重复填充** —— 只是变长，指标**不得**因此变好；
 *    · **纯格式重排** —— 内容没变，指标**不得**变。
 *
 * ⚠️ 判定用**相对次序**，不设阈值：
 *    · D（察觉删除）：删掉被引用单元后指标**下降**；
 *    · P（填充不奖励）：重复填充后指标**不上升**；
 *    · F（格式噪声小于内容信号）：纯格式重排造成的偏移**小于**删除造成的偏移。
 *    另外还有一条**结构性**判据：参照必须**独立于被测管线**
 *    （不许拿"另一条路线的输出"当参照）。
 */
import { documentCoverageView, evaluateDocumentCoverage, type DocumentCoverageUnit } from '../../src/kernel/contracts/document-coverage.ts'

export interface MetricContext {
  readonly units: readonly DocumentCoverageUnit[]
  /** 另一条路线的 5-gram 集合（**只**给跨路线指标用；它不是独立标准）。 */
  readonly siblingGrams?: Set<string>
}

export interface MetricSpec {
  readonly name: string
  /** 参照是否独立于被测管线（跨路线指标**不是**）。 */
  readonly independentStandard: boolean
  readonly measure: (text: string, context: MetricContext) => number
}

/** 字符 5-gram 集合（与自然语料轮同一算法，便于对照旧读数）。 */
export function gramSet(text: string, k = 5): Set<string> {
  const flat = text.normalize('NFKC').replace(/\s+/g, '')
  const grams = new Set<string>()
  for (let index = 0; index + k <= flat.length; index += 1) grams.add(flat.slice(index, index + k))
  return grams
}

export function containmentOf(from: Set<string>, into: Set<string>): number {
  if (from.size === 0) return 0
  let shared = 0
  for (const gram of from) if (into.has(gram)) shared += 1
  return shared / from.size
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 删除指定词片段（**内容删除**负控）。
 *
 * ⚠️ 匹配对**任意空白宽容**（PDF 里常见换行、多空格，汉字与数字之间也常被插空格）。
 * ⚠️ 找不到就**如实报告没删掉**，不假装删了。
 */
export function deleteNeedles(text: string, needles: readonly string[]): { text: string; removed: string[]; missing: string[] } {
  let out = text
  const removed: string[] = []
  const missing: string[] = []
  for (const needle of needles) {
    // ⚠️ 词片段里的空白**不**当字面量：真实 PDF 文本层常常整段没有空格
    //    （"basedoncomplexrecurrentor\nconvolutional"）⇒ 字符之间允许任意空白。
    const parts = [...needle].filter(char => !/\s/.test(char)).map(escapeRegExp)
    if (parts.length === 0) { missing.push(needle); continue }
    const pattern = new RegExp(parts.join('[\\s\\u00a0]*'), 'giu')
    if (!pattern.test(out)) { missing.push(needle); continue }
    out = out.replace(pattern, '')
    removed.push(needle)
  }
  return { text: out, removed, missing }
}

/**
 * 纯格式重排（**格式重排**负控）：加 Markdown 强调、改行宽、折叠多余空格。
 *
 * ⚠️ **行末连字符的行原样保留**：匹配视图里有"行末断词接合"
 *    （`-\n` + 小写字母 ⇒ 去掉连字符与换行）。只要在行首加任何字符，
 *    接合就不再发生 ⇒ 那不是"内容变了"，是**控制本身坏了**。
 *    ⇒ 格式重排后匹配视图必须**逐字相同**（门里有自检）。
 */
export function reflow(text: string): string {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    // ⚠️ 行末连字符的行**原样保留**（见上面说明）。
    if (line.trimEnd().endsWith('-')) { out.push(line); continue }
    const indent = /^[ \t]*/.exec(line)?.[0] ?? ''
    const words = line.split(/\s+/).filter(word => word.length > 0)
    let current = indent
    let first = true
    for (const word of words) {
      // ⚠️ **每行的第一个词不加标记**：换行后的第一个字符必须保持不变，
      //    否则"行末断词接合"会因标记字符而失效 ⇒ 那不是内容变化，是控制坏了。
      const piece = first ? word : word.replace(/([A-Za-z][A-Za-z'-]{7,})/g, '**$1**')
      if (!first && current.length + piece.length + 1 > 72 && !current.endsWith('-')) { out.push(current); current = piece }
      else current = first ? current + piece : `${current} ${piece}`
      first = false
    }
    out.push(current)
  }
  return out.join('\n')
}

/** 重复填充负控：把正文重复若干遍（**只**变长，不新增任何被引用内容）。 */
export function padText(text: string, times: number): string {
  return Array.from({ length: Math.max(1, times) }, () => text).join('\n')
}

/** 参照单元的存在性（唯一被承认为**独立标准**的候选指标）。 */
export function unitCoverageValue(text: string, units: readonly DocumentCoverageUnit[]): number {
  if (units.length === 0) return 0
  return evaluateDocumentCoverage(text, units).observed / units.length
}

export const COVERAGE_METRICS: readonly MetricSpec[] = [
  { name: 'unit_coverage', independentStandard: true, measure: (text, context) => unitCoverageValue(text, context.units) },
  // 结构读数（"同线有序"）：它是**独立**参照，但**对排版敏感** ⇒ 由 F 规则裁决，不进覆盖政策。
  { name: 'row_association_ratio', independentStandard: true, measure: (text, context) => {
    const rows = context.units.filter(unit => unit.kind === 'row')
    if (rows.length === 0) return 0
    return evaluateDocumentCoverage(text, context.units).associated / rows.length
  } },
  { name: 'raw_chars', independentStandard: false, measure: text => text.length },
  { name: 'view_chars', independentStandard: false, measure: text => documentCoverageView(text).length },
  { name: 'cross_route_gram_containment', independentStandard: false,
    measure: (text, context) => containmentOf(gramSet(text), context.siblingGrams ?? new Set<string>()) },
]

export interface MetricResponse {
  readonly metric: string
  readonly baseline: number
  readonly deleted: number | null
  readonly padded: number
  readonly reflowed: number
  /** D：删除后下降多少（正数 = 察觉到了）；null = 这一路判不了。 */
  readonly deletionResponse: number | null
  /** P：填充后上升多少（正数 = 填充被奖励）。 */
  readonly paddingResponse: number
  /** F：格式重排造成的偏移（绝对值）。 */
  readonly reflowResponse: number
  readonly detectsDeletion: boolean
  readonly paddingRewarded: boolean
  readonly formatNoiseDominates: boolean
  readonly admitted: boolean
  readonly reason: string
}

/**
 * 逐指标算三类负控的响应，并给出**是否准入**的判定。
 *
 * ⚠️ `deleteText` 为 undefined 表示"这一路没有可删的被观测单元" ⇒ D 判不了。
 */
export function measureResponses(input: {
  readonly metrics: readonly MetricSpec[]
  readonly baseline: string
  readonly deleted?: string
  readonly padded: string
  readonly reflowed: string
  readonly context: MetricContext
}): MetricResponse[] {
  return input.metrics.map(metric => {
    const baseline = metric.measure(input.baseline, input.context)
    const padded = metric.measure(input.padded, input.context)
    const reflowed = metric.measure(input.reflowed, input.context)
    const deleted = input.deleted === undefined ? null : metric.measure(input.deleted, input.context)
    const deletionResponse = deleted === null ? null : baseline - deleted
    const paddingResponse = padded - baseline
    const reflowResponse = reflowed - baseline
    const detectsDeletion = deletionResponse !== null && deletionResponse > 0
    const paddingRewarded = paddingResponse > 0
    const formatNoiseDominates = deletionResponse !== null && Math.abs(reflowResponse) >= deletionResponse
    const admitted = metric.independentStandard && detectsDeletion && !paddingRewarded && !formatNoiseDominates
    const reason = !metric.independentStandard ? '参照不独立于被测管线（拿另一条路线的输出当标准 ⇒ 互相定义）'
      : deletionResponse === null ? '没有可删的被观测单元 ⇒ 无法判定 D'
      : admitted ? 'D/P/F 全部成立：能察觉真实缺失、不奖励重复填充、不被纯格式重排改变'
      : [paddingRewarded ? 'P 不成立（重复填充让指标变好）' : '',
        formatNoiseDominates ? 'F 不成立（格式噪声不小于内容信号）' : '',
        !detectsDeletion ? 'D 不成立（删除关键内容后指标没有下降）' : ''].filter(Boolean).join('；')
    return { metric: metric.name, baseline, deleted, padded, reflowed, deletionResponse,
      paddingResponse, reflowResponse, detectsDeletion, paddingRewarded, formatNoiseDominates, admitted, reason }
  })
}
