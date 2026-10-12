/**
 * post-Lv2 / **ADR-109 WP5** —— 共存运行时的**就绪判据**与入口令牌（只读 / 失败关闭）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 * · 入口令牌：生成 / 读取 `artifacts/post-lv2/local/coexist-runtime/entry-tokens.json`
 *             （**gitignore**；不进仓库、不进日志）
 * · 就绪判据（**只读**，不打开任何数据库）：
 *     ① `.env` 里有 `CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true`（否则核心**拒绝启动**）
 *     ② `.env.qq` 的 QQ 账号/令牌形状合法
 *     ③ 两个端口可用（起监听前先探）
 *     ④ 旧 QQ 入口是否**正在跑**（真实库单持有 ⇒ 切换前必须先停它）
 * ```
 * ⚠️ 它**不**启动任何东西、**不**打开真实库、**不**改 `.env`。
 * ⚠️ "旧入口在跑"是**读数**，不是判据：`--check` 只如实报，由人决定下一步。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import { readQqPrivateConfig } from '../../src/infrastructure/qq/private-config.ts'

export const ROOT = resolve(import.meta.dirname, '..', '..')
export const RUNTIME_DIR = resolve(ROOT, 'artifacts/post-lv2/local/coexist-runtime')
export const TOKEN_FILE = resolve(RUNTIME_DIR, 'entry-tokens.json')
export const STOP_SENTINEL = resolve(RUNTIME_DIR, 'STOP')

export interface EntryTokens {
  readonly qq: string
  readonly avatar: string
  readonly qqPort: number
  readonly avatarPort: number
  readonly cli?: string
  readonly cliPort?: number
}

/** 读令牌；不存在就**生成并落盘**（与 `pnpm qq:prepare` 同一条纪律：只生成一次） */
export function ensureEntryTokens(options: { create: boolean } = { create: false }): EntryTokens {
  if (existsSync(TOKEN_FILE)) {
    const parsed = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as Partial<EntryTokens>
    if (
      typeof parsed.qq === 'string' &&
      typeof parsed.avatar === 'string' &&
      Number.isSafeInteger(parsed.qqPort) &&
      Number.isSafeInteger(parsed.avatarPort)
    ) {
      if (options.create && parsed.cli === undefined) {
        Object.assign(parsed, { cli: randomBytes(24).toString('hex'), cliPort: 6753 })
        writeFileSync(TOKEN_FILE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
      }
      if (parsed.cli !== undefined && (typeof parsed.cli !== 'string' || parsed.cli.length < 16 || !Number.isSafeInteger(parsed.cliPort))) throw new Error('控制台入口令牌形状不完整')
      return parsed as EntryTokens
    }
    throw new Error(`${TOKEN_FILE} 存在但形状不完整：拒绝猜`)
  }
  if (!options.create) {
    throw new Error(`入口令牌不存在（${TOKEN_FILE}）：先跑 \`pnpm coexist:prepare\``)
  }
  const tokens: EntryTokens = {
    qq: randomBytes(24).toString('hex'),
    avatar: randomBytes(24).toString('hex'),
    qqPort: 6751,
    avatarPort: 6752,
    cli: randomBytes(24).toString('hex'), cliPort: 6753,
  }
  mkdirSync(RUNTIME_DIR, { recursive: true })
  writeFileSync(TOKEN_FILE, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8')
  return tokens
}

async function portFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
  })
}

/** 旧 QQ 入口是否在跑（**读数**：真实库单持有 ⇒ 切换前必须先停它） */
export function oldQqEntryRunning(): boolean {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match '--bridge --qq-private' }).ProcessId -join ','",
      ],
      { encoding: 'utf8' }
    )
    return out.trim() !== ''
  } catch {
    return false
  }
}

export interface Readiness {
  readonly ok: boolean
  readonly problems: string[]
  readonly notes: string[]
  readonly tokens: EntryTokens
}

/**
 * 就绪判据（**只读**）。任何一条不满足 ⇒ `ok=false` 且**列出来**（不猜、不自动修）。
 */
export async function checkReadiness(options: { createTokens?: boolean } = {}): Promise<Readiness> {
  const problems: string[] = []
  const notes: string[] = []
  const env = parse(readFileSync(resolve(ROOT, '.env'), 'utf8'))

  if ((env.CHARACTER_ENTRY_SCOPED_CONVERSATIONS ?? '').trim().toLowerCase() !== 'true') {
    problems.push(
      '`.env` 里 `CHARACTER_ENTRY_SCOPED_CONVERSATIONS` 不是 `true` ⇒ `--coexist` 会**拒绝启动**' +
        '（两条入口会写进同一条会话 = 假隔离）。'
    )
  }
  try {
    const qqEnv = parse(readFileSync(resolve(ROOT, '.env.qq'), 'utf8'))
    const settings = readQqPrivateConfig(qqEnv)
    notes.push(`QQ 账号：owner=${settings.ownerId} bot=${settings.botId}（形状合法）`)
  } catch (error) {
    problems.push(`\`.env.qq\` 不可用：${error instanceof Error ? error.message : String(error)}`)
  }

  let tokens: EntryTokens
  try {
    tokens = ensureEntryTokens({ create: options.createTokens === true })
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
    tokens = { qq: '', avatar: '', qqPort: 6751, avatarPort: 6752 }
  }
  if (tokens.qq !== '') {
    for (const [label, port] of [
      ['QQ', tokens.qqPort],
      ['皮套', tokens.avatarPort],
      ...(tokens.cli ? [['控制台', tokens.cliPort!] as const] : []),
    ] as const) {
      if (await portFree(port)) notes.push(`${label} 监听端口 ${String(port)} 空闲`)
      else problems.push(`${label} 监听端口 ${String(port)} **被占用**`)
    }
  }

  if (oldQqEntryRunning()) {
    notes.push(
      '⚠️ **旧 QQ 入口正在运行**（`--bridge --qq-private`）：真实库是**跨进程单持有**资源，' +
        '启动共存核心之前必须**先正常停掉它**（`Ctrl+C` 排空 → 退出 → 租约释放）。'
    )
  } else {
    notes.push('旧 QQ 入口当前**没有**在运行（可以切换）')
  }
  if (existsSync(STOP_SENTINEL)) {
    notes.push(`⚠️ 停机哨兵存在（${STOP_SENTINEL}）：下次启动会**立刻**收到停机信号，先删掉它。`)
  }
  return { ok: problems.length === 0, problems, notes, tokens }
}

/** 授权串：**逐字**（与 `PROJECT_LG_ALLOW_RESTORE_APPLY` 同一条纪律，布尔开关不算授权） */
export function activationAuthorization(dataDir: string): string {
  return `coexist@${resolve(dataDir)}`
}
