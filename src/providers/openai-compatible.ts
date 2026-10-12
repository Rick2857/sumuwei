/**
 * OpenAI 兼容模型 Provider
 *
 * 用途：把任意提供 OpenAI 兼容 `/chat/completions` 的服务接进 ElizaOS 的模型体系。
 * 当前配置为 DeepSeek 官方端点 + deepseek-v4.1-flash。
 *
 * ---------------------------------------------------------------------------
 * 为什么不直接用 @elizaos/plugin-openai？
 * ---------------------------------------------------------------------------
 * 该插件底层是 Vercel AI SDK v2 的 `createOpenAI()`，默认调用 **Responses API**
 * （POST {baseURL}/responses）。只有 OpenAI 官方提供该端点，DeepSeek 官方
 * 与硅基流动都只提供 `/chat/completions`，因此会得到 404 Not Found。
 * 实测证据（硅基流动）：
 *     POST https://api.siliconflow.cn/v1/responses        → 404 Not Found
 *     POST https://api.siliconflow.cn/v1/chat/completions → 200
 *
 * 解决方式：注册 priority 更高的 TEXT_LARGE / TEXT_SMALL 处理器。
 * core 的 `registerModel` 按 [priority 降序, 注册顺序升序] 排序，`getModel`
 * 取第一个，因此高优先级处理器会稳定覆盖插件自带的那个。
 *
 * ---------------------------------------------------------------------------
 * 职责边界
 * ---------------------------------------------------------------------------
 * 本文件只负责「发请求 + 解析回复」。
 * 上下文组装（人格 / 历史 / 时间 / 动作清单）全部由 ElizaOS 的 provider 体系
 * 完成，见 src/context/builder.ts。不要在这里拼 prompt。
 */
import {
  type GenerateTextParams,
  type IAgentRuntime,
  ModelType,
  type Plugin,
  parseKeyValueXml,
} from '@elizaos/core'
import { ChatStreamError, readChatStream } from './chat-stream.ts'
import type { ImageInput } from '../kernel/contracts/image-input.ts'

export interface StreamingTextOptions {
  onTextDelta?: (text: string) => void
  signal?: AbortSignal
  images?: readonly ImageInput[]
}

/** 部分推理模型会把思维链夹在标记里 */
const THINK_TAG = /<\/think>/g

interface ChatCompletionResponse {
  choices?: { message?: { content?: string; reasoning_content?: string } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string }
}

export interface ModelOutput {
  /** 真正给用户看的回复 */
  text: string
  /** 模型自述的思考过程（Lv2 审计的素材，暂不对外） */
  thought?: string
  /** 模型声明的动作 */
  actions?: string[]
}

function resolve(runtime: IAgentRuntime, key: string, fallback?: string): string | undefined {
  const v = runtime.getSetting(key)
  if (v === null || v === undefined || v === '') return process.env[key] ?? fallback
  return String(v)
}

/**
 * 解析模型输出。
 *
 * 上下文用的是 core 的 `messageHandlerTemplate`，该模板要求模型以
 *   <response><thought/><actions/><providers/><text/></response>
 * 的 XML 形式作答（actions 供 Lv2 的动作体系使用）。
 * 因此这里必须把 `<text>` 取出来再交给用户，而不是把整段 XML 打印出去。
 */
export function parseModelOutput(raw: string): ModelOutput {
  let s = raw.trim()

  // 1) 剥掉推理标记
  if (THINK_TAG.test(s)) {
    THINK_TAG.lastIndex = 0
    const idx = s.lastIndexOf('</think>')
    s = s.slice(idx + '</think>'.length).trim()
  }

  // 2) 解析 XML 动作格式
  const parsed = parseKeyValueXml(s) as { text?: unknown; thought?: unknown; actions?: unknown } | null
  if (parsed && typeof parsed.text === 'string' && parsed.text.trim()) {
    return {
      text: parsed.text.trim(),
      thought: typeof parsed.thought === 'string' ? parsed.thought : undefined,
      actions: Array.isArray(parsed.actions) ? (parsed.actions as string[]) : undefined,
    }
  }

  // 3) 兜底：模型没按格式输出，就直接用它
  return { text: s }
}

