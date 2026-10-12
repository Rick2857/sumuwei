/**
 * M11 WP3 —— `ReflectionInputSource` 的**只读适配**（ADR-085 §7.1 · `D15` · `D30`）。
 *
 * ============================================================================
 *  这一层为什么单独一个文件
 * ============================================================================
 * 输入装配的**逻辑**（触发检测、有界窗口、标签、门槛）全在
 * [`kernel/app/reflection/inputs.ts`](../../kernel/app/reflection/inputs.ts) —— 那里是纯的。
 * SQL **只**出现在这里，且**只读**：没有 insert / update / delete / 事务。
 *
 * ============================================================================
 *  两条实现纪律
 * ============================================================================
 * ① **有界读取真的下推到 SQL**（`limit` 进查询，不是查全量再切片）——
 *    否则 `D30` 的"每 job 最多 50 条"就只是内存里的一个 `slice()`。
 * ② **不读正文**：只要 `id / type / sequence / payload(reason) / source_conversation_event_ids`，
 *    对话侧只要 `actor_type / sequence`。反思输入不需要聊天原话（`D-8` 的隐私边界同源）。
 */

import { sql } from 'drizzle-orm'

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type {
  ReflectionConversationReading,
  ReflectionInputSource,
  ReflectionTriggerEventReading,
} from '../../kernel/contracts/reflection-input.ts'
import { REFLECTION_WINDOW_TEXT_MAX_CODEPOINTS } from '../../kernel/contracts/reflection-input.ts'
import type { ReflectionWindowEvent } from '../../kernel/app/reflection/job.ts'
import { exec, type RawDb } from './db.ts'

function literalList(ids: readonly string[]): string {
  return ids.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(', ')
}

/** 从 payload 里**只**取 `reason`（撤回事件的细分原因）—— 不读别的正文。 */
function reasonOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const reason = (payload as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : undefined
}

function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) if (typeof item === 'string' && item !== '') out.push(item)
  return out
}

