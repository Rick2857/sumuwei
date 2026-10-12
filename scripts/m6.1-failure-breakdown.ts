/**
 * M6.1 —— **调用失败的离线拆解**（只读；不调用模型、不写任何证据目录）。
 *
 * ============================================================================
 *  它回答的问题
 * ============================================================================
 * 「两轮全量读数里的失败，到底发生在**哪一阶段**、具体是**哪个原因**。」
 * 这是用户 2026-09-23 工作单的第 1 项：在动任何修复之前，先把失败分开：
 *
 * ```text
 *   network_http   网络 / HTTP 层    （rate_limited · timeout · network · http_error · no_api_key）
 *   output_budget  输出预算耗尽      （truncated：finish_reason = length 且 content 为空）
 *   parse          解析 / 输出形状    （empty · not_json · shape · unknown_label · contradictory_labels
 *                                     · bad_shape · empty_content）
 *   semantic       语义矛盾          （unresolved：两次采样给出不同标签集合）
 *   ok             判成
 * ```
 *
 * ============================================================================
 *  两条纪律
 * ============================================================================
 * ```text
 *   ① **缺失就写「未记录」**，不推断、不填默认值。
 *      早期读数没有逐次尝试日志（`attemptLog`），也没有 token 用量（`usage`）——
 *      那就如实写 null 并在报告里点名，绝不拿相邻字段猜。
 *   ② 计数必须与**代码算出的权威指标**对账（metrics.*）。
 *      对不上 ⇒ MEASUREMENT INVALID 退出（"检查了 0 项、发现 0 处"与"全都一致"长得一样，
 *      本仓库已经因此吃过一次亏）。
 * ```
 *
 * 用法：
 * ```bash
 * pnpm m6.1:failures                          # 默认拆解**最新两轮**有读数的 wpinstr 轮次
 * pnpm m6.1:failures -- --run <runId> --run <runId>
 * ```
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { MeasurementInvalidError } from '../src/infrastructure/persistence/production-db-safety.ts'

const ROOT = resolve(process.cwd())
const EVAL_DIR = join(ROOT, 'artifacts', 'm6.1')
const OUT_PATH = join(EVAL_DIR, 'failure-breakdown.json')

/** 失败阶段（用户工作单点名的四类 + ok）。 */
type Stage = 'ok' | 'network_http' | 'output_budget' | 'parse' | 'semantic'

const NETWORK_HTTP_CODES = new Set([
  'rate_limited',
  'timeout',
  'network',
  'http_error',
  'no_api_key',
])
const OUTPUT_BUDGET_CODES = new Set(['truncated'])
const PARSE_CODES = new Set([
  'empty',
  'not_json',
  'shape',
  'unknown_label',
  'contradictory_labels',
  'bad_shape',
  'empty_content',
])

interface ObservationRecord {
  readonly itemId: string
  readonly category: string
  readonly ok: boolean
  readonly callFailure: string | null
  readonly parseFailure: string | null
  readonly finishReason?: string | null
  readonly httpStatus?: number | null
  readonly rawLength?: number
  readonly attempts?: number
  readonly durationMs?: number
  readonly usage?: unknown
  readonly attemptLog?: unknown
  readonly readings?: readonly (readonly string[])[]
  readonly expectedLabels?: readonly string[]
  readonly expectedAlert?: boolean
}

function stageOf(record: ObservationRecord): Stage {
  if (record.ok) return 'ok'
  /*
   * ⚠️ 先看 `callFailure`（**尝试级**的码），再看 `parseFailure`。
   * 反过来会把 `truncated` 这类尝试级失败错落到 parse 桶里 —— 而 `parseFailure`
   * 在实现里就是"这次读数没成立的那个码"，两者会重合。
   */
  const callCode = record.callFailure
  if (callCode !== null && callCode !== undefined) {
    if (OUTPUT_BUDGET_CODES.has(callCode)) return 'output_budget'
    if (NETWORK_HTTP_CODES.has(callCode)) return 'network_http'
    if (PARSE_CODES.has(callCode)) return 'parse'
    return 'parse'
  }
  const parseCode = record.parseFailure
  if (parseCode === 'unresolved') return 'semantic'
  if (parseCode === null || parseCode === undefined) return 'semantic'
  if (PARSE_CODES.has(parseCode)) return 'parse'
  return 'parse'
}

