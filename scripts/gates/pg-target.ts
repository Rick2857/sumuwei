/**
 * 门的**显式 PostgreSQL 测试目标**（S-2，2026-10-20）
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 *  门的 `isolateDatabase()` 只能隔离 **PGlite 的数据目录**；后端是 postgres 时，
 *  没给测试目标就**失败关闭**（`postgres_isolation_not_provided`）。
 *
 *  而 PGlite 自 M10 起**已经不是可用的门底座**：迁移 #10 的
 *  `embedding vector(384)` 需要 pgvector，PGlite 没有（也没有 shim）。
 *  ⇒ 现在唯一的门底座是**一次性 PostgreSQL**，由
 *    `scripts/postgresql/test-harness.ts` 的 `withPgTest` / `runPreparedPgGate` 提供
 *    （一次性容器 + `lg_test_<id>` 库 + 装三个扩展 + 准备阶段显式应用 LG 迁移）。
 *
 *  `runPreparedPgGate` 把测试库 URL 放在 **`LG_TEST_PG_URL`** 里传给子进程；
 *  门只需要把它转交给 `isolateDatabase()`。
 *
 * ============================================================================
 *  ⚠️ 空 ⇒ 什么都不给（失败关闭不变）
 * ============================================================================
 *  没有 `LG_TEST_PG_URL` 时本函数返回 `{}`，调用处展开后**行为与改动前逐字相同**
 *  （即：仍然会被 `isolateDatabase()` 拒）。这样"忘了用 harness 跑"不会
 *  悄悄退化成"用别的库"。
 */

/** 形如 `{ postgres: { url } }`；没有显式目标时是 `{}`（展开即无操作） */
export function pgTestTargetFromEnv(): { postgres?: { url: string } } {
  const url = (process.env.LG_TEST_PG_URL ?? '').trim()
  if (url === '') return {}
  return { postgres: { url } }
}
