/**
 * M9 WP10 —— **`m9:gates` 门汇总**（只读已落盘证据；秒级）。
 *
 * 纪律（计划 §16.3 + AGENTS §6.4，逐字沿用 m8:gates）：
 *   · 只读 `artifacts/m9/<runId>/manifest.json`（`m9-manifest@1` 校验）与各 run
 *     的 payload verdict——**不重跑任何门**；
 *   · 文件不存在 / 清单不合法 = REFUSED / NOT RUN，**不是 PASS**；
 *   · **汇总不能替代底层证据**：本脚本的绿只是索引的绿，判定权在每份
 *     run 目录里的原始读数；
 *   · 失败档**分列保留**（防篡改：FAIL run 不因后来的 PASS 被抹掉）。
 *
 * M9 特有规则（与 m8:gates 的差异，各有依据）：
 *   ① **分组键 = runId 前缀**（manifest 的 wp 字段在 M9 有歧义：wp0 同时是
 *     baseline 与 admission、wp8 同时是 e2e 与 scale——前缀唯一且稳定）；
 *   ② **一次性准入记录**（m9:wp0:admission）：它断言开工前基线，M9 建成后
 *     按设计翻红（18/25）。聚合器取**最早**的 run（准入当时的读数）标记
 *     ACCEPTED (one-time)，不取最新——与 lane 的 acceptExitCodes=[1] 同语义；
 *     当前态权威 = m9:wp0r:verify；
 *   ③ **live 门是"运行集"不是单 run**（计划 §15.3：level1 = 3 次独立运行、
 *     long ≥1 次）：按 payload 的 corpusVersion 分集，**最新语料版本的集**为
 *     权威；集 verdict = PASS 当且仅当**集内每个 run 都 PASS** 且集大小达标
 *     （level1 ≥3、long ≥1）。旧语料版本的集 = 被量具修订取代（分列保留）；
 *   ④ **审计取消项分列**（`M9-M95-Overlap-Audit.md`，`be8d1cf`）：B32
 *     （m9:long:verify）与 B43 recall 半边记 CANCELLED——不是 NOT RUN
 *     （没跑）也不是 FAIL（跑了没过），是**裁定不建**；不计入硬门分母。
 *
 * 用法：pnpm m9:gates [--json]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { M9_MANIFEST_VERSION, M9_RUN_PARENT, validateM9Manifest } from './m9-evidence.ts'

const ROOT = resolve(import.meta.dirname, '..')
const PARENT = join(ROOT, M9_RUN_PARENT)

interface GateSpec9 {
  gate: string
  prefix: string
  okVerdicts: readonly string[]
  /** 'latest' = 最新未被取代的 run（缺省）；'earliest' = 一次性记录（admission） */
  authority: 'latest' | 'earliest'
  /** live 运行集：按 corpusVersion 分集，集大小下限 */
  setBased?: { minRuns: number }
  note?: string
}

const REQUIRED_GATES: readonly GateSpec9[] = [
  { gate: 'm9:wp0:baseline', prefix: 'm9-wp0-', okVerdicts: ['BASELINE CAPTURED'], authority: 'latest' },
  {
    gate: 'm9:wp0:admission',
    prefix: 'm9-wp0-admission-',
    okVerdicts: ['PASS'],
    authority: 'earliest',
    note: '一次性准入记录（准入当时的 PASS 见 docs/m9/M9-Admission-Report.md；建成后按设计翻红，当前态权威 = m9:wp0r:verify）',
  },
  { gate: 'm9:wp0r:verify', prefix: 'm9-wp0r-verify-', okVerdicts: ['PASS'], authority: 'latest' },
  { gate: 'm9:measurement:verify', prefix: 'm9-wp2-measurement-', okVerdicts: ['PASS'], authority: 'latest' },
  { gate: 'm9:source:verify', prefix: 'm9-wp3-source-', okVerdicts: ['PASS'], authority: 'latest' },
  { gate: 'm9:verify', prefix: 'm9-wp4-verify-', okVerdicts: ['PASS'], authority: 'latest' },
  { gate: 'm9:invalidation:verify', prefix: 'm9-wp5-invalidation-', okVerdicts: ['PASS'], authority: 'latest' },
  { gate: 'm9:runtime:verify', prefix: 'm9-wp6-runtime-', okVerdicts: ['PASS'], authority: 'latest' },
  { gate: 'm9:context:verify', prefix: 'm9-wp7-context-', okVerdicts: ['PASS'], authority: 'latest' },
  { gate: 'm9:e2e:verify', prefix: 'm9-wp8-e2e-', okVerdicts: ['PASS'], authority: 'latest' },
  { gate: 'm9:scale:verify', prefix: 'm9-wp8-scale-', okVerdicts: ['PASS'], authority: 'latest' },
  {
    gate: 'm9:live:level1',
    prefix: 'm9-live-level1-',
    okVerdicts: ['PASS'],
    authority: 'latest',
    setBased: { minRuns: 3 },
    note: '§15.3 运行集：最新语料版本的 3 次独立运行须全 PASS（严重项 0 容忍）',
  },
  {
    gate: 'm9:live:long',
    prefix: 'm9-live-long-',
    okVerdicts: ['PASS'],
    authority: 'latest',
    setBased: { minRuns: 1 },
    note: '§15.3 长集：最新语料版本 ≥1 次 200 连续轮',
  },
]

