/**
 * 动作委派的**派发边界**（[`ADR-146`](../../../docs/adr/ADR-146-remote-tool-execution.md) `D02`/`D03`/`D05`/`D06`）。
 *
 * ============================================================================
 *  这个模块存在的唯一理由：**让"策略拒绝的委派发不出去"成为结构事实**，
 *  而不是一条靠自觉的纪律
 * ============================================================================
 *
 * ## 为什么它必须长这样
 *
 * 网关的策略判定（`preflight`）在**委派发出去之前**就跑完了。所以这里
 * **没有**"先发出去、看看执行端会不会拒"的选项 —— 一旦发出去，
 * 就是把一个已经决定过的权限判断交给了对端。
 *
 * ⇒ 于是入口就写成**必须传 `admission`，而 `admission.allowed === false`
 * 时一行都不发**。这不是"检查一下"，是**形状上做不到**。
 *
 * ⚠️ 与 ADR `D02` 是同一条纪律的两次落地：
 *   - 线上的**载荷**里没有额度字段（`delegation-wire.ts` 的 `FORBIDDEN_ON_WIRE`）
 *   - 派发的**入口**必须带一份已通过的策略判定（这里）
 *   两处缺一，权限判断就能从别的方向被打开。
 *
 * ## ⚠️ 关于 `riskLevel`
 *
 * 它**出现在这个接口里，但绝不进载荷**。留在这里的理由只有一个：
 * 让读数/诊断能说清"这条委派本来是几级的"，而那条信息走 `emit` 的
 * **本地**通道、不上线。把它加进 `DelegateActionRequest` 就等于开了后门。
 */

import type { PolicyDecision } from '../../action/policy.ts'
import type { ActionRequest } from '../../action/action-request.ts'
import {
  ACTION_RESULT,
  DELEGATE_ACTION,
  type ActionResultResponse,
} from './delegation-wire.ts'

export type DelegationRejection =
  /** ★ M-09：策略没过 ⇒ 一行都不发 */
  | 'delegation_policy_denied'
  /** ADR 待裁定②：这个能力**不在**可委派清单里 */
  | 'delegation_capability_not_delegatable'
  /** ADR `D06`：那一轮已经被取消了 */
  | 'delegation_turn_cancelled'
  /** id 不成对 ⇒ 无法关联结果，只能拒 */
  | 'delegation_missing_action_id'
  /** 同一个 `actionId` 重复派发 */
  | 'delegation_duplicate_action_id'
  /** 执行端回了不认识的结果形状（已由 `parseActionResult` 归一到 `unknown`） */
  | 'delegation_result_unknown_action'

export interface DelegationInFlight {
  readonly actionId: string
  readonly turnRequestId: string
  readonly startedAt: number
}

export interface ActionDelegationOptions {
  /** 把一行写上线（**唯一**的出口） */
  readonly emit: (payload: Record<string, unknown>) => void
  /** 这一轮是不是已经被取消了（ADR `D06`；由 `TurnCancellationRegistry` 提供） */
  readonly isCancelled: (turnRequestId: string) => boolean
  /**
   * 可委派的能力闭集。
   *
   * ⚠️ 刻意**显式传进来**而不是"读一个全局表"：委派面是一条**权限边界**，
   *   把它藏在某个 import 后面，就等于让"多委派一个能力"变成一个不需要改这里的事。
   *   ADR 待裁定②尚未裁定 ⇒ 本轮只在门里显式给 `desktop.operate`。
   */
  readonly delegatableCapabilities: readonly string[]
  /** 硬超时上限（毫秒）。执行端**不得**自行放宽 */
  readonly timeoutMs: number
  readonly now?: () => number
}

export type DelegateOutcome =
  | { readonly ok: true; readonly actionId: string }
  | { readonly ok: false; readonly rejection: DelegationRejection; readonly policyCode?: string }

export class ActionDelegation {
  private readonly inFlight = new Map<string, DelegationInFlight>()

  constructor(private readonly options: ActionDelegationOptions) {}

