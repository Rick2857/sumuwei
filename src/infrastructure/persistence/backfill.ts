/**
 * 回填：把 `memories` 里的既有对话补进 M2.5 的事实账本。
 *
 * ============================================================================
 *  为什么需要这一步
 * ============================================================================
 * M2.5 之后主链路默认走 ContextCompiler，而它的"最近对话"来自
 * **事实账本 `conversation_events`**（不是 ElizaOS 的 `memories`）。
 *
 * 于是升级瞬间会出现一个**历史断层**：
 *
 *     memories            : 有 M1/M2 时期攒下的 N 条真实对话
 *     conversation_events : 0 条（那 N 条发生在新链路之前）
 *
 * 后果不是报错，而是**她在新路径里看不到你们的过去**——
 * 表现为"刚聊过的事她完全不记得"，而 `--history` 里明明还在。
 * 升级到新链路的用户会以为记忆丢了。
 *
 * 因此本文件把那段历史按**真实说话人**补进账本：
 *   · 用户消息 → actorType = 'user'
 *   · 她的回复 → actorType = 'character'
 *   （来源隔离在回填时也必须正确，否则铁律 6 从历史里就破了）
 *
 * ---------------------------------------------------------------------------
 *  三条设计约束
 * ---------------------------------------------------------------------------
 * 1. **可重跑**：靠 `conversationSequence` 的幂等探测，重复执行不会产生副本。
 * 2. **可追溯**：每条回填事件都带 `metadata.backfilledFrom`（原 memories 行 id），
 *    所以以后能回答"这条账本记录是哪来的"。
 * 3. **不改旧表**：`memories` 保持原样。回填是**新增**认识，不是搬走数据。
 *
 * 逻辑放在这里（而不是只写在脚本里）是为了让**主程序**也能用：
 *   · 脚本 `scripts/backfill-conversation-events.ts` 在沙箱里预览/演练
 *   · 主程序 `--backfill-events` 在真实库上执行（它持有生产库写权限）
 */

import { sql } from 'drizzle-orm'

import type { CharacterId, ConversationId } from '../../kernel/contracts/index.ts'
import { exec, type RawDb } from './db.ts'
import {
  appendConversationEvent,
  countConversationEvents,
  latestConversationSequence,
} from './conversation-store.ts'

export interface LegacyMessageRow {
  id: string
  entity_id: string
  content: unknown
  created_at: unknown
}

export interface PlannedBackfill {
  actorType: 'user' | 'character'
  actorId: string
  content: string
  createdAt: number
  sourceMemoryId: string
}

export interface BackfillPlan {
  total: number
  skippedEmpty: number
  userCount: number
  characterCount: number
  items: PlannedBackfill[]
  existingEvents: number
}

export interface BackfillOptions {
  characterId: CharacterId
  conversationId: ConversationId
  roomId: string
  userEntityId: string
  agentEntityId: string
  userName: string
  /** 角色名的显示值（只用于 actorId，不参与判定） */
  actorIdForCharacter?: string
}

/** 读取该房间的历史消息（按时间正序），并规划出待回填的事件 */
export async function planBackfill(
  db: RawDb,
  options: BackfillOptions,
): Promise<BackfillPlan> {
  const rows = await exec(
    db,
    sql`select id, entity_id, content, created_at
        from memories
        where type = 'messages' and room_id = ${options.roomId}
        order by created_at asc`,
    '读取待回填的历史消息',
  )

  const items: PlannedBackfill[] = []
  let skippedEmpty = 0

  for (const row of rows) {
    const entityId = String(row.entity_id)
    const content = row.content
    const text =
      typeof content === 'object' && content !== null
        ? String((content as { text?: unknown }).text ?? '')
        : ''
    if (text.trim() === '') {
      skippedEmpty += 1
      continue
    }

    const actorType: 'user' | 'character' =
      entityId === options.userEntityId
        ? 'user'
        : entityId === options.agentEntityId
          ? 'character'
          : 'user' // 未知发言者按用户处理（保守：宁可当成"外部输入"）

    const createdAtMs = new Date(String(row.created_at)).getTime()

    items.push({
      actorType,
      actorId: actorType === 'user' ? options.userName : (options.actorIdForCharacter ?? String(options.characterId)),
      content: text,
      createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
      sourceMemoryId: String(row.id),
    })
  }

  const userCount = items.filter((i) => i.actorType === 'user').length

  return {
    total: items.length,
    skippedEmpty,
    userCount,
    characterCount: items.length - userCount,
    items,
    existingEvents: await countConversationEvents(db, options.characterId),
  }
}

