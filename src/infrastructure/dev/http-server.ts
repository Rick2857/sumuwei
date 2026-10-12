/**
 * Developer Query HTTP Adapter —— **最小、只读、仅 loopback**（M5.1 WP2 / AT2.6 + AT5.1）。
 *
 * ============================================================================
 *  为什么是手写 `node:http`，而不是一个 Web 框架
 * ============================================================================
 * 仓库里**没有**任何 HTTP / server / 路由基础设施（M5.1 Repository Map F-1，实测 grep 零命中），
 * 而计划书 G-05 / AT5.7 明确禁止为了一个开发者面引入新生态。
 * 于是这里只做三件事：解 URL、查表、回 JSON。**零新依赖**。
 *
 * ---------------------------------------------------------------------------
 *  四道闸（AT5.1：development only / loopback only）
 * ---------------------------------------------------------------------------
 *  ① **必须显式请求**才存在：只有 `--dev-server` 这一个入口会调它
 *     （默认不存在，而不是"默认开启但有个开关"）
 *  ② **只绑 loopback**：`host` 不是回环地址就直接抛（不"警告后继续"）
 *  ③ **逐个请求验对端**：即便绑到了 loopback，也再查一次
 *     `req.socket.remoteAddress` —— 有人把 host 改成 0.0.0.0 时这是最后一道
 *  ④ **只允许 GET**：写方法一律 405。Query 面本来就没有写语义（G-03），
 *     让它们连"路由存在"都问不出来，比答 403 更诚实
 *
 * ---------------------------------------------------------------------------
 *  它**不含**任何业务判断
 * ---------------------------------------------------------------------------
 * 解析交给契约层的 `parse*Query`（失败关闭），取数交给 `DeveloperQueryService`。
 * 这一层只做：URL → 查询对象 → DTO → JSON，以及**错误 → 状态码**的映射。
 *
 * ⚠️ 错误响应里**永不**带 stack、SQL、正文。只有 `{ error: { code, message } }`：
 *    这条路径是外发的，而"排查方便"不该以泄漏为代价。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KernelError,
  isKernelError,
  type CharacterId,
} from '../../kernel/contracts/index.ts'
import {
  parseExecutionGetQuery,
  parseExecutionListQuery,
  parseMemoryIntegrityQuery,
  parseMemoryStatsQuery,
  parseTraceGetQuery,
  parseTraceListQuery,
  type DeveloperQueryService,
} from '../../kernel/contracts/developer-query.ts'
import type { DeveloperControlService } from './control-service.ts'
import { HttpError } from './http-error.ts'

/** 默认端口：给一个人能记住的数（`0` 表示临时端口，测试用） */
export const DEFAULT_DEVELOPER_HTTP_PORT = 8787

/** 请求体上限（控制命令是短 JSON；没有上限就等于允许一次内存耗尽） */
export const MAX_CONTROL_BODY_BYTES = 64 * 1024

export interface DeveloperHttpServerOptions {
  service: DeveloperQueryService
  /** 查询面绑定的角色（查询对象里的 characterId 由它补上，**不取自 URL**） */
  characterId: CharacterId
  /**
   * 控制面（M5.1 WP3）。
   *
   * ⚠️ **可选**：不注入时 `/dev/control/*` 路由**根本不存在**（404），
   *    而不是存在但拒答。一个"看得见点不动"的按钮与一个不存在的按钮，
   *    在排查时的含义完全不同。
   */
  control?: DeveloperControlService
  /** 必须是回环地址；缺省 `127.0.0.1` */
  host?: string
  /** 缺省 {@link DEFAULT_DEVELOPER_HTTP_PORT}；`0` = 由内核分配临时端口 */
  port?: number
  /** 路径前缀（AT2.6："实际 prefix 可依现有服务器规范调整"） */
  prefix?: string
  /**
   * 是否提供开发者页面（M5.1 WP5 / AT5.2–AT5.7）。
   *
   * ⚠️ **不是**一个新开关：页面跟着 `--dev-server` 一起存在或一起不存在
   *    （AT5.1 的 feature guard 已经在 WP2 建好，页面不再建第二套）。
   *    这个参数的存在是为了让门能证明"**没有页面时，两个面一模一样**"。
   */
  servePage?: boolean
  /** 页面资产路径；缺省 = 与本模块同目录的 `page.html` */
  pagePath?: string
}

