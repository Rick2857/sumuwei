/**
 * M5.5.1 WP4 —— **一轮搜索需求的解析**（ADR-049 `R2` §11.2 的六步，落成一个纯函数式编排）。
 *
 * ============================================================================
 *  它是整条新增链的**唯一入口**：候选 → 判定 → 授权 → 绑定 query
 * ============================================================================
 * ```text
 * ① 程序前置检查（总开关 / 模式 / dryRun / 本地优先 / 额度）—— 可**提前拒绝**
 * ② 建立候选与程序授权依据：显式请求候选（词形命中且未被否定），或 auto_public 下的自动候选
 * ③ 两条路径**共用一次**判定调用 → 严格解析 → 当前文本 querySpan 校验
 * ④ 非 search / 判定失败 / 校验失败 ⇒ **搜索调用 0**；不回退旧显式检测器、不补搜
 * ⑤ 合法 search + 程序授权 ⇒ 产出 query（**逐字来自判定通过的那一段**）
 * ```
 *
 * ⚠️ **本函数不调用 provider**：它只产出"要不要搜、搜什么"。出站仍由既有 Policy + 唯一
 *    Gateway 放行（`R2` §11.1 第 4 条的合取关系）。
 *
 * ⚠️ **判定器缺席 ⇒ 失败关闭**（`judge_absent`）：绝不在没有判定器时退回
 *    "旧词形命中就出站"那条路。这是 `R2` §11.2 第 ④ 步最容易被写错的地方 ——
 *    "找不到判定器就用老办法"在代码上只差一个 `??`，却是整条裁定被绕过的形态。
 *
 * ⚠️ 诊断只含**闭集码 / 枚举 / 计数**：没有用户原文、没有模型输出、没有 query 之外的文本。
 */

import { KernelError } from '../contracts/ids.ts'
import {
  SEARCH_MODES,
  decideSearchNeed,
  queryTextOf,
  type SearchCandidateSource,
  type SearchNeedDecision,
  type SearchNeedReason,
} from './search-need.ts'
import type { SearchNeedJudgeFailure, SearchNeedJudgePort } from './search-need-judge.ts'

/**
 * 解析结论的**闭集码**（进 trace / 账本的诊断面）。
 *
 * 前六条是**程序前置检查**（不调判定、不出站），中间几条是判定与授权的否决，
 * 最后一条是唯一放行。刻意把"为什么没搜"分得这么细：`no_candidate`（本来就没要求）
 * 与 `judge_failed`（要求了但判定坏了）在事后排查时是完全不同的两件事。
 */
export const SEARCH_RESOLUTION_CODES = [
  'master_switch_off',
  'invalid_mode',
  'dry_run',
  'local_action_preferred',
  'judge_quota_exhausted',
  'provider_quota_exhausted',
  'no_candidate',
  'judge_absent',
  'judge_failed',
  'no_action',
  'not_authorized_in_explicit_mode',
  'explicit_request_not_confirmed',
  'unknown_candidate_source',
  'span_invalid',
  'allowed',
] as const
export type SearchResolutionCode = (typeof SEARCH_RESOLUTION_CODES)[number]

export interface SearchResolutionInput {
  /** **当前用户发言**（逐字；判定器与 span 都只认它） */
  text: string
  /** 原始模式值（未登记的值得失败关闭，`D551-2`） */
  mode: string
  /** 总开关 */
  masterEnabled: boolean
  /** 干跑：不调判定模型、不出站（ADR-049 §3 逐字保留既有语义） */
  dryRun: boolean
  /** M4.5 本地动作是否已命中（本地优先） */
  localActionFired: boolean
  /** 本轮已用掉的 provider 调用数（显式与自动共享） */
  providerCallsUsed: number
  /** 本轮已用掉的判定调用数（≤1） */
  judgeCallsUsed: number
  /** **程序事实**：词形检测器在当前发言上命中，且没有被否定否决（WP2b） */
  explicitCandidate: boolean
}

export interface SearchResolutionDeps {
  /** 判定器；**缺席** ⇒ 失败关闭（`judge_absent`），绝不退回词形直通 */
  judge?: SearchNeedJudgePort
}

export interface SearchResolution {
  /** `search` 是唯一会产生 ActionRequest 的结论 */
  action: 'none' | 'search' | 'vetoed'
  code: SearchResolutionCode
  candidateSource?: SearchCandidateSource
  decision?: SearchNeedDecision
  reason?: SearchNeedReason
  /** `span_invalid` 时的**安全细分码**（生产校验器的错误码；其它情况不存在） */
  spanFailureCode?: string
  /** **只有** `action === 'search'` 时存在；逐字来自判定通过的 span */
  query?: string
  /** 这一轮**实际**用掉的判定调用数（0/1） */
  judgeCalls: number
  /** 这一轮**将要**发出的 provider 调用数（0/1）—— 由唯一网关真正执行 */
  providerCalls: 0 | 1
  /** 人可读一行（**不含用户原文**） */
  detail: string
}

function skip(code: SearchResolutionCode, detail: string, judgeCalls = 0): SearchResolution {
  return { action: 'none', code, detail, judgeCalls, providerCalls: 0 }
}
/*
 * R2-2：`span_invalid` 需要一个**安全细分码**（来自生产校验器的 `KernelError.code`），
 * 否则"越界 / 空白 / 反序 / 缺 span"四种坐标问题在证据里长得一模一样。
 * ⚠️ 不另写一套校验、不记 query 正文。
 */
function veto(
  code: SearchResolutionCode,
  detail: string,
  judgeCalls: number,
  extra?: { spanFailureCode?: string }
): SearchResolution {
  return {
    action: 'vetoed',
    code,
    detail,
    judgeCalls,
    providerCalls: 0,
    ...(extra?.spanFailureCode !== undefined ? { spanFailureCode: extra.spanFailureCode } : {}),
  }
}

