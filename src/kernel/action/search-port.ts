/**
 * SearchProviderPort —— **搜索 provider 的端口形状**（M5.5 WP3 / ADR-045 D-3）。
 *
 * ============================================================================
 *  它只描述"一次有界搜索"的输入与结果，不认识任何具体供应商
 * ============================================================================
 * provider 换过三次（Brave → Tavily → 本地 SearXNG，见 ADR-045/046/047），
 * 而端口**一次都没改过**：这正是它存在的理由。
 *
 *   · 内核与上层只认这个形状，换 provider = 换一个实现文件（退出成本是裁定判据之一）
 *   · 测试注入 fixture 实现，**离线**即可跑完整条链（不需要网络、不需要 key）
 *   · provider 名字只作为**数据**（`id`）出现，于是 trace / 账本 / 开发者面
 *     报的是"谁给的"，而不是"代码依赖了谁"
 *
 * ---------------------------------------------------------------------------
 *  三条硬性质（每一条都有对应的量具）
 * ---------------------------------------------------------------------------
 * 1. **输入只有三样**：`query` / `limit` / `locale`。端口类型里没有记忆、
 *    prompt、人设、历史对话、userId、traceId 的位置 —— 那些东西**在类型上**
 *    就送不出去（ADR-045 D-19 §4 的禁止清单，D-31 沿用）。
 * 2. **一次搜索恰好一次 provider 请求**：`requestCount` 必须由实现**如实上报**
 *    （`1`；自动重试 `0`）。它出现在结果里而不是只写在文档里，是为了让
 *    "有没有偷偷重试"成为**可断言的事实**。ADR-141 的有界网页读取另计 metrics，
 *    不把一次模型请求等同于一次实际搜索或全部 HTTP 流量。
 * 3. **失败也如实上报**：超时 / 解析失败 / provider 报错一律归一到既有
 *    `ActionFailure` 码（`timeout` / `validation_failed` / `execution_failed`），
 *    绝不返回一个"看起来成功但没有结果"的形状。
 */

import type { SearchEvidenceItem } from '../contracts/external-evidence.ts'
import { EVIDENCE_LIMITS } from '../contracts/external-evidence.ts'
import type { ActionFailure } from './errors.ts'

/**
 * 一次搜索的请求（**只有这三样**）。
 *
 * `signal` 不在这里：它属于"调用方式"，由 `search()` 的入参单独给
 * （见 `SearchProviderCall`），这样"请求内容"与"取消方式"不会混成一个东西。
 */
export interface SearchQuery {
  /** 查询词 —— 来自用户原话里**显式搜索部分**，不接受 URL */
  query: string
  /** 结果条数 1..5（客户端上限；是否发给 provider 由各适配器决定） */
  limit: number
  /**
   * 语言/地区标签，形如 `zh-CN`。
   *
   * ⚠️ 各 provider 对它的处理**不同**，而且都不保证被满足：
   *    Brave 映射成 `country` + `search_lang`；Tavily 只有 `language`（且要国家**名**做 country，
   *    需要手工表，故 v1 不发）；本地 SearXNG 直接作 `language` 传出，
   *    但**不在该实例 `locales` 列表里的代码会回落到实例默认**（见 ADR-047 的已知弱化）。
   */
  locale: string
}

export interface SearchProviderCall extends SearchQuery {
  /** 调用方的取消信号（provider 必须把它与自己的硬超时**合并**，不是二选一） */
  signal?: AbortSignal
}

/** provider 成功时的结果（`items` 是**未验证**的原始条目，见 `SearchEvidenceItem`） */
/** ADR-141: model dispatch count and bounded page reads are distinct observations. */
export interface SearchProviderMetrics {
  nativeToolCalls: number | null
  reportedSearchCalls: number | null
  sourceReads: number
  sourceRequestAttempts: number
  failedSourceReads: number
}

export interface SearchProviderSuccess {
  ok: true
  items: SearchEvidenceItem[]
  /** 这一次**实际**发出的请求数（恒为 1；重试为 0） */
  requestCount: number
  /** provider 界面上被丢掉的条目数（例如非 HTTPS）—— 如实报出，不静默丢 */
  rejectedItems: number
  metrics?: SearchProviderMetrics
}

/** provider 失败时的结果（**同样带请求数**：超时也是发生过一次请求的） */
export interface SearchProviderFailure {
  ok: false
  failure: ActionFailure
  requestCount: number
  rejectedItems: number
  metrics?: SearchProviderMetrics
}

export type SearchProviderOutcome = SearchProviderSuccess | SearchProviderFailure

export interface SearchProviderPort {
  /** provider 标识（进 trace / 账本 / 开发者面；形如 `searxng-local` / `fixture`） */
  readonly id: string
  /** 只用于诊断的 endpoint host（**绝不含凭证、绝不含 query**） */
  readonly endpointHost: string
  /** 一次有界搜索。**必须**只用 `SearchProviderCall` 里的字段 */
  search(input: SearchProviderCall): Promise<SearchProviderOutcome>
}

// ---------------------------------------------------------------------------
// 请求校验（失败关闭；provider 与量具共用这一份**规格**，但不共用检测逻辑）
// ---------------------------------------------------------------------------

/** locale 的形状：`zh` / `zh-CN`（只接受字母，长度有界） */
export const SEARCH_LOCALE_PATTERN = /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/

/**
 * 校验一次搜索请求。
 *
 * 返回**全部**问题（与契约层同一风格）。它由 provider 在发请求**之前**调用：
 * 一个空查询或超界的结果数不该变成一次真实的出站请求（那是要花钱的）。
 */
export function validateSearchQuery(input: SearchQuery): string[] {
  const problems: string[] = []
  if (typeof input.query !== 'string' || input.query.trim() === '') {
    problems.push('query 不能为空（"帮我不带搜索词地搜一下"不是一次搜索）')
  } else if (input.query.length > EVIDENCE_LIMITS.maxQueryLength) {
    problems.push(`query 超过 ${EVIDENCE_LIMITS.maxQueryLength} 字符上限`)
  }
  if (
    !Number.isInteger(input.limit) ||
    input.limit < EVIDENCE_LIMITS.minResultLimit ||
    input.limit > EVIDENCE_LIMITS.maxResultLimit
  ) {
    problems.push(
      `limit 必须是 ${EVIDENCE_LIMITS.minResultLimit}..${EVIDENCE_LIMITS.maxResultLimit} 的整数，` +
        `收到 ${String(input.limit)}`
    )
  }
  if (typeof input.locale !== 'string' || !SEARCH_LOCALE_PATTERN.test(input.locale)) {
    problems.push(`locale 必须形如 zh 或 zh-CN，收到 ${JSON.stringify(input.locale)}`)
  }
  return problems
}

/** 便于诊断的一行摘要（**不含 query、不含 key**） */
export function describeSearchProvider(provider: {
  id: string
  endpointHost: string
}): string {
  return `search provider = ${provider.id} @ ${provider.endpointHost}`
}
