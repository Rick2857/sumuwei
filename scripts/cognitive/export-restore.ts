/**
 * 认知能力建设 · **逻辑导出 / 恢复**（2026-10-21 · 计划 P0.5）
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 *  计划 §3 P0.5 逐字要求：
 *
 *      「在隔离合成角色上建立最小导出/恢复样本：身份、记忆资格、关系情绪、
 *        目标承诺、已撤回根和现有 EBL 状态。后续随新类型扩展。」
 *
 *  它是 P2（世界模型 ＋ EBL 闭环）的**前提**：要证明
 *  「反例结算之后，派生模型 / 技能引用 / 待执行计划拒用」，
 *  就必须能在**一个可复现的起点**上重放同一条链 ⇒ 需要
 *  「把一个角色的状态导出成一份可搬运的文档，再恢复进一个空库」。
 *
 * ============================================================================
 *  为什么是**逻辑导出**而不是"复制数据目录"
 * ============================================================================
 *  PGlite 时代可以 `cpSync(dir, dir)`（`m4:restore:verify` 现在的做法）。
 *  PostgreSQL **没有数据目录**可复制 ⇒ 必须走逻辑导出。
 *
 *  而且逻辑导出才是**可扩展**的那条路：新增一种类型只要往
 *  `EXPORT_TABLES` 里加一张表，导出/恢复**自动**带上它
 *  （计划 §3 P0.5 的"后续随新类型扩展"）。
 *
 * ============================================================================
 *  覆盖的六个方面（计划 §3 P0.5 逐项）
 * ============================================================================
 *  · **身份**      → `character_definitions` · `character_definition_versions`
 *  · **记忆资格**  → `memory_records` · `memory_subject_links` · `memory_events`
 *  · **关系情绪**  → `character_states` · `state_events` · `character_projections`
 *                   （`relationship:*` / `affect:character` 两种 projection_type）
 *  · **目标承诺**  → `character_projections`（`goal:*` 两种 projection_type）
 *  · **已撤回根**  → `memory_evidence_links`（根与记忆的关联及其撤回状态）
 *  · **EBL 状态**  → `character_projections`（`ebl:*`）+ `character_domain_events`
 *                   （`EBL_EVENT`）
 *
 *  ⇒ 关系情绪 / 目标承诺 / EBL 三者在**同一张通用投影表**里
 *    （`character_projections`，主键 `(character_id, projection_type)`），
 *    所以一张表就覆盖了三块 —— 这一点在本文件里是**刻意**记下来的：
 *    将来某个域要是独立成表，只要往清单里加一行。
 *
 * ============================================================================
 *  格式
 * ============================================================================
 *  `lg-cognitive-export@1`：
 *  ```json
 *  {
 *    "format": "lg-cognitive-export@1",
 *    "schemaVersion": 23,
 *    "exportedAt": "…",
 *    "tables": [ { "name": "…", "columns": ["…"], "rows": [ {…} ] } ],
 *    "digest": "sha256(规范化后的 tables)"
 *  }
 *  ```
 *  ⚠️ `digest` **只**覆盖 `tables`（**不含** `exportedAt`）——
 *    否则同一份状态导出两次就会有两个 digest，"恢复后与原来一样"这句话就没法判。
 * ============================================================================
 */

import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'

import type { RawDb } from '../../src/infrastructure/persistence/db.ts'
import { exec } from '../../src/infrastructure/persistence/db.ts'

/** 导出格式标识（版本化 ⇒ 将来格式变了能判出来） */
export const EXPORT_FORMAT = 'lg-cognitive-export@1'

/**
 * 导出覆盖的表。
 *
 * ⚠️ **顺序 = 恢复时的插入顺序**（父表在前）：有外键的表必须先有被引用的行。
 *    删除时按**反序**（子表先删）。
 */
export const EXPORT_TABLES: ReadonlyArray<{ name: string; aspect: string }> = [
  { name: 'character_definitions', aspect: '身份' },
  { name: 'character_definition_versions', aspect: '身份（历史版本）' },
  { name: 'conversation_events', aspect: '事件账本（会话层）' },
  { name: 'character_domain_events', aspect: '事件账本（域层 · 含 EBL 事件）' },
  { name: 'processed_operations', aspect: '幂等账（重放不重复处理）' },
  { name: 'character_sequence_counters', aspect: '角色级序号计数' },
  { name: 'memory_records', aspect: '记忆资格（active/superseded/retracted/disputed）' },
  { name: 'memory_subject_links', aspect: '记忆资格（主体绑定）' },
  { name: 'memory_evidence_links', aspect: '已撤回根（根 ↔ 记忆 ↔ 状态）' },
  { name: 'memory_events', aspect: '记忆事件流（重放的依据）' },
  { name: 'character_states', aspect: '关系情绪（当前状态）' },
  { name: 'state_events', aspect: '关系情绪（事件流）' },
  { name: 'character_projections', aspect: '关系情绪 / 目标承诺 / 信念 / EBL 的投影' },
]

export interface ExportTable {
  name: string
  /** 列名（按 ordinal_position 排序） */
  columns: string[]
  rows: Array<Record<string, unknown>>
}

export interface CognitiveExport {
  format: typeof EXPORT_FORMAT
  schemaVersion: number
  exportedAt: string
  tables: ExportTable[]
  /** sha256（**只**覆盖 tables，不含 exportedAt） */
  digest: string
}

/** bytea 在 JSON 里的标记（pg 返回 Buffer，JSON 化不了） */
const BYTES_MARKER = '$bytes'

/** 把驱动返回的值规范化成"可 JSON 化、可确定性比较"的形式 */
export function canonicalValue (value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return { [BYTES_MARKER]: value.toString('base64') }
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = canonicalValue(source[key])
    return out
  }
  return value
}

