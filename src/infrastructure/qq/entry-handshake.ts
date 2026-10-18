/**
 * 入口握手（`LG_ENTRY <token>`）的**定时安全**校验。
 *
 * ============================================================================
 *  2026-10-17 · 服务器部署 · 远程执行缺口 2/4「应用层鉴权」
 * ============================================================================
 *
 * 改之前（`src/main.ts` 的握手那三行）：
 *
 * ```ts
 * const hello = await reader.next()
 * if (hello === undefined || hello.trim() !== `LG_ENTRY ${spec.token}`) {
 *   socket.write('LG_ENTRY_REJECTED invalid_handshake\n')
 *   socket.destroy()
 *   return
 * }
 * ```
 *
 * ⚠️ **那不是"弱"，是判据错位**：这一行原本是给**同机 loopback** 入口用的，
 *    那里 `!==` 的时间差没有任何可利用面。搬去服务器、跨 SSH 隧道之后，
 *    "本机可信"这个前提**不成立了**，但判据还停在原来那档。
 *
 * -------------------------------------------------------------------------
 *  为什么用「摘要后比」而不是「先判长度再 timingSafeEqual」
 * -------------------------------------------------------------------------
 *  `auth.ts:143` 用的是「先判长度、再 `timingSafeEqual`」——那会**泄露长度**。
 * 这里再进一步：**两边各取 SHA-256 摘要再比**，于是
 *
 *   · 长度**也不泄露**（摘要恒为 32 字节）
 *   · 不受 `timingSafeEqual` 的等长前提约束
 *   · 单次 `timingSafeEqual` 就是全部比较，没有早退分支
 *
 * ⚠️ **不扩大主张**：传输本身已经由 SSH 隧道加密；这一条是**纵深**，
 *    不是"原来有洞现在补上了"。
 *
 * -------------------------------------------------------------------------
 *  失败关闭的形状（与既有纪律一致）
 * -------------------------------------------------------------------------
 *  「形状不合法」与「token 不符」**对外同形**：都是 `invalid_handshake`。
 *  分开报就等于给攻击者一个"我猜对了长度/格式没有"的信道。
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** 握手的固定前缀。载荷里**没有**字段能选入口 —— 入口身份由监听端口绑定（ADR-109 `D02`）。 */
export const ENTRY_HANDSHAKE_PREFIX = 'LG_ENTRY '

export const ENTRY_HANDSHAKE_REJECT = 'LG_ENTRY_REJECTED invalid_handshake\n'

/**
 * 版本不符时的**专用**回执（ADR-146 `D07`）。
 *
 * ⚠️ 与 `invalid_handshake` 分开是刻意的，而且是**反常理**的那一侧：
 *    §D06 那条"失败必须同形"针对的是**token**，因为 token 是秘密。
 *    版本号**不是秘密** —— 对端本来就知道自己在讲第几版。
 *    把版本不符说成"token 不对"，只会让人去查一个根本没问题的 token。
 *    ⇒ 判据按"信息是否敏感"分，而不是一律同形。
 */
export const ENTRY_VERSION_REJECT = 'LG_ENTRY_REJECTED protocol_version_unsupported\n'

/** 本实现接受的协议**主**版本（`REMOTE_EXECUTION_PROTOCOL`，ADR-146 `D07`） */
export const ENTRY_PROTOCOL_VERSION = 1

export type EntryHandshakeVerdict =
  | { ok: true; readonly entry: string; readonly version: number }
  | {
      readonly ok: false
      readonly code: 'empty' | 'malformed' | 'token_mismatch' | 'version_missing' | 'version_unsupported'
      /** 版本类失败才带这个（对外回 `ENTRY_VERSION_REJECT`） */
      readonly version?: number
    }

/** 定长摘要：把「可能长短不一的 token」压成恒定 32 字节后才比 */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * 校验一行握手。
 *
 * ⚠️ **只有 `code` 可用于日志/读数**，`token_mismatch` 不得回给对端 ——
 *    后者回的是 `ENTRY_HANDSHAKE_REJECT`（与 `malformed` / `empty` 同形）。
 *    版本类失败回 `ENTRY_VERSION_REJECT`（见上）。
 */
export function verifyEntryHandshake(line: string | undefined, expectedToken: string): EntryHandshakeVerdict {
  if (line === undefined) return { ok: false, code: 'empty' }
  const trimmed = line.trim()
  if (trimmed === '') return { ok: false, code: 'empty' }
  if (!trimmed.startsWith(ENTRY_HANDSHAKE_PREFIX)) return { ok: false, code: 'malformed' }

  // 尾��是可选的 `v<主版本>`
  const rest = trimmed.slice(ENTRY_HANDSHAKE_PREFIX.length)
  const parts = rest.split(' ')
  const presented = parts[0] ?? ''
  const versionTag = parts.length > 1 ? parts[parts.length - 1] ?? '' : ''

  // 空 token 要在这里就被拒，不靠下面的比较（摘要比较对空串同样"通过"不了，
  // 但提前拒能让「对端根本没发 token」与「发了错 token」不落到同一条路径上）。
  if (presented === '' || expectedToken === '') return { ok: false, code: 'token_mismatch' }

  const matched = timingSafeEqual(digest(presented), digest(expectedToken))
  if (!matched) return { ok: false, code: 'token_mismatch' }

  /*
   * ⚠️ token 对了才轮到版本 —— 顺序不能反。
   *    反过来的话，"版本不对"就成了一个**不需要知道 token 就能问出来**的 oracle。
   */
  if (versionTag === '') return { ok: false, code: 'version_missing' }
  const major = /^v(\d+)$/.exec(versionTag)
  if (major === null) return { ok: false, code: 'version_missing' }
  const version = Number(major[1])
  if (!Number.isInteger(version) || version !== ENTRY_PROTOCOL_VERSION) {
    return { ok: false, code: 'version_unsupported', version }
  }

  return { ok: true, entry: 'accepted', version }
}
