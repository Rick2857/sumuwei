import assert from 'node:assert/strict'
import { readSemanticToolCalls, semanticDomainSelected, type SemanticEntryInput } from '../src/kernel/app/semantic-entry.ts'
import { createOpenAiSemanticEntry, semanticEntryTools } from '../src/infrastructure/model/openai-semantic-entry.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'

const input: SemanticEntryInput = { current: { id: 'current', text: '消掉体育课那条吧，不太可能忘记签到；记住我不吃香菜。', createdAt: 1 },
  recent: [{ id: 'listed', text: '大学体育(I)那条提醒已设置。', createdAt: 0, actor: 'character' }],
  pending: [{ id: 'sports', text: '大学体育(I)：课前签到', dueAt: 2, sourceRefs: [] }],
  memories: [{ id: 'memory', content: '我喜欢喝热水' }], goals: [], relayTasks: [], groupTasks: [],
  enabledDomains: ['memory', 'reminder', 'goal', 'tools', 'relay'], toolCatalog: 'fixture', availableCapabilities: ['system.echo'],
  entry: 'qq_private', availableChannels: ['qq_private'] }
const call = (name: string, value: unknown) => ({ function: { name, arguments: JSON.stringify(value) } })
const cancel = call('lg_reminder', { kind: 'cancel', targetIntentId: 'sports' })
const remember = call('lg_memory', { kind: 'remember', payload: '我不吃香菜' })
const plan = readSemanticToolCalls([cancel, remember], input)
assert.ok(plan.kind === 'planned' && plan.plan.memory && plan.plan.reminder)
assert.equal(semanticDomainSelected(plan, 'tools'), false)
assert.equal(semanticDomainSelected({ kind: 'failed', code: 'timeout' }, 'memory'), false)
assert.equal(semanticDomainSelected({ kind: 'clarify', question: '哪条？' }, 'reminder'), false)
assert.equal(semanticDomainSelected(undefined, 'reminder'), true, 'unconfigured callers retain legacy behavior')
assert.deepEqual(readSemanticToolCalls([], input), { kind: 'planned', plan: {} })
for (const calls of [
  [call('lg_memory', { kind: 'forget', payload: '签到', targetId: 'other-owner' })],
  [call('lg_memory', { kind: 'remember', payload: '我喜欢喝咖啡' })],
  [call('lg_memory', { kind: 'forget', payload: '签到', targetId: 'memory', permission: true })],
  [call('lg_reminder', { kind: 'cancel', targetIntentId: 'foreign' })],
  [call('lg_reminder', { kind: 'batch', items: [{ operation: 'create', sourceId: 'invented', timeText: '10:00', text: '提醒' }] })],
  [call('lg_reminder', { kind: 'cancel', targetIntentId: 'sports', text: 'extra' })],
  [cancel, cancel], [cancel, call('lg_clarify', { question: '哪条？' })],
  [call('execute_shell', { command: 'anything' })],
  [call('lg_goal', { operation: 'create', targetGoalId: 'invented' })],
  [call('lg_relay', { kind: 'cancel', taskId: 'foreign' })],
  [call('lg_tools', { branch: 'tools' })],
]) assert.equal(readSemanticToolCalls(calls, input).kind, 'failed', JSON.stringify(calls))
assert.equal(readSemanticToolCalls([cancel], { ...input, enabledDomains: [] }).kind, 'failed')
assert.equal(readSemanticToolCalls([cancel], { ...input, priorDomains: ['reminder', 'tools'] }).kind, 'failed', 'continuation cannot repeat an already proposed domain')
assert.equal(readSemanticToolCalls([remember], { ...input, priorDomains: ['tools'] }).kind, 'failed', 'read material cannot grant a new memory command')
assert.equal(readSemanticToolCalls([call('reminder', { kind: 'cancel', targetIntentId: 'sports' })], input).kind, 'failed')
assert.equal(readSemanticToolCalls([{ function: { name: 'lg_reminder', arguments: '{' } }], input).kind, 'failed')
assert.equal(readSemanticToolCalls([call('lg_clarify', { question: '哪一节体育课？' })], input).kind, 'clarify')
const memoryTarget = readSemanticToolCalls([call('lg_memory', { kind: 'forget', payload: '签到', targetId: 'memory' })], input)
assert.ok(memoryTarget.kind === 'planned' && memoryTarget.plan.memory?.targetId === 'memory')
let toolValidated = false
assert.equal(readSemanticToolCalls([call('lg_tools', { branch: 'tools' })], input, () => { toolValidated = true }).kind, 'planned')
assert.ok(toolValidated, 'tool proposals use the existing validator before any write')
assert.equal(readKernelFlags({ CHARACTER_SEMANTIC_ENTRY_ENABLED: 'true' }).toolDecisionMode, 'role')
assert.equal(readKernelFlags({}).semanticEntryEnabled, false)

let body: any
let response: any = { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [cancel, remember] } }] }
let calls = 0
const resolver = createOpenAiSemanticEntry({ env: { OPENAI_API_KEY: 'fixture', OPENAI_SMALL_MODEL: 'small', OPENAI_LARGE_MODEL: 'vision' },
  fetchImpl: async (_url, init) => { calls++; body = JSON.parse(String(init?.body)); return Response.json(response) } })
assert.equal((await resolver(input)).kind, 'planned')
assert.equal(calls, 1)
assert.equal(body.model, 'small')
assert.equal(body.tool_choice, 'auto')
assert.ok(body.tools.some((tool: any) => tool.function.name === 'lg_reminder'))
assert.deepEqual(JSON.parse(body.messages[1].content).recent, input.recent)
const ordinarySystem = body.messages[0].content
await resolver({ ...input, replyMedia: { qqVoiceAvailable: true } })
assert.deepEqual(JSON.parse(body.messages[1].content).replyMedia, { qqVoiceAvailable: true })
assert.ok(body.messages[0].content.includes('不需要 lg_tools 或 lg_relay'))
await resolver(input)
assert.equal(body.messages[0].content, ordinarySystem)
assert.ok(!('replyMedia' in JSON.parse(body.messages[1].content)))
response = { choices: [{ finish_reason: 'stop', message: { content: '聊天' } }] }
assert.deepEqual(await resolver(input), { kind: 'planned', plan: {} })
response = { choices: [{ finish_reason: 'length', message: { tool_calls: [cancel] } }] }
assert.equal((await resolver(input)).kind, 'failed')
response = { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [cancel, call('bad', {})] } }] }
assert.equal((await resolver(input)).kind, 'failed', 'one invalid command rejects the entire batch')
await resolver({ ...input, materials: [{ id: 'image', text: '课表', createdAt: 1, dataUrl: 'data:image/png;base64,fixture' }] })
assert.equal(body.model, 'vision')
assert.ok(!body.messages[1].content[0].text.includes('base64'), 'binary data stays out of context JSON')
assert.ok(!semanticEntryTools({ ...input, enabledDomains: [] }).some(tool => tool.function.name === 'lg_memory'))
console.log('Unified semantic entry: closed native calls, multi-domain proposals, no fallback, ids/sources, capabilities, context, image and transport PASS (zero real model requests)')
