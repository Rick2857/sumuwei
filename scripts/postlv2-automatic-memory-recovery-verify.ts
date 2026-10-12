import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createM4Harness } from './m4-harness.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { AutomaticMemoryConsumer, type AutomaticMemoryReading } from '../src/infrastructure/runtime/automatic-memory.ts'
import { authorizeAutomaticMemoryRetry, readAutomaticMemoryHealth } from '../src/infrastructure/runtime/automatic-memory-control.ts'
import { AUTOMATIC_MEMORY_PROCESSOR, AUTOMATIC_MEMORY_VERSION } from '../src/infrastructure/model/langmem-memory-extractor.ts'
import { listJobs } from '../src/infrastructure/persistence/job-store.ts'
import { isolateDatabase, cleanupSandbox } from '../src/dev/sandbox.ts'

const sandbox = isolateDatabase('automatic-memory-recovery', { keep: true })
const h = await createM4Harness({ label: 'automatic-memory-recovery' })
const db = h.kernel.stores.db
const speakerId = await h.recorder.ensureIdentity()
const readings: AutomaticMemoryReading[] = []
const cases: { name: string; pass: boolean }[] = []
const check = (name: string, pass: boolean) => { cases.push({ name, pass }); assert.ok(pass, name) }
let calls = 0
let failed = true
let sequence = 1
const makeConsumer = () => new AutomaticMemoryConsumer({ db, characterId: h.kernel.characterId,
  speaker: entityRef('user', speakerId), registry: h.kernel.registry, onReading: reading => readings.push(reading),
  extractor: { name: AUTOMATIC_MEMORY_PROCESSOR, version: AUTOMATIC_MEMORY_VERSION, process: async () => {
    calls++; if (failed) throw new Error('fixture failure')
    return { candidates: [], rejected: [], extracted: false }
  } } })
let consumer = makeConsumer()
try {
  check('health does not initialize or backfill', (await readAutomaticMemoryHealth(db, h.kernel.characterId)).status === 'not_initialized')
  await consumer.open(); await consumer.drain()
  await h.recorder.recordUserMessage('隔离来源一。', sequence++)
  await consumer.drain(); await consumer.drain(); await consumer.drain(); await consumer.drain()
  let health = await readAutomaticMemoryHealth(db, h.kernel.characterId)
  check('three failures block the exact source', calls === 3 && health.status === 'retry_exhausted' && health.pendingEvents === 1)
  if (health.status !== 'retry_exhausted') throw new Error('fixture not blocked')
  const blocked = health.sourceSequence!
  const failedJobs = (await listJobs(db, h.kernel.characterId, { status: 'failed' })).map(j => j.id)
  failed = false
  await h.recorder.recordUserMessage('隔离来源二。', sequence++)
  await consumer.drain()
  check('provider recovery alone cannot grant attempts or skip source', calls === 3)
  await consumer.close(); consumer = makeConsumer(); await consumer.open(); await consumer.drain()
  check('restart alone cannot reset the failure budget', calls === 3)
  await assert.rejects(authorizeAutomaticMemoryRetry(db, h.kernel.characterId, blocked + 1, true), /source_not_blocked/)
  check('wrong source is rejected', true)
  const preview = await authorizeAutomaticMemoryRetry(db, h.kernel.characterId, blocked)
  check('preview grants nothing and preserves watermark', !preview.applied && preview.health.throughSequence === health.throughSequence)
  await authorizeAutomaticMemoryRetry(db, h.kernel.characterId, blocked, true)
  await assert.rejects(authorizeAutomaticMemoryRetry(db, h.kernel.characterId, blocked, true), /source_not_blocked/)
  check('unconsumed authorization cannot be duplicated', true)
  await consumer.close(); consumer = makeConsumer(); await consumer.open(); await consumer.drain()
  health = await readAutomaticMemoryHealth(db, h.kernel.characterId)
  check('durable grant resumes original source then the next source', calls === 5 && health.status === 'ready' && health.pendingEvents === 0)
  const jobs = await listJobs(db, h.kernel.characterId, { limit: 100 })
  check('failed rows preserved and recovery audit exists', failedJobs.every(id => jobs.some(j => j.id === id && j.status === 'failed'))
    && jobs.some(j => j.processor === 'automatic-memory-operator-recovery' && j.status === 'completed'))
  const before = calls
  await consumer.close(); consumer = makeConsumer(); await consumer.open(); await consumer.drain()
  check('completed source is not replayed on restart', calls === before)
  failed = true; await h.recorder.recordUserMessage('隔离来源三。', sequence++)
  await consumer.drain(); await consumer.drain(); await consumer.drain()
  health = await readAutomaticMemoryHealth(db, h.kernel.characterId)
  if (health.status !== 'retry_exhausted') throw new Error('fixture not blocked again')
  const repeated = health.sourceSequence!
  for (let i = 0; i < 3; i++) {
    const oldCalls = calls
    await authorizeAutomaticMemoryRetry(db, h.kernel.characterId, repeated, true)
    await consumer.drain(); await consumer.drain()
    check(`operator grant ${i + 1} permits only one extra failed attempt`, calls === oldCalls + 1)
  }
  await assert.rejects(authorizeAutomaticMemoryRetry(db, h.kernel.characterId, repeated, true), /recovery_limit/)
  check('three recovery grants remain exhausted across notifications', (await readAutomaticMemoryHealth(db, h.kernel.characterId)).status === 'retry_exhausted')
  await consumer.close(); await consumer.drain()
  check('closed consumer cannot spend another attempt', readings.at(-1)?.status === 'retry_exhausted')
} finally {
  await consumer.close()
  await h.stop()
  await h.runtime.adapter?.close()
}
try {
  const status = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'src/main.ts', '--automatic-memory-status'],
    { env: { ...process.env, OPENAI_API_KEY: 'offline-fixture' }, encoding: 'utf8', timeout: 60_000 })
  check('real main status reads durable exhaustion without model calls', status.status === 0
    && status.stdout.includes('"status": "retry_exhausted"') && status.stdout.includes('"recoveries": 3'))
} finally { cleanupSandbox(sandbox.dir) }
const directory = join('artifacts/post-lv2/automatic-memory-recovery', `run-${Date.now()}`)
mkdirSync(directory, { recursive: true })
writeFileSync(join(directory, 'result.json'), JSON.stringify({ cases, modelCalls: 0, productionDatabaseOpened: false, extractorCalls: calls }, null, 2))
console.log(JSON.stringify({ passed: cases.filter(c => c.pass).length, failed: cases.filter(c => !c.pass).length, cases }, null, 2))
