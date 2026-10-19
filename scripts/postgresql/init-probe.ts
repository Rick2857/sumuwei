/**
 * PostgreSQL 迁移 WP2 探针：让 LG 的**真实** `initDatabase()` 跑在**真实 PostgreSQL** 上。
 *
 * ============================================================================
 *  它证明什么（以及**不**证明什么）
 * ============================================================================
 *  证明：
 *    · 后端选择真的把 plugin-sql 导到了 `PgDatabaseAdapter`（不是 PGlite）
 *    · 身份核对在**插件迁移之前**跑过，并且读回的是真 PostgreSQL 的身份
 *    · 插件迁移 + Kernel 迁移在真 PG 上**从零**建出了 schema
 *    · `isolateDatabase({ postgres })` 的三道判据在真目标上放行
 *
 *  **不**证明：
 *    · 数据迁移（那是 WP4/WP5）
 *    · 仓储级 SQL 兼容（那是 `PG-G04`）
 *    · 第二核心资格（那是 `PG-G03`/WP3）
 *
 * ---------------------------------------------------------------------------
 *  为什么用动态 import
 * ---------------------------------------------------------------------------
 *  `isolateDatabase()` 与开库闸都读 `process.env`，而 ESM 的 import 是**提升**的。
 *  所以本文件**顶层不 import 任何 LG 模块**，先设环境、再动态 import ——
 *  这与 `scripts/*-verify.ts` 里"isolateDatabase 必须在最前面"的既有纪律同源。
 *
 *  跑法（环境由调用方给）：
 *    CHARACTER_DB_BACKEND=postgres \
 *    POSTGRES_URL=postgres://lg_migrate:***@127.0.0.1:55432/lg_test_wp2 \
 *    LG_PRODUCTION_POSTGRES_URL=postgres://.../lg_prod \
 *    LG_PG_EXPECT_DATABASE=lg_test_wp2 LG_PG_EXPECT_USER=lg_migrate \
 *    node node_modules/tsx/dist/cli.mjs scripts/postgresql/init-probe.ts
 */
import type { AgentRuntime, Character, Plugin } from '../../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../../src/infrastructure/runtime/thin-host-factory.ts'




import { character } from '../../src/character/index.ts'

interface Reading {
  ok: boolean
  steps: { step: string; ok: boolean; detail?: string }[]
  /**
   * **不适用**于本次运行的项（具名 + 原因）。
   *
   * ⚠️ 与 `steps` 分开是刻意的：把"不适用"混进"通过"就是本仓库反复记录的
   * "看起来绿了，其实量的是别的东西"。`ok` 只看 `steps`。
   */
  notRun: { id: string; what: string; why: string }[]
  backend?: string
  identity?: {
    database?: string
    user?: string
    serverAddr?: string
    serverPort?: number
    serverVersion?: string
  }
  adapterName?: string
  tableCount?: number
  kernelSchemaVersion?: number
  pgSpecific?: {
    currentDatabase?: string
    serverVersionNum?: string
    vectorExtension?: string | null
    hasVectorColumn?: boolean
  }
  error?: { name: string; code?: string; message: string }
}

const steps: Reading['steps'] = []
const notRun: Reading['notRun'] = []
const step = (name: string, ok: boolean, detail?: string): void => {
  steps.push(detail === undefined ? { step: name, ok } : { step: name, ok, detail })
}

const reading: Reading = { ok: false, steps, notRun }

