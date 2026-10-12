/**
 * Relationship 契约 —— **"她如何看待与某个实体的关系"**（M7 / ADR-064）。
 *
 * ============================================================================
 *  ADR-064（ACCEPTED / DESIGN FROZEN，2026-09-26 用户裁定「按推荐执行」）
 * ============================================================================
 * 本文件是 M7 WP2 的合同层：**只定义语义与纯函数，不实现任何 store**。
 * 实现归属：提案器（WP3）、Validator/Reducer/Projection（WP4）、Context 接线（WP5）。
 *
 * 语义要点（逐条来自已裁定的 ADR-064）：
 *   D-1  关系键 = `EntityRelationKey { owner, target }`（entity.ts 的冻结形状，
 *        FC-05/ADR-018）；投影作用域编进 projectionType：`relationship:<kind>:<id>`。
 *   D-2  维度 = trust 与 closeness（刻意分开，§4.4 不变量：不可合并成"好感度"）；
 *        单事件变化上限 |Δtrust| ≤ 0.05 · |Δcloseness| ≤ 0.03（关系是慢变量）。
 *   D-3  证据等级：只有 **confirmed 的用户直接互动**（`sourceQualificationOf`
 *        派生出 `ESTABLISHED`）能推动关系；她的生成 / 工具 / 摘要 / 未确立归因
 *        一律 Tier 0（失败关闭）。
 *   D-5  时间语义：closeness 超过 24h 无关系证据事件每天侵蚀 0.02；
 *        trust **永不**随时间变化；衰减不可逆（回来不自动回弹）。
 *   D-7  originKind 三值从第一天就存在（SETTING_BASELINE / INTERACTION_DERIVED /
 *        MAINTENANCE_INJECTION 预留）—— 未来若注入，来源可判（INV-CI-01）。
 *
 * 依赖方向（§2 单向铁律）：本文件只 import `ids.ts` / `entity.ts` / `attribution.ts`
 * （均为 contracts 叶子，不反向到达 `domain-event.ts`）。
 * `domain-event.ts → relationship.ts` 是**单向**的（登记事件类型时），
 * 与 `domain-event.ts → memory.ts` 的既有先例同构。
 */

import { KernelError, type ConversationEventId, type DomainEventId, type EntityId, type Timestamp } from './ids.ts'
import { ENTITY_KINDS, entityRef, isEntityKind, type EntityKind, type EntityRef, type EntityRelationKey } from './entity.ts'
import { sourceQualificationOf, type TrustedOriginReading } from './attribution.ts'

// ---------------------------------------------------------------------------
// D-1：关系键与投影作用域
// ---------------------------------------------------------------------------

/**
 * 关系投影的 projectionType（作用域编进类型，projection-model.md 的约定）。
 *
 * `(characterId, projectionType)` 全局唯一：characterId 即 owner（视角拥有者），
 * target 编进 projectionType —— 第一阶段唯一实例是 `relationship:user:<userId>`。
 */
export function relationshipProjectionType(target: EntityRef): string {
  return `relationship:${target.kind}:${String(target.id)}`
}

/** 读回用：解析关系投影类型；不是关系投影 / kind 未登记 / id 为空 ⇒ undefined（不猜） */
export function parseRelationshipProjectionType(projectionType: string): EntityRef | undefined {
  const parts = projectionType.split(':')
  if (parts.length !== 3 || parts[0] !== 'relationship') return undefined
  const kind = parts[1]
  const id = parts[2]
  if (!isEntityKind(kind) || id === '') return undefined
  try {
    return entityRef(kind, id)
  } catch {
    return undefined
  }
}

/** 构造关系键（owner 恒为视角拥有者角色；M7 只有苏沐薇一个 owner） */
export function relationshipKey(owner: EntityId, target: EntityId): EntityRelationKey {
  return { owner, target }
}

// ---------------------------------------------------------------------------
// D-2：维度、界与单事件上限
// ---------------------------------------------------------------------------

/** 关系是两个**独立**维度的当前值（§4.4：不可合并） */
export interface RelationshipDelta {
  trust: number
  closeness: number
}

export const RELATIONSHIP_VALUE_MIN = 0
export const RELATIONSHIP_VALUE_MAX = 1

/** 单事件上限（ADR-064 D-2；语义来源：src/state/types.ts 的既有 MAX_DELTA_PER_TURN） */
export const MAX_TRUST_DELTA_PER_EVENT = 0.05
export const MAX_CLOSENESS_DELTA_PER_EVENT = 0.03

