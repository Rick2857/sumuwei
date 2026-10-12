/**
 * M5.5.1 WP3 —— **搜索需求判定器的端口与纯解析**（ADR-049 `R2` §11.1·§11.2）。
 *
 * ============================================================================
 *  这个文件里**没有**模型调用、没有网络、没有基础设施
 * ============================================================================
 * 它给出三样东西，全部是纯的：
 *
 *   ① 端口形状（`SearchNeedJudgePort`）—— 装配层注入一个实现，测试注入 fixture
 *   ② 固定指令与消息构造（`buildSearchNeedJudgeMessages`）—— prompt 是**程序常量**，
 *      不做字符串拼接式的"人设注入"，也不带记忆/历史/归因
 *   ③ 严格解析（`parseSearchNeedJudgeOutput`）—— 模型输出 → `SearchNeedProposal`，失败关闭
 *
 * ---------------------------------------------------------------------------
 *  三条纪律（每一条都有负控）
 * ---------------------------------------------------------------------------
 * 1. **判定器只看到"用户当前这一条发言"**。它看不到人设、记忆、检索到的历史、
 *    userId、traceId，也看不到候选是从哪条路径来的 —— 于是它**没得可偏**：
 *    既不能借上下文给自己找理由，也不能因为"这是用户显式要求的"就把私人对象判成公开。
 *    （`R2` §11.1 第 5/6 条：显式候选同样要过私人/禁止/引用/自述的边界。）
 * 2. **判定器有否决权，没有授权权**（`R2` §11.1 第 3 条）。它的输出**只能**是一份
 *    `SearchNeedProposal`：没有 `authorized`、没有 `mode`、没有端点、没有次数。
 *    决议由 `decideSearchNeed` + Policy + Gateway 做。
 * 3. **失败即零调用**：任何非 `search` 结论、超时、异常、坏 JSON、坏 span 都使该轮
 *    搜索调用数为 **0**，且**不得**回退到旧显式检测器执行（`R2` §11.2 第 ④ 步）。
 */

import { KernelError } from '../contracts/ids.ts'
import {
  SEARCH_NEED_REASONS,
  parseSearchNeedProposal,
  type SearchNeedProposal,
} from './search-need.ts'

/**
 * 判定失败的**闭集**理由码（进 trace 的诊断面；不含用户原文、不含模型解释）。
 *
 * ⚠️ 刻意不叫 `failed` 一个字：`timeout` / `call_failed` / `invalid_output` / `empty_text`
 *    在事后排查时是三件完全不同的事，混成一个码就等于没记。
 */
export const SEARCH_NEED_JUDGE_FAILURES = [
  'empty_text',
  'timeout',
  'call_failed',
  'invalid_output',
] as const
export type SearchNeedJudgeFailure = (typeof SEARCH_NEED_JUDGE_FAILURES)[number]

/**
 * 硬超时（毫秒）—— **判定调用**的超时（用户裁定 2026-09-20：10000 → 15000 → **25000**）。
 *
 * ⚠️ 它与 **SearXNG 搜索**的冻结超时（`D-31` 的 5000ms）是**两件事**：
 *    混在一句话里记，事后就分不清是哪一处超时（也不能与 `L-M55-12` 混用）。
 * ⚠️ 覆盖**整个判定调用（含响应体读取）**；到期即取消，失败即零搜索。
 * ⚠️ 真正的生效值来自配置 `CHARACTER_WEB_SEARCH_JUDGE_TIMEOUT_MS`（缺省见 `flags.ts`），
 *    这里只是"没有配置时"的兜底常量。
 */
export const SEARCH_NEED_JUDGE_TIMEOUT_MS = 25_000

