/**
 * 后 Lv2 · WP1 —— **LG 入口桥**（受限聊天/事件入口）。
 *
 * ============================================================================
 *  载体：计划书 §4 / §9 / §10（WP1）· ADR-091 §4（`D10`–`D13` / `INV-PL2-09`）
 * ============================================================================
 * 它是什么：一个**很窄**的桥。外壳（VTuber / 语音服务 / 别的客户端）只能通过它
 * 提交一句话、拿到**已经过回复守卫**的回复。它**不是**第二个角色，也**不是**第二个事实权威。
 *
 * ---------------------------------------------------------------------------
 *  四条硬边界（计划 §4 / ADR-091）
 * ---------------------------------------------------------------------------
 * ```text
 * ① 同一套轮次装配（INV-PL2-09）
 *    桥**不得**只调裸模型，也**不得**自己构造 prompt。
 *    prompt 的唯一入口是 ContextCompiler（经 TurnGateway.compileTurn），
 *    而"模型调用的输入"只能是那一份 packet —— 桥连 packet 都拿不到。
 *
 * ② 身份与会话不由外壳决定（INV-PL2-08）
 *    皮套/语音服务的 system_prompt、历史重载、默认记忆**都不参与** LG 推理。
 *    角色与会话由**装配层**在构造时绑定；请求无法把它改成别的角色/会话。
 *
 * ③ 失败不转入默认 Agent
 *    桥失败就是失败（`failed` + 具名理由码），**绝不**回落到外壳自带的聊天 Agent。
 *    这条不是"礼貌"：VTuber 的默认 Agent 有自己的记忆与人格，回落
 *    等于在用户不知情时换了一个角色说话。
 *
 * ④ 不新增能力
 *    这个入口**只**提交对话轮次。它不暴露动作、搜索、代码执行、
 *    GitHub、微信/QQ 或任何后台任务的执行面。
 * ```
 *
 * ⚠️ 刻意**不**做的事：不建立"万能连接器框架"。只有这一个入口、只有这一个方法。
 */

import { KernelError } from '../../contracts/ids.ts'
import {
  bindSpeechExpression,
  decodeExpressiveSpeech,
  type SpeechExpression,
} from '../../contracts/expressive-speech.ts'
/* Lv4.5 / ADR-131：机会报文的入口字面量**只有一处**（不在这里另写 'avatar'） */
import { OPENING_ENTRY } from '../../contracts/proactive-opening.ts'
import {
  arbitrateCharacterOutput,
  buildLookupNoticeCandidate,
  buildMidTurnCorrectionCandidate,
  buildWakeResponseCandidate,
  LOOKUP_NOTICE_CUE,
  MID_TURN_CORRECTION_CUE,
  WAKE_RESPONSE_CUE,
  type CharacterOutputCandidate,
  type CharacterOutputDecision,
  type FloorState,
} from './character-output.ts'
import { detectFastSignal } from './fast-signal.ts'
import { imageInputShapeError, type ImageInput } from '../../contracts/image-input.ts'
import type { CheckedSpeechSegment } from './streaming-speech.ts'
/*
 * ⚠️ 复用 M5.5 的**显式检索词形判定器**（纯函数、只依赖 contracts）。
 *    不另发明一套触发词：那会让"提前查"与"正式查"变成两处授权实现，
 *    而两处迟早会漂移（一处放行、一处拦下）。
 */
import { createExternalEvidenceIntentDetector } from '../../action/external-evidence-intent.ts'

// ---------------------------------------------------------------------------
// 端口（装配层实现；桥本身不碰数据库、不碰模型、不碰 prompt）
// ---------------------------------------------------------------------------

/** 一轮的结局（**六态分列**，不许互相代替；ADR-091 `D10`–`D13`） */
export type BridgeTurnOutcome =
  /** 走完了 LG 正式轮次，回复**已提交**（生成账已落） */
  | 'replied'
  /**
   * 桥拒绝了这个请求（形状非法 / 越界 / 序号过期）。
   * ⚠️ 这是**正常结果**，不是故障 —— 与 FC-03 的 `rejected` 同一个立场。
   */
  | 'rejected'
  /** 轮次中途失败（模型不可达、守卫链抛错……）。**已提交的部分不撤销**。 */
  | 'failed'

export interface BridgeSubmitRequest {
  images?: readonly ImageInput[]
  streamSpeech?: boolean
  /** 用户这一轮说的话（外壳负责把它从语音/文本变成字符串；桥不做 ASR） */
  userText: string
  /**
   * 桥的**幂等键**（外壳重连后可能重发同一条）。
   *
   * ⚠️ 重复提交同一个 key ⇒ 直接返回**上一次**的结果，不产生第二轮对话。
   * 这条与 ADR-091 `D13` 的"重连默认不自动重播已提交的句子"是同一件事的两侧。
   */
  requestId: string
  /**
   * Lv4.5 / `P3`（中途纠正）：这一轮在**回答哪一次开口**。
   *
   * ⚠️ 与 `PREPARE_TURN` 的 `utteranceKey` 是**同一把不透明键**
   *    （`<clientId>:<utterance>`，由外壳在 VAD 边界处给出）。
   *    "提前检索的那次开口"与"她正在说的这一轮"逐字比对，
   *    决定晚到的证据是**纠正**还是**提醒**（见 `lastSubmittedUtteranceKey`）。
   * ⚠️ 可选：没有它 ⇒ 判据不成立 ⇒ 一律走提醒（失败关闭，不猜）。
   */
  utteranceKey?: string
  /**
   * `ADR-139` `D01`：这一轮的**入站平台事实**（可选）。
   *
   * ⚠️ 缺席 = 逐字旧行为；出现但形状非法 ⇒ `validate()` 具名拒绝整轮（`D04`）。
   * ⚠️ 它**不是**授权，也**不能**选入口（`D02`）。
   */
  platformFacts?: BridgeInboundPlatformFacts
  groupContext?: readonly BridgeGroupContextLine[]
}

export interface BridgeSubmitResult {
  streamStatus?: 'completed' | 'interrupted' | 'cancelled'
  /** LG-owned sidecar bound to the final checked reply; never a new action permission. */
  expression?: SpeechExpression
  outcome: BridgeTurnOutcome
  /**
   * 生成段内部的**阶段耗时**（`P4` 后的时延修复；可选）。
   *
   * ⚠️ 它**只是读数**：不参与任何判据、不进账本、不含正文。
   *    存在的理由是"生成是黑盒"——没有它就只能对整段 22.8 s 干瞪眼。
   */
  timings?: {
    contextMs: number
    beginTurnMs: number
    evaluationsMs: number
    compileMs: number
    stateMs: number
    modelMs: number
    guardsMs: number
    completeMs: number
  }
  /** 具名理由码（`outcome !== 'replied'` 时必有） */
  code?: string
  /** 已经过回复守卫的回复正文（`outcome === 'replied'` 时必有） */
  replyText?: string
  /** LG 侧的轮次身份（外壳只能用它们做对账，**不能**用它们换角色/会话） */
  replyId?: string
  traceId?: string
  /** 这一轮实际提交的领域事件 id（**只报计数与 id，不带正文**） */
  domainEventIds?: readonly string[]
  /**
   * 本轮回复守卫的观测三态（**只放枚举标签，不含正文**）。
   *
   * ⚠️ 它**不**进 trace、**不**落库：它只是让调用方（外壳 / 验收门）能对账
   * "这一轮的文本真的过了一遍守卫链"。回复**是否合规**由行为门单独判。
   */
  guardStates?: readonly string[]
  /**
   * 交付真相（ADR-091 `D10`）：这一轮走到了哪一步。
   *
   * ⚠️ `'generated'` **不等于** `'played'`：桥只负责生成与提交，
   * 播放确认由客户端上报（`INV-PL2-10`）。桥**从不**声称"已经播出"。
   */
  delivery: 'generated' | 'rejected' | 'failed'
}

/**
 * 装配层实现的端口（**唯一**的模型与数据库持有者）。
 *
 * ⚠️ 端口的形状让桥**在类型上就拿不到** prompt 与模型：
 * 它只能给一句用户文本，拿回一段已经过守卫的回复。
 */
export interface TurnBridgeHost {
  /**
   * 跑完**一个正式轮次**：`beginTurn` → `compileTurn` → 模型 → 回复守卫 → `completeTurn`。
   *
   * 实现必须与 `src/main.ts` 的轮次链**同一套**（同一批守卫、同一个编译器）。
   */
  runTurn(input: {
    userText: string
    requestId: string
    images?: readonly ImageInput[]
    onSpeechSegment?: (segment: CheckedSpeechSegment) => void
    /**
     * ★ U1 / `WP2b-2b`（`ADR-139` `D01`）：**本轮入站平台事实** —— 可选。
     *
     * ⚠️ 它**不是**身份，是**证据**：由 host（装配层，进程内）用 `resolveInboundTurnScope`
     *   结合绑定清单 / 群白名单解析出本轮作用域。桥只负责**原样转交**，自己**不**解析。
     * ⚠️ 缺席 ⇒ 不传 ⇒ host 那一层不解析 ⇒ 逐字旧行为（会话级作用域）。
     */
    platformFacts?: BridgeInboundPlatformFacts
    groupContext?: readonly BridgeGroupContextLine[]
  }): Promise<HostTurnResult>
  /**
   * 请求取消一轮（后 Lv2 · `L-PL2-04`）。
   *
   * ⚠️ **可选**是刻意的：不支持取消的 host（例如守门的 stub）仍然合法，
   * 而桥会把"没有这个能力"如实报成 `cancel_capability_absent`，
   * **不会**假装已取消（失败关闭）。
   *
   * ⚠️ 实现必须遵守两条：
   * ```text
   * ① 它是**协作式**的：只是"记下意图"，真正停下发生在 host 自己的检查点
   * ② 它**不能撤销**任何已提交的东西：已提交 ⇒ 如实报 `alreadyCommitted: true`
   * ```
   */
  cancelTurn?(input: { requestId: string; reason?: string }): Promise<BridgeCancelReading>
  /**
   * Lv4.5 / `P3`（选项 B）：**边听边查**的检索读数。
   *
   * ⚠️ 这一支与 `runTurn` **不是**同一件事：
   * ```text
   * runTurn      —— 一个正式轮次（会写账、会落用户事件、会花一次模型调用）
   * prepareLookup —— 一次**只读**的提前检索：只为"能不能提前说一句'查到了'"
   * ```
   * 因此它**必须**是只读的（不落用户事件、不写记忆），且**失败关闭**：
   * 没有这个能力 ⇒ 如实报 `lookup_capability_absent`，**不假装查过**。
   */
  prepareLookup?(input: { userText: string; query: string; requestId: string }): Promise<BridgeLookupReading>
  /**
   * Lv4.5 / ADR-131 `D01`：**皮套入口的一次主动开口机会**。
   *
   * ```text
   * 输入：外壳报来的空闲读数（`idleMs`）—— **只作为提示**，host 不信任它
   * 输出：一次**已经过全部闸与守卫**的裁决（说 / 不说 + 具名理由）
   * ```
   *
   * ⚠️ 三条纪律（与 ADR-131 一致）：
   * ```text
   * ① 它**不写** `user_message`、**不**占正式轮次、**不**写记忆
   * ② **说不说由 host（LG）决定**：外壳只报事实，不提供正文、不指定说不说
   * ③ 没有这个能力 ⇒ 如实报 `opening_capability_absent`，**不假装**评估过
   * ```
   * ⚠️ 可选是刻意的：这条能力在 WP5 之前在**结构上不存在**，
   *    而"不存在"必须是可读的读数，不是一次静默的无事发生。
   */
  openingOpportunity?(input: {
    requestId: string
    entry: string
    idleMs: number
    /**
     * ★ **桥自己的读数**（WP5b 侦察修正）：候选版本。
     *
     * ⚠️ 它**必须** ≥ `floor.userRevision`，否则会立刻被既有仲裁判成
     *    `output_stale_against_user_revision`。桥按"已提交轮数 + 1"给。
     */
    turnRevision: number
    /**
     * ★ **桥自己的读数**：话权。
     *
     * ⚠️ `userSpeaking` 在这里**恒为 `false`** —— 因为**报文的前提就是"外壳空闲"**。
     *    桥**没有**独立的 VAD 读数（VAD 在 Python 外壳里），所以它只能采用报文的前提。
     *    ⇒ 推论：预检里的 `opening_user_is_speaking` 在**报文路径下不可达**（见 Known-Limitations）。
     */
    floor: FloorState
    /**
     * ★ **桥自己的读数**：出站通道在不在。
     *
     * ⚠️ 装配层**看不到**它（`outputSink` 是桥的私有状态）。
     *    没有它，预检就没法在**调模型之前**拒 —— 那会变成"生成完才发现没人听"。
     */
    hasLiveClient: boolean
  }): Promise<BridgeOpeningReading> | BridgeOpeningReading
  /**
   * 她**此刻是不是正在说话**（供"边听边查"判断时机）。
   *
   * ⚠️ 可选：拿不到时**不猜**（桥按"不知道"处理，见 `emitLookupNotice`）。
   */
  sheIsSpeaking?(): boolean
  /**
   * Lv4.5 / `P3`（中途纠正）：**废弃她当前回复里还没播的那些句子**。
   *
   * ```text
   * 语义：那些句子是在**没有这条证据**的情况下生成的 ⇒ 不该再播
   * 返回：真的被作废了几段（`0` 也是有效读数 ⇒ "当时没有未播余句"）
   * ```
   * ⚠️ 它**不撤销**任何已提交的东西：说过的那部分照旧算数（与取消同一条纪律）。
   */
  supersedeUnplayed?(input: { by: string; reason: string }): number
  /**
   * Lv4.5 / `P1`：接收**TTS / 外壳**的合成完成回报（契约 §1 的合成账）。
   *
   * ⚠️ 它**不是**可选的礼貌动作：契约 §1 明确要求合成账**带 `audioId`**，
   *    而交付账的迁移表里 `generated → queued` **没有这条路**
   *    （"合成完成"必须留下一个可对账的音频标识别，才有资格谈播放）。
   *    因此"客户端报告了播放"这件事在账上的前置条件正是这一条。
   *
   * ⚠️ 与 `cancelTurn` 同一条纪律：**可选** —— 不传的 host 会把回报如实报成
   *    `synthesis_report_unsupported`，**不会**假装记下了。
   */
  reportSynthesized?(input: {
    segmentId: string
    audioId: string
    at?: number
    reason?: string
  }): Promise<BridgeSynthesisReportResult> | BridgeSynthesisReportResult
  /**
   * 接收**客户端**的播放回报（Lv4.5 / `P1`；契约 §1 的交付账）。
   *
   * ⚠️ 与 `cancelTurn` 同一条纪律：**可选** —— 没有交付账的 host
   * （守门 stub / 纯文本入口）仍然合法，桥会把回报如实报成
   * `playback_report_unsupported`，**不会**假装记下了。
   *
   * ⚠️ 它**不能**凭空制造"已播出"：写进账的每一跳都要过 `media-delivery.ts`
   * 的迁移表，而 `generated`/`synthesized` 都到不了 `playing`/`played`。
   */
  reportPlayback?(input: {
    segmentId: string
    state: BridgePlaybackState
    at?: number
    playedFrom?: number
    playedTo?: number
    reason?: string
  }): Promise<BridgePlaybackReportResult> | BridgePlaybackReportResult
  /**
   * 接收**QQ 投递回执**（post-Lv2 / ADR-110 `D06`/`D08`）。
   *
   * ⚠️ 与 `reportPlayback` 同一条纪律：**可选** —— 没有投递登记的 host
   *    （守门 stub / 非 QQ 入口）仍然合法，桥会把回执如实报成
   *    `qq_delivery_report_unsupported`，**不会**假装记下了。
   *
   * ⚠️ 实现必须遵守三条（`D08` 的表格）：
   * ```text
   * ① 只有 `api_accepted` 才允许带 `messageId`（带不出来就是结果不明，不是接受）
   * ② 未知 / 旧代次的 `deliveryId` ⇒ `accepted: false`（**不**当失败，也**不**改别的行）
   * ③ 它**不**允许把"结果不明"改成"接受"（状态机在登记那一侧失败关闭）
   * ```
   */
  reportReminderDelivery?: TurnBridgeHost['reportQqDelivery']
  reportQqDelivery?(input: {
    deliveryId: string
    status: BridgeQqDeliveryStatus
    messageId?: string
    attempt?: number
    reason?: string
  }): Promise<BridgeQqDeliveryReportResult> | BridgeQqDeliveryReportResult
  /**
   * **只读准备**（Lv4.5 / `P2` · "边听边准备"）。
   *
   * ⚠️ 它是本桥唯一一个**只读**的入口，而这条边界必须由实现保证、由门检查：
   * ```text
   * ① 不写任何东西：不写 user_message、不落事件、不写记忆、不推进序号
   *    （一轮话只该有一条 user_message —— 反复"准备"不得把它变成七八条）
   * ② 只回 id 与计数：正文留在账本里，端口形状让它拿不到
   * ③ 幂等：同一个 `candidateRevision` 重复准备 ⇒ 返回同一份读数
   * ```
   *
   * ⚠️ 与 `cancelTurn` 同一条纪律：**可选** —— 不传的 host 会被桥如实报成
   *    `prepare_capability_absent`，**不会**假装准备了什么。
   */
  prepareTurn?(input: {
    userText: string
    requestId: string
    candidateRevision?: string
  }): Promise<BridgePrepareReading> | BridgePrepareReading
  /** 装配层绑定的角色 id（外壳**不能**改） */
  readonly characterId: string
  /** 装配层绑定的会话 id（外壳**不能**改） */
  readonly conversationId: string
}

