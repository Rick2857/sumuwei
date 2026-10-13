/**
 * 单认知执行者资格（WP3 / ADR-132 `D05`）。
 *
 * ============================================================================
 *  为什么需要它（计划 §3.2 的那句话）
 * ============================================================================
 *  PostgreSQL 的**并发连接不自动提供"同一角色只有一个认知执行者"**。
 *  连接池让很多进程都能连上；能连上 ≠ 有资格写。
 *
 *  而且计划 §3.2 逐字写着：
 *
 *  > **获取一次 advisory lock 不构成完整失效保护**。
 *
 *  也就是说："我拿到锁了"这件事**必须**能由**可观测事件**推翻，
 *  否则一个被网络分区隔开的旧核心会以为它还持有资格，继续往库里写。
 *
 * ---------------------------------------------------------------------------
 *  资格的形状
 * ---------------------------------------------------------------------------
 * ```text
 *   一个**专用连接**（不是"借一个还回去"）+ 该连接上的 session 级 advisory lock
 *   + 记录在案的 (pg_backend_pid, generation)
 * ```
 *
 *  取得：`pg_try_advisory_lock` —— 拿不到就**具名拒绝**，
 *        **不等待、不重试、不"试着跑跑看"**（那三种都会让"第二个核心"变成慢慢发生的事）。
 *
 *  失效（三条，全部**可观测**）：
 *    ① 专用连接 `error` / `end` 事件 ⇒ 立即撤销
 *    ② 同连接上读回的 `pg_backend_pid` 与取得时不一致 ⇒ 视为已失效
 *    ③ 每次落账前的轻量核对失败 ⇒ 撤销
 *
 *  撤销后：停止接收新轮次、取消未提交工作、保留已提交事实；
 *         **绝不**"再试一次拿锁"或"另开一个核心碰碰运气"。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ lockId 的派生**刻意**与 plugin-sql 的迁移锁不同源
 * ---------------------------------------------------------------------------
 *  plugin-sql（`dist/node/index.node.js` 的 `getAdvisoryLockId`）：
 *
 * ```text
 *   sha256(pluginName) → 取 **前 8 字节** → BigInt → & 0x7fff…（63 位）→ 0 则 1
 * ```
 *
 *  它锁的是"**迁移互斥**"，本模块锁的是"**认知执行者资格**" —— 两者的域没关系。
 *  若复用同一派生，会出现"迁移在跑"与"核心在跑"互相锁住。
 *
 *  ⇒ 本模块**同时**改两处，让碰撞在构造上不可能：
 *    ① 输入带专属前缀：`lg:single-core:v1:<角色>`（插件名不可能长这样）
 *    ② 取 sha256 的**第 8…16 字节**（plugin-sql 取的是 0…8）
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 本模块**不 import `pg`**
 * ---------------------------------------------------------------------------
 *  `pg` 在本仓库**不是根依赖**（由 plugin-sql 的依赖图提供）⇒ 直接 import 会
 *  `ERR_MODULE_NOT_FOUND`（WP0 实测）。因此这里用**结构化类型**描述它需要的那几样，
 *  与 `RawDb` 的既有做法同源。
 */

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// 纯函数部分（可单独测）
// ---------------------------------------------------------------------------

/** 资格被拒的**具名**原因 */
export type SingleCoreDenial =
  /** 锁被别人持有（第二个核心） */
  | 'lock_not_acquired'
  /** 拿不到底层连接 */
  | 'no_connection'
  /** `pool.connect()` 本身失败 */
  | 'client_acquire_failed'
  /** 拿不到本连接的 pg_backend_pid（拿不到就无法做"同连接"判据） */
  | 'backend_pid_unavailable'

/** 资格失效的**具名**原因（全部来自可观测事件） */
export type SingleCoreInvalidationReason =
  /** 专用连接报了 error */
  | 'connection_error'
  /** 专用连接 end 了 */
  | 'connection_ended'
  /** 同连接上读回的 pg_backend_pid 与取得时不一致 */
  | 'backend_pid_changed'
  /** 连接被归还/释放（不该发生，但发生了就必须撤销资格） */
  | 'client_released'
  /** 轻量核对本身失败（查不出来 ⇒ 不能假设还持有） */
  | 'verify_failed'

/** 资格锁的命名空间前缀（与插件名空间**构造上不相交**） */
export const SINGLE_CORE_LOCK_NAMESPACE = 'lg:single-core:v1'

/**
 * 由角色 id 派生 advisory lock 的 id。
 *
 * 两处与 plugin-sql **刻意不同**（见文件头注释）：
 *   ① 输入 = `<命名空间>:<角色>`（插件名不可能长这样）
 *   ② 取 sha256 的**第 8…16 字节**（plugin-sql 取 0…8）
 *
 * 返回**十进制字符串**：`pg_try_advisory_lock` 的参数在 SQL 里按 `::bigint` 解析，
 * 而 JS 的 number 放不下 63 位 ⇒ 全程用字符串，不在 JS 侧做数值运算。
 */
