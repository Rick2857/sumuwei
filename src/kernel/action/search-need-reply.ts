/**
 * M5.5.1 WP5 —— **判定结论到回复的绑定**（计划 §WP5："区分未查与查了没结果"·"失败不冒充成功"）。
 *
 * ============================================================================
 *  它补的是 M5.5 五态之外的那一类：**"没查"其实是好几种不同的"没查"**
 * ============================================================================
 * M5.5 的五态（`external-evidence-reply.ts`）描述的是**搜索动作的终态**：
 * 查到并形成证据 / 无结果 / 超时 / 失败 / 未启用联网。它有一个刻意留下的边界
 * （`L-M55-03`）：**没有动作请求时守卫完全不接手**。
 *
 * M5.5.1 新增了一条判定路径，于是多了几种"程序**确实考虑过**要不要查"的情形：
 *
 * ```text
 * 判定说 answer        ⇒ 未查（本来就不需要查）        —— 与"没有请求"不同
 * 判定说 clarify       ⇒ 未查，而且**该问她**          —— 不能装作答过了
 * 判定说 deny_search   ⇒ 未查（用户明确禁止）          —— 必须尊重禁止
 * 判定缺席/超时/坏输出 ⇒ 未查，而且**这是故障**        —— 不能与"查了没结果"混为一谈
 * ```
 *
 * ---------------------------------------------------------------------------
 *  三条纪律
 * ---------------------------------------------------------------------------
 * 1. **只在她说出"查证成功"口吻时才顶替**（与 M5.5 的守卫同一纪律、**同一份**词表）：
 *    强行改写一句与搜索无关的回答，等于**替用户多说话**。
 * 2. **"未查"与"查了没结果"必须是两句不同的话**：混成一句，用户就再也分不清
 *    "她没查"和"她查了但什么都没有" —— 而那正是本里程碑要修的东西。
 * 3. **`L-M55-03` 的边界一寸不让**：程序**没有**建立候选的那些情形（`no_candidate`：
 *    explicit 模式无词形、也没有自动授权）**不接手**。那里守卫依然无法区分
 *    "凭空宣称查过"与"她在讲假设/第三人称"，与 M5.5 逐字一致。
 */

import { SEARCH_SUCCESS_MARKERS, type ExternalEvidenceReplyState } from './external-evidence-reply.ts'

/**
 * 判定路径专属的回复状态（**与 M5.5 五态正交**）。
 *
 * `searched` 不是"查到了"，而是"这一轮的搜索归 M5.5 五态管"—— 本模块不重复表达它。
 */
export const SEARCH_NEED_REPLY_STATES = [
  'searched',
  'not_attempted',
  'needs_clarification',
  'prohibited',
  'judgment_failed',
] as const
export type SearchNeedReplyState = (typeof SEARCH_NEED_REPLY_STATES)[number]

export interface SearchNeedReplyInput {
  /** 解析结论码（`diagnostics.search_need_code`；**undefined** = 本轮没有判定路径） */
  resolutionCode?: string
  /** 判定结论（`diagnostics.search_need_decision`） */
  decision?: string
  /** M5.5 五态算出来的当前状态（**不**被本模块改写） */
  searchState: ExternalEvidenceReplyState
  /** 当前回复正文 */
  replyText: string
}

export interface SearchNeedReplyOutcome {
  state: SearchNeedReplyState
  replyText: string
  /** 是否发生了顶替 */
  replaced: boolean
  /** 诊断一行（**不含用户原文**） */
  detail: string
}

/** 程序前置拒绝 / 授权拒绝 / 判定说 answer ⇒ 都归"未查"，**但各自保留原始码** */
const NOT_ATTEMPTED_CODES: readonly string[] = [
  'master_switch_off',
  'invalid_mode',
  'dry_run',
  'local_action_preferred',
  'judge_quota_exhausted',
  'provider_quota_exhausted',
  'judge_absent',
  'judge_failed',
  'span_invalid',
  'explicit_request_not_confirmed',
  'not_authorized_in_explicit_mode',
  'unknown_candidate_source',
  'no_action',
]

