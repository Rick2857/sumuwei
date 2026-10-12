/** 定向修复的离线复现；不替代 Lv2 的 144 案轮与正式联合门。 */
import 'dotenv/config'
import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
isolateDatabase('lv2-repair', { keep: false })

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyCommitmentClaimGuard, commitmentWriteFacts } from '../src/kernel/app/goal/claim-guard.ts'
import { getWatermark, listJobs } from '../src/infrastructure/persistence/job-store.ts'
import { latestAgreementSequence } from '../src/infrastructure/persistence/agreement-input-source.ts'
import { AGREEMENT_PROCESSOR, AGREEMENT_PROCESSOR_VERSION } from '../src/infrastructure/runtime/agreement-scheduler.ts'
import { createLv2CaseEnvironment, evaluateAssertion } from './lv2-harness.ts'
import { LV2_SHORT_CASES } from '../evals/lv2/short-cases.ts'
import { deterministicRuntime } from './m10-harness.ts'
import { runAgreementWindow } from '../src/infrastructure/runtime/agreement-runner.ts'
import { AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION } from '../src/kernel/contracts/agreement-model-draft.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'
import { validateGoalProposalDraft, GOAL_PROPOSAL_SCHEMA_VERSION } from '../src/kernel/contracts/goal-proposal.ts'
import { sql } from 'drizzle-orm'
import { computeWithdrawnEvidence } from '../src/infrastructure/persistence/withdrawn-evidence.ts'
import { lexicalOverlapHits } from '../src/kernel/app/memory/target-resolver.ts'