/** 浮点容差：只吸收求和噪声（如 0.02+0.03），**不是**放宽上限 */
const DELTA_EPSILON = 1e-9

/** 值夹回 [0,1]（reducer 的最后一道防线；非有限数直接抛——不猜） */
export function clampRelationshipValue(value: number): number {
  if (!Number.isFinite(value)) {
    throw new KernelError(
      'validation_error',
      'relationship_value_not_finite',
      `关系值必须是有限数字，收到 ${String(value)}`,
    )
  }
  return Math.min(RELATIONSHIP_VALUE_MAX, Math.max(RELATIONSHIP_VALUE_MIN, value))
}

/**
 * delta 是否在单事件上限内（Validator 的放行判据；超界**拒绝**，不静默夹——
 * 计划 §3.1.5"单轮上限必须是程序判据"）。
 */
export function relationshipDeltaWithinBounds(delta: RelationshipDelta): boolean {
  return (
    Number.isFinite(delta.trust) &&
    Number.isFinite(delta.closeness) &&
    Math.abs(delta.trust) <= MAX_TRUST_DELTA_PER_EVENT + DELTA_EPSILON &&
    Math.abs(delta.closeness) <= MAX_CLOSENESS_DELTA_PER_EVENT + DELTA_EPSILON
  )
}

// ---------------------------------------------------------------------------
// D-7：来源种类（originKind 三值——第一天就全登记）
// ---------------------------------------------------------------------------

/**
 * 这条关系认知**从哪来**。
 *
 * - `SETTING_BASELINE`：用户授权的角色设定基线（M7 的 ORIGIN 事件用一个；
 *   U-M7-02 裁定：0.85/0.60，依据是"十几年共同长大"的角色设定——是设定，不是经历）。
 * - `INTERACTION_DERIVED`：由真实互动证据推导（M7 的 IMPACT 事件恒为此值；
 *   未来的"自然建档"ORIGIN 也用它）。
 * - `MAINTENANCE_INJECTION`：**预留，M7 不实现**。开发者/管理员直接注入关系状态
 *   = Cognitive Intervention（cognitive-integrity.md §4A），必须走显式警告 · dry-run ·
 *   操作者身份 · 审计的全链。M7 的 Validator 对它**失败关闭**（一律拒绝）；
 *   登记它是为了让"未来若注入，来源从第一天就可判"（INV-CI-01，U-M7-07 裁定）。
 */
export type RelationshipOriginKind =
  | 'SETTING_BASELINE'
  | 'INTERACTION_DERIVED'
  | 'MAINTENANCE_INJECTION'
  /**
   * **后 Lv2 · S8 / ADR-093 `D09`**：由**已提交的世界账本**经封闭故事规则形成。
   *
   * ⚠️ 只有 `interaction_kind = user_choice` 且**服务端绑定到当前真实用户**的故事提交
   * 才允许用它（NPC 台词 / 作者设定 / 剧情内"信任"一律不合格）。
   */
  | 'STORY_DERIVED'

export const RELATIONSHIP_ORIGIN_KINDS: readonly RelationshipOriginKind[] = [
  'SETTING_BASELINE',
  'INTERACTION_DERIVED',
  'MAINTENANCE_INJECTION',
  'STORY_DERIVED',
]

export function isRelationshipOriginKind(value: unknown): value is RelationshipOriginKind {
  return typeof value === 'string' && (RELATIONSHIP_ORIGIN_KINDS as readonly string[]).includes(value)
}

/** M7 放行口实际接受的 originKind（MAINTENANCE_INJECTION 登记但拒绝） */
export function originKindAcceptedByM7(kind: RelationshipOriginKind): boolean {
  return kind === 'SETTING_BASELINE' || kind === 'INTERACTION_DERIVED' || kind === 'STORY_DERIVED'
}

/** U-M7-02 裁定的设定基线（ORIGIN 事件携带；来源 = 用户 2026-09 授权的角色设定） */
export const RELATIONSHIP_SETTING_BASELINE: Readonly<RelationshipDelta> = {
  trust: 0.85,
  closeness: 0.6,
}

// ---------------------------------------------------------------------------
// 投影状态（CharacterProjection<RelationshipState> 的 TState）
// ---------------------------------------------------------------------------

