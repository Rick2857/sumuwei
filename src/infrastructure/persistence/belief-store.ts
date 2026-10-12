/**
 * Belief 投影存取 —— `character_projections` 上的信念行适配（M9 WP4 / ADR-070）。
 *
 * ============================================================================
 *  零新迁移（与 M7 relationship-store / M8 affect-store 同一裁定）
 * ============================================================================
 * `character_projections` 主键 `(character_id, projection_type)`。信念域是
 * **一族多行**（projections/belief.ts 文件头）：
 *
 *     belief:origin                   → BeliefOriginState
 *     belief:<beliefId>               → BeliefState
 *     belief:evidence:<fnv1aHex(key)> → BeliefEvidenceAccumulation
 *
 * 全部复用既有行结构；域事件走通用 `character_domain_events`。
 *
 * ---------------------------------------------------------------------------
 *  apply 与 rebuild **同一条折叠核心**（SC-005 的可执行证明）
 * ---------------------------------------------------------------------------
 * `foldBeliefRows()` 是纯内存编排：一批事件 → 行缓存里的增/改/删。增量路径
 * （applyBeliefEvents：读现有行 → 折叠 → 写回差量）与重建路径
 * （rebuildBeliefProjections：**事务内**删全部 belief:% 行 → 全量重放 → 重插）
 * 走它——同一条代码路径折叠，同一个结果。
 *
 * 事务纪律与 M8 affect-store 同源（M7 已登记缺陷的修复形态）：删与写要么
 * 都发生、要么都不发生。
 */
import type { CharacterId, DomainEventId, Timestamp } from '../../kernel/contracts/ids.ts'
import type { CharacterProjection } from '../../kernel/contracts/projection.ts'
import {
  BELIEF_HANDLED_EVENT_TYPES,
  BELIEF_REDUCER_VERSION,
  beliefEventTargets,
  beliefEvidenceRowKeyOf,
  beliefOriginRowKey,
  beliefRowKeyOf,
  evidenceRowKeyOfNoted,
  reduceBeliefEvidenceAccumulation,
  reduceBeliefOriginState,
  reduceBeliefState,
} from '../../kernel/projections/belief.ts'
import {
  BELIEF_ORIGIN,
  BELIEF_RETRACTED,
  BELIEF_SUPERSEDED,
} from '../../kernel/contracts/domain-event.ts'
import {
  BELIEF_ORIGIN_PROJECTION_TYPE,
  beliefSlotKeyOf,
  type BeliefEvidenceAccumulation,
  type BeliefOriginState,
  type BeliefRetractedPayload,
  type BeliefState,
  type BeliefSupersededPayload,
} from '../../kernel/contracts/belief.ts'
import type { RawDb } from './db.ts'
import { inTransaction } from './db.ts'
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

/** 读取建档行（未建档 = undefined） */
export async function getBeliefOrigin(
  db: RawDb,
  characterId: CharacterId,
): Promise<CharacterProjection<BeliefOriginState> | undefined> {
  return getProjection<BeliefOriginState>(db, characterId, beliefOriginRowKey())
}

/** 读取单信念行 */
export async function getBelief(
  db: RawDb,
  characterId: CharacterId,
  beliefId: string,
): Promise<CharacterProjection<BeliefState> | undefined> {
  return getProjection<BeliefState>(db, characterId, beliefRowKeyOf(beliefId))
}

/** 读取证据累计行（键 = beliefEvidenceProjectionTypeOf 的产出） */
export async function getBeliefEvidence(
  db: RawDb,
  characterId: CharacterId,
  evidenceRowKey: string,
): Promise<CharacterProjection<BeliefEvidenceAccumulation> | undefined> {
  return getProjection<BeliefEvidenceAccumulation>(db, characterId, evidenceRowKey)
}

/** 列出本角色的全部信念域行（前缀 belief: / belief:evidence:） */
export async function listBeliefRows(
  db: RawDb,
  characterId: CharacterId,
): Promise<CharacterProjection<unknown>[]> {
  const all = await listProjections(db, characterId)
  return all.filter((row) => String(row.projectionType).startsWith('belief:'))
}

/**
 * 全部 **active** 信念（WP5：依赖失效扫描的输入）。
 *
 * 只取信念行（跳过 origin / evidence 行），按 status === 'active' 过滤——
 * disputed/superseded/retracted 的信念不再采信，失效传播对它们无动作
 * （ADR-070 §4.2：终态不可迁移，除了 superseded→retracted 的显式撤回）。
 */
