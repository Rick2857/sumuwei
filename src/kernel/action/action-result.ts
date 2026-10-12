/**
 * ActionResult —— **执行真相的唯一载体**（M4.5 计划书 §9 / ADR-033）。
 *
 * ============================================================================
 *  "她说了她做了" 与 "系统真的做了" 之间只能有这一种桥
 * ============================================================================
 * 回复层（`claim-guard.ts`）只认这个类型：
 *
 *   · `executed === false` → 不允许出现成功口吻
 *   · `status === 'partial'` → 必须表达"只完成了一部分"
 *   · `status === 'ambiguous'` → 不得猜目标
 *   · `status === 'timeout'` → 不得当成 success
 *
 * 因此 `accepted` 与 `executed` 是**两个独立**的布尔：
 *
 * ```text
 * accepted = 策略允许做这件事
 * executed = 适配器真的被调用了
 * ```
 *
 * 策略拒绝时 `accepted=false, executed=false`。
 * 允许但适配器抛错时 `accepted=true, executed=true, status='failed'`。
 * 把两者合成一个布尔，就无法区分"没被允许"与"做了但失败了"。
 */

import type { ActionId, Timestamp, TraceId } from '../contracts/ids.ts'
import type { ExternalEvidence } from '../contracts/external-evidence.ts'
import type { TurnContent } from '../contracts/turn-content.ts'
import type { ActionEffect, ActionEvidence } from './action-request.ts'
import type { ActionFailure } from './errors.ts'

export type ActionStatus =
  | 'success'
  | 'rejected'
  | 'failed'
  | 'partial'
  | 'not_found'
  | 'ambiguous'
  | 'timeout'
  | 'cancelled'

export const ACTION_STATUSES: readonly ActionStatus[] = [
  'success',
  'rejected',
  'failed',
  'partial',
  'not_found',
  'ambiguous',
  'timeout',
  'cancelled',
]

export interface ActionResult {
  actionId: ActionId
  traceId: TraceId

  capability: string
  operation: string

  /** 策略是否允许 */
  accepted: boolean
  /** 适配器是否真的被调用过 */
  executed: boolean

  status: ActionStatus

  effect?: ActionEffect
  evidence?: ActionEvidence[]

  /**
   * M5.5（ADR-045 `D-2`/`D-8`）：这一轮搜索得到的**外部证据**（当轮内存载体，**含摘要**）。
   *
   * ⚠️ **永不进库**：账本与 trace 只收 `evidence[].externalEvidence`（引用）。
   *    它存在的意义是让同一轮后续的环节（上下文 section / 来源附录，WP5/WP6）
   *    拿到"实际拿到的证据"，而不必再去问 provider 一次。
   */
  externalEvidence?: readonly ExternalEvidence[]

  /**
   * 实用能力加装：这一轮真的读到的**当轮内容**（计算 / 文档 / 网页正文 / OCR）。
   *
   * ⚠️ **永不进库**（与 `externalEvidence` 同一条纪律，但边界更硬）：
   *    账本与 trace 只收 `toTurnContentRef()` 的产物 —— 那是**没有 `text` 字段**的类型
   *    （隐私边界靠类型，不靠纪律）。它存在的意义是让同一轮后续环节
   *    （上下文 section / 程序追加的来源与范围附录 / 回复守卫）拿到**实际取得的正文**，
   *    而不必再读一次文件、再抓一次网页、再算一次。
   *
   * ⚠️ 旧请求不产生这个字段（缺省 `undefined`）⇒ 默认三能力集合与旧 packet 基线不变。
   */
  turnContent?: readonly TurnContent[]

  /**
   * 部分成功时的进度（`status === 'partial'` 时才有）。
   *
   * ⚠️ 它必须存在：§28 要求"系统回复也必须体现只完成其中一部分"，
   *    而"3 个里成功了 2 个"这句话只有一个来源 —— 执行结果本身。
   *    让回复层去数 `effect` 是另一种"猜"。
   */
  progress?: { completed: number; total: number; detail?: string }

  error?: ActionFailure

  /**
   * 幂等重放：这次请求命中了之前的终态，**没有**第二次副作用。
   * 它仍然可以是 `success`（因为目标状态已经达成），但账本必须如实记录。
   */
  idempotentReplay?: boolean

  startedAt?: Timestamp
  finishedAt?: Timestamp
}

/** 唯一被允许出现成功口吻的条件 */
export function isSuccessResult(result: Pick<ActionResult, 'executed' | 'status'>): boolean {
  return result.executed && result.status === 'success'
}

/**
 * 适配器是否**自报**了一次真实效果。
 *
 * ⚠️ 它**不是**审计判据。审计用的是"能力声明的 sideEffect"+
 * "真的成功了"（见 `audit-invariants.ts` 的 `changedWorld`）——
 * 否则一个写能力只要返回 `{kind:'no_change'}` 就能绕过
 * "有副作用必须有确定目标"。这个函数只用于诊断与回复措辞。
 */
export function producedSideEffect(
  result: Pick<ActionResult, 'executed' | 'status' | 'effect'>
): boolean {
  if (!result.executed) return false
  if (result.status !== 'success' && result.status !== 'partial') return false
  return result.effect !== undefined && result.effect.kind !== 'none' && result.effect.kind !== 'no_change'
}

/** 一行式摘要（进 trace / 日志用；**不含参数内容**） */
export function describeActionResult(result: ActionResult): string {
  return (
    `${result.capability}.${result.operation} ${result.status}` +
    `${result.accepted ? '' : ' (未授权)'}` +
    `${result.executed ? '' : ' (未执行)'}` +
    `${result.idempotentReplay === true ? ' [idempotent-replay]' : ''}` +
    `${result.error !== undefined ? ` [${result.error.code}]` : ''}`
  )
}