export interface DeveloperHttpServer {
  /** 形如 `http://127.0.0.1:8787`（端口是内核实际分配的那个） */
  readonly url: string
  readonly host: string
  readonly port: number
  close: () => Promise<void>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (LOOPBACK_HOSTS.has(normalized)) return true
  // 127.0.0.0/8 全是回环
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}

/** 对端地址是否回环（`::ffff:127.0.0.1` 这类 IPv4 映射也要认） */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address.trim() === '') return false
  const normalized = address.trim().toLowerCase().replace(/^::ffff:/, '')
  return isLoopbackHost(normalized)
}

// ---------------------------------------------------------------------------
// 响应与错误
// ---------------------------------------------------------------------------

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // 开发者面**绝不**被缓存：它读的是"此刻的库"
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * 读页面资产。
 *
 * ⚠️ **每次请求都读**（而不是启动时读一次）：这样"删掉这个文件"这件事
 *    立刻生效，删除测试不需要重启服务器 —— 删掉之后这条路由回 404，
 *    而**其余端点一个字都不变**。
 * ⚠️ 读不到**不抛**：资产缺失是一个被支持的运行状态（页面本来就可有可无）。
 */
export function readPageHtml(pagePath?: string): string | undefined {
  const path = pagePath ?? join(dirname(fileURLToPath(import.meta.url)), 'page.html')
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  })
  response.end(html)
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  /*
   * ⚠️ 只回 code 与一句人类可读说明。
   *    不带 stack、不带 SQL、不带库里的行 —— 这条路径是外发的。
   */
  sendJson(response, status, { error: { code, message } })
}

/**
 * 错误 → 状态码的**唯一**映射。
 *
 * 与 `actionStatusOfFailure` / `controlLadderBooleansOf` 同一条纪律：
 * 一个映射只有一处实现，否则"同样是越界，一处 400 一处 500"迟早出现。
 */
export function statusOfError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message }
  }
  if (isKernelError(error)) {
    const kernelError = error as KernelError
    switch (kernelError.kind) {
      case 'validation_error':
        return { status: 400, code: kernelError.code, message: kernelError.message }
      case 'persistence_error':
        // 读库失败是**服务端**的问题，不是请求的问题
        return { status: 503, code: kernelError.code, message: kernelError.message }
      default:
        return { status: 500, code: kernelError.code, message: kernelError.message }
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, code: 'developer_query_internal_error', message: message.slice(0, 200) }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

interface RouteContext {
  service: DeveloperQueryService
  control: DeveloperControlService | undefined
  characterId: CharacterId
  url: URL
  /** `:id` 段按出现顺序捕获 */
  params: readonly string[]
  /** 原始请求体（只有 POST 路由会读；上限见 {@link MAX_CONTROL_BODY_BYTES}） */
  rawBody: string
  /** 开发者页面的 HTML；资产不存在时是 `undefined`（→ 那条路由回 404） */
  pageHtml?: string
}

type RouteHandler = (context: RouteContext) => Promise<unknown>

/** 控制面路由的返回值：状态码由**阶梯**决定，而不是由 HTTP 惯例决定 */
interface ControlHttpResponse {
  status: number
  body: unknown
}

interface Route {
  /** 形如 `['/dev/query/traces', ':id']`（已去掉空段） */
  segments: readonly string[]
  pattern: string
  method: 'GET' | 'POST'
  /**
   * `page` = 直接回 DTO；`lookup` = 契约层回的是 `DeveloperLookup`（三态），
   * 由这一层**拆封**成 200/404 —— 见 `unwrapLookup`；
   * `control` = 返回 {@link ControlHttpResponse}（状态码由 ControlResult 的阶梯决定）；
   * `html` = 回一段 HTML（开发者页面；资产缺失时这层抛 404，其余端点不受影响）。
   */
  kind: 'page' | 'lookup' | 'control' | 'html'
  /**
   * 这条路由允许的查询串参数（**白名单**）。
   *
   * ⚠️ 必须有这一层：handler 只挑自己认识的参数读，于是
   *    `?orderBy=x` 会在到达契约层的 `rejectUnknownKeys` **之前**就被丢掉，
   *    表现成"传了参数但没生效" —— 而那是查不出来的 bug 形状。
   *    （实测抓到过：`?orderBy=x` 曾经回 200。）
   */
  allowedQueryParams: readonly string[]
  handler: RouteHandler
}

/**
 * 查询串 → 数字。
 *
 * ⚠️ 非数字**原样传下去**，由契约层的 `assertDeveloperLimit` 抛
 *    `developer_bad_limit` —— 在这里悄悄兜底成默认值会让 `?limit=abc`
 *    看起来像成功，而那正是"参数没生效但没人发现"的经典形状。
 */
function numberParam(url: URL, name: string): number | string | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : raw
}

function textParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name)
  return raw === null || raw.trim() === '' ? undefined : raw
}

/**
 * 路由表。
 *
 * 每个 handler **只**做两件事：调契约层的 `parse*Query`、调 service。
 * 任何"顺便查一下"都会让这一层变成第二个业务实现（AT2.1 明令禁止）。
 */
export function buildDeveloperQueryRoutes(prefix = '/dev/query'): Route[] {
  const base = prefix.replace(/\/$/, '')
  const route = (
    path: string,
    handler: RouteHandler,
    options: { kind?: Route['kind']; params?: readonly string[]; method?: Route['method'] } = {}
  ): Route => {
    const segments = path.split('/').filter((part) => part !== '')
    return {
      segments,
      pattern: path,
      method: options.method ?? 'GET',
      kind: options.kind ?? 'page',
      allowedQueryParams: options.params ?? [],
      handler,
    }
  }

  return [
    /*
     * 开发者页面（M5.1 WP5）。
     *
     * ⚠️ 它是一条**独立**路由，且内容来自一个**可以整个删掉**的静态资产：
     *    资产不存在 → 这条路由回一个说明性的 404，而**其余所有端点照常**。
     *    "删掉整个开发者页面之后 kernel / agent / 全部核心门照常"
     *    因此不是一句承诺，而是这一层结构上的后果（`verify-m5.1-page` 会真的删一次）。
     */
    route('/', async ({ pageHtml }) => {
      if (pageHtml === undefined) {
        throw new HttpError(
          404,
          'developer_page_missing',
          '开发者页面资产不存在（page.html 被删掉或被移走了）。' +
            '查询面与控制面不受影响 —— 这条路由是独立的，删掉页面不会影响任何别的东西。'
        )
      }
      return pageHtml
    }, { kind: 'html' }),

    route(`${base}/health`, ({ service, characterId }) => service.getHealth({ characterId })),

    route(`${base}/capabilities`, ({ service, characterId }) =>
      service.getCapabilities({ characterId })
    ),

    route(
      `${base}/traces`,
      ({ service, characterId, url }) =>
        service.listTraces(
          parseTraceListQuery({
            characterId,
            limit: numberParam(url, 'limit'),
            cursor: textParam(url, 'cursor'),
            status: textParam(url, 'status'),
          })
        ),
      { params: ['limit', 'cursor', 'status'] }
    ),

    route(
      `${base}/traces/:id`,
      ({ service, characterId, params }) =>
        service.getTrace(parseTraceGetQuery({ characterId, traceId: params[0] })),
      { kind: 'lookup' }
    ),

    route(`${base}/memory/stats`, ({ service, characterId }) =>
      service.getMemoryStats(parseMemoryStatsQuery({ characterId }))
    ),

    route(
      `${base}/memory/integrity`,
      ({ service, characterId, url }) =>
        service.getMemoryIntegrity(
          parseMemoryIntegrityQuery({
            characterId,
            maxRows: numberParam(url, 'maxRows'),
          })
        ),
      { params: ['maxRows'] }
    ),

    route(
      `${base}/executions`,
      ({ service, characterId, url }) =>
        service.listExecutions(
          parseExecutionListQuery({
            characterId,
            limit: numberParam(url, 'limit'),
            cursor: textParam(url, 'cursor'),
            status: textParam(url, 'status'),
            capability: textParam(url, 'capability'),
          })
        ),
      { params: ['limit', 'cursor', 'status', 'capability'] }
    ),

    route(
      `${base}/executions/:id`,
      ({ service, characterId, params }) =>
        service.getExecution(parseExecutionGetQuery({ characterId, actionId: params[0] })),
      { kind: 'lookup' }
    ),

    // ---- 控制面（M5.1 WP3）-------------------------------------------------
    route(
      `${base}/control/commands`,
      async ({ control }) => {
        if (control === undefined) {
          // 没注入控制面时这条路由**不存在**（见 buildRoutes 里的过滤），
          // 因此走到这里说明装配错了 —— 抛出去比回一个空表诚实
          throw new HttpError(
            503,
            'developer_control_not_wired',
            '控制面没有装配（DeveloperControlService 未注入）'
          )
        }
        return control.listCommands()
      }
    ),

    route(
      `${base}/control/commands/:type`,
      ({ control, rawBody }) => {
        if (control === undefined) {
          throw new HttpError(
            503,
            'developer_control_not_wired',
            '控制面没有装配（DeveloperControlService 未注入）'
          )
        }
        return executeControlRequest(control, rawBody)
      },
      { kind: 'control', method: 'POST' }
    ),
  ]
}

