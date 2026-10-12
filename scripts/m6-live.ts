/**
 * M6 —— **Live 入口**（`pnpm m6:live --suite <...>`）。
 *
 * ============================================================================
 *  它现在**故意什么都不跑**（这是设计，不是偷懒）
 * ============================================================================
 * 计划书 §9.1 要求这个入口："显式选择短 smoke／校准／500 轮套件，必须经测试包装器；
 * 不默认一口气跑三条长轨迹"。那三条套件分别属于 **WP9a / WP9b**，最终候选上的
 * Live 属于 **WP10b**。WP4 能交付、也应该交付的是**它周围的守卫** ——
 * 因为守卫写错的表现是"以为在跑测试、其实在烧 `.env` 里的原 key"，
 * 那正是本仓库登记过的最坏失败模式。
 *
 * 守卫本体在 `scripts/m6-command-surface.ts`（纯函数，可被量具门逐条断言）；
 * 本文件只是外壳：把判定结果如实打出来。
 */

import { TEST_MODEL_WRAPPER_MARKER, evaluateLiveGuard } from './m6-command-surface.ts'

const decision = evaluateLiveGuard({
  argv: process.argv.slice(2),
  wrapperMarkerPresent: process.env[TEST_MODEL_WRAPPER_MARKER] === '1',
})

if (!decision.ok) {
  console.error(`[m6:live] ${decision.code}：${decision.message}`)
  process.exit(2)
}

// 走到这里说明"套件已实现且经包装器" —— 当前登记表里没有任何一条会到这里。
console.error(`[m6:live] 套件 ${decision.suite} 已实现，但本入口的执行接线属于 WP10b`)
console.error(
  '[m6:live] 实际可跑的真模型入口由 M6.1 交付（TD-14 指引）：' +
    '`pnpm with-test-model pnpm m6.1:live --suite short|long` —— 本入口只留守卫，不转发。'
)
process.exit(2)
