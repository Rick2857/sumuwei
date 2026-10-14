import { randomUUID } from 'node:crypto'
import { qqId, type QqPrivateConfig } from './private-config.ts'
import type { BridgeWireResponse } from '../../kernel/app/bridge/turn-bridge.ts'
import { IMAGE_INPUT_LIMITS, type ImageInput } from '../../kernel/contracts/image-input.ts'
import { checkImageInputs, downloadQqImage } from '../media/image-input.ts'
import { addressedByName, GroupContextBuffer, type GroupContextLine } from './group-context.ts'

type Submit = (request: {
  requestId: string
  userText: string
  images?: readonly ImageInput[]
  groupContext?: readonly GroupContextLine[]
  /**
   * **U1 / `ADR-138` · WP2b-2b 的前置（加性）**：这一轮的**入站平台事实**。
   *
   * ```text
   * ⚠️ 核心侧今天**还没有**消费它 ⇒ 带上它**不改变任何行为**（本客户端 L194-197 的
   *    "只收原主人包"那道结构性单用户闸**一个字未动**）。
   *    它的唯一作用是：等核心侧接上 `resolveInboundTurnScope` 时，事实已经在管线上。
   * ```
   */
  platformFacts?: {
    readonly transport: 'qq'
    readonly selfId: string
    readonly senderUserId: string
    readonly messageType: string
    readonly groupId?: string
  }
}) => Promise<BridgeWireResponse>
type Log = (reading: { event: string; requestId?: string; messageId?: string | number }) => void

/** Native Node 22 WebSocket, closed OneBot actions and program-verified admission. */
export class OneBotPrivateClient {
  private socket: WebSocket | undefined
  private verified = false
  private stopping = false
  private queue = Promise.resolve()
  private queued = 0
  private readonly seen = new Set<string>()
  private readonly groupBuffer = new GroupContextBuffer()
  private readonly groupReplies = new Map<string, Set<string>>()
  private readonly lastAccepted = new Map<string, number>()
  private readonly userQueued = new Map<string, number>()
  private readonly groupQueued = new Map<string, number>()
  private readonly revokedGroups = new Set<string>()
  private readonly groupEpochs = new Map<string, number>()
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

