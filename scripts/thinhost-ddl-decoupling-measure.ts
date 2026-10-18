/**
 * 配对测量：同一进程内、同一沙箱、同一路径，比较"跑 DDL"与"跳过 DDL"的代价。
 *
 * ⚠️ 为什么要单独写这个门（而不是直接看服务器重启读数）：
 *    服务器重启读数会把 systemd、QQ 外壳、编码器、网络全部搅进来。
 *    这里只隔离出**本改动唯一改变的那一步**（`runPluginMigrations`），
 *    所以两次读数的差值**就是**这次改动的收益，不含其它噪声。
 *
 * 用法：`--phase=warm` 建库并写盘 → `--phase=with-ddl`（强制跑 DDL）→ `--phase=skip-ddl`（走新逻辑）
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import type { Plugin } from '@elizaos/core'

const IDENTITY_KEYS = [
  'LG_PG_EXPECT_DATABASE',
  'LG_PG_EXPECT_USER',
  'LG_PG_EXPECT_DATABASE_PREFIX',
  'LG_PG_EXPECT_USER_PREFIX',
  'LG_PRODUCTION_POSTGRES_URL',
  'LG_TEST_DATABASE_PREFIX',
] as const

const DIR = join(tmpdir(), 'thinhost-ddl-measure')
const HANDOFF = join(DIR, 'handoff.json')
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=warm').slice(
  '--phase='.length
)

// ⚠️ 后端**由环境决定**，不再硬编码 pglite。
//    第一版写死 `CHARACTER_DB_BACKEND='pglite'` + `POSTGRES_URL=''`，
//    于是即使调用方 export 了隔离 PostgreSQL 的 URL，这个脚本也照样
//    连 PGlite 内存库（服务器实测：读数是 `PgliteDatabaseAdapter` 56 张表，
//    而目标 PG 库里一张表都没有）⇒ 后续"薄宿主装配"门必然失败，
//    而失败原因看起来像薄宿主的 bug，其实是**隔离根本没生效**。
const wantPostgres = (process.env.POSTGRES_URL ?? '') !== ''
if (wantPostgres) {
  process.env.CHARACTER_DB_BACKEND = 'postgres'
  process.env.PGLITE_DATA_DIR = ''
  delete process.env.PROJECT_LG_SANDBOX
  console.log(`[measure] 后端 = postgres（隔离库 ${process.env.LG_PG_EXPECT_DATABASE ?? '(未声明)'}）`)
} else {
  process.env.PGLITE_DATA_DIR = DIR
  process.env.PROJECT_LG_SANDBOX = DIR
  process.env.CHARACTER_DB_BACKEND = 'pglite'
  process.env.POSTGRES_URL = ''
  console.log(`[measure] 后端 = pglite（隔离目录 ${DIR}）`)
}
for (const k of IDENTITY_KEYS) {
  if (wantPostgres) continue
  process.env[k] = ''
}

const { character } = await import('../src/character/index.ts')
const { initDatabase, allowKernelMigration } = await import('../src/db/index.ts')
const { closeDatabaseConnection } = await import(
  '../src/infrastructure/persistence/runtime-shutdown.ts'
)

function newRuntime(): { runtime: AgentRuntime; count: () => number } {
  // ⚠️ settings 也必须跟随后端 —— plugin-sql 读的是 runtime settings，
  //    不回落 process.env（`src/main.ts:1037-1044` 记过这个坑）。
  const runtimeSettings = wantPostgres
    ? { POSTGRES_URL: process.env.POSTGRES_URL ?? '', CHARACTER_DB_BACKEND: 'postgres' }
    : { PGLITE_DATA_DIR: DIR, CHARACTER_DB_BACKEND: 'pglite' }
  const runtime = new AgentRuntime({
    character: character as never,
    plugins: [],
    conversationLength: 10,
    settings: runtimeSettings,
  })
  let n = 0
  const original = runtime.runPluginMigrations.bind(runtime)
  ;(runtime as unknown as { runPluginMigrations: () => Promise<void> }).runPluginMigrations =
    async () => {
      n += 1
      await original()
    }
  return { runtime, count: () => n }
}

interface Reading {
  phase: string
  ddlRuns: number
  wallMs: number
  rssMB: number
  maxRssMB: number
  tables: number
}
const out: Reading = { phase: PHASE, ddlRuns: 0, wallMs: 0, rssMB: 0, maxRssMB: 0, tables: 0 }

if (PHASE === 'warm') {
  // 建库（这次**要**跑 DDL），把基线读数写盘
  // ⚠️ 必须显式放行 Kernel 迁移，否则 `initDatabase` 会**正确地**拒绝
  //    （kernel_migration_pending）。这是既有纪律，不是故障。
  allowKernelMigration()
  const { runtime, count } = newRuntime()
  try {
    const t0 = Date.now()
    const ready = await initDatabase(runtime, sqlPlugin as Plugin)
    const m = process.memoryUsage()
    const prev = existsSync(HANDOFF) ? (JSON.parse(readFileSync(HANDOFF, 'utf8')) as Reading[]) : []
    const rec: Reading = {
      phase: 'warm(fresh, runs ddl)',
      ddlRuns: count(),
      wallMs: Date.now() - t0,
      rssMB: +(m.rss / 1048576).toFixed(1),
      maxRssMB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
      tables: ready.tables.length,
    }
    writeFileSync(HANDOFF, JSON.stringify([...prev, rec], null, 2))
    console.log(JSON.stringify(rec, null, 2))
  } finally {
    await closeDatabaseConnection(runtime)
  }
} else if (PHASE === 'forced') {
  // ⚠️ 第一版这里想用"另一个全新目录"当 with-ddl 对照，**那是假的**：
  //    `@elizaos/plugin-sql` 的连接池是进程级单例，换 PGLITE_DATA_DIR 拿到的
  //    仍是同一个已建好的库 ⇒ 实测 `ddlRuns=0 / tables=56 / 235ms`，
  //    与 warm 的 2172ms 对不上（表早就在了）。教训记在此，别再犯。
  //
  // 正确做法：就在**这个已就绪的进程**里，把 initDatabase 内部那一步的代价
  // 直接量出来 —— 即"再手动跑一次 runPluginMigrations 要多久 / 要多少内存"。
  // 这是同一进程、同一连接、同一份数据上的 A/B，差值就是那一步的净成本。
  const { runtime, count } = newRuntime()
  try {
    // 先量"新逻辑"：initDatabase 应跳过 DDL
    const tSkip = Date.now()
    const ready = await initDatabase(runtime, sqlPlugin as Plugin)
    const skipMs = Date.now() - tSkip
    const skipDdl = count()
    const rssAfterSkip = process.memoryUsage().rss

    // 再量"旧逻辑"：显式跑一次 runPluginMigrations（= 改动前每次启动都会做的那一步）
    const tRun = Date.now()
    await runtime.runPluginMigrations()
    const runMs = Date.now() - tRun
    const rssAfterRun = process.memoryUsage().rss

    const rec: Reading = {
      phase: 'forced(A/B same process)',
      ddlRuns: skipDdl + 1,
      wallMs: runMs - skipMs,
      rssMB: +((rssAfterRun - rssAfterSkip) / 1048576).toFixed(1),
      maxRssMB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
      tables: ready.tables.length,
    }
    const prev = JSON.parse(readFileSync(HANDOFF, 'utf8')) as Reading[]
    writeFileSync(HANDOFF, JSON.stringify([...prev, rec], null, 2))
    console.log(
      JSON.stringify(
        {
          skipBranch: { ddlRuns: skipDdl, wallMs: skipMs, rssMB: +(rssAfterSkip / 1048576).toFixed(1) },
          forcedDdlStep: { wallMs: runMs, rssDeltaMB: rec.rssMB },
          netSavingOfSkippingDdl: { wallMs: runMs - skipMs, rssMB: rec.rssMB },
          tables: ready.tables.length,
        },
        null,
        2
      )
    )
  } finally {
    await closeDatabaseConnection(runtime)
  }
}
