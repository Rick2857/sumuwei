/**
 * `--history` 的账本视图（TD-07 / M7 WP6 预检的**最小替换**落地）。
 *
 * 旧视图（ElizaOS `messages` 遗留镜像）的三个缺陷——缺一半（用户的话
 * 从不进镜像）/ 标错人（非本用户 entity 一律显示成她的名字）/ 作用域错
 * （按 roomId 过滤，看不见角色级账本的其它会话）——在这里被**换数据源**
 * 消除：本函数只读 `conversation_events`（Kernel 账本，与 `memory:list` /
 * `--kernel-status` 同一个权威源）。
 *
 * 边界（`scripts/m7-wp6-td07.ts` 有静态检查守着）：
 *  · 输出是**人类调试视图**，不是认知证据，不进任何认知链；
 *  · 干跑（--test）不写账本 ⇒ 测试轮的话不会出现（设计，不是丢历史）。
 */
import type { RawDb } from '../persistence/db.ts'
import { recentConversationEvents } from '../persistence/conversation-store.ts'
import type { CharacterId } from '../../kernel/contracts/ids.ts'

export interface LedgerHistoryInput {
  db: RawDb
  characterId: CharacterId | string
  /** 本会话用户的 id（账本 actorId 与它相等 ⇒ 显示用户名） */
  userId: string
  userName: string
  characterName: string
  limit?: number
}

/** 账本事件 → 显示名：user 如实分列（非本用户不冒名），system 单列 */
function whoOf(
  event: { actorType: string; actorId?: string },
  input: { userId: string; userName: string; characterName: string }
): string {
  if (event.actorType === 'user') {
    return event.actorId === input.userId ? input.userName : `用户 ${String(event.actorId)}`
  }
  if (event.actorType === 'character') return input.characterName
  return '系统'
}

export async function renderLedgerHistory(input: LedgerHistoryInput): Promise<string> {
  const limit = input.limit ?? 20
  const events = await recentConversationEvents(input.db, {
    characterId: input.characterId as never,
    limit,
  })

  if (events.length === 0) return '（她还没有任何对话记忆）'

  const lines = [
    `${input.characterName} 记得的最近 ${String(events.length)} 条消息（Kernel 账本）：`,
    '',
  ]
  for (const event of events) {
    const who = whoOf(event, input)
    const when = event.createdAt
      ? new Date(event.createdAt).toLocaleString('zh-CN', { hour12: false })
      : '(时间未知)'
    const text =
      typeof event.content === 'string' ? event.content : JSON.stringify(event.content)
    lines.push(`  [${when}] ${who}: ${text.replace(/\n/g, ' / ')}`)
  }
  return lines.join('\n')
}