/**
 * 关系投影的本体状态。
 *
 * ⚠️ 版本 / 时间 / 来源事件在投影**信封**上（`CharacterProjection` 的
 * revision / reducerVersion / lastDomainEventId / updatedAt），不在这里重复。
 *
 * `lastInteractionAt` 是**衰减锚**：最近一次关系证据事件的发生时间，
 * 由 reducer 从**事件自身的时间戳**折叠（不是挂钟——reducer 纯度，ADR-003）。
 * 读时衰减（`effectiveRelationship`）以它为起点计算"当前疏远了多少"。
 *
 * `accusationsInCase` 是**在案指控登记表**（WP4 / ADR-064 §5.2 澄清）：
 * 已折叠、尚未被撤回的 R-3 IMPACT 事件（id + delta + 折叠时间）。
 * 一个字段服务三处，单一事实源：
 *   · reducer 折叠撤回形（R-4b）时按它**反向扣除**被撤回指控的 delta
 *     （"supersede 后旧事件不再驱动投影"——ADR §9 的字面要求）；
 *   · Validator 的在案检查（supersedes 目标必须在案，防双撤回）；
 *   · Job 构建评估器输入（activeAccusationEventIds）。
 * 撤回时条目移除（登记表有界：在案数 ≤ 历史指控数，而指控本身受
 * 单事件 −0.05 上限约束——trust 触底前条目数有限）。
 */
export interface RelationshipState {
  /** 是否已建档（ORIGIN 事件已折叠）。未建档时 trust/closeness 无意义 */
  originated: boolean
  trust: number
  closeness: number
  /** 建档来源（ORIGIN 事件的 originKind；未建档 = null） */
  originKind: RelationshipOriginKind | null
  /** 最近一次关系证据事件时间（衰减锚；未建档 = null） */
  lastInteractionAt: Timestamp | null
  /** 在案指控登记表（见接口注释；未建档 = 空数组） */
  accusationsInCase: readonly RelationshipAccusationInCase[]
}

/** 在案指控的一条登记（reducer 折叠 R-3 时追加；R-4b 撤回时移除并反扣 delta） */
export interface RelationshipAccusationInCase {
  /** 被登记的 R-3 IMPACT 域事件 id（撤回形 supersedes 指向它） */
  domainEventId: DomainEventId
  /** 该指控事件折叠时的 delta（撤回时按它反向扣除） */
  delta: RelationshipDelta
  /** 折叠时间（事件时间戳；审计用） */
  foldedAt: Timestamp
}

/** 空投影初始状态（reducer 的 `initialState()` 用；纯常量，不读时间/配置） */
export const UNORIGINATED_RELATIONSHIP_STATE: RelationshipState = {
  originated: false,
  trust: 0,
  closeness: 0,
  originKind: null,
  lastInteractionAt: null,
  accusationsInCase: [],
}

// ---------------------------------------------------------------------------
// D-5：时间语义（衰减）
// ---------------------------------------------------------------------------

export const RELATIONSHIP_DECAY_RULE_VERSION = 1

/**
 * 衰减参数（ADR-064 D-5 裁定；语义来源：src/state/decay.ts 的既有契约）。
 *
 * - 超过 24h 无关系证据事件：closeness 每天侵蚀 0.02；
 * - trust 恒 0：**疏远 ≠ 失信**，失信走事件通道；
 * - 衰减不可逆：回来不自动回弹，靠真实互动重新累积（计划 §6 场景 5）。
 */
export const RELATIONSHIP_DECAY = {
  absenceThresholdMs: 24 * 60 * 60 * 1000,
  closenessLossPerDay: 0.02,
  trustLossPerDay: 0,
} as const

const DAY_MS = 24 * 60 * 60 * 1000

/** R-1 陪伴单元的自然日口径：UTC+8 固定偏移（她的用户在中文时区；确定性优先，不引 TZ 库） */
const RELATIONSHIP_DAY_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 纯函数：时间戳 → R-1 陪伴单元的自然日（ISO 日期，UTC+8 口径）。
 *
 * 同一实现服务两处（一个概念一处实现）：
 *   · 评估器按它把窗口消息分进"陪伴日"（`unit` 字段的来源）；
 *   · Validator / 审计按它从事件时间戳复核 `unit` 的口径。
 * 确定性：同一时间戳永远同一日——不依赖运行环境时区。
 */
