/**
 * 归因探针：把 LG 核心启动的**每一段**拆开，量它各自的时间 / 峰值内存 / 活动句柄。
 *
 * ============================================================================
 *  为什么要有这个探针（它回答的是设计决策问题，不是性能好奇）
 * ============================================================================
 * 服务器现网读数（2026-10-18，替换前基线）：
 *   t+5s  27.8 MB → t+20s 646.8 MB（峰值）→ t+50s 339.5 MB → t+90s 341.1 MB（稳态）
 * 那 **306 MB 的启动峰值**是这次替换要攻击的目标。但在动手重写之前，
 * 必须先知道它由什么构成 —— 否则可能写完一版薄宿主，最后只省下 40 MB。
 *
 * 本探针把启动拆成 6 个阶段，逐段记录：
 *   S0  进程起来，什么都没 import
 *   S1  import @elizaos/core
 *   S2  import 四个插件（sql / bootstrap / openai / lg 自己的 openai-compatible）
 *   S3  new AgentRuntime({...plugins})
 *   S4  registerPlugin(sqlPlugin) + runPluginMigrations()   ← 就是"启动 DDL"
 *   S5  runtime.initialize()                                  ← 服务注册 + 守卫定时器
 *
 * 每段记录：墙钟增量、RSS/heap、**maxRSS（峰值）**、活动句柄构成。
 * `process.getActiveResourcesInfo()` 里的 'Timeout' 计数 = 活着的定时器，
 * 直接量到上游那批 30 秒孤儿定时器。
 *
 * ============================================================================
 *  两种档位（--variant）
 * ============================================================================
 *   full   = 现状：sql + bootstrap + openai + openai-compatible + persistent-character
 *   thin   = 薄宿主所需：sql + openai-compatible + persistent-character（去掉 bootstrap/openai）
 *
 * ⚠️ **隔离**：必须以 PGLITE_DATA_DIR + PROJECT_LG_SANDBOX 指向同一非生产目录启动，
 *    否则 `assertDatabaseAccessAllowed()` 会直接拒（这是它的本职，不要绕过）。
 *    本探针**只**在隔离 PGlite 上跑，从不接触生产 PostgreSQL。
 */

import { character } from '../src/character/index.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'

interface Stage {
  stage: string
  note: string
  elapsedMs: number
  rssMB: number
  heapUsedMB: number
  externalMB: number
  maxRssMB: number
  handles: Record<string, number>
}

const stages: Stage[] = []
let mark = process.hrtime.bigint()

function nowMs(): number {
  return Number(process.hrtime.bigint() - mark) / 1e6
}

function snapshot(stage: string, note: string): void {
  const m = process.memoryUsage()
  const handles: Record<string, number> = {}
  for (const r of process.getActiveResourcesInfo()) {
    handles[r] = (handles[r] ?? 0) + 1
  }
  const row: Stage = {
    stage,
    note,
    elapsedMs: Number(nowMs().toFixed(1)),
    rssMB: Number((m.rss / 1048576).toFixed(1)),
    heapUsedMB: Number((m.heapUsed / 1048576).toFixed(1)),
    externalMB: Number((m.external / 1048576).toFixed(1)),
    maxRssMB: Number((process.resourceUsage().maxRSS / 1024).toFixed(1)),
    handles,
  }
  stages.push(row)
  // 单行进度，方便在远端日志里看时序
  console.log(
    `[${row.stage}] +${row.elapsedMs}ms rss=${row.rssMB}MB heap=${row.heapUsedMB}MB ` +
      `maxRSS=${row.maxRssMB}MB Timeout=${handles.Timeout ?? 0}`
  )
}

const variant = process.argv.includes('--variant')
  ? process.argv[process.argv.indexOf('--variant') + 1]
  : 'full'

