/** Real main.ts + isolated PostgreSQL + local model/OneBot/TTS; no real sends or model calls. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { startCoexistHost, EntryShell, delay, ROOT } from './coexist/harness.ts'
import { LgStdioClient } from '../src/infrastructure/qq/lg-stdio-client.ts'
import { OneBotPrivateClient } from '../src/infrastructure/qq/onebot-private-client.ts'
import { FileQqDeliveryJournal } from '../src/infrastructure/qq/voice-delivery-journal.ts'
import { createHttpQqVoiceSynthesizer } from '../src/infrastructure/qq/tts-executor.ts'
import { inspectWav } from '../src/infrastructure/qq/voice-reply.ts'
import { WechatGroupClient, type WechatMessage } from '../src/infrastructure/wechat/group-client.ts'

assert.equal(process.env.CHARACTER_DB_BACKEND, 'postgres')
assert.match(new URL(process.env.LG_TEST_PG_URL!).pathname, /^\/lg_test_/)
const sandbox = isolateDatabase('qq-voice-main', { postgres: { url: process.env.LG_TEST_PG_URL! } })
const out = resolve(ROOT, 'artifacts/post-lv2/local', `qq-voice-main-${Date.now()}`)
mkdirSync(out, { recursive: true })
const pool = new pg.Pool({ connectionString: process.env.LG_TEST_PG_URL })
const owner = '123456789', bot = '987654321', member = '222222222', group = '333333333'
const prompts: { qq: boolean; current: string; priorDelivery: boolean }[] = []
const semanticInputs: { current: string; voice: boolean; explanation: boolean }[] = []
const turns: { media?: { mode: string }; outcome: string; replyText?: string }[] = []
const checks: string[] = []
const wxMessages: WechatMessage[] = []
const wav = Buffer.alloc(44 + 4800)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8)
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(4800, 40)
const ttsTexts: string[] = []
let current = '', wxText = '', nextId = 200
const model = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}')
  const system = String(body.messages?.[0]?.content ?? '')
  if (Array.isArray(body.tools)) {
    const input = JSON.parse(body.messages[1].content)
    semanticInputs.push({ current, voice: input.replyMedia?.qqVoiceAvailable === true,
      explanation: system.includes('不需要 lg_tools 或 lg_relay') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { tool_calls: [] } }] }))
    return
  }
  const qq = system.includes('【本轮 QQ 出站媒介】')
  if (qq) {
    const output = system.slice(system.lastIndexOf('# 输出要求'))
    assert.ok(output.includes('<lg-qq-media>') && !output.includes('不要输出任何 XML 标签'))
  }
  let content: string
  if (system.includes('判断此刻是否愿意接话')) content = '{"reply":true}'
  else {
    prompts.push({ qq, current, priorDelivery: system.includes('【上一条 QQ 回复交付事实】') })
    const text = '离线测试正文，数字 42 不应改变。'
    content = current === 'bad' ? '<lg-qq-media>{broken}</lg-qq-media>' : qq
      ? `<lg-qq-media>${JSON.stringify({ version: 1, mode: current === 'text' ? 'text' : 'voice', text })}</lg-qq-media>`
      : text
    content = `<response><text>${content}</text></response>`
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content } }] }))
})
const tts = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  ttsTexts.push(JSON.parse(raw).input)
  res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav)
})
const wxApi = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname)
  let result: unknown = wxMessages
  if (path === '/api/status/auth') result = { status: 'logged_in', loggedInUser: 'wxid_bot_1234' }
  else if (path.startsWith('/api/chats/')) result = { id: '111@chatroom', isGroup: true }
  else if (path === '/api/messages/send') {
    let raw = ''; for await (const chunk of req) raw += chunk
    wxText = JSON.parse(raw).text; result = { success: true }
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
})
await Promise.all([model, tts, wxApi].map(server => new Promise<void>(done => server.listen(0, '127.0.0.1', done))))
const portOf = (server: typeof model) => (server.address() as { port: number }).port
const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws')
const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise<void>(done => ws.once('listening', done))
let peer: { send: (text: string) => void } | undefined
const sends: { type: string; target: string; text?: string }[] = []
ws.on('connection', (socket: any) => {
  peer ??= socket // Core membership probes use additional short-lived connections.
  socket.on('message', (raw: Buffer) => {
    const packet = JSON.parse(String(raw))
    let data: unknown = {}
    if (packet.action === 'get_login_info') data = { user_id: bot }
    else if (packet.action === 'get_group_member_info') data = { user_id: packet.params.user_id, group_id: packet.params.group_id }
    else {
      assert.ok(['send_private_msg', 'send_group_msg'].includes(packet.action))
      const part = packet.params.message[0]
      if (part.type === 'record') assert.equal(inspectWav(Buffer.from(part.data.file.slice(9), 'base64'))?.durationMs, 100)
      sends.push({ type: part.type, target: String(packet.params.user_id ?? packet.params.group_id), text: part.data.text })
      data = { message_id: ++nextId }
    }
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data }))
  })
})
const wsUrl = `ws://127.0.0.1:${ws.address().port}/`
const wxConfig = { baseUrl: `http://127.0.0.1:${portOf(wxApi)}`, token: 'fixture-wechat-token-123456789',
  botId: 'wxid_bot', ownerId: 'wxid_owner', groupIds: ['111@chatroom'], stateFile: resolve(sandbox.dir, 'wx-seen.json') }
const host = await startCoexistHost({ dbDir: sandbox.dir, modelPort: portOf(model), env: {
  CHARACTER_CONTEXT_COMPILER_V1: 'true', CHARACTER_RELATIONSHIP_CONTEXT_ENABLED: 'true',
  CHARACTER_SEMANTIC_ENTRY_ENABLED: 'true', CHARACTER_RELAY_TASKS_ENABLED: 'true',
  CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false', CHARACTER_QQ_VOICE_REPLY: 'true', CHARACTER_QQ_VOICE_OUTPUT: 'true',
  CHARACTER_QQ_DELIVERY_JOURNAL: resolve(out, 'delivery.jsonl'),
  QQ_MULTI_USER_ENABLED: 'true', QQ_ALLOWED_GROUP_IDS: group, QQ_ONEBOT_WS_URL: wsUrl,
  WECHAT_ENABLED: 'true', WECHAT_API_URL: wxConfig.baseUrl, WECHAT_API_TOKEN: wxConfig.token,
  WECHAT_BOT_ID: wxConfig.botId, WECHAT_OWNER_ID: wxConfig.ownerId, WECHAT_ALLOWED_GROUP_IDS: '111@chatroom',
  WECHAT_STATE_FILE: wxConfig.stateFile,
} })
let lg: LgStdioClient | undefined, qq: OneBotPrivateClient | undefined, avatar: EntryShell | undefined
const until = async (predicate: () => boolean) => {
  for (let n = 0; n < 300; n++) { if (predicate()) return; await delay(100) }
  throw new Error('qq_voice_main_timeout')
}
try {
  await host.ready
  lg = new LgStdioClient(ROOT, process.env, { connect: { host: '127.0.0.1', port: host.qqPort, token: host.qqToken } })
  await lg.ready
  qq = new OneBotPrivateClient({ ownerId: owner, botId: bot, wsUrl, token: 'offline-coexist-qq-token-1234567890',
    multiUserEnabled: true, allowedGroupIds: [group] }, async request => {
      const result = await lg!.submit(request); turns.push(result); return result
    }, () => {}, { synthesizer: createHttpQqVoiceSynthesizer({ url: `http://127.0.0.1:${portOf(tts)}/speech`,
      apiKey: 'test-key', model: 'fixture-tts', voice: 'fixture-voice' }) },
    new FileQqDeliveryJournal(resolve(out, 'delivery.jsonl')))
  await qq.connect()
  const send = async (kind: string, groupId?: string) => {
    current = kind; const before = turns.length
    peer!.send(JSON.stringify({ post_type: 'message', message_type: groupId ? 'group' : 'private', sub_type: groupId ? 'normal' : 'friend',
      self_id: bot, user_id: groupId ? member : owner, sender: { user_id: groupId ? member : owner },
      ...(groupId ? { group_id: groupId } : {}), message_id: ++nextId,
      message: [{ type: 'text', data: { text: groupId ? '@苏沐薇 fixture' : 'fixture' } },
        ...(groupId ? [{ type: 'at', data: { qq: bot } }] : [])] }))
    await until(() => turns.length > before); await qq!.drain()
  }
  await send('voice')
  assert.equal(turns.at(-1)?.media?.mode, 'voice'); assert.equal(sends.at(-1)?.type, 'record')
  assert.deepEqual(ttsTexts, ['离线测试正文，数字 42 不应改变。'])
  checks.push('private: real main -> media -> HTTP TTS -> record with exact final text')
  await send('text')
  assert.equal(turns.at(-1)?.media?.mode, 'text'); assert.equal(sends.at(-1)?.type, 'text'); assert.equal(ttsTexts.length, 1)
  checks.push('text: zero additional synthesis')
  assert.equal(prompts.at(-1)?.priorDelivery, true)
  checks.push('next turn: exact previous reply delivery is visible through ContextCompiler')
  await send('voice', group)
  assert.equal(prompts.at(-1)?.priorDelivery, false)
  assert.equal(sends.at(-1)?.target, group); assert.equal(sends.at(-1)?.type, 'record')
  checks.push('authorized group: same product chain and scoped target')
  await send('bad')
  assert.equal(turns.at(-1)?.outcome, 'failed'); assert.equal(ttsTexts.length, 2)
  assert.ok(!sends.some(send => send.text?.includes('<lg-qq-media>')))
  checks.push('bad envelope: failed turn, no TTS, no protocol leak')
  current = 'avatar'; avatar = new EntryShell(host.avatarPort, host.avatarToken); await avatar.ready
  const avatarResult = await avatar.submit('avatar-fixture', 'fixture')
  assert.equal(avatarResult.media, undefined); assert.equal(prompts.at(-1)?.qq, false)
  checks.push('avatar: no QQ section or metadata')
  current = 'wechat'
  const wx = new WechatGroupClient(wxConfig, request => lg!.submit(request), () => {}, request => lg!.assessGroupReply(request))
  await wx.poll()
  wxMessages.push({ localId: 1, chatId: '111@chatroom', sender: 'wxid_alice', type: 1, content: 'fixture',
    timestamp: new Date().toISOString(), isSelf: false, isMentioned: true })
  await wx.poll()
  assert.equal(prompts.at(-1)?.qq, false, 'WeChat shares qq_private entryKey but must not receive QQ media protocol')
  assert.equal(wxText, '离线测试正文，数字 42 不应改变。')
  checks.push('wechat: shared core entry does not enable QQ protocol')
  assert.ok(semanticInputs.some(row => row.current === 'voice' && row.voice && row.explanation))
  assert.ok(semanticInputs.some(row => row.current === 'avatar' && !row.voice && !row.explanation))
  assert.ok(semanticInputs.some(row => row.current === 'wechat' && !row.voice && !row.explanation))
  checks.push('semantic entry: QQ reply voice is visible as presentation, absent on avatar/WeChat')
  const rows = (await pool.query("select content from conversation_events where actor_type='character'")).rows
  assert.ok(rows.length >= 5)
  assert.ok(!JSON.stringify(rows).includes('<lg-qq-media>'))
  checks.push('conversation ledger: canonical text only')
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ status: 'PASS', checks, prompts, semanticInputs, database: 'isolated pgtest',
    model: 'local fixed fixture', tts: 'local fixed WAV', qq: 'local OneBot fixture' }, null, 2))
  console.log(`PASS QQ voice real main ${checks.length} controls: ${out}`)
} catch (error) {
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ status: 'FAIL', checks, error: String(error), prompts }, null, 2))
  throw error
} finally {
  avatar?.close(); await qq?.close(); await lg?.close()
  await host.stop().catch(() => host.kill()); await pool.end()
  for (const socket of ws.clients) socket.terminate()
  await new Promise<void>(done => ws.close(done))
  for (const server of [model, tts, wxApi]) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
}
