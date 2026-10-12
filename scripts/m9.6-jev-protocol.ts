/**
 * M9.6 WP2 —— **Jev（TypeSafe System One）官方协议客户端** + 严格归一化。
 *
 * ============================================================================
 *  定位与纪律
 * ============================================================================
 * ```text
 * · **实验用途**：只被 scripts/ 与 evals/ 消费。不改 src/main.ts、生产 flags、冻结契约。
 * · **只实现已核实的官方协议**（docs.typesafe.ai，核实日 2026-09-29）：
 *     POST https://api.typesafe.ai/v1/systemone
 *     Authorization: Bearer <key>
 *     { state, model, questions }   ← 三个都是必填
 *     → { model, answers, usage }
 *   不做第三方兼容层、不接任意 base URL、不装插件框架。
 * · **不假定 OpenAI Chat Completions 兼容**（官方文档不存在该模式）。
 * · **Key 只进认证头**：不进 prompt / 命令行 / 错误正文 / trace / 报告 / git。
 *   所有失败 `detail` 都过 `redactSecrets`。
 * ```
 *
 * ============================================================================
 *  四态与"不许用概率修复隐藏原始错误"
 * ============================================================================
 * ```text
 * 每次调用落三种终态之一：`ok`（合法且已严格归一）· `invalid_output`（形状/协议违规）
 * · `unavailable`（传输/配置/身份）。**没有第四种"大概能用"**。
 *
 * ⚠️ 概率**不做修复**：不归一、越界、键不在声明集合里 —— 一律 `invalid_output`，
 *    绝不"顺手归一化后当合法"（那会用修复隐藏原始错误率）。
 * ⚠️ `usage` 缺失**不记 0**：记 `usage: null` + `usageKnown: false`，费用按 UNKNOWN 处理。
 * ⚠️ 响应 `model` ≠ 请求 `model` ⇒ `model_mismatch`（**不重试**，须停止该批）。
 * ⚠️ 官方**没有** request id 字段 ⇒ `requestId` 恒为 `null`（不编造）。
 * ```
 */

/* ===========================================================================
 *  协议常量与失败码闭集
 * ========================================================================= */

/**
 * 响应正文硬上限（UTF-16 单元）。
 * ⚠️ 这是**本项目**自设的硬上限，**不是**官方限额的等价物 ——
 * 官方文档的 "64k" 指的是 **token**（`state` 32k + 最长问题），不是 code unit。
 * 超限 ⇒ `invalid_output`（失败关闭，不当成"大概能用"）。
 */
export const MAX_JEV_RESPONSE_UNITS = 131_072

/** **形状/协议**违规（落 `invalid_output`） */
export const JEV_SHAPE_FAILURE_CODES = [
  'envelope_not_json',
  'envelope_not_object',
  'model_missing',
  'model_mismatch',
  'answers_missing',
  'answer_missing',
  'answer_not_object',
  'answer_type_mismatch',
  'noul_invalid',
  'choice_invalid',
  'probabilities_invalid',
  'probabilities_not_normalized',
  'confidence_invalid',
  'score_invalid',
  'legend_mismatch',
  'response_too_long',
] as const

/** **传输/配置/身份**问题（落 `unavailable`） */
export const JEV_TRANSPORT_FAILURE_CODES = [
  'not_configured',
  'http_error',
  'http_error_unauthenticated',
  'rate_limited',
  'overloaded',
  'deadline_exceeded',
  'cancelled',
  'network_error',
] as const

/** 全部失败码（**白名单闭集**；每个码都必须可被离线量具真实触达） */
export const JEV_FAILURE_CODES = [
  ...JEV_SHAPE_FAILURE_CODES,
  ...JEV_TRANSPORT_FAILURE_CODES,
] as const

export type JevFailureCode = (typeof JEV_FAILURE_CODES)[number]

