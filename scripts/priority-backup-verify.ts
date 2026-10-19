import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('priority-backup-verify')
const { MIGRATIONS } = await import('../src/infrastructure/persistence/migrations.ts')
const { backup, verify } = await import('./deploy/postgresql-backup.ts')
const run = `lg-priority-${randomUUID().slice(0, 8)}`
const source = `${run}-source`
const target = `${run}-restore`
const out = join('artifacts/post-lv2/local/priority-three-20261018', `backup-${Date.now()}`)
mkdirSync(out, { recursive: true })
function sql(container: string, database: string, user: string, text: string): string {
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database],
    { input: text, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true })
  if (r.status !== 0) throw new Error(`fixture_sql_failed: ${r.stderr.slice(0, 1000)}`)
  return r.stdout.trim()
}
function docker(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  assert.equal(r.status, 0, `isolated fixture docker ${args[0]} failed`)
  return r.stdout
}
function assertOwned(name: string): void {
  const info = JSON.parse(docker(['inspect', name]))[0]
  assert.equal(info.Config.Labels['project-lg.task'], run)
  assert.equal(info.HostConfig.NetworkMode, 'none')
  assert.equal(info.Mounts.find((m: { Destination: string }) => m.Destination === '/var/lib/postgresql/data').Name, `${name}-data`)
}
const owned: string[] = []
try {
for (const name of [source, target]) {
  docker(['volume', 'create', '--label', `project-lg.task=${run}`, `${name}-data`])
  docker(['create', '--name', name, '--network', 'none', '--label', `project-lg.task=${run}`,
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '--mount', `type=volume,source=${name}-data,target=/var/lib/postgresql/data`,
    'pgvector/pgvector:0.8.7-pg17-bookworm'])
  owned.push(name)
  assertOwned(name) // Inspect actual mount before starting any PostgreSQL process.
  docker(['start', name])
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { windowsHide: true }).status === 0) { ready = true; break }
    await new Promise(done => setTimeout(done, 200))
  }
  assert.ok(ready, 'isolated PostgreSQL must become ready')
}
const db = `lg_priority_${Date.now()}`
const role = 'lg_priority_owner'
sql(source, 'postgres', 'postgres', `do $$ begin create role ${role} login nosuperuser nobypassrls; exception when duplicate_object then null; end $$;
  create database ${db} owner ${role};`)
sql(source, db, 'postgres', 'create extension vector;')
sql(source, db, role, MIGRATIONS.flatMap(m => m.statements).map(s => s + ';').join('\n'))
sql(source, db, role, `create table priority_values (id bigint primary key, note text, amount numeric, raw bytea, meta jsonb, embedding vector(3));
  insert into priority_values values (9007199254740993,'中文\n两行',12345678901234567890.123456,'\\x0001ff','{"value":"来源"}','[1,2,3]');
  create table priority_empty(id int primary key);
  create schema migrations; create table migrations.priority_version(version int); insert into migrations.priority_version values(22);
  create table priority_rls(id int primary key,note text); insert into priority_rls values(1,'全部内容'),(2,'不能丢失');
  alter table priority_rls enable row level security; alter table priority_rls force row level security;
  create policy priority_all on priority_rls for select using (coalesce(current_setting('lg.scope_mode',true),'') <> 'external_query');`)
// A caller's external read scope must not silently turn a full backup into a partial one.
sql(source, db, 'postgres', `alter role ${role} set lg.scope_mode='external_query';`)
const old = spawnSync('docker', ['exec', source, 'pg_dump', '-U', role, '-d', db, '--no-owner', '--no-privileges'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
assert.notEqual(old.status, 0, 'old pg_dump arguments must fail under FORCE RLS')
console.log('PASS old dump failure reproduced under real FORCE RLS')
const writer = spawn('docker', ['exec', '-i', source, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', role, '-d', db],
  { windowsHide: true })
writer.stdout.resume(); writer.stderr.resume()
const writerDone = new Promise<void>((done, reject) => { writer.once('error', reject); writer.once('exit', code =>
  code === 0 ? done() : reject(new Error('concurrent_writer_failed'))) })
writer.stdin.end(Array.from({ length: 120 }, () => "update priority_values set note=note||'.'; select pg_sleep(0.05);").join('\n'))
const before = sql(source, db, role, 'select length(note) from priority_values;')
await backup({ container: source, database: db, user: role }, out)
await writerDone
assert.notEqual(sql(source, db, role, 'select length(note) from priority_values;'), before, 'writer must change source during backup')
const manifestFile = join(out, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
assert.ok(manifest.tables.some((t: { table: string; rowCount: number }) => t.table === 'public.priority_empty' && t.rowCount === 0))
assert.equal(manifest.tables.find((t: { table: string }) => t.table === 'public.priority_rls').rowCount, 2)
await assert.rejects(() => verify(manifestFile, source, 'postgres'), /not_isolated/)
await verify(manifestFile, target, 'postgres')
const result = JSON.parse(readFileSync(join(out, 'restore-verification.json'), 'utf8'))
assert.equal(result.status, 'PASS')
const dumpFile = join(out, 'dump.sql')
const original = readFileSync(dumpFile)
const altered = Buffer.from(original)
altered[Math.floor(altered.length / 2)] ^= 1
writeFileSync(dumpFile, altered)
await assert.rejects(() => verify(manifestFile, target, 'postgres'), /digest_mismatch/)
writeFileSync(dumpFile, original.subarray(0, original.length - 100))
await assert.rejects(() => verify(manifestFile, target, 'postgres'), /truncated/)
writeFileSync(dumpFile, original)
await verify(manifestFile, target, 'postgres')
writeFileSync(join(out, 'checks.json'), JSON.stringify({ status: 'PASS', checks: ['actual migrations 1..22', 'FORCE RLS old failure',
  'concurrent writer with same snapshot dump and fields', 'empty table', 'schema and RLS restore', 'large numeric and bigint', 'bytea JSON vector Chinese',
  'same instance refused', 'tamper refused', 'truncation refused', 'restored after negative controls'],
  source, target, productionDatabaseOpened: false, restoredTableCount: result.tableCount }, null, 2))
sql(source, 'postgres', 'postgres', `drop database ${db};`)
console.log(`PASS PostgreSQL backup/restore: ${result.tableCount} tables; ${out}`)
} finally {
  for (const name of owned.reverse()) {
    assertOwned(name)
    docker(['rm', '-f', name])
    const volume = JSON.parse(docker(['volume', 'inspect', `${name}-data`]))[0]
    assert.equal(volume.Labels['project-lg.task'], run)
    docker(['volume', 'rm', `${name}-data`])
  }
}
