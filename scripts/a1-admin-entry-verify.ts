/**
 * A1 / **WP1c：可运营入口门**（凭证初始化 + 真 CLI + 端到端登录）。
 *
 * ============================================================================
 *  它守什么
 * ============================================================================
 * ```text
 * 正控：`init --password-file` 真的写出凭证文件 · 文件里**没有明文** · 目录在仓库外 ·
 *       读回哈希能验正确口令 · **真 CLI 子进程**退出码 0 · 用同一份哈希起真服务能登录成功
 * 负控：目录在仓库树内 ⇒ 拒 · 已存在且没给 force ⇒ 拒 · 口令过短 ⇒ 拒 · 口令为空 ⇒ 拒 ·
 *       非 TTY 且没给口令文件 ⇒ 拒 · `serve` 没有凭证 ⇒ 拒 · 坏 JSON 凭证 ⇒ 读回 undefined 且登录不可能
 * 恢复：`--force` 换口令后**旧口令失效、新口令可用**，且旧文件备份成 `.bak`
 * ⚠️ 本门用**临时目录**（`%TEMP%`）；**不**碰任何真实凭证目录、不连核心、不开库。
 * ```
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdminAuthError, verifyAdminPassword } from '../src/infrastructure/admin/auth.ts'
import {
  MIN_ADMIN_PASSWORD_LENGTH,
  credentialsPath,
  initAdminCredentials,
  isInsideRepository,
  passwordPolicyProblem,
  readAdminCredentials,
  verifyAdminCredentials,
} from '../src/infrastructure/admin/credentials.ts'
import { ADMIN_SESSION_COOKIE, createAdminAuthServer } from '../src/infrastructure/admin/server.ts'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const CLI = resolve(REPO_ROOT, 'scripts/a1-admin.ts')
const TSX = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}
const named = (code: string, run: () => unknown): boolean => {
  try {
    run()
    return false
  } catch (error) {
    return error instanceof AdminAuthError && error.code === code
  }
}

const work = mkdtempSync(join(tmpdir(), 'a1-admin-entry-'))
const outsideDir = join(work, 'admin-outside')
const insideDir = join(REPO_ROOT, 'artifacts', 'post-lv2', 'local', 'a1-should-not-be-used')
const PASSWORD = 'a1-wp1c-strong-password'
const NEXT_PASSWORD = 'a1-wp1c-rotated-password'

// ---------------------------------------------------------------------------
// 1. 正控：init（真 CLI 子进程）⇒ 文件 ⇒ 校验
// ---------------------------------------------------------------------------

const passwordFile = join(work, 'pw.txt')
writeFileSync(passwordFile, `${PASSWORD}\n`, 'utf8')

const cli = spawnSync(process.execPath, [TSX, CLI, 'init', '--dir', outsideDir, '--password-file', passwordFile], {
  encoding: 'utf8', cwd: REPO_ROOT, timeout: 120_000,
})
check('正控 真 CLI `init` 退出码 0', cli.status === 0, `status=${String(cli.status)} stderr=${cli.stderr.slice(0, 200)}`)
const filePath = credentialsPath(outsideDir)
check('正控 凭证文件真的写出来了', existsSync(filePath), filePath)
const fileText = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
check('正控 文件里**没有明文口令**', !fileText.includes(PASSWORD), fileText.slice(0, 80))
check('正控 CLI 输出里**没有**明文口令、也**没有**哈希', !cli.stdout.includes(PASSWORD) && !/scrypt\$/.test(cli.stdout), cli.stdout.trim().slice(0, 120))
const credentials = readAdminCredentials(outsideDir)
check('正控 读回凭证（version/adminId/passwordHash 齐）',
  credentials !== undefined && credentials.version === 1 && credentials.adminId !== '' && credentials.passwordHash.startsWith('scrypt$'),
  JSON.stringify({ ...credentials, passwordHash: 'scrypt$…' }))
check('正控 正确口令通过校验', verifyAdminCredentials(outsideDir, PASSWORD) === true, '应 true')
check('负控 错误口令不通过', verifyAdminCredentials(outsideDir, 'nope-nope-nope-nope') === false, '应 false')
check('负控 凭证目录**不在**仓库树内（判据 ② 的正控侧）', isInsideRepository(outsideDir, REPO_ROOT) === false, outsideDir)

// ---------------------------------------------------------------------------
// 2. 负控：四条硬规则逐条判红
// ---------------------------------------------------------------------------

check('负控 目录在仓库树内 ⇒ 具名拒绝 credentials_inside_repository',
  named('credentials_inside_repository', () => initAdminCredentials({
    location: { dir: insideDir, repoRoot: REPO_ROOT }, password: PASSWORD,
  })), '应拒')
check('负控 仓库根自己也算"仓库内"', isInsideRepository(REPO_ROOT, REPO_ROOT) === true, '应 true')
check('负控 前缀相似的兄弟目录**不**算仓库内（不是字符串前缀判断）',
  isInsideRepository(`${REPO_ROOT}-evil`, REPO_ROOT) === false, '应 false')
check('负控 已存在且没给 force ⇒ 具名拒绝 credentials_already_exist',
  named('credentials_already_exist', () => initAdminCredentials({
    location: { dir: outsideDir, repoRoot: REPO_ROOT }, password: NEXT_PASSWORD,
  })), '应拒')
check('负控 口令过短 ⇒ 具名拒绝 admin_password_too_short',
  named('admin_password_too_short', () => initAdminCredentials({
    location: { dir: join(work, 'short'), repoRoot: REPO_ROOT }, password: 'short',
  })), '应拒')
check('负控 口令为空 ⇒ 具名拒绝 admin_password_empty',
  named('admin_password_empty', () => initAdminCredentials({
    location: { dir: join(work, 'empty'), repoRoot: REPO_ROOT }, password: '',
  })), '应拒')
check('负控 口令策略判据本身：刚好下限通过、少一个字符拒',
  passwordPolicyProblem('x'.repeat(MIN_ADMIN_PASSWORD_LENGTH)) === undefined &&
  passwordPolicyProblem('x'.repeat(MIN_ADMIN_PASSWORD_LENGTH - 1)) === 'admin_password_too_short',
  `下限 ${String(MIN_ADMIN_PASSWORD_LENGTH)}`)

/* 非 TTY + 没给口令文件 ⇒ 拒（本进程的 stdin 不是 TTY ⇒ 这条能真跑） */
const nonTty = spawnSync(process.execPath, [TSX, CLI, 'init', '--dir', join(work, 'nontty')], {
  encoding: 'utf8', cwd: REPO_ROOT, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
})
check('负控 非 TTY 且没给口令文件 ⇒ 具名拒绝（退出码 1）',
  nonTty.status === 1 && nonTty.stderr.includes('admin_init_requires_tty'),
  `status=${String(nonTty.status)} stderr=${nonTty.stderr.slice(0, 120)}`)
