/** Paired selector experiment: one real candidate pool, independent PG/file beds per arm. */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createFilePlanningBed, scoreFileTask } from './file-planning-bed.ts'
import { createSimulationTaskPlanner, type SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { contentFingerprint } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import type { TaskPlan, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import { extractTaskPlanJson } from '../../src/kernel/action/task-plan.ts'
import { runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const arg = (name: string) => process.argv.indexOf(name) < 0 ? undefined : process.argv[process.argv.indexOf(name) + 1]
interface Job { id: string; task: string; path: string; content: string; candidates: TaskPlan[] }
interface ArmResult { arm: string; achieved: boolean; falseCompletion: boolean; actions: number; executions: number; plans: number;
  bytesMatch: boolean; readMatched: boolean; elapsedMs: number; selectedIndex?: number; selectionReason?: string; stopped: string; comparisons: string[] }

if (process.argv.includes('--arm')) {
  const arm = arg('--arm')!
  assert.ok(['A', 'B'].includes(arm))
  const job = JSON.parse(readFileSync(arg('--job')!, 'utf8')) as Job
  const bed = await createFilePlanningBed(`live-${job.id}-${arm}`)
  try {
    let selection: SimulationPlanSelection | undefined
    const source = { id: 'shared-real-pool', endpointHost: 'cached-test-model', async propose() {
      return { candidates: job.candidates, requestCount: 1 }
    } }
    const planner: TaskPlannerPort = arm === 'A'
      ? { id: source.id, endpointHost: source.endpointHost, async plan() {
        return { ok: true, requestCount: 1, plan: job.candidates[0]! }
      } }
      : createSimulationTaskPlanner({ ...bed.modelOptions, registry: bed.registry,
        goal: { path: job.path, expectedFingerprint: contentFingerprint(job.content) }, candidateSource: source,
        onSelection: value => { selection = value },
      })
    const started = Date.now()
    const outcome = await bed.run(planner, { text: job.task })
    const result: ArmResult = { arm, ...scoreFileTask(outcome, { root: bed.root, path: job.path, content: job.content }),
      actions: outcome.actionsUsed, executions: outcome.results.length, plans: outcome.plansUsed, elapsedMs: Date.now() - started,
      stopped: outcome.stopped, comparisons: (outcome.comparisons ?? []).map(item => item.verdict),
      ...(selection?.selectedIndex === undefined ? {} : { selectedIndex: selection.selectedIndex }),
      ...(selection === undefined ? {} : { selectionReason: selection.reason }),
    }
    writeFileSync(`${arg('--job')!}.${arm}.json`, JSON.stringify(result, null, 2))
  } finally { await bed.stop() }
} else {
  assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', 'real_test_model_wrapper_required')
  assert.ok(process.env.SERVERSIM_MARKER?.startsWith('lg-serversim@'), 'serversim_required')
  const protocolPath = resolve(arg('--protocol')!)
  const protocolText = readFileSync(protocolPath, 'utf8')
  const protocol = JSON.parse(protocolText) as { version: string; segment: 'dev' | 'heldout'; frozen: boolean;
    count: number; seed: string; sourceFingerprint: string; maxTotalTokens: number; maxCompletionTokens: number; pilotReportSha256?: string;
    candidateCache?: { directory: string; reportSha256: string } }
  assert.equal(protocol.version, 'file-selector-experiment@2')
  assert.equal(protocol.frozen, true)
  assert.ok(Number.isSafeInteger(protocol.count) && protocol.count > 0 && protocol.count <= 16)
  assert.ok(Number.isSafeInteger(protocol.maxCompletionTokens) && protocol.maxCompletionTokens > 0 && protocol.maxCompletionTokens <= 8000)
  if (protocol.segment === 'heldout') assert.match(protocol.pilotReportSha256 ?? '', /^[a-f0-9]{64}$/)
  if (protocol.candidateCache) {
    assert.equal(protocol.segment, 'dev', 'heldout_cannot_use_development_cache')
    assert.equal(hash(readFileSync(resolve(protocol.candidateCache.directory, 'report.json'), 'utf8')), protocol.candidateCache.reportSha256)
  }
  const directory = resolve(dirname(protocolPath), `live-${protocol.segment}`)
  mkdirSync(directory, { recursive: true })
  closeSync(openSync(resolve(directory, 'started.lock'), 'wx')) // No silent rerun of the same frozen segment.
  const probe = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs',
    'scripts/cognitive/source-fingerprint.ts', '--out', resolve(directory, 'source.json')], { encoding: 'utf8' })
  assert.equal(probe.status, 0)
  assert.equal(JSON.parse(readFileSync(resolve(directory, 'source.json'), 'utf8')).sourceFingerprint, protocol.sourceFingerprint)
  const endpoint = process.env.OPENAI_BASE_URL!
  const model = process.env.OPENAI_LARGE_MODEL!
  assert.notEqual(new URL(endpoint).hostname, '127.0.0.1', 'real_endpoint_required')
  const admin = process.env.LG_SIM_PGTEST_ADMIN_URL!
  assert.ok(admin, 'isolated_pgtest_admin_required')
  const rows: Array<{ id: string; status: string; modelMs: number; tokens?: number; A?: ArmResult; B?: ArmResult; failure?: string }> = []
  let totalTokens = 0, status = 'RUNNING'
  const persist = () => writeFileSync(resolve(directory, 'report.json'), JSON.stringify({
    status, protocolSha256: hash(protocolText), protocol, sourceFingerprint: protocol.sourceFingerprint,
    execution: 'serversim/simhost', database: 'pgtest, fresh migrated v23 database and role per arm',
    model: { endpointHost: new URL(endpoint).host, model },
    modelRequestAttempts: protocol.candidateCache ? 0 : rows.length, totalTokens, rows,
    generationMode: protocol.candidateCache ? 'cached_real_development_pool' : 'fresh_real_model',
    metrics: {
      plannedPairs: protocol.count, measuredPairs: rows.filter(row => row.status === 'MEASURED').length,
      goalsA: rows.filter(row => row.A?.achieved).length, goalsB: rows.filter(row => row.B?.achieved).length,
      falseCompletionA: rows.filter(row => row.A?.falseCompletion).length, falseCompletionB: rows.filter(row => row.B?.falseCompletion).length,
      bOnlyWins: rows.filter(row => row.B?.achieved && !row.A?.achieved).length,
      aOnlyWins: rows.filter(row => row.A?.achieved && !row.B?.achieved).length,
      actionUnitsA: rows.reduce((sum, row) => sum + (row.A?.actions ?? 0), 0),
      actionUnitsB: rows.reduce((sum, row) => sum + (row.B?.actions ?? 0), 0),
    },
    evidenceScope: 'real-model-generated candidate pools; paired selector effect, not full autonomous-agent benefit',
    productionOpened: false,
  }, null, 2))
  try {
    for (let index = 0; index < protocol.count; index++) {
      const id = `${protocol.segment === 'dev' ? 'D' : 'H'}${String(index + 1).padStart(2, '0')}`
      const nonce = hash(`${protocol.seed}:${index}`).slice(0, 12)
      const content = [
        `核对码=${nonce}\n第二行：保持原样。\n`,
        `{"token":"${nonce}","label":"苏沐薇","ok":true}\n`,
        `note ${nonce}\nquoted: "a\\b"\nemoji: 🌿\n`,
        `  ${nonce}  \n\n末尾保留换行\n`,
      ][index % 4]!
      const path = `task-${nonce}.txt`
      const task = `只操作相对路径 ${path}。写入以下 JSON 字符串解码后的精确内容，再读回核对：${JSON.stringify(content)}。`
      const started = Date.now()
      const row: typeof rows[number] = { id, status: 'COLLECTING', modelMs: 0 }
      rows.push(row); persist()
      try {
        let pool: { candidates?: TaskPlan[] }
        if (protocol.candidateCache) {
          const cached = JSON.parse(readFileSync(resolve(protocol.candidateCache.directory, `${id}.job.json`), 'utf8')) as Job
          assert.equal(cached.path, path); assert.equal(cached.content, content); assert.equal(cached.task, task)
          pool = { candidates: cached.candidates }; row.tokens = 0
        } else {
        const response = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', signal: AbortSignal.timeout(45_000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model, temperature: 0, max_tokens: protocol.maxCompletionTokens, messages: [
            { role: 'system', content: '输出且只输出 JSON：{"candidates":[plan,plan,plan]}。提出3条均打算完整完成任务的候选，最佳放第一。每个plan恰好goal(字符串)、done(布尔)、steps(最多4步)。每步恰好capability、operation、args。只允许sandbox.file.write/write，args为path和content字符串；sandbox.file.read/read，args只有path。路径逐字采用用户给定相对路径；写入正文为用户指定字符串解码后的原文。不要声明任何已经执行过的动作。每条候选均须包含最终真实读回。' },
            { role: 'user', content: task },
          ] }),
        })
        row.modelMs = Date.now() - started
        assert.ok(response.ok, `http_${response.status}`)
        const body = await response.json() as { usage?: { total_tokens?: number }; choices?: { message?: { content?: string } }[] }
        assert.ok(Number.isSafeInteger(body.usage?.total_tokens) && body.usage!.total_tokens! > 0, 'token_measurement_missing')
        row.tokens = body.usage!.total_tokens!
        totalTokens += row.tokens
        assert.ok(totalTokens <= protocol.maxTotalTokens, 'token_budget_exceeded')
        pool = extractTaskPlanJson(body.choices?.[0]?.message?.content ?? '') as { candidates?: TaskPlan[] }
        }
        assert.ok(Array.isArray(pool.candidates) && pool.candidates.length === 3, 'candidate_pool_invalid')
        const jobPath = resolve(directory, `${id}.job.json`)
        writeFileSync(jobPath, JSON.stringify({ id, task, path, content, candidates: pool.candidates } satisfies Job))
        const saved = process.argv
        try {
          for (const arm of (index % 2 === 0 ? ['A', 'B'] : ['B', 'A']) as Array<'A' | 'B'>) {
            process.argv = [saved[0]!, saved[1]!, '--arm', arm, '--job', jobPath]
            await runPreparedPgGateInInstance(admin, `${protocol.segment}-${id}-${arm}`, 'scripts/cognitive/simulation-planner-live.ts')
            row[arm] = JSON.parse(readFileSync(`${jobPath}.${arm}.json`, 'utf8')) as ArmResult
          }
        } finally { process.argv = saved }
        row.status = 'MEASURED'
      } catch (error) {
        row.modelMs ||= Date.now() - started
        row.status = 'FAIL'
        row.failure = (error instanceof Error ? error.message : 'collection_failed').slice(0, 180)
        // Failed transport/format/measurement stays in the denominator; stop rather than resample.
        throw error
      } finally { persist() }
    }
    status = 'COMPLETE'
  } catch (error) { status = 'FAIL'; console.error(`Experiment stopped: ${(error as Error).message.slice(0, 180)}`) }
  persist()
  console.log(`file selector ${protocol.segment}: ${status}; ${directory}`)
  process.exitCode = status === 'COMPLETE' ? 0 : 1
}
