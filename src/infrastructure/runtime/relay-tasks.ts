import type { CharacterId, ConversationEventId } from '../../kernel/contracts/ids.ts'
import type { RelayInput, RelayMetadata, RelayOrigin, RelayResolution, RelaySource, RelayResult } from '../../kernel/app/relay-turn.ts'
import { runRelayTurn } from '../../kernel/app/relay-turn.ts'
import type { RawDb } from '../persistence/db.ts'
import { getConversationEventsByIds } from '../persistence/conversation-store.ts'
import { cancelRelayTask, createRelayTask, listRelayTasks } from '../persistence/relay-store.ts'
import { withReadScope } from '../persistence/read-scope.ts'
import { computeWithdrawnEvidence } from '../persistence/withdrawn-evidence.ts'
import { createNativeMemoryStore } from '../persistence/memory-store.ts'
import { entityRef } from '../../kernel/contracts/entity.ts'
import { advanceOccurrence, getIntent, type NotificationIntentRecord } from '../persistence/notification-store.ts'
import { reserveRelayTask } from '../persistence/relay-store.ts'
import type { QqDeliveryRegistry } from '../../kernel/app/notification-delivery.ts'
import { dispatchProactiveText } from '../../kernel/app/proactive-delivery.ts'

export const relayOccurrenceKey = (intent: NotificationIntentRecord): string =>
  `qq-notify:relay:${intent.id}:${intent.planVersion}:${intent.scheduledAt}`

/** Recheck recorded source identity/content under its original read scope, never an owner's privileged read. */
export async function relaySourcesAvailable(db: RawDb, characterId: CharacterId, metadata: RelayMetadata, ownerUserId: string): Promise<boolean> {
  return withReadScope({ context: { principal: { kind: 'user', userId: metadata.userId,
    verifiedBy: metadata.transport === 'qq' ? 'onebot_inbound' : 'wechat_inbound' }, purpose: 'external_query', room: metadata.room },
    ownerUserId, roomAuthorized: true }, async () => {
    const events = await getConversationEventsByIds(db, metadata.sources.map(source => source.id as ConversationEventId))
    if (events.some((event, index) => !event || String(event.characterId) !== String(characterId)
      || String(event.conversationId) !== metadata.conversationId || event.actorType !== 'user'
      || String(event.actorId) !== metadata.userId
      || (metadata.sources[index]!.truncated ? !event.content.startsWith(metadata.sources[index]!.text)
        : event.content !== metadata.sources[index]!.text))) return false
    const withdrawn = await computeWithdrawnEvidence(db, createNativeMemoryStore(db), entityRef('character', characterId))
    return withdrawn.ok && !metadata.sources.some(source => withdrawn.withdrawnEventIds.includes(source.id as ConversationEventId))
  })
}

export async function handleRelayTurn(input: {
  db: RawDb; characterId: CharacterId; ownerRef: string; ownerUserId: string; origin: RelayOrigin
  ownerPrivate: boolean; current: RelaySource; recent: readonly RelaySource[]
  resolve: (input: RelayInput) => Promise<RelayResolution>
}): Promise<RelayResult> {
  const tasks = await listRelayTasks(input.db, input)
  return runRelayTurn({ current: input.current, recent: input.recent, tasks, origin: input.origin, recipient: 'bound_owner' }, {
    resolve: input.resolve,
    create: async (draft, metadata) => {
      if (!await relaySourcesAvailable(input.db, input.characterId, metadata, input.ownerUserId)) throw new Error('relay_source_unavailable')
      return createRelayTask(input.db, { characterId: input.characterId, ownerRef: input.ownerRef, text: draft.text, metadata, now: Date.now() })
    },
    cancel: async task => cancelRelayTask(input.db, { ...input, task }),
  })
}

/** Resumes only pre-dispatch states. The model's stored text is delivered verbatim, with no template. */
export async function deliverRelayTask(input: {
  db: RawDb; intent: NotificationIntentRecord; ownerRef: string; ownerUserId: string; registry: QqDeliveryRegistry
  execute: (request: { occurrenceKey: string; text: string }) => Promise<{ outcome: 'executed' | 'refused'; code?: string; actionId?: string }>
}) {
  const intent = await getIntent(input.db, input.intent.id)
  if (!intent || intent.kind !== 'relay' || intent.status !== 'pending' || !intent.relayMetadata
    || intent.ownerRef !== input.ownerRef || intent.deliveryChannel !== 'qq_private') return { dispatched: false, code: 'relay_binding_or_state_changed' }
  const occurrenceKey = relayOccurrenceKey(intent)
  const reserved = await reserveRelayTask(input.db, intent, occurrenceKey)
  const occurrence = reserved.occurrence
  if (!occurrence || !['pending', 'evaluating', 'prepared'].includes(occurrence.state)) return { dispatched: false, code: 'relay_already_attempted_or_cancelled' }
  const available = await relaySourcesAvailable(input.db, intent.characterId, intent.relayMetadata, input.ownerUserId)
  if (!available) {
    await advanceOccurrence(input.db, occurrenceKey, { to: 'cancelled', reasonCode: 'relay_source_unavailable' })
    return { dispatched: false, code: 'relay_source_unavailable' }
  }
  if (occurrence.state === 'pending') {
    const step = await advanceOccurrence(input.db, occurrenceKey, { to: 'evaluating' })
    if (!step.ok) return { dispatched: false, code: step.code }
  }
  if (occurrence.state !== 'prepared') {
    const step = await advanceOccurrence(input.db, occurrenceKey, { to: 'prepared', text: intent.text! })
    if (!step.ok) return { dispatched: false, code: step.code }
  }
  return dispatchProactiveText({ occurrenceKey, text: intent.text!, kind: 'relay', generation: input.registry.currentGeneration(),
    dispatch: input.registry, action: { execute: input.execute } })
}
