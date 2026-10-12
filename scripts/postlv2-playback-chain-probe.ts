/**
 * Lv4.5 / P1 —— **回账链路端到端探针**（隔离库 + 真皮套服务 + 真 TTS）。
 *
 * ============================================================================
 *  它证明什么、不证明什么
 * ============================================================================
 * 证明（一条**真实**的链路，不是 mock）：
 * ```text
 *   真 LG 轮次 ⇒ 真皮套服务 ⇒ 真 CosyVoice3 合成 ⇒ 带 replyId/segmentId 的音频包
 *   ⇒ 按**客户端事实**的顺序回报给 /lg/playback
 *   ⇒ LG 交付账**受理**（不是 unknown_segment / before_synthesis）
 * ```
 * **不**证明：浏览器里真的发生了一次播放（那要真人说话 + 真声卡。
 * 浏览器那一半由 `scripts/postlv2-streaming-verify.mjs` 在真播放器 + 模拟时钟上单独验）。
 *
 * ⚠️ 本探针**只连本机已启动的测试入口**（默认 12393）。它**不**启动服务、**不**打开数据库、
 *    **不**碰真实库 —— 库是皮套服务自己在隔离副本里开的（`postlv2-bridge-sandbox.ts`）。
 */

export {}

const PORT = Number(process.env.LG_AVATAR_PORT ?? 12393)
const BASE = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/client-ws`

const USER_TEXT = process.env.LG_PROBE_TEXT ?? '用一句话告诉我你现在能听见我吗'
const TIMEOUT_MS = 180_000

interface AudioChunk {
  type: string
  audio?: string
  index?: number
  final?: boolean
  failed?: boolean
  sample_rate?: number
  display_text?: { text?: string }
  actions?: { lg_expression?: { segmentId?: string; replyId?: string; requestId?: string; text_sha256?: string } }
}

const readStatus = async (): Promise<any> => (await fetch(`${BASE}/lg/status`)).json()

const postReport = async (body: Record<string, unknown>): Promise<any> => {
  const response = await fetch(`${BASE}/lg/playback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await response.json()
}

/** 送一轮真实输入，收集按 segmentId 分组的音频包（**不做**任何"猜测播出"的事） */
async function runTurn(): Promise<{ segments: Map<string, { chunks: number; final: boolean; replyId: string; requestId: string }>; order: string[] }> {
  const segments = new Map<string, { chunks: number; final: boolean; replyId: string; requestId: string }>()
  const order: string[] = []
  const socket = new WebSocket(WS_URL)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* 收尾 */ }
      reject(new Error(`回账探针超时（${TIMEOUT_MS}ms）：没等到音频包`))
    }, TIMEOUT_MS)
    const done = (): void => {
      clearTimeout(timer)
      try { socket.close() } catch { /* 收尾 */ }
      resolve({ segments, order })
    }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'text-input', text: USER_TEXT }))
    })
    socket.addEventListener('message', (event) => {
      let packet: AudioChunk
      try {
        packet = JSON.parse(String(event.data)) as AudioChunk
      } catch {
        return
      }
      if (packet.type !== 'lg-audio-chunk') return
      const meta = packet.actions?.lg_expression
      const segmentId = meta?.segmentId
      if (typeof segmentId !== 'string') return
      const entry = segments.get(segmentId) ?? {
        chunks: 0,
        final: false,
        replyId: String(meta?.replyId ?? ''),
        requestId: String(meta?.requestId ?? ''),
      }
      entry.chunks += packet.audio ? 1 : 0
      entry.final ||= packet.final === true
      if (!segments.has(segmentId)) order.push(segmentId)
      segments.set(segmentId, entry)
      /* 一句的收尾包到了 ⇒ 等一小会儿让后面的句子也到齐 */
      if (order.length > 0 && [...segments.values()].every((item) => item.final)) {
        setTimeout(done, 1500)
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('连不上皮套服务的 /client-ws'))
    })
  })
}

const before = await readStatus()
console.log(`[probe] 服务：mode=${before.mode} speaker=${before.speaker} lg_alive=${before.lg_process_alive}`)
console.log(`[probe] 回报计数（前）：${JSON.stringify(before.playback_reports)}`)

const { segments, order } = await runTurn()
console.log(`[probe] 收到 ${segments.size} 段音频：`)
for (const segmentId of order) {
  const entry = segments.get(segmentId)!
  console.log(`  · ${segmentId} chunks=${entry.chunks} final=${entry.final} replyId=${entry.replyId}`)
}

/*
 * 按**客户端事实**的顺序回报：合成完成（带 audioId）⇒ 排队 ⇒ 开播 ⇒ 播完。
 * ⚠️ 这正是浏览器那一半会在什么时刻发什么 —— 探针不替它做任何判断。
 */
const readings: { segmentId: string; state: string; verdict: unknown }[] = []
const report = async (segmentId: string, state: string, extra: Record<string, unknown> = {}): Promise<void> => {
  const entry = segments.get(segmentId)!
  const verdict = await postReport({
    segmentId,
    state,
    requestId: entry.requestId,
    ...(state === 'synthesized' ? { audioId: `${segmentId}@${(entry.chunks).toString(16)}` } : {}),
    ...extra,
  })
  readings.push({ segmentId, state, verdict })
  console.log(`  → ${segmentId} ${state} ⇒ ${JSON.stringify(verdict)}`)
}

for (const segmentId of order) {
  await report(segmentId, 'synthesized')
  await report(segmentId, 'queued')
  await report(segmentId, 'playing')
  await report(segmentId, 'played', { playedFrom: 0, playedTo: 500 })
}

const after = await readStatus()
console.log(`[probe] 回报计数（后）：${JSON.stringify(after.playback_reports)}`)
console.log(`[probe] 合成账判决：${JSON.stringify(after.synthesis_verdicts)}`)

const accepted = readings.filter((item) => (item.verdict as { outcome?: string }).outcome === 'accepted').length
const rejected = readings.filter((item) => (item.verdict as { outcome?: string }).outcome === 'rejected')
const reading = {
  probe: 'Lv4.5 P1 playback-report chain (in-process, real service)',
  port: PORT,
  userText: USER_TEXT,
  segments: order.map((segmentId) => ({ segmentId, ...segments.get(segmentId)! })),
  reports: readings,
  acceptedCount: accepted,
  rejectedCount: rejected.length,
  rejectedCodes: rejected.map((item) => `${item.segmentId}:${item.state}:${String((item.verdict as { code?: string }).code)}`),
  countersBefore: before.playback_reports,
  countersAfter: after.playback_reports,
  verdict: rejected.length === 0 && accepted >= order.length * 4 ? 'PASS' : 'FAIL',
  notClaimed: [
    '浏览器里真的发生了一次播放：NOT RUN（要真人说话 + 真声卡）',
    '不主张音频被"听见"：这里的 played 是探针按客户端事实顺序发的，播放器那一半由 postlv2-streaming-verify.mjs 单独验',
  ],
}
console.log('')
console.log(JSON.stringify(reading, null, 2))
process.exit(reading.verdict === 'PASS' ? 0 : 1)
