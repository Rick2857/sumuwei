/**
 * PostgreSQL 迁移 WP5：**源快照的形状探针**（只读，快）。
 *
 * ============================================================================
 *  它回答什么
 * ============================================================================
 *  做全表比较之前必须先看清"源到底长什么样"：
 *
 * ```text
 *   · 有哪些表（public + migrations，relkind in (r,p)）· 各多少行
 *   · 每张表的主键是什么（没有主键的表 ⇒ 走稳定行多重集）
 *   · **哪些列走哪条归一化路径**（numeric / vector / jsonb / bytea / 时间 / 数组）
 *   · 驱动给的 JS 形状（number / string / Date / Uint8Array / 数组）——
 *     这一条决定了"规范化够不够"（WP4 的 F-WP4-01 就是没看清形状造成的）
 * ```
 *
 *  它**不**碰真 PG、**不**写任何东西到源目录（读的是 `%TEMP%` 里的一次性副本）。
 *
 * 跑法：pnpm tsx scripts/postgresql/inventory-probe.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { openPgliteSnapshot } from './pglite-reader.ts'
import { normalizeByType } from './row-digest.ts'

const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'

const OUT_FILE = resolve('artifacts/post-lv2/local/pg-migration/source-shape.json')

/** JS 形状的名字（决定了"规范化要不要特别处理"） */
function shapeOf(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `array[${value.length}]`
  if (value instanceof Date) return 'Date'
  if (value instanceof Uint8Array) return 'Uint8Array'
  if (typeof value === 'bigint') return 'bigint'
  if (typeof value === 'object') return 'object'
  return typeof value
}

interface ColumnShape {
  column: string
  dataType: string
  shapes: string[]
  sample: string
}

async function main(): Promise<void> {
  const session = await openPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT })
  const tables = await session.listTables()

  const report: {
    source: string
    tables: { schema: string; name: string; kind: string; rows: number; primaryKey: string[]; columns: number }[]
    columnTypes: Record<string, number>
    shapes: ColumnShape[]
    tablesWithoutPrimaryKey: string[]
    totalRows: number
    attestation: unknown
  } = {
    source: SOURCE_SNAPSHOT,
    tables: [],
    columnTypes: {},
    shapes: [],
    tablesWithoutPrimaryKey: [],
    totalRows: 0,
    attestation: null,
  }

  for (const table of tables) {
    const reading = await session.readTable(table.schema, table.name)
    report.tables.push({
      schema: table.schema,
      name: table.name,
      kind: table.kind,
      rows: reading.rows.length,
      primaryKey: reading.primaryKey,
      columns: reading.columns.length,
    })
    report.totalRows += reading.rows.length
    if (reading.primaryKey.length === 0) report.tablesWithoutPrimaryKey.push(`${table.schema}.${table.name}`)
    for (const column of reading.columns) {
      const key = column.dataType
      report.columnTypes[key] = (report.columnTypes[key] ?? 0) + 1
    }
    // 逐列记录**实际出现的 JS 形状**（最多取前 200 行看形状）
    for (const column of reading.columns) {
      const shapes = new Set<string>()
      let sample = ''
      for (const row of reading.rows.slice(0, 200)) {
        const value = row[column.name]
        if (value === null || value === undefined) continue
        shapes.add(shapeOf(value))
        if (sample === '') sample = normalizeByType(value, column.dataType).slice(0, 80)
      }
      if (shapes.size === 0) shapes.add('(all null)')
      report.shapes.push({
        column: `${table.schema}.${table.name}.${column.name}`,
        dataType: column.dataType,
        shapes: [...shapes].sort(),
        sample,
      })
    }
    console.log(
      `${table.schema}.${table.name.padEnd(42)} rows=${String(reading.rows.length).padStart(6)} ` +
        `cols=${String(reading.columns.length).padStart(3)} pk=[${reading.primaryKey.join(',')}]`
    )
  }

  const attestation = await session.close()
  report.attestation = attestation
  mkdirSync(resolve(OUT_FILE, '..'), { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), 'utf8')

  console.log('')
  console.log(`表数=${report.tables.length} 总行数=${report.totalRows}`)
  console.log(`无主键的表=${report.tablesWithoutPrimaryKey.length}：${report.tablesWithoutPrimaryKey.join(', ')}`)
  console.log(`列类型分布=${JSON.stringify(report.columnTypes)}`)
  console.log(`自证=${JSON.stringify(attestation)}`)
  console.log('')
  console.log('可疑形状（同一列出现多种 JS 形状，或非预期的家族）：')
  const suspicious = report.shapes.filter((s) => s.shapes.length > 1)
  for (const s of suspicious.slice(0, 40)) console.log(`  ${s.column} [${s.dataType}] shapes=${s.shapes.join('/')}`)
  console.log(`  （共 ${suspicious.length} 条）`)
  console.log(`报告：${OUT_FILE}`)
}

await main()
