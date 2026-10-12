/**
 * M5.5 —— **门结果汇总**（`pnpm m5.5:gates`）。
 *
 * ============================================================================
 *  它只读**已落盘的证据**，什么都不重跑
 * ============================================================================
 * 与 `m4.5-gate-results.ts` / `m5-gate-results.ts` 同一条纪律（AGENTS §6）：
 *
 *     文件不存在 = `not-run`，**不是** PASS
 *
 * 它回答的是"这一次 M5.5 的每一道门到底跑没跑、跑出什么"，而**不**回答
 * "代码看起来对不对"。手写一张全绿表格比不写更糟 —— 它看起来像证据。
 *
 * ⚠️ 本门**故意**会在里程碑未完成时退出码 1：`G2`（L1 部件）与 `G5`（Live Smoke）
 *    今天都还没跑，而它们是 Hard Gate。那是**如实读数**，不是故障。
 *
 * 跑法：pnpm m5.5:gates
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const evidenceDir = join(ROOT, 'artifacts', 'm5.5')

interface GateSpec {
  gate: string
  name: string
  command: string
  file: string
  hardGate?: boolean
  /** 判定方式：默认看 `failed === 0`；`verdict` 看指定字段 */
  verdictField?: string
  verdictExpect?: string
  /** 已知的"还没跑"说明（不是 PASS，也不是 FAIL） */
  pendingNote?: string
}

const GATES: GateSpec[] = [
  {
    gate: 'G1',
    name: '契约 · 隐私 · 出站 · 裁定 · 上下文 · 回复五态 · 开发者面边界（WP2–WP7 的量具层）',
    command: 'pnpm m5.5:measurement:verify',
    file: 'measurement.json',
    hardGate: true,
    verdictField: 'verdict',
    verdictExpect: 'PASS',
  },
  {
    gate: 'G2',
    name: 'L1 部件级测试（WP8）',
    command: 'pnpm m5.5:test',
    file: 'component.json',
    hardGate: true,
    pendingNote: '脚本尚未新增（WP8b）；本条命令是**计划中的**入口',
  },
  {
    gate: 'G3',
    name: 'L2 子系统（真实 TurnGateway · 隔离库 · 离线 provider）(WP8)',
    command: 'pnpm m5.5:verify',
    file: 'verify-runtime.json',
    hardGate: true,
  },
  {
    gate: 'G4',
    name: 'L3 端到端（计划书 §9 十二场景 + 开发者面读回）(WP8)',
    command: 'pnpm m5.5:e2e:verify',
    file: 'e2e.json',
    hardGate: true,
  },
  {
    gate: 'G5',
    name: 'Production-copy Live Smoke（真实 `/search` + 真实模型）(WP9)',
    command: 'pnpm m5.5:smoke:live',
    file: join('smoke', 'smoke-result.json'),
    hardGate: true,
    pendingNote: '尚未开始（WP9，需用户另行授权；`production activation = NOT APPROVED`）',
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
  const relative = `artifacts/m5.5/${spec.file.split('\\').join('/')}`
  if (!existsSync(absolute)) {
    results.push({
      gate: spec.gate,
      name: spec.name,
      command: spec.command,
      evidence: relative,
      status: 'not-run',
      ...(spec.hardGate === true ? { hardGate: true } : {}),
      ...(spec.pendingNote !== undefined ? { note: spec.pendingNote } : { note: '证据文件不存在 = not-run（不是 PASS）' }),
    })
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
    ...(verdict !== undefined && verdict !== '' ? { note: `${spec.verdictField}=${verdict}` } : {}),
  })
}

/** 上下文证据（不是门，但验收报告要引用） */
const context = ['baseline.json']
  .map((file) => ({ file, present: existsSync(join(evidenceDir, file)) }))

const hardGates = results.filter((item) => item.hardGate === true)
const summary = {
  testId: 'M5.5 / gate results',
  generatedAt: new Date().toISOString(),
  note:
    '只读已落盘证据；文件不存在 = not-run（不是 PASS）。' +
    '⚠️ Hard Gate 里只要还有 not-run / FAIL，`hardGateVerdict` 就是 FAIL —— 里程碑未完成时退出码 1 是**如实读数**。' +
    '本文件含时钟字段（generatedAt）⇒ 每次运行都会变；它不进"冻结身份"清单。',
  gates: results,
  hardGates: hardGates.map((item) => ({ gate: item.gate, status: item.status })),
  hardGateVerdict: hardGates.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
  context,
}

mkdirSync(evidenceDir, { recursive: true })
writeFileSync(join(evidenceDir, 'gate-results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

console.log('='.repeat(78))
console.log('M5.5 门结果（只读已落盘证据）')
console.log('='.repeat(78))
for (const item of results) {
  const counts = item.passed === undefined ? '' : ` (${item.passed} 通过 / ${item.failed ?? '?'} 失败)`
  console.log(
    `  ${item.status === 'PASS' ? '✅' : item.status === 'FAIL' ? '❌' : '⏭️ '} ${item.gate} ${item.name}${counts}`
  )
  console.log(`      命令：${item.command}   证据：${item.evidence}${item.note ? `   ${item.note}` : ''}`)
}
console.log(`\nHard Gates：${summary.hardGateVerdict}`)
console.log(
  `  （${hardGates.map((item) => `${item.gate}=${item.status}`).join(' · ')}）`
)
console.log(`证据已写入：artifacts/m5.5/gate-results.json`)
process.exit(summary.hardGateVerdict === 'PASS' ? 0 : 1)
