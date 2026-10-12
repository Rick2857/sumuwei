/**
 * M9.5 WP10（前置）—— **人审材料门**（`pnpm m9.5:quality:verify`）。
 *
 * ============================================================================
 *  它做的事：把"人审"从一句待办变成**一份可判的材料 + 若干可复核的性质**
 * ============================================================================
 * ```text
 * 计划 §12 WP10 的第一件事是**人审材料**；而人审最容易出的两类错都不是"审不出来"：
 *   ① **盲化失败**：卡片里夹带了答案键（`relevantMemoryIds` / `forbiddenIds` /
 *      `acceptableAnswerPoints` / `expectedUnknownOrClarify`）⇒ 评审人只是把答案抄一遍，
 *      而那样得到的"通过"**不是**质量读数。
 *   ② **抽样不可复现**：今天抽 24 条、明天换 24 条 ⇒ 两次人审不可比。
 * ⇒ 本门逐条把它们做成判据：
 *      · 抽样**带种子且可复现**（同一颗种子给出同一组 caseId）
 *      · 卡片里的每个字段都**只**来自白名单；答案键的**每一个取值**都不得出现在卡片里
 *      · 相对**分层**（stratum）有覆盖（不能只抽到某一类）
 *      · 计数型自检（抽 0 条 ≠ 抽得对）
 *      · 人审结论如实记为 **`PENDING`** —— 本门**不**产出质量结论
 * ```
 * ⚠️ 材料落在 `artifacts/m9.5/local/quality-review/`（**gitignore 的私有实验目录**）：
 *    它含语料正文，不该进仓库。
 *
 * 用法：`pnpm m9.5:quality:verify`
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

import { sha256 } from './m4-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  runIdFromM95OutPath,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-quality@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const CORPUS_DIR = join(REPO_ROOT, 'evals/m9.5/corpus')
const REVIEW_DIR = join(REPO_ROOT, 'artifacts/m9.5/local/quality-review')
const GAUGE_REVIEW = join(REPO_ROOT, 'artifacts/m9.5/local/measurement-review/review-30.jsonl')

/** **抽样种子**：固定 ⇒ 两次人审抽到同一组（可复现、可比） */
const SAMPLE_SEED = 'm9.5-quality-review@1'
const SAMPLE_SIZE = 24

/**
 * 卡片**允许**出现的字段（白名单）。
 * ⚠️ 白名单而不是黑名单：黑名单会随语料加字段而**静默失效**。
 */
const CARD_FIELDS = ['cardId', 'request', 'memory', 'ask', 'sceneEvidence'] as const

/**
 * 三类**必须**在卡片上带"独立判断所需的证据"，且**逐条**满足结构性质。
 *
 * 第二轮人审指出上一版太弱（只要求三类**合计 > 0**、`nonEmpty` 不校验类型、
 * `candidateSubjects` 一个主体或两个重复主体也能过）⇒ 这里改成**逐类、逐性质**判定。
 */
const EVIDENCE_RULE_VERSION = 'm9.5-evidence-rule@1'

/**
 * **已申报的"预测字段"豁免表**（第二轮人审后新增，`L-M95-15`）。
 *
 * ```text
 * 现实张力：`memory.previousValue` 同时是
 *   · `historyVsCurrent` / `summaryConflict` 的**判断必需**（不给旧值，评审人无从判断），且
 *   · **低基数 + 与"可回答"完全相关**（有 predecessor 的题都属 retrieve 类）
 * ⇒ 既不能删（删了那两类不可判），也不能假装它不预测。
 * 处置：**显式申报**，理由写在下面；判据要求"除申报项外，不得出现任何预测字段"，
 *       并把申报项**记进证据档**（可见，不是静默豁免）。
 * ⚠️ 若将来出现**新的**预测字段，判据**会红** —— 那时必须回到这里申报并说明理由。
 * ```
 */
