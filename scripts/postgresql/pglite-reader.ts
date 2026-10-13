/**
 * PostgreSQL 迁移 WP4：**只读地**从一份 PGlite 副本里读出表内容（供比较器用）。
 *
 * ============================================================================
 *  纪律（与 WP0 的两个探针同源）
 * ============================================================================
 *  · **只接受副本**：`--from` 指向 `data/pglite`（真实库）⇒ 直接拒绝。
 *  · 先在 `%TEMP%` 做一次性副本，**只打开副本**；源目录逐字节不动。
 *  · 只做 SELECT / 系统目录读取：没有 DDL、DML、迁移。
 *
 *  ⚠️ `@electric-sql/pglite` **不是根依赖**（由 plugin-sql 的依赖图提供）⇒
 *    裸 `import` 会 `ERR_MODULE_NOT_FOUND`。这里按插件在 pnpm store 里的真实路径解析它 ——
 *    与 WP0 的两个探针同一做法。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ColumnSpec } from './row-digest.ts'
import { requiresTextEncoding } from './column-encoding.ts'

interface PgliteClient {
  waitReady: Promise<void>
  query: <T>(query: string) => Promise<{ rows: T[] }>
  close: () => Promise<void>
}

function resolvePgliteEntry(): { pglite: string; vector: string } {
  const store = resolve('node_modules/.pnpm')
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith('@elizaos+plugin-sql@')) continue
      const pkg = join(store, entry, 'node_modules', '@elizaos', 'plugin-sql', 'package.json')
      if (!existsSync(pkg)) continue
      const requireFromHere = createRequire(pkg)
      return {
        pglite: requireFromHere.resolve('@electric-sql/pglite'),
        vector: requireFromHere.resolve('@electric-sql/pglite/vector'),
      }
    }
  }
  throw new Error('找不到 @electric-sql/pglite：plugin-sql 的 pnpm 布局与预期不同')
}

/** 目录摘要（路径 + 大小的多重集）—— 用于自证"源目录没被动过" */
function treeDigest(root: string): { files: number; bytes: number; digest: string } {
  const entries: string[] = []
  let bytes = 0
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, relPath)
      else {
        const size = statSync(full).size
        bytes += size
        entries.push(`${relPath}\u0000${size}`)
      }
    }
  }
  walk(root, '')
  entries.sort()
  return { files: entries.length, bytes, digest: createHash('sha256').update(entries.join('\n')).digest('hex') }
}

export interface PgliteReadResult {
  table: string
  columns: ColumnSpec[]
  rows: Record<string, unknown>[]
  /** 源目录在读取前后是否逐字相同（本函数只打开副本） */
  sourceUnchanged: boolean
  copyMatchesSource: boolean
  closedClean: boolean
}

/**
 * 读出某张表的全部行（含列类型）。
 *
 * `limit` 用于控制读数规模；缺省不限。
 */
