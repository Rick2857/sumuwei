import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createOpenAiReminderResolver } from '../src/infrastructure/model/openai-reminder-text.ts'
import { createExplicitMemoryIntentDetector, LlmMemoryIntentClassifier } from '../src/kernel/app/memory/intent-detector.ts'
import { runReminderTurn, reminderFactText, type PendingReminder, type ReminderResolutionInput } from '../src/kernel/app/reminder-turn.ts'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'

assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', 'test endpoint wrapper required')
const text = '消掉体育课那条吧，反正那个时候我十有八九会往操场赶，也不太可能忘记签到'
const now = Date.parse('2026-10-25T23:17:00+08:00')
const sports = { id: 'fixture-sports', text: '大学体育(I)：大学体育(I)上课前记得签到。', dueAt: now + 7200000, sourceRefs: [] }
const input: ReminderResolutionInput = { current: { id: 'fixture-current', text, createdAt: now },
  recent: [{ id: 'fixture-list', actor: 'character', createdAt: now - 30000,
    text: '已设置：10月26日08:25高等数学A(I)；10月26日15:50大学体育(I)，上课前提醒签到。' }],
  pending: [{ ...sports, id: 'fixture-math', text: '高等数学A(I)：上课前记得签到。' }, sports] }
const requests: { model: string; usage?: unknown; output: string; status: number }[] = []
const measuredFetch: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body))
  const response = await fetch(url, init)
  const json = await response.clone().json() as any
  requests.push({ model: body.model, usage: json.usage, output: json.choices?.[0]?.message?.content ?? '', status: response.status })
  return response
}
const chat = async (messages: { role: string; content: string }[]) => {
  const response = await measuredFetch(`${process.env.OPENAI_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_SMALL_MODEL, temperature: 0, max_tokens: 1500, messages }), signal: AbortSignal.timeout(45000),
  })
  assert.ok(response.ok, `HTTP ${response.status}`)
  const json = await response.json() as any
  return String(json.choices?.[0]?.message?.content ?? '')
}
const output = `artifacts/post-lv2/local/reminder-cancellation-${Date.now()}`
mkdirSync(output, { recursive: true })
try {
  const detector = createExplicitMemoryIntentDetector({ classifier: new LlmMemoryIntentClassifier({ invokeModel: prompt => chat([{ role: 'user', content: prompt }]) }) })
  assert.equal(await detector.detect(text, input.recent.map(row => ({ actor: row.actor!, text: row.text }))), undefined, 'cancellation with a reason is not memory deletion')
  assert.equal(await detector.detect('不要忘记签到'), undefined, 'negative reminder is not memory deletion')
  assert.equal((await detector.detect('请你忘掉我关于香菜的偏好'))?.kind, 'forget', 'genuine memory deletion remains available')
  const cancelled: string[] = []
  const ports = { resolve: createOpenAiReminderResolver({ fetchImpl: measuredFetch }),
    create: async () => { throw new Error('unexpected create') }, update: async () => false,
    cancel: async (row: PendingReminder) => { cancelled.push(row.id); return true } }
  const result = await runReminderTurn({ ...input, now, enabled: true }, ports)
  assert.deepEqual(cancelled, [sports.id], JSON.stringify(result))
  const draft = await chat([{ role: 'system', content: '你是苏沐薇，使用自然简短的中文回复用户。严格依据程序事实，不虚构操作结果。' },
    ...input.recent.map(row => ({ role: 'assistant', content: row.text })),
    { role: 'user', content: text }, { role: 'system', content: reminderFactText(result) }])
  const final = runReplyGuardChain({ replyText: draft, reminderResult: result })
  assert.equal(final.replyText, draft, 'natural model confirmation survives checking unchanged')
  assert.match(draft, /取消|撤掉|删掉/u)
  assert.doesNotMatch(draft, /新增\d|已有\d|提醒处理：|没找到.*记忆/u)
  const ambiguous = await ports.resolve({ ...input, recent: [], current: { ...input.current, text: '取消体育课那条提醒' },
    pending: [sports, { ...sports, id: 'fixture-other-sports', dueAt: sports.dueAt + 86400000 }] })
  assert.ok(ambiguous.ok && ambiguous.draft.kind === 'clarify', JSON.stringify(ambiguous))
  writeFileSync(`${output}/result.json`, JSON.stringify({ passed: true, requests, naturalReply: draft,
    database: 'none; in-memory fixture ports', realDeliveries: 0 }, null, 2))
  console.log(JSON.stringify({ passed: true, modelRequests: requests.length, naturalReply: draft, output }))
} catch (error) {
  writeFileSync(`${output}/result.json`, JSON.stringify({ passed: false, requests, error: String(error) }, null, 2))
  throw error
}
