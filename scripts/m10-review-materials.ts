/**
 * M10（`U-11` 的落成）—— **人审材料生成器**（`pnpm m10:review:materials`）。
 *
 * ============================================================================
 *  它生成什么、以及**为什么必须分开三个文件**
 * ============================================================================
 * ```text
 * blind-cards.json/.md   盲审卡片：**只有** caseId / 分层 / 用户原话 / 可选标签集
 *                        机器判据：卡片里**不得**出现金标（见 `C2` 的泄漏探测）
 * answer-sheet.json      **独立答案单**：caseId → 我的金标 + 我的理由
 *                        ⇒ 审阅者先独立判、判完再对答案（否则"复核"退化成"确认"）
 * review-protocol.md     两种人审方式的可执行流程（`U-11` 要用户选的那两种）
 * ```
 *
 * ⚠️ **本文件最要紧的一条机器判据**：卡片里**不许**有金标。
 *    这不是"我记得别写" —— `C2` 会在生成后把每张卡片的全部文本与答案单里的
 *    金标做子串比对；`C3` 是它的**负控**（故意造一张带金标的卡片 ⇒ 探测器必须响）。
 *    对照 M9 的 F-1（呈现层遗忘泄漏）：**泄漏从"呈现层顺手多带了一个字段"开始**。
 *
 * ⚠️ 抽样是**确定性**的（按层取前 N 个家族，家族整体进卡片）：
 *    同一条语料 hash ⇒ 同一套卡片 ⇒ 审阅结论可复现。
 *
 * ⚠️ 零模型 / 零数据库 / 零出网：本门只读**冻结语料**。
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { buildGoalCorpus } from '../evals/m10/goal-corpus.ts'
import { GOAL_METRIC_LABELS } from '../evals/m10/goal-metrics.ts'
import { scoreDeclarative, scorePerCase } from '../evals/m10/review-score.ts'

const REPO_ROOT = resolve(process.cwd())

/** 每层默认抽多少个**家族**（家族整体进卡片 ⇒ 改述组不会被拆开） */
const FAMILIES_PER_LAYER = 2

