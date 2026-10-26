/**
 * 实验脚本的**强制数据隔离**。
 *
 * ============================================================================
 *  规矩（用户 2026-09-15 明确要求，针对"实验"）
 * ============================================================================
 *  凡是跑在真实对话之外、会读写数据库的实验脚本（验收、对照实验、诊断），
 *  一律在**独立副本**上运行，绝不碰真实对话库。
 *
 * ---------------------------------------------------------------------------
 *  为什么做成硬约束，而不是"我记住了"
 * ---------------------------------------------------------------------------
 * 曾经真实发生过：验收脚本跑在真实房间 `room-dm-{USER}` 里，在 trust=0.15
 * 状态下生成的「你谁啊」「我又不认识你」被写进了真实历史。之后即使状态恢复，
 * 她**自己的那些话**仍留在上下文里，把她继续往陌生人方向拉——污染自增强。
 *
 * 靠人自觉是不够的，所以这里做三件事：
 *   1. 每个实验进程自动获得**独立的临时数据库目录**（默认行为，无需选择）
 *   2. 任何指向真实库的尝试**直接抛错拒绝运行**
 *   3. 隔离目录会打印出来，每次运行都能被肉眼确认
 *
 * ---------------------------------------------------------------------------
 *  用法（顺序很关键）
 * ---------------------------------------------------------------------------
 *  ⚠️ 必须在任何"会碰数据库"的模块之前调用，因为它靠设置 `PGLITE_DATA_DIR`
 *     生效，而 pglite 适配器只读一次。
 *
 *  写库的实验脚本 —— 文件顶部两行：
 *
 *      import { isolateDatabase } from '../src/dev/sandbox.ts'
 *      isolateDatabase('verify-state')          // ← 必须在下面的 import 之前
 *
 *      import { initDatabase } from '../src/db/index.ts'
 *
 *  之所以可靠：ESM 按依赖顺序求值，导入模块先于宿主模块体执行；
 *  而真正的数据库连接发生在宿主模块体里更下面的 `await initDatabase(...)`，
 *  那时环境变量早已就位。
 *
 *  只读地观察真实库的脚本（如 dump-prompt.ts）——不调用本模块，
 *  但必须保证只读（不写消息、不建档），见该文件的说明。
 *
 *  纯函数脚本（如 verify-decay.ts）不碰数据库，无需调用。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { KernelError } from '../kernel/contracts/index.ts'
import {
  databaseBackendEnvironmentFrom,
  databaseStartupDenialMessage,
  parseDatabaseTarget,
  postgresIsolationDecision,
  redactPostgresUrl,
  resolveDatabaseBackend,
} from '../infrastructure/persistence/database-backend.ts'

/** 真实对话库位置（相对项目根目录） */
export const PRODUCTION_DB_DIR = resolve('data/pglite')

/** drizzle / PGlite 实际使用的数据目录（适配器支持带子目录的形式） */
function normalize(p: string): string {
  return resolve(p).replace(/[\\/]+$/, '')
}

/** 目标目录是否与真实库重叠（等于、或互为父子） */
export function isProductionDir(dir: string): boolean {
  const a = normalize(dir)
  const b = normalize(PRODUCTION_DB_DIR)
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep)
}

export interface SandboxInfo {
  /**
   * 本次运行独占的目录。
   *
   * ⚠️ 两种后端下它的**含义不同**（类型保持 `string` 是刻意的：它是纯追加改动，
   * 30+ 个既有调用方一行都不用改）：
   *   · `backend === 'pglite'`   ⇒ 这就是本次实验的**数据库目录**
   *   · `backend === 'postgres'` ⇒ 这只是本次实验的**诊断产物落盘目录**
   *      （PostgreSQL 的隔离依据是"连的是哪个库"，见 `postgresTarget`）
   */
  dir: string
  label: string
  /**
   * 本次运行实际使用的后端（WP1）。
   *
   * ⚠️ 判"隔离开没开"时**必须**先看这个字段：
   * 只看 `dir` 是不是真实库目录，在 PG 后端下会**照样通过**（守的是空气）。
   */
  backend: 'pglite' | 'postgres'
  /** 本次运行使用的测试库目标（PostgreSQL 分支；**已脱敏**） */
  postgresTarget?: string
}

let current: SandboxInfo | undefined

/** 同一进程内的隔离序号：防止同一毫秒内的两次 isolateDatabase 撞目录 */
let isolationCounter = 0

