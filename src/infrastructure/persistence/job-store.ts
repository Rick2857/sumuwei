/**
 * 后台任务 / 幂等存储 / 高水位的持久化。
 *
 * ============================================================================
 *  这三张表一起构成"重跑安全"的基础
 * ============================================================================
 *   character_jobs         —— 这次处理做没做、做到哪、失败几次
 *   processed_operations   —— 这个操作是不是已经生效过（幂等的最终裁判）
 *   processor_watermarks   —— 我连续处理到哪个序号了（断点续跑与批处理基准）
 *
 * M2.5 不实现调度器（plan 第 36 节：Runtime 已有 Job 系统就 Adapter，
 * 没有就至少定义 Contract）。这里先把**存储**建好，Phase F/G 的诊断纵切
 * 直接使用它，M4 的 Memory Processor 接入时不需要再改表。
 */

import { sql } from 'drizzle-orm'

import {
  KernelError,
  assertTriggerEnabledInM3_5,
  assertWatermarkAdvances,
  triggerKindOf,
  type CharacterId,
  type CharacterJob,
  type JobId,
  type JobStatus,
  type ProcessorWatermark,
  type Timestamp,
  type TriggerKind,
  asCharacterId,
  asJobId,
  newJobId,
} from '../../kernel/contracts/index.ts'
import { affectedRows, asRows, exec, firstRow, type RawDb } from './db.ts'

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

interface JobRow {
  id: string
  character_id: string
  processor: string
  processor_version: string
  source_from_sequence: number
  source_to_sequence: number
  idempotency_key: string
  status: string
  retry_count: number
  last_error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  // --- M3.5（迁移 0004）：触发种类。旧行由数据库默认值补齐 ----------------
  trigger_kind?: string | null
}

function rowToJob(row: JobRow | undefined): CharacterJob | undefined {
  if (!row) return undefined
  return {
    id: asJobId(String(row.id)),
    characterId: asCharacterId(String(row.character_id)),
    processor: String(row.processor),
    processorVersion: String(row.processor_version),
    // M3.5：列一定存在（迁移 0004 有 not null default），但读取仍容错 ——
    // 迁移之前写入的行若在某条只读路径上被读到，不能因为少一列而炸掉。
    ...(row.trigger_kind !== null && row.trigger_kind !== undefined
      ? { triggerKind: String(row.trigger_kind) as TriggerKind }
      : {}),
    sourceFromSequence: Number(row.source_from_sequence),
    sourceToSequence: Number(row.source_to_sequence),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as JobStatus,
    retryCount: Number(row.retry_count),
    lastError: row.last_error ?? undefined,
    createdAt: Number(row.created_at),
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  }
}

export interface EnqueueJobInput {
  characterId: CharacterId
  processor: string
  processorVersion: string
  sourceFromSequence: number
  sourceToSequence: number
  idempotencyKey: string
  /**
   * M3.5：由什么触发（缺省 `conversation`）。
   *
   * `schedule` / `environment` / `external_event` 已在枚举里登记，
   * 但 **M3.5 没有调度器能产出它们** —— 传进来会被
   * `assertTriggerEnabledInM3_5` 直接拒绝（失败关闭，而不是悄悄写成
   * 一条"看起来像定时任务"的对话任务）。
   */
  triggerKind?: TriggerKind
  now?: Timestamp
}

export interface EnqueueResult {
  job: CharacterJob
  /** false = 同一个幂等键已有未失败的任务，本次没有新建 */
  created: boolean
}

/**
 * 入队。
 *
 * 幂等键上的**部分唯一索引**（只覆盖 pending/running/completed）让
 * "已完成的活不会被重复排期"，同时允许失败任务重建 —— 否则一次失败
 * 会把这个幂等键永久钉死，重试反而做不了。
 */
export async function enqueueJob(db: RawDb, input: EnqueueJobInput): Promise<EnqueueResult> {
  /*
   * ⚠️ **触发闸必须在提前返回之前**（post-Lv2 / ADR-110 `D02` 修的一个既有洞）。
   *
   * 旧顺序是"先按幂等键查 → 命中非 failed 就 return → 才过闸"，于是：
   * ```text
   * 只要同一个幂等键已经有一行非 failed 的作业，
   * 后面无论传什么 triggerKind 都会**直接返回那一行** ⇒ 闸根本没跑。
   * ```
   * 表现为"撞键即绕过触发闸"。它今天不构成越权（既有调用点全是 `conversation`），
   * 但**新的具名许可会把这条洞放大**：一个 `schedule` 请求只要撞上键就能悄悄通过。
   *
   * ⇒ 判据是**声明出来的那个 kind**（与最终落库的 kind 逐字相同），
   *   而且**两条路径都跑同一处断言** —— 只有一处放行口。
   */
  const declaredKind = input.triggerKind ?? 'conversation'
  assertTriggerEnabledInM3_5(declaredKind, input.processor)

  const existing = await findJobByIdempotencyKey(db, input.idempotencyKey)
  if (existing && existing.status !== 'failed') return { job: existing, created: false }

  const job: CharacterJob = {
    id: newJobId(),
    characterId: input.characterId,
    processor: input.processor,
    processorVersion: input.processorVersion,
    // M3.5：缺省 = conversation。旧语义就是"对话驱动"，因此这个缺省
    // 是对既有事实的如实登记，而不是猜测。
    triggerKind: declaredKind,
    sourceFromSequence: input.sourceFromSequence,
    sourceToSequence: input.sourceToSequence,
    idempotencyKey: input.idempotencyKey,
    status: 'pending',
    retryCount: existing ? existing.retryCount + 1 : 0,
    createdAt: input.now ?? Date.now(),
  }

  const rows = await exec(
    db,
    sql`insert into character_jobs
          (id, character_id, processor, processor_version, source_from_sequence,
           source_to_sequence, idempotency_key, status, retry_count, created_at, trigger_kind)
        values (${job.id}, ${job.characterId}, ${job.processor}, ${job.processorVersion},
                ${job.sourceFromSequence}, ${job.sourceToSequence}, ${job.idempotencyKey},
                ${job.status}, ${job.retryCount}, ${job.createdAt},
                ${triggerKindOf(job)})
        returning *`,
    '入队任务'
  )

  return { job: rowToJob(firstRow<JobRow>(rows))!, created: true }
}

