/**
 * INC-01 WP3 —— **唯一的收尾路径**（`stop → close → closed check`）。
 *
 * ============================================================================
 *  它存在的原因（事故报告 §"三个结构性缺口" 的第三个）
 * ============================================================================
 * ```text
 *   ③ `runtime.stop()` 只停 services，**不关**数据库连接，
 *      于是每次退出都留脏状态。
 * ```
 * 在这之前，`src/main.ts` 里有十几处各自 `await runtime.stop()`：它们分布在不同分支，
 * 谁都不负责"把连接关掉"，也没有任何地方能回答"这次退出到底关干净了没有"。
 *
 * ============================================================================
 *  四条判据（计划书 §WP3 `AT3.1`）
 * ============================================================================
 * 1. **顺序固定**：`stop → close → closed check`。**stop 失败也要继续 close** ——
 *    停服务失败不该连累关库（否则"一个 provider 卡住"会变成"库没关"）。
 * 2. **只执行一次**：多次调用复用**同一个 Promise**，因此信号与 `finally`
 *    不会双关（双关在某些适配器上会抛，且掩盖真实原因）。
 * 3. **closed 是问出来的**：只有 `closed === true` 才算"关干净"。
 *    适配器没有暴露这个标志时**如实报 false**（失败关闭），
 *    绝不因为"close() 没抛"就宣称已关闭。
 * 4. **永不抛**：收尾路径抛错会掩盖原始错误、并可能改变退出码。
 *    它把失败记进读数里，让调用方去决定退出码。
 *
 * ⚠️ 依赖是**注入**的：这样验收门能注入"stop 失败 / close 失败 / closed 永远 false"
 *    三种故障，而不需要真的把 PGlite 弄坏。
 */

/** 一次收尾的**读数**（进证据；不是"成功/失败"的布尔，而是每一步各发生了什么） */
export interface ShutdownReading {
  /** `stop` 被真正调用过几次（幂等 ⇒ 正常路径恒为 1） */
  stopCalls: number
  /** `close` 被真正调用过几次 */
  closeCalls: number
  /** `isClosed` 被问过几次（**它是判据，不是可选步骤**） */
  closedCheckCalls: number
  stopFailed: boolean
  closeFailed: boolean
  /** 最后一次问出来的结论；**只有 true 才算关干净** */
  closed: boolean
  /** 一条人能读的说明（进日志与证据） */
  note: string
}

/**
 * 收尾读数 ⇒ 退出码（**单一策略**，`main.ts` 与验收门共用同一份）。
 *
 * 计划书 §WP3 的判据："注入 stop 失败：close 仍执行，**最终非零**"。
 * 于是"什么算收尾失败"只有一处定义：
 * ```text
 *   stopFailed  || closeFailed  || !closed   ⇒ 1
 *   其余                                       ⇒ 0
 * ```
 * 注意 `closed === false` 也算失败 —— 它是**判据**而不是装饰（判据 3）。
 */
export function shutdownExitCode(reading: ShutdownReading | undefined): 0 | 1 {
  if (reading === undefined) return 0
  return reading.stopFailed || reading.closeFailed || !reading.closed ? 1 : 0
}

export interface ShutdownDeps {
  /** 停服务（ElizaOS runtime.stop） */
  stop: () => Promise<void>
  /** 关数据库连接；**没有连接时要安全 no-op** */
  close: () => Promise<void>
  /** 问"关干净了吗"。返回 `false`/抛错 ⇒ 判为未关闭（失败关闭） */
  isClosed: () => boolean | Promise<boolean>
  /**
   * INC-01 WP4（`AT4.3`）：收尾读数算出来**之后**的钩子。
   *
   * 生产状态机（`production-open-guard.ts`）需要"关干净了吗"这个**结论**才能决定
   * 要不要做 post-close 快照并释放租约。钩子被刻意放在判据之后：
   *   · 它拿到的是读数的**副本** ⇒ 改不动已经定稿的判据（`stopFailed` / `closeFailed` / `closed`）；
   *   · 它**抛出也不会**改变退出码（这里是 fail-closed 的**额外**动作，
   *     不是收尾本身的判据）。
   */
  afterRun?: (reading: ShutdownReading) => Promise<void> | void
}

export interface ShutdownHandle {
  /** 幂等：第一次调用真的执行，后续调用复用同一个 Promise */
  shutdown: () => Promise<ShutdownReading>
  /** 已经产生的读数（还没跑过 ⇒ undefined）；**不触发**收尾 */
  reading: () => ShutdownReading | undefined
}

