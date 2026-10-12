/**
 * M8.5 WP12 —— **`m8.5:gates` 门汇总**（只读已落盘证据；秒级）。
 *
 * 纪律（计划 §21 + Acceptance-Contract §1/§5）：
 *   · 只读 `artifacts/m8.5/<runId>/*.json` 的 payload verdict——**不重跑任何门**；
 *   · 文件不存在 = NOT RUN，**不是 PASS**；不手写全绿表；
 *   · **汇总不能替代底层证据**：本脚本的绿只是索引的绿，判定权在每份 run
 *     目录里的原始读数；
 *   · 失败档**分列保留**（防篡改：FAIL run 不因后来的 PASS 被抹掉；权威读数
 *     = 最新 mtime 的 run，全部 run 留档计数）；
 *   · **分列不合成总分**：离线硬门 / 真模型语义评估 / 真实链路三条 lane 各自
 *     判定（m6.1 先例——聚合失败关闭如实拒收）。
 *
 * 与 m8:gates 的差异：M8.5 运行器不写 manifest.json，payload 自带
 * `gate` + `verdict` 字段——本聚合器按目录前缀 + payload 文件名识别门，
 * verdict 以 payload 为权威（缺 verdict 的目录 = REFUSED 留档）。
 *
 * 已裁定残差的索引（不是判定）：盲测终轮机械 verdict=FAIL（关键假阳 2/29），
 * 用户 2026-09-27 裁定接受为残差（WP10 交接单 §5.3 裁定二；b-rep-006 金标交
 * WP12 人审）。本聚合器如实显示 ADJUDICATED RESIDUAL + 裁定出处，**不冒充
 * PASS**；人审改判后按 Corpus-Spec §6 回写程序更新。
 *
 * 用法：pnpm m8.5:gates [--json]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PARENT = join(ROOT, 'artifacts', 'm8.5')

/** 门 → 目录前缀 + payload 文件名 + 绿判词。shadow 无硬阈值（§18）⇒ READINGS 即绿。 */
interface GateSpec {
  gate: string
  dirPrefix: string
  payloadFile: string
  okVerdicts: readonly string[]
  lane: 'offline' | 'semantic' | 'realchain'
}

const GATES: readonly GateSpec[] = [
  { gate: 'm8.5:test', dirPrefix: 'test-', payloadFile: 'test.json', okVerdicts: ['PASS'], lane: 'offline' },
  { gate: 'm8.5:corpus:verify', dirPrefix: 'corpus-replay-', payloadFile: 'corpus-replay.json', okVerdicts: ['PASS'], lane: 'offline' },
  { gate: 'm8.5:wp3:contracts', dirPrefix: 'wp3-contracts-', payloadFile: 'wp3-contracts.json', okVerdicts: ['PASS'], lane: 'offline' },
  { gate: 'm8.5:wp4:verify', dirPrefix: 'wp4-verify-', payloadFile: 'wp4-verify.json', okVerdicts: ['PASS'], lane: 'offline' },
  { gate: 'm8.5:wp5:verify', dirPrefix: 'wp5-verify-', payloadFile: 'wp5-verify.json', okVerdicts: ['PASS'], lane: 'offline' },
  { gate: 'm8.5:wp6:verify', dirPrefix: 'wp6-verify-', payloadFile: 'wp6-verify.json', okVerdicts: ['PASS'], lane: 'offline' },
  { gate: 'm8.5:wp7:verify', dirPrefix: 'wp7-verify-', payloadFile: 'wp7-verify.json', okVerdicts: ['PASS'], lane: 'offline' },
  { gate: 'm8.5:wp8:verify', dirPrefix: 'wp8-verify-', payloadFile: 'wp8-verify.json', okVerdicts: ['PASS'], lane: 'offline' },
  { gate: 'm8.5:verify（离线链）', dirPrefix: 'verify-', payloadFile: 'verify.json', okVerdicts: ['PASS'], lane: 'offline' },
  { gate: 'm8.5:blind:run', dirPrefix: 'blind-', payloadFile: 'blind-metrics.json', okVerdicts: ['PASS'], lane: 'semantic' },
  { gate: 'm8.5:shadow:run', dirPrefix: 'shadow-', payloadFile: 'shadow-taxonomy.json', okVerdicts: ['READINGS'], lane: 'semantic' },
  { gate: 'm8.5:e2e:verify', dirPrefix: 'e2e-', payloadFile: 'e2e-verify.json', okVerdicts: ['PASS'], lane: 'realchain' },
  { gate: 'm8.5:long:verify', dirPrefix: 'long-', payloadFile: 'long-verify.json', okVerdicts: ['PASS'], lane: 'realchain' },
  { gate: 'm8.5:live:level1', dirPrefix: 'live85-', payloadFile: 'live85-verify.json', okVerdicts: ['PASS'], lane: 'realchain' },
]

