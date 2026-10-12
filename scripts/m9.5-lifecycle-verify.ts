/**
 * M9.5 WP5 —— **连续水位 / 缺口 / 重试 / 终态门**（`pnpm m9.5:lifecycle:verify`）。
 *
 * ============================================================================
 *  它验的是哪一条（计划 §8.3 逐字）
 * ============================================================================
 * ```text
 * §8.3-3「第 40 条失败、第 41 条成功，**不得**把水位直接写为 41 并遗漏 40」
 * §8.3-2「处理结果落盘后才推进**连续已处理水位**」
 * §8.3-7「`published` 不等于永远完整；新记忆未索引时**显式报告 pending**」
 * §8.2  「`coverageComplete` … 政策排除列表必须独立给出」
 * §8.3-6「模型变更建立新 generation，**禁止**不同模型空间或不同维度混排」
 * ```
 * 全部是**纯函数**判据（无数据库、无模型）⇒ 可穷举边界：
 * 缺口在首位 / 中间 / 末位；缺口之后仍有成功；重试恰好到上限；换代混排。
 *
 * 用法：`pnpm m9.5:lifecycle:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  assertSameGeneration,
  planIndexMaintenance,
  replayIsIdempotent,
  type Attempt,
  type MaintenanceState,
  type SourceItem,
} from '../src/kernel/app/recall/index-maintenance.ts'

import { sha256 } from './m4-harness.ts'
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
const GATE_VERSION = 'm9.5-lifecycle@1'

interface Probe {
  readonly id: string
  readonly question: string
  readonly verdict: 'ok' | 'unexpected'
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

function probe(input: {
  readonly id: string
  readonly question: string
  readonly run: () => Promise<Record<string, unknown>> | Record<string, unknown>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Probe {
  try {
    const reading = input.run()
    if (reading instanceof Promise) throw new Error('本门的探针必须是同步纯函数')
    const problems = input.judge?.(reading) ?? []
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

const item = (seq: number): SourceItem => ({ seq, memoryId: `mem:${String(seq).padStart(4, '0')}`, sourceRevision: 1 })
const okAttempt = (seq: number): Attempt => ({ item: item(seq), ok: true })
const badAttempt = (seq: number, reason = 'invalid_vector:nan_or_inf'): Attempt => ({ item: item(seq), ok: false, reason })

const baseState = (processedWatermark: number): MaintenanceState => ({
  processedWatermark,
  failures: [],
  generationId: 'gen-A',
  modelFingerprint: 'fp-A',
  indexSchemaVersion: 1,
})

function main(): void {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp5-lifecycle', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const probes: Probe[] = []

  /* ---- ① 核心不变式：第 40 失败、第 41 成功 ⇒ 水位**不得**写成 41 ---- */
  probes.push(
    probe({
      id: 'gap-does-not-advance-watermark',
      question: '§8.3-3：第 40 条失败、第 41 条成功 ⇒ 水位停在 39（**不得**写成 41），但 41 照样写',
      run: () => {
        const plan = planIndexMaintenance({
          state: baseState(39),
          attempts: [okAttempt(41), badAttempt(40)],
          batchLimit: 10,
          maxAttempts: 3,
          sourceTotal: 42,
        })
        return {
          nextWatermark: plan.nextWatermark,
          gapBlocked: plan.gapBlocked,
          gapAtSeq: plan.gapAtSeq,
          rowsWritten: plan.rowsToWrite.map((row) => row.seq),
          writtenAboveGap: plan.writtenAboveGap,
          coverageComplete: plan.coverageComplete,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.nextWatermark !== 39) problems.push(`水位应为 39，实际 ${String(reading.nextWatermark)}`)
        if (reading.gapBlocked !== true || reading.gapAtSeq !== 40) problems.push('缺口未被识别在 seq=40')
        /* 缺口之后成功的行**照样写** —— "水位不推进" ≠ "后面的行不写" */
        if (JSON.stringify(reading.rowsWritten) !== JSON.stringify([41])) {
          problems.push(`缺口之后的成功行应写入，实际 ${JSON.stringify(reading.rowsWritten)}`)
        }
        if (reading.writtenAboveGap !== 1) problems.push('writtenAboveGap 应为 1')
        if (reading.coverageComplete !== false) problems.push('有缺口却宣称覆盖完整')
        return problems
      },
    })
  )

  /* ---- ② 缺口在首位 / 末位 ---- */
  probes.push(
    probe({
      id: 'gap-at-first-position',
      question: '缺口在首位 ⇒ 水位**一步都不动**（即使后面全成功）',
      run: () => {
        const plan = planIndexMaintenance({
          state: baseState(10),
          attempts: [badAttempt(11), okAttempt(12), okAttempt(13)],
          batchLimit: 10,
          maxAttempts: 3,
          sourceTotal: 14,
        })
        return { nextWatermark: plan.nextWatermark, rowsWritten: plan.rowsToWrite.map((r) => r.seq), writtenAboveGap: plan.writtenAboveGap }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.nextWatermark !== 10) problems.push(`水位应保持 10，实际 ${String(reading.nextWatermark)}`)
        if (JSON.stringify(reading.rowsWritten) !== JSON.stringify([12, 13])) problems.push('后面的成功行应写入')
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'no-gap-advances-fully',
      question: '正控（无缺口）⇒ 水位推进到本批末尾（否则上面那些判据可以靠"永不推进"通过）',
      run: () => {
        const plan = planIndexMaintenance({
          state: baseState(10),
          attempts: [okAttempt(11), okAttempt(12), okAttempt(13)],
          batchLimit: 10,
          maxAttempts: 3,
          sourceTotal: 14,
        })
        return { nextWatermark: plan.nextWatermark, gapBlocked: plan.gapBlocked, pending: plan.pendingCount, coverageComplete: plan.coverageComplete }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.nextWatermark !== 13) problems.push(`水位应到 13，实际 ${String(reading.nextWatermark)}`)
        if (reading.gapBlocked !== false) problems.push('无缺口却报 gapBlocked')
        if (reading.pending !== 1) problems.push(`pending 应为 1，实际 ${String(reading.pending)}`)
        if (reading.coverageComplete !== false) problems.push('还有待处理却宣称覆盖完整')
        return problems
      },
    })
  )

  /* ---- ③ 重试与终态 ---- */
  probes.push(
    probe({
      id: 'retry-accumulates-then-clears',
      question: '重试累计：失败两次后成功 ⇒ 尝试数不再保留，水位推进',
      run: () => {
        let state = baseState(39)
        const attemptsSeen: number[] = []
        for (let round = 0; round < 3; round += 1) {
          const plan = planIndexMaintenance({
            state,
            attempts: [round < 2 ? badAttempt(40) : okAttempt(40)],
            batchLimit: 1,
            maxAttempts: 5,
            sourceTotal: 41,
          })
          attemptsSeen.push(plan.failures.find((f) => f.seq === 40)?.attempts ?? -1)
          state = { ...state, processedWatermark: plan.nextWatermark, failures: plan.failures }
        }
        return { attemptsSeen, finalWatermark: state.processedWatermark, finalFailures: state.failures.length }
      },
      judge: (reading) => {
        const problems: string[] = []
        const seen = reading.attemptsSeen as number[]
        if (JSON.stringify(seen.slice(0, 3)) !== JSON.stringify([1, 2, -1])) {
          problems.push(`尝试数序列应为 [1,2,成功即清除]，实际 ${JSON.stringify(seen)}`)
        }
        if (reading.finalWatermark !== 40) problems.push(`成功后水位应到 40，实际 ${String(reading.finalWatermark)}`)
        if (reading.finalFailures !== 0) problems.push('成功后失败记录应清空')
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'terminal-failure-still-blocks-watermark',
      question: '终态失败（达尝试上限）**仍然**挡住水位 —— "永久失败"与"可以跳过"是两件事',
      run: () => {
        let state = baseState(39)
        for (let round = 0; round < 3; round += 1) {
          const plan = planIndexMaintenance({
            state,
            attempts: [badAttempt(40, 'model_missing')],
            batchLimit: 1,
            maxAttempts: 3,
            sourceTotal: 41,
          })
          state = { ...state, processedWatermark: plan.nextWatermark, failures: plan.failures }
        }
        const plan = planIndexMaintenance({
          state,
          attempts: [okAttempt(41)],
          batchLimit: 1,
          maxAttempts: 3,
          sourceTotal: 41,
        })
        return {
          watermark: plan.nextWatermark,
          failures: plan.failures.map((f) => ({ seq: f.seq, attempts: f.attempts, terminal: f.terminal })),
          coverageComplete: plan.coverageComplete,
          failedCount: plan.failedCount,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        const failures = reading.failures as { seq: number; attempts: number; terminal: boolean }[]
        const target = failures.find((f) => f.seq === 40)
        if (target === undefined) problems.push('终态失败记录丢失')
        else {
          if (target.terminal !== true) problems.push(`attempts=${String(target.attempts)} 应已进终态`)
          if (target.attempts !== 3) problems.push(`尝试数应为 3，实际 ${String(target.attempts)}`)
        }
        if (reading.watermark !== 39) problems.push(`终态失败仍应挡住水位（39），实际 ${String(reading.watermark)}`)
        if (reading.coverageComplete !== false) problems.push('有终态失败却宣称覆盖完整')
        if (reading.failedCount !== 1) problems.push('failedCount 应为 1')
        return problems
      },
    })
  )

  /* ---- ④ 断电点①：写成功但水位未推进（重放幂等） ---- */
  probes.push(
    probe({
      id: 'power-cut-written-not-watermarked',
      question: '断电点①「写成功、水位未推进」⇒ 重放只补未写入的行，且**不**越过缺口',
      run: () => {
        const attempts = [badAttempt(40), okAttempt(41), okAttempt(42)]
        const first = planIndexMaintenance({ state: baseState(39), attempts, batchLimit: 10, maxAttempts: 3, sourceTotal: 43 })
        /* 模拟：41/42 已落盘，但水位推进前断电 ⇒ 状态仍是 watermark=39、failures=[] */
        const replay = replayIsIdempotent(
          { state: baseState(39), attempts, batchLimit: 10, maxAttempts: 3, sourceTotal: 43 },
          ['mem:0041', 'mem:0042']
        )
        return {
          firstWritten: first.rowsToWrite.map((r) => r.seq),
          firstWatermark: first.nextWatermark,
          replayWritten: replay.rowsToWrite.map((r) => r.seq),
          replayWatermark: replay.nextWatermark,
          replayGapAt: replay.gapAtSeq,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (JSON.stringify(reading.firstWritten) !== JSON.stringify([41, 42])) problems.push('首轮应写 41/42')
        if (reading.firstWatermark !== 39) problems.push('首轮水位不该越过缺口')
        if (JSON.stringify(reading.replayWritten) !== JSON.stringify([])) {
          problems.push(`重放不应重复写已落盘的行，实际 ${JSON.stringify(reading.replayWritten)}`)
        }
        if (reading.replayWatermark !== 39) problems.push('重放不得越过缺口')
        if (reading.replayGapAt !== 40) problems.push('重放仍应看见 seq=40 这个缺口')
        return problems
      },
    })
  )

  /* ---- ⑤ 断电点②：编码后未写（重放应补上） ---- */
  probes.push(
    probe({
      id: 'power-cut-encoded-not-written',
      question: '断电点②「编码完成、尚未落盘」⇒ 重放把该行补写，水位照常受缺口约束',
      run: () => {
        const attempts = [okAttempt(50), okAttempt(51)]
        const replay = replayIsIdempotent(
          { state: baseState(49), attempts, batchLimit: 10, maxAttempts: 3, sourceTotal: 52 },
          []
        )
        return { replayWritten: replay.rowsToWrite.map((r) => r.seq), replayWatermark: replay.nextWatermark }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (JSON.stringify(reading.replayWritten) !== JSON.stringify([50, 51])) problems.push('未落盘的行应被补写')
        if (reading.replayWatermark !== 51) problems.push('无缺口时水位应到 51')
        return problems
      },
    })
  )

  /* ---- ⑥ 换代混排必须被拒 ---- */
  probes.push(
    probe({
      id: 'generation-mixing-refused',
      question: '§8.3-6：跨代 / 模型指纹不符 / schema 版本不符 一律拒绝（不得混排）',
      run: () => {
        const results: Record<string, string> = {}
        const cases: [string, Parameters<typeof assertSameGeneration>[1]][] = [
          ['same', { generationId: 'gen-A', modelFingerprint: 'fp-A', indexSchemaVersion: 1 }],
          ['other-generation', { generationId: 'gen-B', modelFingerprint: 'fp-A', indexSchemaVersion: 1 }],
          ['other-fingerprint', { generationId: 'gen-A', modelFingerprint: 'fp-B', indexSchemaVersion: 1 }],
          ['other-schema-version', { generationId: 'gen-A', modelFingerprint: 'fp-A', indexSchemaVersion: 2 }],
        ]
        for (const [label, batch] of cases) {
          try {
            assertSameGeneration(baseState(0), batch)
            results[label] = 'accepted'
          } catch (error) {
            results[label] = (error as Error).message.slice(0, 60)
          }
        }
        return results
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.same !== 'accepted') problems.push('同代应被接受')
        for (const key of ['other-generation', 'other-fingerprint', 'other-schema-version']) {
          if (reading[key] === 'accepted') problems.push(`${key} 应被拒绝`)
        }
        return problems
      },
    })
  )

  /* ---- ⑦ 有界批次：batchLimit 真的生效（否则"有界维护"是空话） ---- */
  probes.push(
    probe({
      id: 'batch-limit-is-enforced',
      question: 'batchLimit 真的截断本批（且水位只推进到被处理到的位置）',
      run: () => {
        const plan = planIndexMaintenance({
          state: baseState(0),
          attempts: Array.from({ length: 20 }, (_, i) => okAttempt(i + 1)),
          batchLimit: 7,
          maxAttempts: 3,
          sourceTotal: 20,
        })
        return { processed: plan.rowsToWrite.length, nextWatermark: plan.nextWatermark, pending: plan.pendingCount }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.processed) !== 7) problems.push(`本批应处理 7 条，实际 ${String(reading.processed)}`)
        if (reading.nextWatermark !== 7) problems.push(`水位应到 7，实际 ${String(reading.nextWatermark)}`)
        if (Number(reading.pending) !== 13) problems.push(`pending 应为 13，实际 ${String(reading.pending)}`)
        return problems
      },
    })
  )

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })

  const payload = {
    schemaVersion: 'm9.5-lifecycle@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies: '连续已处理水位 / 缺口不推进 / 缺口之后照样写 / 重试累计 / 终态仍挡水位 / 两个断电点的重放幂等 / 换代拒混排 / 有界批次',
      pure: '全部是纯函数判据（无数据库、无模型）；落盘与编码在调用方',
      notProves: '**不**证明真实库上的水位回填与重启恢复（那需要 WP5 的存储侧接线，下一轮）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
  }
  const evidencePath = join(runDir, 'lifecycle-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp5',
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
    dbKind: 'not-applicable',
    isolationProof: {
      dbTouched: false,
      method: '**构造属性**：本门只测纯函数；不 import 数据库、不 import 编码器',
    },
    configHash: { gate: 'm9.5-lifecycle@1', pure: true },
    command: [{ cmd: 'pnpm m9.5:lifecycle:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'lifecycle-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP5 水位/缺口门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

main()
