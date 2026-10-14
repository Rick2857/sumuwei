/** A single QQ owner maps to the existing USER_NAME domain identity. */
export interface QqPrivateConfig {
  ownerId: string
  botId: string
  wsUrl: string
  token: string
  multiUserEnabled?: boolean
  allowedGroupIds?: readonly string[]
}

export function qqId(value: unknown): string | undefined {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return undefined
  const id = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return /^[1-9]\d{4,19}$/.test(id) ? id : undefined
}

export function readQqPrivateConfig(env: NodeJS.ProcessEnv): QqPrivateConfig {
  const ownerId = qqId(env.QQ_OWNER_ID)
  const botId = qqId(env.QQ_BOT_ID)
  if (!ownerId || !botId || ownerId === botId) throw new Error('QQ requires distinct QQ_OWNER_ID and QQ_BOT_ID')
  const url = new URL(env.QQ_ONEBOT_WS_URL ?? 'ws://127.0.0.1:6701/')
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
    throw new Error('QQ OneBot must use ws://127.0.0.1 with no credentials in the configured URL')
  }
  const token = env.QQ_ONEBOT_ACCESS_TOKEN ?? ''
  if (!/^[a-zA-Z0-9_-]{24,}$/.test(token)) throw new Error('QQ_ONEBOT_ACCESS_TOKEN requires at least 24 safe characters')
  const multiUserEnabled = env.QQ_MULTI_USER_ENABLED === 'true'
  const allowedGroupIds = (env.QQ_ALLOWED_GROUP_IDS ?? '').split(/[,\s/]+/).filter(Boolean)
  if (allowedGroupIds.some(id => qqId(id) === undefined) || (multiUserEnabled && allowedGroupIds.length === 0)) {
    throw new Error('QQ multi-user mode requires valid QQ_ALLOWED_GROUP_IDS')
  }
  return { ownerId, botId, wsUrl: url.href, token,
    ...(multiUserEnabled ? { multiUserEnabled, allowedGroupIds: [...new Set(allowedGroupIds)] } : {}) }
}
