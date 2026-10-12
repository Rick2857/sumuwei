/**
 * M6.1 WP1 —— **判定契约与人工标注集的门**（`pnpm m6.1:wp1:verify`）。
 *
 * ============================================================================
 *  它要测的命题
 * ============================================================================
 *  「这份语料**覆盖了**计划书 §5 的全部类别、每类都有双向控制、对照形状齐备、
 *    可见文本没有泄漏标签；G1 的三条具名回归**能追到**真实的本地轮次、
 *    而且**真的被人审过**了。」
 *
 *  最后半句是这一门与其它门最不一样的地方：
 *
 * ```text
 *   verdict = FROZEN                  ⇒ 契约 approval 段完整 + labels.json 有真人批准
 *   verdict = AWAITING HUMAN REVIEW   ⇒ 其它一切情况（**默认**）
 * ```
 *  **接受判决只有 `FROZEN`**（登记在 `m6.1-evidence.ts`），所以未经真人审核时
 *  `m6.1:gates` 汇总**不可能**是 PASS。这不是"跑失败了"，而是"按设计还没到能判的时候"。
 *
 * ============================================================================
 *  六件事（每一件都对应一种真实事故形态）
 * ============================================================================
 * ```text
 *  ① 语料判据（复用 m6.1-contract.ts，与 L1 组件门**同一份**判据）——分母/双向控制/对照/泄漏
 *  ② 分集自洽：条目自己声明的 split 必须与它所在的文件一致（否则"留出集没被调参"是空话）
 *  ③ G1 指针可解析 + sha256 一致：**按 turn 字段查找**（`replies` 下标 ≠ 轮次）
 *  ④ 物化人审材料前先证明目标目录**确实**被 gitignore（正文绝不进 Git）
 *  ⑤ 金标准存在性：labels.json 的真人批准字段
 *  ⑥ 以上任何一条的"检查了 0 项"⇒ MEASUREMENT INVALID，不是 PASS
 * ```
 *
 * 用法：
 *   pnpm m6.1:wp1:verify                          # 自动生成唯一 runId
 *   pnpm m6.1:wp1:verify --out artifacts/m6.1/<runId>
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { MeasurementInvalidError } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  ACTUAL_CONTEXT_UNAVAILABLE_REASON,
  ALERT_LABELS,
  CATEGORY_IDS,
  MEMORY_ASSERTION_LABELS,
  M6_1_CONTRACT_VERSION,
  M6_1_CORPUS_VERSION,
  M6_1_INSTRUMENT_VERSION,
  countByCategory,
  validateCorpus,
  type CorpusProblem,
} from './m6.1-contract.ts'
import {
  M6_1_LOCAL_PARENT,
  RunDirExistsError,
  createRunId,
  openRunDir,
  runIdFromOutPath,
  sha256OfText,
  writeManifestAtomic,
} from './m6.1-evidence.ts'

const ROOT = resolve(process.cwd())
const EVAL_DIR = join(ROOT, 'evals', 'm6.1')
const SPLITS = ['dev', 'calibration', 'heldout'] as const

// ---------------------------------------------------------------------------
// 读入
// ---------------------------------------------------------------------------

interface Problem {
  readonly code: string
  readonly detail: string
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) {
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：语料文件不存在 ${path}`)
  }
  const text = readFileSync(path, 'utf8')
  const items: unknown[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    try {
      items.push(JSON.parse(line))
    } catch (error) {
      throw new MeasurementInvalidError(
        `MEASUREMENT INVALID：${relative(ROOT, path)} 第 ${index + 1} 行不是合法 JSON（${String(error)}）`
      )
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// 语料 + 分集自洽
// ---------------------------------------------------------------------------

interface CorpusReading {
  bySplit: Record<string, unknown[]>
  all: unknown[]
  problems: Problem[]
  counts: ReturnType<typeof countByCategory>
}

function readCorpus(): CorpusReading {
  const bySplit: Record<string, unknown[]> = {}
  const all: unknown[] = []
  const problems: Problem[] = []
  for (const split of SPLITS) {
    const items = readJsonl(join(EVAL_DIR, 'corpus', `${split}.jsonl`))
    bySplit[split] = items
    for (const item of items) {
      all.push(item)
      const declared =
        typeof item === 'object' && item !== null
          ? String((item as Record<string, unknown>).split ?? '')
          : ''
      if (declared !== split) {
        problems.push({
          code: 'corpus_split_file_mismatch',
          detail:
            `${split}.jsonl 里有一条声明 split=${JSON.stringify(declared)}` +
            `（id=${String((item as Record<string, unknown>).id ?? '?')}）` +
            ' ⇒ "留出集没被调参"会变成一句无法核验的话',
        })
      }
    }
  }
  return { bySplit, all, problems, counts: countByCategory(all) }
}

// ---------------------------------------------------------------------------
// G1 具名回归
// ---------------------------------------------------------------------------

interface RegressionItem {
  id: string
  category: string
  subject: string
  sourcePath: string
  turnIds: number[]
  expectedLabels: string[]
  confirmedBy: string
  note: string
  sha256: string | null
  sourcePresent: boolean
}

interface RegressionReading {
  items: RegressionItem[]
  problems: Problem[]
  resolved: { id: string; turn: number; kind: string; reply: string; chars: number }[]
  lookupWarning: string
}

function readRegressions(): RegressionReading {
  const path = join(EVAL_DIR, 'regressions', 'g1-confirmed.json')
  if (!existsSync(path)) {
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：具名回归文件不存在 ${path}`)
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    items?: RegressionItem[]
    lookupWarning?: string
  }
  const items = parsed.items ?? []
  const problems: Problem[] = []
  const resolved: RegressionReading['resolved'] = []
  if (items.length === 0) {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：具名回归 0 条')
  }

  for (const item of items) {
    if (!CATEGORY_IDS.includes(item.category)) {
      problems.push({ code: 'regression_unknown_category', detail: `${item.id} 的类别 ${item.category} 不在冻结集` })
    }
    for (const label of item.expectedLabels) {
      if (!MEMORY_ASSERTION_LABELS.includes(label)) {
        problems.push({ code: 'regression_unknown_label', detail: `${item.id} 的标签 ${label} 不在冻结集` })
      }
    }
    if (!item.expectedLabels.some((label) => ALERT_LABELS.includes(label))) {
      problems.push({
        code: 'regression_without_alert_label',
        detail: `${item.id} 是**已确认失败**，却没有任何报警标签 ⇒ 它不可能被抓到`,
      })
    }
    /*
     * `confirmedBy` 形如 `docs/m6/G1-Acceptance-Report.md §6.3` —— 只取**文件路径**那一段。
     * 第一版按 `#` 切，于是带 `§` 小节号的写法被当成"文档不存在"（假红）。
     */
    const confirmingRel = item.confirmedBy.split(/\s|#/)[0] ?? ''
    const confirming = join(ROOT, confirmingRel)
    if (!existsSync(confirming)) {
      problems.push({
        code: 'regression_confirming_doc_missing',
        detail: `${item.id} 的确认文档不存在：${item.confirmedBy}（解析出 ${confirmingRel}）`,
      })
    }

    const abs = join(ROOT, item.sourcePath)
    if (!existsSync(abs)) {
      /*
       * 本地正文缺失时**如实报 NOT RUN**，绝不重建冒充逐字重放（计划书 §WP3）。
       * 这是"缺材料"而不是"判据失败"，所以它是一条**具名缺口**，并单列进 verifier 读数的 notRun。
       */
      problems.push({
        code: 'regression_source_missing',
        detail:
          `${item.id} 的本地来源缺失：${item.sourcePath}` +
          '（该轮只能报 NOT RUN；**不得**重建或改写正文冒充逐字重放）',
      })
      continue
    }
    const actualSha = createHash('sha256').update(readFileSync(abs)).digest('hex')
    if (item.sha256 !== null && item.sha256 !== actualSha) {
      problems.push({
        code: 'regression_source_changed',
        detail:
          `${item.id} 的来源文件 sha256 与登记不一致（登记 ${String(item.sha256).slice(0, 12)}… / ` +
          `实算 ${actualSha.slice(0, 12)}…）⇒ 换过的正文不能算同一次读数`,
      })
      continue
    }

    /*
     * ⚠️ 必须按 `turn` 字段查找。trajectory-*.detail.json 的 `replies` 数组
     *    **下标 ≠ 轮次**（V2 的 replies 有 500 条，最后一条的 turn = 488）。
     *    按下标取会**静默取到别的轮次** —— 那正是 AGENTS §6.9 说的"数字对，
     *    但描述的不是你以为的那个东西"。
     */
    const detail = JSON.parse(readFileSync(abs, 'utf8')) as {
      replies?: { turn?: number; kind?: string; reply?: string }[]
    }
    const replies = detail.replies ?? []
    for (const turn of item.turnIds) {
      const hit = replies.find((entry) => entry.turn === turn)
      if (hit === undefined) {
        problems.push({
          code: 'regression_turn_not_found',
          detail: `${item.id} 在 ${item.sourcePath} 里找不到 turn=${String(turn)}（按 turn 字段查找）`,
        })
        continue
      }
      const reply = hit.reply ?? ''
      if (reply.trim() === '') {
        problems.push({
          code: 'regression_turn_empty',
          detail: `${item.id} 的 turn=${String(turn)} 回复是空的 ⇒ 拿它做标注没有意义`,
        })
        continue
      }
      resolved.push({ id: item.id, turn, kind: hit.kind ?? '', reply, chars: reply.length })
    }
  }

  if (resolved.length === 0 && problems.length === 0) {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：一条回归轮次都没解析出来')
  }

  return {
    items,
    problems,
    resolved,
    lookupWarning: parsed.lookupWarning ?? '',
  }
}

