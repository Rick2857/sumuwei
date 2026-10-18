/**
 * 稳态探针：量「启动完成之后」的**长驻代价**。
 *
 * ============================================================================
 *  为什么第一轮没量到它（这是本文件存在的理由）
 * ============================================================================
 * 第一轮归因探针在 `runtime.initialize()` 之后立刻退出，所以只量到了**启动期**。
 * 但生产里 LG 核心是**长驻**的（systemd，天级），而 `@elizaos/plugin-bootstrap`
 * 注册了两个**常驻 interval**：
 *
 *   · `ServiceType.TASK`               TICK_INTERVAL = 1000ms   （每秒查一次 tasks 表）
 *   · `embedding-generation` 服务      processingIntervalMs = 100ms（**每 100ms 唤醒**）
 *     （dist/index.js:7054 / :7292）
 *
 * embedding 那个在 `queue.length > 0` 时才真正干活，但 `setInterval` **本身仍然
 * 每 100ms 唤醒一次事件循环**；task 那个每秒都会 `checkTasks()` 打一次库。
 * ⇒ 这些是**每分钟 600 次 + 每分钟 60 次查询**的固定税，只有量"稳态"才看得见。
 *
 * 用法：`--variant full|thin --idle-ms <n>`
 * ⚠️ 必须以隔离 PGlite 起（PGLITE_DATA_DIR + PROJECT_LG_SANDBOX 指向同一非生产目录）。
 */

import { character } from '../src/character/index.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'

const IDENTITY_KEYS = [
  'LG_PG_EXPECT_DATABASE',
  'LG_PG_EXPECT_USER',
  'LG_PG_EXPECT_DATABASE_PREFIX',
  'LG_PG_EXPECT_USER_PREFIX',
  'LG_PRODUCTION_POSTGRES_URL',
  'LG_TEST_DATABASE_PREFIX',
] as const

const variant = (process.argv.find((a) => a.startsWith('--variant=')) ?? '--variant=full').slice(
  '--variant='.length
)
const idleMs = Number(
  (process.argv.find((a) => a.startsWith('--idle-ms=')) ?? '--idle-ms=120000').slice(
    '--idle-ms='.length
  )
)

// ---- 安全轨（同 attribution 探针）：宁可不跑，也不许碰生产 -------------------
const dataDir = process.env.PGLITE_DATA_DIR ?? ''
const sandbox = process.env.PROJECT_LG_SANDBOX ?? ''
const refuse = (why: string): never => {
  console.error(`拒绝运行稳态探针：${why}`)
  process.exit(3)
}
if (dataDir === '') refuse('PGLITE_DATA_DIR 未设置')
if (sandbox === '' || dataDir !== sandbox) refuse('PGLITE_DATA_DIR 与 PROJECT_LG_SANDBOX 不一致')
if (dataDir.includes('project-lg/data/pglite')) refuse(`指向生产 PGlite 目录：${dataDir}`)
if (process.env.CHARACTER_DB_BACKEND === 'postgres') refuse('本探针只跑隔离 PGlite')
if ((process.env.POSTGRES_URL ?? '') !== '') refuse('POSTGRES_URL 非空')
for (const k of IDENTITY_KEYS) process.env[k] = ''

const core = (await import('@elizaos/core')) as typeof import('@elizaos/core')
const { AgentRuntime } = core
const sqlPlugin = (await import('@elizaos/plugin-sql')).default as unknown as import('@elizaos/core').Plugin
const bootstrapPlugin = (await import('@elizaos/plugin-bootstrap')).default as unknown as import('@elizaos/core').Plugin
const openaiPlugin = (await import('@elizaos/plugin-openai')).default as unknown as import('@elizaos/core').Plugin

const persistentCharacter = createPersistentCharacterPlugin({
  characterId: (character.id ?? character.name) as never,
  userId: core.stringToUuid('user-steady'),
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
    PGLITE_DATA_DIR: dataDir,
    CHARACTER_DB_BACKEND: 'pglite',
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: '',
    OPENAI_LARGE_MODEL: '',
    OPENAI_SMALL_MODEL: '',
  },
})

await runtime.registerPlugin(sqlPlugin)
await runtime.runPluginMigrations()
const { withGuardTimersUnrefed } = await import('../src/infrastructure/runtime/guard-timers.ts')
await withGuardTimersUnrefed(() => runtime.initialize())

function handles(): Record<string, number> {
  const h: Record<string, number> = {}
  for (const r of process.getActiveResourcesInfo()) h[r] = (h[r] ?? 0) + 1
  return h
}

// ---- 预热：让启动期的临时分配与 GC 先过去 --------------------------------
const WARMUP = 20_000
console.log(`variant=${variant} 预热 ${WARMUP}ms …`)
await new Promise((r) => setTimeout(r, WARMUP))

// ---- 稳态观测窗 ----------------------------------------------------------
const cpu0 = process.cpuUsage()
const t0 = process.hrtime.bigint()
const rss0 = process.memoryUsage().rss
const h0 = handles()

const samples: { tSec: number; rssMB: number; heapMB: number }[] = []
const STEP = 10_000
for (let elapsed = 0; elapsed < idleMs; elapsed += STEP) {
  await new Promise((r) => setTimeout(r, STEP))
  const m = process.memoryUsage()
  const sec = Number(process.hrtime.bigint() - t0) / 1e9
  samples.push({
    tSec: +sec.toFixed(1),
    rssMB: +(m.rss / 1048576).toFixed(1),
    heapMB: +(m.heapUsed / 1048576).toFixed(1),
  })
  console.log(
    `  t+${sec.toFixed(0)}s rss=${(m.rss / 1048576).toFixed(1)}MB heap=${(m.heapUsed / 1048576).toFixed(1)}MB Timeout=${handles().Timeout ?? 0}`
  )
}

const cpu1 = process.cpuUsage(cpu0)
const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9
const cpuMs = (cpu1.user + cpu1.system) / 1000
const h1 = handles()
const rss1 = process.memoryUsage().rss

const result = {
  variant,
  idleSec: +elapsedSec.toFixed(1),
  cpuMsDuringIdle: +cpuMs.toFixed(1),
  idleCpuPercentOfOneCore: +((cpuMs / 1000 / elapsedSec) * 100).toFixed(3),
  rssStartMB: +(rss0 / 1048576).toFixed(1),
  rssEndMB: +(rss1 / 1048576).toFixed(1),
  rssDriftMB: +((rss1 - rss0) / 1048576).toFixed(1),
  timersStart: h0.Timeout ?? 0,
  timersEnd: h1.Timeout ?? 0,
  handlesStart: h0,
  handlesEnd: h1,
  samples,
}

console.log('\n=== STEADY STATE RESULT ===')
console.log(JSON.stringify(result, null, 2))

try {
  await runtime.stop()
} catch {
  /* 收尾失败不影响已取得的读数 */
}
process.exit(0)
