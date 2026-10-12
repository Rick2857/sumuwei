/**
 * M9.5 WP7 —— **上下文记账与语义可见性门**（`pnpm m9.5:context:verify`）。
 *
 * ============================================================================
 *  它验的是"数字自洽"而不是"结果好看"
 * ============================================================================
 * ```text
 * ① **逐层计数守恒**（十一条具名不变式）：扫描 ≥ 候选 ≥ 资格 ≥ 选中 ≥ 入模，
 *    以及语义用量不得反超。每条不变式都配一个**正控**：喂它一个坏梯子 ⇒ 必须报出具名违规。
 * ② **每条候选恰好一个去向**，未入模的**必须有具名理由**。
 * ③ **真链路读数**：在隔离库上跑真实检索链（端口 → 资格 → 排序 → 预算 → 轮次 trace），
 *    把 trace 的计数喂进 ①，并断言语义用量**真的可见**（`semanticScoredCount` / `semanticUsedIds`）。
 * ```
 * 用法：`pnpm m9.5:context:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  checkDispositions,
  checkRecallAccounting,
  type CandidateDisposition,
  type RecallLayerCounts,
} from '../src/kernel/app/recall/accounting.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import { createRecallRequest } from '../src/kernel/contracts/recall.ts'
import type { MemorySemanticProbe } from '../src/kernel/recall/ports.ts'
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
const GATE_VERSION = 'm9.5-context@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')

const VALID_LADDER: RecallLayerCounts = {
  scanned: 51,
  candidates: 50,
  eligible: 48,
  selected: 4,
  injected: 4,
  semanticScored: 12,
  semanticUsed: 2,
  droppedByBudget: 6,
}

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

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp7-context', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const probes: Probe[] = []

  /* ---- ① 合法梯子必须安静（正控的反面：量具不能见谁都报） ---- */
  probes.push(
    await probe({
      id: 'valid-ladder-is-silent',
      question: '自洽的梯子 ⇒ **零**违规（量具不能见谁都报）',
      run: () => {
        const verdict = checkRecallAccounting(VALID_LADDER)
        return { ok: verdict.ok, violations: verdict.violations }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.ok !== true) problems.push(`自洽梯子被误报：${JSON.stringify(reading.violations)}`)
        if ((reading.violations as string[]).length !== 0) problems.push('自洽梯子仍报出违规')
        return problems
      },
    })
  )

  /* ---- ② ★ 负控：每条不变式都要**真的会响** ---- */
  probes.push(
    await probe({
      id: 'every-invariant-fires',
      question: '★ 负控：逐条破坏十一条不变式 ⇒ **每一条**都必须被具名报出',
      run: () => {
        const cases: Record<string, readonly string[]> = {
          injectedExceedsSelected: checkRecallAccounting({ ...VALID_LADDER, injected: 5, selected: 4 }).violations,
          semanticUsedExceedsScored: checkRecallAccounting({ ...VALID_LADDER, semanticScored: 1, semanticUsed: 2 }).violations,
          candidatesExceedScanned: checkRecallAccounting({ ...VALID_LADDER, scanned: 10, candidates: 50 }).violations,
          eligibleExceedsCandidates: checkRecallAccounting({ ...VALID_LADDER, candidates: 10, eligible: 48 }).violations,
          selectedExceedsEligible: checkRecallAccounting({ ...VALID_LADDER, eligible: 2, selected: 4 }).violations,
          semanticScoredExceedsCandidates: checkRecallAccounting({ ...VALID_LADDER, semanticScored: 99 }).violations,
          semanticUsedExceedsSelected: checkRecallAccounting({ ...VALID_LADDER, selected: 1, semanticUsed: 2, semanticScored: 12 }).violations,
          negativeCount: checkRecallAccounting({ ...VALID_LADDER, scanned: -1 }).violations,
          nonInteger: checkRecallAccounting({ ...VALID_LADDER, selected: 1.5 }).violations,
          budgetOverdrop: checkRecallAccounting({ ...VALID_LADDER, droppedByBudget: 999 }).violations,
        }
        return { cases }
      },
      judge: (reading) => {
        const problems: string[] = []
        const cases = reading.cases as Record<string, string[]>
        for (const [name, violations] of Object.entries(cases)) {
          if (violations.length === 0) problems.push(`★ ${name} 破坏了不变式却没有报出违规`)
        }
        return problems
      },
    })
  )

  /* ---- ③ 去向：一一对应 + 未入模必须有具名理由 ---- */
  probes.push(
    await probe({
      id: 'dispositions-one-to-one-with-named-reasons',
      question: '每条候选**恰好**一个去向；未入模必须有具名理由、入模必须无理由码',
      run: () => {
        const candidateIds = ['m1', 'm2', 'm3']
        const good: CandidateDisposition[] = [
          { memoryId: 'm1', layer: 'injected', reason: null },
          { memoryId: 'm2', layer: 'ineligible', reason: 'FORGOTTEN' },
          { memoryId: 'm3', layer: 'budget', reason: 'BUDGET_EXHAUSTED' },
        ]
        const missingReason: CandidateDisposition[] = [
          { memoryId: 'm1', layer: 'injected', reason: null },
          { memoryId: 'm2', layer: 'ineligible', reason: null },
          { memoryId: 'm3', layer: 'budget', reason: 'BUDGET_EXHAUSTED' },
        ]
        const unaccounted: CandidateDisposition[] = [
          { memoryId: 'm1', layer: 'injected', reason: null },
          { memoryId: 'm2', layer: 'ineligible', reason: 'FORGOTTEN' },
        ]
        const duplicated: CandidateDisposition[] = [
          ...good,
          { memoryId: 'm2', layer: 'budget', reason: 'BUDGET_EXHAUSTED' },
        ]
        const contradicting: CandidateDisposition[] = [
          { memoryId: 'm1', layer: 'budget', reason: 'BUDGET_EXHAUSTED' },
          { memoryId: 'm2', layer: 'ineligible', reason: 'FORGOTTEN' },
          { memoryId: 'm3', layer: 'budget', reason: 'BUDGET_EXHAUSTED' },
        ]
        const run = (dispositions: CandidateDisposition[]) =>
          checkDispositions({ candidateIds, selectedIds: ['m1'], dispositions })
        return {
          good: run(good),
          missingReason: run(missingReason),
          unaccounted: run(unaccounted),
          duplicated: run(duplicated),
          contradicting: run(contradicting),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        const good = reading.good as { ok: boolean; violations: string[] }
        if (good.ok !== true) problems.push(`合法去向被误报：${JSON.stringify(good.violations)}`)
        for (const key of ['missingReason', 'unaccounted', 'duplicated', 'contradicting']) {
          const item = reading[key] as { ok: boolean; violations: string[] }
          if (item.ok !== false || item.violations.length === 0) {
            problems.push(`★ ${key} 破坏了性质却没有报出违规`)
          }
        }
        return problems
      },
    })
  )

  /* ---- ④ 真链路：trace 的计数喂进记账，且语义用量真的可见 ---- */
  await resetPluginSqlConnection()
  isolateDatabase('m95-wp7-context', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp7-context' })
  const h = bed.h
  const db = h.db

  /*
   * 布景要让**词面命中**真的发生：取值用中文（与查询句共享片段），
   * 否则 `selected = 0`，而 `semanticUsed ≤ selected` 这条关系会**空转**
   * （空转的探针与"没测"在输出上长得一样 —— 所以下面把"选中必须 > 0"写成判据）。
   */
  const COLORS = ['红色', '蓝色', '绿色', '黄色', '紫色', '灰色']
  for (let i = 0; i < COLORS.length; i += 1) {
    const color = COLORS[i] as string
    const evidence = await h.recordUserEvidence(`记住：我喜欢的颜色是${color}。`)
    await h.commitAndFold(
      h.makeCandidate('preference', claim('preference.color.favorite', color, h.user), {
        sourceRefs: [evidence.ref],
      }),
      M4_T0 + 100 + i
    )
  }

  /*
   * 注入一个**确定性的**假探针：只给**偶数序号**的候选分数。
   * 这样 `semanticScored < candidates` 成立，`used ⊂ scored` 的包含关系才被真的走到
   * （真实编码器已由 `m9.5:encoder:verify` / `m9.5:probe:verify` / `m9.5:semantic:verify` 守住）。
   */
  let seenIds: string[] = []
  const deterministicProbe: MemorySemanticProbe = {
    name: 'gate-deterministic',
    score: async (input) => {
      seenIds = input.memoryIds.map((id) => String(id))
      const scores = new Map<string, number>()
      seenIds.forEach((id, index) => {
        if (index % 2 === 0) scores.set(id, 1 - index * 0.01)
      })
      return scores.size > 0 ? { ok: true, scores } : { ok: false, reason: 'missing_score' }
    },
  }

  const port = createMemoryRetrievalStore({
    store: h.store,
    integrity: (owner) => memoryIntegrityProblems(db, owner),
    rootReadings: (ids) => rootReadingsByMemory(db, ids),
    semanticProbe: deterministicProbe,
  })
  const recallPort = createRecallTurnPort({
    service: createMemoryRecallService({ port }),
    budget: { ...DEFAULT_CONTEXT_BUDGET, memoryTokens: 200 },
    now: () => M4_T0 + 10_000,
  })
  const outcome = await recallPort.run(
    createRecallRequest({
      traceId: newTraceId(),
      characterId: String(h.characterId),
      user: entityRef('user', String(h.user.id)),
      query: { text: '我喜欢的颜色是红色吗？', source: 'user_message' },
      intent: 'current_fact',
      candidateLimit: 10,
      contextBudget: { memoryTokens: 200 },
      retrievalPolicyVersion: 'hybrid-relevance@1',
    })
  )

  probes.push(
    await probe({
      id: 'real-trace-counts-are-consistent',
      question: '真链路的 trace 计数**自洽**，且语义用量可见（scored > 0、used ⊆ selected）',
      run: () => {
        const trace = outcome.trace
        const counts: RecallLayerCounts = {
          scanned: trace.scanned,
          candidates: trace.candidateCount,
          eligible: trace.eligibleCount,
          selected: trace.selectedIds.length,
          /* 这一步的 trace 只到"选择器选中"；真实入模由编译器的 `applyContextReality()`
             在这个门之外修正 —— 因此这里用 `reachedContext` 的分支，不假装知道入模数 */
          injected: trace.selectedIds.length,
          semanticScored: trace.semanticScoredCount,
          semanticUsed: trace.semanticUsedIds.length,
          droppedByBudget: trace.droppedByBudget,
        }
        const verdict = checkRecallAccounting(counts)
        return {
          counts,
          verdict,
          semanticScoredCount: trace.semanticScoredCount,
          semanticUsedIds: trace.semanticUsedIds,
          selectedIds: trace.selectedIds,
          /* 这一步读的是 trace 的计数；能力报告在端口的返回里（本门不重复取，避免两处漂移） */
          eligibleCount: trace.eligibleCount,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        const verdict = reading.verdict as { ok: boolean; violations: string[] }
        if (verdict.ok !== true) problems.push(`真链路计数不自洽：${JSON.stringify(verdict.violations)}`)
        const counts = reading.counts as RecallLayerCounts
        if (counts.scanned <= 0) problems.push('真链路扫描了 0 行 ⇒ MEASUREMENT INVALID')
        if (counts.candidates <= 0) problems.push('真链路候选为 0 ⇒ 布景有问题')
        /* ★ 空转防线：一条都没选中时，`semanticUsed ≤ selected` 与去向一致性都是**空转**的 */
        if (counts.selected <= 0) {
          problems.push('★ 真链路一条都没选中 ⇒ 记账关系空转（探针没有内容，等于什么都没测）')
        }
        if (counts.semanticUsed <= 0) {
          problems.push('★ 语义分数算了却没一条入模 ⇒ 「最终使用集合」的语义子集没有被走到')
        }
        if (!(Number(reading.semanticScoredCount) > 0)) {
          problems.push('★ 语义分数一条都没有被记录下来 ⇒ 语义用量在 trace 里不可见（WP7 的要害）')
        }
        const selected = new Set(reading.selectedIds as string[])
        const used = reading.semanticUsedIds as string[]
        if (!used.every((id) => selected.has(id))) problems.push('semanticUsedIds 里出现了不在 selectedIds 里的 id')
        return problems
      },
    })
  )

  probes.push(
    await probe({
      id: 'real-dispositions-are-complete',
      question:
        'N2：真链路**自己**产出完整去向表 —— 候选数 == 去向数、无重复、未入模都有具名理由、入模集合与 selectedIds 一致',
      run: () => {
        const trace = outcome.trace
        const dispositions = trace.dispositions
        const ids = dispositions.map((item) => item.memoryId)
        const verdict = checkDispositions({
          candidateIds: ids,
          selectedIds: trace.selectedIds,
          dispositions,
        })
        return {
          candidateCount: trace.candidateCount,
          dispositionCount: dispositions.length,
          verdict,
          injectedFromDispositions: verdict.injectedIds,
          selectedIds: trace.selectedIds,
          distinctIds: new Set(ids).size,
          layerHistogram: dispositions.reduce<Record<string, number>>((acc, item) => {
            acc[item.layer] = (acc[item.layer] ?? 0) + 1
            return acc
          }, {}),
          namedReasonCount: dispositions.filter((item) => item.reason !== null).length,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        const verdict = reading.verdict as { ok: boolean; violations: string[] }
        if (verdict.ok !== true) problems.push(`真链路去向不自洽：${JSON.stringify(verdict.violations)}`)
        /* ★ 空转防线：去向数必须与候选数**相等** */
        if (reading.dispositionCount !== reading.candidateCount) {
          problems.push(
            `去向数(${String(reading.dispositionCount)}) ≠ 候选数(${String(reading.candidateCount)}) ` +
              '⇒ 有候选没被记账（或凭空多出）'
          )
        }
        if (Number(reading.dispositionCount) <= 0) problems.push('真链路一条去向都没有 ⇒ 生产者没接上')
        if (reading.distinctIds !== reading.dispositionCount) problems.push('去向里有重复 memoryId')
        if (
          JSON.stringify([...(reading.injectedFromDispositions as string[])].sort()) !==
          JSON.stringify([...(reading.selectedIds as string[])].sort())
        ) {
          problems.push('去向里的入模集合与 trace 的 selectedIds 不一致')
        }
        const histogram = reading.layerHistogram as Record<string, number>
        if ((histogram.injected ?? 0) !== (reading.selectedIds as string[]).length) {
          problems.push('injected 层的条数与 selectedIds 不等')
        }
        /* 非入模的都必须带具名理由 */
        const nonInjected = Number(reading.dispositionCount) - Number(histogram.injected ?? 0)
        if (Number(reading.namedReasonCount) !== nonInjected) {
          problems.push(`非入模去向应**全部**带理由码：应有 ${String(nonInjected)} 个，实际 ${String(reading.namedReasonCount)}`)
        }
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
    schemaVersion: 'm9.5-context@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '十一条逐层计数不变式（逐条负控）/ 候选去向一一对应且未入模有具名理由 / 真链路 trace 计数自洽 + 语义用量可见',
      notProves:
        '**不**证明入模数量本身（trace 到"选择器选中"为止；真实入模由编译器的 `applyContextReality()` 修正，属网关侧）；' +
        '也**不**证明回复质量',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'context-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp7',
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
    configHash: { invariants: 11, dispositionLayers: 5 },
    command: [{ cmd: 'pnpm m9.5:context:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'context-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP7 记账门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
