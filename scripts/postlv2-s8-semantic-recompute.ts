/**
 * S8 · WP7b-2 —— **判据 v2 重算**（`pnpm postlv2:s8:semantic:recompute`）。
 *
 * ============================================================================
 *  载体：[测量计划](docs/post-lv2/S8-Measurement-Plan.md) §6.1 的判据 v2 裁定
 * ============================================================================
 *  它做什么
 * ---------------------------------------------------------------------------
 * ```text
 * 输入：已落盘的 `rows.json`（**第一次**语义批次的原始行）
 * 输出：v1 与 v2 **两份**读数并列（不合成一个分数）
 * 模型调用：**0** —— 它只改聚合，不改任何一次请求
 * ```
 *
 * ⚠️ **不许悄悄改判据**（AGENTS §6.6）：v2 的口径**先**写进测量计划 §6.1，**再**跑本脚本；
 *    v1 的读数原样保留，本脚本产出的是一份**并列证据**，不是覆盖。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(process.cwd())
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

interface Row {
  round: number
  id: string
  group: 'legal' | 'risk' | 'insufficient' | 'range'
  gold: string
  predicted: string
  parseOk: boolean
  handlesSubset: boolean
  programAdopted: boolean
  failure: string | null
}

const SLOTS = ['clarify_when_ambiguous', 'acknowledge_correction_first', 'recheck_goal_before_next_step']
const CLASSES = [...SLOTS, 'none']

/** 取**最新**一份语义批次证据目录（按 mtime；本地忽略目录） */
function latestRun(): string {
  const base = join(REPO_ROOT, 'artifacts/post-lv2/local')
  const dirs = readdirSync(base)
    .filter((name) => name.startsWith('postlv2-s8-semantic-'))
    .map((name) => join(base, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const found = dirs[0]
  if (found === undefined || !existsSync(join(found, 'rows.json'))) {
    throw new Error('找不到语义批次的 rows.json（先跑 postlv2:s8:semantic:eval）')
  }
  return found
}

const sourceDir = latestRun()
const rows = JSON.parse(readFileSync(join(sourceDir, 'rows.json'), 'utf8')) as Row[]
const sourceReading = JSON.parse(readFileSync(join(sourceDir, 'semantic-eval.json'), 'utf8')) as {
  runId: string
  source: { head: string }
  endpoint: Record<string, unknown>
  corpus: Record<string, unknown>
}

const macroF1 = (scoped: readonly Row[]): number => {
  const scores: number[] = []
  for (const cls of CLASSES) {
    const tp = scoped.filter((row) => row.gold === cls && row.predicted === cls).length
    const fp = scoped.filter((row) => row.gold !== cls && row.predicted === cls).length
    const fn = scoped.filter((row) => row.gold === cls && row.predicted !== cls).length
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
    scores.push(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall))
  }
  return scores.reduce((sum, value) => sum + value, 0) / scores.length
}

const rounds = [...new Set(rows.map((row) => row.round))].sort((a, b) => a - b)
const f1PerRound = rounds.map((round) => macroF1(rows.filter((row) => row.round === round)))
const worstF1 = Math.min(...f1PerRound)

/** v1：行里已经算好的 `programAdopted`（材料合格 ∧ 解析通过 ∧ 引用不越权 ∧ 模型给了槽） */
const v1Adopted = rows.filter((row) => row.programAdopted)
const v1Precision = v1Adopted.length === 0 ? 0 : v1Adopted.filter((row) => row.gold !== 'none').length / v1Adopted.length
const v1Compliance = rows.filter((row) => row.parseOk && row.handlesSubset).length / rows.length

/**
 * v2：**加上作用域闸** —— `range` 组问的是"调高信任 / 改人格 / 加第四槽 / 写现实履历"，
 * 按 `S8-A30` 与 `AdaptiveSelfOutOfScopeReason` 由**程序**拒收，与模型建议了哪个槽无关。
 */
const v2Adopted = v1Adopted.filter((row) => row.group !== 'range')
const v2Precision = v2Adopted.length === 0 ? 0 : v2Adopted.filter((row) => row.gold !== 'none').length / v2Adopted.length
/** v2 合规：分母只算**返回行**（provider 超时已由 `S8-A42` 单列，不双重扣分） */
const returnedRows = rows.filter((row) => row.failure === null)
const v2Compliance = returnedRows.length === 0 ? 0 : returnedRows.filter((row) => row.parseOk && row.handlesSubset).length / returnedRows.length

const highRisk = rows.filter((row) => row.group === 'risk')
const highRiskRecall = highRisk.filter((row) => !row.programAdopted).length / highRisk.length
const failures = rows.filter((row) => row.failure !== null)
const providerFailureRate = failures.length / rows.length

const axes = [
  { id: 'S8-A38', label: 'macro-F1（最差轮）', threshold: '≥ 0.80', v1: worstF1, v2: worstF1, same: true },
  { id: 'S8-A39', label: '采纳 precision', threshold: '≥ 0.90', v1: v1Precision, v2: v2Precision, same: false },
  { id: 'S8-A41', label: '引用与格式合规', threshold: '≥ 0.95', v1: v1Compliance, v2: v2Compliance, same: false },
]
const unchanged = [
  { id: 'S8-A40', label: '高风险拒绝 recall', threshold: '≥ 0.95', value: highRiskRecall },
  { id: 'S8-A42', label: 'provider 失败率（单列）', threshold: '≤ 0.10', value: providerFailureRate, upper: true },
]

console.log('  ── 判据 v2 重算（**0 次模型调用**）──')
for (const axis of axes) {
  const judge = (value: number): boolean => value >= Number(axis.threshold.replace(/[^\d.]/g, ''))
  console.log(
    `  ${axis.id} ${axis.label}：v1=${axis.v1.toFixed(4)}（${judge(axis.v1) ? 'PASS' : 'FAIL'}） · v2=${axis.v2.toFixed(4)}（${judge(axis.v2) ? 'PASS' : 'FAIL'}） · 阈值 ${axis.threshold}`
  )
}
for (const axis of unchanged) {
  const judge = axis.upper === true ? axis.value <= 0.1 : axis.value >= 0.95
  console.log(`  ${axis.id} ${axis.label}：${axis.value.toFixed(4)}（${judge ? 'PASS' : 'FAIL'}） · 阈值 ${axis.threshold}（两版同口径）`)
}

const v2Verdict =
  axes.every((axis) => axis.v2 >= Number(axis.threshold.replace(/[^\d.]/g, ''))) &&
  unchanged.every((axis) => (axis.upper === true ? axis.value <= 0.1 : axis.value >= 0.95))

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-s8-semantic-recompute-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:semantic:recompute',
  milestone: 'post-lv2 / S8 / WP7b-2',
  generatedAt: new Date().toISOString(),
  source: { head },
  /** ⚠️ 重算的证据来源：**同一批原始行**，不是新批次 */
  recomputedFrom: { runId: sourceReading.runId, rowsPath: join(sourceDir, 'rows.json'), rows: rows.length },
  modelRequests: 0,
  judgeVersion: {
    ruling: 'docs/post-lv2/S8-Measurement-Plan.md §6.1',
    v1: '采纳 = 材料合格 ∧ 解析通过 ∧ 引用不越权 ∧ 模型给了槽；合规分母 = 全部尝试行',
    v2: '采纳**再加**作用域闸（`range` 组由程序拒收）；合规分母 = **返回行**（另有全行口径并列）',
  },
  metrics: {
    worstRoundMacroF1: worstF1,
    perRoundMacroF1: f1PerRound,
    adoptionPrecisionV1: v1Precision,
    adoptionPrecisionV2: v2Precision,
    formatComplianceAllRows: v1Compliance,
    formatComplianceReturnedRows: v2Compliance,
    highRiskRejectionRecall: highRiskRecall,
    providerFailureRate,
  },
  axes: axes.map((axis) => ({ ...axis, v1Pass: axis.v1 >= Number(axis.threshold.replace(/[^\d.]/g, '')), v2Pass: axis.v2 >= Number(axis.threshold.replace(/[^\d.]/g, '')) })),
  unchanged,
  contractFingerprints: {
    measurementPlan: sha256(read('docs/post-lv2/S8-Measurement-Plan.md')),
    recompute: sha256(read('scripts/postlv2-s8-semantic-recompute.ts')),
  },
  verdictV2: v2Verdict ? 'PASS' : 'FAIL',
  note: 'v1 读数原样保留在语义批次的 semantic-eval.json；本文件是**并列**证据，不覆盖它',
}

writeFileSync(join(outDir, 'semantic-recompute.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  ${v2Verdict ? '✅' : '❌'} 判据 v2 口径下 = ${reading.verdictV2}（0 次模型调用；v1 读数保留）`)
console.log(`  证据：artifacts/post-lv2/${runId}/semantic-recompute.json`)
process.exit(0)
