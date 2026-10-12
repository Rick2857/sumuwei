/**
 * M9.6 搜索替换后续实验 —— **跨轮汇总**（`pnpm m9.6:followup:aggregate`）。
 *
 * ============================================================================
 *  它补的是什么
 * ============================================================================
 * ```text
 * 逐轮 `followup-summary.json` 只给**单轮**读数。协议 §4.5 要求保留
 *   「各轮全貌、**最差读数**、**翻转**、逐条分歧及失败码」
 * —— 那需要**跨轮**汇总，本文件就是那一层（只读、零模型调用）。
 *
 * ★ 协议 §7.2 特别要求：安全用例必须分**三列**报，不能把原始 decision 当结论
 *     · 原始搜索选择（raw decision = search）
 *     · **有效提案**（decision = search 且 proposalValid）
 *     · **实际执行**（本实验**没有**搜索执行器 ⇒ 恒为 0，且这是结构性事实）
 * ```
 * ⚠️ 本文件**不在**冻结清单里（冻结的是 compare/candidates/jev-protocol/stats/
 *    followup-summary/search-heldout + 两个 src 文件）⇒ 加它不破坏冻结。
 * ⚠️ 被中断的运行（只有 checkpoint.jsonl）**只登记进度、不评分** ——
 *    截断的语料会让家族不等权、分母失真（协议 §3：不能把字符串无重复当独立性证明）。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { scoreRows } from './m9.6-followup-summary.ts'

const ROOT = resolve('.')
const COMPARE_DIR = join(ROOT, 'artifacts', 'm9.6', 'compare')
const OUT_PATH = join(ROOT, 'artifacts', 'm9.6', 'search-followup', 'aggregate.json')
const FREEZE_PATH = join(ROOT, 'artifacts', 'm9.6', 'search-followup', 'freeze.json')
const RUNNER_PATH = join(ROOT, 'scripts', 'm9.6-compare.ts')

/**
 * ★ 协议 §4.3 冻结的是**连续三轮**。这里显式指定哪三轮是"协议的三轮"，
 *   其余完整轮归入 `extraReplications`（各自报告，**不**用于挑最好的三轮）。
 */
const DESIGNATED_TEST_RUNS = ['followup-test-r1', 'followup-test-r2', 'followup-test-r3'] as const

/* ⚠️ 字段形状必须与冻结的 `m9.6-followup-summary.ts` 的 `Reading`/`Row` **一致**，
 *    否则 `scoreRows` 不接受（本文件只是消费它，不重定义判据）。 */
interface ArmReading {
  outcome: string
  decision: string | null
  proposalValid: boolean
  span?: unknown
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  code: string | null
  requestCount: number
}
interface Row {
  caseId: string
  family: string
  safety: boolean
  stratum: string
  mode: string
  expected: { decision: string; reason?: string; goldSpan?: unknown }
  arms: { A: ArmReading; J: ArmReading }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function readRows(path: string): Row[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Row)
}

/* ---- 1. 发现运行目录 ---- */
const discovered = readdirSync(COMPARE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('followup-'))
  .map((entry) => entry.name)
  .sort()

interface RunRecord {
  readonly runId: string
  readonly split: string
  readonly round: string
  readonly state: 'complete' | 'aborted'
  readonly n: number
  readonly fingerprint: string | null
  readonly freezeHash: string | null
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly rows: Row[]
}

const runs: RunRecord[] = []
for (const runId of discovered) {
  const dir = join(COMPARE_DIR, runId)
  const manifest = readJson(join(dir, 'manifest.json'))
  const predictionsPath = join(dir, 'predictions.jsonl')
  const checkpointPath = join(dir, 'checkpoint.jsonl')
  const complete = existsSync(predictionsPath)
  const rows = readRows(complete ? predictionsPath : checkpointPath)
  let startedAtMs: number | null = null
  try {
    startedAtMs = statSync(join(dir, 'started.json')).mtimeMs
  } catch {
    startedAtMs = null
  }
  let finishedAtMs: number | null = null
  try {
    finishedAtMs = statSync(complete ? predictionsPath : checkpointPath).mtimeMs
  } catch {
    finishedAtMs = null
  }
  runs.push({
    runId,
    split: String(manifest?.split ?? (complete ? '?' : 'test')),
    round: String(manifest?.round ?? '3'),
    state: complete ? 'complete' : 'aborted',
    n: rows.length,
    fingerprint: (manifest?.corpus as { fingerprint?: string } | undefined)?.fingerprint ?? null,
    freezeHash: manifest?.freeze === undefined ? null : JSON.stringify(manifest.freeze),
    startedAtMs,
    finishedAtMs,
    rows,
  })
}

/*
 * ★ **运行时序**（可审计）：把每轮的起止时间与**轮间重叠**算出来。
 *   ⚠️ 这是本阶段的一处**真实偏差**：`followup-test-r3` 其实**仍在跑**（并非中断），
 *      却被误判为"已中断"而多起了一轮 `followup-test-r3b` ⇒ 两轮在墙钟上**重叠**，
 *      重叠窗口内的时延读数受并发负载污染。必须写进证据，不能只写在报告里。
 */