  /**
   * 派发一次动作。
   *
   * ⚠️ **`admission` 是必填的**，而且 `allowed === false` 时**一行都不发**。
   *    没有"先发再拒"这个分支 —— 那正是 M-09 要排除的东西。
   */
  delegate(input: {
    readonly turnRequestId: string
    readonly actionId: string
    readonly request: ActionRequest
    readonly admission: PolicyDecision
  }): DelegateOutcome {
    if (input.actionId === '') return { ok: false, rejection: 'delegation_missing_action_id' }

    // ① 策略优先。⚠️ 顺序**不能**和 ②③ 对调：
    //    先查能力清单会让"这个能力不在清单里"与"策略拒绝"读起来一样，
    //    而这两件事该被分别看见（后者要进账本）。
    if (!input.admission.allowed) {
      // ⚠️ 这里**只回具名码**，不发任何东西到线上。
      return { ok: false, rejection: 'delegation_policy_denied', policyCode: input.admission.code }
    }
    if (!this.options.delegatableCapabilities.includes(input.request.capability)) {
      return { ok: false, rejection: 'delegation_capability_not_delegatable', policyCode: input.admission.code }
    }
    if (this.options.isCancelled(input.turnRequestId)) {
      return { ok: false, rejection: 'delegation_turn_cancelled' }
    }
    if (this.inFlight.has(input.actionId)) {
      return { ok: false, rejection: 'delegation_duplicate_action_id' }
    }

    this.inFlight.set(input.actionId, {
      actionId: input.actionId,
      turnRequestId: input.turnRequestId,
      startedAt: (this.options.now ?? Date.now)(),
    })

    /*
     * ⚠️ 载荷逐字段列出来，**不用展开运算符**。
     *   `...input.request` 会把 request 上任何多余字段一起带上线 ——
     *   而 request 恰恰是有 `riskBudgetOverride` 之类字段的地方。
     *   显式列举是这里唯一安全的写法。
     */
    this.options.emit({
      kind: DELEGATE_ACTION,
      turnRequestId: input.turnRequestId,
      actionId: input.actionId,
      capability: input.request.capability,
      operation: input.request.operation,
      // ⚠️ `ActionRequest` 上的结构化参数叫 `arguments`（不是 `args`）。
      //   载荷上用 `args` 是线上的形状（`delegation-wire.ts`），这里**显式改名**，
      //   避免"名字一样 ⇒ 以后谁把 request 整个展开上线"的顺手事。
      args: { ...input.request.arguments },
      timeoutMs: this.options.timeoutMs,
    })
    return { ok: true, actionId: input.actionId }
  }

  /**
   * 受理一次执行端回的结果（ADR `D05`）。
   *
   * ⚠️ **不认识的结果一律落 `unknown`**（`parseActionResult` 已归一），
   *    这里再兜一次底：万一有人绕过解析器直接调它。
   */
  acceptResult(result: ActionResultResponse): { ok: true; outcome: ActionResultResponse['outcome'] } {
    const known = this.inFlight.get(result.actionId)
    if (known === undefined) {
      return { ok: false as never, outcome: 'unknown' } as never
    }
    this.inFlight.delete(result.actionId)
    const outcome = ['completed', 'rejected', 'failed_confirmed', 'unknown'].includes(result.outcome)
      ? result.outcome
      : 'unknown'
    void known
    return { ok: true, outcome }
  }

  /** 那一轮被取消时，把它名下的委派一并中止（ADR `D06`）。回**中止了几条**。 */
  abortTurn(turnRequestId: string): number {
    let n = 0
    for (const [id, item] of [...this.inFlight.entries()]) {
      if (item.turnRequestId !== turnRequestId) continue
      this.inFlight.delete(id)
      n += 1
    }
    return n
  }

  /** 在途读数（不返回任何载荷内容） */
  snapshot(): readonly DelegationInFlight[] {
    return [...this.inFlight.values()]
  }
}

export { ACTION_RESULT }
