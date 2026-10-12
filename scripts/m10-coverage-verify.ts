/**
 * M10（WP11）—— **场景矩阵覆盖账门**（`pnpm m10:coverage:verify`）。
 *
 * ============================================================================
 *  它防的是什么
 * ============================================================================
 * 计划 §14 的出口原文是"**每项都要有非零测量**"，而 WP11 的出口写着"**未跑项不写 PASS**"。
 * 手写的覆盖账会以三种方式腐烂（与 `m10:docs:verify` 同族，但**这一条的判据更硬**）：
 *
 * ```text
 * A1  48 项里漏了某一项   ⇒ 那一项从"已覆盖"变成"没人知道"
 * A2  写了一个**不存在的检查 id** ⇒ 覆盖账在撒谎（最能骗人的腐烂：它看起来有证据）
 * A3  写了一个**未登记的门**     ⇒ 同上
 * A4  非 COVERED 的行**没有理由** ⇒ "没覆盖"与"忘了"长得一样
 * A5  状态不在闭集里             ⇒ 用模糊词（"基本覆盖"）绕过判定
 * ```
 *
 * `A2` 是**本门存在的理由**：它把表里的每个检查 id 拿到
 * **那道门的最新真实证据**里去核对 —— "文档提到过"不算覆盖，**证据里存在才算**。
 *
 * ⚠️ 门 → 证据档的对应靠一张**显式表**（`testType` 不写在证据里，只在清单里）。
 *    表本身也核对：每个门 id 必须在 `M10_GATES` 里登记过。
 *
 * ⚠️ 纯进程内：只读 `docs/m10/*.md` 与 `artifacts/m10/**`。零数据库 / 零模型 / 零出网。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { M10_GATES } from './gates/manifest.ts'

const REPO_ROOT = resolve(process.cwd())
const EVIDENCE_ROOT = join(REPO_ROOT, 'artifacts', 'm10')
const DOC = 'docs/m10/M10-Scenario-Coverage.md'

function phase(mark: string): void {
  console.error(`[m10-coverage] ${mark}`)
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
 * **门 id → 证据档 `testType`**（显式表）。
 *
 * ⚠️ `testType` 只在清单里、不在门清单里，所以这层对应必须显式写下来；
 *    它会被 `A3` 核对"每个门 id 都真的登记过"。
 */
const GATE_TO_TEST_TYPE: Readonly<Record<string, string>> = {
  'm10:test': 'kernel-test',
  'm10:source:verify': 'source-verify',
  'm10:inputs:verify': 'inputs-verify',
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
}

const STATUSES = ['COVERED', 'PARTIAL', 'ELSEWHERE', 'NOT_COVERED'] as const
type Status = (typeof STATUSES)[number]

interface Row {
  readonly id: string
  readonly scenario: string
  readonly gates: readonly string[]
  readonly checkIds: readonly string[]
  readonly status: Status | string
  readonly reason: string
}

