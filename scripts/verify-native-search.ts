/** ADR-141 component and adapter checks: no env loading, no database, no network. */
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { loadDeepSeekSearchConfig } from '../src/infrastructure/search/deepseek-config.ts'
import { createDeepSeekSearchProvider, parseDeepSeekSearchResponse } from '../src/infrastructure/search/deepseek-search-provider.ts'
import { createWebSearchAdapter } from '../src/infrastructure/action/adapters/web-search.ts'
import { createSha256Fingerprinter } from '../src/infrastructure/search/fingerprint.ts'
import { createPinnedHttpsFetcher, type WebReadFetcher } from '../src/infrastructure/action/adapters/web-read.ts'
import { newActionId } from '../src/kernel/contracts/ids.ts'
import type { SearchProviderMetrics } from '../src/kernel/action/search-port.ts'

let checks = 0
const check = (condition: unknown, message: string): void => { assert.ok(condition, message); checks++ }
const query = 'Node.js 官方文档'
const config = { apiKey: 'synthetic-secret', model: 'deepseek-flash' }
function payload(urls = ['https://example.com/one', 'https://example.org/two']): Record<string, unknown> {
  return { stop_reason: 'end_turn', content: [
    { type: 'server_tool_use', id: 'tool-1', name: 'web_search', input: { query } },
    { type: 'web_search_tool_result', tool_use_id: 'tool-1', content: urls.map(url => ({ type: 'web_search_result', title: '来源', url, encrypted_content: 'NEVER-USE-AS-TEXT' })) },
    { type: 'text', text: 'UNTRUSTED-MODEL-PROSE' },
  ], usage: { server_tool_use: { web_search_requests: 1 } } }
}
const articleText = '这是从网页实际读取的公开正文。'.repeat(80)
const pageFetcher: WebReadFetcher = async request => ({ bytes: Buffer.from(`<html><head><title>真实网页标题</title></head><body><article><p>${articleText}</p></article></body></html>`), finalUrl: request.url, finalHost: new URL(request.url).host, hops: [], status: 200, contentType: 'text/html' })
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const input = { query, limit: 5, locale: 'zh-CN' }
let requests = 0
let lastMetrics: SearchProviderMetrics | undefined
const provider = createDeepSeekSearchProvider({ config, sourceFetcher: pageFetcher, onMetrics: m => { lastMetrics = m }, fetchImpl: async (url, init) => {
  requests++
  assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(init?.redirect, 'error')
  const body = JSON.parse(String(init?.body))
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'tools'])
  assert.equal(body.tools[0].max_uses, 1)
  assert.equal(body.messages.length, 1)
  assert.ok(!String(init?.body).includes(config.apiKey))
  return response(payload())
} })
const out = await provider.search(input)
check(out.ok && out.items.length === 2 && out.items.every(i => i.snippet.length === 600 && !i.snippet.includes('UNTRUSTED')), 'actual page text forms bounded snippets')
check(requests === 1 && lastMetrics?.sourceReads === 2 && lastMetrics.failedSourceReads === 0, 'one model request, two page reads')
const adapter = createWebSearchAdapter({ provider, fingerprint: createSha256Fingerprinter() })
const executeInput = { actionId: newActionId(), operation: 'search', target: { type: 'external_service', canonicalId: provider.id, confidence: 'exact' as const }, args: input, now: () => 1_790_000_000_000 }
const executed = await adapter.execute(executeInput)
check(executed.externalEvidence?.length === 2 && executed.evidence?.some(e => e.detail.includes('网页读取 2')), 'real adapter exposes evidence and safe counts')
check(!JSON.stringify(executed.evidence).includes(articleText.slice(0, 50)) && !JSON.stringify(executed.evidence).includes(config.apiKey), 'ledger evidence contains no body or credentials')

for (const malformed of [null, {}, { ...payload(), stop_reason: 'max_tokens' }, { ...payload(), content: [{ type: 'text', text: 'I searched https://fake.example' }] }, { ...payload(), usage: { server_tool_use: { web_search_requests: 2 } } }]) {
  assert.throws(() => parseDeepSeekSearchResponse(malformed, query)); checks++
}
assert.throws(() => parseDeepSeekSearchResponse(payload(), 'different query')); checks++
const wrongCall = payload(); (wrongCall.content as Array<Record<string, unknown>>)[1]!.tool_use_id = 'wrong'
assert.throws(() => parseDeepSeekSearchResponse(wrongCall, query)); checks++
const toolError = payload(); (toolError.content as Array<Record<string, unknown>>)[1]!.content = { type: 'web_search_tool_result_error', error_code: 'unavailable' }
assert.throws(() => parseDeepSeekSearchResponse(toolError, query)); checks++
check(parseDeepSeekSearchResponse(payload(), query).items.every(i => i.snippet === ''), 'no invented excerpt when citations are absent')
check(parseDeepSeekSearchResponse(payload(), query).toolCalls === 1, 'restored structured response is accepted after negative controls')
const noIds = payload()
delete (noIds.content as Array<Record<string, unknown>>)[0]!.id
delete (noIds.content as Array<Record<string, unknown>>)[1]!.tool_use_id
assert.throws(() => parseDeepSeekSearchResponse(noIds, query)); checks++
const cited = payload(['https://example.com/one'])
;(cited.content as Array<Record<string, unknown>>).push({ type: 'text', citations: [{ type: 'web_search_result_location', url: 'https://example.com/one', cited_text: '真实结构化引用摘录' }] })
let citedPageReads = 0
const citedOutcome = await createDeepSeekSearchProvider({ config, fetchImpl: async () => response(cited), sourceFetcher: async r => { citedPageReads++; return pageFetcher(r) } }).search(input)
check(citedOutcome.ok && citedOutcome.items[0]?.snippet === '真实结构化引用摘录' && citedPageReads === 0, 'native citation excerpt avoids unnecessary page fetches')

