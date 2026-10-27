/**
 * post-Lv2 / P2 门 —— QQ 语音回复的**持久化投递、失败矩阵与真实 TTS 执行器机制**。
 *
 * ============================================================================
 *  这道门回答什么（零真实模型 · 零真实 QQ · 零真实 TTS 账号 · 不打开数据库）
 * ============================================================================
 * ```text
 * ① 投递日志：占用 → 结局 → 重启未知 → 重复键拒绝；坏日志**禁止语音**
 * ② 失败矩阵：合成失败 / 超限 / 平台拒绝 / 无回执 / 断线 / 附录单独记结果
 * ③ 真实 TTS 执行器的**机制**：HTTP 形状、上界、超时、重定向拒绝、配置失败关闭
 * ④ 装配：生产外壳在"日志可写 + TTS 配置齐全"时才装语音端口
 * ```
 *
 * ⚠️ **不证明**：真实 TTS 音色/听感、真实提供方接口（P0 未核对）、固定 LLBot/PMHQ
 *    `record`→SILK、真实 QQ 送达、真实模型是否自主选择（P3）。
 * ⚠️ 本门里的 OneBot 与 TTS 都是**本机假服务**；路径与端口均为临时目录/loopback。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { OneBotPrivateClient } from '../src/infrastructure/qq/onebot-private-client.ts'
import { readQqPrivateConfig } from '../src/infrastructure/qq/private-config.ts'
import {
  FileQqDeliveryJournal, openQqDeliveryJournal, readQqReplyDelivery, sha256Text,
  type QqDeliveryJournalEntry, type QqDeliveryJournalPort,
} from '../src/infrastructure/qq/voice-delivery-journal.ts'
import { createHttpQqVoiceSynthesizer, readQqTtsConfig } from '../src/infrastructure/qq/tts-executor.ts'
import { QQ_VOICE_LIMITS, type QqVoiceOutput } from '../src/infrastructure/qq/voice-reply.ts'

const ROOT = resolve(import.meta.dirname, '..')
const stamp = new Date().toISOString().replace(/\D/g, '')
const evidenceRoot = resolve(ROOT, 'artifacts/post-lv2', `qq-voice-delivery-${stamp}`)
const tempRoot = resolve(evidenceRoot, 'tmp')
mkdirSync(tempRoot, { recursive: true })
const checks: string[] = []
const check = async (name: string, run: () => void | Promise<void>): Promise<void> => { await run(); checks.push(name) }
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const freshDir = (label: string): string => {
  const dir = resolve(tempRoot, label)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/* ------------------------------------------------------------------------- */
