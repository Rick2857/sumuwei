/**
 * M6.1 WP5 / C —— **同输入复测**：把**逐字回复 + 逐字证据块**原样喂回判定器 N 次
 *
 * ============================================================================
 *  它回答什么（用户 2026-09-25 裁定 C，逐字）
 * ============================================================================
 * ```text
 * 「先对两轮分歧回复做**人审**和**同文本复测**，明确标签边界。
 *   若据此改 prompt、采样规则或参数，另立量具版本、重新验证有效性并重新冻结候选；
 *   不得给已有 FAIL 补判。」
 * ```
 * 人审材料 = `pnpm m6.1:judge:review`；**本脚本做"同文本复测"**。
 * 它**不改量具配置一个字段**（改了就成另一个量具 ⇒ 见下面的"量具一致性守卫"）。
 *
 * ============================================================================
 *  "同文本"到底同到什么程度（**如实标注射程**）
 * ============================================================================
 * ```text
 * ✅ 逐字回复        四个轮次的 `local/turns.jsonl` 全留（59/59 条）
 * ✅ 逐字证据块      **只有** CIN(12) + EWP(10) 这 22 条留了记忆列表正文
 *                    （`memoryListAfterSignature` —— 判定器当时看到的 `eligibleState`）
 * ❌ SRP(30) + RCE(7) 的证据块**没留**：它当时是从**活沙箱**读的，沙箱随运行结束被删
 *                    ⇒ 对它们**无法**做"同输入"复测（只有"同文本、重建证据"，那是**另一个**实验）
 * ⇒ 本脚本**默认只吃那 22 条**（`--evidence retained`），并在产物里逐条声明射程。
 *    这同时是一条**留存缺口**的机器证据：判定器的证据块本该逐条落盘。
 * ```
 *
 * ============================================================================
 *  量具一致性守卫（不通过就拒绝跑）
 * ============================================================================
 * ```text
 * 归档的四个轮次用的是：openai-chat-completions @ api.deepseek.com / deepseek-flash /
 *                       effort=low / maxTokens=32000 / prompt=m6.1-judge-prompt@4
 * 本脚本读 `reading.json` 的 `judge` 身份，与**当前进程**里造出来的判定器逐字段比对；
 * 不一致 ⇒ exit 2（否则"复测"测的是另一个量具，读数不可比）。
 * ```
 *
 * ============================================================================
 *  判据（正控 / 负控 / 恢复 · 纯函数自证）
 * ============================================================================
 * ```text
 * 正控  N 次采样三态**全同** ⇒ 不得被标成分歧，pDisagree = 0
 * 负控  采样一半 alert 一半 no_alert ⇒ **必须**被标成分歧，pDisagree = 0.5
 * 恢复  真实读数在自证前后逐字段一致
 * 计数自检 输入数 = 0 / 采样数 < 2 ⇒ MEASUREMENT INVALID（§6.8）
 * ```
 *
 * 用法（**必须经测试包装器**，与短场景同一条失败关闭）：
 * ```bash
 * pnpm with-test-model pnpm m6.1:judge:stability --label cd-r1-rejudge --samples 4
 * pnpm with-test-model pnpm m6.1:judge:stability --label probe --samples 2 --limit 4 --runs cd-r1
 * ```
 */

import 'dotenv/config'

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { M6_1_LOCAL_PARENT } from './m6.1-evidence.ts'
import { alertStateOf, type AlertState } from './m6.1-contract.ts'
import { buildJudgePrompt, itemsFromCorpus, M6_1_JUDGE_PROMPT_VERSION, type InstrumentItem } from './m6.1-instrument.ts'
import {
  createOpenAiInstrumentJudge,
  M6_1_JUDGE_MAX_ATTEMPTS,
  M6_1_JUDGE_MIN_INTERVAL_MS,
  M6_1_JUDGE_TIMEOUT_MS,
} from './m6.1-judge-openai.ts'
import {
  loadCorrectionNegativeSet,
  loadExplicitWriteSet,
} from './m6.1-control-sets.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { failureKindOf, modelRouteFromEnv } from './m6.1-run-guards.ts'

const ROOT = resolve(process.cwd())

