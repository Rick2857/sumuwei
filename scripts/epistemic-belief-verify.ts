import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EBL_EVENT, makeEblClaim, validateEblClaim, validateEblCommand, validateEblEventPayload,
  type EblCommand, type EblState, type EblEventPayload } from '../src/kernel/contracts/epistemic-belief.ts'
import { currentEblEvidence, eblMeetsPolicy, eblUsable, reduceEbl, validateEblTransition } from '../src/kernel/app/epistemic-belief-lifecycle/lifecycle.ts'
import { fnv1a64Hex } from '../src/kernel/action/idempotency.ts'
import { renderBeliefSection } from '../src/kernel/contracts/belief-renderer.ts'
import { beliefReportedScopeKeyOf, type BeliefState } from '../src/kernel/contracts/belief.ts'
import { decideEblPreference, decideEblTaskClarification, readEblPreference, summarizeEblAcceptance,
  type AcceptanceOpportunity } from '../src/kernel/app/epistemic-belief-lifecycle/human-policy.ts'
import { createFullDomainEventRegistry } from '../src/kernel/contracts/domain-event.ts'
import { createDomainPolicyValidator } from '../src/kernel/policies/validator.ts'
import { createProposal } from '../src/kernel/contracts/proposal.ts'
import { asCharacterId, asConversationEventId } from '../src/kernel/contracts/ids.ts'
import { HAND_LABELED_EBL_TRACE, fixtureClaim, fixtureObservation, fixtureSources } from '../evals/epistemic-belief-lifecycle/fixtures.ts'
import { captureEblEvidenceSources } from './epistemic-belief-evidence.ts'

const sourceSnapshot = captureEblEvidenceSources()
const checks: string[] = []
function check(name: string, run: () => void) { run(); checks.push(name); console.log(`PASS ${name}`) }
const claim = fixtureClaim()
const formation = fixtureObservation('formation', { observedAt: 0 })
const a = fixtureObservation('a'), b = fixtureObservation('b'), counter = fixtureObservation('counter', { value: false })
const observations = [formation, a, b, counter]
const sources = () => fixtureSources(observations)
const context = { subjectId: claim.subjectId, scope: claim.scope, environment: claim.environment, conditions: claim.conditions }
let state: EblState | undefined
const events: { payload: EblEventPayload; at: number }[] = []
let clock = 10
function command(cmd: EblCommand) {
  const payload = validateEblTransition({ claimId: claim.id, characterId: claim.characterId, command: cmd, state,
    sources: sources(), observation: cmd.kind === 'settle' ? observations.find(item => item.ref.id === cmd.source.id) : undefined, now: clock })
  events.push({ payload, at: clock }); state = reduceEbl(state, payload, clock++)
}
function register(id: string, designId = id) {
  const observation = observations.find(item => item.ref.id === id)!
  command({ kind: 'register', test: { id, designId, episodeId: observation.episodeId, bindingKey: observation.bindingKey, targetId: observation.targetId, source: observation.ref, anchor: { kind: 'conversation', id: 'anchor' } } })
}
function settle(id: string) { command({ kind: 'settle', testId: id, source: { kind: 'action', id } }) }

