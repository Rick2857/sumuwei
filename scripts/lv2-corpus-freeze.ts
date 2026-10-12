/**
 * Lv2 WP1 —— **语料冻结门**（`lv2:corpus:freeze`）。
 *
 * ============================================================================
 *  它做什么（`docs/lv2/Lv2-Acceptance-Plan.md` §5.2 / §7 WP1）
 * ============================================================================
 * `§5.2` 逐字："场景输入、状态准备、期望、严重错误定义和评分指南**先独立审阅，再冻结**"；
 * `§7 WP1` 出口："独立审阅和具体裁定在案；**新增阈值冻结后才正式测量**"。
 *
 * 于是本门把"冻结"落成**机器可判**的四件事：
 * ```text
 * ① 形状：12 类 × 6 案 = 72（不多不少）· caseId 唯一 · 每案有输入与要求
 * ② 独立性：同一类内**不得**出现"只替换名字"的输入（规范化后逐字比较）
 * ③ 闭集：严重错误七条、判据 kind、状态取值都必须落在冻结的闭集里
 * ④ 快照：把语料与评分指南的**当前内容**连同上界指纹一起写进证据
 *    （`corpus.json` + 模块 sha256 ⇒ 以后"语料被改过"可机器判定）
 * ```
 *
 * ⚠️ **本门不判任何质量好坏**：它判"冻结这件事成立"。
 *    语料**好不好**由人审（`§5.2` 的独立审阅）裁定，不由本门代替。
 * ⚠️ **零模型请求 · 零数据库**：纯数据 + 纯函数。
 *
 * 用法：
 * ```bash
 * pnpm lv2:corpus:freeze                 # 冻结 + 写证据
 * pnpm lv2:corpus:freeze --supersedes <runId>   # 有意改语料后的新一代（记进清单）
 * ```
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  LV2_CASES_PER_FAMILY,
  LV2_SCORING_GUIDE,
  LV2_SEVERE_ERRORS,
  LV2_SHORT_CASES,
  LV2_SHORT_CORPUS_VERSION,
  LV2_SHORT_FAMILIES,
  validateShortCorpus,
  type Lv2ShortCase,
} from '../evals/lv2/short-cases.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'

interface Check {
  readonly id: string
  readonly phase: 'positive' | 'negative' | 'recovery' | 'self'
  readonly pass: boolean
  readonly expected: string
  readonly observed: unknown
}

const checks: Check[] = []
const record = (id: string, phase: Check['phase'], pass: boolean, expected: string, observed: unknown): void => {
  checks.push({ id, phase, pass, expected, observed })
}

/** 汇总一类断言：有没有出现"提到该 caseId / 该关键词"的问题行。 */
function hasProblemWith(cases: readonly Lv2ShortCase[], needle: string): boolean {
  return validateShortCorpus(cases).some(
    (problem) => problem.caseId.includes(needle) || problem.problem.includes(needle),
  )
}