export async function listActiveBeliefs(
  db: RawDb,
  characterId: CharacterId,
): Promise<BeliefState[]> {
  const rows = await listBeliefRows(db, characterId)
  const out: BeliefState[] = []
  for (const row of rows) {
    const type = String(row.projectionType)
    if (type === BELIEF_ORIGIN_PROJECTION_TYPE) continue
    if (type.startsWith('belief:evidence:')) continue
    const state = row.state as BeliefState | undefined
    if (state === undefined || state.status !== 'active') continue
    out.push(state)
  }
  return out
}

/**
 * 按状态列读信念行（WP7：上下文面的输入）。
 *
 * 上下文需要 **active + disputed** 两个状态：active 是"当前采信"，
 * disputed 是"同槽争议侧"——§9.1 要求两侧与"不确定"标签**原子**呈现，
 * 因此 disputed 不能像 superseded/retracted 那样被直接跳过。
 * 其余状态（superseded/retracted）是终态，不进上下文。
 */
export async function listBeliefsByStatus(
  db: RawDb,
  characterId: CharacterId,
  statuses: readonly string[],
): Promise<BeliefState[]> {
  const wanted = new Set(statuses.map(String))
  const rows = await listBeliefRows(db, characterId)
  const out: BeliefState[] = []
  for (const row of rows) {
    const type = String(row.projectionType)
    if (type === BELIEF_ORIGIN_PROJECTION_TYPE) continue
    if (type.startsWith('belief:evidence:')) continue
    const state = row.state as BeliefState | undefined
    if (state === undefined || !wanted.has(String(state.status))) continue
    out.push(state)
  }
  return out
}

/**
 * §5.4 遗忘契约的读侧：本槽位已禁用的根事件并集。
 *
 * 来源 = BELIEF_RETRACTED 事件流（不是投影行——禁用根是**事件携带的承诺**，
 * 行只是缓存）。每条 RETRACTED 的槽位从它自己的信念行推导（payload 只有
 * beliefId；行在终态仍保留）。信念行缺失的孤儿 RETRACTED 无法定槽 ⇒ 跳过
 * （事件流不一致是上游 bug，这里不猜槽位）。
 */
export async function forbiddenRootsForSlot(
  db: RawDb,
  characterId: CharacterId,
  slotKey: string,
): Promise<string[]> {
  const events = await domainEventsFor(db, characterId)
  const roots: string[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== BELIEF_RETRACTED) continue
    if (!beliefEventTargets(event, characterId)) continue
    const payload = event.payload as Partial<BeliefRetractedPayload> | undefined
    if (payload?.beliefId === undefined) continue
    const belief = await getBelief(db, characterId, String(payload.beliefId))
    if (belief === undefined) continue
    const slot = beliefSlotKeyOf({
      perspectiveOwnerId: belief.state.perspectiveOwnerId,
      subject: belief.state.subject,
      predicate: belief.state.proposition.predicate,
      scopeKey: belief.state.proposition.scopeKey,
    })
    if (slot !== slotKey) continue
    for (const root of payload.forbiddenRootIds ?? []) {
      const id = String(root)
      if (!seen.has(id)) {
        seen.add(id)
        roots.push(id)
      }
    }
  }
  return roots
}

// ---------------------------------------------------------------------------
// 折叠核心（apply 与 rebuild 共用；纯内存）
// ---------------------------------------------------------------------------

export interface RowCacheEntry {
  projectionType: string
  revision: number
  state: unknown
  lastDomainEventId?: DomainEventId
  lastDomainEventSequence?: number
  changed: boolean
}

/**
 * 把一批 BELIEF_* 事件折叠进行缓存。
 *
 * 行定位（projections/belief.ts 的助手）+ 证据行清零（SUPERSEDED/RETRACTED
 * 命中该值时——被取代/被撤回的值的累计不得再喂给同值新形成）。
 * 返回被删除的行键集合（apply 路径要照着删库里的行）。
 */
