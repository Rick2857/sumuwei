/**
 * Conversation 录制器 —— 真实消息 → ConversationEvent 的**唯一**入口。
 *
 * ============================================================================
 *  这是 Phase D 的 Adapter，而不是 Rewrite
 * ============================================================================
 * M1/M2 的消息仍写在 ElizaOS 的 `memories` 表里（RECENT_MESSAGES provider 靠它）。
 * 本文件**不拆**那条路径（Adapter > Migration > Rewrite），
 * 而是在旁边把同一件事写进事实账本：
 *
 *     用户消息 ──┬─► memories（旧路径，继续服务现有行为）
 *                └─► ConversationEvent（新账本，带 actor / 序号 / 来源）
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ M3 收口：写入必须经 ConversationLedgerPort（不再直调仓储）
 * ---------------------------------------------------------------------------
 * 这是 M3 自查时发现的一个**实质缺陷**的修复。
 *
 * 问题：M3 实现了 `ConversationLedgerPort`（四个具名写入方法）与
 * `ConversationIntegrityService`（四条完整性规则），但**运行期一条都没用**——
 * 本文件当年直接调 `appendConversationEvent`，于是：
 *
 *   · **悬空 reply 目标可以写进 append-only 账本**（实测：写入成功）
 *   · 会话内序号可以跳号（实测：1 → 50 写入成功）
 *   · 身份表运行期 0 行（只有验证脚本写过）
 *
 * 而测试之所以全绿，是因为它们测的是那个**从未被调用的类**。
 * 这正是"断言全绿但测的不是跑着的代码"——一类会让架构承诺与真实行为
 * 悄悄分叉的缺陷。
 *
 * 现在：所有写入都经端口 → 端口内做 reply graph 校验 → 序号连续性由本文件
 * 与端口共同保证。**失败关闭**：悬空 reply 直接抛错，而不是留在账本里
 * （账本 append-only，写错的来源永远撤不回来）。
 *
 * 硬规则（不变）：
 *   · 本文件**没有**修改或删除事件的函数
 *   · 事件顺序一律取自已分配的序号，不取"内存里的顺序"
 *   · dry-run（`--test`）下整个录制器是 no-op：测试对她等于没发生过
 */

import {
  KernelError,
  type ActorType,
  type CharacterId,
  type ConversationEvent,
  type ConversationEventId,
  type ConversationId,
  type ConversationLedgerPort,
  type DeliveryStatus,
} from '../../kernel/contracts/index.ts'
import type { ConversationAttributionProducer } from './conversation-attribution.ts'
import { createConversationLedger } from '../persistence/ledger.ts'
import { ensureUserIdentity, bindTransportIdentity } from '../persistence/identity-store.ts'
import { allocateSequenceRange } from '../persistence/sequence.ts'
import { latestConversationSequence } from '../persistence/conversation-store.ts'
import type { RawDb } from '../persistence/db.ts'
import type { ConversationLine } from '../../kernel/context/sections.ts'
import { ActorResolver } from './actor-resolver.ts'

/**
 * 逐消息平台身份输入（U1 / WP2b-2a，ADR-133 `D04`）。
 *
 * ⚠️ **只有 `externalId`（平台账号）是身份依据**；`displayName` 只影响显示名，
 *    绝不用来判定"是谁"。昵称 / 群名片 / 会话 ID / 自报身份都不在这个类型里 ——
 *    于是"拿昵称当身份"在**类型上**做不到（与 `kernel/identity/inbound-identity.ts` 同一条纪律）。
 */
export interface InboundIdentityInput {
  readonly externalId: string
  readonly displayName?: string
}

