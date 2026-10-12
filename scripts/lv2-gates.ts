/**
 * Lv2 —— **只读汇总门**（`pnpm lv2:gates`；计划 §`LV2-G10`）。
 *
 * ============================================================================
 *  它做什么 / 不做什么
 * ============================================================================
 * 做：读 `artifacts/lv2/**` 里**已经落盘**的证据，按计划 §`LV2-G0…G9` 的口径逐项给出
 *     `PASS / FAIL / INVALID / NOT RUN`，并算出一个 `overall`。
 * 不做：**它不跑任何门、不调模型、不打开数据库**。
 *
 * 三条纪律（`AGENTS.md` §6.4 / §6.7 / §6.8）：
 *   ① **缺文件 = NOT RUN，不是 PASS**（本脚本对"没找到证据"一律给 NOT RUN）
 *   ② 选档按**身份**（`ended` 降序、tie 按 runId），**不看目录 mtime**（`TD-23` 的教训）
 *   ③ 计数型判据必须自证 `measured_count > 0`；本脚本末尾带**三段式自检**
 *     （合法 ⇒ 安静；注入缺项 ⇒ 必须报 NOT PASS；放回真实证据 ⇒ 恢复）
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'
import { summarizeM111Evidence } from './m11.1-gates.ts'

const ROOT = process.cwd()
const LV2 = join(ROOT, 'artifacts', 'lv2')

interface RunSummary {
  readonly dir: string
  readonly wp: string
  readonly verdict: string
  readonly ended: string
  readonly runId: string
  readonly head: string
  readonly cleanClose: boolean
  readonly realDbOpened: boolean
  readonly counts: Record<string, number>
  readonly severeTags: Record<string, number>
  /** 原始 manifest（门按需读 config/denominators 的具名字段） */
  readonly run: Record<string, unknown>
  readonly denominators: Record<string, unknown>
}

type GateState = 'PASS' | 'FAIL' | 'INVALID' | 'NOT RUN' | 'NOT PASS'

interface GateRow {
  readonly gate: string
  readonly title: string
  readonly state: GateState
  readonly reason: string
  readonly evidence: readonly string[]
}

