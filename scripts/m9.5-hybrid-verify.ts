/**
 * M9.5 WP6（N1 接线）—— **真实检索店的策略版本门**（`pnpm m9.5:hybrid:verify`）。
 *
 * ============================================================================
 *  它把 WP0 的层④缺口**端到端**地钉住（真库、真店、零模型）
 * ============================================================================
 * ```text
 * WP0 的 `S4` 在**纯端口层**量到：N=50 时目标（恰是 lexical 命中）**不进候选池**。
 * 本门在**接线之后**重跑同一形状，并且两侧都要有读数：
 *   legacy（`lexical-recency@1`，缺省）：目标**仍被丢掉** —— 证明缺口真实存在、且缺省行为未变
 *   hybrid（`hybrid-relevance@1`）      ：目标**进入候选池且排首位** —— 证明 D25 的修法生效
 * 另有三条守卫：
 *   ① **off 等价**：legacy 的候选序列与"手算的新近度降序 + id 升序"**逐位相同**
 *   ② **能力报告没变**：`semantic` 仍在 `unavailable` 里 —— 不许因为接线就假装通道活了（D26-④/R3）
 *   ③ **未知策略版本被拒**（不静默回落、不默认 on）
 * ```
 * 用法：`pnpm m9.5:hybrid:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import {
  type RetrievalPolicyVersion,
  createRecallRequest,
} from '../src/kernel/contracts/recall.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'

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
const GATE_VERSION = 'm9.5-hybrid@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')

const FILLERS = 50
const TARGET_VALUE = '毕业论文'

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
  readonly run: () => Promise<Record<string, unknown>>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Promise<Probe> {
  const expectation = input.expectation ?? 'succeed'
  try {
    const reading = await input.run()
    const problems = input.judge?.(reading) ?? []
    if (expectation === 'fail') {
      return { id: input.id, question: input.question, verdict: 'unexpected', reading, error: '应当失败却成功了' }
    }
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

function claim(predicate: string, value: string, subject: ReturnType<typeof entityRef>, qualifiers?: Record<string, unknown>): never {
  return { kind: 'claim', subject, predicate, value, ...(qualifiers !== undefined ? { qualifiers } : {}) } as never
}

interface Observation {
  readonly candidateIds: readonly string[]
  readonly selectedIds: readonly string[]
  readonly scanned: number
  readonly semanticAvailable: boolean
  readonly semanticUnavailableReason: string | null
}

async function observe(input: {
  readonly bed: M55Harness
  readonly h: M4Harness
  readonly question: string
  readonly policyVersion?: RetrievalPolicyVersion
}): Promise<Observation> {
  const { bed, h } = input
  const service = createMemoryRecallService({
    port: createMemoryRetrievalStore({
      store: h.store,
      integrity: (owner) => memoryIntegrityProblems(h.db, owner),
      rootReadings: (ids) => rootReadingsByMemory(h.db, ids),
    }),
  })
  const recallPort = createRecallTurnPort({
    service,
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => M4_T0 + 10_000,
  })
  const request = createRecallRequest({
    traceId: newTraceId(),
    characterId: String(h.characterId),
    user: entityRef('user', String(h.user.id)),
    query: { text: input.question, source: 'user_message' },
    intent: 'current_fact',
    contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
    ...(input.policyVersion !== undefined ? { retrievalPolicyVersion: input.policyVersion } : {}),
  })
  /*
   * 两处读数：**候选与能力**在 service 层（`retrieveCandidates`），
   * **选中集**在轮次端口（它才走资格+排序+预算）。两者都是只读。
   */
  const candidates = await service.retrieveCandidates(request)
  const outcome = await recallPort.run(request)
  void bed
  const semanticEntry = candidates.capabilities.unavailable.find((item) => item.dimension === 'semantic')
  return {
    candidateIds: candidates.candidates.map((candidate) => String(candidate.memoryId)),
    selectedIds: outcome.trace.selectedIds.map(String),
    scanned: candidates.scanned,
    semanticAvailable: candidates.capabilities.available.includes('semantic'),
    semanticUnavailableReason: semanticEntry?.reason ?? null,
  }
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp6-hybrid', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()

  await resetPluginSqlConnection()
  isolateDatabase('m95-wp6-hybrid', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp6-hybrid' })
  const h = bed.h
  const probes: Probe[] = []

  /* ---- 布景：目标（词面命中）+ 50 条更晚的无关记忆 ---- */
  const targetEvidence = await h.recordUserEvidence(`记住：我在写${TARGET_VALUE}。`)
  const target = await h.commitAndFold(
    h.makeCandidate('person_fact', claim('project.background.active', TARGET_VALUE, h.user), {
      sourceRefs: [targetEvidence.ref],
    }),
    M4_T0 + 100
  )
  const targetId = String(target?.id ?? '')
  for (let i = 0; i < FILLERS; i += 1) {
    const evidence = await h.recordUserEvidence(`填充 ${String(i)}`)
    await h.commitAndFold(
      h.makeCandidate(
        'preference',
        claim('preference.color.favorite', `filler-${String(i)}`, h.user, { filler: String(i) }),
        { sourceRefs: [evidence.ref] }
      ),
      M4_T0 + 1_000 + i
    )
  }
  const allRows = await h.store.list({ owner: h.owner, limit: 500 })
  const question = '我现在在写什么？'

  /* ---- ① legacy（缺省）：缺口端到端复现 ---- */
  const legacyDefault = await observe({ bed, h, question })
  const legacyExplicit = await observe({ bed, h, question, policyVersion: 'lexical-recency@1' })
  probes.push(
    await probe({
      id: 'legacy-drops-oldest-lexical-hit',
      question: `缺省与 legacy 一致：${String(FILLERS)} 条更晚的无关记忆之后，词面命中的目标**不进候选池**`,
      run: async () => ({
        rowCount: allRows.length,
        targetId,
        defaultCandidateCount: legacyDefault.candidateIds.length,
        defaultHasTarget: legacyDefault.candidateIds.includes(targetId),
        explicitLegacyHasTarget: legacyExplicit.candidateIds.includes(targetId),
        defaultEqualsExplicit: JSON.stringify(legacyDefault.candidateIds) === JSON.stringify(legacyExplicit.candidateIds),
        scanned: legacyDefault.scanned,
      }),
      judge: (reading) => {
        const problems: string[] = []
        if (reading.defaultHasTarget !== false) {
          problems.push('★ legacy 本应丢掉最旧的词面命中 ⇒ 缺口没复现（探针失去意义）')
        }
        if (reading.explicitLegacyHasTarget !== false) problems.push('显式 legacy 也应丢掉目标')
        /* 缺省必须与显式 legacy **逐位相同** ⇒ "不传字段行为不变" */
        if (reading.defaultEqualsExplicit !== true) problems.push('★ 缺省与显式 legacy 的候选序列不同 ⇒ 缺省行为变了')
        if (Number(reading.defaultCandidateCount) !== FILLERS) {
          problems.push(`候选数应为 ${String(FILLERS)}，实际 ${String(reading.defaultCandidateCount)}`)
        }
        return problems
      },
    })
  )

  /* ---- ② off 等价：legacy 序列 = 手算的新近度降序 + id 升序 ---- */
  probes.push(
    await probe({
      id: 'legacy-order-equals-hand-computed-recency',
      question: 'off 等价：legacy 的候选序列与"手算新近度降序 + id 升序"**逐位相同**',
      run: async () => {
        const expected = [...allRows]
          .sort((a, b) =>
            b.recordedAt === a.recordedAt
              ? String(a.id) < String(b.id)
                ? -1
                : 1
              : b.recordedAt - a.recordedAt
          )
          .slice(0, FILLERS)
          .map((row) => String(row.id))
        return {
          handComputed: expected,
          actual: legacyExplicit.candidateIds,
          identical: JSON.stringify(expected) === JSON.stringify(legacyExplicit.candidateIds),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.identical !== true) {
          problems.push(
            `★ legacy 顺序与手算不同 ⇒ off 不再等价。手算前 3=${JSON.stringify((reading.handComputed as string[]).slice(0, 3))} ` +
              `实际前 3=${JSON.stringify((reading.actual as string[]).slice(0, 3))}`
          )
        }
        return problems
      },
    })
  )

  /* ---- ③ hybrid：目标进候选池且排首位 ---- */
  probes.push(
    await probe({
      id: 'hybrid-keeps-lexical-hit',
      question: 'D25 生效：hybrid 把词面命中的目标**放进候选池**且排在首位',
      run: async () => {
        const hybrid = await observe({ bed, h, question, policyVersion: 'hybrid-relevance@1' })
        return {
          candidateCount: hybrid.candidateIds.length,
          hasTarget: hybrid.candidateIds.includes(targetId),
          rankOfTarget: hybrid.candidateIds.indexOf(targetId),
          selectedHasTarget: hybrid.selectedIds.includes(targetId),
          scanned: hybrid.scanned,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.hasTarget !== true) problems.push('★ hybrid 仍没把目标放进候选池 ⇒ 修法未生效')
        if (reading.rankOfTarget !== 0) problems.push(`目标应排首位，实际第 ${String(reading.rankOfTarget)} 位`)
        if (Number(reading.candidateCount) !== FILLERS) {
          problems.push(`候选数仍应为 ${String(FILLERS)}（截断仍生效），实际 ${String(reading.candidateCount)}`)
        }
        if (reading.selectedHasTarget !== true) {
          problems.push('目标进了候选池却没被选中（后续资格/排序/预算链路有问题）')
        }
        return problems
      },
    })
  )

  /* ---- ④ 能力报告没变：semantic 仍不可用（不许因为接线就假装通道活了） ---- */
  probes.push(
    await probe({
      id: 'semantic-capability-still-unavailable',
      question: 'D26-④/R3：接线之后 `semantic` **仍**在 unavailable 里（本次没有真实语义分数）',
      run: async () => ({
        legacyAvailable: legacyDefault.semanticAvailable,
        hybridAvailable: (await observe({ bed, h, question, policyVersion: 'hybrid-relevance@1' }))
          .semanticAvailable,
        reasonSample: legacyDefault.semanticUnavailableReason?.slice(0, 60) ?? null,
      }),
      judge: (reading) => {
        const problems: string[] = []
        if (reading.legacyAvailable !== false) problems.push('★ legacy 下 semantic 竟报可用')
        if (reading.hybridAvailable !== false) {
          problems.push('★ hybrid 下 semantic 报可用 —— 但本次**没有得到真实分数** ⇒ 伪启用（D26-④）')
        }
        if (typeof reading.reasonSample !== 'string' || reading.reasonSample.length === 0) {
          problems.push('unavailable 必须写明原因')
        }
        return problems
      },
    })
  )

  /* ---- ⑤ 未知策略版本必须被拒 ---- */
  probes.push(
    await probe({
      id: 'unknown-policy-version-rejected',
      question: '未知策略名**拒绝**（不静默回落、不默认 on）',
      expectation: 'fail',
      run: async () => {
        const request = createRecallRequest({
          traceId: newTraceId(),
          characterId: String(h.characterId),
          user: entityRef('user', String(h.user.id)),
          query: { text: question, source: 'user_message' },
          intent: 'current_fact',
          contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
          retrievalPolicyVersion: 'on' as never,
        })
        return { accepted: request.retrievalPolicyVersion }
      },
    })
  )

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })

  await bed.dispose()
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged = JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter)

  const payload = {
    schemaVersion: 'm9.5-hybrid@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        'WP6 的 N1 接线：legacy 缺口端到端复现 / 缺省与显式 legacy 逐位相同 / off 顺序与手算相同 / hybrid 保住词面命中 / semantic 仍未启用 / 未知策略被拒',
      setup: `目标（词面命中）+ ${String(FILLERS)} 条更晚的无关记忆；隔离库 · 真店 · 零模型`,
      notProves:
        '**不**证明语义通道已产出（它仍是 unavailable）；也**不**证明真实 embedding 的召回质量（那要 WP4 表 + WP3 编码器接线 + WP10 盲测）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'hybrid-store-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp6',
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
    configHash: { fillers: FILLERS, defaultPolicyVersion: 'lexical-recency@1' },
    command: [{ cmd: 'pnpm m9.5:hybrid:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    retrievalPolicyVersion: 'lexical-recency@1',
    artifactHashes: { 'hybrid-store-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP6 接线门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
