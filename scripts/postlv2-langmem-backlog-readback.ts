/**
 * LangMem 回退档的**积压读回**（一次性、只读）。
 *
 * ============================================================================
 *  它要回答的只有一个问题
 * ============================================================================
 * [ADR-123](../../docs/adr/ADR-123-post-turn-model-memory-and-semantic-only-recall.md) §20 逐字要求：
 *
 *     回退后旧消费者**可能追赶它未处理的区间**，必须先检查积压；
 *     不得把回退配置描述成完整的数据回滚。
 *
 * 因此本脚本只读三件事：
 *   ① `automatic-memory-langmem@1` 的水位停在哪（ADR-118 建立时为 765）；
 *   ② 当前账本最大序号（= 它会追到哪）；
 *   ③ 两者之间的区间里有多少条**受信的 user_message**（= 真正会被抽取的源），
 *      以及有多少条**已被新档处理过**（`post-turn-model-memory@1` 的水位）。
 *
 * 纪律（照 `scripts/m18-post-migration-readback.ts` 与
 * `scripts/model-stream-length-readback.ts` 同源）：
 *   · 生产库**只被 `cpSync` 读**，从不作为数据库打开；打开的是 `%TEMP%` 里的副本；
 *   · 一切查询**只许 SELECT**（本文件里没有任何 write 语句）；
 *   · 只打印**序号与计数**，**不打印任何对话正文**（与自动记忆日志同一条隐私边界）。
 */
import 'dotenv/config'

import { cpSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { allowProductionDatabase } from '../src/db/index.ts'
import { productionDataDirOf } from '../src/infrastructure/persistence/production-open-guard.ts'
import {
  openRawPGlite,
  ownerRecordPath,
  readOwnerRecord,
  type RawPGlite,
} from '../src/infrastructure/persistence/production-db-safety.ts'

allowProductionDatabase()

const LANGMEM_PROCESSOR = 'automatic-memory-langmem'
const POST_TURN_PROCESSOR = 'post-turn-model-memory'

async function read(dir: string): Promise<Record<string, unknown>> {
  const db: RawPGlite = await openRawPGlite(dir)
  try {
    const one = async (sql: string) => (await db.query(sql)).rows[0] as Record<string, unknown>
    const schema = await one('select max(version)::int as version from character_schema_migrations')
    const ledger = await one(`select coalesce(max(sequence), 0)::int as max_sequence,
        count(*)::int as total_events from conversation_events`)
    const watermarks = (await db.query(
      `select processor, processor_version, processed_through_sequence
         from processor_watermarks order by processor`)).rows as Record<string, unknown>[]
    const jobs = (await db.query(
      `select processor, processor_version, status, count(*)::int as jobs,
              coalesce(min(source_from_sequence), 0)::int as from_sequence,
              coalesce(max(source_to_sequence), 0)::int as to_sequence
         from character_jobs group by 1, 2, 3 order by 1, 3`)).rows as Record<string, unknown>[]
    const records = (await db.query(
      `select status, count(*)::int as records from memory_records group by 1 order by 1`
    )).rows as Record<string, unknown>[]

    const langmem = watermarks.find((row) => row.processor === LANGMEM_PROCESSOR)
    const postTurn = watermarks.find((row) => row.processor === POST_TURN_PROCESSOR)
    const langmemThrough = Number(langmem?.processed_through_sequence ?? -1)
    const postTurnThrough = Number(postTurn?.processed_through_sequence ?? -1)
    const maxSequence = Number(ledger?.max_sequence ?? 0)

    /*
     * 积压区间 = (langmem 水位, 最大序号]。其中：
     *   · `user_messages`      —— 会真的触达 LangMem 的源（它只处理受信 user_message）；
     *   · `already_post_turn`  —— 这一段**已被新档判定过**（`sequence <= postTurn 水位`）：
     *                            换档后两个写入器会看到同一批原话（**必须**如实告知的代价）；
     *   · `never_processed`    —— 落在**新档水位之外**、任何写入器都没碰过的洞
     *                            （ADR-118 cutover 765 → ADR-123 cutover 785 那次两者之间
     *                             曾经有 19 条，但 LangMem 自己在 766…785 已处理完）。
     *
     * ⚠️ 这两个标签曾经被写反（`>` 写成"已处理"）—— 那会把"已被新档判过的 31 条"
     *    报成"31 条从未被处理"。判据方向：**水位是"处理到这里"，所以 `<= 水位` 才是已做**。
     */
    const pending = langmemThrough < 0 ? null : await one(`select
        count(*) filter (where type = 'user_message')::int as user_messages,
        count(*) filter (where type = 'user_message' and sequence <= ${postTurnThrough})::int as already_post_turn,
        count(*) filter (where type = 'user_message' and sequence > ${postTurnThrough})::int as never_processed,
        count(*)::int as all_events
      from conversation_events where sequence > ${langmemThrough} and sequence <= ${maxSequence}`)
    const failed = (await db.query(
      `select processor, status, count(*)::int as jobs,
              coalesce(string_agg(distinct last_error, ','), '(none)') as reasons
         from character_jobs where status = 'failed' group by 1, 2 order by 1`
    )).rows as Record<string, unknown>[]

    return {
      schema: schema?.version, maxSequence, totalEvents: ledger?.total_events,
      langmemThrough, postTurnThrough, pending, watermarks, jobs, records, failed,
    }
  } finally {
    await db.close()
  }
}

const realDataDir = productionDataDirOf()
const owner = readOwnerRecord(ownerRecordPath(realDataDir))
console.log(`生产库（只被 cpSync 读，从未打开）: ${realDataDir}`)
console.log(`owner 记录: cleanClose=${String(owner?.cleanClose)} operationKind=${String(owner?.operationKind)} endedAt=${String(owner?.endedAt)}`)
if (owner?.cleanClose !== true) {
  console.error('拒绝：owner 记录不是 cleanClose=true —— 积压读数会不可信（可能正在跑）。')
  process.exit(2)
}

const copyDir = mkdtempSync(join(tmpdir(), 'langmem-backlog-readback-'))
cpSync(realDataDir, copyDir, { recursive: true })
console.log(`只读副本: ${copyDir}`)

const reading = await read(copyDir)

const watermark = (processor: string) => {
  const row = (reading.watermarks as Record<string, unknown>[]).find((item) => item.processor === processor)
  return row ? `${String(row.processor_version)} @ ${String(row.processed_through_sequence)}` : '（无水流行）'
}

console.log('\n=== 账本与水位 ===')
console.log(`  schema                        : ${String(reading.schema)}`)
console.log(`  账本事件总数 / 最大序号        : ${String(reading.totalEvents)} / ${String(reading.maxSequence)}`)
console.log(`  ${LANGMEM_PROCESSOR}   : ${watermark(LANGMEM_PROCESSOR)}`)
console.log(`  ${POST_TURN_PROCESSOR}     : ${watermark(POST_TURN_PROCESSOR)}`)

const pending = reading.pending as Record<string, unknown> | null
console.log('\n=== 回退后 LangMem 会追的区间 ===')
if (pending === null) {
  console.log('  没有 automatic-memory-langmem 水流行 ⇒ 它会被当成"首次启用"，预置为当前最大序号（ADR-117 D03，不回判）。')
} else {
  console.log(`  区间                        : (${String(reading.langmemThrough)}, ${String(reading.maxSequence)}]`)
  console.log(`  区间内事件总数              : ${String(pending.all_events)}`)
  console.log(`  ├ 受信 user_message（真源） : ${String(pending.user_messages)}`)
  console.log(`  ├ 其中已被新档判定过        : ${String(pending.already_post_turn)}  ← 换档后这批原话会被第二个写入器再判一次`)
  console.log(`  └ 其中从未被任何档处理过    : ${String(pending.never_processed)}`)
}

console.log('\n=== 记忆与任务现状（改动前基线） ===')
for (const row of reading.records as Record<string, unknown>[]) {
  console.log(`  记忆 ${String(row.status)}: ${String(row.records)}`)
}
for (const row of reading.jobs as Record<string, unknown>[]) {
  console.log(`  任务 ${String(row.processor)} / ${String(row.status)}: ${String(row.jobs)} 条 [${String(row.from_sequence)}..${String(row.to_sequence)}]`)
}
for (const row of reading.failed as Record<string, unknown>[]) {
  console.log(`  失败档 ${String(row.processor)}: ${String(row.jobs)} 条 · reasons=${String(row.reasons)}`)
}

console.log('\n（副本库已关闭；生产库从未被打开；本脚本只发 SELECT）')