/** 协议常量表：**只**放从官方文档核实来的事实（核实日 2026-09-29） */
export const JEV_PROTOCOL_FACTS = {
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  modelsEndpoint: 'https://api.typesafe.ai/v1/models',
  authHeader: 'authorization: Bearer <key>',
  requestFields: ['state', 'model', 'questions'],
  questionTypes: ['noul', 'choice', 'score'],
  /** `criteria` 必填的两种；noul 可选 */
  criteriaRequiredFor: ['choice', 'score'],
  choiceMaxOptions: 255,
  scoreMinLevels: 2,
  scoreMaxLevels: 10,
  /** 官方**没有**数值区间字段 ⇒ 区间只能表达为有序档位数组 */
  hasNumericRangeField: false,
  /** ⚠️ Noul **不返回** confidence */
  noulReturnsConfidence: false,
  pricePerMillionInputTokensUsd: 0.042,
  outputTokensFree: true,
  documentedRateLimits: { tokensPerSecond: 250_000, requestsPerMinute: 1_200 },
  documentedContextTokens: { total: 64_000, stateMax: 32_000 },
  /** 官方**没有**文档化超时指引 */
  documentsTimeoutGuidance: false,
  /** 官方**没有** request id 字段 */
  hasRequestId: false,
  /** 官方**不存在** OpenAI Chat Completions 兼容模式 */
  openAiCompatible: false,
  confirmedErrorStatuses: [401, 429, 529],
  /** 422 出现在检索索引副本但直取未复现 ⇒ **未确认** */
  unconfirmedErrorStatuses: [422],
} as const

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODELS_ENDPOINT = 'https://api.typesafe.ai/v1/models'

/**
 * **A/B/J 三列共用的全调用总期限**（计划 §6.2「相同全调用期限」）。
 * ⚠️ 官方**没有**文档化超时指引；这是本项目选定的**有界**值，不是官方建议值。
 */
export const TOTAL_DEADLINE_MS = 20_000

/** 计划 §11：每个逻辑请求最多 **1 次显式重试** ⇒ 最多 2 次尝试 */
export const MAX_ATTEMPTS = 2

/**
 * 概率和容差（超过即判 `probabilities_not_normalized`，**不**自动修复）。
 *
 * ```text
 * 取值依据 = **实测**，不是猜：
 *   · 单问题探针（20 次真实调用）：偏差 **恒为 0**（和恰为 1.000000）。
 *   · 100 例三问题对照运行：**15 次**返回和恰为 **0.99**（偏差 0.01），
 *     且全部出现在 **13 选项**的 `reason` / `query` 问题上。
 * ⇒ 0.01 是**两位小数的表示舍入**，不是实质不归一。
 *   把它当 `invalid_output` 会让 J 的完成率被**我方的尺**压到 85%，
 *   从而把**量具缺陷**记成**模型缺陷**（本阶段真实踩到的一次）。
 * ⚠️ 容差只是"允许读到不精确的和"，**绝不**把概率改写归一：
 *    `probabilities` 原样保留，观测到的和另外记录（`observed`）。
 * ⚠️ 实质性不归一（例如和 0.8）仍必须判失败 —— 有离线负控钉着。
 * ```
 */
export const PROBABILITY_SUM_TOLERANCE = 0.01

/**
 * ★ 浮点比较余量（**只**为表示误差，不是放宽政策）。
 *
 * ⚠️ 实测踩到：`0.69 + 0.3` 在 IEEE-754 下是 `0.9899999999999999`，
 *    与 1 的差是 `0.01000000000000012` —— **略超**名义容差 0.01。
 *    若不加这个余量，"和恰为 0.99"这种**表示舍入**仍会被判失败
 *    （即：容差名义上定了 0.01，实际生效约 0.009999999999999788）。
 */
const FLOAT_COMPARISON_EPSILON = 1e-9

export const JEV_TEST_KEY_VAR = 'M96_JEV_TEST_API_KEY'
export const JEV_MODEL_VAR = 'M96_JEV_MODEL'

/* ===========================================================================
 *  问题类型（官方恰好三种）
 * ========================================================================= */

export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
  /** 可选：`{true, false}`。**Noul 不返回 confidence**。 */
  readonly criteria?: { readonly true: string; readonly false: string }
}