async function callChatCompletionsOnce(
  runtime: IAgentRuntime,
  params: GenerateTextParams & StreamingTextOptions,
  model: string
): Promise<string> {
  const apiKey = resolve(runtime, 'OPENAI_API_KEY')
  const baseURL = (resolve(runtime, 'OPENAI_BASE_URL', 'https://api.deepseek.com') ?? '').replace(/\/$/, '')
  if (!apiKey) {
    throw new Error('缺少 OPENAI_API_KEY，无法调用模型')
  }

  const messages: { role: 'system' | 'user'; content: string | object[] }[] = []
  const system = runtime.character.system
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: params.images?.length ? [
    { type: 'text', text: params.prompt },
    ...params.images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
  ] : params.prompt })

  // temperature 优先级：显式参数 > 运行时设置 > 默认 0.7
  //
  // 支持 MODEL_TEMPERATURE 环境变量/设置，是为了**对照实验的可重复性**：
  // 验证 State→Behavior 时必须压低随机性（建议 0.2~0.4），否则同一状态
  // 两次采样就能产生差异，无法判断差异究竟来自 State 还是采样噪声。
  const configuredTemp = resolve(runtime, 'MODEL_TEMPERATURE')
  const temperature =
    params.temperature ?? (configuredTemp !== undefined ? Number(configuredTemp) : 0.7)

  /*
   * ★ 2026-10-11：**流式请求的网络层失败必须具名**。
   *
   * 原来它裸抛 undici 的 `TypeError: fetch failed` —— 既不是 `ChatStreamError`
   * 也不是 `KernelError` ⇒ 桥折成"首句前失败"、provider 一行日志都没有，
   * 事后无法分辨"网络断了"与"她把封套写坏了"。
   * ⚠️ `message` **原样保留**：`isRetriableModelFailure` 按 message 判瞬态
   *    （`/fetch failed/` 必须仍然匹配），换文案就等于改重试语义。
   * ⚠️ 非流式（没有 `onTextDelta`）**原样抛**：那条路的既有重试与文案是别处的判据。
   */
  let res: Response
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: params.maxTokens ?? 4096,
        stream: params.onTextDelta !== undefined,
        /*
         * ★ 2026-10-10：流式也要 usage（OpenAI 兼容端点把它放在**最后一个** chunk 里）。
         * 这是主回复链 token 计量的**唯一来源** —— 没有它，失败那一轮什么读数都不留
         * （2026-10-10 的事故：`model_stream_finish_length` 之后库里查不到任何 token 数）。
         */
        ...(params.onTextDelta !== undefined ? { stream_options: { include_usage: true } } : {}),
      }),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    })
  } catch (error) {
    if (params.onTextDelta === undefined) throw error
    throw new ChatStreamError(
      'model_stream_fetch_failed',
      error instanceof Error ? error.message : String(error)
    )
  }

  if (res.ok && params.onTextDelta !== undefined) {
    try {
      return parseModelOutput(
        await readChatStream(res, params.onTextDelta, usage =>
          /*
           * 成功时的读数：**不进任何证据、不回显给用户**，只留一行日志。
           * 不可得记 null（`chat-stream.ts` 的 toTokens），不伪装成 0。
           */
          runtime.logger.info(
            `[model] tokens(stream): prompt=${String(usage.promptTokens)} ` +
              `completion=${String(usage.completionTokens)} reasoning=${String(usage.reasoningTokens)}`
          )
        )
      ).text
    } catch (error) {
      /*
       * ⚠️ **失败那一轮最需要这两个数字**（本次事故就是失败轮没有任何读数）。
       * 判据形态：额度被思维链吃光时 `completion ≈ max_tokens` 且 `reasoning` 占绝大部分；
       * 正文本身太长时 `reasoning` 很小而 `streamedChars` 很大。
       */
      if (error instanceof ChatStreamError) {
        const usage = error.usage
        runtime.logger.warn(
          `[model] stream failed code=${error.code} streamedChars=${String(error.streamedChars ?? -1)} ` +
            `prompt=${String(usage?.promptTokens ?? 'null')} ` +
            `completion=${String(usage?.completionTokens ?? 'null')} ` +
            `reasoning=${String(usage?.reasoningTokens ?? 'null')}`
        )
      }
      throw error
    }
  }
  if (!res.ok && params.onTextDelta !== undefined) {
    await res.body?.cancel()
    throw new ChatStreamError(`model_stream_http_${res.status}`, `模型调用失败 (HTTP ${res.status} @ stream)`)
  }
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`模型调用失败 (HTTP ${res.status} @ ${baseURL}/chat/completions): ${params.images?.length ? '[图片请求错误正文已省略]' : body.slice(0, 400)}`)
  }

  let json: ChatCompletionResponse
  try {
    json = JSON.parse(body) as ChatCompletionResponse
  } catch {
    throw new Error(`模型返回非 JSON: ${params.images?.length ? '[图片请求错误正文已省略]' : body.slice(0, 300)}`)
  }
  if (json.error) {
    throw new Error(`模型返回错误: ${params.images?.length ? '[图片请求错误正文已省略]' : json.error.message ?? JSON.stringify(json.error)}`)
  }

  const content = json.choices?.[0]?.message?.content ?? ''
  if (!content) {
    throw new Error(`模型返回空回复: ${params.images?.length ? '[图片请求错误正文已省略]' : body.slice(0, 300)}`)
  }

  if (json.usage) {
    runtime.logger.debug(
      `[model] tokens: prompt=${json.usage.prompt_tokens} completion=${json.usage.completion_tokens} total=${json.usage.total_tokens}`
    )
  }

  const out = parseModelOutput(content)
  if (out.thought) {
    runtime.logger.debug(`[model] thought: ${out.thought.slice(0, 120)}`)
  }
  return out.text
}

