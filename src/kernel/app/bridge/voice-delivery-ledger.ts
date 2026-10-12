/**
 * Lv4.5 / `P1` —— **语音交付账**（进程内；装配层持有，桥只转发回报）。
 *
 * ============================================================================
 *  载体：媒体交付契约 §1（三本账不得互相代替）· 计划 §2 `P1`（播放回报）
 * ============================================================================
 * 它回答的问题只有一个：
 *
 * ```text
 *   "她已经**说出去**了哪几句？"（按客户端**实际汇报的播放事实**）
 * ```
 * 它**不**回答（这些问题是别的东西的职责）：
 *
 * ```text
 *   "她生成过什么"   ⇒ conversation_events（生成的完整记录，一段都不删）
 *   "她合成过什么"   ⇒ TTS 侧读数（audioId + 合成时刻）
 *   "用户听懂了吗"   ⇒ 没有任何账能回答，词汇里也不存在这种状态（契约 §1 第四条）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  四条不可越过的边界
 * ---------------------------------------------------------------------------
 * ```text
 * ① 这是**进程内**的账：不写数据库、不新增 schema、不进 trace 正文。
 *    重启 ⇒ 归零 ⇒ 未播句按"未播出"处理（保守面；契约 §3 的"重连不自动重播"）。
 * ② 状态推进**只有一处**：`media-delivery.ts` 的 `advanceSegment` 与它的迁移表。
 *    本模块**不**自己写迁移表 —— "生成 ⇒ 已播出"在这条路径上不可能发生。
 * ③ 回报是**幂等**的：同一段重复报 `played`、或者迟到的旧回报，一律**安静忽略**
 *    （`accepted: false` + 具名码），**不抛**、**不回退**已确立的交付事实。
 *    重复包/乱序包是网络常态，把常态当失败会让"交付事实"比噪音还不稳。
 * ④ 中间跳**由迁移表推导**（`pathBetween` 的 BFS），不手写一张"捷径表"——
 *    手写的那张一定会和迁移表漂移，而漂移的方向恰好是放宽禁令。
 * ```
 */

import { KernelError } from '../../contracts/ids.ts'
import {
  advanceSegment,
  emptyDeliveryLedger,
  openSegment,
  playedPartition,
  transitionAllowed,
  type DeliveryLedger,
  type SegmentState,
} from '../../contracts/media-delivery.ts'
import {
  BRIDGE_PLAYBACK_STATES,
  type BridgePlaybackReportResult,
  type BridgePlaybackState,
  type BridgeSynthesisReportResult,
  type VoiceDeliveryPort,
  type VoiceDeliveryReading,
} from './turn-bridge.ts'

function isReportableState(value: unknown): value is BridgePlaybackState {
  return typeof value === 'string' && (BRIDGE_PLAYBACK_STATES as readonly string[]).includes(value)
}

/**
 * 交付态的**先后**（只用于识别"迟到的旧回报"）。
 *
 * ⚠️ 它不是迁移表：它只说"哪一档更晚"，**能走哪条路**永远由 `advanceSegment` 说了算。
 * `unknown` 与 `playing` 同档是刻意的：它们都是"发出去了但结局还不知道"。
 */
const STATE_RANK: Readonly<Record<SegmentState, number>> = {
  generated: 0,
  synthesized: 1,
  queued: 2,
  playing: 3,
  unknown: 3,
  played: 4,
  cancelled: 4,
}

/**
 * 从 `from` 走到 `to` 需要依次经过的跳（**由迁移表 BFS 推导**，最短路径）。
 *
 * 返回 `undefined` = 迁移表里根本没有这条路 ⇒ 这条回报**不允许**被补跳。
 * 返回 `[]` = 已经在那儿了。
 */
export function pathBetween(from: SegmentState, to: SegmentState): readonly SegmentState[] | undefined {
  if (from === to) return []
  const queue: SegmentState[][] = [[from]]
  const seen = new Set<SegmentState>([from])
  while (queue.length > 0) {
    const path = queue.shift()!
    const last = path[path.length - 1]!
    for (const next of ALL_STATES) {
      if (seen.has(next) || !transitionAllowed(last, next)) continue
      if (next === to) return [...path.slice(1), next]
      seen.add(next)
      queue.push([...path, next])
    }
  }
  return undefined
}

