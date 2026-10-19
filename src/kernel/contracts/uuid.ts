/**
 * `stringToUuid` 的本地实现 —— 从 ElizaOS 独立出来的确定性 UUID。
 *
 * ============================================================================
 *  为什么必须**逐字节一致**（这是本文件唯一的硬要求）
 * ============================================================================
 * 它不是"随便生成一个 id"：M1/M2 起，`user-Alex`、`agent-entity-苏沐薇`、
 * `world-...`、`room-dm-...`、`msg-{room}-{turn}-user` 这些**全部**由它推导，
 * 并已写进生产库的 `memories` / `participants` / `conversation_events`。
 * 一旦算法差一位 ⇒ 同一个人算出不同 id ⇒ **记忆读不出来**。
 *
 * ============================================================================
 *  上游算法（`@elizaos/core@1.7.2` dist/node/index.node.js:45392-45408）
 * ============================================================================
 * ```js
 * if (typeof target === 'number') target = target.toString()
 * if (typeof target !== 'string') throw TypeError('Value must be string')
 * const maybeUuid = validateUuid(target); if (maybeUuid) return maybeUuid  // 已是合法 UUID ⇒ 原样返回
 * const escapedStr = encodeURIComponent(target)
 * const digest = sha1(escapedStr)
 * const bytes = digest.slice(0, 16)
 * bytes[8]  = bytes[8]  & 63 | 128   // 变体位（10xx）
 * bytes[6]  = bytes[6]  & 15 | 0     // 低 4 位清零（**注意：不是设成 5**）
 * return bytesToUuid(bytes)
 * ```
 *
 * ⚠️⚠️ **上游把版本位清成 0，不是设成 5（UUIDv5）**。第一版我照"标准 v5"写成
 *   `bytes[6] & 0x0f | 0x50` ⇒ 实测 21 个用例**全部**不一致：
 *   `user-Alex` 上游给 `b8ec0760-c90c-0cd1-…`，我给 `…-5cd1-…`。
 *   若不比对就上线 ⇒ **每一个 user/room/world/msg id 都会变** ⇒ 记忆读不出来。
 *   ⇒ 这就是那道逐值比对门存在的理由（`scripts/thinhost-uuid-parity.ts`）。
 *
 * ⚠️ `validateUuid` 的短路很关键：传入**已经是合法 UUID** 时**原样返回**，
 *    不再哈希。`room-${this.ids.userId}` 这类拼接就会走到这条分支
 *    —— 所以这一条必须实现，否则行为不同。
 */

import { createHash } from 'node:crypto'

/** 合法 UUID 的判据（v1–v8，8-4-4-4-12，十六进制，大小写皆可） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 已带连字符的 32 位十六进制是否合法？（与 UUID_RE 等价，仅供性能路径） */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * 返回类型刻意用**模板字面量**，与上游 `stringToUuid` 的声明同形。
 *
 * ⚠️ 这不是洁癖：调用点大量写 `stringToUuid(...) as UUID`，
 *    若这里返回宽泛的 `string`，那些 `as UUID` 之外的**直接赋值**
 *    （例如 `userEntityId: stringToUuid(...)`）就会因为类型不匹配而编译失败 ——
 *    而"改类型让编译过"很容易顺手把值也改掉。
 *    保持同形 ⇒ 调用点一行不用动。
 */
export type UuidString = `${string}-${string}-${string}-${string}-${string}`

export function stringToUuid(target: string | number): UuidString {
  const value = typeof target === 'number' ? target.toString() : target
  if (typeof value !== 'string') {
    throw new TypeError('Value must be string')
  }
  // ⚠️ 短路必须与上游同形：已经是合法 UUID 就原样返回，**不再哈希**。
  if (UUID_RE.test(value)) return value as UuidString

  const escaped = encodeURIComponent(value)
  const digest = createHash('sha1').update(escaped).digest()
  const bytes = digest.subarray(0, 16)

  const b = new Uint8Array(16)
  b.set(bytes)
  b[8] = (b[8]! & 0x3f) | 0x80 // 变体位 10xx
  // ⚠️⚠️ 上游是 `& 0x0f | 0x00`（**清零**，不是设成版本 5）。
  //    与上游逐值比对证明：设成 0x50 会让全部 id 变化 ⇒ 记忆读不出来。
  b[6] = b[6]! & 0x0f

  const hex: string[] = []
  for (const byte of b) hex.push(byte.toString(16).padStart(2, '0'))
  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-` +
    `${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  ) as UuidString
}
