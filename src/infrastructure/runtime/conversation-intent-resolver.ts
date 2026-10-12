/**
 * ConversationIntentResolver —— M3.5 **唯一**真正实现的 IntentResolver。
 *
 * ============================================================================
 *  计划书第 22 节：它就是"对话传输"的 Resolver
 * ============================================================================
 * ```text
 * SpeechIntent
 *       ↓
 * ConversationIntentResolver（本文件）
 *       ↓
 * ConversationRecorder → ConversationLedgerPort → 一条 assistant 事件
 * ```
 *
 * 它是 `IntentResolver`（`kernel/contracts/intent.ts`）的实现，住在
 * **适配器层**（计划书第 57 节：Observation/Intent 的 Adapter 应位于
 * 插件/Adapter 层，不要侵入 Runtime Core）。领域层只认识端口，不认识本文件。
 *
 * ---------------------------------------------------------------------------
 *  为什么"没写进去"必须抛，而不是返回 failed
 * ---------------------------------------------------------------------------
 * 两条路径必须分清，混起来会造成两种相反的事故：
 *
 *   ① **Fast Path 的落库失败**（reply 目标悬空、序号跳号、DB 报错）
 *      → **抛出**。因为"用户收到了回复但她的话没进账本"意味着
 *        事实账本与用户实际经历分叉，而账本是 append-only 的，事后再补
 *        也补不回"当时"那个顺序。M2.5 起这条路就是抛的，M3.5 不许改松。
 *
 *   ② **环境明确拒绝**（未来：门锁着）
 *      → 返回 `rejected`。这是**正常结果**，不是故障，
 *        而且必须以 Observation 的形式回到她那里（FC-03 / 计划书第 20 节）。
 *
 * 因此本 Resolver 只在"该类 intent 我处理不了"时返回 `rejected`，
 * 绝不用 `failed` 掩盖落库异常。
 *
 * ---------------------------------------------------------------------------
 *  为什么写入上下文在**构造时**绑定
 * ---------------------------------------------------------------------------
 * 端口签名是 `resolve(intent)`（计划书第 21 节），没有额外参数。
 * 而"这条回复写进哪个会话、第几号、回复谁"是每一轮才知道的事。
 * 把两者结合起来的方式是：**一轮一个 Resolver 实例**（`TurnGateway` 里现造）。
 *
 * 这样做还有一个好处：未来的 Environment Resolver 完全不需要知道
 * 我们的会话序号 —— 世界与对话的耦合只在装配处，不在端口上。
 */

import {
  KernelError,
  intentResolutionOf,
  speechPayloadOf,
  type CharacterIntent,
  type ConversationEvent,
  type ConversationEventId,
  type IntentResolution,
  type IntentResolver,
} from '../../kernel/contracts/index.ts'
import type { ConversationRecorder } from './conversation-recorder.ts'

export interface ConversationIntentResolverOptions {
  /** 唯一的写入入口（它内部走 ConversationLedgerPort） */
  recorder: ConversationRecorder
  /** 本轮回复在会话内的序号 */
  conversationSequence: number
  /**
   * 本轮被预分配的角色级序号（`recorder.recordUserMessage` 的返回值）。
   *
   * **必填**：序号是持久层原子分配的资源，绝不能由 Resolver 猜。
   * 曾经想过"缺省就用 conversationSequence"，但那会在某个没人注意的路径上
   * 悄悄发射一个角色级序号 —— 而序号空洞正是最难事后解释的数据形态。
   */
  characterSequence: number
  /** 这条回复在回应哪条事件（计划书第 34 节：assistant 事件必填） */
  replyToEventId?: ConversationEventId
  /** 本轮 trace id（进事件的 metadata，用于"这条回复属于哪一轮"） */
  traceId?: string
  modelProfile?: string
  /**
   * 本轮会话对应的稳定用户 id。
   *
   * 给了它之后，`SpeechIntent.payload.target` 会被**校验**：
   * `{ kind:'user', id }` 必须与它一致，否则拒绝。
   *
   * 为什么值得校验：`target` 如果只是装饰字段，那么"对谁说话"这件事
   * 在类型上有、在运行期没有 —— 而未来多角色场景下，把话发给错误的人
   * 是最严重的一类错误（它会把 A 的对话写进 B 的历史）。
   */
  targetUserId?: string
  /** 注入时钟（测试用；缺省 `Date.now`） */
  now?: () => number
}

export class ConversationIntentResolver implements IntentResolver {
  readonly name = 'conversation-intent-resolver'

  private readonly options: ConversationIntentResolverOptions

