/** Bounded semantic probe only: synthetic messages, no database, no delivery. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createOpenAiRelayResolver } from '../src/infrastructure/model/openai-relay.ts'
import type { RelayInput } from '../src/kernel/app/relay-turn.ts'

assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', 'requires with-test-model; never use chat credentials')
let requests = 0, totalTokens = 0
const resolve = createOpenAiRelayResolver({ fetchImpl: async (url, options) => {
  requests++
  assert.ok(requests <= 8)
  const response = await fetch(url, options)
  const usage = await response.clone().json() as { usage?: { total_tokens?: number } }
  totalTokens += usage.usage?.total_tokens ?? 0
  return response
} })
const base: RelayInput = { current: { id: 'current', text: '', actor: 'user' }, recent: [], tasks: [],
  origin: { transport: 'qq', senderId: 'synthetic-alice', userId: 'synthetic-user', conversationId: 'synthetic-room',
    room: { kind: 'group', groupId: 'synthetic-group' } }, recipient: 'bound_owner' }
const cases = [
  { id: 'qq-create', text: '@苏沐薇，帮我告诉你主人，明天下午三点开会。', kinds: ['create'] },
  { id: 'wechat-continuation-no-keyword', text: '改成下午四点吧，就按这个时间办。', kinds: ['create'], wechat: true,
    recent: [{ id: 'request', actor: 'user' as const, text: '请你把明天开会的时间用QQ私聊告诉你的主人。' },
      { id: 'reply', actor: 'character' as const, text: '会议具体几点开始？' }] },
  { id: 'negated', text: '刚才只是举例，不用帮我转告任何事情。', kinds: ['none', 'decline'] },
  { id: 'quoted-request', text: '我在写小说，角色说“帮我转告主人明天开会”，这句话通顺吗？', kinds: ['none'] },
  { id: 'other-recipient', text: '把明天三点开会的事发给小李，别发给你主人。', kinds: ['clarify', 'decline'] },
  { id: 'wrong-output-channel', text: '帮我把三点开会的事用微信私聊告诉你主人，不要用QQ。', kinds: ['clarify', 'decline'] },
  { id: 'verbatim', text: '请用QQ告诉你主人，我的原话必须保留：“不是今天，是明天下午三点；时间还没最终确认。”', kinds: ['create'], mode: 'verbatim' },
  { id: 'insufficient', text: '帮我告诉你主人那件事。', kinds: ['clarify'] },
]
const results = []
for (const item of cases) {
  const result = await resolve({ ...base, current: { ...base.current, text: item.text }, recent: item.recent ?? [],
    origin: { ...base.origin, transport: item.wechat ? 'wechat' : 'qq' } })
  const passed = result.ok && item.kinds.includes(result.draft.kind)
    && (!item.mode || result.draft.kind === 'create' && result.draft.mode === item.mode)
  results.push({ id: item.id, passed, result })
  console.log(JSON.stringify({ id: item.id, passed, result }))
}
const directory = `artifacts/post-lv2/local/relay-model-${Date.now()}`
mkdirSync(directory, { recursive: true })
writeFileSync(`${directory}/result.json`, JSON.stringify({ model: process.env.OPENAI_SMALL_MODEL,
  requests, totalTokens, results, boundary: 'synthetic semantic probe only; no database or real message delivery' }, null, 2))
console.log(JSON.stringify({ requests, totalTokens, passed: results.filter(item => item.passed).length, total: results.length, directory }))
assert.ok(results.every(item => item.passed), 'semantic probe failures must be reported, not converted to keyword rules')
