/**
 * M8.5 WP9 —— 链式总门（§16.1 门清单第三件：`pnpm m8.5:verify`）
 *
 * 串行执行 §16.1 的完整离线门清单，逐门捕获退出码与输出尾部；全部 EXIT 0
 * 才是 PASS。**不缓存、不并发**（门会重写各自 artifacts；串行档才是发布
 * 证据——与 gates-run 的 release 档同一纪律）。
 *
 * 证据 = 落盘的聚合 JSON（§21：不看 stdout 转写，看文件）；measured_count
 * = 实际执行的门数（清单为空 / 门名不存在 ⇒ INVALID，不是 PASS）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// §16.1 门清单（顺序即执行序；typecheck 先行——tsx 不做类型检查）
// ---------------------------------------------------------------------------

const CHAIN: Array<{ id: string; script: string; label: string }> = [
  { id: 'G1', script: 'typecheck', label: '类型（含 src/ scripts/ evals/）' },
  { id: 'G2', script: 'kernel:test', label: '内核边界与既有回归' },
  { id: 'G3', script: 'm8.5:test', label: 'M8.5 部件（契约/解析/评估器/worker/reducer）' },
  { id: 'G4', script: 'm8.5:corpus:verify', label: '语料回放（gate 机械正确率 100% + §16.2 负控）' },
  { id: 'G5', script: 'm8.5:wp3:contracts', label: 'WP3 契约静态锁' },
  { id: 'G6', script: 'm8.5:wp4:verify', label: 'WP4 评估器' },
  { id: 'G7', script: 'm8.5:wp5:verify', label: 'WP5 provider' },
  { id: 'G8', script: 'm8.5:wp6:verify', label: 'WP6 worker 生命周期' },
  { id: 'G9', script: 'm8.5:wp7:verify', label: 'WP7 放行口 + reducer@2' },
  { id: 'G10', script: 'm8.5:wp8:verify', label: 'WP8 接线 + 模式切换 + 崩溃恢复' },
]

// 失败关闭：清单里的每个 script 必须真的存在于 package.json（防拼写错静默跳过）
const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const missing = CHAIN.filter((gate) => typeof packageJson.scripts[gate.script] !== 'string')
if (missing.length > 0) {
  console.error(`清单校验失败：package.json 缺这些 script —— ${missing.map((g) => g.script).join(', ')}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 串行执行（spawn pnpm run <script>；输出流式收尾 8KB）
// ---------------------------------------------------------------------------

interface GateResult {
  id: string
  script: string
  label: string
  exitCode: number | null
  ms: number
  tail: string
}

function runGate(gate: { id: string; script: string; label: string }): Promise<GateResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('pnpm', ['run', gate.script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    })
    let tail = ''
    const push = (chunk: Buffer): void => {
      tail = `${tail}${chunk.toString('utf8')}`.slice(-8_000)
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    child.on('error', (error) => {
      resolve({ ...gate, exitCode: -1, ms: Date.now() - started, tail: `spawn 失败：${String(error)}` })
    })
    child.on('close', (code) => {
      resolve({ ...gate, exitCode: code, ms: Date.now() - started, tail })
    })
  })
}

const gateResults: GateResult[] = []
for (const gate of CHAIN) {
  console.log(`── ${gate.id} ${gate.script}（${gate.label}）…`)
  const result = await runGate(gate)
  gateResults.push(result)
  const verdict = result.exitCode === 0 ? 'PASS' : `FAIL（exit ${String(result.exitCode)}）`
  console.log(`   ${verdict} · ${String(result.ms)}ms`)
  if (result.exitCode !== 0) {
    console.log(`   尾部输出：\n${result.tail.slice(-2_000)}`)
    break // 失败即停：后续门的结果在坏基线上没有意义
  }
}

// ---------------------------------------------------------------------------
// 收口：measured_count 自检 + 证据落盘
// ---------------------------------------------------------------------------

const executed = gateResults.length
const passed = gateResults.filter((r) => r.exitCode === 0).length
const failed = executed - passed
const measuredValid = executed > 0 && executed === CHAIN.length ? executed > 0 : false
const complete = executed === CHAIN.length
const allPassed = failed === 0 && complete

const runId = `verify-${new Date().toISOString().replaceAll(/[-:TZ.]/g, '').slice(0, 17)}`
const outDir = join(process.cwd(), 'artifacts', 'm8.5', runId)
mkdirSync(outDir, { recursive: true })
const evidence = {
  gate: 'm8.5:verify',
  verdict: allPassed && measuredValid ? 'PASS' : 'FAIL',
  measured_count: executed,
  chain_total: CHAIN.length,
  pass: passed,
  fail: failed,
  self_check: measuredValid
    ? complete
      ? 'OK（清单全量执行 + 计数自洽）'
      : `INVALID（失败即停：执行 ${String(executed)}/${String(CHAIN.length)}）`
    : 'INVALID（零执行）',
  gates: gateResults.map((r) => ({
    id: r.id, script: r.script, label: r.label,
    exitCode: r.exitCode, ms: r.ms, verdict: r.exitCode === 0 ? 'PASS' : 'FAIL',
  })),
  tails: Object.fromEntries(gateResults.map((r) => [r.id, r.tail])),
}
writeFileSync(join(outDir, 'verify.json'), JSON.stringify(evidence, null, 2), 'utf8')

console.log('========================================================================')
console.log(`M8.5 链式总门：${evidence.verdict}（${String(passed)}/${String(CHAIN.length)} 门）`)
for (const r of gateResults) {
  console.log(`  ${r.id} ${r.script}: ${r.exitCode === 0 ? 'PASS' : 'FAIL'}（${String(r.ms)}ms）`)
}
console.log(`  证据：${join('artifacts', 'm8.5', runId, 'verify.json')}`)
console.log('========================================================================')
if (evidence.verdict !== 'PASS') process.exit(1)
