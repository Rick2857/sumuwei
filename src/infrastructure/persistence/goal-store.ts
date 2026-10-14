/**
 * Goal / Commitment 投影存取（M10 WP3 / ADR-076 `D03` · `D15` · `D24`）。
 *
 * ============================================================================
 *  零新迁移（与 M7 relationship / M8 affect / M9 belief 同一裁定）
 * ============================================================================
 * `character_projections` 主键 `(character_id, projection_type)`。目标域是
 * **一族多行，但一个目标只有一行**：
 *
 *     goal:<goalId>  →  GoalRowState = { goal: GoalState, commitment: CommitmentState | null }
 *
 * **承诺住在目标行里**（`D03`）：一条 Goal 当前至多一个正式承诺，因此不需要
 * 第二条行、也不需要双表事务。但**事件历史仍然分开**（`GOAL_*` 与 `COMMITMENT_*`
 * 各记各的）——不许拿 `GOAL_COMPLETED` 推算 `COMMITMENT_FULFILLED`。
 *
 * ---------------------------------------------------------------------------
 *  事务边界（如实登记，不假装更强）
 * ---------------------------------------------------------------------------
 * ```text
 * ① 领域事件 + processed_operations ：一个事务（applyAcceptedEvents）
 *    ⇒ 关联修改（supersede+create / cancel+cancel）**原子**
 * ② 目标投影行                      ：另一个事务（applyGoalRows）
 *    ⇒ 两次之间崩溃 = 事件在、投影旧。这不是数据丢失：
 *      "投影是派生的"（铁律 ②）—— rebuildGoalProjections 能从事件重放回来
 *      （WP3 的 rebuild 对账门正是在验这一条）
 * ```
 * 刻意**不**把两步合成一个自写事务：那会复制 `applyAcceptedEvents` 的
 * 序号分配 / 幂等记账 / registry 交互，而复制出来的第二份迟早漂移。
 *
 * ---------------------------------------------------------------------------
 *  apply 与 rebuild **同一条折叠核心**（"投影是缓存"的可执行证明）
 * ---------------------------------------------------------------------------
 * 增量路径（applyGoalRows：读现有行 → 折叠 → 写回差量）与重建路径
 * （rebuildGoalProjections：**事务内**删全部 `goal:%` 行 → 全量重放 → 重插）
 * 走同一个 `foldGoalRows`。
 */

import type { CharacterId, DomainEventId, Timestamp } from '../../kernel/contracts/ids.ts'
import type { CharacterProjection } from '../../kernel/contracts/projection.ts'
import type { DomainEvent } from '../../kernel/contracts/index.ts'
import { isGoalRowKey, type GoalRowState } from '../../kernel/contracts/goal.ts'
import {
  GOAL_HANDLED_EVENT_TYPES,
  GOAL_REDUCER_VERSION,
  foldGoalRowsInMemory,
  goalEventTargets,
  type GoalFoldEntry,
} from '../../kernel/projections/goal.ts'
import type { GoalStateLookupPort } from '../../kernel/policies/goal-validator.ts'
import type { RawDb } from './db.ts'
import { inTransaction } from './db.ts'
import { sourceRootsVisible } from './read-scope.ts'
import {
  deleteProjection,
  domainEventsFor,
  getProjection,
  insertProjection,
  listProjections,
  saveProjection,
} from './event-store.ts'

// ---------------------------------------------------------------------------
// 读助手
// ---------------------------------------------------------------------------

/** 读取一个目标行（不存在 = undefined） */
export async function getGoalRow(
  db: RawDb,
  characterId: CharacterId,
  goalId: string,
): Promise<CharacterProjection<GoalRowState> | undefined> {
  const row = await getProjection<GoalRowState>(db, characterId, `goal:${String(goalId)}`)
  return row !== undefined && await sourceRootsVisible(db, row.state.goal.sourceRefs.map(ref => String(ref.conversationEventId))) ? row : undefined
}

/**
 * 列出本角色的全部目标域行。
 *
 * ⚠️ 与 belief 同一条**已知代价**（`L-M10-02` 家族）：`listProjections` 不带前缀
 *    条件，因此这里是"列出全部投影行 + 内存前缀过滤" —— 成本随**全部**投影行
 *    增长，而不是随目标数增长。WP9 的规模门必须实测它（ADR-076 `D24`）。
 */
export async function listGoalRows(
  db: RawDb,
  characterId: CharacterId,
): Promise<CharacterProjection<unknown>[]> {
  const all = await listProjections(db, characterId)
  return all.filter((row) => isGoalRowKey(String(row.projectionType)))
}

/** 只取 state（放行口的 `GoalStateLookupPort` 实现用） */
export async function listGoalStates(db: RawDb, characterId: CharacterId): Promise<GoalRowState[]> {
  const rows = await listGoalRows(db, characterId)
  const states = rows
    .map((row) => row.state as GoalRowState | undefined)
    .filter((state): state is GoalRowState => state !== undefined)
  const allowed = await Promise.all(states.map(state => sourceRootsVisible(db, state.goal.sourceRefs.map(ref => String(ref.conversationEventId)))))
  return states.filter((_, index) => allowed[index])
}

/**
 * 放行口的**只读**状态端口。
 *
 * ⚠️ 它只读；写走 `applyGoalRows`（事务内）。放行口拿不到写口这件事是**结构性**的
 *    ——"唯一写路径"因此不靠约定。
 */
export function createGoalStateLookup(db: RawDb): GoalStateLookupPort {
  return {
    async getGoal(characterId: string, goalId: string): Promise<GoalRowState | undefined> {
      const row = await getGoalRow(db, characterId as CharacterId, goalId)
      return row?.state as GoalRowState | undefined
    },
    async listGoals(characterId: string): Promise<GoalRowState[]> {
      return listGoalStates(db, characterId as CharacterId)
    },
  }
}

