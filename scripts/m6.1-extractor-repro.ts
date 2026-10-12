/**
 * M6.1 **WP5 产品发现 ② 的离线复现器** —— `education.institution` 取值被截成单字。
 *
 * ============================================================================
 *  它复现什么（用户 2026-09-24 裁定：**先离线复现，再改规则**）
 * ============================================================================
 * ```text
 * 真库/沙箱里实测到的落库值：
 *   「记住：我在江城大学读书。」        ⇒ education.institution = 「书」
 *   「更正一下，我转学到明德大学了。」  ⇒ education.institution = 「了」
 * 这两句**不是**编出来的 —— 它们逐字来自冻结条文 `evals/m6.1/control/*.jsonl`
 * （`SRP-A-01` / `SRP-C-03` / `EWP-01`）。
 * ```
 *
 * 机制（`src/kernel/app/memory/content-extractor.ts` 的 `extractFreeTextValue`）：
 * 线索词「大学」之后还有**下一句的动词**（读书 / 了），"往后"那一支把它当成了取值，
 * 再经 `normalizeValuePhrase` 剥掉前导系词表里的「读」⇒ 剩一个「书」。
 * ⚠️ 它**不报错、长度也合理**，所以只能靠"值内容对不对"来发现 —— 正是本脚本干的事。
 *
 * ============================================================================
 *  三段式自证（AGENTS §6.7）
 * ============================================================================
 * ```text
 * 正控  冻结条文里的 7 句（取值在线索词**之前** / **之后** / 线索词本身带"是"）逐句比对期望
 * 负控① 把**旧行为**（`legacyFreeTextValue`）接上 ⇒ 那两句**必须**复现出「书」/「了」
 *        （否则说明这组用例没有分辨力，本脚本就是白跑的）
 * 负控② 把期望值故意写成错的 ⇒ 比对必须报失败（证明比对真的在比）
 * 恢复  再用生产抽取器跑一遍 ⇒ 与正控逐字段相同
 * ```
 *
 * 用法：`pnpm m6.1:extractor:repro`（退出码 0 = 全部符合期望；1 = 有不符合；3 = 自证失败）
 */

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'

const ROOT = resolve(process.cwd())
const extractor = createRuleOnlyContentExtractor()
const USER = entityRef('user', 'wp5-repro-user')

interface Case {
  readonly text: string
  readonly origin: string
  readonly predicate: string
  readonly value: string
  /** 取值相对线索词的位置：用于自检"这组用例两种语序都覆盖到" */
  readonly position: 'before_cue' | 'after_cue'
}

/** ⚠️ 逐字来自冻结条文；**不要**在这里加"顺手想到的句子"（那会变成对着实现调参） */
const CASES: readonly Case[] = [
  {
    text: '记住：我在江城大学读书。',
    origin: 'SRP-A-01 / EWP-01 的 setup',
    predicate: 'education.institution',
    value: '江城大学',
    position: 'before_cue',
  },
  {
    text: '更正一下，我转学到明德大学了。',
    origin: 'SRP-C-03 的第 2 轮',
    predicate: 'education.institution',
    value: '明德大学',
    position: 'before_cue',
  },
  {
    text: '记住：我在示例工程科技大学',
    origin: 'M4 既有断言（verify-m4-persistence）——**不许回归**',
    predicate: 'education.institution',
    value: '示例工程科技大学',
    position: 'before_cue',
  },
  {
    text: '记住，我现在上的大学是示例工程科技大学',
    origin: 'M4 既有真库观察（取值在线索词**之后**，带系词）',
    predicate: 'education.institution',
    value: '示例工程科技大学',
    position: 'after_cue',
  },
  {
    text: '记住：我的专业是汉语言文学。',
    origin: 'SRP-C-04 / EWP-02 的 setup',
    predicate: 'education.major',
    value: '汉语言文学',
    position: 'after_cue',
  },
  {
    text: '我学的是计算机',
    origin: 'M4 既有断言（线索词本身以「是」结尾）',
    predicate: 'education.major',
    value: '计算机',
    position: 'after_cue',
  },
  {
    text: '记住：我平时用的是 Windows 笔记本。',
    origin: 'SRP-C-09 的 setup（防"修大学名时顺手改坏别的自由文本槽位"）',
    predicate: 'device.primary',
    value: 'Windows 笔记本',
    position: 'after_cue',
  },
]