export async function readPgliteTable(options: {
  sourceDir: string
  table: string
  limit?: number
  /** 工作目录（缺省 `%TEMP%` 下的一次性目录） */
  workDir?: string
}): Promise<PgliteReadResult> {
  const source = resolve(options.sourceDir)
  if (!existsSync(join(source, 'PG_VERSION'))) {
    throw new Error(`不是 PGlite 数据目录（缺 PG_VERSION）：${source}`)
  }
  if (/[\\/]data[\\/]pglite$/.test(source)) {
    throw new Error(`拒绝：--from 指向真实库 ${source}（本读取器只读副本）`)
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.table)) {
    throw new Error(`表名形状不合法：${options.table}`)
  }

  const before = treeDigest(source)
  const workDir = options.workDir ?? join(tmpdir(), `lg-pglite-read-${Date.now().toString(36)}`)
  const copyDir = join(workDir, 'copy')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  cpSync(source, copyDir, { recursive: true })
  const afterCopy = treeDigest(copyDir)
  const copyMatchesSource =
    afterCopy.files === before.files && afterCopy.bytes === before.bytes && afterCopy.digest === before.digest

  const paths = resolvePgliteEntry()
  const { PGlite } = (await import(pathToFileURL(paths.pglite).href)) as { PGlite: new (o: unknown) => PgliteClient }
  const { vector } = (await import(pathToFileURL(paths.vector).href)) as { vector: unknown }

  const db = new PGlite({ dataDir: copyDir, extensions: { vector } })
  await db.waitReady

  let columns: ColumnSpec[] = []
  let rows: Record<string, unknown>[] = []
  let closedClean = false
  try {
    const cols = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = '${options.table}'
        order by ordinal_position`
    )
    columns = cols.rows.map((r) => ({ name: r.column_name, dataType: r.data_type }))

    const limitClause = options.limit === undefined ? '' : ` limit ${Number(options.limit)}`
    const data = await db.query<Record<string, unknown>>(`select * from "${options.table}"${limitClause}`)
    rows = data.rows
  } finally {
    await db.close()
    closedClean = true
    rmSync(workDir, { recursive: true, force: true })
  }

  const after = treeDigest(source)
  return {
    table: options.table,
    columns,
    rows,
    sourceUnchanged: after.digest === before.digest,
    copyMatchesSource,
    closedClean,
  }
}

// ===========================================================================
// 多表会话（WP5：全库比较）
// ===========================================================================
/**
 * 为什么要有"打开一次、读多表"
 * ============================================================================
 * `readPgliteTable` **每次调用复制一次整个 PGlite 目录**（约 49 MB / 1269 文件）。
 * 全库比较有 54 张表 ⇒ 那样会复制 54 遍（`L-PGW4-03`/`L-PGW4-06` 记的就是这条）。
 *
 * 本会话把"复制一次"和"读多表"分开：
 *
 * ```text
 *   openPgliteSnapshot()  → 复制一次 + 打开一次 + **读一次目录摘要**
 *   session.readTable()   → 只 SELECT，不再复制
 *   session.close()       → 关库 + 再读一次目录摘要（自证源目录没被动过）+ 清工作目录
 * ```
 *
 * ⚠️ 自证仍然是**两次**摘要（打开前、关闭后），不是"打开过就算数"。
 */

/** 一张表在快照里的身份 */
export interface SnapshotTable {
  schema: string
  name: string
  /** `pg_class.relkind`：`r` 普通表 / `p` 分区表 */
  kind: string
}

export interface SnapshotTableReading {
  schema: string
  table: string
  columns: ColumnSpec[]
  /** 主键列（按约束里的顺序）；没有主键就是空数组 */
  primaryKey: string[]
  rows: Record<string, unknown>[]
}

export interface SnapshotAttestation {
  /** 源目录在**整个会话**前后是否逐字相同（本会话只打开副本） */
  sourceUnchanged: boolean
  copyMatchesSource: boolean
  closedClean: boolean
  sourceTreeDigest: string
  copyTreeDigest: string
  files: number
  bytes: number
}

export interface PgliteSnapshotSession {
  /** `public` 与 `migrations` schema 下的**基表**（`relkind in (r,p)`） */
  listTables: () => Promise<SnapshotTable[]>
  readTable: (schema: string, table: string) => Promise<SnapshotTableReading>
  /**
   * **诊断/测量专用**的裸查询口（只读语义由调用方保证）。
   *
   * ⚠️ **不要**在比较路径上用它：比较路径必须走 `readTable`（那一条带着
   *    `column-encoding.ts` 的编码判据）。这里开放出来是为了**性能测量**
   *    —— 要比"两个后端跑同一条 SQL"的时延，就必须能在两侧跑**同一条** SQL。
   *    ⇒ 纪律：**测量路径**（本条）与**判据路径**（`readTable`）分开。
   */
  queryRaw: <T>(sql: string) => Promise<T[]>
  close: () => Promise<SnapshotAttestation>
}

/** 标识符白名单（表名/列名都要过这一关，避免拼串） */
function assertIdentifier(value: string, what: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${what} 形状不合法：${JSON.stringify(value)}`)
  }
}

/**
 * 打开一份 PGlite **副本**并保持会话（只读）。
 *
 * 拒绝 `sourceDir` 指向真实库 `data/pglite`。
 */
