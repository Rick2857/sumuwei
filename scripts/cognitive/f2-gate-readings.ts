/**
 * **F2 门读数汇总（干封存的前置输入；零模型、零数据库、只读）**
 *
 * ```text
 * pnpm exec tsx scripts/cognitive/f2-gate-readings.ts            # 写入标准读数文件
 * pnpm exec tsx scripts/cognitive/f2-gate-readings.ts --print    # 只打印，不写文件
 * ```
 *
 * 产出 `artifacts/cognitive/local/f2-executor-20261026/gate-readings.json`：
 * `{ generatedAt, readings: { <gateId>: PASS|FAIL|MISSING }, evidence: { ... } }`。
 *
 * ⚠️ **只从证据文件推导**，不去猜：
 * - 找不到证据 ⇒ `MISSING`（绝不当作"通过"）；
 * - 证据里 `status` 存在 ⇒ 只有 `PASS` 才算 PASS；
 * - 证据里**没有** `status`（历史门只写 checks）⇒ 只有在「checks 非空且没有 `pass:false`」时
 *   才算 PASS，并在 evidence 里记 `basis: 'checks_present_no_error'`（**如实标出口径差异**）。
 * - 同一门目录下有多次运行 ⇒ 取**最新**的一份（按 mtime），并在 evidence 里写出实际用的文件。
 *
 * 本脚本**不**产生任何模型请求，也**不**碰数据库。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { F2_REQUIRED_GATE_IDS } from './f2-live-runner-guards.ts'

const OUT_DIR = resolve(process.env.F2_EXECUTOR_DIR ?? 'artifacts/cognitive/local/f2-executor-20261026')
const OUT_FILE = join(OUT_DIR, 'gate-readings.json')

/**
 * 每个门的证据来源。
 * - `dir`：在该目录下（递归）找**最新**的 `verification.json`；
 * - `files`：显式列出多份证据（**全部**必须 PASS 才算 PASS，例如宿主 + 仿真各一次）。
 */
type EvidenceSpec =
  | { readonly kind: 'newest'; readonly dir: string }
  | { readonly kind: 'files'; readonly files: readonly string[] }

const EVIDENCE: Record<(typeof F2_REQUIRED_GATE_IDS)[number], EvidenceSpec> = {
  'f2-formation-split-calibration-verify': {
    kind: 'files',
    files: [
      'artifacts/cognitive/local/f2-formation-split-20261026/calibration-host.json',
      'artifacts/cognitive/local/f2-formation-split-20261026/calibration-simhost.json',
    ],
  },
  'f2-unit-execution-verify': { kind: 'newest', dir: 'artifacts/local/f2-unit-execution' },
  'f2-sequence-verify': { kind: 'newest', dir: 'artifacts/local/f2-sequence' },
  'f2-provisioning-verify': { kind: 'newest', dir: 'artifacts/local/f2-provisioning' },
  'f2-simhost-e2e-verify': { kind: 'newest', dir: 'artifacts/local/f2-simhost-e2e' },
  'f2-planner-shapes-verify': { kind: 'newest', dir: 'artifacts/local/f2-planner-shapes' },
  'f2-actionturn-closed-loop-verify': { kind: 'newest', dir: 'artifacts/local/f2-actionturn-closed-loop' },
  'f2-task-entry-verify': { kind: 'newest', dir: 'artifacts/local/f2-task-entry' },
  'f2-source-scope-authorization-verify': { kind: 'newest', dir: 'artifacts/local/f2-source-scope-auth' },
  'f2-source-attribution-verify': { kind: 'newest', dir: 'artifacts/local/f2-source-attribution' },
  'f2-rule-source-scope-verify': { kind: 'newest', dir: 'artifacts/local/f2-rule-source-scope' },
  'f2-prep-read-verify': { kind: 'newest', dir: 'artifacts/local/f2-prep-read' },
  'f2-assembly-entry-verify': { kind: 'newest', dir: 'artifacts/local/f2-assembly-entry' },
  'f2-source-veto-integration-verify': { kind: 'newest', dir: 'artifacts/local/f2-source-veto' },
  'f1-precondition-reachability-verify': { kind: 'newest', dir: 'artifacts/local/f1-precondition-reachability' },
}

