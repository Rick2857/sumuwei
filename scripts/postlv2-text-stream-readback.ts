/** Read the closed cancellation probe's copy; never open the production database. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = resolve(process.argv[2] ?? '')
assert.ok(source.startsWith(join(tmpdir(), 'project-lg-exp-postlv2-avatar-')), 'Only a closed avatar test copy is accepted')
const output = resolve('artifacts/post-lv2/text-stream-20261005')
const expected = JSON.parse(readFileSync(join(output, 'cancel-live.json'), 'utf8'))
const copied = join(mkdtempSync(join(tmpdir(), 'lg-stream-readback-')), 'data')
cpSync(source, copied, { recursive: true })
// ⚠️ 直接解析 `@electric-sql/pglite`（M12 · W4）：它已从 plugin-sql 的**传递依赖**
//    **提升为直接依赖**（0.3.16，同版本 ⇒ 仍是同一份，两个实例不会互相损坏）。
//    旧写法绕 plugin-sql 一圈只为拿到那一份，现在那条路随删包一起没了。
const { PGlite } = createRequire(import.meta.url)('@electric-sql/pglite') as {
  PGlite: new (path: string, options: { readOnly: boolean }) => {
    waitReady: Promise<void>
    query: <T>(statement: string, params: unknown[]) => Promise<{ rows: T[] }>
    close: () => Promise<void>
  }
}
const db = new PGlite(copied, { readOnly: true })
await db.waitReady
try {
  const messages = (await db.query<{ id: string; content: string }>(
    'select id, content from conversation_events where id = $1', [expected.replyId])).rows
  const traces = (await db.query<{ status: string; error: string; output_event_id: string }>(
    'select status, error, output_event_id from character_traces where trace_id = $1', [expected.traceId])).rows
  assert.equal(messages.length, 1)
  assert.equal(createHash('sha256').update(messages[0].content).digest('hex'), expected.persisted_prefix_sha256)
  assert.equal(traces.length, 1)
  assert.equal(traces[0].status, 'failed')
  assert.equal(traces[0].error, 'speech_stream_cancelled')
  assert.equal(traces[0].output_event_id, expected.replyId)
  writeFileSync(join(output, 'cancel-readback.json'), JSON.stringify({ pass: true,
    scope: 'SELECT on a copy of the closed avatar test database', assistantRows: messages.length,
    prefixMatchesWire: true, traceStatus: traces[0].status, traceError: traces[0].error,
    outputIdentityMatches: true, productionDatabaseOpened: false }, null, 2))
  console.log('PASS: stored checked prefix, real assistant identity and failed cancellation trace agree')
} finally { await db.close() }
