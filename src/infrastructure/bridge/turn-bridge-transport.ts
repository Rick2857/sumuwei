/**
 * 后 Lv2 · WP1 —— **入口桥的传输与生产 host**（基础设施层）。
 *
 * ============================================================================
 *  载体：计划 §4 / §9（"受限的聊天/事件入口"）· ADR-091 §4 · `INV-PL2-09`/`INV-PL2-10`
 * ============================================================================
 * 两件事放在一起，因为它们是同一件事的两半：
 *
 * ```text
 *   TurnBridgeHost（kernel 侧端口）  ⟵  本模块的 host 实现（**生产轮次装配**）
 *   BridgeWireRequest/Response       ⟵  本模块的 stdio 传输（**受限入口**）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  为什么 host 必须是 `ChatSession` 自己，而不是"照着重写一遍"
 * ---------------------------------------------------------------------------
 * 重写的那一份已经在 R3 **真的漏掉过全部五道回复守卫**（而门照旧 PASS）。
 * 因此 `sessionHost()` 只做一件事：调 `ChatSession.send()` —— 生产那一套装配 ——
 * 再把它**实际用到的身份**（`lastTurnIdentity()`）带回来。
 *
 * ⚠️ 桥的 host 端口**没有**"裸模型"这条路：`send()` 里包含 `beginTurn` 的落账、
 *    `compileTurn` 的编译器、回复守卫链、`completeTurn` 的提交与慢路径。
 *    绕过其中任何一步都会让"同一套装配"这句话失效。
 *
 * ---------------------------------------------------------------------------
 *  传输的边界（受控登记表，且只在**本机**）
 * ---------------------------------------------------------------------------
 * · 换行分隔的 JSON（NDJSON），一行一条消息；
 * · 消息种类**只有** `turn-bridge.ts` 那张受控登记表里的几种；
 * · 未登记的消息种类 ⇒ 拒绝（不建"万能连接器框架"）；
 * · 传输层**不做**任何语义判断：它把行解析成消息、交给桥、把结果写回去。
 *   拒绝/失败的理由码一律由桥给出（只有一处判定）；
 * · **唯一的例外**是"排队还是立即"这一条：它按桥给出的
 *   `isBridgeControlMessageKind` 分类决定（见 `runBridgeTransport`），
 *   判据本身仍然只有一处。
 */

import {
  BRIDGE_MESSAGE_KINDS,
  TurnBridge,
  handleBridgeMessage,
  isBridgeControlMessageKind,
  type BridgeWireResponse,
  type TurnBridgeHost,
  type VoiceDeliveryPort,
} from '../../kernel/app/bridge/turn-bridge.ts'
import { KernelError } from '../../kernel/contracts/ids.ts'
import type { CheckedSpeechSegment } from '../../kernel/app/bridge/streaming-speech.ts'

// ---------------------------------------------------------------------------
// 生产 host：`ChatSession.send()` 的薄包装
// ---------------------------------------------------------------------------

/**
 * 取消登记表（后 Lv2 · `L-PL2-04`）。
 *
 * ============================================================================
 *  它是什么，以及它**不是**什么
 * ============================================================================
 * ```text
 * 是：  一个"哪些 requestId 被请求取消了"的**进程内**登记表
 * 不是：一个能撤销已提交轮次的东西 —— 取消**不撤销**任何已提交的账本行
 * ```
 * ⚠️ 它是**协作式**的：`cancel()` 只是**记下意图**；
 * 真正"停下"发生在 `ChatSession.send()` 内部的检查点
 * （它读 {@link TurnCancellationRegistry.isCancelled}）。
 *
 * ⚠️ 检查点必须是**无副作用的**：模型调用之前、写账本之前。
 * 一旦越过了提交点，取消就只能如实报 `alreadyCommitted: true`。
 */
export class TurnCancellationRegistry {
  private readonly cancelled = new Set<string>()
  private readonly committed = new Set<string>()
  private readonly modelStarted = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()

  signalFor(requestId: string): AbortSignal {
    let controller = this.controllers.get(requestId)
    if (controller === undefined) {
      controller = new AbortController()
      this.controllers.set(requestId, controller)
      if (this.isCancelled(requestId)) controller.abort()
    }
    return controller.signal
  }

