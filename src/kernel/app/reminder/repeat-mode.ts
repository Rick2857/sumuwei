/**
 * ★ S3（ADR-129 D04）：提醒的**重复模式** —— **由模型判**的闭集值。
 *
 * ⚠️ 单独一个模块的理由：类型要被两处共用（`reminder-turn.ts` 的草稿闭集与
 *    `repeat-policy.ts` 的策略），而**不允许**在任一处再抄一份字面量
 *    （"看字面几个词判 3a/3b"正是用户明确禁止的那件事的代码形态）。
 */
export type ReminderRepeatMode = 'once' | 'until_reply'

export const REMINDER_REPEAT_MODES: readonly ReminderRepeatMode[] = ['once', 'until_reply']

export function isReminderRepeatMode(value: unknown): value is ReminderRepeatMode {
  return value === 'once' || value === 'until_reply'
}
