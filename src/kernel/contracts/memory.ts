/**
 * Memory —— **长期记忆的领域模型**（M4 计划书第 21–41 节）。
 *
 * ============================================================================
 *  M4 解决的是"什么事情应该成为苏沐薇的长期记忆，以及这条记忆以后如何保持真实"
 * ============================================================================
 * M4 **不**解决"现在这句话应该召回哪几条记忆"（那是 M5）。
 * 因此这个文件里没有 `search()`、没有相似度、没有 ranking ——
 * 那些一旦提前出现，就会让"记错了"与"记对了但没召回"两个问题混在一起，
 * 变得极难调试（计划书第 3 节）。
 *
 * ---------------------------------------------------------------------------
 *  三条不许破的规矩
 * ---------------------------------------------------------------------------
 * 1. **禁止 `memory.userId`**（计划书第 6 节）。
 *    owner / subject / source 三者分离，全部用 M3.5 的 `EntityRef`。
 *    今天 owner 几乎总是苏沐薇、subject 几乎总是 Alex，
 *    但这**不能**写进类型 —— 写进去就等于宣布"永远不会出现第二个角色"。
 *
 * 2. **旧事实默认不得物理覆盖**（MI-06）。
 *    "我现在戒咖啡了"不是 `UPDATE`，而是"旧条 `SUPERSEDED` + 新条 `ACTIVE`"。
 *    计划书第 35 节：查当前状态返回新的，查历史两条都在。
 *
 * 3. **Memory 不是 Seed Identity**（MI-12）。
 *    这个文件不认识 `CharacterDefinition`，两者之间没有 import 关系。
 *    "她是谁"由 Seed 回答，"她记得什么"由 Memory 回答，M4 不混。
 */

import {
  KernelError,
  asMemoryId,
  makeMemoryId,
  type CharacterId,
  type MemoryId,
  type ProcessorVersion,
  type SchemaVersion,
  type Timestamp,
} from './ids.ts'

import { entityLabel, type EntityRef } from './entity.ts'

import {
  lookupPredicate,
  normalizePredicate,
  valueFitsShape,
  type PredicateKind,
  type PredicateSpec,
} from './memory-predicates.ts'

import type { SourceAuthority } from './source-authority.ts'

export const MEMORY_SCHEMA_VERSION = 1

/**
 * Memory Reducer 的版本。
 *
 * 与 `ProjectionReducer.version` 同一个道理（计划书第 24 / 29 节）：
 * 改了折叠语义就必须升这里，且**不允许**用新版本继续更新旧行的状态 ——
 * 必须先 `rebuildMemory()`。`memory-store.ts` 的写路径会失败关闭。
 */
export const MEMORY_REDUCER_VERSION = 'memory-reducer@1'

// ---------------------------------------------------------------------------
// MemoryType（计划书第 10–15 节：第一版只有四种）
// ---------------------------------------------------------------------------

/**
 * 计划书第 10 节写得很硬：
 *
 *     第一版只支持四种。不要继续膨胀。
 *
 * 因此这里**刻意不是开放 string**。多一个类型就要多一套"它怎么产生、
 * 怎么冲突、怎么纠正"的定义，而那些定义必须由计划书给出，不能由实现顺手决定。
 */
export type MemoryType = 'person_fact' | 'preference' | 'episode' | 'self_experience'

export const MEMORY_TYPES: readonly MemoryType[] = [
  'person_fact',
  'preference',
  'episode',
  'self_experience',
]

/**
 * Claim 家族 = 有事实槽位的两类（计划书第 16–17 节）。
 * Episode 家族 = 描述一段经历的两类。
 *
 * 这个划分**不是**为了好看：它决定 `canonicalKey` 存不存在、
 * 冲突检测走哪条路（第 76 节 vs 第 77 节）。写成一个函数是为了只有一处定义。
 */
export const CLAIM_MEMORY_TYPES: readonly MemoryType[] = ['person_fact', 'preference']
export const EPISODIC_MEMORY_TYPES: readonly MemoryType[] = ['episode', 'self_experience']

export function isClaimMemoryType(type: MemoryType): boolean {
  return CLAIM_MEMORY_TYPES.includes(type)
}

export function isEpisodicMemoryType(type: MemoryType): boolean {
  return EPISODIC_MEMORY_TYPES.includes(type)
}

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// MemoryStatus（计划书第 29–33 节）
// ---------------------------------------------------------------------------

/**
 * 计划书第 29 节：
 *
 *     第一版 ACTIVE / SUPERSEDED / RETRACTED / DISPUTED 足够。
 *     不要增加十几个生命周期。
 *
 * 四个状态各自回答一个不同的问题（混起来会让"她现在还信不信"无法回答）：
 *
 *   ACTIVE      —— 现在可以视为有效的长期记忆
 *   SUPERSEDED  —— **当时可能是真的**，但现在有更合适描述当下情况的新条（第 31 / 84 节）
 *   RETRACTED   —— 这条认知**本身被判定错误或不应保留**（第 32 / 84 节）
 *   DISPUTED    —— 存在矛盾证据，而系统还判不了哪个成立（第 33 节）
 */
export type MemoryStatus = 'active' | 'superseded' | 'retracted' | 'disputed'

export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  'active',
  'superseded',
  'retracted',
  'disputed',
]

/**
 * `SUPERSEDED` 与 `RETRACTED` 的区别是计划书第 84 节专门强调的一点，
 * 这里把它做成一个可断言的事实：**只有 `SUPERSEDED` 表示"曾经是真的"。**
 *
 * 用途：M5 召回时，`DISPUTED` 可以考虑降权召回（它可能是真的、只是有争议），
 * 而 `RETRACTED` **绝不允许**召回（计划书第 32 节："默认不得再进入 M5 Recall"）。
 */
