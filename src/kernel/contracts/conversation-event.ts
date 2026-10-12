/**
 * ConversationEvent —— **事实账本**。
 *
 * ============================================================================
 *  铁律 3：Conversation Event 是"发生了什么"
 * ============================================================================
 * 与 DomainEvent（"她因此如何变化"）严格区分。两者可以底层共库，
 * 但 Domain Model 必须分清——把它们塞进同一张语义不清的 Event 表，
 * 是长期角色系统最早出问题的地方。
 *
 * 铁律：**Append-Only**。发生过的对话不能因为后来理解改变而被改写。
 * 用户先说"我喜欢咖啡"，后说"我现在戒咖啡了"——不是改第一条，
 * 而是新增第二条；"旧认识 → superseded"是 M4 Memory 的事。
 *
 * ============================================================================
 *  M3 的扩展（计划书第 26–37 节）
 * ============================================================================
 * M2.5 的事件已经带 `actorType`，但来源信息还是散在 `metadata` 这个自由字典里
 * （`source` / `userId` / `traceId` / `modelProfile` 混在一起）。M3 把它变成
 * **结构化 provenance**：
 *
 *   · `sourceKind`        —— 事实类别（user_statement / character_output / …）
 *   · `sourceAuthority`   —— 这条内容有资格支持什么结论
 *   · `epistemicSource`   —— 属于哪一类认知产物（来源标签，不是认知状态）
 *   · `deliveryStatus`    —— 生成 ≠ 送达（第 37 节）
 *   · `eventSchemaVersion`—— 事件结构自己的版本
 *
 * 为什么必须做成列而不是继续塞字典：一旦 provenance 是自由字典，
 * 就一定会出现"某个模块忘了写""某个模块写错了键名"，
 * 而 M4 的 Memory 会把这些半成品当成权威来源。
 *
 * ⚠️ 旧字段一个都没删：`metadata` 仍然保留（它承载 traceId / modelProfile /
 * transport 这类**非来源**信息），只是不再承载来源语义。
 */

import {
  KernelError,
  type CharacterId,
  type ConversationEventId,
  type ConversationId,
  type SchemaVersion,
  type Timestamp,
  makeConversationEventId,
} from './ids.ts'
import type { ActorType, AttributionValue } from './actor.ts'
import { assertEventTime } from './time.ts'
import {
  buildProvenance,
  sourceKindForActor,
  type EpistemicSource,
  type SourceAuthority,
  type SourceKind,
} from './source-authority.ts'
import {
  assertConversationAttributionNecessity,
  attributionSlotsOfContext,
  isTrustedAttributionContext,
  type AttributionValueSlot,
  type TrustedAttributionContext,
} from './attribution.ts'

export const CONVERSATION_EVENT_SCHEMA_VERSION = 1

/**
 * M3 的事件结构版本。与 `CONVERSATION_EVENT_SCHEMA_VERSION` 分开是因为
 * 前者描述"表/行结构"，后者描述"这条事件自己的字段布局"——
 * 迁移时两者常常不同步（旧行没有新列）。
 */
export const CONVERSATION_EVENT_M3_SCHEMA_VERSION = 2

/** 发生的事情的种类 */
export type ConversationEventType = 'user_message' | 'assistant_message' | 'system_event' | 'tool_event'

/** @deprecated 用 `ActorType`（actor.ts）。保留别名只为兼容既有 import。 */
export type LegacyActorType = ActorType
export type { ActorType }

/**
 * 生成 ≠ 送达（计划书第 37 节）。
 *
 * 模型成功生成 "Hello" 但网络发送失败时，对话历史必须能表达
 * `generated=true delivered=false`。M3 只预留状态，不实现重投递
 * （那需要 transport 能力，属于后续阶段）。
 */
export type DeliveryStatus = 'generated' | 'delivered' | 'failed'

export interface ConversationEvent {
  id: ConversationEventId

  /** 稳定角色 id（不依赖 Session） */
  characterId: CharacterId

  /** 所属会话（本项目按"角色 × 用户"划分） */
  conversationId: ConversationId