check('registry includes strict EBL payload validator', () => assert.ok(createFullDomainEventRegistry().has(EBL_EVENT)))
const bypass = await createDomainPolicyValidator({ registry: createFullDomainEventRegistry(),
  sources: { async findEvents(ids) { return ids.map(id => ({ id, characterId: asCharacterId(claim.characterId), sequence: 1 })) } },
  processed: { async hasProcessed() { return false } },
}).validate(createProposal({ characterId: asCharacterId(claim.characterId), proposalType: 'ebl-forgery',
  sourceConversationEventIds: [asConversationEventId('cev:ebl-test-character:test:1')], payload: {},
  processor: 'untrusted-proposer', processorVersion: 'untrusted-proposer@1',
  targetEvents: [{ type: EBL_EVENT, operation: 'create', payload: { claimId: claim.id,
    command: { kind: 'review' }, sourceFingerprint: 'self-certified', nextStatus: 'validated' } }],
}))
check('generic proposal cannot bypass EBL evidence/lifecycle validator', () => {
  assert.equal(bypass.accepted, false)
  assert.equal(bypass.rejected[0].code, 'domain_event_requires_specialized_validator')
})
check('reject injected status/code/unknown fields', () => {
  assert.throws(() => validateEblCommand({ kind: 'review', validated: true }))
  assert.throws(() => validateEblCommand({ kind: 'propose', claim: { ...claim, executable: 'anything' } }))
  assert.throws(() => validateEblCommand({ kind: 'settle', source: { kind: 'tool_summary', id: 'x' }, testId: 'x' }))
})
check('forecast verdict accepts only its string enum and remains optional for old evidence', () => {
  const command = { kind: 'settle', source: { kind: 'action', id: 'read' }, testId: 'read',
    model: { modelVersion: 'model@1', ruleVersion: 'rule@1' } }
  validateEblCommand(command)
  for (const forecastVerdict of ['match', 'mismatch', 'unknown'])
    validateEblCommand({ ...command, model: { ...command.model, forecastVerdict } })
  for (const forecastVerdict of ['counterexample', ['match'], { value: 'match' }, true, null])
    assert.throws(() => validateEblCommand({ ...command, model: { ...command.model, forecastVerdict } }), /model_forecast_verdict/)
})
check('goal independent canonical identity', () => {
  const { id, policy, ...input } = claim
  assert.equal(makeEblClaim({ ...input, conditions: { encoding: 'utf8' } }).id, id)
  assert.notEqual(makeEblClaim({ ...input, environment: 'sandbox-filesystem@2' }).id, id)
})
check('propose has no behavioral authority', () => { command({ kind: 'propose', claim }); assert.equal(eblUsable(state!, sources(), context), false) })
check('reject model self validation', () => assert.throws(() => command({ kind: 'review' }), /validation_policy/))
check('freeze tests before realized observations', () => { register('a'); settle('a'); assert.equal(state!.evidence[0].verdict, 'support') })
check('duplicate settlement cannot increase support', () => assert.throws(() => settle('a'), /settled/))
check('one support cannot validate', () => assert.throws(() => command({ kind: 'review' }), /validation_policy/))
check('independent later task and binding can validate', () => { register('b'); settle('b'); command({ kind: 'review' }); assert.equal(eblUsable(state!, sources(), context), true) })
check('wrong scope/version/condition has no authority', () => {
  assert.equal(eblUsable(state!, sources(), { ...context, environment: 'v2' }), false)
  assert.equal(eblUsable(state!, sources(), { ...context, conditions: {} }), false)
  assert.equal(eblUsable(state!, sources(), { ...context, subjectId: 'foreign-user' }), false)
})
check('actual decision change recorded separately', () => {
  command({ kind: 'use', use: { decisionId: 'decision', before: 'unknown', after: 'readback_expected', context } })
  assert.equal(state!.uses.length, 1); assert.equal(state!.evidence.length, 2)
})
check('source revoked immediately masks cached validated state', () => {
  a.usable = false; assert.equal(eblUsable(state!, sources(), context), false); a.usable = true
})
check('real counterexample suspends the used rule', () => {
  register('counter'); settle('counter'); assert.equal(state!.status, 'suspended'); assert.equal(eblUsable(state!, sources(), context), false)
})
check('counterexample withdrawal does not silently restore authority', () => {
  counter.usable = false; assert.equal(eblUsable(state!, sources(), context), false); counter.usable = true
})
check('counterexample cannot be outvoted by supports', () => assert.throws(() => command({ kind: 'review' }), /validation_policy/))
check('counterexample can retire rule and terminal cannot revive', () => {
  command({ kind: 'retire' }); assert.equal(state!.status, 'retired')
  assert.throws(() => command({ kind: 'review' }), /terminal/)
})
check('deterministic replay equals independent hand labels and incremental projection', () => {
  let replay: EblState | undefined
  assert.equal(events.length, HAND_LABELED_EBL_TRACE.length)
  for (const [index, event] of events.entries()) {
    replay = reduceEbl(replay, event.payload, event.at)
    assert.deepEqual([replay.status, replay.tests.length, replay.evidence.length, replay.uses.length], HAND_LABELED_EBL_TRACE[index])
  }
  assert.deepEqual(replay, state)
})
check('JSONB key order cannot change evidence identity or idempotency', () => {
  // Preserve nested references, reversing top-level fields as JSONB may do.
  const actual = Object.fromEntries(Object.entries(a).reverse()) as typeof a
  const saved = events.find(event => event.payload.command.kind === 'settle')!.payload.settlement!
  const testState = { ...state!, evidence: [saved] }
  const source = fixtureSources([formation, actual])
  assert.equal(currentEblEvidence(testState, source).length, 1)
})

