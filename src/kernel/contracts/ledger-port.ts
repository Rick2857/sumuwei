/**
 * ConversationLedgerPort —— 事实账本的**唯一写入契约**。
 *
 * ============================================================================
 *  计划书第 78–81 节：不允许业务代码直接 insert ConversationEvent
 * ============================================================================
 * 计划书写得很直白：
 *
 *   > 否则未来会出现：某个模块忘记 sequence / 某个模块 actorType 写错 /
 *   > 某个模块没写 provenance
 *
 * 所以 M3 把"M2.5 里只是一堆仓储函数"提升为一个**端口**，并且刻意让它的
 * 方法签名**写不出错误的东西**：
 *
 *   · 没有 `append(event)` 这种万能入口 —— 只有四个具名操作
 *     （用户说了话 / 她说了话 / 系统通知 / 工具返回）
 *   · 没有 `sequence` 参数 —— 序号由持久层原子分配（计划书第 81 节）
 *   · 没有 `actorType` 参数 —— 它由你调用的是哪个方法决定
 *   · 没有 `sourceKind` 参数 —— 它由 actorType 推导（失败关闭）
 *
 * 于是"来源写错"这件事从"靠自觉"变成"类型层面写不出来"。
 *
 * ---------------------------------------------------------------------------
 *  为什么端口住在领域层，实现在基础设施层
 * ---------------------------------------------------------------------------
 * 与 `TraceWriter` / `TelemetryPort` 同一个道理：领域层只声明
 * "我需要一个能记账的东西"，基础设施层提供 SQL 实现。
 * 这样领域用例（ConversationIntegrityService）可以被纯内存实现测试，
 * 而不必为每个用例起一个数据库。
 */

import type { CharacterId, ConversationEventId, ConversationId, Timestamp } from './ids.ts'
import type { ConversationEvent, DeliveryStatus } from './conversation-event.ts'

// ---------------------------------------------------------------------------
// 具名写入操作
// ---------------------------------------------------------------------------

/**
 * 用户说了话。
 *
 * `replyToEventId` 存在且指向一条**她自己生成的**事件时，
 * 权威等级会被提升为 `USER_REPLY_CONFIRMATION`（计划书第 33 节）。
 * 这个判定由实现方（端口实现）按 reply graph 查一次得出，
 * 调用方不需要也不应该自己算。
 */
export interface AppendUserStatementInput {
  characterId: CharacterId
  conversationId: ConversationId
  /** 稳定用户身份（**不是** transport 身份，见 actor.ts / 计划书第 25 节） */
  userId: string
  content: string
  /** 会话内序号（由调用方从持久层推导，端口不猜） */
  conversationSequence: number
  replyToEventId?: ConversationEventId
  transport?: string
  /** 由调用方预分配的角色级序号（一次交互要写两条相邻事件时用） */
  characterSequence?: number
  metadata?: Record<string, unknown>
  createdAt?: Timestamp
  /**
   * M3.5（计划书第 29–34 节）：这件事**什么时候发生**。
   *
   * 缺省 = 不写（NULL）。当前对话里它通常等于 `createdAt`，
   * 但那是调用方要声明的事，端口不替它猜 ——
   * "不知道它什么时候发生"与"它就是此刻发生的"是两件不同的事。
   */
  occurredAt?: Timestamp
  /** M3.5：模拟时间槽位；当前必须留空（`assertEventTime` 会拒绝非空值） */
  logicalTime?: string
}

export interface AppendCharacterOutputInput {
  characterId: CharacterId
  conversationId: ConversationId
  content: string
  conversationSequence: number
  /** **必填**：否则无法回答"哪条回复属于哪个角色" */
  characterIdAsActor: CharacterId | string
  replyToEventId?: ConversationEventId
  /**
   * 计划书第 37 节：生成 ≠ 送达。
   *
   * 默认 `generated` —— 事件被写入时它**确实只是生成了**，
   * "送达"是 transport 的事，由调用方在真的发出去之后另行确认。
   * 这个默认值是刻意的：宁可账本说"生成了但没确认送达"，
   * 也不要它谎称"已经送到用户那里了"。
   */
  deliveryStatus?: DeliveryStatus
  traceId?: string
  modelProfile?: string
  transport?: string
  characterSequence?: number
  metadata?: Record<string, unknown>
  createdAt?: Timestamp
  /**
   * M3.5（计划书第 29–34 节）：这件事**什么时候发生**。
   *
   * 缺省 = 不写（NULL）。当前对话里它通常等于 `createdAt`，
   * 但那是调用方要声明的事，端口不替它猜 ——
   * "不知道它什么时候发生"与"它就是此刻发生的"是两件不同的事。
   */
  occurredAt?: Timestamp
  /** M3.5：模拟时间槽位；当前必须留空（`assertEventTime` 会拒绝非空值） */
  logicalTime?: string
}

