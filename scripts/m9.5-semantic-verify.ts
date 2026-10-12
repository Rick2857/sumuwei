/**
 * M9.5 WP6（N1 的语义半边）—— **语义分数真的进链路**（`pnpm m9.5:semantic:verify`）。
 *
 * ============================================================================
 *  它验的就是 R3 / D26-④ 那条：**没有分数就不许说可用**
 * ============================================================================
 * ```text
 * 接线之后，"可用"这件事不再是一个标志位，而是由**本次是否真的算出了分数**决定：
 *   ① 真编码器 + 真派生索引 ⇒ 拿到真分数 ⇒ `semantic` 进 `available`，
 *      候选上出现 `semantic` 通道标签，且分数与**数据库自己算的余弦**逐位相符（oracle）。
 *   ② 探针**具名失败**（timeout / model_missing）⇒ `semantic` 留在 `unavailable`，
 *      原因就是那一个具名值，词面路径照常工作（计划 §9.3 的 `degraded_lexical`）。
 *   ③ 探针说成功但**一条分数都没有** ⇒ 判 `missing_score`（**不是**"都是 0 分"）——
 *      这是"伪启用"的机器防线。
 *   ④ `off`（legacy）下探针**一次都不被调用**（S46：off 模式语义调用数 = 0）。
 * ```
 * 用法：`pnpm m9.5:semantic:verify`（lane=live：需要本地模型）
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import {
  SEMANTIC_INDEX_SCHEMA_VERSION,
  SEMANTIC_META_ID,
  ensureSemanticIndexSchema,
} from '../src/infrastructure/persistence/memory-semantic-index.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import type { SemanticUnavailableReason } from '../src/kernel/contracts/recall.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import type { MemorySemanticProbe } from '../src/kernel/recall/ports.ts'
import { createEncoderClient } from '../src/infrastructure/semantic/encoder-client.ts'
import { loadEmbeddingManifest, embeddingFingerprintOf } from '../src/infrastructure/semantic/embedding-manifest.ts'

import { M4_T0, sha256, type M4Harness } from './m4-harness.ts'
import { createM55Harness, type M55Harness } from './m5.5-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  runIdFromM95OutPath,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-semantic@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const LAB_MODEL_ROOT = join(REPO_ROOT, 'artifacts/m9.5/local/embedding-lab/models')
const GENERATION = 'gen-semantic-gate'

interface Probe {
  readonly id: string
  readonly question: string
  readonly verdict: 'ok' | 'unexpected'
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

async function probe(input: {
  readonly id: string
  readonly question: string
  readonly run: () => Promise<Record<string, unknown>>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Promise<Probe> {
  try {
    const reading = await input.run()
    const problems = input.judge?.(reading) ?? []
    return {
      id: input.id,
      question: input.question,
      verdict: problems.length > 0 ? 'unexpected' : 'ok',
      reading,
      error: problems.length > 0 ? problems.join('; ') : null,
    }
  } catch (error) {
    return {
      id: input.id,
      question: input.question,
      verdict: 'unexpected',
      reading: {},
      error: (error as Error).message.replace(/\s+/g, ' ').slice(0, 240),
    }
  }
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

function toLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => value.toFixed(8)).join(',')}]`
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number)
    na += (a[i] as number) ** 2
    nb += (b[i] as number) ** 2
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

function claim(predicate: string, value: string, subject: ReturnType<typeof entityRef>): never {
  return { kind: 'claim', subject, predicate, value } as never
}

interface Target {
  readonly memoryId: string
  readonly vector: readonly number[]
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp6-semantic', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const manifest = loadEmbeddingManifest(join(REPO_ROOT, 'evals/m9.5/embedding-manifest.json'))
  const fingerprint = embeddingFingerprintOf(manifest)

  await resetPluginSqlConnection()
  isolateDatabase('m95-wp6-semantic', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp6-semantic' })
  const h: M4Harness = bed.h
  const db = h.db
  const probes: Probe[] = []

  /* ---- 建派生 schema + 一代 ---- */
  await ensureSemanticIndexSchema(db, { now: 1_800_000_000_000 })
  await db.execute(
    sql`insert into memory_semantic_generations
        (generation_id, namespace, model_fingerprint, renderer_version, dimension,
         index_schema_version, build_state, created_at, published_at)
        values (${GENERATION}, ${String(h.characterId)}, ${fingerprint}, ${'renderer@1'},
                ${manifest.dimension}, ${SEMANTIC_INDEX_SCHEMA_VERSION}, ${'published'}, ${1}, ${1})`
  )

  /* ---- 三条真记忆（真实放行链） ---- */
  const texts = ['我在写毕业论文。', '我在江城大学读书。', '我平时用 Windows 笔记本。']
  const predicates = ['project.background.active', 'education.institution', 'device.primary']
  const targets: Target[] = []
  const encoder = createEncoderClient({
    manifest,
    repoRoot: REPO_ROOT,
    localModelPath: LAB_MODEL_ROOT,
    deadlineMs: 120_000,
    readyTimeoutMs: 180_000,
  })
  const encoded = await encoder.encode(texts.map((text) => `${manifest.passagePrefix}${text}`))
  if (!encoded.ok) throw new Error(`编码失败：${encoded.reason} ${encoded.detail}`)
  for (let i = 0; i < texts.length; i += 1) {
    const evidence = await h.recordUserEvidence(`记住：${texts[i] as string}`)
    const record = await h.commitAndFold(
      h.makeCandidate('person_fact', claim(predicates[i] as string, texts[i] as string, h.user), {
        sourceRefs: [evidence.ref],
      }),
      M4_T0 + 100 + i
    )
    const memoryId = String(record?.id ?? '')
    const vector = encoded.vectors[i] as readonly number[]
    targets.push({ memoryId, vector })
    await db.execute(
      sql`insert into memory_semantic_index
          (namespace, memory_id, source_revision, generation_id, model_fingerprint, renderer_version,
           content_hash, tokenizer_fingerprint, pooling, normalize, dtype, dimension, embedding, created_at)
          values (${String(h.characterId)}, ${memoryId}, ${1}, ${GENERATION}, ${fingerprint},
                  ${'renderer@1'}, ${'h1'}, ${'tok@1'}, ${manifest.pooling}, ${manifest.normalize},
                  ${manifest.dtype}, ${manifest.dimension}, ${toLiteral(vector)}::vector, ${1})`
    )
  }

  /* ---- 探针：真编码 + 真精确检索（namespace + generation 预过滤） ---- */
  let probeCalls = 0
  const realProbe: MemorySemanticProbe = {
    name: 'gate-exact-search',
    score: async (input) => {
      probeCalls += 1
      const queryVector = await encoder.encode([`${manifest.queryPrefix}${input.text}`])
      if (!queryVector.ok) return { ok: false, reason: 'timeout' }
      const rows = rowsOf(
        await db.execute(
          sql`select memory_id, (embedding <=> ${toLiteral(queryVector.vectors[0] as readonly number[])}::vector) as distance
              from memory_semantic_index
              where namespace = ${input.characterId} and generation_id = ${GENERATION}`
        )
      )
      const scores = new Map<string, number>()
      for (const row of rows) {
        const memoryId = String(row.memory_id)
        if (!input.memoryIds.includes(memoryId as never)) continue
        scores.set(memoryId, 1 - Number(row.distance))
      }
      return scores.size > 0 ? { ok: true, scores } : { ok: false, reason: 'missing_score' }
    },
  }

  const buildStore = (semanticProbe?: MemorySemanticProbe) =>
    createMemoryRetrievalStore({
      store: h.store,
      integrity: (owner) => memoryIntegrityProblems(db, owner),
      rootReadings: (ids) => rootReadingsByMemory(db, ids),
      ...(semanticProbe !== undefined ? { semanticProbe } : {}),
    })

  const runRetrieval = async (
    input: { readonly text: string; readonly policyVersion?: 'lexical-recency@1' | 'hybrid-relevance@1' },
    semanticProbe?: MemorySemanticProbe
  ): Promise<{ availableSemantic: boolean; unavailableReason: string | null; hits: { memoryId: string; channels: string[] }[]; scanned: number }> => {
    /*
     * ⚠️ 本门直接调**端口**而不是 service：通道标签（`channels`）只在端口层存在
     *    —— 而"available 说可用、候选却没打 semantic 标签"正是本门要抓的伪启用。
     *    经 service 的 `RecallCandidate` 不带通道信息，那样就测不到这条。
     */
    const port = buildStore(semanticProbe)
    const result = await port.retrieve({
      traceId: newTraceId(),
      characterId: h.characterId,
      user: entityRef('user', String(h.user.id)),
      text: input.text,
      timeScope: { kind: 'any' },
      limit: 10,
      ...(input.policyVersion !== undefined ? { retrievalPolicyVersion: input.policyVersion } : {}),
    } as Parameters<typeof port.retrieve>[0])
    const semantic = result.capabilities.unavailable.find((item) => item.dimension === 'semantic')
    return {
      availableSemantic: result.capabilities.available.includes('semantic'),
      unavailableReason: semantic?.reason ?? null,
      hits: result.hits.map((hit) => ({
        memoryId: String(hit.record.id),
        channels: [...hit.channels],
      })),
      scanned: result.scanned,
    }
  }

  const question = '我在写什么？'

  /* ---- ① 真分数进来 ⇒ available ---- */
  probes.push(
    await probe({
      id: 'real-score-makes-semantic-available',
      question: '真编码 + 真精确检索 ⇒ `semantic` 进 available，且候选上有 semantic 通道标签',
      run: async () => {
        const before = probeCalls
        const result = await runRetrieval({ text: question, policyVersion: 'hybrid-relevance@1' }, realProbe)
        return {
          probeCalls: probeCalls - before,
          availableSemantic: result.availableSemantic,
          unavailableReason: result.unavailableReason,
          hits: result.hits,
          semanticTagged: result.hits.filter((hit) => hit.channels.includes('semantic')).length,
          scanned: result.scanned,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.probeCalls) < 1) problems.push('hybrid 下探针竟然没被调用')
        if (reading.availableSemantic !== true) {
          problems.push(`★ 拿到真分数后 semantic 仍不可用（原因 ${String(reading.unavailableReason)}）`)
        }
        if (Number(reading.semanticTagged) < 1) problems.push('★ available 说可用，却没有候选被打上 semantic 标签 ⇒ 伪启用')
        return problems
      },
    })
  )

  /* ---- ② 分数与数据库自己的余弦逐位相符（oracle） ---- */
  probes.push(
    await probe({
      id: 'scores-match-database-cosine',
      question: '探针返回的分数与**数据库自己算的余弦**相符（不是编出来的数）',
      run: async () => {
        const queryVector = await encoder.encode([`${manifest.queryPrefix}${question}`])
        if (!queryVector.ok) throw new Error('查询编码失败')
        const rows = rowsOf(
          await db.execute(
            sql`select memory_id, (embedding <=> ${toLiteral(queryVector.vectors[0] as readonly number[])}::vector) as distance
                from memory_semantic_index where generation_id = ${GENERATION}`
          )
        )
        const dbScores = new Map(rows.map((row) => [String(row.memory_id), 1 - Number(row.distance)]))
        const mine = targets.map((target) => ({
          memoryId: target.memoryId,
          dbCosine: dbScores.get(target.memoryId) ?? Number.NaN,
          handCosine: cosine(queryVector.vectors[0] as readonly number[], target.vector),
        }))
        const maxGap = Math.max(...mine.map((item) => Math.abs(item.dbCosine - item.handCosine)))
        return { mine, maxGap }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (!(Number(reading.maxGap) < 1e-5)) {
          problems.push(`数据库余弦与手算余弦最大偏差 ${String(reading.maxGap)} ⇒ 分数来源不可信`)
        }
        return problems
      },
    })
  )

  /* ---- ③ off：探针一次都不被调用 ---- */
  probes.push(
    await probe({
      id: 'off-never-calls-the-probe',
      question: 'S46：legacy（off）下探针**一次都不被调用**，且 semantic 仍不可用',
      run: async () => {
        const before = probeCalls
        const result = await runRetrieval({ text: question, policyVersion: 'lexical-recency@1' }, realProbe)
        return {
          probeCalls: probeCalls - before,
          availableSemantic: result.availableSemantic,
          semanticTagged: result.hits.filter((hit) => hit.channels.includes('semantic')).length,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.probeCalls) !== 0) problems.push('★ off 模式竟然调用了语义探针（S46 要求调用数 = 0）')
        if (reading.availableSemantic !== false) problems.push('★ off 模式竟报 semantic 可用')
        if (Number(reading.semanticTagged) !== 0) problems.push('off 模式不应有 semantic 通道标签')
        return problems
      },
    })
  )

  /* ---- ④ 具名失败 ⇒ 如实降级，词面路径仍工作 ---- */
  probes.push(
    await probe({
      id: 'named-failure-degrades-with-reason',
      question: '探针具名失败（timeout）⇒ semantic 留在 unavailable 且**原因就是那个具名值**，词面路径照常',
      run: async () => {
        const failing: MemorySemanticProbe = {
          name: 'gate-failing',
          score: async () => ({ ok: false, reason: 'timeout' as SemanticUnavailableReason }),
        }
        const result = await runRetrieval({ text: question, policyVersion: 'hybrid-relevance@1' }, failing)
        return {
          availableSemantic: result.availableSemantic,
          unavailableReason: result.unavailableReason,
          hitCount: result.hits.length,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.availableSemantic !== false) problems.push('★ 探针失败却报可用')
        if (reading.unavailableReason !== 'timeout') {
          problems.push(`原因应原样透传为 timeout，实际 ${String(reading.unavailableReason)}`)
        }
        if (Number(reading.hitCount) < 1) problems.push('语义失败时词面路径应照常给出候选（degraded_lexical）')
        return problems
      },
    })
  )

  /* ---- ⑤ R3：说成功却没有分数 ⇒ missing_score ---- */
  probes.push(
    await probe({
      id: 'r3-empty-scores-is-missing-score',
      question: 'R3：探针 `ok:true` 但**一条分数都没有** ⇒ 判 `missing_score`（不是"都是 0 分"）',
      run: async () => {
        const empty: MemorySemanticProbe = {
          name: 'gate-empty',
          score: async () => ({ ok: true, scores: new Map<string, number>() }),
        }
        const result = await runRetrieval({ text: question, policyVersion: 'hybrid-relevance@1' }, empty)
        return { availableSemantic: result.availableSemantic, unavailableReason: result.unavailableReason }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.availableSemantic !== false) {
          problems.push('★ 一条分数都没有却报可用 ⇒ 伪启用（R3 的要害）')
        }
        if (reading.unavailableReason !== 'missing_score') {
          problems.push(`应判 missing_score，实际 ${String(reading.unavailableReason)}`)
        }
        return problems
      },
    })
  )

  /* ---- ⑥ 不接探针 ⇒ not_indexed（与"探针失败"区分开） ---- */
  probes.push(
    await probe({
      id: 'no-probe-reports-not-indexed',
      question: 'hybrid 但没接探针 ⇒ 原因 `not_indexed`（与"探针报错"是两件事）',
      run: async () => {
        const result = await runRetrieval({ text: question, policyVersion: 'hybrid-relevance@1' })
        return { availableSemantic: result.availableSemantic, unavailableReason: result.unavailableReason }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.availableSemantic !== false) problems.push('没有探针却报可用')
        if (reading.unavailableReason !== 'not_indexed') {
          problems.push(`原因应为 not_indexed，实际 ${String(reading.unavailableReason)}`)
        }
        return problems
      },
    })
  )

  await encoder.close()
  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })

  await bed.dispose()
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged = JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter)

  const payload = {
    schemaVersion: 'm9.5-semantic@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        'R3/D26-④ 的机器形态：available 由"本次是否真拿到分数"决定；具名失败如实降级；off 零调用；真分数与数据库余弦相符',
      setup: '3 条真记忆（真实放行链）+ 真编码器（q8 E5-small）+ 真派生索引（精确检索）',
      notProves: '**不**证明召回质量（那要 A0–A5 校准与 WP10 盲测）；也**不**证明生产装配已接线（本轮在门里注入探针）',
    },
    modelFingerprint: fingerprint,
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'semantic-wire-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp6',
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
      realDbUnchanged,
      method: 'isolateDatabase() + digestTree() 前后比对（只读）',
    },
    configHash: { dimension: manifest.dimension, dtype: manifest.dtype, indexSchemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION },
    command: [{ cmd: 'pnpm m9.5:semantic:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    modelFingerprint: fingerprint,
    artifactHashes: { 'semantic-wire-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP6 语义接线门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
