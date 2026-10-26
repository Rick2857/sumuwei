/** Read-only provenance: actual successful reads, bounded to a trace and declared sources. */
import { sql } from 'drizzle-orm'
import type { WriteSourceDeclaration, WriteSourceReadReceipt } from '../../kernel/contracts/write-source-attribution.ts'
import { exec, type RawDb } from './db.ts'

export type WriteSourcesForTarget = (targetPath: string) => readonly WriteSourceDeclaration[]

export async function readWriteSourceReceipts(db: RawDb, input: {
  characterId: string
  activeUserId: string
  traceId: string
  declarations: readonly WriteSourceDeclaration[]
  /** Historical evidence must not borrow a read performed after the write. */
  beforeSequence?: number
}): Promise<WriteSourceReadReceipt[]> {
  const paths = [...new Set(input.declarations.map(item => item.path))]
  if (paths.length === 0 || paths.length > 2) return []
  const rows = await exec(db, sql`select action_id, sequence, event_type, operation,
      payload->'target'->>'canonicalId' as path, payload->'effect'->>'fingerprint' as fingerprint
    from character_action_events
    where character_id = ${input.characterId} and trace_id = ${input.traceId}
      and initiator_kind = 'USER' and initiator_id = ${input.activeUserId}
      and capability in ('sandbox.file.read', 'sandbox.file.write')
      and payload->'target'->>'canonicalId' in (${sql.join(paths.map(path => sql`${path}`), sql`, `)})
      ${input.beforeSequence === undefined ? sql`` : sql`and sequence < ${input.beforeSequence}`}
      and event_type in ('ACTION_SUCCEEDED', 'ACTION_STARTED')
    order by sequence desc limit 65`, 'write source receipts in trace')
  // A truncated history is unknown, never partial proof of a unique source.
  if (rows.length > 64) return []
  const latest = new Map<string, WriteSourceReadReceipt | undefined>()
  for (const row of rows) {
    const path = String(row.path)
    if (latest.has(path)) continue
    if (row.operation === 'write') { latest.set(path, undefined); continue }
    if (row.event_type !== 'ACTION_SUCCEEDED' || typeof row.fingerprint !== 'string') continue
    latest.set(path, { path, contentFingerprint: row.fingerprint, taskId: input.traceId, ok: true })
  }
  return [...latest.values()].filter((item): item is WriteSourceReadReceipt => item !== undefined)
}
