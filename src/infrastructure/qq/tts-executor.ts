/**
 * QQ 语音输出的**HTTP TTS 执行器**（post-Lv2 / P2；真实提供方在 P3 用真实账号校准）。
 *
 * ============================================================================
 *  它做什么 / 不做什么
 * ============================================================================
 * ```text
 * 做  ：把**已经过回复守卫的最终正文**发给配置好的 TTS 端点，拿回一段完整 WAV
 * 不做：选音色/改正文/概括/分句/重试/多提供商路由；不读正文写日志
 * ```
 * 支持原 OpenAI 兼容形状及显式 dashscope 协议（官方完整文本合成接口）。
 * 协议接通不等于账号/模型/音色验收；真实探针与真人试听另列。
 * ⚠️ 失败一律**抛具名错误**（外壳据此回落到文字并记原因）；不返回空音频、不返回 URL。
 * ⚠️ 只允许 https；**唯一例外**是本机 loopback http（门/本地服务用），
 *    且 URL 不得带凭据/查询参数（密钥走 Authorization 头）。
 */
import type { QqVoiceSynthesizer, QqVoiceSynthesisResult } from './voice-reply.ts'
import { QQ_VOICE_LIMITS } from './voice-reply.ts'

export interface QqTtsConfig {
  url: string
  apiKey: string
  model: string
  voice: string
  protocol?: 'openai' | 'dashscope' | 'qwen-tts'
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/

/**
 * 读配置（**全有或全无**，失败关闭）。
 *
 * ```text
 * 四个变量缺任一 / 形状非法 ⇒ 返回 undefined（= 外壳没有语音端口 ⇒ 语音回落文字）
 * 返回 undefined 时**不**打印任何变量值（密钥不落日志）。
 * ```
 */
export function readQqTtsConfig(env: NodeJS.ProcessEnv): QqTtsConfig | undefined {
  const url = (env.CHARACTER_QQ_TTS_URL ?? '').trim()
  const apiKey = (env.CHARACTER_QQ_TTS_API_KEY ?? '').trim()
  const model = (env.CHARACTER_QQ_TTS_MODEL ?? '').trim()
  const voice = (env.CHARACTER_QQ_TTS_VOICE ?? '').trim()
  const protocol = (env.CHARACTER_QQ_TTS_PROTOCOL ?? 'openai').trim()
  if (url === '' && apiKey === '' && model === '' && voice === '') return undefined
  if (url === '' || apiKey === '' || model === '' || voice === '') return undefined
  if (!SAFE_ID.test(model) || !SAFE_ID.test(voice)) return undefined
  if (!['openai', 'dashscope', 'qwen-tts'].includes(protocol)) return undefined
  if (apiKey.length < 8 || apiKey.length > 4096) return undefined
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return undefined
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return undefined
  return { url: parsed.href, apiKey, model, voice,
    ...(protocol === 'openai' ? {} : { protocol: protocol as 'dashscope' | 'qwen-tts' }) }
}

export interface HttpQqVoiceSynthesizerOptions {
  /** 注入 `fetch`（门用）；缺省用全局 fetch */
  fetchImpl?: typeof fetch
}

function bounded(value: unknown, limit: number): boolean {
  return typeof value === 'string' && value.trim() !== '' && [...value].length <= limit
}

/**
 * 读响应体，**有上界**（防止服务端返回超大 body 把宿主内存打满）。
 *
 * ⚠️ 超界立即 abort，报 `tts_response_too_large`；不做"先收下再说"。
 */
async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) throw new Error('tts_response_too_large')
  if (response.body === null) return new Uint8Array(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) throw new Error('tts_response_too_large')
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const audio = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength }
  return audio
}

/** Download provider audio only; never forward the synthesis credential to the file host. */
function audioUrlAllowed(url: URL, endpoint: URL): boolean {
  if (url.username || url.password || url.hash) return false
  if (url.origin === endpoint.origin) return true
  return url.protocol === 'https:' && /^[a-z0-9.-]+\.oss-(?:cn-beijing|cn-shanghai|ap-southeast-1)\.aliyuncs\.com$/i.test(url.hostname)
}

function usageOf(value: unknown): QqVoiceSynthesisResult['usage'] {
  if (!value || typeof value !== 'object') return undefined
  const result: NonNullable<QqVoiceSynthesisResult['usage']> = {}
  for (const [wire, key] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'],
    ['total_tokens', 'totalTokens'], ['characters', 'characters']] as const) {
    const count = (value as Record<string, unknown>)[wire]
    if (Number.isSafeInteger(count) && (count as number) >= 0) result[key] = count as number
  }
  return Object.keys(result).length ? result : undefined
}

