/**
 * M5.1.1 / WP10-C —— **Full Regression & Gate Aggregation**（`pnpm m5.1.1:wp10c:verify`）
 *
 * ============================================================================
 *  这道门做什么（canonical WP10 的 "Regression" 段 · 用户 R-49 授权的 C 步）
 * ============================================================================
 * ```text
 *   运行：M5.1.1 gates · M5 gates · M4.5 gates · natural-language E2E · full regression
 *   若 live-model smoke 是既有 hard requirement：real key available → RUN；no key → NOT RUN
 *   绝不能 mock 成 PASS。
 * ```
 * canonical 五项 → 本仓库的**当前命令名**（逐项对应，没有一项被省略）：
 *
 * | canonical | 本门实际跑 | 说明 |
 * |---|---|---|
 * | M5.1.1 gates | `pnpm m5.1.1:gates` | 九门汇总（只读已落盘证据） |
 * | M5 gates | `pnpm m5.1:gates` | M5.1 九门汇总（只读） |
 * | M4.5 gates | `pnpm m4.5:gates` | M4.5 门结果汇总（只读） |
 * | natural-language E2E | `pnpm m5.1.1:wp9:verify` | M5.1.1 的运行时端到端门（真实 runtime 里的 E4/E8） |
 * | full regression | `pnpm m5.1:regression:verify` | 读 m4.5:ci 原始日志 + `artifacts/m5.1/**` 的 verdict 字段 |
 *
 * 另加 `WP10-A` 计划 §3 C3 明文要求的三道**资格复核门**：`wp8c3`（40/0）· `wp8`（53/0）· `wp9`（PASS）。
 *
 * ============================================================================
 *  三处**必须说清**的口径（否则本门的绿会读起来比实际更强）
 * ============================================================================
 *  ① **不重跑 M5.1 的九个 verifier**，只跑**聚合器**。
 *     理由：那九个 verifier 会**重写冻结目录** `artifacts/m5.1/**`（M5.1 自 2026-09-17 起冻结，
 *     AGENTS §3 + R-46 §2）。它们的 verdict 由**冻结 blob**承载（本门在 §5 从 immutable 标签
 *     `m5.1-complete` 逐路径还原），`m5.1:gates` / `m5.1:regression:verify` 是**只读落盘证据**的
 *     聚合器 —— 这正是 canonical 说的 "M5.1 gates / M5 gates / M4.5 gates"。
 *     实测（§4 的 probe 读数）：四个聚合器**只**重写它们自己那四份 `*-results.json` /
 *     `regression-evidence.json`，**不碰** `artifacts/m5.1/**-evidence.json`。
 *
 *  ② **Live Smoke = NOT RUN**（本机无 `OPENAI_API_KEY`）。
 *     `m5.1:regression:verify` 的 `M51-G9` 读的是 `artifacts/m5.1/live-smoke-evidence.json`
 *     的 `liveSmokeVerdict`，而那是 **M5.1 期（有 key 时）的历史读数**（冻结 blob）。
 *     本门**不**重跑 `m5.1:e2e:verify` ⇒ 不会把那个值改成 `NOT RUN`（改了就会把冻结的
 *     M5.1 判据判红，而那是**不能改**的）；而是把 "live smoke 本次 = NOT RUN" **显式**写进
 *     本门自己的证据（`wp10-regression.json` 的 `liveSmoke` 块）。
 *     ⇒ **禁止**把本门的 `M51-G9 = PASS` 读成"M5.1.1 期跑过 live smoke"。
 *
 *  ③ **跑序即判据**：`wp8c3` 的 C3-0 要求"干净树"。任何跑过的门都会重写被跟踪的 artifacts
 *     ⇒ 它**必须最先、在干净树上单独跑**（§0 已断言干净，§2 第一件事就是它）。
 *
 * ============================================================================
 *  跑法 / 时长
 * ============================================================================
 * `pnpm m5.1.1:wp10c:verify` —— 内含一次**完整 `m4.5:ci`**（约 10 分钟）+ 三道资格复核门 +
 * 四个聚合器 + 冻结面还原。**必须在干净树上单独跑**（§0 的判据；它会重写冻结目录，那是 §5 要还原的）。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, ok: boolean, detail: string): boolean {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}  [${detail}]`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}  [${detail}]`)
  }
  return ok
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}
function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID'}`)
}

const ROOT = process.cwd()
const ART = join(ROOT, 'artifacts', 'm5.1.1')
const M51 = join(ROOT, 'artifacts', 'm5.1')
const FREEZE_TAG = 'm5.1-complete'
const CI_LOG = join(M51, 'wp9-m4.5-ci.log')

/** 冻结目录（canonical historical source **只有** immutable 标签） */
const FROZEN_DIRS = ['artifacts/m4-acceptance', 'artifacts/m4.1', 'artifacts/m4.5', 'artifacts/m5', 'artifacts/m5.1'] as const

