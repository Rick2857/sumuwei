/**
 * 用**一次性 PostgreSQL** 逐道跑 `m4.5:ci` 链上所有会碰库的门（S-2，2026-10-20）
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 *  `m4.5:ci` 链里有 **17 道门**调 `isolateDatabase()`。它们原来假设后端是
 *  PGlite（"无 .env 的 cwd + CHARACTER_DB_BACKEND=pglite"），但：
 *    · PGlite 自 M10 起不可用 —— 迁移 #10 的 `embedding vector(384)` 需要 pgvector；
 *    · 后端是 postgres 时，`isolateDatabase()` 没给测试目标就**失败关闭**。
 *  ⇒ 唯一可行的底座是**一次性 PostgreSQL 容器**。
 *
 *  本脚本把链上的 DB 门**逐道**交给 `runPreparedPgGate`：
 *    每道门 = 一个新容器 + 一个新 `lg_test_<id>` 库 + 三个扩展 + 准备阶段显式应用迁移
 *  ⇒ 门与门之间**不共享库**（这是与"一个库跑全链"的关键区别：
 *     后者会让第 N 道门看见第 N-1 道门写的数据）。
 *
 * ============================================================================
 *  ⚠️ 它**不是** `pnpm m4.5:ci` 的替代品
 * ============================================================================
 *  链上的**非 DB 门**（`typecheck` / 各 `*:test` / `eval:telemetry` / `capability:audit` /
 *  `m4.5:gates` 等）仍由原命令跑。本脚本只补上"DB 门需要一个真库"这一块。
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *  ```bash
 *  pnpm gates:pg-chain            # 逐道跑，最后给分列结果
 *  pnpm gates:pg-chain --only m4:verify
 *  ```
 *
 *  ⚠️ 链式运行不吃额外参数（`runPreparedPgGate` 会把 argv 转发给每道门）。
 */

import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'
import { listPgScenarios, runPgScenarioGate } from '../postgresql/scenario-gate.ts'

interface Entry {
  /** 人读标签（也是容器名/库名前缀的来源） */
  label: string
  /** 对应的 pnpm 脚本名（仅用于报告） */
  pnpm: string
  /** 门体脚本路径（相对仓库根） */
  script: string
  /**
   * 这道门要**逐场景**跑（2026-10-21 新增）。
   *
   * ⚠️ 为什么这几道不一样：它们在一个进程里跑**多个场景**，并假设
   *    **每个场景从空白库开始**。PostgreSQL 下 `isolateDatabase()` 给不出空白库
   *    （它只把 URL 再指一次）⇒ 场景之间互相污染
   *    （实测：`duplicate_content` / `Seed 版本不允许回退：库里是 v4，代码里是 v3`）。
   *    ⇒ 这几道必须**逐场景子进程**（每个场景一个进程 + 一个独立空白库）。
   */
  scenario?: boolean
}

/**
 * `m4.5:ci` 链上**调 `isolateDatabase()`** 的门，按链上的实际顺序。
 *
 * ⚠️ 这份清单是**枚举**而不是从 package.json 解析出来的：链里有 `&&`、
 *    有子脚本、还有 `m4.5:audit` 这种"两道命令"的组合，
 *    自动推导容易把"不碰库的门"也算进来。枚举 + 每项带 pnpm 名，便于核对。
 */
const CHAIN: readonly Entry[] = [
  { label: 'kernel-verify', pnpm: 'kernel:verify', script: 'scripts/verify-phase-c.ts' },
  { label: 'm3-verify', pnpm: 'm3:verify', script: 'scripts/verify-m3-persistence.ts' },
  { label: 'eval-m3', pnpm: 'eval:m3', script: 'scripts/eval-m3.ts', scenario: true },
  { label: 'eval-dryrun', pnpm: 'eval:dryrun', script: 'scripts/verify-dry-run-silence.ts' },
  { label: 'm35-verify', pnpm: 'm3.5:verify', script: 'scripts/verify-m3.5-persistence.ts' },
  { label: 'm4-verify', pnpm: 'm4:verify', script: 'scripts/verify-m4-persistence.ts' },
  { label: 'm4-faults', pnpm: 'm4:faults', script: 'scripts/verify-m4-faults.ts' },
  { label: 'm4-restart', pnpm: 'm4:restart:verify', script: 'scripts/verify-m4-restart.ts' },
  { label: 'm4-isolation', pnpm: 'm4:isolation:verify', script: 'scripts/verify-m4-isolation.ts' },
  { label: 'm4-restore', pnpm: 'm4:restore:verify', script: 'scripts/verify-m4-restore.ts', scenario: true },
  { label: 'm4-mutation-safety', pnpm: 'm4:mutation-safety:verify', script: 'scripts/verify-m4-mutation-safety.ts', scenario: true },
  { label: 'm4-nl-mutation', pnpm: 'm4:nl-mutation:verify', script: 'scripts/verify-m4-nl-mutation.ts', scenario: true },
  { label: 'eval-m4', pnpm: 'eval:m4', script: 'scripts/eval-m4.ts' },
  { label: 'm45-verify', pnpm: 'm4.5:verify', script: 'scripts/verify-m4.5-pipeline.ts' },
  { label: 'm45-measurement', pnpm: 'm4.5:measurement:verify', script: 'scripts/verify-m4.5-measurement.ts' },
  { label: 'm45-nl-action', pnpm: 'm4.5:nl-action:verify', script: 'scripts/verify-m4.5-nl-action.ts' },
  { label: 'm45-audit', pnpm: 'm4.5:audit', script: 'scripts/m4.5-audit.ts' },
]

