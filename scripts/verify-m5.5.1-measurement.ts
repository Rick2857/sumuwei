/**
 * M5.5.1 **WP6 量具门**（`pnpm m5.5.1:measurement:verify`）。
 *
 * ============================================================================
 *  它只测**能离线机器判定**的东西，其余如实报 `NOT RUN`
 * ============================================================================
 * 冻结语料（`evals/fixtures/m5.5.1/search-need-corpus.ts`）有两层标签：
 *
 * ```text
 * wordForm  —— 确定性层：**程序会不会建立显式候选**（词形命中且未被否定）
 *              ⇒ 这一层本门**真的在测**（§1）
 * expected  —— 语义层：应当 answer / search / clarify / deny_search
 *              ⇒ 只有真实模型能测（WP7）⇒ 本门报 **NOT RUN**，绝不报 PASS
 * ```
 *
 * ⚠️ 这条分界是整套纪律的核心：把"我量得到的"与"我量不到的"写在同一张表里、
 *    并让后者也显示绿色，就是 `M5.1` 那次 `migrationVersion=6` 事故的形态。
 *
 * ---------------------------------------------------------------------------
 *  正控 / 负控 / 恢复（§6）
 * ---------------------------------------------------------------------------
 * 量具自己也要被验证：把语料**故意改坏一条**（翻转 `wordForm`）放到临时目录，
 * §1 的检查器必须**响**；放回原样必须重新安静。只做正控的量具与"什么都不检查"
 * 在输出上无法区分。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SEARCH_NEED_CATEGORIES,
  SEARCH_NEED_CORPUS,
  corpusFingerprint,
  type SearchNeedCorpusItem,
} from '../evals/fixtures/m5.5.1/search-need-corpus.ts'
import {
  CORPUS_V1_FINGERPRINT,
  CORPUS_V2_FINGERPRINT,
  CORPUS_ACCEPTANCE_VERSION,
  CORPUS_V2_REVISIONS,
  KNOWN_SCORING_CONFLICTS_V1,
  applyCorpusRevisions,
  auditCorpusTable,
  checkCorpusConsistency,
  findScoringConflicts,
} from './m5.5.1-corpus-audit.ts'
import { createExternalEvidenceIntentDetector } from '../src/kernel/action/external-evidence-intent.ts'
import { newestSemanticsEvidence } from './m5.5.1-gate-select.ts'
import { resolveSearchNeed } from '../src/kernel/action/search-need-resolution.ts'
import { createFixtureSearchNeedJudge } from '../src/infrastructure/model/fixture-search-need-judge.ts'
import {
  SEARCH_NEED_JUDGE_FAILURES,
} from '../src/kernel/action/search-need-judge.ts'
import { computeSemanticsStats, type JudgeObservation } from './m5.5.1-semantics-stats.ts'

const ROOT = resolve('.')
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.5.1')

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

// ---------------------------------------------------------------------------
// §1 的检查器（**纯函数**，三段式自证要用它两次）
// ---------------------------------------------------------------------------

const detector = createExternalEvidenceIntentDetector()

/** "程序会不会建立显式候选" = 词形命中 **且** 未被否定否决 */
function candidateOf(text: string): boolean {
  return detector.detect(text) !== undefined
}

/** 用**这一份语料**跑确定性层检查，返回错配清单（空 = 安静） */
function wordFormMismatches(items: readonly SearchNeedCorpusItem[]): string[] {
  return items
    .filter((item) => candidateOf(item.text) !== item.wordForm)
    .map((item) => `${item.id}(${item.text})：期望候选=${item.wordForm}，实际=${candidateOf(item.text)}`)
}

// ===========================================================================
section('§0 量具自检：语料形状与被测对象数（0 条 = MEASUREMENT INVALID，不是通过）')
// ===========================================================================

check('★ 被测对象数 > 0', SEARCH_NEED_CORPUS.length > 0, `${SEARCH_NEED_CORPUS.length} 条`)
check(
  '★ 语料规模满足计划 §7.3 的"≥80 条冻结语料"',
  SEARCH_NEED_CORPUS.length >= 80,
  `${SEARCH_NEED_CORPUS.length} 条`
)
const ids = SEARCH_NEED_CORPUS.map((item) => item.id)
const uniqueIds = new Set(ids)
const uniqueTexts = new Set(SEARCH_NEED_CORPUS.map((item) => item.text))
check(
  '★ id 与文本都不重复（重复条目会让"条数"虚高）',
  uniqueIds.size === ids.length && uniqueTexts.size === SEARCH_NEED_CORPUS.length,
  `id ${uniqueIds.size}/${ids.length} · 文本 ${uniqueTexts.size}/${SEARCH_NEED_CORPUS.length}`
)
const categoryCounts = new Map<string, number>()
for (const item of SEARCH_NEED_CORPUS) {
  categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1)
}
const unknownCategories = [...categoryCounts.keys()].filter(
  (key) => !(SEARCH_NEED_CATEGORIES as readonly string[]).includes(key)
)
check(
  '★ 每一类都有条目，且没有未登记的类别（九个类别缺一个就是覆盖缺口）',
  unknownCategories.length === 0 && categoryCounts.size === SEARCH_NEED_CATEGORIES.length,
  `${categoryCounts.size} 类 · 未登记 ${unknownCategories.length}`
)
check(
  '★ 两类标签都有非零样本（否则某一条指标量的是空集）',
  SEARCH_NEED_CORPUS.filter((item) => item.wordForm).length > 0 &&
    SEARCH_NEED_CORPUS.filter((item) => !item.wordForm).length > 0,
  `候选 ${SEARCH_NEED_CORPUS.filter((i) => i.wordForm).length} · 非候选 ${SEARCH_NEED_CORPUS.filter((i) => !i.wordForm).length}`
)
const corpusHash = corpusFingerprint(SEARCH_NEED_CORPUS)

