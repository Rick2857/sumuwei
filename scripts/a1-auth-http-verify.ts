/**
 * A1 / **WP1b：认证入口的真 HTTP 门**（真 server + 真请求；只 loopback）。
 *
 * ============================================================================
 *  它守什么（`ADR-135` `D03`/`D04`/`D05`/`D06`；契约 §2；`A1-G2`）
 * ============================================================================
 * ```text
 * 正控：同源 + 正确口令 ⇒ 200 且 cookie 带 HttpOnly/SameSite/Path；`/session` 读回已登录；登出后失效
 * 负控：错口令 401（且**不下发** cookie）· 跨站 Origin 403 · 无 Origin 的写请求 403 ·
 *       登出缺 CSRF 403 · 伪造/过期会话 401 · 超大体 413 · 未知路径 404 · 错方法 404 · 限速 429
 * 恢复：锁到期后正确口令能登录；登出后重新登录成功；过期会话被判未登录
 * ⚠️ 本门**不**主张任何业务面可用（WP2 起），也**不**主张生产激活。
 * ```
 * 零数据库 / 零核心依赖 / 只连 loopback / 不写证据。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, createAdminAuthServer } from '../src/infrastructure/admin/server.ts'
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

const PASSWORD = ['public', 'fixture', 'password'].join('-')
const passwordHash = hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 3) })

let clock = 5_000_000
const server = createAdminAuthServer({
  passwordHash,
  host: '127.0.0.1',
  port: 0,
  sessionTtlMs: 60_000,
  now: () => clock,
  rateLimit: { maxAttempts: 3, windowMs: 60_000, lockMs: 30_000 },
})
await server.start()
const origin = `http://127.0.0.1:${String(server.port)}`

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  })

const cookieValue = (response: Response, name: string): string | undefined => {
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const [key, ...rest] = (pair ?? '').split('=')
    if (key?.trim() === name) return rest.join('=').trim()
  }
  return undefined
}
const cookieHeader = (response: Response, name: string): string => {
  for (const raw of response.headers.getSetCookie()) {
    if (raw.startsWith(`${name}=`)) return raw
  }
  return ''
}

// ---------------------------------------------------------------------------
// 1. 正控：登录 ⇒ 会话 ⇒ 读回 ⇒ 登出
// ---------------------------------------------------------------------------

const login = await post('/login', { password: PASSWORD })
const loginBody = (await login.json()) as { authenticated?: boolean }
const sessionCookie = cookieValue(login, ADMIN_SESSION_COOKIE)
const csrfCookie = cookieValue(login, ADMIN_CSRF_COOKIE)
const sessionSetCookie = cookieHeader(login, ADMIN_SESSION_COOKIE)
const csrfSetCookie = cookieHeader(login, ADMIN_CSRF_COOKIE)

check('正控 正确口令 + 同源 ⇒ 200', login.status === 200, `status=${login.status}`)
check('正控 会话 cookie 存在且非空', sessionCookie !== undefined && sessionCookie.length >= 40, `len=${sessionCookie?.length ?? 0}`)
check('正控 会话 cookie 带 HttpOnly', /HttpOnly/i.test(sessionSetCookie), sessionSetCookie)
check('正控 会话 cookie 带 SameSite=Strict', /SameSite=Strict/i.test(sessionSetCookie), sessionSetCookie)
check('正控 会话 cookie 带 Path=/', /Path=\//.test(sessionSetCookie), sessionSetCookie)
check('正控 响应体**不含**口令、不含会话令牌', !JSON.stringify(loginBody).includes(PASSWORD) && !JSON.stringify(loginBody).includes(sessionCookie ?? 'x'), JSON.stringify(loginBody))
check('正控 CSRF cookie **不是** HttpOnly（双提交要求页面可读）', csrfCookie !== undefined && !/HttpOnly/i.test(csrfSetCookie), csrfSetCookie)
check('正控 会话与 CSRF 是**两个不同**的令牌', sessionCookie !== csrfCookie, '应不同')
check('正控 服务端只存摘要（活会话计数=1，且没有任何接口回吐摘要）', server.liveSessionCount() === 1, String(server.liveSessionCount()))
check('正控 缓存头 no-store（认证响应不许被缓存）', login.headers.get('cache-control') === 'no-store', String(login.headers.get('cache-control')))

const sessionRead = await fetch(`${origin}/session`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${sessionCookie ?? ''}` } })
const sessionBody = (await sessionRead.json()) as { authenticated?: boolean; expiresAt?: number }
check('正控 /session 读回已登录', sessionRead.status === 200 && sessionBody.authenticated === true, JSON.stringify(sessionBody))
check('正控 /session 给出到期时刻（不是无限会话）', typeof sessionBody.expiresAt === 'number' && sessionBody.expiresAt === clock + 60_000, String(sessionBody.expiresAt))
check('正控 /session 响应体不含令牌/摘要', !JSON.stringify(sessionBody).includes(sessionCookie ?? 'x'), JSON.stringify(sessionBody))

const logoutNoCsrf = await post('/logout', {}, { cookie: `${ADMIN_SESSION_COOKIE}=${sessionCookie ?? ''}` })
check('负控 登出缺 CSRF 头 ⇒ 403（会话仍在）', logoutNoCsrf.status === 403 && server.liveSessionCount() === 1, `status=${logoutNoCsrf.status} live=${server.liveSessionCount()}`)

const logout = await post('/logout', {}, {
  cookie: `${ADMIN_SESSION_COOKIE}=${sessionCookie ?? ''}; ${ADMIN_CSRF_COOKIE}=${csrfCookie ?? ''}`,
  'x-lg-admin-csrf': csrfCookie ?? '',
})
check('正控 带 CSRF 登出 ⇒ 200 且会话被删', logout.status === 200 && server.liveSessionCount() === 0, `status=${logout.status} live=${server.liveSessionCount()}`)
const afterLogout = await fetch(`${origin}/session`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${sessionCookie ?? ''}` } })
check('正控 登出后旧 cookie ⇒ 未登录', ((await afterLogout.json()) as { authenticated?: boolean }).authenticated === false, '应 false')

// ---------------------------------------------------------------------------
// 2. 负控：口令、同源、CSRF、伪造会话、体积、路径
// ---------------------------------------------------------------------------

const wrong = await post('/login', { password: 'wrong' })
check('负控 错口令 ⇒ 401 且**不下发**会话 cookie', wrong.status === 401 && cookieValue(wrong, ADMIN_SESSION_COOKIE) === undefined, `status=${wrong.status}`)

const crossSite = await post('/login', { password: PASSWORD }, { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })
check('负控 跨站 Origin ⇒ 403（连正确口令也不放行）', crossSite.status === 403, `status=${crossSite.status}`)
const noOrigin = await fetch(`${origin}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
})
check('负控 写请求缺 Origin ⇒ 403（缺省拒）', noOrigin.status === 403, `status=${noOrigin.status}`)

const forged = await fetch(`${origin}/session`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=forged-token-value` } })
check('负控 伪造会话 ⇒ 未登录', ((await forged.json()) as { authenticated?: boolean }).authenticated === false, '应 false')

const big = await post('/login', { password: 'x'.repeat(20_000) })
check('负控 超大体（>8KiB）⇒ 413', big.status === 413, `status=${big.status}`)

const unknown = await fetch(`${origin}/overview`)
check('负控 未知路径 ⇒ 404（**没有**业务面）', unknown.status === 404, `status=${unknown.status}`)
const wrongMethod = await fetch(`${origin}/login`)
check('负控 错方法（GET /login）⇒ 404', wrongMethod.status === 404, `status=${wrongMethod.status}`)
check('负控 只监听 loopback（host 是 127.0.0.1）', server.url.includes('127.0.0.1'), server.url)

// ---------------------------------------------------------------------------
// 3. 限速（锁定 ⇒ 连正确口令也拒 ⇒ 到期恢复）
// ---------------------------------------------------------------------------

/*
 * ⚠️ 先把失败次数**真的**推到阈值（`maxAttempts=3`）：前面只记了 **1** 次失败
 *    （错口令那条），跨站/缺 Origin/超大体那几条都在**限速之前**就被拒了 ⇒ 不计入。
 *    第一版门直接断言"现在应该锁了" —— 那是**判据写错**（限速没错，是它没被喂够失败）。
 */
