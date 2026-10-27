import { randomUUID } from 'node:crypto'
import { qqId, type QqPrivateConfig } from './private-config.ts'
import type { BridgeWireResponse } from '../../kernel/app/bridge/turn-bridge.ts'
import { qqMediaSelectionOf } from '../../kernel/contracts/qq-media-reply.ts'
import {
  inspectWav,
  oneBotRecordFileUrl,
  QQ_VOICE_LIMITS,
  wavDeliveryProblem,
  type QqVoiceOutput,
  type QqVoiceSynthesisResult,
} from './voice-reply.ts'
import {
  sha256Bytes,
  sha256Text,
  type QqDeliveryJournalEntry,
  type QqDeliveryJournalPort,
  type QqDeliveryPurpose,
} from './voice-delivery-journal.ts'
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
type Log = (reading: {
  event: string
  requestId?: string
  messageId?: string | number
  /**
   * 具名原因（post-Lv2 / P1：语音回落 / 结果不明 / 兜底）。
   *
   * ⚠️ 只放**原因码与结构读数**，不放正文、不放音频字节。
   */
  reason?: string
}) => void

/** 一条出站 QQ 消息段（闭集：text / record 两种；其余发送路径不变） */
type OutboundSegment = { type: 'text'; data: { text: string } } | { type: 'record'; data: { file: string } }

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

  constructor(
    private readonly config: QqPrivateConfig,
    private readonly submit: Submit | undefined,
    private readonly log: Log,
    /**
     * post-Lv2 / P1：**语音输出端口**（可选；不传 = 这个外壳没有合成能力）。
     *
     * ⚠️ 可选是刻意的：不装端口时，"她选了语音"会**如实**回落到文字并记
     *    `voice_output_absent`，而不是假装发过语音、也不是把稿子念错。
     */
    private readonly voice: QqVoiceOutput | undefined = undefined,
    /**
     * post-Lv2 / P2：**持久化投递日志**（可选；生产外壳在协议打开时必装）。
     *
     * ⚠️ 不传 = P1 的"无跨重启去重"行为（读数会记 `qq_delivery_journal_absent`）。
     * ⚠️ 传了但不可读/不可写 ⇒ 语音一律回落文字（`delivery_journal_unavailable`）；
     *    文字路径保持旧行为，只记录"去重不可用"。
     */
    private readonly journal: QqDeliveryJournalPort | undefined = undefined,
  ) {
    /*
     * 重启收尾：把遗留 `reserved` 追加成 `unknown_after_restart`。
     * ⚠️ 遗留"发送中"**不重播**；同一逻辑键再次入站会被 `reserve` 判重复而跳过。
     */
    if (journal !== undefined) {
      try {
        const recovered = journal.recover()
        if (recovered > 0) this.log({ event: 'qq_delivery_recovered_unknown', reason: `recovered=${recovered}` })
      } catch (error) {
        this.log({ event: 'qq_delivery_journal_unavailable', reason: error instanceof Error ? error.message : 'recover_failed' })
      }
    }
  }

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
    return await this.sendSegments([{ type: 'text', data: { text } }], socket, target)
  }

  /**
   * 发一条**语音**消息段（post-Lv2 / P1 的 P2 侧最小接点）。
   *
   * ⚠️ 走 `base64://`：不暴露宿主/容器路径、不开公开下载口。
   * ⚠️ 与文字发送**同一条**身份检查、队列与 messageId 校验（不是第二条发送路径）。
   */
  private async sendRecord(fileUrl: string, socket: WebSocket,
    target: { userId: string; groupId?: string } = { userId: this.config.ownerId }): Promise<string | number> {
    if (!fileUrl.startsWith('base64://') || fileUrl.length > QQ_VOICE_LIMITS.maxAudioBytes * 6) {
      throw new Error('qq_record_unexpected_file')
    }
    return await this.sendSegments([{ type: 'record', data: { file: fileUrl } }], socket, target)
  }

  private async sendSegments(segments: readonly OutboundSegment[], socket: WebSocket,
    target: { userId: string; groupId?: string } = { userId: this.config.ownerId }): Promise<string | number> {
    if (!this.connected || this.socket !== socket) throw new Error('qq_delivery_disconnected')
    if (!await this.isAllowedUser(target.userId, target.groupId)) throw new Error('qq_target_no_longer_authorized')
    const sent = await this.call(target.groupId === undefined ? 'send_private_msg' : 'send_group_msg', {
      ...(target.groupId === undefined ? { user_id: target.userId } : { group_id: target.groupId }),
      message: [...segments],
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
        await this.deliverTurnReply(response, socket, target, requestId)
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

  /**
   * 把一轮**已经过回复守卫**的结果投递出去（post-Lv2 / P1）。
   *
   * ```text
   * 没有媒介选择 / 选了 text           ⇒ 既有文字路径（**零**合成调用）
   * 选了 voice + 装了端口              ⇒ 合成 → 结构校验 → record 段
   * 选了 voice + 没装端口              ⇒ 文字兜底 + `voice_output_absent`
   * 选了 voice + 合成失败/超限/坏 WAV   ⇒ 文字兜底 + 具名原因
   * 选了 voice + 平台明确拒绝 record    ⇒ **一次**文字兜底（确定未发出）
   * 选了 voice + 超时/断开/无回执 id    ⇒ `delivery_unknown`：不重发、不兜底
   * ```
   *
   * ⚠️ 绝不做的事：把音频重发第二遍、把 `api_accepted` 说成"已听"、
   *    在权限被撤销后拿文字兜底绕过权限（兜底走的是同一条身份检查）。
   */
  private async deliverTurnReply(
    response: BridgeWireResponse,
    socket: WebSocket,
    target: { userId: string; groupId?: string },
    requestId: string,
  ): Promise<void> {
    const replyText = response.replyText!
    const media = qqMediaSelectionOf((response as { media?: unknown }).media)
    const appendix = typeof (response as { mediaAppendix?: unknown }).mediaAppendix === 'string'
      ? String((response as { mediaAppendix: string }).mediaAppendix).trim()
      : ''
    const fallbackText = appendix === '' ? replyText : `${replyText}\n\n${appendix}`
    if (media === undefined) {
      await this.sendText(replyText, socket, target)
      return
    }
    /*
     * 逻辑回复键：**受信入站 requestId**（`qq:<bot>:private|group:<会话>:<message_id>`），
     * ⚠️ 不是每次重生成的 replyId —— 换键就等于绕过去重。
     */
    const key = `qq-reply:${requestId}`
    const journal = this.journal
    const startedAt = Date.now()
    if (journal === undefined) {
      this.log({ event: 'qq_delivery_journal_absent', requestId })
    } else {
      const reservation = this.reserveDelivery(journal, {
        key, requestId, purpose: 'reply', requested: media.mode, now: startedAt,
        ...(response.replyId === undefined ? {} : { replyId: response.replyId }),
        ...(response.traceId === undefined ? {} : { traceId: response.traceId }),
      })
      if (reservation === 'duplicate') {
        /* 同一逻辑回复已经投递过/留有结局 ⇒ **不再发第二条**（重启重投也走这里） */
        this.log({ event: 'qq_delivery_duplicate_skipped', requestId, reason: key })
        return
      }
      if (reservation === 'unavailable') {
        this.log({ event: 'qq_delivery_journal_unavailable', requestId, reason: 'reserve_unavailable' })
        if (media.mode === 'voice') {
          this.log({ event: 'qq_voice_fallback_text', requestId, reason: 'delivery_journal_unavailable' })
          await this.sendText(fallbackText, socket, target)
          return
        }
        /* 文字：日志坏了也不改变旧行为（只记录"去重不可用"） */
        await this.sendText(replyText, socket, target)
        return
      }
    }
    let synthesisFacts: Pick<QqDeliveryJournalEntry, 'ttsRequestId' | 'ttsUsage'> = {}
    const record = (entry: Partial<QqDeliveryJournalEntry> & Pick<QqDeliveryJournalEntry, 'status'>): void => {
      this.appendDelivery(journal, {
        at: Date.now(), key, requestId, purpose: 'reply', attempt: 1, ...synthesisFacts, ...entry,
      })
    }
    if (media.mode !== 'voice') {
      await this.sendRecordedText({
        text: replyText, socket, target, requestId, requested: 'text', record,
        ...(media.fallback === undefined ? {} : { reason: media.fallback }),
      })
      return
    }
    const voice = this.voice
    if (voice === undefined) {
      /* 她选了语音，但这个外壳没有合成能力 ⇒ 如实回落，不假装发过语音 */
      this.log({ event: 'qq_voice_fallback_text', requestId, reason: 'voice_output_absent' })
      record({ status: 'fallback_text', requested: 'voice', effective: 'text', reason: 'voice_output_absent', totalMs: Date.now() - startedAt })
      await this.sendRecordedText({ text: fallbackText, socket, target, requestId, requested: 'voice', record, reason: 'voice_output_absent' })
      return
    }
    const synthStarted = Date.now()
    const synthetic = await this.synthesizeVoice(voice, replyText, requestId)
    const synthMs = Date.now() - synthStarted
    if (!synthetic.ok) {
      this.log({ event: 'qq_voice_fallback_text', requestId, reason: synthetic.reason })
      record({
        status: 'fallback_text', requested: 'voice', effective: 'text', reason: synthetic.reason,
        synthMs, totalMs: Date.now() - startedAt,
      })
      await this.sendRecordedText({ text: fallbackText, socket, target, requestId, requested: 'voice', record, reason: synthetic.reason })
      return
    }
    const audio = synthetic.result.audio
    // Store provider-reported units separately from estimates or monetary cost.
    synthesisFacts = {
      ...(synthetic.result.providerRequestId === undefined ? {} : { ttsRequestId: synthetic.result.providerRequestId }),
      ...(synthetic.result.usage === undefined ? {} : { ttsUsage: synthetic.result.usage }) }
    const problem = synthetic.result.format !== 'wav' ? 'voice_audio_not_wav' : wavDeliveryProblem(audio)
    if (problem !== undefined) {
      this.log({ event: 'qq_voice_fallback_text', requestId, reason: problem })
      record({
        status: 'fallback_text', requested: 'voice', effective: 'text', reason: problem,
        synthMs, totalMs: Date.now() - startedAt,
      })
      await this.sendRecordedText({ text: fallbackText, socket, target, requestId, requested: 'voice', record, reason: problem })
      return
    }
    const inspection = inspectWav(audio)
    const textSha256 = sha256Text(replyText)
    const audioSha256 = sha256Bytes(audio)
    try {
      const messageId = await this.sendRecord(oneBotRecordFileUrl(audio), socket, target)
      /*
       * ⚠️ 只记平台接受 + 结构读数：**不是**"她听到了"、**不是**"播放过"。
       *    音频时长/字节数是**读数**，不参与任何判据。
       */
      record({
        status: 'api_accepted', requested: 'voice', effective: 'voice', messageId: String(messageId),
        textSha256, audioSha256, audioBytes: audio.byteLength,
        audioDurationMs: inspection?.durationMs ?? 0, synthMs, totalMs: Date.now() - startedAt,
      })
      this.log({
        event: 'qq_voice_send_api_accepted',
        requestId,
        messageId,
        reason: `${audio.byteLength}b/${inspection?.durationMs ?? 0}ms`,
      })
      /* 来源附录作为**伴随文字**单独发、单独记结果（语音正文不念 URL） */
      if (appendix !== '') {
        await this.sendMediaAppendix({ appendix, key, requestId, socket, target, replyId: response.replyId })
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_voice_send_failed'
      if (code === 'onebot_api_failed') {
        /*
         * 平台**明确拒绝** ⇒ 可确认语音未发出 ⇒ 允许**一次**文字兜底。
         * ⚠️ 兜底走 `sendText`（同一条目标校验）：权限被撤时它同样会拒绝。
         */
        this.log({ event: 'qq_voice_fallback_text', requestId, reason: 'platform_rejected_record' })
        record({
          status: 'failed_confirmed', requested: 'voice', effective: 'voice', reason: 'platform_rejected_record',
          textSha256, audioSha256, audioBytes: audio.byteLength, audioDurationMs: inspection?.durationMs ?? 0,
          synthMs, totalMs: Date.now() - startedAt,
        })
        await this.sendRecordedText({ text: fallbackText, socket, target, requestId, requested: 'voice', record, reason: 'platform_rejected_record' })
        return
      }
      /* 超时 / 断开 / 接受了却没有回执 id ⇒ 结果不明：不重发，也不立即发同内容文字 */
      this.log({ event: 'qq_voice_delivery_unknown', requestId, reason: code })
      record({
        status: 'delivery_unknown', requested: 'voice', effective: 'voice', reason: code,
        textSha256, audioSha256, audioBytes: audio.byteLength, audioDurationMs: inspection?.durationMs ?? 0,
        synthMs, totalMs: Date.now() - startedAt,
      })
    }
  }

  /** 发送**文字**（正式回复或兜底），并把真实结局追加进投递日志 */
  private async sendRecordedText(input: {
    text: string
    socket: WebSocket
    target: { userId: string; groupId?: string }
    requestId: string
    requested: 'text' | 'voice'
    record: (entry: Partial<QqDeliveryJournalEntry> & Pick<QqDeliveryJournalEntry, 'status'>) => void
    reason?: string
  }): Promise<void> {
    const textSha256 = sha256Text(input.text)
    try {
      const messageId = await this.sendText(input.text, input.socket, input.target)
      input.record({
        status: 'api_accepted', requested: input.requested, effective: 'text', messageId: String(messageId),
        textSha256,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_send_failed'
      const status = this.classifySendFailure(code)
      input.record({
        status, requested: input.requested, effective: 'text', reason: code, textSha256,
      })
      this.log({
        event: status === 'delivery_unknown' ? 'qq_text_delivery_unknown' : 'qq_text_delivery_failed_confirmed',
        requestId: input.requestId,
        reason: code,
      })
    }
  }

  /** 语音回复的**伴随来源附录**：单独一条文字、单独记结果（失败不影响已发出的语音） */
  private async sendMediaAppendix(input: {
    appendix: string
    key: string
    requestId: string
    socket: WebSocket
    target: { userId: string; groupId?: string }
    replyId?: string
  }): Promise<void> {
    const journal = this.journal
    const record = (entry: Partial<QqDeliveryJournalEntry> & Pick<QqDeliveryJournalEntry, 'status'>): void => {
      this.appendDelivery(journal, {
        at: Date.now(), key: input.key, requestId: input.requestId, purpose: 'appendix' as QqDeliveryPurpose,
        attempt: 1, ...entry,
      })
    }
    if (journal !== undefined) {
      const reservation = this.reserveDelivery(journal, {
        key: input.key, requestId: input.requestId, purpose: 'appendix', requested: 'voice', now: Date.now(),
        ...(input.replyId === undefined ? {} : { replyId: input.replyId }),
      })
      if (reservation === 'duplicate') {
        this.log({ event: 'qq_appendix_duplicate_skipped', requestId: input.requestId })
        return
      }
      if (reservation === 'unavailable') {
        this.log({ event: 'qq_appendix_skipped', requestId: input.requestId, reason: 'delivery_journal_unavailable' })
        return
      }
    }
    const textSha256 = sha256Text(input.appendix)
    try {
      const messageId = await this.sendText(input.appendix, input.socket, input.target)
      record({ status: 'api_accepted', requested: 'voice', effective: 'text', messageId: String(messageId), textSha256 })
      this.log({ event: 'qq_appendix_send_api_accepted', requestId: input.requestId, messageId })
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_appendix_send_failed'
      record({ status: this.classifySendFailure(code), requested: 'voice', effective: 'text', reason: code, textSha256 })
      this.log({ event: 'qq_appendix_send_failed', requestId: input.requestId, reason: code })
    }
  }

  /** 一次占用（失败关闭：日志异常一律当"不可用"，**不**猜它记下了没有） */
  private reserveDelivery(
    journal: QqDeliveryJournalPort,
    input: Parameters<QqDeliveryJournalPort['reserve']>[0],
  ): 'ok' | 'duplicate' | 'unavailable' {
    try {
      const result = journal.reserve(input)
      return result.ok ? 'ok' : result.reason
    } catch {
      return 'unavailable'
    }
  }

  /** 追加一条结局；写失败只记读数（日志对象会自己标坏 ⇒ 下一次语音发送回落到文字） */
  private appendDelivery(journal: QqDeliveryJournalPort | undefined, entry: Partial<QqDeliveryJournalEntry> & Pick<QqDeliveryJournalEntry, 'status'> & {
    at: number
    key: string
    requestId: string
    purpose: QqDeliveryPurpose
    attempt: number
  }): void {
    if (journal === undefined) return
    try {
      journal.append(entry as QqDeliveryJournalEntry)
    } catch (error) {
      this.log({ event: 'qq_delivery_journal_write_failed', reason: error instanceof Error ? error.message : 'append_failed' })
    }
  }

  /**
   * 发送失败的**结局分类**（闭集两态）。
   *
   * ⚠️ 发送**之前**就确定没发出去（未连接/目标不再获准/平台明确拒）
   *    ⇒ `failed_confirmed`；其余一律 `delivery_unknown`（宁可不说，也不重复）。
   */
  private classifySendFailure(code: string): 'failed_confirmed' | 'delivery_unknown' {
    return code === 'onebot_api_failed' || code === 'qq_target_no_longer_authorized' ||
      code === 'onebot_not_connected' || code === 'qq_delivery_disconnected'
      ? 'failed_confirmed'
      : 'delivery_unknown'
  }

  /**
   * 合成一次（有界）。**只合成、不发送、不兜底** —— 兜底与记账由调用方做。
   *
   * ⚠️ 超时走 `Promise.race` **并且** abort 端口：端口若忽略 signal，外壳仍然
   *    按期限放弃等待（不让一次坏 TTS 把整条发送队列永远占住）。
   */
  private async synthesizeVoice(
    voice: QqVoiceOutput,
    text: string,
    requestId: string,
  ): Promise<{ ok: true; result: QqVoiceSynthesisResult } | { ok: false; reason: string }> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('voice_synthesis_timeout'))
      }, QQ_VOICE_LIMITS.maxSynthesisMs)
    })
    try {
      const result = await Promise.race([
        voice.synthesizer.synthesize({ text, deadlineMs: QQ_VOICE_LIMITS.maxSynthesisMs, signal: controller.signal }),
        timeout,
      ])
      if (result === null || typeof result !== 'object' || !(result.audio instanceof Uint8Array)) {
        return { ok: false, reason: 'voice_synthesis_bad_result' }
      }
      return { ok: true, result }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'voice_synthesis_failed'
      this.log({ event: 'qq_voice_synthesis_failed', requestId, reason: code })
      return { ok: false, reason: code }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
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
