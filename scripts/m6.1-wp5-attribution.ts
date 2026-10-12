/**
 * M6.1 **WP5 失败归因表** —— 把"支持性回忆报警"逐条归到**五个具名成因**上。
 *
 * ============================================================================
 *  它为什么必须**独立于判定器**存在（用户 2026-09-24 裁定）
 * ============================================================================
 * ```text
 * 判定器只回答"这一轮过没过"。它**不能**回答"为什么没过"——
 * 《判定器第二版》里 `slotRecognized_valueDifferent` 就是一个**混合类别**
 * （受控枚举词形差异 / 抽错值 / 更新轮压根没抽出），判定器一律保守地判"依据不可判定"，
 * **不替人消歧**。逐条归因是**另一个交付物**，本脚本就是它。
 * ```
 *
 * ============================================================================
 *  五个具名成因（用户逐字给定；一条可以有**多个**成因）
 * ============================================================================
 * ```text
 * ① basis_not_established  依据建立失败   —— 该轮的槽位值压根没进库（抽错 / 更新轮没抽出 / 写入失败）
 * ② basis_not_in_context   依据未入模     —— 值进库了，但**没被选进这一轮的上下文**
 * ③ reply_violation        回答违规       —— 依据在上下文里，回复仍然补造了无依据的内容
 * ④ judge_wrong            判据错判/不可判 —— 量具两次采样不一致（`alert_state_disagreement`）等
 * ⑤ technical_failure      技术失败       —— 传输/服务（`timeout` 等）
 * ```
 * ⚠️ **①②③ 的依据是从程序真相（trace + 抽取审计）读出来的**，不是从回复文本猜的：
 *    `memory_recall{selected,reachedContext}` / `context_compile.sections` 含不含 `memory-recall`
 *    / `memory_explicit_write.result` / `memory_record_status`。
 * ⚠️ 本脚本给出的是**机器候选归因**（每条都带规则 id）。**最终归因要人读回复确认** ——
 *    写进报告时两个都要写，不能只写机器那半。
 *
 * 用法：
 * ```bash
 * pnpm exec tsx scripts/m6.1-wp5-attribution.ts --run <runId> [--sets supported,ewp]
 * ```
 * 证据：`artifacts/m6.1/<runId>/failure-attribution.json`（**无正文**：只有 id / 标签 / 计数 / 哈希）
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import {
  loadCorrectionNegativeSet,
  loadCounterexamples,
  loadExplicitWriteSet,
  loadSupportedRecallSet,
} from './m6.1-control-sets.ts'

const ROOT = resolve(process.cwd())
const LOCAL_PARENT = join('artifacts', 'm6.1', 'local')

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const runId: string = argValue('--run') ?? ''
if (runId === '') {
  console.error('必须给 --run <runId>（读 artifacts/m6.1/local/<runId>/sandbox-dirs.jsonl）')
  process.exit(2)
}
const setFilter = (argValue('--sets') ?? 'supported,rce,ewp,cin').split(',').map((value) => value.trim())
const itemFilter = (argValue('--items') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '')

const runDir = join(ROOT, 'artifacts', 'm6.1', runId)
const localDir = join(ROOT, LOCAL_PARENT, runId)
const sandboxMapPath = join(localDir, 'sandbox-dirs.jsonl')
if (!existsSync(sandboxMapPath)) {
  console.error(
    `缺 ${sandboxMapPath} ⇒ 这轮没有逐工况沙箱清单（旧版共用沙箱的运行没有这个文件）\n` +
      '   ⇒ 依据"有没有入模"的问题在旧运行上**无法逐工况回答**，不要拿共用沙箱的读数顶替。'
  )
  process.exit(2)
}

interface SandboxRow {
  readonly itemId: string
  readonly dir: string
}
const sandboxes = new Map<string, string>()
for (const line of readFileSync(sandboxMapPath, 'utf8').split(/\r?\n/)) {
  if (line.trim() === '') continue
  const row = JSON.parse(line) as SandboxRow
  sandboxes.set(row.itemId, row.dir)
}

/* ---------------------------------------------------------------------------
 * 冻结清单（判据侧）—— 与判定器**同源**
 * ------------------------------------------------------------------------- */

interface FrozenSpec {
  readonly itemId: string
  readonly setId: string
  readonly category: string
  readonly basisKind: 'memory_slot' | 'dialogue_recent' | 'program'
  readonly slot: string | null
  readonly expected: readonly string[]
  readonly question: string | null
  readonly setupTurns: number
  readonly humanReview: boolean
}

