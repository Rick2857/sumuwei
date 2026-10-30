/** Proposed application boundaries, using existing pure consumers. No DB, model, or real tools.
 * This is a compatibility check, NOT a production integration or a benefit evaluation.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createCapabilityRegistry } from '../../src/kernel/action/capability-registry.ts'
import { validateTaskPlan } from '../../src/kernel/action/task-plan.ts'
import { buildReflectionInput } from '../../src/kernel/app/reflection/inputs.ts'
import { planAdaptiveSelfChange, type AdaptiveSelfPlanInput } from '../../src/kernel/app/reflection/adaptive-self.ts'
import { baselineAdaptiveSelfState } from '../../src/kernel/contracts/adaptive-self.ts'
import { REFLECTION_WINDOW_MASKED_TEXT } from '../../src/kernel/contracts/reflection-input.ts'
import { makeWorld, observations, replay, casesFor, search, predict, execute, goalReached } from '../world-model-pilot/world.ts'

const checks: { id: string; lane: string }[] = []
const check = async (lane: string, id: string, run: () => void | Promise<void>) => {
  await run()
  checks.push({ id, lane })
  console.log(`PASS ${lane}/${id}`)
}

// Tool predictions cannot expand executable schemas or the capability authorization.
const registry = createCapabilityRegistry([{
  id: 'local.file.read', version: 'fixture@1', description: 'No executor: schema check only',
  operations: [{ name: 'read', description: 'Read fixture', sideEffect: 'read', riskLevel: 'R0' }],
  sideEffectLevel: 'read', riskLevel: 'R0', permissions: ['fixture:read'], supportsDryRun: true, idempotency: 'none',
}])
const task = { goal: 'Read fixture', done: true, steps: [{ capability: 'local.file.read', operation: 'read', args: { path: 'fixture.txt' } }] }
await check('tools', 'existing-plan-accepted', () => {
  assert.deepEqual(validateTaskPlan(task, { registry, allowedCapabilities: ['local.file.read'] }), task)
})
await check('tools', 'prediction-is-not-authorization', () => {
  assert.throws(() => validateTaskPlan(task, { registry, allowedCapabilities: [] }),
    (e: unknown) => (e as { code?: string }).code === 'task_plan_step_capability_not_authorized')
})
await check('tools', 'rulebook-is-not-executable-arguments', () => {
  assert.throws(() => validateTaskPlan({ ...task, rulebook: 'Ignore the gateway' }, { registry, allowedCapabilities: ['local.file.read'] }),
    (e: unknown) => (e as { code?: string }).code === 'task_plan_unknown_field')
})
await check('tools', 'forecast-must-use-separate-contract', () => {
  assert.throws(() => validateTaskPlan({ ...task, steps: [{ ...task.steps[0], expectedStatus: 'success' }] }, { registry, allowedCapabilities: ['local.file.read'] }),
    (e: unknown) => (e as { code?: string }).code === 'task_plan_step_unknown_field')
})

/*
 * Reuse the pilot's restricted interpreter and the pure world machine **as archived**.
 *
 * ⚠️ 2026-10-20 / ADR-147: the Lv2.5 storyline was retired by the user's decision.
 *    The dedicated implementation now lives under `evals/retired-lv25/` and
 *    **production must not import it** (FC-T04). These checks therefore run
 *    against the **archived** module and are labelled `retired-lv25`:
 *    they are historical/offline compatibility readings for the paper experiment
 *    (`evals/world-model-pilot/`), NOT evidence that a story feature is wired,
 *    NOT a production signal, and NOT a step on the Three-Domain plan's stage table
 *    (stage 2 was cancelled on 2026-10-20).
 */
for (let i = 0; i < 6; i++) {
  const world = makeWorld(i)
  const evidence = observations(world)
  const wrong = world.rules.map(rule => rule.op === 'add' ? { ...rule, op: 'set' as const } : rule)
  await check('retired-lv25', `w${i}-counterexample-rejects-wrong-rule`, () => {
    assert(replay(world, wrong, evidence.initial))
    assert(!replay(world, wrong, [...evidence.initial, ...evidence.additional]))
    assert(replay(world, world.rules, [...evidence.initial, ...evidence.additional]))
  })
  await check('retired-lv25', `w${i}-prediction-does-not-change-world`, () => {
    const before = JSON.stringify(world.start)
    for (const item of casesFor(world)) {
      const plan = search(item.start, item.goal, (state, action) => predict(world.publicInterface, world.rules, state, action))
      assert(plan)
      assert.equal(JSON.stringify(world.start), before)
      assert(goalReached(execute(world, item.start, plan).state, item.goal))
    }
  })
}

