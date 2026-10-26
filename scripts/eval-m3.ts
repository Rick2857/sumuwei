/**
 * M3 评测 —— **离线档**（默认）。
 *
 * ============================================================================
 *  这个脚本是 PR Smoke 的那一档（计划书第 144/145 节）
 * ============================================================================
 * 计划书第 144 节把 CI 分成两段：
 *
 *     … → M2.5 regression → **M3 deterministic scenarios** → Promptfoo smoke
 *   长对话 Persona Eval：nightly / manual / release gate
 *
 * 它就是中间那一段：**不需要 API Key、秒级完成、每次 commit 都跑**。
 *
 * ---------------------------------------------------------------------------
 *  离线档到底跑了什么（这一点必须说清楚）
 * ---------------------------------------------------------------------------
 *   跑：`requiresModel === false` 的用例，以及**所有**用例里
 *       `kind: 'deterministic'` 的检查 —— 无论那条用例要不要模型。
 *   不跑：`kind: 'judge'` 的检查，它们在报告里是 `skipped`。
 *
 * 那句"以及所有用例里确定性的检查"是关键：T4/T5（她的话不产生事实）、
 * T7/T8（来源隔离）、T1/T2（身份与会话连续）这些**硬保证**全部在这一档里
 * 真的被验证。若离线档什么都不判，那"能程序判断的不用 LLM Judge"
 * （第 52 节）就只是一句口号。
 *
 * ---------------------------------------------------------------------------
 *  硬零指标不为 0 → 退出码 1
 * ---------------------------------------------------------------------------
 * 计划书第 115–118 节把四条指标写成"目标 0"。它们不是目标，是闸：
 * 任何一次不为零都意味着**账本里留下了错误的事实**（append-only，改不了）。
 * 因此这里不把它们并入"通过率"，而是单独打 `CRITICAL` 并以 1 退出 ——
 * 那样 CI 会红，而红的原因一眼可见。
 *
 * 跑法：
 *   tsx scripts/eval-m3.ts                          全部离线用例
 *   tsx scripts/eval-m3.ts --suite identity-core     只跑一个套件
 *   tsx scripts/eval-m3.ts --filter M3-SRC           子串过滤（用例 id / 套件 id / 标签）
 *   tsx scripts/eval-m3.ts --json data/m3-report.json  写出机器可读报告
 *   M3_DRIFT_TURNS=100 tsx scripts/eval-m3.ts        长跑档（50 与 100 两档都会跑）
 *
 * ⚠️ 全部在**一次性副本库**上跑：`isolateDatabase()` 在下面第一行 import 之前
 *    就被调用（见 `src/dev/sandbox.ts` 的说明）。真实对话库碰不到。
 */

import { isolateDatabase } from '../src/dev/sandbox.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { M3_SUITES, findM3Suite, m3Cases, m3CheckCount, m3SuiteIds } from '../evals/m3/index.ts'
import { runM3 } from '../evals/m3/runtime/engine.ts'
import {
  METRIC_DENOMINATORS,
  METRIC_DIRECTIONS,
} from '../evals/m3/runtime/metrics.ts'
import { M3_HARD_ZERO_METRICS, type EvalReport, type M3Metric } from '../evals/m3/types.ts'
import { describeThresholds, thresholdsWithBaseline } from '../evals/m3/thresholds.ts'
import { expect, printSummary, type RunSummary } from './kernel-test-kit.ts'

// ---------------------------------------------------------------------------
// 场景清单（2026-10-21 · 逐场景子进程门）
// ---------------------------------------------------------------------------
/*
 * ⚠️ 必须**在隔离之前**：逐场景 harness 直接读 stdout，
 *    `isolateDatabase()` 的横幅（"[sandbox] 本次实验已隔离…"）会被当成一个"场景"。
 *    ⇒ `--list-cases` 提前退出，stdout 里**只有**用例 id。
 */