/**
 * 建立一次性数据库副本（PGlite）或指向测试库（PostgreSQL）。
 *
 * ============================================================================
 *  ⚠️ WP1：PostgreSQL 后端下**默认失败关闭**
 * ============================================================================
 * 本函数只能隔离 **PGlite 的数据目录**。PostgreSQL 是独立服务，"换个目录"
 * 这件事不存在 —— 换的只能是**连哪个库**。
 *
 * 于是有两种做法，本仓库选后者：
 *
 *   ✗ 「后端是 postgres 也照样往下跑」⇒ 继承到生产 `POSTGRES_URL` 的实验脚本
 *      会连上生产库，而它自己的隔离断言（读 `PGLITE_DATA_DIR`）**照样通过** ——
 *      这正是 INC-01 那一类"看起来隔离了"的形状。
 *   ✓ 「没给测试目标就拒绝」⇒ 要跑 PG 实验，必须在调用处**显式**给出测试库目标。
 *
 * @param label   脚本标识，出现在临时目录名里，便于排查
 * @param options.runId 固定运行标识（同一 id 会复用目录，用于需要跨进程续跑的实验）
 * @param options.postgres 显式给出的测试库目标（`{ url }`）。给错目标会被拒：
 *                 ① 解析不了 ⇒ 拒；② 等于生产目标 ⇒ 拒；③ database 名不带测试前缀 ⇒ 拒。
 *                 测试前缀缺省 `lg_test_`，可用 `LG_TEST_DATABASE_PREFIX` 覆盖。
 */
export function isolateDatabase(
  label: string,
  options: { runId?: string; keep?: boolean; postgres?: { url: string } } = {}
): SandboxInfo {
  isolationCounter += 1
  // ⚠️ 目录名必须**每次调用都不同**：
  //   早期只用 `Date.now()`，同一个进程内连续隔离两个库（例如场景回归逐个跑
  //   SC-001…SC-007）会拿到同一个目录，于是第二个场景直接看到了第一个场景的
  //   对话与领域事件——不是数据串了，而是**根本没隔离**。
  //   实测症状：`预期 2 条助手事件，实际 25`。
  const runId = options.runId ?? `${Date.now()}-${isolationCounter}`
  const dir = join(tmpdir(), `project-lg-exp-${label}-${runId}`)

  // -------------------------------------------------------------------------
  // ① PostgreSQL 分支（WP1）
  // -------------------------------------------------------------------------
  const resolution = resolveDatabaseBackend(databaseBackendEnvironmentFrom())
  if (resolution.backend === 'postgres') {
    /*
     * ========================================================================
     *  显式测试目标的两个来源（S-2，2026-10-20）
     * ========================================================================
     *  ① 调用处给：`isolateDatabase(label, { postgres: { url } })`（首选，最显式）
     *  ② 环境里给：`LG_TEST_PG_URL` —— 由
     *     `scripts/postgresql/test-harness.ts` 的 `runPreparedPgGate` 注入
     *     （它起一次性容器 + `lg_test_<id>` 库 + 装三个扩展 + 准备阶段显式应用 LG 迁移）
     *
     *  ⚠️ 为什么允许 ②：门的底座**已经不是 PGlite** —— 迁移 #10 的
     *     `embedding vector(384)` 需要 pgvector，PGlite 没有（也没有 shim），
     *     所以"无 .env + pglite"那条老跑法自 M10 起不可执行。
     *     若逐门改 17 个文件去传 ①，改动面与出错面都远大于"在这里读一个环境变量"。
     *
     *  ⚠️ **失败关闭没有放松**：② 给的 URL 仍要过 `postgresIsolationDecision()`
     *     的同一套三道判据（可解析 / ≠ 生产目标 / 库名带 `lg_test_` 前缀）；
     *     两处都没给 ⇒ 仍然抛 `postgres_isolation_not_provided`。
     */
    const explicitTarget = options.postgres?.url
    const envTarget = (process.env.LG_TEST_PG_URL ?? '').trim()
    const target = explicitTarget !== undefined ? explicitTarget : (envTarget === '' ? undefined : envTarget)
    const decision = postgresIsolationDecision({
      postgresUrl: target,
      productionTarget: process.env.LG_PRODUCTION_POSTGRES_URL,
      testDatabasePrefix: process.env.LG_TEST_DATABASE_PREFIX,
    })
    if (!decision.allowed) {
      const url = target
      throw new KernelError(
        'persistence_error',
        decision.denial ?? 'postgres_isolation_not_provided',
        databaseStartupDenialMessage(decision.denial ?? 'postgres_isolation_not_provided', {
          resolution,
          ...(url !== undefined && url.trim() !== ''
            ? { redactedTarget: redactPostgresUrl(url) }
            : {}),
        })
      )
    }

    const url = target!
    process.env.POSTGRES_URL = url
    process.env.PROJECT_LG_SANDBOX = dir // 审计标记：仍设，但**不**再是"隔离已成立"的依据

    // 仍然建一个独占目录：只用于落盘诊断产物（`sandboxPath`）。
    // ⚠️ 它**不是**数据库目录 —— PostgreSQL 的数据在服务端，应用这边没有目录可隔离。
    mkdirSync(dir, { recursive: true })

    current = {
      dir,
      label,
      backend: 'postgres',
      postgresTarget: redactPostgresUrl(url),
    }

    console.log(
      `[sandbox] 本次实验已隔离（PostgreSQL）\n` +
        `[sandbox]   实验库 : ${current.postgresTarget}\n` +
        `[sandbox]   生产库 : data/pglite（PGlite，本次不会被写入）\n` +
        `[sandbox]   ⚠️ 隔离依据是"目标是测试库"，不是目录`
    )
    return current
  }

  // -------------------------------------------------------------------------
  // ② PGlite 分支：既有行为逐字保留
  // -------------------------------------------------------------------------
  // 硬约束：绝不允许指向真实库
  if (isProductionDir(dir)) {
    throw new Error(`拒绝运行：实验目录 ${dir} 与真实库 ${PRODUCTION_DB_DIR} 重叠`)
  }

  process.env.PGLITE_DATA_DIR = dir
  process.env.PROJECT_LG_SANDBOX = dir

  current = { dir, label, backend: 'pglite' }

  console.log(
    `[sandbox] 本次实验已隔离\n` +
      `[sandbox]   实验库 : ${dir}\n` +
      `[sandbox]   真实库 : ${PRODUCTION_DB_DIR}（本次不会被写入）`
  )

  // keep=true 时不自动清理：用于需要跨进程复用同一目录的实验
  // （例如"重启后状态是否还在"要在两个进程间交换状态）。
  // 此时由调用方负责在结束后清理。
  if (!options.keep) {
    process.on('exit', () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响实验结果 */
      }
    })
  }

  return current
}