/** 审计取消项（M9-M95-Overlap-Audit.md，be8d1cf）——分列展示，不计入硬门分母 */
const CANCELLED_ITEMS: readonly { item: string; disposition: string; authority: string }[] = [
  {
    item: 'B32（更正后 60/200/500 轮追问 · m9:long:verify）',
    disposition: 'CANCELLED——不建、不在 M9 出证据（与 M9.5 迭代关系；落后一代建设取消）',
    authority: 'M9-M95-Overlap-Audit.md §3.1 裁定一（be8d1cf）',
  },
  {
    item: 'B43 recall 半边（候选范围如实报告）',
    disposition: 'CANCELLED——移交 M9.5 TD-08（S31/S32）',
    authority: 'M9-M95-Overlap-Audit.md §3.1 裁定二（be8d1cf）',
  },
]

interface RunEntry {
  runId: string
  prefix: string
  wp: string
  testType: string
  counts: { total: number; passed: number; failed: number }
  supersedes: string | null
  verdict: string
  verdictSource: 'payload' | 'counts-derived'
  corpusVersion: string | null
  manifestMtime: string
  problems: string[]
}

/** payload verdict + corpusVersion（live 门分集用） */
function payloadFacts(runDir: string, counts: { failed: number }): {
  verdict: string
  source: 'payload' | 'counts-derived'
  corpusVersion: string | null
} {
  try {
    for (const name of readdirSync(runDir)) {
      if (!name.endsWith('.json') || name === 'manifest.json') continue
      try {
        const parsed = JSON.parse(readFileSync(join(runDir, name), 'utf8')) as unknown
        if (parsed !== null && typeof parsed === 'object' && 'verdict' in parsed) {
          const verdict = String((parsed as { verdict: unknown }).verdict)
          if (verdict !== '') {
            const corpusVersion =
              'corpusVersion' in (parsed as Record<string, unknown>)
                ? String((parsed as Record<string, unknown>).corpusVersion)
                : null
            return { verdict, source: 'payload', corpusVersion }
          }
        }
      } catch {
        /* 单个 payload 坏了不算致命——继续找 */
      }
    }
  } catch {
    /* 目录不可读 ⇒ 走 counts 推导 */
  }
  return { verdict: counts.failed === 0 ? 'PASS' : 'FAIL', source: 'counts-derived', corpusVersion: null }
}

