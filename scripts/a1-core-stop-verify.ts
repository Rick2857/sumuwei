/**
 * A1 / **`A1-G6`：核心停机窗口**（契约 §7 那个至今**空着**的退出门）。
 *
 * ============================================================================
 *  契约 §5/§7 的原话（离线那一行）
 * ============================================================================
 * ```text
 * 核心离线 ⇒ 显示"核心离线"，可离线读的面照常可读，写操作如实拒绝；恢复后照常。
 * ```
 *
 * 本门证什么（**三段式**，全部离线）：
 * ```text
 * 正控 ① **核心没在跑**（本门默认状态：管理面不启动核心，也不连核心）
 *      ② 五个**离线可读**面逐个 200（不是 501/503 ⇒ 核心停机不影响读）
 *      ③ 页面 200；未登录读数据面 401（鉴权与离线无关）
 * 负控 ④ **写操作如实拒绝**：对 `/api/*` 发 POST/PUT/DELETE/PATCH 一律**非 2xx**
 *      （首版**一个写面都没有** ⇒ 结构上不存在写路由 ⇒ 拒是事实，不是承诺）
 *      ⑤ 声明的写面集合**为空**（`ADMIN_WRITE_SURFACES`）
 * 结构 ⑥ 管理面**不认识核心**：它自己直读库/配置 ⇒ "核心起来之后读数依然可读"是**结构事实**
 *      （判据落在 import 边界上，不是"我猜它不需要核心"）
 * ⚠️ **不主张**的部分（如实标 NOT RUN）：
 *      · "核心在线"这一读数在 PGlite 上是 `null`（该后端回答不了资格锁的问题）⇒ 这里**不**判它
 *      · 真实 PG 上的"核心停 → 起 → 再读"端到端，需要真核心与真库 ⇒ **NOT RUN（具名）**
 * ```
 *
 * **跑法**（与 `a1:jobs-store:verify` 同款：目录沙箱 ⇒ 必须**没有 `.env` 的 cwd**）：
 * ```text
 *   $env:CHARACTER_DB_BACKEND='pglite'; $env:POSTGRES_URL=''; $env:DATABASE_URL=''
 *   $env:PGLITE_DATA_DIR=''; $env:PROJECT_LG_SANDBOX=''; $env:LG_PG_EXPECT_DATABASE=''
 *   （无 .env 的 cwd）pnpm a1:core-stop:verify
 * ```
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts'
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, createAdminAuthServer } from '../src/infrastructure/admin/server.ts'
import { ADMIN_OFFLINE_READABLE_SURFACES, ADMIN_WRITE_SURFACES } from '../src/infrastructure/admin/query-ports.ts'
import { createEffectiveConfigPort } from '../src/infrastructure/admin-ports/effective-config.ts'
import { createGoalsCommitmentsPort } from '../src/infrastructure/admin-ports/goals-commitments.ts'
import { createCognitionPort } from '../src/infrastructure/admin-ports/cognition.ts'
import { createJobsPort } from '../src/infrastructure/admin-ports/jobs.ts'
import { createSafetyQuotaPort } from '../src/infrastructure/admin-ports/safety-quota.ts'
import { createCoreStatusPort } from '../src/infrastructure/admin-ports/core-status.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const PASSWORD = 'a1-core-stop-password'
const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}
const notRun: string[] = []

/*
 * ⚠️ 这道门**不碰真实库**：它连的是**隔离的端口**（不连库），所以**不需要**开隔离库 ——
 *    端口全部用"未接 reader"的桩，于是"核心停机时读到什么"就是**如实读到什么**（没有编数）。
 *    （第一版在这里留了一个"起隔离核心"的占位 Promise，那个永不 resolve ⇒ 脚本会挂死；已删。）
 */

const server = createAdminAuthServer({
  passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 47) }),
  host: '127.0.0.1',
  port: 0,
  /* ⚠️ **全是未接 reader 的端口**：核心停机窗口里能读到什么，就如实读到什么 */
  ports: {
    effectiveConfig: createEffectiveConfigPort({ env: {}, envText: '' }),
    goalsCommitments: createGoalsCommitmentsPort({}),
    cognition: createCognitionPort({}),
    jobs: createJobsPort({}),
    safetyQuota: createSafetyQuotaPort({ config: {} }),
    coreStatus: createCoreStatusPort({}),
  } as never,
})
await server.start()
const origin = `http://127.0.0.1:${String(server.port)}`

