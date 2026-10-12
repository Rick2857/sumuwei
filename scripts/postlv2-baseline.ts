/**
 * Post-Lv2 首版工程 —— **WP0 基线门**（`postlv2:baseline`）。
 *
 * ============================================================================
 *  它守什么（**全离线**；本门不开任何数据库、不发任何模型请求）
 * ============================================================================
 * ```text
 * B1 计划书在案，且 §0 的 2026-10-03 S1 修订（首个世界线 = 极创二面 + 经历进入长期认知）在位
 * B2 前置解除：ADR-090 `Lv2 = PASS` + 放行后待办表在案（不得回写 Lv2 旧判定）
 * B3 冻结载体四份齐备（ADR-091 / 执行计划 / 世界来源契约 / 媒体交付契约）+ 均已冻结
 * B4 裁决编号连续（ADR `D01…D13` 无缺号）
 * B5 依赖探针：inkjs 真的可安装且**编译器与运行器都能跑**（不是"文档说可以"）
 * B6 许可清单齐备（LG 自身 / inkjs / Open-LLM-VTuber / sherpa-onnx / CosyVoice / 皮套）
 * B7 FC-T04 的**阶段锁演进**已落地：世界实现存在，但"Character 不写世界事实"的负控仍在
 * B8 只读纪律：本门**不**打开任何数据库（`data/pglite` 的 mtime/摘要只在报告里人工记录）
 * ```
 * ⚠️ 纯离线：只 `node:fs` / `node:path` / `node:child_process`。
 * ⚠️ 计数型自检（AGENTS.md §6.8）：`measured_count` 必须 > 0，否则报 MEASUREMENT INVALID。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { probeInkDependency } from '../src/infrastructure/storyline/ink-runtime.ts'

const REPO_ROOT = resolve(process.cwd())
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')
const has = (relative: string): boolean => existsSync(join(REPO_ROOT, relative))

const PLAN = 'docs/research/Post-Lv2-Storyline-Embodiment-Realtime-Plan-2026-10-02.md'
const ADR = 'docs/adr/ADR-091-post-lv2-world-boundary-and-story-source.md'
const EXEC = 'docs/post-lv2/Post-Lv2-Execution-Plan.md'
const SOURCE_CONTRACT = 'docs/post-lv2/Post-Lv2-Story-World-Source-Contract.md'
const MEDIA_CONTRACT = 'docs/post-lv2/Post-Lv2-Media-Delivery-Contract.md'
const BASELINE_DOC = 'docs/post-lv2/Post-Lv2-WP0-Baseline.md'
const LICENSE_DOC = 'docs/post-lv2/Post-Lv2-Dependency-and-License-Freeze.md'

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// ---------------------------------------------------------------------------
// B1 计划书 + S1 修订
// ---------------------------------------------------------------------------
const planText = has(PLAN) ? read(PLAN) : ''
const s1Revision = /2026-10-03 S1 用户修订/.test(planText)
const jichuang = /一起去参加极创工作室的二面/.test(planText)
const persisted = /故事中的经历属于同一个苏沐薇的长期历史/.test(planText)
record(
  'B1',
  '计划书在案，§0 的 S1 修订（极创二面 + 经历进入长期认知）在位',
  planText.length > 0 && s1Revision && jichuang && persisted,
  `字节=${planText.length} · S1修订=${String(s1Revision)} · 极创二面=${String(jichuang)} · 长期历史=${String(persisted)}`,
  [s1Revision, jichuang, persisted].filter(Boolean).length
)

// ---------------------------------------------------------------------------
// B2 前置：Lv2 已放行（状态修订，不回写旧判定）
// ---------------------------------------------------------------------------
const adr090 = has('docs/adr/ADR-090-lv2-risk-acceptance-release.md')
  ? read('docs/adr/ADR-090-lv2-risk-acceptance-release.md')
  : ''
const deferred = has('docs/lv2/Lv2-Deferred-After-Release-2026-10-03.md')
const lv2Released = adr090.includes('Lv2 = PASS') && adr090.includes('ACCEPTED / EXECUTED') && deferred
const noRewrite = adr090.includes('不由本裁定改成 PASS')
record(
  'B2',
  '前置解除：ADR-090 放行在位 + 放行后待办表在案，且不把 M9/M11.1 相关门的旧判定改写成 PASS',
  lv2Released && noRewrite,
  `放行=${String(lv2Released)} · 不回写声明=${String(noRewrite)}`,
  [lv2Released, noRewrite].filter(Boolean).length
)

// ---------------------------------------------------------------------------
// B3 冻结载体四份齐备
// ---------------------------------------------------------------------------
const CARRIERS = [ADR, EXEC, SOURCE_CONTRACT, MEDIA_CONTRACT, BASELINE_DOC, LICENSE_DOC]
const missingCarriers = CARRIERS.filter((path) => !has(path))
const frozenCarriers = [ADR, EXEC, SOURCE_CONTRACT, MEDIA_CONTRACT].filter(
  (path) => has(path) && read(path).includes('ACCEPTED / DESIGN FROZEN')
)
record(
  'B3',
  '冻结载体六份齐备，其中设计四份状态为 `ACCEPTED / DESIGN FROZEN`',
  missingCarriers.length === 0 && frozenCarriers.length === 4,
  `缺=${JSON.stringify(missingCarriers)} · 已冻结=${frozenCarriers.length}/4`,
  [missingCarriers.length === 0, frozenCarriers.length === 4].filter(Boolean).length
)

// ---------------------------------------------------------------------------
// B4 ADR 裁决编号连续 D01…D13
// ---------------------------------------------------------------------------
const adrText = has(ADR) ? read(ADR) : ''
const decisions = [...adrText.matchAll(/^### D(\d{2}) ·/gm)].map((m) => Number(m[1]))
const expected = Array.from({ length: 13 }, (_, i) => i + 1)
const decisionsOk =
  decisions.length === expected.length && expected.every((n) => decisions.includes(n))
record(
  'B4',
  'ADR-091 的 `D01`…`D13` 编号连续、无缺号',
  decisionsOk,
  `实读=${JSON.stringify(decisions)}`,
  decisions.length
)

// ---------------------------------------------------------------------------
// B5 依赖探针：inkjs 编译器 + 运行器真的能跑
// ---------------------------------------------------------------------------
interface ProbeResult {
  ok: boolean
  version: string
  license: string
  detail: string
}
const probeInkjs = (): ProbeResult => {
  const pkgPath = join(REPO_ROOT, 'node_modules/inkjs/package.json')
  if (!existsSync(pkgPath)) return { ok: false, version: 'absent', license: 'absent', detail: 'inkjs 未安装' }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string; license?: string }
  /*
   * 探针本体在 `src/infrastructure/storyline/ink-runtime.ts` 里（**同一个进程**跑）。
   *
   * ⚠️ 为什么不像第一版那样 spawn 一个子进程写脚本：
   *   · `node -e` 的引号/花括号会被 PowerShell 转义（假阴性一次）；
   *   · 把脚本写到 `%TEMP%` 会让 `require('inkjs')` 解析不到（模块解析根是脚本位置，又假阴性一次）；
   *   · 写到 `node_modules/.cache` 仍然解析不到（同上）。
   * 同进程探针测的仍是**真实依赖**（不是 mock），而且没有这些问题。
   */
  const probe = probeInkDependency()
  return {
    ok: probe.ok,
    version: pkg.version ?? 'unknown',
    license: pkg.license ?? 'unknown',
    detail: probe.detail,
  }
}
const ink = probeInkjs()
record(
  'B5',
  '依赖探针：inkjs 已安装，且**编译器与运行器**都真的跑通（不是读文档推断）',
  ink.ok,
  `version=${ink.version} · license=${ink.license} · ${ink.detail}`,
  ink.ok ? 1 : 0
)

