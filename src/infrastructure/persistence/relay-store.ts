import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { CharacterId, NotificationIntentId } from '../../kernel/contracts/ids.ts'
import type { RelayMetadata, RelayOrigin, RelayTaskView } from '../../kernel/app/relay-turn.ts'
import { exec, inTransaction, type RawDb } from './db.ts'
import { createIntent, getIntent, latestOccurrenceForIntent, reserveOccurrence, type NotificationIntentRecord } from './notification-store.ts'

export async function relayView(db: RawDb, intent: NotificationIntentRecord): Promise<RelayTaskView> {
  const latest = (await latestOccurrenceForIntent(db, intent.id)).occurrence
  const { transport, senderId, userId, conversationId, room } = intent.relayMetadata!
  return { id: String(intent.id), text: intent.text!, mode: intent.relayMetadata!.mode,
    origin: { transport, senderId, userId, conversationId, room }, sourceRefs: intent.sourceRefs,
    status: intent.status !== 'pending' ? intent.status : latest?.state ?? 'queued',
    ...(latest?.platformMessageId ? { platformMessageId: latest.platformMessageId } : {}) }
}

/** Caller identity is program supplied; an ordinary caller sees only their own source conversation. */
export async function listRelayTasks(db: RawDb, input: {
  characterId: CharacterId; ownerRef: string; origin: RelayOrigin; ownerPrivate: boolean
}): Promise<RelayTaskView[]> {
  const rows = await exec(db, sql`select id from notification_intents where kind = 'relay'
    and character_id = ${String(input.characterId)} and owner_ref = ${input.ownerRef}
    ${input.ownerPrivate ? sql`` : sql`and conversation_ref = ${input.origin.conversationId}
      and relay_metadata->>'userId' = ${input.origin.userId}
      and relay_metadata->>'senderId' = ${input.origin.senderId}
      and relay_metadata->>'transport' = ${input.origin.transport}`}
    order by created_at desc limit 20`, '读取授权范围内转告任务')
  const result: RelayTaskView[] = []
  for (const row of rows) {
    const intent = await getIntent(db, String(row.id) as NotificationIntentId)
    if (intent?.relayMetadata) result.push(await relayView(db, intent))
  }
  return result
}

export async function createRelayTask(db: RawDb, input: {
  characterId: CharacterId; ownerRef: string; text: string; metadata: RelayMetadata; now: number
}): Promise<{ task: RelayTaskView; created: boolean }> {
  const result = await createIntent(db, { id: `qni:${randomUUID()}` as NotificationIntentId,
    characterId: input.characterId, ownerRef: input.ownerRef, conversationRef: input.metadata.conversationId,
    kind: 'relay', deliveryChannel: 'qq_private', repeatMode: 'once', text: input.text, relayMetadata: input.metadata,
    sourceRefs: input.metadata.sources.map(source => source.id), scheduledAt: input.now, timezone: 'Asia/Shanghai',
    permissionVersion: 'owner-relay-provisional@1', policyVersion: 'owner-relay-provisional@1',
    dedupeKey: `relay:${input.characterId}:${input.metadata.requestSourceId}`, now: input.now })
  if (!result.intent) throw new Error('relay_create_without_readback')
  if (result.intent.ownerRef !== input.ownerRef || result.intent.relayMetadata?.userId !== input.metadata.userId
    || result.intent.conversationRef !== input.metadata.conversationId) throw new Error('relay_dedupe_scope_mismatch')
  return { task: await relayView(db, result.intent), created: result.created }
}

/** One atomic claim: cancelling is allowed only before the sender has reserved an occurrence. */
export async function cancelRelayTask(db: RawDb, input: {
  characterId: CharacterId; ownerRef: string; task: RelayTaskView; origin: RelayOrigin; ownerPrivate: boolean
}): Promise<boolean> {
  return inTransaction(db, async tx => {
    await exec(tx, sql`select id from notification_intents where id = ${input.task.id} for update`, '锁定撤销转告任务')
    const rows = await exec(tx, sql`update notification_intents set status = 'cancelled', updated_at = ${Date.now()}
    where id = ${input.task.id} and kind = 'relay' and status = 'pending'
      and character_id = ${String(input.characterId)} and owner_ref = ${input.ownerRef}
      ${input.ownerPrivate ? sql`` : sql`and conversation_ref = ${input.origin.conversationId}
        and relay_metadata->>'userId' = ${input.origin.userId} and relay_metadata->>'senderId' = ${input.origin.senderId}
        and relay_metadata->>'transport' = ${input.origin.transport}`}
      and not exists(select 1 from notification_occurrences o where o.intent_id = notification_intents.id)
    returning id`, '撤销尚未开始投递的转告任务')
    return rows.length > 0
  })
}

/** Only at scheduler startup: an interrupted network attempt is unknown, never a retry candidate. */
export async function recoverRelayDispatching(db: RawDb, characterId: CharacterId, ownerRef: string): Promise<void> {
  await exec(db, sql`update notification_occurrences o set state='delivery_unknown',
    reason_code='process_restarted_before_receipt', updated_at=${Date.now()}
    from notification_intents i where o.intent_id=i.id and o.kind='relay' and o.state='dispatching'
      and i.character_id=${String(characterId)} and i.owner_ref=${ownerRef}`, '恢复转告在途未知状态')
}

/** Sender and cancellation serialize on the same intent row. */
export async function reserveRelayTask(db: RawDb, intent: NotificationIntentRecord, occurrenceKey: string) {
  return inTransaction(db, async tx => {
    await exec(tx, sql`select id from notification_intents where id = ${String(intent.id)} for update`, '锁定待发送转告任务')
    return reserveOccurrence(tx, { occurrenceKey, intentId: intent.id, characterId: intent.characterId, kind: 'relay',
      expectedPlanVersion: intent.planVersion, dueAt: intent.scheduledAt,
      permissionVersion: intent.permissionVersion, policyVersion: intent.policyVersion })
  })
}