const checks: { id: string; pass: boolean }[] = []
const check = (id: string, pass: boolean): void => {
  checks.push({ id, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}`)
}
const started = new Date().toISOString()
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
let conversations = 0
const observeConversations = async (db: typeof env.h.db) => {
  const result = await db.execute(sql`select count(distinct conversation_id)::int as count from conversation_events`)
  const rows = Array.isArray(result) ? result : (result as { rows?: { count: number }[] }).rows ?? []
  conversations += Number((rows[0] as { count: number })?.count ?? 0)
}
const shortAcceptance = '行。'
const longProposal = '先把两份资料并列，再逐项标出新增与删减，最后确认差异。'
const adoptionDraft = { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'create', span: { start: 0, end: 2 },
  statement: '并列核对资料并确认差异', origin: 'character_proposed', proposedByAssistantEventId: 'cev:proposal',
  proposalSpan: { start: 0, end: [...longProposal].length } }
const adoptionInput = { sourceText: shortAcceptance, proposalSourceText: longProposal, candidateGoalIds: [] }
check('long_proposal_short_acceptance_uses_separate_source_bounds', validateGoalProposalDraft(adoptionDraft, adoptionInput).ok)
check('proposal_reference_beyond_proposal_is_rejected', !validateGoalProposalDraft({ ...adoptionDraft,
  proposalSpan: { start: 0, end: [...longProposal].length + 1 } }, adoptionInput).ok)
check('acceptance_reference_beyond_acceptance_is_rejected', !validateGoalProposalDraft({ ...adoptionDraft,
  span: { start: 0, end: 3 } }, adoptionInput).ok)
const replyText = '嗯。记下了。'
const goalOnly = {
  commitmentWritten: false, anythingWritten: true, goalCreated: true, replyText,
}
const unwrittenAgreement = applyCommitmentClaimGuard(goalOnly)
check('goal_creation_does_not_confirm_commitment', unwrittenAgreement.corrected && !unwrittenAgreement.allowedSuccess)
check('goal_only_correction_acknowledges_existing_record', unwrittenAgreement.corrected && unwrittenAgreement.replyText.includes('目标记录'))
const preservedProposal = applyCommitmentClaimGuard({ ...goalOnly, replyText: '明天十点楼下见。记下了。' })
check('fresh_goal_proposal_survives_claim_correction', preservedProposal.corrected && preservedProposal.replyText.includes('明天十点楼下见') && !preservedProposal.replyText.includes('记下了'))
check('memory_confirmation_is_preserved', !applyCommitmentClaimGuard({ commitmentWritten: false, anythingWritten: true, replyText }).corrected)
check('unwritten_remember_claim_is_corrected', applyCommitmentClaimGuard({ commitmentWritten: false, anythingWritten: false, replyText: '嗯。记住了。' }).corrected)
check('negated_confirmation_is_preserved', !applyCommitmentClaimGuard({ ...goalOnly, replyText: '这次没记下了。' }).corrected)
check('accepted_commitment_restores_confirmation', !applyCommitmentClaimGuard({ ...goalOnly, commitmentWritten: true }).corrected)
const acceptedEventTypes = ['GOAL_CREATED', 'COMMITMENT_ACCEPTED']
const failedCommit = commitmentWriteFacts({ acceptedEventTypes, eventsCommitted: 0 })
check('validation_without_commit_does_not_allow_confirmation', !failedCommit.commitmentWritten && !failedCommit.goalCreated &&
  applyCommitmentClaimGuard({ ...failedCommit, anythingWritten: false, replyText }).corrected)
const restoredCommit = commitmentWriteFacts({ acceptedEventTypes, eventsCommitted: 2 })
check('committed_events_restore_confirmation', !applyCommitmentClaimGuard({ ...restoredCommit, anythingWritten: true, replyText }).corrected)

const extractor = createRuleOnlyContentExtractor()
for (const [id, text, expected] of [
  ['device-positive', '我刚才说错了，还是 Windows。', 'Windows'],
  ['device-linux-positive', '更正一下，还是 Linux。', 'Linux'],
  ['device-abandon-negative', '我刚才说错了，还是算了。', null],
  ['device-bare-negative', '还是 Windows。', null],
  ['device-question-negative', '我刚才说错了，还是 Windows 吗？', null],
  ['device-ambiguous-negative', '我刚才说错了，还是 Windows 或 Linux。', null],
  ['device-recovery', '我刚才说错了，还是 Windows。', 'Windows'],
] as const) {
  const result = await extractor.extract({ text, owner: entityRef('character', 'repair-character'), speaker: entityRef('user', 'repair-user') })
  check(id, expected === null ? result === undefined : result?.content.kind === 'claim' && result.content.value === expected)
}
const strippedCorrection = await extractor.extract({ text: '还是 Windows。', correctionSourceText: '我刚才说错了，还是 Windows。',
  owner: entityRef('character', 'repair-character'), speaker: entityRef('user', 'repair-user') })
check('stripped_correction_keeps_qualified_original_marker', strippedCorrection?.content.kind === 'claim' && strippedCorrection.content.value === 'Windows')
let cleanClose = false
const env = await createLv2CaseEnvironment({ label: 'lv2-repair-slow', conversationId: 'lv2-repair-slow', control: true, slowPath: true })
try {
  await env.prepare(LV2_SHORT_CASES.find(row => row.caseId === 'C08-06')!.prep)
  const cutover = await latestAgreementSequence(env.h.db, env.h.kernel.characterId)
  const first = await env.runTurn('我们再约一次：明天十点楼下见。', { control: true, turnIndex: 1 })
  check('first_turn_consumes_after_startup_cutover', first.completed && first.slowPath?.kind === 'ran' && first.slowPath.result === 'no_agreement' && first.slowPath.modelCalls === 0)
  const jobs = await listJobs(env.h.db, env.h.kernel.characterId)
  check('cutover_preserves_prep_history', cutover > 0 && jobs.some(job => job.sourceFromSequence === cutover))
  check('control_path_makes_zero_model_requests', first.modelRequests === 0)
  const watermark = await getWatermark(env.h.db, env.h.kernel.characterId, AGREEMENT_PROCESSOR, AGREEMENT_PROCESSOR_VERSION)
  check('consumed_watermark_matches_conversation_tail', watermark?.processedThroughSequence === await latestAgreementSequence(env.h.db, env.h.kernel.characterId))
  const second = await env.runTurn('先这样。', { control: true, turnIndex: 2 })
  check('second_turn_still_consumes', second.completed && second.slowPath?.kind === 'ran')
} finally {
  await observeConversations(env.h.db)
  await env.close()
  cleanClose = true
}
await resetPluginSqlConnection()
isolateDatabase('lv2-repair-duplicate', { keep: false })
const duplicateEnv = await createLv2CaseEnvironment({ label: 'lv2-repair-duplicate', conversationId: 'lv2-repair-duplicate', control: true })
try {
  const text = '我们再约一次：明天十点楼下见，一起核对旧提纲。'
  const user = await duplicateEnv.h.recordUserEvidence(text)
  const accepted = await duplicateEnv.goals.turn({ currentInput: text, sourceEventId: String(user.event.id), now: Date.now(), runtime: deterministicRuntime(),
    provider: { name: 'repair-positive', version: 'offline@1', async call() { return {
      schemaVersion: 'goal-proposal@1', operation: 'create', span: { start: 0, end: [...text].length },
      statement: '明天十点楼下见，一起核对旧提纲', origin: 'user_requested',
      commitment: { scope: '一起核对旧提纲', criterion: { kind: 'user_report' } },
    } } },
  })
  check('duplicate_positive_fast_acceptance_is_written', accepted.trace.event.acceptedEventTypes.includes('COMMITMENT_ACCEPTED'))
  const reply = '行，明天十点楼下见，一起核对旧提纲。'
  const assistant = await duplicateEnv.h.recorder.recordAssistantMessage({ text: reply, conversationSequence: 2,
    characterSequence: user.assistantSequence, replyToEventId: user.event.id })
  const entries = [
    { id: String(user.event.id), actorType: 'user' as const, sequence: 1, text },
    { id: String(assistant!.id), actorType: 'character' as const, sequence: 2, text: reply },
  ]
  const provider = { name: 'repair-agreement', version: 'offline@1', async call() { return {
    schemaVersion: AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION, kind: 'mutual_agreement',
    content: '明天十点楼下见，一起核对旧提纲', criterion: '一起核对旧提纲', proposedBySeq: 1, acceptedBySeq: 2,
  } } }
  const run = () => runAgreementWindow(duplicateEnv.h.db, { characterId: duplicateEnv.h.kernel.characterId,
    activeUserId: duplicateEnv.h.userId, entries, provider, signal: new AbortController().signal, now: Date.now() })
  await run()
  check('one_user_acceptance_is_not_written_twice_across_paths', (await duplicateEnv.goals.listStates()).filter(row => row.commitment !== null).length === 1)
  entries.push({ id: 'cev:unrelated', actorType: 'user', sequence: 3, text: '另外一件事。' })
  await run()
  check('changed_window_does_not_reaccept_same_evidence', (await duplicateEnv.goals.listStates()).filter(row => row.commitment !== null).length === 1)
} finally { await observeConversations(duplicateEnv.h.db); await duplicateEnv.close() }
for (const caseId of ['C03-01', 'C03-04', 'C03-06', 'C04-04', 'C05-02', 'C08-02']) {
  await resetPluginSqlConnection()
  isolateDatabase(`lv2-repair-${caseId}`, { keep: false })
  const one = LV2_SHORT_CASES.find(row => row.caseId === caseId)!
  const probe = await createLv2CaseEnvironment({ label: `repair-${caseId}`, conversationId: `repair-${caseId}`, control: true })
  try {
    const sourceEventIds = await probe.prepare(one.prep)
    const before = await probe.snapshot()
    check(`${caseId}_frozen_preconditions`, one.precondition.every(assertion => evaluateAssertion(assertion, before, {
      beforeEventTypes: before.eventTypes, beforeCommitmentRows: before.commitments.length, sourceEventIds,
      identityFingerprint: '', beforeIdentityFingerprint: '',
    }).pass))
    if (caseId === 'C08-02') {
      const text = one.turns[0]!
      const source = await probe.h.recordUserEvidence(text)
      const row = (await probe.goals.listStates()).find(state => state.commitment?.status === 'active')!
      await probe.goals.turn({ currentInput: text, sourceEventId: String(source.event.id), now: Date.now(), runtime: deterministicRuntime(),
        provider: { name: 'repair-cancel', version: 'offline@1', async call() { return { schemaVersion: 'goal-proposal@1', operation: 'cancel',
          span: { start: 0, end: [...text].length }, targetGoalId: String(row.goal.goalId), cancelKind: 'user_waived' } } } })
      check('cancel_goal_also_emits_explicit_commitment_cancellation', (await probe.goals.listStates())[0]?.commitment?.status === 'cancelled')
    } else {
      const turn = await probe.runTurn(one.turns[0]!, { control: true, turnIndex: 1 })
      if (caseId === 'C04-04') {
        const after = await probe.snapshot()
        check('marked_device_reversion_preserves_active_value', one.expect.every(assertion => evaluateAssertion(assertion, after, { beforeEventTypes: before.eventTypes,
          beforeCommitmentRows: before.commitments.length, sourceEventIds: {}, identityFingerprint: '', beforeIdentityFingerprint: '' }).pass))
      } else if (caseId === 'C05-02') {
        const records = await probe.h.store.listBySubject(probe.h.owner, probe.h.user)
        const episode = records.find(row => row.type === 'episode')
        check('derived_episode_reuses_original_forgotten_root', episode?.sourceRefs.some(ref => ref.id === sourceEventIds['记住，我的实验室在 A 楼 302。']) === true &&
          turn.prompt.includes('302') === false && turn.sectionIds.includes('memory-recall') === false)
        const renewed = await probe.runTurn('记住，我的实验室在 A 楼 302。', { control: true, turnIndex: 2 })
        const recalled = await probe.runTurn('我的实验室在哪？', { control: true, turnIndex: 3 })
        const renewedRows = await probe.h.store.listBySubject(probe.h.owner, probe.h.user)
        const renewedFact = renewedRows.find(row => row.type === 'person_fact' && row.status === 'active')
        check('new_confirmation_uses_new_root_and_remains_recallable', renewed.completed &&
          renewedFact?.sourceRefs.every(ref => ref.id !== sourceEventIds['记住，我的实验室在 A 楼 302。']) === true &&
          recalled.sectionIds.includes('memory-recall') && recalled.prompt.includes('302'))
      } else {
        check(`${caseId}_native_recall_qualification_and_context`, turn.sectionIds.includes('memory-recall') === (caseId === 'C03-01'))
      }
    }
  } finally { await observeConversations(probe.h.db); await probe.close() }
}
await resetPluginSqlConnection()
isolateDatabase('lv2-repair-withdrawn-read', { keep: false })
let withdrawalFault: 'none' | 'throw' | 'incomplete' = 'none'
let withdrawalReads = 0
const withdrawalProbe = await createLv2CaseEnvironment({ label: 'lv2-repair-withdrawn-read', conversationId: 'lv2-repair-withdrawn-read', control: true,
  withdrawnCompute: async () => {
    withdrawalReads += 1
    if (withdrawalFault === 'throw') throw new Error('withdrawn_control_read_failed')
    const result = await computeWithdrawnEvidence(withdrawalProbe.h.db, withdrawalProbe.h.store, withdrawalProbe.h.owner)
    return withdrawalFault === 'incomplete' ? { ...result, ok: false, gaps: ['withdrawn_control_incomplete'] } : result
  },
})
try {
  await withdrawalProbe.prepare([{ kind: 'seed_memory', memoryType: 'episode', sourceText: '昨天我在实验室做了光学实验。' }])
  await withdrawalProbe.prepare([
    { kind: 'seed_memory', memoryType: 'person_fact', predicate: 'education.major', value: '计算机', sourceText: '我学计算机。' },
    { kind: 'seed_memory', memoryType: 'person_fact', predicate: 'education.institution', value: '示例工程科技大学', sourceText: '我在示例工程科技大学。' },
  ])
  const educationRows = (await withdrawalProbe.h.store.listBySubject(withdrawalProbe.h.owner, withdrawalProbe.h.user)).filter(row => row.type === 'person_fact')
  check('education_surfaces_do_not_match_generic_identity_question', lexicalOverlapHits('我的名字是什么？', educationRows).length === 0)
  const run = (turnIndex: number) => withdrawalProbe.runTurn('我昨天在实验室做了什么？', { control: true, turnIndex })
  const normal = await run(1)
  check('available_episode_with_live_source_is_recalled', normal.sectionIds.includes('memory-recall') && normal.prompt.includes('光学实验'))
  withdrawalFault = 'throw'
  const failed = await run(2)
  check('withdrawn_read_failure_suppresses_recall_and_reports_failure', !failed.sectionIds.includes('memory-recall') && failed.prompt.includes('本轮记忆召回失败'))
  withdrawalFault = 'incomplete'
  const incomplete = await run(3)
  check('incomplete_withdrawn_set_suppresses_recall_and_reports_failure', !incomplete.sectionIds.includes('memory-recall') && incomplete.prompt.includes('本轮记忆召回失败'))
  withdrawalFault = 'none'
  const restored = await run(4)
  check('restored_withdrawn_read_recovers_without_rewriting_memory', restored.sectionIds.includes('memory-recall') && restored.prompt.includes('光学实验'))
  check('withdrawn_set_is_read_once_per_compiled_turn', withdrawalReads === 4)
} finally { await observeConversations(withdrawalProbe.h.db); await withdrawalProbe.close() }
const runId = createLv2RunId({ wpId: 'wp2-repair', headShort: head })
const dir = openLv2RunDir(process.cwd(), runId)
const failed = checks.filter(row => !row.pass).length
writeFileSync(join(dir, 'checks.json'), `${JSON.stringify({ runId, checks, cleanClose, modelCalls: 0 }, null, 2)}\n`)
const paths = ['scripts/lv2-repair-verify.ts', 'scripts/lv2-harness.ts', 'evals/lv2/short-cases.ts', 'src/kernel/app/goal/claim-guard.ts',
  'src/infrastructure/runtime/agreement-runner.ts', 'src/kernel/contracts/goal-proposal.ts', 'src/kernel/app/goal/understanding.ts',
  'src/kernel/app/goal/turn.ts', 'src/kernel/contracts/memory-predicates.ts', 'src/kernel/app/memory/content-extractor.ts',
  'src/kernel/app/memory/explicit-service.ts', 'src/kernel/context/sections.ts', 'src/infrastructure/model/openai-goal-understanding.ts']
paths.push('src/kernel/app/turn-gateway.ts', 'src/kernel/app/recall/retrieval.ts', 'src/kernel/app/recall/turn.ts', 'src/kernel/recall/eligibility.ts',
  'src/infrastructure/persistence/withdrawn-evidence.ts')
writeLv2Manifest(dir, {
  runId, wp: 'wp2-repair', head, headShort: head.slice(0, 12),
  branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
  toolVersions: { node: process.version }, testType: 'targeted-repair-controls',
  counts: { total: checks.length, passed: checks.length - failed, failed }, phases: ['offline'],
  supersedes: null, started, ended: new Date().toISOString(),
  worktree: { clean: false, lines: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().split(/\r?\n/), note: '修复候选；不作为正式发布证据' },
  sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  config: { slowPath: true, control: true },
  model: { providerKind: 'scripted-offline', totalRequests: 0 },
  requests: { planned: 0, actual: 0 }, denominators: { checks: checks.length, nativeUserTurns: 15, isolatedFixtures: 9 },
  correlations: { cases: 9, conversations, requests: 0, traces: 13 }, faultInjection: 'withdrawn_read_throw;withdrawn_set_incomplete（仅具名离线控制）', cleanClose,
  realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: 'isolateDatabase；仅打开实验库' },
  verdict: failed === 0 ? 'PASS' : 'FAIL',
})
console.log(`runId=${runId} checks=${checks.length} failed=${failed} modelCalls=0 cleanClose=${cleanClose}`)
process.exitCode = failed === 0 ? 0 : 1
