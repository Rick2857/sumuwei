/**
 * A1 / **live 门（第二道 · 写路径）**：受控写面 `jobs.admit` 打**真库**。
 *
 * ============================================================================
 *  为什么**单独一道**，不并进只读那道
 * ============================================================================
 * ```text
 * `a1:serve:db:live:verify`（21 判据）的主张是"**只读**：前后两次只读快照逐项相同"。
 * 写路径**必然**产生新行（动作账本 + `admin_jobs`）⇒ 那条"逐项相同"对它是**假**的。
 * ⇒ 两条声明分开、分开验：**不**把"读干净"和"写进去"揉成一句含糊的话。
 *
 * 它证什么（三段式，真库）：
 * ```text
 * 正控 首次登记 ⇒ **201 `created`**，`state=pending`（"已提交（尚未执行）"）
 *      再登记同键同参数 ⇒ **200 `replayed`** 且**同一个 jobId**（幂等命中，不是第二次）
 *      登记后 `GET /api/jobs` 里**真的出现**那一行（表原本 0 行 ⇒ 空 ≠ 未接线）
 * 负控 同键**不同参数** ⇒ **409** `idempotency_conflict`
 *      重复跑（幂等命中）**不新增行**（`admin_jobs` 仍只有那一条）
 * ⚠️ **不主张**（具名）：无。**读回是门内判据**（WP3 最后一格）：
 *    停机后另起一个**只读**进程直连真库，断言 `character_action_events` 里
 *    本次那一行的 `initiator = SERVICE/admin-console` 且指纹就是回执里的 jobId。
 *    ⚠️ 读回**必须**在停机后跑（单持有租约：管理面开着时第二个进程开库会被拒 —— 那是保护）。
 * ⚠️ 本门**会写真库**（写 `admin_jobs` 与动作账本各一行）——这是用户 2026-10-14 裁定
 *    "按这个设计做"的直接后果，**不是**生产激活（管理面不在生产路径上，见 Gate-Decision §0）。
 * ```
 *
 * **跑法**：`LG_ADMIN_LIVE=1` + `LG_ADMIN_LIVE_PASSWORD_FILE=<临时口令文件>`（缺一 ⇒ 具名 NOT RUN，exit 2）
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from '../src/infrastructure/admin/server.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const TSX = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs')
const CLI = resolve(ROOT, 'scripts/a1-admin.ts')
const PORT = 19395

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}
const notRun: string[] = []

if (process.env.LG_ADMIN_LIVE !== '1') {
  console.log('[NOT RUN] 写路径 live 门需要显式开启（它**会写真库**）：\n  $env:LG_ADMIN_LIVE=1; $env:LG_ADMIN_LIVE_PASSWORD_FILE=<文件>; pnpm a1:jobs-admit:live:verify')
  process.exit(2)
}
const passwordFile = process.env.LG_ADMIN_LIVE_PASSWORD_FILE?.trim()
const password = passwordFile !== undefined && passwordFile !== '' && existsSync(passwordFile)
  ? readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '')
  : undefined
if (password === undefined) {
  console.log('[NOT RUN] 没给 `LG_ADMIN_LIVE_PASSWORD_FILE`（口令只有操作者知道，本门不猜、不存、不打印）')
  process.exit(2)
}

const child = spawn(process.execPath, [TSX, CLI, 'serve', '--with-db', '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let stdout = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk: string) => { stdout += chunk })
child.stderr.setEncoding('utf8')
child.stderr.on('data', () => { /* 库日志不打印 */ })

const origin = `http://127.0.0.1:${String(PORT)}`
const waitFor = async (test: () => boolean, label: string, attempts = 480): Promise<void> => {
  for (let i = 0; i < attempts; i++) {
    if (test()) return
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`超时：${label}`)
}

