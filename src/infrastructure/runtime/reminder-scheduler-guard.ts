/**
 * ★ R-a（2026-10-10）：提醒调度器的**启动判据** —— 冻结的纯函数。
 *
 * ============================================================================
 *  为什么单独抽出来（不是"为了好看"）
 * ============================================================================
 *  `startStandaloneReminders` 住在 `src/main.ts` 里，是**模块私有函数**；而本仓库的门
 *  **不 import `src/main.ts`**（模块加载会无条件跑完整 CLI，见 `m9-activation-readback.ts`
 *  的纪律）。⇒ 门**拿不到**那个函数。
 *
 *  ⚠️ 那么"连调两次只能有一个 timer"如果只在门里测**后果**（重复投递），会得到**弱见证**：
 *     重复投递已经被 `excludeAttempted()`（`L-QQP-05` 的**读侧**修法）挡掉了
 *     ⇒ **两个 timer 在门里也可能全绿**。那正是本仓库最怕的"量错了东西"。
 *  ⇒ 按本仓库的既定模式（`main.ts:6096` 自己写着"判据全在冻结的纯函数里"，
 *     先例 `precheckCareOpportunity`），把判据做成纯函数，由门直接做三段式。
 *
 *  判据本身：同一进程**只允许一个**提醒调度器。
 *    · 两个 timer 会抢**同一个 `occurrenceKey`** ⇒ 重复投递；
 *    · 第二个 timer 不会被任何 `stop()` 收走（`reminderRefreshHook` 已被覆盖）⇒ **泄漏**。
 *  两者都是"看起来在跑、其实在重发"的形状。
 *
 *  ⚠️ 判据的输入是模块级的 `reminderRefreshHook !== undefined`：coexist 那条入口装调度器时
 *     也设它（`main.ts:6241`）⇒ 这条闸**同时覆盖"与 coexist 装了两份"**的情形。
 */

/** 具名拒绝码（门逐字断言它，不用字符串拼） */
export const REMINDER_SCHEDULER_REFUSAL_CODE = 'reminder_standalone_already_started' as const

/** 闭集：启动 or 具名拒绝（多一个字段整条作废的既有风格） */
export type ReminderStartDecision =
  | { readonly kind: 'start' }
  | { readonly kind: 'refuse'; readonly code: typeof REMINDER_SCHEDULER_REFUSAL_CODE }

export function decideReminderStart(input: {
  /** 本进程是否已装了调度器（= `reminderRefreshHook !== undefined`） */
  readonly hookInstalled: boolean
}): ReminderStartDecision {
  return input.hookInstalled
    ? { kind: 'refuse', code: REMINDER_SCHEDULER_REFUSAL_CODE }
    : { kind: 'start' }
}