async function main(): Promise<void> {
  const started = new Date().toISOString()
  const root = process.cwd()
  const supersedesIndex = process.argv.indexOf('--supersedes')
  const supersedes = supersedesIndex >= 0 ? (process.argv[supersedesIndex + 1] ?? null) : null

  /* ------------------------------------------- ①′ 谓词一致性（`LV2-D08` 的机器判据） */
  /*
   * 出身：WP4 的 C04 全类红 + 离线诊断（`Lv2-WP4-C04-Diagnosis.md`）。
   * 事实：语料的 prep 用**程序侧**构造，谓词是**夹具自造的名字**（`food.avoid.cilantro`），
   *       而自然语言的更正会落到**抽取器真实产出的槽位**（`food.preference.cilantro`）——
   *       于是"更正"与"断言"看的是**两个不同的槽位**，案子永远不可能通过。
   * ⇒ 判据：**凡带谓词的 prep，它的 `sourceText` 经生产同款规则抽取器抽出来的谓词
   *   必须与 prep 写的谓词一致**；抽不出来的记为"不可验证"（列出，不判死）。
   * ⚠️ 这条检查是**离线纯函数**（抽取器是规则表，不碰库、不调模型）。
   */
  const prepPredicateRows = LV2_SHORT_CASES.flatMap((one) =>
    one.prep
      .filter((step) => 'predicate' in step && typeof step.predicate === 'string')
      .map((step) => ({
        caseId: one.caseId,
        predicate: (step as { predicate: string }).predicate,
        text: (step as { sourceText?: string; firstSourceText?: string }).sourceText
          ?? (step as { firstSourceText?: string }).firstSourceText
          ?? '',
      })),
  )
  const extractor = createRuleOnlyContentExtractor()
  const evidenceOwner = entityRef('character', 'lv2-corpus-lint')
  const evidenceSpeaker = entityRef('user', 'lv2-corpus-lint')
  const prepPredicateFindings: {
    caseId: string
    declared: string
    extracted: string | null
    text: string
  }[] = []
  for (const row of prepPredicateRows) {
    if (row.text === '') continue
    const extracted = await extractor.extract({ text: row.text, owner: evidenceOwner, speaker: evidenceSpeaker })
    const predicate = extracted === undefined ? null : String((extracted.content as { predicate?: unknown }).predicate ?? '')
    prepPredicateFindings.push({ caseId: row.caseId, declared: row.predicate, extracted: predicate, text: row.text })
  }
  const predicateMismatches = prepPredicateFindings.filter(
    (row) => row.extracted !== null && row.extracted !== '' && row.extracted !== row.declared,
  )
  const predicateUnverifiable = prepPredicateFindings.filter((row) => row.extracted === null || row.extracted === '')
  record(
    'P3-prep-predicates-match-extractor',
    'positive',
    predicateMismatches.length === 0,
    `${String(prepPredicateRows.length)} 条带谓词的 prep：抽取器抽出来的谓词必须与 prep 声明的一致（LV2-D08 的机器判据）`,
    {
      checkedCount: prepPredicateFindings.length,
      mismatches: predicateMismatches,
      unverifiable: predicateUnverifiable.map((row) => `${row.caseId}:${row.declared}`),
    },
  )

  /* ---------------------------------------------------------------- ① 形状 */
  const realProblems = validateShortCorpus(LV2_SHORT_CASES)
  const perFamily = new Map<string, number>()
  for (const one of LV2_SHORT_CASES) perFamily.set(one.family, (perFamily.get(one.family) ?? 0) + 1)
  record(
    'P1-corpus-shape-and-independence',
    'positive',
    realProblems.length === 0 && LV2_SHORT_CASES.length === LV2_SHORT_FAMILIES.length * LV2_CASES_PER_FAMILY,
    `${String(LV2_SHORT_FAMILIES.length)} 类 × ${String(LV2_CASES_PER_FAMILY)} 案 = ${String(
      LV2_SHORT_FAMILIES.length * LV2_CASES_PER_FAMILY,
    )} 案，且自检 0 问题`,
    {
      cases: LV2_SHORT_CASES.length,
      perFamily: Object.fromEntries(perFamily),
      problems: realProblems,
    },
  )
  record(
    'P2-severe-error-closed-set-and-guide-present',
    'positive',
    LV2_SEVERE_ERRORS.length === 7 && LV2_SCORING_GUIDE.version === 'lv2-scoring-guide@1',
    '严重错误闭集 = 7 条；评分指南版本 = lv2-scoring-guide@1',
    { severeErrors: LV2_SEVERE_ERRORS.map((entry) => entry.id), guideVersion: LV2_SCORING_GUIDE.version },
  )

  /* ------------------------------------------------- ② 负控：自检真的会响 */
  const baseline = LV2_SHORT_CASES[0]!
  const renamedOnly = [...LV2_SHORT_CASES, { ...baseline, caseId: 'C01-99', title: '改名冒充独立样本' }]
  record(
    'N1-renamed-duplicate-is-rejected',
    'negative',
    hasProblemWith(renamedOnly, 'C01-99'),
    '同一类内"只换标题、输入逐字相同"的新案必须被自检判死',
    { problems: validateShortCorpus(renamedOnly).filter((problem) => problem.caseId === 'C01-99') },
  )
  const oneMissing = LV2_SHORT_CASES.filter((one) => one.caseId !== 'C01-06')
  record(
    'N2-missing-case-is-rejected',
    'negative',
    validateShortCorpus(oneMissing).some((problem) => problem.caseId === 'C01' && problem.problem.includes('案例数')),
    '某一类只有 5 案时必须报"案例数 = 5"',
    { problems: validateShortCorpus(oneMissing).filter((problem) => problem.caseId === 'C01') },
  )
  const unknownSevere = [
    ...LV2_SHORT_CASES.filter((one) => one.caseId !== 'C03-04'),
    { ...LV2_SHORT_CASES.find((one) => one.caseId === 'C03-04')!, severeErrors: ['not_a_severe_error' as never] },
  ]
  record(
    'N3-unknown-severe-error-is-rejected',
    'negative',
    hasProblemWith(unknownSevere, '未知严重错误'),
    '闭集外的严重错误 id 必须被拒',
    { problems: validateShortCorpus(unknownSevere).filter((problem) => problem.problem.includes('严重错误')) },
  )
  const emptyRequirement = [
    ...LV2_SHORT_CASES.filter((one) => one.caseId !== 'C06-05'),
    { ...LV2_SHORT_CASES.find((one) => one.caseId === 'C06-05')!, reply: { requirement: '   ' } },
  ]
  record(
    'N4-empty-requirement-is-rejected',
    'negative',
    hasProblemWith(emptyRequirement, 'reply.requirement 为空'),
    '没有评分指南正文的案例必须被拒（否则它会静默地"没被判"）',
    { problems: validateShortCorpus(emptyRequirement).filter((problem) => problem.problem.includes('requirement')) },
  )

  /* -------------------------------------------------------- ③ 恢复 + 自检 */
  record(
    'R1-real-corpus-quiet-again',
    'recovery',
    validateShortCorpus(LV2_SHORT_CASES).length === 0,
    '放回**真实**语料 ⇒ 自检重新安静',
    { problems: validateShortCorpus(LV2_SHORT_CASES) },
  )
  const readingCases = LV2_SHORT_CASES.filter((one) => one.expect.length === 0).length
  record(
    'SELF-measured-count-positive',
    'self',
    LV2_SHORT_CASES.length > 0 && checks.length >= 6,
    '语料条数 > 0（计数型自检）且本门判定项 ≥ 6',
    { cases: LV2_SHORT_CASES.length, checksRecorded: checks.length, readingCases },
  )

  /* ------------------------------------------------------------- ④ 快照 */
  const failed = checks.filter((check) => !check.pass)
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL'
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
  const runId = createLv2RunId({ wpId: 'wp1-corpus', headShort: head })
  const dir = openLv2RunDir(root, runId)
  const corpusPath = 'evals/lv2/short-cases.ts'
  const corpusBytes = readFileSync(join(root, corpusPath))
  const corpusSha = createHash('sha256').update(corpusBytes).digest('hex')
  const worktreeLines = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .filter((line) => !line.slice(3).trim().split(/[\\/]/).join('/').startsWith('artifacts/lv2/'))

  writeFileSync(
    join(dir, 'checks.json'),
    `${JSON.stringify({ runId, corpusSha256: corpusSha, checks }, null, 2)}\n`,
    'utf8',
  )
  /* 冻结的**内容**快照（评审对象就是它） */
  writeFileSync(
    join(dir, 'corpus.json'),
    `${JSON.stringify(
      {
        corpusVersion: LV2_SHORT_CORPUS_VERSION,
        sourcePath: corpusPath,
        sourceSha256: corpusSha,
        families: LV2_SHORT_FAMILIES,
        casesPerFamily: LV2_CASES_PER_FAMILY,
        severeErrors: LV2_SEVERE_ERRORS,
        scoringGuide: LV2_SCORING_GUIDE,
        cases: LV2_SHORT_CASES,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  /* 给人审的那一份（`§8.1` 的"第一面"：只给场景与期望，不给任何读数 —— 因为还没有读数） */
  const reviewLines: string[] = [
    '# Lv2 综合短场景语料（冻结候选 · 待审阅）',
    '',
    `- runId：\`${runId}\``,
    `- 语料模块：\`${corpusPath}\` · sha256 \`${corpusSha}\``,
    `- 规模：${String(LV2_SHORT_FAMILIES.length)} 类 × ${String(LV2_CASES_PER_FAMILY)} 案 = ${String(LV2_SHORT_CASES.length)} 案`,
    `- 评分指南：\`${LV2_SCORING_GUIDE.version}\``,
    '',
    '> 本文件由 `pnpm lv2:corpus:freeze` 生成。**这里没有任何读数** —— 冻结的是判据，读数要跑出来才有。',
    '',
  ]
  for (const family of LV2_SHORT_FAMILIES) {
    reviewLines.push(`## ${family.id} ${family.label}`, '')
    for (const one of LV2_SHORT_CASES.filter((entry) => entry.family === family.id)) {
      reviewLines.push(`### ${one.caseId} · ${one.title}`, '')
      if (one.prep.length > 0) reviewLines.push(`- **初始状态**：${one.prep.map(describePrep).join('；')}`)
      if (one.precondition.length > 0) {
        reviewLines.push(`- **开跑前必须成立**：${one.precondition.map(describeAssertion).join('；')}`)
      }
      reviewLines.push(`- **输入**：${one.turns.map((turn) => `「${turn}」`).join(' → ')}`)
      if (one.fault !== undefined) reviewLines.push(`- **故障注入**：\`${one.fault}\``)
      reviewLines.push(`- **回复要求**：${one.reply.requirement}`)
      if (one.reply.mustMentionAny !== undefined) {
        reviewLines.push(`- **必须提到（任一）**：${one.reply.mustMentionAny.join(' / ')}`)
      }
      if (one.reply.mustNotMention !== undefined) {
        reviewLines.push(`- **不许出现**：${one.reply.mustNotMention.join(' / ')}`)
      }
      if (one.reply.maxCodepoints !== undefined) {
        reviewLines.push(`- **长度上界**：${String(one.reply.maxCodepoints)} 码点`)
      }
      reviewLines.push(
        `- **程序状态要求**：${one.expect.length === 0 ? '（读数案：不参与成功率分母）' : one.expect.map(describeAssertion).join('；')}`,
      )
      if (one.severeErrors.length > 0) reviewLines.push(`- **严重错误标签**：${one.severeErrors.join(' / ')}`)
      reviewLines.push(`- **备注**：${one.note}`, '')
    }
  }
  writeFileSync(join(dir, 'corpus-review.md'), `${reviewLines.join('\n')}\n`, 'utf8')

  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp1-corpus',
    head,
    headShort: head.slice(0, 12),
    branch,
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version, platform: process.platform },
    testType: 'corpus-freeze',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes,
    started,
    ended: new Date().toISOString(),
    worktree: { clean: worktreeLines.length === 0, lines: worktreeLines, note: '本门自己的 run 目录按白名单不计入' },
    sourceFingerprints: {
      [corpusPath]: corpusSha,
      'scripts/lv2-corpus-freeze.ts': createHash('sha256')
        .update(readFileSync(join(root, 'scripts/lv2-corpus-freeze.ts')))
        .digest('hex'),
      'docs/lv2/Lv2-Acceptance-Plan.md': createHash('sha256')
        .update(readFileSync(join(root, 'docs/lv2/Lv2-Acceptance-Plan.md')))
        .digest('hex'),
      'docs/lv2/Lv2-WP1-Freeze-Record.md': createHash('sha256')
        .update(readFileSync(join(root, 'docs/lv2/Lv2-WP1-Freeze-Record.md')))
        .digest('hex'),
    },
    config: {
      note: '语料是纯数据；本门不读任何功能开关',
      families: LV2_SHORT_FAMILIES.map((family) => family.id).join(','),
    },
    model: { providerKind: 'none', note: '零模型请求：本门不产任何对话' },
    requests: { planned: 0, actual: 0, note: '零模型请求' },
    denominators: {
      gateChecks: checks.length,
      cases: LV2_SHORT_CASES.length,
      families: LV2_SHORT_FAMILIES.length,
      casesPerFamily: LV2_CASES_PER_FAMILY,
      readingCases: LV2_SHORT_CASES.filter((one) => one.expect.length === 0).length,
      judgedCases: LV2_SHORT_CASES.filter((one) => one.expect.length > 0).length,
      severeErrorIds: LV2_SEVERE_ERRORS.length,
    },
    correlations: { cases: LV2_SHORT_CASES.length, conversations: 0, requests: 0, traces: 0 },
    faultInjection: null,
    cleanClose: null,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: '本门不碰任何数据库' },
    verdict,
    limitation:
      '本门只判"冻结成立"（形状 / 独立性 / 闭集 / 快照），**不判语料质量**。' +
      '语料是否真的覆盖了十二类、期望是否合理、严重错误标签是否挂对 —— 都由 `§5.2` 要求的**独立审阅**裁定。' +
      '本门也**不**产任何读数：它冻结的是判据，不是结果。',
  })

  console.log(`[lv2:corpus] runId = ${runId}`)
  console.log(`[lv2:corpus] head  = ${head}`)
  console.log(`[lv2:corpus] 语料  = ${String(LV2_SHORT_CASES.length)} 案 · ${String(LV2_SHORT_FAMILIES.length)} 类 · sha256 ${corpusSha.slice(0, 12)}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} [${check.phase}] ${check.id.padEnd(42)} ${check.pass ? '' : `实测 ${JSON.stringify(check.observed)}`}`)
  }
  console.log(`[lv2:corpus] 判定项 ${String(checks.length)} · 通过 ${String(checks.length - failed.length)} · 未通过 ${String(failed.length)}`)
  console.log(`[lv2:corpus] 判据案 ${String(LV2_SHORT_CASES.filter((one) => one.expect.length > 0).length)} · 读数案 ${String(LV2_SHORT_CASES.filter((one) => one.expect.length === 0).length)}`)
  console.log(`[lv2:corpus] 模型请求 0 · 数据库未打开 · verdict = ${verdict}`)
  console.log(`[lv2:corpus] 评审材料 = ${manifestPath.replace(`${root}\\`, '').replace(/\\/g, '/').replace('manifest.json', 'corpus-review.md')}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

/** 人读的 prep 摘要（只给评审文件用） */
function describePrep(prep: Lv2ShortCase['prep'][number]): string {
  switch (prep.kind) {
    case 'seed_memory':
      return `写入记忆（${prep.memoryType}${prep.predicate === undefined ? '' : ` · ${prep.predicate}`}${prep.value === undefined ? '' : ` = ${prep.value}`}）来源「${prep.sourceText}」`
    case 'seed_memory_corrected':
      return `写入并更正（${prep.predicate}：${prep.oldValue} → ${prep.newValue}）`
    case 'seed_explicit_memory_corrected':
      return `同会话经显式记忆路径写入并更正（${prep.predicate}：${prep.oldValue} → ${prep.newValue}）`
    case 'seed_memory_forgotten':
      return `写入后遗忘（${prep.predicate} = ${prep.value}）`
    case 'seed_goal':
      return `建立目标「${prep.statement}」`
    case 'seed_goal_completed':
      return `建立并完成目标「${prep.statement}」`
    case 'seed_commitment':
      return `建立承诺「${prep.statement}」`
    case 'seed_commitment_closed':
      return `建立并结清承诺「${prep.statement}」`
    case 'seed_turns':
      return `只写账本：${prep.lines.map((line) => `${line.actor === 'user' ? '用户' : '她'}「${line.text}」`).join(' / ')}`
  }
}

/** 人读的断言摘要 */
function describeAssertion(assertion: Lv2ShortCase['expect'][number]): string {
  switch (assertion.kind) {
    case 'active_memory_value':
      return `槽位 ${assertion.predicate} 的当前值 ${assertion.value === null ? '必须为空' : `= ${assertion.value}`}`
    case 'active_memory_value_anywhere':
      return `存在活跃记忆 = ${assertion.value}`
    case 'no_active_memory_value_anywhere':
      return `任何活跃记忆都不等于 ${assertion.value}`
    case 'active_memory_value_not':
      return `槽位 ${assertion.predicate} 有活跃值且 ≠ ${assertion.value}`
    case 'memory_status':
      return `槽位 ${assertion.predicate} 状态 = ${assertion.status}`
    case 'goal_status':
      return `目标「${assertion.statement}」状态 = ${assertion.status}`
    case 'goal_status_matching':
      return `存在含「${assertion.contains}」的目标，状态 = ${assertion.status}`
    case 'commitment_status':
      return `承诺「${assertion.statement}」状态 = ${assertion.status}`
    case 'commitment_status_matching':
      return `存在含「${assertion.contains}」的承诺，状态 = ${assertion.status}`
    case 'commitment_rows':
      return `承诺行总数 = ${String(assertion.expected)}`
    case 'event_delta':
      return `本轮 ${assertion.eventType} 事件数 = ${String(assertion.delta)}`
    case 'event_delta_prefix':
      return `本轮 ${assertion.prefix}* 事件数 = ${String(assertion.delta)}`
    case 'withdrawn_contains_source':
      return `撤销集包含来源「${assertion.sourceText}」`
    case 'identity_unchanged':
      return '身份（Seed/角色/归属）未变'
    case 'section_present':
      return `入模块 ${assertion.sectionId} 在场`
    case 'section_absent':
      return `入模块 ${assertion.sectionId} 不在场`
    case 'capability_set_unchanged':
      return '能力集合未变（无新增工具/权限）'
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
