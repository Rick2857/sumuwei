import { sql } from 'drizzle-orm'
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { exec, type RawDb } from '../persistence/db.ts'
import { conversationEventsInRange, latestCharacterEventSequence } from '../persistence/conversation-store.ts'
import { enqueueJob, finishJob, getWatermark, markJobRunning } from '../persistence/job-store.ts'
import { AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION } from '../model/langmem-memory-extractor.ts'

export const AUTOMATIC_MEMORY_FAILURE_LIMIT = 3
export const AUTOMATIC_MEMORY_RECOVERY_LIMIT = 3
const RECOVERY_PROCESSOR = 'automatic-memory-operator-recovery'
const RECOVERY_VERSION = 'automatic-memory-operator-recovery@1'
const DEFAULT_TARGET = { processor: AUTOMATIC_MEMORY_PROCESSOR, version: AUTOMATIC_MEMORY_VERSION }

export function automaticMemorySourceKey(characterId: CharacterId, from: number, to: number, target = DEFAULT_TARGET): string {
  return `${target.version}:${String(characterId)}:${from}:${to}`
}

export async function automaticMemoryRetryCounts(db: RawDb, characterId: CharacterId, key: string, target = DEFAULT_TARGET) {
  const rows = await exec(db, sql`select
    count(*) filter (where processor = ${target.processor} and status = 'failed')::int as failures,
    count(*) filter (where processor = ${RECOVERY_PROCESSOR} and status = 'completed')::int as recoveries
    from character_jobs where character_id = ${characterId}
    and (idempotency_key = ${key} or idempotency_key like ${key + ':operator-recovery:%'})`, 'automatic memory retry health')
  return { failures: Number(rows[0]?.failures ?? 0), recoveries: Number(rows[0]?.recoveries ?? 0) }
}

/** SELECT-only. Sequence gaps are not counted as unprocessed conversations. */
export async function readAutomaticMemoryHealth(db: RawDb, characterId: CharacterId, target = DEFAULT_TARGET) {
  const watermark = await getWatermark(db, characterId, target.processor, target.version)
  if (!watermark) return { status: 'not_initialized' as const, throughSequence: null, pendingEvents: 0 }
  const throughSequence = watermark.processedThroughSequence
  const latest = await latestCharacterEventSequence(db, characterId)
  const [source] = await conversationEventsInRange(db, characterId, throughSequence + 1, latest, 1)
  const rows = await exec(db, sql`select
    (select count(*)::int from conversation_events where character_id = ${characterId}
      and sequence > ${throughSequence}) as pending,
    (select max(finished_at) from character_jobs where character_id = ${characterId}
      and processor = ${target.processor} and processor_version = ${target.version}
      and status = 'completed') as last_success`, 'automatic memory lag health')
  const counts = source ? await automaticMemoryRetryCounts(db, characterId,
    automaticMemorySourceKey(characterId, throughSequence + 1, source.sequence, target), target) : { failures: 0, recoveries: 0 }
  return { status: source && counts.failures >= AUTOMATIC_MEMORY_FAILURE_LIMIT + counts.recoveries ? 'retry_exhausted' as const : 'ready' as const,
    throughSequence, pendingEvents: Number(rows[0]?.pending ?? 0), lastSuccessAt: rows[0]?.last_success == null ? null : Number(rows[0].last_success),
    sourceSequence: source?.sequence ?? null, ...counts, recoveryLimit: AUTOMATIC_MEMORY_RECOVERY_LIMIT }
}

/** Explicit operator request: grants one extra attempt at the exact blocked source, never moves the watermark. */
export async function authorizeAutomaticMemoryRetry(db: RawDb, characterId: CharacterId, sourceSequence: number, apply = false, target = DEFAULT_TARGET) {
  if (!Number.isSafeInteger(sourceSequence) || sourceSequence <= 0) throw new Error('automatic_memory_invalid_source')
  if (!db.transaction) throw new Error('automatic_memory_transaction_unavailable')
  return db.transaction(async tx => {
    const health = await readAutomaticMemoryHealth(tx, characterId, target)
    if (health.status !== 'retry_exhausted' || health.sourceSequence !== sourceSequence) throw new Error('automatic_memory_source_not_blocked')
    if (health.recoveries >= AUTOMATIC_MEMORY_RECOVERY_LIMIT) throw new Error('automatic_memory_recovery_limit')
    if (!apply) return { applied: false, attemptsGranted: 0, health }
    const key = automaticMemorySourceKey(characterId, health.throughSequence + 1, sourceSequence, target)
    const { job, created } = await enqueueJob(tx, { characterId, processor: RECOVERY_PROCESSOR, processorVersion: RECOVERY_VERSION,
      triggerKind: 'system', sourceFromSequence: health.throughSequence + 1, sourceToSequence: sourceSequence,
      idempotencyKey: `${key}:operator-recovery:${health.recoveries + 1}` })
    if (!created) throw new Error('automatic_memory_recovery_already_granted')
    await markJobRunning(tx, job.id)
    await finishJob(tx, job.id, 'completed')
    return { applied: true, attemptsGranted: 1, auditJobId: job.id, health }
  })
}
