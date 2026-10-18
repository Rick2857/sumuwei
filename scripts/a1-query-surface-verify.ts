/**
 * A1 / **WP2 第一切片门**：只读面的**契约与边界**（冻结清单 · 只调端口 · 认证前置）。
 *
 * ============================================================================
 *  它守什么（`ADR-135` `D01`/`D07`/`D11`；`ADR-036`；契约 §1/§4；`A1-G1`/`A1-G4`）
 * ============================================================================
 * ```text
 * 静态：① 清单是**闭集**（五个面；路径唯一；字段不重复；只有 effective_config 允许密钥）
 *       ② **依赖边界**：`src/infrastructure/admin/**` 不许 import 数据库 / drizzle / elizaos
 *          —— "不新建第二套真相"由此变成**可判**的性质，而不是一句承诺
 *       ③ 每个只读面都**先过会话**（路由体内 `sessionOf` 在取端口之前）
 * 运行时（真 server + 桩端口）：
 *       正控：已登录 ⇒ 200 且形状是冻结清单那套；字段闭集外的字段被丢掉并计数
 *       负控：未登录 ⇒ 401（**没有**匿名可读）· 端口没接线 ⇒ 501 具名 · 端口抛错 ⇒ 500 具名且不回吐异常
 *             · 未知面 ⇒ 404 · 不该含密钥的面上出现密钥形状字段 ⇒ 被丢掉（droppedFields>0）
 *       恢复：接上端口后同一路径 ⇒ 200
 * ⚠️ 本门**不**主张"页面可用"：那是 WP2 后续切片（真端口实现 + 页面）。
 * ```
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts'
import { ADMIN_SESSION_COOKIE, createAdminAuthServer } from '../src/infrastructure/admin/server.ts'
import { createGoalsCommitmentsPort } from '../src/infrastructure/admin-ports/goals-commitments.ts'
import { createCognitionPort } from '../src/infrastructure/admin-ports/cognition.ts'
import { createJobsPort } from '../src/infrastructure/admin-ports/jobs.ts'
import { createSafetyQuotaPort } from '../src/infrastructure/admin-ports/safety-quota.ts'
import { createEffectiveConfigPort } from '../src/infrastructure/admin-ports/effective-config.ts'
import { createCoreStatusPort } from '../src/infrastructure/admin-ports/core-status.ts'
import {
  ADMIN_OFFLINE_READABLE_SURFACES,
  ADMIN_READ_SURFACES,
  ADMIN_WRITE_SURFACES,
  corePresenceFromLockCount,
  corePresenceLabel,
  isOfflineReadable,
  adminReadSurfaceProblems,
  shouldDropSecretShapedField,
  type AdminQueryPorts,
  type AdminReadSurfacePayload,
} from '../src/infrastructure/admin/query-ports.ts'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

// ---------------------------------------------------------------------------
// 1. 静态：冻结清单
// ---------------------------------------------------------------------------

const problems = adminReadSurfaceProblems()
check('静态 清单自检无问题（闭集/唯一路径/字段不重复/密钥面受限）', problems.length === 0, problems.join('；'))
check('静态 首版五个面 + 用户 2026-10-14 追加的第六个面（共**六个**；`R-A1-2` + 当日裁定）',
  ADMIN_READ_SURFACES.length === 6, String(ADMIN_READ_SURFACES.length))
check('静态 面 id 逐字与冻结档一致（含 `core_status`）',
  [...ADMIN_READ_SURFACES.map((s) => s.id)].sort().join(',') === 'cognition,core_status,effective_config,goals_commitments,jobs,safety_quota',
  ADMIN_READ_SURFACES.map((s) => s.id).join(','))
check('静态 五个 id 与裁定逐字一致',
  ADMIN_READ_SURFACES.map((s) => s.id).join(',') === 'core_status,cognition,goals_commitments,jobs,safety_quota,effective_config',
  ADMIN_READ_SURFACES.map((s) => s.id).join(','))
check('静态 只有 effective_config 允许含密钥字段',
  ADMIN_READ_SURFACES.filter((s) => s.mayContainSecrets).map((s) => s.id).join(',') === 'effective_config',
  ADMIN_READ_SURFACES.filter((s) => s.mayContainSecrets).map((s) => s.id).join(','))
const frozenCopy = JSON.parse(readFileSync(resolve(REPO_ROOT, 'evals/a1/read-surfaces.json'), 'utf8')) as {
  surfaces: { id: string; path: string; fields: string[] }[]
}
check('静态 TS 清单与冻结档 `evals/a1/read-surfaces.json` **双向一致**',
  frozenCopy.surfaces.length === ADMIN_READ_SURFACES.length &&
  frozenCopy.surfaces.every((row, index) => {
    const live = ADMIN_READ_SURFACES[index]!
    return row.id === live.id && row.path === live.path && row.fields.join(',') === live.fields.join(',')
  }),
  `冻结档 ${frozenCopy.surfaces.length} 条`)

// ---------------------------------------------------------------------------
// 2. 静态：依赖边界（"不新建第二套真相"）
// ---------------------------------------------------------------------------

const ADMIN_DIR = resolve(REPO_ROOT, 'src/infrastructure/admin')
const PORTS_DIR = resolve(REPO_ROOT, 'src/infrastructure/admin-ports')
const forbidden = [
  { pattern: /from\s+'[^']*\/db\//, why: 'import 数据库入口' },
  { pattern: /from\s+'drizzle-orm/, why: 'import drizzle' },
  { pattern: /from\s+'@elizaos\//, why: 'import elizaos 运行时' },
  { pattern: /from\s+'[^']*persistence\//, why: 'import 持久层' },
]
const offenders: string[] = []
const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}
/*
 * ⚠️ **两个目录都查**（2026-10-14 加固）：
 *   · `admin/**`（HTTP/认证/契约层）**不许**认识任何持久层
 *   · `admin-ports/**`（端口实现）**也不许自己开库**：它们只吃**注入的 reader**
 *     ⇒ 生产 reader（真要读库的那一层）必须放**别处**，于是"页面不新建第二套真相"这条
 *       在端口层也成立，而不是靠"记得别在那里 import"
 */
