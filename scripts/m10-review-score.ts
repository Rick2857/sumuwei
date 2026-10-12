/**
 * M10（`U-11` 方式甲的执行件）—— `pnpm m10:review:score --answers <填好的卡片文件>`。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * 读用户填过的 `blind-cards.json`（`reviewerVerdict` 已填），与 `answer-sheet.json`
 * 对答案，输出：
 * ```text
 * 一致率（**分母 = 卡片数**，漏答不算同意）+ 逐条分歧清单（caseId / 你的判定 / 金标）
 * ```
 *
 * ⚠️ **三条失败关闭**（都在 `evals/m10/review-score.ts` 里，且各有已知答案自证）：
 *    0 条答案 / 卡片外的 caseId / 同一 caseId 两次 ⇒ **拒收**，不报一致率。
 *
 * ⚠️ 本命令**不产生**"语义质量"读数：它算的是**人的判定与金标的一致率**，
 *    即"金标本身可不可靠"的一个侧面，**不是**系统表现。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { scorePerCase, type GoldEntry, type ReviewAnswer } from '../evals/m10/review-score.ts'
import { GOAL_PROPOSAL_OPERATIONS } from '../src/kernel/contracts/goal-proposal.ts'

function argOf(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/**
 * **从人读的 `.md` 卡片里解析答案**（`--answers <blind-cards.md>`）。
 *
 * ⚠️ 为什么加它：计分器原先**只**收 `blind-cards.json`，而那张卡是人填的 ——
 *    让审阅人手改 70 条 JSON 既费事、又容易漏一个逗号（整个文件就废了）。
 *    ⇒ 人改**人读的那份**，机器读人读的那份（这条与"判据不该假设别人的表现层"是同一条纪律）。
 *
 * ⚠️ **未知标签必须响亮地拒**，不能静默当成"没答"：
 *    否则一个手误（`Creat`）会被读成"没填"，**静默压低**一致率 ——
 *    "看起来是个正常的率，其实量错了东西"。
 */