export interface HostTurnResult {
  streamStatus?: BridgeSubmitResult['streamStatus']
  expression?: SpeechExpression
  /**
   * **已经过回复守卫**的正文。
   *
   * ⚠️ 端口的形状把这件事写进了契约：host 交出来的必须是**检查后**的文本。
   * 桥**没有**守卫链，也**不**应该有一条 —— 它只负责运输与幂等，
   * 拿未检查的 token 直接播出正是计划 §7 点名要避免的第一版错误。
   */
  replyText: string
  replyId: string
  traceId: string
  domainEventIds: readonly string[]
  /**
   * 本轮回复守卫的**观测三态**（可选；只放枚举标签与标记词，**不含正文**）。
   *
   * 它由 host 从 `main.ts` 那条链带出来（`CompleteTurnInput.replyGuards` 的同源读数），
   * 用于对账"这一轮守卫到底跑没跑"——**不是**产品判据。
   */
  guardStates?: readonly string[]
  /**
   * 生成段内部的**阶段耗时**（毫秒；可选）。
   *
   * ============================================================================
   *  它为什么必须走协议
   * ============================================================================
   * §3 的"首段实质语音"在干净窗口里 **9/9 超 5 000 ms**，而拆解显示时间几乎都在
   * "提交 → 正文"这一段里（生成 ≈22.8 s vs 合成 ≈1.9 s）。可"生成"本身还是个黑盒：
   * ```text
   * 装配上下文（providers）· 状态推进 · **模型调用** · 回复守卫 · 落账
   * ```
   * 不拆开就不知道该改哪一个 —— 而 `modelSeconds` 原本只 `logger.info` 到 **stdout**，
   * 也就是**桥的协议通道**，外壳会丢弃它（本批实测过这个坑）⇒ 生产上**读不到**。
   * ⇒ 所以它随 `TURN_RESULT` 回给外壳，进 `/lg/status`。
   */
  timings?: {
    /** 装配上下文（providers → prompt） */
    contextMs: number
    beginTurnMs: number
    evaluationsMs: number
    compileMs: number
    /** 状态推进（读当前状态 + 标记互动） */
    stateMs: number
    /** **模型调用**（`useModel(TEXT_LARGE)`） */
    modelMs: number
    /** 回复守卫链 */
    guardsMs: number
    /** 落账（`completeTurn`） */
    completeMs: number
  }
}

// ---------------------------------------------------------------------------
// 桥
// ---------------------------------------------------------------------------

export interface TurnBridgeOptions {
  host: TurnBridgeHost
  /** 单条用户文本的长度上限（防"外壳把整段录音转写当一轮塞进来"） */
  maxUserTextLength?: number
  /** 幂等缓存的容量上限（FIFO 淘汰；只缓存**结局**，不缓存 prompt） */
  idempotencyCacheSize?: number
  now?: () => number
}

/** 默认上限：一轮用户话 4000 字符（远超正常发言，低于"整段转写"） */
export const DEFAULT_MAX_USER_TEXT_LENGTH = 4000
const DEFAULT_IDEMPOTENCY_CACHE = 64

/**
 * 主动投递正文的**码点**上界（post-Lv2 / ADR-110 `D07`）。
 *
 * ⚠️ 与通知实例的候选正文上界**同一口径**（那里也有 500 的上界与表级 CHECK）——
 *    这里是**结构性兜底**：桥不校验"正文质量"，但"一条要发到真人手机上的文字有多长"
 *    是它可以且应该挡住的东西。
 */
export const QQ_DELIVERY_TEXT_MAX_CODEPOINTS = 500

interface CachedOutcome {
  result: BridgeSubmitResult
  at: number
}

/**
 * 受限入口桥。
 *
 * 它做的事只有三件：**校验形状** → **幂等查表** → **委派给装配层**。
 * 任何"我顺便帮你处理一下"的冲动都应当被拒绝：那是第二个角色的起点。
 */
export class TurnBridge {
  private readonly host: TurnBridgeHost
  private readonly maxUserTextLength: number
  private readonly idempotencyCacheSize: number
  private readonly now: () => number
  private readonly idempotency = new Map<string, CachedOutcome>()
  /**
   * Lv4.5 / `P3`：**出站**通道（由传输层注入；见 {@link setOutputSink}）。
   *
   * ⚠️ 缺省 `undefined` = 没有通道 ⇒ `emitCharacterOutput` 如实报
   *    `output_channel_absent` 并**什么都不写**（失败关闭，不假装说过）。
   */
  private outputSink: ((message: BridgeWireResponse) => void) | undefined
  /**
   * Lv4.5 / `P3`：**有限插话**的总开关（缺省 **false**）。
   *
   * ⚠️ 缺省关的理由与仓库里其它能力一致："新增的主动行为"必须显式开启才生效；
   *    关着时 `emitCharacterOutput` 一次都不会被调用 ⇒ 行为与接线前**逐字相同**。
   */
  interjectionEnabled = false
  /** 已提交的轮次数（"用户当前版本"的读数；只增不减） */
  private submittedTurns = 0
  /** 呼唤回应自己的计数（与轮次数相加构成候选版本，保证**新于**用户版本） */
  private wakeRevision = 0
  /**
   * 已经答过呼唤的那一次"开口"的**键**（见 {@link emitWakeResponse}）。
   *
   * ⚠️ 键由外壳给（`<客户端 id>:<开口序号>`），桥**不解释**它的内部结构 ——
   *    它只需要"同一个键 ⇒ 同一次开口"。`null` = 还没答过。
   */
  private wakeAnsweredUtteranceKey: string | null = null
  /**
   * 已经为**哪一次发音**发起过提前检索（`P3` 选项 B）。
   *
   * ============================================================================
   *  为什么必须有它（这是一个**花钱**的判据）
   * ============================================================================
   * 流式 partial 是**反复**到达的：用户说"帮我搜一下今天的天气"这**一句**话，
   * 外壳会送出**多条** `PREPARE_TURN`（字数每涨一点就送一条）。
   * 没有去重 ⇒ **每一条 partial 都买一次检索** —— 一次出站变成十几次。
   *
   * ⚠️ 与呼唤回应用的**同一把键**（`<clientId>:<utterance>`）：它是外壳给的**不透明**标识，
   *    不是文本 —— 用文本当键会让"同一句话被识别成两种写法"变成两次检索。
   * ⚠️ 键为**空/缺失**时**不去重**（宁可多花一次，也不要因为外壳没给键就永远不查）。
   * ⚠️ 只保留**最近一个**键：同一时刻只有一个发音在推进（这是流式识别的性质），
   *    而无限增长的集合会变成一个没人清理的内存账。
   */
  private lookupUtteranceKey: string | null = null
  /**
   * **正在被回答的那次开口**（`P3` 中途纠正的相关键）。
   *
   * ============================================================================
   *  为什么必须有它（它决定"提醒"还是"纠正"）
   * ============================================================================
   * ```text
   * 提前检索是**为某一次开口**发起的（partial 的 `<clientId>:<utterance>`）
   * 而她那一条回复是**为哪一次开口**生成的 —— 由 `SUBMIT_TURN` 带过来
   *
   * 两者**相同** ⇒ 那条证据是在她**已经开始回答这个问题之后**才到的
   *            ⇒ 她剩下的未播句子是在**没有这条证据**的情况下生成的 ⇒ **陈旧** ⇒ 该纠正
   * 两者**不同** ⇒ 那条证据是给**另一个**问题的 ⇒ 只是一句提醒，不构成纠正
   * ```
   * ⚠️ 这正是计划 §3 验收行"新证据在语音播放中到达，旧余句失效"的**机器可判**形式：
   *    它不需要判断"内容冲不冲突"（那是语义判断），只需要判断**归属**。
   */
  private lastSubmittedUtteranceKey: string | null = null
  /**
   * 已经为**哪一次开口**给过"用户更正"的纠正段（`P3`）。
   *
   * ⚠️ 与检索去重同一条理由：partial 反复到达 ⇒ 用户说一句"不对"会送来**多条**候选，
   *    不去重就会**每条都废一次余句、都说一句纠正**。
   * ⚠️ 键为空 ⇒ **不去重**（宁可多说一次，不要因为外壳没给键就永远不纠正）。
   */
  private correctionUtteranceKey: string | null = null
  /** 出站读数（只计数与最后一个理由码；**不含**正文） */
  private readonly outputReadingState = {
    spoken: 0,
    dropped: 0,
    yielded: 0,
    spokenWithoutExpression: 0,
    /**
     * 因为"这一次开口已经答过呼唤"而**没有**再答的次数。
     *
     * ⚠️ 它必须单独计数：与 `dropped` 混在一起，就再也看不出"她被叫了三次只答一次"
     *    是**设计**（去重生效）还是**故障**（她哑了）。
     */
    suppressedWake: 0,
    lastCode: null as string | null,
  }
  /** 串行闸：一个会话的**正式写入轮次**必须串行（ADR-091 `D12`） */
  private tail: Promise<unknown> = Promise.resolve()
  /**
   * 主动投递的**出站读数**（只计数与最后一个理由码；**不含**正文）。
   *
   * ⚠️ 与 `outputReadingState` 分列：两者是两条线（有限插话 vs 主动联系），
   *    混在一起就再也分不清"她没插话"与"主动投递被拒"。
   */
  private readonly qqDeliveryReadingState = {
    written: 0,
    refused: 0,
    lastCode: null as string | null,
    lastDeliveryId: null as string | null,
  }

  constructor(options: TurnBridgeOptions) {
    if (!options.host) {
      throw new KernelError('validation_error', 'bridge_without_host', '入口桥必须由装配层提供 host')
    }
    if (options.host.characterId.trim() === '' || options.host.conversationId.trim() === '') {
      throw new KernelError(
        'validation_error',
        'bridge_without_identity',
        '入口桥必须在构造时绑定角色与会话：外壳**不得**决定它们（INV-PL2-08）'
      )
    }
    this.host = options.host
    this.maxUserTextLength = options.maxUserTextLength ?? DEFAULT_MAX_USER_TEXT_LENGTH
    this.idempotencyCacheSize = options.idempotencyCacheSize ?? DEFAULT_IDEMPOTENCY_CACHE
    this.now = options.now ?? Date.now
  }

  /** 装配层绑定的身份（外壳**只能读**） */
  get identity(): { characterId: string; conversationId: string } {
    return { characterId: this.host.characterId, conversationId: this.host.conversationId }
  }

  /**
   * 提交一轮。
   *
   * **失败关闭**的三处（每一处都有具名理由码，且**都不回落**默认 Agent）：
   *   ① `requestId` 形状非法 ⇒ `rejected` / `bridge_bad_request_id`
   *   ② `userText` 空、全空白或超长 ⇒ `rejected` / `bridge_bad_user_text`
   *   ③ 装配层抛错 ⇒ `failed` / `bridge_turn_failed`（**不**吞掉、**不**改用别的 Agent）
   */
  async submit(request: BridgeSubmitRequest): Promise<BridgeSubmitResult> {
    const shape = this.validate(request)
    if (shape !== undefined) {
      return { outcome: 'rejected', code: shape, delivery: 'rejected' }
    }

    /*
     * Lv4.5 / `P3`：这一轮提交了 ⇒ 把它算作**已经翻过页**。
     *
     * ⚠️ 它**不是**唯一的翻页方式：真正的翻页由外壳的 `utteranceId`（VAD 边界后 +1）
     *    驱动。这里只是让"提交了却仍带着旧 utteranceId"的客户端也不至于永久哑掉。
     */
    this.submittedTurns += 1
    /*
     * Lv4.5 / `P3`（中途纠正）：记下**这一轮在回答哪一次开口**。
     *
     * 外壳在 `SUBMIT_TURN` 上带 `utteranceKey`（与 `PREPARE_TURN` **同一把不透明键**）。
     * 于是"提前检索的那次开口"与"她正在说的这一轮"可以**逐字比对** ——
     * 相同 ⇒ 证据是在她开始回答之后才到的 ⇒ 剩下的未播句子陈旧 ⇒ 该纠正；
     * 不同 ⇒ 那是给别的问题的证据 ⇒ 只是一句提醒。
     * ⚠️ 外壳不带（例如打字输入、没有 VAD 边界）⇒ 记 `null` ⇒ 判据**不成立**，
     *    于是一律走"提醒"那条路（宁可少纠正，不可错纠正）。
     */
    this.lastSubmittedUtteranceKey = request.utteranceKey ?? null

    const cached = this.idempotency.get(request.requestId)
    if (cached !== undefined) {
      /*
       * ⚠️ 幂等命中返回的是**同一份结果对象**（含同一个 replyId/traceId）。
       * 这不是缓存优化，而是**语义**：重连后的重发**不得**产生第二轮对话、
       * 不得再写一条用户事件、不得再消耗一次模型调用。
       */
      return cached.result
    }

    // 串行闸：正式写入轮次一个接一个（"听/准备/播放重叠"不等于两个正式轮次同时写库）
    const run = this.tail.then(
      async () => this.runGuarded(request),
      async () => this.runGuarded(request)
    )
    this.tail = run.catch(() => undefined)
    const result = await run
    this.remember(request.requestId, result)
    return result
  }