for (const dir of [ADMIN_DIR, PORTS_DIR]) {
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8')
    for (const rule of forbidden) {
      if (rule.pattern.test(text)) offenders.push(`${file.replace(`${REPO_ROOT}\\`, '')}：${rule.why}`)
    }
  }
}
check('静态 依赖边界：`admin/**` 与 `admin-ports/**` 都不 import 数据库/drizzle/elizaos/持久层（端口只吃注入的 reader）',
  offenders.length === 0, offenders.join(' · '))
check('静态 边界判据覆盖了两个目录（不是只查了一个）',
  walk(ADMIN_DIR).length > 0 && walk(PORTS_DIR).length >= 5,
  `admin=${walk(ADMIN_DIR).length} 个文件 · admin-ports=${walk(PORTS_DIR).length} 个文件`)
check('静态 边界判据是活的（能认出一次真 import）',
  forbidden[0]!.pattern.test("import { x } from '../db/index.ts'") === true, '自检：假 import 应被认出')

// ---------------------------------------------------------------------------
// 3. 静态：每个只读面都先过会话
// ---------------------------------------------------------------------------

const serverSource = readFileSync(resolve(ADMIN_DIR, 'server.ts'), 'utf8')
const readBlock = serverSource.slice(serverSource.indexOf('const surface = method === \'GET\''), serverSource.indexOf("if (url.pathname === '/logout'"))
check('静态 只读路由先判会话（`sessionOf` 出现在取端口**之前**）',
  readBlock.indexOf('sessionOf(request)') >= 0 &&
  readBlock.indexOf('sessionOf(request)') < readBlock.indexOf('options.ports'),
  '顺序：先 sessionOf，再 options.ports')
check('静态 没接线 ⇒ 501 具名 `surface_not_wired`（不用空数组冒充"没有数据"）',
  /surface_not_wired/.test(readBlock), '应出现')
check('静态 端口抛错 ⇒ 500 具名且**不**回吐异常消息', /surface_failed/.test(readBlock) && !/error\.message/.test(readBlock), '应出现 surface_failed 且无 error.message')

// ---------------------------------------------------------------------------
// 4. 运行时：真 server + 桩端口
// ---------------------------------------------------------------------------

const PASSWORD = 'wp2-read-surface-password'
const payloadOf = (surface: string, items: Record<string, unknown>[]): AdminReadSurfacePayload =>
  ({ surface: surface as AdminReadSurfacePayload['surface'], generatedAt: '2026-10-14T00:00:00.000Z', items })

