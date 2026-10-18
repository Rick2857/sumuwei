/**
 * A1 / **WP1：认证原语门**（`ADR-135` `D03`/`D04`/`D05`；契约 §2；缺口 `B1`/`B10`）。
 *
 * ============================================================================
 *  这个门守什么、不守什么
 * ============================================================================
 * ```text
 * 守：口令哈希（含"存储串坏 ⇒ 失败关闭"）· 会话令牌摘要 · 同源/CSRF 判据 · 登录限速
 * 不守：HTTP 接线（cookie 真的 HttpOnly 吗、状态码对不对、超时/登出真的生效吗）
 *       ⇒ 那些要等 WP1b 的真 server 门（`a1:auth:http:verify`）；**不许**拿本门当"登录已可用"
 * ```
 * 三段式：正控（该过的过）+ 负控（不该过的**逐条具名**判红）+ 恢复（把出错的那一处改回来 ⇒ 判据翻转）。
 * 零 I/O / 零网络 / 零数据库 / 不占端口 / 不写证据。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ADMIN_CONSOLE_PRINCIPAL_ID,
  DEFAULT_SCRYPT_PARAMS,
  AdminAuthError,
  adminConsolePrincipalFromSession,
  createLoginRateLimiter,
  createSessionToken,
  csrfDecision,
  hashAdminPassword,
  sameOriginDecision,
  sessionDigestMatches,
  sessionTokenDigest,
  verifyAdminPassword,
} from '../src/infrastructure/admin/auth.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

// ---------------------------------------------------------------------------
// 1. 口令哈希（正控 / 负控 / 恢复）
// ---------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple'
const salt = Buffer.alloc(16, 7)
const stored = hashAdminPassword(PASSWORD, { salt })

check('正控 存储串形状是 scrypt$N$r$p$keylen$salt$hash（算法与**全部**参数在串里）',
  /^scrypt\$\d+\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(stored), stored.slice(0, 30) + '…')
check('正控 正确口令 ⇒ 通过', verifyAdminPassword(PASSWORD, stored) === true, '应 true')
check('正控 同一口令两次哈希（同盐）逐字相同', hashAdminPassword(PASSWORD, { salt }) === stored, '确定性（同盐）')
check('正控 不同盐 ⇒ 哈希串不同（盐真的进了计算）',
  hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 9) }) !== stored, '应不同')
check('正控 另一盐的哈希串对**它自己**仍然通过（盐是存储串的一部分）',
  verifyAdminPassword(PASSWORD, hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 9) })) === true, '应 true')
check('负控 错误口令 ⇒ 拒', verifyAdminPassword('wrong password', stored) === false, '应 false')
check('负控 空口令 ⇒ 拒（不静默接受）', verifyAdminPassword('', stored) === false, '应 false')
check('负控 存储串被截断 ⇒ 拒（不抛）', verifyAdminPassword(PASSWORD, stored.slice(0, stored.length - 4)) === false, '应 false')
check('负控 存储串前缀被改 ⇒ 拒', verifyAdminPassword(PASSWORD, stored.replace('scrypt$', 'argon2$')) === false, '应 false')
check('负控 参数被改（N 变小）⇒ 拒', verifyAdminPassword(PASSWORD, stored.replace(/\$16384\$/, '$1024$')) === false, '应 false')
check('负控 keylen 被改大（与哈希段长度不符）⇒ 拒',
  verifyAdminPassword(PASSWORD, stored.replace('$32$', '$48$')) === false, '应 false')
check('负控 keylen 被改小（与哈希段长度不符）⇒ 拒',
  verifyAdminPassword(PASSWORD, stored.replace('$32$', '$16$')) === false, '应 false')
check('负控 哈希段被改成别的合法 base64url ⇒ 拒', verifyAdminPassword(PASSWORD, stored.slice(0, -6) + 'AAAAAA') === false, '应 false')
check('负控 非字符串存储串 ⇒ 拒', verifyAdminPassword(PASSWORD, undefined as unknown as string) === false, '应 false')
check('负控 空口令**不能**被哈希（具名抛错，不设默认口令）',
  (() => { try { hashAdminPassword(''); return false } catch (error) { return error instanceof AdminAuthError && error.code === 'admin_password_empty' } })(),
  '应抛 admin_password_empty')
check('恢复 把哈希段换回原值 ⇒ 通过', verifyAdminPassword(PASSWORD, stored) === true, '应 true')

// ---------------------------------------------------------------------------
// 2. 会话令牌（`D04`：只存摘要）
// ---------------------------------------------------------------------------

const tokenA = createSessionToken()
const tokenB = createSessionToken()
check('正控 令牌是 32 字节 base64url（43 字符、无填充）',
  /^[A-Za-z0-9_-]{43}$/.test(tokenA), `${tokenA.length} 字符`)
check('正控 两次生成不同（高熵随机）', tokenA !== tokenB, '应不同')
check('正控 摘要匹配自己', sessionDigestMatches(tokenA, sessionTokenDigest(tokenA)) === true, '应 true')
check('正控 摘要确定（同一令牌两次摘要相同）',
  sessionTokenDigest(tokenA) === sessionTokenDigest(tokenA), '应相同')
check('负控 摘要**不等于**令牌本身（不把令牌当摘要存）', sessionTokenDigest(tokenA) !== tokenA, '应不同')
check('负控 别人的令牌对不上我的摘要', sessionDigestMatches(tokenB, sessionTokenDigest(tokenA)) === false, '应 false')
check('负控 空令牌 ⇒ 拒', sessionDigestMatches('', sessionTokenDigest(tokenA)) === false, '应 false')
check('负控 空摘要 ⇒ 拒', sessionDigestMatches(tokenA, '') === false, '应 false')
check('负控 长度不同的摘要 ⇒ 拒（先判长度再定时比较）',
  sessionDigestMatches(tokenA, sessionTokenDigest(tokenA).slice(0, 32)) === false, '应 false')
check('恢复 合法令牌重新匹配 ⇒ 通过', sessionDigestMatches(tokenA, sessionTokenDigest(tokenA)) === true, '应 true')

// ---------------------------------------------------------------------------
// 3. 同源判据（`D05`：缺省拒）
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1:19388'
const allowed = sameOriginDecision({ origin: `http://${HOST}`, host: HOST, secFetchSite: 'same-origin' })
check('正控 同源 ⇒ 放行（具名 same_origin）', allowed.allowed === true && allowed.reason === 'same_origin', allowed.reason)
check('正控 Sec-Fetch-Site: none + 无 Origin ⇒ 放行（地址栏直达）',
  sameOriginDecision({ host: HOST, secFetchSite: 'none' }).allowed === true, '应放行')
check('负控 跨站（Sec-Fetch-Site: cross-site）⇒ 拒', (() => {
  const d = sameOriginDecision({ origin: `http://${HOST}`, host: HOST, secFetchSite: 'cross-site' })
  return d.allowed === false && d.reason === 'sec_fetch_cross_site'
})(), '应拒 sec_fetch_cross_site')
check('负控 Origin 指向别的 host ⇒ 拒', (() => {
  const d = sameOriginDecision({ origin: 'http://evil.example', host: HOST, secFetchSite: 'same-origin' })
  return d.allowed === false && d.reason === 'origin_mismatch'
})(), '应拒 origin_mismatch')
check('负控 scheme 不符（https 请求打 http 服务）⇒ 拒', (() => {
  const d = sameOriginDecision({ origin: `https://${HOST}`, host: HOST, secFetchSite: 'same-origin' })
  return d.allowed === false && d.reason === 'origin_scheme_mismatch'
})(), '应拒 origin_scheme_mismatch')
check('负控 **写请求缺 Origin 且不是 none** ⇒ 拒（缺省拒）', (() => {
  const d = sameOriginDecision({ host: HOST, secFetchSite: 'same-origin' })
  return d.allowed === false && d.reason === 'origin_missing'
})(), '应拒 origin_missing')
check('负控 缺 Host ⇒ 拒', (() => {
  const d = sameOriginDecision({ origin: `http://${HOST}`, secFetchSite: 'same-origin' })
  return d.allowed === false && d.reason === 'host_missing'
})(), '应拒 host_missing')
check('负控 Origin 不是合法 URL ⇒ 拒', (() => {
  const d = sameOriginDecision({ origin: 'not a url', host: HOST, secFetchSite: 'same-origin' })
  return d.allowed === false && d.reason === 'origin_malformed'
})(), '应拒 origin_malformed')
check('负控 端口不同（同 host 不同 port）⇒ 拒', sameOriginDecision({
  origin: 'http://127.0.0.1:19389', host: HOST, secFetchSite: 'same-origin',
}).allowed === false, '应拒（port 属于 host 的一部分）')
check('恢复 把 Origin 改回同源 ⇒ 放行',
  sameOriginDecision({ origin: `http://${HOST}`, host: HOST, secFetchSite: 'same-origin' }).allowed === true, '应放行')

// ---------------------------------------------------------------------------
// 4. CSRF 双提交（`D05`：缺省拒）
// ---------------------------------------------------------------------------

const csrfToken = createSessionToken()
check('正控 两处一致 ⇒ 放行', csrfDecision({ cookieToken: csrfToken, headerToken: csrfToken }).allowed === true, '应放行')
check('负控 缺 cookie ⇒ 拒', (() => {
  const d = csrfDecision({ headerToken: csrfToken })
  return d.allowed === false && d.reason === 'csrf_cookie_missing'
})(), '应拒 csrf_cookie_missing')
check('负控 缺头 ⇒ 拒', (() => {
  const d = csrfDecision({ cookieToken: csrfToken })
  return d.allowed === false && d.reason === 'csrf_header_missing'
})(), '应拒 csrf_header_missing')
check('负控 两处不一致 ⇒ 拒', (() => {
  const d = csrfDecision({ cookieToken: csrfToken, headerToken: createSessionToken() })
  return d.allowed === false && d.reason === 'csrf_mismatch'
})(), '应拒 csrf_mismatch')
check('负控 长度不同 ⇒ 拒（不抛）', (() => {
  const d = csrfDecision({ cookieToken: csrfToken, headerToken: csrfToken.slice(0, 10) })
  return d.allowed === false && d.reason === 'csrf_mismatch'
})(), '应拒 csrf_mismatch')
check('恢复 补上头且一致 ⇒ 放行', csrfDecision({ cookieToken: csrfToken, headerToken: csrfToken }).allowed === true, '应放行')

// ---------------------------------------------------------------------------
// 5. 登录限速（注入时钟：锁定 → 拒绝 → 到期恢复）
// ---------------------------------------------------------------------------

let clock = 1_000_000
const limiter = createLoginRateLimiter({ maxAttempts: 3, windowMs: 60_000, lockMs: 300_000, now: () => clock })
const first = limiter.record(false)
const second = limiter.record(false)
const third = limiter.record(false)
check('正控 前两次失败仍在允许态（计数如实）',
  first.allowed === true && first.failures === 1 && second.allowed === true && second.failures === 2,
  `failures=${first.failures}→${second.failures}`)
check('负控 达阈值 ⇒ 锁（具名 rate_limited）', third.allowed === false && third.reason === 'rate_limited', third.reason)
check('负控 锁定期内连**正确口令**也不放行（先问 check）',
  limiter.check().allowed === false, '应拒')
check('负控 锁定时刻 = now + lockMs', third.lockedUntil === clock + 300_000, String(third.lockedUntil))
clock += 299_999
check('负控 差 1ms 仍未解锁', limiter.check().allowed === false, '应拒')
clock += 1
const afterLock = limiter.check()
check('恢复 锁到期 ⇒ 恢复允许且计数清零',
  afterLock.allowed === true && afterLock.failures === 0, `allowed=${afterLock.allowed} failures=${afterLock.failures}`)
const success = limiter.record(true)
check('恢复 成功登录 ⇒ 计数归零', success.allowed === true && success.failures === 0, `failures=${success.failures}`)
check('负控 非法参数 ⇒ 具名抛错',
  (() => { try { createLoginRateLimiter({ maxAttempts: 0, windowMs: 1, lockMs: 1, now: () => 0 }); return false } catch (error) { return error instanceof AdminAuthError && error.code === 'admin_rate_limit_params' } })(),
  '应抛 admin_rate_limit_params')

// ---------------------------------------------------------------------------
// 6. 参数常量与边界（如实登记）
// ---------------------------------------------------------------------------

check('缺省 scrypt 参数 = N 16384 / r 8 / p 1 / keylen 32',
  DEFAULT_SCRYPT_PARAMS.N === 16384 && DEFAULT_SCRYPT_PARAMS.r === 8 && DEFAULT_SCRYPT_PARAMS.p === 1 && DEFAULT_SCRYPT_PARAMS.keylen === 32,
  JSON.stringify(DEFAULT_SCRYPT_PARAMS))
check('本门不读仓库文件（纯原语；ROOT 只用于定位，不参与判据）', typeof ROOT === 'string' && ROOT.length > 0, 'ok')

// ---------------------------------------------------------------------------
// 7. 汇总（失败关闭）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7bis. WP3：管理会话 ⇒ 审计位次（纯函数 · 失败关闭）
// ---------------------------------------------------------------------------

const principal = adminConsolePrincipalFromSession({ adminId: 'admin' })
check('正控 有可信 adminId ⇒ `{kind:\'SERVICE\', id:\'admin-console\'}`（用户 2026-10-14 裁定）',
  principal?.kind === 'SERVICE' && principal?.id === ADMIN_CONSOLE_PRINCIPAL_ID, JSON.stringify(principal))
check('负控 没有 adminId ⇒ `undefined`（**不编身份**：调用方保持 `unknown-runtime-unresolved`）',
  adminConsolePrincipalFromSession({}) === undefined, '应 undefined')
check('负控 空串 / 全空白 ⇒ `undefined`',
  adminConsolePrincipalFromSession({ adminId: '' }) === undefined &&
  adminConsolePrincipalFromSession({ adminId: '   ' }) === undefined, '应 undefined')
check('负控 非字符串 ⇒ `undefined`（不把数字/对象当身份）',
  adminConsolePrincipalFromSession({ adminId: 42 }) === undefined &&
  adminConsolePrincipalFromSession({ adminId: { id: 'admin' } }) === undefined, '应 undefined')
check('负控 位次 id **恒为** `admin-console`（单管理员档；不把 adminId 拼进去 —— 那要独立裁定）',
  adminConsolePrincipalFromSession({ adminId: 'someone-else' })?.id === ADMIN_CONSOLE_PRINCIPAL_ID,
  String(adminConsolePrincipalFromSession({ adminId: 'someone-else' })?.id))
/* ⚠️ 先拓宽成 `string` 再比：直接比 `'SYSTEM'` 会被 tsc 判 TS2367（类型上不可能重叠）——
   而"类型上不可能"本身就是要断言的事，所以用运行时字符串比 */
const principalKind: string = principal?.kind ?? ''
check('负控 种类**不是** `USER`（本仓库 USER 专指聊天参与者）也**不是** `SYSTEM`（人/系统要可分）',
  principalKind !== 'USER' && principalKind !== 'SYSTEM', principalKind)

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP1 认证原语：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 本门**不**主张"登录已可用"：HTTP 接线与 cookie 属性要等 WP1b 的真 server 门（a1:auth:http:verify）。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
