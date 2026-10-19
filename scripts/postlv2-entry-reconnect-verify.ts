/**
 * 入口重连的门（远程执行缺口 3/4）。
 *
 * ⚠️ 用**真的** loopback TCP 服务，并且真的把它关掉再开一个新的端口 ——
 *    断线不是 mock 出来的，是服务端 `close()` 出来的。
 *
 * 最要紧的一条是 D-R3：**断线时在途轮次必须被具名拒绝，绝不自动重发。**
 * 服务端可能已经提交过那一轮；重发等于同一件事做两遍。
 */
import { createServer, type Server, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { LgStdioClient, type LgConnectionState } from '../src/infrastructure/qq/lg-stdio-client.ts'
import { verifyEntryHandshake, ENTRY_HANDSHAKE_REJECT, ENTRY_VERSION_REJECT } from '../src/infrastructure/qq/entry-handshake.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  ${detail}`) }
  else { fail += 1; console.log(`  FAIL  ${name}  ${detail}`) }
}

const TOKEN = 'fixture-'.repeat(4)
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Core {
  server: Server
  port: number
  sockets: Socket[]
  turns: Array<Record<string, unknown>>
  handshakes: string[]
}

async function startCore(): Promise<Core> {
  const core: Core = { server: createServer(), port: 0, sockets: [], turns: [], handshakes: [] }
  core.server.on('connection', (socket) => {
    core.sockets.push(socket)
    socket.setEncoding('utf8')
    const lines = createInterface({ input: socket, crlfDelay: Infinity })
    lines.on('line', (raw) => {
      if (raw.startsWith('LG_ENTRY ')) {
        // ⚠️ 用**真**校验器（L-QQP-09：复制判据必然与本体漂移）
        const hv = verifyEntryHandshake(raw, TOKEN)
        if (!hv.ok) {
          const isVer = hv.code === 'version_missing' || hv.code === 'version_unsupported'
          socket.write(isVer ? ENTRY_VERSION_REJECT : ENTRY_HANDSHAKE_REJECT); socket.destroy(); return
        }
        core.handshakes.push(raw)
        socket.write('LG_ENTRY_READY qq_private conv-1\n')
        return
      }
      try {
        const msg = JSON.parse(raw) as Record<string, unknown>
        if (msg.kind === 'SUBMIT_TURN') core.turns.push(msg)
      } catch { /* 忽略 */ }
    })
  })
  await new Promise<void>((done) => core.server.listen(0, '127.0.0.1', done))
  const a = core.server.address()
  core.port = typeof a === 'object' && a !== null ? a.port : 0
  return core
}

/** 把一个监听在**新端口**上的核心搬过去（模拟"隧道换了目标端口回来"） */
async function restartCoreOnNewPort(old: Core): Promise<Core> {
  await new Promise<void>((done) => old.server.close(() => done()))
  for (const s of old.sockets) s.destroy()
  return await startCore()
}

// ---------------------------------------------------------------------------
console.log('=== D-R1 正常路径：连上、握手、ready ===')
let states: LgConnectionState[] = []
{
  const core = await startCore()
  const c = new LgStdioClient(process.cwd(), process.env,
    { connect: { host: '127.0.0.1', port: core.port, token: TOKEN } },
    { connect: { host: '127.0.0.1', port: core.port, token: TOKEN }, backoffMs: [60, 120, 240], maxAttempts: 1,
      onConnectionState: (s) => states.push(s) })
  await c.ready
  check('握手完成并 ready', core.handshakes.length === 1, `handshakes=${core.handshakes.length}`)
  check('状态回调走过 connecting→ready', states.includes('connecting') && states.includes('ready'), JSON.stringify(states))
  await c.close()
  core.server.close()
}

console.log('\n=== D-R2 ★ 断线后按退避重连，并**重新握手** ===')
{
  states = []
  let core = await startCore()
  let port = core.port
  const c = new LgStdioClient(process.cwd(), process.env,
    { connect: { host: '127.0.0.1', port, token: TOKEN } },
    { connect: { host: '127.0.0.1', port, token: TOKEN }, backoffMs: [80, 160, 320, 640], maxAttempts: 20,
      onConnectionState: (s, d) => states.push(s) })
  await c.ready
  const handshakesBefore = core.handshakes.length

  // 真断：把服务端和它的 socket 全关掉
  for (const s of core.sockets) s.destroy()
  await new Promise<void>((done) => core.server.close(() => done()))
  await settle(120)
  check('断线进入 backoff', states.includes('backoff'), JSON.stringify(states.slice(-3)))

  // 核心在**另一个端口**回来 —— 隧道重建后端点可能变，这是最真实的情形
  core = await startCore()
  const mutableTarget = (c as unknown as {
    reconnect: { connect: { host: string; port: number; token: string } }
  }).reconnect.connect
  mutableTarget.host = '127.0.0.1'
  mutableTarget.port = core.port

  await settle(1500)
  check('重连后**重新握手**（新连接不握手 = 核心挂着未认证连接）', core.handshakes.length >= 1, `handshakes=${core.handshakes.length}`)
  check('重连成功后回到 ready', states.filter((s) => s === 'ready').length >= 2, JSON.stringify(states))
  check(`首次握手只发生过一次（断开前）`, handshakesBefore === 1, `before=${handshakesBefore}`)
  await c.close()
  core.server.close()
}

