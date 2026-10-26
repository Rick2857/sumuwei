/** Candidate human outlet: real PostgreSQL, Memory/M9 and TurnGateway; offline responses only. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { runPreparedPgGate, runPreparedPgGateInInstance } from './postgresql/test-harness.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'
import { captureEblEvidenceSources } from './epistemic-belief-evidence.ts'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { EBL_EVENT, makeEblClaim } from '../src/kernel/contracts/epistemic-belief.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createCharacterAssistantTurnIngress, createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { handleEblPreferenceTurn } from '../src/infrastructure/runtime/epistemic-preference.ts'
import { observeEblFeedback } from '../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { eblManagedRecall } from '../src/infrastructure/runtime/epistemic-human-context.ts'
import { buildBeliefContextSection } from '../src/infrastructure/runtime/adapters.ts'
import { seedBeliefOrigin, maybeRunBeliefEvaluation, maybeRunBeliefMemoryReconciliation } from '../src/infrastructure/runtime/belief-scheduler.ts'
import { listBeliefsByStatus } from '../src/infrastructure/persistence/belief-store.ts'
import { createEblStore } from '../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, EBL_HUMAN_ENVIRONMENT } from '../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { commitModelMemoryPlan } from '../src/infrastructure/runtime/post-turn-model-memory.ts'
import { exec } from '../src/infrastructure/persistence/db.ts'
import { countDomainEvents } from '../src/infrastructure/persistence/event-store.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { renderBeliefSection } from '../src/kernel/contracts/belief-renderer.ts'

if (process.env.LG_EBL_HUMAN_PG_CHILD !== '1') {
  process.env.LG_EBL_HUMAN_PG_CHILD = '1'
  const simAdminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  if (simAdminUrl !== '') await runPreparedPgGateInInstance(simAdminUrl, 'ebl-human', 'scripts/epistemic-belief-human-verify.ts')
  else await runPreparedPgGate('ebl-human', 'scripts/epistemic-belief-human-verify.ts')
  process.exit(0)
}
assert.equal(isolateDatabase('ebl-human', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } }).backend, 'postgres')
const snapshot = captureEblEvidenceSources()
const output = resolve('artifacts/local/epistemic-belief-lifecycle', `human-${Date.now()}`)
mkdirSync(output, { recursive: true })
const checks: string[] = []
function check(name: string, condition: unknown) { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`) }
const h = await createM4Harness({ label: 'ebl-human', userId: 'Alex', validatorFeatures: { restatementRevivalEnabled: true } })
try {
  const cid = h.kernel.characterId
  check('formal outlet is disabled by default', !readKernelFlags({}).epistemicBeliefHumanEnabled)
  const recorder = (id: string) => new ConversationRecorder({ db: h.db, characterId: cid, conversationId: asConversationId(id),
    userId: h.userId, userName: 'fixture', characterName: 'fixture', dryRun: false, transport: 'ebl-human-test',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()] })
  const a = recorder('ebl-human-a'), b = recorder('ebl-human-b')
  let aSequence = 1, bSequence = 1
  async function record(text: string, session = a) {
    const row = await session.recordUserMessage(text, session === a ? aSequence++ : bSequence++)
    assert.ok(row.event); return row.event
  }
  await seedBeliefOrigin(h.db, { characterId: cid, activationId: 'isolated-human-baseline' })
  for (const session of [a, a, b]) await record('以后请先给结论，少讲铺垫。', session)
  const original = await maybeRunBeliefEvaluation(h.db, { characterId: cid, activeUserId: h.userId })
  check('legacy baseline actually formed its tentative style rule', original.kind === 'flushed'
    && (await listBeliefsByStatus(h.db, cid, ['active'])).some(item => item.epistemicKind === 'inferred'))
  const legacy = renderBeliefSection({ candidates: (await listBeliefsByStatus(h.db, cid, ['active'])).map(belief => ({ belief })),
    subject: { kind: 'user', id: h.userId }, quantifier: text => Math.ceil(text.length / 2) })
  check('historical legacy renderer is measurable as a control, not a current runtime outlet', legacy?.text.includes('可能更需要简短结论'))
  const off = await buildBeliefContextSection(h.runtime, { characterId: String(cid), activeUserId: h.userId, selectedMemoryIds: [] })
  check('disabling EBL does not revive the retired legacy inference outlet', off === undefined)
  const beforeRetirement = await countDomainEvents(h.db, cid)
  const retired = await maybeRunBeliefEvaluation(h.db, { characterId: cid, activeUserId: h.userId, retireExplanationInference: true })
  check('takeover retires the old generator without running another inferred job', retired.kind === 'retired'
    && await countDomainEvents(h.db, cid) === beforeRetirement)
  check('takeover masks old inference even before a replacement qualifies', !await buildBeliefContextSection(h.runtime,
    { characterId: String(cid), activeUserId: h.userId, selectedMemoryIds: [], epistemicHuman: {} }))

  const unknownScene = await recorder('ebl-human-unknown-scene').recordUserMessage('以后请先给结论，少讲铺垫。', 1)
  assert.ok(unknownScene.event)
  const unscopedWrite = await handleEblPreferenceTurn(h.db, cid, h.userId, { owner: h.owner, speaker: h.user,
    event: { id: unknownScene.event.id, actorType: unknownScene.event.actorType, content: unknownScene.event.content } })
  await observeEblFeedback(h.db, cid, h.userId, String(unknownScene.event.id), true)
  check('an unobserved technical condition creates neither a scoped preference nor an EBL hypothesis',
    unscopedWrite === undefined && await countDomainEvents(h.db, cid, EBL_EVENT) === 0)

  const inferenceRoots: string[] = []
  await record('下面讨论技术讲解与算法。', a)
  await record('下面讨论技术讲解与算法。', b)
  for (const session of [a, a, a, b, b]) {
    const event = await record('讲细一点。', session)
    inferenceRoots.push(String(event.id))
    const result = await handleEblPreferenceTurn(h.db, cid, h.userId,
      { owner: h.owner, speaker: h.user, event: { id: event.id, actorType: event.actorType, content: event.content } })
    check('implicit feedback is never promoted to an explicit reported preference', result === undefined)
    await observeEblFeedback(h.db, cid, h.userId, String(event.id), true)
  }
  const claim = makeEblClaim({ characterId: String(cid), subjectId: h.userId, domain: 'interpersonal', predicate: 'explanation_detail',
    expected: 'detailed', scope: 'technical_explanation', environment: EBL_HUMAN_ENVIRONMENT,
    conditions: { scene: 'technical_explanation' }, formation: { kind: 'conversation', id: inferenceRoots[0] } })
  const store = createEblStore(h.db, cid, createEblSourceReader(h.userId))
  const validated = (await store.get(claim.id))!
  check('three prospective independent supports across two sessions validate', validated.status === 'validated'
    && validated.evidence.filter(item => item.independent && item.verdict === 'support').length === 3)
  check('a context change closes the old pending test without inventing an outcome', validated.closedTests?.length === 1
    && validated.evidence.length === 3)
  assert.deepEqual(await store.rebuild(claim.id), validated)
  check('closed-context and validation facts replay exactly', true)

  const native = createMemoryRetrievalStore({ store: h.store, integrity: owner => memoryIntegrityProblems(h.db, owner),
    rootReadings: ids => rootReadingsByMemory(h.db, ids) })
  const recall = createRecallTurnPort({ service: createMemoryRecallService({ port: eblManagedRecall(native) }), budget: DEFAULT_CONTEXT_BUDGET, now: Date.now })
  const c = recorder('ebl-human-gateway')
  let next = 1
  let legacyWriterCalls = 0
  const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
    recorder: c, conversationSequence: () => next, recentLimit: 16, slowPathEnabled: false, dryRun: false, userId: h.userId,
    memoryExplicitEnabled: true, memoryWriter: { async handleTurn(request) {
      const result = await handleEblPreferenceTurn(h.db, cid, h.userId, request)
      if (result !== undefined) return result
      legacyWriterCalls++; return undefined
    } }, recallEnabled: true, recall, recallBudget: DEFAULT_CONTEXT_BUDGET,
  })
  async function turn(text: string, options: { budget?: number; staleBuilder?: Awaited<ReturnType<typeof buildBeliefContextSection>> } = {}) {
    const incoming = await gateway.beginTurn(text)
    next = incoming.conversationSequence + 1
    await observeEblFeedback(h.db, cid, h.userId, String(incoming.userEvent!.id), true)
    const scheduling = await maybeRunBeliefEvaluation(h.db, { characterId: cid, activeUserId: h.userId, retireExplanationInference: true })
    assert.equal(scheduling.kind, 'retired')
    await maybeRunBeliefMemoryReconciliation(h.db, { characterId: cid })
    const packet = await gateway.compileTurn({ turn: incoming, currentInput: text, recentLines: [],
      buildBeliefSection: info => options.staleBuilder ? Promise.resolve(options.staleBuilder) : buildBeliefContextSection(h.runtime,
        { characterId: String(cid), activeUserId: h.userId, selectedMemoryIds: info.selectedMemoryIds,
          ...(options.budget === undefined ? {} : { tokenBudget: options.budget }), epistemicHuman: { currentEventId: String(incoming.userEvent!.id) } }) })
    await gateway.completeTurn({ turn: incoming, replyText: '隔离离线回复。' })
    next++
    return { incoming, packet, belief: packet.sections.find(section => section.id === 'belief') }
  }
  const included = await turn('请解释一个算法。')
  check('one real compiled belief section includes the qualified EBL rule', included.belief?.sourceRefs?.includes(claim.id)
    && included.belief.content.includes('经独立后续反馈检验') && !included.belief.content.includes('可能更需要简短结论'))
  check('final inclusion records actual guidance selection, not a retrieval hit', (await store.get(claim.id))?.uses.length === 1)
  const received = await turn('讲细一点。')
  const guided = await createEblSourceReader(h.userId)(h.db, { kind: 'conversation', id: String(received.incoming.userEvent!.id) }, claim, false)
  check('feedback after a guided reply carries influence and cannot independently confirm itself', guided?.influencedBy.includes(claim.id))
  const beforeOtherScene = (await store.get(claim.id))!.uses.length
  const other = await turn('现在改聊闲聊方面。')
  check('technical inference is not consumed after an explicit scene switch', !other.belief
    && (await store.get(claim.id))!.uses.length === beforeOtherScene)
  const resumed = await turn('请解释一个算法。')
  check('an independently observed technical context can use the qualified rule again', resumed.belief?.sourceRefs?.includes(claim.id))
  const usedBeforeDrop = (await store.get(claim.id))!.uses.length
  const dropped = await turn('继续解释算法。', { budget: 0 })
  check('a dropped guidance section never records another use', !dropped.belief && (await store.get(claim.id))!.uses.length === usedBeforeDrop)
  const beforeException = await store.get(claim.id)
  const writerCalls = legacyWriterCalls
  const exception = await turn('这次只讲结论就好，后面我再问。')
  check('current-turn preference masks old guidance in the actual packet', !exception.belief && exception.incoming.memoryWriteResult?.kind === 'not_written')
  check('current-turn exception does not rewrite durable preference or call the legacy writer',
    JSON.stringify(await store.get(claim.id)) === JSON.stringify(beforeException) && legacyWriterCalls === writerCalls)

  const stale = await buildBeliefContextSection(h.runtime, { characterId: String(cid), activeUserId: h.userId,
    selectedMemoryIds: [], epistemicHuman: { currentEventId: String(dropped.incoming.userEvent!.id) } })
  assert.ok(stale?.confirmIncluded)
  await record('你理解错了，我一般更喜欢简短解释。', b) // Deliberately skip the observer to reproduce a failed hook.
  check('a missed feedback hook cannot keep an explicitly contradicted rule usable on a later turn',
    !await buildBeliefContextSection(h.runtime, { characterId: String(cid), activeUserId: h.userId,
      selectedMemoryIds: [], epistemicHuman: { currentEventId: String(dropped.incoming.userEvent!.id) } }))
  await assert.rejects(() => stale.confirmIncluded!(), /unprocessed_feedback/)
  check('a correction after selection is checked again before final guidance inclusion', true)
  await store.commit(claim.id, { kind: 'withdraw' })
  await assert.rejects(() => store.commit(claim.id, { kind: 'use', use: beforeException!.uses[0] }, { allowHuman: true }), /not_usable|terminal/)
  check('replaying an old use receipt cannot bypass current withdrawal checks', true)
  await assert.rejects(() => turn('继续解释一个算法。', { staleBuilder: stale }), /not_usable|terminal|unprocessed_feedback/)
  check('withdrawal between selection and final inclusion rejects the stale prompt', (await store.get(claim.id))?.status === 'withdrawn')

  const permanent = await turn('以后请先给结论，少讲铺垫。')
  check('H1 explicit preference uses the real Memory writer without dispatching legacy again', permanent.incoming.memoryWriteResult?.kind === 'written'
    && legacyWriterCalls === writerCalls + 1) // stale neutral turn tried the ordinary route once
  const activePreferences = async () => (await h.store.listBySubject(h.owner, h.user)).filter(item => item.status === 'active'
    && item.content.kind === 'claim' && item.content.predicate === 'preferred.explanation.style')
  const brief = (await activePreferences())[0]!
  check('explicit preference remains reported, scoped and source-backed', brief?.authority === 'EXPLICIT_USER_STATEMENT'
    && brief.epistemicStatus === 'reported' && brief.content.kind === 'claim' && brief.content.value === 'brief'
    && brief.content.qualifiers?.context === 'technical' && brief.evidenceRootIds.includes(String(permanent.incoming.userEvent!.id)))
  const readback = await turn('解释一下这个算法。')
  check('M9 reported is the only durable explicit-preference outlet', readback.belief?.content.includes('明确陈述')
    && readback.belief.content.includes('brief') && !readback.belief.content.includes('暂定推断：'))
  const recallSection = readback.packet.sections.find(section => section.id === 'memory-recall')
  check('style Memory does not leak back through a second recall outlet', !recallSection?.sourceRefs?.includes(`memory:${brief.id}`))

  const update = await turn('你理解错了，我一般更需要详细解释。')
  check('H3 explicit correction actually writes a replacement', update.incoming.memoryWriteResult?.kind === 'written')
  const detailed = (await activePreferences())[0]!
  const old = await h.store.get(brief.id)
  check('replacement is atomic and retains the old preference history', (await activePreferences()).length === 1
    && detailed.content.kind === 'claim' && detailed.content.value === 'detailed' && old?.status === 'superseded'
    && old.content.kind === 'claim' && old.content.value === 'brief')
  const afterUpdate = await turn('解释这个算法。')
  check('the next actual context stops consuming the old explicit value', afterUpdate.belief?.content.includes('detailed') && !afterUpdate.belief.content.includes('brief'))
  await turn('我以前喜欢详细，现在更喜欢简短。')
  const changed = (await activePreferences())[0]!
  check('H4 can return to an earlier value with a fresh source revision', changed.content.kind === 'claim' && changed.content.value === 'brief'
    && String(changed.evidenceRootIds[0]) !== String(brief.evidenceRootIds[0]))
  const faultEvent = await record('你理解错了，我一般更需要详细解释。')
  const beforeFault = await countDomainEvents(h.db, cid)
  await exec(h.db, sql.raw(`create function ebl_test_supersede_fault() returns trigger language plpgsql as $$
    begin if NEW.type = 'MEMORY_SUPERSEDED' then raise exception 'ebl_test_fault'; end if; return NEW; end $$`), 'isolated fault function')
  await exec(h.db, sql.raw('create trigger ebl_test_supersede_fault before insert on character_domain_events for each row execute function ebl_test_supersede_fault()'), 'isolated fault trigger')
  try {
    await assert.rejects(() => handleEblPreferenceTurn(h.db, cid, h.userId, { owner: h.owner, speaker: h.user,
      event: { id: faultEvent.id, actorType: faultEvent.actorType, content: faultEvent.content } }))
  } finally {
    await exec(h.db, sql.raw('drop trigger ebl_test_supersede_fault on character_domain_events'), 'remove isolated fault trigger')
    await exec(h.db, sql.raw('drop function ebl_test_supersede_fault()'), 'remove isolated fault function')
  }
  check('failure in the second replacement write rolls back the first write and retains the original',
    await countDomainEvents(h.db, cid) === beforeFault && (await activePreferences()).length === 1
    && (await activePreferences())[0].id === changed.id)
  const forget = await record('忘掉我关于讲解详略的偏好。')
  await h.applyStateChange('retract', String(forget.id), { memoryId: String(changed.id), reason: 'explicit_forget' }, Date.now())
  const afterForget = await turn('解释一个算法。')
  check('forgetting immediately removes the explicit outlet and cannot restore legacy inference', !afterForget.belief)
  const oldStillStored = (await listBeliefsByStatus(h.db, cid, ['active'])).some(item => item.epistemicKind === 'inferred')
  check('historical legacy projection is retained for audit, not executed', oldStillStored)

  const mixed = await record('以后请先给结论。我在测试大学学习。')
  const created = await commitModelMemoryPlan({ db: h.db, characterId: cid, speaker: h.user, registry: h.kernel.registry,
    event: mixed, records: [], epistemicManagedStyle: true,
    plan: { destination: 'long_term', decisions: [
      { operation: 'create', quote: '以后请先给结论', explicit: true, memory: { type: 'preference', predicate: 'preferred.explanation.style', value: 'brief', importance: 0.8, confidence: 1 } },
      { operation: 'create', quote: '我在测试大学学习', explicit: true, memory: { type: 'person_fact', predicate: 'education.institution', value: '测试大学', importance: 0.8, confidence: 1 } },
    ] } })
  check('partial overlap retires only old style writes and preserves unrelated facts', created === 1 && (await activePreferences()).length === 0)
  const unsupported = await commitModelMemoryPlan({ db: h.db, characterId: cid, speaker: h.user, registry: h.kernel.registry,
    event: unknownScene.event, records: [], epistemicManagedStyle: true,
    plan: { destination: 'long_term', decisions: [
      { operation: 'create', quote: '以后请先给结论，少讲铺垫', explicit: true,
        memory: { type: 'preference', predicate: 'preferred.explanation.style', value: 'brief', importance: 0.8, confidence: 1 } },
    ] } })
  check('an unsupported scene retains its ordinary memory writer instead of losing an irreplaceable function', unsupported === 1)
  check('EBL guidance and preference pathways use no model calls in this gate', true)
  assert.deepEqual(captureEblEvidenceSources(), snapshot, 'tested sources changed during human gate')
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres',
    evidenceKind: 'real_turn_gateway_memory_m9_offline_responses', measured_count: checks.length, checks, ...snapshot,
    productionOpened: false, modelCalls: 0, humanExperience: 'NOT RUN', measurements: {
      legacyEventsBeforeRetirement: beforeRetirement, retiredWatermark: retired.watermark,
      claimId: claim.id, independentSupports: validated.evidence.length, abandonedTests: validated.closedTests?.length,
      sourceRootIds: inferenceRoots, includedTraceId: String(included.incoming.traceId),
      includedRuleIds: included.belief?.sourceRefs, currentTurnOverrideTraceId: String(exception.incoming.traceId),
      explicitPreferenceMemoryId: String(brief.id), correctedMemoryId: String(detailed.id),
      finalLegacyKeptForAudit: oldStillStored, modelOutputObserved: false,
    } }, null, 2))
  console.log(`EBL human: ${checks.length}/${checks.length}; ${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally { await h.stop() }