  /**
   * **角色级全局序号**（单调、唯一、由持久层原子分配，见 sequence 契约）。
   *
   * 为什么不能 `SELECT MAX(sequence)+1`：无事务保护时并发写会撞号，
   * 而序号是 Watermark / Replay / 乱序 Worker 判定的唯一依据。
   */
  sequence: number

  /** 会话内序号（从 1 开始）。用途是"这个会话说到第几句"这类可读的账 */
  conversationSequence: number

  type: ConversationEventType
  actorType: ActorType

  /** 具体的说话人标识（用户 id、角色 id、系统组件名、工具名）。写入时**必须**尽量提供 */
  actorId?: string

  /** 正文。system_event 可只有 metadata 没有正文 */
  content: string

  /**
   * 事实类别（计划书第 27 节）。
   *
   * 由 `actorType` 唯一推导，不接受调用方自由指定 —— 见
   * `source-authority.ts` 的 `assertSourceConsistency`（失败关闭）。
   */
  sourceKind: SourceKind

  /** 这条内容有资格支持什么结论（计划书第 83 节）。M3 只标记，M4 才定策略。 */
  sourceAuthority: SourceAuthority

  /** 来源标签（**不是**最终认知状态，计划书第 29 节） */
  epistemicSource: EpistemicSource

  /**
   * WP4（step 2/3）：**受信归因信封**。只有走升级后写入路径的事件才有。
   *
   * 它不是"第二份存储"：它就是 ADR-042 的七槽位信封落到 v7 的 18 个槽位列上
   * （`subject` 是派生语义，不落列）。**没有**这个字段时，事件与今天**逐字段相同**。
   *
   * WP4 step 3/3-fix（**读取期**）：`conversation-store.rowToEvent` 只在
   * `attribution_origin = 'RECORDED'` 时按物理列**逐字**重建这个信封
   * （六个槽位的三态 + origin）；Axis B 直接用存储值并复核 R-21 分支，
   * **不走** `deriveSourceForLegacyRow`（也不从 `actor_type` 重建）。
   * 历史行（`MIGRATED_LEGACY` / 无 origin）保持既有 legacy 读行为，不制造这个信封。
   */
  attribution?: {
    attributionOrigin: 'RECORDED'
    slots: Record<AttributionValueSlot, AttributionValue<unknown>>
  }

  /** 生成 / 已送达 / 失败（仅 assistant / tool 事件有意义） */
  deliveryStatus?: DeliveryStatus

  /** 如果是回复某条事件，指向它（assistant 回复 user 时必填） */
  replyToEventId?: ConversationEventId

  /**
   * 附加事实信息。
   *
   * ⚠️ M3 起本字段**不再承载来源语义**（来源见上面三个结构化字段）。
   * 已知约定键：
   *   userId        —— 本轮对话对应的用户（用于按用户解析 Projection）
   *   modelProfile  —— 生成该回复所用模型（仅 assistant 事件）
   *   traceId       —— 该轮 trace（仅 assistant 事件）
   *   transport     —— 渠道来源（cli / qq / harness / …）
   */
  metadata?: Record<string, unknown>

  schemaVersion: SchemaVersion
  createdAt: Timestamp

  /**
   * M3.5（计划书第 29–34 节）：这件事**什么时候发生**。
   *
   * 与 `createdAt` 的关系：
   *   · `createdAt`      ≡ `recordedAt`（系统什么时候记下它）—— 既有列 `created_at`
   *   · `occurredAt`     —— 这件事什么时候发生；当前对话里由调用方显式传，
   *     不传就是 `undefined`（= "不知道"，**不是** "等于现在"）
   *
   * 为什么不默认成 `createdAt`：见 `time.ts` 的 `eventTimeFromRecorded`。
   * 用什么填充它属于**导入/场景**的策略，不属于时间契约。
   */
  occurredAt?: Timestamp

  /**
   * M3.5 预留的模拟时间槽位。
   *
   * 当前**必须为 undefined**：`assertEventTime` 会拒绝任何非空值
   * （`simulation_time_not_supported`）。留字段是为了未来不必改 schema 与
   * 所有调用签名，拒绝写入是为了不出现"有人写了它但没人按它排序"的半成品。
   */
  logicalTime?: string
}