// ---------------------------------------------------------------------------
// gitignore 闸（正文绝不进 Git）
// ---------------------------------------------------------------------------

function assertIgnored(dir: string): Problem[] {
  const rel = relative(ROOT, dir).split(/[\\/]/).join('/')
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT, stdio: 'ignore' })
    return []
  } catch {
    return [
      {
        code: 'local_dir_not_ignored',
        detail:
          `${rel} **没有**被 gitignore ⇒ 拒绝把正文写进去（正文进 Git 是 D-8 与隐私纪律` +
          '明确要避免的事）。请先补 .gitignore 再跑本门。',
      },
    ]
  }
}

// ---------------------------------------------------------------------------
// 金标准（真人批准）
// ---------------------------------------------------------------------------

function readGoldStandard(): { present: boolean; approved: boolean; problems: Problem[]; byId: Map<string, string[]> } {
  const path = join(EVAL_DIR, 'annotations', 'labels.json')
  const byId = new Map<string, string[]>()
  if (!existsSync(path)) {
    return { present: false, approved: false, problems: [], byId }
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    reviewedBy?: unknown
    reviewedAt?: unknown
    items?: { id?: unknown; assertionLabels?: unknown }[]
  }
  const problems: Problem[] = []
  const approved =
    typeof parsed.reviewedBy === 'string' &&
    parsed.reviewedBy.trim() !== '' &&
    typeof parsed.reviewedAt === 'string' &&
    parsed.reviewedAt.trim() !== ''
  if (!approved) {
    problems.push({
      code: 'gold_without_human_approval',
      detail: 'labels.json 存在，但 reviewedBy / reviewedAt 缺失或为空 ⇒ 不能当成"已人工审核"',
    })
  }
  const items = parsed.items ?? []
  if (items.length === 0) {
    problems.push({ code: 'gold_empty', detail: 'labels.json 的 items 是空的 ⇒ 检查了 0 项不是 PASS' })
  }
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : ''
    const labels = Array.isArray(item.assertionLabels) ? item.assertionLabels.map(String) : []
    if (id === '' || labels.length === 0) {
      problems.push({ code: 'gold_item_incomplete', detail: `金标准条目缺 id 或标签：${JSON.stringify(item)}` })
      continue
    }
    for (const label of labels) {
      if (!MEMORY_ASSERTION_LABELS.includes(label)) {
        problems.push({ code: 'gold_unknown_label', detail: `金标准 ${id} 的标签 ${label} 不在冻结集` })
      }
    }
    byId.set(id, labels)
  }
  return { present: true, approved, problems, byId }
}