/* WAV 夹具（与 P1 门同形；结构合法即可）                                      */
/* ------------------------------------------------------------------------- */
function wavFixture(dataBytes = 4800): Uint8Array {
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const write4 = (offset: number, text: string): void => { for (let i = 0; i < 4; i++) bytes[offset + i] = text.charCodeAt(i) }
  write4(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write4(8, 'WAVE')
  write4(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write4(36, 'data'); view.setUint32(40, dataBytes, true)
  return bytes
}

/* ------------------------------------------------------------------------- */
/* ① 投递日志真值表                                                             */
/* ------------------------------------------------------------------------- */
await check('journal: fresh path is readable and reserve creates the file', () => {
  const path = resolve(freshDir('journal-a'), 'journal.jsonl')
  const opened = openQqDeliveryJournal(path)
  assert.ok(opened.journal !== undefined)
  assert.equal(opened.journal.readable, true)
  assert.deepEqual(opened.journal.reserve({ key: 'k1', requestId: 'r1', purpose: 'reply', requested: 'voice', now: 1 }), { ok: true })
  assert.ok(existsSync(path))
  assert.equal(opened.journal.has('k1'), true)
})
await check('journal: same key is refused (no second normal reply)', () => {
  const path = resolve(freshDir('journal-b'), 'journal.jsonl')
  const journal = new FileQqDeliveryJournal(path)
  assert.deepEqual(journal.reserve({ key: 'k2', requestId: 'r2', purpose: 'reply', requested: 'text', now: 1 }), { ok: true })
  assert.deepEqual(journal.reserve({ key: 'k2', requestId: 'r2', purpose: 'reply', requested: 'voice', now: 2 }), { ok: false, reason: 'duplicate' })
  assert.deepEqual(journal.reserve({ key: 'k2', requestId: 'r2', purpose: 'appendix', requested: 'voice', now: 3 }), { ok: true })
})
await check('journal: recovery preserves completed sends and is idempotent', () => {
  const path = resolve(freshDir('journal-recovery-final'), 'journal.jsonl')
  const journal = new FileQqDeliveryJournal(path)
  journal.reserve({ key: 'done', requestId: 'done', purpose: 'reply', requested: 'voice', now: 1 })
  journal.append({ at: 2, key: 'done', requestId: 'done', purpose: 'reply', attempt: 1, status: 'api_accepted', messageId: '42' })
  journal.reserve({ key: 'pending', requestId: 'pending', purpose: 'reply', requested: 'voice', now: 3 })
  assert.equal(new FileQqDeliveryJournal(path).recover(4), 1)
  assert.equal(new FileQqDeliveryJournal(path).recover(5), 0)
  const entries = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(entries.filter(entry => entry.key === 'done').at(-1).status, 'api_accepted')
  assert.equal(entries.filter(entry => entry.key === 'pending').at(-1).status, 'unknown_after_restart')
})
await check('journal: delivery context binds the previous reply and never guesses another room', () => {
  const path = resolve(freshDir('journal-context'), 'journal.jsonl')
  const journal = new FileQqDeliveryJournal(path)
  journal.reserve({ key: 'owner', requestId: 'r1', purpose: 'reply', requested: 'voice', replyId: 'owner-reply' })
  journal.append({ at: 1, key: 'owner', requestId: 'r1', purpose: 'reply', attempt: 1, status: 'api_accepted', effective: 'text' })
  journal.reserve({ key: 'group', requestId: 'r2', purpose: 'reply', requested: 'voice', replyId: 'group-reply' })
  journal.append({ at: 2, key: 'group', requestId: 'r2', purpose: 'reply', attempt: 1, status: 'delivery_unknown', effective: 'voice' })
  assert.deepEqual(readQqReplyDelivery(path, 'owner-reply'), { replyId: 'owner-reply', status: 'api_accepted', requested: 'voice', effective: 'text' })
  assert.equal(readQqReplyDelivery(path, 'group-reply')?.status, 'delivery_unknown')
  assert.equal(readQqReplyDelivery(path, 'another-reply'), undefined)
  writeFileSync(path, 'invalid\n')
  assert.equal(readQqReplyDelivery(path, 'owner-reply'), undefined)
})
await check('journal: entries stay append-only and contain no plaintext', () => {
  const path = resolve(freshDir('journal-c'), 'journal.jsonl')
  const journal = new FileQqDeliveryJournal(path)
  journal.reserve({ key: 'k3', requestId: 'r3', purpose: 'reply', requested: 'voice', now: 1 })
  journal.append({ at: 2, key: 'k3', requestId: 'r3', purpose: 'reply', attempt: 1, status: 'api_accepted', requested: 'voice', effective: 'voice', messageId: '9', textSha256: sha256Text('这是正文') })
  const before = readFileSync(path, 'utf8')
  journal.append({ at: 3, key: 'k3', requestId: 'r3', purpose: 'appendix', attempt: 1, status: 'api_accepted', requested: 'voice', effective: 'text', messageId: '10', textSha256: sha256Text('来源：…') })
  const after = readFileSync(path, 'utf8')
  assert.ok(after.length > before.length)
  assert.ok(after.startsWith(before))
  assert.equal(after.includes('这是正文'), false)
  assert.equal(after.includes('来源：'), false)
  assert.equal(after.split('\n').filter(Boolean).length, 3)
})
await check('journal: any corrupt line makes the whole journal unreadable (fail closed)', () => {
  const dir = freshDir('journal-d')
  const path = resolve(dir, 'journal.jsonl')
  writeFileSync(path, '{"bad":true}\n', 'utf8')
  const opened = openQqDeliveryJournal(path)
  assert.equal(opened.journal, undefined)
  assert.match(String(opened.error), /delivery_journal_corrupt/)
})
await check('journal: live corruption turns reserve into unavailable', () => {
  const dir = freshDir('journal-e')
  const path = resolve(dir, 'journal.jsonl')
  const journal = new FileQqDeliveryJournal(path)
  journal.reserve({ key: 'k5', requestId: 'r5', purpose: 'reply', requested: 'text', now: 1 })
  writeFileSync(path, readFileSync(path, 'utf8') + 'not-json\n', 'utf8')
  assert.deepEqual(journal.reserve({ key: 'k6', requestId: 'r6', purpose: 'reply', requested: 'voice', now: 2 }), { ok: false, reason: 'unavailable' })
  assert.equal(journal.readable, false)
})
await check('journal: unwritable path is unavailable, not silently dropped', () => {
  const dir = freshDir('journal-f')
  const blocker = resolve(dir, 'blocker')
  writeFileSync(blocker, 'x', 'utf8')
  const path = resolve(blocker, 'nested', 'journal.jsonl')
  const opened = openQqDeliveryJournal(path)
  const journal = opened.journal ?? new FileQqDeliveryJournal(path)
  const reading = journal.reserve({ key: 'k7', requestId: 'r7', purpose: 'reply', requested: 'voice', now: 1 })
  assert.deepEqual(reading, { ok: false, reason: 'unavailable' })
})
await check('journal: restart turns orphan reserved into unknown_after_restart', () => {
  const dir = freshDir('journal-g')
  const path = resolve(dir, 'journal.jsonl')
  const first = new FileQqDeliveryJournal(path)
  first.reserve({ key: 'k8', requestId: 'r8', purpose: 'reply', requested: 'voice', now: 1 })
  const second = new FileQqDeliveryJournal(path)
  assert.equal(second.recover(2), 1)
  const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as QqDeliveryJournalEntry)
  const unknown = entries.filter((entry) => entry.status === 'unknown_after_restart')
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0]!.key, 'k8')
  /* 未知不自动重播的机械形态：同一键再次占用一律 duplicate */
  assert.deepEqual(second.reserve({ key: 'k8', requestId: 'r8', purpose: 'reply', requested: 'voice', now: 3 }), { ok: false, reason: 'duplicate' })
})
await check('journal: stale lock is cleaned, fresh lock is bounded-failure', () => {
  const dir = freshDir('journal-h')
  const path = resolve(dir, 'journal.jsonl')
  const journal = new FileQqDeliveryJournal(path)
  const lock = `${path}.lock`
  writeFileSync(lock, '', 'utf8')
  utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  assert.deepEqual(journal.reserve({ key: 'k9', requestId: 'r9', purpose: 'reply', requested: 'text', now: 1 }), { ok: true })
  writeFileSync(lock, '', 'utf8')
  const started = Date.now()
  assert.deepEqual(journal.reserve({ key: 'k10', requestId: 'r10', purpose: 'reply', requested: 'text', now: 2 }), { ok: false, reason: 'unavailable' })
  assert.ok(Date.now() - started <= 4000)
})

