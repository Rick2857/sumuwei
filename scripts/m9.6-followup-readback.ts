/** Append-only interpretation of frozen evidence; never modifies model outputs or gold. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const base = 'artifacts/m9.6'
const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const freeze = load(`${base}/search-followup/freeze.json`)
for (const [path, hash] of Object.entries(freeze.files)) {
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash, `frozen source drift: ${path}`)
}
const names = ['followup-val-r1', 'followup-test-r1', 'followup-test-r2', 'followup-test-r3']
const runs = names.map(name => {
  const dir = `${base}/compare/${name}`
  const manifest = load(`${dir}/manifest.json`)
  assert.deepEqual(manifest.freeze, freeze)
  const rows = readFileSync(`${dir}/predictions.jsonl`, 'utf8').trim().split(/\r?\n/).map(x => JSON.parse(x))
  assert.equal(rows.length, name.includes('val') ? 50 : 150)
  assert.equal(new Set(rows.map(x => x.caseId)).size, rows.length)
  const summary = load(`${dir}/followup-summary.json`)
  const original = load(`${dir}/metrics.json`)
  const arms = Object.fromEntries(['A', 'J'].map(arm => {
    const validSearch = (x: typeof rows[number]) => x.arms[arm].outcome === 'measured' && x.arms[arm].proposalValid && x.arms[arm].decision === 'search'
    return [arm, {
      correct: summary[arm].accuracy.numerator,
      accuracy: summary[arm].accuracy.value,
      fullValid: rows.filter(x => x.arms[arm].outcome === 'measured' && x.arms[arm].proposalValid).length,
      invalidProposalIds: rows.filter(x => x.arms[arm].outcome === 'measured' && !x.arms[arm].proposalValid).map(x => x.caseId),
      safetyRawSearchIds: rows.filter(x => x.safety && x.arms[arm].decision === 'search').map(x => x.caseId),
      safetyValidSearchIds: rows.filter(x => x.safety && validSearch(x)).map(x => x.caseId),
      wrongValidSearchIds: rows.filter(x => x.expected.decision !== 'search' && validSearch(x)).map(x => x.caseId),
      actualSearchExecutions: null, // This experiment calls judges only, not the search gateway.
      errors: rows.filter(x => x.arms[arm].outcome !== 'measured' || x.arms[arm].decision !== x.expected.decision).map(x => ({
        caseId: x.caseId, gold: x.expected.decision, decision: x.arms[arm].decision, reason: x.arms[arm].reason,
        proposalValid: x.arms[arm].proposalValid, code: x.arms[arm].code,
      })),
      ordinaryOverSearch: summary[arm].ordinaryOverSearch,
      explicitRecall: summary[arm].explicitRecall, autoRecall: summary[arm].autoRecall,
      medianMs: summary[arm].medianMs, p95Ms: summary[arm].p95Ms,
      maxMs: Math.max(...rows.map(x => x.arms[arm].latencyMs)),
      over20Seconds: rows.filter(x => x.arms[arm].latencyMs > 20000).map(x => x.caseId),
      requestCount: rows.reduce((n,x) => n+x.arms[arm].requestCount,0),
      spanExact: original.metrics[arm].contract.spanExactMatch,
      goldSpanCoverage: original.metrics[arm].contract.goldCoverageRate,
      failures: summary[arm].failures, usage: summary[arm].usage,
    }]
  }))
  return { name, rows, summary, result: { name, n: rows.length, arms,
    casePaired: summary.casePaired, familyPaired: summary.familyPaired,
    familyF1: { A: summary.A.familyMacroF1, J: summary.J.familyMacroF1 },
    classificationG3: summary.observedG3,
    jevEstimatedCostUsd: original.jevUsage.estimatedCostUsd,
  } }
})
const tests = runs.slice(1)
for (const run of tests) assert.deepEqual(run.rows.map(x => x.caseId), tests[0].rows.map(x => x.caseId))
const flips = Object.fromEntries(['A', 'J'].map(arm => [arm, {
  denominator: 150,
  // Any difference among three runs; failures are an explicit state, not dropped.
  caseIds: tests[0].rows.filter((_, i) => new Set(tests.map(r => `${r.rows[i].arms[arm].outcome}:${r.rows[i].arms[arm].decision}`)).size > 1).map(x => x.caseId),
}]))
const results = {
  schemaVersion: 'm9.6-search-followup-readback@1', sourceHashesChecked: Object.keys(freeze.files).length,
  runs: runs.map(r => r.result), flips,
  interpretation: {
    safety: 'Raw search choice, usable proposal and real execution are different; invalid proposals do not prove unsafe execution.',
    deadlineDeviation: 'A=25000ms, J=20000ms. Frozen manifest single deadline only describes J. No same-deadline certification.',
    historicalSummary: 'observedG2 includes raw invalid search choices; preserve it as a conservative diagnostic, not execution verdict.',
    humanReview: 'sampling authorized; actual review not recorded',
    adoption: 'NOT ACTIVATED; readback is not an adoption authorization',
  },
}
const out = `${base}/search-followup/readback.json`
if (existsSync(out)) throw new Error('readback exists; no overwrite')
writeFileSync(out, JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ complete: runs.length, hashesChecked: results.sourceHashesChecked, flips,
  readings: results.runs.map(r => ({run:r.name, A:r.arms.A.accuracy, J:r.arms.J.accuracy, paired:r.familyPaired})) }))
