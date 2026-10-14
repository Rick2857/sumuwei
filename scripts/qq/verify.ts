/** Offline integration: real local WebSocket + real main.ts + fresh isolated database. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readQqPrivateConfig } from '../../src/infrastructure/qq/private-config.ts'
import { OneBotPrivateClient } from '../../src/infrastructure/qq/onebot-private-client.ts'
import { LgStdioClient } from '../../src/infrastructure/qq/lg-stdio-client.ts'
import { conversationEntryModeOf, createHumanQqPrivateUserTurnIngress } from '../../src/infrastructure/runtime/conversation-attribution.ts'
import { isolateDatabase, cleanupSandbox, PRODUCTION_DB_DIR } from '../../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../../src/infrastructure/persistence/production-db-safety.ts'

const root = resolve(import.meta.dirname, '../..')
const before = digestTree(PRODUCTION_DB_DIR).treeSha256
// Reuse the installed ws implementation used by jsdom; production needs no extra dependency.
const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws')
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise<void>((done) => server.once('listening', done))
const env = {
  QQ_OWNER_ID: '123456789', QQ_BOT_ID: '987654321',
  QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${server.address().port}/`, QQ_ONEBOT_ACCESS_TOKEN: 'offline-qq-fixture-token-123456',
}
const settings = readQqPrivateConfig(env)
assert.throws(() => readQqPrivateConfig({ ...env, QQ_OWNER_ID: env.QQ_BOT_ID }))
assert.throws(() => readQqPrivateConfig({ ...env, QQ_ONEBOT_ACCESS_TOKEN: '' }))
assert.throws(() => readQqPrivateConfig({ ...env, QQ_ONEBOT_WS_URL: 'ws://example.com/' }))
assert.throws(() => conversationEntryModeOf(['--qq-private']))
assert.throws(() => conversationEntryModeOf(['--bridge', '--qq-private', 'agent supplied text']))
assert.equal(conversationEntryModeOf(['--bridge', '--qq-private']), 'interactive_human_qq_private')
assert.throws(() => createHumanQqPrivateUserTurnIngress().attest({ characterId: 'c', presenterActorId: 'wrong', userId: 'u' }))

let socket: any
let loginId = settings.botId
let failSend = false
const sent: { user_id: string; message: { type: string; data: { text: string } }[] }[] = []
server.on('connection', (connection: any, request: { url: string }) => {
  assert.equal(new URL(request.url, 'http://localhost').searchParams.get('access_token'), settings.token)
  socket = connection
  connection.on('message', (raw: Buffer) => {
    const packet = JSON.parse(raw.toString())
    if (packet.action === 'get_login_info') {
      connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: loginId }, echo: packet.echo }))
      return
    }
    if (packet.action === 'get_image') {
      connection.send(JSON.stringify({ status: 'failed', retcode: 1, data: {}, echo: packet.echo }))
      return
    }
    assert.equal(packet.action, 'send_private_msg')
    sent.push(packet.params)
    connection.send(JSON.stringify({ status: failSend ? 'failed' : 'ok', retcode: failSend ? 1 : 0,
      data: { message_id: sent.length }, echo: packet.echo }))
    failSend = false
  })
})
const readings: { event: string; requestId?: string; messageId?: string | number }[] = []
const waitFor = async (test: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt++) { if (test()) return; await delay(10) }
  throw new Error('QQ fixture timeout')
}
const message = (id: number, overrides: Record<string, unknown> = {}): void => socket.send(JSON.stringify({
  post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: settings.botId,
  user_id: settings.ownerId, sender: { user_id: settings.ownerId }, message_id: id,
  message: [{ type: 'text', data: { text: '私聊文字 [CQ:at,qq=123] 中文🙂' } }], ...overrides,
}))
let calls = 0
let active = 0
let peak = 0
let failTurn = false
const client = new OneBotPrivateClient(settings, async (request) => {
  calls++; active++; peak = Math.max(peak, active)
  await delay(10)
  active--
  if (failTurn) { failTurn = false; throw new Error('fixture-model-failed') }
  return { kind: 'TURN_RESULT', requestId: request.requestId, outcome: 'replied', replyText: request.userText,
    replyId: 'fixture-reply', traceId: 'fixture-trace' }
}, (reading) => readings.push(reading))
let lg: LgStdioClient | undefined
let realClient: OneBotPrivateClient | undefined
let sandbox: string | undefined
const model = createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume request without retaining prompt text */ }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content: '<response><text>我已经记住了。</text></response>' } }] }))
})
try {
  loginId = '111111111'
  await assert.rejects(client.connect(), /onebot_bot_account_mismatch/)
  await waitFor(() => socket.readyState === 3)
  loginId = settings.botId
  await client.connect()
  message(1, { user_id: '111111111', sender: { user_id: '111111111' } })
  message(2, { message_type: 'group', group_id: 12345 })
  message(3, { self_id: '111111111' })
  message(4, { sender: { user_id: '111111111' } })
  message(5, { post_type: 'message_sent' })
  message(6, { sub_type: 'group' })
  message(7, { message: [{ type: 'image', data: { file: 'untrusted' } }] })
  message(8)
  message(8)
  await waitFor(() => sent.length === 2)
  await client.drain()
  assert.equal(calls, 1)
  assert.equal(sent[1]!.message[0]!.data.text, '私聊文字 [CQ:at,qq=123] 中文🙂')
  assert.equal(sent[1]!.message[0]!.type, 'text')
  assert(readings.some((reading) => reading.event === 'qq_duplicate_ignored'))
  message(9); message(10)
  await waitFor(() => sent.length === 4)
  await client.drain()
  assert.equal(peak, 1)
  failTurn = true
  message(11)
  await waitFor(() => sent.length === 5)
  await client.drain()
  assert(sent[4]!.message[0]!.data.text.includes('可能已经记入会话'))
  failSend = true
  message(12)
  await waitFor(() => readings.some((reading) => reading.event === 'qq_delivery_failed'))
  message(13)
  await waitFor(() => sent.length === 7)
  await client.drain()
  assert.equal(calls, 6)
  assert(sent.every((packet) => packet.user_id === settings.ownerId))
  await client.close()

  await new Promise<void>((done) => model.listen(0, '127.0.0.1', done))
  const modelPort = (model.address() as { port: number }).port
  sandbox = isolateDatabase('qq-private-verify', { keep: true }).dir
  const features = Object.fromEntries([...readFileSync(resolve(root, 'src/kernel/app/flags.ts'), 'utf8')
    .matchAll(/env\.(CHARACTER_[A-Z_]+_ENABLED)/g)].map((match) => [match[1]!, 'false']))
  /*
   * ⚠️ **子进程必须显式钉死后端**（2026-10-14 实测修）。
   *
   * 子进程的 `cwd` 是仓库根 ⇒ `src/db/index.ts` 会在开库前重读 `<cwd>/.env`；
   * 而 `.env` 里 `CHARACTER_DB_BACKEND=postgres` ⇒ 本门以为的"目录沙箱"对子进程**不成立**，
   * 它会去连**生产 PostgreSQL**（实测读数：`[db] 后端 postgres，身份核对通过：database=sumuwei`），
   * 只是被"单认知执行者资格锁"挡下才没写进去。
   * 这里按 `u1-*` 门的同一套跑法把后端钉成 pglite（dotenv **不覆盖**已存在的环境变量）。
   * ⚠️ 光钉后端还不够：`.env` 的 `LG_PG_EXPECT_DATABASE=sumuwei` 同样会漏进子进程，
   *    而 `initDatabaseInner()` 的**身份核对是按"有没有期望值"触发的**（不按后端）⇒
   *    PGlite 句柄会被拿去做 PG 身份核对（`实际 template1`）⇒ 核心照样起不来。
   *    所以期望值那几项也要一并清空。
   */
  lg = new LgStdioClient(root, {
    ...process.env, ...features, ...env,
    CHARACTER_DB_BACKEND: 'pglite', POSTGRES_URL: '', DATABASE_URL: '',
    LG_PG_EXPECT_DATABASE: '', LG_PG_EXPECT_USER: '', LG_PG_EXPECT_DATABASE_PREFIX: '', LG_PG_EXPECT_USER_PREFIX: '',
    PGLITE_DATA_DIR: sandbox, PROJECT_LG_SANDBOX: sandbox,
    USER_NAME: 'qq-fixture-owner', OPENAI_API_KEY: 'offline-local-fixture',
    OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}`, OPENAI_LARGE_MODEL: 'offline-fixture', OPENAI_SMALL_MODEL: 'offline-fixture',
    CHARACTER_KERNEL_ENABLED: 'true', CHARACTER_MEMORY_ENABLED: 'true', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'true',
    CHARACTER_TOOL_DECISION_MODE: 'rules', CHARACTER_MEMORY_SEMANTIC_MODE: 'off', LOG_LEVEL: 'fatal',
    CHARACTER_EXPRESSIVE_SPEECH: 'false', CHARACTER_ROLLUP_TOKENS: '0',
  })
  await lg.ready
  realClient = new OneBotPrivateClient(settings, (request) => lg!.submit(request), (reading) => readings.push(reading))
  await realClient.connect()
  const countBefore = sent.length
  // Use an unsupported slot; institution phrases are now supported by content-rules@8.
  message(100, { message: [{ type: 'text', data: { text: '请记住，我的幸运口令是星河31427。' } }] })
  message(100)
  await waitFor(() => sent.length === countBefore + 1)
  await realClient.drain()
  assert.match(sent.at(-1)!.message[0]!.data.text, /没有确认新的记录写入成功|这次没有写入/)
  message(101, { message: [{ type: 'text', data: { text: '记住：我在示例工程科技大学' } }] })
  await waitFor(() => sent.length === countBefore + 2)
  await realClient.drain()
  const e2eReply = sent.at(-1)!.message[0]!.data.text
  await realClient.close()
  assert.equal(await lg.close(), 0)
  const db = await openRawPGlite(sandbox)
  let evidence: Record<string, unknown>
  try {
    assert.equal(e2eReply, '我已经记住了。')
    const events = (await db.query('select actor_type, conversation_sequence, metadata, actor_id, content_originator_id from conversation_events order by conversation_sequence')).rows as Record<string, any>[]
    assert.equal(events.length, 4)
    assert.deepEqual(events.map((event) => event.conversation_sequence), [1, 2, 3, 4])
    assert.equal(events[0]!.metadata.transport, 'qq')
    assert.equal(events[0]!.actor_id, events[0]!.content_originator_id)
    const mappings = (await db.query("select transport, external_id, user_id from user_identity_mappings where transport = 'qq'")).rows as Record<string, any>[]
    assert.equal(mappings.length, 1)
    assert.equal(mappings[0]!.external_id, settings.ownerId)
    assert.equal(mappings[0]!.user_id, events[0]!.actor_id)
    const memory = (await db.query('select count(*) as count from memory_records')).rows as { count: number }[]
    assert.equal(Number(memory[0]!.count), 1)
    evidence = { conversationEvents: events.length, sequences: events.map((event) => event.conversation_sequence),
      transport: 'qq', sameDomainUser: true, qqIdentityMappings: mappings.length, memoryRecords: Number(memory[0]!.count),
      unsupportedMemoryPhraseTruthfullyGuarded: true }
  } finally { await db.close() }
  assert.equal(digestTree(PRODUCTION_DB_DIR).treeSha256, before)
  const out = resolve(root, 'artifacts/post-lv2', `qq-private-verify-${new Date().toISOString().replace(/\D/g, '')}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ status: 'PASS', scope: 'offline OneBot fixture + real main.ts + fresh isolated DB',
    productionDatabaseOpened: false, productionTreeUnchanged: true, realQq: 'NOT RUN', externalModel: 'NOT RUN',
    controls: ['configuration', 'bot login mismatch', 'owner allowlist', 'groups', 'sender mismatch', 'self messages',
      'temporary chats', 'non-text messages', 'duplicates', 'serial turns', 'failed turn recovery', 'failed send recovery', 'plain text CQ escaping'],
    e2e: evidence }, null, 2) + '\n')
  console.log(`PASS: QQ private controls + real LG turn/identity/memory; production tree unchanged\n${out}`)
} finally {
  await client.close()
  await realClient?.close()
  if (lg) await lg.close()
  model.closeAllConnections()
  if (model.listening) await new Promise<void>((done) => model.close(() => done()))
  for (const connection of server.clients) connection.terminate()
  await new Promise<void>((done) => server.close(() => done()))
  if (sandbox) cleanupSandbox(sandbox)
}