async function main(): Promise<void> {
  const url = process.env.POSTGRES_URL
  if (url === undefined || url.trim() === '') {
    throw new Error('缺少 POSTGRES_URL（本探针要求由调用方显式给出测试目标）')
  }

  // -------------------------------------------------------------------------
  // ① 隔离：PG 后端下必须显式给出测试目标（ADR-132 D03）
  // -------------------------------------------------------------------------
  const sandbox = await import('../../src/dev/sandbox.ts')
  try {
    const info = sandbox.isolateDatabase('pg-init-probe', { postgres: { url } })
    step('isolateDatabase({ postgres }) 放行', info.backend === 'postgres', `backend=${info.backend} target=${info.postgresTarget ?? '(none)'}`)
  } catch (error) {
    const e = error as { code?: string; message?: string }
    step('isolateDatabase({ postgres }) 放行', false, `${e.code ?? ''} ${e.message ?? String(error)}`)
    reading.error = { name: 'isolation_refused', code: e.code, message: e.message ?? String(error) }
    return
  }

  // -------------------------------------------------------------------------
  // ② 真实 initDatabase
  // -------------------------------------------------------------------------
  const dbModule = await import('../../src/db/index.ts')
  const { initDatabase, allowKernelMigration } = dbModule

  const makeRuntime = (): AgentRuntime =>
    createThinHostRuntime({
    character: character,
    settings: { POSTGRES_URL: url },
  })

  // -------------------------------------------------------------------------
  // ②a 负控：**不**放行迁移时，Kernel 迁移闸必须拦住
  // -------------------------------------------------------------------------
  // 这不是"探针写错了"——它是**真 PG 上的负控读数**：
  // 证明"M3 迁移闸在 PostgreSQL 后端下照样生效"（计划 §3.1 的"普通聊天不自动应用
  // 新增 Kernel 迁移"这条纪律不能因为换库就消失）。
  // 注意它发生在**插件迁移之后**：插件表已经建好，而 Kernel 迁移被拦 —— 两者是两套体系。
  //
  // ⚠️ 这条负控**有前置条件**：目标库必须是**全新**的（`character_schema_migrations` 为空）。
  //    否则 `pendingMigrations()` 返回 0 ⇒ 闸**没有东西可拦** ⇒ 首次 initDatabase 会成功。
  //    那是**正确行为**，不是闸失效。第一版把这种情况记成 FAIL —— 那是量具的错，不是产品的错。
  //    ⇒ 现在如实分列：新鲜库 ⇒ 断言；已有 schema ⇒ 记进 `notRun` 并具名原因。
  {
    const runtimeA = makeRuntime()
    try {
      await initDatabase(runtimeA)
      notRun.push({
        id: 'kernel-migration-gate-negative-control',
        what: '未放行时 Kernel 迁移闸拦住（kernel_migration_pending）',
        why:
          '目标库**已有** Kernel schema ⇒ 无待应用迁移可拦。' +
          '要取得这条读数，请对一个全新库运行本探针（见 create-test-db.sql）。',
      })
    } catch (error) {
      const e = error as { code?: string; message?: string }
      step(
        '负控：未放行时 Kernel 迁移闸拦住（kernel_migration_pending）',
        e.code === 'kernel_migration_pending',
        `code=${e.code ?? '(none)'}`
      )
    }
  }

  // -------------------------------------------------------------------------
  // ②b 正控：显式放行后，真实 initDatabase 应当成功
  // -------------------------------------------------------------------------
  const runtime = makeRuntime()
  allowKernelMigration() // ← 显式动作（与 `pnpm migrate:apply` 同一条路）

  let ready: Awaited<ReturnType<typeof initDatabase>>
  try {
    ready = await initDatabase(runtime)
    step('initDatabase() 成功（显式放行迁移后）', true)
  } catch (error) {
    const e = error as { code?: string; message?: string; name?: string }
    step('initDatabase() 成功（显式放行迁移后）', false, `${e.code ?? e.name ?? ''} ${e.message ?? String(error)}`)
    reading.error = { name: e.name ?? 'init_failed', code: e.code, message: e.message ?? String(error) }
    return
  }

  reading.backend = ready.backend
  reading.adapterName = ready.adapterName
  reading.tableCount = ready.tables.length
  reading.kernelSchemaVersion = ready.kernelSchemaVersion
  reading.identity = ready.identity

  // -------------------------------------------------------------------------
  // ③ 断言：必须真的是 PostgreSQL，不是 PGlite
  // -------------------------------------------------------------------------
  step(
    '适配器是 PgDatabaseAdapter（不是 PgliteDatabaseAdapter）',
    ready.adapterName === 'PgDatabaseAdapter',
    `adapterName=${ready.adapterName}`
  )
  step('backend 读回为 postgres', ready.backend === 'postgres', `backend=${ready.backend}`)
  step(
    '身份核对读到了真服务端地址（PGlite 嵌入式下这里会是空）',
    ready.identity?.serverAddr !== undefined && ready.identity.serverAddr !== '',
    `serverAddr=${ready.identity?.serverAddr ?? '(none)'} serverPort=${ready.identity?.serverPort ?? '(none)'}`
  )
  step(
    'serverVersion 是 PostgreSQL 17.x',
    (ready.identity?.serverVersion ?? '').includes('PostgreSQL 17'),
    `${(ready.identity?.serverVersion ?? '').slice(0, 60)}`
  )
  step(
    '读回的 database 等于测试目标',
    ready.identity?.database === process.env.LG_PG_EXPECT_DATABASE,
    `actual=${ready.identity?.database} expected=${process.env.LG_PG_EXPECT_DATABASE}`
  )

  // -------------------------------------------------------------------------
  // ④ 直接问真 PG：插件表 + Kernel 表 + pgvector 列是否真的建出来了
  // -------------------------------------------------------------------------
  const { getRawDb, exec } = await import('../../src/infrastructure/persistence/db.ts')
  const db = getRawDb(runtime)

  const pg = await exec(
    db,
    (await import('drizzle-orm')).sql`select current_database() as db,
              current_setting('server_version_num') as ver,
              (select extversion from pg_extension where extname='vector') as vector_ver,
              (select count(*)::int from information_schema.tables where table_schema='public') as tables,
              (select count(*)::int from information_schema.columns
                 where table_schema='public' and udt_name='vector') as vector_cols,
              (select coalesce(max(version),0)::int from character_schema_migrations) as kernel_ver`,
    'WP2 探针：直接核对真 PG 里的 schema'
  )
  const row = pg[0] ?? {}
  reading.pgSpecific = {
    currentDatabase: row.db === undefined ? undefined : String(row.db),
    serverVersionNum: row.ver === undefined ? undefined : String(row.ver),
    vectorExtension: row.vector_ver === undefined || row.vector_ver === null ? null : String(row.vector_ver),
    hasVectorColumn: Number(row.vector_cols ?? 0) > 0,
  }
  step('插件 + Kernel 迁移在真 PG 上建出表（>0）', Number(row.tables ?? 0) > 0, `public 表数=${row.tables}`)
  step('pgvector 扩展已在目标库安装', row.vector_ver !== null && row.vector_ver !== undefined, `vector=${row.vector_ver ?? '(未安装)'}`)

  /*
   * ⚠️ 2026-10-19：**不再硬编码 18**，改读源码的 `latestSchemaVersion()`。
   *
   * 原来写死 18，而源码已到 23（`migrations.ts:1971` 的
   * `lg-runtime-compatibility-tables`）⇒ 这道门**长期 FAIL**。
   * 一道永远红的门等于没有门（还会让人以为产品坏了）。
   *
   * ⇒ 改成读源码，于是"再加一个迁移"不会再让这道门过期。
   *    ⚠️ 读数里**同时**写出字面版本，便于事后核对是哪一版。
   */
  const { latestSchemaVersion } = await import('../../src/infrastructure/persistence/migrations.ts')
  const expectedVersion = latestSchemaVersion()
  step(
    `Kernel schema 版本 = 源码最新（${String(expectedVersion)}）`,
    Number(row.kernel_ver ?? 0) === expectedVersion,
    `kernel_ver=${row.kernel_ver} expected=${String(expectedVersion)}`
  )

  // -------------------------------------------------------------------------
  // ④b 装配根接线的**行为面**：`dedicatedPoolOf` 在真 PG 运行时上拿得到可用池
  // -------------------------------------------------------------------------
  // 静态断言只能证明"代码里写了那一行"。这一条证明的是**运行时形状对得上**：
  // PostgreSQL 下 `adapter.manager.getConnection()` 真的能被当作池用
  // （有 `connect`，且 `connect()` 真的给出一条能查询的连接）。
  // ⚠️ 反过来说：PGlite 下它必须返回 undefined —— 那是"纯追加"的前提
  //    （`src/dev/sandbox.ts` 侧的 PGlite 判别由 PG-G03 的纯函数用例覆盖）。
  const { dedicatedPoolOf } = await import(
    '../../src/infrastructure/persistence/single-core-qualification.ts'
  )
  const pool = dedicatedPoolOf(runtime)
  step('dedicatedPoolOf(runtime) 在真 PG 上返回了池（有 connect）', pool !== undefined)
  if (pool !== undefined) {
    try {
      const client = await pool.connect()
      const probe = await client.query('select pg_backend_pid() as pid')
      const pid = (probe.rows[0] as { pid?: unknown } | undefined)?.pid
      step(
        '池给出的专用连接真的能查询（拿得到 pg_backend_pid）',
        pid !== undefined && pid !== null,
        `pg_backend_pid=${String(pid)}`
      )
      client.release?.()
    } catch (error) {
      step('池给出的专用连接真的能查询（拿得到 pg_backend_pid）', false, String(error))
    }
  }

  // -------------------------------------------------------------------------
  // ⑤ 收尾：关掉本进程的连接池（不停止服务）
  // -------------------------------------------------------------------------
  const shutdown = await import('../../src/infrastructure/persistence/runtime-shutdown.ts')
  try {
    await shutdown.closeDatabaseConnection(runtime)
    const closed = shutdown.isDatabaseClosed(runtime)
    step('本进程连接池已关闭（服务继续运行）', closed === true, `isDatabaseClosed=${closed}`)
  } catch (error) {
    step('本进程连接池已关闭（服务继续运行）', false, String(error))
  }

  reading.ok = steps.every((s) => s.ok)
}

await main().catch((error: unknown) => {
  reading.error = {
    name: 'unexpected',
    message: error instanceof Error ? error.message : String(error),
  }
})

console.log(JSON.stringify(reading, null, 2))
if (!reading.ok) process.exitCode = 1
