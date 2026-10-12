/**
 * M10.1 WP8 —— **量具验证门**（`m10.1:measurement:verify`）。
 *
 * ============================================================================
 *  为什么必须单独做一遍（`L-M10.1-07` 的销账）
 * ============================================================================
 * ```text
 * 各道门的正控/负控/恢复都是**内联**的 —— 谁也没法一眼回答"**这几个检测器是不是都会响**"。
 * 一个永远说"没问题"的检测器，与一个真的都没问题的系统，在输出上完全一样（`INV-M45-06`）。
 * ⇒ 本门用**最小夹具**驱动同一批检测器，只回答"它们会不会响"。**不重跑**那几道门的真实链路。
 * ```
 *
 * ============================================================================
 *  四个检测器 × 三段式（缺一不可）
 * ============================================================================
 * ```text
 * ① **事实块的终态措辞**（`renderCommitmentStateBlock`）：未结清 ⇒ 不许出现"不要再提"；
 *    把它变成终态 ⇒ **必须**出现"已结清 + 不要再提"；恢复 ⇒ 又安静。
 * ② **到期档的不含指控**（冻结词表）：合法到期文本 ⇒ 词表**不响**；
 *    往同一段里塞一个指控词 ⇒ **必须响**；去掉 ⇒ 又安静。
 * ③ **兑现的窄规则**（`draftToProgramProposal`）：`user_report` 承诺 ⇒ 配对；
 *    `conversation_output` 承诺 ⇒ **不**配对；恢复 ⇒ 又配对。
 * ④ **人审材料的泄漏探测**（读**最新**那份人审证据）：干净卡片 ⇒ 不响；
 *    把答案单里的一条理由塞进卡片 ⇒ **必须响**；去掉 ⇒ 又安静。
 * ```
 *
 * ⚠️ 零模型 / 零数据库 / 零出网：全部是纯函数与已落盘证据。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { selectLatestReading } from './m10.1-gate-select.ts'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import {
  COMMITMENT_DO_NOT_RAISE,
  renderCommitmentStateBlock,
  type CommitmentFactRow,
} from '../src/kernel/app/goal/commitment-facts.ts'
import { draftToProgramProposal } from '../src/kernel/app/goal/understanding.ts'
import type { GoalCommitmentSummary } from '../src/kernel/app/goal/turn.ts'

const REPO_ROOT = resolve(process.cwd())
const quantify = (text: string): number => [...text].length
/** 指控词表（**冻结**：与 `m10.1:context:verify` 的 C2 同源） */
const ACCUSATION_WORDS = ['失约', '违约', '没做到', '没履行', '不守约', '失信'] as const

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

const blockOf = (row: CommitmentFactRow): string =>
  renderCommitmentStateBlock({ rows: [row], maxTokens: 400, quantify })[0]?.content ?? ''
const rowOf = (status: CommitmentFactRow['status']): CommitmentFactRow => ({
  goalId: 'gol:measurement',
  scope: '明天十点二十五在楼下见',
  status,
  criterionKind: 'user_report',
})

/* ---------------------------------------------------------------------------
 * ① 终态措辞
 * ------------------------------------------------------------------------- */
const openText = blockOf(rowOf('active'))
const closedText = blockOf(rowOf('fulfilled'))
const restoredText = blockOf(rowOf('active'))
record(
  'M1',
  '【① 终态措辞】正控（未结清）⇒ **不**出现"不要再提" · 负控（终态）⇒ **必须**出现"已结清+不要再提" · 恢复（回到未结清）⇒ 又安静',
  !openText.includes(COMMITMENT_DO_NOT_RAISE) &&
    closedText.includes(COMMITMENT_DO_NOT_RAISE) &&
    closedText.includes('已结清') &&
    !restoredText.includes(COMMITMENT_DO_NOT_RAISE),
  `未结清响=${String(openText.includes(COMMITMENT_DO_NOT_RAISE))} · 终态响=${String(
    closedText.includes(COMMITMENT_DO_NOT_RAISE)
  )} · 恢复后响=${String(restoredText.includes(COMMITMENT_DO_NOT_RAISE))}`
)

