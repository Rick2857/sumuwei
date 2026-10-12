/**
 * Lv2 —— **继承模块门**的只读读数（`pnpm lv2:inherited:gates`；计划 `LV2-G6`）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * 计划 `LV2-G6` 要求"**当前启用模块**的冻结语义/来源/行为/控制门逐项有效"。
 * 那些模块各有自己的**只读聚合门**（`m4:gates` … `m11.1:gates`）—— 本脚本把它们
 * **逐个跑一遍**（都是只读已落盘证据），把各自的 `overall` 与退出码记进一份 Lv2 证据。
 *
 * ⚠️ 纪律：
 *   ① **只跑聚合门**（read-only），不跑任何会产生新证据的子门、不调模型
 *   ② **逐项如实**：某项 FAIL 就记 FAIL（例如 `m10.1` 在别人的树上有一条 `long:live` 红档）
 *   ③ 不把历史里程碑的 PASS 当成本轮读数：记的是**此刻**的聚合结果 + 各自引用的 runId
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'

/**
 * 计划 §5.1 的**继承清单**里、每个模块的只读聚合门（顺序 = 里程碑顺序）。
 *
 * `criteria` = 本次 Lv2 验收对该模块的**必选判据**（要它证明什么）；
 * `residual` = **人工登记的残余**（来自各自里程碑的报告/裁定）—— 与聚合门的**当前读数**分列，
 *              两者都不许互相顶替（`LV2-D14` 的口径）。
 */
const INHERITED_GATES: readonly {
  milestone: string
  script: string
  args?: readonly string[]
  criteria: string
  residual: string
}[] = [
  { milestone: 'M4', script: 'lv2:regression:read', args: ['--scope', 'm4'], criteria: '完整回归中的 m4:ci：记忆语义、来源、放行口及故障矩阵', residual: '历史里程碑保留；当前回归必须源码适用、真实退出成功，缺档继续阻断' },
  { milestone: 'M4.5', script: 'lv2:regression:read', args: ['--scope', 'm4.5'], criteria: '完整离线与生产副本真实回归；行动协议与回复事实边界', residual: '原 G14 的 26/18 FAIL 保留；当前候选以独立归档的完整回归承接' },
  { milestone: 'M5', script: 'm5:gates', criteria: '召回/资格/排序/选择与上下文预算', residual: '—' },
  { milestone: 'M5.1', script: 'lv2:regression:read', args: ['--scope', 'm5.1'], criteria: '归因模型与开发者面权威边界（M5.1 冻结 16 行权威地图）', residual: '原 M5.1 聚合实现与验收文件冻结；原生读取器在本候选继承证据副本中运行，旧 G14 FAIL 保留' },
  { milestone: 'M5.5', script: 'm5.5:gates', criteria: '外部证据的来源边界（证据不进长期记忆、正文不进 trace）', residual: '真实 provider 超时是常态（`L-M55-12`）' },
  { milestone: 'M5.5.1', script: 'm5.5.1:gates', criteria: '按需联网与搜索误触发的修复（含语义门）', residual: '正式三轮与 smallSample 诊断分列；诊断 FAIL 保留，当前正式 FAIL 仍阻断' },
  { milestone: 'M6', script: 'm6:gates', criteria: 'Rollup 摘要的来源边界', residual: '—' },
  { milestone: 'M6.1', script: 'm6.1:gates', args: ['--manifest', 'artifacts/m6.1/m6.1-wp0-20260927-9864a0e6206f-cc35/manifest.json', '--manifest', 'artifacts/m6.1/m6.1-wp1-20260927-9864a0e6206f-330d/manifest.json'], criteria: '假记忆边界（可查/可审计/可测）', residual: '按 R-17 提交的显式清单与逐条摘要读取；原缺参数拒收保留' },
  { milestone: 'M7', script: 'm7:gates', criteria: '关系状态与行为（含 TD-06 的短/长形读数）', residual: '`L-M7-01…08` 设计边界' },
  { milestone: 'M8', script: 'm8:gates', criteria: 'Affect 情绪状态演化', residual: '`L-M8-01…15`；M7 评估器双缺陷潜伏（`L-M8-13`）' },
  { milestone: 'M8.5', script: 'm8.5:gates', criteria: '语义情绪理解（含盲测终读数与已裁定残差）', residual: '`L-M85-11` 已裁定残差（不重跑凑数）' },
  { milestone: 'M9', script: 'm9:gates', criteria: '信念/视角/认知修订；遗忘与重述的正确性', residual: 'F-1/F-4 已由 M9.1 修复并按 R-20/R-21 销账（M9.1-Gate-Decision）；M9 的历史失败保留，当前聚合未通过的具体项仍分别阻断，不把历史缺陷误报为未修' },
  { milestone: 'M10', script: 'm10:gates', criteria: '目标与承诺（含 200 轮长链的终态档）', residual: '1 道 NOT RUN（不阻断）' },
  { milestone: 'M10.1', script: 'm10.1:gates', criteria: '约定识别/接受/结清/取消；旧终态不重开；A11 行为对照', residual: '历史 long:live 200 轮 10/11 保留；当前按新长链承接，不外推零承诺行的结清性质；L-M10.1-17 代价面' },
  { milestone: 'M11', script: 'm11:gates', criteria: '反思与自适应（增益另轴，不混入工程平均分）', residual: '历史 JSON/超时失败档保留；当前真模型冒烟按新候选独立读取' },
  { milestone: 'M11.1', script: 'm11.1:gates', criteria: '来源生命周期/语义/行为评分/混合长程/**联合装配**（G11）', residual: 'A12 联合生产队列与独立水位故障矩阵已补交；语义、完整行为评分和混合长程分别按当前有效证据阻断' },
]