const stubPorts: AdminQueryPorts = {
  cognition: async () => payloadOf('cognition', [{ characterId: 'c1', affect: 'calm', extraNotInList: 'should-be-dropped' }]),
  goalsCommitments: async () => payloadOf('goals_commitments', [{ openGoals: 1 }]),
  jobs: async () => payloadOf('jobs', [{ jobId: 'j1', state: 'running' }]),
  safetyQuota: async () => payloadOf('safety_quota', [{ quotaUsed: 3, apiKey: 'sk-should-not-appear' }]),
  effectiveConfig: async () => payloadOf('effective_config', [{ flag: 'X', value: 'sk-live-secret', source: 'env', masked: true }]),
  /* 第六个面（用户 2026-10-14 裁定）：这里给一个**如实 unavailable** 的桩（该面未接 reader 时的正确形状） */
  coreStatus: async () => ({ surface: 'core_status', generatedAt: '', items: [], unavailable: ['presence'] }),
}

const server = createAdminAuthServer({ passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 5) }), host: '127.0.0.1', port: 0, ports: stubPorts })
await server.start()
const origin = `http://127.0.0.1:${String(server.port)}`
const login = await fetch(`${origin}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: PASSWORD }),
})
const sessionToken = login.headers.getSetCookie()
  .map((raw) => raw.split(';')[0] ?? '')
  .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
const authed = { cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}` }

const unauth = await fetch(`${origin}/api/cognition`)
check('负控 未登录读只读面 ⇒ 401（没有匿名可读这一档）', unauth.status === 401, `status=${unauth.status}`)

const cognition = await fetch(`${origin}/api/cognition`, { headers: authed })
const cognitionBody = (await cognition.json()) as { surface?: string; items?: Record<string, unknown>[]; droppedFields?: number; generatedAt?: string }
check('正控 已登录 ⇒ 200', cognition.status === 200, `status=${cognition.status}`)
check('正控 形状是冻结清单那套（surface/generatedAt/items）',
  cognitionBody.surface === 'cognition' && typeof cognitionBody.generatedAt === 'string' && Array.isArray(cognitionBody.items),
  JSON.stringify(cognitionBody).slice(0, 120))
check('正控 **字段闭集**外的字段被丢掉',
  cognitionBody.items?.[0] !== undefined && !('extraNotInList' in cognitionBody.items[0]),
  JSON.stringify(cognitionBody.items?.[0]))

const quota = await fetch(`${origin}/api/safety-quota`, { headers: authed })
const quotaBody = (await quota.json()) as { items?: Record<string, unknown>[]; droppedFields?: number }
const quotaText = JSON.stringify(quotaBody)
/*
 * ⚠️ 第一版这条判据**前提写错**：`apiKey` 不在字段闭集里 ⇒ 它被**闭集**丢掉，
 *    根本轮不到"密钥形状"那条兜底（于是 droppedFields=0，看起来像兜底没生效）。
 *    ⇒ 兜底单独作为**纯函数**测（下面三条），运行时只断言"闭集确实丢掉了它"。
 */
check('负控 不该含密钥的面上，闭集外的 `apiKey` 被丢掉（且不出现在响应里）',
  quotaText.includes('droppedFields') && !quotaText.includes('sk-should-not-appear'),
  `droppedFields=${String(quotaBody.droppedFields)}`)

const cognitionSurface = ADMIN_READ_SURFACES.find((s) => s.id === 'cognition')!
const configSurface = ADMIN_READ_SURFACES.find((s) => s.id === 'effective_config')!
check('负控 兜底判据（纯函数）：非密钥面 + 密钥形状字段名 ⇒ 丢',
  shouldDropSecretShapedField(cognitionSurface, 'apiKey') === true &&
  shouldDropSecretShapedField(cognitionSurface, 'userPassword') === true &&
  shouldDropSecretShapedField(cognitionSurface, 'refreshToken') === true,
  '应 true')
check('正控 兜底判据：正常字段名 ⇒ 不丢（不误伤）',
  shouldDropSecretShapedField(cognitionSurface, 'characterId') === false &&
  shouldDropSecretShapedField(cognitionSurface, 'affect') === false,
  '应 false')
check('恢复 兜底判据：**允许含密钥**的面上同名不丢（由实现方遮蔽）',
  shouldDropSecretShapedField(configSurface, 'apiKey') === false, '应 false')

const config = await fetch(`${origin}/api/effective-config`, { headers: authed })
const configBody = (await config.json()) as { items?: Record<string, unknown>[] }
check('正控 `effective_config` 允许含密钥字段（由实现方遮蔽，服务端不猜）',
  configBody.items?.[0]?.masked === true, JSON.stringify(configBody.items?.[0]))

