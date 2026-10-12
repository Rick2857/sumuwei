#!/usr/bin/env node
/*
 * INC-01 forensics: use PostgreSQL's own WAL reader (pg_walinspect) as an
 * oracle instead of a hand-rolled parser.
 *
 * Why: the decisive question for the preserved broken dataDir is whether the
 * LSN that pg_control names as `checkPoint` still holds a checkpoint record.
 * Postgres answers that authoritatively.
 *
 * Method: grow a DISPOSABLE reader cluster past the LSNs of interest, then copy
 * the preserved segment file(s) into that cluster's pg_wal and query them. The
 * preserved tree is only read from (copyFileSync out) and is never opened.
 *
 * Usage:
 *   node scripts/inc-01-rootcause/wal-oracle.mjs --reader <scratchDir> \
 *        --inject <segmentFile>... --record <lsn>... --checkpoints <a:b>... \
 *        [--out evidence.json]
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.cwd())
const args = process.argv.slice(2)
const listOf = (flag) => args.reduce((acc, a, i) => (a === flag ? [...acc, args[i + 1]] : acc), [])
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i === -1 ? dflt : args[i + 1]
}

function resolveDep(rel) {
  const pnpmDir = join(REPO, 'node_modules', '.pnpm')
  const cand = readdirSync(pnpmDir).filter((n) => /^@electric-sql\+pglite@/.test(n)).sort()
  if (cand.length === 0) throw new Error('could not find @electric-sql/pglite in node_modules/.pnpm')
  return `file:///${join(pnpmDir, cand[cand.length - 1], 'node_modules', '@electric-sql', 'pglite', 'dist', rel).replace(/\\/g, '/')}`
}
const { PGlite } = await import(resolveDep('index.js'))
const { pg_walinspect } = await import(resolveDep('contrib/pg_walinspect.js'))

const reader = argOf('--reader')
if (!reader) {
  console.error('usage: node wal-oracle.mjs --reader <scratchDir> --inject <seg>... --record <lsn>... [--checkpoints a:b]')
  process.exit(2)
}
const norm = reader.replace(/\\/g, '/')
if (!norm.includes('/inc-01-rootcause/')) {
  console.error(`REFUSED: ${reader} is not under an inc-01-rootcause scratch root`)
  process.exit(9)
}
if (!existsSync(reader)) mkdirSync(reader, { recursive: true })

const lsnToBytes = (lsn) => {
  const [hi, lo] = String(lsn).split('/')
  return (BigInt('0x' + hi) << 32n) + BigInt('0x' + lo)
}
let needed = 0n
for (const lsn of [...listOf('--record'), ...listOf('--checkpoints').map((r) => r.split(':')[1])]) {
  const b = lsnToBytes(lsn)
  if (b > needed) needed = b
}

const db = new PGlite(reader, { extensions: { pg_walinspect } })
await db.waitReady
await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_walinspect`)

const cur = () => db.query(`SELECT pg_current_wal_lsn()::text AS lsn, pg_wal_lsn_diff(pg_current_wal_lsn(),'0/0')::bigint AS b`).then((r) => r.rows[0])
let curRow = await cur()
let grown = 0
if (BigInt(curRow.b) <= needed) {
  await db.exec(`CREATE TABLE IF NOT EXISTS grow (id serial primary key, payload text)`)
  while (BigInt(curRow.b) <= needed + 0x100000n) {
    await db.query(`INSERT INTO grow(payload) VALUES ($1)`, ['y'.repeat(2048)])
    grown++
    if (grown % 25 === 0) curRow = await cur()
    if (grown > 400000) break
  }
}
curRow = await cur()

for (const f of listOf('--inject')) {
  copyFileSync(f, join(reader, 'pg_wal', f.split(/[\\/]/).pop()))
}

const out = { reader, readerLsn: curRow, grownInserts: grown, injected: listOf('--inject'), questions: [] }
const ask = async (q, sql, params) => {
  try {
    const r = await db.query(sql, params)
    q.rows = r.rows
  } catch (e) {
    q.error = String(e?.message ?? e)
  }
  out.questions.push(q)
}
for (const lsn of listOf('--record')) {
  await ask({ kind: 'record', lsn }, `SELECT * FROM pg_get_wal_record_info($1::pg_lsn)`, [lsn])
}
for (const rng of listOf('--checkpoints')) {
  const [s, e] = rng.split(':')
  await ask(
    { kind: 'checkpoints', range: rng },
    `SELECT start_lsn::text, end_lsn::text, record_type, record_length, description
     FROM pg_get_wal_records_info($1::pg_lsn, $2::pg_lsn)
     WHERE record_type LIKE '%CHECKPOINT%' ORDER BY start_lsn LIMIT 100`,
    [s, e],
  )
}
try {
  await db.close()
} catch {}

// Interpret the decisive question: does a record start exactly at the named LSN?
const namedLsn = argOf('--named-lsn', null)
if (namedLsn) {
  const q = out.questions.find((x) => x.kind === 'record' && x.lsn === namedLsn)
  const start = q?.rows?.[0]?.start_lsn ?? null
  out.interpretation = {
    namedLsn,
    recordStartsExactlyThere: start === namedLsn,
    firstRecordAtOrAfter: start,
    note: 'pg_get_wal_record_info() reports the record covering/after the LSN; if start_lsn != the LSN, no record begins there',
  }
}

const payload = JSON.stringify(out, null, 1)
const outFile = argOf('--out', null)
if (outFile) writeFileSync(outFile, payload)
console.log(payload)
