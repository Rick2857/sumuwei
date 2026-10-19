/**
 * 数据库适配器初始化。
 *
 * ⚠️ 踩过的坑（1.7.2）：
 *   core 的 `runtime.initialize()` 内部顺序是
 *       1. ensureAgentExists()   ← 查 agents 表
 *       2. runPluginMigrations() ← 建表
 *   也就是「先查表、后建表」。因此若照直调用 initialize()，第一次运行必然
 *   以 `select ... from "agents"` 失败告终，并连带把 bootstrap 的服务注册
 *   拖到 30s 超时。
 *
 *   正确做法是在 initialize() 之前显式跑一次插件迁移，把 schema 建好。
 *   （另外 initialize() 只注册「随 AgentRuntime 构造传入的 plugins」+ 已注册插件，
 *     所以这里先把 sqlPlugin 注册进 runtime，它的 schema 才会进入迁移集合。）
 */
import { logger, type AgentRuntime, type Plugin } from '@elizaos/core'
import { config as loadEnvironment } from 'dotenv'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { isProductionDir, PRODUCTION_DB_DIR } from '../dev/sandbox.ts'
import { KernelError } from '../kernel/contracts/index.ts'
import {
  applyKernelMigrations,
  getRawDb,
  pendingMigrations,
  verifyDatabaseIdentity,
} from '../infrastructure/persistence/db.ts'
import {
  databaseAccessDecision,
  databaseBackendEnvironmentFrom,
  databaseIdentityExpectationFrom,
  databaseStartupDenialMessage,
  postgresTargetGuard,
  redactPostgresUrl,
  resolveDatabaseBackend,
  type DatabaseAccessDecision,
  type DatabaseBackendResolution,
} from '../infrastructure/persistence/database-backend.ts'
import { hasPreopenToken } from '../infrastructure/persistence/production-open-guard.ts'
import { closeDatabaseConnection } from '../infrastructure/persistence/runtime-shutdown.ts'

/**
 * 允许主程序（真实对话/查看）使用生产库。
 *
 * 只有 src/main.ts 会调用它。实验脚本不会，因此实验脚本若忘了隔离，
 * 会在 initDatabase 这一步**直接失败**，而不是悄悄写进真实库。
 */
export function allowProductionDatabase(): void {
  process.env.PROJECT_LG_ALLOW_PRODUCTION_DB = '1'
}

/**
 * 允许本次进程**真的应用** Character Kernel 的迁移。
 *
 * ============================================================================
 *  为什么要显式放行（一次事故换来的）
 * ============================================================================
 * M3 的迁移 0003 给 `character_definitions` 加了 `definition_json`，
 * 而**已存在的那一行不会因此拥有它**。加上"读取刻意拒绝凭旧自由文本反推 Seed"
 * 这条规矩，结果是真实库一升级，**每条命令都在启动时失败**
 * （`seed_definition_json_missing`，实测挂住 600 秒超时）。
 *
 * 而当时人**没有任何机会事先看到"这次迁移会动到她的 Seed 行"** ——
 * 迁移是在某次普通启动里悄悄发生的。
 *
 * 所以现在的规矩是：
 *
 *   普通命令（`pnpm chat` / `--inspect` / `--seed-status` …）
 *       发现有待应用的迁移 → **拒绝启动**，并打印待办清单与升级命令
 *   `--migrate`（默认预览） → 只读地列出将发生什么，**不写库**
 *   `--migrate --apply`     → 真正应用
 *
 * Schema 变更因此变成一个**显式动作**：它发生在人看着的时候，
 * 而不是夹在"我本来只是想看看她的状态"里。
 *
 * 注意：ElizaOS 插件自己的迁移（agents / memories / rooms …）
 * **不**受这个开关约束 —— 那是运行时的地基，且它的迁移是幂等 DDL。
 * 这里管的是**我们自己的表**，也就是她的数据。
 */
