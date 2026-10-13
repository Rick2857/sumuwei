/**
 * PostgreSQL 迁移 WP5：**从真 PG 侧读全库**（供全表比较用）。
 *
 * ============================================================================
 *  与 `pglite-reader.ts` 的分工
 * ============================================================================
 * ```text
 *   pglite-reader   源（PGlite verified 快照的**副本**）：一次复制、打开一次、读多表
 *   pg-target-reader 目标（真 PG）：经 psql 读，**不复制任何东西**（它就是被比的那一侧）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  三条刻意的设计（每条都有实测理由）
 * ---------------------------------------------------------------------------
 *  ① **列类型取 `udt_name` 而不是 `data_type`**（当 `data_type = 'USER-DEFINED'`）
 *     `information_schema.columns.data_type` 对 `vector` 给的是 `USER-DEFINED` ⇒
 *     向量会被按**文本**家族归一，而两个驱动给出的数字文本写法可能不同
 *     （`0.1` vs `0.1000000000000000055`）⇒ **假不等**。换成 `udt_name`（`vector`）后
 *     走 `v:` 家族，两侧都做逐分量规范化。
 *
 *  ② **`numeric` / `real` / `double precision` 在 SQL 里就 `::text`**
 *     `jsonb_agg` 会把 `numeric` 写成 **JSON 数字** ⇒ 到 JS 就成了 double ⇒
 *     超过 17 位有效数字的部分**静默丢失**（假绿）。在 SQL 里先转文本，
 *     JS 侧再按列类型精确规范化，一位都不丢。
 *
 *  ③ **主键取 `information_schema` 的约束视图**，不解析 `pg_index.indkey`
 *     `indkey` 是 `int2vector`，解析要处理 `unnest` + 序号；标准视图直接给
 *     `ordinal_position`，且 PGlite 与真 PG 都支持 ⇒ **两侧用的是同一条判据**。
 *
 * 跑法：由 `scripts/postgresql-g05-verify.ts` 调用。
 */

import type { ColumnSpec } from './row-digest.ts'
import type { SnapshotTable } from './pglite-reader.ts'
import { requiresTextEncoding } from './column-encoding.ts'

/** 执行 SQL 并返回文本（`rc !== 0` ⇒ `undefined`）；由调用方注入（`psql` / 将来的 `pg` 驱动） */
export type SqlQuery = (sql: string) => string | undefined

/** `jsonb_agg` 的结果文本 ⇒ 解析成行数组；样式不对就抛（**不**静默返回空数组） */
export function parseRowJson(text: string, what: string): Record<string, unknown>[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${what}：读回来的不是 JSON（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${what}：读回来的 JSON 不是数组`)
  return parsed as Record<string, unknown>[]
}

function assertIdentifier(value: string, what: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${what} 形状不合法：${JSON.stringify(value)}`)
}

/** 分隔符：**在 SQL 里用 `chr(1)` 生成**，不把控制字符放进命令行参数 */
const SEP = 'chr(1)'
const SEP_CHAR = '\u0001'

export interface TargetTableReading {
  schema: string
  table: string
  columns: ColumnSpec[]
  primaryKey: string[]
  rows: Record<string, unknown>[]
}

/** 目标侧的基表清单（`public` + `migrations`，`relkind in (r,p)`） */
export function listTargetTables(query: SqlQuery, schemas: readonly string[] = ['public', 'migrations']): SnapshotTable[] | undefined {
  for (const schema of schemas) assertIdentifier(schema, 'schema')
  const list = schemas.map((s) => `'${s}'`).join(',')
  const raw = query(
    `select n.nspname||${SEP}||c.relname||${SEP}||c.relkind::text ` +
      'from pg_class c join pg_namespace n on n.oid = c.relnamespace ' +
      `where n.nspname in (${list}) and c.relkind in ('r','p') ` +
      'order by n.nspname, c.relname'
  )
  if (raw === undefined) return undefined
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [schema, name, kind] = line.split(SEP_CHAR)
      return { schema, name, kind }
    })
}

export interface TargetCatalogEntry {
  columns: ColumnSpec[]
  primaryKey: string[]
}

/**
 * **一次读完整库的列规格与主键**（两趟查询，不是每表三趟）。
 *
 * ⚠️ 为什么值得单独一条：54 张表 × 3 次 `docker exec` ≈ 162 次进程启动
 *    （每次约 100ms）⇒ 光这一项就要 16 秒，而且**判据完全一样**。
 *    批量版本把"每表一趟"降成"整库两趟"。
 */