const ALL_STATES: readonly SegmentState[] = [
  'generated',
  'synthesized',
  'queued',
  'playing',
  'played',
  'cancelled',
  'unknown',
]

export interface VoiceDeliveryLedgerOptions {
  /** 诊断上限：账里最多留多少段（超出按最早淘汰；**淘汰的段按未播出处理**） */
  maxSegments?: number
  now?: () => number
}

/**
 * 进程内交付账。
 *
 * ⚠️ `openReply` 只接受**已过回复守卫**的分段（`SpeechExpression.segments`）：
 *    调用点必须是 `completeTurn` 之后那一段。这是契约 §2 `M6` 的一半
 *    （"先检查后合成"），另一半由 `openSegment` 自己拒绝空文本。
 */
export class VoiceDeliveryLedger implements VoiceDeliveryPort {
  private ledger: DeliveryLedger = emptyDeliveryLedger()
  /** 事件序号（`cev:…:<sequence>` 的那一段）→ `replyId`；用于把对话行对到交付账上 */
  private readonly sequences = new Map<number, string>()
  private readonly maxSegments: number
  private readonly now: () => number

  constructor(options: VoiceDeliveryLedgerOptions = {}) {
    this.maxSegments = options.maxSegments ?? 256
    this.now = options.now ?? Date.now
  }

  /**
   * LG 生成了一段已检查的回复 ⇒ 为它的**每一个**分句开一条生成账。
   *
   * ⚠️ 幂等：同一个 `replyId` 重复开账时**不**写第二遍（重连重发是常态）。
   */
  openReply(input: {
    replyId: string
    segments: readonly { segmentId: string; text: string }[]
    at?: number
    by?: string
  }): void {
    if (input.replyId.trim() === '') {
      throw new KernelError('validation_error', 'voice_delivery_without_reply_id', '交付账必须挂在 LG 的 replyId 上')
    }
    const at = input.at ?? this.now()
    const by = input.by ?? 'lg'
    for (const [index, segment] of input.segments.entries()) {
      if (this.ledger.segments.some((item) => item.segmentId === segment.segmentId)) continue
      const opened = openSegment({
        replyId: input.replyId,
        index,
        checkedReplyText: segment.text,
        at,
        by,
      })
      this.ledger = { segments: [...this.ledger.segments, opened] }
    }
    /*
     * ⚠️ 序号从 **replyId 自己**读出来（`cev:<character>:<conversation>:<sequence>`），
     *    而不是从「正文相等」去猜：对账键必须是身份，不是内容。
     *    解析不出来就不登记 —— 那条回复在交付视图里按"未接入交付账"处理（保持原样）。
     */
    const sequence = sequenceOfReplyId(input.replyId)
    if (sequence !== undefined) this.sequences.set(sequence, input.replyId)
    this.evict()
  }

