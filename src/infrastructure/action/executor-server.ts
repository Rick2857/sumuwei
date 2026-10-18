/**
 * 执行端监听服务（[`ADR-146`](../../../docs/adr/ADR-146-remote-tool-execution.md) `D01`/`D03`/`D05`）。
 *
 * ============================================================================
 *  跑在**你的电脑上**，等核心（服务器）把已过策略的委派送过来
 * ============================================================================
 *
 * ```text
 * 服务器 LG 核心                 PC 执行端（本文件）
 *   ├─ 桌面控制开关关着            ├─ 监听 127.0.0.1:<ExecutorServerPort>
 *   └─ 委派 desktop.operate  ────▶ ├─ 握手（token + 协议版本）
 *                                  ├─ 重新核对（此刻的快照，delegation-revalidation.ts）
 *                                  ├─ 真 worker（windows-mcp）
 *                                  └─ 回 ACTION_RESULT ──────▶
 * ```
 *
 * ⚠️ 为什么执行端**必须**自己重新核对（`D03`）：
 *    核心那边的快照是**几十秒前**的。那之后你可能已经切了窗口。
 *    **在过期快照上做的点击，就是在陌生界面上盲点。**
 *    ⇒ 委派只带「当时要做什么」，**不带**「当时那会儿是真的」。
 *
 * ⚠️ 这一层**不评估风险、不查权限、不问额度**（`D02`）：
 *    那些在委派发出去**之前**就已经过了（`action-delegation.ts`）。
 *    这一层**只加不减** —— 它能把"不该做"变成"做不了"，但**不能**把
 *    "不该做"放宽成"可以做"。放宽的唯一入口在核心侧，且那里的闸只认程序常量。
 *
 * ============================================================================
 *  为什么 `snapshot` / `execute` 都是注入的
 * ============================================================================
 *
 * 不是为了好测。是因为**它们各自都可能失败或不可用**，而"此刻拿不到快照"
 * 这件事**必须**导致拒绝执行 —— 那正好是"失败关闭"。
 * ⚠️ 拿不到快照 ⇒ `executor_snapshot_unavailable`，**不是**"就按委派说的做"。
 *    后者是盲点最常见的来源。
 */

