import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { inspectM111Run, summarizeM111Evidence } from './m11.1-gates.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'
import { sealManifest } from './m6.1-evidence.ts'

const started = new Date().toISOString()
const root = mkdtempSync(join(tmpdir(), 'm111-gates-controls-'))
const checks: { caseId: string; pass: boolean }[] = []
const check = (caseId: string, pass: boolean) => checks.push({ caseId, pass })
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const run = (suffix: string, ended: string, failed = 0) => sealManifest({
  schemaVersion: 'm11-manifest@1', runId: `m11-m111-wiring-20261002-000000000000-${suffix}`,
  wp: 'M11.1-WP2', head: '0'.repeat(40), headShort: '0'.repeat(12), branch: 'offline-controls', date: '2026-10-02',
  toolVersions: { node: process.version }, testType: 'wiring', counts: { total: 1, passed: 1 - failed, failed },
  phases: ['positive', 'negative', 'recovery'], supersedes: null, ended, cleanClose: true,
  plannedRequests: 0, actualRequests: 0, sourceFingerprints: { 'fixture.ts': sha('fixture') },
})
const store = (manifest: Record<string, unknown>) => {
  const dir = join(root, 'artifacts/m11.1', String(manifest.runId))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
}
try {
  writeFileSync(join(root, 'fixture.ts'), 'fixture')
  const first = run('0001', '2026-10-02T00:00:00Z')
  store(first)
  check('nonzero-positive-accepted', summarizeM111Evidence(root).readings.wiring.status === 'PASS')
  const confirmation = sealManifest({ ...first, testType: 'formal-known-corpus-semantic', counts: { total: 480, passed: 480, failed: 0 },
    semanticCaseCount: 160, rounds: 3, plannedRequests: 480, actualRequests: 480 })
  check('complete-known-corpus-confirmation-is-accepted', inspectM111Run(root, String(first.runId), confirmation).status === 'PASS')
  check('known-corpus-probe-does-not-replace-full-confirmation', inspectM111Run(root, String(first.runId), sealManifest({ ...confirmation,
    counts: { total: 16, passed: 16, failed: 0 }, semanticCaseCount: 16, rounds: 1, plannedRequests: 16, actualRequests: 16 })).status === 'INVALID')
  const later = run('0002', '2026-10-02T00:01:00Z', 1)
  store(later)
  const failure = summarizeM111Evidence(root)
  check('latest-fail-not-replaced-by-older-pass', failure.readings.wiring.status === 'FAIL' && failure.readings.wiring.runId === later.runId)
  check('missing-long-and-joint-never-pass', failure.gates.G8 === 'NOT RUN' && failure.gates.G11 === 'NOT RUN' && failure.overall === 'NOT PASS')
  store(sealManifest({ ...first, runId: 'm11-m111-human-review-20261002-000000000000-0003',
    testType: 'direct-human-review-declaration', verdict: 'PASS', humanReview: 'PASS', counts: { total: 36, passed: 36, failed: 0 } }))
  const reviewed = summarizeM111Evidence(root)
  check('human-review-does-not-claim-production-first-use', reviewed.humanReview === 'PASS' && reviewed.gates.G10 === 'PARTIAL' && reviewed.naturalFirstUse === 'NOT OBSERVED')
  const invalid = { ...later, cleanClose: false }
  check('unsealed-change-is-invalid', inspectM111Run(root, String(later.runId), invalid).status === 'INVALID')
  check('zero-denominator-is-invalid', inspectM111Run(root, String(first.runId), sealManifest({ ...first, counts: { total: 0, passed: 0, failed: 0 } })).status === 'INVALID')
  check('inconsistent-denominator-is-invalid', inspectM111Run(root, String(first.runId), sealManifest({ ...first, counts: { total: 1, passed: 2, failed: 0 } })).status === 'INVALID')
  check('missing-fingerprints-is-invalid', inspectM111Run(root, String(first.runId), sealManifest({ ...first, sourceFingerprints: {} })).status === 'INVALID')
  check('outside-source-is-invalid', inspectM111Run(root, String(first.runId), sealManifest({ ...first, sourceFingerprints: { '../outside.ts': sha('fixture') } })).status === 'INVALID')
  writeFileSync(join(root, 'fixture.ts'), 'changed')
  const drift = summarizeM111Evidence(root).readings.wiring
  check('source-drift-refuses-but-keeps-recorded-fail', drift.status === 'INVALID' && drift.recordedVerdict === 'FAIL')
  writeFileSync(join(root, 'fixture.ts'), 'fixture')
  check('recovery-retains-latest-failure', summarizeM111Evidence(root).readings.wiring.status === 'FAIL')
} finally {
  if (!relative(resolve(tmpdir()), resolve(root)).startsWith('m111-gates-controls-')) throw new Error('Cleanup outside owned test directory')
  rmSync(root, { recursive: true, force: true })
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm111-gates-controls', headShort: head })
const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
writeM11Manifest(dir, { runId, wp: 'M11.1-WP7', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'readonly-gates-controls', phases: ['positive', 'negative', 'recovery'], supersedes: null,
  started, ended: new Date().toISOString(), counts: { total: checks.length, passed: checks.filter(row => row.pass).length, failed: checks.filter(row => !row.pass).length },
  cleanClose: true, plannedRequests: 0, actualRequests: 0, environment: 'filesystem-offline-no-database', capabilityImpact: 'NONE',
  sourceFingerprints: Object.fromEntries(['scripts/m11.1-gates.ts', 'scripts/m11.1-gates-verify.ts'].map(path => [path, sha(readFileSync(path))])) })
console.log(JSON.stringify({ runId, checks }, null, 2))
process.exit(checks.every(row => row.pass) ? 0 : 1)
