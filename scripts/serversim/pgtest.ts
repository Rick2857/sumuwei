/**
 * 服务器仿真环境 · **仿真内数据库门**执行器（2026-10-21 新增）
 *
 * ============================================================================
 *  它解决什么
 * ============================================================================
 *  仓库的门跑在 PostgreSQL 上时需要**隔离测试库**。历史上的两个入口都不满足
 *  2026-10-21 起的约定：
 *
 *   · `pnpm gates:pg` / `gates:pg-chain`
 *       —— 门体在**宿主机**执行（不在仿真里），且库是宿主机自己起的一次性容器。
 *   · `pnpm serversim:gates`
 *       —— 默认强制 PGlite（自 M10 起不可用），`--pg` 也不提供测试库隔离。
 *
 *  ⇒ 本脚本把「**门体在 simhost 内执行**」与「**库在仿真的专用隔离实例里**」
 *    这两件事接起来：
 *
 *    ┌─ 宿主机（本脚本）──────────────────────────────┐
 *    │  ① 读 pgtest 容器的凭据（单一事实源 = compose.yml）│
 *    │  ② 读仿真自己的生产库地址（sumuwei 副本）        │
 *    │  ③ docker compose exec → simhost 里跑门体        │
 *    └───────────────────────────────────────────────┘
 *                     ↓ compose 网络
 *    ┌─ simhost（门体在这里跑）────────────────────────┐
 *    │  pg gates:pg --<门>                             │
 *    │    └─ 准备阶段：建 lg_test_<id> 库 + 装扩展       │
 *    │       + **显式应用 LG 迁移** + 身份核对          │
 *    │    └─ 门体子进程：LG_TEST_PG_URL=…/lg_test_<id>  │
 *    └───────────────────────────────────────────────┘
 *                     ↓ compose 网络
 *    ┌─ pgtest（**另一个实例** · 独立卷 · 无 sumuwei）───┐
 *    └───────────────────────────────────────────────┘
 *
 * ============================================================================
 *  隔离是**结构性**的，不是靠约定
 * ============================================================================
 *  核心在用的那个实例（`pg`）里装着**真实数据副本**（`sumuwei`，56 表 / 5244 行）。
 *  测试库所在的 `pgtest` 是**另一个实例、另一个卷、另一套口令**，
 *  普通门使用空库；迁移门可把已有只读逻辑快照恢复到自己的测试库，
 *  不连接 simcore 的 `sumuwei`，也不打开生产目标。
 *
 *  另外三道闸：
 *   · 库名必须带 `lg_test_` 前缀（`postgresIsolationDecision` 失败关闭）；
 *   · 准备阶段**显式**应用 LG 迁移（不是启动期建表）；
 *   · 连上后核对 `current_database()` / `current_user`（身份不符即拒）。
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *  ```bash
 *  pnpm serversim:pgtest -- kernel:verify     # 跑一道门
 *  pnpm serversim:pgtest -- --chain           # 跑链上 17 道 DB 门
 *  ```
 *
 *  ⚠️ 前提：仿真栈已在跑（`pnpm serversim:up`），且**镜像里有待测代码**
 *     （改了源码要先 `pnpm serversim:build` + `up -d`）。
 * ============================================================================
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const COMPOSE = join(REPO, 'serversim', 'compose.yml')
const SIM_ENV = join(REPO, 'artifacts', 'serversim', 'local', 'env', '.env')
const LOG_DIR = join(REPO, 'artifacts', 'serversim', 'local', 'gate-logs')
const PGTEST_SERVICE = 'pgtest'
const PGTEST_HOST = 'pgtest' // compose 网络里的服务名

function compose (composeArgs: string[]): string {
  return execFileSync('docker', ['compose', '-f', COMPOSE, ...composeArgs], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 从 `.env` 文本里取一个键（只取值，不打印整个文件） */
