/**
 * 核心侧的**执行端客户端**（ADR-146 `D01`/`D05`）。
 *
 * ============================================================================
 *  方向：核心（客户端） ──▶ PC 执行端（监听端）
 * ============================================================================
 *
 * ```text
 *  核心 connect 127.0.0.1:<ExecutorServerPort>   ← 经隧道到 PC
 *       └─ 写 LG_ENTRY <token> v1                ← **每条新连接都重发**
 *       └─ 读 LG_ENTRY_READY
 *       └─ 写 DELEGATE_ACTION（一次一条）
 *       └─ 读 ACTION_RESULT（闭集结局）
 * ```
 *
 * ⚠️⚠️ **两处 `'error'` 都必须挂**（今天栽过一次）：
 *   ① socket 自己的 `'error'`
 *   ② `createInterface` 的 `'error'` ——
 *      它会**把 socket 的 `'error' 转发成自己的**。只挂 ① 不够：
 *      ② 上没人监听 ⇒ Node 当未捕获异常 ⇒ **整个核心进程崩掉**。
 *      这与 2026-10-16 修掉的 `taskkill` 漏挂 `'error'` 是**同一个形状**。
 *
 * ⚠️ **握手必须带协议版本**（`D07`）：不重发 = 执行端那边挂着一条**未认证**的连接。
 *
 * ⚠️ **断线不重发在途委派**（同 `lg-stdio-client.ts` 的纪律）：
 *    执行端可能已经把那次做完了 —— 重发 = 同一件事做两遍。
 */

import { connect, type Socket } from 'node:net'
import { createInterface, type Interface } from 'node:readline'
import { ENTRY_PROTOCOL_VERSION } from '../qq/entry-handshake.ts'
import {
  ACTION_RESULT,
  DELEGATE_ACTION,
  parseActionResult,
  type ActionOutcome,
} from '../../kernel/app/bridge/delegation-wire.ts'

export interface ExecutorClientOptions {
  readonly host: string
  readonly port: number
  readonly token: string
  /** 一次委派的结局（`unknown` 是默认值，绝不默认成功） */
  readonly onResult: (actionId: string, outcome: ActionOutcome, code?: string) => void
  readonly onLog?: (message: string) => void
  readonly onConnected?: (connected: boolean) => void
}

export class ExecutorClient {
  private socket: Socket | undefined
  private lines: Interface | undefined
  private readonly pending = new Map<string, (outcome: ActionOutcome, code?: string) => void>()
  private connected = false

  constructor(private readonly options: ExecutorClientOptions) {}

  /** 连上并完成握手。**失败关闭**：失败即 reject，不"先连上再说"。 */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port })
      this.socket = socket
      socket.setEncoding('utf8')
      const lines: Interface = createInterface({ input: socket, crlfDelay: Infinity })
      this.lines = lines

      let settled = false
      const deadline = setTimeout(() => fail('lg_executor_handshake_timeout'), 5000)
      const fail = (why: string): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        lines.close()
        socket.destroy()
        reject(new Error(why))
      }
      const ready = (): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        this.socket = socket
        this.lines = lines
        this.connected = true
        this.options.onConnected?.(true)
        this.options.onLog?.(`执行端已连上 ${this.options.host}:${String(this.options.port)}`)
        resolve()
      }

      // ⚠️ ① socket 的 'error'
      socket.on('error', () => { this.connected = false; this.options.onConnected?.(false); fail('lg_executor_socket_failed') })
      // ⚠️ ② readline Interface 的 'error'（转发自 ①）—— **漏了会崩核心**
      lines.on('error', () => { this.connected = false; this.options.onConnected?.(false); fail('lg_executor_line_error') })
      socket.on('close', () => {
        this.connected = false
        this.options.onConnected?.(false)
        // ⚠️ 断线：**具名拒掉在途委派**，绝不重发
        const ids = [...this.pending.keys()]
        for (const id of ids) {
          this.pending.get(id)?.('unknown', 'lg_executor_connection_lost')
          this.pending.delete(id)
        }
        this.options.onLog?.(`执行端连接断开（${ids.length} 条在途委派被判 unknown，**未重发**）`)
        fail('lg_executor_closed')
      })

      socket.on('connect', () => {
        // ⚠️ **每条新连接都重发握手**（不重发 = 对端挂着未认证连接）
        socket.write(`LG_ENTRY ${this.options.token} v${ENTRY_PROTOCOL_VERSION}\n`)
      })

      lines.on('line', (line) => {
        if (line.startsWith('LG_ENTRY_READY')) { ready(); return }
        // ⚠️ 拒收行**不单独处理**：握手失败会立刻触发 fail ⇒ 那才是失败语义。
        //    在这里判一次只会把两个失败面分开。
        if (line.startsWith('LG_ENTRY_REJECTED')) return
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { return }
        const result = parseActionResult(parsed)
        if (!result.ok || result.value.kind !== ACTION_RESULT) return
        const wait = this.pending.get(result.value.actionId)
        // ⚠️ 陌生 actionId 的结果**不**采纳成完成 —— 交给 `onResult` 但不 resolve 任何 pending
        this.options.onResult(result.value.actionId, result.value.outcome, result.value.code)
        if (wait !== undefined) {
          this.pending.delete(result.value.actionId)
          wait(result.value.outcome, result.value.code)
        }
      })
    })
  }

  get isConnected(): boolean {
    return this.connected
  }

  /** 发一次委派。**返回它在执行端的结局**（含 `unknown`） */
  send(payload: Record<string, unknown>): Promise<{ outcome: ActionOutcome; code?: string }> {
    const socket = this.socket
    const actionId = String(payload['actionId'] ?? '')
    if (socket === undefined || !this.connected) {
      return Promise.resolve({ outcome: 'unknown' as const, code: 'lg_executor_not_connected' })
    }
    if (actionId === '') return Promise.resolve({ outcome: 'unknown' as const, code: 'lg_executor_missing_action_id' })
    return new Promise((resolve) => {
      this.pending.set(actionId, (outcome, code) => resolve(code === undefined ? { outcome } : { outcome, code }))
      socket.write(`${JSON.stringify(payload)}\n`)
    })
  }

  async close(): Promise<void> {
    this.connected = false
    const socket = this.socket
    const closed = socket === undefined || socket.closed
      ? Promise.resolve()
      : new Promise<void>((resolve) => socket.once('close', resolve))
    this.lines?.close()
    this.lines = undefined
    this.socket?.destroy()
    this.socket = undefined
    await closed
  }
}

export { DELEGATE_ACTION }
