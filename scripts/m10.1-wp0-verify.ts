/**
 * M10.1 WP0 —— **基线门**（`m10.1:wp0:verify`）。
 *
 * ============================================================================
 *  它守什么（全是**离线**判据；WP0 **不开任何数据库**）
 * ============================================================================
 * ```text
 * B1 三份设计文档都在，且**状态已冻结**（`ACCEPTED / DESIGN FROZEN`）—— 未批准不得开工
 * B2 ADR 的 `D01`…`D13` 与契约的 `A1`…`A14` **编号连续、无缺号**
 * B3 `L-M11-10` 的四处指针**真的存在**（字段 · 网关读取点 · 装配层未传 · flags 注释）
 * B4 契约的"不主张"清单**五条齐全**
 * B5 计划里每个 WP 都有具名门，且**本门已登记**在 `package.json`
 * B6 只读纪律：本门**不**打开任何数据库（只读文件 + 只读 git）
 * ```
 * ⚠️ 纯离线：只 `node:fs` / `node:path` / `node:child_process`(git) —— 不 import 任何数据库模块。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'

const REPO_ROOT = resolve(process.cwd())
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const ADR = 'docs/adr/ADR-086-m10.1-agreement-bridge.md'
const PLAN = 'docs/m10.1/M10.1-Execution-Plan.md'
const CONTRACT = 'docs/m10.1/M10.1-Acceptance-Contract.md'
const BASELINE = 'docs/m10.1/M10.1-WP0-Baseline.md'

// --- B1 三份文档在 + 已冻结 -------------------------------------------------
const missing = [ADR, PLAN, CONTRACT, BASELINE].filter((path) => !existsSync(join(REPO_ROOT, path)))
const frozen = [ADR, PLAN, CONTRACT].every((path) => read(path).includes('ACCEPTED / DESIGN FROZEN'))
record(
  'B1',
  '三份设计文档都在，且状态已冻结为 `ACCEPTED / DESIGN FROZEN`（未批准不得开工）',
  missing.length === 0 && frozen,
  `缺=${JSON.stringify(missing)} · 三份都冻结=${String(frozen)}`
)

// --- B2 决策编号连续 -------------------------------------------------------
const adrText = read(ADR)
const contractText = read(CONTRACT)
const decisionNumbers = [...adrText.matchAll(/^### D(\d{2}) ·/gm)].map((match) => Number(match[1]))
const expectedDecisions = Array.from({ length: 13 }, (_, index) => index + 1)
const decisionsOk =
  decisionNumbers.length === expectedDecisions.length &&
  expectedDecisions.every((number) => decisionNumbers.includes(number))
const contractNumbers = [...contractText.matchAll(/^\|\s\*\*A(\d+)\*\*\s*\|/gm)].map((match) => Number(match[1]))
const expectedCriteria = Array.from({ length: 14 }, (_, index) => index + 1)
const criteriaOk =
  contractNumbers.length === expectedCriteria.length &&
  expectedCriteria.every((number) => contractNumbers.includes(number))
record(
  'B2',
  'ADR 的 `D01`…`D13` 与契约的 `A1`…`A14` 编号连续、无缺号',
  decisionsOk && criteriaOk,
  `决策=${JSON.stringify(decisionNumbers)} · 判据=${JSON.stringify(contractNumbers)}`
)

// --- B3 L-M11-10 的四处指针真的存在 ----------------------------------------
const selector = read('src/kernel/recall/selector.ts')
const gateway = read('src/kernel/app/turn-gateway.ts')
const mainTs = read('src/main.ts')
const flags = read('src/kernel/app/flags.ts')
const pointerField = /goalTokens: number/.test(selector)
const pointerRead = /recallBudget \?\? DEFAULT_CONTEXT_BUDGET\)\.goalTokens/.test(gateway)
/*
 * ⚠️ 「装配层未传」是**当前状态**的断言：M10.1 WP4 销账之后，这一条**应当翻转为"已传"**。
 *    所以本门把两种状态都算 PASS，但**要求基线文档写清是哪一种**（否则销账就成了悄悄改判据）。
 */
const mainPassesGoalTokens = /goalTokens: this\.flags\.goalTokens/.test(mainTs)
const baselineSaysGap = read(BASELINE).includes('`recallBudget` 只传了 `adaptiveSelfTokens`')
const pointerNote = flags.includes('L-M11-10')
record(
  'B3',
  '`L-M11-10` 的四处指针都在（字段 · 网关读取点 · flags 注释 · 装配层状态有记录）',
  pointerField && pointerRead && pointerNote && baselineSaysGap,
  `字段=${String(pointerField)} · 网关读取=${String(pointerRead)} · flags 注释=${String(pointerNote)} · 基线记录装配层状态=${String(baselineSaysGap)} · 装配层当前已传=${String(mainPassesGoalTokens)}`
)

// --- B4 不主张清单五条齐全 -------------------------------------------------
const disclaimers = [
  '不**主张"她不再重复同一件事"',
  '不**主张"她能判断他到底有没有到场"',
  '不**主张"到期 = 失约"',
  '不**主张"约定一定被识别"',
  '不**主张"这修好了 M11 的 `L-M11-40`',
]
const missingDisclaimers = disclaimers.filter((text) => !contractText.includes(text))
record(
  'B4',
  '契约的"不主张"清单**五条齐全**',
  missingDisclaimers.length === 0,
  `缺=${JSON.stringify(missingDisclaimers)}`
)

// --- B5 计划里每个 WP 都有具名门 + 本门已登记 ------------------------------
const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
const plannedGates = [...read(PLAN).matchAll(/`(m10\.1:[a-z0-9.:-]+)`/g)].map((match) => match[1]!)
const uniquePlanned = [...new Set(plannedGates)]
const unregistered = uniquePlanned.filter((name) => packageJson.scripts[name] === undefined)
const selfRegistered = packageJson.scripts['m10.1:wp0:verify'] !== undefined
record(
  'B5',
  '计划里的门名都能解析，且**本门已登记**在 `package.json`（未登记的门名单独列出）',
  selfRegistered && uniquePlanned.length > 0,
  `本门已登记=${String(selfRegistered)} · 计划提及的门 ${String(uniquePlanned.length)} 个 · 尚未登记=${JSON.stringify(unregistered)}`
)

// --- B6 只读纪律 -----------------------------------------------------------
record(
  'B6',
  '本门**不打开任何数据库**（纯文件 + git 只读；WP0 不碰真实库）',
  !/from '\.\.\/src\/(db|infrastructure)/.test(read('scripts/m10.1-wp0-verify.ts')),
  '源码里没有 src/db 或 src/infrastructure 的 import'
)

const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp0', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-wp0-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  designStatus: 'ACCEPTED / DESIGN FROZEN（2026-10-01 用户逐字「行就这么干」）',
  pointers: { pointerField, pointerRead, pointerNote, mainPassesGoalTokens, baselineSaysGap },
  plannedGates: uniquePlanned,
  unregisteredGates: unregistered,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer: '本门只守**基线与纪律**；它不主张任何行为效果（效果见契约 A11 的对照读数）。',
}
writeFileSync(join(dir, 'wp0-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp0',
  head,
  headShort: head.slice(0, 12),
  branch: 'codex/m11-execution-plan',
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'baseline-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['offline'],
  supersedes: null,
  notes: `m10.1:wp0:verify（离线基线门 · 装配层当前已传 goalTokens=${String(mainPassesGoalTokens)}）`,
})

console.log(`runId: ${runId}`)
console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
process.exit(failed.length === 0 ? 0 : 1)