interface GateReading {
  readonly milestone: string
  readonly script: string
  readonly args: readonly string[]
  /** 本次验收对该模块的**必选判据** */
  readonly criteria: string
  /** **人工登记的残余**（与机器读数分列） */
  readonly residual: string
  readonly exitCode: number
  readonly verdict: 'PASS' | 'NOT PASS'
  /** 输出里与判定有关的那几行（原样截取，便于人工复核） */
  readonly lines: readonly string[]
  /** 归一到 `Hard Gates = PASS` / `overall = NOT PASS` 那一行 */
  readonly overallLine: string
  /** 输出里出现的 runId（若有） */
  readonly runIds: readonly string[]
}

function runGate(script: string, args: readonly string[] = []): GateReading {
  let stdout = ''
  let exitCode = 0
  try {
    stdout = execFileSync('pnpm', [script, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true })
  } catch (error) {
    const withOutput = error as { status?: number; stdout?: string; stderr?: string }
    exitCode = withOutput.status ?? 1
    stdout = `${withOutput.stdout ?? ''}\n${withOutput.stderr ?? ''}`
  }
  const interesting = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /overall|Hard Gates|必选门|未通过|not-run|NOT RUN|INVALID/.test(line) && line.length < 400,
    )
  const overallLine = interesting.find((line) => /overall|Hard Gates/.test(line)) ?? interesting.at(-1) ?? ''
  const runIds = [...new Set([...stdout.matchAll(/([a-z0-9.\-]+-\d{8}-[0-9a-f]{8,}-[0-9a-f]{4})/gi)].map((m) => m[1]!))]
  return {
    milestone: '',
    criteria: '',
    residual: '',
    script,
    args,
    exitCode,
    verdict: exitCode === 0 ? 'PASS' : 'NOT PASS',
    lines: interesting.slice(0, 6),
    overallLine,
    runIds: runIds.slice(0, 8),
  }
}

