import { sql } from 'drizzle-orm'
import { entityRef } from '../../kernel/contracts/entity.ts'
import { slotOfCandidate, slotOfRecord, type CharacterId, type EntityRef, type MemoryCandidate } from '../../kernel/contracts/index.ts'
import type { DomainEventRegistry } from '../../kernel/contracts/domain-event.ts'
import { processorEventViewOf, type MemoryExtractor } from '../../kernel/app/memory/extractor.ts'
import { runMemoryExtractionPipeline } from '../../kernel/app/memory/pipeline.ts'
import { createMemoryMutationValidator } from '../../kernel/policies/memory-validator.ts'
import { createLateWriteFence } from '../../kernel/app/reflection/late-write-fence.ts'
import { exec, type RawDb } from '../persistence/db.ts'
import { conversationEventsInRange, findEventRefs, latestCharacterEventSequence } from '../persistence/conversation-store.ts'
import { applyAcceptedEvents } from '../persistence/event-store.ts'
import { createNativeMemoryStore } from '../persistence/memory-store.ts'
import { scopeForConversation, scopeMemoryCandidate, withReadScope, withoutReadScope } from '../persistence/read-scope.ts'
import { advanceWatermark, enqueueJob, finishJob, getWatermark, hasProcessedOperation, markJobRunning } from '../persistence/job-store.ts'
import { AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION, LangMemWorkerFailure } from '../model/langmem-memory-extractor.ts'
import { AUTOMATIC_MEMORY_FAILURE_LIMIT, automaticMemoryRetryCounts, automaticMemorySourceKey } from './automatic-memory-control.ts'

/**
 * 自动记忆失败的**具名原因**（闭集，2026-10-16）。
 *
 * ⚠️ 为什么加它：容量测试里出现 2 个 `automatic_memory_extraction_or_commit_failed`
 *   且**当时无法定位** —— 因为本文件原来写的是 `catch {}`，**异常被整个丢掉**。
 *   现在保留一个**闭集具名码**：它足够定位，且**不含任何用户内容**。
 *
 * 纪律（与本仓库既有做法同型）：
 * · 只放**具名码**与（worker 失败时的）**退出码**；
 * · **不放** stderr 正文、**不放** stdout、**不放**用户原话、**不放**模型回复。
 * · `unknown` 是**诚实的兜底**，不是"什么都塞进来"的口子。
 */
export type AutomaticMemoryFailureCause =
  | 'extractor_worker_timeout'
  | 'extractor_worker_cancelled'
  | 'extractor_worker_exit_nonzero'
  | 'extractor_worker_spawn_failed'
  | 'extractor_worker_output_over_budget'
  | 'extractor_worker_stdin_failed'
  | 'extractor_worker_aborted'
  | 'source_budget'
  | 'malformed_output'
  | 'transaction_unavailable'
  | 'late_write_fenced'
  | 'unknown'

/** 把一个异常映射成**闭集**具名码；**永远**不把 `error.message` 原文带出去。 */
export function automaticMemoryFailureCauseOf(error: unknown): AutomaticMemoryFailureCause {
  if (error instanceof LangMemWorkerFailure) {
    switch (error.reason) {
      case 'timeout': return 'extractor_worker_timeout'
      case 'cancelled': return 'extractor_worker_cancelled'
      case 'exit_nonzero': return 'extractor_worker_exit_nonzero'
      case 'spawn_failed': return 'extractor_worker_spawn_failed'
      case 'output_over_budget': return 'extractor_worker_output_over_budget'
      case 'stdin_failed': return 'extractor_worker_stdin_failed'
      default: return 'extractor_worker_aborted'
    }
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'extractor_worker_cancelled'
    switch (error.message) {
      case 'automatic_memory_source_budget': return 'source_budget'
      case 'automatic_memory_malformed_output': return 'malformed_output'
      case 'automatic_memory_transaction_unavailable': return 'transaction_unavailable'
      case 'late_write_fenced': return 'late_write_fenced'
      default: break
    }
  }
  return 'unknown'
}

export interface AutomaticMemoryReading {
  status: 'cutover' | 'completed' | 'failed' | 'retry_exhausted'
  throughSequence: number
  created: number
  /**
   * **U1 / `ADR-137` 写侧**：这一拍**新建**的记忆 id（**只在这一条真的带 id 时才出现**）。
   *
   * ⚠️ 为什么不能只靠 `created`（计数）：打标要知道**是哪几条**，计数不知道。
   *    缺省不出现 ⇒ 既有读数形状与下游逐字不变（先例：`shadow?` / `authorization?`）。
   */
  createdMemoryIds?: readonly string[]
  rejected: number
  blockedSourceSequence?: number
  failures?: number
  recoveries?: number
  /**
   * ⚠️ **只在 `status === 'failed'` 时出现**：这一拍的**闭集**具名失败原因。
   * 形状见 `AutomaticMemoryFailureCause`。**不含任何用户内容。**
   * 加它的理由：那 2 个"定位不了"的失败（见 `automaticMemoryFailureCauseOf`）。
   */
  cause?: AutomaticMemoryFailureCause
}

