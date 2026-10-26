// OneBot v11 forward-WebSocket probe for the LLBot candidate.
//
// Reads like a real client: it asks for identity and online state, and (in
// `inbound` mode) waits for one real private message from the owner and then
// sends one fixed receipt. It never prints a raw QQ id - only a SHA-256
// comparison result, so the output is safe to keep as evidence.
//
// Environment:
//   LG_TEST_BOT_HASH      sha256 of the bot QQ id (decimal string)   [required]
//   LG_TEST_OWNER_HASH    sha256 of the owner QQ id (decimal string) [required in inbound mode]
//   LG_PROBE_MODE         "readback" (default) | "inbound"
//   LLBOT_CONFIG_PATH     default /app/llbot/default_config.json
//   LLBOT_WS_URL          default derived from the config (ws://127.0.0.1:<port>/)
//   LG_TEST_EXPECT_TEXT   default "LLBot接入测试"
//   LG_TEST_RECEIPT_TEXT  default fixed receipt text
//   LG_PROBE_TIMEOUT_MS   default 180000
import fs from 'node:fs'
import crypto from 'node:crypto'

const hash = value => crypto.createHash('sha256').update(String(value ?? '')).digest('hex')
const expectedBot = process.env.LG_TEST_BOT_HASH
const expectedOwner = process.env.LG_TEST_OWNER_HASH
const mode = process.env.LG_PROBE_MODE ?? 'readback'
const configPath = process.env.LLBOT_CONFIG_PATH ?? '/app/llbot/default_config.json'
const expectText = (process.env.LG_TEST_EXPECT_TEXT ?? 'LLBot接入测试').replace(/\s/g, '')
const receiptText = process.env.LG_TEST_RECEIPT_TEXT
  ?? '【LLBot 通道测试】已收到你的测试消息。这是固定测试回执，尚未接入 LG 正式对话。'
const timeoutMs = Number(process.env.LG_PROBE_TIMEOUT_MS ?? 180000)

if (!/^[a-f0-9]{64}$/.test(expectedBot ?? '')) throw new Error('missing_test_bot_hash')
if (mode === 'inbound' && !/^[a-f0-9]{64}$/.test(expectedOwner ?? '')) throw new Error('missing_test_owner_hash')

let wsUrl = process.env.LLBOT_WS_URL
if (!wsUrl) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const cfg = config.ob11.connect.find(item => item.type === 'ws' && item.enable)
  if (!cfg) throw new Error('no_enabled_ws_connect_in_config')
  wsUrl = `ws://127.0.0.1:${cfg.port}/?access_token=${encodeURIComponent(cfg.token)}`
}

const socket = new WebSocket(wsUrl)
const readings = []
const finish = (status, code, extra = {}) => {
  clearTimeout(timer)
  readings.push({ status, at: new Date().toISOString(), ...extra })
  console.log(JSON.stringify({ scope: 'llbot candidate onebot probe', mode, readings, databaseUsed: false, modelUsed: false }, null, 2))
  try { socket.close() } catch { /* already closed */ }
  process.exit(code)
}
const timer = setTimeout(() => finish(mode === 'inbound' ? 'NO_TEST_MESSAGE_OR_ACK' : 'TIMEOUT', 1), timeoutMs)

// Readback mode must wait for BOTH answers: the status reply can arrive
// before the identity reply, and finishing on the first one would skip the
// account-hash comparison entirely.
let statusReadback = null
let identityReadback = null
const maybeFinishReadback = () => {
  if (mode !== 'readback') return
  if (statusReadback === null || identityReadback === null) return
  const ok = statusReadback.online === true && identityReadback.accountMatch === true
  finish(ok ? 'READBACK_OK' : 'READBACK_FAILED', ok ? 0 : 1, {
    online: statusReadback.online,
    accountMatch: identityReadback.accountMatch,
  })
}

socket.addEventListener('error', () => finish('SOCKET_FAILED', 1))
socket.addEventListener('open', () => {
  readings.push({ status: 'WS_OPEN', at: new Date().toISOString() })
  socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'status' }))
  socket.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'identity' }))
})
socket.addEventListener('message', event => {
  let packet
  try { packet = JSON.parse(event.data) } catch { return }

  if (packet.echo === 'status') {
    const online = packet.data?.online === true
    statusReadback = { online }
    readings.push({ status: 'ONLINE_READBACK', online, at: new Date().toISOString() })
    maybeFinishReadback()
    return
  }
  if (packet.echo === 'identity') {
    const accountMatch = hash(packet.data?.user_id) === expectedBot
    identityReadback = { accountMatch }
    readings.push({ status: 'IDENTITY_READBACK', accountMatch, at: new Date().toISOString() })
    if (!accountMatch) finish('IDENTITY_MISMATCH', 1, { accountMatch })
    maybeFinishReadback()
    return
  }
  if (packet.echo === 'test-ack') {
    const accepted = packet.status === 'ok' && packet.retcode === 0 && packet.data?.message_id != null
    finish(accepted ? 'TEST_ACK_API_ACCEPTED' : 'TEST_ACK_FAILED', accepted ? 0 : 1, {
      inboundOwnerMatched: true,
      exactTestTextMatched: true,
      realUserReceipt: 'AWAITING USER',
    })
    return
  }
  if (mode !== 'inbound') return
  if (packet.post_type !== 'message' || packet.message_type !== 'private') return
  if (hash(packet.self_id) !== expectedBot) return
  if (hash(packet.user_id) !== expectedOwner) return
  if (hash(packet.sender?.user_id) !== expectedOwner) return
  if (!Array.isArray(packet.message)) return
  const text = packet.message.filter(part => part.type === 'text').map(part => part.data?.text ?? '').join('')
  if (text.replace(/\s/g, '') !== expectText) return
  readings.push({ status: 'REAL_INBOUND_TEST_MATCHED', at: new Date().toISOString() })
  socket.send(JSON.stringify({
    action: 'send_private_msg',
    echo: 'test-ack',
    params: {
      user_id: packet.user_id,
      message: [{ type: 'text', data: { text: receiptText } }],
    },
  }))
})
