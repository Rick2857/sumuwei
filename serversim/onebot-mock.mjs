// ============================================================================
//  服务器仿真环境 · 假 OneBot v11 服务端（2026-10-20）
// ============================================================================
//
//  它扮演的角色：服务器上的 **NapCat 容器**。
//  NapCat 做的是「把 QQ 平台翻译成 OneBot v11 协议」；仿真里我们不需要真的 QQ，
//  只需要**协议面**逐字一致 ⇒ 核心侧那条 QQ 链路（外壳 → WS → 动作 → 投递）
//  在仿真里跑的是**同一段代码**。
//
//  ---------------------------------------------------------------------------
//  ⚠️ 它**不**能证明的事（必须如实说）
//  ---------------------------------------------------------------------------
//  · 不证明 NapCat / QQNT 的协议行为（扫码、风控、掉线、被踢）—— 那些是真实
//    平台侧的事，服务器上已经发生过 `KickedOffLine`（10-07 读数）。
//  · 不证明消息真的送达真人。只证明"平台接受了这次投递并回了回执 id"。
//  · 假 OneBot **不会**主动给真人发消息；它只回放我们注入的事件。
//
//  ---------------------------------------------------------------------------
//  协议对照（逐条抄自 src/infrastructure/qq/onebot-private-client.ts）
//  ---------------------------------------------------------------------------
//  · 连接：`ws://127.0.0.1:6701/?access_token=<token>`（token 在 query 里）
//  · 动作帧：`{ action, params, echo }` ⇒ 回帧必须带**同一个 echo**
//  · 成功回帧：`{ status: 'ok', retcode: 0, data: {...}, echo }`
//    （客户端判据是 `status==='ok' && retcode===0 && data` 是对象）
//  · `get_login_info` 的 `data.user_id` **必须等于** `QQ_BOT_ID`
//    （不等 ⇒ 客户端抛 `onebot_bot_account_mismatch`）
//  · `send_private_msg` / `send_group_msg` 的 `data.message_id` 必须是
//    数字或纯数字字符串（否则抛 `qq_delivery_unconfirmed`）
//  · 事件帧（没有 echo）：`post_type:'message'` + `message_type:'private'`
//    + `sub_type:'friend'` + `self_id` + `user_id` + `message_id`
//    + `message:[{type:'text',data:{text}}]` + `sender:{user_id}`
//
//  ⚠️ WebSocket 服务端**自己实现**：Node 22 只有 WebSocket **客户端**
//     （undici），没有服务端；仓库里也没有 `ws` 依赖（OneBot 客户端刻意
//     用原生 API）。依赖一个传递依赖（node_modules/.pnpm 里确实有 ws@8.22.0，
//     但它不是顶层依赖，pnpm 的严格布局下不可解析）会让仿真在别的机器上
//     突然起不来 —— 所以这里按 RFC 6455 手写最小实现。
// ============================================================================

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const WS_PORT = Number(process.env.SIM_ONEBOT_WS_PORT ?? 6701)
const CONTROL_PORT = Number(process.env.SIM_ONEBOT_CONTROL_PORT ?? 6101)
const TOKEN = process.env.QQ_ONEBOT_ACCESS_TOKEN ?? ''
const BOT_ID = process.env.QQ_BOT_ID ?? ''
const OWNER_ID = process.env.QQ_OWNER_ID ?? ''

if (TOKEN.length < 24) { console.error('[onebot-mock] QQ_ONEBOT_ACCESS_TOKEN 至少 24 个安全字符'); process.exit(2) }
if (!/^[1-9]\d{4,19}$/.test(BOT_ID)) { console.error('[onebot-mock] QQ_BOT_ID 必须是合法 QQ 号'); process.exit(2) }

