/** Offline deadline controls: real timers and HTTP body aborts; no network or database. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { GOAL_PROPOSAL_SCHEMA_VERSION } from '../src/kernel/contracts/goal-proposal.ts'
import { GOAL_UNDERSTANDING_DEADLINE_MS, understandGoalProposal, type GoalUnderstandingInput } from '../src/kernel/app/goal/understanding.ts'
import { runGoalTurn, type GoalTurnPorts } from '../src/kernel/app/goal/turn.ts'
import { createRealGoalUnderstandingRuntime } from '../src/infrastructure/goal/understanding-runtime.ts'
import { createOpenAiGoalUnderstandingProvider } from '../src/infrastructure/model/openai-goal-understanding.ts'

const checks: { name: string; pass: boolean; actual: unknown }[] = []
const check = (name: string, pass: boolean, actual: unknown): void => { checks.push({ name, pass, actual }) }
const input: GoalUnderstandingInput = {
  characterId: 'deadline-control', currentInput: '帮我记录写完论文提纲这个目标',
  sourceEventId: 'cev:deadline-control', sourceQualification: 'ESTABLISHED', candidates: [],
}
const draft = {
  schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'create',
  span: { start: 0, end: [...input.currentInput].length }, statement: '写完论文提纲', origin: 'user_requested',
}
let writes = 0
let calls = 0
const ports: GoalTurnPorts = {
  candidates: { readCandidates: async () => ({ candidates: [], goals: [], maskedCount: 0 }) },
  writer: { commit: async () => { writes += 1; return { eventsCommitted: 1, rowsCommitted: 1 } } },
  passThrough: { validate: async () => ({ accepted: true, rejectedCodes: [], acceptedEventTypes: ['GOAL_CREATED'], acceptedEvents: [] }) },
  completion: {
    conversation: { findEvents: async () => [] }, assistant: { findAssistantEvents: async () => [] },
    actions: { findActions: async () => [] },
  },
}
const turnInput = { ...input, now: Date.now(), withdrawnEventIds: new Set<string>(), runtime: createRealGoalUnderstandingRuntime() }
check('kernel deadline is 8000ms', GOAL_UNDERSTANDING_DEADLINE_MS === 8_000, GOAL_UNDERSTANDING_DEADLINE_MS)

for (const thinkingMode of ['default', 'low', 'disabled'] as const) {
  let body: Record<string, unknown> = {}
  const provider = createOpenAiGoalUnderstandingProvider({ thinkingMode, env: { OPENAI_API_KEY: 'mock-credential' }, fetchImpl: async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ choices: [{ message: { content: JSON.stringify(draft) } }] })
  } })
  await provider.call({ input, deadlineMs: 8_000 })
  check(`parser-only thinking request: ${thinkingMode}`, thinkingMode === 'default'
    ? body.thinking === undefined && body.reasoning_effort === undefined
    : thinkingMode === 'low' ? JSON.stringify(body.thinking) === '{"type":"enabled"}' && body.reasoning_effort === 'low'
    : JSON.stringify(body.thinking) === '{"type":"disabled"}' && body.reasoning_effort === undefined, body)
}

const fast = await runGoalTurn({ ...turnInput, provider: {
  name: 'fast-control', version: '1', call: async () => { calls += 1; return draft },
} }, ports)
check('positive: timely valid goal still commits once', fast.outcome === 'accepted' && writes === 1 && calls === 1, { outcome: fast.outcome, writes, calls })

if (GOAL_UNDERSTANDING_DEADLINE_MS === 8_000) {
  let release!: (value: unknown) => void
  let receivedDeadline = 0
  const pending = new Promise<unknown>(resolve => { release = resolve })
  const keepAlive = setTimeout(() => {}, 12_000) // The production runtime intentionally unrefs its timer.
  const started = performance.now()
  const slow = await runGoalTurn({ ...turnInput, provider: {
    name: 'slow-control', version: '1', call: async call => { calls += 1; receivedDeadline = call.deadlineMs; return pending },
  } }, ports)
  clearTimeout(keepAlive)
  const elapsedMs = performance.now() - started
  check('real timer: returns after 8 seconds', elapsedMs >= 7_900 && elapsedMs < 10_000, elapsedMs)
  check('provider receives the same deadline', receivedDeadline === 8_000, receivedDeadline)
  check('timeout exposes a failed fact without successful writes', slow.outcome === 'transport_failed' && slow.trace.proposal.transportReason === 'timeout' && slow.fact?.outcome === 'failed' && slow.fact.operation === 'understanding' && slow.fact.rejectionCodes?.includes('timeout') === true && writes === 1, { outcome: slow.outcome, fact: slow.fact, trace: slow.trace, writes })
  release(draft)
  await delay(20)
  check('late result cannot commit; no implicit retry', writes === 1 && calls === 2, { writes, calls })
  const recovered = await runGoalTurn({ ...turnInput, provider: {
    name: 'recovered-control', version: '1', call: async () => draft,
  } }, ports)
  check('recovery: the next timely goal can still commit', recovered.outcome === 'accepted' && writes === 2, { outcome: recovered.outcome, writes })
}

// Headers arrive promptly, but a real ReadableStream stalls until its fetch signal is aborted.
for (const status of [0, 200, 503]) {
  let signal: AbortSignal | undefined
  let fetchCalls = 0
  const provider = createOpenAiGoalUnderstandingProvider({
    env: { OPENAI_API_KEY: 'offline-fixture', OPENAI_BASE_URL: 'https://offline.invalid', OPENAI_SMALL_MODEL: 'fixture' },
    timeoutMs: 40,
    fetchImpl: async (_url, init) => {
      fetchCalls += 1
      signal = init?.signal ?? undefined
      if (status === 0) return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('fixture headers aborted')), { once: true })
      })
      return new Response(new ReadableStream({ start(controller) {
        signal?.addEventListener('abort', () => controller.error(new Error('fixture body aborted')), { once: true })
      } }), { status })
    },
  })
  let watchdog: NodeJS.Timeout | undefined
  const result = await Promise.race([
    provider.call({ input, deadlineMs: 40 }).then(() => 'unexpected success', () => 'aborted'),
    new Promise<string>(resolve => { watchdog = setTimeout(() => resolve('body stalled'), 500) }),
  ])
  clearTimeout(watchdog)
  check(status === 0 ? 'deadline covers stalled response headers' : `HTTP ${status}: deadline covers stalled response body`, result === 'aborted' && signal?.aborted === true && fetchCalls === 1, { result, aborted: signal?.aborted, fetchCalls })
}
let completedSignal: AbortSignal | undefined
const completed = createOpenAiGoalUnderstandingProvider({
  env: { OPENAI_API_KEY: 'offline-fixture' }, timeoutMs: 40,
  fetchImpl: async (_url, init) => {
    completedSignal = init?.signal ?? undefined
    return Response.json({ choices: [{ message: { content: JSON.stringify(draft) } }] })
  },
})
const value = await completed.call({ input, deadlineMs: 40 })
await delay(60)
check('recovery: completed body parses and clears its abort timer', JSON.stringify(value) === JSON.stringify(draft) && completedSignal?.aborted === false, { aborted: completedSignal?.aborted })
const invalid = await understandGoalProposal(createOpenAiGoalUnderstandingProvider({
  env: { OPENAI_API_KEY: 'offline-fixture' },
  fetchImpl: async () => Response.json({ choices: [{ message: { content: 'not JSON' } }] }),
}), input, createRealGoalUnderstandingRuntime())
check('malformed model content remains invalid rather than transport or none', invalid.kind === 'invalid', invalid.kind)

const failed = checks.filter(item => !item.pass)
const output = join('artifacts', 'post-lv2', `goal-deadline-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(output, { recursive: true })
const reading = { kind: 'offline goal deadline controls', measured_count: checks.length, passed: checks.length - failed.length, failed: failed.length, checks, network: 'MOCKED', database: 'NOT_OPENED', realtimeLatency: 'NOT_MEASURED' }
writeFileSync(join(output, 'reading.json'), JSON.stringify(reading, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ ...reading, evidence: join(output, 'reading.json') }, null, 2))
process.exitCode = failed.length > 0 || checks.length === 0 ? 1 : 0
