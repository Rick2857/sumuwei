/**
 * INC-01 **门结果汇总**（`pnpm inc-01:gates`）。
 *
 * ============================================================================
 *  它只做一件事：把**已经落盘**的证据读出来，摊平给人看
 * ============================================================================
 * ```text
 *   不跑测试        没有 spawn、没有 tsx、没有数据库、没有模型
 *   不改 verdict    它只**读**证据里的 verdict 字段，一个字节都不写回
 *   缺文件 = NOT RUN  文件不存在**不是** PASS（计划书 §7 / AGENTS §6.4）
 * ```
 *
 * 判据与计划书 §7 的验收矩阵一一对应（`G1`…`G9`），另外加两条 WP6 的离线门读数
 * （`L1` 部件、`L2` 聚合）—— 它们也是"必选"。
 *
 * ⚠️ `G9`（首次真实快照 / Real Source Safety）**在用户授权之前按设计是 NOT RUN**：
 *    那不是失败，是**未授权**。汇总里会把它单独说明。
 *
 * 用法：
 *   pnpm inc-01:gates              # 只打印
 *   pnpm inc-01:gates --write      # 额外写 artifacts/incidents/inc-01/gate-results.json
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve('.')
const ART = join(ROOT, 'artifacts/incidents/inc-01')

interface GateSpec {
  id: string
  label: string
  command: string
  required: boolean
  acceptVerdicts: readonly string[]
  evidence: string
  /** 尚未到能运行的时候时给出的理由（不是失败） */
  pendingReason?: string
}

export const INC01_GATE_SPECS: readonly GateSpec[] = [
  {
    id: 'L1',
    label: 'WP6 部件级（`inc-01:test`）',
    command: 'pnpm inc-01:test',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'inc-01-test.json',
  },
  {
    id: 'L2',
    label: 'WP1–WP5 门聚合（`inc-01:verify`）',
    command: 'pnpm inc-01:verify',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'verify-aggregate.json',
  },
  {
    id: 'G1',
    label: 'Single Owner —— 多进程真实路径租约',
    command: 'pnpm exec tsx scripts/verify-inc-01-wp1.ts',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'wp1-lease.json',
  },
  {
    id: 'G2',
    label: 'Quiescent Snapshot —— 复制一致性（静止源）',
    command: 'pnpm exec tsx scripts/verify-inc-01-wp2.ts',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'wp2-snapshot.json',
  },
  {
    id: 'G3',
    label: 'Snapshot Health —— 可恢复性（同一份 WP2 证据里的健康探针读数）',
    command: 'pnpm exec tsx scripts/verify-inc-01-wp2.ts',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'wp2-snapshot.json',
  },
  {
    id: 'G4',
    label: 'Lifecycle Close —— 退出耐久性（stop/close 各一次 + closed=true）',
    command: 'pnpm exec tsx scripts/verify-inc-01-wp3.ts',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'wp3-close.json',
  },
  {
    id: 'G5',
    label: 'Incident Hold —— 坏库保护（源从未被打开）',
    command: 'pnpm exec tsx scripts/verify-inc-01-wp4.ts',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'wp4-integration.json',
  },
  {
    id: 'G6',
    label: 'Restore Drill —— 恢复算法（quarantine + staging 原子切换）',
    command: 'pnpm exec tsx scripts/verify-inc-01-wp5.ts',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'wp5-restore-drill.json',
  },
  {
    id: 'G7',
    label: 'Measurement Truth —— 量具八步自证',
    command: 'pnpm inc-01:measurement:verify',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'measurement-self-test.json',
  },
  {
    id: 'G8',
    label: 'Regression —— 既有里程碑必跑门 EXIT 0',
    command: 'pnpm inc-01:regression:verify',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'regression.json',
    pendingReason: 'WP6 的全量回归（m4.5:ci / m5.1:gates / m5.5:gates …）尚未运行',
  },
  {
    id: 'G9',
    label: 'Real Source Safety —— 首次真实快照前后完整内容摘要逐字相同',
    command: 'pnpm inc-01:first-snapshot',
    required: true,
    acceptVerdicts: ['PASS'],
    evidence: 'first-real-snapshot.json',
    pendingReason: '**尚未授权**：首次真实快照是计划书 §WP6 的用户确认 STOP 动作',
  },
]

interface GateReading {
  id: string
  label: string
  command: string
  required: boolean
  acceptVerdicts: readonly string[]
  accepted: boolean
  evidencePath: string | null
  verdict: string
  checks: number
  failed: number
  measurementInvalid: number
  generatedAt: string | null
  head: string | null
  pendingReason?: string
}

