/** Regression for the actual main.ts maintenance entry, using a production copy only. */
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { createEncoderClient } from '../src/infrastructure/semantic/encoder-client.ts'
import { loadEmbeddingManifest } from '../src/infrastructure/semantic/embedding-manifest.ts'
import { createSemanticProbe } from '../src/infrastructure/semantic/semantic-probe.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { createRecallRequest } from '../src/kernel/contracts/recall.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { RENDERER_VERSION } from '../src/kernel/app/recall/index-render.ts'
import { createM4Harness } from './m4-harness.ts'

const root = resolve(process.cwd())
const startedAt = new Date().toISOString()
const out = join(root, 'artifacts/post-lv2', `semantic-production-verify-${startedAt.replace(/[:.]/g, '-')}`)
mkdirSync(out, { recursive: true })
const realBefore = digestTree(join(root, 'data/pglite'))
const sandbox = isolateDatabase('semantic-production', { keep: true })
cpSync(join(root, 'data/pglite'), sandbox.dir, { recursive: true })
const copyBefore = digestTree(sandbox.dir)
if (copyBefore.treeSha256 !== realBefore.treeSha256) throw new Error('Production copy digest mismatch')
const checks: { name: string; pass: boolean; detail: unknown }[] = []
const check = (name: string, pass: boolean, detail: unknown = null) => {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
}
let stop: (() => Promise<void>) | undefined
const manifest = loadEmbeddingManifest(join(root, 'evals/m9.5/embedding-manifest.json'))
const encoder = createEncoderClient({ manifest, repoRoot: root,
  localModelPath: join(root, 'artifacts/m9.5/local/embedding-lab/models'),
  deadlineMs: 120_000, readyTimeoutMs: 180_000 })
try {
  const child = spawnSync(process.execPath, [createRequire(import.meta.url).resolve('tsx/cli'),
    'src/main.ts', '--maintain-index'], {
    cwd: root, env: { ...process.env }, encoding: 'utf8', windowsHide: true,
    timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  })
  writeFileSync(join(out, 'maintenance.log'), `${child.stdout ?? ''}\n${child.stderr ?? ''}`)
  check('Actual main.ts maintenance exits successfully', child.status === 0,
    { status: child.status, error: child.error?.message })
  const h = await createM4Harness({ label: 'semantic-production' })
  stop = () => h.stop()
  const namespace = String(h.characterId)
  const generations = rowsOf(await h.db.execute(sql`select generation_id, namespace, renderer_version,
    build_state from memory_semantic_generations order by created_at desc`))
  const serving = generations.filter(g => g.namespace === namespace && g.build_state === 'published' &&
    g.renderer_version === RENDERER_VERSION)
  const servingPasses = (rows: typeof generations) => rows.filter(g => g.namespace === namespace &&
    g.build_state === 'published' && g.renderer_version === RENDERER_VERSION).length === 1
  check('Actual entry publishes exactly one generation for the recall character',
    servingPasses(generations), { characterId: namespace, generations })
  check('Legacy production namespace generations are retained', generations.some(g => g.namespace === 'production'))
  check('Generation detector positive / negative / restore',
    servingPasses([{ namespace, build_state: 'published', renderer_version: RENDERER_VERSION }]) &&
    !servingPasses([{ namespace: 'production', build_state: 'published', renderer_version: RENDERER_VERSION }]) &&
    !servingPasses([]) && servingPasses([{ namespace, build_state: 'published', renderer_version: RENDERER_VERSION }]))
  if (serving.length !== 1) throw new Error('No serving generation for the actual recall character')
  const probe = createSemanticProbe({ db: h.db, manifest, encoder })
  const wrongCharacter = await probe.score({ characterId: 'other-character' as never, text: '我在哪里读书？', memoryIds: [] })
  check('Other character cannot consume the production index', !wrongCharacter.ok && wrongCharacter.reason === 'not_indexed')
  const service = createMemoryRecallService({ port: createMemoryRetrievalStore({ store: h.store,
    integrity: owner => memoryIntegrityProblems(h.db, owner),
    rootReadings: ids => rootReadingsByMemory(h.db, ids), semanticProbe: probe }) })
  const recall = createRecallTurnPort({ service, budget: DEFAULT_CONTEXT_BUDGET, now: () => Date.now() })
  // Targeted reproduction on the existing education claim, not a quality benchmark.
  const questions = ['我上学的院校叫什么？', '我就读的高等学府叫什么名字？',
    '我念书的地方是哪所高校？', '你记得我在哪所高校求学吗？', '我的母校是哪所？',
    '我读书的地方是不是示例城市的示例高校？', '我求学的地方是不是示例城市的示例高校？']
  let accepted: { question: string; memoryId: string; score: number; trace: unknown } | undefined
  const samples: unknown[] = []
  for (const question of questions) {
    const request = createRecallRequest({ traceId: 'semantic-production-reproduction', characterId: namespace,
      user: h.user, query: { text: question }, intent: 'current_fact', contextBudget: { memoryTokens: 500 },
      retrievalPolicyVersion: 'hybrid-relevance@1', semanticMode: 'on' })
    const retrieved = await service.retrieveCandidates(request)
    const outcome = await recall.run(request)
    const pure = retrieved.candidates.find(c => !c.retrievedBy.includes('lexical') &&
      typeof c.semanticScore === 'number' && outcome.trace.semanticUsedIds.includes(String(c.memoryId)))
    samples.push({ question, scoredCount: outcome.trace.semanticScoredCount,
      candidates: retrieved.candidates.map(c => ({ memoryId: String(c.memoryId), channels: c.retrievedBy, score: c.semanticScore })),
      selectedIds: outcome.trace.selectedIds })
    if (!pure) continue
    accepted = { question, memoryId: String(pure.memoryId), score: pure.semanticScore!, trace: outcome.trace }
    for (const mode of ['off', 'shadow'] as const) {
      const control = await recall.run({ ...request, semanticMode: mode })
      check(`${mode} does not admit the pure semantic candidate`, !control.trace.selectedIds.includes(accepted.memoryId))
    }
    break
  }
  check('Existing production claim reaches context through pure semantics', accepted !== undefined,
    { accepted, samples })
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
  check('Event maintenance also uses the recall character namespace',
    main.includes('namespace: String(kernel.characterId)') && !main.includes("namespace: 'production'"))
} catch (error) {
  check('Regression completes', false, error instanceof Error ? error.message : String(error))
} finally {
  await stop?.()
  await encoder.close()
  const after = digestTree(join(root, 'data/pglite'))
  check('Real database remains unchanged', after.treeSha256 === realBefore.treeSha256)
  writeFileSync(join(out, 'result.json'), JSON.stringify({ startedAt, completedAt: new Date().toISOString(),
    verdict: checks.length > 0 && checks.every(c => c.pass) ? 'PASS' : 'FAIL',
    measuredCount: checks.length, passed: checks.filter(c => c.pass).length, checks,
    sandbox: sandbox.dir, realDbOpened: false, sourceHashes: Object.fromEntries([
      'src/main.ts', 'scripts/postlv2-semantic-production-verify.ts',
    ].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])) }, null, 2) + '\n')
  console.log(`Evidence: ${out}`)
  if (checks.some(c => !c.pass)) process.exitCode = 1
}
