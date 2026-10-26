/** Pure policy + validator + reducer. Evidence authority is rechecked by the caller transaction. */
import {
  EBL_LIMIT, EBL_POLICY, eblAssert, eblCanonical, eblSignature, eblSourceKey, validateEblCommand,
  type EblCommand, type EblEventPayload, type EblObservation, type EblSettlement,
  type EblSources, type EblState, type EblUse,
} from '../../contracts/epistemic-belief.ts'

export function currentEblEvidence(state: EblState, sources: EblSources): EblSettlement[] {
  const current = new Map(sources.observations.map(item => [eblSourceKey(item.ref), item]))
  return state.evidence.filter(item => {
    const actual = current.get(eblSourceKey(item.observation.ref))
    return actual?.usable === true && eblCanonical(actual) === eblCanonical(item.observation)
  })
}
export function eblMeetsPolicy(state: EblState, sources: EblSources): boolean {
  // A PDF hypothesis cannot discard a contradictory or unobserved formation outcome.
  if (state.claim.predicate === 'document_extracts' && (!sources.formation?.complete || sources.formation.value !== state.claim.expected)) return false
  if (state.claim.policy !== EBL_POLICY || !sources.formation?.usable || state.evidence.length === 0 || state.corrections?.length) return false
  const evidence = currentEblEvidence(state, sources)
  if (evidence.some(item => item.verdict === 'counterexample')) return false
  const supported = evidence.filter(item => item.independent && item.verdict === 'support')
  const tests = supported.map(item => state.tests.find(test => test.id === item.testId)!)
  const count = (values: string[]) => new Set(values).size
  /*
   * ⚠️ **写前置条件必须有一个对照**（ADR-151 步骤 C）：
   *    对照 = "条件**未**被违反时动作**成功**"（观察到了、完整执行了、但没有值）。
   *    没有对照 ⇒ 只知道"这次失败了"，**不知道**失败是不是**有条件的** ⇒ 不得取得资格。
   */
  if (state.claim.predicate === 'write_precondition_holds') {
    const controls = evidence.filter(item => item.verdict === 'inconclusive'
      && item.observation.witnessed && item.observation.executed && item.observation.complete
      && item.observation.value === undefined)
    if (controls.length < 1) return false
  }
  // Frozen v1 policy: two independent tool tests; three human roots, >=2 real episodes/bindings.
  return count(supported.map(item => item.observation.independentKey)) >= (state.claim.domain === 'tool' ? 2 : 3)
    && count(tests.map(test => test.episodeId)) >= 2 && count(tests.map(test => test.bindingKey)) >= 2
    && count(tests.map(test => test.designId)) >= (state.claim.domain === 'tool' ? 2 : 3)
}
export function eblUsable(state: EblState, sources: EblSources, context: EblUse['context'], allowHuman = false, currentTestId?: string): boolean {
  return state.status === 'validated' && state.reviewedFingerprint === sources.fingerprint
    && state.tests.every(test => state.evidence.some(item => item.testId === test.id) || state.closedTests?.some(item => item.testId === test.id)
      || (test.id === currentTestId && test.source !== undefined
        && sources.observations.some(item => test.anchor && eblSourceKey(item.ref) === eblSourceKey(test.anchor) && item.usable)
        && !sources.observations.some(item => eblSourceKey(item.ref) === eblSourceKey(test.source!))))
    && (state.claim.domain === 'tool' || allowHuman)
    && context.subjectId === state.claim.subjectId && context.scope === state.claim.scope
    && context.environment === state.claim.environment
    && Object.entries(state.claim.conditions).every(([key, value]) => context.conditions[key] === value)
    && eblMeetsPolicy(state, sources)
}
export function validateEblTransition(input: {
  claimId: string; characterId: string; command: EblCommand; state?: EblState;
  sources: EblSources; observation?: EblObservation; now: number; allowHuman?: boolean;
  successor?: EblState;
}): EblEventPayload {
  const { claimId, characterId, state, sources, observation, now } = input
  const command = validateEblCommand(input.command)
  eblAssert(Number.isFinite(now) && now >= 0, 'invalid_time')
  let nextStatus = state?.status ?? 'pending'
  let settlement: EblSettlement | undefined
  let correction: EblObservation | undefined
  let closure: EblObservation | undefined
  if (command.kind === 'propose') {
    eblAssert(!state, 'claim_exists')
    eblAssert(command.claim.policy === EBL_POLICY, 'new_claim_policy')
    eblAssert(command.claim.id === claimId && command.claim.characterId === characterId, 'owner')
    eblAssert(sources.formation?.usable && sources.formation.characterId === characterId
      && sources.formation.subjectId === command.claim.subjectId
      && eblSourceKey(sources.formation.ref) === eblSourceKey(command.claim.formation), 'formation_source')
    if (command.claim.predecessor) eblAssert(input.successor?.claim.id === command.claim.predecessor
      && input.successor.claim.characterId === characterId && input.successor.claim.subjectId === command.claim.subjectId
      && input.successor.status !== 'withdrawn', 'predecessor')
  } else {
    eblAssert(state && state.claim.id === claimId && state.claim.characterId === characterId, 'claim_missing')
    eblAssert(!['withdrawn', 'retired', 'superseded'].includes(state.status), 'terminal')
    if (command.kind === 'register') {
      eblAssert(state.tests.length < EBL_LIMIT && !state.tests.some(test => test.id === command.test.id), 'test_duplicate_or_limit')
      eblAssert(sources.formation?.usable, 'formation_source')
      if (state.claim.domain === 'tool') eblAssert(command.test.source?.kind === 'action', 'test_source_required')
      if (state.claim.domain === 'tool') eblAssert(command.test.anchor?.kind === 'conversation'
        && sources.observations.some(item => eblSourceKey(item.ref) === eblSourceKey(command.test.anchor!)
          && item.usable && item.characterId === characterId && item.subjectId === state.claim.subjectId), 'test_anchor_required')
    } else if (command.kind === 'settle') {
      const test = state.tests.find(item => item.id === command.testId)
      eblAssert(test && !state.evidence.some(item => item.testId === command.testId)
        && !state.closedTests?.some(item => item.testId === command.testId), 'test_missing_or_settled')
      if (test.source) eblAssert(eblSourceKey(test.source) === eblSourceKey(command.source), 'registered_source_mismatch')
      eblAssert(observation && observation.usable && observation.characterId === characterId
        && observation.subjectId === state.claim.subjectId && eblSourceKey(observation.ref) === eblSourceKey(command.source), 'observation_source')
      eblAssert(observation.observedAt > test.registeredAt && observation.observedAt > state.formedAt, 'not_preregistered')
      eblAssert(observation.episodeId === test.episodeId && observation.bindingKey === test.bindingKey
        && observation.targetId === test.targetId && observation.environment === state.claim.environment, 'test_binding')
      eblAssert(eblSourceKey(observation.ref) !== eblSourceKey(state.claim.formation)
        && !observation.rootIds.some(root => sources.formation?.rootIds.includes(root)), 'formation_reused')
      const verdict = observation.excluded ? 'excluded'
        : !observation.witnessed || !observation.executed || !observation.complete || observation.value === undefined ? 'inconclusive'
          : observation.value === state.claim.expected ? 'support' : 'counterexample'
      const independent = observation.influencedBy.length === 0 && !state.evidence.some(item =>
        item.observation.independentKey === observation.independentKey || item.observation.rootIds.some(root => observation.rootIds.includes(root))
        || state.tests.find(existing => existing.id === item.testId)?.designId === test.designId)
      /*
       * ⚠️ **带上的"比的是哪一版"**（2026-10-21 新增 · 计划 P2 第 4 步）：
       *    结算落账本时要说清「对应**预测/规则/模型版本**」——
       *    否则账本只说"被支持/被反驳"，答不出"哪一版模型、哪条规则、哪个对象"。
       *    ⇒ 命令里带了 `model` 就带上；没带就**不带**（不编造版本）。
       */
      settlement = {
        testId: test.id,
        observation,
        verdict,
        independent,
        ...(command.model === undefined ? {} : { model: command.model }),
      }
      if (verdict === 'counterexample') nextStatus = 'suspended'
    } else if (command.kind === 'close_test') {
      const test = state.tests.find(item => item.id === command.testId)
      eblAssert(state.claim.domain === 'interpersonal' && test && !test.source
        && !state.evidence.some(item => item.testId === test.id) && !state.closedTests?.some(item => item.testId === test.id)
        && observation?.usable && observation.characterId === characterId && observation.subjectId === state.claim.subjectId
        && observation.environment === state.claim.environment && observation.episodeId !== test.episodeId
        && observation.observedAt > test.registeredAt && eblSourceKey(observation.ref) === eblSourceKey(command.source), 'context_closure')
      closure = observation // An ended context is not a realized support or counterexample.
    } else if (command.kind === 'correct') {
      eblAssert(state.claim.domain === 'interpersonal' && state.claim.predicate === 'explanation_detail'
        && command.source.kind === 'conversation' && observation?.usable && observation.witnessed
        && observation.executed && observation.complete && !observation.excluded
        && observation.feedbackScope === 'persistent' && ['concise', 'detailed'].includes(String(observation.value))
        && observation.value !== state.claim.expected && observation.characterId === characterId
        && observation.subjectId === state.claim.subjectId && observation.environment === state.claim.environment
        && eblSourceKey(observation.ref) === eblSourceKey(command.source)
        && observation.observedAt > state.formedAt && (state.corrections?.length ?? 0) < EBL_LIMIT, 'explicit_correction')
      correction = observation
      nextStatus = 'suspended'
    } else if (command.kind === 'review') {
      eblAssert(eblMeetsPolicy(state, sources) && state.tests.every(test => state.evidence.some(item => item.testId === test.id)
        || state.closedTests?.some(item => item.testId === test.id)), 'validation_policy')
      nextStatus = 'validated'
    } else if (command.kind === 'withdraw') nextStatus = 'withdrawn'
    else if (command.kind === 'retire') {
      eblAssert(currentEblEvidence(state, sources).some(item => item.verdict === 'counterexample') || state.corrections?.length, 'retire_without_counterexample')
      nextStatus = 'retired'
    } else if (command.kind === 'supersede') {
      const successor = input.successor
      eblAssert(successor && successor.claim.predecessor === claimId && successor.claim.characterId === characterId
        && successor.claim.subjectId === state.claim.subjectId && successor.claim.domain === state.claim.domain
        && successor.claim.id === command.successorId && successor.status === 'validated'
        && eblSignature(successor.claim) !== eblSignature(state.claim), 'successor')
      nextStatus = 'superseded'
    } else if (command.kind === 'use') {
      eblAssert(state.uses.length < EBL_LIMIT && command.use.before !== command.use.after
        && !state.uses.some(use => use.decisionId === command.use.decisionId), 'use_duplicate_or_no_change')
      eblAssert(eblUsable(state, sources, command.use.context, input.allowHuman, command.use.decisionId), 'not_usable')
    }
  }
  const forbiddenRoots = command.kind === 'withdraw' ? [...new Set([
    ...(state?.formation.rootIds ?? []), ...(sources.formation?.rootIds ?? []), ...(state?.evidence.flatMap(item => item.observation.rootIds) ?? []),
    ...(state?.corrections?.flatMap(item => item.rootIds) ?? []),
    ...(state?.closedTests?.flatMap(item => item.source.rootIds) ?? []),
  ])].sort() : undefined
  if (command.kind === 'withdraw') eblAssert(forbiddenRoots && forbiddenRoots.length > 0, 'withdraw_roots_missing')
  return { claimId, command, ...(settlement ? { settlement } : {}), sourceFingerprint: sources.fingerprint, nextStatus,
    ...(forbiddenRoots ? { forbiddenRoots } : {}), ...(correction ? { correction } : {}),
    ...(closure ? { closure } : {}),
    ...(command.kind === 'propose' ? { formation: sources.formation! } : {}) }
}

