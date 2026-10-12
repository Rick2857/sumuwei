#!/usr/bin/env node
/*
 * INC-01 root-cause minimal reproduction (TD-18).
 *
 * What it demonstrates
 * --------------------
 * PGlite 0.3.16 (WASM PostgreSQL 17) has no cross-process exclusion on a dataDir.
 * If two live instances use the same dataDir and one of them holds a STALE WAL
 * insert position (it opened before the other advanced the WAL), the stale
 * instance later appends over the other's checkpoint record. pg_control still
 * names that record, so every later open fails during startup recovery with
 *   RuntimeError: Aborted(). Build with -sASSERTIONS for more info.
 * i.e. the dataDir becomes unrecoverable — the exact INC-01 signature.
 *
 * Sequence per iteration
 *   seed   : one clean writer (creates the cluster)
 *   B      : opens NOW, stays idle (its WAL insert position becomes stale)
 *   A      : writes + forces CHECKPOINTs, then exits leaving pg_control -> X
 *   B      : resumes writing; its stream rolls over X's bytes
 *   reopen : must fail  (and keeps failing on a second attempt)
 *
 * Control: identical workloads, but B opens only after A exited (no stale
 * position) -> reopen succeeds.
 *
 * Safety: every database lives under a scratch root containing
 * "inc-01-rootcause"; the real data/pglite is never opened. PGlite is resolved
 * from the repo's pnpm store (it is not a direct dependency of this package).
 *
 * Usage:
 *   node scripts/inc-01-rootcause/repro.mjs run [--iters 3] [--only repro|control]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.cwd())

function resolvePGlite() {
  const pnpmDir = join(REPO, 'node_modules', '.pnpm')
  const cand = readdirSync(pnpmDir).filter((n) => /^@electric-sql\+pglite@/.test(n))
  if (cand.length === 0) throw new Error('could not find @electric-sql/pglite in node_modules/.pnpm')
  cand.sort()
  return `file:///${join(pnpmDir, cand[cand.length - 1], 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js').replace(/\\/g, '/')}`
}
const PGLITE_URL = resolvePGlite()

function guardDir(dir) {
  const norm = String(dir ?? '').replace(/\\/g, '/')
  if (!norm.includes('/inc-01-rootcause/')) {
    console.error(`REFUSED: ${dir} is not under an inc-01-rootcause scratch root`)
    process.exit(9)
  }
}

// ---------------------------------------------------------------- child roles
const role = process.argv[2]
if (role === 'writer' || role === 'ctl') {
  const { PGlite } = await import(PGLITE_URL)
  const isCtl = role === 'ctl'
  const dir = isCtl ? process.argv[3] : process.argv[3]
  const mode = isCtl ? process.argv[6] : process.argv[4]
  const ms = Number(isCtl ? process.argv[5] : process.argv[4]) || 1500
  guardDir(dir)
  const ckptEvery = Number(process.env.CKPT_EVERY ?? '0')
  const idleMs = isCtl ? Number(process.argv[4] ?? '0') : 0
  const writeMs = isCtl ? Number(process.argv[5] ?? '1500') : ms
  setTimeout(() => {
    console.error('WATCHDOG: worker did not settle')
    process.exit(7)
  }, idleMs + writeMs + 30000)

  const db = new PGlite(dir)
  await db.waitReady
  await db.exec(`CREATE TABLE IF NOT EXISTS probe (id serial primary key, note text, at timestamptz default now())`)
  console.log(JSON.stringify({ role, phase: 'opened', pid: process.pid, idleMs, writeMs }))
  if (idleMs > 0) await new Promise((r) => setTimeout(r, idleMs))
  const deadline = Date.now() + writeMs
  let inserts = 0
  let checkpoints = 0
  let firstError = null
  while (Date.now() < deadline) {
    try {
      await db.query(`INSERT INTO probe(note) VALUES ($1)`, [`${role}-${process.pid}-${inserts}-${'x'.repeat(48)}`])
      inserts++
      if (ckptEvery > 0 && inserts % ckptEvery === 0) {
        await db.exec(`CHECKPOINT`)
        checkpoints++
      }
    } catch (e) {
      firstError = String(e?.message ?? e).slice(0, 200)
      break
    }
  }
  if (mode === 'clean') {
    await db.close()
  } else if (mode === 'hold') {
    console.log(JSON.stringify({ role, mode, inserts, checkpoints, firstError, held: true }))
    setInterval(() => {}, 1 << 30)
  }
  console.log(JSON.stringify({ role, mode, inserts, checkpoints, firstError, done: true }))
  process.exit(0)
}

if (role === 'reopen') {
  const { PGlite } = await import(PGLITE_URL)
  const dir = process.argv[3]
  guardDir(dir)
  setTimeout(() => {
    console.error('WATCHDOG: reopen did not settle')
    process.exit(7)
  }, 30000)
  const chain = (e) => {
    const parts = []
    let cur = e
    for (let i = 0; i < 6 && cur; i++) {
      parts.push({ name: cur.name, message: cur.message })
      cur = cur.cause
    }
    return parts
  }
  const verdict = { role: 'reopen', dir, ok: false }
  let db
  try {
    db = new PGlite(dir)
    await db.waitReady
    await db.query(`SELECT 1 AS ok`)
    verdict.ok = true
  } catch (e) {
    verdict.error = chain(e)
    verdict.errorText = String(e?.message ?? e)
  } finally {
    try {
      if (db) await db.close()
    } catch (e) {
      verdict.closeError = String(e?.message ?? e)
    }
  }
  console.log(JSON.stringify(verdict))
  process.exit(verdict.ok ? 0 : 1)
}

// ------------------------------------------------------------------ the driver
if (role !== 'run') {
  console.error('usage: node scripts/inc-01-rootcause/repro.mjs run [--iters N] [--only repro|control]')
  process.exit(2)
}
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? dflt : process.argv[i + 1]
}
const iters = Number(argOf('--iters', '3'))
const only = argOf('--only', 'both')
const scratch = join(REPO, 'data', 'diagnostics', 'inc-01-rootcause', 'repro-scratch', String(Date.now()))
guardDir(scratch)
mkdirSync(scratch, { recursive: true })

const self = process.argv[1]
const spawnSelf = (args, env = {}) =>
  spawn(process.execPath, [self, ...args], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
const collect = (child, timeoutMs = 60000) =>
  new Promise((res) => {
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, timeoutMs)
    child.on('exit', (code, signal) => {
      clearTimeout(t)
      res({ code, signal, out: out.trim(), err: err.trim().slice(-300) })
    })
  })
const lastJson = (r) => {
  const line = r.out.split('\n').filter(Boolean).pop() ?? ''
  try {
    return JSON.parse(line)
  } catch {
    return { parseError: line }
  }
}
const reopen = async (dir) => {
  const v = lastJson(await collect(spawnSelf(['reopen', dir])))
  return { ok: v.ok === true, errorText: v.errorText, error: v.error }
}

const out = { scenario: 'INC-01 minimal reproduction', pglite: PGLITE_URL, scratch, iters, repro: [], control: [] }
const report = (line) => console.log(line)

for (let i = 0; i < iters; i++) {
  if (only !== 'control') {
    const dir = join(scratch, `repro${i}`, 'db')
    mkdirSync(dir, { recursive: true })
    await collect(spawnSelf(['writer', dir, 'clean', '400'])) // seed
    const b = spawnSelf(['ctl', dir, '3000', '4500', 'exit']) // opens early -> stale position
    await new Promise((r) => setTimeout(r, 200))
    const a = spawnSelf(['ctl', dir, '0', '1500', 'exit'], { CKPT_EVERY: '25' }) // writes + checkpoints
    const [aRes, bRes] = await Promise.all([collect(a, 45000), collect(b, 45000)])
    const v1 = await reopen(dir)
    const v2 = await reopen(dir)
    out.repro.push({ iter: i, dir: dir.replace(REPO, '.'), a: lastJson(aRes), b: lastJson(bRes), firstReopen: v1, secondReopen: v2 })
    report(`repro ${i}: first=${v1.ok ? 'OK' : 'FAIL:' + v1.errorText} second=${v2.ok ? 'OK' : 'FAIL'}`)
  }
  if (only !== 'repro') {
    const dir = join(scratch, `control${i}`, 'db')
    mkdirSync(dir, { recursive: true })
    await collect(spawnSelf(['writer', dir, 'clean', '400'])) // seed
    await collect(spawnSelf(['ctl', dir, '0', '1500', 'exit'], { CKPT_EVERY: '25' }))
    await collect(spawnSelf(['ctl', dir, '0', '4500', 'exit']))
    const v1 = await reopen(dir)
    out.control.push({ iter: i, dir: dir.replace(REPO, '.'), reopen: v1 })
    report(`control ${i}: ${v1.ok ? 'OK' : 'FAIL:' + v1.errorText}`)
  }
}

const tally = (rows, key) => rows.reduce((m, r) => ((m[r[key].ok ? 'OK' : 'FAIL'] = (m[r[key].ok ? 'OK' : 'FAIL'] ?? 0) + 1), m), {})
out.summary = { repro: tally(out.repro, 'firstReopen'), control: tally(out.control, 'reopen') }
out.verdict = {
  reproduced: out.repro.length > 0 && out.repro.every((r) => !r.firstReopen.ok && !r.secondReopen.ok),
  controlHolds: out.control.length > 0 && out.control.every((c) => c.reopen.ok),
  errorSignature: out.repro[0]?.firstReopen?.errorText ?? null,
}
writeFileSync(join(scratch, 'summary.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out.summary))
console.log(JSON.stringify(out.verdict))
console.log('scratch:', scratch)
if (!out.verdict.reproduced || !out.verdict.controlHolds) process.exit(1)
