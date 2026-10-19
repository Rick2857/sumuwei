/** Disposable PostgreSQL only. No .env, existing containers, volumes or fallback backend. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'

const IMAGE = 'pgvector/pgvector:0.8.7-pg17-bookworm'
export interface PgTest {
  container: string
  database: string
  url: string
  pool: pg.Pool
  admin: pg.Pool
}
function docker(args: string[], env = process.env): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', env, windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `isolated PostgreSQL: docker ${args[0]} failed (no fallback)`)
  return r.stdout.trim()
}
export function setPgTestEnvironment(url: string): void {
  const target = new URL(url)
  const database = decodeURIComponent(target.pathname.slice(1))
  assert.match(database, /^lg_test_[a-z0-9_]+$/)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname))
  Object.assign(process.env, {
    CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: url, LG_TEST_PG_URL: url,
    LG_PG_EXPECT_DATABASE: database, LG_PG_EXPECT_USER: decodeURIComponent(target.username),
    LG_PG_EXPECT_DATABASE_PREFIX: 'lg_test_', LG_PG_EXPECT_USER_PREFIX: '',
    PGLITE_DATA_DIR: '', PROJECT_LG_SANDBOX: '', LG_PRODUCTION_POSTGRES_URL: '',
    PROJECT_LG_ALLOW_KERNEL_MIGRATION: '', DATABASE_URL: '',
  })
}
export async function withPgTest<T>(label: string, run: (test: PgTest) => Promise<T>): Promise<T> {
  const id = randomBytes(6).toString('hex')
  const container = `lg-test-${label}-${id}`
  const volume = `${container}-data`
  const password = randomBytes(24).toString('hex')
  const database = `lg_test_${id}`
  const role = 'lg_test_owner'
  let created = false
  let pool: pg.Pool | undefined
  let admin: pg.Pool | undefined
  const inspect = () => JSON.parse(docker(['inspect', container]))[0]
  const assertOwned = () => {
    const info = inspect()
    assert.equal(info.Config.Labels['project-lg.test'], id)
    const mounts = info.Mounts.filter((m: { Destination: string }) => m.Destination === '/var/lib/postgresql/data')
    assert.equal(mounts.length, 1)
    assert.equal(mounts[0].Type, 'volume')
    assert.equal(mounts[0].Name, volume)
    assert.equal(info.HostConfig.PortBindings['5432/tcp'][0].HostIp, '127.0.0.1')
  }
  docker(['image', 'inspect', IMAGE]) // No automatic image pull.
  docker(['volume', 'create', '--label', `project-lg.test=${id}`, volume])
  try {
    docker(['create', '--name', container, '--label', `project-lg.test=${id}`,
      '-e', 'POSTGRES_PASSWORD', '--publish', '127.0.0.1::5432',
      '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`, IMAGE],
    { ...process.env, POSTGRES_PASSWORD: password })
    created = true
    assertOwned() // Actual resolved mount checked before the server can start.
    docker(['start', container])
    let ready = false
    /*
     * ⚠️⚠️ **就绪判据必须测 TCP，不能只测 Unix socket**（2026-10-19 实测修）。
     *
     * 旧判据：`pg_isready -U postgres`（**默认走容器内的 Unix socket**）。
     * 而下面 `admin` 连的是 **127.0.0.1:<HostPort>**（TCP）。
     * ⇒ socket 已经 ready、TCP 还没监听时，第一条 TCP 连接会被**当场断掉**
     *   ⇒ `Connection terminated unexpectedly`（实测在 `create role` 那一步）。
     * ⇒ 这个失败是**间歇性**的（看容器启动快慢）⇒ 会让门**时红时绿**，
     *   而"时红时绿的门"比"红的门"更坏：它会让人不再相信门。
     *
     * ⇒ 现在两个都测：socket **且** TCP。
     */
    for (let i = 0; i < 100; i++) {
      const sock = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { windowsHide: true, timeout: 2000 })
      const tcp = spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres'], { windowsHide: true, timeout: 2000 })
      if (sock.status === 0 && tcp.status === 0) { ready = true; break }
      await new Promise(done => setTimeout(done, 200))
    }
    assert.ok(ready, 'isolated PostgreSQL readiness timeout (socket AND TCP)')
    const port = Number(inspect().NetworkSettings.Ports['5432/tcp'][0].HostPort)
    admin = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 2 })
    /*
     * ⚠️ 连一次确认真的通了再继续 —— 连接池是**惰性**的，上面那条 `create role`
     *    才是第一次真正建连。若那一步被断，错误会伪装成"SQL 失败"。
     */
    await admin.query('select 1')
    await admin.query(`create role ${role} login password '${password}' nosuperuser nobypassrls;`)
    await admin.query(`create database ${database} owner ${role}`)
    const ownerUrl = `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`
    pool = new pg.Pool({ connectionString: ownerUrl, max: 4 })
    const ext = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password, database })
    await ext.connect()
    try { await ext.query('create extension vector; create extension fuzzystrmatch; create extension pgcrypto;') }
    finally { await ext.end() }
    const identity = (await pool.query('select current_database() as db, current_user as usr')).rows[0]
    assert.equal(identity.db, database)
    assert.equal(identity.usr, role)
    setPgTestEnvironment(ownerUrl)
    return await run({ container, database, url: ownerUrl, pool, admin })
  } finally {
    await pool?.end()
    await admin?.end()
    if (created) { assertOwned(); docker(['rm', '--force', container]) }
    const info = JSON.parse(docker(['volume', 'inspect', volume]))[0]
    assert.equal(info.Labels['project-lg.test'], id)
    docker(['volume', 'rm', volume])
  }
}

/** Existing gate body runs in its own process; preparation explicitly applies LG migrations. */
export async function runPreparedPgGate(label: string, script: string): Promise<void> {
  await withPgTest(label, async test => {
    const { applyKernelMigrations } = await import('../../src/infrastructure/persistence/db.ts')
    await applyKernelMigrations(drizzle(test.pool) as never)
    const child = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs', script, ...process.argv.slice(2)],
      { env: { ...process.env, LG_TEST_PG_URL: test.url }, stdio: 'inherit', windowsHide: true, timeout: 120_000 })
    assert.equal(child.status, 0, `${label}: PostgreSQL gate failed`)
  })
}
