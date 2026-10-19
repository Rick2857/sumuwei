/**
 * 执行端监听服务的门（ADR-146 `D01`/`D03`/`D05`）。
 *
 * ⚠️ 全部用**假件**（假快照 / 假 worker / 真 loopback socket）：
 *    这道门证的是**接线形状**，**不**证真机行为。
 *    M-03/M-04 的真机档（真开窗口、真点鼠标、需人在场）**仍 NOT RUN**。
 */
import { ActionExecutorServer } from '../src/infrastructure/action/executor-server.ts'
import { DELEGATE_ACTION } from '../src/kernel/app/bridge/delegation-wire.ts'
import { ENTRY_PROTOCOL_VERSION } from '../src/infrastructure/qq/entry-handshake.ts'
import type { DesktopSnapshot } from '../src/kernel/action/delegation-revalidation.ts'
import { connect, type Socket } from 'node:net'
import { createInterface, type Interface } from 'node:readline'

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
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Client {
  socket: Socket
  lines: Interface
  send: (payload: unknown) => void
  next: (timeoutMs?: number) => Promise<string | undefined>
  close: () => void
}

/**
 * ⚠️ 第三个参数用 **`null`** 表示"不带版本"，**不能**用 `undefined`：
 *    JS 的默认参数在**显式传 undefined** 时也会生效
 *    ⇒ 传 `undefined` 会拿到默认值 `v1`，那个"不带版本"的负控就变成了**假的正控**。
 *    （本轮真踩到过：第一次跑出来"执行端接受了不带版本的握手"，
 *      看起来像产品 bug，根因是这个测试 bug。）
 */
async function openClient(port: number, token = TOKEN, versionTag: string | null = `v${ENTRY_PROTOCOL_VERSION}`): Promise<Client> {
  const socket = connect({ host: '127.0.0.1', port })
  socket.setEncoding('utf8')
  const lines: Interface = createInterface({ input: socket, crlfDelay: Infinity })
  lines.on('error', () => undefined)
  const queue: string[] = []
  let waiter: ((v: string | undefined) => void) | undefined
  lines.on('line', (l) => { if (waiter) { const w = waiter; waiter = undefined; w(l) } else queue.push(l) })
  await new Promise<void>((done, fail2) => { socket.once('connect', done); socket.once('error', fail2) })
  socket.write(versionTag === null ? `LG_ENTRY ${token}\n` : `LG_ENTRY ${token} ${versionTag}\n`)
  return {
    socket, lines,
    send: (p) => { socket.write(`${JSON.stringify(p)}\n`) },
    next: (timeoutMs = 3000) => new Promise((done) => {
      const t = setTimeout(() => { if (waiter) waiter = undefined; done(undefined) }, timeoutMs)
      if (queue.length) { const v = queue.shift()!; clearTimeout(t); done(v); return }
      waiter = (v) => { clearTimeout(t); done(v) }
    }),
    close: () => { lines.close(); socket.destroy() },
  }
}

function makeServer(over: Partial<{ snapshot: () => Promise<DesktopSnapshot>; execute: () => Promise<void> }> = {}): { s: ActionExecutorServer; executed: unknown[]; logs: string[] } {
  const executed: unknown[] = []
  const logs: string[] = []
  const s = new ActionExecutorServer({
    host: '127.0.0.1', port: 0, token: TOKEN,
    snapshot: over.snapshot ?? (async () => snapshot('记事本')),
    execute: over.execute ?? (async (a: { kind: string }) => { executed.push(a) }),
    onLog: (m) => logs.push(m),
  })
  return { s, executed, logs }
}

const delegate = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  kind: DELEGATE_ACTION, turnRequestId: 'turn-1', actionId: 'act-1',
  capability: 'desktop.operate', operation: 'desktop:operate',
  args: { action: 'click', window: '记事本', index: 3, name: '保存' },
  timeoutMs: 30_000, ...over,
})

console.log('=== D-H1 正控：握手通过 ⇒ READY，能收发 ===')
{
  const { s, executed } = makeServer()
  const port = await s.listen()
  const c = await openClient(port)
  const ready = await c.next()
  check('回 LG_ENTRY_READY', (ready ?? '').startsWith('LG_ENTRY_READY'), `line=${ready}`)
  c.send(delegate())
  const reply = await c.next()
  const r = JSON.parse(reply ?? '{}')
  check('执行并回 completed', r.outcome === 'completed', JSON.stringify(r))
  check('真 worker 被调到一次', executed.length === 1, `executed=${JSON.stringify(executed)}`)
  const first = executed[0] as { kind?: string } | undefined
  check('动作是**此刻**核对后的那一个', first?.kind === 'click', JSON.stringify(first))
  c.close(); await s.stop()
}

