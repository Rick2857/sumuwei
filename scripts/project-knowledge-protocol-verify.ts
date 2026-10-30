import assert from 'node:assert/strict'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'
import { createProjectKnowledgeProvider } from '../src/kernel/context/project-knowledge-section.ts'
import { createOpenAiSemanticEntry } from '../src/infrastructure/model/openai-semantic-entry.ts'
import type { SemanticEntryInput } from '../src/kernel/app/semantic-entry.ts'

const leaked = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="self.capabilities">\n\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
for (const text of [leaked, `回答前缀\n${leaked}`, '<||DSML|| invoke name="self.capabilities">',
  '<｜DSML｜function_calls><｜DSML｜invoke name="self.capabilities">']) {
  assert.throws(() => runReplyGuardChain({ replyText: text }), /reply_contains_tool_protocol/)
}
for (const text of ['self.capabilities 是只读查询能力。', '我不能从当前信息判断群发送权限。', '普通正文。']) {
  assert.equal(runReplyGuardChain({ replyText: text }).replyText, text)
}
const sections = await createProjectKnowledgeProvider({ project: true, self: true }).provide({} as never)
assert.ok(sections[0]!.content.includes('最终回复阶段'))
assert.ok(!sections[0]!.content.includes('需要时自行查询'))
const base: SemanticEntryInput = { current: { id: 'synthetic-current', text: '问个问题，你现在能够决定自行往哪个群里发消息吗？', createdAt: 123 },
  recent: [], pending: [], memories: [], goals: [], relayTasks: [], groupTasks: [], enabledDomains: ['tools'],
  toolCatalog: 'self.capabilities:query args={}', availableCapabilities: ['self.capabilities'],
  entry: 'qq_private', availableChannels: ['qq_private'] }
let request: any, validated = 0
const entry = createOpenAiSemanticEntry({ env: { OPENAI_API_KEY: 'fixture-only' }, fetchImpl: async (_url, init) => {
  request = JSON.parse(String(init?.body))
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'lg_tools',
    arguments: JSON.stringify({ branch: 'tools', goal: '核对当前能力', steps: [{ capability: 'self.capabilities', operation: 'query', args: {} }], done: true }) } }] } }] })
} })
assert.equal((await entry(base, () => { validated++ })).kind, 'planned')
assert.equal(validated, 1)
assert.ok(request.messages[0].content.includes('当前能力问题'))
assert.ok(request.messages[0].content.includes('查询不授权发送'))
assert.ok(request.messages[0].content.includes('lg_tools'))
assert.deepEqual(request.tools.map((tool: any) => tool.function.name), ['lg_tools', 'lg_clarify'])
await entry({ ...base, availableCapabilities: [] }, () => {})
assert.equal(request.messages[0].content.includes('当前能力问题'), false, 'disabled capability has no query instruction')
console.log('PASS DSML reserved protocol rejection, ordinary prose, final phase boundary, semantic readonly query and disabled control (fixture; zero real model/QQ)')
