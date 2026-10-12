/**
 * M9.6 —— **只读汇总门**（`pnpm m9.6:gates`）。
 *
 * ============================================================================
 *  纪律（本仓最容易被违反的一条）
 * ============================================================================
 * ```text
 * · 它**只读**已落盘的证据文件；**不跑**任何门、**不写**任何东西、**不联网**。
 * · 文件不存在 ⇒ **NOT RUN**，**不是 PASS**（AGENTS.md §6.4）。
 * · 证据存在但读不动 / 判据不过 ⇒ **INVALID**（拒收），不是"当作没看见"。
 * · 未实现的 WP **如实列 NOT RUN 并写出它属于哪个 WP**，不用假档凑数。
 * ```
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = resolve('.')
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm9.6')

interface GateSpec {
  readonly gate: string
  readonly wp: string
  /** 固定相对路径；与 `resolveFile` 二选一 */
  readonly file?: string
  /** 动态定位（例如"最新一次 compare 运行"）；与 `file` 二选一 */
  readonly resolveFile?: () => string | null
  /** 该证据是否**现在就该有档**（false = 属于尚未执行的 WP ⇒ 缺档是 NOT RUN 而非缺陷） */
  readonly requiredNow: boolean
  /**
   * ★ 完全自定义校验。给了它就**不再**套用通用判据（`passed`/`failed`）——
   *   因为对照运行的证据形状与组件级门不同（它没有"通过/失败计数"）。
   *   返回空数组 = 判据成立。⚠️ 它只判**证据是否齐备、形状是否正确**，
   *   **不判质量**（质量在报告里，不在这道门里）。
   */
  readonly validate?: (evidence: Record<string, unknown>) => string[]
  /** 除 `failed === 0` 之外的附加判据（仅用于组件级门） */
  readonly extra?: (evidence: Record<string, unknown>) => string | null
}