/** 反规范化：把 bytea 标记变回 Buffer，其余原样 */
function denormalizeValue (value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value
  if (Array.isArray(value)) return value.map(denormalizeValue)
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    if (typeof source[BYTES_MARKER] === 'string' && Object.keys(source).length === 1) {
      return Buffer.from(source[BYTES_MARKER], 'base64')
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source)) out[key] = denormalizeValue(source[key])
    return out
  }
  return value
}

/** 确定性 JSON（对象键排序） */
export function canonicalJson (value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

/** 导出摘要：只覆盖 tables */
export function exportDigest (tables: ExportTable[]): string {
  const material = tables
    .map(table => ({ name: table.name, columns: table.columns, rows: table.rows }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return createHash('sha256').update(canonicalJson(material), 'utf8').digest('hex')
}

/** 一列的名字与类型（类型决定恢复时怎么把值绑回去） */
interface ColumnInfo {
  name: string
  dataType: string
}

/** 读一张表的列（按 ordinal_position） */
async function columnsOf (db: RawDb, table: string): Promise<ColumnInfo[]> {
  const rows = await exec(
    db,
    sql`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = ${table} and is_generated = 'NEVER'
      order by ordinal_position
    `,
    `读表 ${table} 的列`
  )
  return rows.map(row => ({ name: String(row.column_name), dataType: String(row.data_type) }))
}

/**
 * 把规范化后的值**绑回**驱动（按列类型）。
 *
 * ⚠️ `jsonb` 必须显式 JSON 化：直接绑一个 JS 对象，驱动/ORM 组合的编码方式
 *    各不相同（实测 drizzle 会把它当参数原样传过去，PG 收到的是 `[object Object]`）。
 */
function bindValue (value: unknown, dataType: string): unknown {
  const plain = denormalizeValue(value)
  if (plain === null || plain === undefined) return null
  if (dataType === 'jsonb' || dataType === 'json') return JSON.stringify(plain)
  if (dataType === 'bytea') return plain
  return plain
}

/** 读一张表的全部行（规范化 + 确定性排序） */
async function rowsOfTable (db: RawDb, table: string, columns: ColumnInfo[]): Promise<Array<Record<string, unknown>>> {
  if (columns.length === 0) return []
  // ⚠️ 列名来自 information_schema（**可信标识符**），所以拼进 raw SQL 是安全的。
  const columnList = columns.map(column => `"${column.name}"`).join(', ')
  const rows = await exec(db, sql.raw(`select ${columnList} from "${table}"`), `读表 ${table}`)
  const normalized = rows.map(row => {
    const out: Record<string, unknown> = {}
    for (const column of columns) out[column.name] = canonicalValue(row[column.name])
    return out
  })
  // ⚠️ 排序在 **JS 侧**做：不同列类型（jsonb / bytea / 向量）的可排序性不一样，
  //    而"确定性"只需要一个**稳定**的全序 —— 按规范化 JSON 的字典序即可。
  normalized.sort((a, b) => {
    const left = canonicalJson(a)
    const right = canonicalJson(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
  return normalized
}

/**
 * 导出一个角色的认知状态。
 *
 * ⚠️ 导的是**整张表**（不是"这个角色的行"）：隔离测试库里**只有**那个合成角色，
 *    整表导出才不会漏掉"跨角色的引用行"（例如 `processed_operations`）。
 */
export async function exportCognitiveState (db: RawDb): Promise<CognitiveExport> {
  const tables: ExportTable[] = []
  for (const entry of EXPORT_TABLES) {
    const columns = await columnsOf(db, entry.name)
    tables.push({
      name: entry.name,
      columns: columns.map(column => column.name),
      rows: await rowsOfTable(db, entry.name, columns),
    })
  }
  const schemaRows = await exec(
    db,
    sql`select coalesce(max(version), 0) as v from character_schema_migrations`,
    '读 schema 版本'
  )
  const schemaVersion = Number(schemaRows[0]?.v ?? 0)
  return {
    format: EXPORT_FORMAT,
    schemaVersion,
    exportedAt: new Date().toISOString(),
    tables,
    digest: exportDigest(tables),
  }
}

/**
 * 把一份导出**恢复**进当前库（先清空再写入）。
 *
 * ⚠️ 清空范围 = `EXPORT_TABLES` 里的表，**不包括**
 *    `character_schema_migrations`（那是 schema，不是状态）。
 */
export async function restoreCognitiveState (db: RawDb, doc: CognitiveExport): Promise<void> {
  if (doc.format !== EXPORT_FORMAT) {
    throw new Error(`导出格式不认识：${doc.format}（本仓只认 ${EXPORT_FORMAT}）`)
  }
  // 删除：子表先删（= 清单反序）
  for (const entry of [...EXPORT_TABLES].reverse()) {
    await exec(db, sql.raw(`delete from "${entry.name}"`), `清空表 ${entry.name}`)
  }
  // 插入：父表先插（= 清单顺序）
  for (const table of doc.tables) {
    if (table.rows.length === 0) continue
    const columnInfos = await columnsOf(db, table.name)
    const types = new Map(columnInfos.map(column => [column.name, column.dataType]))
    for (const row of table.rows) {
      const values = table.columns.map(column =>
        sql`${bindValue(row[column], types.get(column) ?? 'text')}`
      )
      await exec(
        db,
        sql`insert into ${sql.raw(`"${table.name}"`)} (${sql.raw(table.columns.map(c => `"${c}"`).join(', '))}) values (${sql.join(values, sql`, `)})`,
        `写入表 ${table.name}`
      )
    }
  }
}
