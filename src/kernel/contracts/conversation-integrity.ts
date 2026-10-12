/**
 * ConversationIntegrity —— 账本的**前置校验规则**（纯函数）。
 *
 * ============================================================================
 *  计划书第 78 节 / 测试矩阵 T1–T15 / 指标 116–118
 * ============================================================================
 * 这一层回答四个问题，而且只用纯函数回答（因此可以逐条单测）：
 *
 *   1. 序号对吗？           —— Event Ordering Error Rate 必须为 0
 *   2. 说话人对吗？         —— actor 与事件类型必须匹配
 *   3. reply graph 对吗？   —— 回复的目标必须存在、同角色、同会话
 *   4. 会话归属对吗？       —— 事件不得跨角色/跨会话漂移
 *
 * 为什么这些校验要单独成一个契约文件，而不是塞进 `appendConversationEvent`：
 * 因为**失败关闭的规则必须能被独立测试和独立 review**。
 * 埋在 SQL 仓储里的校验，改一次就可能悄悄从"拒绝"变成"忽略"。
 *
 * ---------------------------------------------------------------------------
 *  与"幂等"的关系
 * ---------------------------------------------------------------------------
 * 校验通过不代表要写：同一 (会话, 会话内序号) 已经存在时，
 * 正确的行为是**幂等命中**（返回旧事件，不报错）。
 * 因此这里的结论是一个三元组：
 *
 *     accept   —— 可以写
 *     duplicate—— 已存在同样的坐标，走幂等（不是错误）
 *     reject   —— 拒绝，并给出稳定错误码
 */

import { KernelError, type CharacterId, type ConversationEventId, type ConversationId } from './ids.ts'
import type { ActorType } from './actor.ts'
import type { ConversationEvent, ConversationEventType } from './conversation-event.ts'

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------

export type IntegrityVerdict =
  | { kind: 'accept' }
  | { kind: 'duplicate'; reason: 'conversation_sequence_taken' | 'identical_event_exists' }
  | { kind: 'reject'; code: string; message: string }

export function reject(code: string, message: string): IntegrityVerdict {
  return { kind: 'reject', code, message }
}

export const ACCEPT: IntegrityVerdict = { kind: 'accept' }

/** 把拒绝结论变成异常（调用方决定是抛还是记 trace） */
export function throwIfRejected(verdict: IntegrityVerdict): void {
  if (verdict.kind === 'reject') {
    throw new KernelError('validation_error', verdict.code, verdict.message)
  }
}

// ---------------------------------------------------------------------------
// 规则 1：actor 与事件类型必须匹配
// ---------------------------------------------------------------------------

const EVENT_TYPE_ACTOR: Record<ConversationEventType, ActorType> = {
  user_message: 'user',
  assistant_message: 'character',
  system_event: 'system',
  tool_event: 'tool',
}

/**
 * 类型 ↔ actor 的一致性。
 *
 * 与 `createConversationEvent` 里的检查**刻意重复**：那一份是构造期的
 * "最后一道"（任何路径都绕不过），这一份是写入前的"第一道"，
 * 目的是**给出稳定错误码**并让规则可被单独测试。
 * 两处都在是好事：它们检查的是同一件事，但不共享失败方式。
 */
export function validateActorConsistency(input: {
  type: ConversationEventType
  actorType: ActorType
}): IntegrityVerdict {
  const expected = EVENT_TYPE_ACTOR[input.type]
  if (!expected) {
    return reject('unknown_event_type', `未登记的事件类型：${String(input.type)}`)
  }
  if (input.actorType !== expected) {
    return reject(
      'actor_type_mismatch',
      `${input.type} 的 actorType 必须是 ${expected}，收到 ${input.actorType}`
    )
  }
  return ACCEPT
}

// ---------------------------------------------------------------------------
// 规则 2：序号
// ---------------------------------------------------------------------------