export function isRecallEligible(status: MemoryStatus): boolean {
  return status === 'active' || status === 'disputed'
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// MemoryEpistemicStatus（计划书第 22–24 节）
// ---------------------------------------------------------------------------

/**
 * 计划书第 22 节：M4 使用四种。
 *
 * 但真正重要的是那一段限制：
 *
 *     M4 第一版允许形成正式长期的 PERSON_FACT / PREFERENCE 时，
 *     优先只接受 REPORTED。/ INFERRED 不直接成为用户事实。
 *
 * 这条限制**不在这里执行**，而在 `assertMemoryAuthorityAllows()` 里 ——
 * 因为"能不能建用户事实"取决于**权威等级**而不是认知状态本身
 * （`reported` 也可能来自一条工具观测，那时它不能成为用户事实）。
 */
export type MemoryEpistemicStatus = 'reported' | 'observed' | 'inferred' | 'generated'

export const MEMORY_EPISTEMIC_STATUSES: readonly MemoryEpistemicStatus[] = [
  'reported',
  'observed',
  'inferred',
  'generated',
]

export function isMemoryEpistemicStatus(value: unknown): value is MemoryEpistemicStatus {
  return (
    typeof value === 'string' &&
    (MEMORY_EPISTEMIC_STATUSES as readonly string[]).includes(value)
  )
}

// ---------------------------------------------------------------------------
// MemoryAuthority（计划书第 25–27 节）
// ---------------------------------------------------------------------------

/**
 * 计划书第 25 节刻意选择**枚举层级**而不是 0–100 权威分：
 *
 *     不要一开始使用看似精确的 0–100 权威分。
 *     第一版使用枚举层级更可靠。
 *
 * 理由是 0.73 与 0.75 的区别无法被任何人解释，而
 * `EXPLICIT_CORRECTION > EXPLICIT_USER_STATEMENT` 可以被解释。
 *
 * 顺序（计划书第 26 节）：
 *   EXPLICIT_CORRECTION > EXPLICIT_USER_STATEMENT > DIRECT_INTERACTION
 *     > TOOL_OBSERVATION > CHARACTER_GENERATION > MODEL_INFERENCE
 *
 * ⚠️ 计划书第 26 节同时提醒不要把这条关系当成所有领域的绝对真理
 * （"未来工具返回官方数据时，工具证据可能很强"）。
 * M4 只用它做**用户个人 Memory 的初始 policy**。
 */
export type MemoryAuthority =
  | 'EXPLICIT_CORRECTION'
  | 'EXPLICIT_USER_STATEMENT'
  | 'DIRECT_INTERACTION'
  | 'TOOL_OBSERVATION'
  | 'CHARACTER_GENERATION'
  | 'MODEL_INFERENCE'

/** 从高到低。数组顺序**就是**权威顺序，不是按字母排的。 */
export const MEMORY_AUTHORITIES: readonly MemoryAuthority[] = [
  'EXPLICIT_CORRECTION',
  'EXPLICIT_USER_STATEMENT',
  'DIRECT_INTERACTION',
  'TOOL_OBSERVATION',
  'CHARACTER_GENERATION',
  'MODEL_INFERENCE',
]

export function isMemoryAuthority(value: unknown): value is MemoryAuthority {
  return typeof value === 'string' && (MEMORY_AUTHORITIES as readonly string[]).includes(value)
}

/** 权威的数值秩（0 = 最高）。`compareAuthority()` 与测试用它，业务逻辑不用它。 */
export function authorityRank(authority: MemoryAuthority): number {
  const index = MEMORY_AUTHORITIES.indexOf(authority)
  if (index < 0) {
    throw new KernelError(
      'validation_error',
      'unknown_memory_authority',
      `未登记的 MemoryAuthority：${String(authority)}`
    )
  }
  return index
}

/** 返回负数表示 a 更权威（与 `Array.prototype.sort` 的比较器同号约定） */
export function compareAuthority(a: MemoryAuthority, b: MemoryAuthority): number {
  return authorityRank(a) - authorityRank(b)
}

// ---------------------------------------------------------------------------
// EvidenceRef（计划书第 39–41 节）
// ---------------------------------------------------------------------------

/**
 * 计划书第 39 节。当前绝大多数是 `conversation_event`。
 *
 * 为什么 `id` 是 `string` 而不是 `ConversationEventId`：
 * 未来 `observation` / `tool_observation` 的 id 不是对话事件 id。
 * 用窄类型会迫使未来的工具观测**伪装成对话事件**才能当证据 ——
 * 那正是 `observation.ts` 用 `sourceEventIds: string[]` 的同一条理由。
 */
export type EvidenceKind =
  | 'conversation_event'
  | 'observation'
  | 'domain_event'
  | 'tool_observation'
  /**
   * **后 Lv2 · S8 / ADR-093 `D02`**：已提交的世界账本条目（观测或提交身份）。
   *
   * ```text
   * 追加，**不改**旧四个值的含义；旧 decoder / 旧行 / 旧投影不重写（S8-A04）
   * id 形状 = story:<storyId>@v<ver>#<runId>.<eventId>（观测）或 ...e<revision>（提交）
   * 它**永不**支持外部事实：authority 仍是 STORY_OBSERVATION（canSupportExternalFact = false）
   * ```
   */
  | 'story_event'

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'conversation_event',
  'observation',
  'domain_event',
  'tool_observation',
  'story_event',
]

export interface EvidenceRef {
  kind: EvidenceKind
  id: string
}

export function evidenceRef(kind: EvidenceKind, id: string): EvidenceRef {
  if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
    throw new KernelError(
      'validation_error',
      'unknown_evidence_kind',
      `未登记的 EvidenceKind：${String(kind)}`
    )
  }
  if (typeof id !== 'string' || id.trim() === '') {
    throw new KernelError(
      'validation_error',
      'empty_evidence_id',
      'EvidenceRef 的 id 不能为空：没有具体来源的"证据"等于没有证据（MI-03）'
    )
  }
  return { kind, id }
}

export function evidenceRefEquals(a: EvidenceRef, b: EvidenceRef): boolean {
  return a.kind === b.kind && a.id === b.id
}

export function evidenceLabel(ref: EvidenceRef): string {
  return `${ref.kind}:${ref.id}`
}

/** 从对话事件 id 构造（最常见的一处，单独给个名字让调用点可读） */
export function conversationEvidence(eventId: string): EvidenceRef {
  return evidenceRef('conversation_event', eventId)
}

// ---------------------------------------------------------------------------
// MemoryContent（计划书第 16–20 节）
// ---------------------------------------------------------------------------

/**
 * Claim 型内容（PERSON_FACT / PREFERENCE）。
 *
 * ============================================================================
 *  为什么要有 predicate（计划书第 18 节）
 * ============================================================================
 * 原话是：
 *
 *     因为未来需要判断："我喜欢咖啡"和"我不喝咖啡了"是否冲突。
 *     如果全部只是自然语言字符串，冲突检测会完全依赖 LLM。
 *
 * 因此 `subject + predicate` 就是"同一个事实槽位"的定义。
 *
 * `qualifiers` 是计划书第 152 节明确要求的能力：
 *
 *     技术问题我喜欢详细解释，普通闲聊简单点就行。
 *     → 不能错误合并成"用户喜欢详细"或"用户喜欢简短"
 *
 * 因此 qualifiers 进 `canonicalKey`：`{context: 'technical'}` 与
 * `{context: 'casual'}` 是**两个不同的槽位**，各自可以有 ACTIVE 的记忆。
 */
export interface ClaimMemoryContent {
  kind: 'claim'
  /** 这条断言讲的是谁/什么。**必须**与 Record.subjects[0] 一致（构造器会校验） */
  subject: EntityRef
  /** 规范化的槽位键（`normalizePredicate()` 的结果） */
  predicate: string
  /** 槽位取值。形状由 `memory-predicates.ts` 的登记表**提示**，不强制 */
  value: unknown
  /** 限定范围。进 canonicalKey，因此不同 qualifier 是不同槽位 */
  qualifiers?: Record<string, unknown>
}

/**
 * Episode 型内容（EPISODE / SELF_EXPERIENCE，计划书第 20 节）。
 *
 * Episode **没有 predicate**：一段经历不是一个事实槽位，
 * 给它编一个键只会得到一个永远匹配不上的假槽位。
 * 因此 `canonicalKeyOf()` 对 Episode 返回 `undefined`，
 * 去重走第三层的"有限候选集 + judge"（计划书第 77 节）。
 */
export interface EpisodicMemoryContent {
  kind: 'episode'
  summary: string
  /** 这段经历有哪些参与者。至少一个（"她独自经历"也是一种参与者） */
  participants: EntityRef[]
  /**
   * 组成这段经历的事件引用。
   *
   * 计划书第 20 节用的是 `eventRefs: string[]`。这里**不额外多一层类型**：
   * 它与 `MemoryRecord.sourceRefs` 不是同一个概念 ——
   * `sourceRefs` 是"这条记忆凭什么成立"（证据），
   * `eventRefs` 是"这段经历由哪些事件组成"（叙事结构）。
   * 两者今天高度重叠，但未来一段 Episode 可能由多段对话 +
   * 若干工具观测组成，那时它们就分开了。
   */
  eventRefs: string[]
  topicTags?: string[]
}

