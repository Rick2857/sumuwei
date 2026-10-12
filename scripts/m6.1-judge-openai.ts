/**
 * M6.1 WP2 —— **量具的真实判定器适配器**（OpenAI 兼容 `/chat/completions`）。
 *
 * ============================================================================
 *  它只做三件事
 * ============================================================================
 * ```text
 *   prompt  →  POST {base}/chat/completions  →  取 choices[0].message.content
 * ```
 * **不**做：判断合格与否（那是 `parseJudgeOutput` 与 `evaluateValidity` 的事）、
 * 决定标签、写账本、改任何生产路径。
 *
 * ---------------------------------------------------------------------------
 *  为什么放在 `scripts/` 而不是 `src/infrastructure/model/`
 * ---------------------------------------------------------------------------
 * 本仓库已有一份同形状的先例（`src/infrastructure/model/openai-search-need-judge.ts`），
 * 但那一份是**生产判定器**（接在真实对话链路上）。M6.1 的量具按计划书 §WP2 是
 * **独立离线评测量具、不接入生产回复链** ⇒ 把它放进 `scripts/` 让"它不在生产链路上"
 * 这件事在**目录结构**上就成立，而不是靠一句承诺。本阶段 `src/**` 改动数因此保持 **0**。
 *
 * ---------------------------------------------------------------------------
 *  两次由**实测**逼出来的判据修正（都留档，因为都很容易被踩第二次）
 * ---------------------------------------------------------------------------
 * ```text
 *   ① token 预算 700 → 4000
 *      该端点返回 message.reasoning_content，而**推理 token 也算 completion 预算**；
 *      700 被推理吃光后 message.content 变成 null。第一版把这种情况报成 `bad_shape`
 *      （"形状不对"）—— **归因是错的**：形状是对的，是**被截断**了。
 *      ⇒ 现在 `finish_reason = length` 单独报 `truncated`。
 *   ② 超时 25s → 60s，并对 429 / 超时 / 网络做**有界重试**
 *      实测：单次判定 8–18s，且连续调用会撞 **HTTP 429**（限流）。
 *      重试只针对**传输层**失败，且**每次尝试都计数**（`attempts`）——
 *      "重试到成功"与"只留最好一次"的区别就在这个计数可见。
 *      仍然失败 ⇒ **留在分母里**，不剔除（计划书 §6.3）。
 * ```
 *
 * ---------------------------------------------------------------------------
 *  隐私与失败信息
 * ---------------------------------------------------------------------------
 * 失败的返回值里**只有闭集失败码、HTTP 状态与长度**（`rawLength`），
 * 绝不带回模型输出、也绝不带回语料正文。
 */

import type { ParseOutcome } from './m6.1-instrument.ts'
import { parseJudgeOutput } from './m6.1-instrument.ts'

export const M6_1_INSTRUMENT_JUDGE_ID = 'openai-chat-completions'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-v4.1-flash'

/** 单次尝试的硬超时（毫秒）。实测单次 8–18s ⇒ 25s 偏紧，60s 留出余量。 */
export const M6_1_JUDGE_TIMEOUT_MS = 60_000

/**
 * token 预算（见文件头修正 ①）。
 *
 * 实测轨迹：700 → 三条全截断；4000 → 五条里两条仍截断。**根因在下面这个档位**：
 * 诊断探针（16 次调用）实测 completion 里 **~97% 是 reasoning**
 * （1366/1321 · 2193/2148 · 3443/3419 ……）。
 * ⇒ 用 `reasoning_effort: low` 之后实测 completion ≤1594，8000 绰绰有余。
 *
 * ============================================================================
 *  ⚠️ 2026-09-23 修订：8000 → **32000**（用户裁定：「评测预算固定为已实测的 32000」）
 * ============================================================================
 * 上面那段"8000 绰绰有余"的判断**被实测推翻**了（`docs/m6.1/M6.1-Instrument-Validity-Report.md`
 * §19.1/§19.2）：
 * ```text
 *   两轮全量读数里，可修的失败**全部**是 truncated，**网络/HTTP 为 0**；
 *   8000 档失败单元的用量**无一例外**是 completion=8000 / reasoning=8000 / finish=length / 内容长度 0
 *     ⇒ 整个输出预算被**推理**吃光；
 *   8000 → 32000 的单变量对照（固定样本 × 3 次）：成功 13/18 → **18/18**，预算耗尽 5 → **0**。
 * ```
 * ⚠️ 措辞纪律（用户点名）：这只支持「**这些失败的直接机制是推理耗尽预算**」，
 *    **不**支持"这些提示固定需要某个 token 区间"——观测范围不是需求上界。
 *
 * ⚠️ 它**是有效配置的一部分**，必须进 `configKey`（`maxTokens` 已进），
 * 否则两次不同预算的读数会被当成可比。
 * ⚠️ 它**只**是**离线评测判定器**的配置，**不**动苏沐薇生产回复的默认值（`src/**`）。
 */