/**
 * §2 的资格复核门（WP10-A 计划 §3 C3 明文要求）。
 * `cleanTree: true` 的那个**必须最先**跑（C3-0）。
 */
const REQUALIFIERS = [
  { label: 'WP8-C3（Hard Gate · 干净树，C3-0）', pnpm: 'm5.1.1:wp8c3:verify', expect: 40, cleanTree: true },
  { label: 'WP8-B（Hard Gate）', pnpm: 'm5.1.1:wp8:verify', expect: 53, cleanTree: false },
  { label: 'natural-language E2E（M5.1.1 运行时 E2E）', pnpm: 'm5.1.1:wp9:verify', expect: null, cleanTree: false },
] as const

/** canonical 的 "gates" 与 "full regression" 映射（聚合器 + 回归读取器） */
const AGGREGATORS = [
  { label: 'M5.1.1 gates', pnpm: 'm5.1.1:gates', note: '九门汇总（只读已落盘证据）' },
  { label: 'M5 gates', pnpm: 'm5.1:gates', note: 'M5.1 九门汇总（只读）' },
  { label: 'M4.5 gates', pnpm: 'm4.5:gates', note: 'M4.5 门结果汇总（只读）' },
  { label: 'full regression', pnpm: 'm5.1:regression:verify', note: '读 m4.5:ci 原始日志 + artifacts/m5.1/** 的 verdict 字段' },
] as const

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')
const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

/**
 * 解析 `git status --porcelain` 的路径。
 *
 * ⚠️ **这里踩过一个真实的坑，判据因此变得更严**（见 F4 的 `C-G1`）：
 * `git()` 这个 helper 会 `trim()` 整段输出，于是**第一行**的 `XY` 前的那个空格被吃掉
 * （`" M artifacts/x"` → `"M artifacts/x"`），`slice(3)` 会把路径首字母切掉
 * （`artifacts/…` → `rtifacts/…`）。第一版因此在 `git checkout` 时炸掉、
 * 并以**非零退出**留下"半还原"的工作树。
 * 正确做法：**`slice(2)` 再 `trim()`** —— 两种形态（有无前导空格）都对。
 */
function porcelainPaths(out: string): string[] {
  return out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(2).trim().replace(/\\/g, '/'))
}

/** 子进程环境：清掉任何可能串库的隔离变量（AGENTS §7：一个进程只有一个库生效） */
const childEnv = { ...process.env }
delete childEnv.PGLITE_DATA_DIR
delete childEnv.PROJECT_LG_SANDBOX

interface PnpmRun {
  pnpm: string
  exit: number
  passed: number | null
  failed: number | null
  tail: string
  bytes: number
}

/** 串行跑一个 pnpm 门；捕获 stdout+stderr，解析 `N 通过 / M 失败` 尾行。 */
function runPnpm(pnpm: string): PnpmRun {
  const result = spawnSync('pnpm', [pnpm], { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 128 * 1024 * 1024, env: childEnv })
  const exit = result.status === null ? -1 : result.status
  const text = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`
  const counts = [...text.matchAll(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/g)].slice(-1)[0]
  const tail =
    text
      .split('\n')
      .filter((line) => /通过\s*\/\s*\d+\s*失败|PASS|FAIL|not-run|结论/.test(line))
      .slice(-1)[0]
      ?.trim() ?? ''
  return {
    pnpm,
    exit,
    passed: counts ? Number(counts[1]) : null,
    failed: counts ? Number(counts[2]) : null,
    tail,
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

// ===========================================================================
section('§0 前置：干净树 + 冻结面 == immutable 标签')
// ===========================================================================

const porcelainTracked = git('status', '--porcelain', '--untracked-files=no')
const SELF_WRITE = ['artifacts/m5.1.1/wp10-regression.json']
const allPorcelain = git('status', '--porcelain')
const untracked = porcelainPaths(allPorcelain.split('\n').filter((line) => line.startsWith('?? ')).join('\n'))
const foreignUntracked = untracked.filter((p) => !SELF_WRITE.includes(p))
console.log(`  · git status：被跟踪改动 = ${porcelainTracked.length} · 未跟踪 = ${untracked.length}（本门自己的写入面 ${untracked.length - foreignUntracked.length}）`)
check(
  '前置：Git 工作树干净（没有被跟踪文件的改动；未跟踪的只剩本门自己的证据面）',
  porcelainTracked.length === 0 && foreignUntracked.length === 0,
  porcelainTracked.replace(/\n/g, ' ; ') || `tracked=0 · foreign=${foreignUntracked.join(',') || '0'}`
)
const frozenBefore = FROZEN_DIRS.map((dir) => ({
  dir,
  trackedCount: git('ls-files', dir).split('\n').filter(Boolean).length,
  diffVsTag: git('diff', '--name-only', `${FREEZE_TAG}..HEAD`, '--', dir).split('\n').filter(Boolean).length,
}))
measure('冻结目录数', frozenBefore.length)
check(
  `前置：五个冻结目录当前与 \`${FREEZE_TAG}\` **零差异**`,
  frozenBefore.every((r) => r.trackedCount > 0 && r.diffVsTag === 0),
  frozenBefore.map((r) => `${r.dir}:${r.diffVsTag}`).join(' · ')
)

