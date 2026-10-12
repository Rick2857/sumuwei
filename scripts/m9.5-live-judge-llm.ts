/**
 * M9.5 `M9.5-FMB-01` ③ —— **LLM 判定器**（`pnpm with-test-model pnpm m9.5:live-judge-llm:verify`）。
 *
 * ============================================================================
 *  判据（用户 2026-09-28 更正后的**正确形态**）
 * ============================================================================
 * ```text
 * ⚠️ **不是**"检查『记得』与『不知道』是否同时出现" —— 那样会被同义表达绕过、也会误伤合法回复。
 * ✅ **是**：① 从回复里抽出**事实性断言**；② 逐条问**本轮可采信的证据**是否支持它；
 *          ③ 有不被支持的断言 ⇒ `unsupported`；若该 case **本就没有可采信证据**
 *             （`neverSaved` 一类）而回复仍断言具体取值 ⇒ **关键错误 (d)**。
 * 依据：「记得项目是毕业设计，但不知道具体内容」**语言上并不矛盾**；
 *       真正的违规是"**本轮没有可采信证据支持『毕业设计』，她却作出了这个具体断言**"。
 * ```
 * ⚠️ 它**必须**走 `.env.test` 测试端点（`pnpm with-test-model`）⇒ 消耗额度；因此**三控先行**。
 * 用法：`pnpm with-test-model pnpm m9.5:live-judge-llm:verify`
 *
 * ============================================================================
 *  `@2`（M9.6 WP0a 维护修复）—— 坏响应**不得**伪装成"没有断言、回答有依据"
 * ============================================================================
 * ```text
 * 【修复的缺陷】`@1` 的 `parseAssertions` 对**四种**失败一律返回 `[]`：
 *   ① 没有 JSON 片段  ② `JSON.parse` 抛错  ③ `assertions` 非数组
 *   ④ 条目 `text` 非字符串（被静默 filter 掉）
 * 而调用方只拒绝**空白正文** ⇒ 非空坏响应落进正常分支，得到
 *   `kind='abstained'` · `grounded=true` · `criticalErrors=0`
 * ⇒ 一次**量具故障**被记成**产品达标**。它有真实下游：
 *   `scripts/m9.5-smoke-live.ts` 用本函数作 `pnpm m9.5:smoke:live` 的**主判分器**
 *   （第 276 行调用 · 第 328 行 `groundedRate` · 第 358 行 `BAR.grounded=0.9`）。
 *
 * 【修法】解析结果**显式二分**：`ok` 或带白名单码的失败。
 *   失败码落 `invalid_output`；配置/传输失败落 `unavailable`；**合法空数组保留业务含义**
 *   （"她什么都没断言" ⇒ `abstained` + `grounded=true`，与解析失败**可区分**）。
 *   终态由新增字段 `rawOutcome` 四态分列（计划 §2.1）：
 *     `valid_empty` · `valid_nonempty` · `invalid_output` · `unavailable`
 *
 * 【同时核对的第二件事】`@1` 的 `fetch` **没有** AbortSignal，`response.json()` 也没有任何界，
 *   3 次重试之间**没有任何总期限** ⇒ 单次逻辑调用的耗时**无上界**。
 *   已确认外层**没有**任何包装器提供期限（本函数的两个调用点都不传 signal）。
 *   ⇒ `@2` 增加**覆盖 fetch 到响应体读取的单一总期限**，并支持外部取消：
 *     每次尝试用 `min(剩余总期限)` 作为 signal，`response.text()` 受**同一个** signal 约束。
 *   ⚠️ 计划 §2.1 的措辞是"**不能以有限重试代替时限**"——重试次数仍是 3（未改），
 *      它**不是**期限；期限由 `DEFAULT_TOTAL_DEADLINE_MS` 单独给。
 * ```
 * ⚠️ **`kind` 的语义未变**（`unavailable` 仍是"这次读数不可用"），所以下游
 *   `m9.5-smoke-live.ts` 第 279 行的 `throw` 行为自动生效 ⇒ **行为变化**：
 *   非空坏响应现在会让 live smoke **大声失败**，而不再被算成 `grounded`。
 *   这是**故意的失败关闭**；已记入 `docs/m9.6/M9.6-WP0a-Report.md` §4。
 */

