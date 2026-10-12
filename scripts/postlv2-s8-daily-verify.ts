import 'dotenv/config'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

const sandbox = isolateDatabase('s8-daily', { keep: false })
const { createM4Harness, M4_T0 } = await import('./m4-harness.ts')
const { createStoryCognition } = await import('../src/infrastructure/runtime/story-cognition.ts')
const { createStoryLedgerStore } = await import('../src/infrastructure/storyline/store/story-ledger-store.ts')
const { loadStoryRun } = await import('../src/kernel/app/storyline/commit-service.ts')
const { JICHUANG_PACK } = await import('../src/content/storyline/jichuang-interview-two/story-pack.ts')
const { TurnGateway } = await import('../src/kernel/app/turn-gateway.ts')
const { ConversationRecorder } = await import('../src/infrastructure/runtime/conversation-recorder.ts')
const { asConversationId, asConversationEventId } = await import('../src/kernel/contracts/ids.ts')
const h = await createM4Harness({ label: 's8-daily' })
const ledger = createStoryLedgerStore(h.db)
let at = M4_T0
let calls = 0
const cognitionOf = () => createStoryCognition({
  db: h.db, characterId: h.kernel.characterId, pack: JICHUANG_PACK,
  userId: 'daily-user', adaptiveEnabled: false, provider: undefined, now: () => ++at,
})
let cognition = cognitionOf()
const checks: { label: string; pass: boolean; detail: string }[] = []
const check = async (label: string, body: () => Promise<void> | void) => {
  try { await body(); checks.push({ label, pass: true, detail: '' }); console.log(`PASS ${label}`) }
  catch (error) { checks.push({ label, pass: false, detail: String(error) }); console.log(`FAIL ${label}: ${String(error)}`) }
}
const draft = (related: boolean, choiceId: string | null, quote: string | null) =>
  ({ schemaVersion: 'story-daily-draft@1', related, choiceId, quote })
