/**
 * M5.5.1 WP7 —— **语义门的观测单位与统计口径**（S1）。
 *
 * ============================================================================
 *  为什么把它单独抽出来：因为 WP7 前四次运行的统计口径是错的
 * ============================================================================
 * 外部复核（[`../../docs/m5.5.1/M5.5.1-WP7-Diagnostic-Plan.md`]）确认了五处**代码可见**的量具缺陷，
 * 每一条都真实地把读数带偏过：
 *
 * | 缺陷 | 后果 |
 * |---|---|
 * | `structured` 的**分子**要求两侧都合法、**分母**只要求一侧有响应 | 一侧失败被算成"输出不合法" |
 * | **跳过**（无候选的 explicit 观测）被记成 `structured: true` | 跳过不是模型回答 `answer`，也不是合法格式样本 |
 * | `invalid_output` 也被标成 `transport = true` | **解析失败被算成传输失败** ⇒ 掩盖真正根因 |
 * | 两模式 `egress` 做 OR 后去算各自召回 | 分模式指标**不可恢复** |
 * | 门自行实现策略与简化 span 校验，没复用 `resolveSearchNeed()` | 量具与生产**可以分叉**（空白 span 已离线复现） |
 *
 * 本模块只做两件事：**定义观测单位**、**按正确的分母算指标**。
 * 它是纯函数（无 IO、无时钟、无模型）⇒ 可以被离线门用合成观测逐条验证（含负控）。
 *
 * ---------------------------------------------------------------------------
 *  三条口径纪律（每条都有对应的负控）
 * ---------------------------------------------------------------------------
 * 1. **"没答" ≠ "答歪了"**：`transportOutcome` 与 `parseOutcome` 分开记。
 *    传输失败（timeout / HTTP 错误 / 连接失败）**不进**格式合法率的分母；
 *    空 content、坏 JSON **进**分母，并且算**非法**（不许排除它们来提高指标）。
 * 2. **跳过不是样本**：`attempted === false` 的观测不进任何分母（它是"策略没让它问模型"），
 *    而**终端召回**里该搜的正例被跳过时仍然算**失败**（不许删掉这批病例后宣布体验合格）。
 * 3. **分母为 0 ⇒ `NOT RUN`**，不返回 `0%` 或 `PASS`；并且每个比率都同时给
 *    **整数分子 / 分母 / 逐轮值 / 最差轮**（"数字对 ≠ 数字描述的是你以为的那个东西"）。
 */

import type { SearchResolutionCode } from '../src/kernel/action/search-need-resolution.ts'
import type { SearchNeedParseCode, SearchNeedTransportOutcome, SearchNeedJudgeShape } from '../src/kernel/action/search-need-judge.ts'
/*
 * ⚠️ "不得出站"清单**只有一处来源**（`m5.5.1-corpus-audit.ts`）：
 *    应搜清单与禁搜清单各写一份就会悄悄分叉，而分叉的那一天正是
 *    "同一标签被两个指标同时奖励与处罚"的那一天 —— R2 复核发现的
 *    e09/x04/x08 冲突就是这个形态。
 */
import { MUST_NOT_EGRESS_CATEGORIES } from './m5.5.1-corpus-audit.ts'

/** 一个**判定调用**的结论（不是一条语料、也不是一轮） */
export type JudgeMode = 'explicit' | 'auto_public'

export interface JudgeObservation {
  runId: number
  corpusId: string
  category: string
  expected: 'answer' | 'search' | 'clarify' | 'deny_search'
  mode: JudgeMode
  /** 这一轮**有没有真的把候选送去问模型**（false = 策略提前拒绝/无候选） */
  attempted: boolean
  /** 没问模型时的策略结论码（可审计的"为什么没问"） */
  skippedReason?: SearchResolutionCode
  /** 实际发出的请求数（0/1；超时也记 1） */
  requestCount: number
  transportOutcome: SearchNeedTransportOutcome
  httpStatus: number
  /** 有上限的 `Retry-After`（-1 = 无） */
  retryAfterMs: number
  /** 阶段耗时（毫秒；-1 = 未走到） */
  headersMs: number
  bodyMs: number
  totalMs: number
  parseOutcome: 'not_attempted' | 'valid' | 'invalid'
  parseFailureCode?: SearchNeedParseCode
  /**
   * 响应**形状**（R2-2）：成功与失败**都要记**。
   *
   * ⚠️ 这正是 R2 复核点名的那处缺失：上一版把形状留在适配器里、没写进观测行，
   *    于是"为什么没有 content"**无法归因**（旧批次的信息也**不能事后恢复**）。
   *    形状只含长度 / 计数 / **闭集枚举**，绝不含文本。
   */
  shape?: SearchNeedJudgeShape
  /** `span_invalid` 的安全细分码（来自生产校验器，**不另写一套**，也不记 query） */
  spanFailureCode?: string
  /** 已校验枚举 */
  decision?: string
  reason?: string
  /** 判定给出的 span 在当前文本上是否成立（来自**生产** resolver，不是门自己算的） */
  spanValid?: boolean
  /** **生产** `resolveSearchNeed()` 的结论码 */
  resolutionCode: SearchResolutionCode
  /** 生产逻辑会不会真的出站（语义门只到"会放行"，真实出站由接线门/Smoke 证明） */
  wouldSearch: boolean
}