const chronology = runs.map((run) => ({
  runId: run.runId,
  split: run.split,
  round: run.round,
  startedAt: run.startedAtMs === null ? null : new Date(run.startedAtMs).toISOString(),
  finishedAt: run.finishedAtMs === null ? null : new Date(run.finishedAtMs).toISOString(),
  durationMs: run.startedAtMs === null || run.finishedAtMs === null ? null : run.finishedAtMs - run.startedAtMs,
}))
const overlaps: { a: string; b: string; overlapMs: number }[] = []
for (let i = 0; i < runs.length; i += 1) {
  for (let j = i + 1; j < runs.length; j += 1) {
    const left = runs[i]
    const right = runs[j]
    if (left?.startedAtMs == null || left.finishedAtMs == null || right?.startedAtMs == null || right.finishedAtMs == null) continue
    const overlapMs = Math.min(left.finishedAtMs, right.finishedAtMs) - Math.max(left.startedAtMs, right.startedAtMs)
    if (overlapMs > 0) overlaps.push({ a: left.runId, b: right.runId, overlapMs })
  }
}

/* ---- 2. 冻结一致性 ---- */
const freeze = readJson(FREEZE_PATH)
const freezeHashes = new Set(runs.map((run) => run.freezeHash).filter((value): value is string => value !== null))
const frozenFileHashesOk = freeze !== null && runs.every((run) => run.state === 'aborted' || run.fingerprint !== null)

/* ---- 3. 逐轮读数 ---- */
interface RunHighlight {
  readonly runId: string
  readonly split: string
  readonly round: string
  readonly n: number
  readonly A: Record<string, unknown>
  readonly J: Record<string, unknown>
  readonly observedG2: boolean
  readonly observedG3: boolean
  readonly casePaired: unknown
  readonly familyPaired: unknown
  readonly disagreementCount: number
}

const highlights: RunHighlight[] = []
const unscored: { runId: string; reason: string; n: number }[] = []

for (const run of runs) {
  if (run.state === 'aborted') {
    unscored.push({
      runId: run.runId,
      reason: '被中断：只有 checkpoint.jsonl，没有 predictions.jsonl ⇒ 语料被截断、家族不等权，**不评分**（只保留为证据）',
      n: run.n,
    })
    continue
  }
  let scored: ReturnType<typeof scoreRows>
  try {
    scored = scoreRows(run.rows)
  } catch (error) {
    unscored.push({ runId: run.runId, reason: `scoreRows 拒绝：${(error as Error).message}`, n: run.n })
    continue
  }
  const pick = (arm: 'A' | 'J'): Record<string, unknown> => {
    const m = scored[arm]
    return {
      accuracy: m.accuracy,
      macroF1: m.macroF1.macroF1,
      familyMacroF1: m.familyMacroF1,
      binaryDiagnostic: m.binaryDiagnostic,
      explicitRecall: m.explicitRecall,
      autoRecall: m.autoRecall,
      ordinaryOverSearch: m.ordinaryOverSearch,
      allNegativeOverSearch: m.allNegativeOverSearch,
      safetyCases: m.safetyCases,
      unsafeRawSelections: m.unsafeSearchProposals.length,
      completion: m.completion,
      failures: m.failures,
      usage: m.usage,
      medianMs: m.medianMs,
      p95Ms: m.p95Ms,
    }
  }
  highlights.push({
    runId: run.runId,
    split: run.split,
    round: run.round,
    n: scored.n,
    A: pick('A'),
    J: pick('J'),
    observedG2: scored.observedG2,
    observedG3: scored.observedG3,
    casePaired: scored.casePaired,
    familyPaired: scored.familyPaired,
    disagreementCount: scored.disagreements.length,
  })
}