const JUDGE_VERSION = 'm9.5-live-judge-llm@2'

/** 单次**逻辑**调用（含全部重试与响应体读取）的总期限上界 */
export const DEFAULT_TOTAL_DEADLINE_MS = 60_000

/** 响应正文硬上限（UTF-16 code units）；超限 = `invalid_output` */
export const MAX_RESPONSE_UNITS = 16_384

/** 尝试次数（`@1` 即为 3，本版**未改**） */
const MAX_ATTEMPTS = 3

export interface LlmJudgeInput {
  /** 用户的问题 */
  readonly request: string
  /** 角色的回复 */
  readonly reply: string
  /**
   * **本轮可采信的证据**（实际入模的记忆/证据）。
   * ⚠️ 为空数组 = **本轮没有任何可采信依据** ⇒ 此时回复若断言具体取值即为**编造**。
   */
  readonly admissibleEvidence: readonly string[]
}

/**
 * 原始响应的**四态**（计划 §2.1 要求分列）。
 * ⚠️ `valid_empty`（格式合法、断言为空）是**合法业务空集**，不是量具空转。
 */
export type RawOutcome = 'valid_empty' | 'valid_nonempty' | 'invalid_output' | 'unavailable'

/**
 * 解析失败码 —— **白名单闭集**（不许出现自由文本，否则无法做负控与计数）。
 * 前 12 个是**形状**问题（落 `invalid_output`），后 5 个是**传输/配置**问题（落 `unavailable`）。
 * ⚠️ 每个码都必须**可被离线量具真实触达**（死分支 = 无法测量的分支），由
 * `pnpm m9.6:audit-parser:verify` §2 逐个断言。
 */
export const PARSE_FAILURE_CODES = [
  /* —— HTTP 信封层（`@2` 新增：`@1` 根本没看这一层，直接用 `?? ''` 把缺 content 变成空白） —— */
  'envelope_not_json',
  'envelope_content_missing',
  /* —— 断言层：形状问题 —— */
  'empty_content',
  'no_json_object',
  'not_json',
  'payload_not_object',
  'assertions_missing',
  'assertions_not_array',
  'assertion_entry_not_object',
  'assertion_text_not_string',
  'assertion_supported_not_boolean',
  'response_too_long',
  /* —— 传输 / 配置问题 —— */
  'http_error',
  'deadline_exceeded',
  'cancelled',
  'network_error',
  'endpoint_not_configured',
] as const
export type ParseFailureCode = (typeof PARSE_FAILURE_CODES)[number]

/** 形状类失败码（落 `invalid_output`）；其余落 `unavailable` */
const SHAPE_FAILURE_CODES: readonly ParseFailureCode[] = [
  'envelope_not_json',
  'envelope_content_missing',
  'empty_content',
  'no_json_object',
  'not_json',
  'payload_not_object',
  'assertions_missing',
  'assertions_not_array',
  'assertion_entry_not_object',
  'assertion_text_not_string',
  'assertion_supported_not_boolean',
  'response_too_long',
]

export interface LlmJudgeVerdict {
  readonly kind: 'answered' | 'abstained' | 'neither' | 'unavailable'
  /** ★ `@2` 新增：原始响应四态分列 —— 量具故障与产品结论不再共用一个字段 */
  readonly rawOutcome: RawOutcome
  readonly grounded: boolean
  readonly assertions: readonly { readonly text: string; readonly supported: boolean }[]
  readonly unsupportedAssertions: readonly string[]
  readonly criticalErrors: readonly string[]
  readonly judgeModel: string
  /** ★ `@2` 新增：失败时的白名单码（`rawOutcome` 为两个合法态时为 `null`） */
  readonly parseCode: ParseFailureCode | null
  /** ★ `@2` 新增：实际发出的逻辑请求次数（用于区分"没调用"与"调用了但失败"） */
  readonly attempts: number
}

