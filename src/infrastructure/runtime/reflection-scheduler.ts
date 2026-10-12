/**
 * M11 WP7 —— **反思慢路径调度**（ADR-085 §7.1 · §7.2 · `D15` · `D16` · `D17`）。
 *
 * ============================================================================
 *  它**复用**既有生命周期，不建第二套后台服务
 * ============================================================================
 * ```text
 * 水位（processor_watermarks）→ 有尾巴？ → enqueueJob → markJobRunning → run
 *                              ↘ no_tail（不调模型）      ↘ catch ⇒ finishJob('failed')
 *                                                        ↘ 成功 ⇒ finishJob('completed') + 前进水位
 * ```
 * ⚠️ **不是守护进程**：与既有各域一样，它是挂在 `open` / `send` 两个既有钩子上的
 *    "maybe-run 一次"（源码逐字：`turn hook ≠ 新建自主后台任务…没有定时器`）。
 *
 * ============================================================================
 *  三条必须被证明的性质（都是本仓库真实踩过的坑）
 * ============================================================================
 * ① **catch 必须落 `failed`**：否则任务行留在 running ⇒ 下次同窗重试撞 `job_not_pending`
 *    ⇒ **永久楔死**（M8 WP7 / M7 的 `L-M8-13` 修复形状）。
 * ② **失败不前进水位**：尾窗被下一轮重新覆盖（补洞）—— 这正是"可恢复"的含义。
 * ③ **同窗已完成 ⇒ 只补水位，不重跑**（`recovered`）：活已经干完了，重跑会产生第二份业务事件。
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { computeIdempotencyKey } from '../../kernel/contracts/job.ts'
import {
  planReflectionWindow,
  type ReflectionWindowEvent,
  type ReflectionWindowPlan,
} from '../../kernel/app/reflection/job.ts'
import {
  advanceWatermark,
  enqueueJob,
  findJobByIdempotencyKey,
  finishJob,
  getWatermark,
  listJobs,
  markJobRunning,
} from '../persistence/job-store.ts'
import type { RawDb } from '../persistence/db.ts'
import type { ReflectionRunnerOutcome } from './reflection-runner.ts'
import type { LateWriteFence } from '../../kernel/app/reflection/late-write-fence.ts'

export const REFLECTION_PROCESSOR = 'reflection-scheduler'

/** Called once after the application's exclusive database open; old in-flight work has no owner. */
export async function recoverRunningReflectionJobs(db: RawDb, characterId: CharacterId, now = Date.now(), fence?: LateWriteFence): Promise<number> {
  const jobs = (await listJobs(db, characterId)).filter(job => job.processor === REFLECTION_PROCESSOR && job.status === 'running')
  for (const job of jobs) await writeWhileOpen(db, fence, tx => finishJob(tx, job.id, 'failed', { error: 'reflection_process_restarted', now }))
  return jobs.length
}

/** Close may arrive during any persistence await; rollback the entire transition. */
async function writeWhileOpen<T>(db: RawDb, fence: LateWriteFence | undefined, write: (tx: RawDb) => Promise<T>): Promise<T> {
  if (db.transaction === undefined) throw new Error('reflection_scheduler_transaction_unavailable')
  return db.transaction(async tx => {
    const assertOpen = () => { if (fence?.closed) { fence.noteRefused(); throw new Error('late_write_fenced') } }
    assertOpen()
    const result = await write(tx)
    assertOpen()
    return result
  })
}

export interface ReflectionSchedulerPorts {
  /** 当前最新的领域事件序号（没有事件时为 0） */
  latestSequence(): Promise<number>
  /** 读一段窗口事件（有界由调用方负责；本函数只规划） */
  readWindow(from: number, latest: number): Promise<readonly ReflectionWindowEvent[]>
  /** 真正干活（WP3 的输入装配 + WP4 的候选/审查都在这里被调用） */
  run(window: ReflectionWindowPlan): Promise<void | ReflectionRunnerOutcome>
}

