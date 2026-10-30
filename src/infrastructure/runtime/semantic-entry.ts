import { entityRef } from '../../kernel/contracts/entity.ts'
import type { CharacterId, ConversationEvent } from '../../kernel/contracts/index.ts'
import type { ChatChannel } from '../../kernel/contracts/chat-channel.ts'
import type { RelayOrigin } from '../../kernel/app/relay-turn.ts'
import { candidatesFromGoals } from '../../kernel/app/goal/turn.ts'
import type { SemanticDomain, SemanticEntryInput, SemanticEntryResult, SemanticToolContext } from '../../kernel/app/semantic-entry.ts'
import { createOpenAiSemanticEntry } from '../model/openai-semantic-entry.ts'
import { recentConversationEvents } from '../persistence/conversation-store.ts'
import { listGoalStates } from '../persistence/goal-store.ts'
import { createNativeMemoryStore } from '../persistence/memory-store.ts'
import { listPendingIntents } from '../persistence/notification-store.ts'
import { listRelayTasks } from '../persistence/relay-store.ts'
import { listGroupTasks } from '../persistence/qq-group-task-store.ts'
import { computeWithdrawnEvidence } from '../persistence/withdrawn-evidence.ts'
import type { RawDb } from '../persistence/db.ts'
import { ImageInputStore } from '../media/image-input.ts'
import { IMAGE_INPUT_LIMITS } from '../../kernel/contracts/image-input.ts'