/**
 * ⚠️ **故意保留的旧行为**（负控①）。
 *
 * 它是"往后一支无条件接受"的忠实复制：线索词之后只要非空就返回。
 * 保留它的理由：如果哪天它不再复现「书」/「了」，说明本脚本的用例已经**没有分辨力**，
 * 那时"全绿"只是幻觉（AGENTS §6.8）。
 */
function legacyFreeTextValue(text: string, cue: string): string | undefined {
  const index = text.indexOf(cue)
  if (index < 0) return undefined
  const strip = (input: string): string =>
    input
      .replace(/^[\s，,。.：:；;]+/, '')
      .replace(/[。.！!?？?~～]+$/, '')
      .replace(/^(关于|我|我的)/, '')
      .replace(/^(是|在|叫|为|有|于|读)/, '')
      .replace(/(这件事|这个事情|的偏好|这个偏好|的这件事)$/, '')
      .trim()
  const after = strip(text.slice(index + cue.length))
  if (after !== '' && after.length <= 60) return after
  return undefined
}

async function valueOf(text: string): Promise<{ predicate?: string; value?: unknown; basis?: string }> {
  const result = await extractor.extract({ text, owner: USER, speaker: USER })
  if (result === undefined) return {}
  return {
    predicate: result.predicate,
    value: (result.content as { value?: unknown }).value,
    basis: result.basis,
  }
}

/* ------------------------------- 正控 ----------------------------------- */

const positive: { text: string; origin: string; expected: string; actual: string; predicateOk: boolean; valueOk: boolean }[] = []
for (const testCase of CASES) {
  const outcome = await valueOf(testCase.text)
  positive.push({
    text: testCase.text,
    origin: testCase.origin,
    expected: testCase.value,
    actual: String(outcome.value ?? '(没抽出来)'),
    predicateOk: outcome.predicate === testCase.predicate,
    valueOk: String(outcome.value ?? '') === testCase.value,
  })
}
const positiveOk = positive.every((row) => row.predicateOk && row.valueOk)

/* ------------------------------ 负控① ---------------------------------- */
/*
 * ⚠️ 这里**不**拿"当前抽取器的实际输出"当基准，而是把**已知错值**写成冻结 fixture。
 *    理由：若拿实际输出当基准，修复之后 `buggyCases` 变空 ⇒ 负控自动"不再触发"⇒ 自证失败，
 *    而那会把"修好了"错报成"仪器坏了"。冻结 fixture 在修复前后都必须成立，
 *    它守的是"这组用例对旧行为有分辨力"。
 */
const LEGACY_FIXTURES: readonly { text: string; cue: string; legacyValue: string }[] = [
  { text: '记住：我在江城大学读书。', cue: '大学', legacyValue: '书' },
  { text: '更正一下，我转学到明德大学了。', cue: '大学', legacyValue: '了' },
]
const legacyObserved = LEGACY_FIXTURES.map((row) => ({
  text: row.text,
  legacyValue: row.legacyValue,
  observed: legacyFreeTextValue(row.text, row.cue) ?? '(空)',
}))
const negative1Ok =
  LEGACY_FIXTURES.length > 0 && legacyObserved.every((row) => row.observed === row.legacyValue)

/* ------------------------------ 负控② ---------------------------------- */
/* 比对真的在比：故意把期望值写错 ⇒ 必须报失败 */
const flipped = CASES.map((row) => ({ ...row, value: `${row.value}（故意写错）` }))
let flippedFailures = 0
for (const testCase of flipped) {
  const outcome = await valueOf(testCase.text)
  if (String(outcome.value ?? '') !== testCase.value) flippedFailures += 1
}
const negative2Ok = flippedFailures === flipped.length

/* ------------------------------- 恢复 ----------------------------------- */
const restore: string[] = []
for (const testCase of CASES) {
  const outcome = await valueOf(testCase.text)
  restore.push(`${String(outcome.predicate ?? '?')}=${String(outcome.value ?? '(空)')}`)
}
const positiveSignature = positive.map((row) => `${row.actual}`).join('|')
const restoreSignature = restore.map((entry) => entry.split('=')[1] ?? '').join('|')
const restoreOk = positiveSignature === restoreSignature

/* ------------------------------ 用例自检 -------------------------------- */
const positionsCovered = new Set(CASES.map((row) => row.position))
const coverageOk = positionsCovered.has('before_cue') && positionsCovered.has('after_cue') && CASES.length > 0

/* ------------------------------- 报告 ----------------------------------- */

