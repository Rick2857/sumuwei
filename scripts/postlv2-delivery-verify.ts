/**
 * 后 Lv2 · WP4/WP5 —— **媒体交付账门**（`pnpm postlv2:delivery:verify`）。
 *
 * ============================================================================
 *  载体：媒体交付契约 §1/§2/§4 · 计划 §6.2/§7/§8.2
 * ============================================================================
 * 它守的四条**禁令**（契约 §1 的"禁止的等价替换"），以及两条读面判据：
 * ```text
 * D1 「已生成 ⇒ 已播出」不可能：generated 到不了 playing/played
 * D2 「合成完成 ⇒ 已播出」不可能：synthesized 到不了 playing/played
 * D3 「断线 ⇒ 已播放」不可能：断线进 unknown（且 delivered 不能退回 unknown）
 * D4 「播放确认 ⇒ 真人听懂」不存在：词汇里没有任何"听懂"类状态
 * D5 先检查后合成（M6）：空/空白正文进不了生成账；且合成必须带 audioId
 * D6 只有已播出的部分能进后续上下文（M11）：unknown **算未播出**；重连不自动重播
 * D7 对账（M5）：字幕与已检查正文**逐字相同**，且同一 replyId
 * V1 量具自证三段式
 * ```
 *
 * ⚠️ **本门不主张**：真实 TTS / 真实声卡 / 真实播放延迟（那需要 WP4 本体与真人读数）。
 * 它证明的是"三本账**在结构上**不能互相代替"。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  SEGMENT_STATES,
  SEGMENT_TERMINAL_STATES,
  advanceSegment,
  emptyDeliveryLedger,
  ledgerWriteCounts,
  markTransportLost,
  openSegment,
  playedPartition,
  reconcileDelivery,
  segmentsToReplay,
  transitionAllowed,
  type DeliveryLedger,
  type SegmentState,
} from '../src/kernel/contracts/media-delivery.ts'
/* ⚠️ `D9` 量的是**类**上的 `markSuperseded` 映射（那处缺陷在类里，不在纯契约里） */
import { VoiceDeliveryLedger } from '../src/kernel/app/bridge/voice-delivery-ledger.ts'

const REPO_ROOT = resolve(process.cwd())

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const REPLY_ID = 'cev:probe-reply-1'
const CHECKED_TEXT = '我看了你的简历，二面我们聊项目吧。'
/** 把已检查正文切成两段（模拟 TTS 分句） */
const PARTS = ['我看了你的简历，', '二面我们聊项目吧。']

function openLedger(): DeliveryLedger {
  let ledger = emptyDeliveryLedger()
  PARTS.forEach((text, index) => {
    ledger = { segments: [...ledger.segments, openSegment({ replyId: REPLY_ID, index, checkedReplyText: text, at: 1000 + index, by: 'lg' })] }
  })
  return ledger
}

