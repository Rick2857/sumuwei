import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { asMemoryId } from '../../kernel/contracts/ids.ts'
import type { MemoryCandidate } from '../../kernel/contracts/memory.ts'
import { sql, type SQL } from 'drizzle-orm'
import type { Room, ScopeContext } from '../../kernel/contracts/scope.ts'
import { decideRecordVisibility, decideOwnerPrivilegedRecordRead } from '../../kernel/contracts/record-visibility.ts'
import { exec, type RawDb } from './db.ts'
import { filterAuthorizedMemoryCandidates } from './record-scope-store.ts'

export interface ReadScope {
  readonly context: ScopeContext
  readonly ownerUserId: string
  readonly roomAuthorized: boolean
  readonly privilegedTargetUserIds?: readonly string[]
  readonly auditCaseId?: string
}

// Per async chain, never a mutable process-wide "current user".
const scopes = new AsyncLocalStorage<ReadScope>()
export const currentReadScope = (): ReadScope | undefined => scopes.getStore()
export function withReadScope<T>(scope: ReadScope, run: () => T): T { return scopes.run(scope, run) }
export function withoutReadScope<T>(run: () => T): T { return scopes.exit(run) }
function roomGranted(scope: ReadScope): boolean {
  const { room, principal } = scope.context
  return principal.kind === 'system' || (room.kind === 'group' ? scope.roomAuthorized : room.userId === principal.userId)
}
/** Transaction-local RLS facts; pool reuse cannot retain the previous caller's scope. */
export function scopedReadDb(db: RawDb): RawDb {
  return { execute: async query => {
    const scope = currentReadScope()
    if (scope === undefined || scope.context.principal.kind === 'system') return db.execute(query)
    if (db.transaction === undefined) throw new Error('scoped_read_transaction_required')
    return db.transaction(async tx => {
      const room = scope.context.room
      await tx.execute(sql`select set_config('lg.scope_mode', 'external_query', true),
        set_config('lg.room_kind', ${roomGranted(scope) ? room.kind : 'denied'}, true),
        set_config('lg.room_id', ${room.kind === 'group' ? room.groupId : room.userId}, true),
        set_config('lg.owner_user_id', ${scope.ownerUserId}, true),
        set_config('lg.privileged_targets', ${JSON.stringify(scope.privilegedTargetUserIds ?? [])}, true),
        set_config('lg.scope_audit_id', ${scope.auditCaseId ?? ''}, true)`)
      return tx.execute(query)
    })
  } }
}
export function scopeMemoryCandidate(candidate: MemoryCandidate): MemoryCandidate {
  const scope = currentReadScope()
  if (scope === undefined || (scope.context.room.kind === 'private' && scope.context.room.userId === scope.ownerUserId)) return candidate
  const suffix = createHash('sha256').update(JSON.stringify(scope.context.room)).digest('hex').slice(0, 16)
  return { ...candidate, proposedId: asMemoryId(`${candidate.proposedId}:room-${suffix}`) }
}
export async function admittedUserIds(db: RawDb, ownerUserId: string): Promise<readonly string[]> {
  const rows = await exec(db, sql`select distinct user_id from user_identity_mappings where transport in ('qq', 'wechat')`, 'read trusted cognition participants')
  return [...new Set([ownerUserId, ...rows.map(row => String(row.user_id))])]
}
export async function ownerRequestedScope(db: RawDb, scope: ReadScope, text: string): Promise<ReadScope> {
  if (scope.context.principal.kind !== 'owner' || scope.context.room.kind !== 'private') return scope
  const rows = await exec(db, sql`select m.user_id, m.external_id, u.display_name from user_identity_mappings m
    join user_identities u on u.user_id=m.user_id where m.transport in ('qq','wechat')`, 'resolve explicitly mentioned people')
  const targets = [...new Set(rows.filter(row => String(row.user_id) !== scope.ownerUserId &&
    (text.includes(String(row.external_id)) || (String(row.display_name ?? '').length >= 3 && text.includes(String(row.display_name)))))
    .map(row => String(row.user_id)))]
  if (targets.length === 0) return scope
  const auditCaseId = `scope-read:${randomUUID()}`
  await exec(db, sql`insert into scope_read_audit (audit_id, operator_id, target_ids, purpose, created_at)
    values (${auditCaseId}, ${scope.ownerUserId}, ${JSON.stringify(targets)}::jsonb, 'owner_named_record_query', ${Date.now()})`, 'audit named owner read')
  return { ...scope, privilegedTargetUserIds: targets, auditCaseId }
}

function privileged(scope: ReadScope): boolean {
  return scope.context.principal.kind === 'owner' && scope.context.room.kind === 'private'
    && scope.context.room.userId === scope.ownerUserId && !!scope.auditCaseId && !!scope.privilegedTargetUserIds?.length
}

export function roomVisible(origin: Room, scope = currentReadScope()): boolean {
  if (scope === undefined) return true
  return decideRecordVisibility({ context: scope.context,
    label: { originRoom: origin, disclosure: 'private_to_origin' }, originRoom: origin,
    roomAuthorized: scope.roomAuthorized }).allowed
}

