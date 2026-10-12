/**
 * 搜索需求判定器的 **OpenAI 兼容适配器**（M5.5.1 WP3 / ADR-049 `R2` §11.1·§11.2）。
 *
 * ============================================================================
 *  它只做四件事
 * ============================================================================
 * ```text
 * text  →  恰好一次 POST {base}/chat/completions（固定指令 + 用户当前发言）
 *       →  取 choices[0].message.content
 *       →  parseSearchNeedJudgeOutput（严格：未知字段/坏枚举/坏 span 一律拒）
 *       →  SearchNeedJudgeOutcome（成功提案，或闭集失败码 + 如实请求数）
 * ```
 *
 * 它**不**做：判断能不能执行（那是 `decideSearchNeed` + Policy + Gateway 的事）、
 * 构造 ActionRequest、写账本、决定 query 用哪一段。
 *
 * ---------------------------------------------------------------------------
 *  为什么复用既有模型端点而不是新接一个 SDK
 * ---------------------------------------------------------------------------
 * 与 `src/providers/openai-compatible.ts` 同一套环境变量（`OPENAI_API_KEY` /
 * `OPENAI_BASE_URL` / `OPENAI_SMALL_MODEL`），用原生 `fetch` 直连 `/chat/completions`。
 * 理由：**不新增依赖、不新增凭证来源、不新增出站目标** —— 这次判定只是同一轮对话
 * 里多问模型一句，不是接了一个新服务。
 *
 * ---------------------------------------------------------------------------
 *  隐私：这次调用送出的是**比正常一轮更少**的东西
 * ---------------------------------------------------------------------------
 * 正常一轮会把 人设 + 记忆 + 历史 + 动作清单 + 时间 全发给模型；判定调用只发两条：
 * **固定的程序指令** + **用户当前这一条发言**（`buildSearchNeedJudgeMessages`）。
 * 没有 userId、没有 traceId、没有检索到的记忆、没有人设文本 —— 端口与构造函数的
 * 形状里就没有它们的位置。判定器因此**没得可偏**（`R2` §11.1 第 5/6 条）。
 *
 * ⚠️ 失败信息里**绝不**带回模型输出、也绝不带回用户原文：
 *    这些要进 trace / 诊断，而"用户原文或模型解释进账本"正是 M5.5 明令禁止的泄漏。
 *    因此失败只报**闭集码 + 长度**（`rawLength`），连 HTTP body 都不读。
 */

import {
  SEARCH_NEED_JUDGE_MAX_TOKENS,
  SEARCH_NEED_JUDGE_TIMEOUT_MS,
  buildSearchNeedJudgeMessages,
  parseSearchNeedJudgeOutput,
  type SearchNeedJudgeFailure,
  type SearchNeedJudgeOutcome,
  type SearchNeedJudgePort,
  type SearchNeedJudgeShape,
  type SearchNeedParseCode,
  toJudgeContentKind,
  toJudgeFinishReason,
  toSafeParseCode,
} from '../../kernel/action/search-need-judge.ts'

export const OPENAI_SEARCH_NEED_JUDGE_ID = 'openai-chat-completions'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_SMALL_MODEL = 'deepseek-v4.1-flash'

export interface OpenAiSearchNeedJudgeOptions {
  /** 可注入的 fetch（离线测试与出站形状量具用）；缺省用 Node 22 原生 fetch */
  fetchImpl?: typeof fetch
  /** 环境变量来源（缺省 `process.env`；测试可注入，绝不打印取值） */
  env?: NodeJS.ProcessEnv
  /** 覆盖硬超时（毫秒），仅测试用 */
  timeoutMs?: number
  /**
   * **诊断专用**覆盖输出上限（token）。
   *
   * ⚠️ 这是 R2-3/R2-4 单变量实验用的口子（实测：800 被思维链吃光 ⇒ `finish_reason=length`
   *    且 `content` 缺失）。缺省仍走内核常量 `SEARCH_NEED_JUDGE_MAX_TOKENS` ——
   *    **改生产默认值是另一次裁定**，不在本实验范围内。
   */
  maxTokens?: number
}

interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: unknown
      reasoning_content?: unknown
      tool_calls?: unknown
      refusal?: unknown
    }
    finish_reason?: unknown
  }[]
  usage?: {
    completion_tokens?: unknown
    completion_tokens_details?: { reasoning_tokens?: unknown }
  }
}

/** 解析 base URL 的 host（**只用于诊断**；解析不出来就报空串，绝不抛） */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

/**
 * 从响应里取**形状**（长度 / 计数 / **闭集枚举**）—— **绝不取文本**。
 *
 * R2-2 补齐：`contentKind`（missing/null/string/array/object/other）、`finishReason`
 * （闭集，未知折 `other`）、`messagePresent`、tool-call 计数、refusal 是否在场、
 * token 数（**不可得记 null，不伪装成 0**）。
 *
 * ⚠️ 上一版把 `finish_reason` **原样**留着 —— 那是把外部文本写进证据的入口。
 *    这一版只允许闭集里的值。
 */
