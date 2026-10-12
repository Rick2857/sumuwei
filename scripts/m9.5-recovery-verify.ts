/**
 * M9.5 WP9 —— **恢复门**（`pnpm m9.5:recovery:verify`）。
 *
 * ============================================================================
 *  计划 §12 WP9 的 recovery 栏：「**故障注入、恢复、generation 回滚**」
 * ============================================================================
 * ```text
 * ① **故障注入 ⇒ 如实降级，原链独立工作**
 *    探针失败（超时/模型缺/未索引）时：语义列 `unavailable` 且**具名**，候选照常返回。
 * ② **恢复 ⇒ 不留楔子**
 *    同一个店在故障消除后必须**立刻**恢复可用 —— 不许把失败**缓存**下来
 *    （"一次超时之后永远不可用"是最难发现的形态：它看起来像"本来就没有这个能力"）。
 * ③ **generation 回滚 ⇒ 回到上一代且读数可核对**
 *    原子切换（旧的转 `unavailable`、新的转 `published`）与回滚都要能逐代核对分数来源。
 * ④ **切换半途 ⇒ 失败关闭**
 *    同指纹下有**多于一个** published ⇒ 代的身份不唯一 ⇒ 拒绝服务（不猜、不取最大分）。
 * ⑤ **重启无状态丢失**：派生表已就位时 `ensureSemanticIndexSchema` 是 `noop`（零语句）。
 * ```
 * 用法：`pnpm m9.5:recovery:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import {
  SEMANTIC_INDEX_SCHEMA_VERSION,
  ensureSemanticIndexSchema,
} from '../src/infrastructure/persistence/memory-semantic-index.ts'
import { createSemanticProbe } from '../src/infrastructure/semantic/semantic-probe.ts'
import {
  embeddingFingerprintOf,
  loadEmbeddingManifest,
} from '../src/infrastructure/semantic/embedding-manifest.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import { createRecallRequest } from '../src/kernel/contracts/recall.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'

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
const GATE_VERSION = 'm9.5-recovery@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const DIMENSION = 384
const GEN_OLD = 'gen-recovery-old'
const GEN_NEW = 'gen-recovery-new'

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

/** 造一个"指向某个单位向量"的 384 维向量（**不加载模型**：本门只测恢复语义）。 */
function unitVector(index: number): number[] {
  const vector = new Array<number>(DIMENSION).fill(0)
  vector[index % DIMENSION] = 1
  return vector
}

function toLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => value.toFixed(8)).join(',')}]`
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp9-recovery', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const manifest = loadEmbeddingManifest(join(REPO_ROOT, 'evals/m9.5/embedding-manifest.json'))
  /*
   * ⚠️ 必须用**真的**模型指纹（`embeddingFingerprintOf`）：
   *    探针是拿它与当前清单比对来决定"服务哪一代"的。
   *    第一版我自造了一个 `fp-recovery-q8` 串 ⇒ 所有代都被判 `generation_mismatch`
   *    （这个错被本门自己的探针抓出来了 —— 正是"门要能抓自己的量具错"）。
   */
  const fingerprint = embeddingFingerprintOf(manifest)
  const probes: Probe[] = []

  await resetPluginSqlConnection()
  isolateDatabase('m95-wp9-recovery', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp9-recovery' })
  const h = bed.h
  const db = h.db
  const namespace = String(h.characterId)
  /* `h.characterId` 是普通 string；端口的 namespace 参数是品牌类型 */
  const characterId = h.characterId as unknown as CharacterId

  await ensureSemanticIndexSchema(db, { now: 1_800_000_000_000 })

  /* 布景：一条记忆；两个"代"各自写一条向量（旧代的向量与查询更近） */
  const evidence = await h.recordUserEvidence('记住：我在写毕业论文。')
  const target = await h.commitAndFold(
    h.makeCandidate('person_fact', claim('project.background.active', '毕业论文', h.user), {
      sourceRefs: [evidence.ref],
    }),
    M4_T0 + 100
  )
  const targetId = String(target?.id ?? '')

  const insertGeneration = async (generationId: string, state: string, publishedAt: number): Promise<void> => {
    await db.execute(
      sql`insert into memory_semantic_generations
          (generation_id, namespace, model_fingerprint, renderer_version, dimension,
           index_schema_version, build_state, created_at, published_at)
          values (${generationId}, ${namespace}, ${fingerprint}, ${'r@1'}, ${DIMENSION},
                  ${SEMANTIC_INDEX_SCHEMA_VERSION}, ${state}, ${publishedAt}, ${publishedAt})`
    )
  }
  const insertVector = async (generationId: string, index: number): Promise<void> => {
    await db.execute(
      sql`insert into memory_semantic_index
          (namespace, memory_id, source_revision, generation_id, model_fingerprint, renderer_version,
           content_hash, tokenizer_fingerprint, pooling, normalize, dtype, dimension, embedding, created_at)
          values (${namespace}, ${targetId}, ${1}, ${generationId}, ${fingerprint}, ${'r@1'},
                  ${'h'}, ${'t'}, ${'mean'}, ${true}, ${manifest.dtype}, ${DIMENSION},
                  ${toLiteral(unitVector(index))}::vector, ${1})`
    )
  }

  /* 旧代：向量 e0；查询用 e0 ⇒ 余弦 1.0（可核对） */
  await insertGeneration(GEN_OLD, 'published', 1_000)
  await insertVector(GEN_OLD, 0)
  /*
   * 新代先处于 `building`（**这就是"重建半途"**）：此时必须**继续服务旧代**。
   */
  await insertGeneration(GEN_NEW, 'building', 2_000)
  await insertVector(GEN_NEW, 100)

  /** 探针用的假编码器：查询向量恒为 e0（于是"服务哪一代"直接体现在分数上） */
  const encoderFor = (queryIndex: number) => ({
    encode: async () => ({ ok: true as const, vectors: [unitVector(queryIndex)], dimension: DIMENSION }),
  })
  const failingEncoder = {
    encode: async () => ({ ok: false as const, reason: 'timeout', detail: 'injected' }),
  }

  const scoreOnce = async (encoder: { encode: unknown }): Promise<{ ok: boolean; reason?: string; score?: number }> => {
    const probeImpl = createSemanticProbe({
      db,
      manifest,
      encoder: encoder as Parameters<typeof createSemanticProbe>[0]['encoder'],
    })
    const result = await probeImpl.score({
      characterId,
      text: '我在写什么？',
      memoryIds: [targetId] as never,
    })
    return result.ok ? { ok: true, score: result.scores.get(targetId) } : { ok: false, reason: result.reason }
  }

  /* ---- ① 重建半途：仍在服务**已发布**的旧代 ---- */
  probes.push(
    await probe({
      id: 'mid-build-serves-the-published-generation',
      question: '① 新代还在 `building` 时**继续服务旧代**（重建半途不影响在线读数）',
      run: async () => ({ reading: await scoreOnce(encoderFor(0)) }),
      judge: (reading) => {
        const result = reading.reading as { ok: boolean; reason?: string; score?: number }
        const problems: string[] = []
        if (result.ok !== true) problems.push(`应服务已发布的旧代，实际失败：${String(result.reason)}`)
        /* 旧代向量 = e0、查询 = e0 ⇒ 余弦 1.0（"服务的是哪一代"直接读得出来） */
        if (!(Math.abs((result.score ?? -1) - 1) < 1e-6)) {
          problems.push(`分数应为 1.0（旧代向量与查询同向），实际 ${String(result.score)}`)
        }
        return problems
      },
    })
  )

  /* ---- ② 切换：新代转 published、旧代转 unavailable ⇒ 读数切到新代 ---- */
  probes.push(
    await probe({
      id: 'atomic-switch-changes-the-served-generation',
      question: '② 原子切换后读数切到新代（分数从 1.0 变成 0.0 —— 新代向量与查询正交）',
      run: async () => {
        await db.execute(sql`update memory_semantic_generations set build_state = 'unavailable' where generation_id = ${GEN_OLD}`)
        await db.execute(sql`update memory_semantic_generations set build_state = 'published' where generation_id = ${GEN_NEW}`)
        return { reading: await scoreOnce(encoderFor(0)) }
      },
      judge: (reading) => {
        const result = reading.reading as { ok: boolean; reason?: string; score?: number }
        const problems: string[] = []
        if (result.ok !== true) problems.push(`切换后应能服务新代，实际失败：${String(result.reason)}`)
        if (!(Math.abs((result.score ?? -1) - 0) < 1e-6)) {
          problems.push(`分数应为 0.0（新代向量与查询正交），实际 ${String(result.score)} ⇒ 读数没切到新代`)
        }
        return problems
      },
    })
  )

  /* ---- ③ ★ 切换半途（两代都 published）⇒ 失败关闭，不猜 ---- */
  probes.push(
    await probe({
      id: 'two-published-generations-refuse-to-serve',
      question: '③ ★ 同指纹下有**两个** published ⇒ 代的身份不唯一 ⇒ **拒绝服务**（不许取最大分糊过去）',
      run: async () => {
        await db.execute(sql`update memory_semantic_generations set build_state = 'published' where generation_id = ${GEN_OLD}`)
        const result = await scoreOnce(encoderFor(0))
        return { result, publishedCount: 2 }
      },
      judge: (reading) => {
        const result = reading.result as { ok: boolean; reason?: string }
        const problems: string[] = []
        if (result.ok !== false) {
          problems.push(
            '★ 两代并存的半途状态下竟然服务成功 ⇒ 在"猜"该用哪一代（那是"她记得什么"随切换时机漂移的成因）'
          )
        }
        if (result.reason !== 'generation_mismatch') {
          problems.push(`拒绝理由应具名为 generation_mismatch，实际 ${String(result.reason)}`)
        }
        return problems
      },
    })
  )

  /* ---- ④ 回滚：新代转 unavailable ⇒ 回到旧代读数（可核对） ---- */
  probes.push(
    await probe({
      id: 'rollback-restores-the-previous-generation',
      question: '④ 回滚（新代转 unavailable）⇒ 读数**回到旧代**（1.0），且没有残留状态',
      run: async () => {
        /*
         * 回滚 = 把**新代**撤销发布、把**旧代**恢复为唯一已发布的一代。
         * ⚠️ 第一版把 `GEN_OLD` 标成了 unavailable（写反了）—— 那测的是"切换"而不是"回滚"，
         *    读数当然是新代的 0.0。量具写错方向是这一门最容易犯的错：
         *    它不会报错，只会给出一个**看起来合理**的数。
         */
        await db.execute(sql`update memory_semantic_generations set build_state = 'unavailable' where generation_id = ${GEN_NEW}`)
        await db.execute(sql`update memory_semantic_generations set build_state = 'published' where generation_id = ${GEN_OLD}`)
        const result = await scoreOnce(encoderFor(0))
        return { result }
      },
      judge: (reading) => {
        const result = reading.result as { ok: boolean; score?: number }
        const problems: string[] = []
        if (result.ok !== true) problems.push('回滚后应能服务旧代')
        if (!(Math.abs((result.score ?? -1) - 1) < 1e-6)) {
          problems.push(`回滚后分数应回到 1.0，实际 ${String(result.score)}`)
        }
        return problems
      },
    })
  )

  /* ---- ⑤ 故障注入 ⇒ 具名降级；恢复 ⇒ **不留楔子** ---- */
  /*
   * ⚠️ 铺垫只做一件事：保证**恰好一代**已发布（GEN_OLD）。
   *    第一版在这里又插了一个 published 的代 ⇒ 变成"两代并存"被拒服务，
   *    于是断言全部失败 —— 故障注入应当是**编码器**故障，不是"把代搞乱"。
   */
  await db.execute(sql`update memory_semantic_generations set build_state = 'unavailable' where generation_id <> ${GEN_OLD}`)

  const storeWith = (encoderImpl: { encode: unknown }) =>
    createMemoryRetrievalStore({
      store: h.store,
      integrity: (owner) => memoryIntegrityProblems(db, owner),
      rootReadings: (ids) => rootReadingsByMemory(db, ids),
      semanticProbe: createSemanticProbe({
        db,
        manifest,
        encoder: encoderImpl as Parameters<typeof createSemanticProbe>[0]['encoder'],
      }),
    })

  const observe = async (encoderImpl: { encode: unknown }): Promise<{ hits: number; semanticScored: number }> => {
    const port = storeWith(encoderImpl)
    const recallPort = createRecallTurnPort({
      service: createMemoryRecallService({ port }),
      budget: DEFAULT_CONTEXT_BUDGET,
      now: () => M4_T0 + 10_000,
    })
    const outcome = await recallPort.run(
      createRecallRequest({
        traceId: newTraceId(),
        characterId: String(h.characterId),
        user: entityRef('user', String(h.user.id)),
        query: { text: '我在写什么？', source: 'user_message' },
        intent: 'current_fact',
        candidateLimit: 10,
        contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
        retrievalPolicyVersion: 'hybrid-relevance@1',
      })
    )
    /*
     * 从 trace 读：`semanticScoredCount` 直接就是"这一轮语义有没有真的参与"，
     * 比经 `record.capabilities` 更贴题（capabilities 在端口返回里，不在决策记录上）。
     */
    return { hits: outcome.trace.candidateCount, semanticScored: outcome.trace.semanticScoredCount }
  }

  probes.push(
    await probe({
      id: 'fault-then-recovery-leaves-no-wedge',
      question: '⑤ 故障注入 ⇒ 语义不可用而候选照常；**恢复后立刻可用**（不缓存失败）',
      run: async () => {
        const broken = await observe(failingEncoder)
        const recovered = await observe(encoderFor(0))
        return { broken, recovered }
      },
      judge: (reading) => {
        const broken = reading.broken as { hits: number; semanticScored: number }
        const recovered = reading.recovered as { hits: number; semanticScored: number }
        const problems: string[] = []
        if (broken.semanticScored !== 0) problems.push('故障时不应有语义分数')
        if (broken.hits <= 0) problems.push('★ 故障时原链必须独立工作（候选不能为 0）')
        if (recovered.semanticScored <= 0) {
          problems.push('★ 恢复后语义仍不可用 ⇒ 失败被缓存下来了（"一次超时之后永远不可用"）')
        }
        if (recovered.hits <= 0) problems.push('恢复后候选也不应为 0')
        return problems
      },
    })
  )

  /* ---- ⑥ 重启：派生表已就位 ⇒ noop（零语句），状态不丢 ---- */
  probes.push(
    await probe({
      id: 'restart-does-not-reset-derived-state',
      question: '⑥ "重启"（重新跑建表器）⇒ `noop` 零语句；已发布的代与向量仍在 ⇒ 读数不变',
      run: async () => {
        const before = await scoreOnce(encoderFor(0))
        const ensure = await ensureSemanticIndexSchema(db, { now: 1_900_000_000_000 })
        const after = await scoreOnce(encoderFor(0))
        const generations = rowsOf(
          await db.execute(
            sql`select build_state, count(*)::int as c from memory_semantic_generations
                where generation_id = ${GEN_OLD} group by build_state`
          )
        )
        return {
          ensureAction: ensure.action,
          ensureStatements: ensure.statementsRun,
          before,
          after,
          oldGeneration: generations.map((row) => ({ state: String(row.build_state), count: Number(row.c) })),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.ensureAction !== 'noop') {
          problems.push(`重启时建表器应为 noop，实际 ${String(reading.ensureAction)}`)
        }
        if (reading.ensureStatements !== 0) problems.push('noop 应跑 0 条语句')
        const before = reading.before as { ok: boolean; score?: number }
        const after = reading.after as { ok: boolean; score?: number }
        if (before.ok !== true || after.ok !== true) problems.push('重启前后都应能服务')
        if (before.score !== after.score) problems.push('重启改变了读数 ⇒ 状态丢失')
        return problems
      },
    })
  )

  await bed.dispose()
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged = JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter)

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })

  const payload = {
    schemaVersion: 'm9.5-recovery@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '重建半途继续服务旧代 / 原子切换 / **两个 published 时失败关闭** / 回滚回到旧代 / 故障注入后恢复不留楔子 / 重启不重置派生状态',
      notProves:
        '**不**证明进程级重启（本门用"重跑建表器 + 重读"模拟）；也**不**证明真实模型下的恢复（本门用确定性向量，模型路径由 `m9.5:probe:verify` 守）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'recovery-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp9',
    lane: 'offline',
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
    configHash: { generations: [GEN_OLD, GEN_NEW], dimension: DIMENSION },
    command: [{ cmd: 'pnpm m9.5:recovery:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'recovery-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP9 恢复门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
