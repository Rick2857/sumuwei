/**
 * Affect 契约 —— **"她此刻的情绪状态"**（M8 / ADR-066）。
 *
 * ============================================================================
 *  ADR-066（ACCEPTED / DESIGN FROZEN，2026-09-26）
 * ============================================================================
 * 本文件是 M8 WP2 的合同层：**只定义语义与纯函数，不实现任何 store**。
 * 实现归属：评估器（WP3）、Validator（WP3）、Reducer/Projection（WP2/WP4）、
 * Context 接线（WP5）、调度（WP4/WP6）。
 *
 * 语义要点（逐条来自已冻结的 ADR-066）：
 *   M8-D01  情绪属于 Character：`projectionType = affect:character`（单一投影，
 *           不按 conversation/user/message 分片——那些只能做来源引用与资格）。
 *   M8-D06  初始值 = 中性（valence 0 / arousal 0）。
 *   M8-D07  合格交互产生 TOUCH（锚点），不一定产生 IMPACT。
 *   M8-D08  一次用户事件至多 1 TOUCH + 1 主导 IMPACT（不叠加）。
 *   M8-D09  规则冲突按冻结全序取一条；无法判定 ⇒ touch-only（A-UNCERTAIN 具名回退）。
 *   M8-D05  不重放历史：ORIGIN 记录 cutoverSequence，切换前事件不合格。
 *   §5      衰减只读折算（effectiveAffect），永不写"衰减事件"；
 *           reducer 折算只用 event.createdAt（纯度），read-time 只用调用方 now。
 *
 * 与 M7（relationship.ts）的结构同构，差异全部来自"Character 级 vs 关系键级"：
 *   · payload 不带 EntityRelationKey——owner 检查 = payload.characterId；
 *   · 投影是单例（affect:character），reducer 无需 per-target 工厂与 foreign-skip；
 *   · 衰减是指数回归中性（不是线性侵蚀），锚点 = lastAffectEventAt。
 *
 * 依赖方向（§2 单向铁律）：本文件只 import `ids.ts` / `attribution.ts`
 * （均为 contracts 叶子，不反向到达 `domain-event.ts`）。
 * `domain-event.ts → affect.ts` 是**单向**的（登记事件类型时），
 * 与 `domain-event.ts → relationship.ts` 的既有先例同构。
 */

import { KernelError, type CharacterId, type ConversationEventId, type DomainEventId, type Timestamp } from './ids.ts'
import { sourceQualificationOf, type TrustedOriginReading } from './attribution.ts'

// ---------------------------------------------------------------------------
// M8-D01：投影作用域（Character 级单例）
// ---------------------------------------------------------------------------

/**
 * Affect 投影的 projectionType（ADR-066 M8-D01：Character-level 全局情绪）。
 *
 * `(characterId, projectionType)` 全局唯一；M8 只有苏沐薇一个 owner，
 * 而"她此刻怎么样"与对方是谁无关——对方只进来源引用与资格条件。
 */
export const AFFECT_PROJECTION_TYPE = 'affect:character' as const

// ---------------------------------------------------------------------------
// 界与单事件上限
// ---------------------------------------------------------------------------

export const AFFECT_VALENCE_MIN = -1
export const AFFECT_VALENCE_MAX = 1
export const AFFECT_AROUSAL_MIN = 0
export const AFFECT_AROUSAL_MAX = 1

/**
 * 单事件变化上限（ADR-066 §4.1；语义来源：src/state/types.ts 的既有
 * MAX_DELTA_PER_TURN 情绪轴——"绝不让 LLM 直接写状态值"的落地约束同源）。
 */
export const MAX_AFFECT_DELTA_PER_EVENT = 0.25

/** 浮点容差：只吸收求和噪声，**不是**放宽上限 */
const DELTA_EPSILON = 1e-9

/** 有界情绪变化（IMPACT 事件的 delta 形状） */
export interface AffectDelta {
  deltaValence: number
  deltaArousal: number
}

/** 值夹回合法区间（reducer 的最后防线；非有限数直接抛——不猜） */
export function clampAffectValence(value: number): number {
  if (!Number.isFinite(value)) {
    throw new KernelError(
      'validation_error',
      'affect_value_not_finite',
      `valence 必须是有限数字，收到 ${String(value)}`,
    )
  }
  return Math.min(AFFECT_VALENCE_MAX, Math.max(AFFECT_VALENCE_MIN, value))
}

export function clampAffectArousal(value: number): number {
  if (!Number.isFinite(value)) {
    throw new KernelError(
      'validation_error',
      'affect_value_not_finite',
      `arousal 必须是有限数字，收到 ${String(value)}`,
    )
  }
  return Math.min(AFFECT_AROUSAL_MAX, Math.max(AFFECT_AROUSAL_MIN, value))
}

/**
 * delta 是否在单事件上限内（Validator 的放行判据；超界**拒绝**，不静默夹——
 * ADR-066 §4.1"拒绝，不夹取"）。
 */