export interface ChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: string
  /** 必填：选项 → 描述（值可为 `null`）。官方上限 255 个选项。 */
  readonly criteria: Readonly<Record<string, string | null>>
}

export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  /** 必填：**有序**档位描述（低位 → 高位），**2–10 档**。没有数值区间字段。 */
  readonly criteria: readonly string[]
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion
export type JevQuestions = Readonly<Record<string, JevQuestion>>

export interface SystemOneRequest {
  readonly state: string
  readonly model: string
  readonly questions: JevQuestions
}

/* ===========================================================================
 *  响应类型（严格归一后的形状）
 * ========================================================================= */

export interface JevUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export type JevAnswer =
  | { readonly type: 'noul'; readonly noul: number }
  | {
      readonly type: 'choice'
      readonly choice: string | null
      readonly probabilities: Readonly<Record<string, number>>
      /** ⚠️ 分布导出的统计量，**不是**"这次判断正确的概率"；Choice 携带 */
      readonly confidence: number | null
    }
  | {
      readonly type: 'score'
      readonly score: number
      /**
       * 官方形状是**对象** `{"0": "<档位描述>", "1": …}`（WP3 预检实测确认）。
       * 本字段是**归一之后**的内部表示（有序数组）；归一前已逐档校验与声明一致，
       * 所以这不是"修复"，只是把已验证的对象转成本项目内部形状。
       */
      readonly legend: readonly string[]
      readonly probabilities: Readonly<Record<string, number>>
      readonly confidence: number | null
    }

export interface JevCallOk {
  readonly ok: true
  readonly answers: Readonly<Record<string, JevAnswer>>
  /** 响应 `model`：**实际作答**的版本 */
  readonly servedModel: string
  /** ⚠️ `null` = **UNKNOWN**（绝不当 0） */
  readonly usage: JevUsage | null
  readonly usageKnown: boolean
  /** 官方未文档化 request id ⇒ 恒 `null` */
  readonly requestId: null
  readonly attempts: number
}

export interface JevCallFailure {
  readonly ok: false
  readonly code: JevFailureCode
  readonly family: 'invalid_output' | 'unavailable'
  readonly attempts: number
  /** 已脱敏；可为空串 */
  readonly detail: string
  /**
   * ★ 可机器读的**观测量**（只有部分失败码有）：例如 `probabilities_not_normalized`
   *   记实测的**概率和**。用它来把"容差该定多少"变成**读数**而不是猜。
   */
  readonly observed: number | null
  /** 是否必须**停止整批**（认证失败 / 错模型版本） */
  readonly stopBatch: boolean
}

export type JevCallResult = JevCallOk | JevCallFailure

/* ===========================================================================
 *  脱敏与配置
 * ========================================================================= */

/** 把已知秘密从任何要落盘/上屏的文本里抹掉 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < 8) continue
    out = out.split(secret).join('[REDACTED]')
  }
  return out
}

export type JevConfig =
  | { readonly ok: true; readonly apiKey: string; readonly model: string }
  | { readonly ok: false; readonly code: 'not_configured'; readonly missing: readonly string[] }

/**
 * ★ 失败关闭：两个具名变量都**必须**在（默认从环境读，测试可注入）。
 * **绝不**回落 `OPENAI_API_KEY` —— "以为在跑 Jev、其实在烧主模型 Key"是这里最坏的失败模式。
 */
export function resolveJevConfig(env: Readonly<Record<string, string | undefined>> = process.env): JevConfig {
  const apiKey = (env[JEV_TEST_KEY_VAR] ?? '').trim()
  const model = (env[JEV_MODEL_VAR] ?? '').trim()
  const missing = [
    ...(apiKey === '' ? [JEV_TEST_KEY_VAR] : []),
    ...(model === '' ? [JEV_MODEL_VAR] : []),
  ]
  if (missing.length > 0) return { ok: false, code: 'not_configured', missing }
  return { ok: true, apiKey, model }
}

