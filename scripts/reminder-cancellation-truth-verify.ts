import assert from 'node:assert/strict'
import { detectByRule, createExplicitMemoryIntentDetector } from '../src/kernel/app/memory/intent-detector.ts'
import { asksToRemember } from '../src/kernel/app/memory/remember-request.ts'
import { readReminderDraft, runReminderTurn, reminderFactText, type PendingReminder, type ReminderResolutionInput } from '../src/kernel/app/reminder-turn.ts'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'
import { CheckedSpeechStream } from '../src/kernel/app/bridge/streaming-speech.ts'
import { createOpenAiReminderResolver } from '../src/infrastructure/model/openai-reminder-text.ts'
import { createExplicitMemoryTurnPort } from '../src/kernel/app/memory/explicit-turn.ts'

const text = '消掉体育课那条吧，反正那个时候我十有八九会往操场赶，也不太可能忘记签到'
for (const phrase of [text, '我不会忘记签到', '不太可能忘记', '不要忘记签到', '别忘记吃饭',
  '不要忘掉这件事', '我想知道“忘掉那条记忆”是什么意思', '你能忘掉那条记忆吗？']) {
  assert.notEqual(detectByRule(phrase)?.kind, 'forget', phrase)
}
assert.equal(asksToRemember(text), false)
for (const phrase of ['忘掉我关于香菜的偏好', '不要再记这件事了', '请你忘掉那条记忆', '把那条记忆删掉吧']) {
  assert.equal(detectByRule(phrase)?.kind, 'forget', phrase)
  assert.equal(asksToRemember(phrase), true, phrase)
}
let classified = ''
const detector = createExplicitMemoryIntentDetector({ classifier: { name: 'semantic-fixture', async classify(value) { classified = value; return undefined } } })
assert.equal(await detector.detect('忘掉我关于香菜的偏好'), undefined, 'a destructive keyword cannot override semantic none')
assert.equal(classified, '忘掉我关于香菜的偏好')
await detector.detect(text)
assert.equal(classified, text, 'the classifier receives the whole reason and negation')
const history = [{ actor: 'character' as const, text: '已设置大学体育的提醒。' }]
let classifiedContext: unknown
const contextualPort = createExplicitMemoryTurnPort({ service: { handle: async () => { throw new Error('unexpected memory write') } } as never,
  readIntentContext: async () => history,
  detector: createExplicitMemoryIntentDetector({ classifier: { name: 'context-fixture', async classify(_text, recent) { classifiedContext = recent; return undefined } } }) })
assert.equal(await contextualPort.handleTurn({ event: { id: 'fixture' as never, actorType: 'user', content: text },
  owner: { kind: 'character', id: 'fixture' }, speaker: { kind: 'user', id: 'fixture' } } as never), undefined)
assert.deepEqual(classifiedContext, history, 'the memory turn port forwards recent context before choosing a destructive intent')

const now = Date.parse('2026-10-25T23:17:00+08:00')
const pending = [
  { id: 'math', text: '高等数学A(I)：上课前记得签到。', dueAt: now + 3600000, sourceRefs: [] },
  { id: 'sports', text: '大学体育(I)：大学体育(I)上课前记得签到。', dueAt: now + 7200000, sourceRefs: [] },
]
const input: ReminderResolutionInput = { current: { id: 'current', text, createdAt: now },
  recent: [{ id: 'listed', actor: 'character', text: '1. 高等数学A(I)\n2. 大学体育(I)', createdAt: now - 30000 }], pending }
let captured: any
const resolver = createOpenAiReminderResolver({ env: { OPENAI_API_KEY: 'fixture' }, fetchImpl: async (_url, init) => {
  captured = JSON.parse(String(init?.body))
  return Response.json({ choices: [{ message: { content: JSON.stringify({ kind: 'cancel', targetIntentId: 'sports' }) } }] })
} })
const cancelled: string[] = []
const ports = { resolve: resolver, create: async () => { throw new Error('unexpected create') }, update: async () => false,
  cancel: async (target: PendingReminder) => { cancelled.push(target.id); return true } }
const result = await runReminderTurn({ ...input, now, enabled: true }, ports)
assert.deepEqual(cancelled, ['sports'])
assert.deepEqual(JSON.parse(captured.messages[1].content), input, 'the resolver receives both the last list and actual pending ids')
assert.equal(result.kind, 'planned')
assert.doesNotMatch(reminderFactText(result), /提醒处理：新增/u)
const replyText = '好，体育课那条提醒已经取消了。'
assert.equal(runReplyGuardChain({ replyText, reminderResult: result }).replyText, replyText)
assert.notEqual(runReplyGuardChain({ replyText: '好，高数那条提醒已经取消了。', reminderResult: result }).replyText,
  '好，高数那条提醒已经取消了。', 'a natural confirmation must not name the wrong course')
assert.notEqual(runReplyGuardChain({ replyText: '体育课还在，高数那条提醒已经取消了。', reminderResult: result }).replyText,
  '体育课还在，高数那条提醒已经取消了。', 'the cancelled target and completion must appear in the same clause')
assert.doesNotMatch(runReplyGuardChain({ replyText: '提醒已经设置好了。', reminderResult: result }).replyText, /设置好了/u)
assert.equal(readReminderDraft({ kind: 'cancel', targetIntentId: 'sports', text: 'extra' }), undefined)
assert.equal(readReminderDraft({ kind: 'cancel', targetIntentId: '' }), undefined)
const refused = await runReminderTurn({ ...input, now, enabled: true }, { ...ports,
  resolve: async () => ({ ok: true, draft: readReminderDraft({ kind: 'cancel', targetIntentId: 'other-owner' })! }) })
assert.equal(refused.kind, 'refused')
assert.deepEqual(cancelled, ['sports'])

const failure = { kind: 'failed' as const, code: 'invalid_output', message: '这次提醒处理失败；已有提醒的排期和内容未改动，本轮尚未确认更新。' }
assert.equal(runReplyGuardChain({ replyText: '已取消体育课提醒。', reminderResult: failure }).replyText, failure.message)
assert.equal(runReplyGuardChain({ replyText: '我没找到你说的那条记忆，所以什么都没改。', reminderResult: failure,
  memoryWriteResult: { kind: 'not_written', intent: 'forget', reason: 'target_not_found', summary: '' }, userAskedToRemember: true }).replyText, failure.message)
const conflict = await runReminderTurn({ ...input, now, enabled: true }, { ...ports, cancel: async () => false })
assert.equal(conflict.kind, 'planned')
assert.match(runReplyGuardChain({ replyText, reminderResult: conflict }).replyText, /没能取消/u)

for (const [receipt, draft, expected] of [[result, replyText, replyText], [conflict, replyText, '没能取消']] as const) {
  const emitted: string[] = []
  const stream = new CheckedSpeechStream({ replyId: 'test', traceId: 'test', facts: { reminderResult: receipt }, emit: packet => emitted.push(packet.segment.text) })
  stream.push(draft)
  assert.equal(emitted.length, 0, 'batch speech waits for result validation')
  const final = stream.finish(draft)
  assert.ok(final.outcome.replyText.includes(expected))
  if (receipt === result) assert.equal(final.outcome.replyText, replyText, 'no receipt appended after a valid natural confirmation')
}
console.log('Reminder cancellation: negation, semantic authority, context, closed single cancel, target scope, natural replies, failure priority and checked speech PASS (zero model requests)')