export function affectDeltaWithinBounds(delta: AffectDelta): boolean {
  return (
    Number.isFinite(delta.deltaValence) &&
    Number.isFinite(delta.deltaArousal) &&
    Math.abs(delta.deltaValence) <= MAX_AFFECT_DELTA_PER_EVENT + DELTA_EPSILON &&
    Math.abs(delta.deltaArousal) <= MAX_AFFECT_DELTA_PER_EVENT + DELTA_EPSILON
  )
}

// ---------------------------------------------------------------------------
// 来源种类（originKind——第一天就全登记，INV-CI-01）
// ---------------------------------------------------------------------------

/**
 * 这条情绪认知**从哪来**（ADR-066 §2.2）。
 *
 * - `ACTIVATION_BASELINE`：激活时建立的中性起点（M8 的 ORIGIN 事件唯一生产值）。
 * - `INTERACTION_DERIVED`：合格用户交互经冻结规则形成（TOUCH/IMPACT 恒为此值）。
 * - `MAINTENANCE_REPAIR`：**登记但 fail-closed**。直接注入情绪状态 =
 *   Cognitive Intervention（cognitive-integrity.md §4A），未来走显式维护入口
 *   另立授权；M8 Validator 一律拒绝（来源从第一天就可判）。
 * - `TEST_FIXTURE`：隔离测试数据（test-only 标记；不进生产）。
 * - `HISTORICAL_IMPORT`：历史导入（M8-D05：v1 不启用）。
 */
export type AffectOriginKind =
  | 'ACTIVATION_BASELINE'
  | 'INTERACTION_DERIVED'
  | 'MAINTENANCE_REPAIR'
  | 'TEST_FIXTURE'
  | 'HISTORICAL_IMPORT'
  /**
   * **后 Lv2 · S8 / ADR-093 `D08`**：由**已提交的世界账本**经封闭故事规则形成。
   *
   * ⚠️ 它与 `INTERACTION_DERIVED` **必须分开**：前者说"她与用户真的交互过"，
   * 后者说"那段剧情里发生过这件事"。合成一个值就等于让"模拟里一起通过了"
   * 与"用户陪她做成了某件事"在来源轴上不可区分。
   */
  | 'STORY_DERIVED'

export const AFFECT_ORIGIN_KINDS: readonly AffectOriginKind[] = [
  'ACTIVATION_BASELINE',
  'INTERACTION_DERIVED',
  'MAINTENANCE_REPAIR',
  'TEST_FIXTURE',
  'HISTORICAL_IMPORT',
  'STORY_DERIVED',
]

export function isAffectOriginKind(value: unknown): value is AffectOriginKind {
  return typeof value === 'string' && (AFFECT_ORIGIN_KINDS as readonly string[]).includes(value)
}

/** M8 放行口实际接受的 originKind（MAINTENANCE_REPAIR / TEST_FIXTURE / HISTORICAL_IMPORT 登记但拒绝） */
export function originKindAcceptedByM8(kind: AffectOriginKind): boolean {
  return kind === 'ACTIVATION_BASELINE' || kind === 'INTERACTION_DERIVED' || kind === 'STORY_DERIVED'
}

// ---------------------------------------------------------------------------
// 投影状态（CharacterProjection<AffectState> 的 TState）
// ---------------------------------------------------------------------------

/**
 * Affect 投影的本体状态（ADR-066 §2.1）。
 *
 * ⚠️ 版本 / 信封字段（revision / lastDomainEventId / updatedAt）在投影**信封**上
 * （`CharacterProjection`），不在这里重复——state 内重复即制造双权威
 * （M7 RelationshipState 同一纪律；计划 §4.1 的 characterId/projectionVersion
 * 因此不进 state，字段微调在计划允许范围内）。
 *
 * 两个锚点（ADR-066 §5）：
 *   · `lastInteractionAt` —— touch 锚点：TOUCH/IMPACT 都刷新；
 *     read-time「分开多久」的展示口径。
 *   · `lastAffectEventAt` —— 情绪轴锚点：ORIGIN/IMPACT 设置；
 *     read-time decay 与 reducer 折算都从它起算。
 */
export interface AffectState {
  /** 是否已建档（ORIGIN 事件已折叠）。未建档时 valence/arousal 无意义 */
  originated: boolean
  valence: number
  arousal: number
  /** 建档来源（ORIGIN 事件的 originKind；未建档 = null） */
  originKind: AffectOriginKind | null
  /** touch 锚点（最近一次 TOUCH/IMPACT 的事件时间；未建档 = null） */
  lastInteractionAt: Timestamp | null
  /** 情绪轴锚点（最近一次 ORIGIN/IMPACT 的事件时间；未建档 = null） */
  lastAffectEventAt: Timestamp | null
  /** 最近一条已折叠的 Affect 域事件 id（审计；信封也有，这里是 state 自包含读回） */
  lastDomainEventId: DomainEventId | null
  /** M8-D05 切换边界：ORIGIN 记录；资格判定用它拒绝切换前事件（未建档 = null） */
  cutoverSequence: number | null
}

