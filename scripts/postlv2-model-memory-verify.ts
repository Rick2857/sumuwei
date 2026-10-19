import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ModelType } from '../src/infrastructure/runtime/eliza-vocabulary.ts'
import { stringToUuid } from '../src/kernel/contracts/uuid.ts'


import { sql } from 'drizzle-orm'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { isolateDatabase, cleanupSandbox } from '../src/dev/sandbox.ts'
import { getRawDb, exec } from '../src/infrastructure/persistence/db.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { asConversationId, createFullDomainEventRegistry, createRecallRequest, entityRef, type ConversationEvent, type MemoryRecord } from '../src/kernel/contracts/index.ts'
import { createNativeMemoryStore } from '../src/infrastructure/persistence/memory-store.ts'
import { getWatermark } from '../src/infrastructure/persistence/job-store.ts'
import { readAutomaticMemoryHealth, authorizeAutomaticMemoryRetry } from '../src/infrastructure/runtime/automatic-memory-control.ts'
import { MODEL_MEMORY_PROCESSOR, MODEL_MEMORY_VERSION, MODEL_MEMORY_TARGET, PostTurnModelMemoryConsumer,
  commitModelMemoryPlan, modelMemoryPrompt, parseModelMemoryPlan, deferredMemoryTurnPort, type ModelMemoryPlan } from '../src/infrastructure/runtime/post-turn-model-memory.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { applyResponseTruthPolicy } from '../src/kernel/app/memory/response-truth.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'

