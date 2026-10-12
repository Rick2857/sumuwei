/**
 * web-read —— `web.read` 的适配器（实用能力加装执行计划 §3.1「网页深读」）。
 *
 * ============================================================================
 *  它是一个**有界获取器**，不是一个 HTTP 工具
 * ============================================================================
 * 计划书 §3.1 逐字要求：「HTTPS、443 端口、无 URL 用户凭据，最多三次重定向；
 * 逐跳校验 IPv4/IPv6 的回环、私有、链路本地及其它非公网地址。连接使用已校验 DNS
 * 地址，并保留原主机的 TLS 证书/SNI 校验；不得"校验一次、实际连接重新随意解析"。
 * 优先用原生 HTTPS 获取及受控地址解析，避免再引入浏览器或通用爬虫。取得 HTML 后
 * 用 `new JSDOM()`，不启用脚本/子资源，不用 `JSDOM.fromURL()`；只提供正文文字。」
 *
 * 这条链上每一段都有**唯一**实现，且顺序不可倒：
 *
 * ```text
 * ① 准入（纯函数，可离线断言）   admitWebReadUrl       https / 443 / 无 userinfo / 字面地址非公网 ⇒ 否
 * ② 自行解析（node:dns）         resolve               lookup({ all: true, verbatim: true })
 * ③ 逐地址校验（纯函数）         classifyAddress       **每一个**返回的地址都必须是公网单播
 * ④ 连接**固定地址**             connect               host=<已校验 IP> + servername=<原主机> + rejectUnauthorized
 * ⑤ 有界边读（超过上限立刻中断） readBoundedBody       流式计数，超限即 abort，**不先缓冲**
 * ⑥ 正文提取（懒加载）           extractArticle        new JSDOM(html) 默认选项 + Readability
 * ```
 *
 * ============================================================================
 *  三条"不许"（每条都有对应的探针读数）
 * ============================================================================
 * ① **不许"校验一次、实际连接随意解析"**：DNS 只在第 ② 步做一次，连接用的是
 *    第 ③ 步校验过的那个地址（`host: <ip>`）。系统后来怎么解析与本次无关 ——
 *    这正是 DNS rebinding 的防线。
 * ② **不许因为固定了地址就丢掉 TLS 主机名校验**：连接同时给 `servername: <原主机>`
 *    与 `rejectUnauthorized: true`。实测（见探针 `tlsHostnameValidation`）：
 *    `host=127.0.0.1 + servername=localhost` 对 CN=localhost 的证书**成功**，
 *    而 `servername=wrong.invalid` 得到 `ERR_TLS_CERT_ALTNAME_INVALID`
 *    —— 也就是说主机名校验仍然生效；不给 `ca` 时自签证书得到
 *    `DEPTH_ZERO_SELF_SIGNED_CERT`。地址固定与证书校验**同时**成立。
 * ③ **不许碰文件系统**：本文件只 import `node:crypto` / `node:dns/promises` /
 *    `node:https` / `node:net`。URL 字符串只经过 `new URL()` 与 `https.request`，
 *    没有 `fs` 的位置；`file:` / `c:` / 裸路径在 ① 就被否掉（`not_https` / `bad_url`）。
 *
 * ============================================================================
 *  失败怎么归一（`errors.ts` 的语义，逐条说明取舍）
 * ============================================================================
 * ```text
 * 准入失败（not_https / bad_port / userinfo / bad_url / 字面地址非公网）→ validation_failed
 * 解析后地址非公网（含重定向后）                                      → validation_failed
 * 正文超过 2 MiB / DOM 元素超过 50,000 / content-type 不是 HTML       → validation_failed
 * 重定向超过三次 / 重定向缺 Location                                  → validation_failed
 * 上游 404 / 410                                                      → target_not_found
 * Readability 返回 null 或正文为空                                    → target_not_found
 * 上游其它非 2xx / 连接或解析失败                                     → execution_failed
 * 上游不请自来地压缩（`Content-Encoding: gzip` 之类）                 → validation_failed
 * 超时（解析 / 连接 / 读取共用同一个 15 秒总期限）                     → timeout
 * ```
 * ⚠️ **为什么准入失败不用 `permission_denied`**：`turn-content-reply.ts` 把
 *    `status === 'rejected' && failureCode === 'permission_denied'` 解读成
 *    **"这项能力没有启用"**（`not_enabled`）。而"拒绝连接一个私网地址"与
 *    "网页深读没启用"是两件事 —— 用 `permission_denied` 会让回复层说出后者。
 *    同一理由，上游 401/403 **也不**用 `permission_denied`。
 * ⚠️ **为什么 Readability 返回 null 用 `target_not_found`**：传输本身成功了
 *    （`execution_failed` 会夸大失败），而"这个地址上没有可取的文章正文"
 *    与 `errors.ts` 的 `target_not_found`（目标不存在）语义一致 —— 用户看到的是
 *    "没拿到内容"，不是"系统坏了"。（动态空壳页正是这一档。）
 *
 * 正文**一个字都不进** `effect` / `evidence` / `facts`：那三处是账本与 trace 的来源，
 * 只有引用、指纹与计数（先例：ADR-045 `D-8`，`web-search.ts`）。
 */

import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'

import { ActionFailureError, actionFailure } from '../../../kernel/action/errors.ts'
import type { ActionFailureCode } from '../../../kernel/action/errors.ts'
import type { ActionEvidence } from '../../../kernel/action/action-request.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import { WEB_READ, WEB_READ_OPERATION } from '../../../kernel/action/utility-capabilities.ts'
import {
  TURN_CONTENT_LIMITS,
  type WebArticleTurnContent,
} from '../../../kernel/contracts/turn-content.ts'

// ---------------------------------------------------------------------------
// 首版运行约束（计划书 §3.1「公共初始上限」）
// ---------------------------------------------------------------------------

/** 解压后 HTML 上限。⚠️ 本实现不发 `Accept-Encoding`，因此这就是**响应体**上限 */
export const WEB_READ_MAX_BYTES = 2 * 1024 * 1024
/** DOM 元素上限（解析**之后**的守卫：它挡的是"把这份文档交给 Readability"，不是解析本身） */
export const WEB_READ_MAX_DOM_ELEMENTS = 50_000
/** 整次操作的总期限（解析 + 全部重定向跳 + 读取正文共用这一个预算） */
export const WEB_READ_TOTAL_TIMEOUT_MS = 15_000
/** 最多跟随几次重定向（⇒ 最多 4 次连接） */
export const WEB_READ_MAX_REDIRECTS = 3
/** 只允许 443（URL 里缺省端口等价于 443） */
export const WEB_READ_ALLOWED_PORT = 443

/** 重定向状态码（300/304 不是"换个地方取"） */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** 接受的响应媒体类型（"text/html-ish"）。只认这两种 —— 静态文章正文的前提 */
const HTML_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml'])

const DEFAULT_USER_AGENT = 'SuMuwei/1.0 (+web.read adapter; static article reader)'

// ---------------------------------------------------------------------------
// ① URL 准入（纯函数）
// ---------------------------------------------------------------------------

export type WebReadAdmissionReason =
  | 'not_https'
  | 'bad_port'
  | 'userinfo'
  | 'forbidden_address'
  | 'bad_url'