const failures: string[] = []
if (!coverageOk) failures.push('用例自检失败：必须同时覆盖"取值在线索词之前"与"之后"两种语序')
if (CASES.some((row) => row.value.trim() === '' || row.predicate.trim() === '')) {
  failures.push('用例自检失败：期望的槽位/取值不得为空')
}
/*
 * ⚠️ **自证失败**与**正控不符**是两件事，退出码分开（与判定器同一条纪律）：
 *    自证失败 = 读数不可用（3）；正控不符 = 这是**关于被测对象**的读数（1）。
 */
if (!negative1Ok) failures.push('负控①未触发：旧行为没能复现冻结 fixture 里的错值 ⇒ 这组用例没有分辨力')
if (!negative2Ok) failures.push('负控②未触发：故意写错的期望值没有被判失败 ⇒ 比对没在比')
if (!restoreOk) failures.push('恢复未回到正控读数')

console.log('='.repeat(92))
console.log('M6.1 WP5 产品发现② 离线复现：自由文本槽位的取值边界（零模型调用 · 纯规则抽取器）')
console.log('='.repeat(92))
for (const row of positive) {
  const flag = row.valueOk && row.predicateOk ? 'OK  ' : '**不符**'
  console.log(`  [${flag}] ${row.text}`)
  console.log(`         期望 ${row.expected} · 实际 ${row.actual}（${row.origin}）`)
}
console.log('')
console.log(`  正控 ${positive.filter((row) => row.valueOk && row.predicateOk).length}/${positive.length} 符合期望`)
console.log(
  `  负控① 旧行为仍复现冻结 fixture 的错值：${
    negative1Ok
      ? `是（${legacyObserved.map((row) => `${row.text} ⇒ ${row.observed}`).join(' · ')}）`
      : `**否**（${legacyObserved.map((row) => `${row.text}: 期望旧值 ${row.legacyValue} 实测 ${row.observed}`).join(' · ')}）`
  }`
)
console.log(`  负控② 故意写错的期望值被判失败：${negative2Ok ? `是（${flippedFailures}/${flipped.length}）` : '**否**'}`)
console.log(`  用例自检 语序覆盖：${[...positionsCovered].join(' + ') || '(空)'} · 用例数 ${CASES.length}`)
console.log(`  恢复：${restoreOk ? 'PASS（与正控逐字段相同）' : '**失败**'}`)
console.log('')
console.log(
  positiveOk
    ? '  结论：生产规则抽取器在冻结条文的这 7 句上**取值与槽位都正确**。'
    : '  结论：生产规则抽取器**仍有取值错误**（上表 **不符** 行）⇒ 不得声称发现②已修复。'
)

const evidence = {
  schemaVersion: 'm6.1-extractor-repro@1',
  testId: 'M6.1 / WP5 产品发现② 离线复现（自由文本槽位取值边界）',
  what: '冻结条文里 7 句中文显式记忆 → 规则抽取器的（槽位, 取值）是否符合期望。',
  mechanism:
    'extractFreeTextValue 的"往后"分支在线索词之后还有下一句动词时把它当成了取值（读书→书）；' +
    '修复方向是只在"线索词之后确实是取值引导位置"时才接受往后分支。',
  cases: CASES.map((row) => ({ ...row })),
  positive,
  selfProof: {
    coverage: { positions: [...positionsCovered], cases: CASES.length, ok: coverageOk },
    negative1_legacyReproducesFrozenWrongValues: { fired: negative1Ok, detail: legacyObserved },
    negative2_wrongExpectationFails: { fired: negative2Ok, flippedFailures },
    restore: restoreOk,
  },
  failures,
  verdict: coverageOk && negative1Ok && negative2Ok && restoreOk ? (positiveOk ? 'PASS' : 'FAIL') : 'INCOMPLETE',
  notProven: [
    '只覆盖**规则抽取器**（生产缺省那一份）；模型抽取路径（当前未接线）不在本脚本范围。',
    '只覆盖这 7 句冻结条文与 2 条 M4 既有断言；中文取值边界的**其它**语序没有被本脚本证明。',
    '本脚本**不打开任何数据库**、不调任何模型 ⇒ 它证明的是"规则产出的值对不对"，不是"库里存了什么"。',
  ],
}
writeFileSync(join(ROOT, 'artifacts', 'm6.1', 'extractor-repro.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log('  证据：artifacts/m6.1/extractor-repro.json')

if (failures.length > 0) {
  console.error('\n  ⚠️ 自证失败 ⇒ 读数不可用：')
  for (const message of failures) console.error(`     · ${message}`)
  process.exitCode = 3
} else {
  process.exitCode = positiveOk ? 0 : 1
}