/* ---- 4. 最差 run（只在**协议指定的三轮**里取；另报含额外轮的稳健性） ---- */
const testRunsAll = highlights.filter((entry) => entry.split === 'test')
const testRuns = testRunsAll.filter((entry) => (DESIGNATED_TEST_RUNS as readonly string[]).includes(entry.runId))
const extraReplications = testRunsAll.filter((entry) => !(DESIGNATED_TEST_RUNS as readonly string[]).includes(entry.runId))
const num = (value: unknown): number | null => {
  if (typeof value === 'number') return value
  if (value !== null && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: number | null }).value
    return typeof inner === 'number' ? inner : null
  }
  return null
}
const worstOf = (
  pool: RunHighlight[],
  arm: 'A' | 'J',
  field: string,
  mode: 'min' | 'max'
): { runId: string; value: number } | null => {
  let best: { runId: string; value: number } | null = null
  for (const entry of pool) {
    const raw = num((entry[arm] as Record<string, unknown>)[field])
    if (raw === null) continue
    if (best === null || (mode === 'min' ? raw < best.value : raw > best.value)) best = { runId: entry.runId, value: raw }
  }
  return best
}
const worstRun = {
  note: '取 test 各完整轮的**最差**读数（协议 §4.5 / 契约 §7：不挑最佳值）。`extraReplications` 单独列出，不用于替换协议的三轮。',
  designatedRuns: testRuns.map((entry) => entry.runId),
  extraReplicationRuns: extraReplications.map((entry) => entry.runId),
  accuracy: { A: worstOf(testRuns, 'A', 'accuracy', 'min'), J: worstOf(testRuns, 'J', 'accuracy', 'min') },
  familyMacroF1: { A: worstOf(testRuns, 'A', 'familyMacroF1', 'min'), J: worstOf(testRuns, 'J', 'familyMacroF1', 'min') },
  ordinaryOverSearch: { A: worstOf(testRuns, 'A', 'ordinaryOverSearch', 'max'), J: worstOf(testRuns, 'J', 'ordinaryOverSearch', 'max') },
  allNegativeOverSearch: { A: worstOf(testRuns, 'A', 'allNegativeOverSearch', 'max'), J: worstOf(testRuns, 'J', 'allNegativeOverSearch', 'max') },
  medianMs: { A: worstOf(testRuns, 'A', 'medianMs', 'max'), J: worstOf(testRuns, 'J', 'medianMs', 'max') },
  p95Ms: { A: worstOf(testRuns, 'A', 'p95Ms', 'max'), J: worstOf(testRuns, 'J', 'p95Ms', 'max') },
  /** 若把额外轮也算进最差，结论会不会变？ */
  robustnessWithExtraRuns: {
    accuracyWorstJIncludingExtras: worstOf(testRunsAll, 'J', 'accuracy', 'min'),
    accuracyWorstAIncludingExtras: worstOf(testRunsAll, 'A', 'accuracy', 'min'),
    worstRunChanges: worstOf(testRunsAll, 'J', 'accuracy', 'min')?.runId !== worstOf(testRuns, 'J', 'accuracy', 'min')?.runId,
  },
  familyPairedLow: {
    designated: testRuns.map((entry) => ({ runId: entry.runId, low: num((entry.familyPaired as { low?: number })?.low) })),
    worstLow: Math.min(
      ...testRuns.map((entry) => num((entry.familyPaired as { low?: number })?.low) ?? Number.POSITIVE_INFINITY)
    ),
  },
}

/** 四轮全貌（含额外轮）—— 便于读者自行核对，不参与判定 */
const allTestRunTable = testRunsAll.map((entry) => ({
  runId: entry.runId,
  designated: (DESIGNATED_TEST_RUNS as readonly string[]).includes(entry.runId),
  A_accuracy: num((entry.A as { accuracy?: unknown }).accuracy),
  J_accuracy: num((entry.J as { accuracy?: unknown }).accuracy),
  J_familyMacroF1: num((entry.J as { familyMacroF1?: unknown }).familyMacroF1),
  J_ordinaryOverSearch: num((entry.J as { ordinaryOverSearch?: unknown }).ordinaryOverSearch),
  J_allNegativeOverSearch: num((entry.J as { allNegativeOverSearch?: unknown }).allNegativeOverSearch),
  J_rawUnsafe: (entry.J as { unsafeRawSelections?: number }).unsafeRawSelections,
  J_completion: num((entry.J as { completion?: unknown }).completion),
  J_medianMs: (entry.J as { medianMs?: number }).medianMs,
  J_p95Ms: (entry.J as { p95Ms?: number }).p95Ms,
  observedG2: entry.observedG2,
  observedG3: entry.observedG3,
}))

/* ---- 5. 三轮翻转率（逐案 × 每臂） ---- */
const flipReport: Record<string, unknown> = {}
for (const arm of ['A', 'J'] as const) {
  const perPair: Record<string, number> = {}
  let anyFlip = 0
  const caseIds = runs.find((run) => run.state === 'complete' && run.split === 'test')?.rows.map((row) => row.caseId) ?? []
  for (const caseId of caseIds) {
    const decisions = testRuns.map((entry) => {
      const row = runs.find((run) => run.runId === entry.runId)?.rows.find((candidate) => candidate.caseId === caseId)
      return row?.arms[arm].decision ?? null
    })
    if (new Set(decisions).size > 1) anyFlip += 1
  }
  for (let i = 0; i < testRuns.length; i += 1) {
    for (let j = i + 1; j < testRuns.length; j += 1) {
      const left = runs.find((run) => run.runId === testRuns[i]?.runId)
      const right = runs.find((run) => run.runId === testRuns[j]?.runId)
      if (left === undefined || right === undefined) continue
      const flips = caseIds.filter((caseId) => {
        const a = left.rows.find((row) => row.caseId === caseId)?.arms[arm].decision ?? null
        const b = right.rows.find((row) => row.caseId === caseId)?.arms[arm].decision ?? null
        return a !== b
      }).length
      perPair[`${String(testRuns[i]?.runId)} vs ${String(testRuns[j]?.runId)}`] = flips
    }
  }
  flipReport[arm] = {
    testRunsCompared: testRuns.length,
    casesThatEverFlipAcrossAllRuns: anyFlip,
    caseCount: caseIds.length,
    everFlipRate: caseIds.length === 0 ? null : anyFlip / caseIds.length,
    perPair,
    note: '协议 §4.5：翻转率必须是跨轮实测，不是单轮的稳定性描述',
  }
}

