import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { SEARCH_HELDOUT, validateHeldout, experimentFingerprint } from '../evals/m9.6/search-heldout.ts'
import { scoreRows } from './m9.6-followup-summary.ts'

validateHeldout()
assert.equal(SEARCH_HELDOUT.val.length, 50)
assert.equal(SEARCH_HELDOUT.test.length, 150)
assert.notEqual(experimentFingerprint(SEARCH_HELDOUT.val), experimentFingerprint(SEARCH_HELDOUT.test))
const reading = (decision: string) => ({ decision, outcome: 'measured', proposalValid: true, latencyMs: 10,
  inputTokens: 1, outputTokens: 1, requestCount: 1, code: null })
const rows = SEARCH_HELDOUT.test.map(x => ({ caseId: x.caseId, family: x.family!, safety: x.safety ?? false,
  stratum: x.stratum, mode: x.mode, expected: x.expected, arms: { A: reading(x.expected.decision), J: reading(x.expected.decision) } }))
const pass = scoreRows(rows)
assert.equal(pass.observedG2, true)
assert.equal(pass.observedG3, true)
assert.equal(pass.familyCount, 30)
const broken = structuredClone(rows)
for (const row of broken) row.arms.J.decision = 'search'
const bad = scoreRows(broken)
assert.equal(bad.observedG2, false)
assert.equal(bad.observedG3, false)
assert.equal(bad.J.unsafeSearchProposals.length, 40)
const unavailable = structuredClone(rows)
for (const row of unavailable) row.arms.J.outcome = 'unavailable'
const empty = scoreRows(unavailable)
assert.equal(empty.J.accuracy.value, 0)
assert.equal(empty.J.completion.value, 0)
assert.equal(empty.J.binaryDiagnostic.value, 0)
assert.equal(empty.observedG2, false)
assert.throws(() => scoreRows([]))
assert.throws(() => scoreRows([...rows, rows[0]]))
assert.throws(() => scoreRows(rows.slice(1)))
assert.deepEqual(scoreRows(rows), pass)
mkdirSync('artifacts/m9.6/search-followup', { recursive: true })
writeFileSync('artifacts/m9.6/search-followup/verification.json', JSON.stringify({ status: 'PASS', checks: 17,
  networkCalls: 0, controls: ['perfect predictions accepted', 'unsafe all-search rejected', 'unavailable not success', 'empty/duplicate/unequal cluster rejected', 'restored predictions identical'],
  valCount: 50, testCount: 150 }, null, 2) + '\n')
console.log('follow-up verification: PASS; 17 assertions; zero network calls')