/**
 * 会话内序号必须严格递增、且只能 +1。
 *
 * 为什么不允许跳号：会话内序号是**可读的账**
 * （"这个会话说到第几句"），跳号会让它失去这个用途。
 * 角色级序号（`sequence`）**允许有空洞** —— 它是坐标不是计数器
 * （一次交互预分配两个序号，模型失败时第二个就空着）。
 */
export function validateConversationSequence(input: {
  incoming: number
  /** 该会话当前最大会话内序号（0 = 还没有事件） */
  currentMax: number
}): IntegrityVerdict {
  if (!Number.isSafeInteger(input.incoming) || input.incoming < 1) {
    return reject(
      'bad_conversation_sequence',
      `conversationSequence 必须是 >= 1 的安全整数，收到 ${String(input.incoming)}`
    )
  }
  if (input.incoming <= input.currentMax) {
    // 不是错误：这是幂等命中（同一个序号重复写）
    return { kind: 'duplicate', reason: 'conversation_sequence_taken' }
  }
  if (input.incoming > input.currentMax + 1) {
    return reject(
      'conversation_sequence_gap',
      `会话内序号出现空洞：当前最大 ${input.currentMax}，收到 ${input.incoming}。` +
        '会话内序号必须是可读的连续账（角色级序号才允许空洞）。'
    )
  }
  return ACCEPT
}

// ---------------------------------------------------------------------------
// 规则 3：reply graph
// ---------------------------------------------------------------------------

/** reply graph 校验需要的"被回复事件"的最小视图 */
export interface ReplyTargetView {
  id: ConversationEventId
  characterId: CharacterId
  conversationId: ConversationId
  sequence: number
  actorType: ActorType
}

/**
 * 计划书第 34 节：没有 reply graph 时，
 * 用户一句"对。"会让未来的系统完全无法理解"对什么"。
 *
 * 因此 M3 起它对 assistant 事件是**必填**，对 user 事件是可选但**一旦给了就必须对**。
 *
 * 四条规则：
 *   1. 目标必须存在（不存在 → `reply_target_missing`）
 *   2. 目标必须属于同一角色（→ `reply_target_foreign_character`）
 *   3. 目标必须属于同一会话（→ `reply_target_other_conversation`）
 *   4. 目标必须**更早**（→ `reply_target_not_earlier`）
 */
export function validateReplyGraph(input: {
  type: ConversationEventType
  replyToEventId?: ConversationEventId | string | undefined
  /** 查询结果：undefined = 不存在 */
  target?: ReplyTargetView | undefined
  characterId: CharacterId
  conversationId: ConversationId
  /** 本事件的角色级序号（用于"必须更早"） */
  sequence: number
}): IntegrityVerdict {
  const hasReply = input.replyToEventId !== undefined && String(input.replyToEventId) !== ''

  if (!hasReply) {
    if (input.type === 'assistant_message') {
      return reject(
        'reply_target_required',
        'assistant_message 必须带 replyToEventId：否则无法回答"这条回复在回应什么"'
      )
    }
    return ACCEPT
  }

  if (!input.target) {
    return reject(
      'reply_target_missing',
      `replyToEventId=${String(input.replyToEventId)} 指向的事件不存在。` +
        '悬空的 reply graph 会污染证据链，因此失败关闭。'
    )
  }
  if (String(input.target.characterId) !== String(input.characterId)) {
    return reject(
      'reply_target_foreign_character',
      `回复目标属于角色 ${String(input.target.characterId)}，不是 ${String(input.characterId)}`
    )
  }
  if (String(input.target.conversationId) !== String(input.conversationId)) {
    return reject(
      'reply_target_other_conversation',
      `回复目标属于会话 ${String(input.target.conversationId)}，不是 ${String(input.conversationId)}`
    )
  }
  if (input.target.sequence >= input.sequence) {
    return reject(
      'reply_target_not_earlier',
      `回复目标序号 ${input.target.sequence} 不早于本事件序号 ${input.sequence}`
    )
  }
  return ACCEPT
}

