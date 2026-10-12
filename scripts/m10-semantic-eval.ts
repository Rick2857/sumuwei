/**
 * M10 WP10 —— **语义评估**（`pnpm m10:semantic:eval`）。**真模型档**（计划 §16.1）。
 *
 * ============================================================================
 *  它量什么、不量什么
 * ============================================================================
 * ```text
 * 量    ：**冻结语料的意图理解** —— 拿真模型把每条原话（+ 程序给定的结构化候选）
 *         读成闭集里的一个操作，与金标逐案比对。
 * 不量  ：真实链（那是 `m10:smoke:live` / `m10:long:live` 的事）、
 *         也不量"她答得对不对"（理解层只产出结论，回复组装在别处）。
 * ```
 *
 * ============================================================================
 *  四条硬纪律（每条都有来历）
 * ============================================================================
 * ```text
 * ① **守卫：绝不回落生产 key**。没有 `DSH_TEST_MODEL_WRAPPER` 标记 ⇒ **拒跑**（exit 2）。
 *    本门会**真的出站**，而 `import 'dotenv/config'` 会把 `.env` 的**生产 key** 读进来 ——
 *    "以为在跑测试、其实在烧生产 key"是这里最坏的失败模式（与 m6/m9 的 live 门同一条纪律）。
 *
 * ② ⭐ **必须量跑次间方差**。实测（`F4`）：同一提示词、同一条语料，两次答案**不同**
 *    （"我没答应过要写论文"：`none` → `clarify`）。
 *    ⇒ **单次的一致率不是稳定估计** ⇒ `--runs < 3` 时本门判 **INCONCLUSIVE**，不判 PASS。
 *    （这条直接来自"量具有效性先于读数"：一个随机数不是读数。）
 *
 * ③ **失败不伪装成答错**。`invalid` / `transport` 等**不是**"她读错了"，
 *    它们是"这次没读到" ⇒ 从**分母里剔出去**、**分桶如实报出**，
 *    并断言账加得起来（`answered + failures === items × runs`）。
 *
 * ④ **判据先声明、后读数**：PASS 的条件是 **准确率 > 多数类基线**（"总猜 none"那条线，
 *    由度量机自己算）且**失败率 ≤ 声明的上界**。上界是**运行参数**，不是看到数字之后挑的。
 *    ⚠️ 而"多数类基线"这条对照**不是**为了好看 —— 它是本仓库 §6 第 3 条（正控 + 负控）在语义面的落点。
 * ```
 *
 * ⚠️ 零数据库：本门**不开任何库**（理解层的输入全在内存里）⇒ 真实库从不被触碰。
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { buildGoalCorpus, type GoalCorpusSplit } from '../evals/m10/goal-corpus.ts'
import {
  readSemantic,
  type GoalMetricLabel,
  type LabelledCase,
  type SemanticReading,
} from '../evals/m10/goal-metrics.ts'
import { understandGoalProposal } from '../src/kernel/app/goal/understanding.ts'
import { createOpenAiGoalUnderstandingProvider } from '../src/infrastructure/model/openai-goal-understanding.ts'
/*
 * ⚠️ **生产运行时**（真实时钟 + 真的和期限赛跑）—— 真模型门该跑**产品那条链**的运行时，
 *    而不是测试用的"直接 await、不调真实定时器"。
 *    ⇒ 顺带让 `G-2` 的那块运行时**被真的用上**（否则它是死代码）。
 */
import { createRealGoalUnderstandingRuntime } from '../src/infrastructure/goal/understanding-runtime.ts'
import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6-command-surface.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = '00000000-0000-4000-8000-000000000001'

/** 失败率上界：**声明的运行界**（不是看到数字之后挑的） */
const DECLARED_FAILURE_BOUND = 0.1
/** 少于这么多次运行 ⇒ 量不出方差 ⇒ 判 INCONCLUSIVE（见纪律 ②） */
const MIN_RUNS_FOR_VARIANCE = 3

