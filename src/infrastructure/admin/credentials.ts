/**
 * A1 / **WP1c：管理后台的凭证存放**（`ADR-135` `D16` / `R-A1-4`）。
 *
 * ============================================================================
 *  四条硬规则（都在本文件里以程序判据实现，不靠"记得这么做"）
 * ============================================================================
 * ```text
 * ① 只存**哈希**：文件里永远没有明文口令（`passwordHash` 是 `scrypt$…` 存储串）
 * ② **不许放进仓库树**：目标目录落在仓库根之下 ⇒ 具名拒绝（`credentials_inside_repository`）
 *    —— 理由不是洁癖：仓库有 git、有 artifacts 副本、有公开导出流程，凭证进去就等于泄露面
 * ③ **不静默覆盖**：已存在 ⇒ 具名拒绝；要换口令必须显式 `force`（并把旧文件先备份成 `.bak`）
 * ④ **口令下限 12 字符**：初始化时就拒，避免"能登进去但等于没有口令"
 * ```
 * ⚠️ 本模块**不**读环境、**不**开端口：目录由调用方给出（CLI 解析 `--dir` / `LG_ADMIN_CREDENTIALS_DIR`）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { AdminAuthError, hashAdminPassword, verifyAdminPassword } from './auth.ts'

/** 凭证文件名（固定；目录可配） */
export const ADMIN_CREDENTIALS_FILENAME = 'admin-credentials.json'

/** 口令下限（初始化时拒短口令） */
export const MIN_ADMIN_PASSWORD_LENGTH = 12

export interface AdminCredentials {
  readonly version: 1
  readonly adminId: string
  readonly passwordHash: string
  readonly createdAt: string
}

export interface CredentialsLocation {
  /** 目录（**仓库外**） */
  readonly dir: string
  /** 仓库根（判据 ② 用；调用方给，避免本模块猜 cwd） */
  readonly repoRoot: string
}

/** 凭证文件的绝对路径 */
export function credentialsPath(dir: string): string {
  return join(resolve(dir), ADMIN_CREDENTIALS_FILENAME)
}

/**
 * 判据 ②：目录是否落在仓库树内（含"就是仓库根"）。
 *
 * ⚠️ 用 `relative` + 分隔符判断，**不**用字符串 `startsWith`：
 *    `C:\repo-evil` 会以 `C:\repo` 为前缀，但那不是"仓库内"。
 */
export function isInsideRepository(dir: string, repoRoot: string): boolean {
  const target = resolve(dir)
  const root = resolve(repoRoot)
  if (target === root) return true
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`${sep}..`)
}

/** 口令策略（判据 ④）：短口令/空白口令一律拒 */
export function passwordPolicyProblem(password: string): string | undefined {
  if (typeof password !== 'string' || password === '') return 'admin_password_empty'
  if (password.trim().length < MIN_ADMIN_PASSWORD_LENGTH) return 'admin_password_too_short'
  return undefined
}

export interface InitReading {
  readonly path: string
  readonly adminId: string
  readonly replacedExisting: boolean
  /** 明文是否出现在文件里（**永远** false；作为读数写出来，便于门断言） */
  readonly plaintextStored: false
}

/**
 * 初始化凭证（判据 ①②③④ 全在这里）。
 *
 * ⚠️ 明文口令**只**作为参数经过本函数，不落盘、不进日志、不进返回值。
 */
export function initAdminCredentials(input: {
  location: CredentialsLocation
  password: string
  adminId?: string
  force?: boolean
  now?: () => Date
}): InitReading {
  const { dir, repoRoot } = input.location
  if (isInsideRepository(dir, repoRoot)) {
    throw new AdminAuthError(
      'credentials_inside_repository',
      `拒绝：凭证目录落在仓库树内（${resolve(dir)}）—— 仓库有 git / artifacts 副本 / 公开导出流程。\n` +
        '  请指向仓库外（缺省建议 %LOCALAPPDATA%\\project-lg-admin）。'
    )
  }
  const policy = passwordPolicyProblem(input.password)
  if (policy !== undefined) {
    throw new AdminAuthError(
      policy,
      policy === 'admin_password_empty'
        ? '拒绝：口令为空。'
        : `拒绝：口令少于 ${String(MIN_ADMIN_PASSWORD_LENGTH)} 个字符。`
    )
  }
  const path = credentialsPath(dir)
  const existing = existsSync(path)
  if (existing && input.force !== true) {
    throw new AdminAuthError(
      'credentials_already_exist',
      `拒绝：凭证文件已存在（${path}）。要换口令请显式给 force（旧文件会先备份成 .bak）。`
    )
  }
  mkdirSync(dir, { recursive: true })
  if (existing) renameSync(path, `${path}.bak`)
  const adminId = input.adminId ?? 'admin'
  const credentials: AdminCredentials = {
    version: 1,
    adminId,
    passwordHash: hashAdminPassword(input.password),
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  }
  const text = `${JSON.stringify(credentials, null, 2)}\n`
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 })
  return { path, adminId, replacedExisting: existing, plaintextStored: false }
}

/** 读凭证（**失败关闭**：缺文件/坏 JSON/字段不全 ⇒ `undefined`，不抛） */
export function readAdminCredentials(dir: string): AdminCredentials | undefined {
  const path = credentialsPath(dir)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AdminCredentials>
    if (parsed.version !== 1) return undefined
    if (typeof parsed.passwordHash !== 'string' || parsed.passwordHash === '') return undefined
    if (typeof parsed.adminId !== 'string' || parsed.adminId === '') return undefined
    return {
      version: 1,
      adminId: parsed.adminId,
      passwordHash: parsed.passwordHash,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    }
  } catch {
    return undefined
  }
}

/** 校验口令（缺凭证 ⇒ false；**不**区分"文件坏"与"口令错"） */
export function verifyAdminCredentials(dir: string, password: string): boolean {
  const credentials = readAdminCredentials(dir)
  if (credentials === undefined) return false
  return verifyAdminPassword(password, credentials.passwordHash)
}

/** 凭证目录的**人读**说明（`serve` 打印用；**不含**任何哈希片段） */
export function describeCredentialsDir(dir: string): string {
  return `${resolve(dir)}${sep}${ADMIN_CREDENTIALS_FILENAME}`
}

/** 供 CLI 用：`--dir` 缺省（仓库外） */
export function defaultCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.LG_ADMIN_CREDENTIALS_DIR?.trim()
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const localAppData = env.LOCALAPPDATA?.trim()
  if (localAppData !== undefined && localAppData !== '') return join(localAppData, 'project-lg-admin')
  /* 非 Windows / 无 LOCALAPPDATA：退到用户主目录（**仍然**在仓库外） */
  const home = env.USERPROFILE?.trim() ?? env.HOME?.trim()
  return home !== undefined && home !== '' ? join(home, '.project-lg-admin') : join(dirname(resolve('.')), 'project-lg-admin')
}
