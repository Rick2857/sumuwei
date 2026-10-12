/**
 * M6 · WP4 —— **量具资格化门**（`pnpm m6:measurement:verify`）。
 *
 * ============================================================================
 *  它在回答什么
 * ============================================================================
 *  「M6 的那几个门**真的会响**吗？」—— 不是"跑一遍看着没问题"，而是：
 *  往每个检测器里**注入一个假象**，它必须**响**；放回真实输入，它必须**安静**。
 *
 *  计划书 §WP4 列的 **8 类注入**逐条处置（实现 / 部分实现 / N/A 必须给理由与归属）。
 *
 *  三段式（AGENTS §6.7，缺一不可），每条注入都跑满：
 *    正控：合法输入 ⇒ 检测器**安静**
 *    负控：注入假象 ⇒ 检测器**必须响**
 *    恢复：放回合法输入 ⇒ **重新安静**
 *
 *  另加两条量具自检（AGENTS §6.2/§6.8）：
 *    · 扫描范围非空（`measured_count > 0`）；
 *    · **N/A 必须带理由与归属**（否则"跳过"与"没测"看起来一样 —— 这正是注入 #1 的形态）。
 *
 * 用法：`pnpm m6:measurement:verify`（纯函数；不碰数据库、不跑模型、不跑搜索）
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import {
  M6_GATE_SPECS,
  M6_MANIFEST_REQUIRED_FIELDS,
  detectChosenButNotInjected,
  detectUnavailableWrittenAsZero,
  validateLongDialogueEvidence,
  validateManifest,
  validateRollupEvidence,
  type GateEvidenceProblem,
} from './m6-evidence.ts'
import { M6_SUITES, M6_LIVE_SUITES, auditSuiteScripts, evaluateLiveGuard, resolveSuiteSelection } from './m6-command-surface.ts'

// ---------------------------------------------------------------------------
// 报告骨架
// ---------------------------------------------------------------------------

const rows: { label: string; pass: boolean; detail?: string }[] = []
const measurements: { label: string; count: number; mustBePositive: boolean }[] = []
let failures = 0
let measurementInvalid = 0

function check(label: string, pass: boolean, detail?: string): void {
  if (!pass) failures += 1
  rows.push({ label, pass, ...(detail !== undefined ? { detail } : {}) })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
function measure(label: string, count: number, mustBePositive = true): void {
  if (mustBePositive && count <= 0) measurementInvalid += 1
  measurements.push({ label, count, mustBePositive })
  console.log(`  MEASURE ${label} = ${count}${mustBePositive && count <= 0 ? '  ← MEASUREMENT INVALID' : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const ROOT = resolve('.')

// ---------------------------------------------------------------------------
// 三段式骨架：正控 ⇒ 负控 ⇒ 恢复
// ---------------------------------------------------------------------------

let injectionsRun = 0
/** 负控里**真的响过**的问题码（用来证明"声明的覆盖"不是纸面声明） */
const firedCodes = new Set<string>()

/**
 * @param label 注入的名字
 * @param code  期望被触发的问题码
 * @param legal 合法输入
 * @param inject 假象
 * @param detect 被测检测器
 */
function threePhase<T>(input: {
  id: string
  label: string
  code: string
  legal: T
  inject: (legal: T) => T
  detect: (subject: T) => GateEvidenceProblem[]
}): void {
  injectionsRun += 1
  const legalProblems = input.detect(input.legal).map((p) => p.code)
  check(
    `${input.id} 正控：合法输入 ⇒ 检测器**安静**`,
    legalProblems.length === 0,
    legalProblems.join(',') || '（无问题）',
  )
  const injectedProblems = input.detect(input.inject(input.legal))
  const fired = injectedProblems.some((p) => p.code === input.code)
  if (fired) firedCodes.add(input.code)
  check(
    `${input.id} 负控：注入「${input.label}」⇒ 必须响`,
    fired,
    injectedProblems.map((p) => p.code).join(',') || '**没响** —— 这是假绿',
  )
  const restoredProblems = input.detect(input.legal).map((p) => p.code)
  check(
    `${input.id} 恢复：放回合法输入 ⇒ **重新安静**`,
    restoredProblems.length === 0,
    restoredProblems.join(',') || '（无问题）',
  )
}