/* ------------------------------------------------------------------------- */
/* ② 外壳 + 日志：失败矩阵（本地 OneBot ws 夹具）                                */
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
let nextMessageId = 5000
const loginId = '987654321'
let behavior: { rejectRecord?: boolean; missingMessageIdForRecord?: boolean; disconnectOnRecord?: boolean; rejectText?: boolean } = {}
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
    if (!isRecord && behavior.rejectText === true) {
      connection.send(JSON.stringify({ status: 'failed', retcode: 100, data: null, echo: packet.echo }))
      return
    }
    connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: ++nextMessageId }, echo: packet.echo }))
  })
})
await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done))
const wsPort = (httpServer.address() as { port: number }).port
const settings = readQqPrivateConfig({
  QQ_OWNER_ID: '123456789', QQ_BOT_ID: loginId,
  QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${wsPort}/`, QQ_ONEBOT_ACCESS_TOKEN: 'offline-delivery-fixture-token-123456',
})
const waitFor = async (test: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt += 1) { if (test()) return; await delay(10) }
  throw new Error(`fixture_timeout:${label}`)
}
interface ShellRun {
  events: { event: string; requestId?: string; reason?: string; messageId?: string | number }[]
  sent: SentPacket[]
  journalText: string
  requestId: string
  key: string
}
let inboundCounter = 7000
const runShell = async (input: {
  journal: QqDeliveryJournalPort | undefined
  voice?: QqVoiceOutput
  media?: unknown
  appendix?: string
  voicePortAbsent?: boolean
  behavior?: typeof behavior
  messageId?: number
}): Promise<ShellRun> => {
  sentPackets = []; behavior = input.behavior ?? {}
  const events: ShellRun['events'] = []
  const requestIdFor = (messageId: number): string => `qq-private:${loginId}:${messageId}`
  const submit = async (request: { requestId: string }) => ({
    kind: 'TURN_RESULT' as const, requestId: request.requestId, outcome: 'replied' as const,
    replyText: '这是要表达的正文。', delivery: 'generated' as const, replyId: 'reply:offline-1', traceId: 'trace:offline-1',
    media: input.media ?? { version: 1, mode: 'text' },
    ...(input.appendix === undefined ? {} : { mediaAppendix: input.appendix }),
  })
  const client = new OneBotPrivateClient(settings, submit as never, (reading) => events.push(reading),
    input.voice, input.journal)
  await client.connect()
  await client.drain()
  const messageId = input.messageId ?? ++inboundCounter
  try {
    peer.send(JSON.stringify({
      post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: loginId,
      user_id: '123456789', sender: { user_id: '123456789' }, message_id: messageId,
      message: [{ type: 'text', data: { text: '在吗' } }],
    }))
    await waitFor(() => events.some((event) => event.event === 'qq_send_api_accepted') ||
      events.some((event) => event.event.startsWith('qq_delivery_duplicate')) ||
      events.some((event) => event.event === 'qq_voice_delivery_unknown') ||
      events.some((event) => event.event === 'qq_appendix_send_failed') ||
      !client.connected, 'outcome')
    await client.drain()
    await delay(40)
    const journalText = input.journal === undefined || !existsSync(input.journal.path)
      ? '' : readFileSync(input.journal.path, 'utf8')
    return {
      events, sent: [...sentPackets], journalText,
      requestId: requestIdFor(messageId), key: `qq-reply:${requestIdFor(messageId)}`,
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}
const entriesOf = (run: ShellRun): QqDeliveryJournalEntry[] =>
  run.journalText.split('\n').filter(Boolean).map((line) => JSON.parse(line) as QqDeliveryJournalEntry)
const voicePort = (audio: Uint8Array | (() => Uint8Array), failWith?: string): QqVoiceOutput => ({
  synthesizer: {
    async synthesize() {
      if (failWith !== undefined) throw new Error(failWith)
      return { audio: typeof audio === 'function' ? audio() : audio, format: 'wav' as const }
    },
  },
})
const journalAt = (label: string): FileQqDeliveryJournal => {
  const dir = freshDir(`shell-${label}`)
  return new FileQqDeliveryJournal(resolve(dir, 'journal.jsonl'))
}
/** 可注入故障的日志端口（模拟"日志中途坏掉"） */
const brokenJournal = (): QqDeliveryJournalPort => {
  const path = resolve(freshDir('shell-broken'), 'journal.jsonl')
  return {
    path, readable: true,
    recover: () => 0,
    has: () => false,
    reserve: () => ({ ok: false, reason: 'unavailable' }),
    append: () => { throw new Error('delivery_journal_write_failed') },
  }
}

try {
  await check('shell: voice success is journaled with hashes and structure readings, no plaintext', async () => {
    const journal = journalAt('voice-ok')
    const audio = wavFixture()
    const run = await runShell({ journal, voice: voicePort(audio), media: { version: 1, mode: 'voice' } })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'record')
    const entries = entriesOf(run)
    assert.deepEqual(entries.map((entry) => entry.status), ['reserved', 'api_accepted'])
    assert.equal(entries[1]!.requested, 'voice')
    assert.equal(entries[1]!.effective, 'voice')
    assert.ok(entries[1]!.messageId !== undefined)
    assert.equal(entries[1]!.audioBytes, audio.byteLength)
    assert.equal(entries[1]!.audioDurationMs, 100)
    assert.equal(entries[1]!.textSha256, sha256Text('这是要表达的正文。'))
    assert.equal(run.journalText.includes('这是要表达的正文。'), false)
    assert.ok(run.events.some((event) => event.event === 'qq_voice_send_api_accepted'))
  })
  await check('shell: duplicate inbound after restart sends nothing (duplicate_skipped)', async () => {
    const journal = journalAt('dup')
    const first = await runShell({ journal, voice: voicePort(wavFixture()), media: { version: 1, mode: 'voice' } })
    assert.equal(first.sent.length, 1)
    /* 模拟重启后的同一条入站：新客户端、**同一 message_id**、同一日志 */
    const sameMessageId = Number(first.requestId.split(':').pop())
    const second = await runShell({ journal, media: { version: 1, mode: 'voice' }, messageId: sameMessageId })
    assert.equal(second.sent.length, 0)
    assert.deepEqual(second.key, first.key)
    assert.ok(second.events.some((event) => event.event === 'qq_delivery_duplicate_skipped'))
  })
  await check('shell: crash-while-reserved becomes unknown and is never replayed', async () => {
    const journal = journalAt('crash')
    /* 预置一条 reserved（等价于"发送前崩溃"），键与下一次入站一致 */
    const probe = new FileQqDeliveryJournal(journal.path)
    const messageId = inboundCounter + 1
    const requestId = `qq-private:${loginId}:${messageId}`
    probe.reserve({ key: `qq-reply:${requestId}`, requestId, purpose: 'reply', requested: 'voice', now: 1 })
    const run = await runShell({ journal, voice: voicePort(wavFixture()), media: { version: 1, mode: 'voice' }, messageId })
    assert.equal(run.requestId, requestId)
    assert.equal(run.sent.length, 0)
    assert.ok(run.events.some((event) => event.event === 'qq_delivery_recovered_unknown'))
    const entries = entriesOf(run)
    assert.ok(entries.some((entry) => entry.status === 'unknown_after_restart'))
    assert.ok(run.events.some((event) => event.event === 'qq_delivery_duplicate_skipped'))
  })
  await check('shell: text choice is journaled and also deduped', async () => {
    const journal = journalAt('text')
    const run = await runShell({ journal, media: { version: 1, mode: 'text' } })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'text')
    const entries = entriesOf(run)
    assert.deepEqual(entries.map((entry) => entry.status), ['reserved', 'api_accepted'])
    assert.equal(entries[1]!.requested, 'text')
    assert.equal(entries[1]!.effective, 'text')
    const again = await runShell({ journal, media: { version: 1, mode: 'text' }, messageId: Number(run.requestId.split(':').pop()) })
    assert.equal(again.sent.length, 0)
  })
  await check('shell: synthesis failure => one fallback text, journal records both facts', async () => {
    const journal = journalAt('synth-fail')
    const run = await runShell({ journal, voice: voicePort(wavFixture(), 'tts_http_503'), media: { version: 1, mode: 'voice' } })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'text')
    const entries = entriesOf(run)
    assert.ok(entries.some((entry) => entry.status === 'fallback_text' && entry.reason === 'tts_http_503'))
    assert.ok(entries.some((entry) => entry.status === 'api_accepted' && entry.effective === 'text'))
  })
  await check('shell: voice fallback preserves the source appendix', async () => {
    const run = await runShell({ journal: journalAt('fallback-appendix'), voice: voicePort(wavFixture(), 'tts_http_503'),
      media: { version: 1, mode: 'voice' }, appendix: '来源：https://example.invalid/evidence' })
    assert.equal(run.sent.length, 1)
    assert.match(String(run.sent[0]!.params.message[0]!.data.text), /来源：https:\/\/example.invalid\/evidence$/)
  })
  await check('shell: provider usage remains on the delivery record', async () => {
    const run = await runShell({ journal: journalAt('tts-usage'), media: { version: 1, mode: 'voice' }, voice: {
      synthesizer: { async synthesize() { return { audio: wavFixture(), format: 'wav',
        providerRequestId: 'provider-fixture', usage: { characters: 20 } } } },
    } })
    const accepted = entriesOf(run).find(entry => entry.status === 'api_accepted')!
    assert.equal(accepted.ttsRequestId, 'provider-fixture')
    assert.deepEqual(accepted.ttsUsage, { characters: 20 })
  })
  await check('shell: platform-rejected record => one text fallback, both outcomes journaled', async () => {
    const journal = journalAt('record-reject')
    const run = await runShell({ journal, voice: voicePort(wavFixture()), media: { version: 1, mode: 'voice' }, behavior: { rejectRecord: true } })
    assert.equal(run.sent.length, 2)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'record')
    assert.equal(run.sent[1]!.params.message[0]!.type, 'text')
    const entries = entriesOf(run)
    assert.ok(entries.some((entry) => entry.status === 'failed_confirmed' && entry.reason === 'platform_rejected_record'))
    assert.ok(entries.some((entry) => entry.status === 'api_accepted' && entry.effective === 'text'))
  })
  await check('shell: accepted record without message id => delivery_unknown, no text duplicate', async () => {
    const journal = journalAt('record-unknown')
    const run = await runShell({ journal, voice: voicePort(wavFixture()), media: { version: 1, mode: 'voice' }, behavior: { missingMessageIdForRecord: true } })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'record')
    const entries = entriesOf(run)
    assert.ok(entries.some((entry) => entry.status === 'delivery_unknown'))
    assert.equal(entries.some((entry) => entry.status === 'api_accepted'), false)
  })
  await check('shell: disconnect during record => delivery_unknown, never replayed', async () => {
    const journal = journalAt('record-disconnect')
    const run = await runShell({ journal, voice: voicePort(wavFixture()), media: { version: 1, mode: 'voice' }, behavior: { disconnectOnRecord: true } })
    assert.equal(run.sent.length, 1)
    const entries = entriesOf(run)
    assert.ok(entries.some((entry) => entry.status === 'delivery_unknown'))
    assert.equal(run.journalText.includes('"status":"api_accepted"'), false)
  })
  await check('shell: appendix goes as a separate text and is separately journaled', async () => {
    const journal = journalAt('appendix')
    const run = await runShell({
      journal, voice: voicePort(wavFixture()), media: { version: 1, mode: 'voice' },
      appendix: '来源：\n[E1] 某页 — https://example.invalid/x',
    })
    assert.equal(run.sent.length, 2)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'record')
    assert.equal(run.sent[1]!.params.message[0]!.type, 'text')
    assert.equal(run.sent[1]!.params.message[0]!.data.text, '来源：\n[E1] 某页 — https://example.invalid/x')
    const entries = entriesOf(run)
    assert.ok(entries.some((entry) => entry.purpose === 'reply' && entry.status === 'api_accepted'))
    assert.ok(entries.some((entry) => entry.purpose === 'appendix' && entry.status === 'api_accepted'))
  })
  await check('shell: appendix failure does not resend or invalidate the voice', async () => {
    const journal = journalAt('appendix-fail')
    const run = await runShell({
      journal, voice: voicePort(wavFixture()), media: { version: 1, mode: 'voice' },
      appendix: '来源：https://example.invalid/x', behavior: { rejectText: true },
    })
    assert.equal(run.sent.length, 2)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'record')
    const entries = entriesOf(run)
    assert.ok(entries.some((entry) => entry.purpose === 'reply' && entry.status === 'api_accepted'))
    assert.ok(entries.some((entry) => entry.purpose === 'appendix' && entry.status === 'failed_confirmed'))
    assert.ok(run.events.some((event) => event.event === 'qq_appendix_send_failed'))
    assert.equal(run.sent.filter((packet) => packet.params.message[0]!.type === 'record').length, 1)
  })
  await check('shell: unavailable journal forbids voice (falls back to text)', async () => {
    const journal = brokenJournal()
    const run = await runShell({ journal, voice: voicePort(wavFixture()), media: { version: 1, mode: 'voice' } })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'text')
    assert.ok(run.events.some((event) => event.event === 'qq_voice_fallback_text' && event.reason === 'delivery_journal_unavailable'))
  })
  await check('shell: no journal keeps P1 behavior and says so (journal_absent)', async () => {
    const run = await runShell({ journal: undefined, voice: voicePort(wavFixture()), media: { version: 1, mode: 'voice' } })
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0]!.params.message[0]!.type, 'record')
    assert.ok(run.events.some((event) => event.event === 'qq_delivery_journal_absent'))
  })
} finally {
  /* 关掉本地夹具（否则事件循环留着监听器，门跑完不退出） */
  for (const connection of wsServer.clients) connection.terminate()
  await new Promise<void>((done) => wsServer.close(() => done()))
  await new Promise<void>((done) => httpServer.close(() => done()))
}

/* ------------------------------------------------------------------------- */
/* ③ HTTP TTS 执行器（本机假服务；机制）                                       */
/* ------------------------------------------------------------------------- */
const ttsAudio = wavFixture(2400)
await check('tts: Chelsie uses Qwen-TTS shape, upgrades OSS to HTTPS and enforces 600 characters', async () => {
  let calls = 0
  const synth = createHttpQqVoiceSynthesizer({ url: 'https://fixture.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    apiKey: 'fixture-key', model: 'qwen3-tts-flash', voice: 'Chelsie', protocol: 'qwen-tts' }, {
    fetchImpl: (async (url, init) => {
      calls++
      if (calls === 1) {
        assert.deepEqual(JSON.parse(String(init?.body)), { model: 'qwen3-tts-flash',
          input: { text: '原文保持不变。', voice: 'Chelsie', language_type: 'Auto' } })
        return Response.json({ output: { finish_reason: 'stop', audio: {
          url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?Signature=fixture' } }, usage: { characters: 8 } })
      }
      assert.equal(String(url), 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?Signature=fixture')
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      return new Response(Buffer.from(ttsAudio), { headers: { 'content-type': 'audio/wav' } })
    }) as typeof fetch,
  })
  assert.deepEqual((await synth.synthesize({ text: '原文保持不变。', deadlineMs: 1000 })).usage, { characters: 8 })
  await assert.rejects(synth.synthesize({ text: '字'.repeat(601), deadlineMs: 1000 }), /tts_text_invalid/)
  assert.equal(calls, 2)
})
await check('tts: DashScope request, bounded download and usage follow the official contract', async () => {
  let calls = 0
  const result = await createHttpQqVoiceSynthesizer({
    url: 'https://fixture.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    apiKey: 'fixture-provider-key', model: 'fixture-model', voice: 'fixture-voice', protocol: 'dashscope',
  }, { fetchImpl: (async (_url, init) => {
    calls++
    if (calls === 1) {
      assert.deepEqual(JSON.parse(String(init?.body)), { model: 'fixture-model',
        input: { text: '保持正文，42。', voice: 'fixture-voice', format: 'wav', sample_rate: 24000 } })
      return Response.json({ request_id: 'provider-request-1', output: { finish_reason: 'stop',
        audio: { url: 'https://fixture.oss-cn-beijing.aliyuncs.com/audio.wav?signature=fixture' } },
        usage: { input_tokens: 8, output_tokens: 12, total_tokens: 20, characters: 9 } })
    }
    assert.equal(new Headers(init?.headers).has('authorization'), false)
    assert.equal(init?.redirect, 'error')
    return new Response(Buffer.from(ttsAudio), { headers: { 'content-type': 'audio/wav' } })
  }) as typeof fetch }).synthesize({ text: '保持正文，42。', deadlineMs: 1000 })
  assert.equal(calls, 2)
  assert.deepEqual(result.audio, ttsAudio)
  assert.equal(result.providerRequestId, 'provider-request-1')
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 12, totalTokens: 20, characters: 9 })
})
await check('tts: DashScope rejects foreign or private audio URLs before any download', async () => {
  for (const url of ['http://169.254.169.254/latest', 'https://evil.invalid/audio.wav', 'https://user:secret@bucket.oss-cn-beijing.aliyuncs.com/a']) {
    let calls = 0
    const synth = createHttpQqVoiceSynthesizer({ url: 'https://fixture.cn-beijing.maas.aliyuncs.com/tts',
      apiKey: 'fixture-key', model: 'm', voice: 'v', protocol: 'dashscope' }, {
      fetchImpl: (async () => { calls++; return Response.json({ output: { finish_reason: 'stop', audio: { url } } }) }) as typeof fetch,
    })
    await assert.rejects(synth.synthesize({ text: '正文', deadlineMs: 1000 }), /tts_audio_url_rejected/)
    assert.equal(calls, 1)
  }
})
let ttsMode: 'wav' | 'json' | 'http500' | 'html' | 'oversize' | 'slow' | 'redirect' = 'wav'
let lastTtsRequest: { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> } | undefined
const ttsServer: Server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    try { lastTtsRequest = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> } }
    catch { lastTtsRequest = { headers: request.headers, body: {} } }
    if (ttsMode === 'http500') { response.writeHead(500); response.end('nope'); return }
    if (ttsMode === 'redirect') { response.writeHead(302, { location: 'http://127.0.0.1:1/x' }); response.end(); return }
    if (ttsMode === 'html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html>'); return }
    if (ttsMode === 'oversize') { response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(QQ_VOICE_LIMITS.maxAudioBytes + 1) }); response.end(); return }
    if (ttsMode === 'slow') {
      response.writeHead(200, { 'content-type': 'audio/wav' })
      setTimeout(() => response.end(Buffer.from(ttsAudio)), 300)
      return
    }
    if (ttsMode === 'json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ audio_base64: Buffer.from(ttsAudio).toString('base64') }))
      return
    }
    response.writeHead(200, { 'content-type': 'audio/wav' })
    response.end(Buffer.from(ttsAudio))
  })
})
await new Promise<void>((done) => ttsServer.listen(0, '127.0.0.1', done))
const ttsPort = (ttsServer.address() as { port: number }).port
const ttsConfig = readQqTtsConfig({
  CHARACTER_QQ_TTS_URL: `http://127.0.0.1:${ttsPort}/v1/audio/speech`,
  CHARACTER_QQ_TTS_API_KEY: 'offline-tts-fixture-key-1234567890',
  CHARACTER_QQ_TTS_MODEL: 'offline-tts-model',
  CHARACTER_QQ_TTS_VOICE: 'offline-voice',
})
try {
  assert.ok(ttsConfig !== undefined)
  await check('tts: config is all-or-nothing and refuses non-loopback http/query credentials', () => {
    assert.equal(readQqTtsConfig({}), undefined)
    assert.equal(readQqTtsConfig({
      CHARACTER_QQ_TTS_URL: 'https://example.invalid/tts', CHARACTER_QQ_TTS_API_KEY: 'k'.repeat(20),
      CHARACTER_QQ_TTS_MODEL: 'm', CHARACTER_QQ_TTS_VOICE: 'v',
    })?.url, 'https://example.invalid/tts')
    assert.equal(readQqTtsConfig({
      CHARACTER_QQ_TTS_URL: 'http://example.invalid/tts', CHARACTER_QQ_TTS_API_KEY: 'k'.repeat(20),
      CHARACTER_QQ_TTS_MODEL: 'm', CHARACTER_QQ_TTS_VOICE: 'v',
    }), undefined)
    assert.equal(readQqTtsConfig({
      CHARACTER_QQ_TTS_URL: 'https://example.invalid/tts?key=secret', CHARACTER_QQ_TTS_API_KEY: 'k'.repeat(20),
      CHARACTER_QQ_TTS_MODEL: 'm', CHARACTER_QQ_TTS_VOICE: 'v',
    }), undefined)
    assert.equal(readQqTtsConfig({
      CHARACTER_QQ_TTS_URL: 'https://example.invalid/tts', CHARACTER_QQ_TTS_API_KEY: 'k'.repeat(20),
      CHARACTER_QQ_TTS_MODEL: 'bad model', CHARACTER_QQ_TTS_VOICE: 'v',
    }), undefined)
  })
  await check('tts: wav response is returned with the configured request shape', async () => {
    ttsMode = 'wav'
    const synthesizer = createHttpQqVoiceSynthesizer(ttsConfig!)
    const result = await synthesizer.synthesize({ text: '这是要念的正文。', deadlineMs: 2000 })
    assert.equal(result.format, 'wav')
    assert.deepEqual(result.audio, ttsAudio)
    assert.equal(lastTtsRequest?.body.model, 'offline-tts-model')
    assert.equal(lastTtsRequest?.body.input, '这是要念的正文。')
    assert.equal(lastTtsRequest?.body.voice, 'offline-voice')
    assert.equal(lastTtsRequest?.body.response_format, 'wav')
    assert.equal(lastTtsRequest?.headers.authorization, 'Bearer offline-tts-fixture-key-1234567890')
  })
  await check('tts: JSON base64 response is accepted', async () => {
    ttsMode = 'json'
    const result = await createHttpQqVoiceSynthesizer(ttsConfig!).synthesize({ text: '好。', deadlineMs: 2000 })
    assert.deepEqual(result.audio, ttsAudio)
  })
  await check('tts: 500 / HTML / redirect are named failures', async () => {
    const synthesizer = createHttpQqVoiceSynthesizer(ttsConfig!)
    ttsMode = 'http500'
    await assert.rejects(synthesizer.synthesize({ text: '好。', deadlineMs: 2000 }), /tts_http_500/)
    ttsMode = 'html'
    await assert.rejects(synthesizer.synthesize({ text: '好。', deadlineMs: 2000 }), /tts_content_type_unexpected/)
    ttsMode = 'redirect'
    await assert.rejects(synthesizer.synthesize({ text: '好。', deadlineMs: 2000 }), /tts_transport_failed/)
  })
  await check('tts: oversize body is refused by declared length (bounded read)', async () => {
    ttsMode = 'oversize'
    await assert.rejects(createHttpQqVoiceSynthesizer(ttsConfig!).synthesize({ text: '好。', deadlineMs: 2000 }), /tts_response_too_large/)
  })
  await check('tts: slow provider is bounded by the deadline', async () => {
    ttsMode = 'slow'
    const started = Date.now()
    await assert.rejects(createHttpQqVoiceSynthesizer(ttsConfig!).synthesize({ text: '好。', deadlineMs: 80 }), /tts_(timeout|transport_failed|stream)/)
    assert.ok(Date.now() - started < 2000)
  })
} finally {
  await new Promise<void>((done) => ttsServer.close(() => done()))
}