/** A single shared consumer. Native ledger, jobs, validator, events and reducer stay authoritative. */
export class AutomaticMemoryConsumer {
  private readonly fence = createLateWriteFence()
  private inFlight: Promise<void> | undefined
  private notified = false

  constructor(private readonly input: {
    db: RawDb; characterId: CharacterId; speaker: EntityRef; registry: DomainEventRegistry
    ownerUserId?: string
    extractor: MemoryExtractor; onReading: (reading: AutomaticMemoryReading) => void
  }) {}

  async open(): Promise<void> {
    const { db, characterId } = this.input
    const watermark = await getWatermark(db, characterId, AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION)
    if (watermark === undefined) {
      const latest = await latestCharacterEventSequence(db, characterId)
      await advanceWatermark(db, characterId, AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION, latest)
      this.input.onReading({ status: 'cutover', throughSequence: latest, created: 0, rejected: 0 })
    }
    // The process owner lease excludes another live worker. A running row is a crashed run.
    const rows = await exec(db, sql`select id from character_jobs where character_id = ${characterId}
      and processor = ${AUTOMATIC_MEMORY_PROCESSOR} and processor_version = ${AUTOMATIC_MEMORY_VERSION}
      and status = 'running'`, 'recover automatic memory jobs')
    for (const row of rows) await finishJob(db, String(row.id) as never, 'failed', { error: 'worker_interrupted' })
    void this.drain()
  }

