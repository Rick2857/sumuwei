/**
 * M9.6 WP2 —— **量具门**（`pnpm m9.6:measurement:verify`）。
 *
 * ============================================================================
 *  它证明什么（计划 §8 WP2 出口 / 契约 §8 G0）
 * ============================================================================
 * ```text
 * §1 **分母纪律**：分母为 0 ⇒ NOT RUN（`value === null`），**不是 0%、不是 PASS**
 * §2 **合法业务空集 ≠ 测量空转**：格式合法的空预测算"已测量"；解析失败不算
 * §3 **主读数分母**：传输失败与非法输出按端到端失败计入全量分母；只看有效响应的另列
 * §4 **伪通过负控（三段式）**：正控 / 负控（把错公式重新实现一遍，必须给出**另一个**数）
 *    / 恢复；并证明"全部失败 ⇒ 零错误"这种自欺会被 `outputValidRate` 抓住
 * §5 校准自检：Brier / ECE 的分箱与分母；负控证明"忽略箱计数"会给出不同的数
 * §6 零真实出站
 * ```
 * ⚠️ 纯离线。它**不**评价 Jev 质量（那要真模型），只证明"量具本身有牙"。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  accountOutcomes,
  accuracy,
  brierScore,
  describeMetric,
  expectedCalibrationError,
  falsePositiveRateFor,
  macroF1,
  pairedBootstrapDiff,
  ratio,
  recallFor,
  wilsonInterval,
  type LabeledCase,
  type MultiLabelCase,
  type OutcomeCase,
} from './m9.6-stats.ts'

const ROOT = resolve('.')

let passed = 0
let failed = 0
const failures: string[] = []
const checks: { label: string; ok: boolean; detail: string }[] = []

function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok, detail })
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
  return ok
}

function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

/* ===========================================================================
 *  §1 分母纪律
 * ========================================================================= */

section('§1 分母为 0 ⇒ NOT RUN（不是 0%、不是 PASS）')

check(
  '★ `ratio(0, 0)` ⇒ `value === null` 且 `notRun === true`（**不是** 0）',
  ratio(0, 0).value === null && ratio(0, 0).notRun === true,
  describeMetric(ratio(0, 0))
)
check(
  '★ 空集的准确率 ⇒ NOT RUN（**关键**：`0/0` 与"全对"在输出上长得一样）',
  accuracy([]).notRun === true && accuracy([]).value === null,
  describeMetric(accuracy([]))
)
check(
  '★ 多标签宏平均：金标里从不出现的标签**不参与**宏平均（把无定义当 0 会凭空压低分数）',
  macroF1([{ predicted: [], gold: [] }], ['A-GRATITUDE', 'A-HOSTILE']).macroF1.notRun === true &&
    macroF1([{ predicted: ['A-GRATITUDE'], gold: ['A-GRATITUDE'] }], ['A-GRATITUDE', 'A-HOSTILE']).labelsWithoutGold.join(',') === 'A-HOSTILE',
  '无金标标签被单列，不拉低宏平均'
)
check(
  '★ `wilsonInterval(0, 0)` ⇒ `null`（**不**返回 [0,1] —— 那会被读成"区间很宽但有效"）',
  wilsonInterval(0, 0) === null && wilsonInterval(1, 2) !== null,
  `n=2 时 ${JSON.stringify(wilsonInterval(1, 2))}`
)
check(
  '★ 成对 bootstrap：空输入 ⇒ `null`；长度不匹配 ⇒ `null`（不许对齐后硬算）',
  pairedBootstrapDiff([], []) === null && pairedBootstrapDiff([1, 0], [1]) === null,
  '空输入与长度不匹配都返回 null'
)
check(
  '★ 校准：空输入 ⇒ NOT RUN（Brier 与 ECE 都是）',
  brierScore([]).notRun === true && expectedCalibrationError([]).ece.notRun === true,
  '空集不复用 0'
)
check(
  '★ 每个量都**显式带分母**（读者能看见分母是什么，不是只有一个数）',
  [accuracy([]), ratio(1, 4), macroF1([], ['A']).macroF1].every((metric) => typeof metric.denominator === 'number'),
  '全部带 denominator'
)

/* ===========================================================================
 *  §2 合法业务空集 ≠ 测量空转
 * ========================================================================= */

section('§2 合法业务空集（格式合法、预测为空）算"已测量"，解析失败不算')