export function relationshipDayOf(timestamp: Timestamp): string {
  return new Date(timestamp + RELATIONSHIP_DAY_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 纯函数：给定起止时刻，计算 closeness 因疏远侵蚀后的值。
 *
 * 规则：`to ≤ from` ⇒ 原值；不足免侵蚀阈值 ⇒ 原值；
 * 超出部分按 `closenessLossPerDay` 线性侵蚀，下限 0。
 *
 * ⚠️ 同一实现服务两处（一个概念一处实现）：
 *   · reducer 折叠 IMPACT 时结算**事件之间**的历史疏远（输入全部来自事件时间戳——纯）；
 *   · 读路径计算**当前**疏远（输入的 `to` 是挂钟——但那在读侧，不在 reducer）。
 */
export function erodeClosenessForAbsence(closeness: number, from: Timestamp, to: Timestamp): number {
  if (to <= from) return clampRelationshipValue(closeness)
  const absenceMs = to - from - RELATIONSHIP_DECAY.absenceThresholdMs
  if (absenceMs <= 0) return clampRelationshipValue(closeness)
  const loss = (absenceMs / DAY_MS) * RELATIONSHIP_DECAY.closenessLossPerDay
  return clampRelationshipValue(closeness - loss)
}

/**
 * 读时视图：当前有效关系 = 投影本体 + 自衰减锚以来的疏远侵蚀。
 *
 * 纯函数、**不回写**：投影本体永远是事件折叠结果（重放 A==B 的基础）；
 * "她现在实际如何待你" = 本函数的输出（WP5 的 Context 只读这一层）。
 * 未建档 ⇒ 原样返回（没有关系可侵蚀）。
 */
export function effectiveRelationship(state: RelationshipState, now: Timestamp): RelationshipState {
  if (!state.originated || state.lastInteractionAt === null) return state
  return {
    ...state,
    closeness: erodeClosenessForAbsence(state.closeness, state.lastInteractionAt, now),
  }
}

// ---------------------------------------------------------------------------
// D-6：行为接线（关系 → 上下文的唯一注入块）
// ---------------------------------------------------------------------------

/**
 * 渲染输入：读时视图 + 挂钟 + 投影信封。
 *
 * `effective` 必须是 `effectiveRelationship` 的输出（当前疏远已结算）；
 * `projection` 是投影行的信封（revision / updatedAt），进来源引用与版本行。
 */
export interface RelationshipRenderInput {
  effective: RelationshipState
  now: Timestamp
  projection: { revision: number; updatedAt: number }
}

/**
 * 关系注入块的确定性渲染（ADR-064 D-6：单一注入块）。
 *
 * 输入相同 ⇒ 输出逐字节相同（可审计链条：数值 → 语义 → 行为倾向）。
 * 返回 `undefined` ⇔ 未建档 ⇒ 调用方产 **0 个 section**（prompt 安静）。
 *
 * 措辞纪律（D-6 逐字）：
 *   · 只渲染**当前状态与表达方式**，不叙述事件、不补造共同经历；
 *   · 分档措辞逐字移植自 M2 的 `renderStateBlock`（L1-M2 验收过的映射，
 *     换一套等于把已验收的行为改掉）；
 *   · trust 与 closeness **联合**判断（很亲近但不信 ≠ 又疏远又不信——
 *     这是 WP5 出口条件"联合行为规则"的机制）。
 */
export function renderRelationshipGuidance(input: RelationshipRenderInput): string | undefined {
  const s = input.effective
  if (!s.originated) return undefined

  const describeTrust = (trust: number): string => {
    if (trust >= 0.8) return '非常信任对方，几乎不设防'
    if (trust >= 0.6) return '比较信任对方'
    if (trust >= 0.4) return '信任程度一般，会保留一部分判断'
    if (trust >= 0.2) return '不太信任对方，会提防'
    return '几乎不信任对方'
  }
  const describeCloseness = (closeness: number): string => {
    if (closeness >= 0.8) return '觉得对方非常亲近，是自己人'
    if (closeness >= 0.6) return '和对方很亲近'
    if (closeness >= 0.4) return '与对方有一定距离感'
    if (closeness >= 0.2) return '和对方比较疏远'
    return '感觉与对方已经很生疏'
  }

  /*
   * 联合行为规则（L1-M2 验收措辞逐字移植，来源 src/state/provider.ts）：
   * 同样是低信任，「很亲近却不信」与「又疏远又不信」是完全不同的两种态度——
   * 前者是受伤、起疑、想弄清为什么；后者才是冷淡与客气。
   */
  const guidance: string[] = []
  if (s.trust <= 0.3) {
    if (s.closeness >= 0.5) {
      guidance.push(
        '你对对方信任度很低，但你们本该很亲近，这让你像被辜负了一样：' +
          '你会直接表达受伤与怀疑、追问缘由，而不是客套疏远。'
      )
    } else {
      guidance.push('你对对方既疏远又不太信任：会保持客气与距离，不愿多说自己的事。')
    }
  } else if (s.trust >= 0.8) {
    guidance.push('你完全信任对方，不会去揣测他的动机。')
  }

  if (s.closeness <= 0.3) {
    guidance.push(
      '你感到与对方生疏了：不会主动示好，不会提共同回忆，称呼与语气都会退回到客气的位置。'
    )
  } else if (s.closeness >= 0.75) {
    guidance.push('你觉得与对方非常亲近，会自然地流露在意，甚至直接表达不痛快。')
  }

  // 嘴硬掩饰的 closeness 支（M2 联合规则的另一半；valence 支留在情绪块，归 M8）
  if (s.closeness < 0.4) {
    guidance.push('按你的性子，这些情绪你不会直说，而是藏在更短、更平的句子里；越是在意，越不肯承认。')
  }

  // 缺席说明（与 M2 的 decayNote 同形；口径 = 关系证据事件，见 §5.1 ④）
  const absenceLines: string[] = []
  if (s.lastInteractionAt !== null) {
    const absenceHours = (input.now - s.lastInteractionAt) / 3_600_000
    if (absenceHours > 0) {
      const absentHours = Math.max(0, absenceHours - RELATIONSHIP_DECAY.absenceThresholdMs / 3_600_000)
      absenceLines.push(
        absentHours > 0
          ? `（距上次互动已过 ${absenceHours.toFixed(1)} 小时，其中 ${absentHours.toFixed(1)} 小时属于长期分开）`
          : `（距上次互动已过 ${absenceHours.toFixed(1)} 小时）`
      )
    }
  }

  return [
    '# 你们此刻的关系',
    '',
    '（下面是你此刻对对方的真实感受，会直接影响你的语气与态度；',
    '不要向对方复述这些数值，只让它们体现在你的回应方式里；',
    '也不要借此编造或补叙你们没有发生过的事。）',
    '',
    `trust（信任）: ${s.trust.toFixed(2)}   → ${describeTrust(s.trust)}`,
    `closeness（亲近）: ${s.closeness.toFixed(2)}   → ${describeCloseness(s.closeness)}`,
    '',
    '## 此刻的行为倾向',
    ...guidance.map((x) => `- ${x}`),
    '',
    ...absenceLines,
    `（关系投影 r${input.projection.revision} · 更新于 ${new Date(input.projection.updatedAt).toISOString()}）`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// D-3：证据等级（Tier 1 的唯一判据）
// ---------------------------------------------------------------------------

export const RELATIONSHIP_EVIDENCE_RULE_VERSION = 1

/**
 * 证据候选的**结构性**视图。
 *
 * 刻意不 import `processor.ts`（那会经 proposal.ts 反向到达 domain-event.ts，
 * 形成循环）：`ProcessorEventView` 结构上满足本形状，调用方直接传即可。
 */
export interface RelationshipEvidenceCandidateView {
  id: ConversationEventId
  type: string
  trustedOrigin?: TrustedOriginReading
}

export type RelationshipEvidenceVerdict =
  | { ok: true; qualifiedEventIds: ConversationEventId[] }
  | {
      ok: false
      code: 'relationship_evidence_missing' | 'relationship_evidence_not_qualified'
      detail: string
    }

/**
 * Tier 1 判据（ADR-064 D-3；失败关闭）：
 *
 * ```text
 * 通过   ⇔ 候选非空，且每一条都是 user_message 且来源资格 = ESTABLISHED
 *         （资格由 sourceQualificationOf 派生——ADR-043 的唯一实现，不另造判据）
 * 不过   ⇔ 空候选 / 非 user_message / 资格不是 ESTABLISHED
 *         （她的生成、工具、系统、未确立归因、UNCONFIRMED/CONTRADICTED 一律 Tier 0）
 * ```
 *
 * "每一条都必须合格"而不是"至少一条"：`sourceConversationEventIds` 的语义是
 * **因果**（"由哪些对话引起"）——把她的回复混进因果集是 Tier 0 污染，
 * 哪怕旁边还躺着一条合格的用户消息。
 */
export function relationshipEvidenceVerdictOf(
  candidates: readonly RelationshipEvidenceCandidateView[],
): RelationshipEvidenceVerdict {
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'relationship_evidence_missing',
      detail: 'IMPACT 必须引用至少一条真实对话事件（ADR-064 D-3：无证据不变化）',
    }
  }
  const qualified: ConversationEventId[] = []
  for (const candidate of candidates) {
    if (candidate.type !== 'user_message') {
      return {
        ok: false,
        code: 'relationship_evidence_not_qualified',
        detail:
          `事件 ${String(candidate.id)} 的 type=${candidate.type}：` +
          '关系证据只能是用户的直接互动（user_message），她的生成/工具/系统一律 Tier 0',
      }
    }
    const qualification = sourceQualificationOf(candidate.trustedOrigin)
    if (qualification !== 'ESTABLISHED') {
      return {
        ok: false,
        code: 'relationship_evidence_not_qualified',
        detail:
          `事件 ${String(candidate.id)} 的来源资格是 ${qualification}：` +
          '要求 ESTABLISHED（ADR-064 D-3 Tier 1；资格派生见 ADR-043 §3.2）',
      }
    }
    qualified.push(candidate.id)
  }
  return { ok: true, qualifiedEventIds: qualified }
}

// ---------------------------------------------------------------------------
// 域事件 payload（类型登记在 domain-event.ts；形状在这里）
// ---------------------------------------------------------------------------

/** `RELATIONSHIP_ORIGIN` 的 payload：建档（基线必须有来源——计划 §6 场景 1） */
export interface RelationshipOriginPayload {
  /** 完整关系键（审计自包含；owner 必须等于事件的 characterId，否则 owner_mismatch） */
  key: EntityRelationKey
  /** 目标种类（key 只带 id；projectionType 与审计需要 kind） */
  targetKind: EntityKind
  trust: number
  closeness: number
  originKind: RelationshipOriginKind
  /** 非空：这条基线凭什么成立（如"用户 2026-09 授权的角色设定"） */
  basis: string
}

/** `RELATIONSHIP_IMPACT` 的 payload：一次有界的关系变化 */
export interface RelationshipImpactPayload {
  key: EntityRelationKey
  targetKind: EntityKind
  /** 有界 delta（Validator 按 relationshipDeltaWithinBounds 放行；reducer 再夹 [0,1] 兜底） */
  delta: RelationshipDelta
  /** 冻结规则集（ADR-064 附录 A）里触发本变化的规则 id */
  ruleId: string
  /**
   * 幂等单元（WP4 澄清：加进 payload，让幂等键**从事件自身可推导**）：
   *   r1 → 自然日 ISO（`relationshipDayOf`，UTC+8）· r2/r3/r4 → 'window' ·
   *   r5-messages → 'messages-<n>' · r5-days → 'days-<n>'
   * 同一 (operation, ruleId, unit) 的重复提案必然撞键——r1 的"同一天最多计一次"、
   * r5 的"同一里程碑最多计一次"都由它保证（键的 range 分量对 r1 刻意置零，见 Validator）。
   */
  unit: string
  /**
   * 本事件的认知来源。M7 的 Validator 只放行 `INTERACTION_DERIVED`；
   * `MAINTENANCE_INJECTION` 登记但**失败关闭**（未来走 Cognitive Intervention 时另行开闸）。
   */
  originKind: RelationshipOriginKind
  /** 纠正/撤回链（计划 §6 场景 11）：本事件取代哪条旧 IMPACT、为什么 */
  supersedes?: { domainEventId: DomainEventId; reason: string }
  /**
   * **S8 / ADR-093 `D09`**：规则表版本（**可选、只追加**）。
   *
   * ```text
   * 缺省（旧生产者不写）  ⇒ 走 ADR-064 附录 A 的既有规则集（行为逐字不变）
   * 'story-relationship@1' ⇒ 走 S8 的故事规则表（放行口按它**选表**，并要求精确增量 + STORY_DERIVED）
   * ```
   */
  ruleVersion?: string
  /** 人类可读说明（进 trace 与审计；不进任何 prompt） */
  note?: string
}

// ---------------------------------------------------------------------------
// 提案类型名（proposal.proposalType 的受控值）
// ---------------------------------------------------------------------------

export const RELATIONSHIP_ORIGIN_PROPOSAL_TYPE = 'relationship-origin' as const
export const RELATIONSHIP_IMPACT_PROPOSAL_TYPE = 'relationship-impact' as const

// ---------------------------------------------------------------------------
// 拒绝理由码（WP4 Validator 的受控登记表；WP2 先冻结语义）
// ---------------------------------------------------------------------------

export interface RelationshipRejectionSpec {
  readonly code: string
  readonly description: string
}

/**
 * 关系链的全部具名拒绝码。
 *
 * 纪律（M6-FMB-01 §3 的硬顺序对关系同样适用）：先冻结判据，再写实现；
 * Validator 只能引用这里登记过的码——新码必须先改本表（可审计）。
 */
export const RELATIONSHIP_REJECTION_CODES: readonly RelationshipRejectionSpec[] = [
  {
    code: 'relationship_owner_mismatch',
    description: 'payload.key.owner ≠ 事件的 characterId（伪造跨角色关系——失败关闭）',
  },
  {
    code: 'relationship_target_kind_invalid',
    description: 'targetKind 未登记于 ENTITY_KINDS（entity.ts 是唯一登记处）',
  },
  {
    code: 'relationship_delta_not_finite',
    description: 'delta 含非有限数（NaN/Infinity 不进关系状态）',
  },
  {
    code: 'relationship_delta_out_of_bounds',
    description: 'delta 超出单事件上限（|Δtrust|>0.05 或 |Δcloseness|>0.03）——拒绝，不静默夹',
  },
  {
    code: 'relationship_origin_values_out_of_range',
    description: 'ORIGIN 基线值超出 [0,1]',
  },
  {
    code: 'relationship_origin_kind_invalid',
    description: 'originKind 未登记（三值枚举之外）',
  },
  {
    code: 'relationship_origin_injection_not_enabled',
    description: 'originKind = MAINTENANCE_INJECTION：登记但 M7 失败关闭（Cognitive Intervention 未开闸）',
  },
  {
    code: 'relationship_origin_already_exists',
    description: '同一关系第二次建档（一条关系只有一个 ORIGIN；后续变化走 IMPACT）',
  },
  {
    code: 'relationship_origin_missing',
    description: '建档前收到 IMPACT（没有基线就没有可影响的状态）',
  },
  {
    code: 'relationship_evidence_missing',
    description: 'IMPACT 未引用任何对话事件（无证据不变化）',
  },
  {
    code: 'relationship_evidence_not_qualified',
    description: '引用事件未确立 ESTABLISHED 用户资格（Tier 0：她的生成/工具/未确立归因）',
  },
  {
    code: 'relationship_supersedes_invalid',
    description: '取代链接指向不存在或非 RELATIONSHIP_IMPACT 的事件',
  },
]

export const RELATIONSHIP_REJECTION_CODE_SET: ReadonlySet<string> = new Set(
  RELATIONSHIP_REJECTION_CODES.map((spec) => spec.code),
)

export function isRelationshipRejectionCode(code: string): boolean {
  return RELATIONSHIP_REJECTION_CODE_SET.has(code)
}

// ---------------------------------------------------------------------------
// payload 结构校验（registry 的 validatePayload 用；结构 ≠ 业务规则）
// ---------------------------------------------------------------------------

/**
 * 结构校验的分工（沿用 memory 的先例）：
 *   · 这里只查**形状**（字段在、类型对、枚举登记过）——"不合法"；
 *   · 业务规则（证据资格、界、建档存在性、取代链）归 WP4 的 Validator——"不放行"；
 *   · payload 超长由 registry 的 maxPayloadBytes 拦——"太大"。
 * 三类失败是三个可区分的信号，不许合并成一个错误码。
 */

function requirePayloadObject(payload: unknown, eventType: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`${eventType} payload 必须是对象`)
  }
  return payload as Record<string, unknown>
}

