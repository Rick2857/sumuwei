/**
 * Belief Reducer —— 把 `BELIEF_*` 事件折叠成信念投影行（M9 WP4 / ADR-070 §4.2）。
 *
 * ============================================================================
 *  与 memory / relationship / affect reducer 的结构差异：**一族多行**
 * ============================================================================
 * 前三者都是"一个投影类型一行"（memory 按 id 分行但走自己的 store）。信念域
 * 的投影是**三种行**，全部落在通用 `character_projections` 表（零新迁移）：
 *
 *     belief:origin                    → BeliefOriginState（一角色一行）
 *     belief:<beliefId>                → BeliefState（一信念一行；身份含修订链）
 *     belief:evidence:<fnv1aHex(key)>  → BeliefEvidenceAccumulation（一 (槽位,值) 一行）
 *
 * 因此本文件提供**按行的纯折叠函数** + 行定位助手；多行编排（读旧行 →
 * 定位受影响行 → 折叠 → 写回）在 `belief-store.ts`（事务内，apply 与
 * rebuild 同一条代码路径——"投影是缓存"的可执行证明，SC-005 同构）。
 *
 * ---------------------------------------------------------------------------
 *  折叠语义（与独立 oracle `evals/fixtures/m9/belief-oracle.ts` 逐字段对齐；
 *  `m9:verify` 三方比对：生产 reducer × oracle × 手写预期）
 * ---------------------------------------------------------------------------
 *   ORIGIN            首个建档生效；重复 ORIGIN = no-op（一角色一次）
 *   FORMED            新 beliefId → active；同 id 重放 = no-op（幂等，不并根）
 *   REINFORCED        仅 active 接受；新根去重后计入（INV-M9-08）；非 active = no-op
 *   DISPUTED          active → disputed；再 disputed = no-op
 *   SUPERSEDED        old → superseded（终态）；new 行由它自己的 FORMED 决定
 *   RETRACTED         → retracted（终态：重放旧证据不复活，B28）
 *
 * 证据累计行（oracle 不比对——它不属于信念状态机；门里与手写预期比对）：
 *   EVIDENCE_NOTED    追加去重根 + 会话；lastEvidenceAt 前进
 *   SUPERSEDED/RETRACTED（命中该值的行）→ **清零**：被取代/被撤回的值的
 *     累计不得再喂给同值新形成（否则"用户纠正后旧根又把旧值顶回来"）。
 *     已记事件都在（零累计丢失是对**事件流**的承诺；累计行是派生缓存）。
 *     已知保守边：争议窗口里"已记但未强化"的根会被一起清掉——它们既不
 *     被禁用也不再可用；失败关闭方向（少形成，绝不错形成），v1 接受。
 *
 * 三条禁令照旧：不调 LLM、不读挂钟（时间一律 `event.createdAt`）、不写库。
 * 语义违规（未建档先 FORMED）在 Validator 已挡；折叠层对**孤儿事件**
 * （引用不存在的 beliefId）按 no-op 处理（重放历史可能从中间开始——
 * 行存在性由 store 编排保证，这里不炸）。
 */
import type { DomainEvent } from '../contracts/index.ts'
import {
  BELIEF_DISPUTED,
  BELIEF_EVIDENCE_NOTED,
  BELIEF_FORMED,
  BELIEF_ORIGIN,
  BELIEF_REINFORCED,
  BELIEF_RETRACTED,
  BELIEF_SUPERSEDED,
} from '../contracts/domain-event.ts'
import {
  BELIEF_ORIGIN_PROJECTION_TYPE,
  beliefEvidenceProjectionTypeOf,
  beliefSlotKeyOf,
  type BeliefDisputedPayload,
  type BeliefEvidenceAccumulation,
  type BeliefEvidenceNotedPayload,
  type BeliefFormedPayload,
  type BeliefOriginPayload,
  type BeliefOriginState,
  type BeliefProposition,
  type BeliefReinforcedPayload,
  type BeliefRetractedPayload,
  type BeliefSlotKeyInput,
  type BeliefState,
  type BeliefSupersededPayload,
} from '../contracts/belief.ts'
import type { CharacterId } from '../contracts/ids.ts'

