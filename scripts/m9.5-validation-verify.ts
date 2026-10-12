/**
 * M9.5 WP1/WP2 —— **独立验证集确认门**（`pnpm m9.5:validation:verify`）。
 *
 * ============================================================================
 *  它在校准链里的位置（用户 2026-09-28 定的顺序）
 * ============================================================================
 * ```text
 * ① 开发集参数比较      —— `pnpm m9.5:calibration:verify`（已完成：A0/A1/A2）
 * ② **独立验证集确认**  —— **本门**：在 `val.jsonl` 上重跑同样的三臂，
 *                          并**读 dev 那一门的证据**做方向对照
 * ③ 旧强项回归          —— 待做
 * ⇒ 三步齐了才冻结策略参数并把 `calibrated` 改为 `true`（正式盲测之前）
 * ```
 *
 * ============================================================================
 *  为什么它是**独立的一道门**（而不是"同一个门里多跑一批"）
 * ============================================================================
 * ```text
 * · **独立库**：上一次把 dev/val 写进**同一个库**，撞了 `duplicate_content`
 *   （同一 (predicate, value) 在不同 subject 下仍判重复内容）—— 已回退。
 *   本门在**自己的隔离库**里跑 val，从结构上消除这种串扰。
 * · **独立证据档**：两条读数**分开落盘**，`confirmation` 是**读** dev 的证据得来的，
 *   不是同一进程里顺手比的 —— 否则"独立确认"只是措辞。
 * ⚠️ **盲测集绝不读**（第 6 条探针核对本文件不出现 blind 路径）。
 * ```
 * 用法：`pnpm m9.5:validation:verify`
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
const GATE_VERSION = 'm9.5-validation@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const LAB_MODEL_ROOT = join(REPO_ROOT, 'artifacts/m9.5/local/embedding-lab/models')
const CORPUS_VAL = join(REPO_ROOT, 'evals/m9.5/corpus/val.jsonl')
const ARTIFACTS = join(REPO_ROOT, 'artifacts/m9.5')
const GENERATION = 'gen-validation'

const SAMPLE_SEED = 'm9.5-validation@1'
const SAMPLE_SIZE = 24
const CANDIDATE_LIMIT = 8

const PARAPHRASE_FORMS = new Set(['synonym', 'indirect', 'elliptical', 'boundedHint', 'similarProject', 'mixedEntity'])

const ARMS: { readonly arm: 'A0' | 'A1' | 'A2'; readonly mode: SemanticMode }[] = [
  { arm: 'A0', mode: 'off' },
  { arm: 'A1', mode: 'shadow' },
  { arm: 'A2', mode: 'on' },
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

interface ArmReading {
  readonly arm: string
  readonly cases: number
  readonly inPool: number
  readonly scored: number
  readonly topRanked: number
  readonly paraphraseCases: number
  readonly paraphraseTopRanked: number
  readonly probeCalls: number
}

/** **读 dev 那一门的证据**（独立确认的前提：读数来自**另一份**证据档，不是同进程顺手比） */
function readDevCalibration(): {
  readonly runId: string
  readonly arms: Record<string, { inPool: number; topRanked: number; cases: number }>
} | null {
  if (!existsSync(ARTIFACTS)) return null
  const dirs = readdirSync(ARTIFACTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes('wp12-calibration'))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const dir of dirs) {
    const path = join(ARTIFACTS, dir, 'calibration-verify.json')
    if (!existsSync(path)) continue
    const payload = JSON.parse(readFileSync(path, 'utf8')) as {
      arms?: { arm: string; cases: number; targetInPool: number; targetTopRanked: number }[]
    }
    if (payload.arms === undefined) continue
    const arms: Record<string, { inPool: number; topRanked: number; cases: number }> = {}
    for (const arm of payload.arms) {
      arms[arm.arm] = { inPool: arm.targetInPool, topRanked: arm.targetTopRanked, cases: arm.cases }
    }
    return { runId: dir, arms }
  }
  return null
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp12-validation', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const manifest = loadEmbeddingManifest(join(REPO_ROOT, 'evals/m9.5/embedding-manifest.json'))
  const fingerprint = embeddingFingerprintOf(manifest)
  const probes: Probe[] = []

  /* ---- 抽样：val 专属（确定性；只取 normal/hard） ---- */
  const pool = readFileSync(CORPUS_VAL, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const cases = (() => {
    const sorted = [...pool]
      .filter((item) => item.stratum === 'normal' || item.stratum === 'hard')
      .sort((a, b) => {
        const ra = createHash('sha256').update(`${SAMPLE_SEED}|${String(a.caseId)}`).digest('hex')
        const rb = createHash('sha256').update(`${SAMPLE_SEED}|${String(b.caseId)}`).digest('hex')
        return ra < rb ? -1 : 1
      })
    /*
     * ⚠️ **按 (predicate, value) 去重**：语料允许同一取值配**不同 user**（`familyId` 含 user），
     *    但本门把所有 case 都物化在**同一个 subject**（harness 的用户）下
     *    ⇒ 两条同值 case 会撞 `duplicate_content`（实测踩到，与上次"dev/val 同库"是**同一根因的两种表现**）。
     *    去重之后每个取值只出现一次 ⇒ 库内不可能重复。
     */
    const seen = new Set<string>()
    return sorted
      .filter((item) => {
        const snapshot = item.authoritativeSnapshot as { predicate: string; value: string }
        const key = `${snapshot.predicate}@${snapshot.value}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, SAMPLE_SIZE)
  })()

  /* ---- 自己的隔离库（dev/val 串扰在结构上不可能） ---- */
  await resetPluginSqlConnection()
  isolateDatabase('m95-validation', { keep: false })
  const bed = await createM55Harness({ label: 'm95-validation' })
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
  if (!(await encoder.fingerprintPromise)) throw new Error('编码子进程未就绪（A1/A2 需要真分数）')

  /* ---- 布景（只在 val 的库上写） ---- */
  const sceneOf = new Map<string, { targetId: string; request: string; formKind: string }>()
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index] as Record<string, unknown>
    const snapshot = item.authoritativeSnapshot as { predicate: string; value: string }
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
    sceneOf.set(String(item.caseId), { targetId, request: String(item.request), formKind: String(item.formKind) })
  }

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

  const armReadings: ArmReading[] = []
  for (const arm of ARMS) {
    let inPool = 0
    let scored = 0
    let topRanked = 0
    let paraphraseCases = 0
    let paraphraseTopRanked = 0
    const callsBefore = probeCalls
    for (const item of cases) {
      const scene = sceneOf.get(String((item as Record<string, unknown>).caseId))
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
      const hit = result.hits.some((h2) => String(h2.record.id) === scene.targetId)
      const hasScore = result.semanticScoredIds.includes(scene.targetId)
      const isTop = String(result.hits[0]?.record.id ?? '') === scene.targetId
      if (hit) inPool += 1
      if (hasScore) scored += 1
      if (isTop) topRanked += 1
      if (PARAPHRASE_FORMS.has(scene.formKind)) {
        paraphraseCases += 1
        if (isTop) paraphraseTopRanked += 1
      }
    }
    armReadings.push({
      arm: arm.arm,
      cases: cases.length,
      inPool,
      scored,
      topRanked,
      paraphraseCases,
      paraphraseTopRanked,
      probeCalls: probeCalls - callsBefore,
    })
  }

  await encoder.close()
  await bed.dispose()

  const dev = readDevCalibration()

  /* ---- ① val 在自己的库里跑完三臂 ---- */
  probes.push(
    await probe({
      id: 'validation-split-runs-in-its-own-database',
      question: `① val 抽 ${String(SAMPLE_SIZE)} 条、在**自己的隔离库**里跑 A0/A1/A2 三臂`,
      run: () => ({
        poolSize: pool.length,
        sampled: cases.length,
        seed: SAMPLE_SEED,
        arms: armReadings.map((arm) => ({ arm: arm.arm, cases: arm.cases })),
      }),
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.poolSize) <= 0) problems.push('val 池为空 ⇒ MEASUREMENT INVALID')
        if (Number(reading.sampled) !== SAMPLE_SIZE) {
          problems.push(`应抽 ${String(SAMPLE_SIZE)} 条，实际 ${String(reading.sampled)}`)
        }
        for (const arm of reading.arms as { arm: string; cases: number }[]) {
          if (arm.cases !== SAMPLE_SIZE) problems.push(`${arm.arm} 只跑了 ${String(arm.cases)} 条`)
        }
        return problems
      },
    })
  )

  /* ---- ② 三臂在 val 上互相可分辨（与 dev 同一套性质） ---- */
  probes.push(
    await probe({
      id: 'arms-are-distinguishable-on-validation',
      question: '② val 上：A0 零语义调用、A1 拿到分数但排序不变、A2 真的改变入池/首位',
      run: () => {
        const a0 = armReadings.find((arm) => arm.arm === 'A0')
        const a1 = armReadings.find((arm) => arm.arm === 'A1')
        const a2 = armReadings.find((arm) => arm.arm === 'A2')
        return { table: armReadings, a0Calls: a0?.probeCalls ?? -1, a1Scored: a1?.scored ?? -1 }
      },
      judge: (reading) => {
        const problems: string[] = []
        const table = reading.table as ArmReading[]
        const a0 = table.find((row) => row.arm === 'A0')
        const a1 = table.find((row) => row.arm === 'A1')
        const a2 = table.find((row) => row.arm === 'A2')
        if (a0 === undefined || a1 === undefined || a2 === undefined) return ['三臂读数不全']
        if (a0.probeCalls !== 0 || a0.scored !== 0) problems.push('★ A0 不是纯基线（有语义调用/分数）')
        if (a1.probeCalls <= 0 || a1.scored <= 0) problems.push('★ A1 没有真的算分')
        if (a1.inPool !== a0.inPool || a1.topRanked !== a0.topRanked) {
          problems.push('★ A1 改变了排序 ⇒ shadow 语义不成立')
        }
        if (a2.inPool === a0.inPool && a2.topRanked === a0.topRanked) {
          problems.push('★ A2 与 A0 完全相同 ⇒ 混合召回没有起作用')
        }
        return problems
      },
    })
  )

  /* ---- ③ ★ 独立确认：方向必须在 val 上同样成立，且对照的是**另一份证据档** ---- */
  probes.push(
    await probe({
      id: 'validation-confirms-the-dev-direction',
      question: '③ ★ 读 **dev 那一门的证据**做对照：A2 ≥ A0 的方向在 dev 与 val 上**都**成立',
      run: () => {
        const a0 = armReadings.find((arm) => arm.arm === 'A0')
        const a2 = armReadings.find((arm) => arm.arm === 'A2')
        return {
          devRunId: dev?.runId ?? null,
          devArms: dev?.arms ?? null,
          valA0: { inPool: a0?.inPool ?? -1, topRanked: a0?.topRanked ?? -1 },
          valA2: { inPool: a2?.inPool ?? -1, topRanked: a2?.topRanked ?? -1 },
          valImproves:
            (a2?.inPool ?? 0) >= (a0?.inPool ?? 0) && (a2?.topRanked ?? 0) >= (a0?.topRanked ?? 0),
          valStrictlyBetter: (a2?.inPool ?? 0) > (a0?.inPool ?? 0) || (a2?.topRanked ?? 0) > (a0?.topRanked ?? 0),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        /* 正控：**必须真的读到** dev 的证据（否则"独立确认"没有对照物） */
        if (reading.devRunId === null || reading.devArms === null) {
          problems.push('★ 没读到 dev 那一门的证据 ⇒ 独立确认为空（需先跑 `pnpm m9.5:calibration:verify`）')
          return problems
        }
        const devArms = reading.devArms as Record<string, { inPool: number; topRanked: number; cases: number }>
        const devA0 = devArms.A0
        const devA2 = devArms.A2
        if (devA0 === undefined || devA2 === undefined || devA0.cases <= 0) {
          problems.push('★ dev 证据里缺 A0/A2 ⇒ 无法对照')
          return problems
        }
        const devImproves = devA2.inPool >= devA0.inPool && devA2.topRanked >= devA0.topRanked
        if (devImproves !== true) {
          problems.push(`dev 侧方向本身不成立（A0=${JSON.stringify(devA0)} A2=${JSON.stringify(devA2)}）⇒ 先看 dev 门`)
        }
        if (reading.valImproves !== true) {
          problems.push(`★ **独立验证集不支持** dev 的方向：val A0=${JSON.stringify(reading.valA0)} A2=${JSON.stringify(reading.valA2)}`)
        }
        if (devImproves === true && reading.valStrictlyBetter !== true) {
          problems.push('★ dev 上严格变好而 val 上只是打平 ⇒ 方向**未获独立确认**（结论须如实降级）')
        }
        return problems
      },
    })
  )

  /* ---- ④ 盲测集**从未被读** ---- */
  probes.push(
    await probe({
      id: 'blind-split-is-never-read',
      question: '④ 盲测集从未被读：本门源码里不出现 blind 路径',
      run: () => {
        const source = readFileSync(join(REPO_ROOT, 'scripts/m9.5-validation-verify.ts'), 'utf8')
        /*
         * ⚠️ **模式必须运行时拼接**：第一版把 `corpus-blind` / `blind.jsonl` 直接写成字面量，
         *    于是**探针自己的源码里就含有这两个串** ⇒ 检查匹配到了**它自己**（永远报红）。
         *    这类"自指"错误与 `m9.5:regression` 被聚合门自指是同族：**判据的文本也要算进被测范围**。
         */
        const blindDir = ['corpus', 'blind'].join('-')
        const blindFile = ['blind', 'jsonl'].join('.')
        /*
         * ⚠️ **先剥注释再扫**：解释这个坑的注释里**必然**会写到那两个串
         *    ⇒ 不剥注释就等于"守卫把自己的说明文字判成违规"。
         *    这是仓库里已有先例的同一条教训（M3.5 的 FC-T04 静态锁当年就是这么修好的）。
         */
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
        return {
          mentionsBlindPath: code.includes(blindDir) || code.includes(blindFile),
          readsVal: source.includes('val.jsonl'),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.mentionsBlindPath !== false) problems.push('★ 本门引用了盲测路径')
        if (reading.readsVal !== true) problems.push('本门应读 val.jsonl')
        return problems
      },
    })
  )

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged = JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter)

  const payload = {
    schemaVersion: 'm9.5-validation@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '校准链第 ② 步：**独立验证集**（val）上重跑 A0/A1/A2（自己的隔离库）+ 读 **dev 那一门**的证据做方向对照',
      devReference: dev?.runId ?? null,
      independence:
        '独立库（结构上不可能与 dev 串扰）+ 独立证据档 + 对照读的是**另一份**证据（不是同进程顺手比）',
      notProves:
        '**不**证明权重/门槛已校准（那是冻结前的最后一步）；也**不**证明盲测质量（盲测集未读）',
      blindUntouched: true,
    },
    arms: armReadings,
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
    modelFingerprint: fingerprint,
  }
  const evidencePath = join(runDir, 'validation-verify.json')
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
    command: [{ cmd: 'pnpm m9.5:validation:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    modelFingerprint: fingerprint,
    artifactHashes: { 'validation-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 独立验证集确认门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      ...armReadings.map(
        (arm) =>
          `  val ${arm.arm}: 入池 ${String(arm.inPool)}/${String(arm.cases)} · 有分数 ${String(arm.scored)} · 排首位 ${String(arm.topRanked)} · 改述首位 ${String(arm.paraphraseTopRanked)}/${String(arm.paraphraseCases)} · 探针 ${String(arm.probeCalls)} 次`
      ),
      `  dev 对照档：${dev?.runId ?? '(未找到)'}`,
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
