/**
 * ActionClaimGuard —— **执行真相先于回复**（M4.5 §10 / §29 / §30 / ADR-033）。
 *
 * ============================================================================
 *  两层保证，方向相反
 * ============================================================================
 *   ① 前置：动作结果作为一个 `droppable: false` 的 section 进上下文
 *      → 模型的默认倾向变成"转述一条已发生的事实"，而不是"猜自己成功了"
 *   ② 后置：**确定性**守卫。指令可以被无视，因此还需要一层语法级保证：
 *
 * ```text
 * if (没有 success 的 ActionResult) and (回复含未被否定的动作成功口吻)
 *      → 替换成按真实 status 分派的如实句
 * ```
 *
 * ---------------------------------------------------------------------------
 *  为什么词表与记忆的**不共用**
 * ---------------------------------------------------------------------------
 *   1. **命中率**：混用会让"我记住了"在动作失败时被误替换
 *   2. **回归安全**：M4.1 的 `RESPONSE_SUCCESS_MARKERS` 与
 *      `replyClaimsSuccess` 对外行为一个字节都不能变
 *      （`scripts/verify-m4-smoke-live.ts` 直接 import 它们）
 *   3. **可解释**：守卫日志要能说清是动作口吻还是记忆口吻触发的
 *
 * 共享的只有最底层的 `scanClaims`（包括 4 字符否定窗口）。
 */

import type { ActionResult, ActionStatus } from './action-result.ts'
import { isSuccessResult } from './action-result.ts'
import { scanClaims } from './claim-scanner.ts'

/**
 * "动作成功口吻"标记（§30）。
 *
 * 取舍与 M4.1 一致：只收**明确的完成态**表述，刻意不收"好"/"知道了"
 * 這类泛应声词（它们会大量误伤）。宁可漏报（退回 prompt 层），
 * 也不要误改成她没说过的意思。
 */
export const ACTION_SUCCESS_MARKERS: readonly string[] = [
  '已完成',
  '已经完成',
  '完成了',
  '已经创建',
  '创建好了',
  '已经写好',
  '写好了',
  '已经写入',
  '已经改成',
  '修改好了',
  '已经修改',
  '已经更新',
  '更新好了',
  '已经删除',
  '删掉了',
  '已经发送',
  '发出去了',
  '已经保存',
  '保存好了',
  '已经建立',
  '建好了',
  '处理好了',
  '已经处理',
  '执行成功',
  '已经读取',
  '读到了',
  '已经读',
  '搞定了',
  '弄好了',
  '帮你做了',
  '已经帮你',
]

export interface ActionClaimGuardInput {
  /** 本轮的动作结果；`undefined` / 空数组 = 这一轮没有动作请求 */
  results: readonly ActionResult[] | undefined
  /** 模型生成的回复 */
  replyText: string
}

export interface ActionClaimGuardOutcome {
  replyText: string
  corrected: boolean
  /** 触发替换的成功口吻标记（`corrected === true` 时非空） */
  markers: string[]
  /** 这一轮是否存在"允许说成功"的动作结果 */
  allowedSuccess: boolean
}

/** 回复里是否出现了未被否定的动作成功口吻 */
export function replyClaimsActionSuccess(replyText: string): {
  claims: boolean
  markers: string[]
} {
  return scanClaims(replyText, ACTION_SUCCESS_MARKERS)
}

/**
 * 失效时的优先级：越靠前越需要如实说清。
 *
 * "不确定指的是哪个"与"没找到"必须排在"失败了"之前 ——
 * 因为它们对用户要采取的行动完全不同（前者要补充说明，后者可以直接重试）。
 */
const STATUS_SEVERITY: Record<ActionStatus, number> = {
  ambiguous: 0,
  not_found: 1,
  rejected: 2,
  timeout: 3,
  failed: 4,
  cancelled: 5,
  partial: 6,
  success: 7,
}

function mostInformative(results: readonly ActionResult[]): ActionResult {
  return [...results].sort((a, b) => STATUS_SEVERITY[a.status] - STATUS_SEVERITY[b.status])[0]!
}

