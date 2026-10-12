/**
 * M11 **自适应自我的存取**（ADR-085 §4.2.1：行存储 + 折叠）。
 *
 * ============================================================================
 *  本文件是本域**唯一**的写路径（恰好两个导出：apply / rebuild）
 * ============================================================================
 * ```text
 * applyAdaptiveSelfRows()          增量折叠（事件已按 sequence 升序）
 * rebuildAdaptiveSelfProjections() 删本域行 → 全量重放 → 重插
 *
 * ⚠️ 读面（list / get）里**没有**写原语。
 * ⚠️ 三槽**永远**都有读法：没有事件时按 `baselineAdaptiveSelfState()` 读，
 *    因此"她今天有没有被调整过"不需要靠"表里有没有行"来判断。
 * ```
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { DomainEvent } from '../../kernel/contracts/domain-event.ts'
import type { CharacterProjection } from '../../kernel/contracts/projection.ts'
import {
  ADAPTIVE_SELF_SLOTS,
  adaptiveSelfProjectionTypeOf,
  baselineAdaptiveSelfState,
  type AdaptiveSelfSlot,
  type AdaptiveSelfState,
} from '../../kernel/contracts/adaptive-self.ts'
import {
  ADAPTIVE_SELF_REDUCER_VERSION,
  foldAdaptiveSelfRows,
  type AdaptiveSelfRowCacheEntry,
} from '../../kernel/app/reflection/adaptive-self.ts'
import {
  deleteProjection,
  insertProjection,
  listProjections,
  saveProjection,
} from './event-store.ts'
import { inTransaction, type RawDb } from './db.ts'

export interface ApplyAdaptiveSelfRowsResult {
  readonly appliedEvents: number
  readonly insertedRows: number
  readonly updatedRows: number
}

/** 读面：本域全部投影行（**没有**任何写原语） */
export async function listAdaptiveSelfRows(
  db: RawDb,
  characterId: CharacterId
): Promise<CharacterProjection<unknown>[]> {
  const all = await listProjections(db, characterId)
  return all.filter((row) => String(row.projectionType).startsWith('adaptive-self:'))
}

/** 读面：三槽的当前状态（**总有**三个值；没有行时是 baseline） */
export async function listAdaptiveSelfStates(
  db: RawDb,
  characterId: CharacterId
): Promise<AdaptiveSelfState[]> {
  const rows = await listAdaptiveSelfRows(db, characterId)
  const bySlot = new Map<AdaptiveSelfSlot, AdaptiveSelfState>()
  for (const row of rows) {
    const state = row.state as AdaptiveSelfState | undefined
    if (state === undefined || state.slot === undefined) continue
    bySlot.set(state.slot, state)
  }
  return ADAPTIVE_SELF_SLOTS.map((slot) => bySlot.get(slot) ?? baselineAdaptiveSelfState(slot))
}

/** 读面：单个槽 */
export async function getAdaptiveSelfState(
  db: RawDb,
  characterId: CharacterId,
  slot: AdaptiveSelfSlot
): Promise<AdaptiveSelfState> {
  const states = await listAdaptiveSelfStates(db, characterId)
  return states.find((state) => state.slot === slot) ?? baselineAdaptiveSelfState(slot)
}

function toCacheEntry(row: CharacterProjection<unknown>): AdaptiveSelfRowCacheEntry {
  return {
    projectionType: String(row.projectionType),
    revision: row.revision,
    state: row.state as AdaptiveSelfState,
    ...(row.lastDomainEventId === undefined ? {} : { lastDomainEventId: row.lastDomainEventId }),
    ...(row.lastDomainEventSequence === undefined
      ? {}
      : { lastDomainEventSequence: row.lastDomainEventSequence }),
    changed: false,
  }
}

/** 增量应用（事务内；事件已由调用方落账） */
export async function applyAdaptiveSelfRows(
  db: RawDb,
  characterId: CharacterId,
  events: readonly DomainEvent[],
  now: number = Date.now()
): Promise<ApplyAdaptiveSelfRowsResult> {
  return inTransaction(db, async (tx) => {
    const existing = await listAdaptiveSelfRows(tx, characterId)
    const cache = new Map<string, AdaptiveSelfRowCacheEntry>()
    for (const row of existing) cache.set(String(row.projectionType), toCacheEntry(row))

    foldAdaptiveSelfRows(cache, events, adaptiveSelfProjectionTypeOf)

    let inserted = 0
    let updated = 0
    for (const entry of cache.values()) {
      if (!entry.changed) continue
      const projection: CharacterProjection<unknown> = {
        characterId,
        projectionType: entry.projectionType,
        revision: entry.revision,
        reducerVersion: ADAPTIVE_SELF_REDUCER_VERSION,
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

export interface RebuildAdaptiveSelfResult {
  readonly rows: CharacterProjection<unknown>[]
  readonly appliedEvents: number
  readonly previousRowCount: number
}

/** 全量重建（只折叠已提交事件；不调 provider、不重新生成候选） */
export async function rebuildAdaptiveSelfProjections(
  db: RawDb,
  characterId: CharacterId,
  events: readonly DomainEvent[],
  now: number = Date.now()
): Promise<RebuildAdaptiveSelfResult> {
  return inTransaction(db, async (tx) => {
    const previous = await listAdaptiveSelfRows(tx, characterId)
    for (const row of previous) {
      await deleteProjection(tx, characterId, String(row.projectionType))
    }
    const cache = new Map<string, AdaptiveSelfRowCacheEntry>()
    foldAdaptiveSelfRows(cache, events, adaptiveSelfProjectionTypeOf)
    const rows: CharacterProjection<unknown>[] = []
    for (const entry of cache.values()) {
      const projection: CharacterProjection<unknown> = {
        characterId,
        projectionType: entry.projectionType,
        revision: entry.revision,
        reducerVersion: ADAPTIVE_SELF_REDUCER_VERSION,
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
