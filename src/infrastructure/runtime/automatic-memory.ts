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
import { AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION } from '../model/langmem-memory-extractor.ts'
import { AUTOMATIC_MEMORY_FAILURE_LIMIT, automaticMemoryRetryCounts, automaticMemorySourceKey } from './automatic-memory-control.ts'

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
    } catch {
      await finishJob(db, job.id, 'failed', { error: 'automatic_memory_extraction_or_commit_failed' })
      this.input.onReading({ status: 'failed', throughSequence: stored.processedThroughSequence, created: 0, rejected: 0 })
      return false
    }
    }
    return scope === undefined ? processEvent() : withReadScope(scope, processEvent)
  }

  private assertOpen(): void {
    if (this.fence.closed) { this.fence.noteRefused(); throw new Error('late_write_fenced') }
  }
}
