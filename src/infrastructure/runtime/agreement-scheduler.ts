/**
 * M10.1 WP2b —— **约定识别的慢路径调度**（`D02`：有界窗口 + 一次模型调用 + 严格校验）。
 *
 * ============================================================================
 *  它与 M11 的反思调度器**同形**，但**不共用**
 * ============================================================================
 * ```text
 * 共用的部分**已经**是共用的：作业行 / 水位 / 幂等键 / 晚写闸门都住在
 *   `job-store.ts`（`enqueueJob` · `markJobRunning` · `finishJob` ·
 *   `findJobByIdempotencyKey` · `getWatermark` · `advanceWatermark`）——
 *   本文件**不**复制它们，只编排。
 * 不共用的部分：**窗口规划**与**草稿类型**（反思按 `planReflectionWindow` 划序列区间、
 *   草稿是反思草案；约定窗口是"最近 N 条原始对话 + 序号引用"）。
 *   ⇒ 把两者硬并成一个函数会让"M11 的窗口语义"与"约定窗口语义"互相牵制，
 *     而两者都由各自的里程碑冻结过。
 * ```
 *
 * ============================================================================
 *  五条硬性质（照抄 M11 的，理由同源）
 * ============================================================================
 * ```text
 * ① **一次性 cutover**（`D33`）：水位行不存在 ⇒ 把边界**预置**成调用方给的 `cutoverSequence`，
 *    本次**不消费** ⇒ **不回判历史**。
 * ② **失败不抛、水位不前进**：尾窗下一轮重新覆盖（补洞），但任务行必须**如实落 `failed`**。
 * ③ **同窗不并发**：幂等键含 `[from,to]` ⇒ 同窗第二次调用要么 `already_running`、要么
 *    `recovered`（活干完了只补水位，**不**重跑 ⇒ 不产生第二份业务事件）。
 * ④ **晚写闸门**：收尾期间（`fence.closed`）一切写入拒绝，如实记 `cancelled`。
 * ⑤ **不改历史**：只从水位往后读；一个字节都不回写。
 * ```
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { LateWriteFence } from '../../kernel/app/reflection/late-write-fence.ts'
import {
  advanceWatermark,
  enqueueJob,
  findJobByIdempotencyKey,
  finishJob,
  getWatermark,
  listJobs,
  markJobRunning,
} from '../persistence/job-store.ts'
import { computeIdempotencyKey } from '../../kernel/contracts/job.ts'
import type { RawDb } from '../persistence/db.ts'

export const AGREEMENT_PROCESSOR = 'agreement-scheduler'
export const AGREEMENT_PROCESSOR_VERSION = 'agreement-scheduler@1'

/** 仅在独占开库后调用；此前的在飞任务已没有所属进程。 */
export async function recoverRunningAgreementJobs(db: RawDb, characterId: CharacterId, now = Date.now(), fence?: LateWriteFence): Promise<number> {
  const jobs = (await listJobs(db, characterId)).filter(job => job.processor === AGREEMENT_PROCESSOR && job.status === 'running')
  for (const job of jobs) await writeWhileOpen(db, fence, tx => finishJob(tx, job.id, 'failed', { error: 'agreement_process_restarted', now }))
  return jobs.length
}

/** 一次窗口：**原始条目**（装配与遮蔽在 runner 里做） */
export interface AgreementWindowPlan {
  readonly entries: readonly {
    readonly id: string
    readonly actorType: string
    readonly sequence: number
    readonly text: string
    readonly contentUnavailable?: boolean
  }[]
  readonly fromSequence: number
  readonly toSequence: number
}

export interface AgreementSchedulerPorts {
  /** 账本里**角色级**最大事件序号（没有事件时为 0） */
  latestSequence(): Promise<number>
  /** 读一段窗口（**有界由调用方负责**；本函数只规划） */
  readWindow(from: number, latest: number): Promise<readonly AgreementWindowPlan['entries'][number][]>
  /** 真正干活（一次模型调用 + 形状闸 + 语义闸 + 放行口 + 写） */
  run(window: AgreementWindowPlan): Promise<AgreementRunResult>
}

/** 一次执行段的结论（与 runner 的 `AgreementRunKind` 同集；`truncated`/`fenced` 也是结论，不是失败） */
export interface AgreementRunResult {
  readonly kind:
    | 'written'
    | 'already_applied'
    | 'no_agreement'
    | 'rejected'
    | 'invalid'
    | 'empty'
    | 'truncated'
    | 'fenced'
  readonly reason?: string
  readonly detail?: string
  readonly eventsWritten?: number
}

export type AgreementSchedulerOutcome =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'no_tail'; readonly watermark: number; readonly latest: number }
  | { readonly kind: 'cutover_preset'; readonly watermark: number; readonly latest: number }
  | {
      readonly kind: 'ran'
      readonly jobId: string
      readonly toSequence: number
      readonly result: AgreementRunResult['kind']
      readonly reason?: string
    }
  | { readonly kind: 'recovered'; readonly jobId: string; readonly toSequence: number }
  | { readonly kind: 'failed'; readonly jobId: string; readonly watermark: number; readonly detail: string }
  | { readonly kind: 'already_running'; readonly jobId: string }
  | { readonly kind: 'retry_deferred'; readonly jobId: string; readonly retryAfter: number }
  | { readonly kind: 'cancelled'; readonly watermark: number }

export interface MaybeRunAgreementInput {
  readonly characterId: CharacterId
  readonly processorVersion?: string
  /** 首次 cutover 的边界（`D33`：**不**回判全部历史） */
  readonly cutoverSequence: number
  readonly ports: AgreementSchedulerPorts
  readonly now?: number
  readonly fence?: LateWriteFence
}

