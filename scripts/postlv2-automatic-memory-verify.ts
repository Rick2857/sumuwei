import 'dotenv/config'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentRuntime, stringToUuid, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { isolateDatabase, cleanupSandbox } from '../src/dev/sandbox.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import { openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { findEventRefs } from '../src/infrastructure/persistence/conversation-store.ts'
import { createMemoryMutationValidator } from '../src/kernel/policies/memory-validator.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { asConversationId, createFullDomainEventRegistry, entityRef } from '../src/kernel/contracts/index.ts'
import { createNativeMemoryStore } from '../src/infrastructure/persistence/memory-store.ts'
import { getWatermark, hasProcessedOperation, listJobs } from '../src/infrastructure/persistence/job-store.ts'
import { AutomaticMemoryConsumer, type AutomaticMemoryReading } from '../src/infrastructure/runtime/automatic-memory.ts'
import { AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION, LangMemMemoryExtractor } from '../src/infrastructure/model/langmem-memory-extractor.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { processorEventViewOf } from '../src/kernel/app/memory/extractor.ts'

const live = process.argv.includes('--live')
if (live && process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Use with-test-model for live verification')
const python = process.env.CHARACTER_MEMORY_AUTOMATIC_PYTHON
  ?? resolve('artifacts/post-lv2/local/automatic-memory-20261007/langmem/.venv/Scripts/python.exe')
const evidenceRoot = resolve(`artifacts/research/automatic-memory-20261007/run-${Date.now()}`)
mkdirSync(evidenceRoot, { recursive: true })
const readings: AutomaticMemoryReading[] = []
const cases: { name: string; pass: boolean; detail?: string }[] = []
let modelCalls = 0
let mode: 'valid' | 'bad-quote' | 'malformed' | 'transport-failure' = 'valid'
const fixture = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.includes('/chat/completions')) {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return
  }
  let raw = ''
  for await (const chunk of request) raw += String(chunk)
  modelCalls++
  if (mode === 'transport-failure') { response.writeHead(500); response.end('{}'); return }
  const body = JSON.parse(raw) as { messages: { content: string }[] }
  const text = body.messages.map((message) => message.content).join('\n')
  if (!text.includes('You extract candidate memories for LG.')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'chat-fixture', choices: [{ message: { role: 'assistant', content: '<response><text>收到。</text></response>' }, finish_reason: 'stop' }] }))
    return
  }
  const match = /"sequence":\s*(\d+),\s*"actor":\s*"USER",\s*"content":\s*("(?:\\.|[^"\\])*")/u.exec(text)
  assert.ok(match, 'fixture receives labelled source data')
  const sequence = Number(match[1])
  const content = JSON.parse(match[2]!) as string
  let candidates: unknown[] = []
  if (content.includes('在示科读书')) candidates = [{ memoryType: 'person_fact', subjectToken: 'USER',
    claim: { predicate: 'education.institution', value: '示科' },
    evidenceEventSequences: [sequence], evidenceQuotes: [{ sequence, quote: mode === 'bad-quote' ? '虚构证据' : content }], confidence: 0.95 }]
  if (content.includes('毕业答辩通过')) candidates = [{ memoryType: 'episode', subjectToken: 'USER',
    episode: { summary: '用户完成并通过了毕业答辩，这件事对用户很重要。', participantTokens: ['USER'], topicTags: ['毕业', '答辩', '重要'] },
    evidenceEventSequences: [sequence], evidenceQuotes: [{ sequence, quote: content }], confidence: 0.95 }]
  if (content.includes('不吃香菜')) candidates = [{ memoryType: 'preference', subjectToken: 'USER',
    claim: { predicate: 'food.preference.cilantro', value: 'dislike' },
    evidenceEventSequences: [sequence], evidenceQuotes: [{ sequence, quote: content }], confidence: 0.95 }]
  if (content.includes('南京大学')) candidates = [{ memoryType: 'person_fact', subjectToken: 'USER',
    claim: { predicate: 'education.institution', value: '南京大学' },
    evidenceEventSequences: [sequence], evidenceQuotes: [{ sequence, quote: content }], confidence: 0.95 }]
  const args = mode === 'malformed' ? { candidates: [{ memoryType: 'illegal' }] } : { candidates }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture',
    choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_one', type: 'function',
      function: { name: 'MemoryBatch', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})