/* ===========================================================================
 *  严格归一化（**不修复**）
 * ========================================================================= */

const SHAPE = new Set<string>(JEV_SHAPE_FAILURE_CODES)
const known = (code: JevFailureCode): boolean => (JEV_FAILURE_CODES as readonly string[]).includes(code)

function fail(code: JevFailureCode, attempts: number, detail: string, observed: number | null = null): JevCallFailure {
  if (!known(code)) throw new Error(`未声明的失败码：${code}`)
  const family = SHAPE.has(code) ? 'invalid_output' : 'unavailable'
  const stopBatch = code === 'http_error_unauthenticated' || code === 'model_mismatch'
  return { ok: false, code, family, attempts, detail, observed, stopBatch }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * `answers` 的**严格**归一。任何一处不符合声明即整份失败 —— 不做局部修复。
 * `questions` 是判据源：选项集合、档位、类型都由它决定。
 *
 * ★ 导出给 **B 列对照臂** 复用：B 把同一组问题交给普通 LLM，返回值必须过**同一把尺**
 *   （否则"Jev 的严格性"与"B 的宽松性"就不可比）。B 没有独立版本号 ⇒ 调用方把
 *   `servedModel` 传成与 `requestedModel` 相同，并在证据里注明这一差异。
 */
export function normalizeAnswers(
  rawAnswers: unknown,
  questions: JevQuestions,
  servedModel: string,
  requestedModel: string,
  secrets: readonly string[],
  attempts: number
): JevCallResult {
  if (servedModel !== requestedModel) {
    return fail('model_mismatch', attempts, redactSecrets(`请求 ${requestedModel} · 响应 ${servedModel}`, secrets))
  }
  if (!isPlainObject(rawAnswers)) return fail('answers_missing', attempts, 'answers 不是对象')

  const out: Record<string, JevAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    if (!(id in rawAnswers)) return fail('answer_missing', attempts, `缺 answer：${id}`)
    const answer = rawAnswers[id]
    if (!isPlainObject(answer)) return fail('answer_not_object', attempts, `answer 不是对象：${id}`)
    if (answer.type !== question.type) {
      return fail('answer_type_mismatch', attempts, `${id}：声明 ${question.type} · 返回 ${String(answer.type)}`)
    }

    if (question.type === 'noul') {
      const value = answer.noul
      if (!isFiniteNumber(value)) return fail('noul_invalid', attempts, `${id}：noul 不是有限数`)
      if (value < 0 || value > 1) return fail('noul_invalid', attempts, `${id}：noul 越界 ${String(value)}`)
      out[id] = { type: 'noul', noul: value }
      continue
    }

    /* Choice 与 Score 都带 probabilities 与（可选）confidence —— 逐个严查 */
    const probabilities = answer.probabilities
    if (!isPlainObject(probabilities)) return fail('probabilities_invalid', attempts, `${id}：probabilities 不是对象`)
    const declaredKeys =
      question.type === 'choice'
        ? Object.keys(question.criteria)
        : question.criteria.map((_level, index) => String(index))
    let sum = 0
    for (const [key, value] of Object.entries(probabilities)) {
      if (!isFiniteNumber(value)) return fail('probabilities_invalid', attempts, `${id}：概率不是有限数（${key}）`)
      if (value < 0 || value > 1) return fail('probabilities_invalid', attempts, `${id}：概率越界（${key}=${String(value)}）`)
      if (!declaredKeys.includes(key)) return fail('probabilities_invalid', attempts, `${id}：未声明的键 ${key}`)
      sum += value
    }
    /*
     * ⚠️ **不归一化**：官方说 probabilities 之和为 1。和不为 1 就是协议违规，
     *    修好它等于用"修复"掩盖原始错误率（计划 §6.2 / §11 逐字禁止）。
     */
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE + FLOAT_COMPARISON_EPSILON) {
      return fail(
        'probabilities_not_normalized',
        attempts,
        `${id}：概率和 ${sum.toFixed(6)} ≠ 1（容差 ${String(PROBABILITY_SUM_TOLERANCE)}）`,
        sum
      )
    }

    const confidence = answer.confidence
    if (confidence !== undefined) {
      if (!isFiniteNumber(confidence)) return fail('confidence_invalid', attempts, `${id}：confidence 不是有限数`)
      if (confidence < 0 || confidence > 1) return fail('confidence_invalid', attempts, `${id}：confidence 越界`)
    }

    if (question.type === 'choice') {
      const choice = answer.choice
      if (choice !== null && typeof choice !== 'string') return fail('choice_invalid', attempts, `${id}：choice 不是字符串或 null`)
      if (typeof choice === 'string' && !declaredKeys.includes(choice)) {
        return fail('choice_invalid', attempts, `${id}：choice 不在声明选项里（${choice}）`)
      }
      out[id] = {
        type: 'choice',
        choice: choice as string | null,
        probabilities: probabilities as Record<string, number>,
        confidence: isFiniteNumber(confidence) ? confidence : null,
      }
      continue
    }

    /*
     * ★ `legend` 的官方形状是**对象**映射（WP3 预检实测）：
     *     `"legend": {"0": "平静", "1": "略微", …}`
     *   不是我方最初假设的有序数组 —— 那个假设被预检判成 `legend_mismatch`，
     *   是**我方实现**错，不是服务端错。这里按实测形状严格校验，
     *   然后再归一成本项目内部的有序数组（已逐档证明与声明一致，不是"修复"）。
     */
    const legend = answer.legend
    if (!isPlainObject(legend)) {
      return fail('legend_mismatch', attempts, `${id}：legend 不是对象（官方形状为 {"0": "<档位描述>", …}）`)
    }
    if (Object.keys(legend).length !== question.criteria.length) {
      return fail('legend_mismatch', attempts, `${id}：legend 档位数 ${String(Object.keys(legend).length)} ≠ 声明 ${String(question.criteria.length)}`)
    }
    for (let index = 0; index < question.criteria.length; index += 1) {
      if (legend[String(index)] !== question.criteria[index]) {
        return fail('legend_mismatch', attempts, `${id}：legend[${String(index)}] 与声明档位不一致`)
      }
    }
    const score = answer.score
    if (!isFiniteNumber(score)) return fail('score_invalid', attempts, `${id}：score 不是有限数`)
    /* 官方语义：`score` 是**跨档概率加权**，可以落在两档之间 ⇒ 界内即可，不要求是整数 */
    if (score < 0 || score > question.criteria.length - 1) {
      return fail('score_invalid', attempts, `${id}：score 越界（${String(score)}）`)
    }
    out[id] = {
      type: 'score',
      score,
      legend: [...question.criteria],
      probabilities: probabilities as Record<string, number>,
      confidence: isFiniteNumber(confidence) ? confidence : null,
    }
  }
  return {
    ok: true,
    answers: out,
    servedModel,
    usage: null,
    usageKnown: false,
    requestId: null,
    attempts,
  }
}