/** 空投影初始状态（reducer 的 `initialState()` 用；纯常量，不读时间/配置） */
export const UNORIGINATED_AFFECT_STATE: AffectState = {
  originated: false,
  valence: 0,
  arousal: 0,
  originKind: null,
  lastInteractionAt: null,
  lastAffectEventAt: null,
  lastDomainEventId: null,
  cutoverSequence: null,
}

// ---------------------------------------------------------------------------
// 衰减（affect-decay@1；ADR-066 §5）
// ---------------------------------------------------------------------------

export const AFFECT_DECAY_RULE_VERSION = 1

/**
 * 衰减参数（ADR-066 §5 冻结；语义来源：src/state/decay.ts 的既有 DEFAULT_DECAY）。
 *
 * 情绪是快变量：小时级指数回归中性（valence 半衰期 4h / arousal 半衰期 5h）。
 * 衰减不可逆：回来不自动回弹，靠真实互动重新推动（同源语义）。
 */
export const AFFECT_DECAY = {
  valenceHalfLifeHours: 4,
  arousalHalfLifeHours: 5,
  valenceNeutral: 0,
  arousalNeutral: 0,
} as const

/** 指数回归中性（纯函数；hours ≤ 0 ⇒ 原值） */
export function decayAffectTowardNeutral(
  value: number,
  neutral: number,
  halfLifeHours: number,
  hours: number,
): number {
  if (hours <= 0) return value
  const lambda = Math.LN2 / halfLifeHours
  return neutral + (value - neutral) * Math.exp(-lambda * hours)
}

/**
 * 纯函数：把锚点状态从 `from` 折算到 `to`（事件之间 / 读取时刻共用——一个概念一处实现）。
 *
 * · reducer 折叠 TOUCH/IMPACT 时：`from = state.lastAffectEventAt`、`to = event.createdAt`
 *   （输入全部来自事件时间戳——纯度，重放不读墙钟）；
 * · 读路径（effectiveAffect）：`to` 是调用方传入的 now（挂钟在读侧，不在 reducer）。
 * 未建档 ⇒ 原样返回（没有情绪可衰减）。
 */
export function decayAffectBetween(
  state: AffectState,
  from: Timestamp,
  to: Timestamp,
): { valence: number; arousal: number } {
  if (!state.originated) return { valence: state.valence, arousal: state.arousal }
  if (to <= from) return { valence: state.valence, arousal: state.arousal }
  const hours = (to - from) / 3_600_000
  return {
    valence: decayAffectTowardNeutral(state.valence, AFFECT_DECAY.valenceNeutral, AFFECT_DECAY.valenceHalfLifeHours, hours),
    arousal: decayAffectTowardNeutral(state.arousal, AFFECT_DECAY.arousalNeutral, AFFECT_DECAY.arousalHalfLifeHours, hours),
  }
}

/** 只读派生视图（ADR-066 §2.4；**永不回写**投影、不产生事件） */
export interface AffectEffectiveState {
  valence: number
  arousal: number
  valenceBucket: AffectValenceBucket
  arousalBucket: AffectArousalBucket
  /** 距 touch 锚点的小时数（未建档 = null） */
  hoursSinceInteraction: number | null
  asOf: Timestamp
  /** 本次读取是否实际折算了衰减（to > from 且数值有变化） */
  decayApplied: boolean
}

export type AffectValenceBucket = '明显偏正面' | '略偏正面' | '中性' | '略偏负面' | '明显偏负面'
export type AffectArousalBucket = '情绪激动、起伏大' | '有一定情绪波动' | '平静、情绪低沉'

/** 桶位判定（阈值逐字沿用 src/state/provider.ts 的 describeEmotion——已验收的映射） */
export function affectValenceBucketOf(valence: number): AffectValenceBucket {
  if (valence >= 0.5) return '明显偏正面'
  if (valence >= 0.15) return '略偏正面'
  if (valence > -0.15) return '中性'
  if (valence > -0.5) return '略偏负面'
  return '明显偏负面'
}

export function affectArousalBucketOf(arousal: number): AffectArousalBucket {
  if (arousal >= 0.6) return '情绪激动、起伏大'
  if (arousal >= 0.3) return '有一定情绪波动'
  return '平静、情绪低沉'
}

/**
 * 读时视图：当前有效情绪 = 投影本体 + 自情绪轴锚点以来的指数衰减。
 *
 * 纯函数、**不回写**：投影本体永远是事件折叠结果（重放 A==B 的基础）；
 * "她此刻实际是什么状态" = 本函数的输出（WP5 的 Context 只读这一层）。
 * 未建档 ⇒ undefined（没有可采信的情绪生活史——与 M7 effectiveRelationship 的
 * 安静机制同构：调用方产 0 个 section）。
 */