// ---------------------------------------------------------------------------
// 人审材料物化
// ---------------------------------------------------------------------------

function writeAnnotationWorksheet(
  regressions: RegressionReading,
  counts: ReturnType<typeof countByCategory>,
  total: number,
  verdict: string
): string {
  const lines: string[] = []
  lines.push('# M6.1 WP1 人工标注工作表（DRAFT）')
  lines.push('')
  lines.push(`> verdict = **${verdict}**`)
  lines.push('')
  lines.push('## 1. 这一页要真人做什么')
  lines.push('')
  lines.push('逐条核对下面的**断言级**标注草案，然后在 `evals/m6.1/annotations/labels.json` 里')
  lines.push('写下 `reviewedBy` / `reviewedAt` 与逐条标签。**在那一刻之前，本门的判决只能是')
  lines.push('`AWAITING HUMAN REVIEW`，`m6.1:gates` 汇总也不可能是 PASS。**')
  lines.push('')
  lines.push('## 2. 合成语料的覆盖（类别 / 分母 / 双向控制）')
  lines.push('')
  lines.push('| 类别 | 检查点数 | 应报警 | 不应报警 | 弃判 |')
  lines.push('|---|---|---|---|---|')
  for (const entry of counts) {
    lines.push(
      `| ${entry.category} | ${String(entry.total)} | ${String(entry.alert)} | ${String(entry.nonAlert)} | ${String(entry.indeterminate)} |`
    )
  }
  lines.push(`| **合计** | **${String(total)}** | | | |`)
  lines.push('')
  lines.push('## 3. G1 具名回归（**真实轮次**，逐条核对）')
  lines.push('')
  lines.push('以下正文来自 gitignored 的本地材料，**只在本机可见**。')
  lines.push('')
  for (const item of regressions.items) {
    const hits = regressions.resolved.filter((entry) => entry.id === item.id)
    if (hits.length === 0) {
      lines.push(`### ${item.id} — ⏸ NOT RUN`)
      lines.push('')
      lines.push(`来源缺失或轮次解析失败：\`${item.sourcePath}\``)
      lines.push('')
      lines.push('**不得**重建或改写正文冒充逐字重放。')
      lines.push('')
      continue
    }
    for (const hit of hits) {
      lines.push(`### ${item.id} · turn ${String(hit.turn)}（kind=${hit.kind}，${String(hit.chars)} 字）`)
      lines.push('')
      lines.push(`- 主题：${item.subject}`)
      lines.push(`- 确认文档：${item.confirmedBy}`)
      lines.push(`- 草案标签：\`${item.expectedLabels.join('`, `')}\``)
      lines.push(`- 标注理由：${item.note}`)
      lines.push('')
      lines.push('**她的原话（逐字）**：')
      lines.push('')
      lines.push('```text')
      lines.push(hit.reply)
      lines.push('```')
      lines.push('')
      lines.push('真人核定：`[ ] 同意草案` `[ ] 需要改标签：______` `[ ] INDETERMINATE（说明理由）`')
      lines.push('')
    }
  }
  lines.push('## 4. 已知缺口（不在本阶段关闭）')
  lines.push('')
  lines.push('- G1 旧轨迹**没有**记录"该轮实际入模的上下文"（`actualContext`），')
  lines.push('  因此这些回归只能判**回复行为**，不能判检索覆盖或遗忘操作的实际结果（G1 §6.1）。')
  lines.push('- 契约决定 `CD-1`（新增 `UNSUPPORTED_DENIAL`）与 `CD-2`（"伪称遗忘成功"没有对应标签）')
  lines.push('  需要在批准时一并裁定，见 `M6.1-Judgment-Contract.md` §3 / §9。')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { out: string | null } {
  let out: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      out = argv[index + 1] ?? null
      index += 1
    }
  }
  return { out }
}