function requireKey(payload: Record<string, unknown>, eventType: string): EntityRelationKey {
  const raw = payload.key
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${eventType} payload.key 必须是 EntityRelationKey`)
  }
  const key = raw as Record<string, unknown>
  if (typeof key.owner !== 'string' || key.owner === '') {
    throw new Error(`${eventType} payload.key.owner 必须是非空字符串`)
  }
  if (typeof key.target !== 'string' || key.target === '') {
    throw new Error(`${eventType} payload.key.target 必须是非空字符串`)
  }
  return { owner: key.owner as EntityId, target: key.target as EntityId }
}

function requireTargetKind(payload: Record<string, unknown>, eventType: string): EntityKind {
  const kind = payload.targetKind
  if (typeof kind !== 'string' || !(ENTITY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`${eventType} payload.targetKind 必须是 ENTITY_KINDS 里登记过的值，收到 ${String(kind)}`)
  }
  return kind as EntityKind
}

function requireFinite(payload: Record<string, unknown>, field: string, eventType: string): number {
  const value = payload[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${eventType} payload.${field} 必须是有限数字`)
  }
  return value
}

function requireOriginKind(payload: Record<string, unknown>, eventType: string): RelationshipOriginKind {
  const kind = payload.originKind
  if (!isRelationshipOriginKind(kind)) {
    throw new Error(
      `${eventType} payload.originKind 必须是 ${RELATIONSHIP_ORIGIN_KINDS.join(' / ')}，收到 ${String(kind)}`,
    )
  }
  return kind
}