/** Read-only scoped context; all effects remain in existing domain validators and writers. */
export async function resolveSemanticEntry(input: {
  db: RawDb; event: ConversationEvent; characterId: CharacterId; activeUserId: string; ownerRef: string
  entry: ChatChannel; channels: readonly ChatChannel[]; domains: readonly SemanticDomain[]
  origin?: RelayOrigin; ownerPrivate: boolean; imageRefs: readonly string[]; imageDataRoot?: string
  tools?: SemanticToolContext
  materials?: SemanticEntryInput['materials']; priorDomains?: readonly SemanticDomain[]
  replyMedia?: SemanticEntryInput['replyMedia']
  conversationContext?: SemanticEntryInput['conversationContext']
  /** ADR-156：机器人实际所在群（只读；由装配层从 OneBot 群列表取，拿不到就不传） */
  qqGroups?: SemanticEntryInput['qqGroups']
}): Promise<SemanticEntryResult> {
  try {
    if (input.event.content.length > 12000) return { kind: 'failed', code: 'context_unavailable' }
    const store = createNativeMemoryStore(input.db)
    const owner = entityRef('character', String(input.characterId))
    const withdrawn = await computeWithdrawnEvidence(input.db, store, owner)
    if (!withdrawn.ok) return { kind: 'failed', code: 'context_unavailable' }
    const blocked = new Set(withdrawn.withdrawnEventIds)
    const history = await recentConversationEvents(input.db, { characterId: input.characterId,
      conversationId: input.event.conversationId, beforeSequence: input.event.sequence - 1, limit: 24 })
    const recent = history.filter(row => row.conversationId === input.event.conversationId
      && !blocked.has(String(row.id)) && (row.actorType === 'user' || row.actorType === 'character'))
      .map(row => ({ id: String(row.id), text: [...row.content].slice(0, 2000).join(''), createdAt: row.createdAt,
        actor: row.actorType as 'user' | 'character', truncated: [...row.content].length > 2000 }))
    const memoryRows = input.domains.includes('memory')
      ? await store.listBySubject(owner, entityRef('user', input.activeUserId)) : []
    const eligibleMemories = memoryRows.filter(row => ['active', 'disputed'].includes(row.status)
      && !row.sourceRefs.some(ref => ref.kind === 'conversation_event' && blocked.has(String(ref.id))))
    const memories = eligibleMemories.slice(-40)
      .map(row => ({ id: String(row.id), content: JSON.stringify(row.content).slice(0, 1000) }))
    const rows = input.domains.includes('reminder') ? await listPendingIntents(input.db, input.characterId,
      { kind: 'reminder', ownerRef: input.ownerRef, conversationRef: input.event.conversationId, editable: true, limit: 500 }) : []
    const pending = rows.filter(row => row.scheduledAt > input.event.createdAt && !row.sourceRefs.some(ref => blocked.has(ref)))
      .map(row => ({ id: String(row.id), text: row.text!, dueAt: row.scheduledAt, sourceRefs: row.sourceRefs,
        channel: row.deliveryChannel, ...(row.repeatMode ? { repeatMode: row.repeatMode } : {}) }))
    const states = input.domains.includes('goal') ? await listGoalStates(input.db, input.characterId) : []
    const goals = candidatesFromGoals({ goals: states.map(row => row.goal), withdrawnEventIds: blocked, labelOf: goal => goal.statement }).candidates.slice(0, 40)
    const relayTasks = input.domains.includes('relay') && input.origin ? await listRelayTasks(input.db,
      { characterId: input.characterId, ownerRef: input.ownerRef, origin: input.origin, ownerPrivate: input.ownerPrivate }) : []
    /*
     * ADR-156：群任务域只在启用时读任务事实（**只读**；不在这里做任何授权判断）。
     * ⚠️ 群列表是**外部事实**，由装配层从 OneBot `get_group_list` 取后传入；
     *    这里不自己连平台（这个模块只读库与已给的事实）。
     */
    const groupTasks: SemanticEntryInput['groupTasks'] = input.domains.includes('group_task')
      ? await listGroupTasks(input.db, { limit: 50 }) : []
    const materials: NonNullable<SemanticEntryInput['materials']>[number][] = [...(input.materials ?? [])]
    let unavailableMaterials = 0
    if (input.imageDataRoot && !input.priorDomains) {
      const images = new ImageInputStore(input.imageDataRoot)
      const refs = input.imageRefs.length ? input.imageRefs.map(ref => ({ ref, event: input.event }))
        : (await recentConversationEvents(input.db, { characterId: input.characterId,
          conversationId: input.event.conversationId, limit: IMAGE_INPUT_LIMITS.maxContextImages, imagesOnly: true }))
          .filter(row => row.conversationId === input.event.conversationId && !blocked.has(String(row.id)))
          .flatMap(row => (Array.isArray(row.metadata?.imageRefs) ? row.metadata.imageRefs : [])
            .filter((ref): ref is string => typeof ref === 'string').map(ref => ({ ref, event: row })))
      let bytes = 0
      for (const { ref, event } of refs.slice(0, IMAGE_INPUT_LIMITS.maxContextImages)) {
        const image = await images.load(ref)
        const size = image ? image.dataUrl.split(',')[1].length * 3 / 4 : 0
        if (!image || bytes + size > IMAGE_INPUT_LIMITS.maxContextBytes) { unavailableMaterials++; continue }
        bytes += size
        materials.push({ id: ref, text: event.content.slice(0, 2000), createdAt: event.createdAt, dataUrl: image.dataUrl })
      }
    }
    return await createOpenAiSemanticEntry()({ current: { id: String(input.event.id), text: input.event.content, createdAt: input.event.createdAt },
      recent, pending, memories, goals, relayTasks, groupTasks, materials, enabledDomains: input.domains, priorDomains: input.priorDomains,
      ...(input.qqGroups === undefined ? {} : { qqGroups: input.qqGroups }),
      ...(input.conversationContext === undefined ? {} : { conversationContext: input.conversationContext }),
      omittedMemories: Math.max(0, eligibleMemories.length - memories.length), unavailableMaterials,
      toolCatalog: input.tools?.catalog ?? '', availableCapabilities: input.tools?.capabilities ?? [],
      ...(input.replyMedia === undefined ? {} : { replyMedia: input.replyMedia }),
      knownDirectories: input.tools?.knownDirectories, openTask: input.tools?.openTask,
      entry: input.entry, availableChannels: input.channels }, input.tools?.validate)
  } catch { return { kind: 'failed', code: 'context_unavailable' } }
}
