/** Real main/QQ/WeChat clients and PostgreSQL; fixed model plus synthetic platform APIs. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import pg from 'pg'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { startCoexistHost, delay, ROOT } from './coexist/harness.ts'
import { LgStdioClient } from '../src/infrastructure/qq/lg-stdio-client.ts'
import { OneBotPrivateClient } from '../src/infrastructure/qq/onebot-private-client.ts'
import { WechatGroupClient, type WechatMessage } from '../src/infrastructure/wechat/group-client.ts'

assert.equal(process.env.CHARACTER_DB_BACKEND, 'postgres')
assert.match(new URL(process.env.LG_TEST_PG_URL!).pathname, /^\/lg_test_/)
const sandbox = isolateDatabase('relay-main', { postgres: { url: process.env.LG_TEST_PG_URL! } })
const pool = new pg.Pool({ connectionString: process.env.LG_TEST_PG_URL })
const owner = '123456789', bot = '987654321', member = '222222222', group = '333333333'
const wxGroup = '111@chatroom', wxOwner = 'wxid_owner', wxBot = 'wxid_bot', wxSender = 'wxid_alice'
const wxMessages: WechatMessage[] = []
const sends: { action: string; target: string; text: string }[] = []
const modelInputs: { current: { id: string; text: string }; origin: { transport: string }; tasks: unknown[] }[] = []
const prompts: string[] = []
const model = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}')
  const system = String(body.messages?.[0]?.content ?? '')
  let content: string
  if (system.includes('转告任务决策器')) {
    const input = JSON.parse(body.messages.at(-1).content)
    modelInputs.push(input)
    const text = input.current.text
    const outgoing = text.includes('fixture-wx-request') ? '微信Alice托我告诉你，明天下午三点开会。'
      : text.includes('fixture-qq-request') ? 'QQ同事的原话：“周五见。”' : undefined
    content = JSON.stringify(outgoing ? { kind: 'create', requestSourceId: input.current.id, sourceIds: [input.current.id],
      mode: input.origin.transport === 'wechat' ? 'summary' : 'verbatim', text: outgoing }
      : text === 'fixture-list' ? { kind: 'list' } : { kind: 'none' })
  } else if (system.includes('判断此刻是否愿意接话')) content = JSON.stringify({ reply: true })
  else if (system.includes('提醒请求解析器')) content = JSON.stringify({ kind: 'none' })
  else { prompts.push(raw); content = '<response><text>这是模型自行选择的回复。</text></response>' }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }] }))
})
const wxApi = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname)
  let result: unknown
  if (path === '/api/status/auth') result = { status: 'logged_in', loggedInUser: wxBot + '_1234' }
  else if (path.startsWith('/api/chats/')) result = { id: wxGroup, isGroup: true }
  else if (path === '/api/messages/send') {
    let raw = ''; for await (const chunk of req) raw += chunk
    const data = JSON.parse(raw); assert.equal(data.chatId, wxGroup)
    sends.push({ action: 'wechat_group_reply', target: data.chatId, text: data.text }); result = { success: true }
  } else result = wxMessages
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result))
})
await Promise.all([new Promise<void>(done => model.listen(0, '127.0.0.1', done)), new Promise<void>(done => wxApi.listen(0, '127.0.0.1', done))])
const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws')
const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
const sockets = new Set<{ send: (text: string) => void; close: () => void }>()
let nextMessage = 100
wsServer.on('connection', (socket: { on: (event: string, cb: (data: unknown) => void) => void; send: (text: string) => void; close: () => void }) => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket))
  socket.on('message', raw => {
    const request = JSON.parse(String(raw))
    let data: unknown = {}
    if (request.action === 'get_login_info') data = { user_id: bot }
    else if (request.action === 'get_group_member_info') data = { user_id: request.params.user_id, group_id: request.params.group_id }
    else if (request.action === 'send_private_msg' || request.action === 'send_group_msg') {
      sends.push({ action: request.action, target: String(request.params.user_id ?? request.params.group_id),
        text: request.params.message.map((part: { data: { text?: string } }) => part.data.text ?? '').join('') })
      data = { message_id: ++nextMessage }
    }
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }))
  })
})
await new Promise<void>(done => wsServer.once('listening', done))
const wsUrl = `ws://127.0.0.1:${wsServer.address().port}/`
const wxConfig = { baseUrl: `http://127.0.0.1:${(wxApi.address() as { port: number }).port}`, token: 'fixture-wechat-token-123456789',
  botId: wxBot, ownerId: wxOwner, groupIds: [wxGroup], stateFile: resolve(sandbox.dir, 'relay-wx-seen.json') }
const host = await startCoexistHost({ dbDir: sandbox.dir, modelPort: (model.address() as { port: number }).port, env: {
  CHARACTER_QQ_PROACTIVE_MODE: 'on', CHARACTER_RELAY_TASKS_ENABLED: 'true', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false',
  CHARACTER_CONTEXT_COMPILER_V1: 'true', CHARACTER_RELATIONSHIP_CONTEXT_ENABLED: 'true', CHARACTER_ACTION_ENABLED: 'true',
  QQ_MULTI_USER_ENABLED: 'true', QQ_ALLOWED_GROUP_IDS: group, QQ_ONEBOT_WS_URL: wsUrl,
  WECHAT_ENABLED: 'true', WECHAT_API_URL: wxConfig.baseUrl, WECHAT_API_TOKEN: wxConfig.token,
  WECHAT_BOT_ID: wxBot, WECHAT_OWNER_ID: wxOwner, WECHAT_ALLOWED_GROUP_IDS: wxGroup, WECHAT_STATE_FILE: wxConfig.stateFile,
} })
let lg: LgStdioClient | undefined, qq: OneBotPrivateClient | undefined, wx: WechatGroupClient | undefined
const until = async (test: () => boolean | Promise<boolean>, label: string) => {
  for (let n = 0; n < 200; n++) { if (await test()) return; await delay(100) }
  throw new Error(`timeout: ${label}`)
}
try {
  await host.ready
  lg = new LgStdioClient(ROOT, process.env, { connect: { host: '127.0.0.1', port: host.qqPort, token: host.qqToken } })
  qq = new OneBotPrivateClient({ ownerId: owner, botId: bot, wsUrl, token: 'offline-coexist-qq-token-1234567890',
    multiUserEnabled: true, allowedGroupIds: [group] }, request => lg!.submit(request), () => {})
  lg.setQqDeliveryHandler(async out => qq!.deliverProactiveText(out.text))
  await lg.ready; await qq.connect()
  wx = new WechatGroupClient(wxConfig, request => lg!.submit(request), () => {}, request => lg!.assessGroupReply(request))
  await wx.poll()
  wxMessages.push({ localId: 1, chatId: wxGroup, sender: wxSender, type: 1, content: 'fixture-wx-request：明天下午三点开会，这件事请你帮忙带到。',
    timestamp: new Date().toISOString(), isSelf: false, isMentioned: true })
  await wx.poll()
  await until(() => sends.some(item => item.action === 'send_private_msg' && item.text.startsWith('微信Alice')), 'WeChat -> owner QQ')
  for (const socket of sockets) socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: bot, user_id: member, sender: { user_id: member }, group_id: group, message_id: 42, message: [
      { type: 'at', data: { qq: bot } }, { type: 'text', data: { text: 'fixture-qq-request：周五见。' } },
    ] }))
  await until(() => sends.some(item => item.action === 'send_private_msg' && item.text.startsWith('QQ同事')), 'QQ group -> owner QQ')
  await until(async () => Number((await pool.query("select count(*)::int n from notification_occurrences where kind='relay' and state='api_accepted'")).rows[0].n) === 2, 'two recorded platform receipts')
  await delay(300)
  assert.ok(!host.stdout.some(line => line.includes('qq_delivery_already_settled')), 'receipt acknowledgements must not create another delivery report')
  const outbound = sends.filter(item => item.text.startsWith('微信Alice') || item.text.startsWith('QQ同事'))
  assert.equal(outbound.length, 2)
  assert.ok(outbound.every(item => item.action === 'send_private_msg' && item.target === owner), 'relay payload only to bound owner QQ')
  const rows = (await pool.query("select kind,delivery_channel,relay_metadata from notification_intents where kind='relay'")).rows
  assert.equal(rows.length, 2)
  assert.deepEqual(new Set(rows.map(row => row.relay_metadata.transport)), new Set(['qq', 'wechat']))
  assert.deepEqual(new Set(rows.map(row => row.relay_metadata.mode)), new Set(['summary', 'verbatim']))
  assert.ok(modelInputs.some(input => input.origin.transport === 'qq') && modelInputs.some(input => input.origin.transport === 'wechat'))
  assert.ok(prompts.some(prompt => prompt.includes('本轮转告任务事实') && prompt.includes('created')))
  // Model opts out despite the visible word 转告. No keyword rule may create a task.
  const ownerFacts = { transport: 'qq' as const, selfId: bot, senderUserId: owner, messageType: 'private' as const }
  const ignored = await lg.submit({ requestId: 'relay-none', userText: '“转告”只是一个例子，不用执行。', platformFacts: ownerFacts })
  assert.equal(ignored.outcome, 'replied', JSON.stringify(ignored))
  assert.equal((await pool.query("select count(*)::int n from notification_intents where kind='relay'")).rows[0].n, 2)
  const listed = await lg.submit({ requestId: 'relay-list', userText: 'fixture-list', platformFacts: ownerFacts })
  assert.equal(listed.outcome, 'replied', JSON.stringify(listed)); assert.equal(listed.replyText, '这是模型自行选择的回复。')
  assert.ok(prompts.at(-1)!.includes('api_accepted') && prompts.at(-1)!.includes('微信Alice'))
  assert.equal((await pool.query("select count(*)::int n from conversation_events where content like '微信Alice%' or content like 'QQ同事%'")).rows[0].n, 0, 'outbound delivery is not fabricated inbound/chat history')
  console.log('PASS real main: admitted QQ-group and WeChat-group requests -> model decisions -> durable relay tasks -> real Gateway/client -> synthetic QQ private send -> stored receipts -> owner context; no template or fake conversation events')
} catch (error) {
  console.error(host.stdout.slice(-20).join('\n'), host.stderr.slice(-20).join('\n'))
  throw error
} finally {
  wx?.stop(); await qq?.close(); await lg?.close()
  if (host.child.exitCode === null) await host.stop()
  await pool.end()
  for (const socket of sockets) socket.close()
  await new Promise<void>(done => wsServer.close(() => done()))
  model.closeAllConnections(); wxApi.closeAllConnections(); model.close(); wxApi.close()
}