export function singleCoreLockId(characterId: string): string {
  const digest = createHash('sha256').update(`${SINGLE_CORE_LOCK_NAMESPACE}:${characterId}`).digest()
  const slice = digest.subarray(8, 16)
  let value = BigInt(`0x${slice.toString('hex')}`) & 0x7fffffffffffffffn
  if (value === 0n) value = 1n
  return value.toString()
}

/**
 * "同连接"判据（纯函数）。
 *
 * 取得资格时记下 `pg_backend_pid`；此后每次核对都要求**同一个值**。
 * 不一致意味着这条连接已经不是原来那条了（池换过、代理换过、连接被重连过）
 * ⇒ 那条连接上的 session advisory lock **已经不在**（PG 的 session 锁随会话消失）。
 */
export function isSameBackendSession(
  expected: number | undefined,
  actual: number | undefined
): boolean {
  if (expected === undefined || actual === undefined) return false
  return expected === actual
}

// ---------------------------------------------------------------------------
// 它需要的那几样（结构化类型，不 import pg）
// ---------------------------------------------------------------------------

export interface DedicatedClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  release?: (error?: unknown) => void
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}

export interface DedicatedPool {
  connect: () => Promise<DedicatedClient>
  /** 池级错误（可选）：有的话也接上 —— 池报错同样意味着"不能再假设还持有" */
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}

// ---------------------------------------------------------------------------
// 资格句柄
// ---------------------------------------------------------------------------

export interface SingleCoreQualification {
  readonly acquired: boolean
  readonly denial?: SingleCoreDenial
  /** 取得资格时那条专用连接的 `pg_backend_pid` */
  readonly backendPid?: number
  /** 代次（同一进程内每次取得递增）—— 用于区分"同一个进程重新取得" */
  readonly generation: number
  /** 锁 id（十进制字符串，便于日志与对账） */
  readonly lockId?: string
  /** 资格是否仍有效（由**可观测事件**判定；不查库） */
  isHeld: () => boolean
  /** 失效原因（若已失效） */
  readonly invalidationReason?: SingleCoreInvalidationReason
  /**
   * 落账前的**轻量核对**：在同一条连接上读回 `pg_backend_pid` 并比对。
   *
   * ⚠️ 它只证明"这条连接还是原来那条"。它**不**证明"数据库认为我还持锁"——
   *    但 PG 的 session advisory lock 随会话消失，所以"连接还是那条"蕴含"锁还在"。
   *    这条推理的边界写在 Known-Limitations 里（见 `L-PGW3-05`）。
   */
  verifyStillHeld: () => Promise<boolean>
  /** 主动释放（正常关闭时用）。释放后 `isHeld()` 为 false。 */
  release: () => Promise<void>
}

export interface AcquireOptions {
  pool: DedicatedPool | undefined
  characterId: string
  /** 代次由调用方给（进程内单调递增） */
  generation: number
  /** 观测回调（可选）：失效发生时被叫一次 —— 调用方据此停止接收新轮次 */
  onInvalidated?: (reason: SingleCoreInvalidationReason) => void
}

/**
 * 取得资格。
 *
 * **不等待、不重试**：`pg_try_advisory_lock` 拿不到就是拿不到，
 * 直接返回具名拒绝（"第二个核心被拒"必须是一个**立刻发生**的事实）。
 */
