import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { createProposal } from '../../kernel/contracts/proposal.ts'
import { createFullDomainEventRegistry } from '../../kernel/contracts/domain-event.ts'
import { REFLECTION_INVALIDATED, ADAPTIVE_SELF_REVISED } from '../../kernel/contracts/reflection-events.ts'
import { validateReflectionProposal } from '../../kernel/policies/reflection-validator.ts'
import { planInvalidation } from '../../kernel/app/reflection/invalidation.ts'
import type { LateWriteFence } from '../../kernel/app/reflection/late-write-fence.ts'
import { listReflectionRecords, applyReflectionRows } from '../persistence/reflection-store.ts'
import { listAdaptiveSelfStates, applyAdaptiveSelfRows } from '../persistence/adaptive-self-store.ts'
import { readReflectionSourceSnapshot } from '../persistence/reflection-source-read.ts'
import { applyAcceptedEvents, domainEventsFor } from '../persistence/event-store.ts'
import { exec, type RawDb } from '../persistence/db.ts'
import { sql } from 'drizzle-orm'

/** Permanent source loss uses the existing lifecycle, independently of the enhancement switch. */
export async function invalidateReflectionSources(db: RawDb, characterId: CharacterId, fence: LateWriteFence, activeUserId?: string): Promise<number> {
  if (fence.closed) return 0
  if (db.transaction === undefined) throw new Error('reflection_invalidation_transaction_unavailable')
  return db.transaction(async tx => {
    let written = 0
    const assertWritable = () => { if (fence.closed) { fence.noteRefused(); throw new Error('late_write_fenced') } }
    const emit = async (type: string, payload: Record<string, unknown>, sourceId: string) => {
      assertWritable()
      const proposal = createProposal({ characterId, proposalType: 'reflection-invalidation', payload: {},
        sourceConversationEventIds: [sourceId as never], targetEvents: [{ type, operation: 'create', payload }],
        processor: 'reflection-invalidation', processorVersion: `reflection-invalidation@1-${type}`,
      })
      const outcome = await validateReflectionProposal({ registry: createFullDomainEventRegistry(), reviewFacts: () => undefined,
        processed: { async hasProcessed(key) { return (await exec(tx, sql`select 1 from processed_operations where idempotency_key = ${key} limit 1`, 'M11 invalidation idempotency')).length > 0 } },
      }, proposal)
      if (!outcome.accepted) return
      assertWritable()
      await applyAcceptedEvents(tx, characterId, outcome.acceptedEvents, [], Date.now())
      written += outcome.acceptedEvents.length
    }
    const records = await listReflectionRecords(tx, characterId)
    for (const record of records) {
      if (record.status !== 'accepted' && record.status !== 'pending') continue
      const snapshot = await readReflectionSourceSnapshot(tx, characterId, record.roots.map(id => ({ id, kind: id.startsWith('cev:') ? 'conversation_event' as const : 'domain_event' as const })), { activeUserId, lock: true })
      const rootVerdicts = snapshot.sourceVerdicts.map(row => ({ rootId: row.handleId, usable: row.usable, reason: row.reason }))
      const invalidation = planInvalidation({ reflectionId: record.reflectionId, roots: snapshot.roots, rootVerdicts })
      if (invalidation.kind !== 'invalidate') continue
      await emit(REFLECTION_INVALIDATED, { ...invalidation.plan }, invalidation.plan.causeEventId)
      const states = await listAdaptiveSelfStates(tx, characterId)
      for (const state of states) {
        if (state.level !== 'enhanced') continue
        const stateSnapshot = await readReflectionSourceSnapshot(tx, characterId, state.roots.map(id => ({ id, kind: id.startsWith('cev:') ? 'conversation_event' as const : 'domain_event' as const })), { activeUserId, lock: true })
        if (!stateSnapshot.roots.includes(invalidation.plan.causeEventId)) continue
        await emit(ADAPTIVE_SELF_REVISED, { slot: state.slot, level: 'baseline', revision: state.revision + 1, roots: [...state.roots], reason: invalidation.plan.cause }, invalidation.plan.causeEventId)
        const events = await domainEventsFor(tx, characterId)
        await applyAdaptiveSelfRows(tx, characterId, events.filter(event => String(event.type) === ADAPTIVE_SELF_REVISED))
      }
    }
    if (written > 0) {
      const events = await domainEventsFor(tx, characterId)
      await applyReflectionRows(tx, characterId, events.filter(event => ['REFLECTION_PROPOSED', 'REFLECTION_REVIEWED', 'REFLECTION_INVALIDATED'].includes(String(event.type))))
    }
    assertWritable()
    return written
  })
}
