/** Real gateway + isolated goal store, fixed provider. No model/network. */
import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('postlv2-goal-parallel', { keep: false })
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createM4Harness } from './m4-harness.ts'
import { createM10TurnHarness, deterministicRuntime } from './m10-harness.ts'
import { prepareGoalTurn } from '../src/kernel/app/goal/turn.ts'
import { GOAL_PROPOSAL_SCHEMA_VERSION } from '../src/kernel/contracts/goal-proposal.ts'
import { TurnGateway, type CompileTurnInput } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { listGoalStates } from '../src/infrastructure/persistence/goal-store.ts'
import { GOAL_SECTION_IDS } from '../src/kernel/context/goal-sections.ts'

const checks: { name: string; pass: boolean; actual: unknown }[] = []
const check = (name: string, pass: boolean, actual: unknown): void => { checks.push({ name, pass, actual }) }
const h = await createM4Harness({ label: 'postlv2-goal-parallel' })
const goals = createM10TurnHarness({ db: h.kernel.stores.db, characterId: h.kernel.characterId, userId: h.userId })
const reading: { parallel: boolean; elapsedMs: number; order: string[] }[] = []
for (const parallel of [false, true]) {
  const order: string[] = []
  let calls = 0
  const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
    recorder: h.recorder, conversationSequence: h.nextTurnSequence, recentLimit: 16, slowPathEnabled: false,
    userId: h.userId, recallBudget: { ...DEFAULT_CONTEXT_BUDGET, goalTokens: 300 } })
  const internal = gateway as unknown as { recallForTurn: (input: unknown) => Promise<unknown> }
  const recall = internal.recallForTurn.bind(gateway)
  internal.recallForTurn = async info => { order.push('recall:start'); await delay(250); const result = await recall(info); order.push('recall:end'); return result }
  const text = `帮我记录完成第${parallel ? '二' : '一'}份报告这个目标。`
  const turn = await gateway.beginTurn(text)
  const prepare: NonNullable<NonNullable<CompileTurnInput['runGoalTurn']>['prepare']> = async info => {
    order.push('prepare:start')
    const finish = await prepareGoalTurn({ ...info, characterId: h.kernel.characterId, sourceQualification: 'ESTABLISHED',
      withdrawnEventIds: new Set(), now: Date.now(), runtime: deterministicRuntime(), provider: {
        name: 'parallel-control', version: '1', call: async () => {
          calls += 1; await delay(250); order.push('model:end')
          return { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'create', span: { start: 0, end: [...text].length }, statement: text, origin: 'user_requested' }
        },
      } }, goals.ports)
    order.push('prepare:end')
    const before = (await domainEventsFor(h.kernel.stores.db, h.kernel.characterId)).filter(event => event.type === 'GOAL_CREATED').length
    check(`${parallel ? 'parallel' : 'serial'} preparation has no goal writes`, before === Number(parallel), before)
    return async () => {
      order.push('commit:start')
      const result = await finish()
      const again = await finish()
      check('continuation is idempotent', result === again, result.outcome)
      order.push('commit:end')
      const states = await listGoalStates(h.kernel.stores.db, h.kernel.characterId)
      return { turn: result, contextState: { ordered: states.map(row => ({ goal: row.goal, rowKey: `goal:${row.goal.goalId}` })), withdrawnEventIds: new Set() } }
    }
  }
  const runGoalTurn = Object.assign(async (info: Parameters<typeof prepare>[0]) => (await prepare(info))(), parallel ? { prepare } : {})
  const started = performance.now()
  const packet = await gateway.compileTurn({ turn, currentInput: text, recentLines: [], runGoalTurn })
  reading.push({ parallel, elapsedMs: performance.now() - started, order })
  check('one model call per turn', calls === 1, calls)
  check('writes stay after recall', order.indexOf('commit:start') > order.indexOf('recall:end'), order)
  check('same-turn committed facts reach prompt', packet.sections.some(section => section.id === GOAL_SECTION_IDS.fact) && turn.goalWriteReality?.acceptedEventTypes.includes('GOAL_CREATED') === true, { sections: packet.sections.map(section => section.id), reality: turn.goalWriteReality })
  if (parallel) check('preparation overlaps recall', order.indexOf('prepare:start') < order.indexOf('recall:end'), order)
  await gateway.completeTurn({ turn, replyText: '已记录。', modelDurationMs: 0 })
}
check('injected 250ms branches shorten wall time', reading[0]!.elapsedMs - reading[1]!.elapsedMs > 150, reading)
// Failed preparation must not invoke a second parser or allow a write.
const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot, recorder: h.recorder,
  conversationSequence: h.nextTurnSequence, recentLimit: 16, slowPathEnabled: false, userId: h.userId })
const turn = await gateway.beginTurn('准备失败负控。')
let fallbackCalls = 0
await gateway.compileTurn({ turn, currentInput: '准备失败负控。', recentLines: [], runGoalTurn: Object.assign(async () => { fallbackCalls += 1; return undefined }, { prepare: async () => { throw new Error('injected failure') } }) })
check('preparation failure has no hidden retry or write claim', fallbackCalls === 0 && turn.goalWriteReality === undefined, { fallbackCalls, reality: turn.goalWriteReality })
await gateway.completeTurn({ turn, replyText: '继续对话。', modelDurationMs: 0 })
const recoveryTurn = await gateway.beginTurn('准备恢复正控。')
let recoveryCalls = 0
await gateway.compileTurn({ turn: recoveryTurn, currentInput: '准备恢复正控。', recentLines: [], runGoalTurn: Object.assign(async () => { fallbackCalls += 1; return undefined }, {
  prepare: async () => async () => { recoveryCalls += 1; return undefined },
}) })
check('recovery: next preparation resumes normally', recoveryCalls === 1 && fallbackCalls === 0, { recoveryCalls, fallbackCalls })
await gateway.completeTurn({ turn: recoveryTurn, replyText: '恢复对话。', modelDurationMs: 0 })
let unusableCalls = 0
const finish = await prepareGoalTurn({ characterId: h.kernel.characterId, currentInput: '未确认来源', sourceEventId: 'cev:unknown', sourceQualification: 'UNCONFIRMED_ORIGIN', withdrawnEventIds: new Set(), now: Date.now(), runtime: deterministicRuntime(), provider: { name: 'unusable', version: '1', call: async () => { unusableCalls += 1; return {} } } }, goals.ports)
const unusable = await finish()
check('unusable source never invokes parser', unusableCalls === 0 && unusable.outcome === 'source_unusable', { unusableCalls, outcome: unusable.outcome })
const dir = join('artifacts', 'post-lv2', `goal-parallel-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'reading.json'), JSON.stringify({ checks, reading, scope: 'Isolated gateway scheduling and writes; injected durations, not production latency' }, null, 2))
console.log(JSON.stringify({ dir, passed: checks.filter(check => check.pass).length, total: checks.length, reading }, null, 2))
process.exit(checks.every(check => check.pass) ? 0 : 1)