function requireUnit(payload: Record<string, unknown>, eventType: string): string {
  const unit = payload.unit
  if (typeof unit !== 'string' || unit.trim() === '') {
    throw new Error(
      `${eventType} payload.unit 必须是非空字符串（幂等单元：r1=自然日 ISO · r2/r3/r4='window' · r5=里程碑标签）`,
    )
  }
  return unit
}

/** `RELATIONSHIP_ORIGIN` 的结构校验（registry 用） */
export function validateRelationshipOriginPayload(payload: unknown): RelationshipOriginPayload {
  const eventType = 'RELATIONSHIP_ORIGIN'
  const object = requirePayloadObject(payload, eventType)
  const trust = requireFinite(object, 'trust', eventType)
  const closeness = requireFinite(object, 'closeness', eventType)
  if (trust < RELATIONSHIP_VALUE_MIN || trust > RELATIONSHIP_VALUE_MAX) {
    throw new Error(`${eventType} payload.trust 必须在 [0,1]，收到 ${String(trust)}`)
  }
  if (closeness < RELATIONSHIP_VALUE_MIN || closeness > RELATIONSHIP_VALUE_MAX) {
    throw new Error(`${eventType} payload.closeness 必须在 [0,1]，收到 ${String(closeness)}`)
  }
  const basis = object.basis
  if (typeof basis !== 'string' || basis.trim() === '') {
    throw new Error(`${eventType} payload.basis 必须是非空字符串（基线凭什么成立——计划 §6 场景 1）`)
  }
  return {
    key: requireKey(object, eventType),
    targetKind: requireTargetKind(object, eventType),
    trust,
    closeness,
    originKind: requireOriginKind(object, eventType),
    basis,
  }
}