const login = await fetch(`${origin}/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: PASSWORD }),
})
const token = login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '')
  .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
/* ⚠️ 写路径的闸序是 **会话 → 同源 → CSRF → 端口接线**；要打"已声明但未接线"那条路，
   就必须**带上 CSRF**（否则停在 403 csrf_rejected —— 那是另一条路，也是一条真闸）。 */
const csrfCookie = login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '')
  .find((pair) => pair.startsWith(`${ADMIN_CSRF_COOKIE}=`))?.split('=')[1] ?? ''
const authed = { cookie: `${ADMIN_SESSION_COOKIE}=${token}` }
const authedWrite = {
  cookie: `${ADMIN_SESSION_COOKIE}=${token}; ${ADMIN_CSRF_COOKIE}=${csrfCookie}`,
  'x-lg-admin-csrf': csrfCookie,
  origin,
}
check('前置 登录 200 且拿到会话 cookie', login.status === 200 && token !== '', `status=${login.status}`)

// 正控 ②：核心没在跑，五个离线可读面逐个 200
const pathsBySurface: Record<string, string> = {
  effective_config: '/api/effective-config',
  goals_commitments: '/api/goals-commitments',
  cognition: '/api/cognition',
  jobs: '/api/jobs',
  safety_quota: '/api/safety-quota',
  /* ⚠️ 第六个面（用户 2026-10-14 裁定）**也是离线可读** ——
     第一版这张表漏了它 ⇒ `path` 是 `undefined` ⇒ URL 拼成 `http://…:63703undefined` ⇒ fetch 抛。 */
  core_status: '/api/core-status',
}
const statusBySurface: Record<string, number> = {}
for (const surface of ADMIN_OFFLINE_READABLE_SURFACES) {
  const path = pathsBySurface[surface]
  const response = await fetch(`${origin}${path}`, { headers: authed })
  statusBySurface[surface] = response.status
}
check('正控 核心停机时，**离线可读的五个面**逐个 200（不是 501/503）',
  Object.values(statusBySurface).every((status) => status === 200),
  Object.entries(statusBySurface).map(([surface, status]) => `${surface}=${String(status)}`).join(' · '))
check('正控 页面 200（核心停机不影响页面本身）',
  (await fetch(`${origin}/`)).status === 200, '')
check('正控 未登录读数据面 ⇒ 401（鉴权与离线是两回事）',
  (await fetch(`${origin}/api/jobs`)).status === 401, '')

// 负控 ④：写操作如实拒绝（首版没有写面 ⇒ 任何写动词都非 2xx）
const writeStatuses: string[] = []
for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const response = await fetch(`${origin}/api/jobs`, { method, headers: authed })
  writeStatuses.push(`${method}=${String(response.status)}`)
}
check('负控 写操作**如实拒绝**：四个写动词逐个非 2xx',
  writeStatuses.every((entry) => {
    const status = Number(entry.split('=')[1])
    return status < 200 || status >= 300
  }), writeStatuses.join(' · '))
check('负控 写面集合**只有一个**（用户 2026-10-14 裁定：首版只开 `jobs.admit`；不多开也不少开）',
  ADMIN_WRITE_SURFACES.length === 1 && ADMIN_WRITE_SURFACES[0] === 'jobs.admit', ADMIN_WRITE_SURFACES.join(', '))
/*
 * ⚠️ 未声明的路径上写动词仍被拒；已声明但**没接线**的写面报 501。
 *    ⚠️ 第一版写成 `status < 300 || status >= 300` ⇒ **恒真**（判据形同虚设，已修）：
 *    恒真判据比没有判据更坏 —— 它会让"门全绿"变成一句空话。
 */
const undeclaredWrite = await fetch(`${origin}/api/cognition`, { method: 'POST', headers: authed })
const declaredButUnwired = await fetch(`${origin}/api/jobs`, { method: 'POST', headers: authedWrite })
check('负控 **未声明**的路径上写动词 ⇒ 404（不是"碰巧也拒了"的糊弄）',
  undeclaredWrite.status === 404, `POST /api/cognition status=${String(undeclaredWrite.status)}`)
check('负控 已声明但**未接线**的写面 ⇒ 501 `write_not_wired`（不静默接受，也不假装成功）',
  declaredButUnwired.status === 501, `POST /api/jobs status=${String(declaredButUnwired.status)}`)

// 结构 ⑥：管理面不认识核心（它自己直读库/配置）
const adminSource = [
  'src/infrastructure/admin/server.ts',
  'src/infrastructure/admin/query-ports.ts',
  'src/infrastructure/admin/auth.ts',
].map((file) => ({ file, text: readFileSync(resolve(ROOT, file), 'utf8') }))
const coreImports = adminSource.filter(({ text }) => /kernel\/app|@elizaos\/core/.test(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')))
check('结构 管理面**不 import 核心/运行时** ⇒ "核心起来之后读数依然可读"是结构事实',
  coreImports.length === 0, coreImports.map(({ file }) => file).join(', '))

// 不主张的部分（如实 NOT RUN）
notRun.push('真实 PG 上"核心停 → 起 → 再读"端到端（需真核心与真库；本门**从不**碰真实库）')
notRun.push('`presence=online` 这一读数：PGlite 回答不了资格锁问题（那条路在 `a1:jobs-store:verify` 的负控里已判）')

await server.stop()

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
for (const reason of notRun) console.log(`NOT RUN  ${reason}`)
console.log(`\nA1 / G6 核心停机窗口：判据 ${checks.length} · 失败 ${failed.length} · 未运行 ${notRun.length} · measured_count=${checks.length}`)
console.log('⚠️ 本门跑在**一次性隔离库**上（无 .env 的 cwd + PGlite 沙箱）；**从不**打开真实库。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
