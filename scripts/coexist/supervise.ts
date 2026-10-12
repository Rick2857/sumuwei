/**
 * post-Lv2 / **ADR-109 WP5** —— 共存的**启动 / 停机 / 回滚**编排。
 *
 * ============================================================================
 *  两种模式（**默认什么都不做**）
 * ============================================================================
 * ```bash
 * pnpm coexist:check                      # 只读就绪判据（不开库、不起进程）
 * pnpm coexist:prepare                    # 生成入口令牌（一次；落在 gitignore 的 local/ 下）
 * pnpm coexist:start                      # ★ 正式切换：需要**逐字授权**（见下）
 * pnpm coexist:stop                       # 有序停机：写停机哨兵 ⇒ 编排者关核心 stdin
 * ```
 *
 * **逐字授权**（与 `PROJECT_LG_ALLOW_RESTORE_APPLY` 同一条纪律：布尔开关不算授权）：
 * ```text
 *   PROJECT_LG_COEXIST_ACTIVATE='coexist@<解析后的 data/pglite 绝对路径>'
 * ```
 * 没有它 ⇒ **拒绝启动**（本脚本存在的主要理由：正式切换不是"跑一下试试"）。
 *
 * ============================================================================
 *  切换顺序（计划 §6 WP5 的第 2–5 步）
 * ============================================================================
 * ```text
 * ① 就绪判据（`coexist:check`）：入口开关 / QQ 配置 / 端口 / **旧入口是否还在跑**
 * ② 旧 QQ 入口必须**已经正常停掉**（真实库跨进程单持有；本脚本**不**替人杀进程）
 * ③ 起一个常驻核心（`src/main.ts --coexist`，唯一库持有者）
 * ④ 起两条外壳，各自**连到自己的监听**（QQ：`scripts/qq/chat.ts` 的连接档；
 *    皮套：`postlv2-avatar-production.cmd --connect-*`）
 * ⑤ 停机：写停机哨兵（或 Ctrl+C）⇒ **关核心 stdin** ⇒ 核心排空在飞轮次、关库、释放租约
 * ```
 *
 * ⚠️ 本脚本**不**打开数据库、**不**做迁移、**不**删快照：那些各走各自的授权链（INC-01）。
 * ⚠️ 它**不**动 `.env`：入口开关与令牌都由人显式配好（`coexist:check` 会检查）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { parse } from 'dotenv'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ROOT,
  RUNTIME_DIR,
  STOP_SENTINEL,
  activationAuthorization,
  checkReadiness,
  ensureEntryTokens,
  oldQqEntryRunning,
} from './readiness.ts'

const argv = process.argv.slice(2)
const mode = argv.includes('--start') ? 'start' : argv.includes('--prepare') ? 'prepare' : 'check'

function printReadiness(reading: Awaited<ReturnType<typeof checkReadiness>>): void {
  console.log('共存运行时 · 就绪判据（只读）')
  for (const note of reading.notes) console.log(`  · ${note}`)
  for (const problem of reading.problems) console.log(`  ✗ ${problem}`)
  console.log(reading.ok ? '  ⇒ 就绪：可以切换' : '  ⇒ **不就绪**：先解决上面列出的问题')
}

if (mode === 'prepare') {
  const tokens = ensureEntryTokens({ create: true })
  console.log('入口令牌已就绪（**不进仓库、不打印取值**）')
  console.log(`  QQ 端口   : ${String(tokens.qqPort)}`)
  console.log(`  皮套端口  : ${String(tokens.avatarPort)}`)
  console.log('  ⚠️ 把这两个端口与令牌配给两条外壳（见 `docs/post-lv2/QQ-Live2D-Coexistence-Activation-Candidate.md`）')
  process.exit(0)
}

if (mode === 'check') {
  printReadiness(await checkReadiness())
  process.exit(0)
}

// ---------------------------------------------------------------------------
// --start：正式切换（**逐字授权**）
// ---------------------------------------------------------------------------
const dataDir = resolve(ROOT, 'data/pglite')
const expected = activationAuthorization(dataDir)
const given = (process.env.PROJECT_LG_COEXIST_ACTIVATE ?? '').trim()
if (given !== expected) {
  console.error('❌ 拒绝启动：没有**逐字授权**。')
  console.error(`   需要环境变量 PROJECT_LG_COEXIST_ACTIVATE='${expected}'`)
  console.error('   （布尔开关不算授权；这条与 PROJECT_LG_ALLOW_RESTORE_APPLY 是同一条纪律）')
  process.exit(2)
}

const reading = await checkReadiness({ createTokens: true })
printReadiness(reading)
if (!reading.ok) process.exit(2)
if (oldQqEntryRunning()) {
  console.error('❌ 拒绝启动：**旧 QQ 入口仍在运行**。')
  console.error('   真实库是跨进程单持有资源 ⇒ 先到那个窗口按 Ctrl+C，等它排空退出（租约释放）再回来。')
  console.error('   本脚本**不**替人杀进程：那样会跳过"排空在飞消费者"这一步。')
  process.exit(2)
}
if (existsSync(STOP_SENTINEL)) rmSync(STOP_SENTINEL)

const tokens = ensureEntryTokens()
const env: NodeJS.ProcessEnv = { ...process.env }
const qqEnv = parse(readFileSync(resolve(ROOT, '.env.qq'), 'utf8'))
for (const [key, value] of Object.entries(qqEnv)) if (key.startsWith('QQ_')) env[key] = value
env.CHARACTER_COEXIST_QQ_PORT = String(tokens.qqPort)
env.CHARACTER_COEXIST_AVATAR_PORT = String(tokens.avatarPort)
env.CHARACTER_COEXIST_QQ_TOKEN = tokens.qq
env.CHARACTER_COEXIST_AVATAR_TOKEN = tokens.avatar
if (tokens.cli) {
  env.CHARACTER_COEXIST_CLI_PORT = String(tokens.cliPort)
  env.CHARACTER_COEXIST_CLI_TOKEN = tokens.cli
}

const children: { name: string; child: ChildProcess }[] = []
const core = spawn(
  process.execPath,
  [resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'), resolve(ROOT, 'src/main.ts'), '--coexist'],
  { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'inherit'] }
)
children.push({ name: 'core', child: core })
let ready = false
core.stdout!.setEncoding('utf8')
core.stdout!.on('data', (chunk: string) => {
  process.stdout.write(chunk)
  if (chunk.includes('COEXIST_READY')) ready = true
})
const coreExit = new Promise<number | null>((done) => core.once('close', (code) => done(code)))

for (let attempt = 0; attempt < 900 && !ready; attempt += 1) {
  if (core.exitCode !== null) break
  await delay(200)
}
if (!ready) {
  console.error('❌ 核心没有就绪（见上面的输出）。不启动任何外壳。')
  core.stdin?.end()
  process.exit(1)
}
console.log('✅ 核心已就绪（唯一库持有者）。现在起两条外壳。')

/** 外壳：QQ（连接档）与皮套（连接档） */
function startShells(): void {
  const qqShell = spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'), resolve(ROOT, 'scripts/qq/chat.ts')],
    {
      cwd: ROOT,
      env: {
        ...env,
        QQ_COEXIST_CONNECT_PORT: String(tokens.qqPort),
        QQ_COEXIST_CONNECT_TOKEN: tokens.qq,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    }
  )
  children.push({ name: 'qq-shell', child: qqShell })
  const avatarShell = spawn(
    'cmd',
    [
      '/d',
      '/c',
      resolve(ROOT, 'scripts/postlv2-avatar-production.cmd'),
      '--connect-host',
      '127.0.0.1',
      '--connect-port',
      String(tokens.avatarPort),
      '--connect-token',
      tokens.avatar,
    ],
    { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] }
  )
  children.push({ name: 'avatar-shell', child: avatarShell })
}