export async function findJobByIdempotencyKey(
  db: RawDb,
  key: string
): Promise<CharacterJob | undefined> {
  const rows = await exec(
    db,
    sql`select * from character_jobs where idempotency_key = ${key}
        order by created_at desc limit 1`,
    '按幂等键读取任务'
  )
  return rowToJob(firstRow<JobRow>(rows))
}

export async function getJob(db: RawDb, id: JobId): Promise<CharacterJob | undefined> {
  const rows = await exec(db, sql`select * from character_jobs where id = ${id} limit 1`, '读取任务')
  return rowToJob(firstRow<JobRow>(rows))
}

export async function markJobRunning(db: RawDb, id: JobId, now = Date.now()): Promise<void> {
  const affected = await affectedRows(
    db,
    sql`update character_jobs set status = 'running', started_at = ${now}
        where id = ${id} and status = 'pending'
        returning id`,
    '标记任务运行中'
  )
  if (affected === 0) {
    const job = await getJob(db, id)
    throw new KernelError(
      'validation_error',
      'job_not_pending',
      `任务 ${id} 不是 pending 状态（当前 ${job?.status ?? '(不存在)'}），不能开始运行`
    )
  }
}

/**
 * 把 `error` 与**闭集具名** `cause` 拼成 `last_error` 那一格的内容。
 *
 * 抽成**纯函数**是为了能被门直接单测（`finishJob` 本身要一个已打开的库）。
 *
 * 三条性质，任何一条被改坏都必须被门抓住：
 * ① **不传 `cause` ⇒ 逐字返回 `error`**（既有调用方与既有读数完全不受影响）；
 * ② 不传 `error` ⇒ `undefined`（那一格写 `null`，与今天一致）；
 * ③ `cause` 为**空串**时视同**不传**（`''` 不该产生 `xxx:` 这种半截串）。
 */
export function composeJobError(error: string | undefined, cause: string | undefined): string | undefined {
  if (error === undefined) return undefined
  if (cause === undefined || cause === '') return error
  return `${error}:${cause}`
}

/**
 * 结束一个任务。
 *
 * ⚠️ `cause`（2026-10-16 新增，**可选**）：`last_error` 是**单列**，所以原因以
 *   `'<error>:<cause>'` 的形式**拼接**在同一格里（规则见 `composeJobError`）。
 *   `cause` 必须是**闭集具名码**，**不是**异常原文（隐私纪律见调用点）。
 */
export async function finishJob(
  db: RawDb,
  id: JobId,
  status: Extract<JobStatus, 'completed' | 'failed'>,
  options: { error?: string; now?: Timestamp; cause?: string } = {}
): Promise<void> {
  const composed = composeJobError(options.error, options.cause)
  await exec(
    db,
    sql`update character_jobs
        set status = ${status}, finished_at = ${options.now ?? Date.now()},
            last_error = ${composed ?? null}
        where id = ${id}
        returning id`,
    '结束任务'
  )
}

export async function listJobs(
  db: RawDb,
  characterId: CharacterId,
  options: { status?: JobStatus; limit?: number } = {}
): Promise<CharacterJob[]> {
  const rows = await exec(
    db,
    sql`select * from character_jobs
        where character_id = ${characterId}
          ${options.status === undefined ? sql`` : sql`and status = ${options.status}`}
        order by created_at desc
        limit ${Math.max(1, Math.min(500, options.limit ?? 50))}`,
    '列出任务'
  )
  return asRows<JobRow>(rows).map((r) => rowToJob(r)!)
}

// ---------------------------------------------------------------------------
// 幂等存储
// ---------------------------------------------------------------------------

/** 该幂等键是否已经成功生效过（Validator 的 `Idempotency` 检查） */
export async function hasProcessedOperation(db: RawDb, key: string): Promise<boolean> {
  const rows = await exec(
    db,
    sql`select 1 as one from processed_operations where idempotency_key = ${key} limit 1`,
    '幂等查询'
  )
  return rows.length > 0
}

