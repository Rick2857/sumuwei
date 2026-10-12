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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

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
  /** 本次运行独占的数据目录 */
  dir: string
  label: string
}

let current: SandboxInfo | undefined

/** 同一进程内的隔离序号：防止同一毫秒内的两次 isolateDatabase 撞目录 */
let isolationCounter = 0

/**
 * 建立一次性数据库副本。
 *
 * @param label   脚本标识，出现在临时目录名里，便于排查
 * @param options.runId 固定运行标识（同一 id 会复用目录，用于需要跨进程续跑的实验）
 */
export function isolateDatabase(
  label: string,
  options: { runId?: string; keep?: boolean } = {}
): SandboxInfo {
  isolationCounter += 1
  // ⚠️ 目录名必须**每次调用都不同**：
  //   早期只用 `Date.now()`，同一个进程内连续隔离两个库（例如场景回归逐个跑
  //   SC-001…SC-007）会拿到同一个目录，于是第二个场景直接看到了第一个场景的
  //   对话与领域事件——不是数据串了，而是**根本没隔离**。
  //   实测症状：`预期 2 条助手事件，实际 25`。
  const runId = options.runId ?? `${Date.now()}-${isolationCounter}`
  const dir = join(tmpdir(), `project-lg-exp-${label}-${runId}`)

  // 硬约束：绝不允许指向真实库
  if (isProductionDir(dir)) {
    throw new Error(`拒绝运行：实验目录 ${dir} 与真实库 ${PRODUCTION_DB_DIR} 重叠`)
  }

  process.env.PGLITE_DATA_DIR = dir
  process.env.PROJECT_LG_SANDBOX = dir

  current = { dir, label }

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
 */
export function assertIsolated(): void {
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
 *
 * @returns 是否真的清掉了一个现存单例
 */
export async function resetPluginSqlConnection(): Promise<boolean> {
  const bag = pluginSqlSingletons()
  if (!bag?.pgLiteClientManager) return false

  try {
    await bag.pgLiteClientManager.close?.()
  } catch {
    /* 关不掉也要继续清，否则下一个场景会拿到坏连接 */
  }
  delete bag.pgLiteClientManager
  bag.postgresConnectionManagers?.clear()
  return true
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
  const base = current?.dir ?? mkdtempSync(join(tmpdir(), 'project-lg-exp-unknown-'))
  return join(base, name)
}
