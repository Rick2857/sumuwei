import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m11.1-baseline', { keep: false })

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { createM4Harness, M4_T0 } from './m4-harness.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'
import { runReflectionWindow, REFLECTION_PROCESSOR_VERSION } from '../src/infrastructure/runtime/reflection-runner.ts'
import { maybeRunReflectionEvaluation, REFLECTION_PROCESSOR } from '../src/infrastructure/runtime/reflection-scheduler.ts'
import { latestDomainEventSequence, readReflectionWindowEvents } from '../src/infrastructure/persistence/reflection-input-source.ts'
import { appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { listReflectionRecords } from '../src/infrastructure/persistence/reflection-store.ts'
import { listAdaptiveSelfStates } from '../src/infrastructure/persistence/adaptive-self-store.ts'
import { getWatermark, advanceWatermark, listJobs } from '../src/infrastructure/persistence/job-store.ts'
import { createReflectionLineageLookup } from '../src/infrastructure/persistence/reflection-lineage-read.ts'
import { expandLineage } from '../src/kernel/app/reflection/lineage.ts'
import { createLateWriteFence } from '../src/kernel/app/reflection/late-write-fence.ts'
import { renderAdaptiveSelfSection } from '../src/kernel/context/adaptive-self-sections.ts'
import { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } from '../src/kernel/contracts/reflection.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'
import { createOpenAiReflectionDraftProvider } from '../src/infrastructure/model/openai-reflection.ts'
import { computeWithdrawnEvidence } from '../src/infrastructure/persistence/withdrawn-evidence.ts'

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const findings: { id: string; caseId: string; status: string; observed: unknown }[] = []
const controls: { caseId: string; pass: boolean; observed: unknown }[] = []
let clock = M4_T0
const started = new Date().toISOString()
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

async function main(): Promise<void> {
  // This is a before-fix reproduction, not a gate for corrected source.
  const frozen = JSON.parse(readFileSync('artifacts/m11.1/m11-m111-wp0-20261002-9b6ccd88285e-3fcb/manifest.json', 'utf8')) as { sourceFingerprints: Record<string, string> }
  for (const path of ['src/infrastructure/runtime/reflection-runner.ts', 'src/infrastructure/runtime/reflection-scheduler.ts', 'src/infrastructure/model/openai-reflection.ts', 'src/main.ts']) {
    if (hash(path) !== frozen.sourceFingerprints[path]) throw new Error(`Historical reproduction requires the frozen before-fix source: ${path}; read the saved WP0 run or use m11.1:wiring:verify for current source.`)
  }
  const h = await createM4Harness({ label: 'm111-baseline' })
  const characterId = h.kernel.characterId
  let lastCall: ReflectionDraftCall | undefined
  let targetSlot = 'clarify_when_ambiguous'
  const provider = {
    name: 'm111-offline-reproduction', version: 'm111-repro@1',
    async call(call: ReflectionDraftCall) {
      lastCall = call
      return {
        schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
        focusQuestion: '对象不明确时是否应先核对？', explanation: '独立反馈的候选解释。',
        supportHandles: call.handles.map(handle => handle.id), counterHandles: [],
        scope: REFLECTION_DRAFT_SCOPE, suggestedSlot: targetSlot,
      }
    },
  }
  async function seed(caseId: string, roots: number, sessions: number, triggers = 1) {
    const watermark = await latestDomainEventSequence(h.db, characterId)
    const ids: string[] = []
    const recorders = Array.from({ length: sessions }, (_, session) => new ConversationRecorder({
      db: h.db, characterId, conversationId: asConversationId(`${caseId}-session-${session}`),
      dryRun: false, userId: h.userId, userName: 'Alex', characterName: '苏沐薇', transport: 'm111-repro',
      attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    }))
    for (let i = 0; i < roots; i++) {
      const evidence = await recorders[i % sessions]!.recordUserMessage('隔离复现：对象不明确时请先核对。', Math.floor(i / sessions) + 1)
      ids.push(String(evidence.event!.id))
    }
    for (let i = 0; i < triggers; i++) {
      await appendDomainEvent(h.db, characterId, {
        type: 'GOAL_COMPLETED', operation: 'm111-repro-trigger',
        payload: { goalId: `goal:${caseId}:${i}`, basis: 'user_report', expectedRevision: 1 },
        sourceConversationEventIds: ids as never,
        idempotencyKey: `m111:${caseId}:${i}`, processor: 'm111-repro', processorVersion: 'm111-repro@1', scope: 'CHARACTER_INTERNAL',
      }, ++clock)
    }
    return { watermark, ids }
  }
  async function runCase(caseId: string, roots: number, sessions: number, triggers = 1, extras = {}) {
    const fixture = await seed(caseId, roots, sessions, triggers)
    const outcome = await runReflectionWindow(h.db, { characterId, watermark: fixture.watermark, provider, now: () => ++clock, ...extras })
    const actual = await expandLineage(createReflectionLineageLookup(h.db, { characterId }), lastCall!.handles, { characterId: String(characterId) })
    return { outcome, actualRoots: actual.roots.map(root => root.id), rootCount: actual.rootCount, conversationCount: actual.conversationCount, fixture }
  }
  let cleanClose = false
  try {
    const positive = await runCase('positive', 3, 2)
    controls.push({ caseId: 'positive', pass: positive.outcome.kind === 'accepted' && positive.rootCount === 3 && positive.conversationCount === 2, observed: positive })
    const same = await runCase('same-root', 1, 1, 3)
    const single = await runCase('single-session', 3, 1)
    findings.push({ id: 'F01', caseId: 'same-root-and-single-session', status: same.outcome.kind === 'accepted' || single.outcome.kind === 'accepted' ? 'REPRODUCED' : 'NOT REPRODUCED', observed: { same, single } })
    const unread = await runCase('missing-qualification', 3, 2)
    findings.push({ id: 'F02', caseId: 'missing-qualification', status: unread.outcome.kind === 'accepted' ? 'REPRODUCED' : 'NOT REPRODUCED', observed: { outcome: unread.outcome, providedQualificationReadings: 0 } })
    const recovery = await runCase('explicit-unusable-control', 3, 2, 1, { allSourcesUnusableReason: 'source_retracted' })
    controls.push({ caseId: 'explicit-unusable-control', pass: recovery.outcome.kind === 'rejected', observed: recovery.outcome })
    const states = await listAdaptiveSelfStates(h.db, characterId)
    const enhanced = states.find(state => state.level === 'enhanced')!
    const sourceMemory = await h.commitAndFold(h.makeCandidate('person_fact', {
      kind: 'claim', subject: h.user, predicate: 'm111.fixture.preference', value: '先核对对象',
    } as never, { sourceRefs: [{ kind: 'conversation_event', id: positive.fixture.ids[0]! }] }), ++clock)
    if (sourceMemory === null) throw new Error('F03 positive memory fixture was rejected')
    const forget = await h.recordUserEvidence('忘掉刚才那条核对对象的偏好。')
    await h.applyStateChange('retract', String(forget.event.id), { memoryId: sourceMemory.id, reason: 'explicit_forget' }, ++clock)
    const withdrawn = await computeWithdrawnEvidence(h.db, h.store, h.owner)
    if (!withdrawn.withdrawnEventIds.includes(positive.fixture.ids[0]!)) throw new Error('F03 withdrawn oracle did not mark source')
    const sections = renderAdaptiveSelfSection({ states: await listAdaptiveSelfStates(h.db, characterId), maxTokens: 300, quantify: text => [...text].length })
    findings.push({ id: 'F03', caseId: 'production-read-after-source-invalidation', status: sections.some(section => section.id === 'adaptive-self') ? 'REPRODUCED' : 'NOT REPRODUCED', observed: { sourceInvalidationPersisted: true, withdrawnRoots: withdrawn.withdrawnEventIds, injectedRefs: sections.flatMap(section => section.sourceRefs ?? []), limitation: 'Production list/render callback reproduced; full gateway filtering follows WP2.' } })
    targetSlot = 'acknowledge_correction_first'
    const beforeRevision = states.find(state => state.slot === targetSlot)!.revision
    const off = await runCase('adaptive-off-production-arguments', 3, 2)
    const afterRevision = (await listAdaptiveSelfStates(h.db, characterId)).find(state => state.slot === targetSlot)!.revision
    findings.push({ id: 'F04', caseId: 'adaptive-off-production-arguments', status: afterRevision > beforeRevision ? 'REPRODUCED' : 'NOT REPRODUCED', observed: { outcome: off.outcome, beforeRevision, afterRevision, adaptiveFlagPassedByMain: false } })
    const formatFixture = await seed('format-invalid', 3, 2)
    await advanceWatermark(h.db, characterId, REFLECTION_PROCESSOR, REFLECTION_PROCESSOR_VERSION, formatFixture.watermark, ++clock)
    const schedule = await maybeRunReflectionEvaluation(h.db, {
      characterId, processorVersion: REFLECTION_PROCESSOR_VERSION, cutoverSequence: formatFixture.watermark, now: ++clock,
      ports: {
        latestSequence: () => latestDomainEventSequence(h.db, characterId),
        readWindow: (from, latest) => readReflectionWindowEvents(h.db, characterId, from, latest, 50),
        async run(window) {
          // Exactly the main callback's return shape: runner outcome is logged then discarded.
          await runReflectionWindow(h.db, { characterId, watermark: window.fromSequence, provider: { ...provider, async call() { return 'not-json' } } })
        },
      },
    })
    const watermark = await getWatermark(h.db, characterId, REFLECTION_PROCESSOR, REFLECTION_PROCESSOR_VERSION)
    findings.push({ id: 'F05', caseId: 'format-invalid-scheduler', status: schedule.kind === 'ran' && watermark!.processedThroughSequence > formatFixture.watermark ? 'REPRODUCED' : 'NOT REPRODUCED', observed: { schedule, beforeWatermark: formatFixture.watermark, afterWatermark: watermark?.processedThroughSequence, jobs: (await listJobs(h.db, characterId)).map(job => ({ id: job.id, status: job.status })) } })
    const fence = createLateWriteFence()
    const lateFixture = await seed('late-return', 3, 2)
    const eventCount = (await domainEventsFor(h.db, characterId)).length
    await runReflectionWindow(h.db, {
      characterId, watermark: lateFixture.watermark,
      provider: { ...provider, async call(call) { fence.close(); return provider.call(call) } },
    })
    const lateWrites = (await domainEventsFor(h.db, characterId)).length - eventCount
    const bodyProvider = createOpenAiReflectionDraftProvider({
      env: { OPENAI_API_KEY: 'synthetic-offline-key' }, timeoutMs: 10,
      fetchImpl: async (_url, init) => ({
        ok: true, status: 200,
        async json() {
          await new Promise(resolve => setTimeout(resolve, 40))
          return { choices: [{ message: { content: JSON.stringify({ aborted: (init!.signal as AbortSignal).aborted }) } }] }
        },
      }) as Response,
    })
    const body = await bodyProvider.call(lastCall!)
    findings.push({ id: 'F06', caseId: 'late-return-and-slow-body', status: lateWrites > 0 || (body as { aborted: boolean }).aborted === false ? 'REPRODUCED' : 'NOT REPRODUCED', observed: { lateWrites, fenceClosed: fence.closed, bodyResult: body, configuredDeadlineMs: 10 } })
    const semantic = readFileSync('scripts/m11-semantic-eval.ts', 'utf8')
    const thresholds = { format90: semantic.includes('metrics.formatValidRate >= 0.9'), recall90: semantic.includes('rejectionRecall >= 0.9'), worstRoundOnlyCounts: semantic.includes('perRoundFormat.length === rounds') }
    findings.push({ id: 'F07', caseId: 'threshold-contract-comparison', status: Object.values(thresholds).every(Boolean) ? 'CONFIRMED CONTRACT MISMATCH' : 'RECHECK REQUIRED', observed: thresholds })
    const sorted = ['refl:9', 'refl:10'].sort()
    const oldSlice = sorted.slice(1)
    const records = await listReflectionRecords(h.db, characterId)
    findings.push({ id: 'F08', caseId: 'lexical-order-cumulative-revision-and-sessions', status: oldSlice[0] !== 'refl:10' ? 'REPRODUCED' : 'NOT REPRODUCED', observed: { oldSlice, identityDifference: ['refl:10'], refusalAdjustmentReportedByOldAlgorithm: afterRevision, refusalEventsWritten: recovery.outcome.eventsWritten, templateSessions: 2, actualSingleCaseSessions: single.conversationCount, recordsMeasured: records.length } })
  } finally {
    await h.stop()
    cleanClose = true
  }
  const runId = createM11RunId({ wpId: 'm111-wp0', headShort: head })
  const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  const sources = ['src/infrastructure/runtime/reflection-runner.ts', 'src/infrastructure/runtime/reflection-scheduler.ts', 'src/infrastructure/model/openai-reflection.ts', 'src/main.ts', 'scripts/m11-review-materials.ts', 'scripts/m11-semantic-eval.ts', 'scripts/m11.1-baseline-verify.ts']
  writeFileSync(join(dir, 'reproductions.json'), JSON.stringify({ findings, controls }, null, 2) + '\n')
  writeM11Manifest(dir, {
    runId, wp: 'M11.1-WP0', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version }, testType: 'baseline-reproduction', phases: ['before'], supersedes: null,
    counts: { total: controls.length + findings.length, passed: controls.filter(control => control.pass).length + findings.filter(f => f.status === 'REPRODUCED' || f.status === 'CONFIRMED CONTRACT MISMATCH').length, failed: controls.filter(control => !control.pass).length },
    started, ended: new Date().toISOString(), cleanClose, environment: 'isolated-synthetic-fixtures', modelRequests: 0, sourceFingerprints: Object.fromEntries(sources.map(path => [path, hash(path)])), capabilityImpact: 'NONE',
    limitation: 'Baseline observations prove defects, not corrected production behavior. F07 is static contract mismatch; F08 consumer-algorithm counterexamples.',
  })
  console.log(JSON.stringify({ runId, controls, findings: findings.map(({ id, status }) => ({ id, status })), cleanClose }, null, 2))
  process.exit(controls.every(control => control.pass) ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