export function createShutdown(deps: ShutdownDeps): ShutdownHandle {
  let pending: Promise<ShutdownReading> | undefined
  let latest: ShutdownReading | undefined

  const run = async (): Promise<ShutdownReading> => {
    const reading: ShutdownReading = {
      stopCalls: 0,
      closeCalls: 0,
      closedCheckCalls: 0,
      stopFailed: false,
      closeFailed: false,
      closed: false,
      note: '',
    }
    const notes: string[] = []

    // ① stop：失败**不中断**（判据 1）
    reading.stopCalls += 1
    try {
      await deps.stop()
      notes.push('stop=ok')
    } catch (error) {
      reading.stopFailed = true
      notes.push(`stop=failed(${error instanceof Error ? error.message : String(error)})`)
    }

    // ② close：无论如何都执行
    reading.closeCalls += 1
    try {
      await deps.close()
      notes.push('close=ok')
    } catch (error) {
      reading.closeFailed = true
      notes.push(`close=failed(${error instanceof Error ? error.message : String(error)})`)
    }

    // ③ closed check：判据，不是装饰
    reading.closedCheckCalls += 1
    try {
      reading.closed = (await deps.isClosed()) === true
      notes.push(`closed=${String(reading.closed)}`)
    } catch (error) {
      reading.closed = false
      notes.push(`closed=unknown(${error instanceof Error ? error.message : String(error)})`)
    }

    reading.note = notes.join(' · ')
    latest = reading

    /*
     * ④ 钩子（`AT4.3`）：读数已经定稿，钩子只做**后续动作**。
     * 它抛出时只记一条 note —— 收尾路径"永不抛"（判据 4）在这里同样成立。
     */
    if (deps.afterRun !== undefined) {
      try {
        /*
         * 传**副本**：钩子即便改了它也改不到已定稿的读数 ——
         * "后续动作不得改写判据"这件事由**代码**保证，而不是由约定保证。
         */
        await deps.afterRun({ ...reading })
      } catch (error) {
        reading.note = `${reading.note} · afterRun=failed(${error instanceof Error ? error.message : String(error)})`
      }
    }

    return reading
  }

  return {
    shutdown: (): Promise<ShutdownReading> => {
      if (pending === undefined) pending = run()
      return pending
    },
    reading: (): ShutdownReading | undefined => latest,
  }
}

// ---------------------------------------------------------------------------
// 真实接线：从 AgentRuntime 拿到可关闭的数据库客户端
// ---------------------------------------------------------------------------

/**
 * plugin-sql 暴露的非公开但稳定存在的底层句柄。
 *
 * ⚠️ **INC-01 WP4 实测修正**（这条以前是错的，所以单独写出来）：
 * `runtime.adapter` 是 `PgliteDatabaseAdapter`，它的 `db` / `getDatabase()` 返回的是
 * **drizzle 包装对象**（`PgliteDatabase`），那个对象**既没有 `close` 也没有 `closed`**。
 * 于是旧实现里
 * ```text
 *   closeDatabaseConnection(runtime)  → 静默 no-op（typeof client.close !== 'function' 直接 return）
 *   isDatabaseClosed(runtime)         → 永远 false
 * ```
 * 后者会让**每一次干净退出都判成"没关"**（退出码 1），前者会让"关连接"这件事根本没发生。
 * 真正的连接在 `adapter.manager.getConnection()` 后面（PGlite 客户端：有 `close()` 与 `closed`）。
 */
interface ClosableDbClient {
  close?: () => Promise<void>
  closed?: boolean
  /**
   * `pg.Pool`（node-postgres 的 `pg-pool`）：**只在所有 client 都释放之后**才置 true。
   *
   * 源码依据（`pg-pool@3.14.0` 的 `_pulseQueue`）：`this.ending` 在 `end()` 被调用时立刻置 true；
   * 而 `this.ended` 只在 `this._clients.length === 0` 那一支里才置 true。
   * ⇒ `ended` 才是"池真的空了"，`ending` 只是"正在关"。
   */
  ended?: boolean
  /**
   * `pg.Pool`：`end()` 被调用后**立刻**置 true = **关闭进行中**。
   *
   * ⚠️ 刻意把它读出来**只是**为了能显式地**不**用它当"已关闭"的判据 ——
   *    那正是计划 §3.2 警告的"仅凭管理器预先设置的 closed 标记宣布关闭成功"。
   */
  ending?: boolean
}

interface RawAdapter {
  db?: ClosableDbClient
  getDatabase?: () => ClosableDbClient | undefined
  /** `PgliteDatabaseAdapter`：真正的连接挂在它后面 */
  manager?: {
    getConnection?: () => ClosableDbClient | undefined
    isShuttingDown?: () => boolean
  }
  close?: () => Promise<void>
  closed?: boolean
}

function adapterOf(runtime: unknown): RawAdapter | undefined {
  const adapter = (runtime as { adapter?: RawAdapter }).adapter
  if (adapter === undefined || adapter === null) return undefined
  return adapter
}

/** 真正的**连接对象**（只有它会如实暴露 `closed`） */
function connectionOf(runtime: unknown): ClosableDbClient | undefined {
  const adapter = adapterOf(runtime)
  if (adapter === undefined) return undefined
  const viaManager = adapter.manager?.getConnection?.()
  if (viaManager !== undefined && viaManager !== null) return viaManager
  const viaGetter = adapter.getDatabase?.()
  if (viaGetter !== undefined && viaGetter !== null) return viaGetter
  return adapter.db ?? undefined
}

