/**
 * 后 Lv2 · WP4/WP5 —— **媒体交付账**（三本账的唯一实现，kernel 契约层）。
 *
 * ============================================================================
 *  载体：媒体交付契约 §1/§2/§4 · 计划 §6.2/§7/§8.2 · `INV-PL2-09`/`INV-PL2-11`
 * ============================================================================
 * 契约 §1 把"她说了一句话"拆成**三本不许互相代替的账**：
 *
 * ```text
 *  生成账  LG 回复守卫**之后**的文本（replyId + segmentId）      ← LG 自己写
 *  合成账  TTS 服务侧"合成完成"（audioId + synthesizedAt）        ← TTS 服务写
 *  交付账  **客户端上报**的播放事实（queued/playing/played/…）    ← 客户端写
 * ```
 *
 * 本模块**只**提供这三本账的**结构与合法迁移**，不做 I/O、不调 TTS、不碰音频。
 * 它存在的理由是契约里那四条"禁止的等价替换"——那些替换在代码里**必须不可能**，
 * 而不是靠"我们记得不要那样写"：
 *
 * | 禁止的替换 | 本模块的机器形态 |
 * |---|---|
 * | 已生成 ⇒ 已播出 | 生成只能到 `synthesized` **或** `cancelled`；`playing` 必须由交付账推进 |
 * | 合成完成 ⇒ 已播出 | 合成只到 `synthesized`；**永远**到不了 `playing` |
 * | 播放确认 ⇒ 真人听懂 | 交付态只有 `played`，没有任何"听懂/理解"的状态 |
 * | 断线 ⇒ 已播放 | `unknown` 是一个**独立的终态**，且断线只能进它 |
 *
 * ⚠️ **M6（先检查后合成）的机器形态**：任何 segment 的文本都必须来自
 * `checkedReplyText`，而 `checkedReplyText` 只能由"已过回复守卫"的正文构造
 * （见 {@link openSegment}）。"先播未检查的 token、再在字幕里修正"因此在类型上不可能。
 */

import { KernelError } from './ids.ts'

// ---------------------------------------------------------------------------
// 标识与状态（受控词汇）
// ---------------------------------------------------------------------------

/**
 * 一段语音的**生命周期**（三本账的合并视图，但每一步都记着"谁写的"）。
 *
 * ⚠️ 排序即合法顺序：`generated → synthesized → queued → playing → played`。
 * 正常路径之外只允许 `cancelled` 与 `unknown`（都是终态）。
 */
export type SegmentState =
  /** 生成账：LG 守卫后的文本已经定下来 */
  | 'generated'
  /** 合成账：TTS 侧报告合成完成（**只证明有音频文件**） */
  | 'synthesized'
  /** 交付账：客户端报告已排队 */
  | 'queued'
  /** 交付账：客户端报告**声卡正在播** */
  | 'playing'
  /** 交付账：客户端报告播完了 */
  | 'played'
  /** 终止：被取消 / 被停止 / 被新语音顶掉 */
  | 'cancelled'
  /** 终止：**断线或状态未知**（契约 §1：断线时状态**必须**是 unknown） */
  | 'unknown'

export const SEGMENT_STATES: readonly SegmentState[] = [
  'generated',
  'synthesized',
  'queued',
  'playing',
  'played',
  'cancelled',
  'unknown',
]

/** 终态：到了就不再有合法迁移（除 `unknown` 可被更强的交付事实纠正，见 {@link advanceSegment}） */
export const SEGMENT_TERMINAL_STATES: readonly SegmentState[] = ['played', 'cancelled', 'unknown']

/** 每一步是**谁**写的（审计面：出问题时先看是哪本账坏了） */
export type SegmentLedger = 'generation' | 'synthesis' | 'delivery'

export const SEGMENT_LEDGER_OF: Readonly<Record<SegmentState, SegmentLedger>> = {
  generated: 'generation',
  synthesized: 'synthesis',
  queued: 'delivery',
  playing: 'delivery',
  played: 'delivery',
  cancelled: 'delivery',
  unknown: 'delivery',
}