export function parseAnswersFromMarkdown(text: string, labels: readonly string[]): {
  readonly cards: { caseId: string; reviewerVerdict: string | null; reviewerNote: string | null }[]
  readonly unknownLabels: { caseId: string; raw: string }[]
} {
  const cards: { caseId: string; reviewerVerdict: string | null; reviewerNote: string | null }[] = []
  const unknownLabels: { caseId: string; raw: string }[] = []
  /* 卡片头：`### 1. \`caseId\`（layer）` */
  const blocks = text.split(/^###\s+\d+\.\s+`([^`]+)`/m)
  for (let i = 1; i + 1 < blocks.length; i += 2) {
    const caseId = blocks[i]!
    const body = blocks[i + 1]!
    const rawVerdict =
      /`?reviewerVerdict`?\s*[:：]\s*(.+)/.exec(body)?.[1]?.trim() ?? ''
    const note = /`?reviewerNote`?\s*[:：]\s*(.+)/.exec(body)?.[1]?.trim() ?? ''
    /* 占位符/空 ⇒ 没答 */
    const placeholder =
      rawVerdict === '' ||
      rawVerdict.includes('待填') ||
      rawVerdict === '_' ||
      rawVerdict === '—' ||
      rawVerdict === '-'
    if (placeholder) {
      cards.push({ caseId, reviewerVerdict: null, reviewerNote: null })
      continue
    }
    /* 去掉 markdown 强调与行内代码的包裹 */
    const cleaned = rawVerdict.replace(/[*`_]/g, '').trim()
    if (!labels.includes(cleaned)) {
      unknownLabels.push({ caseId, raw: rawVerdict })
      cards.push({ caseId, reviewerVerdict: null, reviewerNote: null })
      continue
    }
    cards.push({
      caseId,
      reviewerVerdict: cleaned,
      reviewerNote: note.includes('可选') ? null : note,
    })
  }
  return { cards, unknownLabels }
}

function main(): void {
  const answersPath = argOf('--answers')
  const sheetPath = argOf('--sheet')

  if (answersPath === undefined) {
    console.log('用法：pnpm m10:review:score --answers <填好的 blind-cards.md 或 .json> [--sheet <answer-sheet.json>]')
    console.log('提示：材料由 `pnpm m10:review:materials` 生成在 artifacts/m10/<runId>/ 下。')
    console.log('推荐直接填 **.md**（人读的那份），本命令直接读它 —— 不必手改 JSON。')
    console.log('⚠️ 若采用**方式乙（声明式裁定）**，本命令不适用 —— 那种方式 perCaseRate 必须字面写 N/A。')
    process.exit(2)
  }

  const isMarkdown = /\.md$/i.test(answersPath)
  let cards: { caseId: string }[]
  let answers: ReviewAnswer[]
  if (isMarkdown) {
    const parsed = parseAnswersFromMarkdown(readFileSync(resolve(answersPath), 'utf8'), GOAL_PROPOSAL_OPERATIONS)
    if (parsed.unknownLabels.length > 0) {
      console.log(`verdict: REFUSED（unknown_label）`)
      console.log(
        `理由：${String(parsed.unknownLabels.length)} 张卡的标签不在闭集里（**不许静默当成"没答"** —— ` +
          '那会把一个手误读成"少答了一题"，静默压低一致率）：',
      )
      for (const item of parsed.unknownLabels.slice(0, 10)) {
        console.log(`  · ${item.caseId}：「${item.raw}」`)
      }
      console.log(`合法标签（${String(GOAL_PROPOSAL_OPERATIONS.length)} 个）：${GOAL_PROPOSAL_OPERATIONS.join(' · ')}`)
      process.exit(2)
    }
    cards = parsed.cards.map((card) => ({ caseId: card.caseId }))
    answers = parsed.cards.map((card) => ({ caseId: card.caseId, verdict: card.reviewerVerdict }))
  } else {
    const answersFile = JSON.parse(readFileSync(resolve(answersPath), 'utf8')) as {
      cards: { caseId: string; reviewerVerdict?: string | null; reviewerNote?: string | null }[]
    }
    cards = answersFile.cards.map((card) => ({ caseId: card.caseId }))
    /*
     * ⚠️ **字段名映射**（冒烟测试抓到的真实缺陷）。
     *
     * 生成器写的字段是 `reviewerVerdict`，而计分器读的是 `verdict` ——
     * 直接把卡片喂进去 ⇒ 每一张的 `verdict` 都是 `undefined` ⇒
     * **全部卡片被判成"分歧"**，输出里出现 `你判 undefined`。
     *
     * 若我只做"已知答案"自证（S1–S6 全绿）而不拿**真生成的文件**跑一次，
     * 这个缺陷会一直留着：自证用的是**手造的**答案对象，字段名由我自己对齐，
     * 于是"生成器与计分器说不到一块去"这件事**永远不会被自证发现**。
     * ⇒ 一条普遍教训：**自证用手造输入，就一定要额外用真实产物冒烟一次。**
     */
    answers = answersFile.cards.map((card) => ({
      caseId: card.caseId,
      verdict: card.reviewerVerdict ?? null,
    }))
  }

  /* 答案单：缺省找**同目录**的那一份（材料本来就是一起生成的） */
  const resolvedSheet =
    sheetPath ?? resolve(resolve(answersPath), '..', 'answer-sheet.json')
  /*
   * ⚠️ **答案单找不到 ⇒ 给人话，不抛栈**（WP11 轮次补）。
   *    实测触发方式：**路径含空格**（本仓库根就是 `...\project LG`）时，
   *    若调用方在 shell 下漏了引号，子进程会在空格处被截断 ⇒ 收到一个
   *    "看起来合法但不存在"的路径 ⇒ 原先直接抛 `ENOENT` 的裸栈，
   *    读者要自己去猜是哪个参数错了。⇒ 现在把**解析后的路径**印出来。
   */
  if (!existsSync(resolvedSheet)) {
    console.log('verdict: REFUSED（sheet_not_found）')
    console.log(`解析后的答案单路径：${resolvedSheet}`)
    console.log('提示：用 `--sheet <answer-sheet.json>` 指定；它与卡片一起生成在同一个 run 目录里。')
    console.log('⚠️ 路径含空格时（本仓库根目录就含）在 shell 下要加引号，否则会在空格处被截断。')
    process.exit(2)
  }
  const sheetFile = JSON.parse(readFileSync(resolvedSheet, 'utf8')) as {
    entries: GoldEntry[]
  }
  const gold: GoldEntry[] = sheetFile.entries.map((entry) => ({
    caseId: entry.caseId,
    gold: entry.gold,
  }))

  const result = scorePerCase(cards, gold, answers)
  if (!result.ok) {
    console.log(`verdict: REFUSED（${result.refusal.code}）`)
    console.log(`理由：${result.refusal.detail}`)
    console.log('⚠️ 拒收**不是**失败，是"这份答案不足以算出一个数" —— 不报一致率。')
    process.exit(1)
  }

  const score = result.score
  if (score.method !== 'per-case') {
    console.log('verdict: N/A（声明式裁定不产生一致率）')
    process.exit(0)
  }

  console.log('M10 人审计分（方式甲：逐案独立打分）')
  console.log(`  卡片数（分母）   ${String(score.cards)}`)
  console.log(`  与金标一致       ${String(score.agreed)}`)
  console.log(`  一致率           ${(score.rate * 100).toFixed(1)}%`)
  console.log(`  未答             ${String(score.unanswered.length)}${score.unanswered.length > 0 ? '（**不计入同意**）' : ''}`)
  if (score.unanswered.length > 0) {
    console.log(`    ${score.unanswered.slice(0, 10).join(', ')}${score.unanswered.length > 10 ? ' …' : ''}`)
  }
  if (score.disagreements.length === 0) {
    console.log('  分歧             0 条')
  } else {
    console.log(`  分歧             ${String(score.disagreements.length)} 条：`)
    for (const item of score.disagreements) {
      console.log(`    ${item.caseId}：你判 ${item.reviewer} · 我判 ${item.gold}`)
    }
    console.log('  ⇒ 逐条裁定：改金标 / 改判据 / 记为**已裁定残差**（三者都要写下来）')
  }
  console.log('⚠️ 这个数字是"人的判定与金标的一致率"，**不是**系统表现。')
  /*
   * ⚠️ **`verdict` 不能只看分歧数**（冒烟测试抓到的第二处缺陷）。
   *
   * 第一版写的是 `disagreements.length === 0 ? 'AGREED' : ...` ——
   * 于是**70 张全部未答**也报 `AGREED`（"0 条分歧"被"没人答过"满足了）。
   * ⇒ 这正是本仓库反复出现的那一类形状：**"0 个失败"与"什么都没量"在输出上长得一样。**
   *    ⇒ 必须先看**答了多少**，再看分歧。
   */
  const verdict =
    score.unanswered.length === score.cards
      ? 'AWAITING_REVIEW'
      : score.unanswered.length > 0
        ? 'PARTIAL'
        : score.disagreements.length === 0
          ? 'AGREED'
          : 'REVIEWED_WITH_DISAGREEMENTS'
  console.log(`verdict: ${verdict}`)
  if (verdict === 'AWAITING_REVIEW') {
    console.log('⚠️ 一张都没答 ⇒ **不是** AGREED。0 条分歧在这种情况下没有意义。')
  }
  process.exit(0)
}

main()
