/**
 * 数据库句柄与迁移执行（基础设施层）。
 *
 * ============================================================================
 *  这是 Kernel 唯一被允许碰 SQL 的地方
 * ============================================================================
 * 依赖方向（plan 第 6 节）：
 *
 *     Runtime / Transport
 *            ↓
 *     Character Application Layer
 *            ↓
 *     Character Domain  ←── 只依赖 interface / type / domain model
 *            ▲
 *            │
 *     Infrastructure implementations
 *
 * 因此 `src/kernel/**` 里**既没有** `import 'drizzle-orm'`，也没有
 * `runtime.adapter` 这种运行时概念。所有 SQL 都收敛在本目录。
 *
 * ⚠️ 写保护闸继承：`getRawDb()` 拿到的是 `plugin-sql` 的底层句柄，
 *    而放行与否由 `src/db/index.ts` 的 `initDatabase()` 决定。
 *    也就是说实验脚本若忘了 `isolateDatabase()`，会在 `initDatabase` 处
 *    就失败，**根本走不到这里** —— 既有三层防护不受影响。
 */

import { sql } from 'drizzle-orm'

import { KernelError, type Timestamp } from '../../kernel/contracts/index.ts'
import { MIGRATIONS, assertMigrationsWellFormed, latestSchemaVersion } from './migrations.ts'
import {
  databaseIdentityError,
  verifyDatabaseIdentityReading,
  type DatabaseIdentityExpectation,
  type DatabaseIdentityReading,
} from './database-backend.ts'

/** plugin-sql 暴露的底层句柄（接口里没有，这是本项目唯一需要断言的地方） */
export interface RawDb {
  execute: (query: unknown) => Promise<unknown>
  /** PGlite 适配器带事务能力；不同驱动可能没有 */
  transaction?: <T>(fn: (tx: RawDb) => Promise<T>) => Promise<T>
}

/** 取底层数据库句柄。所有仓储都从这里进入数据库。 */
export function getRawDb(holder: unknown): RawDb {
  const h = holder as {
    db?: unknown
    adapter?: { db?: RawDb; getDatabase?: () => RawDb | undefined }
  }
  const candidate =
    h.adapter?.db ??
    h.adapter?.getDatabase?.() ??
    (typeof h.db === 'object' && h.db !== null ? (h.db as RawDb) : undefined)

  if (!candidate?.execute) {
    throw new KernelError(
      'persistence_error',
      'no_db_handle',
      '拿不到底层数据库句柄：plugin-sql 尚未注册适配器，或 initDatabase() 还没跑完'
    )
  }
  return candidate
}

/** drizzle 的 execute 在不同驱动下返回形状不同，统一取行数组 */
export function rowsOf(result: unknown): Record<string, unknown>[] {
  const r = (result as { rows?: unknown[] })?.rows ?? result
  return Array.isArray(r) ? (r as Record<string, unknown>[]) : []
}

