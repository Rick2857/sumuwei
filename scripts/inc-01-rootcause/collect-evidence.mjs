#!/usr/bin/env node
/*
 * INC-01: consolidate the root-cause lab evidence into one committed artifact.
 *
 * Reads the (gitignored) lab run summaries under
 *   data/diagnostics/inc-01-rootcause/
 * and writes
 *   artifacts/incidents/inc-01/rootcause/evidence.json
 * so the finding is reviewable without the scratch trees.
 *
 * Usage: node scripts/inc-01-rootcause/collect-evidence.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.cwd())
const LAB = join(REPO, 'data', 'diagnostics', 'inc-01-rootcause', 'lab')
const OUT_DIR = join(REPO, 'artifacts', 'incidents', 'inc-01', 'rootcause')
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function pgliteVersion() {
  const pnpmDir = join(REPO, 'node_modules', '.pnpm')
  const cand = readdirSync(pnpmDir).filter((n) => /^@electric-sql\+pglite@/.test(n)).sort()
  const last = cand[cand.length - 1] ?? ''
  return last.replace('@electric-sql+pglite@', '').replace(/_.*$/, '')
}

const SCENARIO_LABELS = {
  mkdb: 'control: one clean writer then reopen',
  kill: 'single process SIGKILL mid-write, then reopen',
  'kill-ckpt': 'single process SIGKILL during forced checkpoints, then reopen',
  concurrent: 'two live writers on one dataDir (no checkpoints)',
  'concurrent-ckpt': 'two live writers on one dataDir with forced checkpoints',
  readonly2: 'two concurrent read-only openers',
  hotcopy: 'cpSync of a live dataDir while writing, open the copy',
  sequential2: 'same workloads, writers strictly sequential (no stale position)',
  'stale-writer': 'stale-position race (uncontrolled variant)',
  'stale-writer2': 'REPRODUCTION: stale WAL insert position of a second live instance',
}

const scenarios = []
if (existsSync(LAB)) {
  for (const dir of readdirSync(LAB).sort()) {
    const m = /^exp-(.+)-(\d+)$/.exec(dir)
    if (!m) continue
    const summary = readJson(join(LAB, dir, 'summary.json'))
    if (!summary) continue
    const key = summary.scenario ?? m[1]
    scenarios.push({
      scenario: key,
      label: SCENARIO_LABELS[key] ?? key,
      runDir: dir,
      iters: summary.iters,
      tally: summary.tally,
      root: String(summary.root ?? '').replace(REPO, '.'),
      reproShaped: key === 'stale-writer2',
    })
  }
}

const byScenario = {}
for (const s of scenarios) {
  const entry = (byScenario[s.scenario] ??= { label: s.label, runs: 0, iterations: 0, tally: {}, reproShaped: s.reproShaped })
  entry.runs++
  entry.iterations += s.iters ?? 0
  for (const [k, v] of Object.entries(s.tally ?? {})) entry.tally[k] = (entry.tally[k] ?? 0) + v
}

const lease = readJson(join(LAB, 'lease-test', 'lease-test-summary.json'))
const leaseSteps = (lease?.steps ?? []).map((s) => {
  let out = null
  try {
    out = JSON.parse(s.out.split('\n').filter(Boolean).pop() ?? 'null')
  } catch {}
  return { step: s.step, exitCode: s.exitCode ?? null, acquired: out?.acquired ?? null, isLeaseHeld: out?.isLeaseHeld ?? null, error: out?.error ?? null, held: out?.held ?? null, released: out?.released ?? null }
})

const pgControl = (dir) => {
  const p = join(REPO, dir, 'global', 'pg_control')
  if (!existsSync(p)) return null
  const buf = readFileSync(p)
  const T = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1
    T[i] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < 288; i++) crc = T[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return {
    path: dir,
    pg_control_version: buf.readUInt32LE(8),
    catalog_version_no: buf.readUInt32LE(12),
    state: buf.readUInt32LE(16),
    time: new Date(Number(buf.readBigInt64LE(24)) * 1000).toISOString(),
    checkPoint: '0x' + buf.readBigUInt64LE(32).toString(16),
    prevCheckPoint: '0x' + buf.readBigUInt64LE(40).toString(16),
    crc32cValid: ((crc ^ 0xffffffff) >>> 0) === buf.readUInt32LE(288),
  }
}

const oracleBroken = readJson(join(OUT_DIR, 'wal-oracle-broken-vs-golden.json'))

const evidence = {
  incident: 'INC-01',
  task: 'TD-18 root-cause investigation',
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    pglite: pgliteVersion(),
    walPageMagic: '0xD116 (PG17)',
    pgControlLayout:
      'system_identifier@0 u64, pg_control_version@8 u32, catalog_version_no@12 u32, state@16 u32, time@24 i64, checkPoint@32 u64, prevCheckPoint@40 u64, checkPointCopy@48, pg_crc32c@288 (CRC32C over the first 288 bytes)',
  },
  preservedTrees: {
    broken: pgControl('data/pglite.broken-20260920-214044'),
    golden: pgControl('data/pglite.snapshot-20260919-2329'),
    realAfterRestore: pgControl('data/pglite'),
  },
  // Deterministic postgres-side answers on the preserved WAL (see wal-oracle-*.json)
  walOracle: oracleBroken
    ? {
        readerLsn: oracleBroken.readerLsn,
        interpretation: oracleBroken.interpretation,
        answers: oracleBroken.questions.map((q) =>
          q.kind === 'record'
            ? { kind: 'record', lsn: q.lsn, error: q.error ?? null, start: q.rows?.[0]?.start_lsn ?? null, type: q.rows?.[0]?.record_type ?? null, rm: q.rows?.[0]?.resource_manager ?? null }
            : { kind: 'checkpoints', range: q.range, error: q.error ?? null, found: q.rows?.length ?? null },
        ),
      }
    : null,
  reproduction: {
    script: 'scripts/inc-01-rootcause/repro.mjs',
    scenario: 'two live instances on one dataDir; the second holds a stale WAL insert position and later overwrites the first checkpoint record',
    scenarioTallies: byScenario['stale-writer2'] ?? null,
    control: byScenario['sequential2'] ?? null,
    lastCommittedRun: readJson(join(OUT_DIR, 'repro-committed-summary.json')),
    signature: 'RuntimeError: Aborted(). Build with -sASSERTIONS for more info.',
  },
  excluded: Object.fromEntries(
    Object.entries(byScenario).filter(([k]) => k !== 'stale-writer2' && k !== 'stale-writer'),
  ),
  preventionControl: { method: 'src/infrastructure/persistence/production-db-safety.ts acquireProductionLease on a disposable dataDir', steps: leaseSteps },
  runs: scenarios,
  instrumentCorrections: [
    'First tree-diff implementation computed relative paths against the recursion root, collapsing 1206 files to 604 basenames; fixed and now aborts with MEASUREMENT INVALID on duplicate keys.',
    "First WAL page-magic constant used PG16's 0xD113, so every page looked invalid; corrected to PG17's 0xD116 after printing the raw value.",
    'Hand-rolled XLogRecord CRC validation never matched, so it was abandoned in favour of pg_walinspect (Postgres own reader) rather than reporting unvalidated parses.',
  ],
}

writeFileSync(join(OUT_DIR, 'evidence.json'), JSON.stringify(evidence, null, 2))
console.log(
  JSON.stringify(
    {
      wrote: 'artifacts/incidents/inc-01/rootcause/evidence.json',
      scenarios: Object.fromEntries(Object.entries(byScenario).map(([k, v]) => [k, v.tally])),
      leaseOk: leaseSteps.length > 0,
      oracleInterpretation: evidence.walOracle?.interpretation ?? null,
    },
    null,
  ),
)
