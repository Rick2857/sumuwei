/**
 * M6.1 —— **CD-9 跨轮聚合的核心**（被两个入口共用）。
 *
 * ============================================================================
 *  为什么要单独一份
 * ============================================================================
 * `m6.1:cross-run:verify` 是**离线**入口：跑完几轮之后回过头聚合。
 * 而 live 门在 §13.3 之前**根本没有喂跨轮读数**（verdict 里写着 `cross_run_not_measured`），
 * 那是一个已知缺口：量具在自己的读数里承认"跨轮可复现性没测到"，却仍然出 verdict。
 *
 * 用户 2026-09-23 的工作单第 3 项要求接通它：**本轮采样完成后，与同配置历史聚合，
 * 再生成最终 verdict**。因此聚合逻辑必须只有一份 —— 两个入口各写一遍，
 * 迟早出现"离线和 live 用不同口径"的静默错配（本仓库已经登记过同型缺陷）。
 *
 * ============================================================================
 *  纪律
 * ============================================================================
 * ```text
 *   ① 只聚合**配置键相同**的采样；不同的**不合并**，但计入 excludedByConfig。
 *   ② 只取**成功**采样：失败采样是"没测到"，混进来就会把传输故障说成语料不一致。
 *   ③ 按目录 mtime 排序，**不**按 runId 字典序（字典序 ≠ 时间序）。
 *   ④ 本轮由调用方显式传入（in-memory 采样），**不**从磁盘读自己 —— 避免读到自己写了一半的断点。
 *   ⑤ 历史不足时如实返回"没测到"，由 evaluateCrossRun 判 INCONCLUSIVE，绝不判通过。
 * ```
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { sha256OfText } from './m6.1-evidence.ts'
import {
  crossRunConfigKey,
  judgePromptCorpusText,
  type CrossRunReading,
  type CrossRunSample,
  type InstrumentItem,
  type RecordedJudgeConfig,
} from './m6.1-instrument.ts'

export { crossRunConfigKey, type RecordedJudgeConfig }

export interface PerRunSummary {
  readonly runId: string
  readonly samples: number
  readonly failedSamples: number
  readonly hasJudgedEvidence: boolean
}

export interface CrossRunAggregate {
  readonly reading: CrossRunReading
  readonly configKeyOfCurrent: string
  readonly perRun: readonly PerRunSummary[]
  readonly counters: {
    readonly runsScanned: number
    readonly runsWithEvidence: number
    readonly runsWithoutEvidence: number
    readonly successfulSamples: number
    readonly failedSamples: number
  }
}

/**
 * 从一份 `instrument-live.json` 取出探针采样。
 *
 * ⚠️ 采样明细不在读数文件里（那里只有聚合与 disagreements），而在每轮的
 * `stability.partial.jsonl`（逐采样断点）。缺断点 = 那一轮没有可用明细，**不是 0 条一致**。
 */
