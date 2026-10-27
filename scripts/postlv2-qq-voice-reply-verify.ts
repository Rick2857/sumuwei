/**
 * post-Lv2 / P1 门 —— **QQ 出站媒介选择**（同轮文字 / 语音）。
 *
 * ============================================================================
 *  这道门回答什么（零真实模型 · 零真实 QQ · 不打开数据库）
 * ============================================================================
 * ```text
 * ① 契约：只解码**完整封套**；坏封套**整轮失败**（绝不把协议念给用户）
 * ② 缺省等价：开关关 / 非 QQ / 无 media ⇒ 旧行为逐字不变（wire 上没有 media 键）
 * ③ section：只在 QQ 且语音可用时挂；内容含封套格式与 60 s 上限
 * ④ 桥 → 传输 → 外壳：她的选择真的送到外壳（不是写在核心里的死字段）
 * ⑤ 外壳分支：text 零合成；voice 合成 + record；失败/超限/未知的**兜底规则**
 * ⑥ 边界：WAV 结构、4 MiB、60 s、`base64://`，以及"结果不明不重发"
 * ```
 *
 * ⚠️ **控模型输出**（固定 host）⇒ 本门只证"机制与接线"，**不**主张她真的会自主选择；
 *    那也是计划 P3 才用真实模型观察的事。
 * ⚠️ OneBot 是本地 `ws` 夹具（不是真实后端）：**不**证明固定 LLBot/PMHQ 镜像能发语音。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { OneBotPrivateClient } from '../src/infrastructure/qq/onebot-private-client.ts'
import { readQqPrivateConfig } from '../src/infrastructure/qq/private-config.ts'
import {
  inspectWav, oneBotRecordFileUrl, QQ_VOICE_LIMITS, wavDeliveryProblem,
  type QqVoiceOutput, type QqVoiceSynthesizer,
} from '../src/infrastructure/qq/voice-reply.ts'
import {
  decodeQqMediaReply, qqMediaSelectionOf, renderQqMediaEnvelope, resolveQqMediaReply,
  QQ_MEDIA_ENVELOPE_VERSION, QQ_MEDIA_TEXT_MAX_CHARS, type QqMediaSelection,
} from '../src/kernel/contracts/qq-media-reply.ts'
import { createQqMediaReplyProvider } from '../src/kernel/context/qq-media-reply-section.ts'
import { composePromptFromPacket } from '../src/kernel/context/sections.ts'
import type { ContextPacket } from '../src/kernel/contracts/context.ts'
import { sessionHost } from '../src/infrastructure/bridge/turn-bridge-transport.ts'
import { handleBridgeMessage, TurnBridge } from '../src/kernel/app/bridge/turn-bridge.ts'

const ROOT = resolve(import.meta.dirname, '..')
const checks: string[] = []
const check = async (name: string, run: () => void | Promise<void>): Promise<void> => { await run(); checks.push(name) }
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/* ------------------------------------------------------------------------- */
/* WAV 夹具（结构合法即可；内容不是音频判据的一部分）                          */
/* ------------------------------------------------------------------------- */
function wavFixture(input: {
  sampleRateHz?: number
  channels?: number
  bitsPerSample?: number
  dataBytes?: number
  audioFormat?: number
} = {}): Uint8Array {
  const sampleRateHz = input.sampleRateHz ?? 24_000
  const channels = input.channels ?? 1
  const bitsPerSample = input.bitsPerSample ?? 16
  const dataBytes = input.dataBytes ?? sampleRateHz * channels * (bitsPerSample / 8) * 1
  const audioFormat = input.audioFormat ?? 1
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const write4 = (offset: number, text: string): void => { for (let i = 0; i < 4; i++) bytes[offset + i] = text.charCodeAt(i) }
  write4(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write4(8, 'WAVE')
  write4(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, audioFormat, true); view.setUint16(22, channels, true)
  view.setUint32(24, sampleRateHz, true)
  view.setUint32(28, sampleRateHz * channels * (bitsPerSample / 8), true)
  view.setUint16(32, channels * (bitsPerSample / 8), true); view.setUint16(34, bitsPerSample, true)
  write4(36, 'data'); view.setUint32(40, dataBytes, true)
  return bytes
}

/* ------------------------------------------------------------------------- */
/* ① 契约：完整封套 / 坏封套 / 缺省等价                                        */
/* ------------------------------------------------------------------------- */
const invalidEnvelope = (body: string, code: string): void => {
  const raw = `<lg-qq-media>${body}</lg-qq-media>`
  assert.throws(() => decodeQqMediaReply(raw), (error: Error & { code?: string }) => error.code === code, code)
}

await check('valid voice envelope decodes with exact body', () => {
  const raw = renderQqMediaEnvelope('voice', '我没说不去。这是第 3 步，不是第 2 步。')
  const draft = decodeQqMediaReply(raw)
  assert.deepEqual(draft, { version: QQ_MEDIA_ENVELOPE_VERSION, mode: 'voice', text: '我没说不去。这是第 3 步，不是第 2 步。' })
})
await check('valid text envelope decodes', () => {
  const draft = decodeQqMediaReply(renderQqMediaEnvelope('text', '好的。'))
  assert.equal(draft?.mode, 'text'); assert.equal(draft?.text, '好的。')
})
await check('no envelope is backward-compatible text', () => {
  assert.equal(decodeQqMediaReply('就是一段普通回复。'), undefined)
})
await check('broken JSON fails closed', () => {
  invalidEnvelope('', 'qq_media_bad_json')
})
await check('missing field fails closed', () => {
  invalidEnvelope('{"version":1,"mode":"voice"}', 'qq_media_missing_field')
})
await check('extra field fails closed (no expression escapes)', () => {
  invalidEnvelope('{"version":1,"mode":"voice","text":"好","call":"rm"}', 'qq_media_unexpected_field')
})
await check('wrong version fails closed', () => {
  invalidEnvelope('{"version":2,"mode":"voice","text":"好"}', 'qq_media_bad_version')
})
await check('unknown mode fails closed', () => {
  invalidEnvelope('{"version":1,"mode":"audio","text":"好"}', 'qq_media_bad_mode')
})
await check('empty text fails closed', () => {
  invalidEnvelope('{"version":1,"mode":"voice","text":"   "}', 'qq_media_empty_text')
})
await check('too-long text fails closed', () => {
  const text = 'a'.repeat(QQ_MEDIA_TEXT_MAX_CHARS + 1)
  invalidEnvelope(JSON.stringify({ version: 1, mode: 'text', text }), 'qq_media_text_too_long')
})
await check('prose before/after envelope fails closed', () => {
  const good = renderQqMediaEnvelope('voice', '好')
  assert.throws(() => decodeQqMediaReply(`我先说一句。${good}`), (e: { code?: string }) => e.code === 'qq_media_envelope_not_whole')
  assert.throws(() => decodeQqMediaReply(`${good}后记。`), (e: { code?: string }) => e.code === 'qq_media_envelope_not_whole')
})
await check('mentioning the tag without a whole envelope fails closed (never leaks protocol)', () => {
  assert.throws(() => decodeQqMediaReply('她说 <lg-qq-media> 这种标记不能用。'), (e: { code?: string }) => e.code === 'qq_media_envelope_not_whole')
})
await check('nested envelope fails closed', () => {
  const inner = renderQqMediaEnvelope('text', 'x')
  assert.throws(() => decodeQqMediaReply(`<lg-qq-media>${JSON.stringify({ version: 1, mode: 'text', text: inner })}</lg-qq-media>`),
    (e: { code?: string }) => e.code === 'qq_media_envelope_nested')
})
await check('resolve: disabled / unavailable / non-qq leave the raw text untouched', () => {
  const raw = renderQqMediaEnvelope('voice', '好')
  assert.deepEqual(resolveQqMediaReply({ raw, enabled: false, voiceAvailable: true }), { text: raw })
  assert.deepEqual(resolveQqMediaReply({ raw, enabled: true, voiceAvailable: false }), { text: raw })
})
await check('resolve: enabled + envelope => body text + selection (no protocol leak)', () => {
  const resolved = resolveQqMediaReply({ raw: renderQqMediaEnvelope('voice', '她说的正文。'), enabled: true, voiceAvailable: true })
  assert.equal(resolved.text, '她说的正文。')
  assert.deepEqual(resolved.media, { version: 1, mode: 'voice' })
})
await check('resolve: enabled + no envelope => text + missing_metadata (never claims she chose)', () => {
  const resolved = resolveQqMediaReply({ raw: '旧式正文。', enabled: true, voiceAvailable: true })
  assert.equal(resolved.text, '旧式正文。')
  assert.deepEqual(resolved.media, { version: 1, mode: 'text', fallback: 'missing_metadata' })
})
await check('wire media shape is validated closed', () => {
  assert.deepEqual(qqMediaSelectionOf({ version: 1, mode: 'voice' }), { version: 1, mode: 'voice' })
  assert.deepEqual(qqMediaSelectionOf({ version: 1, mode: 'text', fallback: 'missing_metadata' }), { version: 1, mode: 'text', fallback: 'missing_metadata' })
  assert.equal(qqMediaSelectionOf({ version: 1, mode: 'voice', target: '123' }), undefined)
  assert.equal(qqMediaSelectionOf({ version: 2, mode: 'voice' }), undefined)
  assert.equal(qqMediaSelectionOf({ version: 1, mode: 'audio' }), undefined)
  assert.equal(qqMediaSelectionOf(undefined), undefined)
})

/* ------------------------------------------------------------------------- */
/* ② section 与装配（结构判据 + 直接驱动 provider）                            */
/* ------------------------------------------------------------------------- */
await check('compiled QQ output requirements do not prohibit the required media envelope', async () => {
  const sections = await createQqMediaReplyProvider().provide({} as never)
  const packet = { text: sections[0].content, sections } as ContextPacket
  const prompt = composePromptFromPacket(packet, '苏沐薇')
  const output = prompt.slice(prompt.lastIndexOf('# 输出要求'))
  assert.ok(output.includes('<lg-qq-media>'))
  assert.ok(!output.includes('不要输出任何 XML 标签'))
  assert.ok(!output.includes('只输出你会说出口的话本身'))
})
await check('ordinary prompt stays byte-identical even when user quotes a media tag', () => {
  const text = '用户引用 <lg-qq-media> 并谈起语音，不是开启协议。'
  const prompt = composePromptFromPacket({ text, sections: [] } as unknown as ContextPacket, '苏沐薇')
  assert.equal(prompt, ['# 任务', '你是「苏沐薇」。按她此刻的状态与语气，回应对方刚刚说的话。', '',
    '<context>', text, '</context>', '', '# 输出要求', '只输出你会说出口的话本身。',
    '- 不要输出任何 XML 标签、字段名、"thought"、"actions" 之类的结构。', '- 不要复述上面 context 里的条目名或数值。',
    '- 不要解释你在做什么。', '- 直接开始说话。'].join('\n'))
})
await check('section only exists as an opt-in instruction with the envelope format', () => {
  const provider = createQqMediaReplyProvider()
  return provider.provide({} as never).then(sections => {
    assert.equal(sections.length, 1)
    const [section] = sections
    assert.equal(section.id, 'qq-media-reply')
    assert.equal(section.kind, 'instruction')
    assert.equal(section.droppable, false)
    assert.equal(section.priority, 85)
    assert.deepEqual(section.sourceRefs, ['qq-media@1'])
    for (const must of ['<lg-qq-media>', '"mode":"text"', '"mode"', 'voice', '60 秒', '4 MiB', '不要为了发语音']) {
      assert.ok(section.content.includes(must), must)
    }
  })
})
await check('gateway mount is gated by qqMediaReply.voiceAvailable (structural lock)', () => {
  const gateway = readFileSync(resolve(ROOT, 'src/kernel/app/turn-gateway.ts'), 'utf8')
  assert.ok(gateway.includes('createQqMediaReplyProvider'))
  assert.ok(gateway.includes("input.qqMediaReply !== undefined && input.qqMediaReply.voiceAvailable"))
})
await check('main.ts consumes both flags and only on the qq entry (structural lock)', () => {
  const main = readFileSync(resolve(ROOT, 'src/main.ts'), 'utf8')
  assert.ok(main.includes("this.entryKey === 'qq_private'"))
  assert.ok(main.includes('this.flags.qqVoiceReplyEnabled'))
  assert.ok(main.includes('this.flags.qqVoiceOutputEnabled'))
  assert.ok(main.includes('resolveQqMediaReply({ raw: call.text'))
  assert.ok(main.includes('qqMediaReply: { voiceAvailable: true,'))
  assert.ok(main.includes('media: qqMediaResolved.media'))
})
await check('flags default off and are reported in the startup line', () => {
  const flags = readFileSync(resolve(ROOT, 'src/kernel/app/flags.ts'), 'utf8')
  assert.ok(flags.includes("truthy(env.CHARACTER_QQ_VOICE_REPLY, false)"))
  assert.ok(flags.includes("truthy(env.CHARACTER_QQ_VOICE_OUTPUT, false)"))
  assert.ok(flags.includes("record('qq-voice-reply'"))
  assert.ok(flags.includes('record(`qq-voice-output`'))
})

/* ------------------------------------------------------------------------- */
/* ③ 桥 → 传输：她的选择必须真的走完这条链                                     */
/* ------------------------------------------------------------------------- */
const fakeSession = (media?: QqMediaSelection): Parameters<typeof sessionHost>[0] => ({
  characterId: 'character:offline-fixture',
  conversationId: 'dm-offline-fixture',
  async send() { return '她说的话。' },
  lastTurnIdentity() {
    return { replyId: 'reply:offline-1', traceId: 'trace:offline-1', domainEventIds: [], ...(media === undefined ? {} : { media }) }
  },
} as never)
const submitThroughBridge = async (media?: QqMediaSelection): Promise<Record<string, unknown>> => {
  const bridge = new TurnBridge({ host: sessionHost(fakeSession(media)) })
  return await handleBridgeMessage(bridge, { kind: 'SUBMIT_TURN', requestId: `turn-${media?.mode ?? 'none'}`, userText: '你好' }) as unknown as Record<string, unknown>
}
await check('bridge carries voice selection to the wire', async () => {
  const wire = await submitThroughBridge({ version: 1, mode: 'voice' })
  assert.deepEqual(wire.media, { version: 1, mode: 'voice' })
  assert.equal(wire.replyText, '她说的话。')
})
await check('bridge carries text + missing_metadata', async () => {
  const wire = await submitThroughBridge({ version: 1, mode: 'text', fallback: 'missing_metadata' })
  assert.deepEqual(wire.media, { version: 1, mode: 'text', fallback: 'missing_metadata' })
})
await check('no selection => wire has no media key at all (byte-shape equivalence)', async () => {
  const wire = await submitThroughBridge(undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(wire, 'media'), false)
  assert.equal(JSON.stringify(wire).includes('"media"'), false)
})

/* ------------------------------------------------------------------------- */
/* ④ WAV / Base64 边界                                                          */
/* ------------------------------------------------------------------------- */
await check('24 kHz mono PCM16 is accepted and inspected', () => {
  const inspection = inspectWav(wavFixture({ sampleRateHz: 24_000 }))
  assert.ok(inspection !== undefined)
  assert.equal(inspection.sampleRateHz, 24_000); assert.equal(inspection.channels, 1)
  assert.equal(inspection.bitsPerSample, 16); assert.equal(inspection.durationMs, 1000)
})
await check('16 kHz local-model output is also accepted (preference, not hard rule)', () => {
  assert.ok(inspectWav(wavFixture({ sampleRateHz: 16_000 })) !== undefined)
})
await check('non-WAV bytes, non-PCM format, 8-bit and 3 channels are rejected', () => {
  assert.equal(inspectWav(new TextEncoder().encode('not a wave file at all')), undefined)
  assert.equal(inspectWav(wavFixture({ audioFormat: 3 })), undefined)
  assert.equal(inspectWav(wavFixture({ bitsPerSample: 8 })), undefined)
  assert.equal(inspectWav(wavFixture({ channels: 3 })), undefined)
})
await check('delivery boundaries: empty / oversize / too long are named failures', () => {
  assert.equal(wavDeliveryProblem(new Uint8Array()), 'voice_audio_empty')
  const oversize = new Uint8Array(QQ_VOICE_LIMITS.maxAudioBytes + 1)
  assert.equal(wavDeliveryProblem(oversize), 'voice_audio_too_large')
  const tooLong = wavFixture({ sampleRateHz: 16_000, dataBytes: 16_000 * 2 * 62 })
  assert.equal(wavDeliveryProblem(tooLong), 'voice_audio_too_long')
})
await check('record file URL is base64:// and round-trips exactly', () => {
  const audio = wavFixture({ sampleRateHz: 24_000, dataBytes: 2400 })
  const url = oneBotRecordFileUrl(audio)
  assert.ok(url.startsWith('base64://'))
  const decoded = Buffer.from(url.slice('base64://'.length), 'base64')
  assert.equal(decoded.length, audio.byteLength)
  assert.deepEqual(new Uint8Array(decoded), audio)
})

/* ------------------------------------------------------------------------- */
/* ⑤ 外壳：本地 OneBot 夹具（零真实 QQ）                                       */
/* ------------------------------------------------------------------------- */
const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws') as {
  WebSocketServer: new (options: { noServer: true }) => {
    on: (event: string, handler: (connection: any) => void) => void
    emit: (event: string, connection: any) => void
    handleUpgrade: (request: unknown, socket: unknown, head: unknown, done: (connection: any) => void) => void
    clients: Set<any>
    close: (done: () => void) => void
  }
}
const httpServer = createServer()
const wsServer = new WebSocketServer({ noServer: true })
interface SentPacket { action: string; params: { user_id?: string; group_id?: string; message: { type: string; data: Record<string, unknown> }[] } }
let sentPackets: SentPacket[] = []
let peer: any
let nextMessageId = 1000
let loginId = '987654321'
let behavior: { rejectRecord?: boolean; missingMessageIdForRecord?: boolean; disconnectOnRecord?: boolean } = {}
httpServer.on('upgrade', (request, socket, head) => {
  wsServer.handleUpgrade(request, socket, head, (connection: any) => wsServer.emit('connection', connection))
})
wsServer.on('connection', (connection: any) => {
  peer = connection
  connection.on('message', (raw: Buffer) => {
    const packet = JSON.parse(raw.toString()) as SentPacket & { echo: string }
    if (packet.action === 'get_login_info') {
      connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: loginId }, echo: packet.echo }))
      return
    }
    if (packet.action === 'get_group_member_info') {
      connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: packet.params.user_id, group_id: packet.params.group_id }, echo: packet.echo }))
      return
    }
    sentPackets.push({ action: packet.action, params: packet.params })
    const isRecord = packet.params.message.length === 1 && packet.params.message[0]!.type === 'record'
    if (isRecord && behavior.disconnectOnRecord === true) { connection.terminate(); return }
    if (isRecord && behavior.rejectRecord === true) {
      connection.send(JSON.stringify({ status: 'failed', retcode: 100, data: null, echo: packet.echo }))
      return
    }
    if (isRecord && behavior.missingMessageIdForRecord === true) {
      connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: packet.echo }))
      return
    }
    connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: ++nextMessageId }, echo: packet.echo }))
  })
})
await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done))
const port = (httpServer.address() as { port: number }).port
const config = readQqPrivateConfig({
  QQ_OWNER_ID: '123456789', QQ_BOT_ID: loginId,
  QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${port}/`, QQ_ONEBOT_ACCESS_TOKEN: 'offline-voice-fixture-token-1234567890',
})
const groupConfig = readQqPrivateConfig({
  QQ_OWNER_ID: '123456789', QQ_BOT_ID: loginId, QQ_MULTI_USER_ENABLED: 'true', QQ_ALLOWED_GROUP_IDS: '777777',
  QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${port}/`, QQ_ONEBOT_ACCESS_TOKEN: 'offline-voice-fixture-token-1234567890',
})
const waitFor = async (test: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) { if (test()) return; await delay(10) }
  throw new Error(`fixture_timeout:${label}`)
}
interface ShellRun {
  events: { event: string; requestId?: string; reason?: string }[]
  sent: SentPacket[]
  synthesis: { text: string }[]
}
const runShell = async (input: {
  clientConfig?: typeof config
  media?: unknown
  mediaAbsent?: boolean
  voice?: QqVoiceOutput
  group?: boolean
  behavior?: typeof behavior
}): Promise<ShellRun> => {
  sentPackets = []; behavior = input.behavior ?? {}
  const events: ShellRun['events'] = []
  const synthesis: { text: string }[] = []
  const submit = async (request: { requestId: string }) => {
    return {
      kind: 'TURN_RESULT' as const, requestId: request.requestId, outcome: 'replied' as const,
      replyText: '这是要表达的正文。', delivery: 'generated' as const,
      ...(input.mediaAbsent === true ? {} : { media: input.media ?? { version: 1, mode: 'text' } }),
    }
  }
  const clientConfig = input.clientConfig ?? config
  const client = new OneBotPrivateClient(clientConfig, submit as never, (reading) => events.push(reading), input.voice)
  await client.connect()
  await client.drain()
  try {
    if (input.group === true) {
      peer!.send(JSON.stringify({
        post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: loginId,
        user_id: '123456789', group_id: '777777', sender: { user_id: '123456789' }, message_id: ++nextMessageId,
        message: [{ type: 'at', data: { qq: loginId } }, { type: 'text', data: { text: '在吗' } }],
      }))
    } else {
      peer!.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: loginId,
        user_id: '123456789', sender: { user_id: '123456789' }, message_id: ++nextMessageId,
        message: [{ type: 'text', data: { text: '在吗' } }],
      }))
    }
    await waitFor(() => events.some((event) => event.event.startsWith('qq_') && event.event !== 'qq_send_api_accepted')
      || events.some((event) => event.event === 'qq_send_api_accepted') || sentPackets.length > 0 || !client.connected, 'first-outcome')
    await client.drain()
    await delay(30)
    return { events, sent: [...sentPackets], synthesis }
  } finally {
    await client.close().catch(() => undefined)
  }
}
const voicePort = (audio: Uint8Array | (() => Uint8Array), record?: { text: string }[]): QqVoiceOutput => ({
  synthesizer: (() => ({
    async synthesize({ text }: { text: string }) {
      record?.push({ text })
      return { audio: typeof audio === 'function' ? audio() : audio, format: 'wav' as const }
    },
  }))() as QqVoiceSynthesizer,
})

