/**
 * Affect Reducer —— **把 `AFFECT_*` 事件折叠成 Character 的当前情绪状态**。
 *
 * ============================================================================
 *  ADR-066（M8）——与 memory / relationship reducer 同一条铁律
 * ============================================================================
 *     AffectState          = 当前投影（缓存，不是事实本体）
 *     AFFECT_* 事件        = 她的情绪为什么变成这样
 *
 *     删掉投影 → replay Domain Events → 逐字段一致（SC-005 同构）
 *
 * 三条禁令照旧：不调 LLM、不读挂钟（时间一律 `event.createdAt`）、不写库。
 *
 * ---------------------------------------------------------------------------
 *  与 relationship reducer 的两处结构差异（都来自"Character 级 vs 关系键级"）
 * ---------------------------------------------------------------------------
 * ① **单例投影**：`(characterId, 'affect:character')` 一行——没有 per-target
 *    工厂参数与 foreign-skip 的"多目标共享序号空间"问题；但**own 判定仍在**：
 *    `payload.characterId ≠ owner` 的事件经 `isStale` 跳过（不折叠、不推进信封），
 *    与 relationship 的纪律同因——别人的事件折进本行会让信封前进，
 *    之后真正的乱序补投事件会被误判过时而静默丢失。
 *
 * ② **衰减折算发生在 IMPACT 内部**（§5 规则 2：先把旧锚以事件时间折算到有效值，
 *    再应用 delta，再写新锚）。TOUCH **不折算**：它只推进交互锚
 *    （`lastInteractionAt`），不动 valence/arousal 也不动情绪轴锚
 *    （`lastAffectEventAt`）——"delta 恒为零"（M8-D07）在存储层字面成立，
 *    读时衰减统一由 `effectiveAffect` 一处计算（指数衰减可复合：
 *    锚点不折算与逐事件折算在任何读取时刻给出相同的有效值）。
 *
 * 语义违规（未建档先 TOUCH/IMPACT / 重复 ORIGIN）在这里是**硬错误**：
 * Validator 在放行口已挡过一遍，折叠层再炸说明事件流本身不一致——
 * 失败关闭比静默跳过诚实（跳过会让投影与事件流永久漂移且无任何信号）。
 */
import { KernelError, type DomainEvent } from '../contracts/index.ts'
import { AFFECT_IMPACT, AFFECT_ORIGIN, AFFECT_TOUCH } from '../contracts/domain-event.ts'
import {
  AFFECT_PROJECTION_TYPE,
  UNORIGINATED_AFFECT_STATE,
  clampAffectArousal,
  clampAffectValence,
  decayAffectBetween,
  type AffectImpactPayload,
  type AffectOriginPayload,
  type AffectState,
  type AffectTouchPayload,
} from '../contracts/affect.ts'
import type { AffectSemanticImpactPayload } from '../contracts/affect-semantic.ts'
import type { CharacterId } from '../contracts/ids.ts'
import { defaultIsStale, type CharacterProjection, type ProjectionReducer } from '../contracts/projection.ts'

/** 本 reducer 会处理的全部事件类型（登记进投影信封的 reducer_version 守卫） */
export const AFFECT_HANDLED_EVENT_TYPES: readonly string[] = [
  AFFECT_ORIGIN,
  AFFECT_TOUCH,
  AFFECT_IMPACT,
]

/** 改折叠算法必须升版本（投影行的 reducer_version 会拒绝跨版本追加） */
export const AFFECT_REDUCER_VERSION = 'affect-reducer@1'

/**
 * M8.5 reducer@2（ADR-068 M85-D19）：新增 SOURCE_ANCHORED 分支——语义 IMPACT
 * 的衰减结算到 `payload.sourceAt`，**不推进** `lastInteractionAt`；无 timingKind
 * 的历史事件在 @2 下与 @1 逐字一致（混合重放 A==B）。
 *
 * ⚠️ 注册面纪律：@1 工厂（`affectReducerFor`）仍是现行注册——把运行时切到 @2
 * 是受控重建 + 激活批准范围内的事（WP8/激活段），不在本文件静默发生。
 */
export const AFFECT_REDUCER_V2_VERSION = 'affect-reducer@2'

// ---------------------------------------------------------------------------
// payload 读取（登记表在写入时已做结构校验；这里只做防御性收窄）
// ---------------------------------------------------------------------------

function originPayloadOf(event: DomainEvent): AffectOriginPayload | undefined {
  return event.payload as AffectOriginPayload | undefined
}

function touchPayloadOf(event: DomainEvent): AffectTouchPayload | undefined {
  return event.payload as AffectTouchPayload | undefined
}

function impactPayloadOf(event: DomainEvent): AffectImpactPayload | undefined {
  return event.payload as AffectImpactPayload | undefined
}

