/*
 * M5.1 WP9 —— 全量回归证据（`pnpm m5.1:regression:verify`）
 *
 * 为什么要有这个脚本，而不是手写 `regression-evidence.json`：
 *
 *   AGENTS §6.4：**不要手写"全绿"表格**。汇总器只读已落盘证据，
 *   文件不存在 = `not-run`。同一纪律必须适用于"全量回归"这一层 ——
 *   否则 WP9 就成了唯一一个"结论由人写"的门。
 *
 * 所以这个脚本**不重新跑任何门**，它只做两件事：
 *   ① 读 `pnpm m4.5:ci` 留下的原始日志，提取它的退出码与逐门通过数（真值来自日志）；
 *   ② 读 `artifacts/m5.1/*.json` 里各门自己写的 verdict 字段。
 * 然后按**合取**给一个总判定：任何一项不是 PASS → FAIL。
 *
 * 为什么不在这里重跑 m4.5:ci：它要 ~10 分钟，而且它**会重写历史证据**
 * （artifacts/m4-acceptance/、artifacts/m4.1/、artifacts/m4.5/），
 * 那违反 AGENTS §7。回归是"别人跑完我来读"，不是"我在门里再跑一遍"。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ART = join(ROOT, 'artifacts', 'm5.1')

/** m4.5:ci 的原始日志（WP9 跑的那一次；gitignore 里，因为它 ~667 KB） */
const CI_LOG = join(ART, 'wp9-m4.5-ci.log')

interface GateReading {
  id: string
  script: string
  evidence: string
  verdictField: string
  verdict: string
  note?: string
}

const readings: GateReading[] = []
const problems: string[] = []

/**
 * 从证据文件里读**一个** verdict 字段。
 * 判据是字段值，**不是**文件存在 —— 这正是 M5.1 汇总器的同一条纪律。
 */
function readVerdict(id: string, script: string, file: string, field: string): void {
  const path = join(ART, file)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // 文件不存在 = not-run，**不是** PASS
    readings.push({ id, script, evidence: `artifacts/m5.1/${file}`, verdictField: field, verdict: 'not-run' })
    problems.push(`${id}：证据文件不存在（${file}）→ not-run`)
    return
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    readings.push({ id, script, evidence: `artifacts/m5.1/${file}`, verdictField: field, verdict: 'not-run' })
    problems.push(`${id}：证据文件不是合法 JSON（${file}）：${(error as Error).message}`)
    return
  }
  const value = parsed[field]
  const verdict = typeof value === 'string' ? value : 'missing-field'
  readings.push({
    id,
    script,
    evidence: `artifacts/m5.1/${file}`,
    verdictField: field,
    verdict,
    note: typeof parsed.note === 'string' ? parsed.note : undefined,
  })
  if (verdict !== 'PASS') problems.push(`${id}：${field} = ${verdict}（应为 PASS）`)
}

/* ---------- ① $pnpm m4.5:ci$ 的原始日志：退出码 + 逐门通过数 ---------- */

interface CiReading {
  ran: boolean
  exitCode: number | null
  log: string
  logBytes: number
  logEncoding: string
  gateSummaries: { label: string; passed: number; failed: number }[]
  hardGates: { id: string; label: string; status: string; passed: number; failed: number }[]
}

const ci: CiReading = {
  ran: false,
  exitCode: null,
  log: 'artifacts/m5.1/wp9-m4.5-ci.log',
  logBytes: 0,
  logEncoding: 'unknown',
  gateSummaries: [],
  hardGates: [],
}

/**
 * 读日志时**必须**先看字节序标记。
 *
 * 这里踩过真实的坑：PowerShell 的 `*>` 重定向在 5.1 下写 UTF-16LE，
 * 用 `readFileSync(..., 'utf8')` 读出来时 **ASCII 仍然匹配得上**
 * （`EXIT_CODE=` 找得到），但中文正则会**静默匹配零条** ——
 * 于是"31 条逐门小结"变成"0 条"，量具自检因此报"判据失效"。
 * 这正是 AGENTS §7 那条 ANSI/UTF-8 坑的同一个根因：**别猜编码，看 BOM**。
 */
