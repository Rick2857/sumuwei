/**
 * M10 `G-2`：目标理解的**真实运行时**（`GoalUnderstandingRuntime` 的生产实现）。
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 * ```text
 * `runGoalTurn` 的输入里带一个 `GoalUnderstandingRuntime`（`now()` + `withDeadline()`），
 * 而**全仓原先只有测试里的实现**（`deterministicRuntime`：不调真实定时器、直接 await）。
 * ⇒ 生产要接线（`G-2`），就必须有一个**真的**实现：真实时钟 + 真的和期限赛跑。
 * ```
 *
 * ============================================================================
 *  ⚠️ 两条纪律（都来自 `L-M10-61` 那 72 分钟）
 * ============================================================================
 * ```text
 * ① **定时器必须清掉，并且 `unref`**：`L-M10-61` 的第三环就是"兜底定时器从不清理"
 *    ⇒ 一个悬着的 `setTimeout` 会把事件循环**握住**（进程不退出，而回复早已产出）。
 *    这里的做法：`finally { clearTimeout(timer) }` + `timer.unref?.()` 双保险。
 * ② **超时就是超时**：返回 `{kind:'timeout'}`（内核记 `transport`），
 *    **不重试、不降级重问**（"零隐式重试"是设计）。
 * ```
 */

import type { GoalUnderstandingRuntime } from '../../kernel/app/goal/understanding.ts'

/**
 * 造一个真实运行时。
 *
 * ⚠️ 它**不**吞掉 `work()` 的异常：异常照原样抛给调用方（内核把 provider 抛错记成 `transport`），
 *    只有**超时**才返回 `{kind:'timeout'}` —— 两者在结论上必须分得开。
 */
export function createRealGoalUnderstandingRuntime(): GoalUnderstandingRuntime {
  return {
    now: () => Date.now(),

    async withDeadline<T>(
      work: () => Promise<T>,
      deadlineMs: number,
    ): Promise<{ readonly kind: 'ok'; readonly value: T } | { readonly kind: 'timeout' }> {
      let timer: NodeJS.Timeout | undefined
      const timedOut = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(1, deadlineMs))
        /*
         * ⚠️ `unref`：这个定时器**不该**成为"进程还活着"的理由。
         *    （`L-M10-61` 的形态就是"活干完了、进程不走"。）
         */
        timer.unref?.()
      })
      try {
        return await Promise.race([
          work().then((value) => ({ kind: 'ok' as const, value })),
          timedOut,
        ])
      } finally {
        /* ① 纪律：无论走哪条路都清掉，绝不留下悬着的定时器 */
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}
