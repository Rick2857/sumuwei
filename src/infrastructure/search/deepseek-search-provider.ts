/**
 * ADR-141: one native search, then at most two bounded public-page reads.
 * Protocol reference: deepseek-ai/deepseek-harness@86a4022, web-search-deepseek (MIT).
 * No provider prose or encrypted_content is used as evidence.
 */
import { EVIDENCE_LIMITS, type SearchEvidenceItem } from '../../kernel/contracts/external-evidence.ts'
import { actionFailure } from '../../kernel/action/errors.ts'
import { validateSearchQuery, type SearchProviderPort, type SearchProviderOutcome, type SearchProviderMetrics } from '../../kernel/action/search-port.ts'
import {
  admitWebReadUrl, createPinnedHttpsConnector, createPinnedHttpsFetcher,
  decodeHtml, extractArticle, checkHtmlContentType, WEB_READ_MAX_BYTES, type WebReadFetcher,
} from '../action/adapters/web-read.ts'
import {
  DEEPSEEK_SEARCH_ENDPOINT, DEEPSEEK_SEARCH_PROVIDER_ID, DEEPSEEK_SEARCH_TIMEOUT_MS,
  DEEPSEEK_SEARCH_TOTAL_TIMEOUT_MS, DEEPSEEK_SEARCH_MAX_PAGES, type DeepSeekSearchConfig,
} from './deepseek-config.ts'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined

export interface NativeSearchResult {
  items: SearchEvidenceItem[]
  toolCalls: number
  reportedSearchCalls: number | null
}

/** Check actual native calls and structured sources; never scrape model-written URLs. */
export function parseDeepSeekSearchResponse(payload: unknown, query: string): NativeSearchResult {
  const body = object(payload)
  if (body?.stop_reason !== 'end_turn' || !Array.isArray(body.content)) throw new Error('native_search_incomplete')
  const blocks = body.content.map(object)
  const calls = blocks.filter(b => b?.type === 'server_tool_use')
  if (calls.length !== 1 || typeof calls[0]?.id !== 'string' || !calls[0].id || calls[0]?.name !== 'web_search' || object(calls[0]?.input)?.query !== query) {
    throw new Error('native_search_call_or_query_mismatch')
  }
  const results = blocks.filter(b => b?.type === 'web_search_tool_result')
  if (results.length !== 1 || results[0]?.tool_use_id !== calls[0]?.id || !Array.isArray(results[0]?.content)) {
    throw new Error('native_search_result_missing_or_failed')
  }
  const reported = object(object(body.usage)?.server_tool_use)?.web_search_requests
  if (reported !== undefined && reported !== 1) throw new Error('native_search_usage_mismatch')
  const snippets = new Map<string, string>()
  for (const block of blocks) {
    if (block?.type !== 'text' || !Array.isArray(block.citations)) continue
    for (const raw of block.citations) {
      const cite = object(raw)
      if (cite?.type === 'web_search_result_location' && typeof cite.url === 'string' && typeof cite.cited_text === 'string') {
        if (!snippets.has(cite.url)) snippets.set(cite.url, cite.cited_text.trim())
      }
    }
  }
  const items: SearchEvidenceItem[] = []
  for (const raw of results[0]!.content as unknown[]) {
    const item = object(raw)
    if (item?.type !== 'web_search_result' || typeof item.url !== 'string' || typeof item.title !== 'string') {
      throw new Error('native_search_result_invalid')
    }
    items.push({ title: item.title.slice(0, EVIDENCE_LIMITS.maxTitleLength), url: item.url, snippet: snippets.get(item.url) ?? '' })
  }
  return { items, toolCalls: calls.length, reportedSearchCalls: typeof reported === 'number' ? reported : null }
}

