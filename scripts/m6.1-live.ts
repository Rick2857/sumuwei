/**
 * M6.1 —— **Live 入口**（`pnpm with-test-model pnpm m6.1:live --suite <short|long> …`）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 *  ① 守卫（纯判定，可被 `m6.1:test` 穷举断言）—— 见 `scripts/m6.1-command-surface.ts`：
 *       必须显式给套件 · 必须经测试包装器 · 未实现的套件具名拒绝
 *  ② **已实现的套件转交给它的运行器**（本文件只做转交，不自己实现判定）
 *       short → `scripts/m6.1-live-short.ts`（M6.1 WP5）
 *       long  → `scripts/m6.1-live-long.ts`（M6.1 WP6；--trajectory V1|V2|V3 必填）
 * ```
 *
 * ⚠️ 为什么转交用 `spawnSync` 而不是 `import`：运行器是**进口即执行**的 CLI
 *    （顶层跑完就 `process.exit`）。import 它会让"守卫判定"这一步直接被跳过。
 *
 * ⚠️ 退出码**原样透传**（不吞、不改写）：一条"把失败读成成功"的包装器
 *    比没有包装器更坏。
 */

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { TEST_MODEL_WRAPPER_MARKER, evaluateM6_1LiveGuard } from './m6.1-command-surface.ts'

const decision = evaluateM6_1LiveGuard({
  argv: process.argv.slice(2),
  wrapperMarkerPresent: process.env[TEST_MODEL_WRAPPER_MARKER] === '1',
})

if (!decision.ok) {
  console.error(`[m6.1:live] ${decision.code}：${decision.message}`)
  process.exit(2)
}

const RUNNERS: Record<string, string> = {
  short: 'scripts/m6.1-live-short.ts',
  long: 'scripts/m6.1-live-long.ts',
}

const runner = RUNNERS[decision.suite]
if (runner === undefined) {
  /* 登记成 implemented 却没有运行器 = 装配不一致：失败关闭，不假装跑过 */
  console.error(`[m6.1:live] 套件 ${decision.suite} 登记为已实现，但没有对应的运行器 ⇒ 拒绝（不是空跑 PASS）`)
  process.exit(2)
}

console.log(`[m6.1:live] 转交 ${runner}（--suite ${decision.suite}）`)
const result = spawnSync(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), runner, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