/** 最新一次对照运行目录（按名字排序取最后；runId 里含序号/时间） */
function latestRunIn(subdir: string, preferPrefix?: string): string | null {
  try {
    const entries = readdirSync(join(EVIDENCE_DIR, subdir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    /* ★ 有正式拆分（`test-*`）时**优先**读它 —— 否则"取字典序最后"会随目录名偶然变化 */
    const preferred = preferPrefix === undefined ? [] : entries.filter((name) => name.startsWith(preferPrefix))
    const pool = preferred.length > 0 ? preferred : entries
    return pool.length === 0 ? null : join(EVIDENCE_DIR, subdir, pool[pool.length - 1] as string, 'metrics.json')
  } catch {
    return null
  }
}

const latestCompareRun = (): string | null => latestRunIn('compare')
const latestAuditRun = (): string | null => latestRunIn('audit-compare', 'test-')

const GATE_SPECS: readonly GateSpec[] = [
  {
    gate: 'm9.6-audit-parser@1',
    wp: 'WP0a',
    file: 'audit-parser.json',
    requiredNow: true,
    extra: (evidence) => {
      const counts = evidence.rawOutcomeCounts as Record<string, number> | undefined
      if (counts === undefined) return '缺 rawOutcomeCounts'
      const zero = Object.entries(counts).filter(([, value]) => value === 0).map(([key]) => key)
      return zero.length === 0 ? null : `四态中未触达：${zero.join(',')}（MEASUREMENT INVALID）`
    },
  },
  {
    gate: 'm9.6-contract-tests@1',
    wp: 'WP2',
    file: 'contract-tests.json',
    requiredNow: true,
    extra: (evidence) => {
      const unReached = evidence.unReachedCodes as string[] | undefined
      if (unReached === undefined) return '缺 unReachedCodes'
      if (unReached.length > 0) return `失败码有死分支：${unReached.join(',')}`
      const egress = evidence.realEgressAttempts as number | undefined
      return egress === 0 ? null : `真实出站不为 0：${String(egress)}`
    },
  },
  {
    gate: 'm9.6-measurement@1',
    wp: 'WP2',
    file: 'measurement.json',
    requiredNow: true,
    extra: (evidence) => {
      const negative = evidence.negativeControls as Record<string, unknown> | undefined
      if (negative === undefined) return '缺 negativeControls（伪通过负控）'
      return null
    },
  },
  {
    gate: 'm9.6-preflight@1',
    wp: 'WP3',
    file: 'preflight.json',
    requiredNow: true,
    extra: (evidence) => {
      const verdict = evidence.verdict
      if (verdict !== 'USABLE') return `预检结论 = ${String(verdict)}（不是 USABLE）`
      const calls = evidence.callsUsed as number | undefined
      const budget = evidence.callBudget as number | undefined
      if (calls === undefined || budget === undefined) return '缺调用预算读数'
      return calls <= budget ? null : `调用 ${String(calls)} 超预算 ${String(budget)}`
    },
  },
  {
    gate: 'm9.6-compare@1',
    wp: 'WP4',
    resolveFile: latestCompareRun,
    requiredNow: true,
    validate: (evidence) => {
      const reasons: string[] = []
      const metrics = evidence.metrics as Record<string, { mainReading?: { endToEndDenominator?: number } }> | undefined
      if (metrics === undefined) return ['缺 metrics']
      for (const arm of ['A', 'J'] as const) {
        const entry = metrics[arm]
        if (entry === undefined) {
          reasons.push(`缺 ${arm} 列读数`)
          continue
        }
        const denominator = entry.mainReading?.endToEndDenominator ?? 0
        /* ⚠️ 分母为 0 与"跑过"在输出上长得一样 ⇒ 必须显式拒绝 */
        if (denominator === 0) reasons.push(`${arm} 列主分母为 0（NOT RUN，不能当 PASS）`)
      }
      /* B 列允许 NOT RUN（计划 §6.2），但**必须**如实登记在案 */
      if (metrics.B === undefined) reasons.push('缺 B 列的 NOT RUN 登记（B 不可用必须可见，不许静默省略）')
      return reasons
    },
    extra: () => null,
  },
  {
    gate: 'm9.6-audit-compare@1',
    wp: 'WP4a',
    resolveFile: latestAuditRun,
    requiredNow: false,
    validate: (evidence) => {
      const reasons: string[] = []
      const metrics = evidence.metrics as
        | {
            layer1?: Record<string, { notRun?: boolean; accuracyOverAllCases?: { notRun?: boolean; denominator?: number } }>
            layer2?: Record<string, { notRun?: boolean; extraction?: { totalKeyClaims?: number } }>
          }
        | undefined
      if (metrics === undefined) return ['缺 metrics']
      /* ① 层：至少一列真跑过且分母非零 */
      const layer1Arms = Object.entries(metrics.layer1 ?? {})
      const layer1Usable = layer1Arms.some(
        ([, entry]) => entry.notRun !== true && entry.accuracyOverAllCases?.notRun !== true && (entry.accuracyOverAllCases?.denominator ?? 0) > 0
      )
      if (layer1Arms.length === 0) reasons.push('缺第一层读数（应与 NOT RUN 分开登记）')
      else if (!layer1Usable) reasons.push('第一层没有任何分母非零的读数 ⇒ NOT RUN，不能当 PASS')
      /* ② 层：提取覆盖必须有非零分母（覆盖 0 条主张与"没量"长得一样） */
      for (const [arm, entry] of Object.entries(metrics.layer2 ?? {})) {
        if (entry.notRun === true) continue
        const total = entry.extraction?.totalKeyClaims ?? 0
        if (total === 0) reasons.push(`第二层 ${arm} 的 keyClaim 分母为 0 ⇒ MEASUREMENT INVALID`)
      }
      return reasons
    },
  },
  { gate: 'm9.6-shadow@1', wp: 'WP5', file: 'shadow.json', requiredNow: false },
]

interface Reading {
  readonly gate: string
  readonly wp: string
  readonly requiredNow: boolean
  readonly verdict: 'PASS' | 'INVALID' | 'NOT RUN'
  readonly reasons: readonly string[]
  readonly head?: string
  readonly passed?: number
  readonly failed?: number
}

function readEvidence(path: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, reason: `artifacts/m9.6/ 下没有该档（${path.split(/[\\/]/).slice(-2).join('/')}）` }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: '证据不是对象' }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, reason: '证据不是合法 JSON（读不动 ⇒ INVALID）' }
  }
}

function headCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function isAncestor(commit: string, head: string): boolean | null {
  if (commit === head) return true
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, head], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch (error) {
    /* exit 1 = 非祖先；其它（如未知提交）⇒ 无法判定 */
    return (error as { status?: number }).status === 1 ? false : null
  }
}

const readings: Reading[] = []
const head = headCommit()