function argOf(name: string): string | undefined {
  const hit = process.argv.find((item) => item.startsWith(`${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 1)
}

const split = (argOf('--split') ?? 'test') as GoalCorpusSplit
const runs = Number(argOf('--runs') ?? '3')
const limitRaw = argOf('--limit')
const limit = limitRaw === undefined ? undefined : Number(limitRaw)

interface Check {
  group: 'A' | 'B' | 'C'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group, id, label, expected, actual, pass })
}
function phase(mark: string): void {
  console.error(`[m10-semantic-eval] ${mark}`)
}

/* ---------------------------------------------------------------------------
 * 守卫：先拒，再谈别的（纪律 ①）
 * ------------------------------------------------------------------------- */
if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error(
    `[m10-semantic-eval] 拒绝：缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ ` +
      '本门只跑**测试端点**（`pnpm with-test-model pnpm m10:semantic:eval`），' +
      '**绝不回落** `.env` 的原 key',
  )
  process.exit(2)
}
const provider = createOpenAiGoalUnderstandingProvider()
if ((process.env.OPENAI_API_KEY ?? '').trim() === '') {
  console.error('[m10-semantic-eval] 拒绝：测试端点没有 key（`.env.test` 缺 OPENAI_API_KEY）')
  process.exit(2)
}
const endpointHost = ((): string => {
  try {
    return new URL(process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com').host
  } catch {
    return '(无法解析)'
  }
})()
const modelName = (process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(缺省)'

/* ---------------------------------------------------------------------------
 * 语料（冻结）
 * ------------------------------------------------------------------------- */
const corpus = buildGoalCorpus()
const allOfSplit = corpus.items.filter((item) => item.split === split)
/** `--limit` 按**层轮转**取，保持层的多样性（不是截前 N 条 —— 那会让某一层独占） */
const items = ((): typeof allOfSplit => {
  if (limit === undefined || limit >= allOfSplit.length) return allOfSplit
  const byLayer = new Map<string, typeof allOfSplit>()
  for (const item of allOfSplit) {
    byLayer.set(item.layer, [...(byLayer.get(item.layer) ?? []), item])
  }
  const picked: typeof allOfSplit = []
  const layers = [...byLayer.keys()].sort()
  let index = 0
  while (picked.length < limit) {
    const layer = layers[index % layers.length]!
    const pool = byLayer.get(layer)!
    const next = pool[Math.floor(index / layers.length)]
    if (next !== undefined) picked.push(next)
    index += 1
    if (index > allOfSplit.length * 2) break
  }
  return picked
})()

const cases: LabelledCase[] = items.map((item) => ({
  caseId: item.caseId,
  layer: item.layer,
  sourceText: item.sourceText,
  gold: item.gold.operation as GoalMetricLabel,
}))

/* ---------------------------------------------------------------------------
 * 跑：每条 × 每次运行，各一次调用（零重试）
 * ------------------------------------------------------------------------- */
phase(`running ${String(cases.length)} cases × ${String(runs)} run(s) against ${endpointHost}`)

type FailureKind = 'invalid' | 'transport' | 'source_unusable' | 'not_invoked' | 'threw'
const perRun: GoalMetricLabel[][] = []
/** `caseId → 各次运行的预测（缺 = 那一次没读到）` */
const perCasePredictions = new Map<string, (GoalMetricLabel | null)[]>()
const failures: Record<FailureKind, number> = {
  invalid: 0,
  transport: 0,
  source_unusable: 0,
  not_invoked: 0,
  threw: 0,
}
/**
 * ⚠️ **失败原因要记下来**（否则一个 FAIL 的读数**无法诊断**）：
 *    只有桶计数的话，读到"失败率 16.7%"的人**无从知道**是超时、HTTP 错，还是结构不合法。
 *    留最近 20 条（够诊断，不会把证据档撑大）。
 */
const failureDetails: { kind: FailureKind; caseId: string; run: number; detail: string }[] = []
/**
 * ⚠️ **时延也要记**（用户 2026-09-30 授权"按实际情况延长延迟预算"）：
 *    "按实际情况"必须**有分布**，否则只能靠印象挑一个数。
 *    记每次尝试的 `elapsedMs`（成功与失败都记），报 min / mean / max / p95。
 */
const latenciesMs: number[] = []
const noteFailure = (kind: FailureKind, caseId: string, runIndex: number, detail: string): void => {
  failures[kind] += 1
  if (failureDetails.length < 20) {
    failureDetails.push({ kind, caseId, run: runIndex, detail: detail.slice(0, 200) })
  }
}

for (let runIndex = 0; runIndex < runs; runIndex += 1) {
  const predictions: GoalMetricLabel[] = []
  for (const item of items) {
    const slot = perCasePredictions.get(item.caseId) ?? []
    let predicted: GoalMetricLabel | null = null
    try {
      const startedMs = Date.now()
      const outcome = await understandGoalProposal(
        provider,
        {
          characterId: CHARACTER,
          currentInput: item.sourceText,
          sourceEventId: `conv:m10-semantic-eval-${item.caseId}-r${String(runIndex)}`,
          sourceQualification: 'ESTABLISHED',
          candidates: item.candidates.map((candidate) => ({ ...candidate, revision: 1 })),
        },
        createRealGoalUnderstandingRuntime(),
      )
      /* 成功与失败都记时延（`transport` 的那些正是"撞到期限"的证据） */
      latenciesMs.push(Date.now() - startedMs)
      if (outcome.kind === 'understood') {
        predicted = outcome.draft.operation as GoalMetricLabel
      } else {
        /* ⚠️ 只有 `invalid` / `transport` 带 `detail`（`source_unusable` / `not_invoked` 只有 `reason`） */
        const detail = 'detail' in outcome ? String(outcome.detail) : ''
        noteFailure(
          outcome.kind,
          item.caseId,
          runIndex,
          `${outcome.reason}${detail === '' ? '' : `：${detail}`}`,
        )
      }
    } catch (error) {
      /* provider 抛 ⇒ 内核本该记 transport；走到这里说明是**本门**的意外 ⇒ 单独一桶 */
      latenciesMs.push(-1)
      noteFailure('threw', item.caseId, runIndex, error instanceof Error ? error.message : String(error))
    }
    if (predicted !== null) predictions.push(predicted)
    slot[runIndex] = predicted
    perCasePredictions.set(item.caseId, slot)
  }
  perRun.push(predictions)
}

const answeredPerRun = perRun.map((predictions) => predictions.length)
const totalAttempts = cases.length * runs
const answered = answeredPerRun.reduce((sum, count) => sum + count, 0)
const failureTotal = Object.values(failures).reduce((sum, count) => sum + count, 0)

/* ---------------------------------------------------------------------------
 * 读数：**每一轮单独读**（不合并掩盖），再报方差
 * ------------------------------------------------------------------------- */
const answeredCases = cases.filter((item) => (perCasePredictions.get(item.caseId) ?? []).length > 0)
const readings: SemanticReading[] = []
for (let runIndex = 0; runIndex < runs; runIndex += 1) {
  const casesThisRun = cases.filter((item) => perCasePredictions.get(item.caseId)?.[runIndex] !== null)
  const predictionsThisRun = casesThisRun.map(
    (item) => perCasePredictions.get(item.caseId)![runIndex]!,
  )
  if (casesThisRun.length > 0) readings.push(readSemantic(casesThisRun, predictionsThisRun))
}
/** 合并读（**所有已答**）：用于与基线比 —— 但**逐轮读数同时报出**，不拿它掩盖某轮的失败 */
const mergedCases: LabelledCase[] = []
const mergedPredictions: GoalMetricLabel[] = []
for (const item of cases) {
  for (const predicted of perCasePredictions.get(item.caseId) ?? []) {
    if (predicted === null) continue
    mergedCases.push(item)
    mergedPredictions.push(predicted)
  }
}
const merged = mergedCases.length > 0 ? readSemantic(mergedCases, mergedPredictions) : undefined

const accuracies = readings.map((reading) => reading.accuracy)
const meanAccuracy =
  accuracies.length === 0 ? Number.NaN : accuracies.reduce((a, b) => a + b, 0) / accuracies.length
const minAccuracy = accuracies.length === 0 ? Number.NaN : Math.min(...accuracies)
const maxAccuracy = accuracies.length === 0 ? Number.NaN : Math.max(...accuracies)

/**
 * **时延分布** —— 它是"延迟预算该定多少"的**依据**（用户 2026-09-30 授权按实际情况延长）。
 * ⚠️ 只统计**真的走完的**调用（`-1` 是本门自己的意外）。
 * ⚠️ 撞到期限的那些**也**在里面（它们的时延就是期限本身）⇒ 分布会把"被掐掉的"如实露出来。
 */
const okLatencies = latenciesMs.filter((value) => value >= 0).sort((a, b) => a - b)
const latency = {
  samples: okLatencies.length,
  min: okLatencies.length === 0 ? Number.NaN : okLatencies[0]!,
  mean:
    okLatencies.length === 0
      ? Number.NaN
      : okLatencies.reduce((sum, value) => sum + value, 0) / okLatencies.length,
  max: okLatencies.length === 0 ? Number.NaN : okLatencies[okLatencies.length - 1]!,
  p95:
    okLatencies.length === 0
      ? Number.NaN
      : okLatencies[Math.min(okLatencies.length - 1, Math.floor(okLatencies.length * 0.95))]!,
}

/** 逐条**跨运行稳定性**：各次都给了结论且**全都一样** ⇒ 稳 */
const stability = cases.map((item) => {
  const slot = perCasePredictions.get(item.caseId) ?? []
  const given = slot.filter((value): value is GoalMetricLabel => value !== null && value !== undefined)
  return {
    caseId: item.caseId,
    layer: item.layer,
    gold: item.gold,
    predictions: slot,
    stable: given.length === runs && new Set(given).size === 1,
    answered: given.length,
  }
})
const unstable = stability.filter((row) => row.answered === runs && !row.stable)
/**
 * ⚠️ **第三桶：没答满**（`answered < runs`）。
 *    第一版漏了它 —— 断言写成"稳定 + 翻转 = 条目数"，而**没答满的那些两条都不属于**
 *    ⇒ 实测 `8 + 0 = 8 ≠ 12`（判据当场红，是**判据自己**的算术错，不是产品的）。
 *    ⇒ 三桶必须**恰好划分**：稳定 + 翻转 + 没答满 = 条目数。
 */
const partial = stability.filter((row) => row.answered < runs)

const perCaseRows = stability.map((row) => ({
  ...row,
  /* 逐案读数（`U-11` 方式甲：逐案可核） */
  hit: row.answered === runs && row.predictions.every((value) => value === row.gold),
}))

/* ---------------------------------------------------------------------------
 * 判据（先声明、后读数）
 * ------------------------------------------------------------------------- */
phase('checks')
record(
  'A',
  'A1',
  '**语料指纹在场且 split 非空**（读数必须挂在某一份冻结语料上）',
  '指纹长度 > 0 · 条目 > 0',
  `指纹=${corpus.corpusHash} · split=${split} · 条目=${String(items.length)}（该 split 共 ${String(allOfSplit.length)}）`,
  corpus.corpusHash.length > 0 && items.length > 0,
)
record(
  'A',
  'A2',
  '**分母自证**：真的读到了结论（`answered > 0`）——"一条都没读到"与"全对"在输出上长得一样',
  'answered > 0',
  `answered=${String(answered)} / ${String(totalAttempts)} 次尝试（${String(cases.length)} 条 × ${String(runs)} 轮）`,
  answered > 0,
)
record(
  'A',
  'A3',
  '**账加得起来**：`answered + 失败 = 条目 × 轮数`（失败**不伪装成答错**，也不能凭空消失）',
  'answered + failures === items × runs',
  `${String(answered)} + ${String(failureTotal)} = ${String(totalAttempts)}`,
  answered + failureTotal === totalAttempts,
)
record(
  'A',
  'A4',
  '**五桶失败分别报出**，且 `source_unusable` / `not_invoked` **必须是 0**'
    + '（本门的每条都有 ESTABLISHED 归因与非空原话 ⇒ 那两个桶一旦非零，说明接线错了）',
  'invalid/transport/threw 报出 · source_unusable = not_invoked = 0',
  `invalid=${String(failures.invalid)} · transport=${String(failures.transport)} · threw=${String(failures.threw)}` +
    ` · source_unusable=${String(failures.source_unusable)} · not_invoked=${String(failures.not_invoked)}`,
  failures.source_unusable === 0 && failures.not_invoked === 0,
)
record(
  'A',
  'A5',
  '**多数类基线在场**（"总猜 none"那条线）：准确率必须与它一起看，否则"高准确率"可能只是"多数类占比高"',
  'majorityBaseline 是有限数',
  merged === undefined
    ? '**没有合并读数**'
    : `accuracy=${merged.accuracy.toFixed(4)} · baseline=${merged.majorityBaseline.toFixed(4)} · macroF1=${merged.macroF1.value.toFixed(4)}`,
  merged !== undefined && Number.isFinite(merged.majorityBaseline),
)
record(
  'A',
  'A6',
  '**逐轮读数分列**（不合并掩盖某一轮的失败）：每轮一条 accuracy',
  '轮数 = readings 条数',
  `${String(runs)} 轮 ⇒ 读数 ${String(readings.length)} 条：[${accuracies.map((value) => value.toFixed(3)).join(', ')}]`,
  readings.length === runs && readings.length > 0,
)
record(
  'A',
  'A7',
  '**方差读数在场**（`F4`：这个量有跑次间方差 ⇒ 必须量它）'
    + ' —— ⚠️ 三桶必须**恰好划分**：`稳定 + 跨轮翻转 + 没答满 = 条目数`'
    + '（第一版漏了"没答满"那一桶，断言当场红：`8 + 0 ≠ 12`）',
  'runs ≥ 3 · 三桶之和 = 条目数',
  `${String(runs)} 轮 · 稳定 ${String(stability.filter((row) => row.stable).length)} 条` +
    ` · 跨轮翻转 ${String(unstable.length)} 条 · 没答满 ${String(partial.length)} 条` +
    ` · accuracy min/mean/max=${minAccuracy.toFixed(3)}/${meanAccuracy.toFixed(3)}/${maxAccuracy.toFixed(3)}`,
  runs >= MIN_RUNS_FOR_VARIANCE &&
    stability.filter((row) => row.stable).length + unstable.length + partial.length === cases.length,
)
record(
  'B',
  'B1',
  '**逐案清单在场**（`U-11` 方式甲：逐案可核）',
  '逐案行数 = 条目数',
  `${String(perCaseRows.length)} 行`,
  perCaseRows.length === cases.length,
)
record(
  'A',
  'A8',
  '**时延分布在场**（它是"延迟预算该定多少"的依据；`F5`：8 秒对本端点太紧）'
    + ' —— ⚠️ 撞到期限的那些**也在**分布里（它们的时延就是期限本身）',
  '样本 > 0 · min/mean/max/p95 都是有限数',
  `样本 ${String(latency.samples)} · min=${String(Math.round(latency.min))}ms` +
    ` · mean=${String(Math.round(latency.mean))}ms · max=${String(Math.round(latency.max))}ms` +
    ` · p95=${String(Math.round(latency.p95))}ms`,
  latency.samples > 0 &&
    Number.isFinite(latency.min) &&
    Number.isFinite(latency.mean) &&
    Number.isFinite(latency.max),
)
record(
  'C',
  'C1',
  '**跑在测试端点上**（守卫标记在场；本门**绝不**回落 `.env` 的原 key）',
  `${TEST_MODEL_WRAPPER_MARKER} = 1`,
  `标记在场 · endpoint=${endpointHost} · model=${modelName}`,
  process.env[TEST_MODEL_WRAPPER_MARKER] === '1',
)

const failureRate = totalAttempts === 0 ? Number.NaN : failureTotal / totalAttempts
record(
  'C',
  'C2',
  `**失败率 ≤ 声明的上界**（${String(DECLARED_FAILURE_BOUND)}）：超过它说明提示词/契约有**系统性**问题，`
    + '而不是模型的随机错（上界是运行参数，不是看到数字之后挑的）',
  `≤ ${String(DECLARED_FAILURE_BOUND)}`,
  Number.isNaN(failureRate) ? 'N/A' : failureRate.toFixed(4),
  Number.isFinite(failureRate) && failureRate <= DECLARED_FAILURE_BOUND,
)

const passed = checks.filter((check) => check.pass).length
const failedChecks = checks.length - passed
/** ⚠️ 判 PASS 的**唯一**口径：读到了东西 · 打赢多数类基线 · 失败率在上界内 · 判据全绿 */
const beatsBaseline = merged !== undefined && merged.accuracy > merged.majorityBaseline
const verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'INVALID' =
  answered === 0
    ? 'INVALID'
    : runs < MIN_RUNS_FOR_VARIANCE
      ? 'INCONCLUSIVE'
      : failedChecks === 0 && beatsBaseline
        ? 'PASS'
        : 'FAIL'

/* ---------------------------------------------------------------------------
 * 落盘
 * ------------------------------------------------------------------------- */
phase('done')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM10RunId({ wpId: 'wp10-semantic', headShort: head })
const dir = openM10RunDir(REPO_ROOT, runId)

const payload = {
  schema: 'm10-semantic-eval@1',
  runId,
  head,  /* ⚠️ 与离线干跑的 `semanticClaim: 'none'` **分列**：这一份是**真模型**读数 */
  semanticClaim: 'real_model' as const,
  model: { endpointHost, model: modelName },
  corpus: { fingerprint: corpus.corpusHash, split, items: items.length, runs, limit: limit ?? null },
  perRunAccuracy: accuracies,
  accuracy: { min: minAccuracy, mean: meanAccuracy, max: maxAccuracy },
  /** 时延分布 —— "延迟预算该定多少"的依据（用户 2026-09-30 授权按实际情况延长） */
  latency,
  merged,
  failures,
  failureDetails,
  failureRate,
  stability: {
    stable: stability.filter((row) => row.stable).length,
    flipped: unstable.length,
    partial: partial.length,
    flippedCases: unstable.map((row) => row.caseId),
  },
  perCase: perCaseRows,
  checks,
  summary: { total: checks.length, passed, failed: failedChecks, verdict },
}
/*
 * ⚠️ **半成品目录要收拾干净**（本轮实测撞到）：
 *    第一次跑时 `writeM10Manifest` 因缺公共字段而抛 ⇒ 目录里只剩 `semantic-eval.json`、
 *    **没有清单** ⇒ `m10:evidence:verify` 的 `A1` 把它判成 **INVALID**，
 *    而那个目录**不会被自动清理** ⇒ 聚合门**永久红**。
 *    ⇒ 证据写入包一层：**崩了就把这个目录删掉**（半个档案不是档案）。
 */
try {
  writeFileSync(join(dir, 'semantic-eval.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
  runId,
  wp: 'wp10-semantic',
  head,
  headShort: head.slice(0, 12),
  branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version, git: '(见 baseline)' },
  testType: 'semantic-eval',
  counts: { total: checks.length, passed, failed: failedChecks },
  phases: ['guard', 'run', 'read', 'checks'],
  supersedes: null,
  notes:
    `真模型语义评估（split=${split} · ${String(items.length)} 条 × ${String(runs)} 轮）· ` +
    `accuracy mean=${meanAccuracy.toFixed(4)} · baseline=${merged?.majorityBaseline.toFixed(4) ?? 'N/A'} · ` +
    `失败率=${failureRate.toFixed(4)} · 跨轮翻转 ${String(unstable.length)} 条`,
  })
} catch (error) {
  /* ⚠️ **半个档案不是档案**：崩了就把这个目录删掉 —— 否则 `m10:evidence:verify` 的 `A1`
     会把它判成 INVALID，而那个目录**不会被自动清理** ⇒ 聚合门**永久红**（本轮实测撞到） */
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 删不掉也要把原因印出来 */
  }
  console.error(
    `[m10-semantic-eval] 证据写入失败 ⇒ 已删除半成品目录 ${dir}：` +
      `${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}

for (const check of checks) {
  console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label.slice(0, 90)}`)
  console.log(`        期望 ${check.expected} · 实测 ${check.actual}`)
}
console.log(
  `\nverdict: ${verdict}（断言 ${String(passed)}/${String(checks.length)}）` +
    `\n  准确率 mean=${meanAccuracy.toFixed(4)} · min=${minAccuracy.toFixed(4)} · max=${maxAccuracy.toFixed(4)}` +
    `\n  多数类基线=${merged?.majorityBaseline.toFixed(4) ?? 'N/A'} · macroF1=${merged?.macroF1.value.toFixed(4) ?? 'N/A'}` +
    `\n  失败率=${failureRate.toFixed(4)}（invalid=${String(failures.invalid)} · transport=${String(failures.transport)}）` +
    `\n  跨轮翻转 ${String(unstable.length)} 条`,
)
console.log(`证据：${join(dir, 'semantic-eval.json')}`)
if (verdict === 'INVALID' || verdict === 'FAIL') process.exitCode = 1