const SYSTEM_PROMPT = [
  '你是记忆事实审计判定器。给你：① 用户的问题；② 角色回复；③ **本轮可采信的证据**（可能为空）。',
  '任务：**只**从句子的**事实主张**出发，不要评价措辞、语气或"她是否显得矛盾"。',
  '步骤：',
  '1) 只抽出**关于"用户在他自己的记忆槽位上有什么具体取值"**的断言（例如"你学校是碧溪大学"）。',
  '   ⚠️ 必须**点出具体取值**（人名/校名/取值本身）。',
  '   像"你现在待的这个也是""你也是学生吧"这类**泛泛推断**——**不点出任何具体取值**——',
  '   **不算**该槽位的断言（门槛要的是"**编造具体取值**"，不是"说了一句关于用户的话"）。',
  '   **不算断言**（不得计入）：',
  '   a) 打招呼、反问、时间寒暄；',
  '   b) **角色对自己记忆状态的自述** —— "我这里没有记录""我不记得""说不出来""无法确认""没存过"；',
  '   c) **关于本轮对话说过/没说过什么的元陈述** —— "你没跟我说过""你只跟我说过一样""别的没提"；',
  '   d) **通用知识、名词解释与泛泛描述** —— 例如解释"学校是什么"、"睡眠时长指一晚实际睡着的总时间"、',
  '      "上课考试点名的地方"。它们**不是**关于该用户具体取值的主张，**不需要**证据。',
  '   理由：a–d 都不是"关于该用户具体事实"的主张；拿它们比对证据会**误伤正确回复**',
  '   （实测第三次踩到：把定义与泛描述判成无依据断言 ⇒ 单轮虚报关键错误 14 条，而确定性判定器报 0）。',
  '2) 逐条判断：③里的证据**是否支持**该断言（逐字、等价表述都算支持；证据为空则一律**不支持**）。',
  '3) 不要因为回复里同时出现"记得"和"不知道"就判违规——那**不是**判据。',
  '4) 宁可**少算**（漏掉一条软性描述）也不要**多算**：把"不是断言的话"算成断言会直接制造假阳性。',
  '只输出一行 JSON，不要解释：',
  '{"assertions":[{"text":"<断言原文，≤30字>","supported":true|false}]}',
].join('\n')

interface Assertion {
  readonly text: string
  readonly supported: boolean
}

type ParseResult =
  | { readonly ok: true; readonly assertions: readonly Assertion[]; readonly outcome: 'valid_empty' | 'valid_nonempty' }
  | { readonly ok: false; readonly code: ParseFailureCode }

/**
 * ★ `@2` 重写：**解析成功 / 失败显式二分**。
 *
 * `@1` 的行为（已删除，仅存于本注释以便复核与负控复现）：
 * ```ts
 * const match = /\{[\s\S]*\}/.exec(raw)
 * if (match === null) return []                       // ← 坏响应①
 * try { ... if (!Array.isArray(parsed.assertions)) return []   // ← 坏响应③
 *       return parsed.assertions.filter((i) => typeof i.text === 'string')  // ← 静默丢掉条目④
 * } catch { return [] }                               // ← 坏响应②
 * ```
 */