const turn = async (text: string, raw: unknown, anchor: string, fail = false) => {
  // 这是真实装配的方法；替换的只有模型端口。
  return await cognition.resolveDailyTurn({
    actorId: 'daily-user', interactionRef: 'daily-conversation', anchorConversationEventId: anchor,
    currentInput: text, recentLines: [],
    decision: { deadlineMs: 1000, port: { call: async () => {
      calls += 1
      if (fail) throw new Error('injected transport failure')
      return raw
    } } },
  })
}
const runs = () => ledger.listRuns(JICHUANG_PACK.storyId)
let runId = ''
await check('关闭模式不读写故事、不调用模型', async () => {
  const before = calls
  const r = await cognition.resolveDailyTurn({ actorId: 'daily-user', interactionRef: 'daily-conversation',
    anchorConversationEventId: 'disabled', currentInput: '极创二面', recentLines: [] })
  assert.equal(r.kind, 'disabled'); assert.equal(calls, before); assert.deepEqual(await runs(), [])
})
await check('冷启动时坏形状、超时和无法引用原话均不建立故事', async () => {
  for (const raw of [null, draft(true, 'ask_scope', '没有说过'),
    { ...draft(true, null, '极创'), related: 'true' }, { ...draft(true, null, '极创'), extra: true }]) {
    const r = await turn('极创二面', raw, 'bad-cold')
    assert.equal(r.kind, 'failed'); assert.deepEqual(await runs(), [])
  }
  const r = await cognition.resolveDailyTurn({ actorId: 'daily-user', interactionRef: 'daily-conversation',
    anchorConversationEventId: 'timeout', currentInput: '极创二面', recentLines: [],
    decision: { deadlineMs: 1000, port: { call: async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }) } } } })
  assert.equal(r.code, 'story_daily_timeout'); assert.deepEqual(await runs(), [])
})
await check('无关首次聊天不创建故事且无世界上下文', async () => {
  const r = await turn('今天晚饭吃什么？', draft(false, null, null), 'a1')
  assert.equal(r.kind, 'unrelated'); assert.deepEqual(r.worldObservations, []); assert.deepEqual(await runs(), [])
})
await check('相关但未选择自动开局并呈现真实入口场景', async () => {
  const r = await turn('我们聊聊极创二面的准备吧', draft(true, null, '极创二面'), 'a2')
  assert.equal(r.kind, 'related'); assert.equal((await runs()).length, 1)
  runId = (await runs())[0]!
  const state = await loadStoryRun({ ledger, pack: JICHUANG_PACK, runId })
  assert.equal(state.ok, true)
  if (state.ok) { assert.equal(state.commits.length, 1); assert.equal(state.commits[0]!.binding.interactionKind, 'system') }
  assert.match(r.worldObservations.map(n => n.text).join('\n'), /范围|分工/)
})
await check('用户自然表达选择推进并保留真实会话锚', async () => {
  const r = await turn('我们先把二面的范围问清楚', draft(true, 'ask_scope', '范围问清楚'), 'a3')
  assert.equal(r.kind, 'committed')
  const commits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId })
  assert.equal(commits.length, 2); assert.equal(commits[1]!.choiceId, 'ask_scope')
  assert.equal(commits[1]!.binding.interactionRef, 'daily-conversation')
  assert.equal(commits[1]!.binding.anchorConversationEventId, 'a3')
})
await check('插入闲聊不推进、不注入剧情', async () => {
  const before = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId })
  const r = await turn('今天有点困', draft(false, null, null), 'a4')
  assert.equal(r.kind, 'unrelated'); assert.deepEqual(r.worldObservations, [])
  assert.deepEqual(await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId }), before)
})
await check('重新创建装配从账本续接且不重复开局', async () => {
  cognition = cognitionOf()
  const r = await turn('继续准备二面', draft(true, 'go_prepare', '继续准备'), 'a5')
  assert.equal(r.kind, 'committed'); assert.equal((await runs()).length, 1)
  const commits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId })
  assert.equal(commits.filter(c => c.eventType === 'STORY_STARTED').length, 1)
})
await check('越界提案及原话不匹配拒收零写入', async () => {
  const before = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId })
  for (const raw of [draft(true, 'invented', '准备'), draft(true, 'split_by_strength', '用户没说过')]) {
    const r = await turn('准备', raw, 'bad')
    assert.equal(r.kind, 'failed'); assert.deepEqual(r.worldObservations, [])
  }
  assert.deepEqual(await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId }), before)
})
await check('调用失败不推进且同进程新轮可恢复', async () => {
  const before = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId })
  assert.equal((await turn('准备', null, 'failed', true)).kind, 'failed')
  assert.deepEqual(await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId }), before)
  assert.equal((await turn('按各自的长处分工', draft(true, 'split_by_strength', '各自的长处'), 'a6')).kind, 'committed')
})
await check('准备、参加、复盘走到确定性结局', async () => {
  for (const [choice, text] of [['after_drill_go', '演练完了，去参加二面'], ['follow_partner', '让搭档先回答，我来补充'], ['acknowledge_fix', '承认不足一起补上']] as const) {
    assert.equal((await turn(text, draft(true, choice, text), choice)).kind, 'committed')
  }
  const loaded = await loadStoryRun({ ledger, pack: JICHUANG_PACK, runId })
  assert.equal(loaded.ok, true)
  if (loaded.ok) { assert.equal(loaded.state.terminal, true); assert.equal(loaded.state.ending, 'passed_together') }
})
await check('已结束故事可追问但不自动重开', async () => {
  cognition = cognitionOf()
  const r = await turn('这次极创二面模拟结果是什么？', draft(true, null, '极创二面'), 'result')
  assert.equal(r.kind, 'related'); assert.equal((await runs()).length, 1)
  assert.match(r.worldObservations.map(n => n.text).join('\n'), /模拟.*通过/)
})
await check('真实网关将剧情送进回复上下文且不伪装用户原话', async () => {
  const recorder = new ConversationRecorder({ db: h.db, characterId: h.kernel.characterId,
    conversationId: asConversationId('s8-daily-context'), dryRun: false,
    userName: 'daily-user', characterName: '苏沐薇', transport: 'cli', userId: 'daily-user', userRef: 'daily-user' })
  let sequence = 0
  const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
    recorder, conversationSequence: () => ++sequence, recentLimit: 16, slowPathEnabled: false, dryRun: false, userId: 'daily-user' })
  const text = '这次极创二面模拟结果是什么？'
  const r = await turn(text, draft(true, null, '极创二面'), 'context')
  const incoming = await gateway.beginTurn(text)
  const packet = await gateway.compileTurn({ turn: { ...incoming, worldObservations: r.worldObservations, storyTurnScope: 'related' }, currentInput: text, recentLines: [] })
  const section = packet.sections.find(s => String(s.id) === 'world-observation')
  assert.ok(section); assert.match(section.content, /模拟.*通过/); assert.ok(section.sourceRefs?.length)
  assert.ok(gateway.promptFor(packet).includes(section.content))
  assert.ok(!packet.sections.find(s => String(s.id) === 'current-input')?.content.includes('一起通过'))
  const scope = packet.sections.find(s => String(s.id) === 'story-turn-scope')
  assert.ok(scope); assert.equal(scope.kind, 'instruction'); assert.equal(scope.droppable, false)
  assert.match(scope.content, /模拟.*现实/)
  const idleText = '今天有点困，先聊聊晚饭'
  const idle = await gateway.beginTurn(idleText)
  const idlePacket = await gateway.compileTurn({ turn: { ...idle, storyTurnScope: 'unrelated' }, currentInput: idleText,
    recentLines: [{ id: asConversationEventId('s8-prior'), sequence: 1, actorType: 'character', speaker: '苏沐薇', text: '明天一起去二面' }] })
  assert.ok(!idlePacket.sections.some(s => String(s.id) === 'world-observation'))
  assert.match(idlePacket.sections.find(s => String(s.id) === 'story-turn-scope')!.content, /不主动.*故事/)
  assert.equal(idlePacket.sections.find(s => String(s.id) === 'story-turn-scope')!.sourceRefs?.length ?? 0, 0)
})
await check('反例：无关标记夹带选择必须拒收', async () => {
  const r = await turn('晚饭吃什么', draft(false, 'ask_scope', '晚饭'), 'contradiction')
  assert.equal(r.kind, 'failed')
})
await check('非零分母和生产隔离', () => {
  assert.ok(calls > 0); assert.ok(sandbox.dir !== process.env.PROJECT_LG_PRODUCTION_DATA_DIR)
  assert.notEqual(process.env.PROJECT_LG_ALLOW_PRODUCTION_DB, '1')
})
const verdict = checks.every(c => c.pass) ? 'PASS' : 'FAIL'
const outDir = join('artifacts/post-lv2', `s8-daily-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`)
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'result.json'), JSON.stringify({ verdict, checks, modelCalls: { fixture: calls, real: 0 }, sandbox: sandbox.dir }, null, 2))
console.log(`${verdict}: ${checks.filter(c => c.pass).length}/${checks.length}; ${outDir}/result.json`)
await resetPluginSqlConnection()
process.exit(verdict === 'PASS' ? 0 : 1)
