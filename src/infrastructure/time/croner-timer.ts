/**
 * `ProactiveTimerPort` 的 **Croner 实现**（post-Lv2 / ADR-110 `D04`）。
 *
 * ============================================================================
 *  它为什么单独住一层
 * ============================================================================
 * ```text
 * 判据与编排住在 kernel（`proactive-scheduler.ts`，一行 SQL、一行 croner 都没有）
 * 真正的定时器住在 infrastructure（本文件）
 * ⇒ 门可以拿一个**假定时器**把调度器的判据全部跑出来（确定、不等待）
 *   而"真 croner 到底会不会响"由一条**真的等一小会儿**的用例单独证明
 * ```
 *
 * ⚠️ 三条从 WP1 探针来的**实测事实**（`L-QQP-01` 与它的两个同伴）：
 * ```text
 * ① 单次触发的有效瞬间被截断到秒；同秒目标 ⇒ `nextRun()` 为 null ⇒ **静默不排期**
 *    ⇒ 生产侧由 `onceShotIsSchedulable()` **先预判**（本文件不重复这道判据）
 * ② 具名作业**同名不唯一**（探针实测：两个同名作业都排上了）⇒ 本实现自己用 Map 保证
 *    "一个名字只有一个作业"，并在重排前**先 cancel**
 * ③ `stop()` 之后作业**从 `scheduledJobs` 里消失**（不再占位）
 * ```
 */
import { Cron } from 'croner'
import type { ProactiveTimerPort } from '../../kernel/app/proactive-scheduler.ts'

export interface CronerTimerOptions {
  /** 时区（**不继承宿主机**；由 `ProactivePolicy` 给） */
  readonly timeZone: string
  /** 日志（可选；**不含正文**） */
  readonly onReading?: (reading: { event: string; name: string; detail?: string }) => void
}

/**
 * 一次只拿**一个**定时器的实现（内部按名字管理，重排前先取消同名作业）。
 *
 * ⚠️ `unref` 让定时器**不阻止进程退出** —— 她主动联系的调度器不该让 Ctrl+C 失效。
 */
export function createCronerTimer(options: CronerTimerOptions): ProactiveTimerPort {
  const jobs = new Map<string, Cron>()

  const cancelNamed = (name: string): void => {
    const existing = jobs.get(name)
    if (existing === undefined) return
    try {
      existing.stop()
    } catch {
      /* 已经停了 / 正在停 —— 如实当成"取消完成" */
    }
    jobs.delete(name)
  }

  return {
    armOnce(name, at, fire) {
      cancelNamed(name)
      try {
        /*
         * ⚠️ **`L-QQP-06`（本处修的缺陷）**：Croner 的单次触发在**秒首**开火 ——
         *    实测比目标时刻**早 200–862ms**（它把目标截断到秒，然后在那一秒的**开头**响）。
         *    ⇒ 提醒会在"到点"之前不到一秒发出，而验收要求是"**不早于**目标时刻"。
         *
         * 修法：**不在回调里直接 `fire()`**，而是先量一下"离目标还差多少"：
         * ```text
         * 还差 > 0  ⇒ setTimeout 补足那一段（上限就是一个秒内的零头）
         * 已到/已过 ⇒ 立刻 fire
         * ```
         * ⚠️ 只补**正**的零头：绝不在已经迟到时再延后（迟到是要如实发生的，不该被"修"掉）。
         * ⚠️ 这是**发送前复检**的自然位置：`onceShotIsSchedulable` 判的是"能不能排上"，
         *    它**不**保证"不早于目标时刻"（两件事，别混）。
         */
        const fireNotEarly = (): void => {
          const remaining = at - Date.now()
          if (remaining <= 0) {
            void fire()
            return
          }
          const late = setTimeout(() => {
            void fire()
          }, remaining)
          /* `unref`：不能让这个补足的定时器把进程钉住 */
          if (typeof late.unref === 'function') late.unref()
        }
        const job = new Cron(new Date(at), { timezone: options.timeZone, unref: true }, () => {
          /* ⚠️ 一次性作业触发后**自己**从表里消失（`stop()` 之后不再占位） */
          jobs.delete(name)
          fireNotEarly()
        })
        const planned = job.nextRun()
        if (planned === null) {
          /*
           * ⚠️ 到这一步说明"预判"漏了（例如两次调用之间时钟跨过了那一秒）。
           *    如实取消并具名 —— **绝不**留一个永远不会响的作业。
           */
          job.stop()
          return { ok: false, code: 'croner_next_run_null' }
        }
        jobs.set(name, job)
        return { ok: true, nextRunAt: planned.getTime() }
      } catch (error) {
        options.onReading?.({
          event: 'croner_arm_failed',
          name,
          detail: error instanceof Error ? error.message : String(error),
        })
        return { ok: false, code: 'croner_arm_failed' }
      }
    },

    armEvery(name, intervalMs, fire) {
      cancelNamed(name)
      if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
        /* 下界 = 1 秒：比这更密的周期 tick 没有意义（而且会把事件循环打满） */
        return { ok: false, code: 'croner_interval_too_small' }
      }
      /*
       * ⚠️ 实测踩到的：第一版把**任何**间隔都塞进**秒**字段（`*​/N * * * * *`），
       *    而关心机会的间隔是 **30 分钟** = 1800 秒 —— 秒字段只接受 0–59
       *    ⇒ Croner 抛错 ⇒ 如实报 `care_arm_refused: croner_arm_failed`，
       *      于是**关心 tick 永远不会排上**（只有个读数值，没有说明它为什么没排）。
       *    ⇒ 按量级选字段：< 60 秒走秒字段，否则走**分钟**字段（整分起）。
       */
      const seconds = Math.round(intervalMs / 1_000)
      const minutes = Math.round(intervalMs / 60_000)
      let pattern: string
      if (intervalMs < 60_000) {
        pattern = `*/${String(seconds)} * * * * *`
      } else if (minutes >= 1 && minutes <= 59 && Math.abs(minutes * 60_000 - intervalMs) < 1_000) {
        pattern = `0 */${String(minutes)} * * * *`
      } else {
        /* 不是整分钟、或者超过 59 分钟 ⇒ 具名拒绝（**不**造一个表达不了它的 pattern） */
        return { ok: false, code: 'croner_interval_not_expressible' }
      }
      try {
        const job = new Cron(pattern, { timezone: options.timeZone, unref: true }, () => {
          void fire()
        })
        jobs.set(name, job)
        return { ok: true }
      } catch (error) {
        options.onReading?.({
          event: 'croner_arm_failed',
          name,
          detail: error instanceof Error ? error.message : String(error),
        })
        return { ok: false, code: 'croner_arm_failed' }
      }
    },

    cancel(name) {
      cancelNamed(name)
    },

    nextRunAt(name) {
      const job = jobs.get(name)
      if (job === undefined) return null
      return job.nextRun()?.getTime() ?? null
    },

    stopAll() {
      for (const name of [...jobs.keys()]) cancelNamed(name)
    },
  }
}
