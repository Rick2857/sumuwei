/**
 * M5.1 WP7 —— **门结果汇总**（`pnpm m5.1:gates`）。
 *
 * ============================================================================
 *  它只读**已落盘的证据**，什么都不重跑
 * ============================================================================
 * 与 `scripts/m4.5-gate-results.ts` / `scripts/m5-gate-results.ts` 同一条纪律（AGENTS §6）：
 *
 *     文件不存在 = `not-run`，**不是** PASS
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 两条"措辞纪律"，做成了机读字段（这是本文件最重要的部分）
 * ---------------------------------------------------------------------------
 *  ① **spike 不是门**：它单列在 `spikes[]`，**不参与** `hardGateVerdict`。
 *     把一次协议实测算成一道门，会让"能接"这句话悄悄升格。
 *  ② **spike 必须带 claim 上限**：每条 spike 都要写清
 *     `claim`（它证明了什么）与 `claimLimit`（它**没有**证明什么）。
 *     没有 `claimLimit` 的 spike 会让汇总器直接失败 ——
 *     因为"没写清楚没证明什么"的绿，与"没验过"在读者眼里是同一种东西。
 *
 * 具体到 AT6.1：正确的说法是
 *
 *     OTLP protocol compatibility verified;
 *     specific backend deployment not exercised
 *
 * 而**不是** "Langfuse/OpenLIT integration PASS"。
 * Langfuse / OpenLIT / Cognee / Temporal **一次都没有在本机部署过**
 * （见 `M5.1-OSS-Audit.md` §0 与 §1.5）。
 *
 * 跑法：pnpm m5.1:gates
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const evidenceDir = join(ROOT, 'artifacts', 'm5.1')

/** 判定方式：默认看 `failed === 0`；`field` 看指定字段；`allHardGatesPass` 看继承门的数组 */
type VerdictRule = 'failedZero' | 'field' | 'allHardGatesPass'

interface GateSpec {
  gate: string
  name: string
  command: string
  /** 相对 `artifacts/` 的路径（继承门在别的里程碑目录下） */
  file: string
  hardGate?: boolean
  /** 这条门**为什么**是硬的（写进证据，免得 WP9 再猜） */
  why?: string
  rule?: VerdictRule
  /** `rule: 'field'` 时看哪个字段 */
  verdictField?: string
  /** `rule: 'field'` 时期望的值（缺省 PASS） */
  verdictExpect?: string
}