  /**
   * 应用一条**客户端**播放回报。
   *
   * 结局只有两种：**推进了**（`accepted: true`）或**安静忽略**（`accepted: false` + 具名码）。
   * 忽略的都是**常态**，不是故障：
   * ```text
   * playback_report_without_segment     回报缺 segmentId（形状非法）
   * playback_report_unknown_state       报了一个客户端不该报的状态
   * playback_report_unknown_segment     账上没有这一段（例如进程重启过）
   * playback_report_before_synthesis    账上还没有"这一段被合成过"的事实
   *                                     ⇒ 播放报告**不能**充当合成完成的证据
   * playback_report_stale_or_duplicate  重复 / 迟到 / 与已确立事实冲突
   * ```
   */
  report(input: {
    segmentId: string
    state: unknown
    at?: number
    by?: string
    playedFrom?: number
    playedTo?: number
    reason?: string
  }): BridgePlaybackReportResult {
    const segmentId = typeof input.segmentId === 'string' ? input.segmentId.trim() : ''
    if (segmentId === '') return { accepted: false, code: 'playback_report_without_segment' }
    if (!isReportableState(input.state)) return { accepted: false, code: 'playback_report_unknown_state' }
    const current = this.ledger.segments.find((segment) => segment.segmentId === segmentId)
    if (current === undefined) return { accepted: false, code: 'playback_report_unknown_segment' }
    /*
     * ⚠️ 这一条是**本模块**的判据，而且是必须的：
     *
     * 通用迁移表是"乐观"的（`generated → synthesized` 是一条合法边，因为 LG 侧
     * 确实可以这么写账）。如果交付账也照它走，BFS 会给出
     * `generated → synthesized → queued` 这条**存在**的路径 ——
     * 于是"客户端报了一句播放"就顺手把"这一段被合成过"也写进了账。
     * 那正是契约 §1 的第一条禁令换了个方向（**合成完成 ≠ 已播出**的反面：
     * 播放报告 **不能** 充当合成完成的证据）。
     *
     * 所以交付侧的回报要求账上**已经**有合成事实（或更晚）才受理。
     */
    if (STATE_RANK[current.state] < STATE_RANK.synthesized) {
      return { accepted: false, code: 'playback_report_before_synthesis', state: current.state }
    }
    /*
     * ⚠️ 推进的**唯一**判据是：目标态严格更晚（`STATE_RANK`），**而且**迁移表里有路。
     * 于是三种常态被安静吸收：重复（同档）、迟到（更早）、与终态冲突。
     * 迁移判断本身**不**在这里重写一遍（`advanceSegment` 才是唯一一处）。
     */
    if (STATE_RANK[input.state] <= STATE_RANK[current.state]) {
      return { accepted: false, code: 'playback_report_stale_or_duplicate', state: current.state }
    }
    const path = pathBetween(current.state, input.state)
    if (path === undefined) {
      return { accepted: false, code: 'playback_report_stale_or_duplicate', state: current.state }
    }
    const at = input.at ?? this.now()
    const by = input.by ?? 'client'
    try {
      for (const [hopIndex, hop] of path.entries()) {
        const isFinalHop = hopIndex === path.length - 1
        this.ledger = advanceSegment(this.ledger, {
          segmentId,
          to: hop,
          at,
          by,
          /*
           * 播放区间与理由**只**落在**最后一跳**上：它们描述的是"这次播放"，
           * 不是"它被排过队"。缺失就是缺失 —— 不填 0、不填 now。
           */
          ...(isFinalHop && input.playedFrom !== undefined ? { playedFrom: input.playedFrom } : {}),
          ...(isFinalHop && input.playedTo !== undefined ? { playedTo: input.playedTo } : {}),
          ...(isFinalHop && input.reason !== undefined ? { reason: input.reason } : {}),
        })
      }
      return { accepted: true, state: input.state }
    } catch (error) {
      /* 迁移表拒绝 ⇒ 这是"迟到/冲突"，不是故障：安静忽略，并如实报账上仍是什么 */
      const code = error instanceof KernelError ? error.code : 'playback_report_rejected'
      return { accepted: false, code, state: current.state }
    }
  }

  /**
   * 应用一条**合成完成**回报（TTS / 外壳侧）。
   *
   * ⚠️ `audioId` **必需**：迁移表自己会拒绝没有音频标识的"合成完成"
   *    （`synthesis_without_audio_id`）。本方法**不**替它编一个 id。
   */
  reportSynthesized(input: {
    segmentId: string
    audioId: string
    at?: number
    by?: string
    reason?: string
  }): BridgeSynthesisReportResult {
    const segmentId = typeof input.segmentId === 'string' ? input.segmentId.trim() : ''
    if (segmentId === '') return { accepted: false, code: 'synthesis_report_without_segment' }
    if (typeof input.audioId !== 'string' || input.audioId.trim() === '') {
      return { accepted: false, code: 'synthesis_report_without_audio_id' }
    }
    const current = this.ledger.segments.find((segment) => segment.segmentId === segmentId)
    if (current === undefined) return { accepted: false, code: 'synthesis_report_unknown_segment' }
    /* 重复报"合成完成"是常态（分块流式合成会对同一段报多次）⇒ 幂等吸收 */
    if (current.state !== 'generated') {
      return { accepted: false, code: 'synthesis_report_stale_or_duplicate', state: current.state }
    }
    try {
      this.ledger = advanceSegment(this.ledger, {
        segmentId,
        to: 'synthesized',
        at: input.at ?? this.now(),
        by: input.by ?? 'tts',
        audioId: input.audioId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      })
      return { accepted: true, state: 'synthesized' }
    } catch (error) {
      const code = error instanceof KernelError ? error.code : 'synthesis_report_rejected'
      return { accepted: false, code, state: current.state }
    }
  }

