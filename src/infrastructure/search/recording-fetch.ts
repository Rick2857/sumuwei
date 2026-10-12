/**
 * RecordingFetch —— **出站请求的记录器**（M5.5 量具 / WP9 Live Smoke 复用）。
 *
 * ============================================================================
 *  它记什么、不记什么，是这条里程碑的核心纪律
 * ============================================================================
 * 记：方法、URL（**含查询串** —— 那是"到底发了什么"的唯一证据）、
 *     请求头的**名字**与**值的长度**、body 长度、调用次数。
 *
 * **不记：请求头的值。** 这不是"记得脱敏"，而是"结构上取不到"——
 * 只要记录器从不保存头的值，任何放进头的凭证（`Authorization` / cookie / API key）
 * 都不可能出现在证据文件、日志或提交里。
 *
 * **不记：body 内容。** 只记 `bodyLength` 与 `bodyFieldNames`（JSON 的**键名**）。
 * ⚠️ Tavily（`ADR-054` / `ADR-046 D-26`）是 **POST + JSON**，于是"零 body"这条断言不再适用，
 *    而"到底发了哪几个字段"必须仍可核对。做法是**只记键名、永不记值**：
 *    键名集合本身是**冻结常量**（`TAVILY_ALLOWED_BODY_FIELDS`），而值里才有 query 正文。
 *    这与 SearXNG 时代的差别只是"从 URL 参数名换成 body 字段名"，泄漏面**没有变大**。
 *    非 JSON / 非字符串 body ⇒ 记 `null`（**不**尝试解析，也不保存片段）。
 *
 * 因此验证"只发了那六个字段"用的是：JSON 键名集合 + URL 与 body 的哨兵扫描；
 * 验证"凭证只在头里"用的是：头的名字集合 + 头值的**长度**（值本身结构上取不到）。
 *
 * ⚠️ 它**不**是日志：`describeRecording()` 只输出名字与长度。
 *    任何"把 requests 原样打进日志/证据"的用法都要先想清楚 URL 里有没有隐私
 *    （Live Smoke 只用合成查询；这条约束写在 `docs/m5.5/M5.5-Execution-Plan.md` §WP9）。
 */

export interface RecordedRequest {
  method: string
  /** 完整 URL（含查询串）：出站内容的唯一证据 */
  url: string
  /** 请求头的**名字**（小写、排序；**永不记值**） */
  headerNames: readonly string[]
  /** 每个请求头的**值长度**（够用来发现"多带了一个头"，又不足以还原任何值） */
  headerValueLengths: Readonly<Record<string, number>>
  /** body 的长度：GET 请求恒为 0 —— "零 body"是可断言的 */
  bodyLength: number
  /**
   * JSON body 的**键名**（排序；值一个都不记）。
   * `null` = 没有 body，或 body 不是 JSON 对象。
   */
  bodyFieldNames: readonly string[] | null
}

export interface RecordingFetch {
  fetchImpl: typeof fetch
  /** 到目前为止的记录（**不含任何请求头的值、不含 body 内容**） */
  requests: readonly RecordedRequest[]
  callCount(): number
  reset(): void
}

export interface RecordingFetchOptions {
  /** 这次调用的应答；缺省 = 200 + 形状合法的空结果 */
  respond?: (request: RecordedRequest, index: number) => Promise<Response> | Response
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  const maybe = input as { url?: unknown }
  return typeof maybe?.url === 'string' ? maybe.url : String(input)
}

function headerEntries(headers: unknown): [string, string][] {
  if (headers === undefined || headers === null) return []
  if (Array.isArray(headers)) {
    return (headers as [string, string][]).map(([name, value]) => [String(name), String(value)])
  }
  const maybeEntries = (headers as { entries?: unknown }).entries
  if (
    typeof maybeEntries === 'function' &&
    typeof (headers as { forEach?: unknown }).forEach === 'function'
  ) {
    const out: [string, string][] = []
    ;(headers as { forEach: (cb: (v: string, k: string) => void) => void }).forEach(
      (value, name) => {
        out.push([String(name), String(value)])
      }
    )
    return out
  }
  return Object.entries(headers as Record<string, unknown>).map(([name, value]) => [
    String(name),
    String(value),
  ])
}

/**
 * 从 body 里**只取键名**（值一个字节都不返回）。
 *
 * ⚠️ 这是本文件里唯一读 body 的地方，而且它**只**返回 `Object.keys()` 的排序结果。
 *    非字符串 / 非 JSON / 非对象 ⇒ `null`（**不**保存原文，也**不**保存片段）。
 */
function bodyFieldNamesOf(body: unknown): readonly string[] | null {
  if (typeof body !== 'string' || body === '') return null
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return Object.keys(parsed as Record<string, unknown>).sort()
  } catch {
    return null
  }
}

export function createRecordingFetch(options: RecordingFetchOptions = {}): RecordingFetch {
  const requests: RecordedRequest[] = []

  const fetchImpl: typeof fetch = async (input, init) => {
    const entries = headerEntries(init?.headers)
    const headerNames = entries.map(([name]) => name.toLowerCase()).sort()
    const headerValueLengths: Record<string, number> = {}
    for (const [name, value] of entries) headerValueLengths[name.toLowerCase()] = value.length
    const body = init?.body
    const record: RecordedRequest = {
      method: String(init?.method ?? 'GET').toUpperCase(),
      url: urlOf(input),
      headerNames,
      headerValueLengths,
      // 只记长度：body 内容一个字节都不保存
      bodyLength: typeof body === 'string' ? body.length : body === undefined ? 0 : -1,
      // 只记键名：值（含 query 正文）结构上取不到
      bodyFieldNames: bodyFieldNamesOf(body),
    }
    requests.push(record)

    if (options.respond !== undefined) return await options.respond(record, requests.length - 1)
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return {
    fetchImpl,
    requests,
    callCount: () => requests.length,
    reset: () => {
      requests.length = 0
    },
  }
}

/** 一行诊断（**只有名字、长度与参数名**，没有值） */
export function describeRecording(requests: readonly RecordedRequest[]): string {
  if (requests.length === 0) return 'outbound requests: 0'
  return requests
    .map((request, index) => {
      const host = (() => {
        try {
          return new URL(request.url).host
        } catch {
          return '(unparsable)'
        }
      })()
      const paramNames = (() => {
        try {
          return [...new URL(request.url).searchParams.keys()].sort().join(',') || '(none)'
        } catch {
          return '(unparsable)'
        }
      })()
      return (
        `#${index + 1} ${request.method} ${host} ` +
        `params=[${paramNames}] headers=[${request.headerNames.join(',')}] ` +
        `body=${request.bodyLength}${
          request.bodyFieldNames === null ? '' : ` fields=[${request.bodyFieldNames.join(',')}]`
        }`
      )
    })
    .join(' | ')
}
