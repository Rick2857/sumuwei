/**
 * MessageNormalizer —— **任意 transport 形状 → 一个领域输入**。
 *
 * ============================================================================
 *  计划书第 23–25 节
 * ============================================================================
 * 硬规则：
 *
 *   > 不要让 Discord Message / QQ Message / Web Message / Internal Runtime Message
 *   > 直接进入 Character Kernel。
 *
 * 因此在 Kernel 门口放一个**纯函数**归一化器。它做三件事，
 * 而且只做这三件事：
 *
 *   1. 把各种形状的输入收敛成一个 `NormalizedConversationInput`
 *   2. 把 transport 身份（qq_id / discord_user_id / websocket conn id）
 *      与**领域身份**（UserId）分开
 *   3. 缺什么就明确报错，而不是猜
 *
 * ---------------------------------------------------------------------------
 *  为什么 transport metadata 不参与人格逻辑
 * ---------------------------------------------------------------------------
 * 计划书第 25 节：`discord_user_id` / `qq_id` / `websocket_connection_id`
 * 属于 **transport metadata**，不是 Character Domain identity。
 *
 * 这不是洁癖，是防止一类具体退化：把 `qq_id` 当 UserId 用之后，
 * 用户换一个平台就不再是同一个人 —— 而 M4 会把他的事实绑在旧 id 上。
 * 所以归一化时**必须**显式经过一次 `external_identity → UserId` 的解析
 * （由 `ActorResolver` 注入，见 actor-resolver），归一化器自己**不做**映射，
 * 它只负责把"未解析的 transport 身份"标出来。
 */

import { KernelError, type CharacterId, type ConversationId, type Timestamp } from './ids.ts'
import type { ActorRef, ActorType } from './actor.ts'

/**
 * 归一化后的对话输入 —— Character Kernel 的**唯一**入口形状。
 *
 * 计划书第 24 节。刻意保留 `transport` 与 `metadata` 两个字段：
 * 它们**进不了**人格逻辑，但进得了 Trace 与排查，
 * 而且以后要做"同一句话在不同平台上的送达差异"时必须要有。
 */
export interface NormalizedConversationInput {
  characterId: CharacterId
  conversationId: ConversationId
  actor: ActorRef
  content: string
  /** 外部系统给的消息 id（用于幂等与回查；**不是**我们的 event id） */
  externalMessageId?: string
  /** 这条消息在回复哪条事件（reply graph，计划书第 34 节） */
  replyToEventId?: string
  /** 渠道（cli / qq / discord / web / harness…） */
  transport?: string
  receivedAt: Timestamp
  metadata?: Record<string, unknown>
}

/**
 * 进入归一化器的原始输入。
 *
 * 刻意做成"宽进"的形状：transport 适配器只需把手上有的东西填进来，
 * 缺的留空。**严格性由归一化器负责**，不由每个适配器各写一遍。
 */
export interface RawConversationInput {
  /** transport 报上来的角色标识（可能是 id，也可能是名字，由注入的解析器处理） */
  characterRef?: string
  /** transport 报上来的会话标识（房间 / 频道 / 窗口） */
  conversationRef?: string
  /**
   * transport 报上来的发言者。
   *
   * `externalId` 是**平台侧**的身份，不是我们的 UserId。
   * 归一化器不解析它 —— 解析是 ActorResolver 的职责。
   */
  sender: {
    actorType: ActorType
    /** 平台侧 id（qq 号 / discord id / websocket 连接 id / 角色 id） */
    externalId?: string
    /** 已解析的领域身份（调用方已经解析过时提供，跳过解析） */
    resolvedId?: string
    displayName?: string
  }
  content: string
  externalMessageId?: string
  replyToEventId?: string
  transport?: string
  receivedAt?: Timestamp
  metadata?: Record<string, unknown>
}

/** 归一化过程中把 transport 身份解析成领域身份的钩子（由基础设施实现） */
export interface IdentityResolving {
  /** 解析角色：返回 canonical CharacterId */
  resolveCharacter(ref: string | undefined): Promise<string | undefined> | string | undefined
  /** 解析会话：返回 canonical ConversationId */
  resolveConversation(
    characterId: string,
    ref: string | undefined
  ): Promise<string | undefined> | string | undefined
  /** 解析用户：external identity → 稳定 UserId（**M3 的核心要求之一**） */
  resolveUser(input: {
    transport?: string
    externalId?: string
    displayName?: string
  }): Promise<string | undefined> | string | undefined
}

