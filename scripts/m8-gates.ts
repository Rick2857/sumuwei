/**
 * M8 WP8 —— **`m8:gates` 门汇总**（只读已落盘证据；秒级）。
 *
 * 纪律（计划 §10 WP8 任务 5 + AGENTS §6.4）：
 *   · 只读 `artifacts/m8/<runId>/manifest.json`（`m8-manifest@1` 校验）与各 run
 *     的 payload verdict——**不重跑任何门**；
 *   · 文件不存在 / 清单不合法 = REFUSED / NOT RUN，**不是 PASS**；
 *   · **汇总不能替代底层证据**：本脚本的绿只是索引的绿，判定权在每份
 *     run 目录里的原始读数；
 *   · 失败档**分列保留**（防篡改：FAIL run 不因后来的 PASS 被抹掉，只被
 *     "最新未被取代的 run"取代权威地位）。
 *
 * 权威选取规则（与各 WP 交接单的链一致）：
 *   同 wp 的 run 按 manifest mtime 排序，**最新且未被同 wp 任何 run 的
 *   `supersedes` 指到**者为权威；被指向者标记 superseded 留档。
 *
 * 用法：pnpm m8:gates [--json]（--json 只打印 JSON，不写文件）
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  M8_MANIFEST_VERSION,
  M8_RUN_ID_PATTERN,
  M8_RUN_PARENT,
  validateM8Manifest,
} from './m8-evidence.ts'

const ROOT = resolve(import.meta.dirname, '..')
const PARENT = join(ROOT, M8_RUN_PARENT)

/** M8 的十道门（package.json 的 m8:* 清单 ↔ manifest 的 wp 字段）。
 * `okVerdicts`：该门的"绿"判词——wp0 基线是快照门（BASELINE CAPTURED 即绿），
 * 其余门绿 = PASS。MEASUREMENT INVALID / FAIL / REFUSED 一律不绿。 */
const REQUIRED_GATES: readonly { gate: string; wp: string; okVerdicts: readonly string[] }[] = [
  { gate: 'm8:wp0:baseline', wp: 'wp0', okVerdicts: ['BASELINE CAPTURED'] },
  { gate: 'm8:wp0:admission', wp: 'wp0-admission', okVerdicts: ['PASS'] },
  { gate: 'm8:wp2:contracts', wp: 'wp2-contracts', okVerdicts: ['PASS'] },
  { gate: 'm8:wp3:verify', wp: 'wp3-verify', okVerdicts: ['PASS'] },
  { gate: 'm8:wp4:verify', wp: 'wp4-verify', okVerdicts: ['PASS'] },
  { gate: 'm8:wp5:verify', wp: 'wp5-verify', okVerdicts: ['PASS'] },
  { gate: 'm8:wp6:verify', wp: 'wp6-verify', okVerdicts: ['PASS'] },
  { gate: 'm8:e2e:verify', wp: 'e2e-verify', okVerdicts: ['PASS'] },
  { gate: 'm8:long:verify', wp: 'long-verify', okVerdicts: ['PASS'] },
  { gate: 'm8:live:level1', wp: 'live-level1', okVerdicts: ['PASS'] },
]

interface RunEntry {
  runId: string
  wp: string
  testType: string
  counts: { total: number; passed: number; failed: number }
  supersedes: string | null
  verdict: string
  verdictSource: 'payload' | 'counts-derived'
  manifestMtime: string
  problems: string[]
}

function verdictOf(runDir: string, counts: { failed: number }): {
  verdict: string
  source: 'payload' | 'counts-derived'
} {
  // payload verdict 优先（MEASUREMENT INVALID 只能从 payload 读到）
  try {
    for (const name of readdirSync(runDir)) {
      if (!name.endsWith('.json') || name === 'manifest.json') continue
      try {
        const parsed = JSON.parse(readFileSync(join(runDir, name), 'utf8')) as unknown
        if (parsed !== null && typeof parsed === 'object' && 'verdict' in parsed) {
          const verdict = String((parsed as { verdict: unknown }).verdict)
          if (verdict !== '') return { verdict, source: 'payload' }
        }
      } catch {
        /* 单个 payload 坏了不算致命——继续找 */
      }
    }
  } catch {
    /* 目录不可读 ⇒ 走 counts 推导 */
  }
  return { verdict: counts.failed === 0 ? 'PASS' : 'FAIL', source: 'counts-derived' }
}

