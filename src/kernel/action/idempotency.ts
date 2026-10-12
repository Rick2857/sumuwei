/**
 * Idempotency —— **重复请求不产生第二次副作用**（M4.5 §26 / INV-M45-02）。
 *
 * ============================================================================
 *  键必须由**请求的语义**决定，而不是由时间或随机数决定
 * ============================================================================
 * 未来 Agent 最大的风险之一是"重试 → 重复执行"。要让重试安全，
 * 两次请求必须算得出**同一个键**：
 *
 * ```text
 * key = capability + operation + 已解析目标 + 参数（稳定序列化）
 * ```
 *
 * ⚠️ 刻意**不**用随机 id、也不用 `Date.now()`：那会让每次重试都是新键，
 *    于是幂等表永远不会命中 —— "有幂等机制"变成一句空话。
 *
 * ⚠️ 也刻意**不** import `node:crypto`：`src/kernel/**` 不允许依赖 Node
 *    内置模块（与种子指纹 `infrastructure/persistence/seed-hash.ts` 不同，
 *    那是基础设施层）。内联 FNV-1a 64 位足够：这里的碰撞后果是
 *    "两次不同的写被当成同一次"，而请求里已经带上目标与内容，
 *    真正不同的请求在规范化文本上就不可能相同。
 */

import type { ActionRequest } from './action-request.ts'

/**
 * 稳定序列化：对象键排序、数组保序、`undefined` 显式区分。
 *
 * 与 `scripts/m4-harness.ts` 的 `stableStringify` 是同一种做法，
 * 但这里必须**自持**（kernel 不能 import scripts）。
 */
export function stableSerialize(value: unknown): string {
  if (value === undefined) return '__undefined__'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const keys = Object.keys(source).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(source[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** FNV-1a 64 位（纯 TS，确定性，无 Node 依赖） */
export function fnv1a64Hex(text: string): string {
  const PRIME = 1099511628211n
  const OFFSET = 14695981039346656037n
  const MASK = (1n << 64n) - 1n
  let hash = OFFSET
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * PRIME) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}

export interface IdempotencyKeyInput {
  capability: string
  operation: string
  /** 已解析目标的稳定标识（`canonicalId`）。没有目标时用 `-` */
  targetId?: string
  /** 请求参数 */
  args: Record<string, unknown>
  /** 请求方显式给的键（优先） */
  provided?: string
}

/**
 * 推导幂等键。
 *
 * 显式提供的键**原样使用**（它就是调用方在表达"这两次是同一次操作"）；
 * 否则按语义推导。
 */
export function actionIdempotencyKey(input: IdempotencyKeyInput): string {
  if (input.provided !== undefined && input.provided.trim() !== '') return input.provided
  const material = stableSerialize({
    capability: input.capability,
    operation: input.operation,
    target: input.targetId ?? '-',
    args: input.args,
  })
  return `idem:${input.capability}:${fnv1a64Hex(material)}`
}

/**
 * 这次请求在幂等语义上要不要检查历史。
 *
 * ```text
 * none      —— 不检查（回声这类无副作用的能力）
 * supported —— 检查；键由语义推导，命中则重放
 * required  —— 检查；且请求必须显式带键（否则策略拒绝）
 * ```
 */
export function shouldCheckIdempotency(idempotency: 'none' | 'supported' | 'required'): boolean {
  return idempotency !== 'none'
}

/** 供账本记录：这次请求用的键是不是请求方显式给的 */
export function isExplicitKey(request: ActionRequest): boolean {
  return request.idempotencyKey !== undefined && request.idempotencyKey.trim() !== ''
}
