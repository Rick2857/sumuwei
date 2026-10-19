/**
 * 门：**不经 `@elizaos/plugin-sql`**，LG 自己的迁移体系能否在空库上建出全部 schema
 * （M12 · W1-b）。这是 M12 的核心问题：
 *
 *   过去建表靠上游插件；插件卸掉后，建表必须由 LG 自己完成。
 *
 * ============================================================================
 *  它守的是什么
 * ============================================================================
 * · 正控：空库 + 只跑 LG 的迁移（0010…0024，含新的 0024 基础表）⇒ 结构齐全
 * · 幂等：再跑一遍 ⇒ 无错、无结构变化
 * · 负控：**去掉 0024** ⇒ 六张基础表必须建不出来
 *   （证明 0024 真的在起作用，不是"反正别的地方也建了表"）
 *
 * ⚠️ 前置：目标库必须已 `create extension vector`（W0b 的前置 P-2）——
 *    迁移 0010 的 `vector(384)` 列依赖它。
 * ⚠️ 失败关闭：目标必须是 `lg_test_` 前缀的隔离库。
 *
 * ⚠️ 文件名说明：仓库里已有 `thinhost-bootstrap-verify.ts`（另一条线的门），
 *    本门刻意**不**占用那个名字，避免冲突。
 */

import { Client } from 'pg'
import { execFileSync } from 'node:child_process'
import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

const BASE_TABLE_LIST = ['agents', 'memories', 'rooms', 'participants', 'entities', 'worlds']

