/**
 * post-Lv2 / **ADR-109 `D06`** —— **双入口的有序调度**（有界、轮转公平、一次一轮）。
 *
 * ============================================================================
 *  它解决的是什么问题
 * ============================================================================
 *
 * ```text
 * 一个核心 + 两个受信会话 ⇒ 两个入口可以**同时**提交正式轮次
 * 而"正式轮次"要串行（写入顺序、模型额度、账本序号都是共享资源）
 * ```
 *
 * 天真的串行（一个全局 FIFO）会**饿死**：一边连发十条，另一边的第一条要等十轮。
 * 因此这里的策略是**轮转公平**：
 *
 * ```text
 *   每个入口一个有界队列
 *   服务完一个入口后，指针移到下一个入口 ⇒ 下一条优先给"另一边"（如果它有活）
 *   同一入口内部保持 FIFO（同入口顺序不变）
 * ```
 *
 * ----------------------------------------------------------------------------
 *  三条纪律（与桥/取消同源）
 * ----------------------------------------------------------------------------
 * ① **有界且失败关闭**：队列超过上限 ⇒ **立即具名拒绝**，不是无限堆积
 *    （堆积会把"模型慢"变成"内存涨"，而外壳看到的是超时 —— 两件事分不清）。
 * ② **控制消息不走这里**：`CANCEL_TURN` / `REPORT_PLAYBACK` / `PREPARE_TURN`
 *    的分类与处理在 `runBridgeTransport` 里（它们**不排队**）。
 *    本模块只管 `runTurn` 那一件"要调模型、要写账本"的事。
 * ③ **读数只记计数与时刻，不记正文**：`TurnSchedulerReading` 里没有任何消息文本。
 *
 * ⚠️ 它**不**判断"该不该回答"、**不**碰身份、**不**碰账本：那三件事各有各的权威。
 */

import { KernelError } from '../../contracts/ids.ts'

/** 一次正式轮次的调度读数（**不含正文**） */
export interface TurnSchedulerReading {
  readonly entry: string
  /** 这一轮在队列里等了多久（毫秒） */
  readonly waitMs: number
  /** 这一轮真正跑了多久（毫秒） */
  readonly runMs: number
  /** 入队时该入口的队列深度（含自己） */
  readonly queueDepthAtEnqueue: number
  readonly startedAt: number
  readonly finishedAt: number
  readonly outcome: 'completed' | 'failed'
}

export interface TurnSchedulerOptions {
  /** 参与调度的入口键（顺序固定；轮转按这个顺序） */
  readonly entries: readonly string[]
  /** 每个入口的队列上限（含正在跑的那一轮）——超过即具名拒绝 */
  readonly maxQueuedPerEntry: number
  /** 只给门用：覆盖时钟 */
  readonly now?: () => number
}

interface PendingTurn {
  readonly task: () => Promise<unknown>
  readonly enqueuedAt: number
  readonly queueDepthAtEnqueue: number
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly entry: string
}

/**
 * 轮转公平的有界轮次调度器。
 *
 * ⚠️ **一次只跑一轮**（`running` 是单飞闸）：这是"正式写入串行"的同一件事，
 *    与 `TurnBridge` 自己的串行闸是**双保险**而不是替代（`D12` 不变）。
 */
export class FairTurnScheduler {
  private readonly entries: readonly string[]
  private readonly maxQueuedPerEntry: number
  private readonly now: () => number
  private readonly queues = new Map<string, PendingTurn[]>()
  private readonly readingsLog: TurnSchedulerReading[] = []
  /** 下一个优先服务的入口下标（轮转指针） */
  private pointer = 0
  private running = false
  /** 正在跑的那一轮属于哪个入口（队列上限把它也算进去 —— 见 `depthOf`） */
  private runningEntry: string | undefined
  private readonly backgroundQueue: PendingTurn[] = []

  constructor(options: TurnSchedulerOptions) {
    if (options.entries.length === 0) {
      throw new KernelError('validation_error', 'scheduler_no_entries', '调度器至少要有一个入口')
    }
    if (!Number.isSafeInteger(options.maxQueuedPerEntry) || options.maxQueuedPerEntry < 1) {
      throw new KernelError(
        'validation_error',
        'scheduler_bad_bound',
        `队列上限必须是 >= 1 的整数，收到 ${String(options.maxQueuedPerEntry)}`
      )
    }
    const unique = new Set(options.entries)
    if (unique.size !== options.entries.length) {
      throw new KernelError('validation_error', 'scheduler_duplicate_entry', '调度器的入口键必须互不相同')
    }
    this.entries = Object.freeze([...options.entries])
    this.maxQueuedPerEntry = options.maxQueuedPerEntry
    this.now = options.now ?? Date.now
    for (const entry of this.entries) this.queues.set(entry, [])
  }