  constructor(options: ConversationIntentResolverOptions) {
    this.options = options
  }

  async resolve(intent: CharacterIntent): Promise<IntentResolution> {
    return (await this.resolveWithEvent(intent)).resolution
  }

  /**
   * 同上的**更详细版本**：额外把落库产生的那条事件交出来。
   *
   * 为什么端口上没有它（计划书第 21 节把签名定为 `resolve(intent)`）：
   * 端口是给未来的 Environment Resolver 共用的 —— 世界不需要、也不该
   * 产生我们的 `ConversationEvent`。而 **Trace 需要** `outputEventId`
   * （没有它就无法回答"这一轮最终写下了哪条事件"）。
   *
   * 因此：端口保持最小，实现暴露更多；装配处（`TurnGateway`）
   * 按"拿得到就拿、拿不到就只记 resolution"处理。
   */
  async resolveWithEvent(
    intent: CharacterIntent
  ): Promise<{ resolution: IntentResolution; event?: ConversationEvent }> {
    const now = this.options.now ?? Date.now
    const payload = speechPayloadOf(intent)

    /*
     * 只有 SPEECH 归本 Resolver 管。
     *
     * 返回 `rejected` 而不是抛错，是因为"路由不到处理器"在多 Resolver
     * 并存的世界里是**正常情况**（将来还有 Environment Resolver 接 ACTION）。
     * 但拒绝的理由写清楚，避免它被误读成"世界拒绝了她的请求"。
     */
    if (payload === undefined) {
      return {
        resolution: intentResolutionOf(intent.id, 'rejected', {
          reason: `unsupported_intent_type:${intent.type}`,
          resolvedAt: now(),
        }),
      }
    }

    // --- 收件人校验（失败关闭）---------------------------------------------
    const target = payload.target
    if (
      this.options.targetUserId !== undefined &&
      target !== undefined &&
      target.kind === 'user' &&
      String(target.id) !== this.options.targetUserId
    ) {
      return {
        resolution: intentResolutionOf(intent.id, 'rejected', {
          reason: 'speech_target_mismatch',
          resolvedAt: now(),
        }),
      }
    }

    /*
     * 落库。失败**故意不捕获** —— 见文件头的两条路径说明。
     * 干跑时 `recordAssistantMessageOutcome` 返回 skipped，什么也不写。
     */
    const outcome = await this.options.recorder.recordAssistantMessageOutcome({
      text: payload.text,
      conversationSequence: this.options.conversationSequence,
      characterSequence: this.options.characterSequence,
      ...(this.options.replyToEventId ? { replyToEventId: this.options.replyToEventId } : {}),
      ...(this.options.traceId ? { traceId: this.options.traceId } : {}),
      ...(this.options.modelProfile ? { modelProfile: this.options.modelProfile } : {}),
    })

    if (outcome.skipped) {
      /*
       * 干跑（`--test` / `--dry-run`）：没有事件可引用。
       *
       * 这里返回 `accepted` 且 `resultRefs` 为空，而不是编一个假的事件 id：
       *   · `accepted` 描述的是"这条 intent 被 Resolver 消费了"
       *   · `resultRefs` 空如实表示"没有产生任何持久结果"
       * 而且干跑**不写 trace**，因此不会留下一条看起来像真发生过的记录。
       */
      return {
        resolution: intentResolutionOf(intent.id, 'accepted', { resultRefs: [], resolvedAt: now() }),
      }
    }

    if (outcome.event === undefined) {
      // 非干跑路径上"没有事件"是不该发生的：如实标为 failed 而不是假装成功
      return {
        resolution: intentResolutionOf(intent.id, 'failed', {
          reason: 'assistant_event_missing_after_append',
          resolvedAt: now(),
        }),
      }
    }

    return {
      event: outcome.event,
      resolution: intentResolutionOf(intent.id, 'accepted', {
        // 幂等命中时 `appended === false`，但事件仍然存在 —— 因此 resultRefs
        // 一律指向那条事件，而不是"只有新写的才给引用"。
        resultRefs: [String(outcome.event.id)],
        resolvedAt: now(),
      }),
    }
  }
}

/** 便捷构造（装配处一行） */
export function createConversationIntentResolver(
  options: ConversationIntentResolverOptions
): ConversationIntentResolver {
  return new ConversationIntentResolver(options)
}

/** 该 Resolver 是否被正确接线（供测试与自检断言） */
export function assertResolverWired(resolver: ConversationIntentResolver): void {
  if (!resolver?.name) {
    throw new KernelError('validation_error', 'resolver_not_wired', 'ConversationIntentResolver 未装配')
  }
}
