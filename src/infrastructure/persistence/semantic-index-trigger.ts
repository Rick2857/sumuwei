/**
 * M9.5 **启用计划 / WP4 · W2** —— **有工作上限的异步维护触发器**（串行 + 合并 + 不丢）。
 *
 * ============================================================================
 *  它解决什么（用户 2026-10-01 裁定的形态）
 * ============================================================================
 * ```text
 * 触发点是 `src/main.ts:1604` 的 `commitEvents` —— 每一次"新记忆 / 更正 / 遗忘"提交都经过它。
 * ⚠️ 但**不能**在那里 `await` 维护：那会把编码塞进**用户轮次的关键路径**（冷加载 ~1.2 s）。
 * ⇒ 触发必须**投递即返回**，维护在后台**串行**跑，且**有上限**、**不丢**。
 * ```
 *
 * 三条语义（各自有判据，见 `pnpm m9.5:test` 的 WP4 组）：
 * ```text
 *   ① **串行**：任何时刻最多一轮在跑（绝不并发两轮 —— 两轮会争同一代的计数与水位）
 *   ② **合并**：一轮在跑时来的触发**不排队成 N 轮**，而是合并成"跑完再来一轮"
 *      （100 次触发不等于 100 轮；但**也不等于丢掉** —— 至少还有一轮）
 *   ③ **不丢**：合并只压缩**次数**，不取消**工作**；真正的"上限"由 `runOnce` 内部按条数/时间把握
 * ```
 *
 * ⚠️ **纯模块**：不 import 数据库、不 import 模型 —— `runOnce` 是注入的。
 *    ⇒ 它可以在**没有任何库**的情况下被穷举测试（那正是"算错合并/串行"最该被测的地方）。
 */

export type MaintenanceReason = 'event' | 'startup' | 'manual'

export interface MaintenanceTriggerOptions {
  /** 跑**一轮**维护（上限由它自己把握：条数 / 时间） */
  readonly runOnce: (reason: MaintenanceReason) => Promise<void>
  /** 一轮失败时怎么办（缺省：如实抛出，由调用方决定；本模块**不吞**） */
  readonly onError?: (error: unknown, reason: MaintenanceReason) => void
}

export interface MaintenanceReadings {
  /** 真的跑了几轮 */
  readonly rounds: number
  /** 因为"已有一轮在跑"而被**合并**掉的触发数 */
  readonly coalesced: number
  /** 当前是否有一轮在跑 */
  readonly running: boolean
  /** 合并后**仍欠着**的轮数（0 或 1：合并是"欠一轮"，不是"欠 N 轮"） */
  readonly owed: number
  /** 每一轮开始/结束的时刻（诊断：证明**没有并发**） */
  readonly spans: readonly { readonly reason: MaintenanceReason; readonly startedAt: number; readonly endedAt: number }[]
}

export interface MaintenanceTrigger {
  /** **投递即返回**（返回的 promise 只用于测试等待；调用方**不要**在关键路径上 await 它） */
  readonly trigger: (reason: MaintenanceReason) => Promise<void>
  readonly readings: () => MaintenanceReadings
}

export function createMaintenanceTrigger(options: MaintenanceTriggerOptions): MaintenanceTrigger {
  let rounds = 0
  let coalesced = 0
  let owed = 0
  let running = false
  const spans: { reason: MaintenanceReason; startedAt: number; endedAt: number }[] = []
  /** 等待"当前这一轮 + 它欠的那一轮"结束的等待者 */
  let drainWaiters: (() => void)[] = []

  const runLoop = async (firstReason: MaintenanceReason): Promise<void> => {
    running = true
    let reason = firstReason
    for (;;) {
      const startedAt = Date.now()
      try {
        await options.runOnce(reason)
      } catch (error) {
        options.onError?.(error, reason)
      }
      spans.push({ reason, startedAt, endedAt: Date.now() })
      rounds += 1
      if (owed === 0) break
      /* 把欠着的那一轮跑掉（合并后的那一轮）—— 于是"欠"只可能 0/1 */
      owed = 0
      reason = 'event'
    }
    running = false
    const waiters = drainWaiters
    drainWaiters = []
    for (const waiter of waiters) waiter()
  }

  const trigger = async (reason: MaintenanceReason): Promise<void> => {
    if (running) {
      /* ⚠️ 合并：次数压缩成"欠一轮"，但**不取消工作** */
      coalesced += 1
      owed = 1
      return await new Promise<void>((resolve) => drainWaiters.push(resolve))
    }
    return await new Promise<void>((resolve) => {
      drainWaiters.push(resolve)
      void runLoop(reason)
    })
  }

  return {
    trigger,
    readings: () => ({ rounds, coalesced, running, owed, spans }),
  }
}
