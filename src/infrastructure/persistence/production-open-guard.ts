/**
 * INC-01 WP4 —— **生产打开的唯一状态机**（租约 → pre-open 快照 → 打开 → 关闭 → post-close 快照）。
 *
 * ============================================================================
 *  它把三件已经单独验过的东西串成一条**不可跳过**的路径
 * ============================================================================
 * ```text
 *   WP1 跨进程租约          acquireProductionLease()   失败关闭、owner 取证
 *   WP2 verified snapshot   createVerifiedSnapshot()   复制→校验→健康→晋升
 *   WP3 唯一收尾            runtime-shutdown.ts        stop → close → closed check
 * ```
 * 状态机（计划书 §WP4 "Required State Machine" 逐字）：
 *
 * ```text
 *   IDLE → LEASED → PREOPEN_SNAPSHOT_VERIFIED → DB_OPEN
 *        → SERVICES_STOPPED → DB_CLOSED_VERIFIED → POSTCLOSE_SNAPSHOT_VERIFIED → RELEASED
 * ```
 * 失败边（每一条都有具名的 incident code，`AT4.4`）：
 * ```text
 *   LEASE FAILED              → 源**从未**被打开
 *   PREOPEN VERIFY FAILED     → INCIDENT_HOLD，源从未被打开
 *   DB OPEN/INIT FAILED       → 尝试关闭，非零退出
 *   DB CLOSE NOT VERIFIED     → 非零，**不做** post-close 晋升
 *   POSTCLOSE SNAPSHOT FAILED → 非零，**保留**上一份 verified snapshot
 * ```
 *
 * ============================================================================
 *  `AT4.1` 的"token"是什么、为什么它在别处不能伪造
 * ============================================================================
 * `src/db/index.ts` 的中央闸会问本模块 `hasPreopenToken(dataDir)`。
 * **授予**只发生在本模块内部（`prepareProductionOpen` 走完 LEASED 与
 * PREOPEN_SNAPSHOT_VERIFIED 之后），因此
 * ```text
 *   只设 PROJECT_LG_ALLOW_PRODUCTION_DB=1 **不再足以**打开真实库
 * ```
 * —— 这正是 `AT4.1` 的判据。`src/db/index.ts` 只能**问**，不能**给**。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PRODUCTION_DB_DIR } from '../../dev/sandbox.ts'
import {
  acquireProductionLease,
  createVerifiedSnapshot,
  digestTree,
  normalizeDataDir,
  ownerRecordPath,
  readOwnerRecord,
  type OperationKind,
  type OwnerRecord,
  type ProductionLease,
  type SnapshotResult,
  type TreeDigest,
} from './production-db-safety.ts'

// ---------------------------------------------------------------------------
// 状态与 incident code
// ---------------------------------------------------------------------------

export const PRODUCTION_OPEN_STATES = [
  'IDLE',
  'LEASED',
  'PREOPEN_SNAPSHOT_VERIFIED',
  'DB_OPEN',
  'SERVICES_STOPPED',
  'DB_CLOSED_VERIFIED',
  'POSTCLOSE_SNAPSHOT_VERIFIED',
  'RELEASED',
] as const

export type ProductionOpenState = (typeof PRODUCTION_OPEN_STATES)[number]

export type ProductionIncidentCode =
  | 'lease_failed'
  | 'preopen_verify_failed'
  | 'db_open_failed'
  | 'db_close_not_verified'
  | 'postclose_snapshot_failed'

/** 每一条失败边对应一个具名 code（`AT4.4`：错误信息必须能给出它） */
export const PRODUCTION_INCIDENT_CODES: readonly ProductionIncidentCode[] = [
  'lease_failed',
  'preopen_verify_failed',
  'db_open_failed',
  'db_close_not_verified',
  'postclose_snapshot_failed',
]

/**
 * `AT4.4` 的 incident hold 输出。
 *
 * ⚠️ 它**只报事实与一条 dry-run 指令**：不删 `postmaster.pid` / WAL、
 * 不自动切换库、不自动恢复。任何"自动修复"都会把一个可诊断的状态变成不可诊断的状态。
 */