export async function acquireSingleCoreQualification(
  options: AcquireOptions
): Promise<SingleCoreQualification> {
  const lockId = singleCoreLockId(options.characterId)
  const generation = options.generation

  if (options.pool === undefined) {
    return denied('no_connection', lockId, generation)
  }

  let client: DedicatedClient
  try {
    client = await options.pool.connect()
  } catch {
    return denied('client_acquire_failed', lockId, generation)
  }

  // -------------------------------------------------------------------------
  // 失效状态（闭包内的唯一真相）
  // -------------------------------------------------------------------------
  let invalidReason: SingleCoreInvalidationReason | undefined
  const invalidate = (reason: SingleCoreInvalidationReason): void => {
    if (invalidReason !== undefined) return // 首次原因保留，不覆盖
    invalidReason = reason
    try {
      options.onInvalidated?.(reason)
    } catch {
      /* 观测回调抛错不影响"已经失效"这个事实 */
    }
  }

  const onClientError = (): void => invalidate('connection_error')
  const onClientEnd = (): void => invalidate('connection_ended')
  client.on?.('error', onClientError)
  client.on?.('end', onClientEnd)
  const onPoolError = (): void => invalidate('connection_error')
  options.pool.on?.('error', onPoolError)

  const detach = (): void => {
    client.removeListener?.('error', onClientError)
    client.removeListener?.('end', onClientEnd)
    options.pool?.removeListener?.('error', onPoolError)
  }

  const releaseClient = (): void => {
    detach()
    try {
      client.release?.()
    } catch {
      /* 释放失败不影响"资格已撤销" */
    }
  }

  // -------------------------------------------------------------------------
  // 取锁
  // -------------------------------------------------------------------------
  try {
    const locked = await client.query('select pg_try_advisory_lock($1::bigint) as acquired', [lockId])
    const acquired = readFirstRow(locked)?.acquired === true
    if (!acquired) {
      releaseClient()
      return denied('lock_not_acquired', lockId, generation)
    }
  } catch {
    releaseClient()
    return denied('client_acquire_failed', lockId, generation)
  }

  // -------------------------------------------------------------------------
  // 记下本连接的 pg_backend_pid（"同连接"判据的基准）
  // -------------------------------------------------------------------------
  let backendPid: number | undefined
  try {
    const pidRow = await client.query('select pg_backend_pid() as pid')
    const raw = readFirstRow(pidRow)?.pid
    backendPid = raw === undefined || raw === null ? undefined : Number(raw)
  } catch {
    backendPid = undefined
  }
  if (backendPid === undefined || Number.isNaN(backendPid)) {
    // 拿不到 pid 就无法做"同连接"判据 ⇒ 不能假装持有 ⇒ 放锁并具名拒绝
    try {
      await client.query('select pg_advisory_unlock($1::bigint)', [lockId])
    } catch {
      /* 放不掉也要走"拒绝"这条路 */
    }
    releaseClient()
    return denied('backend_pid_unavailable', lockId, generation)
  }

  const held = (): boolean => invalidReason === undefined

  return {
    acquired: true,
    backendPid,
    generation,
    lockId,
    isHeld: held,
    get invalidationReason(): SingleCoreInvalidationReason | undefined {
      return invalidReason
    },
    verifyStillHeld: async (): Promise<boolean> => {
      if (!held()) return false
      try {
        const row = await client.query('select pg_backend_pid() as pid')
        const raw = readFirstRow(row)?.pid
        const actual = raw === undefined || raw === null ? undefined : Number(raw)
        if (!isSameBackendSession(backendPid, actual)) {
          invalidate('backend_pid_changed')
          return false
        }
        return true
      } catch {
        invalidate('verify_failed')
        return false
      }
    },
    release: async (): Promise<void> => {
      if (held()) {
        try {
          await client.query('select pg_advisory_unlock($1::bigint)', [lockId])
        } catch {
          /* 放锁失败：连接即将释放，session 锁随会话消失 */
        }
      }
      invalidate('client_released')
      releaseClient()
    },
  }
}

function denied(
  denial: SingleCoreDenial,
  lockId: string,
  generation: number
): SingleCoreQualification {
  return {
    acquired: false,
    denial,
    generation,
    lockId,
    isHeld: () => false,
    verifyStillHeld: async () => false,
    release: async () => undefined,
  }
}

function readFirstRow(result: { rows: unknown[] }): Record<string, unknown> | undefined {
  const first = result.rows[0]
  if (first === undefined || first === null) return undefined
  return first as Record<string, unknown>
}

/**
 * 从运行时句柄里取出"那个连接池"。
 *
 * 形状与 `runtime-shutdown.ts` 的 `connectionOf()` 同源：真正的连接挂在
 * `adapter.manager.getConnection()` 后面（PGlite 是嵌入式客户端，PostgreSQL 是 `pg.Pool`）。
 *
 * ⚠️ 这里**只**接受"看起来像 Pool 的东西"（有 `connect` 方法）：
 *    PGlite 的嵌入式客户端**没有** `connect` ⇒ 返回 undefined ⇒ 调用方据此知道
 *    "这个后端没有池"，从而不去取得资格（PGlite 是单进程嵌入式，资格概念不适用）。
 */
export function dedicatedPoolOf(holder: unknown): DedicatedPool | undefined {
  const candidate = (
    holder as { adapter?: { manager?: { getConnection?: () => unknown } } } | undefined
  )?.adapter?.manager?.getConnection?.()
  if (candidate === undefined || candidate === null) return undefined
  const pool = candidate as DedicatedPool
  return typeof pool.connect === 'function' ? pool : undefined
}

/** 人读的拒绝文案（先讲清怎么改对，再给事实） */
export function singleCoreDenialMessage(denial: SingleCoreDenial, characterId: string): string {
  switch (denial) {
    case 'lock_not_acquired':
      return (
        `拒绝成为认知执行者：角色 ${characterId} 的资格锁已被另一个核心持有。\n` +
        '\n' +
        '同一角色**首期只允许一个认知执行者**（计划 §3.2）。本进程**不会**等待、重试、\n' +
        '也不会"试着跑跑看" —— 那三种做法都会让"第二个核心"变成慢慢发生的事。\n' +
        '若确认前一个核心已停止，请先确认它的连接已释放，再启动本进程。\n' +
        '\n' +
        '（只读查询与备份**不受**本资格限制：它们不参与这个锁。）'
      )
    case 'no_connection':
      return '拒绝成为认知执行者：拿不到底层数据库连接（池未建立）。'
    case 'client_acquire_failed':
      return '拒绝成为认知执行者：从池里取专用连接失败，或取锁语句执行失败。'
    case 'backend_pid_unavailable':
      return (
        '拒绝成为认知执行者：拿不到本连接的 pg_backend_pid。\n' +
        '\n' +
        '没有它就无法做"同连接"判据（ADR-132 D05 的失效条件②）⇒ 不能假装持有。\n' +
        '（已把刚取到的锁放掉，不留悬空资格。）'
      )
  }
}
