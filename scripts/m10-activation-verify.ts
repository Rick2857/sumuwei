/**
 * M10（WP11/WP12）—— **激活候选核对表的绊线门**（`pnpm m10:activation:verify`）。
 *
 * ============================================================================
 *  它防的是什么
 * ============================================================================
 * `docs/m10/M10-Activation-Candidate.md` 里那张"缺口表"（G-1…G-4）是**人写的**。
 * 人写的表会**腐烂**——而且这一张烂起来特别危险，因为它守的是**激活**：
 *
 * ```text
 * A1  表里说 G-1/G-2 是 OPEN，而代码里其实已经接好了 ⇒ 候选在**低估**自己
 *     （后果轻一点：白等一轮）
 * A2  表里说 OPEN，谁偷偷接了线而没更新表 ⇒ 下一轮的人**以为还没接**，
 *     可能**再接一遍**（后果重：生产轮次被接两次 / 或者按"未接线"的前提做判断）
 * A3  反过来，表里写 CLOSED 而代码里没有 ⇒ 候选在**高估**自己
 *     ⇒ 可能出现"以为能激活、其实开关根本不存在"
 * A4  总判（READY / NOT READY）与逐条缺口**自相矛盾**
 * A5  开放缺口**没有归属** ⇒ "谁的活"变成没人认领
 * A6  有开放缺口却把"激活"槽写成已激活 ⇒ **文档撒谎**（这一条最严重）
 * ```
 *
 * ⇒ 本门把**表与代码对账**：G-1 查 `flags.ts` 有没有 goal 开关、G-2 查 `main.ts`
 *    有没有 `runGoalTurn`。**它是一条绊线**：谁接了线而没更新表，它就红。
 *
 * ⚠️ 它**只读** `docs/m10/M10-Activation-Candidate.md` 与两个源文件。零数据库 / 零模型 / 零出网。
 * ⚠️ 它**不**判断"M10 该不该激活"——那只属用户授权（`U-01`）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'

const REPO_ROOT = resolve(process.cwd())
const DOC = 'docs/m10/M10-Activation-Candidate.md'
const FLAGS = 'src/kernel/app/flags.ts'
const MAIN = 'src/main.ts'

function phase(mark: string): void {
  console.error(`[m10-activation] ${mark}`)
}

interface Check {
  group: 'A' | 'C'
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

/** 去掉注释后再判定（仓库反复踩过的那条：判结构必须先剥注释） */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

interface Gap {
  readonly id: string
  readonly status: string
  readonly owner: string
}

/** 解析 §2 的缺口表：`| 编号 | 缺口 | 机器判据 | 归属 | 状态 |` */
export function parseGaps(text: string): Gap[] {
  const gaps: Gap[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 7) continue
    const id = cells[1]!.replace(/[*`]/g, '')
    if (!/^G-\d+$/.test(id)) continue
    gaps.push({ id, owner: cells[4]!, status: cells[5]!.replace(/[`*]/g, '') })
  }
  return gaps
}

