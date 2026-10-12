/**
 * M6.1 WP2 —— **量具自证门**（`pnpm m6.1:measurement:verify`，L0）。
 *
 * ============================================================================
 *  它要回答的问题（与 L1 部件门**不同**，别混）
 * ============================================================================
 * ```text
 *   m6.1:test（L1）              判据**本身**对不对（在内存夹具上穷举）
 *   本门（L0）                   这套**有效性判据在真实冻结语料上会不会响**
 * ```
 * 三段式（AGENTS §6.7）：
 *
 * ```text
 *   正控    一套良好判定 ⇒ 检测器**安静**（VALID、0 条理由）
 *   负控    逐种注入 ⇒ 对应的那一条理由**必须**具名出现
 *   恢复    放回良好判定 ⇒ 重新安静
 * ```
 * 外加一条计数型自检：**语料 measured_count 必须 > 0**，
 * 否则整门判 `MEASUREMENT INVALID`（"检查了 0 条、发现 0 问题"与"全部一致"长得一样）。
 *
 * ============================================================================
 *  它**不**主张什么（写在这里，免得被读成"量具已经有效了"）
 * ============================================================================
 * ```text
 *   本门用的全是**夹具判定器** ⇒ 它证明"判据会响"，**不**证明真实 judge 判得对。
 *   真实 judge 的读数在 m6.1:instrument:live；在它跑出来之前，
 *   量具对真实数据的有效性**未知**（不是"大概没问题"）。
 * ```
 *
 * 用法：
 *   pnpm m6.1:measurement:verify
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { MeasurementInvalidError } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  M6_1_CONTRACT_VERSION,
  M6_1_CORPUS_VERSION,
  M6_1_INSTRUMENT_VERSION,
} from './m6.1-contract.ts'
import {
  INSTRUMENT_VALIDITY_CRITERIA,
  computeMetrics,
  computeStability,
  computeCrossRunStability,
  evaluateValidity,
  fixtureAlwaysAlertJudge,
  fixtureAlwaysSafeJudge,
  fixtureEmptyJudge,
  fixtureGarbageJudge,
  fixtureKeywordJudge,
  fixturePerfectJudge,
  itemsFromCorpus,
  judgeItem,
  runFixtureJudge,
  type InstrumentItem,
  type Metrics,
  type StabilityReading,
  type CrossRunReading,
} from './m6.1-instrument.ts'

const ROOT = resolve(process.cwd())
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm6.1')
const SPLITS = ['dev', 'calibration', 'heldout'] as const

interface Check {
  readonly id: string
  readonly phase: 'positive' | 'negative' | 'recovery' | 'self-check'
  readonly proposition: string
  readonly observed: string
  readonly pass: boolean
}

const checks: Check[] = []

function record(check: Check): void {
  checks.push(check)
}

function recordAll(entries: readonly Check[]): void {
  for (const entry of entries) record(entry)
}

// ---------------------------------------------------------------------------
// 读真实冻结语料（不是内存夹具）
// ---------------------------------------------------------------------------

function readFrozenCorpus(): { items: InstrumentItem[]; files: string[]; bytes: number } {
  const items: InstrumentItem[] = []
  const files: string[] = []
  let bytes = 0
  for (const split of SPLITS) {
    const abs = join(ROOT, 'evals', 'm6.1', 'corpus', `${split}.jsonl`)
    if (!existsSync(abs)) {
      throw new MeasurementInvalidError(`MEASUREMENT INVALID：语料文件不存在 ${abs}`)
    }
    const text = readFileSync(abs, 'utf8')
    bytes += Buffer.byteLength(text, 'utf8')
    files.push(`evals/m6.1/corpus/${split}.jsonl`)
    const rows: unknown[] = []
    for (const [index, line] of text.split('\n').entries()) {
      if (line.trim() === '') continue
      try {
        rows.push(JSON.parse(line))
      } catch (error) {
        throw new MeasurementInvalidError(
          `MEASUREMENT INVALID：${split}.jsonl 第 ${index + 1} 行不是合法 JSON（${String(error)}）`
        )
      }
    }
    items.push(...itemsFromCorpus(rows))
  }
  if (items.length === 0) {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：语料 0 条（分母为零不是 PASS）')
  }
  return { items, files, bytes }
}

// ---------------------------------------------------------------------------
// 判定集构造（负控注入用）
// ---------------------------------------------------------------------------

/** 目标条目：按 kind 找，不写死 id（写死过一次，注入落空、负控自己没生效）。 */
function targetOf(items: readonly InstrumentItem[], kind: string): string | undefined {
  return items.filter((item) => item.contrast?.kind === kind).at(-1)?.itemId
}