// ===========================================================================
section('§1 C1：fork 前置读数（被 gitignore 的 CI 日志 + M5.1 期的回归读数）')
// ===========================================================================

/** 旧日志的**边界读数**（不进 git，所以只能记 sha256/字节/BOM） */
const priorLogBytes = readFileSync(CI_LOG)
const priorLog = {
  path: 'artifacts/m5.1/wp9-m4.5-ci.log',
  present: true,
  bytes: priorLogBytes.length,
  sha256: sha256(priorLogBytes),
  bom:
    priorLogBytes[0] === 0xff && priorLogBytes[1] === 0xfe
      ? 'utf-16le'
      : priorLogBytes[0] === 0xfe && priorLogBytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8',
  mtime: statSync(CI_LOG).mtime.toISOString(),
  gitignored: git('check-ignore', 'artifacts/m5.1/wp9-m4.5-ci.log').length > 0,
}
console.log(`  · 旧日志：${priorLog.bytes} 字节 · ${priorLog.bom} · sha ${priorLog.sha256.slice(0, 16)}… · mtime ${priorLog.mtime}`)
measure('旧 CI 日志的字节数', priorLog.bytes)

/**
 * M5.1 期的回归读数：从 **committed blob** 取（`git show HEAD:…`），
 * 因为它就是当时那位**冻结的 M5.1 读者**（`m5.1:regression:verify`）自己写的产物 ——
 * 本门**不**再写第二份日志解析器（避免与冻结判据漂移）。
 */
const priorRegressionRaw = git('show', `HEAD:artifacts/m5.1/regression-evidence.json`)
const priorRegression = JSON.parse(priorRegressionRaw) as {
  regressionVerdict?: string
  m45Ci?: Record<string, unknown>
  gateReadings?: unknown[]
}
const priorM45 = (priorRegression.m45Ci ?? {}) as Record<string, unknown>
const priorCi = {
  source: 'HEAD:artifacts/m5.1/regression-evidence.json（M5.1 期的冻结读数，由当时那位 M5.1 读者自己解析）',
  regressionVerdict: priorRegression.regressionVerdict ?? null,
  exitCode: priorM45.exitCode ?? null,
  logBytes: priorM45.logBytes ?? null,
  logEncoding: priorM45.logEncoding ?? null,
  gateSummaryCount: Array.isArray(priorM45.gateSummaries) ? (priorM45.gateSummaries as unknown[]).length : null,
  hardGateCount: Array.isArray(priorM45.hardGates) ? (priorM45.hardGates as unknown[]).length : null,
  gateReadingsCount: Array.isArray(priorRegression.gateReadings) ? priorRegression.gateReadings.length : null,
}
console.log(`  · M5.1 期回归读数：verdict=${String(priorCi.regressionVerdict)} · ciExit=${String(priorCi.exitCode)} · 逐门小结=${String(priorCi.gateSummaryCount)} · 硬门=${String(priorCi.hardGateCount)}`)
check(
  '★ C1：旧 CI 日志的读数已被 fork（sha256 + 字节 + BOM + 旧回归读者的解析结果）—— 覆盖它之前先留证',
  priorLog.present && priorLog.bytes > 0 && priorCi.exitCode !== null && priorLog.gitignored,
  `${priorLog.sha256.slice(0, 16)}… · priorCiExit=${String(priorCi.exitCode)}`
)

// ===========================================================================
section('§2 C3-a：**干净树上先跑**资格复核门（wp8c3 → wp8 → wp9）')
// ===========================================================================
console.log('  · 跑序即判据：§0 已断言干净 ⇒ wp8c3 的 C3-0「干净树」判据此刻成立（**没有**用清洁度例外）')

const requalification: PnpmRun[] = []
for (const spec of REQUALIFIERS) {
  const run = runPnpm(spec.pnpm)
  requalification.push(run)
  console.log(`  · ${spec.label.padEnd(38)} → EXIT=${run.exit} · ${String(run.passed)} 通过 / ${String(run.failed)} 失败`)
  const expectedOk = spec.expect === null ? run.failed === 0 && (run.passed ?? 0) > 0 : run.passed === spec.expect && run.failed === 0
  check(`★ C3：${spec.label} \`${spec.pnpm}\` PASS${spec.expect === null ? '' : `（${spec.expect}/0）`}`, run.exit === 0 && expectedOk, `EXIT=${run.exit} · ${String(run.passed)}/${String(run.failed)}`)
}
measure('跑过的资格复核门数', requalification.length)
const wp8c3Run = requalification[0]
measure('wp8c3 报出的断言数（C3-0 干净树判据真的量到了东西）', wp8c3Run.passed ?? 0)

