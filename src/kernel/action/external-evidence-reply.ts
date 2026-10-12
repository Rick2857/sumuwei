/**
 * 外部证据的**回复真相**（M5.5 WP6 / ADR-045 `D-9`·`D-17`）。
 *
 * ============================================================================
 *  它与 `claim-guard.ts` 是同一条纪律的两个领域，因此**刻意不共用词表**
 * ============================================================================
 * 已有的两道守卫各管一类口吻：
 *   `applyResponseTruthPolicy`  —— "我记住了"（记忆）
 *   `applyActionClaimGuard`     —— "我已经处理好了"（动作）
 * 本文件管第三类：**"我上网查到了"**（外部证据）。
 *
 * 与 claim-guard 一样的三条理由（不共用词表）：
 *   1. **命中率**：混用会让"我记住了"在搜索失败时被误替换
 *   2. **回归安全**：`ACTION_SUCCESS_MARKERS` 与 `RESPONSE_SUCCESS_MARKERS`
 *      的对外行为一个字节都不能变
 *   3. **可解释**：日志要能说清是哪一类口吻触发的
 * 共享的只有最底层的 `scanClaims`（含 4 字符否定窗口）。
 *
 * ---------------------------------------------------------------------------
 *  五态（ADR-045 §A.5）与**程序**做什么
 * ---------------------------------------------------------------------------
 * ```text
 * 查到并形成证据      success 且实际入模 > 0     → 守卫安静 + 追加**确定性来源附录**
 * 搜索执行但无结果    success 且实际入模 = 0     → 无附录；若出现"查到了"式口吻 ⇒ 替换成如实句
 * 搜索超时            timeout                    → 无附录；同上（如实句）
 * 搜索失败            failed / rejected（非授权）→ 无附录；同上
 * 未启用联网          rejected + permission_denied → 无附录；同上（"联网搜索没有启用"）
 * ```
 *
 * ⚠️ **来源列表由程序生成，不由模型生成**（`D-9`）：模型正文里所有
 *    `[E<数字>]` 形态的内联标签一律**剥离**（`D-17`）—— 即使那个编号是合法的，
 *    模型把它放在哪句话后面也无法被机器验证。可验证的只有集合：
 *    "实际入模了哪几条"（程序知道）+ "来源列表列了哪几条"（程序生成）。
 *
 * ⚠️ **已知局限（如实登记）**：非成功态只有在回复**出现成功口吻**时才会被改写。
 *    回复完全没提搜索时保持原样 —— 强行把一句与搜索无关的回答替换成
 *    "搜索超时了"会改写用户真正在问的那件事。前置的 `action-result` section
 *    （`droppable: false`）负责让模型**倾向**于如实转述，本守卫负责它不听的时候。
 */

import type { ActionResult } from './action-result.ts'
import type { ActionTurnResult } from './action-turn.ts'
import { scanClaims } from './claim-scanner.ts'
import { WEB_SEARCH } from './external-evidence-capability.ts'
import {
  buildCitationAppendix,
  citationLabelsIn,
  type ExternalEvidence,
  type ExternalEvidenceTurnReality,
} from '../contracts/external-evidence.ts'

/**
 * "上网查到了"式成功口吻。
 *
 * 取舍与既有两道守卫一致：只收**明确的完成态**表述，刻意不收"好"/"知道了"
 * 这类泛应声词。宁可漏报（退回 prompt 层与 action-result section），
 * 也不要误改成她没说过的意思。
 */
export const SEARCH_SUCCESS_MARKERS: readonly string[] = [
  '查到了',
  '已经查到',
  '查到的',
  '搜到了',
  '已经搜到',
  '搜到的',
  '搜索到了',
  '我查了',
  '我搜了',
  '我上网查',
  '我联网查',
  '上网查了',
  '联网查了',
  '搜索结果',
  '搜索显示',
  '网上说',
  '网上显示',
  '据网上',
  '根据网上',
  '查到资料',
  '找到资料',
  '查到了资料',
]

/** 五态（用户可见的区分，`D-9`/§A.5） */
export type ExternalEvidenceReplyState =
  | 'no_search' // 这一轮没有搜索动作
  | 'answered_with_sources' // 查到并形成证据（有附录）
  | 'searched_empty' // 搜索执行但无结果
  | 'timeout'
  | 'failed'
  | 'not_enabled' // 未启用联网（permission_denied）