// ---------------------------------------------------------------------------
//  最小 WebSocket 服务端（RFC 6455）
// ---------------------------------------------------------------------------
/*
 * RFC 6455 §1.3 的 magic GUID。
 * ⚠️ 这一串**极易手打错**（实测 2026-10-20 踩过：末尾两段写成
 *    `5AB0DC85B11F`，正确是 `C5AB0DC85B11`）⇒ 手打错的症状是
 *    客户端报 "Incorrect hash received in Sec-WebSocket-Accept header"，
 *    而**服务端看起来一切正常**（握手"成功"了、连接数在涨）。
 * ⇒ 下面有 RFC §1.3 的标准向量自检：算错就**启动即失败**，不给它进容器。
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function websocketAccept (key) { return createHash('sha1').update(key + GUID).digest('base64') }

// RFC 6455 §1.3 的标准向量：key → accept
if (websocketAccept('dGhlIHNhbXBsZSBub25jZQ==') !== 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=') {
  console.error('[onebot-mock] Sec-WebSocket-Accept 计算与 RFC 6455 §1.3 标准向量不符')
  console.error('   ⇒ 拒绝启动（宁可明确失败，也不要让每个客户端都报"hash 不对"）')
  process.exit(2)
}

function encodeFrame (opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) { header = Buffer.alloc(2); header[1] = length } else if (length < 65536) {
    header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(length, 2)
  } else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2) }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

class WsConnection {
  constructor (socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.listeners = new Map()
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain() })
    socket.on('close', () => this.emit('close'))
    socket.on('error', () => this.emit('close'))
  }

  on (event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(handler)
  }

  emit (event, payload) {
    for (const handler of this.listeners.get(event) ?? []) handler(payload)
  }

  send (text) { if (!this.socket.destroyed) this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8'))) }

  drain () {
    for (;;) {
      const buffer = this.buffer
      if (buffer.length < 2) return
      const fin = (buffer[0] & 0x80) !== 0
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) { if (buffer.length < offset + 2) return; length = buffer.readUInt16BE(offset); offset += 2 } else if (length === 127) {
        if (buffer.length < offset + 8) return
        length = Number(buffer.readBigUInt64BE(offset)); offset += 8
      }
      let maskKey
      if (masked) { if (buffer.length < offset + 4) return; maskKey = buffer.subarray(offset, offset + 4); offset += 4 }
      if (buffer.length < offset + length) return
      let payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
      this.buffer = buffer.subarray(offset + length)
      this.handleFrame(fin, opcode, payload)
    }
  }

  handleFrame (fin, opcode, payload) {
    if (opcode === 0x8) { this.socket.end(encodeFrame(0x8, Buffer.alloc(0))); this.socket.destroy(); return }
    if (opcode === 0x9) { this.socket.write(encodeFrame(0xa, payload)); return }
    if (opcode === 0xa) return
    if (opcode === 0x0) { this.fragments.push(payload); if (!fin) return; payload = Buffer.concat(this.fragments); this.fragments = []; this.emit('message', payload.toString('utf8')); return }
    if (opcode === 0x1) { if (!fin) { this.fragments = [payload]; return } this.emit('message', payload.toString('utf8')) }
  }
}

// ---------------------------------------------------------------------------
//  状态
// ---------------------------------------------------------------------------
/** @type {Set<WsConnection>} */
const connections = new Set()
/** 核心发出去的消息（agent 用来断言"她确实回了"） */
const sent = []
/** 核心调过的 OneBot 动作 */
const calls = []
let messageIdSeq = 1000

function log (event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'onebot-mock', event, ...extra }))
}

// ---------------------------------------------------------------------------
//  WS 服务端
// ---------------------------------------------------------------------------
const wsServer = createServer((request, response) => {
  response.writeHead(426, { 'content-type': 'text/plain' })
  response.end('onebot-mock: WebSocket only\n')
})