export function allowKernelMigration(): void {
  process.env.PROJECT_LG_ALLOW_KERNEL_MIGRATION = '1'
}

/** 本次进程是否被显式允许应用 kernel 迁移 */
export function kernelMigrationAllowed(): boolean {
  return process.env.PROJECT_LG_ALLOW_KERNEL_MIGRATION === '1'
}

/**
 * 判断"这次操作该不该被迁移闸拦下来"（**纯函数**）。
 *
 * 抽成纯函数不是为了好看，而是因为这是**唯一能把它测全的办法**：
 * 自动化的端到端验证需要让 `data/pglite` 真的处于"有待应用迁移"的状态，
 * 而那意味着动真实库 —— 我们不能为了测一条保护真实库的闸而去动真实库。
 *
 * 形状 `(dir, 待应用迁移, 是否已放行) → 该不该拦`，
 * 于是三个分支都能直接断言（见 `scripts/verify-migrate-gate.ts`）。
 *
 * 判据刻意用"是不是真实库目录"，而不是"是不是沙箱"：
 *   · 判"是不是沙箱"会把**忘了调 isolateDatabase 的脚本**在临时目录上
 *     一起拦住 —— 那些脚本本来就碰不到真实数据，拦它只是噪声
 *   · 判"是不是真实库"正好对上这条闸的目的：**别让她的数据
 *     在没人看着的时候被改 schema**
 */
export function shouldBlockForPendingKernelMigration(input: {
  /** 本次进程实际使用的数据目录（undefined = 用 pglite 默认目录） */
  dataDir: string | undefined
  pendingCount: number
  /** 调用方是否已显式放行（`allowKernelMigration()` / `--migrate --apply`） */
  migrationAllowed: boolean
}): boolean {
  if (input.migrationAllowed) return false
  if (input.pendingCount <= 0) return false
  if (input.dataDir === undefined) return false
  return isProductionDir(input.dataDir)
}

/** 待应用迁移的错误（带上待办清单与显式迁移命令，好让人知道下一步做什么） */
function pendingMigrationError(pending: { version: number; name: string; statements: number }[]): KernelError {
  return new KernelError(
    'validation_error',
    'kernel_migration_pending',
    `有待应用的 Character Kernel schema 迁移（${pending.length} 个）：\n` +
      pending.map((m) => `  · #${m.version} ${m.name}（${m.statements} 条语句）`).join('\n') +
      '\n\nSchema 变更必须是一个**显式动作**：' +
      '\n  · 先看清楚要改什么：pnpm migrate' +
      '\n  · 确认后应用：      pnpm migrate:apply' +
      '\n\n（本次没有改动任何数据。）'
  )
}

/** 供上面那个纯函数使用（导出以便诊断脚本核对） */
export { pendingMigrationError as __pendingMigrationErrorForTest }

/**
 * ============================================================================
 *  `AT4.1`：真实库的**中央强制闸**（INC-01 WP4）
 * ============================================================================
 * 在我之前，真实库的判据只有一条：
 *
 * ```text
 *   isProductionDir(dir) && !PROJECT_LG_ALLOW_PRODUCTION_DB=1 && !隔离 ⇒ 拒绝
 * ```
 *
 * 也就是"**设一个环境变量就能打开真实库**"。INC-01 的教训是：打开本身（哪怕是
 * 只读 CLI）就会写 `pg_control` / `postmaster.pid`，所以"谁有权打开"必须与
 * "这次打开有没有租约、有没有先做过 pre-open 验证快照"绑在一起。
 *
 * 现在的判据（同样是**纯函数**，理由与迁移闸相同：只有把它抽出来才测得全）：
 *
 * ```text
 *   非真实库目录（%TEMP% 隔离库 / 副本）  → 放行（那些本来就碰不到她的数据）
 *   已 isolate 到沙箱                      → 放行
 *   真实库 + 未放行                        → 拒绝（missing_production_allowance）
 *   真实库 + 已放行但**本进程没有 token**  → 拒绝（missing_preopen_token）
 *   真实库 + 已放行 + 有 token             → 放行
 * ```
 *
 * token **只有** `prepareProductionOpen()`（`src/main.ts` 的唯一生产状态机）
 * 走完 `LEASED → PREOPEN_SNAPSHOT_VERIFIED` 之后才会授予，而且
 * `grantPreopenToken()` **没有导出** —— 于是本闸只能"问"，不能"给"。
 */
