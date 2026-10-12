/**
 * 主动联系的**调度器**（post-Lv2 / ADR-110 `D04` + `L-QQP-01`）。
 *
 * ============================================================================
 *  它负责什么 / 不负责什么
 * ============================================================================
 * ```text
 * 负责：① 读"最近一条待办提醒"→ 排**一次**单次触发（**先过 L-QQP-01 的预判**）
 *      ② 到点时回调上层（**不**在这里决定发不发、发什么）
 *      ③ 关心机会的**周期 tick**（只在活动时段内真的回调；时段外如实记读数）
 *      ④ 重排：每次触发/刷新都重算最近一条（**有界**，不递归）
 *      ⑤ 读数：排了没有 / 下一次何时 / 拒了几次 / 最后一次为什么
 * 不负责：判断该不该发（判据层）、生成正文（模型那一步）、投递（线缆那一侧）、
 *        写库（持久层）。本模块**一行 SQL 都没有**。
 * ```
 *
 * ⚠️ **`L-QQP-01` 是这里的第一条纪律**：Croner 的单次触发有效瞬间被**截断到秒**，
 *    同秒的目标会 `nextRun() === null` ⇒ **静默不排期、一次都不响**。
 *    所以本模块在排期**之前**先过 `onceShotIsSchedulable()`：
 *    - 可排 ⇒ 排，并记 `nextRunAt`
 *    - 不可排 ⇒ **具名**拒绝（`reminder_not_schedulable`）并**立刻回调上层**
 *      （那条提醒已经过了它能被排的窗口 ⇒ 上层该把它定案，而不是让它悬着）
 *
 * ⚠️ 一次**只排一条**（最近的那条）。到点触发之后再读一次待办重排 ——
 *    这样"新增/取消/改时"永远只需要 `refresh()`，不需要理解内部状态。
 */
import {
  isWithinActiveWindow,
  onceShotIsSchedulable,
  type ActiveWindow,
  type ProactivePolicy,
} from '../contracts/notification.ts'

/** 一次单次触发 / 一个周期 tick 的**具名**句柄（名 = 幂等键，见 `L-QQP-01` 的探针发现） */
export interface ProactiveTimerPort {
  armOnce(
    name: string,
    at: number,
    fire: () => void | Promise<void>
  ): { ok: boolean; code?: string; nextRunAt?: number }
  armEvery(name: string, intervalMs: number, fire: () => void | Promise<void>): { ok: boolean; code?: string }
  cancel(name: string): void
  nextRunAt(name: string): number | null
  stopAll(): void
}

export const REMINDER_TIMER_NAME = 'qq-proactive-reminder-due'
export const CARE_TIMER_NAME = 'qq-proactive-care-tick'

export interface PendingReminder {
  readonly occurrenceKey: string
  readonly dueAt: number
}

export interface ProactiveSchedulerReadings {
  /** 当前有没有排着一条单次触发 */
  readonly reminderArmed: boolean
  readonly reminderNextRunAt: number | null
  /** 到点回调**真的执行了**几次（只数 `due` 那条路） */
  readonly reminderFired: number
  /**
   * "已经不可排期"而被**立刻交付**给上层的次数（`L-QQP-01` 的另一半）。
   *
   * ⚠️ 与 `reminderFired` **分开计数**：前者是"到点了"，后者是"到得太晚、根本排不上"。
   *    合成一个数就再也分不清"她不发"是因为没到点还是因为已经过期。
   */
  readonly reminderExpiredHandover: number
  /** 关心 tick 真的回调了几次 */
  readonly careTicks: number
  /** 关心 tick 因为"不在活动时段"被如实跳过几次 */
  readonly careSkippedOutsideWindow: number
  /** `onceShotIsSchedulable` 判"已不可排"几次（**具名**，不是静默） */
  readonly refusedNotSchedulable: number
  /** 定时器自己拒绝了排期几次 */
  readonly refusedByTimer: number
  readonly refreshes: number
  readonly lastCode: string | null
  readonly lastError: string | null
}

export interface ProactiveSchedulerOptions {
  readonly careEnabled?: boolean
  readonly timer: ProactiveTimerPort
  readonly policy: ProactivePolicy
  readonly now?: () => number
  /** 读"还没到点、仍然要发的提醒"（按 `dueAt` 升序或无序都行 —— 这里自己取最小） */
  readonly listPendingReminders: () => Promise<readonly PendingReminder[]>
  /** 到点了（**上层**去决定发不发、发什么、经谁发） */
  readonly onReminderDue: (input: PendingReminder) => Promise<void>
  /** 关心机会的 tick（**上层**去做十种预检） */
  readonly onCareOpportunity: (input: { at: number }) => Promise<void>
  /** 诊断钩子（**不含正文**） */
  readonly onReading?: (reading: { event: string; detail?: string; at?: number }) => void
}

