/**
 * M5.5.1 WP2 —— **搜索需求提案的纯契约与纯策略**（ADR-049 `D551-1`…`D551-5`）。
 *
 * ============================================================================
 *  这个文件里**没有**模型调用、没有网络、没有基础设施
 * ============================================================================
 * 它只回答两个问题，而且都必须是**纯函数**（同样的输入必得同样的结论）：
 *
 *   ① **这份提案合法吗**（`parseSearchNeedProposal`）—— 失败关闭，形状从严
 *   ② **它能不能变成一次执行**（`decideSearchNeed`）—— 授权只来自程序事实
 *
 * ⚠️ 第 ② 条是整条链上最要紧的一处：**模型提案不能给自己授权**。
 *    因此 `decideSearchNeed` 的入参里**只有**程序侧的事实（模式、总开关、限额、
 *    本地动作是否已触发），**提案本身无法影响**任何一个 —— 并且
 *    `parseSearchNeedProposal` 会**拒绝未知字段**，所以"在提案里塞一个
 *    `authorized: true` / `mode: 'auto_public'`"这种偷渡在类型与运行期都过不来。
 *
 * 与既有裁定的关系（ADR-049 §0）：`explicit`（缺省）与 M5.5 的
 * `INV-M55-03` **完全一致** —— 无明确请求 ⇒ 零搜索调用；只有 `auto_public`
 * 才放行"模型提议"这一条**新增**路径，而执行仍只由 Policy + 唯一 Gateway 放行。
 */

import { KernelError } from '../contracts/ids.ts'

/** 提案的四种结论（`D551-3`；`reason` 只用于诊断与评测，**不具授权能力**） */
export const SEARCH_NEED_DECISIONS = ['answer', 'search', 'clarify', 'deny_search'] as const
export type SearchNeedDecision = (typeof SEARCH_NEED_DECISIONS)[number]

/**
 * 允许的诊断理由（**枚举**，不是自由文本）。
 *
 * ⚠️ 刻意用枚举而不是 `string`：ADR-049 §5 只允许"枚举 / 版本 / 模式 / 引用 / 理由码 /
 *    计数 / 耗时"进诊断面 —— 一个自由文本字段迟早会被人塞进模型解释或用户原文。
 */
export const SEARCH_NEED_REASONS = [
  'time_sensitive_fact',
  'latest_news',
  'explicit_public_sourcing',
  'stable_knowledge',
  'chitchat_or_creative',
  'private_object',
  'negated_or_forbidden',
  'quoted_or_metalinguistic',
  'self_reported',
  'missing_subject',
  'ambiguous_scope',
  'local_action_preferred',
  'adversarial_input',
] as const
export type SearchNeedReason = (typeof SEARCH_NEED_REASONS)[number]

/** 查询片段：**当前用户文本**里的一个连续区间 `[start, end)`（`D551-3`） */
export interface QuerySpan {
  start: number
  end: number
}

export interface SearchNeedProposal {
  decision: SearchNeedDecision
  reason: SearchNeedReason
  /** **仅** `decision === 'search'` 时存在 */
  querySpan?: QuerySpan
}

/** 允许的模式（`D551-2`）；缺省 `explicit` = 与 M5.5 语义完全一致 */
export const SEARCH_MODES = ['explicit', 'auto_public'] as const
export type SearchMode = (typeof SEARCH_MODES)[number]

/** 每轮上限（`D551-4`）：判定调用 1 次、provider 调用 1 次，显式与自动**共享** */
export const SEARCH_NEED_LIMITS = {
  maxJudgeCallsPerTurn: 1,
  maxProviderCallsPerTurn: 1,
} as const

/**
 * 候选来源（**程序事实**，`R2` §11.1 第 2/4 条）。
 *
 * ⚠️ 这个字段**不是**模型能填的东西：它由装配层根据"程序自己检出了什么"给出。
 *    模型在提案里写 `reason: 'explicit_public_sourcing'` **不等于**候选来自显式请求 ——
 *    `R2` §11.1 第 4 条逐字：那个 reason"不是显式授权凭据，不得借它把自动提案升级成用户指令"。
 */
