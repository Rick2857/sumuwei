import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { AdaptiveSelfState } from '../../kernel/contracts/adaptive-self.ts'
import type { RawDb } from '../persistence/db.ts'
import { sourceRootsVisible } from '../persistence/read-scope.ts'
import { listAdaptiveSelfStates } from '../persistence/adaptive-self-store.ts'
import { readReflectionSourceSnapshot } from '../persistence/reflection-source-read.ts'
import { filterAdaptiveSelfThisTurn } from '../../kernel/app/reflection/invalidation.ts'
import { meetsStabilityThreshold } from '../../kernel/app/reflection/inputs.ts'
import { listReflectionRecords } from '../persistence/reflection-store.ts'
import { listJobs } from '../persistence/job-store.ts'
import { REFLECTION_PROCESSOR } from './reflection-scheduler.ts'
import { buildReflectionFactPack, reflectionFactInputFrom } from '../../kernel/app/reflection/fact-pack.ts'

/** Always requalify at the consumer; an old enhanced projection is not current permission. */
export async function readUsableAdaptiveSelfStates(
  db: RawDb, characterId: CharacterId, activeUserId?: string,
): Promise<AdaptiveSelfState[]> {
  let states: AdaptiveSelfState[]
  try { states = await listAdaptiveSelfStates(db, characterId) } catch { return [] }
  const result: AdaptiveSelfState[] = []
  for (const state of states) {
    if (state.level === 'enhanced' && !await sourceRootsVisible(db, state.roots)) continue
    if (state.level !== 'enhanced') { result.push(state); continue }
    try {
      const snapshot = await readReflectionSourceSnapshot(db, characterId, state.roots.map(id => ({
        id, kind: id.startsWith('cev:') ? 'conversation_event' as const : 'domain_event' as const,
      })), { activeUserId })
      const verdict = filterAdaptiveSelfThisTurn({
        slot: state.slot, roots: snapshot.roots,
        rootVerdicts: snapshot.sourceVerdicts.map(row => ({ rootId: row.handleId, usable: row.usable, reason: row.reason })),
      })
      if (snapshot.usable && verdict.usable && meetsStabilityThreshold({ rootCount: snapshot.roots.length, conversationCount: snapshot.conversationCount, unresolvedConflict: snapshot.unresolvedConflict }).met) result.push(state)
    } catch {
      // A missing current reading blocks this turn; it does not permanently retract history.
    }
  }
  return result
}

/** Read after same-turn domain operations, with the same current eligibility as rendering. */
export async function readCurrentReflectionFactPack(db: RawDb, characterId: CharacterId, activeUserId?: string) {
  const [records, usable, states, jobs] = await Promise.all([
    listReflectionRecords(db, characterId), readUsableAdaptiveSelfStates(db, characterId, activeUserId),
    listAdaptiveSelfStates(db, characterId), listJobs(db, characterId),
  ])
  const latestJob = jobs.filter(job => job.processor === REFLECTION_PROCESSOR)
    .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))[0]
  return buildReflectionFactPack(reflectionFactInputFrom({
    reflectionStatuses: records.map(record => String(record.status)),
    activeAdjustments: usable.filter(state => state.level === 'enhanced').length,
    invalidatedAdjustments: states.filter(state => state.invalidatedReason !== undefined).length,
    lastRunFailed: latestJob?.status === 'failed',
  }))
}