export interface ProductionIncidentHold {
  code: ProductionIncidentCode
  detail: string
  /** 出事那一刻的源摘要（有就报，没有就如实缺席） */
  sourceDigest?: TreeDigest
  /** 最后一份 **verified** 快照 id（有就报） */
  lastVerifiedSnapshotId?: string
  /** 给人照抄的 dry-run 指令（**只有 dry-run**，不带 --apply） */
  restoreDryRunCommand: string
}

export interface ProductionOpenReading {
  dataDir: string
  states: ProductionOpenState[]
  incident?: ProductionIncidentHold
  preOpenSnapshotId?: string
  postCloseSnapshotId?: string
  /** 正常关闭 ⇒ true；强杀/异常 ⇒ 不写这条路（owner record 会留住事实） */
  cleanClose: boolean
  /** `AT4.5`：上一次**没有干净关闭**的 owner 取证（诊断事实，**不是**损坏原因的断言） */
  previousUncleanExit?: OwnerRecord
  /** 源被**真正打开**过几次（测试注入的计数器；用于断言失败边没碰源） */
  sourceOpens: number
  /** 上一份 verified 快照（`AT4.4`/`AT4.3` 用） */
  lastVerifiedSnapshotId?: string
}

// ---------------------------------------------------------------------------
// PRE-OPEN TOKEN（`AT4.1`）
// ---------------------------------------------------------------------------

/**
 * 本进程已经为某个 dataDir 走完"租约 + pre-open 验证"的证据。
 *
 * **只在模块内部授予**：`src/db/index.ts` 只能 `hasPreopenToken()` 问，
 * 因此"绕过状态机直接打开真实库"在类型与运行期都做不到。
 */
const preopenTokens = new Map<string, { issuedAt: number; snapshotId?: string; runtimeId: string }>()

/** 中央闸**只能问**这个（授予在下面，没有导出） */
export function hasPreopenToken(dataDir: string): boolean {
  return preopenTokens.has(normalizeDataDir(resolve(dataDir)))
}

/** 读 token 的细节（证据/诊断用；同样不授予） */
export function preopenTokenOf(
  dataDir: string
): { issuedAt: number; snapshotId?: string; runtimeId: string } | undefined {
  return preopenTokens.get(normalizeDataDir(resolve(dataDir)))
}

function grantPreopenToken(dataDir: string, runtimeId: string, snapshotId: string | undefined): void {
  preopenTokens.set(normalizeDataDir(resolve(dataDir)), {
    issuedAt: Date.now(),
    runtimeId,
    ...(snapshotId !== undefined ? { snapshotId } : {}),
  })
}

/** 释放时撤销（下一次打开必须重新走一遍状态机） */
function revokePreopenToken(dataDir: string): void {
  preopenTokens.delete(normalizeDataDir(resolve(dataDir)))
}

/** 测试钩子：清空所有 token（**只给门用**，生产路径不应调用） */
export function __resetPreopenTokensForTest(): void {
  preopenTokens.clear()
}

// ---------------------------------------------------------------------------
// 路径约定（唯一一处；`pnpm db:snapshot` 与生产状态机必须一致）
// ---------------------------------------------------------------------------

/** 快照根缺省值（与 `scripts/snapshot-db.ts --snapshot-root` 的缺省一致） */
export const DEFAULT_SNAPSHOT_ROOT = resolve('data', 'snapshots')

/**
 * 生产路径**自动**快照的保留份数。
 *
 * `INC01-D4` 的缺省是 **3**（手动 `pnpm db:snapshot` 仍用它）；自动路径刻意用**更宽**的窗口：
 *
 * ```text
 *   判据"真实库相对 WP0 基线的漂移**有据**"要求"改动前那一份"还在快照根里。
 *   每次真实打开会写 **2** 份（pre-open + post-close）⇒ 窗口太窄会把证据链自己剪掉。
 * ```
 *
 * 这是**更严**的保留（留得更多），不违反 D4 的"不足 n 份不得清理"。
 */
export const PRODUCTION_SNAPSHOT_KEEP = 10

/** 本次进程要打开的 dataDir（未设 `PGLITE_DATA_DIR` ⇒ 真实库缺省目录） */
export function productionDataDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PGLITE_DATA_DIR ?? PRODUCTION_DB_DIR)
}