const GATES: GateSpec[] = [
  {
    gate: 'M51-G1',
    name: '开发者平面契约（WP1）',
    command: 'pnpm m5.1:test',
    file: 'm5.1/wp1-contracts.json',
  },
  {
    gate: 'M51-G2',
    name: '只读查询面 · Query Mutation Count = 0（WP2）',
    command: 'pnpm m5.1:query:verify',
    file: 'm5.1/query-negative-control.json',
    hardGate: true,
    why: 'G-03：Query 面**不可能**写。判据是"调完全部端点前后整库逐字段相同"',
    rule: 'field',
    verdictField: 'hardGateVerdict',
  },
  {
    gate: 'M51-G3',
    name: '控制面 · 执行结果与权威状态一致（WP3）',
    command: 'pnpm m5.1:control:verify',
    file: 'm5.1/control-execution-truth.json',
    hardGate: true,
    why: 'AT3.6：五档必须两两可区分；结果必须与账本/权威状态一致',
    rule: 'field',
    verdictField: 'hardGateVerdict',
  },
  {
    gate: 'M51-G4',
    name: '可观测性 · Trace Truth（WP4 / AT4.4）',
    command: 'pnpm m5.1:observability:verify',
    file: 'm5.1/observability-evidence.json',
    hardGate: true,
    why: 'AT4.4：观测里说的必须就是真相（被编译器丢掉的那条不得出现在 selectedMemoryIds）',
    rule: 'field',
    verdictField: 'traceTruthVerdict',
  },
  {
    gate: 'M51-G5',
    name: '遥测零泄漏（WP4 / AT4.5）',
    command: 'pnpm m5.1:observability:verify',
    file: 'm5.1/leakage-evidence.json',
    hardGate: true,
    why: 'AT4.5：外发不可撤回 —— 扫的是**导出的负载**，四个哨兵零命中',
    rule: 'field',
    verdictField: 'leakageVerdict',
  },
  {
    gate: 'M51-G6',
    name: '开发者页面独立性（WP5 · 非硬门）',
    command: 'pnpm m5.1:page:verify',
    file: 'm5.1/page-evidence.json',
    why: '计划书 FINAL GATE MATRIX 里 "Developer Page Independence" 不是硬门',
    rule: 'field',
    verdictField: 'pageIndependenceVerdict',
  },
  {
    gate: 'M51-G7',
    name: '量具与负控 · 五个检测器都会响（WP7 / AT7.2）',
    command: 'pnpm m5.1:measurement:verify',
    file: 'm5.1/measurement-negative-controls.json',
    hardGate: true,
    why: 'INV-M45-06：一个永远说"没问题"的检测器与一个真的都没问题的系统，输出完全一样',
    rule: 'field',
    verdictField: 'measurementVerdict',
  },
  {
    gate: 'M51-G8',
    name: '真实自然语言 E2E · E1–E5（WP8）',
    command: 'pnpm m5.1:e2e:verify',
    file: 'm5.1/nl-e2e-evidence.json',
    hardGate: true,
    why:
      'AT3.6/AT5.x 的最后一层：判据是**三处投影互相对齐**' +
      '（真实 prompt 文本 / trace.selectedMemoryIds / Query API 的 DTO）',
    rule: 'field',
    verdictField: 'e2eVerdict',
  },
  {
    gate: 'M51-G9',
    name: 'Production-copy Live Smoke（WP8 · 真实模型）',
    command: 'pnpm m5.1:e2e:verify',
    file: 'm5.1/live-smoke-evidence.json',
    hardGate: true,
    why:
      '离线全绿 ≠ 真实链路正确（M4 的 D1 缺陷穿过了 939 项断言）。' +
      '判据必须看 liveSmokeVerdict —— 文件存在也可能是 not-run',
    rule: 'field',
    verdictField: 'liveSmokeVerdict',
  },
  {
    gate: 'M51-G10',
    name: '全量回归 · 既有 Hard Gate 零退化（WP9）',
    command: 'pnpm m5.1:regression:verify',
    file: 'm5.1/regression-evidence.json',
    hardGate: true,
    why:
      '计划书 WP9：任何原有 Hard Gate 退化就是 M5.1 FAIL，' +
      '**不得**解释为"与 M5.1 无关"（除非有可复现证据证明 baseline 本来就失败）',
    rule: 'field',
    verdictField: 'regressionVerdict',
  },
  {
    gate: 'M5-G',
    name: 'M5 召回门（继承）',
    command: 'pnpm m5:gates',
    file: 'm5/gate-results.json',
    hardGate: true,
    why: 'M5.1 不得让 M5 的既有 Hard Gate 退化',
    rule: 'field',
    verdictField: 'hardGateVerdict',
  },
  {
    gate: 'M45-G',
    name: 'M4.5 行动门（继承）',
    command: 'pnpm m4.5:gates',
    file: 'm4.5/gate-results.json',
    hardGate: true,
    why: 'M5.1 不得让 M4.5 的既有 Hard Gate（G12/G13/G14）退化',
    rule: 'allHardGatesPass',
  },
]

/**
 * spike：**不是门**。
 *
 * 它们证明协议/成本层面的结论，**不**进入 `hardGateVerdict`。
 * `claimLimit` 是必填的 —— 见文件头 ⚠️②。
 */
interface SpikeSpec {
  id: string
  name: string
  command: string
  file: string
  claim: string
  claimLimit: string
}

