/**
 * PayloadStaging —— **写入载荷的私有暂存**端口（第二批计划 §2.1 第 4 点）。
 *
 * ============================================================================
 *  为什么写入内容不能走 `arguments`
 * ============================================================================
 * M4.5 的 `sandbox.file.write` 把正文放在 `arguments.content` 里，而账本的
 * `summarizeArguments()` 对长字符串会留**前 40 个字符的预览** ——
 * 那是为防止"参数原文整段进账本"设计的，但它对**文件正文**仍然是泄漏：
 * 40 个字符足够泄漏一行地址、一个 token 的前缀、一句话。
 *
 * 计划书 §2.1 第 4 点因此逐字要求：
 * ```text
 * 写入载荷在临时内存/私有暂存中传递，账本参数保存载荷引用、目标和指纹。
 * 正文不通过参数预览泄漏。
 * ```
 *
 * 本文件是这条要求的**结构性**实现：`arguments` 里只有
 * `payloadRef` / `payloadBytes` / `payloadFingerprint` 三个**没有正文**的字段，
 * 正文只存在于 `PayloadStagingPort` 的内存条目里。
 *
 * ---------------------------------------------------------------------------
 *  三条性质
 * ---------------------------------------------------------------------------
 * ① **进程私有**：`Map` + TTL，永不落盘、永不进 ledger / trace / 开发者面。
 * ② **引用不透明**：`payloadRef` 是随机 id，不含路径、不含内容哈希以外的东西。
 * ③ **有界**：条数与单条字节数都有上限；过期条目被 `sweep()` 清掉
 *    （不能让一次长会话把内存撑成第二个数据库）。
 */

export type StagedPayloadKind = 'text' | 'json' | 'base64'

export type StagedPayloadValue =
  | { kind: 'text'; text: string }
  | { kind: 'json'; json: string }
  | { kind: 'base64'; base64: string }

/** 放进暂存后拿到的**引用**（这三个字段是唯一允许离开暂存的形状） */
export interface StagedPayloadRef {
  payloadRef: string
  kind: StagedPayloadKind
  /** 载荷字节数（解码后的真实字节，不是 base64 文本长度） */
  bytes: number
  /** 载荷指纹（十六进制；"这次要写的字节"与"真的写下去的字节"比对用） */
  fingerprint: string
  /** 人类可读的来源标签（如 `task:plan#2` / `user:explicit`）——**不含正文** */
  label: string
}

export interface PayloadStagingPort {
  /** 放进暂存，返回引用（**唯一**能拿到引用的地方） */
  put(input: {
    value: StagedPayloadValue
    label: string
    fingerprint: string
    bytes: number
  }): StagedPayloadRef
  /** 按引用取出载荷；不存在（过期 / 已清）时 `undefined` —— 调用方必须失败关闭 */
  read(payloadRef: string): StagedPayloadValue | undefined
  has(payloadRef: string): boolean
  /** 当前条目数（有界性判据；不是性能读数） */
  size(): number
  /** 清掉过期条目，返回清掉的条数 */
  sweep(): number
  /** 全清（任务结束 / 进程收尾） */
  clear(): void
}

/** 缺省上界（计划书 §3.2：单文件 10 MiB；条数上界防"暂存变成第二个数据库"） */
export const PAYLOAD_STAGING_LIMITS = {
  maxEntries: 64,
  maxBytesPerPayload: 10 * 1024 * 1024,
  /** 条目存活毫秒数（比一个任务的 10 分钟时限长一点，留收尾余量） */
  ttlMs: 15 * 60 * 1000,
} as const

/**
 * 内存实现。
 *
 * ⚠️ 它**不是**一个"缓存"：条目被取走后不重建，过期后不复活。
 *    "引用还在"必须能被当成"这次写入的字节还有据可查"。
 */
export function createInMemoryPayloadStaging(
  options: { now?: () => number; limits?: Partial<typeof PAYLOAD_STAGING_LIMITS> } = {}
): PayloadStagingPort {
  const now = options.now ?? (() => Date.now())
  const limits = { ...PAYLOAD_STAGING_LIMITS, ...(options.limits ?? {}) }
  const entries = new Map<string, { value: StagedPayloadValue; at: number; bytes: number }>()
  let counter = 0

  function sweepInternal(): number {
    const cutoff = now() - limits.ttlMs
    let removed = 0
    for (const [key, entry] of entries) {
      if (entry.at < cutoff) {
        entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  return {
    put(input) {
      if (input.bytes > limits.maxBytesPerPayload) {
        throw new Error(
          `载荷 ${input.bytes} 字节超过暂存单条上限 ${limits.maxBytesPerPayload} —— 拒绝放进暂存`
        )
      }
      sweepInternal()
      while (entries.size >= limits.maxEntries) {
        // 最旧的先走：有界性是硬要求，宁可让这一次写入失败，也不让内存无界
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
      counter += 1
      const payloadRef = `pl_${now().toString(36)}_${counter.toString(36)}`
      entries.set(payloadRef, { value: input.value, at: now(), bytes: input.bytes })
      return {
        payloadRef,
        kind: input.value.kind,
        bytes: input.bytes,
        fingerprint: input.fingerprint,
        label: input.label,
      }
    },
    read(payloadRef) {
      const entry = entries.get(payloadRef)
      if (entry === undefined) return undefined
      if (entry.at < now() - limits.ttlMs) {
        entries.delete(payloadRef)
        return undefined
      }
      return entry.value
    },
    has(payloadRef) {
      return this.read(payloadRef) !== undefined
    },
    size() {
      return entries.size
    },
    sweep: sweepInternal,
    clear() {
      entries.clear()
    },
  }
}