/** 把任意 DB 错误包成 KernelError(persistence_error)，保留原始信息便于定位 */
export async function exec(
  db: RawDb,
  query: unknown,
  context: string
): Promise<Record<string, unknown>[]> {
  try {
    return rowsOf(await db.execute(query))
  } catch (error) {
    throw new KernelError(
      'persistence_error',
      'query_failed',
      `${context}：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * 行数读取（**只用 `returning` 的结果**，不猜驱动语义）。
 *
 * ⚠️ 有意为之的设计约束：不依赖 `affectedRows`。不同驱动（PGlite / Postgres /
 * drizzle 包装层）对 UPDATE / DELETE 的返回形状并不一致，而"乐观锁到底成功没有"
 * 是必须绝对可靠的判断 —— 猜错一次就是静默的数据覆盖。
 * 因此所有需要知道"改了几行"的地方一律用 `... returning *`，数返回的数组长度。
 */
export async function affectedRows(
  db: RawDb,
  query: unknown,
  context: string
): Promise<number> {
  return (await exec(db, query, context)).length
}

/** 只读单值查询的便捷包装 */
export async function scalar(
  db: RawDb,
  query: unknown,
  column: string,
  context: string
): Promise<unknown> {
  const rows = await exec(db, query, context)
  return rows[0]?.[column]
}

/**
 * 把 `exec` 返回的行数组**收窄**成我们的 row 类型。
 *
 * 这是本项目唯一需要的类型断言点：`exec` 的返回类型刻意是
 * `Record<string, unknown>[]`（数据库不知道我们的表形状），
 * 而收窄只能靠调用方。把它收敛成一个具名函数，
 * 好处是"哪里有断言"一眼可查，而不是散落各处的 `as unknown as X`。
 */
export function asRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows as unknown as T[]
}

/** 取第一行（不存在则 undefined）并收窄类型 */
export function firstRow<T>(rows: Record<string, unknown>[]): T | undefined {
  return rows.length > 0 ? (rows[0] as unknown as T) : undefined
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

/**
 * 把一条迁移语句改写成**幂等**形式。
 *
 * ⚠️ 为什么在**执行层**统一处理，而不是逐条改迁移（2026-10-19 实测）：
 *   PostgreSQL **既不支持** `ADD CONSTRAINT IF NOT EXISTS`，**也不支持**
 *   `CREATE POLICY IF NOT EXISTS`；而既有迁移里有十几条裸的 `add constraint`
 *   与七条裸的 `create policy`。
 *   逐条改必然**漏**（第一版只改了 `v7AttributionCheckStatements`，
 *   门立刻报出漏掉的 `command_type_vocab`；扩到 policy 后同理）。
 *   ⇒ 在这里一处包住，对**所有**迁移与**所有**语句类型生效，新写的迁移也不必记得手包。
 *
 * ⚠️ 这**不改变**正常路径的行为：`applyKernelMigrations()` 会按 `applied` 跳过
 *   已应用迁移，裸语句本来就不会重跑。改它是为了让迁移**自证幂等** ——
 *   门 `thinhost:lgmigration:verify` 的 I1（第二遍必须无错）就是靠它。
 *
 * 判据与 PostgreSQL 自身 `already exists` 的报错口径一致：
 *   · 约束 → `pg_constraint.conname`
 *   · 策略 → `pg_policies`（按 schemaname + tablename + policyname）
 */
function toIdempotentStatement(statement: string): string {
  const trimmed = statement.trim()

  // ---- ① alter table … add constraint ------------------------------------
  const c = /^alter\s+table\s+([^\s]+)\s+add\s+constraint\s+([^\s]+)\s+([\s\S]+)$/i.exec(trimmed)
  if (c !== null) {
    const table = c[1]!.replace(/'/g, "''")
    const name = c[2]!.replace(/'/g, "''")
    return (
      `do $$ begin\n` +
      `  if not exists (select 1 from pg_constraint where conname = '${name}') then\n` +
      `    alter table ${table} add constraint ${c[2]} ${c[3]!.trim()};\n` +
      `  end if;\n` +
      `end $$;`
    )
  }

  // ---- ② create policy <name> on <table> … --------------------------------
  const p = /^create\s+policy\s+([^\s]+)\s+on\s+([^\s]+)\s+([\s\S]+)$/i.exec(trimmed)
  if (p !== null) {
    const policy = p[1]!.replace(/'/g, "''")
    const table = p[2]!
    const bare = table.replace(/^public\./i, '')
    return (
      `do $$ begin\n` +
      `  if not exists (\n` +
      `    select 1 from pg_policies\n` +
      `     where schemaname = 'public' and tablename = '${bare}' and policyname = '${policy}'\n` +
      `  ) then\n` +
      `    ${trimmed};\n` +
      `  end if;\n` +
      `end $$;`
    )
  }

  return statement
}

const MIGRATION_TABLE = `create table if not exists character_schema_migrations (
  version     integer primary key,
  name        text    not null,
  applied_at  bigint  not null
)`

export interface MigrationReport {
  fromVersion: number
  toVersion: number
  applied: { version: number; name: string }[]
  skipped: number
}

/**
 * 执行未应用的迁移。
 *
 * 幂等：已应用的版本会被跳过。整个流程在**一个事务**里（若驱动支持），
 * 因此"迁移跑到一半失败"不会留下半个 schema。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 生产库的迁移由主程序**显式**放行（`--migrate --apply`）
 * ---------------------------------------------------------------------------
 * 这里不做"要不要迁移"的判断 —— 那是调用方（`src/db/index.ts` 与主程序）的事。
 * 本函数只负责"跑，并且跑得原子"。
 */
export async function applyKernelMigrations(db: RawDb): Promise<MigrationReport> {
  assertMigrationsWellFormed()

  const run = async (target: RawDb): Promise<MigrationReport> => {
    await exec(target, sql.raw(MIGRATION_TABLE), '创建迁移表')

    const appliedRows = await exec(
      target,
      sql`select version from character_schema_migrations order by version`,
      '读取已应用迁移'
    )
    const applied = new Set(appliedRows.map((r) => Number(r.version)))
    const fromVersion = applied.size === 0 ? 0 : Math.max(...applied)

    const newlyApplied: { version: number; name: string }[] = []
    let skipped = 0

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        skipped += 1
        continue
      }
      for (const statement of migration.statements) {
        await exec(
          target,
          sql.raw(toIdempotentStatement(statement)),
          `迁移 ${migration.version}（${migration.name}）执行失败`
        )
      }
      await exec(
        target,
        sql`insert into character_schema_migrations (version, name, applied_at)
            values (${migration.version}, ${migration.name}, ${Date.now()})`,
        `登记迁移 ${migration.version}`
      )
      newlyApplied.push({ version: migration.version, name: migration.name })
    }

    return {
      fromVersion,
      toVersion: latestSchemaVersion(),
      applied: newlyApplied,
      skipped,
    }
  }

  // PGlite 支持事务：整批迁移原子完成。不支持的驱动退化为逐条执行（仍然幂等）。
  if (typeof db.transaction === 'function') {
    return db.transaction(async (tx) => run(tx))
  }
  return run(db)
}

/** 当前 schema 版本（未建表时返回 0） */
export async function currentSchemaVersion(db: RawDb): Promise<number> {
  try {
    const rows = await exec(
      db,
      sql`select coalesce(max(version), 0) as v from character_schema_migrations`,
      '读取 schema 版本'
    )
    return Number(rows[0]?.v ?? 0)
  } catch {
    return 0
  }
}

/**
 * 还没被应用的迁移（升序）。
 *
 * ⚠️ 这个函数存在的理由是"**升级前必须能先看清楚要改什么**"。
 *
 * 实测踩到过的事故：迁移 0003 给 `character_definitions` 加了
 * `definition_json`，而已存在的那一行不会因此拥有它 ——
 * 结果是真实库一升级，**每条命令都在启动时失败**（`seed_definition_json_missing`），
 * 而当时**没有任何机会事先看到"这次迁移会动到她的 Seed 行"**。
 *
 * 有了它，`--migrate` 可以先打印出待应用的清单（dry-run），
 * 人看过再决定 `--apply`。
 */
export async function pendingMigrations(
  db: RawDb
): Promise<{ version: number; name: string; statements: number }[]> {
  let applied = new Set<number>()
  try {
    const rows = await exec(
      db,
      sql`select version from character_schema_migrations order by version`,
      '读取已应用迁移（探测待应用清单）'
    )
    applied = new Set(rows.map((r) => Number(r.version)))
  } catch {
    // 迁移表都还没有 → 全部待应用
    applied = new Set()
  }
  return MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => ({
    version: m.version,
    name: m.name,
    statements: m.statements.length,
  }))
}

/** 在事务里执行一段工作（驱动不支持时直接执行，靠语句自身保证原子性） */
export async function inTransaction<T>(
  db: RawDb,
  work: (tx: RawDb) => Promise<T>
): Promise<T> {
  if (typeof db.transaction !== 'function') return work(db)
  return db.transaction(work)
}

// ---------------------------------------------------------------------------
// PostgreSQL 目标身份核对（WP1 / ADR-132 `D02`、`INV-DB-09` 设计）
// ---------------------------------------------------------------------------

/**
 * 读回**实际**连接身份。全部来自 SQL，不来自配置。
 *
 * ⚠️ PGlite（嵌入式）与真 PostgreSQL 都能回答这几条；差别只在
 *    `inet_server_addr()` / `inet_server_port()` 在嵌入式下可能为空。
 *    因此这里**不**把"读不到"当成"错误"，而是**如实记 null**，
 *    由调用方的期望值决定它算不算不符（失败关闭在期望那一侧，不在这里猜）。
 */
export async function readDatabaseIdentity(db: RawDb): Promise<DatabaseIdentityReading> {
  const row = firstRow<{
    database: unknown
    user: unknown
    addr: unknown
    port: unknown
    version: unknown
  }>(
    await exec(
      db,
      sql`select current_database() as database,
                 current_user       as user,
                 inet_server_addr()::text as addr,
                 inet_server_port()::int  as port,
                 version()          as version`,
      '读回数据库身份'
    )
  )
  const asText = (v: unknown): string | undefined =>
    v === null || v === undefined ? undefined : String(v)
  const port = row?.port
  return {
    database: asText(row?.database),
    user: asText(row?.user),
    serverAddr: asText(row?.addr),
    serverPort: port === null || port === undefined ? undefined : Number(port),
    serverVersion: asText(row?.version),
  }
}

/**
 * 连接后核对身份，不符则**抛** `KernelError(persistence_error / db_identity_mismatch)`。
 *
 * 调用位置是刻意的：在 `registerPlugin` 之后（那时才有句柄）、
 * 在 `runPluginMigrations()` **之前** —— 也就是"插件迁移、建档和任何业务写入之前"。
 *
 * ⚠️ 期望值的形状见 `DatabaseIdentityExpectation`：**未给的维度不判**。
 *    一条期望都不给时判不符（`ok=false`）⇒ 会抛。这是有意的：
 *    身份核对必须有东西可核，否则它只是一句好听的话。
 */
export async function verifyDatabaseIdentity(
  db: RawDb,
  expectation: DatabaseIdentityExpectation
): Promise<DatabaseIdentityReading> {
  const reading = await readDatabaseIdentity(db)
  const verdict = verifyDatabaseIdentityReading(reading, expectation)
  if (!verdict.ok) throw databaseIdentityError(verdict)
  return reading
}

export const nowTs = (): Timestamp => Date.now()
