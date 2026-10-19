/**
 * W0b · 六张基础表的**结构指纹**取证（M12 卸载 ElizaOS 的输入）。
 *
 * ============================================================================
 *  它取什么、为什么不是"表数"
 * ============================================================================
 * W1 要在**没有 ElizaOS 的情况下**建出同样能用的六张表
 * （`agents` / `memories` / `rooms` / `participants` / `entities` / `worlds`）。
 * 只记"44 张表"是不够的 —— 真正决定"能不能用"的是：
 *
 *   · 列：名字 / 类型 / 是否 NOT NULL / 默认值
 *   · 外键：指向哪张表的哪一列（**含级联规则**）
 *   · 唯一约束与索引（唯一索引是幂等的根据）
 *   · 扩展（`vector` —— 迁移 10 的 `vector(384)` 列依赖它）
 *   · 触发器
 *
 * ⚠️ **表数不能代替结构**：本门对"表数"只作为**附带读数**，主判据是逐项结构。
 *
 * ============================================================================
 *  运行方式（**必须**显式给出隔离目标；缺一即拒）
 * ============================================================================
 *   POSTGRES_URL=postgres://…/lg_test_w0b \
 *   LG_PG_EXPECT_DATABASE=lg_test_w0b \
 *   node node_modules/tsx/dist/cli.mjs scripts/thinhost-bootstrap-fingerprint.ts
 *
 * ⚠️ **失败关闭**：目标库不带 `lg_test_` 前缀、或与 `LG_PRODUCTION_POSTGRES_URL`
 *   同名 ⇒ 当场拒绝（这是本门的第一条判据，不是事后检查）。
 */

import pg from 'pg'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

/** W1 要接管的那六张表（名单同 src/db/index.ts:528） */
export const BASE_TABLES = ['agents', 'memories', 'rooms', 'participants', 'entities', 'worlds'] as const

