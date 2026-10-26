/** 共享 pgtest 实例上，两组场景必须使用各自的角色和数据库。 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import { runPgScenarioGate } from '../postgresql/scenario-gate.ts'

if (process.argv.includes('--case')) {
  const url = process.env.LG_TEST_PG_URL
  assert.ok(url)
  const pool = new pg.Pool({ connectionString: url })
  try {
    const identity = (await pool.query('select current_user as role, current_database() as database')).rows[0]
    assert.match(identity.role, /^lg_test_owner_[a-f0-9]+$/)
    assert.match(identity.database, /^lg_test_[a-f0-9]+$/)
    assert.equal(identity.role, decodeURIComponent(new URL(url).username))
    assert.equal((await pool.query('select pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()')).rows[0].owner,
      identity.role)
    await pool.query('create table scenario_isolation_probe (id integer primary key)')
    await pool.query('insert into scenario_isolation_probe values (1)')
    assert.equal((await pool.query('select count(*)::int as count from scenario_isolation_probe')).rows[0].count, 1)
    console.log(`ROLE=${identity.role} DATABASE=${identity.database}`)
  } finally {
    await pool.end()
  }
} else {
  assert.ok(process.env.LG_SIM_PGTEST_ADMIN_URL, '必须在 serversim 的独立 pgtest 实例内运行')
  const groups = await Promise.all(['first', 'second'].map(label => runPgScenarioGate({
    label: `scenario-isolation-${label}`,
    script: 'scripts/cognitive/scenario-isolation-verify.ts',
    scenarios: [{ id: 'isolated', argv: ['--case', 'isolated'] }],
  })))
  const identities = groups.map(group => {
    assert.equal(group.length, 1)
    assert.equal(group[0]!.ok, true, `${group[0]!.detail ?? ''}\n${group[0]!.tail}`)
    const identity = /ROLE=(\S+) DATABASE=(\S+)/.exec(group[0]!.tail)
    assert.ok(identity)
    return { role: identity[1], database: identity[2] }
  })
  assert.notEqual(identities[0]!.role, identities[1]!.role)
  assert.notEqual(identities[0]!.database, identities[1]!.database)
  const admin = new pg.Pool({ connectionString: process.env.LG_SIM_PGTEST_ADMIN_URL })
  try {
    assert.equal((await admin.query('select count(*)::int as count from pg_roles where rolname = any($1::text[])',
      [identities.map(identity => identity.role)])).rows[0].count, 0)
    assert.equal((await admin.query('select count(*)::int as count from pg_database where datname = any($1::text[])',
      [identities.map(identity => identity.database)])).rows[0].count, 0)
  } finally {
    await admin.end()
  }
  mkdirSync('artifacts/cognitive/local', { recursive: true })
  writeFileSync(`artifacts/cognitive/local/scenario-isolation-${Date.now()}.json`,
    JSON.stringify({ status: 'PASS', groups: identities, execution: 'serversim/pgtest' }, null, 2))
  console.log('PASS 两组并发场景使用不同角色与数据库，各自建表写入成功，结束后清理完成')
}