export function searchNeedReplyStateOf(input: {
  resolutionCode?: string
  decision?: string
}): SearchNeedReplyState {
  const code = input.resolutionCode
  if (code === undefined || code === 'allowed') return 'searched'
  if (code === 'no_candidate') return 'searched' // ⚠️ L-M55-03 的边界：不接手
  if (code === 'judge_absent' || code === 'judge_failed' || code === 'span_invalid') {
    return 'judgment_failed'
  }
  if (code === 'no_action') {
    if (input.decision === 'clarify') return 'needs_clarification'
    if (input.decision === 'deny_search') return 'prohibited'
    return 'not_attempted'
  }
  return NOT_ATTEMPTED_CODES.includes(code) ? 'not_attempted' : 'searched'
}

/** 各态如实的用户可见句（**只在这些态需要"顶替"时使用**） */
export function truthfulNeedSentence(state: SearchNeedReplyState): string | undefined {
  switch (state) {
    case 'searched':
      return undefined
    case 'not_attempted':
      // ⚠️ 与 M5.5 的"没有可以给你引用的结果"**刻意不同**：那是"查了但空"，这是"没查"
      return '这次我没有联网查，下面是我自己知道的。'
    case 'needs_clarification':
      return '这个我还需要你再说清一点：你想让我上网查什么？'
    case 'prohibited':
      return '好，这次不联网，我就按自己知道的回答。'
    case 'judgment_failed':
      return '这次我没能判断该不该上网查（判断没成功），所以没有去查——不想凭猜给你一个像查过的答案。'
  }
}

function containsSuccessMarker(text: string): boolean {
  return SEARCH_SUCCESS_MARKERS.some((marker) => text.includes(marker))
}

/**
 * 把判定结论绑到回复上（**纯函数**）。
 *
 * 判据顺序：
 *   ① 本轮没有判定路径 / 判定放行 ⇒ `searched`，**逐字不改**（交给 M5.5 五态）
 *   ② 否则按结论码定态
 *   ③ 只有她说出成功口吻时才顶替；`not_attempted` 也顶替（因为程序**确实**考虑过要不要查）
 */
export function applySearchNeedReplyPolicy(input: SearchNeedReplyInput): SearchNeedReplyOutcome {
  const state = searchNeedReplyStateOf({
    ...(input.resolutionCode !== undefined ? { resolutionCode: input.resolutionCode } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
  })
  if (state === 'searched') {
    return { state, replyText: input.replyText, replaced: false, detail: '判定未否决：回复不改写' }
  }
  if (!containsSuccessMarker(input.replyText)) {
    return {
      state,
      replyText: input.replyText,
      replaced: false,
      detail: `${state}：回复里没有"查证成功"口吻 ⇒ 不改写（不替用户多说话）`,
    }
  }
  const sentence = truthfulNeedSentence(state)
  if (sentence === undefined) {
    return { state, replyText: input.replyText, replaced: false, detail: `${state}：没有可用的如实句` }
  }
  return { state, replyText: sentence, replaced: true, detail: `${state}：成功口吻被如实句顶替` }
}

/**
 * 从这一轮的动作结果里取出判定结论（**只有一处实现**）。
 *
 * ⚠️ 判定结论挂在 `ActionTurnResult.diagnostics` 上，而"被否决"的轮次**没有**
 *    `request`/`result` —— 这正是它与 `searchFactOf`（只看 `result`）的区别：
 *    前者能看见"程序考虑过但没查"，后者只看得见"真的执行过"。
 */
export function searchNeedDiagnosticsOf(
  results: readonly { diagnostics?: Record<string, string | number | boolean> }[] | undefined
): { code?: string; decision?: string } {
  if (results === undefined) return {}
  for (const item of results) {
    const code = item.diagnostics?.search_need_code
    if (typeof code !== 'string') continue
    const decision = item.diagnostics?.search_need_decision
    return { code, ...(typeof decision === 'string' ? { decision } : {}) }
  }
  return {}
}