export interface WebReadUrlAdmissionOk {
  ok: true
  url: URL
  /** URL 规范化后的完整地址（punycode / 十进制 IP 都已归一） */
  href: string
  /** 规范化后的主机名（无方括号、无尾点、已小写） */
  host: string
  /** Host 头用的形态（IPv6 带方括号；缺省端口不出现） */
  hostHeader: string
  /** 主机是 IP 字面量时给出它（此时不做 DNS，直接按字面量判） */
  literalAddress?: string
  /** 字面量地址的类别（仅 `literalAddress` 存在时有意义） */
  literalScope?: AddressScope
}

export interface WebReadUrlAdmissionRejected {
  ok: false
  reason: WebReadAdmissionReason
  detail: string
  href?: string
}

export type WebReadUrlAdmission = WebReadUrlAdmissionOk | WebReadUrlAdmissionRejected

/**
 * 把主机名归一成可以拿去 DNS / SNI / Host 的形态。
 *
 * 三条归一（都来自实测，不是猜的）：
 * · `new URL('https://2130706433/x').hostname === '127.0.0.1'` —— 十进制/八进制/短形式
 *   IPv4 由 URL 解析器归一，所以"用 `new URL()` 解析"本身就是一道防线；
 * · `new URL('https://例え.jp/x').hostname === 'xn--r8jz45g.jp'` —— IDN 归一成 ASCII；
 * · `new URL('https://example.com./x').hostname === 'example.com.'` —— **尾点被保留**
 *   （而 `https://127.0.0.1./x` 的尾点被吃掉），因此这里显式去掉一个尾点，
 *   免得"是不是 IP 字面量"与 DNS 查询落在两个不同的字符串上。
 */
function normalizeHost(rawHostname: string): string {
  const unbracketed =
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname
  const lower = unbracketed.toLowerCase()
  return lower.endsWith('.') && lower.length > 1 ? lower.slice(0, -1) : lower
}

/**
 * URL 准入。
 *
 * 顺序是刻意的：**先协议，再端口，再凭据，最后地址** —— 于是
 * `file:///C:/Windows/win.ini` 报的是 `not_https`（"只走 HTTPS"），
 * 而不是某个含混的地址结论。`C:\Windows\win.ini` 也一样（`new URL()` 把它读成
 * 协议 `c:`），而 `/etc/passwd`、`not a url` 则连 URL 都不是 ⇒ `bad_url`。
 */
export function admitWebReadUrl(rawUrl: string): WebReadUrlAdmission {
  const text = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (text === '') {
    return { ok: false, reason: 'bad_url', detail: 'URL 是空串' }
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'bad_url', detail: '不是合法的绝对 URL（解析失败）' }
  }

  const href = url.href

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'not_https',
      detail: `只接受 https:，收到 ${url.protocol}`,
      href,
    }
  }

  if (url.port !== '' && url.port !== String(WEB_READ_ALLOWED_PORT)) {
    return {
      ok: false,
      reason: 'bad_port',
      detail: `只接受 ${String(WEB_READ_ALLOWED_PORT)} 端口（缺省端口也算），收到 ${url.port}`,
      href,
    }
  }

  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      reason: 'userinfo',
      detail: 'URL 里不得带用户凭据（username / password）',
      href,
    }
  }

  const host = normalizeHost(url.hostname)
  if (host === '') {
    return { ok: false, reason: 'bad_url', detail: '主机名为空', href }
  }

  const hostHeader =
    url.hostname.startsWith('[') ? `[${host}]` : host

  /*
   * ⚠️ IP 字面量必须先判、且**先于**下面的字符集检查：IPv6 字面量天然带冒号，
   *    先做 `[a-z0-9._-]` 检查会把 `https://[::1]/x` 报成 `bad_url`
   *    —— 结果虽然一样是"拒绝"，但"这是一个私网地址"这个事实就丢了
   *    （审计与计数要分得清"写法怪"和"想去内网"）。探针抓到的就是这个顺序问题。
   */
  const literalFamily = isIP(host)
  if (literalFamily !== 0) {
    const classified = classifyAddress(host)
    if (!classified.allowed) {
      return {
        ok: false,
        reason: 'forbidden_address',
        detail: `主机是 IP 字面量且属于 ${classified.scope}：${classified.address}`,
        href,
      }
    }
    return {
      ok: true,
      url,
      href,
      host,
      hostHeader,
      literalAddress: classified.address,
      literalScope: classified.scope,
    }
  }

  /*
   * 主机名必须是规范化之后的 ASCII 形态。
   * `new URL()` 已经把 IDN 转成 punycode，因此这里出现别的字符只可能是
   * 某种我们没预料到的形态 —— 失败关闭（不做"清洗一下试试"）。
   */
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(host)) {
    return {
      ok: false,
      reason: 'bad_url',
      detail: '主机名含 ASCII 字母数字与 `.-_` 之外的字符（拒绝猜测）',
      href,
    }
  }

  return { ok: true, url, href, host, hostHeader }
}

// ---------------------------------------------------------------------------
// 地址分类（纯函数）
// ---------------------------------------------------------------------------

export type AddressScope =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'cgnat'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  | 'invalid'

export interface AddressClassification {
  /** 归一后的地址（IPv4 点分 / IPv6 压缩形式由调用方给的原串决定，这里原样回显） */
  address: string
  /** 字面量的形态：4 / 6；不是 IP 时为 0 */
  family: 0 | 4 | 6
  scope: AddressScope
  /** 只有 `scope === 'public'` 才允许连接 */
  allowed: boolean
  /** IPv4-mapped IPv6（`::ffff:a.b.c.d` / `::ffff:7f00:1`）解出的内层 IPv4 */
  mappedIpv4?: string
}

/**
 * 地址分类：**默认拒绝，只有证明是公网单播才放行**。
 *
 * IPv4 侧按 RFC 6890 的保留块逐个列举（含 100.64/10 CGNAT、169.254/16 链路本地、
 * 224/4 组播、240/4 保留、各 TEST-NET、198.18/15 基准测试、192.88.99/24）；
 * IPv6 侧**不再逐个列举**：只有落在 `2000::/3`（全局单播）才放行，其余一律拒绝
 * （ULA `fc00::/7`、链路本地 `fe80::/10`、组播 `ff00::/8`、`::`、`::1`、
 * `2001:db8::/32`、NAT64 `64:ff9b::/96` 因此都自动落在拒绝侧）。
 * IPv4-mapped IPv6 解出内层 IPv4 再判 —— `::ffff:127.0.0.1` 必须与 `127.0.0.1` 同罪。
 */
export function classifyAddress(address: string): AddressClassification {
  const family = isIP(address)
  if (family === 4) {
    const bytes = ipv4ToBytes(address)
    if (bytes === undefined) return { address, family: 4, scope: 'invalid', allowed: false }
    return { address, family: 4, scope: classifyIpv4(bytes), allowed: classifyIpv4(bytes) === 'public' }
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(address)
    if (bytes === undefined) return { address, family: 6, scope: 'invalid', allowed: false }
    const mapped = mappedIpv4Of(bytes)
    if (mapped !== undefined) {
      const innerScope = classifyIpv4(mapped)
      return {
        address,
        family: 6,
        scope: innerScope,
        allowed: innerScope === 'public',
        mappedIpv4: mapped.join('.'),
      }
    }
    return { address, family: 6, scope: classifyIpv6(bytes), allowed: classifyIpv6(bytes) === 'public' }
  }
  return { address, family: 0, scope: 'invalid', allowed: false }
}

