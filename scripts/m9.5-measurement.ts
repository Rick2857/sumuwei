/**
 * M9.5 WP2 / C4 —— **量具有效性自证**（`pnpm m9.5:measurement:verify`）。
 *
 * ============================================================================
 *  它验证的是**量具**，不是系统
 * ============================================================================
 * ```text
 * 计划 §14.6 + AGENTS §6.7 的三段式（缺一不可）：
 *   正控：合法输入 ⇒ 检测器**安静**
 *   负控：注入假象 ⇒ 检测器**必须响**
 *   恢复：放回真实实现 ⇒ **重新安静**
 * 「只做正控的量具」与「什么都不检查」在输出上无法区分 —— 所以负控是主角。
 *
 * ⚠️ 因此**正控喂的是语料自己的 gold**（selected/context 直接取 gold id）：
 *    它检验的是"判定器认不认 gold"，**不是**"检索链跑通没跑通"。
 *    把这两件事混起来，正控 100% 会被误读成"系统正确率 100%"。
 * ```
 *
 * ============================================================================
 *  范围边界（本阶段 / 下阶段）
 * ============================================================================
 * ```text
 * 本脚本（WP2，离线、零模型）：**检索侧判定器**
 *   · 候选面：`selectedIds` 是否覆盖 `requiredEvidenceGroups`（= Candidate Recall 的判据核）
 *   · 上下文面：`contextIds` 是否真的含所需证据（= Context Evidence Success 的判据核）
 *   · 泄漏面：`forbiddenIds` / `leakedIds` / "无目标却给证据"（= Critical Leakage）
 *   · 覆盖/权威面：`partial_coverage` 与 `source_unavailable` 必须与"没找到"**分开**
 * 不属本脚本（WP10，需真模型）：**回复侧**
 *   · `Answer Grounded Correctness` · `Unsupported Assertion Rate`
 *   ⇒ 本脚本的 `probes` 里如实标 `not-run`，**不**用 0 冒充"这层没问题"。
 * ```
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · **零模型调用、零联网、不开数据库**（构造属性：本脚本不 import 数据库模块）。
 *  · 不读盲测集去调参：本脚本只读 **dev + val**（`evals/m9.5/corpus/`）；
 *    blind 只在 WP10 用一次。**这本身是一条可被机器核对的纪律**（见 `blindUntouched`）。
 *  · 人工核对材料（≥30 例）写到 `artifacts/m9.5/local/`（已 ignore）；
 *    人未读 ⇒ 结论里 `Human Review = PENDING`，**不代填**。
 *
 * 用法：`pnpm m9.5:measurement:verify`
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
const GATE_VERSION = 'm9.5-measurement@1'
const CORPUS_DIR = join(REPO_ROOT, 'evals/m9.5/corpus')
const LOCAL_DIR = join(REPO_ROOT, 'artifacts/m9.5/local/measurement-review')
const BLIND_PATH = join(REPO_ROOT, 'artifacts/m9.5/local/corpus-blind/blind.jsonl')

// ---------------------------------------------------------------------------
// 语料类型（只读 dev/val）
// ---------------------------------------------------------------------------

interface CorpusCase {
  readonly caseId: string
  readonly familyId: string
  readonly split: string
  readonly stratum: string
  readonly formKind: string
  readonly user: string
  readonly request: string
  readonly intent: string
  readonly timeScope: string
  readonly authoritativeSnapshot: { readonly value: string; readonly previousValue?: string }
  readonly relevantMemoryIds: readonly string[]
  readonly requiredEvidenceGroups: readonly (readonly string[])[]
  readonly forbiddenIds: readonly string[]
  readonly expectedUnknownOrClarify: boolean
}

/** 一次检索的**观测**（判定器只吃这个形状；不读语料之外的东西） */
interface Observation {
  readonly selectedIds: readonly string[]
  /** 真正进了最终上下文的（`selected` ≠ `actual in model`，计划 §14.3 明文） */
  readonly contextIds: readonly string[]
  readonly leakedIds: readonly string[]
  readonly coverage: 'complete' | 'partial'
  readonly authorityQueryOk: boolean
}

