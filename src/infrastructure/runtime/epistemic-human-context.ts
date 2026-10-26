/** Read-qualified EBL guidance through the existing belief section; no second prompt outlet. */
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { EBL_LIMIT, makeEblClaim, type EblState } from '../../kernel/contracts/epistemic-belief.ts'
import { isEblManagedStyle, readEblPreference } from '../../kernel/app/epistemic-belief-lifecycle/human-policy.ts'
import type { BeliefContextRenderInput } from '../../kernel/contracts/belief-renderer.ts'
import { getConversationEvent } from '../persistence/conversation-store.ts'
import { createEblStore } from '../persistence/epistemic-belief-store.ts'
import { createEblSourceReader, EBL_HUMAN_ENVIRONMENT } from '../persistence/epistemic-belief-source.ts'
import type { RawDb } from '../persistence/db.ts'
import type { MemoryRetrievalPort } from '../../kernel/recall/ports.ts'
import { sql } from 'drizzle-orm'
import { exec } from '../persistence/db.ts'

/** Style facts remain in Memory/M9; this removes their duplicate model-facing recall outlet. */
export function eblManagedRecall(port: MemoryRetrievalPort): MemoryRetrievalPort {
  return { ...port, name: `${port.name}:ebl-style-outlet`, async retrieve(query) {
    const result = await port.retrieve(query)
    return { ...result, hits: result.hits.filter(hit => !isEblManagedStyle(hit.record.content)) }
  } }
}

export async function readEblHumanContext(db: RawDb, characterId: CharacterId, activeUserId: string, eventId?: string) {
  const readSource = createEblSourceReader(activeUserId)
  const store = createEblStore(db, characterId, readSource)
  async function hasLaterContradiction(state: EblState): Promise<boolean> {
    // Observer failure must not let a qualified correction disappear from the read path.
    // ponytail: scans this subject's post-formation messages; batch/index only after scale measurement.
    const rows = await exec(db, sql`select id, content from conversation_events where character_id = ${characterId}
      and actor_type = 'user' and actor_id = ${activeUserId} and sequence > (
        select sequence from conversation_events where id = ${state.claim.formation.id})`, 'EBL missed correction check')
    for (const row of rows) {
      const signal = readEblPreference(String(row.content))
      if (!signal || signal.horizon !== 'persistent' || signal.value === state.claim.expected) continue
      const source = await readSource(db, { kind: 'conversation', id: String(row.id) }, state.claim, false)
      if (source?.usable && source.complete) return true
    }
    return false
  }
  const presentation: NonNullable<BeliefContextRenderInput['epistemic']> = { currentOverride: false, technicalContext: false }
  const context = { subjectId: activeUserId, scope: 'technical_explanation', environment: EBL_HUMAN_ENVIRONMENT,
    conditions: { scene: 'technical_explanation' } }
  if (eventId) {
    const event = await getConversationEvent(db, eventId as never)
    if (!event || event.type !== 'user_message' || event.actorId !== activeUserId || String(event.characterId) !== String(characterId)) {
      return { presentation } // Managed legacy slot remains masked; no new EBL authority.
    }
    if (readEblPreference(event.content)) { presentation.currentOverride = true; return { presentation } }
    const probe = makeEblClaim({ characterId: String(characterId), subjectId: activeUserId, domain: 'interpersonal',
      predicate: 'explanation_detail', expected: 'concise', scope: context.scope, environment: context.environment,
      conditions: context.conditions, formation: { kind: 'conversation', id: eventId } })
    presentation.technicalContext = (await readSource(db, probe.formation, probe, false))?.usable === true
  }
  if (!presentation.technicalContext) return { presentation }
  const states: EblState[] = []
  for (const expected of ['concise', 'detailed'] as const) {
    const lookup = makeEblClaim({ characterId: String(characterId), subjectId: activeUserId, domain: 'interpersonal',
      predicate: 'explanation_detail', expected, scope: context.scope, environment: context.environment,
      conditions: context.conditions, formation: { kind: 'conversation', id: eventId ?? 'read-only-no-current-event' } })
    const state = await store.get(lookup.id)
    if (state && state.uses.length < EBL_LIMIT && await store.usable(state.claim.id, context, true)
      && !await hasLaterContradiction(state)) states.push(state)
  }
  if (states.length === 1 && !presentation.currentOverride) {
    const state = states[0]
    presentation.candidate = { claimId: state.claim.id, subjectId: activeUserId, value: state.claim.expected as 'concise' | 'detailed' }
  }
  return { presentation,
    confirmIncluded: presentation.candidate && eventId ? async () => {
      // Recheck at final compiler inclusion; failure prevents returning a stale prompt.
      if (await hasLaterContradiction(states[0])) throw new Error('ebl_unprocessed_feedback')
      await store.commit(presentation.candidate!.claimId, { kind: 'use', use: { decisionId: eventId,
        before: 'no_inferred_style_guidance', after: `inferred_style_${presentation.candidate!.value}`, context } }, { allowHuman: true })
    } : undefined,
  }
}
