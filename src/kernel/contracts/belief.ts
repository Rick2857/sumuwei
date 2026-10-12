/**
 * Belief 契约 —— **"她对命题的当前判断"**（M9 / ADR-070）。
 *
 * ============================================================================
 *  ADR-070（ACCEPTED / DESIGN FROZEN，2026-09-27）
 * ============================================================================
 * 本文件是 M9 WP2 的合同层：**只定义语义与纯函数，不实现任何 store**。
 * 实现归属：评估器/协调器（WP3/WP5）、Validator（WP4）、Reducer/Projection（WP4）、
 * Context 接线（WP7）、调度（WP6）。
 *
 * 语义要点（逐条来自已冻结的 ADR-070）：
 *   D02   perspectiveOwnerId 必填；生产 v1 仅当前 Character（多主体 = TD-20 前置）。
 *   D03   槽位键 = (owner, subject.kind, subject.id, predicate, scopeKey)；
 *         **value 不进槽位键**——同一命题不同时间作用域未必矛盾。
 *   D04   B-REPORTED 只从白名单 Memory（§白名单常量，代码核对自 memory.ts）；
 *         B-INFERRED 只从受限可信互动。
 *   D05   B-INFERRED v1 仅 interaction.explanation_detail 一个槽位。
 *   D06   推断阈值 ≥3 独立合格事件 · 跨 ≥2 会话 · 窗口 ≤50（先冻后测）。
 *   D08   supportLevel ∈ {tentative, supported}；无数值概率。
 *   D10   Belief 事件只描述 CHARACTER_INTERNAL（DomainEvent.scope 字面量类型
 *         编译期已封死 'WORLD'；INV-M9-07 结构性继承）。
 *   D13   遗忘双保险 + forbiddenRootIds 契约（§BELIEF_RETRACTED）。
 *   D14   投影键 `belief:<beliefId>` / `belief:origin` / `belief:evidence:<slotHash>`
 *         （WP0 S5 已证通用投影表可承载；迁移 = NONE）。
 *
 * 四层分离（ADR-070 §1）：Conversation → Memory → **Belief** →（World 本版不建）。
 * Belief 不是 Memory 的镜像：它回答"她当前信什么、依据什么、还作数吗"，
 * 修订产生**新** beliefId（supersedes 链留因果），绝不改写历史（INV-M9-11）。
 *
 * 依赖方向（§2 单向铁律）：本文件只 import `ids.ts` / `entity.ts` / `memory.ts`
 * / `attribution.ts`（均为 contracts 叶子，不反向到达 `domain-event.ts`）。
 * `domain-event.ts → belief.ts` 是**单向**的（登记事件类型时），
 * 与 `domain-event.ts → relationship.ts` / `→ affect.ts` 的既有先例同构。
 */

import {
  KernelError,
  type BeliefId,
  type CharacterId,
  type ConversationEventId,
  type DomainEventId,
  type MemoryId,
  type Timestamp,
} from './ids.ts'
import type { EntityRef, PerspectiveOwnerId } from './entity.ts'
import { CLAIM_MEMORY_TYPES, type MemoryAuthority, type MemoryType } from './memory.ts'
import { sourceQualificationOf, type TrustedOriginReading } from './attribution.ts'

// ---------------------------------------------------------------------------
// 身份与作用域（M9-D02）
// ---------------------------------------------------------------------------

/**
 * 视角所有者 id —— "这条判断是**谁**的认知"。
 *
 * **复用 M3.5 在 entity.ts 预留的 `PerspectiveOwnerId = EntityId`**
 * （FC-T05 当年守的正是这个约定：契约先于实现，M9 落地时不改 schema）。
 * 今天恒为当前 Character，但类型上不写死——第二个角色/NPC 来的时候
 * 这里不能成为堵点。生产 v1 的"仅当前 Character"由 Validator 装配侧闸保证
 * （ADR-070 D02），不是类型系统的职责。
 */

// ---------------------------------------------------------------------------
// 认知种类 / 状态 / 支持等级（M9-D08；INV-M9-03）
// ---------------------------------------------------------------------------

/**
 * 这条判断**从哪类输入形成**——由程序推导，模型/提案不能自报提升
 * （INV-M9-03：inferred 永不伪装为 reported）。
 *
 * - `reported`：白名单 Memory 的带来源当前判断（B-REPORTED）。
 * - `inferred`：受限互动经冻结规则累积的有限假设（B-INFERRED）——
 *   永远不能因为"重复次数多"升级为 reported。
 */
export type BeliefEpistemicKind = 'reported' | 'inferred'

export const BELIEF_EPISTEMIC_KINDS: readonly BeliefEpistemicKind[] = ['reported', 'inferred']

/** 生命周期状态（ADR-070 §4.2 状态转换表） */
export type BeliefStatus = 'active' | 'disputed' | 'superseded' | 'retracted'

export const BELIEF_STATUSES: readonly BeliefStatus[] = ['active', 'disputed', 'superseded', 'retracted']

/**
 * 支持强度（M9-D08）：可解释、非真值概率。
 *
 * `supported` 只代表满足本版证据政策，**不代表**科学/法律/客观事实已证实；
 * B-INFERRED 永远 `tentative`（更多重复不自动升级）。
 */