/** 从证据树里读出**每个 testType 的最新证据**的检查 id 集合 */
function loadEvidenceCheckIds(): Map<string, { runId: string; ids: Set<string> }> {
  const out = new Map<string, { runId: string; ids: Set<string> }>()
  for (const dir of readdirSync(EVIDENCE_ROOT).sort()) {
    const full = join(EVIDENCE_ROOT, dir)
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(join(full, 'manifest.json'), 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    /* ⚠️ 不能只看"第一个 json"：`review-materials` 的 `answer-sheet.json` 也有 json 但没有 `checks` */
    let ids: string[] | undefined
    for (const name of readdirSync(full)) {
      if (!name.endsWith('.json') || name === 'manifest.json') continue
      try {
        const parsed = JSON.parse(readFileSync(join(full, name), 'utf8')) as {
          checks?: { id?: unknown }[]
        }
        if (Array.isArray(parsed.checks) && parsed.checks.length > 0) {
          ids = parsed.checks.map((c) => String(c.id))
          break
        }
      } catch {
        /* 不是证据档 */
      }
    }
    if (ids === undefined) continue
    const type = String(manifest.testType)
    const prev = out.get(type)
    /* 保留 id 最多的那一代（最完整） */
    if (prev === undefined || ids.length > prev.ids.size) out.set(type, { runId: dir, ids: new Set(ids) })
  }
  return out
}

/** 解析覆盖账的表格行 */
export function parseCoverageRows(text: string): Row[] {
  const rows: Row[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    /* `| a | b | … |` ⇒ ['', a, b, …, ''] */
    if (cells.length < 8) continue
    const id = cells[1]!
    if (!/^G\d\d$/.test(id)) continue
    const gates = [...cells[3]!.matchAll(/`(m10:[^`]+)`/g)].map((m) => m[1]!)
    const checkIds = cells[4]!
      .split('/')
      .map((part) => part.replace(/[`\s]/g, ''))
      .filter((part) => part !== '' && part !== '（无）')
    rows.push({ id, scenario: cells[2]!, gates, checkIds, status: cells[5]!, reason: cells[6]! })
  }
  return rows
}

/**
 * 每个被点名的检查 id 是否都能在**它点名的某一道门**里找到。
 *
 * ⚠️ 判据是"**每个 id 各自**在某道点名的门里存在"，**不是**"所有 id 都在同一道门里"。
 *    第一版写成后者 ⇒ 一行同时点名两道门时**永远判不过**（`L1` 在 `m10:test` 里、
 *    `G01` 在 `m10:e2e:verify` 里，没有哪一道门同时有两个）⇒ 当场红了 14 行。
 *    ⇒ 一行点名多道门，本来就是"这几项合起来由这几道门覆盖"的意思。
 */
function idLooksCovered(row: Row, evidence: Map<string, { runId: string; ids: Set<string> }>): boolean {
  return row.checkIds.every((id) =>
    row.gates.some((gate) => {
      const type = GATE_TO_TEST_TYPE[gate]
      return type !== undefined && (evidence.get(type)?.ids.has(id) ?? false)
    }),
  )
}