export function isForbiddenAddress(address: string): boolean {
  return !classifyAddress(address).allowed
}

function classifyIpv4(b: readonly number[]): AddressScope {
  const [a0, a1, a2, a3] = [b[0] ?? -1, b[1] ?? -1, b[2] ?? -1, b[3] ?? -1]
  if (a0 < 0) return 'invalid'
  if (a0 === 0) return 'reserved' // 0.0.0.0/8：本网络（含 0.0.0.0 未指定）
  if (a0 === 10) return 'private'
  if (a0 === 127) return 'loopback'
  if (a0 === 169 && a1 === 254) return 'link_local'
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return 'private'
  if (a0 === 192 && a1 === 168) return 'private'
  if (a0 === 100 && a1 >= 64 && a1 <= 127) return 'cgnat' // 100.64.0.0/10
  if (a0 === 192 && a1 === 0 && a2 === 0) return 'reserved' // 192.0.0.0/24 IETF 协议分配
  if (a0 === 192 && a1 === 0 && a2 === 2) return 'reserved' // TEST-NET-1
  if (a0 === 192 && a1 === 88 && a2 === 99) return 'reserved' // 6to4 中继任播
  if (a0 === 198 && (a1 === 18 || a1 === 19)) return 'reserved' // 基准测试
  if (a0 === 198 && a1 === 51 && a2 === 100) return 'reserved' // TEST-NET-2
  if (a0 === 203 && a1 === 0 && a2 === 113) return 'reserved' // TEST-NET-3
  if (a0 >= 224 && a0 <= 239) return 'multicast'
  if (a0 >= 240) return 'reserved' // 含 255.255.255.255 广播
  if (a0 === a1 && a1 === a2 && a2 === a3 && a3 === 255) return 'reserved'
  return 'public'
}

function classifyIpv6(bytes: readonly number[]): AddressScope {
  if (bytes.length !== 16) return 'invalid'
  const allZero = bytes.every((v) => v === 0)
  if (allZero) return 'unspecified'
  const isLoopback = bytes.slice(0, 15).every((v) => v === 0) && bytes[15] === 1
  if (isLoopback) return 'loopback'
  const first = bytes[0] ?? 0
  const second = bytes[1] ?? 0
  if ((first & 0xfe) === 0xfc) return 'private' // fc00::/7 ULA
  if (first === 0xfe && (second & 0xc0) === 0x80) return 'link_local' // fe80::/10
  if (first === 0xfe && (second & 0xc0) === 0xc0) return 'reserved' // fec0::/10 站点本地（已废弃）
  if (first === 0xff) return 'multicast'
  // 全局单播：只有 2000::/3 放行；其余（含文档 2001:db8::/32）一律拒绝
  if ((first & 0xe0) === 0x20) {
    if (first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return 'reserved'
    return 'public'
  }
  return 'reserved'
}

/** IPv4-mapped（`::ffff:0:0/96`）与 IPv4-compatible（`::/96`）解出内层 IPv4 */
function mappedIpv4Of(bytes: readonly number[]): number[] | undefined {
  const headZero = bytes.slice(0, 10).every((v) => v === 0)
  if (!headZero) return undefined
  const isMapped = bytes[10] === 0xff && bytes[11] === 0xff
  const isCompatible = bytes[10] === 0 && bytes[11] === 0
  if (!isMapped && !isCompatible) return undefined
  const inner = bytes.slice(12)
  if (inner.length !== 4) return undefined
  // `::` 与 `::1` 由 classifyIpv6 处理；`::0.0.0.0` / `::0.0.0.1` 也交给它
  if (isCompatible && inner.every((v) => v === 0)) return undefined
  if (isCompatible && inner.slice(0, 3).every((v) => v === 0) && inner[3] === 1) return undefined
  return inner
}

function ipv4ToBytes(input: string): number[] | undefined {
  const parts = input.split('.')
  if (parts.length !== 4) return undefined
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    bytes.push(value)
  }
  return bytes
}

function ipv6ToBytes(input: string): number[] | undefined {
  const zoneAt = input.indexOf('%')
  const text = zoneAt >= 0 ? input.slice(0, zoneAt) : input
  if (text === '') return undefined
  const firstDoubleColon = text.indexOf('::')
  if (firstDoubleColon >= 0 && text.indexOf('::', firstDoubleColon + 2) >= 0) return undefined
  const hasDoubleColon = firstDoubleColon >= 0
  const left = hasDoubleColon ? text.slice(0, firstDoubleColon) : text
  const right = hasDoubleColon ? text.slice(firstDoubleColon + 2) : ''
  const leftParts = left === '' ? [] : left.split(':')
  const rightParts = right === '' ? [] : right.split(':')
  const flat = hasDoubleColon ? [...leftParts, ...rightParts] : leftParts
  if (flat.length === 0) return hasDoubleColon ? new Array<number>(16).fill(0) : undefined

  const expand = (parts: readonly string[], isRight: boolean): number[] | undefined => {
    const out: number[] = []
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? ''
      if (part === '') return undefined
      const isLastOverall = isRight
        ? index === parts.length - 1
        : !hasDoubleColon && index === parts.length - 1
      if (part.includes('.')) {
        if (!isLastOverall) return undefined
        const v4 = ipv4ToBytes(part)
        if (v4 === undefined) return undefined
        out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0))
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined
      out.push(parseInt(part, 16))
    }
    return out
  }

  const leftGroups = expand(leftParts, false)
  if (leftGroups === undefined) return undefined
  const rightGroups = expand(rightParts, true)
  if (rightGroups === undefined) return undefined
  const missing = 8 - leftGroups.length - rightGroups.length
  if (hasDoubleColon ? missing < 1 : missing !== 0) return undefined
  const groups = [...leftGroups, ...new Array<number>(missing).fill(0), ...rightGroups]
  const bytes: number[] = []
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// ② + ④ 解析与连接端口（可注入；缺省是原生 HTTPS + node:dns）
// ---------------------------------------------------------------------------

/** 解析器端口：只回答"这个主机名解析成哪些地址"（顺序即连接优先级） */
export type WebReadResolver = (host: string) => Promise<readonly string[]>

export interface WebReadConnectRequest {
  /** **已校验并固定**的地址。连接只允许用它，不许再解析 */
  address: string
  family: 4 | 6
  port: number
  /** 原主机名（TLS 的 SNI 与主机名校验对象） */
  servername: string
  /** Host 头（IPv6 带方括号；缺省端口不出现） */
  hostHeader: string
  /** 已编码的 path + query（不含 fragment） */
  path: string
  deadlineAt: number
  now: () => number
}

export interface WebReadConnection {
  status: number
  headers: IncomingHttpHeaders
  /** 原始响应体流（不做解压：本适配器不发 `Accept-Encoding`） */
  body: AsyncIterable<Buffer>
  /** 主动断开（重定向跳、超限、超时都要调它，避免连接泄漏） */
  destroy: () => void
}

export type WebReadConnector = (request: WebReadConnectRequest) => Promise<WebReadConnection>

export interface PinnedHttpsConnectorOptions {
  userAgent?: string
  /**
   * 额外的受信 CA。
   *
   * ⚠️ 它只能**增加**信任（本地夹具的自签证书验收用），**关不掉**校验：
   *    `rejectUnauthorized` 恒为 `true`，`servername` 恒为原主机名。
   *    生产装配不传 ⇒ 用系统信任库。
   */
  trustedCa?: readonly (string | Buffer)[]
}

