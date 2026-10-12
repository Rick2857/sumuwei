/**
 * M9.5 WP8 —— **模式门**（`pnpm m9.5:modes:verify`）。
 *
 * ============================================================================
 *  计划 §12 WP8 的权威要求（逐字）
 * ============================================================================
 * ```text
 * 「shadow 比较新旧检索但**实际回复只使用旧路径**；语义路径的结果**不能影响**
 *   记忆写入、信念形成或上下文。shadow 会使用额外计算、可能维护派生索引，
 *   **不能称"完全零副作用"**。」
 * 「出口：模式门与隐私门 PASS；**关闭时没有语义查询/推理调用**，且原链可独立工作。」
 * S46：off 与原版本同输入/同夹具 ⇒ 候选/资格/选中语义等价；**语义调用数 0**
 * S47：shadow 模式 ⇒ 有对照读数，实际 **prompt/回复输入不变**
 * ```
 *
 * 本门用一个**布景**同时展示三档（最旧但词面命中的目标 + 3 条更新的无关记忆，limit=3）：
 * ```text
 *   off    ⇒ 目标被截断丢掉；探针**0 次调用**
 *   shadow ⇒ 选中集合与 off **逐位相同**（S47），但多出"如果开启会怎样"的对照读数
 *   on     ⇒ 目标被保住（语义分数真的参与了排序）
 * ```
 * 用法：`pnpm m9.5:modes:verify`
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
import {
  SEMANTIC_MODES,
  createRecallRequest,
  defaultSemanticModeFor,
  isSemanticMode,
  type SemanticMode,
} from '../src/kernel/contracts/recall.ts'
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
const GATE_VERSION = 'm9.5-modes@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const LIMIT = 3

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

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp8-modes', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const probes: Probe[] = []

  /* ---- 纯函数部分：模式取值与缺省推导 ---- */
  probes.push(
    await probe({
      id: 'mode-value-set-and-default-derivation',
      question: '三种模式取值合法；缺省由策略版本推导（不传 = 旧行为）',
      run: () => ({
        modes: [...SEMANTIC_MODES],
        accepts: Object.fromEntries(SEMANTIC_MODES.map((mode) => [mode, isSemanticMode(mode)])),
        rejects: {
          maybe: isSemanticMode('maybe'),
          empty: isSemanticMode(''),
          TRUE: isSemanticMode('TRUE'),
        },
        defaults: {
          legacy: defaultSemanticModeFor('lexical-recency@1'),
          hybrid: defaultSemanticModeFor('hybrid-relevance@1'),
        },
      }),
      judge: (reading) => {
        const problems: string[] = []
        const accepts = reading.accepts as Record<string, boolean>
        for (const mode of reading.modes as string[]) {
          if (accepts[mode] !== true) problems.push(`${mode} 应被接受`)
        }
        const rejects = reading.rejects as Record<string, boolean>
        for (const key of ['maybe', 'empty', 'TRUE']) {
          if (rejects[key] !== false) problems.push(`${key} 应被拒绝（不得默认 on）`)
        }
        const defaults = reading.defaults as Record<string, string>
        if (defaults.legacy !== 'off') problems.push(`legacy 策略的缺省模式应为 off，实际 ${String(defaults.legacy)}`)
        if (defaults.hybrid !== 'on') problems.push(`hybrid 策略的缺省模式应为 on，实际 ${String(defaults.hybrid)}`)
        return problems
      },
    })
  )

  probes.push(
    await probe({
      id: 'unknown-mode-rejected-by-contract',
      question: '未知模式被 `createRecallRequest` 拒绝（不默认 on、也不静默回落 off）',
      expectation: 'fail',
      run: () => {
        const request = createRecallRequest({
          traceId: 'trace-x',
          characterId: 'char-x',
          user: entityRef('user', 'u1'),
          query: { text: '你好' },
          semanticMode: 'maybe' as never,
        })
        return { accepted: request.semanticMode }
      },
    })
  )

  /* ---- 真库布景 ---- */
  await resetPluginSqlConnection()
  isolateDatabase('m95-wp8-modes', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp8-modes' })
  const h = bed.h
  const db = h.db

  /* 目标：**最旧**，但词面命中（含「颜色」）—— 与 WP0 的层④缺口同形 */
  const targetEvidence = await h.recordUserEvidence('记住：我喜欢的颜色是红色。')
  const target = await h.commitAndFold(
    h.makeCandidate('preference', claim('preference.color.favorite', '红色', h.user), {
      sourceRefs: [targetEvidence.ref],
    }),
    M4_T0 + 10
  )
  const targetId = String(target?.id ?? '')
  /* 3 条**更新**的无关记忆（词面不命中） */
  const FILLERS = ['钢琴', '爬山', '围棋']
  for (let i = 0; i < FILLERS.length; i += 1) {
    const evidence = await h.recordUserEvidence(`记住：我最近在练${FILLERS[i] as string}。`)
    await h.commitAndFold(
      h.makeCandidate('preference', claim('preference.hobby.recent', FILLERS[i] as string, h.user), {
        sourceRefs: [evidence.ref],
      }),
      M4_T0 + 1_000 + i
    )
  }

  let probeCalls = 0
  /** 目标给高分、其余给低分（确定性；真实编码器由别的门守） */
  const deterministicProbe: MemorySemanticProbe = {
    name: 'gate-modes-deterministic',
    score: async (input) => {
      probeCalls += 1
      const scores = new Map<string, number>()
      for (const id of input.memoryIds) {
        const key = String(id)
        scores.set(key, key === targetId ? 0.95 : 0.2)
      }
      return scores.size > 0 ? { ok: true, scores } : { ok: false, reason: 'missing_score' }
    },
  }

  interface Observation {
    readonly probeCalls: number
    readonly candidateIds: readonly string[]
    readonly semanticScoredIds: readonly string[]
    readonly shadow: { legacyOrderIds: readonly string[]; hybridOrderIds: readonly string[]; topChanged: boolean } | null
  }

  const observe = async (
    mode: SemanticMode | undefined,
    probeImpl: MemorySemanticProbe | undefined
  ): Promise<Observation> => {
    const port = createMemoryRetrievalStore({
      store: h.store,
      integrity: (owner) => memoryIntegrityProblems(db, owner),
      rootReadings: (ids) => rootReadingsByMemory(db, ids),
      ...(probeImpl !== undefined ? { semanticProbe: probeImpl } : {}),
    })
    const before = probeCalls
    const result = await port.retrieve({
      traceId: newTraceId(),
      characterId: h.characterId,
      user: entityRef('user', String(h.user.id)),
      text: '我喜欢的颜色是什么？',
      timeScope: { kind: 'any' },
      limit: LIMIT,
      retrievalPolicyVersion: 'hybrid-relevance@1',
      ...(mode !== undefined ? { semanticMode: mode } : {}),
    } as Parameters<typeof port.retrieve>[0])
    return {
      probeCalls: probeCalls - before,
      candidateIds: result.hits.map((hit) => String(hit.record.id)),
      semanticScoredIds: result.semanticScoredIds,
      shadow: result.shadow ?? null,
    }
  }

  /* ---- ① off：零语义调用 ---- */
  const offRun = await observe('off', deterministicProbe)
  probes.push(
    await probe({
      id: 'off-makes-zero-semantic-calls',
      question: 'S46：`off` ⇒ 探针**0 次调用**、无分数、无对照读数；目标被旧路径丢掉',
      run: () => ({ ...offRun, includesTarget: offRun.candidateIds.includes(targetId) }),
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.probeCalls) !== 0) problems.push(`★ off 竟然调用了探针 ${String(reading.probeCalls)} 次`)
        if ((reading.semanticScoredIds as string[]).length !== 0) problems.push('off 却有语义分数')
        if (reading.shadow !== null) problems.push('off 不应有 shadow 对照读数')
        if (reading.includesTarget !== false) {
          problems.push('★ 布景失效：off 下目标竟然在候选里（无法展示"旧路径丢掉它"）')
        }
        return problems
      },
    })
  )

  /* ---- ② shadow：算，但输出与 off **逐位相同** ---- */
  const shadowRun = await observe('shadow', deterministicProbe)
  probes.push(
    await probe({
      id: 'shadow-computes-but-output-identical-to-off',
      question: '★ S47：`shadow` 真的算分并给出对照读数，而**选中集合与 off 逐位相同**（prompt 输入不变）',
      run: () => ({
        ...shadowRun,
        offCandidateIds: offRun.candidateIds,
        identicalToOff: JSON.stringify(shadowRun.candidateIds) === JSON.stringify(offRun.candidateIds),
        orderChangedInShadowComparison: shadowRun.shadow?.topChanged ?? null,
      }),
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.probeCalls) <= 0) problems.push('★ shadow 没有调用探针 ⇒ 没有对照读数可言')
        if ((reading.semanticScoredIds as string[]).length <= 0) problems.push('shadow 应记下真的算过分数的候选')
        if (reading.shadow === null) problems.push('★ shadow 没有对照读数（计划的"比较新旧检索"没做到）')
        if (reading.identicalToOff !== true) {
          problems.push(
            `★ shadow 的输出与 off 不同 ⇒ 语义影响了上下文（计划逐字禁止）。` +
              `shadow=${JSON.stringify(reading.candidateIds)} off=${JSON.stringify(reading.offCandidateIds)}`
          )
        }
        /* 对照读数必须**真的**指出差别（否则它是空的） */
        if (reading.orderChangedInShadowComparison !== true) {
          problems.push('★ 对照读数说"顺序没变" —— 但布景里语义本应改变顺序 ⇒ 对照是空的')
        }
        return problems
      },
    })
  )

  /* ---- ③ on：分数真的参与排序 ---- */
  probes.push(
    await probe({
      id: 'on-lets-scores-change-the-order',
      question: '`on` ⇒ 语义分数参与排序：最旧但词面+语义命中的目标被保住（off 下它被丢掉）',
      run: async () => {
        const onRun = await observe('on', deterministicProbe)
        return {
          onCandidateIds: onRun.candidateIds,
          includesTarget: onRun.candidateIds.includes(targetId),
          rankOfTarget: onRun.candidateIds.indexOf(targetId),
          differsFromOff: JSON.stringify(onRun.candidateIds) !== JSON.stringify(offRun.candidateIds),
          offCandidateIds: offRun.candidateIds,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.includesTarget !== true) problems.push('★ on 没能把目标保住 ⇒ 语义分数没有影响排序')
        if (reading.rankOfTarget !== 0) problems.push(`目标应排首位，实际第 ${String(reading.rankOfTarget)} 位`)
        if (reading.differsFromOff !== true) problems.push('on 与 off 输出相同 ⇒ 分数没起作用')
        return problems
      },
    })
  )

  /* ---- ④ shadow 的诚实降级：探针失败 ⇒ 不编对照读数 ---- */
  probes.push(
    await probe({
      id: 'shadow-degrades-without-inventing-comparison',
      question: 'shadow + 探针失败 ⇒ 如实降级：无对照读数（不编）、输出仍与 off 相同、原链照常工作',
      run: async () => {
        const failing: MemorySemanticProbe = {
          name: 'gate-modes-failing',
          score: async () => ({ ok: false, reason: 'timeout' }),
        }
        const run = await observe('shadow', failing)
        return {
          ...run,
          identicalToOff: JSON.stringify(run.candidateIds) === JSON.stringify(offRun.candidateIds),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.shadow !== null) problems.push('★ 探针失败却给出了对照读数 ⇒ 编读数')
        if ((reading.semanticScoredIds as string[]).length !== 0) problems.push('探针失败却有语义分数')
        if (reading.identicalToOff !== true) problems.push('探针失败时输出应与 off 相同')
        if ((reading.candidateIds as string[]).length <= 0) problems.push('★ 探针失败后原链没能独立工作')
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
    schemaVersion: 'm9.5-modes@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        'S46（off 零语义调用、输出语义等价）/ S47（shadow 有对照读数但输出与 off 逐位相同）/ on 真的改变顺序 / 探针失败时如实降级且原链独立工作 / 未知模式被拒',
      notProves:
        '**不**证明 shadow 的"零成本"（计划逐字：shadow 有额外计算与派生索引开销，**不能**称零副作用）；' +
        '也**不**证明隐私边界（那是 `m9.5:privacy:verify` 的职责）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'modes-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp8',
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
    configHash: { modes: [...SEMANTIC_MODES], candidateLimit: LIMIT },
    command: [{ cmd: 'pnpm m9.5:modes:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'modes-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP8 模式门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
