import { randomUUID } from 'node:crypto'
import { qqId, type QqPrivateConfig } from './private-config.ts'
import type { BridgeWireResponse } from '../../kernel/app/bridge/turn-bridge.ts'
import { IMAGE_INPUT_LIMITS, type ImageInput } from '../../kernel/contracts/image-input.ts'
import { checkImageInputs, downloadQqImage } from '../media/image-input.ts'

type Submit = (request: { requestId: string; userText: string; images?: readonly ImageInput[] }) => Promise<BridgeWireResponse>
type Log = (reading: { event: string; requestId?: string; messageId?: string | number }) => void

/** Native Node 22 WebSocket, with a closed set of OneBot actions and one private owner. */
export class OneBotPrivateClient {
  private socket: WebSocket | undefined
  private verified = false
  private stopping = false
  private queue = Promise.resolve()
  private queued = 0
  private readonly seen = new Set<string>()
  private readonly pending = new Map<string, {
    resolve: (data: Record<string, unknown>) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(private readonly config: QqPrivateConfig, private readonly submit: Submit | undefined, private readonly log: Log) {}

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) throw new Error('onebot_already_connected')
    const url = new URL(this.config.wsUrl)
    url.searchParams.set('access_token', this.config.token)
    const socket = this.socket = new WebSocket(url)
    this.verified = false
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      if (typeof event.data !== 'string' || event.data.length > 100_000) return
      let packet: Record<string, unknown>
      try { packet = JSON.parse(event.data) } catch { return }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return
      if (typeof packet.echo === 'string') {
        const pending = this.pending.get(packet.echo)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(packet.echo)
        if (packet.status === 'ok' && packet.retcode === 0 && packet.data && typeof packet.data === 'object') {
          pending.resolve(packet.data as Record<string, unknown>)
        } else pending.reject(new Error('onebot_api_failed'))
        return
      }
      this.receive(packet, socket)
    })
    const disconnect = (): void => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.verified = false
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('onebot_disconnected'))
      }
      this.pending.clear()
      this.log({ event: 'onebot_disconnected' })
      if (socket.readyState !== WebSocket.CLOSED) socket.close()
    }
    socket.addEventListener('close', disconnect)
    socket.addEventListener('error', disconnect)
    try {
      await new Promise<void>((done, reject) => {
        const finish = (error?: Error): void => {
          clearTimeout(timer)
          socket.removeEventListener('error', fail)
          socket.removeEventListener('close', fail)
          socket.removeEventListener('open', open)
          if (error) reject(error)
          else done()
        }
        const timer = setTimeout(() => finish(new Error('onebot_connect_timeout')), 10_000)
        const fail = (): void => finish(new Error('onebot_connect_failed'))
        const open = (): void => finish()
        socket.addEventListener('error', fail, { once: true })
        socket.addEventListener('close', fail, { once: true })
        socket.addEventListener('open', open, { once: true })
      })
      const login = await this.call('get_login_info', {})
      if (qqId(login.user_id) !== this.config.botId) throw new Error('onebot_bot_account_mismatch')
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('onebot_disconnected')
      this.verified = true
      this.log({ event: 'onebot_owner_private_ready' })
    } catch (error) { disconnect(); throw error }
  }

  get connected(): boolean { return this.verified && this.socket?.readyState === WebSocket.OPEN }

  private call(action: 'get_login_info' | 'send_private_msg' | 'get_image', params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('onebot_not_connected'))
    const echo = randomUUID()
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('onebot_api_timeout')) }, 10_000)
      this.pending.set(echo, { resolve: done, reject, timer })
      socket.send(JSON.stringify({ action, params, echo }))
    })
  }

  private async sendText(text: string, socket: WebSocket): Promise<string | number> {
    if (!this.connected || this.socket !== socket) throw new Error('qq_delivery_disconnected')
    const sent = await this.call('send_private_msg', {
      user_id: this.config.ownerId, message: [{ type: 'text', data: { text } }],
    })
    if ((typeof sent.message_id !== 'number' || !Number.isSafeInteger(sent.message_id)) &&
        (typeof sent.message_id !== 'string' || !/^-?\d+$/.test(sent.message_id))) {
      throw new Error('qq_delivery_unconfirmed')
    }
    this.log({ event: 'qq_send_api_accepted', messageId: sent.message_id as string | number })
    return sent.message_id as string | number
  }

  /**
   * **主动投递**一条文字给本人（post-Lv2 / ADR-110 `D06`/`D08`）。
   *
   * ============================================================================
   *  它与 `receive()` 里那条发送路径的关系
   * ============================================================================
   * ```text
   * 同一个 socket、同一个 owner、同一条 `this.queue` 串行链
   * ⇒ **不会**两条并排写：普通回复优先（下面的等让逻辑），主动文字不插队
   * ```
   *
   * ⚠️ **结局三态**（`D08`）：`api_accepted`（有回执 id）/ `failed_confirmed`（平台明确拒）
   *    / `delivery_unknown`（超时、断开、接受了却没有回执 id）。
   *    ⚠️ 绝不返回"已送达"——QQ 协议不给那个凭据。
   * ⚠️ **不重试**：一次调用 = 一次尝试。重发由上层按 `D08` 的规则决定，
   *    而不是在这里"再试一次"（那会把"可能已送达"变成"确定送两次"）。
   */
  async deliverProactiveText(text: string): Promise<{
    status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'
    messageId?: string
    reason?: string
  }> {
    if (!this.connected || this.stopping) {
      /* 发送**前**就确定连接不可用 ⇒ 未发送（不是"结果不明"） */
      return { status: 'failed_confirmed', reason: 'qq_not_connected_before_send' }
    }
    const socket = this.socket!
    const task = this.queue.then(
      async () => await this.deliverOnQueue(text, socket),
      async () => await this.deliverOnQueue(text, socket)
    )
    this.queue = task.then(() => undefined, () => undefined)
    return await task
  }

  /** 在**同一条**串行链上真正发一次（普通回复优先：有在途回复时先让） */
  private async deliverOnQueue(
    text: string,
    socket: WebSocket
  ): Promise<{
    status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'
    messageId?: string
    reason?: string
  }> {
    /*
     * **普通回复优先**：`this.queued` 是"在途/排队的正式回复"计数。
     * 主动文字等它归零（有界）再发 —— 用户正在等一句回复时，主动问候不该插在它前面。
     * ⚠️ 有界是必须的：无界等待会让一条排不进去的主动文字永远占着队列尾。
     */
    for (let wait = 0; wait < 100 && this.queued > 0; wait += 1) {
      await new Promise((done) => setTimeout(done, 50))
    }
    if (!this.connected || this.socket !== socket) {
      return { status: 'failed_confirmed', reason: 'qq_delivery_disconnected' }
    }
    try {
      const messageId = await this.sendText(text, socket)
      return { status: 'api_accepted', messageId: String(messageId) }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_delivery_failed'
      this.log({ event: 'qq_proactive_delivery_failed', messageId: undefined })
      /*
       * ⚠️ 三个桶分开（`D08`）：
       * ```text
       * qq_delivery_unconfirmed   平台 ok 但**没有**回执 id ⇒ 结果不明（不是"没发出"）
       * onebot_api_failed         平台明确拒 ⇒ 确定失败
       * 其它（超时/断开/连接档）    ⇒ 结果不明
       * ```
       */
      if (code === 'onebot_api_failed') return { status: 'failed_confirmed', reason: code }
      if (code === 'qq_delivery_unconfirmed') return { status: 'delivery_unknown', reason: code }
      return { status: 'delivery_unknown', reason: code }
    }
  }

  private receive(packet: Record<string, unknown>, socket: WebSocket): void {
    const submit = this.submit
    if (submit === undefined) return // Read-only status probe: never consumes or replies to user messages.
    if (!this.connected || this.stopping || packet.post_type !== 'message' || packet.message_type !== 'private') return
    if (qqId(packet.self_id) !== this.config.botId || qqId(packet.user_id) !== this.config.ownerId ||
        packet.group_id !== undefined || packet.sub_type !== 'friend') return
    const sender = packet.sender as Record<string, unknown> | undefined
    if (!sender || qqId(sender.user_id) !== this.config.ownerId) return
    const id = packet.message_id
    if ((typeof id !== 'number' || !Number.isSafeInteger(id)) && (typeof id !== 'string' || !/^-?\d+$/.test(id))) return
    const requestId = `qq-private:${this.config.botId}:${id}`
    if (this.seen.has(requestId)) { this.log({ event: 'qq_duplicate_ignored', requestId }); return }
    this.seen.add(requestId)
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!)
    const segments = packet.message
    if (!Array.isArray(segments) || segments.length === 0 || segments.some((part) =>
      !part || !['text', 'image'].includes(part.type) ||
      (part.type === 'text' ? typeof part.data?.text !== 'string' : !part.data || part.data.type === 'flash'))) {
      void this.sendText('这个入口目前支持文字和普通图片消息。', socket).catch(() => this.log({ event: 'qq_delivery_failed', requestId }))
      return
    }
    const imageParts = segments.filter(part => part.type === 'image')
    if (imageParts.length > IMAGE_INPUT_LIMITS.maxImages) {
      void this.sendText('一条消息最多支持 4 张图片，请分开发送。', socket).catch(() => this.log({ event: 'qq_delivery_failed', requestId }))
      return
    }
    const userText = segments.filter(part => part.type === 'text').map((part) => part.data.text).join('') ||
      (imageParts.length ? '[用户发送了图片]' : '')
    if (!userText.trim() || userText.length > 6000) {
      this.log({ event: 'qq_text_rejected', requestId })
      return
    }
    if (this.queued >= 4) {
      void this.sendText('前面的消息还在处理中，请稍后再发。', socket).catch(() => this.log({ event: 'qq_delivery_failed', requestId }))
      return
    }
    this.queued++
    this.queue = this.queue.then(async () => {
      if (!this.connected || this.socket !== socket) { this.log({ event: 'qq_queued_disconnected', requestId }); return }
      let response: BridgeWireResponse
      let images: ImageInput[] | undefined
      if (imageParts.length) {
        try {
          images = []
          for (const part of imageParts) {
            if (Number(part.data.file_size) > IMAGE_INPUT_LIMITS.maxImageBytes) throw new Error('image_input_too_large')
            let url = part.data.url
            if (!url && typeof part.data.file === 'string') url = (await this.call('get_image', { file: part.data.file })).url
            images.push(await downloadQqImage(url))
          }
          checkImageInputs(images)
        } catch {
          this.log({ event: 'qq_image_input_failed', requestId })
          await this.sendText('这次没有成功读取图片。请重发 PNG/JPEG 图片（每张不超过 8 MiB、合计不超过 16 MiB，最多 4 张）。', socket)
          return
        }
      }
      if (!this.connected || this.socket !== socket) return
      try { response = await submit({ requestId, userText, ...(images ? { images } : {}) }) }
      catch {
        this.log({ event: 'lg_turn_failed', requestId })
        await this.sendText('这轮连接失败了，消息可能已经记入会话。请稍后重新发送。', socket)
        return
      }
      if (response.outcome === 'replied' && typeof response.replyText === 'string' && response.replyText.trim()) {
        await this.sendText(response.replyText, socket)
      } else {
        this.log({ event: 'lg_turn_failed', requestId })
        await this.sendText(response.code === 'image_input_disabled' ? '图片输入尚未启用。' :
          images ? '这轮看图没有完成，无法确认图片内容。请稍后重发。' :
          '这轮回复没有完成，消息可能已经记入会话。请稍后重新发送。', socket)
      }
    }).catch(() => this.log({ event: 'qq_delivery_failed', requestId })).finally(() => { this.queued-- })
  }

  async drain(): Promise<void> { await this.queue }

  async close(): Promise<void> {
    this.stopping = true
    await this.drain()
    const socket = this.socket
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((done) => {
        socket.addEventListener('close', () => done(), { once: true })
        socket.close()
      })
    }
  }
}
