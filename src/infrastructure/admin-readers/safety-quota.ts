/**
 * A1 / **WP2：`safety_quota` reader 的**映射半**（纯函数）**。
 *
 * ============================================================================
 *  为什么先把这一半单独落地
 * ============================================================================
 * ```text
 * 这一面的**风险不在查询，而在映射**：账本记录里带着 `failure.message`
 * （可能含目标、参数、内部细节），而这一面的字段闭集只有 `reason` 与 `at`
 * ⇒ "把 message 带出去"就是越界（隐私边界 `D07`）。
 * 所以先把映射写成**纯函数**并逐组合测全；`used()`（日额度）那一半要先把
 * "策略时区的日界"算清楚（`main.ts:6661` 附近有现成算法）再落地。
 * ```
 *
 * 口径（已核对，见交接单 §4①）：
 * ```text
 * reason = record.failure?.code ?? record.status        ← **原因码**（`errors.ts:85` `ActionFailure.code`）
 * at     = record.finishedAt ?? record.requestedAt      ← `ExecutionRecordView` 的两个时间戳
 * ⚠️ `message` **永不**出现在输出里
 * ```
 */
import type { ExecutionRecordView } from '../../kernel/action/execution-ledger.ts'
import { zonedDayWindow } from '../../kernel/contracts/notification.ts'

/** 一条拒绝读数（与冻结清单的字段一致：只有原因码与时刻） */
export interface DenialRow {
  reason: string
  at: string
}

/**
 * 把账本的时间戳归一成 ISO 串。
 *
 * ⚠️ **实测踩到**：`Timestamp` 在类型上**不是** string（`ExecutionRecordView.requestedAt/finishedAt`
 *    是 `Timestamp`）—— 第一版直接把它塞进 `at: string`，`tsx` 照跑、`tsc` 判红 TS2322。
 *    而门当时用 `as unknown as ExecutionRecordView` 造了 ISO 串的假记录，**把这个错盖住了**
 *    ⇒ 门也一并改成用**真类型**（数字时间戳）。
 */
function timestampToIso(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string') return value
  return ''
}

/**
 * 把一条账本记录映射成拒绝读数（**纯函数**）。
 *
 * ⚠️ 只映射"拒绝态"的记录（`status === 'rejected'`）；其它状态返回 `undefined`
 *    —— 这一面叫"最近拒绝"，**不**把失败/取消混进来（那是别的量）。
 * ⚠️ 输出里**没有** `message` 的位置：类型上就不给。
 */
export function denialFromRecord(record: ExecutionRecordView): DenialRow | undefined {
  if (record.status !== 'rejected') return undefined
  const code = record.failure?.code
  const reason = typeof code === 'string' && code.trim() !== '' ? code : record.status
  return { reason, at: timestampToIso(record.finishedAt ?? record.requestedAt) }
}

/**
 * 取最近 `limit` 条拒绝（**纯函数**；输入顺序即"最近的在前"，本函数**不**重排）。
 *
 * ⚠️ `limit` 在这里**再夹一次**（1..20）：端口已经夹过，但映射层不许依赖调用方守规矩。
 * ⚠️ 输入里的非拒绝记录**跳过**（不是"当成拒绝"）。
 */
export function denialRowsFromRecords(records: readonly ExecutionRecordView[], limit: number): DenialRow[] {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 20) : 5
  const out: DenialRow[] = []
  for (const record of records) {
    const row = denialFromRecord(record)
    if (row === undefined) continue
    out.push(row)
    if (out.length >= cap) break
  }
  return out
}

/**
 * **`used()` 那一半**：日额度用量（按**策略时区**的日界）。
 *
 * ```text
 * 日界     `zonedDayWindow(now(), timeZone)`（`contracts/notification.ts:399`，**既有算法**）
 * 用量     `countUsage({characterId, dayStart, dayEnd})`（**注入**；生产实现是
 *          `notification-store.ts:894 countQuotaUsage(db, {...})`，生产用法见 `main.ts:6657-6671`）
 * 口径     报**合计**（不带 `kind`）—— 因为本面只有一个 `quotaUsed` 字段；
 *          要分开报"关心/其它"就必须**改冻结清单加字段**，不许挤进同一个格子
 * ```
 *
 * ⚠️ **不许自己算日界**：`new Date().setHours(0,0,0,0)` 是**宿主机**时区，
 *    而生产注释逐字点名"日额度按**策略时区**的日界，不是宿主机"（`main.ts:6633`）。
 * ⚠️ 依赖**注入**（`countUsage` / `now`）⇒ 本函数可在**不碰数据库**的情况下被门测全。
 */
export function createQuotaUsageReader(input: {
  readonly characterId: string
  readonly timeZone: string
  /** **epoch 毫秒**（`zonedDayWindow` 的入参类型就是 number —— `tsc` 实测纠正过我用 Date 的第一版） */
  readonly now: () => number
  readonly countUsage: (query: { characterId: string; dayStart: number; dayEnd: number }) => Promise<number>
}): () => Promise<number> {
  return async () => {
    const window = zonedDayWindow(input.now(), input.timeZone)
    return await input.countUsage({ characterId: input.characterId, dayStart: window.start, dayEnd: window.end })
  }
}

/**
 * **账本 reader 的组合**：`used()`（日额度）+ `recentDenials`（最近拒绝）。
 *
 * ```text
 * 拒绝读数  `ledger.listRecords({ characterId, status: 'rejected', limit })`
 *           ⚠️ `ActionLedgerQuery`（`execution-ledger.ts:182`）**逐字要求**：
 *              "过滤必须发生在 SQL 里，不是读回来再 filter" ⇒ 这里把 `status:'rejected'` 交给端口，
 *              拿到结果后再用**已过门的纯函数** `denialRowsFromRecords` 映射（映射 ≠ 过滤）
 * 依赖**全部注入**（`ledger` / `countUsage` / `now`）⇒ 门可以完全不碰数据库地测全
 * ```
 */
export function createSafetyQuotaLedgerReader(input: {
  readonly characterId: string
  readonly timeZone: string
  readonly now: () => number
  readonly countUsage: (query: { characterId: string; dayStart: number; dayEnd: number }) => Promise<number>
  readonly ledger: {
    listRecords(query: { characterId: string; status?: string; capability?: string; limit: number }): Promise<ExecutionRecordView[]>
  }
  readonly denialLimit?: number | undefined
}): { used: (window?: unknown) => Promise<number>; recentDenials: (limit: number) => Promise<DenialRow[]> } {
  const used = createQuotaUsageReader({
    characterId: input.characterId,
    timeZone: input.timeZone,
    now: input.now,
    countUsage: input.countUsage,
  })
  return {
    used: async () => await used(),
    recentDenials: async (limit: number) => {
      const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 20) : (input.denialLimit ?? 5)
      const records = await input.ledger.listRecords({ characterId: input.characterId, status: 'rejected', limit: cap })
      return denialRowsFromRecords(records, cap)
    },
  }
}