/** 对外（用户可见）的如实表述 */
export function truthfulActionSentence(result: ActionResult): string {
  const what = result.error?.message ?? ''
  switch (result.status) {
    case 'ambiguous':
      return '你说的那个我不确定指的是哪一个，所以什么都没动。你说得再具体一点？'
    case 'not_found':
      return '我没找到你说的那个，所以什么都没改。'
    case 'rejected':
      return `这次的操作没有被允许执行（${describeReasonCode(result)}），所以什么都没发生。`
    case 'timeout':
      return '这次执行没有等到结果，所以我不能确定它完成了没有。你要我再看一眼吗？'
    case 'failed':
      return `这次执行到一半失败了，什么都没完成。${what === '' ? '' : `（${what}）`}`
    case 'cancelled':
      return '这次操作被取消了，没有执行。'
    case 'partial': {
      const progress = result.progress
      return progress === undefined
        ? '这次只完成了一部分，剩下的没有成功。'
        : `这次只完成了一部分（${progress.completed}/${progress.total}），剩下的没有成功。`
    }
    case 'success':
      // 走到这里说明调用方判断错了（success 不需要如实句）
      return result.effect?.detail ?? '这次操作已经完成。'
  }
}

function describeReasonCode(result: ActionResult): string {
  const code = result.error?.code
  switch (code) {
    case 'permission_denied':
      return '不在允许的范围内'
    case 'unsupported':
      return '当前执行入口不支持这个操作'
    case 'validation_failed':
      return '请求本身不完整'
    default:
      return code ?? '未知原因'
  }
}

/** 给模型看的一句话事实（进上下文 section） */
export function actionFactSummary(result: ActionResult): string {
  const target = result.effect?.detail ?? ''
  switch (result.status) {
    case 'success':
      return `你**刚刚已经执行**了一次动作，并且成功了：${target || result.capability}。这是已经发生的事实，可以直接说。`
    case 'partial':
      return `你刚刚执行了一次动作，但**只完成了一部分**：${target || truthfulActionSentence(result)}。不要说得像全部做完了。`
    case 'ambiguous':
      return `有人请求你执行一个动作，但**目标不唯一**，因此系统**没有执行**。${truthfulActionSentence(result)}不要猜目标，也不要说已经处理。`
    case 'not_found':
      return `有人请求你执行一个动作，但**目标不存在**，因此系统**没有执行**。不要说你做了。`
    case 'rejected':
      return `有人请求你执行一个动作，但被系统**拒绝**（${result.error?.code ?? '未知'}），**没有任何副作用发生**。不要说你做了。`
    case 'timeout':
      return `一次动作执行**超时**，无法确定是否完成。不要说它成功了。`
    case 'failed':
      return `一次动作执行**失败**，没有完成任何事。不要说它成功了。`
    case 'cancelled':
      return `一次动作执行被取消，没有发生任何事。不要说它成功了。`
  }
}

/**
 * 应用 Action Claim Guard。
 *
 * 纯函数：同输入必同输出。**替换发生在写账本与写 memories 之前**，
 * 否则账本里会留着那句没有被说出口的话（M4.1 的现场纪律）。
 */
export function applyActionClaimGuard(input: ActionClaimGuardInput): ActionClaimGuardOutcome {
  const results = input.results ?? []
  if (results.length === 0) {
    return { replyText: input.replyText, corrected: false, markers: [], allowedSuccess: false }
  }

  const allowedSuccess = results.some((r) => isSuccessResult(r))
  if (allowedSuccess) {
    return { replyText: input.replyText, corrected: false, markers: [], allowedSuccess: true }
  }

  const claim = replyClaimsActionSuccess(input.replyText)
  if (!claim.claims) {
    return { replyText: input.replyText, corrected: false, markers: [], allowedSuccess: false }
  }

  return {
    replyText: truthfulActionSentence(mostInformative(results)),
    corrected: true,
    markers: claim.markers,
    allowedSuccess: false,
  }
}