  /**
   * **被顶掉**：同一个话题里又来了新一轮 ⇒ 旧回复里还没播完的片段结局明确为"没播完"。
   *
   * ============================================================================
   *  为什么需要它（Lv4.5 / P1 · 计划 §1「旧任务不串话」与「边听边查/改口撤回」）
   * ============================================================================
   * 客户端不一定来得及为**每一个**片段都发一条 `cancelled`（浏览器被顶掉、页面切走、
   * 回报被丢），于是账上会留下"永远停在 `queued`/`playing`/`synthesized`"的片段。
   * 那些片段在交付视图里是"未播出"，方向是对的；但**账本身**会说不清"它到底怎么了"，
   * 而 §2 `M11` 要求区分"确定没播"与"不知道播没播"。
   *
   * 因此这一条把"**有新轮次顶掉它**"当成**证据**：那一轮已经没有播出的机会了
   * （计划 §1「旧任务不串话」：旧音频不能继续播放），所以
   * `queued`（还没开播）⇒ `cancelled`（确定没播），`playing` / `synthesized` ⇒ `unknown`
   * （**已经发出去了**，我们不知道声卡那一刻播到哪 ⇒ 不许说成"确定没播"）。
   *
   * ⚠️ 终态（`played` / `cancelled` / `unknown`）**一个字都不动**：它们已经定案。
   */
  markSuperseded(input: { at?: number; by?: string; reason?: string } = {}): readonly string[] {
    const at = input.at ?? this.now()
    const by = input.by ?? 'lg'
    const reason = input.reason ?? 'superseded_by_new_turn'
    const touched: string[] = []
    for (const segment of [...this.ledger.segments]) {
      if (segment.state === 'played' || segment.state === 'cancelled' || segment.state === 'unknown') continue
      /*
       * ======================================================================
       *  目标状态**按当前状态分别取**（这是一处实测出来的缺陷）
       * ======================================================================
       * 第一版写的是"`queued` ⇒ `cancelled`，**其它一律** ⇒ `unknown`"，
       * 而迁移表里 `synthesized → unknown` **根本不允许** ⇒ `advanceSegment` 抛错
       * ⇒ 被下面那个 `catch` 静默吞掉 ⇒ 函数报"什么都没作废"，
       * **而当时确实有未播余句**（真链路读数：`correction_last_superseded = 0`，
       * 可她正在说、纠正段也确实播出去了）。**"做不到"被伪装成了"没得做"。**
       *
       * 现在按状态取，每个未终态都有**合法且诚实**的目标：
       * ```text
       * generated   ⇒ cancelled  还没合成 ⇒ 确定不会播
       * synthesized ⇒ cancelled  还没被客户端排上 ⇒ 确定不会播
       * queued      ⇒ cancelled  排上了但还没开播 ⇒ 确定不会播
       * playing     ⇒ unknown    **已经在播** ⇒ 不知道声卡播到哪（不许说成"确定没播"）
       * ```
       * ⇒ 只有 `playing` 才是"不知道"；其余都是"确定不会播"。
       */
      const target: SegmentState = segment.state === 'playing' ? 'unknown' : 'cancelled'
      try {
        this.ledger = advanceSegment(this.ledger, { segmentId: segment.segmentId, to: target, at, by, reason })
        touched.push(`${segment.segmentId}:${target}`)
      } catch {
        /*
         * ⚠️ 走到这里说明**迁移表与上面那套映射不一致** —— 那不是"没得做"，
         *    而是"想作废却作废不了"。按纪律不许静默：记下来，让读数能反证。
         */
        this.supersedeFailuresInternal.push(segment.segmentId)
      }
    }
    return touched
  }

