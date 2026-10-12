/**
 * M5.1.1 —— 门结果汇总器（`pnpm m5.1.1:gates`）
 *
 * **只读已落盘的证据**（秒级），不跑任何门、不写除 `artifacts/m5.1.1/gate-results.json` 之外的任何东西。
 * 规则（计划 §WP8 Gate rule）：**证据缺失 = `not-run`，不是 PASS**。
 *
 * 它把九门注册表（`M511-G1`…`M511-G9`）各自的 verifier 证据读出来汇总；
 * `M511-G8` 恒为 `NOT RUN`（break-glass 未实现，不得伪造 PASS）。
 */

import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { M511_GATES, VERIFIERS } from './m5.1.1-attribution-gate-registry.ts'

const ROOT = process.cwd()
const ART = join(ROOT, 'artifacts', 'm5.1.1')
const abs = (p: string): string => join(ROOT, p)

type VerifierReading = {
  id: string
  pnpm: string | null
  evidence: string
  present: boolean
  verdict: string | null
  passed: number | null
  failed: number | null
  measurementInvalid: number | null
  generatedAt: string | null
}

function readVerifier(id: string): VerifierReading[] {
  const v = VERIFIERS.find((x) => x.id === id)
  if (v === undefined) return []
  const primary = v.evidence[0]
  if (primary === undefined) {
    return [{ id, pnpm: v.pnpm, evidence: '(不写证据：只读 exit code)', present: true, verdict: null, passed: null, failed: null, measurementInvalid: null, generatedAt: null }]
  }
  if (!existsSync(abs(primary))) {
    return [{ id, pnpm: v.pnpm, evidence: primary, present: false, verdict: null, passed: null, failed: null, measurementInvalid: null, generatedAt: null }]
  }
  const j = JSON.parse(readFileSync(abs(primary), 'utf8')) as Record<string, unknown>
  return [
    {
      id,
      pnpm: v.pnpm,
      evidence: primary,
      present: true,
      verdict: typeof j.verdict === 'string' ? j.verdict : null,
      passed: typeof j.passed === 'number' ? j.passed : null,
      failed: typeof j.failed === 'number' ? j.failed : null,
      measurementInvalid: typeof j.measurementInvalid === 'number' ? j.measurementInvalid : null,
      generatedAt: typeof j.generatedAt === 'string' ? j.generatedAt : null,
    },
  ]
}

type GateResult = {
  id: string
  name: string
  claim: string
  status: string
  verdict: 'PASS' | 'FAIL' | 'NOT RUN' | 'not-run'
  reason: string
  verifiers: VerifierReading[]
}

const manifestPath = abs('artifacts/m5.1.1/wp8-gate-manifest.json')
const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>) : null
const manifestGates = new Map<string, { verdict: string; reason: string }>()
if (manifest !== null && Array.isArray(manifest.gates)) {
  for (const g of manifest.gates as { id: string; verdict?: string; reason?: string }[]) {
    if (typeof g.verdict === 'string') manifestGates.set(g.id, { verdict: g.verdict, reason: g.reason ?? '' })
  }
}
const manifestGeneratedAt = manifest !== null && typeof manifest.generatedAt === 'string' ? manifest.generatedAt : null

const results: GateResult[] = []
for (const g of M511_GATES) {
  if (g.status === 'NOT_RUN') {
    results.push({ id: g.id, name: g.name, claim: g.claim, status: g.status, verdict: 'NOT RUN', reason: g.notRunReason ?? '', verifiers: [] })
    continue
  }
  const readings = g.verifiers.flatMap((id) => readVerifier(id))
  const missing = readings.filter((r) => !r.present && r.evidence !== '(不写证据：只读 exit code)')
  const red = readings.filter((r) => r.present && ((r.verdict !== null && r.verdict !== 'PASS') || (r.failed ?? 0) !== 0 || (r.measurementInvalid ?? 0) !== 0))
  const harnessRow = manifestGates.get(g.id)
  let verdict: GateResult['verdict'] = 'PASS'
  let reason = `${readings.length} 条 verifier 证据齐备且通过`
  if (harnessRow === undefined) {
    // 没有 harness 读数：落盘证据只能说明"过去跑过"，不能说明"现在通过" ⇒ not-run（不是 PASS）
    verdict = 'not-run'
    reason = `没有 harness 读数（wp8-gate-manifest.json 缺失或无此门）⇒ evidence-only 不足以判定 PASS；落盘证据：${readings.filter((r) => r.present).length} 条存在${red.length ? ` · 其中 ${red.length} 条报红` : ''}`
  } else if (harnessRow.verdict === 'FAIL') {
    verdict = 'FAIL'
    reason = `harness 判定 FAIL（以**当前 exit code** 为准）：${harnessRow.reason}${missing.length ? ` · 证据缺失：${missing.map((m) => m.id).join(', ')}` : ''}`
  } else if (harnessRow.verdict === 'NOT RUN') {
    verdict = 'NOT RUN'
    reason = harnessRow.reason
  } else {
    verdict = 'PASS'
    reason = `harness 判定 PASS（逐门 exit 0）· ${red.length === 0 ? '落盘证据亦无红' : `落盘证据有 ${red.length} 条报红（历史那次运行）`}`
  }
  results.push({ id: g.id, name: g.name, claim: g.claim, status: g.status, verdict, reason, verifiers: readings })
}

const wp8Summary = (manifest?.summary ?? null) as Record<string, unknown> | null
console.log('\nM5.1.1 门结果汇总（判定以 **wp8 harness 的当前 exit code** 为准；没有 harness 读数 = not-run，不是 PASS）')
console.log(`  harness 读数时间：${manifestGeneratedAt ?? '(无)'}`)
console.log('='.repeat(96))
for (const r of results) {
  console.log(`${r.id.padEnd(9)} ${String(r.verdict).padEnd(9)} ${r.name}`)
  console.log(`${' '.repeat(19)}${r.reason}`)
}
console.log('='.repeat(96))
console.log(`WP8-B harness 判定 = ${String(wp8Summary?.wp8Verdict ?? '(未运行：artifacts/m5.1.1/wp8-gate-manifest.json 不存在 ⇒ not-run)')}`)
if (wp8Summary !== null) {
  console.log(`  harness 自检：${String(wp8Summary.passed)} 通过 / ${String(wp8Summary.failed)} 失败 · measurementInvalid = ${String(wp8Summary.measurementInvalid)}`)
  console.log(`  门覆盖：${JSON.stringify(manifest?.coverage ?? {})}`.slice(0, 260))
}

const out = {
  testId: 'M5.1.1 / gate results（M511-G1…G9）',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:gates',
  rule: 'missing evidence = not-run（不是 PASS）',
  gates: results,
  wp8Harness: wp8Summary,
}
writeFileSync(join(ART, 'gate-results.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log('证据已写入：artifacts/m5.1.1/gate-results.json')
const anyFail = results.some((r) => r.verdict === 'FAIL')
const anyNotRun = results.some((r) => r.verdict === 'not-run')
if (anyFail) console.log('结论：有门 FAIL ⇒ 汇总不通过')
else if (anyNotRun) console.log('结论：有门 not-run（证据缺失）⇒ 不得读作 PASS')
else console.log('结论：全部可判定的门 = PASS')
process.exit(anyFail ? 1 : 0)
