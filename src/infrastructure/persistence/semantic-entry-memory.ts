import { sql } from 'drizzle-orm'
import { exec, type RawDb } from './db.ts'
import type { CharacterId } from '../../kernel/contracts/ids.ts'

/** Background extraction cannot reinterpret a command already owned by the entry. */
export async function semanticMemoryDisposition(db: RawDb, characterId: CharacterId, eventId: string): Promise<'legacy' | 'automatic' | 'skip'> {
  const rows = await exec(db, sql`select steps from character_traces where character_id = ${characterId}
    and input_event_id = ${eventId} order by started_at desc limit 1`, 'semantic memory ownership')
  const steps = rows[0]?.steps
  if (!Array.isArray(steps)) return 'skip'
  const entry = steps.find(step => step.kind === 'semantic_entry' && step.attributes?.phase !== 'after_read')
  if (!entry) return 'skip'
  return entry.attributes?.outcome === 'planned' && !String(entry.attributes?.domains).split(',').includes('memory') ? 'automatic' : 'skip'
}
