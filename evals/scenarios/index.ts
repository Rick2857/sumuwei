/**
 * 场景注册表 —— **Canonical 定义**。
 *
 * 这里是"行为回归测什么"的唯一定义处：
 *   · 内部 harness（`scripts/eval-scenarios.ts`）直接读它
 *   · Promptfoo 通过 `evals/promptfoo/build-config.ts` 把同一份定义翻成 YAML
 *   · M3–M12 新增场景只需要往这里加文件，不需要改 runner
 *
 * 因此"换掉 Promptfoo"不会丢掉任何场景定义（plan 第 54/87 节）。
 */

import type { Scenario } from '../harness/runner.ts'

import { SC_001 } from './sc-001-seed-stability.ts'
import { SC_002 } from './sc-002-assistant-is-not-user.ts'
import { SC_003 } from './sc-003-event-order.ts'
import { SC_004 } from './sc-004-duplicate-processing.ts'
import { SC_005 } from './sc-005-projection-replay.ts'
import { SC_006 } from './sc-006-context-compiler.ts'
import { SC_007 } from './sc-007-telemetry-failure.ts'

export const SCENARIOS: readonly Scenario[] = [
  SC_001,
  SC_002,
  SC_003,
  SC_004,
  SC_005,
  SC_006,
  SC_007,
]

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}
