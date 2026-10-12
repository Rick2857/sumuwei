/**
 * M5 —— **门结果汇总**（`pnpm m5:gates`）。
 *
 * ============================================================================
 *  它只读**已落盘的证据**，什么都不重跑
 * ============================================================================
 * 与 `m4.5-gate-results.ts` 同一条纪律（AGENTS §6）：
 *
 *     文件不存在 = `not-run`，**不是** PASS
 *
 * 它回答的是"这一次 M5 的每一道门到底跑没跑、跑出什么"，而**不**回答
 * "代码看起来对不对"。手写一张全绿表格比不写更糟 —— 它看起来像证据。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const evidenceDir = join(ROOT, 'artifacts', 'm5')

interface GateSpec {
  gate: string
  name: string
  command: string
  file: string
  hardGate?: boolean
  /** 判定方式：默认看 failed === 0；`verdict` 看指定字段 */
  verdictField?: string
  /** 期望的 verdict 值（默认 PASS） */
  verdictExpect?: string
}

const GATES: GateSpec[] = [
  { gate: 'G1', name: 'Recall Contracts（WP1）', command: 'pnpm m5:test', file: 'wp1-contracts.json' },
  {
    gate: 'G2',
    name: 'Eligibility Filter（WP2 / P0 安全层）',
    command: 'pnpm m5:verify',
    file: 'wp2-eligibility.json',
    hardGate: true,
    verdictField: 'hardGateVerdict',
  },
  { gate: 'G3', name: 'Retrieval Adapter（WP3）', command: 'pnpm m5:retrieval:verify', file: 'wp3-retrieval.json' },
  { gate: 'G4', name: 'Ranking / Conflict / Dedup（WP4）', command: 'pnpm m5:ranking:verify', file: 'wp4-ranking.json' },
  { gate: 'G5', name: 'Context Selector & Budget（WP5）', command: 'pnpm m5:budget:verify', file: 'wp5-context-budget.json' },
  { gate: 'G6', name: 'Runtime Integration（WP6）', command: 'pnpm m5:runtime:verify', file: 'wp6-context-compiler.json' },
  { gate: 'G7', name: 'Trace / Audit / Measurement Truth（WP7）', command: 'pnpm m5:trace:verify', file: 'wp7-trace.json', hardGate: true },
  { gate: 'G8', name: 'Natural-Language E2E A–H（WP8）', command: 'pnpm m5:e2e:verify', file: 'wp8-e2e.json', hardGate: true },
  {
    gate: 'G9',
    name: 'Production-copy Live Smoke（WP8 / 真实模型）',
    command: 'pnpm m5:smoke:live',
    file: join('smoke', 'smoke-result.json'),
    hardGate: true,
  },
]

interface GateResult {
  gate: string
  name: string
  command: string
  evidence: string
  status: 'PASS' | 'FAIL' | 'not-run'
  passed?: number
  failed?: number
  failures?: string[]
  hardGate?: boolean
  note?: string
}

const results: GateResult[] = []
for (const spec of GATES) {
  const absolute = join(evidenceDir, spec.file)
  const relative = `artifacts/m5/${spec.file.split('\\').join('/')}`
  if (!existsSync(absolute)) {
    results.push({ ...spec, evidence: relative, status: 'not-run', passed: undefined, failed: undefined })
    continue
  }
  const parsed = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown> & {
    passed?: number
    failed?: number
    failures?: string[]
  }
  const verdict = spec.verdictField === undefined ? undefined : String(parsed[spec.verdictField] ?? '')
  const ok =
    spec.verdictField === undefined
      ? (parsed.failed ?? 1) === 0
      : verdict === (spec.verdictExpect ?? 'PASS')
  results.push({
    gate: spec.gate,
    name: spec.name,
    command: spec.command,
    evidence: relative,
    status: ok ? 'PASS' : 'FAIL',
    ...(parsed.passed !== undefined ? { passed: parsed.passed } : {}),
    ...(parsed.failed !== undefined ? { failed: parsed.failed } : {}),
    ...(parsed.failures !== undefined ? { failures: parsed.failures } : {}),
    ...(spec.hardGate === true ? { hardGate: true } : {}),
    ...(verdict !== undefined && verdict !== '' ? { note: `${String(spec.verdictField)}=${verdict}` } : {}),
  })
}

/** 上下文证据（不是门，但验收报告要引用） */
const context = [
  'baseline.json',
  'real-db-inventory.json',
  'investigation-2026-09-17.json',
  'wp6-live-smoke-result.json',
]
  .map((file) => ({ file, present: existsSync(join(evidenceDir, file)) }))

const hardGates = results.filter((item) => item.hardGate === true)
const summary = {
  testId: 'M5 / gate results',
  generatedAt: new Date().toISOString(),
  note: '只读已落盘证据；文件不存在 = not-run（不是 PASS）',
  gates: results,
  hardGates: hardGates.map((item) => ({ gate: item.gate, status: item.status })),
  hardGateVerdict: hardGates.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
  context,
}

mkdirSync(evidenceDir, { recursive: true })
writeFileSync(join(evidenceDir, 'gate-results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

console.log('='.repeat(72))
console.log('M5 门结果（只读已落盘证据）')
console.log('='.repeat(72))
for (const item of results) {
  const counts =
    item.passed === undefined ? '' : ` (${item.passed} 通过 / ${item.failed ?? '?'} 失败)`
  console.log(`  ${item.status === 'PASS' ? '✅' : item.status === 'FAIL' ? '❌' : '⏭️ '} ${item.gate} ${item.name}${counts}`)
  console.log(`      命令：${item.command}   证据：${item.evidence}${item.note ? `   ${item.note}` : ''}`)
}
console.log(`\nHard Gates：${summary.hardGateVerdict}`)
console.log(`证据已写入：artifacts/m5/gate-results.json`)
process.exit(summary.hardGateVerdict === 'PASS' ? 0 : 1)