function readEvidence(spec: GateSpec): GateReading {
  const path = join(ART, spec.evidence)
  const base: GateReading = {
    id: spec.id,
    label: spec.label,
    command: spec.command,
    required: spec.required,
    acceptVerdicts: spec.acceptVerdicts,
    accepted: false,
    evidencePath: null,
    verdict: 'NOT RUN',
    checks: 0,
    failed: 0,
    measurementInvalid: 0,
    generatedAt: null,
    head: null,
    ...(spec.pendingReason !== undefined ? { pendingReason: spec.pendingReason } : {}),
  }
  if (!existsSync(path)) return base
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return { ...base, evidencePath: relative(ROOT, path).split(/[\\/]/).join('/') }
  }
  const verdict = typeof parsed.verdict === 'string' ? parsed.verdict : 'NOT RUN'
  const measurements = (parsed.measurements ?? {}) as Record<string, unknown>
  const totals = (parsed.totals ?? {}) as Record<string, unknown>
  const hasChecksArray = Array.isArray(parsed.checks)
  const totalsRecord = (parsed.totals ?? {}) as Record<string, unknown>
  /*
   * 少数证据文件把断言记在别的字段里（口径不同，不是"没检查"）：
   *   · `first-real-snapshot.json`：8 条断言记在 `problems[]`（空 = 全过）
   * 这里显式声明，免得汇总器把它们印成 `checks=0` —— 那看起来像"检查了 0 项"。
   */
  const impliedChecks: Record<string, number> = { 'first-real-snapshot.json': 8 }
  const checks =
    typeof measurements.checks === 'number'
      ? measurements.checks
      : Array.isArray(parsed.checks)
        ? parsed.checks.length
        : typeof totalsRecord.checks === 'number'
          ? totalsRecord.checks
          : Array.isArray(parsed.gates)
            ? parsed.gates.length
            : typeof totalsRecord.steps === 'number'
              ? totalsRecord.steps
              : (impliedChecks[spec.evidence] ?? 0)
  const failed =
    typeof parsed.failed === 'number'
      ? parsed.failed
      : typeof measurements.failed === 'number'
        ? measurements.failed
        : typeof totalsRecord.failed === 'number'
          ? totalsRecord.failed
          : Array.isArray(parsed.problems)
            ? parsed.problems.length
            : Array.isArray(parsed.steps)
              ? (parsed.steps as { fired?: boolean }[]).filter((step) => step.fired === false).length
              : hasChecksArray
                ? (parsed.checks as { pass?: boolean }[]).filter((c) => c.pass === false).length
                : 0
  const measurementInvalid =
    typeof parsed.measurementInvalid === 'number'
      ? parsed.measurementInvalid
      : typeof measurements.measurementInvalid === 'number'
        ? measurements.measurementInvalid
        : 0
  return {
    ...base,
    accepted: spec.acceptVerdicts.includes(verdict),
    evidencePath: relative(ROOT, path).split(/[\\/]/).join('/'),
    verdict,
    checks,
    failed,
    measurementInvalid,
    generatedAt:
      typeof parsed.generatedAt === 'string'
        ? parsed.generatedAt
        : typeof parsed.checkedAt === 'string'
          ? parsed.checkedAt
          : null,
    head: typeof parsed.head === 'string' ? parsed.head : null,
  }
}

const readings = INC01_GATE_SPECS.map(readEvidence)

console.log('\nINC-01 门结果（**只读**已落盘证据；缺文件 = NOT RUN，不是 PASS）')
console.log('─'.repeat(104))
for (const reading of readings) {
  const mark = reading.accepted ? '✅' : reading.verdict === 'NOT RUN' ? '⏭️ ' : '❌'
  console.log(
    `  ${mark} ${reading.id.padEnd(3)} ${reading.label.padEnd(46)} ${reading.verdict.padEnd(10)} ` +
      `checks=${reading.checks} failed=${reading.failed} invalid=${reading.measurementInvalid}`
  )
  console.log(`      可接受判决：${reading.acceptVerdicts.join('/')} · 证据：${reading.evidencePath ?? '(缺失)'}`)
  if (reading.verdict === 'NOT RUN' && reading.pendingReason !== undefined) {
    console.log(`      ⏭️ 未运行的理由：${reading.pendingReason}`)
  }
}
console.log('─'.repeat(104))

const required = readings.filter((reading) => reading.required)
const missingRequired = required.filter((reading) => reading.verdict === 'NOT RUN')
const failingRequired = required.filter((reading) => reading.verdict !== 'NOT RUN' && !reading.accepted)
const unauthorized = missingRequired.filter((reading) => reading.pendingReason?.includes('授权'))
const hardGateVerdict = missingRequired.length > 0 || failingRequired.length > 0 ? 'NOT PASS' : 'PASS'

console.log(`  必选门 ${required.length} 个 · 未运行 ${missingRequired.length} 个 · 未通过 ${failingRequired.length} 个`)
console.log(
  `  **Hard Gates = ${hardGateVerdict}**` +
    (hardGateVerdict === 'NOT PASS'
      ? `（未运行：${missingRequired.map((r) => r.id).join(',') || '无'}；未通过：${
          failingRequired.map((r) => r.id).join(',') || '无'
        }）`
      : '')
)
if (unauthorized.length > 0) {
  console.log(
    `  ⏭️ 其中 ${unauthorized.map((r) => r.id).join(',')} 是**尚未授权**（不是失败）：` +
      unauthorized.map((r) => r.pendingReason).join('；')
  )
}
console.log('  ⚠️ 本命令**没有**运行任何测试，也**没有**改写任何 verdict；它只读已落盘证据。\n')

if (process.argv.includes('--write')) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const now = new Date()
  const outPath = join(ART, 'gate-results.json')
  mkdirSync(ART, { recursive: true })
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        incident: 'INC-01',
        wp: 'WP6',
        generatedAt: now.toISOString(),
        head,
        verdict: hardGateVerdict,
        gates: readings,
        requiredCount: required.length,
        notRunCount: missingRequired.length,
        failingCount: failingRequired.length,
        unauthorizedCount: unauthorized.length,
        scope: {
          readOnly: true,
          runsTests: false,
          rewritesVerdicts: false,
          note: '只读已落盘证据的汇总；缺文件记 NOT RUN；未授权的门（G9）单独标注。',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  console.log(`  证据已写入：${relative(ROOT, outPath).split(/[\\/]/).join('/')}\n`)
}

process.exit(hardGateVerdict === 'PASS' ? 0 : 2)
