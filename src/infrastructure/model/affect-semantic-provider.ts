/**
 * 语义评估器的 **OpenAI 兼容适配器**（M8.5 WP5 / ADR-068；detached：WP6 才消费）。
 *
 * ============================================================================
 *  它只做三件事
 * ============================================================================
 * ```text
 * outboundText → 恰好一次 POST {base}/chat/completions（单条 user 消息 = 指令+输入块）
 *             → 抽 choices[0]（content / finish_reason 闭集映射 / tool_calls / refusal）
 *             → SemanticModelResponseEnvelope + shape（长度/计数/闭集枚举，绝不取文本）
 * ```
 * 解析与映射在 WP4（`parseSemanticJudgment`）；重试与任务生命周期在 WP6 worker。
 *
 * ---------------------------------------------------------------------------
 *  传输失败闭集（Contract-Freeze §7：唯一可重试类别）
 * ---------------------------------------------------------------------------
 * `timeout`（硬超时覆盖 body 读；调用方取消同归此码——它同样意味着"未取得判定"）
 * `rate_limited`（HTTP 429；Retry-After 有上限地透传，只作提示不自动重试）
 * `server_error`（HTTP 5xx 与其它非 2xx——含 4xx：非重试友好，烧尽尝试后失败关闭）
 * `network_error`（fetch 层失败：DNS / 连接拒绝 / TLS / 中断）
 *
 * ---------------------------------------------------------------------------
 *  纪律（与 openai-search-need-judge.ts 同源）
 * ---------------------------------------------------------------------------
 * · 同一套环境变量（OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_SMALL_MODEL）：
 *   不新增依赖、不新增凭证来源、不新增出站目标（ADR-068 能力矩阵"推荐 NONE"行）。
 * · 没有 key ⇒ 不做请求（requestCount 如实 0），绝不回落其它凭证来源。
 * · 失败分支**不读 body**（错误页可能回显我们发过去的内容）；失败信息只带闭集码
 *   + 形状（长度/计数/闭集枚举），绝不带模型输出、用户正文或 HTTP 错误正文。
 * · 超时覆盖响应体读取：读体与中止信号赛跑（自造 Response 挂住也不会无限等）。
 * · `json_object` 只约束输出格式，不放松 WP4 的任何校验。
 */

import {
  AFFECT_SEMANTIC_MAX_TOKENS,
  AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS,
  AFFECT_SEMANTIC_TIMEOUT_MS,
  isAffectSemanticTransportFailure,
  type AffectSemanticTransportFailureCode,
} from '../../kernel/contracts/affect-semantic.ts'
import type { SemanticModelResponseEnvelope } from '../../kernel/app/affect/semantic-evaluator.ts'

export const OPENAI_AFFECT_SEMANTIC_PROVIDER_ID = 'openai-chat-completions'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_SMALL_MODEL = 'deepseek-v4.1-flash'

export interface OpenAiAffectSemanticProviderOptions {
  /** 可注入的 fetch（离线门与出站形状量具用）；缺省 Node 22 原生 fetch */
  fetchImpl?: typeof fetch
  /** 环境变量来源（缺省 process.env；测试可注入，绝不打印取值） */
  env?: NodeJS.ProcessEnv
  /** 覆盖硬超时（毫秒），仅测试用 */
  timeoutMs?: number
  /** 覆盖输出上限（token），仅诊断实验用；改生产默认值 = 另一次裁定 */
  maxTokens?: number
}

/** 一次调用的观测形状：长度 / 计数 / 闭集枚举 / 计时（Contract-Freeze §10 计数器源） */
export interface AffectSemanticProviderShape {
  readonly httpStatus: number
  readonly choiceCount: number
  readonly messagePresent: boolean
  readonly contentKind: 'missing' | 'string' | 'other'
  readonly contentLength: number
  readonly finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'other' | 'none'
  readonly toolCallCount: number
  readonly refusalPresent: boolean
  readonly bodyWasJson: boolean
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly reasoningTokens: number | null
  readonly headersMs: number
  readonly bodyMs: number
  readonly totalMs: number
  readonly retryAfterMs: number
}

export interface AffectSemanticProviderCall {
  /** WP4 `buildSemanticOutbound` 的完整出站文本（指纹已由 WP4 计算） */
  readonly outboundText: string
  /** 调用方取消信号（shutdown / 模式切换） */
  readonly signal?: AbortSignal
}

