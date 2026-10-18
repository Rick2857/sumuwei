/**
 * A1 / **WP1：管理后台的认证原语**（纯函数 + 注入时钟；零 I/O / 零网络 / 零数据库）。
 *
 * ============================================================================
 *  归属与纪律
 * ============================================================================
 * ```text
 * 设计    ADR-135 D03（认证是第一性要求）· D04（会话与 cookie）· D05（CSRF/Origin）· D06（地址与传输）
 * 契约    Admin-Backend-Acceptance-Contract.md §2（认证与授权判据）
 * 缺口    B1（认证层从零建，全仓 0 命中）· B10（CSRF/Origin 防线为零）
 * 纪律    这里**只有**判据本身：不读环境、不开端口、不碰数据库、不落盘
 *         ⇒ 于是"登录判据对不对"可以**独立**被门测全（HTTP 接线在 WP1b）
 * ⚠️ 本模块**不**主张"登录已可用"：可用性要等 `src/infrastructure/admin/server.ts`（WP1b）的真 server 门。
 * ```
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------------------
// WP3：管理会话 ⇒ 审计位次（`D09`；用户 2026-10-14 裁定 = **SERVICE / admin-console**）
// ---------------------------------------------------------------------------

/**
 * 管理后台操作者在审计里的位次 id（**单管理员**档；`R-A1-4`）。
 *
 * ⚠️ 用户 2026-10-14 裁定：种类 = **`SERVICE`**（不是 `USER` —— 本仓库的 `USER` 专指**聊天参与者**，
 *    把操作者混进去会让"用户数/关系"这类统计悄悄多一个人；也不是 `SYSTEM` ——
 *    那会让"人亲自下命令"与"系统自动做"在审计里无法区分）。
 * ⚠️ `PrincipalKind` 只有六种，**没有** `DEVELOPER`（`contracts/actor.ts:167`）。
 * ⚠️ 将来若真要多管理员（A2），id 必须改成 `admin-console:<adminId>` ——
 *    那会**改变审计身份语义** ⇒ 需要一次独立裁定，不许顺手改。
 */
export const ADMIN_CONSOLE_PRINCIPAL_ID = 'admin-console'

/**
 * 把**已认证的管理会话**映射成审计位次（**纯函数，失败关闭**）。
 *
 * ```text
 * 有可信 adminId ⇒ { kind: 'SERVICE', id: 'admin-console' }
 * 没有/空/非字符串 ⇒ `undefined` ⇒ 调用方**保持** `unknown-runtime-unresolved`
 *                     （**不许**为了"看起来接上了"就编一个身份）
 * ```
 */
export function adminConsolePrincipalFromSession(input: { adminId?: unknown }): { kind: 'SERVICE'; id: string } | undefined {
  const adminId = input.adminId
  if (typeof adminId !== 'string' || adminId.trim() === '') return undefined
  return { kind: 'SERVICE', id: ADMIN_CONSOLE_PRINCIPAL_ID }
}

// ---------------------------------------------------------------------------
// 口令哈希（`D03` / `R-A1-4`：只存带随机盐/算法/参数的哈希；首版 Node 内置 scrypt）
// ---------------------------------------------------------------------------

/** scrypt 参数（OWASP 优先 Argon2id；Node 内置只有 scrypt ⇒ 首版用它，参数显式落盘） */
export interface ScryptParams {
  readonly N: number
  readonly r: number
  readonly p: number
  readonly keylen: number
}

/** 缺省参数（`N=2^14` ⇒ 16 MiB 内存，本机登录耗时可接受；改参数 = 改哈希串，不影响旧串校验） */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1, keylen: 32 }

/**
 * 存储格式：`scrypt$<N>$<r>$<p>$<keylen>$<saltBase64url>$<hashBase64url>`
 * （算法与**全部**参数在串里，便于日后换代）
 *
 * ⚠️ `keylen` **必须**进串：scrypt 的输出是**前缀一致**的（PBKDF2 的收尾），
 *    若校验时按"存储串里那段的长度"去派生，把哈希段**截断**4 个 base64 字符
 *    仍会**校验通过**（实测踩到过）。⇒ 长度要**声明**并**逐字核对**。
 */
const HASH_PREFIX = 'scrypt'
const MIN_KEYLEN = 16
const MAX_KEYLEN = 64

/** 口令为空的具名拒绝（不静默接受空口令 —— 那是"无通用默认口令"的反面） */
export class AdminAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AdminAuthError'
  }
}

/**
 * 生成口令哈希。**必须**显式给口令；空口令/非字符串 ⇒ 具名抛错。
 *
 * ⚠️ 盐由调用方也可注入（门要确定性），生产**不要**注入（缺省 `randomBytes(16)`）。
 */
