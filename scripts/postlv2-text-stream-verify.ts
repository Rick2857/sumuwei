import assert from 'node:assert/strict'
import { ChatStreamError, readChatStream } from '../src/providers/chat-stream.ts'
import { SpeechStreamDecoder, CheckedSpeechStream } from '../src/kernel/app/bridge/streaming-speech.ts'
import { sessionHost, TurnCancellationRegistry } from '../src/infrastructure/bridge/turn-bridge-transport.ts'
import { TurnBridge, handleBridgeMessage, type BridgeWireResponse } from '../src/kernel/app/bridge/turn-bridge.ts'
import { VoiceDeliveryLedger } from '../src/kernel/app/bridge/voice-delivery-ledger.ts'
import type { SpeechExpression } from '../src/kernel/contracts/expressive-speech.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { ModelType } from '@elizaos/core'
import { asActionId, asTraceId } from '../src/kernel/contracts/ids.ts'
import { withoutAppendices } from '../src/kernel/contracts/expressive-speech.ts'

const envelope = '<lg-speech>{"segments":[{"text":"第一句。","cue":"natural"},{"text":"第二句。","cue":"firm"}]}</lg-speech>'
const decoder = new SpeechStreamDecoder()
const firstEnd = envelope.indexOf('},{') + 1
assert.equal(decoder.push(envelope.slice(0, firstEnd - 1)).length, 0)
assert.deepEqual(decoder.push(envelope.slice(firstEnd - 1, firstEnd)), [{ text: '第一句。', cue: 'natural' }])
assert.deepEqual(decoder.push(envelope.slice(firstEnd)), [{ text: '第二句。', cue: 'firm' }])
decoder.finish(envelope)

const wrapped = new SpeechStreamDecoder()
assert.equal(wrapped.push('<response><thought>引用 <lg-speech> 不应播出</thought><text>').length, 0)
assert.equal(wrapped.push(envelope).length, 2)
wrapped.push('</text></response>')
wrapped.finish(envelope)
const escaped = new SpeechStreamDecoder()
const escapedText = '<lg-speech>' + JSON.stringify({ segments: [{ text: '引号 " 与反斜线 \\ 都保留。', cue: 'natural' }] }) + '</lg-speech>'
const pieces = [...escapedText].flatMap(char => escaped.push(char))
assert.equal(pieces[0]?.text, '引号 " 与反斜线 \\ 都保留。')
escaped.finish(escapedText)
assert.throws(() => decoder.push('extra'))

const emitted: string[] = []
const checked = new CheckedSpeechStream({
  replyId: 'cev:char:conv:2', traceId: 'trc:stream', facts: {},
  emit: packet => emitted.push(packet.segment.text),
})
checked.push(envelope.slice(0, firstEnd))
assert.deepEqual(emitted, ['第一句。'])
checked.push(envelope.slice(firstEnd))
const completed = checked.finish(envelope)
assert.equal(completed.outcome.replyText, '第一句。第二句。')
assert.deepEqual(completed.expression.segments.map(s => s.segmentId), ['cev:char:conv:2#0', 'cev:char:conv:2#1'])
assert.equal(completed.expression.segments[1]?.cue, 'firm')

const safePrefix = '<lg-speech>{"segments":[{"text":"先说明一下。","cue":"firm"},'
const badClaim = '{"text":"我已经记住了。","cue":"playful"}]}</lg-speech>'
const guardedPackets: string[] = []
const guarded = new CheckedSpeechStream({ replyId: 'cev:guard:conv:2', traceId: 'trc:guard',
  facts: { memoryWriteResult: { kind: 'not_written', intent: 'remember', reason: 'persistence_failed', summary: 'synthetic failure' } },
  emit: packet => guardedPackets.push(packet.segment.text),
})
guarded.push(safePrefix)
assert.deepEqual(guardedPackets, ['先说明一下。'])
guarded.push(badClaim)
const rewritten = guarded.finish(safePrefix + badClaim)
assert.equal(rewritten.expression.segments[0].cue, 'firm')
assert.ok(rewritten.expression.segments.slice(1).every(segment => segment.cue === 'natural'))
assert.ok(!rewritten.outcome.replyText.includes('我已经记住了'))
assert.equal(rewritten.expression.fallback, 'guard_rewrite')
assert.ok(rewritten.outcome.corrected.memoryTruth)
assert.ok(rewritten.outcome.markers.memoryTruth.length > 0)
assert.equal(rewritten.outcome.reports.find(report => report.name === 'memory_truth')?.state, 'triggered')
assert.equal(rewritten.expression.segments.map(segment => segment.text).join(''), rewritten.outcome.replyText)