/** 本次进程的快照根（可被 `PGLITE_SNAPSHOT_DIR` 覆盖） */
export function productionSnapshotRootOf(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PGLITE_SNAPSHOT_DIR ?? DEFAULT_SNAPSHOT_ROOT)
}

/**
 * 最后一份 **verified** 快照 id（`AT4.4` 的 incident hold 要报它）。
 *
 * 判据刻意用"**目录 + manifest 都在**"：`INC01-D3` 的晋升顺序是
 * `rename(staging → pglite-<id>)` **然后**才写 `pglite-<id>.manifest.json`，
 * 因此 manifest 是"这份快照已经被验证过"的凭证；只有目录而没有 manifest 的
 * 是**未完成的**晋升，不算数。
 *
 * 快照 id 形如 `<ISO-8601 时间戳>-<源摘要前 12 位>`，所以字典序 == 时间序。
 */
export function lastVerifiedSnapshotId(snapshotRoot: string): string | undefined {
  const root = resolve(snapshotRoot)
  if (!existsSync(root)) return undefined

  const ids: string[] = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!entry.name.startsWith('pglite-') || !entry.name.endsWith('.manifest.json')) continue
      const id = entry.name.slice('pglite-'.length, -'.manifest.json'.length)
      if (id.length === 0) continue
      if (existsSync(join(root, `pglite-${id}`))) ids.push(id)
    }
  } catch {
    return undefined
  }
  return ids.sort().pop()
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

export interface ProductionOpenDeps {
  /** 真实打开的**动作本身**（构造 PGlite / 注册 adapter）。**只在 pre-open PASS 之后才允许被调用** */
  openDatabase: () => Promise<void>
  /** 停服务（WP3 的收尾第一段） */
  stopServices: () => Promise<void>
  /** 关连接（WP3 的第二段） */
  closeDatabase: () => Promise<void>
  /** 关干净了吗（WP3 的第三段；**只有 true 才允许 post-close 晋升**） */
  isDatabaseClosed: () => boolean

  // ---- 以下都是注入点（生产用缺省实现；门用 fixture 替身） ----
  acquireLease?: typeof acquireProductionLease
  createSnapshot?: (input: {
    kind: 'pre-open' | 'post-close'
    lease: Pick<ProductionLease, 'dataDir' | 'pipeName'>
  }) => Promise<SnapshotResult>
  releaseLease?: (lease: ProductionLease, options: { cleanClose: boolean; detail: string }) => Promise<void>
  lastVerifiedSnapshotId?: () => string | undefined
  ownerRecordDir?: string
  now?: () => Date
}

export interface ProductionOpenOptions {
  dataDir: string
  snapshotRoot: string
  operationKind: OperationKind
  runtimeId?: string
  deps: ProductionOpenDeps
}

export interface ProductionOpenHandle {
  reading: ProductionOpenReading
  lease: ProductionLease
  /**
   * `AT4.2`：真正的打开动作（构造 PGlite / 注册 adapter）。
   *
   * 它是**唯一**允许调用 `deps.openDatabase()` 的地方，并且自己先验一次 token ——
   * 于是"跳过状态机直接打开"在这一层也做不到。
   * 失败 ⇒ `db_open_failed`：仍然尝试关闭，且 pre-open 快照**保留**。
   */
  open: () => Promise<void>
  /**
   * `AT4.3`：只有 `closed === true` 才做 post-close 晋升，然后释放租约。
   *
   * `afterClose: true` = 调用方**已经**跑完 WP3 的唯一收尾路径
   * （`createRuntimeShutdown`：`stop → close → closed check`），本函数**不重复**
   * 停服务与关库，只做 ⑥ 记账 → ⑦ post-close 快照 → ⑧ 释放租约。
   * 为什么要有这个模式：`pnpm chat` 的收尾只能有一条路径（`AT3.1`/`AT3.2`），
   * 而"关两次"会让读数失去意义（某些适配器第二次 `close()` 会抛）。
   * `closed` 仍然**两条读数都要为 true**才算晋升。
   */
  finish: (input: {
    closed: boolean
    detail?: string
    afterClose?: boolean
  }) => Promise<ProductionOpenReading>
}