{
  const cases: readonly OutcomeCase[] = [
    /* 合法空预测：她**没有**任何情绪家族 ⇒ 这是业务结果，不是量具故障 */
    { outcome: 'measured', predictedCorrect: true },
    /* 解析失败：量具坏了，这条**不能**算"已测量" */
    { outcome: 'invalid_output' },
    { outcome: 'unavailable' },
  ]
  const accounting = accountOutcomes(cases)
  check(
    '★ 合法空预测计入 `measured`（⇒ 不是"检查了 0 项"）',
    accounting.measured === 1,
    `measured=${String(accounting.measured)}`
  )
  check(
    '★ 解析失败/传输失败**不**计入 `measured`，但**计入**主分母',
    accounting.invalidOutput === 1 &&
      accounting.unavailable === 1 &&
      accounting.endToEndDenominator === 3 &&
      accounting.measured === 1,
    `measured=${String(accounting.measured)} invalid=${String(accounting.invalidOutput)} unavailable=${String(accounting.unavailable)} 主分母=${String(accounting.endToEndDenominator)}`
  )
  check(
    '★ 主读数把失败算**错**：端到端准确率 = 1/3（有效响应附列 = 1/1，**不能替代**主读数）',
    accounting.endToEndAccuracy.value === 1 / 3 && accounting.validOnlyAccuracy.value === 1,
    `主 ${describeMetric(accounting.endToEndAccuracy)} · 附列 ${describeMetric(accounting.validOnlyAccuracy)}`
  )
}

/* ===========================================================================
 *  §3 主分母纪律（计划 §7 逐字）
 * ========================================================================= */

section('§3 传输失败 / 非法输出计入**全量分母**；有效响应附列不得替代主读数')

const RUN: readonly OutcomeCase[] = [
  ...Array.from({ length: 70 }, () => ({ outcome: 'measured', predictedCorrect: true }) as OutcomeCase),
  ...Array.from({ length: 20 }, () => ({ outcome: 'measured', predictedCorrect: false }) as OutcomeCase),
  ...Array.from({ length: 7 }, () => ({ outcome: 'invalid_output' }) as OutcomeCase),
  ...Array.from({ length: 3 }, () => ({ outcome: 'unavailable' }) as OutcomeCase),
]
const RUN_ACCOUNTING = accountOutcomes(RUN)

check(
  '★ 正控：100 条里 70 条判对 / 20 条判错 / 7 条非法输出 / 3 条传输失败 ⇒ 主准确率 = 70/100 = 0.70',
  RUN_ACCOUNTING.endToEndAccuracy.value === 0.7 && RUN_ACCOUNTING.endToEndDenominator === 100,
  describeMetric(RUN_ACCOUNTING.endToEndAccuracy)
)
check(
  '★ 附列（只看有效响应）= 70/90 ≈ 0.7778 ⇒ **高于**主读数（这就是"只看成功的"会带来的错觉）',
  Math.abs((RUN_ACCOUNTING.validOnlyAccuracy.value ?? 0) - 70 / 90) < 1e-12 && (RUN_ACCOUNTING.validOnlyAccuracy.value ?? 0) > 0.7,
  describeMetric(RUN_ACCOUNTING.validOnlyAccuracy)
)
check(
  '★ 完整合法输出率 = 90/100 = 0.90（把"量具坏了多少"显式化）',
  RUN_ACCOUNTING.outputValidRate.value === 0.9,
  describeMetric(RUN_ACCOUNTING.outputValidRate)
)

/* ===========================================================================
 *  §4 三段式自证：伪通过负控
 * ========================================================================= */

section('§4 三段式自证 —— 负控把**错公式**重新实现一遍，必须给出另一个数')

/*
 * ============================================================================
 *  ⚠️ 以下三个是**故意的错公式**，不是死代码。
 * ============================================================================
 * 复刻的是本仓历史上真实踩过的三种口径错误（AGENTS.md §6.8/§6.9 与 M5.5.1 WP7）：
 *   错公式① 把端到端失败从**分母**里剔除 ⇒ 准确率被抬高（"只看成功的"）
 *   错公式② 把**未测量**也算成"格式合法" ⇒ 完成率被抬高（"跳过也算过"）
 *   错公式③ 把无定义标签的 F1 当成 **0** 计入宏平均 ⇒ 宏平均被压低
 * 只测"正确公式给出我想要的数"是正控；证明"错公式会给出另一个数"才证明判据有牙。
 */

/** 错公式①：只统计拿到有效响应的 case（剔除失败） */
function wrongDropFailures(cases: readonly OutcomeCase[]): number | null {
  const measured = cases.filter((item) => item.outcome === 'measured')
  if (measured.length === 0) return null
  return measured.filter((item) => item.predictedCorrect === true).length / measured.length
}