/**
 * 判定调用的输出上限（token）。
 *
 * ⚠️ 它**不是**"给多了会招来长篇解释"这种口味问题 —— 实测（R2-3/R2-4）：
 *    800 会被**推理链全部吃光**（`completionTokens=reasoningTokens=800`、`finish_reason=length`、
 *    `content` 字段缺失 ⇒ 解析失败）。用户裁定 2026-09-20 方案 B 把它提到 **1600**。
 *    ⚠️ 提高它会让该调用**墙钟变长**（更多推理 token）⇒ 与判定超时**相互作用**，两者要一起看。
 */
export const SEARCH_NEED_JUDGE_MAX_TOKENS = 2_400

/**
 * **固定指令**（程序常量，逐字冻结）。
 *
 * ⚠️ 它不是"人设"、不是"她"在思考：这是一次**工具性判定**，输出的唯一消费者是
 *    程序（`parseSearchNeedProposal`）。因此这里刻意没有人格、没有称呼、没有情绪。
 */
export const SEARCH_NEED_JUDGE_INSTRUCTION = [
  '你是一个"是否需要联网查证"的判定器。你只判断下面这条用户发言是否需要外部公开资料才能回答。',
  '',
  '只输出一个 JSON 对象，不要输出任何其它文字，不要用代码块围栏。字段恰好是：',
  '  decision: "search" | "answer" | "clarify" | "deny_search"',
  '  reason: 下面清单里的一个值',
  '  querySpan: { "start": 整数, "end": 整数 }   // 仅当 decision 是 search 时给出',
  '',
  'decision 的含义：',
  '- search：需要时效性事实、最新消息，或用户明确要求查公开资料，且查询对象是公开可检索的。',
  '- answer：常识、闲聊、创作、翻译、代码，或对象的归属在用户自己身上（我的笔记 / 我的余额 / 我的日程 / 我的文件 / 我妈的情况）。',
  '- clarify：用户想查点什么，但**完全没有可检索的对象** —— 连"要查什么"都定不下来。',
  '- deny_search：用户明确禁止联网，或明确要求只根据已有知识回答。',
  '· "对象够不够"只按**能不能发起检索**判，**不**按"能不能一次给出唯一答案"判：',
  '  对象本身公开可检索 ⇒ 归 search。缺线路 / 站点 / 方向 / 日期 / 城市 / 具体子话题，',
  '  只影响"答案够不够精确"，**不影响该不该先去查**（例如"上海现在的地铁末班车时间"缺线路，仍应 search）。',
  '  只有当说话人连"查什么"都没给出（例如"这个算法是谁最早提出的"却没说是哪个算法）时，才归 clarify。',
  '· 引号或「」里的字句**本身不是搜索对象**：若用户是在问「这句话是什么意思」，那是 answer；',
  '  只有当他问的是**出处/来源**（源自哪里、谁先说的、哪本书）时，才归 search。',
  '',
  'querySpan 只能指向这条用户发言里的一个连续片段，而且只包含要检索的对象本身：',
  '不要带上称谓、其它分句，也不要带上手机号、证件号、住址、账号这类私人内容。',
  '',
  'reason 只能取以下之一：',
  SEARCH_NEED_REASONS.join(', '),
  '',
  '硬约束（逐条都能被机器校验；真实模型第一次运行就栽在这里）：',
  '· 你的回复**必须**是一个 JSON 对象，而且是**唯一**的输出内容：不要解释、不要前后缀文字、不要代码块围栏。',
  '· **字段随 decision 而定，多一个少一个整条判定都会被程序丢弃**（这是防注入的结构性要求，不是保守）：',
  '    · decision 是 "search" ⇒ 有且仅有三个字段：decision / reason / querySpan。',
  '    · decision 是 "answer" / "clarify" / "deny_search" ⇒ 有且仅有**两个**字段：decision / reason。**不要**给出 querySpan，也不要写 querySpan: null。',
  '· querySpan 必须是一个对象，形如 {"start":2,"end":6}，两个值都是整数且 start < end；它只能指向用户发言里的连续片段。',
  '· 正确示例（search）：{"decision":"search","reason":"time_sensitive_fact","querySpan":{"start":2,"end":6}}',
  '· 正确示例（answer）：{"decision":"answer","reason":"stable_knowledge"}',
].join('\n')

