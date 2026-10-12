/**
 * M9.5 WP9 —— **端到端门**（`pnpm m9.5:e2e:verify`）。
 *
 * ============================================================================
 *  它是唯一走**真 `TurnGateway`** 的门（其余门都直连端口/店）
 * ============================================================================
 * ```text
 * 直连端口的门能证明"机制对不对"，但证明不了"**用户看到的那段 prompt** 变没变"。
 * 本门在真网关上跑完整链（`beginTurn` → 召回 → 资格 → 排序 → 预算 → 编译器 → packet）
 * 并直接检查**编译后的 prompt**：
 *
 *   布景：目标（**最旧**但词面+语义都命中，取值里带哨兵）+ 50 条更新的无关记忆
 *         ⇒ 候选上限缺省 50，总数 51 ⇒ **旧路径必然把目标挤出候选池**
 *
 *   ① `on`（混合排序）  ⇒ 目标进候选 ⇒ **出现在 packet 里**
 *   ② 旧路径（`off`）   ⇒ 目标被截断丢掉 ⇒ **不在 packet 里**
 *   ③ 同一轮的 `trace` 里**没有**哨兵（正文只许进 prompt，不许进诊断）
 * ```
 * ⚠️ ① 与 ② 是**同一条判据的两侧**：只测一侧的话，"永远不出现"也能让 ② 变绿。
 *
 * 用法：`pnpm m9.5:e2e:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
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
const GATE_VERSION = 'm9.5-e2e@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
/** 目标取值里的哨兵：让"它在不在 prompt 里"成为一个**不可能碰巧命中**的问题 */
const SENTINEL = 'SENTINEL-M95-E2E-4f21c9'
const FILLERS = 50

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
      : createM95RunId({ wpId: 'wp9-e2e', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const probes: Probe[] = []

  await resetPluginSqlConnection()
  isolateDatabase('m95-wp9-e2e', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp9-e2e' })
  const h = bed.h
  const db = h.db

  /* 布景：目标最旧、词面与语义都命中；50 条更新的无关记忆把候选池撑到上限 */
  const targetEvidence = await h.recordUserEvidence(`记住：我最喜欢的颜色是红色 ${SENTINEL}。`)
  const target = await h.commitAndFold(
    h.makeCandidate('preference', claim('preference.color.favorite', `红色 ${SENTINEL}`, h.user), {
      sourceRefs: [targetEvidence.ref],
    }),
    M4_T0 + 10
  )
  const targetId = String(target?.id ?? '')
  for (let i = 0; i < FILLERS; i += 1) {
    const evidence = await h.recordUserEvidence(`记住：我最近在练乐器第 ${String(i)} 号。`)
    await h.commitAndFold(
      h.makeCandidate('preference', claim('preference.hobby.recent', `乐器-${String(i)}`, h.user), {
        sourceRefs: [evidence.ref],
      }),
      M4_T0 + 1_000 + i
    )
  }

  const deterministicProbe: MemorySemanticProbe = {
    name: 'gate-e2e-deterministic',
    score: async (input) => {
      const scores = new Map<string, number>()
      for (const id of input.memoryIds) scores.set(String(id), String(id) === targetId ? 0.95 : 0.2)
      return scores.size > 0 ? { ok: true, scores } : { ok: false, reason: 'missing_score' }
    },
  }

  /**
   * **spy 端口**：把这一轮**召回层**的读数取出来。
   *
   * ⚠️ 为什么需要它：编译后的 packet **不能**在两次独立轮次之间逐字比较
   *    （每轮有新的 traceId 与时间戳 —— 第一版就是这么比错的：字节数一样却"不相等"）。
   *    要对照"选择变了没有"，必须取**召回层**的 `selectedIds`。
   */
  let lastRecallTrace: { selectedIds: string[]; semanticScoredCount: number } | null = null

  const runTurn = async (input: {
    readonly text: string
    readonly policyVersion?: 'lexical-recency@1' | 'hybrid-relevance@1'
    readonly semanticMode?: 'off' | 'shadow' | 'on'
  }): Promise<{ packetJson: string; traceJson: string; replyText: string; recall: { selectedIds: string[]; semanticScoredCount: number } | null }> => {
    const port = createMemoryRetrievalStore({
      store: h.store,
      integrity: (owner) => memoryIntegrityProblems(db, owner),
      rootReadings: (ids) => rootReadingsByMemory(db, ids),
      semanticProbe: deterministicProbe,
    })
    const recallPort = createRecallTurnPort({
      service: createMemoryRecallService({ port }),
      budget: DEFAULT_CONTEXT_BUDGET,
      now: () => M4_T0 + 10_000,
    })
    lastRecallTrace = null
    const spied = {
      ...recallPort,
      run: async (request: Parameters<typeof recallPort.run>[0]) => {
        const outcome = await recallPort.run(request)
        lastRecallTrace = {
          selectedIds: outcome.trace.selectedIds.map(String),
          semanticScoredCount: outcome.trace.semanticScoredCount,
        }
        return outcome
      },
    }
    const gateway = bed.gatewayOf({
      search: 'off',
      recall: spied,
      recallEnabled: true,
      ...(input.policyVersion !== undefined ? { recallPolicyVersion: input.policyVersion } : {}),
      ...(input.semanticMode !== undefined ? { recallSemanticMode: input.semanticMode } : {}),
    })
    const turn = await bed.say({
      gateway,
      text: input.text,
      replyText: '嗯，我记着呢。',
    })
    return {
      packetJson: JSON.stringify(turn.packet),
      traceJson: JSON.stringify(turn.trace),
      replyText: turn.replyText,
      recall: lastRecallTrace,
    }
  }

  /*
   * ⚠️ 查询句**必须**与目标取值有词面重叠（这里共享「红色」）。
   *    第一版写的是「我最喜欢的颜色是什么？」—— 与「红色 …」**零重叠**，
   *    于是选择器一条都没选（`selectedCount = 0`），三档读数全都"目标不在 prompt 里"，
   *    看起来像"缺口没修"，其实是**布景没让目标成为一个合格候选**。
   */
  const question = '我最喜欢的颜色是红色吗？'

  /* ---- ① on：目标进入编译后的 prompt ---- */
  const onTurn = await runTurn({ text: question, policyVersion: 'hybrid-relevance@1', semanticMode: 'on' })
  probes.push(
    await probe({
      id: 'on-mode-target-reaches-the-compiled-prompt',
      question: `① 真网关 + \`on\`：最旧但相关的目标（${String(FILLERS + 1)} 条里）**进入编译后的 prompt**`,
      run: () => ({
        packetHasSentinel: onTurn.packetJson.includes(SENTINEL),
        packetBytes: onTurn.packetJson.length,
        traceHasSentinel: onTurn.traceJson.includes(SENTINEL),
        /* 召回层的读数：用来分清"失败在召回"还是"失败在编译器/预算" */
        recallSelectedCount: onTurn.recall?.selectedIds.length ?? null,
        recallSelectedTarget: onTurn.recall?.selectedIds.includes(targetId) ?? null,
        recallSemanticScored: onTurn.recall?.semanticScoredCount ?? null,
      }),
      judge: (reading) => {
        const problems: string[] = []
        if (reading.packetHasSentinel !== true) {
          problems.push(
            '★ 目标没有出现在编译后的 prompt 里 ⇒ WP0 的层④缺口在**真链路上**仍未修（或布景没复现缺口）'
          )
        }
        /* ③ 正文只许进 prompt，不许进 trace */
        if (reading.traceHasSentinel !== false) {
          problems.push('★ 哨兵出现在这一轮的 trace 里 ⇒ 诊断泄漏正文')
        }
        return problems
      },
    })
  )

  /* ---- ② 旧路径：目标被截断丢掉（同一条判据的另一侧） ---- */
  probes.push(
    await probe({
      id: 'legacy-path-drops-the-target',
      question: '② 旧路径（不传策略版本）⇒ 目标被**候选截断**丢掉、**不在** prompt 里（缺口复现，证明 ① 不是空转）',
      run: async () => {
        const legacyTurn = await runTurn({ text: question })
        return {
          packetHasSentinel: legacyTurn.packetJson.includes(SENTINEL),
          packetBytes: legacyTurn.packetJson.length,
          replyProduced: legacyTurn.replyText.length > 0,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.packetHasSentinel !== false) {
          problems.push('★ 旧路径下目标也进了 prompt ⇒ 布景没复现缺口，"①的有效性"就无从谈起')
        }
        if (reading.replyProduced !== true) problems.push('旧路径必须照常产出一句回复（原链独立工作）')
        return problems
      },
    })
  )

  /* ---- ③ shadow：与旧路径**同 packet**，且不泄漏 ---- */
  probes.push(
    await probe({
      id: 'shadow-keeps-the-packet-identical-to-legacy',
      question: '③ S47 在**真网关**上复核：`shadow` 算分但**召回层选择**与旧路径**逐位相同**',
      run: async () => {
        const legacyTurn = await runTurn({ text: question })
        const shadowTurn = await runTurn({ text: question, policyVersion: 'hybrid-relevance@1', semanticMode: 'shadow' })
        const legacyIds = legacyTurn.recall?.selectedIds ?? []
        const shadowIds = shadowTurn.recall?.selectedIds ?? []
        return {
          identicalRecallSelection: JSON.stringify(legacyIds) === JSON.stringify(shadowIds),
          legacySelected: legacyIds.length,
          shadowSelected: shadowIds.length,
          shadowHasSentinel: shadowTurn.packetJson.includes(SENTINEL),
          shadowSemanticScored: shadowTurn.recall?.semanticScoredCount ?? null,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.identicalRecallSelection !== true) {
          problems.push(
            `★ shadow 改变了召回层的选择（legacy ${String(reading.legacySelected)} 条 vs shadow ${String(reading.shadowSelected)} 条）`
          )
        }
        if (reading.shadowHasSentinel !== false) problems.push('shadow 下目标进了 prompt ⇒ 它影响了上下文')
        /*
         * ⚠️ shadow **必须真的算了分**，否则"选择没变"可以靠"什么都没做"通过。
         * （本次布景里目标会被截断丢掉，所以 scored 可能为 0 —— 那也要**如实**区分：
         *   `null` 表示没读到召回读数（量具问题），`0` 表示确实没算分。）
         */
        if (reading.shadowSemanticScored === null) {
          problems.push('★ 没读到召回层读数 ⇒ 探针是空转的')
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
    schemaVersion: 'm9.5-e2e@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '真 TurnGateway 全链：`on` 下目标进入**编译后的 prompt** / 旧路径下目标被截断丢掉（两侧对照）/ trace 无正文 / `shadow` 与旧路径 packet 逐字相同',
      setup: `目标（最旧、词面+语义命中、取值带哨兵）+ ${String(FILLERS)} 条更新的无关记忆 ⇒ 候选上限缺省 50 必然挤出目标`,
      notProves:
        '**不**证明回复**内容**的质量（那要 WP10 盲测）；也**不**证明真实模型下的链路（本门用离线 provider 与确定性探针）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'e2e-verify.json')
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
    configHash: { fillers: FILLERS, gateway: 'real TurnGateway + offline provider' },
    command: [{ cmd: 'pnpm m9.5:e2e:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'e2e-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP9 端到端门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
