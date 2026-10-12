import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scoreBehavior, validateReviewCards, type BehaviorReading, type ReviewCard } from './m11.1-measurement.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'

const started = new Date().toISOString()
const root = 'artifacts/m11.1/local/historical-360-review-20261003'
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const preparation = JSON.parse(readFileSync('artifacts/m11.1/historical-360-review-preparation-20261003.json', 'utf8'))
const observationsBytes = readFileSync(join(root, 'blind-observations.json'))
const observations = JSON.parse(observationsBytes.toString())
const freezePath = join(root, 'blind-observations-freeze.json')
if (!existsSync(freezePath)) writeFileSync(freezePath, JSON.stringify({ sha256: sha(observationsBytes), frozenAt: new Date().toISOString(),
  scored: observations.rows.length, sealedKeyRead: false }) + '\n')
const freeze = JSON.parse(readFileSync(freezePath, 'utf8'))
if (freeze.sha256 !== sha(observationsBytes) || freeze.scored !== 360 || observations.rows.length !== 360 ||
    new Set(observations.rows.map((row: any) => row.cardId)).size !== 360) throw new Error('Complete frozen blind observations required')
for (const name of ['behavior.json', 'verification.json', 'sealed-key.json']) {
  if (sha(readFileSync(join(root, name))) !== preparation.privateMaterialHashes[name]) throw new Error(`Historical material changed: ${name}`)
}
const blind = JSON.parse(readFileSync(join(root, 'behavior.json'), 'utf8'))
if (observations.sourceSha256 !== preparation.privateMaterialHashes['behavior.json']) throw new Error('Observations have another blind source')
const verification = JSON.parse(readFileSync(join(root, 'verification.json'), 'utf8'))
const key = JSON.parse(readFileSync(join(root, 'sealed-key.json'), 'utf8'))
const sourceManifest = JSON.parse(readFileSync(`artifacts/m11.1/${preparation.sourceRun}/manifest.json`, 'utf8'))
const sourceBytes = readFileSync(`artifacts/m11.1/local/${preparation.sourceRun}/cards.json`)
if (sha(sourceBytes) !== sourceManifest.privateCardsSha256 || sha(sourceBytes) !== preparation.sourceCardsSha256) throw new Error('Historical source bytes changed')
const original = JSON.parse(sourceBytes.toString()) as (ReviewCard & { corpusCaseId: string; slot: string; legal: boolean; round: number; completed: boolean; liveReply: boolean; cleanClose: boolean })[]
const integrity = validateReviewCards(original)
if (!integrity.valid || original.length !== 360 || original.some(row => !row.completed || !row.liveReply || !row.cleanClose)) throw new Error('Incomplete historical collection')
const rows: BehaviorReading[] = []
for (const face of blind) {
  const reading = observations.rows.find((row: any) => row.cardId === face.cardId)
  const labels = key.find((row: any) => row.cardId === face.cardId)
  const evidence = verification.find((row: any) => row.cardId === face.cardId)
  const source = original.find(row => row.replySha256 === face.replySha256)
  if (!reading || !labels || !evidence || !source || reading.replySha256 !== face.replySha256 || sha(face.reply) !== face.replySha256 ||
      source.scenario !== face.scenario || source.reply !== face.reply || labels.caseId !== source.caseId ||
      ['corpusCaseId', 'pairId', 'arm', 'round', 'slot', 'legal', 'completed'].some(field => labels[field] !== (source as any)[field]) ||
      ['traceId', 'eventIds', 'packetRefs', 'rootIds', 'conversationIds', 'databaseId', 'baselineFingerprint'].some(field =>
        JSON.stringify(evidence[field]) !== JSON.stringify((source as any)[field])) ||
      ['clarificationAsked', 'currentCorrectionAcknowledged', 'appropriate', 'seriousViolation'].some(field => typeof reading[field] !== 'boolean') ||
      typeof reading.rationale !== 'string' || reading.rationale.length === 0) throw new Error(`Invalid blind/evidence binding: ${face.cardId}`)
  if (!['clarify_when_ambiguous', 'acknowledge_correction_first'].includes(labels.slot)) throw new Error('Historical review has an unexpected slot')
  rows.push({ caseId: labels.corpusCaseId, slot: labels.slot, legal: labels.legal, arm: labels.arm, round: labels.round,
    completed: labels.completed, used: labels.slot === 'clarify_when_ambiguous' ? reading.clarificationAsked : reading.currentCorrectionAcknowledged,
    correct: reading.appropriate, seriousViolation: reading.seriousViolation, scored: true })
}
const expectedIds = [...new Set(rows.map(row => row.caseId))]
const identities = new Set(rows.map(row => `${row.caseId}:${row.round}:${row.arm}`))
if (expectedIds.length !== 60 || rows.length !== 360 || identities.size !== 360 || expectedIds.some(id =>
  [1, 2].some(round => ['A', 'B', 'C'].some(arm => !identities.has(`${id}:${round}:${arm}`))))) throw new Error('Historical 60 x 2 x 3 denominator incomplete')
const metrics = scoreBehavior(rows, expectedIds)
if (metrics.valid || metrics.legality !== 'INVALID') throw new Error('Historical 360 must not be accepted as the formal 540 gate')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm111-historical-behavior-scored', headShort: head })
const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n')
writeFileSync(join(root, 'scored-readings.json'), JSON.stringify(rows, null, 2) + '\n')
const checks = { completeBlindScores: rows.length === 360, originalCardIntegrity: integrity.valid, independentArmTraceDatabaseIds: true,
  packetAndSourceBinding: true, formal540StillInvalid: metrics.valid === false, originalSourceUnchanged: sha(readFileSync(`artifacts/m11.1/local/${preparation.sourceRun}/cards.json`)) === preparation.sourceCardsSha256 }
writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
const paths = ['scripts/m11.1-historical-behavior-score.ts', 'scripts/m11.1-measurement.ts', 'docs/m11.1/M11.1-Acceptance-Contract.md']
writeM11Manifest(dir, { runId, wp: 'M11.1-WP6', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'historical-manual-blind-diagnostic',
  phases: ['blind-scoring', 'evidence-verification', 'unseal'], supersedes: null, started, ended: new Date().toISOString(),
  counts: { total: 6, passed: 6, failed: 0 }, plannedRequests: 0, actualRequests: 0, cleanClose: true, environment: 'offline-private-materials', capabilityImpact: 'NONE',
  verdict: 'HISTORICAL DIAGNOSTIC ONLY', historicalSourceRun: preparation.sourceRun, sourcePromptVersion: 'reflection-prompt@2',
  reviewer: observations.reviewer, methodVersion: observations.methodVersion, humanReview: false, scoredReplies: rows.length,
  observationSha256: sha(observationsBytes), observationFrozenAt: freeze.frozenAt, sourceCardsSha256: preparation.sourceCardsSha256,
  limitation: 'Codex manual blind scoring of the old two-slot candidate; no independent human adjudication. Full 360 coverage does not replace the current three-slot 540 gate; the native scorer remains INVALID.',
  sourceFingerprints: Object.fromEntries(paths.map(path => [path, sha(readFileSync(path))])) })
console.log(JSON.stringify({ runId, scored: rows.length, modelRequests: 0, formal540Status: metrics.legality, arms: metrics.arms, gains: metrics.gains }, null, 2))