// ---------------------------------------------------------------------------
// 折叠核心（apply 与 rebuild 共用；纯内存）
// ---------------------------------------------------------------------------

/**
 * 折叠缓存的一行（与 `GoalFoldEntry` 同形；别名只为让本文件的读者少跳一次）。
 */
export type RowCacheEntry = GoalFoldEntry

/**
 * 把一批 Goal 事件折叠进行缓存。
 *
 * ⚠️ 它**委托**给 `projections/goal.ts` 的 `foldGoalRowsInMemory`（唯一折叠循环）
 *    —— apply 与 rebuild 因此不可能漂移。
 *
 * 本域**没有**行删除（不像 belief 的证据累计行要清零）：一个目标一行，
 * 终态只是 state 变化。返回值恒为空集，保留签名是为了与 belief 的折叠核心同形
 * （`foldXRows(cache, events)`），调用方无需分支。
 */
export function foldGoalRows(
  cache: Map<string, RowCacheEntry>,
  events: readonly DomainEvent[],
): Set<string> {
  foldGoalRowsInMemory(cache, events)
  return new Set<string>()
}

// ---------------------------------------------------------------------------
// 增量应用
// ---------------------------------------------------------------------------

export interface ApplyGoalRowsResult {
  appliedEvents: number
  insertedRows: number
  updatedRows: number
  deletedRows: number
}

/**
 * 把已落库的 Goal 事件增量折叠进行（**一个事务**）。
 *
 * 事件必须**已按 sequence 升序**排好。幂等由上游保证
 * （`processed_operations` 的幂等键挡重复投递，见 `goal-validator.ts`）。
 */
export async function applyGoalRows(
  db: RawDb,
  characterId: CharacterId,
  events: readonly DomainEvent[],
  now: number = Date.now(),
): Promise<ApplyGoalRowsResult> {
  return inTransaction(db, async (tx) => {
    const existing = await listGoalRows(tx, characterId)
    const cache = new Map<string, RowCacheEntry>()
    for (const row of existing) {
      cache.set(String(row.projectionType), {
        projectionType: String(row.projectionType),
        revision: row.revision,
        /* 行 state 是 jsonb 读回来的 unknown；本域的 canonical 形状是 GoalRowState */
        state: row.state as GoalRowState,
        lastDomainEventId: row.lastDomainEventId,
        lastDomainEventSequence: row.lastDomainEventSequence,
        changed: false,
      })
    }

    foldGoalRows(cache, events)

    let inserted = 0
    let updated = 0
    for (const entry of cache.values()) {
      if (!entry.changed) continue
      const projection: CharacterProjection<unknown> = {
        characterId,
        projectionType: entry.projectionType,
        revision: entry.revision,
        reducerVersion: GOAL_REDUCER_VERSION,
        ...(entry.lastDomainEventId !== undefined
          ? { lastDomainEventId: entry.lastDomainEventId }
          : {}),
        ...(entry.lastDomainEventSequence !== undefined
          ? { lastDomainEventSequence: entry.lastDomainEventSequence }
          : {}),
        state: entry.state,
        updatedAt: now as Timestamp,
      }
      const before = existing.find(
        (row) => String(row.projectionType) === entry.projectionType,
      )
      if (before === undefined) {
        await insertProjection(tx, projection, now)
        inserted += 1
      } else {
        await saveProjection(tx, projection, before.revision, now)
        updated += 1
      }
    }

    return {
      appliedEvents: events.length,
      insertedRows: inserted,
      updatedRows: updated,
      deletedRows: 0,
    }
  })
}

// ---------------------------------------------------------------------------
// 重建（"投影是缓存"的可执行证明）
// ---------------------------------------------------------------------------

export interface RebuildGoalResult {
  rows: CharacterProjection<unknown>[]
  appliedEvents: number
  previousRowCount: number
}

/**
 * 目标投影重建：**事务内**删全部 `goal:%` 行 → 全量重放 → 重插。
 * 中途崩溃 ⇒ 回滚，旧行仍在。
 */
export async function rebuildGoalProjections(
  db: RawDb,
  characterId: CharacterId,
  now: number = Date.now(),
): Promise<RebuildGoalResult> {
  return inTransaction(db, async (tx) => {
    const previous = await listGoalRows(tx, characterId)
    for (const row of previous) {
      await deleteProjection(tx, characterId, String(row.projectionType))
    }

    const events = await domainEventsFor(tx, characterId)
    const relevant = events.filter(
      (event) =>
        (GOAL_HANDLED_EVENT_TYPES as readonly string[]).includes(event.type) &&
        goalEventTargets(event, String(characterId)),
    )

    const cache = new Map<string, RowCacheEntry>()
    foldGoalRows(cache, relevant)

    const rows: CharacterProjection<unknown>[] = []
    for (const entry of cache.values()) {
      const projection: CharacterProjection<unknown> = {
        characterId,
        projectionType: entry.projectionType,
        revision: entry.revision,
        reducerVersion: GOAL_REDUCER_VERSION,
        ...(entry.lastDomainEventId !== undefined
          ? { lastDomainEventId: entry.lastDomainEventId }
          : {}),
        ...(entry.lastDomainEventSequence !== undefined
          ? { lastDomainEventSequence: entry.lastDomainEventSequence }
          : {}),
        state: entry.state,
        updatedAt: now as Timestamp,
      }
      await insertProjection(tx, projection, now)
      rows.push(projection)
    }

    return { rows, appliedEvents: relevant.length, previousRowCount: previous.length }
  })
}

export { GOAL_REDUCER_VERSION }
