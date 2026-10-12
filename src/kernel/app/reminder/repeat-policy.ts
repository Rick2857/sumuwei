/**
 * ★ S3（ADR-129 D04/D05）：**重复投递的策略** —— 冻结纯函数。
 *
 * ============================================================================
 *  用户裁定（2026-10-10）
 * ============================================================================
 * ```text
 * 3a  用户没要求自己回应（含明确说"不用管我有没有回复"）⇒ **程序层确认成功即止**，不二次提醒；
 * 3b  用户明确要求重要 / 要求自己回应 ⇒ **60 秒/条重复，直到用户回复**；
 *     **任何回复即销账**（不要求他说"收到"）；**上限 10 次**。
 * 优先  重复是"同一条提醒的续发"，**不重复占额**；但**停机/暂停优先**于重复。
 * 判定  3a/3b **由模型判**（闭集字段 `repeat`），**不得按字面几个词归类**。
 * ```
 *
 * ============================================================================
 *  为什么是纯函数
 * ============================================================================
 *  · 判据不能只活在调度器里（那是"看起来在跑"最容易藏身处）⇒ 抽出来，门可直接三段式量它；
 *  · 调度器只负责"到这个时刻调一次 schedule"，**要不要续发**这件事在这里一次算清。
 *
 *  ⚠️ 本模块不碰数据库：把 `repeat` 模式与已续发次数**落库**需要一次迁移（另案、需用户授权）。
 *     这里的判据先冻结 —— 迁移到位后调度器直接调用它即可。
 */

import { type ReminderRepeatMode } from './repeat-mode.ts'
import { reminderOccurrenceKey } from '../../contracts/notification.ts'

/** 续发间隔（用户裁定：60 秒/条） */
export const REMINDER_REPEAT_INTERVAL_MS = 60_000

/** 续发上限（用户裁定：10 次） */
export const REMINDER_REPEAT_MAX_ATTEMPTS = 10

/** 闭集：续发 or 具名停止（多一个字段整条作废的既有风格） */
export type ReminderRepeatDecision =
  | { readonly kind: 'repeat'; readonly nextAt: number }
  | {
      readonly kind: 'stop'
      readonly reason: 'once' | 'settled' | 'max_attempts' | 'paused'
    }

/**
 * 一条提醒投递之后，**还要不要续发**。
 *
 * 判定顺序是刻意的（前面的优先）：
 * ```text
 * ① paused（停机/暂停）        ⇒ stop('paused')        —— 用户裁定里"暂停优先于重复"
 * ② settledByReply（他回过了） ⇒ stop('settled')       —— "任何回复即销账"
 * ③ mode !== 'until_reply'     ⇒ stop('once')          —— 3a：确认成功即止
 * ④ attempt >= 10              ⇒ stop('max_attempts')  —— 上限
 * ⑤ 否则                       ⇒ repeat(投递时刻 + 60s)
 * ```
 * ⚠️ `attempt` 是**已经投递过的次数**（首次投递 = 1）⇒ `attempt = 10` 时停止，总共最多 10 条。
 */
export function decideReminderRepeat(input: {
  mode: ReminderRepeatMode | null | undefined
  /** 已经投递过的次数（首次 = 1） */
  attempt: number
  /** 本次投递发生的时刻（续发从它 + 60s 起算） */
  deliveredAt: number
  /** 这条提醒之后，用户**有没有回过任何一句话** */
  settledByReply?: boolean
  /** 停机 / 暂停（`notification_control` 的落库状态） */
  paused?: boolean
  /**
   * ★ 可注入的续发间隔（毫秒）。**缺席 ⇒ 冻结常量 60_000**（逐字不变）。
   * 存在的理由：行为级门要在**秒级**观测到第二条（否则一道门要等 60 秒）；
   * ⚠️ 生产装配缺省不传 ⇒ 行为与改动前完全相同（回滚 = 不设那个环境变量）。
   */
  intervalMs?: number
}): ReminderRepeatDecision {
  if (input.paused === true) return { kind: 'stop', reason: 'paused' }
  if (input.settledByReply === true) return { kind: 'stop', reason: 'settled' }
  if (input.mode !== 'until_reply') return { kind: 'stop', reason: 'once' }
  if (input.attempt >= REMINDER_REPEAT_MAX_ATTEMPTS) return { kind: 'stop', reason: 'max_attempts' }
  return { kind: 'repeat', nextAt: input.deliveredAt + (input.intervalMs ?? REMINDER_REPEAT_INTERVAL_MS) }
}

/**
 * ★ S3 ③ 驱动：**下一条续发要怎么排** —— 冻结纯函数（把最易错的两件事关进可量测的地方）。
 *
 * 为什么单独抽：续发实际是"再排一条 occurrence"，而**排期的键**必须与占用时用的键**逐字一致**
 * （`reminderOccurrenceKey(intentId, planVersion, dueAt)`）—— 键算错会出现两种坏结局：
 *   · 键与既有一条**撞上** ⇒ 被幂等挡住 ⇒ "续发看起来配好了、其实永不发"；
 *   · 键与既有一条**差一点** ⇒ 同一条提醒**重复投递**（本仓库最忌讳的那类）。
 *
 * ⚠️ 与 `decideReminderRepeat` 的分工：那里决定"还要不要发"，这里把"要发"翻译成**可执行的排期**
 *    （新 `dueAt` = 上次投递 + 60s；`attempt` 递增；键由**同一个**冻结函数算出）。
 * ⚠️ 仍不碰数据库：真正落库由调用方走唯一入口 `reserveOccurrence()`。
 */
export function nextRepeatOccurrence(input: {
  intentId: string
  planVersion: number
  mode: ReminderRepeatMode | null | undefined
  /** **已经投递过的次数**（首次 = 1） */
  attempt: number
  deliveredAt: number
  settledByReply?: boolean
  paused?: boolean
  /** ★ 可注入的续发间隔（缺席 ⇒ 冻结常量 60_000）；见 `decideReminderRepeat` 的同名字段 */
  intervalMs?: number
}): { kind: 'arm'; occurrenceKey: string; dueAt: number; attempt: number }
  | { kind: 'stop'; reason: 'once' | 'settled' | 'max_attempts' | 'paused' } {
  const decision = decideReminderRepeat({
    mode: input.mode,
    attempt: input.attempt,
    deliveredAt: input.deliveredAt,
    ...(input.settledByReply === undefined ? {} : { settledByReply: input.settledByReply }),
    ...(input.paused === undefined ? {} : { paused: input.paused }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
  })
  if (decision.kind === 'stop') return decision
  return {
    kind: 'arm',
    /* ⚠️ 键必须与 `reserveOccurrence` 用的**同一个**冻结函数算出（见上） */
    occurrenceKey: reminderOccurrenceKey({ intentId: input.intentId, planVersion: input.planVersion, dueAt: decision.nextAt }),
    dueAt: decision.nextAt,
    attempt: input.attempt + 1,
  }
}
