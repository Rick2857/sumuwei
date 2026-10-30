import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { connect, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  BridgeGroupTaskDispatchInstruction,
  BridgeWireResponse,
} from '../../kernel/app/bridge/turn-bridge.ts'
import { ENTRY_PROTOCOL_VERSION } from './entry-handshake.ts'
/**
 * 连接状态（2026-10-17 · 远程执行缺口 3/4「重连」）。
 *
 * ⚠️ **对外只用于呈现与诊断** —— 它**不参与**任何成败判定。
 *    "重连成功了吗"这件事的唯一判据是握手回的那一句 `LG_ENTRY_READY`。
 */
export type LgConnectionState = 'connecting' | 'ready' | 'backoff' | 'closed'

/**
 * 重连参数（缺口 3/4）。
 *
 * ⚠️ 只对**连接档**有意义：子进程档是"核心自己挂了"，
 *    恢复它要重启整个外壳，那是另一件事，不在这里偷做。
 */
export interface LgReconnectOptions {
  readonly connect: { host: string; port: number; token: string }
  /** 退避序列（毫秒）；用完停在最后一个。缺省见 {@link DEFAULT_BACKOFF_MS} */
  readonly backoffMs?: readonly number[]
  /** 最多重连几次。缺省无限 —— 外壳是长驻进程，隧道会自己回来 */
  readonly maxAttempts?: number
  /** 状态变化回调：每次连接/断开/退避都会叫它 */
  readonly onConnectionState?: (state: LgConnectionState, detail: { attempt: number; nextRetryMs?: number }) => void
}

/**
 * 缺省退避序列。
 *
 * ⚠️ 30 秒封顶的理由：SSH 隧道断了之后重连会一直失败，
 *    **封顶是为了让 CPU 与日志有个下限**，不是因为"该放弃了"。
 *    是否放弃由 `maxAttempts` 决定，不在这里藏。
 */
export const DEFAULT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 5000, 10_000, 30_000]

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
export interface BridgeCancelOutcome {
  /**
   * 取消意图**是否被登记**。
   *
   * ⚠️ 对应服务端的 `CANCEL_RESULT.outcome`：`'cancelled' | 'rejected'`
   *    （`turn-bridge.ts:2060-2061` 明写"**没有**『已撤销』这个结局"）。
   * ⚠️ `true` **不等于**"轮次已经停下" —— 取消是**协作式**的：
   *    真正的停止发生在 `session.send()` 的检查点。这里只报"意图被记下了"。
   */
  readonly accepted: boolean
  /** 具名理由码（`accepted === false` 时必有） */
  readonly code?: string
}