export type AffectSemanticTransportOutcome =
  | {
      readonly ok: true
      readonly envelope: SemanticModelResponseEnvelope
      readonly shape: AffectSemanticProviderShape
      readonly requestCount: 1
    }
  | {
      readonly ok: false
      readonly failure: AffectSemanticTransportFailureCode
      readonly requestCount: 0 | 1
      readonly shape?: AffectSemanticProviderShape
      /** 仅 rate_limited 可能携带：解析后的 Retry-After（毫秒，已封顶） */
      readonly retryAfterMs?: number
    }

interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: unknown
      tool_calls?: unknown
      refusal?: unknown
    }
    finish_reason?: unknown
  }[]
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    completion_tokens_details?: { reasoning_tokens?: unknown }
  }
}

/** 解析 base URL 的 host（只用于诊断；解析不出报空串，绝不抛） */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

/** finish_reason → 闭集（未知折 other；绝不把外部文本原样留进证据） */
function toClosedFinishReason(raw: unknown): AffectSemanticProviderShape['finishReason'] {
  if (raw === 'stop') return 'stop'
  if (raw === 'length') return 'length'
  if (raw === 'content_filter') return 'content_filter'
  if (raw === 'tool_calls') return 'tool_calls'
  if (raw === undefined || raw === null) return 'none'
  return 'other'
}

/** Retry-After：只接受秒数与 HTTP-date，封顶 AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS */
function parseRetryAfter(raw: string | null, nowMs: number): number {
  if (raw === null || raw.trim() === '') return -1
  const value = raw.trim()
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return -1
  return Math.min(Math.max(at - nowMs, 0), AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS)
}

const toTokens = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : null

export interface AffectSemanticProvider {
  readonly id: string
  readonly endpointHost: string
  /** 一次语义评估调用（恰好一次 HTTP；无循环、无重试、无降级重问） */
  call(input: AffectSemanticProviderCall): Promise<AffectSemanticTransportOutcome>
}