/** 构造只读口（`characterId` 是**作用域**，不是可选参数）。 */
export function createReflectionInputSource(
  db: RawDb,
  options: { readonly characterId: CharacterId; readonly throughSequence?: number; readonly eligibleDomainEventIds?: readonly string[] }
): ReflectionInputSource {
  const characterId = String(options.characterId)

  return {
    async domainEventsSince(afterSequence, limit): Promise<ReflectionTriggerEventReading[]> {
      if (limit <= 0) return []
      if (options.eligibleDomainEventIds?.length === 0) return []
      const rows = await exec(
        db,
        sql`select id, type, sequence, payload, source_conversation_event_ids
              from character_domain_events
             where character_id = ${characterId}
               and sequence > ${afterSequence}
               ${options.throughSequence === undefined ? sql`` : sql`and sequence <= ${options.throughSequence}`}
               ${options.eligibleDomainEventIds === undefined ? sql`` : sql`and id in (${sql.join(options.eligibleDomainEventIds.map(id => sql`${id}`), sql`, `)})`}
             order by sequence asc
             limit ${limit}`,
        'M11 反思输入：读水位之后的领域事件（只读）'
      )
      return rows.map((row) => ({
        id: String(row.id),
        type: String(row.type),
        sequence: Number(row.sequence),
        ...(reasonOf(row.payload) === undefined ? {} : { reason: reasonOf(row.payload) }),
        sourceConversationEventIds: stringArrayOf(row.source_conversation_event_ids),
      }))
    },

    async conversationActors(ids): Promise<ReflectionConversationReading[]> {
      if (ids.length === 0) return []
      const rows = await exec(
        db,
        sql.raw(
          `select id, actor_type, conversation_id, sequence, content
             from conversation_events
            where id in (${literalList(ids)})`
        ),
        'M11 反思输入：读对话事件的最小信息 + 有界正文（只读）'
      )
      return rows.map((row) => ({
        id: String(row.id),
        actorType: String(row.actor_type),
        ...(typeof row.conversation_id === 'string' ? { conversationId: row.conversation_id } : {}),
        sequence: Number(row.sequence),
        /*
         * ⚠️ **有界**：超长正文在**这里**截断（`L-M11-14` 的修复面之一）。
         *    遮蔽**不**在这里做 —— 它由装配层按资格读数决定（本层不知道谁被忘掉）。
         */
        text: [...String(row.content ?? '')].slice(0, REFLECTION_WINDOW_TEXT_MAX_CODEPOINTS).join(''),
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// 调度层的**两个只读端口**（WP12 接线用；都在这里，因为它们都是本域的取数边界）
// ---------------------------------------------------------------------------

/**
 * 当前**领域事件**的最大序号（没有事件 ⇒ 0）。
 *
 * ⚠️ 它是 `cutoverSequence` 的来源（`D33`：首次建立 cutover = 此刻的账本边界），
 *    与"按 conversation sequence 算"是**两个不同的量**（`S34` 的考点）。
 */
export async function latestDomainEventSequence(
  db: RawDb,
  characterId: CharacterId
): Promise<number> {
  const rows = await exec(
    db,
    sql`select coalesce(max(sequence), 0) as latest
          from character_domain_events
         where character_id = ${String(characterId)}`,
    'M11 调度：读领域事件最大序号（只读）'
  )
  const value = rows[0] === undefined ? 0 : Number((rows[0] as { latest?: unknown }).latest ?? 0)
  return Number.isFinite(value) ? value : 0
}

/**
 * 读一段**窗口事件**（供调度层规划：谁合格、谁跳过、水位推进到哪）。
 *
 * ⚠️ `actorType` 取自**被引用的对话事件**：领域事件本身没有 actor 概念，
 *    而"跳过 tool/assistant"这条规则（`S35`）针对的是**对话侧**的来源。
 *    没有引用任何对话事件的领域事件按 `program` 处理（它们是程序事实，属于合格触发）。
 */
export async function readReflectionWindowEvents(
  db: RawDb,
  characterId: CharacterId,
  fromSequence: number,
  latestSequence: number,
  limit: number
): Promise<readonly ReflectionWindowEvent[]> {
  if (limit <= 0 || latestSequence <= fromSequence) return []
  const rows = await exec(
    db,
    sql`select id, type, sequence, source_conversation_event_ids
          from character_domain_events
         where character_id = ${String(characterId)}
           and sequence > ${fromSequence}
           and sequence <= ${latestSequence}
         order by sequence asc
         limit ${limit}`,
    'M11 调度：读窗口事件（只读）'
  )
  const referenced = new Set<string>()
  for (const row of rows) {
    for (const id of stringArrayOf((row as { source_conversation_event_ids?: unknown }).source_conversation_event_ids)) {
      referenced.add(id)
    }
  }
  const actors = new Map<string, string>()
  if (referenced.size > 0) {
    const actorRows = await exec(
      db,
      sql.raw(
        `select id, actor_type from conversation_events where id in (${literalList([...referenced])})`
      ),
      'M11 调度：读窗口事件的对话侧 actor（只读）'
    )
    for (const row of actorRows) {
      actors.set(String((row as { id: unknown }).id), String((row as { actor_type: unknown }).actor_type))
    }
  }
  return rows.map((row) => {
    const ids = stringArrayOf((row as { source_conversation_event_ids?: unknown }).source_conversation_event_ids)
    const actorType = ids.map((id) => actors.get(id)).find((value) => value !== undefined) ?? 'program'
    return {
      id: String((row as { id: unknown }).id),
      type: String((row as { type: unknown }).type),
      sequence: Number((row as { sequence: unknown }).sequence),
      actorType,
      ...(reasonOf((row as { payload?: unknown }).payload) === 'explicit_forget'
        ? { requiresInvalidation: true }
        : {}),
    }
  })
}
