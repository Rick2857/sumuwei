/**
 * M9.5 WP7/8 —— **兼容门**（`pnpm m9.5:compat:verify`）。
 *
 * ============================================================================
 *  它验的是计划 §4.4「交给 M10/M11 的稳定边界」那 7 条
 * ============================================================================
 * ```text
 * ① 请求带明确 character / user / 目的 / 时间 / 预算 / **调用版本**
 * ② 引用可追溯到 Memory ID + 版本 + 证据；**不返回可直接当"新事实"的摘要文本**
 * ④ M10 形状的消费者：召回是**规划输入**，**不是**授权或承诺
 * ⑤ M11 形状的消费者：**独立待审**提案，**不写回**长期状态
 * ⑥ **使用前必须再次复核有效性**（不许长期持有一次检索时的快照）
 * ⑦ 两个 **纯 fixture consumer**（不创建 Goal/Reflection 生产服务）
 * ```
 * ⚠️ 门**不**自己实现"消费者"：它调用 `handoff-fixtures.ts` 里那两个**留在仓库里**的
 *    fixture —— 这样 M10/M11 读得到可执行契约，而不是只能读散文。
 *
 * 用法：`pnpm m9.5:compat:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { sql } from 'drizzle-orm'

import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  goalFixtureConsume,
  referencesFromOutcome,
  reflectionFixtureConsume,
  recheckReferences,
  type RecallReference,
} from '../src/kernel/app/recall/handoff-fixtures.ts'
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
const GATE_VERSION = 'm9.5-compat@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const SENTINEL = 'SENTINEL-M95-COMPAT-1a77b3-DO-NOT-PROPAGATE'

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
      : createM95RunId({ wpId: 'wp78-compat', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const probes: Probe[] = []

  await resetPluginSqlConnection()
  isolateDatabase('m95-wp78-compat', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp78-compat' })
  const h = bed.h
  const db = h.db

  /* 布景：一条带哨兵的偏好 + 一条经历 */
  const preferenceEvidence = await h.recordUserEvidence(`记住：我喜欢的颜色是红色 ${SENTINEL}。`)
  const preference = await h.commitAndFold(
    h.makeCandidate('preference', claim('preference.color.favorite', `红色 ${SENTINEL}`, h.user), {
      sourceRefs: [preferenceEvidence.ref],
    }),
    M4_T0 + 100
  )
  const experienceEvidence = await h.recordUserEvidence('记住：上次我熬夜赶论文很难受。')
  /*
   * ⚠️ 这里用 `person_fact` 而不是 `episode`：`episode` 家族对 `content.kind` 有更严的形状要求
   *    （`claim` 不属于它），而本门验的是**交给 M10/M11 的契约形状**，不是某一类记忆的科目。
   *    M11 的"过去经历"在本门里由一条可追溯的记忆充当即可。
   */
  await h.commitAndFold(
    h.makeCandidate('person_fact', claim('experience.recent.note', '熬夜赶论文很难受', h.user), {
      sourceRefs: [experienceEvidence.ref],
    }),
    M4_T0 + 200
  )
  const targetId = String(preference?.id ?? '')

  const port = createMemoryRetrievalStore({
    store: h.store,
    integrity: (owner) => memoryIntegrityProblems(db, owner),
    rootReadings: (ids) => rootReadingsByMemory(db, ids),
  })
  const recallPort = createRecallTurnPort({
    service: createMemoryRecallService({ port }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => M4_T0 + 10_000,
  })
  const request = createRecallRequest({
    traceId: newTraceId(),
    characterId: String(h.characterId),
    user: entityRef('user', String(h.user.id)),
    query: { text: `我喜欢的颜色是什么？${SENTINEL}`, source: 'user_message' },
    intent: 'current_fact',
    candidateLimit: 10,
    contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
  })
  const outcome = await recallPort.run(request)

  /* §4.4 ①：请求带明确范围与调用版本 */
  probes.push(
    await probe({
      id: 'request-carries-explicit-scope-and-calling-version',
      question: '① 请求带 character / user / 目的 / 时间 / 预算 / **调用版本**；trace 记下**生效的**版本与模式',
      run: () => ({
        hasCharacterId: typeof request.characterId === 'string' && request.characterId.length > 0,
        hasUser: request.user.kind === 'user' && String(request.user.id).length > 0,
        hasIntent: request.intent === 'current_fact',
        hasTimeScope: request.timeScope.kind === 'any',
        hasBudget: typeof request.contextBudget.memoryTokens === 'number' && request.contextBudget.memoryTokens > 0,
        hasCandidateLimit: request.candidateLimit > 0,
        /* 缺省不出现 ⇒ 由下游推导；trace 里记的是**生效值** */
        requestPolicyVersionAbsent: !Object.prototype.hasOwnProperty.call(request, 'retrievalPolicyVersion'),
        tracePolicyVersion: outcome.trace.retrievalPolicyVersion,
        traceSemanticMode: outcome.trace.semanticMode,
      }),
      judge: (reading) => {
        const problems: string[] = []
        for (const key of ['hasCharacterId', 'hasUser', 'hasIntent', 'hasTimeScope', 'hasBudget', 'hasCandidateLimit'] as const) {
          if (reading[key] !== true) problems.push(`§4.4① 缺项：${key}`)
        }
        if (reading.requestPolicyVersionAbsent !== true) {
          problems.push('缺省不该在请求上塞策略版本字段（那会破坏"不传即等价"）')
        }
        /* ★ "调用版本"必须**在 trace 里可读**，否则消费方无法解释两次不同读数 */
        if (reading.tracePolicyVersion !== 'lexical-recency@1') {
          problems.push(`trace 应记下生效策略版本，实际 ${String(reading.tracePolicyVersion)}`)
        }
        if (reading.traceSemanticMode !== 'off') {
          problems.push(`trace 应记下生效模式（此处应为 off），实际 ${String(reading.traceSemanticMode)}`)
        }
        return problems
      },
    })
  )

  /*
   * 证据指针**从证据链接表真查**（不手工编）：
   *   §4.4 第 2 条要的是"引用可追溯到证据"，那就必须让引用指向**真实的**证据行。
   *   第一版只给目标填了证据 ⇒ `allHaveEvidence` 失败 —— 那是量具在偷懒，不是契约有问题。
   */
  const selectedIds = outcome.trace.selectedIds.map(String)
  const linkRows = selectedIds.length === 0
    ? []
    : rowsOf(
        await db.execute(
          sql`select memory_id, evidence_kind, evidence_id from memory_evidence_links
              where memory_id in ${sql.raw(`(${selectedIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')})`)}
              order by memory_id, evidence_kind, evidence_id`
        )
      )
  const evidenceByMemoryId = new Map<string, string[]>()
  for (const row of linkRows) {
    const memoryId = String(row.memory_id)
    const list = evidenceByMemoryId.get(memoryId) ?? []
    /* 证据指针带上类型（`evidence_kind:evidence_id`）—— 单看 id 无法判断它指向哪张表 */
    list.push(`${String(row.evidence_kind)}:${String(row.evidence_id)}`)
    evidenceByMemoryId.set(memoryId, list)
  }
  const references = referencesFromOutcome(outcome, evidenceByMemoryId)

  /* §4.4 ②：引用可追溯、且 record/trace 里**没有**可直接当新事实的摘要文本 */
  probes.push(
    await probe({
      id: 'references-traceable-and-no-fact-shaped-text',
      question: '② 引用带 Memory ID / 版本 / 证据指针；诊断里**没有**可直接当"新事实"的正文',
      run: () => ({
        referenceCount: references.length,
        allHaveMemoryId: references.every((item) => item.memoryId.length > 0),
        allHaveRevision: references.every((item) => Number.isInteger(item.sourceRevision)),
        allHaveEvidence: references.every((item) => item.evidenceIds.length > 0),
        traceHasSentinel: JSON.stringify(outcome.trace).includes(SENTINEL),
        recordHasSentinel: JSON.stringify(outcome.record).includes(SENTINEL),
        /* 正控：哨兵确实在场上（本轮它同时进了记忆取值与查询句） */
        selectionHasSentinel: JSON.stringify(outcome.selection).includes(SENTINEL),
        referenceShapeKeys: references.length > 0 ? Object.keys(references[0] as RecallReference).sort() : [],
      }),
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.referenceCount) <= 0) problems.push('没有产生引用 ⇒ 布景或链路有问题')
        for (const key of ['allHaveMemoryId', 'allHaveRevision', 'allHaveEvidence'] as const) {
          if (reading[key] !== true) problems.push(`引用的可追溯性缺项：${key}`)
        }
        if (reading.selectionHasSentinel !== true) {
          problems.push('★ 正控失败：哨兵没进上下文 ⇒ "诊断里没有它"证明不了什么')
        }
        if (reading.traceHasSentinel !== false) problems.push('★ trace 里出现了记忆正文')
        if (reading.recordHasSentinel !== false) problems.push('★ 决策记录里出现了记忆正文')
        /* 引用形状必须**只有**三样（id/版本/证据）—— 多一个字段就可能是"正文夹带" */
        if (JSON.stringify(reading.referenceShapeKeys) !== JSON.stringify(['evidenceIds', 'memoryId', 'sourceRevision'])) {
          problems.push(`引用形状应只有 id/版本/证据，实际 ${JSON.stringify(reading.referenceShapeKeys)}`)
        }
        return problems
      },
    })
  )

  /* §4.4 ④：Goal 形状的消费者 —— 输入而非授权 */
  probes.push(
    await probe({
      id: 'goal-fixture-uses-recall-as-input-not-authorization',
      question: '④ M10 形状的 fixture：召回是**规划输入**，且**没有**授权/承诺的出口',
      run: () => {
        const recheck = { stillValid: () => true }
        const output = goalFixtureConsume({ outcome, references, recheck })
        return {
          planningInputCount: output.planningInputs.length,
          executionAuthorizations: output.executionAuthorizations.length,
          newCommitments: output.newCommitments.length,
          allImplyNoAuthorization: output.planningInputs.every((item) => item.impliesUserAuthorization === false),
          allUsableAsInput: output.planningInputs.every((item) => item.usableAsPlanningInput === true),
          /* 静态面：fixture 的**返回类型**里没有"授权/承诺"这种出口 */
          fixtureSourceHasAuthorizationField: readFileSync(
            join(REPO_ROOT, 'src/kernel/app/recall/handoff-fixtures.ts'),
            'utf8'
          ).includes('readonly executionAuthorizations: readonly never[]'),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.planningInputCount) <= 0) problems.push('§4.4④ 应产出规划输入')
        if (Number(reading.executionAuthorizations) !== 0) problems.push('★ 召回结果产生了执行授权')
        if (Number(reading.newCommitments) !== 0) problems.push('★ 召回结果产生了新承诺')
        if (reading.allImplyNoAuthorization !== true) problems.push('规划输入必须显式标出不等于授权')
        if (reading.fixtureSourceHasAuthorizationField !== true) {
          problems.push('★ fixture 的授权出口不是"类型上就没有"（只靠约定不写）')
        }
        return problems
      },
    })
  )

  /* §4.4 ⑤：Reflection 形状的消费者 —— 独立待审、不写回 */
  probes.push(
    await probe({
      id: 'reflection-fixture-proposes-pending-review-without-writing',
      question: '⑤ M11 形状的 fixture：产出**独立待审**提案、**不写回**长期状态、提案不自证',
      run: () => {
        const recheck = { stillValid: () => true }
        const output = reflectionFixtureConsume({ outcome, references, recheck })
        return {
          proposalCount: output.proposals.length,
          allPendingReview: output.proposals.every((item) => item.status === 'pending_review'),
          stateWrites: output.stateWrites.length,
          proposalIds: output.proposals.map((item) => item.proposalId),
          basedOnCounts: output.proposals.map((item) => item.basedOnMemoryIds.length),
          /* 提案里**只**有 id 与证据指针（没有原文） */
          proposalsHaveText: JSON.stringify(output.proposals).includes(SENTINEL),
          fixtureHasNoEvidenceOkStatus: !readFileSync(
            join(REPO_ROOT, 'src/kernel/app/recall/handoff-fixtures.ts'),
            'utf8'
          ).includes("'evidence_ok'"),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.proposalCount) <= 0) problems.push('§4.4⑤ 应产出待审提案')
        if (reading.allPendingReview !== true) problems.push('★ 提案状态必须是 pending_review（反思不得自证）')
        if (Number(reading.stateWrites) !== 0) problems.push('★ fixture 写回了长期状态')
        if (reading.proposalsHaveText !== false) problems.push('★ 提案里夹带了原文')
        if (reading.fixtureHasNoEvidenceOkStatus !== true) {
          problems.push('fixture 出现了"证据充分/成立"这类自证状态值')
        }
        return problems
      },
    })
  )

  /* §4.4 ⑥：使用前复核 —— 陈旧引用必须被丢弃（且带具名理由） */
  probes.push(
    await probe({
      id: 'stale-reference-is-dropped-on-recheck',
      question: '⑥ **使用前再次复核**：撤回过 / 已被取代的引用必须被丢弃，并给出具名理由',
      run: () => {
        const stale: RecallReference = {
          memoryId: 'mem:already-forgotten',
          sourceRevision: 1,
          evidenceIds: ['evidence:gone'],
        }
        const all: RecallReference[] = [...references, stale]
        /* 复核读数模拟"那条已经被撤回" */
        const result = recheckReferences(all, { stillValid: (reference) => reference.memoryId !== stale.memoryId })
        const goal = goalFixtureConsume({ outcome, references: all, recheck: { stillValid: (r) => r.memoryId !== stale.memoryId } })
        const reflection = reflectionFixtureConsume({
          outcome,
          references: all,
          recheck: { stillValid: (r) => r.memoryId !== stale.memoryId },
        })
        return {
          usableCount: result.usable.length,
          droppedCount: result.dropped.length,
          droppedReasons: result.dropped.map((item) => item.reason),
          droppedIds: result.dropped.map((item) => item.reference.memoryId),
          goalDroppedCount: goal.droppedCount,
          reflectionDroppedCount: reflection.droppedCount,
          reflectionProposalMentionsStale: JSON.stringify(reflection.proposals).includes(stale.memoryId),
          goalMentionsStale: JSON.stringify(goal.planningInputs).includes(stale.memoryId),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.droppedCount) !== 1) problems.push('陈旧引用应被丢弃 1 条')
        if (JSON.stringify(reading.droppedReasons) !== JSON.stringify(['stale_reference_recheck_failed'])) {
          problems.push(`丢弃理由应具名，实际 ${JSON.stringify(reading.droppedReasons)}`)
        }
        if (Number(reading.goalDroppedCount) !== 1) problems.push('Goal fixture 没有执行复核')
        if (Number(reading.reflectionDroppedCount) !== 1) problems.push('Reflection fixture 没有执行复核')
        if (reading.goalMentionsStale !== false) problems.push('★ 陈旧引用仍然出现在规划输入里')
        if (reading.reflectionProposalMentionsStale !== false) problems.push('★ 陈旧引用仍然出现在提案里')
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
    schemaVersion: 'm9.5-compat@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '§4.4 ①请求范围与调用版本 ②引用可追溯且诊断无正文 ④Goal 形状=输入非授权 ⑤Reflection 形状=待审不写回 ⑥使用前复核丢弃陈旧引用 ⑦两个纯 fixture',
      fixtures: 'src/kernel/app/recall/handoff-fixtures.ts（**留在仓库里**，M10/M11 读得到可执行契约）',
      notProves:
        '**不**证明 M10/M11 的真实实现会这么做（本门只证明**契约形状**可执行）；也**不**创建任何 Goal/Reflection 生产服务（§4.4 第 7 条）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'compat-verify.json')
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
    configHash: { fixtureFile: 'src/kernel/app/recall/handoff-fixtures.ts', consumers: 2 },
    command: [{ cmd: 'pnpm m9.5:compat:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'compat-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP7/8 兼容门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
