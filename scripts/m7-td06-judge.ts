/**
 * M7 WP6-B · TD-06 —— **判定器适配器**（OpenAI 兼容 `/chat/completions`）。
 *
 * 与 `scripts/m6.1-judge-openai.ts` 的关系：**传输纪律同款**（有界重试只对
 * 传输层失败 · 每次尝试计数 · 失败只留闭集码不留正文 · reasoning_effort low ·
 * 32000 预算 · 60s 超时），**解析层是 TD-06 自己的**（四界裁决 JSON，不是
 * M6.1 的 assertions 形状）——一个概念一处实现：M6.1 的 `parseJudgeOutput`
 * 冻结在它的标签集上，TD-06 不复用它也不改它。
 *
 * 判定契约：[`docs/m7/M7-WP6-TD06-Definition.md`](../../docs/m7/M7-WP6-TD06-Definition.md)
 * §1 四界（轴 A uptake / 轴 B add-displace）+ §1.5 边界裁决表。
 * 输出形状（判定器必须产出的 JSON）：
 * ```json
 * { "verdict": "RESPONDS_TO_CURRENT|NORMAL_CONTINUITY|REPETITION_PRESSURE|TOPIC_HIJACK",
 *   "subtype": "care|callback|followup|null",
 *   "uptake": true,
 *   "rationale": "一句话" }
 * ```
 */
import { createHash } from 'node:crypto'

export const TD06_JUDGE_TIMEOUT_MS = 60_000
export const TD06_JUDGE_MAX_TOKENS = 32_000
export const TD06_JUDGE_REASONING_EFFORT = 'low'
export const TD06_JUDGE_MAX_ATTEMPTS = 5
export const TD06_JUDGE_MIN_INTERVAL_MS = 1_500

export const TD06_VERDICTS = [
  'RESPONDS_TO_CURRENT',
  'NORMAL_CONTINUITY',
  'REPETITION_PRESSURE',
  'TOPIC_HIJACK',
] as const
export type Td06Verdict = (typeof TD06_VERDICTS)[number]

export const TD06_SUBTYPES = ['care', 'callback', 'followup'] as const
export type Td06Subtype = (typeof TD06_SUBTYPES)[number]

export interface Td06JudgeReading {
  readonly verdict: Td06Verdict
  readonly subtype: Td06Subtype | null
  readonly uptake: boolean
  readonly rationale: string
}

export type Td06JudgeFailure =
  | 'empty'
  | 'not_json'
  | 'shape'
  | 'unknown_verdict'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'auth_failed'
  | 'server_error'
  | 'truncated'
  | 'unknown'

export interface Td06JudgeCallResult {
  readonly ok: boolean
  readonly reading: Td06JudgeReading | null
  readonly failure: Td06JudgeFailure | null
  readonly httpStatus: number | null
  readonly finishReason: string | null
  readonly rawLength: number
  readonly attempts: number
  readonly durationMs: number
}

export interface Td06JudgeOptions {
  readonly env?: Record<string, string | undefined>
  readonly timeoutMs?: number
  readonly maxTokens?: number
  readonly maxAttempts?: number
  readonly minIntervalMs?: number
  readonly sleepImpl?: (ms: number) => Promise<void>
  readonly fetchImpl?: typeof fetch
  /** 提示词指纹（进证据：判定提示词变了 ⇒ 跨轮读数不可比） */
  readonly promptFingerprint?: string
}

function classifyHttp(status: number, bodyText: string): Td06JudgeFailure {
  if (status === 429) return 'rate_limited'
  if (status === 401 || status === 403) return 'auth_failed'
  if (status >= 500) return 'server_error'
  if (/rate[\s_-]?limit|too many requests/i.test(bodyText)) return 'rate_limited'
  return 'unknown'
}

function isRetryable(failure: Td06JudgeFailure | null): boolean {
  return failure === 'rate_limited' || failure === 'timeout' || failure === 'network'
}

/** 解析判定器输出（允许 ```json 包裹；verdict 必须在冻结四界内）。 */
export function parseTd06JudgeOutput(text: string): { reading: Td06JudgeReading | null; failure: Td06JudgeFailure | null } {
  const trimmed = text.trim()
  if (trimmed === '') return { reading: null, failure: 'empty' }
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  const body = (fenced?.[1] ?? trimmed).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { reading: null, failure: 'not_json' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { reading: null, failure: 'shape' }
  const raw = parsed as { verdict?: unknown; subtype?: unknown; uptake?: unknown; rationale?: unknown }
  if (typeof raw.verdict !== 'string' || !TD06_VERDICTS.includes(raw.verdict as Td06Verdict)) {
    return { reading: null, failure: 'unknown_verdict' }
  }
  const subtype =
    typeof raw.subtype === 'string' && TD06_SUBTYPES.includes(raw.subtype as Td06Subtype)
      ? (raw.subtype as Td06Subtype)
      : null
  return {
    reading: {
      verdict: raw.verdict as Td06Verdict,
      subtype,
      uptake: raw.uptake === true,
      rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 500) : '',
    },
    failure: null,
  }
}