console.log('\n=== D-R3 ★★★ 断线时在途轮次被具名拒绝，**绝不自动重发** ===')
{
  states = []
  const core = await startCore()
  const c = new LgStdioClient(process.cwd(), process.env,
    { connect: { host: '127.0.0.1', port: core.port, token: TOKEN } },
    { connect: { host: '127.0.0.1', port: core.port, token: TOKEN }, backoffMs: [60, 120], maxAttempts: 1 })
  await c.ready
  const inflight = c.submit({ requestId: 'turn-inflight', userText: '说一件很长的事' })
  await settle(120)
  check('轮次已提交到线上', core.turns.length === 1, `turns=${core.turns.length}`)

  // 真断
  for (const s of core.sockets) s.destroy()
  let code = ''
  try { await inflight } catch (e) { code = (e as Error).message }
  await settle(400)

  check('在途轮次被拒（不是挂着）', code !== '', `code=${code}`)
  check('拒绝理由具名 lg_entry_connection_lost', code === 'lg_entry_connection_lost', `code=${code}`)
  const resubmits = core.turns.filter((t) => t.requestId === 'turn-inflight').length
  check('★ **没有**自动重发（重发会把已提交的那轮做两遍）', resubmits === 1, `线上该 requestId 出现 ${resubmits} 次`)
  await c.close()
  core.server.close()
}

console.log('\n=== D-R4 ★ maxAttempts 用尽 ⇒ 停在 closed，不无限重试 ===')
{
  states = []
  const core = await startCore()
  const deadPort = core.port
  const c = new LgStdioClient(process.cwd(), process.env,
    // ⚠️ 首次连接用**活**端口（要能 ready），重连目标同一个端口 —— 下面把它杀掉
    { connect: { host: '127.0.0.1', port: deadPort, token: TOKEN } },
    { connect: { host: '127.0.0.1', port: deadPort, token: TOKEN }, backoffMs: [50, 90], maxAttempts: 2,
      onConnectionState: (s) => states.push(s) })
  await c.ready
  // 真断：杀掉全部 socket 并关掉监听 ⇒ 之后每次重连都 ECONNREFUSED
  for (const s of core.sockets) s.destroy()
  await new Promise<void>((done) => core.server.close(() => done()))
  await settle(1200)

  const backoffs = states.filter((s) => s === 'backoff').length
  check(`重试次数受 maxAttempts 约束（backoff ≤ 2，实测 ${backoffs}）`, backoffs <= 2, `backoff=${backoffs}`)
  check('退避用尽后报 closed（不无限重试）', states.includes('closed'), JSON.stringify(states))
  check('★ closed **只报一次**（重复报是噪声，不是状态）', states.filter((s) => s === 'closed').length === 1, `closed ×${states.filter((s) => s === 'closed').length}`)
  check('★ 没有回到 ready（端口已经没人听）', states.filter((s) => s === 'ready').length === 1, JSON.stringify(states))
  await c.close()
}

console.log('\n=== D-R5 ★ close() 之后不再重连（否则退避定时器会把进程钉住）===')
{
  states = []
  const core = await startCore()
  const c = new LgStdioClient(process.cwd(), process.env,
    { connect: { host: '127.0.0.1', port: core.port, token: TOKEN } },
    { connect: { host: '127.0.0.1', port: core.port, token: TOKEN }, backoffMs: [60], maxAttempts: 50,
      onConnectionState: (s) => states.push(s) })
  await c.ready
  await c.close()
  const after = states.length
  await settle(500)
  check('close() 之后状态不再变化', states.length === after, `close 后多出 ${states.length - after} 次回调`)
  check('close() 后不产生新的 backoff', states.filter((s) => s === 'backoff').length === 0, JSON.stringify(states))
  core.server.close()
}

console.log('\n=== D-R6 重连后能正常收发（新连接不是"半残的"）===')
{
  const core = await startCore()
  let target = core.port
  const c = new LgStdioClient(process.cwd(), process.env,
    { connect: { host: '127.0.0.1', port: target, token: TOKEN } },
    { connect: { host: '127.0.0.1', port: target, token: TOKEN }, backoffMs: [60, 120, 240], maxAttempts: 10 })
  await c.ready
  // 让服务端在下一轮回结果
  core.sockets[0]!.on('data', () => undefined)
  const pending = c.submit({ requestId: 'turn-after', userText: 'hi' })
  await settle(150)
  core.sockets[core.sockets.length - 1]!.write(
    `${JSON.stringify({ kind: 'TURN_RESULT', requestId: 'turn-after', outcome: 'completed' })}\n`)
  const result = await pending
  check('重连后的连接能正常收到 TURN_RESULT', result.requestId === 'turn-after', JSON.stringify({ requestId: result.requestId }))
  await c.close()
  core.server.close()
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