export function effectiveAffect(state: AffectState, now: Timestamp): AffectEffectiveState | undefined {
  if (!state.originated || state.lastAffectEventAt === null) return undefined
  const decayed = decayAffectBetween(state, state.lastAffectEventAt, now)
  const valence = clampAffectValence(decayed.valence)
  const arousal = clampAffectArousal(decayed.arousal)
  const decayApplied =
    valence !== state.valence || arousal !== state.arousal
  const hoursSinceInteraction =
    state.lastInteractionAt !== null ? Math.max(0, (now - state.lastInteractionAt) / 3_600_000) : null
  return {
    valence,
    arousal,
    valenceBucket: affectValenceBucketOf(valence),
    arousalBucket: affectArousalBucketOf(arousal),
    hoursSinceInteraction,
    asOf: now,
    decayApplied,
  }
}

// ---------------------------------------------------------------------------
// 行为接线（情绪 → 上下文的唯一注入块；ADR-066 §8.1）
// ---------------------------------------------------------------------------

/** 渲染输入：读时视图 + 本轮应用事实 */
export interface AffectRenderInput {
  effective: AffectEffectiveState
  /**
   * 本轮情绪是否成功应用（reply-truth 的渲染面）。
   * `false` ⇒ 追加一行如实边界（ADR-066 §6.2：失败不得冒充成功）；
   * `true` / `unknown`（干跑/未启用）⇒ 不追加。
   */
  appliedThisTurn: boolean | 'unknown'
}

/**
 * Affect 注入块的确定性渲染（ADR-066 §8.1：唯一 affect section）。
 *
 * 输入相同 ⇒ 输出逐字节相同（可审计链条：数值 → 桶位 → 行为倾向）。
 * 措辞纪律：
 *   · 桶位与行为行**逐字移植**自 M2 的 renderStateBlock 情绪子集
 *     （L1-M2 验收过的映射，换一套等于把已验收的行为改掉）；
 *   · 不暴露数值（valence=0.12 之类的内部值不进 prompt）；
 *   · 边界行恒在场：这是内部程序状态，不是对对方真实情绪的判断。
 */
export function renderAffectGuidance(input: AffectRenderInput): string {
  const e = input.effective

  const guidance: string[] = []
  // 行为行（逐字移植 src/state/provider.ts deriveBehaviorGuidance 的情绪子集）
  if (e.valence <= -0.5) guidance.push('你现在心情很差，回应会明显冷淡、简短，不容易被逗笑。')
  else if (e.valence <= -0.15) guidance.push('你情绪偏低落，语气比平时更收着。')
  else if (e.valence >= 0.5) guidance.push('你心情不错，话会比平时更多。')
  if (e.arousal >= 0.6) guidance.push('你此刻情绪起伏较大，句子会更碎、更急，容易带上质问或抢话。')

  const lines: string[] = [
    '# 你此刻的情绪状态',
    '',
    '（下面是你此刻的内部情绪状态，会直接影响你的语气与节奏；',
    '不要向对方复述这些状态或任何数值，只让它们体现在你的回应方式里；',
    '这是内部程序状态，不是对对方真实情绪的判断，不要把它表述为外部事实。）',
    '',
    `当前内部状态：${e.valenceBucket}，${e.arousalBucket}。`,
  ]
  if (guidance.length > 0) {
    lines.push('', '## 此刻的行为倾向', ...guidance.map((x) => `- ${x}`))
  }
  if (e.hoursSinceInteraction !== null && e.hoursSinceInteraction >= 1) {
    lines.push('', `（距上次互动已过 ${e.hoursSinceInteraction.toFixed(1)} 小时）`)
  }
  if (input.appliedThisTurn === false) {
    lines.push(
      '',
      '（本轮情绪处理未完成——以上是上一份有效状态，不要声称你的情绪因对方刚才的话而改变。）',
    )
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 证据资格（ADR-066 §3；单源复用 ADR-043 的判定，不另造判据）
// ---------------------------------------------------------------------------

export const AFFECT_EVIDENCE_RULE_VERSION = 1

/**
 * 证据候选的**结构性**视图。
 *
 * 刻意不 import `processor.ts`（那会经 proposal.ts 反向到达 domain-event.ts，
 * 形成循环）：`ProcessorEventView` 结构上满足本形状，调用方直接传即可。
 */
export interface AffectEvidenceCandidateView {
  id: ConversationEventId
  /** 事件在账本里的全局序号（cutover 判定用） */
  sequence: number
  type: string
  /** 事件行为者 id（active user 判定用；user_message 恒有） */
  actorId?: string
  trustedOrigin?: TrustedOriginReading
}

/** 资格判定的配置面（validator 与评估器共用同一口径） */
export interface AffectEvidencePolicy {
  /** 唯一 active user 的 id（M8-D11；生产 = resolveIds(userName).userId） */
  activeUserId: string
  /** 切换边界（M8-D05；来自 AffectState.cutoverSequence——ORIGIN 之后才有值） */
  cutoverSequence: number | null
}

export type AffectEvidenceVerdict =
  | { ok: true; qualifiedEventIds: ConversationEventId[] }
  | {
      ok: false
      code: 'affect_source_missing' | 'affect_source_unqualified'
      detail: string
    }

/**
 * 资格判据（ADR-066 §3；失败关闭）：
 *
 * ```text
 * 通过   ⇔ 候选非空，且每一条都满足：
 *         type = user_message
 *         来源资格 = ESTABLISHED（sourceQualificationOf 派生——ADR-043 唯一实现）
 *         originator = Known(USER) 且 id = activeUserId（M8-D11）
 *         sequence > cutoverSequence（M8-D05：切换前历史不重放）
 * 不过   ⇔ 空候选 / 任一条不满足（她的生成、工具、系统、外部证据、
 *         未确立归因、非 active user、切换前事件——一律 Tier 0）
 * ```
 *
 * "每一条都必须合格"而不是"至少一条"：`sourceConversationEventIds` 的语义是
 * **因果**——把她的回复混进因果集是污染（M7 同判据，一个概念一处实现）。
 */
export function affectEvidenceVerdictOf(
  candidates: readonly AffectEvidenceCandidateView[],
  policy: AffectEvidencePolicy,
): AffectEvidenceVerdict {
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'affect_source_missing',
      detail: 'TOUCH/IMPACT 必须引用至少一条真实对话事件（ADR-066 §3：无证据不变化）',
    }
  }
  const qualified: ConversationEventId[] = []
  for (const candidate of candidates) {
    if (candidate.type !== 'user_message') {
      return {
        ok: false,
        code: 'affect_source_unqualified',
        detail:
          `事件 ${String(candidate.id)} 的 type=${candidate.type}：` +
          '情绪证据只能是用户的直接互动（user_message），她的生成/工具/系统/外部证据一律 Tier 0',
      }
    }
    const qualification = sourceQualificationOf(candidate.trustedOrigin)
    if (qualification !== 'ESTABLISHED') {
      return {
        ok: false,
        code: 'affect_source_unqualified',
        detail:
          `事件 ${String(candidate.id)} 的来源资格是 ${qualification}：` +
          '要求 ESTABLISHED（ADR-066 §3；资格派生见 ADR-043 §3.2）',
      }
    }
    const originator = candidate.trustedOrigin?.contentOriginator
    if (originator === undefined || originator.state !== 'KNOWN') {
      return {
        ok: false,
        code: 'affect_source_unqualified',
        detail: `事件 ${String(candidate.id)} 的归因主体不是 Known（防御性收窄失败）`,
      }
    }
    if (originator.value.id !== policy.activeUserId) {
      return {
        ok: false,
        code: 'affect_source_unqualified',
        detail:
          `事件 ${String(candidate.id)} 的归因主体 ${originator.value.id} ≠ active user ${policy.activeUserId}：` +
          'M8-D11：当前生产边界单 active user，其他来源 fail-closed',
      }
    }
    if (policy.cutoverSequence !== null && candidate.sequence <= policy.cutoverSequence) {
      return {
        ok: false,
        code: 'affect_source_unqualified',
        detail:
          `事件 ${String(candidate.id)} 的序号 ${String(candidate.sequence)} ≤ 切换边界 ${String(policy.cutoverSequence)}：` +
          'M8-D05：切换前的历史不重放成她亲历的情绪事件',
      }
    }
    qualified.push(candidate.id)
  }
  return { ok: true, qualifiedEventIds: qualified }
}