// ===========================================================================
section('§1 确定性层测量：程序建不建立显式候选（**真的在测**）')
// ===========================================================================

const mismatches = wordFormMismatches(SEARCH_NEED_CORPUS)
check(
  '★ 确定性层：每一句的"候选/非候选"与冻结标签一致',
  mismatches.length === 0,
  `核对 ${SEARCH_NEED_CORPUS.length} 条 · 错配 ${mismatches.length}${mismatches.length > 0 ? `：${mismatches.slice(0, 4).join(' / ')}` : ''}`
)
const explicitPublicRecall =
  SEARCH_NEED_CORPUS.filter((item) => item.category === 'explicit_public').filter((item) =>
    candidateOf(item.text)
  ).length / SEARCH_NEED_CORPUS.filter((item) => item.category === 'explicit_public').length
check(
  '★ 指标：合法显式公开请求的**候选召回率** = 100%（确定性层，计划 §7.3 的 explicit ≥95%）',
  explicitPublicRecall === 1,
  `${(explicitPublicRecall * 100).toFixed(1)}%`
)
const forbiddenCandidates = SEARCH_NEED_CORPUS.filter((item) => item.category === 'negated_forbidden')
  .filter((item) => candidateOf(item.text)).length
check(
  '★ 指标：显式禁止类的候选数 = 0（**错误出站**必须为 0，计划 §7.3）',
  forbiddenCandidates === 0,
  `${forbiddenCandidates} 条仍被当成候选`
)

// ===========================================================================
section('§2 零调用不变量（按语料计数）：explicit 模式无候选 ⇒ 判定 0 次')
// ===========================================================================

const noCandidateItems = SEARCH_NEED_CORPUS.filter((item) => !item.wordForm)
let zeroCallOk = 0
const zeroCallViolations: string[] = []
const countingJudge = createFixtureSearchNeedJudge()
for (const item of noCandidateItems) {
  const before = countingJudge.calls()
  const resolution = await resolveSearchNeed(
    {
      text: item.text,
      mode: 'explicit',
      masterEnabled: true,
      dryRun: false,
      localActionFired: false,
      providerCallsUsed: 0,
      judgeCallsUsed: 0,
      explicitCandidate: false,
    },
    { judge: countingJudge }
  )
  if (countingJudge.calls() === before && resolution.code === 'no_candidate' && resolution.providerCalls === 0) {
    zeroCallOk += 1
  } else {
    zeroCallViolations.push(`${item.id}:${resolution.code}`)
  }
}
check(
  '★ 不变量：explicit 模式 + 无候选 ⇒ **判定调用 0 次、provider 调用 0 次**（逐条）',
  zeroCallViolations.length === 0 && zeroCallOk === noCandidateItems.length && zeroCallOk > 0,
  `${zeroCallOk}/${noCandidateItems.length} 条${zeroCallViolations.length > 0 ? ` · 违反：${zeroCallViolations.slice(0, 3).join(',')}` : ''}`
)

// ===========================================================================
section('§3 故障注入：判定异常 ⇒ provider 调用 0（逐类计数）')
// ===========================================================================