export interface BackfillResult {
  written: number
  deduplicated: number
  before: number
  after: number
  /** 因为"来源记忆已经回填过"而跳过的条数（幂等的真正依据） */
  skippedAlreadyBackfilled: number
}

/**
 * 执行回填。
 *
 * ============================================================================
 *  幂等靠什么？靠**来源记忆 id**，不是 conversationSequence
 * ============================================================================
 * 第一版用 `conversationSequence` 做幂等键（`appendConversationEvent` 内部
 * 按 `(character, conversation, conversationSequence)` 判重）——
 * 结果**第二次运行又写了 4 条副本**，因为对话内序号是从当前最大值+1 开始的：
 *
 *     第一次 → seq 1..4，第二次从 5 开始 → 看起来"全是新消息"
 *
 * 这是设计错误，不是实现 bug：序号是"第几句"这种位置信息，
 * 它天然会被"已经写进去的历史"推着往前走。
 * 真正稳定的判重依据是**这条事件是从哪条旧消息来的**——
 * 也就是 `metadata.backfilledFrom`。
 *
 * 因此：先查出已经回填过的来源 id 集合，再跳过它们。
 * 这样无论重跑多少次、中间有没有新增对话，结果都一样。
 */
export async function applyBackfill(
  db: RawDb,
  options: BackfillOptions,
  plan: BackfillPlan,
): Promise<BackfillResult> {
  const before = plan.existingEvents

  // 已经回填过的来源记忆 id（幂等的真实依据）
  const already = new Set(
    (
      await exec(
        db,
        sql`select metadata->>'backfilledFrom' as src
            from conversation_events
            where character_id = ${options.characterId}
              and metadata->>'backfill' = 'm2.5-memories-to-events'
              and metadata->>'backfilledFrom' is not null`,
        '读取已回填的来源标记',
      )
    ).map((row) => String(row.src)),
  )

  let nextConversationSequence =
    (await latestConversationSequence(db, options.characterId, options.conversationId)) + 1

  let written = 0
  let deduplicated = 0
  let skippedAlreadyBackfilled = 0

  for (const item of plan.items) {
    if (already.has(item.sourceMemoryId)) {
      skippedAlreadyBackfilled += 1
      continue
    }

    const result = await appendConversationEvent(
      db,
      {
        characterId: options.characterId,
        conversationId: options.conversationId,
        conversationSequence: nextConversationSequence,
        type: item.actorType === 'user' ? 'user_message' : 'assistant_message',
        actorType: item.actorType,
        actorId: item.actorId,
        content: item.content,
        metadata: {
          source: 'cli',
          userId: options.userName,
          // 可追溯：这条账本记录是从哪条旧消息来的（同时也是幂等依据）
          backfilledFrom: item.sourceMemoryId,
          backfill: 'm2.5-memories-to-events',
        },
        createdAt: item.createdAt,
      },
      // ⚠️ 这是**唯一**该显式允许序号空隙的地方：回填写的是早年的旧消息，
      // 它们的会话内序号与今天的账本本来就不连续。默认 false 的含义是
      // "调用方必须承认自己在制造空洞"，于是 grep 这一个开关
      // 就能列出全部会留下空洞的路径。
      { allowSequenceGap: true }
    )
    nextConversationSequence += 1
    if (result.appended) written += 1
    else deduplicated += 1
  }

  return {
    written,
    deduplicated,
    before,
    after: await countConversationEvents(db, options.characterId),
    skippedAlreadyBackfilled,
  }
}