check('负控 那条拒绝之后**没有**留下凭证文件', !existsSync(credentialsPath(join(work, 'nontty'))), '应不存在')

const serveNoCreds = spawnSync(process.execPath, [TSX, CLI, 'serve', '--dir', join(work, 'nope')], {
  encoding: 'utf8', cwd: REPO_ROOT, timeout: 120_000,
})
check('负控 `serve` 没有凭证 ⇒ 具名拒绝（退出码 2）',
  serveNoCreds.status === 2 && serveNoCreds.stderr.includes('没有可用的凭证'),
  `status=${String(serveNoCreds.status)}`)

const badDir = join(work, 'badjson')
initAdminCredentials({ location: { dir: badDir, repoRoot: REPO_ROOT }, password: PASSWORD })
writeFileSync(credentialsPath(badDir), '{ not json', 'utf8')
check('负控 坏 JSON 凭证 ⇒ 读回 undefined（失败关闭，不抛）', readAdminCredentials(badDir) === undefined, '应 undefined')
check('负控 坏 JSON 凭证 ⇒ 任何口令都不通过', verifyAdminCredentials(badDir, PASSWORD) === false, '应 false')

// ---------------------------------------------------------------------------
// 3. 端到端：用**真存储的哈希**起真服务并登录（WP1b 的接线）
// ---------------------------------------------------------------------------

const stored = readAdminCredentials(outsideDir)
const server = createAdminAuthServer({
  passwordHash: stored?.passwordHash ?? '', host: '127.0.0.1', port: 0, sessionTtlMs: 60_000,
})
await server.start()
const origin = `http://127.0.0.1:${String(server.port)}`
const loginOk = await fetch(`${origin}/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: PASSWORD }),
})
check('正控 端到端：凭证文件里的哈希 ⇒ 真服务登录 200', loginOk.status === 200, `status=${loginOk.status}`)
check('正控 端到端：登录拿到 HttpOnly 会话 cookie',
  loginOk.headers.getSetCookie().some((raw) => raw.startsWith(`${ADMIN_SESSION_COOKIE}=`) && /HttpOnly/i.test(raw)),
  loginOk.headers.getSetCookie().join(' | ').slice(0, 120))
const loginBad = await fetch(`${origin}/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: 'definitely-not-it' }),
})
check('负控 端到端：错口令 ⇒ 401', loginBad.status === 401, `status=${loginBad.status}`)
await server.stop()

// ---------------------------------------------------------------------------
// 4. 恢复：`--force` 换口令 ⇒ 旧失效、新可用、旧文件备份
// ---------------------------------------------------------------------------

writeFileSync(passwordFile, `${NEXT_PASSWORD}\n`, 'utf8')
const forced = spawnSync(process.execPath, [TSX, CLI, 'init', '--dir', outsideDir, '--password-file', passwordFile, '--force'], {
  encoding: 'utf8', cwd: REPO_ROOT, timeout: 120_000,
})
check('恢复 `init --force` 退出码 0', forced.status === 0, `status=${String(forced.status)} stderr=${forced.stderr.slice(0, 160)}`)
check('恢复 旧文件被备份成 .bak', existsSync(`${filePath}.bak`), `${filePath}.bak`)
check('恢复 新口令可用', verifyAdminCredentials(outsideDir, NEXT_PASSWORD) === true, '应 true')
check('恢复 旧口令**失效**', verifyAdminCredentials(outsideDir, PASSWORD) === false, '应 false')
check('恢复 备份文件里也没有明文', !readFileSync(`${filePath}.bak`, 'utf8').includes(PASSWORD), '应无明文')

// ---------------------------------------------------------------------------
// 5. 汇总（失败关闭）
// ---------------------------------------------------------------------------

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP1c 可运营入口：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 本门只覆盖"初始化 + 起服务 + 登录"这条链；业务面（WP2 起）与生产激活（独立授权）不在内。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