/**
 * 造出实际交给 `https.request` 的选项 —— **单独导出**是为了让"地址被固定住了"
 * 这件事可以被离线断言，而不是只能靠"看起来对"。
 */
export function buildPinnedHttpsRequestOptions(
  request: WebReadConnectRequest,
  options: PinnedHttpsConnectorOptions = {}
): RequestOptions {
  /*
   * SNI 只在原主机名**不是 IP 字面量**时设置：
   * RFC 6066 不许把 IP 放进 SNI（Node 会给 DEP0123 警告并忽略它），
   * 而 IP 字面量 URL 的正确校验对象就是那个 IP（`host`），
   * 所以此时不设 servername 恰好是"仍然校验"的那条路。
   */
  const servername = isIP(request.servername) === 0 ? request.servername : undefined
  const remaining = Math.max(1, request.deadlineAt - request.now())
  return {
    protocol: 'https:',
    host: request.address,
    family: request.family,
    port: request.port,
    method: 'GET',
    path: request.path,
    ...(servername !== undefined ? { servername } : {}),
    headers: {
      Host: request.hostHeader,
      'User-Agent': options.userAgent ?? DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml;q=0.9',
      // 明确不要压缩：这样"解压后 HTML ≤ 2 MiB"就等于"响应体 ≤ 2 MiB"（不存在解压炸弹）
      'Accept-Encoding': 'identity',
      Connection: 'close',
    },
    rejectUnauthorized: true,
    signal: AbortSignal.timeout(remaining),
    ...(options.trustedCa !== undefined ? { ca: [...options.trustedCa] } : {}),
  }
}

export function createPinnedHttpsConnector(
  options: PinnedHttpsConnectorOptions = {}
): WebReadConnector {
  return async function connect(request: WebReadConnectRequest): Promise<WebReadConnection> {
    const requestOptions = buildPinnedHttpsRequestOptions(request, options)
    return await new Promise<WebReadConnection>((resolve, reject) => {
      let settled = false
      const clientRequest = httpsRequest(requestOptions, (response: IncomingMessage) => {
        settled = true
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response as AsyncIterable<Buffer>,
          destroy: () => {
            response.destroy()
          },
        })
      })
      clientRequest.on('error', (error: Error) => {
        if (settled) return
        settled = true
        reject(error)
      })
      clientRequest.end()
    })
  }
}

/**
 * 缺省解析器：`lookup({ all: true, verbatim: true })`。
 *
 * `all: true` 是**必须**的：只取一个地址就无法履行"逐跳校验**每一个**地址"。
 * `verbatim: true` 保留系统解析顺序（不重排）—— 我们不挑"看起来更公网"的那个，
 * 而是"只要有一个不合格就整跳拒绝"。
 */
export function createSystemResolver(): WebReadResolver {
  return async (host: string): Promise<readonly string[]> => {
    const records = await dnsLookup(host, { all: true, verbatim: true })
    return records.map((record) => record.address)
  }
}

// ---------------------------------------------------------------------------
// ⑤ 有界边读（超过上限立刻中断）
// ---------------------------------------------------------------------------

export interface BoundedReadOptions {
  maxBytes: number
  deadlineAt: number
  now: () => number
  /** 超限/超时时先断开连接（避免继续往管道里灌数据） */
  onOverflow?: () => void
}

/**
 * 流式读取，**边读边数**。
 *
 * ⚠️ 关键性质：超过上限时**立刻**中断，且**不把已经收到的字节留在返回里**
 *    —— "先 buffer 完再看大小"正是这条上限要防的东西（一个 200 MiB 的响应
 *    会先把进程撑爆）。探针用一个 3 MiB 的真实响应体证明请求方在 2 MiB 处
 *    就把它掐断了（服务端写出的字节数远小于 3 MiB）。
 */