export const M6_1_JUDGE_MAX_TOKENS = 32_000

/**
 * 推理预算档位。
 *
 * ⚠️ **实测逼出来的**（诊断探针，16 次调用）：
 * ```text
 * 基线（不传）  completion 1366–3443，其中 reasoning 1321–3419（**~97%**）· 正文只 63–113 字符
 * low          端点接受（无 400）· completion 1197–1594 · 3/3 finish=stop · 6.3–7.9s
 * ```
 * 截断的根因是**推理 token 的方差**（1321 → 4914），压档位即可压住，时延也降一半。
 *
 * ⚠️ **它改变判定器的配置** ⇒ 必须进 `configKey`（见 `m6.1-cross-run.ts`），
 * 否则新旧采样会被误当成可比。
 */
export const M6_1_JUDGE_REASONING_EFFORT = 'low'

/** 单条判定的最大尝试次数（只对传输层失败重试；每次尝试都进 `attempts`）。 */
export const M6_1_JUDGE_MAX_ATTEMPTS = 5

/**
 * 两次调用之间的最小间隔（毫秒）。
 *
 * 实测：68 条连续调用有 14 条撞 **HTTP 429**。单纯加重试次数治标 ——
 * 限流是按时间窗算的，**放慢节奏**才治本。缺省 1.5s ⇒ 68 条约 100 秒额外开销，
 * 相对 8–18s/次的模型时延可以忽略。
 */
export const M6_1_JUDGE_MIN_INTERVAL_MS = 1_500

export type JudgeCallFailure =
  | 'no_api_key'
  | 'http_error'
  | 'rate_limited'
  | 'bad_shape'
  | 'empty_content'
  | 'truncated'
  | 'timeout'
  | 'network'

/**
 * 端点自报的 token 用量（**可能缺项** —— 缺就是 `null`，不许填 0 冒充"量到了"）。
 *
 * 为什么要采它：截断（`finish_reason = length` + 空 content）的成因是**输出预算被吃光**，
 * 而"预算够不够"这件事只有用量能回答。第一版完全没采 ⇒ 证据里
 * "已记录的 token 用量"只能是**未记录**，于是对截断只能猜。
 */
export interface JudgeUsage {
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly totalTokens: number | null
  /** 推理 token（端点若给 `completion_tokens_details.reasoning_tokens`） */
  readonly reasoningTokens: number | null
}

/**
 * **单次** HTTP 尝试的原始读数。
 *
 * ⚠️ 加它的原因是一次真实的可疑读数：某条 `attempts = 3` 而只留下 1 个采样，
 * 说明内部发生过一次可重试失败 + 一次截断，但 `JudgeCallResult` 只保留**最后**
 * 一次的失败码（`truncated`），前面那次失败**被丢掉了** —— 于是记录里
 * `callFailure = truncated` 与 `finishReason = stop` 并列，读起来自相矛盾。
 * 逐次留痕之后，"哪一次因为什么失败"不再是推断。
 */
export interface JudgeAttemptRecord {
  readonly index: number
  readonly callFailure: JudgeCallFailure | null
  readonly httpStatus: number | null
  readonly finishReason: string | null
  readonly rawLength: number
  readonly durationMs: number
  readonly usage: JudgeUsage | null
}