  drain(): Promise<void> {
    if (this.fence.closed) return Promise.resolve()
    this.notified = true
    if (this.inFlight) return this.inFlight
    this.inFlight = withoutReadScope(() => this.run()).finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  async close(): Promise<void> {
    this.fence.close()
    await this.inFlight
  }

  private async run(): Promise<void> {
    try {
      // At most 20 source events per notification; no unbounded history/model batch.
      let budget = 20
      while (this.notified && !this.fence.closed && budget > 0) {
        this.notified = false
        while (!this.fence.closed && budget-- > 0 && await this.tick()) { /* durable tail */ }
      }
    } catch {
      // Infrastructure errors remain observable, contain no prompt/body and never fail a chat turn.
      this.input.onReading({ status: 'failed', throughSequence: 0, created: 0, rejected: 0 })
    }
  }

  private async tick(): Promise<boolean> {
    const { db, characterId, extractor, registry } = this.input
    const stored = await getWatermark(db, characterId, AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION)
    if (!stored) throw new Error('automatic_memory_missing_cutover')
    const from = stored.processedThroughSequence + 1
    const latest = await latestCharacterEventSequence(db, characterId)
    const [event] = await conversationEventsInRange(db, characterId, from, latest, 1)
    if (!event) return false
    const scope = this.input.ownerUserId === undefined ? undefined : await scopeForConversation(db,
      String(event.conversationId), event.actorType === 'user' && event.actorId ? String(event.actorId) : this.input.ownerUserId, this.input.ownerUserId)
    const processEvent = async (): Promise<boolean> => {
    const speaker = scope === undefined || event.actorType !== 'user' || !event.actorId ? this.input.speaker : entityRef('user', String(event.actorId))
    const key = automaticMemorySourceKey(characterId, from, event.sequence)
    const counts = await automaticMemoryRetryCounts(db, characterId, key)
    if (counts.failures >= AUTOMATIC_MEMORY_FAILURE_LIMIT + counts.recoveries) {
      this.input.onReading({ status: 'retry_exhausted', throughSequence: stored.processedThroughSequence,
        blockedSourceSequence: event.sequence, ...counts, created: 0, rejected: 0 })
      return false
    }
    const { job } = await enqueueJob(db, { characterId, processor: AUTOMATIC_MEMORY_PROCESSOR,
      processorVersion: AUTOMATIC_MEMORY_VERSION, sourceFromSequence: from, sourceToSequence: event.sequence,
      idempotencyKey: key })
    if (job.status !== 'pending') throw new Error('automatic_memory_unexpected_job_status')
    await markJobRunning(db, job.id)
    try {
      const owner = entityRef('character', String(characterId))
      const extraction = event.type === 'user_message' && event.actorId === String(speaker.id)
        ? await extractor.process({ owner, speaker, views: [processorEventViewOf(event)] },
          { processorName: extractor.name, processorVersion: extractor.version })
        : { candidates: [], rejected: [], extracted: false }
      if (!db.transaction) throw new Error('automatic_memory_transaction_unavailable')
      const outcome = await db.transaction(async (tx) => {
        this.assertOpen()
        const store = createNativeMemoryStore(tx)
        // Pending old extraction must not undo a newer correction/retraction/dispute.
        const candidates: MemoryCandidate[] = []
        for (const unscopedCandidate of extraction.candidates) {
          const candidate = scopeMemoryCandidate(unscopedCandidate)
          const previous = await store.get(candidate.proposedId)
          if (previous && (previous.status === 'retracted' || previous.status === 'superseded')) continue
          const slot = slotOfCandidate(candidate)
          const records = slot ? await store.listByCanonicalKey(slot.canonicalKey) : []
          if (records.some((record) => record.updatedAt > event.createdAt)) continue
          // A new spelling/alias must not dispute or replace an existing accepted fact.
          // First release leaves differing slot values to the explicit correction path.
          if (slot && records.some((record) => (record.status === 'active' || record.status === 'disputed')
            && slotOfRecord(record)?.slotFingerprint !== slot.slotFingerprint)) continue
          candidates.push(candidate)
        }
        const validator = createMemoryMutationValidator({ registry,
          sources: { findEvents: (ids) => findEventRefs(tx, ids as never) },
          processed: { hasProcessed: (key) => hasProcessedOperation(tx, key) },
          lookup: {
            findActiveByFingerprint: async (lookup) => {
              const found = await store.getActiveByFingerprint(lookup.owner, lookup.fingerprint)
              return found === null ? undefined : { memoryId: found.id }
            },
            findActiveByCanonicalKey: async (lookup) => (await store.getActiveByCanonicalKey(lookup.canonicalKey))
              .map((record) => ({ memoryId: record.id })),
            getRecord: async (id) => (await store.get(id)) ?? undefined,
          },
          // Automatic extraction cannot revive forgotten records through the explicit revival feature.
          features: { restatementRevivalEnabled: false },
        })
        const result = await runMemoryExtractionPipeline({
          extractor: { name: extractor.name, version: extractor.version, process: async () => ({ ...extraction, candidates }) },
          validator, fold: (domainEvent) => store.apply(domainEvent),
          commit: async (accepted, now) => (await applyAcceptedEvents(tx, characterId, accepted, [], now)).domainEvents,
          conflict: { recordsInCanonicalSlot: async ({ canonicalKey }) => (await store.listByCanonicalKey(canonicalKey))
            .filter((record) => record.status === 'active' || record.status === 'disputed') },
          utterance: event.content,
        }, { owner, speaker, events: [event], processorContext: { processorName: extractor.name, processorVersion: extractor.version } })
        await finishJob(tx, job.id, 'completed')
        await advanceWatermark(tx, characterId, AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION, event.sequence)
        this.assertOpen()
        return result
      })
      this.input.onReading({ status: 'completed', throughSequence: event.sequence, created: outcome.created.length,
        /* U1 / ADR-137 写侧：把**哪几条**新建的带出去（装配层据此打归属标签） */
        createdMemoryIds: outcome.created.map((record) => String(record.id)),
        rejected: outcome.rejections.length + extraction.candidates.length - outcome.candidates })
      return true
    } catch (error) {
      /*
       * ⚠️ 2026-10-16：原来是 `catch {}` —— **异常被整个丢掉**。
       *   于是容量测试里那 2 个失败"定位不了"：**信息在抛出点就没了**。
       *   现在保留一个**闭集具名码**（`automaticMemoryFailureCauseOf`），
       *   它足以定位，且**不含任何用户内容**（不放 stderr / stdout / 原话 / 回复）。
       *
       * 顶层 `error` 字符串**逐字不变** ⇒ 既有读数与门不受影响。
       */
      const cause = automaticMemoryFailureCauseOf(error)
      await finishJob(db, job.id, 'failed', { error: 'automatic_memory_extraction_or_commit_failed', cause })
      this.input.onReading({ status: 'failed', throughSequence: stored.processedThroughSequence, created: 0, rejected: 0, cause })
      return false
    }
    }
    return scope === undefined ? processEvent() : withReadScope(scope, processEvent)
  }

  private assertOpen(): void {
    if (this.fence.closed) { this.fence.noteRefused(); throw new Error('late_write_fenced') }
  }
}
