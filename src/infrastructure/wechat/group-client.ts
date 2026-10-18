import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BridgeInboundPlatformFacts, BridgeWireResponse } from '../../kernel/app/bridge/turn-bridge.ts'
import { GroupContextBuffer, type GroupContextLine } from '../qq/group-context.ts'

export interface WechatConfig {
  baseUrl: string; token: string; botId: string; ownerId: string
  groupIds: readonly string[]; stateFile: string
}
export function readWechatConfig(env: NodeJS.ProcessEnv): WechatConfig | undefined {
  if (env.WECHAT_ENABLED !== 'true') return undefined
  const url = new URL(env.WECHAT_API_URL ?? 'http://127.0.0.1:16174')
  const token = env.WECHAT_API_TOKEN ?? ''
  const botId = env.WECHAT_BOT_ID ?? ''; const ownerId = env.WECHAT_OWNER_ID ?? ''
  const groupIds = [...new Set((env.WECHAT_ALLOWED_GROUP_IDS ?? '').split(/[,\s]+/).filter(Boolean))]
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash || !/^[a-zA-Z0-9_-]{24,}$/.test(token) ||
    !platformId(botId) || !platformId(ownerId) || botId === ownerId || groupIds.length === 0 ||
    groupIds.some(id => !/^\d+@chatroom$/.test(id)) || !env.WECHAT_STATE_FILE) throw new Error('wechat_config_invalid')
  return { baseUrl: url.origin, token, botId, ownerId, groupIds, stateFile: env.WECHAT_STATE_FILE }
}
function platformId(id: unknown): id is string { return typeof id === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{2,100}$/.test(id) }
export interface WechatMessage {
  localId: number; chatId: string; sender?: string; type: number; content: string
  timestamp: string; isSelf?: boolean; isMentioned?: boolean
  reply?: { sender?: string; [key: string]: unknown }
}
/** serverId is an i64 serialized as a JSON number: never use its rounded JS value as identity. */
export function wechatMessageKey(m: WechatMessage): string {
  return createHash('sha256').update(JSON.stringify([m.chatId, m.localId, m.timestamp, m.sender, m.type, m.content])).digest('hex')
}
export function validWechatMessage(m: WechatMessage, groupId: string, botId: string, now = Date.now()): boolean {
  const at = Date.parse(m.timestamp)
  return m.chatId === groupId && Number.isSafeInteger(m.localId) && m.localId > 0 && m.type === 1 &&
    platformId(m.sender) && m.sender !== botId && m.isSelf === false && typeof m.content === 'string' &&
    m.content.trim().length > 0 && m.content.length <= 6000 && Number.isFinite(at) && at >= now - 300_000 && at <= now + 30_000
}

export class WechatApi {
  constructor(readonly config: WechatConfig, private readonly signal?: AbortSignal) {}
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(this.config.baseUrl + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: 'error' })
    if (!response.ok) throw new Error(`wechat_http_${response.status}`)
    return await response.json()
  }
  async assertAccount(): Promise<void> {
    const a = await this.request('/api/status/auth') as { status?: string; loggedInUser?: string }
    if (a.status !== 'logged_in' || typeof a.loggedInUser !== 'string' ||
      (a.loggedInUser !== this.config.botId && !a.loggedInUser.startsWith(this.config.botId + '_'))) throw new Error('wechat_account_not_ready')
  }
  async assertGroup(groupId: string): Promise<void> {
    if (!this.config.groupIds.includes(groupId)) throw new Error('wechat_group_not_authorized')
    const chat = await this.request(`/api/chats/${encodeURIComponent(groupId)}`) as { id?: string; isGroup?: boolean }
    if (chat?.id !== groupId || chat.isGroup !== true) throw new Error('wechat_group_not_available')
  }
  async messages(groupId: string): Promise<WechatMessage[]> {
    if (!this.config.groupIds.includes(groupId)) throw new Error('wechat_group_not_authorized')
    const list = await this.request(`/api/messages/${encodeURIComponent(groupId)}?limit=100`)
    if (!Array.isArray(list)) throw new Error('wechat_messages_invalid')
    return list as WechatMessage[]
  }
  /** Read-only public group source check. This does not authorize identity creation, formal turns or sends. */
  async readVerifiedSource(facts: BridgeInboundPlatformFacts, text?: string): Promise<WechatMessage> {
    if (facts.transport !== 'wechat' || facts.messageType !== 'group' || facts.selfId !== this.config.botId ||
      !facts.groupId || !facts.messageId) throw new Error('wechat_platform_facts_rejected')
    await this.assertGroup(facts.groupId)
    const source = (await this.messages(facts.groupId)).find(m =>
      validWechatMessage(m, facts.groupId!, this.config.botId) && m.sender === facts.senderUserId &&
      wechatMessageKey(m) === facts.messageId && (text === undefined || text === m.content))
    if (!source) throw new Error('wechat_source_message_not_verified')
    return source
  }
  /** Formal admission and delivery always check the live account after re-reading the exact source. */
  async verifyFacts(facts: BridgeInboundPlatformFacts, text?: string): Promise<WechatMessage> {
    const source = await this.readVerifiedSource(facts, text)
    await this.assertAccount()
    return source
  }
  async sendReply(facts: BridgeInboundPlatformFacts, text: string): Promise<void> {
    if (!text.trim() || text.length > 6000) throw new Error('wechat_reply_invalid')
    await this.verifyFacts(facts)
    // One attempt only: a timeout may already have sent the message; never retry an uncertain send.
    const result = await this.request('/api/messages/send', { chatId: facts.groupId, text }) as { success?: boolean }
    if (result.success !== true) throw new Error('wechat_delivery_not_confirmed')
  }
}