/**
 * 解析一轮的搜索需求。
 *
 * 判据顺序即不变量（与 `decideSearchNeed` 的理由同源）：
 *   ① 总开关 off ⇒ `master_switch_off`
 *   ② 模式值非法 ⇒ `invalid_mode`（配置错误，**不**降级）
 *   ③ dryRun ⇒ `dry_run`
 *   ④ 本地动作已命中 ⇒ `local_action_preferred`
 *   ⑤ 判定额度 / provider 额度已用尽
 *   ⑥ 没有候选 ⇒ `no_candidate`（**explicit 模式无词形命中就是这一条：0 次判定调用**）
 *   ⑦ 判定器缺席 ⇒ `judge_absent`（失败关闭）
 *   ⑧ 一次判定 → 失败 ⇒ `judge_failed`；非 search ⇒ `no_action`
 *   ⑨ 程序授权（候选来源 + 受信确认 + 模式 + 额度）⇒ 不通过则按 `decideSearchNeed` 的码否决
 *   ⑩ span 越界 ⇒ `span_invalid`；否则 `allowed` + query
 */
export async function resolveSearchNeed(
  input: SearchResolutionInput,
  deps: SearchResolutionDeps
): Promise<SearchResolution> {
  if (!input.masterEnabled) {
    return skip('master_switch_off', '总开关关闭：不判定、不授权、不构造适配器')
  }
  if (!(SEARCH_MODES as readonly string[]).includes(input.mode)) {
    return skip('invalid_mode', `未登记的模式值 ${JSON.stringify(input.mode)}：配置错误，禁止搜索（不静默降级）`)
  }
  if (input.dryRun) {
    return skip('dry_run', '干跑：不调判定模型、不出站（ADR-049 §3）')
  }
  if (input.localActionFired) {
    return skip('local_action_preferred', '本轮已命中本地动作：不判定、不补搜')
  }
  if (input.judgeCallsUsed >= 1) {
    return skip('judge_quota_exhausted', '本轮判定调用额度已用尽（显式与自动共享 ≤1）')
  }
  if (input.providerCallsUsed >= 1) {
    return skip('provider_quota_exhausted', '本轮 provider 调用额度已用尽（显式与自动共享 ≤1）')
  }

  /*
   * ② 候选与程序授权依据。
   *
   * ⚠️ explicit 模式下**没有词形命中就根本没有候选** ⇒ 连判定都不调（0 次模型调用）。
   *    这是 `R2` §11.3 点名要保住的那条："无明确请求的 explicit 模式零调用"。
   */
  const candidateSource: SearchCandidateSource | undefined = input.explicitCandidate
    ? 'explicit_request'
    : input.mode === 'auto_public'
      ? 'auto_proposal'
      : undefined
  if (candidateSource === undefined) {
    return skip('no_candidate', 'explicit（缺省）模式且没有显式词形请求：不判定、不搜索（与 INV-M55-03 一致）')
  }

  // ⑦ 判定器缺席 ⇒ 失败关闭（**绝不**退回词形直通）
  const judge = deps.judge
  if (judge === undefined) {
    return veto('judge_absent', '没有可用的需求判定器：宁可不搜，也不退回旧词形直通', 0)
  }

  // ⑧ **恰好一次**判定（显式与自动共用同一个入口）
  const judged = await judge.judge({ text: input.text })
  if (judged.ok !== true) {
    const failure: SearchNeedJudgeFailure = judged.failure
    return veto('judge_failed', `判定未取得合法结论（${failure}）：不搜索、不回退、不补搜`, 1)
  }

  // ⑨ 程序授权（合取关系里除判决本身之外的那几项）
  const outcome = decideSearchNeed({
    masterEnabled: input.masterEnabled,
    mode: input.mode,
    proposal: judged.proposal,
    candidateSource,
    // 受信确认**只**来自程序事实：候选是程序按词形建立的，不是模型自称的
    explicitRequestConfirmed: candidateSource === 'explicit_request',
    localActionFired: input.localActionFired,
    providerCallsUsed: input.providerCallsUsed,
  })
  const decided = (code: SearchResolutionCode, detail: string): SearchResolution => ({
    action: 'vetoed',
    code,
    candidateSource,
    decision: judged.proposal.decision,
    reason: judged.proposal.reason,
    judgeCalls: 1,
    providerCalls: 0,
    detail,
  })
  if (outcome.allowed !== true) {
    return decided(outcome.code as SearchResolutionCode, `程序侧授权未通过（${outcome.code}）：不搜索`)
  }

  // ⑩ 合法 search ⇒ 绑定**判定通过的那一段**（R2 §11.1 第 5 条）
  const span = judged.proposal.querySpan
  if (span === undefined) {
    return veto('span_invalid', '判定说 search 却没给 querySpan：不搜索', 1, {
      spanFailureCode: 'search_need_span_missing',
    })
  }
  let query: string
  try {
    query = queryTextOf(input.text, span)
  } catch (error) {
    const code = error instanceof KernelError ? error.code : 'search_need_span_invalid'
    return veto(
      'span_invalid',
      `判定给出的 querySpan 在当前发言上不成立（${code}）：不搜索`,
      1,
      { spanFailureCode: code }
    )
  }
  return {
    action: 'search',
    code: 'allowed',
    candidateSource,
    decision: 'search',
    reason: judged.proposal.reason,
    query,
    judgeCalls: 1,
    providerCalls: 1,
    detail: `${input.mode} + ${candidateSource}：放行一次搜索（query 逐字取自判定通过的片段）`,
  }
}