  private async runGuarded(request: BridgeSubmitRequest): Promise<BridgeSubmitResult> {
    try {
      const outcome = await this.host.runTurn({
        userText: request.userText,
        requestId: request.requestId,
        ...(request.images !== undefined ? { images: request.images } : {}),
        /*
         * ★ U1 / `ADR-139` `D01`：本轮的入站平台事实**原样转交**给 host（装配层去解析）。
         * ⚠️ 缺席 ⇒ 不加这个键 ⇒ host 不解析 ⇒ 逐字旧行为。
         * ⚠️ 形状已由 `validate()` 判过（`:2534` 那一格）；这里**不重复判**。
         */
        ...(request.platformFacts !== undefined ? { platformFacts: request.platformFacts } : {}),
        ...(request.groupContext !== undefined ? { groupContext: request.groupContext } : {}),
        ...(request.streamSpeech && this.outputSink !== undefined ? {
          onSpeechSegment: (speech: CheckedSpeechSegment) => this.outputSink?.({
            kind: 'SPEECH_SEGMENT', requestId: request.requestId, outcome: 'generated', speech,
          }),
        } : {}),
      })
      if (
        typeof outcome.replyText !== 'string' ||
        outcome.replyText.trim() === '' ||
        typeof outcome.replyId !== 'string' ||
        outcome.replyId.trim() === '' ||
        typeof outcome.traceId !== 'string' ||
        outcome.traceId.trim() === ''
      ) {
        return { outcome: 'failed', code: 'bridge_host_incomplete_result', delivery: 'failed' }
      }
      return {
        outcome: outcome.streamStatus === 'interrupted' || outcome.streamStatus === 'cancelled' ? 'failed' : 'replied',
        ...(outcome.streamStatus !== undefined ? { streamStatus: outcome.streamStatus } : {}),
        ...(outcome.streamStatus === 'interrupted' || outcome.streamStatus === 'cancelled'
          ? { code: `speech_stream_${outcome.streamStatus}` } : {}),
        replyText: outcome.replyText,
        replyId: outcome.replyId,
        traceId: outcome.traceId,
        domainEventIds: [...outcome.domainEventIds],
        ...(outcome.guardStates !== undefined ? { guardStates: [...outcome.guardStates] } : {}),
        delivery: outcome.streamStatus === 'interrupted' || outcome.streamStatus === 'cancelled' ? 'failed' : 'generated',
        ...(outcome.expression !== undefined ? { expression: outcome.expression } : {}),
        /* `P4` 后的时延修复：阶段耗时**原样**带出去（只是读数，不参与任何判据） */
        ...(outcome.timings !== undefined ? { timings: outcome.timings } : {}),
      }
    } catch (error) {
      /*
       * ⚠️ 失败**不**回落、**不**重试、**不**改用外壳自带的聊天 Agent。
       * 理由见文件头第 ③ 条：VTuber 的默认 Agent 有自己的记忆与人格。
       * 错误信息只带**具名码**，不带 prompt / 正文 / key。
       */
      const code = error instanceof KernelError ? error.code : 'bridge_turn_failed'
      /*
       * ======================================================================
       *  诊断必须留在**某个地方**（2026-10-05 事故修复）
       * ======================================================================
       * 协议上只回具名码是对的（外壳不需要、也不该拿到细节）。但**丢掉 message**
       * 会让"契约为什么拒收"这件事完全不可查：真实事故里只有一个
       * `turn_content_list_invalid`，而真正的原因（`一轮最多 6 份内容，收到 10`）
       * 就写在 message 里 —— 查了很久才通过读账本原始字节复原出来。
       *
       * ⇒ 走 **stderr**：桥的 stdout 是 NDJSON 协议通道，写日志在生产上读不到
       *   （这一批实测过这个坑）。这里的 message 只含字段名 / 上限 / id / 计数，
       *   不含任何正文；再压成一行、截断到 400 字符。
       */
      if (error instanceof KernelError) {
        console.error(`[bridge] 轮次失败 code=${code} · ${singleLine(error.message, 400)}`)
      }
      return { outcome: 'failed', code, delivery: 'failed' }
    }
  }

  /**
   * 只读准备的**形状检查**（与 `submit` 共用同一处判据）。
   *
   * ⚠️ 刻意复用 `validate` 而**不是**再写一遍：准备与提交对"什么算一条合法输入"
   *    必须完全一致 —— 否则外壳会看到"提交被拒但准备通过了"这种自相矛盾的状态，
   *    而那种矛盾最后一定会变成"准备用了一句从没被接受过的话"。
   */
  validatePrepare(request: BridgeSubmitRequest): string | undefined {
    return this.validate(request)
  }