// ---------------------------------------------------------------------------
// §0 量具自检
// ---------------------------------------------------------------------------

section('§0 量具自检 —— 扫描范围与登记表')

measure('§0 已登记的门数（范围自检）', M6_GATE_SPECS.length)
measure('§0 manifest 必填字段数（范围自检）', M6_MANIFEST_REQUIRED_FIELDS.length)
check(
  '§0-1 门登记表非空且每项都有 id / command / schemaVersion',
  M6_GATE_SPECS.length > 0 &&
    M6_GATE_SPECS.every(
      (spec) => spec.id.trim() !== '' && spec.command.trim() !== '' && spec.schemaVersion.trim() !== ''
    ),
  M6_GATE_SPECS.map((spec) => spec.id).join(', ')
)
check(
  '§0-2 schemaVersion 不重复（否则汇总会把两份证据算成一个门）',
  new Set(M6_GATE_SPECS.map((spec) => spec.schemaVersion)).size === M6_GATE_SPECS.length
)

// ---------------------------------------------------------------------------
// 合法输入（正控的基准）
// ---------------------------------------------------------------------------

function legalManifest(): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    runId: 'm6-wp4-fixture-20260921-abcdef123456',
    testType: 'fixture',
    head: 'abcdef1234567890abcdef1234567890abcdef12',
    codeCommit: 'abcdef1234567890abcdef1234567890abcdef12',
    runRelevantTreeSha: 'a'.repeat(64),
    workingTreeExceptions: [],
    commands: [{ cmd: 'pnpm exec tsx scripts/verify-m6-wp2-rollup.ts', exitCode: 0 }],
    toolVersions: { node: process.version },
    fixtureRubricThresholdHashes: { 'evals/fixtures/m3.5/prompt-baseline.txt': 'b'.repeat(64) },
    nonSecretConfigFingerprint: { keys: [] },
    startedAt: '2026-09-21T00:00:00.000Z',
    finishedAt: '2026-09-21T00:00:01.000Z',
    counts: { executed: 59, completed: 59, skipped: 0, failed: 0 },
    evidence: [{ path: 'artifacts/m6/x/rollup-unit.json', sha256: 'c'.repeat(64) }],
    sandboxIdentity: { opensDatabase: false },
    realDbProtection: { digestBefore: 'd'.repeat(64), measuredCount: 1205 },
    exclusions: ['.git/', 'node_modules/'],
  }
  return manifest
}

section('§1 注入清单（计划书 §WP4 的 8 类）')

// #1 0 条用例 / 退出码 0 但 skipped
threePhase({
  id: '#1',
  label: '0 条用例 / 退出码 0 但 skipped',
  code: 'manifest_zero_counts',
  legal: legalManifest(),
  inject: (legal) => ({ ...legal, counts: { executed: 0, completed: 0, skipped: 0, failed: 0 } }),
  detect: validateManifest,
})
threePhase({
  id: '#1b',
  label: '有跳过项却没有理由',
  code: 'manifest_skipped_silently',
  legal: legalManifest(),
  inject: (legal) => ({ ...legal, counts: { executed: 60, completed: 59, skipped: 1, failed: 0 } }),
  detect: validateManifest,
})

// #2 旧提交的结果 / 默认路径混淆
threePhase({
  id: '#2',
  label: '证据自称的 head 与 manifest 的 codeCommit 不一致（旧提交或默认路径的旧结果）',
  code: 'manifest_stale_commit',
  legal: legalManifest(),
  inject: (legal) => ({ ...legal, codeCommit: 'f'.repeat(40) }),
  detect: validateManifest,
})

