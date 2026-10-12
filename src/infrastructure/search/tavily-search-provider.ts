/**
 * Tavily provider —— **单一 JSON Search API 的薄适配器**（M5.5 / ADR-046 `D-20`…`D-30`，ADR-054 落地）。
 *
 * ============================================================================
 *  它只做四件事
 * ============================================================================
 * ```text
 * SearchQuery(query/limit/locale)  →  一个 POST /search（恰好一次）
 *                                 →  响应形状校验（不认识 ⇒ 失败，不是"成功但空"）
 *                                 →  原始条目（**未验证**）+ 丢弃计数
 *                                 →  SearchProviderOutcome
 * ```
 *
 * 它**不**做：证据构造与验证（kernel 契约层）、去重与标签、预算与上下文注入、
 * 措辞与来源附录。它**不接收**：记忆、prompt、人设、历史对话、userId、traceId
 * —— 端口类型里根本没有它们的位置（`SearchProviderCall` 只有 query/limit/locale/signal）。
 *
 * ---------------------------------------------------------------------------
 *  `D-20`…`D-30` 的约束落在哪些地方
 * ---------------------------------------------------------------------------
 * · **凭证只在请求头**：`Authorization: Bearer <key>`（`D-26`）。body 里**永不**出现
 *   `api_key`/`token`/`secret` —— 那是 `V-3` 明确否决过的形状（key 一进 body，
 *   记录器就会把它记下来，"结构性不可泄漏"当场失效）。
 * · **固定 endpoint**：`https://api.tavily.com/search` 是代码常量，装配时逐段核对。
 *   HTTPS 是硬要求 —— ADR-047 的 loopback http 例外随 `D-31a` 一起退役。
 * · **请求 body 是冻结的六个字段**：`query` / `max_results` / `language` /
 *   `search_depth=basic` / `auto_parameters=false` / `include_usage=true`（`D-21`…`D-23`）。
 * · **恰好一次请求、零重试**（`D-28`）：`fetchImpl` 只被调用一次，没有循环、没有降级重问。
 * · **硬超时 15000ms**（2026-09-22 重新裁定）：`AbortController` + `setTimeout`，并与
 *   调用方信号**合并**；超时与"调用方取消"是**两个**结论（`timeout` vs `cancelled`）。
 * · **只消费 `results[].title/url/content`**：`score` / `raw_content` / `answer` /
 *   `images` / `follow_up_questions` 一律忽略（它们不是证据层认识的东西）。
 * · **摘要在 provider 边界截断到契约上限**（`EVIDENCE_LIMITS.maxSnippetLength`，600）：
 *   ⚠️ 这一条是**真实事故换来**的（ADR-054）：Tavily 的 `content` 常在 800–1500 字符，
 *      而证据层只收 ≤600 的摘要 —— 不截断的话**每一条**都会被 `snippet_too_long` 丢掉，
 *      适配器于是报 `partial`（"返回了条目但一条都没能形成证据"），
 *      用户看到的是"搜不了"。截断在**这一层**做是对的：provider 的摘要长度是
 *      provider 的方言，而"摘要多长才算合格"是**我们的契约**（与 `max_results`
 *      在本地截断同一个道理）。
 *      ⚠️ 它**不**放宽任何契约：证据层仍然独立校验，截断后仍要过全部检查。
 * · **非 HTTPS 来源、缺字段、非法 URL 一律丢弃并计数**（它们仍然过不了证据层，
 *   "丢掉"不是放行）。
 *
 * ⚠️ 失败信息里**不放 provider 的原始响应正文**：HTTP 失败**只按状态码映射**，连 body 都不读。
 * ⚠️ **"Tavily 是托管 API"**：`query` 直接出站到 Tavily 的服务器（不是本机代理）。
 *    这一条写在 ADR-054 与已知局限里，不许被"反正也是 HTTPS"这句话盖过去。
 */

import type { SearchEvidenceItem } from '../../kernel/contracts/external-evidence.ts'
import { EVIDENCE_LIMITS } from '../../kernel/contracts/external-evidence.ts'
import { actionFailure, type ActionFailure } from '../../kernel/action/errors.ts'
import {
  validateSearchQuery,
  type SearchProviderOutcome,
  type SearchProviderPort,
  type SearchQuery,
} from '../../kernel/action/search-port.ts'
import {
  D20_RULING,
  TAVILY_PROVIDER_ID,
  type TavilyConfig,
} from './tavily-config.ts'

/* provider 标识从配置层**re-export**：装配层与量具都只认这一个名字（不再各写一份常量） */
export { TAVILY_PROVIDER_ID }

// ---------------------------------------------------------------------------
// 请求构造（**唯一**，纯函数 —— 量具直接检查它的输出）
// ---------------------------------------------------------------------------

export interface TavilySearchRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  /** JSON body（**逐字**由这里生成；量具断言字段名集合恰好是那六个） */
  body: string
}

