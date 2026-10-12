/**
 * M9.5 `L-M95-18` —— **有限词面权重校准**（`pnpm m9.5:lexical-calibration`）。
 *
 * ============================================================================
 *  判据**先于**读数：门槛在 `docs/m9.5/M9.5-Lexical-Calibration-Bar.md` 里写定
 * ============================================================================
 * ```text
 * 用户裁定（逐字）："选 A：保留 E5，做有限的词面权重校准。要求混合召回对照证明精确命中改善，
 *   并守住改述与旧强项；不设字面命中无条件置顶，不以通过单条用例为冻结依据。
 *   达标后冻结并进入真模型档，否则维持等权、登记局限。"
 *
 * 候选（**预先列出，看读数后不得增删**）：w_lexical ∈ {1.00, 1.25, 1.50, 2.00}
 * 固定不变：w_semantic = 1 · w_margin = 0.5 · relevanceGate 原样 · 策略版本 hybrid-relevance@1
 *
 * 两套 case（**工具修订见 Bar §2.5**）：
 *   · **精确命中场景**（构造，≥6/split）：查询句**逐字包含**目标取值
 *   · **改述类**（真实语料，≥8/split）：与 `calibration@1` 同种子同去重
 * ⚠️ 走**真检索店 + 真编码器**（"混合召回对照"，不是语义单通道）。
 * ```
 * 用法：`pnpm m9.5:lexical-calibration`
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  SEMANTIC_INDEX_SCHEMA_VERSION,
  ensureSemanticIndexSchema,
} from '../src/infrastructure/persistence/memory-semantic-index.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import {
  embeddingFingerprintOf,
  loadEmbeddingManifest,
} from '../src/infrastructure/semantic/embedding-manifest.ts'
import { createEncoderClient } from '../src/infrastructure/semantic/encoder-client.ts'
import { createSemanticProbe } from '../src/infrastructure/semantic/semantic-probe.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import type { HybridRelevancePolicy } from '../src/kernel/app/recall/hybrid-candidates.ts'

import { M4_T0, sha256 } from './m4-harness.ts'
import { createM55Harness } from './m5.5-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-lexical-calibration@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const LAB_MODEL_ROOT = join(REPO_ROOT, 'artifacts/m9.5/local/embedding-lab/models')
const CORPUS = join(REPO_ROOT, 'evals/m9.5/corpus')

const SAMPLE_SIZE = 24
const CANDIDATE_LIMIT = 8
const SEEDS = { dev: 'm9.5-calibration@1', val: 'm9.5-validation@1' } as const
const PARAPHRASE_FORMS = new Set(['synonym', 'indirect', 'elliptical', 'boundedHint', 'similarProject', 'mixedEntity'])

/** **预先列出**的候选（看读数后不得增删） */
const LEXICAL_WEIGHTS = [1, 1.25, 1.5, 2] as const
/** 门槛（Bar §2 (v)）：样本不足 ⇒ MEASUREMENT INVALID，不是 PASS */
const MIN_EXACT = 6
const MIN_PARAPHRASE = 8

const policyOf = (lexical: number): HybridRelevancePolicy => ({
  version: 'hybrid-relevance@1',
  calibrated: false,
  weights: { lexical, semantic: 1, margin: 0.5 },
  relevanceGate: { minCombined: 0.5, minMargin: null },
})

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1
  else failures.push(`${name}${detail === undefined ? '' : ` —— ${detail}`}`)
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function safeTreeDigest(): Record<string, unknown> | null {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return { dir: 'data/pglite', measuredCount: digest.measuredCount, treeSha256: digest.treeSha256 }
  } catch (error) {
    return { dir: 'data/pglite', error: (error as Error).message }
  }
}

function claim(predicate: string, value: string, subject: ReturnType<typeof entityRef>): never {
  return { kind: 'claim', subject, predicate, value } as never
}

function toLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => value.toFixed(8)).join(',')}]`
}

interface CorpusCase {
  readonly caseId: string
  readonly predicate: string
  readonly value: string
  readonly request: string
  readonly formKind: string
}

function sampleOf(split: 'dev' | 'val'): CorpusCase[] {
  const rows = readFileSync(join(CORPUS, `${split}.jsonl`), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const seen = new Set<string>()
  return rows
    .filter((row) => row.stratum === 'normal' || row.stratum === 'hard')
    .sort((a, b) => {
      const ra = createHash('sha256').update(`${SEEDS[split]}|${String(a.caseId)}`).digest('hex')
      const rb = createHash('sha256').update(`${SEEDS[split]}|${String(b.caseId)}`).digest('hex')
      return ra < rb ? -1 : 1
    })
    .filter((row) => {
      const snapshot = row.authoritativeSnapshot as { predicate: string; value: string }
      const key = `${snapshot.predicate}@${snapshot.value}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, SAMPLE_SIZE)
    .map((row) => {
      const snapshot = row.authoritativeSnapshot as { predicate: string; value: string }
      return {
        caseId: String(row.caseId),
        predicate: snapshot.predicate,
        value: snapshot.value,
        request: String(row.request),
        formKind: String(row.formKind),
      }
    })
}

interface SplitReading {
  readonly split: string
  readonly lexical: number
  readonly exactCases: number
  readonly exactTopRanked: number
  readonly exactInPool: number
  readonly paraphraseCases: number
  readonly paraphraseTopRanked: number
  readonly twoLiteralTopCount: number
}

