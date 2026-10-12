/**
 * Relationship Reducer —— **把 `RELATIONSHIP_*` 事件折叠成一段关系的当前状态**。
 *
 * ============================================================================
 *  计划书第 72–74 节（与 memory reducer 同一条铁律）
 * ============================================================================
 *     RelationshipState       = 当前投影（缓存，不是事实本体）
 *     RELATIONSHIP_* 事件     = 这段关系为什么变成这样
 *
 *     删掉投影 → replay Domain Events → 逐字段一致（SC-005 / ADR-064 §9）
 *
 * 三条禁令照旧：不调 LLM、不读挂钟（时间一律 `event.createdAt`）、不写库。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 为什么是**工厂**而不是单例（与 memory reducer 的差异）
 * ---------------------------------------------------------------------------
 * `ProjectionReducer.projectionType` 是**只读常量**（要落进投影行），而关系投影
 * 是 per-target 作用域：`(characterId, 'relationship:user:<id>')` 一行。
 * 所以每个目标一个 reducer 实例：`relationshipReducerFor(target)`。
 *
 * 由此多出一条**正确性关键**的纪律（增量与重放 A==B 的前提）：
 *
 *     不是本目标的关系事件必须经 `isStale` **跳过**（不折叠、不推进信封）。
 *
 * 因为 `character_domain_events.sequence` 是**角色级**单调序——所有目标的关系
 * 事件与记忆事件共用一个序号空间。若把别人的事件折进本行（哪怕 state 不变），
 * 信封的 `lastDomainEventSequence` 也会前进，之后本目标真正的乱序补投事件
 * （sequence ≤ 信封）会被误判过时而**静默丢失**。
 * 重放侧同理：`rebuildRelationshipProjection`（relationship-store.ts）在折叠前
 * 按 target 过滤——通用 `rebuildProjection` 不带这个过滤，**不能**用于关系。
 * ---------------------------------------------------------------------------
 *
 * 折叠语义（ADR-064 §5.1 澄清 + §5.2 WP4 澄清）：
 *   · ORIGIN：未建档 → 建档（基线夹界）；已建档 → 硬错误（Validator 已挡，折叠层防御）
 *   · IMPACT：先做**事件间侵蚀结算**（`erodeClosenessForAbsence`，锚 → 事件时间，
 *     纯函数、只用事件数据），再应用 delta（夹界防御），最后推进锚。
 *   · 撤回形（supersedes 在案指控）：**反向扣除**被撤回指控的 delta 再应用自己的
 *     ——"supersede 后旧事件不再驱动投影"（ADR §9）的字面实现；被撤回条目移出
 *     在案登记表。修复形（无 supersedes）纯叠加。
 *   · 指控（ruleId 'r3'）折叠后进在案登记表（`accusationsInCase`，单一事实源：
 *     撤回反扣 / Validator 在案检查 / Job 构建评估器输入三处共用）。
 */
import {
  KernelError,
  type DomainEvent,
  type EntityRef,
} from '../contracts/index.ts'
import {
  RELATIONSHIP_ORIGIN,
  RELATIONSHIP_IMPACT,
} from '../contracts/domain-event.ts'
import {
  UNORIGINATED_RELATIONSHIP_STATE,
  clampRelationshipValue,
  erodeClosenessForAbsence,
  relationshipProjectionType,
  type RelationshipAccusationInCase,
  type RelationshipImpactPayload,
  type RelationshipOriginPayload,
  type RelationshipState,
} from '../contracts/relationship.ts'
import {
  defaultIsStale,
  type CharacterProjection,
  type ProjectionReducer,
} from '../contracts/projection.ts'

/** 本 reducer 会处理的全部事件类型（登记进投影信封的 reducer_version 守卫） */
export const RELATIONSHIP_HANDLED_EVENT_TYPES: readonly string[] = [
  RELATIONSHIP_ORIGIN,
  RELATIONSHIP_IMPACT,
]

/** 改折叠算法必须升版本（投影行的 reducer_version 会拒绝跨版本追加） */
export const RELATIONSHIP_REDUCER_VERSION = 'relationship-reducer@1'

// ---------------------------------------------------------------------------
// payload 读取（登记表在写入时已做结构校验；这里只做防御性收窄）
// ---------------------------------------------------------------------------

function impactPayloadOf(event: DomainEvent): RelationshipImpactPayload | undefined {
  return event.payload as RelationshipImpactPayload | undefined
}

function originPayloadOf(event: DomainEvent): RelationshipOriginPayload | undefined {
  return event.payload as RelationshipOriginPayload | undefined
}

/**
 * 事件是否属于给定目标（owner + target 都要匹配；形状不对按"不是我的"处理）。
 *
 * 导出给 `relationship-store.ts` 的**按目标过滤重放**用：
 * 通用 `rebuildProjection` 只按事件类型过滤，会把别的目标的事件折进本行
 * （信封前进 ⇒ 乱序补投被误判过时 ⇒ A≠B）——关系重放必须先过这一道。
 */
export function relationshipEventTargets(
  event: DomainEvent,
  owner: EntityRef,
  target: EntityRef,
): boolean {
  const payload =
    event.type === RELATIONSHIP_ORIGIN ? originPayloadOf(event) : impactPayloadOf(event)
  if (payload === undefined) return false
  return String(payload.key.owner) === String(owner.id) && String(payload.key.target) === String(target.id)
}

// ---------------------------------------------------------------------------
// 纯折叠
// ---------------------------------------------------------------------------