/**
 * 幂等查询口的**构造器**。
 *
 * Processor 需要在提案之前自查"这件事我做过没有"，
 * 而它拿到的应该是**能力**（一个 hasProcessed 函数），不是整个数据库句柄。
 * 这样"Processor 只能问、不能改"是结构性的。
 */
export function createProcessedOperationStore(db: RawDb): {
  hasProcessed: (key: string) => Promise<boolean>
} {
  return {
    hasProcessed: (key: string) => hasProcessedOperation(db, key),
  }
}

export interface ProcessedOperationRecord {
  idempotencyKey: string
  characterId: CharacterId
  processor: string
  processorVersion: string
  operation: string
  domainEventId?: string
  processedAt: number
}

export async function listProcessedOperations(
  db: RawDb,
  characterId: CharacterId,
  limit = 50
): Promise<ProcessedOperationRecord[]> {
  const rows = await exec(
    db,
    sql`select * from processed_operations where character_id = ${characterId}
        order by processed_at desc limit ${Math.max(1, Math.min(500, limit))}`,
    '列出已处理操作'
  )
  return rows.map((r) => ({
    idempotencyKey: String(r.idempotency_key),
    characterId: asCharacterId(String(r.character_id)),
    processor: String(r.processor),
    processorVersion: String(r.processor_version),
    operation: String(r.operation),
    domainEventId: r.domain_event_id ? String(r.domain_event_id) : undefined,
    processedAt: Number(r.processed_at),
  }))
}

/**
 * 写入一条已处理操作（M8.5 WP6 / ADR-068 M85-D20）。
 *
 * 与 `hasProcessedOperation` 对偶的**写侧**：语义评估的终结闸
 * （`affect-semantic-finalized:<sourceEventId>`）与紧凑回执编码落在
 * `processed_operations`——无 DomainEvent 的终态（NO_IMPACT / EXPIRED / …）
 * 也必须有可审计的持久收据。
 *
 * · `on conflict do nothing`：键已存在 ⇒ `recorded: false`（天然幂等，
 *   与 `applyAcceptedEvents` 的记幂等行为一致）。
 * · **原子性由调用方的事务保证**：与 DomainEvent 追加同事务时，
 *   传事务句柄（`RawDb` 兼容 tx）——闸与终态要么都落、都不落。
 */
export interface RecordProcessedOperationInput {
  idempotencyKey: string
  characterId: CharacterId
  processor: string
  processorVersion: string
  operation: string
  domainEventId?: string
}

export async function recordProcessedOperation(
  db: RawDb,
  input: RecordProcessedOperationInput,
  now: number = Date.now()
): Promise<{ recorded: boolean }> {
  const rows = await exec(
    db,
    sql`insert into processed_operations
          (idempotency_key, character_id, processor, processor_version, operation,
           domain_event_id, processed_at)
        values (${input.idempotencyKey}, ${input.characterId}, ${input.processor},
                ${input.processorVersion}, ${input.operation}, ${input.domainEventId ?? null},
                ${now})
        on conflict (idempotency_key) do nothing
        returning idempotency_key`,
    '记录已处理操作（独立写侧）'
  )
  return { recorded: rows.length > 0 }
}

// ---------------------------------------------------------------------------
// 水位
// ---------------------------------------------------------------------------

export async function getWatermark(
  db: RawDb,
  characterId: CharacterId,
  processor: string,
  processorVersion: string
): Promise<ProcessorWatermark | undefined> {
  const rows = await exec(
    db,
    sql`select * from processor_watermarks
        where character_id = ${characterId}
          and processor = ${processor}
          and processor_version = ${processorVersion}
        limit 1`,
    '读取水位'
  )
  const row = rows[0]
  if (!row) return undefined
  return {
    characterId: asCharacterId(String(row.character_id)),
    processor: String(row.processor),
    processorVersion: String(row.processor_version),
    processedThroughSequence: Number(row.processed_through_sequence),
    updatedAt: Number(row.updated_at),
  }
}

/** 推进水位。**只许前进**（回退会导致事件被重复处理）。 */
export async function advanceWatermark(
  db: RawDb,
  characterId: CharacterId,
  processor: string,
  processorVersion: string,
  throughSequence: number,
  now = Date.now()
): Promise<ProcessorWatermark> {
  const current = await getWatermark(db, characterId, processor, processorVersion)
  assertWatermarkAdvances(current, throughSequence)

  await exec(
    db,
    sql`insert into processor_watermarks
          (character_id, processor, processor_version, processed_through_sequence, updated_at)
        values (${characterId}, ${processor}, ${processorVersion}, ${throughSequence}, ${now})
        on conflict (character_id, processor, processor_version) do update set
          processed_through_sequence = excluded.processed_through_sequence,
          updated_at = excluded.updated_at
        returning *`,
    '推进水位'
  )

  const updated = await getWatermark(db, characterId, processor, processorVersion)
  return updated!
}
