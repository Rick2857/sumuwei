/**
 * Affect 投影存取 —— `character_projections` 上的情绪行适配（M8 WP4 / ADR-066）。
 *
 * ============================================================================
 *  零新迁移（与 M7 relationship-store 同一裁定）
 * ============================================================================
 * `character_projections` 从 M2.5 起就是通用表：主键
 * `(character_id, projection_type)`。情绪投影的 projectionType 是
 * `affect:character`（M8-D01：**不分片**——一个角色一行），复用既有行结构；
 * 域事件走通用的 `character_domain_events` + `processed_operations`。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 重放必须**按目标过滤** + **事务包装**（与 M7 的两点差异）
 * ---------------------------------------------------------------------------
 *  · 目标过滤：通用 `rebuildProjection()` 只按 handledEventTypes 过滤；
 *    `affectEventTargets(event, owner)` 还要校验 payload.characterId——
 *    别的 Character 的 AFFECT 事件若被折进本行，信封的
 *    lastDomainEventSequence 会前进，之后本角色真正的乱序补投会被误判过时。
 *  · **事务包装**：M7 的 `rebuildRelationshipProjection` 把 delete + insert
 *    留在两个独立调用里（已登记缺陷：重建中途崩溃 = 投影行丢失）。
 *    M8 从第一版就包进 `inTransaction`——删与写要么都发生、要么都不发生。
 *
 * 与增量路径（`applyAcceptedEvents` + `affectReducerFor` 的 own/isStale 跳过）
 * 语义对齐：同一条代码路径折叠（`reduceAffectState`），同一个结果——
 * "删投影 → 重放 → 逐字段一致"（SC-005 / ADR-066 §9）。
 */
import type { CharacterId, DomainEventId, Timestamp } from '../../kernel/contracts/ids.ts'
import type { CharacterProjection } from '../../kernel/contracts/projection.ts'
import {
  AFFECT_HANDLED_EVENT_TYPES,
  AFFECT_REDUCER_VERSION,
  AFFECT_REDUCER_V2_VERSION,
  affectEventTargets,
  reduceAffectState,
  reduceAffectStateV2,
} from '../../kernel/projections/affect.ts'
import {
  AFFECT_PROJECTION_TYPE,
  UNORIGINATED_AFFECT_STATE,
  type AffectState,
} from '../../kernel/contracts/affect.ts'
import type { RawDb } from './db.ts'
import { inTransaction } from './db.ts'
import {
  deleteProjection,
  domainEventsFor,
  getProjection,
  insertProjection,
} from './event-store.ts'

/** 读取角色的情绪投影（未建档 = undefined） */
export async function getAffectProjection(
  db: RawDb,
  characterId: CharacterId
): Promise<CharacterProjection<AffectState> | undefined> {
  return getProjection<AffectState>(db, characterId, AFFECT_PROJECTION_TYPE)
}

export interface AffectRebuildResult {
  projection: CharacterProjection<AffectState>
  /** 折叠进本行的情绪事件数（= revision） */
  appliedEvents: number
  /** 被目标过滤跳过的情绪事件数（别的 Character 的） */
  skippedForeign: number
  previousRevision: number | undefined
}

/**
 * 情绪投影重建（"投影是缓存"的可执行证明）：
 * **事务内**删当前行 → 读全部域事件 → 按目标过滤 → 按序折叠 → 写回。
 *
 * 中途崩溃 ⇒ 事务回滚 ⇒ 旧行仍在（M7 缺陷的修复形态，见文件头）。
 */