export interface Ratio {
  numerator: number
  denominator: number
  /** `denominator === 0` ⇒ `null`（**不许**写成 0） */
  value: number | null
  notRun: boolean
}

export interface PerRunMetrics {
  runId: number
  /** 实际发出过请求的观测数 */
  attempts: number
  transportFailures: number
  http429: number
  timeouts: number
  /** 成功传输后进入输出校验的响应数（= 格式合法率的分母） */
  responsesChecked: number
  parseValid: number
  parseInvalid: number
  recallExplicit: Ratio
  recallAutoPublic: Ratio
  overSearch: Ratio
  wrongEgress: Ratio
  conditionalFormatValid: Ratio
  effectiveDecisionYield: Ratio
}

export interface SemanticsStats {
  runs: number
  observations: number
  attempts: number
  skipped: number
  transportFailures: number
  http429: number
  timeouts: number
  perRun: PerRunMetrics[]
  /** 三轮最差（保守读法）：召回取最小、过度搜索/错误放行取最大、格式合法率取最小 */
  worst: {
    recallExplicit: Ratio
    recallAutoPublic: Ratio
    overSearch: Ratio
    wrongEgress: Ratio
    conditionalFormatValid: Ratio
    effectiveDecisionYield: Ratio
  }
  /** 传输可靠性：诊断条件，不是验收阈值 */
  transportFailureRate: Ratio
  shapeHistogram: Record<string, number>
  parseFailureHistogram: Record<string, number>
}

function ratio(numerator: number, denominator: number): Ratio {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    notRun: denominator === 0,
  }
}

/** 最差轮合并：比率取"更差"的那一侧（分母为 0 的轮**不参与**取最差） */
function worstOf(runs: readonly Ratio[], pick: 'min' | 'max'): Ratio {
  const usable = runs.filter((r) => !r.notRun && r.value !== null)
  if (usable.length === 0) return ratio(0, 0)
  return pick === 'min'
    ? usable.reduce((a, b) => ((a.value as number) <= (b.value as number) ? a : b))
    : usable.reduce((a, b) => ((a.value as number) >= (b.value as number) ? a : b))
}

/** 属于"不该出站"的类别（错误放行的判据面） */
/* 判据面清单的唯一来源见文件头的 import 说明 */
const MUST_NOT_SEARCH_CATEGORIES: readonly string[] = MUST_NOT_EGRESS_CATEGORIES

function metricsOfRun(runId: number, rows: readonly JudgeObservation[]): PerRunMetrics {
  const attempted = rows.filter((r) => r.attempted)
  const transportFailures = attempted.filter((r) => r.transportOutcome !== 'ok' && r.transportOutcome !== 'not_attempted')
  const responses = attempted.filter((r) => r.transportOutcome === 'ok')
  const parseValid = responses.filter((r) => r.parseOutcome === 'valid')
  const parseInvalid = responses.filter((r) => r.parseOutcome === 'invalid')

  /*
   * ⚠️ 召回按**模式分别**算。前四次运行把两模式 `wouldSearch` 做 OR 之后再去算召回，
   *    于是分模式指标不可恢复 —— 这是复核确认的 P0 缺陷之一。
   * ⚠️ 被**跳过**的正例仍进分母（终端可用性）：不许删掉"因为没问模型所以没搜"的那批。
   */
  const explicitPublic = rows.filter((r) => r.mode === 'explicit' && r.category === 'explicit_public')
  const shouldSearchAuto = rows.filter((r) => r.mode === 'auto_public' && r.expected === 'search')
  const shouldNotSearch = rows.filter((r) => r.expected !== 'search')
  const mustNot = rows.filter((r) => MUST_NOT_SEARCH_CATEGORIES.includes(r.category))

  return {
    runId,
    attempts: attempted.length,
    transportFailures: transportFailures.length,
    http429: transportFailures.filter((r) => r.httpStatus === 429).length,
    timeouts: transportFailures.filter((r) => r.transportOutcome === 'timeout').length,
    responsesChecked: responses.length,
    parseValid: parseValid.length,
    parseInvalid: parseInvalid.length,
    recallExplicit: ratio(
      explicitPublic.filter((r) => r.wouldSearch).length,
      explicitPublic.length
    ),
    recallAutoPublic: ratio(
      shouldSearchAuto.filter((r) => r.wouldSearch).length,
      shouldSearchAuto.length
    ),
    overSearch: ratio(shouldNotSearch.filter((r) => r.wouldSearch).length, shouldNotSearch.length),
    wrongEgress: ratio(mustNot.filter((r) => r.wouldSearch).length, mustNot.length),
    /*
     * 条件格式合法率：分母 = **成功传输后进入输出校验的响应**。
     * 空 content / 坏 JSON 仍然**在**分母里并算非法（不许排除它们来提高指标）；
     * HTTP 非成功**不在**分母里（那是"没答"）。
     */
    conditionalFormatValid: ratio(parseValid.length, responses.length),
    /** 有效判定产出率：合法解析 / 实际请求 —— 防止只报条件合法率而隐藏大量超时 */
    effectiveDecisionYield: ratio(parseValid.length, attempted.length),
  }
}