function frozenSpecs(): FrozenSpec[] {
  const out: FrozenSpec[] = []
  if (setFilter.includes('supported')) {
    for (const item of loadSupportedRecallSet(ROOT)) {
      out.push({
        itemId: item.id,
        setId: 'supported',
        category: item.category,
        basisKind: item.basisKind,
        slot: item.source.slot,
        expected: item.expectedPoints,
        question: item.question,
        setupTurns: item.setup.length,
        humanReview: false,
      })
    }
  }
  if (setFilter.includes('rce')) {
    for (const item of loadCounterexamples(ROOT)) {
      out.push({
        itemId: item.id,
        setId: 'rce',
        category: item.category,
        basisKind: 'dialogue_recent',
        slot: null,
        expected: item.mustNotProduce,
        question: item.question,
        setupTurns: item.setup.length,
        humanReview: item.humanReview === true,
      })
    }
  }
  if (setFilter.includes('ewp')) {
    for (const item of loadExplicitWriteSet(ROOT)) {
      out.push({
        itemId: item.id,
        setId: 'ewp',
        category: 'explicit_write',
        basisKind: 'memory_slot',
        slot: item.slot,
        expected: [item.expectedStoredValue],
        question: null,
        setupTurns: item.setup.length,
        humanReview: false,
      })
    }
  }
  if (setFilter.includes('cin')) {
    for (const item of loadCorrectionNegativeSet(ROOT)) {
      out.push({
        itemId: item.id,
        setId: 'cin',
        category: item.category,
        basisKind: 'program',
        slot: null,
        expected: [],
        question: null,
        setupTurns: 1,
        humanReview: false,
      })
    }
  }
  if (itemFilter.length === 0) return out
  const filtered = out.filter((spec) => itemFilter.includes(spec.itemId))
  const unknown = itemFilter.filter((id) => !out.some((spec) => spec.itemId === id))
  if (filtered.length !== itemFilter.length) {
    console.error(
      `MEASUREMENT INVALID：--items 给了 ${String(itemFilter.length)} 条，只匹配到 ${String(filtered.length)} 条` +
        `（不认识的：${unknown.join(',') || '无'}）`
    )
    process.exit(2)
  }
  return filtered
}

/* ---------------------------------------------------------------------------
 * 既落盘证据
 * ------------------------------------------------------------------------- */

interface JudgeRow {
  readonly itemId: string
  readonly setId: string
  readonly alertState: 'alert' | 'no_alert' | 'undecidable'
  readonly ok: boolean
  readonly failure: string | null
  readonly labels?: readonly string[]
  readonly expectedPointsHit?: readonly string[]
  readonly expectedPointsMissed?: readonly string[]
  readonly forbiddenHit?: readonly string[]
}

interface AuditTurn {
  readonly turnIndex: number
  readonly type: string | null
  readonly predicate: string | null
  readonly value: string | null
  readonly containsExpected: boolean | null
}
interface AuditRow {
  readonly itemId: string
  readonly slot?: string | null
  readonly expected?: readonly string[]
  readonly turns?: readonly AuditTurn[]
  readonly result?: string
}

interface LocalTurn {
  readonly itemId: string
  readonly turnIndex: number
  readonly userText?: string
  readonly reply?: string
  readonly replyChars: number
  readonly status: number
  readonly memoryListSha256?: string
  readonly memoryListUnchanged?: boolean | null
  readonly memoryListHasExpected?: boolean | null
}

const readJsonl = <T,>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as T)
    : []

const judgeRows = new Map<string, JudgeRow>()
for (const row of readJsonl<JudgeRow>(join(runDir, 'judge.partial.jsonl'))) judgeRows.set(row.itemId, row)

const auditRows = new Map<string, AuditRow>()
/** ⚠️ **证据归属**：运行目录里冻结的审计优先（抽取器一改，全局那份就是"新仪器在旧语料上的读数"） */
const auditSourcePath = (() => {
  const scoped = join(runDir, 'extraction-audit.json')
  return existsSync(scoped) ? { path: scoped, scoped: true } : { path: join(ROOT, 'artifacts', 'm6.1', 'extraction-audit.json'), scoped: false }
})()
let auditSourceSha256: string | null = null
{
  if (existsSync(auditSourcePath.path)) {
    const raw = readFileSync(auditSourcePath.path, 'utf8')
    auditSourceSha256 = createHash('sha256').update(raw).digest('hex')
    const parsed = JSON.parse(raw) as { rows?: AuditRow[] }
    for (const row of parsed.rows ?? []) auditRows.set(row.itemId, row)
  }
}