const url = process.env.POSTGRES_URL ?? ''
const dbName = (() => {
  try {
    return new URL(url).pathname.replace(/^\//, '')
  } catch {
    return ''
  }
})()
const productionUrl = process.env.LG_PRODUCTION_POSTGRES_URL ?? ''
const productionDb = (() => {
  try {
    return new URL(productionUrl).pathname.replace(/^\//, '')
  } catch {
    return ''
  }
})()

// ---------------------------------------------------------------------------
// 0 · 安全轨：目标必须是隔离测试库
// ---------------------------------------------------------------------------
if (dbName === '' || !dbName.startsWith('lg_test_')) {
  console.error(`拒绝：目标库名 "${dbName}" 不带 lg_test_ 前缀。本门不得指向生产库。`)
  process.exit(2)
}
if (productionDb !== '' && dbName === productionDb) {
  console.error(`拒绝：目标库与生产库同名（${dbName}）。`)
  process.exit(2)
}

const pool = new pg.Pool({ connectionString: url, max: 1 })

async function main(): Promise<void> {
  try {
    const identity = await pool.query(
      'select current_database() as db, current_user as usr, current_setting(\'server_version\') as ver'
    )
    const row = identity.rows[0] ?? {}
    check(
      'S0-identity',
      row.db === dbName,
      `database=${String(row.db)} user=${String(row.usr)} server=${String(row.ver)}`
    )

    // -----------------------------------------------------------------------
    // 1 · 六张表都在
    // -----------------------------------------------------------------------
    const tablesRes = await pool.query(
      `select table_name from information_schema.tables
        where table_schema='public' and table_name = any($1)`,
      [[...BASE_TABLES]]
    )
    const found = tablesRes.rows.map((r) => String(r.table_name)).sort()
    const missing = BASE_TABLES.filter((t) => !found.includes(t))
    check(
      'S1-six-base-tables',
      missing.length === 0,
      missing.length === 0
        ? `六张基础表齐备：${found.join(', ')}`
        : `缺 ${missing.join(', ')}（实到 ${found.length}/6）`
    )

    // -----------------------------------------------------------------------
    // 2 · 列（名字 / 类型 / NOT NULL / 默认值）
    // -----------------------------------------------------------------------
    const colsRes = await pool.query(
      `select table_name, column_name, data_type, udt_name, is_nullable, column_default
         from information_schema.columns
        where table_schema='public' and table_name = any($1)
        order by table_name, ordinal_position`,
      [[...BASE_TABLES]]
    )
    const columnsByTable = new Map<string, string[]>()
    for (const r of colsRes.rows) {
      const t = String(r.table_name)
      const notNull = String(r.is_nullable) === 'NO' ? ' NOT NULL' : ''
      const def = r.column_default === null || r.column_default === undefined ? '' : ` DEFAULT ${String(r.column_default)}`
      const line = `${String(r.column_name)}:${String(r.data_type)}${notNull}${def}`
      columnsByTable.set(t, [...(columnsByTable.get(t) ?? []), line])
    }
    const totalColumns = [...columnsByTable.values()].reduce((n, v) => n + v.length, 0)
    check(
      'S2-columns-captured',
      totalColumns > 0,
      `六张表共取到 ${String(totalColumns)} 个列定义（每表 ${[...columnsByTable.entries()].map(([t, v]) => `${t}=${String(v.length)}`).join(' ')}）`
    )

    // -----------------------------------------------------------------------
    // 3 · 外键（含级联规则）
    // -----------------------------------------------------------------------
    const fkRes = await pool.query(
      `select tc.table_name, kcu.column_name,
              ccu.table_name as foreign_table, ccu.column_name as foreign_column,
              rc.update_rule, rc.delete_rule
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
         join information_schema.referential_constraints rc
           on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
        where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema='public'
          and tc.table_name = any($1)
        order by tc.table_name, kcu.column_name`,
      [[...BASE_TABLES]]
    )
    const fks = fkRes.rows.map(
      (r) =>
        `${String(r.table_name)}.${String(r.column_name)} → ${String(r.foreign_table)}.${String(r.foreign_column)}` +
        ` (on update ${String(r.update_rule)}, on delete ${String(r.delete_rule)})`
    )
    check(
      'S3-foreign-keys-captured',
      true,
      `外键 ${String(fks.length)} 条${fks.length > 0 ? `：${fks.join(' | ')}` : '（无）'}`
    )

    // -----------------------------------------------------------------------
    // 4 · 唯一约束与索引
    // -----------------------------------------------------------------------
    const idxRes = await pool.query(
      `select tablename, indexname, indexdef from pg_indexes
        where schemaname='public' and tablename = any($1)
        order by tablename, indexname`,
      [[...BASE_TABLES]]
    )
    const uniqueIdx = idxRes.rows.filter((r) => String(r.indexdef).includes('UNIQUE'))
    check(
      'S4-indexes-captured',
      idxRes.rows.length > 0,
      `索引 ${String(idxRes.rows.length)} 个（其中唯一 ${String(uniqueIdx.length)} 个）` +
        `${uniqueIdx.length > 0 ? `：${uniqueIdx.map((r) => String(r.indexname)).join(', ')}` : ''}`
    )

    // -----------------------------------------------------------------------
    // 5 · 扩展（迁移 10 的 vector(384) 列依赖它）
    // -----------------------------------------------------------------------
    const extRes = await pool.query('select extname, extversion from pg_extension order by extname')
    const hasVector = extRes.rows.some((r) => String(r.extname) === 'vector')
    check(
      'S5-pgvector-present',
      hasVector,
      `扩展：${extRes.rows.map((r) => `${String(r.extname)}@${String(r.extversion)}`).join(', ')}`
    )

    // -----------------------------------------------------------------------
    // 6 · 触发器
    // -----------------------------------------------------------------------
    const trgRes = await pool.query(
      `select event_object_table as tbl, trigger_name, action_timing, event_manipulation
         from information_schema.triggers
        where trigger_schema='public' and event_object_table = any($1)
        order by 1,2`,
      [[...BASE_TABLES]]
    )
    check(
      'S6-triggers-captured',
      true,
      `触发器 ${String(trgRes.rows.length)} 个${trgRes.rows.length > 0 ? `：${trgRes.rows.map((r) => String(r.trigger_name)).join(', ')}` : '（无）'}`
    )

    // -----------------------------------------------------------------------
    // 7 · 总表数（**附带**读数，不是主判据）
    // -----------------------------------------------------------------------
    const totalRes = await pool.query(
      `select count(*)::int as n from information_schema.tables where table_schema='public'`
    )
    console.log(`\n[附带] public 总表数 = ${String(totalRes.rows[0]?.n ?? '?')}（参考值，非主判据）`)

    // -----------------------------------------------------------------------
    // 输出指纹（W1 的实现输入）
    // -----------------------------------------------------------------------
    console.log('\n=== 六张基础表 · 结构指纹 ===')
    for (const t of BASE_TABLES) {
      console.log(`\n-- ${t} --`)
      for (const c of columnsByTable.get(t) ?? []) console.log(`  col  ${c}`)
    }
    console.log('\n=== 外键 ===')
    for (const f of fks) console.log(`  ${f}`)
    console.log('\n=== 索引 ===')
    for (const r of idxRes.rows) console.log(`  ${String(r.indexdef)}`)
    console.log('\n=== 触发器 ===')
    for (const r of trgRes.rows) {
      console.log(`  ${String(r.tbl)}: ${String(r.trigger_name)} ${String(r.action_timing)} ${String(r.event_manipulation)}`)
    }
    console.log('\n=== 扩展 ===')
    for (const r of extRes.rows) console.log(`  ${String(r.extname)}@${String(r.extversion)}`)
  } finally {
    await pool.end()
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n=== 基础表结构指纹: ${checks.length - failed.length}/${checks.length} PASS ===`)
  for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
  if (failed.length > 0) process.exitCode = 1
}

void main()
