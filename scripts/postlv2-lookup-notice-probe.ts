/**
 * Lv4.5 / `P3`（选项 B）—— **边听边查**的真链路探针。
 *
 * ============================================================================
 *  它要回答的那一个问题
 * ============================================================================
 * 门（`B20`/`B21`）证明的是**判据的形状**：词形、时机、去重、来源翻译。
 * 它们**没有**证明一件事：**在真实链路里，那一句"查到了。"到底会不会出现**。
 *
 * ```text
 * ① 先发一条 text-input 让她开始说话（她的音频开始在播）
 * ② **在她还在说的时候**把"帮我搜一下明天的天气"按网页的方式喂进麦克风
 *    （partial 里出现**显式检索词形** ⇒ 桥发起提前检索）
 * ③ 看回来的包里有没有 `requestId` 以 `interjection` 开头的短句，文本是不是"查到了。"
 * ```
 *
 * ⚠️ 这一条**要花一次真实出站检索**（Tavily 一次 credit）+ 一次真实模型调用。
 * ⚠️ 它**可能合理地不响**：若检索在她说完之后才回来，判据是"她没在说 ⇒ 不说"
 *    （那是**设计**，不是失败）。所以读数里必须能看到**原因**：
 *    外壳的 `interjection.dropped` 会带上具名理由码（如 `lookup_notice_she_is_not_speaking`）
 *    ⇒ 探针据此区分"没触发 / 时机不成立 / 真的投递了"三种情况，而不是只报"没有"。
 *
 * 用法： `npx tsx scripts/postlv2-lookup-notice-probe.ts`
 *   · `LG_LOOKUP_WAV`   语料（缺省 `artifacts/post-lv2/local/lookup-phrase-20261005.wav`）
 *   · `LG_LOOKUP_PRELUDE` 先发的那句话（缺省让她说三句 ⇒ 音频窗口更长）
 *   · `LG_LOOKUP_WAIT_MS` 尾部等待（缺省 12000：要等"出站检索 + 合成 + 分包"）
 */

export {}

import { readFileSync } from 'node:fs'

