import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
const sandbox = isolateDatabase('goal-settlement-chain', { keep: true })
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createM4Harness } from './m4-harness.ts'
import { createM10TurnHarness, deterministicRuntime } from './m10-harness.ts'
import { prepareGoalTurn } from '../src/kernel/app/goal/turn.ts'
import { GOAL_PROPOSAL_SCHEMA_VERSION } from '../src/kernel/contracts/goal-proposal.ts'
import { createOpenAiGoalUnderstandingProvider } from '../src/infrastructure/model/openai-goal-understanding.ts'
import { createRealGoalUnderstandingRuntime } from '../src/infrastructure/goal/understanding-runtime.ts'
import { createProductionGoalCompletionPorts } from '../src/infrastructure/goal/completion-ports.ts'
import { understandGoalProposal } from '../src/kernel/app/goal/understanding.ts'
import { TurnGateway, type CompileTurnInput } from '../src/kernel/app/turn-gateway.ts'
import type { ConversationLine } from '../src/kernel/context/sections.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'

const live = process.argv.includes('--live')
if (live) assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', '真模型必须经过 with-test-model')
const checks: { name: string; pass: boolean; actual: unknown }[] = []
const check = (name: string, pass: boolean, actual: unknown): void => {
  checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
}
const h = await createM4Harness({ label: 'goal-settlement-chain' })
const goals = createM10TurnHarness({ db: h.kernel.stores.db, characterId: h.kernel.characterId, userId: h.userId })
const labels = ['凌晨六分钟那条，到点通知拔插头', '后来分开记的那条，到点通知拔插头', '到点发的那条，通知拔插头', '以后通知默认从现在开始计时']
for (const [index, statement] of labels.entries()) {
  const seeded = await goals.turn({ currentInput: statement, sourceEventId: `cev:seed:${index}`, now: Date.now(), runtime: deterministicRuntime(),
    provider: { name: 'seed', version: '1', async call() { return { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
      operation: 'create', span: { start: 0, end: [...statement].length }, statement, origin: 'user_requested',
      ...(index === 3 ? {} : { commitment: { scope: statement, criterion: { kind: 'user_report' } } }) } } } })
  assert.equal(seeded.outcome, 'accepted', JSON.stringify(seeded))
}
const ids = (await goals.listStates()).filter(row => row.commitment !== null).map(row => String(row.goal.goalId))
assert.equal(ids.length, 3)
const nativeCompletion = createProductionGoalCompletionPorts({ db: h.kernel.stores.db, characterId: h.kernel.characterId })
if (live) {
  const candidates = (await goals.candidates()).candidates.map(row => ({ ...row, priority: 'normal', successCriterionKind: 'user_report' }))
  for (const [currentInput, expected] of [['插头还没拔', 'no-completion'], ['对，就是这三条', 'no-completion'], ['只完成了其中两条拔插头约定', 'clarify']] as const) {
    const understood = await understandGoalProposal(createOpenAiGoalUnderstandingProvider(), { characterId: h.kernel.characterId,
      currentInput, sourceEventId: 'cev:negative', sourceQualification: 'ESTABLISHED', candidates, recentConversation: [] }, createRealGoalUnderstandingRuntime())
    const operation = understood.kind === 'understood' ? understood.draft.operation : undefined
    check(`真模型负控：${currentInput}`, operation !== undefined &&
      (expected === 'clarify' ? operation === 'clarify' : !['report_complete', 'create'].includes(operation)), understood)
  }
}
const history = [
  ['user', '插头已经拔了'], ['character', '凌晨六分钟那条、后来分开记的那条、还有到点发的那条都在。你这一句已经拔了，我不知道是回哪条。'],
  ['user', '两条都是，饭已经吃了'], ['character', '我刚列的是三条，哪两条？'],
  ['user', '搞错了，三条都是'], ['character', '是我刚列的那三条吗？三条都结掉，还是三条都先挂着？'],
] as const
const recent: ConversationLine[] = history.map(([actorType, text], index) => ({ id: `cev:history:${index}` as never,
  sequence: index + 1, speaker: actorType, actorType, text }))
