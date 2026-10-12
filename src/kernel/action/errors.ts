/**
 * 失败语义归一（M4.5 计划书 §27）。
 *
 * ============================================================================
 *  "禁止所有工具各自 throw random error"
 * ============================================================================
 * 各能力的适配器天然会抛各种各样的东西：`ENOENT`、`EACCES`、
 * 自己 new 的 `Error`、乃至一个字符串。如果让这些形状流到账本与回复层，
 * 就会出现：
 *
 *   · 账本里 status 五花八门，"失败率"无法统计
 *   · 回复层只能写一句含糊的"没成功"，用户分辨不出是权限还是不存在
 *
 * 因此每一种失败都必须**先归一到九种码之一**，再进入 ActionResult。
 *
 * ```text
 * validation_failed    请求本身不合法（缺参 / 幂等键缺失）
 * permission_denied    策略或沙箱范围拒绝
 * target_not_found     目标不存在
 * target_ambiguous     目标不唯一 / 证据不足
 * execution_failed     适配器真的失败了
 * timeout              超时（**不等于**成功，也不等于失败）
 * partial_success      部分成功（§28）
 * cancelled            被取消
 * unsupported          能力不认这个操作 / 环境不支持
 * ```
 */

import type { ActionStatus } from './action-result.ts'

export type ActionFailureCode =
  | 'validation_failed'
  | 'permission_denied'
  | 'target_not_found'
  | 'target_ambiguous'
  | 'target_uncertain'
  | 'execution_failed'
  | 'timeout'
  | 'partial_success'
  | 'cancelled'
  | 'unsupported'

export const ACTION_FAILURE_CODES: readonly ActionFailureCode[] = [
  'validation_failed',
  'permission_denied',
  'target_not_found',
  'target_ambiguous',
  'target_uncertain',
  'execution_failed',
  'timeout',
  'partial_success',
  'cancelled',
  'unsupported',
]

/**
 * 失败码 → ActionResult.status 的**唯一映射**。
 *
 * 放在这里而不是各调用点：`partial_success → partial` 这类对应关系
 * 一旦允许各处自己写，就会出现"同样是部分成功，一处报 success 一处报 partial"。
 * 而 §28 明确要求：写 3 个文件成功 2 个，结果**不能**是 success。
 */
export function actionStatusOfFailure(code: ActionFailureCode): ActionStatus {
  switch (code) {
    case 'target_not_found':
      return 'not_found'
    case 'target_ambiguous':
    case 'target_uncertain':
      return 'ambiguous'
    case 'partial_success':
      return 'partial'
    case 'timeout':
      return 'timeout'
    case 'cancelled':
      return 'cancelled'
    case 'execution_failed':
      return 'failed'
    case 'validation_failed':
    case 'permission_denied':
    case 'unsupported':
      return 'rejected'
  }
}

export interface ActionFailure {
  code: ActionFailureCode
  message: string
  details?: Record<string, unknown>
}

export function actionFailure(
  code: ActionFailureCode,
  message: string,
  details?: Record<string, unknown>
): ActionFailure {
  return details === undefined ? { code, message } : { code, message, details }
}

/**
 * 把适配器抛出的任意东西归一成一条失败。
 *
 * ⚠️ 刻意**不**把未知错误当成"成功"或"没有发生"：
 *    未知错误是 `execution_failed` —— 最保守的那个结论。
 *    "静默失败"在执行层等于"她撒谎"（M4 的原话，同样适用于动作）。
 */
export function normalizeAdapterError(error: unknown): ActionFailure {
  // 适配器主动抛出的"已归一失败"必须原样保留（否则 timeout 会被降级成 execution_failed）
  if (error instanceof ActionFailureError) return error.failure
  if (isActionFailureLike(error)) return error

  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    // 常见的文件系统错误码映射。刻意只映射**确定**的那几个 ——
    // 猜错的映射比不映射更危险（它会把权限问题报成"不存在"）。
    if (code === 'ENOENT') {
      return actionFailure('target_not_found', error.message)
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return actionFailure('permission_denied', error.message)
    }
    if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
      return actionFailure('timeout', error.message)
    }
    return actionFailure('execution_failed', error.message, { errorName: error.name })
  }

  return actionFailure('execution_failed', String(error))
}

/** 让适配器可以**主动**抛出一个已归一的失败（避免字符串匹配） */
export class ActionFailureError extends Error {
  readonly failure: ActionFailure

  constructor(failure: ActionFailure) {
    super(failure.message)
    this.name = 'ActionFailureError'
    this.failure = failure
  }
}

export function isActionFailureLike(value: unknown): value is ActionFailure {
  if (value === null || typeof value !== 'object') return false
  const code = (value as { code?: unknown }).code
  const message = (value as { message?: unknown }).message
  return (
    typeof message === 'string' &&
    typeof code === 'string' &&
    (ACTION_FAILURE_CODES as readonly string[]).includes(code)
  )
}