export interface ConversationRecorderOptions {
  db: RawDb
  characterId: CharacterId
  conversationId: ConversationId
  /** 干跑模式：所有录制调用都变成 no-op */
  dryRun: boolean
  /** 用户显示名（进上下文里的说话人；**不是**身份） */
  userName: string
  /** 角色显示名 */
  characterName: string
  /**
   * 渠道来源（如 cli / qq / harness）。
   *
   * ⚠️ M3 起它进 `metadata.transport` 而**不是** `metadata.source`：
   * "source" 这个词在 M3 已经被 `sourceKind`（事实类别）占用了，
   * 一个词两种含义是来源审计里最容易出错的地方。
   */
  transport?: string
  /**
   * 稳定用户身份（**领域身份**，不是 transport 身份）。
   *
   * ⚠️ 它**不是**用来推导的输入。曾经的实现把它当 externalId 再喂给
   * `deriveUserId`，于是 `stringToUuid('user-user-Alex')` 之类会算出一个
   * **新的** userId —— 身份表里出现一条与事件 actorId 不一致的行。
   * 那条错误很隐蔽：`conversation_identities` 有行（所以看着"落库了"），
   * 但 `user_identities` 里没有对应的人。
   *
   * 现在拆成两个字段：
   *   · `userRef`  —— transport 侧的身份（**推导的输入**），如 `'Alex'`
   *   · `userId`   —— 已经解析好的领域身份（**不做推导**，直接登记）
   *
   * 都不给时 `userRef` 退回 `userName`（CLI 下二者本来就是同一个东西）。
   */
  userId?: string
  /**
   * transport 侧的用户标识（推导 userId 的输入）。
   *
   * 与 `userId` 的区别见上：一个是"平台侧叫什么"，一个是"我们这边是谁"。
   * 计划书第 25 节要求二者不得混用 —— 而这里曾经混过。
   */
  userRef?: string
  /**
   * 身份解析器。给了它，用户身份就会在**每条用户消息**上被确保落库
   * （`user_identities` / `user_identity_mappings` / `conversation_identities`）。
   *
   * 为什么放在这里而不是单独一步：身份的存在性应当由**第一件真实发生的事**
   * 带出来，而不是靠某个"记得先注册"的初始化步骤 —— 后者会被遗忘，
   * 而遗忘的症状（身份表空着）在单用户下看不出来。
   */
  identityResolver?: ActorResolver
  /**
   * 用户 id 的**确定性推导规则**（`(transport, externalId) → userId`）。
   *
   * 没传 `identityResolver` 时，本文件用它**自己造一个** resolver
   * （挂在同一个 db 上）。这样"身份落库"对所有写入者都生效，
   * 而不是只对记得传 resolver 的那个生效。
   *
   * 缺省规则 = `deriveUserId ?? (input) => input.externalId`，
   * 即"把 externalId 原样当 userId"。CLI 传的是
   * `stringToUuid('user-Alex')` —— **与 M1/M2 的历史一致**，
   * 因此既有数据不会因为这次收口而分叉。
   */
  deriveUserId?: (input: { transport: string; externalId: string }) => string
  /**
   * **逐消息**身份解析（U1 / WP2b-2a，ADR-133 `D04`）。
   *
   * 给了它，`recordUserMessage(..., identity)` 才会按**平台账号**解析领域身份；
   * **不给** ⇒ 本文件与今天**逐字节相同**（永远走 `userId` / `userRef` 那条既有路径）。
   *
   * ⚠️ 传了 `identity` 却没有它 ⇒ **具名拒绝**
   *    （`inbound_identity_resolver_missing`）——**不**静默回退到配置里的单用户身份。
   */
  resolveInboundUserId?: (input: InboundIdentityInput) => Promise<string>
  /**
   * 记账端口（可选）。不传则用 `db` 现造一个。
   *
   * 允许注入是为了让"写入必须经端口"这条约束可以被测试直接验证，
   * 也为了让装配层能显式指定 transport 缺省值。
   */
  ledger?: ConversationLedgerPort
  /**
   * WP6.1（K-28）：**生产 ingress 的受信归因构造者**。
   *
   * 只有 `src/main.ts` 该传它，而且它只能由
   * `conversationAttributionForEntryMode()` 产出（见
   * `infrastructure/runtime/conversation-attribution.ts` 的文件头）。
   *
   * ⚠️ 不传 = legacy 写入路径（不写归因列）。测试夹具 / 迁移回填 / M3 评测
   * 都走这条缺省 —— 它们**不是**生产入口，而且它们要断言的是"由 actor_type
   * 推导出来的"旧值（例如 `USER_REPLY_CONFIRMATION`）。
   */
  attribution?: readonly ConversationAttributionProducer[]
}

export interface RecordedExchange {
  userEvent: ConversationEvent
  /** 用户事件与助手事件是否都真的写入了（dry-run / 幂等命中时为 false） */
  persisted: boolean
}

/** 写入结果：区分"真的写了" / "幂等命中" / "干跑没写" */
export interface RecordOutcome {
  event: ConversationEvent | undefined
  appended: boolean
  /** dry-run 下为 true；调用方据此跳过后续依赖事件的步骤 */
  skipped: boolean
}