function shapeOf(
  status: number,
  payload: ChatCompletionResponse | undefined,
  timing: JudgeTiming
): SearchNeedJudgeShape {
  const choice = payload?.choices?.[0]
  const message = choice?.message
  const contentPresent = message !== undefined && Object.prototype.hasOwnProperty.call(message, 'content')
  const content = message?.content
  const reasoning = message?.reasoning_content
  const toolCalls = message?.tool_calls
  const toTokens = (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) ? raw : null

  return {
    httpStatus: status,
    choiceCount: Array.isArray(payload?.choices) ? payload.choices.length : 0,
    messagePresent: message !== undefined && message !== null,
    contentKind: toJudgeContentKind(content, contentPresent),
    contentLength: typeof content === 'string' ? content.length : 0,
    reasoningPresent: Object.prototype.hasOwnProperty.call(message ?? {}, 'reasoning_content'),
    reasoningContentLength: typeof reasoning === 'string' ? reasoning.length : 0,
    finishReason: toJudgeFinishReason(choice?.finish_reason),
    toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
    refusalPresent:
      message !== undefined &&
      message !== null &&
      Object.prototype.hasOwnProperty.call(message, 'refusal') &&
      message.refusal !== null,
    completionTokens: toTokens(payload?.usage?.completion_tokens),
    reasoningTokens: toTokens(payload?.usage?.completion_tokens_details?.reasoning_tokens),
    headersMs: timing.headersMs,
    bodyMs: timing.bodyMs,
    totalMs: timing.totalMs,
    retryAfterMs: timing.retryAfterMs,
  }
}

/** `Retry-After` 的上限（毫秒）：**不许**把服务端给的任意值直接当调度依据 */
const RETRY_AFTER_CAP_MS = 60_000

/**
 * 解析 `Retry-After`（**有上限**，只读这一个受控头）。
 *
 * ⚠️ 只接受两种形态：秒数、HTTP-date。其它一律 -1。**不记录原始 header 集合**、
 *    不读响应错误正文（它们可能回显我们发过去的内容）。
 */
function parseRetryAfter(raw: string | null, nowMs: number): number {
  if (raw === null || raw.trim() === '') return -1
  const value = raw.trim()
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, RETRY_AFTER_CAP_MS)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return -1
  return Math.min(Math.max(at - nowMs, 0), RETRY_AFTER_CAP_MS)
}

interface JudgeTiming {
  startedMs: number
  headersMs: number
  bodyMs: number
  totalMs: number
  retryAfterMs: number
}