const partial = new CheckedSpeechStream({ replyId: 'cev:partial:conv:2', traceId: 'trc:partial', facts: {}, emit: () => {} })
partial.push(safePrefix)
partial.push('{"text":"残缺内容')
assert.throws(() => partial.finish(safePrefix + '{"text":"残缺内容'))
assert.equal(partial.snapshot().outcome.replyText, '先说明一下。')
const unfinished = new CheckedSpeechStream({ replyId: 'cev:tail:conv:2', traceId: 'trc:tail', facts: {}, emit: () => {} })
unfinished.push('<lg-speech>{"segments":[{"text":"不完整","cue":"firm"},')
assert.equal(unfinished.segments.length, 0)
unfinished.push('{"text":"的句子。","cue":"natural"}]}</lg-speech>')
assert.equal(unfinished.segments[0]?.text, '不完整的句子。')
assert.equal(unfinished.segments[0]?.cue, 'natural')

// Program sources appear once in the record, and never in emitted speech.
const source = { kind: 'external_evidence' as const, id: 'ev:fixture', provider: 'fixture',
  sourceUri: 'https://example.com/fixture', title: 'Synthetic source', snippet: 'Synthetic evidence',
  retrievedAt: 1, contentFingerprint: 'a'.repeat(64), citationLabel: 'E1' }
const sourcedSpeech: string[] = []
const sourced = new CheckedSpeechStream({ replyId: 'cev:source:conv:2', traceId: 'trc:source', facts: {
  actionResults: [{ kind: 'executed', result: {
    actionId: asActionId('act:source'), traceId: asTraceId('trc:source'), capability: 'web.search',
    operation: 'search', accepted: true, executed: true, status: 'success',
  } }],
  externalEvidenceInContext: { selected: [source], selectedEvidenceIds: [source.id],
    droppedByContextBudget: false, droppedByContextBudgetCount: 0,
    intendedSelectedIds: [source.id], droppedByBudget: 0, bundleAttached: true },
}, emit: packet => sourcedSpeech.push(packet.segment.text) })
const sourcedEnvelope = '<lg-speech>{"segments":[{"text":"第一句[E1]。第二句[E99]。","cue":"natural"}]}</lg-speech>'
sourced.push(sourcedEnvelope)
assert.equal(sourcedSpeech.length, 2)
assert.ok(sourcedSpeech.every(text => !text.includes('[E') && !text.includes(source.sourceUri)))
const sourcedResult = sourced.finish(sourcedEnvelope)
assert.equal(sourcedResult.outcome.replyText.split(source.sourceUri).length - 1, 1)
assert.equal(withoutAppendices(sourcedResult.outcome.replyText, [sourcedResult.outcome.evidenceAppendix]), sourcedSpeech.join(''))
assert.deepEqual(sourcedResult.outcome.markers.strippedCitationLabels, ['E1', 'E99'])

// Actual byte-stream parsing: do not mistake reasoning, heartbeat or usage for speech.
/*
 * ⚠️ ★ 2026-10-11：这里的 SSE 必须带上**真实端点的形状** —— 开了
 * `stream_options.include_usage` 之后，**除最后一块之外每一个 chunk 的 `usage` 都是 `null`**。
 * 原来这个夹具不带 usage 字段，于是漏掉了真机上那个
 * `TypeError: Cannot read properties of null (reading 'prompt_tokens')`
 * （皮套入口每轮都在首句之前失败，2026-10-10 23:32 起）。
 */