/** `RELATIONSHIP_IMPACT` 的结构校验（registry 用） */
export function validateRelationshipImpactPayload(payload: unknown): RelationshipImpactPayload {
  const eventType = 'RELATIONSHIP_IMPACT'
  const object = requirePayloadObject(payload, eventType)
  const deltaRaw = object.delta
  if (typeof deltaRaw !== 'object' || deltaRaw === null) {
    throw new Error(`${eventType} payload.delta 必须是 { trust, closeness }`)
  }
  const delta = deltaRaw as Record<string, unknown>
  const ruleId = object.ruleId
  if (typeof ruleId !== 'string' || ruleId.trim() === '') {
    throw new Error(`${eventType} payload.ruleId 必须是非空字符串（冻结规则集的规则 id）`)
  }
  const result: RelationshipImpactPayload = {
    key: requireKey(object, eventType),
    targetKind: requireTargetKind(object, eventType),
    delta: {
      trust: requireFinite(delta, 'trust', eventType),
      closeness: requireFinite(delta, 'closeness', eventType),
    },
    ruleId,
    unit: requireUnit(object, eventType),
    originKind: requireOriginKind(object, eventType),
  }
  /* S8：可选规则表版本（缺省 ⇒ 旧规则集，行为逐字不变） */
  if (object.ruleVersion !== undefined) {
    if (typeof object.ruleVersion !== 'string' || object.ruleVersion.trim() === '') {
      throw new Error(`${eventType} payload.ruleVersion 给定时必须是非空字符串`)
    }
    result.ruleVersion = object.ruleVersion
  }
  const supersedesRaw = object.supersedes
  if (supersedesRaw !== undefined) {
    if (typeof supersedesRaw !== 'object' || supersedesRaw === null) {
      throw new Error(`${eventType} payload.supersedes 必须是 { domainEventId, reason }`)
    }
    const supersedes = supersedesRaw as Record<string, unknown>
    if (typeof supersedes.domainEventId !== 'string' || supersedes.domainEventId === '') {
      throw new Error(`${eventType} payload.supersedes.domainEventId 必须是非空字符串`)
    }
    if (typeof supersedes.reason !== 'string' || supersedes.reason.trim() === '') {
      throw new Error(`${eventType} payload.supersedes.reason 必须是非空字符串`)
    }
    result.supersedes = {
      domainEventId: supersedes.domainEventId as DomainEventId,
      reason: supersedes.reason,
    }
  }
  if (typeof object.note === 'string') {
    result.note = object.note
  }
  return result
}