// Independent scenario matrix. A deliberately faulty implementation must fail these controls.
for (const [name, patch, expected, independent] of [
  ['timeout excluded', { excluded: 'transport_failure' }, 'excluded', true],
  ['unwitnessed condition', { witnessed: false }, 'inconclusive', true],
  ['missing observation', { complete: false }, 'inconclusive', true],
  ['cancelled action', { excluded: 'cancelled', executed: false }, 'excluded', true],
  ['rule influenced outcome', { influencedBy: [claim.id] }, 'support', false],
  ['independent counterexample', { value: false }, 'counterexample', true],
] as const) {
  check(name, () => {
    const observation = fixtureObservation('x', { ...patch } as Partial<typeof a>)
    const localSources = fixtureSources([formation, observation])
    const base = reduceEbl(undefined, validateEblTransition({ claimId: claim.id, characterId: claim.characterId,
      command: { kind: 'propose', claim }, sources: localSources, now: 1 }), 1)
    const registered = reduceEbl(base, validateEblTransition({ claimId: claim.id, characterId: claim.characterId, state: base,
      command: { kind: 'register', test: { id: 'x', designId: 'x', episodeId: observation.episodeId, bindingKey: observation.bindingKey, targetId: observation.targetId, source: observation.ref, anchor: { kind: 'conversation', id: 'anchor' } } }, sources: localSources, now: 2 }), 2)
    const payload = validateEblTransition({ claimId: claim.id, characterId: claim.characterId, state: registered,
      command: { kind: 'settle', testId: 'x', source: observation.ref }, observation, sources: localSources, now: 3 })
    assert.equal(payload.settlement?.verdict, expected); assert.equal(payload.settlement?.independent, independent)
    assert.throws(() => validateEblTransition({ claimId: claim.id, characterId: claim.characterId, state: registered,
      command: { kind: 'settle', testId: 'x', source: observation.ref }, observation: { ...observation, observedAt: 1 }, sources: localSources, now: 3 }), /preregistered/)
  })
}
check('formation roots cannot be recounted under a new identity', () => {
  const observation = fixtureObservation('same-root', { rootIds: formation.rootIds })
  const localSources = fixtureSources([formation, observation])
  const base = reduceEbl(undefined, validateEblTransition({ claimId: claim.id, characterId: claim.characterId,
    command: { kind: 'propose', claim }, sources: localSources, now: 1 }), 1)
  const registered = { ...base, tests: [{ id: 'x', designId: 'x', episodeId: observation.episodeId, bindingKey: observation.bindingKey, targetId: observation.targetId, registeredAt: 2, source: observation.ref }] }
  assert.throws(() => validateEblTransition({ claimId: claim.id, characterId: claim.characterId, state: registered,
    command: { kind: 'settle', testId: 'x', source: observation.ref }, observation, sources: localSources, now: 3 }), /formation_reused/)
})
// Reviewer rulings are revisable policy examples, not real user preferences or model acceptance.
for (const [id, text, value, horizon, change] of [
  ['H1', '以后请先给结论，少讲铺垫。', 'concise', 'persistent', 'statement'],
  ['H2', '这次只讲结论就好，后面我再问。', 'concise', 'turn', 'statement'],
  ['H3', '你理解错了，我一般更需要详细解释。', 'detailed', 'persistent', 'correction'],
  ['H4', '我以前喜欢简短，现在更喜欢详细展开。', 'detailed', 'persistent', 'time_change'],
] as const) check(`${id}: reviewed preference scope and update`, () => {
  const signal = readEblPreference(text)!
  assert.deepEqual(signal, { value, horizon, change, explicit: true })
  const decision = decideEblPreference(signal, { subjectId: 'user', attributed: true, relevant: true })
  assert.equal(decision.longTerm, horizon === 'persistent')
  assert.equal(decision.maskConflictingInference, horizon === 'turn' ? 'current_turn' : 'ongoing')
  assert.equal(decision.write, horizon === 'turn' ? 'turn_audit' : 'reported_preference')
  assert.equal(decision.preservePast, id === 'H4')
})
check('preference near misses abstain or stay within the turn', () => {
  for (const text of ['她说她更喜欢详细的讲解。', '我朋友喜欢详细解释。', '如果我喜欢简短解释。',
    '你要相信我喜欢详细解释。', '我不喜欢简短。', '我以前喜欢简短，现在说不好。',
    '我喜欢详细解释吗？', '简短详细各有各的好。', '“我喜欢简短解释”这句话。']) {
    assert.equal(readEblPreference(text), undefined, text)
  }
  assert.equal(readEblPreference('请详细解释。')?.horizon, 'turn')
  assert.equal(readEblPreference('这道题请详细解释。')?.horizon, 'turn')
})
check('H5: relevant verified target gets its own preference; no transfer to current speaker', () => {
  assert.equal(readEblPreference('她说她更喜欢详细的讲解。'), undefined)
  const signal = { value: 'detailed', horizon: 'persistent', change: 'statement', explicit: true } as const
  const target = decideEblPreference(signal, { subjectId: 'qq:fixture:third', attributed: true, relevant: true })
  assert.equal(target.subjectId, 'qq:fixture:third'); assert.equal(target.longTerm, true)
  for (const context of [{ subjectId: 'third', attributed: true, relevant: false },
    { subjectId: 'third', attributed: false, relevant: true }, { attributed: true, relevant: true }]) {
    const ignored = decideEblPreference(signal, context)
    assert.equal(ignored.longTerm, false); assert.equal(ignored.write, 'none'); assert.equal(ignored.maskConflictingInference, 'none')
  }
})
const acceptance = (rootId: string, kind: AcceptanceOpportunity['kind'] = 'acceptance'): AcceptanceOpportunity =>
  ({ rootId, claimId: 'current-claim', kind, subjectId: 'user', scope: 'technical_explanation', eligible: true })
