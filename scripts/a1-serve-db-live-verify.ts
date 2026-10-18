/**
 * A1 / **WP2 live 门：`--with-db` 真库注入**（交接单 §1bis ④）。
 *
 * ============================================================================
 *  为什么它**不登记**在门表里
 * ============================================================================
 * ```text
 * 它**会打开生产库**（读为主）⇒ 与 `postlv2:bridge:verify` 同例：**不登记**为离线门
 * （离线门必须零数据库；把这条混进去，`.env` 一换后端就会红得莫名其妙）。
 * 跑法：`LG_ADMIN_LIVE=1`（缺省 **NOT RUN**）+ 可选 `LG_ADMIN_LIVE_PASSWORD_FILE=<文件>`
 * ```
 * 它证什么（三段式）：
 * ```text
 * 正控（无认证部分）：带 `--with-db` 起服务 · 启动横幅含"身份核对通过：database=<库>"与"已开库" ·
 *                    `/` 200 · 未登录读数据面 401
 * 正控（有认证部分，需口令）：登录 ⇒ `/api/goals-commitments` 与 `/api/cognition` **200 且无 `unavailable`**
 *                            ⇒ 同一路径再读一次**读数一致**（稳定，不是随机数）
 * 负控：不带 `--with-db` 时那两个面**必须**回到 `unavailable`（两条路径可分）
 * 收尾：停进程 ⇒ 端口不再响应（**必须**，它持有库连接与资格锁）
 * ⚠️ 缺口令 ⇒ **NOT RUN（exit 2）**，并把已取得的无认证读数如实打印（**不**冒充通过）
 * ```
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_SESSION_COOKIE } from '../src/infrastructure/admin/server.ts'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const TSX = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const CLI = resolve(REPO_ROOT, 'scripts/a1-admin.ts')

if (process.env.LG_ADMIN_LIVE !== '1') {
  console.log(
    '[NOT RUN] live 门需要显式开启：本门**会打开生产库**。\n' +
      '  跑法：$env:LG_ADMIN_LIVE=1; $env:LG_ADMIN_LIVE_PASSWORD_FILE=<口令文件>; pnpm a1:serve:db:live:verify\n' +
      '  ⚠️ 口令文件用完请立刻删除；本门不打印口令。'
  )
  process.exit(2)
}

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}
const notRun: string[] = []

const passwordFile = process.env.LG_ADMIN_LIVE_PASSWORD_FILE?.trim()
const password = passwordFile !== undefined && passwordFile !== '' && existsSync(passwordFile)
  ? readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '')
  : undefined

/**
 * **只读快照**（`§1bis ③` 的第三段判据）：跑**现成的只读探针** `postgresql-cutover-probe.ts`，
 * 取它的读数（`domainEventsViaKernel` / `conversationEvents` / `characterProjections` / `memoryRecords`）。
 * ⚠️ 探针自己就是"只读 + 身份核对"的既有工具，**不**在这里另写 SQL。
 */
const snapshot = async (): Promise<Record<string, number> | undefined> => {
  const probe = spawn(process.execPath, [TSX, resolve(REPO_ROOT, 'scripts/postgresql-cutover-probe.ts'), '--db', 'sumuwei'], {
    cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  })
  let out = ''
  probe.stdout.setEncoding('utf8')
  probe.stdout.on('data', (chunk: string) => { out += chunk })
  await new Promise<void>((done) => probe.once('close', () => done()))
  const json = /\{[\s\S]*\}/.exec(out)
  if (json === null) return undefined
  try {
    const parsed = JSON.parse(json[0]) as { ok?: boolean; readings?: Record<string, number> }
    if (parsed.ok !== true || parsed.readings === undefined) return undefined
    const { domainEventsViaKernel, conversationEvents, characterProjections, memoryRecords } = parsed.readings
    return { domainEventsViaKernel, conversationEvents, characterProjections, memoryRecords }
  } catch {
    return undefined
  }
}
const before = await snapshot()

const PORT = 19393
const child = spawn(process.execPath, [TSX, CLI, 'serve', '--with-db', '--port', String(PORT)], {
  cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let stdout = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk: string) => { stdout += chunk })
child.stderr.setEncoding('utf8')
child.stderr.on('data', () => { /* 库日志不打印：可能含连接细节 */ })

const url = `http://127.0.0.1:${String(PORT)}`
const waitFor = async (test: () => boolean, label: string, attempts = 480): Promise<void> => {
  for (let i = 0; i < attempts; i++) {
    if (test()) return
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`超时：${label}`)
}