export function foldBeliefRows(
  cache: Map<string, RowCacheEntry>,
  events: readonly import('../../kernel/contracts/index.ts').DomainEvent[],
): Set<string> {
  const deleted = new Set<string>()

  const touch = (
    key: string,
    event: import('../../kernel/contracts/index.ts').DomainEvent,
    fold: (state: unknown) => unknown,
  ): void => {
    const entry = cache.get(key)
    const next = fold(entry?.state)
    if (entry === undefined) {
      if (next === undefined) return
      cache.set(key, {
        projectionType: key,
        revision: 1,
        state: next,
        lastDomainEventId: event.id,
        lastDomainEventSequence: event.sequence,
        changed: true,
      })
    } else {
      entry.state = next
      entry.revision += 1
      entry.lastDomainEventId = event.id
      entry.lastDomainEventSequence = event.sequence
      entry.changed = true
    }
  }

  /**
   * SUPERSEDED/RETRACTED 命中的证据行清零（读信念行推导 (槽位, 值)）。
   *
   * 只在**迁移真实发生**时清零（读折叠前状态）：replay 事件（旧信念已终态）
   * 是 no-op，不得再次清零——否则会错杀两次迁移之间新进来的累计
   * （WP4 校准轮抓出：sup 重放把取代后新记的 r8..r10 又清了一遍）。
   * 这与 oracle 的终态守卫逐字段对齐（oracle 是规格）。
   */
  const resetEvidenceRowForBelief = (
    beliefId: string,
    event: import('../../kernel/contracts/index.ts').DomainEvent,
    transitionHappens: (status: BeliefState['status']) => boolean,
  ): void => {
    const beliefEntry = cache.get(beliefRowKeyOf(beliefId))
    const belief = beliefEntry?.state as BeliefState | undefined
    if (belief === undefined) return
    if (!transitionHappens(belief.status)) return
    const key = beliefEvidenceRowKeyOf({
      perspectiveOwnerId: belief.perspectiveOwnerId,
      subject: belief.subject,
      predicate: belief.proposition.predicate,
      scopeKey: belief.proposition.scopeKey,
      value: belief.proposition.value,
    })
    if (cache.delete(key)) deleted.add(key)
  }

  for (const event of events) {
    switch (event.type) {
      case BELIEF_ORIGIN: {
        touch(beliefOriginRowKey(), event, (state) =>
          reduceBeliefOriginState(state as BeliefOriginState | undefined, event),
        )
        break
      }
      case 'BELIEF_EVIDENCE_NOTED': {
        const key = evidenceRowKeyOfNoted(event)
        if (key === undefined) break
        touch(key, event, (state) =>
          reduceBeliefEvidenceAccumulation(state as BeliefEvidenceAccumulation | undefined, event),
        )
        break
      }
      case 'BELIEF_FORMED':
      case 'BELIEF_REINFORCED':
      case 'BELIEF_DISPUTED': {
        const payload = event.payload as { beliefId?: string } | undefined
        if (payload?.beliefId === undefined) break
        touch(beliefRowKeyOf(String(payload.beliefId)), event, (state) =>
          reduceBeliefState(state as BeliefState | undefined, event),
        )
        break
      }
      case BELIEF_SUPERSEDED: {
        const payload = event.payload as Partial<BeliefSupersededPayload> | undefined
        if (payload?.oldBeliefId === undefined) break
        // 先清零旧值的证据行（要用旧信念行的 proposition——必须在折叠前读；
        // 只有 active/disputed → superseded 的真实迁移才清，replay 不清）
        resetEvidenceRowForBelief(
          String(payload.oldBeliefId),
          event,
          (status) => status === 'active' || status === 'disputed',
        )
        touch(beliefRowKeyOf(String(payload.oldBeliefId)), event, (state) =>
          reduceBeliefState(state as BeliefState | undefined, event),
        )
        break
      }
      case BELIEF_RETRACTED: {
        const payload = event.payload as Partial<BeliefRetractedPayload> | undefined
        if (payload?.beliefId === undefined) break
        // 非 retracted → retracted 的真实迁移才清零（replay 不清）
        resetEvidenceRowForBelief(
          String(payload.beliefId),
          event,
          (status) => status !== 'retracted',
        )
        touch(beliefRowKeyOf(String(payload.beliefId)), event, (state) =>
          reduceBeliefState(state as BeliefState | undefined, event),
        )
        break
      }
      default:
        break
    }
  }
  return deleted
}

// ---------------------------------------------------------------------------
// 增量应用（Job 层：accepted 事件 → 行差量写回）
// ---------------------------------------------------------------------------

export interface ApplyBeliefRowsResult {
  /** 折叠进行缓存的事件数（含 no-op 命中） */
  appliedEvents: number
  /** 新插入的行数 */
  insertedRows: number
  /** 更新的行数 */
  updatedRows: number
  /** 删除的行数（证据行清零） */
  deletedRows: number
}

/**
 * 把已落库的 BELIEF_* 事件增量折叠进行（事务内）。
 *
 * 事件必须**已按 sequence 升序**排好（调用方从 domainEventsFor 拿到的就是）。
 * 幂等性由上游保证（processed_operations 的幂等键挡重复投递）；本函数
 * 只做"同一批事件 → 同一批行变更"。
 */
