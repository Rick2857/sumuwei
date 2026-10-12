import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isolateDatabase, cleanupSandbox } from '../src/dev/sandbox.ts'
import { createM4Harness, M4_T0 } from './m4-harness.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { createRecallRequest } from '../src/kernel/contracts/recall.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'

const cases: string[] = []
const playerModule = await import(pathToFileURL(resolve('scripts/postlv2_speech_client.js')).href)
const nodes: { stopCount: number; onended?: () => void; buffer?: { duration: number }; at?: number }[] = []
const context = { currentTime: 0, state: 'running', resume: async () => {},
  createBuffer: (_: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel() {} }),
  createAnalyser: () => ({ connect() {}, disconnect() {} }),
  createBufferSource: () => {
    const node = { stopCount: 0, connect() {}, stop() { this.stopCount++ }, start(at: number) { Object.assign(this, { at }) } }
    nodes.push(node); return node
  } }
const expressions = { reading: () => ({ generation: 1, revoked: false }), canPlay: () => true, start: () => true, finish() {} }
let acknowledge!: (value: { status: string }) => void
let sends = 0
const core = new Promise(resolve => { acknowledge = resolve })
const player = playerModule.createSpeechPlayback(expressions, () => undefined, () => context,
  async (ids: string[]) => { assert.deepEqual(ids, ['avatar:fixture']); sends++; return core })
const meta = { segmentId: 'reply:fixture#0', requestId: 'avatar:fixture', generation: 1, text_sha256: 'fixture' }
const packet = { actions: { lg_expression: meta }, codec: 'pcm_f32le', sample_rate: 24000, index: 0,
  audio: Buffer.from(new Float32Array(24_000).fill(0.05).buffer).toString('base64'), final: true, failed: false }
assert.equal(player.feed(packet), true)
const playback = player.play(meta, () => {}, () => () => {})
assert.equal(player.play(meta, () => {}, () => () => {}), playback)
await delay(5)
assert.equal(nodes.length, 1)
cases.push('duplicate play shares one completion and one audio source')
let played = false
playback.then(() => { played = true })
assert.equal(played, false)
const interruption = player.interrupt()
assert.equal((await interruption.silenced).status, 'silent')
await playback
assert.equal(nodes[0]!.stopCount, 1)
assert.equal(player.reading().interruptions.at(-1).core, 'pending')
player.stop()
assert.equal(nodes[0]!.stopCount, 1)
assert.equal(player.feed(packet), false)
cases.push('local stop is idempotent and old audio cannot resurrect before core ACK')
acknowledge({ status: 'acknowledged' })
assert.equal((await interruption.done).status, 'acknowledged')
assert.equal(sends, 1)
cases.push('core ACK has a separate completion and truthful result')

const python = JSON.parse(execFileSync('python', ['-X', 'utf8', 'scripts/postlv2-voice-control-verify.py'], { encoding: 'utf8', timeout: 30_000 }).trim())
assert.equal(python.passed, python.checks)
cases.push('bounded Python speech queue and priority cancel use the real bridge wire reader')

const sandbox = isolateDatabase('oss-mechanisms', { keep: true })
const h = await createM4Harness({ label: 'oss-mechanisms' })
try {
  const seeds = [
    ['person_fact', 'education.major', '计算机'], ['person_fact', 'education.institution', '示例工程科技大学'],
    ['preference', 'food.preference.cilantro', 'dislike'], ['preference', 'preferred.address', 'Alex'],
  ] as const
  for (const [type, predicate, value] of seeds) {
    const source = await h.recordUserEvidence(`记住，${predicate} 是 ${value}`)
    assert.ok(await h.commitAndFold(h.makeCandidate(type,
      { kind: 'claim', subject: h.user, predicate, value }, { sourceRefs: [source.ref] }), M4_T0))
  }
  const service = createMemoryRecallService({ port: createMemoryRetrievalStore({ store: h.store,
    integrity: owner => memoryIntegrityProblems(h.db, owner), rootReadings: ids => rootReadingsByMemory(h.db, ids) }) })
  const options = { service, budget: DEFAULT_CONTEXT_BUDGET, now: () => M4_T0 + 10_000 }
  const port = createRecallTurnPort({ ...options, injectionLimit: 3 })
  const query = 'education.major education.institution food.preference.cilantro preferred.address'
  const request = createRecallRequest({ traceId: newTraceId(), characterId: String(h.kernel.characterId),
    user: h.user, query: { text: query }, intent: 'current_fact' })
  const original = await createRecallTurnPort(options).run(request)
  const bounded = await port.run(request)
  assert.equal(original.selection.entries.length, 4)
  assert.equal(bounded.selection.entries.length, 3)
  assert.equal(bounded.record.metrics.exclusionHistogram.INJECTION_LIMIT, 1)
  assert.equal(bounded.trace.dispositions.length, 4)
  cases.push('three related native facts enter context; excluded fact has a distinct audited reason')
  const wrongUser = await port.run({ ...request, user: entityRef('user', 'other-user') })
  const wrongNamespace = await port.run({ ...request, characterId: 'other-character' as typeof request.characterId })
  assert.equal(wrongUser.selection.entries.length + wrongNamespace.selection.entries.length, 0)
  cases.push('native user and character scope qualification remains before shortlisting')
  const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
    recorder: h.recorder, conversationSequence: () => 0, recentLimit: 16, slowPathEnabled: false, dryRun: true,
    userId: h.userId, recall: port, recallEnabled: true })
  const compiled = await gateway.compileTurn({ turn: { traceId: newTraceId(), conversationSequence: 0 }, currentInput: query, recentLines: [] })
  assert.equal(compiled.sections.find(section => section.id === 'memory-recall')?.sourceRefs?.length, 3)
  cases.push('real TurnGateway compiles the bounded memory block with three source references')
} finally { await h.stop(); await h.runtime.adapter?.close(); cleanupSandbox(sandbox.dir) }
const directory = join('artifacts/post-lv2/oss-mechanisms', `run-${Date.now()}`)
mkdirSync(directory, { recursive: true })
const result = { passed: cases.length, failed: 0, cases, python, modelCalls: 0,
  productionDatabaseOpened: false, speechPerformanceAcceptance: 'NOT RUN', personalityBenefitEvaluation: 'NOT RUN' }
writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