export type BeliefSupportLevel = 'tentative' | 'supported'

export const BELIEF_SUPPORT_LEVELS: readonly BeliefSupportLevel[] = ['tentative', 'supported']

export function isBeliefEpistemicKind(value: unknown): value is BeliefEpistemicKind {
  return (
    typeof value === 'string' && (BELIEF_EPISTEMIC_KINDS as readonly string[]).includes(value)
  )
}

export function isBeliefStatus(value: unknown): value is BeliefStatus {
  return typeof value === 'string' && (BELIEF_STATUSES as readonly string[]).includes(value)
}

export function isBeliefSupportLevel(value: unknown): value is BeliefSupportLevel {
  return (
    typeof value === 'string' && (BELIEF_SUPPORT_LEVELS as readonly string[]).includes(value)
  )
}

// ---------------------------------------------------------------------------
// 投影作用域（M9-D14；WP0 S5 已证形状）
// ---------------------------------------------------------------------------

/**
 * 每条 belief 一个有界投影行：`belief:<beliefId>`。
 *
 * 键含 beliefId（因而含 owner 分量）⇒ 无碰撞、稳定；与关系域的
 * `relationship:user:<id>` 先例同族（scope 编码进 projectionType，
 * 通用投影表零迁移承载）。
 */
export const BELIEF_PROJECTION_PREFIX = 'belief:' as const

export function beliefProjectionTypeOf(beliefId: BeliefId): string {
  return `${BELIEF_PROJECTION_PREFIX}${String(beliefId)}`
}

/** Character 级建档投影（BELIEF_ORIGIN 的折叠结果；一角色一行） */
export const BELIEF_ORIGIN_PROJECTION_TYPE = 'belief:origin' as const

/** 待累计证据投影：`belief:evidence:<slotHash>`（跨页持久化"待累计"，不靠尾窗） */
export const BELIEF_EVIDENCE_PROJECTION_PREFIX = 'belief:evidence:' as const

export function beliefEvidenceProjectionTypeOf(slotKey: string): string {
  return `${BELIEF_EVIDENCE_PROJECTION_PREFIX}${fnv1aHex(slotKey)}`
}

// ---------------------------------------------------------------------------
// 槽位键（M9-D03：value 不进键）
// ---------------------------------------------------------------------------

/** 槽位键的输入形状（全部必填；缺任何分量 = 无法判定冲突归属） */
export interface BeliefSlotKeyInput {
  perspectiveOwnerId: PerspectiveOwnerId
  subject: EntityRef
  predicate: string
  scopeKey: string
}

/**
 * 冲突槽位键：`owner|subject.kind|subject.id|predicate|scopeKey`。
 *
 * - `value` **不在键里**（D03）：同一命题不同时间作用域未必矛盾；
 *   冲突判定 = 同键 + 时间重叠 + value 互斥，由 Validator 组合判断。
 * - 分隔符用 `|`（各分量内部允许 `:`，如 EntityRef 的 `char:xxx`）。
 * - 同实体 id 不同 kind ⇒ 键不同（B07：`object:box` ≠ `person:box`）。
 */
export function beliefSlotKeyOf(input: BeliefSlotKeyInput): string {
  if (typeof input.perspectiveOwnerId !== 'string' || input.perspectiveOwnerId === '') {
    throw new KernelError(
      'validation_error',
      'belief_owner_missing',
      '槽位键的 perspectiveOwnerId 不能为空（INV-M9-01）',
    )
  }
  if (
    typeof input.subject !== 'object' ||
    input.subject === null ||
    typeof input.subject.kind !== 'string' ||
    typeof input.subject.id !== 'string' ||
    String(input.subject.id) === ''
  ) {
    throw new KernelError(
      'validation_error',
      'belief_subject_invalid',
      '槽位键的 subject 必须是合法 EntityRef（kind + id 非空；INV-M9-01）',
    )
  }
  if (typeof input.predicate !== 'string' || input.predicate.trim() === '') {
    throw new KernelError(
      'validation_error',
      'belief_predicate_empty',
      '槽位键的 predicate 不能为空',
    )
  }
  if (typeof input.scopeKey !== 'string' || input.scopeKey.trim() === '') {
    throw new KernelError(
      'validation_error',
      'belief_scope_empty',
      '槽位键的 scopeKey 不能为空（作用域不明 = 冲突不可判定）',
    )
  }
  return [
    String(input.perspectiveOwnerId),
    input.subject.kind,
    String(input.subject.id),
    input.predicate,
    input.scopeKey,
  ].join('|')
}

// ---------------------------------------------------------------------------
// BeliefId（确定性；修订 = 新 id）
// ---------------------------------------------------------------------------

/**
 * 确定性 belief id：`blf:<characterId>:<slotHash>:<formationKey>`。
 *
 * - `slotHash` = 槽位键的 FNV-1a（键含 `|` 与超长成分，不能直接进 id）。
 * - `formationKey` = 唯一标识**这次形成**（如形成事件的域序号）：
 *   同槽位的每次修订必须是**不同** id（INV-M9-11 修订不抹历史），
 *   而同一批形成输入重跑必须得到**同一** id（幂等）。
 */