export class ConversationRecorder {
  private readonly options: ConversationRecorderOptions
  private readonly ledger: ConversationLedgerPort
  /**
   * 身份解析器 —— **总有**一个（要么外部注入，要么这里现造）。
   *
   * 这个"总有"是刻意的：M3 自查发现身份表在运行期 0 行，
   * 原因正是"只有记得传 resolver 的调用方才写身份"。
   * 把它变成必需，遗忘就不再可能 —— 而遗忘的症状在单用户下看不出来。
   */
  private readonly resolver: ActorResolver
  /** 最近一次解析出来的显示名 */
  private resolvedDisplayName: string | undefined

  constructor(options: ConversationRecorderOptions) {
    this.options = options
    this.ledger =
      options.ledger ??
      createConversationLedger({
        db: options.db,
        defaultTransport: options.transport ?? 'cli',
        // WP6.1：把生产 ingress 传给账本（不传 = legacy 路径）
        ...(options.attribution !== undefined ? { attribution: options.attribution } : {}),
      })
    this.resolver =
      options.identityResolver ??
      new ActorResolver({
        db: options.db,
        // 缺省：externalId 原样当 userId。CLI 一定会显式传 deriveUserId
        // （`stringToUuid('user-Alex')`），因此这条缺省只服务于最小夹具。
        deriveUserId: options.deriveUserId ?? ((input) => input.externalId),
        defaultTransport: options.transport ?? 'cli',
      })
  }

  get conversationId(): ConversationId {
    return this.options.conversationId
  }

  get dryRun(): boolean {
    return this.options.dryRun
  }

  /** 渠道名（进 trace 的 message.normalize 属性） */
  get transport(): string {
    return this.options.transport ?? 'cli'
  }

  /**
   * 稳定用户身份。
   *
   * 若构造时只给了 resolver，这里会用它解析（并因此落一次身份表）——
   * 但**异步**：`userId` 因此可能是"还没解析过"时的兜底值。
   * 录制路径会先 `ensureIdentity()` 再写事件，所以写入时的身份一定是解析过的。
   */
  get userId(): string {
    return this.options.userId ?? this.resolvedDisplayName ?? this.options.userName
  }

  /** 用户显示名（解析器给出的优先于构造参数） */
  get userName(): string {
    return this.resolvedDisplayName ?? this.options.userName
  }

  /**
   * 确保身份落库（幂等）。**每条真实发生的消息都会走一次。**
   *
   * 做三件事：
   *   1. 解析 userId（经 `ActorResolver`；它同时负责落 user_identities
   *      与 user_identity_mappings）
   *   2. 落 `conversation_identities`，从而**同一个用户的两个会话**
   *      在数据上明确指向同一行 userId（计划书第 91 节的 Gate）
   *   3. 缓存显示名，供上下文里的说话人解析使用
   *
   * 为什么由"第一件真实发生的事"带出来，而不是靠一个初始化步骤：
   * 初始化步骤会被遗忘，而遗忘的症状（身份表空着）在单用户下看不出来 ——
   * M3 自查时它就是这样连续躲过了全部 48 项持久化验证。
   */
  async ensureIdentity(): Promise<string> {
    /*
     * 已经解析好的领域身份：**直接登记，不做推导**。
     *
     * 这条分支必须存在，而且必须不去调 `resolveUser` 的推导路径 ——
     * 把领域身份当成 transport 身份再推导一次会算出一个**新的人**
     * （实测踩到过：`user_identities` 0 行而 `conversation_identities` 1 行）。
     */
    if (this.options.userId) {
      return this.bindKnownIdentity({
        userId: this.options.userId,
        displayName: this.options.userName,
        ...(this.options.userRef === undefined ? {} : { externalId: this.options.userRef }),
      })
    }

    // 没有现成的领域身份 → 经 ActorResolver 推导（并落映射表）
    const resolved = await this.resolver.resolveUser({
      transport: this.transport,
      externalId: this.options.userRef ?? this.options.userName,
      displayName: this.options.userName,
    })
    this.resolvedDisplayName = this.options.userName

    await this.resolver.ensureConversation({
      conversationId: this.options.conversationId,
      characterId: String(this.options.characterId),
      userId: resolved.userId,
      label: `dm-${String(this.options.characterId).slice(0, 8)}`,
      transport: this.transport,
    })
    return resolved.userId
  }

