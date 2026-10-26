import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOpenAiStoryChoicePort } from '../../src/infrastructure/model/openai-story-choice.ts'
import { ACTIONS, casesFor, equal, execute, goalReached, hash, makeWorld, parseRules, predict, replay, search, verify, type State } from './world.ts'

function outputBudgetExhausted(row: { httpStatus?: number; usage?: unknown }): boolean {
  const usage = row.usage as { completion_tokens?: number } | undefined
  return row.httpStatus === 200 && (usage?.completion_tokens ?? 0) >= 4096
}
assert(outputBudgetExhausted({ httpStatus: 200, usage: { completion_tokens: 4096 } }))
assert(!outputBudgetExhausted({ httpStatus: 429, usage: { completion_tokens: 4096 } }))
assert(!outputBudgetExhausted({ httpStatus: 200, usage: { completion_tokens: 4095 } }))
assert(!outputBudgetExhausted({ httpStatus: 200 }))
const controls = verify() + 4
console.log(`Offline controls: ${controls}/${controls}`)
if (process.argv.includes('--verify')) {
  const directory = join(process.cwd(), 'artifacts/post-lv2/local/world-model-pilot', `offline-${Date.now()}`)
  mkdirSync(directory, { recursive: true })
  const corpus = Array.from({ length: 6 }, (_, i) => makeWorld(i)).flatMap(casesFor)
  const hashes = Object.fromEntries(['protocol.md', 'world.ts', 'run.ts'].map(file => [file, hash(readFileSync(join(process.cwd(), 'evals/world-model-pilot', file), 'utf8'))]))
  writeFileSync(join(directory, 'verification.json'), JSON.stringify({ passed: controls, failed: 0, sourceHashes: hashes, corpusHash: hash(corpus), cases: corpus.length, database: 'NOT OPENED', modelRequests: 0 }, null, 2))
  console.log(`Evidence: ${directory}`)
  process.exit(0)
}
assert(process.argv.includes('--live'), 'Use --verify or --live')
assert(process.env.DSH_TEST_MODEL_WRAPPER === '1' && process.env.OPENAI_API_KEY?.trim(), 'Test-model wrapper and test credentials required')
assert(process.env.OPENAI_BASE_URL?.trim() && process.env.OPENAI_SMALL_MODEL?.trim(), 'Explicit test endpoint/model required')

const root = process.cwd()
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const output = join(root, 'artifacts/post-lv2/local/world-model-pilot', runId)
execFileSync('git', ['check-ignore', join(output, 'calls.json')], { stdio: 'pipe' })
mkdirSync(output, { recursive: true })
const worlds = Array.from({ length: 6 }, (_, i) => makeWorld(i))
const cases = worlds.flatMap(casesFor)
const resumeIndex = process.argv.indexOf('--resume')
const resumeDirectory = resumeIndex < 0 ? undefined : process.argv[resumeIndex + 1]
const resumedCalls: Call[] = resumeDirectory ? JSON.parse(readFileSync(join(resumeDirectory, 'calls.json'), 'utf8')) : []
if (resumeDirectory) {
  const prior = JSON.parse(readFileSync(join(resumeDirectory, 'summary.json'), 'utf8'))
  assert.equal(prior.corpusHash, hash(cases), 'Cannot resume a different corpus')
  assert.equal(prior.model, process.env.OPENAI_SMALL_MODEL, 'Cannot resume a different model')
  assert(resumedCalls.length < 48 && resumedCalls.every(c => !c.error || outputBudgetExhausted(c)), 'Transport failures cannot be resumed')
}
const sourceHashes = Object.fromEntries(['protocol.md', 'world.ts', 'run.ts'].map(file => [file, hash(readFileSync(join(root, 'evals/world-model-pilot', file), 'utf8'))]))
writeFileSync(join(output, 'preregistration.json'), JSON.stringify({ schema: 'world-model-pilot@1', sourceHashes, corpusHash: hash(cases), cases, controls, resumeDirectory }, null, 2))

const schema = `The executable model is JSON {"rulebook":"short explanation including unresolved alternatives","rules":[...]}. There must be exactly one rule for each action.
Each rule has exactly {"action":"key_a|key_b|key_c","op":"add|set|refill","field":"shape|colour|fuel","value":integer,"cost":integer}.
For add: subtract cost from fuel and add value to the named field modulo that field's range. For set: subtract cost and set the field to value. Neither changes any other field. For refill: field=fuel,cost=0,value=new fuel, and consume the single refill. Cannot refill twice. If fuel<cost, or refill unavailable, action is illegal and the state stays unchanged. Values must be 0..6 and costs 0..3. Non-refill rules act only on shape/colour. Refill rules act only on fuel. These are representation options, not the hidden world rules.`
const shared = `This is a synthetic badge puzzle, not a user conversation. Infer the unknown button dynamics from observed transitions. State fields are fully visible; each recorded before-state starts an independent trial. Illegal actions leave state unchanged in observations, but a successful plan must contain only legal actions. Fuel must never be negative. Match target shape and colour within 8 actions, minimizing action count. Use only the supplied observations as evidence. Both generalizing addition and constant-setting are possible explanations until evidence distinguishes them. Reply only with a JSON object, no hidden reasoning transcript. ${schema}`
type Case = (typeof cases)[number]
type Arm = 'A' | 'B'
type Call = { caseId: string; arm: Arm; stage: number; prompt: string; raw?: unknown; usage?: unknown; latencyMs: number; httpStatus?: number; providerCode?: number; error?: string }
type Result = { caseId: string; world: number; arm: Arm; success: boolean; optimal: boolean; actions: number | null; oracleActions: number; predictionsCorrect: number; predictionsTotal: number; initialReplay?: boolean; finalReplay?: boolean; revised?: boolean; failure?: string; plan: string[]; trace?: unknown }
const calls: Call[] = [], results: Result[] = []
const save = () => {
  writeFileSync(join(output, 'calls.json'), JSON.stringify(calls, null, 2))
  writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2))
}