function readLogText(path: string): string {
  const bytes = readFileSync(path)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes)
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes)
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '')
}

try {
  const rawBytes = readFileSync(CI_LOG)
  const log = readLogText(CI_LOG)
  ci.ran = true
  ci.logBytes = rawBytes.length
  ci.logEncoding =
    rawBytes.length >= 2 && rawBytes[0] === 0xff && rawBytes[1] === 0xfe
      ? 'utf-16le'
      : rawBytes.length >= 2 && rawBytes[0] === 0xfe && rawBytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8'

  // 末尾那行 `EXIT_CODE=<n>` 是我们自己追加的；它是**日志里的真值**，不是我的记忆
  const exitMatch = /EXIT_CODE=(\d+)/.exec(log)
  ci.exitCode = exitMatch ? Number(exitMatch[1]) : null
  if (ci.exitCode === null) problems.push('m4.5:ci 日志里找不到 EXIT_CODE 行 → 退出码未知')
  else if (ci.exitCode !== 0) problems.push(`m4.5:ci 退出码 = ${ci.exitCode}（应为 0）`)

  // 逐门小结：形如 `M4.5 L1 部件级测试：135 通过 / 0 失败`
  const summaryRe = /^\s*(.+?)：\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/gm
  for (const match of log.matchAll(summaryRe)) {
    ci.gateSummaries.push({ label: match[1].trim(), passed: Number(match[2]), failed: Number(match[3]) })
  }

  // 硬门表：形如 `✅ G12  Measurement Validation（L0）  PASS 38 通过 / 0 失败 [HARD GATE]`
  const hardRe = /([✅❌])\s+(G\d+)\s+(.+?)\s+(PASS|FAIL)\s+(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*\[HARD GATE\]/g
  for (const match of log.matchAll(hardRe)) {
    ci.hardGates.push({
      id: match[2],
      label: match[3].trim(),
      status: match[4],
      passed: Number(match[5]),
      failed: Number(match[6]),
    })
  }

  // 日志里**任何**非零失败数都必须被抓出来（不是只看小结行）
  const nonzero = [...log.matchAll(/\d+\s*通过\s*\/\s*([1-9]\d*)\s*失败/g)]
  if (nonzero.length > 0) problems.push(`m4.5:ci 日志里有 ${nonzero.length} 处非零失败计数`)

  // 出现 ❌ 也必须被抓出来
  if (log.includes('❌')) problems.push('m4.5:ci 日志里出现 ❌')

  if (ci.hardGates.length === 0) problems.push('m4.5:ci 日志里没解析到任何硬门行 → 判据失效（量具自检）')
  if (ci.gateSummaries.length === 0) problems.push('m4.5:ci 日志里没解析到任何逐门小结 → 判据失效（量具自检）')
} catch {
  problems.push('m4.5:ci 原始日志不存在 → 全量回归 not-run（**不是** PASS）')
}

/* ---------- ② 各门自己写的 verdict 字段 ---------- */

/**
 * 读「通过数 / 失败数」型证据（`wp1-contracts.json` 没有 verdict 字段，
 * 它写的是 `passed` / `failed`）。判据与 `m5.1-gate-results.ts` 的
 * `rule: 'counts'` 完全一致：**必须有断言**且**零失败**才算 PASS。
 */
function readCounts(id: string, script: string, file: string): void {
  const path = join(ART, file)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    readings.push({ id, script, evidence: `artifacts/m5.1/${file}`, verdictField: 'passed/failed', verdict: 'not-run' })
    problems.push(`${id}：证据文件不存在或不是合法 JSON（${file}）→ not-run`)
    return
  }
  const passed = typeof parsed.passed === 'number' ? parsed.passed : null
  const failed = typeof parsed.failed === 'number' ? parsed.failed : null
  const verdict = passed !== null && failed === 0 && passed > 0 ? 'PASS' : 'FAIL'
  readings.push({
    id,
    script,
    evidence: `artifacts/m5.1/${file}`,
    verdictField: 'passed/failed',
    verdict,
    note: `passed=${passed} failed=${failed}`,
  })
  if (verdict !== 'PASS') problems.push(`${id}：passed=${passed} failed=${failed} → FAIL`)
}

