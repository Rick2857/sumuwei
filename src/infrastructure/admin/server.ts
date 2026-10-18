/**
 * A1 / **WP1b：管理后台的认证入口**（真 HTTP 服务；只 loopback、只认证、**零业务面**）。
 *
 * ============================================================================
 *  这个服务做什么、不做什么
 * ============================================================================
 * ```text
 * 做：`POST /login`（口令 ⇒ 会话 cookie）· `POST /logout`（清会话）· `GET /session`（是否已登录 + 到期时刻）
 *     三道闸全部接上：**同源**（D05）· **CSRF 双提交**（D05，登录除外，见下）· **登录限速**（D03）
 *     会话：HttpOnly + SameSite=Strict + Path=/（远程 HTTPS 档才加 Secure）；**只存摘要**（D04）
 * 不做：任何业务面（总览/查询/trace/任务从 **WP2** 起）· 静态资源 · 第二个真相来源（D01）· 数据库（D02）
 * ⚠️ 它**不**新建第二套真相：这里没有任何"从库里读出来的状态"可展示 —— 那要等 WP2 复用既有服务。
 * ```
 *
 * 两处刻意的设计：
 * ```text
 * ① **登录不要 CSRF**：登录**之前**没有会话，双提交令牌无处可取；对登录有效的防线是
 *    **同源判据** + 限速（`D05` 的判据只对"已持有会话的写操作"成立）。⇒ `/login` 只过同源。
 * ② **CSRF cookie 不是 HttpOnly**：双提交的语义要求页面 JS 能读到它并与请求头一起发；
 *    真正保命的是 `lg_admin_session`（HttpOnly）。两者**不同名**，且服务端只信"两处相等"。
 * ```
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  createLoginRateLimiter,
  createSessionToken,
  csrfDecision,
  sameOriginDecision,
  sessionDigestMatches,
  sessionTokenDigest,
  verifyAdminPassword,
  type RateLimitReading,
} from './auth.ts'
import { renderAdminPage } from './page.ts'
import {
  ADMIN_PORT_METHOD,
  AdminQueryError,
  shouldDropSecretShapedField,
  surfaceByPath,
  type AdminQueryPorts,
  type AdminReadSurfacePayload,
  type AdminWritePorts,
} from './query-ports.ts'

/** cookie 名（**两个**：会话 HttpOnly；CSRF 供双提交读取） */
export const ADMIN_SESSION_COOKIE = 'lg_admin_session'
export const ADMIN_CSRF_COOKIE = 'lg_admin_csrf'

/** 请求体上限（认证面只有一个小 JSON；超了就是有人在拿它当上传口） */
const MAX_BODY_BYTES = 8 * 1024

export interface AdminAuthServerOptions {
  /** 管理员口令的**存储串**（由 `hashAdminPassword` 生成；服务端**永不**持有明文） */
  readonly passwordHash: string
  readonly host?: string | undefined
  readonly port?: number | undefined
  /** 会话有效期（毫秒） */
  readonly sessionTtlMs?: number | undefined
  /** 注入时钟（门要确定性；缺省 `Date.now`） */
  readonly now?: (() => number) | undefined
  /** 限速参数（缺省：5 次失败 / 5 分钟窗口 / 15 分钟锁定） */
  readonly rateLimit?: { maxAttempts: number; windowMs: number; lockMs: number } | undefined
  /** 认的 scheme（远程 HTTPS 档传 `https` ⇒ cookie 加 `Secure`） */
  readonly scheme?: 'http' | 'https' | undefined
  /**
   * `WP2` 的**只读端口**（由装配根注入；缺省 = 一个面都没接线 ⇒ 每个面如实 501）。
   *
   * ⚠️ 本服务**不**自己读库：它只调这些端口（`D01`/`D07`）。端口实现复用既有 reader/投影/账本。
   */
  readonly ports?: AdminQueryPorts | undefined
  /**
   * WP4 的**受控写端口**（缺省 = 一个写面都没接线 ⇒ `jobs.admit` 如实 501）。
   *
   * ⚠️ 端口**必须**保证"审计写不进 ⇒ 登记失败关闭"（服务端只看到抛错）。
   */
  readonly writePorts?: AdminWritePorts | undefined
  /** 已认证的管理身份（**服务端侧**来源；缺省 = `'admin'` 单管理员档 `R-A1-4`） */
  readonly adminIdOf?: (() => string) | undefined
}

export interface AdminAuthServer {
  readonly port: number
  readonly url: string
  start(): Promise<void>
  stop(): Promise<void>
  /** 当前活着的会话数（**读数**：只有计数，不含任何令牌/摘要） */
  liveSessionCount(): number
  /** 最近一次登录判据的读数（**不含口令**） */
  lastLoginReading(): { allowed: boolean; reason: string; status: number } | undefined
}