const localTurns = new Map<string, LocalTurn[]>()
for (const row of readJsonl<LocalTurn>(join(localDir, 'turns.jsonl'))) {
  const list = localTurns.get(row.itemId) ?? []
  list.push(row)
  localTurns.set(row.itemId, list)
}

/* ---------------------------------------------------------------------------
 * 程序真相：逐工况打开**它自己的**沙箱，读 trace（零模型调用）
 * ------------------------------------------------------------------------- */

interface TurnTrace {
  readonly order: number
  readonly sections: readonly string[]
  readonly recallCandidates: number | null
  readonly recallEligible: number | null
  readonly recallSelected: number | null
  readonly recallScanned: number | null
  readonly recallDroppedByBudget: number | null
  readonly recallReachedContext: boolean | null
  readonly recordStatusOutcome: string | null
  readonly recordStatusReasonCode: string | null
  readonly writeResults: readonly string[]
  readonly stepKinds: readonly string[]
}
interface ItemTrace {
  readonly itemId: string
  readonly traceCount: number
  readonly writeResults: readonly string[]
  readonly turns: readonly TurnTrace[]
  readonly error: string | null
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const asBool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

async function readItemTrace(itemId: string, dbDir: string, expectedTurns: number): Promise<ItemTrace> {
  const empty: ItemTrace = { itemId, traceCount: 0, writeResults: [], turns: [], error: null }
  if (!existsSync(dbDir)) return { ...empty, error: '沙箱目录不存在' }

  const { resetPluginSqlConnection, isProductionDir, PRODUCTION_DB_DIR } = await import('../src/dev/sandbox.ts')
  if (isProductionDir(dbDir) || resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) {
    return { ...empty, error: '拒绝：该路径被判成生产库' }
  }
  /* ⚠️ 一个进程只有一个库 ⇒ 换库前先重置（AGENTS §7） */
  await resetPluginSqlConnection()
  process.env.PGLITE_DATA_DIR = dbDir
  process.env.PROJECT_LG_SANDBOX = dbDir

  const { AgentRuntime } = await import('@elizaos/core')
  const sqlPlugin = (await import('@elizaos/plugin-sql')).default
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')
  const { createDeveloperQueryService } = await import('../src/infrastructure/dev/query-service.ts')
  const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
  const { entityRef } = await import('../src/kernel/contracts/entity.ts')

  const characterId = asCharacterId(character.id ?? character.name)
  const runtime = new AgentRuntime({
    character: character as never,
    plugins: [sqlPlugin],
    conversationLength: 16,
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
    },
  } as never)
  await initDatabase(runtime, sqlPlugin)
  const service = createDeveloperQueryService({
    db: getRawDb(runtime),
    characterId,
    owner: entityRef('character', String(characterId)),
    runtimeId: 'm6.1-wp5-attribution',
  })

  /* 上限取"预期轮数 + 余量"，并**核对不等于上限**（截断后重新编号会把证据贴错轮次） */
  const limit = expectedTurns + 8
  const page = await service.listTraces({ characterId, limit })
  if (page.items.length >= limit) {
    return { ...empty, traceCount: page.items.length, error: `listTraces 返回 ${String(page.items.length)} 条 = 上限 ⇒ 可能截断，拒绝出读数` }
  }
  const ordered = [...page.items].sort((left, right) =>
    String(left.startedAt).localeCompare(String(right.startedAt))
  )
  const turns: TurnTrace[] = []
  const writeResults: string[] = []
  for (const [index, item] of ordered.entries()) {
    const detail = await service.getTrace({ characterId, traceId: item.traceId })
    const steps = detail?.found === true ? detail.value.steps : []
    let sections: readonly string[] = []
    let recall: Record<string, unknown> | null = null
    let outcome: string | null = null
    let reasonCode: string | null = null
    const turnWriteResults: string[] = []
    const stepKinds: string[] = []
    for (const step of steps) {
      const attributes = (step as { attributes?: unknown }).attributes
      const record = typeof attributes === 'object' && attributes !== null ? (attributes as Record<string, unknown>) : {}
      stepKinds.push(String(step.kind))
      if (step.kind === 'context_compile') {
        sections = String(record.sections ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value !== '')
      }
      if (step.kind === 'memory_recall') recall = record
      if (step.kind === 'memory_explicit_write' && typeof record.result === 'string') {
        writeResults.push(record.result)
        turnWriteResults.push(record.result)
      }
      if (step.kind === 'memory_record_status') {
        outcome = typeof record.outcome === 'string' ? record.outcome : null
        reasonCode = typeof record.reason_code === 'string' ? record.reason_code : null
      }
    }
    turns.push({
      order: index + 1,
      sections,
      recallCandidates: asNumber(recall?.candidates),
      recallEligible: asNumber(recall?.eligible),
      recallSelected: asNumber(recall?.selected),
      recallScanned: asNumber(recall?.scanned),
      recallDroppedByBudget: asNumber(recall?.droppedByBudget),
      recallReachedContext: asBool(recall?.reachedContext),
      recordStatusOutcome: outcome,
      recordStatusReasonCode: reasonCode,
      writeResults: turnWriteResults,
      stepKinds,
    })
  }
  return { itemId, traceCount: ordered.length, writeResults, turns, error: null }
}

