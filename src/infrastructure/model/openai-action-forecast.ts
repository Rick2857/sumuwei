/**
 * 行动预测的 **OpenAI 兼容适配器**（三域应用方案 §2）。
 *
 * ============================================================================
 *  它与 `openai-task-planner.ts` 是同一套形状，理由也一样
 * ============================================================================
 * ```text
 * ActionForecastInput → 恰好一次 POST {base}/chat/completions（固定指令 + 候选步骤 + 闭集状态）
 *                    → 取 choices[0].message.content
 *                    → parseActionForecast（严格：未知字段 / 位置错位 / 枚举越界一律拒）
 *                    → ActionForecastOutcome（一份可用预测，或闭集失败码 + 如实请求数）
 * ```
 * 复用**既有**环境变量（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_SMALL_MODEL`）
 * ⇒ **不新增依赖、不新增凭证来源、不新增出站目标**。
 *
 * ============================================================================
 *  三条不许破的边界
 * ============================================================================
 * ① **它不是授权**：端口拿不到授权集合、参数与执行器；它只产出**预期与核对条件**。
 * ② **提示词从契约派生**：核对条件的闭集枚举全部 import 进来现算
 *    ⇒ 契约改一个枚举，提示词**同一次改动**就跟着变（手写会量到提示词的错）。
 * ③ **失败要分对桶**：网络 / HTTP / 没有 key ⇒ `call_failed`；
 *    "给了东西但形状不对" ⇒ `invalid_output` + **白名单里的**闭集码。
 *    模型输出**绝不**原样落进 trace / 账本。
 */

import {
  ACTION_FORECAST_SCHEMA_VERSION,
  parseActionForecast,
  toSafeActionForecastParseCode,
  type ActionForecastFailure,
  type ActionForecastInput,
  type ActionForecastOutcome,
  type ActionForecastParseCode,
  type ActionForecastPort,
} from '../../kernel/action/action-forecast.ts'
import {
  ACTION_FORECAST_CHECK_KINDS,
  ACTION_FORECAST_STATUSES,
  WORLD_MODEL_UNCERTAINTIES,
} from '../../kernel/contracts/world-model.ts'

export const OPENAI_ACTION_FORECAST_ID = 'openai-compatible-action-forecast@1'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_SMALL_MODEL = 'deepseek-v4.1-flash'

/** 预测调用的硬超时（毫秒）。**与规划器的 45000ms 无关**：这是另一件事。 */
export const ACTION_FORECAST_TIMEOUT_MS = 20_000

/**
 * 预测调用的输出上限（token）。
 *
 * ⚠️ 它必须够大：2026-10-20 dev 段实测**出现过空回包**（`action_forecast_empty`），
 *    与 M5.5.1 的同款教训一致（"判定器 800 被思维链吃光 ⇒ 内容缺失"）。
 *    ⇒ 给 **2000**，并把它当作**运行约束**而不是性能 SLA。
 */
export const ACTION_FORECAST_MAX_TOKENS = 2_000

/** 闭集状态摘要最多带几条（防止把无限历史塞进 prompt） */
export const MAX_FORECAST_STATE_LINES = 30