function incident(input: {
  code: ProductionIncidentCode
  detail: string
  dataDir: string
  sourceDigest?: TreeDigest
  lastVerifiedSnapshotId?: string
}): ProductionIncidentHold {
  return {
    code: input.code,
    detail: input.detail,
    ...(input.sourceDigest !== undefined ? { sourceDigest: input.sourceDigest } : {}),
    ...(input.lastVerifiedSnapshotId !== undefined
      ? { lastVerifiedSnapshotId: input.lastVerifiedSnapshotId }
      : {}),
    /*
     * `AT4.4`：给出 **dry-run** 指令（不带 --apply）。
     * 真实恢复是破坏性状态切换，必须由用户对具体 snapshot ID 当轮授权（WP5 的边界）。
     */
    restoreDryRunCommand:
      `pnpm db:restore --from ${input.lastVerifiedSnapshotId ?? '<snapshot-id>'} ` +
      `--data-dir ${input.dataDir}`,
  }
}

/**
 * 前半：`IDLE → LEASED → PREOPEN_SNAPSHOT_VERIFIED`，成功后**授予 token**。
 *
 * 任何一步失败 ⇒ 抛 `ProductionOpenGuardError`（带 incident hold），
 * 并且**源一次都没有被打开**（`sourceOpens` 保持 0）。
 */
export class ProductionOpenGuardError extends Error {
  readonly hold: ProductionIncidentHold
  readonly reading: ProductionOpenReading
  constructor(hold: ProductionIncidentHold, reading: ProductionOpenReading) {
    super(`[${hold.code}] ${hold.detail}`)
    this.name = 'ProductionOpenGuardError'
    this.hold = hold
    this.reading = reading
  }
}

