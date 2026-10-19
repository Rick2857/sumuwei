/**
 * 门：`BASE_TABLE_DDL` 的**性质**自检（M12 · W1-a，2026-10-19 修订）。
 *
 * ============================================================================
 *  ⚠️ 它测的**不是**"能从空库建出六张表"
 * ============================================================================
 * 实测发现：迁移 **0023**（`lg-runtime-compatibility-tables`）**已经完整覆盖**了
 * 六张基础表（建表 + 12 外键 + 7 索引，全部幂等，且与旧宿主取证的列集合逐表相同）。
 * ⇒ `BASE_TABLE_DDL` 已按裁定**缩成只有外键与索引**（0 条建表），
 *    它在空库上**本来就建不出表**。
 *
 * ⇒ 这道门改为守住它**现在**的性质：
 *   ① 它**不含**建表（那是 0023 的职责，两者不重叠）
 *   ② 它**全是**幂等形式（`create index if not exists` / `DO` 块判存在性）
 *   ③ 放在**已建好六张表**的库上：第一遍无错、第二遍无错且结构零变化
 *
 * 📌 保留价值：它是"0023 是否仍与旧宿主等价"的**可执行比对物**，不是迁移输入。
 *    删掉就没有了这个对照基准。
 *
 * ⚠️ 判据纪律（L-QQP-09）：结构比对**不**用"表数相等"（表数对而列/约束/索引不同的库
 *    照样能跑，但行为会漂）；也不用 `conrelid::regclass::text` 比表名（**依赖
 *    search_path**，实测读到 0 条约束 —— 那是量具的错）。
 * ⚠️ 失败关闭：目标必须是 `lg_test_` 前缀的隔离库。
 */

import { Client } from 'pg'
import { BASE_TABLE_DDL } from '../src/infrastructure/persistence/base-tables-ddl.ts'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

