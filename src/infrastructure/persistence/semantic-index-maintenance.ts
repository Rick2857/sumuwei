/**
 * M9.5 **启用计划 / WP4** —— **一轮维护**（`build` + `reconcile` 的**唯一入口**）。
 *
 * ============================================================================
 *  为什么要有它（`D-3` 的原话）
 * ============================================================================
 * ```text
 * `D-3` = 「**必须先接自动化维护，才允许切 `on`**」。
 * 而在这之前，"维护"是两个**各自独立**的调用：WP2 的 `buildSemanticIndex()` 与
 * WP3 的 `reconcileSemanticIndex()` —— 谁先谁后、失败要不要继续，**没有任何一处规定**。
 * ⇒ 本模块就是那条规定：**一轮维护 = 先失效传播，再建**，且**顺序不能反**。
 * ```
 *
 * ⚠️ **顺序为什么不能反**（这是本模块唯一真正的判断）：
 * ```text
 * 先 reconcile 再 build：
 *   · 被遗忘的件**先**从索引里消失 ⇒ 紧接着的 build **不会**把它写回来（它已不 eligible）
 * 先 build 再 reconcile：
 *   · 中间那一段，一条"她已经忘掉的事"**还在索引里**（虽然很短）
 * ⇒ 遗忘的隐私边界要求"先删后建"。
 * ```
 *
 * ⚠️ **它不决定"什么时候跑"**：显式命令 / 启动时一次 / 后台周期任务 —— 那是**接线**的事，
 *    属 `WP4` 的接线部分（**需你定**）；本模块只提供那个**可被调用的动作**。
 * ⚠️ **失败不吞**：`build` 抛错就抛（调用方决定是否重试）；`reconcile` 抛错同理 ——
 *    一轮维护**不**假装"部分成功也算成功"。
 */

import type { RawDb } from './db.ts'
import { buildSemanticIndex, type BuildOptions, type BuildResult } from './semantic-index-builder.ts'
import { reconcileSemanticIndex, type ReconcileResult } from './semantic-index-reconcile.ts'

export interface MaintenanceOptions extends Omit<BuildOptions, 'db'> {
  readonly db: RawDb
}

export interface MaintenanceRun {
  /** **先**跑的失效传播 */
  readonly reconcile: ReconcileResult
  /** **后**跑的建索引 */
  readonly build: BuildResult
  /** 一句话读数（便于日志/健康读回引用） */
  readonly summary: string
}

export async function runIndexMaintenance(options: MaintenanceOptions): Promise<MaintenanceRun> {
  const reconcile = await reconcileSemanticIndex({
    db: options.db,
    namespace: options.namespace,
    generationId: options.generationId,
    integrityProblemsOf: options.integrityProblemsOf,
  })
  const build = await buildSemanticIndex(options)
  return {
    reconcile,
    build,
    summary:
      `reconcile: 删 ${String(reconcile.removedIneligible)} 条(失格) + ` +
      `${String(reconcile.removedStaleRevision)} 条(过期版)，留 ${String(reconcile.kept)}；` +
      `build: eligible ${String(build.counts.eligible)} / indexed ${String(build.counts.indexed)} / ` +
      `pending ${String(build.counts.pending)} / failed ${String(build.counts.failed)} / ` +
      `excluded ${String(build.counts.excluded)} · ${build.buildState}` +
      `${build.refused === null ? '' : ` · REFUSED ${build.refused}`}`,
  }
}