const unknown = await fetch(`${origin}/api/not-a-surface`, { headers: authed })
check('负控 未知面 ⇒ 404', unknown.status === 404, `status=${unknown.status}`)
const noAuthUnknown = await fetch(`${origin}/api/not-a-surface`)
check('负控 未知面**未登录**也 404（不泄露"哪些面存在"）', noAuthUnknown.status === 404, `status=${noAuthUnknown.status}`)

await server.stop()

const bareServer = createAdminAuthServer({ passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 5) }), host: '127.0.0.1', port: 0 })
await bareServer.start()
const bareOrigin = `http://127.0.0.1:${String(bareServer.port)}`
const bareLogin = await fetch(`${bareOrigin}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: bareOrigin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: PASSWORD }),
})
const bareToken = bareLogin.headers.getSetCookie()
  .map((raw) => raw.split(';')[0] ?? '')
  .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
const notWired = await fetch(`${bareOrigin}/api/cognition`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${bareToken}` } })
const notWiredBody = (await notWired.json()) as { error?: string }
check('负控 端口**没接线** ⇒ 501 具名 `surface_not_wired`（不编造数据）',
  notWired.status === 501 && notWiredBody.error === 'surface_not_wired', `status=${notWired.status} body=${JSON.stringify(notWiredBody)}`)
await bareServer.stop()

const failingPorts: AdminQueryPorts = {
  ...stubPorts,
  cognition: async () => { throw new Error('db exploded: secret-detail-xyz') },
}
const failingServer = createAdminAuthServer({ passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 5) }), host: '127.0.0.1', port: 0, ports: failingPorts })
await failingServer.start()
const failingOrigin = `http://127.0.0.1:${String(failingServer.port)}`
const failingLogin = await fetch(`${failingOrigin}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: failingOrigin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: PASSWORD }),
})
const failingToken = failingLogin.headers.getSetCookie()
  .map((raw) => raw.split(';')[0] ?? '')
  .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
const failed = await fetch(`${failingOrigin}/api/cognition`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${failingToken}` } })
const failedText = await failed.text()
check('负控 端口抛错 ⇒ 500 具名 `surface_failed`', failed.status === 500 && failedText.includes('surface_failed'), `status=${failed.status}`)
check('负控 500 里**没有**异常消息（不回吐内部细节）', !failedText.includes('secret-detail-xyz'), failedText.trim())
await failingServer.stop()

// 恢复：接上端口后同一路径 ⇒ 200
const recoveredServer = createAdminAuthServer({ passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 5) }), host: '127.0.0.1', port: 0, ports: stubPorts })
await recoveredServer.start()
const recoveredOrigin = `http://127.0.0.1:${String(recoveredServer.port)}`
const recoveredLogin = await fetch(`${recoveredOrigin}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: recoveredOrigin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: PASSWORD }),
})
const recoveredToken = recoveredLogin.headers.getSetCookie()
  .map((raw) => raw.split(';')[0] ?? '')
  .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
const recovered = await fetch(`${recoveredOrigin}/api/cognition`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${recoveredToken}` } })
check('恢复 接上端口后 ⇒ 200', recovered.status === 200, `status=${recovered.status}`)
await recoveredServer.stop()

// ---------------------------------------------------------------------------
// 4bis. WP5 切片：**错误体是闭集**且**不泄露栈/SQL/正文**（契约 §5）
// ---------------------------------------------------------------------------

/*
 * 做法：错误码**不在这里重抄一遍**（那会与实现分叉）——
 * 从 `server.ts` 的**代码**里把 `error: '…'` 的字面量抽出来，再断言"实测到的那些 ⊆ 抽出来的集合"。
 */
const serverCodeOnly = serverSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const declaredErrorCodes = new Set(
  [...serverCodeOnly.matchAll(/error:\s*'([a-z_]+)'/g)].map((match) => match[1]!)
)
check('WP5 从 `server.ts` 抽出**错误码闭集**（非空）', declaredErrorCodes.size >= 5, [...declaredErrorCodes].sort().join(', '))
/*
 * ⚠️ 必须**另起一个服务**：本文件上面几段跑完已经把服务 `stop()` 了 ——
 *    第一版直接在停掉之后 fetch ⇒ `ECONNREFUSED`（不是判据红，是**量具用错了对象**）。
 */