startShells()

/**
 * 有序停机：**关核心的 stdin**（计划 §6 的顺序：停新入站 → 排空 → 关库 → 释放租约）。
 * ⚠️ 两条外壳先停（不再提交新轮次），核心最后收尾。
 */
let stopping = false
async function stop(reason: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`\n开始有序停机（${reason}）：先停两条外壳，再关核心 stdin…`)
  for (const { name, child } of children) {
    if (name === 'core') continue
    try {
      child.kill()
    } catch {
      /* 外壳已经退出 */
    }
  }
  await delay(500)
  core.stdin?.end()
  const code = await Promise.race([coreExit, delay(180_000).then(() => 'timeout' as const)])
  console.log(`核心退出码：${String(code)}`)
  if (existsSync(STOP_SENTINEL)) rmSync(STOP_SENTINEL)
  process.exit(code === 0 ? 0 : 1)
}

process.once('SIGINT', () => void stop('Ctrl+C'))
process.once('SIGTERM', () => void stop('SIGTERM'))
/* 停机哨兵：`pnpm coexist:stop` 写它 ⇒ 这里走同一条有序停机 */
const sentinelTimer = setInterval(() => {
  if (existsSync(STOP_SENTINEL)) void stop('停机哨兵')
}, 500)
sentinelTimer.unref()
writeFileSync(resolve(RUNTIME_DIR, 'running.pid'), `${String(process.pid)}\n`, 'utf8')
