/**
 * 完整 CI 在**仿真内**的串联执行器（2026-10-21 · 认知能力建设计划 P0 续）
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 *  计划 §5 末段：「完整收口保持项目 `pnpm m4.5:ci` 的**全部原有断言和必选门**，
 *  在仿真内串联退出 0；再执行本批相关 EBL/世界模型/技能等领域门」。
 *
 *  ⇒ 本脚本把 `m4.5:ci` 的**整条链**（从 package.json 展开）在 simhost 内
 *    **逐道**跑完，并给出一条分列的读数。
 *
 * ============================================================================
 *  三种跑法（按门**实际**要什么底座分）
 * ============================================================================
 *  ① **逐场景门**（一个进程里跑多个场景、且假设每个场景从空白库开始的）
 *     → 每个场景一个独立进程 + 一个独立空白库
 *     （`scripts/postgresql/scenario-gate.ts`）
 *  ② **碰库的门** → 一个**新建的空白** `lg_test_<id>` 库（准备阶段显式迁移 + 身份核对）
 *  ③ **不碰库的门** → 直接在 simhost 里跑（不额外准备任何东西）
 *
 *  ⚠️ **链本身不在这里定义**：它从 package.json 展开（`ci-chain.ts`），
 *     所以"链上有什么"永远以 package.json 为准（改链 ⇒ 展开跟着变）。
 *     ⚠️ 展开**不删断言**：每一道门都照原样跑（只是换了执行位置与目标）。
 *
 * ============================================================================
 *  用法（宿主侧）
 * ============================================================================
 *  ```bash
 *  pnpm serversim:pgtest:ci
 *  ```
 *  ⇒ 宿主只做编排：把 `LG_SIM_PGTEST_ADMIN_URL` 注入 simhost，然后跑本脚本。
 * ============================================================================
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { fullCiChain, SCENARIO_GATES, type CiGate } from './ci-chain.ts'
import { runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'
import { listPgScenarios, runPgScenarioGate } from '../postgresql/scenario-gate.ts'

const adminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
if (adminUrl === '') {
  console.error('❌ 需要 LG_SIM_PGTEST_ADMIN_URL（仿真内的专用隔离实例的 admin 连接串）')
  console.error('   宿主侧的入口是 `pnpm serversim:pgtest:ci`。')
  process.exit(2)
}

const GATE_TIMEOUT_MS = Number(process.env.LG_CI_GATE_TIMEOUT_MS ?? 1_800_000)

interface GateResult {
  index: number
  name: string
  command: string
  kind: 'scenario' | 'database' | 'plain'
  /** PASS / FAIL / NOT RUN */
  status: 'PASS' | 'FAIL' | 'NOT RUN'
  ok: boolean
  detail?: string
  scenarios?: number
  durationMs: number
}

const chain = fullCiChain('m4.5:ci')
console.log('='.repeat(74))
console.log(`完整 CI（m4.5:ci）在仿真内执行 · 展开后共 ${String(chain.length)} 道`)
console.log('='.repeat(74))

/*
 * ⚠️ `runPreparedPgGateInInstance` 会把 `process.argv.slice(2)` **原样转发**给门体
 *    ⇒ 本脚本自己的参数会被门当成参数解析（实测：`eval-m3.ts` 报"未知参数"）。
 *    ⇒ 整轮期间把 argv 清成最小形态。
 */
const savedArgv = process.argv.slice(2)
process.argv = [process.argv[0]!, process.argv[1]!]

