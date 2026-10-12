/**
 * Observation —— **Character Kernel 的输入边界**。
 *
 * ============================================================================
 *  M3.5 WP3（计划书第 10–14 / 49 / 68 / 76 节）
 * ============================================================================
 * 为什么必须有这一层：如果 Kernel 的输入永远是"用户消息"，那么未来任何
 * 非对话输入（世界事件、工具观测、场景变化）都只能有**一条**路进得来：
 *
 *     伪装成用户消息
 *
 * 那是本项目最危险的一类技术债，因为它会同时污染三件事：
 *
 *   · **事实账本** —— 一条"房间的灯突然熄灭"被记成 `user_message`，
 *     来源类别、权威等级、reply graph 全部跟着错，而且是 append-only，改不回来。
 *   · **人格评测** —— 她"回应了用户"，但根本没有用户说话。
 *   · **可解释性** —— 事后无法区分"用户真的说了这句话"与"系统替用户说了"。
 *
 * Observation 解决的是**"什么东西被角色感知到了"**，把输入变成数据而不是通道。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 铁律：Observation ≠ 事实（计划书第 14 节）
 * ---------------------------------------------------------------------------
 * Observation 表示的是：
 *
 *     某种信息**进入了她的感知范围**
 *
 * 它**不代表**内容本身客观正确。例如：
 *
 *     某人告诉苏沐薇："门外没人。"
 *
 * 正确的 Observation 是 `某人说"门外没人"`，
 * **不是** `门外真的没人`。
 *
 * 把这条写进类型注释而不是只写文档，是因为它是 M9 Belief 的地基：
 * 一旦 Observation 被当成事实，Belief 就退化成了"世界真相的副本"，
 * 而那样"她以为"和"实际是"就再也分不开了。
 *
 * ---------------------------------------------------------------------------
 *  M3.5 真正产出的只有一种
 * ---------------------------------------------------------------------------
 *     User Message → ConversationEvent → ConversationObservation → Kernel
 *
 * 其余五种（WORLD / TOOL / SOCIAL / SYSTEM / ENVIRONMENT）**只登记枚举**
 * （计划书第 12 节），没有任何代码会产出它们 —— 由 FC-T01…T08 与
 * `docs/m3.5/compatibility-audit.md` 共同守住这一点。
 */

import { KernelError, makeObservationId, type CharacterId, type ConversationEventId, type ObservationId, type Timestamp } from './ids.ts'
import type { ConversationEvent } from './conversation-event.ts'
import type { SourceKind } from './source-authority.ts'
import { type EntityRef, fromActor } from './entity.ts'

// ---------------------------------------------------------------------------
// 类型登记
// ---------------------------------------------------------------------------

/**
 * Observation 种类（**受控登记表**，与 `DomainEventType` 同一个模式）。
 *
 * 为什么封闭而不是 `string`：这份清单就是"M3.5 允许哪些输入"的唯一答案。
 * 开放成 string 之后，"某个模块手滑产出一种新输入、悄悄改变了 Kernel 的语义"
 * 就不再可能被拦住 —— 而 Kernel 的输入语义是最不该被悄悄改的东西。
 */
export type ObservationType =
  /** ✅ M3.5 唯一真正产出的一种 */
  | 'CONVERSATION_OBSERVATION'
  // —— 以下仅登记（计划书第 12 节）——
  | 'WORLD_OBSERVATION'
  | 'TOOL_OBSERVATION'
  | 'SOCIAL_OBSERVATION'
  | 'SYSTEM_OBSERVATION'
  | 'ENVIRONMENT_OBSERVATION'

export const OBSERVATION_TYPES: readonly ObservationType[] = [
  'CONVERSATION_OBSERVATION',
  'WORLD_OBSERVATION',
  'TOOL_OBSERVATION',
  'SOCIAL_OBSERVATION',
  'SYSTEM_OBSERVATION',
  'ENVIRONMENT_OBSERVATION',
]

/**
 * M3.5 允许**产出**的种类 —— 恰一种。
 *
 * 登记 ≠ 可产出：`OBSERVATION_TYPES` 回答"这个名字合法吗"，
 * 这张表回答"现在谁有资格造它"。两者分开的理由是
 * `verify-m3-phoenix` 那条老教训：**"声明了字段"不等于"字段会被用到"**。
 */
export const M3_5_PRODUCIBLE_OBSERVATION_TYPES: readonly ObservationType[] = [
  'CONVERSATION_OBSERVATION',
]