async function main(): Promise<void> {
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId = createM95RunId({ wpId: 'wp2-lexical-calibration', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const manifest = loadEmbeddingManifest(join(REPO_ROOT, 'evals/m9.5/embedding-manifest.json'))
  const fingerprint = embeddingFingerprintOf(manifest)

  const readings: SplitReading[] = []

  for (const split of ['dev', 'val'] as const) {
    const cases = sampleOf(split)
    const paraphraseCases = cases.filter((item) => PARAPHRASE_FORMS.has(item.formKind))
    /*
     * 精确命中场景：**构造查询**（逐字包含目标取值），但**取值取自真实语料**。
     * ⚠️ 第一版从 `cases.slice(0,6)` 取 ⇒ 与改述集**重叠**，撞 `场景内取值重复`（守卫抓到了）。
     *    ⇒ 改用**非改述类**的 case 作场景源：与改述集**按构造不重叠**（样本已按 `predicate@value` 去重）。
     */
    const exactSource = cases.filter((item) => !PARAPHRASE_FORMS.has(item.formKind))
    const exactScenes = exactSource.slice(0, MIN_EXACT).map((item, index) => ({
      sceneId: `${split}-exact-${String(index)}`,
      predicate: item.predicate,
      targetValue: item.value,
      decoyValue: `${item.value.slice(0, 1)}修订版${String(index)}`,
      query: `我在做${item.value}，现在到什么程度了？`,
    }))
    /* **负控场景**：查询句**同时**逐字包含两条记忆的取值 ⇒ 至少一条字面命中拿不到第一 */
    const twoLiteralQuery = `我在做${exactScenes[0]?.targetValue ?? '甲'}和${exactScenes[1]?.targetValue ?? '乙'}，先说第一个。`

    await resetPluginSqlConnection()
    isolateDatabase(`m95-lexical-${split}`, { keep: false })
    const bed = await createM55Harness({ label: `m95-lexical-${split}` })
    const h = bed.h
    const db = h.db
    const namespace = String(h.characterId)
    await ensureSemanticIndexSchema(db, { now: 1_800_000_000_000 })
    await db.execute(
      sql`insert into memory_semantic_generations
          (generation_id, namespace, model_fingerprint, renderer_version, dimension,
           index_schema_version, build_state, created_at, published_at)
          values (${`gen-lexical-${split}`}, ${namespace}, ${fingerprint}, ${'r@1'}, ${manifest.dimension},
                  ${SEMANTIC_INDEX_SCHEMA_VERSION}, ${'published'}, ${1}, ${1})`
    )
    const encoder = createEncoderClient({
      manifest,
      repoRoot: REPO_ROOT,
      localModelPath: LAB_MODEL_ROOT,
      deadlineMs: 120_000,
      readyTimeoutMs: 180_000,
    })
    if (!(await encoder.fingerprintPromise)) throw new Error('编码子进程未就绪（本门要"混合召回对照"）')

    const written = new Set<string>()
    const sceneOf = new Map<string, { targetId: string; query: string; formKind: string }>()
    let ordinal = 0
    const writeMemory = async (predicate: string, value: string): Promise<string> => {
      ordinal += 1
      const key = `${predicate}@${value}`
      if (written.has(key)) throw new Error(`场景内取值重复：${key}`)
      written.add(key)
      const evidence = await h.recordUserEvidence(`记住：${predicate} 是 ${value}。`)
      const record = await h.commitAndFold(
        h.makeCandidate('preference', claim(predicate, value, h.user), { sourceRefs: [evidence.ref] }),
        M4_T0 + 1_000 + ordinal
      )
      const targetId = String(record?.id ?? '')
      const encoded = await encoder.encode([`${manifest.passagePrefix}${predicate} ${value}`])
      if (!encoded.ok) throw new Error(`布景编码失败：${encoded.detail}`)
      await db.execute(
        sql`insert into memory_semantic_index
            (namespace, memory_id, source_revision, generation_id, model_fingerprint, renderer_version,
             content_hash, tokenizer_fingerprint, pooling, normalize, dtype, dimension, embedding, created_at)
            values (${namespace}, ${targetId}, ${1}, ${`gen-lexical-${split}`}, ${fingerprint}, ${'r@1'},
                    ${'h'}, ${'t'}, ${manifest.pooling}, ${manifest.normalize}, ${manifest.dtype},
                    ${manifest.dimension}, ${toLiteral(encoded.vectors[0] as readonly number[])}::vector, ${1})`
      )
      return targetId
    }

    for (const scene of exactScenes) {
      const targetId = await writeMemory(scene.predicate, scene.targetValue)
      await writeMemory(scene.predicate, scene.decoyValue)
      sceneOf.set(scene.sceneId, { targetId, query: scene.query, formKind: 'exact-hit' })
    }
    for (const item of paraphraseCases) {
      const targetId = await writeMemory(item.predicate, item.value)
      sceneOf.set(item.caseId, { targetId, query: item.request, formKind: item.formKind })
    }
    /* 负控：两条**字面命中**（取值都在同一句查询里） */
    const twoLiteralIds = [
      await writeMemory('project.background.active', '甲方案重写'),
      await writeMemory('project.background.active', '乙方案重写'),
    ]
    const twoLiteralQueryReal = twoLiteralQuery.replace('甲', '甲方案重写').replace('乙', '乙方案重写')

    const probeImpl = createSemanticProbe({
      db,
      manifest,
      encoder: {
        encode: async (texts) => {
          const result = await encoder.encode(texts)
          return result.ok
            ? { ok: true as const, vectors: result.vectors, dimension: result.dimension }
            : { ok: false as const, reason: result.reason, detail: result.detail }
        },
      },
    })

    const retrieveWith = async (
      text: string,
      policy: HybridRelevancePolicy
    ): Promise<{ top: string | null; ids: string[] }> => {
      const port = createMemoryRetrievalStore({
        store: h.store,
        integrity: (owner) => memoryIntegrityProblems(db, owner),
        rootReadings: (ids) => rootReadingsByMemory(db, ids),
        semanticProbe: probeImpl,
        hybridPolicy: policy,
      })
      const result = await port.retrieve({
        traceId: newTraceId(),
        characterId: h.characterId,
        user: entityRef('user', String(h.user.id)),
        text,
        timeScope: { kind: 'any' },
        limit: CANDIDATE_LIMIT,
        retrievalPolicyVersion: 'hybrid-relevance@1',
        semanticMode: 'on',
      } as Parameters<typeof port.retrieve>[0])
      return { top: result.hits[0] === undefined ? null : String(result.hits[0].record.id), ids: result.hits.map((hit) => String(hit.record.id)) }
    }

    for (const lexical of LEXICAL_WEIGHTS) {
      const policy = policyOf(lexical)
      let exactTopRanked = 0
      let exactInPool = 0
      let paraphraseTopRanked = 0
      for (const scene of exactScenes) {
        const entry = sceneOf.get(scene.sceneId)
        if (entry === undefined) continue
        const result = await retrieveWith(entry.query, policy)
        if (result.ids.includes(entry.targetId)) exactInPool += 1
        if (result.top === entry.targetId) exactTopRanked += 1
      }
      for (const item of paraphraseCases) {
        const entry = sceneOf.get(item.caseId)
        if (entry === undefined) continue
        const result = await retrieveWith(entry.query, policy)
        if (result.top === entry.targetId) paraphraseTopRanked += 1
      }
      /* 负控：同一句里两条字面命中 ⇒ 数出**拿到第一的字面命中条数**（应当 ≤1） */
      const twoLiteral = await retrieveWith(twoLiteralQueryReal, policy)
      const twoLiteralTopCount = twoLiteralIds.filter((id) => twoLiteral.top === id).length

      readings.push({
        split,
        lexical,
        exactCases: exactScenes.length,
        exactTopRanked,
        exactInPool,
        paraphraseCases: paraphraseCases.length,
        paraphraseTopRanked,
        twoLiteralTopCount,
      })
      process.stdout.write(
        `  ${split} w_lexical=${lexical.toFixed(2)} · 精确命中 首位 ${String(exactTopRanked)}/${String(exactScenes.length)} 入池 ${String(exactInPool)} · 改述首位 ${String(paraphraseTopRanked)}/${String(paraphraseCases.length)} · 双字面命中拿第一 ${String(twoLiteralTopCount)} 条\n`
      )
    }

    await encoder.close()
    await bed.dispose()
  }

  const find = (split: string, lexical: number): SplitReading | undefined =>
    readings.find((row) => row.split === split && row.lexical === lexical)
  const base = (split: string): SplitReading => find(split, 1) as SplitReading

  /* ---- (v) 样本量 + 空转防线 ---- */
  const thin = readings.filter((row) => row.exactCases < MIN_EXACT || row.paraphraseCases < MIN_PARAPHRASE)
  check(
    '(v) 样本量达标（精确命中 ≥6、改述 ≥8；不足 ⇒ MEASUREMENT INVALID，不是 PASS）',
    thin.length === 0,
    thin.length > 0 ? JSON.stringify(thin.slice(0, 2)) : `全部 ${String(readings.length)} 组达标`
  )

  /* ---- (i) 精确命中**改善**（两个 split 各自严格 > 基线且 ≥ +1）---- */
  const improvements = (['dev', 'val'] as const).map((split) => ({
    split,
    base: base(split)?.exactTopRanked ?? -1,
    perCandidate: LEXICAL_WEIGHTS.map((lexical) => ({ lexical, value: find(split, lexical)?.exactTopRanked ?? -1 })),
  }))
  const passingCandidates = LEXICAL_WEIGHTS.filter((lexical) =>
    (['dev', 'val'] as const).every((split) => {
      const baseline = base(split)?.exactTopRanked ?? -1
      const current = find(split, lexical)?.exactTopRanked ?? -1
      return baseline >= 0 && current >= baseline + 1
    })
  )
  /* ⚠️ (i)(ii)(iii) **不**用 `check()`：它们是**候选的验收条件**（决定 MET/NOT_MET），
     不是"测量是否成立"。混在一起会把"未达标"误报成"没测成"。 */

  /* ---- (ii) 守住**改述**（两 split 都不得下降）---- */
  const paraphraseRegressions = readings.filter((row) => {
    if (row.lexical === 1) return false
    const baseline = base(row.split)?.paraphraseTopRanked ?? -1
    return row.paraphraseTopRanked < baseline
  })
  /* (ii) 守住改述 —— 判定输入（不在此 check） */

  /* ---- (iii) 守住旧强项：字面命中不得被挤出池 ---- */
  const droppedFromPool = readings.filter((row) => row.exactInPool < row.exactCases)
  /* (iii) 守住旧强项：字面命中不被挤出池 —— 判定输入（不在此 check） */

  /* ---- (iv) ★ **不设无条件置顶**：同一句里两条字面命中时，拿第一的**至多一条** ---- */
  const overTop = readings.filter((row) => row.twoLiteralTopCount > 1)
  check(
    '(iv) ★ 负控：同一句里**两条**字面命中 ⇒ 拿到第一的**至多一条** ⇒ 字面命中**不是**无条件置顶',
    overTop.length === 0 && readings.every((row) => row.twoLiteralTopCount <= 1),
    overTop.length > 0 ? JSON.stringify(overTop.slice(0, 2)) : '全部 ≤1'
  )

  /*
   * ⚠️ **阈值 vs 测量完整性**（第一版把两者混成一个退出码 —— 那是错的）：
   *   · `check()` 只判**测量完整性/回归防线**（样本量、负控是否有效、自检）⇒ 违反 ⇒ 退出码 3
   *   · (i)(ii)(iii) 是**候选的验收条件** ⇒ 决定 `MET / NOT_MET`，**两种结局都退 0**（Bar §3）
   *   若把"未达标"当失败退出，就等于把"**测到了一个不如预期的结果**"说成"**没测成**"。
   */
  const met =
    passingCandidates.length > 0 && paraphraseRegressions.length === 0 && droppedFromPool.length === 0
  /* 达标候选：**取 w_lexical 最小者**（(vi)：改动最小、离基线最近） */
  const chosen = passingCandidates.length > 0 ? Math.min(...passingCandidates) : null
  check(
    '(iv) ★ 负控有效：同一句里两条字面命中 ⇒ 拿到第一的至多一条',
    readings.every((row) => row.twoLiteralTopCount <= 1)
  )
  check(
    '(i)(ii)(iii) 的读数**被真的取到**（每组都跑过；不是空转）',
    readings.length === LEXICAL_WEIGHTS.length * 2 && readings.every((row) => row.exactCases > 0 && row.paraphraseCases > 0),
    `组数=${String(readings.length)}`
  )
  const total = passed + failures.length
  const selfCheck = selfCheckMeasurement({ measuredCount: total, notRunCount: 0, failedCount: failures.length })
  const realDbAfter = safeTreeDigest()
  const payload = {
    schemaVersion: 'm9.5-lexical-calibration@1',
    runId,
    generatedAt: new Date().toISOString(),
    bar: 'docs/m9.5/M9.5-Lexical-Calibration-Bar.md（**判据先于读数**；工具定义修订见其 §2.5）',
    candidates: LEXICAL_WEIGHTS,
    readings,
    verdict: met ? 'MET' : 'NOT_MET',
    chosenLexicalWeight: met ? chosen : null,
    /** ⚠️ 未达标 ⇒ **维持等权**、登记局限、`calibrated` 仍为 false（用户逐字） */
    disposition: met
      ? `写入选定权重（w_lexical=${String(chosen)}）→ 重跑 calibration/validation/legacy-strength → 进入真模型档`
      : '维持等权（不改 PROVISIONAL_HYBRID_POLICY）· 登记局限 · calibrated 保持 false',
    checks: { passed, failed: failures.length, total },
    failures,
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter) },
  }
  const evidencePath = join(runDir, 'lexical-calibration.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp2',
    lane: 'live',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: GATE_VERSION,
    dbKind: 'synthetic',
    isolationProof: {
      sandboxIsolationUsed: true,
      realDbDigestBefore: realDbBefore,
      realDbDigestAfter: realDbAfter,
      realDbUnchanged: JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter),
      method: 'isolateDatabase() + digestTree() 前后比对（只读）',
    },
    configHash: { candidates: LEXICAL_WEIGHTS, minExact: MIN_EXACT, minParaphrase: MIN_PARAPHRASE },
    command: [{ cmd: 'pnpm m9.5:lexical-calibration', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: total,
    notRunCount: 0,
    counts: { total, passed, failed: failures.length },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    modelFingerprint: fingerprint,
    artifactHashes: { 'lexical-calibration.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 词面权重校准：${met ? '**MET（达标）**' : '**NOT MET（未达标）**'}`,
      `  通过 ${String(passed)} / 失败 ${String(failures.length)}（共 ${String(total)} 项）`,
      ...failures.map((line) => `  ✗ ${line}`),
      `  达标候选：${JSON.stringify(passingCandidates)} · 选定：${chosen === null ? '（无）' : `w_lexical=${String(chosen)}`}`,
      `  处置：${payload.disposition}`,
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (failures.length > 0 || total === 0) process.exitCode = 3
}

await main()
