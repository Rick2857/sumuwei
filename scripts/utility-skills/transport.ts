/**
 * transport —— 离线网络夹具（`web.read` 的六组用；`scripts/utility-skills-verify.ts` 专用）。
 *
 * ============================================================================
 *  它替换的是什么、**不**替换的是什么
 * ============================================================================
 * `web-read.ts` 的三处注入点（`resolve` / `connect` / `admit`）是**它自己**留的测试缝
 * （文件头写明「只有验收"本地夹具"时才替换（生产缺省 = `admitWebReadUrl`）」）。
 *
 * ```text
 * 被替换   ① 地址解析（DNS）   → 夹具的 Hosts 表（.test 域名 → 127.0.0.1）
 *          ② 连接目的地       → 本地 HTTPS 夹具服务（**TLS 逐字保留**：真的握手、
 *                               真的证书校验，`rejectUnauthorized` 仍是 true）
 *          ③ 地址分类         → 只把"解析出来的回环地址"放行，**仅限夹具主机名**；
 *                               协议 / 端口 / 凭据 / 字面量地址那几道仍由**真实**实现判
 * 不被替换 有界读取（2 MiB 立刻中断）、DOM 元素上限、content-type 门、
 *          jsdom 默认选项（不跑脚本、不加载子资源）、Readability 提取、
 *          15 秒总期限、重定向次数上限
 * ```
 *
 * ⚠️ **这不是"直接调适配器"**：夹具只提供字节，判定链整条在适配器里跑。
 *
 * ⚠️ 证书**每次运行现生成**（自签 CA + SAN 覆盖夹具主机名），私钥落临时目录、
 *    不进仓库。TLS 客户端仍然做真实校验（`ca = [自签证书]`、`servername = 原主机`）
 *    —— 也就是"地址被固定住"与"证书校验仍然生效"两件事**同时**成立。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import {
  createPinnedHttpsConnector,
  createPinnedHttpsFetcher,
  type WebReadConnectRequest,
  type WebReadConnection,
  type WebReadFetcher,
} from '../../src/infrastructure/action/adapters/web-read.ts'

// ---------------------------------------------------------------------------
// 自签证书（每次运行现生成）
// ---------------------------------------------------------------------------

export interface LocalTlsMaterial {
  readonly certPath: string
  readonly keyPath: string
  /** PEM 文本（作为 `ca` 传给连接器） */
  readonly certPem: string
  readonly opensslAvailable: boolean
  readonly problem?: string
}

/**
 * 夹具用的**合成主机名**。
 *
 * ⚠️ 为什么不能是 `127.0.0.1`：适配器在**进入获取阶段之前**对 `args.url` 调了一次
 *    `admitWebReadUrl`（`web-read.ts` 适配器本体那一处**不可注入**），而字面量回环
 *    地址会被它正确地拒绝（`forbidden_address`）。
 *    因此夹具必须让"用户原话里的 URL"看起来是一个**公网**地址：
 *    主机名是合成的，解析由夹具的 Hosts 表回答，答案是一个**公网 IP**；
 *    只有"实际连到哪里"由夹具的 `connect` 替换 —— 这恰好是适配器留缝的那两层
 *    （`resolve` / `connect`），而**准入与逐地址校验仍然由真实实现跑**。
 */
export const FIXTURE_HOSTS: readonly string[] = [
  'article.test',
  'redirect.test',
  'loop.test',
  'status.test',
  'slow.test',
  'large.test',
  'shell.test',
  'mixed.test',
  'private.test',
  'empty.test',
]

/** 夹具宣称的"公网地址"（TEST-NET-3 文档保留段；**不是**真出站目标，只是准入的读数） */
export const FIXTURE_PUBLIC_IP = '93.184.216.34'
/** 混合解析/私网解析用的不合格地址 */
export const FIXTURE_LOOPBACK_IP = '127.0.0.1'
export const FIXTURE_PRIVATE_IP = '10.0.0.5'

/**
 * 生成一张只在本次运行里使用的自签证书。
 *
 * ⚠️ 用系统 `openssl`（本机实测存在）；**没有**它 ⇒ 如实返回 `opensslAvailable: false`，
 *    调用方据此把依赖网络夹具的组判 `NOT RUN`（不是 PASS、也不是悄悄跳过 TLS）。
 */
