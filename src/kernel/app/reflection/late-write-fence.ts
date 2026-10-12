/**
 * M11 WP7 —— **late-write fence**（ADR-085 `D17` · §7.3 · `L-M11-11`）。
 *
 * ============================================================================
 *  为什么这个文件必须存在
 * ============================================================================
 * WP0 的侦察结论逐字：**仓库里没有这道闸**（`grep fence|late_write` 在 `src/` 零命中）。
 * 而 `D17` 要求「关闭后 provider 返回 ⇒ **零**写入（事件 / 投影 / 水位）」。
 * 今天只有 `close()` 的 abort + 有界等待作为**部分**替代 —— 那挡不住
 * "abort 之后 provider 仍然把结果送回来"这一种真实情形。
 *
 * ============================================================================
 *  设计（三条判据）
 * ============================================================================
 * ① **关闭是一次性的、单向的**：`close()` 之后再 `close()` 是幂等的，**没有** `open()`。
 *    （"重开"会把一次关机变成一次竞态：晚返回的写入会在重开之后被放行。）
 * ② **拒绝是返回值，不是异常**：`guardedWrite()` 返回 `{ok:false, reason:'late_write_fenced'}`，
 *    调用方据此记一条**具名**读数 —— 抛异常会让"被挡下"与"执行器坏了"长得一样。
 * ③ **计数可观测**：`refusedCount` 是"有多少次写入被这道闸挡下"的读数，
 *    没有它，"闸在工作"与"闸从没被触发过"在输出上无法区分。
 *
 * ⚠️ 纯逻辑：没有 SQL、没有 `node:*`、不读时钟（时间由调用方注入）。
 */

export type LateWriteRefusalReason = 'late_write_fenced'

export interface LateWriteFence {
  /** 已经关闭了吗（**问出来的**，不是猜的） */
  readonly closed: boolean
  /** 被挡下的写入次数（可观测读数） */
  readonly refusedCount: number
  /** 关闭（幂等、单向） */
  close(): void
  /** 现在允许写吗 */
  allow(): boolean
  /** 记一次被挡下的写入 */
  noteRefused(): void
}

export function createLateWriteFence(): LateWriteFence {
  let closed = false
  let refused = 0
  return {
    get closed() {
      return closed
    },
    get refusedCount() {
      return refused
    },
    close() {
      closed = true
    },
    allow() {
      return !closed
    },
    noteRefused() {
      refused += 1
    },
  }
}

export type GuardedWriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: LateWriteRefusalReason; readonly detail: string }

/**
 * 受闸保护的写入。
 *
 * ⚠️ 它在**写入之前**问闸，而且**不重试**：晚返回的结果只能被丢弃，
 *    不能"等闸开了再写"（那正是这条纪律要防的事）。
 */
export async function guardedWrite<T>(
  fence: LateWriteFence,
  write: () => Promise<T>
): Promise<GuardedWriteResult<T>> {
  if (!fence.allow()) {
    fence.noteRefused()
    return {
      ok: false,
      reason: 'late_write_fenced',
      detail: '写入被 late-write fence 挡下：关闭之后到达的结果**零写入**（事件 / 投影 / 水位都不写）',
    }
  }
  return { ok: true, value: await write() }
}

/**
 * 把闸挂到一次"可能晚返回"的调用上。
 *
 * 语义：调用**总是**被执行（不能因为闸关了就跳过 abort 之类的收尾），
 * 但它的**结果**只有在闸开着时才会被 `commit` 落盘。
 */
export async function withLateWriteFence<T, R>(input: {
  readonly fence: LateWriteFence
  readonly produce: () => Promise<T>
  readonly commit: (value: T) => Promise<R>
}): Promise<GuardedWriteResult<R> | { readonly ok: false; readonly reason: 'produce_failed'; readonly detail: string }> {
  let produced: T
  try {
    produced = await input.produce()
  } catch (error) {
    return {
      ok: false,
      reason: 'produce_failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  return await guardedWrite(input.fence, async () => await input.commit(produced))
}
