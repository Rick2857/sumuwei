/**
 * Lv2 WP3 —— **量具有效性**（`lv2:measurement:verify`）。
 *
 * ============================================================================
 *  它回答什么（`AGENTS.md` §6.2 / §6.7 / §6.8 + 计划 §4 `LV2-G2`）
 * ============================================================================
 * 计划 `LV2-G2` 的必选出口逐字：
 *   「独立 oracle、语义评分、全分母、**源码适用性**、聚合规则 |
 *     每个硬门**正控 / 缺陷负控 / 恢复**成立；**恒空 / 全拒实现不能 PASS**；`measured_count > 0`」
 *
 * 而 `LV2-G2` 的第一句是"**量具自己也要被验证**"（`INV-M45-06`）。
 * Lv2 现在只有一个硬门（`lv2:core:verify`）和一套选档判据（`scripts/lv2-gate-select.ts`）——
 * 本门就是把这两样**放进三段式**：
 *
 * ```text
 * ① 量具的**判据内核**（选档 + 适用性）：合成夹具上，正控安静；
 *    注入 `TD-23` 的**原始缺陷**（按 mtime/目录名选档）⇒ 检测器**必须响**；
 *    放回真实现 ⇒ 重新安静。
 * ② **恒空 / 全拒 / 零分母 / 注入档 / 缺字段**都必须被拒（不能 PASS）。
 * ③ **清单契约**（`lv2-manifest@1`）：逐字段负控 —— 删掉哪一个就必须报哪一个（N/N 命中）。
 * ④ **源码适用性**：源指纹对不上 ⇒ 明确报 stale；`checked = 0` ⇒ 测量无效（不是 PASS）。
 * ```
 *
 * ⚠️ **零模型请求 · 零数据库 · 零出网**：全部在 `mkdtemp` 的合成夹具 + 只读真实证据上完成。
 * ⚠️ 夹具**不写进 `artifacts/lv2/`**：它只读那里的真实 run（正控），绝不污染正式证据目录。
 *
 * 用法：`pnpm lv2:measurement:verify`
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sealManifest } from './m6.1-evidence.ts'
import { freshnessOf, readLv2Runs, selectLatestFormalRun } from './lv2-gate-select.ts'
import {
  LV2_MANIFEST_REQUIRED_FIELDS,
  createLv2RunId,
  openLv2RunDir,
  validateLv2Manifest,
  writeLv2Manifest,
} from './lv2-evidence.ts'

interface Check {
  readonly id: string
  readonly phase: 'positive' | 'negative' | 'recovery' | 'self'
  readonly pass: boolean
  readonly expected: string
  readonly observed: unknown
}

const checks: Check[] = []
const record = (
  id: string,
  phase: Check['phase'],
  pass: boolean,
  expected: string,
  observed: unknown,
): void => {
  checks.push({ id, phase, pass, expected, observed })
}

/** 合成夹具用的"合法清单"（字段集与 `lv2-manifest@1` 逐条对齐）。 */
function fixtureManifest(fingerprintPath: string, fingerprint: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 'lv2-manifest@1',
    runId: 'lv2-wp9-fixture-20261002-0123456789ab-0001',
    wp: 'wp9-fixture',
    head: '0'.repeat(40),
    headShort: '0123456789ab',
    branch: 'main',
    date: '20261002',
    toolVersions: { node: process.version },
    testType: 'fixture',
    counts: { total: 3, passed: 3, failed: 0 },
    phases: ['single'],
    supersedes: null,
    started: '2026-10-02T00:00:00.000Z',
    ended: '2026-10-02T00:00:01.000Z',
    worktree: { clean: true },
    sourceFingerprints: { [fingerprintPath]: fingerprint },
    config: { fixture: true },
    model: { providerKind: 'none' },
    requests: { planned: 0, actual: 0 },
    denominators: { fixture: 1 },
    correlations: { cases: 0, conversations: 0, requests: 0, traces: 0 },
    faultInjection: null,
    cleanClose: true,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: '夹具：未打开任何库' },
    verdict: 'PASS',
    ...overrides,
  }
}