interface Reading {
  readonly status: 'PASS' | 'FAIL' | 'MISSING'
  readonly checks: number | null
  readonly basis: string
  readonly files: readonly string[]
}

function newestVerification(dir: string): string | undefined {
  const found: { file: string, mtime: number }[] = []
  const walk = (current: string): void => {
    if (!existsSync(current)) return
    const stat = statSync(current)
    if (stat.isFile()) {
      if (current.endsWith('verification.json')) found.push({ file: current, mtime: stat.mtimeMs })
      return
    }
    for (const entry of readdirSync(current)) walk(join(current, entry))
  }
  walk(dir)
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0]?.file
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/')
}

function judge(file: string): Reading {
  const shown = normalizePath(file)
  if (!existsSync(file)) return { status: 'MISSING', checks: null, basis: 'evidence_missing', files: [shown] }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return { status: 'FAIL', checks: null, basis: 'evidence_unreadable', files: [shown] }
  }
  const checks = Array.isArray(parsed.checks) ? parsed.checks : null
  const status = typeof parsed.status === 'string' ? parsed.status : undefined
  const violated = checks !== null && checks.some(item => typeof item === 'object' && item !== null && (item as Record<string, unknown>).pass === false)
  if (status !== undefined) {
    return { status: status === 'PASS' && !violated ? 'PASS' : 'FAIL', checks: checks?.length ?? null, basis: violated ? 'declared_pass_but_check_failed' : 'declared_status', files: [shown] }
  }
  if (checks === null || checks.length === 0) return { status: 'FAIL', checks: checks?.length ?? null, basis: 'no_status_and_no_checks', files: [shown] }
  if (violated) return { status: 'FAIL', checks: checks.length, basis: 'check_failed', files: [shown] }
  return { status: 'PASS', checks: checks.length, basis: 'checks_present_no_error', files: [shown] }
}

function resolveEvidence(spec: EvidenceSpec): Reading {
  if (spec.kind === 'newest') {
    const file = newestVerification(spec.dir)
    return file === undefined
      ? { status: 'MISSING', checks: null, basis: 'no_verification_json', files: [] }
      : judge(file)
  }
  const readings = spec.files.map(judge)
  const status = readings.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL'
  return {
    status,
    checks: readings.reduce<number | null>((total, item) => (total === null || item.checks === null ? null : total + item.checks), 0),
    basis: readings.map(item => item.basis).join('+'),
    files: spec.files,
  }
}

const readings: Record<string, 'PASS' | 'FAIL' | 'MISSING'> = {}
const evidence: Record<string, Reading> = {}
for (const gate of F2_REQUIRED_GATE_IDS) {
  const reading = resolveEvidence(EVIDENCE[gate])
  readings[gate] = reading.status
  evidence[gate] = reading
}

const payload = {
  generatedAt: new Date().toISOString(),
  schema: 'f2-gate-readings@1',
  policy: 'missing ⇒ MISSING（绝不当作通过）；declared status 非 PASS ⇒ FAIL；无 status 时仅 checks 非空且无 pass:false 才算 PASS',
  readings,
  evidence,
}

const failed = F2_REQUIRED_GATE_IDS.filter(gate => readings[gate] !== 'PASS')
if (process.argv.includes('--print')) {
  for (const gate of F2_REQUIRED_GATE_IDS) {
    const item = evidence[gate]
    console.log(`${readings[gate].padEnd(7)} ${gate}  checks=${String(item.checks)} basis=${item.basis}`)
    for (const file of item.files) console.log(`        ${file}`)
  }
  console.log(failed.length === 0 ? '全部通过' : `未通过：${failed.join(',')}`)
} else {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2))
  console.log(`门读数已写入 ${OUT_FILE}`)
  for (const gate of F2_REQUIRED_GATE_IDS) console.log(`  ${readings[gate].padEnd(7)} ${gate}`)
  console.log(failed.length === 0 ? '全部通过（10/10）' : `未通过：${failed.join(',')}`)
}
process.exit(failed.length === 0 ? 0 : 1)