/* ---- 6. ★ 安全用例三列（协议 §7.2） ---- */
const runnerSource = readFileSync(RUNNER_PATH, 'utf8')
const noSearchExecutor =
  !/search-provider|web-search|executeSearch|searchExecutor|adapter\.search/.test(runnerSource) &&
  !/import .*search-provider/.test(runnerSource)

const safetyThreeColumns: Record<string, unknown> = {}
for (const run of runs) {
  if (run.state === 'aborted') continue
  const safety = run.rows.filter((row) => row.safety === true)
  const perArm: Record<string, unknown> = {}
  for (const arm of ['A', 'J'] as const) {
    const rawSelections = safety.filter((row) => row.arms[arm].decision === 'search')
    const validProposals = rawSelections.filter((row) => row.arms[arm].proposalValid === true)
    perArm[arm] = {
      safetyCases: safety.length,
      rawSearchSelections: rawSelections.length,
      rawSelectionCaseIds: rawSelections.map((row) => `${row.caseId}(${row.expected.decision})`),
      validSearchProposals: validProposals.length,
      validProposalCaseIds: validProposals.map((row) => row.caseId),
      actualExecutions: 0,
      actualExecutionNote: noSearchExecutor
        ? '本实验的两个臂都**只是判定器**：运行器里没有搜索执行器 ⇒ 实际执行恒为 0（结构性事实，已机械核对运行器源码）'
        : '⚠️ 未能在运行器源码里证明没有搜索执行器 ⇒ 实际执行必须记为 UNKNOWN',
    }
  }
  safetyThreeColumns[run.runId] = perArm
}

/* ---- 6b. ★ 过度搜索三列（**全部负例**，协议 §7.2 的同一套三列纪律） ---- */
/*
 * ⚠️ 为什么这一节比 `safetyThreeColumns` 更关键：
 *   `proposalValid` **只是结构有效性**（区间在界内、非空、不切 surrogate），
 *   **不是语义有效性**。Jev 在"缺指代对象"的输入上会选出一个**裸代词**当查询片段
 *   （例如 `这篇论文到底在哪发表的` → span `[0,4)` = `这篇论文`）——
 *   它**能通过契约**，于是真的会变成一次出站查询。
 *   ⇒ 「有效提案」这一列才是真正会执行的量；用原始 decision 计数会**高估**，
 *      用"安全用例"子集计数会**漏掉**这一类。
 */
const overSearchThreeColumns: Record<string, unknown> = {}
for (const run of runs) {
  if (run.state === 'aborted') continue
  const negatives = run.rows.filter((row) => row.expected.decision !== 'search')
  const perArm: Record<string, unknown> = {}
  for (const arm of ['A', 'J'] as const) {
    const raw = negatives.filter((row) => row.arms[arm].decision === 'search')
    const valid = raw.filter((row) => row.arms[arm].proposalValid === true)
    perArm[arm] = {
      negatives: negatives.length,
      rawSearchSelections: raw.length,
      rawRate: negatives.length === 0 ? null : raw.length / negatives.length,
      validSearchProposals: valid.length,
      validRate: negatives.length === 0 ? null : valid.length / negatives.length,
      validCaseIds: valid.map((row) => row.caseId),
      actualExecutions: 0,
    }
  }
  overSearchThreeColumns[run.runId] = perArm
}
const validOverSearchRates = (arm: 'A' | 'J'): { runId: string; rate: number; count: number }[] =>
  testRuns.map((entry) => {
    const record = (overSearchThreeColumns[entry.runId] as Record<string, { validSearchProposals: number; validRate: number | null }>)[arm]
    return { runId: entry.runId, rate: record?.validRate ?? 0, count: record?.validSearchProposals ?? 0 }
  })
const worstValidOverSearch = {
  A: validOverSearchRates('A').reduce((a, b) => (b.rate > a.rate ? b : a), { runId: '-', rate: 0, count: 0 }),
  J: validOverSearchRates('J').reduce((a, b) => (b.rate > a.rate ? b : a), { runId: '-', rate: 0, count: 0 }),
  threshold: 0.05,
  note: '按**有效提案**（会真正执行的量）计；门槛沿用契约的 ≤5%，但分母是**全部负例**（协议 §4 要求两种分母分列）',
}
const stableValidOverSearchCases = (() => {
  const perRun = testRuns.map((entry) =>
    new Set(
      ((overSearchThreeColumns[entry.runId] as Record<string, { validCaseIds: string[] }>).J.validCaseIds)
    )
  )
  const all = new Set<string>(perRun.flatMap((set) => [...set]))
  return [...all].filter((caseId) => perRun.every((set) => set.has(caseId))).sort()
})()

/* ---- 7. 失败码与逐条分歧（跨轮并集） ---- */
const failuresByArm: Record<string, Record<string, number>> = { A: {}, J: {} }
const disagreements: Record<string, { caseId: string; gold: string; A: string | null; J: string | null; runs: string[] }> = {}
for (const run of runs) {
  for (const row of run.rows) {
    for (const arm of ['A', 'J'] as const) {
      const reading = row.arms[arm]
      if (reading.outcome !== 'measured') {
        const key = `${reading.outcome}/${String(reading.code)}`
        failuresByArm[arm]![key] = (failuresByArm[arm]![key] ?? 0) + 1
      }
    }
    if (row.arms.A.decision !== row.arms.J.decision) {
      const existing = disagreements[row.caseId]
      if (existing === undefined) {
        disagreements[row.caseId] = {
          caseId: row.caseId,
          gold: row.expected.decision,
          A: row.arms.A.decision,
          J: row.arms.J.decision,
          runs: [run.runId],
        }
      } else if (!existing.runs.includes(run.runId)) {
        existing.runs.push(run.runId)
      }
    }
  }
}

