/**
 * Lv2 —— **回归半**的只读读数（`pnpm lv2:regression:read`；计划 `LV2-G7` 的第二半）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * `LV2-G7` 要求"相关门与完整离线/真实回归成功"。本脚本**只读**跑一次 `pnpm m4.5:gates`
 * （它自己也是只读：读已落盘证据），把 `overall` 与**未通过的 Hard Gate**如实记进一份 Lv2 证据。
 *
 * ⚠️ 两条纪律：
 *   ① 它**不**跑 `m4.5:ci` / `smoke:live`（那些会重写别家证据、且 live 档要真模型）
 *      —— 它读的是**它们已经落盘**的结果
 *   ② 别家的 FAIL 档**如实归口、带 head**，**不替它解释**（例如 `G14` 的 26/18 来自
 *      `artifacts/m4.5/smoke/smoke-result.json` 这份**已落盘**的读数）
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'
import { readLatestLv2Regression } from './lv2-regression-evidence.ts'
import { readM51Inherited } from './lv2-m51-inherited.ts'

interface HardGateRow {
  readonly gate?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly passed?: unknown
  readonly failed?: unknown
  readonly evidence?: unknown
}

function main(): void {
  const started = new Date().toISOString()
  const root = process.cwd()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const candidate = readLatestLv2Regression(root)
  const scopeIndex = process.argv.indexOf('--scope')
  if (scopeIndex >= 0) {
    const scope = process.argv[scopeIndex + 1]
    if (scope === 'm5.1') {
      const result = readM51Inherited(root)
      console.log(`overall = ${result.verdict} · scope=m5.1 · sourceRunId=${result.sourceRunId ?? 'NOT RUN'}`)
      console.log(JSON.stringify(result))
      process.exitCode = result.verdict === 'PASS' ? 0 : 1
      return
    }
    if (!['m4', 'm4.5'].includes(scope ?? '')) throw new Error('--scope 只支持 m4 / m4.5 / m5.1')
    console.log(`overall = ${candidate?.valid ? 'PASS' : 'NOT PASS'} · scope=${scope} · sourceRunId=${candidate?.runId ?? 'NOT RUN'}`)
    console.log(JSON.stringify({ scope, overall: candidate?.valid ? 'PASS' : 'NOT PASS', evidence: candidate ?? { problems: ['当前候选完整回归尚未执行'] } }))
    process.exitCode = candidate?.valid ? 0 : 1
    return
  }

  let stdout = ''
  let exitCode = 0
  try {
    if (candidate !== undefined) {
      exitCode = candidate.valid ? 0 : 1
      stdout = candidate.valid ? `overall = PASS · ${candidate.runId}` : `不是 PASS：${candidate.problems.join('；')}`
    } else {
    stdout = execFileSync('pnpm', ['m4.5:gates'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true })
    }
  } catch (error) {
    const withOutput = error as { status?: number; stdout?: string }
    exitCode = withOutput.status ?? 1
    stdout = withOutput.stdout ?? ''
  }
  const warning = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.includes('不是 PASS')) ?? ''

  let hardGates: HardGateRow[] = []
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'artifacts', 'm4.5', 'gate-results.json'), 'utf8')) as {
      gates?: readonly HardGateRow[]
    }
    hardGates = candidate?.valid ? [] : (parsed.gates ?? []).filter((row) => String(row.status ?? '') !== 'PASS')
  } catch {
    hardGates = []
  }

  const verdict = exitCode === 0 && warning === '' ? 'PASS' : 'FAIL'
  const runId = createLv2RunId({ wpId: 'wp6-regression', headShort: head })
  const dir = openLv2RunDir(root, runId)
  writeFileSync(
    join(dir, 'readings.json'),
    `${JSON.stringify({ runId, exitCode, warning, candidateRegression: candidate ?? null, failingGates: hardGates.map((row) => ({
      gate: row.gate, name: row.name, status: row.status, passed: row.passed, failed: row.failed, evidence: row.evidence,
    })) }, null, 2)}\n`,
    'utf8',
  )
  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp6-regression',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version },
    testType: 'read-only-regression-rollup',
    counts: { total: 1, passed: verdict === 'PASS' ? 1 : 0, failed: verdict === 'PASS' ? 0 : 1 },
    phases: ['single'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: { clean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '', note: '本脚本自己的 run 目录按白名单不计入' },
    sourceFingerprints: Object.fromEntries(
    (['scripts/lv2-regression-read.ts', 'scripts/lv2-regression-evidence.ts', 'scripts/lv2-evidence.ts'] as const).map((path) => [
        path,
        createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
      ]),
    ),
    config: { mode: '只读当前完整回归档；尚无档时读旧聚合门', note: '不跑 m4.5:ci / smoke:live；不调模型' },
    model: { providerKind: 'none', note: '零模型请求' },
    requests: { planned: 0, actual: 0, note: '零模型请求' },
    denominators: { failingGates: hardGates.length, measuredCount: 1 },
    correlations: { cases: 0, conversations: 0, requests: 0, traces: 0 },
    faultInjection: null,
    cleanClose: true,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: '只读；未打开任何库' },
    verdict,
    limitation:
      '当前完整回归档必须同时通过源码、原始日志与 Smoke 摘要核验；旧聚合门只作无新档时的历史读面。失败或失效证据不被略过。',
  })

  console.log(`[lv2:regression] runId = ${runId} · exit=${String(exitCode)} · verdict=${verdict}`)
  console.log(`[lv2:regression] ${warning === '' ? '无未通过 Hard Gate' : warning}`)
  for (const row of hardGates) console.log(`  ❌ ${String(row.gate)} ${String(row.name)} ${String(row.status)} ${String(row.passed)}通过/${String(row.failed)}失败 · ${String(row.evidence)}`)
  console.log(`[lv2:regression] manifest = ${manifestPath.replace(`${root}\\`, '').replace(/\\/g, '/')}`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main()
