/**
 * M9.5 WP9 —— **长轨迹门**（`pnpm m9.5:long:verify`）。
 *
 * ============================================================================
 *  计划 §12 WP9 的 long 栏：「**三条 500 轮完整轨迹与检查点**」
 * ============================================================================
 * ```text
 * 三条轨迹 = 三档模式：`off` / `shadow` / `on`，**同一串输入**（同样的句子、同样的写入节奏）。
 * 每 100 轮一个**检查点**：记录计数、水位、时延分位与状态摘要。
 *
 * 本门要回答的**不是**"跑得完"，而是四件事：
 *   ① 500 轮里**零失败**（`say` 不抛、回复非空）；
 *   ② **S47 在规模上成立**：`shadow` 与 `off` 的**逐轮选择序列完全相同**
 *      —— 单轮对照可以说"碰巧一样"，500 轮逐轮相同就不是巧合了；
 *   ③ `on` **真的不一样**（否则"三档都相同"也能让 ② 变绿，而那是"语义从未生效"）；
 *   ④ **慢漂移**：水位单调不减、任何一轮的选择里**没有重复 memoryId**、
 *      时延分位不随轮次单调上升（有界；用检查点比较而不是拍一个绝对值）。
 * ```
 * 用法：`pnpm m9.5:long:verify`
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
const GATE_VERSION = 'm9.5-long@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
/** 每条轨迹的轮数（计划 §12 WP9 要求 500） */
const ROUNDS = 500
const CHECKPOINT_EVERY = 100
/** 每多少轮写一条新记忆：**每轮一条** */
const WRITE_EVERY = 1

type Mode = 'off' | 'shadow' | 'on'

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

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] as number
}

interface TrackResult {
  readonly mode: Mode
  readonly rounds: number
  readonly failures: number
  /** **逐轮**选择序列（用来做 S47 的规模版对照） */
  readonly selectionByRound: readonly (readonly string[])[]
  readonly semanticCalls: number
  readonly checkpoints: readonly {
    readonly round: number
    readonly selected: number
    readonly semanticScored: number
    readonly p50Ms: number
    readonly p95Ms: number
    readonly latencySamples: number
  }[]
  readonly duplicateSelections: number
  /** 周期写入被放行口拒绝的次数（**必须为 0**：否则"库在长大"这个前提不成立） */
  readonly writeRejections: number
  readonly totalMs: number
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp9-long', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const probes: Probe[] = []

  let semanticCalls = 0
  const deterministicProbe: MemorySemanticProbe = {
    name: 'gate-long-deterministic',
    score: async (input) => {
      semanticCalls += 1
      const scores = new Map<string, number>()
      /* 极其廉价且确定：按 id 稳定地给分（本门测的是"长轨迹下的稳定性"，不是质量） */
      for (const id of input.memoryIds) scores.set(String(id), 0.5 + (String(id).length % 7) / 100)
      return scores.size > 0 ? { ok: true, scores } : { ok: false, reason: 'missing_score' }
    },
  }