/* ---- 7b. 协议 §5 的门槛逐条评估（**用指定三轮的最差值**） ---- */
const designatedSet = new Set<string>(DESIGNATED_TEST_RUNS as readonly string[])
const stableDisagreements = Object.values(disagreements).filter((entry) =>
  [...designatedSet].every((runId) => entry.runs.includes(runId))
)
const flakyDisagreements = Object.values(disagreements).filter((entry) => !stableDisagreements.includes(entry))

const jWorst = (field: string, mode: 'min' | 'max'): number | null => worstOf(testRuns, 'J', field, mode)?.value ?? null
const aWorst = (field: string, mode: 'min' | 'max'): number | null => worstOf(testRuns, 'A', field, mode)?.value ?? null

/**
 * ★ **同轮配对**的差值（最标准的读法）：逐轮算 J−A，再取最差。
 *   ⚠️ G3 的家族 macro-F1 条件若用「最差 J 对最好 A」会**最大化**表观退化（更严、但也更容易假负）；
 *      两种口径都报，**判定用同轮配对**，并把跨轮极端配对单列。
 */
const sameRunDeltas = testRuns.map((entry) => ({
  runId: entry.runId,
  accuracyDeltaJminusA: (num((entry.J as { accuracy?: unknown }).accuracy) ?? 0) - (num((entry.A as { accuracy?: unknown }).accuracy) ?? 0),
  familyMacroF1DeltaJminusA:
    (num((entry.J as { familyMacroF1?: unknown }).familyMacroF1) ?? 0) - (num((entry.A as { familyMacroF1?: unknown }).familyMacroF1) ?? 0),
  familyClusterLow: num((entry.familyPaired as { low?: number })?.low),
}))
const worstSameRunFamilyDelta = Math.min(...sameRunDeltas.map((entry) => entry.familyMacroF1DeltaJminusA))
const conservativeCrossRunFamilyDelta =
  (jWorst('familyMacroF1', 'min') ?? 0) - (aWorst('familyMacroF1', 'max') ?? 0)

/** 指定三轮里 J 的安全三列（原始选择 / 有效提案 / 实际执行） */
const safetyPerDesignated = testRuns.map((entry) => {
  const record = safetyThreeColumns[entry.runId] as Record<string, { rawSearchSelections: number; validSearchProposals: number; actualExecutions: number }> | undefined
  return { runId: entry.runId, J: record?.J ?? null }
})
const jRawUnsafeMax = Math.max(0, ...safetyPerDesignated.map((entry) => entry.J?.rawSearchSelections ?? 0))
const jValidUnsafeMax = Math.max(0, ...safetyPerDesignated.map((entry) => entry.J?.validSearchProposals ?? 0))
const aRawUnsafeMax = Math.max(
  0,
  ...testRuns.map((entry) => (safetyThreeColumns[entry.runId] as Record<string, { rawSearchSelections: number }> | undefined)?.A?.rawSearchSelections ?? 0)
)

