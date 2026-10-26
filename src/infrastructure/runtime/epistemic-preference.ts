/** One explicit preference writer; reuses the existing Memory validator/service and M9 reported path. */
import { sql } from 'drizzle-orm'
import { entityRef } from '../../kernel/contracts/entity.ts'
import { asCharacterId, type CharacterId } from '../../kernel/contracts/ids.ts'
import { canonicalKeyOf } from '../../kernel/contracts/memory.ts'
import { createFullDomainEventRegistry } from '../../kernel/contracts/domain-event.ts'
import { createMemoryMutationValidator } from '../../kernel/policies/memory-validator.ts'
import { createExplicitMemoryService } from '../../kernel/app/memory/explicit-service.ts'
import { translate, type ExplicitMemoryTurnRequest, type ExplicitMemoryTurnResult } from '../../kernel/app/memory/explicit-turn.ts'
import { readEblPreference, EBL_PREFERENCE_PREDICATE, EBL_PREFERENCE_QUALIFIERS } from '../../kernel/app/epistemic-belief-lifecycle/human-policy.ts'
import { makeEblClaim } from '../../kernel/contracts/epistemic-belief.ts'
import { getConversationEvent, findEventRefs } from '../persistence/conversation-store.ts'
import { createNativeMemoryStore } from '../persistence/memory-store.ts'
import { applyAcceptedEvents } from '../persistence/event-store.ts'
import { hasProcessedOperation } from '../persistence/job-store.ts'
import { scopeMemoryCandidate } from '../persistence/read-scope.ts'
import { exec, inTransaction, type RawDb } from '../persistence/db.ts'
import { createEblSourceReader, EBL_HUMAN_ENVIRONMENT } from '../persistence/epistemic-belief-source.ts'

/** Retire an old write only where the new source adapter actually owns that statement. */
export async function eblOwnsPreferenceSource(db: RawDb, characterId: CharacterId, activeUserId: string, eventId: string): Promise<boolean> {
  const event = await getConversationEvent(db, eventId as never)
  const signal = event && readEblPreference(event.content)
  if (!signal?.explicit) return false
  const claim = makeEblClaim({ characterId: String(characterId), subjectId: activeUserId, domain: 'interpersonal',
    predicate: 'explanation_detail', expected: signal.value, scope: 'technical_explanation', environment: EBL_HUMAN_ENVIRONMENT,
    conditions: { scene: 'technical_explanation' }, formation: { kind: 'conversation', id: eventId } })
  return await createEblSourceReader(activeUserId)(db, claim.formation, claim, false) !== undefined
}

