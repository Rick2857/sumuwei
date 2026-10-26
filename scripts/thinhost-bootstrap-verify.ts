import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { drizzle } from 'drizzle-orm/node-postgres'
import { withPgTest } from './postgresql/test-harness.ts'
import { compatibilityCatalog } from './postgresql/compatibility-catalog.ts'

await withPgTest('bootstrap', async test => {
  const { MIGRATIONS } = await import('../src/infrastructure/persistence/migrations.ts')
  const { applyKernelMigrations } = await import('../src/infrastructure/persistence/db.ts')
  const db = drizzle(test.pool)
  let checks = 0
  const check = (label: string) => { checks++; console.log(`PASS ${label}`) }
  const snapshot = async () => {
    const tables = (await test.pool.query(`select tablename from pg_tables where schemaname='public' order by tablename`)).rows
    const data = []
    for (const { tablename } of tables) {
      const rows = (await test.pool.query(`select row_to_json(t)::text as r from public."${tablename}" t order by row_to_json(t)::text`)).rows
      data.push({ tablename, rows })
    }
    const schema = spawnSync('docker', ['exec', test.container, 'pg_dump', '-U', 'postgres', '-d', test.database,
      '--schema-only', '--no-owner', '--no-privileges'], { encoding: 'utf8', windowsHide: true })
    assert.equal(schema.status, 0)
    const normalized = schema.stdout.replace(/^\\(?:un)?restrict.*$/gm, '').replace(/^--.*$/gm, '')
    return JSON.stringify({ tables, data, schema: normalized })
  }
  const cli = (apply: boolean) => spawnSync(process.execPath,
    ['--import', './node_modules/tsx/dist/loader.mjs', 'src/main.ts', '--migrate', ...(apply ? ['--apply'] : [])],
    { env: { ...process.env, CHARACTER_THIN_HOST: 'on' }, encoding: 'utf8', timeout: 90_000, windowsHide: true })
  const before = await snapshot()
  const preview = cli(false)
  assert.equal(preview.status, 0, preview.stderr)
  assert.equal(await snapshot(), before)
  check('empty database preview creates no tables')
  // Real ordinary init: a rejected process must not mutate schema or data.
  const rejected = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs',
    'scripts/thinhost-initdb-verify.ts'], { env: { ...process.env }, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stdout + rejected.stderr, /kernel_migration_pending|迁移|migrate:apply/)
  assert.equal(await snapshot(), before)
  check('A3 empty startup refuses with nonzero exit and zero schema/data changes')
  const applied = cli(true)
  assert.equal(applied.status, 0, applied.stderr)
  const frozen = JSON.parse(readFileSync('evals/postgresql/compatibility-baseline.json', 'utf8'))
  const expected = frozen.tables.map((table: Record<string, unknown>) => ({ ...table, triggers: table.triggers ?? [] }))
  assert.deepEqual(await compatibilityCatalog(test.pool), expected)
  check('A1 explicit CLI migration matches all six upstream table structures')
  const ready = await snapshot()
  assert.equal(cli(true).status, 0)
  assert.equal(await snapshot(), ready)
  check('A4 repeated explicit migration is byte-for-byte idempotent')
  // Existing v22 shape: retain actual compatibility tables and data, remove only
  // this fixture's new ledger row to exercise the append-only upgrade.
  await test.pool.query(`insert into agents(id,name) values('00000000-0000-4000-8000-000000000001','升级保留');
    delete from character_schema_migrations where version=23`)
  const oldData = (await test.pool.query('select row_to_json(a)::text from agents a order by id')).rows
  const old = await snapshot()
  assert.notEqual(cli(false).status, null)
  const pendingReject = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs',
    'scripts/thinhost-initdb-verify.ts'], { env: { ...process.env }, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  assert.notEqual(pendingReject.status, 0)
  assert.equal(await snapshot(), old)
  check('A3 v22 startup cannot silently apply v23')
  await applyKernelMigrations(db as never)
  assert.deepEqual((await test.pool.query('select row_to_json(a)::text from agents a order by id')).rows, oldData)
  assert.equal((await test.pool.query('select max(version) as v from character_schema_migrations')).rows[0].v, MIGRATIONS.at(-1)!.version)
  check('A2 isolated v22 upgrade preserves compatibility business rows')
  const afterUpgrade = await snapshot()
  const started = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs',
    'scripts/thinhost-initdb-verify.ts'], { env: { ...process.env }, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  assert.equal(started.status, 0, started.stdout + started.stderr)
  assert.equal(await snapshot(), afterUpgrade)
  check('ready startup leaves schema/data/migration rows unchanged')
  assert.ok(checks > 0)
  console.log(JSON.stringify({ backend: 'postgres', checks, status: 'PASS', productionAccess: false }))
})