export async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  options: BoundedReadOptions
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let received = 0
  try {
    for await (const chunk of body) {
      if (options.now() > options.deadlineAt) {
        options.onOverflow?.()
        throw webReadFailure({
          code: 'timeout',
          reason: 'deadline_exceeded',
          message: `读取正文超过总期限（已收到 ${String(received)} 字节）`,
          details: { stage: 'body', receivedBytes: received, deadlineAt: options.deadlineAt },
        })
      }
      received += chunk.byteLength
      if (received > options.maxBytes) {
        options.onOverflow?.()
        throw webReadFailure({
          code: 'validation_failed',
          reason: 'body_too_large',
          message: `响应体超过 ${String(options.maxBytes)} 字节上限（已收到 ${String(received)} 字节即中断）`,
          details: { maxBytes: options.maxBytes, receivedBytes: received },
        })
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
  } catch (error) {
    if (error instanceof ActionFailureError) throw error
    if (isAbortLike(error)) {
      options.onOverflow?.()
      throw webReadFailure({
        code: 'timeout',
        reason: 'deadline_exceeded',
        message: '读取正文时被总期限中断',
        details: { stage: 'body', receivedBytes: received },
      })
    }
    throw error
  }
  return Buffer.concat(chunks, received)
}

function isAbortLike(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  const name = (error as { name?: unknown }).name
  return code === 'ABORT_ERR' || name === 'AbortError'
}

// ---------------------------------------------------------------------------
// ③ + ⑥ 获取阶段（逐跳准入 / 解析 / 校验 / 固定地址连接）
// ---------------------------------------------------------------------------

export interface WebReadHop {
  url: string
  host: string
  /** 这一跳实际连接的 IP（DNS 校验的输出，不是主机名） */
  address: string
  /** TLS SNI / 主机名校验用的名字（= 原主机名） */
  servername: string
  status: number
  location?: string
}

export interface WebReadFetchRequest {
  /** 已经准入的 URL（获取阶段会对**每一跳**重新准入） */
  url: string
  /** 整次操作的绝对期限（解析 + 所有跳 + 读取共用一个） */
  deadlineAt: number
  maxBytes: number
}

export interface WebReadFetchResult {
  /** 原始响应体字节（**这是 `sourceFingerprint` 的对象**） */
  bytes: Buffer
  finalUrl: string
  finalHost: string
  /** 完整跳链（含每一跳实际连接的地址） */
  hops: readonly WebReadHop[]
  status: number
  contentType?: string
  /** 最终响应头声称的字符集（没有就是 undefined，由 meta 或 utf-8 兜底） */
  declaredCharset?: string
}

/** 测试缝：整段"获取"可以被替换（替换的是 IO，不是准入与上限） */
export type WebReadFetcher = (request: WebReadFetchRequest) => Promise<WebReadFetchResult>

export type WebReadAdmitter = (rawUrl: string) => WebReadUrlAdmission

export interface PinnedHttpsFetcherDeps {
  resolve?: WebReadResolver
  connect?: WebReadConnector
  connectorOptions?: PinnedHttpsConnectorOptions
  now?: () => number
  maxRedirects?: number
  /** ⚠️ 测试缝：只有在验收"本地夹具"时才替换（生产缺省 = `admitWebReadUrl`） */
  admit?: WebReadAdmitter
  /**
   * 第二批：**允许的 content-type 家族**（缺省 = 只认 HTML，逐字不变）。
   *
   * ==========================================================================
   *  为什么必须有这个口子（真模型 live 逼出来的）
   * ==========================================================================
   * `news.read` 复用这同一个受限获取器取 RSS/Atom —— 而真实的订阅源回的是
   * `application/xml` / `application/rss+xml`，被这里"不是 HTML"**在读正文之前**拒掉。
   * 于是**每一个真实订阅源都取不到**，而离线夹具因为替换掉了整个 fetcher
   * （连带这一处 content-type 闸）一个断言都没碰到它。
   *
   * ⚠️ 缺省仍然是 `'html'`：`web.read` 的行为**逐字不变**；
   *    只有资讯那条路显式传 `'xml'`。**不是**把闸放松成"什么都收"。
   */
  contentTypeFamily?: 'html' | 'xml'
}

export function createPinnedHttpsFetcher(deps: PinnedHttpsFetcherDeps = {}): WebReadFetcher {
  const now = deps.now ?? ((): number => Date.now())
  const resolve = deps.resolve ?? createSystemResolver()
  const connect = deps.connect ?? createPinnedHttpsConnector(deps.connectorOptions)
  const maxRedirects = deps.maxRedirects ?? WEB_READ_MAX_REDIRECTS
  const admit = deps.admit ?? admitWebReadUrl

  return async function fetchHtml(request: WebReadFetchRequest): Promise<WebReadFetchResult> {
    const hops: WebReadHop[] = []
    /** 已经跟随过的重定向次数（不是跳数：第一跳不是重定向） */
    let followed = 0
    let current = request.url

    for (;;) {
      // ① 每一跳都重新准入（重定向目标与首个 URL 走同一条路）
      const admitted = admit(current)
      if (!admitted.ok) {
        throw webReadFailure({
          code: 'validation_failed',
          reason: admitted.reason,
          message: `第 ${String(hops.length + 1)} 跳的地址不被接受（${admitted.reason}）：${admitted.detail}`,
          details: { url: admitted.href ?? current, hopIndex: hops.length, hops: summarizeHops(hops) },
        })
      }
      const host = admitted.host

      // ② 自己解析（一次），③ 逐地址校验（**每一个**都必须是公网单播）
      const addresses = admitted.literalAddress !== undefined
        ? [admitted.literalAddress]
        : await withDeadline(resolve(host), request, now, 'resolve', hops)
      if (addresses.length === 0) {
        throw webReadFailure({
          code: 'execution_failed',
          reason: 'dns_no_answer',
          message: `DNS 没有给出任何地址：${host}`,
          details: { stage: 'resolve', host, hopIndex: hops.length, hops: summarizeHops(hops) },
        })
      }
      const classifications = addresses.map((address) => classifyAddress(address))
      const forbidden = classifications.find((entry) => !entry.allowed)
      if (forbidden !== undefined) {
        throw webReadFailure({
          code: 'validation_failed',
          reason: 'forbidden_address',
          message: `解析出的地址属于 ${forbidden.scope}，整跳拒绝（已解析 ${String(addresses.length)} 个地址）：${forbidden.address}`,
          details: {
            stage: 'address',
            host,
            address: forbidden.address,
            scope: forbidden.scope,
            resolvedAddresses: [...addresses],
            hopIndex: hops.length,
            hops: summarizeHops(hops),
          },
        })
      }
      // ④ 连接**已校验的那个地址**（列表顺序即优先级；不重排、不重解析）
      const pinned = classifications[0] as AddressClassification
      const connection = await withDeadline(
        connect({
          address: pinned.address,
          family: pinned.family === 6 ? 6 : 4,
          port: WEB_READ_ALLOWED_PORT,
          servername: host,
          hostHeader: admitted.hostHeader,
          path: `${admitted.url.pathname}${admitted.url.search}`,
          deadlineAt: request.deadlineAt,
          now,
        }),
        request,
        now,
        'connect',
        hops
      )

      const status = connection.status
      const location = headerValue(connection.headers, 'location')
      const isRedirect = REDIRECT_STATUS.has(status)
      hops.push({
        url: admitted.href,
        host,
        address: pinned.address,
        servername: host,
        status,
        ...(location !== undefined ? { location } : {}),
      })

      if (isRedirect) {
        connection.destroy()
        if (location === undefined) {
          throw webReadFailure({
            code: 'validation_failed',
            reason: 'redirect_without_location',
            message: `${String(status)} 重定向没有 Location 头`,
            details: { stage: 'redirect', status, hops: summarizeHops(hops) },
          })
        }
        let next: URL
        try {
          next = new URL(location, admitted.href)
        } catch {
          throw webReadFailure({
            code: 'validation_failed',
            reason: 'bad_redirect_location',
            message: '重定向的 Location 不是合法 URL',
            details: { stage: 'redirect', status, hops: summarizeHops(hops) },
          })
        }
        if (followed >= maxRedirects) {
          throw webReadFailure({
            code: 'validation_failed',
            reason: 'too_many_redirects',
            message: `重定向超过 ${String(maxRedirects)} 次`,
            details: {
              stage: 'redirect',
              maxRedirects,
              followed,
              next: next.href,
              hops: summarizeHops(hops),
            },
          })
        }
        followed += 1
        current = next.href
        continue
      }

      // 非 2xx：不读正文（避免把一个巨大的错误页下回来），状态码原样保留
      if (status < 200 || status >= 300) {
        connection.destroy()
        return {
          bytes: Buffer.alloc(0),
          finalUrl: admitted.href,
          finalHost: host,
          hops,
          status,
          ...(headerValue(connection.headers, 'content-type') !== undefined
            ? { contentType: headerValue(connection.headers, 'content-type') as string }
            : {}),
        }
      }

      /*
       * content-type 在**读正文之前**检查：一个 `video/mp4` 的 2xx 不该被下载。
       * 缺省 content-type 也失败关闭 —— 不然"没声明"就等价于"随便什么都能读"。
       */
      const rawContentType = headerValue(connection.headers, 'content-type')
      const typeCheck =
        (deps.contentTypeFamily ?? 'html') === 'xml'
          ? checkXmlContentType(rawContentType)
          : checkHtmlContentType(rawContentType)
      if (!typeCheck.ok) {
        connection.destroy()
        throw webReadFailure({
          code: 'validation_failed',
          reason: typeCheck.reason,
          message: typeCheck.detail,
          details: {
            stage: 'content-type',
            contentType: rawContentType ?? null,
            hops: summarizeHops(hops),
          },
        })
      }

      /*
       * 压缩要**明说**再拒。
       *
       * 本适配器请求时不发 `Accept-Encoding: gzip`（只发 `identity`），因此
       * "解压后 HTML ≤ 2 MiB"就等于"响应体 ≤ 2 MiB"（不存在解压炸弹）。
       * 但服务器**可以**不请自来地压缩：那种字节喂给 jsdom 只会得到一片乱码，
       * 最终以"这个地址上没有正文"收场 —— 那是个**误导**的失败。所以这里把它
       * 明说成 `unsupported_content_encoding`：不猜、不解压、也不假装读到了。
       */
      const contentEncoding = headerValue(connection.headers, 'content-encoding')
      const encoding = contentEncoding?.trim().toLowerCase()
      if (encoding !== undefined && encoding !== '' && encoding !== 'identity') {
        connection.destroy()
        throw webReadFailure({
          code: 'validation_failed',
          reason: 'unsupported_content_encoding',
          message: `响应声明了 Content-Encoding: ${encoding}，而 web.read 只处理未压缩的响应`,
          details: { stage: 'content-encoding', contentEncoding: encoding, hops: summarizeHops(hops) },
        })
      }

      const bytes = await readBoundedBody(connection.body, {
        maxBytes: request.maxBytes,
        deadlineAt: request.deadlineAt,
        now,
        onOverflow: () => {
          connection.destroy()
        },
      })

      return {
        bytes,
        finalUrl: admitted.href,
        finalHost: host,
        hops,
        status,
        contentType: typeCheck.mediaType,
        ...(typeCheck.charset !== undefined ? { declaredCharset: typeCheck.charset } : {}),
      }
    }
  }
}

function summarizeHops(hops: readonly WebReadHop[]): readonly Record<string, unknown>[] {
  return hops.map((hop) => ({
    url: hop.url,
    host: hop.host,
    address: hop.address,
    status: hop.status,
  }))
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name]
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && raw.length > 0) return raw[0]
  return undefined
}