export type ReflectionSchedulerOutcome =
  | { readonly kind: 'no_tail'; readonly watermark: number; readonly latest: number }
  /**
   * **首次建立 cutover**（`D33`）：水位行不存在 ⇒ 把边界**预置**成调用方给的 `cutoverSequence`，
   * 本次**不消费**。
   *
   * ⚠️ 为什么必须有这一档：水位行不存在时若直接按 0 起读，第一次就会**回判全部历史**
   *    （违反 `D33`）；而若只是"不建行、直接 no_tail"，水位永远建不起来 ⇒ 慢路径**永不运行**。
   *    ⇒ 预置 + 本次不消费：边界一旦落地就是**一次性**的，之后的窗口从它往后走。
   */
  | { readonly kind: 'cutover_preset'; readonly watermark: number; readonly latest: number }
  | { readonly kind: 'ran'; readonly jobId: string; readonly toSequence: number; readonly skipped: number }
  | { readonly kind: 'recovered'; readonly jobId: string; readonly toSequence: number }
  | { readonly kind: 'failed'; readonly jobId: string; readonly watermark: number; readonly detail: string }
  | { readonly kind: 'already_running'; readonly jobId: string }
  | { readonly kind: 'retry_deferred'; readonly jobId: string; readonly retryAfter: number }
  | { readonly kind: 'cancelled'; readonly watermark: number }

export interface MaybeRunReflectionInput {
  readonly characterId: CharacterId
  readonly processorVersion: string
  /** 首次 cutover 的序号边界（`D33`：**不**回判全部历史） */
  readonly cutoverSequence: number
  readonly ports: ReflectionSchedulerPorts
  readonly now?: number
  readonly fence?: LateWriteFence
}

/** 一次"也许跑一次"的慢路径调度 */
export async function maybeRunReflectionEvaluation(
  db: RawDb,
  input: MaybeRunReflectionInput
): Promise<ReflectionSchedulerOutcome> {
  const now = input.now ?? Date.now()
  if (input.fence?.closed) return { kind: 'cancelled', watermark: input.cutoverSequence }
  const processorVersion = input.processorVersion

  const stored = await getWatermark(db, input.characterId, REFLECTION_PROCESSOR, processorVersion)
  const latest = await input.ports.latestSequence()

  /*
   * **首次建立 cutover**（`D33`）：水位行不存在 ⇒ 预置边界，本次不消费。
   * ⚠️ 这是"不回判全部历史"与"慢路径真的会跑"两件事的**唯一**交点：
   *    只 no_tail 不建行 ⇒ 永不运行；按 0 起读 ⇒ 回判历史。
   */
  if (stored === undefined) {
    await writeWhileOpen(db, input.fence, tx => advanceWatermark(
      tx,
      input.characterId,
      REFLECTION_PROCESSOR,
      processorVersion,
      input.cutoverSequence,
      now
    ))
    return { kind: 'cutover_preset', watermark: input.cutoverSequence, latest }
  }

  // ⚠️ 水位缺省 = **cutover**（不是 0）：首次建立之后才看，**不**回判激活前的全部历史（`D33`）
  const watermark = stored.processedThroughSequence

  if (latest <= watermark) return { kind: 'no_tail', watermark, latest }

  const events = await input.ports.readWindow(watermark, latest)
  const window = planReflectionWindow({ events, watermark, latest })
  if (!window.hasTail) return { kind: 'no_tail', watermark, latest }

  const idempotencyKey = computeIdempotencyKey({
    characterId: input.characterId,
    processor: REFLECTION_PROCESSOR,
    processorVersion,
    sourceFromSequence: window.fromSequence,
    sourceToSequence: window.toSequence,
    operation: 'reflection-window',
  })

  const previous = await findJobByIdempotencyKey(db, idempotencyKey)
  if (previous?.status === 'failed' && now < (previous.finishedAt ?? previous.createdAt) + 60_000) {
    return { kind: 'retry_deferred', jobId: String(previous.id), retryAfter: (previous.finishedAt ?? previous.createdAt) + 60_000 }
  }
  if (input.fence?.closed) return { kind: 'cancelled', watermark }

  const enqueued = await writeWhileOpen(db, input.fence, tx => enqueueJob(tx, {
    characterId: input.characterId,
    processor: REFLECTION_PROCESSOR,
    processorVersion,
    sourceFromSequence: window.fromSequence,
    sourceToSequence: window.toSequence,
    idempotencyKey,
    triggerKind: 'conversation',
    now,
  }))

  if (!enqueued.created) {
    const existing = await findJobByIdempotencyKey(db, idempotencyKey)
    if (existing?.status === 'completed') {
      // 活干完了：只补水位，不重跑（否则会产生第二份业务事件）
      await writeWhileOpen(db, input.fence, tx => advanceWatermark(
        tx,
        input.characterId,
        REFLECTION_PROCESSOR,
        processorVersion,
        window.toSequence,
        now
      ))
      return { kind: 'recovered', jobId: String(existing.id), toSequence: window.toSequence }
    }
    if (existing?.status === 'running') {
      // 同窗正在跑：不并发第二次（同窗重入由幂等键挡住）
      return { kind: 'already_running', jobId: String(existing.id) }
    }
    // failed：允许重建（部分唯一索引只覆盖 pending/running/completed）
    const rebuilt = await writeWhileOpen(db, input.fence, tx => enqueueJob(tx, {
      characterId: input.characterId,
      processor: REFLECTION_PROCESSOR,
      processorVersion,
      sourceFromSequence: window.fromSequence,
      sourceToSequence: window.toSequence,
      idempotencyKey,
      triggerKind: 'conversation',
      now,
    }))
    return await runJob(db, rebuilt.job.id, window, input, now)
  }

  return await runJob(db, enqueued.job.id, window, input, now)
}