const results: GateResult[] = []
let index = 0
for (const gate of chain) {
  index += 1
  const started = Date.now()
  const banner = `[${String(index)}/${String(chain.length)}] ${gate.name}  ${gate.command}`
  console.log(`\n${'='.repeat(74)}\n${banner}\n${'='.repeat(74)}`)
  const isScenario = gate.script !== undefined && SCENARIO_GATES.includes(gate.script)
  const kind: GateResult['kind'] = isScenario ? 'scenario' : gate.touchesDatabase ? 'database' : 'plain'
  try {
    if (isScenario) {
      const scenarios = listPgScenarios(gate.script!)
      const outcomes = await runPgScenarioGate({
        label: gate.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
        script: gate.script!,
        scenarios: scenarios.map(scenario => ({
          id: scenario.id,
          argv: ['--case', scenario.id],
          ...(scenario.extraDatabases > 0 ? { extraDatabases: scenario.extraDatabases } : {}),
        })),
      })
      const failed = outcomes.filter(outcome => !outcome.ok)
      for (const outcome of outcomes) {
        console.log(`  ${outcome.ok ? 'PASS' : 'FAIL'}  ${outcome.id}${outcome.ok ? '' : `  — ${outcome.detail ?? ''}`}`)
        if (outcome.summary !== '') console.log(`        · ${outcome.summary}`)
      }
      if (failed.length > 0) {
        throw new Error(`逐场景门：${String(outcomes.length)} 个场景里有 ${String(failed.length)} 个失败（${failed.map(o => o.id).join(', ')}）`)
      }
      results.push({ index, name: gate.name, command: gate.command, kind, status: 'PASS', ok: true, scenarios: outcomes.length, durationMs: Date.now() - started })
    } else if (gate.touchesDatabase) {
      await runPreparedPgGateInInstance(adminUrl, gate.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), gate.script!)
      results.push({ index, name: gate.name, command: gate.command, kind, status: 'PASS', ok: true, durationMs: Date.now() - started })
    } else {
      /*
       * ⚠️ 不碰库的门**照原样**跑（`pnpm exec <命令>`）：不额外注入任何东西，
       *    也不改它的参数 ⇒ 断言一字不改。
       */
      const parts = gate.command.split(/\s+/).filter(part => part !== '')
      const child = spawnSync('pnpm', ['exec', ...parts], {
        cwd: process.cwd(),
        stdio: 'inherit',
        timeout: GATE_TIMEOUT_MS,
      })
      if (child.error !== undefined) throw child.error
      if (child.status !== 0) throw new Error(`退出码 ${String(child.status)}`)
      results.push({ index, name: gate.name, command: gate.command, kind, status: 'PASS', ok: true, durationMs: Date.now() - started })
    }
    console.log(`✅ ${gate.name}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    results.push({
      index, name: gate.name, command: gate.command, kind, status: 'FAIL', ok: false, detail,
      durationMs: Date.now() - started,
    })
    console.log(`❌ ${gate.name} — ${detail.split('\n')[0] ?? ''}`)
    // ⚠️ 继续跑：一道红就停会让"到底几道红"变成未知
  }
}

process.argv = [process.argv[0]!, process.argv[1]!, ...savedArgv]

const passed = results.filter(result => result.status === 'PASS').length
const failed = results.filter(result => result.status === 'FAIL').length
const notRun = results.filter(result => result.status === 'NOT RUN').length
const outDir = join(process.cwd(), 'artifacts', 'cognitive', 'local')
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'ci-run.json'),
  `${JSON.stringify(
    {
      chain: 'm4.5:ci',
      ranAt: new Date().toISOString(),
      execution: 'serversim（门体在 simhost 容器内执行）',
      databaseIsolation: '仿真专用隔离实例 pgtest · 每道门一个新建的空白 lg_test_<id> 库',
      total: results.length,
      passed,
      failed,
      notRun,
      /** ⚠️ NOT RUN 的门**不算通过** ⇒ 「完整必选 CI 在仿真退出 0」尚未达成 */
      allMandatoryGatesRan: notRun === 0,
      gates: results,
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log('\n' + '='.repeat(74))
console.log(`  完整 CI（m4.5:ci，仿真内）：${String(results.length)} 道 · 通过 ${String(passed)} · 失败 ${String(failed)} · 未运行 ${String(notRun)}`)
for (const result of results) {
  console.log(`  ${result.status.padEnd(7)} ${result.name.padEnd(26)} ${result.kind.padEnd(9)} ${result.command}`)
}
if (notRun > 0) {
  console.log('')
  console.log('  ⚠️ 未运行（**不算通过**）：')
  for (const result of results.filter(item => item.status === 'NOT RUN')) {
    console.log(`     · ${result.name} — ${result.detail ?? ''}`)
  }
}
console.log('='.repeat(74))
process.exit(failed === 0 && notRun === 0 ? 0 : 1)