export function makeBeliefId(
  characterId: CharacterId,
  slotKey: string,
  formationKey: string,
): BeliefId {
  if (typeof characterId !== 'string' || characterId === '') {
    throw new KernelError('validation_error', 'empty_id', 'BeliefId 的 characterId 不能为空')
  }
  if (typeof slotKey !== 'string' || slotKey === '') {
    throw new KernelError('validation_error', 'belief_slot_empty', 'BeliefId 的 slotKey 不能为空')
  }
  if (typeof formationKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(formationKey)) {
    throw new KernelError(
      'validation_error',
      'belief_formation_key_invalid',
      `BeliefId 的 formationKey 必须是 1..64 位字母数字/_-（收到 ${JSON.stringify(formationKey)}）`,
    )
  }
  return `blf:${characterId}:${fnv1aHex(slotKey)}:${formationKey}` as BeliefId
}

/** FNV-1a 32bit → 8 位十六进制（纯函数、无 import；只为 id 有界，不作安全用途） */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// BeliefState（ADR-070 §3.2；WP4 reducer 的折叠目标）
// ---------------------------------------------------------------------------

/** 命题：谓词 + 值 + 作用域 + 有效期（时间三分离之一：命题有效期） */
export interface BeliefProposition {
  predicate: string
  value: string | number | boolean | EntityRef
  scopeKey: string
  validFrom?: Timestamp
  validTo?: Timestamp
}

/**
 * 一条视角化信念的当前状态（投影行的 canonical 形状）。
 *
 * 细则全部来自 ADR-070 §3.2：
 * - `evidenceRootIds` = 真实 conversation event 引用（不伪装不存在的来源）；
 * - `dependsOnMemoryIds` 独立记录 Memory 依赖（EvidenceRef 无 memory kind）；
 * - 缺失信念 = unknown，**没有** "unknown = false" 默认值（INV-M9-12）；
 * - 不复制聊天正文——存最小命题 + 受控引用（隐私继承读取资格）。
 */
export interface BeliefState {
  beliefId: BeliefId
  perspectiveOwnerId: PerspectiveOwnerId
  subject: EntityRef
  proposition: BeliefProposition
  epistemicKind: BeliefEpistemicKind
  status: BeliefStatus
  supportLevel: BeliefSupportLevel
  evidenceRefs: ConversationEventId[]
  evidenceRootIds: ConversationEventId[]
  dependsOnMemoryIds: MemoryId[]
  ruleId: string
  ruleVersion: string
  supersedesBeliefId?: BeliefId
}

/** BELIEF_ORIGIN 投影的 canonical 形状（Character 级；一角色一行） */
export interface BeliefOriginState {
  originated: true
  activationId: string
  cutoverSequence: number
  policyVersion: string
  /** 建档时间（epoch ms；reducer 只用事件携带值，纯度） */
  originatedAt: Timestamp
}

/**
 * 待累计证据投影（B-INFERRED 的跨页持久化"待累计"状态）。
 *
 * 只记**去重后**的根与来源会话——同根重复/重复投递/摘要复述不能多计
 * （INV-M9-04/08）；重启后从投影恢复，不靠无限尾窗（ADR-070 §3.4）。
 */
export interface BeliefEvidenceAccumulation {
  slotKey: string
  predicate: string
  scopeKey: string
  value: string
  /** 去重后的合格根事件（升序；新根追加） */
  rootIds: ConversationEventId[]
  /** 去重后的来源会话 id（跨 ≥2 会话的判据输入） */
  conversationIds: string[]
  /** 首条合格证据时间（epoch ms；窗口 ≤50 的"最近"口径由评估器侧维护） */
  firstEvidenceAt: Timestamp
  lastEvidenceAt: Timestamp
  ruleId: string
  ruleVersion: string
}

// ---------------------------------------------------------------------------
// B-REPORTED 白名单（M9-D04；代码核对：memory.ts）
// ---------------------------------------------------------------------------

/**
 * 允许形成 B-REPORTED 的 Memory 类型 = **Claim 家族**（带事实槽位的两类）。
 *
 * `episode / self_experience`（EPISODIC 家族）**不进白名单**：它们是经历
 * 描述，不是带槽位的可判定命题（ADR-070 §2 关键冻结值）。
 * 引用 `CLAIM_MEMORY_TYPES` 而不是复写——单一语义源，白名单漂移即编译期可见。
 */
export const BELIEF_REPORTED_MEMORY_TYPES: readonly MemoryType[] = CLAIM_MEMORY_TYPES

/** 允许形成 B-REPORTED 的权威档（与 memory.ts 的直接建档白名单同一套） */
export const BELIEF_REPORTED_AUTHORITIES: readonly MemoryAuthority[] = [
  'EXPLICIT_USER_STATEMENT',
  'EXPLICIT_CORRECTION',
]