/** 解析 `content-type: text/html; charset=UTF-8`（只认这两种 HTML 媒体类型） */
export function checkHtmlContentType(rawContentType: string | undefined):
  | { ok: true; mediaType: string; charset?: string }
  | { ok: false; reason: 'missing_content_type' | 'unsupported_content_type'; detail: string } {
  if (rawContentType === undefined || rawContentType.trim() === '') {
    return {
      ok: false,
      reason: 'missing_content_type',
      detail: '响应没有声明 content-type，按"不是 HTML"失败关闭',
    }
  }
  const [rawMedia = '', ...parameters] = rawContentType.split(';')
  const mediaType = rawMedia.trim().toLowerCase()
  if (!HTML_MEDIA_TYPES.has(mediaType)) {
    return {
      ok: false,
      reason: 'unsupported_content_type',
      detail: `content-type 不是 HTML（${mediaType === '' ? '(空)' : mediaType}）`,
    }
  }
  let charset: string | undefined
  for (const parameter of parameters) {
    const [key = '', value = ''] = parameter.split('=')
    if (key.trim().toLowerCase() === 'charset') {
      const cleaned = value.trim().replace(/^["']|["']$/g, '').toLowerCase()
      if (cleaned !== '') charset = cleaned
    }
  }
  return charset === undefined ? { ok: true, mediaType } : { ok: true, mediaType, charset }
}

/**
 * **XML 家族**的 content-type 闸（第二批：`news.read` 用）。
 *
 * ⚠️ 缺省（`web.read`）走的仍然是上面的 `checkHtmlContentType` —— 一个字都没改。
 *    这一份是**另一个家族**的白名单，不是"放松"：
 * ```text
 * application/xml        text/xml
 * application/rss+xml    application/atom+xml
 * application/rdf+xml    text/rss+xml
 * ```
 * 缺 content-type 或家族之外（例如 `text/html`、`video/mp4`）**照样失败关闭**。
 */
const XML_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
  'text/rss+xml',
])

export function checkXmlContentType(
  rawContentType: string | undefined
):
  | { ok: true; mediaType: string; charset?: string }
  | { ok: false; reason: string; detail: string } {
  if (rawContentType === undefined || rawContentType.trim() === '') {
    return {
      ok: false,
      reason: 'missing_content_type',
      detail: '响应没有声明 content-type，按"不是 XML"失败关闭',
    }
  }
  const [rawMedia = '', ...parameters] = rawContentType.split(';')
  const mediaType = rawMedia.trim().toLowerCase()
  if (!XML_MEDIA_TYPES.has(mediaType)) {
    return {
      ok: false,
      reason: 'unsupported_content_type',
      detail: `content-type 不是 XML 家族（${mediaType === '' ? '(空)' : mediaType}）`,
    }
  }
  let charset: string | undefined
  for (const parameter of parameters) {
    const [key = '', value = ''] = parameter.split('=')
    if (key.trim().toLowerCase() === 'charset') {
      const cleaned = value.trim().replace(/^["']|["']$/g, '').toLowerCase()
      if (cleaned !== '') charset = cleaned
    }
  }
  return charset === undefined ? { ok: true, mediaType } : { ok: true, mediaType, charset }
}

/**
 * 总期限的统一实现。
 *
 * 四条性质：
 * · 每一个 `await`（解析 / 连接）都在同一个 `deadlineAt` 之下，重定向跳**共享**它；
 * · 超时抛 `timeout`（不是 execution_failed）—— "没在期限内回来"是独立的事实；
 * · **工作自身的失败原样传播**（`ENOTFOUND` 不是超时！把 DNS 失败说成超时会让
 *   用户与运维去查网络的另一头。这条是实测发现的：`withDeadline` 原本把
 *   "计时器赢了"与"工作拒绝了"混成同一个形状）；
 * · `then/catch` 包一层，避免"计时器赢了之后原 promise 才拒绝"变成
 *   unhandled rejection（那会让进程在别处炸掉，很难归因）。
 */
async function withDeadline<T>(
  work: Promise<T>,
  request: WebReadFetchRequest,
  now: () => number,
  stage: 'resolve' | 'connect',
  hops: readonly WebReadHop[]
): Promise<T> {
  const remaining = request.deadlineAt - now()
  if (remaining <= 0) {
    throw webReadFailure({
      code: 'timeout',
      reason: 'deadline_exceeded',
      message: `总期限已用尽，无法开始 ${stage}`,
      details: { stage, hopIndex: hops.length, hops: summarizeHops(hops) },
    })
  }
  const settled = work.then(
    (value) => ({ kind: 'ok' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error })
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout' })
    }, remaining)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    const result = await Promise.race([settled, timeout])
    if (result.kind === 'ok') return result.value
    // 工作自己的失败（DNS 查不到 / 连接被拒 / 证书不匹配）原样交给上层归一
    if (result.kind === 'error') throw result.error
    throw webReadFailure({
      code: 'timeout',
      reason: 'deadline_exceeded',
      message: `${stage} 超过总期限（${String(remaining)} ms 内没有回来）`,
      details: { stage, hopIndex: hops.length, hops: summarizeHops(hops) },
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// ⑥ 正文提取（jsdom 默认选项 + Readability）—— 懒加载，缺省关闭时不加载重依赖
// ---------------------------------------------------------------------------

export interface WebReadExtraction {
  ok: boolean
  reason?: 'article_not_extractable' | 'dom_element_limit_exceeded'
  title?: string
  /** 归一化之后的正文（**可能为空**；空也走失败关闭） */
  text: string
  /** 归一化后、**截断前**的完整正文 */
  fullText: string
  domElementCount: number
  /** jsdom 自己报出来的解析期错误（**只是计数，不是正文**） */
  jsdomErrorCount: number
}

export interface WebReadExtractionOptions {
  maxDomElements?: number
}

/** Readability 解析结果里我们真正消费的那两个字段（结构类型，不引入上游类型） */
interface ReadabilityArticle {
  title?: string | null
  textContent?: string | null
}

/**
 * 只提供正文文字：`new JSDOM(html)` + `Readability.parse()`。
 *
 * 四条纪律（逐条对应计划书 §3.1）：
 * · **不用 `JSDOM.fromURL()`**：字节由我们自己取回来（上游已经是受控获取）。
 * · **不启用脚本**：`runScripts` 缺省 ⇒ 页面里的脚本一个字都不执行。
 * · **不加载子资源**：`resources` 缺省 ⇒ 不发子请求（jsdom 30 的 `loadSubresources` 为 false）。
 * · **重依赖懒加载**：jsdom / Readability 走动态 `import()`，于是"能力关闭时
 *   不加载组件"这条边界在模块层面也成立（顶层只有 `node:*`）。
 *
 * ⚠️ 一个 `VirtualConsole` 是唯一传进去的选项：它**既不开脚本也不开子资源**，
 *    作用只是把"不可信 HTML 触发的解析期噪音"截在内存里（不让它喷到生产日志），
 *    同时把条数记成事实。默认选项的那两条性质由探针的 A/B 读数守住。
 */
export async function extractArticle(
  html: string,
  options: WebReadExtractionOptions = {}
): Promise<WebReadExtraction> {
  const maxDomElements = options.maxDomElements ?? WEB_READ_MAX_DOM_ELEMENTS
  const [{ JSDOM, VirtualConsole }, { Readability }] = await Promise.all([
    import('jsdom'),
    import('@mozilla/readability'),
  ])

  let jsdomErrorCount = 0
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', () => {
    jsdomErrorCount += 1
  })

  const dom = new JSDOM(html, { virtualConsole })
  const document = dom.window.document
  const domElementCount = document.getElementsByTagName('*').length

  const empty = (reason: WebReadExtraction['reason']): WebReadExtraction => ({
    ok: false,
    ...(reason !== undefined ? { reason } : {}),
    text: '',
    fullText: '',
    domElementCount,
    jsdomErrorCount,
  })

  if (domElementCount > maxDomElements) return empty('dom_element_limit_exceeded')

  /*
   * 只取真正用得到的两个字段（`title` / `textContent`）：Readability 的返回是
   * `null | {...}` 联合，这里用一个结构类型接住，避免把上游类型铺到本模块的 API 上。
   */
  let parsed: ReadabilityArticle | null = null
  try {
    parsed = new Readability(document).parse()
  } catch {
    return empty('article_not_extractable')
  }
  if (parsed === null || parsed === undefined) return empty('article_not_extractable')

  const rawText = typeof parsed.textContent === 'string' ? parsed.textContent : ''
  const fullText = normalizeArticleText(rawText)
  if (fullText.trim() === '') return empty('article_not_extractable')

  const title = typeof parsed.title === 'string' && parsed.title.trim() !== '' ? parsed.title.trim() : undefined
  return {
    ok: true,
    ...(title !== undefined ? { title } : {}),
    text: fullText,
    fullText,
    domElementCount,
    jsdomErrorCount,
  }
}

/**
 * 正文归一：逐行去掉缩进、丢掉空行，行内多余空白压成一个空格。
 *
 * ⚠️ 它改变的是**排版**，不是内容：探针断言已知句子与数字在归一前后都还在
 *    （Readability 的 `textContent` 带大量缩进，直接送进预算等于把额度花在空格上）。
 */
export function normalizeArticleText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t\u00a0\u3000 ]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim()
}