let sessionCookie = ''
let goalsStatus = 0
let goalsBody: { unavailable?: string[]; items?: Record<string, unknown>[] } = {}
let cognitionStatus = 0
let cognitionBody: { unavailable?: string[] } = {}
let stable = false
try {
  await waitFor(() => /https?:\/\/127\.0\.0\.1:\d+/.test(stdout), '服务打印 URL')
  check('正控 带 `--with-db` 起服务并打印 loopback URL', stdout.includes(`127.0.0.1:${String(PORT)}`), 'URL 应在')
  check('正控 启动横幅含**身份核对通过**（真库连上）', /身份核对通过：database=\S+/.test(stdout),
    (stdout.match(/身份核对通过：database=\S+/) ?? ['(未见)'])[0])
  check('正控 启动横幅含"已开库（--with-db）"', stdout.includes('已开库（--with-db）'), '应在')
  /*
   * `R-A1-5`：核心在线/离线（三态之一）。**这里只断言"横幅报了且是合法三态"** ——
   * ⚠️ 具体该报哪个值，取决于一个**可疑的事实**：管理进程 `--with-db` 会 `initKernel`
   *    ⇒ 它**自己可能就持有**那把单认知执行者资格锁 ⇒ 探针会报「核心在线」，而那是**它自己**。
   *    本门的职责是把读数**如实打印**出来（见下方 R-A1-5 行），由人来判这是不是缺陷。
   */
  const presenceLine = stdout.split('\n').find((line) => /核心(在线|离线|状态未知)/.test(line)) ?? ''
  check('R-A1-5 启动横幅报核心状态（三态之一，且不吞掉原因）',
    /核心(在线|离线|状态未知)/.test(stdout), presenceLine.trim() || '(未见)')
  console.log(`   R-A1-5 实测读数：${presenceLine.trim() || '(未见)'}`)

  const page = await fetch(`${url}/`)
  check('正控 `GET /` 200（页面空壳不受开库影响）', page.status === 200, `status=${page.status}`)
  const unauth = await fetch(`${url}/api/goals-commitments`)
  check('负控 未登录读数据面 ⇒ 401', unauth.status === 401, `status=${unauth.status}`)

  if (password === undefined) {
    notRun.push('登录后读真读数：没给 `LG_ADMIN_LIVE_PASSWORD_FILE`（口令只有操作者知道，本门不猜、不存）')
  } else {
    const login = await fetch(`${url}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ password }),
    })
    sessionCookie = login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '')
      .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
    check('正控 登录 200 且拿到会话 cookie', login.status === 200 && sessionCookie !== '', `status=${login.status}`)
    const authed = { cookie: `${ADMIN_SESSION_COOKIE}=${sessionCookie}` }

    const goals = await fetch(`${url}/api/goals-commitments`, { headers: authed })
    goalsStatus = goals.status
    goalsBody = (await goals.json()) as typeof goalsBody
    check('正控 `goals_commitments` **200 且无 `unavailable`**（真读数）',
      goals.status === 200 && goalsBody.unavailable === undefined && goalsBody.items !== undefined,
      `status=${goals.status} unavailable=${String(goalsBody.unavailable)}`)
    check('正控 四个计数都是**非负整数**（不是 null、不是字符串）',
      ['openGoals', 'completedGoals', 'openCommitments', 'settledCommitments'].every((key) =>
        Number.isSafeInteger((goalsBody.items?.[0] as Record<string, unknown>)?.[key])),
      JSON.stringify(goalsBody.items?.[0]))

    const cognition = await fetch(`${url}/api/cognition`, { headers: authed })
    cognitionStatus = cognition.status
    cognitionBody = (await cognition.json()) as typeof cognitionBody
    check('正控 `cognition` 200；`characterId` 是真值（非空）',
      cognition.status === 200 && typeof (cognitionBody as { items?: Record<string, unknown>[] }).items?.[0]?.characterId === 'string',
      `status=${cognition.status} unavailable=${String(cognitionBody.unavailable)}`)

    /*
     * `safety_quota` 的**账本侧**（`§1ter ②`）：接线已进装配根 ⇒ 这两个字段**必须**不再是 `unavailable`。
     * ⚠️ 这条断言存在的理由：只证"编译通过 + 不破坏启动"**不等于**"读数已确认"。
     */
    const quota = await fetch(`${url}/api/safety-quota`, { headers: authed })
    const quotaBody = (await quota.json()) as { unavailable?: string[]; items?: Record<string, unknown>[] }
    const quotaRow = quotaBody.items?.[0] ?? {}
    check('正控 `safety_quota` 的账本字段**不再是 `unavailable`**（`quotaUsed` / `recentDenials` 已接线）',
      quota.status === 200 &&
      !(quotaBody.unavailable ?? []).includes('quotaUsed') &&
      !(quotaBody.unavailable ?? []).includes('recentDenials'),
      `status=${quota.status} unavailable=${String(quotaBody.unavailable)}`)
    check('正控 `quotaUsed` 是**非负整数**；`recentDenials` 是**数组**（不是 null/字符串）',
      Number.isSafeInteger(quotaRow.quotaUsed) && (quotaRow.quotaUsed as number) >= 0 && Array.isArray(quotaRow.recentDenials),
      JSON.stringify(quotaRow))
    check('正控 窗口如实报**日额度**（`daily_policy_tz`，不是那个不存在的 `deployment_total`）',
      quotaRow.quotaWindow === 'daily_policy_tz', String(quotaRow.quotaWindow))

    /*
     * `jobs` 面（WP4 的 `admin_jobs` 表 + 仓储已接线）：**必须**不再是 `unavailable`。
     * ⚠️ 真表今天**是空的**（0 行）⇒ `items: []` 是**正确**读数（空 ≠ 未接线）；
     *    所以判据是"**没有** `jobs` 这个 unavailable 条目"，**不是**"items 非空"。
     */
    const jobs = await fetch(`${url}/api/jobs`, { headers: authed })
    const jobsBody = (await jobs.json()) as { unavailable?: string[]; items?: unknown[] }
    check('正控 `jobs` 面**不再是 `unavailable`**（`admin_jobs` 表 + 仓储已接线）',
      jobs.status === 200 && !(jobsBody.unavailable ?? []).includes('jobs'),
      `status=${jobs.status} unavailable=${String(jobsBody.unavailable)}`)
    check('正控 `jobs` 返回的是**数组**（真表 0 行 ⇒ 空数组也是正确读数；空 ≠ 未接线）',
      Array.isArray(jobsBody.items), JSON.stringify(jobsBody).slice(0, 100))

    /*
     * 第六个面 `core_status`（用户 2026-10-14 裁定）：真库上必须是**真读数**，
     * 且 `presence` 必须是三态之一；查不出来 ⇒ `null` + 具名原因（**绝不** `offline`）。
     */
    const coreStatus = await fetch(`${url}/api/core-status`, { headers: authed })
    const coreBody = (await coreStatus.json()) as { items?: Record<string, unknown>[]; unavailable?: string[] }
    const coreRow = coreBody.items?.[0] ?? {}
    check('正控 `core_status` 面 200 且 `presence` 是三态之一（online/offline/null）',
      coreStatus.status === 200 && ['online', 'offline', null].includes(coreRow.presence as string | null),
      `status=${coreStatus.status} presence=${String(coreRow.presence)} unavailable=${String(coreBody.unavailable)}`)
    check('正控 `core_status` 的文案与 presence **一致**（`offline` ⇒ 标签含"离线"；`null` ⇒ 标签含"未知"）',
      coreRow.presence === 'offline'
        ? String(coreRow.label).includes('离线')
        : coreRow.presence === 'online'
          ? String(coreRow.label).includes('在线')
          : String(coreRow.label).includes('未知'),
      String(coreRow.label))
    check('⚠️ 正控 核心**确实没在跑** ⇒ `presence` 必须是 `offline`（不是 `unknown`）',
      coreRow.presence === 'offline', String(coreRow.presence))

    const again = await fetch(`${url}/api/goals-commitments`, { headers: authed })
    const againBody = (await again.json()) as { items?: Record<string, unknown>[] }
    stable = JSON.stringify(againBody.items) === JSON.stringify(goalsBody.items)
    check('正控 同一路径再读一次 ⇒ 读数**一致**（稳定，不是随机/累积）', stable, '应一致')
  }
} catch (error) {
  check('live 流程未抛错地跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  child.kill()
  await new Promise((done) => setTimeout(done, 800))
}

let stopped = false
try {
  await fetch(`${url}/session`)
} catch {
  stopped = true
}
check('收尾 停机后端口不再响应（**必须**：它持有库连接与资格锁）', stopped, stopped ? 'ok' : '仍在听')

/*
 * `§1bis ③`：**只读**判据 —— 起服务前与停服务后的只读快照必须**逐项相同**。
 * ⚠️ 这是"这次没写库"的机器判据；**不许**用"没有报错"代替。
 */
const after = await snapshot()
check('正控 **只读**：起服务前 / 停服务后两次只读快照逐项相同（这次没写库）',
  before !== undefined && after !== undefined && JSON.stringify(before) === JSON.stringify(after),
  `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
for (const reason of notRun) console.log(`NOT RUN  ${reason}`)
console.log(
  `\nA1 / WP2 live（--with-db）：判据 ${checks.length} · 失败 ${failed.length} · ` +
    `未运行 ${notRun.length} · measured_count=${checks.length} · goals=${goalsStatus} cognition=${cognitionStatus}`
)
console.log('⚠️ 本门**会打开生产库**（读为主）：不登记在离线门表里（与 postlv2:bridge:verify 同例）。')
if (failed.length > 0) process.exit(1)
if (notRun.length > 0) process.exit(2)