try {
  await check('shell: text selection sends text and never synthesizes', async () => {
    let calls = 0
    const run = await runShell({
      media: { version: 1, mode: 'text' },
      voice: { synthesizer: { async synthesize() { calls += 1; return { audio: wavFixture(), format: 'wav' as const } } } },
    })
    assert.equal(calls, 0)
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'text')
    assert.equal(run.sent[0]!.params.message[0]!.data.text, '这是要表达的正文。')
  })
  await check('shell: voice selection synthesizes the final text and sends one record', async () => {
    const audio = wavFixture({ sampleRateHz: 24_000, dataBytes: 4800 })
    const seen: { text: string }[] = []
    const run = await runShell({ media: { version: 1, mode: 'voice' }, voice: voicePort(audio, seen) })
    assert.equal(run.sent.length, 1)
    const segment = run.sent[0]!.params.message[0]!
    assert.equal(segment.type, 'record')
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.text, '这是要表达的正文。')
    const payload = Buffer.from(String(segment.data.file).slice('base64://'.length), 'base64')
    assert.deepEqual(new Uint8Array(payload), audio)
    assert.ok(run.events.some((event) => event.event === 'qq_voice_send_api_accepted'))
  })
  await check('shell: voice without an output port falls back to text and says why', async () => {
    const run = await runShell({ media: { version: 1, mode: 'voice' } })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'text')
    assert.ok(run.events.some((event) => event.event === 'qq_voice_fallback_text' && event.reason === 'voice_output_absent'))
  })
  await check('shell: synthesis failure falls back to the same final text', async () => {
    const run = await runShell({
      media: { version: 1, mode: 'voice' },
      voice: { synthesizer: { async synthesize() { throw new Error('provider_down') } } },
    })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'text')
    assert.ok(run.events.some((event) => event.event === 'qq_voice_fallback_text' && event.reason === 'provider_down'))
  })
  await check('shell: non-WAV synthesis output is refused before sending', async () => {
    const run = await runShell({
      media: { version: 1, mode: 'voice' },
      voice: voicePort(new TextEncoder().encode('definitely-not-wav')),
    })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'text')
    assert.ok(run.events.some((event) => event.event === 'qq_voice_fallback_text' && event.reason === 'voice_audio_not_wav_pcm16'))
  })
  await check('shell: over-long audio is refused, not truncated or summarized', async () => {
    const tooLong = wavFixture({ sampleRateHz: 16_000, dataBytes: 16_000 * 2 * 62 })
    const run = await runShell({ media: { version: 1, mode: 'voice' }, voice: voicePort(tooLong) })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'text')
    assert.ok(run.events.some((event) => event.event === 'qq_voice_fallback_text' && event.reason === 'voice_audio_too_long'))
  })
  await check('shell: platform-rejected record gets exactly one text fallback (confirmed not sent)', async () => {
    const run = await runShell({ media: { version: 1, mode: 'voice' }, voice: voicePort(wavFixture()), behavior: { rejectRecord: true } })
    assert.equal(run.sent.length, 2)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'record')
    assert.equal(run.sent[1]!.params.message[0]!.type, 'text')
    assert.ok(run.events.some((event) => event.event === 'qq_voice_fallback_text' && event.reason === 'platform_rejected_record'))
  })
  await check('shell: accepted record without message id => delivery_unknown, no text duplicate', async () => {
    const run = await runShell({ media: { version: 1, mode: 'voice' }, voice: voicePort(wavFixture()), behavior: { missingMessageIdForRecord: true } })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'record')
    assert.ok(run.events.some((event) => event.event === 'qq_voice_delivery_unknown' && event.reason === 'qq_delivery_unconfirmed'))
    assert.equal(run.events.some((event) => event.event === 'qq_voice_fallback_text'), false)
  })
  await check('shell: disconnect during record send => delivery_unknown, never replayed', async () => {
    const run = await runShell({ media: { version: 1, mode: 'voice' }, voice: voicePort(wavFixture()), behavior: { disconnectOnRecord: true } })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'record')
    assert.ok(run.events.some((event) => event.event === 'qq_voice_delivery_unknown'))
    assert.equal(run.events.some((event) => event.event === 'qq_voice_fallback_text'), false)
  })
  await check('shell: old core without media keeps the text path byte-shape unchanged', async () => {
    const run = await runShell({ mediaAbsent: true, voice: voicePort(wavFixture()) })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'text')
    assert.equal(run.events.some((event) => event.event.startsWith('qq_voice_')), false)
  })
  await check('shell: malformed media shape fails closed to text (no guessing)', async () => {
    const run = await runShell({ media: { version: 1, mode: 'audio' }, voice: voicePort(wavFixture()) })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'text')
  })
  await check('shell: group voice uses send_group_msg with a record segment', async () => {
    const run = await runShell({ clientConfig: groupConfig, media: { version: 1, mode: 'voice' }, voice: voicePort(wavFixture()), group: true })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.action, 'send_group_msg')
    assert.equal(run.sent[0]!.params.group_id, '777777')
    assert.equal(run.sent[0]!.params.message[0]!.type, 'record')
  })
} finally {
  for (const connection of wsServer.clients) connection.terminate()
  await new Promise<void>((done) => wsServer.close(() => done()))
  await new Promise<void>((done) => httpServer.close(() => done()))
}