interface RunBreakdown {
  readonly runId: string
  readonly evidencePath: string
  readonly promptVersion: string | null
  readonly promptDigestPrefix: string | null
  readonly verdict: string | null
  readonly declared: number
  readonly stages: Record<Stage, number>
  readonly codes: Record<string, number>
  readonly finishReasons: Record<string, number>
  readonly attemptHistogram: Record<string, number>
  readonly usageRecorded: boolean
  readonly attemptLogRecorded: boolean
  readonly notRecorded: string[]
  readonly failedItems: {
    itemId: string
    category: string
    stage: Stage
    code: string
    finishReason: string | null
    httpStatus: number | null
    rawLength: number | null
    attempts: number | null
    durationMs: number | null
    usage: unknown
    expectedLabels: string[]
    readings: string[][]
  }[]
}

function parseRunIds(argv: readonly string[]): string[] {
  const ids: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--run') continue
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new Error(`--run 后面必须是一个 runId（收到 ${String(value)}）`)
    }
    ids.push(value)
    index += 1
  }
  return ids
}

/**
 * 默认取**最新两轮全量读数**（按目录 mtime，不按 runId 字典序 —— 字典序 ≠ 时间序）。
 *
 * ⚠️ 必须筛 `scope.mode === 'full'`（实测逼出来的）：
 * 第一版只按 mtime 取"最新两轮"，于是在跑过 `--only` 小实验之后，
 * 默认拆解**静默换成了那两条 1 条 / 3 条目的诊断档**，把两轮全量的失败分布挤掉了
 * （文件从 759 行掉到 12 行，而脚本一声不吭）。"默认值悄悄改了它量的是什么"
 * 正是本仓库反复登记的那类缺陷 ⇒ 现在只认全量轮，并把选中了哪两轮**打印出来**。
 */
function latestRuns(count: number): string[] {
  if (!existsSync(EVAL_DIR)) throw new MeasurementInvalidError(`MEASUREMENT INVALID：缺目录 ${EVAL_DIR}`)
  const candidates = readdirSync(EVAL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('m6.1-wpinstr-'))
    .map((entry) => {
      const evidencePath = join(EVAL_DIR, entry.name, 'instrument-live.json')
      let scopeMode: string | null = null
      if (existsSync(evidencePath)) {
        try {
          const parsed = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
            scope?: { mode?: string }
          }
          scopeMode = parsed.scope?.mode ?? null
        } catch {
          scopeMode = null
        }
      }
      return {
        name: entry.name,
        mtimeMs: statSync(join(EVAL_DIR, entry.name)).mtimeMs,
        hasEvidence: existsSync(evidencePath),
        scopeMode,
      }
    })
    .filter((entry) => entry.hasEvidence && entry.scopeMode === 'full')
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(-count)
    .map((entry) => entry.name)
  if (candidates.length === 0) {
    throw new MeasurementInvalidError(
      'MEASUREMENT INVALID：找不到任何**全量**（scope.mode=full）读数 ⇒ 默认拆解无从谈起；' +
        '要拆解诊断档请显式 --run <runId>（默认**不**会把 --limit/--only 的轮次当成全量）'
    )
  }
  return candidates
}