const RUNS: readonly { label: string; runId: string }[] = [
  { label: 'cd-r1', runId: 'm6.1-wp5-short-r1-code-default-20260924-5bee9d7d91ad-890f' },
  { label: 'cd-r2', runId: 'm6.1-wp5-short-r2-code-default-20260924-16521b9db086-dfca' },
  { label: 'dp-r1', runId: 'm6.1-wp5-short-r1-deployed-20260924-1d553110545b-1639' },
  { label: 'dp-r2', runId: 'm6.1-wp5-short-r2-deployed-20260924-0a4dce9df731-342e' },
]

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const label = argValue('--label')
if (label === undefined || !/^[a-z0-9-]+$/.test(label)) {
  console.error('失败关闭：必须给 --label <a-z0-9->（产物文件名里用它 ⇒ 不许覆盖旧读数）')
  process.exit(2)
}
const samples = Number(argValue('--samples') ?? '4')
const limit = argValue('--limit') === undefined ? undefined : Number(argValue('--limit'))
const runFilter = (argValue('--runs') ?? RUNS.map((run) => run.label).join(','))
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '')
const cooldownMs = Number(argValue('--rate-limit-cooldown-ms') ?? '60000')
const rateLimitRetries = Number(argValue('--rate-limit-retries') ?? '5')
const maxConsecutiveFailures = Number(argValue('--max-consecutive-failures') ?? '3')
const dryRun = process.argv.includes('--dry-run')
if (!Number.isInteger(samples) || samples < 2) {
  console.error(`失败关闭：--samples 必须是 ≥2 的整数（收到 ${String(samples)}）`)
  process.exit(2)
}
for (const run of RUNS) {
  if (runFilter.includes(run.label)) continue
  if (!RUNS.some((candidate) => candidate.label === run.label)) continue
}
const selectedRuns = RUNS.filter((run) => runFilter.includes(run.label))
if (selectedRuns.length === 0) {
  console.error(`失败关闭：--runs 一个都没匹配上（收到 ${JSON.stringify(runFilter)}）`)
  process.exit(2)
}
if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error(
    `失败关闭：缺 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 拒绝运行（绝不回落到 .env 的原 key）。`
  )
  process.exit(2)
}
const outputPath = join(ROOT, 'artifacts', 'm6.1', `judge-stability-${label}.json`)
if (existsSync(outputPath)) {
  console.error(`失败关闭：${outputPath} 已存在 ⇒ 换一个 --label（**不许覆盖已有读数**）`)
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * 冻结条文 → 判定器条目（与运行器的 `buildWorkItems` **同一套 loader**）
 * ------------------------------------------------------------------------- */
interface FrozenItem {
  readonly setId: string
  readonly id: string
  readonly category: string
  readonly turns: readonly string[]
}
const frozen: FrozenItem[] = []
for (const item of loadCorrectionNegativeSet(ROOT)) {
  frozen.push({
    setId: 'cin',
    id: item.id,
    category: item.category,
    turns: [item.text],
  })
}
for (const item of loadExplicitWriteSet(ROOT)) {
  frozen.push({ setId: 'ewp', id: item.id, category: 'explicit_write', turns: [...item.setup] })
}

const readLines = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []

const readJudgeIdentity = (runId: string): Record<string, unknown> => {
  const reading = JSON.parse(
    readFileSync(join(ROOT, 'artifacts', 'm6.1', runId, 'reading.json'), 'utf8')
  ) as { judge?: Record<string, unknown> }
  return reading.judge ?? {}
}

interface StabilityInput {
  readonly runLabel: string
  readonly runId: string
  readonly itemId: string
  readonly setId: string
  readonly category: string
  readonly turns: readonly string[]
  readonly reply: string
  /** 判定器当时看到的 `eligibleState`（逐字 · 来自 local 的 `memoryListAfterSignature`） */
  readonly evidence: string
  /** 归档那一轮的两次采样三态（对照用） */
  readonly archivedStates: readonly AlertState[]
  readonly archivedDisagreed: boolean
}

const inputs: StabilityInput[] = []
const skipped: { runLabel: string; itemId: string; why: string }[] = []
for (const run of selectedRuns) {
  const localDir = join(ROOT, M6_1_LOCAL_PARENT, run.runId)
  const rows = readLines(join(localDir, 'turns.jsonl'))
  const judgeRows = readLines(join(ROOT, 'artifacts', 'm6.1', run.runId, 'judge.partial.jsonl'))
  for (const item of frozen) {
    const definition = rows.filter(
      (row) => row.itemId === item.id && row.memoryListSha256 === undefined && typeof row.reply === 'string'
    )
    const program = rows.filter(
      (row) => row.itemId === item.id && typeof row.memoryListAfterSignature === 'string'
    )
    const archived = judgeRows.find((row) => row.itemId === item.id)
    const evidence = program[program.length - 1]?.memoryListAfterSignature
    if (definition.length === 0) {
      skipped.push({ runLabel: run.label, itemId: item.id, why: '逐字回复没留' })
      continue
    }
    if (evidence === undefined || String(evidence) === '') {
      skipped.push({ runLabel: run.label, itemId: item.id, why: '证据块（记忆列表正文）没留 ⇒ 无法做同输入复测' })
      continue
    }
    if (archived === undefined) {
      skipped.push({ runLabel: run.label, itemId: item.id, why: '归档判定行缺失' })
      continue
    }
    const archivedStates = ((archived.samples as string[][] | undefined) ?? []).map((ls) => alertStateOf(ls))
    inputs.push({
      runLabel: run.label,
      runId: run.runId,
      itemId: item.id,
      setId: item.setId,
      category: item.category,
      turns: item.turns,
      reply: String(definition[definition.length - 1]!.reply),
      evidence: String(evidence),
      archivedStates,
      archivedDisagreed: new Set(archivedStates).size > 1,
    })
  }
}
const selected = limit === undefined ? inputs : inputs.slice(0, limit)

/* ---------------------------------------------------------------------------
 * 量具一致性守卫：与归档身份逐字段比对（不一致 ⇒ 拒绝跑）
 * ------------------------------------------------------------------------- */
const judge = createOpenAiInstrumentJudge({ model: process.env.OPENAI_SMALL_MODEL })
const currentIdentity = {
  id: judge.id,
  host: judge.baseUrlHost,
  model: judge.model,
  reasoningEffort: judge.reasoningEffort,
  maxTokens: judge.maxTokens,
  timeoutMs: M6_1_JUDGE_TIMEOUT_MS,
  maxAttempts: M6_1_JUDGE_MAX_ATTEMPTS,
  minIntervalMs: M6_1_JUDGE_MIN_INTERVAL_MS,
  promptVersion: M6_1_JUDGE_PROMPT_VERSION,
}
const archivedIdentity = readJudgeIdentity(selectedRuns[0]!.runId)
const identityFields = ['id', 'host', 'model', 'reasoningEffort', 'maxTokens', 'timeoutMs', 'maxAttempts', 'minIntervalMs', 'promptVersion'] as const
const identityDrift = identityFields
  .filter((field) => field in archivedIdentity && archivedIdentity[field] !== currentIdentity[field])
  .map((field) => `${field}: 归档 ${JSON.stringify(archivedIdentity[field])} ≠ 当前 ${JSON.stringify(currentIdentity[field])}`)

console.log('='.repeat(96))
console.log('M6.1 WP5 / C · 同输入复测（逐字回复 + 逐字证据块 · 只换采样）')
console.log('='.repeat(96))
console.log(`  label=${label} · samples=${String(samples)} · runs=${selectedRuns.map((r) => r.label).join(',')}`)
console.log(`  可复测输入 = ${String(selected.length)} / 候选 ${String(inputs.length)}（跳过的 ${String(skipped.length)} 条见产物）`)
console.log(`  量具配置：${identityFields.map((field) => `${field}=${String(currentIdentity[field])}`).join(' · ')}`)
if (identityDrift.length > 0) {
  console.error('\n  ⚠️ 量具配置与归档不一致 ⇒ 复测读数**不可比**，拒绝跑：')
  for (const line of identityDrift) console.error(`     · ${line}`)
  process.exit(2)
}
console.log('  量具一致性守卫：与归档 `reading.json` 的 judge 身份逐字段相同 ✔')
if (dryRun) {
  console.log('\n  --dry-run：只打印计划，不调模型。')
  for (const input of selected) {
    console.log(`   · ${input.runLabel} ${input.itemId} 回复 ${String(input.reply.length)} 字 · 证据 ${String(input.evidence.length)} 字 · 归档 ${input.archivedStates.join('/')}`)
  }
  process.exit(0)
}

/* ---------------------------------------------------------------------------
 * 纯函数：三态分布 ⇒ "两次随机采样不一致"的概率
 * ------------------------------------------------------------------------- */
function stateCounts(states: readonly AlertState[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const state of states) counts[state] = (counts[state] ?? 0) + 1
  return counts
}
/** 1 - Σ p_i²：从 N 次采样的多项分布估"两次独立采样三态不同"的概率 */
function pDisagreeTwoDraws(states: readonly AlertState[]): number {
  const n = states.length
  if (n === 0) return 0
  const counts = stateCounts(states)
  return 1 - Object.values(counts).reduce((acc, count) => acc + (count / n) ** 2, 0)
}

/* ---------------------------------------------------------------------------
 * 采样
 * ------------------------------------------------------------------------- */
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
interface Reading {
  readonly runLabel: string
  readonly itemId: string
  readonly setId: string
  readonly states: readonly AlertState[]
  readonly labels: readonly (readonly string[])[]
  readonly archivedStates: readonly AlertState[]
  readonly archivedDisagreed: boolean
  readonly transportationFailure: string | null
  readonly rateLimitRetries: number
}
const readings: Reading[] = []
/**
 * ⚠️ **逐条落盘**（本仓库自己的教训：judge 阶段曾整轮跑 80 分钟却零增量落盘，只能中止）：
 * 每跑完一条就追加一行 ⇒ 中途被限流/打断也不至于把已花的调用全丢掉。
 */
const partialPath = join(ROOT, 'artifacts', 'm6.1', `judge-stability-${label}.partial.jsonl`)
let consecutiveFailures = 0
let aborted = false
for (const input of selected) {
  const rawItems = itemsFromCorpus([
    {
      id: input.itemId,
      category: input.category,
      responseText: input.reply,
      factBase: { script: input.turns, itemId: input.itemId, setId: input.setId },
      eligibleState: { memoryListText: input.evidence.slice(0, 4000) },
      actualContext: null,
      actualContextUnavailableReason:
        '逐字提示**刻意不落** trace；本运行器的结构性上下文读数在 local/trace-readout.json',
      expected: { shouldAlert: false, labels: [] },
    },
  ])
  const instrumentItem = rawItems[0] as InstrumentItem
  const states: AlertState[] = []
  const labels: string[][] = []
  let transportationFailure: string | null = null
  let limitRetries = 0
  for (let sample = 0; sample < samples; sample += 1) {
    if (sample > 0) await sleep(M6_1_JUDGE_MIN_INTERVAL_MS)
    let attempt = 0
    for (;;) {
      const result = await judge.judge(buildJudgePrompt(instrumentItem))
      if (result.callFailure === null) {
        const parsed = result.parsed
        if (parsed?.ok === true) {
          const own = parsed.output.assertions.map((assertion) => assertion.label)
          labels.push(own)
          states.push(alertStateOf(own))
        } else {
          labels.push([])
          states.push('undecidable')
        }
        break
      }
      const kind = failureKindOf(result.callFailure)
      if (result.callFailure === 'rate_limited' && attempt < rateLimitRetries) {
        attempt += 1
        limitRetries += 1
        console.log(`      · ${input.itemId} 限流 ⇒ 冷却 ${String(cooldownMs)}ms 后重试（第 ${String(attempt)} 次）`)
        await sleep(cooldownMs)
        continue
      }
      transportationFailure = `${result.callFailure}（${kind}）`
      break
    }
    if (transportationFailure !== null) break
    console.log(
      `      · ${input.runLabel} ${input.itemId} 采样${String(sample + 1)}/${String(samples)} ⇒ ${states[states.length - 1] ?? '?'}`
    )
  }
  readings.push({
    runLabel: input.runLabel,
    itemId: input.itemId,
    setId: input.setId,
    states,
    labels,
    archivedStates: input.archivedStates,
    archivedDisagreed: input.archivedDisagreed,
    transportationFailure,
    rateLimitRetries: limitRetries,
  })
  appendFileSync(partialPath, `${JSON.stringify(readings[readings.length - 1])}\n`, 'utf8')
  consecutiveFailures = transportationFailure === null ? 0 : consecutiveFailures + 1
  if (maxConsecutiveFailures > 0 && consecutiveFailures >= maxConsecutiveFailures) {
    aborted = true
    break
  }
}

/* ---------------------------------------------------------------------------
 * 自证（纯函数）+ 汇总
 * ------------------------------------------------------------------------- */
const syntheticAgree: AlertState[] = ['no_alert', 'no_alert', 'no_alert', 'no_alert']
const syntheticSplit: AlertState[] = ['alert', 'alert', 'no_alert', 'no_alert']
const positiveControlOk = new Set(syntheticAgree).size === 1 && pDisagreeTwoDraws(syntheticAgree) === 0
const negativeControlOk = new Set(syntheticSplit).size === 2 && Math.abs(pDisagreeTwoDraws(syntheticSplit) - 0.5) < 1e-9
const recomputed = readings.map((row) => pDisagreeTwoDraws(row.states))
const restoreOk = recomputed.every((value, index) => value === pDisagreeTwoDraws(readings[index]!.states))
const complete = readings.filter((row) => row.transportationFailure === null && row.states.length === samples)

const failures: string[] = []
if (readings.length === 0) failures.push('MEASUREMENT INVALID：0 条读数')
if (!positiveControlOk) failures.push('正控未成立：三态全同的合成样本被判成分歧 / pDisagree ≠ 0')
if (!negativeControlOk) failures.push('负控未成立：一半 alert 一半 no_alert 的合成样本没有被算出 0.5')
if (!restoreOk) failures.push('恢复失败：真实读数在自证前后不一致')
if (complete.length === 0) failures.push(`计数自检：没有一条拿到 ${String(samples)} 次完整采样`)
if (complete.length > 0 && readings.every((row) => row.setId === readings[0]!.setId)) {
  failures.push('射程自检：本批只覆盖了一个集 ⇒ 结论不得外推到别的集')
}
if (aborted) failures.push('设备中止：连续传输失败达到阈值 ⇒ 读数不完整（不是产品读数）')

const byArchived = {
  archivedDisagreed: complete.filter((row) => row.archivedDisagreed),
  archivedAgreed: complete.filter((row) => !row.archivedDisagreed),
}
const mean = (rows: readonly Reading[]): number | null =>
  rows.length === 0 ? null : rows.reduce((acc, row) => acc + pDisagreeTwoDraws(row.states), 0) / rows.length
const summary = {
  inputs: readings.length,
  complete: complete.length,
  noLongerDisagree: complete.filter((row) => new Set(row.states).size === 1 && row.archivedDisagreed).length,
  newDisagree: complete.filter((row) => new Set(row.states).size > 1 && !row.archivedDisagreed).length,
  meanPDisagreeArchivedDisagreed: mean(byArchived.archivedDisagreed),
  meanPDisagreeArchivedAgreed: mean(byArchived.archivedAgreed),
  bySet: [...new Set(complete.map((row) => row.setId))].map((setId) => {
    const own = complete.filter((row) => row.setId === setId)
    return { setId, complete: own.length, meanPDisagree: mean(own) }
  }),
}

console.log('')
for (const row of readings) {
  const p = pDisagreeTwoDraws(row.states)
  console.log(
    `  ${row.runLabel} ${row.itemId.padEnd(9)} 归档 ${row.archivedStates.join('/').padEnd(24)}` +
      ` ⇒ 复测 ${row.states.join('/') || '(无)'} · pDisagree=${p.toFixed(2)}` +
      `${row.transportationFailure === null ? '' : ` **传输失败=${row.transportationFailure}**`}`
  )
}
console.log('')
console.log(
  `  正控（全同 ⇒ p=0）= ${positiveControlOk ? 'PASS' : '**未成立**'} · ` +
    `负控（对半 ⇒ p=0.5）= ${negativeControlOk ? 'PASS' : '**未成立**'} · 恢复 = ${restoreOk ? 'PASS' : '**失败**'}`
)
console.log(
  `  汇总：完整 ${String(summary.complete)}/${String(summary.inputs)} 条 · ` +
    `归档分歧的复测平均 pDisagree=${summary.meanPDisagreeArchivedDisagreed === null ? '—' : summary.meanPDisagreeArchivedDisagreed.toFixed(3)} · ` +
    `归档一致的复测平均 pDisagree=${summary.meanPDisagreeArchivedAgreed === null ? '—' : summary.meanPDisagreeArchivedAgreed.toFixed(3)}`
)
console.log(`  「归档分歧、复测不再分歧」= ${String(summary.noLongerDisagree)} 条 · 「归档一致、复测却分歧」= ${String(summary.newDisagree)} 条`)
console.log(`  verdict = ${failures.length > 0 ? 'INCOMPLETE' : 'OK'}`)

const evidence = {
  schemaVersion: 'm6.1-judge-stability@1',
  testId: 'M6.1 WP5 / C · 同输入复测（逐字回复 + 逐字证据块，只换采样次数）',
  label,
  what: '把归档轮次里判定器**当时看到的输入**（逐字回复 + 逐字记忆列表正文）原样重建，重新采样 N 次，量三态的稳定性。',
  why: '用户裁定 C：先人审 + 同文本复测，明确标签边界；据此才谈是否改 prompt / 采样规则 / 参数。',
  scope: {
    evidenceRetained: '仅 CIN(12) + EWP(10)：只有这两集的 `memoryListAfterSignature` 落盘了',
    evidenceNotRetained: 'SRP(30) + RCE(7) 的证据块未落盘（当时从活沙箱读，沙箱随运行结束删除）⇒ 本脚本**不做**它们的"同输入"复测',
    claim: '结论只覆盖本批的集（逐条见 bySet），不得外推到 SRP/RCE。',
    samplesPerInput: samples,
  },
  judgeIdentity: {
    current: currentIdentity,
    archived: archivedIdentity,
    drift: identityDrift,
    route: modelRouteFromEnv(process.env, '本机进程环境（测试包装器注入；不落正文）'),
  },
  readings,
  skipped,
  summary,
  selfProof: {
    positive_control_all_same_state: { ok: positiveControlOk, states: syntheticAgree, pDisagree: pDisagreeTwoDraws(syntheticAgree) },
    negative_control_split_state: { ok: negativeControlOk, states: syntheticSplit, pDisagree: pDisagreeTwoDraws(syntheticSplit) },
    restore_real_readings_unchanged: { ok: restoreOk },
    count_check_complete_inputs: complete.length,
  },
  failures,
  verdict: failures.length > 0 ? 'INCOMPLETE' : 'OK',
  notProduced: [
    '它**不**判"哪一次采样对"（那要人审 + 标签边界裁定）。',
    '它**不**改任何量具参数；它只增加**采样次数**来量稳定性（配置逐字段与归档一致，有守卫）。',
    '它**不**给已有 FAIL 补判：归档四轮的读数一个字没动，本文件是**新增**的一次测量。',
    '它**不**覆盖 SRP/RCE（证据块没落盘）—— 那是**留存缺口**，不是"它们稳定"。',
  ],
}
mkdirSync(join(ROOT, 'artifacts', 'm6.1'), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`  证据：artifacts/m6.1/judge-stability-${label}.json（逐条落盘：…${label}.partial.jsonl）`)

if (aborted) {
  writeFileSync(
    join(ROOT, 'artifacts', 'm6.1', `judge-stability-aborted-${label}.json`),
    `${JSON.stringify({ schemaVersion: 'm6.1-judge-stability-aborted@1', reason: 'consecutive_transport_failures', label, readings: readings.length }, null, 2)}\n`,
    'utf8'
  )
}
if (failures.length > 0) {
  console.error('\n  ⚠️ 自证未成立 / 读数不完整：')
  for (const message of failures) console.error(`     · ${message}`)
  process.exitCode = 3
} else {
  process.exitCode = 0
}