function readRuns(): RunSummary[] {
  if (!existsSync(LV2)) return []
  const runs: RunSummary[] = []
  for (const entry of readdirSync(LV2, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(LV2, entry.name, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    let aggregate: Record<string, unknown> = {}
    const aggregatePath = join(LV2, entry.name, 'aggregate.json')
    if (existsSync(aggregatePath)) {
      try {
        aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8')) as Record<string, unknown>
      } catch {
        aggregate = {}
      }
    }
    const severeTags: Record<string, number> = {}
    const incidents = (aggregate.severeIncidents ?? []) as readonly { tag?: unknown }[]
    for (const incident of incidents) {
      const tag = String(incident.tag ?? 'unknown')
      severeTags[tag] = (severeTags[tag] ?? 0) + 1
    }
    runs.push({
      dir: entry.name,
      wp: String(manifest.wp ?? ''),
      verdict: String(manifest.verdict ?? 'UNKNOWN'),
      ended: String(manifest.ended ?? ''),
      runId: String(manifest.runId ?? entry.name),
      head: String(manifest.head ?? ''),
      cleanClose: manifest.cleanClose === true,
      realDbOpened: (manifest.realDb as { opened?: unknown } | undefined)?.opened === true,
      counts: (manifest.counts ?? {}) as Record<string, number>,
      severeTags,
      run: manifest,
      denominators: (manifest.denominators ?? {}) as Record<string, unknown>,
    })
  }
  return runs
}

/** 选最新一代：`ended` 降序、tie 按 runId 降序（**不看 mtime**）。 */
function latest(runs: readonly RunSummary[], wpPrefix: string): RunSummary | undefined {
  return runs
    .filter((run) => run.wp.startsWith(wpPrefix))
    .sort((a, b) => (a.ended === b.ended ? (a.runId < b.runId ? 1 : -1) : a.ended < b.ended ? 1 : -1))[0]
}

const JOINT_COVERAGE = ['native-goal-model-and-program-interfaces', 'native-commitment-settlement',
  'budget-eight-combinations', 'a12-production-queue', 'independent-watermarks',
  'provider-failures', 'exclusive-open-recovery', 'close-fence'] as const

function hasJointCoverage(manifest: Record<string, any>): boolean {
  return Array.isArray(manifest.jointCoverage) && JOINT_COVERAGE.every(key => manifest.jointCoverage.includes(key)) &&
    manifest.counts?.total > 0 && ['src/main.ts', 'src/infrastructure/runtime/goal-reflection-queue.ts',
      'src/infrastructure/runtime/agreement-runtime.ts', 'src/infrastructure/runtime/reflection-runtime.ts']
      .every(file => typeof manifest.sourceFingerprints?.[file] === 'string')
}

function main(): void {
  const started = new Date().toISOString()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runs = readRuns()
  const rows: GateRow[] = []
  const push = (gate: string, title: string, state: GateState, reason: string, evidence: readonly string[]): void => {
    rows.push({ gate, title, state, reason, evidence })
  }

  /* ---------------------------------------------------------------- G0 基线 */
  const wp0 = latest(runs, 'wp0')
  push(
    'LV2-G0',
    '基线与配置',
    wp0 === undefined ? 'NOT RUN' : wp0.verdict === 'BASELINE CAPTURED' ? 'PASS' : 'FAIL',
    wp0 === undefined ? '未找到 `lv2:baseline` 的证据' : `wp0 verdict=${wp0.verdict}`,
    wp0 === undefined ? [] : [wp0.dir],
  )

  /* ------------------------------------------------------- G1 状态与权限 */
  const short = latest(runs, 'wp4-short')
  const core = latest(runs, 'wp2-core')
  const severeTotal = short === undefined ? null : Object.values(short.severeTags).reduce((a, b) => a + b, 0)
  if (short === undefined) {
    push('LV2-G1', '状态与权限', 'NOT RUN', '未找到短场景批次证据', core === undefined ? [] : [core.dir])
  } else {
    push(
      'LV2-G1',
      '状态与权限',
      severeTotal === 0 && core?.verdict === 'PASS' ? 'PASS' : 'FAIL',
      `严重错误 incident = ${String(severeTotal)}（${Object.entries(short.severeTags)
        .map(([tag, count]) => `${tag}×${String(count)}`)
        .join(' · ') || '无'}）· 核心路径门 verdict=${String(core?.verdict ?? 'NOT RUN')}`,
      [short.dir, ...(core === undefined ? [] : [core.dir])],
    )
  }

  /* ------------------------------------------------------------ G2 量具 */
  const measurement = latest(runs, 'wp3-measurement')
  const corpus = latest(runs, 'wp1-corpus')
  const diagnose = latest(runs, 'wp4-diagnose')
  const instrumentRows = [
    ['wp2-core', core],
    ['wp3-measurement', measurement],
    ['wp1-corpus', corpus],
    ['wp4-diagnose-memory', diagnose],
  ] as const
  const instrumentMissing = instrumentRows.filter(([, run]) => run === undefined).map(([name]) => name)
  const instrumentFailed = instrumentRows.filter(([, run]) => run !== undefined && run.verdict !== 'PASS')
  push(
    'LV2-G2',
    '量具（正控/缺陷负控/恢复 + measured_count>0）',
    instrumentMissing.length > 0 ? 'NOT RUN' : instrumentFailed.length > 0 ? 'FAIL' : 'PASS',
    instrumentMissing.length > 0
      ? `缺 ${instrumentMissing.join(' · ')}`
      : instrumentFailed.length > 0
        ? `未通过：${instrumentFailed.map(([name, run]) => `${name}=${String(run?.verdict)}`).join(' · ')}`
        : instrumentRows.map(([name, run]) => `${name}=PASS(${String(run?.counts.passed ?? '?')}/${String(run?.counts.total ?? '?')})`).join(' · '),
    instrumentRows.flatMap(([, run]) => (run === undefined ? [] : [run.dir])),
  )

  /* -------------------------------------------------- G3 综合短场景（§5.2） */
  if (short === undefined) {
    push('LV2-G3', '综合短场景（12 类 × 6 案 × 2 轮）', 'NOT RUN', '未找到短场景批次证据', [])
  } else {
    const judged = (short.denominators.judged as number | undefined) ?? short.counts.total ?? 0
    const passed = short.counts.passed ?? 0
    push(
      'LV2-G3',
      '综合短场景（12 类 × 6 案 × 2 轮）',
      short.verdict === 'PASS' ? 'PASS' : 'FAIL',
      `判据案 ${String(passed)}/${String(judged)} = ${judged === 0 ? 'n/a' : ((passed / judged) * 100).toFixed(1)}%（门槛：每轮 ≥90% · 每类每轮 ≥5/6 · 严重错误 = 0）· 本代 verdict=${short.verdict}`,
      [short.dir],
    )
  }

  /* ------------------------------------------------- G4 原生联合装配 */
  const joint = summarizeM111Evidence(ROOT).readings.joint
  const jointManifest = joint.runId === null ? {} : JSON.parse(readFileSync(join(ROOT, 'artifacts/m11.1', joint.runId, 'manifest.json'), 'utf8'))
  const jointComplete = hasJointCoverage(jointManifest)
  const jointState = joint.status === 'PARTIAL' ? 'FAIL' : joint.status === 'PASS' && !jointComplete ? 'INVALID' : joint.status
  push(
    'LV2-G4',
    '原生联合装配（Goal/Commitment/Reflection 各自任务与结清）',
    jointState,
    joint.runId === null ? '未找到 A12 联合装配证据' :
      `M11.1 G11=${joint.status} · 当前源码与自摘要核验 · ${String(jointManifest.counts?.passed ?? 0)}/${String(jointManifest.counts?.total ?? 0)} · 八项联合覆盖=${String(jointComplete)}` +
      (joint.problems.length ? ` · ${joint.problems.join('；')}` : ''),
    joint.runId === null ? [] : [`artifacts/m11.1/${joint.runId}`],
  )

  /* ------------------------------------------- G5 混合轨迹与恢复（50 轮） */
  /*
   * 计划 §`LV2-G5` 要**四件**：真实 50 轮混合轨迹 · 15 次回访 · 重启 · 逐字段 rebuild，
   * 外加"当前适用的离线 200/500 轨迹"的适用性。
   * ⇒ 逐件读数，缺一件就不给 PASS（二进制门里用 FAIL + 具名缺口表达 PARTIAL）。
   */
  const trajectoryRuns = runs.filter((run) => run.wp.startsWith('wp5-trajectory'))
  /*
   * ⚠️ **只认"整条轨迹"那一次**：`lv2:restart:preflight` 会为**每一段**也写一份 `wp5-trajectory`
   *    （`config.segmentTag = seg1/seg2`、`config.from > 1`、且**不带** rebuild 检查）——
   *    它们是最新的，若被选中，G5 会把"回访/rebuild 缺失"误报成轨迹的缺口（实测踩到）。
   */
  const isWholeTrajectory = (run: { run: Record<string, unknown> }): boolean => {
    const config = (run.run as { config?: { segmentTag?: unknown; from?: unknown } }).config ?? {}
    return String(config.segmentTag ?? 'whole') === 'whole' && Number(config.from ?? 1) <= 1
  }
  const liveTrajectory = trajectoryRuns
    .filter((run) => String((run.run as { config?: { mode?: unknown } }).config?.mode ?? '').includes('live'))
    .filter((run) => isWholeTrajectory(run))
    .sort((a, b) => (a.ended === b.ended ? (a.runId < b.runId ? 1 : -1) : a.ended < b.ended ? 1 : -1))[0]
  const restartRun = latest(runs, 'wp5-restart')
  const g5Pieces: string[] = []
  const g5Missing: string[] = []
  if (liveTrajectory === undefined) {
    g5Missing.push('真实档 50 轮混合轨迹')
  } else {
    const rounds = Number(liveTrajectory.denominators.rounds ?? 0)
    const revisits = Number(liveTrajectory.denominators.revisits ?? 0)
    const revisitPassed = Number(liveTrajectory.denominators.revisitPassed ?? 0)
    g5Pieces.push(`真实档 ${String(rounds)} 轮（${liveTrajectory.dir}）`)
    if (rounds < 50 || liveTrajectory.verdict !== 'PASS' || !liveTrajectory.cleanClose ||
      Number((liveTrajectory.run.requests as { actual?: unknown } | undefined)?.actual ?? 0) <= 0) g5Missing.push('有效完成、收尾并具实际调用计数的 50 轮真实档')
    if (revisits >= 15 && revisitPassed === revisits) g5Pieces.push(`回访 ${String(revisitPassed)}/${String(revisits)}`)
    else g5Missing.push(`15 次回访（读到 ${String(revisitPassed)}/${String(revisits)}）`)
    const rebuild = String(liveTrajectory.denominators.fieldLevelRebuild ?? 'NOT IMPLEMENTED')
    if (rebuild.startsWith('CHECKED_OK')) g5Pieces.push(`逐字段 rebuild = ${rebuild}`)
    else g5Missing.push(`逐字段 rebuild（读到 ${rebuild}）`)
  }
  if (restartRun === undefined) g5Missing.push('重启')
  else {
    const mode = String((restartRun.run as { config?: { mode?: unknown } }).config?.mode ?? '')
    g5Pieces.push(`重启（${restartRun.verdict} · ${restartRun.dir}）`)
    if (restartRun.verdict !== 'PASS' || !restartRun.cleanClose ||
      Number((restartRun.run.requests as { actual?: unknown } | undefined)?.actual ?? 0) <= 0) g5Missing.push('完成、收尾并有实际调用计数的真实重启')
    if (mode.includes('控制档')) g5Missing.push('**真实档**重启（现有重启读数只在控制档）')
  }
  /*
   * 离线 200/500 轨迹：**按继承口径承接**（读它们的当前读数 + 各自的适用性规则）。
   * 出身读数（2026-10-02，只读）：
   *   · `m10.1:long:verify (200)` = 10/10 PASS（head 2ff58c8f）
   *   · `m10.1:long:verify (500)` = 10/10 PASS（head 2ff58c8f）
   *   · `m10.1:long:live (200·真模型)` = 10/11 FAIL（head cf6d314c，**别家**已落盘档）
   *   · 500 轮**真模型**档：用户已裁定不跑（"200 轮够了"）
   * ⚠️ 它们的适用性由**各自里程碑的指纹规则**决定（M11.1 的 `limitation` 逐字：
   *    "Source fingerprints determine current applicability. Recorded FAIL remains visible
   *     even when the candidate changed."）⇒ 本门**按继承承接，不据为己有**。
   */
  g5Pieces.push(
    '离线 200/500 轨迹（继承）：M10.1 `long:verify(200)`/`(500)` 各 **10/10**（head 2ff58c8f，依指纹适用性规则承接）· ' +
      '`long:live(200)` 10/11（别家 head cf6d314c）· 500 真模型档已裁定不跑',
  )
  push(
    'LV2-G5',
    '混合轨迹与恢复（50 轮 + 15 次回访 + 重启 + rebuild）',
    g5Missing.length === 0 ? 'PASS' : liveTrajectory === undefined ? 'NOT RUN' : 'FAIL',
    g5Missing.length === 0
      ? g5Pieces.join(' · ')
      : `已取得：${g5Pieces.join(' · ') || '（无）'}；**缺**：${g5Missing.join(' · ')}`,
    [...(liveTrajectory === undefined ? [] : [liveTrajectory.dir]), ...(restartRun === undefined ? [] : [restartRun.dir])],
  )

  /* ------------------------------------------------- G6 继承模块门 */
  const inherited = latest(runs, 'wp6-inherited')
  if (inherited === undefined) {
    push('LV2-G6', '继承模块门（当前启用模块的冻结语义/来源/行为）', 'NOT RUN', '未找到 `lv2:inherited:gates` 的读数（逐条读 m4…m11.1 的聚合门）', [])
  } else {
    const gateCount = (inherited.denominators.gatesRun as number | undefined) ?? inherited.counts.total ?? 0
    const failedNames = (inherited.denominators.failedNames as string[] | undefined) ?? []
    push(
      'LV2-G6',
      '继承模块门（当前启用模块的冻结语义/来源/行为）',
      inherited.verdict === 'PASS' ? 'PASS' : 'FAIL',
      `${String(inherited.counts.passed ?? 0)}/${String(gateCount)} 道聚合门当前 PASS` +
        (failedNames.length === 0 ? '' : `；未 PASS：${failedNames.join(' · ')}`),
      [inherited.dir],
    )
  }

  /* ------------------------------------------- G7 隐私、预算与回归 */
  const realDbTouched = runs.filter((run) => run.realDbOpened).map((run) => run.dir)
  const privacy = latest(runs, 'wp6-privacy-budget')
  const regression = latest(runs, 'wp6-regression')
  const privacyOk = privacy !== undefined && privacy.verdict === 'PASS'
  const regressionOk = regression !== undefined && regression.verdict === 'PASS'
  push(
    'LV2-G7',
    '隐私、预算与回归',
    privacy === undefined || regression === undefined ? 'NOT RUN' : privacyOk && regressionOk ? 'PASS' : 'FAIL',
    `**隐私/预算半 = ${privacy === undefined ? 'NOT RUN' : privacy.verdict}**` +
      (privacy === undefined
        ? ''
        : `（${String(privacy.denominators.windowsChecked ?? 0)} 个正文窗口 × ${String(privacy.denominators.machineFiles ?? 0)} 份机器证据）`) +
      ` · **回归半 = ${regression === undefined ? 'NOT RUN' : regression.verdict}**` +
      (regression === undefined
        ? ''
        : `（未通过的 Hard Gate：${String(regression.denominators.failingGates ?? 0)} 道 —— 见 ${regression.dir}；` +
          '⚠️ 若是别家**旧档**，本门只归口不解释）') +
      ` · 真实库隔离：${String(runs.length)} 份 run 全部 \`realDb.opened=false\`${realDbTouched.length === 0 ? '（✓）' : `（✗ ${realDbTouched.join(' · ')}）`}`,
    [...(privacy === undefined ? [] : [privacy.dir]), ...(regression === undefined ? [] : [regression.dir])],
  )

  /* ------------------------------------------------- G8 真人复核 */
  /*
   * `LV2-G8` 要的是"**当前材料经真人明确裁定**"。机器**不能**替人裁定，
   * 但可以读**声明的裁定**（`artifacts/lv2/human-ruling.json`，逐字记录用户原话）。
   * ⚠️ 纪律：本门只认**有原话的声明**；没有它一律 NOT RUN（不得由"材料已备"自动变绿）。
   */
  const rulingPath = join(LV2, 'human-ruling.json')
  let g8State: 'PASS' | 'NOT RUN' = 'NOT RUN'
  let g8Reason = '本轮材料尚未呈交真人复核（计划 §5.4；历史人审不代替本轮材料）'
  const materials = latest(runs, 'wp7-review-materials')
  if (existsSync(rulingPath)) {
    try {
      const ruling = JSON.parse(readFileSync(rulingPath, 'utf8')) as {
        item?: unknown
        date?: unknown
        verbatim?: unknown
        scope?: unknown
        limitation?: unknown
      }
      if (String(ruling.item ?? '') === 'LV2-G8' && String(ruling.verbatim ?? '') !== '') {
        g8State = 'PASS'
        g8Reason =
          `**声明式批准**（${String(ruling.date)} · 用户原话「${String(ruling.verbatim)}」）· ` +
          `范围：${String(ruling.scope)} · 限定：${String(ruling.limitation)} · ` +
          `材料：${materials?.dir ?? '（缺）'}`
      }
    } catch {
      g8State = 'NOT RUN'
      g8Reason = '找到了 `artifacts/lv2/human-ruling.json` 但解析失败（不猜其内容）'
    }
  }
  push('LV2-G8', '真人复核（身份/自然性/澄清/归属/结清/长程连续性）', g8State, g8Reason, materials === undefined ? [] : [materials.dir])

  /* ------------------------------------------------- G9 后续交接 */
  /*
   * `LV2-G9` 后续交接：**可复现**不是一句声明 —— 这里做两件机器能判的事：
   *   ① 四份交付文档**真的存在**（缺哪份就报哪份）
   *   ② `Lv2-Architecture.md` §6 的复现序列里出现的 `lv2:*` 命令，**每一条都真的在 `package.json` 里**
   *      （文档写了但脚本不存在 = 交接不可复现；这是最常见的"看起来齐全"）
   * ⚠️ 它**不**判"内容写得好不好"——那属人审（G8）。
   */
  const handoffDocs = [
    'docs/lv2/Lv2-Architecture.md',
    'docs/lv2/Lv2-Known-Limitations.md',
    'docs/lv2/Lv2-Acceptance-Report.md',
    'docs/lv2/Lv2-Gate-Decision.md',
  ] as const
  const missingDocs = handoffDocs.filter((path) => !existsSync(join(ROOT, path)))
  const architectureText = existsSync(join(ROOT, 'docs/lv2/Lv2-Architecture.md'))
    ? readFileSync(join(ROOT, 'docs/lv2/Lv2-Architecture.md'), 'utf8')
    : ''
  const documented = [...new Set([...architectureText.matchAll(/pnpm (lv2:[a-z0-9:]+)/g)].map((match) => match[1]!))]
  const packageScripts = Object.keys(
    (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {},
  )
  const missingScripts = documented.filter((name) => !packageScripts.includes(name))
  const missingItemsListed = /尚不存在|尚不存在的功能|缺项/.test(architectureText) ||
    /尚不存在|缺项/.test(existsSync(join(ROOT, 'docs/lv2/Lv2-Acceptance-Report.md'))
      ? readFileSync(join(ROOT, 'docs/lv2/Lv2-Acceptance-Report.md'), 'utf8')
      : '')
  const g9Problems: string[] = []
  if (missingDocs.length > 0) g9Problems.push(`缺文档：${missingDocs.join(' · ')}`)
  if (missingScripts.length > 0) g9Problems.push(`文档写了但脚本不存在：${missingScripts.join(' · ')}`)
  if (documented.length === 0) g9Problems.push('复现序列里读不到任何 `pnpm lv2:*` 命令（measured_count = 0 ⇒ 本门无效）')
  if (!missingItemsListed) g9Problems.push('"尚不存在项"清单未在文档里显式列出')
  push(
    'LV2-G9',
    '后续交接（相同内核入口/输入输出/状态读面/启动关闭恢复）',
    g9Problems.length === 0 ? 'PASS' : 'FAIL',
    g9Problems.length === 0
      ? `四份交付文档齐 · 复现序列 ${String(documented.length)} 条命令全部存在 · "尚不存在项"已显式列出`
      : g9Problems.join(' · '),
    [],
  )

  /* ------------------------------------------------- G10 只读汇总 */
  const blocking = rows.filter((row) => row.state !== 'PASS')
  const overall = blocking.length === 0 ? 'PASS' : 'NOT PASS'
  push(
    'LV2-G10',
    '只读汇总',
    overall === 'PASS' ? 'PASS' : 'NOT PASS',
    blocking.length === 0
      ? 'G0–G9 全部有效 PASS'
      : `${String(blocking.length)} 项未 PASS：${blocking.map((row) => `${row.gate}=${row.state}`).join(' · ')}`,
    [],
  )

  /* ------------------------------------------------------------- 三段式自检 */
  const selfChecks: { id: string; pass: boolean; note: string }[] = []
  const stateOf = (list: readonly GateRow[]): GateState =>
    list.every((row) => row.state === 'PASS' || row.gate === 'LV2-G10') ? 'PASS' : 'NOT PASS'
  selfChecks.push({
    id: 'SELF-1-合法证据安静',
    pass: stateOf(rows) === (overall as GateState),
    note: `真实证据下的 overall = ${String(overall)}（本函数与逐行判定同源）`,
  })
  const injectedMissing: GateRow[] = [...rows.filter((row) => row.gate !== 'LV2-G10'), { gate: 'LV2-G5', title: 'injected', state: 'NOT RUN', reason: '注入：缺文件', evidence: [] }]
  selfChecks.push({
    id: 'SELF-2-注入缺项必须报 NOT PASS',
    pass: stateOf(injectedMissing) === 'NOT PASS',
    note: `注入一个 NOT RUN 后 overall = ${String(stateOf(injectedMissing))}（"缺文件 = PASS"是这里最坏的失败模式）`,
  })
  const injectedFail: GateRow[] = rows.map((row) => (row.gate === 'LV2-G3' ? { ...row, state: 'FAIL' as GateState } : row))
  selfChecks.push({
    id: 'SELF-3-注入 FAIL 必须报 NOT PASS',
    pass: stateOf(injectedFail) === 'NOT PASS',
    note: `把 G3 注入成 FAIL 后 overall = ${String(stateOf(injectedFail))}`,
  })
  const measuredCount = runs.length
  if (joint.status === 'PASS') {
    selfChecks.push({ id: 'SELF-4-A12覆盖负控与恢复',
      pass: jointComplete && !hasJointCoverage({ ...jointManifest, jointCoverage: JOINT_COVERAGE.filter(key => key !== 'independent-watermarks') }) && hasJointCoverage(jointManifest),
      note: '移除独立水位覆盖必须拒收；原联合证据恢复后接受' })
  }

  const runId = createLv2RunId({ wpId: 'wp7-gates', headShort: head })
  const dir = openLv2RunDir(ROOT, runId)
  writeFileSync(join(dir, 'readings.json'), `${JSON.stringify({ runId, rows, selfChecks, runsSeen: runs.length }, null, 2)}\n`, 'utf8')
  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp7-gates',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version },
    testType: 'read-only-gate-rollup',
    counts: { total: rows.length - 1, passed: rows.filter((row) => row.gate !== 'LV2-G10' && row.state === 'PASS').length, failed: blocking.filter((row) => row.gate !== 'LV2-G10').length },
    phases: ['single'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: { clean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '', note: '本脚本自己的 run 目录按白名单不计入' },
    sourceFingerprints: Object.fromEntries(
      (['scripts/lv2-gates.ts', 'scripts/lv2-evidence.ts', 'scripts/lv2-gate-select.ts', 'scripts/m11.1-gates.ts'] as const).map((path) => [
        path,
        createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex'),
      ]),
    ),
    config: { mode: '只读（不跑门、不调模型、不开库）', selection: 'ended 降序 · tie 按 runId（**不看 mtime**，TD-23）' },
    model: { providerKind: 'none', note: '零模型请求' },
    requests: { planned: 0, actual: 0, note: '零模型请求' },
    denominators: { runsSeen: runs.length, rowsJudged: rows.length - 1, measuredCount },
    correlations: { cases: 0, conversations: 0, requests: 0, traces: 0 },
    faultInjection: null,
    cleanClose: true,
    realDb: {
      opened: false,
      summaryBefore: null,
      summaryAfter: null,
      note: `只读；本次扫到的 ${String(runs.length)} 份 run 全部 \`realDb.opened=false\``,
    },
    verdict: overall === 'PASS' ? 'PASS' : 'FAIL',
    limitation:
      '本门**只读已落盘证据**：缺文件 = NOT RUN（不是 PASS）。它**不**替代任何子门，' +
      '也**不**对"未跑"的项做任何推断；G4/G6/G7/G8/G9 的 NOT RUN 是**当前真实状态**。',
  })

  console.log(`[lv2:gates] runId = ${runId}（只读 · 扫到 ${String(runs.length)} 份 run）`)
  for (const row of rows) {
    const badge = row.state === 'PASS' ? '✅' : row.state === 'FAIL' ? '❌' : row.state === 'NOT RUN' ? '⬜' : '⚠️'
    console.log(`  ${badge} ${row.gate.padEnd(8)} ${row.title}`)
    console.log(`        ${row.state} · ${row.reason}`)
  }
  console.log(`[lv2:gates] 三段式自检 ${selfChecks.filter((check) => check.pass).length}/${selfChecks.length}`)
  for (const check of selfChecks) console.log(`   ${check.pass ? '✅' : '❌'} ${check.id} —— ${check.note}`)
  console.log(`[lv2:gates] overall = ${overall} · measured_count(run 数) = ${String(measuredCount)} · manifest = ${manifestPath.replace(`${ROOT}\\`, '').replace(/\\/g, '/')}`)
  process.exitCode = overall === 'PASS' && selfChecks.every((check) => check.pass) ? 0 : 1
}

main()