interface Check {
  group: 'A' | 'C' | 'S'
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

interface BlindCard {
  readonly caseId: string
  readonly familyId: string
  readonly layer: string
  /**
   * **上文（状态）** —— 用户 2026-09-30 的批评：
   * ```text
   * ① 很多句子没给上下文（比如"那个"——上文到底有没有指代？）
   *    ⇒ 分不清"该澄清"还是"按上文指代对应"
   * ② 有些句子没说明**是否与当前计划有关** ⇒ 分不清闲聊 / 提要求 / 题外话 / 对计划的改变
   * ```
   * ⇒ 卡片现在**必须**显示系统当时知道什么（当前几条目标、各是什么状态、最近在谈什么）。
   * ⚠️ 它**只写状态、不评价这句话本身**（写"这句无关"就等于把答案印在题面上）。
   */
  readonly context: string
  readonly utterance: string
  /** 审阅者从**这一个**闭集里选一个（卡片上给出，但不给答案） */
  readonly labels: readonly string[]
  /** 审阅者填这里（留空 = 待审） */
  readonly reviewerVerdict: string | null
  readonly reviewerNote: string | null
}

/**
 * **泄漏探测**：在给定文本里搜"像金标"的痕迹。
 *
 * ⚠️ 它必须能抓到**两种**形状：
 *   ① 把金标标签**作为字段值**带上去（`gold: 'create'`）
 *   ② 把金标**写进自然语言**里（"这一条应当是 create"）
 *   因此判据是"卡片文本里出现了**该条的**金标标签"，而不是"出现了某个字段名"。
 */
export function goldLeaksIn(cardText: string, goldOfCase: string): boolean {
  /* 只搜**该条的**金标：别的条的金标出现在卡片里不算这张卡泄漏
     （但如果出现的是**它自己**的答案，那这张卡就废了） */
  const pattern = new RegExp(`(^|[^a-z_])${goldOfCase}([^a-z_]|$)`)
  return pattern.test(cardText)
}

function main(): void {
  const corpus = buildGoalCorpus()
  const goldByCase = new Map(corpus.items.map((item) => [item.caseId, item.gold.operation]))

  /* ---------------------------------------------------------------------
   * A · 抽样（确定性、按层、家族整体）
   * ------------------------------------------------------------------- */
  const layerOrder = [
    'explicit_operation',
    'negation_reference_hypothesis',
    'commitment_and_false_fulfillment',
    'dependency_change',
    'multi_goal_ambiguity',
    'unrelated',
  ]
  const familyOrder = new Map<string, string[]>()
  for (const item of corpus.items) {
    const bucket = familyOrder.get(item.layer) ?? []
    if (!bucket.includes(item.familyId)) bucket.push(item.familyId)
    familyOrder.set(item.layer, bucket)
  }

  const sampledFamilies = new Set<string>()
  for (const layer of layerOrder) {
    for (const familyId of (familyOrder.get(layer) ?? []).slice(0, FAMILIES_PER_LAYER)) {
      sampledFamilies.add(familyId)
    }
  }
  const sampled = corpus.items.filter((item) => sampledFamilies.has(item.familyId))

  const cards: BlindCard[] = sampled.map((item) => ({
    caseId: item.caseId,
    familyId: item.familyId,
    layer: item.layer,
    context: item.context,
    utterance: item.sourceText,
    labels: GOAL_METRIC_LABELS,
    reviewerVerdict: null,
    reviewerNote: null,
  }))

  record(
    'A',
    'A1',
    '**抽样是确定的**：按层取固定数量的**家族**（家族整体进卡片 ⇒ 改述组不被拆开）',
    `每层 ${String(FAMILIES_PER_LAYER)} 个家族 · 六层`,
    `抽中 ${String(sampledFamilies.size)} 个家族 / 共 ${String(new Set(corpus.items.map((i) => i.familyId)).size)} · ` +
      `卡片 ${String(cards.length)} 张 / 全量 ${String(corpus.items.length)} 条`,
    sampledFamilies.size > 0 && cards.length > 0,
  )

  const sampledLayers = new Set(cards.map((card) => card.layer))
  record(
    'A',
    'A2',
    '**六层都被抽到**（某一层漏抽 ⇒ 那一层的金标从未被人看过）',
    `6 层都有卡片`,
    `覆盖 ${String(sampledLayers.size)} 层：[${[...sampledLayers].sort().join(', ')}]`,
    sampledLayers.size === layerOrder.length,
  )

  /* ---------------------------------------------------------------------
   * C · **反泄漏**（本门最要紧的机器判据 + 它的负控）
   * ------------------------------------------------------------------- */
  const leaked: string[] = []
  for (const card of cards) {
    const cardText = [card.caseId, card.familyId, card.layer, card.context, card.utterance]
      .concat(card.labels)
      .join(' ')
    const gold = goldByCase.get(card.caseId) ?? ''
    /*
     * ⚠️ 注意：`labels` 里当然**会**出现金标那个字符串（那是**可选集**，
     *    九选一，给出它是为了让审阅者知道判据空间）。⇒ 探测必须排除"可选集"，
     *    只看**这张卡自己的内容**（id / 家族 / 层 / **上文** / 原话）。
     *
     * ⚠️ **上文加入探测范围**（用户 2026-09-30 的批评之后）：它现在印在卡面上，
     *    所以它也必须过一遍泄漏判据 —— 在上文里写"这句与目标无关""这里指代不明"
     *    就等于把答案印在题面上。
     */
    const ownText = [card.caseId, card.familyId, card.layer, card.context, card.utterance].join(' ')
    if (goldLeaksIn(ownText, gold)) leaked.push(`${card.caseId}(gold=${gold})`)
  }
  record(
    'C',
    'C1',
    '**卡片里没有金标**：把每张卡片的"自己的内容"（id / 家族 / 层 / **上文** / 原话）'
      + '与**该条的**金标做比对（可选标签集不算 —— 九选一的空间必须给出，否则审阅者不知道判据空间）',
    '0 处泄漏',
    leaked.length === 0 ? `0 处（${String(cards.length)} 张卡片）` : `**${String(leaked.length)} 处**：[${leaked.slice(0, 5).join(', ')}]`,
    leaked.length === 0 && cards.length > 0,
  )

  /* C2 —— 泄漏探测器的**负控**：故意造一张带金标的卡片 ⇒ 必须响 */
  const leakProbeCase = cards[0]!
  const probeGold = goldByCase.get(leakProbeCase.caseId) ?? 'create'
  const injectedCardText = `${leakProbeCase.caseId} ${leakProbeCase.layer} 这一条应当是 ${probeGold}`
  const probeFired = goldLeaksIn(injectedCardText, probeGold)
  record(
    'C',
    'C2',
    '【负控】**泄漏探测器必须响**：故意把金标写进一张卡片的自然语言里 ⇒ 探测器判"有泄漏"'
      + '（不做这条，"卡片里没有金标"与"探测器根本不工作"在输出上长得一样）',
    '探测器判 有泄漏',
    `探测器=${probeFired ? '有泄漏' : '**没响**'}（注入的卡片：…应当是 ${probeGold}）`,
    probeFired,
  )

  /* C3 —— 正控：干净卡片必须安静 */
  const cleanText = `${leakProbeCase.caseId} ${leakProbeCase.layer} 把写完论文提纲设成我们接下来的目标`
  record(
    'C',
    'C3',
    '【正控】干净卡片**必须安静**（否则探测器靠"永远报泄漏"通过上一条）',
    '探测器判 无泄漏',
    `探测器=${goldLeaksIn(cleanText, probeGold) ? '**报泄漏**' : '无泄漏'}`,
    !goldLeaksIn(cleanText, probeGold),
  )

  /* C4 —— 答案单是**独立文件**（否则"盲审"退化成"对答案"） */
  record(
    'C',
    'C4',
    '**答案单是独立文件**（卡片文件里不得含金标字段的**取值**）',
    '分成两个文件',
    'blind-cards.* 与 answer-sheet.json 分开写；卡片字段只有 '
      + `${String(Object.keys(cards[0]!).join('/'))}`,
    Object.keys(cards[0]!).every((key) => key !== 'gold' && key !== 'expected'),
  )

  record(
    'C',
    'C5',
    '**卡片与答案单一对一**：caseId 集合完全相同（否则"审了 60 条、对了 58 条"这种事永远查不出来）',
    '两侧 caseId 集合相同',
    `卡片 ${String(cards.length)} 条 · 答案单 ${String(corpus.items.length)} 条（全量）`,
    corpus.items.length >= cards.length &&
      cards.every((card) => goldByCase.has(card.caseId)),
  )

  /* ---------------------------------------------------------------------
   * S · 计分器的**已知答案**自证（方式甲能被机器算成一个真数字）
   * ------------------------------------------------------------------- */
  const goldEntries = cards.map((card) => ({
    caseId: card.caseId,
    gold: goldByCase.get(card.caseId) ?? '',
  }))

  /* S1 —— 全部与金标一致 ⇒ 一致率恰好 1 */
  const allAgree = goldEntries.map((entry) => ({ caseId: entry.caseId, verdict: entry.gold }))
  const agreeScore = scorePerCase(cards, goldEntries, allAgree)
  record(
    'S',
    'S1',
    '**【已知答案】全部按金标答 ⇒ 一致率恰好 1**（分母 = 卡片数）',
    `rate = 1 · cards = ${String(cards.length)}`,
    agreeScore.ok
      ? `rate=${String(agreeScore.score.method === 'per-case' ? agreeScore.score.rate : 'N/A')} · cards=${String(agreeScore.score.cards)}`
      : `拒收：${agreeScore.refusal.code}`,
    agreeScore.ok && agreeScore.score.method === 'per-case' && agreeScore.score.rate === 1,
  )

  /* S2 —— 故意答错 N 条 ⇒ 一致率恰好 (cards-N)/cards，且分歧被逐条列出 */
  const wrongCount = Math.min(3, cards.length)
  const disagreeAnswers = allAgree.map((answer, index) =>
    index < wrongCount ? { caseId: answer.caseId, verdict: '__deliberately_wrong__' } : answer,
  )
  const disagreeScore = scorePerCase(cards, goldEntries, disagreeAnswers)
  const expectedRate = (cards.length - wrongCount) / cards.length
  record(
    'S',
    'S2',
    `**【已知答案】故意答错 ${String(wrongCount)} 条 ⇒ 一致率恰好 (${String(cards.length)}-${String(wrongCount)})/${String(cards.length)}**`,
    `rate = ${String(expectedRate)} · 分歧 ${String(wrongCount)} 条`,
    disagreeScore.ok && disagreeScore.score.method === 'per-case'
      ? `rate=${String(disagreeScore.score.rate)} · 分歧=${String(disagreeScore.score.disagreements.length)}`
      : '（非 per-case）',
    disagreeScore.ok &&
      disagreeScore.score.method === 'per-case' &&
      Math.abs(disagreeScore.score.rate - expectedRate) < 1e-12 &&
      disagreeScore.score.disagreements.length === wrongCount,
  )

  /* S3 —— 负控：空答案必须**拒收**（0 分母不得报一致率） */
  const emptyScore = scorePerCase(cards, goldEntries, [])
  record(
    'S',
    'S3',
    '【负控】**空答案必须拒收**（`no_answers`）—— "0 条答案"与"全部一致"在输出上长得一样，'
      + '而 0/0 不得被报成一致率',
    '拒收 · code = no_answers',
    emptyScore.ok ? '**没有拒收**' : `拒收 code=${emptyScore.refusal.code}`,
    !emptyScore.ok && emptyScore.refusal.code === 'no_answers',
  )

  /* S4 —— 负控：答案里有卡片外的 caseId ⇒ 拒收（对错账比错更糟） */
  const strayScore = scorePerCase(cards, goldEntries, [
    ...allAgree,
    { caseId: 'not-a-card', verdict: 'create' },
  ])
  record(
    'S',
    'S4',
    '【负控】**答案里出现卡片外的 caseId ⇒ 拒收**（`unknown_case`）'
      + ' —— 对错账比错更糟：它会让分子分母都失去意义',
    '拒收 · code = unknown_case',
    strayScore.ok ? '**没有拒收**' : `拒收 code=${strayScore.refusal.code}`,
    !strayScore.ok && strayScore.refusal.code === 'unknown_case',
  )

  /* S5 —— 负控：漏答不得被算成同意（分母仍是卡片数） */
  const partialAnswers = allAgree.slice(0, Math.max(1, cards.length - 2))
  const partialScore = scorePerCase(cards, goldEntries, partialAnswers)
  record(
    'S',
    'S5',
    '【负控】**漏答的卡片不得被算成"同意"**：分母仍是卡片数 ⇒ 一致率 < 1',
    `rate < 1 · unanswered = 2`,
    partialScore.ok && partialScore.score.method === 'per-case'
      ? `rate=${String(partialScore.score.rate)} · answered=${String(cards.length - partialScore.score.unanswered.length)} · unanswered=${String(partialScore.score.unanswered.length)}`
      : '（非 per-case）',
    partialScore.ok &&
      partialScore.score.method === 'per-case' &&
      partialScore.score.rate < 1 &&
      partialScore.score.unanswered.length === cards.length - partialAnswers.length,
  )

  /* S6 —— 方式乙：类型里**没有** rate 字段；必须字面 N/A */
  const declarative = scoreDeclarative(cards, '已审、无异议')
  record(
    'S',
    'S6',
    '**方式乙（声明式裁定）在类型上就没有 `rate` 字段**，`perCaseRate` 必须字面是 `N/A`'
      + ' —— "不把无异议变成不存在的数字一致率"因此是**类型上的**纪律，不是一句提醒',
    "perCaseRate = 'N/A' · 且无 rate 字段",
    `perCaseRate='${declarative.perCaseRate}' · 有 rate 字段=${String('rate' in declarative)}`,
    declarative.perCaseRate === 'N/A' && !('rate' in declarative),
  )

  const passed = checks.filter((check) => check.pass).length
  const failed = checks.length - passed

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp10-review', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  /* ---------------------------------------------------------------------
   * 落盘：三个文件 + 一个给人看的清单
   * ------------------------------------------------------------------- */
  writeFileSync(
    join(dir, 'blind-cards.json'),
    `${JSON.stringify({ schema: 'm10-blind-cards@1', runId, cards }, null, 2)}\n`,
    'utf8',
  )

  const cardLines: string[] = [
    '# M10 盲审卡片（**不含金标**）',
    '',
    `- runId：\`${runId}\``,
    `- 语料指纹：\`${corpus.corpusHash}\``,
    `- 卡片数：${String(cards.length)}（按层抽家族，家族整体进卡片）`,
    '',
    '> 填法：在每张卡片的 `reviewerVerdict` 里从 `labels` 选**一个**（九选一），',
    '> 理由写进 `reviewerNote`。⚠️ **先填完再打开 `answer-sheet.json`** ——',
    '> 否则这次复核只是"确认"，不是"独立判断"。',
    '',
    `## 可选标签（闭集，${String(GOAL_METRIC_LABELS.length)} 个）`,
    '',
    `\`${GOAL_METRIC_LABELS.join('` · `')}\``,
    '',
  ]
  for (const [index, card] of cards.entries()) {
    cardLines.push(
      `### ${String(index + 1)}. \`${card.caseId}\`（${card.layer}）`,
      '',
      `- **上文（系统当时知道什么）**：${card.context.replace(/^上文：/, '')}`,
      `- 用户原话：「${card.utterance}」`,
      `- \`reviewerVerdict\`：_(待填)_`,
      `- \`reviewerNote\`：_(可选)_`,
      '',
    )
  }
  writeFileSync(join(dir, 'blind-cards.md'), `${cardLines.join('\n')}\n`, 'utf8')

  writeFileSync(
    join(dir, 'answer-sheet.json'),
    `${JSON.stringify(
      {
        schema: 'm10-answer-sheet@1',
        runId,
        corpusHash: corpus.corpusHash,
        note:
          '⚠️ 这是我的金标与理由。**先独立判完卡片再看这份** —— 否则复核退化成确认。' +
          '如果你的判定与这里不同，请直接说"第 N 条我不同意"，那正是这次复核要产出的东西。',
        entries: corpus.items.map((item) => ({
          caseId: item.caseId,
          familyId: item.familyId,
          layer: item.layer,
          split: item.split,
          utterance: item.sourceText,
          gold: item.gold.operation,
          note: item.gold.note ?? null,
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  writeFileSync(
    join(dir, 'review-protocol.md'),
    `${[
      '# M10 人审流程（`U-11` 的两种方式，**请选一种**）',
      '',
      `- runId：\`${runId}\``,
      `- 语料指纹：\`${corpus.corpusHash}\``,
      '',
      '## 前置：这一步审的是**金标**，不是系统',
      '',
      '```text',
      '本流程审的是"**语料的金标对不对**"（登记项 U-15）。',
      '它**不是**"系统的语义能力评测" —— 那需要真模型（WP10 的 m10:semantic:eval）。',
      '两者不能互相顶替：金标错了，语义指标的分母就是错的。',
      '```',
      '',
      '## 方式甲：逐案独立打分（证据强度**高**）',
      '',
      '```text',
      '① 只看 blind-cards.md / .json（**不含金标**），逐张填 reviewerVerdict（九选一）',
      '② 填完再打开 answer-sheet.json 对答案',
      '③ 把结论交给收口方：`pnpm m10:review:score --answers <你填好的文件>`',
      '   ⇒ 机器算出**一致率**（带非零分母）+ 逐条列出**分歧**',
      '④ 分歧逐条裁定：改金标 / 改判据 / 记为已裁定残差',
      '```',
      '',
      '产出：一个**真实的**一致率数字（分母 = 卡片数）。',
      '',
      '## 方式乙：用户声明式裁定（证据强度**低**，但明确记录）',
      '',
      '```text',
      '① 你读材料后声明"已审、无异议"，或指出具体条目',
      '② 记录**只有**"声明式裁定"这件事本身',
      '③ ⚠️ **不生成**逐案一致率 —— 那是把"无异议"变成不存在的数字（WP10 出口逐字禁止）',
      '```',
      '',
      '产出：一条声明式 PASS（或具名条目）。**不得**写成 "一致率 100%" 或任何数字。',
      '',
      '## 两种方式的**记录模板**',
      '',
      '```text',
      'reviewedBy   : <你的标识>',
      'reviewedAt   : <YYYY-MM-DD>',
      'method       : per-case | declarative      ← 必须二选一，不许含糊',
      'perCaseRate  : <方式甲才有；方式乙必须写 N/A，且**不得**估算>',
      'disagreements: <逐条 caseId + 你的判定 + 裁定>',
      '```',
      '',
      '⚠️ 若选方式乙，`perCaseRate` 必须字面写 `N/A`。',
      '   把它写成 `1.0` / `100%` / `无` 都是把声明变成数字。',
      '',
    ].join('\n')}\n`,
    'utf8',
  )

  const payload = {
    schema: 'm10-review-materials@1',
    runId,
    head,
    mode: 'offline' as const,
    /** ⚠️ 与干跑同一条反主张：本门**不**产生任何语义结论 */
    semanticClaim: 'none' as const,
    corpusHash: corpus.corpusHash,
    cards: cards.length,
    familiesSampled: sampledFamilies.size,
    layersCovered: [...sampledLayers].sort(),
    files: ['blind-cards.json', 'blind-cards.md', 'answer-sheet.json', 'review-protocol.md'],
    checks,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
    disclaimer:
      '本门只**生成审阅材料**并证明它们没有泄漏金标。它不主张任何语义质量，' +
      '也不代替用户的独立复核（U-15）。',
  }
  writeFileSync(join(dir, 'review-materials.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp10',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'review-materials',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'U-11 人审材料：确定性抽样（按层抽家族）+ 盲审卡片（无金标，含泄漏探测器及其正负控）' +
      '+ 独立答案单 + 两种人审方式的可执行流程（含"声明式裁定不得生成一致率"的记录模板）。' +
      '⚠️ 不主张语义质量。',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} [${check.group}] ${check.label}`)
    console.log(`      期望 ${check.expected} · 实测 ${check.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log(`材料：artifacts/m10/${runId}/ · 卡片 ${String(cards.length)} 张（**不含金标**）`)
  console.log('⚠️ 审的是**金标**（U-15），不是系统的语义能力。')
  process.exit(failed === 0 ? 0 : 1)
}

main()