/** 本 reducer 会处理的全部事件类型 */
export const BELIEF_HANDLED_EVENT_TYPES: readonly string[] = [
  BELIEF_ORIGIN,
  BELIEF_EVIDENCE_NOTED,
  BELIEF_FORMED,
  BELIEF_REINFORCED,
  BELIEF_DISPUTED,
  BELIEF_SUPERSEDED,
  BELIEF_RETRACTED,
]

/** 改折叠算法必须升版本（投影行的 reducer_version 拒绝跨版本追加） */
export const BELIEF_REDUCER_VERSION = 'belief-reducer@1'

// ---------------------------------------------------------------------------
// payload 读取（登记表在写入时已做结构校验；这里只做防御性收窄）
// ---------------------------------------------------------------------------

function payloadOf<T>(event: DomainEvent): T | undefined {
  return event.payload as T | undefined
}

/** 事件是否属于本 Character（owner 匹配；形状不对按"不是我的"处理） */
export function beliefEventTargets(event: DomainEvent, owner: CharacterId): boolean {
  const payload = payloadOf<{ characterId?: string }>(event)
  if (payload === undefined) return false
  return String(payload.characterId) === String(owner)
}

// ---------------------------------------------------------------------------
// 行定位（store 编排用：一个事件 → 受影响的投影行键）
// ---------------------------------------------------------------------------

/** ORIGIN 行键（一角色一行） */
export function beliefOriginRowKey(): string {
  return BELIEF_ORIGIN_PROJECTION_TYPE
}

/** 信念行键 */
export function beliefRowKeyOf(beliefId: string): string {
  return `belief:${String(beliefId)}`
}

/** 证据累计行键（(槽位, 值) 复合——value 不进信念槽位键，但进累计键） */
export function beliefEvidenceRowKeyOf(
  input: BeliefSlotKeyInput & { value: BeliefProposition['value'] },
): string {
  const slotKey = beliefSlotKeyOf(input)
  return beliefEvidenceProjectionTypeOf(`${slotKey}|${String(input.value)}`)
}

/** EVIDENCE_NOTED 命中的证据行键（payload 自带全部槽位分量） */
export function evidenceRowKeyOfNoted(event: DomainEvent): string | undefined {
  if (event.type !== BELIEF_EVIDENCE_NOTED) return undefined
  const payload = payloadOf<BeliefEvidenceNotedPayload>(event)
  if (payload === undefined) return undefined
  return beliefEvidenceRowKeyOf({
    perspectiveOwnerId: payload.perspectiveOwnerId,
    subject: payload.subject,
    predicate: payload.predicate,
    scopeKey: payload.scopeKey,
    value: payload.value,
  })
}

// ---------------------------------------------------------------------------
// 纯折叠：origin 行
// ---------------------------------------------------------------------------

/** ORIGIN 行折叠：首个生效；重复 = no-op（Validator 挡一遍，折叠层宽容重放） */
export function reduceBeliefOriginState(
  state: BeliefOriginState | undefined,
  event: DomainEvent,
): BeliefOriginState | undefined {
  if (event.type !== BELIEF_ORIGIN) return state
  if (state !== undefined && state.originated) return state
  const payload = payloadOf<BeliefOriginPayload>(event)
  if (payload === undefined) return state
  return {
    originated: true,
    activationId: payload.activationId,
    cutoverSequence: payload.cutoverSequence,
    policyVersion: payload.policyVersion,
    originatedAt: event.createdAt,
  }
}

// ---------------------------------------------------------------------------
// 纯折叠：单信念行（与 oracle 的 beliefs[beliefId] 折叠逐字段对齐）
// ---------------------------------------------------------------------------

/**
 * 单信念行折叠。`state === undefined` = 该信念尚无行（FORMED 建行；
 * 其它事件类型对不存在的信念 = no-op——重放可能从事件流中段开始）。
 */
