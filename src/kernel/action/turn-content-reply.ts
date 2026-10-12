/**
 * 当轮内容的**回复真相**（实用能力加装计划 §4A/§4C；与 M5.5 的外部证据守卫同一条纪律）。
 *
 * ============================================================================
 *  它与 `external-evidence-reply.ts` 是同一条纪律的两个领域，因此**刻意不共用词表**
 * ============================================================================
 * ```text
 * applyResponseTruthPolicy          ——  "我记住了"（记忆）
 * applyGoalClaimGuard               ——  "我记下了这件事"（目标 / 承诺）
 * applyActionClaimGuard             ——  "我已经处理好了"（动作）
 * applyExternalEvidenceReplyPolicy  ——  "我上网查到了"（外部证据）
 * applyTurnContentReplyPolicy       ——  "我读了 / 我算出来了"（当轮内容）← 本文件
 * ```
 * 不共用词表的三个理由与既有的两道守卫完全一致：命中率、回归安全、可解释。
 * 共享的只有最底层的 `scanClaims`（含否定窗口）。
 *
 * ---------------------------------------------------------------------------
 *  六态（用户可见的区分）
 * ---------------------------------------------------------------------------
 * ```text
 * no_content   这一轮没有实用能力动作          → 守卫完全不介入（只剥离自造标签）
 * delivered    真的取到内容**且真的入了模**    → 守卫安静 + 追加**确定性来源与范围附录**
 * empty        执行成功但没有可用内容          → 无附录；出现成功口吻 ⇒ 顶替成如实句
 * timeout      超时                            → 同上
 * failed       失败（含部分成功但没入模）      → 同上
 * not_enabled  未启用（permission_denied）     → 同上（"这项能力没有启用"）
 * ```
 *
 * ⚠️ **附录由程序生成，不由模型生成**：模型正文里所有 `[C<数字>]` 形态的内联标签
 *    一律**剥离** —— 即使那个编号是合法的，模型把它放在哪句话后面也无法被机器验证。
 *    可验证的只有集合："实际入模了哪几份"（程序知道）。
 *
 * ⚠️ **已知局限（如实登记）**：非交付态只有在回复**出现成功口吻**时才会被改写。
 *    回复完全没提这件事时保持原样 —— 强行把一句无关回答替换成"读失败了"
 *    会改写用户真正在问的那件事。前置的 `turn-content` section 负责让模型**倾向**于
 *    如实转述，本守卫负责它不听的时候。
 */

import type { ActionResult } from './action-result.ts'
import type { ActionTurnResult } from './action-turn.ts'
import { scanClaims } from './claim-scanner.ts'
import {
  buildTurnContentAppendix,
  turnContentLabelsIn,
  type TurnContent,
  type TurnContentContextReality,
  type TurnContentKind,
} from '../contracts/turn-content.ts'
import { IMAGE_OCR, MATH_CALCULATE } from './utility-capabilities.ts'
import { LOCAL_FILE_LIST, LOCAL_FILE_READ } from './local-file-capabilities.ts'
import { WEATHER_QUERY } from './weather-capability.ts'
import { OFFICE_GENERATE } from './office-capability.ts'
import { NEWS_READ } from './news-capability.ts'
import { BROWSER_READ } from './browser-capability.ts'
import { DESKTOP_INSPECT } from './desktop-capability.ts'
import {
  producesTurnContent,
  turnContentCapabilityLabel,
  turnContentKindOfCapability,
} from './turn-content-capabilities.ts'

/**
 * "我读了 / 我算出来了"式成功口吻。
 *
 * 取舍与既有守卫一致：只收**明确的完成态**表述，刻意不收"好"/"知道了"这类泛应声词，
 * 也不收"结果是"这种在日常对话里极常见的短语（那会误改与能力无关的回答）。
 */
export const TURN_CONTENT_SUCCESS_MARKERS: readonly string[] = [
  '我读到了',
  '我读完了',
  '读完了',
  '我读了一下',
  '我看了这份',
  '我打开看了',
  '已经读到了',
  '已经读完',
  '我看到了文件',
  '文件里读到了',
  '我算出来了',
  '算出来了',
  '已经算出',
  '我算了一下',
  '计算结果是',
  '识别出',
  '我识别到了',
  '图里写的是',
  '图片里写着',
  '我读到了这篇文章',
]

export type TurnContentReplyState =
  | 'no_content'
  | 'delivered'
  | 'empty'
  | 'timeout'
  | 'failed'
  | 'not_enabled'

export interface TurnContentFact {
  capability: string
  kind: TurnContentKind
  status: ActionResult['status']
  failureCode?: string
  failureReason?: 'ocr_assets_missing'
}

export interface TurnContentReplyInput {
  /** 这一轮的实用能力动作终态（空数组 / undefined = 这一轮没有这类动作） */
  facts?: readonly TurnContentFact[]
  /** 上下文层写下的**实际入模**事实 */
  reality?: TurnContentContextReality
  replyText: string
}