/**
 * 截断到当轮内容上限，**不切开代理对**。
 *
 * （`text.length` 是 UTF-16 码元数，在 `max-1` 处切下去可能留下一个孤立代理项；
 *   契约要求 `scope.includedChars === text.length`，所以"切在哪儿"必须是确定的。）
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.charCodeAt(maxChars - 1)
  const cut = head >= 0xd800 && head <= 0xdbff ? maxChars - 1 : maxChars
  return text.slice(0, cut)
}

// ---------------------------------------------------------------------------
// 字符集（响应头 → meta → utf-8）
// ---------------------------------------------------------------------------

export interface DecodedHtml {
  html: string
  charset: string
  charsetSource: 'header' | 'meta' | 'default'
}

const CHARSET_ALIASES: Record<string, string> = {
  'utf8': 'utf-8',
  'utf-8': 'utf-8',
  'gb2312': 'gbk',
  'gb_2312-80': 'gbk',
  'x-gbk': 'gbk',
  'gb18030': 'gb18030',
  'big5': 'big5',
  'shift_jis': 'shift_jis',
  'sjis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'iso-8859-1': 'windows-1252',
  'ascii': 'utf-8',
}

/** 从响应头或 HTML 头部 `<meta charset>` 决定怎么解码（决定不了就 utf-8） */
export function decodeHtml(bytes: Buffer, declaredCharset?: string): DecodedHtml {
  let charset = declaredCharset?.trim().toLowerCase()
  let charsetSource: DecodedHtml['charsetSource'] = 'header'
  if (charset === undefined || charset === '') {
    const sniff = bytes.subarray(0, 2048).toString('latin1')
    const match = /charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(sniff)
    if (match !== null && match[1] !== undefined) {
      charset = match[1].toLowerCase()
      charsetSource = 'meta'
    }
  }
  if (charset === undefined || charset === '') {
    return { html: bytes.toString('utf8'), charset: 'utf-8', charsetSource: 'default' }
  }
  const canonical = CHARSET_ALIASES[charset] ?? charset
  try {
    const decoder = new TextDecoder(canonical, { fatal: false })
    return { html: decoder.decode(bytes), charset: canonical, charsetSource }
  } catch {
    // 解码器不认识这个字符集名 ⇒ 退回 utf-8，并**如实**说清用了哪个
    return { html: bytes.toString('utf8'), charset: 'utf-8', charsetSource }
  }
}

// ---------------------------------------------------------------------------
// 失败构造（唯一入口）
// ---------------------------------------------------------------------------

function webReadFailure(input: {
  code: ActionFailureCode
  reason: string
  message: string
  details?: Record<string, unknown>
}): ActionFailureError {
  return new ActionFailureError(
    actionFailure(input.code, input.message, {
      capability: WEB_READ,
      operation: WEB_READ_OPERATION,
      reason: input.reason,
      ...(input.details ?? {}),
    })
  )
}

function sha256Hex(material: Buffer | string): string {
  return createHash('sha256').update(material).digest('hex')
}

/**
 * 失败码映射的唯一实现（准入 / 限制 / 重定向三组）。
 *
 * ⚠️ 刻意**不**用 `permission_denied`：`turn-content-reply.ts` 把它读成
 *    "这项能力没有启用"，而"拒绝连接一个私网地址"并不是没启用（见文件头）。
 */
export function webReadFailureCodeFor(input: {
  kind: 'admission' | 'limit' | 'redirect'
}): ActionFailureCode {
  switch (input.kind) {
    case 'admission':
    case 'limit':
    case 'redirect':
      return 'validation_failed'
  }
}

// ---------------------------------------------------------------------------
// 适配器本体
// ---------------------------------------------------------------------------

export interface WebReadAdapterOptions {
  /** 测试缝：整段"获取"可替换（准入、上限、提取仍在适配器里，替换不掉） */
  fetchHtml?: WebReadFetcher
  /** 注入时钟（只用于 15 秒总期限；`fetchedAt` 用 `input.now()`） */
  now?: () => number
  totalTimeoutMs?: number
  maxBytes?: number
  maxDomElements?: number
  maxRedirects?: number
  /** 以下四项只在**没有**注入 `fetchHtml` 时用于构造缺省获取器 */
  resolve?: WebReadResolver
  connect?: WebReadConnector
  connectorOptions?: PinnedHttpsConnectorOptions
}