export class ProactiveScheduler {
  private readonly options: ProactiveSchedulerOptions
  private readonly now: () => number
  private readonly counters = {
    reminderFired: 0,
    reminderExpiredHandover: 0,
    careTicks: 0,
    careSkippedOutsideWindow: 0,
    refusedNotSchedulable: 0,
    refusedByTimer: 0,
    refreshes: 0,
    lastCode: null as string | null,
    lastError: null as string | null,
  }
  private armed = false
  private stopped = false
  /**
   * 交付闸：`fireReminder` 正在跑时**不许**再进来一次。
   *
   * ⚠️ 这不是防御性编程的洁癖 —— 它是**实测抓到的**：第一版在"不可排 ⇒ 立刻交付"
   *    那条路上**无条件**重排，而重排又会读到**同一条**（上层还没来得及定案）
   *    ⇒ `refresh` ⟷ `fireReminder` 互递归到堆爆（`FATAL ERROR: heap out of memory`）。
   *    现在：① 不可排那条路**不**自动重排（由上层定案后显式 `refresh()`）
   *          ② 真发生了重入 ⇒ 具名拒绝并返回（**绝不**让栈/堆失控）
   */
  private handingOver = false

  constructor(options: ProactiveSchedulerOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  /** 启动：先读一次待办排上，再排关心 tick。**幂等**（重复 start 只排一次）。 */
  async start(): Promise<void> {
    this.stopped = false
    if (this.options.careEnabled !== false) this.armCareTick()
    await this.refresh()
  }

  /**
   * 重排**最近一条**待办提醒。
   *
   * ⚠️ 提醒登记 / 取消 / 改时之后**必须**调它 —— 这是"外部改了库，调度器怎么知道"的**唯一**答案。
   */
  async refresh(): Promise<void> {
    if (this.stopped) return
    this.counters.refreshes += 1
    this.options.timer.cancel(REMINDER_TIMER_NAME)
    this.armed = false

    let pending: readonly PendingReminder[]
    try {
      pending = await this.options.listPendingReminders()
    } catch (error) {
      this.recordError('refresh_failed', error)
      return
    }
    const next = nearest(pending)
    if (next === undefined) {
      this.counters.lastCode = 'no_pending_reminder'
      this.options.onReading?.({ event: 'no_pending_reminder' })
      return
    }

    const now = this.now()
    /*
     * ⚠️ `L-QQP-01`：**先**预判可排性。不可排 ⇒ 具名 + **立刻回调**（别让它悬着）。
     *    绝不"排一个 nextRun() 为 null 的作业然后什么都不发生"。
     */
    if (!onceShotIsSchedulable(next.dueAt, now)) {
      this.counters.refusedNotSchedulable += 1
      this.counters.lastCode = 'reminder_not_schedulable'
      this.options.onReading?.({
        event: 'reminder_not_schedulable',
        detail: next.occurrenceKey,
        at: next.dueAt,
      })
      await this.fireReminder(next, 'not_schedulable')
      return
    }

    const armed = this.options.timer.armOnce(REMINDER_TIMER_NAME, next.dueAt, () => {
      void this.fireReminder(next, 'due')
    })
    if (!armed.ok) {
      this.counters.refusedByTimer += 1
      this.counters.lastCode = armed.code ?? 'timer_refused'
      this.options.onReading?.({ event: 'arm_refused', detail: armed.code })
      return
    }
    this.armed = true
    this.counters.lastCode = null
    this.options.onReading?.({ event: 'reminder_armed', detail: next.occurrenceKey, at: next.dueAt })
  }

  /** 排关心 tick（只在活动时段内真的回调；时段外如实记读数） */
  private armCareTick(): void {
    const interval = this.options.policy.opportunityIntervalMs
    const armed = this.options.timer.armEvery(CARE_TIMER_NAME, interval, () => {
      void this.fireCare()
    })
    if (!armed.ok) {
      this.counters.refusedByTimer += 1
      this.counters.lastCode = armed.code ?? 'care_timer_refused'
      this.options.onReading?.({ event: 'care_arm_refused', detail: armed.code })
    }
  }

  private async fireReminder(input: PendingReminder, reason: 'due' | 'not_schedulable'): Promise<void> {
    if (this.stopped) return
    if (this.handingOver) {
      /* 重入 ⇒ 具名拒绝（正常路径不该发生；发生了也**绝不**递归下去） */
      this.counters.lastCode = 'reminder_handover_reentry_refused'
      this.options.onReading?.({ event: 'reminder_handover_reentry_refused', detail: input.occurrenceKey })
      return
    }
    this.handingOver = true
    this.armed = false
    try {
      await this.options.onReminderDue(input)
      if (reason === 'due') {
        this.counters.reminderFired += 1
        this.counters.lastCode = null
      } else {
        /* ⚠️ 与"到点"分开计数；`lastCode` **保留** `reminder_not_schedulable`（那是这条路的结论） */
        this.counters.reminderExpiredHandover += 1
      }
      this.options.onReading?.({ event: 'reminder_handed_over', detail: input.occurrenceKey, at: this.now() })
    } catch (error) {
      this.recordError('reminder_due_failed', error)
    } finally {
      this.handingOver = false
    }
    /*
     * ⚠️ **只有 `due` 那条路自动重排**。
     *    `not_schedulable` 那条路**不**重排：那一条还挂在待办里，上层拿到它之后要先去定案
     *    （否则这里会再读到同一条 ⇒ 互递归）。上层定案完**必须**自己调 `refresh()`。
     * ⚠️ 重排**必须在 try/catch 之外**：上层抛一次不该让后面所有提醒永不触发。
     *    有界：`refresh()` 只排一条、不递归调用自己。
     */
    if (reason === 'due') await this.refresh()
  }

  private async fireCare(): Promise<void> {
    if (this.stopped) return
    const at = this.now()
    if (!isWithinActiveWindow(at, this.options.policy.activeWindow as ActiveWindow)) {
      this.counters.careSkippedOutsideWindow += 1
      this.counters.lastCode = 'care_outside_active_window'
      this.options.onReading?.({ event: 'care_skipped_outside_window', at })
      return
    }
    try {
      await this.options.onCareOpportunity({ at })
      this.counters.careTicks += 1
      this.counters.lastCode = null
      this.options.onReading?.({ event: 'care_tick', at })
    } catch (error) {
      this.recordError('care_tick_failed', error)
    }
  }

  /** 停：取消两个具名作业。**幂等**。 */
  stop(): void {
    this.stopped = true
    this.armed = false
    this.options.timer.cancel(REMINDER_TIMER_NAME)
    this.options.timer.cancel(CARE_TIMER_NAME)
  }

  async drain(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.handingOver) {
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return true
  }

  private recordError(code: string, error: unknown): void {
    this.counters.lastCode = code
    this.counters.lastError = error instanceof Error ? error.message : String(error)
    this.options.onReading?.({ event: code, detail: this.counters.lastError })
  }

  readings(): ProactiveSchedulerReadings {
    return {
      reminderArmed: this.armed,
      reminderNextRunAt: this.options.timer.nextRunAt(REMINDER_TIMER_NAME),
      reminderFired: this.counters.reminderFired,
      reminderExpiredHandover: this.counters.reminderExpiredHandover,
      careTicks: this.counters.careTicks,
      careSkippedOutsideWindow: this.counters.careSkippedOutsideWindow,
      refusedNotSchedulable: this.counters.refusedNotSchedulable,
      refusedByTimer: this.counters.refusedByTimer,
      refreshes: this.counters.refreshes,
      lastCode: this.counters.lastCode,
      lastError: this.counters.lastError,
    }
  }
}

/** 取 `dueAt` 最小的那一条（空集 ⇒ `undefined`） */
export function nearest(pending: readonly PendingReminder[]): PendingReminder | undefined {
  let best: PendingReminder | undefined
  for (const item of pending) {
    if (best === undefined || item.dueAt < best.dueAt) best = item
  }
  return best
}

/**
 * 把**已经尝试过**的机会剔掉（`L-QQP-05` 的修法）。
 *
 * ============================================================================
 *  为什么需要它（实测得到）
 * ============================================================================
 * ```text
 * 投递之后**意图没有被结清** —— 它的 `status` 仍然是 `pending`
 *   （本批刻意**不**把 `api_accepted` 写成"已送达"：`D08` 说平台接受 ≠ 送达）
 * ⇒ 调度器每次重排都会**再列出同一条**并再交付一次。
 * ```
 * ⚠️ 实测读数（整链那一门）：第二次交付被**实例行的唯一占用**拒住
 *    （`reminder_occurrence_dispatching`）—— **没有发出第二次**。
 *    也就是说：幂等是保住了，但每次重排都白跑一趟、日志里多一条"被拒"。
 *
 * ⇒ 正确的修法是**读侧**过滤（不是把状态写成"已送达"）：
 *    "还要不要发" 与 "发出去之后平台怎么说" 是**两件事**，
 *    把它们混成一个状态就会既过度主张又丢掉真相。
 */
export function excludeAttempted(
  pending: readonly PendingReminder[],
  attemptedOccurrenceKeys: ReadonlySet<string>
): PendingReminder[] {
  if (attemptedOccurrenceKeys.size === 0) return [...pending]
  return pending.filter((item) => !attemptedOccurrenceKeys.has(item.occurrenceKey))
}