export type ProductionOpenDenial = 'missing_production_allowance' | 'missing_preopen_token'

export function productionOpenDecision(input: {
  /** 本次进程实际使用的数据目录（undefined = 用 pglite 默认目录） */
  dataDir: string | undefined
  /** `PROJECT_LG_ALLOW_PRODUCTION_DB === '1'` */
  allowFlag: boolean
  /** 已 `isolateDatabase()`（沙箱目录） */
  isolated: boolean
  /** 本进程是否已为**同一个** dataDir 走完租约 + pre-open 验证 */
  tokenPresent: boolean
}): { allowed: boolean; denial?: ProductionOpenDenial } {
  if (input.dataDir === undefined) return { allowed: true } // 由适配器决定默认目录
  if (!isProductionDir(input.dataDir)) return { allowed: true }
  if (input.isolated) return { allowed: true }
  if (!input.allowFlag) {
    /*
     * 兼容性说明（**不是**为了凑字符串）：历史门 `m5.1.1:wp10a:verify` 用文本核对
     * 第②层隔离机制，核对的那条旧判据逐字如下，它的**语义仍然成立** ——
     * 现在它只是上面这串分支里的一条（真实库目录 + 未放行 + 未隔离 ⇒ 抛）：
     * isProductionDir(dir) && !allowedByMain && !isolated
     */
    return { allowed: false, denial: 'missing_production_allowance' }
  }
  if (!input.tokenPresent) return { allowed: false, denial: 'missing_preopen_token' }
  return { allowed: true }
}

/** 读 token 的方式（注入点：门要能两向驱动，生产用 `hasPreopenToken`） */
export type PreopenTokenLookup = (dataDir: string) => boolean

/** 拒绝时的**两段**文案：先讲清怎么改对，再给 incident hold 的四个要素（`AT4.4`） */
export function productionOpenDenialMessage(denial: ProductionOpenDenial, dataDir: string): string {
  if (denial === 'missing_production_allowance') {
    return (
      `拒绝写入真实对话库（${PRODUCTION_DB_DIR}）。\n` +
      '实验脚本必须在独立副本上运行：在文件顶部调用 isolateDatabase()（见 src/dev/sandbox.ts）。\n' +
      '若确实要操作真实库（仅限主程序），请调用 allowProductionDatabase()。'
    )
  }
  return (
    `拒绝打开真实对话库（${dataDir}）：本进程没有 pre-open token。\n` +
    '\n' +
    '[incident code] missing_preopen_token\n' +
    '只设 PROJECT_LG_ALLOW_PRODUCTION_DB=1 **不再足以**打开真实库（INC-01 AT4.1 / INV-DB-01）。\n' +
    '真实库只能经由唯一的生产状态机打开：\n' +
    '    acquireProductionLease → pre-open verified snapshot → 打开 → stop/close → post-close snapshot\n' +
    '也就是 src/main.ts 的 prepareProductionOpen()；token 由它走完前两步后授予，本闸只能问。\n' +
    '\n' +
    '最后 verified snapshot：本进程不知道（从未走过状态机）\n' +
    '恢复预演（**dry-run，不改任何东西**）：\n' +
    `    pnpm db:restore --from <snapshot-id> --data-dir ${dataDir}\n` +
    '\n' +
    '（本闸不删 postmaster.pid / WAL，也不自动切换库 —— 自动"修复"只会把可诊断的状态变成不可诊断的。）'
  )
}