export interface JudgeCallResult {
  readonly ok: boolean
  /** 成功时的解析结果（**注意**：`ok:false` 也可能是"HTTP 成功但输出解析失败"） */
  readonly parsed: ParseOutcome | null
  readonly callFailure: JudgeCallFailure | null
  readonly httpStatus: number | null
  /** 模型自报的结束原因（`stop` / `length` …）。`length` ⇒ 被截断，不是"形状不对"。 */
  readonly finishReason: string | null
  readonly rawLength: number
  /** 这一次判定**一共尝试了几次**（含失败尝试）。1 = 一次就成。 */
  readonly attempts: number
  readonly durationMs: number
  /** 最后一次尝试的用量（端点没给 ⇒ null） */
  readonly usage: JudgeUsage | null
  /** **逐次**尝试的原始读数（顺序即发生顺序） */
  readonly attemptLog: readonly JudgeAttemptRecord[]
}

export interface OpenAiInstrumentJudgeOptions {
  readonly fetchImpl?: typeof fetch
  readonly env?: Record<string, string | undefined>
  readonly timeoutMs?: number
  readonly model?: string
  /** 推理预算档位（缺省 low，见 M6_1_JUDGE_REASONING_EFFORT 的实测记录） */
  readonly reasoningEffort?: string
  /**
   * 输出预算（`max_tokens`）。
   *
   * ⚠️ 它是 `configKey` 的一部分吗？**不是** —— 但它会改变判定器的行为，
   * 所以任何用它做的对照实验都必须**逐次记下实际取值**，不能拿不同预算的读数互相比较。
   */
  readonly maxTokens?: number
  readonly maxAttempts?: number
  /** 可注入的等待（离线测试用）；缺省用真实 setTimeout */
  readonly sleepImpl?: (ms: number) => Promise<void>
}

export interface OpenAiInstrumentJudge {
  readonly id: string
  readonly baseUrlHost: string
  readonly model: string
  /** 推理预算档位 —— **进 configKey**：它变了，跨轮采样就不再可比 */
  readonly reasoningEffort: string
  /** 实际使用的输出预算（`max_tokens`）—— 实验时**必须**记进证据 */
  readonly maxTokens: number
  judge(prompt: string): Promise<JudgeCallResult>
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return '(不可解析)'
  }
}

/** 只有传输层失败才重试：结果层失败（解析、截断、形状）重试没有意义。 */
function isRetryable(failure: JudgeCallFailure | null): boolean {
  return failure === 'rate_limited' || failure === 'timeout' || failure === 'network'
}

/** 只取**具名**字段；缺项一律 `null`（不填 0 冒充"量到了"）。 */
function usageOf(payload: unknown): JudgeUsage | null {
  if (typeof payload !== 'object' || payload === null) return null
  const raw = (payload as { usage?: unknown }).usage
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  const details = record.completion_tokens_details
  const reasoning =
    typeof details === 'object' && details !== null
      ? num((details as Record<string, unknown>).reasoning_tokens)
      : null
  return {
    promptTokens: num(record.prompt_tokens),
    completionTokens: num(record.completion_tokens),
    totalTokens: num(record.total_tokens),
    reasoningTokens: reasoning,
  }
}