export function generateLocalTlsMaterial(dir: string): LocalTlsMaterial {
  const certPath = join(dir, 'local-fixture.crt')
  const keyPath = join(dir, 'local-fixture.key')
  mkdirSync(dir, { recursive: true })
  if (existsSync(certPath) && existsSync(keyPath)) {
    return {
      certPath,
      keyPath,
      certPem: readFileSync(certPath, 'utf8'),
      opensslAvailable: true,
    }
  }

  /*
   * ⚠️ SAN 必须同时覆盖**主机名**与**夹具宣称的公网 IP**：
   *    `buildPinnedHttpsRequestOptions` 对 IP 字面量**不设 SNI**（RFC 6066），
   *    于是 TLS 校验对象就是那个 IP ⇒ 证书里必须列 `IP:<addr>`，否则
   *    `ERR_TLS_CERT_ALTNAME_INVALID: Hostname/IP does not match ... IP: 127.0.0.1 is not in the cert's list`
   *    （实测：2026-10-04，夹具第一版只列了 DNS 名）。
   */
  const san = [
    ...FIXTURE_HOSTS.map((host) => `DNS:${host}`),
    `IP:${FIXTURE_PUBLIC_IP}`,
    'IP:127.0.0.1',
  ].join(',')
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '3650',
        '-subj',
        '/CN=article.test/O=project-LG local fixture',
        '-addext',
        `subjectAltName=${san}`,
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
        '-addext',
        'extendedKeyUsage=serverAuth',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
  } catch (error) {
    return {
      certPath,
      keyPath,
      certPem: '',
      opensslAvailable: false,
      problem: `openssl 生成自签证书失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return { certPath, keyPath, certPem: readFileSync(certPath, 'utf8'), opensslAvailable: true }
}

// ---------------------------------------------------------------------------
// Hosts 表（合成公网主机名 → 夹具宣称的公网地址）
// ---------------------------------------------------------------------------

export interface LocalWebHosts {
  /** 主机名 → 解析出来的地址（夹具默认给一个**公网**地址，于是准入会放行） */
  readonly map: ReadonlyMap<string, readonly string[]>
  readonly hostNames: readonly string[]
}

export function makeLocalHosts(
  hostNames: readonly string[] = FIXTURE_HOSTS,
  address: string = FIXTURE_PUBLIC_IP
): LocalWebHosts {
  const map = new Map<string, readonly string[]>()
  for (const host of hostNames) map.set(host, [address])
  return { map, hostNames }
}

// ---------------------------------------------------------------------------
// 本地 HTTPS 夹具服务
// ---------------------------------------------------------------------------

export interface LocalWebFixture {
  readonly port: number
  readonly tls: LocalTlsMaterial
  readonly hosts: LocalWebHosts
  readonly urlFor: (host: string, path?: string) => string
  /** 各路由被访问的次数（按 host + path 键） */
  readonly hits: ReadonlyMap<string, number>
  /** 逐响应的实测读数（服务端视角：真的写出去了多少字节） */
  readonly served: readonly {
    host: string
    path: string
    status: number
    declaredBytes: number
    writtenBytes: number
    clientAborted: boolean
  }[]
  readonly close: () => Promise<void>
}

export interface LocalWebRoute {
  readonly host: string
  readonly path: string
  readonly status: number
  readonly contentType?: string
  readonly body?: string | Uint8Array
  readonly headers?: Record<string, string>
  /** 分块发送的每块字节数（用于"超限在读取阶段终止"的实测） */
  readonly chunkBytes?: number
  readonly chunkCount?: number
  /** 响应之前等多久（毫秒；用于超时那一组） */
  readonly delayMs?: number
}

export async function startLocalWebFixture(input: {
  tls: LocalTlsMaterial
  routes: readonly LocalWebRoute[]
  hostNames?: readonly string[]
}): Promise<LocalWebFixture> {
  const hostNames = input.hostNames ?? FIXTURE_HOSTS
  const hosts = makeLocalHosts(hostNames)
  const hits = new Map<string, number>()
  const served: {
    host: string
    path: string
    status: number
    declaredBytes: number
    writtenBytes: number
    clientAborted: boolean
  }[] = []
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

  const server: Server = createServer(
    {
      cert: readFileSync(input.tls.certPath),
      key: readFileSync(input.tls.keyPath),
    },
    (request: IncomingMessage, response: ServerResponse) => {
      const host = String(request.headers.host ?? '').split(':')[0]?.toLowerCase() ?? ''
      const path = String(request.url ?? '/')
      const key = `${host}${path}`
      hits.set(key, (hits.get(key) ?? 0) + 1)
      const route = input.routes.find((item) => item.host === host && item.path === path)
      if (route === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        served.push({ host, path, status: 404, declaredBytes: 0, writtenBytes: 9, clientAborted: false })
        return
      }

      const send = (): void => {
        const headers: Record<string, string> = { ...(route.headers ?? {}) }
        if (route.contentType !== undefined) headers['content-type'] = route.contentType
        if (route.chunkBytes !== undefined && route.chunkCount !== undefined) {
          const chunkSize = route.chunkBytes
          const chunkTotal = route.chunkCount
          headers['content-type'] = route.contentType ?? 'text/html; charset=utf-8'
          response.writeHead(route.status, headers)
          const chunk = Buffer.alloc(chunkSize, 0x20)
          let written = 0
          let aborted = false
          response.on('close', () => {
            aborted = true
          })
          let index = 0
          /*
           * ⚠️ 读数在 \`close\` 里**同步**落盘，不依赖 \`response.end()\` 的回调：
           *    被客户端中断的连接上，end 的回调**永远不会**触发 ——
           *    而"超限时服务端到底写出了多少字节"正是这一档唯一的硬证据（实测踩过）。
           */
          response.on('close', () => {
            aborted = true
            served.push({
              host,
              path,
              status: route.status,
              declaredBytes: chunkSize * chunkTotal,
              writtenBytes: written,
              clientAborted: true,
            })
          })
          const finish = (): void => {
            served.push({
              host,
              path,
              status: route.status,
              declaredBytes: chunkSize * chunkTotal,
              writtenBytes: written,
              clientAborted: false,
            })
          }
          const pump = (): void => {
            if (aborted || index >= chunkTotal) {
              if (!aborted) {
                response.end()
                finish()
              }
              return
            }
            index += 1
            const ok = response.write(chunk)
            written += chunk.byteLength
            if (ok) setImmediate(pump)
            else response.once('drain', pump)
          }
          pump()
          return
        }

        const body = route.body ?? ''
        const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
        response.writeHead(route.status, headers)
        let aborted = false
        response.on('close', () => {
          aborted = true
        })
        response.end(bytes, () => {
          served.push({
            host,
            path,
            status: route.status,
            declaredBytes: bytes.byteLength,
            writtenBytes: bytes.byteLength,
            clientAborted: aborted,
          })
        })
      }

      if (route.delayMs !== undefined && route.delayMs > 0) {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer)
          if (!response.writableEnded) send()
        }, route.delayMs)
        pendingTimers.add(timer)
        return
      }
      send()
    }
  )

  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    tls: input.tls,
    hosts,
    urlFor: (host, path = '/') => `https://${host}${path}`,
    hits,
    served,
    async close() {
      for (const timer of pendingTimers) clearTimeout(timer)
      pendingTimers.clear()
      await new Promise<void>((resolvePromise) => {
        server.closeAllConnections?.()
        server.close(() => resolvePromise())
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 与适配器对接的获取器
// ---------------------------------------------------------------------------

export interface FixtureFetcherReading {
  /** 连接器真的被调用的次数（**受禁目标必须是 0**） */
  readonly connectCalls: number
  /** 连接器实际连到的地址与端口（"校验过的地址 = 实际连接的地址"） */
  readonly connectTargets: { address: string; port: number; servername: string }[]
  /** 解析器真的被调用的次数 */
  readonly resolveCalls: number
  /** 连接器向外抛出的错误（**诊断用**：只记 name/code/message，不含正文） */
  readonly connectErrors: { name: string; code: string; message: string }[]
  /** 连接**成功**的次数（拿到响应头） */
  readonly connectOk: number
  /** 解析器被问到的主机名（诊断用） */
  readonly resolveHosts: readonly string[]
}

/**
 * 造一对"夹具替换层"：`resolve`（Hosts 表）与 `connect`（把已校验的地址接到本地夹具端口）。
 *
 * ============================================================================
 *  为什么 `connect` 还要把地址换成 `127.0.0.1`（**实测约束，不是妥协**）
 * ============================================================================
 * 适配器的准入与逐地址分类是**真实实现**，而真实实现要求"目标是公网单播地址"。
 * 于是夹具的 Hosts 表必须给一个**真的公网** IP（`93.184.216.34`）。
 *
 * 但一个真的公网 IP **是不可能连到本机服务的** —— 实测：
 *
 * ```text
 * https://127.0.0.1:<port>/  → 200（9 ms）
 * https://93.184.216.34:<port>/ → ETIMEDOUT（21050 ms，从未到达本机 TLS 服务）
 * ```
 *
 * （第一版夹具就踩在这上面：主机名解析成 `127.0.0.1` ⇒ 适配器**正确地**报
 *  `forbidden_address`；换成保留段 `203.0.113.10` ⇒ 分类器判 `reserved` 仍然拒；
 *   换成真公网 IP 又连不到本机。三条路都堵死在"真实实现"这一侧。）
 *
 * 因此夹具在**连接器这一层**做最后一步地址翻译：准入看到的仍然是公网地址
 * （读数里如实记下），实际 TCP 目标是本机夹具端口 —— 这正是"替换 IO、不替换判定"
 * 的边界所在，也是适配器本来就留出 `connect` 缝的原因。
 *
 * ⚠️ 被替换的只有"包发到哪个网卡"，**没有**被替换的是：逐跳准入、逐地址分类、
 *    "用已校验地址而不是重新解析"这个决定、TLS 证书校验（`rejectUnauthorized` 仍为 true）、
 *    有界读取、content-type 门、jsdom/Readability 提取。
 */
export function makeFixtureFetcher(input: {
  fixture: LocalWebFixture
  /** 用 throw 的解析器：证明"受禁目标连解析都没发生" */
  throwOnResolve?: boolean
}): {
  fetcher: WebReadFetcher
  resolve: (host: string) => Promise<readonly string[]>
  connect: (request: WebReadConnectRequest) => Promise<WebReadConnection>
  reading: FixtureFetcherReading
} {
  const reading = {
    connectCalls: 0,
    connectTargets: [] as { address: string; port: number; servername: string }[],
    resolveCalls: 0,
    connectErrors: [] as { name: string; code: string; message: string }[],
    resolveHosts: [] as string[],
    connectOk: 0,
  }
  const { fixture } = input

  const resolve = async (host: string): Promise<readonly string[]> => {
    reading.resolveCalls += 1
    reading.resolveHosts.push(host)
    if (input.throwOnResolve === true) {
      throw new Error(`夹具禁止解析：${host}`)
    }
    return fixture.hosts.map.get(host.toLowerCase()) ?? []
  }

  const realConnector = createPinnedHttpsConnector({ trustedCa: [fixture.tls.certPem] })
  const connect = async (request: WebReadConnectRequest): Promise<WebReadConnection> => {
    reading.connectCalls += 1
    reading.connectTargets.push({
      address: request.address,
      port: fixture.port,
      servername: request.servername,
    })
    /*
     * ⚠️ 地址换成回环 + 端口换成夹具端口（见函数头：真公网 IP 连不到本机）。
     *    `servername` / Host 头 / `rejectUnauthorized` / `ca` 全部原样交给真实连接器
     *    ⇒ **TLS 主机名校验真的在跑**（证书 SAN 覆盖夹具主机名）。
     */
    try {
      const connection = await realConnector({
        ...request,
        address: '127.0.0.1',
        family: 4,
        port: fixture.port,
      })
      reading.connectOk += 1
      return connection
    } catch (error) {
      const typed = error as { name?: string; code?: string; message?: string }
      reading.connectErrors.push({
        name: String(typed.name ?? 'Error'),
        code: String(typed.code ?? ''),
        message: String(typed.message ?? '').slice(0, 200),
      })
      throw error
    }
  }

  const fetcher = createPinnedHttpsFetcher({ resolve, connect })
  return { fetcher, resolve, connect, reading }
}

/** 响应体指纹（"这次提取的正是那一份字节"） */
export function sha256OfBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 把一段文字落进本地证据目录（`local/` 已 gitignore：正文只放这里） */
export function writeLocalEvidence(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, name)
  writeFileSync(target, text, 'utf8')
  return target
}

/**
 * 同 `makeFixtureFetcher`，但**解析器可以换**（用于"混合解析 / 私网 / 无应答"那几档）。
 *
 * ⚠️ 为什么必须包成 fetcher：`Suite.readWeb()` 在没拿到 `fetchHtml` 时会自己拼一个
 *    默认 fetcher，于是 `overrides.resolve` 会被它覆盖 —— 实测症状是
 *    `mixed.test` 被解析成公网地址、连到夹具 404，判据看起来是 `http_status`
 *    而不是 `forbidden_address`。解析器只有走 fetcher 才真的生效。
 */
export function makeResolvingFetcher(
  fixture: LocalWebFixture,
  resolve: (host: string) => Promise<readonly string[]>
): WebReadFetcher {
  const base = makeFixtureFetcher({ fixture })
  return createPinnedHttpsFetcher({ resolve, connect: base.connect })
}
