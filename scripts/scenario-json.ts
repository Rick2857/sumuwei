/**
 * 单个场景的可机读执行器 —— Promptfoo 与外部 runner 的**桥**。
 *
 * ============================================================================
 *  为什么要有这个文件
 * ============================================================================
 * plan 第 54 节要求：场景的 canonical 定义必须留在内部，
 * Promptfoo 只是 Runner 之一。所以：
 *
 *      evals/scenarios/*.ts          ← canonical 定义（唯一真相）
 *              │
 *              ├─ scripts/eval-scenarios.ts      内部 runner（人看）
 *              └─ scripts/scenario-json.ts       ← 本文件（机读）
 *                       │
 *                       └─ evals/promptfoo/provider.mjs → Promptfoo
 *
 * 它把一次场景运行的结果以**单行 JSON** 打到 stdout，因此外层任何工具
 * （Promptfoo / CI / 自研 long-horizon runner）都能消费同一份事实。
 *
 * 用法：
 *   node_modules/.bin/tsx scripts/scenario-json.ts SC-002
 *   EVAL_MODEL_MODE=real node_modules/.bin/tsx scripts/scenario-json.ts SC-001
 */

import { findScenario } from '../evals/scenarios/index.ts'
import { assertInvariants, runScenario, type ModelMode } from '../evals/harness/runner.ts'
import { cleanupSandbox } from '../src/dev/sandbox.ts'
import type { InvariantViolation } from '../evals/harness/invariants.ts'

const scenarioId = process.argv[2]
if (!scenarioId) {
  console.error('用法：tsx scripts/scenario-json.ts <SCENARIO_ID>')
  process.exit(2)
}

const scenario = findScenario(scenarioId)
if (!scenario) {
  console.error(`未找到场景：${scenarioId}`)
  process.exit(2)
}

const modelMode = (process.env.EVAL_MODEL_MODE as ModelMode) ?? 'echo'

try {
  const { run, agent } = await runScenario(scenario, { modelMode })
  const violations: InvariantViolation[] = assertInvariants(run)

  const payload = {
    scenarioId: scenario.id,
    description: scenario.description,
    modelMode,
    ok: violations.length === 0,
    violations: violations.map((v) => ({ code: v.code, message: v.message })),
    turns: agent.captured.map((turn) => ({
      input: turn.input,
      reply: turn.reply,
      sections: turn.packet.sections.map((s) => s.id),
      droppedSections: turn.packet.droppedSectionIds,
      compilerVersion: turn.packet.compilerVersion,
      estimatedTokens: turn.packet.estimatedTokens,
    })),
    counts: {
      conversationEvents: run.conversationEvents.length,
      domainEvents: run.domainEvents.length,
      assertions: scenario.assertions.length,
    },
    durationMs: run.durationMs,
  }

  // 单行 JSON：任何外层 runner 都能直接解析
  process.stdout.write(`${JSON.stringify(payload)}\n`)

  const dir = agent.dataDir
  if (dir) cleanupSandbox(dir)
  process.exit(payload.ok ? 0 : 1)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(
    `${JSON.stringify({ scenarioId: scenario.id, ok: false, error: message })}\n`,
  )
  process.exit(1)
}