/** B-REPORTED 的资格判据（纯函数；reconciler 与 Validator 共用同一语义源） */
export function isBeliefReportedEligible(memory: {
  type: MemoryType
  authority: MemoryAuthority
  epistemicStatus: string
  status: string
}): boolean {
  return (
    (BELIEF_REPORTED_MEMORY_TYPES as readonly string[]).includes(memory.type) &&
    (BELIEF_REPORTED_AUTHORITIES as readonly string[]).includes(memory.authority) &&
    memory.epistemicStatus === 'reported' &&
    memory.status === 'active'
  )
}

// ---------------------------------------------------------------------------
// B-INFERRED 冻结槽位与阈值（M9-D05/D06；先冻后测）
// ---------------------------------------------------------------------------

/** v1 唯一推断槽位的谓词（拟议 Belief 槽位，不是 Memory predicate） */
export const BELIEF_INFERRED_PREDICATE = 'interaction.explanation_detail' as const

/** 槽位取值闭集（不开放 string——扩值 = 新规则版本） */
export const BELIEF_INFERRED_VALUES = ['detailed', 'concise'] as const
export type BeliefInferredValue = (typeof BELIEF_INFERRED_VALUES)[number]

/** 首版作用域：技术讲解这一互动主题域 */
export const BELIEF_INFERRED_SCOPE = 'technical_explanation' as const

/** 形成阈值：≥3 个**不同**合格用户事件（同根去重后） */
export const BELIEF_INFERRED_MIN_ROOTS = 3

/** 形成阈值：跨 ≥2 个会话 */
export const BELIEF_INFERRED_MIN_CONVERSATIONS = 2

/** 候选观察窗口：最多最近 50 个合格交互事件 */
export const BELIEF_INFERRED_WINDOW_LIMIT = 50

/** 冻结规则标识（规则变更 = 升版本，不清空 processed 表） */
export const BELIEF_INFERRED_RULE_ID = 'belief-inferred-explanation-detail' as const
export const BELIEF_INFERRED_RULE_VERSION = 'belief-inferred-rules@1' as const

/** B-REPORTED 的规则标识（reconciler 产出） */
export const BELIEF_REPORTED_RULE_ID = 'belief-reported-from-memory' as const
export const BELIEF_REPORTED_RULE_VERSION = 'belief-reported-rules@1' as const

/**
 * 生命周期事件的规则标识（WP5 revision 规划器产出 DISPUTED/SUPERSEDED/
 * RETRACTED 时携带）。与两条形成路径的规则分开——修订不是推断也不是
 * 白名单转写，审计上要能区分"谁形成的"与"谁修订的"。
 */
export const BELIEF_REVISION_RULE_ID = 'belief-revision-lifecycle' as const
export const BELIEF_REVISION_RULE_VERSION = 'belief-revision-rules@1' as const

/**
 * B-REPORTED 的 formationKey：依赖的 Memory 集合确定性哈希。
 *
 * 与 inferred 的「合并根最大 sequence"同一职位——reconciler 产出与 Validator
 * 复推共用本函数（INV-M9-11：修订 = 新 id，同批输入重跑 = 同 id）。
 * Memory id 含 `:`，不能直接进 formationKey 的字符集，故取 FNV-1a。
 *
 * ⚠️ M9.1 WP8 / F-5：入参可以是**身份分量**（`beliefReportedDependencyTokenOf`
 * 的产物），而不只是裸 Memory id。`revision > 1` 的 Memory（被复活过）在分量里
 * 并入 revision ⇒ 复活的再形成得到**新 beliefId**（ADR-072 `D13`「新信念身份」），
 * 而 revision = 1 时分量与裸 id **逐字节相同** ⇒ M9 基线身份不变。
 */
export function beliefReportedFormationKeyOf(dependencyIds: readonly (MemoryId | string)[]): string {
  if (dependencyIds.length === 0) {
    throw new KernelError(
      'validation_error',
      'empty_id',
      'B-REPORTED 的 formationKey 至少需要一个 Memory 依赖（D04）',
    )
  }
  return fnv1aHex([...dependencyIds].map(String).sort().join(','))
}

/**
 * 依赖项在 formationKey 里的**身份分量**（M9.1 WP8 / F-5；ADR-072 `D13`）。
 *
 * ```text
 * revision = 1（首次形成）      ⇒ 裸 Memory id（与 M9 基线逐字节同形）
 * revision > 1（忘掉/更正后重述复活）⇒ `<memoryId>@r<revision>` ⇒ 新身份
 * ```
 *
 * 为什么必须这样：reconciler 用「依赖 Memory 集合」推导 beliefId，而复活**沿用同
 * 一个 Memory id**（只升 revision）。若分量只取裸 id，复活后的再形成会推导出**同一个
 * beliefId**，而该形成幂等键在首次形成时已消费 ⇒ 放行口判 `duplicate_operation`
 * 拒绝 ⇒ 派生 reported 信念永不重建（F-5 的实测机制：`formed=1` 但终态零 active）。
 * 把 revision 并入分量即得到 D13 要求的「新信念身份」，旧 retracted 信念保持 retracted。
 *
 * ⚠️ 两侧**必须**用同一函数（reconciler 产出 + validator 复推，INV-M9-11）。
 */
export function beliefReportedDependencyTokenOf(dependency: {
  memoryId: MemoryId | string
  revision: number
}): string {
  const id = String(dependency.memoryId)
  return dependency.revision > 1 ? `${id}@r${String(dependency.revision)}` : id
}