// wp8 的 harness 自检：unexpectedWrites / redGates 必须空（从它自己的落盘证据 `wp8-gate-manifest.json` 读）
const wp8Manifest = JSON.parse(readFileSync(join(ART, 'wp8-gate-manifest.json'), 'utf8')) as {
  summary?: { passed?: number; failed?: number; wp8Verdict?: string; unexpectedWrites?: unknown[]; redGates?: unknown[]; measurementInvalid?: number }
}
const wp8Summary = wp8Manifest.summary ?? {}
check(
  '★ C3：`wp8:verify` 的落盘证据（`wp8-gate-manifest.json`）里 `unexpectedWrites = 0` 且 `redGates = 0`（没有"未声明写入面"）',
  wp8Summary.wp8Verdict === 'PASS' &&
    (wp8Summary.unexpectedWrites ?? []).length === 0 &&
    (wp8Summary.redGates ?? []).length === 0 &&
    wp8Summary.measurementInvalid === 0,
  `verdict=${String(wp8Summary.wp8Verdict)} · unexpectedWrites=${(wp8Summary.unexpectedWrites ?? []).length} · redGates=${(wp8Summary.redGates ?? []).length} · measurementInvalid=${String(wp8Summary.measurementInvalid)}`
)

const wp9Run = requalification[2]
check(
  '★ C3：`wp9:verify` 的 stdout 里出现 `WP9 = PASS`（canonical 的 "natural-language E2E"）',
  /\*\*WP9 = PASS\*\*/.test(wp9Run.tail) || (wp9Run.exit === 0 && (wp9Run.failed ?? 1) === 0),
  `EXIT=${wp9Run.exit} · ${String(wp9Run.passed)}/${String(wp9Run.failed)}`
)

// ===========================================================================
section('§3 C2：跑 fresh `pnpm m4.5:ci`（全量 CI），日志落到冻结读者读的那个路径')
// ===========================================================================

const ciStartedAt = new Date().toISOString()
const t0 = Date.now()
const ciResult = spawnSync('pnpm', ['m4.5:ci'], {
  cwd: ROOT,
  encoding: 'utf8',
  shell: true,
  maxBuffer: 256 * 1024 * 1024,
  env: childEnv,
})
const ciExit = ciResult.status === null ? -1 : ciResult.status
const ciText = `${String(ciResult.stdout ?? '')}\n${String(ciResult.stderr ?? '')}`
const ciMs = Date.now() - t0

/**
 * 日志编码：**UTF-8 无 BOM**（不用 PowerShell 的 `*>` —— 它写 UTF-16LE，AGENTS §7 的坑）。
 * 冻结的 M5.1 读者是 **BOM-aware** 的（`readLogText`），UTF-8 走它的最后一条分支 ✓。
 */
writeFileSync(CI_LOG, `${ciText}\nEXIT_CODE=${ciExit}\n`, 'utf8')
const freshLogBytes = readFileSync(CI_LOG)
const freshLog = {
  path: 'artifacts/m5.1/wp9-m4.5-ci.log',
  bytes: freshLogBytes.length,
  sha256: sha256(freshLogBytes),
  encoding: 'utf-8 (no BOM)',
  writtenBy: 'Node writeFileSync —— 刻意不用 PowerShell 重定向（会写 UTF-16LE）',
}
console.log(`  · fresh日志：${freshLog.bytes} 字节 · sha ${freshLog.sha256.slice(0, 16)}…`)
measure('fresh CI 日志的字节数', freshLog.bytes)
check(
  '★ C2-HardGate：`pnpm m4.5:ci` **EXIT = 0**（全量离线 CI 真跑通过）',
  ciExit === 0,
  `EXIT=${ciExit} · ${Math.round(ciMs / 1000)}s · 日志 ${freshLog.bytes} 字节`
)
const ciGateSummaryCount = [...ciText.matchAll(/^\s*(.+?)：\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/gm)].length
const ciHardGateCount = [...ciText.matchAll(/[✅❌]\s+G\d+\s+.+?\s+(PASS|FAIL)\s+\d+\s*通过\s*\/\s*\d+\s*失败\s*\[HARD GATE\]/g)].length
console.log(`  · 时长 ${Math.round(ciMs / 1000)}s · 日志自解析：逐门小结 ${ciGateSummaryCount} 条 · 硬门 ${ciHardGateCount} 条`)
measure('fresh CI 日志里的逐门小结条数（自己解析，用于与冻结读者交叉核对）', ciGateSummaryCount)
measure('fresh CI 日志里的硬门条数（自己解析，用于与冻结读者交叉核对）', ciHardGateCount)
check(
  '★ C2：fresh 日志**不是空的**（自己解析到的逐门小结 / 硬门都 > 0 ⇒ 捕获真的抓到了子进程 stdout）',
  ciGateSummaryCount > 0 && ciHardGateCount > 0,
  `小结=${ciGateSummaryCount} · 硬门=${ciHardGateCount}`
)