const SPIKES: SpikeSpec[] = [
  {
    id: 'M51-S1',
    name: 'AT6.1 通用 OTLP 端点兼容性',
    command: 'pnpm m5.1:spike:otlp',
    file: 'm5.1/oss-spike-otlp.json',
    claim: 'OTLP protocol compatibility verified（我们发出的是标准 OTLP，protobuf 与 JSON 两种编码都被通用接收端逐字段接受）',
    claimLimit: 'specific backend deployment not exercised（Langfuse / OpenLIT 一次都没有在本机部署过；本次没有验证任何具体后端的面板、摄取管线或语义映射）',
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
  why?: string
  note?: string
}

/** 读一条证据并按规则判 PASS / FAIL / not-run（**不重跑任何东西**） */
function evaluate(spec: GateSpec): GateResult {
  const relative = `artifacts/${spec.file.split('\\').join('/')}`
  // ⚠️ 证据一律住在 `artifacts/` 下（继承门在各自里程碑的目录里，如 `m5/gate-results.json`）
  const absolute = join(ROOT, 'artifacts', ...spec.file.split('/'))
  const base: GateResult = {
    gate: spec.gate,
    name: spec.name,
    command: spec.command,
    evidence: relative,
    status: 'not-run',
    ...(spec.hardGate === true ? { hardGate: true } : {}),
    ...(spec.why !== undefined ? { why: spec.why } : {}),
  }
  if (!existsSync(absolute)) {
    return { ...base, note: '证据文件不存在 = not-run（不是 PASS）' }
  }

  const parsed = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>
  const rule: VerdictRule = spec.rule ?? 'failedZero'

  let ok: boolean
  let note: string | undefined
  if (rule === 'field') {
    const actual = String(parsed[spec.verdictField ?? 'verdict'] ?? '')
    ok = actual === (spec.verdictExpect ?? 'PASS')
    note = `${String(spec.verdictField)}=${actual || '(缺失)'}`
  } else if (rule === 'allHardGatesPass') {
    const hardGates = Array.isArray(parsed.hardGates)
      ? (parsed.hardGates as { gate: string; status: string }[])
      : []
    const notPass = hardGates.filter((item) => item.status !== 'PASS')
    ok = hardGates.length > 0 && notPass.length === 0
    note =
      hardGates.length === 0
        ? 'hardGates 为空 —— 不能当成 PASS'
        : hardGates.map((item) => `${item.gate}=${item.status}`).join(' ')
  } else {
    ok = (parsed.failed ?? 1) === 0
  }

  const passed = typeof parsed.passed === 'number' ? parsed.passed : undefined
  const failed = typeof parsed.failed === 'number' ? parsed.failed : undefined
  const failures = Array.isArray(parsed.failures) ? (parsed.failures as string[]) : undefined
  return {
    ...base,
    status: ok ? 'PASS' : 'FAIL',
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
    ...(failures !== undefined ? { failures } : {}),
    ...(note !== undefined ? { note } : {}),
  }
}

const results = GATES.map(evaluate)

// ---------------------------------------------------------------------------
// 量具自检：**篡改过的输入必须被判成 not-run / FAIL**
// ---------------------------------------------------------------------------

const missingSpec: GateSpec = {
  gate: 'M51-SELFTEST',
  name: '（自检用：故意指向不存在的证据）',
  command: '(n/a)',
  file: 'm5.1/__this-file-does-not-exist__.json',
  hardGate: true,
  rule: 'field',
  verdictField: 'hardGateVerdict',
}
const missingResult = evaluate(missingSpec)
const selfCheck: Record<string, string | boolean> = {
  missingEvidenceYields: missingResult.status,
  missingEvidenceIsNotPass: missingResult.status !== 'PASS',
  note: '一个把缺文件当 PASS 的汇总器，与一个什么都验过的汇总器，输出完全一样',
}

const hardGates = results.filter((item) => item.hardGate === true)
const hardGateVerdict = hardGates.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL'

/** 自检②：如果多一道"缺文件的硬门"，总判定必须变成 FAIL（而不是被忽略） */
const counterfactualVerdict =
  [...hardGates, missingResult].every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL'
selfCheck['missingHardGateDowngradesVerdict'] = counterfactualVerdict === 'FAIL'

/** 自检③：spike 不许参与总判定（它是协议结论，不是门） */
const spikeIds = new Set(SPIKES.map((spike) => spike.id))
selfCheck['spikesAreNotGates'] = results.every((item) => !spikeIds.has(item.gate))
selfCheck['everySpikeHasClaimLimit'] = SPIKES.every((spike) => spike.claimLimit.trim() !== '')

const spikes = SPIKES.map((spec) => {
  const absolute = join(ROOT, 'artifacts', ...spec.file.split('/'))
  const present = existsSync(absolute)
  const parsed = present ? (JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>) : {}
  return {
    id: spec.id,
    name: spec.name,
    command: spec.command,
    evidence: `artifacts/${spec.file.split('\\').join('/')}`,
    status: present ? String(parsed.spikeVerdict ?? '(缺 verdict 字段)') : 'not-run',
    /** ⚠️ 机读的 claim 上限：任何报告都必须连它一起引用 */
    claim: spec.claim,
    claimLimit: spec.claimLimit,
    note: 'spike **不是门**，不参与 hardGateVerdict',
  }
})

// ---------------------------------------------------------------------------
// FINAL GATE MATRIX（计划书原文的 14 行）→ 每一行由谁来回答
// ---------------------------------------------------------------------------

const FINAL_GATE_MATRIX: { gate: string; hard: boolean; answeredBy: string }[] = [
  { gate: 'Authority Boundary', hard: true, answeredBy: 'docs/m5.1/M5.1-Authority-Map.md（冻结）+ 各 WP 的冻结区 diff 为空' },
  { gate: 'Query Read-Only', hard: true, answeredBy: 'M51-G2' },
  { gate: 'Control Safety', hard: true, answeredBy: 'M51-G3' },
  { gate: 'Execution Truth', hard: true, answeredBy: 'M51-G3 + M51-G7' },
  { gate: 'Observability Truth', hard: true, answeredBy: 'M51-G4' },
  { gate: 'Telemetry Leakage = 0', hard: true, answeredBy: 'M51-G5' },
  { gate: 'Developer Page Independence', hard: false, answeredBy: 'M51-G6' },
  { gate: 'OSS ADR Complete', hard: false, answeredBy: 'docs/m5.1/M5.1-OSS-Audit.md §6 + docs/adr/ADR-037~041' },
  { gate: 'Measurement Negative Controls', hard: true, answeredBy: 'M51-G7' },
  { gate: 'Natural-Language E2E', hard: true, answeredBy: 'M51-G8（nl-e2e-evidence.json，e2eVerdict）' },
  { gate: 'Production-copy Smoke', hard: true, answeredBy: 'M51-G9（live-smoke-evidence.json，liveSmokeVerdict）' },
  { gate: 'M5 Regression', hard: true, answeredBy: 'M5-G' },
  { gate: 'M4.5 Hard Gates', hard: true, answeredBy: 'M45-G' },
  { gate: 'Full Regression', hard: true, answeredBy: 'M51-G10（regression-evidence.json，regressionVerdict）' },
]

const summary = {
  testId: 'M5.1 / gate results',
  generatedAt: new Date().toISOString(),
  note: '只读已落盘证据；文件不存在 = not-run（不是 PASS）',
  gates: results,
  spikes,
  hardGates: hardGates.map((item) => ({ gate: item.gate, status: item.status })),
  hardGateVerdict,
  selfCheck,
  finalGateMatrix: FINAL_GATE_MATRIX,
  claimDiscipline: {
    rule:
      'spike 的证据只允许被引述为 claim + claimLimit 两句话；' +
      '**不许**把一次协议 spike 写成"某个具体后端 integration PASS"',
    example: {
      correct:
        'OTLP protocol compatibility verified; specific backend deployment not exercised',
      wrong: 'Langfuse/OpenLIT integration PASS',
      why:
        'Langfuse / OpenLIT / Cognee / Temporal 一次都没有在本机部署过' +
        '（M5.1-OSS-Audit.md §0 与 §1.5）；把协议实测说成集成通过，' +
        '正是本仓库最贵的缺陷形状：数字看起来合理，但量的不是那个东西',
    },
  },
  context: ['baseline.json', 'wp0-baseline.log', 'oss-spike-otlp.json'].map((file) => ({
    file,
    present: existsSync(join(evidenceDir, file)),
  })),
}

mkdirSync(evidenceDir, { recursive: true })
writeFileSync(join(evidenceDir, 'gate-results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

console.log('='.repeat(72))
console.log('M5.1 门结果（只读已落盘证据）')
console.log('='.repeat(72))
for (const item of results) {
  const counts =
    item.passed === undefined ? '' : ` (${item.passed} 通过 / ${item.failed ?? '?'} 失败)`
  const mark = item.status === 'PASS' ? '✅' : item.status === 'FAIL' ? '❌' : '⏭️ '
  console.log(`  ${mark} ${item.gate} ${item.name}${counts}`)
  console.log(`      命令：${item.command}   证据：${item.evidence}${item.note ? `   ${item.note}` : ''}`)
}
console.log('\nspike（**不是门**，不参与总判定）：')
for (const spike of spikes) {
  console.log(`  • ${spike.id} ${spike.name} → ${spike.status}`)
  console.log(`      claim      : ${spike.claim}`)
  console.log(`      claimLimit : ${spike.claimLimit}`)
}
console.log(`\n量具自检：缺证据 → ${selfCheck.missingEvidenceYields}；` +
  `缺硬门会把总判定降级：${String(selfCheck['missingHardGateDowngradesVerdict'])}；` +
  `spike 不算门：${String(selfCheck['spikesAreNotGates'])}`)
console.log(`\nHard Gates：${hardGateVerdict}`)
console.log('证据已写入：artifacts/m5.1/gate-results.json')
process.exit(
  hardGateVerdict === 'PASS' &&
    selfCheck.missingEvidenceIsNotPass &&
    selfCheck['missingHardGateDowngradesVerdict'] === true &&
    selfCheck['spikesAreNotGates'] &&
    selfCheck['everySpikeHasClaimLimit']
    ? 0
    : 1
)