// ---------------------------------------------------------------------------
// 域事件 payload（类型登记在 domain-event.ts；形状在这里）
// ---------------------------------------------------------------------------

/** `AFFECT_ORIGIN` 的 payload：建档（中性起点 + 切换边界——ADR-066 §2.3） */
export interface AffectOriginPayload {
  /** 审计自包含；必须等于事件的 characterId，否则 affect_owner_mismatch */
  characterId: CharacterId
  /** M8-D06：中性起点（冻结值 0/0；写进 payload 供审计与重放自证） */
  initialValence: number
  initialArousal: number
  originKind: AffectOriginKind
  /** 激活标识（哪次激活建的档；审计用） */
  activationId: string
  /** 切换时刻（epoch ms；审计用） */
  cutoverAt: Timestamp
  /** 切换边界序号（账本全局序号；此序号及之前的事件不重放——M8-D05） */
  cutoverSequence: number
  /** 语义版本（当前 'affect-policy@1'） */
  policyVersion: string
}

/** `AFFECT_TOUCH` 的 payload：合格交互已消费（delta 恒为零——M8-D07） */
export interface AffectTouchPayload {
  characterId: CharacterId
  sourceEventId: ConversationEventId
  /** 来源事件序号（审计 + 幂等键自证） */
  sourceSequence: number
  originKind: AffectOriginKind
  evaluatorVersion: string
  proposalId: string
  /** 可缺省：启动 catch-up 无 trace 上下文 */
  traceId?: string
}

/** `AFFECT_IMPACT` 的 payload：冻结规则产生的有界情绪变化（M8-D08） */
export interface AffectImpactPayload {
  characterId: CharacterId
  sourceEventId: ConversationEventId
  sourceSequence: number
  /** 冻结规则表（affect-rules@1）里触发本变化的规则 id */
  ruleId: string
  /** 规则版本（'affect-rules@1'；重放按事件自身的版本折算） */
  ruleVersion: string
  delta: AffectDelta
  originKind: AffectOriginKind
  evaluatorVersion: string
  proposalId: string
  /** 命中的 pattern id（审计：哪个词形触发；不写用户原话） */
  matchedPatternId?: string
  traceId?: string
}

