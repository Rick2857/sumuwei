/**
 * M11 WP7 —— **反思任务的窗口规划**（ADR-085 §7.1 · §7.2 · `D15` · `D16` · `D17`）。
 *
 * ============================================================================
 *  它回答三个问题（都是**纯函数**）
 * ============================================================================
 * ```text
 * ① 这一次该看哪一段？           planReflectionWindow()：水位 → 有界窗口 → 水位上界
 * ② 哪些事件要**跳过但仍推进水位**？  跳过 tool / assistant / 非资格事件（否则**永久楔死**）
 * ③ 两次待处理区间怎么合并？      合并只**扩大**序号范围，**不得**丢掉必须失效的事件
 * ```
 *
 * ============================================================================
 *  三条硬边界（都是本仓库真实踩过的坑）
 * ============================================================================
 * ① **跳过 ≠ 停止**：窗口里出现一条 tool 事件时，若不跳过，评估会 failed、
 *    水位冻结、之后**每个**窗口都还含它 ⇒ 永久楔死（M8 WP7 实测到的 A10）。
 * ② **合并不丢失效**：合并区间时，若只取"较大序号"而不带上另一段里的
 *    必须失效事件，合并就静默变成了跳过（`D12` 的安全失效因此被推迟）。
 * ③ **没有尾巴就不做事**：`latest <= watermark` ⇒ `no_tail` ⇒ **不调用模型**（`D15`）。
 *
 * ⚠️ 纯逻辑：没有 SQL、没有 `node:*`、不调模型。
 */

/** 窗口里的一条事件（最小读数） */
export interface ReflectionWindowEvent {
  readonly id: string
  readonly type: string
  readonly sequence: number
  readonly actorType: string
  /** 这条事件是否要求**立即失效**（例如它是一条 `explicit_forget` 的撤回） */
  readonly requiresInvalidation?: boolean
}

export interface ReflectionWindowPlan {
  /** 本次消费的序号范围（含端点；`from > to` 表示空窗口） */
  readonly fromSequence: number
  readonly toSequence: number
  /** 合格事件（要进反思输入的那些） */
  readonly eligible: readonly ReflectionWindowEvent[]
  /** 被跳过的事件（tool / assistant / 非资格）—— 它们**仍然**推进水位 */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[]
  /** 本窗口里**必须**失效的对象（合并不许丢） */
  readonly mustInvalidate: readonly string[]
  /** 窗口是否被容量上限截断（截了 ⇒ 上界只到最后一个被消费的事件） */
  readonly truncated: boolean
  /** 判定：这一段值不值得跑模型 */
  readonly hasTail: boolean
}

export const REFLECTION_WINDOW_MAX_EVENTS = 50

/**
 * 规划一次窗口。
 *
 * @param mergeWith 上一次**未消费完**的待处理区间（合并只扩大范围）
 */
export function planReflectionWindow(input: {
  readonly events: readonly ReflectionWindowEvent[]
  readonly watermark: number
  readonly latest: number
  readonly mergeWith?: {
    readonly fromSequence: number
    readonly toSequence: number
    readonly mustInvalidate: readonly string[]
  }
  readonly maxEvents?: number
}): ReflectionWindowPlan {
  const maxEvents = input.maxEvents ?? REFLECTION_WINDOW_MAX_EVENTS

  // 合并：起点取**更早**的那个（扩大范围），并带上另一段的必须失效
  const from = Math.min(input.watermark, input.mergeWith?.fromSequence ?? input.watermark)
  const mergedInvalidations = [...(input.mergeWith?.mustInvalidate ?? [])]

  if (input.latest <= input.watermark && input.mergeWith === undefined) {
    return {
      fromSequence: input.watermark,
      toSequence: input.watermark,
      eligible: [],
      skipped: [],
      mustInvalidate: mergedInvalidations,
      truncated: false,
      hasTail: false,
    }
  }

  const inRange = input.events
    .filter((event) => event.sequence > from - 1 && event.sequence <= input.latest)
    .sort((a, b) => a.sequence - b.sequence)

  const consumed = inRange.slice(0, maxEvents)
  const truncated = inRange.length > consumed.length

  const eligible: ReflectionWindowEvent[] = []
  const skipped: { id: string; reason: string }[] = []
  const mustInvalidate = new Set<string>(mergedInvalidations)

  for (const event of consumed) {
    /*
     * ⚠️ 跳过规则：**tool** 与 **assistant** 事件不是反思的合格输入
     *    （工具内容不是她的经历；她自己的话只能证明"她说过"）。
     *    关键是：跳过它们**仍然**推进水位（下面的 toSequence 会越过它们）。
     */
    if (event.actorType === 'tool') {
      skipped.push({ id: event.id, reason: 'tool_event_not_eligible' })
      continue
    }
    if (event.actorType === 'character' || event.actorType === 'assistant') {
      skipped.push({ id: event.id, reason: 'assistant_speech_not_eligible' })
      continue
    }
    if (event.requiresInvalidation) mustInvalidate.add(event.id)
    eligible.push(event)
  }

  const lastConsumed = consumed[consumed.length - 1]
  const toSequence = lastConsumed === undefined ? from : lastConsumed.sequence

  return {
    fromSequence: from,
    toSequence,
    eligible,
    skipped,
    mustInvalidate: [...mustInvalidate].sort(),
    truncated,
    hasTail: true,
  }
}

/**
 * 合并两个待处理区间（**只扩大，不丢失效**）。
 *
 * 独立出来是为了让它**单独可测**：合并的正确性不依赖窗口规划的其他部分。
 */
export function mergePendingWindows(
  a: { fromSequence: number; toSequence: number; mustInvalidate: readonly string[] },
  b: { fromSequence: number; toSequence: number; mustInvalidate: readonly string[] }
): { fromSequence: number; toSequence: number; mustInvalidate: readonly string[] } {
  return {
    fromSequence: Math.min(a.fromSequence, b.fromSequence),
    toSequence: Math.max(a.toSequence, b.toSequence),
    mustInvalidate: [...new Set([...a.mustInvalidate, ...b.mustInvalidate])].sort(),
  }
}
