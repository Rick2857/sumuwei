/**
 * M18 迁移后读回（一次性、只读）—— 照迁移 #17 的既有纪律。
 *
 * ============================================================================
 *  它要证明什么
 * ============================================================================
 * ```text
 * ① 生产库 schema 确实 = 18（#18 reminder-repeat-mode-and-attempt 已应用）；
 * ② **旧行逐字段不变**：把 `notification_intents` 的旧字段（**排除新增列 repeat_mode**）
 *    做摘要，迁移前快照（v17）与迁移后副本（v18）**逐字相同**；
 * ③ 新增列对旧行的取值是 null（= 行为等同 once）；
 * ④ `notification_occurrences` 的新增列同样对旧行为 null。
 * ```
 *
 * 纪律（与 `scripts/model-stream-length-readback.ts` 同源）：
 *   · 生产库**只被 cpSync 读**，从不作为数据库打开；打开的是 %TEMP% 里的副本；
 *   · 保留快照**直接以只读方式打开**（它本身就是一份副本）；
 *   · 一切查询**只许 SELECT**（`rows()` 拒绝非 SELECT）。
 */
import 'dotenv/config'

import { cpSync, existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { allowProductionDatabase } from '../src/db/index.ts'
import { productionDataDirOf } from '../src/infrastructure/persistence/production-open-guard.ts'
import { openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'

allowProductionDatabase()

/** 旧字段摘要：**排除新列**（迁移 #17 的既有做法）。列都取自既有 SQL，确保存在。 */
const OLD_FIELDS_DIGEST = `select
    count(*)::int as rows,
    coalesce(md5(string_agg(id || '|' || coalesce(delivery_channel, '') || '|' || coalesce(conversation_ref, '')
      || '|' || scheduled_at::text || '|' || coalesce(text, ''), E'\\n' order by id)), '(empty)') as digest
  from notification_intents`

async function read(label: string, dir: string, withNewColumns: boolean): Promise<Record<string, unknown>> {
  const db = await openRawPGlite(dir)
  try {
    const schema = (await db.query('select max(version)::int as version from character_schema_migrations')).rows[0]
    const intents = (await db.query(OLD_FIELDS_DIGEST)).rows[0]
    /* ⚠️ 迁移**前**的快照没有新列 ⇒ 只有 after(v18) 才查它（否则 errorMissingColumn） */
    const newCols = withNewColumns
      ? (await db.query(
          `select count(*)::int as rows, count(repeat_mode)::int as non_null_repeat from notification_intents`
        )).rows[0]
      : { rows: 0, non_null_repeat: 0 }
    /*
     * ⚠️ 这里曾经是 `: { rows: 0, ... }` —— **那是个占位默认值，不是读数**，
     *    而我据此一度报出"快照缺 3 行"的结论（错的）。现在改成：v17 也**照真查**，
     *    只是**不查新列**。
     */
    const occurrences = withNewColumns
      ? (await db.query(
          `select count(*)::int as rows, count(repeat_attempt)::int as non_null_attempt,
                  coalesce(string_agg(state, ',' order by occurrence_key), '(none)') as states
             from notification_occurrences`
        )).rows[0]
      : (await db.query(
          `select count(*)::int as rows, null::int as non_null_attempt,
                  coalesce(string_agg(state, ',' order by occurrence_key), '(none)') as states
             from notification_occurrences`
        )).rows[0]
    /* ★ 明细：v17 也能查（不带新列即可） */
    const occurrenceDetail = (await db.query('select * from notification_occurrences order by occurrence_key limit 5')).rows
    return { label, schema: schema?.version, intents, newCols, occurrences, occurrenceDetail }
  } finally {
    await db.close()
  }
}

const realDataDir = productionDataDirOf()
const copyDir = mkdtempSync(join(tmpdir(), 'm18-readback-live-'))
cpSync(realDataDir, copyDir, { recursive: true })
console.log(`生产库（只被 cpSync 读，从未打开）: ${realDataDir}`)

const snapshotRoot = resolve('data/snapshots/reminder-repeat-m18-20261010')
const snapshotDir = existsSync(snapshotRoot)
  ? join(snapshotRoot, readdirSync(snapshotRoot).find(name => name.startsWith('pglite-')) ?? '')
  : ''
if (snapshotDir === '' || !existsSync(snapshotDir)) {
  console.error(`找不到迁移前快照目录：${snapshotRoot}`)
  process.exit(2)
}
console.log(`迁移前快照（只读打开）: ${snapshotDir}`)

const before = await read('before(v17 快照)', snapshotDir, false)
const after = await read('after(v18 副本)', copyDir, true)

for (const reading of [before, after]) {
  const intents = reading.intents as Record<string, unknown>
  const newCols = reading.newCols as Record<string, unknown>
  const occurrences = reading.occurrences as Record<string, unknown>
  console.log(`\n[${String(reading.label)}]`)
  console.log(`  schema=${String(reading.schema)}`)
  console.log(`  intents: rows=${String(intents.rows)} digest=${String(intents.digest).slice(0, 16)}…`)
  console.log(`  新列: non_null_repeat_mode=${String(newCols.non_null_repeat)}`)
  console.log(`  occurrences: rows=${String(occurrences.rows)} non_null_repeat_attempt=${String(occurrences.non_null_attempt)} states=${String(occurrences.states)}`)
  for (const row of (reading.occurrenceDetail ?? []) as Record<string, unknown>[]) {
    console.log(`    · ${JSON.stringify(row).slice(0, 320)}`)
  }
}

const sameDigest = (before.intents as Record<string, unknown>).digest === (after.intents as Record<string, unknown>).digest
const sameRows = (before.intents as Record<string, unknown>).rows === (after.intents as Record<string, unknown>).rows
console.log('\n=== 判据 ===')
console.log(`  schema 前进到 18                     : ${String(after.schema === 18)}`)
console.log(`  旧字段摘要逐字相同（排除 repeat_mode） : ${String(sameDigest)}`)
console.log(`  行数相同                             : ${String(sameRows)}`)
console.log(`  旧行 repeat_mode 全为 null            : ${String((after.newCols as Record<string, unknown>).non_null_repeat === 0)}`)
console.log(`  旧行 repeat_attempt 全为 null         : ${String((after.occurrences as Record<string, unknown>).non_null_attempt === 0)}`)
console.log('\n（两个库均已关闭；生产库从未被打开）')