await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done))
if (!live) {
  const port = (fixture.address() as { port: number }).port
  Object.assign(process.env, { OPENAI_API_KEY: 'offline-fixture', OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_LARGE_MODEL: 'fixture' })
}
const sandbox = isolateDatabase('automatic-memory-verify', { keep: true })
const runtime = new AgentRuntime({ character: character as Character, plugins: [sqlPlugin] as Plugin[], settings: { OPENAI_API_KEY: 'unused' } })
await initDatabase(runtime, sqlPlugin)
const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character), registry: createFullDomainEventRegistry() })
const db = getRawDb(runtime)
const userId = stringToUuid('user-automatic-memory-fixture')
const speaker = entityRef('user', userId)
const owner = entityRef('character', String(kernel.characterId))
const store = createNativeMemoryStore(db)
const recorder = new ConversationRecorder({ db, characterId: kernel.characterId,
  conversationId: asConversationId('automatic-memory-fixture'), userId,
  dryRun: false, userName: 'Fixture', characterName: character.name, transport: 'verify',
  attribution: [createHumanConsoleUserTurnIngress()] })
const extractor = new LangMemMemoryExtractor({ python })
const makeConsumer = () => new AutomaticMemoryConsumer({ db, characterId: kernel.characterId, speaker,
  registry: kernel.registry, extractor, onReading: (reading) => readings.push(reading) })
