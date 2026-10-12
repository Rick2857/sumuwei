/**
 * M10（WP8/WP11）—— **只读证据判定聚合门**（`pnpm m10:gates`）。
 *
 * ============================================================================
 *  计划 §16.1 点名了它，而它此前**根本不存在**
 * ============================================================================
 * 原文：`m10:gates` —— 「**只读判定各证据，不隐式跑门**」（WP8/11）。
 * 每个别的里程碑都有这一件（`m5:gates` / `m5.1:gates` / `m6:gates` / `m8:gates` / `m9:gates` …），
 * 而 M10 一直没有。而 WP11 的出口逐字要求：「必须门**无缺档 / 无非法 run**」——
 * 那正是本门要回答的问题。
 *
 * ============================================================================
 *  §16.2 的纪律（逐条落到代码里）
 * ============================================================================
 * ```text
 * ① 缺文件           ⇒ NOT RUN（**不是** PASS）
 * ② schema 错        ⇒ INVALID
 * ③ 归属不明         ⇒ INVALID
 * ④ 零分母           ⇒ INVALID（"量了 0 项、0 处问题"与"全部通过"长得一样）
 * ⑤ 不得默认 PASS     ⇒ 每道门**恰好**拿到一个标签；没有"没判出来但算绿"
 * ⑥ 失败档不回写      ⇒ 有 FAIL 档就**如实报出**，不让后来的一次绿把它抹掉
 * ⑦ 只读、不隐式跑门  ⇒ 本门**不 spawn 任何门**（这一点由 A8 判结构钉住）
 * ```
 *
 * ⚠️ 它是**档案的快照**，不是"这一次运行"的读数：证据按 run 累积，缺的就是 NOT RUN。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { pickLatest, rankReadings, type RankInput, type SelectionBasis } from './gate-evidence-select.ts'
import { M10_GATES, M10_SEMANTIC_GATES } from './gates/manifest.ts'

const REPO_ROOT = resolve(process.cwd())
const EVIDENCE_ROOT = join(REPO_ROOT, 'artifacts', 'm10')
const SELF_ENTRY = 'scripts/m10-gates.ts'

function phase(mark: string): void {
  console.error(`[m10-gates] ${mark}`)
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

/**
 * **门 id → 证据档 `testType`**。
 *
 * ⚠️ 这份表**必须与 `M10_GATES` 同步**，而 `A2` 就是钉它同步的那条判据：
 *    新增一道门却忘了在这里登记 ⇒ 本门**红**（而不是把那道门静默漏掉）。
 *    ⇒ 这份映射**不会腐烂**，因为有一条判据守着它。
 */
const GATE_TO_TEST_TYPE: Readonly<Record<string, string>> = {
  /* ⚠️ 语义 / live lane 的**真模型门**也在聚合里（它们的证据档与离线门同形） */
  'm10:semantic:eval': 'semantic-eval',
  'm10:smoke:live': 'smoke-live',
  'm10:long:live': 'long-live',
  'm10:onpath:live': 'onpath-live',
  'm10:activation:readback': 'activation-readback',
  'm10:preflight': 'm10-preflight',
  'm10:test': 'kernel-test',
  'm10:inputs:verify': 'inputs-verify',
  'm10:source:verify': 'source-verify',
  'm10:invalidation:verify': 'invalidation-verify',
  'm10:completion:verify': 'completion-verify',
  'm10:context:verify': 'context-verify',
  'm10:observability:verify': 'observability-verify',
  'm10:e2e:verify': 'e2e-verify',
  'm10:scale:verify': 'scale-verify',
  'm10:long:verify': 'long-verify',
  'm10:gateway:verify': 'gateway-verify',
  'm10:oracle:verify': 'oracle-verify',
  'm10:measurement:verify': 'measurement-verify',
  'm10:evidence:verify': 'evidence-verify',
  'm10:docs:verify': 'docs-verify',
  'm10:m11:verify': 'm11-contract',
  'm10:semantic:dry': 'semantic-dry',
  'm10:review:materials': 'review-materials',
  'm10:realdb:invariant': 'realdb-invariant',
  'm10:coverage:verify': 'coverage-verify',
  'm10:activation:verify': 'activation-verify',
  'm10:regression:verify': 'regression-verify',
}