function main(): void {
  const started = new Date().toISOString()
  const root = process.cwd()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const readings: GateReading[] = INHERITED_GATES.map((entry) => ({
    ...runGate(entry.script, entry.args),
    milestone: entry.milestone,
    criteria: entry.criteria,
    residual: entry.residual,
  }))

  /*
   * `LV2-D14`：**三列表**（必选判据 → 当前有效证据 → 残余）。
   * 生成给人读的 md，落进本 run 的证据目录 —— 与 `corpus-review.md` 同一个做法。
   */
  const table = [
    '# Lv2 · `LV2-G6` 继承模块门：必选判据 → 当前有效证据 → 残余',
    '',
    `> 生成时间：${new Date().toISOString()} · head \`${head.slice(0, 12)}\` · 由 \`pnpm lv2:inherited:gates\` 生成（只读）`,
    '> 口径（`LV2-D14`）：**历史失败保留**；后续修复证据经**适用性核验**后承接；',
    '> **当前**必选项的 FAIL/INVALID/NOT RUN **继续阻断**完整 PASS。三列各归各，不许互相顶替。',
    '',
    '| 模块 | 本次验收的必选判据 | 当前有效证据（聚合门读数 · runId 见证据目录） | 残余（人工登记，来自各自报告） |',
    '|---|---|---|---|',
    ...readings.map(
      (row) =>
        `| **${row.milestone}** | ${row.criteria} | ${row.verdict === 'PASS' ? '✅ PASS' : '❌ NOT PASS'} · exit=${String(row.exitCode)} · ${row.overallLine.replace(/\|/g, '/')} | ${row.residual} |`,
    ),
    '',
    `**合计**：${String(readings.filter((row) => row.verdict === 'PASS').length)}/${String(readings.length)} 当前 PASS ⇒ \`LV2-G6\` = ${readings.every((row) => row.verdict === 'PASS') ? 'PASS' : 'FAIL'}。`,
    '',
    '⚠️ 本表的第二列是**机器读数**（各聚合门此刻的判定），第三列是**人工登记的残余**；',
    '两者的来源不同，读的时候不要混。',
    '',
  ].join('\n')

  const passed = readings.filter((row) => row.verdict === 'PASS')
  const failed = readings.filter((row) => row.verdict !== 'PASS')
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL'
  const runId = createLv2RunId({ wpId: 'wp6-inherited-gates', headShort: head })
  const dir = openLv2RunDir(root, runId)
  writeFileSync(join(dir, 'readings.json'), `${JSON.stringify({ runId, readings }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'criteria-table.md'), `${table}\n`, 'utf8')
  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp6-inherited-gates',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version },
    testType: 'read-only-inherited-gate-rollup',
    counts: { total: readings.length, passed: passed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: { clean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '', note: '本脚本自己的 run 目录按白名单不计入' },
    sourceFingerprints: Object.fromEntries(
      (['scripts/lv2-inherited-gates.ts', 'scripts/lv2-evidence.ts'] as const).map((path) => [
        path,
        createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
      ]),
    ),
    config: { mode: '只读（逐个跑各模块的聚合门，不跑子门、不调模型）', list: INHERITED_GATES.map((row) => row.script) },
    model: { providerKind: 'none', note: '零模型请求' },
    requests: { planned: 0, actual: 0, note: '零模型请求' },
    denominators: {
      gatesRun: readings.length,
      passed: passed.length,
      failed: failed.length,
      failedNames: failed.map((row) => `${row.milestone}/${row.script}`),
    },
    correlations: { cases: 0, conversations: 0, requests: 0, traces: 0 },
    faultInjection: null,
    cleanClose: true,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: '只读；各聚合门自身也只读已落盘证据' },
    verdict,
    limitation:
      '本读数记录的是**此刻**各模块聚合门的结果（每项都带它自己引用的 runId）。' +
      '⚠️ 别的会话的树在动 ⇒ 某一项可能是**它们**的旧红档（例如 `m10.1:long:live` 的 head 不是本 HEAD）；' +
      '本脚本**不**替它们解释，只如实归口 + 记 head。',
  })

  console.log(`[lv2:inherited] runId = ${runId}（${String(readings.length)} 道聚合门 · 只读）`)
  for (const row of readings) {
    console.log(`  ${row.verdict === 'PASS' ? '✅' : '❌'} ${row.milestone.padEnd(7)} ${row.script.padEnd(16)} exit=${String(row.exitCode)} · ${row.overallLine.slice(0, 90)}`)
  }
  console.log(`[lv2:inherited] 通过 ${String(passed.length)}/${String(readings.length)} ⇒ ${verdict}`)
  console.log(`[lv2:inherited] 三列表（必选判据 → 当前有效证据 → 残余）= ${join(dir, 'criteria-table.md')}`)
  console.log(`[lv2:inherited] manifest = ${manifestPath.replace(`${root}\\`, '').replace(/\\/g, '/')}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main()