/**
 * 折叠一个关系事件（只处理本目标的事件；别人的事件返回原状态）。
 *
 * 语义违规（未建档先 IMPACT / 重复 ORIGIN / 撤回不在案的目标）在这里是**硬错误**：
 * Validator 在放行口已挡过一遍，折叠层再炸说明事件流本身不一致——
 * 失败关闭比静默跳过诚实（跳过会让投影与事件流永久漂移且无任何信号）。
 */
export function reduceRelationshipState(
  state: RelationshipState,
  event: DomainEvent,
  owner: EntityRef,
  target: EntityRef,
): RelationshipState {
  if (!RELATIONSHIP_HANDLED_EVENT_TYPES.includes(event.type)) return state
  if (!relationshipEventTargets(event, owner, target)) return state

  if (event.type === RELATIONSHIP_ORIGIN) {
    const payload = originPayloadOf(event)
    if (payload === undefined) return state
    if (state.originated) {
      throw new KernelError(
        'validation_error',
        'relationship_origin_duplicate',
        `关系 ${String(owner.id)}→${String(target.id)} 已建档，ORIGIN 事件不能二次折叠` +
          '（Validator 应已拦截；折叠层防御性失败关闭）',
      )
    }
    return {
      originated: true,
      trust: clampRelationshipValue(payload.trust),
      closeness: clampRelationshipValue(payload.closeness),
      originKind: payload.originKind,
      lastInteractionAt: event.createdAt,
      accusationsInCase: [],
    }
  }

  // ---- RELATIONSHIP_IMPACT ----
  const payload = impactPayloadOf(event)
  if (payload === undefined) return state
  if (!state.originated || state.lastInteractionAt === null) {
    throw new KernelError(
      'validation_error',
      'relationship_origin_missing',
      `关系 ${String(owner.id)}→${String(target.id)} 尚未建档（或锚缺失），IMPACT 事件无法折叠` +
        '（Validator 应已拦截；折叠层防御性失败关闭）',
    )
  }

  // ① 事件间侵蚀结算（§5.1：锚 → 本事件时间；纯函数，只用事件数据）
  const erodedCloseness = erodeClosenessForAbsence(
    state.closeness,
    state.lastInteractionAt,
    event.createdAt,
  )

  // ② 撤回形：反向扣除被撤回指控的 delta（"旧事件不再驱动投影"）
  let trust = state.trust
  let closeness = erodedCloseness
  let accusations: readonly RelationshipAccusationInCase[] = state.accusationsInCase
  if (payload.supersedes !== undefined) {
    const accusedId = String(payload.supersedes.domainEventId)
    const index = state.accusationsInCase.findIndex((a) => String(a.domainEventId) === accusedId)
    if (index < 0) {
      throw new KernelError(
        'validation_error',
        'relationship_supersedes_not_in_case',
        `撤回指向的事件 ${accusedId} 不在 ${String(owner.id)}→${String(target.id)} 的在案登记表里` +
          '（已被撤回过 / 从未在案；事件流不一致，失败关闭）',
      )
    }
    const accused = state.accusationsInCase[index]
    trust = trust - accused.delta.trust
    closeness = closeness - accused.delta.closeness
    accusations = [
      ...state.accusationsInCase.slice(0, index),
      ...state.accusationsInCase.slice(index + 1),
    ]
  }

  // ③ 应用本事件 delta（夹界：Validator 挡超界，这里防御性收口）
  trust = clampRelationshipValue(trust + payload.delta.trust)
  closeness = clampRelationshipValue(closeness + payload.delta.closeness)

  // ④ 指进入案登记表（撤回反扣 / 在案检查 / 评估器输入的单一事实源）
  if (payload.ruleId === 'r3') {
    accusations = [
      ...accusations,
      {
        domainEventId: event.id,
        delta: payload.delta,
        foldedAt: event.createdAt,
      },
    ]
  }

  // ⑤ 推进衰减锚（只随关系证据事件前进——§5.1 ④ 的既定语义）
  return {
    originated: true,
    trust,
    closeness,
    originKind: state.originKind,
    lastInteractionAt: event.createdAt,
    accusationsInCase: accusations,
  }
}

// ---------------------------------------------------------------------------
// 工厂（per-target reducer 实例）
// ---------------------------------------------------------------------------

/**
 * 为一个目标构建关系投影 reducer。
 *
 * `isStale` 的两层判定（顺序重要）：
 *   1. 不是本目标的事件 → 跳过（**不推进信封**——见文件头纪律）；
 *   2. 本目标的事件 → 按序号单调（`defaultIsStale`：sequence ≤ 信封 = 过时）。
 */
export function relationshipReducerFor(
  owner: EntityRef,
  target: EntityRef,
): ProjectionReducer<RelationshipState> {
  const projectionType = relationshipProjectionType(target)
  return {
    projectionType,
    version: RELATIONSHIP_REDUCER_VERSION,
    handledEventTypes: RELATIONSHIP_HANDLED_EVENT_TYPES,
    initialState: () => UNORIGINATED_RELATIONSHIP_STATE,
    reduce: (state: RelationshipState, event: DomainEvent): RelationshipState =>
      reduceRelationshipState(state, event, owner, target),
    isStale: (
      projection: CharacterProjection<RelationshipState>,
      event: DomainEvent,
    ): boolean => {
      if (!relationshipEventTargets(event, owner, target)) return true
      return defaultIsStale(projection, event)
    },
  }
}
