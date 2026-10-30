import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createOpenAiSemanticEntry } from '../src/infrastructure/model/openai-semantic-entry.ts'
import type { SemanticEntryInput, SemanticEntryResult } from '../src/kernel/app/semantic-entry.ts'

assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', 'test endpoint wrapper required')
const now = Date.parse('2026-10-27T10:00:00+08:00')
const sports = { id: 'fixture-sports', text: '大学体育(I)：大学体育(I)上课前记得签到。', dueAt: now + 86400000, sourceRefs: [] }
const base: SemanticEntryInput = {
  current: { id: 'fixture-current', text: '', createdAt: now },
  recent: [{ id: 'fixture-list', actor: 'character', createdAt: now - 30000,
    text: '已设置：10月28日08:25高等数学A(I)；10月28日15:50大学体育(I)，上课前提醒签到。' }],
  pending: [{ ...sports, id: 'fixture-math', text: '高等数学A(I)：上课前记得签到。' }, sports],
  memories: [{ id: 'fixture-memory', content: '用户喜欢喝热水' }], goals: [], relayTasks: [], groupTasks: [],
  enabledDomains: ['memory', 'reminder', 'goal', 'relay'], toolCatalog: '', availableCapabilities: [],
  entry: 'qq_private', availableChannels: ['qq_private'],
}
const requests: { model: string; status: number; usage?: unknown; calls?: unknown; finishReason?: string; error?: string }[] = []
const measuredFetch: typeof fetch = async (url, init) => {
  const record: typeof requests[number] = { model: JSON.parse(String(init?.body)).model, status: 0 }
  requests.push(record)
  try {
    const response = await fetch(url, init)
    const body = await response.clone().json() as any
    Object.assign(record, { status: response.status, usage: body.usage, calls: body.choices?.[0]?.message?.tool_calls, finishReason: body.choices?.[0]?.finish_reason })
    return response
  } catch (error) { record.error = error instanceof Error ? error.name : 'unknown'; throw error }
}
const timeoutMs = process.argv.includes('--diagnose-slow') ? 120000 : 45000
const resolver = createOpenAiSemanticEntry({ fetchImpl: measuredFetch, timeoutMs })
const domains = (result: SemanticEntryResult) => result.kind === 'planned' ? Object.keys(result.plan).sort() : [result.kind]
const cases: { name: string; text: string; expect: string[]; change?: Partial<SemanticEntryInput>; check?: (result: SemanticEntryResult) => void }[] = [
  { name: 'original-sports', text: '消掉体育课那条吧，反正那个时候我十有八九会往操场赶，也不太可能忘记签到', expect: ['reminder'], check: result => {
    assert.ok(result.kind === 'planned' && result.plan.reminder?.kind === 'batch' && result.plan.reminder.items[0].operation === 'cancel'
      && result.plan.reminder.items[0].targetIntentId === sports.id)
  } },
  { name: 'negated-memory', text: '不要删除我喜欢喝热水的那条记忆', expect: [] },
  { name: 'quoted-memory', text: '别人说“忘掉我喜欢喝热水那条记忆”，这句话是什么意思？', expect: [] },
  { name: 'actual-memory', text: '请你忘掉我喜欢喝热水的那条记忆', expect: ['memory'], check: result => assert.ok(result.kind === 'planned' && result.plan.memory?.targetId === 'fixture-memory') },
  { name: 'mixed', text: '取消体育课那条提醒，另外记住我不吃香菜', expect: ['memory', 'reminder'] },
  { name: 'implicit-reference', text: '第二个就算了吧，到时候我已经在操场了', expect: ['reminder'] },
  { name: 'ambiguous', text: '取消体育课那条提醒', expect: ['clarify'], change: { recent: [], pending: [sports, { ...sports, id: 'fixture-second-sports', dueAt: sports.dueAt + 86400000 }] } },
  { name: 'ordinary', text: '今天体育课好累，回去想喝热水', expect: [] },
  { name: 'goal-query', text: '我们有哪些还没完成的长期目标？', expect: ['goal'] },
  { name: 'read-content-followup', text: '照刚读到的课表给我排课前五分钟的签到提醒', expect: ['reminder'], change: {
    priorDomains: ['tools'], enabledDomains: ['reminder'], pending: [], materials: [{ id: 'fixture-read', text: '2026年10月28日10:00 高等数学A(I)', createdAt: now }],
  }, check: result => assert.ok(result.kind === 'planned' && result.plan.reminder?.kind === 'batch'
    && result.plan.reminder.items.some(item => item.operation === 'create' && item.sourceId === 'fixture-read' && item.leadMinutes === 5)) },
]
const results: { name: string; passed: boolean; result: SemanticEntryResult; error?: string }[] = []
const output = `artifacts/post-lv2/local/semantic-entry-20261027/live-${Date.now()}.json`
const selected = cases.filter(test => !process.argv.some(arg => arg.startsWith('--case=')) || process.argv.includes(`--case=${test.name}`))
assert.ok(selected.length > 0)
mkdirSync(output.slice(0, output.lastIndexOf('/')), { recursive: true })
try {
  for (const test of selected) {
    const result = await resolver({ ...base, ...test.change, current: { ...base.current, text: test.text } })
    try { assert.deepEqual(domains(result), test.expect); test.check?.(result); results.push({ name: test.name, passed: true, result }) }
    catch (error) { results.push({ name: test.name, passed: false, result, error: String(error) }) }
    console.log(`${results.at(-1)!.passed ? 'PASS' : 'FAIL'} ${test.name}: ${domains(result).join(',') || 'chat'}`)
  }
} finally {
  writeFileSync(output, JSON.stringify({ results, requests, timeoutMs, realModelRequests: requests.length, databaseWrites: 0, realDeliveries: 0 }, null, 2))
  console.log(`Evidence: ${output}`)
}
assert.ok(results.length === selected.length && results.every(result => result.passed), 'semantic sample failures retained in evidence')