const PORT = Number(process.env.LG_AVATAR_PORT ?? 12393)
const BASE = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/client-ws`
const WAV = process.env.LG_LOOKUP_WAV ?? 'artifacts/post-lv2/local/lookup-phrase-20261005.wav'
const PRELUDE_RAW = process.env.LG_LOOKUP_PRELUDE ?? '用三句话说说你今天的心情，每句都短一点。'
/**
 * ⚠️ `LG_LOOKUP_PRELUDE=NONE` = **不起轮次**（零模型调用）。
 *    用途：隔离"只喂语音时，提前检索到底跑不跑" —— 起轮次会同时引入
 *    "她是否在说"与"轮次并发"两个变量，混在一起就分不清是哪一个是原因。
 *    （不能用空字符串：PowerShell 里 `$env:X = ""` 会**删掉**变量，而不是置空 —— 实测踩到。）
 */
const PRELUDE = PRELUDE_RAW === 'NONE' ? '' : PRELUDE_RAW
/** 网页每块发的样本数（与上游一致） */
const CHUNK_SAMPLES = 1000
const CHUNK_GAP_MS = Number(process.env.LG_LOOKUP_GAP_MS ?? 30)
/**
 * ⚠️ 尾部等待要**同时**覆盖"先说话"与"出站检索"两段：
 *    她在说（几秒）→ partial → 检索（实测 2–8s）→ 判据 → 合成 → 分包。
 *    太短会把"还没合成完"读成"没投递"（这个坑在 partial 探针上踩过一次）。
 */
const TAIL_WAIT_MS = Number(process.env.LG_LOOKUP_WAIT_MS ?? 12_000)

function readWav(path: string): { samples: Float32Array; sampleRate: number } {
  const buffer = readFileSync(path)
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

const readStatus = async (): Promise<Record<string, any>> => await (await fetch(`${BASE}/lg/status`)).json()

const { samples, sampleRate } = readWav(WAV)
const before = await readStatus()
if (before.lg_process_alive !== true) {
  console.error('服务没在跑（/lg/status 说 lg_process_alive != true）')
  process.exit(1)
}
const beforeInterjection = { ...(before.interjection ?? {}) }
console.log(
  `[lookup] 语料=${WAV.split(/[\\/]/).pop()} ${(samples.length / sampleRate).toFixed(2)}s @${String(sampleRate)}Hz`
)
console.log(`[lookup] 前置语：${PRELUDE}`)
console.log(
  `[lookup] 起点读数：started=${String(beforeInterjection.started)} spoken=${String(beforeInterjection.spoken)} dropped=${String(beforeInterjection.dropped)}`
)

interface SeenPacket {
  at: number
  type: string
  requestId?: string
  text?: string
  segmentId?: string
  displayText?: string
  bytes?: number
}

const seen: SeenPacket[] = []
/** partial 文本（用来确认"显式检索词形"真的出现过 —— 否则这条测试根本没到判据那一步） */
const partials: string[] = []
const selfUid: { value: string | null } = { value: null }
let audioMsAtFirstSpeech: number | null = null
/** 已经替哪个片段报过"合成账"（同一条只报一次） */
const reportedSynthesized = new Set<string>()
const reportSynthesized = (segmentId: string): void => {
  if (segmentId === '' || reportedSynthesized.has(segmentId)) return
  reportedSynthesized.add(segmentId)
  /*
   * ========================================================================
   *  为什么探针必须**像浏览器那样**报一条合成账
   * ========================================================================
   * "她正在说"读的是**交付账**，而交付账只由**客户端**的回报填充
   * （媒体交付契约 §1 第一条：服务端**不能**从"音频包发出去了"推断播出）。
   * ```text
   * 探针只收包、从不回报 ⇒ 交付账永远是空的 ⇒ hasUnplayed() 恒为 false
   *   ⇒ "边听边查"的时机判据**在探针里永远不成立**
   *     （实测：interjection.started=0 且 dropped=0，而 playback_reports 全是 0，
   *      真实浏览器会话里那两个计数器是有数的）
   * ```
   * ⚠️ 所以这里**只**报 `synthesized`（"音频确实存在且被交付了" —— 这件事探针**能**证明，
   *    那些字节就在它手上），**绝不**报 `playing`/`played`：那两个的意思是
   *    "声音真的从声卡出来了"，探针没有声卡输出，**证明不了** —— 报它们就是伪造证据。
   */
  void fetch(`${BASE}/lg/playback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    /*
     * ⚠️ `audioId` **必须**带：桥以 `synthesis_report_without_audio_id` 失败关闭
     *    （实测：不带时 playback.rejected 涨、synthesized 恒为 0，看起来像"回报没到"）。
     * 命名沿用**客户端那条既有约定**（`postlv2_speech_client.js`）：
     *    `${segmentId}@${text_sha256 前 12}`，没有 sha 时退化成 `${segmentId}@audio`。
     *    探针没有 sha（它不解析正文）⇒ 用后者，含义仍是"客户端观察到了这一段的音频"。
     */
    body: JSON.stringify({
      segmentId,
      state: 'synthesized',
      audioId: `${segmentId}@audio`,
      requestId: 'lookup-probe',
    }),
  }).catch(() => {})
}
const startedAt = performance.now()
let fedSamples = 0