export function readTargetCatalog(
  query: SqlQuery,
  schemas: readonly string[] = ['public', 'migrations']
): Map<string, TargetCatalogEntry> | undefined {
  for (const schema of schemas) assertIdentifier(schema, 'schema')
  const list = schemas.map((s) => `'${s}'`).join(',')

  const columnsRaw = query(
    `select table_schema||${SEP}||table_name||${SEP}||column_name||${SEP}||` +
      "case when data_type = 'USER-DEFINED' then udt_name else data_type end " +
      `from information_schema.columns where table_schema in (${list}) ` +
      'order by table_schema, table_name, ordinal_position'
  )
  if (columnsRaw === undefined) return undefined
  const pkRaw = query(
    `select tc.table_schema||${SEP}||tc.table_name||${SEP}||kcu.column_name ` +
      'from information_schema.table_constraints tc ' +
      'join information_schema.key_column_usage kcu ' +
      '  on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema ' +
      ' and kcu.table_name = tc.table_name ' +
      `where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema in (${list}) ` +
      'order by tc.table_schema, tc.table_name, kcu.ordinal_position'
  )
  if (pkRaw === undefined) return undefined

  const catalog = new Map<string, TargetCatalogEntry>()
  for (const line of columnsRaw.split('\n')) {
    if (line.trim() === '') continue
    const [schema, table, column, dataType] = line.split(SEP_CHAR)
    const key = `${schema}.${table}`
    const entry = catalog.get(key) ?? { columns: [], primaryKey: [] }
    entry.columns.push({ name: column, dataType })
    catalog.set(key, entry)
  }
  for (const line of pkRaw.split('\n')) {
    if (line.trim() === '') continue
    const [schema, table, column] = line.split(SEP_CHAR)
    const key = `${schema}.${table}`
    const entry = catalog.get(key) ?? { columns: [], primaryKey: [] }
    entry.primaryKey.push(column)
    catalog.set(key, entry)
  }
  return catalog
}

/** 目标侧一张表的列规格 + 主键 */
export function readTargetTableSchema(query: SqlQuery, schema: string, table: string): { columns: ColumnSpec[]; primaryKey: string[] } | undefined {
  assertIdentifier(schema, 'schema')
  assertIdentifier(table, 'table')
  const columnsRaw = query(
    `select column_name||${SEP}||` +
      "case when data_type = 'USER-DEFINED' then udt_name else data_type end " +
      `from information_schema.columns where table_schema = '${schema}' and table_name = '${table}' ` +
      'order by ordinal_position'
  )
  if (columnsRaw === undefined) return undefined
  const columns: ColumnSpec[] = columnsRaw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [name, dataType] = line.split(SEP_CHAR)
      return { name, dataType }
    })

  const pkRaw = query(
    'select kcu.column_name ' +
      'from information_schema.table_constraints tc ' +
      'join information_schema.key_column_usage kcu ' +
      '  on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema ' +
      ' and kcu.table_name = tc.table_name ' +
      "where tc.constraint_type = 'PRIMARY KEY' " +
      `and tc.table_schema = '${schema}' and tc.table_name = '${table}' ` +
      'order by kcu.ordinal_position'
  )
  if (pkRaw === undefined) return undefined
  const primaryKey = pkRaw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return { columns, primaryKey }
}

/**
 * 目标侧一张表的**全部行**。
 *
 * ⚠️ 先取列规格再拼 SQL（否则不知道该把哪些列 `::text`）。
 */
export function readTargetTableRows(query: SqlQuery, schema: string, table: string, columns: readonly ColumnSpec[]): Record<string, unknown>[] | undefined {
  assertIdentifier(schema, 'schema')
  assertIdentifier(table, 'table')
  const projections = columns
    .map((column) => {
      assertIdentifier(column.name, 'column')
      // ⚠️ 与源侧**同一条判据**（`column-encoding.ts`）—— 见那里的不变式 ①。
      return requiresTextEncoding(column.dataType)
        ? `to_jsonb("${column.name}"::text) as "${column.name}"`
        : `to_jsonb("${column.name}") as "${column.name}"`
    })
    .join(', ')
  const raw = query(
    `select coalesce(jsonb_agg(x), '[]'::jsonb)::text from (select ${projections} from "${schema}"."${table}") x`
  )
  if (raw === undefined) return undefined
  return parseRowJson(raw, `${schema}.${table}`)
}

/** 读一张表的三件套（规格 + 主键 + 行） */
export function readTargetTable(query: SqlQuery, schema: string, table: string): TargetTableReading | undefined {
  const schemaReading = readTargetTableSchema(query, schema, table)
  if (schemaReading === undefined) return undefined
  const rows = readTargetTableRows(query, schema, table, schemaReading.columns)
  if (rows === undefined) return undefined
  return { schema, table, columns: schemaReading.columns, primaryKey: schemaReading.primaryKey, rows }
}