// ===========================================================================
section('§4 C3-b：canonical 的聚合器（M5.1.1 gates · M5.1 gates · M4.5 gates · full regression）')
// ===========================================================================

const aggregatorResults: (PnpmRun & { label: string; note: string })[] = []
for (const spec of AGGREGATORS) {
  const run = runPnpm(spec.pnpm)
  aggregatorResults.push({ ...run, label: spec.label, note: spec.note })
  console.log(`  · ${spec.label.padEnd(15)} → pnpm ${spec.pnpm} EXIT=${run.exit} :: ${run.tail}`)
}
measure('跑过的聚合器数', aggregatorResults.length)
check(
  '★ C3-HardGate：四个聚合器（M5.1.1 gates · M5 gates · M4.5 gates · full regression）**全部 EXIT 0**',
  aggregatorResults.length === 4 && aggregatorResults.every((r) => r.exit === 0),
  aggregatorResults.map((r) => `${r.pnpm}=${r.exit}`).join(' · ')
)

/** `m5.1.1:gates` 自己的判据（WP10-A 计划 §3 C3 的 Hard Gate：G1–G7 PASS · G8 NOT RUN · G9 PASS） */
const m511GateResults = JSON.parse(readFileSync(join(ART, 'gate-results.json'), 'utf8')) as {
  gates?: { id: string; status: string; verdict: string; name: string }[]
  wp8Harness?: { passed?: number; failed?: number; unexpectedWrites?: unknown[]; redGates?: unknown[]; wp8Verdict?: string }
}
const m511Gates = m511GateResults.gates ?? []
const m511Readings = m511Gates.map((g) => `${g.id}=${g.verdict}`)
const g17 = m511Gates.filter((g) => /^M511-G[1-7]$/.test(g.id))
const g8 = m511Gates.find((g) => g.id === 'M511-G8')
const g9 = m511Gates.find((g) => g.id === 'M511-G9')
console.log(`  · M5.1.1 九门读数：${m511Readings.join(' · ')}`)
measure('m5.1.1:gates 判定的门数', m511Gates.length)
check(
  '★ C3-HardGate：`m5.1.1:gates` = G1–G7 **全 PASS** · G8 = **NOT RUN**（Break-Glass 未实现，如实登记）· G9 = **PASS**',
  m511Gates.length === 9 &&
    g17.length === 7 &&
    g17.every((g) => g.verdict === 'PASS') &&
    g8?.verdict === 'NOT RUN' &&
    g9?.verdict === 'PASS',
  m511Readings.join(' · ')
)
check(
  `★ C3：\`m5.1.1:gates\` 读到的 WP8 harness 自检 = ${String(m511GateResults.wp8Harness?.passed)} 通过 / ${String(m511GateResults.wp8Harness?.failed)} 失败（与 §2 的 wp8 逐门判定一致）`,
  m511GateResults.wp8Harness?.wp8Verdict === 'PASS' &&
    m511GateResults.wp8Harness?.failed === 0 &&
    (m511GateResults.wp8Harness?.unexpectedWrites ?? []).length === 0,
  `passed=${String(m511GateResults.wp8Harness?.passed)} · failed=${String(m511GateResults.wp8Harness?.failed)} · unexpectedWrites=${(m511GateResults.wp8Harness?.unexpectedWrites ?? []).length}`
)

