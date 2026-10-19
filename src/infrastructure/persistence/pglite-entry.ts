/**
 * 解析 PGlite 入口路径 —— **全仓唯一一份**（M12 · W2 创建，W4 简化）。
 *
 * ============================================================================
 *  历史：W2 时这段逻辑必须绕一圈（实测，不是推测）
 * ============================================================================
 * `@electric-sql/pglite` 当时**不是**本仓库的直接依赖，只挂在
 * `@elizaos/plugin-sql` 的传递依赖里，而 pnpm 是**严格依赖隔离**的：
 *   · `createRequire(本仓文件).resolve('@electric-sql/pglite')` ⇒ **MODULE_NOT_FOUND**
 *   · `createRequire(plugin-sql 的入口).resolve('@electric-sql/pglite')` ⇒ ✅
 * ⇒ 于是写成"先试直接、失败就经 plugin-sql 绕一圈"。
 *
 * ============================================================================
 *  W4：`@electric-sql/pglite` 已**提升为直接依赖**（0.3.16，与原传递依赖**同版本**）
 * ============================================================================
 * ⇒ 绕一圈的那条路**随 `@elizaos/plugin-sql` 一起删掉**：
 *   保留它 = 删包后仍留一条指向已删包的代码路径（下次删包会再撞一次）。
 *
 * ⚠️ 版本必须**逐字等于**原传递依赖（实测装的是 `0.3.16`）：
 *   两个 PGlite 实例指向同一个数据目录会**互相损坏**
 *   （进程级单例问题，见 `src/dev/sandbox.ts` 的记录）⇒ 宁可绕一圈也不能自己装一份新的。
 *
 * ⚠️⚠️ **这里曾经有一个真 bug**（2026-10-19 实测发现）：
 *   `thin-host-factory.ts` 的 `PglitePool` 写的是
 *   `createRequire(import.meta.url).resolve('@electric-sql/pglite')` ——
 *   注释声称"按 plugin-sql 的**同一份**解析"，**但代码并没有**那么做
 *   ⇒ 实测 MODULE_NOT_FOUND ⇒ 薄宿主的 PGlite 分支**根本起不来**。
 *   之前没暴露，是因为所有薄宿主门都跑在 **PostgreSQL** 后端上。
 */

import { createRequire } from 'node:module'

/**
 * 解析 PGlite 的入口路径。
 *
 * ⚠️ 失败时**具名报错**（说清"直接依赖不在"这件事），不要静默回落 ——
 *    静默回落会让"这次到底跑在哪个库上"不可判定。
 */
export function resolvePgliteEntry(): string {
  const requireFromHere = createRequire(import.meta.url)
  try {
    return requireFromHere.resolve('@electric-sql/pglite')
  } catch {
    throw new Error(
      '[pglite] 解析不到 `@electric-sql/pglite`。\n' +
        '  它在 package.json 里是**直接依赖**（W4 从 plugin-sql 的传递依赖提升而来）。\n' +
        '  若这里失败，多半是依赖没装全：`pnpm install`。\n' +
        '  （本次没有改动任何数据。）'
    )
  }
}