const TABLES = ['agents', 'entities', 'memories', 'participants', 'rooms', 'worlds']
const url = process.env.POSTGRES_URL ?? ''
const dbName = (() => {
  try {
    return new URL(url).pathname.replace(/^\//, '')
  } catch {
    return ''
  }
})()

// 失败关闭：只允许隔离测试库
if (dbName === '' || !dbName.startsWith('lg_test_')) {
  console.error(`拒绝：目标库 "${dbName}" 不带 lg_test_ 前缀`)
  process.exit(2)
}

interface Fingerprint {
  columns: string[]
  constraints: string[]
  indexes: string[]
}

async function fingerprint(c: Client): Promise<Fingerprint> {
  const cols = await c.query(
    `select table_name || '.' || column_name || ' ' || data_type ||
            case when is_nullable='NO' then ' NOT NULL' else '' end ||
            coalesce(' DEFAULT ' || column_default, '') as line
       from information_schema.columns
      where table_schema='public' and table_name = any($1)
      order by 1`,
    [TABLES]
  )
  // ⚠️⚠️ **不能用 `conrelid::regclass::text = any($1)`**（实测踩到，读数是 0）：
  //   `regclass::text` 的输出**取决于会话的 search_path** ——
  //   本仓连接下它返回**裸表名**（`memories`），不带 `public.` 前缀；
  //   拿 `public.memories` 去比自然一条都匹配不上
  //   ⇒ 门会报"约束 0 条"，而约束其实建好了（**量具的错，不是产品的错**）。
  // ⇒ 改用**目录表连接**，与 search_path 无关。
  const cons = await c.query(
    `select c.conname || ' ' || pg_get_constraintdef(c.oid) as line
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = any($1)
      order by 1`,
    [TABLES]
  )
  const idx = await c.query(
    `select indexdef as line from pg_indexes
      where schemaname='public' and tablename = any($1)
      order by 1`,
    [TABLES]
  )
  return {
    columns: cols.rows.map((r) => String(r.line)),
    constraints: cons.rows.map((r) => String(r.line)),
    indexes: idx.rows.map((r) => String(r.line)),
  }
}

function diff(a: string[], b: string[]): string[] {
  const setB = new Set(b)
  return a.filter((x) => !setB.has(x))
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 0 · 静态性质：它**不含**建表，且全是幂等形式
  // -------------------------------------------------------------------------
  {
    const hasCreateTable = BASE_TABLE_DDL.some((s) => /^\s*create\s+table/i.test(s))
    check(
      'S0-no-create-table',
      !hasCreateTable,
      hasCreateTable
        ? 'BASE_TABLE_DDL 里还有建表语句 —— 建表归迁移 0023，这里只留外键与索引'
        : `BASE_TABLE_DDL 不含建表（${String(BASE_TABLE_DDL.length)} 条，外键+索引）`
    )

    const nonIdempotent = BASE_TABLE_DDL.filter(
      (s) =>
        !/^\s*(do\s+\$\$|create\s+(unique\s+)?index\s+if\s+not\s+exists)/i.test(s)
    )
    check(
      'S1-all-idempotent-form',
      nonIdempotent.length === 0,
      nonIdempotent.length === 0
        ? '全部语句为幂等形式（DO 块 / create index if not exists）'
        : `非幂等形态 ${String(nonIdempotent.length)} 条：${nonIdempotent.map((s) => s.replace(/\s+/g, ' ').slice(0, 60)).join(' | ')}`
    )

    const doBlocks = BASE_TABLE_DDL.filter((s) => /^\s*do\s+\$\$/i.test(s)).length
    check(
      'S2-shape-counts',
      doBlocks > 0 && doBlocks < BASE_TABLE_DDL.length,
      `DO 块（外键）${String(doBlocks)} 条 · 其余 ${String(BASE_TABLE_DDL.length - doBlocks)} 条为索引`
    )
  }

  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    // -------------------------------------------------------------------------
    // 1 · 前置：六张表必须**已经存在**（由迁移 0023 建出）
    // -------------------------------------------------------------------------
    {
      const before = await fingerprint(client)
      const tablesPresent = TABLES.filter((t) => before.columns.some((c) => c.startsWith(`${t}.`)))
      check(
        'P0-precondition-tables-exist',
        tablesPresent.length === 6,
        `前置：六张基础表已存在 ${String(tablesPresent.length)}/6` +
          `${tablesPresent.length === 6 ? '' : `（缺 ${TABLES.filter((t) => !tablesPresent.includes(t)).join(', ')} —— 请先用 LG 迁移建库）`}`
      )
    }

    const before = await fingerprint(client)

    // -------------------------------------------------------------------------
    // 2 · 正控①：执行全部 DDL（应全部为空操作，无错）
    // -------------------------------------------------------------------------
    let runErr = ''
    try {
      for (const stmt of BASE_TABLE_DDL) await client.query(stmt)
    } catch (error) {
      runErr = error instanceof Error ? error.message : String(error)
    }
    check('P1-first-run-no-error', runErr === '', runErr === '' ? '第一遍无报错（幂等 ⇒ 空操作）' : runErr)

    const after = await fingerprint(client)
    check(
      'P2-first-run-structure-unchanged',
      diff(before.columns, after.columns).length === 0 && diff(before.indexes, after.indexes).length === 0,
      `第一遍后列/索引零变化（该产物是 0023 的对照基准，重复执行不应改结构）`
    )

    // -------------------------------------------------------------------------
    // 3 · 正控② 幂等：再跑一遍，必须无错且结构不变
    // -------------------------------------------------------------------------
    let secondRunError = ''
    try {
      for (const stmt of BASE_TABLE_DDL) await client.query(stmt)
    } catch (error) {
      secondRunError = error instanceof Error ? error.message : String(error)
    }
    check('I1-second-run-no-error', secondRunError === '', secondRunError === '' ? '第二遍无报错' : `第二遍报错：${secondRunError.slice(0, 160)}`)

    const after2 = await fingerprint(client)
    const changed =
      diff(after.columns, after2.columns).length +
      diff(after2.columns, after.columns).length +
      diff(after.constraints, after2.constraints).length +
      diff(after.indexes, after2.indexes).length
    check('I2-second-run-structure-unchanged', changed === 0, `第二遍后结构变化项=${String(changed)}（应为 0）`)

    // -------------------------------------------------------------------------
    // 4 · 负控：去掉一个索引 ⇒ 比对必须报出该差异
    // -------------------------------------------------------------------------
    const partial = await (async (): Promise<Fingerprint> => {
      const c2 = new Client({ connectionString: url })
      await c2.connect()
      try {
        await c2.query('begin')
        await c2.query('drop index if exists idx_participants_user')
        const fp = await fingerprint(c2)
        await c2.query('rollback')
        return fp
      } finally {
        await c2.end()
      }
    })()
    const missing = diff(after.indexes, partial.indexes)
    check(
      'N1-drop-one-index-is-detected',
      missing.length === 1 && missing[0]!.includes('idx_participants_user'),
      `去掉 1 个索引后比对报出 ${String(missing.length)} 条差异：${missing.map((m) => m.slice(0, 60)).join(' | ')}`
    )
  } finally {
    await client.end()
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n=== 基础表 DDL 产物门: ${checks.length - failed.length}/${checks.length} PASS ===`)
  for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
  if (failed.length > 0) process.exitCode = 1
}

void main()