/**
 * B-REPORTED 的 scopeKey：claim qualifiers 的确定性编码。
 *
 * Memory 的 qualifiers 进 canonicalKey（不同 qualifier = 不同槽位），Belief 侧
 * 同理：空限定 = `general`；有限定 = `q:<fnv1a(canonical)>`。canonical 形状
 * 冻结为 `k=JSON(v)` 按 key 排序后 `|` 连接——改形状 = 新规则版本。
 */
export function beliefReportedScopeKeyOf(
  qualifiers: Record<string, unknown> | undefined,
): string {
  if (qualifiers === undefined) return 'general'
  const keys = Object.keys(qualifiers).sort()
  if (keys.length === 0) return 'general'
  const canonical = keys
    .map((k) => `${k}=${JSON.stringify(qualifiers[k]) ?? 'null'}`)
    .join('|')
  return `q:${fnv1aHex(canonical)}`
}

/**
 * 累计状态是否达到形成阈值（纯函数；评估器与测试共用——**测试另建独立
 * oracle，不 import 本函数当 expected**，WP2 任务 6）。
 */
export function beliefInferredThresholdMet(acc: {
  rootIds: readonly ConversationEventId[]
  conversationIds: readonly string[]
}): boolean {
  return (
    acc.rootIds.length >= BELIEF_INFERRED_MIN_ROOTS &&
    acc.conversationIds.length >= BELIEF_INFERRED_MIN_CONVERSATIONS
  )
}

// ---------------------------------------------------------------------------
// 证据资格四条（ADR-070 §3.4；与 ADR-066 §3 同判据、独立权威——各自成文，
// 门里机器断言两者对同一夹具给出相同判定，防隐性漂移）
// ---------------------------------------------------------------------------

/** 资格判定的候选视图（与 AffectEvidenceCandidateView 同形；独立命名） */
export interface BeliefEvidenceCandidateView {
  id: ConversationEventId
  sequence: number
  type: string
  actorId?: string
  trustedOrigin?: TrustedOriginReading
}

/** 资格判定的配置面（评估器与 Validator 共用同一口径） */
export interface BeliefEvidencePolicy {
  activeUserId: string
  /** 切换边界（来自 BeliefOriginState.cutoverSequence；null = 未建档，拒绝一切） */
  cutoverSequence: number | null
}

/**
 * 单条证据是否合格（四条全过才算；失败关闭）：
 *   type = user_message · 来源资格 = ESTABLISHED · originator = Known(active user)
 *   · sequence > cutoverSequence（切换前历史不重评）
 */
export function beliefEvidenceQualifies(
  view: BeliefEvidenceCandidateView,
  policy: BeliefEvidencePolicy,
): boolean {
  if (view.type !== 'user_message') return false
  if (sourceQualificationOf(view.trustedOrigin) !== 'ESTABLISHED') return false
  const originator = view.trustedOrigin?.contentOriginator
  if (originator === undefined || originator.state !== 'KNOWN') return false
  if (originator.value.id !== policy.activeUserId) return false
  if (policy.cutoverSequence === null) return false
  if (view.sequence <= policy.cutoverSequence) return false
  return true
}

export type BeliefEvidenceVerdict =
  | { ok: true; qualifiedEventIds: ConversationEventId[] }
  | {
      ok: false
      code: 'belief_source_missing' | 'belief_source_unqualified'
      detail: string
    }

/**
 * 提案级资格判定（Validator 用）：候选非空，且**每一条**都合格。
 *
 * "每一条都必须合格"而不是"至少一条"：`sourceConversationEventIds` 的语义是
 * **因果**——把不合格事件混进因果集是污染（M7/M8 同判据）。
 */
export function beliefEvidenceVerdictOf(
  candidates: readonly BeliefEvidenceCandidateView[],
  policy: BeliefEvidencePolicy,
): BeliefEvidenceVerdict {
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'belief_source_missing',
      detail: 'B-INFERRED 证据事件必须引用至少一条真实对话事件（ADR-070 §3.4：无证据不采信）',
    }
  }
  const qualified: ConversationEventId[] = []
  for (const candidate of candidates) {
    if (!beliefEvidenceQualifies(candidate, policy)) {
      return {
        ok: false,
        code: 'belief_source_unqualified',
        detail:
          `事件 ${String(candidate.id)} 不满足资格四条（type/ESTABLISHED/active user/切换后）：` +
          '她的生成、工具、系统、未确立归因、非 active user、切换前事件一律不采（ADR-070 §3.4）',
      }
    }
    qualified.push(candidate.id)
  }
  return { ok: true, qualifiedEventIds: qualified }
}

// ---------------------------------------------------------------------------
// Validator 拒绝码（WP4 冻结；新码必须先改这张表——可审计）
// ---------------------------------------------------------------------------