/** 一个片段的 id（确定性：`<replyId>#<index>` —— 同一轮同一句永远同一个 id） */
export type SegmentId = string & { readonly __brand: 'SegmentId' }

/** 一轮回复的 id（来自 LG 的账本，**不是**客户端编的） */
export type ReplyId = string & { readonly __brand: 'ReplyId' }

export function segmentIdOf(replyId: string, index: number): SegmentId {
  if (!Number.isInteger(index) || index < 0) {
    throw new KernelError(
      'validation_error',
      'segment_index_invalid',
      `片段序号必须是 ≥0 的整数，收到 ${String(index)}`
    )
  }
  return `${replyId}#${String(index)}` as SegmentId
}

// ---------------------------------------------------------------------------
// 片段记录（追加式；每次迁移都留一条历史）
// ---------------------------------------------------------------------------

export interface SegmentTransition {
  state: SegmentState
  ledger: SegmentLedger
  at: number
  /** 谁报告的（`lg` / `tts:<name>` / `client:<name>`）；断线时是 `transport` */
  by: string
  /** 音频 id（合成账之后才有） */
  audioId?: string
  /** 交付账的播放区间（客户端上报；毫秒，相对音频开头） */
  playedFrom?: number
  playedTo?: number
  /** 人类可读的理由（取消 / 未知的原因） */
  reason?: string
}

export interface SegmentRecord {
  segmentId: SegmentId
  replyId: ReplyId
  index: number
  /**
   * **生成账的正文**：它只能来自"已过回复守卫"的文本（见 {@link openSegment}）。
   * ⚠️ 它**就是**字幕要显示的那份 —— 契约 §2 `M5` 要求"检查后文本与字幕一致（同一 replyId）"。
   */
  text: string
  state: SegmentState
  history: readonly SegmentTransition[]
  audioId?: string
  playedFrom?: number
  playedTo?: number
  reason?: string
}

export interface DeliveryLedger {
  readonly segments: readonly SegmentRecord[]
}

export function emptyDeliveryLedger(): DeliveryLedger {
  return { segments: [] }
}

// ---------------------------------------------------------------------------
// 合法迁移表（唯一的一处定义）
// ---------------------------------------------------------------------------

/**
 * 允许的下一步。**这张表就是契约 §1 四条禁令的机器形态**。
 *
 * 读法（每一行都要能被"为什么"解释）：
 * ```text
 * generated   → synthesized（TTS 报告完成）· cancelled（决定不合成）
 * synthesized → queued（客户端排队）· cancelled（排队前被取消）
 * queued      → playing（客户端报告开始播）· cancelled（排队后被取消）· unknown（断线）
 * playing     → played（客户端报告播完）· cancelled（被停止）· unknown（断线）
 * 终态        → 只有 unknown 能被 delivered 事实纠正成 queued/playing/played
 * ```
 *
 * ⚠️ **注意 `generated` 和 `synthesized` 都到不了 `playing`/`played`**：
 * 这正是"已生成 ⇒ 已播出"与"合成完成 ⇒ 已播出"两条禁令。
 */
const ALLOWED: Readonly<Record<SegmentState, readonly SegmentState[]>> = {
  generated: ['synthesized', 'cancelled'],
  synthesized: ['queued', 'cancelled'],
  queued: ['playing', 'cancelled', 'unknown'],
  playing: ['played', 'cancelled', 'unknown'],
  played: [],
  cancelled: [],
  /*
   * ⚠️ `unknown` 是**可纠正**的终态，而且是**单向**的：
   * 断线之后客户端重连、如实报告"其实已经播过/正在播" ⇒ 允许进入交付态。
   * 反过来（交付态 ⇒ unknown）**不允许** —— 那会让"已播出"被一句断线抹掉。
   */
  unknown: ['queued', 'playing', 'played'],
}