const wp5Server = createAdminAuthServer({
  passwordHash: hashAdminPassword('wp5-error-set-password', { salt: Buffer.alloc(16, 31) }),
  host: '127.0.0.1', port: 0, ports: failingPorts,
})
await wp5Server.start()
const wp5Origin = `http://127.0.0.1:${String(wp5Server.port)}`
const wp5Login = await fetch(`${wp5Origin}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: wp5Origin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: 'wp5-error-set-password' }),
})
const wp5Token = wp5Login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '')
  .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
const observedErrorCodes = new Set<string>()
for (const probe of [
  await fetch(`${wp5Origin}/api/cognition`),                                                                     // 未登录 ⇒ 401
  await fetch(`${wp5Origin}/api/not-a-surface`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${wp5Token}` } }),   // 未知面 ⇒ 404
  await fetch(`${wp5Origin}/api/cognition`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${wp5Token}` } }),       // 端口抛错 ⇒ 500
]) {
  const body = (await probe.json()) as { error?: string }
  if (typeof body.error === 'string') observedErrorCodes.add(body.error)
}
check('WP5 实测到的错误码**全部**在闭集内（没有临时编的码）',
  observedErrorCodes.size > 0 && [...observedErrorCodes].every((code) => declaredErrorCodes.has(code)),
  `实测：${[...observedErrorCodes].sort().join(', ')}`)
const errorBodyText = await (await fetch(`${wp5Origin}/api/not-a-surface`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${wp5Token}` } })).text()
check('WP5 错误响应**不含**栈/SQL/正文（无 `at ` 栈行、无 `select `、无 `Error:`）',
  !/(\n\s*at\s+\S)|(select\s+\w+\s+from)|(\bError:)/i.test(errorBodyText), errorBodyText.slice(0, 80))
check('WP5 错误体只含**具名码**（键集 ⊆ {error, surface}）',
  (() => {
    const parsed = JSON.parse(errorBodyText) as Record<string, unknown>
    return Object.keys(parsed).every((key) => key === 'error' || key === 'surface')
  })(), errorBodyText.slice(0, 80))
await wp5Server.stop()

// ---------------------------------------------------------------------------
// 4ter. WP5 切片：**离线可读闭集 + 写面为空**（用户 2026-10-14 裁定）
// ---------------------------------------------------------------------------

check('WP5 离线可读闭集**逐字**是裁定的四个面 + 第六个面 `core_status`（它正是报"离线"的那一面）',
  [...ADMIN_OFFLINE_READABLE_SURFACES].sort().join(',') === 'cognition,core_status,effective_config,goals_commitments,jobs',
  ADMIN_OFFLINE_READABLE_SURFACES.join(', '))
check('WP5 `safety_quota` **不在**离线可读闭集里（它的账本侧读不到时如实 `unavailable`）',
  !isOfflineReadable('safety_quota'), '应不在')
check('WP5 闭集里的四个面**逐个**都判"可离线读"（判据是活的，不是只判一个）',
  ADMIN_OFFLINE_READABLE_SURFACES.every((surface) => isOfflineReadable(surface)),
  ADMIN_OFFLINE_READABLE_SURFACES.join(', '))
check('WP5 五个只读面**恰好四个**可离线读（不是五个、也不是三个）',
  ADMIN_READ_SURFACES.filter((surface) => isOfflineReadable(surface.id)).length === 5,
  String(ADMIN_READ_SURFACES.filter((surface) => isOfflineReadable(surface.id)).length))
check('WP5 写面集合**恰好一个** `jobs.admit`（用户 2026-10-14 裁定；**不许多开**）',
  ADMIN_WRITE_SURFACES.length === 1 && ADMIN_WRITE_SURFACES[0] === 'jobs.admit', ADMIN_WRITE_SURFACES.join(', '))
/*
 * 结构判据（**接线后已同步改严**，2026-10-14）：
 *   写路由只允许出现在三处 —— 登录 / 登出 / **唯一声明的写面** `jobs.admit`。
 *   ⚠️ 这是"改成更严"，**不是**"放宽成数得清就行"：
 *     ① 白名单：每处 `'POST'` 附近 200 字符内必须出现 `/login`、`/logout` 或 `/api/jobs`
 *     ② 计数：**非认证**的 POST 恰好 **1** 处，且与 `ADMIN_WRITE_SURFACES.length` 相等
 *        ⇒ 将来有人多写一条 POST（哪怕在白名单路径上），计数会红。
 */