export interface SearchNeedJudgeMessage {
  role: 'system' | 'user'
  content: string
}

/**
 * 构造判定调用的消息（**只有两条**：固定指令 + 用户当前发言）。
 *
 * ⚠️ 这里**没有**第三个参数可以塞别的东西 —— 端口形状本身就是隐私边界：
 *    人设、记忆、历史、userId、traceId 在类型上就进不来（与 `search-port.ts` 同一手法）。
 */
export function buildSearchNeedJudgeMessages(text: string): SearchNeedJudgeMessage[] {
  return [
    { role: 'system', content: SEARCH_NEED_JUDGE_INSTRUCTION },
    { role: 'user', content: text },
  ]
}

/**
 * 从模型输出里取出那个 JSON 对象。
 *
 * 只容忍两件事（真实端点的常见包装），其余一律失败关闭：
 *   · 代码块围栏（```json … ```）
 *   · 对象前后有少量说明文字
 *
 * ⚠️ **不**做"猜字段"、**不**补默认值、**不**把 `"search"` 之外的近义词映射过来。
 *    一个被宽容解释过的判定等于没有判定。
 */
export function extractSearchNeedJudgeJson(raw: string): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new KernelError('validation_error', 'search_need_judge_empty', '判定器返回了空内容')
  }
  const withoutFence = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new KernelError(
      'validation_error',
      'search_need_judge_no_json_object',
      '判定器输出里找不到一个 JSON 对象'
    )
  }
  try {
    return JSON.parse(withoutFence.slice(start, end + 1))
  } catch {
    throw new KernelError('validation_error', 'search_need_judge_bad_json', '判定器输出的 JSON 解析失败')
  }
}

/**
 * 解析判定器的输出（**失败关闭**）。
 *
 * 解析链是刻意分两步的：先取出 JSON 对象，再交给 `parseSearchNeedProposal` 做形状校验
 * （未知字段、枚举、span 的存在性与整数性都在那里）。**这里不重复实现一遍校验** ——
 * 两份校验迟早会分叉，而分叉的那一天就是"模型塞进去的 `authorized: true` 被放过"的那一天。
 */
export function parseSearchNeedJudgeOutput(raw: string): SearchNeedProposal {
  return parseSearchNeedProposal(extractSearchNeedJudgeJson(raw))
}

/** 判定调用的一次结果（**同样带请求数**：超时也是发生过一次请求的） */
export interface SearchNeedJudgeInput {
  /** **当前用户发言**（逐字；判定器只能看这一条） */
  text: string
  /** 调用方的取消信号（实现必须把它与自己的硬超时**合并**，不是二选一） */
  signal?: AbortSignal
}

/**
 * 判定失败的**形状**（**只记"有没有 / 多大 / 几个"，不含任何文本**）。
 *
 * ⚠️ 它存在的理由是一次真实故障：WP7 两次真实运行的结构化输出合法率都只有 ~37%，
 *    而证据里刻意不记模型原始输出（防泄漏）⇒ **看不见失败长什么样**，
 *    于是只能猜。加这一层是为了让"猜"变成"读"：
 *    `contentLength=0` + `reasoningContentLength>0` 是"思维链把 token 吃光"的签名，
 *    而 `contentLength>0` 才是"模型答了但形状不对"。
 *    ⚠️ 三个字符数都是**长度**，不是内容 —— 长度不会泄漏用户文本。
 */
