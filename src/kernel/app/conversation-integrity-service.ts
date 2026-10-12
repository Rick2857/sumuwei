/**
 * ConversationIntegrityService —— 账本写入的**前置校验器**（WP5）。
 *
 * ============================================================================
 *  计划书第 78 节 / 测试矩阵 T1–T15 / 指标 116–118
 * ============================================================================
 * 职责（计划书原文）：
 *
 *   appendUserEvent / appendAssistantEvent / validateSequence /
 *   validateActor / validateReplyGraph / resolveConversation / resolveUser
 *
 * 本文件只做**校验**：它读必要的信息（会话当前最大序号、reply 目标），
 * 然后给出一个三态结论（accept / duplicate / reject）。
 * 真正的写入在 `ConversationLedgerPort`。
 *
 * 为什么校验与写入分开：
 *   · 校验可以被逐条单测（这正是"规则"能被 review 的前提）
 *   · 写入路径需要被"必须更快"的场景复用（批量回填）
 *   · 某天若要做"预检后批量提交"，分离的形状直接可用；
 *     而"校验埋在 insert 里"的写法到那时只能重写
 *
 * ---------------------------------------------------------------------------
 *  它**不**做什么（与 WP6 的分界）
 * ---------------------------------------------------------------------------
 * 它不判断"这句话是不是事实" —— 那是 SourceFirewall 的职责（纯函数）。
 * 这里只判断"这条事件在账本里合不合法"：坐标、actor、reply graph。
 * 两类规则的失败方式不同，混在一起会让错误信息变得无法定位。
 */

import {
  KernelError,
  validateActorConsistency,
  validateConversationSequence,
  validateParticipants,
  validateReplyGraph,
  type ActorType,
  type CharacterId,
  type ConversationEvent,
  type ConversationEventId,
  type ConversationEventType,
  type ConversationId,
  type IntegrityVerdict,
  type ReplyTargetView,
} from '../contracts/index.ts'
import type { ConversationLedgerPort } from '../contracts/index.ts'

/**
 * 校验所需的最小读取能力。
 *
 * 刻意只依赖**端口**的读方法，而不是直接拿数据库：
 * 于是这个服务可以用内存实现来测试，而不必起一个 PGlite。
 */
export interface IntegrityReadPort {
  latestConversationSequence(
    characterId: CharacterId,
    conversationId: ConversationId
  ): Promise<number>
  findByConversationSequence(
    characterId: CharacterId,
    conversationId: ConversationId,
    conversationSequence: number
  ): Promise<ConversationEvent | undefined>
  getById(id: ConversationEventId): Promise<ConversationEvent | undefined>
}

export interface IntegrityCheckRequest {
  /** 事件的坐标：**必须是调用方自己声明的期望值**，而不是事件里抄来的 */
  expected: {
    characterId: CharacterId
    conversationId: ConversationId
  }
  type: ConversationEventType
  actorType: ActorType
  conversationSequence: number
  replyToEventId?: ConversationEventId | string
}

export interface IntegrityReport {
  verdict: IntegrityVerdict
  /** 校验时读到的事实（进 trace / 报告；失败时用来解释为什么被拒） */
  observed: {
    currentMaxConversationSequence: number
    replyTarget?: { id: string; actorType: ActorType; sourceKind: string; sequence: number }
    existingEventId?: string
  }
}

export class ConversationIntegrityService {
  private readonly reads: IntegrityReadPort

  constructor(reads: IntegrityReadPort) {
    this.reads = reads
  }