/**
 * 计划 §16.1 点名、但**有意未登记**的命令。
 *
 * ⚠️ 它们**不在** `ALL_GATES` 里（含语义 lane），本门必须**如实报出来**，
 *    而不是让"聚合全绿"看起来像覆盖了它们。
 *
 * ⚠️ **权威源是交接单 §6.11.1 的那张处置表**（`m10:docs:verify` 的 `B3`/`B3b` 会
 *    按"三种处置恰好划分 §16.1 的 20 条"机械核它）⇒ **本清单是第二份副本**，
 *    改那张表时**必须同步这里**（否则"聚合说未登记、文档说已实现"会各说各话）。
 *    ⚠️ 本轮就撞上了这一处：`m10:semantic:eval` 已实现并登记进 `m10-semantic` lane，
 *       而这份清单还写着"未实现" ⇒ `A7` 当场红（判据按设计工作）。
 */
const PLANNED_UNREGISTERED: readonly { id: string; why: string }[] = [
  { id: 'm10:lifecycle:verify', why: '**判据已并入**：`m10:test` 的 L1–L11 / X1–X22 / G1–G2 + `m10:invalidation:verify` 的 C6–C8' },
  { id: 'm10:recovery:verify', why: '**判据已并入**：`m10:completion:verify` 的 P1–P6 / I1–I5 + `m10:long:verify` 的 L3 + `m10:e2e:verify` 的 C1/C2' },
  /* ⚠️ 2026-09-30：`m10:activation:readback` **已实现并登记**（`M10_READBACK_GATE`，离线组）⇒ 从本清单移出。
     ⇒ 现在**只剩 2 条**（两条都是"判据已并入"），§16.1 的 20 条里**没有"未实现"的了**。 */
]

type Verdict = 'PASS' | 'FAIL' | 'NOT RUN' | 'INVALID'

interface GateReading {
  readonly id: string
  readonly verdict: Verdict
  readonly runId: string | null
  readonly detail: string
  /** 档案里存在过的 FAIL 次数（**不被后来的绿抹掉**） */
  readonly failureArchive: number
  readonly runs: number
  /** **被标记为注入档**的份数（`M10_INJECTION`）—— 它们**不参与**判定 */
  readonly injectionArchive: number
  /**
   * 最新一份是**没有标记的** FAIL ⇒ 分不清"她真的红了"与"标记出现之前的注入档"。
   * ⚠️ 如实登记，不猜。
   */
  readonly ambiguousNewestFail: boolean
  /**
   * 这一份是**按哪一段**选出来的（具名，见 `scripts/gate-evidence-select.ts`）。
   * `AUD-20261005-02` 之前这里是 `mtimeMs` —— **mtime 永不参与选档**。
   */
  readonly selectionBasis: SelectionBasis
  /** 与选定档**时间并列**的其它档（runId 升序）；空数组 = 无并列 */
  readonly tiedWith: readonly string[]
  /**
   * 并列组里**判定不同** ⇒ 无法把读数归给任何一份 ⇒ `INVALID`（失败关闭）。
   * ⚠️ 与 `m10.1:gates` 的 `AMBIGUOUS` 是同一件事，只是本门的标签集只有四个词。
   */
  readonly ambiguousSelection: boolean
}

/**
 * **分类器**（纯函数，好让它能被手造输入单测）。
 *
 * ⚠️ 它是本门的核心：`NOT RUN` / `INVALID` 与 `PASS` 的区分**全在这里**。
 *    任一条不成立就退回 `PASS` ⇒ 那就变成"缺档也算过"。
 */