function breakdownOf(runId: string): RunBreakdown {
  const evidencePath = join(EVAL_DIR, runId, 'instrument-live.json')
  if (!existsSync(evidencePath)) {
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：缺读数 ${evidencePath}`)
  }
  const parsed = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
    judge?: { promptVersion?: string; promptDigest?: string }
    verdict?: string
    observations?: ObservationRecord[]
    metrics?: {
      declared?: number
      parseFailures?: number
      unresolved?: number
      undecidableByReason?: Record<string, number>
      denominators?: { declared?: number }
    }
  }
  const observations = parsed.observations ?? []
  if (observations.length === 0) {
    throw new MeasurementInvalidError(
      `MEASUREMENT INVALID：${runId} 的 observations 有 0 条 ⇒ 拆解无从谈起`
    )
  }

  const stages: Record<Stage, number> = {
    ok: 0,
    network_http: 0,
    output_budget: 0,
    parse: 0,
    semantic: 0,
  }
  const codes: Record<string, number> = {}
  const finishReasons: Record<string, number> = {}
  const attemptHistogram: Record<string, number> = {}
  const failedItems: RunBreakdown['failedItems'] = []
  let usageRecorded = false
  let attemptLogRecorded = false

  for (const record of observations) {
    const stage = stageOf(record)
    stages[stage] += 1
    if (stage !== 'ok') {
      const code = String(record.callFailure ?? record.parseFailure ?? '(未记录)')
      codes[code] = (codes[code] ?? 0) + 1
    }
    const finish = record.finishReason ?? null
    const finishKey = finish === null ? '(未记录)' : finish
    finishReasons[finishKey] = (finishReasons[finishKey] ?? 0) + 1
    const attempts = record.attempts ?? null
    const attemptKey = attempts === null ? '(未记录)' : String(attempts)
    attemptHistogram[attemptKey] = (attemptHistogram[attemptKey] ?? 0) + 1
    if (record.usage !== undefined && record.usage !== null) usageRecorded = true
    if (Array.isArray(record.attemptLog) && record.attemptLog.length > 0) attemptLogRecorded = true
    if (stage === 'ok') continue
    failedItems.push({
      itemId: record.itemId,
      category: record.category,
      stage,
      code: String(record.callFailure ?? record.parseFailure ?? '(未记录)'),
      finishReason: finish,
      httpStatus: record.httpStatus ?? null,
      rawLength: record.rawLength ?? null,
      attempts,
      durationMs: record.durationMs ?? null,
      usage: record.usage ?? null,
      expectedLabels: [...(record.expectedLabels ?? [])],
      readings: (record.readings ?? []).map((entry) => [...entry]),
    })
  }

  /*
   * ---- 与权威指标对账（对不上就是 MEASUREMENT INVALID）----
   *
   * 这些等式来自实现本身：
   *   declared              = observations.length
   *   parseFailures         = 非 ok 且不是 unresolved 的条目数
   *   unresolved            = 非 ok 且 parseFailure === 'unresolved'
   *   undecidableByReason   = { call_failure: 非 ok 且非 unresolved, sampling_disagreement: unresolved }
   *   各阶段之和             = declared
   */
  const metrics = parsed.metrics ?? {}
  const declared = metrics.denominators?.declared ?? metrics.declared ?? null
  const unresolvedCount = failedItems.filter((entry) => entry.code === 'unresolved').length
  const parseFailureCount = failedItems.length - unresolvedCount
  const sumStages = Object.values(stages).reduce((sum, value) => sum + value, 0)
  const mismatches: string[] = []
  if (declared !== null && declared !== observations.length) {
    mismatches.push(`declared ${String(declared)} ≠ observations ${String(observations.length)}`)
  }
  if (sumStages !== observations.length) {
    mismatches.push(`阶段之和 ${String(sumStages)} ≠ observations ${String(observations.length)}`)
  }
  if (metrics.parseFailures !== undefined && metrics.parseFailures !== parseFailureCount) {
    mismatches.push(
      `parseFailures ${String(metrics.parseFailures)} ≠ 拆解算出的 ${String(parseFailureCount)}`
    )
  }
  if (metrics.unresolved !== undefined && metrics.unresolved !== unresolvedCount) {
    mismatches.push(`unresolved ${String(metrics.unresolved)} ≠ 拆解算出的 ${String(unresolvedCount)}`)
  }
  const reasonCounts = metrics.undecidableByReason ?? {}
  const callFailureReason = reasonCounts.call_failure ?? 0
  const disagreementReason = reasonCounts.sampling_disagreement ?? 0
  if (callFailureReason !== parseFailureCount) {
    mismatches.push(
      `undecidableByReason.call_failure ${String(callFailureReason)} ≠ 拆解算出的 ${String(parseFailureCount)}`
    )
  }
  if (disagreementReason !== unresolvedCount) {
    mismatches.push(
      `undecidableByReason.sampling_disagreement ${String(disagreementReason)} ≠ 拆解算出的 ${String(unresolvedCount)}`
    )
  }
  if (mismatches.length > 0) {
    throw new MeasurementInvalidError(
      `MEASUREMENT INVALID：${runId} 的拆解与权威指标对不上 —— ${mismatches.join('；')}`
    )
  }

  const notRecorded: string[] = []
  if (!usageRecorded) notRecorded.push('token 用量（usage）：该轮判定器未采集 ⇒ **未记录**')
  if (!attemptLogRecorded) {
    notRecorded.push(
      '逐次尝试明细（attemptLog）：该轮未采集 ⇒ **未记录**；' +
        '因此"哪一次因为什么失败"以及"内部重试了几次"只能从 attempts 与采样数推出，**不是记录**'
    )
  }

  return {
    runId,
    evidencePath: relative(ROOT, evidencePath).split(/[\\/]/).join('/'),
    promptVersion: parsed.judge?.promptVersion ?? null,
    promptDigestPrefix: parsed.judge?.promptDigest?.slice(0, 12) ?? null,
    verdict: parsed.verdict ?? null,
    declared: observations.length,
    stages,
    codes,
    finishReasons,
    attemptHistogram,
    usageRecorded,
    attemptLogRecorded,
    notRecorded,
    failedItems,
  }
}

function main(): void {
  const startedAt = new Date().toISOString()
  const requested = parseRunIds(process.argv.slice(2))
  const runIds = requested.length > 0 ? requested : latestRuns(2)
  if (runIds.length === 0) {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：没有任何轮次可拆解')
  }
  const runs = runIds.map(breakdownOf)

  const evidence = {
    schemaVersion: 'm6.1-failure-breakdown@1',
    testId: 'M6.1 调用失败的离线拆解（只读；不调用模型、不写任何读数目录）',
    scope:
      '把每一轮的失败按**阶段**分开（network_http / output_budget / parse / semantic），' +
      '并逐条列出原因、finish_reason、HTTP 状态、长度、尝试次数、耗时；' +
      '缺失字段一律记 null 并在 notRecorded 里点名，**不推断**。',
    startedAt,
    finishedAt: new Date().toISOString(),
    stageRule: {
      network_http: [...NETWORK_HTTP_CODES],
      output_budget: [...OUTPUT_BUDGET_CODES],
      parse: [...PARSE_CODES],
      semantic: ['unresolved'],
      precedence: '先看尝试级 callFailure，再看 parseFailure（两者会重合，顺序反了就错桶）',
    },
    runs,
    crossChecked: '各轮计数已与 metrics.parseFailures / unresolved / undecidableByReason 对账通过',
  }

  const text = `${JSON.stringify(evidence, null, 2)}\n`
  writeFileSync(OUT_PATH, text, 'utf8')

  console.log('='.repeat(78))
  console.log('M6.1 调用失败拆解（离线只读）')
  console.log('='.repeat(78))
  console.log(`拆解轮次（${requested.length > 0 ? '显式 --run' : '默认：最新全量轮'}）：${runIds.join(' · ')}`)
  for (const run of runs) {
    console.log(`\n轮次 ${run.runId}  （${run.promptVersion ?? '(未记录)'}#${run.promptDigestPrefix ?? '??'}）`)
    console.log(`  verdict=${String(run.verdict)}  声明条目=${String(run.declared)}`)
    console.log(
      `  阶段      ok ${String(run.stages.ok)} · 网络/HTTP ${String(run.stages.network_http)} · ` +
        `输出预算 ${String(run.stages.output_budget)} · 解析 ${String(run.stages.parse)} · ` +
        `语义 ${String(run.stages.semantic)}`
    )
    console.log(`  原因码    ${JSON.stringify(run.codes)}`)
    console.log(`  finish    ${JSON.stringify(run.finishReasons)}`)
    console.log(`  尝试次数  ${JSON.stringify(run.attemptHistogram)}`)
    console.log(`  token 用量 ${run.usageRecorded ? '已记录' : '**未记录**'}`)
    for (const note of run.notRecorded) console.log(`  ⚠️ ${note}`)
    console.log('  失败条目（逐条）：')
    for (const entry of run.failedItems) {
      console.log(
        `    ${entry.itemId.padEnd(15)} ${entry.stage.padEnd(14)} ${entry.code.padEnd(16)} ` +
          `finish=${String(entry.finishReason ?? '(未记录)')} http=${String(entry.httpStatus ?? '(未记录)')} ` +
          `len=${String(entry.rawLength ?? '(未记录)')} tries=${String(entry.attempts ?? '(未记录)')} ` +
          `ms=${String(entry.durationMs ?? '(未记录)')} usage=${entry.usage === null ? '(未记录)' : JSON.stringify(entry.usage)}`
      )
      console.log(
        `       期望=${entry.expectedLabels.join('+') || '(空)'}  采样=${
          entry.readings.map((set) => `[${set.join('+')}]`).join(' vs ') || '(无成功采样)'
        }`
      )
    }
  }
  console.log(`\n证据：${relative(ROOT, OUT_PATH).split(/[\\/]/).join('/')}`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6.1-failures] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6.1-failures] 这是 MEASUREMENT INVALID，不是"没问题"')
  }
  process.exit(2)
}
