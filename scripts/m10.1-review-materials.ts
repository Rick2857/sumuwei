/**
 * M10.1 WP7 —— **人审材料生成器**（`m10.1:review:materials`）。
 *
 * ============================================================================
 *  四审题（计划 §2 的 WP7）与它对应的材料
 * ============================================================================
 * ```text
 * ① **识别门槛**   6 条"像约定"的原话（其中**有真有假**）⇒ 问：哪几条应当被记成承诺？
 * ② **结清后是否还提** 把**程序真的渲染出来的**事实块（已结清那档）逐字给出 ⇒ 问：这样够不够"不要再提"？
 * ③ **到期措辞**   `expired` 档的块逐字给出 ⇒ 问：有没有指控感？
 * ④ **越界**      未结清档的块 + 目标状态块的字段面 ⇒ 问：有没有替谁做了超出授权的陈述？
 * ```
 *
 * ============================================================================
 *  三个文件**必须分开**（否则"复核"退化成"确认"）
 * ============================================================================
 * ```text
 * blind-cards.md/.json   盲审卡：**只有** caseId / 题组 / 材料原文 —— **没有**我的结论、没有档位
 * answer-sheet.json      **独立答案单**：caseId → **我的答案与理由**（审阅者先独立判、再对答案）
 * review-protocol.md     两阶段流程 + **请你签**的位置（**本门不代签**）
 * ```
 *
 * ⚠️ **本门最要紧的一条机器判据**：卡片里**不许**出现答案单里的任何结论。
 *    这不是"我记得别写" —— `C2` 会把每张卡片的**全部文本**与答案单里的**每条答案/理由**
 *    做子串比对；`C3` 是它的**负控**（故意造一张带结论的卡片 ⇒ 探测器**必须响**）。
 *    对照 M9 的 F-1：**泄漏从"呈现层顺手多带了一个字段"开始。**
 *
 * ⚠️ 零模型 / 零数据库 / 零出网：只读冻结语料 + 纯渲染器。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import {
  COMMITMENT_DO_NOT_RAISE,
  renderCommitmentStateBlock,
  type CommitmentFactRow,
} from '../src/kernel/app/goal/commitment-facts.ts'
import { renderGoalStateBlock, type GoalContextItem } from '../src/kernel/context/goal-sections.ts'
import type { GoalState } from '../src/kernel/contracts/goal.ts'
import { entityRef } from '../src/kernel/contracts/index.ts'
import { lastAssistantEvidenceOf } from '../src/kernel/context/sections.ts'
import { buildAgreementCorpus } from '../evals/m10.1/agreement-corpus.ts'

const REPO_ROOT = resolve(process.cwd())
const quantify = (text: string): number => [...text].length
const T0 = 1_960_000_000_000

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

/* ---------------------------------------------------------------------------
 * 材料：四组（**材料原文来自程序**，不是手写的结论）
 * ------------------------------------------------------------------------- */
interface Card {
  readonly caseId: string
  readonly section: 'recognition' | 'closure' | 'expiry' | 'boundary'
  readonly question: string
  readonly material: string
}
const cards: Card[] = []

/* ① 识别门槛：约定形状的原话（**其中有真有假**；答案单里才有"我判它算什么"） */
const recognitionProbes: { caseId: string; text: string }[] = [
  { caseId: 'thr-01', text: '明天十点二十五，楼下，带伞和外套。' },
  { caseId: 'thr-02', text: '下次写论文的时候，你先给我三个步骤再动笔。' },
  { caseId: 'thr-03', text: '行，就按你说的来。' },
  { caseId: 'thr-04', text: '我最近在想要不要换个方向。' },
  { caseId: 'thr-05', text: '那你答应了：周五之前把提纲发我。' },
  { caseId: 'thr-06', text: '如果下雨我就不去了。' },
]
for (const probe of recognitionProbes) {
  cards.push({
    caseId: probe.caseId,
    section: 'recognition',
    question: '这一条**该不该**被记成一条"承诺"（带可核对判据、有终态）？请只答该/不该 + 一句理由。',
    material: probe.text,
  })
}

