/**
 * 委派载荷的**形状校验**（[`ADR-146`](../../../../docs/adr/ADR-146-remote-tool-execution.md) `D01`/`D02`/`D05`）。
 *
 * ============================================================================
 *  这个模块只做一件事：**在**东西被采纳之前，把它变成一个**说得出名字的形状**，
 *  或者明确地说"不采纳"。
 * ============================================================================
 *
 * ## 为什么要有独立的一层
 *
 * `turn-bridge.ts` 的受控登记表管的是"这是不是一条**消息种类**"；
 * 这一层管的是"这条消息**长得对不对**"。
 *
 * 分开的理由：种类合法但形状非法时，**仍然必须失败关闭**。
 * 如果形状校验散落在各个消费点，那么每加一个消费点就多一处可能漏判的地方。
 *
 * ## 三条纪律（每条都有机器判据，见 ADR-146 §4）
 *
 * ① **线上不携带风险额度**（`D02`）。载荷里**没有**额度字段，
 *    多一个字段即失败 —— 不是"忽略它"，是**拒收整条**。
 *    额度是核心装配根给的程序常量（`main.ts:2734` / `gateway.ts:343`），
 *    让它重新在线上出现等于把已做过的权限判断交回给对端改。
 *
 * ② **结局是闭集**（`D05`）。`completed | rejected | failed_confirmed | unknown`。
 *    `unknown` 是默认值：形状不认识、字段缺了、执行端崩了 —— 一律 `unknown`。
 *    ⚠️ **绝不允许"没读到结果就算成功"**。
 *
 * ③ **正文不进判据**（`D04`）。`content` 可以在线上（SSH 通道已加密，
 *    且 `SUBMIT_TURN` 本来就带 `userText`），但它**不得**进入任何
 *    理由码、诊断文本或读数摘要。
 *
 * ⚠️ 这个模块**刻意不 import 任何风险额度相关的类型**（`RiskLevel` 等）。
 *    载荷里既然不允许出现额度字段（`D02`），把那个类型引进来就等于
 *    在签名里预留了它的位置 —— 而"预留"正是这条路腐化的起点。
 */

/** `DELEGATE_ACTION` / `ACTION_RESULT`（ADR-146 `D01`） */
export const DELEGATE_ACTION = 'DELEGATE_ACTION'
export const ACTION_RESULT = 'ACTION_RESULT'

/** 线上协议主版本（ADR-146 `D07`）。主号不同 ⇒ 握手直接拒，不"试试看" */
export const REMOTE_EXECUTION_PROTOCOL = 1

/** 动作结局闭集（ADR-146 `D05`）。⚠️ `unknown` 是**默认**，不是兜底的最后一档 */
export const ACTION_OUTCOMES = ['completed', 'rejected', 'failed_confirmed', 'unknown'] as const
export type ActionOutcome = (typeof ACTION_OUTCOMES)[number]

/**
 * ⚠️ **这些字段名是"不许出现"的清单**（ADR-146 §4 `M-02` 的判据本身）。
 *
 * 它们不在接口里，是因为**形状校验就是要把它们挡在门外**；
 * 把它们写成字段反而等于承认它们合法。
 */
const FORBIDDEN_ON_WIRE: readonly string[] = [
  'riskBudgetOverride', 'riskBudget', 'maxRiskLevel', 'risk',
  'riskLevel', 'grantedPermissions', 'permissions', 'allow', 'approved',
]

export interface DelegateActionRequest {
  readonly kind: typeof DELEGATE_ACTION
  /** 关联的轮次（取消按轮次走，`D06`） */
  readonly turnRequestId: string
  /** 本次委派的唯一 id（重发/去重用；**不是** `turnRequestId`） */
  readonly actionId: string
  /** 能力标识。⚠️ 核心侧先过网关策略；**线上带不出来一个新能力** */
  readonly capability: string
  /** 操作标识 */
  readonly operation: string
  readonly args: Readonly<Record<string, unknown>>
  /** 硬超时（毫秒）；核心给的**上限**，执行端不得自行放宽 */
  readonly timeoutMs: number
}