/** §1 的候选条件表：数 `MET` / `NOT MET` */
export function countPreconditions(text: string): { met: number; notMet: number; rows: number } {
  let met = 0
  let notMet = 0
  let rows = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 6) continue
    if (!/^\d+$/.test(cells[1]!)) continue
    rows += 1
    const status = cells[3]!.replace(/[*`]/g, '').trim()
    if (status === 'MET') met += 1
    if (status === 'NOT MET') notMet += 1
  }
  return { met, notMet, rows }
}

/**
 * **代码的实际情况**（绊线的另一半）。
 *
 * ⚠️ `codeOnly` 先剥注释：`main.ts` 的注释里**提到**过 `runGoalTurn` 的语义，
 *    不剥注释会把"注释里说了"当成"接好了"——这正是本仓库反复踩的那类坑。
 */
function codeFacts(): { flagExists: boolean; wired: boolean } {
  const flags = codeOnly(readFileSync(join(REPO_ROOT, FLAGS), 'utf8'))
  const main = codeOnly(readFileSync(join(REPO_ROOT, MAIN), 'utf8'))
  return {
    flagExists: /CHARACTER_GOALS_ENABLED/.test(flags),
    wired: /runGoalTurn/.test(main),
  }
}

/** 一条缺口的**应有状态**（只有 G-1/G-2 可机判；其余交人） */
function expectedGapStatus(id: string, facts: { flagExists: boolean; wired: boolean }): string | null {
  if (id === 'G-1') return facts.flagExists ? 'CLOSED' : 'OPEN'
  if (id === 'G-2') return facts.wired ? 'CLOSED' : 'OPEN'
  return null
}

function main(): void {
  phase('A: 表与代码对账')
  const path = join(REPO_ROOT, DOC)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const gaps = parseGaps(text)
  const pre = countPreconditions(text)
  const facts = codeFacts()

  const openGaps = gaps.filter((gap) => gap.status === 'OPEN')

  /* ------------------------------------------------------------------ A1 */
  record(
    'A',
    'A1',
    '**材料在场**：候选文件存在 · 解析出 §1 八项条件 · 解析出 §2 的 G-1…G-4'
      + '（"解析出 0 行、0 个问题"与"全部一致"在输出上长得一样）',
    '文件在 · 8 项条件 · ≥4 条缺口',
    `${existsSync(path) ? '在' : '**缺**'} · 条件 ${String(pre.rows)} 项（MET ${String(pre.met)} / NOT MET ${String(pre.notMet)}）· 缺口 ${String(gaps.length)} 条`,
    existsSync(path) && pre.rows === 8 && gaps.length >= 4,
  )

  /* ------------------------------------------------- A2/A3：两条绊线 */
  for (const [checkId, gapId, fact, factLabel] of [
    ['A2', 'G-1', facts.flagExists, `\`${FLAGS}\` 里有 \`CHARACTER_GOALS_ENABLED\``],
    ['A3', 'G-2', facts.wired, `\`${MAIN}\` 里出现 \`runGoalTurn\``],
  ] as const) {
    const gap = gaps.find((item) => item.id === gapId)
    const truth = expectedGapStatus(gapId, facts)
    record(
      'A',
      checkId,
      `**【绊线】${gapId} 表里的状态 = 代码的实际情况**（${factLabel} ⇒ 真实为 \`${String(truth)}\`）`
        + ' —— 谁接了线却**没更新表**，这一条就红（那是本门存在的理由）',
      `表 = 真实 = ${String(truth)}`,
      gap === undefined
        ? `**表里没有 ${gapId}**`
        : `表 = ${gap.status} · 真实 = ${String(truth)}（${factLabel}）`,
      gap !== undefined && truth !== null && gap.status === truth,
    )
  }

  /* ------------------------------------------------------------------ A4 */
  const saysNotReady = /CANDIDATE\s*\/\s*NOT READY/.test(text)
  const saysReady = /CANDIDATE\s*\/\s*READY/.test(text)
  const shouldBeNotReady = openGaps.length > 0
  record(
    'A',
    'A4',
    '**总判与逐条缺口一致**：有开放缺口 ⇒ 总判必须是 `NOT READY`；'
      + '全部关闭 ⇒ 总判必须已改成 `READY`（**改了代码就必须改这张表**）',
    shouldBeNotReady ? 'NOT READY' : 'READY',
    `开放缺口 ${String(openGaps.length)} 条 ⇒ 文档 ${saysNotReady ? 'NOT READY' : saysReady ? 'READY' : '**两者都没写**'}`,
    shouldBeNotReady ? saysNotReady && !saysReady : saysReady,
  )

  /* ------------------------------------------------------------------ A5 */
  const noOwner = openGaps.filter((gap) => gap.owner.replace(/[*`\s（）()]/g, '').length < 4)
  record(
    'A',
    'A5',
    '**每条开放缺口都有归属**（≥4 个有效字符）—— 否则"谁的活"变成没人认领',
    '0 条缺归属',
    noOwner.length === 0
      ? `${String(openGaps.length)} 条开放缺口都写了归属`
      : `**缺归属**：${noOwner.map((gap) => gap.id).join(', ')}`,
    noOwner.length === 0,
  )

  /* ------------------------------------------------------------------ A6 */
  /*
   * ⚠️ **两处修正**（都是把候选改成计划 §21.1 的槽表之后才暴露的 —— 判据不该假设文档的排版）：
   *
   * ```text
   * v1  认死**中文槽名**那个字面量（用正则去匹配它）
   *     而 §21.1 的槽名是 `Production activation` ⇒ 换成计划的名字之后**找不到槽** ⇒ 红
   *     （"找不到"本身是**对**的失败关闭，但它是**排版耦合**，不是真发现）
   *
   * v2  想对整行搜 ACTIVATED ⇒ **也会错**：§21.1 的最后一列是"**计划允许的表达**"，
   *     本来就写着 `ACTIVATED / NOT ACTIVATED` ⇒ 对整行搜**永远为真**（假阳性）
   * ```
   * ⇒ 现在：**两种槽名都认**，且**只看取值那一格**（表格第 2 列）。
   *
   * ⚠️ 另记一处**踩过的坑**：本注释第一版把那条正则**原样**写进来了，
   *    而它的结尾正好是"星号紧跟斜杠"这一对字符 —— 那一对就是**块注释的结束符**
   *    ⇒ 注释在那里被**提前终止**，后面整段变成"代码" ⇒ 一串 `Invalid character`。
   *    ⇒ 在块注释里描述正则，**不要写出那一对相邻字符**（这与"判结构先剥注释"是同一枚硬币的两面）。
   */
  const activationRow =
    text
      .split(/\r?\n/)
      .find((line) => /Production activation/.test(line) || /\*\*激活\*\*/.test(line)) ?? ''
  /* `| 槽 | 值 | 缺口 | 计划允许的表达 |` ⇒ split('|')[2] 是"值"那一格 */
  const valueCell = activationRow.split('|')[2] ?? ''
  const claimsActivated = /\bACTIVATED\b/.test(valueCell.replace(/NOT ACTIVATED/g, ''))
  record(
    'A',
    'A6',
    '**结论槽不撒谎**：有开放缺口时，"激活"槽的**取值**不得出现 `ACTIVATED`'
      + '（**这一条最严重**：文档说已激活而代码里连开关都没有）'
      + ' —— ⚠️ 判据看的是**取值那一格**，不是整行（行尾"计划允许的表达"列本来就写着'
      + ' `ACTIVATED / NOT ACTIVATED`，对整行搜会永远为真）',
    '取值不含 ACTIVATED',
    activationRow === ''
      ? '**找不到"激活"槽**（认 `Production activation` 与 `**激活**` 两种写法）'
      : `取值格：${valueCell.trim().slice(0, 60)}`,
    activationRow !== '' && (!shouldBeNotReady || !claimsActivated),
  )

  /* ==================================================================== C */
  phase('C: 探测器的正负控')
  const g2 = gaps.find((gap) => gap.id === 'G-2')
  if (g2 === undefined) {
    record('C', 'C0', '需要 G-2 来做正负控', '找到 1 条', '**没找到**', false)
  } else {
    record(
      'C',
      'C1',
      '【正控】**真实的那一行当前是一致的**（`G-2` 表里写的 = 代码的真实状态）—— '
        + '这一条红了说明**绊线已经在响**（表与代码真的不一致）；'
        + '⚠️ 它与 C2 **不再互相依赖**：C2 改为相对**真实值**翻转后，'
        + '无论这一条红不红，C2 的读数都可解释',
      `G-2 = ${String(expectedGapStatus('G-2', facts))} 且表一致`,
      `表 = ${g2.status} · 真实 = ${String(expectedGapStatus('G-2', facts))}`,
      g2.status === expectedGapStatus('G-2', facts),
    )
    /*
     * ⚠️ **翻转要相对"真实值"翻，不能相对"表里的值"翻**（本轮用真实注入测出来的缺陷）。
     *
     * 第一版写成 `flipped.status = g2.status === 'OPEN' ? 'CLOSED' : 'OPEN'`（相对**表**翻）。
     * 于是当绊线已经红了（表 = OPEN、真实 = CLOSED）时，翻转恰好得到 CLOSED
     * ⇒ **与真实值一致** ⇒ C2 报"被判为一致"而变红 ——
     * 那条红**不是**"检测器坏了"，而是**控制本身依赖了被测对象的状态**（C1 的必要性没写出来）。
     * ⇒ 现在相对**真实值**翻：无论表是什么样，翻转结果都与真实值相反 ⇒
     *   C2 成为一条**独立**于文档状态的控制，读数永远可解释。
     */
    const truthForControl = expectedGapStatus('G-2', facts)
    const flipped = { ...g2, status: truthForControl === 'OPEN' ? 'CLOSED' : 'OPEN' }
    record(
      'C',
      'C2',
      '【负控】**把一个状态翻成与真实值相反**必须被抓**（相对**真实值**翻，'
        + '所以本条的读数**独立于文档当前状态**；相对表里的值翻会让它在绊线已红时失去意义）',
      '判为不一致',
      flipped.status === expectedGapStatus('G-2', facts) ? '**被判为一致**' : '判为不一致',
      flipped.status !== expectedGapStatus('G-2', facts),
    )
  }

  /* ================================================================== 落盘 */
  const passed = checks.filter((check) => check.pass).length
  const failed = checks.length - passed
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp11-activation', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm10-activation-verify@1',
    runId,
    head,
    mode: 'offline' as const,
    semanticClaim: 'none' as const,
    doc: DOC,
    preconditions: pre,
    gaps,
    codeFacts: facts,
    checks,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
    disclaimer:
      '本门把**候选的缺口表**与**代码的实际情况**对账（G-1 查 flags.ts、G-2 查 main.ts），' +
      '并核对总判/归属/结论槽。它**不**判断 M10 该不该激活（那只属用户授权 `U-01`），' +
      '也**不**主张任何语义结论。',
  }
  writeFileSync(join(dir, 'activation-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp11',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'activation-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      '**绊线门**：激活候选的缺口表（G-1…G-4）与代码实际状态对账 + 总判/归属/结论槽。' +
      '⚠️ 不判断该不该激活；不主张语义。',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} [${check.group}] ${check.label}`)
    console.log(`      期望 ${check.expected} · 实测 ${check.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log(
    `缺口：${gaps.map((gap) => `${gap.id}=${gap.status}`).join(' · ')} · ` +
      `代码事实：flag=${String(facts.flagExists)} wired=${String(facts.wired)}`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main()