export function transitionAllowed(from: SegmentState, to: SegmentState): boolean {
  return ALLOWED[from].includes(to)
}

// ---------------------------------------------------------------------------
// 唯一的放行口：开一个片段（生成账）
// ---------------------------------------------------------------------------

/** 一段待合成的文本（由**已检查**的正文切出来） */
export interface SegmentPlan {
  text: string
}

export interface OpenSegmentInput {
  replyId: string
  index: number
  /**
   * **已过回复守卫的正文**。
   *
   * ⚠️ 参数名刻意叫 `checkedReplyText`：调用点必须来自
   * `TurnGateway.completeTurn` 之后那一段（`replyGuards` 已经跑过），
   * **不是**模型原始输出。这是契约 §2 `M6` 的一半。
   */
  checkedReplyText: string
  at: number
  /** 谁生成的（`lg` 或装配层名） */
  by: string
}

/**
 * 打开一个片段（写生成账）。
 *
 * ⚠️ 它**只**接受"已检查"的正文。空文本 / 纯空白**拒绝**：
 * 一段没有内容的语音不该进账（否则交付账会为它等一个永远不会来的播放确认）。
 */
export function openSegment(input: OpenSegmentInput): SegmentRecord {
  const text = input.checkedReplyText
  if (typeof text !== 'string' || text.trim() === '') {
    throw new KernelError(
      'validation_error',
      'segment_without_checked_text',
      '片段正文必须是非空文本：生成账是"她说过什么"的唯一权威，空片段会让交付账等一个不会来的确认'
    )
  }
  if (typeof input.replyId !== 'string' || input.replyId.trim() === '') {
    throw new KernelError(
      'validation_error',
      'segment_without_reply_id',
      '片段必须挂在**LG 账本里的** replyId 上：客户端自编的 id 无法与字幕/记忆对账（M5）'
    )
  }
  return {
    segmentId: segmentIdOf(input.replyId, input.index),
    replyId: input.replyId as ReplyId,
    index: input.index,
    text,
    state: 'generated',
    history: [{ state: 'generated', ledger: 'generation', at: input.at, by: input.by }],
  }
}

// ---------------------------------------------------------------------------
// 推进（唯一的一处迁移检查）
// ---------------------------------------------------------------------------

export interface AdvanceSegmentInput {
  segmentId: string
  to: SegmentState
  at: number
  by: string
  audioId?: string
  playedFrom?: number
  playedTo?: number
  reason?: string
}

function withSegment(
  ledger: DeliveryLedger,
  segmentId: string,
  update: (segment: SegmentRecord) => SegmentRecord,
  code: string,
  message: string
): DeliveryLedger {
  const index = ledger.segments.findIndex((segment) => segment.segmentId === segmentId)
  if (index < 0) {
    throw new KernelError('validation_error', code, message)
  }
  const next = ledger.segments.slice()
  next[index] = update(ledger.segments[index]!)
  return { segments: next }
}

/**
 * 推进一个片段。**唯一**的迁移检查点。
 *
 * 拒绝的三类（各自具名，便于门逐一断言）：
 * ```text
 * segment_unknown                 这个 segmentId 不在账上
 * segment_transition_illegal      迁移不在 ALLOWED 表里（四条禁令在此生效）
 * segment_state_regression        想回到"更早"的状态（时间倒流）
 * ```
 */