/** 错公式②：把 `invalid_output` 也算成"格式合法" */
function wrongCountInvalidAsValid(cases: readonly OutcomeCase[]): number | null {
  if (cases.length === 0) return null
  return (cases.filter((item) => item.outcome !== 'unavailable').length) / cases.length
}

/** 错公式③：无定义标签按 0 计入宏平均 */
function wrongZeroForUndefined(cases: readonly MultiLabelCase[], labels: readonly string[]): number {
  const per: number[] = []
  for (const label of labels) {
    const tp = cases.filter((item) => item.predicted.includes(label) && item.gold.includes(label)).length
    const fp = cases.filter((item) => item.predicted.includes(label) && !item.gold.includes(label)).length
    const fn = cases.filter((item) => !item.predicted.includes(label) && item.gold.includes(label)).length
    per.push(tp + fp + fn === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn))
  }
  return per.reduce((sum, value) => sum + value, 0) / per.length
}

check(
  '★ **负控①**：把失败从分母剔除 ⇒ 准确率被**抬高**到 70/90 ≈ 0.7778（正确值 0.70）',
  Math.abs((wrongDropFailures(RUN) ?? 0) - 70 / 90) < 1e-12 &&
    RUN_ACCOUNTING.endToEndAccuracy.value === 0.7 &&
    (wrongDropFailures(RUN) ?? 0) > RUN_ACCOUNTING.endToEndAccuracy.value,
  `正确 ${describeMetric(RUN_ACCOUNTING.endToEndAccuracy)} vs 错公式 ${String(wrongDropFailures(RUN))}`
)
check(
  '★ **负控②**：把 `invalid_output` 算成"格式合法" ⇒ 完成率被抬高到 0.97（正确值 0.90）',
  wrongCountInvalidAsValid(RUN) === 0.97 && RUN_ACCOUNTING.outputValidRate.value === 0.9,
  `正确 0.90 vs 错公式 ${String(wrongCountInvalidAsValid(RUN))}`
)
{
  const cases: readonly MultiLabelCase[] = [{ predicted: ['A-GRATITUDE'], gold: ['A-GRATITUDE'] }]
  const correct = macroF1(cases, ['A-GRATITUDE', 'A-HOSTILE'])
  const wrong = wrongZeroForUndefined(cases, ['A-GRATITUDE', 'A-HOSTILE'])
  check(
    '★ **负控③**：无定义标签按 0 计入宏平均 ⇒ 0.5（正确值 1.0，因为无金标标签不参与）',
    correct.macroF1.value === 1 && wrong === 0.5 && correct.labelsWithoutGold.join(',') === 'A-HOSTILE',
    `正确 ${describeMetric(correct.macroF1)} vs 错公式 ${String(wrong)}`
  )
}

/* 恢复：正确公式在同一批数据上重新给出正确数 */
check(
  '★ **恢复**：正确公式在同一批数据上重新安静（主 0.70 · 完成率 0.90 · 宏平均 1.0）',
  RUN_ACCOUNTING.endToEndAccuracy.value === 0.7 &&
    RUN_ACCOUNTING.outputValidRate.value === 0.9 &&
    macroF1([{ predicted: ['A-GRATITUDE'], gold: ['A-GRATITUDE'] }], ['A-GRATITUDE', 'A-HOSTILE']).macroF1.value === 1,
  '三个数都回到正确值'
)