/**
 * 事件是否属于本 Character（owner 匹配；形状不对按"不是我的"处理）。
 *
 * 导出给 affect-store 的**按 owner 过滤重放**用：通用 `rebuildProjection` 只按
 * 事件类型过滤，会把别的 Character 的 AFFECT 事件折进本行（信封前进 ⇒
 * 乱序补投被误判过时 ⇒ A≠B）——单 Character 生产里这是防御层，但纪律与
 * relationship 的 `relationshipEventTargets` 同构（一个概念一处实现）。
 */
export function affectEventTargets(event: DomainEvent, owner: CharacterId): boolean {
  const payload =
    event.type === AFFECT_ORIGIN
      ? originPayloadOf(event)
      : event.type === AFFECT_TOUCH
        ? touchPayloadOf(event)
        : impactPayloadOf(event)
  if (payload === undefined) return false
  return String(payload.characterId) === String(owner)
}

// ---------------------------------------------------------------------------
// 纯折叠
// ---------------------------------------------------------------------------

/**
 * 折叠一个 Affect 事件（只处理本 Character 的事件；别人的事件返回原状态）。
 *
 * · ORIGIN：未建档 → 建档（中性起点 + cutover 边界 + 双锚）；已建档 → 硬错误。
 * · TOUCH：未建档 → 硬错误；已建档 → 只推进交互锚。
 * · IMPACT：未建档 → 硬错误；已建档 → 先折算衰减（锚 → 事件时间），
 *   再应用 delta（夹界防御），再推进双锚。
 * · IMPACT + `timingKind='SOURCE_ANCHORED'`（M8.5 语义负载）：
 *   - @1 折叠 ⇒ **硬错误**（语义负载要求 @2；@1 生产路径永远看不到它，
 *     看到说明事件流与注册面不一致——失败关闭比静默错折诚实）；
 *   - @2 折叠 ⇒ 衰减结算到 `sourceAt`，应用 delta，`lastAffectEventAt`
 *     前进到 `max(sourceAt, 旧锚)`（锚不后退——晚到的更早来源不"反衰减"），
 *     **`lastInteractionAt` 不推进**（M85-D19：慢路径晚到的 IMPACT 不得
 *     误刷新互动时间）。
 */
export function reduceAffectState(
  state: AffectState,
  event: DomainEvent,
  owner: CharacterId,
): AffectState {
  return foldAffectEvent(state, event, owner, 1)
}

/** reducer@2 折叠入口（历史事件与 @1 逐字一致；语义负载走 SOURCE_ANCHORED 分支） */
export function reduceAffectStateV2(
  state: AffectState,
  event: DomainEvent,
  owner: CharacterId,
): AffectState {
  return foldAffectEvent(state, event, owner, 2)
}

type AffectFoldVersion = 1 | 2

