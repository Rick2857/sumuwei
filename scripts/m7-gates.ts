/**
 * M7 WP7 —— **汇总门**（`pnpm m7:gates`）。
 *
 * ============================================================================
 *  纪律（AGENTS §6.4：不要手写"全绿"表格）
 * ============================================================================
 * 只读 `artifacts/m7/` 下已落盘的证据；文件不存在 = `NOT RUN`，不是 PASS。
 * 每份证据按 `m7-manifest@1` 校验（L-M61-14：manifest 缺失/不合规 ⇒ REFUSED，
 * 拒收是真信息）。清单被事后改过（payloadSha256 不符）⇒ REFUSED。
 *
 *  当前读数 = 每个 WP 门**最新封印**的那次运行（排序主键 = 结果文件自带的
 *  capturedAt 封印时戳，对 checkout/merge 的 mtime 扰动免疫；2026-09-26 修），
 *  无论它是 PASS 还是 FAIL——绝不挑绿的（m6 wp10b-live 先例：取最新那份 FAIL）。
 *  历史运行全部列出（含 FAIL 中间档：它们是判据修正的留档，不是噪音）。
 *
 *  WP6-B 的非工件面（人审盲审 / Live Smoke）**分列登记、不进判定门计数**——
 *  没有真实读数时只能标 NOT RUN，不能用离线结果冒充（计划 §7.3）；
 *  两者已于 2026-09-26 完成，状态文本如实更新（判定载体：Gate-Decision §6.1/§6.5）。
 *
 * 跑法：pnpm m7:gates（只读，秒级）
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { M7_RUN_ID_PATTERN, validateM7Manifest } from './m7-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const PARENT = join(REPO_ROOT, 'artifacts/m7')

/** 门清单（冻结：M7 的全部证据面） */
const GATES: readonly {
  readonly gate: string
  readonly wp: string
  readonly resultFile: string
  readonly kind: 'verdict' | 'capture'
}[] = [
  { gate: 'wp0-baseline', wp: 'wp0', resultFile: 'baseline-after.json', kind: 'capture' },
  { gate: 'wp0-admission', wp: 'wp0-admission', resultFile: 'admission.json', kind: 'verdict' },
  { gate: 'wp2-contracts', wp: 'wp2-contracts', resultFile: 'contracts.json', kind: 'verdict' },
  { gate: 'wp3-probe', wp: 'wp3-probe', resultFile: 'probe.json', kind: 'capture' },
  { gate: 'wp3-verify', wp: 'wp3-verify', resultFile: 'verify.json', kind: 'verdict' },
  { gate: 'wp4-verify', wp: 'wp4-verify', resultFile: 'verify.json', kind: 'verdict' },
  { gate: 'wp5-verify', wp: 'wp5-verify', resultFile: 'verify.json', kind: 'verdict' },
  { gate: 'wp6-verify', wp: 'wp6-verify', resultFile: 'verify.json', kind: 'verdict' },
  { gate: 'wp6-td07', wp: 'wp6-td07', resultFile: 'verify.json', kind: 'verdict' },
  { gate: 'wp6-td06', wp: 'wp6-td06', resultFile: 'verify.json', kind: 'verdict' },
  /* WP6-B 真模型面（授权后落地；证据 = 各运行器自封印的 verify.json） */
  { gate: 'wp6b-long', wp: 'wp6b-long', resultFile: 'verify.json', kind: 'verdict' },
  { gate: 'wp6b-td06', wp: 'wp6b-td06', resultFile: 'verify.json', kind: 'verdict' },
  { gate: 'wp6b-level1', wp: 'wp6b-level1', resultFile: 'verify.json', kind: 'verdict' },
  { gate: 'm7-test', wp: 'test', resultFile: 'verify.json', kind: 'verdict' },
  { gate: 'm7-measurement', wp: 'measurement', resultFile: 'verify.json', kind: 'verdict' },
]

