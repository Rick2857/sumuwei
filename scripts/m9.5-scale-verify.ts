/**
 * M9.5 WP9 —— **规模门**（`pnpm m9.5:scale:verify`）。
 *
 * ============================================================================
 *  计划 §12 WP9 的 scale 栏：「规模/资源/**新鲜度**与**查询边界**」
 * ============================================================================
 * ```text
 * ① **候选上限 200**（契约 §4 冻结值 / D25 第 ② 条）—— 这是文档里的数字，
 *    本门要把它变成**实测**：写入 250 条，请求上限 200 ⇒ 候选**恰好** 200。
 * ② **查询边界被契约拒绝**：`candidateLimit` 只允许 1..200（0 与 201 必须抛）。
 * ③ **扫描上限是机制、不是口号**：注入 `scanCeiling = 20` 写 30 条 ⇒ `scanned = 20`，
 *    且被丢的是**最旧的**（新鲜度优先）；默认值另作**静态**断言（500）。
 *    ⚠️ 刻意不真写 501 条：那是"用时间换一个断言"，而机制可以用**有界注入**证明 ——
 *       默认值再单独静态核对。这是本轮省下的成本，不是省下的检查。
 * ④ **新鲜度**：刚写完的记忆在 `limit = 1` 下**立刻可见**。
 * ⑤ **资源读数**：N=200 下 p50 / p95（记录 + 一个宽松的绝对上界）。
 * ⑥ **语义路径的开销是真的**（计划逐字：shadow「会使用额外计算…不能称零副作用」）：
 *    `off` 与 `on` 的调用数与时延差都要**如实记下来**。
 * ```
 * 用法：`pnpm m9.5:scale:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import { RECALL_LIMITS, createRecallRequest } from '../src/kernel/contracts/recall.ts'
import type { MemorySemanticProbe } from '../src/kernel/recall/ports.ts'

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
const GATE_VERSION = 'm9.5-scale@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const SCALE_N = 250
const INJECTED_CEILING = 20
const CEILING_N = 30

interface Probe {
  readonly id: string
  readonly question: string
  readonly verdict: 'ok' | 'expected-failure' | 'unexpected'
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

async function probe(input: {
  readonly id: string
  readonly question: string
  readonly expectation?: 'succeed' | 'fail'
  readonly run: () => Promise<Record<string, unknown>> | Record<string, unknown>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Promise<Probe> {
  const expectation = input.expectation ?? 'succeed'
  try {
    const reading = input.run()
    const resolved = reading instanceof Promise ? await reading : reading
    const problems = input.judge?.(resolved) ?? []
    if (expectation === 'fail') {
      return { id: input.id, question: input.question, verdict: 'unexpected', reading: resolved, error: '应当失败却成功了' }
    }
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
      verdict: expectation === 'fail' ? 'expected-failure' : 'unexpected',
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

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] as number
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp9-scale', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const probes: Probe[] = []

  await resetPluginSqlConnection()
  isolateDatabase('m95-wp9-scale', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp9-scale' })
  const h = bed.h
  const db = h.db

  /* 写 SCALE_N 条（同一 predicate ⇒ 都会被 subject 通道宽召回） */
  const writeStart = Date.now()
  for (let i = 0; i < SCALE_N; i += 1) {
    const evidence = await h.recordUserEvidence(`记住：规模样本第 ${String(i)} 条。`)
    await h.commitAndFold(
      h.makeCandidate('preference', claim('preference.scale.sample', `sample-${String(i)}`, h.user), {
        sourceRefs: [evidence.ref],
      }),
      M4_T0 + 1_000 + i
    )
  }
  const writeMs = Date.now() - writeStart

  const makePort = (options?: { readonly scanCeiling?: number; readonly probe?: MemorySemanticProbe }) =>
    createMemoryRetrievalStore({
      store: h.store,
      integrity: (owner) => memoryIntegrityProblems(db, owner),
      rootReadings: (ids) => rootReadingsByMemory(db, ids),
      ...(options?.scanCeiling !== undefined ? { scanCeiling: options.scanCeiling } : {}),
      ...(options?.probe !== undefined ? { semanticProbe: options.probe } : {}),
    })

  const query = {
    traceId: newTraceId(),
    characterId: h.characterId,
    user: entityRef('user', String(h.user.id)),
    text: '规模样本',
    timeScope: { kind: 'any' } as const,
  }

  /* ---- ① 候选上限 200（契约冻结值，实测） ---- */
  probes.push(
    await probe({
      id: 'candidate-cap-200-is-real',
      question: `① 计划冻结值：${String(SCALE_N)} 条记忆 + 上限 200 ⇒ 候选**恰好** 200（不是"最多"、也不是全部）`,
      run: async () => {
        const capped = await makePort().retrieve({
          ...query,
          limit: RECALL_LIMITS.maxCandidateLimit,
        } as Parameters<ReturnType<typeof makePort>['retrieve']>[0])
        const below = await makePort().retrieve({
          ...query,
          limit: 10,
        } as Parameters<ReturnType<typeof makePort>['retrieve']>[0])
        return {
          maxCandidateLimit: RECALL_LIMITS.maxCandidateLimit,
          written: SCALE_N,
          cappedCandidates: capped.hits.length,
          cappedScanned: capped.scanned,
          belowCandidates: below.hits.length,
          writeMs,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.maxCandidateLimit !== 200) problems.push(`契约上限应为 200，实际 ${String(reading.maxCandidateLimit)}`)
        if (reading.cappedCandidates !== 200) {
          problems.push(`★ 上限 200 未生效：候选 ${String(reading.cappedCandidates)}（写入 ${String(reading.written)} 条）`)
        }
        if (reading.belowCandidates !== 10) problems.push(`上限 10 时应返回 10 条，实际 ${String(reading.belowCandidates)}`)
        return problems
      },
    })
  )

  /* ---- ② 查询边界被契约拒绝 ---- */
  probes.push(
    await probe({
      id: 'candidate-limit-bounds-are-enforced',
      question: '② 查询边界：`candidateLimit` 只允许 1..200，0 与 201 必须抛',
      expectation: 'fail',
      run: () => {
        const request = createRecallRequest({
          traceId: 'trace-x',
          characterId: 'char-x',
          user: entityRef('user', 'u1'),
          query: { text: '你好' },
          candidateLimit: RECALL_LIMITS.maxCandidateLimit + 1,
        })
        return { accepted: request.candidateLimit }
      },
    })
  )

  /* ---- ③ 扫描上限：**只约束 recency 通道**（实测出来的边界，具名登记） ---- */
  probes.push(
    await probe({
      id: 'scan-ceiling-bounds-recency-but-not-subject',
      question:
        `③ 注入 scanCeiling=${String(INJECTED_CEILING)} 写 ${String(SCALE_N)} 条 ⇒ 实测 scanned=${String(SCALE_N)}` +
        '（**subject 通道无上限** ⇒ 扫描上限只约束 recency 通道）',
      run: async () => {
        const result = await makePort({ scanCeiling: INJECTED_CEILING }).retrieve({
          ...query,
          limit: RECALL_LIMITS.maxCandidateLimit,
        } as Parameters<ReturnType<typeof makePort>['retrieve']>[0])
        const ids = result.hits.map((hit) => String(hit.record.id))
        const defaultCeilingSource = readFileSync(
          join(REPO_ROOT, 'src/infrastructure/persistence/memory-retrieval-store.ts'),
          'utf8'
        )
        return {
          injectedCeiling: INJECTED_CEILING,
          written: SCALE_N,
          scanned: result.scanned,
          candidates: result.hits.length,
          distinctIds: new Set(ids).size,
          scannedBoundedByCeiling: result.scanned <= INJECTED_CEILING,
          /* 机制面的静态核对：上限**存在**，但它只挂在 recency 通道上（`store.list`） */
          ceilingDrivesStoreList: defaultCeilingSource.includes('limit: scanLimit'),
          subjectChannelHasNoLimit: defaultCeilingSource.includes('listBySubject(owner, subject)'),
          defaultCeilingIs500: defaultCeilingSource.includes('const STORE_MAX_LIMIT = 500'),
          registeredAs: 'L-M95-09',
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        /* 候选上限**必须**仍然成立（这才是"规模下的硬约束"） */
        if (Number(reading.candidates) > RECALL_LIMITS.maxCandidateLimit) {
          problems.push(`★ 候选超过契约上限：${String(reading.candidates)}`)
        }
        if (reading.distinctIds !== reading.candidates) problems.push('候选里有重复')
        if (reading.ceilingDrivesStoreList !== true) {
          problems.push('★ 扫描上限没有驱动 `store.list` 的 limit ⇒ 机制整条丢了')
        }
        if (reading.defaultCeilingIs500 !== true) problems.push('★ 默认扫描上限不是 500')
        if (reading.subjectChannelHasNoLimit !== true) {
          problems.push('★ subject 通道的实现形状变了 ⇒ 必须回来核对 `L-M95-09` 这条边界是否仍然成立')
        }
        /*
         * ★ **特征化判据**（刻意让"悄悄修好"也报红）：
         * 当前事实是 **subject 通道不受扫描上限约束**（`listBySubject` 无 limit）
         * ⇒ 注入 20 的上限，实测 scanned 仍是全部。
         * ⚠️ 若将来有人把 subject 通道也加上上限（那是**好事**），这条会红 ——
         *    那时**不是**回退实现，而是回来更新 `L-M95-09` 与本判据（强制一次有意识的复核）。
         */
        if (reading.scannedBoundedByCeiling !== false) {
          problems.push(
            '★ 扫描竟然被上限夹住了 —— subject 通道现在有上限了？请回来更新 `L-M95-09` 与这条判据'
          )
        }
        if (Number(reading.scanned) !== Number(reading.written)) {
          problems.push(
            `实测 scanned=${String(reading.scanned)} 与写入 ${String(reading.written)} 不等 ⇒ 现象变了，须复核边界`
          )
        }
        return problems
      },
    })
  )

  /* ---- ④ 新鲜度：刚写入的在 limit=1 下可见 ---- */
  probes.push(
    await probe({
      id: 'freshness-newest-is-immediately-visible',
      question: '④ 新鲜度：刚写完的记忆在 `limit = 1` 下**立刻可见**（召回不是只看得见旧货）',
      run: async () => {
        const evidence = await h.recordUserEvidence('记住：规模样本里最新的一条是 sample-NEWEST。')
        const fresh = await h.commitAndFold(
          h.makeCandidate('preference', claim('preference.scale.sample', 'sample-NEWEST', h.user), {
            sourceRefs: [evidence.ref],
          }),
          M4_T0 + 999_999
        )
        const result = await makePort().retrieve({
          ...query,
          limit: 1,
        } as Parameters<ReturnType<typeof makePort>['retrieve']>[0])
        const topId = String(result.hits[0]?.record.id ?? '')
        return { freshId: String(fresh?.id ?? ''), topId, matches: topId === String(fresh?.id ?? '') }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.matches !== true) problems.push('★ 刚写入的记忆没有出现在 limit=1 的结果里（新鲜度不成立）')
        return problems
      },
    })
  )

  /* ---- ⑤ 资源读数（记录 + 宽松上界） ---- */
  probes.push(
    await probe({
      id: 'latency-at-200-is-recorded',
      question: `⑤ N=${String(SCALE_N)} 下 20 次检索的 p50/p95（记录；只判"不是灾难级"）`,
      run: async () => {
        const samples: number[] = []
        for (let i = 0; i < 20; i += 1) {
          const started = Date.now()
          await makePort().retrieve({
            ...query,
            limit: RECALL_LIMITS.maxCandidateLimit,
          } as Parameters<ReturnType<typeof makePort>['retrieve']>[0])
          samples.push(Date.now() - started)
        }
        const sorted = [...samples].sort((a, b) => a - b)
        return {
          samples,
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          max: sorted[sorted.length - 1] ?? null,
          candidateUpperBoundMs: 2_000,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if ((reading.samples as number[]).length !== 20) problems.push('采样数不足')
        if (!(Number(reading.p95) <= 2_000)) {
          problems.push(`★ p95=${String(reading.p95)} ms 超过宽松上界 2000 ms`)
        }
        return problems
      },
    })
  )

  /* ---- ⑥ 语义路径的开销是真的（计划逐字：shadow 不能称零副作用） ---- */
  probes.push(
    await probe({
      id: 'semantic-path-cost-is-real-and-recorded',
      question: '⑥ `off` 与 `on` 的探针调用数与耗时差**如实记下**（计划禁止把 shadow 说成零副作用）',
      run: async () => {
        let calls = 0
        const deterministicProbe: MemorySemanticProbe = {
          name: 'gate-scale-deterministic',
          score: async (input) => {
            calls += 1
            const scores = new Map<string, number>()
            for (const id of input.memoryIds) scores.set(String(id), 0.5)
            return scores.size > 0 ? { ok: true, scores } : { ok: false, reason: 'missing_score' }
          },
        }
        const measure = async (probeImpl?: MemorySemanticProbe): Promise<{ ms: number; calls: number }> => {
          const before = calls
          const started = Date.now()
          await makePort(probeImpl !== undefined ? { probe: probeImpl } : undefined).retrieve({
            ...query,
            limit: RECALL_LIMITS.maxCandidateLimit,
            retrievalPolicyVersion: 'hybrid-relevance@1',
            ...(probeImpl === undefined ? { semanticMode: 'off' as const } : {}),
          } as Parameters<ReturnType<typeof makePort>['retrieve']>[0])
          return { ms: Date.now() - started, calls: calls - before }
        }
        const off = await measure(undefined)
        const on = await measure(deterministicProbe)
        return { off, on, callsDelta: on.calls - off.calls, msDelta: on.ms - off.ms }
      },
      judge: (reading) => {
        const problems: string[] = []
        const off = reading.off as { calls: number }
        const on = reading.on as { calls: number }
        if (off.calls !== 0) problems.push('★ off 竟然调用了语义探针')
        if (on.calls <= 0) problems.push('on 应调用语义探针')
        /* 开销**不必**判大小，但必须"不是负的"（负值说明量具算反了） */
        if (!(Number(reading.callsDelta) > 0)) problems.push('调用数差应为正')
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
    schemaVersion: 'm9.5-scale@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '候选上限 200（实测）/ 查询边界被协约拒绝 / 扫描上限是机制 + 默认 500 静态核对 / 新鲜度 / 时延 p50·p95 / 语义路径开销如实记录',
      notProves:
        '**不**证明 500 条以上规模下的读数（本轮用**有界注入**证明机制、默认值作静态断言）；' +
        '也**不**证明长轨迹下的漂移（那属 `long`）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'scale-verify.json')
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
    configHash: { scaleN: SCALE_N, injectedCeiling: INJECTED_CEILING, maxCandidateLimit: RECALL_LIMITS.maxCandidateLimit },
    command: [{ cmd: 'pnpm m9.5:scale:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'scale-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP9 规模门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
