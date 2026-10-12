/**
 * 「从**决定要发**到**交给外壳**」这一段（post-Lv2 / ADR-110 `D05`/`D07`/`D08`）。
 *
 * ============================================================================
 *  它在链路里的位置
 * ============================================================================
 * ```text
 * WP3 判据层    入口读点 → 到期 / 空闲 → 候选
 * WP4 判据层    闭集提案（silence / defer / send）+ 来源复核
 * ← 本模块 →   决定是 send 之后：**登记 → 经真网关执行 → 交给外壳**
 * WP5 线缆      外壳真的调 send API → 回执 → `QqDeliveryRegistry` 结算实例状态
 * ```
 *
 * ============================================================================
 *  顺序是**判据**的一部分，不是实现细节
 * ============================================================================
 * ```text
 * ① `assertDeliverable(generation)`  —— 没有当前投递连接 ⇒ **什么都不动**
 *    （实例留在 `prepared`：它没有被"尝试过"，如实）
 * ② `beginDispatch` → `dispatching`  —— **先**进 dispatching 再执行
 *    ⚠️ 顺序反过来的话，外壳回执可能**快过**这次状态写入，
 *       而 `prepared → api_accepted` **不在迁移表里** ⇒ 一条真回执会被判"非法迁移"。
 *       先写 dispatching ⇒ 回执永远有落点（`dispatching → {api_accepted,failed_confirmed,delivery_unknown}`）。
 * ③ 经**真网关**执行（额度在这一步由调用点签发；见 `riskBudgetOverride` 的注释）
 * ④ 网关**拒了** ⇒ `dispatching → failed_confirmed` + 具名 reason
 *    ⚠️ 这是"确定没发出"（本地事实），不是"结果不明"。
 *       它让"进了 dispatching 的实例**一定**落在一个终态上"，不会被卡住。
 * ⑤ 执行成功 ⇒ 返回；**平台结局**由回执那一侧写（本模块**不**猜）
 * ```
 *
 * ⚠️ **不重试**（`D08`）：一次调用 = 一次尝试。重发由上层按规则决定，
 *    这里"再试一次"会把"可能已送达"变成"确定送两次"。
 */
import type { NotificationKind, NotificationOccurrenceState } from '../contracts/notification.ts'

/** 投递登记那一侧的两个动作（权威在 `notification_occurrences`） */
export interface ProactiveDispatchPort {
  /** 闸：这一次投递有权吗（连接代次） */
  assertDeliverable(generation: number | null): { ok: boolean; code?: string }
  /** `prepared`（或 `evaluating`/`pending`）→ `dispatching` */
  beginDispatch(input: {
    occurrenceKey: string
    generation: number | null
  }): Promise<{ ok: boolean; code?: string; state?: NotificationOccurrenceState }>
  /** 网关拒了 ⇒ 定案为"确定没发出" */
  settleConfirmedFailure(input: {
    occurrenceKey: string
    reasonCode: string
  }): Promise<{ ok: boolean; code?: string; state?: NotificationOccurrenceState }>
}

/** 经**真网关**执行一次 `qq.private.message` / `send` */
export interface ProactiveActionPort {
  execute(input: {
    text: string
    occurrenceKey: string
    kind: NotificationKind
  }): Promise<{
    outcome: 'executed' | 'refused'
    /** `outcome === 'refused'` 时的**闭集**失败码（来自策略/网关，不是自造的） */
    code?: string
    actionId?: string
  }>
}

export interface ProactiveDispatchOutcome {
  /** 这一句**交给外壳了**（还**不**等于送达 —— 平台结局由回执写） */
  readonly dispatched: boolean
  /** 具名理由（未投递时必有） */
  readonly code?: string
  /** 推进之后的实例状态 */
  readonly state?: NotificationOccurrenceState
  /** 账本里的动作 id（进了网关才有） */
  readonly actionId?: string
}

/**
 * 把一条**已经过判据层**的正文交给外壳。
 *
 * ⚠️ 它**不**判断"该不该发"：调用方必须先拿到 WP4 的 `send` 决定。
 *    传进来的正文必须是**已过回复守卫**的那一份（与 `TURN_RESULT.replyText` 同一条纪律）。
 */
export async function dispatchProactiveText(input: {
  occurrenceKey: string
  text: string
  kind: NotificationKind
  generation: number | null
  dispatch: ProactiveDispatchPort
  action: ProactiveActionPort
}): Promise<ProactiveDispatchOutcome> {
  const occurrenceKey = String(input.occurrenceKey ?? '').trim()
  if (occurrenceKey === '') {
    return { dispatched: false, code: 'proactive_dispatch_without_occurrence' }
  }
  const text = String(input.text ?? '')
  if (text.trim() === '') {
    return { dispatched: false, code: 'proactive_dispatch_without_text' }
  }

  /* ① 闸：没有当前投递连接 ⇒ **什么都不动**（实例留在 prepared） */
  const gate = input.dispatch.assertDeliverable(input.generation)
  if (!gate.ok) return { dispatched: false, code: gate.code ?? 'qq_delivery_no_active_connection' }

  /* ② 先进 dispatching（见文件头的顺序说明） */
  const begun = await input.dispatch.beginDispatch({
    occurrenceKey,
    generation: input.generation,
  })
  if (!begun.ok) return { dispatched: false, code: begun.code ?? 'dispatch_begin_refused', state: begun.state }

  /* ③ 经真网关执行（额度由调用点签发） */
  const executed = await input.action.execute({ text, occurrenceKey, kind: input.kind })

  /* ④ 网关拒了 ⇒ 确定没发出（不是"结果不明"） */
  if (executed.outcome !== 'executed') {
    const reasonCode = `gateway_refused:${executed.code ?? 'unknown'}`
    const settled = await input.dispatch.settleConfirmedFailure({ occurrenceKey, reasonCode })
    return {
      dispatched: false,
      code: executed.code ?? 'proactive_dispatch_refused',
      state: settled.state ?? begun.state,
    }
  }

  /* ⑤ 交给外壳了：平台结局等回执 */
  return {
    dispatched: true,
    state: begun.state ?? 'dispatching',
    ...(executed.actionId === undefined ? {} : { actionId: executed.actionId }),
  }
}
