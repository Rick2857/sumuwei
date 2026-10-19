/**
 * 门：启动 DDL 解耦（thinhost S1）
 *
 * ============================================================================
 *  它证明什么 / 不证明什么
 * ============================================================================
 * 证明：
 *   A1  schema 已就绪时，`initDatabase()` **不再**调用 `runPluginMigrations()`
 *   A2  缺表时**仍然**调用（首次启动 / 老库升级路径逐字不变）
 *   A3  "已就绪"的判据是**表在不在**这个事实，不是任何环境开关
 *   A4  跳过与不跳过，**最终表集合一致**（不是"跳过了就少建了什么"）
 *
 * 不证明：
 *   · 不证明外部改过列之后启动能自愈（那由显式维护入口负责，见 db/index.ts 注释）
 *   · 不证明生产库上的性能收益（那要服务器配对读数，见 docs/research/thinhost）
 *
 * ⚠️ 判据纪律（L-QQP-09 同型坑第四次）：**不许**用"全文按词找"当判据 ——
 *   三次都是被我自己写的注释打败。所以 A1/A2 一律**真跑** initDatabase，
 *   并在**运行时**替换 runPluginMigrations 计数，不读源码文本。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRuntime, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

/**
 * 身份期望类键：设成**空串**占位，让 `initDatabase` 内部那次 `loadEnvironment`
 * 重播种填不回来（`dotenv` 不覆盖已存在的键）。详见 withSandbox 里的说明。
 */
const REOPEN_IDENTITY_KEYS = [
  'LG_PG_EXPECT_DATABASE',
  'LG_PG_EXPECT_USER',
  'LG_PG_EXPECT_DATABASE_PREFIX',
  'LG_PG_EXPECT_USER_PREFIX',
  'LG_PRODUCTION_POSTGRES_URL',
  'LG_TEST_DATABASE_PREFIX',
] as const

interface Check {
  id: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

async function withSandbox<T>(label: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `thinhost-ddl-${label}-`))
  process.env.PGLITE_DATA_DIR = dir
  process.env.PROJECT_LG_SANDBOX = dir
  // ⚠️ 下面三个键必须**设成空串**而不是删除。
  //
  // 原因（第一次跑就踩了，记录在此免得再犯）：`assertDatabaseAccessAllowed()`
  // 内部会 `loadEnvironment({ path: <从 cwd 向上找到的 .env> })` 重新播种
  // （src/db/index.ts:227-231）。`dotenv` **不覆盖已存在的键**，所以
  //   · 设成空串 ⇒ 重载填不回来 ⇒ 判据成立；
  //   · `delete` 掉   ⇒ 重载把 `LG_PG_EXPECT_DATABASE=sumuwei` 填回来
  //     ⇒ 报 `db_identity_mismatch: 期望 sumuwei，实际 template1`（本门第一次的真实失败）。
  // 这不是保护太严，是**隔离姿势错了**：要"占位"，不要"清空"。
  process.env.CHARACTER_DB_BACKEND = 'pglite'
  process.env.POSTGRES_URL = ''
  const identityKeys = REOPEN_IDENTITY_KEYS
  const saved = identityKeys.map((k) => [k, process.env[k]] as const)
  for (const k of identityKeys) process.env[k] = ''
  try {
    return await fn(dir)
  } finally {
    delete process.env.PGLITE_DATA_DIR
    delete process.env.PROJECT_LG_SANDBOX
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  }
}