export function isObservationType(value: unknown): value is ObservationType {
  return typeof value === 'string' && (OBSERVATION_TYPES as readonly string[]).includes(value)
}

export function isProducibleInM3_5(type: ObservationType): boolean {
  return (M3_5_PRODUCIBLE_OBSERVATION_TYPES as readonly string[]).includes(type)
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * 对话观测的内容（M3.5 唯一真正被产出的 payload）。
 *
 * 刻意保留 `speaker`：Observation 回答"谁把这条信息带进她的感知范围"，
 * 而不只是"文本是什么"。少了它，"她听说的"与"你亲眼看到的"在数据上同形。
 */
export interface ConversationObservationContent {
  /** 派生来源事件（与 `sourceEventIds[0]` 一致；冗余是为了可读） */
  eventId: ConversationEventId
  text: string
  speaker: EntityRef
  sourceKind: SourceKind
}

export interface Observation {
  id: ObservationId

  /** **谁的**感知（计划书第 10 节：Observation 永远是某个角色的观测） */
  characterId: CharacterId

  /** 这条信息从哪来（用户 / 她自己的输出 / 系统 / 工具 / 未来的场景） */
  source: EntityRef

  type: ObservationType

  /**
   * 内容。
   *
   * `unknown` 是**刻意**的（计划书第 10 节）：Observation 是未来世界的边界，
   * 今天不可能知道未来的 payload 长什么样。领域层只对**已登记并会产出**的
   * 那一种（CONVERSATION）做结构校验，其余保持不透明。
   */
  content: unknown

  /**
   * 派生自哪些事件（计划书第 10 节）。
   *
   * 刻意是 `string[]` 而**不是** `ConversationEventId[]`：
   * 未来的 World Observation 来自 WorldEvent，那不是 ConversationEventId。
   * 用窄类型会让未来的世界事件**被迫**登记成对话事件 —— 又是一个伪装通道。
   */
  sourceEventIds: string[]

  /** 事情什么时候发生（可空：当前 ≈ recordedAt，计划书第 31 节） */
  occurredAt?: Timestamp

  /** 系统什么时候记录到它（**必有**） */
  recordedAt: Timestamp

  metadata?: Record<string, unknown>
}

export interface NewObservation {
  characterId: CharacterId
  source: EntityRef
  type: ObservationType
  content: unknown
  sourceEventIds?: string[]
  occurredAt?: Timestamp
  recordedAt?: Timestamp
  metadata?: Record<string, unknown>
  /** 只用于测试与合成输入：显式指定 id（默认由来源事件派生） */
  id?: ObservationId
}

/**
 * 构造 Observation。
 *
 * 失败关闭的三处：
 *   1. `type` 未登记 → 拒绝（这份清单是唯一答案）
 *   2. `recordedAt` / `occurredAt` 不是有限数 → 拒绝
 *      （时间戳是排序与因果的基础，`NaN` 会静默地把顺序弄坏）
 *   3. `CONVERSATION_OBSERVATION` 的 content 形状不符 → 拒绝
 *      （"唯一真正产出的那一种"必须比其余五种更严，而不是更松）
 */
export function createObservation(input: NewObservation): Observation {
  if (!isObservationType(input.type)) {
    throw new KernelError(
      'validation_error',
      'unknown_observation_type',
      `未登记的 ObservationType：${String(input.type)}。` +
        '新增一种输入时必须在 observation.ts 登记，否则 Kernel 会悄悄接受它',
      { type: String(input.type) }
    )
  }
  if (String(input.characterId).trim() === '') {
    throw new KernelError('validation_error', 'observation_without_character', 'Observation 必须属于某个角色')
  }
  if (!isFiniteTimestamp(input.recordedAt)) {
    throw new KernelError(
      'validation_error',
      'bad_recorded_at',
      `Observation.recordedAt 必须是有限时间戳，收到 ${String(input.recordedAt)}`
    )
  }
  if (input.occurredAt !== undefined && !isFiniteTimestamp(input.occurredAt)) {
    throw new KernelError(
      'validation_error',
      'bad_occurred_at',
      `Observation.occurredAt 必须是有限时间戳，收到 ${String(input.occurredAt)}`
    )
  }

  const sourceEventIds = dedupe(input.sourceEventIds ?? [])

  if (input.type === 'CONVERSATION_OBSERVATION') {
    validateConversationContent(input.content)
    if (sourceEventIds.length === 0) {
      throw new KernelError(
        'validation_error',
        'conversation_observation_without_source',
        '对话观测必须带来源事件：没有来源的观测无法回答"她是听谁说的"'
      )
    }
  }

  return {
    id: input.id ?? makeObservationId(sourceEventIds[0] ?? `synthetic:${String(input.characterId)}`),
    characterId: input.characterId,
    source: input.source,
    type: input.type,
    content: input.content,
    sourceEventIds,
    ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
    recordedAt: input.recordedAt ?? Date.now(),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }
}

/**
 * `ConversationEvent → ConversationObservation`（计划书第 11 / 68 节）。
 *
 * 这是 M3.5 唯一真正被使用的 Observation 适配器。它**不写任何东西** ——
 * Observation 由事件派生、不落库（计划书第 84 节），因此这里没有表、
 * 没有仓储、没有缓存，只有一个纯函数。
 *
 * ⚠️ 注意它把 `type` 也固定成 CONVERSATION 而**不是**按事件种类再分：
 * "用户说的"与"她自己说的"是同一类**感知方式**（都是对话），
 * 区别在 `source.kind` 与 `content.sourceKind`。混成两种 Observation
 * 会让"对话"这个概念在你没注意的时候裂成两半。
 */
export function conversationObservationFrom(
  event: ConversationEvent,
  options: { recordedAt?: Timestamp } = {}
): Observation {
  const speaker = fromActor({
    actorId: event.actorId ?? event.actorType,
    actorType: event.actorType,
  })

  return createObservation({
    // 派生 id 只依赖事件 id → 同一条事件永远得到同一个 Observation
    id: makeObservationId(String(event.id)),
    characterId: event.characterId,
    source: speaker,
    type: 'CONVERSATION_OBSERVATION',
    content: {
      eventId: event.id,
      text: event.content,
      speaker,
      sourceKind: event.sourceKind,
    } satisfies ConversationObservationContent,
    sourceEventIds: [String(event.id)],
    occurredAt: event.occurredAt,
    recordedAt: options.recordedAt ?? event.createdAt,
  })
}

/**
 * 由 Observation 派生"本轮输入文本"。
 *
 * 为什么是**派生**而不是额外传一个 `currentInput`：
 * 两个来源就一定会有一天不一致，而"她看到的输入"与"事件里记的输入"不一致，
 * 是最难查的一类缺陷。因此 M3.5 保证：**只有 Observation 是来源**，
 * 文本由它算出来（FC-T08 会比对"派生结果与显式传入是否相符"）。
 */
export function deriveCurrentInput(observation: Observation): string {
  if (observation.type !== 'CONVERSATION_OBSERVATION') {
    throw new KernelError(
      'validation_error',
      'observation_not_renderable_as_input',
      `${observation.type} 没有"当前输入文本"这个概念：` +
        '把它当作一句用户话渲染进 prompt，正是 Observation 要阻止的那种伪装',
      { type: observation.type }
    )
  }
  return conversationContentOf(observation).text
}

/** 取出对话观测的内容（形状校验 + 窄化，**唯一**的读取口） */
export function conversationContentOf(observation: Observation): ConversationObservationContent {
  validateConversationContent(observation.content)
  return observation.content as ConversationObservationContent
}

/** 该观测是否来自用户本人（进上下文与未来的 Belief 时会用到） */
export function isFromUser(observation: Observation): boolean {
  return observation.source.kind === 'user'
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function validateConversationContent(content: unknown): void {
  if (content === null || typeof content !== 'object') {
    throw new KernelError(
      'validation_error',
      'bad_observation_content',
      'CONVERSATION_OBSERVATION 的 content 必须是对象（{ eventId, text, speaker, sourceKind }）'
    )
  }
  const record = content as Partial<ConversationObservationContent>
  if (typeof record.text !== 'string' || record.text.trim() === '') {
    throw new KernelError(
      'validation_error',
      'empty_observation_text',
      '对话观测的正文不能为空：空的观测没有任何证据价值，只会污染上下文'
    )
  }
  if (record.eventId === undefined || String(record.eventId).trim() === '') {
    throw new KernelError('validation_error', 'observation_without_event', '对话观测必须带 eventId')
  }
  if (record.speaker === undefined || typeof record.speaker !== 'object') {
    throw new KernelError('validation_error', 'observation_without_speaker', '对话观测必须带 speaker')
  }
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (value.trim() === '') continue
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