export interface TurnContentReplyOutcome {
  replyText: string
  /** 追加的确定性来源与范围附录（空串 = 没有附录） */
  appendix: string
  /** 逐能力的态（保序，与 `facts` 同序） */
  states: readonly { capability: string; state: TurnContentReplyState }[]
  corrected: boolean
  markers: string[]
  /** 被剥离的内联标签（只记标签本身，不记正文） */
  strippedLabels: string[]
}

/** 从这一轮的动作结果里取出"会产出当轮内容"的能力的终态（只有一处实现） */
export function turnContentFactsOf(
  results: readonly ActionTurnResult[] | undefined
): TurnContentFact[] | undefined {
  if (results === undefined) return undefined
  const facts: TurnContentFact[] = []
  for (const item of results) {
    const result = item.result
    if (result === undefined) continue
    const capability = String(result.capability)
    /*
     * 第二批：判据从 `UTILITY_CAPABILITY_IDS`（第一批四项）换成聚合清单
     * `producesTurnContent()`。第一批四项都在新清单里 ⇒ 旧路径的取值**逐字不变**。
     */
    if (!producesTurnContent(capability)) continue
    const failureCode = result.error?.code
    facts.push({
      capability,
      kind: turnContentKindOfCapability(capability),
      status: result.status,
      ...(failureCode !== undefined ? { failureCode } : {}),
      ...(capability === IMAGE_OCR && result.error?.details?.reason === 'ocr_assets_missing'
        ? { failureReason: 'ocr_assets_missing' as const } : {}),
    })
  }
  return facts.length > 0 ? facts : undefined
}

/**
 * 这一项实际**入了模**的份数。
 *
 * ⚠️ 它**只**从"编译器之后的事实"（`reality.refs`）来，不从动作结果来：
 *    "适配器拿到了正文"与"正文真的进了 prompt"是两件事，而回复层要按后者说话
 *    （被上下文预算整段丢掉时必须说"没拿到"，不能说"我读过了"）。
 */
export function injectedCountOf(input: {
  capability: string
  reality?: TurnContentContextReality
}): number {
  return (input.reality?.refs ?? []).filter((ref) => ref.capability === input.capability).length
}

/**
 * 各能力在该状态下**必须**说 / **必须不**说的话（第二批：按能力分叉）。
 *
 * ⚠️ 第一批四项的措辞**逐字保留** —— 它们有已落盘的真模型 live 读数对着。
 */
function truthfulSentenceForCapability(input: {
  capability: string
  state: TurnContentReplyState
  label: string
}): string | undefined {
  const { capability, state, label } = input
  switch (capability) {
    case MATH_CALCULATE:
      if (state === 'empty') return '这个算式我这次没有拿到可以给你的结果。'
      if (state === 'timeout') return '这个算式我这次算超时了，没有得到结果。'
      return undefined
    case LOCAL_FILE_LIST:
      if (state === 'empty') return '目录这次没有列出可引用的条目。'
      return undefined
    case LOCAL_FILE_READ:
      if (state === 'empty') return '这个文件我这次没有拿到可以引用的正文。'
      return undefined
    case WEATHER_QUERY:
      if (state === 'empty') return '这次没有拿到可引用的天气数据。'
      return undefined
    case OFFICE_GENERATE:
      /*
       * ⚠️ 办公生成**不是**"读"：它的失败措辞必须说的是"没生成出来 / 没能复核"，
       *    而不是"我打开看了但没有内容" —— 后者会把一次生成失败描述成一次阅读失败。
       */
      if (state === 'empty') return '文件这次没能生成到可以复核的状态，所以我不能说我做好了。'
      if (state === 'failed') return '这次文件没有生成成功，没有产物。'
      if (state === 'timeout') return '这次生成超时了，没有拿到文件。'
      return undefined
    case NEWS_READ:
      if (state === 'empty') return '这次没有拿到可引用的订阅条目。'
      return undefined
    case BROWSER_READ:
      if (state === 'empty') return '这次没有拿到可引用的页面内容。'
      return undefined
    case DESKTOP_INSPECT:
      if (state === 'empty') return '这次没有拿到可以说的桌面内容。'
      if (state === 'failed') return '这次没能看到桌面（读取没有成功）。'
      return undefined
    default:
      return undefined
  }
}

export function turnContentReplyStateOf(input: {
  fact: TurnContentFact
  /** 这一项实际入了模的份数（由 `injectedCountOf` 从 `reality.refs` 算出） */
  injectedCount: number
}): TurnContentReplyState {
  const { fact } = input
  if (fact.status === 'success' || fact.status === 'partial') {
    return input.injectedCount > 0 ? 'delivered' : 'empty'
  }
  if (fact.status === 'timeout') return 'timeout'
  if (
    fact.status === 'rejected' &&
    (fact.failureCode === 'permission_denied' || fact.failureCode === undefined)
  ) {
    /*
     * ⚠️ `permission_denied` 在这里**只**表示"开关关闭 ⇒ 未授予权限"这一条路径：
     *    四项能力都是本地构造的，它们的失败不经过 HTTP 状态码，因此没有
     *    `external-evidence-reply.ts` 那个"401/403 也是 permission_denied"的二义性。
     *    这一点写在这里是为了避免把那个修复的思路错误地照搬过来。
     */
    return 'not_enabled'
  }
  return 'failed'
}