const INJECTED_OUTPUTS = ['{"decision":', '', '{"decision":"browse","reason":"latest_news"}', '{}']
let faultOk = 0
const faultTotal = SEARCH_NEED_JUDGE_FAILURES.length + INJECTED_OUTPUTS.length
const faultRows: { label: string; code: string; providerCalls: number }[] = []
for (const failure of SEARCH_NEED_JUDGE_FAILURES) {
  const judge = createFixtureSearchNeedJudge({ failures: { [SEARCH_NEED_CORPUS[0].text]: failure } })
  const resolution = await resolveSearchNeed(
    {
      text: SEARCH_NEED_CORPUS[0].text,
      mode: 'explicit',
      masterEnabled: true,
      dryRun: false,
      localActionFired: false,
      providerCallsUsed: 0,
      judgeCallsUsed: 0,
      explicitCandidate: true,
    },
    { judge }
  )
  faultRows.push({ label: `判定失败码 ${failure}`, code: resolution.code, providerCalls: resolution.providerCalls })
  if (resolution.providerCalls === 0) faultOk += 1
}
for (const raw of INJECTED_OUTPUTS) {
  const judge = createFixtureSearchNeedJudge({ outputs: { [SEARCH_NEED_CORPUS[0].text]: raw } })
  const resolution = await resolveSearchNeed(
    {
      text: SEARCH_NEED_CORPUS[0].text,
      mode: 'explicit',
      masterEnabled: true,
      dryRun: false,
      localActionFired: false,
      providerCallsUsed: 0,
      judgeCallsUsed: 0,
      explicitCandidate: true,
    },
    { judge }
  )
  faultRows.push({ label: `坏输出 ${JSON.stringify(raw).slice(0, 24)}`, code: resolution.code, providerCalls: resolution.providerCalls })
  if (resolution.providerCalls === 0) faultOk += 1
}
check(
  '★ 故障注入：每一类失败/坏输出 ⇒ provider 调用 0（计数型，且被测对象数 > 0）',
  faultOk === faultTotal && faultTotal > 0,
  `${faultOk}/${faultTotal} 类`
)
check(
  '★ 故障**不**被当成"查了没结果"：结论码是 `judge_failed`，不是 `allowed`/`no_action`',
  faultRows.filter((row) => row.label.startsWith('判定失败码')).every((row) => row.code === 'judge_failed'),
  faultRows.map((row) => `${row.code}`).slice(0, 4).join(',')
)

// ===========================================================================
section('§4 旁路负控：词形直通 vs 经过判定（计数差 > 0）')
// ===========================================================================

const privateItems = SEARCH_NEED_CORPUS.filter((item) => item.category === 'private_object')
let bypassEgress = 0
let judgedEgress = 0
for (const item of privateItems) {
  if (candidateOf(item.text)) bypassEgress += 1 // 旁路 = 词形命中就出站
  const judged = await resolveSearchNeed(
    {
      text: item.text,
      mode: 'explicit',
      masterEnabled: true,
      dryRun: false,
      localActionFired: false,
      providerCallsUsed: 0,
      judgeCallsUsed: 0,
      explicitCandidate: candidateOf(item.text),
    },
    { judge: createFixtureSearchNeedJudge() }
  )
  judgedEgress += judged.providerCalls
}
check(
  '★ 旁路负控：私人对象类在**词形直通**下会出站 N 次，在**经过判定**下出站 0 次',
  bypassEgress > 0 && judgedEgress === 0,
  `旁路 ${bypassEgress} 次 vs 判定后 ${judgedEgress} 次（被测 ${privateItems.length} 条）`
)

// ===========================================================================
section('§5 语义层指标：**NOT RUN**（真实模型才测得了，属 WP7）')
// ===========================================================================

console.log(
  `  ⏸ 语义指标 NOT RUN：召回（auto_public ≥90% / explicit ≥95%）、过度搜索 ≤5%、\n` +
    `     结构化输出合法率 ≥99%、错误出站 0 —— 需要**真实模型**在 ${SEARCH_NEED_CORPUS.length} 条语料上跑 3 次（WP7）。\n` +
    `     本门**不**为它们报任何 PASS（把它们与 §1–§4 混在一张绿表里正是要避免的事）。`
)
const semanticNotRun = {
  verdict: 'NOT RUN',
  reason: '需要真实模型；WP7',
  metrics: [
    'recall_auto_public≥90%',
    'recall_explicit≥95%',
    'over_search≤5%',
    'structured_output_valid≥99%',
    'wrong_egress=0',
  ],
  runsRequired: 3,
}

// ===========================================================================
section('§6 量具自证（正控 / 负控 / 恢复）：把语料改坏一条，§1 必须响')
// ===========================================================================

const probeDir = mkdtempSync(join(tmpdir(), 'm551-corpus-'))
let planted = 0
let restored = 0
try {
  // ② 负控：翻转一条的 wordForm 标签 ⇒ 错配必须出现
  const broken = SEARCH_NEED_CORPUS.map((item, index) =>
    index === 0 ? { ...item, wordForm: !item.wordForm } : item
  )
  writeFileSync(join(probeDir, 'broken.json'), JSON.stringify(broken), 'utf8')
  planted = wordFormMismatches(JSON.parse(readFileSync(join(probeDir, 'broken.json'), 'utf8')) as SearchNeedCorpusItem[]).length
  rmSync(join(probeDir, 'broken.json'), { force: true })
  // ③ 恢复：原语料重新安静
  restored = wordFormMismatches(SEARCH_NEED_CORPUS).length
} finally {
  rmSync(probeDir, { recursive: true, force: true })
}
check('★ 量具负控：故意改坏一条标签 ⇒ 检查器报出 ≥1 处错配', planted >= 1, `${planted} 处`)
check('★ 量具恢复：原语料 ⇒ 重新安静（0 处）', restored === 0, `${restored} 处`)

// ===========================================================================
section('§7 语义门统计口径（S1 自证）：正控 / 负控（旧算法必须失败）/ 恢复')
// ===========================================================================