export function createOpenAiSearchNeedJudge(options: OpenAiSearchNeedJudgeOptions = {}): SearchNeedJudgePort {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_SMALL_MODEL
  const timeoutMs = options.timeoutMs ?? SEARCH_NEED_JUDGE_TIMEOUT_MS

  const failed = (
    failure: SearchNeedJudgeFailure,
    requestCount: number,
    shape?: SearchNeedJudgeShape,
    parseFailureCode?: SearchNeedParseCode
  ): SearchNeedJudgeOutcome => ({
    ok: false,
    failure,
    requestCount,
    ...(shape !== undefined ? { shape } : {}),
    ...(parseFailureCode !== undefined ? { parseFailureCode } : {}),
  })

  return {
    id: OPENAI_SEARCH_NEED_JUDGE_ID,
    endpointHost: hostOf(baseURL),

    async judge(input): Promise<SearchNeedJudgeOutcome> {
      /*
       * ① 先校验，再发请求。
       *    空文本不得产生任何出站请求 —— 因此这条路径的 requestCount 如实为 0。
       */
      if (typeof input.text !== 'string' || input.text.trim() === '') {
        return failed('empty_text', 0)
      }
      /*
       * ② 没有 key ⇒ **不做请求**（`call_failed` + requestCount 0）。
       *    刻意**不**回落任何其它凭证来源：那正是"以为在跑测试、其实在烧生产 key"的成因。
       */
      if (apiKey === '') return failed('call_failed', 0)

      // ③ 硬超时 + 调用方信号，合并成同一个 controller
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      const onCallerAbort = (): void => controller.abort()
      // ⚠️ 已 abort 的信号不会再触发 abort 事件（DOM/undici 语义）：必须先查 aborted
      if (input.signal?.aborted === true) {
        controller.abort()
      } else {
        input.signal?.addEventListener('abort', onCallerAbort, { once: true })
      }

      const timing: JudgeTiming = {
        startedMs: Date.now(),
        headersMs: -1,
        bodyMs: -1,
        totalMs: -1,
        retryAfterMs: -1,
      }
      try {
        // ④ **恰好一次**：这里没有循环、没有重试、没有降级重问
        const response = await doFetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: buildSearchNeedJudgeMessages(input.text),
            temperature: 0,
            max_tokens: options.maxTokens ?? SEARCH_NEED_JUDGE_MAX_TOKENS,
            stream: false,
            /*
             * 端点侧 JSON 模式（WP7 第一次真实运行的实测：结构化输出合法率只有 38.6%）。
             * ⚠️ 它**只**约束输出格式，**不**放松任何校验 —— 严格解析里那条
             *    "未知字段一律拒"一个字没改（它是防偷渡 authorized:true 的结构性保证）。
             */
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        })

        timing.headersMs = Date.now() - timing.startedMs
        // ⚠️ 失败分支**不读 body**：模型错误页可能回显我们发过去的内容
        if (!response.ok) {
          timing.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now())
          timing.totalMs = Date.now() - timing.startedMs
          return failed('call_failed', 1, shapeOf(response.status, undefined, timing))
        }

        /*
         * ⚠️ **超时必须覆盖响应体读取**（用户裁定 A 第 2 条）。
         *    只把 signal 交给 fetch 是不够的：若某个实现的响应体读起来不理会 signal
         *    （自造 Response / 代理挂住），`await response.json()` 会**无限等**。
         *    因此这里把"读体"与"中止信号"**赛跑**，任一方先到就结束 —— 到期即取消。
         */
        const abortedSignal = new Promise<"aborted">((resolve) => {
          if (controller.signal.aborted) resolve("aborted")
          else controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true })
        })
        const raced = await Promise.race([
          response
            .json()
            .then((value) => ({ kind: "body" as const, value: value as ChatCompletionResponse }))
            .catch(() => ({ kind: "bad" as const })),
          abortedSignal.then(() => ({ kind: "aborted" as const })),
        ])
        if (raced.kind === "aborted") {
          timing.totalMs = Date.now() - timing.startedMs
          return failed(
            timedOut || controller.signal.aborted ? "timeout" : "call_failed",
            1,
            shapeOf(0, undefined, timing)
          )
        }
        let payload: ChatCompletionResponse | undefined
        let bodyNotJson = raced.kind === "bad"
        if (raced.kind === "body") payload = raced.value
        timing.bodyMs = Date.now() - timing.headersMs - timing.startedMs
        timing.totalMs = Date.now() - timing.startedMs
        const shape = shapeOf(response.status, payload, timing)

        /*
         * ⚠️ 下面每一条都是**解析**失败（HTTP 是成功的）⇒ 它们**不是**传输失败。
         *    量具曾经把这一类标成传输失败，正好掩盖了真正的根因。
         *    每条都带一个**白名单里的**安全码，不再笼统地说"模型不合约"。
         */
        if (bodyNotJson) return failed('invalid_output', 1, shape, 'search_need_judge_response_not_json')
        if (payload === undefined) return failed('invalid_output', 1, shape, 'search_need_judge_no_choice')
        const content = payload.choices?.[0]?.message?.content
        if (typeof content !== 'string') {
          return failed('invalid_output', 1, shape, 'search_need_judge_content_not_string')
        }

        try {
          timing.totalMs = Date.now() - timing.startedMs
          return { ok: true, proposal: parseSearchNeedJudgeOutput(content), requestCount: 1, shape: shapeOf(response.status, payload, timing) }
        } catch (error) {
          /*
           * 解析失败**只**记形状与**白名单码**：模型输出可能整段抄了用户原文，
           * 绝不能落进 trace / 账本 / 证据（`toSafeParseCode` 不认识的一律 unknown）。
           */
          timing.totalMs = Date.now() - timing.startedMs
          return failed('invalid_output', 1, shape, toSafeParseCode(error))
        }
      } catch {
        // 超时与"调用方取消"都归 `timeout`：调用方取消不是一条独立的授权结论，
        // 它同样意味着"这一轮没有取得合法判定"⇒ 零搜索调用。
        timing.totalMs = Date.now() - timing.startedMs
        return failed(
          timedOut || controller.signal.aborted ? 'timeout' : 'call_failed',
          1,
          shapeOf(0, undefined, timing)
        )
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onCallerAbort)
      }
    },
  }
}

/** 便于诊断：一行说明（**不含 key、不含用户文本**） */
export function describeOpenAiSearchNeedJudge(
  judge: SearchNeedJudgePort,
  env: NodeJS.ProcessEnv = process.env
): string {
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_SMALL_MODEL
  return `search-need judge @ ${judge.endpointHost} · model=${model} · ≤1 call/turn · ${SEARCH_NEED_JUDGE_TIMEOUT_MS}ms`
}
