import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupSandbox } from '../src/dev/sandbox.ts'
import { runM111PrivateWorker } from './m11.1-private-worker.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'

async function main() {
  if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Test model wrapper required')
  const root = resolve('artifacts/m11.1/local/corpus-proposed-v1')
  const status = JSON.parse(readFileSync(join(root, 'review-status.json'), 'utf8'))
  const bytes = readFileSync(join(root, 'behavior.json'))
  const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  if (status.status !== 'FROZEN / HUMAN REVIEWED' || sha(bytes) !== status.behaviorSha256 || sha(readFileSync(join(root, 'semantic.json'))) !== status.semanticSha256) throw new Error('Frozen reviewed corpus required')
  const corpus = JSON.parse(bytes.toString('utf8')) as { caseId: string; slot: string; class: string; preparation: string[] }[]
  const selected = ['clarify_when_ambiguous', 'acknowledge_correction_first'].flatMap(slot => corpus.filter(item => item.slot === slot && item.class === 'legal').slice(0, 6))
  const started = new Date().toISOString(), head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'm111-short-live', headShort: head })
  const privateDir = resolve('artifacts/m11.1/local', runId)
  execFileSync('git', ['check-ignore', '--quiet', privateDir])
  mkdirSync(privateDir, { recursive: true })
  const readings: Record<string, unknown>[] = []
  // Serial workers share the initial batch reservation ledger, with one request per job.
  for (const item of selected) {
    const id = `short-${randomBytes(6).toString('hex')}`
    const input = join(privateDir, `${id}-input.json`), output = join(privateDir, `${id}-output.json`)
    writeFileSync(input, JSON.stringify({ ...item, caseId: `short-${item.caseId}`, round: 1, semanticSha256: status.semanticSha256, behaviorSha256: status.behaviorSha256 }))
    try {
      const observed = await runM111PrivateWorker('short', id, input, output, 'C', false)
      const result = observed.output
      readings.push({ caseId: item.caseId, exitCode: observed.exitCode, actualRequests: result.preparationRequests ?? 0,
        cleanClose: result.cleanClose === true, formatValid: result.formatValid === true, roots: result.actualRoots ?? null,
        conversations: result.actualConversations ?? null, scheduling: result.scheduling, modelVersion: result.modelVersion, promptVersion: result.promptVersion,
        pass: observed.exitCode === 0 && result.cleanClose === true && result.preparationRequests === 1 && result.formatValid === true })
    } finally { cleanupSandbox(join(tmpdir(), `project-lg-exp-m111-behavior-${id}`)) }
    console.log(JSON.stringify({ runId, completed: readings.length, passed: readings.filter(row => row.pass).length }))
  }
  const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  writeFileSync(join(dir, 'readings.json'), JSON.stringify(readings, null, 2) + '\n')
  const passed = readings.filter(row => row.pass).length
  const paths = ['scripts/m11.1-short-live.ts', 'scripts/m11.1-behavior-worker.ts', 'scripts/m11.1-private-worker.ts', 'src/infrastructure/model/openai-reflection.ts', 'src/infrastructure/persistence/reflection-input-source.ts', 'src/kernel/app/reflection/job.ts', 'src/infrastructure/runtime/reflection-runtime.ts', 'src/infrastructure/runtime/reflection-runner.ts']
  writeM11Manifest(dir, { runId, wp: 'M11.1-WP6', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'formal-real-candidate-short', phases: ['live'], supersedes: null,
    started, ended: new Date().toISOString(), counts: { total: 12, passed, failed: 12 - passed }, plannedRequests: 12,
    actualRequests: readings.reduce((n, row) => n + Number(row.actualRequests), 0), verdict: passed === 12 ? 'PASS' : 'FAIL', cleanClose: readings.every(row => row.cleanClose),
    environment: 'isolated-test-model', capabilityImpact: 'NONE', corpusSha256: status.behaviorSha256,
    model: process.env.OPENAI_SMALL_MODEL, endpointHost: new URL(process.env.OPENAI_BASE_URL!).host,
    sourceFingerprints: Object.fromEntries(paths.map(path => [path, sha(readFileSync(path))])),
    limitation: '12 real candidate requests through common open/scheduler/runner. Not dialogue behavior, full G5, goal-slot integration, or 200-turn proof.' })
  console.log(JSON.stringify({ runId, passed, failed: 12 - passed }, null, 2))
  process.exit(passed === 12 ? 0 : 1)
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Short runner failed'); process.exit(1) })