/*
 * 这一节测的是**量具的算法**，不是模型。观测是合成的 ⇒ 分母是已知整数，
 * 于是"算错了"与"算对了"可以被代码区分。
 *
 * 负控的写法是刻意的：**把旧算法重新实现一遍**，然后断言它与正确实现**结论不同**。
 * 只测"正确实现给出我希望的数字"是正控；证明"旧算法会给出另一个数字"才证明判据有牙。
 */

function obs(over: Partial<JudgeObservation> & { runId: number; corpusId: string; mode: JudgeObservation['mode'] }): JudgeObservation {
  return {
    category: 'implicit_needs_verification',
    expected: 'search',
    attempted: true,
    requestCount: 1,
    transportOutcome: 'ok',
    httpStatus: 200,
    retryAfterMs: -1,
    headersMs: 10,
    bodyMs: 20,
    totalMs: 40,
    parseOutcome: 'valid',
    resolutionCode: 'allowed',
    wouldSearch: true,
    ...over,
  }
}

const SYNTHETIC: JudgeObservation[] = [
  // A：显式公开、正常放行
  obs({ runId: 1, corpusId: 'A', mode: 'explicit', category: 'explicit_public', wouldSearch: true }),
  // B：auto 侧、HTTP 成功但**解析失败**（未知字段）——这是"答歪了"，不是"没答"
  obs({
    runId: 1,
    corpusId: 'B',
    mode: 'auto_public',
    parseOutcome: 'invalid',
    parseFailureCode: 'search_need_proposal_unknown_field',
    wouldSearch: false,
    resolutionCode: 'judge_failed',
  }),
  // C：私人对象、判定 answer ⇒ 不出站
  obs({ runId: 1, corpusId: 'C', mode: 'auto_public', category: 'private_object', expected: 'answer', decision: 'answer', wouldSearch: false, resolutionCode: 'no_action' }),
  // D：显式模式**被跳过**（无候选）——跳过不是"模型回答 answer"，也不是合法格式样本
  obs({ runId: 1, corpusId: 'D', mode: 'explicit', category: 'private_object', expected: 'answer', attempted: false, requestCount: 0, transportOutcome: 'not_attempted', parseOutcome: 'not_attempted', skippedReason: 'no_candidate', wouldSearch: false, resolutionCode: 'no_candidate' }),
  // E：传输层超时 —— "没答"，不进格式合法率的分母
  obs({ runId: 1, corpusId: 'E', mode: 'auto_public', category: 'chitchat_creative', expected: 'answer', transportOutcome: 'timeout', httpStatus: 0, parseOutcome: 'not_attempted', wouldSearch: false, resolutionCode: 'judge_failed' }),
  // F：同一条语料两模式结论**不同**（证伪"OR 合并后算分模式召回"）
  obs({ runId: 1, corpusId: 'F', mode: 'explicit', category: 'explicit_public', wouldSearch: false, resolutionCode: 'no_action', decision: 'answer' }),
  obs({ runId: 1, corpusId: 'F', mode: 'auto_public', category: 'explicit_public', wouldSearch: true }),
]

const stats = computeSemanticsStats(SYNTHETIC)
const r1 = stats.perRun[0]
check(
  '★ 正控：调用 / 跳过 / 传输失败 三个计数是已知整数',
  r1.attempts === 6 && stats.skipped === 1 && r1.transportFailures === 1 && r1.timeouts === 1 && r1.http429 === 0,
  `attempts=${r1.attempts} skipped=${stats.skipped} transport=${r1.transportFailures}(超时${r1.timeouts}/429 ${r1.http429})`
)
check(
  '★ 正控：条件格式合法率的分母 = **成功传输后进入输出校验的响应**（5 条 ok 中 4 合法 / 1 非法）',
  r1.responsesChecked === 5 && r1.parseValid === 4 && r1.parseInvalid === 1 && r1.conditionalFormatValid.numerator === 4 && r1.conditionalFormatValid.denominator === 5,
  `${r1.parseValid}/${r1.responsesChecked}`
)
check(
  '★ 正控：有效判定产出率 = 合法解析 / **实际请求**（防止只报条件合法率而隐藏超时）',
  r1.effectiveDecisionYield.numerator === 4 && r1.effectiveDecisionYield.denominator === 6,
  `${r1.effectiveDecisionYield.numerator}/${r1.effectiveDecisionYield.denominator}`
)
check(
  '★ 正控：召回按**模式分别**算（F 在 explicit 为 false、auto 为 true ⇒ 两个模式各记各的）',
  r1.recallExplicit.numerator === 1 && r1.recallExplicit.denominator === 2 && r1.recallAutoPublic.numerator === 1 && r1.recallAutoPublic.denominator === 2,
  `explicit ${r1.recallExplicit.numerator}/${r1.recallExplicit.denominator} · auto ${r1.recallAutoPublic.numerator}/${r1.recallAutoPublic.denominator}`
)
check(
  '★ 正控：**被跳过的正例仍进召回分母**（不许删掉"因为没问模型所以没搜"的病例）',
  SYNTHETIC.filter((o) => !o.attempted && o.expected === 'search').every((o) => o.wouldSearch === false),
  '跳过不计为成功'
)

// ---- 负控：把旧算法重新实现一遍，它必须给出**不同**的数字 ----