/** fresh 回归读数：由**冻结的 M5.1 读者**自己写出来的（本门只读它，不自己解析日志） */
const freshRegressionPath = join(M51, 'regression-evidence.json')
let freshRegression: Record<string, unknown> | null = null
try {
  freshRegression = JSON.parse(readFileSync(freshRegressionPath, 'utf8')) as Record<string, unknown>
} catch {
  freshRegression = null
}
const freshM45 = (freshRegression?.m45Ci ?? {}) as Record<string, unknown>
const freshGateReadings = (freshRegression?.gateReadings ?? []) as { id: string; verdict: string }[]
const freshCi = {
  source: 'artifacts/m5.1/regression-evidence.json（本次运行由冻结的 M5.1 读者写出）',
  regressionVerdict: freshRegression?.regressionVerdict ?? null,
  exitCode: freshM45.exitCode ?? null,
  logBytes: freshM45.logBytes ?? null,
  logEncoding: freshM45.logEncoding ?? null,
  gateSummaryCount: Array.isArray(freshM45.gateSummaries) ? (freshM45.gateSummaries as unknown[]).length : null,
  hardGateCount: Array.isArray(freshM45.hardGates) ? (freshM45.hardGates as unknown[]).length : null,
  problems: (freshRegression?.problems ?? []) as string[],
  gateVerdicts: freshGateReadings.map((r) => `${r.id}=${r.verdict}`),
}
measure('fresh 回归解析到的逐门小结数', Number(freshCi.gateSummaryCount ?? 0))
measure('fresh 回归解析到的硬门数', Number(freshCi.hardGateCount ?? 0))
check(
  '★ `full regression`：fresh 日志被**冻结的 M5.1 读者**解析成功（逐门小结与硬门都 > 0 ⇒ 判据没有失效），且 `regressionVerdict = PASS`',
  freshCi.regressionVerdict === 'PASS' &&
    Number(freshCi.gateSummaryCount ?? 0) > 0 &&
    Number(freshCi.hardGateCount ?? 0) > 0 &&
    freshCi.problems.length === 0,
  `verdict=${String(freshCi.regressionVerdict)} · 小结=${String(freshCi.gateSummaryCount)} · 硬门=${String(freshCi.hardGateCount)} · problems=${freshCi.problems.length}`
)
check(
  '★ fresh 日志里的 `EXIT_CODE` / 字节数与本次 `m4.5:ci` 一致（冻结读者读的**不是**旧日志）',
  Number(freshCi.exitCode) === ciExit && freshCi.logBytes === freshLog.bytes,
  `log.exitCode=${String(freshCi.exitCode)} vs 本次=${ciExit} · log.bytes=${String(freshCi.logBytes)} vs ${freshLog.bytes}`
)
check(
  '★ 交叉核对：本门**自己**解析 fresh 日志得到的逐门小结 / 硬门条数 == 冻结读者解析出的（两套判据同一份真值）',
  freshCi.gateSummaryCount === ciGateSummaryCount && freshCi.hardGateCount === ciHardGateCount,
  `自解析 ${ciGateSummaryCount}/${ciHardGateCount} vs 冻结读者 ${String(freshCi.gateSummaryCount)}/${String(freshCi.hardGateCount)}`
)

// ===========================================================================
section('§5 C4：逐路径还原冻结面（canonical source = immutable 标签）+ K-32/K-33 复核')
// ===========================================================================

/**
 * 解析与自检见文件顶部的 `porcelainPaths()`（那处坑的真实记录）。
 */
const dirtied = FROZEN_DIRS.flatMap((dir) => porcelainPaths(git('status', '--porcelain', '--', dir)))
const malformedDirtied = dirtied.filter((p) => !p.startsWith('artifacts/') || p.includes('\t'))
measure('跑门期间被改写的冻结路径数（0 也是要被断言的值）', dirtied.length, true)
console.log(`  · 被改写的冻结路径：${dirtied.length === 0 ? '(无)' : dirtied.join(', ')}`)
check(
  '★ C4：被改写路径的**解析结果**全部形如 `artifacts/…`（量具自检：porcelain 解析没有吃掉首字符）',
  malformedDirtied.length === 0,
  malformedDirtied.length === 0 ? `${dirtied.length} 条全部合法` : `畸形 ${malformedDirtied.join(', ')}`
)
/** 每条待还原路径都必须真的存在于 immutable 标签里（不存在 ⇒ 丢给 `git checkout` 会炸掉整条命令） */
const notInTag = dirtied.filter((p) => spawnSync('git', ['cat-file', '-e', `${FREEZE_TAG}:${p}`], { cwd: ROOT }).status !== 0)
check(
  `★ C4：每条待还原路径都存在于 \`${FREEZE_TAG}\` 里（否则整条 checkout 会失败并留下半还原状态）`,
  notInTag.length === 0,
  notInTag.length === 0 ? `${dirtied.length} 条全部在标签里` : `不在标签里：${notInTag.join(', ')}`
)
if (dirtied.length > 0 && malformedDirtied.length === 0 && notInTag.length === 0) {
  execFileSync('git', ['checkout', FREEZE_TAG, '--', ...dirtied], { cwd: ROOT, encoding: 'utf8' })
  console.log(`  · 已执行：git checkout ${FREEZE_TAG} -- <${dirtied.length} 条路径>`)
} else if (dirtied.length > 0) {
  console.log('  · **跳过 checkout**（解析畸形或路径不在标签里）—— 见上面的两条红')
}

const frozenAfter = FROZEN_DIRS.map((dir) => ({
  dir,
  worktreeDiffVsTag: git('diff', '--name-only', FREEZE_TAG, '--', dir).split('\n').filter(Boolean).length,
  headDiffVsTag: git('diff', '--name-only', `${FREEZE_TAG}..HEAD`, '--', dir).split('\n').filter(Boolean).length,
}))
measure('还原后仍与标签不同的冻结路径数（0 = 干净）', frozenAfter.reduce((s, r) => s + r.worktreeDiffVsTag, 0), true)
check(
  `★ C4-HardGate：还原之后五个冻结目录的**工作树**与 \`${FREEZE_TAG}\` 零差异（逐路径，无差别 checkout 是被禁止的）`,
  frozenAfter.every((r) => r.worktreeDiffVsTag === 0),
  frozenAfter.map((r) => `${r.dir}:${r.worktreeDiffVsTag}`).join(' · ')
)
check(
  `HEAD 与 \`${FREEZE_TAG}\` 的冻结面差异也 = 0（历史证据一个字节都没被改写）`,
  frozenAfter.every((r) => r.headDiffVsTag === 0),
  frozenAfter.map((r) => `${r.dir}:${r.headDiffVsTag}`).join(' · ')
)

