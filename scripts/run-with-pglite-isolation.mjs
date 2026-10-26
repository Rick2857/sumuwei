/**
 * 用 **PGlite 隔离**跑仓库的门（2026-10-20 新增）
 *
 * ============================================================================
 *  这个文件为什么存在
 * ============================================================================
 *  `.env` 现在写着 `CHARACTER_DB_BACKEND=postgres`。而仓库里大量门的第一步是
 *  `isolateDatabase()`，它**只能隔离 PGlite 的数据目录**；后端是 postgres 时
 *  按设计**失败关闭**（`postgres_isolation_not_provided`）。
 *
 *  ⇒ 于是"跑门"的正确方式一直是 `docs/` 里反复出现的那一句：
 *     **无 `.env` 的 cwd + 钉死 `CHARACTER_DB_BACKEND=pglite`**。
 *     但本检出里**没有**任何脚本实现它（`docs/world-model/World-Model-Acceptance-Report-2026-10-20.md:203`
 *     引用过 `scripts/run-with-pglite-isolation.mjs`，而该文件此前**不存在**）。
 *  ⇒ 本文件就是补上那一个。
 *
 * ============================================================================
 *  它到底做了什么（四条，缺一条都不成立）
 * ============================================================================
 *  ① **把 `<repo>/.env` 挪开**（运行结束/被中断时**一定**挪回）。
 *     为什么必须挪文件，而不是设 `DOTENV_CONFIG_PATH`：
 *     `src/db/index.ts:231-237` 会在开库前**自己从 cwd 逐级向上找 `.env`** 再读它。
 *     只改 dotenv 的入口挡不住这一条（实测：仍然 `postgres_url_without_backend`）。
 *  ② **删掉环境里的 PG 变量**（`POSTGRES_URL` / `DATABASE_URL` / `LG_PG_EXPECT_*`）。
 *     设成空串**不够** —— 解析器把"有值但空"与"没有"区别对待。
 *  ③ **钉死 `CHARACTER_DB_BACKEND=pglite`**。
 *  ④ **把 `PGLITE_DATA_DIR` 指向一个临时目录**（兜底，见下）。
 *
 * ============================================================================
 *  ⚠️ ④ 是安全网，不是装饰
 * ============================================================================
 *  没有 `.env` 时 `PGLITE_DATA_DIR` 是空的 ⇒ `src/db/index.ts` 会退到
 *  **真实库目录**。一道忘了先调 `isolateDatabase()` 的门，就会去开真实库。
 *  ⇒ 这里把默认值指到一个和仓库无关的临时目录：万一有门忘了隔离，
 *    它污染的是这个临时目录，不是 `data/pglite`。
 *    （正常门会用自己的沙箱覆盖它 —— 那是 `isolateDatabase()` 的职责。）
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *  ```bash
 *  node scripts/run-with-pglite-isolation.mjs pnpm m4.5:ci
 *  node scripts/run-with-pglite-isolation.mjs pnpm kernel:verify
 *  node scripts/run-with-pglite-isolation.mjs --print-env   # 只看它会怎么跑，不执行
 *  ```
 *
 *  ⚠️ 它**不改**任何产品代码、**不改** `.env` 内容（只在运行期间把它挪开再挪回）。
 *  ⚠️ 它**不打开**生产库：连接串被删掉、后端被钉成 pglite。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../', import.meta.url)))
const ENV_FILE = join(REPO, '.env')
const HIDDEN = join(REPO, '.env.hidden-by-pglite-runner')
const ARGS = process.argv.slice(2)

// ---------------------------------------------------------------------------
//  参数
// ---------------------------------------------------------------------------
if (ARGS.length === 0 || ARGS[0] === '--help' || ARGS[0] === '-h') {
  console.log('用法：node scripts/run-with-pglite-isolation.mjs [--print-env] <命令…>')
  console.log('例：  node scripts/run-with-pglite-isolation.mjs pnpm m4.5:ci')
  process.exit(ARGS.length === 0 ? 2 : 0)
}
const PRINT_ONLY = ARGS[0] === '--print-env'
const COMMAND = PRINT_ONLY ? ARGS.slice(1) : ARGS

// ---------------------------------------------------------------------------
//  ⚠️ 祖先目录里的 `.env` 也要提前发现（否则"挪开本仓库的"并不够）
// ---------------------------------------------------------------------------
const ancestorEnvFiles = []
for (let dir = dirname(REPO); ; dir = dirname(dir)) {
  const candidate = join(dir, '.env')
  if (existsSync(candidate)) ancestorEnvFiles.push(candidate)
  if (dirname(dir) === dir) break
}
if (ancestorEnvFiles.length > 0) {
  console.warn('⚠️ 仓库**上级目录**里也存在 .env —— 本脚本不会动它们：')
  for (const file of ancestorEnvFiles) console.warn(`   · ${file}`)
  console.warn('   `src/db/index.ts` 的向上搜索会读到它们；若里面有 POSTGRES_URL，隔离可能不成立。')
}

// ---------------------------------------------------------------------------
//  构造子进程环境
// ---------------------------------------------------------------------------
const DB_KEYS_TO_REMOVE = [
  'POSTGRES_URL',
  'DATABASE_URL',
  'LG_PG_EXPECT_DATABASE',
  'LG_PG_EXPECT_USER',
  'LG_PG_CONTAINER',
  'LG_PG_EXPECT_DATABASE_PREFIX',
  'LG_PG_EXPECT_USER_PREFIX',
  'LG_PRODUCTION_POSTGRES_URL',
  'PGLITE_SNAPSHOT_DIR',
]
const fallbackDataDir = mkdtempSync(join(tmpdir(), 'project-lg-gate-pglite-'))

const childEnv = { ...process.env }
for (const key of DB_KEYS_TO_REMOVE) delete childEnv[key]
childEnv.CHARACTER_DB_BACKEND = 'pglite'
childEnv.PGLITE_DATA_DIR = join(fallbackDataDir, 'data')
childEnv.DOTENV_CONFIG_PATH = join(fallbackDataDir, 'no-such-dotenv-file')
childEnv.LG_GATE_PGLITE_RUNNER = '1'

if (PRINT_ONLY) {
  console.log('（--print-env：只看环境，不执行）')
  console.log(`  仓库根        : ${REPO}`)
  console.log(`  .env 会被挪到 : ${HIDDEN}`)
  console.log(`  后端          : ${childEnv.CHARACTER_DB_BACKEND}`)
  console.log(`  PGLITE_DATA_DIR（兜底）: ${childEnv.PGLITE_DATA_DIR}`)
  console.log(`  已删除的键    : ${DB_KEYS_TO_REMOVE.filter(k => process.env[k] !== undefined).join(', ') || '(本来就没有)'}`)
  console.log(`  命令          : ${COMMAND.join(' ')}`)
  rmSync(fallbackDataDir, { recursive: true, force: true })
  process.exit(0)
}

// ---------------------------------------------------------------------------
//  挪开 / 挪回（一条失败边都不放过）
// ---------------------------------------------------------------------------
let hidden = false
function restore () {
  if (!hidden) return
  try {
    if (existsSync(HIDDEN)) {
      renameSync(HIDDEN, ENV_FILE)
      hidden = false
    }
  } catch (error) {
    // 最后一道：挪不回来必须**大声说**，否则下一次运行会以为没有 .env
    console.error(`\n❌ 无法把 .env 挪回：${error instanceof Error ? error.message : String(error)}`)
    console.error(`   请手工执行：mv "${HIDDEN}" "${ENV_FILE}"`)
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore()
    rmSync(fallbackDataDir, { recursive: true, force: true })
    process.exit(130)
  })
}
process.on('exit', () => { restore(); rmSync(fallbackDataDir, { recursive: true, force: true }) })
process.on('uncaughtException', (error) => {
  console.error(error)
  restore()
  process.exit(1)
})

if (existsSync(ENV_FILE)) {
  renameSync(ENV_FILE, HIDDEN)
  hidden = true
  console.log('▸ 已把 .env 挪开（运行结束会挪回）')
} else {
  console.log('▸ 仓库根没有 .env（本来就没有）')
}
console.log(`▸ 后端 = pglite；连接串类变量已删除；PGLITE_DATA_DIR 兜底 = ${childEnv.PGLITE_DATA_DIR}`)
console.log(`▸ 执行：${COMMAND.join(' ')}\n`)

// ---------------------------------------------------------------------------
//  执行
// ---------------------------------------------------------------------------
const [executable, ...rest] = COMMAND
const isPnpm = executable === 'pnpm'
const result = spawnSync(
  isPnpm && process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : executable,
  isPnpm && process.platform === 'win32' ? ['/d', '/c', 'pnpm', ...rest] : rest,
  { cwd: REPO, env: childEnv, stdio: 'inherit', shell: false }
)

restore()
rmSync(fallbackDataDir, { recursive: true, force: true })

if (result.error !== undefined) {
  console.error(`\n❌ 起不来：${result.error.message}`)
  process.exit(1)
}
console.log(`\n▸ 子命令退出码：${String(result.status)}`)
process.exit(result.status ?? 1)