/* ② 结清后是否还提：**程序真的渲染出来的**已结清块（逐字） */
const closedRow: CommitmentFactRow = {
  goalId: 'gol:review-closed',
  scope: '明天十点二十五在楼下见（伞和外套）',
  status: 'fulfilled',
  criterionKind: 'user_report',
}
const closedBlock =
  renderCommitmentStateBlock({ rows: [closedRow], maxTokens: 400, quantify })[0]?.content ?? ''
cards.push({
  caseId: 'clo-01',
  section: 'closure',
  question:
    '这段文字会被放进她的上下文（**逐字**）。以你作为当事人的感受：它**足以**让她不再重复提这件事吗？' +
    '若不足，缺的是什么？',
  material: closedBlock,
})

/* ③ 到期措辞：`expired` 档（逐字；问"有没有指控感"） */
const expiredRow: CommitmentFactRow = {
  goalId: 'gol:review-expired',
  scope: '明天十点二十五在楼下见（伞和外套）',
  status: 'expired',
  criterionKind: 'user_report',
  dueAt: T0,
}
const expiredBlock =
  renderCommitmentStateBlock({ rows: [expiredRow], maxTokens: 400, quantify })[0]?.content ?? ''
cards.push({
  caseId: 'exp-01',
  section: 'expiry',
  question:
    '同上，这段也会进她的上下文。到期这一档的措辞**有没有**"你失约了/你没做到"这类**指控**的味道？' +
    '若你觉得像指控，请指出是哪几个字。',
  material: expiredBlock,
})

/* ④ 越界：未结清档的块 + 目标状态块（字段面） */
const openRow: CommitmentFactRow = {
  goalId: 'gol:review-open',
  scope: '投稿前先把稿子发给她看',
  status: 'active',
  criterionKind: 'user_report',
}
const openBlock =
  renderCommitmentStateBlock({ rows: [openRow], maxTokens: 400, quantify })[0]?.content ?? ''
const goalFixture: GoalState = {
  goalId: 'gol:review-goal' as never,
  characterId: 'char_review',
  owner: entityRef('character', 'char_review'),
  origin: 'user_requested',
  sourceRefs: [{ conversationEventId: 'cev:review-1' as never, fingerprint: 'fp-review' }],
  revision: 1,
  statement: '把提纲写完',
  successCriterion: { kind: 'user_report' },
  status: 'active',
  priority: 'normal',
  dependencies: [],
  time: { recordedAt: T0 },
}
const goalItem: GoalContextItem = { goal: goalFixture, rowKey: `goal:${String(goalFixture.goalId)}` }
const goalBlock = renderGoalStateBlock([goalItem])
cards.push({
  caseId: 'bnd-01',
  section: 'boundary',
  question:
    '下面两段都是**程序生成**、会进她上下文的事实陈述。它们有没有**替谁**做了超出授权的陈述' +
    '（例如替她承诺、替用户确认、或把"她的猜测"写成事实）？',
  material: `${openBlock}\n\n---\n\n${goalBlock}`,
})

/* ---------------------------------------------------------------------------
 * C1 四组齐全（非零分母）
 * ------------------------------------------------------------------------- */
const sections = ['recognition', 'closure', 'expiry', 'boundary'] as const
const perSection = Object.fromEntries(
  sections.map((section) => [section, cards.filter((card) => card.section === section).length])
)
record(
  'C1',
  '【四组齐全】识别门槛 / 结清后是否还提 / 到期措辞 / 越界 **四组都有卡片**，且每组的材料都非空',
  sections.every((section) => perSection[section] > 0) &&
    cards.every((card) => card.material.trim() !== '' && card.question.trim() !== ''),
  JSON.stringify(perSection)
)

/* ---------------------------------------------------------------------------
 * 答案单（**我**的答案；与卡片分文件）
 * ------------------------------------------------------------------------- */
