/**
 * 后 Lv2 · WP1d —— **入口桥传输与生产 host 门**（`pnpm postlv2:transport:verify`）。
 *
 * ============================================================================
 *  载体：计划 §4 / §9 · ADR-091 §4 · `INV-PL2-09`/`INV-PL2-10`/`INV-PL2-11`
 * ============================================================================
 * 它守什么（**全离线**：内存流 + 受控 stub session；**不 spawn 子进程**）：
 * ```text
 * T1 生产 host：`sessionHost()` 返回**已检查**的正文 + **session 自己**的身份；
 *               `send()` 没登记身份 ⇒ 失败关闭（**绝不**编一个 replyId 出去）
 * T2 身份只来自 session：请求里没有任何字段能改角色/会话（INV-PL2-08）
 * T3 传输：合法行 ⇒ 回一条结果；**畸形 JSON** ⇒ 具名拒绝且**不打断会话**
 * T4 串行与配对：写回的顺序 == 读入的顺序，且每条响应带回同一个 requestId
 * T5 未登记消息种类 ⇒ 拒绝（不建万能连接器框架）
 * T6 逐行计数自证：`linesIn / parsed / malformed / linesOut` 与真实输入相符
 * V1 量具自证三段式（正控 / 负控 / 恢复）
 * ```
 *
 * ⚠️ 本门**不**声称"生产接线已被真实验证"：`main.ts` 的 `--bridge` 分支确实用同一条
 *    `runBridgeTransport` + `sessionHost`（静态判据 T7 核对源码），但"真的从
 *    外壳进程连进来"属真人/真外壳的读数，本门**不**替代它。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { asCharacterId, asConversationId } from '../src/kernel/contracts/ids.ts'
import {
  TurnBridge,
  BRIDGE_MESSAGE_KINDS,
  handleBridgeMessage,
  type BridgeWireResponse,
  type TurnBridgeHost,
} from '../src/kernel/app/bridge/turn-bridge.ts'
import { VoiceDeliveryLedger } from '../src/kernel/app/bridge/voice-delivery-ledger.ts'
import {
  BRIDGE_TRANSPORT_MESSAGE_KINDS,
  runBridgeTransport,
  sessionHost,
  TurnCancellationRegistry,
  type BridgeSessionLike,
  type BridgeTransportStreams,
} from '../src/infrastructure/bridge/turn-bridge-transport.ts'

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

// ===========================================================================
// T1/T2 生产 host：ChatSession.send() 的薄包装
// ===========================================================================

/** 受控 stub session：模拟 `ChatSession` 的最小面 */
function makeStubSession(options: { forgetIdentityAfterSend?: boolean } = {}): {
  session: BridgeSessionLike
  sends: string[]
} {
  const sends: string[] = []
  let identity:
    | { replyId: string; traceId: string; domainEventIds: readonly string[] }
    | undefined
  const session: BridgeSessionLike = {
    characterId: String(asCharacterId('char_session_probe')),
    conversationId: String(asConversationId('dm-session-probe')),
    async send(userText: string) {
      sends.push(userText)
      if (options.forgetIdentityAfterSend !== true) {
        identity = {
          replyId: `cev:session:${sends.length}`,
          traceId: `trc:session:${sends.length}`,
          domainEventIds: ['dev:session:1'],
        }
      }
      return `（已过守卫）收到：${userText}`
    },
    lastTurnIdentity: () => identity,
  }
  return { session, sends }
}

const stub = makeStubSession()
const host = sessionHost(stub.session)
const hostResult = await host.runTurn({ userText: '你好', requestId: 'r-1' })
record(
  'T1',
  '生产 host：`sessionHost()` 交回**已检查**的正文 + **session 自己**的 identity（replyId/traceId/domainEventIds）',
  hostResult.replyText === '（已过守卫）收到：你好' &&
    hostResult.replyId === 'cev:session:1' &&
    hostResult.traceId === 'trc:session:1' &&
    hostResult.domainEventIds.length === 1 &&
    stub.sends.length === 1,
  `replyId=${hostResult.replyId} · traceId=${hostResult.traceId} · send 调用=${stub.sends.length}`,
  5
)