export interface ExternalEvidenceSearchFact {
  status: ActionResult['status']
  failureCode?: string
  /**
   * `permission_denied` 时 provider 携带的 **HTTP 状态**（有才填）。
   *
   * 为什么必须有它：`permission_denied` 被**两条不同的路径**共用（`TD-10` G-1，2026-10-04）——
   * ```text
   * ① 策略/开关：flag 关闭 ⇒ capability 未授予 ⇒ 可审计的 permission_denied
   *    ⇒ 用户可见态必须是"**未启用联网**"（配置）
   * ② provider：Tavily 回 401/403 ⇒ permission_denied（ADR-046 `D-28` 的设计映射）
   *    ⇒ 这是**故障**，说成"没启用"就是**说错失败原因**（"换 key" ≠ "打开开关"）
   * ```
   * 两者在**码**上不可区分，在**状态**上可区分 ⇒ 只把状态这一个数字带过来（不带正文，
   * 不违反 `TD-12` 的隐私边界）。
   */
  failureHttpStatus?: number
}

export interface ExternalEvidenceReplyInput {
  /** 这一轮搜索动作的终态；`undefined` = 这一轮没有搜索（守卫完全不介入） */
  search?: ExternalEvidenceSearchFact
  /** WP5 写下的**实际入模**事实（`undefined` = 没搜索/没有该字段） */
  reality?: ExternalEvidenceTurnReality
  replyText: string
}

export interface ExternalEvidenceReplyOutcome {
  replyText: string
  /** 追加的确定性来源附录（空串 = 没有附录） */
  appendix: string
  state: ExternalEvidenceReplyState
  /** 是否改写过她的原话 */
  corrected: boolean
  /** 触发改写的成功口吻标记 */
  markers: string[]
  /** 被剥离的内联标签（`D-17`；只记标签本身，不记正文） */
  strippedCitationLabels: string[]
}

/** 从这一轮的动作结果里取出"搜索那一次"的终态（只有一处实现） */
export function searchFactOf(
  results: readonly ActionTurnResult[] | undefined
): ExternalEvidenceSearchFact | undefined {
  if (results === undefined) return undefined
  for (const item of results) {
    if (item.result === undefined) continue
    if (String(item.result.capability) !== WEB_SEARCH) continue
    const failureCode = item.result.error?.code
    /* 只取 `details.status` 这一个数字（`D-28` 放进来的 HTTP 状态），不搬运任何正文 */
    const rawStatus = item.result.error?.details?.status
    const failureHttpStatus = typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : undefined
    return {
      status: item.result.status,
      ...(failureCode !== undefined ? { failureCode } : {}),
      ...(failureHttpStatus !== undefined ? { failureHttpStatus } : {}),
    }
  }
  return undefined
}

export function replyStateOf(input: {
  search?: ExternalEvidenceSearchFact
  injectedCount: number
}): ExternalEvidenceReplyState {
  const search = input.search
  if (search === undefined) return 'no_search'
  if (search.status === 'success') {
    return input.injectedCount > 0 ? 'answered_with_sources' : 'searched_empty'
  }
  if (search.status === 'timeout') return 'timeout'
  if (
    search.status === 'rejected' &&
    (search.failureCode === 'permission_denied' || search.failureCode === undefined)
  ) {
    /*
     * ⚠️ `permission_denied` 是**未启用联网**的那一条路径（ADR-045 `D-12`）：
     *    能力恒登记、权限只在 flag 打开时授予 ⇒ flag 关闭时用户说"搜一下"
     *    得到的就是这个码。它必须与"搜索失败"区分开：前者是配置，后者是故障。
     *
     * ⚠️ **但它被两条路径共用**（`TD-10` G-1，2026-10-04 修）：provider 的 401/403
     *    也是这个码（ADR-046 `D-28` 的设计映射）——"凭证被吊销"被读成"没启用联网"
     *    就是**说错失败原因**。区分判据 = provider 带过来的 **HTTP 状态**：
     *    401/403 ⇒ 这是**故障**（用户要换 key，不是打开开关）⇒ `failed`。
     *    没有任何状态（策略/开关那条路径不经过 HTTP）⇒ 仍然是 `not_enabled`。
     */
    if (search.failureHttpStatus === 401 || search.failureHttpStatus === 403) return 'failed'
    return 'not_enabled'
  }
  return 'failed'
}