/* ------------------------------------------------------------------------- */
/* 证据                                                                        */
/* ------------------------------------------------------------------------- */
const out = resolve(ROOT, 'artifacts/post-lv2', `qq-voice-reply-${new Date().toISOString().replace(/\D/g, '')}`)
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'result.json'), `${JSON.stringify({
  status: 'PASS',
  checks: checks.length,
  controls: checks,
  node: process.version,
  sources: {
    'src/kernel/contracts/qq-media-reply.ts': sha256(resolve(ROOT, 'src/kernel/contracts/qq-media-reply.ts')),
    'src/kernel/context/qq-media-reply-section.ts': sha256(resolve(ROOT, 'src/kernel/context/qq-media-reply-section.ts')),
    'src/infrastructure/qq/voice-reply.ts': sha256(resolve(ROOT, 'src/infrastructure/qq/voice-reply.ts')),
    'src/infrastructure/qq/onebot-private-client.ts': sha256(resolve(ROOT, 'src/infrastructure/qq/onebot-private-client.ts')),
  },
  boundary: {
    database: 'NOT_OPENED', network: 'LOCAL_LOOPBACK_ONLY', realModel: 'NONE', realQq: 'NOT RUN',
    tts: 'FAKE_PORT_ONLY', scope: 'contract + bridge transport + QQ shell against local OneBot fixture',
    notProven: '真实 TTS 音色/听感、固定 LLBot/PMHQ 镜像的 record 转换、真实模型是否自主选择（P3）',
  },
}, null, 2)}\n`)
console.log(`PASS: QQ 出站媒介选择 · P1（${checks.length} 项）\n${out}`)