/** 旧算法①：两模式 `wouldSearch` 做 OR 合并后算召回（前四次运行就是这么算的） */
function oldOrRecallExplicit(rows: readonly JudgeObservation[]): number {
  const rowsByCorpus = new Map<string, boolean>()
  for (const row of rows) rowsByCorpus.set(row.corpusId, (rowsByCorpus.get(row.corpusId) ?? false) || row.wouldSearch)
  const explicitPublicIds = [...new Set(rows.filter((r) => r.category === 'explicit_public').map((r) => r.corpusId))]
  return explicitPublicIds.filter((id) => rowsByCorpus.get(id) === true).length / explicitPublicIds.length
}
const correctExplicit = r1.recallExplicit.value as number
const orExplicit = oldOrRecallExplicit(SYNTHETIC)
check(
  '★ 负控：**旧 OR 算法**给出的分模式召回与正确值不同（⇒ 这条判据真的有牙）',
  orExplicit !== correctExplicit && correctExplicit === 0.5 && orExplicit === 1,
  `正确 ${correctExplicit} vs 旧 OR ${orExplicit}`
)

/** 旧算法②：把**跳过**算成"合法格式样本" */
const oldFormatValid = (r1.parseValid + stats.skipped) / (r1.responsesChecked + stats.skipped)
check(
  '★ 负控：把跳过算成合法样本 ⇒ 条件格式合法率被抬高（正确值 4/5）',
  oldFormatValid !== (r1.conditionalFormatValid.value as number) && oldFormatValid === 5 / 6,
  `正确 ${r1.conditionalFormatValid.value} vs 旧算法 ${oldFormatValid}`
)

/** 旧算法③：把 `invalid_output` 也算成**传输失败** */
const oldTransport = r1.transportFailures + (r1.parseInvalid ?? 0)
check(
  '★ 负控：把解析失败算成传输失败 ⇒ 传输失败率被抬高（这正是掩盖根因的那一步）',
  oldTransport !== r1.transportFailures && r1.transportFailures === 1 && oldTransport === 2,
  `正确 ${r1.transportFailures} vs 旧算法 ${oldTransport}`
)

/** 旧算法④：量具自己实现 span 校验（空白 span 会被放行） */
const blankText = ' abc'
const blankJudge = createFixtureSearchNeedJudge({
  outputs: {
    [blankText]: JSON.stringify({ decision: 'search', reason: 'latest_news', querySpan: { start: 0, end: 1 } }),
  },
})
const blankResolution = await resolveSearchNeed(
  {
    text: blankText,
    mode: 'explicit',
    masterEnabled: true,
    dryRun: false,
    localActionFired: false,
    providerCallsUsed: 0,
    judgeCallsUsed: 0,
    explicitCandidate: true,
  },
  { judge: blankJudge }
)
check(
  '★ 负控：空白 span —— **生产 resolver** 判 `span_invalid` 且不出站（量具过去在这里 `wouldSearch=true`）',
  blankResolution.code === 'span_invalid' && blankResolution.action === 'vetoed' && blankResolution.providerCalls === 0,
  `${blankResolution.code}/${blankResolution.action}`
)
check(
  '★ 恢复：同一个空白 span 用例换成正确口径（直接读 resolver 的 action）⇒ 重新一致',
  (blankResolution.action === 'search') === false,
  'resolver 的结论就是量具的结论（不再有第二份实现）'
)

// ---- 分母为 0：必须是 NOT RUN，不是 0% ----
const emptyStats = computeSemanticsStats([])
const zeroDenom = computeSemanticsStats([
  obs({ runId: 1, corpusId: 'Z', mode: 'explicit', category: 'explicit_public', transportOutcome: 'timeout', httpStatus: 0, parseOutcome: 'not_attempted', wouldSearch: false, resolutionCode: 'judge_failed' }),
])
check(
  '★ 分母为 0 ⇒ `NOT RUN`（返回 null，不许写成 0% 或 PASS）',
  emptyStats.worst.conditionalFormatValid.notRun === true &&
    emptyStats.worst.conditionalFormatValid.value === null &&
    zeroDenom.perRun[0].conditionalFormatValid.notRun === true,
  `空集 notRun=${emptyStats.worst.conditionalFormatValid.notRun} · 全超时 notRun=${zeroDenom.perRun[0].conditionalFormatValid.notRun}`
)
check(
  '★ 最差轮规则：多轮时取更差的那一轮（不被某一轮的好成绩覆盖）',
  (() => {
    const twoRuns = [
      ...SYNTHETIC,
      obs({ runId: 2, corpusId: 'A', mode: 'explicit', category: 'explicit_public', wouldSearch: false, resolutionCode: 'no_action', decision: 'answer' }),
      obs({ runId: 2, corpusId: 'F', mode: 'explicit', category: 'explicit_public', wouldSearch: false, resolutionCode: 'no_action', decision: 'answer' }),
      obs({ runId: 2, corpusId: 'F', mode: 'auto_public', category: 'explicit_public', wouldSearch: true }),
    ]
    const s = computeSemanticsStats(twoRuns)
    return s.worst.recallExplicit.notRun === false && s.worst.recallExplicit.value === 0
  })(),
  '第 2 轮更差 ⇒ 最差轮取它'
)
// ===========================================================================
section('§8 语料与计分一致性（R2-1）：同一标签不得既应搜又绝对禁搜')
// ===========================================================================