/** WP6-B 的"非工件面"分列行：机器门只读 artifacts/m7 工件，这些面不进判定门计数。
 *  2026-09-26 起两者均已完成——行保留（历史可溯），状态文本如实更新：
 *  盲审 = 人审终态在 Gate-Decision §6.5（判定载体是文档不是工件，机器门不冒充）；
 *  Live Smoke = 证据在 artifacts/m4.5/（并发会话未提交领土），M7 门只引用不重复判定。 */
const NOT_RUN_ITEMS: readonly { readonly item: string; readonly reason: string }[] = [
  { item: '人工盲审包（四查）', reason: '已人审完成（2026-09-26 三轮：TD-06 12/12 合格 · Level 1 4/4 · 轨迹四查 4/4；1 处分类分歧登记为量具读数）；终态载体 Gate-Decision §6.5，非机器工件 ⇒ 不进判定门计数' },
  { item: 'm4.5:ci:full（Live Smoke）', reason: '已跑（2026-09-26 EXIT 0 · Production-copy 52/0）；证据归 artifacts/m4.5/（并发会话领土），M7 门只引用不重复判定 ⇒ 不进判定门计数' },
]

interface RunRow {
  readonly runId: string
  readonly date: string
  readonly verdict: string | undefined
  readonly manifestProblems: readonly string[]
  readonly resultFileMissing: boolean
  readonly mtimeMs: number
  /** 结果文件封印时戳（排序主键；对 checkout/merge 的 mtime 扰动免疫） */
  readonly capturedAt: string
}

