/**
 * M11 WP11 —— **只读聚合门**（`m11:gates`，计划 §12.1）。
 *
 * ============================================================================
 *  计划 §12.1 对它的要求
 * ============================================================================
 * ```text
 * 「`m11:gates` | **只读聚合** | 分 lane、**最新有效证据**、FAIL / NOT RUN / INVALID 分列」
 * 「登记建议 `m11-offline / m11-semantic / m11-live` 三个 lane」
 * ```
 *
 * ============================================================================
 *  四条纪律（都是本仓库踩出来的）
 * ============================================================================
 * ```text
 * ① **只读**：本门**不跑**任何别的门、不开库、不调模型；它只读已落盘的 manifest。
 * ② **最新 = 最新那一次，不管它是什么结论**（TD-04② 的教训逐字："不接受按最新 PASS 挑证据"）。
 *    证据目录名里带日期与 head ⇒ 按 (date, runId) 排序取**最后一个**。
 * ③ **四态分列**：`PASS` / `FAIL` / `NOT RUN`（没有证据）/ `INVALID`（manifest 缺字段或读不出）
 *    —— **不合成一个总分**（M6/M9 的既有纪律）。
 * ④ **live 门按设计不在离线 lane**：要真模型的门单列一条 lane；`NOT RUN` **不是** PASS。
 * ```
 *
 * 用法：`pnpm m11:gates [--lane=m11-offline|m11-semantic|m11-live|all] [--json]`
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'

const REPO_ROOT = resolve(process.cwd())
const ARTIFACTS = join(REPO_ROOT, 'artifacts', 'm11')
const headCounts = new Map<string, number>()
const artifactTimes = new Map<string, number>()
let commitTime = -1
for (const line of execFileSync('git', ['log', '--format=t:%ct', '--name-only', '--', 'artifacts/m11'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/)) {
  if (line.startsWith('t:')) commitTime = Number(line.slice(2)) * 1000
  else if (line !== '' && !artifactTimes.has(line)) artifactTimes.set(line, commitTime)
}

function hasCapturedBaseline(baseline: any, runId: string, head: string | undefined): boolean {
  return baseline.runId === runId && baseline.phase === 'after' && baseline.capture?.head === head &&
    typeof baseline.verdict === 'string' && baseline.verdict.startsWith('BASELINE CAPTURED') &&
    ['A11', 'A13', 'A14'].every(id => baseline.checks?.some((check: { id: string; pass: boolean }) => check.id === id && check.pass === true))
}

type Lane = 'm11-offline' | 'm11-semantic' | 'm11-live'

interface GateRef {
  /** manifest 里的 `wp` 字段（一个 wp 可能有多条读数，例如 long 的 200/500） */
  readonly wp: string
  readonly title: string
  readonly lane: Lane
  /** 需要的 manifest 字段（缺了 ⇒ INVALID） */
  readonly requires?: readonly string[]
}

/**
 * 三个 lane 的**门清单**（与计划 §12.1 的命令表逐条对应）。
 *
 * ⚠️ 这里登记的是"**存在过证据**的门"，不是"跑得动的命令"——
 *    聚合门只读证据，因此它主张的是"这些读数在案"，**不是**"它们现在还能跑通"。
 */
const M11_GATES: readonly GateRef[] = [
  // ---- lane 1：离线（不需要真模型）----
  { wp: 'wp0', title: 'WP0 基线核查（B/P/C/D/A 五组）', lane: 'm11-offline' },
  { wp: 'wp2', title: '派生链与去重（lineage）', lane: 'm11-offline' },
  { wp: 'wp3', title: '输入装配与触发（inputs）', lane: 'm11-offline' },
  { wp: 'wp4', title: '候选/审查/放行口（policy）', lane: 'm11-offline' },
  { wp: 'wp5', title: '行为调整（adaptive）', lane: 'm11-offline' },
  { wp: 'wp6', title: '失效与同轮阻断（invalidation）', lane: 'm11-offline' },
  { wp: 'wp7', title: '任务/水位/晚写闸门（recovery）', lane: 'm11-offline' },
  { wp: 'wp8', title: '上下文注入与事实包（context）', lane: 'm11-offline' },
  { wp: 'wp9-measurement', title: '量具有效性 + 64 场景 + 语料（measurement）', lane: 'm11-offline' },
  { wp: 'wp9-e2e', title: '离线端到端链（e2e）', lane: 'm11-offline' },
  { wp: 'wp9-long-200', title: '离线 200 轮轨迹', lane: 'm11-offline' },
  { wp: 'wp9-long-500', title: '离线 500 轮轨迹', lane: 'm11-offline' },
  { wp: 'wp11-observability', title: '可观测性与隐私（observability）', lane: 'm11-offline' },
  // ---- lane 2：语义（需要真模型 + 冻结语料）----
  { wp: 'wp10-semantic', title: '盲测语义评测（160×3）', lane: 'm11-semantic' },
  // ---- lane 3：真实链（需要真模型）----
  { wp: 'wp10-smoke-live', title: '真实端点冒烟', lane: 'm11-live' },
  { wp: 'wp10-long-live', title: '200 轮真实链', lane: 'm11-live' },
  { wp: 'wp10-ablation', title: '三档行为消融', lane: 'm11-live' },
  { wp: 'wp10-review-materials', title: '盲审材料（32 张卡）', lane: 'm11-live' },
]