/**
 * 取消一轮**在途**的轮次（2026-10-17 · 远程执行缺口 4/4）。
 *
 * ⚠️ 服务端 `CANCEL_TURN` **早就实现了**（`turn-bridge.ts` 的受控登记表 + `TurnCancellationRegistry`），
 *    缺的只是**客户端从不发**。而且客户端的 `lines.on('line')` 原来只认 `TURN_RESULT`
 *    ⇒ 服务端回的 `CANCEL_RESULT` 会被**静默丢掉**。两处一起补。
 *
 * -------------------------------------------------------------------------
 *  失败关闭：只允许取消**本客户端自己提交过**的轮次
 * -------------------------------------------------------------------------
 *  `requestId` 是客户端自己生成的。让它能取消任意 id 等于开一条
 *  「我可以打断别人的轮次」的路 —— 哪怕当前只有单入口，这条例外也要挡住。
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
  /**
   * 让 `ready` **只 settle 一次**的钩子。
   *
   * ⚠️ 它是**实例字段**而不是构造函数的局部 const —— `fail()` 是方法，
   *    看不见构造函数的局部变量。放进局部作用域会直接 `ReferenceError`（本轮踩到过）。
   */
  private rejectReadyOnce: (error: Error) => void = () => undefined
  /**
   * 与 {@link rejectReadyOnce} 成对；同样是**实例字段**（`openSocket` 要用它）。
   */
  private markReadyOnce: () => void = () => undefined
  /** 首次 ready 的判定标记 —— 重连期间 `ready` 必须**保持** fulfilled，不能被后续断开再拒一次 */
  private everReady = false
  private readonly reconnect: LgReconnectOptions | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0
  /** `closed` 只报一次（见 `scheduleReconnect` 里的注释） */
  private closedEmitted = false
  private readyTimer: ReturnType<typeof setTimeout> | undefined
  private readonly exit: Promise<number | null>
  readonly ready: Promise<void>
  /**
   * 在途轮次的 `requestId`（`submit` 写、`finish` 删）。
   * ⚠️ **只用于"这个 id 是不是我提交过"这一个判据** —— 不承担任何调度职责。
   */
  private readonly inFlight = new Set<string>()
  /** `CANCEL_TURN` 的回执等待项。⚠️ 与 `pending` **分开**：`CANCEL_RESULT` 的 `requestId`
   *  与被取消的那一轮**是同一个 id**，放同一个 map 会互相顶掉。 */
  private readonly cancellations = new Map<string, {
    resolve: (outcome: BridgeCancelOutcome) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
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
  /**
   * ADR-156 / P3-G：**群任务派发**的处理器（由外壳装上）。
   *
   * ```text
   * 装上 ⇒ 核心发来的 `DELIVER_GROUP_TASK` 交给它发送，回执（三态）原样写回核心
   * 不装 ⇒ 那一条**如实回报 `failed_confirmed` + `group_task_delivery_handler_absent`**
   *        （失败关闭：宁可报"没发"，也**不许**假装发过 —— 核心会按回执结算额度）
   * ```
   * ⚠️ 与 {@link qqDeliveryHandler} **同形但不同线**：那条的关联键是 `deliveryId`，
   *    这条的关联键是 `deliveryKey`（= 发送实例 id）。两者的回执 kind 也不同
   *    （`REPORT_QQ_DELIVERY` / `REPORT_GROUP_TASK_DELIVERY`）。
   */
  private groupTaskDeliveryHandler:
    | ((groupTask: BridgeGroupTaskDispatchInstruction) => Promise<{
        status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'
        messageId?: string
        reason?: string
      }>)
    | undefined
  /**
   * ADR-156 / P3-I：**只读群列表**的处理器（由外壳装上）。
   *
   * ```text
   * 装上 ⇒ 核心发来的 `LIST_GROUPS` 交给它读（真实实现只有一个 `get_group_list`），列表原样写回核心
   * 不装 ⇒ 回 `group_task_group_list_handler_absent`（**不许**回空数组冒充成功）
   * ```
   * ⚠️ 它与 {@link groupTaskDeliveryHandler} 的**方向相同、语义相反**：那条会**发消息**，
   *    这条**一条消息都不发**（只读 `get_group_list`，不占发送队列、不做放行决定）。
   */
  private groupListHandler:
    | (() => Promise<readonly { readonly groupId: string; readonly groupName: string }[]>)
    | undefined

  constructor(
    root: string,
    env: NodeJS.ProcessEnv,
    options: { connect?: { host: string; port: number; token: string } } = {},
    reconnect?: LgReconnectOptions,
  ) {
    const connectTo = options.connect
    // 连接档才有"重连"可言；子进程档不给这个参数（也不假装有）
    this.reconnect = connectTo === undefined ? undefined : (reconnect ?? { connect: connectTo })

    let markReady: () => void = () => undefined
    let rejectReady: (error: Error) => void = () => undefined
    let readySettled = false
    this.markReadyOnce = (): void => {
      if (readySettled) return
      readySettled = true
      markReady()
    }
    this.rejectReadyOnce = (error: Error): void => {
      if (readySettled) return
      readySettled = true
      rejectReady(error)
    }
    this.ready = new Promise((done, reject) => { markReady = done; rejectReady = reject })
    this.readyTimer = setTimeout(() => {
      this.rejectReadyOnce(new Error('lg_bridge_start_timeout'))
      this.stopTransport()
    }, 120_000)

    if (connectTo === undefined) {
      this.process = spawn(process.execPath, [
        '--import', pathToFileURL(resolve(root, 'node_modules/tsx/dist/loader.mjs')).href,
        resolve(root, 'src/main.ts'), '--bridge', '--qq-private',
      ], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
      this.attachLineReader(this.process.stdout)
      // Diagnostics stay in the local terminal and are never forwarded as QQ replies.
      this.process.stderr.pipe(process.stderr)
      this.process.stdin.on('error', () => this.fail('lg_bridge_stdin_failed'))
      this.process.on('error', () => this.fail('lg_bridge_start_failed'))
      this.exit = new Promise((done) => {
        this.process!.once('close', (code) => {
          this.clearReadyTimer()
          this.rejectReadyOnce(new Error(`lg_bridge_exit_${code ?? 'unknown'}`))
          this.fail(`lg_bridge_exit_${code ?? 'unknown'}`)
          done(code)
        })
      })
      return
    }

    this.process = undefined
    this.openSocket(connectTo)
    this.exit = new Promise((done) => {
      this.socket!.once('close', () => { this.clearReadyTimer(); done(0) })
    })
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== undefined) {
      clearTimeout(this.readyTimer)
      this.readyTimer = undefined
    }
  }

  /** 行读取器的公共部分（两种传输共用）；**必须**处理 Interface 自己的 `'error'` */
  private attachLineReader(source: NodeJS.ReadableStream): void {
    const lines = createInterface({ input: source, crlfDelay: Infinity })
    /*
     * ⚠️ 2026-10-17 · 缺口 4/4 的门**抓到的真缺陷**（`D-C8` 让进程直接崩）。
     *
     *    `createInterface({ input: socket })` 会**自己**在 socket 上挂监听器，
     *    并把 socket 的 `'error'` **转发成 readline Interface 自己的 `'error'`**。
     *    ⇒ 只给 `socket` 挂 handler 不够：Interface 上没人监听 ⇒
     *    Node 当作未捕获异常 ⇒ **整个外壳进程崩掉**。
     *
     *    与 2026-10-16 修掉的 `taskkill` 漏挂 `'error'` 是**同一个形状**：
     *    "命令/连接失败"必须有一条被处理的路径，不能让它冒泡到进程级。
     */
    lines.on('error', (error: Error) => {
      this.onTransportDead(`lg_entry_line_error:${error.message.slice(0, 60)}`)
    })
    lines.on('line', (line) => {
      /*
       * ⚠️ `LG_ENTRY_REJECTED`（含 `protocol_version_unsupported`）**故意不单独处理**。
       *   核心那边 `socket.destroy()` 会让 socket 立刻 close ⇒ `onTransportDead` 已经
       *   把 `ready` 拒掉了。在这里再判一次只会**把两个失败面分开**，而那正是
       *   ADR-146 `D06` 要避免的（版本不符该回哪一句是**核心**的职责，不是客户端的）。
       *   （先前那版在这里写了 `markReadyOnce = () => undefined`，那会把 ready 的
       *     解析彻底废掉、让握手失败永远挂到 120 秒超时 —— 已删。）
       */
      if (line === 'QQ_PRIVATE_READY' || line.startsWith('LG_ENTRY_READY')) {
        this.clearReadyTimer()
        this.markReadyOnce()
        this.everReady = true
        this.reconnectAttempt = 0
        this.closedEmitted = false
        this.emitState('ready')
        return
      }
      this.handleLine(line)
    })
  }

  /** 一行协议载荷的分派（两种传输共用） */
  private handleLine(line: string): void {
    let response: BridgeWireResponse
    try { response = JSON.parse(line) } catch { return }
    /*
     * post-Lv2 / ADR-110 `D06`：**核心主动发来的投递**。
     * ⚠️ 它在 `pending` 之外：主动投递不是任何一轮的结果，
     *    所以不能走下面的 `pending.get(requestId)`（那是 `deliveryId`，永远查不到）。
     */
    if (response?.kind === 'DELIVER_QQ_TEXT') {
      // REPORT_QQ_DELIVERY acknowledgements share this kind, but carry no outbound command.
      if (response.qqDelivery !== undefined) return
      void this.handleQqDelivery(response).catch(() => undefined)
      return
    }
    if (response?.kind === 'CANCEL_RESULT') {
      /*
       * ⚠️ 必须**先于**下面 `kind !== 'TURN_RESULT'` 的早退处理：
       *    原来只认 TURN_RESULT，服务端回的 CANCEL_RESULT 被静默丢掉，
       *    cancel() 就只能永远等超时 —— 那等于"取消是假的"。
       */
      const id = typeof response.requestId === 'string' ? response.requestId : ''
      const waiting = this.cancellations.get(id)
      if (!waiting) return
      clearTimeout(waiting.timer)
      this.cancellations.delete(id)
      waiting.resolve({
        // ⚠️ `cancelled` = 意图**被登记**；`rejected` = 没记下。没有第三个结局。
        accepted: response.outcome === 'cancelled',
        ...(typeof response.code === 'string' ? { code: response.code } : {}),
      })
      return
    }
    /*
     * ADR-156 / P3-G：**我方回执的应答**（`REPORT_GROUP_TASK_DELIVERY` 被受理之后的回包）。
     *
     * ⚠️ 它是**独立 kind**（`GROUP_TASK_DELIVERY_RESULT`），刻意**不**与出站派发指令共用
     *    `DELIVER_GROUP_TASK`：共用的话外壳必须读载荷才知道"这是指令还是应答"，
     *    误读一次就是**多往群里发一条**。所以这里连载荷都不用看，直接忽略。
     */
    if (response?.kind === 'GROUP_TASK_DELIVERY_RESULT') return
    /*
     * ADR-156 / P3-G：**核心派发来的一条群任务消息**（与上面的主动投递同类：不是某轮的结果）。
     *
     * ```text
     * requestId = deliveryKey（= 发送实例 id），**不是**轮次 id
     *   ⇒ 走下面的 `pending.get(requestId)` 永远查不到，必须在早退**之前**建档
     * 它**必须**有回执（`REPORT_GROUP_TASK_DELIVERY`）：没有回执 ⇒ 核心按"结果未知"结算
     * ```
     */
    if (response?.kind === 'DELIVER_GROUP_TASK') {
      void this.handleGroupTaskDelivery(response).catch(() => undefined)
      return
    }
    /*
     * ADR-156 / P3-I：**核心发来的只读群列表查询**（与上面两条同类：不是某轮的结果）。
     *
     * ⚠️ `requestId` 是这次查询的关联键（`qq-group-list:<n>`），**不是**轮次 id
     *    ⇒ 走下面的 `pending.get(requestId)` 永远查不到，必须在早退**之前**建档。
     */
    if (response?.kind === 'LIST_GROUPS') {
      void this.handleListGroups(response).catch(() => undefined)
      return
    }
    /*
     * ADR-156 / P3-I：**我方群列表回执的应答**（核心收到 `LIST_GROUPS_RESULT` 之后的回包）。
     *
     * ⚠️ 与 `GROUP_TASK_DELIVERY_RESULT` 同一条处理：**不读载荷**，直接忽略。
     *    "回执到底送到了没有"由这一句回答，而不是靠超时去猜。
     */
    if (response?.kind === 'LIST_GROUPS_RESULT') return
    if (response?.kind !== 'TURN_RESULT' && response?.kind !== 'GROUP_REPLY_DECISION') return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    this.inFlight.delete(response.requestId)
    pending.resolve(response)
  }

  /**
   * 建立（或**重建**）一条 socket 并装上握手 —— 缺口 3/4 的落脚点。
   *
   * ⚠️ **每一条新连接都必须重发握手**。入口身份由监听端口绑定（ADR-109 `D02`），
   *    所以新 socket 不握手 = 核心那边挂着一条**未认证**的连接。
   */
  private openSocket(target: { host: string; port: number; token: string }): void {
    const socket = connect({ host: target.host, port: target.port })
    this.socket = socket
    socket.setEncoding('utf8')
    this.attachLineReader(socket)
    socket.on('error', () => this.onTransportDead('lg_entry_socket_failed'))
    socket.on('close', () => {
      if (this.transportClosed) return
      this.onTransportDead('lg_entry_socket_closed')
    })
    /*
     * ⚠️ 握手**必须带协议版本**（ADR-146 `D07`）：新连接不握手 = 核心挂着未认证连接；
     *    不带版本 = 核心按 v0 处理并明确回"版本不支持"，**不"试试看"**。
     */
    socket.write(`LG_ENTRY ${target.token} v${ENTRY_PROTOCOL_VERSION}\n`)
    this.emitState('connecting')
  }

  /**
   * 传输断了：**判失败 + 安排重连**。
   *
   * ⚠️ **在途轮次不在这里重发** —— `fail()` 已经把它们具名拒掉了。
   *    服务端可能已经把那一轮提交进账本（写了记忆、动了状态），
   *    重发等于同一件事做两遍。"不知道结果"从来不等于"可以重试"。
   */
  private onTransportDead(code: string): void {
    this.rejectReadyOnce(new Error(code))
    this.fail(this.everReady ? 'lg_entry_connection_lost' : code)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnect === undefined || this.transportClosed) return
    if (this.reconnectTimer !== undefined) return
    const cfg = this.reconnect
    const backoff = cfg.backoffMs ?? DEFAULT_BACKOFF_MS
    const maxAttempts = cfg.maxAttempts ?? Number.POSITIVE_INFINITY
    if (this.reconnectAttempt >= maxAttempts) {
      /*
       * ⚠️ 只报**一次** `closed`。
       *    `onTransportDead` 在每次重连失败时都会进来，若每次都报，
       *    状态流会出现 `closed closed closed` —— 那不是"状态"，
       *    是噪声，而且让看状态的人以为发生了三次不同的事。
       *    （本轮的门 D-R4 把这个读数照出来了。）
       */
      if (!this.closedEmitted) {
        this.closedEmitted = true
        this.emitState('closed')
      }
      return
    }
    const wait = backoff[Math.min(this.reconnectAttempt, backoff.length - 1)]!
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.transportClosed) return
      this.openSocket(cfg.connect)
    }, wait)
    this.emitState('backoff', { nextRetryMs: wait })
  }

  private emitState(state: LgConnectionState, extra: { nextRetryMs?: number } = {}): void {
    this.reconnect?.onConnectionState?.(state, { attempt: this.reconnectAttempt, ...extra })
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

  /**
   * 装上**群任务派发**处理器（ADR-156 / P3-G · `DELIVER_GROUP_TASK`）。
   *
   * ⚠️ 不装 = 那条指令如实回报 `failed_confirmed` + `group_task_delivery_handler_absent`
   *    （**不**回一条"成功"）—— 这正是"没有这个能力就说没有"的同一条纪律：
   *    核心按回执结算额度，一条假的 `api_accepted` 会让额度账少记一条真实消息。
   */
  setGroupTaskDeliveryHandler(
    handler: (groupTask: BridgeGroupTaskDispatchInstruction) => Promise<{
      status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'
      messageId?: string
      reason?: string
    }>
  ): void {
    this.groupTaskDeliveryHandler = handler
  }

  /**
   * 把一条群任务派发**落地**，并把回执写回核心（ADR-156 / P3-G · 契约 §3.1）。
   *
   * ```text
   * 装上处理器       ⇒ 交给它发送，回执 = 它给的三态（**不改判**）
   * 没装处理器       ⇒ failed_confirmed + `group_task_delivery_handler_absent`
   * 没有可用关联键   ⇒ **连回执都不回**（见下）
   * 处理器抛错       ⇒ delivery_unknown + 具名 reason（发出去没有，外壳不知道）
   * ```
   *
   * ⚠️ **失败关闭的方向**：宁可报"没发"（`failed_confirmed`），也**不许**假装发过。
   *    反方向的谎（把成功报成失败）代价只有一次重派尝试；本方向的谎会让核心
   *    把一条**根本没发出去的**消息记成"平台已接受"。
   * ⚠️ **没有关联键就不回**：回执要按 `deliveryKey` 对号，编一个键等于让核心把它
   *    当成另一次派发（那边会报 `group_task_report_unknown_key`，比沉默更误导）。
   */
  private async handleGroupTaskDelivery(response: BridgeWireResponse): Promise<void> {
    const groupTask = response.groupTask
    const rawKey = groupTask?.deliveryKey
    /*
     * 关联键：优先取指令自己的 `deliveryKey`；它缺席时退回 `requestId`
     * （协议里两者**逐字同值**，退回只是为了让一条形状略残的指令仍能被如实回报）。
     */
    const deliveryKey = typeof rawKey === 'string' && rawKey.trim() !== ''
      ? rawKey
      : typeof response.requestId === 'string' && response.requestId.trim() !== ''
        ? response.requestId
        : ''
    if (deliveryKey === '') return
    const handler = this.groupTaskDeliveryHandler
    if (handler === undefined || groupTask === undefined) {
      /* 有键但没人接 / 没有指令 ⇒ 如实报"没发"（绝不回一条假的成功） */
      this.writeLine({
        kind: 'REPORT_GROUP_TASK_DELIVERY',
        requestId: deliveryKey,
        deliveryKey,
        status: 'failed_confirmed',
        reason: 'group_task_delivery_handler_absent',
      })
      return
    }
    let reading: { status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'; messageId?: string; reason?: string }
    try {
      reading = await handler(groupTask)
    } catch (error) {
      /*
       * ⚠️ 处理器抛错 ⇒ **结果未知**，不是"失败"：异常可能发生在发送**之后**
       *    （回读回执时炸了）。报失败会诱导核心重派 —— 那可能让群里出现两条。
       */
      reading = {
        status: 'delivery_unknown',
        reason: error instanceof Error ? error.message : 'group_task_delivery_threw',
      }
    }
    let status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown' =
      reading.status === 'api_accepted' || reading.status === 'failed_confirmed' || reading.status === 'delivery_unknown'
        ? reading.status
        : 'delivery_unknown'
    let reason = reading.reason
    let messageId = reading.messageId
    /*
     * 闭集外的状态 ⇒ 如实降级成"结果未知"（`report_unknown_status` 那条回执会被桥拒掉，
     * 而桥拒掉之后核心只能等超时 —— 两端都要多绕一圈才能得到同一个结论）。
     */
    if (status === 'api_accepted' && (typeof messageId !== 'string' || messageId.trim() === '')) {
      /* "平台接受了但没有回执 id" 在既有口径里就是**结果不明**（不是失败） */
      status = 'delivery_unknown'
      reason = reason ?? 'group_task_delivery_unconfirmed'
      messageId = undefined
    }
    this.writeLine({
      kind: 'REPORT_GROUP_TASK_DELIVERY',
      requestId: deliveryKey,
      deliveryKey,
      status,
      /* ⚠️ 只有接受才带平台回执 id（桥那一侧会拒"非接受却带回执 id"） */
      ...(status === 'api_accepted' && messageId !== undefined ? { platformMessageId: messageId } : {}),
      ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
    })
  }

  /**
   * 装上**只读群列表**处理器（ADR-156 / P3-I · `LIST_GROUPS`）。
   *
   * ⚠️ 生产外壳（`scripts/qq/chat.ts`）装的是 `async () => await client.listGroups()`：
   *    那一条只发一个 `get_group_list`，**不发消息、不占发送队列、不做放行决定**。
   * ⚠️ 不装 = 这条能力如实缺席（回 `group_task_group_list_handler_absent`）——
   *    **绝不**回一个空数组冒充"机器人不在任何群"。
   */
  setGroupListHandler(
    handler: () => Promise<readonly { readonly groupId: string; readonly groupName: string }[]>
  ): void {
    this.groupListHandler = handler
  }

  /**
   * 把核心的一条 `LIST_GROUPS` **落地**，并把群列表（或具名失败码）写回核心。
   *
   * ```text
   * 装上处理器       ⇒ 读一次群列表，原样回 `groups`
   * 没装处理器       ⇒ 回 `group_task_group_list_handler_absent`（**不许**回空数组）
   * 没有关联键       ⇒ **连回执都不回**（回执要按 requestId 对号；编一个键比沉默更误导）
   * 处理器抛错       ⇒ 回该错误名（`onebot_not_connected` / `qq_group_list_too_large:201` …）
   *                    不是具名码时回落 `group_task_group_list_unavailable`
   * ```
   *
   * ⚠️ **失败关闭的方向**：宁可报"读不到"，也**不许**用空数组把它伪装成
   *    "机器人一个群都不在" —— 那会让核心的群目标消歧得出 `group_task_group_not_found`
   *    （一个**假的**事实），而主人会被告知"没有这个群"。
   */
  private async handleListGroups(response: BridgeWireResponse): Promise<void> {
    const requestId = typeof response.requestId === 'string' ? response.requestId : ''
    if (requestId.trim() === '') return
    const handler = this.groupListHandler
    if (handler === undefined) {
      this.writeLine({
        kind: 'LIST_GROUPS_RESULT',
        requestId,
        code: 'group_task_group_list_handler_absent',
      })
      return
    }
    try {
      const groups = await handler()
      /* 形状兜底：只留两个字段（核心侧还会再过一遍闭集校验，这里是第一道） */
      this.writeLine({
        kind: 'LIST_GROUPS_RESULT',
        requestId,
        groups: groups.map((entry) => ({ groupId: entry.groupId, groupName: entry.groupName })),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      /*
       * 具名码透传（外壳/OneBot 那侧的失败码本身就是具名的，见 `listGroups()`）；
       * 不是具名码（比如一个自由文本异常）⇒ 回落成桥那边的通用具名码，**不**把
       * 任意文本当 reason 写进协议（协议里只放码）。
       */
      const code = /^[a-z0-9_:]{1,64}$/.test(message) ? message : 'group_task_group_list_unavailable'
      this.writeLine({ kind: 'LIST_GROUPS_RESULT', requestId, code })
    }
  }

  private fail(code: string): void {
    /*
     * ⚠️ 2026-10-17（`D-C8` 门抓到的第二半）：`ready` 必须**跟着失败一起**拒。
     *    原来只有 120 秒的 `lg_bridge_start_timeout` 会拒它 ⇒
     *    「连接被拒」这种**永远不会自己好**的情形下，外壳要干等两分钟。
     *    而那正是隧道断了 / 核心还没起来时的常态。
     *    不快速失败，后面那个"重连"（缺口 3/4）就没有可用的触发点。
     */
    this.rejectReadyOnce(new Error(code))
    this.failure ??= new Error(code)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(this.failure)
    }
    this.pending.clear()
    this.inFlight.clear()
    for (const waiting of this.cancellations.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(this.failure)
    }
    this.cancellations.clear()
  }

  /**
   * 取消一轮**在途**的轮次（远程执行缺口 4/4）。
   *
   * ⚠️ **失败关闭的三条**：
   *   ① `requestId` 必须是**本客户端 `submit` 过、且尚未收到结果**的（`inFlight`）
   *   ② 同一个 `requestId` 不能并发取消两次
   *   ③ 传输已失败时直接拒，不再往一条死路上写
   *
   * ⚠️ 它**不新增权限**：服务端 `CANCEL_TURN` 只更新进程内取消登记，
   *    真正的停止发生在 `session.send()` 的检查点（既有语义，一个字不改）。
   *    也就是说"取消了"≠"一定停住了" —— 这里回的是**意图是否被登记**。
   */
  cancel(requestId: string, reason?: string): Promise<BridgeCancelOutcome> {
    if (this.failure) return Promise.reject(this.failure)
    if (requestId === '') return Promise.reject(new Error('lg_cancel_empty_request_id'))
    if (!this.inFlight.has(requestId)) {
      // 不是我在途的轮次 ⇒ 拒。不给"顺手取消一个已完成轮次"留缝。
      return Promise.reject(new Error('lg_cancel_unknown_request'))
    }
    if (this.cancellations.has(requestId)) {
      return Promise.reject(new Error('lg_cancel_duplicate_request'))
    }
    return new Promise<BridgeCancelOutcome>((done, reject) => {
      const timer = setTimeout(() => {
        this.cancellations.delete(requestId)
        /*
         * ⚠️ 超时**不**说"失败"：取消是协作式的（ADR-110 `D05` 那种语义），
         *    回执没到只说明**没等到回执**，不能推断成"没停住"。
         *    如实报 `accepted:false` + 具名 code。
         */
        done({ accepted: false, code: 'lg_cancel_result_timeout' })
      }, 10_000)
      this.cancellations.set(requestId, { resolve: done, reject, timer })
      this.writeLine({
        kind: 'CANCEL_TURN',
        requestId,
        ...(reason === undefined ? {} : { reason }),
      })
    })
  }

  /** 取消已经登记、但**还没回执**的那些（停机时用；不等它们） */
  cancelAllOutstanding(reason: string): number {
    const ids = [...this.cancellations.keys()]
    for (const id of ids) {
      const waiting = this.cancellations.get(id)
      if (waiting === undefined) continue
      clearTimeout(waiting.timer)
      this.cancellations.delete(id)
      waiting.resolve({ accepted: false, code: 'lg_cancel_client_shutdown' })
    }
    return ids.length
  }

  submit(request: { requestId: string; userText: string; images?: readonly import('../../kernel/contracts/image-input.ts').ImageInput[]
    platformFacts?: import('../../kernel/app/bridge/turn-bridge.ts').BridgeInboundPlatformFacts
  }): Promise<BridgeWireResponse> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending.has(request.requestId)) return Promise.reject(new Error('lg_bridge_duplicate_request'))
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.fail('lg_bridge_timeout')
        // Drain through main.ts shutdown; a timeout does not prove the turn was rolled back.
        this.stopTransport()
      }, 180_000)
      this.pending.set(request.requestId, { resolve: done, reject, timer })
      this.inFlight.add(request.requestId)
      this.writeLine({ kind: 'SUBMIT_TURN', ...request })
    })
  }

  assessGroupReply(request: import('../../kernel/app/bridge/turn-bridge.ts').BridgeSubmitRequest): Promise<BridgeWireResponse> {
    if (this.failure) return Promise.reject(this.failure)
    // A foreground QQ/WeChat turn takes priority. No decision backlog and no transport reset on timeout.
    if (this.pending.size > 0) return Promise.resolve({ kind: 'GROUP_REPLY_DECISION', requestId: request.requestId,
      outcome: 'rejected', code: 'group_reply_foreground_busy' })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId)
        resolve({ kind: 'GROUP_REPLY_DECISION', requestId: request.requestId, outcome: 'failed', code: 'group_reply_timeout' })
      }, 40_000)
      this.pending.set(request.requestId, { resolve, reject, timer })
      this.writeLine({ kind: 'ASSESS_GROUP_REPLY', ...request })
    })
  }

  async close(): Promise<number | null> {
    this.cancelAllOutstanding('lg_client_close')
    if (this.transportClosed && this.process === undefined) return 0
    this.stopTransport()
    return await this.exit
  }
}
