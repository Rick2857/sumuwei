/**
 * ADR-131 `D15` —— 主动开口的**机会状态**（冷却 / 日额度 / 幂等键的那一面）。
 *
 * ============================================================================
 *  为什么单独一个文件
 * ============================================================================
 * `precheckOpeningOpportunity` 要三个读数：
 * ```text
 * lastOpeningAt            两次开口之间的冷却
 * openingsUsedToday        本通道日额度
 * handledOpportunityKeys   机会键幂等（同一小时最多一次）
 * ```
 * ⚠️ 而在 WP5b 之前，**这三个在全仓库任何地方都不存在**（只有契约里的入参形状）。
 *    WP0 基线写的"存在投递登记里、不新建表"**在现有登记表里没有对应的位置** ——
 *    这一条当时的判断是**不准确的**，本文件是它的更正。
 *
 * ============================================================================
 *  本文件给什么、不给什么
 * ============================================================================
 * ```text
 * 给   ：**端口**（`OpeningStatePort`）+ 一个**内存实现** + 日界计数（纯函数）
 * 不给 ：落库。**落库要一条迁移，而迁移必须由用户单独批准**
 *        （先例：`0014` / `0015` / `0016` / `0017` 各自单独批准）
 * ```
 *
 * ⚠️ **内存实现的已知局限（机器可读，不是一句口头说明）**：
 *    进程重启 ⇒ `lastOpeningAt` / 日额度 / 已处理机会键**全部归零**
 *    ⇒ **重启可以绕过冷却与日额度**，同一小时的机会重算后也会再来一次。
 *    见 {@link IN_MEMORY_OPENING_STATE_LIMITATION} —— 它是一条**读数**，
 *    探针会把它演示出来（"新实例什么都不记得"），而不是只写在文档里。
 */

import { dayKeyOf, type ProactivePolicy } from '../../contracts/notification.ts'

/** 内存实现的可读局限标识（登记用；探针会实测它） */
export const IN_MEMORY_OPENING_STATE_LIMITATION =
  'in_memory_opening_state_resets_on_restart: 重启后冷却/日额度/机会键幂等全部归零 ⇒ 重启可绕过限流'

export interface OpeningStateSnapshot {
  /** 上一次开口实际占额的时刻（含结果不明与明确失败 —— 都占额） */
  readonly lastOpeningAt?: number
  /** 所有已占额时刻（升序；日额度按**时区日界**数它） */
  readonly openingTimestamps: readonly number[]
  /** 已经处理过的机会键（幂等） */
  readonly handledOpportunityKeys: readonly string[]
}

export interface OpeningStatePort {
  snapshot(): OpeningStateSnapshot
  /**
   * 记下一次开口。
   *
   * ⚠️ **无论成没成都要记**：冷却与日额度算的是"占额"，不是"成功"。
   *    （与 `lastCareAt` 的注释同一条口径："含结果不明与明确失败 —— 两者都占额"。）
   */
  record(input: { readonly opportunityKey: string; readonly at: number }): void
}

/**
 * 指定时区**日界内**已占额的条数（纯函数）。
 *
 * ⚠️ 日界用 `dayKeyOf(ts, tz)` 算，**不**用 UTC 日、**不**用本机时区 ——
 *    与 `careOpportunityKey` 用的是同一个日键函数（否则"每天"的定义会有两处）。
 */
export function countOpeningsToday(
  openingTimestamps: readonly number[],
  now: number,
  timeZone: string
): number {
  const today = dayKeyOf(now, timeZone)
  let count = 0
  for (const at of openingTimestamps) {
    if (dayKeyOf(at, timeZone) === today) count += 1
  }
  return count
}

/**
 * 内存实现。
 *
 * ⚠️ 它的用途是**让 WP5b 的接线先跑起来**，不是最终形态。
 *    局限见文件头与 {@link IN_MEMORY_OPENING_STATE_LIMITATION}。
 */
export function createInMemoryOpeningState(): OpeningStatePort {
  const timestamps: number[] = []
  const handled: string[] = []
  return {
    snapshot() {
      const sorted = [...timestamps].sort((a, b) => a - b)
      return {
        ...(sorted.length > 0 ? { lastOpeningAt: sorted[sorted.length - 1] } : {}),
        openingTimestamps: sorted,
        handledOpportunityKeys: [...handled],
      }
    },
    record(input) {
      timestamps.push(input.at)
      /* 幂等键只留**有界**的一段：它按小时去重，不需要无限保存 */
      if (!handled.includes(input.opportunityKey)) handled.push(input.opportunityKey)
      while (handled.length > 48) handled.shift()
    },
  }
}

/**
 * 把状态端口 + 外部读数拼成预检的入参。
 *
 * ⚠️ `allUsedToday` **不**由本端口提供：那是"全类主动消息"（含 care 与提醒），
 *    它们的账在通知那一侧 —— 由**调用方**读了传进来（本端口只管开口自己那一份）。
 */
export function openingPrecheckInputs(input: {
  readonly state: OpeningStatePort
  readonly now: number
  readonly policy: ProactivePolicy
  readonly allUsedToday: number
}): {
  readonly lastOpeningAt?: number
  readonly openingsUsedToday: number
  readonly handledOpportunityKeys: readonly string[]
  readonly allUsedToday: number
} {
  const snapshot = input.state.snapshot()
  return {
    ...(snapshot.lastOpeningAt === undefined ? {} : { lastOpeningAt: snapshot.lastOpeningAt }),
    openingsUsedToday: countOpeningsToday(snapshot.openingTimestamps, input.now, input.policy.timeZone),
    handledOpportunityKeys: snapshot.handledOpportunityKeys,
    allUsedToday: input.allUsedToday,
  }
}