export interface NewConversationEvent {
  characterId: CharacterId
  conversationId: ConversationId
  conversationSequence: number
  type: ConversationEventType
  actorType: ActorType
  actorId?: string
  content: string
  replyToEventId?: ConversationEventId
  /**
   * 调用方可选的**显式来源声明**。
   *
   * 它**不会**覆盖 actorType 的推导结果：不一致时直接抛错
   * （`source_kind_actor_mismatch`）。存在的意义是让调用点把意图写出来，
   * 从而在 review 时一眼可见"这句话被当成了什么"。
   */
  sourceKind?: SourceKind
  deliveryStatus?: DeliveryStatus
  /** 被回复事件的来源类别（仅用于把用户确认提升为 USER_REPLY_CONFIRMATION） */
  repliedToSourceKind?: SourceKind
  metadata?: Record<string, unknown>
  createdAt?: Timestamp
  /** M3.5：发生时间（缺省 = 不知道；见 `ConversationEvent.occurredAt`） */
  occurredAt?: Timestamp
  /** M3.5：模拟时间槽位（当前必须留空） */
  logicalTime?: string
  /**
   * WP4（step 2/3）：**受信归因上下文**。
   *
   * 它只能由 `buildTrustedAttributionContext()` 产出（其证据 token 不可伪造），
   * 因此"调用方自报权威"在类型层与运行期都不可行（K-25）。
   * **不传** ⇒ 行为与今天逐字段相同（legacy 路径零影响）。
   */
  trustedAttribution?: TrustedAttributionContext
}

/**
 * 构造事件（**不含 sequence**）。
 *
 * sequence 由持久层在**同一个事务里**原子分配后回填，
 * 因此这里刻意不接收它——领域层没有权力决定序号。
 * 这条约束让"序号一定来自可信持久层"成为类型层面的事实。
 */