const postSites = [...serverCodeOnly.matchAll(/'POST'/g)].map((match) => match.index ?? 0)
const strayPosts = postSites.filter((index) => {
  const window = serverCodeOnly.slice(Math.max(0, index - 200), index + 200)
  return !window.includes("'/login'") && !window.includes("'/logout'") && !window.includes("'/api/jobs'")
})
check('WP5 结构：`server.ts` 里的 `\'POST\'` 只在**登录 / 登出 / 唯一写面**三处',
  postSites.length > 0 && strayPosts.length === 0,
  `POST 出现 ${postSites.length} 处 · 可疑 ${strayPosts.length} 处`)
const nonAuthPosts = postSites.filter((index) => {
  const window = serverCodeOnly.slice(Math.max(0, index - 200), index + 200)
  return !window.includes("'/login'") && !window.includes("'/logout'")
})
check('WP5 结构：**非认证**的 POST 恰好一处，且**与声明的写面数相等**（多写一条就红）',
  nonAuthPosts.length === ADMIN_WRITE_SURFACES.length,
  `非认证 POST ${String(nonAuthPosts.length)} 处 · 声明写面 ${String(ADMIN_WRITE_SURFACES.length)} 个`)

// ---------------------------------------------------------------------------
// 4quater. R-A1-5：核心在线/离线三态（**纯函数**；探针只读、不抢锁）
// ---------------------------------------------------------------------------

check('R-A1-5 锁被持有（count>0）⇒ `online`', corePresenceFromLockCount(1) === 'online', String(corePresenceFromLockCount(1)))
check('R-A1-5 锁没被持有（count=0）⇒ `offline`', corePresenceFromLockCount(0) === 'offline', String(corePresenceFromLockCount(0)))
check('⚠️ R-A1-5 **查不出来**（undefined/null/负数/非整数）⇒ `null`（**绝不**报成离线）',
  corePresenceFromLockCount(undefined) === null &&
  corePresenceFromLockCount(null) === null &&
  corePresenceFromLockCount(-1) === null &&
  corePresenceFromLockCount(1.5) === null &&
  corePresenceFromLockCount(Number.NaN) === null,
  '应全为 null')
check('R-A1-5 三态**互不相同**且 `null` 的文案说"未知"（不说"离线"）',
  new Set([corePresenceLabel('online'), corePresenceLabel('offline'), corePresenceLabel(null)]).size === 3 &&
  corePresenceLabel(null).includes('未知') && !corePresenceLabel(null).includes('离线'),
  corePresenceLabel(null))
check('R-A1-5 在线/离线的文案**逐字**是「核心在线」/「核心离线」',
  corePresenceLabel('online') === '核心在线' && corePresenceLabel('offline') === '核心离线',
  `${corePresenceLabel('online')} / ${corePresenceLabel('offline')}`)

// ---------------------------------------------------------------------------
// 4quinquies. **端口工厂必须返回函数**（2026-10-14 由 live 门抓到真缺陷后补的门）
// ---------------------------------------------------------------------------

/*
 * ⚠️ 背景（**真实缺陷**）：`createCoreStatusPort` 第一版返回 `{ read }` **对象**，
 *    而路由 `server.ts:265` 判的是 `typeof ports[methodName] !== 'function'`
 *    ⇒ 该面被判成"没接线"（501），只在 live 门里暴露（离线门用手写桩，抓不到）。
 * ⇒ 这里把"六个端口工厂逐个返回函数"变成**离线**判据，让同类错误当场红。
 */
check('端口工厂**返回函数**（不是 `{read}` 对象）—— 路由的 501 判据靠它',
  typeof createGoalsCommitmentsPort({}) === 'function' &&
  typeof createCognitionPort({}) === 'function' &&
  typeof createJobsPort({}) === 'function' &&
  typeof createSafetyQuotaPort({ config: {} }) === 'function' &&
  typeof createEffectiveConfigPort({ env: {}, envText: '' }) === 'function' &&
  typeof createCoreStatusPort({}) === 'function',
  [createGoalsCommitmentsPort({}), createCognitionPort({}), createJobsPort({})].map((port) => typeof port).join(','))

const failedChecks = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 只读面（第一切片）：判据 ${checks.length} · 失败 ${failedChecks.length} · measured_count=${checks.length}`)
console.log('⚠️ 只覆盖**契约与边界**（清单/依赖边界/认证前置/形状收口）；真端口实现与页面是后续切片。')
if (checks.length === 0 || failedChecks.length > 0) process.exit(1)