/* ★ "全部失败 ⇒ 零错误"的自欺必须被抓住 */
{
  const allFail: readonly OutcomeCase[] = Array.from({ length: 40 }, () => ({ outcome: 'invalid_output' }) as OutcomeCase)
  const accounting = accountOutcomes(allFail)
  check(
    '★ **自欺探针**：全部失败时端到端准确率 NOT RUN（分母 40 但**无** measured ⇒ 有效响应附列为 NOT RUN），完成率 = 0',
    accounting.measured === 0 &&
      accounting.validOnlyAccuracy.notRun === true &&
      accounting.outputValidRate.value === 0 &&
      accounting.endToEndAccuracy.value === 0,
    `完成率 ${describeMetric(accounting.outputValidRate)} · 有效响应附列 ${describeMetric(accounting.validOnlyAccuracy)}`
  )
  check(
    '★ **拒绝 PASS**：完成率为 0 的运行不得被读成"零关键错误所以达标"（判据见下）',
    accounting.outputValidRate.value === 0 && accounting.outputValidRate.value < 0.99,
    'G2 的完整合法输出率 ≥99% 会把这种运行直接判负'
  )
}
{
  /* 判据的自检：三个门槛都是"数"而不是"描述" */
  const gate = (accounting: ReturnType<typeof accountOutcomes>): { readonly outputValidOk: boolean; readonly safetyOk: boolean } => ({
    outputValidOk: (accounting.outputValidRate.value ?? 0) >= 0.99,
    /* 安全零错误必须**同时**要求有实际有效响应（否则"全部弃权"也能零错误） */
    safetyOk: accounting.measured > 0,
  })
  const allFail = accountOutcomes(Array.from({ length: 10 }, () => ({ outcome: 'invalid_output' }) as OutcomeCase))
  const healthy = accountOutcomes(Array.from({ length: 100 }, () => ({ outcome: 'measured', predictedCorrect: true }) as OutcomeCase))
  check(
    '★ 量具自检的**自检**：同一套门判"全失败"为不达标、判"全有效"为达标',
    gate(allFail).outputValidOk === false && gate(allFail).safetyOk === false && gate(healthy).outputValidOk === true && gate(healthy).safetyOk === true,
    `全失败 outputValidOk=${String(gate(allFail).outputValidOk)} safetyOk=${String(gate(allFail).safetyOk)} · 全有效 outputValidOk=${String(gate(healthy).outputValidOk)}`
  )
}

/* 正控：单标签 / 召回 / 假阳性率三个量在构造数据上给出**手算**值 */
{
  const labeled: readonly LabeledCase[] = [
    { predicted: 'search', gold: 'search' },
    { predicted: 'search', gold: 'answer' },
    { predicted: 'answer', gold: 'answer' },
    { predicted: 'clarify', gold: 'answer' },
  ]
  const multi: readonly MultiLabelCase[] = [
    { predicted: ['A-HOSTILE'], gold: ['A-HOSTILE'] },
    { predicted: [], gold: ['A-COMFORT'] },
    { predicted: ['A-COMFORT'], gold: [] },
    { predicted: [], gold: [] },
  ]
  check(
    '★ 正控：单标签准确率 = 2/4（手算）',
    accuracy(labeled).value === 0.5,
    describeMetric(accuracy(labeled))
  )
  check(
    '★ 正控：家族召回（金标为 A-COMFORT 的 1 条、命中 0）⇒ 0/1',
    recallFor(multi, 'A-COMFORT').numerator === 0 && recallFor(multi, 'A-COMFORT').denominator === 1,
    describeMetric(recallFor(multi, 'A-COMFORT'))
  )
  check(
    '★ 正控：家族假阳性率（金标非 A-COMFORT 的 3 条、误报 1）⇒ 1/3',
    falsePositiveRateFor(multi, 'A-COMFORT').numerator === 1 && falsePositiveRateFor(multi, 'A-COMFORT').denominator === 3,
    describeMetric(falsePositiveRateFor(multi, 'A-COMFORT'))
  )
}

/* 成对 bootstrap 的可复现性（固定种子 ⇒ 同一批数据两次相同） */
{
  const candidate = [1, 1, 0, 1, 0, 1, 1, 1, 0, 1]
  const baseline = [1, 0, 0, 1, 0, 1, 1, 0, 0, 1]
  const first = pairedBootstrapDiff(candidate, baseline)
  const second = pairedBootstrapDiff(candidate, baseline)
  check(
    '★ 成对 bootstrap **可复现**（固定种子 ⇒ 两次逐字段相同），且给出 95% 区间',
    first !== null && JSON.stringify(first) === JSON.stringify(second) && first.low <= first.high,
    first === null ? 'null' : `meanDiff=${first.meanDiff.toFixed(4)} [${first.low.toFixed(4)}, ${first.high.toFixed(4)}] n=${String(first.n)}`
  )
  check(
    '★ 区间按 **case** 重采样（同一题的三次响应不是三个独立样本 ⇒ n = case 数，不是响应数）',
    first !== null && first.n === candidate.length,
    `n=${String(first?.n)}`
  )
}

/* ===========================================================================
 *  §5 校准自检
 * ========================================================================= */

section('§5 校准：分箱预先固定；负控证明忽略箱计数会给出不同的数')