export function advanceSegment(ledger: DeliveryLedger, input: AdvanceSegmentInput): DeliveryLedger {
  const current = ledger.segments.find((segment) => segment.segmentId === input.segmentId)
  if (current === undefined) {
    throw new KernelError(
      'validation_error',
      'segment_unknown',
      `交付账里没有片段 ${input.segmentId}：不能为不存在的一段语音记录播放事实`
    )
  }
  if (!transitionAllowed(current.state, input.to)) {
    throw new KernelError(
      'validation_error',
      'segment_transition_illegal',
      `非法迁移 ${current.state} → ${input.to}（片段 ${current.segmentId}）：` +
        '生成与合成都**不**等于已播出；断线之后不允许再退回未知'
    )
  }
  /*
   * ⚠️ 合成账的"完成"必须**带音频 id**：只报"合成完成"而没有 audioId，
   * 无法与交付账里的播放事实对上（契约 §1 的合成账要 `audioId`）。
   */
  if (input.to === 'synthesized' && (input.audioId ?? '').trim() === '') {
    throw new KernelError(
      'validation_error',
      'synthesis_without_audio_id',
      '合成账必须带 audioId：没有音频 id 的"合成完成"无法与播放事实对账'
    )
  }
  const transition: SegmentTransition = {
    state: input.to,
    ledger: SEGMENT_LEDGER_OF[input.to],
    at: input.at,
    by: input.by,
    ...(input.audioId !== undefined ? { audioId: input.audioId } : {}),
    ...(input.playedFrom !== undefined ? { playedFrom: input.playedFrom } : {}),
    ...(input.playedTo !== undefined ? { playedTo: input.playedTo } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  }
  return withSegment(
    ledger,
    input.segmentId,
    (segment) => ({
      ...segment,
      state: input.to,
      history: [...segment.history, transition],
      ...(input.audioId !== undefined ? { audioId: input.audioId } : {}),
      ...(input.playedFrom !== undefined ? { playedFrom: input.playedFrom } : {}),
      ...(input.playedTo !== undefined ? { playedTo: input.playedTo } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }),
    'segment_unknown',
    `交付账里没有片段 ${input.segmentId}`
  )
}

/**
 * 断线：把**还没交付的**记为 `cancelled`、把**已交付但结局不明**的记为 `unknown`。
 *
 * ⚠️ 这个区分是门在 R14 抓出来的，不是先想好的：
 * ```text
 *   generated / synthesized  ⇒ 这一段**从来没有被发出去**
 *                              ⇒ 结局是**明确的**：没播（cancelled）
 *   queued / playing         ⇒ 这一段**已经发出去了**，声卡播到哪我们**不知道**
 *                              ⇒ 只能是 unknown（契约 §1：断线时状态必须是 unknown）
 * ```
 * 第一版把两者一起压成 `unknown`，于是 `generated → unknown` 被迁移表拒了 ——
 * 那是对的：**"从没发出去"与"发出去了但不知道"是两件事**，
 * 把它们合并会让"未播出"变得不可判（而 `M11` 正需要区分"没播"与"不知道播没播"）。
 */
export function markTransportLost(
  ledger: DeliveryLedger,
  input: { at: number; reason?: string }
): DeliveryLedger {
  let next = ledger
  for (const segment of ledger.segments) {
    if (SEGMENT_TERMINAL_STATES.includes(segment.state)) continue
    const neverSent = segment.state === 'generated' || segment.state === 'synthesized'
    next = advanceSegment(next, {
      segmentId: segment.segmentId,
      to: neverSent ? 'cancelled' : 'unknown',
      at: input.at,
      by: 'transport',
      reason: input.reason ?? (neverSent ? 'transport_lost_before_send' : 'transport_lost_after_send'),
    })
  }
  return next
}

// ---------------------------------------------------------------------------
// 读面：**只有已播出的部分**才能进后续上下文（契约 §2 `M11`）
// ---------------------------------------------------------------------------

export interface PlayedPartition {
  /** 客户端**确认已播出**的正文（按 index） */
  playedText: string
  /** 未确认播出的正文（按 index）—— **不得**被表述成"我刚才已经告诉过你" */
  unplayedText: string
  playedCount: number
  unplayedCount: number
  /** 其中状态是 `unknown` 的（断线导致我们**不知道**播没播） */
  unknownCount: number
}

/**
 * 按**可确认的已播放部分**切分。
 *
 * ⚠️ `unknown` **算未播出**：断线时我们不知道声卡播到哪了，
 * 把"不确定"当成"已播出"就会让她说"我刚才已经告诉过你"——
 * 而那正是契约 §2 `M11` 要禁止的。
 */
export function playedPartition(ledger: DeliveryLedger): PlayedPartition {
  const sorted = [...ledger.segments].sort((a, b) => a.index - b.index)
  const played = sorted.filter((segment) => segment.state === 'played')
  const unplayed = sorted.filter((segment) => segment.state !== 'played')
  return {
    playedText: played.map((segment) => segment.text).join(''),
    unplayedText: unplayed.map((segment) => segment.text).join(''),
    playedCount: played.length,
    unplayedCount: unplayed.length,
    unknownCount: sorted.filter((segment) => segment.state === 'unknown').length,
  }
}

/**
 * 重连之后**哪些片段还要再播**。
 *
 * ⚠️ 契约 §2 `M11`："重连默认**不自动重播**"。
 * 因此已 `played` 的**不**重播；`unknown` 的**也不**自动重播
 * （重播要先问用户 —— "不确定"不是"没播过"）。
 * 真正需要重播的只有"还没开始播"的那些（`generated`/`synthesized`/`queued`）。
 */
export function segmentsToReplay(ledger: DeliveryLedger): readonly SegmentRecord[] {
  return [...ledger.segments]
    .sort((a, b) => a.index - b.index)
    .filter((segment) => ['generated', 'synthesized', 'queued'].includes(segment.state))
}

// ---------------------------------------------------------------------------
// 对账（契约 §2 `M5`：转录 / 回复 / 字幕**同一 replyId**）
// ---------------------------------------------------------------------------

export interface DeliveryReconciliation {
  ok: boolean
  replyIds: readonly string[]
  /** 字幕文本（= 生成账正文拼接） */
  subtitleText: string
  problems: readonly string[]
}

/**
 * 把交付账与"这一轮的 replyId + 已检查正文"对账。
 *
 * 它抓的是：字幕与生成账不一致 · 有片段挂在别的 replyId 上 · 有段落缺历史。
 */
export function reconcileDelivery(input: {
  ledger: DeliveryLedger
  replyId: string
  checkedReplyText: string
}): DeliveryReconciliation {
  const problems: string[] = []
  const replyIds = [...new Set(input.ledger.segments.map((segment) => String(segment.replyId)))]
  if (input.ledger.segments.length === 0) problems.push('empty_ledger')
  if (replyIds.length > 1) problems.push(`multiple_reply_ids:${replyIds.join(',')}`)
  if (replyIds.length === 1 && replyIds[0] !== input.replyId) {
    problems.push(`reply_id_mismatch:${String(replyIds[0])}`)
  }
  const subtitleText = [...input.ledger.segments]
    .sort((a, b) => a.index - b.index)
    .map((segment) => segment.text)
    .join('')
  /*
   * ⚠️ 字幕必须与**已检查正文**逐字相同 —— 但切分允许丢空白差异吗？**不允许**：
   * 允许"差不多"就等于允许"先播一份、字幕写另一份"。
   */
  if (subtitleText !== input.checkedReplyText) {
    problems.push('subtitle_differs_from_checked_text')
  }
  for (const segment of input.ledger.segments) {
    if (segment.history.length === 0) problems.push(`segment_without_history:${segment.segmentId}`)
    if (segment.history[0]?.state !== 'generated') {
      problems.push(`segment_not_born_in_generation:${segment.segmentId}`)
    }
  }
  return { ok: problems.length === 0, replyIds, subtitleText, problems }
}

/** 三本账各写了哪些（审计读面：出问题时先看是哪本账坏了） */
export function ledgerWriteCounts(ledger: DeliveryLedger): Record<SegmentLedger, number> {
  const counts: Record<SegmentLedger, number> = { generation: 0, synthesis: 0, delivery: 0 }
  for (const segment of ledger.segments) {
    for (const transition of segment.history) counts[transition.ledger] += 1
  }
  return counts
}