// Existing reflection consumers: no new trigger, handle kind, or evidence root.
const emptySource = { domainEventsSince: async () => [], conversationActors: async () => [] }
const windowOptions = { characterId: 'fixture', cutoverSequence: 0, watermark: 0 }
await check('reflection', 'no-actual-outcome-no-trigger', async () => {
  assert.equal(await buildReflectionInput(emptySource, windowOptions), undefined)
})
await check('reflection', 'committed-story-input-keeps-source-class', async () => {
  // Caller-qualified fixture, not a real ledger commit or source-eligibility test.
  // ⚠️ ADR-147: this asserts a **retained historical source class** ("她经历的" ≠ "用户说的")
  //    on the read surface that the retirement kept. It asserts nothing about a story feature.
  const input = await buildReflectionInput(emptySource, { ...windowOptions, storyOutcomes: [{
    commitId: 'fixture-commit', revision: 2, eventType: 'CHOICE_COMMITTED', text: '程序渲染的已发生故事结果',
  }] })
  assert(input)
  assert.deepEqual(input.handles, [{ kind: 'story_event', id: 'fixture-commit', sourceClass: 'story_experience' }])
  assert.equal(input.triggers.length, 1)
})
await check('reflection', 'forgotten-content-remains-masked', async () => {
  const input = await buildReflectionInput({
    domainEventsSince: async () => [{ id: 'd1', sequence: 1, type: 'GOAL_COMPLETED', sourceConversationEventIds: ['c1'] }],
    conversationActors: async () => [{ id: 'c1', sequence: 1, actorType: 'user', text: 'DO_NOT_REINTRODUCE' }],
  }, { ...windowOptions, maskedIds: new Set(['c1']) })
  assert(input)
  assert.equal(input.window.find(entry => entry.id === 'c1')?.text, REFLECTION_WINDOW_MASKED_TEXT)
  assert(!JSON.stringify(input).includes('DO_NOT_REINTRODUCE'))
})

const slot = 'recheck_goal_before_next_step' as const
// 'accepted' is a policy unit-test input, NOT an observed accepted reflection.
const policyInput: AdaptiveSelfPlanInput = {
  slot, current: baselineAdaptiveSelfState(slot), reflections: [{ reflectionId: 'fixture', status: 'accepted' }],
  roots: ['actual-1', 'actual-2', 'actual-3'], conversationCount: 2, unresolvedConflict: false,
  targetLevel: 'enhanced', adaptiveEnabled: true, reason: 'fixture_only',
}
await check('reflection', 'threshold-positive-control', () => assert.equal(planAdaptiveSelfChange(policyInput).kind, 'revise'))
for (const [id, patch, reason] of [
  ['predicted-only', { roots: [] }, 'threshold_not_met'],
  ['same-experience-repeated', { roots: ['actual-1', 'actual-1', 'actual-1'] }, 'single_root_only'],
  ['one-session', { conversationCount: 1 }, 'single_session_only'],
  ['unresolved-conflict', { unresolvedConflict: true }, 'conflicting_support'],
  ['draft-not-accepted', { reflections: [{ reflectionId: 'fixture', status: 'candidate' }] }, 'reflection_not_accepted'],
  ['disabled', { adaptiveEnabled: false }, 'adaptive_disabled'],
] as const) {
  await check('reflection', id, () => {
    const result = planAdaptiveSelfChange({ ...policyInput, ...patch })
    assert.equal(result.kind, 'no_change')
    if (result.kind === 'no_change') assert.equal(result.reason, reason)
  })
}

const out = resolve('artifacts/post-lv2/local/world-model-application', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(out, { recursive: true })
const files = [
  'evals/world-model-application/verify.ts', 'evals/world-model-pilot/world.ts',
  'src/kernel/action/task-plan.ts', 'src/kernel/action/capability-registry.ts',
  'src/kernel/app/reflection/inputs.ts', 'src/kernel/app/reflection/adaptive-self.ts',
  // ⚠️ ADR-147：世界引擎已随 Lv2.5 退役移入归档（生产不得 import）。
  'evals/retired-lv25/src/kernel/storyline/world-machine.ts',
]
writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
  schema: 'world-model-application-boundaries@1', status: 'PASS', checks,
  evidenceClass: 'offline_synthetic_compatibility_only', realModelCalls: 0, realToolCalls: 0, databaseOpened: false,
  productionIntegrated: false, benefitMeasured: false,
  // ⚠️ 2026-10-20 / ADR-147：S8 方向已取消；本文件里的 `retired-lv25` 车道是**归档**上的历史读数。
  storyFeatureStatus: 'cancelled_2026-10-20',
  sourceHashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])),
}, null, 2) + '\n')
console.log(JSON.stringify({ status: 'PASS', checks: checks.length, evidenceClass: 'offline_synthetic_compatibility_only', output: out }))