export const SEARCH_CANDIDATE_SOURCES = ['explicit_request', 'auto_proposal'] as const
export type SearchCandidateSource = (typeof SEARCH_CANDIDATE_SOURCES)[number]

const PROPOSAL_FIELDS: readonly string[] = ['decision', 'reason', 'querySpan']
const SPAN_FIELDS: readonly string[] = ['start', 'end']

function invalid(code: string, message: string): KernelError {
  return new KernelError('validation_error', code, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseIntInRange(value: unknown, what: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalid('search_need_span_not_integer', `${what} 必须是整数，收到 ${JSON.stringify(value)}`)
  }
  if (value < 0 || value > max) {
    throw invalid('search_need_span_out_of_range', `${what} 必须在 0..${max} 之间，收到 ${String(value)}`)
  }
  return value
}

/**
 * 解析一份**未知来源**的提案（模型输出 / fixture / 反序列化结果）—— **失败关闭**。
 *
 * 四条纪律（每条都有负控）：
 *   1. 只接受三个字段，**任何未知字段一律拒**（这是"提案不能给自己授权"的第一道闸）
 *   2. `decision` / `reason` 必须落在**枚举**里
 *   3. `querySpan` **当且仅当** `decision === 'search'`
 *   4. span 必须是 `0 ≤ start < end` 的整数区间
 *
 * ⚠️ 它**不认识文本**：span 是否落在**当前用户文本**内由 `queryTextOf` 用真实文本判
 *    （ADR-049 `D551-3`：query 只能取当前文本的一个连续片段，**不得**从历史/记忆补全）。
 */
export function parseSearchNeedProposal(raw: unknown): SearchNeedProposal {
  if (!isPlainObject(raw)) {
    throw invalid('search_need_proposal_not_object', `提案必须是对象，收到 ${typeof raw}`)
  }
  const unknownFields = Object.keys(raw).filter((key) => !PROPOSAL_FIELDS.includes(key))
  if (unknownFields.length > 0) {
    throw invalid(
      'search_need_proposal_unknown_field',
      `提案里有未知字段：${unknownFields.join(', ')}。` +
        '只允许 decision / reason / querySpan —— 否则模型可以靠塞字段给自己授权或夹带正文'
    )
  }
  const decision = raw.decision
  if (typeof decision !== 'string' || !(SEARCH_NEED_DECISIONS as readonly string[]).includes(decision)) {
    throw invalid(
      'search_need_proposal_bad_decision',
      `decision 必须是 ${SEARCH_NEED_DECISIONS.join('|')}，收到 ${JSON.stringify(decision)}`
    )
  }
  const reason = raw.reason
  if (typeof reason !== 'string' || !(SEARCH_NEED_REASONS as readonly string[]).includes(reason)) {
    throw invalid(
      'search_need_proposal_bad_reason',
      `reason 必须是登记过的枚举值，收到 ${JSON.stringify(reason)}`
    )
  }

  if (decision !== 'search') {
    if (raw.querySpan !== undefined) {
      throw invalid(
        'search_need_proposal_unexpected_span',
        `decision=${decision} 时不得带 querySpan（只有 search 才需要查询片段）`
      )
    }
    return { decision: decision as SearchNeedDecision, reason: reason as SearchNeedReason }
  }

  const span = raw.querySpan
  if (!isPlainObject(span)) {
    throw invalid('search_need_proposal_missing_span', 'decision=search 时必须给出 querySpan')
  }
  const spanUnknown = Object.keys(span).filter((key) => !SPAN_FIELDS.includes(key))
  if (spanUnknown.length > 0) {
    throw invalid('search_need_span_unknown_field', `querySpan 里有未知字段：${spanUnknown.join(', ')}`)
  }
  const start = parseIntInRange(span.start, 'querySpan.start', Number.MAX_SAFE_INTEGER)
  const end = parseIntInRange(span.end, 'querySpan.end', Number.MAX_SAFE_INTEGER)
  if (start >= end) {
    throw invalid('search_need_span_empty', `querySpan 必须是 start < end，收到 [${start}, ${end})`)
  }
  return {
    decision: 'search',
    reason: reason as SearchNeedReason,
    querySpan: { start, end },
  }
}

/**
 * 从**当前用户文本**里取出 span 指向的那一段（逐字，不做任何改写/补全）。
 *
 * 越界、空片段、非连续一律拒 —— 这条函数就是 `D551-3` 的落点：
 * **query 只可能是用户自己刚说过的一个连续片段**。
 */
export function queryTextOf(text: string, span: QuerySpan): string {
  if (typeof text !== 'string') {
    throw invalid('search_need_text_not_string', `用户文本必须是字符串，收到 ${typeof text}`)
  }
  const start = parseIntInRange(span.start, 'querySpan.start', text.length)
  const end = parseIntInRange(span.end, 'querySpan.end', text.length)
  if (start >= end) {
    throw invalid('search_need_span_empty', `querySpan 必须是 start < end，收到 [${start}, ${end})`)
  }
  const query = text.slice(start, end)
  if (query.trim() === '') {
    throw invalid('search_need_span_blank', 'querySpan 指向的是空白片段（那等于没有查询词）')
  }
  return query
}

export type SearchNeedOutcomeCode =
  | 'allowed'
  | 'master_switch_off'
  | 'invalid_mode'
  | 'local_action_preferred'
  | 'quota_exhausted'
  | 'not_authorized_in_explicit_mode'
  | 'explicit_request_not_confirmed'
  | 'unknown_candidate_source'
  | 'no_action'

export interface SearchNeedOutcome {
  allowed: boolean
  code: SearchNeedOutcomeCode
  /** 人可读的一行（**不**含用户原文） */
  detail: string
}

export interface DecideSearchNeedInput {
  /** 总开关（`CHARACTER_WEB_SEARCH_ENABLED`）—— off ⇒ 一切照旧，零出站 */
  masterEnabled: boolean
  /** 原始模式值：**未登记的值必须失败关闭**，不得静默当成 auto_public（`D551-2`） */
  mode: string
  /** 这一轮的提案（已过 `parseSearchNeedProposal`） */
  proposal: SearchNeedProposal
  /**
   * 这个提案**从哪来**（程序事实，见 `SEARCH_CANDIDATE_SOURCES`）。
   *
   * 缺省 `auto_proposal` 是刻意的：**忘了给**时按最严的那一类处理，而不是白拿显式授权。
   */
  candidateSource?: SearchCandidateSource
  /**
   * **受信程序**是否在当前用户消息上确认了一次有效显式请求（`R2` §11.1 第 4 条）。
   *
   * ⚠️ 只有装配层能置 true —— 它的来源是程序自己的词形检测器（且已过 WP2b 的否定否决）。
   *    模型输出、提案字段、`reason` 都**改不动**它。缺省 `false`。
   */
  explicitRequestConfirmed?: boolean
  /** M4.5 的本地动作是否已经命中（`D551-4` 的本地优先） */
  localActionFired: boolean
  /** 本轮**已经**用掉的 provider 调用数（显式 + 自动共享，`D551-4`） */
  providerCallsUsed: number
}

/**
 * **纯策略**：提案能不能变成一次执行（`R2` §11.1：合取关系里的"程序侧授权依据"那一项）。
 *
 * ⚠️ 授权只来自**程序事实**：总开关、模式、候选来源、受信确认、限额、本地优先。
 *    `proposal` 只影响"要不要搜"这一件事（`decision`），**影响不了**任何一条授权判据；
 *    而且它在类型上就没有 `authorized` / `mode` / `capability` 这些位置。
 *
 * ⚠️ **判定器有否决权，没有授权权**（`R2` §11.1 第 3 条）：`decision=search` 只是**必要**条件，
 *    本函数与 Policy / Gateway 一起才构成放行。反之，本函数**不**放行非 search 的结论。
 *
 * 判据顺序（先到先拒，顺序即不变量）：
 *   ① 总开关 off                    → `master_switch_off`
 *   ② 模式值非法                    → `invalid_mode`（**不**降级成任何一种模式）
 *   ②′ 候选来源值非法               → `unknown_candidate_source`（同样**不**降级；与 ② 同为配置错误）
 *   ③ 本地动作已命中                → `local_action_preferred`
 *   ④ 限额已用尽                    → `quota_exhausted`
 *   ⑤ 非 search 结论                → `no_action`
 *   ⑥ 自动提案 + explicit 模式      → `not_authorized_in_explicit_mode`
 *   ⑦ 显式候选但**程序没确认**显式请求 → `explicit_request_not_confirmed`
 *   ⑧ 其余 search                   → `allowed`
 */
export function decideSearchNeed(input: DecideSearchNeedInput): SearchNeedOutcome {
  if (!input.masterEnabled) {
    return { allowed: false, code: 'master_switch_off', detail: '总开关关闭：不授权、不构造适配器' }
  }
  if (!(SEARCH_MODES as readonly string[]).includes(input.mode)) {
    return {
      allowed: false,
      code: 'invalid_mode',
      detail: `未登记的模式值 ${JSON.stringify(input.mode)}：配置错误，禁止搜索（不静默降级）`,
    }
  }
  const source: SearchCandidateSource = input.candidateSource ?? 'auto_proposal'
  /*
   * ⚠️ 非法来源值必须**失败关闭**，而且要**紧挨着 `invalid_mode`** 判 —— 两者是同一类东西：
   *    配置/接线错误。放在后面判会让"本地动作已命中"这类**本轮状态**盖过配置错误，
   *    于是同一条错误接线在不同轮次报出不同理由码，事后没法用它定位问题。
   *
   * ⚠️ 真实踩过（写 WP3 时自查发现）：若只判 `=== 'auto_proposal'` 与 `=== 'explicit_request'`，
   *    一个 `'EXPLICIT_REQUEST'`（大小写不同）会**两个都不是** ⇒ 直接落到 `allowed`，
   *    等于凭一个拼错的大小写白拿授权。这类"两条都不匹配于是放行"是授权漏洞的经典形态。
   */
  if (!(SEARCH_CANDIDATE_SOURCES as readonly string[]).includes(source)) {
    return {
      allowed: false,
      code: 'unknown_candidate_source',
      detail: `未登记的候选来源 ${JSON.stringify(source)}：配置错误，禁止搜索（不静默降级）`,
    }
  }
  if (input.localActionFired) {
    return { allowed: false, code: 'local_action_preferred', detail: '本轮已命中本地动作：不补搜' }
  }
  if (input.providerCallsUsed >= SEARCH_NEED_LIMITS.maxProviderCallsPerTurn) {
    return { allowed: false, code: 'quota_exhausted', detail: '本轮 provider 调用额度已用尽（显式与自动共享）' }
  }
  if (input.proposal.decision !== 'search') {
    return {
      allowed: false,
      code: 'no_action',
      detail: `decision=${input.proposal.decision}：不产生 ActionRequest（用安全 trace 记录判定）`,
    }
  }
  if (source === 'auto_proposal' && input.mode === 'explicit') {
    return {
      allowed: false,
      code: 'not_authorized_in_explicit_mode',
      detail: 'explicit（缺省）模式不放行"无明确请求"的自动提案 —— 与 INV-M55-03 完全一致',
    }
  }
  if (source === 'explicit_request' && input.explicitRequestConfirmed !== true) {
    return {
      allowed: false,
      code: 'explicit_request_not_confirmed',
      detail:
        '候选自称来自显式请求，但**程序没有确认**这次显式请求：模型 reason 不是授权凭据（R2 §11.1 第 4 条）',
    }
  }
  return {
    allowed: true,
    code: 'allowed',
    detail: `${input.mode} + ${source} + decision=search（reason=${input.proposal.reason}）`,
  }
}