export async function applyBeliefRows(
  db: RawDb,
  characterId: CharacterId,
  events: readonly import('../../kernel/contracts/index.ts').DomainEvent[],
  now: number = Date.now(),
): Promise<ApplyBeliefRowsResult> {
  return inTransaction(db, async (tx) => {
    const existing = await listBeliefRows(tx, characterId)
    const cache = new Map<string, RowCacheEntry>()
    for (const row of existing) {
      cache.set(String(row.projectionType), {
        projectionType: String(row.projectionType),
        revision: row.revision,
        state: row.state,
        lastDomainEventId: row.lastDomainEventId,
        lastDomainEventSequence: row.lastDomainEventSequence,
        changed: false,
      })
    }

    const deleted = foldBeliefRows(cache, events)

    let inserted = 0
    let updated = 0
    for (const key of deleted) {
      await deleteProjection(tx, characterId, key)
    }
    for (const entry of cache.values()) {
      if (!entry.changed) continue
      const projection: CharacterProjection<unknown> = {
        characterId,
        projectionType: entry.projectionType,
        revision: entry.revision,
        reducerVersion: BELIEF_REDUCER_VERSION,
        ...(entry.lastDomainEventId !== undefined ? { lastDomainEventId: entry.lastDomainEventId } : {}),
        ...(entry.lastDomainEventSequence !== undefined
          ? { lastDomainEventSequence: entry.lastDomainEventSequence }
          : {}),
        state: entry.state,
        updatedAt: now as Timestamp,
      }
      // 同一批内"清零 → 再累计"的证据行：库里的行已被上面的 delete 拿掉，
      // 即便 pre-batch 读里还有它，也必须走 insert（WP4 门抓出的真缺陷：
      // 走 save 会拿旧 revision 去更新一条已删除的行 ⇒ projection_missing）。
      const before = deleted.has(entry.projectionType)
        ? undefined
        : existing.find((row) => String(row.projectionType) === entry.projectionType)
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
      deletedRows: deleted.size,
    }
  })
}

// ---------------------------------------------------------------------------
// 重建（"投影是缓存"的可执行证明）
// ---------------------------------------------------------------------------

export interface RebuildBeliefResult {
  /** 重建后的全部信念域行 */
  rows: CharacterProjection<unknown>[]
  /** 折叠进行的事件数 */
  appliedEvents: number
  /** 重建前的行数 */
  previousRowCount: number
}

/**
 * 信念投影重建：**事务内**删全部 belief:% 行 → 全量重放 BELIEF_* 事件
 * （按目标过滤）→ 重插。中途崩溃 ⇒ 回滚，旧行仍在。
 *
 * 与增量路径（applyBeliefRows）共用 `foldBeliefRows`——A==B 的机器基础。
 */
export async function rebuildBeliefProjections(
  db: RawDb,
  characterId: CharacterId,
  now: number = Date.now(),
): Promise<RebuildBeliefResult> {
  return inTransaction(db, async (tx) => {
    const previous = await listBeliefRows(tx, characterId)
    for (const row of previous) {
      await deleteProjection(tx, characterId, String(row.projectionType))
    }

    const events = await domainEventsFor(tx, characterId)
    const relevant = events.filter(
      (e) =>
        (BELIEF_HANDLED_EVENT_TYPES as readonly string[]).includes(e.type) &&
        beliefEventTargets(e, characterId),
    )

    const cache = new Map<string, RowCacheEntry>()
    foldBeliefRows(cache, relevant)

    const rows: CharacterProjection<unknown>[] = []
    for (const entry of cache.values()) {
      const projection: CharacterProjection<unknown> = {
        characterId,
        projectionType: entry.projectionType,
        revision: entry.revision,
        reducerVersion: BELIEF_REDUCER_VERSION,
        ...(entry.lastDomainEventId !== undefined ? { lastDomainEventId: entry.lastDomainEventId } : {}),
        ...(entry.lastDomainEventSequence !== undefined
          ? { lastDomainEventSequence: entry.lastDomainEventSequence }
          : {}),
        state: entry.state,
        updatedAt: now as Timestamp,
      }
      await insertProjection(tx, projection, now)
      rows.push(projection)
    }

    return {
      rows,
      appliedEvents: relevant.length,
      previousRowCount: previous.length,
    }
  })
}

// ---------------------------------------------------------------------------
// 便捷常量重导出（装配层 / 门用）
// ---------------------------------------------------------------------------

export { BELIEF_ORIGIN_PROJECTION_TYPE }
