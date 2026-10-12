/** Native Node WebSocket recovery against a local OneBot fixture; no database or real QQ sends. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { OneBotPrivateClient } from '../../src/infrastructure/qq/onebot-private-client.ts'
import { readQqPrivateConfig } from '../../src/infrastructure/qq/private-config.ts'

const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws')
const http = createServer()
const server = new WebSocketServer({ noServer: true })
const controls: string[] = []
const readings: { event: string }[] = []
let inboundCalls = 0
let rejectUpgrade = false
let loginId = '987654321'
let holdSend = false
let sent = 0
let lastSendEcho = ''
let peer: any
http.on('upgrade', (request, socket, head) => {
  if (rejectUpgrade) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return }
  server.handleUpgrade(request, socket, head, (connection: any) => server.emit('connection', connection))
})
server.on('connection', (connection: any) => {
  peer = connection
  connection.on('message', (raw: Buffer) => {
    const packet = JSON.parse(raw.toString())
    if (packet.action === 'get_login_info') {
      connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: loginId }, echo: packet.echo }))
      return
    }
    assert.equal(packet.action, 'send_private_msg')
    sent++
    lastSendEcho = packet.echo
    if (!holdSend) connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: sent }, echo: packet.echo }))
  })
})
await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
const settings = readQqPrivateConfig({
  QQ_OWNER_ID: '123456789', QQ_BOT_ID: loginId,
  QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${(http.address() as { port: number }).port}/`,
  QQ_ONEBOT_ACCESS_TOKEN: 'offline-reconnect-fixture-token',
})
const client = new OneBotPrivateClient(settings, async (request) => {
  inboundCalls++
  return { kind: 'TURN_RESULT', requestId: request.requestId, outcome: 'replied', replyText: request.userText }
}, (reading) => readings.push(reading))
const bounded = async <T>(task: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('reconnect_fixture_timeout')), 2000)
    })])
  } finally { clearTimeout(timer) }
}
const waitFor = async (test: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) { if (test()) return; await delay(10) }
  throw new Error('reconnect_fixture_timeout')
}
const socketOf = (): WebSocket => (client as unknown as { socket: WebSocket }).socket
let status = 'FAIL'
let failure: string | undefined
try {
  await client.connect()
  assert(client.connected)
  await assert.rejects(client.connect(), /onebot_already_connected/)
  controls.push('healthy connection rejects duplicate connect')

  peer.terminate()
  await waitFor(() => !client.connected)
  rejectUpgrade = true
  const failedConnect = client.connect()
  const failedSocket = socketOf()
  await assert.rejects(failedConnect, /onebot_connect_failed/)
  assert(!client.connected)
  await assert.rejects(client.connect(), /onebot_connect_failed/)
  controls.push('disconnect and repeated native handshake failures do not lock reconnect')

  rejectUpgrade = false
  await bounded(client.connect())
  assert(client.connected)
  controls.push('same process reconnects after service recovers')

  holdSend = true
  let settled = false
  const delivery = client.deliverProactiveText('offline fixture only').then((result) => { settled = true; return result })
  await waitFor(() => sent === 1)
  failedSocket.dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 999 }, echo: lastSendEcho }),
  }))
  failedSocket.dispatchEvent(new Event('close'))
  await delay(20)
  assert(client.connected, 'stale close must not disconnect the replacement')
  assert(!settled, 'stale API echo must not complete a new connection request')
  peer.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: lastSendEcho }))
  assert.deepEqual(await bounded(delivery), { status: 'api_accepted', messageId: '1' })
  controls.push('stale close and API response cannot affect replacement connection')

  const unknown = client.deliverProactiveText('offline disconnect fixture')
  await waitFor(() => sent === 2)
  peer.terminate()
  assert.equal((await bounded(unknown)).status, 'delivery_unknown')
  await client.connect()
  assert(client.connected)
  assert.equal(sent, 2)
  controls.push('in-flight send disconnect is unknown and never replayed after reconnect')

  socketOf().dispatchEvent(new Event('error'))
  await waitFor(() => !client.connected)
  await bounded(client.connect())
  assert(client.connected)
  controls.push('active transport error releases connection for retry')

  peer.terminate()
  await waitFor(() => !client.connected)
  loginId = '111111111'
  await assert.rejects(client.connect(), /onebot_bot_account_mismatch/)
  assert(!client.connected)
  loginId = settings.botId
  await bounded(client.connect())
  assert(client.connected)
  controls.push('bot mismatch fails closed and a later valid login recovers')

  holdSend = false
  const inbound = JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: settings.botId, user_id: settings.ownerId, sender: { user_id: settings.ownerId }, message_id: 100,
    message: [{ type: 'text', data: { text: 'offline recovery fixture' } }],
  })
  peer.send(inbound)
  peer.send(inbound)
  await waitFor(() => sent === 3)
  await client.drain()
  assert.equal(inboundCalls, 1)
  controls.push('new inbound private turn replies after recovery and duplicate is ignored')

  await bounded(client.close())
  const failedClient = new OneBotPrivateClient(settings, undefined, () => {})
  rejectUpgrade = true
  await assert.rejects(failedClient.connect(), /onebot_connect_failed/)
  await bounded(failedClient.close())
  controls.push('shutdown after native handshake failure is bounded')
  status = 'PASS'
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await bounded(client.close()).catch(() => {})
  for (const connection of server.clients) connection.terminate()
  await new Promise<void>((done) => server.close(() => done()))
  await new Promise<void>((done) => http.close(() => done()))
  const out = resolve(import.meta.dirname, '../../artifacts/post-lv2', `qq-reconnect-${new Date().toISOString().replace(/\D/g, '')}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ status, node: process.version, controls,
    clientSha256: createHash('sha256').update(readFileSync(resolve(import.meta.dirname,
      '../../src/infrastructure/qq/onebot-private-client.ts'))).digest('hex'),
    failure, events: readings.map((reading) => reading.event), productionDatabaseOpened: false,
    realQqMessages: 'NOT RUN', scope: 'native WebSocket + local OneBot fixture' }, null, 2) + '\n')
  console.log(`${status}: QQ reconnect (${controls.length} controls)${failure ? `: ${failure}` : ''}\n${out}`)
}