if (process.argv.includes('--list-cases')) {
  for (const entry of m3Cases()) console.log(`${entry.caseId}\t0`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 隔离（必须在任何会碰数据库的模块之前）
// ---------------------------------------------------------------------------
isolateDatabase('eval-m3')

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

interface Options {
  suiteIds: string[]
  filter?: string
  json?: string
  quiet: boolean
  /**
   * **精确**跑一条用例（2026-10-21 新增 · 逐场景子进程门用）。
   *
   * ⚠️ 与 `--filter` 的区别：`--filter` 是**子串**匹配 ⇒ 不能用来"只跑这一条"；
   *    这里按用例 id **完全相等**选。
   */
  caseId?: string
  /**
   * 把报告以**单行 JSON** 打到 stdout。
   *
   * 为什么需要它（而不是复用 `--json <file>`）：外层 Runner（Promptfoo）
   * 是通过**子进程**调用本脚本的，读的是 stdout。走文件的话，
   * 就得约定一个临时路径、并在并发用例之间避免撞名 —— 而 stdout
   * 天然是"这一次调用"的私有通道。
   *
   * 与 `--json` 可以同时用：前者给机器，后者给人留档。
   */
  stdout: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { suiteIds: [], quiet: false, stdout: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--suite' || arg === '-s') {
      const value = argv[index + 1]
      if (!value) throw new Error('--suite 需要一个套件 id')
      options.suiteIds.push(value)
      index += 1
    } else if (arg.startsWith('--suite=')) {
      options.suiteIds.push(arg.slice('--suite='.length))
    } else if (arg === '--filter' || arg === '-f') {
      const value = argv[index + 1]
      if (!value) throw new Error('--filter 需要一个子串')
      options.filter = value
      index += 1
    } else if (arg.startsWith('--filter=')) {
      options.filter = arg.slice('--filter='.length)
    } else if (arg === '--json') {
      const value = argv[index + 1]
      if (!value) throw new Error('--json 需要一个文件路径')
      options.json = value
      index += 1
    } else if (arg.startsWith('--json=')) {
      options.json = arg.slice('--json='.length)
    } else if (arg === '--stdout') {
      options.stdout = true
    } else if (arg === '--case') {
      const value = argv[index + 1]
      if (!value) throw new Error('--case 需要一个用例 id')
      options.caseId = value
      index += 1
    } else if (arg.startsWith('--case=')) {
      options.caseId = arg.slice('--case='.length)
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else if (!arg.startsWith('-')) {
      // 位置参数当作子串过滤（与 `eval-scenarios.ts` 的手感一致）
      options.filter = arg
    } else {
      throw new Error(`未知参数：${arg}（--help 看用法）`)
    }
  }
  return options
}

function printUsage(): void {
  console.log(
    [
      'M3 人格与完整性评测（离线档，无需 API Key）',
      '',
      '用法：tsx scripts/eval-m3.ts [选项] [过滤子串]',
      '',
      '  --suite <id>     只跑指定套件（可重复）',
      '  --filter <子串>  过滤用例 id / 套件 id / 标签',
      '  --json <path>    写出 EvalReport（机器可读，给人留档）',
      '  --stdout         把摘要以单行 JSON 打到 stdout（外层 Runner 读它）',
      '  --quiet          只打印摘要',
      '',
      `套件：${m3SuiteIds().join(', ')}`,
    ].join('\n')
  )
}

const options = parseArgs(process.argv.slice(2))

// 套件 id 写错时必须**当场**报错，而不是安静地跑 0 条用例（那会看起来像"全绿"）
for (const id of options.suiteIds) {
  if (!findM3Suite(id)) {
    console.error(`没有这个套件：${id}`)
    console.error(`可用套件：${m3SuiteIds().join(', ')}`)
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

const thresholds = thresholdsWithBaseline()

if (!options.quiet) {
  console.log('='.repeat(72))
  console.log('M3 人格与完整性评测（离线档：echo 模式，judge 检查标记为 skipped）')
  console.log('='.repeat(72))
  console.log(`  套件   ：${(options.suiteIds.length > 0 ? options.suiteIds : m3SuiteIds()).join(', ')}`)
  if (options.filter) console.log(`  过滤   ：${options.filter}`)
  console.log(`  用例   ：${m3Cases().length} 条，共 ${m3CheckCount()} 条检查（来自 evals/m3/index.ts）`)
  console.log(`  阈值   ：${describeThresholds(thresholds)}`)
  console.log(`  硬零   ：${M3_HARD_ZERO_METRICS.join(', ')}`)
  console.log('')
}

const started = Date.now()
const { report, observations } = await runM3({
  suites: M3_SUITES,
  live: false,
  ...(options.suiteIds.length > 0 ? { suiteIds: options.suiteIds } : {}),
  ...(options.caseId !== undefined ? { caseIds: [options.caseId] } : {}),
  ...(options.filter ? { filter: options.filter } : {}),
  modelProfile: 'echo（deterministic，无模型调用）',
  thresholds,
  onCase: options.quiet
    ? undefined
    : ({ caseId, suiteId }) => {
        process.stdout.write(`  ⏳ ${caseId}  (${suiteId})\n`)
      },
})

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

printMetricTable(report)
printCaseTable(report, observations)
printHardZero(report)

const summary: RunSummary = {
  passed: report.results.filter((result) => result.passed).length,
  failed: report.results.filter((result) => !result.passed).length,
  failures: report.results
    .filter((result) => !result.passed)
    .map((result) => ({
      name: result.caseId,
      failure: {
        message:
          result.deterministic.find((entry) => !entry.pass)?.detail ??
          result.judged.find((entry) => entry.status === 'scored')?.detail ??
          '未通过（原因见报告）',
      },
    })),
  durationMs: Date.now() - started,
}
printSummary(summary, 'M3 离线评测结果')

if (options.json) {
  writeReport(report, options.json)
}

/*
 * 外层 Runner（Promptfoo）的机器可读出口。
 *
 * ⚠️ 必须**在** `process.exit` 之前打印，而且必须是一行 ——
 * provider 是"取 stdout 里最后一行以 `{` 开头的文本"来解析的
 * （与既有的 `scripts/scenario-json.ts` 同一约定）。
 *
 * 这里刻意**只放事实，不放判断**：
 * 通过与否、指标怎么算，全部在 evals/m3 里。外层 Runner 若自己
 * 算一遍"什么算通过"，那套 Gate 就有了两个会各自漂移的定义。
 */
if (options.stdout) {
  process.stdout.write(
    `${JSON.stringify({
      ok: report.hardZeroViolations.length === 0 && summary.failed === 0,
      suiteIds: options.suiteIds.length > 0 ? options.suiteIds : m3SuiteIds(),
      caseCount: report.results.length,
      passed: summary.passed,
      failed: summary.failed,
      live: report.live,
      modelProfile: report.modelProfile,
      durationMs: summary.durationMs,
      hardZeroMetricCount: M3_HARD_ZERO_METRICS.length,
      hardZeroViolations: report.hardZeroViolations.map((violation) => ({
        metric: violation.metric,
        caseId: violation.caseId,
        detail: violation.detail,
      })),
      metrics: report.metrics,
      cases: report.results.map((result) => ({
        caseId: result.caseId,
        suiteId: result.suiteId,
        passed: result.passed,
        observations: result.observations,
        failedChecks: result.deterministic
          .filter((entry) => !entry.pass)
          .map((entry) => ({ id: entry.id, detail: entry.detail ?? '' })),
        skippedJudges: result.judged
          .filter((entry) => entry.status === 'skipped')
          .map((entry) => entry.id),
      })),
    })}\n`
  )
}

// 硬零指标一旦不为 0：退出码 1（这是 Gate，不是"目标"）
/*
 * ⚠️ `--case` 模式（逐场景子进程门）**额外**把"这条用例自己的检查没过"也算失败。
 *    全量模式保持原样（只有硬零指标决定退出码）—— 那是既有契约，不改。
 */
const exitCode =
  report.hardZeroViolations.length === 0 && (options.caseId === undefined || summary.failed === 0)
    ? 0
    : 1
process.exit(exitCode)

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/**
 * 每个指标一行。
 *
 * 形如：
 *
 *     IdentityStabilityRate          12/12   ✅
 *     PersonalityConsistency         —       ⏭️  离线档不评（judge）
 *
 * 分母是什么写在 `METRIC_DENOMINATORS` 里，报告末尾会打印，
 * 因为"12/12"如果没人知道 12 是什么，它就不是一个指标。
 */
function printMetricTable(report: EvalReport): void {
  console.log('')
  console.log('指标：')
  const names = Object.keys(report.metrics).sort()
  if (names.length === 0) {
    console.log('  （没有产出任何指标：过滤条件可能排除了全部用例）')
    return
  }
  const width = Math.max(...names.map((name) => name.length))
  for (const name of names) {
    const entry = report.metrics[name]
    const direction = METRIC_DIRECTIONS[name as M3Metric]
    const isZeroMetric = direction === 'zero'
    const scoreText = entry.score === undefined ? '' : `  均分 ${entry.score.toFixed(2)}`
    const verdict = metricVerdict(name as M3Metric, entry)
    const counts = isZeroMetric
      ? `违规 ${entry.measured - entry.passed} 次`
      : `${entry.passed}/${entry.measured}`
    console.log(`  ${name.padEnd(width)}  ${counts.padEnd(10)} ${verdict}${scoreText}`)
  }
  console.log('')
  console.log('  分母口径：')
  for (const name of names) {
    console.log(`    · ${name}：${METRIC_DENOMINATORS[name as M3Metric]}`)
  }
}

function metricVerdict(
  metric: M3Metric,
  entry: { measured: number; passed: number; score?: number }
): string {
  if (entry.measured === 0) return '⏭️  未测到'
  if (METRIC_DIRECTIONS[metric] === 'zero') {
    return entry.passed === entry.measured ? '✅' : '🔴 CRITICAL'
  }
  if (entry.score !== undefined) return entry.score >= 0.6 ? '✅' : '❌'
  return entry.passed === entry.measured ? '✅' : '❌'
}

/** 逐条用例：只打未通过的细节（通过的只给一行计数，避免刷屏） */
function printCaseTable(
  report: EvalReport,
  observations: Map<string, { reply: string }[]>
): void {
  const failed = report.results.filter((result) => !result.passed)
  if (failed.length === 0) return

  console.log('')
  console.log('未通过的用例：')
  for (const result of failed) {
    console.log(`  ❌ ${result.caseId}  (${result.suiteId})`)
    for (const entry of result.deterministic.filter((item) => !item.pass)) {
      console.log(`       · [${entry.id}] ${entry.detail ?? '未通过'}`)
    }
    for (const entry of result.judged.filter((item) => item.status === 'skipped')) {
      console.log(`       ⏭️  [${entry.id}] ${entry.detail ?? ''}`)
    }
    const last = observations.get(result.caseId)?.at(-1)
    if (last) console.log(`       她这一轮说：${truncate(last.reply)}`)
  }
}

function printHardZero(report: EvalReport): void {
  console.log('')
  if (report.hardZeroViolations.length === 0) {
    console.log('硬零指标：全部为 0 ✅')
    return
  }
  console.log('='.repeat(72))
  console.log('CRITICAL —— 硬零指标不为 0（计划书第 115–118 节）')
  console.log('='.repeat(72))
  for (const violation of report.hardZeroViolations) {
    console.log(`  🔴 ${violation.metric}  用例 ${violation.caseId}`)
    console.log(`       ${violation.detail}`)
  }
  console.log('')
  console.log('这四条不是"目标"，是闸：任何一次不为零都意味着账本里留下了错误的事实。')
}

function writeReport(report: EvalReport, path: string): void {
  const target = join(process.cwd(), path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`报告已写出：${relative(process.cwd(), target)}`)
}

function truncate(text: string, max = 140): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened
}

// `expect` 保留给后续想在这里直接断言的人（与 kernel-test-kit 同一个手感）
void expect
