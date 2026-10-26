/**
 * 逐场景子进程门执行器 · 命令行入口（2026-10-21 · 认知能力建设计划 P0.4）
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *  ```bash
 *  pnpm gates:pg:scenario -- scripts/verify-m4-mutation-safety.ts
 *  ```
 *
 *  它做三件事：
 *   ① 问门体自己要场景清单（`--list-cases`）—— 清单的**唯一事实源在门里**；
 *   ② 每个场景**一个独立进程 + 一个独立的空白隔离库**（见 scenario-gate.ts）；
 *   ③ 分列报告每个场景的成败，**一道红就整体非零退出**。
 *
 *  ⚠️ 为什么必须是**子进程**而不是"同进程换库"：
 *     产品不变量「同进程只允许一个 PostgreSQL 目标」**一字未动**；
 *     进程内目标**从不改变** ⇒ 那条守卫根本不会被触发。
 *     隔离来自**进程边界 + 库边界**。
 *
 *  ⚠️ 两种执行位置：
 *     · 宿主模式（不给 `LG_SIM_PGTEST_ADMIN_URL`）：每个场景一个一次性容器；
 *     · 仿真模式（给了它）：门体跑在 simhost 内，库住在仿真的**专用隔离实例**。
 * ============================================================================
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listPgScenarios, runPgScenarioGate, type ScenarioOutcome } from '../postgresql/scenario-gate.ts'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
void REPO

const args = process.argv.slice(2)
const script = args.find(arg => !arg.startsWith('--'))
if (script === undefined) {
  console.error('用法：pnpm gates:pg:scenario -- scripts/<门体>.ts')
  console.error('例：  pnpm gates:pg:scenario -- scripts/verify-m4-mutation-safety.ts')
  process.exit(2)
}

const listFlagIndex = args.indexOf('--list-flag')
const listFlag = listFlagIndex >= 0 ? (args[listFlagIndex + 1] ?? '--list-cases') : '--list-cases'
const caseFlagIndex = args.indexOf('--case-flag')
const caseFlag = caseFlagIndex >= 0 ? (args[caseFlagIndex + 1] ?? '--case') : '--case'

console.log('='.repeat(74))
console.log(`逐场景子进程门：${script}`)
console.log(`  场景清单来源：门体自身的 ${listFlag}`)
console.log('='.repeat(74))

let entries: Array<{ id: string; extraDatabases: number }>
try {
  entries = listPgScenarios(script, listFlag)
} catch (error) {
  console.error(`❌ 读不到场景清单：${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
if (entries.length === 0) {
  console.error(`❌ 门体 ${script} 没有报告任何场景（${listFlag} 输出为空）`)
  process.exit(2)
}
console.log(`  场景数：${String(entries.length)}`)

const outcomes: ScenarioOutcome[] = await runPgScenarioGate({
  label: script.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
  script,
  scenarios: entries.map(entry => ({
    id: entry.id,
    argv: [caseFlag, entry.id],
    ...(entry.extraDatabases > 0 ? { extraDatabases: entry.extraDatabases } : {}),
  })),
})

const passed = outcomes.filter(o => o.ok).length
const failed = outcomes.length - passed

console.log('\n' + '='.repeat(74))
console.log(`  逐场景门：${String(outcomes.length)} 个场景 · 通过 ${String(passed)} · 失败 ${String(failed)}`)
for (const outcome of outcomes) {
  console.log(`  ${outcome.ok ? 'PASS' : 'FAIL'}  ${outcome.id}${outcome.ok ? '' : `  — ${outcome.detail ?? ''}`}`)
  // ⚠️ 每个场景都留下**一行读数**（门自己的"…：N 通过 / M 失败"）：
  //    门体的 stdout 是被捕获的，不打这一行的话日志里只剩 PASS/FAIL 两个字母。
  if (outcome.summary !== '') console.log(`        · ${outcome.summary}`)
  if (!outcome.ok && outcome.tail !== '') {
    console.log('        ' + outcome.tail.split('\n').join('\n        '))
  }
}
console.log('='.repeat(74))
process.exit(failed === 0 ? 0 : 1)
