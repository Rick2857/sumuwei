import { randomUUID } from 'node:crypto'
import { qqId, type QqPrivateConfig } from './private-config.ts'
import {
  BRIDGE_GROUP_TASK_DISPATCH_KEYS,
  QQ_DELIVERY_TEXT_MAX_CODEPOINTS,
  type BridgeGroupTaskDispatchInstruction,
  type BridgeWireResponse,
} from '../../kernel/app/bridge/turn-bridge.ts'
import { qqMediaSelectionOf } from '../../kernel/contracts/qq-media-reply.ts'
import {
  inspectWav,
  oneBotRecordFileUrl,
  QQ_VOICE_LIMITS,
  wavDeliveryProblem,
  type QqVoiceOutput,
  type QqVoiceSynthesisResult,
} from './voice-reply.ts'
import {
  sha256Bytes,
  sha256Text,
  type QqDeliveryJournalEntry,
  type QqDeliveryJournalPort,
  type QqDeliveryPurpose,
} from './voice-delivery-journal.ts'
import { IMAGE_INPUT_LIMITS, type ImageInput } from '../../kernel/contracts/image-input.ts'
import { checkImageInputs, downloadQqImage } from '../media/image-input.ts'
import { addressedByName, GroupContextBuffer, platformDisplayName, type GroupContextLine } from './group-context.ts'
import { GROUP_NAME_MAX_CODEPOINTS, type QqGroupListEntry } from './group-directory.ts'

type Submit = (request: {
  requestId: string
  userText: string
  images?: readonly ImageInput[]
  groupContext?: readonly GroupContextLine[]
  /**
   * **U1 / `ADR-138` · WP2b-2b 的前置（加性）**：这一轮的**入站平台事实**。
   *
   * ```text
   * ⚠️ 核心侧今天**还没有**消费它 ⇒ 带上它**不改变任何行为**（本客户端 L194-197 的
   *    "只收原主人包"那道结构性单用户闸**一个字未动**）。
   *    它的唯一作用是：等核心侧接上 `resolveInboundTurnScope` 时，事实已经在管线上。
   * ```
   */
  platformFacts?: {
    readonly transport: 'qq'
    readonly selfId: string
    readonly senderUserId: string
    readonly messageType: 'private' | 'group'
    readonly groupId?: string
    /**
     * 平台侧显示名（QQ：群名片优先，退回昵称；可选）。
     *
     * ⚠️ 它与 `senderUserId` **不是**同一类事实：身份仍只由 `senderUserId` 决定，
     *    这里只是"叫她怎么称呼对方"的展示用标签；缺席 ⇒ 核心退回 `QQ用户<id>`。
     *    形状已在 `platformDisplayName` 里收敛过（≤64 码点、无控制字符），
     *    因为桥对越界的显示名会**整条拒绝平台事实**。
     */
    readonly senderName?: string
  }
}) => Promise<BridgeWireResponse>
type Log = (reading: {
  event: string
  requestId?: string
  messageId?: string | number
  /**
   * 具名原因（post-Lv2 / P1：语音回落 / 结果不明 / 兜底）。
   *
   * ⚠️ 只放**原因码与结构读数**，不放正文、不放音频字节。
   */
  reason?: string
  /**
   * ADR-156 / P3-G：**这一条派发最终被平台接受了几条**对外消息（1 或 2）。
   *
   * ⚠️ 只数 `api_accepted`：`delivery_unknown` 的那一条**不计入**（"不知道发没发"不等于发过）。
   *    它存在的唯一理由：让门与人对账时能分清"2 条都对"与"1 条（附录被吞了）"，
   *    而不是只能数总的 `send_group_msg` 条数。
   */
  deliveredCount?: number
}) => void

/** 一条出站 QQ 消息段（闭集：text / record 两种；其余发送路径不变） */
type OutboundSegment = { type: 'text'; data: { text: string } } | { type: 'record'; data: { file: string } }

/* ------------------------------------------------------------------------- */
/* post-Lv2 / 群任务 P2：任务授权发送（全部**追加式**；旧路径不认识这些类型）   */
/* ------------------------------------------------------------------------- */

/** 群任务发送的**发送前复核**输入（群号 + 任务身份；断言"正是这个群 + 正是这个版本"） */
export interface QqGroupTaskAuthorizerInput {
  readonly groupId: string
  readonly taskId: string
  readonly taskVersion: number
  /**
   * 这一次发送的幂等键（装配层把它当作**实例 id**）。
   *
   * ⚠️ 复核要算"把这一条也算上之后还超不超额度"，就必须先把自己的预留从实例账本里
   *    剔除（见 `readSendOccupancyForRecheck`）。没有它只能退化成"只用已结算计数"，
   *    那会把在途/已明确失败的其它实例漏掉。缺省 ⇒ 调用方按旧口径兜底。
   */
  readonly deliveryKey?: string
}

/** 复核结果：`{ok:true}` 才放行；否则给出具名码（调用方如实回报，不改判） */
export type QqGroupTaskAuthorization = { readonly ok: true } | { readonly ok: false; readonly code: string }

/** 授权复核端口（由装配层注入；结果来自持久层任务事实，不来自模型载荷） */
export type QqGroupTaskAuthorizer = (input: QqGroupTaskAuthorizerInput) => Promise<QqGroupTaskAuthorization>

/** 一次任务授权群发送的入参（⚠️ `groupId` 来自任务授权事实，不来自模型参数） */
export interface QqGroupTaskSendInput {
  readonly groupId: string
  readonly taskId: string
  readonly taskVersion: number
  readonly media: 'text' | 'voice'
  readonly text: string
  /** 只有 `media === 'voice'` 才可能用到：已经合成好的 `base64://` 音频 */
  readonly recordFileUrl?: string
  /** 幂等稳定键（来自 `ActionRequest.idempotencyKey`；模型没有任何路径能写它） */
  readonly deliveryKey: string
}

/** 群任务发送的结局三态（与 `deliverProactiveText` 同一口径：**绝不**说"已送达"） */
export interface QqGroupTaskSendResult {
  readonly status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'
  readonly messageId?: string
  readonly reason?: string
}

/**
 * **本条派发**的结局 ＋ 一行对账读数（内部类型，不出外壳）。
 *
 * ⚠️ `deliveredCount` 只数**平台已接受**的对外消息（1 或 2）：
 *    门与人对账时它能分清"2 条都对"与"1 条（附录被吞了）"，
 *    而只数总的 `send_group_msg` 条数分不清这两件事。
 */
type CoreDispatchOutcome = QqGroupTaskSendResult & { readonly deliveredCount: number }

/**
 * 派发**正文那一条**的结局（P3-I：语音/文字两支共用同一个形状）。
 *
 * ⚠️ `deliveredCount` 只会是 `0` 或 `1`：正文就是一条（语音失败后的文字兜底是**替代**它，
 *    不是追加 —— 契约 §2 第 4 条"兜底不加条数"）。
 */
type CoreDispatchBody = CoreDispatchOutcome

/**
 * ⚠️ **唯一一条窄路径**的凭据。
 *
 * 只有 `deliverGroupTaskMessage` 在**发送前**向 `groupTaskAuthorizer` 复核通过之后
 * 才构造它；`sendSegments` 只有拿到"群号逐字相同 + 任务身份完整"的它才跳过
 * 静态群名单（`isAllowedUser`）。其它任何调用点都构造不出它（本文件私有类型）。
 */
interface GroupTaskSendAuthorization {
  readonly groupId: string
  readonly taskId: string
  readonly taskVersion: number
}

/* ------------------------------------------------------------------------- */
/* post-Lv2 / 群任务 P2.1-A：**群列表只读**（附加式；旧路径不认识这些类型）      */
/* ------------------------------------------------------------------------- */

/**
 * 群列表里的一条读数（定义在纯消歧模块 `group-directory.ts`，此处**转出**同一类型）。
 *
 * ⚠️ 群号统一成 `string`（OneBot v11 的 `group_id` 可能是数字也可能是字符串）；
 *   群名已 `trim` 且有界。**它只是"有哪些群"的读数，不表示"能在哪个群发"**。
 */
export type { QqGroupListEntry }

/**
 * 一次群列表读取的边界（超限**具名拒绝**，不静默截断后继续）。
 *
 * ⚠️ 上限按 `get_group_list` **回包原始条数**计（清理前）：平台回包是外部输入，
 *    "先解析再判断大小"本身就要先吃下整份载荷。
 */
export const QQ_GROUP_LIST_LIMITS = {
  /** 一次读取最多接受多少个群 */
  maxGroups: 200,
} as const

/**
 * ADR-156 / P3-B：`TURN_RESULT.groupTaskReply` 的**闭集**校验。
 *
 * ```text
 * 形状不对（缺键/多键/类型不对/群号非法/任务号空）⇒ undefined
 *   ⇒ 回落到旧静态群名单检查（**失败关闭**，不是"放行"）
 * ```
 *
 * ⚠️ 只接受这三个键：`groupId` / `taskId` / `taskVersion`。
 *    多一个键就整条作废，避免外壳被一个长得像的载荷骗过。
 */
function groupTaskReplyScopeOf(
  value: unknown
): { groupId: string; taskId: string; taskVersion: number } | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'groupId,taskId,taskVersion') return undefined
  const groupId = record.groupId
  const taskId = record.taskId
  const taskVersion = record.taskVersion
  const normalizedGroup = typeof groupId === 'string' ? qqId(groupId) : undefined
  if (normalizedGroup === undefined) return undefined
  if (typeof taskId !== 'string' || taskId.trim() === '') return undefined
  if (typeof taskVersion !== 'number' || !Number.isSafeInteger(taskVersion) || taskVersion < 1) return undefined
  return { groupId: normalizedGroup, taskId: taskId.trim(), taskVersion }
}

/* ------------------------------------------------------------------------- */
/* ADR-156 / P3-G：**核心派发的群任务发送**（策略 A：外壳不开库、不重判任务）    */
/* ------------------------------------------------------------------------- */

/**
 * 发送幂等表的上限（FIFO 淘汰；见 `deliverGroupTaskFromCore` 的检查 ④）。
 *
 * ⚠️ 有界是必须的：外壳是长驻进程，`deliveryKey` 是核心的实例 id，
 *    无界会成为一条只涨不落的泄漏；256 条覆盖"最近一分钟内的重派"绰绰有余。
 */
const QQ_GROUP_TASK_DISPATCH_MEMORY = 256

/**
 * "正在被回答的那条入站"这张表的上限（按群一条；最多记 32 个群，FIFO 淘汰）。
 *
 * ⚠️ 它只回答"这次派发该引用哪一条入站消息"，不放行任何东西。
 */
const QQ_GROUP_TASK_ACTIVE_INBOUND_MAX = 32

/**
 * 派发指令的**形状**（[检查 ①]{@link coreDispatchInstructionOf}）。
 *
 * ⚠️ `groupId` 在这里只做**类型**校验；它**能不能解析成 QQ 号**属于检查 ②
 *    （`group_task_dispatch_bad_target`）—— 两个失败码各管一段，不混。
 */
interface CoreDispatchInstruction {
  readonly deliveryKey: string
  readonly groupId: string
  readonly taskId: string
  readonly taskVersion: number
  readonly text: string
  readonly media: 'text' | 'voice'
  readonly quoteMessageId?: string
  readonly textFallback?: boolean
  /**
   * 语音回复的**来源附录**（可选；纯文字、单独一条）。
   *
   * ⚠️ 为什么要它单独一个字段而不是塞在 `text` 里：记录 §7.8 的计数口径是
   *    「正文、附录、兜底**都计数**」⇒ 语音 + 附录 = **2 条**对外消息。
   *    一条指令只有一个 `text`，而派发这条出口发完正文就结束了
   *    （`TURN_RESULT` 不再带 `mediaAppendix`）⇒ 没有这第二个出口，附录会被**静默吞掉**，
   *    而账本上还写着 2 条。
   */
  readonly appendixText?: string
  readonly reservedMessages: number
  readonly expiresAt: number
}

/**
 * **检查 ①：形状**（命中即失败、**一条也不发**，码 `group_task_dispatch_malformed`）。
 *
 * ```text
 * 键集合**恰好**是闭集    —— 多一个键整条作废（不是"取能认的字段"）
 * 必填键齐全             —— `quoteMessageId` / `textFallback` / `appendixText` 可缺席，
 *                           其余缺一个就作废
 * 类型与上界             —— 正文与附录均非空且 ≤ 500 码点、`media ∈ {text,voice}`、
 *                           `taskVersion` ≥1 安全整数、`reservedMessages` 1..3、
 *                           `expiresAt` 有限数
 * ```
 *
 * ⚠️ 闭集键表与正文上界都**直接 import 桥的那一份**（`BRIDGE_GROUP_TASK_DISPATCH_KEYS`
 *  / `QQ_DELIVERY_TEXT_MAX_CODEPOINTS`）：这条链上两边各写一份迟早漂移，
 *    而漂移的代价是**多发一条群消息**。
 * ⚠️ 只回**一个**具名码：哪一格坏了进日志读数（`reason` 仍是同一个码，细节不外泄），
 *    回执是给核心结算用的 —— 多一个字段就是多一个会漂移的判据。
 * ⚠️ 取值**原样保留**（不 trim）：`deliveryKey` 是核心实例 id，改一个字符就再也对不上号。
 */
function coreDispatchInstructionOf(
  value: unknown
): { ok: true; instruction: CoreDispatchInstruction } | { ok: false; reason: string } {
  const malformed = { ok: false as const, reason: 'group_task_dispatch_malformed' }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return malformed
  const record = value as Record<string, unknown>
  /*
   * ⚠️ 判据是"**每个键都在闭集内**"，不是"键集合与闭集逐字相等"：
   *    `quoteMessageId` / `textFallback` 允许缺席，逐字相等的比较会把**合法**指令也判死。
   *    多一个键 ⇒ 立刻作废（这一步），少一个必填键 ⇒ 下面的类型检查判死。
   */
  for (const key of Object.keys(record)) {
    if (!BRIDGE_GROUP_TASK_DISPATCH_KEYS.includes(key)) return malformed
  }
  const deliveryKey = record.deliveryKey
  const groupId = record.groupId
  const taskId = record.taskId
  const taskVersion = record.taskVersion
  const text = record.text
  const media = record.media
  const quoteMessageId = record.quoteMessageId
  const textFallback = record.textFallback
  const appendixText = record.appendixText
  const reservedMessages = record.reservedMessages
  const expiresAt = record.expiresAt
  if (typeof deliveryKey !== 'string' || deliveryKey.trim() === '') return malformed
  if (typeof groupId !== 'string' || groupId.trim() === '') return malformed
  if (typeof taskId !== 'string' || taskId.trim() === '') return malformed
  if (typeof taskVersion !== 'number' || !Number.isSafeInteger(taskVersion) || taskVersion < 1) return malformed
  if (typeof text !== 'string' || text.trim() === '' || [...text].length > QQ_DELIVERY_TEXT_MAX_CODEPOINTS) {
    return malformed
  }
  if (media !== 'text' && media !== 'voice') return malformed
  if (quoteMessageId !== undefined && typeof quoteMessageId !== 'string') return malformed
  if (textFallback !== undefined && typeof textFallback !== 'boolean') return malformed
  /*
   * 附录的形状与正文**同一口径**（空串也算坏值：桥侧先拒一次 `group_task_dispatch_bad_appendix`，
   * 这里是第二道）。上界复用同一个 500 码点常量。
   */
  if (appendixText !== undefined
    && (typeof appendixText !== 'string' || appendixText.trim() === ''
      || [...appendixText].length > QQ_DELIVERY_TEXT_MAX_CODEPOINTS)) return malformed
  if (typeof reservedMessages !== 'number' || !Number.isSafeInteger(reservedMessages)
    || reservedMessages < 1 || reservedMessages > 3) return malformed
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return malformed
  return {
    ok: true,
    instruction: {
      deliveryKey,
      groupId,
      taskId,
      taskVersion,
      text,
      media,
      ...(quoteMessageId === undefined ? {} : { quoteMessageId }),
      ...(textFallback === undefined ? {} : { textFallback }),
      ...(appendixText === undefined ? {} : { appendixText }),
      reservedMessages,
      expiresAt,
    },
  }
}