/* ---------------------------------------------------------------------------
 * ② 到期档的不含指控（词表探测器）
 * ------------------------------------------------------------------------- */
const expiredText = blockOf({ ...rowOf('expired'), dueAt: 1_960_000_000_000 })
const detectorAccusation = (text: string): string[] =>
  ACCUSATION_WORDS.filter((word) => text.includes(word))
const poisonedAccusation = `${expiredText}\n（你失约了。）`
record(
  'M2',
  '【② 到期措辞】正控（合法到期文本）⇒ 词表**一个字都不响** · 负控（塞进"失约"）⇒ **必须响** · 恢复（去掉）⇒ 又安静',
  detectorAccusation(expiredText).length === 0 &&
    detectorAccusation(poisonedAccusation).length > 0 &&
    detectorAccusation(expiredText).length === 0,
  `合法命中=${JSON.stringify(detectorAccusation(expiredText))} · 注入命中=${JSON.stringify(
    detectorAccusation(poisonedAccusation)
  )}`
)

/* ---------------------------------------------------------------------------
 * ③ 兑现的窄规则
 * ------------------------------------------------------------------------- */
const closureProposalOf = (
  criterionKind: GoalCommitmentSummary['criterionKind']
): { readonly types: readonly string[] } => {
  const mapped = draftToProgramProposal(
    {
      schemaVersion: 'goal-proposal@1',
      operation: 'report_complete',
      span: { start: 0, end: 4 },
      targetGoalId: 'gol:measurement',
    },
    {
      characterId: 'char_measurement',
      sourceEventId: 'cev:user:measurement',
      proposalId: 'm10.1-measurement',
      processor: 'm10.1-measurement-verify',
      processorVersion: 'm10.1-measurement-verify@1',
      candidates: [
        {
          goalId: 'gol:measurement',
          status: 'active',
          priority: 'normal',
          statement: '明天十点二十五在楼下见',
          revision: 1,
        },
      ],
      sourceText: '我到了。',
      now: 1_960_000_000_000,
      targetCommitments: [
        {
          goalId: 'gol:measurement',
          commitmentId: 'cmt:measurement',
          revision: 1,
          criterionKind,
          status: 'active',
        },
      ],
    }
  )
  return {
    types: (mapped.proposal?.targetEvents ?? []).map((target) => String(target.type)),
  }
}
const paired = closureProposalOf('user_report')
const notPaired = closureProposalOf('conversation_output')
const pairedAgain = closureProposalOf('user_report')
record(
  'M3',
  '【③ 兑现的窄规则】正控（`user_report` 承诺）⇒ 配对出 `COMMITMENT_FULFILLED` · 负控（`conversation_output`）⇒ **不**配对 · 恢复 ⇒ 又配对',
  paired.types.includes('COMMITMENT_FULFILLED') &&
    !notPaired.types.includes('COMMITMENT_FULFILLED') &&
    pairedAgain.types.includes('COMMITMENT_FULFILLED'),
  `user_report=${JSON.stringify(paired.types)} · conversation_output=${JSON.stringify(notPaired.types)}`
)

/* ---------------------------------------------------------------------------
 * ④ 人审材料的泄漏探测（读**最新**那份证据）
 * ------------------------------------------------------------------------- */
/*
 * ⚠️ 第一版用 `git ls-files` 找"最新那份人审材料" ⇒ **找不到**：那份证据此刻还在未跟踪区
 *    （`git ls-files` 只看**已提交**的索引）。⇒ 改成**扫文件系统**（按 mtime 取最新）。
 */
const reviewRoot = resolve(REPO_ROOT, 'artifacts/m10.1')
const newestReview = existsSync(reviewRoot)
  ? readdirSync(reviewRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(reviewRoot, entry.name))
      .filter(
        (dir) =>
          existsSync(join(dir, 'blind-cards.json')) && existsSync(join(dir, 'answer-sheet.json'))
      )
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
      .at(-1)
  : undefined