const answerSheet = {
  schema: 'm10.1-review-answer-sheet@1',
  reviewedBy: '',
  reviewedAt: '',
  note:
    '这是**生成者**的答案与理由，与 `blind-cards` 分开保存。请**先**独立判完四题，**再**打开它。' +
    '⚠️ 本文件**没有签名** —— 签名只能由审阅者本人填（`C4`）。' +
    '⚠️ **形态变更（2026-10-02 稍后）**：终态档按 `L-M10.1-15` 的修法改成**计数式陈述**（`内容从略`）⇒ ' +
    '`clo-01` / `exp-01` 的**材料已变**；已签的那次人审（2026-10-02 声明式裁定）覆盖的是**旧形态**。',
  answers: [
    {
      caseId: 'thr-01',
      answer: '该',
      reason: '双方对"明天十点二十五楼下见"有明确表达；判据可落在"由对方报告确认"这一档。',
    },
    { caseId: 'thr-02', answer: '该', reason: '给出了可核对的动作序列（先给三个步骤再动笔）。' },
    { caseId: 'thr-03', answer: '不该', reason: '**只有接受、没有内容** —— 指代不唯一，正确处置是澄清而不是记成承诺。' },
    { caseId: 'thr-04', answer: '不该', reason: '这是想法，不是约定；没有对方、没有判据。' },
    { caseId: 'thr-05', answer: '该', reason: '明确把义务落在对方身上（周五之前发提纲），且可核对。' },
    { caseId: 'thr-06', answer: '不该', reason: '这是**条件句**，条件本身未定；记成承诺会把"如果"写成"一定"。' },
    {
      caseId: 'clo-01',
      answer: '基本够，但要靠"程序事实"而不是靠她的记性',
      reason:
        '块里逐字写了「已结清 + 内容从略 + 不要再提」。⚠️ 2026-10-02 之后终态档**不再复述内容**' +
        '（`L-M10.1-15` 的修法：实测把内容一起摆出来会**再启动**她提这件事）。风险面因此变了：' +
        '不在措辞，而在**她会不会忽略这一段**与**她看不到"是哪一条"**（后者登记 `L-M10.1-17`）。',
    },
    {
      caseId: 'exp-01',
      answer: '不算指控',
      reason: '措辞是"时间到了"，没有"失约/违约/没做到"这类词；冻结词表由 `m10.1:context:verify` 的 C2 逐条守着。',
    },
    {
      caseId: 'bnd-01',
      answer: '没有替谁承诺',
      reason:
        '两段都是**程序事实**：一段是"这条约定还没结清 + 它的判据"，一段是"她此刻在推进什么"。' +
        '判据那一栏用的是"由对方报告确认"这种**出处**说法，不是替用户断言他做没做。',
    },
  ],
} as const

/* ---------------------------------------------------------------------------
 * C2 ⭐ 泄漏探测（正向）：卡片里不许出现答案单里的任何**结论性文本**
 * ------------------------------------------------------------------------- */
/*
 * ⚠️ **不能拿"该/不该"这种单字结论做子串比对**（第一版就是这么写的 ⇒ 卡片里
 *    到处都是"该不该"⇒ 假阳性满屏）。**可比的结论** = 答案单里的**理由**（长文本）。
 *    ⇒ 探测器的输入是"理由"，判别式是"逐字子串"。
 */
const cardTextOf = (card: Card): string => `${card.caseId}\n${card.question}\n${card.material}`
const allCardText = cards.map(cardTextOf).join('\n\u0000\n')
const secrets = answerSheet.answers.map((row) => row.reason)
const detector = (text: string): string[] =>
  secrets.filter((secret) => secret.trim() !== '' && text.includes(secret))
const leaked = detector(allCardText)
record(
  'C2',
  '【⭐ 泄漏探测·正向】卡片里**没有**答案单里的任何**理由**（逐字子串比对；单字答案"该/不该"不可比，见下条）',
  leaked.length === 0,
  `比对 ${String(secrets.length)} 条理由 · 命中=${JSON.stringify(leaked.slice(0, 2))}`
)