/**
 * 注入的**缺陷选择器** —— 复刻 `TD-23` 量到的既有行为：
 * 按目录 **mtime** 排序、并列时按**目录名升序**打破，取最后一个。
 *
 * ⚠️ 它**只**存在于本门内部，作为负控的"假象"；产品代码里没有任何调用点。
 */
function defectiveMtimeSelector(runsParent: string): { selected: string | null; rule: string } {
  const rows = [] as { name: string; mtimeMs: number }[]
  for (const dir of readLv2Runs(runsParent)) rows.push({ name: dir.runId, mtimeMs: dir.mtimeMs })
  rows.sort((a, b) => (a.mtimeMs !== b.mtimeMs ? a.mtimeMs - b.mtimeMs : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const last = rows.at(-1)
  return { selected: last?.name ?? null, rule: 'mtime 升序 + 目录名升序，取最后一个（= TD-23 量到的行为）' }
}

function writeFixture(parent: string, runId: string, manifest: Record<string, unknown>): string {
  const dir = join(parent, runId)
  mkdirSync(dir, { recursive: false })
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(sealManifest(manifest), null, 2)}\n`, 'utf8')
  return dir
}

function main(): void {
  const started = new Date().toISOString()
  const root = process.cwd()
  const fixture = mkdtempSync(join(tmpdir(), 'lv2-measurement-'))
  const fixtureParent = join(fixture, 'artifacts', 'lv2')
  mkdirSync(fixtureParent, { recursive: true })
  const realPath = 'scripts/lv2-gate-select.ts'
  const realHash = createHash('sha256').update(readFileSync(join(root, realPath))).digest('hex')
  const runIdOf = (suffix: string): string => `lv2-wp9-fixture-20261002-0123456789ab-${suffix}`

  try {
    /* ---------------------------------------------------------------------
     * 夹具：五份候选 + 一份注入档 + 一份零分母档 + 一份缺 ended 档
     *   · runOld（FAIL，ended 更早）
     *   · runNew（PASS，ended 更晚）  ← **正确答案**
     *   · runZero（counts.total = 0 ⇒ 零分母）
     *   · runInjected（带 injection 标记）
     *   · runNoEnded（缺 ended）
     *   · runStale（指纹对不上，但选档上合法）
     * ------------------------------------------------------------------- */
    const dirOld = writeFixture(
      fixtureParent,
      runIdOf('ff01'),
      fixtureManifest(realPath, realHash, {
        runId: runIdOf('ff01'),
        verdict: 'FAIL',
        counts: { total: 3, passed: 2, failed: 1 },
        ended: '2026-10-02T00:00:01.000Z',
      }),
    )
    const dirNew = writeFixture(
      fixtureParent,
      runIdOf('aa02'),
      fixtureManifest(realPath, realHash, {
        runId: runIdOf('aa02'),
        verdict: 'PASS',
        ended: '2026-10-02T00:00:02.000Z',
      }),
    )
    const dirZero = writeFixture(
      fixtureParent,
      runIdOf('bb03'),
      fixtureManifest(realPath, realHash, {
        runId: runIdOf('bb03'),
        counts: { total: 0, passed: 0, failed: 0 },
        ended: '2026-10-02T00:00:03.000Z',
      }),
    )
    const dirInjected = writeFixture(
      fixtureParent,
      runIdOf('cc04'),
      fixtureManifest(realPath, realHash, {
        runId: runIdOf('cc04'),
        injection: 'M10_INJECTION-fixture',
        ended: '2026-10-02T00:00:04.000Z',
      }),
    )
    const noEndedManifest = fixtureManifest(realPath, realHash, { runId: runIdOf('dd05'), ended: undefined })
    delete (noEndedManifest as Record<string, unknown>).ended
    const dirNoEnded = writeFixture(fixtureParent, runIdOf('dd05'), noEndedManifest)
    const staleParent = join(fixture, 'stale', 'artifacts', 'lv2')
    mkdirSync(staleParent, { recursive: true })
    writeFixture(
      staleParent,
      runIdOf('ee06'),
      fixtureManifest(realPath, '0'.repeat(64), { runId: runIdOf('ee06'), ended: '2026-10-02T00:00:06.000Z' }),
    )

    /*
     * **关键一步**：把夹具里那几份目录的 mtime 压成**完全相同** ——
     * 这正是 `TD-23` 的现实条件（四份 200 轮真模型档 mtime 全等）：
     * 一旦时间戳并列，"谁是最新"就只剩**目录名顺序**这一个线索，
     * 而它与"谁更晚产生"**毫无关系**。
     */
    const tied = new Date('2026-10-02T00:00:00.000Z')
    for (const dir of [dirOld, dirNew, dirZero, dirInjected, dirNoEnded]) {
      utimesSync(dir, tied, tied)
    }

    /* ---------------------------------------------------------------------
     * ① 正控：真实现安静
     * ------------------------------------------------------------------- */
    const selection = selectLatestFormalRun(fixtureParent)
    record(
      'P1-selection-picks-newest-formal-by-identity',
      'positive',
      selection.selected?.runId === runIdOf('aa02'),
      `选中 ${runIdOf('aa02')}（ended 更晚的 PASS），而不是 mtime 并列时字典序最后的 ${runIdOf('ff01')}`,
      {
        selected: selection.selected?.runId ?? null,
        ended: selection.selected?.ended ?? null,
        eligible: selection.eligible.map((row) => row.runId),
        rule: selection.rule,
      },
    )
    const excludedIds = new Set(selection.excluded.map((row) => row.runId))
    record(
      'P2-ineligible-runs-excluded-with-named-reasons',
      'positive',
      [runIdOf('bb03'), runIdOf('cc04'), runIdOf('dd05')].every((id) => excludedIds.has(id)) &&
        selection.eligible.length === 2,
      '零分母 / 注入档 / 缺 ended 三类各被排除且给出具名理由；合格候选恰好 2 份',
      { excluded: selection.excluded, eligibleCount: selection.eligible.length },
    )

    const filtered = selectLatestFormalRun(fixtureParent, { wp: 'wp9-fixture' })
    record(
      'P6-wp-filter-limits-candidates',
      'positive',
      filtered.eligible.length === 2 && filtered.selected?.runId === runIdOf('aa02'),
      '限定 wp 后候选恰好是那两份合格 run，且仍选中 ended 更晚的那份',
      { eligible: filtered.eligible.map((row) => row.runId), selected: filtered.selected?.runId ?? null },
    )
    const emptySelection = selectLatestFormalRun(fixtureParent, { wp: 'no-such-gate' })
    record(
      'N6-empty-candidate-is-null-not-pass',
      'negative',
      emptySelection.selected === null && emptySelection.eligible.length === 0,
      '限定到不存在的门 ⇒ selected = null 且候选为空（调用方必须当 NOT RUN，不是 PASS）',
      { selected: emptySelection.selected, eligible: emptySelection.eligible.length, rule: emptySelection.rule },
    )

    /* ---------------------------------------------------------------------
     * ② 缺陷负控：注入 `TD-23` 的原始缺陷 ⇒ 检测器**必须响**
     * ------------------------------------------------------------------- */
    const defective = defectiveMtimeSelector(fixtureParent)
    record(
      'N1-defective-mtime-selector-is-detected',
      'negative',
      defective.selected === runIdOf('ff01') && defective.selected !== selection.selected?.runId,
      `缺陷选择器必须选中更早的 FAIL（${runIdOf('ff01')}），从而与真实现的答案不同 —— 证明这个检测器真的会响`,
      { defectiveSelected: defective.selected, correctSelected: selection.selected?.runId ?? null, rule: defective.rule },
    )

    /* ---------------------------------------------------------------------
     * ③ 恢复：放回真实现 ⇒ 重新安静
     * ------------------------------------------------------------------- */
    mkdirSync(join(fixtureParent, 'local'), { recursive: true })
    record(
      'P7-private-local-directory-is-not-a-formal-run',
      'positive',
      !readLv2Runs(fixtureParent).some(row => row.runId === 'local'),
      '私有正文目录 local 不参与正式 run 的清单完整性与选档；其它非法 run 仍拒收',
      { privateDirectory: 'local' },
    )
    const recovered = selectLatestFormalRun(fixtureParent)
    record(
      'R1-real-selector-quiet-again',
      'recovery',
      recovered.selected?.runId === runIdOf('aa02'),
      '恢复后仍选中 ended 更晚的那份（安静）',
      { selected: recovered.selected?.runId ?? null },
    )

    /* ---------------------------------------------------------------------
     * ④ 源码适用性：正控 + 负控 + `checked = 0`
     * ------------------------------------------------------------------- */
    const freshGood = freshnessOf(root, fixtureManifest(realPath, realHash, { runId: runIdOf('aa02') }))
    const freshBad = freshnessOf(root, readLv2Runs(staleParent)[0]?.manifest ?? null)
    record(
      'P3-freshness-positive',
      'positive',
      freshGood.fresh && freshGood.checked === 1 && freshGood.stale.length === 0,
      '指纹对得上 ⇒ fresh=true 且 checked=1',
      freshGood,
    )
    record(
      'N2-freshness-detects-stale-source',
      'negative',
      !freshBad.fresh && freshBad.checked === 1 && freshBad.stale.length === 1,
      '指纹对不上 ⇒ fresh=false 且 stale 里具名列出那一条',
      freshBad,
    )
    const freshEmpty = freshnessOf(root, fixtureManifest(realPath, realHash, { runId: runIdOf('aa02'), sourceFingerprints: {} }))
    record(
      'N3-empty-fingerprints-is-invalid-not-pass',
      'negative',
      !freshEmpty.fresh && freshEmpty.checked === 0,
      '零个指纹 ⇒ checked=0 且绝不报 fresh（"测了 0 项"不是"全部一致"）',
      freshEmpty,
    )

    /* ---------------------------------------------------------------------
     * ⑤ 清单契约：逐字段负控（对**已封**清单删字段，不再封 —— R-08 的教训）
     * ------------------------------------------------------------------- */
    const sealed = sealManifest(fixtureManifest(realPath, realHash, { runId: runIdOf('aa02') }))
    const baseProblems = validateLv2Manifest(sealed)
    record(
      'P4-manifest-contract-accepts-well-formed',
      'positive',
      baseProblems.length === 0,
      '合契约的清单 0 问题',
      { problems: baseProblems },
    )
    const fieldMisses: string[] = []
    for (const field of LV2_MANIFEST_REQUIRED_FIELDS) {
      const tampered = { ...sealed }
      delete tampered[field]
      const problems = validateLv2Manifest(tampered)
      if (!problems.some((problem) => problem.field === field)) fieldMisses.push(field)
    }
    record(
      'N4-manifest-field-negative-controls',
      'negative',
      fieldMisses.length === 0,
      `逐字段删掉 ${String(LV2_MANIFEST_REQUIRED_FIELDS.length)} 个必填字段，每一个都必须报出它自己（N/N 命中）`,
      { fieldsChecked: LV2_MANIFEST_REQUIRED_FIELDS.length, misses: fieldMisses },
    )
    const payloadTampered = { ...sealed, verdict: 'PASS-但被改过' }
    const tamperProblems = validateLv2Manifest(payloadTampered)
    record(
      'N5-manifest-payload-tamper-detected',
      'negative',
      tamperProblems.some((problem) => problem.field === 'payloadSha256'),
      '封完再改一个字段 ⇒ payloadSha256 不符必须被报出',
      { problems: tamperProblems },
    )

    /* ---------------------------------------------------------------------
     * ⑥ 真实证据（只读）：真实 run 全部可读，且选档与独立重算一致
     * ------------------------------------------------------------------- */
    const realParent = join(root, 'artifacts', 'lv2')
    const realRuns = readLv2Runs(realParent)
    const recomputed = realRuns
      .filter((row) => row.eligible)
      .slice()
      .sort((a, b) => Date.parse(b.ended ?? '') - Date.parse(a.ended ?? ''))
    const realSelection = selectLatestFormalRun(realParent)
    record(
      'P5-real-evidence-selection-matches-independent-recompute',
      'positive',
      realRuns.length >= 2 &&
        realRuns.every((row) => row.manifest !== null) &&
        realSelection.selected?.runId === recomputed[0]?.runId,
      '真实 artifacts/lv2 下 ≥2 份且清单都可解析；选档结果与独立重算（只看 ended）一致',
      {
        runs: realRuns.map((row) => ({ runId: row.runId, eligible: row.eligible, reasons: row.reasons, ended: row.ended, verdict: row.verdict })),
        selected: realSelection.selected?.runId ?? null,
      },
    )
    const newestFreshness = freshnessOf(root, realSelection.selected?.manifest ?? null)
    const newestZeroDenominator = (realSelection.selected?.counts?.total ?? 0) === 0
    record(
      'SELF-measured-count-and-denominators-positive',
      'self',
      checks.length >= 8 && newestFreshness.checked > 0 && !newestZeroDenominator,
      `门的检查数 ≥ 8（自检第 ${String(checks.length + 1)} 项）且最新真实 run 的源指纹项 > 0 且分母 > 0`,
      { checksRecorded: checks.length, newestRun: realSelection.selected?.runId ?? null, newestFreshness, newestZeroDenominator },
    )
    checks.push({
      id: 'READING-newest-real-run-freshness',
      phase: 'self',
      pass: true,
      expected: '（读数，不参与判定）最新真实候选 run 的源码适用性',
      observed: { runId: realSelection.selected?.runId ?? null, freshness: newestFreshness },
    })

    /* ---------------------------------------------------------------------
     * ⑦ **硬门自己的三段式**：注入 `R-29` 的缺陷 ⇒ `lv2:core:verify` 必须 FAIL
     *
     * 注入手法（与 M5.1.1 / M10 / M11 的 `*:measurement:verify` 同一条）：
     *   ① 先把目标源文件**逐字节**读进来（含 sha256）；
     *   ② 改一处**真实起作用**的判据（把 `commitment` 的可携带操作从 `['create']` 改成 `[]`
     *      —— 这正是 `R-29` 事故的效应：模型面再也表达不出一条承诺）；
     *   ③ 子进程跑 `lv2:core:verify`，带 `LV2_INJECTION` 标记 ⇒ 它写出的证据档**自带注入标记**，
     *      于是 `readLv2Runs` 会把它排除在正式候选之外（读者可以分列）；
     *   ④ `finally` 里**恢复原字节**，并断言 sha256 与改前**逐字相同**；
     *   ⑤ 再跑一次，确认门重新 PASS（"放回真实实现 ⇒ 重新安静"）。
     * ------------------------------------------------------------------- */
    const injectedPath = 'src/kernel/contracts/goal-proposal.ts'
    const injectedAbs = join(root, injectedPath)
    const originalBytes = readFileSync(injectedAbs)
    const originalSha = createHash('sha256').update(originalBytes).digest('hex')
    const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const runCoreGate = (label: string, injection?: string) => {
      const result = spawnSync(process.execPath, [tsxCli, 'scripts/lv2-core-verify.ts'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 32 * 1024 * 1024,
        env: injection === undefined ? process.env : { ...process.env, LV2_INJECTION: injection },
      })
      return { label, exitCode: result.status, injection: injection ?? null }
    }
    /** 找**带注入标记**的最新 run（正式候选里看不到它 —— 这是刻意的）。 */
    const newestInjectedRun = (): Record<string, unknown> | null => {
      const rows = readLv2Runs(realParent)
        .filter((row) => row.manifest !== null && 'injection' in row.manifest)
        .sort((a, b) => Date.parse(b.ended ?? '') - Date.parse(a.ended ?? ''))
      return rows[0]?.manifest ?? null
    }
    const positiveRun = runCoreGate('positive')
    record(
      'P7-hard-gate-positive-control',
      'positive',
      positiveRun.exitCode === 0,
      '真源码上 `lv2:core:verify` 必须 EXIT 0（安静）',
      positiveRun,
    )
    let defectRun: { label: string; exitCode: number | null; injection: string | null } | null = null
    let restoredSha = ''
    try {
      const patched = readFileSync(injectedAbs, 'utf8')
      const needle = "commitment: ['create'],"
      const occurrences = patched.split(needle).length - 1
      if (occurrences !== 1) throw new Error(`注入锚点不唯一：${String(occurrences)} 处（期望 1）`)
      writeFileSync(injectedAbs, patched.replace(needle, 'commitment: [],'), 'utf8')
      defectRun = runCoreGate('defect', 'R-29-effect-fixture')
    } finally {
      writeFileSync(injectedAbs, originalBytes)
      restoredSha = createHash('sha256').update(readFileSync(injectedAbs)).digest('hex')
    }
    const injectedManifest = newestInjectedRun()
    const injectedChecks = injectedManifest === null
      ? null
      : (JSON.parse(
          readFileSync(join(realParent, String(injectedManifest.runId), 'checks.json'), 'utf8'),
        ) as { checks: { id: string; pass: boolean }[] })
    const a1Failed = injectedChecks?.checks.find((check) => check.id.startsWith('A1'))?.pass === false
    record(
      'N7-hard-gate-defect-negative-control',
      'negative',
      defectRun?.exitCode === 1 && a1Failed && injectedManifest !== null && 'injection' in injectedManifest,
      '注入 R-29 的效应（`commitment` 不再可携带）⇒ `lv2:core:verify` 必须 EXIT 1 且 A1 正控失败；该证据档必须带注入标记',
      {
        defectRun,
        injectedRunId: injectedManifest?.runId ?? null,
        injectedVerdict: injectedManifest?.verdict ?? null,
        a1Failed,
      },
    )
    record(
      'N8-injected-run-excluded-from-formal-candidates',
      'negative',
      injectedManifest !== null &&
        selectLatestFormalRun(realParent, { wp: 'wp2-core' }).eligible.every(
          (row) => row.runId !== injectedManifest.runId,
        ),
      '带注入标记的档**不在**正式候选里（选档排除它），但原始读者仍能看到它',
      {
        injectedRunId: injectedManifest?.runId ?? null,
        formalCandidates: selectLatestFormalRun(realParent, { wp: 'wp2-core' }).eligible.map((row) => row.runId),
      },
    )
    record(
      'N9-injected-source-restored-byte-identical',
      'negative',
      restoredSha === originalSha,
      '恢复后源文件 sha256 与改前**逐字相同**',
      { path: injectedPath, before: originalSha, after: restoredSha },
    )
    const recoveryRun = runCoreGate('recovery')
    record(
      'R2-hard-gate-quiet-after-restore',
      'recovery',
      recoveryRun.exitCode === 0,
      '恢复后 `lv2:core:verify` 必须重新 EXIT 0（安静）',
      recoveryRun,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }

  /* 读数项（`READING-*`）不进判定 —— 它们是给人看的，不是判据 */
  const judged = checks.filter((check) => !check.id.startsWith('READING-'))
  const failed = judged.filter((check) => !check.pass)
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL'
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = createLv2RunId({ wpId: 'wp3-measurement', headShort: head })
  const dir = openLv2RunDir(root, runId)
  const worktreeLines = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .filter((line) => !line.slice(3).trim().split(/[\\/]/).join('/').startsWith('artifacts/lv2/'))
  writeFileSync(join(dir, 'checks.json'), `${JSON.stringify({ runId, checks }, null, 2)}\n`, 'utf8')
  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp3-measurement',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version, platform: process.platform },
    testType: 'measurement-validity',
    counts: { total: judged.length, passed: judged.length - failed.length, failed: failed.length },
    phases: ['positive', 'negative', 'recovery', 'self'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: { clean: worktreeLines.length === 0, lines: worktreeLines, note: '本门自己的 run 目录按白名单不计入' },
    sourceFingerprints: Object.fromEntries(
      (
        [
          'scripts/lv2-measurement-verify.ts',
          'scripts/lv2-gate-select.ts',
          'scripts/lv2-evidence.ts',
          'scripts/lv2-core-verify.ts',
          'scripts/m6.1-evidence.ts',
          'docs/lv2/Lv2-Acceptance-Plan.md',
          'docs/lv2/Lv2-WP1-Freeze-Record.md',
        ] as const
      ).map((path) => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]),
    ),
    config: { note: '本门不读 `.env` 的功能开关：它只做证据层与清单契约的判定', fixtureParent: '<mkdtemp，运行后删除>' },
    model: { providerKind: 'none', note: '零模型请求：本门不产任何对话' },
    requests: { planned: 0, actual: 0, note: '零模型请求' },
    denominators: {
      gateChecks: judged.length,
      positives: judged.filter((check) => check.phase === 'positive').length,
      negatives: judged.filter((check) => check.phase === 'negative').length,
      recoveries: judged.filter((check) => check.phase === 'recovery').length,
      manifestFieldsNegativeControlled: LV2_MANIFEST_REQUIRED_FIELDS.length,
      fixtureRuns: 6,
      realRunsRead: readLv2Runs(join(root, 'artifacts', 'lv2')).length,
      hardGateSubprocessRuns: 3,
    },
    correlations: { cases: judged.length, conversations: 0, requests: 0, traces: 0 },
    faultInjection:
      '两处：① 夹具内注入 `TD-23` 的原始缺陷选择器（mtime + 目录名）——只存在于本门内部；' +
      '② 子进程注入 `R-29` 的效应（把 `src/kernel/contracts/goal-proposal.ts` 的 `commitment: [\'create\']` 改成 `[]`）' +
      '⇒ 由 `lv2:core:verify` 带 `LV2_INJECTION=R-29-effect-fixture` 写出一份**带注入标记**的 FAIL 档，' +
      '随后逐字节恢复并断言 sha256 相同。产品代码里没有任何注入路径。',
    cleanClose: null,
    realDb: {
      opened: false,
      summaryBefore: null,
      summaryAfter: null,
      note: '本门不碰任何数据库（连隔离库都不建）⇒ 没有可关闭的连接',
    },
    verdict,
    limitation:
      '本门只验**证据层**：选档依据（身份 vs mtime）、清单契约、源码适用性、以及几类"必须被拒"的档。' +
      '它**不**验任何语义/行为门本身（那些要各自的语料与真模型档），也**不**主张既有里程碑的聚合器已被修复（`TD-23` 只要求 Lv2 自己的不继承该缺陷）。',
  })

  console.log(`[lv2:measurement] runId = ${runId}`)
  console.log(`[lv2:measurement] head  = ${head}`)
  for (const check of checks) {
    console.log(
      `  ${check.id.startsWith('READING-') ? '📖' : check.pass ? '✅' : '❌'} [${check.phase}] ${check.id.padEnd(52)} ${
        check.pass ? '' : `期望 ${check.expected} · 实测 ${JSON.stringify(check.observed)}`
      }`,
    )
  }
  console.log(`[lv2:measurement] 判定项 ${String(judged.length)} · 通过 ${String(judged.length - failed.length)} · 未通过 ${String(failed.length)}`)
  console.log(`[lv2:measurement] 模型请求 0 · 数据库未打开 · verdict = ${verdict}`)
  console.log(`[lv2:measurement] manifest = ${manifestPath.replace(root, '').split('\\').join('/').replace(/^\//, '')}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main()