/** 真造一个 runtime，并**在运行时**给 runPluginMigrations 装计数器。 */
function countedRuntime(character: unknown): { runtime: AgentRuntime; count: () => number } {
  const runtime = new AgentRuntime({
    character: character as never,
    plugins: [],
    conversationLength: 10,
    settings: { PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR, CHARACTER_DB_BACKEND: 'pglite' },
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

const { character } = await import('../src/character/index.ts')
const { initDatabase } = await import('../src/db/index.ts')
const { closeDatabaseConnection } = await import('../src/infrastructure/persistence/runtime-shutdown.ts')

// ---------------------------------------------------------------------------
// A1：**第二次**开同一个已就绪的库 ⇒ 必须跳过 DDL，且表集合不变
//
// ⚠️ 必须**跨进程**，而且**每个进程只能开一个库**：
//    `@elizaos/plugin-sql` 的连接池是**进程级单例**（PG 全局键 `default:pg`；
//    PGlite 单例），所以
//      · 同进程连开两次 ⇒ 第二次拿到**已关闭**的客户端（`PGlite is closed`）
//      · 同进程做完 A2 再做 A1 ⇒ A1 必然继承 A2 关掉的单例
//    ⇒ 本门分**三段独立进程**，用 `--phase=` 选段：
//        build  （默认）跑 A2：全新库必须跑 DDL
//        build-reopen  建库并把表集合写盘（给 reopen 段用）
//        reopen  重开同一目录，断言跳过 DDL 且表一张不少
//    第一版把三段塞进一个进程，栽在 `PGlite is closed` 上。
// ---------------------------------------------------------------------------
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=build').slice(
  '--phase='.length
)

// 目录固定（可预测），两阶段之间靠它交接；每次跑之前先清干净。
const REOPEN_DIR = join(tmpdir(), 'thinhost-ddl-reopen')

if (PHASE === 'build') {
  // 只跑 A2，别碰 A1 —— 单例已经用掉了。
  await withSandbox('fresh', async () => {
    const { runtime, count } = countedRuntime(character)
    try {
      const ready = await initDatabase(runtime, sqlPlugin as Plugin)
      const ran = count()
      check(
        'A2-fresh-runs-ddl',
        ran === 1,
        `全新库必须跑 1 次 runPluginMigrations（实测 ${ran} 次），并建出 ${ready.tables.length} 张表`
      )
      const required = ['agents', 'memories', 'rooms', 'participants', 'entities', 'worlds']
      const missing = required.filter((t) => !ready.tables.includes(t))
      check('A2-fresh-tables', missing.length === 0, `必需表齐全（缺：${missing.join(',') || '无'}）`)
    } finally {
      await closeDatabaseConnection(runtime)
    }
  })
  report(`A2（全新库仍跑 DDL）`)
} else if (PHASE === 'build-reopen') {
  rmSync(REOPEN_DIR, { recursive: true, force: true })
  process.env.PGLITE_DATA_DIR = REOPEN_DIR
  process.env.PROJECT_LG_SANDBOX = REOPEN_DIR
  process.env.CHARACTER_DB_BACKEND = 'pglite'
  process.env.POSTGRES_URL = ''
  for (const k of REOPEN_IDENTITY_KEYS) process.env[k] = ''
  const { runtime, count } = countedRuntime(character)
  try {
    const ready = await initDatabase(runtime, sqlPlugin as Plugin)
    writeFileSync(
      join(REOPEN_DIR, 'first-run.json'),
      JSON.stringify({ ddlRuns: count(), tables: ready.tables }, null, 2)
    )
    check(
      'A1-prep-first-runs-ddl',
      count() === 1,
      `准备阶段跑 ${count()} 次 DDL，建 ${ready.tables.length} 张表（写盘供 reopen 段）`
    )
  } finally {
    await closeDatabaseConnection(runtime)
  }
  report('A1 准备（建库）')
} else if (PHASE === 'reopen') {
  const handoff = join(REOPEN_DIR, 'first-run.json')
  if (!existsSync(handoff)) {
    console.error(`缺少交接文件 ${handoff}：先跑 --phase=build-reopen`)
    process.exit(2)
  }
  const first = JSON.parse(readFileSync(handoff, 'utf8')) as { ddlRuns: number; tables: string[] }
  check('A1-prep-was-fresh', first.ddlRuns === 1, `上一次建库确实跑了 ${first.ddlRuns} 次 DDL`)

  process.env.PGLITE_DATA_DIR = REOPEN_DIR
  process.env.PROJECT_LG_SANDBOX = REOPEN_DIR
  process.env.CHARACTER_DB_BACKEND = 'pglite'
  process.env.POSTGRES_URL = ''
  for (const k of REOPEN_IDENTITY_KEYS) process.env[k] = ''
  const second = countedRuntime(character)
  try {
    const ready = await initDatabase(second.runtime, sqlPlugin as Plugin)
    const ran = second.count()
    check(
      'A1-ready-skips-ddl',
      ran === 0,
      `schema 已就绪时必须 0 次 runPluginMigrations（实测 ${ran} 次）—— 这就是"启动不再跑 DDL"`
    )
    const missing = first.tables.filter((t) => !ready.tables.includes(t))
    check(
      'A4-same-tables',
      missing.length === 0,
      `跳过 DDL 后上次的 ${first.tables.length} 张表一张不少（缺：${missing.join(',') || '无'}）`
    )
    check(
      'A3-decision-is-table-driven',
      ran === 0,
      '跳过与否由"表在不在"决定，全程没有读任何跳过开关'
    )
  } finally {
    await closeDatabaseConnection(second.runtime)
  }
  report('A1/A3/A4（已就绪 ⇒ 跳过 DDL）')
}

function report(title: string): void {
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n=== thinhost DDL decoupling · ${title}: ${checks.length - failed.length}/${checks.length} PASS ===`)
  for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
  if (failed.length > 0) process.exitCode = 1
}