// #3 / #4（后半）N/A：必须给理由与归属
const NOT_APPLICABLE = [
  {
    id: '#3',
    subject: '`expected=search` 的正例同时进入"禁止出站"集合',
    ownerGate: 'pnpm m5.5.1:measurement:verify（`scripts/m5.5.1-corpus-audit.ts` 是那份清单的唯一来源）',
    reason:
      '这是**搜索语料**的集合冲突判据，属于 M5.5.1 的量具；M6 的摘要语料里没有"禁止出站"这一类清单，' +
      '因此在这里实现它只会造出第二份清单（而"两处各一份"正是那条判据要防的事）。',
  },
  {
    id: '#4b',
    subject: '搜索调用与模型调用混为一个计数',
    ownerGate: 'pnpm m5.5.1:measurement:verify',
    reason:
      'M6 的离线证据**不产生任何出站调用**（摘要不调模型、不搜索），因此这里没有"两种调用"可混。' +
      '真实出站计数的判据在 M5.5.1 与 WP10b 的 Live 证据里。',
  },
  {
    id: '#8b',
    subject: '一次坏模型回复被重试后的好回复覆盖',
    ownerGate: 'WP10b 的 Live 证据（M6 的离线门不调用模型，没有"重试"这一动作）',
    reason:
      '离线证据里不存在"模型回复"与"重试"，因此这条注入在 M6 的**离线**量具上没有落点；' +
      '它必须在 WP10b 的 Live 证据上有落点（"故意丢弃失败轮次"这一半已经由 #8 覆盖）。',
  },
] as const

measure('§1 声明为 N/A 的注入条数（范围自检）', NOT_APPLICABLE.length, false)
check(
  '§1-1 每条 N/A **都给了理由与归属门**（不许静默跳过）',
  NOT_APPLICABLE.every((item) => item.reason.trim() !== '' && item.ownerGate.trim() !== ''),
  NOT_APPLICABLE.map((item) => item.id).join(', ')
)

// #4 前半：不可得却写成 0
threePhase({
  id: '#4a',
  label: '读数不可得却写成 0',
  code: 'unavailable_written_as_zero',
  legal: { reportedTokens: 0, tokensAvailable: true },
  inject: () => ({ reportedTokens: 0, tokensAvailable: false }),
  detect: detectUnavailableWrittenAsZero,
})

// #5 选了 ≠ 入模
threePhase({
  id: '#5',
  label: '已选择但被编译器裁掉，却仍被计为"实际入模"',
  code: 'chosen_but_not_injected',
  legal: { selectedCount: 3, sectionSurvived: true, claimedInjectedCount: 3 },
  inject: (legal) => ({ ...legal, sectionSurvived: false }),
  detect: detectChosenButNotInjected,
})

// #6 缺失正例 ⇒ "永远不摘要"也能过门
threePhase({
  id: '#6',
  label: '没有正例却报 PASS（"永远不摘要"就能满足这种门）',
  code: 'rollup_no_positive_example',
  legal: { verdict: 'PASS', passed: 27, failed: 0, measurementInvalid: 0, scope: {} },
  inject: () => ({ verdict: 'PASS', passed: 0, failed: 0, measurementInvalid: 0, scope: {} }),
  detect: validateRollupEvidence,
})

// #7 轮数不对 / 重复 turn
threePhase({
  id: '#7',
  label: '声称 500 轮但只有 50 个 turn',
  code: 'round_count_mismatch',
  legal: { claimedRounds: 50, observedTurnIds: Array.from({ length: 50 }, (_, i) => `t${i}`) },
  inject: () => ({ claimedRounds: 500, observedTurnIds: Array.from({ length: 50 }, (_, i) => `t${i}`) }),
  detect: validateLongDialogueEvidence,
})
threePhase({
  id: '#7b',
  label: '同一个 turn 出现两次（断点重复输入）',
  code: 'duplicate_turns',
  legal: { claimedRounds: 3, observedTurnIds: ['t1', 't2', 't3'] },
  inject: () => ({ claimedRounds: 3, observedTurnIds: ['t1', 't2', 't2'] }),
  detect: validateLongDialogueEvidence,
})

// #8 失败轮次被丢弃
threePhase({
  id: '#8',
  label: '尝试 5 次、完成 3 次、跳过 0、失败 0（2 次去哪了？）',
  code: 'manifest_failed_runs_dropped',
  legal: legalManifest(),
  inject: (legal) => ({ ...legal, counts: { executed: 5, completed: 3, skipped: 0, failed: 0 } }),
  detect: validateManifest,
})

