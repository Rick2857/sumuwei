/**
 * PostgreSQL 迁移探针：**同进程第二个 PostgreSQL 目标**（`PG-G01` 的 G01.7）。
 *
 * ============================================================================
 *  它证明什么
 * ============================================================================
 *  plugin-sql 的连接池全局键是 `default:pg` —— **不含连接地址**。
 *  ⇒ 同进程换目标会复用旧池（对 B 的查询实际落在 A 上）。
 *  计划 §3.2 的首期裁定："同进程多目标路径必须**拒绝**或有已验证的隔离实现"。
 *
 *  本探针在**同一个进程**里做三件事：
 * ```text
 *   ① 打开目标 A            ⇒ 期望**成功**
 *   ② 再打开**同一个** A     ⇒ 期望**成功**（重复打开是幂等的，守卫不该误伤）
 *   ③ 打开**另一个** B       ⇒ 期望**具名拒绝** `second_postgres_target_in_process`
 * ```
 *  ② 是**对照**：没有它，"③ 被拒"可能只是因为"第二次调用 initDatabase 就会失败"。
 *
 *  输出用哨兵行（与 `qualification-probe.ts` 同一约定）。
 *
 *  跑法：
 *    LG_TARGET_A=postgres://…/lg_test_a LG_TARGET_B=postgres://…/lg_test_b \
 *    node node_modules/tsx/dist/cli.mjs scripts/postgresql/second-target-probe.ts
 */
import type { AgentRuntime, Character, Plugin } from '../../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../../src/infrastructure/runtime/thin-host-factory.ts'



import { character } from '../../src/character/index.ts'

const SENTINEL = '__SECOND_TARGET_JSON__'

interface Attempt {
  ok: boolean
  code?: string
  database?: string
  message?: string
}

interface Reading {
  ok: boolean
  firstA?: Attempt
  secondA?: Attempt
  thenB?: Attempt
  /** 收尾是否把池关掉了（不关的话进程会挂着不退出，见下） */
  closedClean?: boolean
  error?: string
}

const reading: Reading = { ok: false }

/** 最近一次**成功开库**用的 runtime —— 收尾时要靠它关掉池 */
let openedRuntime: AgentRuntime | undefined

/**
 * 用给定的 URL 跑一次真实的 `initDatabase()`。
 *
 * ⚠️ 每次都要**新造 runtime**（同一个 runtime 上 `registerPlugin` 会因
 *    "adapter 已注册"而跳过，那测不到目标守卫）。
 * ⚠️ `process.env.POSTGRES_URL` 必须同步改 —— `resolveDatabaseBackend()` 读的就是它。
 */
async function attempt(url: string, database: string): Promise<Attempt> {
  process.env.CHARACTER_DB_BACKEND = 'postgres'
  process.env.POSTGRES_URL = url
  process.env.LG_TEST_PG_URL = url
  process.env.LG_PG_EXPECT_DATABASE = database
  process.env.LG_PG_EXPECT_USER = 'lg_migrate'
  process.env.LG_TEST_DATABASE_PREFIX = 'lg_test_'

  const runtime = createThinHostRuntime({
    character: character,
    settings: { POSTGRES_URL: url },
  })

  try {
    const { initDatabase } = await import('../../src/db/index.ts')
    const ready = await initDatabase(runtime)
    /*
     * ⚠️ 只在**成功**时记下 runtime：池挂在这个 runtime 的 adapter 上。
     *    失败的那次（守卫在 `registerPlugin` **之前**就抛了）根本没有 adapter ⇒
     *    `closeDatabaseConnection()` 对它是个 no-op（AT3.3）⇒ 拿它收尾等于没关。
     *    （本轮实测：第一版记的是"最后一次尝试"，于是进程永远不退出。）
     */
    openedRuntime = runtime
    return { ok: true, database: ready.identity?.database }
  } catch (error) {
    const e = error as { code?: string; message?: string }
    return {
      ok: false,
      code: e.code,
      message: (e.message ?? String(error)).split('\n')[0],
    }
  }
}

async function main(): Promise<void> {
  const urlA = process.env.LG_TARGET_A
  const urlB = process.env.LG_TARGET_B
  const dbA = process.env.LG_TARGET_A_DB
  const dbB = process.env.LG_TARGET_B_DB
  if (urlA === undefined || urlB === undefined || dbA === undefined || dbB === undefined) {
    throw new Error('缺少 LG_TARGET_A / LG_TARGET_B / LG_TARGET_A_DB / LG_TARGET_B_DB')
  }

  // 迁移闸：目标 A 是全新库 ⇒ 需要显式放行（与 `pnpm migrate:apply` 同一条路）
  const { allowKernelMigration } = await import('../../src/db/index.ts')
  allowKernelMigration()

  reading.firstA = await attempt(urlA, dbA)
  reading.secondA = await attempt(urlA, dbA)
  reading.thenB = await attempt(urlB, dbB)

  /*
   * ==========================================================================
   *  收尾：**必须**关掉本进程的池
   * ==========================================================================
   * ⚠️ 本轮实测踩到：不关的话进程**永远不退出**（挂住）。
   *
   * 机理与 `F-WP2-02` 是同一件事的**另一面**：
   *   · `F-WP2-02` 是"初始化**失败**时没人关池" ⇒ 已在 `initDatabase` 里修掉；
   *   · 这一条是"初始化**成功**"时池**本来就该开着**（那是应用自己的池）
   *     ⇒ `initDatabase` 的失败回收**不会**（也不该）触发。
   *   ⇒ 所以**探针/脚本**在正常路径下要自己关 —— 与 `init-probe.ts` 同源。
   *
   * 实测症状：三次尝试共用**同一个**池（插件按 `default:pg` 缓存），
   * 进程退出后 `pg_stat_activity` 里 `lg_migrate` 仍握着 1 个 `lg_test_sa` 会话。
   */
  if (openedRuntime !== undefined) {
    const { closeDatabaseConnection } = await import(
      '../../src/infrastructure/persistence/runtime-shutdown.ts'
    )
    await closeDatabaseConnection(openedRuntime)
    reading.closedClean = true
  }

  reading.ok = true
}

await main().catch((error: unknown) => {
  reading.error = error instanceof Error ? error.message : String(error)
})

console.log(`${SENTINEL} ${JSON.stringify(reading)}`)
if (!reading.ok) process.exitCode = 1