let release!: () => void
const held = new Promise<void>(resolve => { release = resolve })
let firstDelta!: () => void
const observed = new Promise<void>(resolve => { firstDelta = resolve })
const bytes = new TextEncoder()
const response = new Response(new ReadableStream<Uint8Array>({
  async start(controller) {
    controller.enqueue(bytes.encode(': heartbeat\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"不能播"}}],"usage":null}\r\n\r\n'))
    const event = bytes.encode('data: {"choices":[{"delta":{"content":"你好。"}}],"usage":null}\n\n')
    for (const byte of event) controller.enqueue(new Uint8Array([byte]))
    await held
    controller.enqueue(bytes.encode(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":null}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,' +
        '"completion_tokens_details":{"reasoning_tokens":0}}}\n\ndata: [DONE]\n\n'
    ))
    controller.close()
  },
}))
const deltas: string[] = []
const usageReadings: { promptTokens: number | null; completionTokens: number | null; reasoningTokens: number | null }[] = []
const reading = readChatStream(response, delta => { deltas.push(delta); firstDelta() }, value => { usageReadings.push(value) })
await observed
assert.deepEqual(deltas, ['你好。'])
release()
assert.equal(await reading, '你好。')
// `usage: null` 的块既**不得**抛错，也不得被当成读数；只有最后那块对象才算数
assert.deepEqual(usageReadings, [{ promptTokens: 11, completionTokens: 3, reasoningTokens: 0 }])
await assert.rejects(readChatStream(new Response('data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n'), () => {}))
await assert.rejects(readChatStream(new Response('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'), () => {}))

/*
 * ★ 2026-10-11：三条**静默路径**必须具名（真机事故的第二个观测洞）。
 *
 * 实测（2026-10-10 23:32/23:33 与 2026-10-11 00:20，皮套入口同一形状三次）：
 * 抛出来的是 `TypeError`（读取层中断 / 严格 UTF-8 解码失败）——**不是**
 * `ChatStreamError` ⇒ 桥折成"首句前失败"、provider 一行日志都没有。
 * 现在它们各自有具名 code，并且把"已流出多少个字符"一起带出来。
 */
const failureOf = async (run: Promise<unknown>): Promise<ChatStreamError> => {
  let failure: unknown
  try {
    await run
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof ChatStreamError, `应为 ChatStreamError，实际：${String(failure)}`)
  return failure as ChatStreamError
}
// ① 读取层中断：undici 对端把流掐了（`TypeError: terminated`）
let pulls = 0
const interrupted = await failureOf(readChatStream(new Response(new ReadableStream<Uint8Array>({
  pull(controller) {
    pulls += 1
    if (pulls === 1) controller.enqueue(bytes.encode('data: {"choices":[{"delta":{"content":"半句。"}}]}\n\n'))
    else controller.error(new TypeError('terminated'))
  },
})), () => {}))
assert.equal(interrupted.code, 'model_stream_read_failed')
assert.equal(interrupted.message, 'terminated', 'message 必须原样保留（重试分类按它判瞬态）')
assert.equal(interrupted.streamedChars, 3, '失败时也要能回答"流出了多少正文"')
// ② 严格 UTF-8 解码失败：非法字节（立即抛）与**末尾半截多字节**（flush 时抛，真实形态）
const invalidByte = await failureOf(readChatStream(new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([0xff, 0xfe]))
    controller.close()
  },
})), () => {}))
assert.equal(invalidByte.code, 'model_stream_utf8_invalid')
const truncatedChar = await failureOf(readChatStream(new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    /* `0xe6 0x97` 是「晚」的前两字节：流在这里被掐断 ⇒ flush 时才报非法 */
    controller.enqueue(new Uint8Array([0xe6, 0x97]))
    controller.close()
  },
})), () => {}))
assert.equal(truncatedChar.code, 'model_stream_utf8_invalid')
// ③ 载荷不是 JSON —— 且 message **不得**携带载荷片段（正文纪律）
const badPayload = await failureOf(readChatStream(new Response('data: 这不是 JSON\n\n'), () => {}))
assert.equal(badPayload.code, 'model_stream_bad_payload')
assert.equal(badPayload.message, '流式载荷不是合法 JSON（片段不入日志）')

