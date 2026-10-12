/**
 * probe-web-read.ts —— WP3（`web.read`）的探针与读数（计划书 §3.1「网页深读」/ §4 A「网页 6 组」）。
 *
 * ============================================================================
 *  它要回答的问题（每条都要有读数；缺了就是缺了，不用"看起来没问题"顶替）
 * ============================================================================
 * ```text
 * ① 准入判决：http / file / 端口 / userinfo / 回环 / 私有 / 链路本地 / CGNAT /
 *    组播 / 保留 / IPv4-mapped IPv6 → 逐条给出机器可读的理由码
 * ② 受禁目标连接数：这些 URL 通过**适配器**跑一遍，连接与解析计数必须是 0
 * ③ DNS 固定：每一跳各自解析一次、连接用的是**已校验的那个 IP**、
 *    重定向目标**逐跳重新准入**、重定向到受禁地址**在连接之前**被拒
 * ④ 提取：磁盘夹具的正文长度 / 已知句子与数字 / 脚本未执行 / 广告与导航未混入 /
 *    DOM 元素数；以及 `assertTurnContent` 直接调用通过
 * ⑤ 隐私：effect / evidence / facts 里**一个正文字符都没有**（拿 sentinel 反向证明）
 * ⑥ 上限：2 MiB 流式上限（合成流 + 一个真实套接字的 3 MiB 响应）、50,000 DOM 元素
 * ⑦ 本地上游行为：302 跳链 / 404 / 500 / 非 HTML content-type / 缺 content-type / 超时
 * ⑧ TLS：**真实套接字**上"固定 IP + 保留原主机名校验"的正控与负控
 *    （证书主机名不匹配必须失败、自签证书必须失败 ⇒ 校验没有被关掉）
 * ```
 *
 * 运行：
 * ```bash
 * node node_modules/tsx/dist/cli.mjs scripts/utility-skills/probe-web-read.ts
 * ```
 * 产出：`artifacts/post-lv2/local/utility-skills-preparation/runs/web-read-probe.json`
 *
 * ============================================================================
 *  关于"测试缝"（**没有一处削弱生产默认**）
 * ============================================================================
 * · 全部判决类用例走**真实准入** `admitWebReadUrl`（探针显式传入，证明没有换策略）。
 * · 全部跳链类用例只注入 `resolve` / `connect` 两个端口 —— 它们本来就是注入点
 *   （生产缺省是 `node:dns` 与 `node:https`）。被注入的 `connect` 会**记录**它收到了
 *   什么（地址 / SNI / Host），于是"连接用的是已校验的 IP"这句话是可复核的，
 *   而不是"读代码看起来对"。
 * · 提取路径用 `fetchHtml` 缝把磁盘夹具的字节喂进去：没有网络、没有服务器，
 *   但**准入、上限、解码、提取、契约**全是生产代码。
 * · TLS 一段用的是**生产连接器** `createPinnedHttpsConnector()`，只是多传了一个
 *   `trustedCa`（本地夹具自签证书）。`rejectUnauthorized` 仍是 true —— 负控
 *   （不给 ca / servername 写错）必须失败，这正是"校验没被关掉"的证据。
 */

import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createRequire } from 'node:module'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { JSDOM, VirtualConsole } from 'jsdom'

import {
  ActionFailureError,
  actionStatusOfFailure,
  normalizeAdapterError,
} from '../../src/kernel/action/errors.ts'
import type { ActionFailure } from '../../src/kernel/action/errors.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../../src/kernel/action/executor-port.ts'
import { newActionId } from '../../src/kernel/contracts/ids.ts'
import {
  assertTurnContent,
  assertTurnContentList,
  describeTurnContentRef,
  toTurnContentRef,
  validateTurnContent,
  TURN_CONTENT_LIMITS,
  type WebArticleTurnContent,
} from '../../src/kernel/contracts/turn-content.ts'
import { WEB_READ, WEB_READ_OPERATION } from '../../src/kernel/action/utility-capabilities.ts'
import {
  admitWebReadUrl,
  buildPinnedHttpsRequestOptions,
  checkHtmlContentType,
  classifyAddress,
  createPinnedHttpsConnector,
  createPinnedHttpsFetcher,
  createSystemResolver,
  createWebReadAdapter,
  decodeHtml,
  extractArticle,
  normalizeArticleText,
  readBoundedBody,
  truncateText,
  WEB_READ_ALLOWED_PORT,
  WEB_READ_MAX_BYTES,
  WEB_READ_MAX_DOM_ELEMENTS,
  WEB_READ_MAX_REDIRECTS,
  WEB_READ_TOTAL_TIMEOUT_MS,
  type WebReadConnectRequest,
  type WebReadConnector,
  type WebReadFetchResult,
  type WebReadResolver,
} from '../../src/infrastructure/action/adapters/web-read.ts'

const require = createRequire(import.meta.url)

/**
 * jsdom 30 的新 API（`requestInterceptor` + `resources: {interceptors}`）比已装的
 * `@types/jsdom@27` 新，因此这里从 CJS 侧取那个函数，并给"宽松选项"留一个闸门。
 * ⚠️ 这一段**只**用于探针的仪器正控（"如果加载器是活的，它能被看见"）；
 *    生产适配器用的是默认选项，压根没有 `resources`。
 */
const jsdomCjs = require('jsdom') as {
  requestInterceptor: (
    fn: (request: { url: string }, context: { element?: { localName?: string } | null }) => unknown
  ) => unknown
}

/** 用宽松选项构造 jsdom（类型只在探针里放宽，生产代码里没有这个口子） */
function constructDom(html: string, options: Record<string, unknown> = {}): JSDOM {
  return new JSDOM(html, options as unknown as ConstructorParameters<typeof JSDOM>[1])
}