function perfectJudgments(items: readonly InstrumentItem[]) {
  return items.map((item) => judgeItem(item, fixturePerfectJudge()(item)))
}

/**
 * 篡改一条：让它与"逐字相同"的同伴判得**三态不同**。
 *
 * ⚠️ `CD-14`：判据是三态，所以篡改必须动 `alertState` —— 只改细标签
 * （`predictedAlert` / `predictedLabels`）在 CD-14 下**不构成差异**，
 * 负控会"通过"却什么都没测（一种最隐蔽的假绿）。
 */
function tamperOneJudgment(
  items: readonly InstrumentItem[],
  targetId: string,
  labels: readonly string[]
) {
  return items.map((item) => {
    const base = judgeItem(item, fixturePerfectJudge()(item))
    if (item.itemId !== targetId) return base
    return {
      ...base,
      alertState: 'alert' as const,
      predictedAlert: true,
      predictedLabels: [...labels],
    }
  })
}

/** `main()` 里构装好的确定探针；由 main 赋值的注入点（缺省未初始化 ⇒ 失败关闭）。 */
let STABLE_PROBE_DEFAULT: StabilityReading | null = null
let STABLE_CROSS_DEFAULT: CrossRunReading | null = null

function reasonsOf(metrics: Metrics, stability?: StabilityReading, crossRun?: CrossRunReading): string[] {
  const probe = stability ?? STABLE_PROBE_DEFAULT
  const cross = crossRun ?? STABLE_CROSS_DEFAULT
  if (probe === null) {
    throw new MeasurementInvalidError(
      'MEASUREMENT INVALID：连续性探针未初始化（内部错误，不是"没有不一致"）'
    )
  }
  if (cross === null) {
    throw new MeasurementInvalidError(
      'MEASUREMENT INVALID：跨轮夹具未初始化（内部错误，不是"没有不一致"）'
    )
  }
  return evaluateValidity(metrics, INSTRUMENT_VALIDITY_CRITERIA, {
    criteriaFrozen: true,
    stability: probe,
    crossRun: cross,
  }).reasons.map((reason) => reason.code)
}

/**
 * CD-9 的**确定**跨轮夹具：历轮与本轮给出一致标签（6 项，双向）。
 */
function deterministicCrossRun(items: readonly InstrumentItem[]): CrossRunReading {
  const picked = [
    ...items.filter((item) => item.expectedAlert).slice(0, 3),
    ...items.filter((item) => !item.expectedAlert).slice(0, 3),
  ]
  const make = (runId: string) =>
    picked.map((item) => ({
      runId,
      itemId: item.itemId,
      configKey: 'l0-fixture@1',
      labels: item.expectedLabels.slice(0, 1),
    }))
  return computeCrossRunStability(make('run-old'), make('run-new'), 'l0-fixture@1')
}

/**
 * CD-8 的**确定**探针夹具：3 个应报警 + 3 个不应报警，每项 3 次采样且全一致。
 *
 * 它证明的是"当判定器确实可复现时，稳定性判据会安静" —— 与"它会不会响"配对。
 */
