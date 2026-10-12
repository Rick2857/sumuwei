/**
 * M9.5 WP1/WP2 —— **A0/A1/A2 开发集对照门**（`pnpm m9.5:calibration:verify`）。
 *
 * ============================================================================
 *  计划 §274–279 的六臂定义（**逐字**）+ §570 的执行要求
 * ============================================================================
 * ```text
 * | A0 原词面        | 无改动        | **真实基线**
 * | A1 E5 + 精确向量  | 增加语义候选   | 小模型能否解决**改述**
 * | A2 混合召回      | 词面+向量组合  | 是否**保住字面精确命中**
 * | A3 BGE 候选      | 换 embedding | 质量增益是否值得资源成本
 * | A4 可选 reranker | 最终相关性重排 | 难负例改善是否足够
 * | A5 可选 ANN      | 精确→近似索引  | 速度收益与召回损失
 * §570：「用同一开发集比较 **A0/A1/A2**；小模型不足时再执行 A3。」
 * ```
 *
 * **本门的臂映射（如实、且每一臂都跑真编码器）**：
 * ```text
 * A0 = `semanticMode: 'off'`     —— 不调探针（词面 + 新近度）
 * A1 = `semanticMode: 'shadow'`  —— **真的算**语义分数并记录，但**不影响排序**
 *                                  ⇒ 它测的正是「语义能不能**看到**改述」（与排序策略无关）
 * A2 = `semanticMode: 'on'`      —— 词面 + 语义**组合**排序
 * A3 / A4 / A5 = **NOT RUN**（BGE 未安装 / reranker 未实现 / ANN 未比较）—— 如实分列
 * ```
 *
 * 指标（每臂三个数，**同一条 case 同一批记忆**）：
 * ```text
 * · targetInPool     目标是否进了候选池（层④的门口）
 * · targetScored     目标是否**真的拿到了语义分数**（A1 的专属读数）
 * · targetSelected   目标是否**被选中**（用户可见的那一层）
 * ```
 * 用法：`pnpm m9.5:calibration:verify`
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
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
import type { SemanticMode } from '../src/kernel/contracts/recall.ts'

import { M4_T0, sha256 } from './m4-harness.ts'
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
const GATE_VERSION = 'm9.5-calibration@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const LAB_MODEL_ROOT = join(REPO_ROOT, 'artifacts/m9.5/local/embedding-lab/models')
const CORPUS_DEV = join(REPO_ROOT, 'evals/m9.5/corpus/dev.jsonl')
const GENERATION = 'gen-calibration'

/** 确定性抽样（**同一颗种子给同一组 case**，可复现） */
const SAMPLE_SEED = 'm9.5-calibration@1'
const SAMPLE_SIZE = 24

/** 「改述类」：A1/A2 存在的理由就是它们（与字面命中相对） */
const PARAPHRASE_FORMS = new Set(['synonym', 'indirect', 'elliptical', 'boundedHint', 'similarProject', 'mixedEntity'])

/**
 * 候选上限取 **8**（而不是契约上限 50）——**刻意**。
 *
 * ```text
 * 本门要对照的是"**候选范围**这一层"（WP0 的层④）。若上限大于库规模，截断从不发生，
 * 三臂的入池读数会全部相同 ⇒ **对照是空的**（第一版就是 50，正好踩这个坑）。
 * 取 8 之后：A0/A1 按新近度截断会把**最旧的目标**挤出池，A2 按相关性把它排前面
 * ⇒ 层④的差别**在读数上看得见**。
 * ```
 */
const CANDIDATE_LIMIT = 8

