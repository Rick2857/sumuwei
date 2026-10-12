/** Current qualification for M11 consumers; lineage is descriptive, this read is authoritative. */
import { sql } from 'drizzle-orm'
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { entityRef } from '../../kernel/contracts/entity.ts'
import type { LineageHandle } from '../../kernel/contracts/reflection-lineage.ts'
import type { ReflectionSourceVerdict } from '../../kernel/policies/reflection-validator.ts'
import { expandLineage } from '../../kernel/app/reflection/lineage.ts'
import { createReflectionLineageLookup, withdrawnStoryAnchorIds } from './reflection-lineage-read.ts'
import { createNativeMemoryStore } from './memory-store.ts'
import { computeWithdrawnEvidence } from './withdrawn-evidence.ts'
import { exec, type RawDb } from './db.ts'
import { getConversationEventsByIds } from './conversation-store.ts'
import { originReadingOfEvent } from './qualification-read.ts'
import { qualificationsForMemories } from './qualification-read.ts'
import { createRecallRequest } from '../../kernel/contracts/recall.ts'
import { evaluateEligibility } from '../../kernel/recall/eligibility.ts'
import { recheckBeliefDependencies } from '../../kernel/app/belief/eligibility.ts'
import { getBelief } from './belief-store.ts'
import { createBeliefJobPorts } from '../runtime/belief-scheduler.ts'

export interface ReflectionSourceSnapshot {
  readonly roots: readonly string[]
  readonly conversationCount: number
  readonly sourceVerdicts: readonly ReflectionSourceVerdict[]
  readonly fingerprint: string
  readonly revisions: Readonly<Record<string, number>>
  readonly usable: boolean
  readonly unresolvedConflict: boolean
}