export function hashAdminPassword(
  password: string,
  options: { salt?: Buffer; params?: ScryptParams } = {}
): string {
  if (typeof password !== 'string' || password === '') {
    throw new AdminAuthError('admin_password_empty', '拒绝：管理口令为空（不设通用默认口令）')
  }
  const params = options.params ?? DEFAULT_SCRYPT_PARAMS
  const salt = options.salt ?? randomBytes(16)
  const derived = scryptSync(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p })
  return [
    HASH_PREFIX, String(params.N), String(params.r), String(params.p), String(params.keylen),
    salt.toString('base64url'), derived.toString('base64url'),
  ].join('$')
}

/**
 * 校验口令。**失败关闭**：任何解析不了 / 参数非法 / 长度不符的存储串 ⇒ `false`（**不**抛、**不**回落）。
 *
 * ⚠️ 用 `timingSafeEqual`（等长前提由长度先判保证）；比较失败与解析失败**对外同形**（都 `false`），
 *    调用方不得据此区分"口令错"与"存储坏"。
 */
export function verifyAdminPassword(password: string, stored: string): boolean {
  if (typeof password !== 'string' || password === '') return false
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 7) return false
  const [prefix, rawN, rawR, rawP, rawKeylen, saltPart, hashPart] = parts as [string, string, string, string, string, string, string]
  if (prefix !== HASH_PREFIX) return false
  const N = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  const keylen = Number(rawKeylen)
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false
  if (!Number.isSafeInteger(keylen) || keylen < MIN_KEYLEN || keylen > MAX_KEYLEN) return false
  if (N <= 1 || r <= 0 || p <= 0) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltPart, 'base64url')
    expected = Buffer.from(hashPart, 'base64url')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  /* ⚠️ 长度**逐字核对**（截断过的存储串在这里被拒；见文件头对"前缀一致"的说明） */
  if (expected.length !== keylen) return false
  let actual: Buffer
  try {
    actual = scryptSync(password, salt, keylen, { N, r, p })
  } catch {
    return false
  }
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

// ---------------------------------------------------------------------------
// 会话令牌（`D04`：浏览器只持 HttpOnly cookie；**只存摘要**）
// ---------------------------------------------------------------------------

/** 高熵会话令牌（32 字节 ⇒ 256 位；base64url 无填充） */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 令牌摘要（**存库/存文件只存它**）。
 *
 * ⚠️ 这里用 sha256 而不是 scrypt：令牌是**高熵随机**（不是人选的口令），
 *    慢哈希对"离线爆破 256 位随机"没有增益，却会让每个请求都付一次 scrypt 的代价。
 */
export function sessionTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 摘要比对（定时安全；长度先判，非法输入一律 `false`） */
export function sessionDigestMatches(token: string, storedDigest: string): boolean {
  if (typeof token !== 'string' || token === '') return false
  if (typeof storedDigest !== 'string' || storedDigest === '') return false
  const actual = Buffer.from(sessionTokenDigest(token), 'utf8')
  const expected = Buffer.from(storedDigest, 'utf8')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

// ---------------------------------------------------------------------------
// 同源 / CSRF（`D05`：缺省**拒**；这两个判据只对**会改状态**的请求用）
// ---------------------------------------------------------------------------

export interface SameOriginInput {
  /** 请求头 `Origin`（浏览器对跨源与多数 POST 会带；**缺席**要单独判） */
  readonly origin?: string | undefined
  /** 请求头 `Host`（`host:port`，不含 scheme） */
  readonly host?: string | undefined
  /** 请求头 `Sec-Fetch-Site`（现代浏览器带；`none` = 用户直接输入地址） */
  readonly secFetchSite?: string | undefined
  /** 本服务自己认的 scheme（缺省 `http`；远程 HTTPS 档必须传 `https`） */
  readonly scheme?: 'http' | 'https' | undefined
}

export interface OriginDecision {
  readonly allowed: boolean
  /** 具名理由（**允许时也有**：`same_origin` / `sec_fetch_none`） */
  readonly reason: string
}

const SAME_ORIGIN_REASONS = {
  allowed: 'same_origin',
  none: 'sec_fetch_none',
  originMissing: 'origin_missing',
  hostMissing: 'host_missing',
  originMismatch: 'origin_mismatch',
  schemeMismatch: 'origin_scheme_mismatch',
  crossSite: 'sec_fetch_cross_site',
  malformed: 'origin_malformed',
} as const

/**
 * 同源判据（**失败关闭**）：
 *
 * ```text
 * ① `Sec-Fetch-Site` 是 `cross-site` ⇒ 拒（浏览器自己说的，最便宜的一道）
 * ② `Origin` 与 `scheme://Host` **逐字**相等 ⇒ 放行
 * ③ `Sec-Fetch-Site: none`（地址栏直达）**且** `Origin` 缺席 ⇒ 放行（GET 导航的正常形状）
 * ④ 其余（含 `Origin` 缺席的写请求）⇒ 拒
 * ```
 */
export function sameOriginDecision(input: SameOriginInput): OriginDecision {
  const scheme = input.scheme ?? 'http'
  const site = typeof input.secFetchSite === 'string' ? input.secFetchSite.trim().toLowerCase() : ''
  if (site === 'cross-site') return { allowed: false, reason: SAME_ORIGIN_REASONS.crossSite }
  const host = typeof input.host === 'string' ? input.host.trim() : ''
  const origin = typeof input.origin === 'string' ? input.origin.trim() : ''
  if (origin === '') {
    if (site === 'none') return { allowed: true, reason: SAME_ORIGIN_REASONS.none }
    return { allowed: false, reason: SAME_ORIGIN_REASONS.originMissing }
  }
  if (host === '') return { allowed: false, reason: SAME_ORIGIN_REASONS.hostMissing }
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return { allowed: false, reason: SAME_ORIGIN_REASONS.malformed }
  }
  if (parsed.protocol !== `${scheme}:`) return { allowed: false, reason: SAME_ORIGIN_REASONS.schemeMismatch }
  if (parsed.host !== host) return { allowed: false, reason: SAME_ORIGIN_REASONS.originMismatch }
  return { allowed: true, reason: SAME_ORIGIN_REASONS.allowed }
}

