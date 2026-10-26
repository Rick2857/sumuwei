// ============================================================================
//  服务器仿真环境 · 假微信桥 API（2026-10-20）
// ============================================================================
//
//  它扮演的角色：服务器上的 **微信桥容器**（/opt/lg-wechat-bridge，API 绑
//  127.0.0.1:16174）。上游是 Rust 写的 agent-wechat，真的去驱动微信客户端；
//  仿真里不可能也不该驱动真人微信，于是只做**协议面**。
//
//  ---------------------------------------------------------------------------
//  协议对照（逐条抄自 src/infrastructure/wechat/group-client.ts）
//  ---------------------------------------------------------------------------
//  · 所有 /api/* 请求带 `Authorization: Bearer <token>`；**无鉴权必须 401**
//    （10-16 部署记录的实测口径："无鉴权查询实际返回 401"）
//  · `GET  /api/status/auth`            ⇒ `{ status: 'logged_in', loggedInUser: <botId> }`
//  · `GET  /api/chats/:groupId`         ⇒ `{ id: <groupId>, isGroup: true }`
//  · `GET  /api/messages/:groupId?limit=` ⇒ 消息数组
//  · `POST /api/messages/send` {chatId,text} ⇒ `{ success: true }`
//
//  消息对象形状（客户端 `validWechatMessage` 的硬要求）：
//  `{ localId>0, chatId, sender, type:1, content, timestamp(ISO), isSelf:false }`
//  ⚠️ `timestamp` 必须在**最近 5 分钟内**（客户端会拒绝更旧的）——
//     所以注入时用当前时间生成，不要写死。
//
//  ---------------------------------------------------------------------------
//  ⚠️ 它**不**能证明的事
//  ---------------------------------------------------------------------------
//  · 不证明上游 Rust 桥的真实行为（登录确认、群消息读取、SQLCipher 库）。
//  · 不证明微信侧的送达。
// ============================================================================

import { createServer } from 'node:http'

const PORT = Number(process.env.SIM_WECHAT_PORT ?? 16174)
const TOKEN = process.env.WECHAT_API_TOKEN ?? ''
const BOT_ID = process.env.WECHAT_BOT_ID ?? ''
const OWNER_ID = process.env.WECHAT_OWNER_ID ?? ''
const GROUPS = (process.env.WECHAT_ALLOWED_GROUP_IDS ?? '').split(/[,\s]+/).filter(Boolean)

if (TOKEN.length < 24) { console.error('[wechat-mock] WECHAT_API_TOKEN 至少 24 个安全字符'); process.exit(2) }
if (!BOT_ID) { console.error('[wechat-mock] WECHAT_BOT_ID 未设置'); process.exit(2) }

const sent = []
const injected = []
let localId = 1

function log (event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'wechat-mock', event, ...extra }))
}

function authorized (request) {
  const header = request.headers.authorization ?? ''
  return header === `Bearer ${TOKEN}`
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const json = (code, body) => {
    response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }

  // ---- 仿真控制面（loopback-only；不需要鉴权，因为整栈都只在 loopback）----
  if (url.pathname === '/sim/health') { json(200, { ok: true, groups: GROUPS, sent: sent.length }); return }
  if (url.pathname === '/sim/sent') { json(200, { sent }); return }
  if (url.pathname === '/sim/inject' && request.method === 'POST') {
    let body = ''
    for await (const chunk of request) body += chunk
    let payload
    try { payload = JSON.parse(body) } catch { json(400, { error: 'invalid_json' }); return }
    const groupId = String(payload.groupId ?? GROUPS[0] ?? '')
    const text = String(payload.text ?? '')
    if (!groupId || !text) { json(400, { error: 'groupId_and_text_required' }); return }
    const message = {
      localId: localId++,
      chatId: groupId,
      sender: String(payload.sender ?? OWNER_ID),
      type: 1,
      content: text,
      timestamp: new Date().toISOString(),
      isSelf: false,
      isMentioned: payload.isMentioned === true,
    }
    injected.push(message)
    log('injected', { groupId, localId: message.localId })
    json(200, { ok: true, message })
    return
  }

  // ---- 真实 API 面（必须鉴权）----------------------------------------------
  if (!authorized(request)) { json(401, { error: 'unauthorized' }); return }

  if (url.pathname === '/api/status/auth') { json(200, { status: 'logged_in', loggedInUser: BOT_ID }); return }

  const chatMatch = /^\/api\/chats\/(.+)$/.exec(url.pathname)
  if (chatMatch) {
    const groupId = decodeURIComponent(chatMatch[1])
    if (!GROUPS.includes(groupId)) { json(404, { error: 'chat_not_found' }); return }
    json(200, { id: groupId, isGroup: true })
    return
  }

  const messagesMatch = /^\/api\/messages\/([^/]+)$/.exec(url.pathname)
  if (messagesMatch && request.method === 'GET') {
    const groupId = decodeURIComponent(messagesMatch[1])
    if (!GROUPS.includes(groupId)) { json(403, { error: 'group_not_authorized' }); return }
    const limit = Number(url.searchParams.get('limit') ?? 100)
    json(200, injected.filter(m => m.chatId === groupId).slice(-Math.max(1, limit)))
    return
  }

  if (url.pathname === '/api/messages/send' && request.method === 'POST') {
    let body = ''
    for await (const chunk of request) body += chunk
    let payload
    try { payload = JSON.parse(body) } catch { json(400, { error: 'invalid_json' }); return }
    const chatId = String(payload.chatId ?? '')
    const text = String(payload.text ?? '')
    if (!GROUPS.includes(chatId) || !text) { json(400, { error: 'invalid_send' }); return }
    sent.push({ at: new Date().toISOString(), chatId, chars: text.length })
    log('sent', { chatId })
    json(200, { success: true, localId: localId++ })
    return
  }

  json(404, { error: 'not_found' })
})

// ⚠️ 监听 0.0.0.0：仿真主机里的环回转发器按 compose 网络的 DNS 名连过来
//    （`wechat:16174`），必须能连上容器的实际地址。
server.listen(PORT, '0.0.0.0', () => log('listening', { port: PORT }))

const shutdown = () => { log('stopping'); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