let consumer = makeConsumer()
let sequence = 0
async function source(content: string) {
  const recorded = await recorder.recordUserMessage(content, ++sequence)
  assert.ok(recorded.event)
  return recorded.event
}
async function check(name: string, run: () => Promise<void> | void) {
  try { await run(); cases.push({ name, pass: true }); console.log(`PASS ${name}`) }
  catch (error) { cases.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) }); console.log(`FAIL ${name}`) }
}
try {
  await check('default off and zero historical backfill', async () => {
    assert.equal(readKernelFlags({}).memoryAutomaticEnabled, false)
    await source('我目前在示科读书。')
    await consumer.open(); await consumer.drain()
    assert.equal((await store.list({ owner, limit: 100 })).length, 0)
  })
  await check('ordinary factual statement persists through the native pipeline', async () => {
    await source('我目前在示科读书。'); await consumer.drain()
    const records = await store.list({ owner, status: 'active', limit: 100 })
    assert.equal(records.length, 1)
    assert.ok(JSON.stringify(records[0]!.content).includes('示科'))
    assert.ok(records[0]!.sourceRefs.length > 0)
  })
  await check('repeat statement does not duplicate memory', async () => {
    await source('我目前在示科读书。'); await consumer.drain()
    assert.equal((await store.list({ owner, status: 'active', limit: 100 })).length, 1)
  })
  await check('a differing automatic slot value cannot dispute or overwrite an accepted fact', async () => {
    await source('我现在在南京大学读书。'); await consumer.drain()
    const records = await store.list({ owner, status: 'active', limit: 100 })
    assert.equal(records.length, 1)
    assert.ok(JSON.stringify(records[0]!.content).includes('示科'))
    assert.equal(readings.at(-1)?.created, 0)
  })
  await check('stable preference persists without an explicit remember command', async () => {
    await source('我一直不吃香菜，吃饭都要避开。'); await consumer.drain()
    assert.ok((await store.list({ owner, status: 'active', limit: 100 })).some((record) => record.type === 'preference'))
  })
  await check('unconfirmed program input is excluded before calling the model', async () => {
    const event = await source('随便聊聊。')
    const before = modelCalls
    const result = await extractor.process({ owner, speaker, views: [{ ...processorEventViewOf(event), trustedOrigin: undefined }] })
    assert.equal(result.candidates.length, 0)
    if (!live) assert.equal(modelCalls, before)
    await consumer.drain()
  })
  for (const [name, text] of [
    ['question', '我是不是在示科读书？'],
    ['quotation', '朋友说：“我住在北京。”这是他的情况。'],
    ['hypothetical', '假如我住在上海，通勤会很方便。'],
    ['fiction', '我们写个故事，主角是个喜欢爵士乐的学生。'],
    ['temporary state', '今天午饭吃了面，现在有点困。'],
  ]) await check(`${name} creates no memory`, async () => {
    const before = (await store.list({ owner, limit: 100 })).length
    await source(text!); await consumer.drain()
    assert.equal((await store.list({ owner, limit: 100 })).length, before)
    assert.equal(readings.at(-1)?.status, 'completed')
  })
  await check('important reported episode persists without claiming shared experience', async () => {
    await source('我的毕业答辩通过了，准备了一整年，这是我今年最重要的事情。'); await consumer.drain()
    const episodes = (await store.list({ owner, limit: 100 })).filter((record) => record.type === 'episode')
    assert.equal(episodes.length, 1)
    assert.equal(episodes[0]!.content.kind, 'episode')
    if (episodes[0]!.content.kind === 'episode') assert.ok(episodes[0]!.content.participants.every((participant) => participant.kind === 'user'))
  })
  await check('explicit forgetting prevents automatic revival of the same fact', async () => {
    const record = (await store.list({ owner, status: 'active', limit: 100 })).find((record) => record.type === 'person_fact')!
    const event = await source('忘掉我在哪个学校读书。')
    const validator = createMemoryMutationValidator({ registry: kernel.registry,
      sources: { findEvents: (ids) => findEventRefs(db, ids as never) }, processed: { hasProcessed: (key) => hasProcessedOperation(db, key) },
      lookup: { findActiveByFingerprint: async () => undefined, findActiveByCanonicalKey: async () => [], getRecord: async (id) => (await store.get(id)) ?? undefined } })
    const result = await validator.validate({ characterId: kernel.characterId, owner, candidates: [], operation: 'retract', mutation: 'explicit',
      triggeredByEventId: event.id, target: { memoryId: record.id, reason: 'explicit_forget' } })
    assert.equal(result.accepted.length, 1)
    for (const domainEvent of (await applyAcceptedEvents(db, kernel.characterId, result.accepted, [], Date.now())).domainEvents) await store.apply(domainEvent)
    await consumer.drain()
    await source('我目前在示科读书。'); await consumer.drain()
    assert.equal((await store.get(record.id))!.status, 'retracted')
    assert.equal(readings.at(-1)?.created, 0)
  })
  if (!live) {
    await check('verbatim evidence check rejects invented quote', async () => {
      mode = 'bad-quote'
      await source('我目前在示科读书。'); await consumer.drain()
      assert.equal(readings.at(-1)?.status, 'completed')
      assert.ok(readings.at(-1)!.rejected > 0)
    })
    await check('malformed schema fails without trustcall repair requests', async () => {
      mode = 'malformed'; const before = modelCalls
      const event = await source('我目前在示科读书。'); await consumer.drain()
      assert.equal(modelCalls - before, 1)
      assert.equal(readings.at(-1)?.status, 'failed')
      assert.ok((await getWatermark(db, kernel.characterId, AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION))!.processedThroughSequence < event.sequence)
    })
    await check('failed source recovers in same process on a fresh notification', async () => {
      mode = 'valid'; await source('随便聊聊。'); await consumer.drain()
      assert.equal(readings.at(-1)?.status, 'completed')
      const jobs = (await listJobs(db, kernel.characterId, { limit: 100 })).filter((job) => job.processor === AUTOMATIC_MEMORY_PROCESSOR)
      assert.ok(jobs.some((job) => job.status === 'failed'))
    })
    await check('consumer restart preserves cutover and does not replay completed model calls', async () => {
      await consumer.close(); const before = modelCalls
      consumer = makeConsumer(); await consumer.open(); await consumer.drain()
      assert.equal(modelCalls, before)
    })
    await check('shutdown fences a late result and leaves its source recoverable', async () => {
      await consumer.close()
      const watermark = await getWatermark(db, kernel.characterId, AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION)
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>((done) => { enter = done })
      const delayed = new Promise<void>((done) => { release = done })
      const held = new AutomaticMemoryConsumer({ db, characterId: kernel.characterId, speaker, registry: kernel.registry,
        extractor: { name: AUTOMATIC_MEMORY_PROCESSOR, version: AUTOMATIC_MEMORY_VERSION,
          process: async () => { enter(); await delayed; return { candidates: [], rejected: [], extracted: false } } },
        onReading: (reading) => readings.push(reading) })
      await held.open(); await source('稍后再聊。')
      const draining = held.drain(); await entered
      const closing = held.close(); release(); await closing; await draining
      assert.equal((await getWatermark(db, kernel.characterId, AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION))!.processedThroughSequence,
        watermark!.processedThroughSequence)
      assert.equal(readings.at(-1)?.status, 'failed')
      consumer = makeConsumer(); await consumer.open(); await consumer.drain()
      assert.equal(readings.at(-1)?.status, 'completed')
    })
    await check('transport failure stops at three attempts and never skips the failed source', async () => {
      mode = 'transport-failure'; await source('我目前在示科读书。')
      const before = modelCalls
      await consumer.drain(); await consumer.drain(); await consumer.drain(); await consumer.drain()
      assert.equal(modelCalls - before, 3)
      assert.equal(readings.at(-1)?.status, 'retry_exhausted')
    })
  }
} finally {
  await consumer.close()
  await runtime.stop()
  await runtime.adapter?.close()
  cleanupSandbox(sandbox.dir)
}
if (!live) await check('real main bridge triggers one shared automatic-memory consumer', async () => {
  mode = 'valid'
  const isolated = isolateDatabase('automatic-memory-main', { keep: true })
  const featureFlags = Object.fromEntries([...readFileSync('src/kernel/app/flags.ts', 'utf8').matchAll(/env\.(CHARACTER_[A-Z_]+_ENABLED)/g)].map((match) => [match[1]!, 'false']))
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--bridge'], {
    windowsHide: true, env: { ...process.env, ...featureFlags, CHARACTER_MEMORY_ENABLED: 'true',
      CHARACTER_MEMORY_EXPLICIT_ENABLED: 'true', CHARACTER_MEMORY_AUTOMATIC_ENABLED: 'true', CHARACTER_MEMORY_AUTOMATIC_PYTHON: python,
      CHARACTER_MEMORY_SEMANTIC_MODE: 'off', CHARACTER_AFFECT_SEMANTIC_MODE: 'rules', CHARACTER_ROLLUP_TOKENS: '0',
      CHARACTER_GOAL_TOKENS: '0', CHARACTER_COMMITMENT_TOKENS: '0', CHARACTER_EXPRESSIVE_MODULATION: 'false',
      PGLITE_DATA_DIR: isolated.dir, PROJECT_LG_SANDBOX: isolated.dir, OPENAI_SMALL_MODEL: 'fixture', USER_NAME: 'AutomaticMainFixture', LOG_LEVEL: 'info' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  let reply = false
  let writes = false
  let tail = ''
  const ended = new Promise<number | null>((done) => child.once('close', done))
  const timeout = setTimeout(() => child.kill(), 90_000)
  const inspect = (line: string) => {
    tail = (tail + line).slice(-1200)
    if (line.includes('TURN_RESULT')) reply = true
    if (line.includes('[automatic-memory]') && /"created":\s*1/u.test(line)) writes = true
    if (reply && writes) child.stdin.end()
  }
  lines.on('line', inspect)
  child.stderr.on('data', (chunk) => inspect(String(chunk)))
  child.stdin.write(JSON.stringify({ kind: 'SUBMIT_TURN', requestId: 'automatic-main-1', userText: '我目前在示科读书。' }) + '\n')
  try {
    assert.equal(await ended, 0, tail)
    assert.ok(reply && writes)
    const reopened = await openRawPGlite(isolated.dir)
    try {
      assert.equal((await reopened.query("select * from memory_records where status = 'active'")).rows.length, 1)
      assert.equal((await reopened.query("select * from processor_watermarks where processor = 'automatic-memory-langmem'")).rows.length, 1)
    } finally { await reopened.close() }
  } finally { clearTimeout(timeout); lines.close(); cleanupSandbox(isolated.dir) }
})
fixture.closeAllConnections()
await new Promise<void>((done) => fixture.close(() => done()))
writeFileSync(resolve(evidenceRoot, 'result.json'), JSON.stringify({ live, passed: cases.filter((c) => c.pass).length,
  failed: cases.filter((c) => !c.pass).length, fixtureModelCalls: live ? undefined : modelCalls,
  realModelCallCount: live ? 'NOT_MEASURED' : 0, cases, readings, productionDbOpened: false }, null, 2))
if (cases.some((c) => !c.pass)) process.exitCode = 1
