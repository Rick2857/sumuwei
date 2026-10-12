/**
 * M11 WP10 —— **语义评测（盲测 160 条 × 3 轮）**（`m11:semantic:eval`）。
 *
 * ============================================================================
 *  它量什么、不量什么（**先把口径写死，再看数字**）
 * ============================================================================
 * ```text
 * 量的是**模型这一格**：
 *   · 格式有效率（严格校验接受的比例）
 *   · **编造 handle 率**（模型引用了程序没给的 id —— 必须为 0）
 *   · **支持膨胀率**（模型声称的支持数 > 程序解析出的独立根数）
 *   · **反例漏报率**（金标有反例，而模型一条都没写）
 *   · 传输失败率（端点问题，不是模型的错，**单列**）
 * 也量**端到端判定**（程序侧，用**程序解析的根**，不是模型自报的）：
 *   · 决策一致率 · 采纳 precision · 拒收 recall · macro-F1
 * 不量：她的措辞好不好、读起来像不像她（那是人审，WP10 的人审材料）。
 * ```
 *
 * ============================================================================
 *  四条纪律
 * ============================================================================
 * ① **全分母**：480 次调用**全部**进分母；格式失败与传输失败都**算错**，不算"缺失"
 *    （`L-M11-15` 的教训：真实端点下格式失败是**常态之一**）。
 * ② **最差轮**：三轮里**最差**的那一轮与平均值**一起**报 —— 平均值会掩盖一轮崩掉。
 * ③ **语料冻结**：指纹与冻结值不符 ⇒ **拒绝运行**（看到输出之后改 labels 是禁止的）。
 * ④ **缺端点 ⇒ NOT RUN**（exit 2），**不是** FAIL，也不是 PASS。
 *
 * 用法：`pnpm m11:semantic:eval [--rounds=3] [--concurrency=6]`
 */

import 'dotenv/config'

import { config as loadTestEnv } from 'dotenv'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

loadTestEnv({ path: '.env.test', override: true })

import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  writeM11Manifest,
} from './m11-evidence.ts'
import {
  buildReflectionCorpus,
  REFLECTION_CORPUS_FAMILIES,
  REFLECTION_CORPUS_FAMILY_LABELS,
  type ReflectionCorpusFamily,
  type ReflectionCorpusItem,
} from '../evals/m11/reflection-corpus.ts'
import { createOpenAiReflectionDraftProvider } from '../src/infrastructure/model/openai-reflection.ts'
import { validateReflectionDraft } from '../src/kernel/contracts/reflection.ts'
import { meetsStabilityThreshold } from '../src/kernel/app/reflection/inputs.ts'
import type { ReflectionHandle } from '../src/kernel/contracts/reflection.ts'
import type { ReflectionWindowEntry } from '../src/kernel/contracts/reflection-input.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'

const REPO_ROOT = resolve(process.cwd())

/**
 * **冻结值**：语料一旦改动，指纹就变，本门直接拒绝（计划 §11.1）。
 *
 * ⚠️ 修订记录（**append-only**）：
 *   · `3ecfcbb9ab05dc9a`（第一代，2026-10-01 上午）—— 首轮盲测用的就是它。
 *   · `945ff576b9adaac7`（第二代，同日）—— 修 `L-M11-16`：`fact_confusion` 与
 *     `overreach_revision` 两族的**输入读数**补上各自的否决事实
 *     （`not_fact_authority` / `slot_out_of_scope`）。**金标一个字没改**，
 *     改的是"输入与金标不自洽"这件事。第一代的读数**保留**（缺陷代际并存）。
 */
const FROZEN_CORPUS_FINGERPRINT = '945ff576b9adaac7'

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

interface ItemReading {
  readonly caseId: string
  readonly family: ReflectionCorpusFamily
  readonly round: number
  readonly transportFailed: boolean
  readonly formatValid: boolean
  readonly reason: string | null
  readonly invented: readonly string[]
  readonly supportCount: number
  readonly programRootCount: number
  readonly counterCount: number
  readonly goldCounter: number
  readonly latencyMs: number
}