export type MemoryContent = ClaimMemoryContent | EpisodicMemoryContent

export function isClaimContent(content: MemoryContent): content is ClaimMemoryContent {
  return content.kind === 'claim'
}

export function isEpisodicContent(content: MemoryContent): content is EpisodicMemoryContent {
  return content.kind === 'episode'
}

// ---------------------------------------------------------------------------
// MemoryRecord（计划书第 21 节）
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 *  `MemoryRecord` 是**当前投影**，不是事实本体（计划书第 72 节）
 * ============================================================================
 * 事实本体是 `character_domain_events` 里的 `MEMORY_*` 事件。
 * 这个结构随时可以从事件重建（`rebuildMemory(memoryId)`），
 * 因此改 reducer 语义不必丢历史。
 *
 * ⚠️ 三个字段**不要**混淆（计划书第 34–41 节）：
 *   owner       —— 谁拥有这条记忆（当前恒为苏沐薇）
 *   subjects    —— 这条记忆讲的是谁/什么（复数：一段共同经历有两个主体）
 *   sourceRefs  —— 这条记忆根据什么建立（证据，MI-03 要求非空）
 */
export interface MemoryRecord {
  id: MemoryId

  /** 谁拥有这条记忆。计划书第 7 节：当前绝大部分是 `{ kind:'character', id:'char_sumuwei' }` */
  owner: EntityRef

  type: MemoryType

  content: MemoryContent

  /**
   * 这条记忆讲的是谁/什么（计划书第 8 节）。
   *
   * 复数不是"为了灵活"：计划书第 8 节的例子
   * "我们曾经讨论过 AI Agent" 天然有**两个**主体。
   * 用单数会让那条记忆只能记成"她记得自己和某人"，丢掉对象是谁。
   */
  subjects: EntityRef[]

  epistemicStatus: MemoryEpistemicStatus

  authority: MemoryAuthority

  /**
   * 值得长期记住的程度（0..1）。
   *
   * ⚠️ 计划书第 52 节专门强调：**confidence ≠ importance**。
   * "我今天午饭吃了面"的 confidence 很高，但长期 importance 很低。
   * 两者必须分开存，混起来会让"确定但没价值"的东西被永久记住。
   */
  importance: number

  /** 对内容正确性的置信度（0..1）。与 `importance` 独立，见上 */
  confidence: number

  status: MemoryStatus

  /** 证据（MI-03：**必须**非空，否则不允许写入） */
  sourceRefs: EvidenceRef[]

  /**
   * 证据的**根** id（计划书第 40–41 节）。
   *
   * 这是为未来防 Reflection 自我强化预留的：
   *   Memory A 来自 Event #100
   *   Memory B 基于 A 总结产生
   *   → B 的 evidenceRootIds **仍然应该包含** Event #100，
   *     不能伪造成新的独立证据（计划书第 41 节）
   *
   * M4 就把这条写成断言函数，尽管真正的派生链要等 M11。
   */
  evidenceRootIds: string[]

  /** 事实从什么时候开始有效（计划书第 36 节）。缺省 = 不知道 */
  validFrom?: Timestamp

  /**
   * 事实到什么时候失效。
   *
   * `null` 与 `undefined` 的区别刻意保留：
   *   undefined = 不知道 / 不适用
   *   null      = **明确地"没有终点"**（当前有效，且预期继续有效）
   * 用 `null` 承载后者是 SQL 语义的自然延伸，也是 `rebuildMemory` 时
   * 能区分"这条被 supersede 过又被 restore"的关键。
   */
  validUntil?: Timestamp | null

  /** 这件事什么时候发生（Episode 必备；Claim 可选）。计划书第 37–38 节 */
  occurredAt?: Timestamp

  /** 系统什么时候创建这条记忆（**必有**，计划书第 37 节） */
  recordedAt: Timestamp

  /** 这条取代了哪些旧记忆（MI-07：Correction 必须能追溯旧 Memory） */
  supersedes?: MemoryId[]

  /** 这条被哪条取代（`SUPERSEDED` 时必有） */
  supersededBy?: MemoryId

  /** 产生这条记忆的组件名与版本（计划书第 66–67 节） */
  processor?: string
  processorVersion?: ProcessorVersion

  /**
   * Claim 型的事实槽位键（计划书第 34 节）。
   * Episode 型为 `undefined`（它没有槽位）。
   */
  canonicalKey?: string

  /**
   * 内容指纹（计划书第 75 节去重第一层）。
   *
   * 与 `canonicalKey` 的关系：
   *   canonicalKey  —— **同一个槽位**（不含取值，用于找冲突对象）
   *   fingerprint   —— **同一个内容**（含取值，用于判完全重复）
   */
  contentFingerprint: string

  /** 算出这一行的 reducer 版本（改了语义必须先 rebuild） */
  reducerVersion: string

  /**
   * 乐观锁版本。每成功应用一个领域事件 +1。
   *
   * 与 `character_projections` 的 `revision` 同义，
   * 但**刻意不复用那张表** —— 理由见
   * `docs/m4/compatibility-audit.md` §5 F1：
   * `character_projections` 的前提是"一个角色一种投影一行"，
   * 而 Memory 需要"每条记忆各自一行、各自独立重放"。
   */
  revision: number

  schemaVersion: SchemaVersion

  createdAt: Timestamp
  updatedAt: Timestamp
}

// ---------------------------------------------------------------------------
// 稳定序列化与摘要
// ---------------------------------------------------------------------------

/**
 * 确定性序列化：对象键**排序**后输出。
 *
 * 为什么必须自己写：`JSON.stringify` 按**插入顺序**输出键，
 * 于是 `{a:1,b:2}` 与 `{b:2,a:1}` 得到不同字符串 ——
 * 而这两个对象在语义上完全相同。用在 canonicalKey 上会导致
 * "同一件事在不同代码路径下算出两个槽位"，而这种缺陷**不报错**。
 *
 * 处理范围刻意保守：只支持 JSON 可表达的值 +
 * 兜底 `String(value)`。遇到不支持的类型（函数、Symbol）时
 * **抛错**而不是静默变成 `[object Object]` ——
 * 后者会让两条不同的记忆撞上同一个指纹。
 */