/**
 * 控制命令的 HTTP 语义。
 *
 * ============================================================================
 *  ⚠️ 状态码由**阶梯**决定，而不是由 HTTP 惯例决定（AT3.6）
 * ============================================================================
 * 计划书写得很直接：**"禁止 HTTP 200 == executed"**。
 * 因此：
 *
 *   rejected   → 400（请求本身不被允许；body 里仍带完整的 ControlResult，
 *                    这样"它试图执行什么、为什么被拒"是可读的）
 *   accepted   → 200 + `attempted: false`（dryRun 的真实落点）
 *   attempted  → 200 + `disposition: failed`
 *   executed   → 200 + `executed: true, verification: failed`
 *   verified   → 200 + `verification: verified`
 *
 * 于是 `accepted` 与 `verified` **同为 200**，而它们的阶梯完全不同 ——
 * 这正是"200 不意味着执行过"的可验证形式。
 */
export function executeControlRequest(
  control: DeveloperControlService,
  rawBody: string
): Promise<ControlHttpResponse> {
  let parsed: unknown
  try {
    parsed = rawBody.trim() === '' ? {} : JSON.parse(rawBody)
  } catch (error) {
    throw new HttpError(
      400,
      'developer_control_body_not_json',
      `控制命令的请求体必须是 JSON：${error instanceof Error ? error.message : String(error)}`
    )
  }
  return control.execute(parsed).then((execution) => ({
    status: execution.result.outcome === 'rejected' ? 400 : 200,
    body: {
      result: execution.result,
      ...(execution.report !== undefined ? { report: execution.report } : {}),
      replayed: execution.replayed,
    },
  }))
}

/**
 * `DeveloperLookup` → HTTP。
 *
 * 契约层刻意保留**三态**（找到 / 没找到 / 不属于这个角色），因为排查时的处置不同。
 * 到了 HTTP 这一层，三态收敛成两态：`found` → 200 + `value`，
 * 其余 → 404 + `{ error: { code: reasonCode, message: reason } }`。
 *
 * ⚠️ `character_mismatch` 也回 404（**不**回 403）：从调用方视角"存在但不是你的"
 *    与"不存在"应当不可区分 —— 否则这个面就成了一个跨角色的存在性探针。
 *    真正的区分留在**证据**里（理由码进响应体的 `code`），而不是靠状态码。
 */