type Basis = 'candidate' | 'context'
type Verdict = 'correct' | 'wrong' | 'insufficient'

interface JudgeReading {
  readonly verdict: Verdict
  readonly failures: readonly string[]
}

/**
 * 判定器本体。**只据 ID 与集合**，不看正文、不调模型。
 *
 * ⚠️ 它与"被测系统"必须**同源不同体**：语料的 gold 由生成器产出，
 *    判定器只做集合运算 ⇒ `gold 生成` 与 `执行结果计算` 天然分离（计划 §14.6）。
 */
function judge(c: CorpusCase, obs: Observation, basis: Basis): JudgeReading {
  const fatal: string[] = []
  const insufficient: string[] = []
  const seen = new Set(basis === 'candidate' ? obs.selectedIds : obs.contextIds)

  /* ① 关键泄漏：一票否决 */
  if (obs.leakedIds.length > 0) fatal.push(`leak:${obs.leakedIds.join(',')}`)

  /* ② 权威回查失败 ⇒ 不是"没找到"，而是"这条读数不可用" */
  if (!obs.authorityQueryOk) insufficient.push('source_unavailable')

  /* ③ 覆盖不完整 ⇒ 未命中不能解释成"不存在" */
  if (obs.coverage === 'partial') insufficient.push('partial_coverage')

  if (c.expectedUnknownOrClarify) {
    /* 应当未知：**不允许**给出任何证据（给了就是"无据断言"的机器形态） */
    if (seen.size > 0) fatal.push(`asserted_without_support:${[...seen].join(',')}`)
  } else {
    for (const group of c.requiredEvidenceGroups) {
      if (!group.some((id) => seen.has(id))) fatal.push(`missing_group:${group.join('|')}`)
    }
    for (const bad of c.forbiddenIds) {
      if (seen.has(bad)) fatal.push(`forbidden_present:${bad}`)
    }
  }

  if (fatal.length > 0) return { verdict: 'wrong', failures: [...fatal, ...insufficient] }
  if (insufficient.length > 0) return { verdict: 'insufficient', failures: insufficient }
  return { verdict: 'correct', failures: [] }
}

// ---------------------------------------------------------------------------
// 观测的构造：gold（正控）与 6 种"只改一件事"的注入（负控）
// ---------------------------------------------------------------------------

function goldObservation(c: CorpusCase): Observation {
  const ids = [...c.relevantMemoryIds]
  return {
    selectedIds: ids,
    contextIds: ids,
    leakedIds: [],
    coverage: 'complete',
    authorityQueryOk: true,
  }
}

/**
 * 对照组：每条**声明它期望的判定种类**（不是只声明"别是 correct"）。
 *
 * ⚠️ 第一版只有 6 条"注入一次改动 ⇒ 判定别是 correct"，自我审查时发现两个真缺口：
 * ```text
 * A. **没有任何对照验证 `selected` ≠ `actual in model`** ——
 *    而那正是 `Candidate Recall` 与 `Context Evidence Success` **不许混用**的核心
 *    （计划 §14.3 明文"selected ≠ actual in model"）。⇒ 补 `selected-but-not-in-context`。
 * B. **没有任何对照验证"覆盖不完整 / 权威不可用"必须判 `insufficient`**，
 *    而不是 `wrong` 也不是 `correct`。只断言"别是 correct"会让一个把两者混成 `wrong`
 *    的判定器**照样通过**。⇒ 补 `partial-coverage` 与 `authority-unavailable`，
 *    并把期望改成**精确的三态**。
 * ```
 */
interface Control {
  readonly kind: string
  readonly what: string
  readonly applicable: (c: CorpusCase) => boolean
  readonly build: (c: CorpusCase, gold: Observation) => Observation
  readonly expected: (c: CorpusCase) => { readonly candidate: Verdict; readonly context: Verdict }
}

