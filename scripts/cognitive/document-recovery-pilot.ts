/** Frozen developmental comparison, synthetic real PDFs; no injected reader failures. */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createDocumentReadingBed } from './document-reading-bed.ts'
import { runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'
import { createOpenAiToolDecisionPort } from '../../src/infrastructure/model/openai-tool-decision.ts'
import { DOCUMENT_EXTRACT } from '../../src/kernel/contracts/document-reading.ts'

const arg = (key: string) => process.argv[process.argv.indexOf(key) + 1]
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
interface Job { id: string; marker: string; decision: unknown }
if (process.argv.includes('--arm')) {
  const arm = arg('--arm') as 'current' | 'static' | 'model'
  assert.ok(['current','static','model'].includes(arm))
  const jobPath = resolve(arg('--job')), job = JSON.parse(readFileSync(jobPath, 'utf8')) as Job
  const bed = await createDocumentReadingBed(`pilot-${job.id}-${arm}`)
  try {
    const trainingStarted = Date.now(); await bed.train()
    const trainingMs = Date.now() - trainingStarted, trainingActions = bed.calls()
    const started = Date.now(), outcome = await bed.run(bed.file(job.id, job.marker), arm, { viaTurn: true, decision: job.decision })
    const content = outcome?.results.flatMap(r => r.result.turnContent ?? []).map(c => c.text).join('\n') ?? ''
    const achieved = job.marker.length > 0 && content.includes(job.marker)
    writeFileSync(`${jobPath}.${arm}.json`, JSON.stringify({ arm, achieved, falseCompletion: outcome?.stopped === 'done' && !achieved,
      extractionAvailable: content.trim().length > 0, actions: outcome?.actionsUsed ?? 0, elapsedMs: Date.now() - started,
      stopped: outcome?.stopped ?? 'no_task', trainingMs, trainingActions,
      simulations: outcome?.simulationsUsed ?? 0, comparisons: outcome?.comparisons?.map(c => c.verdict) ?? [],
      errors: outcome?.epistemicFailures ?? 0, readers: outcome?.results.map(r => r.request.arguments.reader) ?? [] }, null, 2))
  } finally { await bed.stop() }
} else {
  assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1')
  assert.ok(process.env.SERVERSIM_MARKER?.startsWith('lg-serversim@'))
  const protocolPath = resolve(arg('--protocol')), rawProtocol = readFileSync(protocolPath, 'utf8')
  const protocol = JSON.parse(rawProtocol) as { version: string; frozen: boolean; sourceFingerprint: string; seed: string; maxTotalTokens: number; maxCompletionTokens: number }
  assert.equal(protocol.version, 'document-recovery-pilot@1'); assert.equal(protocol.frozen, true)
  const directory = resolve(dirname(protocolPath), 'pilot'); mkdirSync(directory, { recursive: true })
  closeSync(openSync(resolve(directory, 'started.lock'), 'wx'))
  assert.equal(JSON.parse(readFileSync(arg('--source'), 'utf8')).sourceFingerprint, protocol.sourceFingerprint)
  const endpoint = new URL(process.env.OPENAI_BASE_URL!), model = process.env.OPENAI_SMALL_MODEL!
  assert.ok(!['localhost','127.0.0.1'].includes(endpoint.hostname))
  const admin = process.env.LG_SIM_PGTEST_ADMIN_URL!; assert.ok(admin)
  let tokens = 0, attempts = 0, status = 'RUNNING'
  const rows: Array<Record<string, unknown>> = []
  const persist = () => writeFileSync(resolve(directory, 'report.json'), JSON.stringify({ status, protocol, protocolSha256: hash(rawProtocol),
    endpointHost: endpoint.host, model, tokens, attempts, rows, location: 'serversim/simhost',
    database: 'fresh migrated pgtest database and role per document/arm',
    scope: 'three synthetic real PDF tasks, shared real role decision; bounded reader policy comparison, not full-agent or natural-document benefit',
    productionOpened: false }, null, 2))
  try {
    for (const [index, text] of ['Simple text source', 'Punctuation: value=41; exact (token) \\ root', ''].entries()) {
      const id = `D${index+1}`, marker = text ? `${text} ${hash(protocol.seed + id).slice(0,12)}` : ''
      let used: number | undefined
      const port = createOpenAiToolDecisionPort({ timeoutMs: 60_000, fetchImpl: async (url, init) => {
        attempts++
        const request = JSON.parse(String(init?.body)); request.max_tokens = protocol.maxCompletionTokens
        const response = await fetch(url, { ...init, body: JSON.stringify(request) })
        if (response.ok) used = (await response.clone().json() as { usage?: { total_tokens?: number } }).usage?.total_tokens
        return response
      } })
      const started = Date.now(), decision = await port.decide({ text: `帮我读取「/tmp/${id}.pdf」的正文`, recentLines: [],
        catalog: 'document.extract/read：只读指定 PDF。args 为 path（用户指定的绝对路径）、reader（markitdown 或 pdfminer）。',
        allowedCapabilities: [DOCUMENT_EXTRACT], hasOpenTask: false, taskBudgetAvailable: true })
      assert.ok(decision.ok, 'real role request failed; no automatic retry')
      assert.ok(Number.isSafeInteger(used) && used! > 0, 'missing usage; stop measurement')
      tokens += used!; assert.ok(tokens <= protocol.maxTotalTokens, 'pilot token budget reached')
      const path = resolve(directory, `${id}.json`)
      writeFileSync(path, JSON.stringify({ id, marker, decision: decision.raw } satisfies Job, null, 2))
      const row: Record<string, unknown> = { id, category: marker ? 'extractable_text' : 'empty_pdf_negative_control', modelMs: Date.now()-started, tokens: used }
      rows.push(row); persist()
      for (const arm of ['current','static','model']) {
        const saved = process.argv
        try {
          process.argv = [saved[0]!, saved[1]!, '--arm', arm, '--job', path]
          await runPreparedPgGateInInstance(admin, `document-pilot-${id}-${arm}`, 'scripts/cognitive/document-recovery-pilot.ts')
        } finally { process.argv = saved }
        row[arm] = JSON.parse(readFileSync(`${path}.${arm}.json`, 'utf8')); persist()
      }
    }
    status = 'COMPLETE'
  } catch (error) { status = 'FAILED'; rows.push({ failure: String(error) }); throw error }
  finally { persist() }
}