const k32 = runPnpm('m5.1.1:wp8c1:verify')
const k33 = runPnpm('m5.1.1:wp8c2:verify')
console.log(`  · K-32 复核 → EXIT=${k32.exit} · ${String(k32.passed)}/${String(k32.failed)} :: ${k32.tail}`)
console.log(`  · K-33 复核 → EXIT=${k33.exit} · ${String(k33.passed)}/${String(k33.failed)}`)
check('★ C4：还原后 **K-32 门 PASS**（冻结证据与 immutable 标签逐字一致）', k32.exit === 0, `EXIT=${k32.exit} · ${String(k32.passed)}/${String(k32.failed)}`)
check('C4：还原后 **K-33 专项门**仍 PASS（没有连带损伤）', k33.exit === 0, `EXIT=${k33.exit} · ${String(k33.passed)}/${String(k33.failed)}`)

// ===========================================================================
section('§6 C5：Live Smoke 前置（canonical：no key → NOT RUN）')
// ===========================================================================

const hasKey = (process.env.OPENAI_API_KEY ?? '').trim() !== ''
const liveSmoke = {
  status: hasKey ? ('RUN' as const) : ('NOT RUN' as const),
  OPENAI_API_KEY_present: hasKey,
  rule: 'canonical WP10：real key available → RUN；no key → NOT RUN。**绝不能** mock 成 PASS。',
  affected: ['m4.5:ci:full（= m4.5:ci && m4.5:smoke:live）', 'm4.5:smoke:live', 'eval:m4:extraction:live', 'eval:m4:promptfoo:live'],
  m51G9Note:
    '`m5.1:regression:verify` 的 M51-G9 读 `artifacts/m5.1/live-smoke-evidence.json` 的 liveSmokeVerdict，' +
    '那是 **M5.1 期（有 key 时）的历史读数**（冻结 blob）。本门**不**重跑 `m5.1:e2e:verify`（重跑会把该值改成 NOT RUN，' +
    '从而把**冻结的** M5.1 判据判红 —— 而 M5.1 判据不可改）。`scripts/verify-m5.1-e2e.ts:533` 在无 key 时 ' +
    "`notRun = ['live model call','production-copy live smoke']`。⇒ **禁止**把本门的 `M51-G9 = PASS` 读成" +
    '"M5.1.1 期跑过 live smoke"。',
}
measure('Live Smoke 前置检查项数', 2, true)
/** 机器证明"本门没有跑任何需要 key 的命令"：跑过的命令清单里不含 live/smoke 字样 */
const commandsRun = ['m4.5:ci', ...requalification.map((r) => r.pnpm), ...aggregatorResults.map((r) => r.pnpm), 'm5.1.1:wp8c1:verify', 'm5.1.1:wp8c2:verify']
const liveCommandsSpawned = commandsRun.filter((c) => /:full|smoke:live|:live\b/.test(c))
measure('本门 spawn 过的命令数', commandsRun.length)
check(
  '★ Live Smoke 如实登记：本门**没有** spawn 任何需要 key 的命令（`m4.5:ci:full` / `*.smoke:live` / `*:live`），也没有把它 mock 成 PASS',
  !hasKey && liveSmoke.status === 'NOT RUN' && liveCommandsSpawned.length === 0,
  `OPENAI_API_KEY present = ${String(hasKey)} · liveSmoke = ${liveSmoke.status} · 跑过的 live 命令 = ${liveCommandsSpawned.join(',') || '(无)'}`
)

// ===========================================================================
section('§7 量具健康 / 判定 / 证据')
// ===========================================================================

const measurementInvalid = measurements.filter((m) => !m.valid)
check(
  '所有计数型判据都自检过 `measured_count > 0`（测到 0 个对象的一律 MEASUREMENT INVALID，不报 PASS）',
  measurementInvalid.length === 0,
  `${measurements.length} 个量具，无效 ${measurementInvalid.length} 个${measurementInvalid.length > 0 ? `：${measurementInvalid.map((m) => m.label).join(' , ')}` : ''}`
)