interface SessionRecord {
  readonly digest: string
  readonly expiresAt: number
  readonly csrfToken: string
}

const json = (response: ServerResponse, status: number, payload: Record<string, unknown>): void => {
  const body = `${JSON.stringify(payload)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body, 'utf8'),
  })
  response.end(body)
}

const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.split('=')
    if (key?.trim() === name) return rest.join('=').trim()
  }
  return undefined
}

const readBody = async (request: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) return { ok: false, reason: 'body_too_large' }
    chunks.push(buffer)
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

/**
 * 建一个**只做认证**的管理入口。
 *
 * ⚠️ 它**不**自己开库、**不**读环境、**不**写文件：调用方（WP1b 的 CLI / WP2 的装配根）负责把
 *    口令哈希与参数喂进来 —— 于是这个服务可以在**核心停机**时照常起（`D02`/`A1-G6`）。
 */
export function createAdminAuthServer(options: AdminAuthServerOptions): AdminAuthServer {
  const host = options.host ?? '127.0.0.1'
  const scheme = options.scheme ?? 'http'
  const sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000
  const now = options.now ?? (() => Date.now())
  const limiter = createLoginRateLimiter({
    maxAttempts: options.rateLimit?.maxAttempts ?? 5,
    windowMs: options.rateLimit?.windowMs ?? 5 * 60 * 1000,
    lockMs: options.rateLimit?.lockMs ?? 15 * 60 * 1000,
    now,
  })
  const sessions = new Map<string, SessionRecord>()
  let lastLoginReading: { allowed: boolean; reason: string; status: number } | undefined
  /** 真的绑上的端口（`listen(0)` 时由内核分配；`port`/`url` 用 **getter** 读它） */
  let boundPort = options.port ?? 0

  const cookieAttributes = (httpOnly: boolean): string =>
    `${httpOnly ? 'HttpOnly; ' : ''}SameSite=Strict; Path=/${scheme === 'https' ? '; Secure' : ''}`

  const purgeExpired = (): void => {
    const at = now()
    for (const [digest, record] of sessions) if (record.expiresAt <= at) sessions.delete(digest)
  }

  const sessionOf = (request: IncomingMessage): SessionRecord | undefined => {
    purgeExpired()
    const token = readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE)
    if (token === undefined || token === '') return undefined
    for (const record of sessions.values()) if (sessionDigestMatches(token, record.digest)) return record
    return undefined
  }

  const originGuard = (request: IncomingMessage, response: ServerResponse): boolean => {
    const decision = sameOriginDecision({
      origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
      host: typeof request.headers.host === 'string' ? request.headers.host : undefined,
      secFetchSite: typeof request.headers['sec-fetch-site'] === 'string' ? request.headers['sec-fetch-site'] : undefined,
      scheme,
    })
    if (decision.allowed) return true
    json(response, 403, { error: 'origin_rejected', reason: decision.reason })
    return false
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `${scheme}://${request.headers.host ?? `${host}`}`)
      const method = request.method ?? 'GET'

      /*
       * `WP2`：**首版管理页**（一页 HTML；`R-A1-1` 的"轻量、独立"档）。
       *
       * ⚠️ 它**不需要会话**：页面是**空壳**（不含任何数据/密钥），数据一律现取 `/api/*`（那些面要会话）。
       *    这样"页面显示 = 程序事实"是**结构性**的，而不是靠渲染时小心。
       */
      if ((url.pathname === '/' || url.pathname === '/index.html') && method === 'GET') {
        const html = renderAdminPage()
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(html, 'utf8'),
        })
        response.end(html)
        return
      }

      if (url.pathname === '/session' && method === 'GET') {
        const session = sessionOf(request)
        json(response, 200, {
          authenticated: session !== undefined,
          ...(session === undefined ? {} : { expiresAt: session.expiresAt }),
        })
        return
      }

      if (url.pathname === '/login' && method === 'POST') {
        /* ① 同源（登录唯一的防线之一；CSRF 在登录前无从取令牌，见文件头 ①） */
        if (!originGuard(request, response)) return
        /* ② 限速：**先问**再验口令（锁定期内连正确口令也不放行） */
        const gate: RateLimitReading = limiter.check()
        if (!gate.allowed) {
          lastLoginReading = { allowed: false, reason: gate.reason, status: 429 }
          response.setHeader('retry-after', String(Math.max(1, Math.ceil((gate.lockedUntil - now()) / 1000))))
          json(response, 429, { error: 'rate_limited', lockedUntil: gate.lockedUntil })
          return
        }
        const body = await readBody(request)
        if (!body.ok) {
          json(response, 413, { error: body.reason })
          return
        }
        let password = ''
        try {
          const parsed = JSON.parse(body.text === '' ? '{}' : body.text) as { password?: unknown }
          password = typeof parsed.password === 'string' ? parsed.password : ''
        } catch {
          json(response, 400, { error: 'bad_json' })
          return
        }
        const verified = verifyAdminPassword(password, options.passwordHash)
        const reading = limiter.record(verified)
        if (!verified) {
          const status = reading.allowed ? 401 : 429
          lastLoginReading = { allowed: false, reason: reading.allowed ? 'bad_credentials' : reading.reason, status }
          json(response, status, { error: reading.allowed ? 'bad_credentials' : reading.reason })
          return
        }
        const token = createSessionToken()
        const csrfToken = createSessionToken()
        const expiresAt = now() + sessionTtlMs
        sessions.set(sessionTokenDigest(token), { digest: sessionTokenDigest(token), expiresAt, csrfToken })
        lastLoginReading = { allowed: true, reason: 'session_created', status: 200 }
        response.setHeader('set-cookie', [
          `${ADMIN_SESSION_COOKIE}=${token}; ${cookieAttributes(true)}; Max-Age=${String(Math.floor(sessionTtlMs / 1000))}`,
          `${ADMIN_CSRF_COOKIE}=${csrfToken}; ${cookieAttributes(false)}; Max-Age=${String(Math.floor(sessionTtlMs / 1000))}`,
        ])
        json(response, 200, { authenticated: true, expiresAt })
        return
      }

      /*
       * -----------------------------------------------------------------------
       *  WP2：只读面（**只调端口**，绝不自己读库）
       * -----------------------------------------------------------------------
       * ⚠️ 三条失败关闭：① 没有会话 ⇒ 401（**没有**"匿名可读"这一档）
       *                  ② 端口没接线 ⇒ 501 `surface_not_wired`（**不**用空数组冒充"没有数据"）
       *                  ③ 端口抛错 ⇒ 500 `surface_failed`（**不**把异常消息回吐给浏览器）
       */
      const surface = method === 'GET' ? surfaceByPath(url.pathname) : undefined
      if (surface !== undefined) {
        if (sessionOf(request) === undefined) {
          json(response, 401, { error: 'not_authenticated' })
          return
        }
        const ports = options.ports
        const methodName = ADMIN_PORT_METHOD[surface.id]
        const reader = ports?.[methodName] as
          | ((input?: { cursor?: string | undefined; limit?: number | undefined }) => Promise<AdminReadSurfacePayload>)
          | undefined
        if (ports === undefined || typeof reader !== 'function') {
          json(response, 501, { error: 'surface_not_wired', surface: surface.id })
          return
        }
        try {
          /* 分页参数**原样**交给端口（游标不透明；`limit` 的夹紧在端口里） */
          const cursorParam = url.searchParams.get('cursor')
          const limitParam = url.searchParams.get('limit')
          const limit = limitParam === null ? undefined : Number(limitParam)
          const payload = await reader.call(ports, {
            ...(cursorParam === null || cursorParam === '' ? {} : { cursor: cursorParam }),
            ...(limit === undefined || !Number.isSafeInteger(limit) ? {} : { limit }),
          })
          let droppedFields = 0
          const items = payload.items.map((item) => {
            const kept: Record<string, unknown> = {}
            for (const field of surface.fields) {
              if (!(field in item)) continue
              /* 纵深防御：**不该含密钥**的面上出现密钥形状的字段名 ⇒ 丢掉并计数（见 `shouldDropSecretShapedField`） */
              if (shouldDropSecretShapedField(surface, field)) {
                droppedFields += 1
                continue
              }
              kept[field] = item[field]
            }
            return kept
          })
          json(response, 200, {
            surface: surface.id,
            generatedAt: payload.generatedAt,
            items,
            droppedFields,
            ...(payload.unavailable === undefined ? {} : { unavailable: payload.unavailable }),
            ...(payload.nextCursor === undefined ? {} : { nextCursor: payload.nextCursor }),
          })
        } catch (error) {
          /* ⚠️ 客户端错误（`bad_cursor`）⇒ **400**，不许伪装成 500 的服务端故障 */
          if (error instanceof AdminQueryError) {
            json(response, 400, { error: error.code, surface: surface.id })
            return
          }
          json(response, 500, { error: 'surface_failed', surface: surface.id })
        }
        return
      }

      if (url.pathname === '/logout' && method === 'POST') {
        if (!originGuard(request, response)) return
        const session = sessionOf(request)
        if (session === undefined) {
          json(response, 401, { error: 'not_authenticated' })
          return
        }
        const csrf = csrfDecision({
          cookieToken: readCookie(request.headers.cookie, ADMIN_CSRF_COOKIE),
          headerToken: typeof request.headers['x-lg-admin-csrf'] === 'string' ? request.headers['x-lg-admin-csrf'] : undefined,
        })
        if (!csrf.allowed) {
          json(response, 403, { error: 'csrf_rejected', reason: csrf.reason })
          return
        }
        sessions.delete(session.digest)
        response.setHeader('set-cookie', [
          `${ADMIN_SESSION_COOKIE}=; ${cookieAttributes(true)}; Max-Age=0`,
          `${ADMIN_CSRF_COOKIE}=; ${cookieAttributes(false)}; Max-Age=0`,
        ])
        json(response, 200, { authenticated: false })
        return
      }

      /*
       * -----------------------------------------------------------------------
       *  WP4：受控写面 `jobs.admit`（用户 2026-10-14 裁定；**唯一**一个）
       * -----------------------------------------------------------------------
       * ⚠️ 三闸缺一不可：**会话** → **同源** → **CSRF**；外加"端口没接线 ⇒ 501"。
       * ⚠️ `adminId` 取自**会话**（`options.adminIdOf`），**不**从请求体取 ——
       *    否则审计里的 initiator 就是**请求方自报**（`action-request.ts` 逐字警告过那条路）。
       */
      if (url.pathname === '/api/jobs' && method === 'POST') {
        const session = sessionOf(request)
        if (session === undefined) {
          json(response, 401, { error: 'not_authenticated' })
          return
        }
        if (!originGuard(request, response)) return
        const csrf = csrfDecision({
          cookieToken: readCookie(request.headers.cookie, ADMIN_CSRF_COOKIE),
          headerToken: typeof request.headers['x-lg-admin-csrf'] === 'string' ? request.headers['x-lg-admin-csrf'] : undefined,
        })
        if (!csrf.allowed) {
          json(response, 403, { error: 'csrf_rejected', reason: csrf.reason })
          return
        }
        const admit = options.writePorts?.jobsAdmit
        if (options.writePorts === undefined || typeof admit !== 'function') {
          json(response, 501, { error: 'write_not_wired', write: 'jobs.admit' })
          return
        }
        const body = await readBody(request)
        if (!body.ok) {
          json(response, 413, { error: body.reason })
          return
        }
        let idempotencyKey = ''
        let params: unknown = {}
        try {
          const parsed = JSON.parse(body.text === '' ? '{}' : body.text) as {
            idempotencyKey?: unknown
            params?: unknown
          }
          /* 幂等键**必填**且必须是非空字符串（缺失 ⇒ 400；**不**替调用方编一个） */
          if (typeof parsed.idempotencyKey !== 'string' || parsed.idempotencyKey.trim() === '') {
            json(response, 400, { error: 'idempotency_key_required' })
            return
          }
          idempotencyKey = parsed.idempotencyKey
          params = parsed.params ?? {}
        } catch {
          json(response, 400, { error: 'bad_json' })
          return
        }
        try {
          const result = await admit.call(options.writePorts, {
            idempotencyKey,
            params,
            adminId: options.adminIdOf === undefined ? 'admin' : options.adminIdOf(),
          })
          json(response, result.admission === 'created' ? 201 : 200, {
            admission: result.admission,
            jobId: result.jobId,
            state: result.state,
          })
        } catch (error) {
          /*
           * 端口抛错 ⇒ **失败关闭**（500 `write_failed`，不回吐异常文本）。
           * ⚠️ 幂等冲突也走这里 ⇒ 端口用 `AdminWriteError('idempotency_conflict')` 命名它，
           *    服务端据此回 **409**（明确拒绝，不静默新建第二个任务）。
           */
          const reason = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : undefined
          if (reason === 'idempotency_conflict') {
            json(response, 409, { error: 'idempotency_conflict' })
            return
          }
          json(response, 500, { error: 'write_failed', write: 'jobs.admit' })
        }
        return
      }

      json(response, 404, { error: 'not_found' })
    })().catch(() => {
      if (!response.headersSent) json(response, 500, { error: 'internal_error' })
      else response.end()
    })
  })

  return {
    /*
     * ⚠️ 这两个必须是 **getter**：`listen(0)` 之后端口才由内核分配，
     *    写成普通属性会永远停在 0（实测：门拿着 `http://127.0.0.1:0` 去 fetch ⇒ EADDRNOTAVAIL）。
     */
    get port(): number {
      return boundPort
    },
    get url(): string {
      return `http://${host}:${String(boundPort)}`
    },
    start: async () => {
      await new Promise<void>((done, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 0, host, () => {
          server.removeListener('error', reject)
          const address = server.address()
          if (address !== null && typeof address === 'object') boundPort = address.port
          done()
        })
      })
    },
    stop: async () => {
      await new Promise<void>((done) => {
        server.close(() => done())
        server.closeAllConnections()
      })
    },
    liveSessionCount: () => {
      purgeExpired()
      return sessions.size
    },
    lastLoginReading: () => lastLoginReading,
  }
}