export interface AppendSystemEventInput {
  characterId: CharacterId
  conversationId: ConversationId
  /** 系统组件名（如 `scheduler`） */
  source: string
  content: string
  conversationSequence: number
  metadata?: Record<string, unknown>
  characterSequence?: number
  createdAt?: Timestamp
  /**
   * M3.5（计划书第 29–34 节）：这件事**什么时候发生**。
   *
   * 缺省 = 不写（NULL）。当前对话里它通常等于 `createdAt`，
   * 但那是调用方要声明的事，端口不替它猜 ——
   * "不知道它什么时候发生"与"它就是此刻发生的"是两件不同的事。
   */
  occurredAt?: Timestamp
  /** M3.5：模拟时间槽位；当前必须留空（`assertEventTime` 会拒绝非空值） */
  logicalTime?: string
}

export interface AppendToolEventInput {
  characterId: CharacterId
  conversationId: ConversationId
  /** 工具名（如 `weather`） */
  toolName: string
  content: string
  conversationSequence: number
  /** 该工具调用是为回应哪条事件 */
  replyToEventId?: ConversationEventId
  metadata?: Record<string, unknown>
  characterSequence?: number
  createdAt?: Timestamp
  /**
   * M3.5（计划书第 29–34 节）：这件事**什么时候发生**。
   *
   * 缺省 = 不写（NULL）。当前对话里它通常等于 `createdAt`，
   * 但那是调用方要声明的事，端口不替它猜 ——
   * "不知道它什么时候发生"与"它就是此刻发生的"是两件不同的事。
   */
  occurredAt?: Timestamp
  /** M3.5：模拟时间槽位；当前必须留空（`assertEventTime` 会拒绝非空值） */
  logicalTime?: string
}

export interface AppendOutcome {
  event: ConversationEvent
  /** true = 真的写进去了；false = 幂等命中（同一会话内序号已存在） */
  appended: boolean
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export interface RecentEventsQuery {
  characterId: CharacterId
  conversationId?: ConversationId
  limit: number
  beforeSequence?: number
}

/**
 * 事实账本端口。
 *
 * ⚠️ **没有 update / delete**。不是"我们约定不改"，是端口上根本没有那两个字。
 * 整个 M3 唯一的删除发生在 `--reset-kernel`（一个显式的开发者命令），
 * 那条路径不走这个端口。
 */
export interface ConversationLedgerPort {
  appendUserStatement(input: AppendUserStatementInput): Promise<AppendOutcome>
  appendCharacterOutput(input: AppendCharacterOutputInput): Promise<AppendOutcome>
  appendSystemEvent(input: AppendSystemEventInput): Promise<AppendOutcome>
  appendToolEvent(input: AppendToolEventInput): Promise<AppendOutcome>

  getById(id: ConversationEventId): Promise<ConversationEvent | undefined>
  /**
   * 按会话内序号回读（幂等判定与完整性校验用）。
   *
   * 存在的理由：`ConversationIntegrityService` 要能回答"这个坐标被占了吗"，
   * 而它只允许依赖端口 —— 于是端口必须提供这一次读取。
   * 少了它，那个服务就只能自己去拿数据库句柄，边界立刻破掉。
   */
  findByConversationSequence(
    characterId: CharacterId,
    conversationId: ConversationId,
    conversationSequence: number
  ): Promise<ConversationEvent | undefined>
  listRecent(query: RecentEventsQuery): Promise<ConversationEvent[]>
  listRange(
    characterId: CharacterId,
    fromSequence: number,
    toSequence: number,
    limit?: number
  ): Promise<ConversationEvent[]>
  /** 会话内下一个可用序号（`latestConversationSequence() + 1`） */
  nextConversationSequence(
    characterId: CharacterId,
    conversationId: ConversationId
  ): Promise<number>
  count(characterId: CharacterId): Promise<number>
}