/** 手动清理某个沙箱目录（keep=true 时由调用方在结束后调用） */
export function cleanupSandbox(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

/**
 * 运行期守卫。会写库的实验在自己的写操作前可以再调一次，
 * 防止隔离被绕过（例如环境变量被外部覆盖）。
 *
 * ⚠️ WP1：**两条分支的判据不同**（这是刻意的）。
 *   · PGlite：读 `PGLITE_DATA_DIR` 是不是真实库目录
 *   · PostgreSQL：读 `POSTGRES_URL` 的目标三元组是不是生产目标 / 带不带测试前缀
 *
 * 旧实现只看 `PGLITE_DATA_DIR` —— 在 PG 后端下那个变量仍然存在（`.env` 里就有），
 * 于是它会**照样通过**。这就是"守的是空气"的形状。
 */
export function assertIsolated(): void {
  const resolution = resolveDatabaseBackend(databaseBackendEnvironmentFrom())

  if (resolution.backend === 'postgres') {
    const decision = postgresIsolationDecision({
      postgresUrl: resolution.postgresUrl,
      productionTarget: process.env.LG_PRODUCTION_POSTGRES_URL,
      testDatabasePrefix: process.env.LG_TEST_DATABASE_PREFIX,
    })
    if (decision.allowed) return
    throw new KernelError(
      'persistence_error',
      decision.denial ?? 'postgres_isolation_not_provided',
      databaseStartupDenialMessage(decision.denial ?? 'postgres_isolation_not_provided', {
        resolution,
        ...(resolution.postgresUrl !== undefined && resolution.postgresUrl !== ''
          ? { redactedTarget: redactPostgresUrl(resolution.postgresUrl) }
          : {}),
      })
    )
  }

  const dir = process.env.PGLITE_DATA_DIR
  if (!dir) {
    throw new Error(
      '数据库目录未设置。会写库的实验必须先调用 isolateDatabase()（见 src/dev/sandbox.ts）。'
    )
  }
  if (isProductionDir(dir)) {
    throw new Error(
      `拒绝运行：目标目录 ${dir} 指向真实对话库 ${PRODUCTION_DB_DIR}。\n` +
        '实验必须在独立副本上运行 —— 见 src/dev/sandbox.ts。'
    )
  }
}

/** 当前沙箱信息（未隔离时为 undefined） */
export function sandboxInfo(): SandboxInfo | undefined {
  return current
}

// ---------------------------------------------------------------------------
// 进程级数据库单例
// ---------------------------------------------------------------------------

/**
 * 关闭一批 PostgreSQL 连接池管理的**纯函数**（WP1）。
 *
 * 抽出来的理由与 `src/db/index.ts` 的其他纯函数相同：**这是唯一能把它测全的办法**。
 * 「旧实现只 clear 不 close」这个缺陷在真环境里不可见（PG 分支从未走过），
 * 但它是可判定的 —— 只要让"关没关"变成一个可观察的返回值。
 *
 * @returns `closed` 成功关闭数 · `failed` 失败数 · `skipped` 没有 close 方法的项数
 */
export async function closePostgresPoolManagers(
  managers: Map<string, unknown>
): Promise<{ closed: number; failed: number; skipped: number }> {
  let closed = 0
  let failed = 0
  let skipped = 0
  for (const manager of managers.values()) {
    const candidate = manager as { close?: () => Promise<void> | void } | null | undefined
    if (typeof candidate?.close !== 'function') {
      skipped += 1
      continue
    }
    try {
      await candidate.close()
      closed += 1
    } catch {
      failed += 1
    }
  }
  return { closed, failed, skipped }
}

/**
 * `@elizaos/plugin-sql` 把 PGlite 客户端缓存在 **`globalThis` 上的进程级单例**里：
 *
 *     globalSingletons.pgLiteClientManager ??= new PGliteClientManager({ dataDir })
 *
 * 也就是说：**一个进程里只有第一个数据库会生效**。之后的
 * `createDatabaseAdapter()` 即使拿到新的 `PGLITE_DATA_DIR`，也只会复用那个
 * 已经打开的旧库。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须显式清掉它
 * ---------------------------------------------------------------------------
 * 实测症状（一次跑多个场景的回归时）：
 *
 *     [SC-002] dir=…-harness-SC-002-…   conversationEvents=86
 *
 * SC-002 只有 2 轮对话，却读到了 86 条事件 —— 因为它读的是 SC-001 的库。
 * 这不是数据串了，而是**隔离根本没生效**，而且失败方式是"看起来在正常工作"。
 *
 * 因此：任何要在同一个进程里隔离**第二个**数据库的地方，
 * 必须先调用本函数（`evals/harness` 就是这么做的）。
 * 单进程单库的脚本不受影响（默认行为不变）。
 */
export const PLUGIN_SQL_SINGLETONS = Symbol.for('@elizaos/plugin-sql/global-singletons')

interface PluginSqlSingletonBag {
  pgLiteClientManager?: {
    close?: () => Promise<void> | void
    isShuttingDown?: () => boolean
  }
  postgresConnectionManagers?: Map<string, unknown>
}

export function pluginSqlSingletons(): PluginSqlSingletonBag | undefined {
  return (globalThis as Record<symbol, unknown>)[PLUGIN_SQL_SINGLETONS] as
    | PluginSqlSingletonBag
    | undefined
}

/**
 * 关闭并清除 plugin-sql 的进程级数据库单例。
 *
 * 必须**先关**再删：PGlite 是嵌入式 Postgres，进程内同时打开两个数据目录
 * 会各自持有自己的 wal / postmaster 状态；不关就换目录会让旧的连接悬空。
 * PostgreSQL 侧同理：`clear()` 只清 Map 的**引用**，池里的连接仍在 ——
 * 那就是"换库了但旧连接还在写旧目标"的形状，也正是计划 §3.2 点名禁止的。
 *
 * ============================================================================
 *  ⚠️ WP1 修掉的两个既有真缺陷（`D12`）
 * ============================================================================
 * 缺陷①：旧实现 `bag.postgresConnectionManagers?.clear()`
 *         **只清引用、不调 `close()`** ⇒ PG 池悬挂。
 *         现在先逐个 `await close()`，关不掉的照实统计（不假装关好了）。
 * 缺陷②：旧实现开头 `if (!bag?.pgLiteClientManager) return false`
 *         ⇒ 在"只有 PG 池、没有 PGlite 管理器"的进程里**整个函数早退**，
 *           连缺陷①那一行都到不了（PG 分支从未走过，所以今天无症状）。
 *         现在两个分支分开判断，互不短路。
 *
 * @returns 是否真的处理掉了一个现存单例（PGlite 管理器**或**任一 PG 池）
 */
export async function resetPluginSqlConnection(): Promise<boolean> {
  const bag = pluginSqlSingletons()
  if (bag === undefined) return false

  let touched = false

  // -------------------------------------------------------------------------
  // ① PGlite 管理器
  // -------------------------------------------------------------------------
  const pglite = bag.pgLiteClientManager
  if (pglite !== undefined) {
    try {
      await pglite.close?.()
    } catch {
      /* 关不掉也要继续清，否则下一个场景会拿到坏连接 */
    }
    delete bag.pgLiteClientManager
    touched = true
  }

  // -------------------------------------------------------------------------
  // ② PostgreSQL 连接池（**缺陷① 的修法：先 close，再 clear**）
  // -------------------------------------------------------------------------
  // ⚠️ 这里**不**用"关不掉就跳过"的写法：关失败只是记下来，
  //    但引用仍然必须清掉，否则下一次 `createDatabaseAdapter()` 会拿到
  //    同一个已 `_closed` 的 manager（上游会重建，但我们要清干净）。
  const managers = bag.postgresConnectionManagers
  if (managers !== undefined && managers.size > 0) {
    const outcome = await closePostgresPoolManagers(managers)
    managers.clear()
    touched = true
    if (outcome.failed > 0) {
      // 如实告知：清掉了引用，但**没有**证明全部关干净。
      // 调用方（门/诊断脚本）应当据此判红，而不是把它当成功。
      console.warn(
        `[sandbox] resetPluginSqlConnection：${outcome.failed} 个 PostgreSQL 池关闭失败；` +
          '引用已清除，但**不能**据此认为连接已释放。'
      )
    }
  }

  return touched
}

/**
 * 断言"当前数据库连接确实指向隔离目录"。
 *
 * `resetPluginSqlConnection()` 是修法，这个是**探针**：
 * 万一上游哪天换了缓存策略、或者有人又加了一条复用路径，
 * 这里会立刻炸出来，而不是等到"某个场景莫名多读了 84 条事件"。
 */
export async function assertConnectedToSandbox(db: {
  execute: (query: unknown) => Promise<unknown>
}): Promise<void> {
  const resolution = resolveDatabaseBackend(databaseBackendEnvironmentFrom())

  // -------------------------------------------------------------------------
  // PostgreSQL：能直接问"我连的是哪个库"（PGlite 问不到目录，PG 问得到库名）
  // -------------------------------------------------------------------------
  if (resolution.backend === 'postgres') {
    const expected = parseDatabaseTarget(resolution.postgresUrl ?? '')?.database
    if (expected === undefined || expected === '') {
      throw new KernelError(
        'persistence_error',
        'postgres_isolation_not_provided',
        '断言失败：后端是 postgres，但连接串里读不出 database 名，无法证明连的是隔离库。'
      )
    }
    const { sql } = await import('drizzle-orm')
    const result = await db.execute(sql`select current_database() as database`)
    const rows = ((result as { rows?: { database?: unknown }[] })?.rows ?? []) as {
      database?: unknown
    }[]
    const actual = rows[0]?.database === undefined ? undefined : String(rows[0].database)
    if (actual !== expected) {
      throw new KernelError(
        'persistence_error',
        'db_identity_mismatch',
        `断言失败：当前连接的实际 database 与隔离目标不符。\n` +
          `  期望：${expected}\n  实际：${actual ?? '(读不到)'}\n` +
          '（很可能复用了进程内上一个连接池；见 resetPluginSqlConnection()。）'
      )
    }
    return
  }

  // -------------------------------------------------------------------------
  // PGlite：既有行为逐字保留
  // -------------------------------------------------------------------------
  const expected = process.env.PGLITE_DATA_DIR
  if (!expected) return

  // PGlite 每次连接都会在数据目录里放 PG_VERSION；用 SQL 拿不到目录路径，
  // 因此这里退一步：只验证"当前连接的库里有我们刚迁移过的表"，
  // 真正的目录一致性由 isolateDatabase + resetPluginSqlConnection 保证。
  const { sql } = await import('drizzle-orm')
  const result = await db.execute(
    sql`select count(*)::int as c from information_schema.tables
        where table_schema = 'public' and table_name = 'character_schema_migrations'`
  )
  const rows = ((result as { rows?: { c: number }[] })?.rows ?? []) as { c: number }[]
  if (Number(rows[0]?.c ?? 0) === 0) {
    throw new Error(
      `数据库隔离校验失败：当前连接里没有 character_schema_migrations 表。\n` +
        `  期望的数据目录：${expected}\n` +
        '  可能原因：plugin-sql 复用了进程内上一个数据库单例，' +
        '需要在打开新库之前调用 resetPluginSqlConnection()。'
    )
  }
}

/** 生成一个本次运行独占的临时文件路径（用于落盘诊断产物） */
export function sandboxPath(name: string): string {
  const base =
    current?.dir ?? mkdtempSync(join(tmpdir(), 'project-lg-exp-unknown-'))
  return join(base, name)
}