export function createOpenAiAffectSemanticProvider(
  options: OpenAiAffectSemanticProviderOptions = {},
): AffectSemanticProvider {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_SMALL_MODEL
  const timeoutMs = options.timeoutMs ?? AFFECT_SEMANTIC_TIMEOUT_MS

  const failed = (
    failure: AffectSemanticTransportFailureCode,
    requestCount: 0 | 1,
    shape?: AffectSemanticProviderShape,
    retryAfterMs?: number,
  ): AffectSemanticTransportOutcome => ({
    ok: false,
    failure,
    requestCount,
    ...(shape !== undefined ? { shape } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })

  return {
    id: OPENAI_AFFECT_SEMANTIC_PROVIDER_ID,
    endpointHost: hostOf(baseURL),

    async call(input) {
      // ① 空出站不做请求（上游 buildSemanticOutbound 已挡；防御性失败关闭）
      if (typeof input.outboundText !== 'string' || input.outboundText.length === 0) {
        return failed('network_error', 0)
      }
      // ② 没有 key ⇒ 不做请求（requestCount 如实 0；绝不回落其它凭证来源）
      if (apiKey === '') return failed('network_error', 0)

      // ③ 硬超时 + 调用方信号合并成同一 controller
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      const onCallerAbort = (): void => controller.abort()
      if (input.signal?.aborted === true) {
        controller.abort()
      } else {
        input.signal?.addEventListener('abort', onCallerAbort, { once: true })
      }

      const timing = {
        startedMs: Date.now(),
        headersMs: -1,
        bodyMs: -1,
        totalMs: -1,
        retryAfterMs: -1,
      }
      const shapeOf = (
        status: number,
        payload: ChatCompletionResponse | undefined,
        bodyWasJson: boolean,
      ): AffectSemanticProviderShape => {
        const choice = payload?.choices?.[0]
        const message = choice?.message
        const content = message?.content
        return {
          httpStatus: status,
          choiceCount: Array.isArray(payload?.choices) ? payload.choices.length : 0,
          messagePresent: message !== undefined && message !== null,
          contentKind:
            typeof content === 'string' ? 'string' : message === undefined ? 'missing' : 'other',
          contentLength: typeof content === 'string' ? content.length : 0,
          finishReason: toClosedFinishReason(choice?.finish_reason),
          toolCallCount: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
          refusalPresent:
            message !== undefined &&
            message !== null &&
            Object.prototype.hasOwnProperty.call(message, 'refusal') &&
            message.refusal !== null,
          bodyWasJson,
          promptTokens: toTokens(payload?.usage?.prompt_tokens),
          completionTokens: toTokens(payload?.usage?.completion_tokens),
          reasoningTokens: toTokens(payload?.usage?.completion_tokens_details?.reasoning_tokens),
          headersMs: timing.headersMs,
          bodyMs: timing.bodyMs,
          totalMs: timing.totalMs,
          retryAfterMs: timing.retryAfterMs,
        }
      }

      try {
        // ④ 恰好一次 POST：单条 user 消息 = 完整出站文本（指纹覆盖所发内容）
        const response = await doFetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: input.outboundText }],
            temperature: 0,
            max_tokens: options.maxTokens ?? AFFECT_SEMANTIC_MAX_TOKENS,
            stream: false,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        })

        timing.headersMs = Date.now() - timing.startedMs
        // ⑤ 失败分支不读 body；429 单列（唯一带 Retry-After 提示的码）
        if (!response.ok) {
          timing.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now())
          timing.totalMs = Date.now() - timing.startedMs
          const shape = shapeOf(response.status, undefined, true)
          if (response.status === 429) {
            return failed('rate_limited', 1, shape, timing.retryAfterMs)
          }
          // 5xx 与其它非 2xx（含 4xx）统一 server_error：非重试友好，烧尽尝试后失败关闭
          return failed('server_error', 1, shape)
        }

        // ⑥ 超时覆盖响应体读取：读体与中止信号赛跑
        const abortedSignal = new Promise<'aborted'>((resolve) => {
          if (controller.signal.aborted) resolve('aborted')
          else controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
        })
        const raced = await Promise.race([
          response
            .json()
            .then((value) => ({ kind: 'body' as const, value: value as ChatCompletionResponse }))
            .catch(() => ({ kind: 'bad' as const })),
          abortedSignal.then(() => ({ kind: 'aborted' as const })),
        ])
        if (raced.kind === 'aborted') {
          timing.totalMs = Date.now() - timing.startedMs
          return failed('timeout', 1, shapeOf(response.status, undefined, false))
        }
        const bodyWasJson = raced.kind === 'body'
        const payload = bodyWasJson ? raced.value : undefined
        timing.bodyMs = Date.now() - timing.headersMs - timing.startedMs
        timing.totalMs = Date.now() - timing.startedMs
        const shape = shapeOf(response.status, payload, bodyWasJson)

        // ⑦ HTTP 成功但 body 非 JSON：信封 content=null（解析层归 missing_content；形状记 bodyWasJson）
        if (!bodyWasJson || payload === undefined) {
          return {
            ok: true,
            envelope: { content: null, finishReason: null, hasToolCalls: false },
            shape,
            requestCount: 1,
          }
        }
        const message = payload.choices?.[0]?.message
        const content = typeof message?.content === 'string' ? message.content : null
        // 信封只携带闭集映射值（stop/length/content_filter/tool_calls/other）；未知折 other，
        // 绝不把外部字符串原样透传（与 shape 同一纪律）
        const closedFinish = toClosedFinishReason(payload.choices?.[0]?.finish_reason)
        return {
          ok: true,
          envelope: {
            content,
            finishReason: closedFinish === 'none' ? null : closedFinish,
            hasToolCalls: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
            refusalPresent: shape.refusalPresent,
          },
          shape,
          requestCount: 1,
        }
      } catch {
        // fetch 层失败：超时/调用方取消 → timeout；其余 → network_error
        timing.totalMs = Date.now() - timing.startedMs
        return failed(
          timedOut || controller.signal.aborted ? 'timeout' : 'network_error',
          1,
          shapeOf(0, undefined, false),
        )
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onCallerAbort)
      }
    },
  }
}

/** 便于诊断：一行说明（不含 key、不含用户文本） */
export function describeAffectSemanticProvider(
  provider: AffectSemanticProvider,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_SMALL_MODEL
  return `affect-semantic provider @ ${provider.endpointHost} · model=${model} · ≤1 call/task · ${AFFECT_SEMANTIC_TIMEOUT_MS}ms`
}

/** 传输失败码闭集守卫（供门与调用方校验） */
export function isAffectSemanticProviderFailure(
  value: string,
): value is AffectSemanticTransportFailureCode {
  return isAffectSemanticTransportFailure(value)
}