  private call(action: 'get_login_info' | 'send_private_msg' | 'send_group_msg' | 'get_group_member_info' | 'get_image', params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('onebot_not_connected'))
    const echo = randomUUID()
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('onebot_api_timeout')) }, 10_000)
      this.pending.set(echo, { resolve: done, reject, timer })
      socket.send(JSON.stringify({ action, params, echo }))
    })
  }

  async isAllowedUser(userId: string, groupId?: string): Promise<boolean> {
    if (userId === this.config.botId || qqId(userId) === undefined) return false
    if (groupId === undefined && userId === this.config.ownerId) return true
    if (!this.config.multiUserEnabled || !this.connected) return false
    const groups = groupId === undefined ? this.config.allowedGroupIds ?? [] :
      (this.config.allowedGroupIds?.includes(groupId) ? [groupId] : [])
    for (const id of groups) {
      if (this.revokedGroups.has(id)) continue
      try {
        const bot = await this.call('get_group_member_info', { group_id: id, user_id: this.config.botId, no_cache: true })
        if (qqId(bot.user_id) !== this.config.botId || qqId(bot.group_id) !== id) continue
        const member = await this.call('get_group_member_info', { group_id: id, user_id: userId, no_cache: true })
        if (qqId(member.user_id) === userId && qqId(member.group_id) === id) return true
      } catch { /* Missing membership or unavailable platform never grants access. */ }
    }
    return false
  }

  private async sendText(text: string, socket: WebSocket,
    target: { userId: string; groupId?: string } = { userId: this.config.ownerId }): Promise<string | number> {
    if (!this.connected || this.socket !== socket) throw new Error('qq_delivery_disconnected')
    if (!await this.isAllowedUser(target.userId, target.groupId)) throw new Error('qq_target_no_longer_authorized')
    const sent = await this.call(target.groupId === undefined ? 'send_private_msg' : 'send_group_msg', {
      ...(target.groupId === undefined ? { user_id: target.userId } : { group_id: target.groupId }),
      message: [{ type: 'text', data: { text } }],
    })
    if ((typeof sent.message_id !== 'number' || !Number.isSafeInteger(sent.message_id)) &&
        (typeof sent.message_id !== 'string' || !/^-?\d+$/.test(sent.message_id))) {
      throw new Error('qq_delivery_unconfirmed')
    }
    this.log({ event: 'qq_send_api_accepted', messageId: sent.message_id as string | number })
    if (target.groupId !== undefined) {
      const replies = this.groupReplies.get(target.groupId) ?? new Set<string>()
      replies.add(String(sent.message_id))
      while (replies.size > 100) replies.delete(replies.values().next().value!)
      this.groupReplies.set(target.groupId, replies)
    }
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
    if (this.connected && qqId(packet.self_id) === this.config.botId && packet.post_type === 'notice') {
      const group = qqId(packet.group_id)
      if (group && this.config.allowedGroupIds?.includes(group) && ['group_decrease', 'group_increase'].includes(String(packet.notice_type))) {
        this.groupEpochs.set(group, (this.groupEpochs.get(group) ?? 0) + 1)
        this.groupBuffer.clear(group); this.groupReplies.delete(group)
        if (qqId(packet.user_id) === this.config.botId) {
          if (packet.notice_type === 'group_decrease') this.revokedGroups.add(group)
          else this.revokedGroups.delete(group)
        }
      }
      return
    }
    if (!this.connected || this.stopping || packet.post_type !== 'message') return
    const userId = qqId(packet.user_id)
    const groupId = packet.message_type === 'group' ? qqId(packet.group_id) : undefined
    if (qqId(packet.self_id) !== this.config.botId || userId === undefined || userId === this.config.botId) return
    if (packet.message_type === 'group') {
      if (!this.config.multiUserEnabled || !groupId || !this.config.allowedGroupIds?.includes(groupId) || this.revokedGroups.has(groupId) || packet.anonymous || packet.sub_type !== 'normal') return
    } else if (packet.message_type !== 'private' || packet.group_id !== undefined ||
      !(this.config.multiUserEnabled ? ['friend', 'group', 'other'].includes(String(packet.sub_type)) : packet.sub_type === 'friend') ||
      (!this.config.multiUserEnabled && userId !== this.config.ownerId)) return
    const sender = packet.sender as Record<string, unknown> | undefined
    if (!sender || qqId(sender.user_id) !== userId) return
    const id = packet.message_id
    if ((typeof id !== 'number' || !Number.isSafeInteger(id)) && (typeof id !== 'string' || !/^-?\d+$/.test(id))) return
    const requestId = groupId === undefined && !this.config.multiUserEnabled ? `qq-private:${this.config.botId}:${id}` :
      `qq:${this.config.botId}:${groupId === undefined ? `private:${userId}` : `group:${groupId}`}:${id}`
    if (this.seen.has(requestId)) { this.log({ event: 'qq_duplicate_ignored', requestId }); return }
    this.seen.add(requestId)
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!)
    const segments = packet.message
    const target = { userId, ...(groupId === undefined ? {} : { groupId }) }
    const groupEpoch = groupId === undefined ? 0 : this.groupEpochs.get(groupId) ?? 0
    let groupContext: readonly GroupContextLine[] | undefined
    if (groupId !== undefined) {
      if (!Array.isArray(segments) || segments.some(part => !part || !['text', 'at', 'reply'].includes(part.type)
        || !part.data || (part.type === 'text' && typeof part.data.text !== 'string'))) return
      const text = segments.filter(part => part.type === 'text').map(part => part.data?.text ?? '').join('')
      if (!text.trim() || text.length > 6000) return
      groupContext = this.groupBuffer.read(groupId)
      this.groupBuffer.add(groupId, { senderId: userId, text, at: Date.now() })
      const addressed = segments.some(part => part.type === 'at' && qqId(part.data?.qq) === this.config.botId)
        || segments.some(part => part.type === 'reply' && this.groupReplies.get(groupId)?.has(String(part.data?.id)))
        || addressedByName(text)
      if (!addressed) return
    }
    if (!Array.isArray(segments) || segments.length === 0 || segments.some((part) =>
      !part || !(groupId === undefined ? ['text', 'image'] : ['text', 'at', 'reply']).includes(part.type) ||
      (part.type === 'text' ? typeof part.data?.text !== 'string' : !part.data || part.data.type === 'flash'))) {
      if (userId === this.config.ownerId) void this.sendText('这个入口目前支持文字和普通图片消息。', socket, target).catch(() => this.log({ event: 'qq_delivery_failed', requestId }))
      return
    }
    const imageParts = segments.filter(part => part.type === 'image')
    if (imageParts.length > IMAGE_INPUT_LIMITS.maxImages) {
      void this.sendText('一条消息最多支持 4 张图片，请分开发送。', socket, target).catch(() => this.log({ event: 'qq_delivery_failed', requestId }))
      return
    }
    const userText = segments.filter(part => part.type === 'text').map((part) => part.data.text).join('') ||
      (imageParts.length ? '[用户发送了图片]' : '')
    if (!userText.trim() || userText.length > 6000) {
      this.log({ event: 'qq_text_rejected', requestId })
      return
    }
    if (this.queued >= (this.config.multiUserEnabled ? 16 : 4) || (this.config.multiUserEnabled && (this.userQueued.get(userId) ?? 0) >= 2)
      || (groupId !== undefined && (this.groupQueued.get(groupId) ?? 0) >= 4)) {
      if (userId === this.config.ownerId) void this.sendText('前面的消息还在处理中，请稍后再发。', socket, target).catch(() => this.log({ event: 'qq_delivery_failed', requestId }))
      return
    }
    const rateKey = groupId === undefined ? `private:${userId}` : `group:${groupId}:${userId}`
    if (this.config.multiUserEnabled && userId !== this.config.ownerId && Date.now() - (this.lastAccepted.get(rateKey) ?? 0) < 3000) return
    this.lastAccepted.set(rateKey, Date.now())
    if (this.lastAccepted.size > 1024) this.lastAccepted.delete(this.lastAccepted.keys().next().value!)
    this.userQueued.set(userId, (this.userQueued.get(userId) ?? 0) + 1)
    if (groupId !== undefined) this.groupQueued.set(groupId, (this.groupQueued.get(groupId) ?? 0) + 1)
    this.queued++
    this.queue = this.queue.then(async () => {
      if (!this.connected || this.socket !== socket) { this.log({ event: 'qq_queued_disconnected', requestId }); return }
      if (!await this.isAllowedUser(userId, groupId)) {
        if (groupId !== undefined) this.groupBuffer.clear(groupId)
        this.log({ event: 'qq_member_not_authorized', requestId }); return
      }
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
          await this.sendText('这次没有成功读取图片。请重发 PNG/JPEG 图片（每张不超过 8 MiB、合计不超过 16 MiB，最多 4 张）。', socket, target)
          return
        }
      }
      if (!this.connected || this.socket !== socket) return
      try {
        response = await submit({
          requestId,
          userText,
          ...(images ? { images } : {}),
          ...(groupContext === undefined || groupId === undefined || groupEpoch !== (this.groupEpochs.get(groupId) ?? 0)
            ? {} : { groupContext }),
          // Only validated platform facts cross the bridge; the model cannot choose actor/room.
          platformFacts: {
            transport: 'qq',
            selfId: String(packet.self_id),
            senderUserId: String(packet.user_id),
            messageType: String(packet.message_type),
            ...(packet.group_id === undefined ? {} : { groupId: String(packet.group_id) }),
          },
        })
      }
      catch {
        this.log({ event: 'lg_turn_failed', requestId })
        await this.sendText('这轮连接失败了，消息可能已经记入会话。请稍后重新发送。', socket, target)
        return
      }
      if (response.outcome === 'replied' && typeof response.replyText === 'string' && response.replyText.trim()) {
        await this.sendText(response.replyText, socket, target)
      } else {
        this.log({ event: 'lg_turn_failed', requestId })
        await this.sendText(response.code === 'image_input_disabled' ? '图片输入尚未启用。' :
          images ? '这轮看图没有完成，无法确认图片内容。请稍后重发。' :
          '这轮回复没有完成，消息可能已经记入会话。请稍后重新发送。', socket, target)
      }
    }).catch(() => this.log({ event: 'qq_delivery_failed', requestId })).finally(() => {
      this.queued--; const remaining = (this.userQueued.get(userId) ?? 1) - 1
      if (remaining === 0) this.userQueued.delete(userId); else this.userQueued.set(userId, remaining)
      if (groupId !== undefined) {
        const groupsRemaining = (this.groupQueued.get(groupId) ?? 1) - 1
        if (groupsRemaining === 0) this.groupQueued.delete(groupId); else this.groupQueued.set(groupId, groupsRemaining)
      }
    })
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
