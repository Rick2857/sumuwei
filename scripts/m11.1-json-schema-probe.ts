import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openM111ModelBatch } from './m11.1-model-batch.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'

if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Test model wrapper required; zero requests started')
const status = JSON.parse(readFileSync('artifacts/m11.1/local/corpus-proposed-v1/review-status.json', 'utf8'))
const batch = openM111ModelBatch({ semantic: status.semanticSha256, behavior: status.behaviorSha256 })
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm111-json-schema-compatibility', headShort: head })
const started = new Date().toISOString()
const finish = await batch.reserveWhenAvailable('short', 'json-schema-compatibility:20261003:strict-object@1')
let httpStatus: number | null = null, accepted = false, transportFailed = false
try {
  const response = await fetch(`${process.env.OPENAI_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000), body: JSON.stringify({ model: process.env.OPENAI_SMALL_MODEL, temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name: 'strict_compatibility', strict: true,
        schema: { type: 'object', properties: { compatible: { type: 'boolean', enum: [true] } }, required: ['compatible'], additionalProperties: false } } },
      messages: [{ role: 'user', content: '输出 JSON 对象，compatible 为 true；不要添加其它字段。' }] }) })
  httpStatus = response.status
  if (!response.ok) finish('transport_failed')
  else {
    const body = await response.json() as { choices?: { message?: { content?: string } }[] }
    finish('returned')
    try { const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? ''); accepted = parsed.compatible === true && Object.keys(parsed).length === 1 } catch { /* Invalid body is a failed compatibility reading. */ }
  }
} catch { transportFailed = true; finish('transport_failed') }
const reading = { httpStatus, accepted, transportFailed, actualRequests: 1, retries: 0,
  limitation: 'One minimal strict-schema request; a successful response would not prove enforcement or full Reflection schema compatibility. No runtime format switch.' }
const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
writeFileSync(join(dir, 'reading.json'), JSON.stringify(reading, null, 2) + '\n')
writeM11Manifest(dir, { runId, wp: 'M11.1-WP5', head, headShort: head.slice(0, 12), branch: 'main', date: started.slice(0, 10),
  toolVersions: { node: process.version }, testType: 'endpoint-json-schema-compatibility', phases: ['compatibility'], supersedes: null,
  started, ended: new Date().toISOString(), counts: { total: 1, passed: Number(accepted), failed: Number(!accepted) },
  plannedRequests: 1, actualRequests: 1, cleanClose: true, environment: 'test-model-no-database', capabilityImpact: 'NONE',
  verdict: accepted ? 'MINIMAL REQUEST ACCEPTED' : 'MINIMAL REQUEST NOT ACCEPTED', endpointHost: new URL(process.env.OPENAI_BASE_URL!).host,
  model: process.env.OPENAI_SMALL_MODEL, limitation: reading.limitation,
  sourceFingerprints: Object.fromEntries(['scripts/m11.1-json-schema-probe.ts', 'scripts/m11.1-model-batch.ts'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) })
console.log(JSON.stringify({ runId, ...reading }))