  /**
   * 登记一个**已经解析好**的领域身份（`ensureIdentity` 与 `ensureIdentityFor` 共用）。
   *
   * 一个概念一处实现：两条路径的落库语义必须完全一致
   * （`user_identities` + 可选 `user_identity_mappings` + `conversation_identities`）。
   */
  private async bindKnownIdentity(input: {
    userId: string
    displayName?: string
    externalId?: string
  }): Promise<string> {
    const displayName = input.displayName ?? this.options.userName
    this.resolvedDisplayName = displayName
    await ensureUserIdentity(this.options.db, input.userId, displayName)

    /*
     * 有明确的 transport 身份时，把它**绑定**到这个已知的领域身份。
     *
     * 这一步不是多余的：它正是计划书第 25 节要的
     * `external_identity → Internal UserId` 映射。
     * 与"推导"的区别：这里**不猜** userId（它已经给了），只登记对应关系。
     * 绑定是 `on conflict do nothing`，因此一个 transport 身份永远不会改绑到别人。
     */
    if (input.externalId !== undefined) {
      await bindTransportIdentity(this.options.db, {
        transport: this.transport,
        externalId: input.externalId,
        userId: input.userId,
      })
    }

    await this.resolver.ensureConversation({
      conversationId: this.options.conversationId,
      characterId: String(this.options.characterId),
      userId: input.userId,
      label: `dm-${String(this.options.characterId).slice(0, 8)}`,
      transport: this.transport,
    })
    return input.userId
  }