export function createOpenAiInstrumentJudge(
  options: OpenAiInstrumentJudgeOptions = {}
): OpenAiInstrumentJudge {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = (env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = options.model ?? env.OPENAI_SMALL_MODEL ?? env.OPENAI_MODEL ?? DEFAULT_MODEL
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const timeoutMs = options.timeoutMs ?? M6_1_JUDGE_TIMEOUT_MS
  const maxTokens = options.maxTokens ?? M6_1_JUDGE_MAX_TOKENS
  const maxAttempts = Math.max(1, options.maxAttempts ?? M6_1_JUDGE_MAX_ATTEMPTS)
  const reasoningEffort = options.reasoningEffort ?? M6_1_JUDGE_REASONING_EFFORT
  const sleep =
    options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let attemptCounter = 0

  async function attemptOnce(prompt: string): Promise<JudgeCallResult> {
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    /**
     * 每次 HTTP 尝试都产出一条 `attemptLog`，**包括失败的那次** ——
     * 上一版只保留最后一次失败码，前面那次失败就永久丢了。
     */
    const failed = (
      callFailure: JudgeCallFailure,
      httpStatus: number | null,
      finishReason: string | null,
      usage: JudgeUsage | null = null
    ): JudgeCallResult => {
      attemptCounter += 1
      const durationMs = Date.now() - startedAt
      return {
        ok: false,
        parsed: null,
        callFailure,
        httpStatus,
        finishReason,
        rawLength: 0,
        attempts: 1,
        durationMs,
        usage,
        attemptLog: [
          {
            index: attemptCounter,
            callFailure,
            httpStatus,
            finishReason,
            rawLength: 0,
            durationMs,
            usage,
          },
        ],
      }
    }
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0,
          reasoning_effort: reasoningEffort,
        }),
        signal: controller.signal,
      })
      if (response.status === 429) return failed('rate_limited', 429, null)
      if (!response.ok) return failed('http_error', response.status, null) // **不读 body**

      const payload: unknown = await response.json()
      const usage = usageOf(payload)
      const first = (() => {
        if (typeof payload !== 'object' || payload === null) return undefined
        const choices = (payload as { choices?: unknown }).choices
        if (!Array.isArray(choices) || choices.length === 0) return undefined
        return choices[0] as
          | { finish_reason?: unknown; message?: { content?: unknown } }
          | undefined
      })()
      const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : null
      const content = first?.message?.content
      if (content === undefined || content === null) {
        /*
         * `content` 为 null 有两种完全不同的原因，**不能混成一个码**：
         *   · `finish_reason = length` ⇒ 预算被推理吃光（**被截断**）
         *   · 其它                     ⇒ 真的形状不对
         * 混起来会把"预算不够"误报成"接口坏了"，从而修错地方（已经踩过一次）。
         */
        return failed(
          finishReason === 'length' ? 'truncated' : 'bad_shape',
          response.status,
          finishReason,
          usage
        )
      }
      if (typeof content !== 'string') {
        return failed('bad_shape', response.status, finishReason, usage)
      }
      if (content.trim() === '') {
        return failed(
          finishReason === 'length' ? 'truncated' : 'empty_content',
          response.status,
          finishReason,
          usage
        )
      }
      const parsed = parseJudgeOutput(content)
      attemptCounter += 1
      const durationMs = Date.now() - startedAt
      return {
        ok: parsed.ok,
        parsed,
        callFailure: null,
        httpStatus: response.status,
        finishReason,
        rawLength: content.length,
        attempts: 1,
        durationMs,
        usage,
        attemptLog: [
          {
            index: attemptCounter,
            callFailure: null,
            httpStatus: response.status,
            finishReason,
            rawLength: content.length,
            durationMs,
            usage,
          },
        ],
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return failed(aborted ? 'timeout' : 'network', null, null)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    id: M6_1_INSTRUMENT_JUDGE_ID,
    baseUrlHost: hostOf(baseUrl),
    model,
    reasoningEffort,
    async judge(prompt: string): Promise<JudgeCallResult> {
      const overallStart = Date.now()
      if (apiKey === '') {
        return {
          ok: false,
          parsed: null,
          callFailure: 'no_api_key',
          httpStatus: null,
          finishReason: null,
          rawLength: 0,
          attempts: 0,
          durationMs: 0,
          usage: null,
          attemptLog: [],
        }
      }
      let attempts = 0
      let last: JudgeCallResult | null = null
      /** **每一次**尝试都留下原始读数（不再只留最后一次的失败码）。 */
      const attemptLog: JudgeAttemptRecord[] = []
      while (attempts < maxAttempts) {
        attempts += 1
        last = await attemptOnce(prompt)
        attemptLog.push(...last.attemptLog)
        if (!isRetryable(last.callFailure) || attempts >= maxAttempts) break
        // 退避：限流时等久一点（2s → 5s → 8s → 10s）
        await sleep(Math.min(10_000, 2_000 + (attempts - 1) * 3_000))
      }
      const result = last ?? {
        ok: false,
        parsed: null,
        callFailure: 'network' as const,
        httpStatus: null,
        finishReason: null,
        rawLength: 0,
        attempts: 0,
        durationMs: 0,
        usage: null,
        attemptLog: [],
      }
      return {
        ...result,
        attempts,
        durationMs: Date.now() - overallStart,
        attemptLog,
      }
    },
    /** 供实验脚本核对"这一轮到底用了多少输出预算"。 */
    maxTokens,
  }
}