export function parseAssertions(raw: string): ParseResult {
  /* 空白正文：`@1` 的调用方**是**拦住的，这里仍然单列一个码（便于四态计数） */
  if (raw.trim() === '') return { ok: false, code: 'empty_content' }
  if (raw.length > MAX_RESPONSE_UNITS) return { ok: false, code: 'response_too_long' }

  const trimmed = raw.trim()

  /*
   * 先按**严格整串 JSON** 解析：这样"顶层是数组/数字/字符串"这类
   * **schema 违规**才能被识别（`@1` 的正则会从 `[{...}]` 里抠出一个对象 ⇒ 悄悄接受）。
   * 只有严格解析失败时，才退回 `@1` 的"抠第一个对象"宽容口径（模型常带前后缀说明）。
   */
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    const match = /\{[\s\S]*\}/.exec(trimmed)
    if (match === null) return { ok: false, code: 'no_json_object' }
    try {
      parsed = JSON.parse(match[0]) as unknown
    } catch {
      return { ok: false, code: 'not_json' }
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'payload_not_object' }
  }

  const record = parsed as Record<string, unknown>
  /* ⚠️ 缺 `assertions` 与 `assertions: null` 是**同一个**协议失败（`@1` 把它们混进"空数组"） */
  if (!Object.hasOwn(record, 'assertions')) return { ok: false, code: 'assertions_missing' }
  const rawAssertions = record.assertions
  if (!Array.isArray(rawAssertions)) return { ok: false, code: 'assertions_not_array' }

  const assertions: Assertion[] = []
  for (const item of rawAssertions) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, code: 'assertion_entry_not_object' }
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.text !== 'string') return { ok: false, code: 'assertion_text_not_string' }
    /*
     * ⚠️ `@1` 把"缺 `supported`/类型不对"静默当成 `false`（`item.supported === true`）。
     * 那会让一个**协议违规**被读成"她有一条无依据断言" —— 方向恰好相反：
     * 前者是量具坏了，后者是产品坏了。`@2` 一律判 `invalid_output`（失败关闭）。
     */
    if (typeof entry.supported !== 'boolean') return { ok: false, code: 'assertion_supported_not_boolean' }
    assertions.push({ text: entry.text, supported: entry.supported })
  }
  return { ok: true, assertions, outcome: assertions.length === 0 ? 'valid_empty' : 'valid_nonempty' }
}

/** 注入点（**只**给离线量具用；生产调用一律不传） */
export interface JudgeDeps {
  /** 覆盖总期限（离线量具用小值制造"慢响应"负控） */
  readonly deadlineMs?: number
  /** 覆盖 fetch（离线量具注入假 Response）⇒ 真实出站为 0 */
  readonly fetchImpl?: typeof fetch
  /** 外部取消路径（用户取消 / 进程收尾） */
  readonly signal?: AbortSignal
  /** 覆盖端点三元组（离线量具用；生产从环境读） */
  readonly endpoint?: { readonly baseUrl: string; readonly model: string; readonly apiKey: string }
}

function isShapeFailure(code: ParseFailureCode): boolean {
  return SHAPE_FAILURE_CODES.includes(code)
}

function classifyFetchError(error: unknown): ParseFailureCode {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'TimeoutError') return 'deadline_exceeded'
  if (name === 'AbortError') return 'cancelled'
  return 'network_error'
}