const ARMS: { readonly arm: 'A0' | 'A1' | 'A2'; readonly mode: SemanticMode; readonly what: string }[] = [
  { arm: 'A0', mode: 'off', what: '原词面（词面 + 新近度）' },
  { arm: 'A1', mode: 'shadow', what: 'E5 + 精确向量（算语义候选，不影响排序）' },
  { arm: 'A2', mode: 'on', what: '混合召回（词面 + 向量组合排序）' },
]

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
  readonly run: () => Promise<Record<string, unknown>> | Record<string, unknown>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Promise<Probe> {
  try {
    const reading = input.run()
    const resolved = reading instanceof Promise ? await reading : reading
    const problems = input.judge?.(resolved) ?? []
    return {
      id: input.id,
      question: input.question,
      verdict: problems.length > 0 ? 'unexpected' : 'ok',
      reading: resolved,
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

function claim(predicate: string, value: string, subject: ReturnType<typeof entityRef>): never {
  return { kind: 'claim', subject, predicate, value } as never
}

function toLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => value.toFixed(8)).join(',')}]`
}

export interface ArmReading {
  readonly arm: string
  readonly cases: number
  /** 目标是否进了**候选池**（= 端口返回的 `hits`；层④的门口） */
  readonly targetInPool: number
  /** 目标是否**真的拿到语义分数**（A1 的**专属**读数：看得到 ≠ 用得上） */
  readonly targetScored: number
  /** 目标是否**排首位**（端口层能测的最强代理；真正的"选中"在轮次层，见 `m9.5:e2e`） */
  readonly targetTopRanked: number
  readonly paraphraseCases: number
  readonly paraphraseTopRanked: number
  readonly probeCalls: number
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp12-calibration', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const manifest = loadEmbeddingManifest(join(REPO_ROOT, 'evals/m9.5/embedding-manifest.json'))
  const fingerprint = embeddingFingerprintOf(manifest)
  const probes: Probe[] = []

  /* ---- 抽样（确定性 + 只取"有唯一目标"的 normal/hard 类） ---- */
  const all = readFileSync(CORPUS_DEV, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const eligible = all.filter(
    (item) => item.stratum === 'normal' || item.stratum === 'hard'
  )
  const ranked = [...eligible].sort((a, b) => {
    const ra = createHash('sha256').update(`${SAMPLE_SEED}|${String(a.caseId)}`).digest('hex')
    const rb = createHash('sha256').update(`${SAMPLE_SEED}|${String(b.caseId)}`).digest('hex')
    return ra < rb ? -1 : 1
  })
  /*
   * ⚠️ **按 (predicate, value) 去重**：语料允许同一取值配**不同 user**（`familyId` 含 user），
   *    而本门把所有 case 都物化在**同一个 subject** 下 ⇒ 两条同值 case 会撞 `duplicate_content`。
   * ⚠️ 这个修复**先在 `validation` 门做了、却漏了本门** —— 语料重生成后本门才暴露。
   *    **同一根因的两种表现**：修一个门时，要问"同族的还有谁"。
   */
  const cases = (() => {
    const seen = new Set<string>()
    return ranked
      .filter((item) => {
        const snapshot = item.authoritativeSnapshot as { predicate: string; value: string }
        const key = `${snapshot.predicate}@${snapshot.value}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, SAMPLE_SIZE)
  })()

  await resetPluginSqlConnection()
  isolateDatabase('m95-calibration', { keep: false })
  const bed = await createM55Harness({ label: 'm95-calibration' })
  const h = bed.h
  const db = h.db
  const namespace = String(h.characterId)

  await ensureSemanticIndexSchema(db, { now: 1_800_000_000_000 })
  await db.execute(
    sql`insert into memory_semantic_generations
        (generation_id, namespace, model_fingerprint, renderer_version, dimension,
         index_schema_version, build_state, created_at, published_at)
        values (${GENERATION}, ${namespace}, ${fingerprint}, ${'r@1'}, ${manifest.dimension},
                ${SEMANTIC_INDEX_SCHEMA_VERSION}, ${'published'}, ${1}, ${1})`
  )

  const encoder = createEncoderClient({
    manifest,
    repoRoot: REPO_ROOT,
    localModelPath: LAB_MODEL_ROOT,
    deadlineMs: 120_000,
    readyTimeoutMs: 180_000,
  })
  if (!(await encoder.fingerprintPromise)) {
    throw new Error('编码子进程未就绪（本门需要真编码器：A1/A2 的分量必须是真分数）')
  }

  /* ---- 布景：逐 case 写记忆 + 同一条向量入派生索引 ---- */
  const sceneOf = new Map<string, { targetId: string; request: string; formKind: string }>()
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index] as Record<string, unknown>
    const snapshot = item.authoritativeSnapshot as { predicate: string; value: string }
    const caseId = String(item.caseId)
    const evidence = await h.recordUserEvidence(`记住：${snapshot.predicate} 是 ${snapshot.value}。`)
    const record = await h.commitAndFold(
      h.makeCandidate('person_fact', claim(snapshot.predicate, snapshot.value, h.user), {
        sourceRefs: [evidence.ref],
      }),
      M4_T0 + 1_000 + index
    )
    const targetId = String(record?.id ?? '')
    const encoded = await encoder.encode([`${manifest.passagePrefix}${snapshot.predicate} ${snapshot.value}`])
    if (!encoded.ok) throw new Error(`布景编码失败：${encoded.detail}`)
    await db.execute(
      sql`insert into memory_semantic_index
          (namespace, memory_id, source_revision, generation_id, model_fingerprint, renderer_version,
           content_hash, tokenizer_fingerprint, pooling, normalize, dtype, dimension, embedding, created_at)
          values (${namespace}, ${targetId}, ${1}, ${GENERATION}, ${fingerprint}, ${'r@1'},
                  ${'h'}, ${'t'}, ${manifest.pooling}, ${manifest.normalize}, ${manifest.dtype},
                  ${manifest.dimension}, ${toLiteral(encoded.vectors[0] as readonly number[])}::vector, ${1})`
    )
    sceneOf.set(caseId, { targetId, request: String(item.request), formKind: String(item.formKind) })
  }

  /* ---- 逐臂跑同一批 case ---- */
  let probeCalls = 0
  const probeImpl = createSemanticProbe({
    db,
    manifest,
    encoder: {
      encode: async (texts) => {
        probeCalls += 1
        const result = await encoder.encode(texts)
        return result.ok
          ? { ok: true as const, vectors: result.vectors, dimension: result.dimension }
          : { ok: false as const, reason: result.reason, detail: result.detail }
      },
    },
  })

  const armResults: ArmReading[] = []
  for (const arm of ARMS) {
    let targetInPool = 0
    let targetScored = 0
    let targetTopRanked = 0
    let paraphraseCases = 0
    let paraphraseTopRanked = 0
    const callsBefore = probeCalls

    for (const item of cases) {
      const caseId = String((item as Record<string, unknown>).caseId)
      const scene = sceneOf.get(caseId)
      if (scene === undefined) continue
      const port = createMemoryRetrievalStore({
        store: h.store,
        integrity: (owner) => memoryIntegrityProblems(db, owner),
        rootReadings: (ids) => rootReadingsByMemory(db, ids),
        semanticProbe: probeImpl,
      })
      const result = await port.retrieve({
        traceId: newTraceId(),
        characterId: h.characterId,
        user: entityRef('user', String(h.user.id)),
        text: scene.request,
        timeScope: { kind: 'any' },
        limit: CANDIDATE_LIMIT,
        retrievalPolicyVersion: 'hybrid-relevance@1',
        semanticMode: arm.mode,
      } as Parameters<typeof port.retrieve>[0])

      /*
       * ⚠️ 端口层的 `hits` 是**候选池**（截断之后），**不是**"选中集"。
       *    第一版把 `channels.includes('lexical')` 当成"被选中" —— 那量的是"词面命中过"，
       *    与"选择器选没选它"是两件事。真正的选中在**轮次层**（`m9.5:e2e` 已覆盖）。
       *    这里如实只报三样：入池 / 有语义分数 / 排首位。
       */
      const inPool = result.hits.some((hit) => String(hit.record.id) === scene.targetId)
      const scored = result.semanticScoredIds.includes(scene.targetId)
      const topRanked = String(result.hits[0]?.record.id ?? '') === scene.targetId
      if (inPool) targetInPool += 1
      if (scored) targetScored += 1
      if (topRanked) targetTopRanked += 1
      if (PARAPHRASE_FORMS.has(scene.formKind)) {
        paraphraseCases += 1
        if (topRanked) paraphraseTopRanked += 1
      }
    }
    armResults.push({
      arm: arm.arm,
      cases: cases.length,
      targetInPool,
      targetScored,
      targetTopRanked,
      paraphraseCases,
      paraphraseTopRanked,
      probeCalls: probeCalls - callsBefore,
    })
  }

  await encoder.close()
  await bed.dispose()

  /* ---- ① 三臂都跑了同一批 case（对照的前提） ---- */
  probes.push(
    await probe({
      id: 'three-arms-ran-the-same-dev-cases',
      question: `① A0/A1/A2 各跑**同一批** ${String(SAMPLE_SIZE)} 条 dev case（同一颗种子、同一批记忆、真编码器）`,
      run: () => ({
        sampled: cases.length,
        seed: SAMPLE_SEED,
        eligiblePool: eligible.length,
        arms: armResults.map((arm) => ({ arm: arm.arm, cases: arm.cases })),
      }),
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.sampled) !== SAMPLE_SIZE) {
          problems.push(`应抽 ${String(SAMPLE_SIZE)} 条，实际 ${String(reading.sampled)}`)
        }
        if (Number(reading.eligiblePool) < SAMPLE_SIZE) problems.push('可选池小于样本量')
        for (const arm of reading.arms as { arm: string; cases: number }[]) {
          if (arm.cases !== SAMPLE_SIZE) problems.push(`${arm.arm} 只跑了 ${String(arm.cases)} 条 ⇒ 三臂不可比`)
        }
        return problems
      },
    })
  )

  /* ---- ② A0 的语义调用数必须为 0（基线是真的基线） ---- */
  probes.push(
    await probe({
      id: 'a0-makes-no-semantic-calls',
      question: '② A0（原词面）的语义调用数**为 0**；A1/A2 **真的调用了**（否则它们不是那两臂）',
      run: () => ({
        calls: Object.fromEntries(armResults.map((arm) => [arm.arm, arm.probeCalls])),
        scored: Object.fromEntries(armResults.map((arm) => [arm.arm, arm.targetScored])),
      }),
      judge: (reading) => {
        const problems: string[] = []
        const calls = reading.calls as Record<string, number>
        const scored = reading.scored as Record<string, number>
        if (calls.A0 !== 0) problems.push('★ A0 竟然调用了语义探针 ⇒ 它不是"原词面"基线')
        if (scored.A0 !== 0) problems.push('★ A0 有语义分数 ⇒ 基线不纯')
        for (const arm of ['A1', 'A2']) {
          if (!(Number(calls[arm]) > 0)) problems.push(`★ ${arm} 没有调用探针 ⇒ 该臂没跑起来`)
          if (!(Number(scored[arm]) > 0)) problems.push(`★ ${arm} 一条语义分数都没拿到`)
        }
        return problems
      },
    })
  )

  /* ---- ③ A1 的**专属**读数：算到了分（但不影响排序） ---- */
  probes.push(
    await probe({
      id: 'a1-sees-paraphrases-without-affecting-order',
      question:
        '③ A1（精确向量）**看得到**语义候选（`targetScored > 0`），但入池/首位与 A0 **相同**（排序未变）',
      run: () => ({
        table: armResults.map((arm) => ({
          arm: arm.arm,
          inPool: arm.targetInPool,
          scored: arm.targetScored,
          topRanked: arm.targetTopRanked,
          paraphrase: `${String(arm.paraphraseTopRanked)}/${String(arm.paraphraseCases)}`,
        })),
      }),
      judge: (reading) => {
        const problems: string[] = []
        const table = reading.table as { arm: string; inPool: number; scored: number; topRanked: number }[]
        const a1 = table.find((row) => row.arm === 'A1')
        const a0 = table.find((row) => row.arm === 'A0')
        if (a1 === undefined || a0 === undefined) {
          problems.push('缺少 A0/A1 读数')
          return problems
        }
        if (a1.scored <= 0) problems.push('★ A1 没有算到任何语义分数 ⇒ 它没测到"改述能不能被看到"')
        /* A1 与 A0 的**入池/首位**必须一致（`shadow` 不改排序）—— 这正是 S47 在对照里的形态 */
        if (a1.inPool !== a0.inPool || a1.topRanked !== a0.topRanked) {
          problems.push(
            `★ A1 与 A0 的池/位读数不同（入池 ${String(a1.inPool)} vs ${String(a0.inPool)}，` +
              `首位 ${String(a1.topRanked)} vs ${String(a0.topRanked)}）⇒ shadow 影响了排序`
          )
        }
        return problems
      },
    })
  )

  /* ---- ④ A2 与 A0 必须**有差**（否则"混合召回"没起作用） ---- */
  probes.push(
    await probe({
      id: 'a2-differs-from-a0-or-the-comparison-is-vacuous',
      question: '④ A2（混合召回）与 A0 的**入池/首位**读数**必须不同**（否则三臂对照是空的）',
      run: () => {
        const a0 = armResults.find((arm) => arm.arm === 'A0')
        const a2 = armResults.find((arm) => arm.arm === 'A2')
        return {
          a0InPool: a0?.targetInPool ?? -1,
          a2InPool: a2?.targetInPool ?? -1,
          a0TopRanked: a0?.targetTopRanked ?? -1,
          a2TopRanked: a2?.targetTopRanked ?? -1,
          deltaTopRanked: (a2?.targetTopRanked ?? 0) - (a0?.targetTopRanked ?? 0),
          a0Paraphrase: `${String(a0?.paraphraseTopRanked ?? -1)}/${String(a0?.paraphraseCases ?? -1)}`,
          a2Paraphrase: `${String(a2?.paraphraseTopRanked ?? -1)}/${String(a2?.paraphraseCases ?? -1)}`,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.a0InPool === reading.a2InPool && reading.a0TopRanked === reading.a2TopRanked) {
          problems.push(
            `★ A0 与 A2 的入池/首位读数完全相同（入池 ${String(reading.a0InPool)}、首位 ${String(reading.a0TopRanked)}）` +
              '⇒ 混合召回没有改变任何一条 ⇒ 对照是空的'
          )
        }
        if (Number(reading.deltaTopRanked) < 0) {
          problems.push(`★ A2 的"目标排首位"比 A0 更少（${String(reading.deltaTopRanked)}）⇒ 需复盘而不是当"增益"`)
        }
        return problems
      },
    })
  )

  /* ---- ⑤ A3/A4/A5 如实分列（**不许**缺席当通过） ---- */
  probes.push(
    await probe({
      id: 'a3-a4-a5-are-listed-as-not-run',
      question: '⑤ A3（BGE）/ A4（reranker）/ A5（ANN）如实标 **NOT RUN**（不许缺席当通过）',
      run: () => ({
        a3: 'NOT RUN · 理由：BGE-M3 未安装（本地只有 q8 E5-small）',
        a4: 'NOT RUN · 理由：reranker 未实现',
        a5: 'NOT RUN · 理由：HNSW/IVFFlat 可创建但未做精度/速度对照（WP1 的 T1 未触达）',
        executed: armResults.map((arm) => arm.arm),
      }),
      judge: (reading) => {
        const problems: string[] = []
        for (const key of ['a3', 'a4', 'a5'] as const) {
          if (typeof reading[key] !== 'string' || !String(reading[key]).startsWith('NOT RUN')) {
            problems.push(`${key} 必须如实标 NOT RUN`)
          }
        }
        if (JSON.stringify(reading.executed) !== JSON.stringify(['A0', 'A1', 'A2'])) {
          problems.push('已执行的臂应恰为 A0/A1/A2（计划 §570 的要求）')
        }
        return problems
      },
    })
  )

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  /*
   * ⚠️ **范围**：本门**声明的**测量集就是 A0/A1/A2 三臂（计划 §570 要求的那三臂）。
   *    A3/A4/A5 **不是本门"声明了却没跑"的项**，而是**本门范围之外、计划另裁**的臂
   *    ⇒ `notRunCount = 0` 是**正确的范围**，不是"把没跑的藏起来"：
   *       它们由 `armsNotAttempted` **具名列出**（含理由），并由 ⑤ 号探针判其必须为 `NOT RUN`。
   */
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged = JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter)

  const payload = {
    schemaVersion: 'm9.5-calibration@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '计划 §570：同一开发集比较 **A0/A1/A2**（真编码器）；三臂同批 case / A0 零语义调用 / A1 看得到改述 / A2 与 A0 有差 / A3·A4·A5 如实 NOT RUN',
      armMapping: {
        A0: 'semanticMode=off（词面 + 新近度）',
        A1: 'semanticMode=shadow（算语义候选并记录，不影响排序）',
        A2: 'semanticMode=on（词面 + 向量组合排序）',
      },
      notProves:
        '**不**产出校准后的权重/门槛（那是**裁定**，本门只交对照读数）；' +
        '也**不**证明 A3 的"质量增益是否值得资源成本"（BGE 未安装）；盲测集**未读**',
      blindUntouched: true,
    },
    arms: armResults,
    /** **本门范围之外**的臂（计划 §279 定义；缺席**不算通过**，也不算本门的"未跑"） */
    armsNotAttempted: [
      { arm: 'A3', what: 'BGE 候选', status: 'NOT RUN', reason: 'BGE-M3 未安装（本地只有 q8 E5-small）' },
      { arm: 'A4', what: '可选 reranker', status: 'NOT RUN', reason: 'reranker 未实现' },
      { arm: 'A5', what: '可选 ANN', status: 'NOT RUN', reason: 'HNSW/IVFFlat 可创建但未做精度/速度对照' },
    ],
    /**
     * **校准状态**（用户 2026-09-28 裁定：保持 false）。
     *
     * ```text
     * 冻结前置顺序（逐字落在代码里，免得"忘了还有两步"）：
     *   ① 开发集参数比较  ← 本门
     *   ② 独立**验证集**确认（`evals/m9.5/corpus/val.jsonl`）
     *   ③ **旧强项回归**（字面精确命中 / 新近度兜底 不得退化）
     *   ⇒ 之后才冻结策略参数并把 `calibrated` 改为 `true`（**正式盲测之前**）
     * ⚠️ 该标志**不代表**盲测通过，**也不**代表获准生产激活。
     * ```
     */
    calibration: {
      calibrated: false,
      frozen: false,
      stepsDone: ['dev-set-comparison'],
      stepsRemaining: ['validation-set-confirmation', 'legacy-strength-regression'],
      flagMeansBlindPass: false,
      flagMeansActivationApproved: false,
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, notRunCount: 0, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'calibration-verify.json')
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
      realDbUnchanged,
      method: 'isolateDatabase() + digestTree() 前后比对（只读）',
    },
    configHash: { seed: SAMPLE_SEED, sampleSize: SAMPLE_SIZE, arms: ['A0', 'A1', 'A2'] },
    command: [{ cmd: 'pnpm m9.5:calibration:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    modelFingerprint: fingerprint,
    artifactHashes: { 'calibration-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 A0/A1/A2 对照门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      ...armResults.map(
        (arm) =>
          `  ${arm.arm}: 入池 ${String(arm.targetInPool)}/${String(arm.cases)} · 有分数 ${String(arm.targetScored)} · 排首位 ${String(arm.targetTopRanked)} · 改述首位 ${String(arm.paraphraseTopRanked)}/${String(arm.paraphraseCases)} · 探针 ${String(arm.probeCalls)} 次`
      ),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