type Verdict = 'PASS' | 'FAIL' | 'NOT RUN' | 'INVALID'

interface GateReading {
  readonly wp: string
  readonly title: string
  readonly lane: Lane
  readonly verdict: Verdict
  readonly runId: string | null
  readonly head: string | null
  readonly date: string | null
  readonly counts: { total: number; passed: number; failed: number } | null
  readonly detail: string
}

interface ManifestShape {
  readonly runId?: string
  readonly wp?: string
  readonly head?: string
  readonly date?: string
  readonly counts?: { total?: number; passed?: number; failed?: number }
  readonly verdict?: string
  readonly phases?: readonly string[]
  readonly ended?: string
  readonly started?: string
}

/**
 * 这份 manifest 是**判决**还是**基线捕获**？
 *
 * ⚠️ WP0 的基线门默认跑的是 **`before` 阶段**（断言"实现还不存在"），
 *    它的 verdict 是 `PENDING-AFTER-SAMPLE`、**按设计 exit 0**，而 `counts.failed` 记的是
 *    "开工前的断言现在不成立"（实测 4 条）—— 那不是里程碑失败，是**起点读数**。
 *    ⇒ 只把"跑到了判决"（phases 含 `after`）的读数当判决；纯 `before` 的记为**捕获**。
 *    （M9 的同类处理：`m9:wp0:admission` 用 `acceptExitCodes: [1]` + "当前态权威另有一门"。）
 */
function isVerdictReading(manifest: ManifestShape): boolean {
  const phases = manifest.phases ?? []
  if (phases.includes('after')) return true
  return !phases.includes('before')
}

/** 列出所有 runId 目录（只读） */
function listRunDirs(): string[] {
  if (!existsSync(ARTIFACTS)) return []
  return readdirSync(ARTIFACTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('m11-'))
    .map((entry) => entry.name)
}

/**
 * 取某个 wp 的**最新**一次读数。
 *
 * 排序先看候选 HEAD 的 Git 位置，再看自报时刻/提交时刻；不使用 checkout mtime。
 *    runId 里带的是**产生它的那次提交的 head 短哈希**，而"产生顺序"与"哈希字典序"无关。
 *    实测：盲测第一代（head `fe7266f1`，**FAIL 6/8**）与第二代（head `86f97d8b`，**PASS 8/8**）
 *    同日 ⇒ 按名字排把 `fe7…` 排到了最后 ⇒ 聚合门报的是**被修掉的那一代**。
 *    旧 manifest 没有起止时刻时，采用文件的 Git 提交时刻；最后才按 runId 兜底。
 * ⚠️ **不**按结论筛（TD-04②："不接受按最新 PASS 挑证据"）。
 */