const socket = new WebSocket(WS_URL)
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('探针超时')), 300_000)
  socket.addEventListener('open', () => {
    void (async () => {
      /* ① 先让她开始说话（这样"她正在说"才有机会成立） */
      if (PRELUDE !== '') socket.send(JSON.stringify({ type: 'text-input', text: PRELUDE }))
      /*
       * ② 等她的**第一块音频**到达（真在说了），再喂检索语音。
       *    ⚠️ 不能"发完就喂"：那时她的合成还没开始，`hasUnplayed()` 会是 false，
       *       于是判据必然不成立 —— 探针会自己把功能测没。
       *    ⚠️ `LG_LOOKUP_PRELUDE=''`（空前置语）**跳过这一段**：那是用来隔离另一个问题的
       *       ——"只喂语音、不起轮次时，提前检索到底跑不跑"（见 §隔离用法）。
       */
      if (PRELUDE === '') {
        console.log('[lookup] 空前置语 ⇒ 跳过"等她出声"，直接喂（用于隔离：不起轮次时检索跑不跑）')
      } else {
        const speechDeadline = performance.now() + 60_000
        while (audioMsAtFirstSpeech === null && performance.now() < speechDeadline) {
          await new Promise((r) => setTimeout(r, 200))
        }
        if (audioMsAtFirstSpeech === null) {
          console.error('[lookup] 等不到她的第一块音频（60s）⇒ 无法制造"她正在说"的时机')
        } else {
          console.log(`[lookup] 她开始出声（${String(audioMsAtFirstSpeech)}ms）⇒ 现在喂检索语音`)
        }
      }
      for (let offset = 0; offset < samples.length; offset += CHUNK_SAMPLES) {
        const chunk = Array.from(samples.subarray(offset, offset + CHUNK_SAMPLES))
        socket.send(JSON.stringify({ type: 'mic-audio-data', audio: chunk }))
        fedSamples += chunk.length
        if (CHUNK_GAP_MS > 0) await new Promise((r) => setTimeout(r, CHUNK_GAP_MS))
      }
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
      client_uid?: string
      display_text?: { text?: string }
      actions?: { lg_expression?: { segmentId?: string; requestId?: string } }
    }
    try {
      packet = JSON.parse(String(event.data)) as typeof packet
    } catch {
      return
    }
    if (packet.type === 'set-model-and-conf' && typeof packet.client_uid === 'string') {
      selfUid.value = packet.client_uid
      return
    }
    if (packet.type === 'lg-asr-partial') {
      partials.push(String(packet.text ?? ''))
      return
    }
    if (packet.type === 'lg-audio-chunk' && audioMsAtFirstSpeech === null) {
      audioMsAtFirstSpeech = Math.round(performance.now() - startedAt)
    }
    /* 探针像浏览器一样回报"这段音频存在"（只报 synthesized，理由见 `reportSynthesized`） */
    /*
     * ⚠️ 片段的 id 在 `actions.lg_expression.segmentId` 里，**不是**顶层 `segmentId`
     *    —— 实测踩到：读错位置 ⇒ 每次都拿到 undefined ⇒ 一条都没报上去，
     *    于是交付账仍是空的（表现与"探针不回报"完全一样，看不出是读错了字段）。
     */
    if (packet.type === 'lg-audio-chunk') {
      const segmentId = packet.actions?.lg_expression?.segmentId ?? packet.segmentId
      if (typeof segmentId === 'string') reportSynthesized(segmentId)
    }
    seen.push({
      at: Math.round(performance.now() - startedAt),
      type: String(packet.type ?? '?'),
      ...(packet.actions?.lg_expression?.requestId !== undefined
        ? { requestId: packet.actions.lg_expression.requestId }
        : {}),
      ...(packet.text !== undefined ? { text: packet.text } : {}),
      ...(packet.display_text?.text !== undefined ? { displayText: packet.display_text.text } : {}),
      ...(packet.segmentId !== undefined ? { segmentId: packet.segmentId } : {}),
      ...(packet.audio !== undefined ? { bytes: packet.audio.length } : {}),
    })
  })
  socket.addEventListener('error', () => reject(new Error('连不上 /client-ws')))
})
try { socket.close() } catch { /* 收尾 */ }
await new Promise((r) => setTimeout(r, 900))

const after = await readStatus()
const afterInterjection = { ...(after.interjection ?? {}) }
/**
 * 插话的音频块：`requestId` 以 `interjection` 开头的那一类。
 *
 * ⚠️ 这一层判据必须落在**音频**上（收到了块），而不是"服务端记了 spoken" ——
 *    后者只说明它调了 `speak()`，不说明音频真的过了这条 websocket。
 */