/** 把语料条目变成一次**真实**的模型调用（窗口 = 该条目的结构化读数） */
function callOf(item: ReflectionCorpusItem): ReflectionDraftCall {
  const rootCount = item.input.rootCount
  const ids = Array.from({ length: rootCount }, (_, index) => `ce:${item.caseId}:${String(index + 1)}`)
  const window: ReflectionWindowEntry[] = ids.map((id, index) => ({
    id,
    kind: 'conversation_event',
    revision: index + 1,
    sourceClass: (item.input.sourceKinds[index % item.input.sourceKinds.length] ??
      'user_statement') as ReflectionWindowEntry['sourceClass'],
    fromTrigger: true,
    text: index === 0 ? item.input.statement : `（同一簇里的另一条来源，第 ${String(index + 1)} 条）`,
  }))
  const handles: ReflectionHandle[] = ids.map((id) => ({ kind: 'conversation_event', id }))
  return {
    characterId: `char_${item.family}`,
    window,
    handles,
    counterHandles: item.input.hasCounterexample ? [handles[handles.length - 1]!] : [],
    triggerReasonCodes: item.input.sourceProblems.length > 0 ? [...item.input.sourceProblems] : ['explicit_correction'],
    deadlineMs: 20_000,
  }
}

/** 程序侧判定（**用程序解析的根**，不是模型自报的支持数） */
function programDecision(item: ReflectionCorpusItem): 'adopted' | 'not_adopted' {
  const stability = meetsStabilityThreshold({
    rootCount: item.input.rootCount,
    conversationCount: item.input.conversationCount,
    unresolvedConflict: item.input.unresolvedConflict,
  })
  return stability.met && item.input.sourceProblems.length === 0 ? 'adopted' : 'not_adopted'
}