for (const spec of GATE_SPECS) {
  const resolved = spec.resolveFile !== undefined ? spec.resolveFile() : join(EVIDENCE_DIR, spec.file as string)
  if (resolved === null) {
    readings.push({
      gate: spec.gate,
      wp: spec.wp,
      requiredNow: spec.requiredNow,
      verdict: 'NOT RUN',
      reasons: ['（动态定位）artifacts/m9.6/compare/ 下没有任何运行目录'],
    })
    continue
  }
  const result = readEvidence(resolved)
  if (!result.ok) {
    readings.push({ gate: spec.gate, wp: spec.wp, requiredNow: spec.requiredNow, verdict: 'NOT RUN', reasons: [result.reason] })
    continue
  }
  const evidence = result.value
  const reasons: string[] = []

  /* 给了 `validate` 就用它自己的判据；组件级门才套 `passed`/`failed` */
  const custom = spec.validate !== undefined
  const failed = typeof evidence.failed === 'number' ? evidence.failed : null
  const passed = typeof evidence.passed === 'number' ? evidence.passed : null
  if (!custom) {
    if (failed === null) reasons.push('缺 `failed` 计数')
    else if (failed !== 0) reasons.push(`失败 ${String(failed)} 项`)
    /* 计数型自检：`passed === 0` 与"全部通过"在输出上长得一样 ⇒ 拒绝 PASS */
    if (passed !== null && passed === 0) reasons.push('`passed` 为 0 ⇒ MEASUREMENT INVALID（不是"没有失败"）')
  }

  if (spec.validate !== undefined) {
    reasons.push(...spec.validate(evidence))
  } else if (spec.extra !== undefined) {
    const extraReason = spec.extra(evidence)
    if (extraReason !== null) reasons.push(extraReason)
  }

  const evidenceHead = typeof evidence.head === 'string' ? evidence.head : undefined
  if (evidenceHead !== undefined && head !== null) {
    const ancestor = isAncestor(evidenceHead, head)
    if (ancestor === false) reasons.push(`证据 head ${evidenceHead.slice(0, 10)} 不是当前 HEAD 的祖先（错版本档）`)
    else if (ancestor === null) reasons.push(`无法判定证据 head ${evidenceHead.slice(0, 10)} 与当前 HEAD 的关系`)
  }

  readings.push({
    gate: spec.gate,
    wp: spec.wp,
    requiredNow: spec.requiredNow,
    verdict: reasons.length === 0 ? 'PASS' : 'INVALID',
    reasons,
    head: evidenceHead,
    passed: passed ?? undefined,
    failed: failed ?? undefined,
  })
}

/* ---- 输出 ---- */
console.log('M9.6 只读汇总门（`pnpm m9.6:gates`）—— 只读已落盘证据，不跑门、不写文件\n')
for (const reading of readings) {
  const mark = reading.verdict === 'PASS' ? '✅' : reading.verdict === 'INVALID' ? '❌' : '·'
  const counts = reading.passed === undefined ? '' : ` · ${String(reading.passed)}/${String((reading.passed ?? 0) + (reading.failed ?? 0))}`
  console.log(`  ${mark} ${reading.gate.padEnd(26)} ${reading.wp.padEnd(5)} ${reading.verdict.padEnd(8)}${counts}`)
  for (const reason of reading.reasons) console.log(`      ↳ ${reason}`)
}

const requiredNow = readings.filter((reading) => reading.requiredNow)
const present = requiredNow.filter((reading) => reading.verdict !== 'NOT RUN')
const invalid = requiredNow.filter((reading) => reading.verdict === 'INVALID')
const notRun = readings.filter((reading) => reading.verdict === 'NOT RUN')

console.log(
  `\n  本阶段应已有档：${String(present.length)}/${String(requiredNow.length)} · INVALID：${String(invalid.length)}` +
    ` · 未实现/未跑（各属其 WP）：${String(notRun.length)}`
)
for (const reading of notRun) console.log(`      · ${reading.gate}（${reading.wp}）NOT RUN`)
console.log(`\n  Hard Gates = ${requiredNow.length > 0 && invalid.length === 0 && present.length === requiredNow.length ? 'PASS' : 'NOT PASS'}`)
console.log('  ⚠️ 未实现的 WP（WP4 / WP4a / WP5）**不是**"未通过"，而是**未执行**；不得读成达标或失败。')
console.log('  ⚠️ 本门**不**含任何质量结论：质量在 WP4 的冻结语料上才产生。')

console.log(
  `\n${JSON.stringify({
    schemaVersion: 'm9.6-gates@1',
    overall: requiredNow.length > 0 && invalid.length === 0 && present.length === requiredNow.length ? 'PASS' : 'NOT PASS',
    requiredNow: { present: present.length, total: requiredNow.length },
    invalid: invalid.map((reading) => ({ gate: reading.gate, reasons: reading.reasons })),
    notRun: notRun.map((reading) => ({ gate: reading.gate, wp: reading.wp })),
    readings: readings.map((reading) => ({
      gate: reading.gate,
      wp: reading.wp,
      requiredNow: reading.requiredNow,
      verdict: reading.verdict,
      reasons: reading.reasons,
    })),
  })}`
)

process.exit(invalid.length > 0 || present.length !== requiredNow.length ? 1 : 0)
