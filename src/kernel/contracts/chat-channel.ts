/** Channel identity is supplied by the authenticated entry, never by message payloads. */
export type ChatChannel = 'cli' | 'qq_private' | 'avatar'
export const CHAT_CHANNELS: readonly ChatChannel[] = ['cli', 'qq_private', 'avatar']
export const CHAT_CHANNEL_LABELS: Readonly<Record<ChatChannel, string>> = {
  cli: '控制台文字', qq_private: 'QQ 私聊', avatar: '皮套',
}
export function isChatChannel(value: unknown): value is ChatChannel {
  return CHAT_CHANNELS.includes(value as ChatChannel)
}
