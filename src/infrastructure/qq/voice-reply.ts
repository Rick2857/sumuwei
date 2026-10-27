/**
 * QQ 语音输出的**受信端口**与硬边界（post-Lv2 / P1 接点，P2 接真实 TTS）。
 *
 * ============================================================================
 *  边界写在这里的理由
 * ============================================================================
 * ```text
 * 模型只选"这条回复用文字还是语音"（见 qq-media-reply 契约）
 * 合成器只做"给定最终正文 → 一段完整 WAV"
 * 外壳只做"结构校验 → record 段 → 既有串行队列 → 既有身份检查"
 * ```
 * ⚠️ 三条都不越界：合成器**不能**选音色对应的会话、**不能**给 URL/路径、
 *    外壳**不**按字数或情绪再判一次要不要发语音。
 *
 * ⚠️ 初拟技术边界（计划 §4.2：**待组件实测校准**，不是 QQ 标准保证）：
 *    完整 WAV、PCM16、单声道优先、≤ 60 s、≤ 4 MiB、合成等待 ≤ 30 s。
 *    超限**不截断答案、不自行概括**：如实记录并按失败规则回落到文字。
 */
import { Buffer } from 'node:buffer'

export const QQ_VOICE_LIMITS = Object.freeze({
  /** 一条语音消息的字节上界（计划 §4.2：4 MiB） */
  maxAudioBytes: 4 * 1024 * 1024,
  /** 一条语音消息的时长上界（计划 §4.2：60 s） */
  maxDurationMs: 60_000,
  /** 合成等待上界（计划 §4.2：初拟 30 s，待实测校准） */
  maxSynthesisMs: 30_000,
  /** 可接受的采样率范围（16 kHz 的旧本地模型也算合法，24 kHz 优先但不是硬要求） */
  minSampleRateHz: 8_000,
  maxSampleRateHz: 48_000,
  /** 优先但不唯一：单声道 PCM16（立体声只放宽到 2 声道） */
  maxChannels: 2,
  bitsPerSample: 16,
})

/** 合成器的产出：**完整 WAV 字节**（不是 URL、不是路径） */
export interface QqVoiceSynthesisResult {
  audio: Uint8Array
  format: 'wav'
  providerRequestId?: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; characters?: number }
}

/**
 * TTS 端口（由装配层注入；**不装 = 没有这个能力**）。
 *
 * ⚠️ 端口不读配置、不选音色、不改正文：正文是**已经过回复守卫**的最终文本。
 * ⚠️ `deadlineMs` 是外壳给的**等待上限**；实现可以不看它，但外壳仍会按它放弃等待。
 */
export interface QqVoiceSynthesizer {
  synthesize(input: { text: string; deadlineMs: number; signal?: AbortSignal }): Promise<QqVoiceSynthesisResult>
}

export interface QqVoiceOutput {
  synthesizer: QqVoiceSynthesizer
}

/** WAV 结构读数（只用于校验与读数；**不含正文**） */
export interface WavInspection {
  sampleRateHz: number
  channels: number
  bitsPerSample: number
  durationMs: number
  dataBytes: number
  totalBytes: number
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

/**
 * 检查一段字节是不是**能发出去的** WAV（结构读数；不合法 ⇒ `undefined`）。
 *
 * 判据只有结构，不看内容：RIFF/WAVE 头、`fmt ` 与 `data` 块、PCM16、
 * 声道 1–2、采样率 8–48 kHz、时长可由字节算出且 > 0。
 */
export function inspectWav(audio: Uint8Array): WavInspection | undefined {
  if (!(audio instanceof Uint8Array) || audio.byteLength < 44) return undefined
  if (fourCc(audio, 0) !== 'RIFF' || fourCc(audio, 8) !== 'WAVE') return undefined
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  /* chunk 遍历必须**有界**：损坏的 size 字段不得让我们越界读或死循环 */
  let offset = 12
  let format: { audioFormat: number; channels: number; sampleRateHz: number; bitsPerSample: number } | undefined
  let dataBytes: number | undefined
  while (offset + 8 <= audio.byteLength) {
    const id = fourCc(audio, offset)
    const size = u32(view, offset + 4)
    const body = offset + 8
    if (body + size > audio.byteLength) {
      /* `data` 块允许 size 大于实际（流式写出），但只接受实际剩余字节 */
      if (id === 'data') { dataBytes = audio.byteLength - body; break }
      return undefined
    }
    if (id === 'fmt ') {
      if (size < 16) return undefined
      format = {
        audioFormat: u16(view, body),
        channels: u16(view, body + 2),
        sampleRateHz: u32(view, body + 4),
        bitsPerSample: u16(view, body + 14),
      }
    } else if (id === 'data') {
      dataBytes = size
      break
    }
    offset = body + size + (size % 2)
  }
  if (format === undefined || dataBytes === undefined) return undefined
  if (format.audioFormat !== 1) return undefined
  if (format.bitsPerSample !== QQ_VOICE_LIMITS.bitsPerSample) return undefined
  if (format.channels < 1 || format.channels > QQ_VOICE_LIMITS.maxChannels) return undefined
  if (format.sampleRateHz < QQ_VOICE_LIMITS.minSampleRateHz || format.sampleRateHz > QQ_VOICE_LIMITS.maxSampleRateHz) return undefined
  if (dataBytes <= 0) return undefined
  const bytesPerSecond = format.sampleRateHz * format.channels * (format.bitsPerSample / 8)
  const durationMs = Math.round((dataBytes / bytesPerSecond) * 1000)
  if (durationMs <= 0) return undefined
  return {
    sampleRateHz: format.sampleRateHz,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    durationMs,
    dataBytes,
    totalBytes: audio.byteLength,
  }
}

/**
 * 这段音频**能不能按计划发出去**（失败关闭，返回具名原因）。
 *
 * ⚠️ 原因码进日志与读数，**不带正文/音频字节**。
 */
export function wavDeliveryProblem(audio: Uint8Array): string | undefined {
  if (!(audio instanceof Uint8Array)) return 'voice_audio_not_bytes'
  if (audio.byteLength === 0) return 'voice_audio_empty'
  if (audio.byteLength > QQ_VOICE_LIMITS.maxAudioBytes) return 'voice_audio_too_large'
  const inspection = inspectWav(audio)
  if (inspection === undefined) return 'voice_audio_not_wav_pcm16'
  if (inspection.durationMs > QQ_VOICE_LIMITS.maxDurationMs) return 'voice_audio_too_long'
  return undefined
}

/**
 * OneBot 语音段的 `file` 值：`base64://<base64>`。
 *
 * ⚠️ 走 Base64 而不是宿主路径：宿主/容器路径不一致会让后端读不到，
 *    而开一个公开下载口是另一件事（计划 §4.2）。
 */
export function oneBotRecordFileUrl(audio: Uint8Array): string {
  return `base64://${Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString('base64')}`
}
