export interface GroupContextLine {
  senderId: string
  text: string
  at: number
  /**
   * 平台侧显示名（QQ：群名片优先，退回昵称；可选）。
   *
   * ⚠️ 它是**展示用事实**，不是身份依据：身份仍只有 `senderId`，
   *    这个字段只决定"最近对话"里的说话人标签（缺省由调用方退回 `QQ用户<id>`）。
   */
  name?: string
  messageId?: string
  mentionedUserIds?: readonly string[]
  replyToMessageId?: string
  replyToSenderId?: string
  replyText?: string
  sourceAt?: number
  isCurrent?: boolean
  sourceMessageIds?: readonly string[]
}

/**
 * 显示名上限（码点）—— 与桥的 `platformDisplayNameProblem`（`turn-bridge.ts`）**同一上界**。
 *
 * ⚠️ 两侧必须一致：外壳这边多留一个字符，桥就会把整条平台事实判死
 *    （`bridge_bad_platform_facts_sender_name`）⇒ 一条超长群名片能让这一轮入站**失败**。
 */
const PLATFORM_DISPLAY_NAME_MAX_CODEPOINTS = 64

/**
 * 把平台显示名收敛成"能进 prompt 的一行标签"（纯函数）。
 *
 * ```text
 * 非字符串                       ⇒ undefined（畸形载荷不猜）
 * [\u0000-\u001f\u007f]          ⇒ 压成空格（换行/制表会打断"最近对话"的逐行结构）
 * 连续空白                       ⇒ 压成一个空格
 * 收敛后为空                     ⇒ undefined（调用方退回 `QQ用户<id>`）
 * 过长                           ⇒ 截断到 64 个码点
 * ```
 *
 * ⚠️ 为什么在这里收敛、而不是把原始昵称原样丢给桥：桥对超界/含控制字符的显示名
 *    会**整条拒绝平台事实**（`bridge_bad_platform_facts_sender_name`）⇒ 一个 200 字的
 *    群名片或带换行的昵称就会让这一轮入站失败。收敛只发生在**展示用的事实**上，
 *    不参与任何授权判定（`senderId` 那条链一个字未动）。
 */
export function platformDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const collapsed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (collapsed === '') return undefined
  const truncated = [...collapsed].slice(0, PLATFORM_DISPLAY_NAME_MAX_CODEPOINTS).join('').trim()
  return truncated === '' ? undefined : truncated
}

/** Conservative direct-address detection; ambiguous/quoted/third-person mentions stay quiet. */
export function addressedByName(text: string): boolean {
  if (/[“”「」『』"]/.test(text) || /(?:他说|她说|转发|引用|听说|据说)/.test(text)) return false
  return /^(?:喂[，,\s]*)?(?:苏沐薇|沐薇|小薇)[，,:：\s]+\S/.test(text.trim())
    || /^(?:苏沐薇|沐薇|小薇)(?:在吗|你好|你(?:能|会|觉得|认为|可以|有没有|要不要|知道)|帮我|请)/.test(text.trim())
}

export class GroupContextBuffer {
  private readonly rooms = new Map<string, GroupContextLine[]>()
  add(groupId: string, line: GroupContextLine): void {
    const lines = this.read(groupId, line.at)
    /*
     * ⚠️ 只截 `text`：显示名是**已经收敛好的**短标签（≤64 码点），
     *    和正文走同一刀会把名字切坏，而名字整条丢掉的后果是模型又只看到一串 QQ 号。
     */
    lines.push({ ...line, text: line.text.slice(0, 1000) })
    while (lines.length > 20 || lines.reduce((sum, item) => sum + item.text.length, 0) > 6000) lines.shift()
    this.rooms.delete(groupId)
    this.rooms.set(groupId, lines)
    while (this.rooms.size > 32) this.rooms.delete(this.rooms.keys().next().value!)
  }
  read(groupId: string, now = Date.now()): GroupContextLine[] {
    const lines = (this.rooms.get(groupId) ?? []).filter(line => line.at >= now - 300_000 && line.at <= now)
    if (lines.length === 0) this.rooms.delete(groupId)
    /* 原样带出（含 `name`）：这里**不**做二次清洗 —— 收敛只发生在入口那一处 */
    return lines.map(line => ({ ...line }))
  }
  clear(groupId: string): void { this.rooms.delete(groupId) }
}

/** Display data only. Current identity and permissions still come from the turn scope. */
export function groupMessageLabel(line: GroupContextLine, botId?: string): string {
  return `${line.name ?? (line.senderId === botId ? '机器人' : '群成员')}（QQ ${line.senderId}）`
}

export function groupMessageText(line: GroupContextLine, now = Date.now()): string {
  const { text, name, isCurrent, ...facts } = line
  const quoteStatus = line.replyToMessageId !== undefined && line.replyText === undefined ? '引用原文不在短期窗口内，不能猜测' : undefined
  return `${JSON.stringify({ ...facts, quoteStatus })}\n${text}\n（已等待 ${Math.max(0, Math.round((now - (line.sourceAt ?? line.at)) / 1000))} 秒）`
}