function main(): void {
  if (!existsSync(PARENT)) {
    console.error(`找不到 ${PARENT}`)
    process.exit(2)
  }

  const runs: RunEntry[] = []
  for (const name of readdirSync(PARENT)) {
    if (!M8_RUN_ID_PATTERN.test(name)) continue
    const dir = join(PARENT, name)
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      runs.push({
        runId: name,
        wp: '(未知——无清单)',
        testType: '(无清单)',
        counts: { total: 0, passed: 0, failed: 0 },
        supersedes: null,
        verdict: 'REFUSED',
        verdictSource: 'counts-derived',
        manifestMtime: '',
        problems: ['manifest.json 缺失（运行中断或被拒——留档不判）'],
      })
      continue
    }
    let manifest: unknown
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      runs.push({
        runId: name,
        wp: '(未知——清单不可解析)',
        testType: '(清单不可解析)',
        counts: { total: 0, passed: 0, failed: 0 },
        supersedes: null,
        verdict: 'REFUSED',
        verdictSource: 'counts-derived',
        manifestMtime: '',
        problems: [`manifest.json 不可解析：${error instanceof Error ? error.message : String(error)}`],
      })
      continue
    }
    const problems = validateM8Manifest(manifest).map((p) => `${p.field}: ${p.problem}`)
    const record = manifest as Record<string, unknown>
    const countsRaw = (record.counts ?? {}) as Record<string, unknown>
    const counts = {
      total: Number(countsRaw.total ?? 0),
      passed: Number(countsRaw.passed ?? 0),
      failed: Number(countsRaw.failed ?? 0),
    }
    const { verdict, source } = problems.length > 0
      ? { verdict: 'REFUSED', source: 'counts-derived' as const }
      : verdictOf(dir, counts)
    runs.push({
      runId: name,
      wp: String(record.wp ?? '(缺 wp)'),
      testType: String(record.testType ?? '(缺 testType)'),
      counts,
      supersedes: typeof record.supersedes === 'string' ? record.supersedes : null,
      verdict,
      verdictSource: source,
      manifestMtime: new Date(statSync(manifestPath).mtimeMs).toISOString(),
      problems,
    })
  }

  // 被 supersedes 指到的 run（同 wp 内）标记为已取代
  const superseded = new Set<string>()
  for (const run of runs) {
    if (run.supersedes !== null) superseded.add(run.supersedes)
  }

  // 按 wp 分组，选权威（最新 mtime 且未被取代）
  const byWp = new Map<string, RunEntry[]>()
  for (const run of runs) {
    const list = byWp.get(run.wp) ?? []
    list.push(run)
    byWp.set(run.wp, list)
  }

  interface GateRow {
    gate: string
    wp: string
    status: string
    authoritativeRun: string | null
    counts: string | null
    runsTotal: number
    failRunsOnRecord: number
    note: string
  }
  const rows: GateRow[] = []
  for (const required of REQUIRED_GATES) {
    const group = (byWp.get(required.wp) ?? []).slice().sort((a, b) =>
      a.manifestMtime.localeCompare(b.manifestMtime)
    )
    if (group.length === 0) {
      rows.push({
        gate: required.gate,
        wp: required.wp,
        status: 'NOT RUN',
        authoritativeRun: null,
        counts: null,
        runsTotal: 0,
        failRunsOnRecord: 0,
        note: '无任何 run 目录',
      })
      continue
    }
    const candidates = group.filter((r) => !superseded.has(r.runId))
    const authoritative = (candidates.length > 0 ? candidates : group)[
      (candidates.length > 0 ? candidates : group).length - 1
    ]
    const status = required.okVerdicts.includes(authoritative.verdict)
      ? 'PASS'
      : authoritative.verdict
    const failRuns = group.filter((r) => !required.okVerdicts.includes(r.verdict)).length
    rows.push({
      gate: required.gate,
      wp: required.wp,
      status,
      authoritativeRun: authoritative.runId,
      counts: `${String(authoritative.counts.passed)}/${String(authoritative.counts.total)}`,
      runsTotal: group.length,
      failRunsOnRecord: failRuns,
      note:
        authoritative.problems.length > 0
          ? authoritative.problems.join('；')
          : `${String(group.length)} 个 run 在案（非绿 ${String(failRuns)} 个分列保留）`,
    })
  }

  const hardGatesPass = rows.every((r) => r.status === 'PASS')
  const summary = {
    schema: 'm8-gates@1',
    manifestVersion: M8_MANIFEST_VERSION,
    capturedAt: new Date().toISOString(),
    readOnly: true,
    disclaimer: '汇总不能替代底层证据：判定权在 artifacts/m8/<runId>/ 的原始读数；本文件只是索引。',
    hardGates: hardGatesPass ? 'PASS' : 'NOT PASS',
    gates: rows,
    runs: runs
      .slice()
      .sort((a, b) => a.runId.localeCompare(b.runId))
      .map((r) => ({
        runId: r.runId,
        wp: r.wp,
        testType: r.testType,
        verdict: r.verdict,
        verdictSource: r.verdictSource,
        counts: r.counts,
        supersedes: r.supersedes,
        superseded: superseded.has(r.runId),
        manifestMtime: r.manifestMtime,
        problems: r.problems,
      })),
  }

  const jsonOnly = process.argv.includes('--json')
  if (!jsonOnly) {
    console.log('='.repeat(78))
    console.log('M8 门汇总（只读已落盘证据——不重跑任何门）')
    console.log('='.repeat(78))
    for (const row of rows) {
      const mark = row.status === 'PASS' ? '✅' : row.status === 'NOT RUN' ? '⬜' : '❌'
      console.log(
        `  ${mark} ${row.gate.padEnd(20)} ${row.status.padEnd(10)} ${row.counts ?? '—'.padEnd(5)}   ${row.authoritativeRun ?? '—'}`
      )
      console.log(`      ${row.note}`)
    }
    console.log('-'.repeat(78))
    console.log(`  Hard Gates = ${hardGatesPass ? 'PASS' : 'NOT PASS'}（${String(rows.filter((r) => r.status === 'PASS').length)}/${String(rows.length)} 门权威读数为 PASS）`)
    console.log(`  在案 run 总数 ${String(runs.length)}（含失败档与被取代档——分列保留，不回写）`)
    console.log('  ⚠️ 汇总不能替代底层证据；生产激活另需 WP9 独立裁定（PASS / NOT ACTIVATED）。')
  }

  const outPath = join(PARENT, 'gate-results.json')
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  if (!jsonOnly) console.log(`  写出 ${outPath}`)
  process.exitCode = hardGatesPass ? 0 : 1
}

main()
