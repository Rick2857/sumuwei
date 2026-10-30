/** Dedicated serversim pgtest only; independent of uncommitted shared harness changes. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'

export async function withKnowledgeTestDatabase<T>(adminUrl: string, _label: string,
  run: (test: { database: string; url: string; pool: pg.Pool; admin: pg.Pool }) => Promise<T>): Promise<T> {
  const target = new URL(adminUrl)
  assert.equal(target.hostname, 'pgtest')
  const id = randomBytes(6).toString('hex'), database = `lg_test_${id}`, role = `lg_test_knowledge_${id}`
  const password = randomBytes(24).toString('hex')
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 })
  let pool: pg.Pool | undefined
  try {
    await admin.query(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole nobypassrls`)
    await admin.query(`create database ${database} owner ${role}`)
    const extensionUrl = new URL(adminUrl); extensionUrl.pathname = '/' + database
    const extension = new pg.Client({ connectionString: extensionUrl.href })
    await extension.connect()
    try { await extension.query('create extension vector; create extension pgcrypto; create extension fuzzystrmatch') }
    finally { await extension.end() }
    target.pathname = '/' + database; target.username = role; target.password = password
    pool = new pg.Pool({ connectionString: target.href, max: 2 })
    return await run({ database, url: target.href, pool, admin })
  } finally {
    await pool?.end()
    try {
      await admin.query(`drop database if exists ${database} with (force)`)
      await admin.query(`drop role if exists ${role}`)
      assert.equal((await admin.query('select count(*)::int n from pg_database where datname=$1', [database])).rows[0].n, 0)
      assert.equal((await admin.query('select count(*)::int n from pg_roles where rolname=$1', [role])).rows[0].n, 0)
    } finally { await admin.end() }
  }
}