export function createTd06Judge(options: Td06JudgeOptions = {}): {
  readonly model: string
  readonly baseUrlHost: string
  readonly maxTokens: number
  readonly reasoningEffort: string
  readonly promptFingerprint: string
  judge: (prompt: string) => Promise<Td06JudgeCallResult>
} {
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const baseUrl = (env.OPENAI_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '')
  const model = env.OPENAI_LARGE_MODEL ?? 'deepseek-v4.1-flash'
  const apiKey = env.OPENAI_API_KEY ?? ''
  const timeoutMs = options.timeoutMs ?? TD06_JUDGE_TIMEOUT_MS
  const maxTokens = options.maxTokens ?? TD06_JUDGE_MAX_TOKENS
  const maxAttempts = options.maxAttempts ?? TD06_JUDGE_MAX_ATTEMPTS
  const minIntervalMs = options.minIntervalMs ?? TD06_JUDGE_MIN_INTERVAL_MS
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const doFetch = options.fetchImpl ?? fetch
  let lastCallAt = 0

  async function attemptOnce(prompt: string): Promise<Td06JudgeCallResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: '你是行为判定器。只输出严格 JSON，不要输出任何其他文字。' },
            { role: 'user', content: prompt },
          ],
          max_tokens: maxTokens,
          temperature: 0,
          reasoning_effort: TD06_JUDGE_REASONING_EFFORT,
        }),
        signal: controller.signal,
      })
      const bodyText = await response.text()
      if (!response.ok) {
        return {
          ok: false, reading: null, failure: classifyHttp(response.status, bodyText),
          httpStatus: response.status, finishReason: null, rawLength: bodyText.length, attempts: 1,
          durationMs: 0,
        }
      }
      let payload: unknown
      try {
        payload = JSON.parse(bodyText)
      } catch {
        return {
          ok: false, reading: null, failure: 'not_json',
          httpStatus: response.status, finishReason: null, rawLength: bodyText.length, attempts: 1,
          durationMs: 0,
        }
      }
      const choice = (payload as { choices?: { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }[] }).choices?.[0]
      const content = choice?.message?.content
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
      if (typeof content !== 'string' || content.trim() === '') {
        return {
          ok: false, reading: null, failure: finishReason === 'length' ? 'truncated' : 'empty',
          httpStatus: response.status, finishReason, rawLength: bodyText.length, attempts: 1,
          durationMs: 0,
        }
      }
      const parsed = parseTd06JudgeOutput(content)
      return {
        ok: parsed.reading !== null,
        reading: parsed.reading,
        failure: parsed.failure,
        httpStatus: response.status,
        finishReason,
        rawLength: content.length,
        attempts: 1,
        durationMs: 0,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failure: Td06JudgeFailure = /abort/i.test(message)
        ? 'timeout'
        : /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(message)
          ? 'network'
          : 'network'
      return { ok: false, reading: null, failure, httpStatus: null, finishReason: null, rawLength: 0, attempts: 1, durationMs: 0 }
    } finally {
      clearTimeout(timer)
    }
  }

  async function judge(prompt: string): Promise<Td06JudgeCallResult> {
    const started = Date.now()
    /* 串行最小间隔（L-M61-13 单端点纪律：连续调用会撞 429） */
    const wait = lastCallAt + minIntervalMs - Date.now()
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
    let last: Td06JudgeCallResult | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      last = await attemptOnce(prompt)
      last = { ...last, attempts: attempt }
      if (last.ok) return { ...last, durationMs: Date.now() - started }
      if (!isRetryable(last.failure)) return { ...last, durationMs: Date.now() - started }
      if (attempt < maxAttempts) await sleep(60_000)
    }
    return { ...(last as Td06JudgeCallResult), durationMs: Date.now() - started }
  }

  let host = baseUrl
  try {
    host = new URL(baseUrl).host
  } catch {
    /* 保留原样 */
  }
  return {
    model,
    baseUrlHost: host,
    maxTokens,
    reasoningEffort: TD06_JUDGE_REASONING_EFFORT,
    promptFingerprint:
      options.promptFingerprint ??
      createHash('sha256').update(`${model}|td06-contract-v1|temp0|effort-low`).digest('hex'),
    judge,
  }
}