export function reduceEbl(state: EblState | undefined, event: EblEventPayload, at: number): EblState {
  const command = event.command
  if (command.kind === 'propose') {
    if (state) return state
    eblAssert(event.formation, 'replay_formation')
    return { claim: structuredClone(command.claim), formation: structuredClone(event.formation), status: 'pending', formedAt: at, tests: [], evidence: [], uses: [] }
  }
  eblAssert(state && state.claim.id === event.claimId, 'replay_orphan')
  const next: EblState = { ...state, status: event.nextStatus }
  if (command.kind === 'register') next.tests = [...state.tests, { ...structuredClone(command.test), registeredAt: at }]
  if (command.kind === 'settle') { eblAssert(event.settlement, 'replay_settlement'); next.evidence = [...state.evidence, structuredClone(event.settlement)] }
  if (command.kind === 'correct') { eblAssert(event.correction, 'replay_correction'); next.corrections = [...(state.corrections ?? []), structuredClone(event.correction)] }
  if (command.kind === 'close_test') { eblAssert(event.closure, 'replay_closure'); next.closedTests = [...(state.closedTests ?? []), { testId: command.testId, source: structuredClone(event.closure) }] }
  if (command.kind === 'review') next.reviewedFingerprint = event.sourceFingerprint
  if (command.kind === 'supersede') next.successorId = command.successorId
  if (command.kind === 'use') next.uses = [...state.uses, structuredClone(command.use)]
  return next
}
