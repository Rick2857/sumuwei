/** 已有服务器逻辑快照 → simhost 内独立 PG 测试库；不采集生产。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { parsePlainDump } from './backup.ts'

export function readVerifiedPgSnapshot(directory: string) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
    seededAt: string; source: { kind: string }; dumpBytes: number; dumpSha256: string
  }
  const sql = readFileSync(join(directory, 'dump.sql'), 'utf8')
  const parsed = parsePlainDump(sql)
  assert.ok(['server', 'local-container'].includes(manifest.source.kind), 'pg_snapshot_origin_required')
  assert.ok(Number.isFinite(Date.parse(manifest.seededAt)), 'pg_snapshot_capture_time_required')
  assert.ok(parsed.headerPresent && parsed.endMarkerPresent, 'pg_snapshot_truncated')
  assert.equal(parsed.bytes, manifest.dumpBytes, 'pg_snapshot_size_mismatch')
  assert.equal(parsed.sha256, manifest.dumpSha256, 'pg_snapshot_digest_mismatch')
  assert.ok(parsed.tables.length > 0 && parsed.totalRows > 0, 'pg_snapshot_data_required')
  return { sql, parsed, capturedAt: manifest.seededAt, origin: manifest.source.kind }
}

/** 去除已由测试床安装的扩展 DDL；COPY 数据逐字保留，不解析普通 SQL。 */
export function snapshotRestoreSql(sql: string): string {
  let inCopy = false
  return sql.split('\n').filter(line => {
    if (inCopy) {
      if (line === '\\.') inCopy = false
      return true
    }
    if (/^COPY .* FROM stdin;$/.test(line)) inCopy = true
    assert.ok(!/^\s*\\(?:connect|c)(?:\s|$)|^\s*CREATE DATABASE\b/i.test(line), 'pg_snapshot_target_switch_forbidden')
    // pg_dump 只需要 restrict/unrestrict；拒绝 shell、include、变量设置等客户端命令。
    assert.ok(!/^\s*\\/.test(line) || /^\s*\\(?:un)?restrict\s+\S+\s*$/.test(line), 'pg_snapshot_client_command_forbidden')
    return !/^(?:(?:CREATE|DROP|ALTER)\s+EXTENSION\b|COMMENT ON EXTENSION\b)/i.test(line)
  }).join('\n')
}

export async function restoreSimPgSnapshot(url: string, directory = '/opt/serversim/seed') {
  const target = new URL(url)
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol), 'pg_snapshot_bad_protocol')
  assert.equal(target.hostname, 'pgtest', 'pg_snapshot_requires_sim_pgtest')
  const database = decodeURIComponent(target.pathname.slice(1))
  const role = decodeURIComponent(target.username)
  assert.match(database, /^lg_test_[a-f0-9]+$/)
  assert.match(role, /^lg_test_owner_[a-f0-9]+$/)
  assert.equal(database, process.env.LG_PG_EXPECT_DATABASE)
  assert.equal(role, process.env.LG_PG_EXPECT_USER)
  const source = readVerifiedPgSnapshot(directory)
  const pool = new pg.Pool({ connectionString: url })
  try {
    const identity = (await pool.query('select current_database() as database, current_user as role')).rows[0]
    assert.deepEqual(identity, { database, role })
    const restoreEnv: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: decodeURIComponent(target.password) }
    for (const name of ['PGHOSTADDR', 'PGSERVICE', 'PGOPTIONS']) delete restoreEnv[name]
    const restored = spawnSync('psql', ['--no-psqlrc', '--no-password', '--host', target.hostname,
      '--port', target.port || '5432', '--username', role, '--dbname', database,
      '--single-transaction', '--set', 'ON_ERROR_STOP=1', '--quiet'], {
      input: snapshotRestoreSql(source.sql), encoding: 'utf8', timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: restoreEnv,
    })
    assert.equal(restored.status, 0, `pg_snapshot_restore_failed: ${restored.error?.message ?? ''} ${restored.stderr.slice(-1200)}`)
    for (const table of source.parsed.tables) {
      const count = (await pool.query(`select count(*)::int as count from ${table.name}`)).rows[0].count
      assert.equal(count, table.rows, `pg_snapshot_row_count: ${table.name}`)
    }
    return { sha256: source.parsed.sha256, capturedAt: source.capturedAt, origin: source.origin,
      tables: source.parsed.tables.map(table => table.name), rows: source.parsed.totalRows,
      target: { database, role } }
  } finally {
    await pool.end()
  }
}