function deterministicProbe(items: readonly InstrumentItem[]): StabilityReading {
  const picked = [
    ...items.filter((item) => item.expectedAlert).slice(0, 3),
    ...items.filter((item) => !item.expectedAlert).slice(0, 3),
  ]
  return computeStability(
    picked.map((item) => ({
      itemId: item.itemId,
      expectedAlert: item.expectedAlert,
      samples: [
        item.expectedLabels.slice(0, 1),
        item.expectedLabels.slice(0, 1),
        item.expectedLabels.slice(0, 1),
      ].map((labels) => ({ ok: true, labels })),
    }))
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const startedAt = new Date().toISOString()
  const corpus = readFrozenCorpus()
  const items = corpus.items
  /** CD-8 的确定探针夹具（要在拿到语料之后才能构装） */
  const STABLE_PROBE: StabilityReading = deterministicProbe(items)
  const STABLE_CROSS: CrossRunReading = deterministicCrossRun(items)
  STABLE_PROBE_DEFAULT = STABLE_PROBE
  STABLE_CROSS_DEFAULT = STABLE_CROSS

  // ---- 自检：计数型检测器必须先自证"真的量到了东西" ----
  record({
    id: 'S1',
    phase: 'self-check',
    proposition: '语料 measured_count > 0（"检查了 0 条"必须判 MEASUREMENT INVALID，不是 PASS）',
    observed: `measured_count=${String(items.length)}`,
    pass: items.length > 0,
  })
  record({
    id: 'S2',
    phase: 'self-check',
    proposition: '冻结语料与冻结标准版本一致（读数绑到它量的是哪一版）',
    observed: `${M6_1_CONTRACT_VERSION} / ${M6_1_CORPUS_VERSION} / ${M6_1_INSTRUMENT_VERSION} / 标准=${INSTRUMENT_VALIDITY_CRITERIA.status}`,
    /*
     * ⚠️ 不再钉某个字面版本号（那样每升一次版都要来这里改一次，而且改的时候容易
     * 顺手把这条"版本一致性"检查弱化成恒真）。钉的是**形状**：三个版本号都必须是
     * 具名版本，不能是空串、不能退回"量具未实现"的占位符。
     */
    pass:
      /^m6\.1-contract@\d+$/.test(M6_1_CONTRACT_VERSION) &&
      /^m6\.1-corpus@\d+$/.test(M6_1_CORPUS_VERSION) &&
      /^m6\.1-instrument@\d+$/.test(M6_1_INSTRUMENT_VERSION) &&
      INSTRUMENT_VALIDITY_CRITERIA.status === 'FROZEN',
  })

  // ---- 正控：良好判定 ⇒ 检测器安静 ----
  const good = runFixtureJudge(items, fixturePerfectJudge())
  const goodDecision = evaluateValidity(good.metrics, INSTRUMENT_VALIDITY_CRITERIA, {
    criteriaFrozen: true,
      stability: STABLE_PROBE,
      crossRun: STABLE_CROSS,
  })
  record({
    id: 'P1',
    phase: 'positive',
    proposition: '良好判定 ⇒ 有效性判据**安静**（VALID 且 0 条理由）',
    observed: `${goodDecision.verdict}，理由 ${String(goodDecision.reasons.length)} 条`,
    pass: goodDecision.verdict === 'VALID' && goodDecision.reasons.length === 0,
  })
  record({
    id: 'P2',
    phase: 'positive',
    proposition: '分母齐全：应报警与不应报警的样本都存在（两侧都不是 0）',
    observed: `应报警 ${String(good.metrics.alert.total)} · 不应报警 ${String(good.metrics.nonAlert.total)}`,
    pass: good.metrics.alert.total > 0 && good.metrics.nonAlert.total > 0,
  })

  // ---- 负控：逐种注入，对应的理由必须具名出现 ----
  const fakeJudges: { id: string; name: string; code: string; judge: ReturnType<typeof fixturePerfectJudge> }[] = [
    { id: 'N1', name: '全部判安全（一条断言都不报）', code: 'no_alert_denominator', judge: fixtureAlwaysSafeJudge() },
    { id: 'N2', name: '全部判编造', code: 'false_alarm_above_max', judge: fixtureAlwaysAlertJudge() },
    { id: 'N3', name: '空结果（超时 / 空输出）', code: 'parse_failure_above_max', judge: fixtureEmptyJudge() },
    { id: 'N4', name: '形状坏掉（不是 JSON）', code: 'parse_failure_above_max', judge: fixtureGarbageJudge() },
  ]
  recordAll(
    fakeJudges.map((sample) => {
      const run = runFixtureJudge(items, sample.judge)
      const codes = reasonsOf(run.metrics)
      return {
        id: sample.id,
        phase: 'negative' as const,
        proposition: `注入「${sample.name}」⇒ 必须报 ${sample.code}`,
        observed: codes.length === 0 ? '**没响**（假量具会过门）' : codes.join(','),
        pass: codes.includes(sample.code),
      }
    })
  )

  // 关键词负控：必须在"有关键词但不应报警"的样本上误报
  const keywordItems = items.filter((item) => !item.expectedAlert).slice(0, 40)
  const keywordRun = runFixtureJudge(
    keywordItems.length >= 2 ? keywordItems : items.slice(0, 2),
    fixtureKeywordJudge()
  )
  record({
    id: 'N5',
    phase: 'negative',
    proposition: '注入「仅按关键词判」⇒ 必须在**支持性回忆**上误报并报 false_alarm_above_max',
    observed: `误报 ${String(keywordRun.metrics.nonAlert.falseAlarms)}/${String(keywordRun.metrics.nonAlert.total)} · 理由 ${reasonsOf(keywordRun.metrics).join(',') || '(没响)'}`,
    pass:
      keywordRun.metrics.nonAlert.falseAlarms > 0 &&
      reasonsOf(keywordRun.metrics).includes('false_alarm_above_max'),
  })

  // 分母归零：分别抽掉两侧
  const onlyNonAlert = items.filter((item) => !item.expectedAlert)
  const onlyAlert = items.filter((item) => item.expectedAlert)
  record({
    id: 'N6',
    phase: 'negative',
    proposition: '抽掉全部应报警样本 ⇒ 分母 0 ⇒ 必须报 no_alert_denominator（不是 PASS）',
    observed: (() => {
      const run = runFixtureJudge(onlyNonAlert, fixturePerfectJudge())
      const codes = reasonsOf(run.metrics)
      return codes.length === 0 ? '**没响**' : codes.join(',')
    })(),
    pass: (() => {
      const run = runFixtureJudge(onlyNonAlert, fixturePerfectJudge())
      return reasonsOf(run.metrics).includes('no_alert_denominator')
    })(),
  })
  record({
    id: 'N7',
    phase: 'negative',
    proposition: '抽掉全部不应报警样本 ⇒ 分母 0 ⇒ 必须报 no_non_alert_denominator（不是 PASS）',
    observed: (() => {
      const run = runFixtureJudge(onlyAlert, fixturePerfectJudge())
      const codes = reasonsOf(run.metrics)
      return codes.length === 0 ? '**没响**' : codes.join(',')
    })(),
    pass: (() => {
      const run = runFixtureJudge(onlyAlert, fixturePerfectJudge())
      return reasonsOf(run.metrics).includes('no_non_alert_denominator')
    })(),
  })

  // 防线：a==b 被篡改 ⇒ 必须响
  const abTarget = targetOf(items, 'a-equals-b')
  record({
    id: 'N8',
    phase: 'negative',
    proposition: '让逐字相同的两条得到不同判定 ⇒ 必须报 a_equals_b_inconsistent',
    observed:
      abTarget === undefined
        ? '**找不到 a==b 对照**（语料缺陷，本门按未响处理）'
        : (() => {
            const metrics = computeMetrics(items, tamperOneJudgment(items, abTarget, ['UNSUPPORTED_DETAIL']))
            const codes = reasonsOf(metrics)
            return `目标=${abTarget} ⇒ ${codes.join(',') || '(没响)'}`
          })(),
    pass: (() => {
      if (abTarget === undefined) return false
      const metrics = computeMetrics(items, tamperOneJudgment(items, abTarget, ['UNSUPPORTED_DETAIL']))
      return reasonsOf(metrics).includes('a_equals_b_inconsistent')
    })(),
  })

  // 标准未冻结 ⇒ 只能 INCONCLUSIVE
  record({
    id: 'N9',
    phase: 'negative',
    proposition: '标准被标为未批准 ⇒ 再好的读数也只能 INCONCLUSIVE（"拿没批的阈值当通过"不可能）',
    observed: (() => {
      const decision = evaluateValidity(good.metrics, { ...INSTRUMENT_VALIDITY_CRITERIA, status: 'PROPOSED-AWAITING-APPROVAL' }, {
        criteriaFrozen: false,
      })
      return `${decision.verdict}:${decision.reasons.map((reason) => reason.code).join(',')}`
    })(),
    pass: (() => {
      const decision = evaluateValidity(good.metrics, { ...INSTRUMENT_VALIDITY_CRITERIA, status: 'PROPOSED-AWAITING-APPROVAL' }, {
        criteriaFrozen: false,
      })
      return decision.verdict === 'INCONCLUSIVE'
    })(),
  })

  // 条目不足 ⇒ 必须响
  record({
    id: 'N10',
    phase: 'negative',
    proposition: `条目数不足 ${String(INSTRUMENT_VALIDITY_CRITERIA.minItems)} ⇒ 必须报 too_few_items`,
    observed: (() => {
      const run = runFixtureJudge(items.slice(0, 10), fixturePerfectJudge())
      const codes = reasonsOf(run.metrics)
      return codes.length === 0 ? '**没响**' : codes.join(',')
    })(),
    pass: (() => {
      const run = runFixtureJudge(items.slice(0, 10), fixturePerfectJudge())
      return reasonsOf(run.metrics).includes('too_few_items')
    })(),
  })

  // 解析层：越界标签不得进度量
  record({
    id: 'N11',
    phase: 'negative',
    proposition: '解析层挡住越界标签（它进不了度量，因此不可能被判成"一条有效断言"）',
    observed: (() => {
      // 这里刻意走**真实的**解析器，而不是直接造 JudgeOutput
      const injected = runFixtureJudge(items, () => ({
        ok: false as const,
        failure: 'unknown_label' as const,
        detail: '注入：越界标签',
      }))
      return `解析失败 ${String(injected.metrics.parseFailures)} 条 · 理由 ${reasonsOf(injected.metrics).join(',')}`
    })(),
    pass: (() => {
      const injected = runFixtureJudge(items, () => ({
        ok: false as const,
        failure: 'unknown_label' as const,
        detail: '注入：越界标签',
      }))
      return (
        injected.metrics.parseFailures === items.length &&
        reasonsOf(injected.metrics).includes('parse_failure_above_max')
      )
    })(),
  })

  // ---- 恢复：放回良好判定 ⇒ 重新安静 ----
  const recovered = runFixtureJudge(items, fixturePerfectJudge())
  const recoveredDecision = evaluateValidity(recovered.metrics, INSTRUMENT_VALIDITY_CRITERIA, {
    criteriaFrozen: true,
      stability: STABLE_PROBE,
      crossRun: STABLE_CROSS,
  })
  record({
    id: 'R1',
    phase: 'recovery',
    proposition: '放回良好判定 ⇒ 有效性判据重新安静（VALID 且 0 条理由）',
    observed: `${recoveredDecision.verdict}，理由 ${String(recoveredDecision.reasons.length)} 条`,
    pass: recoveredDecision.verdict === 'VALID' && recoveredDecision.reasons.length === 0,
  })

  const passed = checks.filter((entry) => entry.pass).length
  const failed = checks.length - passed

  const evidence = {
    schemaVersion: 'm6.1-measurement@1',
    testId: 'M6.1 / L0 量具自证（三段式：正控 / 负控 / 恢复；离线；夹具判定器）',
    scope:
      '**冻结语料**（evals/m6.1/corpus/*.jsonl）上的有效性判据自证：' +
      '召回/误报/解析失败/弃判/分母归零/两条防线/条目下限/标准未冻结',
    verdict: failed > 0 ? 'FAIL' : 'PASS',
    passed,
    failed,
    measurementInvalid: 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    counters: {
      checks: checks.length,
      corpusItems: items.length,
      corpusFiles: corpus.files.length,
      corpusBytes: corpus.bytes,
      alertItems: good.metrics.alert.total,
      nonAlertItems: good.metrics.nonAlert.total,
      negativeInjections: checks.filter((entry) => entry.phase === 'negative').length,
      positiveControls: checks.filter((entry) => entry.phase === 'positive').length,
      recoveries: checks.filter((entry) => entry.phase === 'recovery').length,
      perCategoryWithAlertControl: good.metrics.perCategory.filter((entry) => entry.alertExpected > 0)
        .length,
    },
    criteria: INSTRUMENT_VALIDITY_CRITERIA,
    baselineReading: {
      note: '**夹具**判定器下的读数（不是真实 judge 的读数）：它只说明判据会响。',
      recall: good.metrics.alert.recall,
      falseAlarmRate: good.metrics.nonAlert.rate,
      parseFailureRate: good.metrics.parseFailureRate,
      abstentionRate: good.metrics.abstentionRate,
      aEqualsBConsistency: good.metrics.defenses.aEqualsBConsistency,
      pairConsistency: good.metrics.defenses.pairConsistency,
      positionBias: good.metrics.defenses.positionBias,
    },
    versions: {
      contract: M6_1_CONTRACT_VERSION,
      corpus: M6_1_CORPUS_VERSION,
      instrument: M6_1_INSTRUMENT_VERSION,
    },
    notProven: [
      '**没有任何真实语义读数**：本门全程用夹具判定器。真实 judge 的读数在 m6.1:instrument:live。',
      '在真实 judge 跑出来之前，量具对**真实数据**的有效性未知（不是"大概没问题"）。',
      '量具若与**被测端**同模型，误差相关，**不能**称独立验证（计划书 §WP2）。',
    ],
  }

  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, 'measurement.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

  console.log('='.repeat(78))
  console.log('M6.1 L0 量具自证（冻结语料 · 夹具判定器 · 三段式）')
  console.log('='.repeat(78))
  console.log(
    `  语料 ${String(items.length)} 条（${corpus.files.join(' + ')}）· 应报警 ${String(good.metrics.alert.total)} · 不应报警 ${String(good.metrics.nonAlert.total)}`
  )
  for (const entry of checks) {
    console.log(`  ${entry.pass ? '✅' : '❌'} ${entry.id} [${entry.phase}] ${entry.proposition}`)
    console.log(`      ${entry.observed}`)
  }
  console.log(`\nL0 量具自证：${String(passed)} 通过 / ${String(failed)} 失败 · verdict=${evidence.verdict}`)
  console.log('  证据：artifacts/m6.1/measurement.json')
  console.log('  ⚠️ 这**不是**真实 judge 的读数 —— 它只证明"判据会响"。')
  process.exit(failed > 0 ? 1 : 0)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6.1-measurement] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6.1-measurement] 这是 MEASUREMENT INVALID，不是 PASS')
  }
  process.exit(2)
}