import { createServer, type Server, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import {
  verifyEntryHandshake,
  ENTRY_HANDSHAKE_REJECT,
  ENTRY_VERSION_REJECT,
} from '../../infrastructure/qq/entry-handshake.ts'
import { parseDelegateAction, ACTION_RESULT, DELEGATE_ACTION } from '../../kernel/app/bridge/delegation-wire.ts'
import { revalidateAgainstSnapshot, type DesktopSnapshot } from '../../kernel/action/delegation-revalidation.ts'

export type ExecutorRefusal =
  /** 拿不到此刻的快照 ⇒ **绝不**按委派说的做 */
  | 'executor_snapshot_unavailable'
  /** 真 worker 跑了但没能交回可判定的结果 */
  | 'executor_worker_failed'
  /** 这一轮被取消了 */
  | 'executor_cancelled'

export interface ExecutorOptions {
  readonly host: string
  readonly port: number
  readonly token: string
  /** 取**此刻**的桌面快照。抛异常 ⇒ `executor_snapshot_unavailable`（失败关闭） */
  readonly snapshot: () => Promise<DesktopSnapshot>
  /** 真 worker。抛异常 ⇒ `executor_worker_failed` */
  readonly execute: (action: { readonly kind: string; readonly window: string; readonly index: number; readonly content?: string; readonly name?: string }) => Promise<void>
  readonly isCancelled?: (actionId: string) => boolean
  readonly onLog?: (message: string) => void
  readonly onState?: (state: 'listening' | 'closed' | 'stopped') => void
}

export class ActionExecutorServer {
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()

  constructor(private readonly options: ExecutorOptions) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket))
      // ⚠️ 失败关闭：**出错时把**监听地址**说清楚**。0.0.0.0 会让执行端暴露到局域网。
      server.once('error', (error: Error) => reject(new Error(`executor_listen_failed:${error.message}`)))
      server.listen(this.options.port, this.options.host, () => {
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : this.options.port
        this.server = server
        this.options.onState?.('listening')
        this.options.onLog?.(`执行端已在 ${this.options.host}:${port} 等待委派`)
        resolve(port)
      })
    })
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    // ⚠️ 必须处理 socket 自己的 'error'：不接就冒泡成未捕获异常 ⇒ **进程崩掉**。
    //   与读行器那条是同一个形状（见 attachLineReader）。
    socket.on('error', () => { this.sockets.delete(socket); socket.destroy() })
    socket.on('close', () => { this.sockets.delete(socket) })

    const lines = createInterface({ input: socket, crlfDelay: Infinity })
    // ⚠️ `createInterface` 会把 socket 的 'error' **转发成 Interface 自己的 'error'**，
    //    这里没人监听就会崩 —— 与 lg-stdio-client.ts 里同一个坑。
    lines.on('error', () => { lines.close(); socket.destroy() })

    const first = (async (): Promise<boolean> => {
      const hello = await new Promise<string | undefined>((done) => {
        const timer = setTimeout(() => done(undefined), 30_000)
        lines.once('line', (line) => { clearTimeout(timer); done(line) })
        socket.once('close', () => { clearTimeout(timer); done(undefined) })
      })
      const verdict = verifyEntryHandshake(hello, this.options.token)
      if (!verdict.ok) {
        // 版本类失败回专用码；token 类失败一律同形（不开 oracle）
        const isVersion = verdict.code === 'version_missing' || verdict.code === 'version_unsupported'
        socket.write(isVersion ? ENTRY_VERSION_REJECT : ENTRY_HANDSHAKE_REJECT)
        socket.destroy()
        return false
      }
      socket.write('LG_ENTRY_READY action_executor v1\n')
      return true
    })()

    first.then((ok) => {
      if (!ok) return
      lines.on('line', (raw) => { void this.handleLine(socket, raw) })
    }).catch(() => { lines.close(); socket.destroy() })
  }

  private async handleLine(socket: Socket, raw: string): Promise<void> {
    let message: unknown
    try { message = JSON.parse(raw) } catch {
      // ⚠️ 坏 JSON **不**回任何东西：连"这条我看不懂"都不说，避免把解析行为变成 oracle
      this.options.onLog?.('收到无法解析的一行，已忽略（不回应）')
      return
    }
    const parsed = parseDelegateAction(message)
    if (!parsed.ok) {
      // 形状不合法 ⇒ 回 `unknown`，**不**回 rejected（"看不懂"与"没执行"是两件事）
      socket.write(`${JSON.stringify({ kind: ACTION_RESULT, requestId: '', outcome: 'unknown', code: parsed.rejection })}\n`)
      return
    }
    const { value } = parsed

    if (this.options.isCancelled?.(value.actionId) === true) {
      socket.write(this.result(value.actionId, 'unknown', 'executor_cancelled'))
      return
    }

    // ① 取**此刻**的快照。⚠️ 拿不到就拒绝 —— 不按委派说的做。
    let now: DesktopSnapshot
    try { now = await this.options.snapshot() }
    catch (error) {
      this.options.onLog?.(`取快照失败（${(error as Error).message.slice(0, 60)}）⇒ 拒绝执行`)
      socket.write(this.result(value.actionId, 'unknown', 'executor_snapshot_unavailable'))
      return
    }

    // ② 用**此刻**的读数重新核对（`D03`）
    const verdict = revalidateAgainstSnapshot(now, {
      action: String(value.args['action'] ?? ''),
      window: typeof value.args['window'] === 'string' ? value.args['window'] : undefined,
      index: typeof value.args['index'] === 'number' ? value.args['index'] : undefined,
      name: typeof value.args['name'] === 'string' ? value.args['name'] : undefined,
      content: typeof value.args['content'] === 'string' ? value.args['content'] : undefined,
    })
    if (!verdict.ok) {
      this.options.onLog?.(`重新核对未过（${verdict.rejection}）⇒ 拒绝执行`)
      // ⚠️ `rejected` 是**明确拒绝**，不是失败 —— 核心据此知道"别再发一次同样的"
      socket.write(this.result(value.actionId, 'rejected', verdict.rejection))
      return
    }

    // ③ 真 worker
    try {
      await this.options.execute(verdict.action)
      socket.write(this.result(value.actionId, 'completed'))
    } catch (error) {
      this.options.onLog?.(`worker 失败（${(error as Error).message.slice(0, 60)}）`)
      socket.write(this.result(value.actionId, 'failed_confirmed', 'executor_worker_failed'))
    }
  }

  /** 结局是闭集；这里只写死**安全**的那几个值，不给"默认成功"留位置 */
  private result(actionId: string, outcome: 'completed' | 'rejected' | 'failed_confirmed' | 'unknown', code?: string): string {
    return `${JSON.stringify({
      kind: ACTION_RESULT,
      actionId,
      outcome,
      ...(code === undefined ? {} : { code }),
    })}\n`
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = undefined
    if (server === undefined) { this.options.onState?.('stopped'); return }
    await new Promise<void>((done) => server.close(() => done()))
    this.options.onState?.('stopped')
  }
}

export { DELEGATE_ACTION }