/* ---------------------------------------------------------------------------
 * 归因规则（**每条都带规则 id**；输出的是"机器候选"）
 * ------------------------------------------------------------------------- */

type CauseId =
  | 'basis_not_established'
  | 'basis_not_in_context'
  | 'reply_violation'
  | 'judge_wrong'
  | 'technical_failure'

const CAUSE_LABEL: Record<CauseId, string> = {
  basis_not_established: '① 依据建立失败',
  basis_not_in_context: '② 依据未入模',
  reply_violation: '③ 回答违规',
  judge_wrong: '④ 判据错判/不可判',
  technical_failure: '⑤ 技术失败',
}

/** 依据侧的机器判定（含"词形差异 ⇒ 依据其实成立"这一类，它**不是**失败） */
type BasisVerdict =
  | { readonly kind: 'ok_literal'; readonly detail: string }
  | { readonly kind: 'ok_word_form'; readonly detail: string }
  | { readonly kind: 'wrong_value'; readonly detail: string }
  | { readonly kind: 'missing_on_update_turn'; readonly detail: string }
  | { readonly kind: 'write_failed'; readonly detail: string }
  | { readonly kind: 'not_applicable'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string }

/** 纯 ASCII 单词 = 受控枚举的规范值（如 `undergraduate`），中文 = 自由文本 */
const isAsciiToken = (value: string): boolean => /^[A-Za-z][A-Za-z0-9_ -]*$/.test(value.trim())

function judgeBasis(spec: FrozenSpec, audit: AuditRow | undefined, trace: ItemTrace | undefined): BasisVerdict {
  if (spec.basisKind === 'dialogue_recent') {
    return { kind: 'not_applicable', detail: 'B0 依据就是最近对话本身（不经抽取器）' }
  }
  if (spec.basisKind === 'program') return { kind: 'not_applicable', detail: 'B0 程序面工况，不涉及记忆依据' }
  if (audit === undefined) return { kind: 'unknown', detail: 'B1 抽取审计里没有这一条' }
  if (audit.result === 'literal') return { kind: 'ok_literal', detail: 'B2 抽取审计 = literal' }
  const turns = audit.turns ?? []
  const emptyTurn = turns.find((turn) => turn.value === null || turn.value === undefined)
  if (emptyTurn !== undefined) {
    return {
      kind: 'missing_on_update_turn',
      detail: `B3 第 ${String(emptyTurn.turnIndex + 1)} 轮**没抽出来**（value = null）`,
    }
  }
  const values = turns.map((turn) => turn.value ?? '').filter((value) => value !== '')
  const latinValues = values.filter((value) => isAsciiToken(value))
  if (latinValues.length === values.length && latinValues.length > 0) {
    return {
      kind: 'ok_word_form',
      detail: `B4 受控枚举的**词形差异**（库里是 ${latinValues.join('/')}；期望 ${spec.expected.join('/')}）⇒ 依据其实成立`,
    }
  }
  const writeResults = trace?.writeResults ?? []
  if (writeResults.length > 0 && writeResults.every((result) => result !== 'written' && result !== 'already_applied')) {
    return { kind: 'write_failed', detail: `B5 显式写入未成功：${writeResults.join('/')}` }
  }
  return { kind: 'wrong_value', detail: `B6 抽成了别的值（${values.join('/') || '(空)'} ≠ ${spec.expected.join('/')}）` }
}