export const BELIEF_REJECTION_CODES: readonly string[] = [
  'belief_owner_mismatch',
  'belief_origin_duplicate',
  'belief_not_originated',
  'belief_source_missing',
  'belief_source_unqualified',
  'belief_slot_already_active',
  'belief_roots_forbidden',
  'belief_not_active',
  'belief_belief_missing',
  'belief_supersede_target_invalid',
  'belief_threshold_not_met',
  'belief_rule_version_unknown',
  'belief_id_not_derivable',
  'belief_forbidden_roots_invalid',
]

// ---------------------------------------------------------------------------
// 领域事件 payload 契约（ADR-070 §4.2 七事件；结构校验，业务规则在 Validator）
// ---------------------------------------------------------------------------

/** BELIEF_ORIGIN：建立空起点与切换边界（一角色一次） */
export interface BeliefOriginPayload {
  characterId: CharacterId
  activationId: string
  cutoverSequence: number
  cutoverAt: Timestamp
  policyVersion: string
}

/**
 * BELIEF_EVIDENCE_NOTED：记录一个合格待累计互动证据引用。
 *
 * **不表示已形成信念**——只是"这根线索被看见了"；形成由 FORMED 在阈值
 * 达成时表达。冻结为真实事件（可重放、零累计丢失；ADR-070 §4.2）。
 */
export interface BeliefEvidenceNotedPayload {
  characterId: CharacterId
  perspectiveOwnerId: PerspectiveOwnerId
  subject: EntityRef
  predicate: string
  scopeKey: string
  value: string
  rootEventId: ConversationEventId
  rootSequence: number
  conversationId: string
  ruleId: string
  ruleVersion: string
}

/** BELIEF_FORMED：依据满足形成条件，新建一条判断 */
export interface BeliefFormedPayload {
  characterId: CharacterId
  beliefId: BeliefId
  perspectiveOwnerId: PerspectiveOwnerId
  subject: EntityRef
  proposition: BeliefProposition
  epistemicKind: BeliefEpistemicKind
  supportLevel: BeliefSupportLevel
  evidenceRootIds: ConversationEventId[]
  /**
   * Memory 依赖（B-REPORTED 用）。**可选**：B-INFERRED 无 Memory 依赖，
   * 省略 ≠ 空数组——校验器对"存在但为空数组"失败关闭
   * （`requireOptionalIdArray`：空集合用 undefined，不用 []）。
   */
  dependsOnMemoryIds?: MemoryId[]
  ruleId: string
  ruleVersion: string
}

/** BELIEF_REINFORCED：增加真正独立的合格支持（去重后必须非空） */
export interface BeliefReinforcedPayload {
  characterId: CharacterId
  beliefId: BeliefId
  newRootIds: ConversationEventId[]
  ruleId: string
  ruleVersion: string
}

/** BELIEF_DISPUTED：冲突已存在但尚不能解决（保留两侧） */
export interface BeliefDisputedPayload {
  characterId: CharacterId
  beliefId: BeliefId
  conflictingBeliefId?: BeliefId
  conflictingValue?: string | number | boolean | EntityRef
  reason: string
  ruleId: string
  ruleVersion: string
}

/** BELIEF_SUPERSEDED：用新的当前判断取代旧条（old/new 因果链） */
export interface BeliefSupersededPayload {
  characterId: CharacterId
  oldBeliefId: BeliefId
  newBeliefId: BeliefId
  reason: string
  validTo: Timestamp
  ruleId: string
  ruleVersion: string
}

/**
 * BELIEF_RETRACTED：撤回/失效/遗忘引起的停止采信。
 *
 * `forbiddenRootIds`（ADR-070 §5.4 遗忘契约）：本次失效所**禁止再用**的根
 * 事件集合。同槽位的任何新 B-INFERRED 提案，根集合与之相交即被拒绝
 * （失败关闭）——raw-event 推断不能绕道复活（B28）。
 *
 * 类型可选 = 运行时契约（`requireOptionalIdArray`）：**空集合用 undefined，
 * 不用 `[]`**（存在但空 = 结构违规）。语义上：
 * · `user_forget_request` ⇒ **必携非空**（Validator 业务规则强制——遗忘
 *   不禁根 = 旧依据可绕道复活，B28 失守）；
 * · `dependency_invalidated` ⇒ 可省（Memory 撤回 ≠ 对话根作废；
 *   新显式陈述 ⇒ 新 identity，B31）。
 */
export interface BeliefRetractedPayload {
  characterId: CharacterId
  beliefId: BeliefId
  reason: 'user_forget_request' | 'dependency_invalidated' | 'user_correction' | 'superseded_by_correction'
  causeRef?: DomainEventId
  forbiddenRootIds?: ConversationEventId[]
  ruleId: string
  ruleVersion: string
}

// ---------------------------------------------------------------------------
// payload 结构校验（registry 用；一个概念一处实现）
// ---------------------------------------------------------------------------

function requirePayloadObject(payload: unknown, eventType: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`${eventType} payload 必须是对象，收到 ${typeof payload}`)
  }
  return payload as Record<string, unknown>
}

function requireNonEmptyString(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): string {
  const value = object[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${eventType} payload.${field} 必须是非空字符串`)
  }
  return value
}

function requireCharacterId(object: Record<string, unknown>, eventType: string): CharacterId {
  return requireNonEmptyString(object, 'characterId', eventType) as CharacterId
}

function requirePositiveInteger(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): number {
  const value = object[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${eventType} payload.${field} 必须是 ≥1 的整数`)
  }
  return value
}