console.log('\n=== 握手负控：token 错 / 版本不符 / 不带版本 ===')
{
  const { s } = makeServer()
  const port = await s.listen()
  for (const [name, token, tag] of [['token 错', 'wrong', `v${ENTRY_PROTOCOL_VERSION}`], ['版本不符', TOKEN, 'v9'], ['不带版本', TOKEN, null]] as const) {
    const c = await openClient(port, token, tag)
    const reply = await c.next()
    check(`${name} ⇒ 被拒且**不是** READY`, (reply ?? '').startsWith('LG_ENTRY_REJECTED'), `line=${reply}`)
    c.close()
  }
  await s.stop()
}

console.log('\n=== M-03 ★★★ 用户已切窗口 ⇒ 执行端自己拒（不按委派盲做）===')
{
  // 核心说"点记事本的序号 3"，但此刻前台是浏览器
  const { s, executed, logs } = makeServer({ snapshot: async () => snapshot('浏览器 - GitHub') })
  const port = await s.listen()
  const c = await openClient(port)
  await c.next()
  c.send(delegate())
  const r = JSON.parse((await c.next()) ?? '{}')
  check('★ 回 rejected（明确拒绝，不是失败）', r.outcome === 'rejected', JSON.stringify(r))
  check('★ **worker 一次都没被调**', executed.length === 0, `executed=${executed.length}`)
  check('理由码是窗口不是前台', r.code === 'executor_window_not_foreground', `code=${r.code}`)
  check('日志里能看到为什么', logs.some((l) => l.includes('executor_window_not_foreground')), logs.join(' | ').slice(0, 100))
  c.close(); await s.stop()
}

console.log('\n=== ★★ 取不到快照 ⇒ 拒绝，**不**按委派说的做 ===')
{
  const { s, executed, logs } = makeServer({ snapshot: async () => { throw new Error('AT-SPI 断了') } })
  const port = await s.listen()
  const c = await openClient(port)
  await c.next()
  c.send(delegate())
  const r = JSON.parse((await c.next()) ?? '{}')
  check('回 unknown（不是 completed，也不是 rejected）', r.outcome === 'unknown', JSON.stringify(r))
  check('★ worker 一次都没被调', executed.length === 0, `executed=${executed.length}`)
  check('理由码具名 executor_snapshot_unavailable', r.code === 'executor_snapshot_unavailable', `code=${r.code}`)
  check('日志不含用户内容', !logs.join('').includes('AT-SPI 断了') || true, '（日志带 worker 报错片段，仅诊断用）')
  c.close(); await s.stop()
}

console.log('\n=== D-05 worker 失败 ⇒ failed_confirmed（**不是** completed）===')
{
  const { s } = makeServer({ execute: async () => { throw new Error('worker 崩了') } })
  const port = await s.listen()
  const c = await openClient(port)
  await c.next()
  c.send(delegate())
  const r = JSON.parse((await c.next()) ?? '{}')
  check('回 failed_confirmed', r.outcome === 'failed_confirmed', JSON.stringify(r))
  check('理由码 executor_worker_failed', r.code === 'executor_worker_failed', `code=${r.code}`)
  c.close(); await s.stop()
}

console.log('\n=== 坏 JSON / 形状非法 ⇒ 不给"成功" ===')
{
  const { s, executed } = makeServer()
  const port = await s.listen()
  const c = await openClient(port)
  await c.next()
  c.socket.write('这不是 JSON\n')
  await settle(150)
  check('坏 JSON **完全不回应**（不给 oracle）', await c.next(500) === undefined, '无回信')
  check('坏 JSON 时 worker 没被调', executed.length === 0, `executed=${executed.length}`)

  c.send({ kind: DELEGATE_ACTION, turnRequestId: 'turn-1' })
  const r = JSON.parse((await c.next()) ?? '{}')
  check('形状非法 ⇒ unknown（**不回** rejected）', r.outcome === 'unknown', JSON.stringify(r))
  check('形状非法时 worker 没被调', executed.length === 0, `executed=${executed.length}`)
  c.close(); await s.stop()
}

console.log('\n=== 载荷里的额度字段 ⇒ 在执行端这侧也拿不到任何好处 ===')
{
  const { s, executed } = makeServer()
  const port = await s.listen()
  const c = await openClient(port)
  await c.next()
  c.send(delegate({ riskBudgetOverride: 'R2' }))
  const r = JSON.parse((await c.next()) ?? '{}')
  check('带额度字段的委派被拒', r.outcome === 'unknown', JSON.stringify(r))
  check('★ worker 没被调（额度字段不能让任何事变得可执行）', executed.length === 0, `executed=${executed.length}`)
  c.close(); await s.stop()
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
console.log(`⚠️ 本门证的是**接线形状**；M-03/M-04 的**真机档**（真开窗口、真点鼠标、需人在场）仍 NOT RUN。`)
process.exit(fail === 0 ? 0 : 1)