async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
  return results
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let rounds = 3
  let concurrency = 6
  let limit = 0
  for (let i = 0; i < args.length; i += 1) {
    if (args[i]?.startsWith('--rounds=')) rounds = Number(args[i]!.slice('--rounds='.length))
    else if (args[i]?.startsWith('--concurrency=')) concurrency = Number(args[i]!.slice('--concurrency='.length))
    /*
     * ⚠️ `--limit` **只**用于"先验管道"的小跑（例如 6 条）：
     *    它会把分母改小 ⇒ 这种读数**不得**当作语义评测结论（证据档里记 `limit`）。
     */
    else if (args[i]?.startsWith('--limit=')) limit = Number(args[i]!.slice('--limit='.length))
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }

  // ① 端点检查（缺 ⇒ NOT RUN，不是 FAIL）
  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim()
  if (apiKey === '') {
    console.error('[m11:semantic:eval] NOT RUN：测试端点没有 key（`.env.test` 缺 OPENAI_API_KEY）')
    process.exit(2)
  }
  // ② 语料冻结检查（指纹不符 ⇒ 拒绝）
  const corpus = buildReflectionCorpus()
  const fingerprint = createHash('sha256').update(canonicalJson(corpus)).digest('hex')
  if (!fingerprint.startsWith(FROZEN_CORPUS_FINGERPRINT)) {
    console.error(
      `[m11:semantic:eval] 拒绝：语料指纹 ${fingerprint.slice(0, 16)} 与冻结值 ${FROZEN_CORPUS_FINGERPRINT} 不符`
    )
    process.exit(3)
  }
  const blindAll = corpus.filter((item) => item.split === 'blind')
  const blind = limit > 0 ? blindAll.slice(0, limit) : blindAll
  const provider = createOpenAiReflectionDraftProvider()
  const host = (() => {
    try {
      return new URL(process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com').host
    } catch {
      return '(无法解析)'
    }
  })()
  console.log(
    `[m11:semantic:eval] endpoint host=${host} · model=${(process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(缺省)'}` +
      ` · 盲测 ${String(blind.length)} 条 × ${String(rounds)} 轮 = **最多 ${String(blind.length * rounds)} 次**候选生成请求 · 并发 ${String(concurrency)}`
  )

  const startedAt = Date.now()
  const readings: ItemReading[] = []
  for (let round = 1; round <= rounds; round += 1) {
    const roundStartedAt = Date.now()
    const rows = await pool(blind, concurrency, async (item): Promise<ItemReading> => {
      const call = callOf(item)
      const at = Date.now()
      let raw: unknown
      let transportFailed = false
      try {
        raw = await provider.call(call)
      } catch (error) {
        transportFailed = true
        raw = error instanceof Error ? error.message : String(error)
      }
      const parsed = transportFailed
        ? { ok: false as const, reason: 'transport' as const }
        : validateReflectionDraft(raw, { handles: call.handles })
      const provided = new Set(call.handles.map((row) => row.id))
      const support = parsed.ok ? parsed.draft.supportHandles : []
      return {
        caseId: item.caseId,
        family: item.family,
        round,
        transportFailed,
        formatValid: parsed.ok,
        reason: parsed.ok ? null : String(parsed.reason),
        invented: support.filter((id) => !provided.has(id)),
        supportCount: support.length,
        programRootCount: item.input.rootCount,
        counterCount: parsed.ok ? parsed.draft.counterHandles.length : 0,
        goldCounter: item.gold.counterexamples,
        latencyMs: Date.now() - at,
      }
    })
    readings.push(...rows)
    const valid = rows.filter((row) => row.formatValid).length
    console.log(
      `  第 ${String(round)} 轮：格式有效 ${String(valid)}/${String(rows.length)} · 耗时 ${String(Date.now() - roundStartedAt)} ms`
    )
  }

  // -------------------------------------------------------------------------
  // 指标（**全分母**）
  // -------------------------------------------------------------------------
  const total = readings.length
  const byRound = (round: number): ItemReading[] => readings.filter((row) => row.round === round)
  const rate = (numerator: number, denominator: number): number =>
    denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4))
  /**
   * ⚠️ **分母为 0 时返回 `null`，不返回 0**。
   *
   * 干跑（6 条，全来自同一个家族）实测到：`拒收 recall` 的分母是 0，
   * 而第一版把它算成 **0** ⇒ 看起来像"判得极差"，其实是**什么都没量到**。
   * 这正是 §6.8「0 检查 / 0 失败 ≠ PASS」的同一类错：**不可判定必须与"判得差"分开**。
   */
  const rateOrNull = (numerator: number, denominator: number): number | null =>
    denominator === 0 ? null : Number((numerator / denominator).toFixed(4))

  const formatValid = readings.filter((row) => row.formatValid).length
  const transportFailed = readings.filter((row) => row.transportFailed).length
  const invented = readings.filter((row) => row.invented.length > 0).length
  const inflated = readings.filter(
    (row) => row.formatValid && row.supportCount > row.programRootCount
  ).length
  const counterOmitted = readings.filter(
    (row) => row.formatValid && row.goldCounter > 0 && row.counterCount === 0
  ).length

  const goldAdopt = readings.filter((row) => {
    const item = blind.find((candidate) => candidate.caseId === row.caseId)!
    return item.gold.shouldAdjust
  }).length
  const programAdopt = readings.filter((row) => {
    const item = blind.find((candidate) => candidate.caseId === row.caseId)!
    return programDecision(item) === 'adopted'
  }).length
  const truePositive = readings.filter((row) => {
    const item = blind.find((candidate) => candidate.caseId === row.caseId)!
    return item.gold.shouldAdjust && programDecision(item) === 'adopted'
  }).length
  const falsePositive = readings.filter((row) => {
    const item = blind.find((candidate) => candidate.caseId === row.caseId)!
    return !item.gold.shouldAdjust && programDecision(item) === 'adopted'
  }).length
  const falseNegative = readings.filter((row) => {
    const item = blind.find((candidate) => candidate.caseId === row.caseId)!
    return item.gold.shouldAdjust && programDecision(item) !== 'adopted'
  }).length
  const trueNegative = readings.filter((row) => {
    const item = blind.find((candidate) => candidate.caseId === row.caseId)!
    return !item.gold.shouldAdjust && programDecision(item) !== 'adopted'
  }).length

  const adoptionPrecision = rateOrNull(truePositive, truePositive + falsePositive)
  const rejectionRecall = rateOrNull(trueNegative, trueNegative + falsePositive)
  const macroF1 = (() => {
    const precisionAdopt = adoptionPrecision
    const recallAdopt = rateOrNull(truePositive, truePositive + falseNegative)
    const precisionReject = rejectionRecall
    const recallReject = rateOrNull(trueNegative, trueNegative + falseNegative)
    if (
      precisionAdopt === null ||
      recallAdopt === null ||
      precisionReject === null ||
      recallReject === null
    ) {
      return null
    }
    const f1Adopt =
      precisionAdopt + recallAdopt === 0 ? 0 : (2 * precisionAdopt * recallAdopt) / (precisionAdopt + recallAdopt)
    const f1Reject =
      precisionReject + recallReject === 0 ? 0 : (2 * precisionReject * recallReject) / (precisionReject + recallReject)
    return Number(((f1Adopt + f1Reject) / 2).toFixed(4))
  })()

  const perRoundFormat = Array.from({ length: rounds }, (_, index) =>
    rate(byRound(index + 1).filter((row) => row.formatValid).length, byRound(index + 1).length)
  )
  const perFamily = Object.fromEntries(
    REFLECTION_CORPUS_FAMILIES.map((family) => {
      const rows = readings.filter((row) => row.family === family)
      return [
        family,
        {
          label: REFLECTION_CORPUS_FAMILY_LABELS[family],
          n: rows.length,
          formatValidRate: rate(rows.filter((row) => row.formatValid).length, rows.length),
          inventedCount: rows.filter((row) => row.invented.length > 0).length,
        },
      ]
    })
  )
  const latencies = readings.map((row) => row.latencyMs).sort((a, b) => a - b)
  const p = (q: number): number => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0

  const metrics = {
    requests: total,
    rounds,
    concurrency,
    formatValidRate: rate(formatValid, total),
    formatFailureRate: rate(total - formatValid, total),
    transportFailureRate: rate(transportFailed, total),
    inventedHandleRate: rate(invented, total),
    supportInflationRate: rate(inflated, total),
    counterOmissionRate: rate(counterOmitted, total),
    adoptionPrecision,
    rejectionRecall,
    macroF1,
    decisionAgreement: rate(truePositive + trueNegative, total),
    undefinedMetrics: {
      adoptionPrecision: adoptionPrecision === null,
      rejectionRecall: rejectionRecall === null,
      macroF1: macroF1 === null,
    },
    confusion: { truePositive, falsePositive, trueNegative, falseNegative, goldAdopt, programAdopt },
    perRoundFormatValidRate: perRoundFormat,
    worstRoundFormatValidRate: Math.min(...perRoundFormat),
    latencyMs: { p50: p(0.5), p95: p(0.95), max: latencies[latencies.length - 1] ?? 0 },
    wallClockMs: Date.now() - startedAt,
  }

  // -------------------------------------------------------------------------
  // 判据（**跑之前写下的**；缺端点时根本不走到这里）
  // -------------------------------------------------------------------------
  const checks = [
    {
      id: 'E1',
      label: '【全分母】请求数 = 盲测条数 × 轮数（没有"跳过失败项"）',
      pass: total === blind.length * rounds,
      detail: `requests=${String(total)} · 期望=${String(blind.length * rounds)}`,
    },
    {
      id: 'E2',
      label: '【不编造】编造 handle 率 = **0**（`D14`/`D31`：模型只能引用程序给的 id）',
      pass: invented === 0,
      detail: `编造项=${String(invented)} · 率=${String(metrics.inventedHandleRate)}`,
    },
    {
      id: 'E3',
      label: '【格式】格式有效率 ≥ 0.90（`L-M11-15` 已登记真实端点会偶发非 JSON；门槛**跑之前**定下）',
      pass: metrics.formatValidRate >= 0.9,
      detail: `格式有效=${String(metrics.formatValidRate)} · 失败=${String(metrics.formatFailureRate)} · 最差轮=${String(metrics.worstRoundFormatValidRate)}`,
    },
    {
      id: 'E4',
      label: '【不膨胀】支持膨胀率 ≤ 0.10（模型声称的支持数不得超过程序解析的独立根数）',
      pass: metrics.supportInflationRate <= 0.1,
      detail: `膨胀=${String(metrics.supportInflationRate)}`,
    },
    {
      id: 'E5',
      label: '【反例】反例漏报率 ≤ 0.30（金标有反例而模型一条都没写）',
      pass: metrics.counterOmissionRate <= 0.3,
      detail: `漏报=${String(metrics.counterOmissionRate)}`,
    },
    {
      id: 'E6',
      label:
        '【端到端】采纳 precision ≥ 0.90 且 拒收 recall ≥ 0.90（用**程序解析的根**判定）；' +
        '⚠️ 任一子指标**分母为 0** ⇒ 判 **不可判定**（不是 PASS，也不是 FAIL）',
      pass:
        adoptionPrecision !== null &&
        rejectionRecall !== null &&
        adoptionPrecision >= 0.9 &&
        rejectionRecall >= 0.9,
      detail:
        adoptionPrecision === null || rejectionRecall === null
          ? `**不可判定**（分母为 0：TP=${String(truePositive)} FP=${String(falsePositive)} TN=${String(trueNegative)} FN=${String(falseNegative)}）`
          : `precision=${String(adoptionPrecision)} · recall=${String(rejectionRecall)} · macroF1=${String(macroF1)} · 混淆=${JSON.stringify({ truePositive, falsePositive, trueNegative, falseNegative })}`,
    },
    {
      id: 'E7',
      label: '【传输单列】传输失败率 ≤ 0.05（端点问题**不**与模型的错混算）',
      pass: metrics.transportFailureRate <= 0.05,
      detail: `传输失败=${String(metrics.transportFailureRate)} · p95=${String(metrics.latencyMs.p95)} ms`,
    },
    {
      id: 'E8',
      label: '【最差轮】三轮里最差的一轮也要报（平均值会掩盖一轮崩掉）',
      pass: perRoundFormat.length === rounds,
      detail: `各轮格式率=${JSON.stringify(perRoundFormat)}`,
    },
  ]
  const failed = checks.filter((check) => !check.pass)

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'wp10-semantic', headShort: head })
  const dir = openM11RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm11-semantic-eval@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    endpointHost: host,
    model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(default)',
    credentialSource: '.env.test',
    corpusFingerprint: fingerprint,
    frozenCorpusFingerprint: FROZEN_CORPUS_FINGERPRINT,
    blindCount: blind.length,
    blindTotal: blindAll.length,
    limitApplied: limit,
    isFullRun: limit === 0,
    metrics,
    perFamily,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    readings,
  }
  writeFileSync(join(dir, 'semantic-eval.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp10-semantic',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'semantic-eval',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: `m11:semantic:eval（盲测 ${String(blind.length)}×${String(rounds)} · 真实端点 ${host} · 全分母）`,
  })

  console.log(`runId: ${runId}`)
  console.log(`metrics: ${JSON.stringify(metrics, null, 2)}`)
  for (const check of checks) console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:semantic:eval 抛错：', error)
  process.exit(1)
})