/**
 * AT3.3：**没有 adapter 时安全 no-op**。
 *
 * 它同时覆盖两件真实情况：
 *   · `buildRuntime()` 在 adapter 建好之前就失败（`runtime.adapter` 为空）
 *   · 某些只读命令根本没有注册 sql 插件
 *
 * 关闭顺序：先走 **adapter 自己的 `close()`**（plugin-sql 的受支持路径，
 * 它会顺带处理 manager 的状态），失败再退到连接对象自己的 `close()`。
 */
export async function closeDatabaseConnection(runtime: unknown): Promise<void> {
  const adapter = adapterOf(runtime)
  if (adapter === undefined) return

  const closers: (() => Promise<void>)[] = []
  if (typeof adapter.close === 'function') {
    const close = adapter.close.bind(adapter)
    closers.push(() => close())
  }
  const connection = connectionOf(runtime)
  if (connection !== undefined && connection !== adapter && typeof connection.close === 'function') {
    const close = connection.close.bind(connection)
    closers.push(() => close())
  }
  if (closers.length === 0) return

  let firstError: unknown
  for (const close of closers) {
    try {
      await close()
      return
    } catch (error) {
      firstError ??= error
    }
  }
  throw firstError
}

/**
 * 问"数据库关干净了吗"。
 *
 * ⚠️ 失败关闭：**问不到 `closed`/`ended` 就报 false**（而不是"close 没抛就算关好"）。
 * 这一条是刻意选的：本次事故的教训正是"看起来完成了，其实没有"。
 *
 * ============================================================================
 *  `F-WP2-01`（2026-10-13 真 PG 实测修）：PostgreSQL 分支
 * ============================================================================
 * 旧实现只认 PGlite 的形状（`connection.closed` / `adapter.closed`）。而 PostgreSQL 下：
 *
 * ```text
 *   connection = adapter.manager.getConnection() = pg.Pool
 *   pg.Pool **没有** `.closed`（`pg-pool` 全文 `this.closed` 命中 0）
 *   PostgresConnectionManager 暴露的是 isClosed()（方法）与 _closed（私有）
 *   ⇒ 两个分支都取不到 ⇒ 落到 return false
 * ```
 *
 * 实测后果（`artifacts/post-lv2/postgresql-migration/pg-migration-wp2-20261013T130636/
 * real-postgres-init.json`）：池**真的**关了（`pg_stat_activity` 里 `lg_migrate` 会话数 = 0），
 * 而本函数返回 `false` ⇒ **假阴性**。方向是安全的（失败关闭），但"关闭是问出来的"
 * 这句在 PG 上答不出来。
 *
 * **修法用的是 `pool.ended`，不是 `pool.ending`、也不是管理器的 `_closed`**：
 *   · `ended`   —— 只在所有 client 释放之后才 true ⇒ 这才是"关干净了"
 *   · `ending`  —— `end()` 一调用就 true ⇒ 拿它当"已关闭"会得到**假阳性**
 *   · `_closed` —— `PostgresConnectionManager.close()` 里**先置标记再 await pool.end()**
 *                  ⇒ 同样会在"关还没完成"时报已关闭（ADR-132 `D06` 明确不许这么用）
 */
export function isDatabaseClosed(runtime: unknown): boolean {
  const adapter = adapterOf(runtime)
  if (adapter === undefined) return true // 没有连接 ⇒ 没有"没关的连接"

  const connection = connectionOf(runtime)
  // ① PGlite：客户端自己的 closed（既有判据，逐字保留）
  if (connection !== undefined && typeof connection.closed === 'boolean') return connection.closed
  // ② PostgreSQL：pg.Pool 的 ended（只在池空之后为 true）。
  //    ⚠️ 顺序在 ① 之后是刻意的：PGlite 客户端**没有** ended，pg.Pool **没有** closed，
  //       两个分支互不干扰。
  if (connection !== undefined && typeof connection.ended === 'boolean') return connection.ended
  // ③ 兜底：adapter 自己的 closed（既有判据，逐字保留）
  if (typeof adapter.closed === 'boolean') return adapter.closed
  // ④ 问不到任何"已关闭"的凭证 ⇒ 失败关闭
  return false
}

/**
 * 停服务（ElizaOS `runtime.stop`）—— **唯一实现**。
 *
 * INC-01 WP4 的生产状态机也把它当作 `stopServices` 注入点，
 * 于是"裸 `runtime.stop()`"只存在于**这一个文件**里：
 * WP3 门 §3-1 会扫真实 opener 里有没有别的地方"只 stop 不 close"。
 */
export async function stopRuntimeServices(runtime: unknown): Promise<void> {
  const candidate = runtime as { stop?: () => Promise<void> }
  if (typeof candidate.stop === 'function') await candidate.stop()
}

/** 把 `AgentRuntime` 接成收尾 helper（生产唯一入口） */
export function createRuntimeShutdown(
  runtime: unknown,
  options: { afterRun?: (reading: ShutdownReading) => Promise<void> | void } = {}
): ShutdownHandle {
  return createShutdown({
    stop: async () => await stopRuntimeServices(runtime),
    close: async () => await closeDatabaseConnection(runtime),
    isClosed: () => isDatabaseClosed(runtime),
    ...(options.afterRun !== undefined ? { afterRun: options.afterRun } : {}),
  })
}
