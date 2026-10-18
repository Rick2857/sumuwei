/** ADR-141: real TurnGateway/ledger/context/guards, synthetic network, fresh PGlite only. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateDatabase } from '../src/dev/sandbox.ts'
process.env.CHARACTER_DB_BACKEND = 'pglite'
process.env.POSTGRES_URL = ''
process.env.DATABASE_URL = ''
process.env.LG_PG_EXPECT_DATABASE = 'template1'
const sandbox = isolateDatabase('native-search-chain')
const { createM55Harness } = await import('./m5.5-harness.ts')
const { createFixtureSearchProvider } = await import('../src/infrastructure/search/fixture-search-provider.ts')
const { createDeepSeekSearchProvider } = await import('../src/infrastructure/search/deepseek-search-provider.ts')
const { applyExternalEvidenceReplyPolicy } = await import('../src/kernel/action/external-evidence-reply.ts')
let calls = 0
let broken = false
let partial = false
const text = 'NATIVE-PAGE-BODY-SENTINEL 这是网页的真实合成正文。'.repeat(40)
const native = createDeepSeekSearchProvider({
  config: { apiKey: 'NATIVE-KEY-SENTINEL', model: 'deepseek-flash' },
  fetchImpl: async (_url, init) => {
    calls++
    const request = JSON.parse(String(init?.body))
    const query = request.messages[0].content[0].text.replace('Perform a web search for the query: ', '')
    return new Response(JSON.stringify(broken ? { content: [] } : { stop_reason: 'end_turn', content: [
      { type: 'server_tool_use', name: 'web_search', id: 'call-1', input: { query } },
      { type: 'web_search_tool_result', tool_use_id: 'call-1', content: ['a', 'b'].map(s => ({ type: 'web_search_result', title: s, url: `https://example.com/${s}` })) },
    ], usage: { server_tool_use: { web_search_requests: 1 } } }))
  },
  sourceFetcher: async request => {
    if (partial && request.url.endsWith('/b')) throw new Error('synthetic page failure')
    return { bytes: Buffer.from(`<html><title>来源正文</title><article><p>${text}</p></article></html>`), finalUrl: request.url, finalHost: 'example.com', status: 200, hops: [], contentType: 'text/html' }
  },
})
const wrapped = createFixtureSearchProvider({ id: native.id, endpointHost: native.endpointHost, respond: (input) => native.search(input) })
const bed = await createM55Harness({ label: 'native-search-chain', provider: wrapped, sandboxRoot: join(sandbox.dir, 'actions') })
let checks = 0
const check = (condition: unknown, label: string): void => { assert.ok(condition, label); checks++ }
try {
  const before = await bed.tableDigest('memory_records')
  const turn = await bed.say({ gateway: bed.gatewayOf({ search: 'on' }), text: '搜索 Node.js 官方文档', replyText: '我查到了。[E99]' })
  check(calls === 1 && turn.search?.status === 'success' && turn.externalEvidence.length === 2, 'gateway executed native provider once')
  check(turn.packet.text.includes('NATIVE-PAGE-BODY-SENTINEL'), 'actual reader text reached compiled context')
  check(turn.inContext?.selected.length === 2, 'two selected evidence references')
  const reply = applyExternalEvidenceReplyPolicy({ search: turn.search!, reality: turn.inContext!, replyText: turn.replyText })
  check(reply.state === 'answered_with_sources' && reply.appendix.includes('https://example.com/a') && reply.appendix.includes('https://example.com/b') && !reply.replyText.includes('[E99]'), 'program appendix corresponds to input sources, invented citation removed')
  const persisted = JSON.stringify({ ledger: await bed.actionRows(), trace: turn.trace })
  check(!persisted.includes('NATIVE-PAGE-BODY-SENTINEL') && !persisted.includes('NATIVE-KEY-SENTINEL'), 'ledger and trace contain neither page text nor credential')
  check((await bed.tableDigest('memory_records')) === before, 'search did not write long-term memory')
  await bed.say({ gateway: bed.gatewayOf({ search: 'on' }), text: '你好', replyText: '你好。' })
  check(calls === 1, 'ordinary conversation produced zero search I/O')
  const off = await bed.say({ gateway: bed.gatewayOf({ search: 'off' }), text: '搜索 Node.js 官方文档', replyText: '这次没有启用搜索。' })
  check(calls === 1 && off.search?.status === 'rejected', 'flag-off denied before provider dispatch')
  partial = true
  const partly = await bed.say({ gateway: bed.gatewayOf({ search: 'on' }), text: '搜索 Node.js 官方文档', replyText: '部分来源读取失败。' })
  check(partly.search?.status === 'partial' && partly.externalEvidence.length === 1, 'page failure remains partial through real gateway')
  broken = true
  const failed = await bed.say({ gateway: bed.gatewayOf({ search: 'on' }), text: '搜索 Node.js 官方文档', replyText: '我查到了很多资料。' })
  const failedReply = applyExternalEvidenceReplyPolicy({ search: failed.search!, ...(failed.inContext ? { reality: failed.inContext } : {}), replyText: failed.replyText })
  check(failed.search?.status === 'failed' && failedReply.appendix === '' && failed.externalEvidence.length === 0, 'missing tool results cannot become a sourced answer')
  broken = false; partial = false
  const dropped = await bed.say({ gateway: bed.gatewayOf({ search: 'on', evidenceTokens: 0 }), text: '搜索 Node.js 官方文档', replyText: '查到了。' })
  const droppedReply = applyExternalEvidenceReplyPolicy({ search: dropped.search!, reality: dropped.inContext!, replyText: dropped.replyText })
  check(droppedReply.appendix === '' && dropped.inContext?.selected.length === 0, 'budget-discarded evidence never appears in appendix')
  mkdirSync('artifacts/post-lv2/native-search', { recursive: true })
  writeFileSync('artifacts/post-lv2/native-search/chain.json', JSON.stringify({ schema: 'native-search-chain@1', checks, failed: 0, modelRequests: calls, network: 'synthetic', database: 'fresh-isolated-pglite' }, null, 2) + '\n')
  console.log(`native-search-chain: ${checks} checks passed`)
} finally { await bed.dispose() }