export interface SearchNeedJudgeShape {
  /** HTTP 状态（0 = 没发出请求或连接层失败） */
  httpStatus: number
  /** 返回了几个 choice */
  choiceCount: number
  /** `choices[0]` 是否存在（"缺失"与"有但空"是两件事） */
  messagePresent: boolean
  /** `content` 的**闭集**种类（R2-2） */
  contentKind: JudgeContentKind
  /** `choices[0].message.content` 的字符数（0 = 空；种类见 `contentKind`） */
  contentLength: number
  /** 是否存在 `reasoning_content` 字段（该端点不返回它 ≠ 没有推理） */
  reasoningPresent: boolean
  /** `choices[0].message.reasoning_content` 的字符数 */
  reasoningContentLength: number
  /** 端点报的结束原因（**闭集**；不认识的一律 `other`，不回显原文） */
  finishReason: JudgeFinishReason
  /** 返回里的 tool-call 数量（**不记工具名与参数**） */
  toolCallCount: number
  /** 是否存在 refusal 字段（**不记其文本**） */
  refusalPresent: boolean
  /** `usage.completion_tokens`；**不可得记 `null`**（不许伪装成 0） */
  completionTokens: number | null
  /** 推理 token 数（若端点给）；不可得记 `null` */
  reasoningTokens: number | null
  /*
   * 阶段耗时（**毫秒整数**；-1 = 没走到那一步）。
   * ⚠️ 真实故障现场：144 次 timeout，但"响应慢 / 排队 / 连接 / 读体 / 上游推理"哪一项主导
   *    **现有计时区分不了**。这三个值只回答"走到哪一步、各花多久"，**不含任何文本**。
   * ⚠️ 尚未收到 headers 的那段耗时**不能**被细分命名（DNS / 排队 / 推理都只是猜测）。
   */
  headersMs: number
  bodyMs: number
  totalMs: number
  /** `Retry-After` 解析后的毫秒（有上限；-1 = 没有该头或解析不出） */
  retryAfterMs: number
}

/**
 * `content` 的**闭集**种类（R2-2）。
 *
 * ⚠️ 上一版只有一个 `contentLength`，于是 `content_not_string` 这**一个**码把
 *    `null` / 缺失 / 数组 / 对象全糊在一起 —— 而它们的根因与修法**完全不同**。
 *    收敛成闭集才能在**不记文本**的前提下区分它们。
 */
export const JUDGE_CONTENT_KINDS = ['missing', 'null', 'string', 'array', 'object', 'other'] as const
export type JudgeContentKind = (typeof JUDGE_CONTENT_KINDS)[number]

/**
 * `finish_reason` 的**闭集**（R2-2）。
 *
 * ⚠️ 上一版**原样保留**端点给的任意字符串 —— 那是把外部文本写进证据的入口
 *    （端点理论上可以把它做成任何东西）。未知值现在一律折成 `other`。
 */
export const JUDGE_FINISH_REASONS = [
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'function_call',
  'missing',
  'other',
] as const
export type JudgeFinishReason = (typeof JUDGE_FINISH_REASONS)[number]

/** 把端点的任意 `finish_reason` 收敛进闭集（不认识的一律 `other`，**不回显原文**） */
export function toJudgeFinishReason(raw: unknown): JudgeFinishReason {
  if (raw === undefined || raw === null) return 'missing'
  return typeof raw === 'string' && (JUDGE_FINISH_REASONS as readonly string[]).includes(raw)
    ? (raw as JudgeFinishReason)
    : 'other'
}

/** 把 `content` 收敛成闭集种类（**不看内容**，只看类型与存在性） */
export function toJudgeContentKind(content: unknown, present: boolean): JudgeContentKind {
  if (!present) return 'missing'
  if (content === null) return 'null'
  if (typeof content === 'string') return 'string'
  if (Array.isArray(content)) return 'array'
  if (typeof content === 'object') return 'object'
  return 'other'
}

/**
 * 安全解析失败码（**闭集 + 白名单**）。
 *
 * ⚠️ 只允许两种来源：① 解析器自己的 `KernelError.code`（已在白名单里）
 *    ② 统一兜底 `unknown_parse_failure`。
 *    **禁止**把 `error.message` / `details` / `stack` / 模型生成的任意键名或值写进来 ——
 *    它们都可能夹带用户正文（M5.5 的泄漏面纪律）。
 */
