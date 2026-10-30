import assert from 'node:assert/strict'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'
import { CheckedSpeechStream } from '../src/kernel/app/bridge/streaming-speech.ts'
import { reminderFactText, type ReminderTurnResult } from '../src/kernel/app/reminder-turn.ts'
import { renderGoalFactBlock } from '../src/kernel/context/goal-sections.ts'

// These are proposed replies, not assertions that an operation actually happened.
const replies = [
  '你之前交代的我记住了。课表以后可以直接查。',
  '我没说提醒已经设置好了，只是在解释课表怎么查看。',
  '课表你不用再截图。我发文字就行。',
  '你问的是“说定了”是什么意思？',
  '嗯。记下了。',
]
for (const replyText of replies) {
  const result = runReplyGuardChain({ replyText, reminderResult: { kind: 'none' },
    goalWriteReality: { acceptedEventTypes: [], eventsCommitted: 0 } })
  assert.equal(result.replyText, replyText)
  assert.equal(result.corrected.commitmentTruth, false)
}
const failed = { kind: 'failed' as const, code: 'reminder_write_failed', message: '这次提醒未能保存。' }
const cancelled: ReminderTurnResult = { kind: 'planned', code: 'reminder_plan_result', sourceRefs: ['fixture'],
  message: '体育课提醒已取消。', items: [{ operation: 'cancel', status: 'cancelled', id: 'sports', text: '大学体育(I)：签到。' }] }
for (const [reminderResult, replyText] of [
  [cancelled, '好啦，那条体育签到就不催你了。'],
  [failed, '刚才没存成，我知道你已经讲清楚了。'],
] as const) {
  assert.equal(runReplyGuardChain({ replyText, reminderResult }).replyText, replyText)
  const packets: string[] = []
  const stream = new CheckedSpeechStream({ replyId: 'fixture', traceId: 'fixture', facts: { reminderResult },
    emit: packet => packets.push(packet.segment.text) })
  const raw = `<lg-speech>${JSON.stringify({ segments: [{ text: replyText, cue: 'natural' }] })}</lg-speech>`
  stream.push(raw)
  const result = stream.finish(raw)
  assert.equal(result.outcome.replyText, replyText)
  assert.equal(packets.join(''), replyText, 'streaming must not append an operation receipt')
}
assert.match(reminderFactText(failed), /failed|未能保存/u)
assert.match(reminderFactText(cancelled), /cancelled/u)
assert.match(renderGoalFactBlock({ outcome: 'failed', operation: 'none', rejectionCodes: ['timeout'] }), /失败|timeout/u)
console.log('Reply language: model text preserved, normal/streaming agree, execution facts retained; zero model requests, no database')