/* ---------------------------------------------------------------------------
 * 有界传输重试（2026-09-25，M6.1 判定轮空回复根因修复）
 * ---------------------------------------------------------------------------
 * 实测失败形态（a8fed873e6cf 批四轮，3 条 turns_incomplete，stderr 留痕）：
 *   ① `fetch failed`（传输层掉线，2 条：SRP-C-06#2 / SRP-A-01#0）；
 *   ② HTTP 200 + `content:""` + `reasoning_content` 满（推理耗尽预算、
 *      零正文发射，1 条：SRP-B-08#0）。
 * 两者都是**外部瞬态**；失败关闭路径（空回复 + 不编造）工作正确，但
 * 一轮里 ≥2 条就把「技术失败 ≤1」门顶破（r2-dep 因此 27→25）。
 *
 * 纪律：
 *   - 重试只**重发 HTTP 调用**——外围轮次管线只跑一次 ⇒ 幂等安全
 *    （记忆写入不在本函数内，不会被重试重复）；
 *   - 只重试瞬态（策略见 `model-retry.ts`，纯函数 + 零依赖）；
 *   - 有界：最多 3 次尝试，指数退避；耗尽后**原样抛出**——失败仍然
 *     失败关闭，不许把重试耗尽静默成"成功"。
 */
import {
  MODEL_CALL_MAX_ATTEMPTS,
  isRetriableModelFailure,
  modelCallBackoffMs,
} from './model-retry.ts'

export {
  MODEL_CALL_MAX_ATTEMPTS,
  MODEL_CALL_RETRY_BASE_MS,
  isRetriableModelFailure,
} from './model-retry.ts'

async function callChatCompletions(
  runtime: IAgentRuntime,
  params: GenerateTextParams & StreamingTextOptions,
  model: string
): Promise<string> {
  let lastError: unknown
  let emitted = false
  const onTextDelta = params.onTextDelta
  const streamingParams = onTextDelta === undefined ? params : {
    ...params, onTextDelta: (text: string) => { emitted = true; onTextDelta(text) },
  }
  for (let attempt = 1; attempt <= MODEL_CALL_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await callChatCompletionsOnce(runtime, streamingParams, model)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const retriable = isRetriableModelFailure(message)
      if (emitted || params.signal?.aborted || !retriable || attempt === MODEL_CALL_MAX_ATTEMPTS) {
        throw error
      }
      const backoffMs = modelCallBackoffMs(attempt)
      runtime.logger.warn(
        `[model] 第 ${String(attempt)}/${String(MODEL_CALL_MAX_ATTEMPTS)} 次调用瞬态失败（${message.slice(0, 120)}），${String(backoffMs)}ms 后重试`
      )
      await new Promise((resolveSleep) => setTimeout(resolveSleep, backoffMs))
    }
  }
  /* 循环正常必然 return 或 throw；这行只为类型收口 */
  throw lastError
}

/** 优先级 10 > 插件默认的 0，确保本处理器被选中 */
const PRIORITY = 10

export const openAiCompatiblePlugin: Plugin = {
  name: 'openai-compatible',
  description: 'OpenAI-compatible /chat/completions provider (DeepSeek official endpoint)',
  priority: PRIORITY,
  models: {
    [ModelType.TEXT_LARGE]: async (runtime, params) =>
      callChatCompletions(
        runtime,
        params as GenerateTextParams,
        resolve(runtime, 'OPENAI_LARGE_MODEL', 'deepseek-v4.1-flash') as string
      ),
    [ModelType.TEXT_SMALL]: async (runtime, params) =>
      callChatCompletions(
        runtime,
        params as GenerateTextParams,
        resolve(runtime, 'OPENAI_SMALL_MODEL', 'deepseek-v4.1-flash') as string
      ),
  },
}

export default openAiCompatiblePlugin