export function unwrapLookup(payload: unknown): { status: number; body: unknown } {
  if (payload !== null && typeof payload === 'object' && 'found' in payload) {
    const lookup = payload as { found: boolean; value?: unknown; reasonCode?: string; reason?: string }
    if (lookup.found === true) return { status: 200, body: lookup.value }
    return {
      status: 404,
      body: { error: { code: lookup.reasonCode ?? 'not_found', message: lookup.reason ?? '未找到' } },
    }
  }
  return { status: 200, body: payload }
}

/** 匹配一条路由；`:seg` 捕获为 params（顺序即出现顺序） */
export function matchDeveloperQueryRoute(
  routes: readonly Route[],
  pathname: string
): { route: Route; params: string[] } | undefined {
  const parts = pathname.split('/').filter((part) => part !== '')
  for (const candidate of routes) {
    if (candidate.segments.length !== parts.length) continue
    const params: string[] = []
    let matched = true
    for (let index = 0; index < candidate.segments.length; index += 1) {
      const expected = candidate.segments[index]!
      const actual = parts[index]!
      if (expected.startsWith(':')) {
        if (actual.trim() === '') {
          matched = false
          break
        }
        params.push(decodeURIComponent(actual))
        continue
      }
      if (expected !== actual) {
        matched = false
        break
      }
    }
    if (matched) return { route: candidate, params }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 服务器
// ---------------------------------------------------------------------------

export async function startDeveloperQueryServer(
  options: DeveloperHttpServerOptions
): Promise<DeveloperHttpServer> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? DEFAULT_DEVELOPER_HTTP_PORT
  const prefix = options.prefix ?? '/dev/query'
  /*
   * ⚠️ 没有注入控制面时，控制路由**不存在**（而不是"存在但回 503"）；
   *    `servePage === false` 时页面路由同样**不存在**（而不是"存在但空"）。
   *    一个看得见点不动的按钮会让人以为功能坏了；一个 404 说明它没被装配。
   */
  const routes = buildDeveloperQueryRoutes(prefix).filter((route) => {
    if (route.pattern === '/') return options.servePage !== false
    return options.control !== undefined || !route.pattern.includes('/control/')
  })

  // 闸②：非回环直接拒绝启动（不"警告后继续"）
  if (!isLoopbackHost(host)) {
    throw new HttpError(
      400,
      'developer_server_non_loopback',
      `开发者查询面只允许绑回环地址，收到 host=${host}。` +
        'AT5.1：development only / loopback only —— 这个面没有身份验证，' +
        '把它绑到外部接口等于把她的记忆库匿名公开'
    )
  }

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response)
  })

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // 闸③：对端必须是回环
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        sendError(response, 403, 'developer_server_peer_not_loopback', '只接受回环地址的请求')
        return
      }

      const url = new URL(request.url ?? '/', `http://${host}`)
      const pathname = url.pathname.replace(/\/+$/, '') || '/'
      const matched = matchDeveloperQueryRoute(routes, pathname)

      if (matched === undefined) {
        sendError(
          response,
          404,
          'developer_query_unknown_route',
          `没有这个查询端点：${pathname}。可用端点：${routes.map((r) => r.pattern).join(' , ')}`
        )
        return
      }

      /*
       * 闸④（按路由）：方法不对 → 405。
       *
       * 查询路由只有 GET（整个查询面没有任何写语义）；控制路由是 POST。
       * 用**路由表**上的 method 判定，而不是一条全局规则 ——
       * 否则加控制面时就得在全局规则里开一个洞。
       */
      if (request.method !== matched.route.method) {
        sendError(
          response,
          405,
          'developer_query_method_not_allowed',
          `${matched.route.pattern} 只接受 ${matched.route.method}（收到 ${String(request.method)}）`
        )
        return
      }

      // 未知查询参数必须在**这一层**就拒掉：handler 只读自己认识的键，
      // 因此契约层的 `rejectUnknownKeys` 看不到它们（见 allowedQueryParams 的说明）
      const unknownParams = [...url.searchParams.keys()].filter(
        (key) => !matched.route.allowedQueryParams.includes(key)
      )
      if (unknownParams.length > 0) {
        throw new HttpError(
          400,
          'developer_query_unknown_field',
          `${matched.route.pattern} 收到未声明的查询参数：${unknownParams.join(', ')}。` +
            `允许的参数：${matched.route.allowedQueryParams.join(', ') || '(无)'}`
        )
      }

      const rawBody =
        matched.route.method === 'POST' ? await readBody(request) : ''

      const payload = await matched.route.handler({
        service: options.service,
        control: options.control,
        characterId: options.characterId,
        url,
        params: matched.params,
        rawBody,
        ...(matched.route.kind === 'html'
          ? { pageHtml: readPageHtml(options.pagePath) }
          : {}),
      })

      /*
       * 四种路由各有一条**唯一的**状态码规则：
       *   lookup  → 200 / 404（见 `unwrapLookup`）
       *   control → 200 / 400（由阶梯决定，见 `executeControlRequest`）
       *   html    → 200 + text/html（见 `sendHtml`）
       *   page    → 200
       * 一个 handler "顺便"改状态码在结构上做不到。
       */
      if (matched.route.kind === 'lookup') {
        const unwrapped = unwrapLookup(payload)
        if (unwrapped.status !== 200) {
          const body = unwrapped.body as { error: { code: string; message: string } }
          sendError(response, unwrapped.status, body.error.code, body.error.message)
          return
        }
        sendJson(response, 200, unwrapped.body)
        return
      }

      if (matched.route.kind === 'control') {
        const controlled = payload as ControlHttpResponse
        sendJson(response, controlled.status, controlled.body)
        return
      }

      if (matched.route.kind === 'html') {
        sendHtml(response, String(payload))
        return
      }

      sendJson(response, 200, payload)
    } catch (error) {
      const mapped = statusOfError(error)
      sendError(response, mapped.status, mapped.code, mapped.message)
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo | null
  const actualPort = address !== null && typeof address === 'object' ? address.port : port

  return {
    url: `http://${host}:${actualPort}`,
    host,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

/**
 * 端点清单（**唯一**来源是路由表本身；CLI 打印与测试断言共用）。
 *
 * ⚠️ 只含**查询**端点（AT2.6 的 8 个）：页面路由 `/` 与控制路由都不算查询端点，
 *    因此它们不出现在这份清单里 —— 否则 WP2 那条
 *    "端点清单正好是 AT2.6 的 8 个"会被页面悄悄改写成 9 个。
 */
export function developerQueryRoutePatterns(prefix = '/dev/query'): string[] {
  return buildDeveloperQueryRoutes(prefix)
    .filter((route) => route.pattern !== '/' && !route.pattern.includes('/control/'))
    .map((route) => route.pattern)
}

/** 控制面端点清单（只有注入控制面时才存在的那些） */
export function developerControlRoutePatterns(prefix = '/dev/query'): string[] {
  return buildDeveloperQueryRoutes(prefix)
    .filter((route) => route.pattern.includes('/control/'))
    .map((route) => `${route.method} ${route.pattern}`)
}

/**
 * 读请求体（带上限）。
 *
 * ⚠️ 没有上限就等于允许一次内存耗尽 —— 这个面虽然是回环的，
 *    但"只有本机"不是"可以不管资源"的理由。
 */
export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_CONTROL_BODY_BYTES) {
      throw new HttpError(
        413,
        'developer_control_body_too_large',
        `请求体超过 ${MAX_CONTROL_BODY_BYTES} 字节上限`
      )
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