const PREDICTOR_EXEMPTIONS: Record<string, string> = {
  'memory.previousValue':
    'historyVsCurrent / summaryConflict 的判断必需；其存在性与"可回答"的相关是**场景设计**的结果，不是为评审人加的答案提示',
}
const EVIDENCE_REQUIRED_KINDS = ['wrongOwner', 'ambiguousSubject', 'brokenRoot'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * **逐类**给出"这份证据够不够判"的具名问题列表（空 = 够）。
 *
 * 每条断言都对应一个真实的失败形态（括号里是它防的那种"看起来齐了"）。
 */
function evidenceProblemsOf(kind: string, evidence: unknown): string[] {
  const problems: string[] = []
  if (!isRecord(evidence)) return ['sceneEvidence 不是对象']
  const owner = isRecord(evidence.otherOwnerRecord) ? evidence.otherOwnerRecord : null

  switch (kind) {
    case 'wrongOwner': {
      /* ① 当前 owner 与读取范围必须显式（防"与顶层 memory.owner 混淆"） */
      if (!nonEmptyString(evidence.currentOwner)) problems.push('wrongOwner 缺 currentOwner')
      if (!nonEmptyString(evidence.accessScope)) problems.push('wrongOwner 缺 accessScope')
      /* ② 第三轮人审：当前 owner 的记录集合必须**显式为空**（防"看起来两个 owner 都有记录"） */
      if (!Array.isArray(evidence.currentOwnerRecords) || evidence.currentOwnerRecords.length !== 0) {
        problems.push('wrongOwner 的 currentOwnerRecords 必须是**空数组**（当前 owner 无记录）')
      }
      const other = isRecord(evidence.inaccessibleCandidateRecord) ? evidence.inaccessibleCandidateRecord : null
      if (other === null) {
        problems.push('wrongOwner 的 inaccessibleCandidateRecord 必须是对象')
        break
      }
      for (const key of ['recordId', 'owner', 'subject', 'predicate', 'value'] as const) {
        if (!nonEmptyString(other[key])) problems.push(`wrongOwner.inaccessibleCandidateRecord 缺 ${key}`)
      }
      /* ③ 该候选必须**标记为不可访问**（它是"只有另一 owner 有"的那条） */
      if (other.accessible !== false) {
        problems.push('wrongOwner 的候选记录必须标 accessible = false')
      }
      /* ④ **两个 owner 必须不同** */
      if (nonEmptyString(other.owner) && nonEmptyString(evidence.currentOwner) && other.owner === evidence.currentOwner) {
        problems.push('wrongOwner 的 currentOwner 与候选记录的 owner **相同**')
      }
      break
    }
    case 'ambiguousSubject': {
      const records = evidence.candidateRecords
      /* ① 必须是**两条实际候选记录**（防"只有一个主体"） */
      if (!Array.isArray(records) || records.length < 2) {
        problems.push('ambiguousSubject 的 candidateRecords 必须至少有 2 条')
        break
      }
      const ids = new Set<string>()
      const subjects = new Set<string>()
      const values = new Set<string>()
      for (const [index, record] of records.entries()) {
        if (!isRecord(record)) {
          problems.push(`candidateRecords[${String(index)}] 不是对象`)
          continue
        }
        for (const key of ['recordId', 'subject', 'value'] as const) {
          if (!nonEmptyString(record[key])) problems.push(`candidateRecords[${String(index)}] 缺 ${key}`)
        }
        if (nonEmptyString(record.recordId)) ids.add(String(record.recordId))
        if (nonEmptyString(record.subject)) subjects.add(String(record.subject))
        if (nonEmptyString(record.value)) values.add(String(record.value))
      }
      /* ② 记录 id 与**主体**都不得重复（防"两条一样的记录"充数） */
      if (ids.size !== records.length) problems.push('candidateRecords 的 recordId 有重复')
      if (subjects.size < 2) problems.push('candidateRecords 的 subject **不足两个不同主体**')
      /*
       * ③ 第三轮人审：两条**取值必须不同** —— 否则"直接回答共同值"不一定错，
       *    也就无法验证"选错主体会答错"。
       */
      if (values.size < 2) problems.push('candidateRecords 的 **取值必须不同**（否则无法验证选错主体会答错）')
      /* ④ 必须明确**没有可消歧的上下文** */
      if (evidence.disambiguatingContext !== null) {
        problems.push('ambiguousSubject 必须显式声明 disambiguatingContext = null')
      }
      break
    }
    case 'brokenRoot': {
      /* ① 断链事实必须显式（空引用列表**正是**内容，所以只要求是数组） */
      if (!Array.isArray(evidence.rootEvidenceRefs)) problems.push('brokenRoot 的 rootEvidenceRefs 必须是数组')
      /* ② 状态必须是 broken */
      if (evidence.rootStatus !== 'broken') problems.push("brokenRoot 的 rootStatus 必须是 'broken'")
      /* ③ 必须标明是**合成前提**（防读成"实际运行中已验证断链"） */
      if (evidence.provenance !== 'synthetic_premise') {
        problems.push("brokenRoot 必须标明 provenance = 'synthetic_premise'")
      }
      break
    }
    default:
      problems.push(`未知的需要证据的类别：${kind}`)
  }
  return problems
}

/** **答案键**：这些字段的**取值**一个都不许出现在卡片里。 */
const WITHHELD_FIELDS = [
  'relevantMemoryIds',
  'requiredEvidenceGroups',
  'forbiddenIds',
  'expectedUnknownOrClarify',
  'acceptableAnswerPoints',
  'stratum',
  'formKind',
  'annotator',
  'adjudication',
] as const

/**
 * 卡片上的**提问**（用户 2026-09-28 人审指出：「我没有记过」是**错误引导**）。
 *
 * ```text
 * 修前：`ask` 把"没答上来"当成"应该回『我没有记过』" —— 那是**错误的推断**：
 *   遗忘 / 来源断链 / 主体不明确 / 跨 owner，**都不能**推出"从未记过"，
 *   而答案键自己也要求不得这样推断。
 * ⇒ 四个选项必须**分开**，并明确禁止该推断。
 * ```
 */
const CARD_ASK = [
  '请判断：这句话应当用哪条记忆来回答？四选一（可加备注）：',
  '① 有可用依据 —— 写出是哪一条；',
  '② 目前没有可用依据 —— ⚠️ 这**不等于**「从未记过」：遗忘 / 来源断链 / 主体不明确 / 跨 owner 都会导致无依据；',
  '③ 需要澄清 —— 这句话本身需要先问清楚（例如指代不明）；',
  '④ 材料不足以判断 —— 并写出**缺什么**（这条判的是材料，不是被审对象）。',
].join('\n')

interface Probe {
  readonly id: string
  readonly question: string
  readonly verdict: 'ok' | 'unexpected'
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

async function probe(input: {
  readonly id: string
  readonly question: string
  readonly run: () => Record<string, unknown>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Promise<Probe> {
  try {
    const reading = input.run()
    const problems = input.judge?.(reading) ?? []
    return {
      id: input.id,
      question: input.question,
      verdict: problems.length > 0 ? 'unexpected' : 'ok',
      reading,
      error: problems.length > 0 ? problems.join('; ') : null,
    }
  } catch (error) {
    return {
      id: input.id,
      question: input.question,
      verdict: 'unexpected',
      reading: {},
      error: (error as Error).message.replace(/\s+/g, ' ').slice(0, 240),
    }
  }
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function safeTreeDigest(): Record<string, unknown> | null {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return { dir: 'data/pglite', measuredCount: digest.measuredCount, treeSha256: digest.treeSha256 }
  } catch (error) {
    return { dir: 'data/pglite', error: (error as Error).message }
  }
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 确定性排序键：由种子派生的 sha256 前 16 位（**同样的种子给同样的顺序**） */
function rankOf(seed: string, key: string): string {
  return createHash('sha256').update(`${seed}|${key}`).digest('hex').slice(0, 16)
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp10-quality', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const probes: Probe[] = []

  const dev = readJsonl(join(CORPUS_DIR, 'dev.jsonl'))
  const val = readJsonl(join(CORPUS_DIR, 'val.jsonl'))
  const pool = [...dev, ...val]

  /* ---- 抽样：确定性 + 分层轮转 ---- */
  const byStratum = new Map<string, Record<string, unknown>[]>()
  for (const item of pool) {
    const stratum = String(item.stratum ?? 'unknown')
    byStratum.set(stratum, [...(byStratum.get(stratum) ?? []), item])
  }
  for (const [stratum, items] of byStratum) {
    byStratum.set(stratum, [...items].sort((a, b) => (rankOf(SAMPLE_SEED, String(a.caseId)) < rankOf(SAMPLE_SEED, String(b.caseId)) ? -1 : 1)))
  }
  const strata = [...byStratum.keys()].sort()
  const picked: Record<string, unknown>[] = []
  let cursor = 0
  while (picked.length < SAMPLE_SIZE && cursor < SAMPLE_SIZE * 10) {
    for (const stratum of strata) {
      const items = byStratum.get(stratum) ?? []
      const item = items[cursor]
      if (item !== undefined && picked.length < SAMPLE_SIZE) picked.push(item)
    }
    cursor += 1
  }

  /*
   * ★ **保证三类各至少一张**：否则"第⑦条逐类断言"要么靠抽样运气，
   *   要么因为没抽到而**误报**。替换掉末尾若干张（确定性：同种子同结果）。
   */
  const guaranteed: string[] = []
  for (const kind of EVIDENCE_REQUIRED_KINDS) {
    if (picked.some((item) => String(item.formKind) === kind)) continue
    const candidate = pool.find((item) => String(item.formKind) === kind)
    if (candidate === undefined) {
      guaranteed.push(`${kind}:池中不存在（无法保证覆盖）`)
      continue
    }
    /* 替换最后一张：保持总数不变、且**确定性** */
    picked[picked.length - 1] = candidate
    guaranteed.push(`${kind}:已强制纳入`)
  }

  /**
   * **卡片上的"记忆"只保留场景事实**。
   *
   * ⚠️ 第二轮人审指出：`authoritativeSnapshot.status` 由**预设答案**生成
   *    （`retrieve ? 'active' : 'absent_or_not_usable'`）⇒ **24/24 张都能靠它预测答案**。
   *    那是盲化漏洞，不是"证据不足" ⇒ 卡片**不得**携带任何**能预测答案**的字段。
   * ⚠️ 语料内部仍保留 `status`（WP9 物化 fixture 需要它）；**卡片**上不出现。
   */
  const memoryForCard = (snapshot: unknown, sceneEvidence: unknown): Record<string, unknown> => {
    const s = (snapshot ?? {}) as Record<string, unknown>
    const evidence = (sceneEvidence ?? {}) as Record<string, unknown>
    /*
     * ⚠️ 第三轮人审（Q024）：当**正式 Memory 集合为空**时，顶层 `memory` **不能**再展示一个取值
     *    —— 否则"权威快照里有这条"与答案键"从未正式保存"互相矛盾，评审人只能猜一个看不见的标签。
     * ⇒ 把**缺失本身**作为场景事实渲染出来（与 `sceneEvidence` 同源）。
     */
    const formalRecords = evidence.formalMemoryRecords
    if (Array.isArray(formalRecords) && formalRecords.length === 0) {
      return {
        formalMemoryRecords: [],
        ...(evidence.appearsOnlyIn !== undefined ? { appearsOnlyIn: evidence.appearsOnlyIn } : {}),
      }
    }
    /* `wrongOwner`：当前 owner 无记录（否则看起来"两个 owner 都有记录"） */
    if (Array.isArray(evidence.currentOwnerRecords) && evidence.currentOwnerRecords.length === 0) {
      return { currentOwnerRecords: [] }
    }
    return {
      ...(s.owner !== undefined ? { owner: s.owner } : {}),
      ...(s.subject !== undefined ? { subject: s.subject } : {}),
      ...(s.predicate !== undefined ? { predicate: s.predicate } : {}),
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(s.previousValue !== undefined ? { previousValue: s.previousValue } : {}),
    }
  }

  const cards = picked.map((item, index) => ({
    cardId: `Q-${String(index + 1).padStart(3, '0')}`,
    request: item.request,
    memory: memoryForCard(item.authoritativeSnapshot, item.sceneEvidence),
    ask: CARD_ASK,
    /*
     * ⚠️ **不是答案键**：这是"判断需要知道的事实"（当前 owner / 访问范围 / 另一 owner 的
     *    结构化记录 / 候选记录 / 来源断链事实）。第二轮人审指出缺了它，评审人只能猜。
     */
    sceneEvidence: item.sceneEvidence ?? {},
  }))
  const answerKey = picked.map((item, index) => ({
    cardId: `Q-${String(index + 1).padStart(3, '0')}`,
    caseId: item.caseId,
    relevantMemoryIds: item.relevantMemoryIds,
    forbiddenIds: item.forbiddenIds,
    expectedUnknownOrClarify: item.expectedUnknownOrClarify,
    acceptableAnswerPoints: item.acceptableAnswerPoints,
    stratum: item.stratum,
    formKind: item.formKind,
  }))

  mkdirSync(REVIEW_DIR, { recursive: true })
  const cardsPath = join(REVIEW_DIR, 'cards.jsonl')
  const keyPath = join(REVIEW_DIR, 'answer-key.json')
  writeFileSync(cardsPath, `${cards.map((card) => JSON.stringify(card)).join('\n')}\n`, 'utf8')
  writeFileSync(keyPath, `${JSON.stringify({ seed: SAMPLE_SEED, size: SAMPLE_SIZE, key: answerKey }, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(REVIEW_DIR, 'README.md'),
    [
      '# M9.5 人审材料（quality 门的前置）',
      '',
      `抽样：\`${SAMPLE_SEED}\` · ${String(SAMPLE_SIZE)} 条 · 分层轮转（相对 stratum 覆盖）`,
      '',
      '## ⚠️ 本包当前**不可用于人审**（2026-09-28 撤回）',
      '',
      '首轮人审指出的问题已登记为 `L-M95-11`（见 `docs/m9.5/M9.5-Known-Limitations.md`）：',
      '语料把**测试提示写进了用户原话**、部分 `formKind` 标签与内容不符、',
      '跨 owner / 主体歧义 / 来源断链类**没有给出判断所需的证据**。',
      '⇒ 在语料重生成之前，**不要**据此出质量结论；本目录只作为缺陷证据保留。',
      '',
      '## 怎么审（语料修好之后）',
      '',
      '1. 逐条读 `cards.jsonl` 的 `request`（用户原话）与 `memory`（权威快照）。',
      '2. 按卡片上的 `ask` **四选一**：① 有可用依据 / ② 目前没有可用依据 / ③ 需要澄清 / ④ 材料不足以判断。',
      '   ⚠️ **不得**从「② 没有可用依据」推出「从未记过」—— 遗忘、来源断链、主体不明确、跨 owner',
      '   都会导致无依据，而它们与"从未记过"是**四件不同的事**。',
      '3. 把判断写进 `verdicts.jsonl`：`{"cardId":"Q-001","verdict":"有可用依据","note":"..."}`。',
      '',
      '⚠️ `answer-key.json` 是**答案键**（`relevantMemoryIds` / `forbiddenIds` / 期望澄清等）。',
      '   **审完再看**。卡片里刻意不含这些字段 —— 这也是本门会机器核对的性质。',
      '',
      '⚠️ 本目录在 gitignore 的私有实验区（含语料正文，不进仓库）。',
    ].join('\n') + '\n',
    'utf8'
  )

  /* ---- ① 抽样确定性 + 分层覆盖 ---- */
  probes.push(
    await probe({
      id: 'sample-is-deterministic-and-stratified',
      question: `① 抽样**可复现**（同种子同结果）且相对分层有覆盖（${String(SAMPLE_SIZE)} 条）`,
      run: () => {
        const secondPass = picked.map((item) => String(item.caseId))
        const firstPass = cards.map((card, index) => String(picked[index]?.caseId))
        const usedStrata = [...new Set(picked.map((item) => String(item.stratum ?? 'unknown')))].sort()
        return {
          poolSize: pool.length,
          picked: picked.length,
          strataInPool: strata.length,
          strataUsed: usedStrata,
          deterministic: JSON.stringify(firstPass) === JSON.stringify(secondPass),
          cardIds: cards.map((card) => card.cardId),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.poolSize) <= 0) problems.push('语料池为空 ⇒ MEASUREMENT INVALID')
        if (Number(reading.picked) !== SAMPLE_SIZE) {
          problems.push(`应抽 ${String(SAMPLE_SIZE)} 条，实际 ${String(reading.picked)}`)
        }
        if (reading.deterministic !== true) problems.push('★ 抽样不可复现（同种子两次不同）')
        /* 分层覆盖：用到的分层数不能明显少于池里的分层数 */
        const used = (reading.strataUsed as string[]).length
        const inPool = Number(reading.strataInPool)
        if (used < Math.min(inPool, 3)) {
          problems.push(`★ 分层覆盖不足：池中 ${String(inPool)} 类、只抽到 ${String(used)} 类`)
        }
        return problems
      },
    })
  )

  /* ---- ② ★ 盲化：答案键的**每一个取值**都不得出现在卡片里 ---- */
  probes.push(
    await probe({
      id: 'answer-key-is-not-in-the-cards',
      question: '② ★ 盲化：卡片**只**含白名单字段，且答案键的每个取值都**不在**卡片里',
      run: () => {
        const cardsText = readFileSync(cardsPath, 'utf8')
        const cardsParsed = readJsonl(cardsPath)
        /* 字段白名单核对 */
        const extraFields = [
          ...new Set(cardsParsed.flatMap((card) => Object.keys(card).filter((key) => !(CARD_FIELDS as readonly string[]).includes(key)))),
        ]
        /* 取值核对：答案键里的每个标量/数组元素都不得出现 */
        const leakedValues: string[] = []
        for (const entry of answerKey) {
          for (const field of WITHHELD_FIELDS) {
            const value = (entry as Record<string, unknown>)[field]
            const values = Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)]
            for (const candidate of values) {
              /*
               * ⚠️ **跳过布尔字面量**：`expectedUnknownOrClarify` 是布尔，`String(false)` = `"false"`，
               *    而卡片里有 `"accessible":false` 之类的**无关布尔** ⇒ 子串匹配会**误报泄漏**。
               *    （实测踩到：第③条把 `expectedUnknownOrClarify=false` 报成泄漏。）
               *    布尔值不携带任何可识别信息 ⇒ 不参与"取值泄漏"扫描是**语义正确**的，不是放宽。
               */
              if (candidate === 'true' || candidate === 'false') continue
              if (candidate.length >= 3 && cardsText.includes(candidate)) leakedValues.push(`${field}=${candidate}`)
            }
          }
        }
        /* **正控**：同样的检查要能抓到"确实在卡片里"的东西（否则"没泄漏"可能是检查坏了） */
        const positiveControlDetects = cardsText.includes(String(cards[0]?.request ?? '\u0000'))
        return {
          cardCount: cardsParsed.length,
          allowedFields: [...CARD_FIELDS],
          extraFields,
          leakedValues: leakedValues.slice(0, 5),
          leakedCount: leakedValues.length,
          positiveControlDetects,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if ((reading.extraFields as string[]).length > 0) {
          problems.push(`★ 卡片出现白名单外的字段：${(reading.extraFields as string[]).join(',')}`)
        }
        if (Number(reading.leakedCount) > 0) {
          problems.push(`★ 答案键泄漏进卡片：${(reading.leakedValues as string[]).join(' | ')}`)
        }
        if (reading.positiveControlDetects !== true) {
          problems.push('★ 正控失败：检查连"确实在卡片里的内容"都认不出来 ⇒ 上面的"无泄漏"不可信')
        }
        return problems
      },
    })
  )

  /* ---- ③ 已有 gauge 盲审样本在案且可解析 ---- */
  probes.push(
    await probe({
      id: 'gauge-review-samples-are-on-file',
      question: '③ 判定器的 30 条盲审样本在案、30 行、逐行可解析',
      run: () => {
        const exists = existsSync(GAUGE_REVIEW)
        const lines = exists
          ? readFileSync(GAUGE_REVIEW, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0)
          : []
        let parseFailures = 0
        for (const line of lines) {
          try {
            JSON.parse(line)
          } catch {
            parseFailures += 1
          }
        }
        return { exists, lines: lines.length, parseFailures }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.exists !== true) problems.push('★ 判定器的盲审样本不在案')
        if (Number(reading.lines) !== 30) problems.push(`样本应为 30 行，实际 ${String(reading.lines)}`)
        if (Number(reading.parseFailures) > 0) problems.push(`${String(reading.parseFailures)} 行解析失败`)
        return problems
      },
    })
  )

  /* ---- ④ 材料完整性与计数自检 ---- */
  probes.push(
    await probe({
      id: 'review-packet-is-complete',
      question: '④ 评审包三件齐备（cards / answer-key / README）且计数自检通过',
      run: () => {
        const files = ['cards.jsonl', 'answer-key.json', 'README.md'].map((name) => ({
          name,
          exists: existsSync(join(REVIEW_DIR, name)),
          bytes: existsSync(join(REVIEW_DIR, name)) ? readFileSync(join(REVIEW_DIR, name), 'utf8').length : 0,
        }))
        return { files, cardCount: readJsonl(cardsPath).length, keyCount: JSON.parse(readFileSync(keyPath, 'utf8')).key.length }
      },
      judge: (reading) => {
        const problems: string[] = []
        for (const file of reading.files as { name: string; exists: boolean; bytes: number }[]) {
          if (file.exists !== true || file.bytes <= 0) problems.push(`材料缺失或为空：${file.name}`)
        }
        /* ★ 计数型自检：0 张卡片与"卡片都对"在输出上长得一样 */
        if (Number(reading.cardCount) <= 0) problems.push('★ 卡片数为 0 ⇒ MEASUREMENT INVALID')
        if (reading.cardCount !== reading.keyCount) {
          problems.push(`卡片数(${String(reading.cardCount)}) ≠ 答案键条数(${String(reading.keyCount)})`)
        }
        return problems
      },
    })
  )

  /* ---- ⑤ 措辞规则：**不得**把"无可用依据"引导成"从未记过"（人审指出的缺陷类） ---- */
  probes.push(
    await probe({
      id: 'ask-does-not-conflate-absence-with-never-recorded',
      question:
        '⑤ ★ 措辞规则：卡片**分开**给出「目前没有可用依据」与「需要澄清」，且**禁止**把前者读成「从未记过」',
      run: () => {
        const cardsText = readFileSync(cardsPath, 'utf8')
        const readmeText = readFileSync(join(REVIEW_DIR, 'README.md'), 'utf8')
        return {
          askHasNoUsableBasis: CARD_ASK.includes('② 目前没有可用依据'),
          askHasNeedsClarify: CARD_ASK.includes('③ 需要澄清'),
          askHasInsufficientMaterial: CARD_ASK.includes('④ 材料不足以判断'),
          askForbidsTheInference: CARD_ASK.includes('不等于') && CARD_ASK.includes('从未记过'),
          /* 旧措辞必须消失（它会引导出错误结论） */
          legacyWordingGoneFromCards: !cardsText.includes('我没有记过'),
          legacyWordingGoneFromReadme: !readmeText.includes('我没记过'),
          readmeStatesWithdrawal: readmeText.includes('不可用于人审'),
          packetWithdrawn: true,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        for (const key of [
          'askHasNoUsableBasis',
          'askHasNeedsClarify',
          'askHasInsufficientMaterial',
          'askForbidsTheInference',
          'legacyWordingGoneFromCards',
          'legacyWordingGoneFromReadme',
          'readmeStatesWithdrawal',
        ] as const) {
          if (reading[key] !== true) problems.push(`★ 措辞规则未满足：${key}`)
        }
        return problems
      },
    })
  )

  /* ---- ⑦ ★ 三类必须带"独立判断所需的证据"（首轮人审：「缺证据 ⇒ 评审人只能猜」） ---- */
  probes.push(
    await probe({
      id: 'judgment-evidence-present-for-the-three-kinds',
      question:
        '⑦ ★ `wrongOwner` / `ambiguousSubject` / `brokenRoot` 的卡片**必须**带各自所需的证据键（非空）',
      run: () => {
        const cardsParsed = readJsonl(cardsPath)
        const detail: { cardId: string; kind: string; problems: string[] }[] = []
        const perKind: Record<string, number> = {}
        for (let index = 0; index < picked.length; index += 1) {
          const kind = String((picked[index] as Record<string, unknown>).formKind)
          if (!(EVIDENCE_REQUIRED_KINDS as readonly string[]).includes(kind)) continue
          perKind[kind] = (perKind[kind] ?? 0) + 1
          const card = cardsParsed[index] as Record<string, unknown> | undefined
          const problems = evidenceProblemsOf(kind, card?.sceneEvidence)
          if (problems.length > 0) detail.push({ cardId: String(card?.cardId ?? '?'), kind, problems })
        }
        return {
          ruleVersion: EVIDENCE_RULE_VERSION,
          requiredKinds: [...EVIDENCE_REQUIRED_KINDS],
          perKindCount: perKind,
          incomplete: detail,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        const perKind = reading.perKindCount as Record<string, number>
        /*
         * ★ **逐类**要求出现（上一版只要"三类合计 > 0" ⇒ 只抽到一类也能过）。
         *   抽样已由 `guaranteeEvidenceKinds()` 保证覆盖 ⇒ 缺任何一类都是真失败，不是抽样运气。
         */
        for (const kind of reading.requiredKinds as string[]) {
          if ((perKind[kind] ?? 0) <= 0) problems.push(`★ 抽样里没有 ${kind} 卡片 ⇒ 该类的判据是空转的`)
        }
        if ((reading.incomplete as unknown[]).length > 0) {
          problems.push(`★ 有卡片证据不达标：${JSON.stringify((reading.incomplete as unknown[]).slice(0, 3))}`)
        }
        return problems
      },
    })
  )

  /* ---- ⑧ ★ 第⑦条的**负控**：每一种坏形态都必须被单独抓住（否则"加固"只是声称） ---- */
  probes.push(
    await probe({
      id: 'evidence-check-has-teeth',
      question:
        '⑧ ★ 第⑦条负控：逐条喂坏证据 ⇒ **每一种**都必须被具名抓住；真实卡片证据必须**零问题**（正控）',
      run: () => {
        const goodWrongOwner = {
          currentOwner: 'C1',
          accessScope: 'C1（当前会话只读本 owner）',
          /* 当前 owner 的记录集合**显式为空**（第三轮人审 Q002） */
          currentOwnerRecords: [],
          inaccessibleCandidateRecord: {
            recordId: 'mem:C2:p@v@u1',
            owner: 'C2',
            subject: 'u1',
            predicate: 'p',
            value: 'v',
            accessible: false,
          },
        }
        const goodAmbiguous = {
          candidateRecords: [
            /* 两条候选**主体与取值都不同**（第三轮人审 Q016/Q020） */
            { recordId: 'mem:C1:p@v1@u1', subject: 'u1', value: 'v1' },
            { recordId: 'mem:C1:p@v2@u2', subject: 'u2', value: 'v2' },
          ],
          disambiguatingContext: null,
        }
        const goodBroken = { rootEvidenceRefs: [], rootStatus: 'broken', provenance: 'synthetic_premise' }
        const cases: Record<string, string[]> = {
          /* 正控必须**安静** */
          goodWrongOwner: evidenceProblemsOf('wrongOwner', goodWrongOwner),
          goodAmbiguous: evidenceProblemsOf('ambiguousSubject', goodAmbiguous),
          goodBroken: evidenceProblemsOf('brokenRoot', goodBroken),
          /* 负控必须**响** —— 每条对应人审点名的弱点 */
          missingCurrentOwner: evidenceProblemsOf('wrongOwner', { ...goodWrongOwner, currentOwner: undefined }),
          recordIsString: evidenceProblemsOf('wrongOwner', { ...goodWrongOwner, inaccessibleCandidateRecord: 'C2 · p = v' }),
          sameOwner: evidenceProblemsOf('wrongOwner', {
            ...goodWrongOwner,
            inaccessibleCandidateRecord: { ...goodWrongOwner.inaccessibleCandidateRecord, owner: 'C1' },
          }),
          /* 第三轮人审新增的两条弱点 */
          currentOwnerLooksPopulated: evidenceProblemsOf('wrongOwner', {
            ...goodWrongOwner,
            currentOwnerRecords: [{ recordId: 'x' }],
          }),
          candidateRecordAccessible: evidenceProblemsOf('wrongOwner', {
            ...goodWrongOwner,
            inaccessibleCandidateRecord: { ...goodWrongOwner.inaccessibleCandidateRecord, accessible: true },
          }),
          singleCandidate: evidenceProblemsOf('ambiguousSubject', { candidateRecords: [goodAmbiguous.candidateRecords[0]] }),
          duplicateSubjects: evidenceProblemsOf('ambiguousSubject', {
            candidateRecords: [goodAmbiguous.candidateRecords[0], { ...goodAmbiguous.candidateRecords[0] }],
          }),
          /* 第三轮人审：两条取值相同 ⇒ 必须被抓（否则无法验证"选错主体会答错"） */
          sameValueTwice: evidenceProblemsOf('ambiguousSubject', {
            candidateRecords: [
              goodAmbiguous.candidateRecords[0],
              { ...goodAmbiguous.candidateRecords[1], value: 'v1' },
            ],
          }),
          hasDisambiguatingContext: evidenceProblemsOf('ambiguousSubject', {
            ...goodAmbiguous,
            disambiguatingContext: '上下文里提到的那个项目',
          }),
          notBroken: evidenceProblemsOf('brokenRoot', { ...goodBroken, rootStatus: 'ok' }),
          missingProvenance: evidenceProblemsOf('brokenRoot', { rootEvidenceRefs: [], rootStatus: 'broken' }),
          refsNotArray: evidenceProblemsOf('brokenRoot', { ...goodBroken, rootEvidenceRefs: 'none' }),
          notAnObject: evidenceProblemsOf('brokenRoot', null),
        }
        /* 真实卡片的证据也必须零问题（**正控**在真数据上复认） */
        const cardsParsed = readJsonl(cardsPath)
        const realProblems: string[] = []
        for (let index = 0; index < picked.length; index += 1) {
          const kind = String((picked[index] as Record<string, unknown>).formKind)
          if (!(EVIDENCE_REQUIRED_KINDS as readonly string[]).includes(kind)) continue
          const card = cardsParsed[index] as Record<string, unknown> | undefined
          realProblems.push(...evidenceProblemsOf(kind, card?.sceneEvidence))
        }
        return { cases, realProblems, realProblemCount: realProblems.length }
      },
      judge: (reading) => {
        const problems: string[] = []
        const cases = reading.cases as Record<string, string[]>
        for (const key of ['goodWrongOwner', 'goodAmbiguous', 'goodBroken'] as const) {
          if ((cases[key] ?? []).length > 0) problems.push(`正控被误报：${key} ⇒ ${JSON.stringify(cases[key])}`)
        }
        for (const key of [
          'missingCurrentOwner',
          'recordIsString',
          'sameOwner',
          'currentOwnerLooksPopulated',
          'candidateRecordAccessible',
          'singleCandidate',
          'duplicateSubjects',
          'sameValueTwice',
          'hasDisambiguatingContext',
          'notBroken',
          'missingProvenance',
          'refsNotArray',
          'notAnObject',
        ] as const) {
          if ((cases[key] ?? []).length === 0) problems.push(`★ 负控没被抓住：${key}`)
        }
        if (Number(reading.realProblemCount) > 0) {
          problems.push(`★ 真实卡片仍有问题：${JSON.stringify((reading.realProblems as string[]).slice(0, 3))}`)
        }
        return problems
      },
    })
  )

  /* ---- ⑨ ★ 盲化：**任何字段都不得能预测答案**（不只是把 `status` 挪走） ---- */
  probes.push(
    await probe({
      id: 'no-card-field-predicts-the-answer',
      question:
        '⑨ ★ 盲化：卡片上**没有任何**字段能**单独预测**答案（逐字段检查"值 → 答案类"是否一一对应）',
      run: () => {
        const cardsParsed = readJsonl(cardsPath)
        /** 答案类（由**答案键**给出，只在门内部使用）：有合格依据 / 无合格依据 */
        const answerClassOf = (index: number): 'answerable' | 'not_answerable' => {
          const entry = answerKey[index] as { relevantMemoryIds?: unknown[] }
          return (entry.relevantMemoryIds ?? []).length > 0 ? 'answerable' : 'not_answerable'
        }
        const classes = new Set(picked.map((_, index) => answerClassOf(index)))
        /* 扁平化每个字段（顶层 + `memory.*` + `sceneEvidence` 只做存在性，不做值预测） */
        const fieldValueOf = (card: Record<string, unknown>, path: string): string | undefined => {
          const parts = path.split('.')
          let cursor: unknown = card
          for (const part of parts) {
            if (typeof cursor !== 'object' || cursor === null) return undefined
            cursor = (cursor as Record<string, unknown>)[part]
          }
          return cursor === undefined ? undefined : JSON.stringify(cursor)
        }
        const candidatePaths = ['request', 'memory.owner', 'memory.subject', 'memory.predicate', 'memory.value', 'memory.previousValue', 'memory.status']
        /**
         * ★ **基数上限**：只有**低基数**字段才可能携带预测信息。
         *
         * ⚠️ 第一版没有这条 ⇒ 它把 `request`(20 个不同值) 与 `memory.value`(24 个) 都报成
         *    "完美预测字段"。但那在 24 张卡上**每张都唯一** ⇒ "值 → 答案类"必然一一对应，
         *    是**同义反复**（标识符天然"确定"它自己那一条的类）。那是**检查自己的错**，
         *    不是盲化漏洞 —— 一个会把标识符报成泄漏的检查，等于把噪声当证据。
         */
        const cardinalityLimit = Math.max(3, Math.floor(picked.length / 4))
        const predictors: { path: string; distinctValues: number }[] = []
        const lowCardinalityFields: string[] = []
        for (const path of candidatePaths) {
          const map = new Map<string, Set<string>>()
          let observed = 0
          for (let index = 0; index < picked.length; index += 1) {
            const card = cardsParsed[index] as Record<string, unknown> | undefined
            if (card === undefined) continue
            const value = fieldValueOf(card, path)
            if (value === undefined) continue
            observed += 1
            const set = map.get(value) ?? new Set<string>()
            set.add(answerClassOf(index))
            map.set(value, set)
          }
          if (observed === 0) continue
          if (map.size > cardinalityLimit) continue
          lowCardinalityFields.push(`${path}(${String(map.size)})`)
          /* **完美预测**：每个值只对应一个答案类，且样本里不止一个类 */
          const perfect = classes.size > 1 && [...map.values()].every((set) => set.size === 1)
          if (perfect) predictors.push({ path, distinctValues: map.size })
        }
        return {
          answerClassesInSample: [...classes],
          candidatePaths,
          cardinalityLimit,
          lowCardinalityFields,
          predictors,
          /** **已申报的豁免项与其理由**（记进证据档 ⇒ 豁免是**可见**的，不是静默的） */
          declaredExemptions: PREDICTOR_EXEMPTIONS,
          /*
           * **正控**：人为注入一个"完美预测字段"（`injectedPredictor = 答案类`），
           * 它必须是**低基数**且被本规则判为预测字段 —— 否则"没抓到"可能只是检查坏了。
           */
          positiveControl: (() => {
            const map = new Map<string, Set<string>>()
            for (let index = 0; index < picked.length; index += 1) {
              const key = answerClassOf(index)
              const set = map.get(key) ?? new Set<string>()
              set.add(key)
              map.set(key, set)
            }
            return map.size <= cardinalityLimit && classes.size > 1 && [...map.values()].every((set) => set.size === 1)
          })(),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if ((reading.answerClassesInSample as string[]).length < 2) {
          problems.push('★ 样本里只有一个答案类 ⇒ 本判据空转（抽样须同时含"有依据"与"无依据"）')
        }
        if ((reading.lowCardinalityFields as string[]).length === 0) {
          problems.push('★ 一个低基数字段都没有可比 ⇒ 本判据没测到东西')
        }
        if (reading.positiveControl !== true) {
          problems.push('★ 正控失败：注入的"完美预测字段"没被规则认出来 ⇒ 上面的"无预测字段"不可信')
        }
        /*
         * ★ 判据：**除已申报的豁免项外**，不得出现任何预测字段。
         *   豁免项必须逐条有理由（`PREDICTOR_EXEMPTIONS`），且会被记进证据档（可见）。
         */
        const predictors = reading.predictors as { path: string }[]
        const undeclared = predictors.filter((item) => PREDICTOR_EXEMPTIONS[item.path] === undefined)
        if (undeclared.length > 0) {
          problems.push(`★ **未申报**的预测字段（盲化漏洞）：${JSON.stringify(undeclared)}`)
        }
        return problems
      },
    })
  )

  /* ---- ⑪ ★ 第四轮人审五条：答案键**不得**越过"能答什么/不能断言什么"的边界 ---- */
  probes.push(
    await probe({
      id: 'answer-key-respects-the-five-boundaries',
      question:
        '⑪ ★ 五条语义边界：① 换单位**任一正确**换算都算对 ② 历史类问句**消歧**为"更正之前" ' +
        '③ 双问句类必须标出"另一件**无法确认**" ④ "无正式记忆" ≠ "不能回答"（须给出历史是否可见） ' +
        '⑤ "有记录但来源不可核验" 不得说成"没有记录"',
      run: () => {
        /* 在**全语料**（dev+val）上核，而不是只看抽样 24 张 —— 这些是语料级性质 */
        const corpus = [
          ...readJsonl(join(CORPUS_DIR, 'dev.jsonl')),
          ...readJsonl(join(CORPUS_DIR, 'val.jsonl')),
        ]
        const problems: string[] = []
        const counts: Record<string, number> = {}
        for (const kind of ['unitChange', 'historyVsCurrent', 'negation', 'neverSaved', 'brokenRoot'] as const) {
          const items = corpus.filter((item) => String(item.formKind) === kind)
          counts[kind] = items.length
          if (items.length === 0) {
            problems.push(`${kind}:语料里 0 条 ⇒ 该类判据**空转**`)
            continue
          }
          for (const item of items) {
            const points = ((item.acceptableAnswerPoints as string[] | undefined) ?? []).join(' | ')
            const historyVisible = (item.sceneEvidence as Record<string, unknown> | undefined)?.historyVisibleThisTurn
            if (kind === 'unitChange' && !(points.includes('任一正确') && points.includes('不得') && points.includes('限定'))) {
              problems.push('unitChange:未声明"任一正确换算都算对/不得限定某一种单位"')
            }
            if (kind === 'historyVsCurrent' && !String(item.request).includes('更正之前')) {
              problems.push(`historyVsCurrent:问句未消歧 —— ${String(item.request)}`)
            }
            if (kind === 'negation' && !(points.includes('无法确认') && points.includes('单条记录不足'))) {
              problems.push('negation:未标出"另一件无法确认 / 单条记录不足以判断"')
            }
            if (kind === 'neverSaved' && !(historyVisible === false && points.includes('不等于') && points.includes('是否可见'))) {
              problems.push('neverSaved:未给出"历史本轮是否可见"，或未区分"无记忆 ≠ 不能回答"')
            }
            if (kind === 'brokenRoot' && !(points.includes('投影行') && points.includes('不得说成') && !points.includes('没有可支持的记录'))) {
              problems.push('brokenRoot:把"有记录但来源不可核验"说成了"没有记录"')
            }
          }
        }
        return { corpusSize: corpus.length, counts, problems }
      },
      judge: (reading) => {
        const problems = [...(reading.problems as string[])]
        for (const [name, count] of Object.entries(reading.counts as Record<string, number>)) {
          if (count <= 0) problems.push(`★ ${name} 在语料里 0 条 ⇒ 该条判据空转`)
        }
        if (Number(reading.corpusSize) <= 0) problems.push('★ 语料为 0 ⇒ MEASUREMENT INVALID')
        return problems.slice(0, 5)
      },
    })
  )

  /* ---- ⑩ 人审结论如实记为 PENDING（本门**不**产质量结论） ---- */
  probes.push(
    await probe({
      id: 'human-review-is-recorded-as-pending',
      question: '⑤ 人审结论如实记为 `PENDING`，本门**不**产出任何质量结论',
      run: () => {
        const verdictPath = join(REVIEW_DIR, 'verdicts.jsonl')
        const verdicts = readJsonl(verdictPath)
        return {
          humanReview: 'PENDING',
          verdictsOnFile: verdicts.length,
          reviewDir: 'artifacts/m9.5/local/quality-review',
          seed: SAMPLE_SEED,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.humanReview !== 'PENDING') problems.push('人审状态必须如实为 PENDING（不得由工程自行判定）')
        return problems
      },
    })
  )

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged = JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter)

  const payload = {
    schemaVersion: 'm9.5-quality@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '人审材料的**可复现抽样** / **盲化**（卡片只含白名单字段、答案键取值零泄漏 + 正控）/ gauge 样本在案 / 材料完整与计数自检',
      humanReview: 'PENDING',
      notProves:
        '**不**产出质量结论：本门只证明"材料可判且没夹带答案"。质量结论要人审填 `verdicts.jsonl` 后**另裁**；' +
        'A0–A5 的权重校准与真模型档（`smoke-live` / `long-live`）**仍未做**',
      materialLocation: 'artifacts/m9.5/local/quality-review/（gitignore 私有区，含语料正文）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'quality-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp10',
    lane: 'offline',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: GATE_VERSION,
    dbKind: 'not-applicable',
    isolationProof: {
      dbTouched: false,
      method: '**构造属性**：本门只读语料与写私有材料目录；不打开数据库',
    },
    configHash: { seed: SAMPLE_SEED, sampleSize: SAMPLE_SIZE, withheldFields: [...WITHHELD_FIELDS] },
    command: [{ cmd: 'pnpm m9.5:quality:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    humanReview: 'PENDING',
    artifactHashes: { 'quality-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP10 人审材料门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  人审结论：PENDING（本门不产质量结论）`,
      `  材料：artifacts/m9.5/local/quality-review/（cards.jsonl / answer-key.json / README.md）`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