export function createDeepSeekSearchProvider(options: {
  config: DeepSeekSearchConfig
  fetchImpl?: typeof fetch
  sourceFetcher?: WebReadFetcher
  searchTimeoutMs?: number
  totalTimeoutMs?: number
  onMetrics?: (metrics: SearchProviderMetrics) => void
}): SearchProviderPort {
  const { config } = options
  const doFetch = options.fetchImpl ?? globalThis.fetch
  return {
    id: DEEPSEEK_SEARCH_PROVIDER_ID,
    endpointHost: 'api.deepseek.com',
    async search(input): Promise<SearchProviderOutcome> {
      const metrics: SearchProviderMetrics = { nativeToolCalls: null, reportedSearchCalls: null, sourceReads: 0, sourceRequestAttempts: 0, failedSourceReads: 0 }
      let requestCount = 0
      const problems = validateSearchQuery(input)
      if (problems.length) return { ok: false, failure: actionFailure('validation_failed', problems.join(' / ')), requestCount, rejectedItems: 0, metrics }
      if (input.signal?.aborted) return { ok: false, failure: actionFailure('cancelled', '搜索已取消'), requestCount, rejectedItems: 0, metrics }
      const deadlineAt = Date.now() + (options.totalTimeoutMs ?? DEEPSEEK_SEARCH_TOTAL_TIMEOUT_MS)
      const overall = AbortSignal.any([AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())), ...(input.signal ? [input.signal] : [])])
      const searchSignal = AbortSignal.any([overall, AbortSignal.timeout(options.searchTimeoutMs ?? DEEPSEEK_SEARCH_TIMEOUT_MS)])
      try {
        requestCount = 1
        const response = await doFetch(DEEPSEEK_SEARCH_ENDPOINT, {
          method: 'POST', redirect: 'error', signal: searchSignal,
          headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: config.model, max_tokens: 4096,
            messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${input.query}` }] }],
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
          }),
        })
        if (!response.ok) return {
          ok: false, failure: actionFailure(response.status === 401 || response.status === 403 ? 'permission_denied' : 'execution_failed', `原生搜索 HTTP ${response.status}`, { status: response.status }), requestCount, rejectedItems: 0, metrics,
        }
        const parsed = parseDeepSeekSearchResponse(await response.json(), input.query)
        metrics.nativeToolCalls = parsed.toolCalls
        metrics.reportedSearchCalls = parsed.reportedSearchCalls
        const connect = createPinnedHttpsConnector()
        const fetchPage = options.sourceFetcher ?? createPinnedHttpsFetcher({
          maxRedirects: 1,
          connect: async request => { metrics.sourceRequestAttempts++; return connect(request) },
        })
        const items: SearchEvidenceItem[] = []
        const seen = new Set<string>()
        let rejectedItems = 0
        for (const item of parsed.items) {
          if (items.length >= input.limit) { rejectedItems++; continue }
          const admitted = admitWebReadUrl(item.url)
          if (!admitted.ok || seen.has(admitted.href)) { rejectedItems++; continue }
          seen.add(admitted.href)
          if (item.snippet && item.title) {
            items.push({ ...item, snippet: item.snippet.slice(0, EVIDENCE_LIMITS.maxSnippetLength) })
            continue
          }
          if (metrics.sourceReads >= DEEPSEEK_SEARCH_MAX_PAGES) { rejectedItems++; continue }
          metrics.sourceReads++
          try {
            overall.throwIfAborted()
            const page = await fetchPage({ url: admitted.href, deadlineAt, maxBytes: WEB_READ_MAX_BYTES, signal: overall })
            if (page.status < 200 || page.status >= 300 || page.bytes.byteLength > WEB_READ_MAX_BYTES ||
                !checkHtmlContentType(page.contentType).ok || !admitWebReadUrl(page.finalUrl).ok || page.hops.length > 2) throw new Error('source_http_failed')
            const article = await extractArticle(decodeHtml(page.bytes, page.declaredCharset).html)
            overall.throwIfAborted()
            if (!article.ok || !article.fullText.trim()) throw new Error('source_text_missing')
            items.push({ title: (article.title?.trim() || item.title).slice(0, EVIDENCE_LIMITS.maxTitleLength), url: page.finalUrl, snippet: article.fullText.slice(0, EVIDENCE_LIMITS.maxSnippetLength) })
          } catch {
            metrics.failedSourceReads++
            // Keep the unfulfilled source visible to the existing adapter's partial-result check.
            items.push(item)
          }
        }
        if (input.signal?.aborted || (overall.aborted && !items.some(item => item.snippet))) throw new Error('cancelled_or_timed_out')
        if (parsed.items.length > 0 && items.length === 0) items.push(parsed.items[0]!)
        return { ok: true, items, requestCount, rejectedItems, metrics }
      } catch {
        return { ok: false, failure: actionFailure(input.signal?.aborted ? 'cancelled' : searchSignal.aborted || overall.aborted ? 'timeout' : 'execution_failed', '原生搜索未完成，未形成可用结果'), requestCount, rejectedItems: 0, metrics }
      } finally {
        options.onMetrics?.({ ...metrics })
      }
    },
  }
}