function requireNonNegativeInteger(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): number {
  const value = object[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${eventType} payload.${field} 必须是 ≥0 的整数`)
  }
  return value
}

function requireTimestamp(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): Timestamp {
  const value = object[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${eventType} payload.${field} 必须是非负有限数（epoch ms）`)
  }
  return value as Timestamp
}

function requireEntityRef(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): EntityRef {
  const raw = object[field]
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${eventType} payload.${field} 必须是 EntityRef（kind + id）`)
  }
  const ref = raw as Record<string, unknown>
  if (typeof ref.kind !== 'string' || ref.kind.trim() === '') {
    throw new Error(`${eventType} payload.${field}.kind 必须是非空字符串`)
  }
  if (typeof ref.id !== 'string' || ref.id.trim() === '') {
    throw new Error(`${eventType} payload.${field}.id 必须是非空字符串`)
  }
  return { kind: ref.kind, id: ref.id } as EntityRef
}

function requireIdArray(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): string[] {
  const raw = object[field]
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${eventType} payload.${field} 必须是非空数组（空集合用 undefined，不用 []）`)
  }
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${eventType} payload.${field} 的每个成员必须是非空字符串 id`)
    }
  }
  return [...raw] as string[]
}

function requireOptionalIdArray(
  object: Record<string, unknown>,
  field: string,
  eventType: string,
): string[] {
  if (object[field] === undefined) return []
  return requireIdArray(object, field, eventType)
}

function requireProposition(
  object: Record<string, unknown>,
  eventType: string,
): BeliefProposition {
  const raw = object.proposition
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${eventType} payload.proposition 必须是 { predicate, value, scopeKey }`)
  }
  const prop = raw as Record<string, unknown>
  const predicate = requireNonEmptyString(prop, 'predicate', `${eventType}.proposition`)
  const scopeKey = requireNonEmptyString(prop, 'scopeKey', `${eventType}.proposition`)
  const value = prop.value
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean' &&
    typeof value !== 'object'
  ) {
    throw new Error(`${eventType} payload.proposition.value 必须是 string | number | boolean | EntityRef`)
  }
  const result: BeliefProposition = { predicate, value: value as BeliefProposition['value'], scopeKey }
  if (prop.validFrom !== undefined) {
    result.validFrom = requireTimestamp(prop, 'validFrom', `${eventType}.proposition`)
  }
  if (prop.validTo !== undefined) {
    result.validTo = requireTimestamp(prop, 'validTo', `${eventType}.proposition`)
  }
  return result
}

/** `BELIEF_ORIGIN` 的结构校验（registry 用） */
export function validateBeliefOriginPayload(payload: unknown): BeliefOriginPayload {
  const eventType = 'BELIEF_ORIGIN'
  const object = requirePayloadObject(payload, eventType)
  return {
    characterId: requireCharacterId(object, eventType),
    activationId: requireNonEmptyString(object, 'activationId', eventType),
    cutoverSequence: requireNonNegativeInteger(object, 'cutoverSequence', eventType),
    cutoverAt: requireTimestamp(object, 'cutoverAt', eventType),
    policyVersion: requireNonEmptyString(object, 'policyVersion', eventType),
  }
}

/** `BELIEF_EVIDENCE_NOTED` 的结构校验（registry 用） */
export function validateBeliefEvidenceNotedPayload(payload: unknown): BeliefEvidenceNotedPayload {
  const eventType = 'BELIEF_EVIDENCE_NOTED'
  const object = requirePayloadObject(payload, eventType)
  return {
    characterId: requireCharacterId(object, eventType),
    perspectiveOwnerId: requireNonEmptyString(object, 'perspectiveOwnerId', eventType) as PerspectiveOwnerId,
    subject: requireEntityRef(object, 'subject', eventType),
    predicate: requireNonEmptyString(object, 'predicate', eventType),
    scopeKey: requireNonEmptyString(object, 'scopeKey', eventType),
    value: requireNonEmptyString(object, 'value', eventType),
    rootEventId: requireNonEmptyString(object, 'rootEventId', eventType) as ConversationEventId,
    rootSequence: requirePositiveInteger(object, 'rootSequence', eventType),
    conversationId: requireNonEmptyString(object, 'conversationId', eventType),
    ruleId: requireNonEmptyString(object, 'ruleId', eventType),
    ruleVersion: requireNonEmptyString(object, 'ruleVersion', eventType),
  }
}

