/**
 * 入口取消（`CANCEL_TURN` / `CANCEL_RESULT`）的门。
 *
 * 2026-10-17 · 远程执行缺口 4/4
 *
 * ⚠️ 这里**不 mock**：起一个真的 loopback TCP 服务扮演核心，让 `LgStdioClient`
 *    真连、真发握手、真收发行。这样才证得出"线上那一行到底是什么形状"。
 */
import { createServer, type Socket, type Server } from 'node:net'
import { createInterface, type Interface } from 'node:readline'
import { LgStdioClient, type BridgeCancelOutcome } from '../src/infrastructure/qq/lg-stdio-client.ts'
import { verifyEntryHandshake, ENTRY_HANDSHAKE_REJECT, ENTRY_VERSION_REJECT } from '../src/infrastructure/qq/entry-handshake.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}  ${detail}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}

const TOKEN = 'fixture-'.repeat(4)

/** 假核心：收到行就按脚本回行，并**记录**线上到底发了什么 */
interface FakeCore {
  server: Server
  port: number
  received: Array<Record<string, unknown>>
  raw: string[]
  sockets: Socket[]
}

async function startFakeCore(behaviour: {
  onTurn?: (line: Record<string, unknown>, core: FakeCore) => void
  onCancel?: (line: Record<string, unknown>, core: FakeCore) => void
}): Promise<FakeCore> {
  const core: Partial<FakeCore> & { received: Array<Record<string, unknown>>; raw: string[]; sockets: Socket[] } = {
    received: [],
    raw: [],
    sockets: [],
  }
  const server = createServer((socket) => {
    core.sockets!.push(socket)
    socket.setEncoding('utf8')
    const lines = createInterface({ input: socket, crlfDelay: Infinity })
    lines.on('line', (raw) => {
      core.raw!.push(raw)
      if (raw.startsWith('LG_ENTRY ')) {
        // ⚠️ 用**真**校验器，别在测试里另写一份判据（L-QQP-09：复制判据必然与本体漂移）
        const hv = verifyEntryHandshake(raw, TOKEN)
        if (!hv.ok) {
          const isVer = hv.code === 'version_missing' || hv.code === 'version_unsupported'
          socket.write(isVer ? ENTRY_VERSION_REJECT : ENTRY_HANDSHAKE_REJECT)
          socket.destroy(); return
        }
        socket.write('LG_ENTRY_READY qq_private conv-1\n')
        return
      }
      let msg: Record<string, unknown>
      try { msg = JSON.parse(raw) as Record<string, unknown> } catch { return }
      core.received!.push(msg)
      if (msg.kind === 'SUBMIT_TURN') behaviour.onTurn?.(msg, core as FakeCore)
      if (msg.kind === 'CANCEL_TURN') behaviour.onCancel?.(msg, core as FakeCore)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { server, port, received: core.received!, raw: core.raw!, sockets: core.sockets! }
}

const connect = (port: number): LgStdioClient =>
  new LgStdioClient(process.cwd(), process.env, { connect: { host: '127.0.0.1', port, token: TOKEN } })

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
console.log('=== D-C1 失败关闭：不能取消不存在的轮次 ===')
{
  const core = await startFakeCore({})
  const c = connect(core.port)
  await c.ready
  let code = ''
  try { await c.cancel('never-submitted', 'x') } catch (e) { code = (e as Error).message }
  check('未提交过的 requestId 被拒', code === 'lg_cancel_unknown_request', `code=${code}`)
  let code2 = ''
  try { await c.cancel('', 'x') } catch (e) { code2 = (e as Error).message }
  check('空 requestId 被拒', code2 === 'lg_cancel_empty_request_id', `code=${code2}`)
  check('线上**没有**发出任何 CANCEL_TURN', !core.raw.some((l) => l.includes('CANCEL_TURN')), `raw=${core.raw.length} 行`)
  await c.close()
  core.server.close()
}

console.log('\n=== D-C2 ★ 正控：提交过的轮次可以取消，且线上形状正确 ===')
{
  const core = await startFakeCore({
    onCancel: (line, k) => {
      // 核心侧回执
      k.sockets[0]!.write(`${JSON.stringify({ kind: 'CANCEL_RESULT', requestId: line.requestId, outcome: 'cancelled' })}\n`)
    },
  })
  const c = connect(core.port)
  await c.ready
  void c.submit({ requestId: 'req-1', userText: '你好' }).catch(() => undefined)
  await settle(120)
  const outcome = await c.cancel('req-1', '用户打断')
  const sent = core.received.find((m) => m.kind === 'CANCEL_TURN') as Record<string, unknown> | undefined
  check('线上确实发了 CANCEL_TURN', sent !== undefined, JSON.stringify(sent))
  check('携带正确的 requestId', sent?.requestId === 'req-1', String(sent?.requestId))
  check('携带 reason', sent?.reason === '用户打断', String(sent?.reason))
  check('**没有**任何"撤销"类字段', sent !== undefined && !('undo' in sent) && !('rollback' in sent), JSON.stringify(Object.keys(sent ?? {})))
  check('回执解析为 accepted', outcome.accepted === true, JSON.stringify(outcome))
  await c.close()
  core.server.close()
}

console.log('\n=== D-C3 核心回 rejected ⇒ 如实报 false，不粉饰 ===')
{
  const core = await startFakeCore({
    onCancel: (line, k) => {
      k.sockets[0]!.write(`${JSON.stringify({ kind: 'CANCEL_RESULT', requestId: line.requestId, outcome: 'rejected', code: 'cancel_capability_absent' })}\n`)
    },
  })
  const c = connect(core.port)
  await c.ready
  void c.submit({ requestId: 'req-2', userText: 'hi' }).catch(() => undefined)
  await settle(120)
  const outcome = await c.cancel('req-2')
  check('accepted=false', outcome.accepted === false, JSON.stringify(outcome))
  check('带具名 code', outcome.code === 'cancel_capability_absent', String(outcome.code))
  await c.close()
  core.server.close()
}

console.log('\n=== D-C4 ★ 核心不回执 ⇒ 超时但**不**说"失败"（取消是协作式的）===')
{
  const core = await startFakeCore({ /* onCancel 故意不回 */ })
  const c = connect(core.port)
  await c.ready
  void c.submit({ requestId: 'req-3', userText: 'hi' }).catch(() => undefined)
  await settle(120)
  const started = Date.now()
  const outcome: BridgeCancelOutcome = await c.cancel('req-3')
  const elapsed = Date.now() - started
  check('resolve 而不是 reject（抛异常会把"没等到回执"说成"取消失败"）', outcome.accepted === false, JSON.stringify(outcome))
  check('带 lg_cancel_result_timeout', outcome.code === 'lg_cancel_result_timeout', String(outcome.code))
  check(`约 10 秒后超时（实测 ${Math.round(elapsed / 1000)}s）`, elapsed >= 9000 && elapsed < 13000, `${elapsed}ms`)
  await c.close()
  core.server.close()
}

console.log('\n=== D-C5 同一个轮次不能并发取消两次 ===')
{
  const core = await startFakeCore({ /* 不回执，让第一个挂着 */ })
  const c = connect(core.port)
  await c.ready
  void c.submit({ requestId: 'req-4', userText: 'hi' }).catch(() => undefined)
  await settle(120)
  const first = c.cancel('req-4')
  await settle(50)
  let dup = ''
  try { await c.cancel('req-4') } catch (e) { dup = (e as Error).message }
  check('第二次取消被拒', dup === 'lg_cancel_duplicate_request', `code=${dup}`)
  void first.catch(() => undefined)
  await c.close()
  core.server.close()
}

console.log('\n=== D-C6 ★ 轮次结束后就不能再取消（inFlight 已清）===')
{
  const core = await startFakeCore({
    onTurn: (line, k) => {
      k.sockets[0]!.write(`${JSON.stringify({ kind: 'TURN_RESULT', requestId: line.requestId, outcome: 'completed' })}\n`)
    },
  })
  const c = connect(core.port)
  await c.ready
  await c.submit({ requestId: 'req-5', userText: 'hi' })
  await settle(80)
  let code = ''
  try { await c.cancel('req-5', '事后') } catch (e) { code = (e as Error).message }
  check('已完成的轮次不能取消', code === 'lg_cancel_unknown_request', `code=${code}`)
  await c.close()
  core.server.close()
}

console.log('\n=== D-C7 关闭时排空未回执的取消，不留悬挂 Promise ===')
{
  const core = await startFakeCore({})
  const c = connect(core.port)
  await c.ready
  void c.submit({ requestId: 'req-6', userText: 'hi' }).catch(() => undefined)
  await settle(120)
  const p = c.cancel('req-6')
  await settle(60)
  await c.close()
  const outcome = await p
  check('close() 之后取消**已 settle**（没有悬挂）', outcome.code === 'lg_cancel_client_shutdown', JSON.stringify(outcome))
  core.server.close()
}

console.log('\n=== D-C8 握手被拒时不建连接（鉴权那条链仍生效）===')
{
  const bad = new LgStdioClient(process.cwd(), process.env, { connect: { host: '127.0.0.1', port: 1, token: 'wrong-token' } })
  let rejected = false
  try { await bad.ready } catch { rejected = true }
  check('握手失败 ⇒ ready 拒', rejected, `rejected=${rejected}`)
  await bad.close().catch(() => undefined)
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
