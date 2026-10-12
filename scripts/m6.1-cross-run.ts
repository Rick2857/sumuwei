/**
 * M6.1 WP2 —— **跨轮稳定性读数**（`pnpm m6.1:cross-run:verify`，CD-9）。
 *
 * ============================================================================
 *  它回答的问题
 * ============================================================================
 *  「**逐字相同的探针项，在不同轮次之间给出的是同一个判定吗**」
 *
 *  CD-8 只测轮内重复性；§11.3 记下的边界是：真正的缺陷是**跨轮漂移**
 *  （`…-68e0` 与 `…-9f89` 里 ab 对**都已成功判成**却给出不同标签）。
 *  本门把那一层补上。
 *
 * ============================================================================
 *  它**不需要任何模型调用**
 * ============================================================================
 * 每一轮的真实读数里**本来就有**探针采样。本门把**已经落盘**的历轮采样聚合起来比，
 * 因此它**不新增出站、不新增成本** —— 这也意味着它可以在任何时候重跑，读数稳定。
 *
 *  比对合法性：只有 `configKey` 相同的采样才允许互相比较
 *  （提示版本 + 判定器 id/host/model + 探针集版本）。
 *  不同配置的样本**不合并**，但会被**计数并报出**（`excludedByConfig`）。
 *
 * ============================================================================
 *  它不主张什么
 * ============================================================================
 * ```text
 * · 第一轮必然判 INVALID（没有历史可比）—— 这是**正确的失败关闭**：
 *   单轮读数在原理上无法证明可复现性。
 * · 本门只覆盖**探针项**，不覆盖全部 68 条语料 —— 它是"抽检"，不是全覆盖。
 * · 它不改变任何判定标准，只把已经观察到的性质变成机器判据。
 * ```
 *
 * 用法：
 *   pnpm m6.1:cross-run:verify
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { MeasurementInvalidError } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  M6_1_CONTRACT_VERSION,
  M6_1_CORPUS_VERSION,
  M6_1_INSTRUMENT_VERSION,
} from './m6.1-contract.ts'
import {
  PROBE_SET_VERSION,
  aggregateCrossRun,
  crossRunConfigKey,
  samplesFromRun,
  type RecordedJudgeConfig,
} from './m6.1-cross-run-core.ts'
import {
  INSTRUMENT_VALIDITY_CRITERIA,
  M6_1_JUDGE_PROMPT_VERSION,
  computeCrossRunStability,
  evaluateCrossRun,
  type CrossRunSample,
} from './m6.1-instrument.ts'

const ROOT = resolve(process.cwd())
const EVAL_DIR = join(ROOT, 'artifacts', 'm6.1')

/**
 * 由**证据里记的**配置拼出比较键（键格式只在 `m6.1-instrument.ts` 定义一次）。
 * 返回 `null` = 那一轮没记全配置 ⇒ 不参与比对。
 */
function configKeyFromJudge(judge: RecordedJudgeConfig): string | null {
  return crossRunConfigKey(judge, PROBE_SET_VERSION)
}