/** 已裁定残差索引（出处 = WP10 交接单 §5.3；显示用，不是判定）。 */
const ADJUDICATED: Readonly<Record<string, string>> = {
  'm8.5:blind:run':
    '用户 2026-09-27 裁定：关键假阳性 2/29 接受为残差（10/11 过；b-rep-006 金标交 WP12 人审，b-host-010 随翻转率复核）——WP10 交接单 §5.3 裁定二',
}

interface RunEntry {
  runId: string
  gate: string | null
  verdict: string
  counts: string
  mtime: string
  problems: string[]
}

function readVerdict(dir: string, payloadFile: string): {
  verdict: string
  counts: string
  problems: string[]
} {
  const payloadPath = join(dir, payloadFile)
  if (!existsSync(payloadPath)) {
    return { verdict: 'REFUSED', counts: '—', problems: [`${payloadFile} 缺失（运行中断或被拒——留档不判）`] }
  }
  try {
    const parsed = JSON.parse(readFileSync(payloadPath, 'utf8')) as Record<string, unknown>
    const verdict = String(parsed.verdict ?? '')
    if (verdict === '') {
      return { verdict: 'REFUSED', counts: '—', problems: ['payload 无 verdict 字段'] }
    }
    const countsField = (parsed.counts ?? {}) as Record<string, unknown>
    const total = parsed.total ?? countsField.total
    const failed = parsed.failed ?? countsField.failed
    const totalNum = Number(total ?? 0)
    const failedNum = Number(failed ?? 0)
    const passedNum = typeof parsed.passed === 'number' ? parsed.passed : totalNum - failedNum
    const counts = total !== undefined ? `${String(passedNum)}/${String(totalNum)}` : '—'
    return { verdict, counts, problems: [] }
  } catch (error) {
    return { verdict: 'REFUSED', counts: '—', problems: [`payload 不可解析：${error instanceof Error ? error.message : String(error)}`] }
  }
}