export async function openPgliteSnapshot(options: {
  sourceDir: string
  workDir?: string
  /** 会话作用的 schema（缺省 `public` 与 `migrations`） */
  schemas?: readonly string[]
}): Promise<PgliteSnapshotSession> {
  const source = resolve(options.sourceDir)
  if (!existsSync(join(source, 'PG_VERSION'))) {
    throw new Error(`不是 PGlite 数据目录（缺 PG_VERSION）：${source}`)
  }
  if (/[\\/]data[\\/]pglite$/.test(source)) {
    throw new Error(`拒绝：sourceDir 指向真实库 ${source}（本读取器只读副本）`)
  }
  const schemas = options.schemas ?? ['public', 'migrations']
  for (const schema of schemas) assertIdentifier(schema, 'schema')
  const schemaList = schemas.map((s) => `'${s}'`).join(',')

  const before = treeDigest(source)
  const workDir = options.workDir ?? join(tmpdir(), `lg-pglite-session-${Date.now().toString(36)}`)
  const copyDir = join(workDir, 'copy')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  cpSync(source, copyDir, { recursive: true })
  const afterCopy = treeDigest(copyDir)
  const copyMatchesSource =
    afterCopy.files === before.files && afterCopy.bytes === before.bytes && afterCopy.digest === before.digest

  const paths = resolvePgliteEntry()
  const { PGlite } = (await import(pathToFileURL(paths.pglite).href)) as { PGlite: new (o: unknown) => PgliteClient }
  const { vector } = (await import(pathToFileURL(paths.vector).href)) as { vector: unknown }

  const db = new PGlite({ dataDir: copyDir, extensions: { vector } })
  await db.waitReady

  let closed = false

  return {
    listTables: async (): Promise<SnapshotTable[]> => {
      const result = await db.query<{ nspname: string; relname: string; relkind: string }>(
        'select n.nspname, c.relname, c.relkind::text as relkind ' +
          'from pg_class c join pg_namespace n on n.oid = c.relnamespace ' +
          `where n.nspname in (${schemaList}) and c.relkind in ('r','p') ` +
          'order by n.nspname, c.relname'
      )
      return result.rows.map((row) => ({ schema: row.nspname, name: row.relname, kind: row.relkind }))
    },

    readTable: async (schema: string, table: string): Promise<SnapshotTableReading> => {
      assertIdentifier(schema, 'schema')
      assertIdentifier(table, 'table')
      // ⚠️ `data_type` 对 `vector` 给的是 `USER-DEFINED` ⇒ 必须换成 `udt_name`，
      //    否则向量会被按**文本**家族归一：一侧是数组 `[1,2]`、另一侧是驱动给的字符串，
      //    而两者的数字文本写法可能不同（`0.1` vs `0.1000000000000000055`）⇒ **假不等**。
      const cols = await db.query<{ column_name: string; effective_type: string }>(
        'select column_name, ' +
          "case when data_type = 'USER-DEFINED' then udt_name else data_type end as effective_type " +
          `from information_schema.columns where table_schema = '${schema}' and table_name = '${table}' ` +
          'order by ordinal_position'
      )
      const columns: ColumnSpec[] = cols.rows.map((row) => ({
        name: row.column_name,
        dataType: row.effective_type,
      }))

      const pk = await db.query<{ column_name: string }>(
        'select kcu.column_name ' +
          'from information_schema.table_constraints tc ' +
          'join information_schema.key_column_usage kcu ' +
          '  on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema ' +
          ' and kcu.table_name = tc.table_name ' +
          "where tc.constraint_type = 'PRIMARY KEY' " +
          `and tc.table_schema = '${schema}' and tc.table_name = '${table}' ` +
          'order by kcu.ordinal_position'
      )

      const data = await db.query<Record<string, unknown>>(
        // ⚠️ **显式投影**（不是 `select *`）：需要转文本的列在 SQL 里就 `::text` ——
        //    判据见 `column-encoding.ts`（那里写着"为什么"）。两侧用**同一条**判据，
        //    否则会出现"看起来在比数据、其实在比驱动的编码"（F-WP4-01 那一类）。
        `select ${columns
          .map((column) =>
            requiresTextEncoding(column.dataType)
              ? `"${column.name}"::text as "${column.name}"`
              : `"${column.name}"`
          )
          .join(', ')} from "${schema}"."${table}"`
      )
      return {
        schema,
        table,
        columns,
        primaryKey: pk.rows.map((row) => row.column_name),
        rows: data.rows,
      }
    },

    queryRaw: async <T>(sql: string): Promise<T[]> => {
      const result = await db.query<T>(sql)
      return result.rows
    },

    close: async (): Promise<SnapshotAttestation> => {
      if (!closed) {
        closed = true
        await db.close()
        rmSync(workDir, { recursive: true, force: true })
      }
      const after = treeDigest(source)
      return {
        sourceUnchanged: after.digest === before.digest,
        copyMatchesSource,
        closedClean: closed,
        sourceTreeDigest: before.digest,
        copyTreeDigest: afterCopy.digest,
        files: before.files,
        bytes: before.bytes,
      }
    },
  }
}