/** 从任意载荷里取一个**可对账**的 `deliveryKey`（只为读数；取不到就不编一个） */
function coreDispatchKeyOf(value: unknown): string | undefined {
  const key = (value as { deliveryKey?: unknown } | null | undefined)?.deliveryKey
  return typeof key === 'string' && key !== '' ? key : undefined
}

/** 单帧 ws 事件的字节上限（ADR-156 / P3-E：100 KB → 1 MB；超限**记读数**而非静默丢弃） */
const MAX_WS_FRAME_BYTES = 1_000_000

/** Native Node 22 WebSocket, closed OneBot actions and program-verified admission. */
export class OneBotPrivateClient {
  private socket: WebSocket | undefined
  private verified = false
  private stopping = false
  private queue = Promise.resolve()
  private queued = 0
  private readonly seen = new Set<string>()
  private readonly groupBuffer = new GroupContextBuffer()
  private readonly groupContextConsumed = new Map<string, Set<string>>()
  private readonly pendingGroupTurns = new Map<string, {
    parts: string[]; line: GroupContextLine; until: number; deadline: number
  }>()
  private readonly groupReplies = new Map<string, Set<string>>()
  /**
   * ADR-156 / P3-G：**正在被回答的那条入站**（按群、有界；原生引用的**唯一**依据）。
   *
   * ```text
   * 记什么 —— `receive()` 里已经校验过的**入站 message_id**（裸 id，不是 requestId）+ 它的 requestId
   * 何时记 —— 只在 `await submit(...)` 的**在途窗口内**（设 → 等核心 → `finally` 清）
   * 用途   —— 只有一个：核心派发的这条回复要不要带 `{type:'reply'}` 引用段
   * 不做什么 —— 不放行任何东西、不参与准入、不替代 `seen`（`seen` 存的是 requestId）
   * ```
   *
   * ⚠️ **为什么由外壳自持**：核心拿不到可信的 QQ 入站 id
   *    （`platformFactsProblems` 对 `transport==='qq'` 明确禁止 `messageId`）
   *    ⇒ 引用只能由**校验过入站**的那一侧补，模型与核心都给不出。
   * ⚠️ 按**群**存而不是一个全局单槽：不同群/不同会话的轮次可以并发，
   *    全局单槽会被另一个群的在途轮次覆盖 ⇒ 引用到错的群的消息。
   * ⚠️ 同一群只留**一条**：同会话轮次本来就是串行的（`this.queue`），
   *    留一条正好是"正在被回答的那一条"。
   */
  private readonly activeInbounds = new Map<string, { requestId: string; messageId: string }>()
  /**
   * ADR-156 / P3-G：**发送幂等表**（`deliveryKey` ⇒ 首次结局的 promise，有界 FIFO）。
   *
   * ⚠️ 存的是 **promise** 而不是结果：同一个键**并发**到达时，第二条要等到**同一个结局**，
   *    而不是在第一条还在飞的时候又发一次。
   */
  private readonly coreDispatches = new Map<string, Promise<QqGroupTaskSendResult>>()
  private readonly lastAccepted = new Map<string, number>()
  private readonly userQueued = new Map<string, number>()
  private readonly groupQueued = new Map<string, number>()
  private readonly revokedGroups = new Set<string>()
  private readonly groupEpochs = new Map<string, number>()
  private readonly pending = new Map<string, {
    resolve: (data: Record<string, unknown>) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(
    private readonly config: QqPrivateConfig,
    private readonly submit: Submit | undefined,
    private readonly log: Log,
    /**
     * post-Lv2 / P1：**语音输出端口**（可选；不传 = 这个外壳没有合成能力）。
     *
     * ⚠️ 可选是刻意的：不装端口时，"她选了语音"会**如实**回落到文字并记
     *    `voice_output_absent`，而不是假装发过语音、也不是把稿子念错。
     */
    private readonly voice: QqVoiceOutput | undefined = undefined,
    /**
     * post-Lv2 / P2：**持久化投递日志**（可选；生产外壳在协议打开时必装）。
     *
     * ⚠️ 不传 = P1 的"无跨重启去重"行为（读数会记 `qq_delivery_journal_absent`）。
     * ⚠️ 传了但不可读/不可写 ⇒ 语音一律回落文字（`delivery_journal_unavailable`）；
     *    文字路径保持旧行为，只记录"去重不可用"。
     */
    private readonly journal: QqDeliveryJournalPort | undefined = undefined,
    /**
     * post-Lv2 / 群任务 P2：**任务授权复核端口**（可选；不传 = 这个外壳没有
     * 群任务发送能力 —— 调 `deliverGroupTaskMessage` 会如实失败，不会改用别的路径）。
     *
     * ⚠️ 这个端口是"群号可以来自任务事实"的**唯一**依据：不传它，静态群名单
     *    （`isAllowedUser`）就是唯一准入，旧行为逐字不变。
     */
    private readonly groupTaskAuthorizer: QqGroupTaskAuthorizer | undefined = undefined,
    /**
     * ADR-156 / P3-B：**群入站准入交给核心**（可选；缺省 `false` ⇒ 逐字旧行为）。
     *
     * ```text
     * 旧行为（false）：外壳收到群消息先按**静态群名单 + 成员核验**过滤，不合格就丢
     * 打开（true）   ：外壳只做**结构性校验**（群号/发送者/文本/图片/限流），
     *                  准入判定交给核心（`decideGroupAdmission` + `decideInboundRouting`）
     * ```
     *
     * ⚠️ 为什么必须这样：方案 §5 要求"**先看生效任务，再看旧名单**"。外壳不开库
     *    ⇒ 它判不了任务；在外壳就把消息丢掉，核心永远等不到"这条该由任务接管"的机会。
     *    P3-A 只接好了核心侧，外壳侧这一刀是 P3-B 补的。
     * ⚠️ 它**只影响入站**：出站仍是旧静态名单（旧回复路径）或任务授权窄路径
     *    （`deliverGroupTaskMessage` / 任务接管轮的回复），两条都不放宽。
     */
    private readonly deferGroupAdmissionToCore = false,
  ) {
    /*
     * 重启收尾：把遗留 `reserved` 追加成 `unknown_after_restart`。
     * ⚠️ 遗留"发送中"**不重播**；同一逻辑键再次入站会被 `reserve` 判重复而跳过。
     */
    if (journal !== undefined) {
      try {
        const recovered = journal.recover()
        if (recovered > 0) this.log({ event: 'qq_delivery_recovered_unknown', reason: `recovered=${recovered}` })
      } catch (error) {
        this.log({ event: 'qq_delivery_journal_unavailable', reason: error instanceof Error ? error.message : 'recover_failed' })
      }
    }
  }

  /**
   * ADR-156 / P3-B：**正在投递的这一条回复**若属于"群任务接管轮"，这里放它的任务身份。
   *
   * ⚠️ 值只来自**桥的 `TURN_RESULT.groupTaskReply`**（核心按持久层任务判定后给的事实），
   *    外壳不自己猜、也不接受模型载荷。
   * ⚠️ 它只在一次 `deliverTurnReply` 期间有效（结束后立刻清空），且群号必须与目标逐字相同
   *    才跳过静态群名单 —— 与 `deliverGroupTaskMessage` 的窄路径同一条纪律。
   * ⚠️ `quoteMessageId` 是**这一条入站的** OneBot `message_id`（`receive()` 里已校验过的
   *    那个值），用于方案 §7.1 的**原生引用回复**；它同样只在这条回复期间有效。
   */
  private replyTaskScope?: { groupId: string; taskId: string; taskVersion: number; quoteMessageId?: string }

  /**
   * ADR-156 / P3-G：**正在投递的这一条**由核心派发的群任务（`sendSegments` 的第三条窄路径凭据）。
   *
   * ```text
   * 挂上  —— 只在 `deliverGroupTaskFromCore` 的**发送期间**（`coreDispatchSend` 里）
   * 清掉  —— `finally`（异常路径也必须清：否则下一条回复会被它放行）
   * 缺席  —— 旧调用点永远看不到它 ⇒ `sendSegments` 的旧判据逐字不变
   * ```
   *
   * ⚠️ `quoteMessageId` 是**已经对上白名单**的那个入站 id（见 `coreDispatchQuote`）；
   *    对不上的引用**不会**被放进这里 ⇒ 伪造/跨群的引用段构造不出来。
   */
  private coreDispatchScope?: { groupId: string; taskId: string; taskVersion: number; quoteMessageId?: string }


  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) throw new Error('onebot_already_connected')
    const url = new URL(this.config.wsUrl)
    url.searchParams.set('access_token', this.config.token)
    const socket = this.socket = new WebSocket(url)
    this.verified = false
    socket.addEventListener('message', (event) => {
      /*
       * ADR-156 / P3-E：`receive()` **之前**这五处也全是静默 `return`。
       *
       * ```text
       * 真实链路实测：LLBot 上报 119 条、我们只收到 41 条（送达率 31%）
       *   ⇒ 而 receive() 内部 24 处早已全部具名 —— 说明丢在这一段
       * 从这里起每一处都留 `qq_ws_frame_dropped{reason}`。
       * ```
       */
      if (this.socket !== socket) {
        return this.log({ event: 'qq_ws_frame_dropped', reason: 'stale_socket' })
      }
      if (typeof event.data !== 'string') {
        return this.log({ event: 'qq_ws_frame_dropped', reason: 'non_text_frame' })
      }
      /*
       * ⚠️ 上限从 **100 KB 提到 1 MB**：大群里带图片/卡片/长文的事件 JSON 很容易过 100 KB，
       *    旧行为是**静默丢弃**（不是截断）⇒ 送达率被它吃掉是合理怀疑，且 1 MB 仍远小于
       *    Node 单帧的常见内存界限。
       */
      if (event.data.length > MAX_WS_FRAME_BYTES) {
        return this.log({ event: 'qq_ws_frame_dropped', reason: `too_large:${event.data.length}` })
      }
      let packet: Record<string, unknown>
      try { packet = JSON.parse(event.data) } catch {
        return this.log({ event: 'qq_ws_frame_dropped', reason: 'bad_json' })
      }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
        return this.log({ event: 'qq_ws_frame_dropped', reason: 'bad_shape' })
      }
      if (typeof packet.echo === 'string') {
        const pending = this.pending.get(packet.echo)
        if (!pending) return this.log({ event: 'qq_ws_frame_dropped', reason: 'unknown_echo' })
        clearTimeout(pending.timer)
        this.pending.delete(packet.echo)
        if (packet.status === 'ok' && packet.retcode === 0 && packet.data && typeof packet.data === 'object') {
          pending.resolve(packet.data as Record<string, unknown>)
        } else pending.reject(new Error('onebot_api_failed'))
        return
      }
      this.receive(packet, socket)
    })
    const disconnect = (): void => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.verified = false
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('onebot_disconnected'))
      }
      this.pending.clear()
      this.log({ event: 'onebot_disconnected' })
      if (socket.readyState !== WebSocket.CLOSED) socket.close()
    }
    socket.addEventListener('close', disconnect)
    socket.addEventListener('error', disconnect)
    try {
      await new Promise<void>((done, reject) => {
        const finish = (error?: Error): void => {
          clearTimeout(timer)
          socket.removeEventListener('error', fail)
          socket.removeEventListener('close', fail)
          socket.removeEventListener('open', open)
          if (error) reject(error)
          else done()
        }
        const timer = setTimeout(() => finish(new Error('onebot_connect_timeout')), 10_000)
        const fail = (): void => finish(new Error('onebot_connect_failed'))
        const open = (): void => finish()
        socket.addEventListener('error', fail, { once: true })
        socket.addEventListener('close', fail, { once: true })
        socket.addEventListener('open', open, { once: true })
      })
      const login = await this.call('get_login_info', {})
      if (qqId(login.user_id) !== this.config.botId) throw new Error('onebot_bot_account_mismatch')
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('onebot_disconnected')
      this.verified = true
      this.log({ event: 'onebot_owner_private_ready' })
    } catch (error) { disconnect(); throw error }
  }

  get connected(): boolean { return this.verified && this.socket?.readyState === WebSocket.OPEN }

  private call(action: 'get_login_info' | 'send_private_msg' | 'send_group_msg' | 'get_group_member_info' | 'get_image' | 'get_group_list', params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('onebot_not_connected'))
    const echo = randomUUID()
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('onebot_api_timeout')) }, 10_000)
      this.pending.set(echo, { resolve: done, reject, timer })
      socket.send(JSON.stringify({ action, params, echo }))
    })
  }

  async isAllowedUser(userId: string, groupId?: string): Promise<boolean> {
    if (userId === this.config.botId || qqId(userId) === undefined) return false
    if (groupId === undefined && userId === this.config.ownerId) return true
    if (!this.config.multiUserEnabled || !this.connected) return false
    const groups = groupId === undefined ? this.config.allowedGroupIds ?? [] :
      (this.config.allowedGroupIds?.includes(groupId) ? [groupId] : [])
    for (const id of groups) {
      if (this.revokedGroups.has(id)) continue
      try {
        const bot = await this.call('get_group_member_info', { group_id: id, user_id: this.config.botId, no_cache: true })
        if (qqId(bot.user_id) !== this.config.botId || qqId(bot.group_id) !== id) continue
        const member = await this.call('get_group_member_info', { group_id: id, user_id: userId, no_cache: true })
        if (qqId(member.user_id) === userId && qqId(member.group_id) === id) return true
      } catch { /* Missing membership or unavailable platform never grants access. */ }
    }
    return false
  }

  /**
   * **只读**读取机器人当前所在的群列表（post-Lv2 / 群任务 P2.1-A）。
   *
   * ============================================================================
   *  它做什么 / 不做什么
   * ============================================================================
   * ```text
   * 只发一个 `get_group_list` 请求
   *   ⇒ **不发任何消息段**（无 send_private_msg / send_group_msg）
   *   ⇒ **不占用发送队列**（不碰 `this.queue` / `this.queued` / `lastAccepted`）
   *   ⇒ 不写 `groupReplies`、不写投递日志、不做任何"发送"记账
   *
   * 群号统一成 string（`qqId` 同时认数字与字符串回包），逐条校验
   * 群名 trim；空名 / 非字符串 / 超过 64 个码点 ⇒ **整条丢弃并计读数**
   * 重复群号 ⇒ 保留首条、其余丢弃并计读数
   * 回包 `data` 不是数组 ⇒ `qq_group_list_invalid`
   * 回包原始条数 > 200 ⇒ `qq_group_list_too_large`（不截断后继续）
   *
   * ⚠️ **不**看 `allowedGroupIds`、**不**读 `multiUserEnabled`、**不**查成员身份、
   *    **不**做任何放行决定 —— 读出"有哪些群"**不等于**"能在哪个群发"。
   *    本方法的存在只为给**消歧**（`group-directory.ts`）提供"当前可见群"事实；
   *    能不能发仍然只由任务授权（`deliverGroupTaskMessage`）与静态名单（旧路径）决定。
   * ```
   *
   * ⚠️ 失败一律具名（`onebot_not_connected` / `qq_group_list_invalid` /
   *    `qq_group_list_too_large` / 底层 `call()` 的既有码），**不返回空数组**冒充成功。
   */
  async listGroups(): Promise<readonly QqGroupListEntry[]> {
    if (!this.connected) {
      this.log({ event: 'qq_group_list_failed', reason: 'onebot_not_connected' })
      throw new Error('onebot_not_connected')
    }
    let raw: unknown
    try {
      raw = await this.call('get_group_list', {})
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_group_list_failed'
      this.log({ event: 'qq_group_list_failed', reason: code })
      throw new Error(code)
    }
    /* 真实 OneBot v11 的 `get_group_list` 回包是 `data: [...]`（本文件 `call()` 原样返回） */
    if (!Array.isArray(raw)) {
      this.log({ event: 'qq_group_list_failed', reason: 'qq_group_list_invalid' })
      throw new Error('qq_group_list_invalid')
    }
    /* 上限按**原始条数**（清理前）计：不先解析整份平台载荷再判大小 */
    if (raw.length > QQ_GROUP_LIST_LIMITS.maxGroups) {
      this.log({ event: 'qq_group_list_failed', reason: `qq_group_list_too_large:${raw.length}` })
      throw new Error('qq_group_list_too_large')
    }
    const entries: QqGroupListEntry[] = []
    const seen = new Set<string>()
    let dropped = 0
    const drop = (reason: string): void => {
      dropped += 1
      this.log({ event: 'qq_group_list_entry_dropped', reason })
    }
    for (const item of raw) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) { drop('not_object'); continue }
      const record = item as Record<string, unknown>
      const groupId = qqId(record.group_id)
      if (groupId === undefined) { drop('bad_group_id'); continue }
      const name = record.group_name
      if (typeof name !== 'string') { drop('bad_group_name'); continue }
      const groupName = name.trim()
      if (groupName === '' || [...groupName].length > GROUP_NAME_MAX_CODEPOINTS) { drop('bad_group_name'); continue }
      if (seen.has(groupId)) { drop('duplicate_group_id'); continue }
      seen.add(groupId)
      entries.push({ groupId, groupName })
    }
    /*
     * 读数：原始条数 / 采用条数 / 丢弃条数。
     * ⚠️ 丢弃**不静默**：每一条都有自己的 `qq_group_list_entry_dropped` + 具名 reason。
     */
    this.log({ event: 'qq_group_list_read', reason: `raw=${raw.length};groups=${entries.length};dropped=${dropped}` })
    return entries
  }

  private async sendText(text: string, socket: WebSocket,
    target: { userId: string; groupId?: string } = { userId: this.config.ownerId },
    groupTaskAuthorization?: GroupTaskSendAuthorization, quoteMessageId?: string): Promise<string | number> {
    return await this.sendSegments([{ type: 'text', data: { text } }], socket, target, groupTaskAuthorization, quoteMessageId)
  }

  /**
   * 发一条**语音**消息段（post-Lv2 / P1 的 P2 侧最小接点）。
   *
   * ⚠️ 走 `base64://`：不暴露宿主/容器路径、不开公开下载口。
   * ⚠️ 与文字发送**同一条**身份检查、队列与 messageId 校验（不是第二条发送路径）。
   */
  private async sendRecord(fileUrl: string, socket: WebSocket,
    target: { userId: string; groupId?: string } = { userId: this.config.ownerId },
    groupTaskAuthorization?: GroupTaskSendAuthorization, quoteMessageId?: string): Promise<string | number> {
    if (!fileUrl.startsWith('base64://') || fileUrl.length > QQ_VOICE_LIMITS.maxAudioBytes * 6) {
      throw new Error('qq_record_unexpected_file')
    }
    return await this.sendSegments([{ type: 'record', data: { file: fileUrl } }], socket, target, groupTaskAuthorization, quoteMessageId)
  }

  private async sendSegments(segments: readonly OutboundSegment[], socket: WebSocket,
    target: { userId: string; groupId?: string } = { userId: this.config.ownerId },
    groupTaskAuthorization?: GroupTaskSendAuthorization, quoteMessageId?: string): Promise<string | number> {
    if (!this.connected || this.socket !== socket) throw new Error('qq_delivery_disconnected')
    /*
     * ⚠️ **唯一一条窄路径**（post-Lv2 / 群任务 P2）：
     * 只有 `deliverGroupTaskMessage` 在**发送前**向 `groupTaskAuthorizer` 复核通过、
     * 并且凭据里的群号与本次目标**逐字相同**时才跳过下面的静态群名单；
     * 旧调用点都不传第 4 个参数 ⇒ `authorizedGroupTask === false` ⇒ 旧检查**逐字不变**。
     * 群号仍然只来自任务授权事实；载荷提供不了群号（能力层参数闭集 + 黑名单）。
     */
    const authorizedByTask = groupTaskAuthorization !== undefined
      && target.groupId !== undefined
      && groupTaskAuthorization.groupId === target.groupId
      && groupTaskAuthorization.taskId.trim() !== ''
      && Number.isSafeInteger(groupTaskAuthorization.taskVersion)
      && groupTaskAuthorization.taskVersion >= 1
    /*
     * ADR-156 / P3-B：**任务接管轮的回复**（与上面那条任务派发窄路径同一个判据形状）。
     *
     * ⚠️ 任务身份来自桥的 `TURN_RESULT.groupTaskReply`（核心已按任务路由判过），
     *    群号仍必须与本次目标**逐字相同**；不满足 ⇒ 回落旧静态名单。
     */
    const replyTask = this.replyTaskScope
    const authorizedByReplyTask = replyTask !== undefined
      && target.groupId !== undefined
      && replyTask.groupId === target.groupId
      && replyTask.taskId.trim() !== ''
      && Number.isSafeInteger(replyTask.taskVersion)
      && replyTask.taskVersion >= 1
    /*
     * ADR-156 / P3-G：**核心派发的群任务发送** —— 第三条窄路径，与上面两条**完全同形**。
     *
     * ```text
     * 群号必须与本次目标**逐字相同**（不能"顺手发到别的群"）
     * 任务身份必须完整（非空 taskId + 版本 ≥1 安全整数）
     * 不满足 ⇒ 回落下面的旧静态群名单（**不是**放行）
     * 旧调用点不挂 `coreDispatchScope` ⇒ `authorizedByCoreDispatch === false` ⇒ 旧行为逐字不变
     * ```
     * ⚠️ 三条窄路径都只放宽**旧静态群名单**这一道，成员核验之外的任何东西都不碰。
     */
    const coreDispatch = this.coreDispatchScope
    const authorizedByCoreDispatch = coreDispatch !== undefined
      && target.groupId !== undefined
      && coreDispatch.groupId === target.groupId
      && coreDispatch.taskId.trim() !== ''
      && Number.isSafeInteger(coreDispatch.taskVersion)
      && coreDispatch.taskVersion >= 1
    if (!authorizedByTask && !authorizedByReplyTask && !authorizedByCoreDispatch
      && !await this.isAllowedUser(target.userId, target.groupId)) {
      throw new Error('qq_target_no_longer_authorized')
    }
    /*
     * 方案 §7.1：**任务接管轮**的回复带上原生引用段（`{type:'reply', data:{id}}`）。
     *
     * ```text
     * 引用目标 —— 只来自 `receive()` 里校验过的入站 message_id（真实入站绑定）
     * 生效范围 —— 只在 `authorizedByReplyTask` 成立时（任务接管轮 + 群号逐字相同）
     * 额外额度 —— 无：它与正文在**同一次** send_group_msg 里（不是第二条消息）
     * ```
     *
     * ⚠️ 关掉引用 = 不传 scope 或缺 `quoteMessageId` ⇒ 逐字旧行为（无引用段）。
     * ⚠️ 第三条窄路径（核心派发）的引用目标已经在上游对上白名单（`coreDispatchQuote`），
     *    这里只做同一道形状兜底；两条窄路径互斥（一次发送只会是其中一条）。
     */
    const quote = authorizedByReplyTask ? replyTask!.quoteMessageId
      : authorizedByCoreDispatch ? coreDispatch!.quoteMessageId
      : (target.groupId !== undefined ? quoteMessageId : undefined)
    // QQ clients can hide record playback when a native reply segment is present (real audition 2026-10-29).
    const message: ReadonlyArray<Record<string, unknown>> = !segments.some(segment => segment.type === 'record')
      && quote !== undefined && /^\-?\d+$/.test(quote)
      ? [{ type: 'reply', data: { id: quote } }, ...segments]
      : [...segments]
    const sent = await this.call(target.groupId === undefined ? 'send_private_msg' : 'send_group_msg', {
      ...(target.groupId === undefined ? { user_id: target.userId } : { group_id: target.groupId }),
      message,
    })
    if ((typeof sent.message_id !== 'number' || !Number.isSafeInteger(sent.message_id)) &&
        (typeof sent.message_id !== 'string' || !/^-?\d+$/.test(sent.message_id))) {
      throw new Error('qq_delivery_unconfirmed')
    }
    this.log({ event: 'qq_send_api_accepted', messageId: sent.message_id as string | number })
    if (target.groupId !== undefined) {
      const replies = this.groupReplies.get(target.groupId) ?? new Set<string>()
      replies.add(String(sent.message_id))
      while (replies.size > 100) replies.delete(replies.values().next().value!)
      this.groupReplies.set(target.groupId, replies)
      const context = this.groupBuffer.read(target.groupId)
      const sourceIndex = context.findIndex(line => line.messageId === quote)
      if (sourceIndex >= 0) {
        const key = `${target.groupId}:${target.userId}`
        const consumed = this.groupContextConsumed.get(key) ?? new Set<string>()
        for (const line of context.slice(0, sourceIndex + 1)) if (line.messageId) consumed.add(line.messageId)
        consumed.add(String(sent.message_id))
        while (consumed.size > 100) consumed.delete(consumed.values().next().value!)
        this.groupContextConsumed.delete(key)
        this.groupContextConsumed.set(key, consumed)
        if (this.groupContextConsumed.size > 1024) this.groupContextConsumed.delete(this.groupContextConsumed.keys().next().value!)
      }
      const text = segments.filter(segment => segment.type === 'text').map(segment => segment.data.text).join('')
      if (text) this.groupBuffer.add(target.groupId, { senderId: this.config.botId, text,
        messageId: String(sent.message_id), at: Date.now(), ...(quote === undefined ? {} : { replyToMessageId: quote }) })
    }
    return sent.message_id as string | number
  }

  /**
   * **主动投递**一条文字给本人（post-Lv2 / ADR-110 `D06`/`D08`）。
   *
   * ============================================================================
   *  它与 `receive()` 里那条发送路径的关系
   * ============================================================================
   * ```text
   * 同一个 socket、同一个 owner、同一条 `this.queue` 串行链
   * ⇒ **不会**两条并排写：普通回复优先（下面的等让逻辑），主动文字不插队
   * ```
   *
   * ⚠️ **结局三态**（`D08`）：`api_accepted`（有回执 id）/ `failed_confirmed`（平台明确拒）
   *    / `delivery_unknown`（超时、断开、接受了却没有回执 id）。
   *    ⚠️ 绝不返回"已送达"——QQ 协议不给那个凭据。
   * ⚠️ **不重试**：一次调用 = 一次尝试。重发由上层按 `D08` 的规则决定，
   *    而不是在这里"再试一次"（那会把"可能已送达"变成"确定送两次"）。
   */
  async deliverProactiveText(text: string): Promise<{
    status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'
    messageId?: string
    reason?: string
  }> {
    if (!this.connected || this.stopping) {
      /* 发送**前**就确定连接不可用 ⇒ 未发送（不是"结果不明"） */
      return { status: 'failed_confirmed', reason: 'qq_not_connected_before_send' }
    }
    const socket = this.socket!
    const task = this.queue.then(
      async () => await this.deliverOnQueue(text, socket),
      async () => await this.deliverOnQueue(text, socket)
    )
    this.queue = task.then(() => undefined, () => undefined)
    return await task
  }

  /** 在**同一条**串行链上真正发一次（普通回复优先：有在途回复时先让） */
  private async deliverOnQueue(
    text: string,
    socket: WebSocket
  ): Promise<{
    status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'
    messageId?: string
    reason?: string
  }> {
    /*
     * **普通回复优先**：`this.queued` 是"在途/排队的正式回复"计数。
     * 主动文字等它归零（有界）再发 —— 用户正在等一句回复时，主动问候不该插在它前面。
     * ⚠️ 有界是必须的：无界等待会让一条排不进去的主动文字永远占着队列尾。
     */
    for (let wait = 0; wait < 100 && this.queued > 0; wait += 1) {
      await new Promise((done) => setTimeout(done, 50))
    }
    if (!this.connected || this.socket !== socket) {
      return { status: 'failed_confirmed', reason: 'qq_delivery_disconnected' }
    }
    try {
      const messageId = await this.sendText(text, socket)
      return { status: 'api_accepted', messageId: String(messageId) }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_delivery_failed'
      this.log({ event: 'qq_proactive_delivery_failed', messageId: undefined })
      /*
       * ⚠️ 三个桶分开（`D08`）：
       * ```text
       * qq_delivery_unconfirmed   平台 ok 但**没有**回执 id ⇒ 结果不明（不是"没发出"）
       * onebot_api_failed         平台明确拒 ⇒ 确定失败
       * 其它（超时/断开/连接档）    ⇒ 结果不明
       * ```
       */
      if (code === 'onebot_api_failed') return { status: 'failed_confirmed', reason: code }
      if (code === 'qq_delivery_unconfirmed') return { status: 'delivery_unknown', reason: code }
      return { status: 'delivery_unknown', reason: code }
    }
  }

  /* ========================================================================= */
  /* post-Lv2 / 群任务 P2：**一次任务授权的群发送**（附加式；旧路径不认识它）    */
  /* ========================================================================= */

  /**
   * 发一条**任务授权**的群消息（post-Lv2 / 群任务 P2）。
   *
   * ============================================================================
   *  它与既有发送路径的关系
   * ============================================================================
   * ```text
   * 同一个 socket、同一条 `this.queue` 串行链、同一条 `sendSegments`
   *   ⇒ 不是第二条发送路径；`qq_send_api_accepted` 日志与 `groupReplies` 记账照旧
   * **发送前**向 `groupTaskAuthorizer` 复核（失败关闭）：不传/拒绝/抛错都**不发**
   * **唯一**例外：复核通过 ⇒ 跳过 `sendSegments` 里的静态群名单（`isAllowedUser`），
   *   因为"旧名单拒绝但任务授权可达"正是本批要打通的点；其它情形逐字不变
   * ```
   *
   * ⚠️ `groupId` 必须来自**任务授权事实**（持久层任务行 + 原子额度预留），
   *    不是模型参数 —— 能力层的参数闭集里根本没有群号字段。
   * ⚠️ 结局三态（`api_accepted` / `failed_confirmed` / `delivery_unknown`）与
   *    `deliverProactiveText` 同一口径：**绝不**说"群成员已看到"；`unknown` 不重发。
   * ⚠️ **不重试**：一次调用 = 一次尝试；重发由上层按任务额度与结算规则决定。
   */
  async deliverGroupTaskMessage(input: QqGroupTaskSendInput): Promise<QqGroupTaskSendResult> {
    if (!this.connected || this.stopping) {
      return { status: 'failed_confirmed', reason: 'qq_not_connected_before_send' }
    }
    const groupId = qqId(input.groupId)
    if (groupId === undefined || groupId === this.config.botId) {
      return { status: 'failed_confirmed', reason: 'qq_group_task_target_invalid' }
    }
    if (input.taskId.trim() === '' || !Number.isSafeInteger(input.taskVersion) || input.taskVersion < 1
      || input.deliveryKey.trim() === '') {
      return { status: 'failed_confirmed', reason: 'qq_group_task_input_invalid' }
    }
    if (input.media === 'voice'
      && (typeof input.recordFileUrl !== 'string' || !input.recordFileUrl.startsWith('base64://'))) {
      return { status: 'failed_confirmed', reason: 'qq_group_task_record_absent' }
    }
    const socket = this.socket!
    const task = this.queue.then(
      async () => await this.deliverGroupTaskOnQueue({ ...input, groupId }, socket),
      async () => await this.deliverGroupTaskOnQueue({ ...input, groupId }, socket)
    )
    this.queue = task.then(() => undefined, () => undefined)
    return await task
  }

  /** 在**同一条**串行链上真正发一次任务授权的群消息（普通回复优先：有在途回复时先让） */
  private async deliverGroupTaskOnQueue(
    input: QqGroupTaskSendInput,
    socket: WebSocket
  ): Promise<QqGroupTaskSendResult> {
    for (let wait = 0; wait < 100 && this.queued > 0; wait += 1) {
      await new Promise((done) => setTimeout(done, 50))
    }
    if (!this.connected || this.socket !== socket) {
      return { status: 'failed_confirmed', reason: 'qq_delivery_disconnected' }
    }
    /* **发送前复核**：发出去就收不回来，所以授权与连接状态都要在发的那一刻再核一次 */
    const authorization = await this.authorizeGroupTaskSend({
      groupId: input.groupId, taskId: input.taskId, taskVersion: input.taskVersion,
      deliveryKey: input.deliveryKey,
    })
    if (!authorization.ok) {
      /*
       * 没有任务授权 ⇒ **不发**。若这个群本来就不在静态名单里，给出与旧路径
       * **逐字相同**的具名原因（`qq_target_no_longer_authorized`）——那是旧闸自己的话。
       */
      const reason = this.groupInStaticAllowlist(input.groupId)
        ? authorization.code : 'qq_target_no_longer_authorized'
      this.log({ event: 'qq_group_task_send_not_authorized', requestId: input.deliveryKey, reason })
      return { status: 'failed_confirmed', reason }
    }
    const scope: GroupTaskSendAuthorization = {
      groupId: input.groupId, taskId: input.taskId, taskVersion: input.taskVersion,
    }
    /*
     * ⚠️ 群消息的 `target.userId` 只是这条发送路径的形状要求（群消息的 wire 参数
     *    只有 `group_id`）；任务授权窄路径**不**走成员核验，也没有"某个成员"这回事。
     */
    const target = { userId: this.config.botId, groupId: input.groupId }
    try {
      const messageId = input.media === 'voice'
        ? await this.sendRecord(input.recordFileUrl!, socket, target, scope)
        : await this.sendText(input.text, socket, target, scope)
      this.log({ event: 'qq_group_task_send_api_accepted', requestId: input.deliveryKey, messageId })
      return { status: 'api_accepted', messageId: String(messageId) }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_group_task_send_failed'
      this.log({ event: 'qq_group_task_send_failed', requestId: input.deliveryKey, reason: code })
      /*
       * 桶与 `deliverOnQueue` 同一条纪律：发送**前**就能确定没发出去的 ⇒
       * `failed_confirmed`；其余（超时 / 断开 / 接受了却没有回执 id）⇒ `delivery_unknown`。
       */
      const status: QqGroupTaskSendResult['status'] = code === 'onebot_api_failed'
        || code === 'qq_target_no_longer_authorized' || code === 'onebot_not_connected'
        || code === 'qq_delivery_disconnected' || code === 'qq_record_unexpected_file'
        ? 'failed_confirmed' : 'delivery_unknown'
      return { status, reason: code }
    }
  }

  /** 发送前向授权端口复核（端口缺失 / 抛错 / 明确拒绝 ⇒ 一律不放行） */
  private async authorizeGroupTaskSend(input: QqGroupTaskAuthorizerInput): Promise<QqGroupTaskAuthorization> {
    const authorizer = this.groupTaskAuthorizer
    if (authorizer === undefined) return { ok: false, code: 'qq_group_task_authorizer_absent' }
    try {
      const result = await authorizer(input)
      if (result !== undefined && (result as { ok?: unknown }).ok === true) return { ok: true }
      const code = (result as { code?: unknown } | undefined)?.code
      return { ok: false, code: typeof code === 'string' && code !== '' ? code : 'qq_group_task_not_authorized' }
    } catch {
      return { ok: false, code: 'qq_group_task_authorizer_failed' }
    }
  }

  /**
   * 旧静态群名单的**只读事实**（不发任何网络请求、**不放行任何东西**）。
   *
   * 用途只有一个：`deliverGroupTaskMessage` 在"没有任务授权"时给出与旧发送路径
   * **逐字相同**的具名原因（名单外的群 ⇒ `qq_target_no_longer_authorized`）。
   * 真正的放行仍然只由 `isAllowedUser`（带成员核验）或任务授权窄路径决定。
   */
  private groupInStaticAllowlist(groupId: string): boolean {
    return this.config.multiUserEnabled === true
      && this.connected
      && (this.config.allowedGroupIds?.includes(groupId) ?? false)
      && !this.revokedGroups.has(groupId)
  }

  /* ----------------------------------------------------------------------- */
  /* ADR-156 / P3-G：**核心派发的群任务发送**（策略 A：外壳不开库、不重判任务）  */
  /* ----------------------------------------------------------------------- */

  /**
   * 把**核心派发来的一条群任务消息**发出去（`DELIVER_GROUP_TASK` 的落地端）。
   *
   * ============================================================================
   *  策略 A：外壳**不开库、不重判任务**
   * ============================================================================
   * ```text
   * ① 形状   → `group_task_dispatch_malformed`   闭集键 / 类型 / 正文上界 / 版本 / 预留数 / 有效期
   * ② 目标绑定 → `group_task_dispatch_bad_target` 群号可解析、不是机器人自己、只能是这条指令里的那个
   * ③ 有效期 → `group_task_dispatch_expired`      now <= expiresAt
   * ④ 发送幂等 → 同一 `deliveryKey` 只发一次      重复 ⇒ 原样回首次结局（读数 `group_task_dispatch_replayed`）
   * ```
   * 四条**顺序执行、命中即返回且一条也不发**；通过 ⇒ 用**同一条 socket + 同一道发送前复核**发出去，
   * 走 `sendSegments` 的第三条窄路径（`coreDispatchScope`），因此可以发到不在旧静态群名单里的群。
   * ⚠️ **唯一**不共用的东西是 `this.queue` 那条串行链 —— 这条指令是核心**在轮次内部**
   *    发出来并等回执的，排队会与"正在等我们"的那一轮互相等死（见 `performCoreDispatch`）。
   *
   * ⚠️ **一条指令可能对应两条对外消息**：正文 + `appendixText`（语音的来源附录）。
   *    两条都发、都计数，顺序固定（正文在前）。`reservedMessages` 必须 ≥ 实际条数，
   *    否则一条都不发（见 `performCoreDispatch` 的第二道核）。
   * ⚠️ **原生引用的目标由外壳自持**（`activeInbounds`）：核心拿不到可信的入站 `message_id`
   *    （`platformFactsProblems` 对 `transport==='qq'` 明确禁止它），所以引用只能由
   *    校验过入站的那一侧补。对不上就不加引用，**仍然发送**。
   *
   * ⚠️ **它不向 `groupTaskAuthorizer` 复核**：那条复核要读持久层任务与额度账本，
   *    而外壳按策略 A **不开库**。授权由核心在派发**之前**判完（原子额度预留 + 实例 id），
   *    这里收到的 `deliveryKey` 就是那次预留的实例 id。
   * ⚠️ **绝不重试**：一次调用 = 一次尝试；`delivery_unknown` 也**不**补发、不切侧信道。
   * ⚠️ 旧调用点不碰这个方法 ⇒ 旧发送路径（含 `deliverGroupTaskMessage`）逐字不变。
   */
  async deliverGroupTaskFromCore(
    instruction: BridgeGroupTaskDispatchInstruction,
  ): Promise<QqGroupTaskSendResult> {
    /* ① 形状 —— 多一个键整条作废（不是"取能认的字段"） */
    const shape = coreDispatchInstructionOf(instruction)
    if (!shape.ok) {
      const key = coreDispatchKeyOf(instruction)
      this.log({
        event: 'qq_group_task_dispatch_rejected',
        ...(key === undefined ? {} : { requestId: key }),
        reason: shape.reason,
      })
      return { status: 'failed_confirmed', reason: shape.reason }
    }
    const parsed = shape.instruction
    /*
     * ② 目标绑定 —— 群号**只能**来自这条指令。
     *
     * ```text
     * 解析不出 QQ 号 / 解析出来是机器人自己 ⇒ 一条也不发
     * 这一条**不能**被调用方另指目标：下面所有发送都用这个 `groupId`（不用 ownerId、
     *   不用 `config.allowedGroupIds` 里的任何一个），所以"另指一个群"在这里构造不出来
     * ```
     */
    const groupId = qqId(parsed.groupId)
    if (groupId === undefined || groupId === this.config.botId) {
      this.log({ event: 'qq_group_task_dispatch_rejected', requestId: parsed.deliveryKey, reason: 'group_task_dispatch_bad_target' })
      return { status: 'failed_confirmed', reason: 'group_task_dispatch_bad_target' }
    }
    /* ③ 有效期 —— 过期就是过期：**不**因为"晚了一点点"就发（额度与时效由核心决定） */
    if (Date.now() > parsed.expiresAt) {
      this.log({ event: 'qq_group_task_dispatch_rejected', requestId: parsed.deliveryKey, reason: 'group_task_dispatch_expired' })
      return { status: 'failed_confirmed', reason: 'group_task_dispatch_expired' }
    }
    /*
     * ④ 发送幂等 —— 同一 `deliveryKey` **只发一次**。
     *
     * ⚠️ 重复到达时**原样返回首次结局**（含 `delivery_unknown`）：这一次调用**没有**任何副作用，
     *    读数照记（`group_task_dispatch_replayed`）—— 不静默，也不假装又发了一次。
     * ⚠️ 存 promise 不存结果：并发重复到达时第二条等到**同一个结局**，不会双发。
     */
    const replayed = this.coreDispatches.get(parsed.deliveryKey)
    if (replayed !== undefined) {
      this.log({ event: 'group_task_dispatch_replayed', requestId: parsed.deliveryKey })
      return await replayed
    }
    const attempt = this.performCoreDispatch({ ...parsed, groupId })
    this.coreDispatches.set(parsed.deliveryKey, attempt)
    while (this.coreDispatches.size > QQ_GROUP_TASK_DISPATCH_MEMORY) {
      const oldest = this.coreDispatches.keys().next().value
      if (oldest === undefined) break
      this.coreDispatches.delete(oldest)
    }
    return await attempt
  }

  /**
   * 四条检查通过之后的**真正发送**（发送前仍要看连接状态；语音可能在这里失败关闭）。
   *
   * ⚠️ 它**从不抛**：所有结局都落成三态读数 —— 抛出去只会让核心等成超时，
   *    而"没发出去"与"不知道发没发"是两件不同的事，不能混成一个异常。
   */
  private async performCoreDispatch(
    instruction: CoreDispatchInstruction & { readonly groupId: string },
  ): Promise<QqGroupTaskSendResult> {
    /*
     * 记录 §7.8「**发送前预留足够额度**」的**第二道**核（桥侧已经先拒过一次）：
     * 正文 1 条 + 附录 1 条（有附录时）必须都被预留住。
     *
     * ⚠️ 这里只判"预留 ≥ 下限"，不判上限（上限由核心的原子预留事务管）——
     *    外壳能回答的只有"这条指令自己是不是自相矛盾"。
     * ⚠️ 判死就**一条都不发**：发了正文再发现额度不够，那一条已经收不回来了。
     */
    const minPlanned = 1 + Number(instruction.appendixText !== undefined)
      + Number(instruction.media === 'voice' && instruction.quoteMessageId !== undefined)
    if (instruction.reservedMessages < minPlanned) {
      this.log({
        event: 'qq_group_task_dispatch_rejected',
        requestId: instruction.deliveryKey,
        reason: 'group_task_dispatch_reserved_below_planned',
      })
      return { status: 'failed_confirmed', reason: 'group_task_dispatch_reserved_below_planned' }
    }
    if (!this.connected || this.stopping) {
      /* 发送**前**就确定连接不可用 ⇒ 未发送（不是"结果不明"） */
      return { status: 'failed_confirmed', reason: 'qq_not_connected_before_send' }
    }
    /*
     * ⚠️ **语音在这里没有录音文件** —— 这是本方法唯一一处"能力缺口"，必须说清楚：
     *
     * ```text
     * 派发指令里只有 `text` 与 `media`：核心不知道音色/音频，也没有把音频送过来
     *   （音频要由**外壳**合成，那是本文件 `deliverTurnReply` 那条路的事）
     * 而策略 A 又要求外壳**不重判任务** ⇒ 这里不能被"她选了语音"牵着去合成，
     *   也不能把语音路径悄悄降级成一条与预留账不符的发送
     * ⇒ 失败关闭：`failed_confirmed` + `group_task_record_absent`（确定没发出去）
     * ⇒ **不许**假装发过语音（核心会按"语音已发"结算额度）
     * ⇒ **也不许**偷偷改发文字（除非任务自己声明 `textFallback === true` ——
     *   那是**任务声明**，不是外壳的判断；此时按文字发送并记 `qq_group_task_voice_fallback_text`）
     * ```
     */
    /*
     * ADR-156 / P3-I（契约 §2）：**语音现在真的有出口了** —— 合成在外壳侧
     * （`synthesizeVoiceRecord` 复用 `QqVoiceOutput` 端口 / `base64://` / `maxAudioBytes` / `sendRecord`）。
     *
     * ⚠️ P3-G 的那条"语音没有录音文件 ⇒ `group_task_record_absent`"**已退休**：
     *    它当时是对的（核心不传音频、外壳也没有出口），但本批把出口补上了
     *    ⇒ 再留着它就会**永远**在语音派发上失败（而账本上写着要发语音）。
     * ⚠️ 核心仍然**不传音频、不合成**（契约 §2 第 1 条）：桥协议里只有正文与形态。
     */
    /*
     * ⚠️ **这条派发不走 `this.queue`** —— 它与本文件其它发送路径有一处关键不同：
     *
     * ```text
     * 这条指令是核心在**轮次内部**发出来的：核心 `dispatchGroupTaskReply` → 写指令 → **等回执**
     *   （等回执是为了按平台结果结算额度与实例）
     * 而此刻外壳的 `this.queue` 尾巴正是**那一轮本身**（它 `await submit()` 在等核心）
     * ⇒ 把发送挂到 `this.queue` 后面（或先等 `this.queued` 归零）= 等一条**正在等我**的链
     *   ⇒ 死锁：5 秒后核心按 `delivery_unknown` 结算，额度永远对不上、消息也可能根本没发
     * ```
     * ⇒ **就地发**：下面 `coreDispatchSend` 里重新核连接/身份（与队列内那几条同一口径）。
     *    并发性仍然成立：`this.queue` 串行 ⇒ 此刻唯一在途的轮次就是**在等我们这一条**的这一轮，
     *    没有第二个发送会同时写这条 socket。
     */
    const socket = this.socket
    if (!socket) return { status: 'failed_confirmed', reason: 'onebot_not_connected' }
    return await this.coreDispatchSend(instruction, socket)
  }

  /**
   * 真正发出**这条派发指令的全部对外消息**（不前插、不排队：理由见 `performCoreDispatch`）。
   *
   * ```text
   * 先发**正文**那条（按 `media`；语音无录音时的失败关闭见 `performCoreDispatch`）
   * 再发 **`appendixText`** 那条纯文字（**只有正文被接受才发** —— 附录是给正文配的）
   * 两条在这里顺序发：不插队、不并发、不重排
   * ```
   *
   * ⚠️ 顺序不能反：附录是"这段语音/这句话的来源"，先单独甩一条附录出去，
   *    群里会先看到一串 URL 再看到正文。
   */
  private async coreDispatchSend(
    instruction: CoreDispatchInstruction & { readonly groupId: string },
    socket: WebSocket,
  ): Promise<QqGroupTaskSendResult> {
    /*
     * **读数：这一条没有排队，是就地发的**（ADR-156 / P3-G · 契约更正）。
     *
     * ⚠️ 它必须是**可见的事实**而不是隐含行为：契约 §7.7 原本写的是"同一队列"，
     *    而那条口径在"核心同步等回执"的时序下会**自锁**
     *    （详见 `performCoreDispatch`；反证：把 `this.queue` 设成永不 resolve 的 promise，
     *    这一条**仍然发得出去**）。
     */
    this.log({
      event: 'group_task_dispatch_inline',
      requestId: instruction.deliveryKey,
      reason: 'in_flight_turn_awaits_receipt',
    })
    const outcome = await this.coreDispatchDeliver(instruction, socket)
    /*
     * **结算读数**：让门与人对账时能分清"2 条都对"与"1 条（附录被吞了）"。
     * ⚠️ `deliveredCount` 只数**平台已接受**的条数；`delivery_unknown` 那条不计入。
     */
    this.log({
      event: 'qq_group_task_dispatch_delivered',
      requestId: instruction.deliveryKey,
      ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }),
      deliveredCount: outcome.deliveredCount,
      reason: outcome.reason === undefined ? outcome.status : `${outcome.status}:${outcome.reason}`,
    })
    return {
      status: outcome.status,
      ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }),
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    }
  }

  /**
   * 真正发出**这条派发指令的全部对外消息**（不前插、不排队：理由见 `performCoreDispatch`）。
   *
   * ```text
   * ① **正文**那一条（按 `media`）：
   *      文字 ⇒ `sendText`
   *      语音 ⇒ **外壳侧合成** → `base64://` → `sendRecord`（P3-I 契约 §2）
   *             明确失败且任务 `textFallback === true` ⇒ **一次**文字兜底（**替代**语音那条，不加条数）
   *             结果不明（超时/断开/无回执 id）      ⇒ `delivery_unknown`：**不兜底、不重发**
   * ② **`appendixText`** 那条纯文字（**只有正文被接受才发** —— 附录是给正文配的）
   * 两条在这里顺序发：不插队、不并发、不重排
   * ```
   *
   * ⚠️ 顺序不能反：附录是"这段语音/这句话的来源"，先单独甩一条附录出去，
   *    群里会先看到一串 URL 再看到正文。
   * ⚠️ `deliveredCount` 只数**平台已接受**的条数：语音 + 附录都成功才是 **2**。
   */
  private async coreDispatchDeliver(
    instruction: CoreDispatchInstruction & { readonly groupId: string },
    socket: WebSocket,
  ): Promise<CoreDispatchOutcome> {
    /* 发送**前**再核一次连接（与 `sendSegments` 同一道）：发出去就收不回来 */
    if (!this.connected || this.socket !== socket) {
      return { status: 'failed_confirmed', reason: 'qq_delivery_disconnected', deliveredCount: 0 }
    }
    const quote = this.coreDispatchQuote(instruction)
    if (instruction.media === 'voice' && instruction.quoteMessageId !== undefined && quote === undefined) {
      return { status: 'failed_confirmed', reason: 'group_task_voice_quote_target_unavailable', deliveredCount: 0 }
    }
    const scope = {
      groupId: instruction.groupId,
      taskId: instruction.taskId,
      taskVersion: instruction.taskVersion,
    }
    this.coreDispatchScope = { ...scope, ...(quote === undefined ? {} : { quoteMessageId: quote }) }
    /*
     * ⚠️ 群消息的 `target.userId` 只是这条发送路径的形状要求（群消息的 wire 参数
     *    只有 `group_id`）；窄路径**不**走成员核验，也没有"某个成员"这回事。
     */
    const target = { userId: this.config.botId, groupId: instruction.groupId }
    try {
      /* ① 正文（语音在前；语音失败时的文字兜底**替代**它，不追加） */
      const body = instruction.media === 'voice'
        ? await this.coreDispatchVoiceBody(instruction, socket, target)
        : await this.coreDispatchTextBody(instruction, socket, target)
      if (body.status !== 'api_accepted' || body.messageId === undefined) {
        /* 正文都没发出去 ⇒ 附录**不单独发**（一条只配正文的来源没有意义，还会白占一条额度） */
        return { ...body }
      }
      const appendix = instruction.appendixText
      if (appendix === undefined || body.reason?.startsWith('voice_failed_after_quote:')) {
        return {
          status: 'api_accepted',
          messageId: body.messageId,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          deliveredCount: body.deliveredCount,
        }
      }
      /*
       * 附录：**同一个窄路径，但去掉引用段**。
       * ⚠️ 引用只属于正文那一条：把它也挂在附录上 = 群里出现两条"引用回复"，
       *    而核心只按一条计（记录 §7.8：引用**不额外计条数**）。
       */
      this.coreDispatchScope = { ...scope }
      let appendixMessageId: string | number
      try {
        appendixMessageId = await this.sendText(appendix, socket, target)
      } catch (error) {
        const code = error instanceof Error ? error.message : 'qq_group_task_appendix_send_failed'
        const appendixStatus = this.coreDispatchFailureStatus(code)
        this.log({ event: 'qq_group_task_appendix_send_failed', requestId: instruction.deliveryKey, reason: code })
        /*
         * **聚合口径**（记录 §7.8）：
         * ```text
         * 附录"不确定发没发" ⇒ 整体 `delivery_unknown`（保守：不重发、也不假装发全了）
         * 附录"确定没发"     ⇒ 正文那一条**仍然成立** ⇒ `api_accepted` + `appendix_failed:<code>`
         *   （把一条已送达的正文报成失败同样是在说假话 —— 只是方向相反的那个假话）
         * ```
         * ⚠️ 绝不因为附录失败而**重发正文**：正文已经发出去了。
         * ⚠️ `deliveredCount` 只算**已确认被接受**的正文那一条（附录这条不确定/没发）。
         */
        return appendixStatus === 'delivery_unknown'
          ? { status: 'delivery_unknown', messageId: body.messageId, reason: `appendix_unknown:${code}`, deliveredCount: body.deliveredCount }
          : { status: 'api_accepted', messageId: body.messageId, reason: `appendix_failed:${code}`, deliveredCount: body.deliveredCount }
      }
      this.log({
        event: 'qq_group_task_appendix_send_api_accepted',
        requestId: instruction.deliveryKey,
        messageId: appendixMessageId,
      })
      /* 回执里的平台 id 取**正文**那条（附录那条只是它的伴随来源） */
      return { status: 'api_accepted', messageId: body.messageId, deliveredCount: body.deliveredCount + 1 }
    } finally {
      /* 窄路径**只在这批消息发送期间**存在：异常路径也必须清掉（否则下一条回复会被它放行） */
      this.coreDispatchScope = undefined
    }
  }

  /** 派发的**文字正文**（也用于语音明确失败后的兜底：两处对外的文字出口只有这一条） */
  private async coreDispatchTextBody(
    instruction: CoreDispatchInstruction & { readonly groupId: string },
    socket: WebSocket,
    target: { userId: string; groupId?: string },
  ): Promise<CoreDispatchBody> {
    try {
      const messageId = await this.sendText(instruction.text, socket, target)
      this.log({ event: 'qq_group_task_send_api_accepted', requestId: instruction.deliveryKey, messageId })
      return { status: 'api_accepted', messageId: String(messageId), deliveredCount: 1 }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_group_task_send_failed'
      this.log({ event: 'qq_group_task_send_failed', requestId: instruction.deliveryKey, reason: code })
      return { status: this.coreDispatchFailureStatus(code), reason: code, deliveredCount: 0 }
    }
  }

  /**
   * 派发的**语音正文**（P3-I 契约 §2：合成在**外壳侧**，核心不合成、不传音频）。
   *
   * ```text
   * 合成 + 结构校验（同一个 `synthesizeVoiceRecord`）→ 通过 ⇒ `sendRecord(base64://…)`
   * 合成/校验**明确失败** ⇒ 任务允许（`textFallback === true`）时**一次**文字兜底；否则 0 条 + 具名码
   * 平台**明确拒绝** record ⇒ 同上（确定没发出去，可以兜底）
   * 超时 / 断开 / 无回执 id ⇒ `delivery_unknown`：**不兜底、不重发**（可能已经送达）
   * ```
   *
   * ⚠️ **兜底只按任务授权**：`textFallback !== true` 时**不许**改发文字
   *    （契约 §2 第 4 条）—— 那是任务声明，不是外壳自己的判断。
   * ⚠️ 日志只留**字节数与时长**，不写音频、不写正文（契约 §2 第 6 条）。
   */
  private async coreDispatchVoiceBody(
    instruction: CoreDispatchInstruction & { readonly groupId: string },
    socket: WebSocket,
    target: { userId: string; groupId?: string },
  ): Promise<CoreDispatchBody> {
    const synthesized = await this.synthesizeVoiceRecord(instruction.text, instruction.deliveryKey)
    if (!synthesized.ok) {
      return await this.coreDispatchVoiceFallback(instruction, socket, target, synthesized.reason)
    }
    let quoteMessageId: string | undefined
    if (instruction.quoteMessageId !== undefined) {
      try {
        // Reuse the final guarded model text; the shell invents no acknowledgement wording.
        quoteMessageId = String(await this.sendText(instruction.text, socket, target))
        this.log({ event: 'qq_group_task_voice_quote_send_api_accepted', requestId: instruction.deliveryKey, messageId: quoteMessageId })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'group_task_quote_send_failed'
        return { status: this.coreDispatchFailureStatus(reason), reason, deliveredCount: 0 }
      }
      this.coreDispatchScope = { groupId: instruction.groupId, taskId: instruction.taskId, taskVersion: instruction.taskVersion }
    }
    try {
      const messageId = await this.sendRecord(synthesized.fileUrl, socket, target)
      this.log({
        event: 'qq_group_task_voice_send_api_accepted',
        requestId: instruction.deliveryKey,
        messageId,
        /* ⚠️ 只有字节数与时长：音频内容与正文都不进日志 */
        reason: `${synthesized.audio.byteLength}b/${synthesized.durationMs}ms`,
      })
      return { status: 'api_accepted', messageId: String(messageId), deliveredCount: quoteMessageId === undefined ? 1 : 2 }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_group_task_voice_send_failed'
      if (quoteMessageId !== undefined) {
        return { status: this.coreDispatchFailureStatus(code) === 'delivery_unknown' ? 'delivery_unknown' : 'api_accepted',
          messageId: quoteMessageId, reason: `voice_failed_after_quote:${code}`, deliveredCount: 1 }
      }
      const status = this.coreDispatchFailureStatus(code)
      this.log({ event: 'qq_group_task_voice_send_failed', requestId: instruction.deliveryKey, reason: code })
      if (status === 'delivery_unknown') {
        /* 超时 / 断开 / 平台 ok 但没有回执 id ⇒ **结果不明**：不重发，也不发同内容文字 */
        return { status: 'delivery_unknown', reason: code, deliveredCount: 0 }
      }
      return await this.coreDispatchVoiceFallback(instruction, socket, target, code)
    }
  }

  /**
   * 语音**明确失败**后的唯一一条出路：任务声明允许时改发文字（**替代**那条语音，不增加条数）。
   *
   * ⚠️ `textFallback !== true` ⇒ **一条都不发**，如实 `failed_confirmed` + 具名 reason。
   *    这正是"只语音任务不许偷偷改成文字"在代码里的落点（与 `decideVoiceFallback` 同一纪律）。
   */
  private async coreDispatchVoiceFallback(
    instruction: CoreDispatchInstruction & { readonly groupId: string },
    socket: WebSocket,
    target: { userId: string; groupId?: string },
    reason: string,
  ): Promise<CoreDispatchBody> {
    if (instruction.textFallback !== true) {
      this.log({ event: 'qq_group_task_send_skipped', requestId: instruction.deliveryKey, reason })
      return { status: 'failed_confirmed', reason, deliveredCount: 0 }
    }
    this.log({ event: 'qq_group_task_voice_fallback_text', requestId: instruction.deliveryKey, reason })
    /* ⚠️ 兜底走**同一条**文字正文出口，所以它同样受引用段/窄路径/身份检查约束 */
    return await this.coreDispatchTextBody(instruction, socket, target)
  }

  /**
   * 一条**群任务发送**失败的结局分类（`failed_confirmed` / `delivery_unknown`）。
   *
   * ⚠️ 与 `deliverGroupTaskMessage` 的桶**逐字同口径**（含 `qq_record_unexpected_file`）：
   *    发送**前**就能确定没发出去 ⇒ `failed_confirmed`；其余（超时 / 接受了却没有回执 id
   *    / 发送途中断开）⇒ `delivery_unknown`。**绝不重试**。
   */
  private coreDispatchFailureStatus(code: string): 'failed_confirmed' | 'delivery_unknown' {
    return code === 'onebot_api_failed' || code === 'qq_target_no_longer_authorized'
      || code === 'onebot_not_connected' || code === 'qq_delivery_disconnected'
      || code === 'qq_record_unexpected_file'
      ? 'failed_confirmed' : 'delivery_unknown'
  }

  /**
   * 原生引用目标：**只认外壳自己校验过的、正在被回答的那条入站消息**。
   *
   * ```text
   * 在途入站存在（同一个群）    ⇒ 引用**它**（这是 `receive()` 里校验过的那条 message_id）
   * 指令里给了 quoteMessageId   ⇒ 只作旁证：**与外壳自持的不一致时以自持者为准**并记读数
   *                               （核心拿不到可信入站 id，`platformFactsProblems` 明确禁止）
   * 没有在途入站                ⇒ **不加引用、仍然发送**（正文是主体），记 `group_task_dispatch_quote_unavailable`
   * ```
   * ⚠️ 引用段与正文在**同一次** `send_group_msg` 里（不是第二条消息）⇒ 不额外占额度。
   */
  private coreDispatchQuote(instruction: {
    readonly groupId: string
    readonly deliveryKey: string
    readonly quoteMessageId?: string
  }): string | undefined {
    const active = this.activeInbounds.get(instruction.groupId)
    if (active === undefined) {
      this.log({
        event: 'group_task_dispatch_quote_unavailable',
        requestId: instruction.deliveryKey,
        reason: 'no_active_inbound',
      })
      return undefined
    }
    const wanted = instruction.quoteMessageId
    if (wanted !== undefined && wanted !== active.messageId) {
      /* 不一致时**以自持的为准**：那个值是 `receive()` 校验过的，指令里的只能当旁证 */
      this.log({
        event: 'group_task_dispatch_quote_mismatch',
        requestId: instruction.deliveryKey,
        reason: 'instruction_quote_differs',
      })
    }
    return active.messageId
  }

  /**
   * 记下"这个群的这条入站正在被回答"（按群一条，有界）。
   *
   * ⚠️ 只作为 {@link coreDispatchQuote} 的依据：不放行任何东西、不参与准入。
   * ⚠️ 上限 32 个群（FIFO 淘汰）：外壳是长驻进程，群多时不设上限就是一条只涨不落的表。
   */
  private rememberActiveInbound(groupId: string, requestId: string, messageId: string): void {
    /* 同一群只留**最近一条**（同会话轮次串行 ⇒ 它就是"正在被回答的那一条"） */
    this.activeInbounds.delete(groupId)
    this.activeInbounds.set(groupId, { requestId, messageId })
    while (this.activeInbounds.size > QQ_GROUP_TASK_ACTIVE_INBOUND_MAX) {
      const oldest = this.activeInbounds.keys().next().value
      if (oldest === undefined) break
      this.activeInbounds.delete(oldest)
    }
  }

  /**
   * 这一轮结束：清掉"正在被回答"的读数。
   *
   * ⚠️ 只在它仍是**我这一条**时清：清错一条会让下一条派发失去该有的引用，
   *    而引用丢了不会有任何报错 —— 只会让群里少一个"在回哪句"。
   */
  private clearActiveInbound(groupId: string, requestId: string): void {
    if (this.activeInbounds.get(groupId)?.requestId === requestId) this.activeInbounds.delete(groupId)
  }

  /**
   * ADR-156 / P3-E：**每一次静默丢弃都必须留一条读数**。
   *
   * ```text
   * 真实链路上出现过：LLBot 明明收到"测试ing"，核心一条入站都没有，日志里什么也没有
   *   ⇒ 只能翻平台日志反推"是外壳丢的"，却看不出**丢在哪一步**
   * 从这个方法起：每一处丢弃都带**具名理由**（不含正文、不含群名）
   * ```
   */
  private dropInbound(
    reason: string,
    extra: { requestId?: string; groupId?: string; userId?: string } = {}
  ): void {
    this.log({ event: 'qq_inbound_dropped', reason, ...extra })
  }

  private receive(packet: Record<string, unknown>, socket: WebSocket): void {
    const submit = this.submit
    if (submit === undefined) return // Read-only status probe: never consumes or replies to user messages.
    /*
     * ADR-156 / P3-E：**入站对账读数**（在任何 `return` 之前）。
     *
     * ```text
     * 真实链路出现过："平台日志说上报了 message.group，我们这侧一条记录都没有"
     *   ⇒ 分不清是"平台没推"、"传输丢了"、还是"我们某处静默丢弃"
     * 有了这一行：把 平台「事件上报 message.group」条数 与 这里的条数**逐分钟对账**：
     *   相等   ⇒ 平台没丢，丢失发生在我们内部（具名 reason 会指出哪一步）
     *   我们更少 ⇒ **ws 传输层丢了事件**（去查重连/心跳/缓冲）
     * ```
     *
     * ⚠️ 只记 `post_type:'message'`（心跳/meta 不记，避免 5 秒一条的噪声）。
     * ⚠️ 发送者只留**末 3 位**：够对账，不够还原一个 QQ 号。
     */
    if (packet.post_type === 'message') {
      const seenGroup = qqId(packet.group_id)
      const seenSender = qqId(packet.user_id)
      this.log({
        event: 'qq_inbound_seen',
        /* `reason` 是 `log()` 的闭集字段之一：把"类型/群/发送者末三位"压成一段可对账的短串 */
        reason: [
          `type=${String(packet.message_type ?? 'unknown')}`,
          seenGroup === undefined ? 'group=-' : `group=${seenGroup}`,
          `senderTail=${(seenSender ?? '').slice(-3)}`,
        ].join(' '),
      })
    }
    if (this.connected && qqId(packet.self_id) === this.config.botId && packet.post_type === 'notice') {
      const group = qqId(packet.group_id)
      if (group && this.config.allowedGroupIds?.includes(group) && ['group_decrease', 'group_increase'].includes(String(packet.notice_type))) {
        this.groupEpochs.set(group, (this.groupEpochs.get(group) ?? 0) + 1)
        this.groupBuffer.clear(group); this.groupReplies.delete(group)
        /*
         * ADR-156 / P3-G：群成员纪元变了 ⇒ "正在被回答"的读数也一起清掉。
         * ⚠️ 理由与 `groupBuffer` / `groupReplies` 清空**同一条**：纪元一过，
         *    旧的上下文、旧的回复关联、旧的在途入站都不再代表"这个群现在在说什么"。
         */
        this.activeInbounds.delete(group)
        if (qqId(packet.user_id) === this.config.botId) {
          if (packet.notice_type === 'group_decrease') this.revokedGroups.add(group)
          else this.revokedGroups.delete(group)
        }
      }
      return
    }
    if (!this.connected || this.stopping || packet.post_type !== 'message') {
      return this.dropInbound(!this.connected ? 'not_connected' : this.stopping ? 'stopping' : 'not_message')
    }
    const userId = qqId(packet.user_id)
    const groupId = packet.message_type === 'group' ? qqId(packet.group_id) : undefined
    if (qqId(packet.self_id) !== this.config.botId || userId === undefined || userId === this.config.botId) {
      return this.dropInbound('wrong_identity', {
        ...(groupId === undefined ? {} : { groupId }),
        ...(userId === undefined ? {} : { userId }),
      })
    }
    const where = { ...(groupId === undefined ? {} : { groupId }), userId }
    if (packet.message_type === 'group') {
      /*
       * ADR-156 / P3-B：**准入可以下放给核心**（`deferGroupAdmissionToCore`）。
       *
       * ```text
       * 旧行为：群号必须命中静态名单，且机器人没有被移出该群，否则直接丢
       * 下放后：只保留"结构性"前提（多用户档、群号可解析、非匿名、非特殊子类型），
       *        准入交给核心（任务授权优先于旧名单）
       * ```
       * ⚠️ 机器人被移出群（`revokedGroups`）仍然直接丢：那不是"授权问题"，
       *    是这条连接根本没有这个群的消息来源。
       */
      const structural = !this.config.multiUserEnabled ? 'multi_user_disabled'
        : !groupId ? 'no_group_id'
        : packet.anonymous ? 'anonymous_sender'
        : packet.sub_type !== 'normal' ? 'group_sub_type_not_normal'
        : this.revokedGroups.has(groupId) ? 'group_revoked'
        : undefined
      if (structural !== undefined) return this.dropInbound(structural, where)
      if (!this.deferGroupAdmissionToCore && !this.config.allowedGroupIds?.includes(groupId!)) {
        return this.dropInbound('group_not_allowlisted', where)
      }
    } else if (packet.message_type !== 'private' || packet.group_id !== undefined ||
      !(this.config.multiUserEnabled ? ['friend', 'group', 'other'].includes(String(packet.sub_type)) : packet.sub_type === 'friend') ||
      (!this.config.multiUserEnabled && userId !== this.config.ownerId)) {
      return this.dropInbound('private_shape_rejected', where)
    }
    const sender = packet.sender as Record<string, unknown> | undefined
    if (!sender || qqId(sender.user_id) !== userId) return this.dropInbound('sender_mismatch', where)
    /*
     * 平台显示名：**群名片优先、昵称兜底**。
     *
     * ```text
     * card     —— 群名片（这个群里她看到的名字；大群里基本人人不同）
     * nickname —— QQ 昵称（跨群一致，但可能和群名片不一致）
     * ```
     *
     * ⚠️ 两处都必须过 `platformDisplayName`：空串 / 纯空白 / 全是控制字符的"名字"
     *    收敛后是 `undefined` ⇒ `??` 会继续退到下一个来源（`card` 是空白就退 `nickname`），
     *    而不是把空白串当成名字送进 prompt。
     * ⚠️ 它**不参与任何准入判定**：身份仍是 `userId`（上面那条 `sender_mismatch` 已判过），
     *    显示名只影响上下文里的说话人标签。
     */
    const senderName = platformDisplayName(sender.card) ?? platformDisplayName(sender.nickname)
    const id = packet.message_id
    if ((typeof id !== 'number' || !Number.isSafeInteger(id)) && (typeof id !== 'string' || !/^-?\d+$/.test(id))) {
      return this.dropInbound('bad_message_id', where)
    }
    const requestId = groupId === undefined && !this.config.multiUserEnabled ? `qq-private:${this.config.botId}:${id}` :
      `qq:${this.config.botId}:${groupId === undefined ? `private:${userId}` : `group:${groupId}`}:${id}`
    if (this.seen.has(requestId)) { this.log({ event: 'qq_duplicate_ignored', requestId }); return }
    this.seen.add(requestId)
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!)
    const segments = packet.message
    const target = { userId, ...(groupId === undefined ? {} : { groupId }) }
    const groupEpoch = groupId === undefined ? 0 : this.groupEpochs.get(groupId) ?? 0
    const receivedAt = Date.now()
    const enqueuedAt = performance.now()
    let currentGroupLine: GroupContextLine | undefined
    if (groupId !== undefined) {
      if (!Array.isArray(segments) || segments.some(part => !part || !['text', 'at', 'reply'].includes(part.type)
        || !part.data || (part.type === 'text' && typeof part.data.text !== 'string'))) {
        return this.dropInbound('segment_shape_rejected', { requestId, ...where })
      }
      const text = segments.filter(part => part.type === 'text').map(part => part.data?.text ?? '').join('')
      if ((!text.trim() && !segments.some(part => part.type === 'at' || part.type === 'reply')) || text.length > 6000) {
        return this.dropInbound(!text.trim() ? 'text_empty' : 'text_too_long', { requestId, ...where })
      }
      const replyTo = segments.find(part => part.type === 'reply')?.data?.id
      const replyToMessageId = typeof replyTo === 'string' || typeof replyTo === 'number' ? String(replyTo) : undefined
      if (replyToMessageId !== undefined && !/^-?\d{1,20}$/.test(replyToMessageId)) return this.dropInbound('bad_reply_id', { requestId, ...where })
      const quoted = this.groupBuffer.read(groupId).find(line => line.messageId === replyToMessageId)
      const mentionedUserIds = [...new Set(segments.filter(part => part.type === 'at')
        .map(part => part.data?.qq === 'all' ? 'all' : qqId(part.data?.qq)).filter((id): id is string => id !== undefined))]
      if (mentionedUserIds.length > 32) return this.dropInbound('too_many_mentions', { requestId, ...where })
      currentGroupLine = { senderId: userId, text, at: receivedAt, messageId: String(id), mentionedUserIds,
        ...(senderName === undefined ? {} : { name: senderName }),
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        ...(quoted === undefined ? {} : { replyToSenderId: quoted.senderId, replyText: quoted.text }),
        ...(typeof packet.time === 'number' && Number.isSafeInteger(packet.time) && packet.time >= 0 && packet.time * 1000 <= receivedAt + 60_000
          ? { sourceAt: packet.time * 1000 } : {}) }
      this.groupBuffer.add(groupId, currentGroupLine)
      const addressed = segments.some(part => part.type === 'at' && qqId(part.data?.qq) === this.config.botId)
        || segments.some(part => part.type === 'reply' && this.groupReplies.get(groupId)?.has(String(part.data?.id)))
        || addressedByName(text)
      /*
       * 方案 §4 第 7 条：**任务生效时不再要求 @ / 直呼其名**。
       * ⚠️ 外壳不知道"这个群有没有任务"（它不开库）⇒ 下放模式下不在这里判；
       *    真正的判据在核心（`decideInboundRouting`）。旧模式逐字不变。
       */
      const continuation = this.pendingGroupTurns.get(JSON.stringify([groupId, userId, groupEpoch, replyToMessageId]))
      const canContinue = continuation !== undefined && performance.now() <= continuation.until
        && mentionedUserIds.length === 0 && !text.trimStart().startsWith('/')
      if (!addressed && !canContinue && !this.deferGroupAdmissionToCore) {
        return this.dropInbound('not_addressed', { requestId, ...where })
      }
    }
    if (!Array.isArray(segments) || segments.length === 0 || segments.some((part) =>
      !part || !(groupId === undefined ? ['text', 'image'] : ['text', 'at', 'reply']).includes(part.type) ||
      (part.type === 'text' ? typeof part.data?.text !== 'string' : !part.data || part.data.type === 'flash'))) {
      if (userId === this.config.ownerId) void this.sendText('这个入口目前支持文字和普通图片消息。', socket, target).catch(() => this.log({ event: 'qq_delivery_failed', requestId }))
      return this.dropInbound('segment_type_unsupported', { requestId, ...where })
    }
    const imageParts = segments.filter(part => part.type === 'image')
    if (imageParts.length > IMAGE_INPUT_LIMITS.maxImages) {
      void this.sendText('一条消息最多支持 4 张图片，请分开发送。', socket, target).catch(() => this.log({ event: 'qq_delivery_failed', requestId }))
      return this.dropInbound('too_many_images', { requestId, ...where })
    }
    const userText = segments.filter(part => part.type === 'text').map((part) => part.data.text).join('') ||
      (imageParts.length ? '[用户发送了图片]' : groupId !== undefined ? '[本条消息只有 @ 或回复段，没有文字正文]' : '')
    if (!userText.trim() || userText.length > 6000) {
      this.log({ event: 'qq_text_rejected', requestId })
      return this.dropInbound('user_text_rejected', { requestId, ...where })
    }
    const burstMs = this.config.groupBurstMs ?? 300
    const burstKey = currentGroupLine && !this.deferGroupAdmissionToCore && burstMs > 0 && !userText.trimStart().startsWith('/')
      ? JSON.stringify([groupId, userId, groupEpoch, currentGroupLine.replyToMessageId]) : undefined
    const pending = burstKey === undefined ? undefined : this.pendingGroupTurns.get(burstKey)
    if (pending && performance.now() <= pending.until && pending.parts.length < 3
      && (currentGroupLine!.mentionedUserIds?.length === 0 || JSON.stringify(currentGroupLine!.mentionedUserIds) === JSON.stringify(pending.line.mentionedUserIds))
      && pending.parts.join('\n').length + userText.length + 1 <= 6000) {
      pending.parts.push(userText)
      const sourceMessageIds = [...(pending.line.sourceMessageIds ?? [pending.line.messageId!]), String(id)]
      pending.line = { ...currentGroupLine!, sourceMessageIds,
        mentionedUserIds: [...new Set([...(pending.line.mentionedUserIds ?? []), ...(currentGroupLine!.mentionedUserIds ?? [])])] }
      pending.until = Math.min(performance.now() + burstMs, pending.deadline)
      this.log({ event: 'qq_group_burst_merged', requestId, reason: JSON.stringify({ sourceMessageIds }) })
      return
    }
    /*
     * ADR-156 / P3-E：在途上限（**群上限 4 → 16**，用户裁定"提高到 4 倍"）。
     *
     * ```text
     * 为什么提：真实大群里 22 条消息 5 分钟就把 groupQueued 顶到 4
     *   ⇒ **主人本人的消息也被一起丢掉**，而且丢得无声无息（这一批才加上读数）
     * 为什么主人豁免：与 3 秒限流同一条立场 —— 主人的话不该被"群太热闹"吞掉
     * ```
     * ⚠️ 全局上限（16/4）与每人上限（2）**不放宽**：它们是防雪崩的，不是防热闹的。
     */
    const groupQueueLimit = 16
    const groupQueueFull = groupId !== undefined && userId !== this.config.ownerId
      && (this.groupQueued.get(groupId) ?? 0) >= groupQueueLimit
    const globalQueueFull = this.queued >= (this.config.multiUserEnabled ? 16 : 4)
    const userQueueFull = this.config.multiUserEnabled && userId !== this.config.ownerId
      && (this.userQueued.get(userId) ?? 0) >= 2
    if (globalQueueFull || userQueueFull || groupQueueFull) {
      if (userId === this.config.ownerId) void this.sendText('前面的消息还在处理中，请稍后再发。', socket, target).catch(() => this.log({ event: 'qq_delivery_failed', requestId }))
      return this.dropInbound(
        globalQueueFull ? 'queue_full' : userQueueFull ? 'user_queue_full' : 'group_queue_full',
        { requestId, ...where }
      )
    }
    const rateKey = groupId === undefined ? `private:${userId}` : `group:${groupId}:${userId}`
    if (this.config.multiUserEnabled && userId !== this.config.ownerId && Date.now() - (this.lastAccepted.get(rateKey) ?? 0) < 3000) {
      return this.dropInbound('rate_limited', { requestId, ...where })
    }
    this.lastAccepted.set(rateKey, Date.now())
    if (this.lastAccepted.size > 1024) this.lastAccepted.delete(this.lastAccepted.keys().next().value!)
    this.userQueued.set(userId, (this.userQueued.get(userId) ?? 0) + 1)
    if (groupId !== undefined) this.groupQueued.set(groupId, (this.groupQueued.get(groupId) ?? 0) + 1)
    this.queued++
    const batch = { parts: [userText], line: currentGroupLine!, until: performance.now() + burstMs, deadline: performance.now() + 1000 }
    if (burstKey !== undefined) this.pendingGroupTurns.set(burstKey, batch)
    this.queue = this.queue.then(async () => {
      if (burstKey !== undefined) {
        while (performance.now() < batch.until) await new Promise(resolve => setTimeout(resolve, Math.max(1, batch.until - performance.now())))
        if (this.pendingGroupTurns.get(burstKey) === batch) this.pendingGroupTurns.delete(burstKey)
      }
      const turnText = batch.parts.join('\n')
      const replyMessageId = groupId === undefined ? String(id) : batch.line.messageId!
      const processingAt = performance.now()
      if (!this.connected || this.socket !== socket) { this.log({ event: 'qq_queued_disconnected', requestId }); return }
      /*
       * ADR-156 / P3-B：群入站的准入**可以**下放给核心。
       *
       * ⚠️ 只在"群消息 + 显式打开下放"时跳过这道旧闸；私聊与旧装配逐字不变。
       * ⚠️ 跳过的是**准入**，不是结构校验：群号/发送者/文本/图片/限流仍在上面的分支里判过。
       */
      const deferGroupAdmission = this.deferGroupAdmissionToCore && groupId !== undefined
      if (!deferGroupAdmission && !await this.isAllowedUser(userId, groupId)) {
        if (groupId !== undefined) this.groupBuffer.clear(groupId)
        this.log({ event: 'qq_member_not_authorized', requestId }); return
      }
      if (groupId !== undefined && groupEpoch !== (this.groupEpochs.get(groupId) ?? 0)) {
        this.log({ event: 'qq_group_epoch_changed', requestId }); return
      }
      this.log({ event: 'qq_turn_timing', requestId,
        reason: JSON.stringify({ phase: 'admission', queueMs: Math.round(processingAt - enqueuedAt),
          membershipMs: Math.round(performance.now() - processingAt), ageMs: Math.max(0, Date.now() - receivedAt) }) })
      let response: BridgeWireResponse
      let images: ImageInput[] | undefined
      if (imageParts.length) {
        try {
          images = []
          for (const part of imageParts) {
            if (Number(part.data.file_size) > IMAGE_INPUT_LIMITS.maxImageBytes) throw new Error('image_input_too_large')
            let url = part.data.url
            if (!url && typeof part.data.file === 'string') url = (await this.call('get_image', { file: part.data.file })).url
            images.push(await downloadQqImage(url))
          }
          checkImageInputs(images)
        } catch {
          this.log({ event: 'qq_image_input_failed', requestId })
          await this.sendText('这次没有成功读取图片。请重发 PNG/JPEG 图片（每张不超过 8 MiB、合计不超过 16 MiB，最多 4 张）。', socket, target)
          return
        }
      }
      if (!this.connected || this.socket !== socket) return
      /*
       * ADR-156 / P3-G：**这一条入站正在被回答**（原生引用的唯一依据）。
       *
       * ⚠️ 只在 `await submit(...)` 的**在途窗口内**有效：核心会在这一轮**内部**
       *    把派发指令发回来（它要等回执结算额度）⇒ 那正是这个窗口。
       * ⚠️ 记在这里（而不是入队时）是因为同群的下一轮可能已经排在队列里 ——
       *    入队时就记，会让"上一轮的派发"引到"下一轮的消息"上。
       */
      if (groupId !== undefined) this.rememberActiveInbound(groupId, requestId, replyMessageId)
      try {
        response = await submit({
          requestId,
          userText: turnText,
          ...(images ? { images } : {}),
          ...(groupId === undefined ? {} : { groupContext: [
            ...this.groupBuffer.read(groupId).filter(line => line.messageId !== batch.line.messageId
              && !(batch.line.sourceMessageIds ?? []).includes(line.messageId ?? '')
              && (line.at <= batch.line.at || line.senderId === userId)
              && !this.groupContextConsumed.get(`${groupId}:${userId}`)?.has(line.messageId ?? '')).slice(-19),
            { ...batch.line, text: turnText.slice(0, 1000), isCurrent: true },
          ].filter((line, index, all) => all.slice(index).reduce((sum, row) => sum + row.text.length, 0) <= 6000) }),
          // Only validated platform facts cross the bridge; the model cannot choose actor/room.
          platformFacts: {
            transport: 'qq',
            selfId: String(packet.self_id),
            senderUserId: String(packet.user_id),
            messageType: packet.message_type === 'group' ? 'group' : 'private',
            ...(packet.group_id === undefined ? {} : { groupId: String(packet.group_id) }),
            /* ⚠️ 有界、可选：缺席时桥不认识这个键的"空值"，整条事实会按形状拒掉 */
            ...((batch.line?.name ?? senderName) === undefined ? {} : { senderName: batch.line?.name ?? senderName }),
          },
        })
      }
      catch {
        this.log({ event: 'lg_turn_failed', requestId })
        await this.sendText('这轮连接失败了，消息可能已经记入会话。请稍后重新发送。', socket, target)
        return
      } finally {
        this.log({ event: 'qq_turn_timing', requestId, reason: JSON.stringify({ phase: 'core', durationMs: Math.round(performance.now() - processingAt) }) })
        /* 轮次一结束就不再"正在被回答"：清掉，避免下一条派发引到它 */
        if (groupId !== undefined) this.clearActiveInbound(groupId, requestId)
      }
      /*
       * ADR-156 / P3-C：**有意不回**（程序判据决定这一轮沉默）。
       *
       * ```text
       * 发什么 —— 什么都不发（正文、失败提示、兜底话术都不发）
       * 记什么 —— 一条 `qq_no_reply` 读数（带具名理由，**不含正文**）
       * 不做什么 —— 不重试、不当成失败、不写投递日志（没有投递这回事）
       * ```
       *
       * ⚠️ 放在 `replied` 分支**之前**：`no_reply` 没有 `replyText`，若落到下面的
       *    else 分支就会被当成"回复失败"并给群里发一句失败提示 —— 那正是本通道要消除的行为。
       */
      if (response.outcome === 'no_reply') {
        this.log({ event: 'qq_no_reply', requestId, reason: String(response.code ?? 'unspecified') })
        return
      }
      /*
       * ADR-156 / P3-G：**接管轮的正文已经由 `DELIVER_GROUP_TASK` 那条出口发过了**。
       *
       * ```text
       * 发什么 —— 什么都不发（不重发正文、不发"失败提示"、不写投递日志）
       * 记什么 —— 一条 `qq_group_task_dispatch_settled` 读数（带三态与具名理由，不含正文）
       * 不做什么 —— 不重试、不切侧信道补发、不记 `lg_turn_failed`
       * ```
       *
       * ⚠️ 必须放在 `replied && replyText` **之前**、`no_reply` 之后：
       *    `groupTaskDispatch` 出现时桥**刻意不带** `replyText`（单一发送出口），
       *    落到下面的 else 分支就会给群里发一句"这轮回复没有完成" ——
       *    那正是 P3-C 修掉的那个缺陷的**镜像**（成功被报成失败）。
       */
      if (response.groupTaskDispatch !== undefined) {
        const dispatch = response.groupTaskDispatch
        this.log({
          event: 'qq_group_task_dispatch_settled',
          requestId,
          ...(typeof dispatch.messageId === 'string' ? { messageId: dispatch.messageId } : {}),
          reason: dispatch.reason === undefined ? dispatch.status : `${dispatch.status}:${dispatch.reason}`,
        })
        return
      }
      if (response.outcome === 'replied' && typeof response.replyText === 'string' && response.replyText.trim()) {
        // Project/self citations are visible text; existing voice delivery already transports its own source appendix.
        if (response.knowledgeAppendix && (response as { media?: { mode?: string } }).media?.mode !== 'voice') {
          response = { ...response, replyText: response.replyText + '\n\n' + response.knowledgeAppendix }
        }
        /*
         * ADR-156 / P3-B：这一轮若归**群任务接管**，核心会在 `TURN_RESULT` 里带上
         * `groupTaskReply`（任务身份 + 群号）。它只在本条回复的投递期间生效：
         * 投递完立刻清空 ⇒ 不会污染下一条回复的放行判据。
         */
        const replyScope = groupTaskReplyScopeOf((response as { groupTaskReply?: unknown }).groupTaskReply)
        /*
         * 方案 §7.1：任务接管轮的回复**原生引用**这条入站消息。
         * ⚠️ 引用目标 = 本函数里已经校验过的 `id`（**真实入站**的 `message_id`），
         *    不是模型给的、也不是任何模型可见字段 ⇒ 伪造/跨群不可能成立。
         * ⚠️ 它挂在同一次发送上（不是第二条消息）⇒ 不额外占额度。
         */
        this.replyTaskScope = replyScope === undefined ? undefined : { ...replyScope, quoteMessageId: replyMessageId }
        const deliveryStarted = performance.now()
        try {
          await this.deliverTurnReply(response, socket, target, requestId, replyMessageId)
        } finally {
          this.replyTaskScope = undefined
          this.log({ event: 'qq_turn_timing', requestId, reason: JSON.stringify({ phase: 'delivery', durationMs: Math.round(performance.now() - deliveryStarted) }) })
        }
      } else {
        this.log({ event: 'lg_turn_failed', requestId })
        await this.sendText(response.code === 'image_input_disabled' ? '图片输入尚未启用。' :
          images ? '这轮看图没有完成，无法确认图片内容。请稍后重发。' :
          '这轮回复没有完成，消息可能已经记入会话。请稍后重新发送。', socket, target)
      }
    }).catch(() => this.log({ event: 'qq_delivery_failed', requestId })).finally(() => {
      this.queued--; const remaining = (this.userQueued.get(userId) ?? 1) - 1
      if (remaining === 0) this.userQueued.delete(userId); else this.userQueued.set(userId, remaining)
      if (groupId !== undefined) {
        const groupsRemaining = (this.groupQueued.get(groupId) ?? 1) - 1
        if (groupsRemaining === 0) this.groupQueued.delete(groupId); else this.groupQueued.set(groupId, groupsRemaining)
      }
    })
  }

  /**
   * 把一轮**已经过回复守卫**的结果投递出去（post-Lv2 / P1）。
   *
   * ```text
   * 没有媒介选择 / 选了 text           ⇒ 既有文字路径（**零**合成调用）
   * 选了 voice + 装了端口              ⇒ 合成 → 结构校验 → record 段
   * 选了 voice + 没装端口              ⇒ 文字兜底 + `voice_output_absent`
   * 选了 voice + 合成失败/超限/坏 WAV   ⇒ 文字兜底 + 具名原因
   * 选了 voice + 平台明确拒绝 record    ⇒ **一次**文字兜底（确定未发出）
   * 选了 voice + 超时/断开/无回执 id    ⇒ `delivery_unknown`：不重发、不兜底
   * ```
   *
   * ⚠️ 绝不做的事：把音频重发第二遍、把 `api_accepted` 说成"已听"、
   *    在权限被撤销后拿文字兜底绕过权限（兜底走的是同一条身份检查）。
   */
  private async deliverTurnReply(
    response: BridgeWireResponse,
    socket: WebSocket,
    target: { userId: string; groupId?: string },
    requestId: string,
    quoteMessageId?: string,
  ): Promise<void> {
    const replyText = response.replyText!
    const media = qqMediaSelectionOf((response as { media?: unknown }).media)
    const appendix = typeof (response as { mediaAppendix?: unknown }).mediaAppendix === 'string'
      ? String((response as { mediaAppendix: string }).mediaAppendix).trim()
      : ''
    const fallbackText = appendix === '' ? replyText : `${replyText}\n\n${appendix}`
    if (media === undefined) {
      await this.sendText(replyText, socket, target, undefined, quoteMessageId)
      return
    }
    /*
     * 逻辑回复键：**受信入站 requestId**（`qq:<bot>:private|group:<会话>:<message_id>`），
     * ⚠️ 不是每次重生成的 replyId —— 换键就等于绕过去重。
     */
    const key = `qq-reply:${requestId}`
    const journal = this.journal
    const startedAt = Date.now()
    if (journal === undefined) {
      this.log({ event: 'qq_delivery_journal_absent', requestId })
    } else {
      const reservation = this.reserveDelivery(journal, {
        key, requestId, purpose: 'reply', requested: media.mode, now: startedAt,
        ...(response.replyId === undefined ? {} : { replyId: response.replyId }),
        ...(response.traceId === undefined ? {} : { traceId: response.traceId }),
      })
      if (reservation === 'duplicate') {
        /* 同一逻辑回复已经投递过/留有结局 ⇒ **不再发第二条**（重启重投也走这里） */
        this.log({ event: 'qq_delivery_duplicate_skipped', requestId, reason: key })
        return
      }
      if (reservation === 'unavailable') {
        this.log({ event: 'qq_delivery_journal_unavailable', requestId, reason: 'reserve_unavailable' })
        if (media.mode === 'voice') {
          this.log({ event: 'qq_voice_fallback_text', requestId, reason: 'delivery_journal_unavailable' })
          await this.sendText(fallbackText, socket, target, undefined, quoteMessageId)
          return
        }
        /* 文字：日志坏了也不改变旧行为（只记录"去重不可用"） */
        await this.sendText(replyText, socket, target, undefined, quoteMessageId)
        return
      }
    }
    let synthesisFacts: Pick<QqDeliveryJournalEntry, 'ttsRequestId' | 'ttsUsage'> = {}
    const record = (entry: Partial<QqDeliveryJournalEntry> & Pick<QqDeliveryJournalEntry, 'status'>): void => {
      this.appendDelivery(journal, {
        at: Date.now(), key, requestId, purpose: 'reply', attempt: 1, ...synthesisFacts, ...entry,
      })
    }
    if (media.mode !== 'voice') {
      await this.sendRecordedText({
        text: replyText, socket, target, quoteMessageId, requestId, requested: 'text', record,
        ...(media.fallback === undefined ? {} : { reason: media.fallback }),
      })
      return
    }
    /*
     * ADR-156 / P3-I：**合成 + 结构校验**抽成一处（`synthesizeVoiceRecord`），
     * 正式回复（这里）与核心派发的群任务（`coreDispatchVoiceBody`）**共用同一套**：
     * 同一个端口 / `format==='wav'` / `wavDeliveryProblem` / `inspectWav` / `oneBotRecordFileUrl`。
     * ⚠️ 两处各写一份迟早漂移（一处放行超长音频、一处拦下），而漂移的代价是群里一条发不出去的语音。
     * ⚠️ 端口缺席（`voice_output_absent`）也走这一支：兜底文案与具名 reason 与改动前**逐字相同**。
     */
    const synthetic = await this.synthesizeVoiceRecord(replyText, requestId)
    if (!synthetic.ok) {
      this.log({ event: 'qq_voice_fallback_text', requestId, reason: synthetic.reason })
      record({
        status: 'fallback_text', requested: 'voice', effective: 'text', reason: synthetic.reason,
        ...(synthetic.synthMs === undefined ? {} : { synthMs: synthetic.synthMs }),
        totalMs: Date.now() - startedAt,
      })
      await this.sendRecordedText({ text: fallbackText, socket, target, quoteMessageId, requestId, requested: 'voice', record, reason: synthetic.reason })
      return
    }
    const audio = synthetic.audio
    // Store provider-reported units separately from estimates or monetary cost.
    synthesisFacts = {
      ...(synthetic.result.providerRequestId === undefined ? {} : { ttsRequestId: synthetic.result.providerRequestId }),
      ...(synthetic.result.usage === undefined ? {} : { ttsUsage: synthetic.result.usage }) }
    const synthMs = synthetic.synthMs
    const inspection = { durationMs: synthetic.durationMs }
    const textSha256 = sha256Text(replyText)
    const audioSha256 = sha256Bytes(audio)
    try {
      const messageId = await this.sendRecord(synthetic.fileUrl, socket, target, undefined, quoteMessageId)
      /*
       * ⚠️ 只记平台接受 + 结构读数：**不是**"她听到了"、**不是**"播放过"。
       *    音频时长/字节数是**读数**，不参与任何判据。
       */
      record({
        status: 'api_accepted', requested: 'voice', effective: 'voice', messageId: String(messageId),
        textSha256, audioSha256, audioBytes: audio.byteLength,
        audioDurationMs: inspection?.durationMs ?? 0, synthMs, totalMs: Date.now() - startedAt,
      })
      this.log({
        event: 'qq_voice_send_api_accepted',
        requestId,
        messageId,
        reason: `${audio.byteLength}b/${inspection?.durationMs ?? 0}ms`,
      })
      /* 来源附录作为**伴随文字**单独发、单独记结果（语音正文不念 URL） */
      if (appendix !== '') {
        await this.sendMediaAppendix({ appendix, key, requestId, socket, target, replyId: response.replyId })
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_voice_send_failed'
      if (code === 'onebot_api_failed') {
        /*
         * 平台**明确拒绝** ⇒ 可确认语音未发出 ⇒ 允许**一次**文字兜底。
         * ⚠️ 兜底走 `sendText`（同一条目标校验）：权限被撤时它同样会拒绝。
         */
        this.log({ event: 'qq_voice_fallback_text', requestId, reason: 'platform_rejected_record' })
        record({
          status: 'failed_confirmed', requested: 'voice', effective: 'voice', reason: 'platform_rejected_record',
          textSha256, audioSha256, audioBytes: audio.byteLength, audioDurationMs: inspection?.durationMs ?? 0,
          synthMs, totalMs: Date.now() - startedAt,
        })
        await this.sendRecordedText({ text: fallbackText, socket, target, quoteMessageId, requestId, requested: 'voice', record, reason: 'platform_rejected_record' })
        return
      }
      /* 超时 / 断开 / 接受了却没有回执 id ⇒ 结果不明：不重发，也不立即发同内容文字 */
      this.log({ event: 'qq_voice_delivery_unknown', requestId, reason: code })
      record({
        status: 'delivery_unknown', requested: 'voice', effective: 'voice', reason: code,
        textSha256, audioSha256, audioBytes: audio.byteLength, audioDurationMs: inspection?.durationMs ?? 0,
        synthMs, totalMs: Date.now() - startedAt,
      })
    }
  }

  /** 发送**文字**（正式回复或兜底），并把真实结局追加进投递日志 */
  private async sendRecordedText(input: {
    text: string
    socket: WebSocket
    target: { userId: string; groupId?: string }
    requestId: string
    quoteMessageId?: string
    requested: 'text' | 'voice'
    record: (entry: Partial<QqDeliveryJournalEntry> & Pick<QqDeliveryJournalEntry, 'status'>) => void
    reason?: string
  }): Promise<void> {
    const textSha256 = sha256Text(input.text)
    try {
      const messageId = await this.sendText(input.text, input.socket, input.target, undefined, input.quoteMessageId)
      input.record({
        status: 'api_accepted', requested: input.requested, effective: 'text', messageId: String(messageId),
        textSha256,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_send_failed'
      const status = this.classifySendFailure(code)
      input.record({
        status, requested: input.requested, effective: 'text', reason: code, textSha256,
      })
      this.log({
        event: status === 'delivery_unknown' ? 'qq_text_delivery_unknown' : 'qq_text_delivery_failed_confirmed',
        requestId: input.requestId,
        reason: code,
      })
    }
  }

  /** 语音回复的**伴随来源附录**：单独一条文字、单独记结果（失败不影响已发出的语音） */
  private async sendMediaAppendix(input: {
    appendix: string
    key: string
    requestId: string
    socket: WebSocket
    target: { userId: string; groupId?: string }
    replyId?: string
  }): Promise<void> {
    const journal = this.journal
    const record = (entry: Partial<QqDeliveryJournalEntry> & Pick<QqDeliveryJournalEntry, 'status'>): void => {
      this.appendDelivery(journal, {
        at: Date.now(), key: input.key, requestId: input.requestId, purpose: 'appendix' as QqDeliveryPurpose,
        attempt: 1, ...entry,
      })
    }
    if (journal !== undefined) {
      const reservation = this.reserveDelivery(journal, {
        key: input.key, requestId: input.requestId, purpose: 'appendix', requested: 'voice', now: Date.now(),
        ...(input.replyId === undefined ? {} : { replyId: input.replyId }),
      })
      if (reservation === 'duplicate') {
        this.log({ event: 'qq_appendix_duplicate_skipped', requestId: input.requestId })
        return
      }
      if (reservation === 'unavailable') {
        this.log({ event: 'qq_appendix_skipped', requestId: input.requestId, reason: 'delivery_journal_unavailable' })
        return
      }
    }
    const textSha256 = sha256Text(input.appendix)
    try {
      const messageId = await this.sendText(input.appendix, input.socket, input.target)
      record({ status: 'api_accepted', requested: 'voice', effective: 'text', messageId: String(messageId), textSha256 })
      this.log({ event: 'qq_appendix_send_api_accepted', requestId: input.requestId, messageId })
    } catch (error) {
      const code = error instanceof Error ? error.message : 'qq_appendix_send_failed'
      record({ status: this.classifySendFailure(code), requested: 'voice', effective: 'text', reason: code, textSha256 })
      this.log({ event: 'qq_appendix_send_failed', requestId: input.requestId, reason: code })
    }
  }

  /** 一次占用（失败关闭：日志异常一律当"不可用"，**不**猜它记下了没有） */
  private reserveDelivery(
    journal: QqDeliveryJournalPort,
    input: Parameters<QqDeliveryJournalPort['reserve']>[0],
  ): 'ok' | 'duplicate' | 'unavailable' {
    try {
      const result = journal.reserve(input)
      return result.ok ? 'ok' : result.reason
    } catch {
      return 'unavailable'
    }
  }

  /** 追加一条结局；写失败只记读数（日志对象会自己标坏 ⇒ 下一次语音发送回落到文字） */
  private appendDelivery(journal: QqDeliveryJournalPort | undefined, entry: Partial<QqDeliveryJournalEntry> & Pick<QqDeliveryJournalEntry, 'status'> & {
    at: number
    key: string
    requestId: string
    purpose: QqDeliveryPurpose
    attempt: number
  }): void {
    if (journal === undefined) return
    try {
      journal.append(entry as QqDeliveryJournalEntry)
    } catch (error) {
      this.log({ event: 'qq_delivery_journal_write_failed', reason: error instanceof Error ? error.message : 'append_failed' })
    }
  }

  /**
   * 发送失败的**结局分类**（闭集两态）。
   *
   * ⚠️ 发送**之前**就确定没发出去（未连接/目标不再获准/平台明确拒）
   *    ⇒ `failed_confirmed`；其余一律 `delivery_unknown`（宁可不说，也不重复）。
   */
  private classifySendFailure(code: string): 'failed_confirmed' | 'delivery_unknown' {
    return code === 'onebot_api_failed' || code === 'qq_target_no_longer_authorized' ||
      code === 'onebot_not_connected' || code === 'qq_delivery_disconnected'
      ? 'failed_confirmed'
      : 'delivery_unknown'
  }

  /**
   * **合成 + 结构校验 + 转成 OneBot `file` 值**（语音两条出口共用的唯一一处）。
   *
   * ```text
   * 端口缺席            ⇒ `voice_output_absent`（**不假装发过语音**）
   * 合成抛错/超时/坏结果 ⇒ 端口给的具名 reason（`voice_synthesis_timeout` …）
   * 格式不是 wav        ⇒ `voice_audio_not_wav`
   * 结构不合规/超限      ⇒ `wavDeliveryProblem` 的具名码（`voice_audio_too_large` …）
   * 通过               ⇒ `base64://` 的 record 文件值 + 结构读数
   * ```
   *
   * ⚠️ 它**只合成、不发送、不兜底**：兜底与记账由调用方做（两条出口的兜底授权不同：
   *    正式回复按媒介选择，群任务按任务声明的 `textFallback`）。
   * ⚠️ 返回值里**没有正文、没有音频内容**给日志用：只给字节数与时长（P3-I 契约 §2.6）。
   */
  private async synthesizeVoiceRecord(
    text: string,
    requestId: string,
  ): Promise<
    | {
      readonly ok: true
      readonly result: QqVoiceSynthesisResult
      readonly audio: Uint8Array
      readonly fileUrl: string
      readonly durationMs: number
      readonly synthMs: number
    }
    | { readonly ok: false; readonly reason: string; readonly synthMs?: number }
  > {
    const voice = this.voice
    if (voice === undefined) return { ok: false, reason: 'voice_output_absent' }
    const startedAt = Date.now()
    const synthetic = await this.synthesizeVoice(voice, text, requestId)
    const synthMs = Date.now() - startedAt
    if (!synthetic.ok) return { ok: false, reason: synthetic.reason, synthMs }
    const audio = synthetic.result.audio
    const problem = synthetic.result.format !== 'wav' ? 'voice_audio_not_wav' : wavDeliveryProblem(audio)
    if (problem !== undefined) return { ok: false, reason: problem, synthMs }
    const inspection = inspectWav(audio)
    return {
      ok: true,
      result: synthetic.result,
      audio,
      /* ⚠️ `sendRecord` 会在发之前再核一次 `base64://` 前缀与 `maxAudioBytes`（第二道，仍是同一处常量） */
      fileUrl: oneBotRecordFileUrl(audio),
      durationMs: inspection?.durationMs ?? 0,
      synthMs,
    }
  }

  /**
   * 合成一次（有界）。**只合成、不发送、不兜底** —— 兜底与记账由调用方做。
   *
   * ⚠️ 超时走 `Promise.race` **并且** abort 端口：端口若忽略 signal，外壳仍然
   *    按期限放弃等待（不让一次坏 TTS 把整条发送队列永远占住）。
   */
  private async synthesizeVoice(
    voice: QqVoiceOutput,
    text: string,
    requestId: string,
  ): Promise<{ ok: true; result: QqVoiceSynthesisResult } | { ok: false; reason: string }> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('voice_synthesis_timeout'))
      }, QQ_VOICE_LIMITS.maxSynthesisMs)
    })
    try {
      const result = await Promise.race([
        voice.synthesizer.synthesize({ text, deadlineMs: QQ_VOICE_LIMITS.maxSynthesisMs, signal: controller.signal }),
        timeout,
      ])
      if (result === null || typeof result !== 'object' || !(result.audio instanceof Uint8Array)) {
        return { ok: false, reason: 'voice_synthesis_bad_result' }
      }
      return { ok: true, result }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'voice_synthesis_failed'
      this.log({ event: 'qq_voice_synthesis_failed', requestId, reason: code })
      return { ok: false, reason: code }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async drain(): Promise<void> { await this.queue }

  async close(): Promise<void> {
    this.stopping = true
    await this.drain()
    const socket = this.socket
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((done) => {
        socket.addEventListener('close', () => done(), { once: true })
        socket.close()
      })
    }
  }
}