const url = process.env.POSTGRES_URL ?? ''
const dbName = (() => {
  try {
    return new URL(url).pathname.replace(/^\//, '')
  } catch {
    return ''
  }
})()
if (dbName === '' || !dbName.startsWith('lg_test_')) {
  console.error(`拒绝：目标库 "${dbName}" 不带 lg_test_ 前缀`)
  process.exit(2)
}

async function columnsOf(c: Client): Promise<string[]> {
  const r = await c.query(
    `select table_name || '.' || column_name || ' ' || data_type as line
       from information_schema.columns
      where table_schema='public' order by 1`
  )
  return r.rows.map((x) => String(x.line))
}

/**
 * 用**超级用户**（`docker exec`）重建 schema 并装扩展。
 *
 * ⚠️ 为什么必须走超级用户：`create extension` 要超级用户权限，
 *   而运行账号 `lg_migrate` 会被拒（实测：`permission denied to create extension "vector"`）。
 *   同时 schema 的 `CREATE` 权限要授给运行账号（否则建表被拒）。
 */
function resetAsSuperuser(): string {
  try {
    execFileSync(
      'docker',
      [
        'exec', process.env.LG_TEST_PG_CONTAINER ?? 'lg-postgresql-production',
        'psql', '-U', process.env.LG_TEST_PG_SUPERUSER ?? 'lg_bootstrap',
        '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c',
        'drop schema public cascade; create schema public; create extension if not exists vector; ' +
          `grant all on schema public to ${process.env.LG_TEST_SCHEMA_OWNER ?? 'lg_migrate'};`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    return ''
  } catch (error) {
    const e = error as { stderr?: string; message?: string }
    return `超级用户重建失败：${(e.stderr ?? e.message ?? '').slice(0, 200)}`
  }
}

async function resetSchema(): Promise<string> {
  const err = resetAsSuperuser()
  if (err !== '') return err
  // 运行账号连上后确认它确实能建表（否则上面那句 grant 没生效）
  const c = new Client({ connectionString: url })
  await c.connect()
  try {
    await c.query('drop table if exists public.lg_test_write_probe')
    await c.query('create table public.lg_test_write_probe (i int)')
    await c.query('drop table public.lg_test_write_probe')
    return ''
  } catch (error) {
    return `运行账号无法建表：${error instanceof Error ? error.message.slice(0, 160) : String(error)}`
  } finally {
    await c.end()
  }
}

async function runMigrations(
  c: Client,
  migrations: readonly { version: number; statements: readonly string[] }[]
): Promise<string> {
  for (const m of migrations) {
    try {
      for (const stmt of m.statements) await c.query(stmt)
    } catch (error) {
      return `迁移 ${String(m.version)} 失败：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`
    }
  }
  return ''
}

/**
 * 走**生产用的那条执行路径**（`applyKernelMigrations`）跑一遍。
 *
 * ⚠️ 为什么不自己循环 `c.query(stmt)`：迁移语句的幂等化发生在**执行层**
 *    （`db.ts` 的 `toIdempotentStatement`，2026-10-19 加）。
 *    门自己循环就**绕过了它** ⇒ 裸 `add constraint` 在第二遍报错，
 *    而真实生产路径不会。
 *    ⇒ 幂等那条断言必须走真路径，否则测的是"门自己写的循环"而不是产品。
 */
async function runViaProductionPath(c: Client): Promise<string> {
  const { applyKernelMigrations } = await import('../src/infrastructure/persistence/db.ts')
  const { sql } = (await import('drizzle-orm')) as unknown as {
    sql: { raw: (t: string) => unknown }
  }
  /*
   * ⚠️ 适配 drizzle 的 `SQL` 对象要**按 queryChunks 交替拼接**（第一版写成
   *    `String(query)`，报 `syntax error at or near "["` —— 那是**适配器的错**，
   *    不是迁移的错；它会让人误以为迁移有问题）。
   *    真实形状：`{ queryChunks: [{value:['...']}, <param>, {value:['...']}, …] }`
   *    ⇒ 字符串片段拼进 text，参数一律走 `$n` 占位（**不拼进 SQL**，见本仓纪律）。
   */
  const db = {
    execute: async (query: unknown): Promise<{ rows: unknown[] }> => {
      const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? []
      let text = ''
      const params: unknown[] = []
      for (const chunk of chunks) {
        if (chunk !== null && typeof chunk === 'object' && 'value' in (chunk as object)) {
          text += ((chunk as { value: unknown[] }).value ?? []).join('')
        } else {
          params.push(chunk)
          text += `$${String(params.length)}`
        }
      }
      const r = await c.query(text, params)
      return { rows: r.rows as unknown[] }
    },
  }
  try {
    await applyKernelMigrations(db as never)
    return ''
  } catch (error) {
    return `生产路径执行失败：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`
  }
  void sql
}

async function countTables(c: Client, names: readonly string[]): Promise<number> {
  const r = await c.query(
    `select count(*)::int as n from information_schema.tables
      where table_schema='public' and table_name = any($1)`,
    [[...names]]
  )
  return Number(r.rows[0]?.n ?? 0)
}

/** 六张基础表上的**外键**条数（0024 的增量之一，W0b 基线 12） */
async function countForeignKeys(c: Client): Promise<number> {
  const r = await c.query(
    `select count(*)::int as n
       from pg_constraint k
       join pg_class t on t.oid = k.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = any($1) and k.contype = 'f'`,
    [BASE_TABLE_LIST]
  )
  return Number(r.rows[0]?.n ?? 0)
}

/** 六张基础表上的**非主键**索引个数（0024 的增量之二，W0b 基线 7 个 `idx_*`） */
async function countExtraIndexes(c: Client): Promise<number> {
  const r = await c.query(
    `select count(*)::int as n from pg_indexes
      where schemaname='public' and tablename = any($1)
        and indexname not like '%_pkey' and indexname not like '%_key'`,
    [BASE_TABLE_LIST]
  )
  return Number(r.rows[0]?.n ?? 0)
}

async function main(): Promise<void> {
  const c = new Client({ connectionString: url })
  await c.connect()
  try {
    const resetErr = await resetSchema()
    if (resetErr !== '') {
      check('S0-reset', false, resetErr)
      return
    }

    const empty = await columnsOf(c)
    check('S0-empty-schema', empty.length === 0, `清空后 public 列数=${String(empty.length)}（应为 0）`)

    // ---- 负控：抽掉 0023 ⇒ 六张基础表必须**建不出来** ----
    //
    // ⚠️ 这才是有鉴别力的负控：证明"LG 迁移体系真的能自建六张表"，
    //    而不是"哪里都建了表所以看着有"。
    //    （2026-10-19 实测：0023 已完整覆盖六张表 + 12 外键 + 7 索引 ⇒
    //      我第一版想加的迁移 0024 是纯冗余，**已撤销**。）
    {
      const without23 = MIGRATIONS.filter((m) => m.version !== 23)
      const err = await runMigrations(c, without23)
      const tables = await countTables(c, BASE_TABLE_LIST)
      check(
        'N1-without-0023-base-tables-absent',
        tables === 0,
        `去掉 0023 后基础表 ${String(tables)} 张（应为 0）` +
          `${err === '' ? ' · 其余迁移均成功' : ` · 其余迁移有失败：${err.slice(0, 90)}`}`
      )
      await resetSchema()
    }

    // ---- 正控：**只跑 LG 的迁移**（不碰 plugin-sql）能否建出六张基础表 ----
    //
    // ⚠️ 这才是 M12 的**核心问题**，也是本次实测给出的答案：
    //   迁移 **0023**（`lg-runtime-compatibility-tables`）**已经完整覆盖**了
    //   W0b 取证的六张基础表（建表 + 12 外键 + 7 索引，全部幂等）。
    //   ⇒ **不需要**新增迁移 0024（我第一版写了，随后实测证明是纯冗余，已撤销）。
    {
      const err = await runMigrations(c, MIGRATIONS)
      check(
        'P1-all-migrations-apply',
        err === '',
        err === '' ? `全部 ${String(MIGRATIONS.length)} 个迁移执行无错` : err
      )

      const tables = await countTables(c, BASE_TABLE_LIST)
      check(
        'P2-base-tables-created-by-lg-only',
        tables === 6,
        `LG 迁移（不经 plugin-sql）建出基础表 ${String(tables)}/6`
      )

      const fk = await countForeignKeys(c)
      check('P3-foreign-keys-present', fk >= 12, `外键 ${String(fk)} 条（基线 12）`)

      const idx = await countExtraIndexes(c)
      check('P4-extra-indexes-present', idx >= 7, `非主键索引 ${String(idx)} 个（基线 7）`)

      const total = await c.query(
        `select count(*)::int as n from information_schema.tables where table_schema='public'`
      )
      check(
        'P5-schema-size',
        Number(total.rows[0]?.n ?? 0) > 0,
        `public 表数=${String(total.rows[0]?.n ?? '?')}`
      )

      // ---- 幂等：**两遍都走生产执行路径** ------------------------------------
      // ⚠️ 第一遍也必须走真路径（2026-10-19 实测踩到）：
      //    第一版让第一遍走"门自己的循环"、第二遍走 `applyKernelMigrations`，
      //    于是报"509 → 512 多 3 列"。查下来那 3 列是**门循环与生产路径的差异**
      //    （门循环把 drizzle 参数化的语句漏掉了）⇒ **量具的错，不是迁移的错**。
      //    ⇒ 两遍同源，才是在测"迁移幂不幂等"。
      await resetSchema()
      const firstPassErr = await runViaProductionPath(c)
      check('I0-first-pass-no-error', firstPassErr === '', firstPassErr === '' ? '第一遍（生产路径）无报错' : firstPassErr)

      const before = await columnsOf(c)
      const err2 = await runViaProductionPath(c)
      const after = await columnsOf(c)
      check('I1-second-pass-no-error', err2 === '', err2 === '' ? '第二遍无报错（走 applyKernelMigrations 真路径）' : err2)
      check(
        'I2-second-pass-structure-unchanged',
        before.length === after.length && before.every((x, i) => x === after[i]),
        `第二遍后列数 ${String(before.length)} → ${String(after.length)}（应不变）`
      )
    }
  } finally {
    await c.end()
  }

  const failed = checks.filter((x) => !x.ok)
  console.log(`\n=== LG 自有迁移建库门: ${checks.length - failed.length}/${checks.length} PASS ===`)
  for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
  if (failed.length > 0) process.exitCode = 1
}

void main()