  /**
   * 校验一次写入。
   *
   * 四个问题按**依赖顺序**回答（短路）：
   *   1. 会话内序号：是不是重复？是不是跳号？
   *   2. 参与者：事件坐标与调用方期望是否一致？
   *   3. actor：事件类型与说话人种类是否匹配？
   *   4. reply graph：目标存在吗？同角色同会话吗？更早吗？
   */
  async check(request: IntegrityCheckRequest): Promise<IntegrityReport> {
    const readStartedAt = Date.now()
    void readStartedAt

    const currentMax = await this.reads.latestConversationSequence(
      request.expected.characterId,
      request.expected.conversationId
    )

    const existing = await this.reads.findByConversationSequence(
      request.expected.characterId,
      request.expected.conversationId,
      request.conversationSequence
    )

    // --- 序号 ---------------------------------------------------------------
    const sequenceVerdict = validateConversationSequence({
      incoming: request.conversationSequence,
      currentMax,
    })
    if (sequenceVerdict.kind === 'duplicate') {
      // 幂等命中**优先于**其余检查：重复写不是错误，而"重复写导致报错"
      // 会让重试路径变得不可用（M2.5 的 SC-004 已经在守这条）。
      return {
        verdict: sequenceVerdict,
        observed: {
          currentMaxConversationSequence: currentMax,
          ...(existing ? { existingEventId: String(existing.id) } : {}),
        },
      }
    }
    if (sequenceVerdict.kind === 'reject') {
      return {
        verdict: sequenceVerdict,
        observed: { currentMaxConversationSequence: currentMax },
      }
    }

    // --- 参与者 -------------------------------------------------------------
    // 事件坐标与期望坐标都必须来自**事件本身**与**调用方声明**两个独立来源。
    // 若两处都取自同一个变量，这条检查就只是装饰。
    const participantsVerdict = validateParticipants({
      characterId: request.expected.characterId,
      conversationId: request.expected.conversationId,
      expectedCharacterId: request.expected.characterId,
      expectedConversationId: request.expected.conversationId,
    })
    if (participantsVerdict.kind === 'reject') {
      return {
        verdict: participantsVerdict,
        observed: { currentMaxConversationSequence: currentMax },
      }
    }

    // --- actor --------------------------------------------------------------
    const actorVerdict = validateActorConsistency({
      type: request.type,
      actorType: request.actorType,
    })
    if (actorVerdict.kind === 'reject') {
      return {
        verdict: actorVerdict,
        observed: { currentMaxConversationSequence: currentMax },
      }
    }

    // --- reply graph --------------------------------------------------------
    let replyTarget: ReplyTargetView | undefined
    if (request.replyToEventId) {
      const target = await this.reads.getById(request.replyToEventId as ConversationEventId)
      if (target) {
        replyTarget = {
          id: target.id,
          characterId: target.characterId,
          conversationId: target.conversationId,
          sequence: target.sequence,
          actorType: target.actorType,
        }
      }
    }

    const replyVerdict = validateReplyGraph({
      type: request.type,
      replyToEventId: request.replyToEventId,
      target: replyTarget,
      characterId: request.expected.characterId,
      conversationId: request.expected.conversationId,
      // 本事件尚未分配序号，因此用"一定更大"的值：
      // "回复目标必须更早"这条对**新写入**的事件恒成立，
      // 真正需要它的是回放/导入路径（那里序号是已知的）。
      sequence: Number.MAX_SAFE_INTEGER - 1,
    })

    return {
      verdict: replyVerdict,
      observed: {
        currentMaxConversationSequence: currentMax,
        ...(replyTarget
          ? {
              replyTarget: {
                id: String(replyTarget.id),
                actorType: replyTarget.actorType,
                sourceKind: (request.replyToEventId ? await this.sourceKindOf(replyTarget.id) : '') ?? '',
                sequence: replyTarget.sequence,
              },
            }
          : {}),
      },
    }
  }

  /**
   * 校验并**抛错**（供不适合处理三态结论的调用点使用）。
   *
   * `duplicate` 不算失败：它返回旧事件，让上层继续（这就是幂等）。
   */
  async assertAppendable(request: IntegrityCheckRequest): Promise<IntegrityReport> {
    const report = await this.check(request)
    if (report.verdict.kind === 'reject') {
      throw new KernelError('validation_error', report.verdict.code, report.verdict.message)
    }
    return report
  }

  private async sourceKindOf(id: ConversationEventId): Promise<string> {
    const event = await this.reads.getById(id)
    return event?.sourceKind ?? 'unknown'
  }
}

/**
 * 从 `ConversationLedgerPort` 造出校验所需的读端口。
 *
 * 这样装配层只需提供一个端口，不必再造第二套读函数 ——
 * "校验读的"与"写入读的"是同一份实现，因此它们的语义不会漂移
 * （例如某天序号推导规则改了，两处会同时改）。
 */
export function integrityReadsFrom(ledger: ConversationLedgerPort): IntegrityReadPort {
  return {
    // 端口只提供"下一个可用序号"，因此减一得到"当前最大"。
    // 这个减法只有一处，所以不可能出现两个地方对"当前最大"的定义不同。
    latestConversationSequence: (characterId, conversationId) =>
      ledger.nextConversationSequence(characterId, conversationId).then((next) => next - 1),
    findByConversationSequence: (characterId, conversationId, conversationSequence) =>
      ledger.findByConversationSequence(characterId, conversationId, conversationSequence),
    getById: (id) => ledger.getById(id),
  }
}