// 反向自检：**合法输入必须安静**（防止检测器"什么都报"从而看似全能）
section('§2 反向自检 —— 合法输入必须整体安静')
const cleanProblems = validateManifest(legalManifest())
check(
  '§2-1 一份**完整且自洽**的 manifest ⇒ 零问题（检测器不是"什么都报"）',
  cleanProblems.length === 0,
  cleanProblems.map((p) => p.code).join(',') || '（无问题）'
)
check(
  '§2-2 manifest 必填字段数与 §9.2 的清单一致（清单本身也是判据）',
  M6_MANIFEST_REQUIRED_FIELDS.length === 16,
  `${M6_MANIFEST_REQUIRED_FIELDS.length} 个`
)

/*
 * 计划书 §WP4 的 8 类注入**逐条**有去处。
 *
 * ⚠️ 这条断言刻意放在**所有注入跑完之后**：第一版把它写在 §1 中间，
 *    于是它数的是"那时已跑了几条"——一个**自造的假红**（数量断言早于它要数的东西）。
 *    现在它读的是同一张表 + `firedCodes`（负控里**真的响过**的码），
 *    因此"声明的覆盖"不可能大于"实际响过的"。
 */
const PLAN_INJECTION_ROWS = [
  { n: 1, disposition: 'implemented', codes: ['manifest_zero_counts', 'manifest_skipped_silently'] },
  { n: 2, disposition: 'implemented', codes: ['manifest_stale_commit'] },
  { n: 3, disposition: 'not-applicable', codes: [], naId: '#3' },
  { n: 4, disposition: 'partial', codes: ['unavailable_written_as_zero'], naId: '#4b' },
  { n: 5, disposition: 'implemented', codes: ['chosen_but_not_injected'] },
  { n: 6, disposition: 'implemented', codes: ['rollup_no_positive_example'] },
  { n: 7, disposition: 'implemented', codes: ['round_count_mismatch', 'duplicate_turns'] },
  { n: 8, disposition: 'partial', codes: ['manifest_failed_runs_dropped'], naId: '#8b' },
] as const

measure('§2 计划书注入表的行数（必须 = 8）', PLAN_INJECTION_ROWS.length)
check(
  '§2-3 计划书的 8 类注入**逐条**有去处（实现 / 部分实现 / N/A）',
  PLAN_INJECTION_ROWS.length === 8 &&
    PLAN_INJECTION_ROWS.every((row) => row.codes.length > 0 || 'naId' in row),
  PLAN_INJECTION_ROWS.map((row) => `#${row.n}:${row.disposition}`).join(' ')
)
check(
  '§2-4 声明的覆盖码**全部真的响过**（负控里触发过，不是纸面声明）',
  PLAN_INJECTION_ROWS.every((row) => row.codes.every((code) => firedCodes.has(code))),
  `响过的码：${[...firedCodes].sort().join(',')}`
)
check(
  '§2-5 每条 N/A 都指向真实存在的 N/A 条目（不能指向一个不存在的 id）',
  PLAN_INJECTION_ROWS.every(
    (row) => !('naId' in row) || NOT_APPLICABLE.some((item) => item.id === row.naId)
  ),
  NOT_APPLICABLE.map((item) => item.id).join(',')
)

// ---------------------------------------------------------------------------
// §3 命令面的守卫（`--suite` 与 Live 包装器）
// ---------------------------------------------------------------------------

section('§3 命令面守卫 —— 入口纪律也要被断言，而不是靠注释自律')