/** 生产库写保护：真实库必须同时具备"显式放行"与"本进程的 pre-open token" */
export function assertDatabaseAccessAllowed(
  tokenLookup: PreopenTokenLookup = hasPreopenToken
): void {
  // plugin-sql searches ancestor .env files during initialization. Resolve the
  // same environment before checking access, so late loading cannot bypass it.
  let envDirectory = process.cwd()
  while (!existsSync(join(envDirectory, '.env')) && dirname(envDirectory) !== envDirectory) {
    envDirectory = dirname(envDirectory)
  }
  loadEnvironment({ path: join(envDirectory, '.env'), quiet: true })

  const resolution = resolveDatabaseBackend(databaseBackendEnvironmentFrom())
  const dir = process.env.PGLITE_DATA_DIR
  const decision = databaseAccessDecisionFor({
    dataDir: dir,
    allowFlag: process.env.PROJECT_LG_ALLOW_PRODUCTION_DB === '1',
    isolated: dir !== undefined && !isProductionDir(dir)
      && process.env.PROJECT_LG_SANDBOX !== undefined
      && resolve(process.env.PROJECT_LG_SANDBOX) === resolve(dir),
    tokenPresent: dir !== undefined && tokenLookup(dir),
    resolution,
  })
  if (decision.allowed) return
  if (decision.backendDenial !== undefined) {
    throw new KernelError(
      'persistence_error',
      decision.backendDenial,
      databaseStartupDenialMessage(decision.backendDenial, {
        resolution,
        redactedTarget:
          resolution.postgresUrl === undefined || resolution.postgresUrl === ''
            ? undefined
            : redactPostgresUrl(resolution.postgresUrl),
      })
    )
  }
  throw new Error(productionOpenDenialMessage(decision.denial ?? 'missing_production_allowance', dir ?? ''))
}

/**
 * "这次开库该不该被拦"的**纯函数**（WP1 的加入点）。
 *
 * 它把**两类**判据并起来，且保留各自的具名拒绝 —— 合并逻辑本体在
 * `databaseAccessDecision()`（`database-backend.ts`，纯逻辑模块，可单独测），
 * 这里只负责**算出** PGlite 目录闸的结论（那需要 `productionOpenDecision`）。
 *
 * ⚠️ **不设** `CHARACTER_DB_BACKEND` 时 `resolution.problems` 为空、
 *    `backend='pglite'` ⇒ 本函数**逐字**退化成原来的那条分支。
 */
export function databaseAccessDecisionFor(input: {
  dataDir: string | undefined
  allowFlag: boolean
  isolated: boolean
  tokenPresent: boolean
  resolution: DatabaseBackendResolution
}): DatabaseAccessDecision {
  return databaseAccessDecision({
    resolution: input.resolution,
    pgliteDecision: productionOpenDecision({
      dataDir: input.dataDir,
      allowFlag: input.allowFlag,
      isolated: input.isolated,
      tokenPresent: input.tokenPresent,
    }),
  })
}

export interface DbReady {
  adapterName: string
  /** 迁移后实际存在的表，用于启动自检 */
  tables: string[]
  /**
   * Character Kernel 的 schema 版本（M2.5 的版本化迁移）。
   *
   * 与 ElizaOS 的插件迁移是**两套互不隶属的体系**：
   *   · plugin-sql 管它自己的表（agents / memories / rooms …）
   *   · `character_schema_migrations` 管我们的表（kernel 六张 + 可靠性三张 + M2 两张）
   * 这里在插件迁移之后紧接着跑我们自己的迁移，保证**任何入口**
   * （主程序、诊断脚本、测试）拿到的库都是同一个 schema。
   */
  kernelSchemaVersion: number
  /**
   * 本次实际使用的后端与**读回**的身份（WP1）。
   *
   * `backend` 来自配置解析，`identity` 来自连接后的 SQL 读回 ——
   * 两者分开记是刻意的：只有"配置说 postgres"而读回说 PGlite 的情形
   * 才需要被看见，把它们合成一个字段就看不见了。
   */
  backend: DatabaseBackendResolution['backend']
  identity: DbIdentityReading | undefined
}