  /**
   * **逐消息**身份登记（U1 / WP2b-2a）。
   *
   * 与 `ensureIdentity()` 的区别：身份来自**这一条消息的平台账号**，
   * 而不是进程级配置的单用户。
   *
   * 失败关闭三处（都不静默回退到 `options.userId`）：
   *   ① 装配层没给 `resolveInboundUserId` ⇒ `inbound_identity_resolver_missing`
   *   ② 平台账号为空                      ⇒ `inbound_identity_external_id_empty`
   *   ③ 解析器返回空 userId               ⇒ `inbound_identity_user_id_empty`
   */
  async ensureIdentityFor(input: InboundIdentityInput): Promise<string> {
    const resolve = this.options.resolveInboundUserId
    if (resolve === undefined) {
      throw new KernelError(
        'validation_error',
        'inbound_identity_resolver_missing',
        '调用方给了逐消息身份，但装配层没有提供 resolveInboundUserId —— ' +
          '失败关闭：**不**静默回退到配置里的单用户身份（那会把陌生人当成主人）'
      )
    }
    if (typeof input.externalId !== 'string' || input.externalId.trim() === '') {
      throw new KernelError(
        'validation_error',
        'inbound_identity_external_id_empty',
        '平台账号为空：没有任何身份依据（不猜、不回退）'
      )
    }
    const userId = await resolve(input)
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new KernelError(
        'validation_error',
        'inbound_identity_user_id_empty',
        `解析器对账号 ${input.externalId} 返回空 userId（不猜、不回退）`
      )
    }
    return this.bindKnownIdentity({
      userId,
      displayName: input.displayName ?? this.options.userName,
      externalId: input.externalId,
    })
  }

  /**
   * 录制用户消息。
   *
   * **预分配两个序号**：本次交互的用户事件与随后可能的助手事件。
   * 若助手事件最终没有产生（模型失败），那个序号就空着——
   * 序号允许有空洞（它是"发生过什么"的坐标，不是计数器），
   * 而这一点比"重排序号"安全得多。
   */
  async recordUserMessage(
    text: string,
    conversationSequence: number,
    imageRefs?: readonly string[],
    /**
     * U1 / WP2b-2a：**这条消息**的平台身份。给了它就必须有 `resolveInboundUserId`
     * （否则具名拒绝）；不给 ⇒ 与今天逐字节相同。
     */
    identity?: InboundIdentityInput
  ): Promise<{ event: ConversationEvent | undefined; assistantSequence: number | undefined }> {
    if (this.options.dryRun) return { event: undefined, assistantSequence: undefined }

    const userId = identity === undefined ? await this.ensureIdentity() : await this.ensureIdentityFor(identity)
    await this.assertSequenceContiguous(conversationSequence)

    const range = await allocateSequenceRange(this.options.db, this.options.characterId, 2)
    const outcome = await this.ledger.appendUserStatement({
      characterId: this.options.characterId,
      conversationId: this.options.conversationId,
      userId,
      content: text,
      conversationSequence,
      transport: this.transport,
      characterSequence: range.start,
      ...(imageRefs?.length ? { metadata: { imageRefs: [...imageRefs] } } : {}),
    })

    return { event: outcome.event, assistantSequence: range.end }
  }

  /**
   * 录制助手回复（引用它回复的那条用户事件）。
   *
   * M3：`replyToEventId` 在这里是**必须**的，因为计划书第 34 节说明得很清楚：
   * 没有 reply graph，用户一句"对。"在数据上无法理解"对什么"。
   * 端口会校验目标存在、同角色、同会话 —— 悬空引用**抛错**，不留进账本。
   */
  async recordAssistantMessage(input: {
    text: string
    conversationSequence: number
    characterSequence: number
    replyToEventId?: ConversationEventId
    traceId?: string
    modelProfile?: string
    /** 计划书第 37 节：默认 generated，transport 确认后再改成 delivered */
    deliveryStatus?: DeliveryStatus
  }): Promise<ConversationEvent | undefined> {
    const outcome = await this.recordAssistantMessageOutcome(input)
    return outcome.event
  }

  /** 同上的显式版本：调用方需要区分"真的写了"与"幂等命中"时用它 */
  async recordAssistantMessageOutcome(input: {
    text: string
    conversationSequence: number
    characterSequence: number
    replyToEventId?: ConversationEventId
    traceId?: string
    modelProfile?: string
    deliveryStatus?: DeliveryStatus
  }): Promise<RecordOutcome> {
    if (this.options.dryRun) return { event: undefined, appended: false, skipped: true }

    if (!input.replyToEventId) {
      throw new KernelError(
        'validation_error',
        'reply_target_required',
        'assistant_message 必须带 replyToEventId：否则无法回答"这条回复在回应什么"（计划书第 34 节）'
      )
    }
    // 每条真实发生的消息都确保一次身份落库（幂等）。
    // 放在 assistant 这条路径上也做，而不是只做 user 那条：
    // "身份一定存在"不应当依赖"恰好先写过一条用户消息"。
    await this.ensureIdentity()
    await this.assertSequenceContiguous(input.conversationSequence)

    const outcome = await this.ledger.appendCharacterOutput({
      characterId: this.options.characterId,
      conversationId: this.options.conversationId,
      characterIdAsActor: this.options.characterId,
      content: input.text,
      conversationSequence: input.conversationSequence,
      replyToEventId: input.replyToEventId,
      deliveryStatus: input.deliveryStatus ?? 'generated',
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.modelProfile ? { modelProfile: input.modelProfile } : {}),
      transport: this.transport,
      characterSequence: input.characterSequence,
    })
    return { event: outcome.event, appended: outcome.appended, skipped: false }
  }

  /** 系统事件（如"她等了三天没等到回复"这类由系统观测到的事实） */
  async recordSystemEvent(
    text: string,
    conversationSequence: number,
    metadata: Record<string, unknown> = {}
  ): Promise<ConversationEvent | undefined> {
    if (this.options.dryRun) return undefined
    await this.assertSequenceContiguous(conversationSequence)
    const outcome = await this.ledger.appendSystemEvent({
      characterId: this.options.characterId,
      conversationId: this.options.conversationId,
      source: 'system',
      content: text,
      conversationSequence,
      metadata: { transport: this.transport, ...metadata },
    })
    return outcome.event
  }

  /**
   * 工具返回（M3 第 11/85 节）。
   *
   * ⚠️ 它**不是**用户陈述。一条工具观测（"用户年龄 20"）可以支持
   * `TOOL_OBSERVATION`，但绝不能变成 `user_report` ——
   * M3 现在就把这条路径建好，是为了将来接 Tool 时不需要回头补历史数据
   * （append-only 意味着补不了）。
   */
  async recordToolOutput(
    toolName: string,
    text: string,
    conversationSequence: number,
    options: { replyToEventId?: ConversationEventId; metadata?: Record<string, unknown> } = {}
  ): Promise<ConversationEvent | undefined> {
    if (this.options.dryRun) return undefined
    await this.assertSequenceContiguous(conversationSequence)
    const outcome = await this.ledger.appendToolEvent({
      characterId: this.options.characterId,
      conversationId: this.options.conversationId,
      toolName,
      content: text,
      conversationSequence,
      ...(options.replyToEventId ? { replyToEventId: options.replyToEventId } : {}),
      metadata: { transport: this.transport, ...(options.metadata ?? {}) },
    })
    return outcome.event
  }

  /**
   * 确认送达（计划书第 37 节）。
   *
   * 唯一允许"改动"已存在事件的地方，而且它改的是**投递状态**，
   * 不是内容 —— 内容的 append-only 语义不受影响。
   */
  async confirmDelivery(eventId: ConversationEventId, status: DeliveryStatus): Promise<boolean> {
    if (this.options.dryRun) return false
    const { markDeliveryStatus } = await import('../persistence/conversation-store.ts')
    return markDeliveryStatus(this.options.db, eventId, status)
  }

  /** 最近事件（升序），供 Context 的 recent-conversation section 使用 */
  async recent(limit: number): Promise<ConversationEvent[]> {
    return this.ledger.listRecent({
      characterId: this.options.characterId,
      conversationId: this.options.conversationId,
      limit,
    })
  }

  /** 最近事件 × Context line（说话人名字在这里解析，领域层不知道用户叫什么） */
  async recentContextLines(limit: number): Promise<ConversationLine[]> {
    const events = await this.recent(limit)
    return events.map((event) => ({
      id: event.id,
      sequence: event.sequence,
      speaker: this.speakerOf(event),
      text: event.content,
      // M3：把类别与来源一起带进上下文，于是"谁说的"不再只靠显示名区分
      actorType: event.actorType,
      sourceKind: event.sourceKind,
    }))
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 会话内序号必须**连续 +1**。
   *
   * 为什么放在这里而不是只放进口：端口是通用记账口，它允许"回放/导入"
   * 这类按区间写入的场景；而**一轮真实对话**的语义是"说到第几句"，
   * 跳号会让它失去可读性（计划书第 78 节的四规则之一）。
   *
   * 若同一坐标已经写过，那是**幂等命中**，不是跳号 —— 放行，由端口回旧事件。
   */
  private async assertSequenceContiguous(incoming: number): Promise<void> {
    const currentMax = await latestConversationSequence(
      this.options.db,
      this.options.characterId,
      this.options.conversationId
    )
    if (incoming <= currentMax) return // 幂等命中，交给端口处理
    if (incoming > currentMax + 1) {
      throw new KernelError(
        'validation_error',
        'conversation_sequence_gap',
        `会话内序号出现空洞：当前最大 ${currentMax}，收到 ${incoming}。` +
          '会话内序号必须是可读的连续账（角色级序号才允许空洞）。'
      )
    }
  }

  private speakerOf(event: ConversationEvent): string {
    if (event.actorType === 'user') return this.userName
    if (event.actorType === 'character') return this.options.characterName
    if (event.actorType === 'tool') return event.actorId ?? '工具'
    return '系统'
  }
}