const suiteRefusals = [
  { id: '§3-1', argv: [], code: 'suite_required' },
  { id: '§3-2', argv: ['--suite'], code: 'suite_required' },
  { id: '§3-3', argv: ['--suite', 'nope'], code: 'suite_unknown' },
] as const
for (const item of suiteRefusals) {
  const decision = resolveSuiteSelection([...item.argv])
  check(
    `${item.id} \`m6:verify ${item.argv.join(' ')}\` ⇒ 拒绝（\`${item.code}\`）`,
    decision.ok === false && decision.code === item.code,
    decision.ok ? '**被接受了** —— 这是假绿' : decision.code
  )
}
const acceptedPart = resolveSuiteSelection(['--suite', 'parts'])
const acceptedAll = resolveSuiteSelection(['--suite', 'all'])
check(
  '§3-4 `m6:verify --suite parts` ⇒ 只选一个套件（不偷偷全跑）',
  acceptedPart.ok && acceptedPart.suites.length === 1 && acceptedPart.suites[0] === 'parts'
)
check(
  '§3-5 `m6:verify --suite all` ⇒ 三个套件，且都来自登记表',
  acceptedAll.ok && acceptedAll.suites.length === M6_SUITES.length
)
check(
  '§3-6 登记表里的离线套件脚本**不含**模型/搜索调用面（"不偷偷调用"的机器形式）',
  auditSuiteScripts(ROOT, (path) => readFileSync(path, 'utf8')).every(
    (item) => item.offenders.length === 0
  ),
  auditSuiteScripts(ROOT, (path) => readFileSync(path, 'utf8'))
    .map((item) => item.offenders.join(','))
    .filter((x) => x !== '')
    .join(' | ') || '（全部干净）'
)

const liveRefusals = [
  { id: '§3-7', argv: [], marker: true, code: 'suite_required' },
  { id: '§3-8', argv: ['--suite', 'nope'], marker: true, code: 'suite_unknown' },
  { id: '§3-9', argv: ['--suite', 'smoke'], marker: false, code: 'wrapper_required' },
  { id: '§3-10', argv: ['--suite', 'smoke'], marker: true, code: 'suite_not_implemented' },
] as const
for (const item of liveRefusals) {
  const decision = evaluateLiveGuard({ argv: [...item.argv], wrapperMarkerPresent: item.marker })
  check(
    `${item.id} \`m6:live ${item.argv.join(' ')}\`（包装器=${String(item.marker)}）⇒ 拒绝（\`${item.code}\`）`,
    decision.ok === false && decision.code === item.code,
    decision.ok ? '**被接受了** —— 这是假绿' : decision.code
  )
}
check(
  '§3-11 目前**没有任何 Live 套件是已实现的**（所以"能不能跑"这件事不会被误报）',
  M6_LIVE_SUITES.every((suite) => !suite.implemented),
  M6_LIVE_SUITES.map((suite) => `${suite.name}:${suite.plannedIn}`).join(' ')
)
measure('§3 命令面守卫断言数（范围自检）', suiteRefusals.length + liveRefusals.length + 3)

// ---------------------------------------------------------------------------
// 判决与证据
// ---------------------------------------------------------------------------

section('判决')

const total = rows.length
const passed = rows.filter((row) => row.pass).length
let verdict = 'PASS'
if (measurementInvalid > 0) verdict = 'MEASUREMENT INVALID'
else if (failures > 0) verdict = 'FAIL'

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const now = new Date()
const runId = `m6-wp4-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
const outDir = resolve('artifacts/m6', runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'measurement.json')

console.log(`\n  ${verdict} — ${passed}/${total} 通过，失败 ${failures}，MEASUREMENT INVALID ${measurementInvalid}`)

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      schemaVersion: 'm6-wp4-measurement@1',
      runId,
      generatedAt: now.toISOString(),
      head,
      verdict,
      passed,
      failed: failures,
      measurementInvalid,
      measurements,
      checks: rows,
      injections: {
        implemented: injectionsRun,
        notApplicable: NOT_APPLICABLE,
      },
      gateRegistry: M6_GATE_SPECS,
      scope: {
        opensDatabase: false,
        writesPersistentState: false,
        callsModel: false,
        runsSearch: false,
        note:
          '量具资格化门：只调用纯检测器（manifest / 证据形状 / 三段式）。' +
          '它**不**跑那些门本身 —— 它证明的是"那些门的读数会被这些检测器抓住"。',
        headSemantics: '`head` = 运行时 git HEAD（被测代码提交）；证据文件落在紧随其后的纯证据提交里。',
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log(`  证据：${relative(ROOT, outPath).split(/[\\/]/).join('/')}`)

process.exit(verdict === 'PASS' ? 0 : 2)