/* ===========================================================================
 *  调用
 * ========================================================================= */

export interface JevDeps {
  readonly deadlineMs?: number
  readonly fetchImpl?: typeof fetch
  readonly signal?: AbortSignal
  readonly config?: JevConfig
  readonly baseUrl?: string
}

function classifyFetchError(error: unknown): JevFailureCode {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'TimeoutError') return 'deadline_exceeded'
  if (name === 'AbortError') return 'cancelled'
  return 'network_error'
}

/** HTTP 状态 → 码。429 / 529 是官方文档化的两种节流/过载。 */
function httpCode(status: number): JevFailureCode {
  if (status === 401 || status === 403) return 'http_error_unauthenticated'
  if (status === 429) return 'rate_limited'
  if (status === 529) return 'overloaded'
  return 'http_error'
}

const RETRYABLE: readonly JevFailureCode[] = ['rate_limited', 'overloaded', 'http_error', 'network_error']

export async function callSystemOne(
  request: Omit<SystemOneRequest, 'model'>,
  deps: JevDeps = {}
): Promise<JevCallResult> {
  const config = deps.config ?? resolveJevConfig()
  if (!config.ok) return fail('not_configured', 0, `缺具名变量：${config.missing.join(',')}（不回落 OPENAI_API_KEY）`)

  const secrets = [config.apiKey]
  const baseUrl = deps.baseUrl ?? JEV_ENDPOINT
  const doFetch = deps.fetchImpl ?? fetch
  const deadlineMs = deps.deadlineMs ?? TOTAL_DEADLINE_MS
  const startedAt = Date.now()

  let lastCode: JevFailureCode = 'network_error'
  let lastDetail = ''
  let attempts = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remaining = deadlineMs - (Date.now() - startedAt)
    if (remaining <= 0) {
      lastCode = 'deadline_exceeded'
      lastDetail = '总期限耗尽（跨重试共用同一预算）'
      break
    }
    /*
     * ⚠️ 用**自己的** ref'd 定时器，而不是 `AbortSignal.timeout()`：
     *   后者的定时器是 **unref** 的 ⇒ 当"只有它待触发"时事件循环会空转结束，
     *   期限**根本没机会执行**（离线假 fetch 上直接表现为 `unsettled top-level await`）。
     *   自己的定时器既保证期限真被执行，也保证等待期间事件循环不空。
     */
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new DOMException('deadline exceeded', 'TimeoutError'))
    }, remaining)
    const signal = deps.signal === undefined ? controller.signal : AbortSignal.any([deps.signal, controller.signal])
    attempts = attempt

    try {
      const response = await doFetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ state: request.state, model: config.model, questions: request.questions }),
        signal,
        redirect: 'error', // 拒绝跨域重定向：认证头不得被转发到其它主机
      })

      if (!response.ok) {
        lastCode = httpCode(response.status)
        /* ⚠️ 只记状态码，**不**记响应正文（可能回显认证信息） */
        lastDetail = `HTTP ${String(response.status)}`
        if (!RETRYABLE.includes(lastCode)) return fail(lastCode, attempts, lastDetail)
        continue
      }

      const bodyText = await response.text()
      if (bodyText.length > MAX_JEV_RESPONSE_UNITS) return fail('response_too_long', attempts, `正文 ${String(bodyText.length)} 单元`)

      let envelope: unknown
      try {
        envelope = JSON.parse(bodyText) as unknown
      } catch {
        return fail('envelope_not_json', attempts, '响应正文不是 JSON')
      }
      if (!isPlainObject(envelope)) return fail('envelope_not_object', attempts, '响应顶层不是对象')

      const servedModel = envelope.model
      if (typeof servedModel !== 'string' || servedModel === '') return fail('model_missing', attempts, '响应缺 model')

      const normalized = normalizeAnswers(
        envelope.answers,
        request.questions,
        servedModel,
        config.model,
        secrets,
        attempts
      )
      if (!normalized.ok) return normalized

      /* usage：缺失 ⇒ UNKNOWN，**不记 0** */
      let usage: JevUsage | null = null
      const rawUsage = envelope.usage
      if (isPlainObject(rawUsage) && isFiniteNumber(rawUsage.input_tokens) && isFiniteNumber(rawUsage.output_tokens)) {
        usage = { inputTokens: rawUsage.input_tokens, outputTokens: rawUsage.output_tokens }
      }

      return { ...normalized, usage, usageKnown: usage !== null }
    } catch (error) {
      lastCode = classifyFetchError(error)
      lastDetail = redactSecrets((error as Error).message.slice(0, 120), secrets)
      if (lastCode === 'cancelled' || lastCode === 'deadline_exceeded') break
    } finally {
      clearTimeout(timer)
    }
  }

  return fail(lastCode, attempts, lastDetail)
}

/** 响应 `usage` → 费用。**usage 未知 ⇒ UNKNOWN，绝不返回 0** */
export function estimateCostUsd(usage: JevUsage | null, pricePerMillionInputTokens = 0.042): number | null {
  if (usage === null) return null
  return (usage.inputTokens / 1_000_000) * pricePerMillionInputTokens
}