/**
 * 一个 HTTP TTS 合成器（唯一一个"真实执行器"接点）。
 *
 * ⚠️ 端口契约与 P1 的假端口**完全相同**（`QqVoiceSynthesizer`）：
 *    外壳不区分"真假 TTS"，只按同一套结构校验/兜底规则走。
 */
export function createHttpQqVoiceSynthesizer(
  config: QqTtsConfig,
  options: HttpQqVoiceSynthesizerOptions = {},
): QqVoiceSynthesizer {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    async synthesize(input): Promise<QqVoiceSynthesisResult> {
      if (!bounded(input.text, config.protocol === 'qwen-tts' ? 600 : 8000)) throw new Error('tts_text_invalid')
      const deadline = Math.max(1, Math.min(QQ_VOICE_LIMITS.maxSynthesisMs, input.deadlineMs))
      const timeout = AbortSignal.timeout(deadline)
      const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout])
      let response: Response
      try {
        response = await fetchImpl(config.url, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            'content-type': 'application/json',
            accept: 'audio/wav, application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            ...(config.protocol === 'qwen-tts'
              ? { input: { text: input.text, voice: config.voice, language_type: 'Auto' } }
              : config.protocol === 'dashscope'
              ? { input: { text: input.text, voice: config.voice, format: 'wav', sample_rate: 24000 } }
              : { input: input.text, voice: config.voice, response_format: 'wav' }),
          }),
        })
      } catch (error) {
        /* 超时/取消/网络：只报具名族，不把正文带进消息 */
        if (signal.aborted) throw new Error(input.signal?.aborted === true ? 'tts_cancelled' : 'tts_timeout')
        throw new Error('tts_transport_failed')
      }
      if (!response.ok) throw new Error(`tts_http_${String(response.status)}`)
      const type = (response.headers.get('content-type') ?? '').toLowerCase()
      const maxBytes = QQ_VOICE_LIMITS.maxAudioBytes
      if (type.includes('application/json')) {
        const payload = await readBoundedBody(response, 8 * 1024 * 1024)
        let parsed: unknown
        try { parsed = JSON.parse(new TextDecoder().decode(payload)) } catch { throw new Error('tts_json_invalid') }
        if (config.protocol === 'dashscope' || config.protocol === 'qwen-tts') {
          const data = parsed as { request_id?: unknown; output?: { finish_reason?: unknown; audio?: { url?: unknown } }; usage?: unknown }
          if (data?.output?.finish_reason !== 'stop' || typeof data.output.audio?.url !== 'string') throw new Error('tts_json_without_audio')
          let url: URL
          try { url = new URL(data.output.audio.url) } catch { throw new Error('tts_audio_url_rejected') }
          // Official Qwen examples return HTTP OSS URLs; require HTTPS for the download.
          if (url.protocol === 'http:') {
            const secure = new URL(url); secure.protocol = 'https:'
            if (audioUrlAllowed(secure, new URL(config.url))) url = secure
          }
          if (!audioUrlAllowed(url, new URL(config.url))) throw new Error('tts_audio_url_rejected')
          let download: Response
          try { download = await fetchImpl(url, { redirect: 'error', signal, headers: { accept: 'audio/wav' } }) }
          catch { throw new Error(signal.aborted ? 'tts_timeout' : 'tts_audio_download_failed') }
          if (!download.ok) throw new Error(`tts_audio_http_${download.status}`)
          const audioType = download.headers.get('content-type') ?? ''
          if (!/^(audio\/|application\/octet-stream)/i.test(audioType)) throw new Error('tts_content_type_unexpected')
          const usage = usageOf(data.usage)
          return { audio: await readBoundedBody(download, maxBytes), format: 'wav',
            ...(typeof data.request_id === 'string' && /^[\w-]{1,128}$/.test(data.request_id) ? { providerRequestId: data.request_id } : {}),
            ...(usage === undefined ? {} : { usage }) }
        }
        const base64 = (parsed as { audio_base64?: unknown } | undefined)?.audio_base64
        if (typeof base64 !== 'string' || base64.length === 0 || base64.length > maxBytes * 2) throw new Error('tts_json_without_audio')
        const audio = new Uint8Array(Buffer.from(base64, 'base64'))
        if (audio.byteLength === 0) throw new Error('tts_json_without_audio')
        return { audio, format: 'wav' }
      }
      if (type !== '' && !type.startsWith('audio/') && !type.startsWith('application/octet-stream')) {
        throw new Error('tts_content_type_unexpected')
      }
      return { audio: await readBoundedBody(response, maxBytes), format: 'wav' }
    },
  }
}