interface Attribution {
  readonly itemId: string
  readonly setId: string
  readonly category: string
  readonly basisKind: string
  readonly slot: string | null
  readonly judge: {
    readonly present: boolean
    readonly ok: boolean
    readonly alertState: string | null
    readonly failure: string | null
    readonly labels: readonly string[]
    readonly expectedPointsMissed: readonly string[]
    readonly forbiddenHit: readonly string[]
  }
  readonly basis: BasisVerdict
  readonly context: {
    readonly questionTurnSections: readonly string[]
    readonly recallSectionPresent: boolean | null
    readonly recallSelected: number | null
    readonly recallReachedContext: boolean | null
    readonly recallDroppedByBudget: number | null
    readonly traceTurns: number | null
    readonly traceError: string | null
    /** 这一轮（问句那一轮）的逐步细节：用于回答"为什么没入模" */
    readonly questionTurnSteps: readonly string[]
    readonly questionTurnWriteResults: readonly string[]
    readonly questionTurnRecordStatus: string | null
    readonly questionTurnReasonCode: string | null
  }
  readonly causes: readonly { readonly id: CauseId; readonly rule: string; readonly detail: string }[]
  /** 机器判据看不出来、必须人读回复确认的部分（如实列出） */
  readonly needsHuman: readonly string[]
  readonly replyChars: number | null
  readonly replySha256: string | null
}