const illegalTransition = (ledger: DeliveryLedger, input: Parameters<typeof advanceSegment>[1]): string => {
  try {
    advanceSegment(ledger, input)
    return 'none'
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
}

// ===========================================================================
// D1 「已生成 ⇒ 已播出」不可能
// ===========================================================================
const base = openLedger()
const generatedToPlaying = illegalTransition(base, {
  segmentId: `${REPLY_ID}#0`,
  to: 'playing',
  at: 2000,
  by: 'client:fake',
})
const generatedToPlayed = illegalTransition(base, {
  segmentId: `${REPLY_ID}#0`,
  to: 'played',
  at: 2000,
  by: 'client:fake',
})
record(
  'D1',
  '「**已生成 ⇒ 已播出**」不可能：`generated` 到不了 `playing`/`played`（生成不等于到达）',
  generatedToPlaying === 'segment_transition_illegal' && generatedToPlayed === 'segment_transition_illegal',
  `generated→playing=${generatedToPlaying} · generated→played=${generatedToPlayed}（都应为 segment_transition_illegal）`,
  2
)

// ===========================================================================
// D2 「合成完成 ⇒ 已播出」不可能
// ===========================================================================
const afterSynthesis = advanceSegment(base, {
  segmentId: `${REPLY_ID}#0`,
  to: 'synthesized',
  at: 3000,
  by: 'tts:probe',
  audioId: 'audio:seg0',
})
const synthesizedToPlaying = illegalTransition(afterSynthesis, {
  segmentId: `${REPLY_ID}#0`,
  to: 'playing',
  at: 3100,
  by: 'tts:probe',
})
const synthesizedToPlayed = illegalTransition(afterSynthesis, {
  segmentId: `${REPLY_ID}#0`,
  to: 'played',
  at: 3100,
  by: 'tts:probe',
})
// 正控：走完整条合法链是**可以**的（证明上面的"拒"不是"什么都拒"）
let okChain = afterSynthesis
for (const [to, by] of [
  ['queued', 'client:probe'],
  ['playing', 'client:probe'],
  ['played', 'client:probe'],
] as const) {
  okChain = advanceSegment(okChain, { segmentId: `${REPLY_ID}#0`, to, at: 3200, by })
}
record(
  'D2',
  '「**合成完成 ⇒ 已播出**」不可能（合成只到 `synthesized`）；而**完整的合法链**照常走通到 `played`',
  synthesizedToPlaying === 'segment_transition_illegal' &&
    synthesizedToPlayed === 'segment_transition_illegal' &&
    okChain.segments[0]?.state === 'played',
  `synthesized→playing=${synthesizedToPlaying} · synthesized→played=${synthesizedToPlayed} · 合法链终态=${okChain.segments[0]?.state}（应 played）`,
  3
)

// ===========================================================================
// D3 「断线 ⇒ 已播放」不可能
// ===========================================================================
const inFlight = advanceSegment(
  advanceSegment(base, {
    segmentId: `${REPLY_ID}#0`,
    to: 'synthesized',
    at: 3000,
    by: 'tts:probe',
    audioId: 'audio:seg0',
  }),
  { segmentId: `${REPLY_ID}#0`, to: 'queued', at: 3100, by: 'client:probe' }
)
const lost = markTransportLost(inFlight, { at: 4000, reason: 'socket_closed' })
const afterLossState = lost.segments[0]?.state
/*
 * ⚠️ 另测**还没发出去**的那一段：断线时它必须是 `cancelled`（结局明确=没播），
 * **不是** `unknown`。"从没发出去"与"发出去了但不知道播没播"是两件事，
 * 把它们合并会让 `M11` 无法区分"没播"与"不知道播没播"。
 */
const notYetSent = markTransportLost(base, { at: 4100, reason: 'socket_closed' })
const afterLossNotSent = notYetSent.segments[0]?.state
// 断线之后**不允许**退回 unknown（那会让"已播出"被一句断线抹掉）
/*
 * ⚠️ 这里要**独立的**账：`okChain` 只有 `#0` 一个片段（推进 `#1` 会因
 * `segment_unknown` 抛错，而不是因为迁移非法）。用一条只含 `#1` 的账测"已交付不能退回未知"。
 */
let secondOnly = emptyDeliveryLedger()
secondOnly = {
  segments: [
    openSegment({ replyId: REPLY_ID, index: 1, checkedReplyText: PARTS[1]!, at: 1001, by: 'lg' }),
  ],
}
for (const [to, by, audioId] of [
  ['synthesized', 'tts:probe', 'a1'],
  ['queued', 'client:probe', undefined],
  ['playing', 'client:probe', undefined],
  ['played', 'client:probe', undefined],
] as const) {
  secondOnly = advanceSegment(secondOnly, {
    segmentId: `${REPLY_ID}#1`,
    to,
    at: 3400,
    by,
    ...(audioId !== undefined ? { audioId } : {}),
  })
}
const deliveredToUnknown = illegalTransition(secondOnly, {
  segmentId: `${REPLY_ID}#1`,
  to: 'unknown',
  at: 3700,
  by: 'transport',
})
// `unknown` 可被**更强的交付事实**单向纠正（断线后重连如实报告）
const unknownToPlaying = transitionAllowed('unknown', 'playing')
record(
  'D3',
  '「**断线 ⇒ 已播放**」不可能：已交付的进 `unknown`、**还没发出去的**进 `cancelled`（两件事不合并）；且已交付**不能**退回 `unknown`（单向可纠正）',
  afterLossState === 'unknown' &&
    afterLossNotSent === 'cancelled' &&
    deliveredToUnknown === 'segment_transition_illegal' &&
    unknownToPlaying,
  `已交付断线=${String(afterLossState)}（应 unknown）· 未发送断线=${String(afterLossNotSent)}（应 cancelled）· played→unknown=${deliveredToUnknown}（应 illegal）· unknown→playing 允许=${String(unknownToPlaying)}`,
  6
)

// ===========================================================================
// D4 词汇里没有任何"听懂"类状态
// ===========================================================================
const forbiddenWords = ['understood', 'comprehended', 'heard', 'digested', 'acknowledged_by_human']
const vocabularyClean = SEGMENT_STATES.every(
  (state) => !forbiddenWords.some((word) => String(state).includes(word))
)
record(
  'D4',
  '「**播放确认 ⇒ 真人听懂**」在词汇上不存在：没有任何"听懂/理解"类状态（播放确认只证明客户端报告已播放）',
  vocabularyClean && SEGMENT_STATES.length === 7 && SEGMENT_TERMINAL_STATES.length === 3,
  `状态数=${SEGMENT_STATES.length} · 终态数=${SEGMENT_TERMINAL_STATES.length} · 含禁用词=${String(!vocabularyClean)} · 状态=${JSON.stringify(SEGMENT_STATES)}`,
  3
)

// ===========================================================================
// D5 先检查后合成（M6）+ 合成必须带 audioId
// ===========================================================================
const emptyRejected = (() => {
  try {
    openSegment({ replyId: REPLY_ID, index: 0, checkedReplyText: '   ', at: 1, by: 'lg' })
    return 'none'
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
})()
const noReplyIdRejected = (() => {
  try {
    openSegment({ replyId: '', index: 0, checkedReplyText: '文本', at: 1, by: 'lg' })
    return 'none'
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
})()
const synthesisWithoutAudio = illegalTransition(base, {
  segmentId: `${REPLY_ID}#0`,
  to: 'synthesized',
  at: 3000,
  by: 'tts:probe',
})
record(
  'D5',
  '**先检查后合成**（`M6`）：空/纯空白正文进不了生成账；片段必须挂在 LG 的 `replyId` 上；合成账**必须**带 `audioId`',
  emptyRejected === 'segment_without_checked_text' &&
    noReplyIdRejected === 'segment_without_reply_id' &&
    synthesisWithoutAudio === 'synthesis_without_audio_id',
  `空文本=${emptyRejected} · 无 replyId=${noReplyIdRejected} · 无 audioId=${synthesisWithoutAudio}`,
  3
)

// ===========================================================================
// D6 只有已播出的部分能进后续上下文（M11）
// ===========================================================================
/*
 * 构造：seg0 已 played、seg1 断线后 unknown。
 * ⇒ 只有 seg0 的正文算"说过了"；unknown **必须**算未播出。
 */
let m11 = emptyDeliveryLedger()
PARTS.forEach((text, index) => {
  m11 = { segments: [...m11.segments, openSegment({ replyId: REPLY_ID, index, checkedReplyText: text, at: 1000 + index, by: 'lg' })] }
})
m11 = advanceSegment(m11, { segmentId: `${REPLY_ID}#0`, to: 'synthesized', at: 2000, by: 'tts', audioId: 'a0' })
m11 = advanceSegment(m11, { segmentId: `${REPLY_ID}#0`, to: 'queued', at: 2100, by: 'client' })
m11 = advanceSegment(m11, { segmentId: `${REPLY_ID}#0`, to: 'playing', at: 2200, by: 'client' })
m11 = advanceSegment(m11, { segmentId: `${REPLY_ID}#0`, to: 'played', at: 2300, by: 'client' })
m11 = advanceSegment(m11, { segmentId: `${REPLY_ID}#1`, to: 'synthesized', at: 2400, by: 'tts', audioId: 'a1' })
m11 = advanceSegment(m11, { segmentId: `${REPLY_ID}#1`, to: 'queued', at: 2500, by: 'client' })
m11 = markTransportLost(m11, { at: 2600, reason: 'socket_closed' })
const partition = playedPartition(m11)
const replay = segmentsToReplay(m11)
record(
  'D6',
  '只有**已播出**的部分能进后续上下文（`M11`）：`unknown` **算未播出**；已播出的**不重播**、`unknown` 的**也不自动重播**',
  partition.playedText === PARTS[0] &&
    partition.unplayedText === PARTS[1] &&
    partition.unknownCount === 1 &&
    partition.playedCount === 1 &&
    replay.length === 0,
  `已播出=${JSON.stringify(partition.playedText)} · 未播出=${JSON.stringify(partition.unplayedText)} · unknown=${partition.unknownCount} · 待重播=${replay.length}（应 0）`,
  6
)

// ===========================================================================
// D7 对账（M5）：字幕与已检查正文逐字相同 + 同一 replyId
// ===========================================================================
const goodReconcile = reconcileDelivery({ ledger: okChain, replyId: REPLY_ID, checkedReplyText: CHECKED_TEXT })
const tamperedLedger: DeliveryLedger = {
  segments: okChain.segments.map((segment) =>
    segment.index === 0 ? { ...segment, text: '（被改过的字幕）' } : segment
  ),
}
const tamperedReconcile = reconcileDelivery({
  ledger: tamperedLedger,
  replyId: REPLY_ID,
  checkedReplyText: CHECKED_TEXT,
})
const foreignLedger: DeliveryLedger = {
  segments: okChain.segments.map((segment, index) =>
    index === 1 ? { ...segment, replyId: 'cev:someone-else' as never } : segment
  ),
}
const foreignReconcile = reconcileDelivery({
  ledger: foreignLedger,
  replyId: REPLY_ID,
  checkedReplyText: CHECKED_TEXT,
})
record(
  'D7',
  '对账（`M5`）：字幕与**已检查正文逐字相同**、且所有片段同一 `replyId`；改一个字或换一个 replyId 都会被抓住',
  goodReconcile.ok &&
    !tamperedReconcile.ok &&
    tamperedReconcile.problems.includes('subtitle_differs_from_checked_text') &&
    !foreignReconcile.ok &&
    foreignReconcile.problems.some((problem) => problem.startsWith('multiple_reply_ids')),
  `合法=${String(goodReconcile.ok)} · 篡改字幕=${JSON.stringify(tamperedReconcile.problems)} · 外来 replyId=${JSON.stringify(foreignReconcile.problems)}`,
  5
)

// 三本账各写了多少（审计读面）
/*
 * ⚠️ 判据是"三本账**各自**可数且都非空"，不是"三个数相等" ——
 * 三本账本来就不等长（`okChain` 里 `#0` 走完全链、`#1` 没被推进）。
 * 第一版两次把期望值写错（先凭印象、后按"相等"），两次都是**判据形状**错了：
 * 我要断言的是"审计面能分开三本账"，那就断言**可数、非空、且各自计数正确**。
 */
const counts = ledgerWriteCounts(okChain)
const advanced = okChain.segments.filter((segment) => segment.history.length > 1).length
record(
  'D8',
  '三本账**分别**可数且都非空（出问题时先看是哪本账坏了）：生成=每条一次、合成=被合成过几条、交付=那几条约 3 次',
  counts.generation === okChain.segments.length &&
    counts.synthesis === advanced &&
    counts.delivery === 3 * advanced,
  `生成=${counts.generation}（应 ${okChain.segments.length}）· 合成=${counts.synthesis}（应 ${advanced}）· 交付=${counts.delivery}（应 ${3 * advanced}）`,
  3
)

// ===========================================================================
// D9 废弃未播余句的**状态映射**（P3 中途纠正依赖它；这里修补过一处静默缺陷）
// ===========================================================================
/*
 * 实测出来的缺陷（真链路读数 `correction_last_superseded = 0`，可她正在说）：
 * ```text
 * 第一版 markSuperseded：queued ⇒ cancelled，**其它一律** ⇒ unknown
 * 而迁移表里 synthesized → unknown **不允许** ⇒ advanceSegment 抛错
 *   ⇒ 被 bare catch 静默吞掉 ⇒ 报"什么都没作废"，而当时确实有未播余句
 * ```
 * ⇒ 现在每个未终态都有**合法且诚实**的目标，且"想作废却作废不了"会被记下来（不再是静默）。
 * ⚠️ 这条门要同时钉住**四件事**：合成段被作废 · 播放中只到 unknown · 终态不动 · 失败面为空。
 */
const supersedeLedger = new VoiceDeliveryLedger()
supersedeLedger.openReply({
  replyId: 'r-supersede',
  segments: [
    { segmentId: 'r-supersede#0', text: '一' },
    { segmentId: 'r-supersede#1', text: '二' },
    { segmentId: 'r-supersede#2', text: '三' },
  ],
  at: 1000,
})
/* #0 只到"合成完成"（**这正是真链路里那种段**：客户端报了 synthesized 就没了下文） */
supersedeLedger.reportSynthesized({ segmentId: 'r-supersede#0', audioId: 'a0', at: 1100 })
/* #1 推到"正在播"（不许被说成"确定没播"） */
supersedeLedger.reportSynthesized({ segmentId: 'r-supersede#1', audioId: 'a1', at: 1110 })
supersedeLedger.report({ segmentId: 'r-supersede#1', state: 'playing', at: 1120 })
/* #2 推到"已播完"（终态，一个字都不许动） */
supersedeLedger.reportSynthesized({ segmentId: 'r-supersede#2', audioId: 'a2', at: 1130 })
supersedeLedger.report({ segmentId: 'r-supersede#2', state: 'playing', at: 1140 })
supersedeLedger.report({ segmentId: 'r-supersede#2', state: 'played', at: 1150 })
const supersededTouched = supersedeLedger.markSuperseded({ at: 1200, by: 'mid_turn_correction', reason: 'user_correction' })
const supersededStates = supersedeLedger.states
record(
  'D9',
  '**废弃未播余句**的状态映射（`P3` 中途纠正的地基）：只到"合成完成"的那段 ⇒ `cancelled`（**确定不会播**，不许落成"不知道"）· 已在播的那段 ⇒ `unknown`（不许说成"确定没播"）· 已播完的**一个字都不动** · "想作废却作废不了"的失败面必须为空（静默 = 缺陷）',
  supersededTouched.length === 2 &&
    supersededStates['r-supersede#0'] === 'cancelled' &&
    supersededStates['r-supersede#1'] === 'unknown' &&
    supersededStates['r-supersede#2'] === 'played' &&
    supersedeLedger.supersedeFailures.length === 0,
  `被作废=${String(supersededTouched.length)}（应 2）· 合成段⇒${String(supersededStates['r-supersede#0'])}（应 cancelled）· ` +
    `在播段⇒${String(supersededStates['r-supersede#1'])}（应 unknown）· 已播段⇒${String(supersededStates['r-supersede#2'])}（应 played）· ` +
    `作废失败面=${JSON.stringify(supersedeLedger.supersedeFailures)}（应空）`,
  5
)

// ===========================================================================
// V1 量具自证三段式
// ===========================================================================
/** 被检验的判据本体：**一段"合成完成但没播"的语音不得被算成已播出** */
const detectFalsePlayed = (ledger: DeliveryLedger, segmentId: string): boolean => {
  const segment = ledger.segments.find((item) => item.segmentId === segmentId)
  return segment !== undefined && segment.state === 'played'
}
const selfCheck = (() => {
  const positive = detectFalsePlayed(afterSynthesis, `${REPLY_ID}#0`) // 正控 ⇒ false（只到 synthesized）
  // 负控：直接构造一条"已播出"的记录 ⇒ 必须响
  const negative = detectFalsePlayed(okChain, `${REPLY_ID}#0`) // 这条**真的**已播出 ⇒ true
  const restored = detectFalsePlayed(afterSynthesis, `${REPLY_ID}#0`) // 恢复 ⇒ false
  void negative
  /*
   * ⚠️ 这里的"负控"要喂**违反不变量**的输入。上面的 `okChain` 是**真的**已播出，
   * 所以它响是对的、不构成负控。因此负控改用"把 synthesized 说成 played"的手工记录。
   */
  const forged: DeliveryLedger = {
    segments: afterSynthesis.segments.map((segment) => ({ ...segment, state: 'played' as SegmentState })),
  }
  const forgedDetected = detectFalsePlayed(forged, `${REPLY_ID}#0`)
  return {
    ok: positive === false && forgedDetected === true && restored === false,
    detail: `正控=${String(positive)}（应 false）· 负控（手工伪造 played）=${String(forgedDetected)}（应 true）· 恢复=${String(restored)}（应 false）`,
  }
})()
record('V1', '量具自证三段式：真实"只合成未播"安静 → 伪造 played 必响 → 恢复后重新安静', selfCheck.ok, selfCheck.detail, 3)

// ===========================================================================
// 汇总与证据
// ===========================================================================
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failedChecks = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failedChecks.length === 0

let head = 'unknown'
try {
  head = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-delivery-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const reading = {
  runId,
  gate: 'postlv2:delivery:verify',
  milestone: 'post-lv2 / WP4+WP5 (media source, delivery and cancellation ledger)',
  generatedAt: new Date().toISOString(),
  source: { head },
  vocabulary: {
    segmentStates: [...SEGMENT_STATES],
    terminalStates: [...SEGMENT_TERMINAL_STATES],
  },
  transitionTable: Object.fromEntries(
    SEGMENT_STATES.map((state) => [
      state,
      SEGMENT_STATES.filter((to) => transitionAllowed(state, to)),
    ])
  ),
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
  notClaimed: [
    '不主张真实 TTS / 真实声卡：本门是纯契约读数，没有任何音频',
    '不主张任何延迟阈值（媒体契约 §3 的五条阈值需要真人同钟测量）',
    /*
     * ⚠️ 这一条**已经过时过一次**，而且正是"读数必须跟着实现走"的例子：
     *    第一版写的是"桥仍然没有取消消息（残余 L-PL2-04）"。`L-PL2-04` 早已关闭
     *    （`CANCEL_TURN` 已登记），Lv4.5 / `P1` 又补上了合成账与播放回报。
     *    留着旧措辞会让这份证据在**没做任何事**的情况下显得比实际更保守。
     */
    '不主张"客户端真的发了播放回报"：本门只证明账**在结构上**不会把未播当成已播；真实回报链路的读数在 `postlv2:transport:verify`（T10）与真人联合验收',
    '不主张 LG 已把交付账接进最近对话视图（P1 的接线步骤，见计划书 §2）',
  ],
}
writeFileSync(join(outDir, 'delivery-verify.json'), JSON.stringify(reading, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:delivery:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/delivery-verify.json`)

process.exit(passed ? 0 : 1)