export function reduceBeliefState(
  state: BeliefState | undefined,
  event: DomainEvent,
): BeliefState | undefined {
  switch (event.type) {
    case BELIEF_FORMED: {
      const payload = payloadOf<BeliefFormedPayload>(event)
      if (payload === undefined) return state
      if (state !== undefined) return state // 同 id 重放 = no-op（幂等，不并根）
      return {
        beliefId: payload.beliefId,
        perspectiveOwnerId: payload.perspectiveOwnerId,
        subject: payload.subject,
        proposition: payload.proposition,
        epistemicKind: payload.epistemicKind,
        status: 'active',
        supportLevel: payload.supportLevel,
        evidenceRefs: [...payload.evidenceRootIds],
        evidenceRootIds: [...payload.evidenceRootIds],
        dependsOnMemoryIds: [...(payload.dependsOnMemoryIds ?? [])],
        ruleId: payload.ruleId,
        ruleVersion: payload.ruleVersion,
      }
    }
    case BELIEF_REINFORCED: {
      const payload = payloadOf<BeliefReinforcedPayload>(event)
      if (payload === undefined || state === undefined) return state
      if (state.status !== 'active') return state // disputed/superseded/retracted 不加支持
      return {
        ...state,
        evidenceRefs: mergeUnique(state.evidenceRefs, payload.newRootIds),
        evidenceRootIds: mergeUnique(state.evidenceRootIds, payload.newRootIds),
      }
    }
    case BELIEF_DISPUTED: {
      const payload = payloadOf<BeliefDisputedPayload>(event)
      if (payload === undefined || state === undefined) return state
      if (state.status !== 'active') return state
      return { ...state, status: 'disputed' }
    }
    case BELIEF_SUPERSEDED: {
      const payload = payloadOf<BeliefSupersededPayload>(event)
      if (payload === undefined || state === undefined) return state
      // 本行是 old：进入终态（已是终态 = no-op）；本行是 new：状态由自己的事件决定
      if (String(state.beliefId) !== String(payload.oldBeliefId)) return state
      if (state.status === 'superseded' || state.status === 'retracted') return state
      return { ...state, status: 'superseded' }
    }
    case BELIEF_RETRACTED: {
      const payload = payloadOf<BeliefRetractedPayload>(event)
      if (payload === undefined || state === undefined) return state
      if (String(state.beliefId) !== String(payload.beliefId)) return state
      return { ...state, status: 'retracted' } // 终态：后续事件对本行一律 no-op
    }
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// 纯折叠：证据累计行
// ---------------------------------------------------------------------------

/**
 * 证据累计行折叠。`reset` 由 store 编排在 SUPERSEDED/RETRACTED 时传入
 * （清零该值的累计——见文件头；重放同一事件序列必然复现同样的清零）。
 */
export function reduceBeliefEvidenceAccumulation(
  state: BeliefEvidenceAccumulation | undefined,
  event: DomainEvent,
): BeliefEvidenceAccumulation | undefined {
  if (event.type !== BELIEF_EVIDENCE_NOTED) return state
  const payload = payloadOf<BeliefEvidenceNotedPayload>(event)
  if (payload === undefined) return state

  const slotKey = beliefSlotKeyOf({
    perspectiveOwnerId: payload.perspectiveOwnerId,
    subject: payload.subject,
    predicate: payload.predicate,
    scopeKey: payload.scopeKey,
  })
  const base: BeliefEvidenceAccumulation =
    state !== undefined && state.value === payload.value
      ? state
      : {
          slotKey,
          predicate: payload.predicate,
          scopeKey: payload.scopeKey,
          value: payload.value,
          rootIds: [],
          conversationIds: [],
          firstEvidenceAt: event.createdAt,
          lastEvidenceAt: event.createdAt,
          ruleId: payload.ruleId,
          ruleVersion: payload.ruleVersion,
        }
  if (base.rootIds.some((id) => String(id) === String(payload.rootEventId))) {
    return base // 同根重复 = no-op（INV-M9-04：重复投递不能多计）
  }
  return {
    ...base,
    rootIds: [...base.rootIds, payload.rootEventId],
    conversationIds: mergeUnique(base.conversationIds, [payload.conversationId]),
    firstEvidenceAt: base.firstEvidenceAt,
    lastEvidenceAt: event.createdAt,
  }
}

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

function mergeUnique<T extends string>(existing: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set<string>(existing.map(String))
  const merged = [...existing]
  for (const item of incoming) {
    if (!seen.has(String(item))) {
      seen.add(String(item))
      merged.push(item)
    }
  }
  return merged
}
