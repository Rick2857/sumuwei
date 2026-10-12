/** One-time archival of the direct human declaration received on 2026-10-02; no automated adjudication. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'

const materialRun = 'm11-m111-review-v3-20261002-1662d629a654-771b'
const publicManifest = `artifacts/m11.1/${materialRun}/manifest.json`
const material = JSON.parse(readFileSync(publicManifest, 'utf8'))
const privateDir = join(process.cwd(), 'artifacts/m11.1/local', materialRun)
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
for (const [kind, file] of Object.entries({ behavior: 'behavior.json', verification: 'verification.json', key: 'sealed-key.json' })) {
  if (digest(join(privateDir, file)) !== material.materialHashes[kind]) throw new Error(`review material changed: ${kind}`)
}
if (digest(join(privateDir, 'Review.md')) !== material.reviewMarkdownSha256 || material.sampledCardCount !== 36) throw new Error('review denominator or Markdown changed')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm111-human-review', headShort: head })
const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
const record = { humanReview: 'PASS', reviewedBy: 'human-user', reviewedAt: '2026-10-02',
  directDeclaration: '已审阅，没有严重争议', materialRun, materialHashes: material.materialHashes,
  reviewMarkdownSha256: material.reviewMarkdownSha256, sampledCardCount: 36, independentSampleCases: 12,
  perCaseRate: 'N/A', countMeaning: 'Material cards covered by the declaration, not individual behavior grades',
  scope: 'The 36 real reply blind cards, both non-goal slots, four review topics. No substitute for semantic thresholds, full behavior gains, goal slot, long mixed trajectory or production first use.' }
writeFileSync(join(dir, 'review-record.json'), JSON.stringify(record, null, 2) + '\n')
writeM11Manifest(dir, { runId, wp: 'M11.1-WP4', head, headShort: head.slice(0, 12),
  branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), date: '2026-10-02', toolVersions: { node: process.version },
  testType: 'direct-human-review-declaration', phases: ['human-declaration'], supersedes: null,
  counts: { total: 36, passed: 36, failed: 0 }, verdict: 'PASS', ...record, started: new Date().toISOString(), ended: new Date().toISOString(),
  cleanClose: true, environment: 'archival-no-database', plannedRequests: 0, actualRequests: 0, capabilityImpact: 'NONE',
  sourceFingerprints: { [publicManifest]: digest(publicManifest), 'scripts/m11.1-human-review-record.ts': digest('scripts/m11.1-human-review-record.ts') } })
console.log(JSON.stringify({ runId, humanReview: 'PASS', sampledCardCount: 36, naturalFirstUse: 'NOT OBSERVED' }))