function main(): void {
  if (!existsSync(PARENT)) {
    console.error(`找不到 ${PARENT}`)
    process.exit(2)
  }

  const runs: RunEntry[] = []
  for (const name of readdirSync(PARENT)) {
    /* 最长前缀优先：'m9-wp0-admission-' 必须赢过 'm9-wp0-'（否则准入 run 被基线门吞掉） */
    const matched = REQUIRED_GATES
      .filter((g) => name.startsWith(g.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0]
    if (matched === undefined) continue
    const dir = join(PARENT, name)
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      runs.push({
        runId: name,
        prefix: matched.prefix,
        wp: '(未知——无清单)',
        testType: '(无清单)',
        counts: { total: 0, passed: 0, failed: 0 },
        supersedes: null,
        verdict: 'REFUSED',
        verdictSource: 'counts-derived',
        corpusVersion: null,
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
        prefix: matched.prefix,
        wp: '(未知——清单不可解析)',
        testType: '(清单不可解析)',
        counts: { total: 0, passed: 0, failed: 0 },
        supersedes: null,
        verdict: 'REFUSED',
        verdictSource: 'counts-derived',
        corpusVersion: null,
        manifestMtime: '',
        problems: [`manifest.json 不可解析：${error instanceof Error ? error.message : String(error)}`],
      })
      continue
    }
    const problems = validateM9Manifest(manifest).map((p) => `${p.field}: ${p.problem}`)
    const record = manifest as Record<string, unknown>
    const countsRaw = (record.counts ?? {}) as Record<string, unknown>
    const counts = {
      total: Number(countsRaw.total ?? 0),
      passed: Number(countsRaw.passed ?? 0),
      failed: Number(countsRaw.failed ?? 0),
    }
    const facts = problems.length > 0
      ? { verdict: 'REFUSED', source: 'counts-derived' as const, corpusVersion: null as string | null }
      : payloadFacts(dir, counts)
    runs.push({
      runId: name,
      prefix: matched.prefix,
      wp: String(record.wp ?? '(缺 wp)'),
      testType: String(record.testType ?? '(缺 testType)'),
      counts,
      supersedes: typeof record.supersedes === 'string' ? record.supersedes : null,
      verdict: facts.verdict,
      verdictSource: facts.source,
      corpusVersion: facts.corpusVersion,
      manifestMtime: new Date(statSync(manifestPath).mtimeMs).toISOString(),
      problems,
    })
  }

  const superseded = new Set<string>()
  for (const run of runs) {
    if (run.supersedes !== null) superseded.add(run.supersedes)
  }

  interface GateRow {
    gate: string
    status: string
    authoritativeRun: string | null
    counts: string | null
    runsTotal: number
    failRunsOnRecord: number
    note: string
  }
  const rows: GateRow[] = []
  for (const required of REQUIRED_GATES) {
    const group = runs
      .filter((r) => r.prefix === required.prefix)
      .slice()
      .sort((a, b) => a.manifestMtime.localeCompare(b.manifestMtime))
    if (group.length === 0) {
      rows.push({
        gate: required.gate,
        status: 'NOT RUN',
        authoritativeRun: null,
        counts: null,
        runsTotal: 0,
        failRunsOnRecord: 0,
        note: '无任何 run 目录',
      })
      continue
    }

    if (required.setBased !== undefined) {
      /* live 运行集：按 corpusVersion 分集，最新集为权威，集内全 PASS 才绿。
       * 无清单的 run（运行中/中断）不进集——它们没有 payload 可判；
       * 集内 0 个可判 run ⇒ NOT RUN（不是 FAIL）。 */
      const judged = group.filter((r) => r.verdict !== 'REFUSED' || r.problems.some((p) => !p.includes('manifest.json 缺失')))
      const pending = group.length - judged.length
      const sets = new Map<string, typeof judged>()
      for (const run of judged) {
        const key = run.corpusVersion ?? '(无 payload 语料版本)'
        const list = sets.get(key) ?? []
        list.push(run)
        sets.set(key, list)
      }
      let authoritativeSet: typeof judged = []
      let authoritativeKey = ''
      for (const [key, list] of sets) {
        const latest = list.reduce((a, b) => (a.manifestMtime.localeCompare(b.manifestMtime) >= 0 ? a : b))
        const best = authoritativeSet.reduce(
          (a, b) => (a.manifestMtime.localeCompare(b.manifestMtime) >= 0 ? a : b),
          { manifestMtime: '' } as typeof latest
        )
        if (latest.manifestMtime.localeCompare(best.manifestMtime) > 0 || authoritativeSet.length === 0) {
          authoritativeSet = list
          authoritativeKey = key
        }
      }
      const minRuns = required.setBased.minRuns
      const failInSet = authoritativeSet.filter((r) => !required.okVerdicts.includes(r.verdict))
      const sizeOk = authoritativeSet.length >= minRuns
      const status = authoritativeSet.length === 0
        ? `NOT RUN（无可判 run${pending > 0 ? `；${String(pending)} 个无清单（运行中或中断）` : ''}）`
        : !sizeOk
          ? `NOT RUN（集内仅 ${String(authoritativeSet.length)} < ${String(minRuns)} 次独立运行）`
          : failInSet.length === 0
            ? 'PASS'
            : `FAIL（集内 ${String(failInSet.length)}/${String(authoritativeSet.length)} 非 PASS）`
      const failRuns = judged.filter((r) => !required.okVerdicts.includes(r.verdict)).length
      rows.push({
        gate: required.gate,
        status,
        authoritativeRun: authoritativeSet.length === 0 ? null : `${authoritativeKey} × ${String(authoritativeSet.length)} runs`,
        counts: authoritativeSet.length === 0 ? null : `${String(authoritativeSet.filter((r) => required.okVerdicts.includes(r.verdict)).length)}/${String(authoritativeSet.length)}`,
        runsTotal: group.length,
        failRunsOnRecord: failRuns,
        note: `${required.note ?? ''}；共 ${String(sets.size)} 个语料版本集在案（旧集 = 被量具修订取代，分列保留）${pending > 0 ? `；${String(pending)} 个无清单 run 留档不判` : ''}`,
      })
      continue
    }

    const candidates = group.filter((r) => !superseded.has(r.runId))
    const pool = candidates.length > 0 ? candidates : group
    const authoritative =
      required.authority === 'earliest' ? pool[0] : pool[pool.length - 1]
    if (authoritative === undefined) {
      rows.push({ gate: required.gate, status: 'NOT RUN', authoritativeRun: null, counts: null, runsTotal: 0, failRunsOnRecord: 0, note: '无有效 run' })
      continue
    }
    const isAdmission = required.authority === 'earliest'
    const status = isAdmission
      ? 'ACCEPTED (one-time)'
      : required.okVerdicts.includes(authoritative.verdict)
        ? 'PASS'
        : authoritative.verdict
    const failRuns = group.filter((r) => !required.okVerdicts.includes(r.verdict)).length
    rows.push({
      gate: required.gate,
      status,
      authoritativeRun: authoritative.runId,
      counts: `${String(authoritative.counts.passed)}/${String(authoritative.counts.total)}`,
      runsTotal: group.length,
      failRunsOnRecord: failRuns,
      note:
        required.note ??
        (authoritative.problems.length > 0
          ? authoritative.problems.join('；')
          : `${String(group.length)} 个 run 在案（非绿 ${String(failRuns)} 个分列保留）`),
    })
  }

  const hardGatesPass = rows.every((r) => r.status === 'PASS' || r.status === 'ACCEPTED (one-time)')
  const summary = {
    schema: 'm9-gates@1',
    manifestVersion: M9_MANIFEST_VERSION,
    capturedAt: new Date().toISOString(),
    readOnly: true,
    disclaimer: '汇总不能替代底层证据：判定权在 artifacts/m9/<runId>/ 的原始读数；本文件只是索引。',
    hardGates: hardGatesPass ? 'PASS' : 'NOT PASS',
    gates: rows,
    cancelled: CANCELLED_ITEMS,
    runs: runs
      .slice()
      .sort((a, b) => a.runId.localeCompare(b.runId))
      .map((r) => ({
        runId: r.runId,
        wp: r.wp,
        testType: r.testType,
        verdict: r.verdict,
        verdictSource: r.verdictSource,
        corpusVersion: r.corpusVersion,
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
    console.log('M9 门汇总（只读已落盘证据——不重跑任何门）')
    console.log('='.repeat(78))
    for (const row of rows) {
      const mark = row.status === 'PASS' || row.status === 'ACCEPTED (one-time)' ? '✅' : row.status.startsWith('NOT RUN') ? '⬜' : '❌'
      console.log(`  ${mark} ${row.gate.padEnd(22)} ${row.status.padEnd(14)} ${row.counts ?? '—'}   ${row.authoritativeRun ?? '—'}`)
      console.log(`      ${row.note}`)
    }
    console.log('-'.repeat(78))
    for (const item of CANCELLED_ITEMS) {
      console.log(`  ⛔ CANCELLED  ${item.item}`)
      console.log(`      ${item.disposition}（权威：${item.authority}）`)
    }
    console.log('-'.repeat(78))
    console.log(`  Hard Gates = ${hardGatesPass ? 'PASS' : 'NOT PASS'}（${String(rows.filter((r) => r.status === 'PASS' || r.status === 'ACCEPTED (one-time)').length)}/${String(rows.length)} 门权威读数为绿）`)
    console.log(`  在案 run 总数 ${String(runs.length)}（含失败档与被取代档——分列保留，不回写）`)
    console.log('  ⚠️ 汇总不能替代底层证据；生产激活另需 WP11 独立裁定（M9-D26）。')
  }

  const outPath = join(PARENT, 'gate-results.json')
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  if (!jsonOnly) console.log(`  写出 ${outPath}`)
  process.exitCode = hardGatesPass ? 0 : 1
}

main()