export async function prepareProductionOpen(
  options: ProductionOpenOptions
): Promise<ProductionOpenHandle> {
  const { deps } = options
  const dataDir = resolve(options.dataDir)
  const acquire = deps.acquireLease ?? acquireProductionLease
  /*
   * 缺省释放走**租约对象自己**的 `release()`（WP1 的唯一实现）。
   * 先前的版本让 `deps.releaseLease` 保持 undefined ⇒ 生产路径**根本不会释放**、
   * 也永远不写 `cleanClose` —— 那会让 `AT4.5` 在真实路径上静默失效。
   */
  const release =
    deps.releaseLease ??
    (async (target: ProductionLease, input: { cleanClose: boolean; detail: string }) => {
      await target.release({ cleanClose: input.cleanClose, detail: input.detail })
    })

  /** 释放失败不能掩盖根因；owner record 里留下的就是"未 clean"—— 如实 */
  const releaseLeaseQuietly = async (
    target: ProductionLease,
    input: { cleanClose: boolean; detail: string }
  ): Promise<void> => {
    try {
      await release(target, input)
    } catch {
      /* 见上 */
    }
  }

  const snapshot =
    deps.createSnapshot ??
    (async (input) =>
      await createVerifiedSnapshot({
        sourceDir: dataDir,
        snapshotRoot: options.snapshotRoot,
        lease: input.lease,
        keep: PRODUCTION_SNAPSHOT_KEEP,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      }))

  const reading: ProductionOpenReading = {
    dataDir,
    states: ['IDLE'],
    cleanClose: false,
    sourceOpens: 0,
  }

  const fail = (
    code: ProductionIncidentCode,
    detail: string,
    extra: { sourceDigest?: TreeDigest } = {}
  ): never => {
    const hold = incident({
      code,
      detail,
      dataDir,
      ...(extra.sourceDigest !== undefined ? { sourceDigest: extra.sourceDigest } : {}),
      ...(deps.lastVerifiedSnapshotId?.() !== undefined
        ? { lastVerifiedSnapshotId: deps.lastVerifiedSnapshotId() }
        : {}),
    })
    reading.incident = hold
    throw new ProductionOpenGuardError(hold, reading)
  }

  // ① LEASED
  const lease = await acquire({
    dataDir,
    operationKind: options.operationKind,
    ...(options.runtimeId !== undefined ? { runtimeId: options.runtimeId } : {}),
    ...(deps.ownerRecordDir !== undefined ? { ownerRecordDir: deps.ownerRecordDir } : {}),
  }).catch((error: unknown): never =>
    fail('lease_failed', `拿不到租约：${error instanceof Error ? error.message : String(error)}`)
  )
  reading.states.push('LEASED')
  // `AT4.5`：上一次没干净关闭是**诊断事实**，如实带出来（不据此断言损坏原因）
  if (lease.previousUncleanExit !== undefined) reading.previousUncleanExit = lease.previousUncleanExit

  // ② PREOPEN_SNAPSHOT_VERIFIED
  const pre = await snapshot({ kind: 'pre-open', lease })
  if (!pre.ok) {
    /*
     * 失败关闭：**源从未被打开**。若现有库已坏，验证发生在 disposable copy 上
     * （WP2 的实现保证这一点），真实库保持未打开。
     */
    let sourceDigest: TreeDigest | undefined
    try {
      sourceDigest = digestTree(dataDir)
    } catch {
      /* 连摘要都读不到：如实缺席，不编一个 */
    }
    /*
     * 租约必须放掉：不然"快照失败"会顺带把真实库**锁住**，
     * 而人想做的第一件事恰恰是修好它再重试。`cleanClose=false` 如实写进 owner record。
     */
    reading.states.push('RELEASED')
    await releaseLeaseQuietly(lease, { cleanClose: false, detail: 'PREOPEN_VERIFY_FAILED' })
    fail('preopen_verify_failed', `pre-open 快照未通过验证：${String(pre.failure)}`, {
      ...(sourceDigest !== undefined ? { sourceDigest } : {}),
    })
  }
  reading.states.push('PREOPEN_SNAPSHOT_VERIFIED')
  if (pre.snapshotId !== undefined) reading.preOpenSnapshotId = pre.snapshotId
  if (deps.lastVerifiedSnapshotId?.() !== undefined) {
    reading.lastVerifiedSnapshotId = deps.lastVerifiedSnapshotId()
  }

  // 授予 token（**只有走到这里才授予**）
  grantPreopenToken(dataDir, lease.runtimeId, pre.snapshotId)

  /** 问出来的"关了吗"（问不到 ⇒ false，失败关闭） */
  const closedNow = (): boolean => {
    try {
      return deps.isDatabaseClosed() === true
    } catch {
      return false
    }
  }

  const releaseQuietly = async (input: { cleanClose: boolean; detail: string }): Promise<void> => {
    await releaseLeaseQuietly(lease, input)
  }

  return {
    reading,
    lease,

    // ③ DB_OPEN（**唯一**的打开口）
    open: async () => {
      if (!hasPreopenToken(dataDir)) {
        // 理论上不可达（token 刚授予）；留着是因为"不可达"不该靠假设
        fail('db_open_failed', '没有 pre-open token ⇒ 拒绝打开')
      }
      reading.sourceOpens += 1
      try {
        await deps.openDatabase()
      } catch (error) {
        /*
         * 失败边：`DB OPEN/INIT FAILED → close attempt, nonzero`。
         * pre-open 快照**保留**（本模块从不删快照），也不做 post-close 晋升。
         */
        try {
          await deps.closeDatabase()
        } catch {
          /* 关闭尝试失败：下一条边（closed 问不到）会如实呈现 */
        }
        revokePreopenToken(dataDir)
        await releaseQuietly({ cleanClose: false, detail: 'DB_OPEN_FAILED' })
        reading.states.push('RELEASED')
        reading.cleanClose = false
        fail(
          'db_open_failed',
          `打开/初始化失败：${error instanceof Error ? error.message : String(error)}；` +
            `已尝试关闭（closed=${String(closedNow())}），pre-open 快照保留，不做 post-close 晋升`
        )
      }
      reading.states.push('DB_OPEN')
    },

    finish: async (input) => {
      /*
       * 幂等：失败边（`open()` 抛错、pre-open 失败）**已经**释放过租约并撤销 token。
       * 调用方在最外层 `finally` 里仍会调一次 `finish()` —— 那时候什么都不该再做，
       * 否则会拿一个已经放掉的租约去写第二次 owner record。
       */
      if (reading.states.includes('RELEASED')) return reading
      if (!reading.states.includes('DB_OPEN')) {
        /*
         * "打开从未发生"也必须**放掉租约**：否则一个被跳过的状态机会把库**锁住**，
         * 让人既打不开又不知道被谁挡着 —— 那正是 INC-01 想消灭的那种状态。
         */
        reading.states.push('RELEASED')
        await releaseQuietly({ cleanClose: false, detail: 'OPEN_NEVER_HAPPENED' })
        fail('db_open_failed', 'finish() 在 open() 之前被调用 ⇒ 状态机被跳过')
      }
      const stopFailed: string[] = []

      // ④ SERVICES_STOPPED（失败也继续往下：关库比停服务更重要）
      if (input.afterClose === true) {
        /*
         * 调用方（WP3 的唯一收尾路径）已经停过服务、关过库。
         * 这里**如实记账**而不是重复执行 —— 见 `ProductionOpenHandle.finish` 的说明。
         */
        reading.states.push('SERVICES_STOPPED')
      } else {
        try {
          await deps.stopServices()
        } catch (error) {
          stopFailed.push(error instanceof Error ? error.message : String(error))
        }
        reading.states.push('SERVICES_STOPPED')

        // ⑤ close（WP3 的同一条纪律：无论如何都尝试）
        try {
          await deps.closeDatabase()
        } catch {
          /* 下面是"问出来的结论"才算数 */
        }
      }

      // ⑥ DB_CLOSED_VERIFIED：**两条读数都为 true** 才允许 post-close 晋升（失败关闭）
      const asked = closedNow()
      const closed = input.closed === true && asked
      if (!closed) {
        revokePreopenToken(dataDir)
        await releaseQuietly({ cleanClose: false, detail: 'DB_CLOSE_NOT_VERIFIED' })
        reading.states.push('RELEASED')
        reading.cleanClose = false
        const hold = incident({
          code: 'db_close_not_verified',
          detail:
            '连接没有被验证为已关闭 ⇒ **不做** post-close 晋升，也不写 cleanClose' +
            `（asked=${String(asked)} / reported=${String(input.closed)}）` +
            (input.detail !== undefined ? `（${input.detail}）` : ''),
          dataDir,
          ...(deps.lastVerifiedSnapshotId?.() !== undefined
            ? { lastVerifiedSnapshotId: deps.lastVerifiedSnapshotId() }
            : {}),
        })
        reading.incident = hold
        throw new ProductionOpenGuardError(hold, reading)
      }
      reading.states.push('DB_CLOSED_VERIFIED')

      // ⑦ POSTCLOSE_SNAPSHOT_VERIFIED
      const post = await snapshot({ kind: 'post-close', lease })
      if (!post.ok) {
        revokePreopenToken(dataDir)
        await releaseQuietly({
          cleanClose: false,
          detail: `POSTCLOSE_SNAPSHOT_FAILED:${String(post.failure)}`,
        })
        reading.states.push('RELEASED')
        reading.cleanClose = false
        const hold = incident({
          code: 'postclose_snapshot_failed',
          detail:
            `post-close 快照失败（${String(post.failure)}）⇒ 保留上一份 verified snapshot，` +
            '不做任何"回退到副本"的自动动作',
          dataDir,
          ...(deps.lastVerifiedSnapshotId?.() !== undefined
            ? { lastVerifiedSnapshotId: deps.lastVerifiedSnapshotId() }
            : {}),
        })
        reading.incident = hold
        throw new ProductionOpenGuardError(hold, reading)
      }
      reading.states.push('POSTCLOSE_SNAPSHOT_VERIFIED')
      if (post.snapshotId !== undefined) reading.postCloseSnapshotId = post.snapshotId

      // ⑧ RELEASED（cleanClose=true ⇒ 写进 owner record）
      revokePreopenToken(dataDir)
      reading.cleanClose = true
      await releaseQuietly({
        cleanClose: reading.cleanClose,
        detail: stopFailed.length > 0 ? `STOP_FAILED:${stopFailed.join('|')}` : 'OK',
      })
      reading.states.push('RELEASED')
      return reading
    },
  }
}

/**
 * 上一次打开是否干净（`AT4.5`：作为**诊断事实**显示，**不作**因果断言）。
 *
 * 路径计算**复用** `ownerRecordPath()`（WP1 的唯一实现），不在这里再拼一遍。
 */
export function previousOwnerRecord(dataDir: string, ownerRecordDir?: string): OwnerRecord | undefined {
  return readOwnerRecord(ownerRecordPath(resolve(dataDir), ownerRecordDir))
}