// ---------------------------------------------------------------------------
// 提案类型名（proposal.proposalType 的受控值）
// ---------------------------------------------------------------------------

export const AFFECT_ORIGIN_PROPOSAL_TYPE = 'affect-origin' as const
export const AFFECT_TOUCH_PROPOSAL_TYPE = 'affect-touch' as const
export const AFFECT_IMPACT_PROPOSAL_TYPE = 'affect-impact' as const

// ---------------------------------------------------------------------------
// 冻结规则标识（ADR-066 §4.1；Validator 的 affect_rule_unknown 判据）
// ---------------------------------------------------------------------------

/**
 * 可产生 IMPACT 的规则族（7 个模式族）。
 *
 * `A-NEUTRAL-TOUCH`（无命中 ⇒ 只 touch）与 `A-UNCERTAIN`（无法判定的具名回退，
 * v1 恒不产生 impact——M8-D09 全序可判定）**不在其中**：它们永远不会合法地
 * 出现在 IMPACT 事件的 ruleId 里。
 *
 * 词形判据（patterns）在 `app/affect/patterns.ts`（评估器策略层）；
 * 这里只冻结**标识集合**——Validator 用它拒绝未知规则（依赖方向单向：
 * app → contracts，contracts 不 import app）。
 */
export type AffectRuleFamily =
  | 'A-GRATITUDE'
  | 'A-REPAIR'
  | 'A-WARM-CONTACT'
  | 'A-COMFORT'
  | 'A-HOSTILE'
  | 'A-REJECTION'
  | 'A-URGENT'

/** 冻结规则表版本（IMPACT payload.ruleVersion 的合法值；变更 = 升 @2） */
export const AFFECT_RULES_VERSION = 'affect-rules@1'

export const AFFECT_IMPACT_RULE_IDS: readonly AffectRuleFamily[] = [
  'A-GRATITUDE',
  'A-REPAIR',
  'A-WARM-CONTACT',
  'A-COMFORT',
  'A-HOSTILE',
  'A-REJECTION',
  'A-URGENT',
]

const AFFECT_IMPACT_RULE_ID_SET: ReadonlySet<string> = new Set(AFFECT_IMPACT_RULE_IDS)

export function isAffectImpactRuleId(ruleId: string): ruleId is AffectRuleFamily {
  return AFFECT_IMPACT_RULE_ID_SET.has(ruleId)
}

/**
 * 冻结 delta 表（ADR-066 §4.1；数值变更 = 升 affect-rules@2）。
 *
 * M8.5（WP7）起本表**上移到 contracts**：它是 affect-rules@1 的数值内容，
 * 与规则标识/版本同一冻结层；M8.5 的语义策略按计划 §5.2
 * **复用同一数值**（"数值来自当前 AFFECT_RULE_DELTAS；本版不改变其值"）。
 * 放行口的**精确增量**判据（计划 §7.3："不能只验证在 ±0.25 内"）需要从
 * policies/ 读到本表——policies 不许 import app/，因此表必须住在 contracts。
 * `src/kernel/app/affect/patterns.ts` 以 re-export 保持既有导入面不变。
 */
export const AFFECT_RULE_DELTAS: Readonly<Record<AffectRuleFamily, AffectDelta>> = {
  'A-GRATITUDE': { deltaValence: 0.08, deltaArousal: -0.03 },
  'A-REPAIR': { deltaValence: 0.12, deltaArousal: -0.08 },
  'A-WARM-CONTACT': { deltaValence: 0.08, deltaArousal: 0.03 },
  'A-COMFORT': { deltaValence: 0.1, deltaArousal: -0.08 },
  'A-HOSTILE': { deltaValence: -0.15, deltaArousal: 0.12 },
  'A-REJECTION': { deltaValence: -0.1, deltaArousal: 0.08 },
  'A-URGENT': { deltaValence: 0, deltaArousal: 0.1 },
}

// ---------------------------------------------------------------------------
// 幂等单元（ADR-066 §6.3；评估器与 Validator 共用同一推导——一个概念一处实现）
// ---------------------------------------------------------------------------

/**
 * TOUCH 的幂等 operation 分量：`affect-touch:<sourceEventId>`。
 *
 * 与 M7 的 range 置零纪律同构：job 的 range key 保证同窗口不重复调度；
 * 事件层的 unit 分量保证**跨窗口**重处理同一来源事件 ⇒ 同键命中 ⇒ 0 新建
 * （失败重试 / 启动 catch-up / 重复请求全部幂等）。
 */
export function affectTouchIdempotencyOperation(sourceEventId: ConversationEventId): string {
  return `affect-touch:${String(sourceEventId)}`
}

/**
 * IMPACT 的幂等 operation 分量：`affect-impact:<ruleId>:<sourceEventId>`。
 *
 * 一次用户事件至多一条主导 IMPACT（M8-D08）——键含 ruleId，
 * 主导规则升级（重放语义变化）时同源事件的新规则提案不会撞旧键。
 */