  private validate(request: BridgeSubmitRequest): string | undefined {
    if (request === null || typeof request !== 'object') return 'bridge_bad_request'
    const id = (request as { requestId?: unknown }).requestId
    if (typeof id !== 'string' || !/^[A-Za-z0-9_:@#.-]{1,120}$/.test(id)) return 'bridge_bad_request_id'
    const text = (request as { userText?: unknown }).userText
    if (typeof text !== 'string') return 'bridge_bad_user_text'
    if (text.trim() === '') return 'bridge_empty_user_text'
    if (text.length > this.maxUserTextLength) return 'bridge_user_text_too_long'
    /*
     * `ADR-139` `D04`：**只**校验 `platformFacts` 这一格。
     * ⚠️ 缺席 ⇒ 直接跳过（逐字旧行为）；非法 ⇒ **整轮具名拒绝**（不是"取能认的字段、忽略其余"）。
     */
    const facts = (request as { platformFacts?: unknown }).platformFacts
    if (facts !== undefined) {
      const problem = platformFactsProblems(facts)
      if (problem !== undefined) return problem
    }
    if (request.groupContext !== undefined) {
      if (request.platformFacts?.messageType !== 'group' || !Array.isArray(request.groupContext)
        || request.groupContext.length > 20 || request.groupContext.some(line => !line ||
          typeof line.senderId !== 'string' || !/^[1-9]\d{4,19}$/.test(line.senderId) ||
          typeof line.text !== 'string' || line.text.length > 1000 || !Number.isFinite(line.at))
        || request.groupContext.reduce((sum, line) => sum + line.text.length, 0) > 6000) return 'invalid_group_context'
    }
    return imageInputShapeError(request.images)
  }

  private remember(requestId: string, result: BridgeSubmitResult): void {
    this.idempotency.set(requestId, { result, at: this.now() })
    while (this.idempotency.size > this.idempotencyCacheSize) {
      const oldest = this.idempotency.keys().next()
      if (oldest.done === true) break
      this.idempotency.delete(oldest.value)
    }
  }

  /** 诊断用：缓存里有多少条结局（**不含**任何正文） */
  get idempotencySize(): number {
    return this.idempotency.size
  }

  /**
   * 委派取消给 host（后 Lv2 · `L-PL2-04`）。
   *
   * ⚠️ 桥**不**自己维护取消状态：它只运输。取消是**装配层**的事
   * （只有装配层知道"现在走到哪一步了、还来不来得及停"）——
   * 桥要是自己存一个集合，就成了"第二个说了算的地方"。
   */
  get hostCancelTurn(): TurnBridgeHost['cancelTurn'] {
    return this.host.cancelTurn?.bind(this.host)
  }

  /** host 有没有取消能力（门与诊断用；**不**参与任何产品判据） */
  get cancelCapable(): boolean {
    return typeof this.host.cancelTurn === 'function'
  }

  /**
   * 委派合成回报给 host（Lv4.5 / `P1`）。
   *
   * ⚠️ 与 `hostCancelTurn` 同一条理由：桥**不**自己维护合成账。
   */
  get hostReportSynthesized(): TurnBridgeHost['reportSynthesized'] {
    return this.host.reportSynthesized?.bind(this.host)
  }

  /**
   * 委派播放回报给 host（Lv4.5 / `P1`）。
   *
   * ⚠️ 与 `hostCancelTurn` 同一条理由：桥**不**自己维护交付账。
   *    交付事实的权威在装配层（它知道 replyId 与已检查分句），
   *    桥要是自己存一份，就成了"第二个说了算的地方"。
   */
  get hostReportPlayback(): TurnBridgeHost['reportPlayback'] {
    return this.host.reportPlayback?.bind(this.host)
  }

  /** host 有没有交付账（门与诊断用；**不**参与任何产品判据） */
  get playbackReportCapable(): boolean {
    return typeof this.host.reportPlayback === 'function'
  }

  /**
   * 委派**QQ 投递回执**给 host（post-Lv2 / ADR-110 `D06`）。
   *
   * ⚠️ 与 `hostReportPlayback` 同一条理由：投递登记的权威在装配层，
   *    桥要是自己存一份，就成了"第二个说了算的地方"。
   */
  get hostReportReminderDelivery(): TurnBridgeHost['reportReminderDelivery'] {
    return this.host.reportReminderDelivery?.bind(this.host)
  }
  setReminderDeliveryReporter(reporter: NonNullable<TurnBridgeHost['reportReminderDelivery']>): void {
    this.host.reportReminderDelivery = reporter
  }

  get hostReportQqDelivery(): TurnBridgeHost['reportQqDelivery'] {
    return this.host.reportQqDelivery?.bind(this.host)
  }

  /** host 有没有投递登记（门与诊断用；**不**参与任何产品判据） */
  get qqDeliveryReportCapable(): boolean {
    return typeof this.host.reportQqDelivery === 'function'
  }

  /**
   * 委派**只读准备**给 host（Lv4.5 / `P2`）。
   *
   * ⚠️ 与 `hostCancelTurn` 同一条理由：桥**不**自己算召回。
   *    只有装配层知道怎么走那条**只读**的路；桥要是自己攒一份，
   *    它就会变成"第二个能读账本的地方"。
   */
  get hostPrepareTurn(): TurnBridgeHost['prepareTurn'] {
    return this.host.prepareTurn?.bind(this.host)
  }

  /** host 有没有只读准备能力（门与诊断用；**不**参与任何产品判据） */
  get prepareCapable(): boolean {
    return typeof this.host.prepareTurn === 'function'
  }

  /**
   * 委派**一次主动开口机会**给 host（Lv4.5 / ADR-131 `D01`）。
   *
   * ⚠️ 与 `hostPrepareTurn` 同一条理由：桥**不**调模型、**不**判闸、**不**造正文。
   *    它只运输"外壳报来了一个机会"这件事，整条裁决留在装配层。
   */
  get hostOpeningOpportunity(): TurnBridgeHost['openingOpportunity'] {
    return this.host.openingOpportunity?.bind(this.host)
  }

  /** host 有没有主动开口能力（门与诊断用；**不**参与任何产品判据） */
  get openingCapable(): boolean {
    return typeof this.host.openingOpportunity === 'function'
  }

  /**
   * **出站通道在不在**（WP5b 侦察修正：装配层看不到 `outputSink`）。
   *
   * ⚠️ 它只回答"有没有地方把她的话送出去"，**不**回答"她在不在说"。
   *    机会预检用它来避免"生成完才发现没人听"。
   */
  get outputCapable(): boolean {
    return this.outputSink !== undefined
  }

  /**
   * **已提交轮数**（= 用户话权的当前版本）。
   *
   * ⚠️ 与既有三类插话用的是**同一个计数**（`submittedTurns`）：
   *    机会候选的 `turnRevision` 必须 ≥ 它，否则会被仲裁判过期。
   */
  get submittedTurnRevision(): number {
    return this.submittedTurns
  }

  /** host 有没有**边听边查**能力（门与诊断用；**不**参与任何产品判据） */
  get lookupCapable(): boolean {
    return typeof this.host.prepareLookup === 'function'
  }

  /** 取 host 的**边听边查**入口（缺省 `undefined` ⇒ 如实不查，**不假装查过**） */
  get hostPrepareLookup(): TurnBridgeHost['prepareLookup'] {
    return this.host.prepareLookup
  }

  /**
   * 这一句是不是**显式检索请求**（复用 M5.5 的判定器，不另发明触发词）。
   *
   * ⚠️ 返回 `undefined` = **不是**显式请求 ⇒ 不提前查（`auto_public` 那一档的
   *    自动搜索**不在**这条路上：提前查的授权必须与正式搜索**同一套**）。
   */
  explicitSearchIntent(text: string): { query: string } | undefined {
    const intent = createExternalEvidenceIntentDetector().detect(text)
    if (intent === undefined) return undefined
    /* ⚠️ 字段名是 `args`（不是 `parameters`）—— 已由类型检查钉住 */
    const query = (intent.args as { query?: unknown } | undefined)?.query
    return typeof query === 'string' && query.trim() !== '' ? { query } : undefined
  }

  // -------------------------------------------------------------------------
  // Lv4.5 / `P3`：**出站**的有来源角色输出（有限插话）
  // -------------------------------------------------------------------------

  /**
   * 装/卸**出站**通道（由传输层装上；桥自己**不**碰 stdout）。
   *
   * ⚠️ 通道是**注入**的而不是桥自己写：桥不知道 stdout、也不知道 NDJSON ——
   *    那是传输层的事。这样"谁在什么时刻写出一行"仍然只有一处。
   */
  setOutputSink(sink: ((message: BridgeWireResponse) => void) | undefined): void {
    this.outputSink = sink
  }

  /** 出站通道的读数（门与排错用；**不含**正文） */
  get outputReading(): {
    spoken: number
    dropped: number
    yielded: number
    /** 其中**没有** sidecar、只能按纯文本播的条数（如实记，不当成同一种"说出去了"） */
    spokenWithoutExpression: number
    /** 这一次开口**已经答过**呼唤而没再答的次数（去重的读数，不是失败） */
    suppressedWake: number
    lastCode: string | null
  } {
    return { ...this.outputReadingState }
  }

  /**
   * **呼唤回应**（`P3` 的生产者）：把"她在叫我"变成一条**有来源的短句**。
   *
   * ============================================================================
   *  话权怎么算（这就是"用户优先"的落点）
   * ============================================================================
   * ```text
   * 用户在说话（partial 阶段本来就是他在说） ⇒ `userSpeaking: true`
   * 候选版本 = **已提交轮次数 + 1** ⇒ 比用户当前版本**新**
   *   ⇒ 它不会被 `output_stale_against_user_revision` 丢掉（那是"旧任务"）
   *   ⇒ 同时 `wake_response` 属**紧急两类**，所以"用户占着话权"也允许插
   * ```
   * ⚠️ 这里**不**判"她该不该回应"—— 那是 `detectFastSignal` 的职责（含引用/否定/回声负控），
   *    调用方只有在信号确实成立时才会调到这里。
   */
  emitWakeResponse(input: { signalRef: string; utteranceKey?: string }): CharacterOutputDecision {
    /*
     * ⚠️ **一次呼唤只答一次**（这条是实测出来的）。
     *
     * 外壳是**每一块 partial 都发一次只读准备**的（P2 的设计），于是"苏沐薇你在吗"
     * 会长成 `苏慕微你` → `苏慕微你在` → `苏慕微你在马` 三次准备，**三次都命中**名字 ⇒
     * 她会把「我在。」说三遍。实测读数：3 条准备 ⇒ 3 个 `lg-expression-turn`、
     * 多个编号不同的 `interjection:N#0`（编号不同就是**真的说了好几次**）。
     *
     * ⚠️ 去重键是**不透明的字符串**，由外壳给出（`<客户端 id>:<开口序号>`）：
     * ```text
     * 不能用"哪一条候选"  —— 每条 partial 都是新候选，去重会失效
     * 不能用"下一轮何时提交"—— "只叫一声、不说话"的用户会让它永不清空（第一版这么错）
     * 不能用"开口序号"单值  —— 序号是**每条连接各自**从 1 开始的 ⇒ 刷新页面后
     *                        第一句会被当成"答过了"而**静默不理**（实测踩到）
     * ```
     * ⚠️ 没给键的旧客户端 ⇒ **不去重**（宁可多说一次，也不要永久哑掉）。
     */
    const key = input.utteranceKey
    if (key !== undefined && key !== '' && key === this.wakeAnsweredUtteranceKey) {
      this.outputReadingState.suppressedWake += 1
      return { action: 'drop', code: 'wake_already_answered_for_this_utterance' }
    }
    this.wakeRevision += 1
    const revision = this.submittedTurns + this.wakeRevision
    const candidate = buildWakeResponseCandidate({ revision, signalRef: input.signalRef })
    /*
     * 表达 sidecar 也由**程序**造（与短句本身同一条纪律）：既定文本 ⇒ 既定分句。
     * ⚠️ 造不出来（协议形状不合）时**不**连累这条短句：没有 sidecar 也能按纯文本播，
     *    而"播了但没有表情"远好于"因为她没表情所以不response"。
     */
    let expression: SpeechExpression | undefined
    try {
      const draft = decodeExpressiveSpeech(
        `<lg-speech>${JSON.stringify({ segments: [{ text: candidate.text, cue: WAKE_RESPONSE_CUE }] })}</lg-speech>`
      )
      expression = bindSpeechExpression(`interjection:${revision}`, draft.text, draft)
    } catch {
      expression = undefined
    }
    const decision = this.emitCharacterOutput({
      candidate,
      floor: { userSpeaking: true, userRevision: this.submittedTurns },
      ...(expression !== undefined ? { expression } : {}),
    })
    /* ⚠️ 只有**真的说出去了**才算答过；被丢弃/让位的不算（否则一次丢弃会永久哑掉） */
    if (decision.action === 'speak' && key !== undefined && key !== '') this.wakeAnsweredUtteranceKey = key
    return decision
  }

  /**
   * **边听边查**（`P3` 选项 B）：检索在**她还在说**的时候完成了 ⇒ 插一句"查到了"。
   *
   * ============================================================================
   *  时机判据（这一条的全部价值所在）
   * ============================================================================
   * ```text
   * 她**没在说** ⇒ 不说这一句：正式轮次马上就会把内容给她，
   *                提前插一句只是多插一句（计划 §4.2 禁止推测性生成，提醒同理）
   * 她**正在说** ⇒ 这才有价值：用户不必等她说完才知道"查到了"
   * 不知道      ⇒ **不说**（失败关闭）：宁可漏一次提醒，也不要在错的时机打断
   * ```
   * ⚠️ 与呼唤回应一样：`emitCharacterOutput` 之前先过仲裁（来源闭集 / 长度 / 版本 /
   *    用户优先），本条**不绕过**任何一道。
   */
  emitLookupNotice(input: { sourceRefs: readonly string[] }): CharacterOutputDecision {
    /*
     * ⚠️ `sheIsSpeaking` 拿不到 ⇒ 按 **false** 处理（不猜）。
     *    这与"用户优先"的方向一致：没有证据表明她正在说，就不要打断任何人。
     */
    const sheIsSpeaking = this.sheIsSpeakingNow
    if (!sheIsSpeaking) {
      this.outputReadingState.dropped += 1
      this.outputReadingState.lastCode = 'lookup_notice_she_is_not_speaking'
      return { action: 'drop', code: 'lookup_notice_she_is_not_speaking' }
    }
    if (input.sourceRefs.length === 0) {
      this.outputReadingState.dropped += 1
      this.outputReadingState.lastCode = 'lookup_notice_without_source'
      return { action: 'drop', code: 'lookup_notice_without_source' }
    }
    this.wakeRevision += 1
    const revision = this.submittedTurns + this.wakeRevision
    const candidate = buildLookupNoticeCandidate({ revision, sourceRefs: input.sourceRefs })
    let expression: SpeechExpression | undefined
    try {
      const draft = decodeExpressiveSpeech(
        `<lg-speech>${JSON.stringify({ segments: [{ text: candidate.text, cue: LOOKUP_NOTICE_CUE }] })}</lg-speech>`
      )
      expression = bindSpeechExpression(`interjection:${revision}`, draft.text, draft)
    } catch {
      expression = undefined
    }
    return this.emitCharacterOutput({
      candidate,
      /*
       * ⚠️ 用户**此刻是否在说**：桥拿不到外壳的 VAD 状态 ⇒ 传 `false`。
       *    也就是说：**"非紧急的来源在用户说话时让位"这条仲裁分支，对本来源目前不可达**。
       *    如实写在这里，而不是假装它已经生效。
       */
      floor: { userSpeaking: false, userRevision: this.submittedTurns },
      ...(expression !== undefined ? { expression } : {}),
    })
  }

  /**
   * 该不该为**这一次发音**发起提前检索（`P3` 选项 B）。
   *
   * ```text
   * 没给键        ⇒ **查**（宁可多花一次，也不要因为外壳没给键就永远不查）
   * 与上次同一个键 ⇒ **不查**（partial 反复到达 ⇒ 不去重就是每条都买一次出站）
   * 新的键        ⇒ **查**，并**立刻**记账
   * ```
   * ⚠️ **先记账再返回 true**：调用方拿到 true 之后会 `await` 一次出站检索（慢），
   *    并发到达的下一条 partial 会在这个窗口里进来 —— 等结果回来再记账就漏了它。
   */
  shouldLookupFor(utteranceKey: string | undefined): boolean {
    if (utteranceKey === undefined) return true
    if (utteranceKey === this.lookupUtteranceKey) return false
    this.lookupUtteranceKey = utteranceKey
    return true
  }

  /** **正在被回答的那次开口**（`P3` 中途纠正的归属键；`null` = 外壳没给） */
  get submittedUtteranceKey(): string | null {
    return this.lastSubmittedUtteranceKey
  }

  /** 已经为哪一次开口给过"用户更正"的纠正段（诊断与去重用；`null` = 还没给过） */
  get correctedUtteranceKey(): string | null {
    return this.correctionUtteranceKey
  }

  /** 记下"这次开口的更正已经给过了"（**先记账再产出**：产出是慢的，并发 partial 会挤进来） */
  markCorrected(utteranceKey: string): void {
    this.correctionUtteranceKey = utteranceKey
  }

  /**
   * 她**此刻是不是正在说**（`P3` 的时机读数，**一处判断**）。
   *
   * ⚠️ 缺省 `false`（**不猜**）：拿不到这个能力时，"她正在说"不成立 ⇒
   *    提醒与纠正都不发生。集中在这里是为了让"先判时机再动账"只有一处依据
   *    （曾有过的顺序缺陷：先改了交付账、再发现她根本没在说）。
   */
  get sheIsSpeakingNow(): boolean {
    return this.host.sheIsSpeaking?.() ?? false
  }

  /** 上一次为哪个发音查过（诊断用；`null` = 还没查过） */
  get lastLookupKey(): string | null {
    return this.lookupUtteranceKey
  }

  /**
   * 把这次发音的键**还回去**（只在检索**失败/被拒**时调用）。
   *
   * ⚠️ 理由见调用点：失败不是"买到了" —— 还占着键会让**一次瞬时失败**
   *    变成这条发音**永远不再试**（而这个功能本来就只有一次机会）。
   * ⚠️ 只还"正是这一把"键（避免把**后来**那次发音的键误清掉）。
   */
  releaseLookupFor(utteranceKey: string | undefined): void {
    if (utteranceKey === undefined) return
    if (this.lookupUtteranceKey === utteranceKey) this.lookupUtteranceKey = null
  }

  /**
   * **中途纠正**（`P3`）：晚到的证据**属于她正在回答的那一次开口** ⇒
   * 先废弃未播余句，再给一条**检查过**的纠正段。
   *
   * ============================================================================
   *  两条判据，缺一不可
   * ============================================================================
   * ```text
   * ① 她**正在说**（交付账里还有没播完的片段）—— 与"查到了"共用同一个读数
   * ② 有来源 id（那条证据可审计）—— 与"查到了"共用同一条硬要求
   * ```
   * 而"**是不是同一次开口**"的归属判断在调用点（它需要 `SUBMIT_TURN` 带来的键）。
   *
   * ⚠️ **`sheIsSpeaking` 必须由调用点传进来，不能在函数里重读**（这是实测抓出来的
   *    第二个顺序缺陷，而且它与第一个**互相掩盖**）：
   * ```text
   * 纠正的动作顺序是"**先废余句、再给纠正段**"，而"废余句"恰好会把交付账里
   * 所有未播片段变成终态 ⇒ 重读 `hasUnplayed()` 必然变成 false
   *   ⇒ 纠正段**在真正该纠正的时候永远被丢掉**（"她没在说"）
   * 实测：修好"静默作废"那一处之后，读数从"废了 0 段 + 纠正段播出"
   *       变成"废了 4 段 + **纠正段不见了**" —— 两个缺陷原来在互相掩盖。
   * ```
   * ⇒ 时机是**入口的事实**，一旦为真就为真；后续步骤**不许**再问一次。
   *
   * ⚠️ 与其它短句一样：它**不携带事实**，实质内容由重新判断过的那一轮给出；
   *    它走 `emitCharacterOutput` ⇒ 来源闭集 / 长度 / 版本 / 用户优先**一道都不绕过**。
   */
  emitMidTurnCorrection(input: {
    sourceRefs: readonly string[]
    /** **入口**时判定的事实（调用点已算过；这里不重读，见上面的说明） */
    sheIsSpeaking: boolean
  }): CharacterOutputDecision {
    if (!input.sheIsSpeaking) {
      this.outputReadingState.dropped += 1
      this.outputReadingState.lastCode = 'correction_she_is_not_speaking'
      return { action: 'drop', code: 'correction_she_is_not_speaking' }
    }
    if (input.sourceRefs.length === 0) {
      this.outputReadingState.dropped += 1
      this.outputReadingState.lastCode = 'correction_without_source'
      return { action: 'drop', code: 'correction_without_source' }
    }
    this.wakeRevision += 1
    const revision = this.submittedTurns + this.wakeRevision
    const candidate = buildMidTurnCorrectionCandidate({ revision, sourceRefs: input.sourceRefs })
    let expression: SpeechExpression | undefined
    try {
      const draft = decodeExpressiveSpeech(
        `<lg-speech>${JSON.stringify({ segments: [{ text: candidate.text, cue: MID_TURN_CORRECTION_CUE }] })}</lg-speech>`
      )
      expression = bindSpeechExpression(`interjection:${revision}`, draft.text, draft)
    } catch {
      expression = undefined
    }
    return this.emitCharacterOutput({
      candidate,
      /* ⚠️ 与提醒同样的边界：桥拿不到外壳的 VAD 状态 ⇒ 传 `false`（如实写在注释里） */
      floor: { userSpeaking: false, userRevision: this.submittedTurns },
      ...(expression !== undefined ? { expression } : {}),
    })
  }

  /**
   * **中途纠正**（`P3`）的另外半件：**废弃未播余句**。
   *
   * ⚠️ 它委派给 host（交付账的权威在装配层）—— 桥不自己维护交付账，
   *    与 `reportPlayback` / `sheIsSpeaking` 同一条理由。
   * ⚠️ 缺省 `undefined` ⇒ 调用点按"**没有这个能力**"处理（如实报 `null`），
   *    **不假装**已经作废（失败关闭）。
   */
  get hostSupersedeUnplayed(): TurnBridgeHost['supersedeUnplayed'] {
    return this.host.supersedeUnplayed?.bind(this.host)
  }

  /**
   * 交出一句**有来源**的短句（有限插话的唯一出口）。
   *
   * ============================================================================
   *  它做的事只有三件
   * ============================================================================
   * ```text
   * ① 问 `arbitrateCharacterOutput`：这条**现在**能不能说（用户优先 / 版本 / 长度 / 来源）
   * ② 能说 ⇒ 经**注入的**出站通道写一条 `CHARACTER_OUTPUT`（带 revision / source / sourceRefs / text）
   * ③ 不能说 ⇒ **一个字节都不写**，只把具名理由码记进读数
   * ```
   *
   * ⚠️ 桥**不**在这里生成文本、**不**在这里碰模型或数据库
   *    （`kernel:test` 的"入口桥只能依赖 contracts"那条锁着这条边界）。
   */
  emitCharacterOutput(input: {
    candidate: CharacterOutputCandidate
    floor: FloorState
    /**
     * 这条短句的分句与表达（可选）。
     *
     * ⚠️ 只有**已经分句、已经绑定过守卫后文本**的 sidecar 才允许传进来 ——
     *    本模块**不**为它造一个（那会变成"在这里生成表达"，越界）。
     *    缺席时外壳按纯文本播：如实降级，不伪造。
     */
    expression?: SpeechExpression
  }): CharacterOutputDecision {
    const decision = arbitrateCharacterOutput(input)
    if (decision.action === 'speak') {
      if (this.outputSink === undefined) {
        /* 没有出站通道 ⇒ 如实记为"没说出"（**不**假装说过） */
        this.outputReadingState.dropped += 1
        this.outputReadingState.lastCode = 'output_channel_absent'
        return { action: 'drop', code: 'output_channel_absent' }
      }
      this.outputSink({
        kind: 'CHARACTER_OUTPUT',
        requestId: '',
        outcome: 'spoken',
        characterOutput: {
          revision: input.candidate.turnRevision,
          source: decision.source,
          sourceRefs: [...input.candidate.sourceRefs],
          text: decision.text,
          yieldFloor: true,
          ...(input.expression !== undefined ? { expression: input.expression } : {}),
        },
      })
      this.outputReadingState.spoken += 1
      this.outputReadingState.lastCode = null
      if (input.expression === undefined) this.outputReadingState.spokenWithoutExpression += 1
      return decision
    }
    if (decision.action === 'yield_to_user') this.outputReadingState.yielded += 1
    else this.outputReadingState.dropped += 1
    this.outputReadingState.lastCode = decision.code
    return decision
  }

  // -------------------------------------------------------------------------
  // post-Lv2 / ADR-110 `D06`：**主动投递给 QQ 外壳的一条文字**
  // -------------------------------------------------------------------------

  /**
   * 把一条**已经过回复守卫**的主动文字交给外壳去投递。
   *
   * ============================================================================
   *  它与 `emitCharacterOutput` 的关系：**平行，不共用**
   * ============================================================================
   * ```text
   * emitCharacterOutput   有限插话（呼唤回应 / 纠正 / 查到了）——
   *                       来源闭集在那三样里，**逐字排除**主动闲聊与日程提醒
   * deliverQqText         PC 主动联系（关心 / 提醒）—— 另一条线（`TD-19`）
   * ```
   * ⇒ 两者**都不**生成文本、**都**只运输。这里刻意**不**复用
   *   `arbitrateCharacterOutput`：那会让主动联系从"被排除的闭集"里溜进去。
   *
   * ⚠️ 四条失败关闭（每条具名）：
   * ```text
   * ① `deliveryId` 空 ⇒ `qq_delivery_without_id`
   * ② 正文空 ⇒ `qq_delivery_without_text`
   * ③ 正文超上界 ⇒ `qq_delivery_text_too_long`（结构性兜底；有界由投递登记保证）
   * ④ 没有出站通道 ⇒ `output_channel_absent`（**不**假装说出去了）
   * ```
   * ⚠️ 正文是**这条线上唯一允许出现正文的地方**（`D09`）：核心到外壳的受信线缆需要它；
   *    账本 / trace / `ActionRequest.arguments` **都**只拿实例引用与指纹。
   */
  deliverQqText(input: { deliveryId: string; text: string; attempt?: number }): {
    written: boolean
    code?: string
  } {
    const deliveryId = String(input.deliveryId ?? '').trim()
    if (deliveryId === '') {
      this.qqDeliveryReadingState.refused += 1
      this.qqDeliveryReadingState.lastCode = 'qq_delivery_without_id'
      return { written: false, code: 'qq_delivery_without_id' }
    }
    const text = String(input.text ?? '')
    if (text.trim() === '') {
      this.qqDeliveryReadingState.refused += 1
      this.qqDeliveryReadingState.lastCode = 'qq_delivery_without_text'
      return { written: false, code: 'qq_delivery_without_text' }
    }
    /* 有界：与通知实例的正文上界同一口径（`ADR-110` `D07`） */
    if ([...text].length > QQ_DELIVERY_TEXT_MAX_CODEPOINTS) {
      this.qqDeliveryReadingState.refused += 1
      this.qqDeliveryReadingState.lastCode = 'qq_delivery_text_too_long'
      return { written: false, code: 'qq_delivery_text_too_long' }
    }
    if (this.outputSink === undefined) {
      this.qqDeliveryReadingState.refused += 1
      this.qqDeliveryReadingState.lastCode = 'output_channel_absent'
      return { written: false, code: 'output_channel_absent' }
    }
    this.outputSink({
      kind: 'DELIVER_QQ_TEXT',
      /* ⚠️ `requestId` = `deliveryId`（复用既有的关联字段，不新造第二个） */
      requestId: deliveryId,
      outcome: 'generated',
      qqText: text,
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    })
    this.qqDeliveryReadingState.written += 1
    this.qqDeliveryReadingState.lastCode = null
    this.qqDeliveryReadingState.lastDeliveryId = deliveryId
    return { written: true }
  }

  /** Dedicated local reminder transport; does not widen the interjection source set. */
  deliverReminderText(input: { deliveryId: string; text: string }): { written: boolean; code?: string } {
    if (!input.deliveryId.trim() || !input.text.trim() || [...input.text].length > QQ_DELIVERY_TEXT_MAX_CODEPOINTS) return { written: false, code: 'reminder_output_invalid' }
    if (!this.outputSink) return { written: false, code: 'output_channel_absent' }
    this.outputSink({ kind: 'DELIVER_REMINDER_TEXT', requestId: input.deliveryId, outcome: 'generated', reminderText: input.text })
    return { written: true }
  }

  /** 投递出站的读数（门与排错用；**不含正文**） */
  get qqDeliveryReading(): {
    written: number
    refused: number
    lastCode: string | null
    lastDeliveryId: string | null
  } {
    return { ...this.qqDeliveryReadingState }
  }
}

// ---------------------------------------------------------------------------
// 受限传输消息（首版只有这一种；不建万能连接器框架）
// ---------------------------------------------------------------------------

/**
 * 桥的线上消息形状（外壳 ⟷ 桥）。
 *
 * ⚠️ 只有两个请求种类，每一个都**显式**登记在这张受控表里
 * （计划 §9：新增运行能力要有具名操作和权限映射）。
 *
 * ```text
 * SUBMIT_TURN  提交一轮用户话 ⇒ 拿回**已过回复守卫**的正文
 * CANCEL_TURN  取消一轮**还没提交**的轮次（后 Lv2 · `L-PL2-04`）
 * ```
 *
 * ⚠️ `CANCEL_TURN` **不新增任何权限**，反而**减少**它能做的事：
 * 它只能让"还没走到提交点的那些步骤"停下，**不能**撤销任何已提交的东西
 * （见 {@link BridgeCancelReading} 的 `alreadyCommitted`）。
 * 这条边界是计划 §8.3 的原话：取消的目标是停止过期工作与表达，
 * **不撤销**已提交的用户消息 / 记忆 / 外部副作用。
 */
export type BridgeMessageKind =
  | 'SUBMIT_TURN'
  | 'CANCEL_TURN'
  | 'REPORT_SYNTHESIZED'
  | 'REPORT_PLAYBACK'
  /** Lv4.5 / Lv4.5 P2：**只读准备**（见 {@link BridgePrepareReading}） */
  | 'PREPARE_TURN'
  /**
   * post-Lv2 / ADR-110 `D06`：**主动投递的回执**（外壳 → 核心）。
   *
   * ⚠️ 它是本桥第二条**与某个轮次无关**的入站消息（第一条是 `PREPARE_TURN`）：
   *    它关联的是 `deliveryId`，而**不是**任何 `requestId` 的轮次。
   */
  | 'REPORT_QQ_DELIVERY'
  | 'REPORT_REMINDER_DELIVERY'
  /**
   * Lv4.5 / ADR-131 `D01` · `D18`：**皮套入口的机会报文**（外壳 → 核心）。
   *
   * ⚠️ 它**不是输入**：不落 `user_message`、不占正式轮次、不写记忆。
   *    它只说"我现在闲下来了（`idleMs`）"，**说不说、说什么由 LG 决定**。
   *    ⇒ 这是本桥第三条**与某个轮次无关**的入站消息（前两条是 `PREPARE_TURN` 与投递回执）。
   */
  | 'PROACTIVE_OPPORTUNITY'

export const BRIDGE_MESSAGE_KINDS: readonly BridgeMessageKind[] = [
  'SUBMIT_TURN',
  'CANCEL_TURN',
  'REPORT_SYNTHESIZED',
  'REPORT_PLAYBACK',
  'PREPARE_TURN',
  'REPORT_QQ_DELIVERY',
  'REPORT_REMINDER_DELIVERY',
  'PROACTIVE_OPPORTUNITY',
]

/**
 * Lv4.5 / `P1`+`P2`：**控制消息**（读到就处理，不与耗时轮次排队）。
 *
 * ```text
 * SUBMIT_TURN        正式轮次 —— 会调模型、会写账本 ⇒ 必须串行
 * CANCEL_TURN        只更新进程内取消登记         ⇒ 慢轮次期间**必须**能被读到
 * REPORT_SYNTHESIZED 只推进进程内合成账           ⇒ 同上
 * REPORT_PLAYBACK    只推进进程内交付账           ⇒ 同上
 * PREPARE_TURN       只读召回与候选准备           ⇒ 同上（它**不**写任何账）
 * ```
 *
 * ⚠️ 这是一处**分类**，不是第二处判据：传输层按它决定"排队还是立即"，
 * 而每个种类的**语义**仍然只有 `handleBridgeMessage` 一处实现。
 *
 * ---------------------------------------------------------------------------
 * ★ `PROACTIVE_OPPORTUNITY` **刻意不在**控制类里（ADR-131 `D18` 的落地判断）
 * ---------------------------------------------------------------------------
 * ```text
 * 控制类的**理由**是"慢轮次期间必须能被读到" —— 它们都是**微秒级、不改世界**的动作。
 * 而机会报文会**调一次模型**（`openingDeadlineMs` 上限 8000ms，实测 p90 ≈ 2400ms）。
 * 若把它当控制类，一次 8 秒的机会评估就会**挡住同一批控制消息**，
 * 而 CANCEL_TURN 恰好在"用户要打断她"时到达 —— 那是**最不能等**的时刻。
 * ⇒ 它走**排队**那一档：机会**不紧急**，被慢轮次推迟是**安全方向**
 *   （推迟后预检会按**新鲜读数**重判；过期就拒）。
 * ```
 * ⚠️ 这条判断有一条可测的推论：**它不应出现在本函数的 `true` 分支里**（门里守着）。
 */
export function isBridgeControlMessageKind(value: unknown): boolean {
  return (
    value === 'CANCEL_TURN' ||
    value === 'REPORT_SYNTHESIZED' ||
    value === 'REPORT_PLAYBACK' ||
    value === 'PREPARE_TURN' ||
    /*
     * post-Lv2 / ADR-110 `D06`：QQ 主动投递的**回执**。
     *
     * ⚠️ 它必须是**控制类**：它只把"平台接受 / 明确失败 / 结果不明"记进投递登记，
     *    不写库、不调模型、**不排队**。若它落进 `SUBMIT_TURN` 那条串行泵，
     *    一条慢轮次就会把回执压到轮末 —— 而那正是"结果不明"最容易发生的窗口。
     */
    value === 'REPORT_QQ_DELIVERY' || value === 'REPORT_REMINDER_DELIVERY'
  )
}

/**
 * 外壳能报的**投递结局**（闭集；ADR-110 `D08`）。
 *
 * ```text
 * api_accepted      平台接口接受了（**必须**带回执 id）—— 这**不**等于本人已读
 * failed_confirmed  平台明确拒绝（`detail` 给理由）
 * delivery_unknown  超时 / 发出后断线 / 结果读不出来 —— **不猜**、**不重发**
 * ```
 * ⚠️ 刻意**没有** `delivered` / `read` / `seen`：QQ 协议不给这些凭据，
 *    把它们写进闭集就等于许诺一个我们证明不了的事实。
 */
export type BridgeQqDeliveryStatus = 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'

export const BRIDGE_QQ_DELIVERY_STATUSES: readonly BridgeQqDeliveryStatus[] = [
  'api_accepted',
  'failed_confirmed',
  'delivery_unknown',
]

export function isBridgeQqDeliveryStatus(value: unknown): value is BridgeQqDeliveryStatus {
  return typeof value === 'string' && (BRIDGE_QQ_DELIVERY_STATUSES as readonly string[]).includes(value)
}

/** 一条投递回执被受理之后的读数（**只是记账结果**，不是"送到了"） */
export interface BridgeQqDeliveryReportResult {
  /** 这条回执**是否真的推进了**登记（重复/未知 deliveryId ⇒ `false`，且**不**是失败） */
  accepted: boolean
  /** 具名理由码（`accepted === false` 时必有） */
  code?: string
  /** 推进之后这条投递的结局（登记里没有它 ⇒ `undefined`） */
  recordedState?: string
}

/** 发 `CANCEL_TURN` 时外壳能说什么（**只有**这两样；没有任何"撤销"字段） */
export interface BridgeCancelRequest {
  kind: 'CANCEL_TURN'
  /** 要取消的那一轮的 `requestId`（**必须**是外壳先前用过的那个） */
  requestId: string
  /** 人类可读的理由（进诊断，不进任何判据） */
  reason?: string
}

/**
 * 入站**平台事实**（闭集）—— `ADR-139` `D01`（用户 2026-10-14 裁定 `R-139-1` = ①）。
 *
 * ```text
 * 它回答"这一轮的**真实发言者**是谁"，**不**回答"谁被授权"：
 * 授权仍由 `evaluateScopeAccess`（契约层）判，载荷永远只是事实（`INV-PL2-08` 不冲突）。
 * ⚠️ 它**不能**用来选入口：入口仍由端口 / `--qq-private` 绑定（`ADR-109` `D02`）；
 *    核心拿到它之后必须与**会话已绑定的入口**交叉核对（`ADR-139` `D02`）。
 * ```
 */
export interface BridgeGroupContextLine { readonly senderId: string; readonly text: string; readonly at: number }

export interface BridgeInboundPlatformFacts {
  readonly transport: 'qq'
  /** 机器人自己的平台账号（来自包，非自报） */
  readonly selfId: string
  /** **真实发言者**的平台账号 */
  readonly senderUserId: string
  readonly messageType: 'private' | 'group'
  /** 仅 `messageType === 'group'` 时允许出现（`ADR-139` `D01`） */
  readonly groupId?: string
}

/** 闭集字段名（多一个键整条作废） */
const PLATFORM_FACTS_KEYS: readonly string[] = ['transport', 'selfId', 'senderUserId', 'messageType', 'groupId']

/**
 * 平台事实的**形状判据**（纯函数）。返回**具名**理由码；`undefined` = 合法。
 *
 * ⚠️ `ADR-139` `D04`（用户裁定 `R-139-2` = ①）：**只**严格校验这一格。
 *    其它未知字段**照旧容忍** —— 今天的桥本来就容忍未知字段（2026-10-14 实测），
 *    把"容忍"改成"拒绝"是一次**未被要求的收紧**，会把既有外壳变成回归。
 */
export function platformFactsProblems(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'bridge_bad_platform_facts'
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!PLATFORM_FACTS_KEYS.includes(key)) return 'bridge_bad_platform_facts_key'
  }
  if (record.transport !== 'qq') return 'bridge_bad_platform_facts_transport'
  if (typeof record.selfId !== 'string' || record.selfId.trim() === '') return 'bridge_bad_platform_facts_self'
  if (typeof record.senderUserId !== 'string' || record.senderUserId.trim() === '') {
    return 'bridge_bad_platform_facts_sender'
  }
  const messageType = record.messageType
  if (messageType !== 'private' && messageType !== 'group') return 'bridge_bad_platform_facts_message_type'
  const groupId = record.groupId
  if (messageType === 'private' && groupId !== undefined) return 'bridge_bad_platform_facts_group'
  if (messageType === 'group' && (typeof groupId !== 'string' || groupId.trim() === '')) {
    return 'bridge_bad_platform_facts_group'
  }
  return undefined
}