export type DelegateActionRejection =
  | 'delegate_not_an_object'
  | 'delegate_missing_turn_request_id'
  | 'delegate_missing_action_id'
  | 'delegate_missing_capability'
  | 'delegate_missing_operation'
  | 'delegate_args_not_object'
  | 'delegate_bad_timeout'
  | 'delegate_forbidden_field_on_wire'
  | 'delegate_unknown_kind'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isShortId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200

/**
 * 校验一行 `DELEGATE_ACTION`。
 *
 * ⚠️ 失败时返回的 `rejection` 是**具名码**，**不含任何载荷内容**
 *    （正文不进判据，`D04`）。
 */
export function parseDelegateAction(message: unknown):
  | { readonly ok: true; readonly value: DelegateActionRequest }
  | { readonly ok: false; readonly rejection: DelegateActionRejection } {
  if (!isPlainObject(message)) return { ok: false, rejection: 'delegate_not_an_object' }
  if (message.kind !== DELEGATE_ACTION) return { ok: false, rejection: 'delegate_unknown_kind' }

  // ① 先扫"不许出现"的字段 —— 额度类字段一旦出现，**整条拒收**（D02）
  for (const key of Object.keys(message)) {
    if (FORBIDDEN_ON_WIRE.includes(key)) return { ok: false, rejection: 'delegate_forbidden_field_on_wire' }
  }

  if (!isShortId(message.turnRequestId)) return { ok: false, rejection: 'delegate_missing_turn_request_id' }
  if (!isShortId(message.actionId)) return { ok: false, rejection: 'delegate_missing_action_id' }
  if (typeof message.capability !== 'string' || message.capability === '') {
    return { ok: false, rejection: 'delegate_missing_capability' }
  }
  if (typeof message.operation !== 'string' || message.operation === '') {
    return { ok: false, rejection: 'delegate_missing_operation' }
  }
  if (!isPlainObject(message.args)) return { ok: false, rejection: 'delegate_args_not_object' }
  const timeout = message.timeoutMs
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0 || timeout > 600_000) {
    return { ok: false, rejection: 'delegate_bad_timeout' }
  }

  return {
    ok: true,
    value: {
      kind: DELEGATE_ACTION,
      turnRequestId: message.turnRequestId,
      actionId: message.actionId,
      capability: message.capability,
      operation: message.operation,
      args: message.args,
      timeoutMs: timeout,
    },
  }
}

export interface ActionResultResponse {
  readonly kind: typeof ACTION_RESULT
  readonly actionId: string
  readonly outcome: ActionOutcome
  /** 具名理由码（`outcome !== 'completed'` 时应有） */
  readonly code?: string
  /**
   * 桌面/浏览器文字的载体（`ADR-106` 边界 ①）。
   *
   * ⚠️ 它是**引用**，不是正文。账本/trace 只收它，正文只在当轮内容里。
   */
  readonly contentRef?: string
  readonly elapsedMs?: number
}

/**
 * 解析一行 `ACTION_RESULT`。
 *
 * ⚠️ **未知 outcome 一律落 `unknown`，不是 `completed`**（`D05`）。
 *    这是本模块最要紧的一行：把它写成"默认成功"，就等于
 *    让"执行端崩了"变成"动作成功了"。
 */
export function parseActionResult(message: unknown):
  | { readonly ok: true; readonly value: ActionResultResponse }
  | { readonly ok: false; readonly rejection: 'action_result_not_an_object' | 'action_result_missing_action_id' | 'action_result_no_outcome' } {
  if (!isPlainObject(message)) return { ok: false, rejection: 'action_result_not_an_object' }
  if (message.kind !== ACTION_RESULT) return { ok: false, rejection: 'action_result_no_outcome' }
  if (!isShortId(message.actionId)) return { ok: false, rejection: 'action_result_missing_action_id' }

  const raw = message.outcome
  const outcome: ActionOutcome = ACTION_OUTCOMES.includes(raw as ActionOutcome) ? (raw as ActionOutcome) : 'unknown'

  return {
    ok: true,
    value: {
      kind: ACTION_RESULT,
      actionId: message.actionId,
      outcome,
      ...(typeof message.code === 'string' ? { code: message.code } : {}),
      ...(typeof message.contentRef === 'string' ? { contentRef: message.contentRef } : {}),
      ...(typeof message.elapsedMs === 'number' && Number.isFinite(message.elapsedMs) ? { elapsedMs: message.elapsedMs } : {}),
    },
  }
}