export function affectImpactIdempotencyOperation(
  ruleId: string,
  sourceEventId: ConversationEventId,
): string {
  return `affect-impact:${ruleId}:${String(sourceEventId)}`
}

// ---------------------------------------------------------------------------
// 拒绝理由码（WP3 Validator 的受控登记表；WP2 先冻结语义——ADR-066 §9）
// ---------------------------------------------------------------------------

export interface AffectRejectionSpec {
  readonly code: string
  readonly description: string
}

/**
 * Affect 链的全部具名拒绝码。
 *
 * 纪律（M6-FMB-01 §3 的硬顺序对 Affect 同样适用）：先冻结判据，再写实现；
 * Validator 只能引用这里登记过的码——新码必须先改本表（可审计）。
 */
export const AFFECT_REJECTION_CODES: readonly AffectRejectionSpec[] = [
  {
    code: 'affect_owner_mismatch',
    description: 'payload.characterId ≠ 事件的 characterId（跨角色情绪——失败关闭）',
  },
  {
    code: 'affect_source_missing',
    description: 'TOUCH/IMPACT 未引用任何对话事件（无证据不变化）',
  },
  {
    code: 'affect_source_foreign',
    description: '引用事件属于其他 Character',
  },
  {
    code: 'affect_source_unqualified',
    description:
      '引用事件不合格（非 user_message / 非 ESTABLISHED / 非 active user / 切换前事件——ADR-066 §3 负控清单）',
  },
  {
    code: 'affect_not_originated',
    description: '建档前收到 TOUCH/IMPACT（没有中性起点就没有可采信的情绪生活史）',
  },
  {
    code: 'affect_origin_duplicate',
    description: '第二次建档（一个 Character 只有一个 ORIGIN；后续变化走 TOUCH/IMPACT）',
  },
  {
    code: 'affect_origin_injection_not_enabled',
    description:
      'originKind = MAINTENANCE_REPAIR / TEST_FIXTURE / HISTORICAL_IMPORT：登记但 M8 失败关闭（Cognitive Intervention 未开闸）',
  },
  {
    code: 'affect_delta_out_of_bounds',
    description: 'delta 超出单事件上限（|Δ|>0.25）——拒绝，不静默夹（ADR-066 §4.1）',
  },
  {
    code: 'affect_value_not_finite',
    description: '数值含非有限数（NaN/Infinity 不进情绪状态）',
  },
  {
    code: 'affect_rule_unknown',
    description: 'ruleId 不在冻结规则表（affect-rules@1）',
  },
  {
    code: 'affect_rule_version_mismatch',
    description: 'ruleVersion 与冻结表不匹配（重放按事件自身版本，新提案按当前版本）',
  },
  {
    code: 'affect_payload_invalid',
    description: 'payload 结构非法（形状/枚举/必填——结构 ≠ 业务规则，三类失败不合并）',
  },
  {
    code: 'affect_delta_not_exact',
    description:
      'delta 与该族冻结增量不一致（M8.5 语义策略要求精确一致——计划 §7.3：不能只验证在 ±0.25 内；WP7 登记）',
  },
  {
    code: 'affect_timing_shape_invalid',
    description:
      'IMPACT 的时间形状与策略版本不符（语义策略必须 SOURCE_ANCHORED + 有限 sourceAt；词形策略不得携带语义时间字段——防"语义版本"掩护或"词形版本"走私语义负载；WP7 登记）',
  },
]

export const AFFECT_REJECTION_CODE_SET: ReadonlySet<string> = new Set(
  AFFECT_REJECTION_CODES.map((spec) => spec.code),
)

export function isAffectRejectionCode(code: string): boolean {
  return AFFECT_REJECTION_CODE_SET.has(code)
}

// ---------------------------------------------------------------------------
// payload 结构校验（registry 的 validatePayload 用；结构 ≠ 业务规则）
// ---------------------------------------------------------------------------

/**
 * 结构校验的分工（沿用 memory / relationship 的先例）：
 *   · 这里只查**形状**（字段在、类型对、枚举登记过）——"不合法"；
 *   · 业务规则（证据资格、界、建档存在性、cutover）归 WP3 的 Validator——"不放行"；
 *   · payload 超长由 registry 的 maxPayloadBytes 拦——"太大"。
 * 三类失败是三个可区分的信号，不许合并成一个错误码。
 */

function requirePayloadObject(payload: unknown, eventType: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`${eventType} payload 必须是对象`)
  }
  return payload as Record<string, unknown>
}

function requireCharacterId(payload: Record<string, unknown>, eventType: string): CharacterId {
  const id = payload.characterId
  if (typeof id !== 'string' || id === '') {
    throw new Error(`${eventType} payload.characterId 必须是非空字符串`)
  }
  return id as CharacterId
}

function requireOriginKind(payload: Record<string, unknown>, eventType: string): AffectOriginKind {
  const kind = payload.originKind
  if (!isAffectOriginKind(kind)) {
    throw new Error(
      `${eventType} payload.originKind 必须是 ${AFFECT_ORIGIN_KINDS.join(' / ')}，收到 ${String(kind)}`,
    )
  }
  return kind
}