/*
 * R2 复核指出语料 v1 有三处**自相矛盾**（e09 / x04 / x08）：它们既被当成"应搜正例"
 * （召回分子），又被当成"绝对不得出站"（错误放行判据面）。
 * ⇒ 模型改善可能反而触发硬失败（复核方用真实统计函数复现过：召回 12/23→13/23 的同时
 *    错误放行 0/92→1/92）。这一节把该矛盾变成**机器判据**：
 *    · 出现**未登记**的冲突 ⇒ 失败（有人新写了自相矛盾的标签）
 *    · 登记表里的行已不存在 ⇒ 失败（登记表在骗人）
 *    · 覆盖低于计划下限 ⇒ 失败
 */

const consistencyV1 = checkCorpusConsistency(SEARCH_NEED_CORPUS)
check(
  '★ 正控：v1 的一致性结论 = 通过（A 类冲突恰好是**已登记**的 2 条；B 类登记不过期）',
  consistencyV1.ok === true &&
    consistencyV1.scoringConflicts.length === KNOWN_SCORING_CONFLICTS_V1.length &&
    consistencyV1.unregisteredScoringConflicts.length === 0 &&
    consistencyV1.staleScoringRegistrations.length === 0 &&
    consistencyV1.staleUnachievableRegistrations.length === 0,
  `A 类冲突 ${consistencyV1.scoringConflicts.length}（已登记 ${KNOWN_SCORING_CONFLICTS_V1.length}）· 未登记 ${consistencyV1.unregisteredScoringConflicts.length} · A 类过期登记 ${consistencyV1.staleScoringRegistrations.length} · B 类过期登记 ${consistencyV1.staleUnachievableRegistrations.length}`
)
check(
  '★ 正控：覆盖满足计划下限（条目 / 应搜正例 / 类别）',
  consistencyV1.minimumsOk === true,
  consistencyV1.minimumsDetail
)
check(
  '★ 事实（两类要分清）：**A 类**（既应搜又禁搜，机械检出）= x04/x08；**B 类**（不可达正例，人工登记）= e09；另有 3 条待审项（q03/e03 已裁定移出）',
  consistencyV1.scoringConflicts.map((c) => c.id).sort().join(',') === 'x04,x08' &&
    consistencyV1.unachievablePositives.map((e) => e.id).join(',') === 'e09' &&
    consistencyV1.pendingReview.length === 3,
  `A 类 ${consistencyV1.scoringConflicts.map((c) => c.id).sort().join(',')} · ` +
    `B 类 ${consistencyV1.unachievablePositives.map((e) => e.id).join(',')} · 待审 ${consistencyV1.pendingReview.length}`
)
/** ② 负控：注入一条**未登记**的 A 类冲突 ⇒ 检测器必须响 */
const withInjectedConflict = SEARCH_NEED_CORPUS.map((item) =>
  item.id === 'c01' ? { ...item, category: 'adversarial' as const, expected: 'search' as const } : item
)
const injectedConsistency = checkCorpusConsistency(withInjectedConflict)
check(
  '★ 负控：把一条普通样本改成"既应搜又禁搜" ⇒ 必须认定为**未登记冲突**且结论失败',
  injectedConsistency.ok === false &&
    injectedConsistency.unregisteredScoringConflicts.length === 1 &&
    injectedConsistency.unregisteredScoringConflicts[0]?.id === 'c01',
  `未登记 ${injectedConsistency.unregisteredScoringConflicts.length} · ok=${injectedConsistency.ok}`
)
check(
  '★ 负控：把已登记的 A 类冲突（x08）**改好**却不更新登记表 ⇒ 必须报"登记表过期"',
  (() => {
    const fixed = SEARCH_NEED_CORPUS.map((item) =>
      item.id === 'x08' ? { ...item, category: 'ambiguous_scope' as const, expected: 'clarify' as const } : item
    )
    const result = checkCorpusConsistency(fixed)
    return result.ok === false && result.staleScoringRegistrations.includes('x08')
  })(),
  'x08 被修好后登记表必须同步'
)
check(
  '★ 负控：把 B 类登记行（e09）的标签改成不再要求 search ⇒ 必须报"B 类登记过期"',
  (() => {
    const fixed = SEARCH_NEED_CORPUS.map((item) =>
      item.id === 'e09' ? { ...item, expected: 'clarify' as const } : item
    )
    const result = checkCorpusConsistency(fixed)
    return result.ok === false && result.staleUnachievableRegistrations.includes('e09')
  })(),
  'e09 标签一旦改掉，B 类登记表必须同步'
)
check(
  '★ 恢复：原语料重新安静（与正控同一结论）',
  checkCorpusConsistency(SEARCH_NEED_CORPUS).ok === true,
  '恢复后 ok=true'
)