function foldAffectEvent(
  state: AffectState,
  event: DomainEvent,
  owner: CharacterId,
  version: AffectFoldVersion,
): AffectState {
  if (!AFFECT_HANDLED_EVENT_TYPES.includes(event.type)) return state
  if (!affectEventTargets(event, owner)) return state

  if (event.type === AFFECT_ORIGIN) {
    const payload = originPayloadOf(event)
    if (payload === undefined) return state
    if (state.originated) {
      throw new KernelError(
        'validation_error',
        'affect_origin_duplicate',
        `Character ${String(owner)} 的情绪投影已建档，ORIGIN 事件不能二次折叠` +
          '（Validator 应已拦截；折叠层防御性失败关闭）',
      )
    }
    return {
      originated: true,
      valence: clampAffectValence(payload.initialValence),
      arousal: clampAffectArousal(payload.initialArousal),
      originKind: payload.originKind,
      lastInteractionAt: event.createdAt,
      lastAffectEventAt: event.createdAt,
      lastDomainEventId: event.id,
      cutoverSequence: payload.cutoverSequence,
    }
  }

  if (event.type === AFFECT_TOUCH) {
    const payload = touchPayloadOf(event)
    if (payload === undefined) return state
    if (!state.originated) {
      throw new KernelError(
        'validation_error',
        'affect_not_originated',
        `Character ${String(owner)} 的情绪投影尚未建档，TOUCH 事件无法折叠` +
          '（Validator 应已拦截；折叠层防御性失败关闭）',
      )
    }
    // M8-D07：只推进交互锚；valence/arousal 与情绪轴锚不动（见文件头 ②）
    return {
      ...state,
      lastInteractionAt: event.createdAt,
      lastDomainEventId: event.id,
    }
  }

  // ---- AFFECT_IMPACT ----
  const payload = impactPayloadOf(event)
  if (payload === undefined) return state
  if (!state.originated || state.lastAffectEventAt === null) {
    throw new KernelError(
      'validation_error',
      'affect_not_originated',
      `Character ${String(owner)} 的情绪投影尚未建档（或锚缺失），IMPACT 事件无法折叠` +
        '（Validator 应已拦截；折叠层防御性失败关闭）',
    )
  }

  // ---- M8.5 SOURCE_ANCHORED 分支（ADR-068 M85-D19）----
  const timingKind = (payload as Partial<AffectSemanticImpactPayload>).timingKind
  if (timingKind === 'SOURCE_ANCHORED') {
    if (version === 1) {
      throw new KernelError(
        'validation_error',
        'affect_semantic_payload_requires_reducer_v2',
        `Character ${String(owner)} 的语义 IMPACT（SOURCE_ANCHORED）命中 @1 折叠——` +
          '语义负载要求 affect-reducer@2（注册面不一致；失败关闭，不静默错折）',
      )
    }
    const sourceAt = Number((payload as AffectSemanticImpactPayload).sourceAt)
    if (!Number.isFinite(sourceAt)) {
      throw new KernelError(
        'validation_error',
        'affect_semantic_source_at_invalid',
        `Character ${String(owner)} 的语义 IMPACT 缺少合法 sourceAt（失败关闭）`,
      )
    }
    // ① 衰减结算到 sourceAt（to ≤ from 时 decayAffectBetween 原样返回——负时距不衰减）
    const decayed = decayAffectBetween(state, state.lastAffectEventAt, sourceAt as never)
    // ② 应用 delta（夹界防御）
    const valence = clampAffectValence(decayed.valence + payload.delta.deltaValence)
    const arousal = clampAffectArousal(decayed.arousal + payload.delta.deltaArousal)
    // ③ 情绪轴锚前进到 max(sourceAt, 旧锚)——锚不后退；交互锚不动（M85-D19）
    return {
      originated: true,
      valence,
      arousal,
      originKind: state.originKind,
      lastInteractionAt: state.lastInteractionAt,
      lastAffectEventAt: Math.max(sourceAt, Number(state.lastAffectEventAt)) as never,
      lastDomainEventId: event.id,
      cutoverSequence: state.cutoverSequence,
    }
  }

  // ---- 历史分支（@1/@2 逐字一致——混合重放 A==B 的机器基础）----
  // ① 事件间衰减结算（§5 规则 2：旧锚 → 本事件时间；纯函数，只用事件数据）
  const decayed = decayAffectBetween(state, state.lastAffectEventAt, event.createdAt)

  // ② 应用本事件 delta（夹界：Validator 挡超界，这里防御性收口）
  const valence = clampAffectValence(decayed.valence + payload.delta.deltaValence)
  const arousal = clampAffectArousal(decayed.arousal + payload.delta.deltaArousal)

  // ③ 推进双锚（情绪轴锚随 IMPACT 前进——衰减从新锚重新起算）
  return {
    originated: true,
    valence,
    arousal,
    originKind: state.originKind,
    lastInteractionAt: event.createdAt,
    lastAffectEventAt: event.createdAt,
    lastDomainEventId: event.id,
    cutoverSequence: state.cutoverSequence,
  }
}

// ---------------------------------------------------------------------------
// 工厂（per-character reducer 实例；单 Character 生产里只有一个）
// ---------------------------------------------------------------------------

/**
 * 为一个 Character 构建情绪投影 reducer。
 *
 * `isStale` 的两层判定（顺序重要）：
 *   1. 不是本 Character 的事件 → 跳过（**不推进信封**——见文件头 ①）；
 *   2. 本 Character 的事件 → 按序号单调（`defaultIsStale`：sequence ≤ 信封 = 过时）。
 */
export function affectReducerFor(owner: CharacterId): ProjectionReducer<AffectState> {
  return {
    projectionType: AFFECT_PROJECTION_TYPE,
    version: AFFECT_REDUCER_VERSION,
    handledEventTypes: AFFECT_HANDLED_EVENT_TYPES,
    initialState: () => UNORIGINATED_AFFECT_STATE,
    reduce: (state: AffectState, event: DomainEvent): AffectState =>
      reduceAffectState(state, event, owner),
    isStale: (projection: CharacterProjection<AffectState>, event: DomainEvent): boolean => {
      if (!affectEventTargets(event, owner)) return true
      return defaultIsStale(projection, event)
    },
  }
}

/**
 * reducer@2 工厂（M8.5 / ADR-068 M85-D19）。
 *
 * 与 @1 的唯一行为差异 = SOURCE_ANCHORED 分支；历史事件逐字一致。
 * **注册切换是受控重建 + 激活批准范围内的事**：在切换获批之前，
 * 运行时注册面继续用 `affectReducerFor`（@1）——本工厂只供 M8.5
 * worker 的隔离验证与激活演练使用。
 */
export function affectReducerV2For(owner: CharacterId): ProjectionReducer<AffectState> {
  return {
    projectionType: AFFECT_PROJECTION_TYPE,
    version: AFFECT_REDUCER_V2_VERSION,
    handledEventTypes: AFFECT_HANDLED_EVENT_TYPES,
    initialState: () => UNORIGINATED_AFFECT_STATE,
    reduce: (state: AffectState, event: DomainEvent): AffectState =>
      reduceAffectStateV2(state, event, owner),
    isStale: (projection: CharacterProjection<AffectState>, event: DomainEvent): boolean => {
      if (!affectEventTargets(event, owner)) return true
      return defaultIsStale(projection, event)
    },
  }
}
