/** Public-query, database-free protocol probe. Production credentials require an explicit CLI opt-in. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { parse } from 'dotenv'
import { createDeepSeekSearchProvider } from '../src/infrastructure/search/deepseek-search-provider.ts'
import { createWebSearchAdapter } from '../src/infrastructure/action/adapters/web-search.ts'
import { createSha256Fingerprinter } from '../src/infrastructure/search/fingerprint.ts'
import { newActionId } from '../src/kernel/contracts/ids.ts'
import { loadDeepSeekSearchConfig } from '../src/infrastructure/search/deepseek-config.ts'

const productionCredential = process.argv.includes('--production-credential')
if (!productionCredential && process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Use with-test-model; production probe requires explicit --production-credential')
const config = productionCredential
  ? loadDeepSeekSearchConfig({ env: parse(readFileSync('.env')) })
  : loadDeepSeekSearchConfig({ isTestMode: true })
const query = 'Node.js 22 官方文档 AbortSignal timeout 用法'
const citationMode = process.argv.includes('--citations')
const responsesMode = process.argv.includes('--responses')
const providerMode = process.argv.includes('--provider')
const started = Date.now()
const dir = `artifacts/post-lv2/native-search/probe-${started}`
mkdirSync(dir, { recursive: true })
const result: Record<string, unknown> = {
  schema: 'native-search-probe@1', query, citationMode, responsesMode, endpointHost: 'api.deepseek.com',
  model: config.model, credential: productionCredential ? 'user-authorized-production-probe' : 'explicit-test-credential', database: 'not-imported',
}
try {
  if (providerMode) {
    const provider = createDeepSeekSearchProvider({ config, onMetrics: metrics => { result.metrics = metrics } })
    const adapter = createWebSearchAdapter({ provider, fingerprint: createSha256Fingerprinter() })
    const outcome = await adapter.execute({ actionId: newActionId(), operation: 'search', target: { type: 'external_service', canonicalId: provider.id, confidence: 'exact' }, args: { query, limit: 5, locale: 'zh-CN' }, now: () => Date.now() })
    result.evidence = outcome.externalEvidence?.map(item => ({ title: item.title, url: item.sourceUri, excerptLength: item.snippet.length }))
    result.partial = outcome.partial ?? null
    result.status = (outcome.externalEvidence?.length ?? 0) > 0 ? 'EVIDENCE_OBSERVED' : 'NO_USABLE_EVIDENCE'
  } else {
  const response = await fetch(responsesMode ? 'https://api.deepseek.com/responses' : 'https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
    headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(responsesMode ? {
      model: config.model, max_output_tokens: 4096, reasoning: { effort: 'none' },
      input: `Perform one web search for this exact query and cite sources: ${query}`,
      tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' }, max_tool_calls: 1,
    } : {
      model: config.model, max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: citationMode
        ? `Perform a web search for the exact query below. Give a short answer with native web search citations, including cited_text excerpts in the citations on text blocks. Do not invent citations. Query: ${query}`
        : `Perform a web search for the query: ${query}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    }),
  })
  result.httpStatus = response.status
  if (response.ok) {
    const body = await response.json() as Record<string, any>
    if (responsesMode) {
      result.responseStatus = body.status
      result.incompleteDetails = body.incomplete_details
      result.responseOutput = (Array.isArray(body.output) ? body.output : []).map((b: any) => b.type === 'web_search_call'
        ? { ...b }
        : { type: b.type, fields: Object.keys(b), content: Array.isArray(b.content) ? b.content.map((c: any) => ({ type: c.type, fields: Object.keys(c), annotations: c.annotations })) : undefined })
      result.usage = body.usage
      result.status = (Array.isArray(body.output) ? body.output : []).some((b: any) => b.type === 'web_search_call') ? 'RESULT_BLOCK_OBSERVED' : 'NO_NATIVE_SEARCH'
    } else {
    const blocks = Array.isArray(body.content) ? body.content : []
    result.stopReason = body.stop_reason
    result.blockTypes = blocks.map((b: any) => b.type)
    result.textBlockFields = blocks.filter((b: any) => b.type === 'text').map((b: any) => ({ fields: Object.keys(b), textLength: b.text?.length, citationMarkers: typeof b.text === 'string' ? /cite|【|\[\d+\]/i.test(b.text) : false }))
    result.tools = blocks.filter((b: any) => b.type === 'server_tool_use').map((b: any) => ({ name: b.name, input: b.input }))
    result.results = blocks.filter((b: any) => b.type === 'web_search_tool_result').map((b: any) => ({
      kind: Array.isArray(b.content) ? 'results' : 'tool_error',
      errorCode: b.content?.error_code,
      items: Array.isArray(b.content) ? b.content.map((i: any) => ({ type: i.type, title: i.title, url: i.url, fields: Object.keys(i) })) : [],
    }))
    result.citations = blocks.filter((b: any) => b.type === 'text').flatMap((b: any) => Array.isArray(b.citations) ? b.citations.map((c: any) => ({ type: c.type, url: c.url, excerptLength: typeof c.cited_text === 'string' ? c.cited_text.length : 0 })) : [])
    result.usage = body.usage
    result.status = (result.results as unknown[]).length > 0 ? 'RESULT_BLOCK_OBSERVED' : 'NO_NATIVE_SEARCH'
    }
  } else result.status = 'HTTP_FAILURE'
  }
} catch (error) {
  result.status = 'REQUEST_FAILED'
  result.errorName = error instanceof Error ? error.name : 'unknown'
}
result.durationMs = Date.now() - started
writeFileSync(`${dir}/evidence.json`, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
console.log(`Evidence: ${dir}/evidence.json`)
if (result.status !== 'RESULT_BLOCK_OBSERVED' && result.status !== 'EVIDENCE_OBSERVED') process.exitCode = 1