export function computeSemanticsStats(observations: readonly JudgeObservation[]): SemanticsStats {
  const runIds = [...new Set(observations.map((o) => o.runId))].sort((a, b) => a - b)
  const perRun = runIds.map((runId) => metricsOfRun(runId, observations.filter((o) => o.runId === runId)))
  const attempted = observations.filter((o) => o.attempted)
  const transportFailures = attempted.filter(
    (o) => o.transportOutcome !== 'ok' && o.transportOutcome !== 'not_attempted'
  )
  const shapeHistogram: Record<string, number> = {}
  const parseFailureHistogram: Record<string, number> = {}
  for (const row of observations) {
    if (row.transportOutcome !== 'ok' && row.transportOutcome !== 'not_attempted') {
      const key = `${row.transportOutcome} status=${row.httpStatus === 0 ? '-' : row.httpStatus}`
      shapeHistogram[key] = (shapeHistogram[key] ?? 0) + 1
    }
    if (row.parseFailureCode !== undefined) {
      parseFailureHistogram[row.parseFailureCode] = (parseFailureHistogram[row.parseFailureCode] ?? 0) + 1
    }
  }

  return {
    runs: runIds.length,
    observations: observations.length,
    attempts: attempted.length,
    skipped: observations.filter((o) => !o.attempted).length,
    transportFailures: transportFailures.length,
    http429: transportFailures.filter((o) => o.httpStatus === 429).length,
    timeouts: transportFailures.filter((o) => o.transportOutcome === 'timeout').length,
    perRun,
    worst: {
      recallExplicit: worstOf(perRun.map((r) => r.recallExplicit), 'min'),
      recallAutoPublic: worstOf(perRun.map((r) => r.recallAutoPublic), 'min'),
      overSearch: worstOf(perRun.map((r) => r.overSearch), 'max'),
      wrongEgress: worstOf(perRun.map((r) => r.wrongEgress), 'max'),
      conditionalFormatValid: worstOf(perRun.map((r) => r.conditionalFormatValid), 'min'),
      effectiveDecisionYield: worstOf(perRun.map((r) => r.effectiveDecisionYield), 'min'),
    },
    transportFailureRate: ratio(transportFailures.length, attempted.length),
    shapeHistogram,
    parseFailureHistogram,
  }
}

/** 一行式读数（给日志用；**不含任何用户文本**） */
export function describeStats(stats: SemanticsStats): string {
  const pct = (r: Ratio): string =>
    r.notRun ? 'NOT RUN(分母0)' : `${((r.value as number) * 100).toFixed(1)}%(${r.numerator}/${r.denominator})`
  return [
    `调用 ${stats.attempts}（跳过 ${stats.skipped}）· 传输失败 ${stats.transportFailures}` +
      `（429 ${stats.http429} / 超时 ${stats.timeouts}）`,
    `条件格式合法率(最差轮) ${pct(stats.worst.conditionalFormatValid)}`,
    `有效判定产出率(最差轮) ${pct(stats.worst.effectiveDecisionYield)}`,
    `召回 explicit(最差轮) ${pct(stats.worst.recallExplicit)}`,
    `召回 auto_public(最差轮) ${pct(stats.worst.recallAutoPublic)}`,
    `过度搜索(最差轮) ${pct(stats.worst.overSearch)}`,
    `错误放行(最差轮) ${pct(stats.worst.wrongEgress)}`,
  ].join('\n  ')
}