function latestReading(gate: GateRef, runDirs: readonly string[]): GateReading {
  const candidates: { runId: string; manifest: ManifestShape; order: number; time: number }[] = []
  let capturesSeen = 0
  for (const runId of runDirs) {
    const path = join(ARTIFACTS, runId, 'manifest.json')
    if (!existsSync(path)) continue
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as ManifestShape
      if (manifest.wp !== gate.wp) continue
      if (!isVerdictReading(manifest)) {
        capturesSeen += 1
        continue
      }
      let order = -1, committedAt = -1
      if (/^[a-f0-9]{7,40}$/.test(manifest.head ?? '')) {
        if (!headCounts.has(manifest.head!)) headCounts.set(manifest.head!, Number(execFileSync('git', ['rev-list', '--count', manifest.head!], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()))
        order = headCounts.get(manifest.head!)!
        committedAt = artifactTimes.get(`artifacts/m11/${runId}/manifest.json`) ?? -1
      }
      const recordedAt = Date.parse(manifest.ended ?? manifest.started ?? '')
      candidates.push({ runId, manifest, order, time: Number.isFinite(recordedAt) ? recordedAt : committedAt })
    } catch {
      /* 读不出的 manifest ⇒ 下面按 INVALID 处理（这里先跳过，由缺候选体现） */
    }
  }
  if (candidates.length === 0) {
    return {
      wp: gate.wp,
      title: gate.title,
      lane: gate.lane,
      verdict: 'NOT RUN',
      runId: null,
      head: null,
      date: null,
      counts: null,
      detail:
        capturesSeen > 0
          ? `只有**基线捕获**（before 阶段）读数 ${String(capturesSeen)} 次，**没有判决读数** ⇒ NOT RUN`
          : '没有找到该门的 manifest（**NOT RUN ≠ PASS**）',
    }
  }
  candidates.sort((a, b) => a.order - b.order || a.time - b.time || a.runId.localeCompare(b.runId))
  const latest = candidates[candidates.length - 1]!
  const counts = latest.manifest.counts
  const invalid =
    latest.manifest.runId === undefined ||
    latest.manifest.head === undefined ||
    counts === undefined ||
    counts.total === undefined ||
    counts.passed === undefined ||
    counts.failed === undefined
  let baselineAccepted = false
  if (!invalid && gate.wp === 'wp0') {
    const baselinePath = join(ARTIFACTS, latest.runId, 'wp0-after.json')
    if (existsSync(baselinePath)) {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
      baselineAccepted = hasCapturedBaseline(baseline, latest.runId, latest.manifest.head)
    }
  }
  const verdict: Verdict = invalid
    ? 'INVALID'
    : baselineAccepted ? 'PASS'
    : (counts!.failed ?? 0) > 0
      ? 'FAIL'
      : 'PASS'
  return {
    wp: gate.wp,
    title: gate.title,
    lane: gate.lane,
    verdict,
    runId: latest.runId,
    head: latest.manifest.head ?? null,
    date: latest.manifest.date ?? null,
    counts: invalid
      ? null
      : { total: counts!.total!, passed: counts!.passed!, failed: counts!.failed! },
    detail: invalid
      ? `manifest 缺字段（runId/head/counts 之一）：${latest.runId}`
      : `${baselineAccepted ? 'BASELINE CAPTURED（开工前缺实现断言保留） · ' : ''}${String(counts!.passed)}/${String(counts!.total)} · head=${String(latest.manifest.head).slice(0, 8)} · 在案 ${String(candidates.length)} 次`,
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const laneArg = (args.find((item) => item.startsWith('--lane=')) ?? '--lane=all').slice(7)
  const asJson = args.includes('--json')
  const lanes: Lane[] = ['m11-offline', 'm11-semantic', 'm11-live']
  const selected = laneArg === 'all' ? lanes : lanes.filter((lane) => lane === laneArg)
  if (selected.length === 0) throw new Error(`未知 lane：${laneArg}`)

  const runDirs = listRunDirs()
  const readings = M11_GATES.filter((gate) => selected.includes(gate.lane)).map((gate) =>
    latestReading(gate, runDirs)
  )
  const selfChecks: { id: string; pass: boolean }[] = []
  const baselineReading = readings.find(row => row.wp === 'wp0')
  if (baselineReading?.runId) {
    const file = join(ARTIFACTS, baselineReading.runId, 'wp0-after.json')
    if (existsSync(file)) {
      const baseline = JSON.parse(readFileSync(file, 'utf8'))
      selfChecks.push({ id: 'baseline-positive', pass: hasCapturedBaseline(baseline, baselineReading.runId, baselineReading.head ?? undefined) })
      selfChecks.push({ id: 'baseline-database-change-rejected', pass: !hasCapturedBaseline({ ...baseline,
        checks: baseline.checks.map((row: any) => row.id === 'A11' ? { ...row, pass: false } : row) }, baselineReading.runId, baselineReading.head ?? undefined) })
      selfChecks.push({ id: 'baseline-recovery', pass: hasCapturedBaseline(baseline, baselineReading.runId, baselineReading.head ?? undefined) })
    }
  }

  const tally = (lane: Lane): Record<Verdict, number> => {
    const rows = readings.filter((reading) => reading.lane === lane)
    return {
      PASS: rows.filter((row) => row.verdict === 'PASS').length,
      FAIL: rows.filter((row) => row.verdict === 'FAIL').length,
      'NOT RUN': rows.filter((row) => row.verdict === 'NOT RUN').length,
      INVALID: rows.filter((row) => row.verdict === 'INVALID').length,
    }
  }
  const perLane = Object.fromEntries(selected.map((lane) => [lane, tally(lane)])) as Record<
    Lane,
    Record<Verdict, number>
  >
  const totals = {
    PASS: readings.filter((row) => row.verdict === 'PASS').length,
    FAIL: readings.filter((row) => row.verdict === 'FAIL').length,
    'NOT RUN': readings.filter((row) => row.verdict === 'NOT RUN').length,
    INVALID: readings.filter((row) => row.verdict === 'INVALID').length,
  }

  if (asJson) {
    console.log(JSON.stringify({ lanes: selected, perLane, totals, readings }, null, 2))
  } else {
    console.log(`[m11:gates] lane=${laneArg} · 只读聚合（**不跑任何门**、不开库、不调模型）`)
    for (const lane of selected) {
      console.log(`\n== ${lane} ==`)
      for (const reading of readings.filter((row) => row.lane === lane)) {
        const mark =
          reading.verdict === 'PASS'
            ? '✅'
            : reading.verdict === 'FAIL'
              ? '❌'
              : reading.verdict === 'NOT RUN'
                ? '⚠️ '
                : '🛑'
        console.log(`  ${mark} ${reading.wp.padEnd(20)} ${reading.verdict.padEnd(8)} ${reading.detail}`)
      }
    }
    console.log(
      `\n合计：PASS ${String(totals.PASS)} · FAIL ${String(totals.FAIL)} · ` +
        `NOT RUN ${String(totals['NOT RUN'])} · INVALID ${String(totals.INVALID)}` +
        `（**不合成总分**；NOT RUN ≠ PASS）`
    )
    for (const lane of selected) {
      const row = perLane[lane]
      console.log(
        `  ${lane}: PASS ${String(row.PASS)} · FAIL ${String(row.FAIL)} · NOT RUN ${String(row['NOT RUN'])} · INVALID ${String(row.INVALID)}`
      )
    }
  }

  // 落一份聚合证据（只读结论 + 清单快照）
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: `wp11-gates-${laneArg.replace(/^m11-/, '')}`, headShort: head })
  const dir = openM11RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm11-gates@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    lane: laneArg,
    readOnly: true,
    perLane,
    totals,
    readings,
    selfChecks,
    note: '只读聚合：读已落盘 manifest；最新一次读数**不按结论筛**（TD-04②）；NOT RUN ≠ PASS。',
  }
  writeFileSync(join(dir, 'gates.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: `wp11-gates-${laneArg.replace(/^m11-/, '')}`,
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'gates-aggregate',
    // ⚠️ 聚合门自己的 counts 记的是**被聚合的读数**，不是"本门通过了多少断言"
    counts: { total: readings.length, passed: totals.PASS, failed: totals.FAIL },
    phases: selected,
    supersedes: null,
    notes: `m11:gates（lane=${laneArg}；NOT RUN ${String(totals['NOT RUN'])} · INVALID ${String(totals.INVALID)}）`,
    sourceFingerprints: Object.fromEntries(['scripts/m11-gates.ts', 'scripts/m11-evidence.ts'].map(file => [file, createHash('sha256').update(readFileSync(join(REPO_ROOT, file))).digest('hex')])),
  })
  console.log(`\nrunId: ${runId}`)

  /*
   * ⚠️ 退出码：**FAIL 与 INVALID 都非零**（真信息）；`NOT RUN` **不**导致非零
   *    —— 因为"离线 lane 里 live 门没跑"是**设计**，不是失败（四态分列的意义就在这里）。
   */
  const bad = totals.FAIL + totals.INVALID
  process.exit(bad === 0 && selfChecks.every(row => row.pass) ? 0 : 1)
}

main()