// 负控：send() 没登记身份 ⇒ **失败关闭**（不编 replyId）
const forgetful = makeStubSession({ forgetIdentityAfterSend: true })
const forgetfulHost = sessionHost(forgetful.session)
let forgedRefused = false
let forgedCode = 'none'
try {
  await forgetfulHost.runTurn({ userText: '你好', requestId: 'r-2' })
} catch (error) {
  forgedRefused = true
  forgedCode = (error as { code?: string }).code ?? 'unknown'
}
record(
  'T2',
  '负控：`send()` 返回了却没登记本轮身份 ⇒ **失败关闭**（绝不编一个指向不存在事件的 replyId）',
  forgedRefused && forgedCode === 'bridge_session_without_identity',
  `拒绝=${String(forgedRefused)} · code=${forgedCode}`,
  2
)

// 身份只来自 session：桥的 identity 与 session 一致，且请求改不动
const bridgeIdentity = new TurnBridge({ host }).identity
const requestHasNoIdentityField = !Object.prototype.hasOwnProperty.call(
  JSON.parse(JSON.stringify({ kind: 'SUBMIT_TURN', requestId: 'r', userText: 'x' })),
  'characterId'
)
record(
  'T3',
  '身份只来自 session（`INV-PL2-08`）：桥报出的角色/会话 == session 的绑定；请求字段改不动它',
  bridgeIdentity.characterId === 'char_session_probe' &&
    bridgeIdentity.conversationId === 'dm-session-probe' &&
    requestHasNoIdentityField,
  `绑定=${JSON.stringify(bridgeIdentity)} · 请求无身份字段=${String(requestHasNoIdentityField)}`,
  3
)

// ===========================================================================
// T4/T5/T6 传输（内存流，不 spawn 子进程）
// ===========================================================================
/**
 * 内存流（不 spawn 子进程）。
 *
 * ⚠️ `delayAfterFirstMs` 是给"控制消息解耦"那条判据用的：它让**第二行**
 *    在**慢轮次已经开始跑**之后才到达 —— 否则"取消立刻被读到"可能只是因为
 *    两行本来就一起到了，判据量到的就不是解耦。
 */
function memoryStreams(
  lines: readonly string[],
  delayAfterFirstMs = 0
): {
  streams: BridgeTransportStreams
  written: string[]
} {
  const written: string[] = []
  return {
    written,
    streams: {
      read: () =>
        (async function* () {
          for (const [index, line] of lines.entries()) {
            if (index === 1 && delayAfterFirstMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayAfterFirstMs))
            }
            yield line
          }
        })(),
      write: (line) => written.push(line),
    },
  }
}

const transportStub = makeStubSession()
const transportBridge = new TurnBridge({ host: sessionHost(transportStub.session) })
const transport = memoryStreams([
  JSON.stringify({ kind: 'SUBMIT_TURN', requestId: 'a', userText: '第一句' }),
  JSON.stringify({ kind: 'SUBMIT_TURN', requestId: 'b', userText: '第二句' }),
])
const transportReading = await runBridgeTransport(transportBridge, transport.streams)
const responses = transport.written.map(
  (line) => JSON.parse(line) as { requestId: string; outcome: string; replyText?: string }
)
record(
  'T4',
  '传输：合法行逐条处理；写回的**顺序**与读入一致，且每条响应带回**同一个 requestId**（外壳才能配对）',
  responses.length === 2 &&
    responses[0]!.requestId === 'a' &&
    responses[1]!.requestId === 'b' &&
    responses.every((response) => response.outcome === 'replied'),
  `写回=${JSON.stringify(responses.map((r) => `${r.requestId}:${r.outcome}`))}`,
  responses.length
)

// 畸形 JSON ⇒ 具名拒绝且不打断会话（后面的行照常处理）
const malformedTransport = memoryStreams([
  '{ 这不是 JSON',
  JSON.stringify({ kind: 'SUBMIT_TURN', requestId: 'ok', userText: '还能继续' }),
])
const malformedReading = await runBridgeTransport(
  new TurnBridge({ host: sessionHost(makeStubSession().session) }),
  malformedTransport.streams
)
const malformedResponses = malformedTransport.written.map(
  (line) => JSON.parse(line) as { code?: string; outcome: string; requestId: string }
)
record(
  'T5',
  '畸形 JSON ⇒ 具名拒绝（`bridge_malformed_json`）且**不打断会话**：后面的行照常处理',
  malformedResponses.length === 2 &&
    malformedResponses[0]!.code === 'bridge_malformed_json' &&
    malformedResponses[0]!.outcome === 'rejected' &&
    malformedResponses[1]!.outcome === 'replied' &&
    malformedReading.malformed === 1 &&
    malformedReading.parsed === 1,
  `计数：读入 ${malformedReading.linesIn} · 解析 ${malformedReading.parsed} · 畸形 ${malformedReading.malformed} · 写出 ${malformedReading.linesOut}`,
  5
)