  /**
   * **想作废却作废不了**的片段（诊断读数；空 = 上面那套映射与迁移表一致）。
   *
   * ⚠️ 它存在的理由就是上面那次缺陷：`catch` 静默吞掉非法迁移，会让
   *    "0 段被作废"**同时**表示"没有余句"与"有余句但我没做成" —— 那是两件事。
   */
  get supersedeFailures(): readonly string[] {
    return this.supersedeFailuresInternal
  }
  private supersedeFailuresInternal: string[] = []

  // -------------------------------------------------------------------------
  // 只读视图
  // -------------------------------------------------------------------------

  get segmentCount(): number {
    return this.ledger.segments.length
  }

  /** 账上所有片段的**状态**（诊断/门用；**不含**正文） */
  get states(): Readonly<Record<string, SegmentState>> {
    return Object.fromEntries(this.ledger.segments.map((segment) => [segment.segmentId, segment.state]))
  }

  fullyPlayed(replyId: string): boolean {
    const segments = this.segmentsOf(replyId)
    return segments.length > 0 && segments.every((segment) => segment.state === 'played')
  }

  /**
   * Lv4.5 / `P3`（选项 B）：她**此刻的语音是不是还在飞**（有一个片段还没播完）。
   *
   * ============================================================================
   *  为什么取这三个状态
   * ============================================================================
   * ```text
   * synthesized —— 音频已经有了、还没排上（"即将出声"）
   * queued      —— 已排上 Web Audio 时钟
   * playing     —— 正在出声
   * ```
   * 三者都是"她这一段话还没说完" ⇒ 这时插一句"查到了"才有价值（用户不必等她说完整段）。
   * ⚠️ `cancelled` / `unknown` / `played` **不算**：那一段已经**有结局**了。
   *    把"已作废"算成"正在说"会让提醒在**她永远不会有下文**的时候插进去。
   */
  hasUnplayed(): boolean {
    return this.ledger.segments.some(
      (segment) => segment.state === 'synthesized' || segment.state === 'queued' || segment.state === 'playing'
    )
  }

  unplayedIndexes(replyId: string): readonly number[] {
    return this.segmentsOf(replyId)
      .filter((segment) => segment.state !== 'played')
      .map((segment) => segment.index)
  }

  /**
   * 一个 `replyId` 里**已播出**的正文（按片段编号拼回）。
   *
   * ⚠️ 未播出 / 结局不明的片段**不在**这里：`unknown` 算未播出（契约 §2 `M11`）。
   */
  playedText(replyId: string): string {
    return playedPartition({ segments: this.segmentsOf(replyId) }).playedText
  }

  get playedTextByReplyId(): Readonly<Record<string, string>> {
    const ids = new Set(this.ledger.segments.map((segment) => String(segment.replyId)))
    return Object.fromEntries([...ids].map((replyId) => [replyId, this.playedText(replyId)]))
  }

  /** 交付账里**有据可查**的 `replyId`（视图只处理这些；其它一律原样通过） */
  get knownReplyIds(): readonly string[] {
    return [...new Set(this.ledger.segments.map((segment) => String(segment.replyId)))]
  }

  /**
   * 这一句是不是交付账里**已经**说出去的部分。
   *
   * ⚠️ 判据打在**已播出正文**上：一句在账上但**没播**（或结局不明）的句子
   * 在这里是 `false` —— 契约 §2 `M11` 要求的正是这一点。
   */
  hasSpoken(replyId: string, text: string): boolean {
    const spoken = this.playedText(replyId)
    return spoken !== '' && spoken.includes(text)
  }

  /** 事件序号 → `replyId`（装配层用它把"最近对话"里的助手行对到账上） */
  replyIdForSequence(sequence: number): string | undefined {
    return this.sequences.get(sequence)
  }

