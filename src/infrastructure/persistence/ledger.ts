/**
 * ConversationLedgerPort 的持久化实现（WP5）。
 *
 * ============================================================================
 *  计划书第 79–81 节：所有写入必须经过它
 * ============================================================================
 * 这个文件的形状是刻意的：**四个具名方法，没有通用 append**。
 *
 *   appendUserStatement     —— 用户说了话
 *   appendCharacterOutput   —— 她说了话
 *   appendSystemEvent       —— 系统通知
 *   appendToolEvent         —— 工具返回
 *
 * 因此调用点写不出"actorType 写错"这件事：actor 由**你调用的方法**决定。
 * 序号也写不出来：它由持久层原子分配（计划书第 81 节）。
 *
 * ---------------------------------------------------------------------------
 *  与 conversation-store.ts 的分工
 * ---------------------------------------------------------------------------
 *   conversation-store.ts  —— 行级 SQL（append-only、幂等、竞态兜底）
 *   ledger.ts（本文件）    —— 领域语义（谁说的、什么来源、reply graph 校验）
 *
 * 把两层分开的好处：SQL 层可以被"必须更快"的场景直接复用（例如批量回填），
 * 而领域语义只有一处，不会在三个调用点各写一半。
 *
 * ---------------------------------------------------------------------------
 *  幂等优先于一切校验
 * ---------------------------------------------------------------------------
 * 同一 (会话, 会话内序号) 已存在时**直接返回旧事件**（`appended: false`），
 * 而不是报错。原因：重试是正常现象（网络抖动、进程重启），
 * 而"重试导致报错"会让上层要么吞掉异常、要么重写逻辑。
 * M2.5 的 SC-004 已经在守这条，M3 的端口必须继承它。
 */

import {
  KernelError,
  validateReplyGraph,
  type ActorType,
  type AppendCharacterOutputInput,
  type AppendOutcome,
  type AppendSystemEventInput,
  type AppendToolEventInput,
  type AppendUserStatementInput,
  type CharacterId,
  type ConversationEvent,
  type ConversationEventId,
  type ConversationId,
  type ConversationLedgerPort,
  type RecentEventsQuery,
  type ReplyTargetView,
} from '../../kernel/contracts/index.ts'
import type { ConversationFamily, TrustedAttributionContext } from '../../kernel/contracts/attribution.ts'
import {
  indexConversationIngress,
  type ConversationAttributionProducer,
} from '../runtime/conversation-attribution.ts'
import {
  appendConversationEvent,
  countConversationEvents,
  findByConversationSequence as findByConversationSequenceRow,
  getConversationEvent,
  latestConversationSequence,
  recentConversationEvents,
  conversationEventsInRange,
} from './conversation-store.ts'
import { allocateSequenceRange } from './sequence.ts'
import type { RawDb } from './db.ts'

export interface ConversationLedgerOptions {
  db: RawDb
  /** 缺省 transport（调用方不传时用它；只进 metadata，不参与人格逻辑） */
  defaultTransport?: string
  /**
   * WP6.1（K-28）：**生产 ingress 的受信归因构造者**。
   *
   * 只有装配层（`src/main.ts`）该传它，而且只能由
   * `conversationAttributionForEntryMode()` 产出 —— 见
   * `infrastructure/runtime/conversation-attribution.ts` 的文件头说明。
   *
   * ⚠️ 不传 = **legacy 写入路径**（逐字段与今天相同：不写 `attribution_origin`，
   * 也不写那 18 个槽位列）。这条缺省是给测试夹具、迁移回填与 M3 评测留的，
   * 它**不是**一条"生产可以不接线"的出口：`pnpm m5.1.1:wp6.1:verify` 的
   * 静态探测器会断言生产写入者要么已接线、要么显式登记为兼容路径。
   */
  attribution?: readonly ConversationAttributionProducer[]
}

