/**
 * M9.5 WP6 —— **语义探针适配器门**（`pnpm m9.5:probe:verify`）。
 *
 * ============================================================================
 *  为什么它单独成门（与 `m9.5:semantic:verify` 不重复）
 * ============================================================================
 * ```text
 * `m9.5:semantic:verify` 验的是**端口契约**：真分数进来时 `available` 才对、
 *   具名失败要如实降级、`off` 下不许调用探针。
 * 本门验的是**适配器自己**的五道具名失败 —— 尤其是两条最容易漏的：
 *   · **只服务已发布的代**：`building`/`unavailable` 的代被查询 ⇒ 必须 `not_indexed`
 *     （否则"她记得什么"会随构建时机漂移）
 *   · **没索引就不加载模型**：③ 号探针用"模型被调用就会计数"的方式证明这一点
 *     （不然每次检索白付 134 MiB 的加载代价）
 * ```
 * 用法：`pnpm m9.5:probe:verify`（lane=live：需要本地模型）
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  SEMANTIC_INDEX_SCHEMA_VERSION,
  ensureSemanticIndexSchema,
} from '../src/infrastructure/persistence/memory-semantic-index.ts'
import {
  loadEmbeddingManifest,
  embeddingFingerprintOf,
  type EmbeddingManifest,
} from '../src/infrastructure/semantic/embedding-manifest.ts'
import { createEncoderClient } from '../src/infrastructure/semantic/encoder-client.ts'
import { createSemanticProbe } from '../src/infrastructure/semantic/semantic-probe.ts'

import type { CharacterId } from '../src/kernel/contracts/ids.ts'

import { sha256 } from './m4-harness.ts'
import { createM55Harness } from './m5.5-harness.ts'
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
const GATE_VERSION = 'm9.5-probe@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const LAB_MODEL_ROOT = join(REPO_ROOT, 'artifacts/m9.5/local/embedding-lab/models')

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

async function insertGeneration(input: {
  readonly db: { execute: (query: unknown) => Promise<unknown> }
  readonly namespace: string
  readonly generationId: string
  readonly dimension: number
  readonly fingerprint: string
  readonly buildState: string
}): Promise<void> {
  await input.db.execute(
    sql`insert into memory_semantic_generations
        (generation_id, namespace, model_fingerprint, renderer_version, dimension,
         index_schema_version, build_state, created_at, published_at)
        values (${input.generationId}, ${input.namespace}, ${input.fingerprint}, ${'r@1'},
                ${input.dimension}, ${SEMANTIC_INDEX_SCHEMA_VERSION}, ${input.buildState}, ${1}, ${1})`
  )
}

async function insertRow(input: {
  readonly db: { execute: (query: unknown) => Promise<unknown> }
  readonly namespace: string
  readonly memoryId: string
  readonly generationId: string
  readonly fingerprint: string
  readonly vector: readonly number[]
}): Promise<void> {
  await input.db.execute(
    sql`insert into memory_semantic_index
        (namespace, memory_id, source_revision, generation_id, model_fingerprint, renderer_version,
         content_hash, tokenizer_fingerprint, pooling, normalize, dtype, dimension, embedding, created_at)
        values (${input.namespace}, ${input.memoryId}, ${1}, ${input.generationId}, ${input.fingerprint},
                ${'r@1'}, ${'h'}, ${'t'}, ${'mean'}, ${true}, ${'q8'}, ${384},
                ${toLiteral(input.vector)}::vector, ${1})`
  )
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp6-probe', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const manifest: EmbeddingManifest = loadEmbeddingManifest(join(REPO_ROOT, 'evals/m9.5/embedding-manifest.json'))
  const fingerprint = embeddingFingerprintOf(manifest)

  await resetPluginSqlConnection()
  isolateDatabase('m95-wp6-probe', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp6-probe' })
  const h = bed.h
  const db = h.db
  const namespace = String(h.characterId)
  /* `h.characterId` 是普通 string；端口的 namespace 参数是品牌类型 */
  const characterId = h.characterId as unknown as CharacterId
  const probes: Probe[] = []

  await ensureSemanticIndexSchema(db, { now: 1_800_000_000_000 })

  /* 真实编码器（计数：用来证明"没索引时不该加载模型"） */
  let encodeCalls = 0
  const encoder = createEncoderClient({
    manifest,
    repoRoot: REPO_ROOT,
    localModelPath: LAB_MODEL_ROOT,
    deadlineMs: 120_000,
    readyTimeoutMs: 180_000,
  })
  const countingEncoder = {
    encode: async (texts: readonly string[]) => {
      encodeCalls += 1
      const result = await encoder.encode(texts)
      if (!result.ok) {
        return {
          ok: false as const,
          reason: (result.reason === 'encode_timeout' ? 'timeout' : 'model_missing') as 'timeout' | 'model_missing',
          detail: result.detail,
        }
      }
      return { ok: true as const, vectors: result.vectors, dimension: result.dimension }
    },
  }
  const makeProbe = () => createSemanticProbe({ db, manifest, encoder: countingEncoder })

  const MEMORY_A = 'mem:probe:alpha'
  const MEMORY_B = 'mem:probe:beta'
  const wanted = [MEMORY_A, MEMORY_B]

  /* ---- ① 没有已发布的代 ⇒ not_indexed，且**不加载模型** ---- */
  probes.push(
    await probe({
      id: 'no-published-generation',
      question: '没有已发布的代 ⇒ `not_indexed`，且**模型一次都没被调用**（没索引不该付加载代价）',
      run: async () => {
        await insertGeneration({ db, namespace, generationId: 'gen-building', dimension: 384, fingerprint, buildState: 'building' })
        const before = encodeCalls
        const result = await makeProbe().score({ characterId, text: '我在写什么？', memoryIds: wanted as never })
        return { result, encodeCalls: encodeCalls - before }
      },
      judge: (reading) => {
        const problems: string[] = []
        const result = reading.result as { ok: boolean; reason?: string }
        if (result.ok !== false || result.reason !== 'not_indexed') {
          problems.push(`★ 只有 building 代时必须报 not_indexed，实际 ${JSON.stringify(result)}`)
        }
        if (Number(reading.encodeCalls) !== 0) {
          problems.push('★ 没有已发布代时仍然加载了模型 ⇒ 白付 134 MiB')
        }
        return problems
      },
    })
  )

  /* ---- ② 已发布代 + 真向量 ⇒ 真分数 ---- */
  probes.push(
    await probe({
      id: 'published-generation-returns-real-scores',
      question: '已发布的代 + 真向量 ⇒ 返回**真的**相似度，且只含被要求的 memoryId',
      run: async () => {
        await db.execute(
          sql`update memory_semantic_generations set build_state = 'published'
              where generation_id = 'gen-building'`
        )
        const encoded = await encoder.encode([`${manifest.passagePrefix}我在写毕业论文。`, `${manifest.passagePrefix}江城大学。`])
        if (!encoded.ok) throw new Error('布景编码失败')
        await insertRow({ db, namespace, memoryId: MEMORY_A, generationId: 'gen-building', fingerprint, vector: encoded.vectors[0] as readonly number[] })
        await insertRow({ db, namespace, memoryId: MEMORY_B, generationId: 'gen-building', fingerprint, vector: encoded.vectors[1] as readonly number[] })
        const query = await encoder.encode([`${manifest.queryPrefix}我在写什么？`])
        if (!query.ok) throw new Error('查询编码失败')
        const manual = rowsOf(
          await db.execute(
            sql`select memory_id, (embedding <=> ${toLiteral(query.vectors[0] as readonly number[])}::vector) as distance
                from memory_semantic_index where namespace = ${namespace} and generation_id = 'gen-building'
                order by memory_id`
          )
        )
        const result = await makeProbe().score({
          characterId,
          text: '我在写什么？',
          memoryIds: [MEMORY_A] as never,
        })
        return {
          result: result.ok ? { ok: true, entries: [...result.scores.entries()] } : result,
          manualDistances: manual.map((row) => ({ memoryId: String(row.memory_id), distance: Number(row.distance) })),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        const result = reading.result as { ok: boolean; entries?: [string, number][] }
        if (result.ok !== true) problems.push(`应成功，实际 ${JSON.stringify(result)}`)
        const entries = result.entries ?? []
        if (entries.length !== 1) problems.push(`只要求 1 条 memoryId ⇒ 只能返回 1 条，实际 ${String(entries.length)}`)
        if (entries.length === 1 && entries[0]?.[0] !== MEMORY_A) problems.push('返回的 memoryId 不是被要求的那条')
        const manual = (reading.manualDistances as { memoryId: string; distance: number }[]).find(
          (row) => row.memoryId === MEMORY_A
        )
        if (manual !== undefined && entries.length === 1) {
          const expected = 1 - manual.distance
          const gap = Math.abs((entries[0]?.[1] as number) - expected)
          if (!(gap < 1e-6)) problems.push(`分数与数据库余弦偏差 ${String(gap)}`)
        }
        return problems
      },
    })
  )

  /* ---- ③ 维度不符 ⇒ dimension_mismatch ---- */
  probes.push(
    await probe({
      id: 'dimension-mismatch-named',
      question: '已发布代的维度与模型清单不符 ⇒ 具名 `dimension_mismatch`',
      run: async () => {
        await insertGeneration({ db, namespace, generationId: 'gen-wrong-dim', dimension: 512, fingerprint, buildState: 'published' })
        const result = await makeProbe().score({ characterId, text: 'x', memoryIds: wanted as never })
        return { result }
      },
      judge: (reading) => {
        const result = reading.result as { ok: boolean; reason?: string }
        return result.ok === false && result.reason === 'dimension_mismatch'
          ? []
          : [`应报 dimension_mismatch，实际 ${JSON.stringify(result)}`]
      },
    })
  )

  /* ---- ④ 模型指纹不符 ⇒ generation_mismatch ---- */
  probes.push(
    await probe({
      id: 'foreign-fingerprint-named',
      question: '已发布代的模型指纹与当前清单不符 ⇒ 具名 `generation_mismatch`（禁止跨代混排）',
      run: async () => {
        await db.execute(sql`delete from memory_semantic_generations where generation_id = 'gen-wrong-dim'`)
        await db.execute(
          sql`update memory_semantic_generations set model_fingerprint = ${'someone-elses-fingerprint'}
              where generation_id = 'gen-building'`
        )
        const result = await makeProbe().score({ characterId, text: 'x', memoryIds: wanted as never })
        /* 还原 */
        await db.execute(
          sql`update memory_semantic_generations set model_fingerprint = ${fingerprint}
              where generation_id = 'gen-building'`
        )
        return { result }
      },
      judge: (reading) => {
        const result = reading.result as { ok: boolean; reason?: string }
        return result.ok === false && result.reason === 'generation_mismatch'
          ? []
          : [`应报 generation_mismatch，实际 ${JSON.stringify(result)}`]
      },
    })
  )

  /* ---- ⑤ 有索引但这些 id 没有向量 ⇒ missing_score ---- */
  probes.push(
    await probe({
      id: 'unindexed-ids-are-missing-score',
      question: '代已发布但这个 id 没有向量 ⇒ `missing_score`（**不是**"分数是 0"）',
      run: async () => {
        const result = await makeProbe().score({
          characterId,
          text: '我在写什么？',
          memoryIds: ['mem:probe:never-indexed'] as never,
        })
        return { result }
      },
      judge: (reading) => {
        const result = reading.result as { ok: boolean; reason?: string }
        return result.ok === false && result.reason === 'missing_score'
          ? []
          : [`应报 missing_score，实际 ${JSON.stringify(result)}`]
      },
    })
  )

  /* ---- ⑥ 编码器失败 ⇒ 具名原因原样透传 ---- */
  probes.push(
    await probe({
      id: 'encoder-failure-passthrough',
      question: '编码器失败 ⇒ 原因**原样透传**（timeout / model_missing），不吞不换',
      run: async () => {
        const failing = createSemanticProbe({
          db,
          manifest,
          encoder: {
            encode: async () => ({ ok: false, reason: 'timeout' as const, detail: 'injected' }),
          },
        })
        const timedOut = await failing.score({ characterId, text: 'x', memoryIds: wanted as never })
        const missing = createSemanticProbe({
          db,
          manifest,
          encoder: { encode: async () => ({ ok: false, reason: 'model_missing' as const, detail: 'injected' }) },
        })
        const modelMissing = await missing.score({ characterId, text: 'x', memoryIds: wanted as never })
        return { timedOut, modelMissing }
      },
      judge: (reading) => {
        const problems: string[] = []
        const a = reading.timedOut as { ok: boolean; reason?: string }
        const b = reading.modelMissing as { ok: boolean; reason?: string }
        if (a.reason !== 'timeout') problems.push(`timeout 未透传：${JSON.stringify(a)}`)
        if (b.reason !== 'model_missing') problems.push(`model_missing 未透传：${JSON.stringify(b)}`)
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
    schemaVersion: 'm9.5-probe@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies: '适配器的五道具名失败 + 真分数 + 只服务已发布代 + 没索引不加载模型',
      notProves: '**不**证明它已接进生产装配（`src/main.ts` 接线是下一步）；也**不**证明召回质量',
    },
    modelFingerprint: fingerprint,
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'probe-verify.json')
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
    configHash: { dimension: manifest.dimension, dtype: manifest.dtype },
    command: [{ cmd: 'pnpm m9.5:probe:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    modelFingerprint: fingerprint,
    artifactHashes: { 'probe-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP6 探针适配器门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