// Exercise the real provider handler, including the request body and retry boundary.
const originalFetch = globalThis.fetch
let calls = 0
const abort = new AbortController()
globalThis.fetch = async (_input, init) => {
  calls += 1
  assert.equal(JSON.parse(String(init?.body)).stream, true)
  assert.equal(init?.signal, abort.signal)
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.encode('data: {"choices":[{"delta":{"content":"正文。"}}]}\n\n')) },
    pull(controller) { controller.error(new Error('fetch failed')) },
  }))
}
try {
  const handler = openAiCompatiblePlugin.models![ModelType.TEXT_LARGE] as Function
  const runtime = { character: {}, getSetting: (key: string) => key === 'OPENAI_API_KEY' ? 'offline-only' : undefined,
    logger: { debug() {}, warn() {} } }
  const output: string[] = []
  await assert.rejects(handler(runtime, { prompt: 'offline probe', signal: abort.signal,
    onTextDelta: (text: string) => output.push(text) }), /fetch failed/)
  assert.deepEqual(output, ['正文。'])
  assert.equal(calls, 1, 'a partial stream must never replay its checked prefix through retry')
} finally { globalThis.fetch = originalFetch }

// The real production host + bridge open the delivery identity before the final result.
const ledger = new VoiceDeliveryLedger()
const registry = new TurnCancellationRegistry()
const packets: BridgeWireResponse[] = []
let endTurn!: () => void
const pendingTurn = new Promise<void>(resolve => { endTurn = resolve })
let firstSentence!: () => void
const early = new Promise<void>(resolve => { firstSentence = resolve })
let identity: { replyId: string; traceId: string; domainEventIds: string[]; expression: SpeechExpression; streamStatus: 'completed' | 'cancelled' } | undefined
const host = sessionHost({ characterId: 'char', conversationId: 'conv', lastTurnIdentity: () => identity,
  async send(_text, streaming) {
    assert.ok(streaming)
    streaming.onModelStart?.()
    const checker = new CheckedSpeechStream({ replyId: 'cev:char:conv:2', traceId: 'trc:live', facts: {},
      emit: streaming.onSpeechSegment })
    checker.push(safePrefix)
    firstSentence()
    await pendingTurn
    if (!streaming.signal?.aborted) checker.push('{"text":"后续句。","cue":"natural"}]}</lg-speech>')
    const checked = checker.snapshot()
    identity = { replyId: checked.expression.replyId, traceId: 'trc:live', domainEventIds: [],
      expression: checked.expression, streamStatus: streaming.signal?.aborted ? 'cancelled' : 'completed' }
    return checked.outcome.replyText
  },
}, { delivery: ledger, cancellation: registry })
const bridge = new TurnBridge({ host })
bridge.setOutputSink(packet => packets.push(packet))
const turn = handleBridgeMessage(bridge, { kind: 'SUBMIT_TURN', requestId: 'r-stream', userText: '你好', streamSpeech: true })
await early
assert.equal(packets.length, 1)
assert.equal(packets[0].kind, 'SPEECH_SEGMENT')
const segmentId = packets[0].speech!.segment.segmentId
const synthesis = await handleBridgeMessage(bridge, { kind: 'REPORT_SYNTHESIZED', requestId: 's-first', segmentId, audioId: 'audio:first' })
assert.equal(synthesis.synthesis?.accepted, true, 'first-sentence audio has a valid delivery entry before final text')
const cancelled = await handleBridgeMessage(bridge, { kind: 'CANCEL_TURN', requestId: 'r-stream', reason: 'offline probe' })
assert.equal(cancelled.cancel?.stoppedBeforeModel, false)
assert.ok(registry.signalFor('r-stream').aborted)
endTurn()
const terminal = await turn
assert.equal(terminal.outcome, 'failed')
assert.equal(terminal.streamStatus, 'cancelled')
assert.equal(terminal.replyId, packets[0].speech?.replyId)
assert.equal(terminal.expression?.segments.length, 1)
assert.equal(packets.length, 1, 'cancelled tail cannot leak as another sentence')
const repeated = await handleBridgeMessage(bridge, { kind: 'SUBMIT_TURN', requestId: 'r-stream', userText: '你好', streamSpeech: true })
assert.equal(repeated.streamStatus, 'cancelled')
assert.equal(packets.length, 1, 'cached completion cannot replay speech packets')
console.log('PASS: early checked sentences, late rewrite, partial failure, UTF-8 SSE, provider retry boundary, delivery identity, cancellation and three named silent-path failures')