if (variant !== 'full' && variant !== 'thin') {
  console.error(`--variant 必须是 full 或 thin，收到：${variant}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// ⚠️ 硬性安全轨：宁可不跑，也不许碰生产
// ---------------------------------------------------------------------------
// plugin-sql 读的是 **runtime settings** 里的 PGLITE_DATA_DIR（`main.ts:1047` 注释里
// 记过这个坑：插件**不回落** process.env）。所以只改环境变量**不足以**保证安全 ——
// 必须同时校验环境变量、并把它播种进 settings。两条都做，缺一条就拒绝启动探针。
const dataDir = process.env.PGLITE_DATA_DIR ?? ''
const sandbox = process.env.PROJECT_LG_SANDBOX ?? ''
const refuse = (why: string): never => {
  console.error(`拒绝运行探针：${why}`)
  process.exit(3)
}
if (dataDir === '') refuse('PGLITE_DATA_DIR 未设置（拒绝靠默认值猜生产目录）')
if (sandbox === '') refuse('PROJECT_LG_SANDBOX 未设置（拒绝把这次运行当成已隔离）')
if (dataDir !== sandbox) refuse(`PGLITE_DATA_DIR(${dataDir}) !== PROJECT_LG_SANDBOX(${sandbox})`)
if (dataDir.includes('project-lg/data/pglite')) refuse(`指向生产 PGlite 目录：${dataDir}`)
if (process.env.CHARACTER_DB_BACKEND === 'postgres') refuse('CHARACTER_DB_BACKEND=postgres（本探针只跑隔离 PGlite）')
if ((process.env.POSTGRES_URL ?? '') !== '') refuse('POSTGRES_URL 非空（拒绝任何指向 PostgreSQL 的可能）')
console.log(`安全轨通过：隔离目录 ${dataDir}`)

const label = variant === 'full' ? '现状（bootstrap+openai 都在）' : '薄宿主档（去掉 bootstrap/openai）'
console.log(`=== attribution probe: variant=${variant} — ${label} ===`)
console.log(`node=${process.version} pid=${process.pid}`)
console.log(
  `sandbox PGLITE_DATA_DIR=${process.env.PGLITE_DATA_DIR ?? '(unset)'} ` +
    `PROJECT_LG_SANDBOX=${process.env.PROJECT_LG_SANDBOX ?? '(unset)'}`
)

// ---------------------------------------------------------------------------
// S0 · 基线
// ---------------------------------------------------------------------------
snapshot('S0', '进程起来，未 import 任何东西')

// ---------------------------------------------------------------------------
// S1 · core
// ---------------------------------------------------------------------------
const core = (await import('@elizaos/core')) as typeof import('@elizaos/core')
const { AgentRuntime } = core
snapshot('S1', 'import @elizaos/core')

// ---------------------------------------------------------------------------
// S2 · 插件模块图
// ---------------------------------------------------------------------------
const sqlPlugin = (await import('@elizaos/plugin-sql')).default as unknown as import('@elizaos/core').Plugin
const bootstrapPlugin = (await import('@elizaos/plugin-bootstrap')).default as unknown as import('@elizaos/core').Plugin
const openaiPlugin = (await import('@elizaos/plugin-openai')).default as unknown as import('@elizaos/core').Plugin
snapshot('S2', 'import plugin-sql + plugin-bootstrap + plugin-openai')

// ---------------------------------------------------------------------------
// S3 · 构造 runtime
// ---------------------------------------------------------------------------
const persistentCharacter = createPersistentCharacterPlugin({
  characterId: (character.id ?? character.name) as never,
  userId: core.stringToUuid('user-probe'),
})

const plugins: import('@elizaos/core').Plugin[] =
  variant === 'full'
    ? [openaiPlugin, bootstrapPlugin, openAiCompatiblePlugin, persistentCharacter]
    : [openAiCompatiblePlugin, persistentCharacter]

const runtime = new AgentRuntime({
  character,
  plugins,
  conversationLength: 30,
  settings: {
    // ⚠️ 关键：plugin-sql 读 settings 而不是 process.env。不播种它就可能落到默认目录。
    PGLITE_DATA_DIR: dataDir,
    CHARACTER_DB_BACKEND: 'pglite',
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: '',
    OPENAI_LARGE_MODEL: '',
    OPENAI_SMALL_MODEL: '',
  },
})
snapshot('S3', `new AgentRuntime({ plugins: ${plugins.length} })`)

// ---------------------------------------------------------------------------
// S4 · 启动 DDL
// ---------------------------------------------------------------------------
await runtime.registerPlugin(sqlPlugin)
snapshot('S4a', 'registerPlugin(sqlPlugin)')

await runtime.runPluginMigrations()
snapshot('S4b', 'runPluginMigrations()  ← 启动 DDL 就在这里')

// ---------------------------------------------------------------------------
// S5 · initialize（服务注册 + 守卫定时器）
// ---------------------------------------------------------------------------
const { withGuardTimersUnrefed } = await import('../src/infrastructure/runtime/guard-timers.ts')
const { value: initReport, report: guardReport } = await withGuardTimersUnrefed(() =>
  runtime.initialize()
)
snapshot('S5', `runtime.initialize()（guard unref ${guardReport.unrefed} 个）`)
void initReport

// ---------------------------------------------------------------------------
// 结论行
// ---------------------------------------------------------------------------
console.log('\n=== STAGE TABLE (variant=' + variant + ') ===')
console.log(JSON.stringify(stages, null, 2))
console.log('\n=== SUMMARY ===')
const first = stages[0]
const last = stages[stages.length - 1]
console.log(
  JSON.stringify(
    {
      variant,
      totalMs: Number(last.elapsedMs.toFixed(1)),
      rssGrowthMB: Number((last.rssMB - first.rssMB).toFixed(1)),
      maxRssMB: last.maxRssMB,
      finalTimeouts: last.handles.Timeout ?? 0,
      guardUnrefed: guardReport.unrefed,
      guardDelays: guardReport.delays,
    },
    null,
    2
  )
)

// 有序收尾：停服务 + 关连接（薄宿主要做到"不用 unref 猴子补丁也能退出"，
// 所以这里**故意不**等守卫定时器自然到期，而是显式收尾后看还剩什么句柄）
try {
  await runtime.stop()
} catch (error) {
  console.log(`stop() 失败：${error instanceof Error ? error.message : String(error)}`)
}
snapshot('S6', 'runtime.stop() 之后')
console.log('=== PROBE DONE ===')
process.exit(0)