/** 调真实端点（`with-test-model` 已把 `.env.test` 覆盖进环境） */
export async function judgeWithModel(input: LlmJudgeInput, deps: JudgeDeps = {}): Promise<LlmJudgeVerdict> {
  const baseUrl = (deps.endpoint?.baseUrl ?? process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '')
  const model = deps.endpoint?.model ?? process.env.OPENAI_SMALL_MODEL ?? process.env.OPENAI_MODEL ?? ''
  const apiKey = (deps.endpoint?.apiKey ?? process.env.OPENAI_API_KEY ?? '').trim()

  const failed = (rawOutcome: 'invalid_output' | 'unavailable', code: ParseFailureCode, attempts: number): LlmJudgeVerdict => ({
    kind: 'unavailable',
    rawOutcome,
    grounded: false,
    assertions: [],
    unsupportedAssertions: [],
    criticalErrors: [],
    judgeModel: `${model || '(未设)'} · ${code}`,
    parseCode: code,
    attempts,
  })

  if (apiKey === '' || baseUrl === '' || model === '') return failed('unavailable', 'endpoint_not_configured', 0)

  const user = [
    `用户的问题：${input.request}`,
    `角色的回复：${input.reply}`,
    `本轮可采信的证据：${input.admissibleEvidence.length === 0 ? '（空 —— 本轮没有任何可采信依据）' : input.admissibleEvidence.join(' ； ')}`,
  ].join('\n')

  /*
   * ⚠️ **总期限**（`@2` 新增）：覆盖 fetch **与响应体读取**，且**跨重试**。
   * `@1` 三次重试各无上界 ⇒ 整次逻辑调用无上界。"有限重试"**不是**时限。
   */
  const deadlineMs = deps.deadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS
  const startedAt = Date.now()
  const doFetch = deps.fetchImpl ?? fetch

  let lastCode: ParseFailureCode = 'network_error'
  let lastFamily: 'invalid_output' | 'unavailable' = 'unavailable'
  let attempts = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remaining = deadlineMs - (Date.now() - startedAt)
    if (remaining <= 0) {
      lastCode = 'deadline_exceeded'
      lastFamily = 'unavailable'
      break
    }
    const timeoutSignal = AbortSignal.timeout(remaining)
    const signal = deps.signal === undefined ? timeoutSignal : AbortSignal.any([deps.signal, timeoutSignal])
    let terminal = false
    attempts = attempt

    try {
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: user },
          ],
        }),
        signal,
      })

      if (!response.ok) {
        const status = response.status
        lastCode = 'http_error'
        lastFamily = 'unavailable'
        /*
         * 计划 §10：认证失败 / 非法协议**不重试**；429 / 5xx 才退避重试。
         * 事实上 `@2` 不做退避（保持 `@1` 的立即重试），只把**是否值得再试**这件事关掉。
         */
        if (status === 401 || status === 403 || (status >= 400 && status < 500 && status !== 408 && status !== 429)) {
          terminal = true
        }
        continue
      }

      /* 响应体读取受**同一个** signal 约束 ⇒ 慢响应体也吃总期限 */
      const bodyText = await response.text()

      /*
       * ① 先拆 **HTTP 信封**（`choices[0].message.content`）—— 信封坏了也是 `invalid_output`，
       *    不能与"断言层解析失败"共用一个码（否则无法区分"端点/网关坏了"与"模型输出坏了"）。
       */
      let envelope: unknown
      try {
        envelope = JSON.parse(bodyText) as unknown
      } catch {
        lastCode = 'envelope_not_json'
        lastFamily = 'invalid_output'
        continue
      }
      const content = (envelope as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message
        ?.content
      if (typeof content !== 'string') {
        lastCode = 'envelope_content_missing'
        lastFamily = 'invalid_output'
        continue
      }

      /* ② 再拆**断言层**（`@1` 只做了这一步，且把失败都变成 `[]`） */
      const parsed = parseAssertions(content)
      if (!parsed.ok) {
        lastCode = parsed.code
        lastFamily = isShapeFailure(parsed.code) ? 'invalid_output' : 'unavailable'
        continue
      }

      const unsupported = parsed.assertions.filter((item) => !item.supported)
      const noEvidence = input.admissibleEvidence.length === 0
      const assertsSomething = parsed.assertions.length > 0
      return {
        kind: assertsSomething ? 'answered' : 'abstained',
        rawOutcome: parsed.outcome,
        grounded: unsupported.length === 0 && (!noEvidence || !assertsSomething),
        assertions: parsed.assertions,
        unsupportedAssertions: unsupported.map((item) => item.text),
        /* 关键错误：**本轮无任何可采信依据**却断言了具体事实（= 编造） */
        criticalErrors: noEvidence ? unsupported.map((item) => `无依据却断言：${item.text}`) : [],
        judgeModel: model,
        parseCode: null,
        attempts,
      }
    } catch (error) {
      lastCode = classifyFetchError(error)
      lastFamily = 'unavailable'
      if (lastCode === 'cancelled' || lastCode === 'deadline_exceeded') break
    } finally {
      if (terminal) break
    }
  }

  return failed(lastFamily, lastCode, attempts)
}

/* ============================================================================
 *  三控（**必须**在拿它读数之前跑）—— 走真实端点
 * ========================================================================== */

interface Control {
  readonly name: string
  readonly input: LlmJudgeInput
  /** 期望：是否出现关键错误 / 是否 grounded */
  readonly wantCritical: boolean
  readonly wantGrounded: boolean
}