let leakDetail = '找不到人审证据 ⇒ NOT RUN'
let leakOk = false
if (newestReview !== undefined) {
  const cards = (
    JSON.parse(readFileSync(join(newestReview, 'blind-cards.json'), 'utf8')) as {
      cards: { caseId: string; question: string; material: string }[]
    }
  ).cards
  const answers = (
    JSON.parse(readFileSync(join(newestReview, 'answer-sheet.json'), 'utf8')) as {
      answers: { reason: string }[]
    }
  ).answers
  const secrets = answers.map((row) => row.reason)
  const detectorLeak = (text: string): string[] =>
    secrets.filter((secret) => secret.trim() !== '' && text.includes(secret))
  const clean = cards.map((card) => `${card.caseId}\n${card.question}\n${card.material}`).join('\n')
  const poisoned = `${clean}\n${secrets[0] ?? ''}`
  leakOk =
    detectorLeak(clean).length === 0 &&
    detectorLeak(poisoned).length > 0 &&
    detectorLeak(clean).length === 0
  leakDetail = `正控命中=${String(detectorLeak(clean).length)} · 注入命中=${String(
    detectorLeak(poisoned).length
  )} · 卡片=${String(cards.length)} 张 · 理由=${String(secrets.length)} 条`
}
record(
  'M4',
  '【④ 泄漏探测】正控（干净卡片）不响 · 负控（把一条理由塞进卡片）**必须**响 · 恢复 ⇒ 又安静（证据取**最新**那份人审材料）',
  leakOk,
  leakDetail
)

/* ---------------------------------------------------------------------------
 * ⑤ 聚合门的**选档器**（`R-34` / `TD-23`）
 * ------------------------------------------------------------------------- */
/*
 * 这道量具单列的理由：选档器**不属于任何一道业务门**，它决定"聚合门看到的是哪一份读数"。
 * `R-34` 的实证反例：四份 `long:live-200` 档目录 mtime 完全相同 ⇒ 旧实现按目录名字典序取到那份 FAIL。
 * 下面用 `%TEMP%` 夹具驱动**同一个** `selectLatestReading()`（不碰 `artifacts/`）。
 */