  /**
   * 某入口的**占用数** = 排队中 + （正在跑的那一轮如果属于它）。
   *
   * ⚠️ 上限算上正在跑的那一轮是刻意的：只算排队数时，一个入口可以"跑一轮 +
   *    排一轮"地无限逼近上限，而"有界"在读数上就变成了假的。
   */
  private depthOf(entry: string): number {
    return this.queues.get(entry)!.length + (this.runningEntry === entry ? 1 : 0)
  }

  /** 当前各入口的占用数（诊断读数；含正在跑的那一轮） */
  get depth(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const entry of this.entries) out[entry] = this.depthOf(entry)
    return out
  }

  /** 已完成的调度读数（只读快照） */
  get readings(): readonly TurnSchedulerReading[] {
    return [...this.readingsLog]
  }

  /**
   * 把一次正式轮次排进该入口的队列。
   *
   * ⚠️ **超过上限立即拒绝**（具名码 `scheduler_queue_full`），不排队：
   *    "如实拒绝"与"无限等待后被当成模型超时"是两件必须分开的事。
   * ⚠️ 未登记的入口键**拒绝**（闭集；不得出现"匿名入口"）。
   */
  run<T>(entry: string, task: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(entry)
    if (queue === undefined) {
      return Promise.reject(
        new KernelError('validation_error', 'scheduler_unknown_entry', `未登记的入口：${entry}`)
      )
    }
    if (this.depthOf(entry) >= this.maxQueuedPerEntry) {
      return Promise.reject(
        new KernelError(
          'validation_error',
          'scheduler_queue_full',
          `入口 ${entry} 的队列已满（上限 ${String(this.maxQueuedPerEntry)}，含正在跑的那一轮）：拒绝而不是堆积`
        )
      )
    }
    return new Promise<T>((resolve, reject) => {
      queue.push({
        task: task as () => Promise<unknown>,
        enqueuedAt: this.now(),
        queueDepthAtEnqueue: this.depthOf(entry) + 1,
        resolve: resolve as (value: unknown) => void,
        reject,
        entry,
      })
      void this.pump()
    })
  }

  /**
   * 等调度器**排空**（没有在跑的那一轮、也没有排队的）。
   *
   * ⚠️ 它是收尾用的：核心停机时要"**先等在飞轮次**，再断连接"（ADR-109 `D07` 的
   *    另一半 —— 断开不是停机，停机也不是丢下在飞的轮次）。
   * ⚠️ 它是**有界**的：`timeoutMs` 到点就返回 `false`（"没排空"是如实读数，
   *    不是抛错）—— 调用方据此决定是继续关还是等。
   */
  runBackground<T>(task: () => Promise<T>): Promise<T> {
    if (this.backgroundQueue.length >= 1) return Promise.reject(new Error('scheduler_background_queue_full'))
    return new Promise<T>((resolve, reject) => {
      this.backgroundQueue.push({ task, enqueuedAt: this.now(), queueDepthAtEnqueue: 1, entry: 'system-reminder',
        resolve: resolve as (value: unknown) => void, reject })
      void this.pump()
    })
  }

  async whenIdle(timeoutMs = 30_000): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    for (;;) {
      const queued = [...this.queues.values()].some((queue) => queue.length > 0)
      if (!this.running && !queued && this.backgroundQueue.length === 0) return true
      if (this.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /** 轮转取下一个待服务的入口（同一入口内部 FIFO） */
  private pickNext(): PendingTurn | undefined {
    for (let offset = 0; offset < this.entries.length; offset += 1) {
      const index = (this.pointer + offset) % this.entries.length
      const entry = this.entries[index]!
      const queue = this.queues.get(entry)!
      if (queue.length > 0) {
        // 服务完这一个之后，指针移到**下一个**入口 ⇒ 下一条优先给另一边
        this.pointer = (index + 1) % this.entries.length
        return queue.shift()
      }
    }
    return this.backgroundQueue.shift()
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const pending = this.pickNext()
        if (pending === undefined) break
        const startedAt = this.now()
        let outcome: TurnSchedulerReading['outcome'] = 'completed'
        this.runningEntry = pending.entry
        try {
          pending.resolve(await pending.task())
        } catch (error) {
          outcome = 'failed'
          pending.reject(error)
        } finally {
          this.runningEntry = undefined
          const finishedAt = this.now()
          this.readingsLog.push({
            entry: pending.entry,
            waitMs: startedAt - pending.enqueuedAt,
            runMs: finishedAt - startedAt,
            queueDepthAtEnqueue: pending.queueDepthAtEnqueue,
            startedAt,
            finishedAt,
            outcome,
          })
          /* 只留最近 200 条：它是诊断读数，不是账本（不随进程寿命无限增长） */
          if (this.readingsLog.length > 200) this.readingsLog.shift()
        }
      }
    } finally {
      this.running = false
    }
  }
}