export interface CsrfInput {
  /** cookie 里的令牌（双提交） */
  readonly cookieToken?: string | undefined
  /** 请求头里的令牌（`x-lg-admin-csrf`） */
  readonly headerToken?: string | undefined
}

export interface CsrfDecision {
  readonly allowed: boolean
  readonly reason: string
}

/** CSRF 判据（**失败关闭**）：两处都要有、都要非空、**逐字相等**（定时安全比较） */
export function csrfDecision(input: CsrfInput): CsrfDecision {
  const cookie = typeof input.cookieToken === 'string' ? input.cookieToken : ''
  const header = typeof input.headerToken === 'string' ? input.headerToken : ''
  if (cookie === '') return { allowed: false, reason: 'csrf_cookie_missing' }
  if (header === '') return { allowed: false, reason: 'csrf_header_missing' }
  const a = Buffer.from(cookie, 'utf8')
  const b = Buffer.from(header, 'utf8')
  if (a.length !== b.length) return { allowed: false, reason: 'csrf_mismatch' }
  return timingSafeEqual(a, b) ? { allowed: true, reason: 'csrf_ok' } : { allowed: false, reason: 'csrf_mismatch' }
}

// ---------------------------------------------------------------------------
// 登录限速（`D03`：登录限速；注入时钟 ⇒ 可被判据测全）
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  /** 窗口内允许的**失败**次数（达到即锁） */
  readonly maxAttempts: number
  /** 计数窗口 */
  readonly windowMs: number
  /** 锁定时长 */
  readonly lockMs: number
  readonly now: () => number
}

export interface RateLimitReading {
  readonly allowed: boolean
  readonly reason: string
  /** 解锁时刻（毫秒；未锁时为 0） */
  readonly lockedUntil: number
  /** 当前窗口内的失败计数 */
  readonly failures: number
}

/**
 * 登录限速器（**成功即清零**；锁定期内一律拒）。
 *
 * ⚠️ 它**不**承诺抗分布式爆破（首版单机单管理员；`L-A1-*` 登记该边界）。
 */
export function createLoginRateLimiter(options: RateLimiterOptions) {
  const { maxAttempts, windowMs, lockMs, now } = options
  if (maxAttempts <= 0 || windowMs <= 0 || lockMs <= 0) {
    throw new AdminAuthError('admin_rate_limit_params', '拒绝：限速参数必须为正数')
  }
  let failures = 0
  let windowStartedAt = 0
  let lockedUntil = 0

  const read = (): RateLimitReading => {
    const at = now()
    if (lockedUntil > at) return { allowed: false, reason: 'rate_limited', lockedUntil, failures }
    if (lockedUntil !== 0 && lockedUntil <= at) {
      /* 锁过期 ⇒ 回到干净状态（恢复路径；窗口也重开） */
      lockedUntil = 0
      failures = 0
      windowStartedAt = at
    }
    if (windowStartedAt === 0 || at - windowStartedAt >= windowMs) {
      windowStartedAt = at
      failures = 0
    }
    return { allowed: true, reason: 'rate_ok', lockedUntil: 0, failures }
  }

  return {
    /** 登录**前**问一次（锁定期内直接拒，不必去验口令） */
    check: read,
    /** 登录**后**记账：成功清零；失败累计，达阈值即锁 */
    record: (succeeded: boolean): RateLimitReading => {
      const current = read()
      if (!current.allowed) return current
      if (succeeded) {
        failures = 0
        lockedUntil = 0
        return { allowed: true, reason: 'rate_ok', lockedUntil: 0, failures: 0 }
      }
      failures += 1
      if (failures >= maxAttempts) {
        lockedUntil = now() + lockMs
        return { allowed: false, reason: 'rate_limited', lockedUntil, failures }
      }
      return { allowed: true, reason: 'rate_ok', lockedUntil: 0, failures }
    },
  }
}