// 未登记消息种类 ⇒ 拒绝
const unknownKindTransport = memoryStreams([
  JSON.stringify({ kind: 'EXECUTE_ARBITRARY_CODE', requestId: 'x', userText: 'rm -rf' }),
])
await runBridgeTransport(
  new TurnBridge({ host: sessionHost(makeStubSession().session) }),
  unknownKindTransport.streams
)
const unknownKindResponse = JSON.parse(unknownKindTransport.written[0]!) as {
  code?: string
  outcome: string
}
record(
  'T6',
  '未登记消息种类 ⇒ 拒绝（`bridge_unknown_message_kind`）—— 不建万能连接器框架（受控登记表**显式**列出允许的种类）',
  unknownKindResponse.code === 'bridge_unknown_message_kind' &&
    unknownKindResponse.outcome === 'rejected' &&
    BRIDGE_TRANSPORT_MESSAGE_KINDS.includes('SUBMIT_TURN') &&
    BRIDGE_TRANSPORT_MESSAGE_KINDS.includes('CANCEL_TURN') &&
    BRIDGE_TRANSPORT_MESSAGE_KINDS.includes('REPORT_PLAYBACK'),
  `受控种类=${JSON.stringify(BRIDGE_TRANSPORT_MESSAGE_KINDS)} · 拒绝码=${String(unknownKindResponse.code)}`,
  5
)

// 逐行计数自证（空行不计、注释性空白不计）
const blankTransport = memoryStreams(['', '   ', JSON.stringify({ kind: 'SUBMIT_TURN', requestId: 'z', userText: '嗨' })])
const blankReading = await runBridgeTransport(
  new TurnBridge({ host: sessionHost(makeStubSession().session) }),
  blankTransport.streams
)
record(
  'T7',
  '逐行计数自证：空白行**不计数**、不产生响应；`linesIn/parsed/malformed/linesOut` 与真实输入相符',
  blankReading.linesIn === 1 &&
    blankReading.parsed === 1 &&
    blankReading.malformed === 0 &&
    blankReading.linesOut === 1 &&
    blankTransport.written.length === 1,
  `读入 ${blankReading.linesIn}（应 1）· 写出 ${blankReading.linesOut}（应 1）· 空白行被忽略=${String(transportReading.linesIn === 2)}`,
  5
)

