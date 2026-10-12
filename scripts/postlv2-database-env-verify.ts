import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { liveSmokeSource } from './live-smoke-source.ts'
import { PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

// The fixture's cwd defines its production path; no real LG database is opened.
const fixture = mkdtempSync(join(tmpdir(), 'lg-database-env-'))
const production = join(fixture, 'data/pglite')
const nestedProduction = join(fixture, 'nested/data/pglite')
const child = join(fixture, 'probe.mts')
mkdirSync(join(fixture, 'nested'))
writeFileSync(join(fixture, '.env'), `PGLITE_DATA_DIR=${production.replaceAll('\\', '/')}\n`)
writeFileSync(child, `import { initDatabase } from ${JSON.stringify(pathToFileURL(resolve('src/db/index.ts')).href)};
let initialized = 0;
try { await initDatabase({ registerPlugin: async () => { initialized++; throw Error('fixture_plugin'); } }, {}); }
catch (error) { console.log(JSON.stringify({ initialized, message: String(error) })); }
`)
const baseEnv = { ...process.env }
for (const key of ['PGLITE_DATA_DIR', 'PROJECT_LG_SANDBOX', 'PROJECT_LG_ALLOW_PRODUCTION_DB']) delete baseEnv[key]
const cases: { name: string; pass: boolean }[] = []
try {
  for (const test of [
    { name: 'dotenv production path is denied before plugin initialization', env: {}, cwd: fixture, initialized: 0 },
    { name: 'stale sandbox flag cannot authorize production', env: { PROJECT_LG_SANDBOX: join(fixture, 'old') }, cwd: fixture, initialized: 0 },
    { name: 'production allowance still requires a preopen token', env: { PROJECT_LG_ALLOW_PRODUCTION_DB: '1' }, cwd: fixture, initialized: 0 },
    { name: 'explicit isolated path survives dotenv loading', env: { PGLITE_DATA_DIR: join(fixture, 'isolated') }, cwd: fixture, initialized: 1 },
  ]) {
    const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), child],
      { cwd: test.cwd, env: { ...baseEnv, ...test.env }, encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, result.stderr)
    const reading = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    const pass = reading.initialized === test.initialized
    cases.push({ name: test.name, pass })
    assert.ok(pass, `${test.name}: ${JSON.stringify(reading)}`)
  }
  writeFileSync(join(fixture, '.env'), `PGLITE_DATA_DIR=${nestedProduction.replaceAll('\\', '/')}\n`)
  const nested = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), child],
    { cwd: join(fixture, 'nested'), env: baseEnv, encoding: 'utf8', timeout: 30_000 })
  assert.equal(nested.status, 0, nested.stderr)
  const reading = JSON.parse(nested.stdout.trim().split('\n').at(-1)!)
  cases.push({ name: 'ancestor dotenv is also checked before initialization', pass: reading.initialized === 0 })
  assert.equal(reading.initialized, 0)
  const snapshotId = '2026-10-08T00-00-00-000Z-0123456789ab'
  const snapshot = join(fixture, `pglite-${snapshotId}`)
  mkdirSync(snapshot)
  writeFileSync(join(snapshot, 'fixture-bytes'), 'snapshot fixture, not a database')
  const select = () => liveSmokeSource([`--snapshot-source=${snapshot}`])
  assert.throws(select, /verified_manifest_required/)
  cases.push({ name: 'live smoke rejects a source without a verified manifest', pass: true })
  const digest = digestTree(snapshot)
  const manifest = { snapshotId, sourceDirKind: 'production-data-dir', algorithm: 'inc01-tree-digest-v1',
    excludedPaths: [], fileCount: digest.measuredCount, totalBytes: digest.totalBytes, nonVolatileTreeSha256: digest.treeSha256 }
  writeFileSync(`${snapshot}.manifest.json`, JSON.stringify(manifest))
  assert.equal(select().kind, 'verified_snapshot')
  cases.push({ name: 'live smoke selects matching snapshot bytes without opening them', pass: true })
  writeFileSync(`${snapshot}.manifest.json`, JSON.stringify({ ...manifest, snapshotId: '2026-10-08T00-00-00-000Z-abcdefabcdef' }))
  assert.throws(select, /verified_manifest_required/)
  cases.push({ name: 'snapshot directory and manifest identity must agree', pass: true })
  writeFileSync(`${snapshot}.manifest.json`, JSON.stringify({ ...manifest, excludedPaths: ['fixture-bytes'] }))
  assert.throws(select, /verified_manifest_required/)
  cases.push({ name: 'manifest cannot exclude arbitrary snapshot contents', pass: true })
  writeFileSync(`${snapshot}.manifest.json`, JSON.stringify(manifest))
  writeFileSync(join(snapshot, 'fixture-bytes'), 'tampered bytes')
  assert.throws(select, /snapshot_digest_mismatch/)
  cases.push({ name: 'live smoke rejects changed snapshot bytes', pass: true })
  assert.throws(() => liveSmokeSource([`--snapshot-source=${PRODUCTION_DB_DIR}`]), /overlaps_production/)
  cases.push({ name: 'snapshot option cannot name the production database', pass: true })
} finally { rmSync(fixture, { recursive: true, force: true }) }
console.log(JSON.stringify({ cases, productionDatabaseOpened: false }, null, 2))