/** SQL authorization BEFORE LIMIT. Identifiers are fixed by trusted callers. */
export function memoryReadPredicate(alias = 'memory_records'): SQL {
  const scope = currentReadScope()
  if (scope === undefined) return sql`true`
  if (!roomGranted(scope)) return sql`false`
  const room = scope.context.room
  if (scope.context.principal.kind === 'system') return sql`true`
  if (room.kind === 'group' && !scope.roomAuthorized) return sql`false`
  const kind = room.kind
  const id = kind === 'group' ? (room as { groupId: string }).groupId : (room as { userId: string }).userId
  const targets = scope.privilegedTargetUserIds ?? []
  return sql`exists (select 1 from record_scope_labels scope_label
    where scope_label.record_kind = 'memory' and scope_label.record_id = ${sql.raw(`${alias}.id`)}
      and ((scope_label.origin_room_kind = ${kind} and scope_label.origin_room_id = ${id})
        or (${privileged(scope)} and scope_label.origin_room_kind = 'private'
          and scope_label.origin_room_id in (${sql.join((targets.length ? targets : ['']).map(target => sql`${target}`), sql`, `)})))
      and scope_label.disclosure in ('private_to_origin', 'public_to_room'))
    or (${kind} = 'private' and ${id} = ${scope.ownerUserId}
      and not exists (select 1 from record_scope_labels scope_label
        where scope_label.record_kind = 'memory' and scope_label.record_id = ${sql.raw(`${alias}.id`)}))`
}

export async function authorizedMemoryIds(db: RawDb, ids: readonly string[]): Promise<Set<string>> {
  const scope = currentReadScope()
  if (scope === undefined) return new Set(ids)
  const result = await filterAuthorizedMemoryCandidates(db, { context: scope.context, candidateIds: ids,
    defaultOriginRoom: { kind: 'private', userId: scope.ownerUserId }, roomAuthorized: scope.roomAuthorized })
  const allowed = new Set(result.authorized)
  if (privileged(scope) && ids.length > 0) {
    const labels = await exec(db, sql`select record_id, origin_room_id from record_scope_labels
      where record_kind='memory' and origin_room_kind='private'
      and record_id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`, 'owner named-record label read')
    for (const row of labels) {
      if (!scope.privilegedTargetUserIds!.includes(String(row.origin_room_id))) continue
      const room: Room = { kind: 'private', userId: String(row.origin_room_id) }
      if (decideOwnerPrivilegedRecordRead({ context: { ...scope.context, purpose: 'admin_operation' },
        label: { originRoom: room, disclosure: 'private_to_origin' }, originRoom: room, auditCaseId: scope.auditCaseId! }).allowed) allowed.add(String(row.record_id))
    }
  }
  return allowed
}

export async function bindConversationRoom(db: RawDb, input: {
  conversationId: string; characterId: string; userId: string; room: Room
}): Promise<void> {
  const roomId = input.room.kind === 'group' ? input.room.groupId : input.room.userId
  await exec(db, sql`insert into conversation_rooms (conversation_id, character_id, room_kind, room_id)
    values (${input.conversationId}, ${input.characterId}, ${input.room.kind}, ${roomId})
    on conflict (conversation_id) do nothing`, 'bind conversation room')
  const [row] = await exec(db, sql`select character_id, room_kind, room_id from conversation_rooms
    where conversation_id = ${input.conversationId}`, 'verify conversation room')
  if (!row || row.character_id !== input.characterId || row.room_kind !== input.room.kind || row.room_id !== roomId) {
    throw new Error('conversation_room_binding_conflict')
  }
  await exec(db, sql`insert into room_participants (character_id, room_kind, room_id, user_id)
    values (${input.characterId}, ${input.room.kind}, ${roomId}, ${input.userId}) on conflict do nothing`, 'bind room participant')
}

export function conversationReadPredicate(alias = 'conversation_events'): SQL {
  const scope = currentReadScope()
  if (scope === undefined || scope.context.principal.kind === 'system') return sql`true`
  if (!roomGranted(scope)) return sql`false`
  const room = scope.context.room
  if (room.kind === 'group' && !scope.roomAuthorized) return sql`false`
  const id = room.kind === 'group' ? room.groupId : room.userId
  const targets = scope.privilegedTargetUserIds ?? []
  return sql`exists (select 1 from conversation_rooms scope_room
    where scope_room.conversation_id = ${sql.raw(`${alias}.conversation_id`)}
      and ((scope_room.room_kind = ${room.kind} and scope_room.room_id = ${id})
        or (${privileged(scope)} and scope_room.room_kind='private'
          and scope_room.room_id in (${sql.join((targets.length ? targets : ['']).map(target => sql`${target}`), sql`, `)}))))
    or (${room.kind} = 'private' and ${id} = ${scope.ownerUserId}
      and not exists (select 1 from conversation_rooms scope_room
        where scope_room.conversation_id = ${sql.raw(`${alias}.conversation_id`)}))`
}

export async function scopeForConversation(db: RawDb, conversationId: string, userId: string,
  ownerUserId: string): Promise<ReadScope> {
  const [row] = await exec(db, sql`select room_kind, room_id from conversation_rooms
    where conversation_id = ${conversationId}`, 'read source room')
  if (row === undefined && userId !== ownerUserId) throw new Error('source_room_binding_missing')
  const room: Room = row?.room_kind === 'group' ? { kind: 'group', groupId: String(row.room_id) }
    : { kind: 'private', userId: row === undefined ? ownerUserId : String(row.room_id) }
  return { context: { principal: userId === ownerUserId
    ? { kind: 'owner', userId, verifiedBy: 'config_binding' }
    : { kind: 'user', userId, verifiedBy: 'onebot_inbound' }, purpose: 'external_query', room },
    ownerUserId, roomAuthorized: true }
}

/** Derived output may only reuse source roots visible to this audience. */
export async function sourceRootsVisible(db: RawDb, roots: readonly string[]): Promise<boolean> {
  if (currentReadScope() === undefined) return true
  if (roots.length === 0) return false
  const ids = sql.join(roots.map(id => sql`${id}`), sql`, `)
  const rows = await exec(scopedReadDb(db), sql`select id from conversation_events where id in (${ids})
    and (${conversationReadPredicate()})`, 'authorize derived source roots')
  return new Set(rows.map(row => String(row.id))).size === new Set(roots).size
}