/** 各态如实的用户可见句（**只在这些态需要"顶替"时使用**） */
export function truthfulTurnContentSentence(input: {
  capability: string
  state: TurnContentReplyState
}): string | undefined {
  const label = turnContentCapabilityLabel(input.capability)
  const specific = truthfulSentenceForCapability({
    capability: input.capability,
    state: input.state,
    label,
  })
  if (specific !== undefined) return specific
  switch (input.state) {
    case 'delivered':
    case 'no_content':
      return undefined
    case 'empty':
      // 第一批的通用句（除上面已按能力分叉的那几个）
      return `我打开看了，但这次没有取到可以引用的内容——所以给不出来源。`
    case 'timeout':
      return `这次${label}超时了，我没有拿到内容。`
    case 'failed':
      return `这次${label}失败了，没有拿到内容。`
    case 'not_enabled':
      return `我这边${label}没有启用，所以没法替你做这件事。`
  }
}

/** 剥离模型正文里所有 `[C<数字>]` 内联标签，并顺手清理留下的空格 */
function stripInlineContentLabels(text: string): { text: string; stripped: string[] } {
  const stripped = turnContentLabelsIn(text)
  if (stripped.length === 0) return { text, stripped: [] }
  const cleaned = text
    .replace(/\s?\[C[0-9]{1,4}\]/g, '')
    .replace(/[ \t]+([，,。.、；;：:！!？?）)】\]])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
  return { text: cleaned, stripped }
}

/**
 * 应用当轮内容的回复策略。
 *
 * **纯函数**：同输入必同输出、不读时间/环境、不写任何东西。
 * 调用点必须在**写账本与写 memories 之前**（M4.1 的现场纪律：
 * 账本里不能留着一句没有被说出口的话）。
 */
export function applyTurnContentReplyPolicy(
  input: TurnContentReplyInput
): TurnContentReplyOutcome {
  const facts = input.facts ?? []
  const reachedContext = input.reality?.reachedContext === true
  const refs = input.reality?.refs ?? []

  // ① 先剥离内联标签：无论哪一态，正文里都不留 `[C<n>]`
  const stripped = stripInlineContentLabels(input.replyText)
  let replyText = stripped.text

  if (facts.length === 0) {
    return {
      replyText,
      appendix: '',
      states: [],
      corrected: replyText !== input.replyText,
      markers: [],
      strippedLabels: stripped.stripped,
    }
  }

  const states = facts.map((fact) => ({
    capability: fact.capability,
    state: turnContentReplyStateOf({
      fact,
      injectedCount: injectedCountOf({ capability: fact.capability, ...(input.reality !== undefined ? { reality: input.reality } : {}) }),
    }),
  }))

  // ② 全部交付 ⇒ 安静 + 追加**确定性来源与范围附录**
  if (states.every((entry) => entry.state === 'delivered')) {
    const appendix = buildTurnContentAppendix(refs, { reachedContext: true })
    const withAppendix = appendix === '' ? replyText : `${replyText}\n\n${appendix}`
    return {
      replyText: withAppendix,
      appendix,
      states,
      corrected: withAppendix !== input.replyText,
      markers: [],
      strippedLabels: stripped.stripped,
    }
  }

  // OCR 资产故障是程序事实；不保留模型猜测的图片/格式原因，也不透传路径或原始错误。
  if (facts.some((fact) => fact.capability === IMAGE_OCR && fact.failureReason === 'ocr_assets_missing' && fact.status === 'failed')) {
    const truthful = '本地 OCR 资产不可用，缺少或损坏模型/运行环境；这次没有识别到内容。'
    return { replyText: truthful, appendix: '', states, corrected: truthful !== input.replyText,
      markers: ['ocr_assets_missing'], strippedLabels: stripped.stripped }
  }

  // ③ 有非交付态：出现成功口吻 ⇒ 顶替成如实句；没有成功口吻 ⇒ 保持原样
  const claim = scanClaims(replyText, TURN_CONTENT_SUCCESS_MARKERS)
  const firstBad = states.find((entry) => entry.state !== 'delivered')
  const truthful =
    firstBad === undefined
      ? undefined
      : truthfulTurnContentSentence({ capability: firstBad.capability, state: firstBad.state })

  if (!claim.claims || truthful === undefined) {
    return {
      replyText,
      appendix: '',
      states,
      corrected: replyText !== input.replyText,
      markers: [],
      strippedLabels: stripped.stripped,
    }
  }
  return {
    replyText: truthful,
    appendix: '',
    states,
    corrected: true,
    markers: claim.markers,
    strippedLabels: stripped.stripped,
  }
}