export async function handleEblPreferenceTurn(db: RawDb, characterId: CharacterId, activeUserId: string,
  request: ExplicitMemoryTurnRequest): Promise<ExplicitMemoryTurnResult | undefined> {
  const signal = readEblPreference(request.event.content)
  if (!signal || !signal.explicit) return undefined
  const failure = (reason: string): ExplicitMemoryTurnResult => ({ kind: 'not_written', intent: 'remember', reason,
    summary: '本轮讲解要求优先，但长期偏好没有写入。不要声称已经记住或更新。' })
  if (!db.transaction) return failure('ebl_transaction_required')
  return inTransaction(db, async tx => {
    await exec(tx, sql`select pg_advisory_xact_lock(hashtextextended(${`ebl:${characterId}`}, 0))`, 'EBL preference serialization')
    const event = await getConversationEvent(tx, request.event.id)
    if (!event || event.content !== request.event.content || event.actorType !== 'user' || event.actorId !== activeUserId
      || String(event.characterId) !== String(characterId) || request.owner.kind !== 'character'
      || String(request.owner.id) !== String(characterId) || request.speaker.kind !== 'user'
      || String(request.speaker.id) !== activeUserId) return failure('ebl_preference_source')
    const claim = makeEblClaim({ characterId: String(characterId), subjectId: activeUserId, domain: 'interpersonal',
      predicate: 'explanation_detail', expected: signal.value, scope: 'technical_explanation', environment: EBL_HUMAN_ENVIRONMENT,
      conditions: { scene: 'technical_explanation' }, formation: { kind: 'conversation', id: String(event.id) } })
    const source = await createEblSourceReader(activeUserId)(tx, claim.formation, claim, true)
    if (!source) return undefined // Unsupported scene remains the general Memory writer's responsibility.
    if (!source.usable) return failure('ebl_preference_source')
    if (signal.horizon === 'turn') return { ...failure('turn_scoped_preference'),
      summary: '本轮按当前讲解要求回答。这是本轮例外，没有写入或改写长期偏好，不要声称已长期记住。' }
    const owner = entityRef('character', String(characterId)), subject = entityRef('user', activeUserId)
    const content = { kind: 'claim' as const, subject, predicate: EBL_PREFERENCE_PREDICATE,
      value: signal.value === 'concise' ? 'brief' : 'detailed', qualifiers: { ...EBL_PREFERENCE_QUALIFIERS } }
    const canonicalKey = canonicalKeyOf({ owner, type: 'preference', content })!
    const store = createNativeMemoryStore(tx)
    const active = (await store.listByCanonicalKey(canonicalKey)).filter(item => ['active', 'disputed'].includes(item.status))
    if (active.length > 1) return failure('ebl_preference_ambiguous')
    const validator = createMemoryMutationValidator({ registry: createFullDomainEventRegistry(),
      sources: { findEvents: ids => findEventRefs(tx, ids as never) },
      processed: { hasProcessed: key => hasProcessedOperation(tx, key) },
      lookup: { getRecord: async id => (await store.get(id)) ?? undefined,
        findActiveByFingerprint: async input => {
          const found = await store.getActiveByFingerprint(input.owner, input.fingerprint)
          return found ? { memoryId: found.id } : undefined
        },
        findActiveByCanonicalKey: async input => (await store.getActiveByCanonicalKey(input.canonicalKey)).map(item => ({ memoryId: item.id })),
      }, features: { restatementRevivalEnabled: true },
    })
    const service = createExplicitMemoryService({ validator, store,
      prepareCandidate: scopeMemoryCandidate,
      extractor: { name: 'ebl-explicit-preference@1', async extract() {
        return { type: 'preference', content, subjects: [subject], confidence: 1,
          basis: 'ebl-explicit-preference@1: explicit scoped statement', predicate: EBL_PREFERENCE_PREDICATE }
      } },
      resolveTarget: async () => active[0]
        ? { status: 'resolved', record: active[0], candidates: 1, confidence: 'exact', via: 'canonical_key' }
        : { status: 'not_found', via: 'canonical_key', triedPaths: ['canonical_key'] },
      commitEvents: async (accepted, now) => (await applyAcceptedEvents(tx, asCharacterId(String(characterId)), accepted, [], now)).domainEvents,
    })
    const kind = active[0] && String(active[0].content.kind === 'claim' ? active[0].content.value : '') !== content.value ? 'correct' : 'remember'
    const outcome = await service.handle({ owner, speaker: subject, triggerEventId: String(event.id),
      intent: { kind, payload: event.content, sourceText: event.content, detectedBy: 'rule', matched: 'ebl-explicit-preference@1' },
      targetCanonicalKey: canonicalKey })
    // A rejected replacement must roll back both writes, not leave a half-completed update.
    if (!outcome.ok && outcome.reason !== 'already_applied') throw new Error(`ebl_preference_${outcome.reason}`)
    const result = translate(outcome, event.content)
    if (result.kind === 'written') {
      const current = (await store.getActiveByCanonicalKey(canonicalKey)).find(item => item.content.kind === 'claim' && item.content.value === content.value)
      if (!current) throw new Error('ebl_preference_write_not_effective')
      return { ...result, memoryId: String(current.id) }
    }
    return result
  })
}