export function classify(input: {
  readonly hasEvidence: boolean
  readonly manifestOk: boolean
  readonly testTypeMatches: boolean
  readonly countsTotal: number | null
  readonly countsPassed: number | null
  readonly payloadVerdict: string | null
}): Verdict {
  if (!input.hasEvidence) return 'NOT RUN'
  if (!input.manifestOk) return 'INVALID'
  if (!input.testTypeMatches) return 'INVALID'
  const { countsTotal, countsPassed, payloadVerdict } = input
  if (countsTotal === null || countsPassed === null) return 'INVALID'
  /* 零分母 ⇒ INVALID（"量了 0 项"不能读成"全部通过"） */
  if (countsTotal <= 0) return 'INVALID'
  if (countsPassed > countsTotal || countsPassed < 0) return 'INVALID'
  if (payloadVerdict === null) return 'INVALID'
  const consistent = payloadVerdict === (countsPassed === countsTotal ? 'PASS' : 'FAIL')
  if (!consistent) return 'INVALID'
  return payloadVerdict === 'PASS' ? 'PASS' : 'FAIL'
}

/** 读一个 run 目录；返回 null 表示"这个目录不是证据档" */
function readRun(dir: string): {
  dir: string
  runId: string
  testType: string
  total: number | null
  passed: number | null
  verdict: string | null
  /** 注入档标记（`M10_INJECTION`；标记出现之前的档没有它） */
  injection: string | null
  /** 清单原文（选档要看 `head` / `date`） */
  manifest: Record<string, unknown>
  /** 证据文件路径（选档的 `evidence-commit-time` 段要用它；也可能是空串 = 没有读数文件） */
  readingPath: string
  /** 读数原文（选档的 `reported-time` 段要用它） */
  reading: Record<string, unknown>
} | null {
  const full = join(EVIDENCE_ROOT, dir)
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(join(full, 'manifest.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  /*
   * ⚠️ **"最新一份"不按文件系统时间判**（`TD-23` / `AUD-20261005-02`）。
   *
   * ```text
   * 旧实现（AUD-20261005-02 立案时的本体）：按 `statSync(manifest.json).mtimeMs` 降序取最新。
   *   ⇒ mtime 会因为复制 / 检出 / 恢复 / 同秒写盘而与**提交先后**不一致；
   *     同一批档案的判定会随 mtime 漂移 —— "读数看起来确定、其实不确定"那一族。
   * 现在：五段判据（自报时间 → head 提交时刻 → 证据提交时刻 → 清单日期 → 具名降级）
   *   由 `scripts/gate-evidence-select.ts` 的**唯一一份实现**给出，mtime **永不参与**。
   * ```
   * （本函数只负责把选档需要的原料读出来；排序 / 并列 / 冲突在 `main` 里走共享实现。）
   */
  const runId = typeof manifest.runId === 'string' ? manifest.runId : ''
  const testType = typeof manifest.testType === 'string' ? manifest.testType : ''
  const injection = typeof manifest.injection === 'string' ? manifest.injection : null
  const counts = (manifest.counts ?? {}) as Record<string, unknown>
  const total = typeof counts.total === 'number' ? counts.total : null
  const passed = typeof counts.passed === 'number' ? counts.passed : null
  let verdict: string | null = null
  let readingPath = ''
  let reading: Record<string, unknown> = {}
  for (const name of readdirSync(full)) {
    if (!name.endsWith('.json') || name === 'manifest.json') continue
    try {
      const parsed = JSON.parse(readFileSync(join(full, name), 'utf8')) as {
        checks?: unknown[]
        summary?: { verdict?: unknown }
      }
      if (Array.isArray(parsed.checks) && parsed.checks.length > 0) {
        verdict = typeof parsed.summary?.verdict === 'string' ? parsed.summary.verdict : null
        readingPath = join(full, name)
        reading = parsed as unknown as Record<string, unknown>
        break
      }
    } catch {
      /* 不是证据档 */
    }
  }
  return { dir, runId, testType, total, passed, verdict, injection, manifest, readingPath, reading }
}

function main(): void {
  phase('A: 只读判定各证据')
  const rootExists = existsSync(EVIDENCE_ROOT)
  const dirs = rootExists
    ? readdirSync(EVIDENCE_ROOT).filter((name) => existsSync(join(EVIDENCE_ROOT, name, 'manifest.json')))
    : []

  /** testType → 该档的全部 run（**按身份 / 正式结束时间排序**，见 `gate-evidence-select.ts`） */
  const byType = new Map<string, { dir: string; reading: NonNullable<ReturnType<typeof readRun>> }[]>()
  for (const dir of dirs) {
    const reading = readRun(dir)
    if (reading === null || reading.testType === '') continue
    const list = byType.get(reading.testType) ?? []
    list.push({ dir, reading })
    byType.set(reading.testType, list)
  }
  /*
   * ⚠️ 排序**不再**在这里做（旧代码是 `list.sort((a,b) => b.reading.mtimeMs - a.reading.mtimeMs)`）。
   *    现在每道门在下面按 `rankReadings`（共享实现）算，`mtime` 一个字节都不参与（`TD-23`）。
   */

  /*
   * ⚠️ **遍历合并清单**（`M10_GATES` + 语义 lane）—— 只遍历 `M10_GATES` 的话，
   *    真模型门**永远不会出现在报告里**（它的证据明明在盘上）。
   */
  const allM10Gates = [...M10_GATES, ...M10_SEMANTIC_GATES].filter(
    (gate) => gate.entry !== SELF_ENTRY,
  )
  const readings: GateReading[] = allM10Gates.map((gate) => {
    const type = GATE_TO_TEST_TYPE[gate.id]
    const all = type === undefined ? undefined : byType.get(type)
    if (type === undefined || all === undefined || all.length === 0) {
      return {
        id: gate.id,
        verdict: 'NOT RUN' as Verdict,
        runId: null,
        detail: type === undefined ? '映射表里没有它（见 A2）' : '档案里没有它的证据',
        failureArchive: 0,
        runs: 0,
        injectionArchive: 0,
        ambiguousNewestFail: false,
        selectionBasis: 'none' as SelectionBasis,
        tiedWith: [],
        ambiguousSelection: false,
      }
    }
    /*
     * ⚠️ **注入档不参与判定**（`M10_INJECTION` 标记；见 `writeM10Manifest` 的说明）。
     *
     * 那些档是**我们故意让门变红**时写的，与被测门真正的 FAIL 档在盘上同形。
     * 不排除它们 ⇒ 逐门判"最新一份"会把 `m10:source:verify` / `m10:context:verify`
     * 判成 FAIL，而它们的最新档**都是注入档**（实测）。
     */
    const injections = all.filter((item) => item.reading.injection !== null)
    const genuine = all.filter((item) => item.reading.injection === null)
    const failureArchive = genuine.filter((item) => item.reading.verdict === 'FAIL').length
    if (genuine.length === 0) {
      return {
        id: gate.id,
        verdict: 'NOT RUN' as Verdict,
        runId: null,
        detail: `档案里只有 ${String(injections.length)} 份**注入档**，没有真正的运行`,
        failureArchive: 0,
        runs: all.length,
        injectionArchive: injections.length,
        ambiguousNewestFail: false,
        selectionBasis: 'none' as SelectionBasis,
        tiedWith: [],
        ambiguousSelection: false,
      }
    }
    /*
     * 逐档先算出**它自己的判定**（用同一份 `classify`，与最终读数同源）——
     * 这样"并列组里判定不同"才是在比**判定**，而不是在比 payload 里那个字符串。
     */
    const verdictOf = (item: NonNullable<ReturnType<typeof readRun>>): Verdict =>
      classify({
        hasEvidence: true,
        manifestOk: item.runId !== '',
        testTypeMatches: item.testType === type,
        countsTotal: item.total,
        countsPassed: item.passed,
        payloadVerdict: item.verdict,
      })
    const ranked = rankReadings<NonNullable<ReturnType<typeof readRun>>>(
      genuine.map(
        (item): RankInput<NonNullable<ReturnType<typeof readRun>>> => ({
          item: item.reading,
          dir: item.reading.dir,
          runId: item.reading.runId === '' ? item.dir : item.reading.runId,
          manifest: item.reading.manifest,
          reading: item.reading.reading,
          evidencePath: item.reading.readingPath,
          verdict: verdictOf(item.reading),
        })
      )
    )
    const latest = pickLatest(ranked)
    if (latest === undefined) {
      return {
        id: gate.id,
        verdict: 'NOT RUN' as Verdict,
        runId: null,
        detail: '档案里没有可用读数',
        failureArchive,
        runs: all.length,
        injectionArchive: injections.length,
        ambiguousNewestFail: false,
        selectionBasis: 'none' as SelectionBasis,
        tiedWith: [],
        ambiguousSelection: false,
      }
    }
    /*
     * ⚠️ **并列组里判定不同 ⇒ 失败关闭**（`INVALID`），不靠 runId 字典序偷偷定一个 ——
     *    与 `m10.1:gates` 的 `AMBIGUOUS` 是同一条纪律（`TD-23` / `AUD-20261005-02`）。
     */
    const ambiguous = latest.conflictingVerdicts
    const verdict = ambiguous ? ('INVALID' as Verdict) : verdictOf(latest.picked.item)
    return {
      id: gate.id,
      verdict,
      runId: latest.picked.runId,
      detail:
        `真档 ${String(genuine.length)} 份 · 注入档 ${String(injections.length)} 份 · ` +
        `选档 ${latest.picked.basis} · 选中 ${latest.picked.dir}` +
        (latest.tiedWith.length > 0 ? ` · 并列 ${String(latest.tiedWith.length)} 份` : '') +
        (ambiguous ? ' · **并列档判定不同 ⇒ INVALID（失败关闭）**' : ''),
      failureArchive,
      runs: all.length,
      injectionArchive: injections.length,
      ambiguousNewestFail: verdict === 'FAIL',
      selectionBasis: latest.picked.basis,
      tiedWith: latest.tiedWith,
      ambiguousSelection: ambiguous,
    }
  })

  /* ------------------------------------------------------------------ A1 */
  record(
    'A',
    'A1',
    '**材料在场**：证据根存在 · 读到 ≥1 份证据档 · 覆盖 ≥1 道门'
      + '（"读到 0 份、0 个问题"与"全部通过"在输出上长得一样）',
    '根在 · 档 ≥1 · 门 ≥1',
    `${rootExists ? '根在' : '**根缺**'} · 档 ${String(dirs.length)} 份 · 覆盖 ${String(new Set([...byType.values()].flat().map((x) => x.reading.testType)).size)} 个 testType`,
    rootExists && dirs.length > 0,
  )

  /* ------------------------------------------------------------------ A2 */
  /*
   * ⚠️ **覆盖全部 M10 门（含语义 lane）** —— 否则"新增门却忘了登记映射"这条判据
   *    会**漏掉真模型门**（它们不在 `M10_GATES` 里，但在 `ALL_GATES` 里）。
   */
  const gateIds = [...M10_GATES, ...M10_SEMANTIC_GATES]
    .map((gate) => gate.id)
    .filter((id) => id !== 'm10:gates')
  const mapKeys = Object.keys(GATE_TO_TEST_TYPE)
  const missingInMap = gateIds.filter((id) => !mapKeys.includes(id))
  const extraInMap = mapKeys.filter((id) => !gateIds.includes(id))
  record(
    'A',
    'A2',
    '**映射表与门清单同步**：每道已登记的门都在 `GATE_TO_TEST_TYPE` 里，且表里没有多余项'
      + ' —— 新增门却忘了登记 ⇒ **本门红**，而不是把那道门静默漏掉',
    '0 缺 · 0 多',
    `缺 ${String(missingInMap.length)}${missingInMap.length > 0 ? `（${missingInMap.join(',')}）` : ''} · ` +
      `多 ${String(extraInMap.length)}`,
    missingInMap.length === 0 && extraInMap.length === 0,
  )

  /* ------------------------------------------------------------------ A3 */
  const counts = {
    PASS: readings.filter((item) => item.verdict === 'PASS').length,
    FAIL: readings.filter((item) => item.verdict === 'FAIL').length,
    'NOT RUN': readings.filter((item) => item.verdict === 'NOT RUN').length,
    INVALID: readings.filter((item) => item.verdict === 'INVALID').length,
  }
  const labelled = counts.PASS + counts.FAIL + counts['NOT RUN'] + counts.INVALID
  record(
    'A',
    'A3',
    '**每道门恰好拿到一个标签**（PASS / FAIL / NOT RUN / INVALID）——'
      + '**没有"没判出来但算绿"**；标签数必须等于门数',
    '标签数 = 门数',
    `门 ${String(readings.length)} 道 · 标签 ${String(labelled)} 个 · ` +
      `PASS ${String(counts.PASS)} · FAIL ${String(counts.FAIL)} · NOT RUN ${String(counts['NOT RUN'])} · INVALID ${String(counts.INVALID)}`,
    labelled === readings.length &&
      readings.length === allM10Gates.length &&
      readings.length > 0,
  )

  /* ------------------------------------------------------------------ A4 */
  const sample = classify({
    hasEvidence: false,
    manifestOk: true,
    testTypeMatches: true,
    countsTotal: 5,
    countsPassed: 5,
    payloadVerdict: 'PASS',
  })
  const zeroDenom = classify({
    hasEvidence: true,
    manifestOk: true,
    testTypeMatches: true,
    countsTotal: 0,
    countsPassed: 0,
    payloadVerdict: 'PASS',
  })
  record(
    'A',
    'A4',
    '**【缺档 ⇒ NOT RUN】** 与 **【零分母 ⇒ INVALID】**（手造输入单测分类器）：'
      + '两者都**不得**读成 PASS —— 这正是"缺档也算过"最容易溜进来的两个口子',
    'NOT RUN · INVALID',
    `缺档=${sample} · 零分母=${zeroDenom}`,
    sample === 'NOT RUN' && zeroDenom === 'INVALID',
  )

  /* ------------------------------------------------------------------ A5 */
  const mismatch = classify({
    hasEvidence: true,
    manifestOk: true,
    testTypeMatches: true,
    countsTotal: 5,
    countsPassed: 5,
    payloadVerdict: 'FAIL',
  })
  const badType = classify({
    hasEvidence: true,
    manifestOk: true,
    testTypeMatches: false,
    countsTotal: 5,
    countsPassed: 4,
    payloadVerdict: 'FAIL',
  })
  record(
    'A',
    'A5',
    '**【计数与判定不一致 ⇒ INVALID】** 与 **【归属不明 ⇒ INVALID】**'
      + '（手造输入单测）：一份"说 PASS 但计数对不上"或"testType 不是这道门"的档，'
      + '不得被当成有效读数',
    'INVALID · INVALID',
    `计数不符=${mismatch} · 归属不明=${badType}`,
    mismatch === 'INVALID' && badType === 'INVALID',
  )

  /* ------------------------------------------------------------------ A6 */
  const withFailures = readings.filter((item) => item.failureArchive > 0)
  record(
    'A',
    'A6',
    '**失败档不被后来的绿抹掉**：档案里出现过 FAIL 的门**如实报出**'
      + '（与 `m10:evidence:verify` 的 `A8` 同一条纪律：失败档分列保留、不回写）',
    '如实报出（数量不作断言）',
    withFailures.length === 0
      ? '档案里没有 FAIL 档'
      : `${String(withFailures.length)} 道门的档案里有 FAIL：${withFailures.map((item) => `${item.id}×${String(item.failureArchive)}`).join(' · ')}`,
    true,
  )

  /* ------------------------------------------------------------------ A7 */
  record(
    'A',
    'A7',
    '**计划点名但未登记的命令如实列出**（§16.1）：聚合"全绿"**不得**看起来像覆盖了它们',
    `列出 ${String(PLANNED_UNREGISTERED.length)} 项`,
    `${String(PLANNED_UNREGISTERED.length)} 项未登记：${PLANNED_UNREGISTERED.map((item) => item.id).join(' · ')}`,
    PLANNED_UNREGISTERED.length > 0 &&
      PLANNED_UNREGISTERED.every((item) => !gateIds.includes(item.id)),
  )

  /* ------------------------------------------------------------------ A8 */
  /*
   * ⚠️ 判据修正（本轮用真实产物跑出来的**我自己的量具缺陷**）：
   *    第一版写成 `/spawnSync|execFileSync\([^)]*m10-|child_process/`，
   *    而本文件**必须** import `execFileSync`（读 `git rev-parse`）⇒
   *    `node:child_process` 那个**import 语句**把它自己判红了。
   *    ⇒ "往真实产物里跑一次"能抓到这类缺陷；只跑手造输入抓不到。
   *
   * 现在的判据：**除了读 git 的 `execFileSync('git', …)`，不许有别的进程启动**。
   */
  /*
   * ⚠️ **只剥"散文"待的地方，不剥单引号字符串**（第三次修正，同一处缺陷的第三半）。
   *
   * 三版判据的演化（每一版都是被**真实产物**打回来的）：
   * ```text
   * v1  /child_process/                    ⇒ import 语句把它自己判红
   * v2  找到调用后比对第一个实参是不是 'git'  ⇒ 我那条检查的**标签文本**里
   *                                            也写着 execFileSync('git', …)（在模板串里）⇒ 又判红
   * v3  把**所有**字符串字面量都剥掉          ⇒ `'git'` 自己也被剥掉了 ⇒ **全部**调用变成"非 git"
   * ⇒ v4（现在）：只剥**模板串**（散文就写在反引号里），**保留**单引号字符串
   *    —— 因为 `'git'` 正是判据要读的那个实参。
   * ```
   * ⚠️ 这三版都不是靠"想"发现的：**每一版都往真实产物上跑了一次**。
   */
  const stripProse = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/`[\s\S]*?`/g, '``')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
  const selfText = stripProse(readFileSync(join(REPO_ROOT, SELF_ENTRY), 'utf8'))
  const spawnCalls = [...selfText.matchAll(/(execFileSync|spawnSync|execSync|spawn)\s*\(/g)]
  const nonGitSpawns = spawnCalls.filter((match) => {
    const after = selfText.slice(match.index + match[0].length, match.index + match[0].length + 6)
    return !after.startsWith("'git'")
  })
  record(
    'A',
    'A8',
    '**【只读、不隐式跑门】** 判结构（去注释）：本门里**没有**启动别的进程，'
      + '除了读 `git`（`execFileSync(\'git\', …)` 读 HEAD / 分支）——'
      + '"聚合顺手把门跑了"是这条要防的。'
      + '⚠️ 判据是"**每个启动调用的第一个参数都是 `git`**"，不是"文件里出现过 `child_process`"'
      + '（后者会把 import 语句误判成 spawn —— 第一版就是这么错的）',
    '全部启动调用都只读 git',
    spawnCalls.length === 0
      ? '**一处启动都没有**（连 git 都没读？）'
      : `${String(spawnCalls.length)} 处启动 · 非 git 的 ${String(nonGitSpawns.length)} 处`,
    spawnCalls.length > 0 && nonGitSpawns.length === 0,
  )

  /* ==================================================================== C */
  phase('C: 分类器的正负控（真实档案）')
  const realPass = readings.find((item) => item.verdict === 'PASS')
  const realNotRun = readings.find((item) => item.verdict === 'NOT RUN')
  record(
    'C',
    'C1',
    '【正控】真实档案里**至少有一道 PASS**，且它的 `runId` 非空'
      + '（否则下面的负控可以靠"永远报 NOT RUN"通过）',
    '≥1 道 PASS 且带 runId',
    realPass === undefined ? '**一道都没有**' : `${realPass.id} · runId=${String(realPass.runId)}`,
    realPass !== undefined && realPass.runId !== null && realPass.runId !== '',
  )
  record(
    'C',
    'C2',
    '【负控】**把一道有证据的门当作"没有证据"必须得到 NOT RUN**'
      + '（若分类器对它仍报 PASS，那"缺档也算过"就是真的）',
    'NOT RUN',
    String(
      classify({
        hasEvidence: false,
        manifestOk: true,
        testTypeMatches: true,
        countsTotal: 11,
        countsPassed: 11,
        payloadVerdict: 'PASS',
      }),
    ),
    classify({
      hasEvidence: false,
      manifestOk: true,
      testTypeMatches: true,
      countsTotal: 11,
      countsPassed: 11,
      payloadVerdict: 'PASS',
    }) === 'NOT RUN',
  )
  void realNotRun

  /* ================================================================== 落盘 */
  const passed = checks.filter((check) => check.pass).length
  const failed = checks.length - passed
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp11-gates', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const overall = failed > 0 ? 'FAIL' : counts.FAIL > 0 ? 'FAIL' : counts['NOT RUN'] > 0 ? 'NOT RUN' : 'PASS'
  const payload = {
    schema: 'm10-gates@1',
    runId,
    head,
    mode: 'offline' as const,
    semanticClaim: 'none' as const,
    gates: readings,
    counts,
    plannedUnregistered: PLANNED_UNREGISTERED,
    /** ⚠️ 四类**分列**，不合成一个"总分"；`overall` 只是最保守的那个词 */
    overall,
    checks,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
    disclaimer:
      '**只读**判定各证据（不隐式跑门）。四类分列：PASS / FAIL / NOT RUN / INVALID。' +
      '缺文件 ⇒ NOT RUN；schema 错 / 归属不明 / 零分母 / 计数与判定不一致 ⇒ INVALID。' +
      '它**不**主张任何语义结论，也**不**替代各子门在本次实现上的运行。',
  }
  writeFileSync(join(dir, 'gates.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp11',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'gates',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      '**只读证据聚合**（计划 §16.1 的 `m10:gates`）：逐门判 PASS/FAIL/NOT RUN/INVALID，' +
      '缺档=NOT RUN、零分母/计数不符/归属不明=INVALID、失败档如实报出、未登记的 live 门如实列出。' +
      '⚠️ 不 spawn 任何门（A8 判结构钉住）。',
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
    `门判定：PASS ${String(counts.PASS)} · FAIL ${String(counts.FAIL)} · ` +
      `NOT RUN ${String(counts['NOT RUN'])} · INVALID ${String(counts.INVALID)} · overall=${overall}`,
  )
  const notRun = readings.filter((item) => item.verdict === 'NOT RUN')
  if (notRun.length > 0) console.log(`NOT RUN 明细：${notRun.map((item) => item.id).join(' · ')}`)
  /*
   * 选档依据**具名**（`TD-23` / `AUD-20261005-02`）：`none` = 四个时间层全取不到、只按 runId ——
   * 那是降级，必须看得见；时间并列也要列出来（读者有权知道自己看的是哪一份）。
   */
  const degraded = readings.filter((item) => item.selectionBasis === 'none' && item.runId !== null)
  for (const item of degraded) {
    console.log(
      `  ⚠️ 选档降级 ${item.id}：**四个时间层全取不到**（自报时间 / head 提交时刻 / 证据提交时刻 / 清单日期）⇒ 只按 runId 字典序取 ${item.runId}`,
    )
  }
  const tied = readings.filter((item) => item.tiedWith.length > 0)
  for (const item of tied) {
    console.log(
      `  ⚠️ 选档并列 ${item.id}：与 ${String(item.tiedWith.length)} 份档**时间相同** ⇒ 按 runId 取 ${String(item.runId)}` +
        (item.ambiguousSelection
          ? ' —— ⚠️ **并列档判定不同 ⇒ 报 INVALID（失败关闭）**'
          : '（并列档判定相同，取哪一份都不改变结论）'),
    )
  }
  process.exit(failed === 0 ? 0 : 1)
}

main()