// ---------------------------------------------------------------------------
// B6 许可清单
// ---------------------------------------------------------------------------
const licText = has(LICENSE_DOC) ? read(LICENSE_DOC) : ''
const REQUIRED_LICENSES = ['inkjs', 'Open-LLM-VTuber', 'sherpa-onnx', 'CosyVoice', 'Live2D']
const licenseHits = REQUIRED_LICENSES.filter((name) => licText.includes(name))
record(
  'B6',
  '许可清单齐备（LG 自身 / inkjs / Open-LLM-VTuber / sherpa-onnx / CosyVoice / 皮套资源）',
  licenseHits.length === REQUIRED_LICENSES.length && /许可|LICENSE/.test(licText),
  `命中=${JSON.stringify(licenseHits)}`,
  licenseHits.length
)

// ---------------------------------------------------------------------------
// B7 FC-T04 阶段锁演进：世界实现存在 + 负控仍在
// ---------------------------------------------------------------------------
const fc = has('scripts/future-compat-tests.ts') ? read('scripts/future-compat-tests.ts') : ''
const hasWorldModule = has('src/kernel/storyline') || has('src/infrastructure/storyline')
const negativeControlKept = /Character\s*不(得|能)|worldWithdrawal|assertCharacterInternalScope/.test(fc)
const legacyStopConditionRetired =
  /阶段锁|PHASE_LOCK|FC_T04_WORLD_MODULE_BOUNDARY|post-lv2/i.test(fc) || !/forbidden = \[/.test(fc)
record(
  'B7',
  'FC-T04 阶段锁已演进：世界/故事模块存在，且"Character 不写世界事实"的负控与 scope 校验仍在',
  hasWorldModule && negativeControlKept && legacyStopConditionRetired,
  `世界模块=${String(hasWorldModule)} · 负控在=${String(negativeControlKept)} · 阶段锁已演进=${String(legacyStopConditionRetired)}`,
  [hasWorldModule, negativeControlKept, legacyStopConditionRetired].filter(Boolean).length
)

// ---------------------------------------------------------------------------
// B8 只读纪律（本门自身）
// ---------------------------------------------------------------------------
/*
 * ⚠️ 判据是**import 语句**，不是"文件里出现过 persistence 这个词"。
 * 第一版写成全文正则，结果它匹配到了本文件自己的一句中文说明
 * （"数据/持久化"相关词）—— 那是典型的"量错了东西"（AGENTS.md §6.9）。
 */
const source = read('scripts/postlv2-baseline.ts')
const importLines = source
  .split('\n')
  .filter((line) => /^\s*(import|export)\s.*from\s+['"]/.test(line))
const dbImport = importLines.filter((line) =>
  /(persistence|database|pglite|drizzle|@elizaos)/i.test(line)
)
record(
  'B8',
  '只读纪律：本门不 import 任何数据库模块、不打开 `data/pglite`',
  dbImport.length === 0 && importLines.length >= 3,
  `import 语句=${importLines.length} 条 · 命中数据库模块=${JSON.stringify(dbImport)}`,
  importLines.length
)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failed.length === 0

let head = 'unknown'
let dirty = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定，但会如实写进证据 */
}

const dataDir = join(REPO_ROOT, 'data/pglite')
let dataDirReading: Record<string, unknown> = { exists: existsSync(dataDir) }
if (existsSync(dataDir)) {
  const stat = statSync(dataDir)
  dataDirReading = {
    exists: true,
    mtimeMs: stat.mtimeMs,
    mtimeIso: new Date(stat.mtimeMs).toISOString(),
    note: 'data/ 被 gitignore，本门只用 mtime 记录"未被本门打开"，不用 git 证明',
  }
}

const runId = `postlv2-wp0-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:baseline',
  milestone: 'post-lv2 / WP0',
  generatedAt: new Date().toISOString(),
  source: { head, workingTreeDirty: dirty.length > 0, workingTreePorcelain: dirty.split('\n').filter(Boolean).slice(0, 60) },
  versions: {
    node: process.version,
    pnpm: safeVersion('pnpm -v'),
    platform: `${process.platform} ${process.arch}`,
  },
  planFingerprint: { path: PLAN, sha256: planText.length > 0 ? sha256(planText) : null, bytes: planText.length },
  dataDir: dataDirReading,
  dependencyProbe: { inkjs: ink },
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}

function safeVersion(command: string): string {
  try {
    return execFileSync(command, ['-v'], { cwd: REPO_ROOT, encoding: 'utf8', shell: true }).trim()
  } catch {
    return 'unknown'
  }
}

writeFileSync(join(outDir, 'wp0-baseline.json'), JSON.stringify(reading, null, 2), 'utf8')
writeFileSync(join(outDir, 'README.md'), baselineReadme(reading), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:baseline = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/wp0-baseline.json`)

function baselineReadme(value: typeof reading): string {
  const lines = [
    '# Post-Lv2 WP0 基线读数',
    '',
    `- runId：\`${value.runId}\``,
    `- 生成：${value.generatedAt}`,
    `- HEAD：\`${value.source.head}\` · 工作树脏：${String(value.source.workingTreeDirty)}`,
    `- 判定：**${value.verdict}** · measured_count = ${value.measuredCount}`,
    '',
    '| 检查 | 标签 | 结果 | 读数 |',
    '|---|---|---|---|',
    ...value.checks.map(
      (check) => `| ${check.id} | ${check.label} | ${check.pass ? 'PASS' : 'FAIL'} | ${check.detail.replace(/\|/g, '\\|')} |`
    ),
    '',
    '⚠️ 本门全离线：不打开任何数据库、不发任何模型请求。',
    '',
  ]
  return lines.join('\n')
}

process.exitCode = passed ? 0 : 1