function envValue (text: string, key: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (match === null || match[1] !== key) continue
    let value = (match[2] ?? '').trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    return value
  }
  return undefined
}

/**
 * pgtest 实例的 admin 连接串。
 *
 * ⚠️ 凭据**从正在运行的容器里读**（`printenv`），不在这里复述第二份 ——
 *    单一事实源是 `serversim/compose.yml`；复述就会出现"改了 compose 忘了改这里"。
 */
function pgtestAdminUrl (): string {
  let out: string
  try {
    out = compose(['exec', '-T', PGTEST_SERVICE, 'printenv', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'])
  } catch (error) {
    console.error(`❌ 读不到 ${PGTEST_SERVICE} 容器（仿真栈没起？先跑 pnpm serversim:up）：${(error as Error).message.slice(0, 200)}`)
    process.exit(2)
  }
  const lines = out.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const [user, password, database] = lines
  if (user === undefined || password === undefined || database === undefined) {
    console.error(`❌ ${PGTEST_SERVICE} 的凭据读不全（user=${String(user)} db=${String(database)}）`)
    process.exit(2)
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${PGTEST_HOST}:5432/${encodeURIComponent(database)}`
}

/**
 * 仿真里**核心在用的那个库**的地址（`sumuwei` 真实数据副本）。
 *
 * ⚠️ 它是**隔离判据的对照物**：门体要证明"本次目标 ≠ 这个目标"。
 *    读不到就**不给**这个变量（而不是给个假的）—— 那样隔离判据会退化成
 *    "只看库名前缀"，而前缀是可以被随手写出来的。
 */
function simProductionUrl (): string | undefined {
  if (!existsSync(SIM_ENV)) return undefined
  return envValue(readFileSync(SIM_ENV, 'utf8'), 'POSTGRES_URL')
}

const args = process.argv.slice(2)
const chainMode = args.includes('--chain')
const ciMode = args.includes('--ci')
const scenarioIndex = args.indexOf('--scenario')
const scenarioScript = scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined
const scriptIndex = args.indexOf('--script')
const directScript = scriptIndex >= 0 ? args[scriptIndex + 1] : undefined
const gateNames = args.filter(arg => !arg.startsWith('--') && arg !== scenarioScript && arg !== directScript)
if (gateNames.length > 1) {
  console.error('❌ 一次只接受一道门；请分别调用，不能静默忽略后面的门。')
  process.exit(2)
}
if (!chainMode && !ciMode && scenarioScript === undefined && directScript === undefined && gateNames.length === 0) {
  console.error('用法：pnpm serversim:pgtest -- <pnpm 脚本名>   |   --chain   |   --ci   |   --scenario <门体脚本>   |   --script <门体脚本>')
  console.error('例：  pnpm serversim:pgtest -- kernel:verify')
  console.error('      pnpm serversim:pgtest -- --chain      （链上 17 道 DB 门）')
  console.error('      pnpm serversim:pgtest -- --ci         （完整 m4.5:ci，含非 DB 门）')
  console.error('      pnpm serversim:pgtest -- --scenario scripts/verify-m4-mutation-safety.ts')
  console.error('      pnpm serversim:pgtest -- --script scripts/cognitive/world-model-transition-verify.ts')
  console.error('            （--script 不需要 package.json 里登记过这个脚本）')
  process.exit(2)
}

const adminUrl = pgtestAdminUrl()
const productionUrl = simProductionUrl()
if (productionUrl === undefined) {
  console.error('❌ 读不到仿真自己的生产库地址（' + SIM_ENV.replace(REPO, '<repo>') + '）。')
  console.error('   先跑 `pnpm serversim:prepare`；**不会**伪造一个对照目标。')
  process.exit(2)
}

mkdirSync(LOG_DIR, { recursive: true })
const runId = new Date().toISOString().replace(/[:.]/g, '-')

console.log('─'.repeat(78))
console.log('服务器仿真环境 · 仿真内数据库门')
console.log(`  执行位置      : simhost 容器（compose 服务 simhost）`)
console.log(`  隔离库实例    : ${PGTEST_SERVICE}（独立容器 · 独立卷 · 无 sumuwei 副本）`)
console.log(`  生产对照目标  : ${productionUrl.replace(/:[^:@/]+@/, ':<redacted>@')}`)
console.log(`  运行标识      : ${runId}`)
console.log('─'.repeat(78))

/**
 * 把仿真容器里产出的**证据**复制回宿主。
 *
 * ⚠️ 为什么必须有这一步：仿真容器里的 `artifacts/` 是**容器内文件系统**，
 *    容器一销毁就没了。而**汇总门**（例：`scripts/world-model-gates.ts`）读的是
 *    **宿主**上的 `artifacts/post-lv2/local/…` ⇒ 仿真里跑出来的证据不回传，
 *    汇总门就只看得见**上一轮**的旧证据 ⇒ 它的"源码指纹锁"会误报失配。
 *
 * ⇒ 回传三个既有证据根，保留不同运行目录；同名文件按容器读数覆盖。
 *    原生 docker cp 流式传输，不把含模型资产的整份 tar 放进 Node Buffer。
 */
function collectEvidence (): void {
  const roots = ['artifacts/post-lv2/local', 'artifacts/local', 'artifacts/cognitive/local']
  // A fresh image may not have produced every category yet; create empty optional roots.
  compose(['exec', '-T', 'simhost', 'mkdir', '-p', ...roots.map(root => `/opt/project-lg/${root}`)])
  for (const root of roots) {
    const destination = join(REPO, root)
    mkdirSync(destination, { recursive: true })
    const restored = spawnSync('docker', ['compose', '-f', COMPOSE, 'cp',
      `simhost:/opt/project-lg/${root}/.`, destination], { cwd: REPO, stdio: 'inherit', windowsHide: true })
    if (restored.status !== 0) throw new Error(`证据回传失败：${root}（门体输出已保留，容器证据未删除）`)
  }
}

/**
 * 在 simhost 里跑一段命令，并把输出**同时**打到宿主终端与宿主侧日志文件。
 *
 * ⚠️ 为什么要有宿主侧日志：仿真容器里的 `artifacts/` 是**容器内文件系统**，
 *    容器一销毁就没了 ⇒ 证据必须落在宿主机上，否则"跑过了"无法复核。
 */
function execInSimhost (label: string, commandArgs: string[]): number {
  const logPath = join(LOG_DIR, `${runId}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`)
  const result = spawnSync(
    'docker',
    [
      'compose', '-f', COMPOSE, 'exec', '-T',
      '-e', `LG_SIM_PGTEST_ADMIN_URL=${adminUrl}`,
      '-e', `LG_SIM_PRODUCTION_POSTGRES_URL=${productionUrl}`,
      'simhost', ...commandArgs,
    ],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(logPath, output, 'utf8')
  process.stdout.write(output)
  if (result.error !== undefined) {
    console.error(`❌ ${label} 无法启动：${result.error.message}`)
    return 1
  }
  console.log(`  （日志：${logPath.replace(REPO, '<repo>')}）`)
  collectEvidence()
  return result.status ?? 1
}

const exitCode = ciMode
  ? execInSimhost('ci', ['pnpm', 'exec', 'tsx', 'scripts/cognitive/ci-runner.ts'])
  : chainMode
    ? execInSimhost('chain', ['pnpm', 'gates:pg-chain'])
    : directScript !== undefined
      ? execInSimhost('script', ['pnpm', 'exec', 'tsx', 'scripts/gates/run-pg-script.ts', directScript])
      : scenarioScript !== undefined
        ? execInSimhost('scenario', ['pnpm', 'gates:pg:scenario', '--', scenarioScript])
        : execInSimhost(gateNames[0]!, ['pnpm', 'gates:pg', `--${gateNames[0]!}`])

process.exit(exitCode)
