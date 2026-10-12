/**
 * M11 **反思投影的存取**（ADR-085 §4.2.1：行存储 + 折叠，与 M9/M10 同一形状）。
 *
 * ============================================================================
 *  本文件是本域**唯一**的写路径（恰好两个导出：apply / rebuild）
 * ============================================================================
 * ```text
 * applyReflectionRows()          增量折叠（事件必须已按 sequence 升序）
 * rebuildReflectionProjections() 删本域行 → 全量重放 → 重插（"投影是缓存"的可执行证明）
 *
 * ⚠️ 读面（list / get）里**没有**任何写原语 —— 与 `M10-M11-Read-Only-Contract` §3
 *    的判据同形（那条判据是机器检查的，不是约定）。
 * ⚠️ 事件本身的落库走**共享账本** `applyAcceptedEvents()`（event-store.ts），
 *    它不是本域的写入口 —— 本文件不重造一份。
 * ```
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { DomainEvent } from '../../kernel/contracts/domain-event.ts'
import type { CharacterProjection } from '../../kernel/contracts/projection.ts'
import {
  REFLECTION_REDUCER_VERSION,
  REFLECTION_RECORD_PROJECTION_PREFIX,
  foldReflectionRows,
  recordOfProjection,
  type ReflectionRowCacheEntry,
} from '../../kernel/projections/reflection.ts'
import type { ReflectionRecordState } from '../../kernel/contracts/reflection-events.ts'
import {
  deleteProjection,
  insertProjection,
  listProjections,
  saveProjection,
} from './event-store.ts'
import { inTransaction, type RawDb } from './db.ts'

export interface ApplyReflectionRowsResult {
  readonly appliedEvents: number
  readonly insertedRows: number
  readonly updatedRows: number
}

function toCacheEntry(row: CharacterProjection<unknown>): ReflectionRowCacheEntry {
  return {
    projectionType: String(row.projectionType),
    revision: row.revision,
    state: (row.state as { record: ReflectionRecordState }) ?? {
      record: undefined as unknown as ReflectionRecordState,
    },
    ...(row.lastDomainEventId === undefined ? {} : { lastDomainEventId: row.lastDomainEventId }),
    ...(row.lastDomainEventSequence === undefined
      ? {}
      : { lastDomainEventSequence: row.lastDomainEventSequence }),
    changed: false,
  }
}

/** 增量应用（**事务内**：事件已由调用方落账；这里只补投影） */
export async function applyReflectionRows(
  db: RawDb,
  characterId: CharacterId,
  events: readonly DomainEvent[],
  now: number = Date.now()
): Promise<ApplyReflectionRowsResult> {
  return inTransaction(db, async (tx) => {
    const existing = await listReflectionRows(tx, characterId)
    const cache = new Map<string, ReflectionRowCacheEntry>()
    for (const row of existing) cache.set(String(row.projectionType), toCacheEntry(row))

    foldReflectionRows(cache, events)

    let inserted = 0
    let updated = 0
    for (const entry of cache.values()) {
      if (!entry.changed) continue
      const projection: CharacterProjection<unknown> = {
        characterId,
        projectionType: entry.projectionType,
        revision: entry.revision,
        reducerVersion: REFLECTION_REDUCER_VERSION,
        ...(entry.lastDomainEventId === undefined ? {} : { lastDomainEventId: entry.lastDomainEventId }),
        ...(entry.lastDomainEventSequence === undefined
          ? {}
          : { lastDomainEventSequence: entry.lastDomainEventSequence }),
        state: entry.state,
        updatedAt: now,
      }
      const before = existing.find((row) => String(row.projectionType) === entry.projectionType)
      if (before === undefined) {
        await insertProjection(tx, projection, now)
        inserted += 1
      } else {
        await saveProjection(tx, projection, before.revision, now)
        updated += 1
      }
    }
    return { appliedEvents: events.length, insertedRows: inserted, updatedRows: updated }
  })
}

/** 读面：本域全部投影行（**没有任何写原语**） */
export async function listReflectionRows(
  db: RawDb,
  characterId: CharacterId
): Promise<CharacterProjection<unknown>[]> {
  const all = await listProjections(db, characterId)
  return all.filter((row) => String(row.projectionType).startsWith(REFLECTION_RECORD_PROJECTION_PREFIX))
}

/** 读面：本域全部记录（按 id 升序，确定性） */
export async function listReflectionRecords(
  db: RawDb,
  characterId: CharacterId
): Promise<ReflectionRecordState[]> {
  const rows = await listReflectionRows(db, characterId)
  const records: ReflectionRecordState[] = []
  for (const row of rows) {
    const record = recordOfProjection(row)
    if (record !== undefined) records.push(record)
  }
  return records.sort((a, b) => (a.reflectionId < b.reflectionId ? -1 : a.reflectionId > b.reflectionId ? 1 : 0))
}

/** 读面：一条记录 */
export async function getReflectionRecord(
  db: RawDb,
  characterId: CharacterId,
  reflectionId: string
): Promise<ReflectionRecordState | undefined> {
  const rows = await listReflectionRows(db, characterId)
  for (const row of rows) {
    const record = recordOfProjection(row)
    if (record !== undefined && record.reflectionId === reflectionId) return record
  }
  return undefined
}

export interface RebuildReflectionResult {
  readonly rows: CharacterProjection<unknown>[]
  readonly appliedEvents: number
  readonly previousRowCount: number
}

/**
 * 全量重建（"投影是派生的"可执行证明）。
 *
 * ⚠️ 只折叠**已提交事件**：不调 provider、不重新生成候选、不用当前世界解释过去（`D18`）。
 */
export async function rebuildReflectionProjections(
  db: RawDb,
  characterId: CharacterId,
  events: readonly DomainEvent[],
  now: number = Date.now()
): Promise<RebuildReflectionResult> {
  return inTransaction(db, async (tx) => {
    const previous = await listReflectionRows(tx, characterId)
    for (const row of previous) {
      await deleteProjection(tx, characterId, String(row.projectionType))
    }
    const cache = new Map<string, ReflectionRowCacheEntry>()
    foldReflectionRows(cache, events)
    const rows: CharacterProjection<unknown>[] = []
    for (const entry of cache.values()) {
      const projection: CharacterProjection<unknown> = {
        characterId,
        projectionType: entry.projectionType,
        revision: entry.revision,
        reducerVersion: REFLECTION_REDUCER_VERSION,
        ...(entry.lastDomainEventId === undefined ? {} : { lastDomainEventId: entry.lastDomainEventId }),
        ...(entry.lastDomainEventSequence === undefined
          ? {}
          : { lastDomainEventSequence: entry.lastDomainEventSequence }),
        state: entry.state,
        updatedAt: now,
      }
      await insertProjection(tx, projection, now)
      rows.push(projection)
    }
    return { rows, appliedEvents: events.length, previousRowCount: previous.length }
  })
}