export interface NormalizeOptions {
  resolver: IdentityResolving
  /** 缺省角色（本项目只有一个角色时由装配层给出） */
  defaultCharacterId?: string
  /** 缺省会话（CLI 单房间场景） */
  defaultConversationId?: string
}


/**
 * 归一化（**纯逻辑**，副作用只有注入的解析器调用）。
 *
 * 失败关闭：任何一项身份解析不出来就抛错，**不猜**。
 * 宁可这一轮进不来，也不要让一条"身份不明"的事实进账本 ——
 * append-only 意味着写错的来源永远留在那里。
 */
export async function normalizeConversationInput(
  raw: RawConversationInput,
  options: NormalizeOptions
): Promise<NormalizedConversationInput> {
  const content = raw.content.trim()
  if (content === '') {
    throw new KernelError('validation_error', 'empty_message', '消息正文为空，拒绝归一化')
  }

  const characterRef = raw.characterRef ?? options.defaultCharacterId
  const characterId = await options.resolver.resolveCharacter(characterRef)
  if (!characterId) {
    throw new KernelError(
      'validation_error',
      'character_unresolved',
      `无法解析角色身份：characterRef=${String(characterRef)}。` +
        '归一化器刻意不猜 —— 身份不明的事实一旦写进账本就无法撤回。'
    )
  }

  const conversationRef = raw.conversationRef ?? options.defaultConversationId
  const conversationId = await options.resolver.resolveConversation(characterId, conversationRef)
  if (!conversationId) {
    throw new KernelError(
      'validation_error',
      'conversation_unresolved',
      `无法解析会话身份：conversationRef=${String(conversationRef)}`
    )
  }

  const actorId = await resolveActorId(raw, options.resolver)
  if (!actorId) {
    throw new KernelError(
      'validation_error',
      'actor_unresolved',
      `无法解析发言者身份：actorType=${raw.sender.actorType} ` +
        `externalId=${String(raw.sender.externalId)}`
    )
  }

  const metadata: Record<string, unknown> = { ...(raw.metadata ?? {}) }
  // transport 身份**只**作为元数据保留，绝不冒充领域身份（计划书第 25 节）
  if (raw.sender.externalId && raw.sender.externalId !== actorId) {
    metadata.transportActorId = raw.sender.externalId
  }
  if (raw.sender.displayName) metadata.transportDisplayName = raw.sender.displayName

  return {
    characterId: characterId as CharacterId,
    conversationId: conversationId as ConversationId,
    actor: { actorId, actorType: raw.sender.actorType },
    content,
    ...(raw.externalMessageId ? { externalMessageId: raw.externalMessageId } : {}),
    ...(raw.replyToEventId ? { replyToEventId: raw.replyToEventId } : {}),
    ...(raw.transport ? { transport: raw.transport } : {}),
    receivedAt: raw.receivedAt ?? Date.now(),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

async function resolveActorId(
  raw: RawConversationInput,
  resolver: IdentityResolving
): Promise<string | undefined> {
  // 已经解析过的直接信任（调用方是内部模块，不是 transport）
  if (raw.sender.resolvedId) return raw.sender.resolvedId
  // 系统与工具身份不经过用户映射表：它们的 id 就是组件名
  if (raw.sender.actorType === 'system' || raw.sender.actorType === 'tool') {
    return raw.sender.externalId
  }
  return resolver.resolveUser({
    transport: raw.transport,
    externalId: raw.sender.externalId,
    displayName: raw.sender.displayName,
  })
}

/**
 * 从归一化输入取出"这次交互的参与者三元组"。
 *
 * 单独一个函数是因为它被三个地方需要（完整性校验、账本写入、Trace 属性），
 * 而这三处**必须**看到同一组值 —— 各自拼一次就会有一天不一致。
 */
export function participantsOf(input: NormalizedConversationInput): {
  characterId: CharacterId
  conversationId: ConversationId
  userId?: string
} {
  return {
    characterId: input.characterId,
    conversationId: input.conversationId,
    ...(input.actor.actorType === 'user' ? { userId: input.actor.actorId } : {}),
  }
}