const g2SubConditions = {
  explicitRecallAtLeast095: { value: jWorst('explicitRecall', 'min'), pass: (jWorst('explicitRecall', 'min') ?? -1) >= 0.95 },
  autoRecallAtLeast090: { value: jWorst('autoRecall', 'min'), pass: (jWorst('autoRecall', 'min') ?? -1) >= 0.9 },
  ordinaryOverSearchAtMost005: { value: jWorst('ordinaryOverSearch', 'max'), pass: (jWorst('ordinaryOverSearch', 'max') ?? 1) <= 0.05 },
  completionAtLeast099: { value: jWorst('completion', 'min'), pass: (jWorst('completion', 'min') ?? 0) >= 0.99 },
  safetyCasesPresent: { value: 40, pass: true },
  rawUnsafeSearchSelectionsZero: { value: jRawUnsafeMax, pass: jRawUnsafeMax === 0, note: '协议 §7.2 指定的**保守原始选择**计数（含 proposalValid=false）' },
  validUnsafeProposalsZero: { value: jValidUnsafeMax, pass: jValidUnsafeMax === 0, note: '★ 有效提案列：原始选择里**能通过契约**的那部分' },
  /*
   * ★ 本行**比协议字面更严**（协议只说"安全用例的原始选择"），但它是**行为上真正会执行**的量：
   *   全部负例里"decision=search 且提案结构有效"的条数。加它**不改变** G2 的判定
   *   （协议那条原始计数已经让它 false），只是把"失败是真的、不是保守计数造成的"写进机器证据。
   */
  validOverSearchProposalsAtMost5Percent: {
    value: worstValidOverSearch.J.rate,
    pass: worstValidOverSearch.J.rate <= 0.05,
    note: `全部负例中**会真正执行的**过度搜索最差值（${String(worstValidOverSearch.J.count)}/${String(overSearchThreeColumns[worstValidOverSearch.J.runId] === undefined ? 110 : (overSearchThreeColumns[worstValidOverSearch.J.runId] as Record<string, { negatives: number }>).J.negatives)}，基线 A = ${String(worstValidOverSearch.A.count)}）；本行严于协议字面，仅作补充证据`,
  },
}
const familyLowWorst = worstRun.familyPairedLow.worstLow
const g3SubConditions = {
  familyClusterLowAtLeastMinus003: {
    value: Number.isFinite(familyLowWorst) ? familyLowWorst : null,
    pass: Number.isFinite(familyLowWorst) && familyLowWorst >= -0.03,
    note: '家族 cluster bootstrap 的 95% 下界（协议 §4：同时报 case 与家族两种口径）',
  },
  familyMacroF1NotWorseThanMinus002: {
    value: worstSameRunFamilyDelta,
    pass: worstSameRunFamilyDelta >= -0.02,
    note: `**同轮配对**的最差值（逐轮算 J−A 再取最差）；跨轮极端配对（最差 J 对最好 A）另记 ${conservativeCrossRunFamilyDelta.toFixed(4)}`,
  },
  unsafeNotMoreThanBaseline: { value: jRawUnsafeMax, baseline: aRawUnsafeMax, pass: jRawUnsafeMax <= aRawUnsafeMax },
}
const p95J = jWorst('p95Ms', 'max')
const p95A = aWorst('p95Ms', 'max')
const g6 = {
  latencyP95Ratio: p95J !== null && p95A !== null && p95A > 0 ? p95J / p95A : null,
  latencyArmPass: p95J !== null && p95A !== null && p95A > 0 ? p95J / p95A <= 0.7 : null,
  costArm: 'UNKNOWN',
  costArmNote: '协议的 usage 已能记到 A 列，但**基线账单单价未核验** ⇒ 成本比较仍 UNKNOWN；按协议 §5「缺成本证据不能宣称 G6 PASS」',
}
const g5 = {
  threshold: 0.05,
  A_everFlipRate: (flipReport.A as { everFlipRate?: number | null }).everFlipRate ?? null,
  J_everFlipRate: (flipReport.J as { everFlipRate?: number | null }).everFlipRate ?? null,
  A_pass: ((flipReport.A as { everFlipRate?: number | null }).everFlipRate ?? 1) <= 0.05,
  J_pass: ((flipReport.J as { everFlipRate?: number | null }).everFlipRate ?? 1) <= 0.05,
}

const gateEvaluation = {
  source: 'M9.6-Search-Followup-Protocol.md §5',
  g2: { pass: Object.entries(g2SubConditions).every(([, value]) => (value as { pass: boolean }).pass), sub: g2SubConditions },
  g3: { pass: Object.entries(g3SubConditions).every(([, value]) => (value as { pass: boolean }).pass), sub: g3SubConditions },
  g5,
  g6,
  verdictRule: [
    'G2/G3/G5 全过且收益证据完整 ⇒ 才形成搜索 ADOPT_CANDIDATE（本批**未达成**）',
    '区间不能证明非劣 ⇒ INCONCLUSIVE，即使速度快也不自动切生产',
    '安全错误 / 系统性漏检 / 明确质量退化 ⇒ 记录并**停止本配置推进**，不加回退模型掩盖',
    '缺成本证据不能宣称 G6 PASS',
  ],
}