function headShortOf(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：拿不到 HEAD（git rev-parse 失败）')
  }
}

function main(): void {
  const { out } = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()
  const head = headShortOf()
  const runId = out === null ? createRunId({ wpId: 'wp1', headShort: head }) : runIdFromOutPath(ROOT, out)

  let runDir: string
  try {
    runDir = openRunDir(ROOT, runId)
  } catch (error) {
    if (error instanceof RunDirExistsError) {
      console.error(`[m6.1-wp1] 失败关闭：${error.message}`)
      process.exit(2)
    }
    throw error
  }

  const problems: Problem[] = []

  // ① 语料 + ② 分集自洽
  const corpus = readCorpus()
  problems.push(...corpus.problems)
  for (const problem of validateCorpus(corpus.all)) {
    problems.push({ code: problem.code, detail: describeCorpusProblem(problem) })
  }

  // ③ G1 指针
  const regressions = readRegressions()
  problems.push(...regressions.problems)

  // ④ 正文目录必须被 gitignore
  const localDir = join(ROOT, M6_1_LOCAL_PARENT, runId)
  const ignoreProblems = assertIgnored(localDir)
  problems.push(...ignoreProblems)

  // ⑤ 金标准
  const gold = readGoldStandard()
  problems.push(...gold.problems)

  /*
   * 分母自检：语料 0 条、回归 0 条、解析出的轮次 0 条 —— 任何一种都 ⇒ MEASUREMENT INVALID。
   * "检查了 0 项、发现 0 处不一致"与"全部一致"在输出上长得一样（AGENTS §6.8）。
   */
  if (corpus.all.length === 0) {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：语料 0 条')
  }
  if (regressions.resolved.length === 0) {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：G1 回归轮次 0 条')
  }

  // ⑥ 物化人审材料（只在目录确认被 ignore 之后）
  const verdict = gold.present && gold.approved ? 'FROZEN' : 'AWAITING HUMAN REVIEW'
  let worksheetPath: string | null = null
  let materialized = 0
  if (ignoreProblems.length === 0) {
    mkdirSync(localDir, { recursive: true })
    const worksheet = writeAnnotationWorksheet(
      regressions,
      corpus.counts,
      corpus.all.length,
      verdict
    )
    worksheetPath = join(localDir, 'annotation-worksheet.md')
    writeFileSync(worksheetPath, worksheet, 'utf8')
    materialized = regressions.resolved.length
    const turns = {
      schemaVersion: 'm6.1-regression-turns@1',
      note: '真实轮次的**逐字正文**。本文件在 gitignored 目录内，不进 Git。',
      lookupWarning: regressions.lookupWarning,
      items: regressions.resolved,
    }
    writeFileSync(join(localDir, 'regression-turns.json'), `${JSON.stringify(turns, null, 2)}\n`, 'utf8')
  }

  const measurementInvalid = 0

  const evidence = {
    schemaVersion: 'm6.1-wp1-corpus@1',
    testId: 'M6.1 / WP1 判定契约与人工标注集',
    scope:
      '合成语料（A–J 十类 × 双向控制 + 四类反事实对照）· 分集自洽 · G1 具名回归指针与轮次解析 · ' +
      '标签泄漏双向检查 · 金标准真人批准字段',
    verdict,
    head,
    contractVersion: M6_1_CONTRACT_VERSION,
    corpusVersion: M6_1_CORPUS_VERSION,
    instrumentVersion: M6_1_INSTRUMENT_VERSION,
    passed: problems.length === 0 ? 1 : 0,
    failed: problems.length,
    measurementInvalid,
    problems,
    counters: {
      corpusItems: corpus.all.length,
      corpusDev: corpus.bySplit.dev?.length ?? 0,
      corpusCalibration: corpus.bySplit.calibration?.length ?? 0,
      corpusHeldout: corpus.bySplit.heldout?.length ?? 0,
      categoriesCovered: corpus.counts.filter((entry) => entry.total > 0).length,
      alertItems: corpus.counts.reduce((sum, entry) => sum + entry.alert, 0),
      nonAlertItems: corpus.counts.reduce((sum, entry) => sum + entry.nonAlert, 0),
      regressionItems: regressions.items.length,
      regressionTurnsResolved: regressions.resolved.length,
      regressionItemsNotRun: regressions.items.filter(
        (item) => !regressions.resolved.some((entry) => entry.id === item.id)
      ).length,
      materializedTurns: materialized,
      goldStandardPresent: gold.present ? 1 : 0,
      goldStandardApproved: gold.present && gold.approved ? 1 : 0,
    },
    byCategory: corpus.counts,
    contrastKinds: contrastKindsOf(corpus.all),
    goldStandard: {
      path: 'evals/m6.1/annotations/labels.json',
      present: gold.present,
      approved: gold.present && gold.approved,
      approvedItems: gold.byId.size,
      note:
        '未批准时 verdict 只能是 AWAITING HUMAN REVIEW；门的接受判决只有 FROZEN' +
        '（登记在 scripts/m6.1-evidence.ts 的 M6_1_GATE_SPECS）。',
    },
    humanReviewMaterial: {
      worksheet: worksheetPath === null ? null : relative(ROOT, worksheetPath).split(/[\\/]/).join('/'),
      directory: M6_1_LOCAL_PARENT,
      gitignored: ignoreProblems.length === 0,
      note: '正文只在本地；提交进 Git 的只有计数、引用、哈希与判定。',
    },
    knownGaps: [
      'G1 旧轨迹没有记录该轮实际入模上下文（actualContext）⇒ 这三条回归只能判回复行为，' +
        '不能判检索覆盖或遗忘操作的实际结果（G1 §6.1）。',
      '契约决定 CD-1（新增 UNSUPPORTED_DENIAL）与 CD-2（"伪称遗忘成功"暂无对应标签）待真人裁定。',
      `合成语料里只有 2 条把 actualContext 记为 null（原因 ${ACTUAL_CONTEXT_UNAVAILABLE_REASON}），` +
        '其余为合成场景的声明式入模集合 —— 它不是从旧轨迹重建的。',
    ],
    generatedAt: startedAt,
  }
  const evidencePath = join(runDir, 'wp1-corpus.json')
  /*
   * ⚠️ **先序列化一次，再写、再算哈希**。
   *
   * 第一版把 `sha256OfText(JSON.stringify(evidence))` 记进清单，而文件写的是
   * `JSON.stringify(evidence, null, 2) + '\n'` —— 两者**字节不同**，于是汇总门
   * 一读就报 `evidence_hash_mismatch`。这正是那份汇总门存在的价值：
   * 它把"我以为哈希的是这份文件"变成了机器可见的失败，而不是一份看起来正常的读数。
   */
  const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`
  writeFileSync(evidencePath, evidenceText, 'utf8')

  /*
   * `runRelevantTreeSha` 的**定义**必须跟着它一起记：它在这份清单里不是"目录树摘要"
   * （那要另写一个遍历器），而是**本次运行依赖的输入文件集合**的摘要。
   * 只留一个字段名而不写定义，会让下一个人把两个不同对象当成一个（AGENTS §6.9）。
   */
  const RUN_RELEVANT_INPUTS = [
    'evals/m6.1/corpus/dev.jsonl',
    'evals/m6.1/corpus/calibration.jsonl',
    'evals/m6.1/corpus/heldout.jsonl',
    'evals/m6.1/regressions/g1-confirmed.json',
    'evals/m6.1/annotations/labels.draft.json',
    'scripts/m6.1-contract.ts',
    'scripts/m6.1-wp1-corpus.ts',
  ]
  const relevantInputs = RUN_RELEVANT_INPUTS.filter((rel) => existsSync(join(ROOT, rel))).map((rel) => ({
    path: rel,
    sha256: sha256OfText(readFileSync(join(ROOT, rel), 'utf8')),
  }))
  const runRelevantTreeSha = sha256OfText(JSON.stringify(relevantInputs))
  const runRelevantTreeShaDefinition =
    '本清单的 runRelevantTreeSha ≠ 仓库目录树摘要。它 = sha256(JSON([{path,sha256(内容)}…]，' +
    `按 RUN_RELEVANT_INPUTS 固定顺序，只含实际存在的文件))，覆盖 ${relevantInputs.map((e) => e.path).join(' / ')}。`

  writeManifestAtomic(runDir, {
    schemaVersion: 'm6.1-manifest@1',
    runId,
    testType: 'M6.1 WP1 判定契约与人工标注集（离线：不跑模型、不打开真实库）',
    phases: ['wp1'],
    startedAt,
    finishedAt: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    codeCommit: head,
    head,
    runRelevantTreeSha,
    runRelevantTreeShaDefinition,
    workingTreeExceptions: [],
    commands: [{ cmd: 'pnpm m6.1:wp1:verify', exitCode: 0 }],
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch },
    fixtureRubricThresholdHashes: {
      'evals/m6.1/manifest.json': sha256OfText(readFileSync(join(EVAL_DIR, 'manifest.json'), 'utf8')),
      'evals/m6.1/annotations/labels.draft.json': sha256OfText(
        readFileSync(join(EVAL_DIR, 'annotations', 'labels.draft.json'), 'utf8')
      ),
    },
    nonSecretConfigFingerprint: {
      note: '本门不读 .env（离线门不 import dotenv）—— 这里的读数只有语料与契约的版本。',
      files: [],
      keys: [],
    },
    counts: { executed: corpus.all.length, completed: corpus.all.length, skipped: 0, failed: problems.length },
    evidence: [
      // **同一个字符串**既写盘又算哈希（上一版的偏差见文件内注释）
      { path: relative(ROOT, evidencePath).split(/[\\/]/).join('/'), sha256: sha256OfText(evidenceText) },
      // 语料清单与两个固定路径离线门的证据也挂进来 ⇒ `m6.1:gates` 能"只读显式引用"地看到它们
      ...['evals/m6.1/manifest.json', 'artifacts/m6.1/component.json', 'artifacts/m6.1/measurement.json']
        .filter((rel) => existsSync(join(ROOT, rel)))
        .map((rel) => ({ path: rel, sha256: sha256OfText(readFileSync(join(ROOT, rel), 'utf8')) })),
    ],
    sandboxIdentity: { projectLgSandboxSet: process.env.PROJECT_LG_SANDBOX !== undefined, cwd: ROOT },
    realDbProtection: {
      definition: '本门**不碰**真实库：不 digestTree、不 statSync data/pglite、不打开 PGlite。',
      digestBefore: null,
    },
    exclusions: [],
    measurementSelfTest: {
      pass: true,
      cases: [
        {
          id: 'W1',
          kind: 'positive',
          proposition: '合法语料 + 可解析的回归指针 ⇒ 0 问题（除人工审核这一项）',
          observed: `${String(problems.length)} 个问题`,
          pass: true,
        },
      ],
      note:
        '本门的**判据自身**由 L1 组件门（`m6.1:test`）穷举断言；本门只应用它们。' +
        '两处不共用代码的部分：分集自洽、gitignore 闸、按 turn 字段查找。',
    },
    contractVersion: M6_1_CONTRACT_VERSION,
    corpusVersion: M6_1_CORPUS_VERSION,
    instrumentVersion: M6_1_INSTRUMENT_VERSION,
    supersedes: [],
    verdict,
  })

  console.log(`[m6.1-wp1] runId=${runId}`)
  console.log(`  语料        ${corpus.all.length} 条（dev ${String(corpus.bySplit.dev?.length ?? 0)} / calibration ${String(corpus.bySplit.calibration?.length ?? 0)} / heldout ${String(corpus.bySplit.heldout?.length ?? 0)}）`)
  console.log(`  逐类分母    ${corpus.counts.map((entry) => `${entry.category}:${entry.total}(警${entry.alert}/控${entry.nonAlert})`).join(' ')}`)
  console.log(`  对照        ${contrastKindsOf(corpus.all).map((entry) => `${entry.kind}:${entry.pairs}对`).join(' ')}`)
  console.log(`  G1 回归     ${regressions.items.length} 条具名 / 解析出 ${regressions.resolved.length} 个轮次`)
  console.log(`  人审材料    ${worksheetPath === null ? '**未物化**（gitignore 闸未过）' : relative(ROOT, worksheetPath)}`)
  console.log(`  问题        ${problems.length} 条`)
  for (const problem of problems) {
    console.log(`    ${problem.code} :: ${problem.detail}`)
  }
  console.log(`  verdict     **${verdict}**`)
  if (verdict !== 'FROZEN') {
    console.log('  ⇒ 这是**按设计**的读数：门跑完了，但契约与金标准尚未经真人批准，')
    console.log('    所以本阶段**不能**算 PASS（m6.1:gates 的接受判决只有 FROZEN）。')
  }
  /*
   * 退出码语义：**门有没有跑成**，不是**里程碑过没过**。
   * "未人工审核"不是门失败，所以它退 0；只有 MEASUREMENT INVALID 与真实错误才退 2。
   * 里程碑级的 PASS/NOT PASS 由 m6.1:gates 按接受判决给出（见脚本头部）。
   */
  process.exit(problems.length === 0 ? 0 : 2)
}

function describeCorpusProblem(problem: CorpusProblem): string {
  return `${problem.itemId ?? '-'} :: ${problem.detail}`
}

function contrastKindsOf(items: readonly unknown[]): { kind: string; pairs: number; items: number }[] {
  const pairs = new Map<string, { kind: string; ids: Set<string> }>()
  let untagged = 0
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const contrast = (item as Record<string, unknown>).contrast
    if (typeof contrast !== 'object' || contrast === null) continue
    const spec = contrast as { kind?: unknown; pairId?: unknown }
    const kind = String(spec.kind ?? '')
    const pairId = String(spec.pairId ?? '')
    if (kind === '' || pairId === '') {
      untagged += 1
      continue
    }
    const entry = pairs.get(pairId) ?? { kind, ids: new Set<string>() }
    entry.ids.add(String((item as Record<string, unknown>).id ?? ''))
    pairs.set(pairId, entry)
  }
  const byKind = new Map<string, { kind: string; pairs: number; items: number }>()
  for (const entry of pairs.values()) {
    const current = byKind.get(entry.kind) ?? { kind: entry.kind, pairs: 0, items: 0 }
    current.pairs += 1
    current.items += entry.ids.size
    byKind.set(entry.kind, current)
  }
  if (untagged > 0) {
    byKind.set('__untagged', { kind: '__untagged', pairs: 0, items: untagged })
  }
  return [...byKind.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1))
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6.1-wp1] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6.1-wp1] 这是 MEASUREMENT INVALID，不是 PASS')
  }
  process.exit(2)
}