/**
 * 构造出站请求。**这是唯一允许拼 URL 与 body 的地方**。
 *
 * ⚠️ `limit` → `max_results`、`locale` → `language`（小写化：`zh-CN` → `zh-cn`）—— `D-21`。
 *    刻意**不映射** `country`：Tavily 要的是国家**名**，从 `zh-CN` 推国家名需要一张
 *    手工维护的对照表，而本项目在 M5 已有明确结论：**禁止手工词表**（`D-22`）。
 */
export function buildTavilySearchRequest(
  config: TavilyConfig,
  query: SearchQuery
): TavilySearchRequest {
  const body: Record<string, unknown> = {
    query: query.query,
    search_depth: config.searchDepth,
    max_results: Math.min(query.limit, config.maxResults),
    include_usage: config.includeUsage,
    auto_parameters: config.autoParameters,
    language: query.locale.toLowerCase(),
  }
  return {
    url: config.endpoint,
    method: 'POST',
    headers: {
      /* 凭证**只**在这里出现（`D-26`）。它不进日志、不进证据（有静态锁与量具）。 */
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  }
}

// ---------------------------------------------------------------------------
// 响应 → 原始条目
// ---------------------------------------------------------------------------

interface TavilyParseResult {
  items: SearchEvidenceItem[]
  rejectedItems: number
  /** `usage.credits`（**实际**用量；缺字段记 `null`，不伪装成 0）—— `D-23`/`D-30` 只报告 */
  creditsUsed: number | null
}

/**
 * `provider` 报错 → 既有受控失败码（ADR-046 `D-28` 的映射表）。
 *
 * ⚠️ Tavily 的**限流**用的是 `432`（不是 429）—— 实测与官方文档都见到过。
 *    它必须映射成 `execution_failed`（"这一次没有结果"），而**不是** `permission_denied`
 *    （那会被读成"凭证不对"，把一次可重试的限流说成配置故障）。
 *
 * ⚠️ `401/403 ⇒ permission_denied` 是 `D-28` **设计好的**映射（语义 = 凭证无效或无权），
 *    本函数**不改它**。要修的是"`permission_denied` 在回复层被读成**未启用联网**"那个缺口
 *    （`TD-10` G-1，2026-10-04）：provider 把 **HTTP 状态**放进 `details.status`，
 *    回复层据此把"凭证被拒"与"开关没开"分开 —— 见 `external-evidence-reply.ts` 的
 *    `failureHttpStatus` 与 `verify-td10-search-reliability.ts` §3b。
 */
export function failureForTavilyHttpStatus(status: number): ActionFailure {
  if (status === 401 || status === 403) {
    return actionFailure('permission_denied', `Tavily 拒绝了这次请求（HTTP ${status}）：凭证无效或无权`, {
      status,
    })
  }
  if (status === 400 || status === 422) {
    return actionFailure('validation_failed', `Tavily 认为请求不合法（HTTP ${status}）`, { status })
  }
  if (status === 429 || status === 432) {
    return actionFailure('execution_failed', `Tavily 限流（HTTP ${status}）：这一次没有结果`, { status })
  }
  return actionFailure('execution_failed', `Tavily 返回 HTTP ${status}`, { status })
}

/**
 * 把 provider 的 JSON 解析成原始条目。
 *
 * 三类结果的**区别是刻意的**：
 *   · 响应形状不认识（没有 `results` 数组）⇒ **失败**。
 *     "Tavily 说 200 但我们读不懂"绝不能变成"成功了、只是没有结果"。
 *   · 单条缺字段 / 非字符串 / URL 非法 / 非 HTTPS ⇒ 丢掉并**计数**。
 *   · 条数超过本地上限 ⇒ 截断（`max_results` 已发出，这里再兜一层）。
 */
export function parseTavilyResponse(payload: unknown, maxResults: number): TavilyParseResult | ActionFailure {
  const results = (payload as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) {
    return actionFailure(
      'validation_failed',
      'Tavily 返回的形状不认识（缺少 results 数组）—— 不算成功'
    )
  }

  const items: SearchEvidenceItem[] = []
  let rejectedItems = 0
  for (const raw of results) {
    if (items.length >= Math.max(0, maxResults)) break
    const title = (raw as { title?: unknown }).title
    const url = (raw as { url?: unknown }).url
    const content = (raw as { content?: unknown }).content
    if (typeof title !== 'string' || typeof url !== 'string' || typeof content !== 'string') {
      rejectedItems += 1
      continue
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      rejectedItems += 1
      continue
    }
    if (parsed.protocol !== 'https:') {
      // 证据层只接受 HTTPS 来源（ADR-045 D-14）：非 HTTPS 在这里就丢掉并计数
      rejectedItems += 1
      continue
    }
    if (title.trim() === '' || content.trim() === '') {
      rejectedItems += 1
      continue
    }
    /*
     * ⚠️ 截断（不是丢弃）：Tavily 的 `content` 常 800–1500 字符，而证据层只收 ≤600。
     *    不截断 ⇒ **每一条**都被丢掉 ⇒ 适配器报 partial ⇒ 用户看到"搜不了"（真实事故）。
     *    与 `max_results` 一样，长度上限是**我们的契约**，在 provider 边界落地。
     */
    items.push({
      title,
      url,
      snippet: content.slice(0, EVIDENCE_LIMITS.maxSnippetLength),
    })
  }

  const credits = (payload as { usage?: { credits?: unknown } } | null)?.usage?.credits
  return {
    items,
    rejectedItems,
    creditsUsed: typeof credits === 'number' && Number.isFinite(credits) ? credits : null,
  }
}

function isFailure(value: TavilyParseResult | ActionFailure): value is ActionFailure {
  return (value as ActionFailure).code !== undefined
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

export interface TavilySearchProviderOptions {
  config: TavilyConfig
  /** 可注入的 fetch（离线测试与 recorded-request 量具用）；缺省用 Node 22 原生 fetch */
  fetchImpl?: typeof fetch
  /**
   * 实际用量的回调（**只报告，不阻断** —— `D-30`）。
   *
   * ⚠️ 回调用它把"这一次真的花了几个 credit"带出去进证据/日志；
   *    它**不得**参与任何放行/拒绝判断（成本没有闸）。
   */
  onCreditsUsed?: (credits: number | null) => void
}

export function createTavilySearchProvider(
  options: TavilySearchProviderOptions
): SearchProviderPort {
  const { config } = options
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const endpointHost = new URL(config.endpoint).host

  return {
    id: TAVILY_PROVIDER_ID,
    endpointHost,

    async search(input): Promise<SearchProviderOutcome> {
      /*
       * ① 先校验，再发请求。
       *    非法查询**不得**产生任何出站请求 —— 因此这条路径的 requestCount 如实为 0。
       */
      const problems = validateSearchQuery(input)
      if (problems.length > 0) {
        return {
          ok: false,
          failure: actionFailure('validation_failed', problems.join(' / ')),
          requestCount: 0,
          rejectedItems: 0,
        }
      }

      const request = buildTavilySearchRequest(config, input)

      // ② 硬超时 + 调用方信号，合并成同一个 controller
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, config.hardTimeoutMs)
      const onCallerAbort = (): void => controller.abort()
      /*
       * ⚠️ **已经 abort 的信号不会再触发 `abort` 事件**（DOM/undici 的语义）。
       * 因此必须先查 `aborted`，否则"调用方一上来就取消"会被硬超时兜住，
       * 最终报成 `timeout` —— 而那是**两个不同的结论**。
       */
      if (input.signal?.aborted === true) {
        controller.abort()
      } else {
        input.signal?.addEventListener('abort', onCallerAbort, { once: true })
      }

      try {
        // ③ **恰好一次**：这里没有循环、没有重试
        const response = await doFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        })

        // ⚠️ 失败分支**不读 body**：provider 的错误正文可能回显我们发过去的内容
        if (!response.ok) {
          return {
            ok: false,
            failure: failureForTavilyHttpStatus(response.status),
            requestCount: 1,
            rejectedItems: 0,
          }
        }

        const payload: unknown = await response.json().catch(() => undefined)
        const parsed = parseTavilyResponse(payload, Math.min(input.limit, config.maxResults))
        if (isFailure(parsed)) {
          return { ok: false, failure: parsed, requestCount: 1, rejectedItems: 0 }
        }
        // 成本**只报告**：把实际用量带出去（没有任何分支依赖它）
        options.onCreditsUsed?.(parsed.creditsUsed)
        return {
          ok: true,
          items: parsed.items,
          requestCount: 1,
          rejectedItems: parsed.rejectedItems,
        }
      } catch (error) {
        const aborted = controller.signal.aborted
        const failure = timedOut
          ? actionFailure(
              'timeout',
              `搜索在 ${config.hardTimeoutMs}ms 内没有返回（超时**不等于**成功）`
            )
          : aborted
            ? actionFailure('cancelled', '这次搜索被取消，没有结果')
            : actionFailure(
                'execution_failed',
                `搜索请求失败：${error instanceof Error ? error.name : 'unknown'}`
              )
        return { ok: false, failure, requestCount: 1, rejectedItems: 0 }
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onCallerAbort)
      }
    },
  }
}

/** 便于诊断：一行说明（**不含 query、不含任何认证信息**） */
export function describeTavilyProvider(provider: SearchProviderPort): string {
  return (
    `tavily provider @ ${provider.endpointHost} · depth=${D20_RULING.searchDepth} · ` +
    `results ≤ ${D20_RULING.maxResults} · timeout=${D20_RULING.hardTimeoutMs}ms`
  )
}

/** 结果条数的硬上限（与契约层一致；这里再导出一次是给量具用的**独立**口径） */
export const TAVILY_MAX_ITEMS = EVIDENCE_LIMITS.maxResultLimit
