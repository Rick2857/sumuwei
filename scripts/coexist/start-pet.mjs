/**
 * post-Lv2 / ADR-109 WP5 —— **启动皮套外壳（连接档）**。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 * 读 `artifacts/post-lv2/local/coexist-runtime/entry-tokens.json`（gitignore）
 *   → 用**生产皮套启动器**（`scripts/postlv2-avatar-production.cmd`）
 *     带上 `--connect-host/--connect-port/--connect-token`
 *   → 皮套外壳**连到共存核心的皮套入口**，不再自己起 LG 子进程
 * ```
 *
 * ⚠️ 前提：共存核心**已经在跑**（`pnpm coexist:start`）。核心没跑时这条命令会
 *    连不上并如实报错 —— 它**不会**回落成"自己起一个子进程"（那会去抢正式库租约）。
 * ⚠️ 它**不**改任何配置：端口与令牌都从令牌文件读，且**不打印令牌取值**。
 * ⚠️ 退出：在那个窗口按 Ctrl+C（皮套外壳只关**它这一条连接**，核心照常跑）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TOKENS = resolve(ROOT, 'artifacts/post-lv2/local/coexist-runtime/entry-tokens.json')

if (!existsSync(TOKENS)) {
  console.error(`❌ 找不到入口令牌：${TOKENS}`)
  console.error('   先跑 `pnpm coexist:prepare`。')
  process.exit(2)
}
const tokens = JSON.parse(readFileSync(TOKENS, 'utf8')) as {
  avatarPort?: number
  avatar?: string
}
if (!Number.isSafeInteger(tokens.avatarPort) || typeof tokens.avatar !== 'string' || tokens.avatar === '') {
  console.error('❌ 令牌文件里没有可用的皮套入口（avatarPort / avatar）')
  process.exit(2)
}

console.log('皮套外壳将以**连接档**启动（不再自己持有数据库）')
console.log(`  连到：127.0.0.1:${String(tokens.avatarPort)}（令牌不打印）`)
console.log('  退出：在这个窗口按 Ctrl+C（只关这一条连接，核心继续跑）')
console.log('')

const child = spawn(
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
  { cwd: ROOT, stdio: 'inherit' }
)
child.once('close', (code) => process.exit(code ?? 0))
