/**
 * Relationship 投影存取 —— `character_projections` 上的关系行适配。
 *
 * ============================================================================
 *  为什么没有新迁移（WP4 交接单更正：WP3 文档曾猜"新迁移版本号"）
 * ============================================================================
 * `character_projections` 从 M2.5 起就是**通用表**：主键
 * `(character_id, projection_type)`，而关系投影的作用域就编在
 * projectionType 里（`relationship:user:<id>`——contracts/projection.ts 的
 * 设计意图在此兑现）。因此关系投影**零新表、零迁移**，复用既有行结构；
 * 域事件走通用的 `character_domain_events` + `processed_operations`。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 重放必须**按目标过滤**（本文件存在的核心理由）
 * ---------------------------------------------------------------------------
 * 通用 `rebuildProjection()` 只按 handledEventTypes 过滤——关系事件是
 * per-target 的，别的目标的事件若被折进本行，信封的 lastDomainEventSequence
 * 会前进，之后本目标真正的乱序补投会被误判过时（A≠B）。
 * 因此这里提供 `rebuildRelationshipProjection()`：折叠前先过
 * `relationshipEventTargets()`（owner + target 都匹配才算本行的事件）。
 *
 * 与增量路径（`applyAcceptedEvents` + `relationshipReducerFor` 的 isStale
 * 跳过）语义对齐：同一条代码路径折叠（`reduceRelationshipState`），
 * 同一个结果——"删投影 → 重放 → 逐字段一致"（SC-005 / ADR-064 §9）。
 */
import type { CharacterId, DomainEventId, Timestamp } from '../../kernel/contracts/ids.ts'
import type { EntityRef } from '../../kernel/contracts/entity.ts'
import type { CharacterProjection } from '../../kernel/contracts/projection.ts'
import {
  RELATIONSHIP_HANDLED_EVENT_TYPES,
  RELATIONSHIP_REDUCER_VERSION,
  reduceRelationshipState,
  relationshipEventTargets,
} from '../../kernel/projections/relationship.ts'
import {
  UNORIGINATED_RELATIONSHIP_STATE,
  relationshipProjectionType,
  type RelationshipState,
} from '../../kernel/contracts/relationship.ts'
import type { RawDb } from './db.ts'
import {
  deleteProjection,
  domainEventsFor,
  getProjection,
  insertProjection,
  listProjections,
} from './event-store.ts'

/** 关系投影行的 projectionType 前缀（listRelationshipProjections 的过滤口径） */
export const RELATIONSHIP_PROJECTION_TYPE_PREFIX = 'relationship:'

/** 读取一条关系的当前投影（未建档 = undefined） */
export async function getRelationshipProjection(
  db: RawDb,
  characterId: CharacterId,
  target: EntityRef
): Promise<CharacterProjection<RelationshipState> | undefined> {
  return getProjection<RelationshipState>(db, characterId, relationshipProjectionType(target))
}

export interface RelationshipRebuildResult {
  projection: CharacterProjection<RelationshipState>
  /** 折叠进本行的关系事件数（= revision） */
  appliedEvents: number
  /** 被目标过滤跳过的关系事件数（别的目标的） */
  skippedForeign: number
  previousRevision: number | undefined
}

/**
 * 关系投影重建（"投影是缓存"的可执行证明）：
 * 删当前行 → 读全部域事件 → **按目标过滤** → 按序折叠 → 写回。
 */
export async function rebuildRelationshipProjection(
  db: RawDb,
  characterId: CharacterId,
  owner: EntityRef,
  target: EntityRef,
  now: number = Date.now()
): Promise<RelationshipRebuildResult> {
  const projectionType = relationshipProjectionType(target)
  const previous = await getProjection<RelationshipState>(db, characterId, projectionType)

  const events = await domainEventsFor(db, characterId)
  const relevant = events.filter(
    (e) =>
      (RELATIONSHIP_HANDLED_EVENT_TYPES as readonly string[]).includes(e.type) &&
      relationshipEventTargets(e, owner, target)
  )

  let state: RelationshipState = UNORIGINATED_RELATIONSHIP_STATE
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
    state = reduceRelationshipState(state, event, owner, target)
    revision += 1
    lastId = event.id
    lastSequence = event.sequence
  }

  const projection: CharacterProjection<RelationshipState> = {
    characterId,
    projectionType,
    revision,
    reducerVersion: RELATIONSHIP_REDUCER_VERSION,
    ...(lastId !== undefined ? { lastDomainEventId: lastId } : {}),
    ...(lastSequence !== undefined ? { lastDomainEventSequence: lastSequence } : {}),
    state,
    updatedAt: now as Timestamp,
  }

  await deleteProjection(db, characterId, projectionType)
  await insertProjection(db, projection, now)

  return {
    projection,
    appliedEvents: revision,
    skippedForeign,
    previousRevision: previous?.revision,
  }
}

/** 列出该角色全部关系投影（WP5 Context 读这一层；rebuild-all 也用它枚举目标） */
export async function listRelationshipProjections(
  db: RawDb,
  characterId: CharacterId
): Promise<CharacterProjection<RelationshipState>[]> {
  const all = await listProjections(db, characterId)
  return all
    .filter((p) => p.projectionType.startsWith(RELATIONSHIP_PROJECTION_TYPE_PREFIX))
    .map((p) => p as CharacterProjection<RelationshipState>)
}