export function createConversationLedger(
  options: ConversationLedgerOptions
): ConversationLedgerPort {
  const { db } = options
  const transport = options.defaultTransport ?? 'unknown'
  /** 族 → 生产 ingress（空 map = 全部走 legacy 路径） */
  const ingressByFamily = indexConversationIngress(options.attribution ?? [])

  /**
   * 写入前的 reply graph 校验（**失败关闭**）。
   *
   * 为什么必须在写入前查一次：reply graph 的悬空引用是**永久性**的
   * （append-only 撤不回来）。一条指向不存在事件的回复会让未来任何
   * "这句话在回应什么"的推理都得到错误答案，而且没人知道它是错的。
   */
  async function assertReplyTarget(input: {
    type: ConversationEvent['type']
    replyToEventId?: ConversationEventId
    characterId: CharacterId
    conversationId: ConversationId
  }): Promise<void> {
    let target: ReplyTargetView | undefined
    if (input.replyToEventId) {
      const event = await getConversationEvent(db, input.replyToEventId)
      if (event) {
        target = {
          id: event.id,
          characterId: event.characterId,
          conversationId: event.conversationId,
          sequence: event.sequence,
          actorType: event.actorType,
        }
      }
    }
    // sequence 传一个"一定更大"的值：本事件还没分配序号，
    // 而"回复目标必须更早"这条由持久层的 append-only 语义保证
    // （目标已经存在，本事件必然是新的）。因此这里用一个足够大的数。
    const verdict = validateReplyGraph({
      type: input.type,
      replyToEventId: input.replyToEventId,
      target,
      characterId: input.characterId,
      conversationId: input.conversationId,
      sequence: Number.MAX_SAFE_INTEGER - 1,
    })
    if (verdict.kind === 'reject') {
      throw new KernelError('validation_error', verdict.code, verdict.message)
    }
  }

  /**
   * WP6.1（K-28）：**族 → 生产 ingress → 受信归因上下文**。
   *
   * 两条刻意的性质：
   *   · 生产者由**事件族**查表得到（调用方传不了"用哪份归因"的开关）
   *   · 该族没有生产者时返回 `undefined` ⇒ 走 legacy 路径（逐字段与今天相同）
   *
   * `presenterActorId` 与 `userId` 是**写入路径自己的事实**（呈现位次、已解析的
   * 领域身份），不是外部 DTO 字段 —— 生产 ingress 会自己判断怎么用它们
   * （例如 agent-runner 只把 `SERVICE` 写进两个权威槽位，**不**碰 `userId`）。
   */
  function trustedAttributionFor(input: {
    family: ConversationFamily
    characterId: string
    presenterActorId: string
    userId?: string
  }): TrustedAttributionContext | undefined {
    const producer = ingressByFamily.get(input.family)
    if (producer === undefined) return undefined
    return producer.attest({
      characterId: input.characterId,
      presenterActorId: input.presenterActorId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
    })
  }

  async function appendWith(input: {
    characterId: CharacterId
    conversationId: ConversationId
    conversationSequence: number
    type: ConversationEvent['type']
    actorType: ActorType
    actorId: string
    content: string
    replyToEventId?: ConversationEventId
    deliveryStatus?: ConversationEvent['deliveryStatus']
    repliedToSourceKind?: ConversationEvent['sourceKind']
    metadata?: Record<string, unknown>
    characterSequence?: number
    createdAt?: number
    /** M3.5：发生时间（缺省 = 不知道） */
    occurredAt?: number
    /** M3.5：模拟时间槽位（当前必为空） */
    logicalTime?: string
    /**
     * WP6.1：本条事件的**用户领域身份**（只有 user_message 族有）。
     * 它是受信事实（身份解析路径的产物），由生产 ingress 决定怎么用。
     */
    userId?: string
  }): Promise<AppendOutcome> {
    await assertReplyTarget({
      type: input.type,
      replyToEventId: input.replyToEventId,
      characterId: input.characterId,
      conversationId: input.conversationId,
    })

    /*
     * WP6.1（K-28）：受信归因 —— **由族决定找哪个生产 ingress**，而不是由调用方
     * 传一个"用哪份归因"的开关。没有该族的生产者 ⇒ 返回 undefined ⇒ 走 legacy
     * （不写 `attribution_origin`，也不写那 18 个槽位列），与今天的 SQL 逐字相同。
     */
    const trustedAttribution = trustedAttributionFor({
      family: input.type as ConversationFamily,
      characterId: String(input.characterId),
      presenterActorId: input.actorId ?? '',
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
    })

    const result = await appendConversationEvent(db, {
      characterId: input.characterId,
      conversationId: input.conversationId,
      conversationSequence: input.conversationSequence,
      type: input.type,
      actorType: input.actorType,
      actorId: input.actorId,
      content: input.content,
      replyToEventId: input.replyToEventId,
      deliveryStatus: input.deliveryStatus,
      repliedToSourceKind: input.repliedToSourceKind,
      metadata: input.metadata,
      characterSequence: input.characterSequence,
      createdAt: input.createdAt,
      ...(trustedAttribution !== undefined ? { trustedAttribution } : {}),
      ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
      ...(input.logicalTime !== undefined ? { logicalTime: input.logicalTime } : {}),
    })
    return { event: result.event, appended: result.appended }
  }

  return {
    async appendUserStatement(input: AppendUserStatementInput): Promise<AppendOutcome> {
      // 用户确认的权威提升：只有当这条在回复**她自己生成的内容**时才成立
      // （计划书第 33 节）。判定靠 reply graph，不靠语义猜测。
      let repliedToSourceKind: ConversationEvent['sourceKind'] | undefined
      if (input.replyToEventId) {
        const target = await getConversationEvent(db, input.replyToEventId)
        repliedToSourceKind = target?.sourceKind
      }

      return appendWith({
        characterId: input.characterId,
        conversationId: input.conversationId,
        conversationSequence: input.conversationSequence,
        type: 'user_message',
        actorType: 'user',
        actorId: input.userId,
        content: input.content,
        replyToEventId: input.replyToEventId,
        repliedToSourceKind,
        metadata: {
          transport: input.transport ?? transport,
          userId: input.userId,
          ...(input.metadata ?? {}),
        },
        characterSequence: input.characterSequence,
        createdAt: input.createdAt,
        ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
        ...(input.logicalTime !== undefined ? { logicalTime: input.logicalTime } : {}),
        // WP6.1：用户领域身份（受信事实）—— 生产 ingress 据此建立 actor / contentOriginator
        userId: input.userId,
      })
    },

    async appendCharacterOutput(input: AppendCharacterOutputInput): Promise<AppendOutcome> {
      return appendWith({
        characterId: input.characterId,
        conversationId: input.conversationId,
        conversationSequence: input.conversationSequence,
        type: 'assistant_message',
        actorType: 'character',
        actorId: String(input.characterIdAsActor),
        content: input.content,
        replyToEventId: input.replyToEventId,
        // 计划书第 37 节：默认 generated。**不默认 delivered**，
        // 因为"写进账本"不等于"送到用户手里"。
        deliveryStatus: input.deliveryStatus ?? 'generated',
        metadata: {
          transport: input.transport ?? transport,
          ...(input.traceId ? { traceId: input.traceId } : {}),
          ...(input.modelProfile ? { modelProfile: input.modelProfile } : {}),
          ...(input.metadata ?? {}),
        },
        characterSequence: input.characterSequence,
        createdAt: input.createdAt,
        ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
        ...(input.logicalTime !== undefined ? { logicalTime: input.logicalTime } : {}),
      })
    },

    async appendSystemEvent(input: AppendSystemEventInput): Promise<AppendOutcome> {
      return appendWith({
        characterId: input.characterId,
        conversationId: input.conversationId,
        conversationSequence: input.conversationSequence,
        type: 'system_event',
        actorType: 'system',
        actorId: input.source,
        content: input.content,
        metadata: { transport, ...(input.metadata ?? {}) },
        characterSequence: input.characterSequence,
        createdAt: input.createdAt,
        ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
        ...(input.logicalTime !== undefined ? { logicalTime: input.logicalTime } : {}),
      })
    },

    async appendToolEvent(input: AppendToolEventInput): Promise<AppendOutcome> {
      return appendWith({
        characterId: input.characterId,
        conversationId: input.conversationId,
        conversationSequence: input.conversationSequence,
        type: 'tool_event',
        actorType: 'tool',
        actorId: input.toolName,
        content: input.content,
        replyToEventId: input.replyToEventId,
        metadata: { transport, toolName: input.toolName, ...(input.metadata ?? {}) },
        characterSequence: input.characterSequence,
        createdAt: input.createdAt,
        ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
        ...(input.logicalTime !== undefined ? { logicalTime: input.logicalTime } : {}),
      })
    },

    async getById(id: ConversationEventId): Promise<ConversationEvent | undefined> {
      return getConversationEvent(db, id)
    },

    async findByConversationSequence(
      characterId: CharacterId,
      conversationId: ConversationId,
      conversationSequence: number
    ): Promise<ConversationEvent | undefined> {
      return findByConversationSequenceRow(db, characterId, conversationId, conversationSequence)
    },

    async listRecent(query: RecentEventsQuery): Promise<ConversationEvent[]> {
      return recentConversationEvents(db, {
        characterId: query.characterId,
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        limit: query.limit,
        ...(query.beforeSequence === undefined ? {} : { beforeSequence: query.beforeSequence }),
      })
    },

    async listRange(
      characterId: CharacterId,
      fromSequence: number,
      toSequence: number,
      limit = 200
    ): Promise<ConversationEvent[]> {
      return conversationEventsInRange(db, characterId, fromSequence, toSequence, limit)
    },

    async nextConversationSequence(
      characterId: CharacterId,
      conversationId: ConversationId
    ): Promise<number> {
      return (await latestConversationSequence(db, characterId, conversationId)) + 1
    },

    async count(characterId: CharacterId): Promise<number> {
      return countConversationEvents(db, characterId)
    },
  }
}

/**
 * 为一轮交互预分配两个序号（用户事件 + 她的回复）。
 *
 * 暴露成函数而不是让调用方自己调 `allocateSequenceRange`：
 * "一轮 = 两条相邻事件"这个约定必须有唯一实现处，
 * 否则某天会有人在中间插进第三条，而那会破坏
 * "同一轮的用户事件与助手事件必须相邻"（SC-003）这条不变量。
 */
export async function reserveTurnSequences(
  db: RawDb,
  characterId: CharacterId
): Promise<{ userSequence: number; assistantSequence: number }> {
  const range = await allocateSequenceRange(db, characterId, 2)
  return { userSequence: range.start, assistantSequence: range.end }
}