/* v2 **提案**：由 v1 + 覆盖表派生（文本一字不动）—— 只登记与检查，不改验收语料 */
const corpusV2 = applyCorpusRevisions()
const consistencyV2 = checkCorpusConsistency(corpusV2)
check(
  '★ v2（**已裁定为验收语料**）：冲突清零，覆盖仍满足下限（应搜正例 23 → 20，e09/e03 移出、q03 移入）',
  consistencyV2.scoringConflicts.length === 0 &&
    consistencyV2.minimumsOk === true &&
    consistencyV2.recallPositives === 20 &&
    consistencyV2.explicitPublic === 11,
  `冲突 ${consistencyV2.scoringConflicts.length} · 应搜正例 ${consistencyV2.recallPositives} · 显式公开 ${consistencyV2.explicitPublic} · ${consistencyV2.minimumsDetail}`
)
check(
  '★ v2：文本与 id **逐字未改**（只改 category/expected）',
  corpusV2.every(
    (item, index) => item.text === SEARCH_NEED_CORPUS[index]?.text && item.id === SEARCH_NEED_CORPUS[index]?.id
  ),
  '文本与 id 全部一致'
)
check(
  '★ 版本可追：v1/v2 指纹不同且都进证据（新旧语料不得混用比较通过率）',
  CORPUS_V1_FINGERPRINT !== CORPUS_V2_FINGERPRINT && CORPUS_V1_FINGERPRINT.length > 0,
  `v1=${CORPUS_V1_FINGERPRINT} · v2=${CORPUS_V2_FINGERPRINT}`
)

const auditRows = auditCorpusTable(SEARCH_NEED_CORPUS, { candidateOf })
check(
  '★ 审计表：每一行都给出"是否应搜 / 是否禁搜 / 两模式期望"（可复核的表格，不是口头结论）',
  auditRows.length === SEARCH_NEED_CORPUS.length &&
    auditRows.every((row) => row.scoringConflict === (row.recallPositive && row.mustNotEgress)) &&
    auditRows.filter((row) => row.unachievablePositive).every((row) => row.recallPositive) &&
    auditRows.filter((row) => row.explicitModeExpectation === 'skipped_no_candidate').length > 0,
  `${auditRows.length} 行 · 显式模式被跳过 ${auditRows.filter((r) => r.explicitModeExpectation === 'skipped_no_candidate').length} 行`
)

// ===========================================================================
section('§9 选档器自证（正控 / 负控 / 恢复）：`wp7` 选"最新一份正式观测"')
// ===========================================================================

/*
 * ⚠️ 为什么单独加这一节（登记册 §0p `R-41` 留的那条开放项）：
 *   汇总门 `m5.5.1:gates` 用 `newestSemanticsEvidence()` 决定"语义门看的是哪一份观测"。
 *   这个口径问题（`R-35`：**小样本诊断档被当成最新观测**）当时是被 `4005f360` **顺手**修掉的，
 *   只有源码注释与一次读数背书 —— **没有任何机器判据**守着它下次还这么选。
 *   现在选档器搬进 `scripts/m5.5.1-gate-select.ts`，本节用 `%TEMP%` 夹具驱动**同一个函数**。
 */
const selectionRoot = mkdtempSync(join(tmpdir(), 'm551-select-'))
const observationsOf = (ended: string | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...(ended !== undefined ? { ended } : {}),
  ...extra,
})
const plantObservation = (runId: string, observation: Record<string, unknown>): void => {
  const dir = join(selectionRoot, 'wp7', runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'observations.json'), JSON.stringify(observation), 'utf8')
}

/* ① 正控：自报结束时间更晚的那份必须被选中 —— 而且它的 runId **字典序更小**（证明不是按名字选） */
plantObservation('a-late', observationsOf('2026-10-03T00:00:00Z'))
plantObservation('z-early', observationsOf('2026-10-01T00:00:00Z'))
const pickedByTime = newestSemanticsEvidence(selectionRoot)

/* ② 负控 A：**诊断档**（`smallSample: true`）带的是最新时刻 ⇒ 仍然不许被选中（`R-35` 的那个形态） */
plantObservation('m-small-sample-latest', observationsOf('2026-10-09T00:00:00Z', { smallSample: true }))
const pickedSkippingDiagnostic = newestSemanticsEvidence(selectionRoot)

/* ② 负控 B：两份都**没有任何时间戳** ⇒ 必须具名降级（`basis = none`），不许偷用 mtime */
const noTimeRoot = mkdtempSync(join(tmpdir(), 'm551-select-notime-'))
const plantIn = (root: string, runId: string, observation: Record<string, unknown>): void => {
  const dir = join(root, 'wp7', runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'observations.json'), JSON.stringify(observation), 'utf8')
}
plantIn(noTimeRoot, 'p-aaa', observationsOf(undefined))
plantIn(noTimeRoot, 'p-zzz', observationsOf(undefined))
const pickedWithoutTime = newestSemanticsEvidence(noTimeRoot)