  markModelStarted(requestId: string): void { this.modelStarted.add(requestId) }
  hasStartedModel(requestId: string): boolean { return this.modelStarted.has(requestId) }
  release(requestId: string): void { this.controllers.delete(requestId) }

  /** 记下取消意图（幂等） */
  cancel(requestId: string): void {
    if (requestId.trim() === '') return
    this.cancelled.add(requestId)
    this.controllers.get(requestId)?.abort()
  }

  /** 这一轮有没有被请求取消 */
  isCancelled(requestId: string): boolean {
    return this.cancelled.has(requestId)
  }

  /**
   * 标记"这一轮已经过了提交点"。
   *
   * ⚠️ 一旦标记，取消就**不再**声称能在模型前停下来 ——
   * 那是事实，不是失败（计划 §8.3：取消不撤销已提交的用户消息/记忆/副作用）。
   */
  markCommitted(requestId: string): void {
    this.committed.add(requestId)
  }

  hasCommitted(requestId: string): boolean {
    return this.committed.has(requestId)
  }

  /** 诊断用：登记表规模（**不含**任何正文） */
  get size(): number {
    return this.cancelled.size
  }
}

/** host 侧的取消读数构造（把"能不能停"与"已经停了没"分开报） */
export function cancelReadingOf(input: {
  requestId: string
  registry: TurnCancellationRegistry
  /** 这一轮当前是否还在"模型调用之前"（由 host 的检查点维护） */
  beforeModel: boolean
}): {
  requested: boolean
  stoppedBeforeModel: boolean
  alreadyCommitted: boolean
  cancellablePoints: readonly string[]
} {
  const alreadyCommitted = input.registry.hasCommitted(input.requestId)
  const requested = input.registry.isCancelled(input.requestId)
  /*
   * ⚠️ `stoppedBeforeModel` 的判据是**两件事同时成立**：
   *   ① 我们记下了取消意图
   *   ② 这一轮**还没**越过提交点，而且此刻确实还在模型之前
   * 只看 ① 会把"已经提交了才发现要取消"也说成省下来了 —— 那是假的。
   */
  const stoppedBeforeModel = requested && !alreadyCommitted && input.beforeModel
  return {
    requested,
    stoppedBeforeModel,
    alreadyCommitted,
    /* 越过提交点之后就**没有**可停的点了 —— 如实报空表，而不是编一个出来 */
    cancellablePoints: alreadyCommitted
      ? []
      : input.beforeModel
        ? ['before_model_call', 'before_ledger_commit']
        : ['before_ledger_commit'],
  }
}

/**
 * `ChatSession` 上本模块真正需要的**最小面**。
 *
 * ⚠️ 用结构化类型而不是 `import { ChatSession }`：`ChatSession` 住在 `src/main.ts`，
 * 而那个文件是**一体化的 CLI 入口**（它 import 整个运行时）。让基础设施反向 import
 * 它会制造一个环，也会把"transport 能不能单独测"这件事变成不可能。
 */
export interface BridgeSessionLike {
  send(userText: string, streaming?: {
    onSpeechSegment: (segment: CheckedSpeechSegment) => void
    signal?: AbortSignal
    onModelStart?: () => void
  }, images?: readonly import('../../kernel/contracts/image-input.ts').ImageInput[],
  /**
   * ★ U1 / `WP2b-2b`：**本轮作用域**（可选；`ADR-138` 的"每轮优先于会话级"）。
   * ⚠️ 用类型 import 而不是值 import（本文件对整个契约层都是类型依赖）。
   */
  turnScope?: import('../../kernel/contracts/scope.ts').ScopeContext,
  groupContext?: readonly import('../../kernel/app/bridge/turn-bridge.ts').BridgeGroupContextLine[]): Promise<string>
  lastTurnIdentity():
    | {
        replyId: string
        traceId: string
        domainEventIds: readonly string[]
        expression?: import('../../kernel/contracts/expressive-speech.ts').SpeechExpression
        streamStatus?: import('../../kernel/app/bridge/turn-bridge.ts').BridgeSubmitResult['streamStatus']
        /** 生成段内部的阶段耗时（`P4` 后的时延修复；可选） */
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
      }
    | undefined
  /**
   * Lv4.5 / `P2`：**只读准备**（可选）。
   *
   * ⚠️ 可选与 `cancelTurn` 同一条纪律：没有它的会话（纯文本 CLI 门、旧装配）
   *    会被桥如实报成 `prepare_capability_absent`，而不是假装准备了什么。
   * ⚠️ 实现**必须**是只读的：不写用户消息、不落事件、不推进序号。
   */
  prepare?(userText: string): Promise<{
    candidateRevision: string
    recall: {
      status: 'ran' | 'failed' | 'not_searched'
      cause?: string
      selectedCount: number
      selectedMemoryIds: readonly string[]
    }
    wroteAnything: false
  }>
  /** 装配层绑定的角色/会话（桥的身份来源；外壳**不能**改） */
  readonly characterId: string
  readonly conversationId: string
}