readCounts('M51-G1', 'pnpm m5.1:test', 'wp1-contracts.json')
readVerdict('M51-G2', 'pnpm m5.1:query:verify', 'query-negative-control.json', 'hardGateVerdict')
readVerdict('M51-G3', 'pnpm m5.1:control:verify', 'control-execution-truth.json', 'hardGateVerdict')
readVerdict('M51-G4', 'pnpm m5.1:observability:verify', 'observability-evidence.json', 'traceTruthVerdict')
readVerdict('M51-G5', 'pnpm m5.1:observability:verify', 'leakage-evidence.json', 'leakageVerdict')
readVerdict('M51-G6', 'pnpm m5.1:page:verify', 'page-evidence.json', 'pageIndependenceVerdict')
readVerdict('M51-G7', 'pnpm m5.1:measurement:verify', 'measurement-negative-controls.json', 'measurementVerdict')
readVerdict('M51-G8', 'pnpm m5.1:e2e:verify', 'nl-e2e-evidence.json', 'e2eVerdict')
readVerdict('M51-G9', 'pnpm m5.1:e2e:verify', 'live-smoke-evidence.json', 'liveSmokeVerdict')

/* ---------- ③ 总判定：合取 ---------- */

const regressionVerdict = problems.length === 0 ? 'PASS' : 'FAIL'

const summary = {
  testId: 'M5.1 / WP9 full regression',
  generatedAt: new Date().toISOString(),
  note:
    '全量回归。**判据不是文件存在**：每一项都读证据里的 verdict 字段；' +
    'm4.5:ci 的退出码与逐门计数从它自己的原始日志里解析。任何一项不是 PASS → FAIL。',
  regressionVerdict,
  m45Ci: ci,
  gateReadings: readings,
  problems,
  knownGateRegressions: [] as { gate: string; detail: string }[],
  baselineAlreadyFailing: {
    claimed: false,
    note:
      '计划书 WP9 只允许在"有可复现证据证明 baseline 本来就失败"时，' +
      '才不把既有 Hard Gate 退化算作 M5.1 FAIL。本轮**没有**主张这一例外：' +
      '所有既有 Hard Gate 都是 PASS，没有任何退化。',
  },
  notRun: [
    '真实 Langfuse / OpenLIT 部署（G-06；只有 OTLP 协议 spike）',
    '浏览器端 DOM 渲染自动化（本仓库无浏览器测试设施）',
    '生产库的 destructive smoke（AT: 只允许副本）',
  ],
}

const out = join(ART, 'regression-evidence.json')
writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

const line = '='.repeat(72)
console.log(line)
console.log('M5.1 WP9 全量回归')
console.log(line)
console.log(`  m4.5:ci           exit=${ci.exitCode}  编码=${ci.logEncoding}  逐门小结=${ci.gateSummaries.length} 条  硬门=${ci.hardGates.length} 条`)
for (const gate of ci.hardGates) {
  console.log(`    ${gate.status === 'PASS' ? '✅' : '❌'} ${gate.id} ${gate.label} → ${gate.status} (${gate.passed} 通过 / ${gate.failed} 失败)`)
}
for (const reading of readings) {
  console.log(`  ${reading.verdict === 'PASS' ? '✅' : '❌'} ${reading.id} ${reading.verdictField}=${reading.verdict}`)
}
console.log('')
if (problems.length === 0) {
  console.log('全量回归判定：PASS')
} else {
  console.log('全量回归判定：FAIL')
  for (const problem of problems) console.log(`  ❌ ${problem}`)
}
console.log(`证据已写入：${out}`)

process.exit(regressionVerdict === 'PASS' ? 0 : 1)