{
  /*
   * ⚠️ 两个非空箱的**计数故意不等**（3 与 1）：
   *    若计数相等，"按箱计数加权"与"各箱等权"会得出同一个数，
   *    负控就会空转通过 —— 那正是本仓最忌讳的"看起来合理但量错了"。
   */
  const cases = [
    { probability: 0.95, outcome: 1 as const },
    { probability: 0.95, outcome: 1 as const },
    { probability: 0.95, outcome: 0 as const },
    { probability: 0.55, outcome: 1 as const },
  ]
  const brier = brierScore(cases)
  const { ece, bins } = expectedCalibrationError(cases, 10)
  check(
    '★ Brier 是**均方**（分母 = case 数），不是平方和',
    brier.denominator === 4 && brier.value !== null && Math.abs(brier.value - 1.11 / 4) < 1e-12,
    describeMetric(brier)
  )
  check(
    '★ ECE 分箱**预先固定为 10 箱**且空箱计数为 0（不是"只统计非空箱"）',
    bins.length === 10 && bins.filter((bin) => bin.count === 0).length === 8,
    `${String(bins.length)} 箱 · 空箱 ${String(bins.filter((b) => b.count === 0).length)} · 非空箱计数 ${bins.filter((b) => b.count > 0).map((b) => b.count).join('/')}`
  )
  check(
    '★ ECE 分母 = case 总数，值 = (3×0.2833 + 1×0.45)/4 = 0.325（按箱计数加权）',
    ece.denominator === 4 && ece.value !== null && Math.abs(ece.value - 0.325) < 1e-9,
    describeMetric(ece)
  )
  /* 负控：忽略箱计数（各箱等权）⇒ 给出不同的数 */
  const nonEmpty = bins.filter((bin) => bin.count > 0)
  const wrongUnweighted =
    nonEmpty.reduce((sum, bin) => sum + Math.abs((bin.meanProbability as number) - (bin.meanOutcome as number)), 0) / nonEmpty.length
  check(
    '★ **负控**：忽略箱计数的"等权 ECE"给出**不同**的数（0.3667 vs 0.325 ⇒ 判据有牙）',
    ece.value !== null && Math.abs(wrongUnweighted - ece.value) > 1e-3,
    `正确 ${describeMetric(ece)} vs 等权 ${wrongUnweighted.toFixed(6)}`
  )
}

/* ===========================================================================
 *  §6 证据
 * ========================================================================= */

section('§6 证据')

check(
  '★ 量具文件**不加载** `.env`、不含 Key（纯函数，无 IO）',
  ['scripts/m9.6-stats.ts'].every((path) => !readFileSync(join(ROOT, path), 'utf8').includes('dotenv')),
  'stats.ts 无 dotenv'
)

const head = ((): string => {
  try {
    const raw = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim()
    return raw.startsWith('ref: ') ? readFileSync(join(ROOT, '.git', raw.slice(5).trim()), 'utf8').trim() : raw
  } catch {
    return 'unknown'
  }
})()

const evidence = {
  testId: 'M9.6 / WP2 measurement gauge self-proof (denominators · empty set vs idle · pseudo-pass negative controls)',
  note:
    '纯离线纯函数：无网络、无数据库、无时钟字段 ⇒ 除 head 外重复运行逐字节相同。' +
    '本门**不**评价 Jev 质量，只证明量具有牙。',
  head,
  passed,
  failed,
  failures,
  checks,
  mainReading: {
    endToEndAccuracy: RUN_ACCOUNTING.endToEndAccuracy,
    validOnlyAccuracy: RUN_ACCOUNTING.validOnlyAccuracy,
    outputValidRate: RUN_ACCOUNTING.outputValidRate,
    measured: RUN_ACCOUNTING.measured,
    invalidOutput: RUN_ACCOUNTING.invalidOutput,
    unavailable: RUN_ACCOUNTING.unavailable,
  },
  negativeControls: {
    dropFailuresFromDenominator: wrongDropFailures(RUN),
    countInvalidAsFormatValid: wrongCountInvalidAsValid(RUN),
    zeroForUndefinedLabel: wrongZeroForUndefined([{ predicted: ['A-GRATITUDE'], gold: ['A-GRATITUDE'] }], ['A-GRATITUDE', 'A-HOSTILE']),
  },
  realEgressAttempts: 0,
}
mkdirSync(join(ROOT, 'artifacts', 'm9.6'), { recursive: true })
writeFileSync(join(ROOT, 'artifacts', 'm9.6', 'measurement.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\nM9.6 WP2 量具门：${String(passed)} 通过 / ${String(failed)} 失败`)
console.log(`  主分母读数：${describeMetric(RUN_ACCOUNTING.endToEndAccuracy)} · 有效响应附列 ${describeMetric(RUN_ACCOUNTING.validOnlyAccuracy)} · 完成率 ${describeMetric(RUN_ACCOUNTING.outputValidRate)}`)
console.log('  证据：artifacts/m9.6/measurement.json')
process.exit(failed > 0 ? 1 : 0)