  reading(): VoiceDeliveryReading & { states: Readonly<Record<string, SegmentState>> } {
    return {
      segmentCount: this.segmentCount,
      playedTextByReplyId: this.playedTextByReplyId,
      fullyPlayed: (replyId: string) => this.fullyPlayed(replyId),
      unplayedIndexes: (replyId: string) => this.unplayedIndexes(replyId),
      states: this.states,
    }
  }

  /** 原始账（只给门与诊断；调用方**不得**改它） */
  snapshot(): DeliveryLedger {
    return this.ledger
  }

  private segmentsOf(replyId: string) {
    return this.ledger.segments
      .filter((segment) => String(segment.replyId) === replyId)
      .sort((a, b) => a.index - b.index)
  }

  private evict(): void {
    while (this.ledger.segments.length > this.maxSegments) {
      this.ledger = { segments: this.ledger.segments.slice(1) }
    }
  }
}

/**
 * 从 `replyId` 读出事件序号。
 *
 * ⚠️ 这里刻意**不**用 `sequenceFromEventId`（那在 `job.ts` 里，依赖更重）：
 *    本模块只需要"能不能读出一个整数序号"，读不出就是 `undefined`。
 *    `ConversationEventId` 的形状是 `cev:<characterId>:<conversationId>:<sequence>`
 *    （品牌化 id 里 character/conversation 自己含冒号，所以只锚**最后一个**字段）。
 */
export function sequenceOfReplyId(replyId: string): number | undefined {
  const separator = replyId.lastIndexOf(':')
  if (separator <= 0 || !replyId.startsWith('cev')) return undefined
  const value = Number(replyId.slice(separator + 1))
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * 交付视图：**把"她生成过什么"换成"她说过什么"**（Lv4.5 / `P1`；契约 §2 `M11`）。
 *
 * ```text
 * 用户行 / 系统行          ⇒ 原样通过（这条规则不认识它们，也就不碰它们）
 * 助手行，交付账里没有这段  ⇒ 原样通过（例如 CLI 会话：没有交付账，行为逐字不变）
 * 助手行，整段都播完了      ⇒ 原样通过（说过了，就是全文）
 * 助手行，只播了一部分      ⇒ **只保留播出的部分**（未播的句子不得被表述为"我说过了"）
 * 助手行，一句都没播完      ⇒ **整行撤掉**（它没有发生）
 * ```
 *
 * ⚠️ 三个"不"：
 *   · 不删生成记录（`conversation_events` 一个字都不动，删的只是**视图**里的一行）；
 *   · 不猜（账上没有的回复一律原样通过，**不**因为"没见过"就把她的话抹掉）；
 *   · 不改写（留下的部分**逐字**来自账上已播出的正文，不拼接、不摘要）。
 */
export function applyVoiceDeliveryView<
  T extends { sequence: number; text: string; speaker: string; actorType?: string }
>(
  lines: readonly T[],
  reading: {
    knownReplyIds: readonly string[]
    replyIdForSequence(sequence: number): string | undefined
    fullyPlayed(replyId: string): boolean
    playedText(replyId: string): string
  },
  options: { characterName: string }
): T[] {
  const known = new Set(reading.knownReplyIds)
  const view: T[] = []
  for (const line of lines) {
    const isAssistant =
      line.actorType === 'character' || (line.actorType === undefined && line.speaker === options.characterName)
    if (!isAssistant) {
      view.push(line)
      continue
    }
    const replyId = reading.replyIdForSequence(line.sequence)
    if (replyId === undefined || !known.has(replyId)) {
      view.push(line)
      continue
    }
    if (reading.fullyPlayed(replyId)) {
      view.push(line)
      continue
    }
    const spoken = reading.playedText(replyId)
    if (spoken === '') continue
    /*
     * ⚠️ 只有"这一行确实属于这段回复"时才改写：正文对不上（例如同一序号被别的东西
     *    占用）说明我对错了账，那就**保守地原样通过**，而不是拿另一段的话替换她。
     */
    if (!line.text.includes(spoken) && !spoken.includes(line.text)) {
      view.push(line)
      continue
    }
    view.push({ ...line, text: spoken })
  }
  return view
}
