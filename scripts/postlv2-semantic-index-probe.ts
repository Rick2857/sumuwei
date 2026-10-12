/**
 * 只读探针：**语义索引在（快照副本里）到底建了没有**。
 *
 * 用 `S7` 那个成熟的做法：复制**快照**副本 → `PGlite(readOnly: true)` 原始只读连接 →
 * 只 SELECT。**不 import 任何会跑迁移的模块**（`initDatabase` 会把待应用迁移施加到它打开的库上，
 * 那正是 `PL2-AI-01` 结清时踩过的坑）。
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(process.cwd())
const SNAPSHOT_ROOT = resolve(process.env.PGLITE_SNAPSHOT_DIR ?? join(REPO_ROOT, 'data/snapshots'))
const snapshotId = process.argv[2]
if (snapshotId === undefined) {
  console.error('用法：tsx scripts/postlv2-semantic-index-probe.ts <snapshotId>')
  process.exit(2)
}

const source = join(SNAPSHOT_ROOT, snapshotId)
if (!existsSync(source)) {
  console.error(`快照不存在：${source}`)
  process.exit(2)
}

const copyDir = mkdtempSync(join(tmpdir(), 'pl2sem-'))
try {
  cpSync(source, join(copyDir, 'data'), { recursive: true })
  const require = createRequire(import.meta.url)
  const entry = pathToFileURL(require.resolve('@electric-sql/pglite')).href
  const pglite = (await import(entry)) as {
    PGlite: new (path: string, options?: { readOnly?: boolean }) => unknown
  }
  const db = new pglite.PGlite(join(copyDir, 'data'), { readOnly: true }) as {
    waitReady: Promise<void>
    query: (statement: string) => Promise<{ rows: Record<string, unknown>[] }>
    close: () => Promise<void>
  }
  await db.waitReady
  const query = async (statement: string): Promise<Record<string, unknown>[]> => {
    const head = statement.trim().slice(0, 6).toLowerCase()
    if (!head.startsWith('select')) throw new Error(`拒绝非 SELECT：${statement.slice(0, 80)}`)
    return (await db.query(statement)).rows
  }

  console.log(`快照：${snapshotId}`)

  /* ① schema 版本（顺便再确认一次 v10） */
  const versions = await query('select version, name from character_schema_migrations order by version asc')
  const maxVersion = versions.reduce((max, row) => Math.max(max, Number(row['version'])), 0)
  console.log(`schema 版本 = v${String(maxVersion)}（${String(versions.length)} 条迁移）`)

  /* ② 语义派生表在不在、有没有内容 */
  const tables = await query(
    "select table_name from information_schema.tables where table_name like '%semantic%' order by table_name"
  )
  console.log(`语义相关表：${JSON.stringify(tables.map((row) => String(Object.values(row)[0])))}`)

  for (const table of ['memory_semantic_meta', 'memory_semantic_index', 'memory_semantic_generations']) {
    try {
      const rows = await query(`select count(*)::int as n from ${table}`)
      console.log(`  ${table} = ${String(rows[0]?.['n'])} 行`)
    } catch (error) {
      console.log(`  ${table} = （不可读：${error instanceof Error ? error.message.slice(0, 60) : '?'}）`)
    }
  }

  /* ③ 记忆总数（"建了索引"要与它有可比的规模） */
  try {
    const rows = await query('select count(*)::int as n from memories')
    console.log(`memories = ${String(rows[0]?.['n'])} 行`)
  } catch {
    console.log('memories = （不可读）')
  }
  try {
    const rows = await query('select count(*)::int as n from memory_records')
    console.log(`memory_records = ${String(rows[0]?.['n'])} 行`)
  } catch {
    console.log('memory_records = （不可读）')
  }

  await db.close()
} finally {
  try {
    rmSync(copyDir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响读数 */
  }
}