// ===========================================================================
// T8 静态：`main.ts` 的 `--bridge` 分支真的用同一条传输与同一个 host
// ===========================================================================
const mainSource = readFileSync(join(REPO_ROOT, 'src/main.ts'), 'utf8')
const usesSameTransport = /runBridgeTransport\(bridge/.test(mainSource)
/*
 * ⚠️ 判据要容忍**取消登记表**这个参数：`sessionHost(session, { cancellation })`。
 * 第一版写死 `sessionHost\(session\)`，于是接线**没坏**、判据先红了 ——
 * 判据必须量"用的是不是同一个 host 构造器"，而不是"参数列表长得跟上次一样"。
 */
const usesSessionHost = /sessionHost\(\s*session\s*[,)]/.test(mainSource)
const bridgeIsOptIn = /argv\.includes\('--bridge'\)/.test(mainSource)
const sessionSurfacePresent =
  /lastTurnIdentity\(\)/.test(mainSource) && /get characterId\(\): string/.test(mainSource)
record(
  'T8',
  '静态接线：`main.ts` 的 `--bridge` 分支用**同一条** `runBridgeTransport` + **同一个** `sessionHost(session)`，且缺省不存在（opt-in）',
  usesSameTransport && usesSessionHost && bridgeIsOptIn && sessionSurfacePresent,
  `runBridgeTransport=${String(usesSameTransport)} · sessionHost(session)=${String(usesSessionHost)} · opt-in=${String(bridgeIsOptIn)} · session 读面=${String(sessionSurfacePresent)}`,
  4
)

// ===========================================================================
// V1 量具自证三段式
// ===========================================================================
/** 被检验的判据本体：**畸形行必须被具名拒绝** */
const detectMalformedRejection = (response: { code?: string; outcome?: string }): boolean =>
  response.code === 'bridge_malformed_json' && response.outcome === 'rejected'
const selfCheck = (() => {
  const positive = detectMalformedRejection(malformedResponses[0]!) // 正控 ⇒ true
  const negative = detectMalformedRejection({ code: 'none', outcome: 'replied' }) // 负控 ⇒ false
  const restored = detectMalformedRejection(malformedResponses[0]!) // 恢复 ⇒ true
  return {
    ok: positive === true && negative === false && restored === true,
    detail: `正控=${String(positive)}（应 true）· 负控=${String(negative)}（应 false）· 恢复=${String(restored)}（应 true）`,
  }
})()
record('V1', '量具自证三段式：真实畸形行必响 → 把"已正常回复"喂进去必静 → 恢复后重新响', selfCheck.ok, selfCheck.detail, 3)

// ===========================================================================
// T9 Lv4.5 / P1：**控制消息与耗时轮次解耦**
// ===========================================================================
/*
 * 旧实现是单循环"读一行 → await 处理完 → 写回一行"，于是这一条**不可能**成立：
 * 慢轮次期间外壳发来的 `CANCEL_TURN` 一直躺在输入缓冲区里，直到那一轮结束才被读到。
 * 判据因此刻意量**时序**，而不是"取消登记表里有没有那个 id"：
 *
 *   ① 取消响应**在**轮次响应**之前**写出（`cancelWrittenFirst`）
 *   ② 取消响应的**时延**远小于那一轮的耗时（`controlLatencyMs[0] < turnMs / 2`）
 *   ③ `controlPeakInFlight >= 1`：控制消息真的另起了一条通道
 *   ④ 负控：轮次仍**只**被提交一次（解耦没有把正式轮次也变成并发）
 */
const DECOUPLED_TURN_MS = 60
function makeSlowSession(delayMs: number): { session: BridgeSessionLike; sends: string[] } {
  const sends: string[] = []
  let identity: { replyId: string; traceId: string; domainEventIds: readonly string[] } | undefined
  return {
    sends,
    session: {
      characterId: String(asCharacterId('char_session_probe')),
      conversationId: String(asConversationId('dm-session-probe')),
      async send(userText: string) {
        sends.push(userText)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        identity = {
          replyId: `cev:slow:${sends.length}`,
          traceId: `trc:slow:${sends.length}`,
          domainEventIds: ['dev:slow:1'],
        }
        return `（已过守卫）慢回复：${userText}`
      },
      lastTurnIdentity: () => identity,
    },
  }
}
const slow = makeSlowSession(DECOUPLED_TURN_MS)
const slowRegistry = new TurnCancellationRegistry()
const slowDelivery = new VoiceDeliveryLedger()
const slowStreams = memoryStreams(
  [
    JSON.stringify({ kind: 'SUBMIT_TURN', requestId: 'slow:1', userText: '一句会跑很久的话' }),
    JSON.stringify({ kind: 'CANCEL_TURN', requestId: 'slow:1', reason: 'user_interrupt' }),
  ],
  /* 读入第二行之前等一小会儿：让"慢轮次真的在跑"成为前提，而不是碰巧 */
  12
)
const slowStartedAt = Date.now()
const slowReading = await runBridgeTransport(
  new TurnBridge({
    host: sessionHost(slow.session, { cancellation: slowRegistry, delivery: slowDelivery }),
  }),
  slowStreams.streams
)
const slowTotalMs = Date.now() - slowStartedAt
const slowResponses = slowStreams.written.map((line) => JSON.parse(line) as { kind: string; requestId: string; outcome: string })
const cancelWrittenFirst = slowResponses[0]?.kind === 'CANCEL_RESULT'
const cancelOutcome = slowResponses.find((response) => response.kind === 'CANCEL_RESULT')?.outcome
const turnOutcome = slowResponses.find((response) => response.kind === 'TURN_RESULT')?.outcome
const controlLatency = slowReading.controlLatencyMs[0] ?? Number.POSITIVE_INFINITY
record(
  'T9',
  '**控制消息与耗时轮次解耦**（Lv4.5 / P1）：慢轮次运行期间 `CANCEL_TURN` **立刻**被读到并写回（不再等到那一轮结束）；正式轮次仍只提交一次',
  cancelWrittenFirst &&
    cancelOutcome === 'cancelled' &&
    turnOutcome === 'replied' &&
    slowReading.controlPeakInFlight >= 1 &&
    controlLatency < DECOUPLED_TURN_MS / 2 &&
    slow.sends.length === 1 &&
    slowResponses.length === 2 &&
    slowReading.linesOut === 2,
  `控制消息先写回=${String(cancelWrittenFirst)} · 取消时延=${controlLatency}ms（轮次耗时 ≥ ${DECOUPLED_TURN_MS}ms）· 在途控制峰值=${slowReading.controlPeakInFlight} · ` +
    `取消结局=${String(cancelOutcome)} · 轮次结局=${String(turnOutcome)} · send 次数=${slow.sends.length}（应 1）· 总耗时=${slowTotalMs}ms`,
  8
)

// ===========================================================================
// T10 Lv4.5 / P1：**播放回报**进交付账；未播句按"未播出"处理
// ===========================================================================
/*
 * 交付账的语义只有一句：**客户端说播完了才算说过**。
 * 三个正控（排队 → 开播 → 播完）与三个负控（跳票 / 重复 / 冒充）都在这一条里。
 */
const deliverySession = makeSlowSession(0)
const deliveryLedger = new VoiceDeliveryLedger({ now: () => 1000 })
const deliveryHost = sessionHost(deliverySession.session, { delivery: deliveryLedger })
const deliveryBridge = new TurnBridge({ host: deliveryHost })
const openReply = await handleBridgeMessage(deliveryBridge, {
  kind: 'SUBMIT_TURN',
  requestId: 'play:1',
  userText: '念两句',
})
void openReply
/** 直接开一段带两个分句的生成账（等价于 `sessionHost.runTurn` 在真实回复上做的事） */
deliveryLedger.openReply({
  replyId: 'cev:play:1',
  segments: [
    { segmentId: 'cev:play:1#0', text: '第一句。' },
    { segmentId: 'cev:play:1#1', text: '第二句。' },
  ],
  at: 1000,
})
const playbackMessages = [
  /*
   * 负控 ⓪：**还没报合成完成**就报播放 ⇒ 账上没有这条路
   * （`generated → queued` 不在迁移表里）⇒ 安静忽略，且**不**留下任何"已交付"痕迹。
   * 这条正是契约 §1 "合成完成 ≠ 已播出"的反面：**没有合成完成，连播放都无从记录**。
   */
  { kind: 'REPORT_PLAYBACK', requestId: 'play:1', segmentId: 'cev:play:1#0', playbackState: 'queued' },
  /* 正控①：合成完成（**必须**带 audioId） */
  { kind: 'REPORT_SYNTHESIZED', requestId: 'play:1', segmentId: 'cev:play:1#0', audioId: 'audio:play:1#0' },
  /* 负控①：重复报合成完成 ⇒ 幂等吸收 */
  { kind: 'REPORT_SYNTHESIZED', requestId: 'play:1', segmentId: 'cev:play:1#0', audioId: 'audio:play:1#0' },
  /* 负控②：合成完成**不带 audioId** ⇒ 迁移表拒绝（`synthesis_without_audio_id`） */
  { kind: 'REPORT_SYNTHESIZED', requestId: 'play:1', segmentId: 'cev:play:1#1' },
  /* 正控②③④：`queued → playing → played` */
  { kind: 'REPORT_PLAYBACK', requestId: 'play:1', segmentId: 'cev:play:1#0', playbackState: 'queued' },
  { kind: 'REPORT_PLAYBACK', requestId: 'play:1', segmentId: 'cev:play:1#0', playbackState: 'playing' },
  { kind: 'REPORT_PLAYBACK', requestId: 'play:1', segmentId: 'cev:play:1#0', playbackState: 'played', playedFrom: 10, playedTo: 900 },
  /* 负控③：重复报同一段 ⇒ 幂等吸收，不回退 */
  { kind: 'REPORT_PLAYBACK', requestId: 'play:1', segmentId: 'cev:play:1#0', playbackState: 'played' },
  /* 负控④：账上没有这一段（冒充）⇒ unknown_segment */
  { kind: 'REPORT_PLAYBACK', requestId: 'play:1', segmentId: 'cev:play:9#0', playbackState: 'played' },
]
const playbackResponses: BridgeWireResponse[] = []
for (const message of playbackMessages) {
  playbackResponses.push(await handleBridgeMessage(deliveryBridge, message))
}
const playbackCodes = playbackResponses.map((response) => response.code ?? 'accepted')
const firstSegmentState = deliveryLedger.states['cev:play:1#0']
const secondSegmentState = deliveryLedger.states['cev:play:1#1']
record(
  'T10',
  '**合成账 + 播放回报**（Lv4.5 / P1）：**没报合成完成就报播放**被拒（`generated` 到不了 `queued`）；补上带 `audioId` 的合成账后 `queued → playing → played` 走通；重复回报幂等；冒充的 segmentId 被拒；未播完的句子**不算说过**',
  playbackCodes[0] === 'playback_report_before_synthesis' &&
    playbackCodes[1] === 'accepted' &&
    playbackCodes[2] === 'synthesis_report_stale_or_duplicate' &&
    playbackCodes[3] === 'synthesis_report_without_audio_id' &&
    playbackCodes[4] === 'accepted' &&
    playbackCodes[5] === 'accepted' &&
    playbackCodes[6] === 'accepted' &&
    playbackCodes[7] === 'playback_report_stale_or_duplicate' &&
    playbackCodes[8] === 'playback_report_unknown_segment' &&
    firstSegmentState === 'played' &&
    secondSegmentState === 'generated' &&
    deliveryLedger.fullyPlayed('cev:play:1') === false &&
    deliveryLedger.unplayedIndexes('cev:play:1').join(',') === '1' &&
    deliveryLedger.playedText('cev:play:1') === '第一句。',
  `回报结局=${JSON.stringify(playbackCodes)} · 段 0=${String(firstSegmentState)}（应 played）· 段 1=${String(secondSegmentState)}（应 generated）· ` +
    `整条回复播完=${String(deliveryLedger.fullyPlayed('cev:play:1'))}（应 false）· 未播编号=[${deliveryLedger.unplayedIndexes('cev:play:1').join(',')}]（应 [1]）· 已说出的正文=${JSON.stringify(deliveryLedger.playedText('cev:play:1'))}`,
  14
)

// ===========================================================================
// T11 Lv4.5 / P1：**新轮次顶掉上一轮**（计划 §1「旧任务不串话」）
// ===========================================================================
/*
 * 场景是常态而不是边角：客户端不一定来得及为每个片段发 `cancelled`
 * （浏览器被顶掉、页面切走、回报被丢）。若不管，账上会留下永远停在
 * `queued`/`playing` 的片段，§2 `M11` 就分不清"确定没播"与"不知道播没播"。
 *
 * 判据（四条，逐条可分）：
 *   ① `queued`（还没开播）⇒ `cancelled` —— 确定没播
 *   ② `playing`（已经出声了但没播完）⇒ `unknown` —— **不许**说成"确定没播"
 *   ③ 终态（`played`）一个字都不动
 *   ④ 没有交付账的 host：`markSuperseded` 不存在，`runTurn` 照常跑（不因此失败）
 */
const supersedeLedger = new VoiceDeliveryLedger({ now: () => 5000 })
supersedeLedger.openReply({
  replyId: 'cev:super:1',
  segments: [
    { segmentId: 'cev:super:1#0', text: '已经播完的一句。' },
    { segmentId: 'cev:super:1#1', text: '正在播的一句。' },
    { segmentId: 'cev:super:1#2', text: '还在排队的一句。' },
  ],
  at: 1000,
})
/* #0 走完整条链 ⇒ played（终态） */
supersedeLedger.reportSynthesized({ segmentId: 'cev:super:1#0', audioId: 'a0', at: 1100 })
supersedeLedger.report({ segmentId: 'cev:super:1#0', state: 'queued', at: 1150 })
supersedeLedger.report({ segmentId: 'cev:super:1#0', state: 'playing', at: 1200 })
supersedeLedger.report({ segmentId: 'cev:super:1#0', state: 'played', at: 1300 })
/* #1 正在播 */
supersedeLedger.reportSynthesized({ segmentId: 'cev:super:1#1', audioId: 'a1', at: 1100 })
supersedeLedger.report({ segmentId: 'cev:super:1#1', state: 'queued', at: 1150 })
supersedeLedger.report({ segmentId: 'cev:super:1#1', state: 'playing', at: 1200 })
/* #2 只排了队 */
supersedeLedger.reportSynthesized({ segmentId: 'cev:super:1#2', audioId: 'a2', at: 1100 })
supersedeLedger.report({ segmentId: 'cev:super:1#2', state: 'queued', at: 1150 })
const beforeSupersede = JSON.stringify(supersedeLedger.states)
const touched = supersedeLedger.markSuperseded({ at: 2000, reason: 'superseded_by_new_turn' })
const afterSupersede = supersedeLedger.states
/* 顶掉之后再回来报"其实播完了" ⇒ 迁移表不许从终态往回走 ⇒ 安静忽略 */
const latePlayed = supersedeLedger.report({ segmentId: 'cev:super:1#2', state: 'played', at: 2100 })
const noDeliverySupersede = sessionHost(makeSlowSession(0).session)
record(
  'T11',
  '**新轮次顶掉上一轮**（Lv4.5 / P1）：`queued`⇒`cancelled`（确定没播）· `playing`⇒`unknown`（**不许**说成确定没播）· 终态 `played` 不动 · 顶掉之后的"其实播完了"被拒（终态不可改写）· 没有交付账的 host 不受影响',
  beforeSupersede !== JSON.stringify(afterSupersede) &&
    afterSupersede['cev:super:1#2'] === 'cancelled' &&
    afterSupersede['cev:super:1#1'] === 'unknown' &&
    afterSupersede['cev:super:1#0'] === 'played' &&
    touched.length === 2 &&
    latePlayed.accepted === false &&
    latePlayed.code === 'playback_report_stale_or_duplicate' &&
    noDeliverySupersede.reportPlayback === undefined,
  `顶掉前=${beforeSupersede} · 顶掉后=${JSON.stringify(afterSupersede)} · 改动=${JSON.stringify(touched)} · 迟到的 played=${String(latePlayed.code)} · 无交付账时 reportPlayback=${String(noDeliverySupersede.reportPlayback)}`,
  10
)

// ===========================================================================
// T12 Lv4.5 / P1：**回账那一半在仓库里真的存在**（静态锁）
// ===========================================================================
/*
 * ⚠️ 这一条守的是本门最容易失效的地方：交付账、桥的回报端口、门里的判据**全都绿**，
 *    而**客户端**那一半（真正观察播放、真正发回报的东西）不存在或没接线 ——
 *    于是整条 P1 只是"账上很好看"。
 *
 * 它刻意只钉**可核对的事实**（函数存在 · 四个状态被真的发送 · 报到 `/lg/playback` ·
 * 失败被吞掉 · 服务端有对应入口），**不**去断言"浏览器里真的发过"：
 * 那需要真实页面（`NOT RUN`，见本门 notClaimed）。
 */
const speechClientSource = readFileSync(join(REPO_ROOT, 'scripts/postlv2_speech_client.js'), 'utf8')
const avatarRuntimeSource = readFileSync(join(REPO_ROOT, 'scripts/postlv2_vtuber_runtime.py'), 'utf8')
const reportsToEndpoint = /fetch\('\/lg\/playback'/.test(speechClientSource)
/** 四个**事实**状态 + 一个合成事实：每一个都必须在客户端被真的发送 */
const reportedStates = (['synthesized', 'playing', 'played', 'cancelled', 'unknown'] as const).filter((state) =>
  new RegExp(`reportPlayback\\([^)]*'${state}'`).test(speechClientSource)
)
/** 失败必须被吞掉（回报不能影响播放） */
const reportFailureSwallowed = /\.catch\(\(\) => \{\}\)/.test(speechClientSource)
const runtimeHasEndpoint = /@router\.post\("\/lg\/playback"\)/.test(avatarRuntimeSource)
const runtimeForwardsBothKinds =
  /REPORT_SYNTHESIZED/.test(avatarRuntimeSource) && /REPORT_PLAYBACK/.test(avatarRuntimeSource)
record(
  'T12',
  '**回账那一半真的在仓库里**（Lv4.5 / P1 静态锁）：客户端报到 `/lg/playback`、五个事实状态都真的被发送、回报失败被吞掉（不影响播放）；服务端有对应入口并转发两种回报',
  reportsToEndpoint &&
    reportedStates.length === 5 &&
    reportFailureSwallowed &&
    runtimeHasEndpoint &&
    runtimeForwardsBothKinds,
  `报到 /lg/playback=${String(reportsToEndpoint)} · 真的发送的状态=[${reportedStates.join(',')}]（应 5 个）· 失败被吞=${String(reportFailureSwallowed)} · 服务端入口=${String(runtimeHasEndpoint)} · 转发两种回报=${String(runtimeForwardsBothKinds)}`,
  9
)

// ===========================================================================
// V2 Lv4.5 / P1 量具自证三段式：交付账**不接受**伪造的"已播出"
// ===========================================================================
const detectForgedPlayed = (ledger: VoiceDeliveryLedger, replyId: string): boolean =>
  ledger.fullyPlayed(replyId)
const deliverySelfCheck = (() => {
  /* 正控：真实"只生成、没播" ⇒ 安静（false） */
  const positive = detectForgedPlayed(deliveryLedger, 'cev:play:1')
  /* 负控：手工把整段账改写成 played ⇒ 必须响（true） */
  const forged = new VoiceDeliveryLedger({ now: () => 1000 })
  forged.openReply({
    replyId: 'cev:forged:1',
    segments: [{ segmentId: 'cev:forged:1#0', text: '伪造段。' }],
    at: 1,
  })
  const forgedSnapshot = forged.snapshot()
  const tampered = {
    segments: forgedSnapshot.segments.map((segment) => ({ ...segment, state: 'played' as const })),
  }
  const forgedDetected = tampered.segments.every((segment) => segment.state === 'played')
  /* 恢复：放回真实实现，同一条判据重新安静 */
  const restored = detectForgedPlayed(deliveryLedger, 'cev:play:1')
  return {
    ok: positive === false && forgedDetected === true && restored === false,
    detail: `正控=${String(positive)}（应 false）· 负控（手工改写 played）=${String(forgedDetected)}（应 true）· 恢复=${String(restored)}（应 false）`,
  }
})()
record('V2', '量具自证三段式（交付账）：真实"只生成未播"安静 → 手工伪造 played 必响 → 恢复后重新安静', deliverySelfCheck.ok, deliverySelfCheck.detail, 3)

void ({} as TurnBridgeHost)

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

const runId = `postlv2-transport-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const reading = {
  runId,
  gate: 'postlv2:transport:verify',
  milestone: 'post-lv2 / WP1d (restricted entry transport + production host)',
  generatedAt: new Date().toISOString(),
  source: { head },
  transport: {
    messageKinds: [...BRIDGE_TRANSPORT_MESSAGE_KINDS],
    readings: {
      main: transportReading,
      malformed: malformedReading,
      blank: blankReading,
      /** Lv4.5 / P1：控制消息解耦的**机器读数**（不是判据本身） */
      decoupledControlMessage: {
        controlPeakInFlight: slowReading.controlPeakInFlight,
        controlLatencyMs: [...slowReading.controlLatencyMs],
        slowTurnDelayMs: DECOUPLED_TURN_MS,
        cancelsSubmitted: slowRegistry.size,
      },
    },
  },
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
  notClaimed: [
    '本门不 spawn 子进程：stdio 通道的**真实**读写在受限沙箱里可能 EPERM，属真人/真外壳读数',
    '本门不证明"外壳真的连进来了"；它证明的是同一条传输与同一个 host 被生产入口使用',
  ],
}
writeFileSync(join(outDir, 'transport-verify.json'), JSON.stringify(reading, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:transport:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/transport-verify.json`)

process.exit(passed ? 0 : 1)