/* ---------------------------------------------------------------------------
 * C3 ⭐ 泄漏探测的**负控**：造一张带结论的卡片 ⇒ 探测器**必须响**
 * ------------------------------------------------------------------------- */
const poisoned = `${cardTextOf(cards[0]!)}\n我的结论：${secrets[0]!}`
record(
  'C3',
  '【⭐ 泄漏探测·负控】把一条**理由**故意塞进卡片 ⇒ 同一个探测器**必须响**（否则 C2 是橡皮图章）',
  detector(poisoned).length > 0 && detector(cardTextOf(cards[1]!)).length === 0,
  `注入后命中=${String(detector(poisoned).length)} · 干净卡片命中=${String(detector(cardTextOf(cards[1]!)).length)}`
)

/* ---------------------------------------------------------------------------
 * C4 **不代签**
 * ------------------------------------------------------------------------- */
const protocolBody = [
  '# M10.1 人审流程（两阶段 · **请你签**）',
  '',
  '> ⚠️ 本文件与 `blind-cards.md` 都由**机器**生成；**签名只能由你本人填** ——',
  '>   生成器**不代签**（它把 `reviewedBy` / `reviewedAt` 留空，`C4` 会断言这一点）。',
  '',
  '## 第一阶段：**只看卡片**（`blind-cards.md`）',
  '',
  '1. 四组题各答一遍（识别门槛：该/不该 + 一句理由；其余三组：按题目回答）。',
  '2. **先不要**打开 `answer-sheet.json`。',
  '3. 记下你对每一题的第一判断（写在你自己的地方，不必回填给机器）。',
  '',
  '## 第二阶段：对答案（`answer-sheet.json`）',
  '',
  '4. 打开答案单，逐条比对。**分歧不用改你的答案** —— 请把分歧列出来（那才是最有价值的部分）。',
  '5. 若某条你不认同，请写一句"我为什么这么判"（这会被记进验收报告的"未决项"）。',
  '',
  '## 签署（**只能你填**）',
  '',
  '- 审阅人：______________（生成器留空）',
  '- 日期：________________（生成器留空）',
  '- 结论：☐ 通过　☐ 有异议（见上）',
  '',
  '⚠️ 本表**不进验收结论**：验收报告只记"人审 = PASS / 有异议"，**不代填**。',
].join('\n')
const hasSignatureField = /reviewedBy:\s*['"]?[^\s'"]/.test(JSON.stringify(answerSheet))
    || /reviewedAt:\s*['"]?\d/.test(JSON.stringify(answerSheet))
record(
  'C4',
  '【不代签】答案单里的 `reviewedBy` / `reviewedAt` **都是空的**，流程文件里也只留"请你填"的位置',
  !hasSignatureField && answerSheet.reviewedBy === '' && answerSheet.reviewedAt === '',
  `reviewedBy=${JSON.stringify(answerSheet.reviewedBy)} · reviewedAt=${JSON.stringify(answerSheet.reviewedAt)}`
)

/* ---------------------------------------------------------------------------
 * C5 两阶段分离：卡片**没有**"系统结论/档位"字段
 * ------------------------------------------------------------------------- */
const CARD_FIELDS = ['caseId', 'section', 'question', 'material'] as const
const cardFieldsOk = cards.every(
  (card) => JSON.stringify(Object.keys(card).sort()) === JSON.stringify([...CARD_FIELDS].sort())
)
record(
  'C5',
  '【两阶段分离】每张卡片**只有** `caseId / section / question / material` 四个字段 —— **没有**结论、没有档位、没有"系统会怎么做"',
  cardFieldsOk,
  `字段闭集=${JSON.stringify([...CARD_FIELDS])}`
)

/* ---------------------------------------------------------------------------
 * C6 确定性 + C7 语料在场
 * ------------------------------------------------------------------------- */
const corpus = buildAgreementCorpus()
record(
  'C6',
  '【语料在场】WP1 的约定语料仍在（人审材料与它同源，**不是**凭空写的抽样）',
  corpus.length > 0,
  `语料条数=${String(corpus.length)}`
)
const twice =
  renderCommitmentStateBlock({ rows: [closedRow], maxTokens: 400, quantify })[0]?.content ?? ''
record(
  'C7',
  '【确定性】同一夹具两次渲染 ⇒ 逐字节相同（卡片可复现）',
  twice === closedBlock,
  `两次相同=${String(twice === closedBlock)}`
)

/* ---------------------------------------------------------------------------
 * C8 零模型 / 零库 / 零出网（源码自检）＋ 顺手确认"她那条回复"的选择器在材料里被用过
 * ------------------------------------------------------------------------- */
/*
 * ⚠️ **判据不许自匹配**（第四次踩同一个坑）：直接写 `'initDatabase'` 这些字面量，
 *    判据自己就在源码里 ⇒ `includes` 必然命中。修法：把名字**拼出来**（运行时才成形）。
 */
const forbiddenTokens = [
  `init${'Database'}`,
  `get${'RawDb'}`,
  `plugin${'-'}sql`,
  `fetch${'('}`,
]
const ownSource = readFileSync(join(REPO_ROOT, 'scripts/m10.1-review-materials.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')
const forbidden = forbiddenTokens.filter((token) => ownSource.includes(token))
const selectorProbe = lastAssistantEvidenceOf([])
record(
  'C8',
  '【零模型 / 零数据库 / 零出网】源码里没有开库、没有出站调用；材料全部来自**程序渲染**与**冻结语料**',
  forbidden.length === 0 && selectorProbe === undefined,
  `命中=${JSON.stringify(forbidden)}`
)

/* ---------------------------------------------------------------------------
 * 落盘（三个文件分开）
 * ------------------------------------------------------------------------- */
const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp7-review', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
writeFileSync(join(dir, 'blind-cards.json'), `${JSON.stringify({ schema: 'm10.1-blind-cards@1', cards }, null, 2)}\n`, 'utf8')
writeFileSync(
  join(dir, 'blind-cards.md'),
  [
    '# M10.1 盲审卡（**只有材料，没有结论**）',
    '',
    '> 四组题各答一遍。**先不要**打开 `answer-sheet.json`。',
    '',
    ...cards.map(
      (card) =>
        `## ${card.caseId}（${card.section}）\n\n**问**：${card.question}\n\n**材料**：\n\n\`\`\`\n${card.material}\n\`\`\`\n`
    ),
  ].join('\n'),
  'utf8'
)
writeFileSync(join(dir, 'answer-sheet.json'), `${JSON.stringify(answerSheet, null, 2)}\n`, 'utf8')
writeFileSync(join(dir, 'review-protocol.md'), `${protocolBody}\n`, 'utf8')
const payload = {
  schema: 'm10.1-review-materials@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  humanReview: 'PENDING（材料已生成；**签名只能由你填** —— 本门不代签）',
  perSection,
  cards: cards.length,
  secretsCompared: secrets.length,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门只生成**人审材料**并钉住三条机器判据（无泄漏 / 不代签 / 两阶段分离）。' +
    '它**不**主张人审已通过 —— 那一栏在本门里恒为 PENDING，只能由审阅者本人改。',
}
writeFileSync(join(dir, 'review-materials.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp7-review',
  head,
  headShort: head.slice(0, 12),
  branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'review-materials',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['offline'],
  supersedes: null,
  notes: `m10.1:review:materials（四审题 · 卡片 ${String(cards.length)} 张 · 泄漏探测含负控 · 不代签）`,
})
console.log(`runId: ${runId}`)
console.log(
  `verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）` +
    `\n人审：**PENDING**（材料在 ${dir}）`
)
process.exit(failed.length === 0 ? 0 : 1)