export interface WechatTurnRequest {
  requestId: string; userText: string; platformFacts: BridgeInboundPlatformFacts
  groupContext?: readonly GroupContextLine[]
}
/** Group-only thin shell. No DB/model access; all replies must come from the existing LG gateway. */
export class WechatGroupClient {
  private readonly api: WechatApi
  private readonly buffer = new GroupContextBuffer()
  private readonly seen = new Set<string>()
  private readonly warmed = new Set<string>()
  private readonly lastAccepted = new Map<string, number>()
  private stopped = false
  constructor(private readonly config: WechatConfig,
    private readonly submit: (request: WechatTurnRequest) => Promise<BridgeWireResponse>,
    private readonly log: (reading: { event: string; code?: string; requestId?: string }) => void,
    private readonly assess?: (request: WechatTurnRequest) => Promise<BridgeWireResponse>) {
    this.api = new WechatApi(config)
    if (existsSync(config.stateFile)) {
      const state: unknown = JSON.parse(readFileSync(config.stateFile, 'utf8'))
      if (!Array.isArray(state) || state.some(k => typeof k !== 'string' || !/^[a-f0-9]{64}$/.test(k))) throw new Error('wechat_state_invalid')
      for (const key of state.slice(-2048)) this.seen.add(key as string)
    }
  }
  stop(): void { this.stopped = true }
  private remember(key: string): void {
    this.seen.add(key)
    while (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!)
    mkdirSync(dirname(this.config.stateFile), { recursive: true })
    writeFileSync(this.config.stateFile + '.tmp', JSON.stringify([...this.seen]), { mode: 0o600 })
    renameSync(this.config.stateFile + '.tmp', this.config.stateFile)
  }
  async poll(): Promise<void> {
    // Idle polling only reads message data. Core assessment, formal turns and sends each verify the live account.
    for (const groupId of this.config.groupIds) {
      if (this.stopped) return
      await this.api.assertGroup(groupId)
      const messages = (await this.api.messages(groupId)).sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.localId - b.localId)
      // On startup/restart take a baseline; do not answer old history or replay uncertain deliveries.
      if (!this.warmed.has(groupId)) {
        await this.api.assertAccount()
        for (const m of messages) if (Number.isSafeInteger(m.localId) && typeof m.content === 'string') this.remember(wechatMessageKey(m))
        this.warmed.add(groupId); this.log({ event: 'wechat_group_ready' }); continue
      }
      // Coalesce a burst into one attention decision per group; earlier lines remain bounded context only.
      const latest = messages.filter(m => validWechatMessage(m, groupId, this.config.botId) && !this.seen.has(wechatMessageKey(m))).at(-1)
      for (const m of messages) {
        if (this.stopped || !validWechatMessage(m, groupId, this.config.botId)) continue
        const key = wechatMessageKey(m)
        if (this.seen.has(key)) continue
        this.remember(key)
        const groupContext = this.buffer.read(groupId)
        this.buffer.add(groupId, { senderId: m.sender!, text: m.content, at: Date.parse(m.timestamp) })
        if (m !== latest) continue
        const rateKey = `${groupId}:${m.sender}`
        if (m.sender !== this.config.ownerId && Date.now() - (this.lastAccepted.get(rateKey) ?? 0) < 3000) continue
        const facts: BridgeInboundPlatformFacts = { transport: 'wechat', selfId: this.config.botId,
          senderUserId: m.sender!, messageType: 'group', groupId, messageId: key }
        const requestId = `wechat:${this.config.botId}:${groupId}:${key}`
        try {
          const request = { requestId, userText: m.content, platformFacts: facts, groupContext }
          const decision = await this.assess?.(request)
          if (this.stopped) return
          this.log({ event: 'wechat_reply_decision', requestId, code: decision?.code ?? 'group_reply_capability_absent' })
          if (decision?.outcome !== 'accepted' || decision.groupReply?.reply !== true) continue
          this.lastAccepted.set(rateKey, Date.now())
          if (this.lastAccepted.size > 1024) this.lastAccepted.delete(this.lastAccepted.keys().next().value!)
          const response = await this.submit(request)
          if (this.stopped) return
          if (response.outcome === 'replied' && response.replyText?.trim()) {
            await this.api.sendReply(facts, response.replyText)
            this.buffer.add(groupId, { senderId: this.config.botId, text: response.replyText, at: Date.now() })
            this.log({ event: 'wechat_reply_api_accepted', requestId })
          } else this.log({ event: 'wechat_turn_not_replied', code: response.code, requestId })
        } catch { this.log({ event: 'wechat_turn_or_delivery_failed', requestId }) }
      }
    }
  }
}