/** 晚写闸门下的写（与 M11 同形：**事务内前后各问一次**） */
async function writeWhileOpen<T>(
  db: RawDb,
  fence: LateWriteFence | undefined,
  write: (tx: RawDb) => Promise<T>
): Promise<T> {
  if (db.transaction === undefined) throw new Error('agreement_scheduler_transaction_unavailable')
  return db.transaction(async (tx) => {
    const assertOpen = (): void => {
      if (fence?.closed) {
        fence.noteRefused()
        throw new Error('late_write_fenced')
      }
    }
    assertOpen()
    const result = await write(tx)
    assertOpen()
    return result
  })
}

/** 一次"也许跑一次"的慢路径调度 */
export async function maybeRunAgreementEvaluation(
  db: RawDb,
  input: MaybeRunAgreementInput
): Promise<AgreementSchedulerOutcome> {
  const now = input.now ?? Date.now()
  const processorVersion = input.processorVersion ?? AGREEMENT_PROCESSOR_VERSION
  if (input.fence?.closed) return { kind: 'cancelled', watermark: input.cutoverSequence }

  const stored = await getWatermark(db, input.characterId, AGREEMENT_PROCESSOR, processorVersion)
  const latest = await input.ports.latestSequence()

  /* ---- ① 一次性 cutover（`D33`）：预置边界，本次不消费 ---- */
  if (stored === undefined) {
    await writeWhileOpen(db, input.fence, (tx) =>
      advanceWatermark(
        tx,
        input.characterId,
        AGREEMENT_PROCESSOR,
        processorVersion,
        input.cutoverSequence,
        now
      )
    )
    return { kind: 'cutover_preset', watermark: input.cutoverSequence, latest }
  }

  const watermark = stored.processedThroughSequence
  if (latest <= watermark) return { kind: 'no_tail', watermark, latest }

  const entries = await input.ports.readWindow(watermark, latest)
  if (entries.length === 0) return { kind: 'no_tail', watermark, latest }
  const window: AgreementWindowPlan = {
    entries,
    fromSequence: watermark,
    toSequence: latest,
  }

  const idempotencyKey = computeIdempotencyKey({
    characterId: input.characterId,
    processor: AGREEMENT_PROCESSOR,
    processorVersion,
    sourceFromSequence: watermark,
    sourceToSequence: latest,
    operation: 'agreement-window',
  })

  const previous = await findJobByIdempotencyKey(db, idempotencyKey)
  if (
    previous?.status === 'failed' &&
    now < (previous.finishedAt ?? previous.createdAt) + 60_000
  ) {
    return {
      kind: 'retry_deferred',
      jobId: String(previous.id),
      retryAfter: (previous.finishedAt ?? previous.createdAt) + 60_000,
    }
  }
  if (input.fence?.closed) return { kind: 'cancelled', watermark }

  if (previous?.status === 'completed') {
    /* 活干完了：只补水位，**不**重跑（否则会产生第二份业务事件） */
    await writeWhileOpen(db, input.fence, (tx) =>
      advanceWatermark(tx, input.characterId, AGREEMENT_PROCESSOR, processorVersion, latest, now)
    )
    return { kind: 'recovered', jobId: String(previous.id), toSequence: latest }
  }
  if (previous?.status === 'running') {
    return { kind: 'already_running', jobId: String(previous.id) }
  }

  const enqueued = await writeWhileOpen(db, input.fence, (tx) =>
    enqueueJob(tx, {
      characterId: input.characterId,
      processor: AGREEMENT_PROCESSOR,
      processorVersion,
      sourceFromSequence: watermark,
      sourceToSequence: latest,
      idempotencyKey,
      triggerKind: 'conversation',
      now,
    })
  )
  return await runJob(db, enqueued.job.id, window, {
    characterId: input.characterId,
    processorVersion,
    now,
    fence: input.fence,
    ports: input.ports,
  })
}

async function runJob(
  db: RawDb,
  jobId: Parameters<typeof markJobRunning>[1],
  window: AgreementWindowPlan,
  input: {
    readonly characterId: CharacterId
    readonly processorVersion: string
    readonly now?: number
    readonly fence?: LateWriteFence
    readonly ports: AgreementSchedulerPorts
  }
): Promise<AgreementSchedulerOutcome> {
  await writeWhileOpen(db, input.fence, (tx) => markJobRunning(tx, jobId, input.now ?? Date.now()))
  let result: AgreementRunResult
  try {
    result = await input.ports.run(window)
    if (input.fence?.closed) {
      return { kind: 'cancelled', watermark: window.fromSequence }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (input.fence?.closed) return { kind: 'cancelled', watermark: window.fromSequence }
    /*
     * ⚠️ **失败不抛、水位不前进**（尾窗下一轮重新覆盖 = 补洞），
     *    但任务行必须**如实落 failed** —— 留 `running` 会让同窗重试撞 `job_not_pending`，
     *    于是"补洞"永远走不通（M8 WP7 的教训）。
     */
    try {
      await writeWhileOpen(db, input.fence, (tx) =>
        finishJob(tx, jobId, 'failed', { error: detail, now: input.now ?? Date.now() })
      )
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

  await writeWhileOpen(db, input.fence, async (tx) => {
    await finishJob(tx, jobId, 'completed', { now: input.now ?? Date.now() })
    await advanceWatermark(
      tx,
      input.characterId,
      AGREEMENT_PROCESSOR,
      input.processorVersion,
      window.toSequence,
      input.now ?? Date.now()
    )
  })
  return {
    kind: 'ran',
    jobId: String(jobId),
    toSequence: window.toSequence,
    result: result.kind,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  }
}
