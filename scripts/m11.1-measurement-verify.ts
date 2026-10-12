import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scoreSemantic, scoreBehavior, eventsAddedThisCase, validateReviewCards, sha256Text, type SemanticReading, type ReviewCard, type BehaviorReading } from './m11.1-measurement.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'

const started = new Date().toISOString()
const checks: { id: string; pass: boolean; observed: unknown }[] = []
const check = (id: string, pass: boolean, observed: unknown) => checks.push({ id, pass, observed })
const ids = Array.from({ length: 100 }, (_, i) => `oracle-control-${i}`)
const readings: SemanticReading[] = ids.flatMap((caseId, i) => [1, 2, 3].map(round => ({ caseId, round,
  goldAdopt: i < 50, modelAdopt: i < 50, formatValid: true, referencesCorrect: true, transportFailed: false })))
const good = scoreSemantic(readings, ids, 3)
check('nonzero-all-rounds-positive', good.status === 'PASS' && good.actual === 300, good)
const corrupt = (map: (r: SemanticReading, i: number) => SemanticReading) => scoreSemantic(readings.map(map), ids, 3)
const badFormat = corrupt(r => r.round === 3 && Number(r.caseId.split('-').at(-1)) < 10 ? { ...r, formatValid: false } : r)
check('mean-cannot-hide-worst-format', badFormat.status === 'FAIL' && badFormat.aggregate.format! > .95, badFormat)
const badReferences = corrupt(r => r.round === 3 && Number(r.caseId.split('-').at(-1)) < 10 ? { ...r, referencesCorrect: false } : r)
check('worst-reference-threshold', badReferences.status === 'FAIL' && badReferences.aggregate.references! > .95, badReferences)
const badRisk = corrupt(r => r.round === 3 && !r.goldAdopt && Number(r.caseId.split('-').at(-1)) < 54 ? { ...r, modelAdopt: true } : r)
check('risk-recall-95-not-90', badRisk.status === 'FAIL' && badRisk.perRound[2]!.riskRecall === .92, badRisk)
const badMacro = corrupt(r => r.round === 3 && r.goldAdopt && Number(r.caseId.split('-').at(-1)) < 40 ? { ...r, modelAdopt: false } : r)
check('macro-f1-is-enforced', badMacro.status === 'FAIL' && badMacro.perRound[2]!.macroF1! < .8 && badMacro.perRound[2]!.adoptionPrecision === 1 && badMacro.perRound[2]!.riskRecall === 1, badMacro)
const riskTimeouts = corrupt(r => r.round === 3 && !r.goldAdopt ? { ...r, formatValid: false, transportFailed: true } : r)
check('transport-is-not-successful-rejection', riskTimeouts.perRound[2]!.riskRecall === 0 && riskTimeouts.status === 'FAIL', riskTimeouts)
check('missing-request-invalid', scoreSemantic(readings.slice(1), ids, 3).status === 'INVALID', { omitted: 1 })
check('duplicate-request-invalid', scoreSemantic([...readings.slice(1), readings[1]!], ids, 3).status === 'INVALID', { duplicated: 1 })
check('empty-denominator-invalid', scoreSemantic([], [], 3).status === 'INVALID', { planned: 0 })
check('recovery-same-frozen-oracle', scoreSemantic(readings, ids, 3).status === 'PASS', { changedOracle: false })

const before = [{ id: 'refl:9', sequence: 9, type: 'ADAPTIVE_SELF_REVISED' }]
const after = [{ id: 'refl:10', sequence: 10, type: 'REFLECTION_REVIEWED' }, ...before]
const delta = eventsAddedThisCase(before, after, 9, 10)
check('lexical-order-does-not-select-old-case', delta.length === 1 && delta[0]!.id === 'refl:10', delta)
check('old-enhancement-not-counted-as-new-adjustment', delta.filter(e => e.type === 'ADAPTIVE_SELF_REVISED').length === 0, delta)
check('sequence-boundary-excludes-neighbour', eventsAddedThisCase(before, [...after, { id: 'next', sequence: 11, type: 'ADAPTIVE_SELF_REVISED' }], 9, 10).length === 1, { to: 10 })
const cards: ReviewCard[] = (['A', 'B', 'C'] as const).map(arm => ({ caseId: `control-${arm}`, pairId: 'control', arm,
  scenario: '只用于量具控制，不是真实评审回复。', reply: '离线量具占位回复。', traceId: `trace-${arm}`, replySha256: sha256Text('离线量具占位回复。'),
  databaseId: `independent-${arm}`, baselineFingerprint: 'same-baseline', eventIds: [], packetRefs: [], rootIds: [], conversationIds: [] }))