export async function readReflectionSourceSnapshot(
  db: RawDb,
  characterId: CharacterId,
  handles: readonly LineageHandle[],
  options: { readonly activeUserId?: string; readonly lock?: boolean; readonly now?: number } = {},
): Promise<ReflectionSourceSnapshot> {
  const lookup = createReflectionLineageLookup(db, { characterId })
  const memoryIds = new Set<string>()
  const beliefIds = new Set<string>()
  // Collect every visited derived node, including dependencies reached through another handle.
  const lineage = await expandLineage({ ...lookup,
    async findMemories(ids) { ids.forEach(id => memoryIds.add(id)); return lookup.findMemories(ids) },
    async findBeliefs(ids) { ids.forEach(id => beliefIds.add(id)); return lookup.findBeliefs(ids) },
  }, handles, { characterId: String(characterId) })
  if (options.lock && memoryIds.size > 0) await exec(db, sql`select id from memory_records
    where id in (${sql.join([...memoryIds].map(id => sql`${id}`), sql`, `)}) for share`, 'M11 derived memory commit lock')
  if (options.lock && beliefIds.size > 0) await exec(db, sql`select projection_type from character_projections
    where character_id = ${String(characterId)} and projection_type in (${sql.join([...beliefIds].map(id => sql`${`belief:${id}`}`), sql`, `)}) for share`, 'M11 derived belief commit lock')
  const memoryStore = createNativeMemoryStore(db)
  const memories = await Promise.all([...memoryIds].map(id => memoryStore.get(id as never)))
  const beliefs = await Promise.all([...beliefIds].map(id => getBelief(db, characterId, id)))
  const qualifications = await qualificationsForMemories(db, memories.flatMap(record => record === null ? [] : [{ id: String(record.id), type: record.type }]))
  const now = options.now ?? Date.now()
  const inTime = (from?: number, until?: number | null) => (from === undefined || from <= now) && (until == null || until > now)
  const request = options.activeUserId === undefined ? undefined : createRecallRequest({ traceId: 'reflection-source-qualification',
    characterId: String(characterId), user: entityRef('user', options.activeUserId), query: { text: 'reflection-source-qualification' }, intent: 'current_fact' })
  const memoriesUsable = memories.every(record => record !== null && request !== undefined &&
    evaluateEligibility({ request, candidate: { ...record, memoryId: record.id, searchable: '', dataText: '', retrievedBy: [], integrityOk: record.evidenceRootIds.length > 0 },
      policy: { allowDisputed: false } }).eligible && inTime(record.validFrom, record.validUntil) &&
    (qualifications.get(String(record.id)) === undefined || qualifications.get(String(record.id)) === 'ESTABLISHED'))
  const ports = createBeliefJobPorts(db)
  const beliefStates = beliefs.flatMap(row => row === undefined ? [] : [row.state])
  const beliefVerdicts = await recheckBeliefDependencies({ characterId: String(characterId),
    evidence: { findEvents: ids => ports.findConversationEvents(ids as never) }, memory: { findMemories: ids => ports.findMemories(ids) },
    origin: { getBeliefOrigin: () => ports.belief.getBeliefOrigin(characterId) }, policy: { activeUserId: options.activeUserId ?? '' },
  }, beliefStates)
  const beliefsUsable = beliefs.every(row => row !== undefined && row.state.status === 'active' &&
    String(row.state.perspectiveOwnerId) === String(characterId) && row.state.subject.kind === 'user' &&
    options.activeUserId !== undefined && String(row.state.subject.id) === options.activeUserId &&
    inTime(row.state.proposition.validFrom, row.state.proposition.validTo) && beliefVerdicts.get(String(row.state.beliefId))?.usable === true)
  const derivedUsable = memoriesUsable && beliefsUsable
  const roots = lineage.roots.map(root => root.id)
  const rootIds = sql.join(roots.map(id => sql`${id}`), sql`, `)
  // A short commit transaction holds source records against concurrent retraction.
  if (options.lock && roots.length > 0) {
    await exec(db, sql`select m.id from memory_records m
      join memory_evidence_links l on l.memory_id = m.id
      where l.evidence_id in (${rootIds}) for share of m`, 'M11 source commit lock')
  }
  const withdrawn = await computeWithdrawnEvidence(db, createNativeMemoryStore(db), entityRef('character', String(characterId)))
  /*
   * **S8 / ADR-093 `D12`**：故事体验的**认知使用资格撤回**也要在这里生效。
   *
   * ⚠️ 为什么必须在这一层（实测发现）：采纳之后槽位里存的根是**对话事件 id**，
   *    而撤回挂在**故事提交**上 —— 消费端只看那些对话事件时，它们完全健康，
   *    于是"撤回了却还在入模"。这一行把撤回传播到消费端能看见的那把键上。
   * ⚠️ 没有撤回事件时它返回空集 ⇒ 旧行为逐字不变（M11.1 各门不受影响）。
   */
  const withdrawnStoryAnchors = await withdrawnStoryAnchorIds(db, characterId)
  const rows = roots.length === 0 ? [] : await exec(db, sql`select id, sequence, character_id, actor_type, actor_id
    from conversation_events where id in (${rootIds})`, 'M11 root revision and scope')
  const byId = new Map(rows.map(row => [String(row.id), row]))
  const dependencies = roots.length === 0 ? [] : await exec(db, sql`select distinct m.id, m.status, m.revision
    from memory_records m join memory_evidence_links l on l.memory_id = m.id
    where l.evidence_id in (${rootIds}) and m.owner_kind = 'character' and m.owner_id = ${String(characterId)}`, 'M11 current source conflict and revision')
  /*
   * ⚠️ **批量读**（`R-48` 收口的第二处同形副本，2026-10-04）：这里原来对每个根逐条
   *    `getConversationEvent()`（1 次查询/根）。改成一次批量，**逐行走的仍是同一个
   *    `rowToEvent()`** ⇒ `trustedOrigin` 的解码边界不变，而每轮往返从 O(根数) 降到 1。
   */
  const rootEvents = await getConversationEventsByIds(
    db,
    roots as never
  )
  const origins = new Map(
    roots.map((id, index) => {
      const event = rootEvents[index]
      return [id, event === undefined ? undefined : originReadingOfEvent(event)] as const
    })
  )
  const sourceVerdicts = roots.map((id): ReflectionSourceVerdict => {
    const row = byId.get(id)
    if (row === undefined || String(row.character_id) !== String(characterId) || !withdrawn.ok || !lineage.usable || !derivedUsable) return { handleId: id, usable: false, reason: 'unavailable' }
    if (options.activeUserId !== undefined && String(row.actor_type) === 'user' && String(row.actor_id) !== options.activeUserId) return { handleId: id, usable: false, reason: 'unavailable' }
    const reason = withdrawn.byReason[id]
    if (reason !== undefined) return { handleId: id, usable: false, reason: reason === 'explicit_forget' ? 'source_forgotten' : 'source_retracted' }
    /* S8：这条根背后的**故事经历**被撤回了 ⇒ 与"来源被撤回"同一档（具名、可查） */
    if (withdrawnStoryAnchors.has(id)) return { handleId: id, usable: false, reason: 'source_retracted' }
    if (String(row.actor_type) !== 'user' && String(row.actor_type) !== 'character' && String(row.actor_type) !== 'assistant') return { handleId: id, usable: false, reason: 'unavailable' }
    const origin = origins.get(id)
    // Consume the existing attribution adapter; actor_type alone grants no source permission.
    if (origin === undefined || !origin.axisBConfirmed || origin.contentOriginator.state !== 'KNOWN') return { handleId: id, usable: false, reason: 'unavailable' }
    if (String(row.actor_type) === 'user' && (origin.contentOriginator.value.kind !== 'USER' || origin.contentOriginator.value.id !== String(row.actor_id))) return { handleId: id, usable: false, reason: 'unavailable' }
    if ((String(row.actor_type) === 'character' || String(row.actor_type) === 'assistant') && (String(row.actor_id) !== String(characterId) || origin.contentOriginator.value.kind !== 'CHARACTER' || origin.contentOriginator.value.id !== String(characterId))) return { handleId: id, usable: false, reason: 'unavailable' }
    return { handleId: id, usable: true }
  })
  return {
    roots, conversationCount: lineage.conversationCount, sourceVerdicts,
    revisions: Object.fromEntries([
      ...rows.map(row => [String(row.id), Number(row.sequence)]),
      ...dependencies.map(row => [`memory:${String(row.id)}`, Number(row.revision)]),
      ...memories.flatMap(record => record === null ? [] : [[`memory:${String(record.id)}`, record.revision]]),
      ...beliefs.flatMap(row => row === undefined ? [] : [[`belief:${String(row.state.beliefId)}`, row.revision]]),
    ]),
    usable: lineage.usable && derivedUsable && sourceVerdicts.every(verdict => verdict.usable),
    unresolvedConflict: dependencies.some(row => String(row.status) === 'disputed') || beliefStates.some(state => state.status === 'disputed'),
    fingerprint: JSON.stringify(rows.map(row => [row.id, row.sequence, row.character_id, row.actor_type, row.actor_id]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
  }
}