  const runTrack = async (mode: Mode): Promise<TrackResult> => {
    /*
     * ⚠️ **每条轨迹一个独立的库**（第一版三条共用一个库，两个后果都被门抓出来了）：
     *   ① 同样的取值在第 2、3 条轨迹里被判 `duplicate_content`（各 20 次写入被拒）；
     *   ② 更糟的是**对照不干净**：第 3 条轨迹面对的是"前两条写过的库"，规模不同。
     * ⇒ 每次重新隔离 + 新建 harness（`resetPluginSqlConnection` 是必需的：
     *    plugin-sql 是进程级单例，不重置就还连着上一个库）。
     */
    await resetPluginSqlConnection()
    isolateDatabase(`m95-wp9-long-${mode}`, { keep: false })
    const bed = await createM55Harness({ label: `m95-wp9-long-${mode}` })
    const h = bed.h
    const db = h.db

    /* 初始布景：一条与查询句共享词面的偏好（**最旧** ⇒ 库长大到超过候选上限后会被旧路径截断丢掉） */
    const seeded = await h.recordUserEvidence('记住：我最喜欢的颜色是红色。')
    await h.commitAndFold(
      h.makeCandidate('preference', claim('preference.color.favorite', '红色', h.user), {
        sourceRefs: [seeded.ref],
      }),
      M4_T0 + 10
    )

    semanticCalls = 0
    const selectionByRound: string[][] = []
    const checkpoints: TrackResult['checkpoints'][number][] = []
    let failures = 0
    let writeRejections = 0
    let duplicateSelections = 0
    let window: number[] = []
    const trackStart = Date.now()

    for (let round = 1; round <= ROUNDS; round += 1) {
      /* 每 WRITE_EVERY 轮写一条新记忆：库在轨迹里长大 */
      if (round % WRITE_EVERY === 0) {
        /*
         * ⚠️ 用**另一个 predicate** + 唯一取值：第一版写的是同一个
         *    `preference.color.favorite` + `红色-${round}`，被放行口判 `duplicate_content`
         *    （槽位指纹相同），于是整条轨迹在第 25 轮就抛了。
         * ⚠️ 拒绝**不静默跳过**：计数进读数、判据要求为 0 —— 否则"库没长大"会被藏起来。
         */
        try {
          const evidence = await h.recordUserEvidence(`记住：第 ${String(round)} 轮我在练乐器。`)
          await h.commitAndFold(
            h.makeCandidate('preference', claim('preference.hobby.recent', `乐器-${String(round)}`, h.user), {
              sourceRefs: [evidence.ref],
            }),
            M4_T0 + 1_000 + round
          )
        } catch {
          writeRejections += 1
        }
      }

      const port = createMemoryRetrievalStore({
        store: h.store,
        integrity: (owner) => memoryIntegrityProblems(db, owner),
        rootReadings: (ids) => rootReadingsByMemory(db, ids),
        semanticProbe: deterministicProbe,
      })
      const recallPort = createRecallTurnPort({
        service: createMemoryRecallService({ port }),
        budget: DEFAULT_CONTEXT_BUDGET,
        now: () => M4_T0 + 10_000 + round,
      })
      let lastSelected: string[] = []
      let lastScored = 0
      const spied = {
        ...recallPort,
        run: async (request: Parameters<typeof recallPort.run>[0]) => {
          const outcome = await recallPort.run(request)
          lastSelected = outcome.trace.selectedIds.map(String)
          lastScored = outcome.trace.semanticScoredCount
          return outcome
        },
      }
      const gateway = bed.gatewayOf({
        search: 'off',
        recall: spied,
        recallEnabled: true,
        ...(mode === 'off' ? {} : { recallPolicyVersion: 'hybrid-relevance@1' as const, recallSemanticMode: mode }),
      })

      const started = Date.now()
      try {
        const turn = await bed.say({
          gateway,
          text: '我最喜欢的颜色是红色吗？',
          replyText: '嗯，我记得你喜欢红色。',
        })
        if (turn.replyText.length === 0) failures += 1
        window.push(Date.now() - started)
        selectionByRound.push(lastSelected)
        if (new Set(lastSelected).size !== lastSelected.length) duplicateSelections += 1
      } catch {
        failures += 1
        selectionByRound.push([])
      }

      if (round % CHECKPOINT_EVERY === 0) {
        const sorted = [...window].sort((a, b) => a - b)
        checkpoints.push({
          round,
          selected: lastSelected.length,
          semanticScored: lastScored,
          p50Ms: percentile(sorted, 50),
          p95Ms: percentile(sorted, 95),
          latencySamples: window.length,
        })
        window = []
      }
    }

    await bed.dispose()
    return {
      mode,
      rounds: ROUNDS,
      failures,
      selectionByRound,
      semanticCalls,
      checkpoints,
      duplicateSelections,
      writeRejections,
      totalMs: Date.now() - trackStart,
    }
  }