export const SEARCH_NEED_PARSE_CODES = [
  'search_need_judge_empty',
  'search_need_judge_no_json_object',
  'search_need_judge_bad_json',
  'search_need_judge_response_not_json',
  'search_need_judge_no_choice',
  'search_need_judge_content_not_string',
  'search_need_proposal_not_object',
  'search_need_proposal_unknown_field',
  'search_need_proposal_bad_decision',
  'search_need_proposal_bad_reason',
  'search_need_proposal_missing_span',
  'search_need_proposal_unexpected_span',
  'search_need_span_unknown_field',
  'search_need_span_not_integer',
  'search_need_span_out_of_range',
  'search_need_span_empty',
  'unknown_parse_failure',
] as const
export type SearchNeedParseCode = (typeof SEARCH_NEED_PARSE_CODES)[number]

/** 把任意解析异常压成**白名单里的码**（不认识的一律 `unknown_parse_failure`） */
export function toSafeParseCode(error: unknown): SearchNeedParseCode {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && (SEARCH_NEED_PARSE_CODES as readonly string[]).includes(code)
    ? (code as SearchNeedParseCode)
    : 'unknown_parse_failure'
}

/**
 * 传输层结论（**由失败码派生，不由调用方猜**）。
 *
 * ⚠️ 这里是一次真实事故的落点：量具曾经把 `invalid_output` 也标成 `transport = true`，
 *    于是**解析失败被算成传输失败**，正好把真正的根因掩盖掉。
 *    "没答"（timeout / 连接 / HTTP 错误）与"答歪了"（解析失败）是两件事，永远分开。
 */
export type SearchNeedTransportOutcome =
  | 'not_attempted'
  | 'ok'
  | 'timeout'
  | 'http_error'
  | 'connection_error'

export function transportOutcomeOf(failure: SearchNeedJudgeFailure, httpStatus: number): SearchNeedTransportOutcome {
  switch (failure) {
    case 'empty_text':
      return 'not_attempted'
    case 'timeout':
      return 'timeout'
    case 'call_failed':
      return httpStatus > 0 ? 'http_error' : 'connection_error'
    case 'invalid_output':
      // 解析失败**不是**传输失败：HTTP 是成功的，模型也答了，只是形状不合约
      return 'ok'
  }
}

export type SearchNeedJudgeOutcome =
  | {
      ok: true
      proposal: SearchNeedProposal
      requestCount: number
      /** 成功的调用也带形状（阶段耗时）—— 诊断需要"成功那次花了多久" */
      shape?: SearchNeedJudgeShape
    }
  | {
      ok: false
      failure: SearchNeedJudgeFailure
      requestCount: number
      shape?: SearchNeedJudgeShape
      /** 安全解析失败码（白名单闭集；只有 `invalid_output` 时才有） */
      parseFailureCode?: SearchNeedParseCode
    }

/**
 * 判定器端口。
 *
 * ⚠️ 端口上**只有** `judge` 一个方法，入参只有 `text` / `signal`：
 *    没有"候选来源"、没有模式、没有提示词槽位 —— 判定器的输入面越小，
 *    它被上层"喂成想要的样子"的空间就越小。
 */
export interface SearchNeedJudgePort {
  /** 实现标识（进 trace 诊断面；形如 `openai-chat-completions` / `fixture-judge`） */
  readonly id: string
  /** 只用于诊断的 endpoint host（**绝不含凭证**） */
  readonly endpointHost: string
  /** 一次有界判定。**必须**只用 `SearchNeedJudgeInput` 里的字段 */
  judge(input: SearchNeedJudgeInput): Promise<SearchNeedJudgeOutcome>
}

/** 便于诊断的一行摘要（不含 key、不含用户文本） */
export function describeSearchNeedJudge(judge: { id: string; endpointHost: string }): string {
  return `search-need judge = ${judge.id} @ ${judge.endpointHost}`
}