const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined
const selected = only === undefined ? CHAIN : CHAIN.filter(entry => entry.label === only || entry.pnpm === only)

if (selected.length === 0) {
  console.error(`❌ --only ${String(only)} 不在清单里。可选：${CHAIN.map(e => e.pnpm).join(' / ')}`)
  process.exit(2)
}

/*
 * ⚠️ **仿真内执行分支**（2026-10-21 · 认知能力建设计划 P0）
 *
 *   给定 `LG_SIM_PGTEST_ADMIN_URL` 时，每道门的库住在**仿真里的专用隔离实例**
 *   （compose 服务 `pgtest`）里，门体跑在 simhost 内。
 *   准备阶段语义与宿主模式**完全相同**（`lg_test_` 库 + 显式迁移 + 身份核对），
 *   门与门之间仍然**不共享库**。
 *   ⇒ 宿主模式（不给这个变量）逐字保留既有行为。
 */
const simAdminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()

console.log(
  simAdminUrl === ''
    ? `▸ 用一次性 PostgreSQL 跑 ${String(selected.length)} 道 DB 门（各一个独立容器 + 独立 lg_test_ 库）\n`
    : `▸ 在仿真隔离实例上跑 ${String(selected.length)} 道 DB 门（各一个独立 lg_test_ 库；门体在 simhost 内）\n`
)

/*
 * ⚠️ `runPreparedPgGate` 会把 `process.argv.slice(2)` 原样转发给门体，
 *    而 `--only xxx` 不是门的参数 ⇒ 严格解析 argv 的门会炸（实测：`eval-m3.ts`
 *    报 "未知参数：--eval:m3"，看起来像门故障，其实是**转发污染**）。
 *    ⇒ 整轮期间把 argv 清成最小形态。
 */
const savedArgv = process.argv.slice(2)
process.argv = [process.argv[0]!, process.argv[1]!]
// 门体默认超时放宽到 600s（理由见 run-pg-gate.ts 里那段）
process.env.LG_PG_GATE_TIMEOUT_MS ??= '600000'

const results: Array<{ entry: Entry; ok: boolean; detail?: string }> = []
let index = 0
for (const entry of selected) {
  index += 1
  const banner = `[${String(index)}/${String(selected.length)}] ${entry.pnpm}  (${entry.script})`
  console.log(`\n${'='.repeat(74)}\n${banner}\n${'='.repeat(74)}`)
  try {
    if (entry.scenario === true) {
      /*
       * ⚠️ 逐场景门：**每个场景一个独立进程 + 一个独立空白库**
       *    （场景清单来自门体自身的 `--list-cases`）。
       */
      const scenarios = listPgScenarios(entry.script)
      const outcomes = await runPgScenarioGate({
        label: entry.label,
        script: entry.script,
        scenarios: scenarios.map(scenario => ({
          id: scenario.id,
          argv: ['--case', scenario.id],
          ...(scenario.extraDatabases > 0 ? { extraDatabases: scenario.extraDatabases } : {}),
        })),
      })
      const failedScenarios = outcomes.filter(outcome => !outcome.ok)
      for (const outcome of outcomes) {
        console.log(`  ${outcome.ok ? 'PASS' : 'FAIL'}  ${outcome.id}${outcome.ok ? '' : `  — ${outcome.detail ?? ''}`}`)
      }
      if (failedScenarios.length > 0) {
        throw new Error(
          `逐场景门 ${entry.pnpm}：${String(outcomes.length)} 个场景里有 ${String(failedScenarios.length)} 个失败` +
            `（${failedScenarios.map(outcome => outcome.id).join(', ')}）`
        )
      }
    } else if (simAdminUrl !== '') {
      await runPreparedPgGateInInstance(simAdminUrl, entry.label, entry.script)
    } else {
      await runPreparedPgGate(entry.label, entry.script)
    }
    results.push({ entry, ok: true })
    console.log(`✅ ${entry.pnpm}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    results.push({ entry, ok: false, detail })
    console.log(`❌ ${entry.pnpm} — ${detail}`)
    // ⚠️ 继续跑：一道红就停会让"到底几道红"变成未知
  }
}

const passed = results.filter(r => r.ok).length
const failed = results.length - passed
process.argv = [process.argv[0]!, process.argv[1]!, ...savedArgv]
console.log(`\n${'='.repeat(74)}`)
console.log(`  一次 PostgreSQL 门：${String(results.length)} 道 · 通过 ${String(passed)} · 失败 ${String(failed)}`)
for (const result of results) {
  console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.entry.pnpm.padEnd(26)} ${result.entry.script}`)
}
console.log('='.repeat(74))
process.exit(failed === 0 ? 0 : 1)