export function createConversationEvent(
  input: NewConversationEvent & { sequence: number }
): ConversationEvent {
  const actorType = input.actorType
  const type = input.type

  // --- 来源一致性：声明与行为不符的事件一律拒绝（铁律 5 的第一道闸）------
  if (type === 'user_message' && actorType !== 'user') {
    throw new KernelError(
      'validation_error',
      'actor_type_mismatch',
      `user_message 事件的 actorType 必须是 user，收到 ${actorType}`
    )
  }
  if (type === 'assistant_message' && actorType !== 'character') {
    throw new KernelError(
      'validation_error',
      'actor_type_mismatch',
      `assistant_message 事件的 actorType 必须是 character，收到 ${actorType}`
    )
  }
  if (type === 'tool_event' && actorType !== 'tool') {
    throw new KernelError(
      'validation_error',
      'actor_type_mismatch',
      `tool_event 事件的 actorType 必须是 tool，收到 ${actorType}`
    )
  }
  if (type === 'system_event' && actorType !== 'system') {
    throw new KernelError(
      'validation_error',
      'actor_type_mismatch',
      `system_event 事件的 actorType 必须是 system，收到 ${actorType}`
    )
  }
  if (input.conversationSequence < 1 || !Number.isSafeInteger(input.conversationSequence)) {
    throw new KernelError(
      'validation_error',
      'bad_conversation_sequence',
      `conversationSequence 必须是 >= 1 的安全整数，收到 ${input.conversationSequence}`
    )
  }
  if (input.content.trim() === '') {
    throw new KernelError(
      'validation_error',
      'empty_content',
      '事件正文不能为空：空的"事实"没有任何证据价值，只会污染账本'
    )
  }
  if (type === 'assistant_message' && !input.actorId) {
    throw new KernelError(
      'validation_error',
      'missing_actor_id',
      'assistant_message 必须带 actorId（否则无法回答"哪条回复属于哪个角色"）'
    )
  }

  /*
   * ⚠️ `repliedToSourceKind` 必须**显式**转发给 `buildProvenance`。
   *
   * 实测踩到过的真实缺陷：这个字段在 `NewConversationEvent` 里声明了，
   * 调用方（`ConversationLedgerPort`）也老老实实传了，但这里忘了往下传 ——
   * 于是"用户确认"这条 M3 的核心语义**只活在内存返回值里**：
   * 内存里看到 `USER_REPLY_CONFIRMATION`，从库里读回来却是 `USER_EXPLICIT`。
   *
   * 它之所以没被立刻发现，是因为测试断言的是**返回值**
   * （`ledger.appendUserStatement()` 的返回对象），而返回值是在
   * `appendConversationEvent` 里重新读库构造的……
   * 也就是说正确答案只在"内存里那条路径"上出现过，
   * 而库里从来没有存对过。
   *
   * 教训：**"声明了字段"不等于"字段会被用到"**，而"断言返回值"也不等于
   * "断言落库"。因此 M3 在 `verify-m3-persistence.ts` 里专门有一条
   * "从库里读回来仍是 USER_REPLY_CONFIRMATION"的断言。
   */
  const provenance = buildProvenance({
    actorType,
    actorId: input.actorId ?? actorType,
    declaredKind: input.sourceKind,
    repliedToKind: input.repliedToSourceKind,
    replyToEventId: input.replyToEventId ? String(input.replyToEventId) : undefined,
    transport: transportOf(input.metadata),
  })

  // --- M3.5：时间三元组必须自洽（且 logicalTime 必须留空）------------------
  // 放在这里而不是"各调用点自己记得校验"：时间是排序与因果的基础，
  // 而 `NaN` / 模拟时间会**静默**地把顺序弄坏，不会崩、只会错。
  const recordedAt = input.createdAt ?? Date.now()
  assertEventTime({
    recordedAt,
    ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
    ...(input.logicalTime !== undefined ? { logicalTime: input.logicalTime } : {}),
  })

  // --- WP4 step 2/3：受信归因（**只有携带可信上下文时才生效**）------------------
  //
  // 三条校验都只做一件事：确认这份**受信上下文描述的就是本事件**。
  // 它**不**检查 `actor_type == actor.kind` —— 那正是 D01 要打破的等式。
  const trusted = input.trustedAttribution
  if (trusted !== undefined) {
    /*
     * AT-W4-7（WP4 step 3/3-fix）：**上下文本身也必须是不透明的**。
     *
     * 证据 token 的守卫只挡 `buildTrustedAttributionContext()` 的**入参**；
     * 上下文是普通对象 ⇒ 调用方手写一份同形对象就能把
     * `contentOriginator=Known(USER)` + `USER_EXPLICIT` 直接塞进账本。
     * 因此这里复用同一套运行期登记：手写 / 结构克隆 / JSON 往返**一律拒绝**
     * （不是静默忽略 —— 静默忽略会让"我声明过了"变成一种错觉）。
     */
    if (!isTrustedAttributionContext(trusted)) {
      throw new KernelError(
        'validation_error',
        'untrusted_attribution_context',
        'trustedAttribution 不是受信构造器产出的上下文（手写对象 / 结构克隆 / JSON 往返 ' +
          '都不算证据 —— K-25 §2 / AT-W4-7）；权威归因只能由 ' +
          'buildTrustedAttributionContext() 从三份独立受信证据构造'
      )
    }
    if (trusted.family !== type) {
      throw new KernelError(
        'validation_error',
        'trusted_attribution_family_mismatch',
        `受信归因的事件族是 ${trusted.family}，但事件的 type 是 ${type}`
      )
    }
    if (trusted.presenterActorType !== actorType) {
      throw new KernelError(
        'validation_error',
        'trusted_attribution_actor_type_mismatch',
        `受信归因的呈现角色是 ${trusted.presenterActorType}，但 actorType 是 ${actorType}` +
          '（事件族 ↔ actor_type 是**唯一**允许的 legacy 一致性；actor / contentOriginator ' +
          '与它**并列但不要求相等**）'
      )
    }
    if (trusted.subject.id !== String(input.characterId)) {
      throw new KernelError(
        'validation_error',
        'trusted_attribution_subject_mismatch',
        '受信归因的 subject 必须由本事件的 canonical domain context 派生（characterId 不一致）'
      )
    }
    /*
     * K-29（消费边界，defense in depth）：**同一份** canonical 必要性判据。
     *
     * 构造期（`buildTrustedAttributionContext`）已经过了一遍；这里再过一遍，
     * 防的是"将来重构 / 陈旧内部生产者 / 上下文登记表出问题 / 没预料到的内部构造路径"。
     * 它**不是**第二套语义 —— 调用的就是同一张 `NECESSITY_MATRIX` 上的同一个 validator。
     */
    assertConversationAttributionNecessity(trusted)
  }

  return {
    id: makeConversationEventId(input.characterId, input.conversationId, input.sequence),
    characterId: input.characterId,
    conversationId: input.conversationId,
    sequence: input.sequence,
    conversationSequence: input.conversationSequence,
    type,
    actorType,
    actorId: input.actorId,
    content: input.content,
    sourceKind: trusted?.axisB.sourceKind ?? provenance.kind,
    sourceAuthority: trusted?.axisB.sourceAuthority ?? provenance.authority,
    epistemicSource: trusted?.axisB.epistemicSource ?? provenance.epistemicSource,
    ...(trusted !== undefined
      ? {
          attribution: {
            attributionOrigin: trusted.attributionOrigin,
            slots: attributionSlotsOfContext(trusted),
          },
        }
      : {}),
    deliveryStatus: input.deliveryStatus,
    replyToEventId: input.replyToEventId,
    metadata: input.metadata,
    schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
    createdAt: recordedAt,
    ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
    ...(input.logicalTime !== undefined ? { logicalTime: input.logicalTime } : {}),
  }
}

