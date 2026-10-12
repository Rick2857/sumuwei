import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
const [mode, runId, flags = '11'] = process.argv.slice(2)
if (!runId || !/^[a-z0-9-]+$/.test(runId)) throw new Error('isolated worker id required')
isolateDatabase('m111-process', { runId, keep: true })
import { createM4Harness } from './m4-harness.ts'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { createLateWriteFence } from '../src/kernel/app/reflection/late-write-fence.ts'
import { runConfiguredReflectionTail } from '../src/infrastructure/runtime/reflection-runtime.ts'
import { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } from '../src/kernel/contracts/reflection.ts'
import { appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { listJobs } from '../src/infrastructure/persistence/job-store.ts'
import { listAdaptiveSelfStates, rebuildAdaptiveSelfProjections } from '../src/infrastructure/persistence/adaptive-self-store.ts'
import { listReflectionRecords, rebuildReflectionProjections } from '../src/infrastructure/persistence/reflection-store.ts'
import { readUsableAdaptiveSelfStates } from '../src/infrastructure/runtime/reflection-current-state.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { getTrace } from '../src/infrastructure/persistence/trace-store.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'
import type { RawDb } from '../src/infrastructure/persistence/db.ts'

async function main() {
  const h = await createM4Harness({ label: 'm111-process' })
  const db = new Proxy(h.db, { get(target, key) {
    if (key === 'transaction') return async (work: (tx: RawDb) => Promise<any>) => {
      const result = await h.db.transaction!(work)
      if (mode === 'commit-crash' && result?.kind === 'accepted') {
        process.send?.({ ready: true, afterBusinessCommit: true, pid: process.pid })
        await new Promise(() => {})
      }
      return result
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as RawDb
  const fence = createLateWriteFence()
  const abort = new AbortController()
  let calls = 0
  const provider = { name: 'm111-process-offline', version: 'm111-process@1', async call(call: ReflectionDraftCall) {
    calls++
    if (mode === 'crash') {
      process.send?.({ ready: true, pid: process.pid })
      await new Promise(() => {})
    }
    return { schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION, focusQuestion: '对象未明确时如何核对？',
      explanation: '先核对指代对象，再给下一步。', supportHandles: call.handles.map(handle => handle.id),
      counterHandles: [], scope: REFLECTION_DRAFT_SCOPE, suggestedSlot: 'clarify_when_ambiguous' }
  } }
  const base = { characterId: h.kernel.characterId, activeUserId: h.userId, provider, fence, signal: abort.signal }
  const tick = (reflectionEnabled: boolean, adaptiveEnabled: boolean, now = Date.now(), recover = false) =>
    runConfiguredReflectionTail(db, { ...base, reflectionEnabled, adaptiveEnabled, now, recover })
  async function seed() {
    const ids = []
    const recorders = Array.from({ length: 2 }, (_, i) => new ConversationRecorder({ db: h.db,
      characterId: h.kernel.characterId, conversationId: asConversationId(`m111-process-${i}`), dryRun: false,
      userId: h.userId, userName: 'Alex', characterName: '苏沐薇', transport: 'm111-process',
      attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    }))
    for (let i = 0; i < 3; i++) ids.push((await recorders[i % 2]!.recordUserMessage('验收夹具：两个对象都可能被指代时，先问清对象。', Math.floor(i / 2) + 1)).event!.id)
    await appendDomainEvent(h.db, h.kernel.characterId, { type: 'GOAL_COMPLETED', operation: 'm111-process-fixture',
      payload: { goalId: 'goal:m111-process', basis: 'user_report', expectedRevision: 1 }, sourceConversationEventIds: ids,
      idempotencyKey: 'm111-process-fixture', processor: 'm111-process', processorVersion: 'm111-process@1', scope: 'CHARACTER_INTERNAL',
    })
  }
  async function packet(adaptiveEnabled: boolean, budget: number) {
    const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
      recorder: h.recorder, conversationSequence: h.nextTurnSequence, recentLimit: 16, slowPathEnabled: false,
      userId: h.userId, recallBudget: { ...DEFAULT_CONTEXT_BUDGET, adaptiveSelfTokens: budget },
    })
    const turn = await gateway.beginTurn('离线入口：请帮我核对对象。')
    const p = await gateway.compileTurn({ turn, currentInput: '离线入口：请帮我核对对象。', recentLines: [],
      ...(adaptiveEnabled ? { buildAdaptiveSelfStates: () => readUsableAdaptiveSelfStates(h.db, h.kernel.characterId, h.userId) } : {}),
    })
    await gateway.completeTurn({ turn, replyText: '离线占位回复，不计模型对话。', modelDurationMs: 0 })
    const trace = await getTrace(h.db, turn.traceId)
    return { traceId: turn.traceId, refs: p.sections.filter(s => s.id === 'adaptive-self').flatMap(s => s.sourceRefs ?? []),
      traceKinds: trace?.steps.map(s => s.kind) ?? [] }
  }
  let result: unknown
  try {
    if (mode === 'recover' || mode === 'recover-committed') {
      const before = await listJobs(h.db, h.kernel.characterId)
      const now = Date.now()
      await tick(true, true, now, true)
      const recovered = await tick(true, true, now + 60_001)
      const events = await domainEventsFor(h.db, h.kernel.characterId)
      const records = await listReflectionRecords(h.db, h.kernel.characterId)
      const states = await listAdaptiveSelfStates(h.db, h.kernel.characterId)
      const fieldsBefore = JSON.stringify({ records, states })
      await rebuildReflectionProjections(h.db, h.kernel.characterId, events)
      await rebuildAdaptiveSelfProjections(h.db, h.kernel.characterId, events)
      const fieldsAfter = JSON.stringify({ records: await listReflectionRecords(h.db, h.kernel.characterId), states: await listAdaptiveSelfStates(h.db, h.kernel.characterId) })
      const jobs = await listJobs(h.db, h.kernel.characterId)
      result = { mode, calls, priorRunning: before.filter(j => j.status === 'running').length, recovered,
        failed: jobs.filter(j => j.status === 'failed').length, completed: jobs.filter(j => j.status === 'completed').length,
        reflectionEvents: events.filter(e => /^(REFLECTION_|ADAPTIVE_SELF_)/.test(String(e.type))).length,
        rebuildEqual: fieldsBefore === fieldsAfter, packet: await packet(true, 300),
        pass: before.filter(j => j.status === 'running').length === 1 && calls === (mode === 'recover-committed' ? 0 : 1) && jobs.some(j => j.status === 'failed') &&
          jobs.filter(j => j.status === 'completed').length === 1 && events.filter(e => /^(REFLECTION_|ADAPTIVE_SELF_)/.test(String(e.type))).length === 3 && fieldsBefore === fieldsAfter }
    } else {
      await tick(true, true) // The actual first-open path establishes the isolated cutover.
      await seed()
      if (mode === 'crash' || mode === 'commit-crash') { await tick(true, true); throw new Error('crash worker unexpectedly survived') }
      // 01 tests use of an existing legal state without any new reflection request.
      if (flags === '01') await tick(true, true)
      const before = await domainEventsFor(h.db, h.kernel.characterId)
      const callsBefore = calls
      const reflectionEnabled = flags[0] === '1', adaptiveEnabled = flags[1] === '1'
      await tick(reflectionEnabled, adaptiveEnabled)
      const beforeIds = new Set(before.map(e => String(e.id)))
      const added = (await domainEventsFor(h.db, h.kernel.characterId)).filter(e => !beforeIds.has(String(e.id)))
      const p300 = await packet(adaptiveEnabled, 300)
      const p800 = await packet(adaptiveEnabled, 800)
      const p0 = await packet(adaptiveEnabled, 0)
      const expectedWrites = reflectionEnabled ? (adaptiveEnabled ? 3 : 2) : 0
      const expectedCalls = reflectionEnabled ? 1 : 0
      result = { mode, flags, calls: calls - callsBefore, addedTypes: added.map(e => e.type), packets: [p0, p300, p800],
        pass: calls - callsBefore === expectedCalls && added.length === expectedWrites &&
          p0.refs.length === 0 && (p300.refs.length > 0) === adaptiveEnabled && (p800.refs.length > 0) === adaptiveEnabled &&
          added.every(e => /^(REFLECTION_|ADAPTIVE_SELF_)/.test(String(e.type))) }
    }
  } finally { fence.close(); abort.abort(); await h.stop() }
  process.send?.({ result, cleanClose: true, pid: process.pid })
  process.exit(0)
}
main().catch(error => { process.send?.({ error: String(error), pid: process.pid }); process.exit(1) })