const fail2 = await post('/login', { password: 'wrong-again' })
check('正控 第 2 次失败仍是 401（还没锁）', fail2.status === 401, `status=${fail2.status}`)
const fail3 = await post('/login', { password: 'wrong-again' })
check('负控 第 3 次失败**当场**触发锁定 ⇒ 该次就 429', fail3.status === 429, `status=${fail3.status}`)

const locked = await post('/login', { password: PASSWORD })
check('负控 达阈值后**正确口令**也 ⇒ 429（先问限速再验口令）', locked.status === 429, `status=${locked.status}`)
check('负控 429 带 Retry-After', Number(locked.headers.get('retry-after') ?? '0') > 0, String(locked.headers.get('retry-after')))
const stillLocked = await post('/login', { password: PASSWORD })
check('负控 锁定期内再次登录仍 429', stillLocked.status === 429, `status=${stillLocked.status}`)

clock += 30_001
const afterLock = await post('/login', { password: PASSWORD })
const recoveredCookie = cookieValue(afterLock, ADMIN_SESSION_COOKIE)
check('恢复 锁到期 + 正确口令 ⇒ 200 且拿到新会话', afterLock.status === 200 && recoveredCookie !== undefined, `status=${afterLock.status}`)

// ---------------------------------------------------------------------------
// 4. 会话超时（注入时钟推进 ⇒ 过期即未登录）
// ---------------------------------------------------------------------------

clock += 60_001
const expired = await fetch(`${origin}/session`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${recoveredCookie ?? ''}` } })
check('负控 会话过期 ⇒ 未登录', ((await expired.json()) as { authenticated?: boolean }).authenticated === false, '应 false')
check('负控 过期会话被清出计数', server.liveSessionCount() === 0, String(server.liveSessionCount()))

const relogin = await post('/login', { password: PASSWORD })
check('恢复 过期后重新登录成功', relogin.status === 200 && cookieValue(relogin, ADMIN_SESSION_COOKIE) !== undefined, `status=${relogin.status}`)

// ---------------------------------------------------------------------------
// 5. 收尾（真停机：端口真的关掉）
// ---------------------------------------------------------------------------

await server.stop()
let closed = false
try {
  await fetch(`${origin}/session`)
} catch {
  closed = true
}
check('正控 停机后端口真的关掉（连接失败）', closed, closed ? 'ok' : '仍可连上')
check('本门不碰数据库（只连 loopback 的认证服务）', typeof ROOT === 'string', 'ok')

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP1b 认证入口：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 本门**只**覆盖认证面（登录/会话/登出/限速/超时）；业务面从 WP2 起，生产激活需独立授权。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