async function call(c: Case, arm: Arm, stage: number, prompt: string): Promise<unknown> {
  const previous = resumedCalls.find(row => row.caseId === c.id && row.arm === arm && row.stage === stage)
  if (previous) {
    assert.equal(previous.prompt, prompt, 'Resumed requests must remain byte-identical')
    const cached = { ...previous }
    if (cached.error && outputBudgetExhausted(cached)) { cached.error = 'output_budget_exhausted'; cached.raw = { invalidOutput: 'output_budget_exhausted' } }
    calls.push(cached); save()
    console.log(`${calls.length}/48 ${c.id} ${arm}${stage}: preserved previous request, not repeated`)
    return cached.raw
  }
  const row: Call = { caseId: c.id, arm, stage, prompt, latencyMs: 0 }
  const started = performance.now()
  const port = createOpenAiStoryChoicePort({ timeoutMs: 90_000, fetchImpl: async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    body.max_tokens = 4096
    const response = await fetch(url, { ...init, body: JSON.stringify(body) })
    row.httpStatus = response.status
    const payload = await response.clone().json().catch(() => ({})) as { usage?: unknown; error?: { message?: unknown } }
    if (response.ok) row.usage = payload.usage
    const code = /\((\d+)\)/.exec(String(payload.error?.message ?? ''))
    if (code) row.providerCode = Number(code[1])
    return response
  } })
  try { row.raw = await port.call({ userMessage: prompt, deadlineMs: 90_000 }); return row.raw }
  catch (error) {
    if (outputBudgetExhausted(row)) { row.error = 'output_budget_exhausted'; row.raw = { invalidOutput: row.error }; return row.raw }
    row.error = row.httpStatus ? `http_${row.httpStatus}` : error instanceof Error ? error.name : 'transport_error'; throw error
  }
  finally {
    row.latencyMs = Math.round(performance.now() - started)
    calls.push(row); save()
    console.log(`${calls.length}/48 ${c.id} ${arm}${stage}: ${row.error ?? 'response'} (${row.latencyMs}ms)`)
  }
}