for (const status of [401, 403, 429, 500]) {
  const p = createDeepSeekSearchProvider({ config, fetchImpl: async () => response({ error: config.apiKey }, status) })
  const failed = await p.search(input)
  check(!failed.ok && failed.requestCount === 1 && !JSON.stringify(failed).includes(config.apiKey), `HTTP ${status} fails safely`)
}
const missing = createDeepSeekSearchProvider({ config, fetchImpl: async () => response({ content: [] }) })
check(!(await missing.search(input)).ok, 'HTTP 200 without native results is failure')
const empty = createDeepSeekSearchProvider({ config, fetchImpl: async () => response(payload([])) })
const emptyResult = await empty.search(input)
check(emptyResult.ok && emptyResult.items.length === 0, 'genuine empty result stays distinct')
const many = createDeepSeekSearchProvider({ config, fetchImpl: async () => response(payload(['https://example.com/a', 'https://example.com/b', 'https://example.com/c'])), sourceFetcher: pageFetcher })
const bounded = await many.search(input)
check(bounded.ok && bounded.metrics?.sourceReads === 2 && bounded.items.length === 2 && bounded.rejectedItems === 1, 'at most two page reads, no extra source retry')
let reads = 0
const unsafe = createDeepSeekSearchProvider({ config, fetchImpl: async () => response(payload(['https://127.0.0.1/a', 'file:///private', 'https://example.com/a'])), sourceFetcher: async r => { reads++; return pageFetcher(r) } })
await unsafe.search(input)
check(reads === 1, 'literal private and non-HTTPS sources cannot reach reader')
let connections = 0
const pinned = createPinnedHttpsFetcher({ resolve: async () => ['127.0.0.1'], connect: async () => { connections++; throw new Error('must not connect') } })
await assert.rejects(pinned({ url: 'https://public.example', deadlineAt: Date.now() + 1000, maxBytes: 1024 })); checks++
check(connections === 0, 'shared reader rejects DNS-resolved private addresses before connection')

const partialProvider = createDeepSeekSearchProvider({ config, fetchImpl: async () => response(payload()), sourceFetcher: async r => { if (r.url.includes('example.org')) throw new Error('synthetic'); return pageFetcher(r) } })
const partial = await createWebSearchAdapter({ provider: partialProvider, fingerprint: createSha256Fingerprinter() }).execute(executeInput)
check(partial.partial?.completed === 1 && partial.partial.total === 2 && partial.externalEvidence?.length === 1, 'one unreadable page produces partial success')
const allFailed = createDeepSeekSearchProvider({ config, fetchImpl: async () => response(payload()), sourceFetcher: async () => { throw new Error('synthetic') } })
const noEvidence = await createWebSearchAdapter({ provider: allFailed, fingerprint: createSha256Fingerprinter() }).execute(executeInput)
check(noEvidence.partial?.completed === 0 && noEvidence.externalEvidence?.length === 0, 'search results without readable text do not become success')

const before = requests
const cancelled = new AbortController(); cancelled.abort()
const cancelledResult = await provider.search({ ...input, signal: cancelled.signal })
check(!cancelledResult.ok && cancelledResult.failure.code === 'cancelled' && requests === before, 'pre-cancelled request causes zero I/O')
await provider.search({ ...input, query: '' })
check(requests === before, 'invalid query causes zero I/O')
const keepAlive = setTimeout(() => {}, 1000)
try {
  const hanging = createDeepSeekSearchProvider({ config, searchTimeoutMs: 5, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) })
  const timed = await hanging.search(input)
  check(!timed.ok && timed.failure.code === 'timeout', 'native request timeout is enforced')
  const controller = new AbortController()
  const waiting = createPinnedHttpsFetcher({ resolve: async () => new Promise(() => {}) })({ url: 'https://public.example', deadlineAt: Date.now() + 900, maxBytes: 1024, signal: controller.signal })
  controller.abort()
  await assert.rejects(waiting); checks++
} finally { clearTimeout(keepAlive) }

check(loadDeepSeekSearchConfig({ env: { OPENAI_BASE_URL: 'https://api.deepseek.com', OPENAI_API_KEY: 'secret', OPENAI_LARGE_MODEL: 'deepseek-flash' } }).apiKey === 'secret', 'production reuses selected model credential')
for (const env of [
  { OPENAI_BASE_URL: 'https://api.minimax.cn/v1', OPENAI_API_KEY: 'wrong-vendor-key', OPENAI_LARGE_MODEL: 'other' },
  { OPENAI_BASE_URL: 'https://api.deepseek.com', OPENAI_API_KEY: 'production-key', OPENAI_LARGE_MODEL: 'deepseek-flash', DSH_TEST_MODEL_WRAPPER: '1' },
]) { assert.throws(() => loadDeepSeekSearchConfig({ env })); checks++ }
check(loadDeepSeekSearchConfig({ isTestMode: true, env: { DEEPSEEK_SEARCH_TEST_API_KEY: 'explicit-test-key' } }).apiKey === 'explicit-test-key', 'explicit test credential works without production fallback')
const main = readFileSync('src/main.ts', 'utf8')
check(main.includes('createDeepSeekSearchProvider(') && !main.includes('createTavilySearchProvider'), 'main wires only the native provider')
mkdirSync('artifacts/post-lv2/native-search', { recursive: true })
writeFileSync('artifacts/post-lv2/native-search/component.json', JSON.stringify({ schema: 'native-search-component@1', checks, failed: 0, network: false, database: false }, null, 2) + '\n')
console.log(`native-search: ${checks} checks passed; no network, no database`)