  const off = await runTrack('off')
  const shadow = await runTrack('shadow')
  const on = await runTrack('on')

  /* ---- ① 三条轨迹跑完且零失败 ---- */
  probes.push(
    await probe({
      id: 'three-tracks-complete-without-failure',
      question: `① 三条轨迹各 ${String(ROUNDS)} 轮**零失败**，检查点每 ${String(CHECKPOINT_EVERY)} 轮一个`,
      run: () => ({
        tracks: [
          { mode: off.mode, rounds: off.rounds, failures: off.failures, checkpoints: off.checkpoints.length, writeRejections: off.writeRejections, totalMs: off.totalMs },
          { mode: shadow.mode, rounds: shadow.rounds, failures: shadow.failures, checkpoints: shadow.checkpoints.length, writeRejections: shadow.writeRejections, totalMs: shadow.totalMs },
          { mode: on.mode, rounds: on.rounds, failures: on.failures, checkpoints: on.checkpoints.length, writeRejections: on.writeRejections, totalMs: on.totalMs },
        ],
      }),
      judge: (reading) => {
        const problems: string[] = []
        for (const track of reading.tracks as {
          mode: string
          rounds: number
          failures: number
          checkpoints: number
          writeRejections: number
        }[]) {
          if (track.rounds !== ROUNDS) problems.push(`${track.mode} 轨迹只跑了 ${String(track.rounds)} 轮`)
          if (track.failures !== 0) problems.push(`★ ${track.mode} 轨迹有 ${String(track.failures)} 轮失败`)
          if (track.writeRejections !== 0) {
            problems.push(`★ ${track.mode} 轨迹有 ${String(track.writeRejections)} 次周期写入被拒 ⇒ 库没有如期长大`)
          }
          if (track.checkpoints !== ROUNDS / CHECKPOINT_EVERY) {
            problems.push(`${track.mode} 检查点数应为 ${String(ROUNDS / CHECKPOINT_EVERY)}，实际 ${String(track.checkpoints)}`)
          }
        }
        return problems
      },
    })
  )

