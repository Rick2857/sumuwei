/** 快照验收负控：错误来源、损坏文件、切换目标和 COPY 正文不被改写。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readVerifiedPgSnapshot, restoreSimPgSnapshot, snapshotRestoreSql } from '../postgresql/snapshot-source.ts'

mkdirSync('artifacts/cognitive/local', { recursive: true })
const directory = mkdtempSync('artifacts/cognitive/local/pg-snapshot-negative-')
const sql = '-- PostgreSQL database dump\nDROP EXTENSION IF EXISTS vector;\nCOPY public.example (text) FROM stdin;\nDROP EXTENSION this-is-data;\nvalue\n\\.\n-- PostgreSQL database dump complete\n'
const manifest = { source: { kind: 'server' }, seededAt: '2026-10-20T00:00:00Z',
  dumpBytes: Buffer.byteLength(sql), dumpSha256: createHash('sha256').update(sql).digest('hex') }
const write = (text: string, record = manifest) => {
  writeFileSync(join(directory, 'dump.sql'), text)
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(record))
}
write(sql)
assert.equal(readVerifiedPgSnapshot(directory).parsed.totalRows, 2)
const filtered = snapshotRestoreSql(sql)
assert.ok(!filtered.includes('DROP EXTENSION IF EXISTS vector;'))
assert.ok(filtered.includes('DROP EXTENSION this-is-data;\nvalue\n\\.'))
assert.throws(() => snapshotRestoreSql('\\connect sumuwei\n'), /pg_snapshot_target_switch_forbidden/)
assert.throws(() => snapshotRestoreSql('CREATE DATABASE sumuwei;\n'), /pg_snapshot_target_switch_forbidden/)
assert.throws(() => snapshotRestoreSql('  \\connect sumuwei\n'), /pg_snapshot_target_switch_forbidden/)
assert.throws(() => snapshotRestoreSql('\\! echo untrusted\n'), /pg_snapshot_client_command_forbidden/)
assert.throws(() => snapshotRestoreSql('\\include other.sql\n'), /pg_snapshot_client_command_forbidden/)
write(sql.replace('value', 'other'))
assert.throws(() => readVerifiedPgSnapshot(directory), /pg_snapshot_digest_mismatch/)
write(sql.slice(0, -45))
assert.throws(() => readVerifiedPgSnapshot(directory), /pg_snapshot_truncated/)
write(sql, { ...manifest, source: { kind: 'synthetic' } })
assert.throws(() => readVerifiedPgSnapshot(directory), /pg_snapshot_origin_required/)
await assert.rejects(() => restoreSimPgSnapshot('postgresql://lg_test_owner_abc:test@pg/sumuwei'), /pg_snapshot_requires_sim_pgtest/)
await assert.rejects(() => restoreSimPgSnapshot('postgresql://lg_test_owner_abc:test@pgtest/sumuwei'), /lg_test_/)
writeFileSync(join(directory, 'verification.json'), JSON.stringify({ status: 'PASS', assertions: 13,
  execution: 'serversim', productionOpened: false }, null, 2))
console.log(`PG 快照来源负控：13/13；${directory}`)
