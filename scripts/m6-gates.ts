/**
 * M6 —— **门结果汇总**（`pnpm m6:gates`）。
 *
 * ============================================================================
 *  它只做一件事：把**已经落盘**的证据读出来，摊平给人看
 * ============================================================================
 * ```text
 *   不跑测试        没有 spawn、没有 tsx、没有数据库、没有模型
 *   不改 verdict    它只**读**证据里的 verdict 字段，一个字节都不写回
 *   缺文件 = NOT RUN  文件不存在**不是** PASS（计划书 §8.3 / AGENTS §6.4）
 * ```
 *
 * ⚠️ 与 `m6:measurement:verify` 的分工：那边证明"检测器会响"，这边证明
 *    "落盘的结论被如实读出来"。两边共用 `m6-evidence.ts` 的同一份校验 ——
 *    否则会出现"量具说它能抓 X、汇总却按另一套规则读"。
 *
 * 用法：
 *   pnpm m6:gates              # 只打印
 *   pnpm m6:gates --write      # 额外写 artifacts/m6/<runId>/gate-results.json
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { M6_GATE_SPECS, readLandedEvidence, type LandedEvidence } from './m6-evidence.ts'

const ROOT = resolve('.')
const ARTIFACTS = join(ROOT, 'artifacts/m6')

interface GateReading {
  id: string
  label: string
  command: string
  required: boolean
  acceptVerdicts: readonly string[]
  accepted: boolean
  evidencePath: string | null
  verdict: string
  passed: number
  failed: number
  measurementInvalid: number
  head: string | null
  generatedAt: string | null
  problems: string[]
}

function collectJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => join(dir, entry))
}

function readAll(): LandedEvidence[] {
  const out: LandedEvidence[] = []
  for (const path of collectJsonFiles(ARTIFACTS)) {
    const landed = readLandedEvidence(path, readFileSync(path, 'utf8'))
    if (landed !== undefined) out.push(landed)
  }
  return out
}

function latestFor(spec: (typeof M6_GATE_SPECS)[number], all: LandedEvidence[]): LandedEvidence | undefined {
  const mine = all.filter((item) => item.schemaVersion === spec.schemaVersion)
  if (mine.length === 0) return undefined
  return mine.sort((a, b) => String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? '')))[0]
}

const all = readAll()
const readings: GateReading[] = M6_GATE_SPECS.map((spec) => {
  const landed = latestFor(spec, all)
  const verdict = landed === undefined ? 'NOT RUN' : landed.verdict === '' ? 'NOT RUN' : landed.verdict
  return {
    id: spec.id,
    label: spec.label,
    command: spec.command,
    required: spec.required,
    acceptVerdicts: spec.acceptVerdicts,
    /*
     * "通过"由**登记表**说了算：不同门的命题不同（WP0 说 `BASELINE CAPTURED`）。
     * 靠"看到不认识的就当失败/当通过"会同时制造假红与假绿。
     */
    accepted: spec.acceptVerdicts.includes(verdict),
    evidencePath: landed === undefined ? null : relative(ROOT, landed.path).split(/[\\/]/).join('/'),
    verdict,
    passed: landed?.passed ?? 0,
    failed: landed?.failed ?? 0,
    measurementInvalid: landed?.measurementInvalid ?? 0,
    head: landed?.head ?? null,
    generatedAt: landed?.generatedAt ?? null,
    problems: landed === undefined ? [] : landed.problems.map((p) => `${p.code}: ${p.detail}`),
  }
})

console.log('\nM6 门结果（**只读**已落盘证据；缺文件 = NOT RUN，不是 PASS）')
console.log('─'.repeat(100))
for (const reading of readings) {
  const mark = reading.accepted ? '✅' : reading.verdict === 'NOT RUN' ? '⏭️ ' : '❌'
  console.log(
    `  ${mark} ${reading.id.padEnd(18)} ${reading.verdict.padEnd(20)} ` +
      `passed=${reading.passed} failed=${reading.failed} invalid=${reading.measurementInvalid}`
  )
  console.log(
    `     可接受判决：${reading.acceptVerdicts.join('/')} · 证据：${reading.evidencePath ?? '(缺失)'}`
  )
  if (reading.problems.length > 0) {
    for (const problem of reading.problems) console.log(`     ⚠️ ${problem}`)
  }
}
console.log('─'.repeat(100))

const required = readings.filter((reading) => reading.required)
const missingRequired = required.filter((reading) => reading.verdict === 'NOT RUN')
const failingRequired = required.filter((reading) => reading.verdict !== 'NOT RUN' && !reading.accepted)
const hardGateVerdict =
  missingRequired.length > 0 || failingRequired.length > 0 ? 'NOT PASS' : 'PASS'

console.log(`  必选门 ${required.length} 个 · 未运行 ${missingRequired.length} 个 · 未通过 ${failingRequired.length} 个`)
console.log(
  `  **Hard Gates = ${hardGateVerdict}**` +
    (hardGateVerdict === 'NOT PASS'
      ? `（未运行：${missingRequired.map((r) => r.id).join(',') || '无'}；未通过：${
          failingRequired.map((r) => r.id).join(',') || '无'
        }）`
      : '')
)
console.log(
  '  ⚠️ 本命令**没有**运行任何测试，也**没有**改写任何 verdict；它只读已落盘证据。\n'
)

if (process.argv.includes('--write')) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const now = new Date()
  const runId = `m6-gates-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
  const outDir = join(ARTIFACTS, runId)
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'gate-results.json')
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        schemaVersion: 'm6-gates@1',
        runId,
        generatedAt: now.toISOString(),
        head,
        verdict: hardGateVerdict,
        gates: readings,
        requiredCount: required.length,
        notRunCount: missingRequired.length,
        failingCount: failingRequired.length,
        scope: {
          readOnly: true,
          runsTests: false,
          rewritesVerdicts: false,
          note: '只读已落盘证据的汇总；缺文件记 NOT RUN。',
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