const text = '对，就是你刚刚列出的三条'
const calls: string[] = []
const fixed = createOpenAiGoalUnderstandingProvider({ env: { OPENAI_API_KEY: 'offline-fixture' }, fetchImpl: async (_url, options) => {
  const body = JSON.parse(String(options?.body)); calls.push(body.messages[1].content)
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
    operation: 'report_complete', span: { start: 0, end: [...text].length }, targetGoalIds: ids }) } }] }), { status: 200 })
} })
const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
  recorder: h.recorder, conversationSequence: h.nextTurnSequence, recentLimit: 16, slowPathEnabled: false, userId: h.userId,
  recallBudget: { ...DEFAULT_CONTEXT_BUDGET, goalTokens: 300, commitmentTokens: 300 } })
const run = async (failure: boolean, provider = fixed) => {
  const turn = await gateway.beginTurn(text)
  let evidenceReads = 0
  const ports = { ...goals.ports, completion: { ...nativeCompletion, conversation: { findEvents: async (eventIds: readonly string[]) => {
    evidenceReads += 1
    if (failure && evidenceReads === 2) throw new Error('injected second-target evidence failure')
    return nativeCompletion.conversation.findEvents(eventIds)
  } } } }
  const prepare: NonNullable<NonNullable<CompileTurnInput['runGoalTurn']>['prepare']> = async info => {
    const finish = await prepareGoalTurn({ ...info, characterId: h.kernel.characterId, sourceQualification: 'ESTABLISHED',
      withdrawnEventIds: new Set(), now: Date.now(), provider, runtime: live ? createRealGoalUnderstandingRuntime() : deterministicRuntime() }, ports)
    return async () => ({ turn: await finish() })
  }
  const packet = await gateway.compileTurn({ turn, currentInput: text, recentLines: recent,
    runGoalTurn: Object.assign(async (info: Parameters<typeof prepare>[0]) => (await prepare(info))(), { prepare }) })
  await gateway.completeTurn({ turn, replyText: '已按你的报告处理。', modelDurationMs: 0 })
  return { reality: turn.goalWriteReality, fact: turn.goalFact, evidenceReads, factText: packet.sections.find(row => row.id === 'goal-fact')?.content }
}
const before = await goals.countEvents()
const negative = await run(true)
check('负控：第二项证据失败，三项都不写', negative.evidenceReads === 2 && negative.fact?.outcome === 'rejected' &&
  await goals.countEvents() === before, negative)
const recovered = await run(false, live ? createOpenAiGoalUnderstandingProvider() : fixed)
const rows = await goals.listStates()
check('恢复：真实用户事件完成三项并兑现三条承诺', recovered.fact?.outcome === 'accepted' && recovered.evidenceReads === 3 &&
  ids.every(id => rows.find(row => String(row.goal.goalId) === id)?.goal.status === 'completed' &&
    rows.find(row => String(row.goal.goalId) === id)?.commitment?.status === 'fulfilled'), { recovered, rows })
check('默认提醒偏好没有被一起关闭', rows.find(row => row.goal.statement === labels[3])?.goal.status !== 'completed', rows)
check('本轮事实明确写入结清，不再要求重复确认', recovered.factText?.includes('结清 3 项') === true &&
  recovered.factText.includes('不要再问'), recovered.factText)
if (!live) check('真实网关将完成报告和范围确认一起交给解析器', calls.length === 2 &&
  calls.every(input => input.includes('插头已经拔了') && input.includes('搞错了，三条都是') && input.includes(text)), calls)
const after = await goals.countEvents()
const repeated = await run(false)
check('重复确认已结清项：不再写、不追问', repeated.fact?.outcome === 'query' && repeated.fact.settledGoalCount === 3 && repeated.evidenceReads === 0 &&
  await goals.countEvents() === after, repeated)
const output = resolve('artifacts/post-lv2', `goal-settlement-${live ? 'live' : 'chain'}-${Date.now()}`)
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'evidence.json'), JSON.stringify({ live, sandbox: sandbox.dir, checks, passed: checks.every(row => row.pass) }, null, 2))
console.log(output)
process.exit(checks.every(row => row.pass) ? 0 : 1)