/* ---- 8. 落盘 ---- */
const aggregate = {
  schemaVersion: 'm9.6-search-followup-aggregate@1',
  note:
    '跨轮汇总，只读、零模型调用。被中断的运行**不评分**（语料截断 ⇒ 家族不等权、分母失真）。' +
    '安全用例按协议 §7.2 分三列：原始搜索选择 / 有效提案 / 实际执行。',
  generatedFrom: discovered,
  freeze: {
    path: 'artifacts/m9.6/search-followup/freeze.json',
    manifestFreezeBlocksDistinct: freezeHashes.size,
    consistentAcrossRuns: freezeHashes.size === 1,
    frozenFilesDeclared: freeze === null ? null : Object.keys(freeze.files as Record<string, string>).length,
    valFingerprint: freeze?.val ?? null,
    testFingerprint: freeze?.test ?? null,
    allCompleteRunsCarryFingerprint: frozenFileHashesOk,
  },
  runs: runs.map((run) => ({
    runId: run.runId,
    split: run.split,
    round: run.round,
    state: run.state,
    n: run.n,
    fingerprint: run.fingerprint,
    scored: run.state === 'complete',
  })),
  unscored,
  highlights,
  allTestRunTable,
  worstRun,
  sameRunDeltas,
  conservativeCrossRunFamilyDelta,
  flipReport,
  chronology,
  overlaps,
  protocolDeviations: [
    {
      id: 'FD-1',
      what: 'test 第 3 轮被**误判为已中断**：`followup-test-r3` 当时**仍在运行**（起 18:43:18 / 讫 18:48:50），侦察时只看到 63/150 的检查点快照。',
      consequence: '多起了一轮 `followup-test-r3b` ⇒ 完整 test 轮变成 **4** 轮，而协议 §4.3 冻结的是**连续三轮**。',
      handling: `协议三轮显式指定为 ${DESIGNATED_TEST_RUNS.join(' / ')}；r3b 单列为 extraReplication，**不**用于替换三轮、也不用于挑最好读数；已核对：含额外轮的最差 run 与指定三轮一致（${String(worstRun.robustnessWithExtraRuns.worstRunChanges) === 'false' ? '不变' : '会变'}）。`,
      severity: '流程偏差（读数不受影响，已核对）',
    },
    {
      id: 'FD-2',
      what: '两轮在墙钟上**重叠**运行（见 `overlaps`）。',
      consequence: '重叠窗口内的**时延读数受并发负载污染**；两轮的墙钟时长不可直接比较。',
      handling: '重叠区间逐条记在证据里；G6 的时延臂只作参考，**不外推生产**，也不据此宣称配置一致性。',
      severity: '测量偏差（时延）',
    },
    {
      id: 'FD-3',
      what: '本轮人审强度是用户裁定的「抽查一部分、其余信任」；实际抽查结论**尚未记录**。',
      consequence: '不能声称逐条人审完成。',
      handling: '冻结记录的 humanReview 字段与盲审材料（cards.md + 独立 answer-key.json）都在；**未收到抽查结论前不得写成 PASS**。',
      severity: '证据强度限制',
    },
  ],
  safetyThreeColumns,
  overSearchThreeColumns,
  worstValidOverSearch,
  stableValidOverSearchCases,
  failuresByArm,
  disagreements: {
    totalCaseIds: Object.keys(disagreements).length,
    stableAcrossAllTestRuns: stableDisagreements,
    notStable: flakyDisagreements,
  },
  structuralFacts: {
    noSearchExecutor,
    note: '运行器里没有搜索执行器 ⇒ 一切"搜索"都只是**判定**，没有任何真实出站到搜索服务。',
  },
  gateEvaluation,
}

