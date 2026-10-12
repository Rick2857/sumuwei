import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m111-recovery', { keep: false })
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createM4Harness, M4_T0 } from './m4-harness.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'
import { createLateWriteFence } from '../src/kernel/app/reflection/late-write-fence.ts'
import { runReflectionWindow, REFLECTION_PROCESSOR_VERSION } from '../src/infrastructure/runtime/reflection-runner.ts'
import { maybeRunReflectionEvaluation, REFLECTION_PROCESSOR, recoverRunningReflectionJobs } from '../src/infrastructure/runtime/reflection-scheduler.ts'
import { latestDomainEventSequence, readReflectionWindowEvents } from '../src/infrastructure/persistence/reflection-input-source.ts'
import { appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { advanceWatermark, getWatermark, listJobs } from '../src/infrastructure/persistence/job-store.ts'
import { createOpenAiReflectionDraftProvider } from '../src/infrastructure/model/openai-reflection.ts'
import { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } from '../src/kernel/contracts/reflection.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'
import type { RawDb } from '../src/infrastructure/persistence/db.ts'

const checks: { caseId: string; pass: boolean; observed: unknown }[] = []
const check = (caseId: string, pass: boolean, observed: unknown) => checks.push({ caseId, pass, observed })
const started = new Date().toISOString()
async function main() {
  const h = await createM4Harness({ label: 'm111-recovery' })
  const characterId = h.kernel.characterId
  let clock = M4_T0
  let cleanClose = false
  const source = await h.recordUserEvidence('隔离恢复用来源。')
  const watermark = await latestDomainEventSequence(h.db, characterId)
  await appendDomainEvent(h.db, characterId, { type: 'GOAL_COMPLETED', operation: 'm111-recovery-trigger', payload: { goalId: 'goal:recovery', basis: 'user_report', expectedRevision: 1 }, sourceConversationEventIds: [source.event.id], idempotencyKey: 'm111-recovery:trigger', processor: 'm111-recovery', processorVersion: 'm111-recovery@1', scope: 'CHARACTER_INTERNAL' }, ++clock)
  let lastCall: ReflectionDraftCall | undefined
  let calls = 0
  let invalid = true
  const provider = { name: 'm111-recovery-offline', version: 'm111-recovery@1', async call(call: ReflectionDraftCall) {
    lastCall = call; calls++
    return invalid ? 'broken-json' : { schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION, focusQuestion: '是否有足够支持？', explanation: '一个来源尚不足。', supportHandles: call.handles.map(handle => handle.id), counterHandles: [], scope: REFLECTION_DRAFT_SCOPE }
  } }
  const ports = {
    latestSequence: () => latestDomainEventSequence(h.db, characterId),
    readWindow: (from: number, latest: number) => readReflectionWindowEvents(h.db, characterId, from, latest, 50),
    run: (window: { fromSequence: number }) => runReflectionWindow(h.db, { characterId, watermark: window.fromSequence, provider, adaptiveEnabled: true }),
  }
  try {
    await advanceWatermark(h.db, characterId, REFLECTION_PROCESSOR, REFLECTION_PROCESSOR_VERSION, watermark, ++clock)
    const failed = await maybeRunReflectionEvaluation(h.db, { characterId, processorVersion: REFLECTION_PROCESSOR_VERSION, cutoverSequence: watermark, ports, now: ++clock })
    const failedWatermark = await getWatermark(h.db, characterId, REFLECTION_PROCESSOR, REFLECTION_PROCESSOR_VERSION)
    check('format-failed-no-watermark', failed.kind === 'failed' && failedWatermark!.processedThroughSequence === watermark && calls === 1, { failed, watermark: failedWatermark?.processedThroughSequence, calls })
    const deferred = await maybeRunReflectionEvaluation(h.db, { characterId, processorVersion: REFLECTION_PROCESSOR_VERSION, cutoverSequence: watermark, ports, now: ++clock })
    check('bounded-retry', deferred.kind === 'retry_deferred' && calls === 1, { deferred, calls })
    invalid = false; clock += 60_000
    const recovered = await maybeRunReflectionEvaluation(h.db, { characterId, processorVersion: REFLECTION_PROCESSOR_VERSION, cutoverSequence: watermark, ports, now: ++clock })
    const jobs = (await listJobs(h.db, characterId)).filter(job => job.processor === REFLECTION_PROCESSOR)
    check('new-job-recovery', recovered.kind === 'ran' && calls === 2 && jobs.some(job => job.status === 'failed') && jobs.some(job => job.status === 'completed'), { recovered, calls, jobs: jobs.map(job => ({ id: job.id, status: job.status })) })
    let bodyReturned = false
    const bodyProvider = createOpenAiReflectionDraftProvider({ env: { OPENAI_API_KEY: 'offline-synthetic' }, timeoutMs: 10,
      fetchImpl: async () => ({ ok: true, status: 200, async json() { await new Promise(resolve => setTimeout(resolve, 60)); bodyReturned = true; return { choices: [{ message: { content: '{}' } }] } } }) as Response,
    })
    let bodyFailure = false
    const bodyStart = Date.now()
    try { await bodyProvider.call(lastCall!) } catch { bodyFailure = true }
    check('body-deadline', bodyFailure && !bodyReturned, { failed: bodyFailure, bodyReturned, durationMs: Date.now() - bodyStart, boundMs: 10 })
    // The prior input is terminal now. Deadline controls require a new, unprocessed input.
    const deadlineWatermark = await latestDomainEventSequence(h.db, characterId)
    await appendDomainEvent(h.db, characterId, { type: 'GOAL_COMPLETED', operation: 'm111-recovery-deadline', payload: { goalId: 'goal:deadline-control', basis: 'user_report', expectedRevision: 1 }, sourceConversationEventIds: [source.event.id], idempotencyKey: 'm111-recovery:deadline', processor: 'm111-recovery', processorVersion: 'm111-recovery@1', scope: 'CHARACTER_INTERNAL' }, ++clock)
    const beforeEvents = (await domainEventsFor(h.db, characterId)).length
    let deadlineFailure = false
    try { await runReflectionWindow(h.db, { characterId, watermark: deadlineWatermark, deadlineMs: 10, provider: { ...provider, async call() { await new Promise(resolve => setTimeout(resolve, 60)); return '{}' } } }) } catch { deadlineFailure = true }
    check('runner-deadline-no-events', deadlineFailure && (await domainEventsFor(h.db, characterId)).length === beforeEvents, { failed: deadlineFailure })
    const fence = createLateWriteFence()
    let lateFailure = false
    try { await runReflectionWindow(h.db, { characterId, watermark: deadlineWatermark, fence, provider: { ...provider, async call(call) { fence.close(); return provider.call(call) } } }) } catch { lateFailure = true }
    check('closed-runner-zero-events', lateFailure && (await domainEventsFor(h.db, characterId)).length === beforeEvents && fence.refusedCount > 0, { lateFailure, refusedCount: fence.refusedCount })
    await advanceWatermark(h.db, characterId, REFLECTION_PROCESSOR, 'm111-close-control@1', watermark, ++clock)
    const schedulerFence = createLateWriteFence()
    const cancelled = await maybeRunReflectionEvaluation(h.db, { characterId, processorVersion: 'm111-close-control@1', cutoverSequence: watermark, fence: schedulerFence, now: ++clock, ports: {
      ...ports, async run() { schedulerFence.close(); return { kind: 'no_trigger' as const, eventsWritten: 0, reflectionId: null, detail: 'late result' } },
    } })
    const closedWatermark = await getWatermark(h.db, characterId, REFLECTION_PROCESSOR, 'm111-close-control@1')
    check('closed-scheduler-zero-completion', cancelled.kind === 'cancelled' && closedWatermark!.processedThroughSequence === watermark, { cancelled, watermark: closedWatermark?.processedThroughSequence })
    const repaired = await recoverRunningReflectionJobs(h.db, characterId, ++clock)
    const repeated = await recoverRunningReflectionJobs(h.db, characterId, ++clock)
    check('restart-running-job-recovery-idempotent', repaired === 1 && repeated === 0, { repaired, repeated, limitation: 'Restart API control; cross-process kill/reopen evidence still required.' })
    const commitVersion = 'm111-close-during-completion@1'
    await advanceWatermark(h.db, characterId, REFLECTION_PROCESSOR, commitVersion, deadlineWatermark, ++clock)
    const commitFence = createLateWriteFence()
    let transactions = 0
    const closingDb = new Proxy(h.db, { get(target, key) {
      if (key === 'transaction') return (work: (tx: RawDb) => Promise<unknown>) => h.db.transaction!(async tx => {
        const transactionNumber = ++transactions // enqueue, running, then completion+watermark
        const closingTx = new Proxy(tx, { get(handle, field) {
          if (field === 'execute') return async (query: unknown) => {
            const value = await tx.execute(query)
            if (transactionNumber === 3) commitFence.close()
            return value
          }
          const value = Reflect.get(handle, field)
          return typeof value === 'function' ? value.bind(handle) : value
        } }) as RawDb
        return work(closingTx)
      })
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as RawDb
    let completionRefused = false
    try { await maybeRunReflectionEvaluation(closingDb, { characterId, processorVersion: commitVersion, cutoverSequence: deadlineWatermark,
      fence: commitFence, now: ++clock, ports: { ...ports, async run() { return { kind: 'no_trigger', eventsWritten: 0, reflectionId: null, detail: 'completion race control' } } } }) } catch { completionRefused = true }
    const closedJob = (await listJobs(h.db, characterId)).find(job => job.processorVersion === commitVersion)
    const commitWatermark = await getWatermark(h.db, characterId, REFLECTION_PROCESSOR, commitVersion)
    check('close-inside-completion-transaction-rolls-back', completionRefused && transactions === 3 && closedJob?.status === 'running' && commitWatermark?.processedThroughSequence === deadlineWatermark,
      { completionRefused, transactions, status: closedJob?.status, watermark: commitWatermark?.processedThroughSequence })
  } finally { await h.stop(); cleanClose = true }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'm111-recovery', headShort: head })
  const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
  const paths = ['scripts/m11.1-recovery-verify.ts', 'src/infrastructure/runtime/reflection-scheduler.ts', 'src/infrastructure/runtime/reflection-runner.ts', 'src/infrastructure/model/openai-reflection.ts', 'src/main.ts']
  writeM11Manifest(dir, { runId, wp: 'M11.1-WP3', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'recovery', counts: { total: checks.length, passed: checks.filter(row => row.pass).length, failed: checks.filter(row => !row.pass).length }, phases: ['positive', 'negative', 'recovery'], supersedes: null, started, ended: new Date().toISOString(), cleanClose, environment: 'isolated-offline', plannedRequests: 0, actualRequests: 0, capabilityImpact: 'NONE', sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) })
  console.log(JSON.stringify({ runId, checks }, null, 2))
  process.exit(checks.every(row => row.pass) ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