const noticeAudio = seen.filter((item) => item.type === 'lg-audio-chunk' && (item.requestId ?? '').startsWith('interjection'))
const noticeTurns = seen.filter((item) => item.type === 'lg-expression-turn' && (item.requestId ?? '').startsWith('interjection'))
/** 显式检索词形是否真的到过（没到 ⇒ 这条测试根本没走到判据） */
const EXPLICIT = /(帮我搜一下|搜索一下|搜一下|查一下|帮我查一下|搜索|搜一搜|联网查)/
const explicitPartials = partials.filter((text) => EXPLICIT.test(text))
const deliveredToUs = afterInterjection.last_client !== null && selfUid.value !== null
  ? String(afterInterjection.last_client) === selfUid.value.slice(0, 8)
  : null

const reading = {
  probe: 'Lv4.5 P3 option B - lookup-while-listening, on the real chain',
  wav: WAV,
  prelude: PRELUDE,
  selfUid: selfUid.value,
  explicitPartialsFound: explicitPartials,
  /** 她开始出声的时刻（= 我们喂检索语音的时刻） */
  firstSpeechAtMs: audioMsAtFirstSpeech,
  counts: {
    partials: partials.length,
    packets: seen.length,
    noticeTurns: noticeTurns.length,
    noticeAudioChunks: noticeAudio.length,
  },
  notice: {
    displayTexts: noticeAudio.map((item) => item.displayText ?? null),
    requestIds: [...new Set(noticeAudio.map((item) => item.requestId ?? null))],
  },
  serverReading: {
    startedBefore: beforeInterjection.started ?? null,
    startedAfter: afterInterjection.started ?? null,
    spokenBefore: beforeInterjection.spoken ?? null,
    spokenAfter: afterInterjection.spoken ?? null,
    droppedBefore: beforeInterjection.dropped ?? null,
    droppedAfter: afterInterjection.dropped ?? null,
    lastSource: afterInterjection.last_source ?? null,
    lastCode: afterInterjection.last_code ?? null,
    lastClient: afterInterjection.last_client ?? null,
  },
  deliveredToOurConnection: deliveredToUs,
  /**
   * ⚠️ **提前检索的结局**（随协议回来，不靠日志）。
   *
   * 它回答的是"探针看不到插话"时**最要紧**的那个分叉：
   * ```text
   * lookup_found       —— 查到了，但她没在说 ⇒ 判据**刻意**不说（设计）
   * lookup_not_found   —— 出站成功但没结果
   * lookup_rejected    —— 被策略拒 / 没登记
   * lookup_failed      —— 网关抛错（`lookup_last_code` 给具名理由）
   * （字段缺席）        —— 这次准备**根本没发起检索**（词形/能力/去重）
   * ```
   */
  lookupOutcome: {
    ...Object.fromEntries(Object.entries(after.partial?.prepare ?? {}).filter(([key]) => key.startsWith('lookup_'))),
  },
  verdict:
    noticeAudio.length > 0 && noticeAudio.some((item) => (item.displayText ?? '') === '查到了。')
      ? 'PASS'
      : explicitPartials.length === 0
        ? 'NOT RUN（显式检索词形一条都没到 ⇒ 没走到判据）'
        : (afterInterjection.lastCode ?? '') === 'lookup_notice_she_is_not_speaking'
          ? 'DESIGN（查到了但检索回来时她已说完 ⇒ 判据刻意不说）'
          : 'FAIL（词形到了、却既没有插话也没有具名理由）',
  notClaimed: [
    '这条读数**要花一次真实出站检索**（Tavily 一次 credit）',
    '它用**合成语音**而不是真人麦克风（合成音里"帮我搜一下"的识别率可能比真人高）',
    '探针关掉连接之后才读状态 ⇒ `spoken` 这类**收尾计数**可能滞后（归属看 `last_client`）',
  ],
}
console.log(JSON.stringify(reading, null, 2))
process.exit(reading.verdict === 'PASS' || reading.verdict.startsWith('DESIGN') ? 0 : 1)