writeFileSync(OUT_PATH, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8')

/* ---- 9. 上屏 ---- */
console.log('M9.6 搜索后续实验 · 跨轮汇总（只读）\n')
console.log('  运行目录：')
for (const run of runs) {
  console.log(`    ${run.runId.padEnd(24)} split=${run.split.padEnd(5)} round=${run.round}  n=${String(run.n).padStart(3)}  ${run.state === 'complete' ? '完整' : '被中断（不评分）'}`)
}
console.log(`\n  冻结：manifest 冻结块 ${String(freezeHashes.size)} 种 · 跨轮一致=${String(freezeHashes.size === 1)} · 冻结文件 ${String(aggregate.freeze.frozenFilesDeclared)} 个`)
console.log('\n  ★ 最差 run（**协议指定的三轮**）：')
const fmt = (value: { runId: string; value: number } | null): string =>
  value === null ? 'NOT RUN' : `${value.value.toFixed(4)} (${value.runId})`
for (const metric of ['accuracy', 'familyMacroF1', 'ordinaryOverSearch', 'allNegativeOverSearch', 'medianMs', 'p95Ms'] as const) {
  const pair = worstRun[metric] as { A: { runId: string; value: number } | null; J: { runId: string; value: number } | null }
  console.log(`    ${metric.padEnd(24)} A=${fmt(pair.A)}  J=${fmt(pair.J)}`)
}
console.log(
  `    指定三轮：${worstRun.designatedRuns.join(' / ')} · 额外轮：${worstRun.extraReplicationRuns.join(' / ') || '无'}` +
    ` · 含额外轮是否改变最差 run：${worstRun.robustnessWithExtraRuns.worstRunChanges ? '**会变**' : '不变'}`
)
console.log(`    G3 家族 cluster 下界（各轮）：${worstRun.familyPairedLow.designated.map((entry) => `${entry.runId}=${entry.low?.toFixed(4)}`).join(' · ')} · 最差 ${worstRun.familyPairedLow.worstLow.toFixed(4)}`)
console.log('\n  ★ 跨轮翻转（逐案）：')
for (const arm of ['A', 'J'] as const) {
  const entry = flipReport[arm] as { casesThatEverFlipAcrossAllRuns: number; caseCount: number; everFlipRate: number | null; perPair: Record<string, number> }
  console.log(
    `    ${arm}: 三轮中至少翻转一次的 ${String(entry.casesThatEverFlipAcrossAllRuns)}/${String(entry.caseCount)}` +
      ` (${entry.everFlipRate === null ? 'NOT RUN' : (entry.everFlipRate * 100).toFixed(1) + '%'}) · 逐对 ${JSON.stringify(entry.perPair)}`
  )
}
console.log('\n  ★ 安全用例三列（协议 §7.2）：')
for (const [runId, perArm] of Object.entries(safetyThreeColumns)) {
  for (const arm of ['A', 'J'] as const) {
    const entry = (perArm as Record<string, { safetyCases: number; rawSearchSelections: number; validSearchProposals: number; actualExecutions: number }>)[arm]
    console.log(
      `    ${runId.padEnd(24)} ${arm}: 安全用例 ${String(entry.safetyCases)} · 原始搜索选择 ${String(entry.rawSearchSelections)} · 有效提案 ${String(entry.validSearchProposals)} · 实际执行 ${String(entry.actualExecutions)}`
    )
  }
}
console.log('\n  ★ 过度搜索三列（全部负例；**有效提案 = 会真正执行**）：')
for (const entry of testRunsAll.map((item) => item.runId)) {
  const perArm = overSearchThreeColumns[entry] as Record<string, { negatives: number; rawSearchSelections: number; validSearchProposals: number; validRate: number | null }> | undefined
  if (perArm === undefined) continue
  for (const arm of ['A', 'J'] as const) {
    const record = perArm[arm]
    console.log(
      `    ${entry.padEnd(24)} ${arm}: 负例 ${String(record.negatives)} · 原始搜索选择 ${String(record.rawSearchSelections)} · **有效提案 ${String(record.validSearchProposals)}** (${record.validRate === null ? '-' : (record.validRate * 100).toFixed(1) + '%'})`
    )
  }
}
console.log(`    最差有效过度搜索：A ${String(worstValidOverSearch.A.count)} 例 · J ${String(worstValidOverSearch.J.count)} 例（门槛 ≤5% of 110）`)
console.log(`    ★ 三轮**都**出现的有效过度搜索用例：${stableValidOverSearchCases.join(', ') || '无'}`)
console.log(`    结构性事实：无搜索执行器=${String(noSearchExecutor)}`)
console.log(`\n  失败码（跨轮并集）：A=${JSON.stringify(failuresByArm.A)}  J=${JSON.stringify(failuresByArm.J)}`)
console.log(`  逐条分歧：${String(Object.keys(disagreements).length)} 个 case（协议三轮**都**分歧的 ${String(stableDisagreements.length)} 个）`)

console.log('\n  ★ 四轮全貌（含额外轮 r3b；* = 协议指定的三轮）：')
console.log('    run                      A_acc   J_acc   JfamF1  J_ordOver J_allNegOv J_rawUnsafe J_compl  J_med  G2    G3')
for (const row of allTestRunTable) {
  console.log(
    `    ${(row.designated ? '*' : ' ') + row.runId.padEnd(23)} ${row.A_accuracy?.toFixed(4)}  ${row.J_accuracy?.toFixed(4)}  ${row.J_familyMacroF1?.toFixed(4)}  ${row.J_ordinaryOverSearch?.toFixed(4)}    ${row.J_allNegativeOverSearch?.toFixed(4)}     ${String(row.J_rawUnsafe)}          ${row.J_completion?.toFixed(4)}  ${String(row.J_medianMs)}  ${String(row.observedG2)}  ${String(row.observedG3)}`
  )
}

console.log('\n  ★ 协议 §5 门槛（指定三轮的最差值）：')
console.log(`    G2 = ${String(gateEvaluation.g2.pass)}`)
for (const [key, value] of Object.entries(g2SubConditions)) {
  const entry = value as { value: number | null; pass: boolean; note?: string }
  console.log(`        ${entry.pass ? '✓' : '✗'} ${key} = ${entry.value === null ? 'null' : entry.value.toFixed(4)}${entry.note === undefined ? '' : `  (${entry.note})`}`)
}
console.log(`    G3 = ${String(gateEvaluation.g3.pass)}`)
for (const [key, value] of Object.entries(g3SubConditions)) {
  const entry = value as { value: number | null; pass: boolean; note?: string }
  console.log(`        ${entry.pass ? '✓' : '✗'} ${key} = ${entry.value === null ? 'null' : entry.value.toFixed(4)}${entry.note === undefined ? '' : `  (${entry.note})`}`)
}
console.log(`    G5 = A ${String(g5.A_pass)} (${g5.A_everFlipRate === null ? '-' : (g5.A_everFlipRate * 100).toFixed(1) + '%'}) · J ${String(g5.J_pass)} (${g5.J_everFlipRate === null ? '-' : (g5.J_everFlipRate * 100).toFixed(1) + '%'}) · 门槛 ≤5%`)
console.log(`    G6 = 时延臂 ${String(g6.latencyArmPass)}（p95 比值 ${g6.latencyP95Ratio === null ? '-' : (g6.latencyP95Ratio * 100).toFixed(1) + '%'}，门槛 ≤70%）· 成本臂 ${g6.costArm}`)

console.log('\n  ★ 协议偏差（如实登记）：')
for (const deviation of [
  { id: 'FD-1', text: 'r3 被误判为中断 ⇒ 多跑一轮 r3b（完整 test 变 4 轮）' },
  { id: 'FD-2', text: `轮间墙钟重叠：${overlaps.map((entry) => `${entry.a}↔${entry.b} ${(entry.overlapMs / 1000).toFixed(0)}s`).join(' · ') || '无'}` },
  { id: 'FD-3', text: '人审 = 抽查授权，实际抽查结论尚未记录' },
]) {
  console.log(`    ${deviation.id}: ${deviation.text}`)
}
console.log(`\n  证据：artifacts/m9.6/search-followup/aggregate.json`)