function attribute(spec: FrozenSpec, trace: ItemTrace | undefined): Attribution {
  const judge = judgeRows.get(spec.itemId)
  const audit = auditRows.get(spec.itemId)
  const basis = judgeBasis(spec, audit, trace)
  const local = localTurns.get(spec.itemId) ?? []
  const questionTurn = local.filter((row) => row.memoryListSha256 === undefined).at(-1)
  const lastTrace = trace?.turns.at(-1)
  const causes: { id: CauseId; rule: string; detail: string }[] = []
  const needsHuman: string[] = []

  /* R1/R2：量具侧的失败与不可判 —— 与"回复内容"无关，先定 */
  if (judge !== undefined && judge.ok === false) {
    if (judge.failure === 'alert_state_disagreement') {
      causes.push({ id: 'judge_wrong', rule: 'R1a', detail: '量具两次采样不一致（不可判）' })
    } else {
      causes.push({ id: 'technical_failure', rule: 'R1b', detail: `量具失败：${String(judge.failure)}` })
    }
  } else if (judge !== undefined && judge.ok && judge.alertState === 'undecidable') {
    causes.push({ id: 'judge_wrong', rule: 'R2', detail: '三态 undecidable' })
  }

  /* R3：依据侧 */
  if (basis.kind === 'wrong_value' || basis.kind === 'missing_on_update_turn' || basis.kind === 'write_failed') {
    causes.push({ id: 'basis_not_established', rule: 'R3', detail: basis.detail })
  }

  /* R4：依据有没有进这一轮的上下文（只在"依据本该来自记忆槽位"时有意义） */
  let inContext: boolean | null = null
  if (spec.basisKind === 'memory_slot') {
    const sections = lastTrace?.sections ?? []
    const hasSection = lastTrace === undefined ? null : sections.includes('memory-recall')
    const reached = lastTrace?.recallReachedContext ?? null
    const selected = lastTrace?.recallSelected ?? null
    inContext = hasSection === true && reached === true && (selected ?? 0) > 0
    if (basis.kind === 'ok_literal' || basis.kind === 'ok_word_form') {
      if (inContext === false) {
        /*
         * ⚠️ ② 有**三种互不相同**的子形态，必须分开写（否则"依据未入模"会被读成一种缺陷）：
         *   a) 这一轮**压根没有 `memory-recall` section**（召回没被触发）
         *   b) 召回了但 `selected = 0`（没有候选被选中）
         *   c) 被**预算裁掉**（`droppedByBudget > 0`）
         */
        const recallRan = (lastTrace?.stepKinds ?? []).includes('memory_recall')
        const subKind = !recallRan
          ? 'a 这一轮**没有跑** `memory_recall` 步骤（召回未被触发）'
          : (lastTrace?.recallSelected ?? 0) === 0
            ? `b 跑了召回但**一条都没被选中**（候选=${String(lastTrace?.recallCandidates ?? null)} · 合格=${String(lastTrace?.recallEligible ?? null)}）`
            : (lastTrace?.recallDroppedByBudget ?? 0) > 0
              ? 'c 选中了但被**预算裁掉**'
              : 'd 其它（`reachedContext = false` 但上述都不成立）'
        causes.push({
          id: 'basis_not_in_context',
          rule: 'R4',
          detail:
            `依据已在库里，但这一轮上下文里没有它：${subKind}` +
            ` · sections=[${sections.join(',') || '(无)'}]` +
            ` · 候选=${String(lastTrace?.recallCandidates ?? null)} 合格=${String(lastTrace?.recallEligible ?? null)}` +
            ` 选中=${String(selected)} 扫过=${String(lastTrace?.recallScanned ?? null)}` +
            ` 预算裁掉=${String(lastTrace?.recallDroppedByBudget ?? null)} 达上下文=${String(reached)}`,
        })
      }
    }
  }

  /* R5：依据在上下文里（或依据就是最近对话）却仍然报警 ⇒ 回答违规 */
  const basisIsAvailable =
    spec.basisKind === 'dialogue_recent' ? true : basis.kind === 'ok_literal' || basis.kind === 'ok_word_form'
  if (judge !== undefined && judge.ok && judge.alertState === 'alert') {
    if (spec.basisKind === 'program') {
      /*
       * R6：**程序面工况**（写入正控 / 误触发负控）的报警。
       *
       * 这两集的**门**在程序面（内存清单逐字未变 / 期望值真的落库），因此这条报警**不进**那门 ——
       * 但它仍然是一条必须归因的事实：**回复层说了无依据的话**。
       * ⚠️ 第一版没有这条 ⇒ `CIN-04` 的报警**零成因**，于是本表自己的自检把整份读数判成
       *    "不许交付"（exit 3）。那正是自检该做的事 —— 缺口在规则里，不在数据里。
       */
      causes.push({
        id: 'reply_violation',
        rule: 'R6',
        detail:
          `程序面工况（${spec.setId}）的**回复层**报警：该工况的门在程序面，所以这条不进那门；` +
          `但回复里出现了无依据断言：${(judge.labels ?? []).join(',') || '(无标签)'}`,
      })
    } else if (basisIsAvailable && (spec.basisKind === 'dialogue_recent' || inContext === true)) {
      causes.push({
        id: 'reply_violation',
        rule: 'R5',
        detail: `依据可用（${spec.basisKind === 'dialogue_recent' ? '最近对话本身' : basis.detail}）且已入模 ⇒ 违规在**回复**：${(judge.labels ?? []).join(',')}`,
      })
    } else if (basisIsAvailable && inContext === null) {
      causes.push({
        id: 'reply_violation',
        rule: 'R5′',
        detail: `依据可用且是**对话近因**（不需要召回）⇒ 违规在回复：${(judge.labels ?? []).join(',')}`,
      })
    }
  }

  if (judge === undefined) needsHuman.push('这一条没有量具判定行 ⇒ 成因未定')
  if (basis.kind === 'unknown') needsHuman.push('抽取审计缺这一条 ⇒ 依据是否建立未知，需人读')
  if (basis.kind === 'ok_word_form') {
    needsHuman.push('B4 词形差异是**机器**判的（ASCII 单值 vs 中文期望）⇒ 需人确认语义等价')
  }
  if (causes.some((cause) => cause.id === 'reply_violation')) {
    needsHuman.push('R5 只说"依据可用而回复仍然多说了"；**多说的是什么**要人读回复确认（本文件不存正文）')
  }
  if (trace?.error !== null && trace?.error !== undefined) needsHuman.push(`trace 读数不可用：${trace.error}`)

  return {
    itemId: spec.itemId,
    setId: spec.setId,
    category: spec.category,
    basisKind: spec.basisKind,
    slot: spec.slot,
    judge: {
      present: judge !== undefined,
      ok: judge?.ok ?? false,
      alertState: judge?.alertState ?? null,
      failure: judge?.failure ?? null,
      labels: judge?.labels ?? [],
      expectedPointsMissed: judge?.expectedPointsMissed ?? [],
      forbiddenHit: judge?.forbiddenHit ?? [],
    },
    basis,
    context: {
      questionTurnSections: lastTrace?.sections ?? [],
      recallSectionPresent: lastTrace === undefined ? null : (lastTrace.sections ?? []).includes('memory-recall'),
      recallSelected: lastTrace?.recallSelected ?? null,
      recallReachedContext: lastTrace?.recallReachedContext ?? null,
      recallDroppedByBudget: lastTrace?.recallDroppedByBudget ?? null,
      traceTurns: trace?.turns.length ?? null,
      traceError: trace?.error ?? null,
      questionTurnSteps: lastTrace?.stepKinds ?? [],
      questionTurnWriteResults: lastTrace?.writeResults ?? [],
      questionTurnRecordStatus: lastTrace?.recordStatusOutcome ?? null,
      questionTurnReasonCode: lastTrace?.recordStatusReasonCode ?? null,
    },
    causes,
    needsHuman,
    replyChars: questionTurn?.replyChars ?? null,
    replySha256: questionTurn === undefined ? null : `chars:${String(questionTurn.replyChars)}`,
  }
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

const specs = frozenSpecs()
const traces = new Map<string, ItemTrace>()
const skipped: string[] = []
for (const spec of specs) {
  const dir = sandboxes.get(spec.itemId)
  if (dir === undefined) {
    skipped.push(spec.itemId)
    continue
  }
  const expected = spec.setId === 'ewp' ? spec.setupTurns : spec.setupTurns + 1
  traces.set(spec.itemId, await readItemTrace(spec.itemId, dir, expected))
}

const attributions = specs.map((spec) => attribute(spec, traces.get(spec.itemId)))

/* 计数自检（INV：计数型量具必须先自检"测到的东西不为空"） */
if (attributions.length === 0) {
  console.error('MEASUREMENT INVALID：归因表 0 条 ⇒ 什么都没量到')
  process.exit(2)
}

const byCause: Record<string, string[]> = {}
for (const row of attributions) {
  for (const cause of row.causes) {
    byCause[cause.id] = [...(byCause[cause.id] ?? []), row.itemId]
  }
}
const alerts = attributions.filter((row) => row.judge.ok && row.judge.alertState === 'alert')
const alertsWithoutCause = alerts.filter((row) => row.causes.length === 0)

console.log('='.repeat(96))
console.log(`M6.1 WP5 失败归因（只读既有沙箱 trace + 已落盘证据；**零模型调用**）`)
console.log('='.repeat(96))
console.log(`  run   ${runId}`)
console.log(`  工况  ${String(attributions.length)} 条（集合 ${setFilter.join('/')}）· 缺沙箱 ${String(skipped.length)} 条`)
console.log('')
console.log('  【支持性回忆报警逐条归因】（五类成因，一条可有多个）')
console.log(
  '  ' +
    ['条目'.padEnd(11), '类别'.padEnd(22), '依据'.padEnd(28), '上下文', '成因'].join(' | ')
)
for (const row of attributions.filter((entry) => entry.setId === 'supported')) {
  const marks: string[] = []
  if (row.judge.ok && row.judge.alertState === 'alert') marks.push('报警')
  else if (row.judge.ok && row.judge.alertState === 'undecidable') marks.push('弃判')
  else if (!row.judge.present) marks.push('无量具行')
  else if (!row.judge.ok) marks.push('技术/判据失败')
  else marks.push('未报警')
  const basis =
    row.basis.kind === 'ok_literal'
      ? '字面命中'
      : row.basis.kind === 'ok_word_form'
        ? '词形差异(依据成立)'
        : row.basis.kind === 'not_applicable'
          ? '不适用(对话近因)'
          : row.basis.kind === 'missing_on_update_turn'
            ? '更新轮未抽出'
            : row.basis.kind === 'write_failed'
              ? '写入失败'
              : row.basis.kind === 'wrong_value'
                ? '抽错值'
                : '未知'
  const basisEstablished = row.basis.kind === 'ok_literal' || row.basis.kind === 'ok_word_form'
  const context =
    row.basisKind === 'dialogue_recent'
      ? '不需要召回'
      : row.context.recallReachedContext === null
        ? '(无trace)'
        : row.context.recallReachedContext
          ? `入模(${String(row.context.recallSelected)})`
          : basisEstablished
            ? '**未入模**'
            : '无依据可入模'
  console.log(
    '  ' +
      [
        row.itemId.padEnd(11),
        row.category.padEnd(22),
        basis.padEnd(28),
        context.padEnd(12),
        marks.join('+') +
          (row.causes.length > 0 ? ` ⇒ ${row.causes.map((cause) => cause.id).join(' + ')}` : ''),
      ].join(' | ')
  )
}
console.log('')
console.log('  【按成因汇总】')
for (const [id, items] of Object.entries(byCause)) {
  console.log(`    ${CAUSE_LABEL[id as CauseId]} · ${String(items.length)} 条：${items.join(', ')}`)
}
console.log('')
console.log(
  `  报警 ${String(alerts.length)} 条 · 其中无任何成因 ${String(alertsWithoutCause.length)} 条` +
    `${alertsWithoutCause.length > 0 ? `（${alertsWithoutCause.map((row) => row.itemId).join(',')} ⇒ 归因表自己不完整，不许交付）` : ''}`
)
const needHumanRows = attributions.filter((row) => row.needsHuman.length > 0)
console.log(`  需人读确认 ${String(needHumanRows.length)} 条`)

const evidence = {
  schemaVersion: 'm6.1-wp5-failure-attribution@1',
  testId: 'M6.1 / WP5 失败归因（五个具名成因 · 逐条 · 机器候选 + 人读确认）',
  runId,
  sets: setFilter,
  sandboxIsolation: existsSync(sandboxMapPath),
  basisSource: {
    path: auditSourcePath.path.replace(ROOT, '').replace(/\\/g, '/'),
    scopedToRun: auditSourcePath.scoped,
    sha256: auditSourceSha256,
    note:
      '抽取审计是**可重生成**的：抽取器改过之后全局那份描述的是**新**仪器。' +
      '运行目录里冻结的那一份优先 —— 否则旧运行的归因会被新配置回填。',
  },
  why: [
    '判定器只回答"这一轮过没过"，不回答"为什么没过"。',
    '判定器对 slotRecognized_valueDifferent 一律保守判"依据不可判定"（不替人消歧）⇒ 逐条归因必须独立成表。',
    '五类成因：① 依据建立失败 ② 依据未入模 ③ 回答违规 ④ 判据错判/不可判 ⑤ 技术失败；一条可有多个。',
    '依据侧（①②）读的是**程序真相**：抽取审计 + memory_explicit_write.result + memory_recall{selected,reachedContext} + context_compile.sections。',
  ],
  causeLabels: CAUSE_LABEL,
  counts: {
    items: attributions.length,
    alerts: alerts.length,
    alertsWithoutCause: alertsWithoutCause.map((row) => row.itemId),
    byCause: Object.fromEntries(Object.entries(byCause).map(([id, items]) => [id, items.length])),
    needsHuman: needHumanRows.map((row) => row.itemId),
    skippedNoSandbox: skipped,
    measurementInvalid: attributions.length === 0,
  },
  rows: attributions,
  separateNamedGroups: {
    update_turn_extraction_missing: {
      note: '**单独的具名问题组**（用户裁定）：更正轮的槽位值压根没抽出来 ⇒ 与"抽错值"分开归因。',
      items: attributions
        .filter((row) => row.basis.kind === 'missing_on_update_turn')
        .map((row) => ({ itemId: row.itemId, slot: row.slot, detail: row.basis.detail })),
    },
    wrong_value_extraction: {
      note: '抽成了别的值（例如 `education.institution` 抽成「书」/「了」）⇒ 与上一条**分开**。',
      items: attributions
        .filter((row) => row.basis.kind === 'wrong_value')
        .map((row) => ({ itemId: row.itemId, slot: row.slot, detail: row.basis.detail })),
    },
    controlled_enum_word_form: {
      note: '受控枚举的**词形差异**：依据其实成立 ⇒ **不算失败**，单列（防止把它算进"抽取器坏了"）。',
      items: attributions
        .filter((row) => row.basis.kind === 'ok_word_form')
        .map((row) => ({ itemId: row.itemId, slot: row.slot, detail: row.basis.detail })),
    },
  },
  notProven: [
    '本表给的是**机器候选归因**（每条带规则 id）；最终归因必须由人读回复确认。',
    '本文件**不存回复正文**（只有字数与标签）⇒ 引用具体说了什么必须去 gitignored 的 local/turns.jsonl。',
    '一条 `no_alert` 不能证明某个修复有效；一次报警也不能证明某个模块"坏了"。',
    'trace 是**结构性**读数（section 名字 + 召回计数 + 记忆 id），**不是**逐字提示正文。',
  ],
}
writeFileSync(join(runDir, 'failure-attribution.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`\n  证据：artifacts/m6.1/${runId}/failure-attribution.json`)
if (alertsWithoutCause.length > 0 || attributions.length === 0) process.exitCode = 3