/* ------------------------------------------------------------------------- */
/* ④ 装配结构锁（生产外壳 / 核心 / 桥）                                          */
/* ------------------------------------------------------------------------- */
await check('assembly: chat.ts installs journal + TTS only when protocol and output are both enabled', () => {
  const chat = readFileSync(resolve(ROOT, 'scripts/qq/chat.ts'), 'utf8')
  assert.ok(chat.includes('openQqDeliveryJournal'))
  assert.ok(chat.includes('readQqTtsConfig'))
  assert.ok(chat.includes('createHttpQqVoiceSynthesizer'))
  assert.ok(chat.includes('voiceProtocolEnabled'))
  assert.ok(chat.includes('voiceOutputDeclared'))
  assert.ok(chat.includes('voiceOutput, deliveryJournal?.journal'))
  assert.ok(chat.includes("'qq_delivery_journal_open_failed'"))
})
await check('assembly: client reserves before sending and forbids voice on unavailable journal', () => {
  const client = readFileSync(resolve(ROOT, 'src/infrastructure/qq/onebot-private-client.ts'), 'utf8')
  assert.ok(client.includes('reserveDelivery'))
  assert.ok(client.includes('qq_delivery_duplicate_skipped'))
  assert.ok(client.includes("'delivery_journal_unavailable'"))
  assert.ok(client.includes('journal.recover()'))
  assert.ok(client.includes('qq_appendix_send_api_accepted'))
})
await check('assembly: core attaches appendix only for voice replies', () => {
  const main = readFileSync(resolve(ROOT, 'src/main.ts'), 'utf8')
  assert.ok(main.includes('mediaAppendix'))
  assert.ok(main.includes("qqMediaResolved?.media?.mode === 'voice'"))
  const bridge = readFileSync(resolve(ROOT, 'src/kernel/app/bridge/turn-bridge.ts'), 'utf8')
  assert.ok(bridge.includes('mediaAppendix'))
  const transport = readFileSync(resolve(ROOT, 'src/infrastructure/bridge/turn-bridge-transport.ts'), 'utf8')
  assert.ok(transport.includes('identity.mediaAppendix'))
})
await check('assembly: journal schema has no plaintext fields (hashes only)', () => {
  const journal = readFileSync(resolve(ROOT, 'src/infrastructure/qq/voice-delivery-journal.ts'), 'utf8')
  assert.equal(/^\s*text\??:/m.test(journal), false)
  assert.ok(journal.includes('textSha256'))
  assert.ok(journal.includes('audioSha256'))
})