function main(): void {
  const startedAt = new Date().toISOString()
  if (!existsSync(EVAL_DIR)) {
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：证据目录不存在 ${EVAL_DIR}`)
  }

  /*
   * ⚠️ **按时间排序，不按名字排序**。
   *
   * runId 里嵌的是候选短 hash（`…-88564e96121c-3196` / `…-b972ca6a3621-f49e`），
   * 所以字典序**不等于**时间序：`88564e…` 排在 `b972ca…` 前面，可它其实是**更晚**的一轮。
   * 第一版用 `.sort()` ⇒ "本轮"被错认成较早的那一轮。读数方向不影响判定
   * （比对是对称的），但**标签错了** —— 而"数字对、描述的却不是你以为的那个东西"
   * 正是本仓库反复登记的那类缺陷。
   */
  const runIds = readdirSync(EVAL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('m6.1-wpinstr-'))
    .map((entry) => ({
      name: entry.name,
      mtimeMs: statSync(join(EVAL_DIR, entry.name)).mtimeMs,
      hasEvidence: existsSync(join(EVAL_DIR, entry.name, 'instrument-live.json')),
    }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)

  const all: CrossRunSample[] = []
  const perRun: {
    runId: string
    samples: number
    failedSamples: number
    hasConfig: boolean
    hasJudgedEvidence: boolean
  }[] = []

  for (const entry of runIds) {
    const runId = entry.name
    const evidencePath = join(EVAL_DIR, runId, 'instrument-live.json')
    if (!entry.hasEvidence) {
      // 被杀掉的轮次（只有断点、没有读数）—— 如实记 NOT RUN，不当读数
      perRun.push({
        runId,
        samples: 0,
        failedSamples: 0,
        hasConfig: false,
        hasJudgedEvidence: false,
      })
      continue
    }
    const { samples } = samplesFromRun(runId, evidencePath, EVAL_DIR)
    const partialPath = join(EVAL_DIR, runId, 'stability.partial.jsonl')
    let failed = 0
    if (existsSync(partialPath)) {
      for (const line of readFileSync(partialPath, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const record = JSON.parse(line) as { ok?: unknown }
        if (record.ok !== true) failed += 1
      }
    }
    all.push(...samples)
    perRun.push({
      runId,
      samples: samples.length,
      failedSamples: failed,
      hasConfig: samples.length > 0,
      hasJudgedEvidence: true,
    })
  }

  if (all.length === 0) {
    throw new MeasurementInvalidError(
      'MEASUREMENT INVALID：历轮里一条**成功**的探针采样都没有 ⇒ 跨轮稳定性无从谈起'
    )
  }

  /*
   * 以**最新一轮**为"本轮"，其余轮次为历史 —— 这样 CD-9 判的就是
   * "最新一次运行与之前所有运行是否一致"。没有任何一轮会被丢掉。
   */
  const judgedRuns = perRun.filter((entry) => entry.hasJudgedEvidence)
  const latest = judgedRuns.at(-1)
  if (latest === undefined) {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：没有任何一轮有可用读数')
  }
  const currentSamples = all.filter((sample) => sample.runId === latest.runId)
  const priorSamples = all.filter((sample) => sample.runId !== latest.runId)

  const configKeyOfCurrent =
    currentSamples[0]?.configKey ?? fromEvidence(latest.runId)
  const reading = computeCrossRunStability(priorSamples, currentSamples, configKeyOfCurrent)

  /** 只用一句判据来给出 verdict —— CD-9 的判据是**独立纯函数**，不必伪造语料度量。 */
  const crossReasons = evaluateCrossRun(reading, INSTRUMENT_VALIDITY_CRITERIA)

  const verdict =
    reading.priorItems < INSTRUMENT_VALIDITY_CRITERIA.minCrossRunItems
      ? 'INCONCLUSIVE'
      : crossReasons.length === 0
        ? 'PASS'
        : 'FAIL'

  const evidence = {
    schemaVersion: 'm6.1-cross-run@1',
    testId: 'M6.1 / CD-9 跨轮稳定性（**零模型调用**：只聚合已落盘的历轮探针采样）',
    scope:
      '以最新一轮为"本轮"、其余全部轮次为历史，比对**逐字相同**的探针项的判定标签集合是否跨轮一致',
    verdict,
    startedAt,
    finishedAt: new Date().toISOString(),
    configKey: configKeyOfCurrent,
    reading,
    reasons: crossReasons,
    perRun,
    counters: {
      runsScanned: runIds.length,
      runsWithEvidence: judgedRuns.length,
      runsWithoutEvidence: perRun.filter((entry) => !entry.hasJudgedEvidence).length,
      successfulSamples: all.length,
      failedSamples: perRun.reduce((sum, entry) => sum + entry.failedSamples, 0),
      priorItems: reading.priorItems,
      comparedItems: reading.comparedItems,
      agreeingItems: reading.agreeingItems,
      disagreements: reading.disagreements.length,
      excludedByConfig: reading.excludedByConfig,
    },
    criteria: {
      requireCrossRunStability: INSTRUMENT_VALIDITY_CRITERIA.requireCrossRunStability,
      minCrossRunItems: INSTRUMENT_VALIDITY_CRITERIA.minCrossRunItems,
      minCrossRunRate: INSTRUMENT_VALIDITY_CRITERIA.minCrossRunRate,
    },
    versions: {
      contract: M6_1_CONTRACT_VERSION,
      corpus: M6_1_CORPUS_VERSION,
      instrument: M6_1_INSTRUMENT_VERSION,
      prompt: M6_1_JUDGE_PROMPT_VERSION,
      probeSet: PROBE_SET_VERSION,
    },
    notProven: [
      '本门只覆盖**探针项**（6 项），不覆盖全部 68 条语料 —— 是抽检，不是全覆盖。',
      '失败采样不进比对（它们是"没测到"），因此传输层不稳时本门的分母会缩小；' +
        '分母缩到 0 会判 INCONCLUSIVE，不会判通过。',
      '本门不改变任何判定标准，也不替代语义侧的召回/误报读数。',
    ],
  }

  mkdirSync(EVAL_DIR, { recursive: true })
  writeFileSync(
    join(EVAL_DIR, 'cross-run.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8'
  )

  console.log('='.repeat(78))
  console.log('M6.1 CD-9 跨轮稳定性（零模型调用；聚合已落盘采样）')
  console.log('='.repeat(78))
  console.log(`  轮次扫描    ${String(runIds.length)} 个目录（有读数 ${String(judgedRuns.length)}）`)
  console.log(
    `  成功采样    ${String(all.length)} 条（失败 ${String(evidence.counters.failedSamples)} 条，不进比对）`
  )
  console.log(`  配置键      ${configKeyOfCurrent}`)
  console.log(`  排除（配置不同）${String(reading.excludedByConfig)} 条`)
  console.log(
    `  本轮        ${latest.runId}（${String(currentSamples.length)} 条采样）`
  )
  console.log(
    `  跨轮比对    有历史 ${String(reading.priorItems)} 项 · 比过 ${String(reading.comparedItems)} 项 · 一致 ${String(reading.agreeingItems)} 项 · rate=${String(reading.rate)}`
  )
  console.log(`  本轮缺测    ${String(reading.missingInCurrent)} 项（有历史但本轮没测到）`)
  for (const entry of reading.disagreements) {
    console.log(`  ❌ ${entry.itemId} 在 ${String(entry.runIds.length)} 轮里见过 ${String(entry.observed.length)} 种标签集合：`)
    for (const observed of entry.observed) {
      console.log(`       ${observed === '' ? '(空)' : observed}`)
    }
  }
  console.log(`\n  **verdict = ${verdict}**`)
  for (const reason of crossReasons) {
    console.log(`    ${reason.code} :: ${reason.detail}`)
  }
  console.log('  证据：artifacts/m6.1/cross-run.json')
  process.exit(verdict === 'PASS' ? 0 : 2)
}

/**
 * 兜底：从读数里取配置键（断点缺失时用）。
 *
 * ⚠️ 配置记不全时返回 `(no-config)` —— 这个字符串**不可能**等于任何真实键，
 *    于是全部采样都会被 `excludedByConfig` 排除、`priorItems` 归零 ⇒
 *    判 `INCONCLUSIVE`。**不**判通过：缺配置是"没测到"，不是"测到了且一致"。
 */
function fromEvidence(runId: string): string {
  const evidencePath = join(EVAL_DIR, runId, 'instrument-live.json')
  const parsed = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
    judge?: RecordedJudgeConfig
  }
  return configKeyFromJudge(parsed.judge ?? {}) ?? '(no-config)'
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6.1-cross-run] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6.1-cross-run] 这是 MEASUREMENT INVALID，不是 PASS')
  }
  process.exit(2)
}