export interface OpenAiActionForecastOptions {
  readonly fetchImpl?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly maxTokens?: number
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[]
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

/**
 * 固定指令（**程序常量**）。
 *
 * ⚠️ 它是"工具性预测"，不是"她在思考"：没有人格、没有称呼、没有情绪。
 *    输出的唯一消费者是 `parseActionForecast`。
 */
export function buildActionForecastInstruction(): string {
  return [
    '你是一个"预测接下来几步动作会得到什么"的预测器。你只输出一个 JSON 对象。',
    '',
    '只输出 JSON，不要输出任何其它文字，不要用代码块围栏。顶层字段恰好是：',
    `  schemaVersion: 固定写成 ${JSON.stringify(ACTION_FORECAST_SCHEMA_VERSION)}`,
    '  steps: 数组，**与给你的候选步骤一一对应**（逐字抄 `capability` 与 `operation`）；可以只给前面几步',
    '',
    'steps 里每一项的字段恰好是：',
    '  capability: 字符串，**只抄**候选步骤里 "capability:" 冒号后的内容（**不要**把 operation 拼上去）',
    '  operation: 字符串，**只抄**候选步骤里 "operation:" 冒号后的内容（**不要**把用途写进来）',
    '  expectedVisibleOutcome: 字符串，一句话说明这一步"看得见的"结果是什么',
    '  check: 对象，核对条件（结构见下）',
    '  uncertainty: 字符串，只能是 ' + WORLD_MODEL_UNCERTAINTIES.join(' | '),
    '  dependsOn: 整数数组，依赖前面第几步（0 是第一步）；没有依赖就给空数组',
    '',
    'check 的形状（kind 决定还需要哪个字段）：',
    ...ACTION_FORECAST_CHECK_KINDS.map((kind) => {
      if (kind === 'status_is') {
        return `  {"kind":"status_is","status":"<${ACTION_FORECAST_STATUSES.join('|')}>"}`
      }
      if (kind === 'turn_content_count_at_least' || kind === 'external_evidence_count_at_least') {
        return `  {"kind":"${kind}","count":<非负整数>}`
      }
      return `  {"kind":"${kind}"}`
    }),
    '',
    '硬约束（逐条都能被机器校验；多一个字段整份预测都会被丢弃）：',
    '· 你的回复必须是**一个** JSON 对象，且是唯一输出。',
    '· 顶层**只能**有 schemaVersion / steps 两个字段；每一项**只能**有上面六个字段。',
    '· `check` 里**只能**有上面列出的 kind；status 只能是上面列出的状态。',
    '· `capability` / `operation` **必须逐字**对应候选步骤里的那两行；',
    '  对不上就**这一条不生效**（那一步没有核对条件，行为与不预测时相同）。',
    '· 下面是一个**正确**的例子（照这个形状写）：',
    '  {"schemaVersion":"action-forecast@1","steps":[{"capability":"local.file.write","operation":"write",',
    '   "expectedVisibleOutcome":"文件被写入并留下指纹","check":{"kind":"effect_recorded"},',
    '   "uncertainty":"medium","dependsOn":[]}]}',
    '· `dependsOn` 里的下标是**你这份列表里的**下标（0 = 你写的第一项），',
    '  只能指向**更早**的一项（不能指向自己或后面）；程序会把它换算成计划里的步序。',
    '',
    '判断纪律（这些是事实约束，不是风格建议）：',
    '· **success 只说明适配器报告成功**：它不说明文件真的写对了、内容真的读到了。',
    '  涉及"写下来 / 读回来"的那一步，请用能反映**可见结果**的核对条件',
    '  （例如读到内容用 turn_content_count_at_least，记录了效果用 effect_recorded）。',
    '· **不确定就直说**：uncertainty 给 "high" 或 "unknown"，不要写成确定的样子。',
    '· 依赖关系只写**真的**依赖：后面那一步要靠前面那一步的**结果**才成立时才写。',
    '· 不要预测**没被授权**的动作，也不要为了预测而建议额外的动作。',
    '· 不要在 expectedVisibleOutcome 里写文件正文、URL 参数以外的私密内容。',
  ].join('\n')
}

export function buildActionForecastMessages(
  input: ActionForecastInput
): { role: 'system' | 'user'; content: string }[] {
  /*
   * ⚠️ **候选步骤逐字段分行**（2026-10-20 dev 段 A/B 的**实测**修法）：
   *    第一版把一行渲染成 `0. 能力.操作 · 用途：…` ⇒ **能力名与操作名的边界是模糊的**
   *    ⇒ 真实模型把两段**并进**了 `capability`（`fixture.beta.write.write`），
   *    并把 `用途` 写进了 `operation` ⇒ 那一步**绑不上**（没有闸）。
   *    ⇒ 现在**一行一个字段**，边界没有解释空间。
   */
  const candidates = input.candidateSteps.map((step, index) => {
    const lines = [
      `第 ${String(index)} 步`,
      `  capability: ${step.capability}`,
      `  operation: ${step.operation}`,
    ]
    if (step.purpose !== undefined) lines.push(`  用途: ${step.purpose}`)
    return lines.join('\n')
  })
  const state =
    input.state.length === 0
      ? '（还没有执行过任何步骤）'
      : input.state
          .slice(-MAX_FORECAST_STATE_LINES)
          .map((row) => `${row.step}=${row.status}${row.failureCode === undefined ? '' : `/${row.failureCode}`}`)
          .join('\n')
  const sections: string[] = [
    '任务目标：',
    input.goal,
    '',
    '候选步骤（**按这个顺序**逐步给预测）：',
    candidates.join('\n'),
    '',
    '已经发生过的步骤（闭集）：',
    state,
    '',
    `本任务还可以执行 ${String(input.remainingActions)} 次动作，还可以调用 ${String(input.remainingModelCalls)} 次模型。`,
  ]
  if (input.readback !== undefined && input.readback.length > 0) {
    sections.push(
      '',
      '已经真的读到的内容（**这是实际内容，不是摘要**）：',
      input.readback.join('\n\n')
    )
  }
  sections.push('', '请给出这些步骤的预期可见结果与核对条件。')
  return [
    { role: 'system', content: buildActionForecastInstruction() },
    { role: 'user', content: sections.join('\n') },
  ]
}

export function createOpenAiActionForecast(
  options: OpenAiActionForecastOptions = {}
): ActionForecastPort {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_SMALL_MODEL
  const timeoutMs = options.timeoutMs ?? ACTION_FORECAST_TIMEOUT_MS
  const maxTokens = options.maxTokens ?? ACTION_FORECAST_MAX_TOKENS

  const failed = (
    failure: ActionForecastFailure,
    requestCount: number,
    parseFailureCode?: ActionForecastParseCode
  ): ActionForecastOutcome => ({
    ok: false,
    failure,
    requestCount,
    ...(parseFailureCode !== undefined ? { parseFailureCode } : {}),
  })

  return {
    id: OPENAI_ACTION_FORECAST_ID,
    endpointHost: hostOf(baseURL),

    async forecast(input): Promise<ActionForecastOutcome> {
      if (apiKey === '') return failed('call_failed', 0)
      if (input.candidateSteps.length === 0) return failed('invalid_output', 0, 'action_forecast_bad_steps')

      const controller = new AbortController()
      let timedOut = false
      const budgetMs = Math.max(1, Math.min(timeoutMs, input.deadlineMs))
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, budgetMs)
      const onCallerAbort = (): void => controller.abort()
      if (input.signal?.aborted === true) controller.abort()
      else input.signal?.addEventListener('abort', onCallerAbort, { once: true })

      try {
        const response = await doFetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: buildActionForecastMessages(input),
            temperature: 0,
            max_tokens: maxTokens,
            stream: false,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        })
        if (!response.ok) return failed('call_failed', 1)

        const abortedSignal = new Promise<'aborted'>((resolvePromise) => {
          if (controller.signal.aborted) resolvePromise('aborted')
          else controller.signal.addEventListener('abort', () => resolvePromise('aborted'), { once: true })
        })
        const raced = await Promise.race([
          response
            .json()
            .then((value) => ({ kind: 'body' as const, value: value as ChatCompletionResponse }))
            .catch(() => ({ kind: 'bad' as const })),
          abortedSignal.then(() => ({ kind: 'aborted' as const })),
        ])
        if (raced.kind === 'aborted') return failed(timedOut ? 'timeout' : 'call_failed', 1)
        if (raced.kind === 'bad') return failed('invalid_output', 1, 'action_forecast_bad_json')
        const content = raced.value.choices?.[0]?.message?.content
        if (typeof content !== 'string') return failed('invalid_output', 1, 'action_forecast_not_object')

        try {
          const forecast = parseActionForecast(content, {
            planSignature: input.candidateSteps.map((step) => `${step.capability}.${step.operation}`),
            producedAt: input.producedAt,
            inputRevision: input.inputRevision,
          })
          return { ok: true, forecast, requestCount: 1 }
        } catch (error) {
          /*
           * ⚠️ 解析失败**只**记白名单里的码：模型输出可能整段抄了正文，
           *    绝不能落进 trace / 账本 / 证据。
           */
          return failed('invalid_output', 1, toSafeActionForecastParseCode(error))
        }
      } catch {
        return failed(timedOut ? 'timeout' : 'call_failed', 1)
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onCallerAbort)
      }
    },
  }
}

export function describeOpenAiActionForecast(
  port: ActionForecastPort,
  env: NodeJS.ProcessEnv = process.env
): string {
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_SMALL_MODEL
  return (
    `action forecast @ ${port.endpointHost} · model=${model} · ` +
    `≤${String(ACTION_FORECAST_TIMEOUT_MS)}ms · 核对闭集 ${ACTION_FORECAST_CHECK_KINDS.length} 种`
  )
}
