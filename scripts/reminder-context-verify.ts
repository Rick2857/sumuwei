import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readReminderDraft, runReminderTurn, type ReminderDraft, type ReminderResolution, type PendingReminder } from '../src/kernel/app/reminder-turn.ts'
import { createOpenAiReminderResolver } from '../src/infrastructure/model/openai-reminder-text.ts'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'
import { runGoalTurn, type GoalTurnPorts } from '../src/kernel/app/goal/turn.ts'
import { renderGoalFactBlock } from '../src/kernel/context/goal-sections.ts'
import { RuleBasedContentExtractor, LlmContentExtractor, extractFreeTextValueRaw } from '../src/kernel/app/memory/content-extractor.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { MAX_NOTIFICATION_TEXT_CODEPOINTS } from '../src/kernel/contracts/notification.ts'
import { CheckedSpeechStream } from '../src/kernel/app/bridge/streaming-speech.ts'

const now = Date.UTC(2026, 9, 6, 18, 6, 47)
const source = { id: 'source', text: '6min后发消息叫我拔插头', createdAt: now }
const writes: unknown[] = []
let draft: ReminderResolution = { ok: true, draft: { kind: 'create', timeSourceId: source.id, text: '记得拔插头。' } }
const pending: PendingReminder[] = []
const ports = {
  resolve: async () => draft,
  create: async (input: { text: string; dueAt: number; sourceRefs: readonly string[] }) => {
    writes.push(input); pending.push({ id: 'reminder', ...input }); return { ...input, id: 'reminder', created: true }
  },
  update: async (target: PendingReminder, text: string, refs: readonly string[]) => {
    writes.push({ update: target.id, text, refs }); target.text = text; return true
  },
}
const call = (text: string, enabled = true) => runReminderTurn({ current: { id: 'current', text, createdAt: now + 40_000 }, recent: [source], pending, now: now + 40_000, enabled }, ports)
const created = await call(source.text)
assert.equal(created.kind, 'scheduled')
assert.ok('dueAt' in created && created.dueAt === now + 360_000)
draft = { ok: true, draft: { kind: 'confirm', targetIntentId: 'reminder', text: '记得拔插头。' } }
const confirmed = await call('默认吧')
assert.equal(confirmed.kind, 'existing'); assert.equal(writes.length, 1)
draft = { ok: true, draft: { kind: 'update', targetIntentId: 'reminder', text: '记得拔插头。' } }
pending[0]!.text = '检查手机电量'
assert.equal((await call('对，拔插头')).kind, 'updated')
assert.equal(pending[0]!.dueAt, now + 360_000)
assert.equal(writes.length, 2)
draft = { ok: true, draft: { kind: 'update', targetIntentId: 'other-user', text: '记得拔插头。' } }
assert.equal((await call('对，关闭电脑')).kind, 'failed'); assert.equal(writes.length, 2)
draft = { ok: true, draft: { kind: 'create', timeSourceId: 'forged', text: '记得拔插头。' } }
assert.equal((await call(source.text)).kind, 'failed'); assert.equal(writes.length, 2)
draft = { ok: true, draft: { kind: 'create', timeSourceId: source.id, text: '记得拔插头。' } }
assert.equal((await call(source.text, false)).kind, 'refused'); assert.equal(writes.length, 2)
draft = { ok: false, failure: 'timeout' }
const timeout = await call(source.text)
assert.equal(timeout.kind, 'failed'); assert.equal(writes.length, 2)
assert.match(runReplyGuardChain({ replyText: '记下了，到点发消息', reminderResult: timeout }).replyText, /超时/u)
assert.match(runReplyGuardChain({ replyText: '这条没记，提醒什么？', reminderResult: created }).replyText, /已设置.*拔插头/u)
draft = { ok: true, draft: { kind: 'none' } }
const ordinary = await call('今天天气真好')
assert.equal(ordinary.kind, 'none'); assert.equal(writes.length, 2)
for (const bad of [{ kind: 'create', timeSourceId: source.id, text: '拔插头', dueAt: now }, { kind: 'update', targetIntentId: 'reminder', text: '' }, { kind: 'create', timeSourceId: source.id, text: '字'.repeat(MAX_NOTIFICATION_TEXT_CODEPOINTS + 1) }]) assert.equal(readReminderDraft(bad), undefined)
assert.ok(readReminderDraft({ kind: 'none' }))
const resolver = createOpenAiReminderResolver({ env: { OPENAI_API_KEY: 'fixture' }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"create","text":"拔插头","timeSourceId":"source","dueAt":123}' } }] })) })
assert.deepEqual(await resolver({ current: source, recent: [], pending: [] }), { ok: false, failure: 'invalid_output', diagnostic: 'schema_invalid' })

const owner = entityRef('character', 'character')
const speaker = entityRef('user', 'owner')
const extraction = { owner, speaker, text: '记得提醒我6min后手机将会充好电，给我发消息叫我拔一下插头' }
assert.equal(extractFreeTextValueRaw(extraction.text, '叫我'), '拔一下插头', '负控：裸抽取仍复现误写')
assert.equal(await new RuleBasedContentExtractor().extract(extraction), undefined)
assert.equal(await new LlmContentExtractor({ invokeModel: async () => '{"predicate":"preferred.address","value":"拔一下插头","type":"preference"}' }).extract(extraction), undefined)
for (const text of ['叫我 Alex 就行', '称呼我阿明', '可以叫我Amy']) {
  assert.equal((await new RuleBasedContentExtractor().extract({ ...extraction, text }))?.predicate, 'preferred.address')
}

const goalPorts: GoalTurnPorts = {
  candidates: { readCandidates: async () => ({ candidates: [], goals: [], maskedCount: 0 }) },
  writer: { commit: async () => { throw new Error('不应提交') } },
  passThrough: { validate: async () => { throw new Error('不应放行') } },
  completion: { conversation: { findEvents: async () => [] }, assistant: { findAssistantEvents: async () => [] }, actions: { findActions: async () => [] } },
}
const goalTimeout = await runGoalTurn({ characterId: 'character', currentInput: '记一下这个目标', sourceEventId: 'source', sourceQualification: 'ESTABLISHED', withdrawnEventIds: new Set(), now,
  provider: { name: 'fixture', version: '1', call: async () => ({ operation: 'none' }) }, runtime: { now: () => now, withDeadline: async () => ({ kind: 'timeout' as const }) },
}, goalPorts)
assert.equal(goalTimeout.fact?.outcome, 'failed')
assert.match(renderGoalFactBlock(goalTimeout.fact), /timeout/u)
assert.match(runReplyGuardChain({ replyText: '你没说清，再说一遍', goalFact: goalTimeout.fact }).replyText, /超时/u)
const clarify = renderGoalFactBlock({ outcome: 'clarify', operation: 'clarify', clarifyReason: '需要明确完成判据' })
assert.ok(clarify.includes('需要明确完成判据') && !clarify.includes('含义不唯一'))
assert.ok(!runReplyGuardChain({ replyText: '行。记这条：已经答应了' }).replyText.includes('再说一遍'))
assert.equal(runReplyGuardChain({ replyText: '你好。' }).replyText, '你好。')
const speech: string[] = []
const stream = new CheckedSpeechStream({ replyId: 'reminder-speech', traceId: 'fixture', facts: { reminderResult: created }, emit: packet => speech.push(packet.segment.text) })
const envelope = '<lg-speech>{"segments":[{"text":"六分钟后通过QQ提醒你拔插头。","cue":"natural"},{"text":"拔完就睡吧。","cue":"natural"}]}</lg-speech>'
stream.push(envelope)
assert.equal(stream.finish(envelope).outcome.replyText, '六分钟后通过QQ提醒你拔插头。拔完就睡吧。')
assert.deepEqual(speech, ['六分钟后通过QQ提醒你拔插头。', '拔完就睡吧。'])
const failedSpeech: string[] = []
const failedStream = new CheckedSpeechStream({ replyId: 'failed-speech', traceId: 'fixture', facts: { reminderResult: timeout }, emit: packet => failedSpeech.push(packet.segment.text) })
const failureEnvelope = '<lg-speech>{"segments":[{"text":"嗯。","cue":"natural"},{"text":"已经设置了。","cue":"natural"}]}</lg-speech>'
failedStream.push(failureEnvelope)
const failureResult = failedStream.finish(failureEnvelope)
assert.equal(failureResult.outcome.replyText, failedSpeech.join(''))
assert.equal(failedSpeech.filter(text => text.includes('超时')).length, 1)
assert.ok(!failureResult.outcome.replyText.includes('已经设置了'))

const output = resolve('artifacts/post-lv2/reminder-context-repair/component')
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'evidence.json'), JSON.stringify({ passed: true, created, confirmed, timeout, writes, goalTimeout, clarify }, null, 2))
console.log('提醒指代、来源/目标负控、关闭/超时、回复真相、称呼误写、目标失败：PASS')