wsServer.on('upgrade', (request, socket) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.searchParams.get('access_token') !== TOKEN) {
    log('ws_rejected_bad_token', { path: url.pathname })
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || !key) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
  const accept = websocketAccept(key)
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  )
  socket.setNoDelay(true)
  const connection = new WsConnection(socket)
  connections.add(connection)
  connection.on('close', () => connections.delete(connection))
  connection.on('message', raw => {
    let request2
    try { request2 = JSON.parse(raw) } catch { return }
    if (!request2 || typeof request2 !== 'object') return
    const action = String(request2.action ?? '')
    const params = request2.params ?? {}
    const echo = typeof request2.echo === 'string' ? request2.echo : undefined
    calls.push({ at: new Date().toISOString(), action, params: summarize(params) })
    const reply = (data) => connection.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }))
    switch (action) {
      case 'get_login_info':
        reply({ user_id: Number(BOT_ID), nickname: 'serversim-bot' })
        return
      case 'get_status':
        reply({ online: true, good: true })
        return
      case 'get_friend_list':
        reply([{ user_id: Number(OWNER_ID || 10000), nickname: 'serversim-owner' }])
        return
      case 'get_group_member_info':
        reply({ user_id: Number(params.user_id), group_id: Number(params.group_id), nickname: 'serversim-member' })
        return
      case 'get_image':
        reply({ file: 'serversim://image', url: 'http://127.0.0.1/never-used' })
        return
      case 'send_private_msg':
      case 'send_group_msg': {
        const messageId = messageIdSeq++
        const text = extractText(params.message)
        sent.push({ at: new Date().toISOString(), action, messageId, userId: params.user_id, groupId: params.group_id, text })
        log('sent', { messageId, action, chars: text.length })
        reply({ message_id: messageId })
        return
      }
      default:
        connection.send(JSON.stringify({ status: 'failed', retcode: 1404, data: null, echo, message: `unsupported action: ${action}` }))
    }
  })
  log('ws_connected', { clients: connections.size })
})

/** 只留可断言的摘要，不留原文（隐私纪律：日志里不落用户原话） */
function summarize (params) {
  const out = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key === 'message') { out.message = Array.isArray(value) ? value.map(p => ({ type: p?.type, chars: String(p?.data?.text ?? '').length })) : '(not-array)'; continue }
    out[key] = value
  }
  return out
}

function extractText (message) {
  if (!Array.isArray(message)) return ''
  return message.filter(p => p?.type === 'text').map(p => String(p?.data?.text ?? '')).join('')
}

// ---------------------------------------------------------------------------
//  控制面（宿主机侧用它注入消息、读回"她回了什么"）
//  端口 6101 —— 与服务器上 NapCat WebUI 的端口**同号**，保持拓扑同形。
// ---------------------------------------------------------------------------
const control = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const reply = (code, body) => {
    const payload = JSON.stringify(body)
    response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    response.end(payload)
  }
  if (url.pathname === '/health') { reply(200, { ok: true, clients: connections.size, sent: sent.length, calls: calls.length }); return }
  if (url.pathname === '/sent') { reply(200, { sent }); return }
  if (url.pathname === '/calls') { reply(200, { calls }); return }
  if (url.pathname === '/reset' && request.method === 'POST') { sent.length = 0; calls.length = 0; reply(200, { ok: true }); return }
  if (url.pathname === '/inject' && request.method === 'POST') {
    let body = ''
    for await (const chunk of request) body += chunk
    let payload
    try { payload = JSON.parse(body) } catch { reply(400, { error: 'invalid_json' }); return }
    const text = String(payload.text ?? '')
    if (!text) { reply(400, { error: 'text_required' }); return }
    const userId = String(payload.userId ?? OWNER_ID)
    const messageType = payload.messageType === 'group' ? 'group' : 'private'
    const messageId = messageIdSeq++
    const event = {
      time: Math.floor(Date.now() / 1000),
      self_id: Number(BOT_ID),
      post_type: 'message',
      message_type: messageType,
      sub_type: messageType === 'group' ? 'normal' : 'friend',
      message_id: messageId,
      user_id: Number(userId),
      group_id: messageType === 'group' ? Number(payload.groupId ?? 0) : undefined,
      raw_message: text,
      message: [{ type: 'text', data: { text } }],
      sender: { user_id: Number(userId), nickname: 'serversim-owner' },
    }
    if (event.group_id === undefined) delete event.group_id
    for (const connection of connections) connection.send(JSON.stringify(event))
    log('injected', { messageId, messageType, clients: connections.size })
    reply(200, { ok: true, messageId, deliveredTo: connections.size })
    return
  }
  reply(404, { error: 'not_found' })
})

// ⚠️ 监听 0.0.0.0（不是 127.0.0.1）：仿真主机里的**环回转发器**按 compose
//    网络的 DNS 名连过来（`onebot:6701`），必须能连上容器的实际地址。
//    暴露面仍然只有 compose 网络内部 + 宿主机经 simhost 的 loopback 转发。
wsServer.listen(WS_PORT, '0.0.0.0', () => log('ws_listening', { port: WS_PORT }))
control.listen(CONTROL_PORT, '0.0.0.0', () => log('control_listening', { port: CONTROL_PORT }))

const shutdown = () => { log('stopping'); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
