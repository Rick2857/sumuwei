/**
 * 核心侧执行端客户端的门（ADR-146 `D01`/`D05`）。
 *
 * ⚠️ 两端都是**真** loopback：`ActionExecutorServer`（真监听 + 真握手 + 真重新核对）
 * ↔ `ExecutorClient`（真 connect + 真握手 + 真收发）。
 * 假件只出现在"worker 动作"那一层 —— 那正是要证明**它没被调用**的地方。
 */
import { ActionExecutorServer } from '../src/infrastructure/action/executor-server.ts'
import { ExecutorClient } from '../src/infrastructure/action/executor-client.ts'
import { DELEGATE_ACTION } from '../src/kernel/app/bridge/delegation-wire.ts'
import type { DesktopSnapshot } from '../src/kernel/action/delegation-revalidation.ts'
import { createServer, type Server } from 'node:net'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  ${detail}`) }
  else { fail += 1; console.log(`  FAIL  ${name}  ${detail}`) }
}

const TOKEN = 'fixture-'.repeat(4)
const snapshot = (active: string): DesktopSnapshot => ({
  activeWindow: active,
  windows: [{ name: '记事本', elements: [{ index: 3, name: '保存', actionable: true }] }],
})
const delegate = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  kind: DELEGATE_ACTION, turnRequestId: 'turn-1', actionId: 'act-1',
  capability: 'desktop.operate', operation: 'desktop:operate',
  args: { action: 'click', window: '记事本', index: 3, name: '保存' },
  timeoutMs: 30_000, ...over,
})

interface Pair { server: ActionExecutorServer; client: ExecutorClient; executed: unknown[]; port: number }

async function pair(over: { snapshot?: () => Promise<DesktopSnapshot>; execute?: () => Promise<void> } = {}): Promise<Pair> {
  const executed: unknown[] = []
  const server = new ActionExecutorServer({
    host: '127.0.0.1', port: 0, token: TOKEN,
    snapshot: over.snapshot ?? (async () => snapshot('记事本')),
    execute: over.execute ?? (async (a) => { executed.push(a) }),
  })
  const port = await server.listen()
  const client = new ExecutorClient({
    host: '127.0.0.1', port, token: TOKEN,
    onResult: () => undefined, onLog: () => undefined, onConnected: () => undefined,
  })
  await client.connect()
  return { server, client, executed, port }
}

console.log('=== C-1 正控：握手通过 ⇒ 委派 → 真 worker → completed ===')
{
  const p = await pair()
  check('握手后 isConnected', p.client.isConnected, `port=${p.port}`)
  const r = await p.client.send(delegate())
  check('结局 completed', r.outcome === 'completed', JSON.stringify(r))
  check('★ 真 worker 被调一次', p.executed.length === 1, `executed=${JSON.stringify(p.executed)}`)
  await p.client.close(); await p.server.stop()
}

console.log('\n=== C-2 ★ M-03 端到端：执行端此刻不是前台 ⇒ rejected，且 worker 没被调 ===')
{
  const p = await pair({ snapshot: async () => snapshot('浏览器 - GitHub') })
  const r = await p.client.send(delegate())
  check('★ 结局 rejected', r.outcome === 'rejected', JSON.stringify(r))
  check('理由码透传', r.code === 'executor_window_not_foreground', `code=${r.code}`)
  check('★ **worker 一次都没被调**', p.executed.length === 0, `executed=${p.executed.length}`)
  await p.client.close(); await p.server.stop()
}

console.log('\n=== C-3 ★ 握手失败 ⇒ connect() reject，不"连上再说" ===')
{
  const server = new ActionExecutorServer({
    host: '127.0.0.1', port: 0, token: 'the-real-token',
    snapshot: async () => snapshot('记事本'), execute: async () => undefined,
  })
  const port = await server.listen()
  const client = new ExecutorClient({
    host: '127.0.0.1', port, token: TOKEN, onResult: () => undefined, onConnected: () => undefined,
  })
  let code = ''
  try { await client.connect() } catch (e) { code = (e as Error).message }
  check('★ token 错 ⇒ connect 失败', code !== '', `code=${code}`)
  check('★ 且 isConnected 为 false', !client.isConnected, `isConnected=${client.isConnected}`)
  await client.close(); await server.stop()
}

console.log('\n=== C-4 ★ 连不上（没人监听）⇒ 失败关闭，不是挂死 ===')
{
  // 先占一个端口再关掉 ⇒ 确定没人听
  const tmp = createServer()
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r))
  const dead = (tmp.address() as { port: number }).port
  await new Promise<void>((r) => tmp.close(() => r()))
  const client = new ExecutorClient({
    host: '127.0.0.1', port: dead, token: TOKEN, onResult: () => undefined, onConnected: () => undefined,
  })
  let code = ''
  try { await client.connect() } catch (e) { code = (e as Error).message }
  check('★ 连不上 ⇒ reject（不是挂死）', code !== '', `code=${code}`)
  const r = await client.send(delegate())
  check('未连接时 send 回 unknown（**不是** completed）', r.outcome === 'unknown', JSON.stringify(r))
  await client.close()
}

console.log('\n=== C-5 ★★★ 断线：在途委派具名判 unknown，**绝不重发** ===')
{
  /*
   * ⚠️⚠️ worker **必须慢**。第一版用的是瞬时假 worker + 30ms 后断线，
   *    结果委派**在断线之前就做完了** ⇒ `completed` 是**正确**读数，
   *    而我却断言它应该是 unknown —— 那是**测试**在断言一件没发生的事。
   *    ⇒ 这条与今天反复出现的那条同源：**没先让前提成立，就下结论**。
   *    这里让 worker 睡 3 秒，断线落在 150ms ⇒ **真的在途**。
   */
  let entered = false
  const p = await pair({
    execute: async () => {
      entered = true
      await new Promise((r) => setTimeout(r, 3000))
    },
  })
  const inflight = p.client.send(delegate({ actionId: 'act-inflight' }))
  // 等 worker **真的**进入（而不是靠 sleep 猜）
  for (let i = 0; i < 60 && !entered; i++) await new Promise((r) => setTimeout(r, 50))
  check('worker 真的进入在途', entered, `entered=${entered}`)
  await p.server.stop()
  const r = await inflight
  check('★ 在途委派有结局（没挂着）', r.outcome !== undefined, JSON.stringify(r))
  check('★ 判 unknown，**不是** completed', r.outcome === 'unknown', `outcome=${r.outcome}`)
  check('★ 断线理由具名 lg_executor_connection_lost', r.code === 'lg_executor_connection_lost', `code=${r.code}`)
  check('★ 执行端没回结果 ⇒ 客户端**不**自己编一个成功', r.outcome !== 'completed', `outcome=${r.outcome}`)
  await p.client.close()
}

console.log('\n=== C-6 ★ 执行端崩掉（进程被关）⇒ 客户端不崩 ===')
{
  const p = await pair()
  // 粗暴拔掉：直接销毁底层监听（模拟执行端进程没了）
  await p.server.stop()
  await new Promise((r) => setTimeout(r, 200))
  let alive = true
  try { const r2 = await p.client.send(delegate()); alive = r2.outcome === 'unknown' } catch { alive = false }
  check('★ 执行端没了，客户端仍可用（回 unknown）', alive, '进程未崩')
  await p.client.close()
}

console.log('\n=== C-7 握手未完成时关闭，不遗留 socket ===')
{
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.resume() })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const client = new ExecutorClient({ host: '127.0.0.1', port: (server.address() as { port: number }).port,
    token: TOKEN, onResult: () => undefined })
  const connecting = client.connect().then(() => '', error => (error as Error).message)
  while (sockets.size === 0) await new Promise(r => setTimeout(r, 5))
  await client.close()
  check('关闭握手中的连接也 settle', await connecting === 'lg_executor_closed', '连接未认证，未派发动作')
  for (let i = 0; i < 40 && sockets.size > 0; i++) await new Promise(r => setTimeout(r, 5))
  check('对端连接已释放', sockets.size === 0, `sockets=${sockets.size}`)
  await new Promise<void>(r => server.close(() => r()))
}
console.log('\n=== C-8 对端接受 TCP 但不回答握手，必须有界失败 ===')
{
  const server = createServer(socket => socket.on('data', () => undefined))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const client = new ExecutorClient({ host: '127.0.0.1', port: (server.address() as { port: number }).port,
    token: TOKEN, onResult: () => undefined })
  const code = await client.connect().then(() => '', error => (error as Error).message)
  check('握手超时失败关闭', code === 'lg_executor_handshake_timeout', code)
  await client.close()
  await new Promise<void>(r => server.close(() => r()))
}
console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
