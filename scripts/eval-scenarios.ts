/**
 * 场景回归执行器（内部 harness）。
 *
 * ============================================================================
 *  它是 CI 的"行为层 smoke"
 * ============================================================================
 * 默认 **echo 模式**：不联网、deterministic、秒级完成。
 * 它断言的是**链路与上下文**（序号、幂等、可重放、来源隔离、上下文分区），
 * 而不是"她答得像不像苏沐薇"——后者需要真实模型，由 Promptfoo 与
 * `pnpm test`（既有 run-tests.ts）负责。
 *
 * 跑法：
 *   node_modules/.bin/tsx scripts/eval-scenarios.ts              # 全部场景
 *   node_modules/.bin/tsx scripts/eval-scenarios.ts SC-004       # 单个
 *   EVAL_MODEL_MODE=real node_modules/.bin/tsx scripts/eval-scenarios.ts   # 真实模型
 *   M2_5_LONG_TURNS=300 ... eval-scenarios.ts SC-001             # 长跑
 */

import { SCENARIOS } from '../evals/scenarios/index.ts'
import { runScenario, type ModelMode } from '../evals/harness/runner.ts'
import { cleanupSandbox } from '../src/dev/sandbox.ts'

interface Outcome {
  id: string
  ok: boolean
  durationMs: number
  detail?: string
}

/*
 * ⚠️ `--list-cases` 必须在**横幅之前**：逐场景执行器直接读 stdout，
 *    横幅会被当成一个"场景"。
 *    每行格式：`id<TAB>额外独立库数`（与其它逐场景门同形）。
 */
if (process.argv.includes('--list-cases')) {
  for (const scenario of SCENARIOS) console.log(`${scenario.id}\t0`)
  process.exit(0)
}

/*
 * ⚠️ `--case <id>`（**精确**匹配）与既有的**位置参数**选场景并存。
 *
 *  为什么需要 `--case`：逐场景执行器（`scripts/postgresql/scenario-gate.ts`）
 *    用的是**统一约定** `--case <id>`；而本脚本原本只认位置参数。
 *    位置参数继续可用（`tsx scripts/eval-scenarios.ts SC-004`），一字未改。
 */
const caseIndex = process.argv.indexOf('--case')
const explicitCase = caseIndex >= 0 ? process.argv[caseIndex + 1] : undefined
const filter = explicitCase !== undefined
  ? [explicitCase]
  : process.argv.slice(2).filter((a) => !a.startsWith('--'))
const modelMode = (process.env.EVAL_MODEL_MODE as ModelMode) ?? 'echo'

const title = [
  '='.repeat(72),
  `M2.5 场景回归（model=${modelMode}${process.env.M2_5_LONG_TURNS ? `, longTurns=${process.env.M2_5_LONG_TURNS}` : ''}）`,
  '='.repeat(72),
]
console.log(title.join('\n'))

const selected = filter.length > 0 ? SCENARIOS.filter((s) => filter.includes(s.id)) : SCENARIOS
if (selected.length === 0) {
  console.error(`没有匹配的场景：${filter.join(', ')}`)
  process.exit(2)
}

const outcomes: Outcome[] = []
const sandboxes: string[] = []

for (const scenario of selected) {
  const started = Date.now()
  process.stdout.write(`  ⏳ ${scenario.id} ${scenario.description}\n`)
  try {
    const result = await runScenario(scenario, { modelMode })
    sandboxes.push(result.agent.dataDir ?? '')
    const elapsed = Date.now() - started
    outcomes.push({ id: scenario.id, ok: true, durationMs: elapsed })
    const assertions = scenario.assertions.length
    console.log(
      `  ✅ ${scenario.id}  ${assertions}/${assertions} 断言通过  ` +
        `(${elapsed}ms, ${result.run.conversationEvents.length} 事件, ` +
        `${result.run.domainEvents.length} 领域事件)`,
    )
  } catch (error) {
    const elapsed = Date.now() - started
    const detail = error instanceof Error ? error.message : String(error)
    outcomes.push({ id: scenario.id, ok: false, durationMs: elapsed, detail })
    console.log(`  ❌ ${scenario.id}  (${elapsed}ms)`)
    console.log(
      detail
        .split('\n')
        .map((line) => `       ${line}`)
        .join('\n'),
    )
  }
}

// 清理本次运行产生的沙箱（keep=true 的由我们自己删）
for (const dir of sandboxes) {
  if (dir) cleanupSandbox(dir)
}

const passed = outcomes.filter((o) => o.ok).length
const failed = outcomes.length - passed

console.log(`\n${'='.repeat(72)}`)
console.log(`场景回归结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  console.log('失败场景：')
  for (const outcome of outcomes.filter((o) => !o.ok)) {
    console.log(`  - ${outcome.id} → ${outcome.detail?.split('\n')[0] ?? ''}`)
  }
}
console.log('='.repeat(72))

process.exit(failed === 0 ? 0 : 1)