function transportOf(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.transport
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * 从数据库行补齐 provenance 的**兼容层**。
 *
 * 迁移 0003 之后写入的行一定有这三列；但**迁移之前**已经存在的行
 * （本项目真实库里有 4 条）没有。对它们做**推导**而不是留空：
 * 推导规则与 `createConversationEvent` 完全一致，
 * 因此"旧行的来源"与"新行的来源"在语义上可比。
 *
 * 这样做的代价是旧行没有"当时声明的来源"，收益是账本里
 * **不存在来源未知的事件** —— 后者对 M4 更危险。
 */
export function deriveSourceForLegacyRow(actorType: ActorType): {
  sourceKind: SourceKind
  sourceAuthority: SourceAuthority
  epistemicSource: EpistemicSource
} {
  const provenance = buildProvenance({ actorType, actorId: actorType })
  return {
    sourceKind: provenance.kind,
    sourceAuthority: provenance.authority,
    epistemicSource: provenance.epistemicSource,
  }
}

// ---------------------------------------------------------------------------
// 语义辅助：哪些事件能充当"外部事实"的证据
// ---------------------------------------------------------------------------

/**
 * 该事件是否可以作为**外部事实**（关于用户/世界的可报告事实）的证据。
 *
 * 铁律 5 的第一实现点：Assistant（角色自己）说的话**不能**成为外部事实，
 * 它最多只能形成 `self-expression evidence` 或 `inference`。
 *
 * M3 起这个判定不再看 `actorType`，而是看**权威等级**
 * （`canSupportExternalFact`）—— 因为"用户说的话"与"用户确认"的
 * 证据强度不同，而"工具观测"在语义上又是另一种东西。
 * 这样 M4 只有一处需要读的策略。
 */
export function canEvidenceExternalFact(event: {
  type: ConversationEventType
  actorType: ActorType
  sourceAuthority?: SourceAuthority
}): boolean {
  if (event.type === 'system_event') return false
  if (event.actorType === 'character') return false
  if (event.actorType === 'system') return false
  // 有结构化 authority 就用它；旧数据（迁移前）按 actorType 推导
  const authority = event.sourceAuthority ?? undefined
  if (authority !== undefined) {
    return authority === 'USER_EXPLICIT' ||
      authority === 'USER_REPLY_CONFIRMATION' ||
      authority === 'TOOL_OBSERVATION'
  }
  return event.actorType === 'user' || event.actorType === 'tool'
}

/** 该事件是否只构成"自我表达"证据（她说过的话，而不是事实） */
export function isSelfExpressionOnly(event: { actorType: ActorType }): boolean {
  return event.actorType === 'character'
}

/** 该事件是否属于"真实发生过的一次互动"（Relationship / Affect 的证据基础） */
export function isDirectInteraction(event: { actorType: ActorType }): boolean {
  return event.actorType === 'user' || event.actorType === 'character'
}

export { sourceKindForActor }