/** `BELIEF_FORMED` 的结构校验（registry 用） */
export function validateBeliefFormedPayload(payload: unknown): BeliefFormedPayload {
  const eventType = 'BELIEF_FORMED'
  const object = requirePayloadObject(payload, eventType)
  const epistemicKind = object.epistemicKind
  if (!isBeliefEpistemicKind(epistemicKind)) {
    throw new Error(
      `${eventType} payload.epistemicKind 必须是 ${BELIEF_EPISTEMIC_KINDS.join(' | ')}（收到 ${JSON.stringify(epistemicKind)}）`,
    )
  }
  const supportLevel = object.supportLevel
  if (!isBeliefSupportLevel(supportLevel)) {
    throw new Error(
      `${eventType} payload.supportLevel 必须是 ${BELIEF_SUPPORT_LEVELS.join(' | ')}`,
    )
  }
  return {
    characterId: requireCharacterId(object, eventType),
    beliefId: requireNonEmptyString(object, 'beliefId', eventType) as BeliefId,
    perspectiveOwnerId: requireNonEmptyString(object, 'perspectiveOwnerId', eventType) as PerspectiveOwnerId,
    subject: requireEntityRef(object, 'subject', eventType),
    proposition: requireProposition(object, eventType),
    epistemicKind,
    supportLevel,
    evidenceRootIds: requireIdArray(object, 'evidenceRootIds', eventType) as ConversationEventId[],
    dependsOnMemoryIds: requireOptionalIdArray(object, 'dependsOnMemoryIds', eventType) as MemoryId[],
    ruleId: requireNonEmptyString(object, 'ruleId', eventType),
    ruleVersion: requireNonEmptyString(object, 'ruleVersion', eventType),
  }
}

/** `BELIEF_REINFORCED` 的结构校验（registry 用；去重后必须非空） */
export function validateBeliefReinforcedPayload(payload: unknown): BeliefReinforcedPayload {
  const eventType = 'BELIEF_REINFORCED'
  const object = requirePayloadObject(payload, eventType)
  return {
    characterId: requireCharacterId(object, eventType),
    beliefId: requireNonEmptyString(object, 'beliefId', eventType) as BeliefId,
    newRootIds: requireIdArray(object, 'newRootIds', eventType) as ConversationEventId[],
    ruleId: requireNonEmptyString(object, 'ruleId', eventType),
    ruleVersion: requireNonEmptyString(object, 'ruleVersion', eventType),
  }
}

/** `BELIEF_DISPUTED` 的结构校验（registry 用） */
export function validateBeliefDisputedPayload(payload: unknown): BeliefDisputedPayload {
  const eventType = 'BELIEF_DISPUTED'
  const object = requirePayloadObject(payload, eventType)
  const result: BeliefDisputedPayload = {
    characterId: requireCharacterId(object, eventType),
    beliefId: requireNonEmptyString(object, 'beliefId', eventType) as BeliefId,
    reason: requireNonEmptyString(object, 'reason', eventType),
    ruleId: requireNonEmptyString(object, 'ruleId', eventType),
    ruleVersion: requireNonEmptyString(object, 'ruleVersion', eventType),
  }
  if (object.conflictingBeliefId !== undefined) {
    result.conflictingBeliefId = requireNonEmptyString(object, 'conflictingBeliefId', eventType) as BeliefId
  }
  return result
}

/** `BELIEF_SUPERSEDED` 的结构校验（registry 用） */
export function validateBeliefSupersededPayload(payload: unknown): BeliefSupersededPayload {
  const eventType = 'BELIEF_SUPERSEDED'
  const object = requirePayloadObject(payload, eventType)
  return {
    characterId: requireCharacterId(object, eventType),
    oldBeliefId: requireNonEmptyString(object, 'oldBeliefId', eventType) as BeliefId,
    newBeliefId: requireNonEmptyString(object, 'newBeliefId', eventType) as BeliefId,
    reason: requireNonEmptyString(object, 'reason', eventType),
    validTo: requireTimestamp(object, 'validTo', eventType),
    ruleId: requireNonEmptyString(object, 'ruleId', eventType),
    ruleVersion: requireNonEmptyString(object, 'ruleVersion', eventType),
  }
}

/** `BELIEF_RETRACTED` 的结构校验（registry 用；forbiddenRootIds 契约） */
export function validateBeliefRetractedPayload(payload: unknown): BeliefRetractedPayload {
  const eventType = 'BELIEF_RETRACTED'
  const object = requirePayloadObject(payload, eventType)
  const reason = object.reason
  const BELIEF_RETRACT_REASONS = [
    'user_forget_request',
    'dependency_invalidated',
    'user_correction',
    'superseded_by_correction',
  ] as const
  if (
    typeof reason !== 'string' ||
    !(BELIEF_RETRACT_REASONS as readonly string[]).includes(reason)
  ) {
    throw new Error(
      `${eventType} payload.reason 必须是 ${BELIEF_RETRACT_REASONS.join(' | ')}（收到 ${JSON.stringify(reason)}）`,
    )
  }
  const result: BeliefRetractedPayload = {
    characterId: requireCharacterId(object, eventType),
    beliefId: requireNonEmptyString(object, 'beliefId', eventType) as BeliefId,
    reason: reason as BeliefRetractedPayload['reason'],
    forbiddenRootIds: requireOptionalIdArray(object, 'forbiddenRootIds', eventType) as ConversationEventId[],
    ruleId: requireNonEmptyString(object, 'ruleId', eventType),
    ruleVersion: requireNonEmptyString(object, 'ruleVersion', eventType),
  }
  if (object.causeRef !== undefined) {
    result.causeRef = requireNonEmptyString(object, 'causeRef', eventType) as DomainEventId
  }
  return result
}