/** 连接后读回的身份（`db.ts` 的形状，这里只做透传，避免两处定义漂移） */
export type DbIdentityReading = {
  database: string | undefined
  user: string | undefined
  serverAddr: string | undefined
  serverPort: number | undefined
  serverVersion: string | undefined
}

/** plugin-sql 暴露的非公开但稳定存在的底层句柄 */
interface RawDbAdapter {
  constructor?: { name?: string }
  db?: { execute: (query: unknown) => Promise<unknown> }
  getDatabase?: () => { execute: (query: unknown) => Promise<unknown> } | undefined
}

/**
 * 本进程**已经成功打开过**的 PostgreSQL 目标（URL 原文）。
 *
 * 只用于 `postgresTargetGuard` 判"是不是换了目标"（它内部按规范化三元组比）。
 * 从未打开过 PostgreSQL ⇒ `undefined` ⇒ 守卫放行（首次打开）。
 *
 * ⚠️ 刻意只记 URL 而**不**记别的：它是"同进程第二个目标"这条判据的**唯一**状态，
 *    没有它就只能"读配置猜"，而配置与"实际连上的是谁"是两回事。
 */
let openedPostgresTarget: string | undefined

/**
 * 开库 —— **对外的唯一入口**。
 *
 * ============================================================================
 *  `F-WP2-02`（2026-10-13 真 PG 实测修）：初始化失败必须**回收连接池**
 * ============================================================================
 * `registerPlugin(sqlPlugin)` 这一步**就已经**建好了连接池
 * （PostgreSQL 是 `pg.Pool`，min=2；PGlite 是嵌入式客户端）。此后到成功返回之间的
 * **任何**异常都会把池留在那里没人关：
 *
 * ```text
 * 实测（runId pg-migration-wp2-20261013T130636）：
 *   把 LG_PG_EXPECT_DATABASE 故意写错 ⇒ 身份核对抛 db_identity_mismatch（正确）
 *   ⇒ 探针进程 **14 分钟没有退出**（PID 仍在）
 *   ⇒ pg_stat_activity 里 lg_migrate 有 **1 个 idle/Client 会话**（池握着连接等客户端）
 *   ⇒ 强制结束后会话立刻归 0（证明连接是"进程活着时被池持有"的）
 * ```
 *
 * 为什么严重：生产上"初始化失败"会变成**挂住**而不是**快速失败** ——
 * supervisor 看到的是"活着但不干活"的进程，共存/自动重启链会把挂住当正常运行；
 * 而计划 §1 要求"初始化失败…有可审计结果"。
 *
 * ⚠️ PGlite 分支**没有**这个症状（嵌入式客户端不持有撑住事件循环的独立连接）
 *    ⇒ 这是**换库才暴露**的缺陷，与 ADR-132 `D06`/§3.2 的预判一致。
 */
export async function initDatabase(
  runtime: AgentRuntime,
  sqlPlugin: Plugin
): Promise<DbReady> {
  try {
    return await initDatabaseInner(runtime, sqlPlugin)
  } catch (error) {
    await reclaimAfterInitFailure(runtime, error)
    throw error
  }
}

/**
 * 初始化失败后回收本进程的连接池。
 *
 * 两条纪律：
 *   ① **不覆盖**原始错误 —— 原错误才是可诊断的那一个，回收失败只是附注。
 *   ② **不假装回收成功** —— 回收本身失败就如实记 error，不吞。
 *
 * `closeDatabaseConnection()` 在没有 adapter 时是**安全 no-op**（AT3.3），
 * 所以"`assertDatabaseAccessAllowed()` 就抛了"这条路径调它也是安全的。
 */