/** `https.RequestOptions.headers` 可能是数组，取成可读的字典 */
function outgoingHeaders(options: { headers?: unknown } | null): Record<string, unknown> {
  const headers = options?.headers
  if (headers === undefined || headers === null || Array.isArray(headers)) return {}
  return headers as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 路径 / 常量
// ---------------------------------------------------------------------------

const repoRoot = resolvePath(fileURLToPath(new URL('../../', import.meta.url)))
const prepDir = join(repoRoot, 'artifacts/post-lv2/local/utility-skills-preparation')
const fixtureDir = join(prepDir, 'fixtures')
const outPath = join(prepDir, 'runs/web-read-probe.json')

const ARTICLE_FIXTURE = join(fixtureDir, 'web-article.html')
const DYNAMIC_FIXTURE = join(fixtureDir, 'web-dynamic-empty.html')

/** 本地 TLS 夹具用的自签证书/私钥（来自已装依赖的 test 目录，公开的测试材料） */
const TEST_KEY_PATH = join(
  repoRoot,
  'node_modules/.pnpm/public-encrypt@4.0.3/node_modules/public-encrypt/test/test_key.pem'
)
const TEST_CERT_PATH = join(
  repoRoot,
  'node_modules/.pnpm/public-encrypt@4.0.3/node_modules/public-encrypt/test/test_cert.pem'
)

/** 已知正文里的 sentinel（用来证明"元数据里没有正文"） */
const BODY_SENTINELS = ['莫比乌斯环', '静水压力是流体力学', '97.9', '998.2']
/** 只应出现在原始 HTML、不该出现在正文里的 sentinel */
const NON_ARTICLE_SENTINELS = {
  scriptMarker: 'SCRIPT-RAN',
  scriptInjectedText: '这段文字只应由脚本产生',
  adText: '限时八折',
  footer: '版权所有，未经许可不得转载',
  navOnly: ['首页', '关于本站', 'RSS 订阅'],
  /** 导航词但在正文里合法出现（子串假阳性）—— 如实登记，不假装"导航全清掉了" */
  navAmbiguous: '归档',
}

const FIXED_NOW = Date.parse('2026-10-04T12:00:00.000Z')
const now = (): number => Date.now()
const turnClock = (): number => FIXED_NOW

// ---------------------------------------------------------------------------
// 读数累积
// ---------------------------------------------------------------------------

interface CaseReading {
  id: string
  title: string
  status: 'PASS' | 'FAIL'
  readings: Record<string, unknown>
  failures: string[]
}

const cases: CaseReading[] = []

function recordCase(
  id: string,
  title: string,
  readings: Record<string, unknown>,
  failures: string[]
): CaseReading {
  const entry: CaseReading = {
    id,
    title,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    readings,
    failures,
  }
  cases.push(entry)
  process.stdout.write(`[${entry.status}] ${id} — ${title}${failures.length > 0 ? ` :: ${failures.join(' | ')}` : ''}\n`)
  return entry
}

function sha256Hex(material: Buffer | string): string {
  return createHash('sha256').update(material).digest('hex')
}

function packageVersion(specifier: string): string | null {
  try {
    return String(require(`${specifier}/package.json`).version)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 适配器调用工具
// ---------------------------------------------------------------------------

interface AdapterCallReading {
  status: string
  failureCode: string | null
  failureReason: unknown
  failureMessage: string | null
  failureDetails: Record<string, unknown> | null
  outcome: AdapterOutcome | null
  ms: number
}

function makeInput(url: string, options: { argsOverride?: Record<string, unknown>; omitTarget?: boolean } = {}): AdapterExecuteInput {
  return {
    actionId: newActionId(),
    operation: WEB_READ_OPERATION,
    target: options.omitTarget === true
      ? { type: 'web_url', confidence: 'none' }
      : { type: 'web_url', canonicalId: url, confidence: 'exact' },
    args: options.argsOverride ?? { url },
    now: turnClock,
  }
}

async function callAdapter(
  adapter: CapabilityAdapter,
  input: AdapterExecuteInput
): Promise<AdapterCallReading> {
  const startedAt = Date.now()
  try {
    const outcome = await adapter.execute(input)
    return {
      status: outcome.partial !== undefined ? 'partial' : 'success',
      failureCode: null,
      failureReason: null,
      failureMessage: null,
      failureDetails: null,
      outcome,
      ms: Date.now() - startedAt,
    }
  } catch (error) {
    // 与 Gateway 同一条归一：非 ActionFailureError 也走 normalizeAdapterError
    const failure: ActionFailure = error instanceof ActionFailureError ? error.failure : normalizeAdapterError(error)
    const details = (failure.details ?? null) as Record<string, unknown> | null
    return {
      status: actionStatusOfFailure(failure.code),
      failureCode: failure.code,
      failureReason: details?.reason ?? null,
      failureMessage: failure.message,
      failureDetails: details,
      outcome: null,
      ms: Date.now() - startedAt,
    }
  }
}

// ---------------------------------------------------------------------------
// 计数用工装（记录"要连接谁"与"要解析谁"）
// ---------------------------------------------------------------------------

interface ConnectorReading {
  requested: {
    address: string
    family: number
    port: number
    servername: string
    hostHeader: string
    path: string
  }[]
  destroyed: number
}

function emptyConnectorReading(): ConnectorReading {
  return { requested: [], destroyed: 0 }
}

interface FakeResponse {
  status: number
  headers: Record<string, string>
  body?: Buffer
}

/** 造一个"不碰网络"的连接器：按脚本回答，并把请求原样记下来 */
function makeScriptedConnector(
  reading: ConnectorReading,
  respond: (request: WebReadConnectRequest) => FakeResponse
): WebReadConnector {
  return async (request: WebReadConnectRequest) => {
    reading.requested.push({
      address: request.address,
      family: request.family,
      port: request.port,
      servername: request.servername,
      hostHeader: request.hostHeader,
      path: request.path,
    })
    const spec = respond(request)
    const body = spec.body ?? Buffer.alloc(0)
    return {
      status: spec.status,
      headers: spec.headers,
      body: (async function* generate(): AsyncGenerator<Buffer> {
        if (body.byteLength > 0) yield body
      })(),
      destroy: () => {
        reading.destroyed += 1
      },
    }
  }
}

interface ResolverReading {
  requested: { host: string }[]
}

function makeTableResolver(
  reading: ResolverReading,
  table: Record<string, readonly string[] | (() => readonly string[])>
): WebReadResolver {
  return async (host: string): Promise<readonly string[]> => {
    reading.requested.push({ host })
    const entry = table[host]
    if (entry === undefined) {
      // 探针自己的错误：不在预置表里的解析必须炸出来，不能静默变成"查不到"
      throw new Error(`probe: 未预置的解析请求 ${host}`)
    }
    return typeof entry === 'function' ? entry() : entry
  }
}

// ---------------------------------------------------------------------------
// 网络探测仪（"这一段真的没有出站"的机器判据）
// ---------------------------------------------------------------------------

interface NetworkDetector {
  calls: { api: string; detail: string }[]
  patched: string[]
  uninstall: () => void
}

/**
 * 装上"谁在网络"的计数器。
 *
 * ⚠️ 它**记录后照常放行**（不抛错）：这样"控制组真的会发生一次请求"这件事
 *    也能被同一个仪器量到 —— 否则"0"分不清是"没发生"还是"仪器坏了"。
 *    本次探针里唯一被放行的目标是本机一个只听不应的回环端口（`127.0.0.1:<随机>`）。
 */
function installNetworkDetector(): NetworkDetector {
  const calls: { api: string; detail: string }[] = []
  const patched: string[] = []
  const restores: (() => void)[] = []
  const record = (api: string, detail: string): void => {
    calls.push({ api, detail })
  }

  const patch = (
    target: Record<string, unknown>,
    key: string,
    label: string,
    describeCall: (...args: unknown[]) => string
  ): void => {
    const original = target[key]
    if (typeof original !== 'function') return
    target[key] = (...args: unknown[]): unknown => {
      record(label, describeCall(...args))
      return (original as (...inner: unknown[]) => unknown)(...args)
    }
    patched.push(label)
    restores.push(() => {
      target[key] = original
    })
  }

  patch(globalThis as unknown as Record<string, unknown>, 'fetch', 'fetch', (input) => String(input))

  const describeSocketArgs = (...args: unknown[]): string => {
    const first = args[0]
    if (typeof first === 'object' && first !== null) {
      const options = first as { port?: unknown; host?: unknown; path?: unknown }
      return `port=${String(options.port ?? '')} host=${String(options.host ?? options.path ?? '')}`
    }
    return `port=${String(first ?? '')} host=${String(args[1] ?? '')}`
  }

  const net = require('node:net') as Record<string, unknown>
  patch(net, 'connect', 'net.connect', describeSocketArgs)
  patch(net, 'createConnection', 'net.createConnection', describeSocketArgs)
  // ⚠️ 关键的一条：undici（jsdom 30 的传输层）最终必然落到 Socket#connect，
  //    只包 net.connect 会漏掉它 —— 探针第一轮就是这么"什么都没量到"的。
  const socketPrototype = (require('node:net') as { Socket: { prototype: Record<string, unknown> } }).Socket.prototype
  patch(socketPrototype, 'connect', 'net.Socket#connect', describeSocketArgs)

  const tls = require('node:tls') as Record<string, unknown>
  patch(tls, 'connect', 'tls.connect', describeSocketArgs)

  const http = require('node:http') as Record<string, unknown>
  patch(http, 'request', 'http.request', (...args: unknown[]) => String((args[0] as { host?: unknown })?.host ?? args[0]))
  patch(http, 'get', 'http.get', (...args: unknown[]) => String((args[0] as { host?: unknown })?.host ?? args[0]))

  const https = require('node:https') as Record<string, unknown>
  patch(https, 'request', 'https.request', (...args: unknown[]) => String((args[0] as { host?: unknown })?.host ?? args[0]))
  patch(https, 'get', 'https.get', (...args: unknown[]) => String((args[0] as { host?: unknown })?.host ?? args[0]))

  const dns = require('node:dns') as Record<string, unknown>
  patch(dns, 'lookup', 'dns.lookup', (...args: unknown[]) => String(args[0]))
  const dnsPromises = require('node:dns/promises') as Record<string, unknown>
  patch(dnsPromises, 'lookup', 'dns.lookup(promises)', (...args: unknown[]) => String(args[0]))

  return {
    calls,
    patched,
    uninstall: () => {
      for (const restore of restores.reverse()) restore()
    },
  }
}

// ---------------------------------------------------------------------------
// 本地 HTTP 夹具服务器（跳链 / 状态码 / 上限 / 超时）
// ---------------------------------------------------------------------------

interface LocalServerReading {
  port: number
  requests: { path: string; method: string }[]
  bigBodyBytesWritten: number
  bigBodyChunksWritten: number
  closedByClient: boolean
}

function startLocalHttpServer(articleHtml: Buffer): Promise<{ reading: LocalServerReading; close: () => Promise<void> }> {
  const reading: LocalServerReading = {
    port: 0,
    requests: [],
    bigBodyBytesWritten: 0,
    bigBodyChunksWritten: 0,
    closedByClient: false,
  }
  const hanging: ServerResponse[] = []
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/'
    reading.requests.push({ path, method: req.method ?? 'GET' })
    if (path.startsWith('/hang')) {
      hanging.push(res)
      return // 永不回答：测的是总期限
    }
    if (path.startsWith('/huge')) {
      void streamHuge(res, reading)
      return
    }
    if (path.startsWith('/slow')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body><p>slow</p></body></html>')
      }, 300)
      return
    }
    if (path.startsWith('/r1')) {
      res.writeHead(302, { location: 'https://site.example/r2' })
      res.end()
      return
    }
    if (path.startsWith('/r2')) {
      res.writeHead(302, { location: '/r3' })
      res.end()
      return
    }
    if (path.startsWith('/r3')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(articleHtml)
      return
    }
    if (path.startsWith('/loop')) {
      res.writeHead(302, { location: '/loop' })
      res.end()
      return
    }
    if (path.startsWith('/to-private')) {
      res.writeHead(302, { location: 'https://10.0.0.7/x' })
      res.end()
      return
    }
    if (path.startsWith('/to-http')) {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
      return
    }
    if (path.startsWith('/to-evil')) {
      res.writeHead(302, { location: 'https://evil.example/x' })
      res.end()
      return
    }
    if (path.startsWith('/to-noloc')) {
      res.writeHead(302, {})
      res.end()
      return
    }
    if (path.startsWith('/404')) {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<html><body><p>not found</p></body></html>')
      return
    }
    if (path.startsWith('/500')) {
      res.writeHead(500, { 'content-type': 'text/html' })
      res.end('<html><body><p>boom</p></body></html>')
      return
    }
    if (path.startsWith('/gzip')) {
      // 服务器"不请自来"地压缩：本适配器只发 identity，因此这种响应要**明说再拒**
      const gzipped = gzipSync(articleHtml)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(gzipped)
      return
    }
    if (path.startsWith('/json')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"hello":"world"}')
      return
    }
    if (path.startsWith('/no-content-type')) {
      // 直接把响应头写出去，不给 content-type
      res.writeHead(200, {})
      res.end('<html><body><p>no content type</p></body></html>')
      return
    }
    if (path.startsWith('/article')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(articleHtml)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body><p>default</p></body></html>')
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      reading.port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        reading,
        close: async () => {
          for (const res of hanging) res.destroy()
          server.closeAllConnections()
          await new Promise<void>((done) => {
            server.close(() => {
              done()
            })
          })
        },
      })
    })
  })
}

async function streamHuge(res: ServerResponse, reading: LocalServerReading): Promise<void> {
  const chunk = Buffer.alloc(32 * 1024, 0x61)
  const total = 3 * 1024 * 1024
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
  res.on('close', () => {
    reading.closedByClient = true
  })
  while (reading.bigBodyBytesWritten < total && !res.destroyed) {
    const ok = res.write(chunk)
    reading.bigBodyBytesWritten += chunk.byteLength
    reading.bigBodyChunksWritten += 1
    if (!ok) await sleep(4)
  }
  if (!res.writableEnded && !res.destroyed) res.end()
}