let jobIdSeen = ''
try {
  await waitFor(() => /https?:\/\/127\.0\.0\.1:\d+/.test(stdout), '服务打印 URL')
  const login = await fetch(`${origin}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ password }),
  })
  const cookie = login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
  const csrf = login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`${ADMIN_CSRF_COOKIE}=`))?.split('=')[1] ?? ''
  check('前置 登录 200 且拿到会话 + CSRF', login.status === 200 && cookie !== '' && csrf !== '', `status=${login.status}`)
  const authed = {
    cookie: `${ADMIN_SESSION_COOKIE}=${cookie}; ${ADMIN_CSRF_COOKIE}=${csrf}`,
    'x-lg-admin-csrf': csrf, origin, 'content-type': 'application/json',
  }

  /* 幂等键带本轮随机后缀 ⇒ 不会撞上历史那一行（表里那条是别的轮留下的） */
  const key = `live-admit-${String(Date.now())}`
  const post = async (params: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${origin}/api/jobs`, {
      method: 'POST', headers: authed, body: JSON.stringify({ idempotencyKey: key, params }),
    })
    return { status: response.status, json: (await response.json()) as Record<string, unknown> }
  }

  const created = await post({ probe: 'live-write-1' })
  jobIdSeen = String(created.json.jobId ?? '')
  check('正控 首次登记 ⇒ **201 `created`** 且 `state=pending`（**不是**"完成"）',
    created.status === 201 && created.json.admission === 'created' && created.json.state === 'pending',
    JSON.stringify(created.json))
  check('正控 回执里的 `jobId` 是非空字符串（**不是**编出来的 0/undefined）',
    jobIdSeen !== '' && jobIdSeen !== 'undefined' && jobIdSeen !== '0', jobIdSeen)

  const replay = await post({ probe: 'live-write-1' })
  check('正控 同键同参数 ⇒ **200 `replayed`** 且**同一个 jobId**（幂等命中，不是第二次）',
    replay.status === 200 && replay.json.admission === 'replayed' && replay.json.jobId === jobIdSeen,
    JSON.stringify(replay.json))

  const conflicted = await post({ probe: 'live-write-DIFFERENT' })
  check('负控 同键**不同参数** ⇒ **409** `idempotency_conflict`（明确拒绝，不静默新建）',
    conflicted.status === 409 && conflicted.json.error === 'idempotency_conflict',
    JSON.stringify(conflicted.json))

  /* 读回：`GET /api/jobs` 里必须**真的出现**那一行（表原本 0 行 ⇒ 空 ≠ 未接线） */
  const jobs = await fetch(`${origin}/api/jobs`, { headers: { cookie: authed.cookie ?? '' } })
  const jobsBody = (await jobs.json()) as { items?: { jobId?: string; state?: string }[] }
  const found = (jobsBody.items ?? []).some((item) => item.jobId === jobIdSeen)
  check('正控 读回 `GET /api/jobs` **真的出现**那一行（表原本 0 行 ⇒ 空 ≠ 未接线）', found,
    `items=${JSON.stringify((jobsBody.items ?? []).map((item) => item.jobId))}`)
  check('负控 幂等命中**不新增行**：`admin_jobs` 里同一个 jobId 只出现一次',
    (jobsBody.items ?? []).filter((item) => item.jobId === jobIdSeen).length === 1,
    `出现 ${String((jobsBody.items ?? []).filter((item) => item.jobId === jobIdSeen).length)} 次`)

  /*
 * ⚠️ 这里**曾经**留过一条 NOT RUN（"initiator 需直连读回"）；它已被下方**门内**读回取代，
 *   留着就成了"同一件事既 PASS 又 NOT RUN"的自相矛盾。已删。
 */
} catch (error) {
  check('写路径流程未抛错地跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  child.kill()
  await new Promise((done) => setTimeout(done, 800))
}
let stopped = false
try {
  await fetch(`${origin}/session`)
} catch {
  stopped = true
}
check('收尾 停机后端口不再响应（**必须**：它持有库连接与资格锁）', stopped, stopped ? 'ok' : '仍在听')

/*
 * ⚠️ 读回**必须**在停机**之后**跑：本机库有单持有租约（`production_db_in_use`），
 *   管理面开着的时候第二个进程开库会被拒 —— 那是保护，不是故障。
 * ⚠️ 读回脚本是**只读**（一条 select，不开迁移、不写）。
 */
const readback = await new Promise<{ code: number; stdout: string }>((resolvePromise) => {
  const reader = spawn(process.execPath, [
    TSX, resolve(ROOT, 'scripts/admin-audit-readback.ts'), '--limit', '5', '--capability', 'admin.jobs.admit',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  reader.stdout.setEncoding('utf8')
  reader.stdout.on('data', (chunk: string) => { out += chunk })
  reader.stderr.setEncoding('utf8')
  reader.stderr.on('data', () => { /* 开库日志不打印 */ })
  reader.on('close', (code) => resolvePromise({ code: code ?? -1, stdout: out }))
})
/*
 * ⚠️ 第一版用 `lastIndexOf('{')` 切 JSON —— **错**：JSON 里有嵌套对象，
 *   最后一个 `{` 在中间 ⇒ 切出半截 ⇒ `JSON.parse` 失败 ⇒ 判据读成"账本里没有那一行"，
 *   **把量具自己的错说成了代码的错**（比不报更坏）。正解：`indexOf`（顶层 `{` 是第一个）。
 * ⚠️ 解析不了就把子进程输出**原样打出来** —— 量具自己出错时必须能看出自己错在哪。
 */
const jsonStart = readback.stdout.indexOf('{')
let parsed: { ok?: boolean; records?: { eventType?: string; idempotencyKey?: string; initiator?: string; effectFingerprint?: string | null }[] } | undefined
try {
  parsed = JSON.parse(jsonStart >= 0 ? readback.stdout.slice(jsonStart) : '') as typeof parsed
} catch (error) {
  parsed = undefined
  console.log(`⚠️ 读回输出解析失败（**这是量具的问题，不是账本的问题**）：${error instanceof Error ? error.message : String(error)}`)
  console.log(`   读回子进程 stdout（截断 1200 字）：\n${readback.stdout.slice(0, 1200)}`)
  console.log(`   读回子进程 exit=${readback.code}`)
}
check('前置 读回子进程 exit=0（只读脚本自己跑通了）', readback.code === 0, `exit=${readback.code}`)
check('前置 读回输出能解析成 JSON（量具自检：解析不了就不该谈读数）',
  parsed !== undefined && parsed.ok === true, parsed === undefined ? '解析失败（见上方 ⚠️）' : `ok=${String(parsed.ok)}`)
const succeeded = (parsed?.records ?? []).find(
  (row) => row.eventType === 'ACTION_SUCCEEDED' && row.effectFingerprint === jobIdSeen
)
check('正控 **直连真库读回**：那一行的权威 initiator = `SERVICE/admin-console`（不是 UNKNOWN）',
  succeeded !== undefined && succeeded.initiator === 'SERVICE/admin-console',
  succeeded === undefined ? '账本里没有本次 jobId 的 ACTION_SUCCEEDED 行' : String(succeeded.initiator))
check('正控 读回那一行的 `effectFingerprint` 就是回执里的 jobId（同一件事，不是两件事）',
  succeeded?.effectFingerprint === jobIdSeen && jobIdSeen !== '',
  `读回=${String(succeeded?.effectFingerprint ?? '无')} · 回执=${jobIdSeen}`)

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
for (const reason of notRun) console.log(`NOT RUN  ${reason}`)
console.log(`\nA1 / WP4 live（写路径 jobs.admit）：判据 ${checks.length} · 失败 ${failed.length} · 未运行 ${notRun.length} · measured_count=${checks.length}`)
console.log('⚠️ 本门**会写真库**（admin_jobs + 动作账本各一行）——这是写面裁定的直接后果，**不是**生产激活。')
if (failed.length > 0) process.exit(1)
if (notRun.length > 0) process.exit(2)