/** 各态如实的用户可见句（**只在这些态需要"顶替"时使用**） */
export function truthfulSearchSentence(state: ExternalEvidenceReplyState): string | undefined {
  switch (state) {
    case 'answered_with_sources':
    case 'no_search':
      return undefined
    case 'searched_empty':
      /*
       * ⚠️ 措辞刻意是**预算中性**的：这一态既不覆盖"上游一条都没返回"，
       *    也覆盖"返回了但被证据额度/上下文预算整段丢掉"（`D-8`：两种事后必须
       *    都能被如实转述）。所以不能说"没有找到"——那在第二种情形下是假的；
       *    能说且必须说的是"这次没有可以给你引用的结果"。
       */
      return '我查了一下，但这次没有可以给你引用的结果——所以给不出来源。'
    case 'timeout':
      return '这次上网查没有等到结果（超时了），所以我不能说我查到了什么。你要我再试一次吗？'
    case 'failed':
      return '这次上网查失败了，没有拿到结果。'
    case 'not_enabled':
      return '我这边联网搜索没有启用，所以没法上网替你查。'
  }
}

/** 剥离模型正文里所有 `[E<数字>]` 内联标签（`D-17`），并顺手清理留下的空格 */
function stripInlineCitationLabels(text: string): {
  text: string
  stripped: string[]
} {
  const stripped = citationLabelsIn(text)
  if (stripped.length === 0) return { text, stripped: [] }
  const cleaned = text
    .replace(/\s?\[E[0-9]{1,4}\]/g, '')
    // 删标签后可能出现的"标点前空格"与重复空格
    .replace(/[ \t]+([，,。.、；;：:！!？?）)】\]])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
  return { text: cleaned, stripped }
}

/**
 * 应用外部证据的回复策略。
 *
 * **纯函数**：同输入必同输出、不读时间/环境、不写任何东西。
 * 调用点必须在**写账本与写 memories 之前**（M4.1 的现场纪律：
 * 账本里不能留着一句没有被说出口的话）。
 */
export function applyExternalEvidenceReplyPolicy(
  input: ExternalEvidenceReplyInput
): ExternalEvidenceReplyOutcome {
  const injected: readonly ExternalEvidence[] = input.reality?.selected ?? []
  const state = replyStateOf({
    ...(input.search !== undefined ? { search: input.search } : {}),
    injectedCount: injected.length,
  })

  // ① 先剥离内联标签：无论哪一态，正文里都不留 `[E<n>]`
  const stripped = stripInlineCitationLabels(input.replyText)
  let replyText = stripped.text

  // ② 没有搜索 ⇒ 只做剥离，不动措辞（否则会误改与搜索无关的回答）
  if (state === 'no_search') {
    return {
      replyText,
      appendix: '',
      state,
      corrected: replyText !== input.replyText,
      markers: [],
      strippedCitationLabels: stripped.stripped,
    }
  }

  // ③ 查到并形成证据：安静 + 追加**确定性来源附录**（只列实际入模的那几条）
  if (state === 'answered_with_sources') {
    const appendix = buildCitationAppendix(injected, { reachedContext: true })
    const withAppendix = appendix === '' ? replyText : `${replyText}\n\n${appendix}`
    return {
      replyText: withAppendix,
      appendix,
      state,
      corrected: withAppendix !== input.replyText,
      markers: [],
      strippedCitationLabels: stripped.stripped,
    }
  }

  // ④ 其余四态：出现成功口吻 ⇒ 顶替成如实句；没有成功口吻 ⇒ 保持原样
  const claim = scanClaims(replyText, SEARCH_SUCCESS_MARKERS)
  const truthful = truthfulSearchSentence(state)
  if (!claim.claims || truthful === undefined) {
    return {
      replyText,
      appendix: '',
      state,
      corrected: replyText !== input.replyText,
      markers: [],
      strippedCitationLabels: stripped.stripped,
    }
  }
  return {
    replyText: truthful,
    appendix: '',
    state,
    corrected: true,
    markers: claim.markers,
    strippedCitationLabels: stripped.stripped,
  }
}