interface GateRow {
  readonly gate: string
  readonly status: 'PASS' | 'FAIL' | 'MEASUREMENT INVALID' | 'CAPTURED' | 'NOT RUN' | 'REFUSED'
  readonly current: RunRow | undefined
  readonly runs: readonly RunRow[]
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function runsForGate(wp: string, resultFile: string): { runs: RunRow[]; orphans: string[] } {
  const runs: RunRow[] = []
  const orphans: string[] = []
  if (!existsSync(PARENT)) return { runs, orphans }
  const prefix = `m7-${wp}-`
  for (const entry of readdirSync(PARENT)) {
    if (!entry.startsWith(prefix)) continue
    if (!M7_RUN_ID_PATTERN.test(entry)) {
      orphans.push(entry)
      continue
    }
    const dir = join(PARENT, entry)
    const manifestPath = join(dir, 'manifest.json')
    const resultPath = join(dir, resultFile)
    const problems: string[] = []
    let verdict: string | undefined
    if (!existsSync(manifestPath)) {
      problems.push('manifest.json 缺失（运行未封印 ⇒ 拒收）')
    } else {
      for (const p of validateM7Manifest(readJson(manifestPath))) {
        problems.push(`${p.field}: ${p.problem}`)
      }
    }
    const resultFileMissing = !existsSync(resultPath)
    let capturedAt = ''
    if (!resultFileMissing) {
      const result = readJson(resultPath) as { verdict?: unknown; capturedAt?: unknown }
      verdict = typeof result.verdict === 'string' ? result.verdict : undefined
      /* 排序键用**封印时戳**（结果文件自带的 capturedAt），不用文件 mtime：
         checkout/merge 会批量重写工作树 ⇒ mtime 全体刷新 ⇒ "最新落盘"排序
         失稳（2026-09-26 合并实测：3 个门抽到 FAIL 中间档）。
         capturedAt 是封印时写死的，对 git 操作免疫。 */
      if (typeof result.capturedAt === 'string' && result.capturedAt !== '') capturedAt = result.capturedAt
    }
    const mtimeMs = existsSync(manifestPath) ? statSync(manifestPath).mtimeMs : statSync(dir).mtimeMs
    runs.push({
      runId: entry,
      date: entry.split('-').slice(-3, -2)[0] ?? '',
      verdict,
      manifestProblems: problems,
      resultFileMissing,
      mtimeMs,
      capturedAt,
    })
  }
  runs.sort((a, b) => {
    const keyOf = (r: RunRow): string => r.capturedAt || r.date || String(r.mtimeMs)
    const ka = keyOf(a)
    const kb = keyOf(b)
    if (ka !== kb) return ka < kb ? -1 : 1
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs < b.mtimeMs ? -1 : 1
    return a.runId.localeCompare(b.runId)
  })
  return { runs, orphans }
}

function main(): void {
  const gateRows: GateRow[] = []
  const allOrphans: string[] = []
  for (const gate of GATES) {
    const { runs, orphans } = runsForGate(gate.wp, gate.resultFile)
    allOrphans.push(...orphans)
    const accepted = runs.filter((r) => r.manifestProblems.length === 0 && !r.resultFileMissing)
    const current = accepted.length > 0 ? accepted[accepted.length - 1] : undefined
    let status: GateRow['status']
    if (current === undefined) {
      status = runs.length > 0 ? 'REFUSED' : 'NOT RUN'
    } else if (gate.kind === 'capture') {
      status = current.verdict !== undefined ? 'CAPTURED' : 'REFUSED'
    } else if (current.verdict === 'PASS') {
      status = 'PASS'
    } else if (current.verdict === 'FAIL') {
      status = 'FAIL'
    } else if (current.verdict === 'MEASUREMENT INVALID') {
      status = 'MEASUREMENT INVALID'
    } else {
      status = 'REFUSED'
    }
    gateRows.push({ gate: gate.gate, status, current, runs })
  }

  // ---- 汇总判据（本门自己的检查，不装聋）----
  const verdictGates = gateRows.filter((g) => GATES.find((x) => x.gate === g.gate)?.kind === 'verdict')
  const passed = verdictGates.filter((g) => g.status === 'PASS').length
  const failed = verdictGates.filter((g) => g.status === 'FAIL' || g.status === 'MEASUREMENT INVALID').length
  const notRun = verdictGates.filter((g) => g.status === 'NOT RUN').length
  const refused = gateRows.filter((g) => g.status === 'REFUSED').length
  const hardPass =
    failed === 0 && notRun === 0 && refused === 0 && passed === verdictGates.length && passed > 0

  const capturedAt = new Date().toISOString()
  const payload = {
    schema: 'm7-gates@1',
    capturedAt,
    gates: gateRows.map((g) => ({
      gate: g.gate,
      status: g.status,
      current: g.current ? { runId: g.current.runId, verdict: g.current.verdict } : null,
      runCount: g.runs.length,
      history: g.runs.map((r) => ({
        runId: r.runId,
        verdict: r.verdict ?? null,
        refused: r.manifestProblems.length > 0 || r.resultFileMissing,
        problems: r.manifestProblems,
      })),
    })),
    notRun: NOT_RUN_ITEMS,
    orphanDirs: allOrphans,
    summary: {
      verdictGates: verdictGates.length,
      passed,
      failed,
      notRun,
      refused,
      hardGates: hardPass ? 'PASS' : 'NOT PASS',
    },
  }
  writeFileSync(join(PARENT, 'gate-results.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  console.log('M7 gates（只读已落盘证据；NOT RUN ≠ PASS）')
  for (const g of gateRows) {
    const cur = g.current ? `${g.current.runId} → ${g.current.verdict ?? '(无 verdict)'}` : '—'
    console.log(`  ${g.status.padEnd(18)} ${g.gate.padEnd(16)} ${cur}（历史 ${String(g.runs.length)} 次）`)
  }
  console.log('  ---- WP6-B 非工件面（分列 · 不进判定门计数）----')
  for (const item of NOT_RUN_ITEMS) {
    console.log(`  分列登记         ${item.item}（${item.reason}）`)
  }
  if (allOrphans.length > 0) {
    console.log(`  ⚠️ 形状不合 runId 模式的目录：${allOrphans.join(', ')}`)
  }
  console.log(
    `summary: 判定门 ${String(verdictGates.length)} · PASS ${String(passed)} · FAIL ${String(failed)} · NOT RUN ${String(notRun)} · REFUSED ${String(refused)} ⇒ Hard Gates = ${payload.summary.hardGates}`,
  )
  process.exitCode = hardPass ? 0 : 1
}

main()