export function samplesFromRun(
  runId: string,
  evidencePath: string,
  evalDir: string
): { samples: CrossRunSample[]; configKey: string | null } {
  const parsed = JSON.parse(readFileSync(evidencePath, 'utf8')) as { judge?: RecordedJudgeConfig }
  const configKey = crossRunConfigKey(parsed.judge ?? {}, PROBE_SET_VERSION)
  const partialPath = join(evalDir, runId, 'stability.partial.jsonl')
  if (!existsSync(partialPath) || configKey === null) return { samples: [], configKey }
  const samples: CrossRunSample[] = []
  for (const line of readFileSync(partialPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const record = JSON.parse(line) as { itemId?: unknown; ok?: unknown; labels?: unknown }
    if (typeof record.itemId !== 'string') continue
    if (record.ok !== true) continue // 失败采样不进比对
    const labels = Array.isArray(record.labels) ? record.labels.map(String) : []
    samples.push({ runId, itemId: record.itemId, configKey, labels })
  }
  return { samples, configKey }
}

/** 探针集版本 —— 进配置键：探针换了，跨轮比对就不再可比。 */
export const PROBE_SET_VERSION = 'm6.1-stability-probe@1'

/**
 * CD-9 的**可比性指纹**。
 *
 * ⚠️ 签名里**只有探针集** —— 这是刻意的结构性约束。
 *
 * 第一版在 live 门里折的是 `[...items, ...probeItems]`（本轮跑的全部条目），
 * 于是指纹**随作用域变化**：`--limit 20`、`--only J-4`、全量 68 条会得出三个不同的值，
 * 而 CD-9 比的**就是那 6 条探针**，本轮跑了几条语料根本不影响它们的提示。
 * 实测代价：`--only J-4` 那轮算出 `431dd2af71ea`，与两轮全量的 `47780a48310e` 都不同
 * ⇒ 一次小实验的探针证据被白白排除，跨轮历史永远凑不够。
 *
 * 现在把"只折探针"做成函数签名的一部分：调用方**拿不到**把语料塞进来的口子。
 */
export function probePromptDigest(probeItems: readonly InstrumentItem[]): string {
  return sha256OfText(judgePromptCorpusText(probeItems))
}

/**
 * 聚合"本轮 + 同配置历史"。
 *
 * `currentSamples` 由调用方给出（live 门用内存里刚跑完的采样；离线入口用与历史同源的读取方式）。
 * 历史**一定**排除 `currentRunId` 自己。
 */
export function aggregateCrossRun(options: {
  readonly evalDir: string
  readonly currentRunId: string
  readonly currentSamples: readonly CrossRunSample[]
  readonly configKey: string
  /** 需要与 `computeCrossRunStability` 同一份实现 —— 由调用方传进来，避免循环依赖。 */
  readonly computeStability: (
    prior: readonly CrossRunSample[],
    current: readonly CrossRunSample[],
    configKey: string
  ) => CrossRunReading
}): CrossRunAggregate {
  const { evalDir, currentRunId, currentSamples, configKey, computeStability } = options
  const runIds = existsSync(evalDir)
    ? readdirSync(evalDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('m6.1-wpinstr-'))
        .map((entry) => ({
          name: entry.name,
          mtimeMs: statSync(join(evalDir, entry.name)).mtimeMs,
        }))
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
        .map((entry) => entry.name)
    : []

  const priorSamples: CrossRunSample[] = []
  const perRun: PerRunSummary[] = []
  let failedSamples = 0

  for (const runId of runIds) {
    if (runId === currentRunId) continue // 历史**不含**本轮
    const evidencePath = join(evalDir, runId, 'instrument-live.json')
    if (!existsSync(evidencePath)) {
      perRun.push({ runId, samples: 0, failedSamples: 0, hasJudgedEvidence: false })
      continue
    }
    const { samples } = samplesFromRun(runId, evidencePath, evalDir)
    const partialPath = join(evalDir, runId, 'stability.partial.jsonl')
    let failed = 0
    if (existsSync(partialPath)) {
      for (const line of readFileSync(partialPath, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const record = JSON.parse(line) as { ok?: unknown }
        if (record.ok !== true) failed += 1
      }
    }
    failedSamples += failed
    priorSamples.push(...samples)
    perRun.push({
      runId,
      samples: samples.length,
      failedSamples: failed,
      hasJudgedEvidence: true,
    })
  }

  const current = currentSamples.filter((sample) => sample.configKey === configKey)
  const reading = computeStability(priorSamples, current, configKey)
  const runsWithEvidence = perRun.filter((entry) => entry.hasJudgedEvidence).length

  return {
    reading,
    configKeyOfCurrent: configKey,
    perRun,
    counters: {
      runsScanned: runIds.length,
      runsWithEvidence,
      runsWithoutEvidence: perRun.length - runsWithEvidence,
      successfulSamples: priorSamples.length + current.length,
      failedSamples,
    },
  }
}