export interface BridgeWireRequest {
  images?: readonly ImageInput[]
  kind: BridgeMessageKind
  requestId: string
  /** `SUBMIT_TURN` 必填；`CANCEL_TURN` / `REPORT_PLAYBACK` 忽略 */
  userText?: string
  /** `CANCEL_TURN` 可选 */
  reason?: string
  /** `REPORT_PLAYBACK` 必填：客户端**实际播放**到哪一步（见 {@link BridgePlaybackState}） */
  playbackState?: BridgePlaybackState
  /** `REPORT_PLAYBACK` 必填 / `REPORT_SYNTHESIZED` 必填：这一段是 LG 的哪一段（`<replyId>#<index>`） */
  segmentId?: string
  /** `REPORT_PLAYBACK` / `REPORT_SYNTHESIZED` 可选：同一段音频的标识（合成账**要求**它） */
  audioId?: string
  /** `REPORT_PLAYBACK` 可选：**客户端**时钟上的播放区间（毫秒；诊断用） */
  playedFrom?: number
  playedTo?: number
  /** `REPORT_PLAYBACK` 可选：结局不明/失败的理由（进诊断，不进任何判据） */
  detail?: string
  /** `REPORT_PLAYBACK` 可选：要不要回一条 `PLAYBACK_RESULT`（缺省**不回**：回报是单向的） */
  ack?: boolean
  /**
   * `REPORT_QQ_DELIVERY` **必填**：这一条回执说的是哪一次投递。
   *
   * ⚠️ 与 `requestId` **同值**（复用既有的关联字段，不新造第二个）：
   *    `DELIVER_QQ_TEXT` 发出去时 `requestId = deliveryId`，
   *    外壳回执时把它原样带回来 ⇒ "哪一条投递"在两条消息上逐字一致。
   */
  deliveryId?: string
  /** `REPORT_QQ_DELIVERY` **必填**：结局（闭集） */
  deliveryStatus?: BridgeQqDeliveryStatus
  /** `REPORT_QQ_DELIVERY` 可选：平台的 `messageId`（**只有** `api_accepted` 时允许有） */
  messageId?: string
  /** `SUBMIT_TURN` 可选：这一轮的**入站平台事实**（`ADR-139` `D01`；缺席 = 逐字旧行为） */
  platformFacts?: BridgeInboundPlatformFacts
  groupContext?: readonly BridgeGroupContextLine[]
  /** `REPORT_QQ_DELIVERY` 可选：回执来自第几次尝试（诊断用） */
  attempt?: number
}

// ---------------------------------------------------------------------------
// 交付账（**进程内**；Lv4.5 / `P1`）
// ---------------------------------------------------------------------------

/**
 * 客户端**能报告**的播放状态。
 *
 * ⚠️ 刻意只有三个：`queued` / `playing` / `played` / `unknown` ——
 * `generated`（LG 生成）与 `synthesized`（TTS 合成）**不是**客户端能报的东西，
 * 它们由 LG 侧自己写。把两者混成一张表正是契约 §1 第一条禁令的形状。
 */
export type BridgePlaybackState = 'queued' | 'playing' | 'played' | 'cancelled' | 'unknown'

export const BRIDGE_PLAYBACK_STATES: readonly BridgePlaybackState[] = [
  'queued',
  'playing',
  'played',
  'cancelled',
  'unknown',
]

export interface BridgePlaybackReportResult {
  /** 这条回报**是否真的推进了**交付账（重复/过期回报 ⇒ false，且**不**是失败） */
  accepted: boolean
  /** 具名理由码（`accepted === false` 时必有） */
  code?: string
  /** 推进之后这一段的交付态（账上没有这一段 ⇒ undefined） */
  state?: string
}

/** 合成账的回报读数（形状与 {@link BridgePlaybackReportResult} 同构，理由码不同） */
export type BridgeSynthesisReportResult = BridgePlaybackReportResult

/**
 * 把一次**动作结果**翻译成桥要的检索读数（`P3` 选项 B）。
 *
 * ============================================================================
 *  为什么单独抽成纯函数
 * ============================================================================
 * 它是"检索到底查到没有"的**唯一**翻译处，而这里最容易出的错是**把不该算的来源算成来源**：
 * ```text
 * `ActionEvidence` 里混着好几类行：adapter / policy / ledger / filesystem
 *   · adapter 行上的 `externalEvidence.id` 才是"她依据的那条外部证据"
 *   · policy / ledger 行说的是"她做过什么" —— 把它们当来源
 *     ⇒ 插话会变成"查到了，凭据是：策略允许"（一句没有内容的话）
 * ```
 * 抽出来之后，这条判据可以在门里拿**构造的**结果做正控/负控，而不必真的出站一次。
 */