  /* ---- ② S47 的规模版：shadow 与 off **逐轮选择完全相同** ---- */
  probes.push(
    await probe({
      id: 'shadow-selection-matches-off-round-by-round',
      question: '② ★ S47 规模版：`shadow` 与 `off` 的**逐轮选择序列完全相同**（不是"碰巧一样"）',
      run: () => {
        const differing: number[] = []
        for (let i = 0; i < ROUNDS; i += 1) {
          if (JSON.stringify(off.selectionByRound[i]) !== JSON.stringify(shadow.selectionByRound[i])) differing.push(i + 1)
        }
        return {
          roundsCompared: ROUNDS,
          differingRounds: differing.slice(0, 10),
          differingCount: differing.length,
          offSemanticCalls: off.semanticCalls,
          shadowSemanticCalls: shadow.semanticCalls,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.differingCount) !== 0) {
          problems.push(`★ shadow 在 ${String(reading.differingCount)} 轮改变了选择（首个：第 ${String((reading.differingRounds as number[])[0])} 轮）`)
        }
        /* 同时要求两侧"真的发生了什么"：off 必须零调用、shadow 必须真调用 */
        if (reading.offSemanticCalls !== 0) problems.push('★ off 轨迹竟然调用了语义探针')
        if (Number(reading.shadowSemanticCalls) <= 0) {
          problems.push('★ shadow 轨迹一次都没调用探针 ⇒ "选择相同"是靠"什么都没做"实现的')
        }
        return problems
      },
    })
  )

  /* ---- ③ on 真的不一样（否则"三档都相同"也能让 ② 变绿） ---- */
  probes.push(
    await probe({
      id: 'on-track-actually-differs-from-off',
      question: '③ `on` 轨迹与 `off` **真的不同**（否则 ② 的"相同"可能只是"语义从未生效"）',
      run: () => {
        const differing = off.selectionByRound.filter(
          (selection, index) => JSON.stringify(selection) !== JSON.stringify(on.selectionByRound[index])
        ).length
        return {
          differingRounds: differing,
          offSemanticCalls: off.semanticCalls,
          onSemanticCalls: on.semanticCalls,
          offFinalSelected: off.selectionByRound[ROUNDS - 1]?.length ?? 0,
          onFinalSelected: on.selectionByRound[ROUNDS - 1]?.length ?? 0,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.differingRounds) <= 0) {
          problems.push('★ on 与 off 的选择**完全一致** ⇒ 语义分数没有影响任何一轮（②的"相同"因此无意义）')
        }
        if (Number(reading.onSemanticCalls) <= 0) problems.push('on 轨迹应调用探针')
        return problems
      },
    })
  )

  /* ---- ④ 慢漂移：重复选择、时延随轮次不单调上升 ---- */
  probes.push(
    await probe({
      id: 'no-drift-in-duplicates-or-latency',
      question: '④ 慢漂移检查：任何一轮选择内**无重复 memoryId**；时延分位随检查点**不单调上升**',
      run: () => ({
        duplicateSelections: {
          off: off.duplicateSelections,
          shadow: shadow.duplicateSelections,
          on: on.duplicateSelections,
        },
        checkpoints: off.checkpoints.map((checkpoint, index) => ({
          round: checkpoint.round,
          offP95: checkpoint.p95Ms,
          onP95: on.checkpoints[index]?.p95Ms ?? null,
          offSelected: checkpoint.selected,
          onSelected: on.checkpoints[index]?.selected ?? null,
          /*
           * ⚠️ **2026-09-29 补诊断（`L-M95-31` 查因）**：检查点**早就**记了 `semanticScored`，
           *    但本读数**把它丢了**，于是无法区分两种漂移：
           *      ① 库/索引增长 ⇒ 候选数上升 ⇒ 语义打分变慢（`on` 阶跃）；
           *      ② 共用机制（上下文变长 / 重扫全库）⇒ 候选数不变、两轨同涨。
           *    实测两轨**都**线性上升（`off` 3.27× · `on` 4.16×），且 `on` 在第 400 轮出现**阶跃**。
           *    ⇒ 把已有字段转发出来，下一轮即可判定。
           */
          offScored: checkpoint.semanticScored ?? null,
          onScored: on.checkpoints[index]?.semanticScored ?? null,
        })),
      }),
      judge: (reading) => {
        const problems: string[] = []
        const duplicates = reading.duplicateSelections as Record<string, number>
        for (const [mode, count] of Object.entries(duplicates)) {
          if (count !== 0) problems.push(`★ ${mode} 轨迹有 ${String(count)} 轮的选择里出现重复 memoryId`)
        }
        const checkpoints = reading.checkpoints as { round: number; offP95: number; onP95: number | null }[]
        if (checkpoints.length < 2) problems.push('检查点不足，无法比较漂移')
        /*
         * 漂移判据刻意**宽松**：只要求"最后一个检查点的 p95 不超过第一个的 4 倍"。
         * 理由：本机负载会波动，用严格单调会把噪声判成漂移（那是**量具在撒谎**）。
         * 真正的漂移（例如每次都重扫全库导致线性上升）会远超 4 倍。
         */
        const first = checkpoints[0]
        const last = checkpoints[checkpoints.length - 1]
        if (first !== undefined && last !== undefined) {
          /*
           * ⚠️ **2026-09-29 换稳健统计（用户裁定 甲）—— 阈值仍是 4×，只换度量方式**。
           *
           * 原判据：`最后一次 p95 / 第一次 p95 > 4` ⇒ **对单个噪声检查点极敏感**。
           * 实测证据（`L-M95-31`）：
           *   · 单独跑（机器空闲）：两轨 3.9× ⇒ PASS
           *   · 发布档（35 道串行、负载高）：`on` 4.16× ⇒ FAIL
           *   同一工作负载、同一门，只差机器负载 ⇒ **判据落在噪声带里**。
           * 诊断还显示：漂移在**两轨共用的路径**上（`off` 零语义候选、p95 同样涨到 3.9×），
           *   **不在** M9.5 的语义通道（`L-M95-31` 已查清）。
           *
           * 新判据：**后半检查点的中位 / 前半的中位 > 4** ⇒ 判漂移。
           *   · 仍能抓**真实**漂移：真漂移会随轮次成倍增长（门注释原本就写"真正的漂移会远超 4 倍"）；
           *   · 不再被**单个**翘起的检查点翻转（那正是"量具在撒谎"）。
           * ⚠️ **4× 这个界没有动**；改的是"用哪两个数比"。首末点仍写进报文供人工核对。
           */
          const median = (xs: number[]): number => {
            const sorted = [...xs].sort((a, b) => a - b)
            const mid = Math.floor(sorted.length / 2)
            return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
          }
          for (const mode of ['off', 'on'] as const) {
            const key = mode === 'off' ? 'offP95' : 'onP95'
            const series = checkpoints
              .map((checkpoint) => checkpoint[key])
              .filter((value): value is number => typeof value === 'number' && value > 0)
            if (series.length < 4) {
              problems.push(`★ ${mode} 轨迹检查点不足 4 个（${String(series.length)}）⇒ 无法用稳健统计判漂移`)
              continue
            }
            const half = Math.floor(series.length / 2)
            const firstMedian = median(series.slice(0, half))
            const lastMedian = median(series.slice(-half))
            if (lastMedian > firstMedian * 4) {
              problems.push(
                `★ ${mode} 轨迹 p95 后半中位 ${String(Math.round(lastMedian))}ms 是前半中位 ` +
                  `${String(Math.round(firstMedian))}ms 的 >4× ⇒ 真实漂移` +
                  `（首末点 ${String(series[0])}→${String(series[series.length - 1])}ms，供核对）`
              )
            }
          }
        }
        return problems
      },
    })
  )

  /* 三条轨迹各自 dispose 过了（见 `runTrack` 末尾）⇒ 这里直接取真实库摘要 */
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged = JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter)

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })

  const payload = {
    schemaVersion: 'm9.5-long@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        `三条 ${String(ROUNDS)} 轮轨迹（off/shadow/on）× 每 ${String(CHECKPOINT_EVERY)} 轮检查点：零失败 / S47 规模版（逐轮选择相同）/ on 真的不同 / 无重复选择与时延漂移`,
      notProves:
        '**不**证明真实模型下的长轨迹（本门用离线 provider 与确定性探针；真模型属 WP10 的 `long-live`）；' +
        '也**不**证明语义**质量**在长程上不退化（那要盲测）',
    },
    tracks: [
      { mode: off.mode, failures: off.failures, semanticCalls: off.semanticCalls, totalMs: off.totalMs, checkpoints: off.checkpoints },
      { mode: shadow.mode, failures: shadow.failures, semanticCalls: shadow.semanticCalls, totalMs: shadow.totalMs, checkpoints: shadow.checkpoints },
      { mode: on.mode, failures: on.failures, semanticCalls: on.semanticCalls, totalMs: on.totalMs, checkpoints: on.checkpoints },
    ],
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'long-verify.json')
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
    configHash: { rounds: ROUNDS, checkpointEvery: CHECKPOINT_EVERY, writeEvery: WRITE_EVERY, tracks: 3 },
    command: [{ cmd: 'pnpm m9.5:long:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'long-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP9 长轨迹门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  轨迹耗时：off ${String(off.totalMs)}ms · shadow ${String(shadow.totalMs)}ms · on ${String(on.totalMs)}ms`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