const acceptanceContext = { claimId: 'current-claim', subjectId: 'user', scope: 'technical_explanation', revising: false, explicitContradiction: false }
check('H6a: fewer than three acceptances are weak and disappear on revision', () => {
  const rows = [acceptance('a'), acceptance('b')]
  const result = summarizeEblAcceptance(rows, acceptanceContext)
  assert.equal(result.supporting, 2); assert.equal(result.tier, 'weak_acceptance')
  assert.equal(result.countsAsAgreement, false); assert.equal(result.grantsPermission, false)
  assert.equal(summarizeEblAcceptance(rows, { ...acceptanceContext, revising: true }).supporting, 0)
})
check('H6b: three independent majority acceptances support below explicit statements', () => {
  const rows = [acceptance('a'), acceptance('b'), acceptance('c'), acceptance('d', 'explicit_support')]
  const result = summarizeEblAcceptance(rows, { ...acceptanceContext, revising: true })
  assert.equal(result.tier, 'repeated_acceptance'); assert.equal(result.supporting, 3)
  assert.equal(result.canBlockRevision, false)
  assert.equal(summarizeEblAcceptance(rows, { ...acceptanceContext, explicitContradiction: true }).supporting, 0)
  assert.equal(summarizeEblAcceptance([...rows, acceptance('e', 'explicit_opposition')], acceptanceContext).supporting, 0)
})
check('H6: duplicates, unobserved silence, other subjects and exact-half ratio cannot become majority', () => {
  assert.equal(summarizeEblAcceptance([acceptance('a'), acceptance('a'), acceptance('a')], acceptanceContext).accepted, 1)
  const rows = [acceptance('a'), acceptance('b'), acceptance('c'), acceptance('d', 'explicit_support'),
    acceptance('e', 'explicit_support'), acceptance('f', 'explicit_support'), { ...acceptance('g'), eligible: false },
    { ...acceptance('h'), subjectId: 'other' }, { ...acceptance('i'), scope: 'other' }, { ...acceptance('j'), claimId: 'old-claim' }]
  assert.equal(summarizeEblAcceptance(rows, acceptanceContext).tier, 'weak_acceptance')
  const opposition = [acceptance('a', 'explicit_opposition'), acceptance('a', 'explicit_support'), acceptance('a')]
  assert.equal(summarizeEblAcceptance(opposition, acceptanceContext).supporting, 0)
})
check('H7/H8: task prohibition restricts authorization; only conflicting existing inference is revised', () => {
  for (const hasRelatedInference of [false, true]) for (const contradictsInference of [false, true]) {
    const result = decideEblTaskClarification({ hasRelatedInference, contradictsInference })
    assert.equal(result.prohibitExecution, true); assert.equal(result.mustRecheckAuthorization, true)
    assert.equal(result.scope, 'current_task'); assert.equal(result.createNewInference, false)
    assert.equal(result.reviseExistingInference, hasRelatedInference && contradictsInference)
  }
})
check('explicit persistent correction bypasses experimental delay but cannot validate its replacement', () => {
  const ref = { kind: 'conversation', id: 'direct-preference' } as const
  const humanClaim = makeEblClaim({ characterId: claim.characterId, subjectId: claim.subjectId, domain: 'interpersonal',
    predicate: 'explanation_detail', expected: 'concise', scope: 'technical_explanation', environment: 'interaction@2',
    conditions: { scene: 'technical_explanation' }, formation: ref })
  const origin = fixtureObservation('direct-preference', { ref, environment: humanClaim.environment, value: 'concise', feedbackScope: 'persistent' })
  const correction = fixtureObservation('cross-episode-correction', { ref: { kind: 'conversation', id: 'cross-episode-correction' },
    observedAt: 100, environment: humanClaim.environment, value: 'detailed', feedbackScope: 'persistent' })
  const humanSources = fixtureSources([origin, correction]); humanSources.formation = origin
  const initial = reduceEbl(undefined, validateEblTransition({ claimId: humanClaim.id, characterId: claim.characterId,
    command: { kind: 'propose', claim: humanClaim }, sources: humanSources, now: 1 }), 1)
  const input = { claimId: humanClaim.id, characterId: claim.characterId, state: initial, sources: humanSources,
    command: { kind: 'correct', source: correction.ref } as const, observation: correction, now: 101 }
  const payload = validateEblTransition(input)
  const corrected = reduceEbl(initial, payload, 101)
  assert.equal(corrected.status, 'suspended'); assert.equal(corrected.tests.length, 0)
  assert.equal(corrected.evidence.length, 0); assert.equal(corrected.corrections?.length, 1)
  for (const patch of [{ feedbackScope: 'turn' as const }, { usable: false }, { subjectId: 'other' },
    { value: 'concise' as const }, { observedAt: 0 }, { complete: false }]) {
    assert.throws(() => validateEblTransition({ ...input, observation: { ...correction, ...patch } }), /explicit_correction/)
  }
  assert.throws(() => validateEblTransition({ ...input, state: corrected, command: { kind: 'review' } }), /validation_policy/)
})
check('policy revision preserves old event replay and requires new claims to use current policy', () => {
  const oldSignature = JSON.stringify(['ebl-test-character', 'ebl-test-user', 'tool', 'readback_matches', true,
    'sandbox_readback', 'sandbox-filesystem@1', [['encoding', 'utf8']], ''])
  const legacy = validateEblClaim({ ...claim, policy: 'epistemic-policy@1', id: `ebl:${fnv1a64Hex(oldSignature)}` })
  assert.notEqual(legacy.id, claim.id)
  const legacy2 = validateEblClaim({ ...legacy, policy: 'epistemic-policy@2',
    id: `ebl:${fnv1a64Hex(JSON.stringify([...JSON.parse(oldSignature), 'epistemic-policy@2']))}` })
  assert.notEqual(legacy2.id, claim.id)
  const payload = validateEblEventPayload({ claimId: legacy.id, command: { kind: 'propose', claim: legacy },
    formation, nextStatus: 'pending', sourceFingerprint: 'historical-snapshot' })
  assert.equal(reduceEbl(undefined, payload, 1).claim.policy, 'epistemic-policy@1')
  assert.throws(() => validateEblTransition({ claimId: legacy.id, characterId: claim.characterId,
    command: { kind: 'propose', claim: legacy }, sources: sources(), now: 1 }), /new_claim_policy/)
  const current: EblState = { claim, formation, formedAt: 1, status: 'validated', uses: [],
    tests: [a, b].map(item => ({ id: item.ref.id, episodeId: item.episodeId, bindingKey: item.bindingKey,
      designId: item.ref.id, targetId: item.targetId, registeredAt: 2 })),
    evidence: [a, b].map(item => ({ testId: item.ref.id, verdict: 'support', independent: true, observation: item })) }
  assert.equal(eblMeetsPolicy(current, sources()), true)
  assert.equal(eblMeetsPolicy({ ...current, claim: legacy }, sources()), false)
  assert.equal(eblMeetsPolicy({ ...current, claim: legacy2 }, sources()), false)
})
check('legacy M9 renderer remains byte-identical when EBL takeover is absent', () => {
  const reported = { beliefId: 'reported', subject: { kind: 'user', id: 'render-user' }, epistemicKind: 'reported', status: 'active',
    proposition: { predicate: 'preference.answer_length', value: 'concise_summary', scopeKey: 'technical' }, evidenceRootIds: ['r'] } as unknown as BeliefState
  const inferred = { ...reported, beliefId: 'inferred', epistemicKind: 'inferred',
    proposition: { predicate: 'interaction.explanation_detail', value: 'detailed', scopeKey: 'technical_explanation' } } as unknown as BeliefState
  const rendered = renderBeliefSection({ candidates: [{ belief: reported }, { belief: inferred }], subject: { kind: 'user', id: 'render-user' }, quantifier: () => 1 })
  assert.equal(rendered?.text, [
    '【当前可用判断；内部参考，来源强度不等于客观真值】', '明确陈述：',
    '· 关于 technical：preference.answer_length 为 concise_summary（用户明确陈述；当前仍有效）', '暂定推断：',
    '· 在技术讲解这一范围，对方可能更需要步骤展开（互动推断；暂定，不是用户明确承诺）',
    '限制：这是互动推断与明确陈述的当前采信面；新更正优先；推断不得说成"你说过"；来源强度不等于客观真值。',
  ].join('\n'))
})
check('takeover preserves general style outside the technical scene and obeys the current override', () => {
  const general = { beliefId: 'general-style', subject: { kind: 'user', id: 'render-user' }, epistemicKind: 'reported', status: 'active',
    proposition: { predicate: 'preferred.explanation.style', value: 'balanced', scopeKey: 'general' }, evidenceRootIds: ['g'] } as unknown as BeliefState
  const technical = { ...general, beliefId: 'technical-style',
    proposition: { ...general.proposition, value: 'detailed', scopeKey: beliefReportedScopeKeyOf({ context: 'technical' }) } } as BeliefState
  const input = { candidates: [{ belief: general }, { belief: technical }], subject: { kind: 'user', id: 'render-user' }, quantifier: () => 1 }
  const outside = renderBeliefSection({ ...input, epistemic: { technicalContext: false, currentOverride: false } })
  assert.deepEqual(outside?.usedBeliefIds, ['general-style'])
  const inside = renderBeliefSection({ ...input, epistemic: { technicalContext: true, currentOverride: false } })
  assert.deepEqual(inside?.usedBeliefIds, ['technical-style'])
  assert.equal(renderBeliefSection({ ...input, epistemic: { technicalContext: true, currentOverride: true } }), undefined)
  assert.equal(readEblPreference('我喜欢简短的裙子。'), undefined)
  assert.equal(readEblPreference('请详细解释一般方法。')?.horizon, 'turn')
  assert.equal(readEblPreference('请详细解释以后的生活。')?.horizon, 'turn')
})
assert.ok(checks.length > 0)
assert.ok(sourceSnapshot.measured_files > 0)
assert.deepEqual(captureEblEvidenceSources(), sourceSnapshot, 'tested EBL sources changed during the gate')
const output = resolve('artifacts/local/epistemic-belief-lifecycle', `mechanism-${Date.now()}`)
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'none',
  evidenceKind: 'synthetic_mechanism', measured_count: checks.length, checks, ...sourceSnapshot }, null, 2))
console.log(`EBL mechanism: ${checks.length}/${checks.length}; ${output}`)