export async function rebuildAffectProjection(
  db: RawDb,
  characterId: CharacterId,
  now: number = Date.now()
): Promise<AffectRebuildResult> {
  return inTransaction(db, async (tx) => {
    const previous = await getProjection<AffectState>(tx, characterId, AFFECT_PROJECTION_TYPE)

    const events = await domainEventsFor(tx, characterId)
    const relevant = events.filter(
      (e) =>
        (AFFECT_HANDLED_EVENT_TYPES as readonly string[]).includes(e.type) &&
        affectEventTargets(e, characterId)
    )

    let state: AffectState = UNORIGINATED_AFFECT_STATE
    let revision = 0
    let lastId: DomainEventId | undefined
    let lastSequence: number | undefined
    let skippedForeign = 0
    for (const event of relevant) {
      // 域事件按 (character_id, sequence) 唯一且升序读取；同序列重复在库层不可能
      if (lastSequence !== undefined && event.sequence <= lastSequence) {
        skippedForeign += 1
        continue
      }
      state = reduceAffectState(state, event, characterId)
      revision += 1
      lastId = event.id
      lastSequence = event.sequence
    }

    const projection: CharacterProjection<AffectState> = {
      characterId,
      projectionType: AFFECT_PROJECTION_TYPE,
      revision,
      reducerVersion: AFFECT_REDUCER_VERSION,
      ...(lastId !== undefined ? { lastDomainEventId: lastId } : {}),
      ...(lastSequence !== undefined ? { lastDomainEventSequence: lastSequence } : {}),
      state,
      updatedAt: now as Timestamp,
    }

    await deleteProjection(tx, characterId, AFFECT_PROJECTION_TYPE)
    await insertProjection(tx, projection, now)

    return {
      projection,
      appliedEvents: revision,
      skippedForeign,
      previousRevision: previous?.revision,
    }
  })
}

/**
 * M8.5 §9.3 **受控重建（@2 章）**：删投影行 → 以 reducer@2 重放全部 AFFECT_* 事件
 * → 写回 `affect-reducer@2` 行。语义模式激活（WP13）与激活前演练（WP11 副本）
 * 的盖章步骤。
 *
 * 判据由调用方断言（A==B）：重建结果与现行投影**逐字段一致**——历史事件
 * （无 timingKind）在 @2 下与 @1 逐字一致（WP6 R3）；仅语义路径新事件走
 * SOURCE_ANCHORED 分支。带语义负载的事件流在 @1 行上不存在（@1 折叠硬错误
 * ⇒ 事件写不进去），所以本函数只在 @1 历史上调用是良定的。
 *
 * 与 `rebuildAffectProjection` 同构（事务内删→重放→写回；中途崩溃 ⇒ 回滚，
 * 旧行仍在）——一个概念两版实现，版本不参数化是为了让 @1 重建的既有语义
 * （M8 门断言的面）一个字节不动。
 */
export async function rebuildAffectProjectionV2(
  db: RawDb,
  characterId: CharacterId,
  now: number = Date.now()
): Promise<AffectRebuildResult> {
  return inTransaction(db, async (tx) => {
    const previous = await getProjection<AffectState>(tx, characterId, AFFECT_PROJECTION_TYPE)

    const events = await domainEventsFor(tx, characterId)
    const relevant = events.filter(
      (e) =>
        (AFFECT_HANDLED_EVENT_TYPES as readonly string[]).includes(e.type) &&
        affectEventTargets(e, characterId)
    )

    let state: AffectState = UNORIGINATED_AFFECT_STATE
    let revision = 0
    let lastId: DomainEventId | undefined
    let lastSequence: number | undefined
    let skippedForeign = 0
    for (const event of relevant) {
      if (lastSequence !== undefined && event.sequence <= lastSequence) {
        skippedForeign += 1
        continue
      }
      state = reduceAffectStateV2(state, event, characterId)
      revision += 1
      lastId = event.id
      lastSequence = event.sequence
    }

    const projection: CharacterProjection<AffectState> = {
      characterId,
      projectionType: AFFECT_PROJECTION_TYPE,
      revision,
      reducerVersion: AFFECT_REDUCER_V2_VERSION,
      ...(lastId !== undefined ? { lastDomainEventId: lastId } : {}),
      ...(lastSequence !== undefined ? { lastDomainEventSequence: lastSequence } : {}),
      state,
      updatedAt: now as Timestamp,
    }

    await deleteProjection(tx, characterId, AFFECT_PROJECTION_TYPE)
    await insertProjection(tx, projection, now)

    return {
      projection,
      appliedEvents: revision,
      skippedForeign,
      previousRevision: previous?.revision,
    }
  })
}