/** 把 https 的"按已固定地址连接"搬到一个明文本地端口上（**只**替换传输，不替换判决） */
function makeLocalTransport(port: number, reading: ConnectorReading): WebReadConnector {
  return async (request: WebReadConnectRequest) => {
    reading.requested.push({
      address: request.address,
      family: request.family,
      port: request.port,
      servername: request.servername,
      hostHeader: request.hostHeader,
      path: request.path,
    })
    const http = require('node:http') as typeof import('node:http')
    return await new Promise<{
      status: number
      headers: Record<string, string | string[] | undefined>
      body: AsyncIterable<Buffer>
      destroy: () => void
    }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: request.path,
          headers: { Host: request.hostHeader, 'Accept-Encoding': 'identity' },
        },
        (res) => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: res as unknown as AsyncIterable<Buffer>,
            destroy: () => {
              res.destroy()
            },
          })
        }
      )
      req.on('error', reject)
      req.end()
    })
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const articleHtml = readFileSync(ARTICLE_FIXTURE)
  const dynamicHtml = readFileSync(DYNAMIC_FIXTURE)
  const articleHtmlText = articleHtml.toString('utf8')
  const dynamicHtmlText = dynamicHtml.toString('utf8')

  const environment = {
    node: process.version,
    jsdom: packageVersion('jsdom'),
    readability: packageVersion('@mozilla/readability'),
    typescript: packageVersion('typescript'),
    adapterFile: 'src/infrastructure/action/adapters/web-read.ts',
    probeFile: 'scripts/utility-skills/probe-web-read.ts',
    limits: {
      maxBytes: WEB_READ_MAX_BYTES,
      maxDomElements: WEB_READ_MAX_DOM_ELEMENTS,
      totalTimeoutMs: WEB_READ_TOTAL_TIMEOUT_MS,
      maxRedirects: WEB_READ_MAX_REDIRECTS,
      allowedPort: WEB_READ_ALLOWED_PORT,
      maxTextChars: TURN_CONTENT_LIMITS.maxTextChars,
    },
    fixtures: {
      article: { path: ARTICLE_FIXTURE, bytes: articleHtml.byteLength, sha256: sha256Hex(articleHtml) },
      dynamicEmpty: { path: DYNAMIC_FIXTURE, bytes: dynamicHtml.byteLength, sha256: sha256Hex(dynamicHtml) },
    },
  }

  // -------------------------------------------------------------------------
  // A. 准入判决（纯函数）—— 逐条给出理由码
  // -------------------------------------------------------------------------

  const forbiddenCases: { url: string; expectedReason: string; note: string }[] = [
    { url: 'http://example.com/', expectedReason: 'not_https', note: '明文 HTTP' },
    { url: 'file:///C:/Windows/win.ini', expectedReason: 'not_https', note: 'file: 协议（绝不进文件系统）' },
    { url: 'file:///etc/passwd', expectedReason: 'not_https', note: 'file: 协议（POSIX）' },
    { url: 'C:\\Windows\\win.ini', expectedReason: 'not_https', note: 'Windows 路径被 URL 解析成 c: 协议' },
    { url: '/etc/passwd', expectedReason: 'bad_url', note: '裸路径：连 URL 都不是' },
    { url: 'not a url', expectedReason: 'bad_url', note: '非 URL 文本' },
    { url: 'https://', expectedReason: 'bad_url', note: '缺主机名' },
    { url: '', expectedReason: 'bad_url', note: '空串' },
    { url: 'https://example.com:8443/x', expectedReason: 'bad_port', note: '非 443 端口' },
    { url: 'https://example.com:80/x', expectedReason: 'bad_port', note: '80 端口' },
    { url: 'https://user:pw@example.com/x', expectedReason: 'userinfo', note: 'URL 里带凭据' },
    { url: 'https://127.0.0.1/x', expectedReason: 'forbidden_address', note: 'IPv4 回环' },
    { url: 'https://[::1]/x', expectedReason: 'forbidden_address', note: 'IPv6 回环' },
    { url: 'https://127.0.0.1./x', expectedReason: 'forbidden_address', note: '尾点形式（URL 归一后仍是回环）' },
    { url: 'https://2130706433/x', expectedReason: 'forbidden_address', note: '十进制 IPv4 由 URL 归一成 127.0.0.1' },
    { url: 'https://0x7f.1/x', expectedReason: 'forbidden_address', note: '十六进制/短形式 IPv4 由 URL 归一' },
    { url: 'https://[::ffff:127.0.0.1]/x', expectedReason: 'forbidden_address', note: 'IPv4-mapped IPv6 回环' },
    { url: 'https://[::ffff:7f00:1]/x', expectedReason: 'forbidden_address', note: 'IPv4-mapped（十六进制写法）回环' },
    { url: 'https://[::ffff:169.254.169.254]/x', expectedReason: 'forbidden_address', note: 'IPv4-mapped 链路本地（云元数据）' },
    { url: 'https://10.1.2.3/x', expectedReason: 'forbidden_address', note: '私有 10/8' },
    { url: 'https://172.16.5.5/x', expectedReason: 'forbidden_address', note: '私有 172.16/12' },
    { url: 'https://192.168.0.1/x', expectedReason: 'forbidden_address', note: '私有 192.168/16' },
    { url: 'https://169.254.169.254/latest/meta-data/', expectedReason: 'forbidden_address', note: '链路本地（云元数据端点）' },
    { url: 'https://100.64.1.1/x', expectedReason: 'forbidden_address', note: 'CGNAT 100.64/10' },
    { url: 'https://0.0.0.0/x', expectedReason: 'forbidden_address', note: '未指定地址' },
    { url: 'https://224.0.0.1/x', expectedReason: 'forbidden_address', note: 'IPv4 组播' },
    { url: 'https://240.0.0.1/x', expectedReason: 'forbidden_address', note: 'IPv4 保留' },
    { url: 'https://198.51.100.7/x', expectedReason: 'forbidden_address', note: 'TEST-NET-2（保留）' },
    { url: 'https://[::]/x', expectedReason: 'forbidden_address', note: 'IPv6 未指定' },
    { url: 'https://[fc00::1]/x', expectedReason: 'forbidden_address', note: 'IPv6 ULA 私有' },
    { url: 'https://[fe80::1]/x', expectedReason: 'forbidden_address', note: 'IPv6 链路本地' },
    { url: 'https://[ff02::1]/x', expectedReason: 'forbidden_address', note: 'IPv6 组播' },
    { url: 'https://[2001:db8::1]/x', expectedReason: 'forbidden_address', note: 'IPv6 文档地址（保留）' },
    { url: 'https://[64:ff9b::7f00:1]/x', expectedReason: 'forbidden_address', note: 'NAT64 内嵌回环' },
    { url: 'https://127.1/x', expectedReason: 'forbidden_address', note: '短形式 IPv4 主机名' },
  ]

  const forbiddenVerdicts: Record<string, unknown>[] = []
  const forbiddenFailures: string[] = []
  const forbiddenAdapterCases: Record<string, unknown>[] = []

  for (const entry of forbiddenCases) {
    const verdict = admitWebReadUrl(entry.url)
    const pure = {
      url: entry.url,
      note: entry.note,
      ok: verdict.ok,
      reason: verdict.ok ? null : verdict.reason,
      detail: verdict.ok ? null : verdict.detail,
      normalizedHref: verdict.ok ? verdict.href : (verdict.href ?? null),
      expectedReason: entry.expectedReason,
      reasonMatches: !verdict.ok && verdict.reason === entry.expectedReason,
    }
    forbiddenVerdicts.push(pure)
    if (verdict.ok) {
      forbiddenFailures.push(`${entry.url} 竟然被接受（期望 ${entry.expectedReason}）`)
      continue
    }
    if (verdict.reason !== entry.expectedReason) {
      forbiddenFailures.push(`${entry.url} 的理由是 ${verdict.reason}，期望 ${entry.expectedReason}`)
    }

    // 同一个 URL 再走一遍**适配器**：解析与连接都必须是 0
    const connectorReading = emptyConnectorReading()
    const resolverReading: ResolverReading = { requested: [] }
    const adapter = createWebReadAdapter({
      resolve: makeTableResolver(resolverReading, {}),
      connect: makeScriptedConnector(connectorReading, () => ({ status: 200, headers: { 'content-type': 'text/html' } })),
      now,
    })
    const call = await callAdapter(adapter, makeInput(entry.url))
    forbiddenAdapterCases.push({
      url: entry.url,
      status: call.status,
      failureCode: call.failureCode,
      reason: call.failureReason,
      resolveCalls: resolverReading.requested.length,
      connectCalls: connectorReading.requested.length,
      connectTargets: connectorReading.requested.map((entry2) => entry2.address),
    })
    if (call.failureCode === null) {
      forbiddenFailures.push(`${entry.url} 通过适配器竟然成功了`)
    }
    if (resolverReading.requested.length !== 0 || connectorReading.requested.length !== 0) {
      forbiddenFailures.push(
        `${entry.url} 在准入阶段仍发生了 ${String(resolverReading.requested.length)} 次解析 / ${String(connectorReading.requested.length)} 次连接`
      )
    }
  }

  recordCase(
    'admission-forbidden',
    '受禁 URL 的准入判决 + 适配器零解析 / 零连接',
    {
      cases: forbiddenVerdicts.length,
      verdicts: forbiddenVerdicts,
      adapterCalls: forbiddenAdapterCases,
      connectionAttemptsToForbiddenTargets:
        forbiddenAdapterCases.reduce((sum, entry) => sum + Number(entry.connectCalls), 0),
      resolveAttemptsForForbiddenTargets:
        forbiddenAdapterCases.reduce((sum, entry) => sum + Number(entry.resolveCalls), 0),
    },
    forbiddenFailures
  )

  // 允许侧的对照：证明"拒绝"不是"一律拒绝"
  const allowedCases = [
    { url: 'https://example.com/article', expectHost: 'example.com', note: '普通主机名' },
    { url: 'https://example.com./article', expectHost: 'example.com', note: '尾点被归一' },
    { url: 'https://例え.jp/x', expectHost: 'xn--r8jz45g.jp', note: 'IDN 归一成 punycode（ASCII）' },
    { url: 'https://example.com:443/x', expectHost: 'example.com', note: '显式 443 允许' },
    { url: 'https://93.184.216.34/x', expectHost: '93.184.216.34', note: '公网 IPv4 字面量允许' },
    { url: 'https://[2606:4700:4700::1111]/x', expectHost: '2606:4700:4700::1111', note: '公网 IPv6 字面量允许' },
  ]
  const allowedVerdicts: Record<string, unknown>[] = []
  const allowedFailures: string[] = []
  for (const entry of allowedCases) {
    const verdict = admitWebReadUrl(entry.url)
    allowedVerdicts.push({
      url: entry.url,
      note: entry.note,
      ok: verdict.ok,
      host: verdict.ok ? verdict.host : null,
      literalScope: verdict.ok ? (verdict.literalScope ?? null) : null,
      expectedHost: entry.expectHost,
    })
    if (!verdict.ok) {
      allowedFailures.push(`${entry.url} 被拒了（${verdict.reason}）`)
      continue
    }
    if (verdict.host !== entry.expectHost) {
      allowedFailures.push(`${entry.url} 的规范主机是 ${verdict.host}，期望 ${entry.expectHost}`)
    }
  }
  recordCase('admission-allowed', '允许侧对照（公网 HTTPS 必须放行）', { verdicts: allowedVerdicts }, allowedFailures)

  // -------------------------------------------------------------------------
  // A2. 声明：capabilityId / operation 必须与登记表逐字一致
  // -------------------------------------------------------------------------

  {
    const declarationAdapter = createWebReadAdapter({
      fetchHtml: async () => {
        throw new Error('probe: 声明检查不该触发任何获取')
      },
      now,
    })
    const declarationFailures: string[] = []
    if (declarationAdapter.capabilityId !== WEB_READ) {
      declarationFailures.push(`capabilityId=${declarationAdapter.capabilityId}`)
    }
    if (WEB_READ !== 'web.read') declarationFailures.push(`WEB_READ=${WEB_READ}`)
    if (WEB_READ_OPERATION !== 'read') declarationFailures.push(`WEB_READ_OPERATION=${WEB_READ_OPERATION}`)
    recordCase(
      'adapter-declaration',
      '适配器声明：capabilityId = web.read / operation = read',
      {
        capabilityId: declarationAdapter.capabilityId,
        registeredCapability: WEB_READ,
        registeredOperation: WEB_READ_OPERATION,
      },
      declarationFailures
    )
  }

  // -------------------------------------------------------------------------
  // B. 地址分类（纯函数）：公网 / 回环 / 私有 / 链路本地 / 映射
  // -------------------------------------------------------------------------

  const addressCases = [
    '93.184.216.34',
    '1.1.1.1',
    '127.0.0.1',
    '10.0.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '::1',
    '2606:4700:4700::1111',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:93.184.216.34',
    'not-an-address',
  ]
  const addressReading = addressCases.map((address) => {
    const classified = classifyAddress(address)
    return {
      address,
      family: classified.family,
      scope: classified.scope,
      allowed: classified.allowed,
      mappedIpv4: classified.mappedIpv4 ?? null,
    }
  })
  const addressFailures: string[] = []
  const expectAllowed = new Set(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:93.184.216.34'])
  for (const entry of addressReading) {
    if (entry.allowed !== expectAllowed.has(entry.address)) {
      addressFailures.push(`${entry.address} 的 allowed=${String(entry.allowed)}（期望 ${String(expectAllowed.has(entry.address))}）`)
    }
  }
  recordCase('address-classification', '地址分类（默认拒绝，只有公网单播放行）', { addresses: addressReading }, addressFailures)

  // -------------------------------------------------------------------------
  // B2. 三个纯辅助函数：content-type 解析 / 字符集解码 / 正文归一
  // -------------------------------------------------------------------------

  {
    const contentTypeReadings = [
      checkHtmlContentType('text/html; charset=UTF-8'),
      checkHtmlContentType('application/xhtml+xml'),
      checkHtmlContentType('application/json'),
      checkHtmlContentType('TEXT/HTML'),
      checkHtmlContentType(undefined),
      checkHtmlContentType('text/html; charset="gbk"'),
    ]
    // GBK 字节（0xBEB2 0xCBAE = “静水”），用来说明"中文网页不只 utf-8 一条路"
    const gbkBytes = Buffer.concat([
      Buffer.from('<html><head><meta charset="gbk"></head><body><p>', 'utf8'),
      Buffer.from([0xbe, 0xb2, 0xcb, 0xae]),
      Buffer.from('</p></body></html>', 'utf8'),
    ])
    const metaDecoded = decodeHtml(gbkBytes, undefined)
    const headerDecoded = decodeHtml(gbkBytes, 'gbk')
    const defaultDecoded = decodeHtml(Buffer.from('<html><body><p>abc</p></body></html>', 'utf8'), undefined)
    const normalized = normalizeArticleText('  第一行  \n\n\t 第二行\u3000第三行 ')
    const helperFailures: string[] = []
    const first = contentTypeReadings[0] as { ok: boolean; mediaType?: string; charset?: string }
    const second = contentTypeReadings[1] as { ok: boolean; mediaType?: string }
    const third = contentTypeReadings[2] as { ok: boolean; reason?: string }
    const fourth = contentTypeReadings[3] as { ok: boolean; mediaType?: string }
    const fifth = contentTypeReadings[4] as { ok: boolean; reason?: string }
    const sixth = contentTypeReadings[5] as { ok: boolean; charset?: string }
    if (!(first.ok && first.mediaType === 'text/html' && first.charset === 'utf-8')) helperFailures.push('text/html; charset=UTF-8 解析不对')
    if (!(second.ok && second.mediaType === 'application/xhtml+xml')) helperFailures.push('application/xhtml+xml 应当接受')
    if (third.ok || third.reason !== 'unsupported_content_type') helperFailures.push('application/json 应当被拒')
    if (!(fourth.ok && fourth.mediaType === 'text/html')) helperFailures.push('媒体类型应当大小写无关')
    if (fifth.ok || fifth.reason !== 'missing_content_type') helperFailures.push('缺 content-type 应当失败关闭')
    if (!(sixth.ok && sixth.charset === 'gbk')) helperFailures.push('带引号的 charset 解析不对')
    if (!(metaDecoded.charset === 'gbk' && metaDecoded.charsetSource === 'meta' && metaDecoded.html.includes('静水'))) {
      helperFailures.push(`meta 里的 gbk 没有生效：${metaDecoded.charset}/${metaDecoded.charsetSource}`)
    }
    if (!(headerDecoded.charset === 'gbk' && headerDecoded.charsetSource === 'header' && headerDecoded.html.includes('静水'))) {
      helperFailures.push('响应头里的 gbk 没有生效')
    }
    if (!(defaultDecoded.charset === 'utf-8' && defaultDecoded.charsetSource === 'default')) {
      helperFailures.push('没有字符集声明时应当回落到 utf-8')
    }
    if (normalized !== '第一行\n第二行 第三行') helperFailures.push(`正文归一对不上：${JSON.stringify(normalized)}`)
    recordCase(
      'pure-helpers',
      'content-type 解析 / 字符集解码（含 GBK）/ 正文归一',
      {
        contentTypeReadings,
        decode: {
          gbkBytesHex: gbkBytes.toString('hex'),
          metaDecoded: { charset: metaDecoded.charset, source: metaDecoded.charsetSource, hasJingShui: metaDecoded.html.includes('静水') },
          headerDecoded: { charset: headerDecoded.charset, source: headerDecoded.charsetSource, hasJingShui: headerDecoded.html.includes('静水') },
          defaultDecoded: { charset: defaultDecoded.charset, source: defaultDecoded.charsetSource },
        },
        normalizeArticleText: normalized,
      },
      helperFailures
    )
  }

  // -------------------------------------------------------------------------
  // C. 解析驱动的拒绝（真实 DNS：localhost ⇒ 回环）
  // -------------------------------------------------------------------------

  const realResolver = createSystemResolver()
  let realLookup: { host: string; addresses: string[]; scopes: string[] } | null = null
  let realLookupError: string | null = null
  try {
    const addresses = await realResolver('localhost')
    realLookup = {
      host: 'localhost',
      addresses: [...addresses],
      scopes: addresses.map((address) => classifyAddress(address).scope),
    }
  } catch (error) {
    realLookupError = error instanceof Error ? error.message : String(error)
  }

  const localhostConnector = emptyConnectorReading()
  const localhostAdapter = createWebReadAdapter({
    connect: makeScriptedConnector(localhostConnector, () => ({ status: 200, headers: { 'content-type': 'text/html' } })),
    now,
  })
  const localhostCall = await callAdapter(localhostAdapter, makeInput('https://localhost/x'))
  recordCase(
    'dns-driven-refusal',
    '真实 DNS 把 localhost 解析成回环 ⇒ 连接之前就被拒',
    {
      realLookup,
      realLookupError,
      adapterCall: {
        status: localhostCall.status,
        failureCode: localhostCall.failureCode,
        reason: localhostCall.failureReason,
        resolvedAddresses: localhostCall.failureDetails?.resolvedAddresses ?? null,
        connectCalls: localhostConnector.requested.length,
      },
    },
    [
      ...(realLookupError !== null ? [`真实解析 localhost 失败：${realLookupError}`] : []),
      ...(localhostCall.failureCode === 'validation_failed' ? [] : [`期望 validation_failed，得到 ${String(localhostCall.failureCode)}`]),
      ...(localhostCall.failureReason === 'forbidden_address' ? [] : [`期望 forbidden_address，得到 ${String(localhostCall.failureReason)}`]),
      ...(localhostConnector.requested.length === 0 ? [] : ['被拒的地址仍然发生了连接']),
    ]
  )

  // -------------------------------------------------------------------------
  // D. DNS 固定 / 逐跳重新准入（注入 resolve + connect；无真实网络）
  // -------------------------------------------------------------------------

  const hopArticle = Buffer.from(
    '<!DOCTYPE html><html><head><title>hop</title></head><body><article><h1>hop</h1><p>' +
      '这是一篇用于跳链用例的静态文章正文，长度足够让 Readability 认为它是一篇文章。'.repeat(6) +
      '</p></article></body></html>',
    'utf8'
  )

  interface HopCaseReading {
    id: string
    url: string
    status: string
    failureCode: string | null
    reason: unknown
    connectTargets: { address: string; servername: string; hostHeader: string; port: number; path: string }[]
    resolveCalls: { host: string }[]
    outcome: null | {
      finalUrl: string
      hops: { url: string; address: string; status: number }[]
      textHead: string
      textChars: number
      facts: readonly string[]
    }
    expected: { connectCalls: number; failureCode?: string; reason?: string; hops?: number; finalUrl?: string }
  }

  const hopReadings: HopCaseReading[] = []
  const hopFailures: string[] = []

  const runHopCase = async (
    id: string,
    url: string,
    table: Record<string, readonly string[]>,
    respond: (request: WebReadConnectRequest) => FakeResponse,
    expected: HopCaseReading['expected']
  ): Promise<void> => {
    const connectorReading = emptyConnectorReading()
    const resolverReading: ResolverReading = { requested: [] }
    const adapter = createWebReadAdapter({
      fetchHtml: createPinnedHttpsFetcher({
        admit: admitWebReadUrl,
        resolve: makeTableResolver(resolverReading, table),
        connect: makeScriptedConnector(connectorReading, respond),
        now,
      }),
      totalTimeoutMs: 5000,
      now,
    })
    const call = await callAdapter(adapter, makeInput(url))
    const item = call.outcome?.turnContent?.[0]
    const article = item !== undefined && item.kind === 'web-article' ? (item as WebArticleTurnContent) : undefined
    const reading: HopCaseReading = {
      id,
      url,
      status: call.status,
      failureCode: call.failureCode,
      reason: call.failureReason,
      connectTargets: connectorReading.requested,
      resolveCalls: resolverReading.requested,
      outcome:
        article === undefined
          ? null
          : {
              finalUrl: article.finalUrl,
              hops: (
                (call.failureDetails?.hops as { url: string; address: string; status: number }[] | undefined) ?? []
              ).slice(),
              textHead: article.text.slice(0, 24),
              textChars: article.text.length,
              facts: article.facts,
            },
      expected,
    }
    hopReadings.push(reading)

    if (expected.failureCode !== undefined && call.failureCode !== expected.failureCode) {
      hopFailures.push(`${id}: 期望 failureCode=${expected.failureCode}，得到 ${String(call.failureCode)}`)
    }
    if (expected.reason !== undefined && call.failureReason !== expected.reason) {
      hopFailures.push(`${id}: 期望 reason=${expected.reason}，得到 ${String(call.failureReason)}`)
    }
    if (connectorReading.requested.length !== expected.connectCalls) {
      hopFailures.push(
        `${id}: 期望连接 ${String(expected.connectCalls)} 次，实际 ${String(connectorReading.requested.length)} 次`
      )
    }
  }

  const okArticleHeaders = { 'content-type': 'text/html; charset=utf-8' }

  // C1：两次重定向之后成功（相对 Location 也要能解析）
  await runHopCase(
    'redirect-chain-ok',
    'https://site.example/r1',
    { 'site.example': ['93.184.216.34'] },
    (request) => {
      if (request.path.startsWith('/r1')) return { status: 302, headers: { location: 'https://site.example/r2' } }
      if (request.path.startsWith('/r2')) return { status: 302, headers: { location: '/r3' } }
      return { status: 200, headers: okArticleHeaders, body: hopArticle }
    },
    { connectCalls: 3, hops: 3, finalUrl: 'https://site.example/r3' }
  )

  // C2：重定向到受禁字面量 —— 必须在**连接之前**拒
  await runHopCase(
    'redirect-to-private-literal',
    'https://site.example/r1',
    { 'site.example': ['93.184.216.34'] },
    () => ({ status: 302, headers: { location: 'https://10.0.0.7/x' } }),
    { connectCalls: 1, failureCode: 'validation_failed', reason: 'forbidden_address' }
  )

  await runHopCase(
    'redirect-to-http-metadata',
    'https://site.example/r1',
    { 'site.example': ['93.184.216.34'] },
    () => ({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    { connectCalls: 1, failureCode: 'validation_failed', reason: 'not_https' }
  )

  // C3：重定向到一个**主机名**，它解析到私网 ⇒ 仍然在连接之前拒
  await runHopCase(
    'redirect-to-hostname-resolving-private',
    'https://site.example/r1',
    { 'site.example': ['93.184.216.34'], 'evil.example': ['10.1.2.3'] },
    () => ({ status: 302, headers: { location: 'https://evil.example/x' } }),
    { connectCalls: 1, failureCode: 'validation_failed', reason: 'forbidden_address' }
  )

  // C4：超过三次重定向 ⇒ 恰好 4 次连接后失败
  await runHopCase(
    'too-many-redirects',
    'https://loop.example/loop',
    { 'loop.example': ['93.184.216.34'] },
    () => ({ status: 302, headers: { location: '/loop' } }),
    { connectCalls: 4, failureCode: 'validation_failed', reason: 'too_many_redirects' }
  )

  await runHopCase(
    'redirect-without-location',
    'https://site.example/to-noloc',
    { 'site.example': ['93.184.216.34'] },
    () => ({ status: 302, headers: {} }),
    { connectCalls: 1, failureCode: 'validation_failed', reason: 'redirect_without_location' }
  )

  // C5：多地址里只要有一个不合格，整跳拒绝
  await runHopCase(
    'multi-address-one-forbidden',
    'https://mixed.example/x',
    { 'mixed.example': ['93.184.216.34', '10.0.0.9'] },
    () => ({ status: 200, headers: okArticleHeaders, body: hopArticle }),
    { connectCalls: 0, failureCode: 'validation_failed', reason: 'forbidden_address' }
  )

  // C6：DNS rebinding —— 同一主机名第二次解析直接炸，用来证明"一跳只解析一次"
  {
    const connectorReading = emptyConnectorReading()
    const resolverReading: ResolverReading = { requested: [] }
    let rebindCalls = 0
    const adapter = createWebReadAdapter({
      fetchHtml: createPinnedHttpsFetcher({
        admit: admitWebReadUrl,
        resolve: async (host) => {
          resolverReading.requested.push({ host })
          rebindCalls += 1
          if (rebindCalls > 1) throw new Error('probe: 同一跳被解析了第二次（DNS rebinding 防线失效）')
          return ['93.184.216.34']
        },
        connect: makeScriptedConnector(connectorReading, () => ({ status: 200, headers: okArticleHeaders, body: hopArticle })),
        now,
      }),
      totalTimeoutMs: 5000,
      now,
    })
    const call = await callAdapter(adapter, makeInput('https://rebind.example/x'))
    recordCase(
      'dns-rebinding-single-resolution',
      '同一跳只解析一次，连接用那个已校验的地址（rebinding 防线）',
      {
        status: call.status,
        failureCode: call.failureCode,
        message: call.failureMessage,
        resolveCalls: resolverReading.requested.length,
        connectTargets: connectorReading.requested.map((entry) => entry.address),
      },
      [
        ...(call.status === 'success' ? [] : [`期望成功，得到 ${call.status}（${String(call.failureMessage)}）`]),
        ...(resolverReading.requested.length === 1 ? [] : [`期望解析 1 次，实际 ${String(resolverReading.requested.length)} 次`]),
        ...(connectorReading.requested[0]?.address === '93.184.216.34'
          ? []
          : [`连接目标不是已校验地址：${String(connectorReading.requested[0]?.address)}`]),
      ]
    )
  }

  // C7：连接参数 —— 地址被固定、SNI/Host 仍是原主机名、校验开着
  {
    const connectorReading = emptyConnectorReading()
    const adapter = createWebReadAdapter({
      fetchHtml: createPinnedHttpsFetcher({
        admit: admitWebReadUrl,
        resolve: async () => ['93.184.216.34'],
        connect: makeScriptedConnector(connectorReading, () => ({ status: 200, headers: okArticleHeaders, body: hopArticle })),
        now,
      }),
      totalTimeoutMs: 5000,
      now,
    })
    const call = await callAdapter(adapter, makeInput('https://article.example/path/one?q=1'))
    const request = connectorReading.requested[0]
    const options =
      request === undefined
        ? null
        : buildPinnedHttpsRequestOptions({
            address: request.address,
            family: 4,
            port: request.port,
            servername: request.servername,
            hostHeader: request.hostHeader,
            path: request.path,
            deadlineAt: Date.now() + 1000,
            now,
          })
    const pinnedHeaders = outgoingHeaders(options)
    const ipLiteralOptions = buildPinnedHttpsRequestOptions({
      address: '93.184.216.34',
      family: 4,
      port: 443,
      servername: '93.184.216.34',
      hostHeader: '93.184.216.34',
      path: '/',
      deadlineAt: Date.now() + 1000,
      now,
    })
    recordCase(
      'pinned-connect-parameters',
      '生产连接参数：host=已校验 IP，servername/Host=原主机名，rejectUnauthorized=true',
      {
        status: call.status,
        receivedByConnector: request ?? null,
        productionRequestOptions: options === null
          ? null
          : {
              host: options.host,
              family: options.family,
              port: options.port,
              method: options.method,
              path: options.path,
              servername: options.servername ?? null,
              hostHeader: pinnedHeaders.Host ?? null,
              accept: pinnedHeaders.Accept ?? null,
              acceptEncoding: pinnedHeaders['Accept-Encoding'] ?? null,
              rejectUnauthorized: options.rejectUnauthorized ?? null,
              hasSignal: options.signal !== undefined,
            },
        ipLiteralServername: ipLiteralOptions.servername ?? null,
      },
      [
        ...(request?.address === '93.184.216.34' ? [] : ['连接地址不是已校验的 IP']),
        ...(request?.servername === 'article.example' ? [] : ['servername 不是原主机名']),
        ...(request?.hostHeader === 'article.example' ? [] : ['Host 头不是原主机名']),
        ...(request?.path === '/path/one?q=1' ? [] : [`path 拼错：${String(request?.path)}`]),
        ...(options?.host === '93.184.216.34' ? [] : ['https.options.host 不是已固定地址']),
        ...(options?.servername === 'article.example' ? [] : ['https.options.servername 丢失']),
        ...(options?.rejectUnauthorized === true ? [] : ['rejectUnauthorized 不是 true']),
        ...(pinnedHeaders['Accept-Encoding'] === 'identity' ? [] : ['没有声明 Accept-Encoding: identity']),
        ...(ipLiteralOptions.servername === undefined ? [] : ['IP 字面量不该设 SNI（RFC 6066）']),
      ]
    )
  }

  recordCase(
    'redirect-and-pinning',
    '逐跳准入 / 解析 / 固定地址连接 / 重定向上限（跳链读数）',
    { cases: hopReadings },
    hopFailures
  )

  // -------------------------------------------------------------------------
  // E. 提取路径（fetchHtml 缝 + 磁盘夹具）
  // -------------------------------------------------------------------------

  const fixtureFinalUrl = 'https://example.invalid/notes/pressure'
  const fixtureHops = [
    { url: 'https://example.invalid/notes/pressure', host: 'example.invalid', address: '93.184.216.34', servername: 'example.invalid', status: 200 },
  ]
  const seamFetcher = async (): Promise<WebReadFetchResult> => ({
    bytes: articleHtml,
    finalUrl: fixtureFinalUrl,
    finalHost: 'example.invalid',
    hops: fixtureHops,
    status: 200,
    contentType: 'text/html',
    declaredCharset: 'utf-8',
  })

  const detach = installNetworkDetector()
  const seamAdapter = createWebReadAdapter({ fetchHtml: seamFetcher, now })
  const seamCall = await callAdapter(seamAdapter, makeInput(fixtureFinalUrl))
  const fixtureNetworkCalls = detach.calls.slice()
  detach.uninstall()

  const fixtureItem = seamCall.outcome?.turnContent?.[0]
  const articleItem = fixtureItem !== undefined && fixtureItem.kind === 'web-article'
    ? (fixtureItem as WebArticleTurnContent)
    : undefined
  const fixtureText = articleItem?.text ?? ''
  const fixtureValidation = fixtureItem !== undefined ? validateTurnContent(fixtureItem) : ['没有产出 turnContent']
  let fixtureAssertAccepted = false
  let fixtureAssertError: string | null = null
  let fixtureListAccepted = false
  let fixtureListError: string | null = null
  if (fixtureItem !== undefined) {
    try {
      assertTurnContent(fixtureItem)
      fixtureAssertAccepted = true
    } catch (error) {
      fixtureAssertError = error instanceof Error ? error.message : String(error)
    }
    try {
      assertTurnContentList([fixtureItem])
      fixtureListAccepted = true
    } catch (error) {
      fixtureListError = error instanceof Error ? error.message : String(error)
    }
  }

  // 元数据泄漏检查：effect / evidence / facts / 引用里绝不能有正文
  const metadataJson = JSON.stringify({
    effect: seamCall.outcome?.effect ?? null,
    evidence: seamCall.outcome?.evidence ?? null,
    facts: articleItem?.facts ?? null,
    ref: articleItem !== undefined ? describeTurnContentRef(toTurnContentRef(articleItem, 'C1')) : null,
  })
  const leakedSentinels = BODY_SENTINELS.filter((sentinel) => metadataJson.includes(sentinel))
  const refHasText = articleItem !== undefined ? Object.hasOwn(toTurnContentRef(articleItem, 'C1'), 'text') : null

  const contentOccurrences = (needle: string): number =>
    needle === '' ? 0 : fixtureText.split(needle).length - 1
  const navAmbiguousIndex = fixtureText.indexOf(NON_ARTICLE_SENTINELS.navAmbiguous)
  const navAmbiguousContext =
    navAmbiguousIndex >= 0 ? fixtureText.slice(Math.max(0, navAmbiguousIndex - 12), navAmbiguousIndex + 14) : null

  const fixtureFailures: string[] = []
  if (seamCall.status !== 'success') fixtureFailures.push(`期望成功，得到 ${seamCall.status} / ${String(seamCall.failureMessage)}`)
  if (articleItem === undefined) fixtureFailures.push('没有 web-article 内容')
  if (articleItem?.resourceRef !== fixtureFinalUrl) fixtureFailures.push('resourceRef 不是最终 URL')
  if (articleItem?.sourceFingerprint !== sha256Hex(articleHtml)) fixtureFailures.push('sourceFingerprint 不是原始响应字节的 sha256')
  if (articleItem?.resultFingerprint !== sha256Hex(fixtureText)) fixtureFailures.push('resultFingerprint 不是正文字节的 sha256')
  if (articleItem?.scope.includedChars !== fixtureText.length) fixtureFailures.push('scope.includedChars != text.length')
  const fixtureScope = articleItem?.scope
  if (fixtureScope !== undefined && fixtureScope.truncated !== (fixtureScope.totalChars > fixtureScope.includedChars)) {
    fixtureFailures.push('scope.truncated 与 totalChars/includedChars 不一致')
  }
  if (fixtureValidation.length !== 0) fixtureFailures.push(`validateTurnContent 报了 ${fixtureValidation.join(' / ')}`)
  if (!fixtureAssertAccepted) fixtureFailures.push(`assertTurnContent 抛错：${String(fixtureAssertError)}`)
  if (!fixtureListAccepted) fixtureFailures.push(`assertTurnContentList 抛错：${String(fixtureListError)}`)
  if (leakedSentinels.length !== 0) fixtureFailures.push(`元数据里出现正文 sentinel：${leakedSentinels.join(',')}`)
  if (refHasText === true) fixtureFailures.push('TurnContentRef 里竟然有 text 字段')
  if (fixtureNetworkCalls.length !== 0) {
    fixtureFailures.push(`提取路径发生了 ${String(fixtureNetworkCalls.length)} 次网络调用：${JSON.stringify(fixtureNetworkCalls)}`)
  }
  if (seamCall.outcome?.effect?.kind !== 'content_read') fixtureFailures.push('effect.kind 不是 content_read')
  if (seamCall.outcome?.effect?.bytes !== fixtureText.length) fixtureFailures.push('effect.bytes 不等于正文字符数')
  if (seamCall.outcome?.effect?.fingerprint !== articleItem?.resultFingerprint) fixtureFailures.push('effect.fingerprint 与 resultFingerprint 不一致')
  if (seamCall.outcome?.evidence?.[0]?.detail !== `web.read example.invalid ${String(fixtureText.length)} chars`) {
    fixtureFailures.push(`evidence.detail 形状不对：${String(seamCall.outcome?.evidence?.[0]?.detail)}`)
  }
  if (seamCall.outcome?.evidence?.[0]?.ref !== fixtureFinalUrl) fixtureFailures.push('evidence.ref 不是最终 URL')
  if (!fixtureText.includes('莫比乌斯环的测量基准是 2026 年 10 月')) fixtureFailures.push('已知句子缺失')
  if (!fixtureText.includes('7.25')) fixtureFailures.push('已知数字 7.25 缺失')
  if (fixtureText.includes(NON_ARTICLE_SENTINELS.scriptMarker)) fixtureFailures.push('正文里出现了脚本标记 SCRIPT-RAN')
  if (fixtureText.includes(NON_ARTICLE_SENTINELS.scriptInjectedText)) fixtureFailures.push('正文里出现了脚本注入文字')
  if (fixtureText.includes(NON_ARTICLE_SENTINELS.adText)) fixtureFailures.push('正文里出现了广告文字')
  if (fixtureText.includes(NON_ARTICLE_SENTINELS.footer)) fixtureFailures.push('正文里出现了页脚')
  for (const nav of NON_ARTICLE_SENTINELS.navOnly) {
    if (contentOccurrences(nav) > 0) fixtureFailures.push(`导航词 ${nav} 混进了正文`)
  }
  if (articleItem?.title !== '静水压力测量笔记') fixtureFailures.push(`title 不对：${String(articleItem?.title)}`)
  if (articleItem?.fetchedAt !== FIXED_NOW) fixtureFailures.push('fetchedAt 不是 input.now()')
  if ((articleItem?.facts.length ?? 0) < 6) fixtureFailures.push('facts 太少')

  recordCase(
    'fixture-extraction',
    '磁盘夹具（web-article.html）走完整适配器：正文 / 契约 / 隐私 / 零网络',
    {
      status: seamCall.status,
      ms: seamCall.ms,
      textChars: fixtureText.length,
      textSha256: sha256Hex(fixtureText),
      title: articleItem?.title ?? null,
      contentId: articleItem?.contentId ?? null,
      scope: articleItem?.scope ?? null,
      facts: articleItem?.facts ?? null,
      effect: seamCall.outcome?.effect ?? null,
      evidence: seamCall.outcome?.evidence ?? null,
      validationProblems: fixtureValidation,
      assertTurnContent: { accepted: fixtureAssertAccepted, error: fixtureAssertError },
      assertTurnContentList: { accepted: fixtureListAccepted, error: fixtureListError },
      knownSentencePresent: fixtureText.includes('莫比乌斯环的测量基准是 2026 年 10 月'),
      knownNumberPresent: fixtureText.includes('7.25'),
      nonArticleSentinels: {
        scriptMarker: fixtureText.includes(NON_ARTICLE_SENTINELS.scriptMarker),
        scriptInjectedText: fixtureText.includes(NON_ARTICLE_SENTINELS.scriptInjectedText),
        adText: fixtureText.includes(NON_ARTICLE_SENTINELS.adText),
        footer: fixtureText.includes(NON_ARTICLE_SENTINELS.footer),
        navOnly: Object.fromEntries(NON_ARTICLE_SENTINELS.navOnly.map((nav) => [nav, contentOccurrences(nav)])),
        navAmbiguous: {
          word: NON_ARTICLE_SENTINELS.navAmbiguous,
          occurrences: contentOccurrences(NON_ARTICLE_SENTINELS.navAmbiguous),
          context: navAmbiguousContext,
          note: '导航词，但正文原句 `按日期归档` 里合法出现 —— 子串假阳性，如实登记',
        },
      },
      metadataLeakCheck: {
        sentinels: BODY_SENTINELS,
        leakedSentinels,
        metadataChars: metadataJson.length,
        refHasTextField: refHasText,
        metadataNotContainsFullText: metadataJson.includes(fixtureText) === false,
      },
      networkCallsDuringExtraction: fixtureNetworkCalls,
      textHead: fixtureText.slice(0, 60),
    },
    fixtureFailures
  )

  // -------------------------------------------------------------------------
  // F. jsdom 行为：脚本未执行 / 子资源未加载（含 A/B 正控）
  // -------------------------------------------------------------------------

  {
    const staticConstruction = (): { title: string; injected: boolean; consoleMessages: number; rootText: string | null } => {
      const consoleMessages: number[] = []
      const virtualConsole = new VirtualConsole()
      virtualConsole.on('log', () => consoleMessages.push(1))
      const dom = new JSDOM(articleHtmlText, { virtualConsole })
      const document = dom.window.document
      const result = {
        title: document.title,
        injected: document.getElementById('injected-by-script') !== null,
        consoleMessages: consoleMessages.length,
        rootText: document.getElementById('injected-by-script')?.textContent ?? null,
      }
      dom.window.close()
      return result
    }
    const dangerousConstruction = (): { title: string; injected: boolean; consoleMessages: number; injectedText: string | null } => {
      const consoleMessages: number[] = []
      const virtualConsole = new VirtualConsole()
      virtualConsole.on('log', () => consoleMessages.push(1))
      const dom = new JSDOM(articleHtmlText, { runScripts: 'dangerously', virtualConsole })
      const document = dom.window.document
      const result = {
        title: document.title,
        injected: document.getElementById('injected-by-script') !== null,
        consoleMessages: consoleMessages.length,
        injectedText: document.getElementById('injected-by-script')?.textContent ?? null,
      }
      dom.window.close()
      return result
    }
    const staticReading = staticConstruction()
    const dangerousReading = dangerousConstruction()

    const dynamicStatic = (() => {
      const dom = new JSDOM(dynamicHtmlText, { virtualConsole: new VirtualConsole() })
      const text = dom.window.document.getElementById('root')?.textContent ?? null
      dom.window.close()
      return text
    })()
    const dynamicDangerous = (() => {
      const dom = new JSDOM(dynamicHtmlText, { runScripts: 'dangerously', virtualConsole: new VirtualConsole() })
      const text = dom.window.document.getElementById('root')?.textContent ?? null
      dom.window.close()
      return text
    })()

    // 子资源：合成控制页（本机监听端口只用于仪器自检那一段）
    const controlHtml = [
      '<!DOCTYPE html><html><head><title>control</title>',
      '<link rel="stylesheet" href="https://control.invalid/a.css">',
      '<script src="https://control.invalid/a.js"></script>',
      '<img src="https://control.invalid/p.png">',
      '<iframe src="https://control.invalid/f.html"></iframe>',
      '</head><body><p>control</p></body></html>',
    ].join('')

    const makeCounter = (): { seen: { url: string; element: string | null }[]; interceptor: unknown } => {
      const seen: { url: string; element: string | null }[] = []
      const interceptor = jsdomCjs.requestInterceptor(
        (request: { url: string }, context: { element?: { localName?: string } | null }) => {
          seen.push({ url: String(request.url), element: context?.element?.localName ?? null })
          return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } })
        }
      )
      return { seen, interceptor }
    }

    // A：默认选项（**就是适配器用的那一种**）——同一份文档，一次子资源都不该发生
    const defaultDetector = installNetworkDetector()
    const defaultDom = constructDom(controlHtml, { virtualConsole: new VirtualConsole() })
    await new Promise((done) => setTimeout(done, 300))
    defaultDom.window.close()
    const defaultNetwork = defaultDetector.calls.slice()
    defaultDetector.uninstall()

    // B：提供 resources + 拦截器 ⇒ 加载器是活的（同一份文档能被看见请求）
    const resourcesDetector = installNetworkDetector()
    const resourcesCounter = makeCounter()
    const resourcesDom = constructDom(controlHtml, {
      resources: { interceptors: [resourcesCounter.interceptor] },
      virtualConsole: new VirtualConsole(),
    })
    await new Promise((done) => setTimeout(done, 400))
    resourcesDom.window.close()
    const resourcesNetwork = resourcesDetector.calls.slice()
    resourcesDetector.uninstall()

    // C：再加上 runScripts ⇒ 外部脚本也会被请求（解释 B 里为什么没有 a.js）
    const scriptsCounter = makeCounter()
    const scriptsDom = constructDom(controlHtml, {
      runScripts: 'dangerously',
      resources: { interceptors: [scriptsCounter.interceptor] },
      virtualConsole: new VirtualConsole(),
    })
    await new Promise((done) => setTimeout(done, 400))
    scriptsDom.window.close()

    // D：仪器自检 —— 让一个真的会通过的子资源（iframe ⇒ 一定要取）**放行到真实传输**，
    //    目标是本机一个"只听不应"的端口。探测仪必须记录到这次连接尝试。
    //    ⚠️ 第一轮这里用的是 127.0.0.1:9，结果**拦截器一次都没被调用**：
    //       undici 有一张 WHATWG "blocked port" 表（9/discard 在表里），请求在进传输层
    //       之前就被它拒了。于是"仪器没响"其实是"请求根本没发出" —— 这正是
    //       "0 分不清是没发生还是仪器坏了"的现场。换成真实监听端口后两处都看得见。
    const netSockets: import('node:net').Socket[] = []
    const netServer = (require('node:net') as typeof import('node:net')).createServer((socket) => {
      netSockets.push(socket)
      socket.on('error', () => {})
      // 接受连接、永不回应：只要有连接尝试就够
    })
    await new Promise<void>((done) => {
      netServer.listen(0, '127.0.0.1', () => {
        done()
      })
    })
    const netAddress = netServer.address()
    const probePort = typeof netAddress === 'object' && netAddress !== null ? netAddress.port : 0

    const passSeen: { url: string; element: string | null }[] = []
    const passThroughInterceptor = jsdomCjs.requestInterceptor(
      (request: { url: string }, context: { element?: { localName?: string } | null }) => {
        passSeen.push({ url: String(request.url), element: context?.element?.localName ?? null })
        return undefined // 放行 → 真的会去连那个端口
      }
    )
    const passThroughDetector = installNetworkDetector()
    const passThroughDom = constructDom(
      `<!DOCTYPE html><html><head><title>pass</title></head><body><iframe src="http://127.0.0.1:${String(probePort)}/pass.html"></iframe></body></html>`,
      { resources: { interceptors: [passThroughInterceptor] }, virtualConsole: new VirtualConsole() }
    )
    await new Promise((done) => setTimeout(done, 600))
    passThroughDom.window.close()
    const passThroughNetwork = passThroughDetector.calls.slice()
    passThroughDetector.uninstall()
    for (const socket of netSockets) socket.destroy()
    await new Promise<void>((done) => {
      netServer.close(() => {
        done()
      })
    })

    const subresourceFailures: string[] = []
    if (staticReading.title !== '静水压力测量笔记') subresourceFailures.push(`默认构造后标题变了：${staticReading.title}`)
    if (staticReading.injected) subresourceFailures.push('默认构造下脚本注入的元素出现了')
    if (staticReading.consoleMessages !== 0) subresourceFailures.push('默认构造下脚本居然执行了（有 console 输出）')
    if (dangerousReading.title !== 'SCRIPT-RAN') subresourceFailures.push('正控失败：runScripts=dangerously 时标题没有变成 SCRIPT-RAN')
    if (!dangerousReading.injected) subresourceFailures.push('正控失败：runScripts=dangerously 时注入元素没有出现')
    if (dynamicStatic !== null && dynamicStatic !== '') subresourceFailures.push(`动态空壳页的 #root 里出现了 ${String(dynamicStatic)}`)
    if (dynamicDangerous === null || dynamicDangerous === '') subresourceFailures.push('正控失败：动态空壳页在 runScripts=dangerously 下没有注入文字')
    if (resourcesCounter.seen.length < 2) {
      subresourceFailures.push(`提供 resources 时拦截器只看到 ${String(resourcesCounter.seen.length)} 次请求（期望 ≥2：link + iframe）`)
    }
    if (defaultNetwork.length !== 0) subresourceFailures.push(`默认选项下竟然发生了 ${String(defaultNetwork.length)} 次网络调用`)
    if (passSeen.length === 0) subresourceFailures.push('仪器自检失败：放行的 iframe 连拦截器都没看到')
    if (passThroughNetwork.length === 0) subresourceFailures.push('仪器自检失败：放行一个子资源时网络探测仪没有记录到连接尝试')

    recordCase(
      'jsdom-script-and-subresource-ab',
      'jsdom：脚本未执行 / 子资源未加载（默认选项）＋ 仪器正控 A/B/C/D',
      {
        articleDefault: staticReading,
        articleWithRunScripts: dangerousReading,
        dynamicEmptyDefault: { rootText: dynamicStatic },
        dynamicEmptyWithRunScripts: { rootText: dynamicDangerous },
        subresourceControl: {
          html: controlHtml,
          default: { options: '默认（无 resources / 无 runScripts）', intercepted: null, networkCalls: defaultNetwork },
          withResources: {
            options: 'resources + requestInterceptor（合成响应）',
            intercepted: resourcesCounter.seen,
            networkCalls: resourcesNetwork,
            note: '合成响应 ⇒ 没有真实传输（这是对的，不是漏量）',
          },
          withResourcesAndRunScripts: {
            options: 'runScripts=dangerously + resources + requestInterceptor',
            intercepted: scriptsCounter.seen,
            note: '外部 <script src> 只有开了 runScripts 才会被请求 —— B 里没有 a.js 的原因',
          },
          passThroughInstrumentCheck: {
            options: `resources + 拦截器放行（undefined）→ 真实传输到 127.0.0.1:${String(probePort)} 的只听端口`,
            intercepted: passSeen,
            networkCalls: passThroughNetwork,
            note: '这一段本身不是"能力"读数，而是**仪器的正控**：探测仪必须能看见真实连接尝试（第一轮用 127.0.0.1:9 时被 undici 的 blocked-port 表挡在传输层之前，因此什么都量不到）',
          },
        },
      },
      subresourceFailures
    )
  }

  // -------------------------------------------------------------------------
  // G. 上限：2 MiB 流式 / 50,000 DOM 元素 / 截断
  // -------------------------------------------------------------------------

  {
    const capFailures: string[] = []

    // G1：合成流 —— 恰好到上限放行、超一个字节立刻中断
    const makeStream = (totalBytes: number, chunkBytes: number, onChunk: () => void): AsyncIterable<Uint8Array> => ({
      async *[Symbol.asyncIterator]() {
        let written = 0
        while (written < totalBytes) {
          const size = Math.min(chunkBytes, totalBytes - written)
          written += size
          onChunk()
          yield Buffer.alloc(size, 0x62)
        }
      },
    })

    const smallCap = 64 * 1024
    let consumedAtCap = 0
    const exact = await readBoundedBody(makeStream(smallCap, 8 * 1024, () => { consumedAtCap += 1 }), {
      maxBytes: smallCap,
      deadlineAt: now() + 5000,
      now,
    })
    const overCapFailures: string[] = []
    let consumedOverCap = 0
    try {
      await readBoundedBody(makeStream(smallCap + 1, 8 * 1024, () => { consumedOverCap += 1 }), {
        maxBytes: smallCap,
        deadlineAt: now() + 5000,
        now,
      })
      overCapFailures.push('超过上限却成功了')
    } catch (error) {
      const failure = error instanceof ActionFailureError ? error.failure : normalizeAdapterError(error)
      if (failure.code !== 'validation_failed') overCapFailures.push(`期望 validation_failed，得到 ${failure.code}`)
      if ((failure.details?.reason as string | undefined) !== 'body_too_large') {
        overCapFailures.push(`期望 body_too_large，得到 ${String(failure.details?.reason)}`)
      }
      capFailures.push(...overCapFailures.map((entry) => `readBoundedBody: ${entry}`))
    }
    if (exact.byteLength !== smallCap) capFailures.push(`恰好等于上限的读取长度不对：${String(exact.byteLength)}`)

    // G2：真实套接字上的 2 MiB 上限（服务端 3 MiB，客户端必须在 2 MiB 处掐断）
    const localServer = await startLocalHttpServer(articleHtml)
    const bigConnectorReading = emptyConnectorReading()
    const bigAdapter = createWebReadAdapter({
      fetchHtml: createPinnedHttpsFetcher({
        admit: admitWebReadUrl,
        resolve: makeTableResolver({ requested: [] }, { 'big.example': ['93.184.216.34'] }),
        connect: makeLocalTransport(localServer.reading.port, bigConnectorReading),
        now,
      }),
      totalTimeoutMs: 8000,
      now,
    })
    const bigCall = await callAdapter(bigAdapter, makeInput('https://big.example/huge'))
    const bigBytesWritten = localServer.reading.bigBodyBytesWritten
    if (bigCall.failureCode !== 'validation_failed') {
      capFailures.push(`2 MiB 上限：期望 validation_failed，得到 ${String(bigCall.failureCode)} / ${String(bigCall.failureMessage)}`)
    }
    if (bigCall.failureReason !== 'body_too_large') {
      capFailures.push(`2 MiB 上限：期望 body_too_large，得到 ${String(bigCall.failureReason)}`)
    }
    if (bigBytesWritten >= 3 * 1024 * 1024) {
      capFailures.push(`服务端在客户端中断前已把 3 MiB 全部写出（${String(bigBytesWritten)} 字节）—— 说明不是边读边掐`)
    }
    const receivedBytes = Number(bigCall.failureDetails?.receivedBytes ?? -1)
    if (!(receivedBytes > WEB_READ_MAX_BYTES && receivedBytes <= WEB_READ_MAX_BYTES + 64 * 1024)) {
      capFailures.push(`中断点不在 2 MiB 附近：receivedBytes=${String(receivedBytes)}`)
    }

    recordCase(
      'byte-cap',
      '2 MiB 上限：恰好到上限放行、超过一个字节立刻中断（真实套接字 3 MiB 响应）',
      {
        maxBytes: WEB_READ_MAX_BYTES,
        syntheticExactAtCap: { cap: smallCap, bytes: exact.byteLength, chunksConsumed: consumedAtCap },
        syntheticOverCap: {
          cap: smallCap,
          chunksConsumed: consumedOverCap,
          expected: 'validation_failed / body_too_large',
          failures: overCapFailures,
        },
        realSocket3MiB: {
          status: bigCall.status,
          failureCode: bigCall.failureCode,
          reason: bigCall.failureReason,
          message: bigCall.failureMessage,
          receivedBytesAtAbort: receivedBytes,
          bytesServerWrote: bigBytesWritten,
          chunksServerWrote: localServer.reading.bigBodyChunksWritten,
          serverSawClientClose: localServer.reading.closedByClient,
          note: '服务端写了多少字节是"客户端有没有先缓冲完"的判据；3 MiB 未被全部写出 = 边读边掐',
        },
      },
      capFailures
    )

    // G3：50,000 DOM 元素
    const manyElementsHtml = `<!DOCTYPE html><html><head><title>many</title></head><body><article><h1>many</h1>${'<div></div>'.repeat(60_000)}</article></body></html>`
    const manyExtraction = await extractArticle(manyElementsHtml, {})
    const manyAdapter = createWebReadAdapter({
      fetchHtml: async () => ({
        bytes: Buffer.from(manyElementsHtml, 'utf8'),
        finalUrl: 'https://many.example/x',
        finalHost: 'many.example',
        hops: fixtureHops,
        status: 200,
        contentType: 'text/html',
      }),
      now,
    })
    const manyCall = await callAdapter(manyAdapter, makeInput('https://many.example/x'))
    const smallHtml = `<!DOCTYPE html><html><head><title>small</title></head><body><article><h1>small</h1><p>${'一点正文。'.repeat(80)}</p></article></body></html>`
    const smallExtraction = await extractArticle(smallHtml, {})
    const tinyLimitExtraction = await extractArticle(smallHtml, { maxDomElements: 2 })
    const domFailures: string[] = []
    if (manyExtraction.ok) domFailures.push('60,000 元素的文档没有被上限拦下')
    if (manyExtraction.reason !== 'dom_element_limit_exceeded') domFailures.push(`理由不对：${String(manyExtraction.reason)}`)
    if (manyExtraction.domElementCount <= WEB_READ_MAX_DOM_ELEMENTS) domFailures.push('元素计数没有超过 50,000')
    if (manyCall.failureCode !== 'validation_failed') domFailures.push(`适配器期望 validation_failed，得到 ${String(manyCall.failureCode)}`)
    if (manyCall.failureReason !== 'dom_element_limit_exceeded') domFailures.push(`适配器理由不对：${String(manyCall.failureReason)}`)
    if (!smallExtraction.ok) domFailures.push('小文档被误拦')
    if (tinyLimitExtraction.ok || tinyLimitExtraction.reason !== 'dom_element_limit_exceeded') {
      domFailures.push('把上限压到 2 时小文档没有被拦（说明计数或判据是假的）')
    }
    recordCase(
      'dom-element-cap',
      '50,000 DOM 元素上限（60,000 触发 / 小文档放行 / 低上限正控）',
      {
        maxDomElements: WEB_READ_MAX_DOM_ELEMENTS,
        many: {
          htmlChars: manyElementsHtml.length,
          domElementCount: manyExtraction.domElementCount,
          ok: manyExtraction.ok,
          reason: manyExtraction.reason ?? null,
          adapterFailureCode: manyCall.failureCode,
          adapterReason: manyCall.failureReason,
        },
        small: { domElementCount: smallExtraction.domElementCount, ok: smallExtraction.ok, textChars: smallExtraction.text.length },
        tinyLimitControl: { maxDomElements: 2, ok: tinyLimitExtraction.ok, reason: tinyLimitExtraction.reason ?? null },
      },
      domFailures
    )

    // G4：截断到 TURN_CONTENT_LIMITS.maxTextChars，scope 三条等式仍然成立
    const longParagraph =
      '这是一段足够长的正文，用来把当轮内容推到上限之上，从而检验截断与范围记账是否如实。'.repeat(4)
    const longHtml = `<!DOCTYPE html><html><head><title>long</title><meta charset="utf-8"></head><body><article><h1>long</h1>${`<p>${longParagraph}</p>`.repeat(600)}</article></body></html>`
    const longAdapter = createWebReadAdapter({
      fetchHtml: async () => ({
        bytes: Buffer.from(longHtml, 'utf8'),
        finalUrl: 'https://long.example/x',
        finalHost: 'long.example',
        hops: fixtureHops,
        status: 200,
        contentType: 'text/html; charset=utf-8',
      }),
      now,
    })
    const longCall = await callAdapter(longAdapter, makeInput('https://long.example/x'))
    const longItem = longCall.outcome?.turnContent?.[0]
    const longFailures: string[] = []
    if (longItem === undefined) {
      longFailures.push(`没有产出内容：${String(longCall.failureCode)} / ${String(longCall.failureMessage)}`)
    } else {
      if (longItem.scope.includedChars !== longItem.text.length) longFailures.push('includedChars != text.length')
      if (longItem.scope.includedChars !== TURN_CONTENT_LIMITS.maxTextChars) {
        longFailures.push(`没有截断到上限：${String(longItem.scope.includedChars)}`)
      }
      if (longItem.scope.truncated !== true) longFailures.push('truncated 不是 true')
      if (!(longItem.scope.totalChars > longItem.scope.includedChars)) longFailures.push('totalChars 没有大于 includedChars')
      try {
        assertTurnContent(longItem)
      } catch (error) {
        longFailures.push(`截断后 assertTurnContent 抛错：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const surrogateInput = `${'a'.repeat(5)}😀${'b'.repeat(5)}`
    const surrogateCut = truncateText(surrogateInput, 6)
    if (surrogateCut.length !== 5) longFailures.push(`代理对边界切错了：len=${String(surrogateCut.length)}`)
    recordCase(
      'truncation-and-scope',
      '超出 60,000 字符时的截断与 scope 记账（含代理对边界）',
      {
        maxTextChars: TURN_CONTENT_LIMITS.maxTextChars,
        status: longCall.status,
        scope: longItem?.scope ?? null,
        textChars: longItem?.text.length ?? null,
        facts: longItem?.facts ?? null,
        surrogateBoundary: { input: surrogateInput, cut: surrogateCut, cutLength: surrogateCut.length },
      },
      longFailures
    )

    // G5：本地上游行为（状态码 / content-type / 超时 / 真实跳链）
    const behaviorReadings: Record<string, unknown>[] = []
    const behaviorFailures: string[] = []
    const runBehaviorCase = async (
      id: string,
      url: string,
      expect: { failureCode?: string; reason?: string; status?: string; httpStatus?: number },
      totalTimeoutMs = 8000
    ): Promise<void> => {
      const connectorReading = emptyConnectorReading()
      const adapter = createWebReadAdapter({
        fetchHtml: createPinnedHttpsFetcher({
          admit: admitWebReadUrl,
          resolve: makeTableResolver({ requested: [] }, { 'site.example': ['93.184.216.34'] }),
          connect: makeLocalTransport(localServer.reading.port, connectorReading),
          now,
        }),
        totalTimeoutMs,
        now,
      })
      const call = await callAdapter(adapter, makeInput(url))
      behaviorReadings.push({
        id,
        url,
        status: call.status,
        failureCode: call.failureCode,
        reason: call.failureReason,
        message: call.failureMessage,
        httpStatus: call.failureDetails?.httpStatus ?? null,
        connectCalls: connectorReading.requested.length,
        hops: call.failureDetails?.hops ?? null,
        textChars: call.outcome?.turnContent?.[0]?.text.length ?? null,
      })
      if (expect.failureCode !== undefined && call.failureCode !== expect.failureCode) {
        behaviorFailures.push(`${id}: 期望 failureCode=${expect.failureCode}，得到 ${String(call.failureCode)}（${String(call.failureMessage)}）`)
      }
      if (expect.reason !== undefined && call.failureReason !== expect.reason) {
        behaviorFailures.push(`${id}: 期望 reason=${expect.reason}，得到 ${String(call.failureReason)}`)
      }
      if (expect.status !== undefined && call.status !== expect.status) {
        behaviorFailures.push(`${id}: 期望 status=${expect.status}，得到 ${call.status}`)
      }
      if (expect.httpStatus !== undefined && call.failureDetails?.httpStatus !== expect.httpStatus) {
        behaviorFailures.push(`${id}: httpStatus 没保留（${String(call.failureDetails?.httpStatus)}）`)
      }
    }

    await runBehaviorCase('status-404', 'https://site.example/404', { failureCode: 'target_not_found', status: 'not_found', httpStatus: 404 })
    await runBehaviorCase('status-500', 'https://site.example/500', { failureCode: 'execution_failed', status: 'failed', httpStatus: 500 })
    await runBehaviorCase('content-type-json', 'https://site.example/json', { failureCode: 'validation_failed', reason: 'unsupported_content_type' })
    await runBehaviorCase('content-type-missing', 'https://site.example/no-content-type', { failureCode: 'validation_failed', reason: 'missing_content_type' })
    await runBehaviorCase('content-encoding-unrequested-gzip', 'https://site.example/gzip', {
      failureCode: 'validation_failed',
      reason: 'unsupported_content_encoding',
    })
    await runBehaviorCase('timeout-hanging-server', 'https://site.example/hang', { failureCode: 'timeout', status: 'timeout' }, 400)
    await runBehaviorCase('redirect-chain-real-http', 'https://site.example/r1', { status: 'success' })
    await runBehaviorCase('redirect-to-private-real', 'https://site.example/to-private', { failureCode: 'validation_failed', reason: 'forbidden_address' })
    await runBehaviorCase('redirect-to-http-real', 'https://site.example/to-http', { failureCode: 'validation_failed', reason: 'not_https' })

    // 超时：一个永不返回的 connect（说明总期限不只是"连接器自己自觉"）
    {
      const neverAdapter = createWebReadAdapter({
        fetchHtml: createPinnedHttpsFetcher({
          admit: admitWebReadUrl,
          resolve: async () => ['93.184.216.34'],
          connect: () => new Promise(() => {}),
          now,
        }),
        totalTimeoutMs: 300,
        now,
      })
      const neverCall = await callAdapter(neverAdapter, makeInput('https://never.example/x'))
      behaviorReadings.push({
        id: 'timeout-hanging-connect',
        status: neverCall.status,
        failureCode: neverCall.failureCode,
        reason: neverCall.failureReason,
        message: neverCall.failureMessage,
      })
      if (neverCall.failureCode !== 'timeout') behaviorFailures.push(`timeout-hanging-connect: 期望 timeout，得到 ${String(neverCall.failureCode)}`)
    }

    // 超时：DNS 侧挂住
    {
      const dnsHangAdapter = createWebReadAdapter({
        fetchHtml: createPinnedHttpsFetcher({
          admit: admitWebReadUrl,
          resolve: () => new Promise(() => {}),
          connect: () => new Promise(() => {}),
          now,
        }),
        totalTimeoutMs: 300,
        now,
      })
      const dnsHangCall = await callAdapter(dnsHangAdapter, makeInput('https://dnshang.example/x'))
      behaviorReadings.push({
        id: 'timeout-hanging-resolve',
        status: dnsHangCall.status,
        failureCode: dnsHangCall.failureCode,
        reason: dnsHangCall.failureReason,
        message: dnsHangCall.failureMessage,
      })
      if (dnsHangCall.failureCode !== 'timeout') behaviorFailures.push(`timeout-hanging-resolve: 期望 timeout，得到 ${String(dnsHangCall.failureCode)}`)
    }

    // DNS 失败必须**不是**超时（withDeadline 的"工作自身失败原样传播"）
    {
      const dnsFailAdapter = createWebReadAdapter({
        fetchHtml: createPinnedHttpsFetcher({
          admit: admitWebReadUrl,
          resolve: async () => {
            const error = new Error('getaddrinfo ENOTFOUND dnserror.example') as Error & { code?: string }
            error.code = 'ENOTFOUND'
            throw error
          },
          connect: () => new Promise(() => {}),
          now,
        }),
        totalTimeoutMs: 3000,
        now,
      })
      const dnsFailCall = await callAdapter(dnsFailAdapter, makeInput('https://dnserror.example/x'))
      behaviorReadings.push({
        id: 'dns-failure-is-not-timeout',
        status: dnsFailCall.status,
        failureCode: dnsFailCall.failureCode,
        message: dnsFailCall.failureMessage,
      })
      if (dnsFailCall.failureCode === 'timeout') behaviorFailures.push('DNS 失败被误报成 timeout')
      if (dnsFailCall.status !== 'failed') behaviorFailures.push(`DNS 失败期望 status=failed，得到 ${dnsFailCall.status}`)
    }

    // 缺 URL 参数
    {
      const noUrlAdapter = createWebReadAdapter({
        fetchHtml: seamFetcher,
        now,
      })
      const noUrlInput: AdapterExecuteInput = {
        actionId: newActionId(),
        operation: WEB_READ_OPERATION,
        target: { type: 'web_url', confidence: 'none' },
        args: {},
        now: turnClock,
      }
      const noUrlCall = await callAdapter(noUrlAdapter, noUrlInput)
      behaviorReadings.push({
        id: 'missing-url',
        status: noUrlCall.status,
        failureCode: noUrlCall.failureCode,
        reason: noUrlCall.failureReason,
      })
      if (noUrlCall.failureCode !== 'validation_failed' || noUrlCall.failureReason !== 'missing_url') {
        behaviorFailures.push(`missing-url: 期望 validation_failed/missing_url，得到 ${String(noUrlCall.failureCode)}/${String(noUrlCall.failureReason)}`)
      }
    }

    recordCase(
      'upstream-behaviour',
      '本地上游行为：状态码 / content-type / 超时 / 真实跳链 / 缺参',
      { cases: behaviorReadings, localServerRequests: localServer.reading.requests },
      behaviorFailures
    )

    await localServer.close()
  }

  // -------------------------------------------------------------------------
  // H. TLS：真实套接字上"固定地址 + 保留原主机名校验"
  // -------------------------------------------------------------------------

  {
    const tlsFailures: string[] = []
    let tlsServer: ReturnType<typeof createHttpsServer> | null = null
    let tlsPort = 0
    let bindError: string | null = null
    const key = readFileSync(TEST_KEY_PATH)
    const cert = readFileSync(TEST_CERT_PATH)
    try {
      tlsServer = createHttpsServer({ key, cert }, (req: IncomingMessage, res: ServerResponse) => {
        if ((req.url ?? '/').startsWith('/article')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(articleHtml)
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body><p>tls ok</p></body></html>')
      })
      await new Promise<void>((resolve, rejectListen) => {
        tlsServer?.once('error', rejectListen)
        tlsServer?.listen(443, '127.0.0.1', () => {
          const address = tlsServer?.address()
          tlsPort = typeof address === 'object' && address !== null ? address.port : 0
          resolve()
        })
      })
    } catch (error) {
      bindError = error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}`.trim() : String(error)
    }

    const tlsReadings: Record<string, unknown>[] = []

    const attemptConnect = async (input: {
      label: string
      servername: string
      trustedCa: boolean
      path?: string
      readBody?: boolean
    }): Promise<void> => {
      if (tlsServer === null || bindError !== null) return
      const connector = createPinnedHttpsConnector(input.trustedCa ? { trustedCa: [cert] } : {})
      let reading: Record<string, unknown>
      try {
        const connection = await connector({
          address: '127.0.0.1',
          family: 4,
          port: WEB_READ_ALLOWED_PORT,
          servername: input.servername,
          hostHeader: input.servername,
          path: input.path ?? '/article',
          deadlineAt: now() + 4000,
          now,
        })
        let bodyChars: number | null = null
        let bodySha256: string | null = null
        if (input.readBody === true) {
          const bytes = await readBoundedBody(connection.body, { maxBytes: WEB_READ_MAX_BYTES, deadlineAt: now() + 4000, now })
          bodyChars = bytes.byteLength
          bodySha256 = sha256Hex(bytes)
        }
        connection.destroy()
        reading = { label: input.label, ok: true, status: connection.status, bodyChars, bodySha256 }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? null
        reading = {
          label: input.label,
          ok: false,
          errorCode: code,
          errorMessage: error instanceof Error ? error.message.slice(0, 140) : String(error),
        }
      }
      tlsReadings.push(reading)
    }

    // 正控：固定到 127.0.0.1 但 SNI/主机名校验对象是 localhost（证书 CN=localhost）
    await attemptConnect({ label: 'pinned-ip__servername=localhost__trustedCa=yes', servername: 'localhost', trustedCa: true, readBody: true })
    // 负控 1：主机名不匹配必须失败（证明主机名校验真的在做）
    await attemptConnect({ label: 'pinned-ip__servername=wrong.invalid__trustedCa=yes', servername: 'wrong.invalid', trustedCa: true })
    // 负控 2：不给 ca ⇒ 自签证书必须失败（证明没有关掉链校验）
    await attemptConnect({ label: 'pinned-ip__servername=localhost__trustedCa=no', servername: 'localhost', trustedCa: false })
    // 负控 3：不给 servername（等于拿 IP 去校验）⇒ 必须失败
    await attemptConnect({ label: 'pinned-ip__servername=127.0.0.1__trustedCa=yes', servername: '127.0.0.1', trustedCa: true })

    const positive = tlsReadings.find((entry) => entry.label === 'pinned-ip__servername=localhost__trustedCa=yes')
    const wrongName = tlsReadings.find((entry) => entry.label === 'pinned-ip__servername=wrong.invalid__trustedCa=yes')
    const noCa = tlsReadings.find((entry) => entry.label === 'pinned-ip__servername=localhost__trustedCa=no')
    if (bindError !== null) {
      tlsFailures.push(`无法在 127.0.0.1:443 起本地 TLS 服务：${bindError}（这一段记为 NOT RUN）`)
    } else {
      if (positive?.ok !== true) tlsFailures.push(`正控失败：固定 IP + 正确 SNI 应当成功，得到 ${JSON.stringify(positive)}`)
      if (positive?.bodySha256 !== sha256Hex(articleHtml)) tlsFailures.push('正控读回的正文与夹具字节不一致')
      if (wrongName?.ok !== false) tlsFailures.push('负控失败：主机名不匹配竟然成功了')
      if (wrongName?.errorCode !== 'ERR_TLS_CERT_ALTNAME_INVALID') {
        tlsFailures.push(`负控的理由不是主机名不匹配：${String(wrongName?.errorCode)}`)
      }
      if (noCa?.ok !== false) tlsFailures.push('负控失败：不给 ca 的自签证书竟然成功了')
      if (noCa?.errorCode !== 'DEPTH_ZERO_SELF_SIGNED_CERT' && noCa?.errorCode !== 'SELF_SIGNED_CERT_IN_CHAIN') {
        tlsFailures.push(`自签证书的失败理由意外：${String(noCa?.errorCode)}`)
      }
    }

    recordCase(
      'tls-hostname-validation',
      '真实套接字：连接固定到 IP，证书只按原主机名校验（正控 + 三个负控）',
      {
        bindError,
        serverPort: tlsPort,
        certificate: { path: TEST_CERT_PATH, subjectCN: 'localhost', trustedAs: 'trustedCa（只加信任，不关校验）' },
        readings: tlsReadings,
        realResolverReading: realLookup,
      },
      tlsFailures
    )

    if (tlsServer !== null) {
      await new Promise<void>((done) => {
        tlsServer?.close(() => {
          done()
        })
      })
    }
  }

  // -------------------------------------------------------------------------
  // 汇总与落盘
  // -------------------------------------------------------------------------

  const passed = cases.filter((entry) => entry.status === 'PASS').length
  const failed = cases.length - passed
  const adapterReadings = forbiddenAdapterCases
  const fixtureCase = cases.find((entry) => entry.id === 'fixture-extraction')
  const fixtureReadings = (fixtureCase?.readings ?? {}) as Record<string, unknown>
  const leakCheck = (fixtureReadings.metadataLeakCheck ?? null) as
    | { sentinels?: string[]; leakedSentinels?: string[] }
    | null
  const output = {
    generatedAt: new Date().toISOString(),
    status: 'RAN',
    purpose: 'WP3（网页深读）适配器的离线读数：准入 / DNS 固定 / 逐跳重定向 / 上限 / 提取 / 契约 / TLS',
    environment,
    cases,
    summary: {
      cases: cases.length,
      passed,
      failed,
      failedIds: cases.filter((entry) => entry.status === 'FAIL').map((entry) => entry.id),
      forbiddenTargets: {
        verdicts: forbiddenVerdicts.length,
        connectAttempts: adapterReadings.reduce((sum, entry) => sum + Number(entry.connectCalls), 0),
        resolveAttempts: adapterReadings.reduce((sum, entry) => sum + Number(entry.resolveCalls), 0),
        note: '受禁 URL 走完整适配器（真实准入）后的出站计数；DNS 驱动的拒绝另计（dns-driven-refusal）',
      },
      turnContentContract: {
        // 直接取自 fixture-extraction 的读数（不是从"用例 PASS"反推）
        assertTurnContent: fixtureReadings.assertTurnContent ?? null,
        assertTurnContentList: fixtureReadings.assertTurnContentList ?? null,
        validationProblems: fixtureReadings.validationProblems ?? null,
      },
      bodyTextLeak: {
        sentinels: leakCheck?.sentinels ?? BODY_SENTINELS,
        leakedSentinels: leakCheck?.leakedSentinels ?? null,
        note: 'effect / evidence / facts / TurnContentRef 四处的元数据里出现正文 sentinel 的条数',
      },
    },
  }

  mkdirSync(join(prepDir, 'runs'), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

  process.stdout.write(
    [
      '',
      '=== web.read 探针读数 ===',
      `用例：${String(cases.length)}（PASS ${String(passed)} / FAIL ${String(failed)}）`,
      `受禁 URL：${String(forbiddenVerdicts.length)} 条，出站尝试 ${String(output.summary.forbiddenTargets.connectAttempts)} 次`,
      `产出：${outPath}`,
    ].join('\n') + '\n'
  )
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(
    `probe-web-read 失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exitCode = 1
})
