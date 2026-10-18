/**
 * A1 / **`R-A1-5`：核心在线/离线探针（只读）**。
 *
 * ```text
 * 判据 = 单认知执行者资格锁是否被持有（`single-core-qualification.ts`；
 *        advisory lock id 由纯函数 `singleCoreLockId(characterId)` 给出）
 * 查询 = **只读**查 `pg_locks`（**不**去抢锁 —— 抢锁会真的占住资格，那是副作用）：
 *          select count(*)::int as held from pg_locks
 *           where locktype = 'advisory' and granted
 *             and ((classid::bigint << 32) | objid::bigint) = ${lockId}::bigint
 * ⚠️ 为什么这样拼：`pg_try_advisory_lock(bigint)` 的**单键**形态在 `pg_locks` 里拆成
 *    `classid`（高 32 位）+ `objid`（低 32 位）（`objsubid = 1`）—— 拿整键去比 `objid` 是经典错法。
 * ⚠️ **查不出来 ⇒ `null`**（不是"离线"）：PGlite 没有 `pg_locks`/advisory lock ⇒ 这里会抛
 *    ⇒ 如实返回 `null`。这条路径在**隔离库门**里被真的走到（不是靠断言假装）。
 * ```
 */
import { sql } from 'drizzle-orm'
import { exec } from '../persistence/db.ts'
import { singleCoreLockId } from '../persistence/single-core-qualification.ts'
import { corePresenceFromLockCount, type CorePresence } from '../admin/query-ports.ts'

export interface CorePresenceReading {
  /** 三态：`online` / `offline` / `null`（查不出来） */
  readonly presence: CorePresence
  /** 匹配到的资格锁行数（查不出来时 `undefined`） */
  readonly heldCount?: number | undefined
  /** 查不出来时的**具名**原因（读到了就是 `undefined`） */
  readonly unavailableReason?: string | undefined
}

/**
 * 读核心存在性（**只读**；失败 ⇒ 三态里的 `null` + 具名原因）。
 *
 * ⚠️ 依赖**注入**的 `db`：本模块**不**开库、不读环境、不碰生产库。
 */
export async function readCorePresence(input: {
  readonly db: unknown
  readonly characterId: string
  /**
   * **后端**（`CHARACTER_DB_BACKEND` 的值）。
   *
   * ⚠️ **2026-10-14 实测（门抓到的真缺陷）**：PGlite 上这条查询**不抛错**、返回 **0 行**
   *    ⇒ 第一版把它报成 `offline`（"核心离线"）—— 而真相是**这个后端回答不了这个问题**。
   *    这正是裁定要防的混淆（"查不出来" ≠ "真的没被持有"）。
   *    ⇒ 只有 **`postgres`** 后端的 `pg_locks` 才是资格锁的权威；其余一律 `null` + 具名原因。
   */
  readonly backend: string | undefined
}): Promise<CorePresenceReading> {
  const lockId = singleCoreLockId(input.characterId)
  if (input.backend !== 'postgres') {
    return { presence: null, unavailableReason: `not_postgres_backend:${String(input.backend)}` }
  }
  try {
    const rows = await exec(
      input.db as never,
      sql`select count(*)::int as held from pg_locks
           where locktype = 'advisory' and granted
             and ((classid::bigint << 32) | objid::bigint) = ${lockId}::bigint`,
      '读核心资格锁'
    )
    const raw = rows[0]?.held
    const heldCount = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isSafeInteger(heldCount)) {
      return { presence: null, unavailableReason: 'lock_row_shape_unexpected' }
    }
    return { presence: corePresenceFromLockCount(heldCount), heldCount }
  } catch (error) {
    /* 后端没有 `pg_locks`（例如 PGlite）/ 权限不足 / 连接坏 ⇒ **如实说不知道** */
    return {
      presence: null,
      unavailableReason: `lock_probe_failed:${error instanceof Error ? error.name : 'unknown'}`,
    }
  }
}