export function stableMaterial(value: unknown): string {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string') return JSON.stringify(value)
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new KernelError(
        'validation_error',
        'non_finite_in_material',
        `稳定序列化不接受 NaN / Infinity：它们会让指纹在不同平台算出不同结果（收到 ${String(value)}）`
      )
    }
    return String(value)
  }
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'undefined') return 'undefined'
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableMaterial(item)).join(',')}]`
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableMaterial(record[k])}`).join(',')}}`
  }
  throw new KernelError(
    'validation_error',
    'unsupported_material_value',
    `稳定序列化不支持 ${type} 类型的值：它无法被确定性表达，会让指纹失去意义`
  )
}

/**
 * FNV-1a 64 位风格的稳定摘要。
 *
 * 与 `job.ts` 的 `computeIdempotencyKey()` **同一个算法、同一份理由**：
 *
 *     不用 crypto：它在这里只是"把长键压短"，不是安全用途；
 *     而且同步实现让构造保持纯函数。
 *
 * ⚠️ 因此必须知道它的局限（写进 `memory-backend-contract.md`）：
 * **FNV-1a 不是抗碰撞哈希。** 两个人可能撞键。在 Memory 这个规模下
 * 可接受（撞键的后果是"被当成同一槽位"，由第二、三层去重继续判），
 * 但它**不能**被当作安全边界或跨租户隔离手段。
 */
export function memoryDigest(material: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < material.length; i += 1) {
    hash ^= BigInt(material.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

// ---------------------------------------------------------------------------
// CanonicalMemoryKey（计划书第 34 / 76 节）
// ---------------------------------------------------------------------------

/**
 * 事实槽位键：`owner + subject + type + predicate + qualifier scope`。
 *
 * **不含 `value`** —— 正因为不含主取值，它才能回答
 * "是否正在描述同一个事实槽位"（计划书第 34 节），
 * 从而让"我喜欢咖啡"与"我不喝咖啡了"落到同一个 key 上、
 * 进而被判定为 temporal update 或 conflict（第 79–82 节）。
 */
export type CanonicalMemoryKey = string

/** Claim 型槽位键。Episode 返回 `undefined`（它没有槽位） */
export function canonicalKeyOf(input: {
  owner: EntityRef
  type: MemoryType
  content: MemoryContent
}): CanonicalMemoryKey | undefined {
  if (!isClaimMemoryType(input.type)) return undefined
  if (!isClaimContent(input.content)) {
    throw new KernelError(
      'validation_error',
      'content_type_mismatch',
      `${input.type} 是 Claim 家族，但 content.kind = ${input.content.kind}：` +
        '内容家族与记忆类型必须一致（计划书第 16 节），否则 canonicalKey 会建立在错误的形状上'
    )
  }

  const content = input.content

  /*
   * ============================================================================
   *  qualifier scope = **整个 qualifiers**（键 + 取值）
   * ============================================================================
   * 曾经把这里写成"只取键名、丢弃取值"，它**看起来**更符合
   * "value 不进 key" 这条原则，但那是把两件事混了：
   *
   *     content.value       —— 这条断言的主取值（"详细"）
   *     content.qualifiers  —— 限定这条断言在**什么条件下**成立（"技术问题"）
   *
   * "技术问题要详细解释"与"闲聊要简短"（计划书第 152 节）是**两个不同槽位**，
   * 区别恰恰在 qualifier 的**取值**（technical vs casual）。
   * 丢弃取值会让它们算出同一个 key，于是被"错误合并" ——
   * 而计划书第 152 节点名禁止的正是这件事。
   *
   * 修正后的语义可以一句话说清：
   *   · `value` 是同一槽位下的不同取值 → supercede 关系
   *   · `qualifiers` 是限定条件 → 条件是槽位身份的一部分
   *
   * ⚠️ 这一条由 `kernel-tests-memory.ts` 的
   * "qualifier 不同的偏好是两个槽位" 守住。
   *
   * ---------------------------------------------------------------------------
   *  ⚠️ predicate 必须**先规范化**再进材料（第二处实测缺陷）
   * ---------------------------------------------------------------------------
   * `normalizePredicate()` 把大小写与分隔符折叠成同一个键
   * （`Food.Preference.Cilantro` → `food.preference.cilantro`）。
   * 而第一版直接用 `content.predicate` 原文进摘要 ——
   * 于是**同一个槽位**在不同写法下算出了**不同的 canonicalKey**：
   *
   *     去重第二层与冲突分析全线失效
   *
   * 后果**不报错**：同槽位的重复陈述被判为"新槽位"（每次多说一遍就多一条记忆），
   * "他改主意了"找不到旧条（不会 supersede，两条并存）。
   *
   * 规范化是幂等的（`normalize(normalize(x)) === normalize(x)`），
   * 因此对已经规范过的 predicate 再调一次没有副作用 ——
   * 这正是它可以安全地放在这里、而不必依赖调用方先规范化的原因。
   */
  const qualifierScope = content.qualifiers ?? {}

  return memoryDigest(
    stableMaterial({
      owner: entityLabel(input.owner),
      type: input.type,
      subject: entityLabel(content.subject),
      predicate: normalizePredicate(content.predicate),
      qualifierScope,
    })
  )
}

/**
 * 内容指纹（计划书第 75 节去重第一层）：
 * `owner + subject + type + normalized content`。
 *
 * 与 canonicalKey 的差别是**含取值**：完全相同才撞指纹。
 */
export function contentFingerprintOf(input: {
  owner: EntityRef
  type: MemoryType
  content: MemoryContent
  subjects: readonly EntityRef[]
}): string {
  return memoryDigest(
    stableMaterial({
      owner: entityLabel(input.owner),
      type: input.type,
      subjects: input.subjects.map(entityLabel).sort(),
      content: input.content,
    })
  )
}

/**
 * 由规范化后的槽位材料派生 MemoryId 的 slot。
 *
 * ============================================================================
 *  这个函数是幂等的**唯一**落地点
 * ============================================================================
 * 见 `docs/m4/compatibility-audit.md` §6 F4：同一批事件会产出多条候选，
 * 而幂等键里必须含 memoryId 才能让候选各自独立。
 *
 * 确定性派生同时解决了两件看起来矛盾的事：
 *   · **重跑同一批** → 同一条事实 → 同一个 slot → 同一个 memoryId → 幂等命中（不重复记）
 *   · **同一批里的不同事实** → 材料不同 → 不同 slot → 不同 memoryId → 都能写入
 *
 * 注意它**含取值**（用 `contentFingerprintOf` 的材料）：
 * "我喜欢咖啡" 与 "我戒咖啡了" 必须是**两条**记忆，
 * 因此它们不能用同一个 id。跨槽位更新靠 canonicalKey 去找目标，
 * 不靠 id 相同。
 */
export function memorySlotFor(input: {
  owner: EntityRef
  type: MemoryType
  content: MemoryContent
  subjects: readonly EntityRef[]
}): string {
  const fingerprint = contentFingerprintOf(input)
  // 前缀让 id 在日志里可读："preference-fe3a1b2c" 一眼看出是哪一类
  return `${input.type}-${fingerprint}`
}

// ---------------------------------------------------------------------------
// 槽位级指纹（计划书第 76 节去重第二层的判定材料）
// ---------------------------------------------------------------------------

/**
 * 槽位级指纹：`canonicalKey + 规范化取值`。
 *
 * ============================================================================
 *  它与 `contentFingerprintOf` 的区别（决定了两层各自抓什么）
 * ============================================================================
 *   `contentFingerprintOf`（第一层）含 **qualifiers 全部内容 + subjects 排序**
 *      → 抓的是"这条记忆是不是一模一样"
 *   `slotFingerprintOf`（本函数）只含 **canonicalKey + 取值**
 *      → 抓的是"同一个槽位上，用户说的是不是同一个值"
 *
 * 为什么需要第二个：两条记忆可以**内容不同**（qualifiers 写法略有差别、
 * subjects 顺序不同）但指向同一个槽位的同一个取值。第一层抓不到它们，
 * 而那会让"他第三次说他不吃香菜"在库里留下第三条记录 ——
 * 计划书第 177 节（M4-004）明确要求"最终不应该有三条 Active Memory"。
 *
 * ⚠️ 放在契约层而不是 app 层：它是**领域概念**（与 `canonicalKeyOf` /
 * `contentFingerprintOf` 同级），而放行口（`policies/`）需要用它，
 * 却**不允许**反向 import app 层。
 */
export function slotFingerprintOf(input: { canonicalKey: string; value: unknown }): string {
  return memoryDigest(
    stableMaterial({
      canonicalKey: input.canonicalKey,
      // 取值做**稳定序列化**：`{a:1,b:2}` 与 `{b:2,a:1}` 是同一个值
      value: input.value,
    })
  )
}

/** 从一条记录算出它的槽位（Claim 型才有；Episode 返回 undefined） */
export function slotOfRecord(
  record: MemoryRecord
): { canonicalKey: string; slotFingerprint: string } | undefined {
  if (record.canonicalKey === undefined) return undefined
  if (!isClaimContent(record.content)) return undefined
  return {
    canonicalKey: record.canonicalKey,
    slotFingerprint: slotFingerprintOf({
      canonicalKey: record.canonicalKey,
      value: record.content.value,
    }),
  }
}

/** 从一条候选算出它的槽位（Claim 型才有；Episode 返回 undefined） */
export function slotOfCandidate(
  candidate: MemoryCandidate
): { canonicalKey: string; slotFingerprint: string } | undefined {
  const canonicalKey = canonicalKeyOf({
    owner: candidate.owner,
    type: candidate.proposedType,
    content: candidate.proposedContent,
  })
  if (canonicalKey === undefined) return undefined
  if (!isClaimContent(candidate.proposedContent)) return undefined
  return {
    canonicalKey,
    slotFingerprint: slotFingerprintOf({
      canonicalKey,
      value: candidate.proposedContent.value,
    }),
  }
}

// ---------------------------------------------------------------------------
// 失败关闭的三条约束（M4 的核心防线）
// ---------------------------------------------------------------------------

/**
 * MI-03 / 计划书第 40 节：Memory 必须存在 Evidence，且必须能追到根。
 *
 * 三条检查，每条对应一个真实的失败模式：
 *   1. `sourceRefs` 为空 → 这条记忆"凭什么成立"没有答案
 *   2. `evidenceRootIds` 为空 → 未来 Reflection 无法追回源头，会自我强化
 *   3. 根证据不在来源里 → 计划书第 41 节明确禁止的"伪造成新的独立证据"
 *
 * ⚠️ 第 3 条在 M4 是**弱形式**：只要求 `evidenceRootIds ⊆ sourceRefs` 的 id 集。
 * 强形式（"B 的根必须包含 A 的根"）需要 A→B 的派生链，
 * 那条链要等 M11 的 Reflection —— 但断言函数现在就写好并测试。
 */
export function assertMemoryEvidence(input: {
  sourceRefs: readonly EvidenceRef[]
  evidenceRootIds: readonly string[]
}): void {
  if (input.sourceRefs.length === 0) {
    throw new KernelError(
      'validation_error',
      'memory_without_evidence',
      'Memory 必须有至少一个 Evidence（MI-03）。没有来源的"长期记忆"无法审计，也无法在被质疑时回答它凭什么存在'
    )
  }
  if (input.evidenceRootIds.length === 0) {
    throw new KernelError(
      'validation_error',
      'memory_without_evidence_root',
      'Memory 必须有至少一个 evidenceRootId（计划书第 40 节）。' +
        '少了它，未来 Reflection 产生的派生结论会被当成独立证据重复计票'
    )
  }
  const sourceIds = new Set(input.sourceRefs.map((ref) => ref.id))
  const foreign = input.evidenceRootIds.filter((id) => !sourceIds.has(id))
  if (foreign.length > 0) {
    throw new KernelError(
      'validation_error',
      'evidence_root_not_in_sources',
      `evidenceRootIds 里有不属于 sourceRefs 的 id：${foreign.join(', ')}。` +
        '这等于伪造一份新的独立证据（计划书第 41 节），而不只是"多了一个字段"'
    )
  }
}

/**
 * MI-09 / 计划书第 27 节：用户个人事实的**严格政策**。
 *
 *   PERSON_FACT / PREFERENCE 可以直接建立：EXPLICIT_USER_STATEMENT、EXPLICIT_CORRECTION
 *   不直接建立：CHARACTER_GENERATION、MODEL_INFERENCE
 *   DIRECT_INTERACTION 主要用于 EPISODE / SELF_EXPERIENCE，**不**用来推断用户属性
 *   TOOL_OBSERVATION 对用户个人事实**不成立**（工具观测的是世界，不是用户的自述）
 *
 * ============================================================================
 *  为什么这条必须是**代码**而不是 prompt 里的一句叮嘱
 * ============================================================================
 * 计划书第 148 节把"污染"列为 M4 Critical Test：
 *
 *     用户："猜猜我的生日。"
 *     苏沐薇："我猜是 8 月 3 日。"
 *     → 最终 Memory 不得出现：User birthday = Aug 3
 *
 * 若这条只写在 prompt 里，它的强度取决于模型当天听不听话；
 * 写成断言之后，"把 assistant 的猜测变成用户事实"在**结构上不可能**。
 */
export function assertMemoryAuthorityAllows(input: {
  authority: MemoryAuthority
  type: MemoryType
  epistemicStatus: MemoryEpistemicStatus
}): void {
  if (!isClaimMemoryType(input.type)) {
    // Episode / SELF_EXPERIENCE 描述的是"真实发生过"，因此 DIRECT_INTERACTION
    // 是它的**主要**权威来源。但它同样不能被"她自己编的"建立。
    if (input.authority === 'CHARACTER_GENERATION' && input.type === 'self_experience') {
      throw new KernelError(
        'validation_error',
        'authority_cannot_establish_self_experience',
        'SELF_EXPERIENCE 不能由 CHARACTER_GENERATION 建立（计划书第 149 节）：' +
          '她此刻说的话不是"她曾经历过"的证据 —— 除非那件事真的在可验证历史里',
        { type: input.type, authority: input.authority }
      )
    }
    if (input.authority === 'MODEL_INFERENCE') {
      throw new KernelError(
        'validation_error',
        'inference_cannot_establish_episode',
        'MODEL_INFERENCE 不能建立 Episode / SELF_EXPERIENCE：' +
          '一段"经历"要么真的发生过（OBSERVED / DIRECT_INTERACTION），要么根本不该被记为经历',
        { type: input.type, authority: input.authority }
      )
    }
    return
  }

  const allowed: readonly MemoryAuthority[] = ['EXPLICIT_USER_STATEMENT', 'EXPLICIT_CORRECTION']
  if (allowed.includes(input.authority)) return

  throw new KernelError(
    'validation_error',
    'authority_cannot_establish_person_fact',
    `${input.type} 只能由 ${allowed.join(' / ')} 建立，收到 ${input.authority}（计划书第 27 节）。` +
      '这条不是"建议"：它拦住的是"她自己的输出静默升级成关于用户的长期事实"，' +
      '而那条链一旦成立就无法回溯修正（计划书第 148 节，M4 Critical Test）',
    {
      type: input.type,
      authority: input.authority,
      epistemicStatus: input.epistemicStatus,
      allowed,
    }
  )
}

/**
 * Claim 内容的结构校验。
 *
 * 三件事：predicate 可规范化、取值与登记表相容（只告警不拒绝）、
 * subject 与 `subjects[0]` 一致（防止"内容说 A、索引说 B"）。
 *
 * 返回值带上 `predicateKind` 让调用方能把"未登记的键"记进 trace ——
 * 这是计划书第 19 节"足够稳定即可"与"不要退化成什么都收"之间的落地点。
 */
export function validateClaimContent(input: {
  content: ClaimMemoryContent
  subjects: readonly EntityRef[]
}): { predicate: string; predicateKind: PredicateKind; spec?: PredicateSpec; shapeWarning?: string } {
  const content = input.content
  const predicate = normalizePredicate(content.predicate)

  if (input.subjects.length === 0) {
    throw new KernelError(
      'validation_error',
      'claim_without_subject',
      'Claim 型记忆必须至少有一个 subject：不知道"这条说的是谁"的事实无法被检索，也无法被判冲突'
    )
  }

  const first = input.subjects[0]
  if (first.kind !== content.subject.kind || String(first.id) !== String(content.subject.id)) {
    throw new KernelError(
      'validation_error',
      'claim_subject_mismatch',
      `content.subject（${entityLabel(content.subject)}）与 subjects[0]（${entityLabel(first)}）不一致。` +
        '两处都表达"讲的是谁"，不一致就一定会有一天对不上 —— 而那时数据已经进库了',
      { contentSubject: entityLabel(content.subject), subjectsZero: entityLabel(first) }
    )
  }

  const lookup = lookupPredicate(predicate)
  if (lookup.kind === 'registered' && lookup.spec) {
    const fit = valueFitsShape(lookup.spec, content.value)
    if (!fit.fits) {
      // 刻意**只告警不拒绝**（见 memory-predicates.ts 的 valueFitsShape 说明）：
      // 硬拒会丢掉真实事实，而记下来 + 计数才让"要不要收窄这个槽位"可被数据回答。
      return {
        predicate,
        predicateKind: 'registered',
        spec: lookup.spec,
        shapeWarning: fit.reason,
      }
    }
    return { predicate, predicateKind: 'registered', spec: lookup.spec }
  }

  return { predicate, predicateKind: 'unregistered' }
}

/** Episode 内容的结构校验（计划书第 13 / 20 节） */
export function validateEpisodicContent(input: {
  type: MemoryType
  content: EpisodicMemoryContent
}): void {
  const content = input.content
  if (typeof content.summary !== 'string' || content.summary.trim() === '') {
    throw new KernelError(
      'validation_error',
      'episode_without_summary',
      'Episode 必须有 summary：没有摘要的"经历"在未来的上下文里无法被使用，只会占空间'
    )
  }
  if (!Array.isArray(content.participants) || content.participants.length === 0) {
    throw new KernelError(
      'validation_error',
      'episode_without_participants',
      'Episode 必须有至少一个 participant（计划书第 13 节）。' +
        '"她独自经历"也是参与者为 [她] 的一段经历，但空数组不是',
      { type: input.type }
    )
  }
  if (!Array.isArray(content.eventRefs) || content.eventRefs.length === 0) {
    throw new KernelError(
      'validation_error',
      'episode_without_event_refs',
      'Episode 必须有 eventRefs（计划书第 13 / 20 节）：' +
        '一段"经历"必须能说清它由哪些真实事件组成，否则它与编造无法区分'
    )
  }
}

/**
 * 内容与类型的匹配校验（计划书第 16 / 20 节）。
 *
 * 计划书第 20 节：
 *     SELF_EXPERIENCE 可以 kind = episode，但 MemoryType 不同。
 *
 * 因此合法的组合**只有四种**：claim×(person_fact|preference) 与
 * episode×(episode|self_experience)。交叉的组合必须被拒绝 ——
 * 否则 `canonicalKey` 会被算在一个没有槽位的形状上，
 * 而那种缺陷不会报错，只会让冲突检测静默失效。
 */
export function assertContentMatchesType(type: MemoryType, content: MemoryContent): void {
  const claimType = isClaimMemoryType(type)
  const claimContent = isClaimContent(content)
  if (claimType !== claimContent) {
    throw new KernelError(
      'validation_error',
      'content_type_mismatch',
      `${type} 属于 ${claimType ? 'Claim' : 'Episode'} 家族，` +
        `但 content.kind = ${content.kind}（计划书第 16 / 20 节）`,
      { type, contentKind: content.kind }
    )
  }
}

// ---------------------------------------------------------------------------
// MemoryCandidate（计划书第 43 节）
// ---------------------------------------------------------------------------

/**
 * 抽取器产出的候选。
 *
 * ============================================================================
 *  Candidate **不是**正式 Memory（计划书第 43 / 47 节）
 * ============================================================================
 * 计划书写得很明确：
 *
 *     MemoryExtractor → MemoryCandidate[] 然后停止。
 *     不能：MemoryExtractor → INSERT memory
 *
 * 因此这个类型**没有** `status` / `revision` / `supersededBy` ——
 * 那些是 reducer 折叠出来的结果，不是候选能自己声称的。
 * 少了这几个字段，"抽取器顺手把状态写成 ACTIVE"在类型上就写不出来。
 */
export interface MemoryCandidate {
  /** 建议的 id（由 `memorySlotFor` 确定性派生）。**尚未**进库 */
  proposedId: MemoryId

  owner: EntityRef

  proposedType: MemoryType

  proposedContent: MemoryContent

  subjects: EntityRef[]

  sourceRefs: EvidenceRef[]

  evidenceRootIds: string[]

  epistemicStatus: MemoryEpistemicStatus

  authority: MemoryAuthority

  importance: number
  confidence: number

  proposedValidFrom?: Timestamp

  /**
   * 抽取器自己声称事实发生的时间（可空）。计划书第 43 节的 `proposedValidFrom` 只覆盖
   * "何时开始有效"，而 Episode 还需要"何时发生" —— 因此多这一个可选字段。
   */
  proposedOccurredAt?: Timestamp

  processor: string
  processorVersion: ProcessorVersion

  /**
   * 未登记 predicate 的键（若这条候选是 Claim 且键未登记）。
   *
   * 它**不是**候选自己声称的：由 `createMemoryCandidateFromClaim()` 在
   * 校验时填上。存在的意义是让 Policy 与 trace 能把
   * "这一批有几个没归类的槽位"变成可见的数字（计划书第 19 节）。
   */
  unregisteredPredicate?: string

  /** 取值形状告警（已登记槽位但取值不在合法集合内）。同样由校验填写 */
  predicateShapeWarning?: string
}

export interface NewMemoryCandidate {
  owner: EntityRef
  type: MemoryType
  content: MemoryContent
  subjects: EntityRef[]
  sourceRefs: EvidenceRef[]
  evidenceRootIds?: string[]
  epistemicStatus: MemoryEpistemicStatus
  authority: MemoryAuthority
  importance: number
  confidence: number
  proposedValidFrom?: Timestamp
  proposedOccurredAt?: Timestamp
  processor: string
  processorVersion: ProcessorVersion
  /** 只用于测试与合成输入：显式指定 proposedId */
  id?: MemoryId
}

/**
 * 构造候选。**失败关闭的四条**：
 *   1. 内容与类型匹配（第 16 / 20 节）
 *   2. 权威是否够建这类记忆（第 27 节 / MI-09）
 *   3. 证据与根（第 40–41 节 / MI-03）
 *   4. importance / confidence 在 [0,1] 且有限
 *
 * `evidenceRootIds` **缺省 = 取 sourceRefs 的 id**。
 * 这个缺省是**正确的**而不是省事的：候选直接来自真实事件时，
 * 那些事件**就是**根证据（计划书第 40 节的例子正是 ConversationEvent）。
 * 只有当候选派生自另一条 Memory 时，调用方才必须显式传更早的根。
 */
export function createMemoryCandidate(input: NewMemoryCandidate): MemoryCandidate {
  assertContentMatchesType(input.type, input.content)
  assertMemoryAuthorityAllows({
    authority: input.authority,
    type: input.type,
    epistemicStatus: input.epistemicStatus,
  })

  const sourceRefs = input.sourceRefs.map((ref) => evidenceRef(ref.kind, ref.id))
  const evidenceRootIds =
    input.evidenceRootIds !== undefined
      ? [...input.evidenceRootIds]
      : [...new Set(sourceRefs.map((ref) => ref.id))]

  assertMemoryEvidence({ sourceRefs, evidenceRootIds })

  if (!Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1) {
    throw new KernelError(
      'validation_error',
      'bad_importance',
      `importance 必须在 [0,1] 且有限，收到 ${String(input.importance)}`
    )
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new KernelError(
      'validation_error',
      'bad_confidence',
      `confidence 必须在 [0,1] 且有限，收到 ${String(input.confidence)}`
    )
  }

  let unregisteredPredicate: string | undefined
  let predicateShapeWarning: string | undefined
  /*
   * ⚠️ 内容对象**必须复制一份再改**。
   *
   * 第一版直接改写 `input.content.predicate`（"把规范化后的 predicate 写回内容"），
   * 那是**改调用方的对象**：调用者手里那份与候选里那份会一起变，
   * 于是"候选里的内容"与"我传进去的内容"不再是两件事。
   * 它不会立刻报错，但会让"同一个 content 对象被两条候选共用"这类
   * 用法产生互相干扰 —— 而那种缺陷只在特定调用顺序下出现。
   */
  const content: ClaimMemoryContent | EpisodicMemoryContent = isClaimContent(input.content)
    ? { ...input.content, qualifiers: input.content.qualifiers ? { ...input.content.qualifiers } : undefined }
    : { ...input.content, participants: [...input.content.participants], eventRefs: [...input.content.eventRefs] }

  if (isClaimContent(content)) {
    const checked = validateClaimContent({
      content,
      subjects: input.subjects,
    })
    // 把规范化后的 predicate 写进**复制品**：否则库里会同时出现
    // `Food.Preference` 与 `food.preference` 两条**看起来不同**的槽位
    content.predicate = checked.predicate
    if (checked.predicateKind === 'unregistered') unregisteredPredicate = checked.predicate
    if (checked.shapeWarning) predicateShapeWarning = checked.shapeWarning
  } else {
    validateEpisodicContent({ type: input.type, content })
  }

  const proposedId =
    input.id ??
    makeMemoryId(
      // characterId 由 owner 推导：owner 就是"谁拥有这条记忆"，
      // 而 MemoryId 的作用域正是 owner 的 Memory Space（计划书第 7 节）
      ownerCharacterId(input.owner),
      memorySlotFor({
        owner: input.owner,
        type: input.type,
        content,
        subjects: input.subjects,
      })
    )

  return {
    proposedId: asMemoryId(String(proposedId)),
    owner: input.owner,
    proposedType: input.type,
    // 复制品进候选：调用方后面若改自己那份，不会影响已构造的候选
    proposedContent: content,
    subjects: [...input.subjects],
    sourceRefs,
    evidenceRootIds,
    epistemicStatus: input.epistemicStatus,
    authority: input.authority,
    importance: input.importance,
    confidence: input.confidence,
    ...(input.proposedValidFrom !== undefined
      ? { proposedValidFrom: input.proposedValidFrom }
      : {}),
    ...(input.proposedOccurredAt !== undefined
      ? { proposedOccurredAt: input.proposedOccurredAt }
      : {}),
    processor: input.processor,
    processorVersion: input.processorVersion,
    ...(unregisteredPredicate !== undefined ? { unregisteredPredicate } : {}),
    ...(predicateShapeWarning !== undefined ? { predicateShapeWarning } : {}),
  }
}

/**
 * owner → characterId。
 *
 * ============================================================================
 *  为什么 M4 要求 owner **必须是 character**
 * ============================================================================
 * 计划书第 7 节：Memory Space 属于角色（"每个角色拥有自己的 Memory Space"）。
 * 一个 `user` 拥有的 Memory 在这套模型里没有意义 ——
 * 用户自己的记忆不属于苏沐薇的认知，也不该被 M5 召回进她的上下文。
 *
 * 因此这里**失败关闭**而不是硬塞一个 characterId：
 * 把 user 冒充成 character 与 `toActorRef()` 拒绝
 * "把地点冒充成系统组件"是同一条理由 —— 来源伪造。
 */
export function ownerCharacterId(owner: EntityRef): CharacterId {
  if (owner.kind !== 'character') {
    throw new KernelError(
      'validation_error',
      'memory_owner_not_character',
      `Memory 的 owner 必须是 character（一个 Memory Space 属于一个角色），收到 ${entityLabel(owner)}。` +
        '把 user 当作 owner 会让"她的记忆"与"用户的资料"在数据上无法区分',
      { owner: entityLabel(owner) }
    )
  }
  return owner.id as unknown as CharacterId
}

/**
 * 候选 → 正式记录（**只由 Reducer 调用**，不由抽取器调用）。
 *
 * 这个函数存在的意义是让"候选变成记录"这件事只有一处实现，
 * 且它**不写库**。写库只发生在 `memory-store.apply()` 的事务里。
 */
export function recordFromCandidate(input: {
  candidate: MemoryCandidate
  content: ClaimMemoryContent | EpisodicMemoryContent
  canonicalKey?: CanonicalMemoryKey
  recordedAt: Timestamp
}): MemoryRecord {
  const { candidate } = input
  return {
    id: candidate.proposedId,
    owner: candidate.owner,
    type: candidate.proposedType,
    content: input.content,
    subjects: [...candidate.subjects],
    epistemicStatus: candidate.epistemicStatus,
    authority: candidate.authority,
    importance: candidate.importance,
    confidence: candidate.confidence,
    status: 'active',
    sourceRefs: candidate.sourceRefs.map((ref) => ({ ...ref })),
    evidenceRootIds: [...candidate.evidenceRootIds],
    ...(candidate.proposedValidFrom !== undefined
      ? { validFrom: candidate.proposedValidFrom }
      : {}),
    ...(candidate.proposedOccurredAt !== undefined
      ? { occurredAt: candidate.proposedOccurredAt }
      : {}),
    // 新建且当前有效 → validUntil 明确为"没有终点"（区别于"不知道"）
    validUntil: null,
    recordedAt: input.recordedAt,
    ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
    contentFingerprint: contentFingerprintOf({
      owner: candidate.owner,
      type: candidate.proposedType,
      content: input.content,
      subjects: candidate.subjects,
    }),
    processor: candidate.processor,
    processorVersion: candidate.processorVersion,
    reducerVersion: MEMORY_REDUCER_VERSION,
    revision: 1,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    createdAt: input.recordedAt,
    updatedAt: input.recordedAt,
  }
}

/**
 * 复活快照（M9.1 / ADR-072 D04）——「忘掉/更正后**新的合格重述**」的 CREATE 事件
 * 携带的记录形态。
 *
 * 与首版快照（`recordFromCandidate`）的唯一区别：`revision = previousRevision + 1`
 * （同 id 新版本，不是从 1 重来）。其余字段全部来自**新告知**：
 *   · `sourceRefs` / `evidenceRootIds` = 新告知的证据（R06：旧源不冒充新告知）；
 *   · `validFrom` = 复活事件时刻（发射侧传 `proposedValidFrom = now`——
 *     **不伪造从未中断的有效期**，计划 §3.2 明文）；
 *   · `validUntil = null`（当前有效、无已知终点）、`supersededBy` 缺席（清空）；
 *   · `recordedAt/createdAt/updatedAt` = 事件时刻（reducer 折叠时以 event.createdAt 为准）。
 *
 * 旧值（旧来源、旧 validFrom、旧 validUntil、被谁顶）只在历史事件流里——
 * 复活快照由发射侧**整体**构造，不存在半新半旧的合并态。
 */
export function revivalRecordFromCandidate(input: {
  candidate: MemoryCandidate
  content: ClaimMemoryContent | EpisodicMemoryContent
  canonicalKey?: CanonicalMemoryKey
  recordedAt: Timestamp
  previousRevision: number
}): MemoryRecord {
  return {
    ...recordFromCandidate(input),
    revision: input.previousRevision + 1,
  }
}

// ---------------------------------------------------------------------------
// 权威映射（见 docs/m4/compatibility-audit.md §4 D1）
// ---------------------------------------------------------------------------

/**
 * M3 的 `SourceAuthority` → M4 的 `MemoryAuthority`。
 *
 * 两条**硬规则**（审计 §4 D1）：
 *
 * 1. **`EXPLICIT_CORRECTION` 不能从来源推导出来。**
 *    它只能由显式纠正路径**授予**（用户说"你之前记错了"这个**动作**），
 *    而不是"这句话来自用户"这个**事实**。混起来会让任何用户陈述都能覆盖旧记忆。
 *
 * 2. **`SYSTEM_INSTRUCTION` 失败关闭。**
 *    计划书第 84 节的例子：系统提示"请以简洁方式回答"
 *    **不能**变成"苏沐薇记得有人曾要求自己简洁"。
 *    因此这里抛错，而**不是**回落到 `MODEL_INFERENCE` ——
 *    回落是最危险的做法：它把"我们不知道它算什么"悄悄变成"它算模型推断"，
 *    于是那条记忆照样进库，只是权威低一点。
 */
export function authorityFromSource(
  source: SourceAuthority,
  options: { isExplicitCorrection?: boolean } = {}
): MemoryAuthority {
  if (options.isExplicitCorrection === true) return 'EXPLICIT_CORRECTION'

  switch (source) {
    case 'USER_EXPLICIT':
    case 'USER_REPLY_CONFIRMATION':
      // 计划书第 33 节：用户确认可以把证据等级提上去。
      // 对**用户个人事实**而言，明确陈述与回复确认的证据强度同级，
      // 因此两者映射到同一个 MemoryAuthority（审计 §4 D1）。
      return 'EXPLICIT_USER_STATEMENT'
    case 'DIRECT_INTERACTION':
      return 'DIRECT_INTERACTION'
    case 'TOOL_OBSERVATION':
      return 'TOOL_OBSERVATION'
    case 'CHARACTER_GENERATION':
      return 'CHARACTER_GENERATION'
    case 'SYSTEM_INSTRUCTION':
      throw new KernelError(
        'validation_error',
        'system_instruction_cannot_become_memory_authority',
        'SystemInstruction 不能映射成任何 MemoryAuthority（计划书第 84 节）：' +
          '系统指令"请以简洁方式回答"不能变成"她记得有人曾要求自己简洁"。' +
          '刻意失败关闭而不是回落到 MODEL_INFERENCE —— 回落会让它照样进库',
        { source }
      )
    /*
     * M5.1.1（WP1.1 · K-1 = B1）—— 本里程碑在冻结区里**唯一**新增的分支。
     *
     * `UNCONFIRMED_ORIGIN` 是 ADR-042 §4 新增的 Axis B 取值，含义是
     * "这条内容的来源类别没有被确立"。硬不变量：
     *
     *     它可以作为**已记录的 provenance** 存在（历史回填行必须记它），
     *     但在 ADR-043 裁定之前，它**没有任何**合法的 MemoryAuthority 晋级路径。
     *
     * 因此这里**刻意抛错**，而不是挑一个"最弱的" MemoryAuthority 返回：
     * 回落正是上面 SYSTEM_INSTRUCTION 那段注释所说的**最危险的做法** ——
     * 它把"我们不知道它算什么"悄悄变成"它算模型推断"，于是那条记忆照样进库，
     * 只是权威低一点。来源未确立 ≠ 来源可信。
     *
     * 与 SYSTEM_INSTRUCTION 的区别只在**理由**（一个是"语义上就不该形成记忆"，
     * 一个是"来源没确立，所以现在不能"），处置相同，因此各自单列一个理由码。
     */
    case 'UNCONFIRMED_ORIGIN':
      throw new KernelError(
        'validation_error',
        'unconfirmed_origin_cannot_become_memory_authority',
        'UNCONFIRMED_ORIGIN 不能映射成任何 MemoryAuthority：' +
          '来源未确立不等于来源可信（ADR-042 §4 / U-09）；' +
          'ADR-043 裁定之前它没有合法的晋级路径，' +
          '刻意失败关闭而不是回落到一个低权威 —— 回落会让它照样进库',
        { source }
      )
    /*
     * 后 Lv2 · S1（ADR-091 `D05`）—— 故事体验的权威映射。
     *
     * 映射到既有的 `DIRECT_INTERACTION`（**不新增 MemoryAuthority**），理由有三条，
     * 与 `D05` 的"沿既有放行口、不新开写口、不降门槛"是同一件事：
     *
     *   ① **门槛不降**：`DIRECT_INTERACTION` 是"某件事**真的发生过**"这一档的既有权威，
     *      而故事事件同样是"在**已提交事件流**里真的发生过一次" —— 只是发生在
     *      剧情世界而不是现实对话里。两者在"是否发生过"这个维度上同级，
     *      而这个维度**正是** MemoryAuthority 表达的东西；
     *   ② **不是外部事实**：`DIRECT_INTERACTION` **不在** `EXTERNAL_FACT_AUTHORITIES`
     *      白名单里（`canSupportExternalFact('DIRECT_INTERACTION') === false`，
     *      见 `source-authority.ts`）。因此**这条映射不会**让"模拟中通过二面"
     *      升级成"用户现实中已被极创录取" —— 那一条由 `STORY_OBSERVATION`
     *      被排除在白名单之外单独保证，本映射与它不冲突；
     *   ③ **"现实 vs 模拟"的分辨不在这一轴**：它由来源 id 的
     *      `story:<id>@v<n>#<run>.<event>` 五分量与 `experienceScope`
     *      在 provenance 上表达（契约 `S10`：来源追问必须能区分
     *      用户陈述 / 故事体验 / 她的解释）。把它硬塞进 MemoryAuthority
     *      会让"记忆权威"这一轴同时承担"是否发生过"与"在哪发生过"，
     *      而这正是 M5.1-D01 那类混轴的形状。
     */
    case 'STORY_OBSERVATION':
      return 'DIRECT_INTERACTION'
    default: {
      const exhaustive: never = source
      throw new KernelError(
        'validation_error',
        'unknown_source_authority',
        `未知的 SourceAuthority：${String(exhaustive)}`
      )
    }
  }
}

/** 这一条权威是否允许建立"用户个人事实"（Policy 与测试的便捷入口） */
export function canEstablishUserFact(authority: MemoryAuthority): boolean {
  return authority === 'EXPLICIT_USER_STATEMENT' || authority === 'EXPLICIT_CORRECTION'
}