async function runJob(
  db: RawDb,
  jobId: Parameters<typeof markJobRunning>[1],
  window: ReflectionWindowPlan,
  input: MaybeRunReflectionInput,
  now: number
): Promise<ReflectionSchedulerOutcome> {
  await writeWhileOpen(db, input.fence, tx => markJobRunning(tx, jobId, now))
  try {
    const outcome = await input.ports.run(window)
    if (outcome?.kind === 'format_invalid') throw new Error('reflection_draft_format_invalid')
    if (input.fence?.closed) return { kind: 'cancelled', watermark: window.fromSequence }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (input.fence?.closed) return { kind: 'cancelled', watermark: window.fromSequence }
    /*
     * ⚠️ **失败不抛、水位不前进**（尾窗下一轮重新覆盖 = 补洞），
     *    但任务行必须**如实落 failed** —— 留 running 会让下一次同窗重试撞
     *    `job_not_pending`，于是"补洞"永远走不通（M8 WP7 / M7 `L-M8-13` 的教训）。
     *    `finishJob` 自己失败（库已坏）则吞掉：主错误才是要报的。
     */
    try {
      await writeWhileOpen(db, input.fence, tx => finishJob(tx, jobId, 'failed', { error: detail, now: input.now ?? Date.now() }))
    } catch {
      /* 主错误优先 */
    }
    return {
      kind: 'failed',
      jobId: String(jobId),
      watermark: window.fromSequence,
      detail,
    }
  }

  if (input.fence?.closed) return { kind: 'cancelled', watermark: window.fromSequence }
  await writeWhileOpen(db, input.fence, async tx => {
  await finishJob(tx, jobId, 'completed', { now: input.now ?? Date.now() })
  await advanceWatermark(
    tx,
    input.characterId,
    REFLECTION_PROCESSOR,
    input.processorVersion,
    window.toSequence,
    now
  )
  })
  return {
    kind: 'ran',
    jobId: String(jobId),
    toSequence: window.toSequence,
    skipped: window.skipped.length,
  }
}