const verdict = failed === 0 && measurementInvalid.length === 0 ? 'PASS' : 'FAIL'
mkdirSync(ART, { recursive: true })
const evidence = {
  testId: 'M5.1.1 / WP10-C Full Regression & Gate Aggregation（R-49 授权）',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp10c:verify',
  verdict,
  passed,
  failed,
  failures,
  canonicalMapping: REQUALIFIERS.map((r) => `${r.label} → pnpm ${r.pnpm}`).concat(AGGREGATORS.map((a) => `${a.label} → pnpm ${a.pnpm}`)),
  runOrder: [
    '§0 干净树前置断言',
    '§1 fork 旧 CI 日志与 M5.1 期回归读数（只读）',
    '§2 wp8c3（C3-0 干净树）→ wp8 → wp9',
    '§3 fresh `pnpm m4.5:ci` → 覆盖 artifacts/m5.1/wp9-m4.5-ci.log',
    '§4 四个聚合器（M5.1.1 gates · M5 gates · M4.5 gates · full regression）',
    `§5 逐路径 git checkout ${FREEZE_TAG} 还原冻结面 → K-32 / K-33 复核`,
    '§6 Live Smoke 前置登记',
  ],
  requalification: requalification.map((r) => ({ pnpm: r.pnpm, exit: r.exit, passed: r.passed, failed: r.failed, tail: r.tail })),
  m511Gates: m511Readings,
  wp8Harness: m511GateResults.wp8Harness ?? null,
  priorCi,
  priorLog,
  freshCi,
  freshLog,
  selfParsedCiLog: { gateSummaries: ciGateSummaryCount, hardGates: ciHardGateCount },
  m45CiRun: { exit: ciExit, durationMs: ciMs, startedAt: ciStartedAt, capture: 'Node writeFileSync(utf-8, no BOM) + EXIT_CODE 尾行' },
  aggregators: aggregatorResults.map((r) => ({ label: r.label, pnpm: r.pnpm, note: r.note, exit: r.exit, passed: r.passed, failed: r.failed, tail: r.tail })),
  frozenFaceRestore: {
    canonicalSource: `immutable annotated tag \`${FREEZE_TAG}\``,
    forbidens: ['HEAD', '父提交', '工作树备份', '无差别 git checkout -- artifacts'],
    dirtiedPaths: dirtied,
    after: frozenAfter,
  },
  k32: { exit: k32.exit, passed: k32.passed, failed: k32.failed, tail: k32.tail },
  k33: { exit: k33.exit, passed: k33.passed, failed: k33.failed },
  liveSmoke,
  interpretation: {
    doNotRerunM51Verifiers:
      '本门只跑**聚合器**（M5.1.1 gates · M5.1 gates · M4.5 gates · full regression）。' +
      '九个 M5.1 verifier 会重写冻结目录 `artifacts/m5.1/**`（M5.1 自 2026-09-17 冻结）⇒ 它们的 verdict 由冻结 blob 承载，' +
      '本门在 §5 从 immutable 标签逐路径还原。',
    freshVsHistorical:
      '**fresh**：`m4.5:ci` 的退出码/日志（本次真跑 ~' +
      `${Math.round(ciMs / 1000)}s` +
      '）、`m5.1:regression:verify` 对 fresh 日志的解析、四个聚合器的退出码、三道资格复核门（wp8c3/wp8/wp9）。' +
      '**historical（冻结 blob）**：九个 M5.1 门各自的 verdict 字段（含 `liveSmokeVerdict`）。',
    m51G9IsHistoricalLiveSmoke:
      '`M51-G9 liveSmokeVerdict = PASS` 读的是 **M5.1 期**有 key 时留下的冻结 blob（本门**不**把它重写成 NOT RUN）。' +
      '本机本轮 `liveSmoke = NOT RUN`（§6）。两者**不矛盾**，但**不得**互相冒充。',
  },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    productionDbOpened: false,
    realDbCopied: false,
    srcChanged: false,
    frozenDirsFinallyEqualTag: frozenAfter.every((r) => r.worktreeDiffVsTag === 0),
    liveSmokeMocked: false,
    concurrency: '串行：任何时刻只有一个 pwsh/pnpm 门进程',
  },
}
writeFileSync(join(ART, 'wp10-regression.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log('  ↳ 证据：artifacts/m5.1.1/wp10-regression.json')

console.log(`\n${'='.repeat(78)}`)
console.log(`M5.1.1 WP10-C（Full Regression & Gate Aggregation）：${passed} 通过 / ${failed} 失败｜**WP10-C = ${verdict}**`)
console.log(`  m4.5:ci EXIT=${ciExit}（${Math.round(ciMs / 1000)}s）· 聚合器 ${aggregatorResults.map((r) => `${r.pnpm}=${r.exit}`).join(' · ')}`)
console.log(`  资格复核：${requalification.map((r) => `${r.pnpm}=${r.exit}`).join(' · ')}`)
console.log(`  live smoke = ${liveSmoke.status}`)
console.log('='.repeat(78))
if (failed > 0) console.log(`失败项：\n${failures.map((f) => `    - ${f}`).join('\n')}`)
process.exit(failed === 0 && measurementInvalid.length === 0 ? 0 : 1)