export function toLookupReading(result: {
  accepted: boolean
  executed?: boolean
  status: string
  evidence?: readonly { kind?: string; detail?: string; externalEvidence?: { id?: string } | undefined }[] | undefined
}): BridgeLookupReading {
  /*
   * ⚠️ `detail` 是**诊断**（不含用户正文）：把"被拒在哪一步"摊开成可读的一行。
   *    没有它，"接受了但没结果"与"被策略/目标解析/适配器挡下"长得一样 ——
   *    实测卡在这里：`status=rejected accepted=true executed=true`，
   *    看得出是**适配器**拒的，却看不出为什么。
   * ⚠️ 取证据行的 `detail` 是有意的：系统侧的失败说明就在那里
   *    （如 `validation_failed: query 不能为空`）。截断到 120 字符，
   *    且**不**去取任何 externalEvidence 的正文（那才是用户内容）。
   */
  const firstDetail = (result.evidence ?? [])
    .map((item) => item.detail)
    .find((value): value is string => typeof value === 'string' && value !== '')
  const detail =
    `status=${result.status} accepted=${String(result.accepted)} ` +
    `executed=${String(result.executed ?? null)} evidence=[${(result.evidence ?? []).map((item) => String(item.kind ?? '?')).join(',')}]` +
    (firstDetail !== undefined ? ` · ${firstDetail.slice(0, 120)}` : '')
  if (!result.accepted) return { status: 'rejected', code: result.status, detail }
  /*
   * ⚠️ 来源 id **只**取 `externalEvidence.id`（理由见上）。
   *    没有它 ⇒ `not_found`（**不是** found + 空来源：那会被仲裁
   *    以 `output_without_source` 拒掉，而"根本没查到"更准确）。
   */
  const refs = (result.evidence ?? [])
    .map((item) => item.externalEvidence?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  if (refs.length === 0) return { status: 'not_found', code: result.status, detail }
  return { status: 'found', sourceRefs: refs, detail }
}

/**
 * 这个提前检索的 query **够不够查**（`P3` 选项 B）。
 *
 * ============================================================================
 *  为什么需要它（实测出来的，不是防御性编程）
 * ============================================================================
 * 提前检索的触发点是**流式 partial**，而最早那条命中的 partial 往往是**碎片**：
 * ```text
 * 用户说"帮我搜一下明天的天气"，partial 长这样：
 *     帮我搜一下          ⇒ query = ""（空 ⇒ 判据已挡）
 *     帮我搜一下好        ⇒ query = "好"（**一个字**）
 * ```
 * 实测（直接打真 provider）：
 * ```text
 * query="替"           ⇒ Tavily HTTP 400 · validation_failed   ← 这一枪必然浪费
 * query="替 明天的天气" ⇒ ok · 5 条
 * ```
 * 而这一枪是**唯一**的一枪（键会被记住）⇒ 碎片的代价是"整个功能静默失效"。
 *
 * ⇒ 判据：去掉所有空白后**至少 2 个字符**才算"够查"。
 *    ⚠️ 这**不是**在判断"这句话问得对不对"（那是模型的事），
 *       只排掉**确定会被 provider 拒**的输入 —— 依据就是上面那条 HTTP 400。
 */
export function usableLookupQuery(query: string): boolean {
  return query.replace(/\s+/g, '').length >= 2
}

/**
 * 把一段诊断文本压成**单行 + 有界**（只用于 stderr 诊断，不进协议）。
 *
 * ⚠️ 存在的理由：`KernelError.message` 里可能有换行（契约问题清单就是多行的），
 *    直接打印会把一行日志变成十几行，混进外壳的转发输出里。
 */
function singleLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine
}

/**
 * Lv4.5 / `P3`（选项 B）：**边听边查**的读数（`prepareLookup` 的返回形状）。
 *
 * ⚠️ `status` 是**闭集**，且 `found` 必须带 `sourceRefs`：
 *    "查到了却说不出凭什么" 与 "没查到" 是两件事，混在一起会让
 *    `arbitrateCharacterOutput` 的 `output_without_source` 永远触发不到。
 */
export interface BridgeLookupReading {
  status: 'found' | 'not_found' | 'rejected' | 'failed'
  /** `found` 时**必有**：那条证据的 id（可审计；**不放正文**） */
  sourceRefs?: readonly string[]
  /** 失败/拒绝时的具名理由码（诊断用） */
  code?: string
  /**
   * 诊断行（**不含用户正文**）：`status / accepted / executed / evidence[]`。
   *
   * ⚠️ 它存在的理由：没有它，"被策略拒""目标解析不了""适配器拒"三种情况
   *    在读数上完全一样（都只是 `not_found` + 一个状态码）。
   */
  detail?: string
}

/**
 * Lv4.5 / `P2`：**只读准备**的读数（"边听边准备"那一半的返回形状）。
 *
 * ============================================================================
 *  这个类型的**缺席字段**才是判据
 * ============================================================================
 * ```text
 * 没有 replyText    —— 准备不产出任何"她说的话"（她还没说话）
 * 没有 eventId      —— 准备**不落**任何事件（一轮话只该有一条 user_message）
 * 没有正文          —— 命中项只报 id：正文留在账本里，端口的形状让它拿不到
 * ```
 * ⚠️ 它**不**是"提前生成的回复"：计划 §4.2 明文禁止首版同时推测整段 LLM 回复与提前 TTS。
 *    这里允许的只有**只读召回**与候选准备（不写正式用户消息、不落事件、不写记忆）。
 */
export interface BridgePrepareReading {
  /**
   * 这次候选的**版本**（改口即失效的依据）。
   *
   * ⚠️ 它由 host 按"输入文本 + 影响召回的策略/投影版本"算出来并**回传**；
   *    外壳拿它与自己手里的比较，不同就是过期，**不必**再问 LG 一次。
   */
  candidateRevision: string
  /** 只读召回的状态（`ran` / `failed` / `not_searched` 及其具名原因）——**不**编造 */
  recall: {
    status: 'ran' | 'failed' | 'not_searched'
    cause?: string
    selectedCount: number
    /**
     * 被选中的记忆 **id**（**只有 id**）。
     *
     * 整条路径上**没有任何一处**把正文放进这个字段：外壳拿到 id 也读不到正文
     * （正文的读取面属于开发者面，不属于入口桥）。
     */
    selectedMemoryIds: readonly string[]
  }
  /** 这一次准备**有没有写任何东西**（恒为 `false`；它是一句可核对的断言，不是装饰） */
  wroteAnything: false
}

/** 只读准备的拒绝读数（失败关闭；`outcome: 'rejected'` 时必有 `code`） */
export interface BridgePrepareResult {
  outcome: 'prepared' | 'rejected' | 'failed'
  code?: string
  reading?: BridgePrepareReading
}

/**
 * ADR-131 `D18`：一次主动开口机会的**读数**。
 *
 * ⚠️ 与 `BridgePrepareReading` 同族，但有三处**必须不同**：
 * ```text
 * ① 它有 `decision` 三态（spoken / silenced / deferred）—— 与 `OPPORTUNITY_RESULT` 对齐
 * ② 它**可以**有正文（`text`）—— 那是"她真的说了"的唯一证据；
 *    而正文**只在这一个字段**：账本 / trace / 日志都不放（ADR-131 `D09`）
 * ③ 它带 `sourceRefs`（依据 id）与 `opportunityKey`（幂等键）—— 可审计、都不含正文
 * ```
 * ⚠️ `spoken` 的含义是"**已过预检 + 模型 + 回复守卫 + 仲裁，并已交给外壳**"，
 *    **不是**"我打算说"。裁决在 host 那一侧完成（`runOpeningOpportunity`）。
 */
export interface BridgeOpeningReading {
  readonly decision: 'spoken' | 'silenced' | 'deferred'
  /** 具名理由（`silenced` / `deferred` 时必有） */
  readonly code?: string
  /**
   * ⚠️ **这里刻意没有 `text`**（ADR-131 `D18`：`OPPORTUNITY_RESULT` **不含正文**）。
   *
   * 第一版我在这里放了 `text`，那是**违反 `D18`** 的：她说的那句话只能从
   * `CHARACTER_OUTPUT`（**投递通道**）出去 —— 那是"她真的说了"的唯一出口。
   * 若 `OPPORTUNITY_RESULT` 也带正文，就会出现**第二条投递路径**，
   * 而且会诱使外壳去播它（两个来源、两份真相）。
   * ⇒ 本读数只回答"**她说了没有 / 为什么没说**"，正文去 `CHARACTER_OUTPUT` 里拿。
   */
  readonly yieldedFloor?: true
  readonly sourceRefs?: readonly string[]
  readonly opportunityKey?: string
  readonly idleMs?: number
  /** 回复守卫有没有改写正文（"守卫在工作"，不是产品失败） */
  readonly guardCorrected?: boolean
}

/** 机会报文的响应（`outcome` 与 `PREPARE_RESULT` 同族，便于外壳用一套解析） */
export interface BridgeOpeningResult {
  readonly outcome: 'spoken' | 'silenced' | 'deferred' | 'rejected' | 'failed'
  readonly code?: string
  readonly reading?: BridgeOpeningReading
}

/**
 * 交付账的**只读**视图（装配层用它在构造 `recentLines` 时做保守处理）。
 *
 * ⚠️ 名字里的 "voice" 是刻意的：它只回答"**语音交付**说了哪些句子"，
 * **不**是"她生成过哪些句子"（生成记录完整保留在 conversation_events 里）。
 */
export interface VoiceDeliveryReading {
  /** 账上有几段 */
  segmentCount: number
  /** 已播出（`played`）的片段正文，按 `replyId` + `index` 拼回 */
  playedTextByReplyId: Readonly<Record<string, string>>
  /** 一个 replyId 的**全部**片段是否都已播出 */
  fullyPlayed(replyId: string): boolean
  /** 一个 replyId 里**还没**播出的片段编号（升序） */
  unplayedIndexes(replyId: string): readonly number[]
}

/**
 * 交付账的写入面（装配层持有它；桥只通过 host 端口转发回报）。
 *
 * ⚠️ 三个方法都**不**碰数据库、**不**碰模型：交付事实是**客户端报告**，
 * 不是"LG 自己推断出来的"。
 */
export interface VoiceDeliveryPort extends VoiceDeliveryReading {
  /**
   * LG 生成了一段**已过回复守卫**的正文 ⇒ 开生成账。
   *
   * ⚠️ `segments` 必须来自 `SpeechExpression.segments`（`completeTurn` 之后的
   *    那一段），**不是**模型原始输出的切句结果。
   */
  openReply(input: {
    replyId: string
    segments: readonly { segmentId: string; text: string }[]
    at?: number
    by?: string
  }): void
  /** 应用一条合成完成回报（**必须**带 `audioId`；迁移表自己会拒绝没有它的那一跳） */
  reportSynthesized(input: {
    segmentId: string
    audioId: string
    at?: number
    by?: string
    reason?: string
  }): BridgeSynthesisReportResult
  /** 应用一条客户端播放回报 */
  report(input: {
    segmentId: string
    state: BridgePlaybackState
    at?: number
    by?: string
    playedFrom?: number
    playedTo?: number
    reason?: string
  }): BridgePlaybackReportResult
  /**
   * **新轮次顶掉上一轮**（Lv4.5 / P1 · 计划 §1「旧任务不串话」）。
   *
   * ⚠️ 它把"悬着的"交付态定案：`queued`（还没开播）⇒ `cancelled`；
   *    `playing` / `synthesized`（**已经发出去了**）⇒ `unknown`。
   *    终态一个都不动 —— 已经定案的事实不允许被后续轮次改写。
   */
  markSuperseded(input?: { at?: number; by?: string; reason?: string }): readonly string[]
}

/**
 * 取消的**诚实读数**（没有任何一项主张"已经撤销了什么"）。
 *
 * ```text
 * requested        我们记下了取消意图（**不等于**已经停下）
 * stoppedBeforeModel  在**模型调用之前**就停住了 ⇒ 这一轮真的省下了
 * alreadyCommitted 这一轮**已经提交**到账本 ⇒ 取消**不能**撤销它（这是事实，不是失败）
 * cancellablePoints 这一轮当前还允许在哪些点被停住（诊断用）
 * ```
 */
export interface BridgeCancelReading {
  requested: boolean
  stoppedBeforeModel: boolean
  alreadyCommitted: boolean
  cancellablePoints: readonly string[]
}

export interface BridgeWireResponse {
  speech?: CheckedSpeechSegment
  streamStatus?: BridgeSubmitResult['streamStatus']
  expression?: SpeechExpression
  kind:
    | 'TURN_RESULT'
    | 'SPEECH_SEGMENT'
    | 'CANCEL_RESULT'
    | 'SYNTHESIS_RESULT'
    | 'PLAYBACK_RESULT'
    | 'PREPARE_RESULT'
    /**
     * Lv4.5 / `P3`：**有来源的角色输出**（LG → 外壳的**出站**消息）。
     *
     * ⚠️ 与其它几种的方向相反：它不是"对某条请求的回答"，而是 LG **主动**交出一句
     *    **已经有来源、已经过守卫**的短句，让外壳去播。因此它的 `requestId` 恒为空，
     *    外壳**不**能拿它当作某轮的结果（轮次结果只从 `TURN_RESULT` 来）。
     */
    | 'CHARACTER_OUTPUT'
    /**
     * post-Lv2 / ADR-110 `D06`：**主动投递给 QQ 外壳的一条文字**（核心 → 外壳）。
     *
     * ```text
     * 它**不**是某轮的结果（`requestId` = `deliveryId`，不是轮次 id）
     * 它**不**复用 TURN_RESULT：外壳对每个 requestId 只 resolve 一次并删 pending，
     *   复用会让某一轮被错误地 resolve（WP0 §5.7 ①）
     * 它**必须**由外壳经**同一条**发送串行队列投递（普通回复优先）
     * ```
     */
    | 'DELIVER_QQ_TEXT'
    | 'DELIVER_REMINDER_TEXT'
    /** Lv4.5 / ADR-131 `D18`：机会报文的响应（外壳用与 `PREPARE_RESULT` 同一套解析） */
    | 'OPPORTUNITY_RESULT'
  requestId: string
  outcome: BridgeTurnOutcome | 'cancelled' | 'accepted' | 'prepared' | 'spoken' | 'generated'
  code?: string
  replyText?: string
  replyId?: string
  traceId?: string
  domainEventIds?: readonly string[]
  /** `TURN_RESULT` 才有 */
  delivery?: BridgeSubmitResult['delivery']
  /** `CANCEL_RESULT` 才有 */
  cancel?: BridgeCancelReading
  /**
   * `SYNTHESIS_RESULT` 才有：合成账**有没有**被这条回报推进。
   *
   * ⚠️ `accepted: false` 在这里同样是**常态**（同一段被分块合成多次 ⇒ 幂等吸收）。
   */
  synthesis?: BridgeSynthesisReportResult
  /**
   * `PLAYBACK_RESULT` 才有：交付账**有没有**被这条回报推进。
   *
   * ⚠️ `accepted: false` 是**常态**（重复包 / 乱序包 / 进程重启过），
   * 不是故障 —— 回报的语义是"如实记下客户端说的"，不是"必须改变什么"。
   */
  playback?: BridgePlaybackReportResult
  /**
   * `DELIVER_QQ_TEXT` 才有：这一次投递要送出去的文字。
   *
   * ⚠️ 它是**已过回复守卫**的正文（与 `TURN_RESULT.replyText` 同一条纪律）：
   *    桥**不**生成、**不**检查正文，只运输。长度由生产方（投递登记）保证有界。
   */
  qqText?: string
  reminderText?: string
  /**
   * `REPORT_QQ_DELIVERY` 才有：投递登记**有没有**被这条回执推进。
   *
   * ⚠️ `accepted: false` 同样是**常态**（重复回执 / 旧代次回执 / 未知 deliveryId）——
   *    它不是"投递失败"，而是"这条回执没有改变任何东西"。
   */
  qqDelivery?: BridgeQqDeliveryReportResult
  /**
   * `PREPARE_RESULT` 才有：**只读准备**读数。
   *
   * ⚠️ 这一支**从不**带 `replyText` / `replyId` / `traceId`：
   *    准备不产出她的话，也不落任何账（见 {@link BridgePrepareReading}）。
   */
  prepare?: BridgePrepareReading
  /**
   * `OPPORTUNITY_RESULT` 才有：**主动开口机会**的读数（ADR-131 `D18`）。
   *
   * ⚠️ 与 `prepare` 同族，但有一处**必须不同**：它**可以**带正文（`reading.text`）——
   *    那是"她真的说了"的唯一证据。而正文**只在这一个字段**：
   *    账本 / trace / 日志都不放（`D09`）。
   */
  opening?: BridgeOpeningReading
  /**
   * `CHARACTER_OUTPUT` 才有：**有限插话**的内容与来源。
   *
   * ⚠️ 它**必须**带 `sourceRefs`（非空）：这是"有来源的角色输出"这句话的字面实现，
   *    也是与"随便冒一句"的分界线。`yieldFloor` 恒为 `true`（说完让出话权）。
   */
  characterOutput?: {
    revision: number
    source: string
    sourceRefs: readonly string[]
    text: string
    yieldFloor: true
    /**
     * 这条短句的**分句与表达**（可选）。
     *
     * ⚠️ 为什么它**可以**缺席：没有它时外壳只能按纯文本播（丢掉表情/口型），
     *    但有它时走的才是**与正式轮次完全相同**的那条交付链（合成账 / 交付账 /
     *    字幕 / 手势）。缺席 ⇒ 如实降级，**不**伪造一个 sidecar。
     */
    expression?: SpeechExpression
  }
}