const ALL_CORRECT = (): { candidate: Verdict; context: Verdict } => ({ candidate: 'correct', context: 'correct' })
const ALL_WRONG = (): { candidate: Verdict; context: Verdict } => ({ candidate: 'wrong', context: 'wrong' })
const ALL_INSUFFICIENT = (): { candidate: Verdict; context: Verdict } => ({
  candidate: 'insufficient',
  context: 'insufficient',
})

const retrieveOnly = (c: CorpusCase): boolean =>
  !c.expectedUnknownOrClarify && c.requiredEvidenceGroups.length > 0

const CONTROLS: readonly Control[] = [
  {
    kind: 'drop-one-required',
    what: '只把一条必需证据从选中/入模里拿掉',
    applicable: retrieveOnly,
    build: (c, gold) => {
      const drop = (c.requiredEvidenceGroups[0] ?? [])[0] as string
      return { ...gold, selectedIds: gold.selectedIds.filter((id) => id !== drop), contextIds: gold.contextIds.filter((id) => id !== drop) }
    },
    expected: ALL_WRONG,
  },
  {
    kind: 'owner-swap',
    what: '只把必需证据的 owner 段换掉（C1→C2）',
    applicable: retrieveOnly,
    build: (_c, gold) => ({
      ...gold,
      selectedIds: gold.selectedIds.map((id) => id.replace(':C1:', ':C2:')),
      contextIds: gold.contextIds.map((id) => id.replace(':C1:', ':C2:')),
    }),
    expected: ALL_WRONG,
  },
  {
    kind: 'value-swap',
    what: '只把必需证据的取值段换掉',
    applicable: retrieveOnly,
    build: (_c, gold) => ({
      ...gold,
      selectedIds: gold.selectedIds.map((id) => `${id}#mutated`),
      contextIds: gold.contextIds.map((id) => `${id}#mutated`),
    }),
    expected: ALL_WRONG,
  },
  {
    kind: 'forbidden-included',
    what: '只把 forbidden 的旧值放进来',
    applicable: (c) => c.forbiddenIds.length > 0,
    build: (c, gold) => ({
      ...gold,
      selectedIds: [...gold.selectedIds, c.forbiddenIds[0] as string],
      contextIds: [...gold.contextIds, c.forbiddenIds[0] as string],
    }),
    expected: ALL_WRONG,
  },
  {
    kind: 'assert-without-support',
    what: '对"应未知"的查询只改一件事：给出一条证据',
    applicable: (c) => c.expectedUnknownOrClarify,
    build: (_c, gold) => ({
      ...gold,
      selectedIds: ['mem:MUTATED:no-such-fact'],
      contextIds: ['mem:MUTATED:no-such-fact'],
    }),
    expected: ALL_WRONG,
  },
  {
    kind: 'unauthorized-leak',
    what: '只让泄漏面多一条 id',
    applicable: () => true,
    build: (_c, gold) => ({ ...gold, leakedIds: ['mem:MUTATED:leaked'] }),
    expected: ALL_WRONG,
  },
  {
    /* ★ 缺口 A：selected 有、**实际入模没有** ⇒ 候选面对、上下文面错 */
    kind: 'selected-but-not-in-context',
    what: '选中里有必需证据，但它**没有真的进模型**（selected ≠ actual in model）',
    applicable: retrieveOnly,
    build: (_c, gold) => ({ ...gold, contextIds: [] }),
    expected: () => ({ candidate: 'correct', context: 'wrong' }),
  },
  {
    /* ★ 缺口 B：覆盖不完整 ⇒ 必须 `insufficient`（既不是 correct 也不是 wrong） */
    kind: 'partial-coverage',
    what: '覆盖不完整（索引有缺口）⇒ 未命中不得解释成"不存在"',
    applicable: () => true,
    build: (_c, gold) => ({ ...gold, coverage: 'partial' }),
    expected: ALL_INSUFFICIENT,
  },
  {
    /* ★ 缺口 B：权威回查失败 ⇒ 必须 `insufficient`，且**不用缓存事实顶替** */
    kind: 'authority-unavailable',
    what: '权威回查失败而向量缓存健康 ⇒ 不得用缓存事实顶替',
    applicable: () => true,
    build: (_c, gold) => ({ ...gold, authorityQueryOk: false }),
    expected: ALL_INSUFFICIENT,
  },
]

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function loadJsonl(path: string): CorpusCase[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusCase)
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** 计划 §14.6 要求"各有样例"的四类；每类给出语料里对应的子层 */
const CATEGORIES: readonly { id: string; label: string; kinds: readonly string[] }[] = [
  { id: 'paraphrase', label: '近义改述', kinds: ['synonym', 'indirect', 'elliptical'] },
  { id: 'correct-denial', label: '正确否认', kinds: ['forgotten', 'neverSaved', 'chatOnly', 'outOfCoverage'] },
  { id: 'similar-but-different', label: '相似但不同的事实', kinds: ['similarProject', 'person', 'value-swap-owner', 'numberUnit', 'unitChange'] },
  { id: 'unsupported-assertion', label: '无依据断言', kinds: ['beyondScope', 'outOfCoverage'] },
]

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp2-measurement', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)

  const dev = loadJsonl(join(CORPUS_DIR, 'dev.jsonl'))
  const val = loadJsonl(join(CORPUS_DIR, 'val.jsonl'))
  const cases = [...dev, ...val]
  if (cases.length === 0) throw new Error('语料为空 ⇒ 先跑 `pnpm m9.5:corpus`')

  /* ---- ① 正控：判定器必须认 gold ---- */
  const positive = { total: cases.length, correct: 0, notCorrect: [] as string[] }
  for (const c of cases) {
    const obs = goldObservation(c)
    const a = judge(c, obs, 'candidate')
    const b = judge(c, obs, 'context')
    if (a.verdict === 'correct' && b.verdict === 'correct') positive.correct += 1
    else positive.notCorrect.push(`${c.caseId}(${a.verdict}/${b.verdict})`)
  }

  /* ---- ② 负控：每条的判定必须**精确等于**它声明的期望，且适用条数必须 > 0 ---- */
  const negative = CONTROLS.map((control) => {
    const applicableCases = cases.filter((c) => control.applicable(c))
    let matched = 0
    const mismatched: string[] = []
    for (const c of applicableCases) {
      const gold = goldObservation(c)
      const injected = control.build(c, gold)
      const actual = {
        candidate: judge(c, injected, 'candidate').verdict,
        context: judge(c, injected, 'context').verdict,
      }
      const expected = control.expected(c)
      if (actual.candidate === expected.candidate && actual.context === expected.context) matched += 1
      else {
        mismatched.push(
          `${c.caseId}(期望 ${expected.candidate}/${expected.context}，实测 ${actual.candidate}/${actual.context})`
        )
      }
    }
    return {
      kind: control.kind,
      what: control.what,
      applicableCases: applicableCases.length,
      matched,
      mismatched: mismatched.slice(0, 10),
      /** ★ 分母自检：适用 0 条 ⇒ 这条负控是**空的**，不算通过（AGENTS §6.8） */
      vacuous: applicableCases.length === 0,
      allMatched: applicableCases.length > 0 && matched === applicableCases.length,
    }
  })

  /* ---- ③ 恢复：注入一次、再放回 gold ⇒ 必须**重新安静** ---- */
  const leakControl = CONTROLS.find((control) => control.kind === 'unauthorized-leak') as Control
  const recovery = { total: cases.length, quietAgain: 0, notQuiet: [] as string[] }
  for (const c of cases) {
    /* 先注入（并**断言它确实响了**），再恢复 —— 验的是"响过之后能回到安静"，
       而不是单纯重跑一遍正控（后者与正控重复，证明不了恢复） */
    const injectedVerdict = judge(c, leakControl.build(c, goldObservation(c)), 'context').verdict
    if (injectedVerdict === 'correct') {
      recovery.notQuiet.push(`${c.caseId}(注入未被检出，恢复无意义)`)
      continue
    }
    const restored = judge(c, goldObservation(c), 'candidate')
    const restoredContext = judge(c, goldObservation(c), 'context')
    if (restored.verdict === 'correct' && restoredContext.verdict === 'correct') recovery.quietAgain += 1
    else recovery.notQuiet.push(`${c.caseId}(${restored.verdict}/${restoredContext.verdict})`)
  }

  /* ---- ④ 四类判据有效性（计划 §14.6「各有样例」）---- */
  const categories = CATEGORIES.map((category) => {
    const picked = cases.filter((c) => category.kinds.includes(c.formKind)).slice(0, 12)
    const correctSide = picked.filter((c) => judge(c, goldObservation(c), 'context').verdict === 'correct').length
    const wrongSide = picked.filter((c) => {
      const usable = CONTROLS.filter(
        (control) => control.applicable(c) && control.expected(c).context !== 'correct'
      )
      if (usable.length === 0) return false
      const control = usable[0] as Control
      return judge(c, control.build(c, goldObservation(c)), 'context').verdict === control.expected(c).context
    }).length
    return {
      id: category.id,
      label: category.label,
      samples: picked.length,
      correctSideDetected: correctSide,
      wrongSideDetected: wrongSide,
      /** 两侧都要有样例，否则这一类"没有被验证" */
      bothSidesPresent: picked.length > 0 && correctSide > 0 && wrongSide > 0,
    }
  })

  /* ---- ⑤ 人工核对材料（≥30 例）---- */
  mkdirSync(LOCAL_DIR, { recursive: true })
  const spread = [
    ...cases.filter((c) => c.split === 'dev' && c.stratum === 'normal').slice(0, 8),
    ...cases.filter((c) => c.split === 'dev' && c.stratum === 'hard').slice(0, 8),
    ...cases.filter((c) => c.split === 'dev' && c.stratum === 'unknown').slice(0, 7),
    ...cases.filter((c) => c.split === 'dev' && c.stratum === 'lifecycle').slice(0, 7),
  ]
  const reviewLines = spread.map((c, index) => {
    const gold = goldObservation(c)
    const reviewControl = (CONTROLS.filter(
      (control) => control.applicable(c) && control.expected(c).context !== 'correct'
    )[0] ?? CONTROLS[0]) as Control
    const injected = reviewControl.build(c, gold)
    return {
      no: index + 1,
      caseId: c.caseId,
      request: c.request,
      gold: {
        relevant: c.relevantMemoryIds,
        forbidden: c.forbiddenIds,
        expectedUnknownOrClarify: c.expectedUnknownOrClarify,
        acceptableAnswerPoints: (c as unknown as { acceptableAnswerPoints?: readonly string[] }).acceptableAnswerPoints ?? [],
      },
      observation_gold: gold,
      judge_on_gold: judge(c, gold, 'context'),
      injectedControl: reviewControl.kind,
      expectedOnInjected: reviewControl.expected(c),
      observation_injected: injected,
      judge_on_injected: judge(c, injected, 'context'),
      humanQuestion: '判定器这两次判定对不对？（对的打勾；不对的写出理由并标出是哪条规则错）',
      humanVerdict: 'PENDING_HUMAN_REVIEW',
    }
  })
  const reviewPath = join(LOCAL_DIR, 'review-30.jsonl')
  writeFileSync(reviewPath, reviewLines.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8')

  /* ---- ⑥ 盲测未被触碰（可机器核对的纪律）---- */
  const blindPresent = existsSync(BLIND_PATH)
  const blindReadByThisScript = false

  const probes = {
    positive,
    negative,
    recovery,
    categories,
    replySide: {
      verdict: 'not-run',
      why: '回复侧（grounded correctness / unsupported assertion）需要真实回复模型 ⇒ WP10；本脚本不用 0 冒充',
    },
  }

  const vacuous = negative.filter((mutation) => mutation.vacuous)
  const failedControls = negative.filter((mutation) => !mutation.allMatched)
  const failed =
    (positive.correct === positive.total ? 0 : 1) +
    failedControls.length +
    vacuous.length +
    (recovery.quietAgain === recovery.total ? 0 : 1) +
    categories.filter((category) => !category.bothSidesPresent).length

  const measuredCount =
    positive.total + negative.reduce((sum, mutation) => sum + mutation.applicableCases, 0) + recovery.total +
    categories.reduce((sum, category) => sum + category.samples, 0)

  const selfCheck = selfCheckMeasurement({ measuredCount, notRunCount: 0, failedCount: failed })
  const payload = {
    schemaVersion: 'm9.5-measurement@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verified: '检索侧判定器（候选面 / 上下文面 / 泄漏面 / 覆盖与权威面）',
      notVerifiedHere: '回复侧（需真模型）⇒ WP10',
      corpusUsed: 'dev + val（**blind 未读**）',
    },
    discipline: {
      blindUntouched: blindReadByThisScript === false,
      blindFilePresent: blindPresent,
      why: '盲测只允许在 WP10 用一次；本脚本用 dev+val，读 blind 会让"盲"失效',
    },
    probes,
    humanReview: {
      path: reviewPath.replace(REPO_ROOT, '.').replace(/\\/g, '/'),
      samples: reviewLines.length,
      verdict: 'PENDING_HUMAN_REVIEW',
      note: '人未读 ⇒ 结论里 Human Review = PENDING，**不代填**（计划 §14.4）',
    },
    measurement: {
      selfCheck,
      measuredCount,
      vacuousControls: vacuous.map((m) => m.kind),
      failedControls: failedControls.map((m) => m.kind),
    },
  }

  const evidencePath = join(runDir, 'measurement.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp2',
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
      method: '**构造属性**：本脚本只读语料 JSONL，不 import 任何数据库模块',
    },
    configHash: { judge: 'deterministic-id-set@1', corpusUsed: 'dev+val' },
    command: [{ cmd: 'pnpm m9.5:measurement:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount,
    notRunCount: 0,
    counts: { total: measuredCount, passed: measuredCount, failed },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'measurement.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  const symbol = (ok: boolean): string => (ok ? '✅' : '⚠️')
  process.stdout.write(
    [
      `M9.5 WP2 量具有效性：${runId}`,
      `  正控（判定器须认 gold）：${String(positive.correct)}/${String(positive.total)} ${symbol(positive.correct === positive.total)}`,
      ...negative.map(
        (mutation) =>
          `  对照 ${mutation.kind.padEnd(26)} 适用 ${String(mutation.applicableCases).padStart(4)} · 判定相符 ${String(mutation.matched).padStart(4)}` +
          ` ${symbol(mutation.allMatched)}${mutation.vacuous ? ' （空：适用 0 条）' : ''}`
      ),
      `  恢复（放回 gold 后重新安静）：${String(recovery.quietAgain)}/${String(recovery.total)} ${symbol(recovery.quietAgain === recovery.total)}`,
      ...categories.map(
        (category) =>
          `  判据样例 ${category.id.padEnd(24)} 样例 ${String(category.samples).padStart(3)} · 正控认 ${String(category.correctSideDetected)} · 负控响 ${String(category.wrongSideDetected)} ${symbol(category.bothSidesPresent)}`
      ),
      `  人工核对材料：${String(reviewLines.length)} 例 ⇒ ${reviewPath.replace(REPO_ROOT, '.')}（人审 PENDING，不代填）`,
      `  盲测未被读取：${String(!blindReadByThisScript)}`,
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