/**
 * 由 `ChatSession` 构造桥的 host。
 *
 * ⚠️ 身份取自 **session 自己**（它在构造时绑定），不取自请求 ——
 * 于是"外壳换一个 `characterId` 就能跟她说话"在**类型上**就不可能。
 *
 * ⚠️ `registry` 是可选的：不传 ⇒ host **没有**取消能力，
 * 桥会把取消请求如实拒掉（`cancel_capability_absent`），而不是假装成功。
 */
export function sessionHost(
  session: BridgeSessionLike,
  options: {
    cancellation?: TurnCancellationRegistry
    isBeforeModel?: (requestId: string) => boolean
    /**
     * Lv4.5 / `P1`：**交付账**（进程内）。
     *
     * ⚠️ 不传 ⇒ host **没有**交付账，桥会把播放回报如实报成
     *    `playback_report_unsupported`，而不是假装记下（与取消能力同一条纪律）。
     */
    delivery?: VoiceDeliveryPort
    /**
     * Lv4.5 / `P3`（选项 B）：**边听边查**的提前检索入口。
     *
     * ⚠️ 不传 ⇒ host **没有**这个能力 ⇒ 桥**不会**提前查
     *    （如实报"能力缺席"，与取消/交付账同一条纪律：失败关闭，不假装做过）。
     */
    lookup?: (input: { userText: string; query: string; requestId: string }) => Promise<{
      status: 'found' | 'not_found' | 'rejected' | 'failed'
      sourceRefs?: readonly string[]
      code?: string
    }>
    /**
     * Lv4.5 / `P3`（选项 B）：她**此刻是不是正在说**（决定"查到了"要不要现在插）。
     *
     * ⚠️ 不传 ⇒ 桥按"不知道"处理 ⇒ **不说**（宁可漏一次提醒，也不在错的时刻打断）。
     */
    sheIsSpeaking?: () => boolean
    /**
     * Lv4.5 / `P3`（中途纠正）：**废弃她当前回复里还没播的句子**。
     *
     * ⚠️ 不传 ⇒ 桥按"没有这个能力"处理（读数里 `superseded: null`），**不假装**作废过。
     */
    supersedeUnplayed?: (input: { by: string; reason: string }) => number
    /**
     * Lv4.5 / ADR-131 `D01`：**皮套入口的一次主动开口机会**。
     *
     * ⚠️ 不传 ⇒ 桥如实报 `opening_capability_absent`（**不假装**评估过）——
     *    与取消 / 交付账 / 提前查同一条纪律：**失败关闭，不假装做过**。
     *
     * ⚠️ 它的入参里有三个**桥自己的读数**（`turnRevision` / `floor` / `hasLiveClient`）：
     *    那三个由桥填，装配层**看不到**也**不该猜**（见 `TurnBridgeHost.openingOpportunity`）。
     */
    openingOpportunity?: TurnBridgeHost['openingOpportunity']
    /**
     * ★ U1 / `WP2b-2b`（`ADR-139` `D01`）：**入站平台事实 ⇒ 本轮作用域** 的解析能力 —— 可选。
     *
     * ```text
     * 为什么做成**注入**而不是在这里读库/读配置：
     *   本文件是**桥的传输层**，它不认识 `db`、也不认识"原主人是谁"（那是装配层的程序事实）。
     *   与取消 / 交付账 / 提前查 / 主动开口同一条纪律：
     *     **不传 ⇒ 没有这个能力** ⇒ 本轮不给每轮作用域 ⇒ 回落到会话级 ⇒ 逐字旧行为。
     * ⚠️ 实现方（装配层）必须用 `resolveInboundTurnScope`：它自己带三条失败关闭
     *   （没有平台账号 / 身份解析被拒 / 入口层取不到原主人 id）。
     * ⚠️ **失败关闭时返回 `scope: undefined`** ⇒ 本轮走"无每轮作用域"。
     *   若此时授权器已注入，结果是**全拒且计数可观测**（设计如此）——
     *    接线时**不许**为了"让它能跑"而放宽这一条（本单 §5bis ④）。
     * ```
     */
    resolveTurnScope?: (facts: unknown) => Promise<{ scope?: import('../../kernel/contracts/scope.ts').ScopeContext | undefined }>
    selectSession?: (facts: unknown, userText?: string) => Promise<BridgeSessionLike>
    /** 覆盖 `Date.now`（只给门用；缺省取真实时钟） */
    now?: () => number
  } = {}
): TurnBridgeHost {
  const registry = options.cancellation
  const delivery = options.delivery
  const now = options.now ?? Date.now
  const host: TurnBridgeHost = {
    characterId: session.characterId,
    conversationId: session.conversationId,
    async runTurn(input) {
      /*
       * ⚠️ **进模型之前**的取消检查点：这一轮如果真的被取消了，
       * 就在这里停住 —— 那是唯一"真的省下一次模型调用"的位置。
       */
      if (registry?.isCancelled(input.requestId) === true && registry.hasCommitted(input.requestId) === false) {
        throw new KernelError(
          'validation_error',
          'bridge_turn_cancelled_before_model',
          `轮次 ${input.requestId} 在模型调用之前被取消：不调用模型、不写账本`
        )
      }
      /*
       * Lv4.5 / `P1`：**新轮次顶掉上一轮**（计划 §1「旧任务不串话」）。
       *
       * ⚠️ 放在 `send()` **之前**：这一轮一旦开始装配，上一轮就不可能再播完了
       *    （同一会话里旧音频不得继续播放）。于是"上一轮里还没播完的片段"
       *    在这里得到**结局明确**的读数（`queued`⇒`cancelled` / `playing`⇒`unknown`），
       *    而不是永远停在半途、让 §2 `M11` 分不清"确定没播"与"不知道播没播"。
       * ⚠️ 它**不**撤销任何已提交的东西，也不动终态：只把悬着的交付态定案。
       */
      delivery?.markSuperseded({ at: now(), by: 'lg', reason: 'superseded_by_new_turn' })
      /*
       * ★ U1 / `WP2b-2b`：**本轮作用域**（`ADR-139` `D01`）。
       * ⚠️ 只在**这一轮带平台事实**且**装配层注入了能力**时解析；
       *   任何一处不满足 ⇒ `turnScope` 保持 `undefined` ⇒ `compileTurn` 不传 `scope`
       *   ⇒ 网关回落到 `TurnGatewayOptions.scope`（会话级）⇒ 逐字旧行为。
       * ⚠️ 解析失败**不抛**：那会把"这一轮身份不确定"变成"整轮失败"。
       *   正确语义是**不给每轮作用域**（失败关闭）——若授权器在，则表现为全拒且计数可观测。
       */
      let turnScope: import('../../kernel/contracts/scope.ts').ScopeContext | undefined
      const selectedSession = options.selectSession === undefined ? session : await options.selectSession(input.platformFacts, input.userText)
      if (input.platformFacts !== undefined && options.resolveTurnScope !== undefined) {
        const resolved = await options.resolveTurnScope(input.platformFacts)
        turnScope = resolved.scope
      }
      const segments: import('../../kernel/contracts/expressive-speech.ts').SpeechExpression['segments'] = []
      let replyText: string
      try {
        replyText = await selectedSession.send(input.userText, input.onSpeechSegment === undefined ? undefined : {
          onSpeechSegment: packet => {
            if (registry?.isCancelled(input.requestId)) return
            segments.push(packet.segment)
            delivery?.openReply({ replyId: packet.replyId, segments, at: now(), by: 'lg' })
            input.onSpeechSegment!(packet)
          },
          ...(registry !== undefined ? { signal: registry.signalFor(input.requestId),
            onModelStart: () => registry.markModelStarted(input.requestId) } : {}),
        }, input.images, turnScope, input.groupContext)
      } finally { registry?.release(input.requestId) }
      const identity = selectedSession.lastTurnIdentity()
      if (identity === undefined) {
        /*
         * 失败关闭：`send()` 返回了却没有身份记录 —— 那说明这一轮**没走**
         * 生产装配（或装配半途失败）。这时**绝不能**编一个 replyId 出去：
         * 外壳会拿它去对账，而它会指向一条不存在的事件。
         */
        throw new KernelError(
          'validation_error',
          'bridge_session_without_identity',
          'ChatSession.send() 返回了回复但没有登记本轮身份：这一轮没有走生产装配，拒绝编造 replyId'
        )
      }
      /* 过了提交点 ⇒ 此后取消不再声称能省下任何东西（如实） */
      registry?.markCommitted(input.requestId)
      /*
       * Lv4.5 / `P1`：这一轮**已过回复守卫**的分句进交付账（生成账）。
       *
       * ⚠️ 只在**有** `expression` sidecar 时开账：sidecar 缺席意味着
       *    "这一轮没有分句身份"，而交付账的每一段都必须能对账到
       *    `<replyId>#<index>`（契约 §2 `M5`）。没有身份的段开出来也只会在
       *    播放回报时被报 `unknown_segment` —— 那不是更保守，只是更吵。
       */
      if (delivery !== undefined && identity.expression !== undefined) {
        delivery.openReply({
          replyId: identity.replyId,
          segments: identity.expression.segments,
          at: now(),
          by: 'lg',
        })
      }
      return {
        replyText,
        ...(identity.streamStatus !== undefined ? { streamStatus: identity.streamStatus } : {}),
        replyId: identity.replyId,
        traceId: identity.traceId,
        domainEventIds: identity.domainEventIds,
        ...(identity.expression !== undefined ? { expression: identity.expression } : {}),
        /*
         * `P4` 后的时延修复：**生成段内部的阶段耗时**随结果回给外壳。
         * ⚠️ 不走日志：桥的 stdout 是 NDJSON 协议通道，外壳会丢弃非协议行
         *    （这一批实测过：`modelSeconds` 原本只 `logger.info` 到 stdout ⇒ 生产上读不到）。
         */
        ...(identity.timings !== undefined ? { timings: identity.timings } : {}),
      }
    },
  }
  if (registry !== undefined) {
    host.cancelTurn = async (input) => {
      registry.cancel(input.requestId)
      return cancelReadingOf({
        requestId: input.requestId,
        registry,
        beforeModel: options.isBeforeModel?.(input.requestId) ?? !registry.hasStartedModel(input.requestId),
      })
    }
  }
  if (delivery !== undefined) {
    host.reportSynthesized = (input) =>
      delivery.reportSynthesized({
        segmentId: input.segmentId,
        audioId: input.audioId,
        at: input.at ?? now(),
        by: 'tts',
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      })
    host.reportPlayback = (input) =>
      delivery.report({
        segmentId: input.segmentId,
        state: input.state,
        at: input.at ?? now(),
        by: 'client',
        ...(input.playedFrom !== undefined ? { playedFrom: input.playedFrom } : {}),
        ...(input.playedTo !== undefined ? { playedTo: input.playedTo } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      })
  }
  /*
   * Lv4.5 / `P2`：**只读准备**。
   *
   * ⚠️ 这一支**不接**取消登记表、**不接**交付账：准备既不是一轮对话，
   *    也不是"她说了什么"。它与 `runTurn` 唯一的共同点是**同一套**召回入口
   *    （`session.prepare` → `TurnGateway.prepareTurn` → 同一个 `recallForTurn`）。
   * ⚠️ 失败**不**吞：`session.prepare` 抛错会让桥回 `failed` + 具名码（失败关闭）。
   */
  if (typeof session.prepare === 'function') {
    const prepare = session.prepare.bind(session)
    host.prepareTurn = async (input) => await prepare(input.userText)
  }
  /*
   * Lv4.5 / `P3`（选项 B）：**边听边查**的两个出口。
   *
   * ⚠️ 两者都**只在注入时才存在**（失败关闭）：没有 `lookup` ⇒ 桥不会提前查；
   *    没有 `sheIsSpeaking` ⇒ 桥按"不知道"处理 ⇒ 不说那一句。
   *    这样"没接"与"接了但没查"在读数上分得开（前者是能力缺席，后者是判据不成立）。
   */
  if (options.lookup !== undefined) host.prepareLookup = options.lookup
  if (options.sheIsSpeaking !== undefined) host.sheIsSpeaking = options.sheIsSpeaking
  if (options.supersedeUnplayed !== undefined) host.supersedeUnplayed = options.supersedeUnplayed
  /*
   * Lv4.5 / ADR-131 `D01`：**主动开口的机会受理**。
   *
   * ⚠️ 与上面三条同一条纪律：**不传就没有这个能力** —— 桥会如实报
   *    `opening_capability_absent`，而不是"静默地什么都没发生"。
   *    这正是 WP5b 之前那段状态：链的两端都能用，但中间那根线没接。
   */
  if (options.openingOpportunity !== undefined) host.openingOpportunity = options.openingOpportunity
  return host
}

// ---------------------------------------------------------------------------
// NDJSON 传输
// ---------------------------------------------------------------------------

/** 传输层的最小注入面（让它在门里可以只用内存流跑，不必 spawn 子进程） */
export interface BridgeTransportStreams {
  /** 逐行读入（外壳 → 桥） */
  read: () => AsyncIterable<string>
  /** 逐行写出（桥 → 外壳） */
  write: (line: string) => void
  /** 收尾（可选）：用于把挂起的写入冲出去 */
  flush?: () => Promise<void> | void
}

export interface BridgeTransportReading {
  /** 收到几行 */
  linesIn: number
  /** 其中解析成功的几条 */
  parsed: number
  /** 解析失败（不是合法 JSON 对象）——**单独计数**，不并进"拒绝"里 */
  malformed: number
  /** 写回去几行 */
  linesOut: number
  /**
   * Lv4.5 / P1：**控制消息**里同时最多有几条在途（`CANCEL_TURN` / `REPORT_PLAYBACK`）。
   *
   * 它是"控制消息与耗时 `send()` 已经解耦"的**机器读数**：
   * 串行实现下这个数永远是 0（控制消息只在上一轮结束后才被读到）。
   */
  controlPeakInFlight: number
  /** 控制消息写回去的时刻与读入时刻的差（毫秒）——**读数**，不是判据 */
  controlLatencyMs: number[]
}

/**
 * 跑一条 NDJSON 传输直到输入结束。
 *
 * ============================================================================
 *  Lv4.5 / `P1`：**控制消息与耗时轮次解耦**
 * ============================================================================
 * 旧实现是"读一行 → await 处理完 → 写回一行"的**单循环**。后果是实打实的：
 * 一轮慢请求（模型等待 5–20 秒）期间，外壳随后发来的 `CANCEL_TURN` 一直躺在
 * stdin 缓冲区里**直到那一轮结束才被读到** —— 于是"用户抢话要立刻停"
 * 在**传输层**就不可能成立（`L-PL2-04` 的取消只是账上记下了意图）。
 *
 * 现在的分工：
 * ```text
 * 控制消息（CANCEL_TURN / REPORT_PLAYBACK …）
 *   ⇒ 读到**立即**处理，与在途轮次**并行**（它们不写库、不调模型，只更新进程内登记）
 * 正式轮次（SUBMIT_TURN）
 *   ⇒ 仍走**独立的串行泵**：同一时刻只有一条被提交
 *      （双保险：`TurnBridge` 自己还有一道串行闸；`D12` 的"正式写入串行"不变）
 * ```
 *
 * ⚠️ 判据不在传输层新增：哪些 `kind` 是控制消息，答案**只有一处**
 * （`kernel/app/bridge` 的 {@link isBridgeControlMessageKind}）。
 * 传输层**不做**语义判断，它只是按那一处给出的分类决定"排队还是立即"。
 *
 * ⚠️ 解析失败**不抛**：外壳发来一行坏 JSON 时，正确反应是回一条具名拒绝，
 * 而不是把整个语音会话打断。
 */
export async function runBridgeTransport(
  bridge: TurnBridge,
  streams: BridgeTransportStreams
): Promise<BridgeTransportReading> {
  const reading: BridgeTransportReading = {
    linesIn: 0,
    parsed: 0,
    malformed: 0,
    linesOut: 0,
    controlPeakInFlight: 0,
    controlLatencyMs: [],
  }
  const controlInFlight = new Set<Promise<void>>()
  // Read-only model decisions have their own single slot: never queue QQ turns or controls behind them.
  let assessment: Promise<void> | undefined
  let submits: Promise<void> = Promise.resolve()

  const write = (response: BridgeWireResponse): void => {
    streams.write(JSON.stringify(response))
    reading.linesOut += 1
  }
  /*
   * Lv4.5 / `P3`：把**出站**通道装上（有来源的角色输出）。
   *
   * ⚠️ 为什么装在这里：桥自己**不知道** stdout 与 NDJSON 的格式 —— 那是传输层的事。
   *    装上之后 `TurnBridge.emitCharacterOutput` 才有可能真的写出**一行**；
   *    不装时它如实报 `output_channel_absent`（**不**假装说过）。
   */
  bridge.setOutputSink(write)

  const dispatch = (parsed: unknown): void => {
    if ((parsed as { kind?: unknown })?.kind === 'ASSESS_GROUP_REPLY') {
      if (assessment) {
        write({ kind: 'GROUP_REPLY_DECISION', requestId: String((parsed as { requestId?: unknown }).requestId ?? ''),
          outcome: 'rejected', code: 'group_reply_busy' })
      } else {
        assessment = handleBridgeMessage(bridge, parsed).then(write).finally(() => { assessment = undefined })
      }
      return
    }
    if (isBridgeControlMessageKind((parsed as { kind?: unknown })?.kind)) {
      const startedAt = Date.now()
      const task = (async () => {
        write(await handleBridgeMessage(bridge, parsed))
        reading.controlLatencyMs.push(Date.now() - startedAt)
      })().catch(() => undefined).finally(() => {
        controlInFlight.delete(task)
      })
      controlInFlight.add(task)
      if (controlInFlight.size > reading.controlPeakInFlight) {
        reading.controlPeakInFlight = controlInFlight.size
      }
      return
    }
    /*
     * 正式轮次：挂在**独立**的串行泵上。
     * ⚠️ 泵里接的是"上一条结束后"而不是"立刻"：`SUBMIT_TURN` 不该在传输层堆积成
     *    无限并发（桥自己也串行，这里只是让顺序可预测）。
     */
    submits = submits.then(async () => {
      write(await handleBridgeMessage(bridge, parsed))
    })
  }

  for await (const line of streams.read()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    reading.linesIn += 1

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      reading.malformed += 1
      write({
        kind: 'TURN_RESULT',
        requestId: '',
        outcome: 'rejected',
        code: 'bridge_malformed_json',
        delivery: 'rejected',
      })
      continue
    }
    reading.parsed += 1
    dispatch(parsed)
  }
  /*
   * ⚠️ 收尾顺序是有讲究的：先等正式轮次（它们的响应是外壳真正在等的），
   * 再等控制消息的响应。两者都等完才 flush，否则脚本可能在最后一行响应
   * 写出之前就 EOF 收工。
   */
  await submits
  await assessment
  await Promise.all([...controlInFlight])
  await streams.flush?.()
  return reading
}

/** 供门与诊断使用：受控消息种类登记表（**唯一**的答案） */
export const BRIDGE_TRANSPORT_MESSAGE_KINDS: readonly string[] = [...BRIDGE_MESSAGE_KINDS]