/* ------------------------------------------------------------------------- */
/* 证据                                                                        */
/* ------------------------------------------------------------------------- */
rmSync(tempRoot, { recursive: true, force: true })
mkdirSync(evidenceRoot, { recursive: true })
writeFileSync(resolve(evidenceRoot, 'result.json'), `${JSON.stringify({
  status: 'PASS', checks: checks.length, controls: checks, node: process.version,
  sources: {
    'src/infrastructure/qq/voice-delivery-journal.ts': sha256(resolve(ROOT, 'src/infrastructure/qq/voice-delivery-journal.ts')),
    'src/infrastructure/qq/tts-executor.ts': sha256(resolve(ROOT, 'src/infrastructure/qq/tts-executor.ts')),
    'src/infrastructure/qq/onebot-private-client.ts': sha256(resolve(ROOT, 'src/infrastructure/qq/onebot-private-client.ts')),
    'scripts/qq/chat.ts': sha256(resolve(ROOT, 'scripts/qq/chat.ts')),
  },
  boundary: {
    database: 'NOT_OPENED', network: 'LOCAL_LOOPBACK_ONLY', realModel: 'NONE', realQq: 'NOT RUN',
    tts: 'FAKE_HTTP_FIXTURE_ONLY', scope: 'journal + failure matrix + HTTP executor mechanism + assembly',
    notProven: '真实 TTS 提供方与音色、固定 LLBot/PMHQ record→SILK、真实 QQ 送达、真实模型自主选择（P3）',
  },
}, null, 2)}\n`)
console.log(`PASS: QQ 语音投递/失败矩阵/执行器机制（P2，${checks.length} 项）\n${evidenceRoot}`)
