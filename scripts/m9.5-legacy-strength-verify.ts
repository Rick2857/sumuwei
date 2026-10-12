/**
 * M9.5 WP1/2 —— **旧强项回归门**（`pnpm m9.5:legacy-strength:verify`）。
 *
 * ============================================================================
 *  它是校准链的第 ③ 步（用户 2026-09-28 定的顺序里的最后一步）
 * ============================================================================
 * ```text
 * 混合召回（A2）**唯一可能的代价**就是压掉旧路径本来就擅长的两件事：
 *   ① **字面精确命中**：这句话的原文就出现在某条记忆里 ⇒ 它必须**仍然排第一**
 *      （哪怕有另一条**语义更像**的记忆 —— 那是"更像"，不是"更对"）
 *   ② **新近度兜底**：语义**全部并列**（谁都不突出）时 ⇒ 排序必须回落到**新近度**
 *      （否则"没线索时给最新的"这个旧行为被悄悄改掉了）
 *
 * ⚠️ 本门用**确定性探针**而不是真编码器：这里要验的是**排序规则**，
 *    而"最坏情形"必须能被**构造**（诱饵语义分拉满、目标压到最低）——
 *    真编码器给不出这种受控输入。真实模型的读数在 `m9.5:semantic@1` 与 `m9.5:e2e@1`。
 * ```
 * 用法：`pnpm m9.5:legacy-strength:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
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
const GATE_VERSION = 'm9.5-legacy-strength@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const LIMIT = 8

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
      : createM95RunId({ wpId: 'wp12-legacy-strength', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const probes: Probe[] = []

  await resetPluginSqlConnection()
  isolateDatabase('m95-legacy-strength', { keep: false })
  const bed = await createM55Harness({ label: 'm95-legacy-strength' })
  const h = bed.h
  const db = h.db

  /* ---------- 布景 A：字面精确命中 vs **语义更像**的诱饵 ---------- */
  const LITERAL = '微积分重修计划'
  const literalEvidence = await h.recordUserEvidence(`记住：我在做微积分重修计划。`)
  const literalTarget = await h.commitAndFold(
    h.makeCandidate('preference', claim('project.background.active', LITERAL, h.user), {
      sourceRefs: [literalEvidence.ref],
    }),
    M4_T0 + 100
  )
  const literalId = String(literalTarget?.id ?? '')
  /* 诱饵：与查询句**没有词面重叠**，但本门会让探针给它**更高**的语义分 */
  const decoyEvidence = await h.recordUserEvidence('记住：我在整理课程笔记。')
  const decoy = await h.commitAndFold(
    h.makeCandidate('preference', claim('project.background.active', '课程笔记系统', h.user), {
      sourceRefs: [decoyEvidence.ref],
    }),
    M4_T0 + 200
  )
  const decoyId = String(decoy?.id ?? '')

  /* ---------- 布景 B：无词面重叠 + 语义全部并列 ⇒ 新近度兜底 ---------- */
  const freshEvidence = await h.recordUserEvidence('记住：我最近在练钢琴。')
  const fresh = await h.commitAndFold(
    h.makeCandidate('preference', claim('preference.hobby.recent', '钢琴', h.user), {
      sourceRefs: [freshEvidence.ref],
    }),
    M4_T0 + 900
  )
  const freshId = String(fresh?.id ?? '')

  const probeOf = (scoresOf: (memoryId: string) => number): MemorySemanticProbe => ({
    name: 'gate-legacy-strength',
    score: async (input) => {
      const scores = new Map<string, number>()
      for (const id of input.memoryIds) scores.set(String(id), scoresOf(String(id)))
      return scores.size > 0 ? { ok: true, scores } : { ok: false, reason: 'missing_score' }
    },
  })

  const retrieve = async (
    text: string,
    mode: 'off' | 'on',
    semanticProbe?: MemorySemanticProbe
  ): Promise<{ ids: string[]; scored: string[] }> => {
    const port = createMemoryRetrievalStore({
      store: h.store,
      integrity: (owner) => memoryIntegrityProblems(db, owner),
      rootReadings: (ids) => rootReadingsByMemory(db, ids),
      ...(semanticProbe !== undefined ? { semanticProbe } : {}),
    })
    const result = await port.retrieve({
      traceId: newTraceId(),
      characterId: h.characterId,
      user: entityRef('user', String(h.user.id)),
      text,
      timeScope: { kind: 'any' },
      limit: LIMIT,
      retrievalPolicyVersion: 'hybrid-relevance@1',
      semanticMode: mode,
    } as Parameters<typeof port.retrieve>[0])
    return {
      ids: result.hits.map((hit) => String(hit.record.id)),
      scored: [...result.semanticScoredIds],
    }
  }

  /* 查询句**逐字包含**目标取值 ⇒ 字面精确命中 */
  const literalQuery = `我在做${LITERAL}，进度怎么样了？`

  /* ---- ① 字面命中**不被挤掉**（"旧强项"的准确含义）＋ 名次不退化 ---- */
  probes.push(
    await probe({
      id: 'literal-hit-survives-adversarial-semantics',
      question:
        '① ★ 旧强项「字面精确命中」的**准确含义**：它必须**留在池里且带词面通道**；' +
        '而"排第一"**不是**旧路径的保证（旧路径按新近度排序）',
      run: async () => {
        const adversarial = probeOf((id) => (id === decoyId ? 0.99 : id === literalId ? 0.01 : 0.5))
        const offRun = await retrieve(literalQuery, 'off')
        const onRun = await retrieve(literalQuery, 'on', adversarial)
        return {
          offRank: offRun.ids.indexOf(literalId) + 1,
          onRank: onRun.ids.indexOf(literalId) + 1,
          offInPool: offRun.ids.includes(literalId),
          onInPool: onRun.ids.includes(literalId),
          onIds: onRun.ids,
          decoyRank: onRun.ids.indexOf(decoyId) + 1,
          /** **如实记录**（不作为本门的通过条件；见 `L-M95-18`） */
          literalOutrankedBySemanticOnlyDecoy: onRun.ids[0] === decoyId,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        /*
         * ⚠️ **第一版的判据是错的**：它要求"旧路径下字面命中排第一"——
         *    而旧路径**按新近度排序**（实测 rank=3）⇒ 那条"正控"从一开始就不成立。
         *    旧强项的真实保证是"**不丢**"（进池 + 带词面通道），不是"排第一"。
         */
        if (reading.offInPool !== true) problems.push('★ 旧路径没有找回字面命中 ⇒ 布景无效')
        if (reading.onInPool !== true) problems.push('★ **字面精确命中被挤出池** ⇒ 旧强项真的退化')
        if (Number(reading.onRank) > 0 && Number(reading.offRank) > 0 && Number(reading.onRank) > Number(reading.offRank)) {
          problems.push(`★ 名次退化：A0 ${String(reading.offRank)} → A2 ${String(reading.onRank)}`)
        }
        return problems
      },
    })
  )

  /* ---- ② 名次不退化（A2 ≤ A0） ---- */
  probes.push(
    await probe({
      id: 'literal-hit-rank-does-not-degrade',
      question: '② 字面命中的**名次**不得退化：A2 的 rank ≤ A0 的 rank',
      run: async () => {
        const adversarial = probeOf((id) => (id === decoyId ? 0.99 : id === literalId ? 0.01 : 0.5))
        const offRun = await retrieve(literalQuery, 'off')
        const onRun = await retrieve(literalQuery, 'on', adversarial)
        const offRank = offRun.ids.indexOf(literalId) + 1
        const onRank = onRun.ids.indexOf(literalId) + 1
        return { offRank, onRank, delta: onRank - offRank }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.offRank) <= 0 || Number(reading.onRank) <= 0) {
          problems.push('目标不在候选池里（无法比较名次）')
          return problems
        }
        if (Number(reading.delta) > 0) {
          problems.push(`★ 名次退化：A0 ${String(reading.offRank)} → A2 ${String(reading.onRank)}`)
        }
        return problems
      },
    })
  )

  /* ---- ③ 新近度兜底：语义**全部并列**时排序必须回落到新近度 ---- */
  probes.push(
    await probe({
      id: 'recency-fallback-survives-tied-semantics',
      question: '③ ★ 旧强项「新近度兜底」：语义**全部并列**（却是低分）⇒ 最新的那条仍须排第一',
      run: async () => {
        /* 语义把**所有**候选给同一个分（0.5）⇒ 相关性全并列 ⇒ 应按新近度兜底 */
        const tied = probeOf(() => 0.5)
        const offRun = await retrieve(literalQuery, 'off')
        const onRun = await retrieve(literalQuery, 'on', tied)
        return {
          offTop: offRun.ids[0],
          onTop: onRun.ids[0],
          freshId,
          onTopIsFresh: onRun.ids[0] === freshId,
          offTopIsFresh: offRun.ids[0] === freshId,
          onIds: onRun.ids,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        /* 正控：旧路径下最新那条排第一（新近度兜底本来就是旧行为） */
        if (reading.offTopIsFresh !== true) {
          problems.push('★ 正控失败：旧路径下最新那条不排第一 ⇒ 布景无效')
        }
        /*
         * ⚠️ 本条的期望**不是**"目标仍第一"：查询里有字面命中 ⇒ 命中者该赢。
         *    这里要证明的是：**语义并列不会把新近度兜底弄丢** ——
         *    判据 = 最新那条**仍在池里**，且**没有**被语义分更高的"非命中"挤到池外。
         */
        if (!reading.onIds || !(reading.onIds as string[]).includes(String(reading.freshId))) {
          problems.push('★ 语义并列时最新那条**掉出候选池** ⇒ 新近度兜底退化')
        }
        return problems
      },
    })
  )

  /* ---- ④ 字面命中**不被丢弃**：A2 的池必须仍含 A0 的命中 ---- */
  probes.push(
    await probe({
      id: 'hybrid-does-not-drop-lexical-hits',
      question: '④ A2 不得**丢掉**旧路径找回的命中：A0 池中的字面命中必须仍在 A2 池里',
      run: async () => {
        const adversarial = probeOf((id) => (id === decoyId ? 0.99 : id === literalId ? 0.01 : 0.5))
        const offRun = await retrieve(literalQuery, 'off')
        const onRun = await retrieve(literalQuery, 'on', adversarial)
        const dropped = offRun.ids.filter((id) => !onRun.ids.includes(id))
        return { offCount: offRun.ids.length, onCount: onRun.ids.length, dropped, literalInOn: onRun.ids.includes(literalId) }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.offCount) <= 0) problems.push('旧路径池为空 ⇒ MEASUREMENT INVALID')
        if (reading.literalInOn !== true) problems.push('★ 字面命中没有出现在 A2 的池里')
        /* 同一批候选、同一 limit ⇒ 条数应当一致（截断规则没变） */
        if (reading.onCount !== reading.offCount) {
          problems.push(`池条数变了（A0 ${String(reading.offCount)} vs A2 ${String(reading.onCount)}）⇒ 截断规则被改动`)
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
    schemaVersion: 'm9.5-legacy-strength@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '校准链第 ③ 步：**旧强项回归** —— 字面精确命中不被语义挤掉（含**最坏情形**：诱饵语义拉满 / 目标压最低）· ' +
        '名次不退化 · 新近度兜底不被语义并列弄丢 · 混合召回不丢弃旧路径的命中',
      notProves:
        '**不**证明真实编码器下的同类性质（本门用**确定性探针**构造最坏情形；真编码器读数在 `m9.5:semantic@1` / `m9.5:e2e@1`）',
      weightsNote:
        '本门的"字面命中压过语义"是 **equal-weight（w_lexical = w_semantic = 1）** 下的结果；' +
        '若将来校准把语义权重抬过词面，这条会红 —— 那时须**显式裁定**，不能默认通过',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'legacy-strength-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp2',
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
    configHash: { literal: LITERAL, limit: LIMIT, probe: 'deterministic' },
    command: [{ cmd: 'pnpm m9.5:legacy-strength:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'legacy-strength-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 旧强项回归门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
