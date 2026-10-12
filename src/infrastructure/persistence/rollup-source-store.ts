/**
 * M6 / ADR-050 —— 会话摘要来源的**只读读取面**（`RollupSourceReader` 的唯一实现）。
 *
 * ============================================================================
 *  它只做三件事
 * ============================================================================
 * ```text
 *   ① 取窗口     recentConversationEvents({ conversationId, beforeSequence-1, limit = scanCeiling })
 *                —— 有界、升序、"早于 Recent 窗口"的那一段
 *   ② 取读数     经 `qualification-read.ts` 的消费点取得（唯一适配边界 `processorEventViewOf()`）
 *                —— **唯一适配边界**（用户裁定 R-59）；本文件**不**解析任何物理列
 *   ③ 查状态     memory_evidence_links(is_root) × memory_records.status
 *                —— 事件 → 以它为**根证据**的记忆各自的当前状态（失效闸的唯一输入）
 * ```
 *
 * ============================================================================
 *  四条纪律
 * ============================================================================
 * 1. **不写**：本文件只有 SELECT（唯一的写语句类型连出现都不该出现）。
 * 2. **有界**：`scanCeiling` 直接进 `limit`；`beforeSequence` 是**排他**下界
 *    （存储层用的是闭区间 `<=`，因此这里减 1 —— 一处减法胜过两处语义）。
 * 3. **不猜**：读不到事件 / 读数抛错 / 状态读不到 ⇒ **照实**返回
 *    （读数缺席、状态数组为空），由选择器失败关闭。本文件**没有**
 *    "回落到 actor_type"或"把 MIGRATED_LEGACY 洗成 RECORDED"这种路径。
 * 4. **未知状态按失效处理**：`memory_records.status` 出现词表外的值时，
 *    它不等于 `'active'` ⇒ 该来源被判失效（fail-closed）。宁可少摘一条，
 *    也不把一条状态不明的记忆当作有效来源带进 prompt。
 */

import { sql } from 'drizzle-orm'

import { asConversationEventId, asConversationId } from '../../kernel/contracts/ids.ts'
import type { MemoryStatus } from '../../kernel/contracts/memory.ts'
import type { RollupSourceFacts } from '../../kernel/contracts/rollup.ts'
import type { RollupSourceReader } from '../../kernel/recall/ports.ts'
import { recentConversationEvents } from './conversation-store.ts'
import { exec, rowsOf, type RawDb } from './db.ts'
import { originReadingOfEvent } from './qualification-read.ts'

/** 根证据的种类名（与 `memory-store` 写入时用的字面量同一个） */
export const ROLLUP_EVIDENCE_KIND = 'conversation_event'

/**
 * `事件 id → 把它当**根证据**的记忆各自的状态`（只读）。
 *
 * `is_root = true` 是刻意的：ADR-050 `DR-5`/§3.4 的失效规则问的是
 * "**这条事件**派生出了哪些记忆、它们现在还在不在" —— 非根证据（派生链下游）
 * 不代表这条早期发言本身的状态。
 */
async function rootMemoryStatusesFor(
  db: RawDb,
  eventIds: readonly string[]
): Promise<Map<string, MemoryStatus[]>> {
  const out = new Map<string, MemoryStatus[]>()
  if (eventIds.length === 0) return out
  const rows = rowsOf(
    await exec(
      db,
      sql`select l.evidence_id, r.status
            from memory_evidence_links l
            join memory_records r on r.id = l.memory_id
           where l.evidence_kind = ${ROLLUP_EVIDENCE_KIND}
             and l.is_root = true
             and l.evidence_id in (${sql.join(
               eventIds.map((id) => sql`${id}`),
               sql`, `
             )})`,
      '读取会话摘要来源所挂记忆的当前状态'
    )
  )
  for (const row of rows) {
    const id = String(row.evidence_id)
    const status = String(row.status) as MemoryStatus
    const list = out.get(id)
    if (list === undefined) out.set(id, [status])
    else list.push(status)
  }
  return out
}

/** `sequence` 列的物理类型是 `integer`（int4）。上界超过它时不能照原样送进 SQL ——  */
const INT4_MAX = 2_147_483_647

/**
 * 构造读取面。
 *
 * ⚠️ 没有配置项：**有界**在上游（`scanCeiling` 由调用方给）、**开关**在额度
 * （`ContextBudget.rollupTokens`）。本层多一个开关就多一处"看起来配了其实没接"的位置。
 */
export function createRollupSourceReader(db: RawDb): RollupSourceReader {
  return {
    name: 'conversation-events',
    async read(input) {
      const ceiling = Math.max(0, Math.floor(input.scanCeiling))
      if (ceiling === 0) return []

      /*
       * 上界的两种写实：
       *   · 正常值 ⇒ 转成存储层的**闭区间**（`<= before - 1`）
       *   · 越界/非有限（例如调用方用 `Number.MAX_SAFE_INTEGER` 表达"没有上界"）
       *     ⇒ **不传**这个参数。第一版照原样送进 SQL，得到的是一个
       *     `Failed query` 的不透明错误（int4 越界）；"没有上界"是一个合法意图，
       *     应该有合法的表达，而不是让调用方去猜列类型。
       */
      const requested = Math.floor(input.beforeSequence)
      const inclusiveUpper =
        Number.isFinite(requested) && requested - 1 < INT4_MAX
          ? Math.max(0, requested - 1)
          : undefined

      const events = await recentConversationEvents(db, {
        characterId: input.characterId,
        conversationId: asConversationId(input.conversationId),
        limit: ceiling,
        ...(inclusiveUpper !== undefined ? { beforeSequence: inclusiveUpper } : {}),
      })

      const statuses = await rootMemoryStatusesFor(
        db,
        events.map((event) => String(event.id))
      )

      return events.map((event): RollupSourceFacts => {
        /*
         * 受信读数**经** `qualification-read.ts` 的消费点取得（唯一适配边界的
         * 那一个消费面）。本文件**不**自己读原始归因列，也**不**自己写一遍
         * "取不到怎么办" —— 那是用户裁定 R-59 要求只有一处的东西。
         */
        const originReading = originReadingOfEvent(event)
        return {
          eventId: asConversationEventId(String(event.id)),
          conversationId: String(event.conversationId),
          sequence: event.sequence,
          type: event.type,
          content: event.content,
          ...(originReading !== undefined ? { originReading } : {}),
          rootMemoryStatuses: statuses.get(String(event.id)) ?? [],
        }
      })
    },
  }
}