// ---------------------------------------------------------------------------
// 规则 4：会话归属
// ---------------------------------------------------------------------------

/**
 * 事件不得跨角色 / 跨会话漂移。
 *
 * 计划书 T2/T10（Conversation Isolation / Session Switch）的机制保证：
 * 换会话只换 `ConversationId`，`CharacterId` 与 `UserId` 不变。
 * 反过来若某条事件写着 A 会话却带着 B 会话的坐标，必须当场拒绝。
 */
export function validateParticipants(input: {
  characterId: CharacterId
  conversationId: ConversationId
  expectedCharacterId: CharacterId
  expectedConversationId: ConversationId
}): IntegrityVerdict {
  if (String(input.characterId) !== String(input.expectedCharacterId)) {
    return reject(
      'character_mismatch',
      `事件角色 ${String(input.characterId)} ≠ 期望 ${String(input.expectedCharacterId)}。` +
        '新会话不等于新角色（计划书第 38/39 节）。'
    )
  }
  if (String(input.conversationId) !== String(input.expectedConversationId)) {
    return reject(
      'conversation_mismatch',
      `事件会话 ${String(input.conversationId)} ≠ 期望 ${String(input.expectedConversationId)}`
    )
  }
  return ACCEPT
}

// ---------------------------------------------------------------------------
// 组合校验
// ---------------------------------------------------------------------------

export interface IntegrityCheckInput {
  type: ConversationEventType
  actorType: ActorType
  characterId: CharacterId
  conversationId: ConversationId
  conversationSequence: number
  currentMaxConversationSequence: number
  /**
   * 本次写入**期望落在**的角色/会话坐标。
   *
   * 这正是"会话归属"检查的意义所在：调用方带着自己的坐标来，
   * 事件里的坐标必须与它一致。若两处都取自同一个变量，
   * 这条检查永远通过 —— 那样它就只是装饰。
   */
  expectedCharacterId: CharacterId
  expectedConversationId: ConversationId
  /** 已存在同坐标的事件时提供（用于区分幂等命中与真冲突） */
  existingEvent?: ConversationEvent
  replyToEventId?: ConversationEventId | string
  replyTarget?: ReplyTargetView
  /** 本事件的角色级序号；未分配时传 currentMaxCharacterSequence + 1 */
  sequence: number
}

/**
 * 把四条规则串起来（**短路**：第一条拒绝就返回）。
 *
 * 短路而不是收集全部问题，是因为这些规则有依赖关系：
 * actor 不对时再去校验 reply graph 没有意义，而且错误信息会更难读。
 *
 * ⚠️ 幂等**优先于**其余检查：同坐标已存在时直接返回 duplicate，
 * 因为重复写不是错误，而"重复写导致报错"会让重试路径变得不可用
 * （M2.5 的 SC-004 已经在守这条）。
 */
export function validateIntegrity(input: IntegrityCheckInput): IntegrityVerdict {
  const sequence = validateConversationSequence({
    incoming: input.conversationSequence,
    currentMax: input.currentMaxConversationSequence,
  })
  if (sequence.kind === 'duplicate') return sequence
  if (sequence.kind === 'reject') return sequence

  const participants = validateParticipants({
    characterId: input.characterId,
    conversationId: input.conversationId,
    expectedCharacterId: input.expectedCharacterId,
    expectedConversationId: input.expectedConversationId,
  })
  if (participants.kind === 'reject') return participants

  const actor = validateActorConsistency({ type: input.type, actorType: input.actorType })
  if (actor.kind === 'reject') return actor

  const reply = validateReplyGraph({
    type: input.type,
    replyToEventId: input.replyToEventId,
    target: input.replyTarget,
    characterId: input.characterId,
    conversationId: input.conversationId,
    sequence: input.sequence,
  })
  if (reply.kind === 'reject') return reply

  return ACCEPT
}