/**
 * 造出 `web.read` 的适配器。
 *
 * 与既有适配器同形：`capabilityId` 固定、失败一律 `ActionFailureError`、
 * 成功时填 `effect` / `evidence`，并且（只有四项实用能力才有的）
 * `turnContent` —— 含正文的**当轮内存载体**。
 */
export function createWebReadAdapter(options: WebReadAdapterOptions = {}): CapabilityAdapter {
  const now = options.now ?? ((): number => Date.now())
  const totalTimeoutMs = options.totalTimeoutMs ?? WEB_READ_TOTAL_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? WEB_READ_MAX_BYTES
  const maxDomElements = options.maxDomElements ?? WEB_READ_MAX_DOM_ELEMENTS
  const fetchHtml =
    options.fetchHtml ??
    createPinnedHttpsFetcher({
      now,
      ...(options.resolve !== undefined ? { resolve: options.resolve } : {}),
      ...(options.connect !== undefined ? { connect: options.connect } : {}),
      ...(options.connectorOptions !== undefined ? { connectorOptions: options.connectorOptions } : {}),
      ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
    })

  return {
    capabilityId: WEB_READ,

    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const deadlineAt = now() + totalTimeoutMs
      const rawUrl = requestedUrl(input)
      if (rawUrl === undefined) {
        throw webReadFailure({
          code: 'validation_failed',
          reason: 'missing_url',
          message: 'web.read 没有拿到 URL（参数里既没有 url 也没有 href，目标里也没有）',
        })
      }

      // ① 首个 URL 先准入一次：越界永远不会变成一次出站
      const admitted = admitWebReadUrl(rawUrl)
      if (!admitted.ok) {
        throw webReadFailure({
          // 准入失败 → validation_failed（**不是** permission_denied，见文件头）
          code: webReadFailureCodeFor({ kind: 'admission' }),
          reason: admitted.reason,
          message: `这个地址不能被读取（${admitted.reason}）：${admitted.detail}`,
          details: { url: admitted.href ?? rawUrl, stage: 'admission' },
        })
      }

      // ② 有界获取（内部对**每一跳**重新准入 / 解析 / 校验 / 固定地址连接）
      const fetched = await fetchHtml({ url: admitted.href, deadlineAt, maxBytes })

      // ③ 上游状态码（**原样保留**，让用户能分辨 404 与 500）
      if (fetched.status < 200 || fetched.status >= 300) {
        const notFound = fetched.status === 404 || fetched.status === 410
        throw webReadFailure({
          code: notFound ? 'target_not_found' : 'execution_failed',
          reason: 'http_status',
          message: `上游返回 HTTP ${String(fetched.status)}`,
          details: {
            stage: 'status',
            httpStatus: fetched.status,
            finalUrl: fetched.finalUrl,
            hopCount: fetched.hops.length,
            hops: summarizeHops(fetched.hops),
          },
        })
      }

      // ④ content-type：测试缝也绕不过这一道
      const typeCheck = checkHtmlContentType(fetched.contentType)
      if (!typeCheck.ok) {
        throw webReadFailure({
          code: 'validation_failed',
          reason: typeCheck.reason,
          message: typeCheck.detail,
          details: { stage: 'content-type', contentType: fetched.contentType ?? null, finalUrl: fetched.finalUrl },
        })
      }

      // ⑤ 解码 + 提取
      const decoded = decodeHtml(fetched.bytes, fetched.declaredCharset ?? typeCheck.charset)
      const extraction = await extractArticle(decoded.html, { maxDomElements })
      if (!extraction.ok) {
        const limitExceeded = extraction.reason === 'dom_element_limit_exceeded'
        throw webReadFailure({
          code: limitExceeded ? 'validation_failed' : 'target_not_found',
          reason: extraction.reason ?? 'article_not_extractable',
          message: limitExceeded
            ? `DOM 元素 ${String(extraction.domElementCount)} 个，超过上限 ${String(maxDomElements)}`
            : '这个地址上没有可取的文章正文（动态空壳页 / 无正文）',
          details: {
            stage: 'extract',
            finalUrl: fetched.finalUrl,
            domElementCount: extraction.domElementCount,
            maxDomElements,
            htmlBytes: fetched.bytes.byteLength,
            jsdomErrorCount: extraction.jsdomErrorCount,
            hopCount: fetched.hops.length,
          },
        })
      }

      // ⑥ 组装当轮内容（正文只在这里，账本/trace 只拿引用）
      const fetchedAt = input.now()
      const fullText = extraction.fullText
      const text = truncateText(fullText, TURN_CONTENT_LIMITS.maxTextChars)
      const includedChars = text.length
      const totalChars = fullText.length
      const truncated = totalChars > includedChars
      const resultFingerprint = sha256Hex(text)
      const sourceFingerprint = sha256Hex(fetched.bytes)
      const redirects = Math.max(0, fetched.hops.length - 1)
      const textBytes = Buffer.byteLength(text, 'utf8')
      const finalHost = fetched.finalHost

      const facts: readonly string[] = [
        `最终地址 ${fetched.finalUrl}`,
        `重定向 ${String(redirects)} 次（共 ${String(fetched.hops.length)} 跳）`,
        `正文 ${String(includedChars)} 字符（UTF-8 ${String(textBytes)} 字节）` +
          (truncated ? `，原文 ${String(totalChars)} 字符，已截断到上限 ${String(TURN_CONTENT_LIMITS.maxTextChars)}` : ''),
        `DOM 元素 ${String(extraction.domElementCount)} 个（上限 ${String(maxDomElements)}）`,
        `获取时间 ${new Date(fetchedAt).toISOString()}`,
        extraction.title !== undefined ? 'Readability 给出了标题' : 'Readability 未给出标题',
        `字符集 ${decoded.charset}（来源：${decoded.charsetSource}）`,
      ]

      const turnContent: WebArticleTurnContent = {
        contentId: `${String(input.actionId)}:web-article`,
        kind: 'web-article',
        capability: WEB_READ,
        operation: WEB_READ_OPERATION,
        sourceKind: 'remote-article',
        resourceRef: fetched.finalUrl,
        sourceFingerprint,
        resultFingerprint,
        scope: { totalChars, includedChars, truncated },
        facts,
        text,
        finalUrl: fetched.finalUrl,
        ...(extraction.title !== undefined ? { title: extraction.title } : {}),
        fetchedAt,
      }

      const evidence: ActionEvidence[] = [
        {
          kind: 'adapter',
          detail: `web.read ${finalHost} ${String(includedChars)} chars`,
          ref: fetched.finalUrl,
        },
      ]

      return {
        effect: {
          kind: 'content_read',
          detail: `读取 ${finalHost} 正文（${String(includedChars)} 字符，${String(fetched.hops.length)} 跳）`,
          fingerprint: resultFingerprint,
          // 计划书 §3.1 的口径：这里是**实际取得的正文字符数**（UTF-8 字节数在上面的事实里）
          bytes: includedChars,
        },
        evidence,
        turnContent: [turnContent],
      }
    },
  }
}

function requestedUrl(input: AdapterExecuteInput): string | undefined {
  const fromArgs = stringArg(input.args, 'url') ?? stringArg(input.args, 'href')
  if (fromArgs !== undefined && fromArgs.trim() !== '') return fromArgs.trim()
  const canonical = input.target.canonicalId
  if (canonical !== undefined && canonical.trim() !== '') return canonical.trim()
  const display = input.target.displayName
  if (display !== undefined && display.trim() !== '') return display.trim()
  return undefined
}