export function isBridgeMessageKind(value: unknown): value is BridgeMessageKind {
  return typeof value === 'string' && (BRIDGE_MESSAGE_KINDS as readonly string[]).includes(value)
}

/**
 * 客户端**能报**的播放状态（形状判据，**唯一**一处）。
 *
 * ⚠️ `generated` / `synthesized` **不在**表里：那是 LG 与 TTS 侧的事实，
 *    客户端报它们就等于在替别人写账 —— 正是契约 §1 第一条禁令要挡的东西。
 */
export function isReportablePlaybackState(value: unknown): value is BridgePlaybackState {
  return (
    typeof value === 'string' &&
    (BRIDGE_PLAYBACK_STATES as readonly string[]).includes(value)
  )
}

/**
 * 处理一条线上消息（**失败关闭**）。
 *
 * 未登记的 `kind` ⇒ 拒绝，且理由码是 `bridge_unknown_message_kind`
 * —— 这是"不建万能连接器框架"的机器形态：新种类必须先登记。
 */
export async function handleBridgeMessage(
  bridge: TurnBridge,
  message: unknown
): Promise<BridgeWireResponse> {
  if (message === null || typeof message !== 'object') {
    return { kind: 'TURN_RESULT', requestId: '', outcome: 'rejected', code: 'bridge_bad_request', delivery: 'rejected' }
  }
  const kind = (message as { kind?: unknown }).kind
  if (!isBridgeMessageKind(kind)) {
    return {
      kind: 'TURN_RESULT',
      requestId: typeof (message as { requestId?: unknown }).requestId === 'string'
        ? String((message as { requestId?: unknown }).requestId)
        : '',
      outcome: 'rejected',
      code: 'bridge_unknown_message_kind',
      delivery: 'rejected',
    }
  }
  const requestId = (message as { requestId?: unknown }).requestId
  const normalizedRequestId = typeof requestId === 'string' ? requestId : ''

  /*
   * ---------------------------------------------------------------------------
   * CANCEL_TURN（后 Lv2 · `L-PL2-04`）
   * ---------------------------------------------------------------------------
   * ⚠️ 三条都不可省：
   *   ① host **没有**取消能力 ⇒ 如实拒绝（`cancel_capability_absent`），不假装成功
   *   ② `requestId` 必须非空：取消一条我们认不出来的轮次是无意义的，
   *      而且会让"取消"变成一个可以乱发的动作
   *   ③ 已提交的轮次 ⇒ 取消**照样**被受理，但读数里 `alreadyCommitted: true`
   *      —— 受理与"撤销"是两件事，把后者说成前者就是撒谎
   */
  if (kind === 'CANCEL_TURN') {
    if (normalizedRequestId === '') {
      return {
        kind: 'CANCEL_RESULT',
        requestId: '',
        outcome: 'rejected',
        code: 'cancel_without_request_id',
      }
    }
    if (bridge.hostCancelTurn === undefined) {
      return {
        kind: 'CANCEL_RESULT',
        requestId: normalizedRequestId,
        outcome: 'rejected',
        code: 'cancel_capability_absent',
      }
    }
    const reason = (message as { reason?: unknown }).reason
    const reading = await bridge.hostCancelTurn({
      requestId: normalizedRequestId,
      ...(typeof reason === 'string' ? { reason } : {}),
    })
    return {
      kind: 'CANCEL_RESULT',
      requestId: normalizedRequestId,
      /* ⚠️ 结局只有两种：记下了（`cancelled`）或没记下（`rejected`）。
         **没有**"已撤销"这个结局 —— 那不是一个我们能做到的事。 */
      outcome: reading.requested ? 'cancelled' : 'rejected',
      ...(reading.requested ? {} : { code: 'cancel_not_requested' }),
      cancel: reading,
    }
  }

  /*
   * ---------------------------------------------------------------------------
   * REPORT_SYNTHESIZED（Lv4.5 / `P1`）
   * ---------------------------------------------------------------------------
   * ⚠️ 同样**不排队**：慢轮次期间 TTS 完成一样要立刻回账，
   *    否则下一段的播放事实没有落脚的前置状态。
   */
  if (kind === 'REPORT_SYNTHESIZED') {
    const segmentId = (message as { segmentId?: unknown }).segmentId
    const normalizedSegmentId = typeof segmentId === 'string' ? segmentId : ''
    if (normalizedSegmentId.trim() === '') {
      return {
        kind: 'SYNTHESIS_RESULT',
        requestId: normalizedRequestId,
        outcome: 'rejected',
        code: 'synthesis_report_without_segment',
      }
    }
    const handler = bridge.hostReportSynthesized
    if (handler === undefined) {
      return {
        kind: 'SYNTHESIS_RESULT',
        requestId: normalizedRequestId,
        outcome: 'rejected',
        code: 'synthesis_report_unsupported',
      }
    }
    const raw = message as { audioId?: unknown; detail?: unknown }
    const reading = await handler({
      segmentId: normalizedSegmentId,
      /* ⚠️ 这里**不**兜底成一个编造的 audioId：缺席就是缺席（`''`），
         交给迁移表按 `synthesis_without_audio_id` 拒绝。 */
      audioId: typeof raw.audioId === 'string' ? raw.audioId : '',
      ...(typeof raw.detail === 'string' ? { reason: raw.detail } : {}),
    })
    return {
      kind: 'SYNTHESIS_RESULT',
      requestId: normalizedRequestId,
      outcome: reading.accepted ? 'accepted' : 'rejected',
      ...(reading.code !== undefined ? { code: reading.code } : {}),
      synthesis: reading,
    }
  }

  /*
   * ---------------------------------------------------------------------------
   * REPORT_PLAYBACK（Lv4.5 / `P1`）
   * ---------------------------------------------------------------------------
   * ⚠️ 它是**控制消息**：只更新进程内交付账，不写数据库、不调模型。
   *    因此它在传输层**不排队**（慢轮次期间照样被读到）——
   *    否则"用户抢话后立刻停播"与"播放事实及时回账"两件事都做不到。
   *
   * ⚠️ 三条失败关闭：
   *   ① 缺 `segmentId` ⇒ 拒绝（`playback_report_without_segment`）
   *   ② 状态不在客户端**能报**的那五个里 ⇒ 拒绝（`playback_report_unknown_state`）
   *   ③ host 没有交付账 ⇒ 如实拒绝（`playback_report_unsupported`），不假装记下
   */
  if (kind === 'REPORT_PLAYBACK') {
    const segmentId = (message as { segmentId?: unknown }).segmentId
    const normalizedSegmentId = typeof segmentId === 'string' ? segmentId : ''
    if (normalizedSegmentId.trim() === '') {
      return {
        kind: 'PLAYBACK_RESULT',
        requestId: normalizedRequestId,
        outcome: 'rejected',
        code: 'playback_report_without_segment',
      }
    }
    const state = (message as { playbackState?: unknown }).playbackState
    if (!isReportablePlaybackState(state)) {
      return {
        kind: 'PLAYBACK_RESULT',
        requestId: normalizedRequestId,
        outcome: 'rejected',
        code: 'playback_report_unknown_state',
      }
    }
    const handler = bridge.hostReportPlayback
    if (handler === undefined) {
      return {
        kind: 'PLAYBACK_RESULT',
        requestId: normalizedRequestId,
        outcome: 'rejected',
        code: 'playback_report_unsupported',
      }
    }
    const raw = message as {
      audioId?: unknown
      playedFrom?: unknown
      playedTo?: unknown
      detail?: unknown
    }
    const reading = await handler({
      segmentId: normalizedSegmentId,
      state,
      ...(typeof raw.playedFrom === 'number' ? { playedFrom: raw.playedFrom } : {}),
      ...(typeof raw.playedTo === 'number' ? { playedTo: raw.playedTo } : {}),
      ...(typeof raw.detail === 'string' ? { reason: raw.detail } : {}),
    })
    return {
      kind: 'PLAYBACK_RESULT',
      requestId: normalizedRequestId,
      outcome: reading.accepted ? 'accepted' : 'rejected',
      ...(reading.code !== undefined ? { code: reading.code } : {}),
      playback: reading,
    }
  }

  /*
   * ---------------------------------------------------------------------------
   * REPORT_QQ_DELIVERY（post-Lv2 / ADR-110 `D06`/`D08`）
   * ---------------------------------------------------------------------------
   * ⚠️ 它是**控制消息**：只推进投递登记，不写库、不调模型、**不排队**。
   *
   * ⚠️ 四条失败关闭（每条都有具名码）：
   * ```text
   * ① `deliveryId` 为空 ⇒ `qq_delivery_report_without_id`
   *    （认不出来的投递回执是无意义的 —— 与 `CANCEL_TURN` 拒空 id 同一个立场）
   * ② `deliveryStatus` 不在闭集 ⇒ `qq_delivery_report_unknown_status`
   * ③ host 没有投递登记 ⇒ 如实拒绝（`qq_delivery_report_unsupported`），不假装记下
   * ④ **不是** `api_accepted` 却带了 `messageId` ⇒ `qq_delivery_report_unexpected_message_id`
   *    （`D08`：只有平台接受才有回执 id；带了就说明这一条自相矛盾）
   * ```
   */
  if (kind === 'REPORT_QQ_DELIVERY' || kind === 'REPORT_REMINDER_DELIVERY') {
    const resultKind = kind === 'REPORT_QQ_DELIVERY' ? 'DELIVER_QQ_TEXT' : 'DELIVER_REMINDER_TEXT'
    const raw = message as {
      deliveryId?: unknown
      deliveryStatus?: unknown
      messageId?: unknown
      attempt?: unknown
      detail?: unknown
    }
    const deliveryId = typeof raw.deliveryId === 'string' ? raw.deliveryId.trim() : ''
    if (deliveryId === '') {
      return {
        kind: resultKind,
        requestId: '',
        outcome: 'rejected',
        code: 'qq_delivery_report_without_id',
        qqDelivery: { accepted: false, code: 'qq_delivery_report_without_id' },
      }
    }
    if (!isBridgeQqDeliveryStatus(raw.deliveryStatus)) {
      return {
        kind: resultKind,
        requestId: deliveryId,
        outcome: 'rejected',
        code: 'qq_delivery_report_unknown_status',
        qqDelivery: { accepted: false, code: 'qq_delivery_report_unknown_status' },
      }
    }
    const messageId = typeof raw.messageId === 'string' && raw.messageId.trim() !== ''
      ? raw.messageId.trim()
      : undefined
    if (raw.deliveryStatus !== 'api_accepted' && messageId !== undefined) {
      return {
        kind: resultKind,
        requestId: deliveryId,
        outcome: 'rejected',
        code: 'qq_delivery_report_unexpected_message_id',
        qqDelivery: { accepted: false, code: 'qq_delivery_report_unexpected_message_id' },
      }
    }
    const handler = kind === 'REPORT_QQ_DELIVERY' ? bridge.hostReportQqDelivery : bridge.hostReportReminderDelivery
    if (handler === undefined) {
      return {
        kind: resultKind,
        requestId: deliveryId,
        outcome: 'rejected',
        code: 'qq_delivery_report_unsupported',
        qqDelivery: { accepted: false, code: 'qq_delivery_report_unsupported' },
      }
    }
    const reading = await handler({
      deliveryId,
      status: raw.deliveryStatus,
      ...(messageId === undefined ? {} : { messageId }),
      ...(typeof raw.attempt === 'number' ? { attempt: raw.attempt } : {}),
      ...(typeof raw.detail === 'string' ? { reason: raw.detail } : {}),
    })
    return {
      kind: resultKind,
      requestId: deliveryId,
      outcome: reading.accepted ? 'accepted' : 'rejected',
      ...(reading.code !== undefined ? { code: reading.code } : {}),
      qqDelivery: reading,
    }
  }

  /*
   * ---------------------------------------------------------------------------
   * PROACTIVE_OPPORTUNITY（Lv4.5 / ADR-131 `D01` · `D18`）
   * ---------------------------------------------------------------------------
   * ⚠️ 它**不是输入**：不落 `user_message`、不占正式轮次、不写记忆、**不产出她的话**
   *    （她的话由 host 裁决后经 `CHARACTER_OUTPUT` 走**既有**那条出站）。
   *
   * ⚠️ 三条失败关闭：
   *   ① 入口不是 `OPENING_ENTRY` 或 `idleMs` 非法 ⇒ 形状拒（**一次模型调用都不花**）
   *   ② host 没有这个能力 ⇒ `opening_capability_absent`（**不假装**评估过）
   *   ③ host 抛错 ⇒ `failed` + 具名码（**不**回落、**不**吞掉）
   *
   * ⚠️ `outcome` 只用既有那几个字面量（`spoken` / `rejected` / `failed`），
   *    而把**细分三态**放在 `reading.decision`（`spoken` / `silenced` / `deferred`）——
   *    这样既不动共享的 `outcome` 联合，又保留 ADR-131 `D18` 的形状。
   */
  if (kind === 'PROACTIVE_OPPORTUNITY') {
    const entry = String((message as { entry?: unknown }).entry ?? '')
    const idleRaw = (message as { idleMs?: unknown }).idleMs
    const idleMs =
      typeof idleRaw === 'number' && Number.isFinite(idleRaw) && idleRaw >= 0 ? idleRaw : undefined
    if (entry !== OPENING_ENTRY || idleMs === undefined) {
      return {
        kind: 'OPPORTUNITY_RESULT',
        requestId: normalizedRequestId,
        outcome: 'rejected',
        code: 'opening_packet_shape_invalid',
      }
    }
    const handler = bridge.hostOpeningOpportunity
    if (handler === undefined) {
      return {
        kind: 'OPPORTUNITY_RESULT',
        requestId: normalizedRequestId,
        outcome: 'rejected',
        code: 'opening_capability_absent',
      }
    }
    try {
      const reading = await handler({
        requestId: normalizedRequestId,
        entry,
        idleMs,
        /*
         * ⚠️ 这三个是**桥自己的读数**（WP5b 侦察修正）：
         *    `userSpeaking` 与 `hasLiveClient` 在装配层**拿不到** ——
         *    它们分别是 `submittedTurns` 与 `outputSink` 的私有状态。
         *    若让装配层去猜，就会多出第二处"谁在说话"的定义（`D07` 的第二次实现）。
         */
        turnRevision: bridge.submittedTurnRevision + 1,
        floor: { userSpeaking: false, userRevision: bridge.submittedTurnRevision },
        hasLiveClient: bridge.outputCapable,
      })
      return {
        kind: 'OPPORTUNITY_RESULT',
        requestId: normalizedRequestId,
        outcome: reading.decision === 'spoken' ? 'spoken' : 'rejected',
        ...(reading.code !== undefined ? { code: reading.code } : {}),
        opening: reading,
      }
    } catch {
      return {
        kind: 'OPPORTUNITY_RESULT',
        requestId: normalizedRequestId,
        outcome: 'failed',
        code: 'opening_handler_threw',
      }
    }
  }

  /*
   * ---------------------------------------------------------------------------
   * PREPARE_TURN（Lv4.5 / `P2` · "边听边准备"）
   * ---------------------------------------------------------------------------
   * ⚠️ 它是**只读**的：不写事件、不写记忆、不调模型、不产出她的话。
   *    因此它在传输层**不排队**（慢轮次期间照样能被读到），
   *    而且它的响应形状里**没有** `replyText` / `replyId` / `traceId`。
   *
   * ⚠️ 三条失败关闭：
   *   ① 文本为空或超长 ⇒ 拒绝（复用与 `SUBMIT_TURN` **同一处**的形状检查）
   *   ② host 没有只读准备能力 ⇒ 如实拒绝（`prepare_capability_absent`），不假装准备了
   *   ③ host 抛错 ⇒ `failed` + 具名码（**不**回落、**不**吞掉）
   */
  if (kind === 'PREPARE_TURN') {
    const userText = (message as { userText?: unknown }).userText
    const shape = bridge.validatePrepare({ requestId: normalizedRequestId, userText: typeof userText === 'string' ? userText : '' })
    if (shape !== undefined) {
      return { kind: 'PREPARE_RESULT', requestId: normalizedRequestId, outcome: 'rejected', code: shape }
    }
    const handler = bridge.hostPrepareTurn
    if (handler === undefined) {
      return {
        kind: 'PREPARE_RESULT',
        requestId: normalizedRequestId,
        outcome: 'rejected',
        code: 'prepare_capability_absent',
      }
    }
    const candidateRevision = (message as { candidateRevision?: unknown }).candidateRevision
    /** 提前检索的结局（`P3` 选项 B）；随 `PREPARE_RESULT` 回给外壳 */
    let lookupOutcome:
      | { status: string; code?: string; detail?: string; corrected?: boolean; superseded?: number | null }
      | undefined
    /** P3 中途纠正（**用户更正**那条路）的读数；随 PREPARE_RESULT.correction 回给外壳 */
    let correctionOutcome: { superseded: number | null } | undefined
    try {
      const reading = await handler({
        userText: String(userText),
        requestId: normalizedRequestId,
        ...(typeof candidateRevision === 'string' ? { candidateRevision } : {}),
      })
      /*
       * Lv4.5 / `P3`：**呼唤**的产出点。
       *
       * ============================================================================
       *  为什么挂在这里（而不是新开一条"每块音频都问一次 LG"的路）
       * ============================================================================
       * ```text
       * ① 这条路上已经有**候选文本**（`LGIncrementalASR` 的 partial）与**版本**
       *    （`candidateRevision`）—— 呼唤判定要的两样东西都在这儿，不必新铺一条线。
       * ② 它是**只读**的：判定不改任何账；真的要说时走的是 `emitCharacterOutput`
       *    那条**独立**的出站通道（有来源、有版本、有让出话权）。
       * ③ 与 P2 的分工不变：`detectFastSignal` 判"是不是在叫她"（含引用/否定/回声负控），
       *    `arbitrateCharacterOutput` 判"这条能不能现在说"。
       * ```
       *
       * ⚠️ 它**只**对 `wake` 产出。`stop` 是**停**（走取消那条路），不是"说一句话"——
       *    把 stop 也变成一次发言，会让"用户要她闭嘴"变成"她又说了一句"。
       */
      if (bridge.interjectionEnabled) {
        const signal = detectFastSignal({ text: String(userText) })
        const prepareUtteranceKey = (message as { utteranceKey?: unknown }).utteranceKey
        const utteranceKeyOfPrepare =
          typeof prepareUtteranceKey === 'string' && prepareUtteranceKey !== '' ? prepareUtteranceKey : undefined
        if (signal.kind === 'correction') {
          /*
           * ==================================================================
           *  `P3` 中途纠正（**用户更正**这条路）
           * ==================================================================
           * 计划 §3 第 24 行：「合法新证据**或用户更正**到达时，废弃未播余句，
           * 由 LG 重新判断、检查并给出纠正段」。
           *
           * ```text
           * 她说的时候用户说"不对" ⇒ 她剩下的未播句子**建在一个被否定的前提上**
           *   ⇒ 先废余句（交付账 markSuperseded），再给一条**检查过**的纠正段
           * 她**没在说**      ⇒ 没有"余句"可废、也没有什么要纠正的 ⇒ **什么都不做**
           *                      （那句话会作为普通输入进入下一轮，她自己会回应）
           * ```
           * ⚠️ 判据是**前提**（她正在说）而不是"内容对不对" —— 后者是语义判断，
           *    属于回复守卫与那一轮本身，不属于这条快通道。
           * ⚠️ 去重（与呼唤同一把不透明键）：partial 是反复到达的，不去重会**每一条都纠一次**。
           */
          const key = utteranceKeyOfPrepare
          const alreadyCorrected = key !== undefined && key === bridge.correctedUtteranceKey
          /* ⚠️ 时机**在这里判一次**：随后"废余句"会让 `hasUnplayed()` 变成 false（见 `emitMidTurnCorrection`） */
          const speakingAtEntry = bridge.sheIsSpeakingNow
          if (!alreadyCorrected && speakingAtEntry) {
            if (key !== undefined) bridge.markCorrected(key)
            /*
             * ⚠️ 顺序与另一个 arm 相同：**先废余句，再给纠正段**（顺序即语义）。
             *    `superseded` 必须**回给外壳**（随 `PREPARE_RESULT.correction`）——
             *    否则"旧余句失效"只能靠**推断**，而验收行要的是**读数**：
             *    到底作废了几段？（`0` 也是有效读数："当时没有未播余句"）
             */
            const superseded = bridge.hostSupersedeUnplayed?.({
              by: 'mid_turn_correction',
              reason: 'user_correction',
            })
            correctionOutcome = { superseded: superseded ?? null }
            bridge.emitMidTurnCorrection({
              sourceRefs: [`signal:correction:${typeof candidateRevision === 'string' ? candidateRevision : normalizedRequestId}`],
              sheIsSpeaking: speakingAtEntry,
            })
          }
        } else if (signal.kind === 'wake') {
          bridge.emitWakeResponse({
            signalRef: `signal:wake:${typeof candidateRevision === 'string' ? candidateRevision : normalizedRequestId}`,
            /* ⚠️ 外壳没给键 ⇒ 传 undefined ⇒ **不去重**（宁可多说一次，不要永久哑掉） */
            ...(utteranceKeyOfPrepare !== undefined ? { utteranceKey: utteranceKeyOfPrepare } : {}),
          })
        } else {
          /*
           * Lv4.5 / `P3`（选项 B）：**边听边查**。
           *
           * ```text
           * ① 复用 **M5.5 的显式搜索词形判定**（`createExternalEvidenceIntentDetector`）
           *    —— 不另发明一套触发词：那会把"授权边界"变成两处实现
           * ② 同一次发音**只查一次**（见 `lookupUtteranceKey` 的注释：partial 是反复到达的，
           *    不去重就是每一条都买一次检索）
           * ③ 只有 host 提供 `prepareLookup` 时才真的去查（否则如实不查）
           * ④ 查到了**且她正在说**才插一句（时机判据见 `emitLookupNotice`）
           * ```
           * ⚠️ 它**只读**：不落用户事件、不写记忆、不占正式轮次。
           */
          const lookup = bridge.hostPrepareLookup
          /*
           * ⚠️ **先判词形、再去重**（顺序反了会让这个功能永远不触发）：
           *    partial 是**生长的** —— "帮我查"（还不是显式词形）先到，
           *    "帮我查一下"（是显式词形）后到，**同一次发音**。
           *    若在第一次就把键记下，后面那条真正的请求就被去重吃掉了。
           *    所以：**只有决定真的要查了，才消耗这次发音的键**。
           */
          const intent = lookup === undefined ? undefined : bridge.explicitSearchIntent(String(userText))
          /*
           * ⚠️ **碎片不消耗这一枪**（与"先判词形、再去重"同一条纪律的第三处）：
           *    partial 是**生长的**，最早命中的那条常常只抽出一个字
           *    （实测 `query="替"` ⇒ Tavily **HTTP 400** ⇒ 这一枪必然浪费，
           *    而键一旦记下就再也没有第二枪）。
           *    ⇒ query 不够查 ⇒ **不查、也不记键**，等后面那条更完整的 partial。
           */
          const queryIsUsable = intent !== undefined && usableLookupQuery(intent.query)
          if (lookup !== undefined && intent !== undefined && queryIsUsable && bridge.shouldLookupFor(utteranceKeyOfPrepare)) {
            const lookupReading = await lookup({
              userText: String(userText),
              query: intent.query,
              requestId: normalizedRequestId,
            })
            /*
             * ⚠️ **失败要还回这次发音的键**（`P3` 选项 B 的第二个实测缺陷）。
             *
             * ```text
             * 记键的目的是"同一次发音只**买一次**检索"（partial 是反复到达的）
             * 但**失败**不是"买到了"：网关抛错 / 策略拒 / 校验不过都属于"这一枪没打出去"
             * ⇒ 若还占着键，这条发音就**永远不会再试** —— 一次瞬时失败 = 整个功能静默失效
             * ```
             * ⚠️ 仍然**不会**变成无限重试：每一次重试都由**新的 partial** 驱动，
             *    而 partial 的条数是有限的（说话会被识别成有限段），且成功/查到后键会重新占住。
             */
            if (lookupReading.status === 'failed' || lookupReading.status === 'rejected') {
              bridge.releaseLookupFor(utteranceKeyOfPrepare)
            }
            lookupOutcome = {
              status: lookupReading.status,
              ...(lookupReading.code !== undefined ? { code: lookupReading.code } : {}),
              ...(lookupReading.detail !== undefined ? { detail: lookupReading.detail } : {}),
            }
            if (lookupReading.status === 'found' && (lookupReading.sourceRefs?.length ?? 0) > 0) {
              /*
               * ================================================================
               *  `P3` 中途纠正：**为这一次开口**的证据，晚于她开始回答才到
               * ================================================================
               * ```text
               * 同一次开口（utteranceKey 逐字相同）⇒ 她剩下的未播句子是在**没有这条证据**
               *   的情况下生成的 ⇒ 陈旧 ⇒ **先废弃未播余句**，再给一条检查过的纠正段
               * 不同 / 没有键            ⇒ 那条证据是给别的问题的 ⇒ 只提醒（不纠正）
               * ```
               * ⚠️ 判据**只有归属**，不判断"内容冲不冲突" —— 后者是语义判断，
               *    而这里要的是**机器可判**的那一部分（计划 §3 验收行的可判定形式）。
               */
              const sameUtterance =
                utteranceKeyOfPrepare !== undefined &&
                bridge.submittedUtteranceKey !== null &&
                utteranceKeyOfPrepare === bridge.submittedUtteranceKey
              if (sameUtterance) {
                /*
                 * ① **先判时机、再动账，而且时机只判这一次**（实测抓出两处顺序缺陷）：
                 *    她**没在说** ⇒ 根本没有"未播余句"可废 ⇒ **不许去动交付账**
                 *    （否则账上会记下"我作废了陈旧句子"，而当时一句话都没在播 ——
                 *      那是一条**没有发生过**的事实）。
                 *    在说 ⇒ 先废弃未播余句，**再**给纠正段（顺序即语义：余句已失效）。
                 * ② ⚠️ **`speakingAtEntry` 必须留给纠正段用**：废余句会把交付账里所有
                 *    未播片段变成终态 ⇒ 那一刻之后再问 `hasUnplayed()` 必然是 false
                 *    ⇒ 纠正段会被"她没在说"丢掉。**时机是入口的事实，一旦为真就为真。**
                 */
                const speakingAtEntry = bridge.sheIsSpeakingNow
                if (speakingAtEntry) {
                  const superseded = bridge.hostSupersedeUnplayed?.({
                    by: 'mid_turn_correction',
                    reason: 'late_evidence_for_this_utterance',
                  })
                  lookupOutcome = { ...lookupOutcome, corrected: true, superseded: superseded ?? null }
                }
                bridge.emitMidTurnCorrection({
                  sourceRefs: lookupReading.sourceRefs ?? [],
                  sheIsSpeaking: speakingAtEntry,
                })
              } else {
                bridge.emitLookupNotice({ sourceRefs: lookupReading.sourceRefs ?? [] })
              }
            }
          }
        }
      }
      return {
        kind: 'PREPARE_RESULT',
        requestId: normalizedRequestId,
        outcome: 'prepared',
        prepare: reading,
        /*
         * ⚠️ 提前检索的**结局**随协议回给外壳 ⇒ `/lg/status` 里能读到。
         *
         * **为什么不写日志**（实测踩出来的）：桥的 **stdout 就是 NDJSON 协议通道**，
         * 而外壳在 ready 之后会**丢弃**任何不是协议消息的行
         * （`postlv2_vtuber_runtime.py` 的两处 `if not self.ready: print(...stderr)`）。
         * 于是桥里 `logger.info` 写的诊断在**生产上根本读不到**，而启动期那几条能看到 ——
         * 我据此一度误判"这个分支没跑"，其实它跑了、只是**读数被扔掉**。
         * ⇒ 桥的运行期读数只有两条合法出路：**协议**（这里），或 **stderr**。
         */
        ...(lookupOutcome !== undefined ? { lookup: lookupOutcome } : {}),
        ...(correctionOutcome !== undefined ? { correction: correctionOutcome } : {}),
      }
    } catch (error) {
      const code = error instanceof KernelError ? error.code : 'prepare_failed'
      return { kind: 'PREPARE_RESULT', requestId: normalizedRequestId, outcome: 'failed', code }
    }
  }

  const userText = (message as { userText?: unknown }).userText
  /* `P3` 中途纠正：把外壳给的**开口键**原样转交（没有就省略 ⇒ 判据不成立 ⇒ 只提醒） */
  const submitUtteranceKey = (message as { utteranceKey?: unknown }).utteranceKey
  /*
   * `ADR-139` `D01`：平台事实**原样转交**给 `submit`（形状由 `validate()` 判；这里不重复判）。
   * ⚠️ 缺席 ⇒ **不加这个键**（`D03`：逐字旧行为）。
   */
  const submitPlatformFacts = (message as { platformFacts?: unknown }).platformFacts
  const result = await bridge.submit({
    requestId: normalizedRequestId,
    userText: typeof userText === 'string' ? userText : '',
    streamSpeech: (message as { streamSpeech?: unknown }).streamSpeech === true,
    ...('images' in message ? { images: (message as BridgeWireRequest).images } : {}),
    ...(submitPlatformFacts === undefined
      ? {}
      : { platformFacts: submitPlatformFacts as BridgeInboundPlatformFacts }),
    ...((message as BridgeWireRequest).groupContext === undefined ? {} : { groupContext: (message as BridgeWireRequest).groupContext }),
    ...(typeof submitUtteranceKey === 'string' && submitUtteranceKey !== ''
      ? { utteranceKey: submitUtteranceKey }
      : {}),
  })
  return {
    kind: 'TURN_RESULT',
    requestId: typeof requestId === 'string' ? requestId : '',
    outcome: result.outcome,
    ...(result.streamStatus !== undefined ? { streamStatus: result.streamStatus } : {}),
    ...(result.code !== undefined ? { code: result.code } : {}),
    ...(result.replyText !== undefined ? { replyText: result.replyText } : {}),
    ...(result.replyId !== undefined ? { replyId: result.replyId } : {}),
    ...(result.traceId !== undefined ? { traceId: result.traceId } : {}),
    ...(result.domainEventIds !== undefined ? { domainEventIds: result.domainEventIds } : {}),
    ...(result.expression !== undefined ? { expression: result.expression } : {}),
    /* `P4` 后的时延修复：阶段耗时随结果回外壳（**不**写日志：stdout 是协议通道） */
    ...(result.timings !== undefined ? { timings: result.timings } : {}),
    delivery: result.delivery,
  }
}