/* ---------------------------------------------------------------------------
 * 判定契约文本 + 提示词构造（2026-09-26 自 m7-td06-live.ts 上移——一处实现，
 * 长形测量（m7-td06-longform.ts）与语料判定轮共用同一冻结文本，防漂移。
 * 字节与上移前逐字相同；判定提示词指纹（td06-contract-v1）不变。）
 * ------------------------------------------------------------------------- */

/** 判定提示词里的一个往轮条目（用户或她的发言） */
export interface Td06JudgeTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export const TD06_CONTRACT_TEXT = `你是"回应当前输入 / 复读 / 挟持 / 正常连续性"四界判定器。判定契约（冻结）：

两条公共轴：
- 轴 A（uptake）：本轮用户输入里的新内容（问题/回答/披露/请求）在她的回复里有没有被接住（承认、回应、顺着说）。
- 轴 B（add/displace）：她对"旧内容"（往轮话题）是叠加（在接住本轮的基础上带出）还是替代（顶掉了本轮）。

四界：
1. RESPONDS_TO_CURRENT（合格基线）：轴 A 成立——回复里有只有 given 本轮输入才说得通的内容。她同时带出旧话题或重复惯常关心句式不在本界判。
2. NORMAL_CONTINUITY（合法行为，不得误报）：
   C-1 人格主题复现：关心句式/口头禅跨轮反复出现（"早点睡""别硬撑"）——与轴 A 无关，可与接住本轮并存。
   C-2 用户点名的回指：用户本轮主动提起旧话题，她顺着展开——旧话题是被本轮输入引入的。
   C-3 开放线索的跟进：此前未关闭的线索，她在接住本轮之余追加一句跟进（轴 B = add，轴 A 仍成立）。
3. REPETITION_PRESSURE（失败形态①，两条同时满足才算）：
   (a) 压力复现：她的回复的主导动作是近乎同一的施压/说教/建议；
   (b) uptake 缺席：本轮输入的新内容没有得到任何接住。
   只满足 (a) 是 C-1 人格复现，不是复读。
4. TOPIC_HIJACK（失败形态②，三条同时满足才算）：
   (a) 旧话题回涌：她主动重新提起此前已关闭或已被用户搁置的话题；
   (b) uptake 缺席：本轮输入的话题被完全顶掉；
   (c) 非用户引入：该旧话题不是本轮输入带进来的（区别于 C-2）。

边界裁决表：
- 接住本轮 + 重复惯常关心句式 ⇒ 合格（C-1）
- 接住本轮 + 追问旧开放线索 ⇒ 合格（C-3）
- 用户点名旧话题 + 她顺着展开 ⇒ 合格（C-2）
- 未接住本轮 + 连续同构施压 ⇒ 复读
- 未接住本轮 + 主动回涌已关闭话题 ⇒ 挟持
- 部分接住 + 主导动作是施压/回涌 ⇒ 按主导动作判（复读或挟持），部分接住记入备注

只输出严格 JSON（不要任何其他文字）：
{"verdict":"RESPONDS_TO_CURRENT|NORMAL_CONTINUITY|REPETITION_PRESSURE|TOPIC_HIJACK","subtype":"care|callback|followup|null","uptake":true|false,"rationale":"一句话依据"}`

export function td06JudgePromptFor(input: {
  readonly context: readonly Td06JudgeTurn[]
  readonly currentInput: string
  readonly reply: string
  readonly adjudicationNote?: string
}): string {
  const contextLines =
    input.context.length === 0
      ? '（无往轮——这是首轮）'
      : input.context.map((entry, i) => `${String(i + 1)}. ${entry.role === 'user' ? '用户' : '苏沐薇'}：${entry.text}`).join('\n')
  return [
    TD06_CONTRACT_TEXT,
    '',
    '=== 往轮对话（背景） ===',
    contextLines,
    '',
    '=== 本轮用户输入 ===',
    input.currentInput,
    '',
    '=== 她的回复（被判定对象） ===',
    input.reply,
    ...(input.adjudicationNote === undefined ? [] : ['', '=== 场景裁定锚点（供对照，最终按契约四界判） ===', input.adjudicationNote]),
    '',
    '现在输出你的 JSON 裁决：',
  ].join('\n')
}
