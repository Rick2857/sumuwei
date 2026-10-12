import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { connect, type Socket } from 'node:net'
import { resolve } from 'node:path'
import type { BridgeWireResponse } from '../../kernel/app/bridge/turn-bridge.ts'

/**
 * Owns one existing main.ts bridge process; never opens a database itself.
 *
 * ============================================================================
 *  post-Lv2 / ADR-109 `D01`：**两种传输**
 * ============================================================================
 * ```text
 *  connect 缺省      ⇒ spawn `src/main.ts --bridge --qq-private`（**旧形态**：每入口一个库持有者）
 *  connect 给了      ⇒ TCP 连到 `--coexist` 的 **QQ 监听**（一个核心、两条入口）
 * ```
 * ⚠️ 两条路的**协议完全一样**（NDJSON + `turn-bridge.ts` 的受控登记表）——
 *    差别只在传输层，因此"换一种连法"不改任何语义。
 * ⚠️ 连过去时先发一句**传输层握手** `LG_ENTRY <token>`：入口身份由**监听端口**绑定
 *    （`D02`：载荷里没有字段能选入口）。
 * ⚠️ `close()` 在连接档只关**这一条连接**：核心与另一条入口都不受影响（`D07`）。
 */
export class LgStdioClient {
  readonly process: ChildProcessWithoutNullStreams | undefined
  private socket: Socket | undefined
  private transportClosed = false
  private readonly pending = new Map<string, {
    resolve: (response: BridgeWireResponse) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private failure: Error | undefined
  private readonly exit: Promise<number | null>
  readonly ready: Promise<void>
  /**
   * post-Lv2 / ADR-110 `D06`：**主动投递**的处理器（由外壳装上）。
   *
   * ```text
   * 装上 ⇒ 核心发来的 `DELIVER_QQ_TEXT` 交给它投递，回执原样写回核心
   * 不装 ⇒ 那一行**如实丢弃**（与今天非 `TURN_RESULT` 行的行为一致）
   * ```
   * ⚠️ 它与 `pending` **无关**：主动投递不是任何一轮的结果，
   *    它的关联键是 `deliveryId`（= 线上的 `requestId`），而不是轮次。
   */
  private qqDeliveryHandler:
    | ((input: { deliveryId: string; text: string; attempt?: number }) => Promise<{
        status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'
        messageId?: string
        reason?: string
      }>)
    | undefined

  constructor(
    root: string,
    env: NodeJS.ProcessEnv,
    options: { connect?: { host: string; port: number; token: string } } = {}
  ) {
    const connectTo = options.connect
    if (connectTo === undefined) {
      this.process = spawn(process.execPath, [
        resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, 'src/main.ts'), '--bridge', '--qq-private',
      ], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } else {
      this.process = undefined
      this.socket = connect({ host: connectTo.host, port: connectTo.port })
      this.socket.setEncoding('utf8')
      this.socket.write(`LG_ENTRY ${connectTo.token}\n`)
    }
    let markReady = (): void => {}
    let rejectReady = (_error: Error): void => {}
    const readyTimer = setTimeout(() => {
      rejectReady(new Error('lg_bridge_start_timeout'))
      this.stopTransport()
    }, 120_000)
    this.ready = new Promise((done, reject) => { markReady = done; rejectReady = reject })
    // Keep protocol output private; ordinary startup lines are not QQ replies.
    const source = this.process === undefined ? this.socket! : this.process.stdout
    const lines = createInterface({ input: source, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (line === 'QQ_PRIVATE_READY' || line.startsWith('LG_ENTRY_READY')) {
        clearTimeout(readyTimer)
        markReady()
        return
      }
      let response: BridgeWireResponse
      try { response = JSON.parse(line) } catch { return }
      /*
       * post-Lv2 / ADR-110 `D06`：**核心主动发来的投递**。
       *
       * ⚠️ 它在 `pending` 之外：主动投递不是任何一轮的结果，
       *    所以**不能**走下面的 `pending.get(requestId)` 那条路
       *    （`requestId` 是 `deliveryId`，永远查不到 pending 项）。
       */
      if (response?.kind === 'DELIVER_QQ_TEXT') {
        void this.handleQqDelivery(response).catch(() => undefined)
        return
      }
      if (response?.kind !== 'TURN_RESULT') return
      const pending = this.pending.get(response.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(response.requestId)
      pending.resolve(response)
    })
    if (this.process !== undefined) {
      // Diagnostics stay in the local terminal and are never forwarded as QQ replies.
      this.process.stderr.pipe(process.stderr)
      this.process.stdin.on('error', () => this.fail('lg_bridge_stdin_failed'))
      this.process.on('error', () => this.fail('lg_bridge_start_failed'))
    } else {
      this.socket!.on('error', () => this.fail('lg_entry_socket_failed'))
      this.socket!.on('close', () => this.fail('lg_entry_socket_closed'))
    }
    this.exit = new Promise((done) => {
      if (this.process === undefined) {
        this.socket!.once('close', () => { clearTimeout(readyTimer); done(0) })
        return
      }
      this.process.once('close', (code) => {
        clearTimeout(readyTimer)
        rejectReady(new Error(`lg_bridge_exit_${code ?? 'unknown'}`))
        lines.close()
        this.fail(`lg_bridge_exit_${code ?? 'unknown'}`)
        done(code)
      })
    })
  }

  /** 连接档的收尾：只关这一条连接（核心不随之退出）。 */
  private stopTransport(): void {
    this.transportClosed = true
    if (this.process === undefined) this.socket?.destroy()
    else this.process.stdin.end()
  }

  /** 写一行给核心（**唯一**的写口；连接档与子进程档在这里分岔） */
  private writeLine(payload: Record<string, unknown>): void {
    const line = `${JSON.stringify(payload)}\n`
    if (this.process === undefined) {
      if (!this.transportClosed) this.socket?.write(line)
    } else if (!this.process.stdin.destroyed) this.process.stdin.write(line)
  }

  /**
   * 装上**主动投递**处理器（post-Lv2 / ADR-110 `D06`）。
   *
   * ⚠️ 不装 = 那一行如实丢弃（**不**回一条"成功"的回执）——
   *    这正是"没有这个能力就说没有"的同一条纪律。
   */
  setQqDeliveryHandler(
    handler: (input: { deliveryId: string; text: string; attempt?: number }) => Promise<{
      status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'
      messageId?: string
      reason?: string
    }>
  ): void {
    this.qqDeliveryHandler = handler
  }

  /** 把一条投递回执写回核心（`requestId` = `deliveryId`，与投递指令逐字一致） */
  private async handleQqDelivery(response: BridgeWireResponse): Promise<void> {
    const deliveryId = typeof response.requestId === 'string' ? response.requestId : ''
    const text = typeof response.qqText === 'string' ? response.qqText : ''
    const attempt = (response as { attempt?: unknown }).attempt
    const handler = this.qqDeliveryHandler
    if (handler === undefined || deliveryId === '' || text === '') {
      /* 没有处理器 / 形状不合法 ⇒ **不回**"成功"：如实报结果不明 */
      if (deliveryId !== '') {
        this.writeLine({
          kind: 'REPORT_QQ_DELIVERY', requestId: deliveryId, deliveryId,
          deliveryStatus: 'delivery_unknown', detail: 'delivery_handler_absent',
        })
      }
      return
    }
    let reading: { status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'; messageId?: string; reason?: string }
    try {
      reading = await handler({
        deliveryId,
        text,
        ...(typeof attempt === 'number' ? { attempt } : {}),
      })
    } catch (error) {
      reading = {
        status: 'delivery_unknown',
        reason: error instanceof Error ? error.message : 'delivery_threw',
      }
    }
    this.writeLine({
      kind: 'REPORT_QQ_DELIVERY',
      requestId: deliveryId,
      deliveryId,
      deliveryStatus: reading.status,
      /* ⚠️ 只有接受才带 `messageId`（桥那一侧会拒"非接受却带回执 id"） */
      ...(reading.status === 'api_accepted' && reading.messageId !== undefined
        ? { messageId: reading.messageId }
        : {}),
      ...(reading.reason === undefined ? {} : { detail: reading.reason }),
    })
  }

  private fail(code: string): void {
    this.failure ??= new Error(code)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(this.failure)
    }
    this.pending.clear()
  }

  submit(request: { requestId: string; userText: string; images?: readonly import('../../kernel/contracts/image-input.ts').ImageInput[] }): Promise<BridgeWireResponse> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending.has(request.requestId)) return Promise.reject(new Error('lg_bridge_duplicate_request'))
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.fail('lg_bridge_timeout')
        // Drain through main.ts shutdown; a timeout does not prove the turn was rolled back.
        this.stopTransport()
      }, 180_000)
      this.pending.set(request.requestId, { resolve: done, reject, timer })
      this.writeLine({ kind: 'SUBMIT_TURN', ...request })
    })
  }

  async close(): Promise<number | null> {
    if (this.transportClosed && this.process === undefined) return 0
    this.stopTransport()
    return await this.exit
  }
}