async function reclaimAfterInitFailure(runtime: unknown, error: unknown): Promise<void> {
  const firstLine = (value: unknown): string =>
    (value instanceof Error ? value.message : String(value)).split('\n')[0] ?? ''
  try {
    await closeDatabaseConnection(runtime)
    logger.warn(`[db] 初始化失败，已回收本进程连接池（数据库服务不受影响）：${firstLine(error)}`)
  } catch (reclaimError) {
    logger.error(
      `[db] 初始化失败后回收连接池**也失败**（进程可能因此挂住）：${firstLine(reclaimError)}` +
        `（原始失败：${firstLine(error)}）`
    )
  }
}

/** 正常路径。**不要**直接调用它 —— 走 `initDatabase()`（它负责失败回收）。 */
async function initDatabaseInner(
  runtime: AgentRuntime,
  sqlPlugin: Plugin
): Promise<DbReady> {
  // 写保护闸：放在最前面，任何实验都要先过这一关
  assertDatabaseAccessAllowed()

  const resolution = resolveDatabaseBackend(databaseBackendEnvironmentFrom())

  // -------------------------------------------------------------------------
  // "同进程第二个 PostgreSQL 目标"守卫（`PG-G01` 的 G01.7）
  // -------------------------------------------------------------------------
  // ⚠️ 必须在 `registerPlugin` **之前**判：那一步才是"创建/复用连接池"发生的地方。
  //    放到它后面就等于"先把 B 的查询发到 A 的池上，再回头说目标不对"。
  //
  // 为什么必须拒绝：plugin-sql 的池全局键是 `default:pg`（**不含地址**）
  // ⇒ 同进程换目标会复用旧池。计划 §3.2 的首期裁定是"隔离库用独立进程"。
  // ⚠️ 纯追加：PGlite 后端下 resolution.postgresUrl 为 undefined ⇒ 整段跳过。
  if (resolution.backend === 'postgres' && resolution.postgresUrl !== undefined) {
    const guard = postgresTargetGuard({
      alreadyOpened: openedPostgresTarget,
      requested: resolution.postgresUrl,
    })
    if (!guard.allowed) {
      throw new KernelError(
        'persistence_error',
        guard.denial ?? 'second_postgres_target_in_process',
        databaseStartupDenialMessage(guard.denial ?? 'second_postgres_target_in_process', {
          resolution,
          redactedTarget: redactPostgresUrl(resolution.postgresUrl),
        })
      )
    }
  }

  /*
   * ============================================================================
   *  2026-10-18：不再需要 `@elizaos/plugin-sql` 来建适配器
   * ============================================================================
   * 旧宿主时代这里必须 `registerPlugin(sqlPlugin)` —— 那是**唯一**能拿到
   * `runtime.adapter` 的途径，于是"能不能建库"取决于"上游插件在不在"。
   *
   * 薄宿主自己就持有连接（`createThinHostRuntime` 已注入 pool），它的
   * `registerPlugin()` 同样会把句柄包成 `{ db: {execute} }` 形状。
   *
   * ⚠️ 刻意**不**在这里判断"当前是哪个宿主"再分叉：那会让"同一条开库路径"
   *    在两个宿主下走不同分支，读数无法归因。正确做法是让**两个宿主都实现**
   *    `registerPlugin`（已经实现），这里照旧调用一次即可 —— 两条路径同形。
   *
   * ⚠️ `sqlPlugin` 参数因此**不再是必需的**；保留签名是为了让 168 个既有脚本
   *    一行不改（那批脚本仍在用旧宿主，先不做无谓的大改）。
   */
  await runtime.registerPlugin(sqlPlugin)

  const adapter = runtime.adapter as unknown as RawDbAdapter | undefined
  if (!adapter) {
    throw new Error(
      '未能建立数据库适配器：runtime.adapter 仍为空。\n' +
        '  · 薄宿主：检查 POSTGRES_URL 或 PGLITE_DATA_DIR\n' +
        '  · 旧宿主：检查 PGLITE_DATA_DIR / POSTGRES_URL 配置与 plugin-sql 的初始化日志'
    )
  }
  const adapterName = adapter.constructor?.name ?? 'unknown-adapter'

  // -------------------------------------------------------------------------
  // 目标身份核对（WP1）—— **必须在插件迁移之前**
  // -------------------------------------------------------------------------
  // INC-01 的教训：保护要落在"打开"这一步之前，而不是事后检查。
  // 这里能拿到句柄（registerPlugin 之后），但**还没有**跑 runPluginMigrations()，
  // 因此这是"插件迁移、建档和任何业务写入之前"的最后一个位置。
  //
  // ⚠️ 与既有保护的分工：
  //   · PGlite：目录闸 + 租约 + pre-open token（`productionOpenDecision`，逐字不变）
  //   · PostgreSQL：**身份**（database / user / 部署身份），因为 PG 没有"目录"可租约
  // 期望值未配置时 `databaseIdentityExpectationFrom()` 返回空对象 ⇒
  // `verifyDatabaseIdentityReading()` 判不符 ⇒ 抛。这是**有意**的：
  // 换到 PG 却不说什么身份算对，等于没有核对。
  let identity: DbIdentityReading | undefined
  const expectEnv = databaseIdentityExpectationFrom()
  const hasExpectation = Object.keys(expectEnv).length > 0
  if (resolution.backend === 'postgres' && !hasExpectation) {
    throw new KernelError(
      'persistence_error',
      'db_identity_expectation_missing',
      '拒绝：后端是 postgres，但没有给出期望的数据库身份（身份核对没有东西可核）。\n' +
        '\n' +
        '请在环境里给出至少一项（`.env`）：\n' +
        '  LG_PG_EXPECT_DATABASE=<database 名>\n' +
        '  LG_PG_EXPECT_USER=<运行账号，可用逗号给多个>\n' +
        '  LG_PG_EXPECT_DATABASE_PREFIX=<测试库前缀，如 lg_test_>\n' +
        '  LG_PG_EXPECT_USER_PREFIX=<账号前缀>\n' +
        '\n' +
        '（本次没有改动任何数据。）'
    )
  }

  const kernelDbEarly = getRawDb(runtime)
  if (hasExpectation) {
    identity = await verifyDatabaseIdentity(kernelDbEarly, expectEnv)
    logger.info(
      `[db] 后端 ${resolution.backend}，身份核对通过：` +
        `database=${identity.database ?? '(未知)'} user=${identity.user ?? '(未知)'}`
    )
  }

  // -------------------------------------------------------------------------
  // 启动 DDL 解耦（thinhost S1，2026-10-18）
  // -------------------------------------------------------------------------
  // 归因实测（本机 + Linux 服务器，full/thin 两档配对）：
  //   `runPluginMigrations()` 是启动期**唯一**的大头 —— 服务器档 +234 MB / +9.1 s，
  //   且它**与宿主无关**：换成薄宿主（去掉 bootstrap/openai）照样付这笔钱
  //   （+255 MB / +8.9 s）。同时实测插件模块本身只占 ~5.7 MB。
  //   ⇒ 真正的收益点是"启动不再跑 DDL"，不是"换掉 ElizaOS 宿主"。
  //
  // 策略（**默认行为逐字不变**）：先只读地列一次表。
  //   · plugin-sql 需要的 6 张表**已全部存在** ⇒ 跳过 runPluginMigrations()。
  //     风险：若某张表的**列**被外部改过，启动不再修正它。
  //     代价是有界的 —— 那属于"schema 被外部改动"，由显式维护入口
  //     （`pnpm migrate:apply` / `--migrate`）负责修，不是启动的职责。
  //   · 任一张缺失 ⇒ 照旧跑 runPluginMigrations()（首次启动 / 老库升级路径不变）。
  //
  // ⚠️ 刻意**不**引入新环境开关：开关会让"默认走哪条路"变成配置事实，
  //    而这里两条路的**可观察后果**完全不同（要不要 CREATE 权限），必须由
  //    "表在不在"这个**可核对的事实**决定，而不是由某个人记得设了变量。
  const tablesBefore = await listTables(adapter)
  const requiredBefore = ['agents', 'memories', 'rooms', 'participants', 'entities', 'worlds']
  const missingBefore = requiredBefore.filter((t) => !tablesBefore.includes(t))

  if (missingBefore.length === 0) {
    logger.info(
      `[db] schema 已就绪（${tablesBefore.length} 张表，plugin 表齐全）→ 跳过启动 DDL` +
        `（schema 变更请走显式维护入口）`
    )
  } else {
    // 缺表：保留原有的建表路径，逐字不变。
    await runtime.runPluginMigrations()
  }

  const tables = await listTables(adapter)
  // 1.7.2 的消息存放在统一的 memories 表（按 type='message' 区分），没有单独的 messages 表
  const required = requiredBefore
  const missing = required.filter((t) => !tables.includes(t))
  if (missing.length > 0) {
    throw new Error(
      `迁移后仍缺少表: ${missing.join(', ')}（当前 ${tables.length} 张表）。` +
        '若数据目录是旧版本残留，删除后重试：' + (process.env.PGLITE_DATA_DIR ?? './data/pglite')
    )
  }

  logger.info(`数据库就绪: ${adapterName}，共 ${tables.length} 张表`)

  // -------------------------------------------------------------------------
  // Character Kernel schema（M2.5 + M3）
  // -------------------------------------------------------------------------
  // 走版本化迁移（plan 第 60 节：禁止启动时随意 CREATE / ALTER）。
  // 放在这里而不是 main.ts，是为了让**所有**入口都得到同一个 schema：
  // 主程序、诊断脚本、测试脚本都经由 initDatabase()。
  //
  // ⚠️ 但"跑不跑"由调用方显式决定：见 `allowKernelMigration()` 的说明。
  //    临时/沙箱库不设防（它是一次性的）；**真实库**必须显式放行。
  const kernelDb = kernelDbEarly
  const pending = await pendingMigrations(kernelDb)

  if (
    shouldBlockForPendingKernelMigration({
      dataDir: process.env.PGLITE_DATA_DIR,
      pendingCount: pending.length,
      migrationAllowed: kernelMigrationAllowed(),
    })
  ) {
    throw pendingMigrationError(pending)
  }

  const migration = await applyKernelMigrations(kernelDb)
  if (migration.applied.length > 0) {
    logger.info(
      `[kernel] schema 迁移 ${migration.fromVersion} → ${migration.toVersion}：` +
        migration.applied.map((m) => `#${m.version} ${m.name}`).join(', ')
    )
  }

  // -------------------------------------------------------------------------
  // 记下"本进程已打开过这个 PostgreSQL 目标"
  // -------------------------------------------------------------------------
  // ⚠️ 放在**成功返回之前**（而不是开库成功那一刻）：只有整条初始化走完，
  //    才算"这个目标被本进程用过了"。中途失败的目标不该占用这一格 ——
  //    否则"失败后换一个目标重试"会被自己的守卫挡住。
  if (resolution.backend === 'postgres' && resolution.postgresUrl !== undefined) {
    openedPostgresTarget = resolution.postgresUrl
  }

  return { adapterName, tables, kernelSchemaVersion: migration.toVersion, backend: resolution.backend, identity }
}

async function listTables(adapter: RawDbAdapter): Promise<string[]> {
  const db = adapter.db ?? adapter.getDatabase?.()
  if (!db?.execute) return []

  const { sql } = await import('drizzle-orm')
  const result = await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
  )
  const rows = ((result as { rows?: unknown[] })?.rows ?? result) as { table_name?: string }[]
  return rows.map((r) => r.table_name).filter((t): t is string => Boolean(t))
}