/**
 * 为一个已存在的用户事件补算它应有的权威等级。
 *
 * 计划书第 33 节的判定需要**读一次**被回复的事件，因此它不是纯函数。
 * 单独导出而不是塞进 recorder：测试与评测装置也需要用它，
 * 而它们不一定要实例化一个 recorder。
 *
 * 失败安全：目标事件读不到时**不提升**（保守方向），
 * 因为"把一条普通陈述误标成用户确认"会让 M4 形成错误的偏好记忆。
 */
export async function authorityUpgradeForReply(
  db: RawDb,
  replyToEventId: ConversationEventId | undefined
): Promise<ConversationEvent['sourceKind'] | undefined> {
  if (!replyToEventId) return undefined
  const { getConversationEvent } = await import('../persistence/conversation-store.ts')
  const target = await getConversationEvent(db, replyToEventId)
  if (!target) {
    throw new KernelError(
      'validation_error',
      'reply_target_missing',
      `replyToEventId=${String(replyToEventId)} 指向的事件不存在（reply graph 必须可解析）`
    )
  }
  return target.sourceKind
}

/** 供测试与诊断断言"这个 recorder 的写入确实走端口" */
export function ledgerOf(recorder: ConversationRecorder): ConversationLedgerPort {
  return (recorder as unknown as { ledger: ConversationLedgerPort }).ledger
}

export type { ActorType }