const selectionRoot = mkdtempSync(join(tmpdir(), 'm10.1-select-'))
const fixture = (name: string, reading: Record<string, unknown>, manifest: Record<string, unknown> = {}): string => {
  const dir = join(selectionRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'reading.json'), `${JSON.stringify(reading, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return dir
}

/* 正控：自报结束时间更晚的那份必须被选中（哪怕它的目录名字典序更小） */
fixture('p-aaa-old', { verdict: 'FAIL', ended: '2026-10-01T00:00:00Z' })
fixture('p-zzz-new', { verdict: 'PASS', ended: '2026-10-02T00:00:00Z' })
const positive = selectLatestReading(selectionRoot, 'p-', 'reading.json')

/* 负控（**mtime 反转**）：两份都没有任何时间戳 ⇒ 必须**不**按 mtime 选，并**具名**降级 */
const staleDir = fixture('q-aaa', { verdict: 'FAIL' })
fixture('q-bbb', { verdict: 'PASS' })
const oldSeconds = 1_600_000_000
utimesSync(staleDir, oldSeconds, oldSeconds) // 让 FAIL 那份看起来"更新"
const inverted = selectLatestReading(selectionRoot, 'q-', 'reading.json')

/* 恢复：换个前缀 ⇒ 安静（没有候选 ⇒ undefined，不是"选了某个默认") */
const recovered = selectLatestReading(selectionRoot, 'zzz-none-', 'reading.json')

record(
  'M6',
  '【⑤ 选档器·三段式】正控（自报结束时间更晚者胜）· 负控（**mtime 反转且无时间戳** ⇒ 仍不按 mtime，且 `basis=none` 具名降级）· 恢复（无候选 ⇒ undefined，不是默认选一个）',
  positive?.runId === 'p-zzz-new' &&
    positive?.basis === 'reported-time' &&
    inverted?.basis === 'none' &&
    inverted?.runId === 'q-bbb' &&
    recovered === undefined,
  `正控=${positive?.runId ?? 'undefined'}/${positive?.basis ?? '-'} · mtime 反转后=${inverted?.runId ?? 'undefined'}/${inverted?.basis ?? '-'} · 恢复=${recovered === undefined ? 'undefined' : '有候选'}`
)

/* 负控（非权威档过滤 + 并列判定不同）：干跑档不许当权威；并列且判定不同 ⇒ 必须**拒绝** */
fixture('r-dry-pass', { verdict: 'PASS', dryRun: true, ended: '2026-10-05T00:00:00Z' })
fixture('r-real-fail', { verdict: 'FAIL', dryRun: false, ended: '2026-10-01T00:00:00Z' })
const filtered = selectLatestReading(selectionRoot, 'r-', 'reading.json')
fixture('s-tie-pass', { verdict: 'PASS', ended: '2026-10-06T00:00:00Z' })
fixture('s-tie-fail', { verdict: 'FAIL', ended: '2026-10-06T00:00:00Z' })
const tied = selectLatestReading(selectionRoot, 's-', 'reading.json')

record(
  'M7',
  '【⑤ 选档器·诚实性】干跑档**被滤掉**（不因它好看就选它：正式档 FAIL 时照样报 FAIL）· **时间并列且判定不同** ⇒ `conflictingVerdicts=true`（调用方失败关闭，不许按字典序偷偷定一个）',
  filtered?.runId === 'r-real-fail' &&
    filtered?.skipped.length === 1 &&
    filtered?.skipped[0] === 'r-dry-pass' &&
    tied?.conflictingVerdicts === true &&
    tied?.tiedWith.length === 1,
  `过滤后=${filtered?.runId ?? 'undefined'} · 滤掉=${JSON.stringify(filtered?.skipped ?? [])} · 并列冲突=${String(tied?.conflictingVerdicts)}`
)

rmSync(selectionRoot, { recursive: true, force: true })

/* ---------------------------------------------------------------------------
 * M5 非零分母 + 冻结词表在场
 * ------------------------------------------------------------------------- */
const denominators = {
  gauges: 5,
  accusationWords: ACCUSATION_WORDS.length,
  reviewCards: ((): number => {
    if (newestReview === undefined) return 0
    const parsed = JSON.parse(readFileSync(join(newestReview, 'blind-cards.json'), 'utf8')) as {
      cards: unknown[]
    }
    return parsed.cards.length
  })(),
}
record(
  'M5',
  '【非零分母】五类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
  Object.values(denominators).every((value) => value > 0),
  JSON.stringify(denominators)
)

/* ---------------------------------------------------------------------------
 * 证据
 * ------------------------------------------------------------------------- */
const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp8-measurement', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-measurement-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  gauges: [
    { id: 'terminal-wording', where: 'renderCommitmentStateBlock', phases: ['open', 'closed', 'restored'] },
    { id: 'expiry-wording', where: 'ACCUSATION_WORDS 词表', phases: ['clean', 'injected', 'restored'] },
    { id: 'fulfillment-narrow-rule', where: 'draftToProgramProposal', phases: ['paired', 'not-paired', 'restored'] },
    { id: 'blind-leak-detector', where: 'm10.1:review:materials 的 C2/C3', phases: ['clean', 'injected', 'restored'] },
    { id: 'gate-selection-order', where: 'scripts/m10.1-gate-select.ts（`R-34`/`TD-23`）', phases: ['positive', 'negative', 'restored'] },
  ],
  sourceEvidence: newestReview ?? null,
  accusationWords: ACCUSATION_WORDS,
  denominators,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门只回答"**这四个检测器会不会响**"（正控 / 负控 / 恢复）。它**不**重跑那几道门的真实链路，' +
    '也**不**主张任何语义结论。',
}
writeFileSync(join(dir, 'measurement-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp8-measurement',
  head,
  headShort: head.slice(0, 12),
  branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'measurement-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['offline'],
  supersedes: null,
  notes: `m10.1:measurement:verify（4 个检测器 × 三段式；源证据=${newestReview ?? 'NOT RUN'}）`,
})
console.log(`runId: ${runId}`)
console.log(
  `verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`
)
process.exit(failed.length === 0 ? 0 : 1)