interface ContrastCase {
  id: string; pair: string; text: string; operation: 'none' | 'create' | 'correct' | 'forget' | 'dispute' | 'restore'
  predicate?: string; value?: string; type?: 'person_fact' | 'preference' | 'episode'; seed?: 'active' | 'retracted'
  recent?: { actor: string; text: string }[]
}
const live = process.argv.includes('--live')
if (live && process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Use with-test-model for live verification')
const corpusBytes = readFileSync('evals/post-lv2/model-memory-contrast.json', 'utf8')
const corpus = JSON.parse(corpusBytes) as ContrastCase[]
assert.equal(new Set(corpus.map(item => item.id)).size, corpus.length)
const evidenceRoot = resolve(`artifacts/post-lv2/model-memory/${live ? 'live' : 'offline'}-${Date.now()}`)
mkdirSync(evidenceRoot, { recursive: true })
const results: { name: string; pass: boolean; detail?: string; raw?: string; domainEvents?: number }[] = []
const sandbox = isolateDatabase('model-memory', { keep: true })
const runtime = createThinHostRuntime({
    character: character,
    settings: {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'unused', OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
  OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? '',
},
  })
await initDatabase(runtime)
const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character), registry: createFullDomainEventRegistry() })
const db = getRawDb(runtime)
const store = createNativeMemoryStore(db)
const owner = entityRef('character', String(kernel.characterId))
let realModelDecisions = 0
async function check(name: string, run: () => Promise<void> | void) {
  try { await run(); results.push({ name, pass: true }); console.log(`PASS ${name}`) }
  catch (error) { results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) }); console.log(`FAIL ${name}: ${results.at(-1)?.detail}`) }
}
function fixture(id: string) {
  const userId = stringToUuid(`model-memory-${id}`)
  const speaker = entityRef('user', userId)
  const recorder = new ConversationRecorder({ db, characterId: kernel.characterId, conversationId: asConversationId(`model-memory-${id}`), userId,
    dryRun: false, userName: 'Fixture', characterName: character.name, transport: 'verify', attribution: [createHumanConsoleUserTurnIngress()] })
  let sequence = 0
  async function source(text: string, reply = true) {
    const input = await recorder.recordUserMessage(text, ++sequence)
    assert.ok(input.event && input.assistantSequence)
    if (reply) await respond(input.event, input.assistantSequence)
    return input
  }
  async function respond(event: ConversationEvent, characterSequence: number) {
    await recorder.recordAssistantMessage({ text: '收到，待处理。', conversationSequence: ++sequence, characterSequence, replyToEventId: event.id })
  }
  async function records() { return store.listBySubject(owner, speaker) }
  async function commit(event: ConversationEvent, plan: ModelMemoryPlan, snapshot?: MemoryRecord[]) {
    return db.transaction!(tx => commitModelMemoryPlan({ db: tx, characterId: kernel.characterId, speaker, registry: kernel.registry,
      event, records: snapshot ?? [], plan }))
  }
  return { speaker, recorder, source, respond, records, commit }
}
function creation(text: string, predicate: string, value: string, type: 'person_fact' | 'preference' = 'person_fact'): ModelMemoryPlan {
  return { destination: 'long_term', decisions: [{ operation: 'create', quote: text, explicit: true,
    memory: { type, predicate, value, importance: 0.72, confidence: 0.94 } }] }
}
function expectedPlan(item: ContrastCase, records: MemoryRecord[]): ModelMemoryPlan {
  if (item.operation === 'none') return { destination: 'none', decisions: [] }
  const target = records.find(record => record.content.kind === 'claim' && record.content.predicate === 'education.institution')
  return { destination: item.operation === 'create' ? 'long_term' : 'mutation', decisions: [{ operation: item.operation, quote: item.text, explicit: true,
    ...(item.operation === 'create' ? {} : { targetId: String(target!.id) }),
    ...(item.operation === 'create' || item.operation === 'correct' ? { memory: { type: item.type!,
      ...(item.type === 'episode' ? { summary: item.text } : { predicate: item.predicate!, value: item.value! }), importance: 0.72, confidence: 0.94 } } : {}),
  }] }
}
const domainCount = async () => Number((await exec(db, sql`select count(*)::int as count from character_domain_events where type like 'MEMORY_%'`, 'memory domain count'))[0]!.count)
try {
  for (const item of corpus) {
    let raw = ''
    let written = 0
    await check(`${live ? 'semantic' : 'fixture-commit'}:${item.id}`, async () => {
      const f = fixture(item.id)
      if (item.seed) {
        const seedText = '我的学校是示例工程科技大学。'
        const seed = (await f.source(seedText)).event!
        await f.commit(seed, creation(seedText, 'education.institution', '示例工程科技大学'))
        // A second record prevents ambiguous-delete from becoming a unique-id shortcut.
        const nameText = '以后称呼我阿明。'
        await f.commit((await f.source(nameText)).event!, creation(nameText, 'preferred.address', '阿明', 'preference'))
        if (item.seed === 'retracted') {
          const records = await f.records()
          const target = records.find(record => record.content.kind === 'claim' && record.content.predicate === 'education.institution')!
          const forget = (await f.source('忘掉我的学校信息。')).event!
          await f.commit(forget, { destination: 'mutation', decisions: [{ operation: 'forget', quote: forget.content, explicit: true, targetId: String(target.id) }] }, records)
        }
      }
      const records = await f.records()
      const before = await domainCount()
      const event = (await f.source(item.text)).event!
      if (live) {
        realModelDecisions++
        const handler = openAiCompatiblePlugin.models![ModelType.TEXT_LARGE]!
        const params = { prompt: modelMemoryPrompt({ event, records, recent: item.recent ?? [] }),
          temperature: 0, maxTokens: 4096, signal: AbortSignal.timeout(30_000) }
        raw = String(await handler(runtime, params))
      } else raw = JSON.stringify(expectedPlan(item, records))
      const plan = parseModelMemoryPlan(raw, event.content, records)
      // Commit even a wrong but structurally valid model decision: test the real consequence.
      written = await f.commit(event, plan, records)
      const after = await f.records()
      if (item.operation === 'none') {
        assert.equal(plan.decisions.length, 0, 'semantic false positive')
        assert.equal(await domainCount(), before, 'negative must write zero memory domain events')
        assert.deepEqual(after, records, 'negative must change no memory records')
      } else {
        assert.equal(plan.decisions.length, 1, 'must produce exactly the intended operation')
        assert.equal(plan.decisions[0]!.operation, item.operation)
        if (item.operation === 'create' || item.operation === 'correct') {
          if (item.type === 'episode') {
            assert.equal(after.length, 1)
            assert.equal(after[0]!.type, 'episode')
            assert.ok(after[0]!.content.kind === 'episode' && after[0]!.content.summary.includes('毕业答辩') && after[0]!.content.summary.includes('通过'))
            assert.equal(written, 1)
            return
          }
          const active = after.filter(record => record.status === 'active' && record.content.kind === 'claim' && record.content.predicate === item.predicate)
          assert.equal(active.length, 1)
          assert.equal(active[0]!.type, item.type)
          assert.equal(active[0]!.content.kind === 'claim' && active[0]!.content.value, item.value)
          assert.equal(written, item.operation === 'create' ? 1 : 2)
          if (item.operation === 'correct') assert.ok(after.some(record => record.status === 'superseded'))
        } else {
          const target = after.find(record => record.content.kind === 'claim' && record.content.predicate === 'education.institution')!
          assert.equal(target.status, { forget: 'retracted', dispute: 'disputed', restore: 'active' }[item.operation])
          assert.equal(written, 1)
        }
      }
      assert.equal(await domainCount() - before, written)
    })
    Object.assign(results.at(-1)!, { raw, domainEvents: written })
  }
  if (!live) {
    await check('pending reply truth leaves successful reminder alone', async () => {
      assert.equal(readKernelFlags({}).memoryPostTurnModelEnabled, false)
      assert.equal(readKernelFlags({ CHARACTER_MEMORY_WRITE_MODE: 'post_turn_model' }).memoryPostTurnModelEnabled, true)
      assert.equal(readKernelFlags({ CHARACTER_MEMORY_RECALL_MODE: 'semantic_only' }).memorySemanticOnlyEnabled, true)
      const result = await deferredMemoryTurnPort().handleTurn({} as never)
      assert.equal(result?.kind, 'not_written')
      assert.equal(applyResponseTruthPolicy({ result, replyText: '我已经记住了。' }).corrected, true)
      assert.equal(applyResponseTruthPolicy({ result, replyText: '提醒已经处理好了。' }).corrected, false)
    })
    await check('invalid evidence, target and score are rejected before writes', async () => {
      for (const raw of [
        '{"destination":"long_term","decisions":[]}',
        JSON.stringify(creation('未说过', 'preferred.address', '小林', 'preference')),
        JSON.stringify({ destination: 'mutation', decisions: [{ operation: 'forget', quote: '忘掉学校', explicit: false, targetId: 'invented' }] }),
        JSON.stringify({ destination: 'long_term', decisions: [{ operation: 'create', quote: '叫我小林', explicit: true, memory: { type: 'preference', predicate: 'preferred.address', value: '小林', importance: 8, confidence: 0.9 } }] }),
      ]) assert.throws(() => parseModelMemoryPlan(raw, '叫我小林，忘掉学校', []))
    })
    await check('batch rollback, changed target and withdrawn content cannot bypass native checks', async () => {
      const f = fixture('rollback')
      const event = (await f.source('我在南京大学读书，同时学校是北京大学。')).event!
      const before = await domainCount()
      const a = creation(event.content, 'education.institution', '南京大学')
      const b = creation(event.content, 'education.institution', '北京大学')
      await assert.rejects(f.commit(event, { destination: 'long_term', decisions: [...a.decisions, ...b.decisions] }))
      assert.equal((await f.records()).length, 0)
      assert.equal(await domainCount(), before, 'second decision failure rolls back first decision too')
      await f.commit(event, a)
      const snapshot = await f.records()
      const forget = (await f.source('忘掉我的学校。')).event!
      const plan: ModelMemoryPlan = { destination: 'mutation', decisions: [{ operation: 'forget', quote: forget.content,
        explicit: true, targetId: String(snapshot[0]!.id) }] }
      await f.commit(forget, plan, snapshot)
      await assert.rejects(f.commit(forget, plan, snapshot), /stale_target/)
      await assert.rejects(f.commit((await f.source('我在南京大学读书。')).event!, creation('我在南京大学读书。', 'education.institution', '南京大学')), /cannot_revive/)
      const foreign = fixture('foreign-target')
      const foreignEvent = (await foreign.source('恢复他的学校记忆。')).event!
      await assert.rejects(foreign.commit(foreignEvent, { destination: 'mutation', decisions: [{ operation: 'restore', quote: foreignEvent.content,
        explicit: true, targetId: String(snapshot[0]!.id) }] }, await f.records()), /stale_target/)
    })
    await check('explicit correction back to an old value reuses native restatement revival', async () => {
      const f = fixture('correct-back')
      const a = (await f.source('我的学校是南京大学。')).event!
      await f.commit(a, creation(a.content, 'education.institution', '南京大学'))
      const first = (await f.records())[0]!
      const b = (await f.source('更正学校为北京大学。')).event!
      const correct = (text: string, target: MemoryRecord, value: string): ModelMemoryPlan => ({ destination: 'mutation', decisions: [{
        ...creation(text, 'education.institution', value).decisions[0]!, operation: 'correct', targetId: String(target.id), explicit: true }] })
      assert.equal(await f.commit(b, correct(b.content, first, '北京大学'), await f.records()), 2)
      const records = await f.records()
      const active = records.find(record => record.status === 'active')!
      const c = (await f.source('请更正回来，我现在的学校是南京大学。')).event!
      assert.equal(await f.commit(c, correct(c.content, active, '南京大学'), records), 2)
      assert.equal((await store.get(first.id))!.status, 'active')
      assert.equal((await store.rebuildMemory(first.id)).equal, true, 'online and replay agree')
    })
    await check('semantic-only ordering and no keyword fallback on failure', async () => {
      const f = fixture('recall')
      for (const [text, predicate, value, type] of [
        ['我的学校是南京大学。', 'education.institution', '南京大学', 'person_fact'],
        ['以后称呼我阿明。', 'preferred.address', '阿明', 'preference'],
      ] as const) await f.commit((await f.source(text)).event!, creation(text, predicate, value, type))
      const records = await f.records()
      const target = records.find(record => record.content.kind === 'claim' && record.content.predicate === 'preferred.address')!
      let fail = false
      const port = createMemoryRetrievalStore({ store, semanticOnly: true, integrity: owner => memoryIntegrityProblems(db, owner),
        rootReadings: ids => rootReadingsByMemory(db, ids), semanticProbe: { name: 'fixture-semantic', score: async () => fail
          ? { ok: false, reason: 'timeout' } : { ok: true, scores: new Map(records.map(record => [String(record.id), record.id === target.id ? 0.99 : 0.2])) } } })
      const query = { traceId: 'model-recall' as never, characterId: kernel.characterId, user: f.speaker,
        text: '南京大学', timeScope: { kind: 'any' as const }, limit: 10 }
      const hit = await port.retrieve(query)
      assert.equal(hit.hits[0]?.record.id, target.id, 'semantics win despite exact lexical school hit')
      assert.ok(hit.hits.every(hit => hit.channels.join(',') === 'semantic'))
      assert.ok(!hit.capabilities.available.includes('lexical'))
      const request = createRecallRequest({ traceId: 'model-recall', characterId: String(kernel.characterId), user: f.speaker,
        query: { text: query.text }, semanticMode: 'off', contextBudget: { memoryTokens: 500 } })
      const turn = createRecallTurnPort({ service: createMemoryRecallService({ port }), budget: { ...DEFAULT_CONTEXT_BUDGET, memoryTokens: 500 },
        semanticOnly: true, now: Date.now })
      const recall = await turn.run(request)
      assert.ok(recall.selection.blockText.includes('阿明'))
      assert.ok(!recall.selection.blockText.includes('南京大学'), 'low semantic score cannot bypass via lexical/subject/recency')
      fail = true
      assert.equal((await port.retrieve(query)).hits.length, 0)
      assert.equal((await turn.run(request)).selection.blockText, '')
    })
    await check('post-reply worker calls model every turn, commits once, survives restart', async () => {
      const f = fixture('worker')
      let calls = 0
      const readings: string[] = []
      let mode: 'good' | 'bad' | 'hold' = 'good'
      let release!: () => void
      let entered!: () => void
      let waiting = new Promise<void>(done => { entered = done })
      const makeWorker = () => new PostTurnModelMemoryConsumer({ db, characterId: kernel.characterId, speaker: f.speaker, registry: kernel.registry,
        invoke: async prompt => {
          calls++
          if (mode === 'bad') throw new Error('fixture transport failure')
          if (mode === 'hold') { entered(); await new Promise<void>(done => { release = done }) }
          const text = JSON.parse(prompt.split('\n').at(-1)!).current.text as string
          return JSON.stringify(text.includes('真实学校是') ? creation(text, 'education.institution', '北京大学') : { destination: 'transient', decisions: [] })
        }, onReading: reading => readings.push(reading.status) })
      let worker = makeWorker()
      await worker.open(); await worker.drain()
      const pending = await f.source('我的真实学校是北京大学。', false)
      await worker.drain(); assert.equal(calls, 0, 'no model until reply recorded')
      await f.respond(pending.event!, pending.assistantSequence!)
      await worker.drain(); assert.equal(calls, 1); assert.equal((await f.records()).length, 1)
      await worker.drain(); assert.equal(calls, 1, 'idempotent tail')
      await f.source('你还记得我的学校吗？'); await worker.drain(); assert.equal(calls, 2, 'questions are judged by model too')
      await f.source('提醒我拔插头。'); await worker.drain(); assert.equal(calls, 3, 'reminders are judged by model too')
      await worker.close(); worker = makeWorker(); await worker.open(); await worker.drain(); assert.equal(calls, 3)
      const failedTurn = (await f.source('取消了的对话。', false)).event!
      await kernel.stores.traceWriter.start({ traceId: 'model-memory-failed-turn' as never, characterId: kernel.characterId, inputEventId: failedTurn.id,
        identitySourceRefs: [], contextSectionIds: [], droppedSectionIds: [], sourceConversationEventIds: [], selectedMemoryIds: [],
        projectionRevisionsAtStart: {}, projectionRevisionsAtEnd: {}, domainEventIds: [], actionIds: [], postTurnJobIds: [], processorVersions: {}, steps: [],
        status: 'failed', startedAt: Date.now(), finishedAt: Date.now(), error: 'cancelled' })
      await worker.drain(); assert.equal(calls, 3, 'failed turn is skipped without a model call or stalled watermark')
      mode = 'bad'; await f.source('失败测试。')
      const before = (await getWatermark(db, kernel.characterId, MODEL_MEMORY_PROCESSOR, MODEL_MEMORY_VERSION))!.processedThroughSequence
      for (let i = 0; i < 4; i++) await worker.drain()
      assert.equal(calls, 6); assert.equal(readings.at(-1), 'retry_exhausted')
      assert.equal((await getWatermark(db, kernel.characterId, MODEL_MEMORY_PROCESSOR, MODEL_MEMORY_VERSION))!.processedThroughSequence, before)
      const health = await readAutomaticMemoryHealth(db, kernel.characterId, MODEL_MEMORY_TARGET)
      assert.equal(health.status, 'retry_exhausted')
      await authorizeAutomaticMemoryRetry(db, kernel.characterId, health.sourceSequence!, true, MODEL_MEMORY_TARGET)
      mode = 'good'; await worker.drain(); assert.equal(calls, 7)
      mode = 'hold'; waiting = new Promise<void>(done => { entered = done })
      await f.source('结束中不许晚写。')
      const watermark = (await getWatermark(db, kernel.characterId, MODEL_MEMORY_PROCESSOR, MODEL_MEMORY_VERSION))!.processedThroughSequence
      const draining = worker.drain(); await waiting
      const closing = worker.close(); release(); await closing; await draining
      assert.equal((await getWatermark(db, kernel.characterId, MODEL_MEMORY_PROCESSOR, MODEL_MEMORY_VERSION))!.processedThroughSequence, watermark)
      assert.equal(readings.at(-1), 'failed')
    })
  }
} finally {
  await runtime.stop(); await runtime.adapter?.close(); cleanupSandbox(sandbox.dir)
}
writeFileSync(resolve(evidenceRoot, 'result.json'), JSON.stringify({ live, corpusSha256: createHash('sha256').update(corpusBytes).digest('hex'),
  passed: results.filter(item => item.pass).length, failed: results.filter(item => !item.pass).length,
  realModelDecisions, transportAttempts: live ? 'NOT_MEASURED_PROVIDER_MAY_RETRY' : 0,
  productionDbOpened: false, results }, null, 2))
console.log(`Evidence: ${evidenceRoot}`)
if (results.some(item => !item.pass)) process.exitCode = 1