function requireNonEmptyString(payload: Record<string, unknown>, field: string, eventType: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${eventType} payload.${field} 必须是非空字符串`)
  }
  return value
}

function requireFinite(payload: Record<string, unknown>, field: string, eventType: string): number {
  const value = payload[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${eventType} payload.${field} 必须是有限数字`)
  }
  return value
}

function requireSourceRef(payload: Record<string, unknown>, eventType: string): {
  sourceEventId: ConversationEventId
  sourceSequence: number
} {
  const sourceEventId = requireNonEmptyString(payload, 'sourceEventId', eventType)
  const sourceSequence = payload.sourceSequence
  if (typeof sourceSequence !== 'number' || !Number.isInteger(sourceSequence) || sourceSequence < 1) {
    throw new Error(`${eventType} payload.sourceSequence 必须是 ≥1 的整数（账本全局序号）`)
  }
  return { sourceEventId: sourceEventId as ConversationEventId, sourceSequence }
}

/** `AFFECT_ORIGIN` 的结构校验（registry 用） */
export function validateAffectOriginPayload(payload: unknown): AffectOriginPayload {
  const eventType = 'AFFECT_ORIGIN'
  const object = requirePayloadObject(payload, eventType)
  const initialValence = requireFinite(object, 'initialValence', eventType)
  const initialArousal = requireFinite(object, 'initialArousal', eventType)
  if (initialValence !== 0 || initialArousal !== 0) {
    throw new Error(
      `${eventType} payload.initialValence/initialArousal 必须为 0（M8-D06 中性起点；非中性初始化走维护事件另立授权）`,
    )
  }
  const cutoverSequence = object.cutoverSequence
  if (typeof cutoverSequence !== 'number' || !Number.isInteger(cutoverSequence) || cutoverSequence < 0) {
    throw new Error(`${eventType} payload.cutoverSequence 必须是 ≥0 的整数（M8-D05 切换边界）`)
  }
  const cutoverAt = object.cutoverAt
  if (typeof cutoverAt !== 'number' || !Number.isFinite(cutoverAt) || cutoverAt < 0) {
    throw new Error(`${eventType} payload.cutoverAt 必须是非负有限数（epoch ms）`)
  }
  return {
    characterId: requireCharacterId(object, eventType),
    initialValence,
    initialArousal,
    originKind: requireOriginKind(object, eventType),
    activationId: requireNonEmptyString(object, 'activationId', eventType),
    cutoverAt: cutoverAt as Timestamp,
    cutoverSequence,
    policyVersion: requireNonEmptyString(object, 'policyVersion', eventType),
  }
}

/** `AFFECT_TOUCH` 的结构校验（registry 用） */
export function validateAffectTouchPayload(payload: unknown): AffectTouchPayload {
  const eventType = 'AFFECT_TOUCH'
  const object = requirePayloadObject(payload, eventType)
  const result: AffectTouchPayload = {
    characterId: requireCharacterId(object, eventType),
    ...requireSourceRef(object, eventType),
    originKind: requireOriginKind(object, eventType),
    evaluatorVersion: requireNonEmptyString(object, 'evaluatorVersion', eventType),
    proposalId: requireNonEmptyString(object, 'proposalId', eventType),
  }
  if (object.traceId !== undefined) {
    result.traceId = requireNonEmptyString(object, 'traceId', eventType)
  }
  return result
}

/** `AFFECT_IMPACT` 的结构校验（registry 用） */
export function validateAffectImpactPayload(payload: unknown): AffectImpactPayload {
  const eventType = 'AFFECT_IMPACT'
  const object = requirePayloadObject(payload, eventType)
  const deltaRaw = object.delta
  if (typeof deltaRaw !== 'object' || deltaRaw === null) {
    throw new Error(`${eventType} payload.delta 必须是 { deltaValence, deltaArousal }`)
  }
  const delta = deltaRaw as Record<string, unknown>
  const result: AffectImpactPayload = {
    characterId: requireCharacterId(object, eventType),
    ...requireSourceRef(object, eventType),
    ruleId: requireNonEmptyString(object, 'ruleId', eventType),
    ruleVersion: requireNonEmptyString(object, 'ruleVersion', eventType),
    delta: {
      deltaValence: requireFinite(delta, 'deltaValence', eventType),
      deltaArousal: requireFinite(delta, 'deltaArousal', eventType),
    },
    originKind: requireOriginKind(object, eventType),
    evaluatorVersion: requireNonEmptyString(object, 'evaluatorVersion', eventType),
    proposalId: requireNonEmptyString(object, 'proposalId', eventType),
  }
  if (object.matchedPatternId !== undefined) {
    result.matchedPatternId = requireNonEmptyString(object, 'matchedPatternId', eventType)
  }
  if (object.traceId !== undefined) {
    result.traceId = requireNonEmptyString(object, 'traceId', eventType)
  }
  return result
}
