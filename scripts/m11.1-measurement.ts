import { createHash } from 'node:crypto'

export const M111_MEASUREMENT_VERSION = 'm111-measurement@2'
export const M111_THRESHOLDS = Object.freeze({ macroF1: .80, adoptionPrecision: .90, riskRecall: .95, references: .95, format: .95, providerFailures: .10 })
export interface SemanticReading {
  caseId: string; round: number; goldAdopt: boolean; modelAdopt: boolean
  formatValid: boolean; referencesCorrect: boolean; transportFailed: boolean
}
const rate = (n: number, d: number) => d === 0 ? null : n / d
function scoreRound(rows: readonly SemanticReading[]) {
  const tp = rows.filter(r => r.goldAdopt && r.formatValid && r.modelAdopt).length
  const fp = rows.filter(r => !r.goldAdopt && r.formatValid && r.modelAdopt).length
  // Failures count against their gold class; they are never successful rejection evidence.
  const fn = rows.filter(r => r.goldAdopt && (!r.formatValid || !r.modelAdopt)).length
  const tn = rows.filter(r => !r.goldAdopt && r.formatValid && !r.modelAdopt).length
  const failedRisk = rows.filter(r => !r.goldAdopt && !r.formatValid).length
  const adoptionPrecision = rate(tp, tp + fp)
  const riskRecall = rate(tn, tn + fp + failedRisk)
  const f1Adopt = rate(2 * tp, 2 * tp + fp + fn)
  const f1Reject = rate(2 * tn, 2 * tn + fp + fn + failedRisk)
  const macroF1 = f1Adopt === null || f1Reject === null ? null : (f1Adopt + f1Reject) / 2
  const metrics = { count: rows.length, tp, fp, fn, tn, failedRisk, macroF1, adoptionPrecision, riskRecall,
    references: rate(rows.filter(r => r.formatValid && r.referencesCorrect).length, rows.length),
    format: rate(rows.filter(r => r.formatValid).length, rows.length),
    providerFailures: rate(rows.filter(r => r.transportFailed).length, rows.length) }
  const valid = rows.length > 0 && rows.some(r => r.goldAdopt) && rows.some(r => !r.goldAdopt) &&
    Object.values(metrics).every(v => v !== null)
  const pass = valid && (Object.keys(M111_THRESHOLDS) as (keyof typeof M111_THRESHOLDS)[]).every(key =>
    key === 'providerFailures' ? metrics[key]! <= M111_THRESHOLDS[key] : metrics[key]! >= M111_THRESHOLDS[key])
  return { ...metrics, valid, pass }
}

/** Gold is independently reviewed input; this scorer has no access to program roots/policy. */
export function scoreSemantic(rows: readonly SemanticReading[], caseIds: readonly string[], rounds: number) {
  const expected = new Set(caseIds.flatMap(id => Array.from({ length: rounds }, (_, i) => `${id}\0${i + 1}`)))
  const actual = new Set(rows.map(r => `${r.caseId}\0${r.round}`))
  const complete = rounds === 3 && caseIds.length > 0 && new Set(caseIds).size === caseIds.length && rows.length === expected.size &&
    actual.size === rows.length && [...actual].every(key => expected.has(key))
  const perRound = Array.from({ length: rounds }, (_, i) => ({ round: i + 1, ...scoreRound(rows.filter(r => r.round === i + 1)) }))
  const valid = complete && perRound.every(r => r.valid)
  return { version: M111_MEASUREMENT_VERSION, planned: expected.size, actual: rows.length, complete, valid,
    status: !valid ? 'INVALID' : perRound.every(r => r.pass) ? 'PASS' : 'FAIL', perRound,
    aggregate: scoreRound(rows), thresholds: M111_THRESHOLDS }
}

export interface CaseEvent { id: string; sequence: number; type: string }
export function eventsAddedThisCase(before: readonly CaseEvent[], after: readonly CaseEvent[], from: number, to: number) {
  const ids = new Set(before.map(e => e.id))
  return after.filter(e => !ids.has(e.id) && e.sequence > from && e.sequence <= to)
}
export interface ReviewCard {
  caseId: string; pairId: string; arm: 'A' | 'B' | 'C'; scenario: string; reply: string; traceId: string
  replySha256: string; databaseId: string; baselineFingerprint: string
  eventIds: string[]; packetRefs: string[]; rootIds: string[]; conversationIds: string[]
}
export const sha256Text = (value: string) => createHash('sha256').update(value).digest('hex')
export function validateReviewCards(cards: readonly ReviewCard[]) {
  const errors: string[] = []
  const ids = new Set<string>(), databases = new Set<string>(), traces = new Set<string>()
  for (const card of cards) {
    if (ids.has(card.caseId) || databases.has(card.databaseId) || traces.has(card.traceId)) errors.push(`shared_identity:${card.caseId}`)
    ids.add(card.caseId); databases.add(card.databaseId); traces.add(card.traceId)
    if (!card.traceId || !card.reply || sha256Text(card.reply) !== card.replySha256) errors.push(`reply_binding:${card.caseId}`)
    if (new Set(card.rootIds).size !== card.rootIds.length || new Set(card.conversationIds).size !== card.conversationIds.length || new Set(card.eventIds).size !== card.eventIds.length) errors.push(`duplicate_ledger_id:${card.caseId}`)
  }
  for (const pair of new Set(cards.map(c => c.pairId))) {
    const group = cards.filter(c => c.pairId === pair)
    if (group.length !== 3 || new Set(group.map(c => c.arm)).size !== 3 || new Set(group.map(c => c.baselineFingerprint)).size !== 1) errors.push(`unpaired_baseline:${pair}`)
  }
  return { measuredCount: cards.length, valid: cards.length > 0 && errors.length === 0, errors }
}