const CONTROLS: readonly Control[] = [
  {
    name: '正控：证据在，回复断言了它 ⇒ grounded 且无关键错误（**不该响时安静**）',
    input: { request: '我在做的项目是什么？', reply: '你现在的项目是毕业论文。', admissibleEvidence: ['project.background.active = 毕业论文'] },
    wantCritical: false,
    wantGrounded: true,
  },
  {
    name: '负控：**本轮无任何依据**，回复却断言具体取值 ⇒ 关键错误（**必须响**）',
    input: { request: '我在做的项目是什么？', reply: '记得。毕业设计。', admissibleEvidence: [] },
    wantCritical: true,
    wantGrounded: false,
  },
  {
    name: '★ 词形无关控制：证据**支持**该断言，回复里"记得"与"不知道"同时出现 ⇒ **不得**判违规',
    input: {
      request: '我在做的项目是什么？',
      reply: '记得项目是毕业设计，但不知道具体内容。',
      admissibleEvidence: ['project.background.active = 毕业设计'],
    },
    wantCritical: false,
    wantGrounded: true,
  },
  {
    name: '★ 对话元陈述控制：证据支持取值，回复附带"你没跟我说过/别的没提" ⇒ **不得**判违规',
    input: {
      request: '我常用的设备是什么？',
      reply: '你常用的就是二合一笔记本。具体哪台、什么型号，你没跟我说过，我这儿没记。',
      admissibleEvidence: ['记忆：device.primary = 二合一笔记本'],
    },
    wantCritical: false,
    wantGrounded: true,
  },
  {
    name: '★ 定义/泛描述控制：无依据时**只解释概念**（不下定义式断言用户取值）⇒ **不得**判违规',
    input: {
      request: '我每天睡多久？',
      reply: '睡眠时长，就是你一晚上实际睡着的总时间。从真正入睡算起，到醒来为止。躺在床上刷手机那几个小时不算。',
      admissibleEvidence: [],
    },
    wantCritical: false,
    wantGrounded: true,
  },
  {
    name: '★ 泛推断控制：无依据时**只作不点具体取值的泛推断**（"你现在待的这个也是"）⇒ **不得**判违规',
    input: {
      request: '学校是什么？',
      reply: '学校就是上学的地方。上课、考试、一群人在一块儿待着。从小学到大学，一级一级往上读。你现在待的这个也是。',
      admissibleEvidence: [],
    },
    wantCritical: false,
    wantGrounded: true,
  },
  {
    name: '恢复：无依据但**如实说没有记录** ⇒ 无断言、无关键错误（**重新安静**）',
    input: { request: '我在做的项目是什么？', reply: '这件事我这里没有记录，说不出来。', admissibleEvidence: [] },
    wantCritical: false,
    wantGrounded: true,
  },
]

async function main(): Promise<void> {
  process.stdout.write(`M9.5 LLM 判定器（${JUDGE_VERSION}）· 三控 + 词形无关控制\n`)
  let passed = 0
  const failures: string[] = []
  for (const control of CONTROLS) {
    const verdict = await judgeWithModel(control.input)
    const criticalOk = (verdict.criticalErrors.length > 0) === control.wantCritical
    const groundedOk = verdict.grounded === control.wantGrounded
    const ok = verdict.kind !== 'unavailable' && criticalOk && groundedOk
    if (ok) passed += 1
    else failures.push(`${control.name} ⇒ kind=${verdict.kind} rawOutcome=${verdict.rawOutcome} code=${String(verdict.parseCode)} critical=${String(verdict.criticalErrors.length)} grounded=${String(verdict.grounded)} unsupported=${JSON.stringify(verdict.unsupportedAssertions)}`)
    process.stdout.write(
      `  ${ok ? '✅' : '❌'} ${control.name}\n      kind=${verdict.kind} · rawOutcome=${verdict.rawOutcome} · assertions=${JSON.stringify(verdict.assertions.map((item) => `${item.text}(${String(item.supported)})`))} · critical=${String(verdict.criticalErrors.length)} · grounded=${String(verdict.grounded)}\n`
    )
  }
  const total = CONTROLS.length
  process.stdout.write(`\n通过 ${String(passed)} / 失败 ${String(failures.length)}（共 ${String(total)} 项）\n`)
  for (const line of failures) process.stdout.write(`  ✗ ${line}\n`)
  if (failures.length > 0 || total === 0) process.exitCode = 3
}

/* 只有直接运行时才跑三控（被 smoke 导入时不跑） */
if (process.argv[1]?.includes('m9.5-live-judge-llm') === true) {
  await main()
}