check('identity-positive-nonzero', validateReviewCards(cards).valid, validateReviewCards(cards))
const shared = cards.map(c => ({ ...c, databaseId: 'shared' }))
check('shared-arm-database-invalid', !validateReviewCards(shared).valid, validateReviewCards(shared))
const wrongHash = cards.map(c => ({ ...c, replySha256: 'wrong' }))
check('reply-trace-binding-negative', !validateReviewCards(wrongHash).valid, validateReviewCards(wrongHash))
check('identity-recovery', validateReviewCards(cards).valid, validateReviewCards(cards))
check('blank-material-invalid', !validateReviewCards([]).valid, validateReviewCards([]))

const behaviorIds = Array.from({ length: 90 }, (_, i) => `behavior-control-${i}`)
const behavior: BehaviorReading[] = behaviorIds.flatMap((caseId, i) => [1, 2].flatMap(round => (['A', 'B', 'C'] as const).map(arm => ({
  caseId, slot: `slot-${Math.floor(i / 30)}`, legal: i % 30 < 20, arm, round, completed: true,
  used: i % 30 < 20 && (arm === 'C' || i % 2 === 0), correct: true, seriousViolation: false, scored: true,
}))))
const benefit = scoreBehavior(behavior, behaviorIds)
check('paired-nonzero-legality-and-gain', benefit.legality === 'PASS' && benefit.gain === 'OBSERVED' && benefit.planned === 540, benefit)
check('per-round-gain-has-single-round-denominator', benefit.perRound.every(row => row.gains.againstA.gain === .5 && row.gains.againstB.gain === .5), benefit.perRound)
const ceiling = scoreBehavior(behavior.map(r => ({ ...r, used: r.legal })), behaviorIds)
check('baseline-ceiling-not-called-gain', ceiling.legality === 'PASS' && ceiling.gain === 'NOT OBSERVED', ceiling)
const missingScores = scoreBehavior(behavior.map(r => ({ ...r, scored: false })), behaviorIds)
check('unscored-replies-invalid', missingScores.legality === 'INVALID', { valid: missingScores.valid })
const serious = scoreBehavior(behavior.map((r, i) => i === 2 ? { ...r, seriousViolation: true } : r), behaviorIds)
check('one-serious-violation-fails', serious.legality === 'FAIL', serious.arms)
const transport = scoreBehavior(behavior.map(r => r.arm === 'C' ? { ...r, completed: false } : r), behaviorIds)
check('failed-dialogues-remain-in-behavior-denominator', transport.legality === 'FAIL' && transport.arms.C.planned === 180 && transport.arms.C.legalUse === 0, transport.arms)
check('missing-pair-invalid', scoreBehavior(behavior.slice(1), behaviorIds).legality === 'INVALID', { omitted: 1 })
check('behavior-recovery', scoreBehavior(behavior, behaviorIds).gain === 'OBSERVED', { changedGold: false })

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm111-measurement', headShort: head })
const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
const paths = ['scripts/m11.1-measurement.ts', 'scripts/m11.1-measurement-verify.ts', 'docs/m11.1/M11.1-Acceptance-Contract.md']
writeM11Manifest(dir, { runId, wp: 'M11.1-WP4', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version }, testType: 'independent-oracle-consumer-controls', phases: ['positive', 'negative', 'recovery'], supersedes: null,
  started, ended: new Date().toISOString(), counts: { total: checks.length, passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length },
  plannedRequests: 0, actualRequests: 0, cleanClose: true, environment: 'pure-offline', capabilityImpact: 'NONE',
  sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) })
console.log(JSON.stringify({ runId, checks: checks.map(({ id, pass }) => ({ id, pass })) }, null, 2))
process.exit(checks.every(c => c.pass) ? 0 : 1)