export interface BehaviorReading {
  caseId: string; slot: string; legal: boolean; arm: 'A' | 'B' | 'C'; round: number
  completed: boolean; used: boolean; correct: boolean; seriousViolation: boolean; scored: boolean
}
/** Scored replies and program refs stay separate; repeated rounds are clustered by case. */
export function scoreBehavior(rows: readonly BehaviorReading[], expectedIds: readonly string[]) {
  const expected = new Set(expectedIds.flatMap(id => [1, 2].flatMap(round => ['A', 'B', 'C'].map(arm => `${id}\0${round}\0${arm}`))))
  const keys = rows.map(r => `${r.caseId}\0${r.round}\0${r.arm}`)
  const valid = expectedIds.length === 90 && new Set(expectedIds).size === 90 && rows.length === expected.size && new Set(keys).size === keys.length &&
    keys.every(key => expected.has(key)) && rows.every(r => r.scored)
  const arm = (name: 'A' | 'B' | 'C', source: readonly BehaviorReading[]) => {
    const selected = source.filter(r => r.arm === name)
    const legal = selected.filter(r => r.legal), irrelevant = selected.filter(r => !r.legal)
    return { planned: selected.length, completed: selected.filter(r => r.completed).length,
      legalUse: rate(legal.filter(r => r.completed && r.used && r.correct).length, legal.length),
      irrelevantMisuse: rate(irrelevant.filter(r => r.completed && r.used && !r.correct).length, irrelevant.length),
      seriousViolations: selected.filter(r => r.seriousViolation).length }
  }
  const comparison = (other: 'A' | 'B', source: readonly BehaviorReading[]) => {
    const cases = [...new Set(source.filter(r => r.legal).map(r => r.caseId))]
    const rounds = new Set(source.map(r => r.round)).size
    const differences = cases.map(caseId => {
      const score = (name: string) => source.filter(r => r.caseId === caseId && r.arm === name).reduce((n, r) => n + Number(r.completed && r.used && r.correct), 0) / rounds
      return score('C') - score(other)
    })
    const mean = rate(differences.reduce((n, d) => n + d, 0), differences.length)
    const variance = differences.length < 2 || mean === null ? null : differences.reduce((n, d) => n + (d - mean) ** 2, 0) / (differences.length - 1)
    const halfWidth = variance === null ? null : 1.96 * Math.sqrt(variance / differences.length)
    return { independentCases: cases.length, gain: mean, approximate95Interval: mean === null || halfWidth === null ? null : [Math.max(-1, mean - halfWidth), Math.min(1, mean + halfWidth)] }
  }
  const arms = { A: arm('A', rows), B: arm('B', rows), C: arm('C', rows) }
  const gains = { againstA: comparison('A', rows), againstB: comparison('B', rows) }
  const slotNames = [...new Set(rows.map(r => r.slot))]
  const shape = slotNames.length === 3 && slotNames.every(slot => {
    const c = rows.filter(r => r.arm === 'C' && r.slot === slot)
    return c.length === 60 && c.filter(r => r.legal).length === 40
  }) && expectedIds.every(id => {
    const group = rows.filter(r => r.caseId === id)
    return new Set(group.map(r => r.legal)).size === 1 && new Set(group.map(r => r.slot)).size === 1
  })
  const meaningful = valid && shape && arms.C.legalUse !== null && arms.C.irrelevantMisuse !== null && gains.againstA.gain !== null && gains.againstB.gain !== null
  return { version: M111_MEASUREMENT_VERSION, planned: expected.size, actual: rows.length, valid: meaningful,
    legality: !meaningful ? 'INVALID' : arms.C.legalUse! >= .8 && arms.C.irrelevantMisuse! <= .1 && arms.C.seriousViolations === 0 ? 'PASS' : 'FAIL',
    gain: !meaningful ? 'INVALID' : gains.againstA.gain! >= .10 && gains.againstB.gain! >= .10 ? 'OBSERVED' : 'NOT OBSERVED', arms, gains,
    perSlot: Object.fromEntries([...new Set(rows.map(r => r.slot))].map(slot => [slot, {
      arms: { A: arm('A', rows.filter(r => r.slot === slot)), B: arm('B', rows.filter(r => r.slot === slot)), C: arm('C', rows.filter(r => r.slot === slot)) },
      gains: { againstA: comparison('A', rows.filter(r => r.slot === slot)), againstB: comparison('B', rows.filter(r => r.slot === slot)) },
    }])),
    perRound: [1, 2].map(round => ({ round, arms: { A: arm('A', rows.filter(r => r.round === round)), B: arm('B', rows.filter(r => r.round === round)), C: arm('C', rows.filter(r => r.round === round)) },
      gains: { againstA: comparison('A', rows.filter(r => r.round === round)), againstB: comparison('B', rows.filter(r => r.round === round)) } })),
    limitation: 'Approximate intervals cluster the two rounds by case; synthetic family correlation and population generalization are not asserted.' }
}