function main(): void {
  if (!existsSync(PARENT)) {
    console.error(`找不到 ${PARENT}`)
    process.exit(2)
  }

  const runs: RunEntry[] = []
  const knownPrefixes = GATES.map((g) => g.dirPrefix)
  for (const name of readdirSync(PARENT)) {
    const dir = join(PARENT, name)
    if (!statSync(dir).isDirectory()) continue
    const spec = GATES.find((g) => name.startsWith(g.dirPrefix))
    if (spec === undefined) {
      // 历史目录（wp0-…、wp2-…）与 local：不属于现行门清单——留档不计门
      if (knownPrefixes.some((p) => name.startsWith(p)) || name === 'local') continue
      runs.push({ runId: name, gate: null, verdict: '(历史/非门目录)', counts: '—', mtime: '', problems: [] })
      continue
    }
    const { verdict, counts, problems } = readVerdict(dir, spec.payloadFile)
    const payloadStats = statSync(join(dir, spec.payloadFile), { throwIfNoEntry: false })
    const stamp = payloadStats?.mtimeMs ?? statSync(dir).mtimeMs
    runs.push({
      runId: name,
      gate: spec.gate,
      verdict,
      counts,
      mtime: new Date(stamp).toISOString(),
      problems,
    })
  }

  interface GateRow {
    gate: string
    lane: string
    status: string
    authoritativeRun: string | null
    counts: string | null
    runsTotal: number
    nonGreenOnRecord: number
    note: string
  }
  const rows: GateRow[] = []
  for (const spec of GATES) {
    const group = runs
      .filter((r) => r.gate === spec.gate)
      .sort((a, b) => a.mtime.localeCompare(b.mtime))
    if (group.length === 0) {
      rows.push({
        gate: spec.gate,
        lane: spec.lane,
        status: 'NOT RUN',
        authoritativeRun: null,
        counts: null,
        runsTotal: 0,
        nonGreenOnRecord: 0,
        note: '无任何 run 目录',
      })
      continue
    }
    const authoritative = group[group.length - 1]
    const adjudicated = ADJUDICATED[spec.gate]
    let status: string
    if (spec.okVerdicts.includes(authoritative.verdict)) {
      status = 'PASS'
    } else if (adjudicated !== undefined && authoritative.verdict === 'FAIL') {
      status = 'ADJUDICATED RESIDUAL'
    } else {
      status = authoritative.verdict
    }
    const nonGreen = group.filter((r) => !spec.okVerdicts.includes(r.verdict)).length
    rows.push({
      gate: spec.gate,
      lane: spec.lane,
      status,
      authoritativeRun: authoritative.runId,
      counts: authoritative.counts,
      runsTotal: group.length,
      nonGreenOnRecord: nonGreen,
      note:
        authoritative.problems.length > 0
          ? authoritative.problems.join('；')
          : adjudicated !== undefined && status === 'ADJUDICATED RESIDUAL'
            ? `${adjudicated}；${String(group.length)} 个 run 在案（非绿 ${String(nonGreen)} 个分列保留）`
            : `${String(group.length)} 个 run 在案（非绿 ${String(nonGreen)} 个分列保留）`,
    })
  }

  const laneVerdict = (lane: string): string => {
    const laneRows = rows.filter((r) => r.lane === lane)
    if (laneRows.length === 0) return 'NOT RUN'
    if (laneRows.every((r) => r.status === 'PASS')) return 'PASS'
    if (lane === 'semantic' && laneRows.every((r) => r.status === 'PASS' || r.status === 'ADJUDICATED RESIDUAL' || r.status === 'READINGS')) {
      return 'PASS（含已裁定残差——分列，不是无残差）'
    }
    return 'NOT PASS'
  }

  const offline = laneVerdict('offline')
  const semantic = laneVerdict('semantic')
  const realchain = laneVerdict('realchain')
  const summary = {
    schema: 'm8.5-gates@1',
    capturedAt: new Date().toISOString(),
    readOnly: true,
    disclaimer:
      '汇总不能替代底层证据：判定权在 artifacts/m8.5/<runId>/ 的原始读数；本文件只是索引。三条 lane 分列判定，不合成总分。生产激活另需 §20 人审 PASS + 用户显式批准（§22.1，不可被本汇总替代）。',
    lanes: { offlineHardGates: offline, semanticEvaluation: semantic, realChain: realchain },
    gates: rows,
    runs: runs
      .slice()
      .sort((a, b) => a.runId.localeCompare(b.runId))
      .map((r) => ({
        runId: r.runId,
        gate: r.gate,
        verdict: r.verdict,
        counts: r.counts,
        mtime: r.mtime,
        problems: r.problems,
      })),
  }

  const jsonOnly = process.argv.includes('--json')
  if (!jsonOnly) {
    console.log('='.repeat(78))
    console.log('M8.5 门汇总（只读已落盘证据——不重跑任何门；三 lane 分列）')
    console.log('='.repeat(78))
    for (const lane of ['offline', 'semantic', 'realchain'] as const) {
      const laneName = lane === 'offline' ? '离线硬门' : lane === 'semantic' ? '真模型语义评估' : '真实链路'
      console.log(`── ${laneName} ──`)
      for (const row of rows.filter((r) => r.lane === lane)) {
        const mark = row.status === 'PASS' ? '✅' : row.status === 'NOT RUN' ? '⬜' : row.status === 'ADJUDICATED RESIDUAL' ? '⚖️ ' : '❌'
        console.log(
          `  ${mark} ${row.gate.padEnd(24)} ${row.status.padEnd(20)} ${row.counts ?? '—'}   ${row.authoritativeRun ?? '—'}`
        )
        if (row.note !== '') console.log(`      ${row.note}`)
      }
    }
    console.log('-'.repeat(78))
    console.log(`  离线硬门     = ${offline}`)
    console.log(`  语义评估     = ${semantic}`)
    console.log(`  真实链路     = ${realchain}`)
    console.log(`  在案 run 总数 ${String(runs.length)}（含失败档——分列保留，不回写）`)
    console.log('  ⚠️ 汇总不能替代底层证据；激活另需人审 PASS + 用户显式批准（§22.1）。')
  }

  const outPath = join(PARENT, 'gate-results.json')
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  if (!jsonOnly) console.log(`  写出 ${outPath}`)
  const ok =
    (offline === 'PASS' || offline === 'PASS（含已裁定残差——分列，不是无残差）') &&
    (semantic === 'PASS' || semantic === 'PASS（含已裁定残差——分列，不是无残差）') &&
    realchain === 'PASS'
  process.exitCode = ok ? 0 : 1
}

main()