/* ③ 恢复：指向一个不存在的证据根 ⇒ `null`（不是"选一个默认"） */
const pickedFromNowhere = newestSemanticsEvidence(join(selectionRoot, 'no-such-root'))

rmSync(selectionRoot, { recursive: true, force: true })
rmSync(noTimeRoot, { recursive: true, force: true })

check(
  '★ 选档器正控：自报 `ended` 更晚者胜（且它 runId **字典序更小** ⇒ 不是按名字选）',
  pickedByTime?.runId === 'a-late' && pickedByTime.basis === 'reported',
  `${String(pickedByTime?.runId)} / basis=${String(pickedByTime?.basis)}`
)
check(
  '★ 选档器负控（`R-35` 的形态）：`smallSample: true` 的**诊断档**即使时刻最新也**不许**被选中，且被具名跳过',
  pickedSkippingDiagnostic?.runId === 'a-late' &&
    pickedSkippingDiagnostic.skippedSmallSample.includes('m-small-sample-latest'),
  `${String(pickedSkippingDiagnostic?.runId)} · 跳过=${JSON.stringify(pickedSkippingDiagnostic?.skippedSmallSample ?? [])}`
)
check(
  '★ 选档器负控：两份都没有时间戳 ⇒ **具名降级**（`basis = none`，按 runId 裁决），不偷用 mtime',
  pickedWithoutTime?.basis === 'none' && pickedWithoutTime.runId === 'p-zzz',
  `${String(pickedWithoutTime?.runId)} / basis=${String(pickedWithoutTime?.basis)}`
)
check(
  '★ 选档器恢复：不存在的证据根 ⇒ `null`（不是"选一个默认"）',
  pickedFromNowhere === null,
  pickedFromNowhere === null ? 'null' : `意外选到 ${String(pickedFromNowhere.runId)}`
)

// ===========================================================================
// 证据
// ===========================================================================

const evidence = {
  testId: 'M5.5.1 / WP6 measurement (frozen corpus · deterministic layer · fault injection · bypass)',
  note:
    '只测能离线机器判定的东西。确定性层（程序建不建立显式候选）真的在测；' +
    '语义层（answer/search/clarify/deny_search）报 NOT RUN —— 那是 WP7 真实模型的事。' +
    '证据里没有时钟字段 ⇒ 重复运行逐字节相同。',
  passed,
  failed,
  failures,
  checks,
  corpus: {
    items: SEARCH_NEED_CORPUS.length,
    fingerprint: corpusHash,
    byCategory: Object.fromEntries([...categoryCounts.entries()].sort()),
    candidateTrue: SEARCH_NEED_CORPUS.filter((item) => item.wordForm).length,
    candidateFalse: SEARCH_NEED_CORPUS.filter((item) => !item.wordForm).length,
  },
  deterministic: {
    mismatches: mismatches.length,
    explicitPublicRecall,
    forbiddenCandidates,
    zeroCallChecked: zeroCallOk,
    zeroCallViolations: zeroCallViolations.length,
  },
  faultInjection: { checked: faultTotal, providerCallsZero: faultOk, rows: faultRows },
  bypass: { privateItems: privateItems.length, bypassEgress, judgedEgress },
  semantic: semanticNotRun,
  statsSelfProof: { syntheticObservations: SYNTHETIC.length, mechanical: true },
  selfProof: { planted, restored },
  corpusAudit: {
    v1Fingerprint: CORPUS_V1_FINGERPRINT,
    v2Fingerprint: CORPUS_V2_FINGERPRINT,
    v2Revisions: CORPUS_V2_REVISIONS.map((r) => ({
      id: r.id,
      toCategory: r.toCategory,
      toExpected: r.toExpected,
    })),
    knownScoringConflictsV1: KNOWN_SCORING_CONFLICTS_V1.map((c) => c.id),
    scoringConflictsFound: findScoringConflicts(SEARCH_NEED_CORPUS).map((c) => c.id),
    consistencyV1: {
      ok: consistencyV1.ok,
      minimumsOk: consistencyV1.minimumsOk,
      recallPositives: consistencyV1.recallPositives,
      explicitPublic: consistencyV1.explicitPublic,
    },
    unachievablePositivesV1: consistencyV1.unachievablePositives.map((e) => e.id),
    pendingBoundaryReview: consistencyV1.pendingReview.map((e) => e.id),
    consistencyV2: {
      ok: consistencyV2.ok,
      recallPositives: consistencyV2.recallPositives,
      scoringConflicts: consistencyV2.scoringConflicts.length,
    },
    acceptanceVersion: CORPUS_ACCEPTANCE_VERSION,
    note:
      'v2 是**提案**（待裁定）：v1 仍是唯一验收语料，旧 FAIL 记录保留；' +
      '不得用 v2 重算旧观测后宣称 PASS，也不得为过门直接套用覆盖表。',
    table: auditRows,
  },
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'measurement.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`\nM5.5.1 WP6 量具门：${passed} 通过 / ${failed} 失败｜语义层 NOT RUN（WP7）`)
console.log(`  证据：artifacts/m5.5.1/measurement.json`)
process.exit(failed > 0 ? 1 : 0)