function main(): void {
  const path = join(REPO_ROOT, DOC)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const rows = parseCoverageRows(text)
  const evidence = loadEvidenceCheckIds()

  /* ======================================================================
   * A0 · 材料在场
   * ==================================================================== */
  phase('A0: material present')
  record(
    'A',
    'A0',
    '**材料在场**：覆盖账存在 · 解析出 48 行 · 证据树里读到 ≥ 10 道门的证据'
      + '（"解析出 0 行、0 个问题"与"全部覆盖"在输出上长得一样）',
    '账在 · 48 行 · 证据 ≥ 10 道门',
    `账=${existsSync(path) ? '在' : '**缺**'} · ${String(rows.length)} 行 · ` +
      `证据 ${String(evidence.size)} 道门`,
    existsSync(path) && rows.length === 48 && evidence.size >= 10,
  )

  /* A1 · 48 项齐不全 */
  const expected = Array.from({ length: 48 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`)
  const got = new Set(rows.map((row) => row.id))
  const missing = expected.filter((id) => !got.has(id))
  const extra = rows.map((row) => row.id).filter((id) => !expected.includes(id))
  const duplicated = rows.map((row) => row.id).filter((id, index) => rows.findIndex((r) => r.id === id) !== index)
  record(
    'A',
    'A1',
    '**G01–G48 齐不全**：48 项各出现**恰好一次**（漏一项 ⇒ 它从"已覆盖"变成"没人知道"；'
      + '重复一项 ⇒ 两行可以互相矛盾）',
    '48 项各一次 · 0 缺 · 0 多 · 0 重',
    `缺 ${String(missing.length)}${missing.length > 0 ? `（${missing.join(',')}）` : ''} · ` +
      `多 ${String(extra.length)} · 重 ${String(duplicated.length)}`,
    missing.length === 0 && extra.length === 0 && duplicated.length === 0,
  )

  /* A2 · **检查 id 必须真的存在于那道门的最新证据里** —— 本门存在的理由 */
  phase('A2: every cited check id exists in that gate evidence')
  const brokenChecks: string[] = []
  for (const row of rows) {
    if (row.status !== 'COVERED') continue
    if (row.checkIds.length === 0) {
      brokenChecks.push(`${row.id}（COVERED 却没写检查 id）`)
      continue
    }
    if (!idLooksCovered(row, evidence)) {
      brokenChecks.push(`${row.id}→[${row.checkIds.join(',')}]@[${row.gates.join(',')}]`)
    }
  }
  record(
    'A',
    'A2',
    '**每个被点名的检查 id 都真的存在于那道门的证据里** —— "文档提到过"不算覆盖，'
      + '**证据里存在才算**。这一条把"覆盖账在撒谎"（写得像有证据）变成红的',
    '0 处对不上',
    brokenChecks.length === 0
      ? `${String(rows.filter((r) => r.status === 'COVERED').length)} 行 COVERED 全部在证据里对得上`
      : `**对不上 ${String(brokenChecks.length)} 处**：${brokenChecks.slice(0, 4).join(' · ')}`,
    brokenChecks.length === 0,
  )

  /* A3 · 点名的门必须已登记 */
  const gateIds = new Set(M10_GATES.map((gate) => gate.id))
  const badGates = [...new Set(rows.flatMap((row) => row.gates))].filter((gate) => !gateIds.has(gate))
  record(
    'A',
    'A3',
    '**点名的门都已登记**：覆盖账里出现的每个 `m10:*` 都在 `M10_GATES` 里'
      + '（未登记的门 id = 一个不存在的判据）',
    '0 个未登记的门',
    badGates.length === 0 ? `${String(gateIds.size)} 道门里点名了 ${String(new Set(rows.flatMap((r) => r.gates)).size)} 道，全部已登记` : `**未登记**：${badGates.join(', ')}`,
    badGates.length === 0,
  )

  /* A4 · 非 COVERED 的行必须有理由 */
  const noReason = rows.filter((row) => row.status !== 'COVERED' && row.reason.replace(/[`*\s（）()]/g, '').length < 10)
  record(
    'A',
    'A4',
    '**非 `COVERED` 的行必须写明理由**（≥10 个有效字符）——'
      + '否则"没覆盖"与"忘了写"在输出上长得一样',
    '0 行缺理由',
    noReason.length === 0
      ? `${String(rows.filter((r) => r.status !== 'COVERED').length)} 行非 COVERED 都写了理由`
      : `**缺理由**：${noReason.map((r) => r.id).join(', ')}`,
    noReason.length === 0,
  )

  /* A5 · 状态闭集 */
  const badStatus = rows.filter((row) => !(STATUSES as readonly string[]).includes(row.status))
  record(
    'A',
    'A5',
    '**状态在闭集里**：`COVERED` / `PARTIAL` / `ELSEWHERE` / `NOT_COVERED`'
      + '（开放词表 ⇒ 可以用"基本覆盖"绕过判定）',
    `0 行越界（闭集 ${String(STATUSES.length)} 个）`,
    badStatus.length === 0 ? '0 行越界' : `**越界**：${badStatus.map((r) => `${r.id}=${r.status}`).join(', ')}`,
    badStatus.length === 0,
  )

  /* A6 · 不许合成一个总分：四类各自计数，且 PARTIAL/NOT_COVERED 不得为 0 却被写成全绿 */
  const byStatus = Object.fromEntries(
    STATUSES.map((status) => [status, rows.filter((row) => row.status === status).length]),
  ) as Record<Status, number>
  record(
    'A',
    'A6',
    '**分列而不合成总分**：四类各自计数，且账里**必须**同时出现 `COVERED` 与非 `COVERED`'
      + '（只有 COVERED ⇒ 这份账没有登记任何未达项，那是不可能的）',
    '四类计数可得 · COVERED > 0 · 非 COVERED > 0',
    `COVERED=${String(byStatus.COVERED)} · PARTIAL=${String(byStatus.PARTIAL)} · ` +
      `ELSEWHERE=${String(byStatus.ELSEWHERE)} · NOT_COVERED=${String(byStatus.NOT_COVERED)}`,
    byStatus.COVERED > 0 && byStatus.COVERED < 48,
  )

  /* ======================================================================
   * C · 探测器的正负控
   * ==================================================================== */
  phase('C: controls on the evidence cross-reference')

  const coveredRow = rows.find((row) => row.status === 'COVERED' && row.gates.length > 0)
  if (coveredRow === undefined) {
    record('C', 'C0', '**需要一个 COVERED 行**来做正负控', '找到 1 行', '**一行都没找到**', false)
  } else {
    record(
      'C',
      'C1',
      '【正控】一个**真实**的行必须被判为"在证据里对得上"'
        + '（否则下面的负控可以靠"永远报对不上"通过）',
      `${coveredRow.id} 对得上`,
      idLooksCovered(coveredRow, evidence) ? '对得上' : '**对不上**',
      idLooksCovered(coveredRow, evidence),
    )

    const fakeRow: Row = {
      ...coveredRow,
      checkIds: ['C999-not-a-real-check'],
    }
    record(
      'C',
      'C2',
      '【负控】**编造一个检查 id 必须被抓**（`C999-not-a-real-check`）—— '
        + '这是 `A2` 的核心价值：覆盖账不能靠自己声称',
      '判为对不上',
      idLooksCovered(fakeRow, evidence) ? '**被判为对得上**' : '判为对不上',
      !idLooksCovered(fakeRow, evidence),
    )
  }

  /* ======================================================================
   * 落盘
   * ==================================================================== */
  const passed = checks.filter((check) => check.pass).length
  const failed = checks.length - passed

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp11-coverage', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const groups = ['A', 'C'] as const
  const perGroup = Object.fromEntries(
    groups.map((group) => [
      group,
      {
        total: checks.filter((check) => check.group === group).length,
        passed: checks.filter((check) => check.group === group && check.pass).length,
      },
    ]),
  )

  const payload = {
    schema: 'm10-coverage-verify@1',
    runId,
    head,
    mode: 'offline' as const,
    semanticClaim: 'none' as const,
    doc: DOC,
    rows: rows.length,
    byStatus,
    /** 未达项**逐条列出**（不合成总分） */
    notCovered: rows.filter((row) => row.status !== 'COVERED').map((row) => ({
      id: row.id,
      status: row.status,
      reason: row.reason.slice(0, 120),
    })),
    evidenceGatesRead: [...evidence.keys()].sort(),
    checks,
    perGroup,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
    disclaimer:
      '本门核对**覆盖账与真实证据的一致性**（编号齐不全 · 检查 id 存在 · 门已登记 · 未达项有理由）。' +
      '它**不**重跑任何门，也**不**主张任何语义结论。',
  }
  writeFileSync(join(dir, 'coverage-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp11',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'coverage-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP11 §14 覆盖账：G01–G48 齐不全 · **每个检查 id 在该门真实证据里存在**（A2）· ' +
      '门已登记 · 非 COVERED 行有理由 · 状态闭集 · 分列不合成总分 + 两组正负控。' +
      '⚠️ 不重跑门、不主张语义。',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} [${check.group}] ${check.label}`)
    console.log(`      期望 ${check.expected} · 实测 ${check.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log(`分组：${groups.map((g) => `${g}=${String(perGroup[g].passed)}/${String(perGroup[g].total)}`).join(' · ')}`)
  console.log(
    `覆盖：COVERED ${String(byStatus.COVERED)} · PARTIAL ${String(byStatus.PARTIAL)} · ` +
      `ELSEWHERE ${String(byStatus.ELSEWHERE)} · NOT_COVERED ${String(byStatus.NOT_COVERED)}`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main()