async function run(c: Case, arm: Arm): Promise<void> {
  const w = worlds[c.world], oracle = search(c.start, c.goal, w.oracleStep)!
  const row: Result = { caseId: c.id, world: c.world, arm, success: false, optimal: false, actions: null, oracleActions: oracle.length, predictionsCorrect: 0, predictionsTotal: c.probes.length, plan: [] }
  try {
    const firstTask = arm === 'A'
      ? 'Analyze the observations and retain concise reasoning notes for later decisions. Return {"notes":"..."}. You have the same representation options as the other condition, but may reason in any way.'
      : 'Infer an initial rulebook and declarative model using the specified JSON schema. Keep uncertainty in the rulebook; choose a working hypothesis for each executable rule.'
    const first = await call(c, arm, 1, `${shared}\n${firstTask}\n${JSON.stringify({ publicInterface: c.publicInterface, observations: c.initial })}`)
    if (arm === 'B') {
      try { row.initialReplay = replay(w, parseRules(first), c.initial) } catch { row.initialReplay = false }
    }
    const secondTask = arm === 'A'
      ? 'Use all evidence and your earlier notes to infer the rules, mentally compare candidate sequences, and choose a shortest successful plan. Return exactly {"plan":["key_a",...],"predictions":[state,...]}. predictions must contain one next-state for each probe in order; illegal probe actions predict the unchanged state.'
      : 'Revise the rulebook and executable rules using all old and new observations. Return only {"rulebook":"...","rules":[...]}. Your model will be replay-checked and a fixed shortest-path planner will use only your rules to choose actions. No oracle rules are available to it.'
    const payload = { publicInterface: c.publicInterface, observations: [...c.initial, ...c.additional], previous: JSON.stringify(first).slice(0, 6000), start: c.start, goal: c.goal, probes: c.probes }
    const second = await call(c, arm, 2, `${shared}\n${secondTask}\n${JSON.stringify(payload)}`)
    let predictions: unknown[]
    if (arm === 'A') {
      assert(second && typeof second === 'object' && !Array.isArray(second))
      const parsed = second as { plan: unknown; predictions: unknown }
      assert.deepEqual(Object.keys(parsed).sort(), ['plan', 'predictions'])
      assert(Array.isArray(parsed.plan) && parsed.plan.length <= 8 && parsed.plan.every(a => ACTIONS.includes(a)))
      assert(Array.isArray(parsed.predictions) && parsed.predictions.length === c.probes.length)
      row.plan = parsed.plan; predictions = parsed.predictions
    } else {
      const rules = parseRules(second)
      row.revised = !equal(first, second)
      row.finalReplay = replay(w, rules, [...c.initial, ...c.additional])
      if (!row.finalReplay) { row.failure = 'replay_rejected'; return }
      predictions = c.probes.map(p => predict(c.publicInterface, rules, p.before, p.action) ?? p.before)
      const plan = search(c.start, c.goal, (s, a) => predict(c.publicInterface, rules, s, a))
      if (!plan) { row.failure = 'no_model_plan'; return }
      row.plan = plan
    }
    row.predictionsCorrect = predictions.filter((p, i) => {
      const truth = execute(w, c.probes[i].before, [c.probes[i].action]).state
      // Compare field values, not model JSON property order.
      return p && typeof p === 'object' && Object.keys(truth).length === Object.keys(p).length && Object.entries(truth).every(([k, v]) => (p as State)[k as keyof State] === v)
    }).length
    const actual = execute(w, c.start, row.plan)
    row.actions = actual.trace.length; row.trace = actual.trace
    row.success = actual.valid && goalReached(actual.state, c.goal)
    row.optimal = row.success && row.actions === oracle.length
  } catch (error) { row.failure = outputBudgetExhausted(calls.at(-1) ?? {}) ? 'output_budget_exhausted' : error instanceof assert.AssertionError ? 'invalid_schema' : 'call_failed' }
  finally { results.push(row); save() }
}

const transportFailed = () => calls.some(c => c.error && c.error !== 'output_budget_exhausted')
for (const [i, c] of cases.entries()) {
  for (const arm of (i % 2 === 0 ? ['A', 'B'] : ['B', 'A']) as Arm[]) {
    await run(c, arm)
    if (transportFailed()) break
  }
  if (transportFailed()) { console.log('Transport failure: batch stopped, no retry.'); break }
}
const count = (arm: Arm, field: 'success' | 'optimal') => results.filter(r => r.arm === arm && r[field]).length
const clusters = worlds.map(w => ({ world: w.index, A: results.filter(r => r.world === w.index && r.arm === 'A' && r.optimal).length, B: results.filter(r => r.world === w.index && r.arm === 'B' && r.optimal).length }))
const wins = clusters.filter(c => c.B > c.A).length, losses = clusters.filter(c => c.A > c.B).length
const choose = (n: number, k: number): number => { let x = 1; for (let i = 1; i <= k; i++) x = x * (n - i + 1) / i; return x }
const n = wins + losses
const p = n === 0 ? 1 : Math.min(1, 2 * Array.from({ length: Math.min(wins, losses) + 1 }, (_, k) => choose(n, k)).reduce((a, b) => a + b, 0) / 2 ** n)
const complete = calls.length === 48 && !transportFailed()
const summary = {
  schema: 'world-model-pilot-result@1', runId, createdAt: new Date().toISOString(), sourceHashes, corpusHash: hash(cases),
  endpointHost: new URL(process.env.OPENAI_BASE_URL!).host, model: process.env.OPENAI_SMALL_MODEL,
  controls, requests: calls.length, requestsThisProcess: calls.length - resumedCalls.length, resumeDirectory, complete, monetaryCost: 'NOT MEASURED',
  arms: (['A', 'B'] as Arm[]).map(arm => ({ arm, cases: results.filter(r => r.arm === arm).length, success: count(arm, 'success'), optimal: count(arm, 'optimal'), predictionsCorrect: results.filter(r => r.arm === arm).reduce((s, r) => s + r.predictionsCorrect, 0), predictionsTotal: results.filter(r => r.arm === arm).reduce((s, r) => s + r.predictionsTotal, 0), failures: results.filter(r => r.arm === arm && r.failure).map(r => ({ caseId: r.caseId, code: r.failure })), calls: calls.filter(c => c.arm === arm).map(c => ({ latencyMs: c.latencyMs, usage: c.usage })) })),
  clusters, worldSignTest: { wins, losses, ties: 6 - n, p, statisticallySupported: complete && p <= .05 },
  verdict: !complete ? 'INCOMPLETE' : count('B', 'optimal') - count('A', 'optimal') >= 3 && count('B', 'success') >= count('A', 'success') ? 'PILOT_GAIN' : 'NO_DEMONSTRATED_GAIN',
}
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ ...summary, arms: summary.arms.map(({ calls: _, ...a }) => a), output }, null, 2))
process.exitCode = complete ? 0 : 1
