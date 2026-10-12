/**
 * ExecutionLedger —— **她做过什么**（M4.5 §18 / ADR-034）。
 *
 * ============================================================================
 *  与 Memory 是两本账，且都是 append-only
 * ============================================================================
 * ```text
 * Memory 保存：她知道什么
 * Ledger 保存：她做过什么
 * ```
 *
 * 端口上只有**具名操作**（九个阶段），没有 `append(event)`：
 * 与 `ConversationLedgerPort` 同一条理由 ——
 * 一个万能入口会让"某个调用点忘了 traceId / status 写错"变成可能。
 *
 * ⚠️ **没有 update / delete**。不是"我们约定不改"，是端口上根本没有那两个字。
 */

import type {
  ActionId,
  CharacterId,
  Timestamp,
  TraceId,
} from '../contracts/ids.ts'
import type {
  ActionEffect,
  ActionEvidence,
  ActionRequest,
  ActionTarget,
  SideEffectLevel,
} from './action-request.ts'
import type { ActionStatus } from './action-result.ts'
import type { ActionFailure } from './errors.ts'
import type { PolicyDecision } from './policy.ts'
import type {
  AttributionEventFamily,
  AttributionValueSlot,
  TrustedActionAttributionContext,
} from '../contracts/attribution.ts'
import type { AttributionValue, PrincipalRef } from '../contracts/actor.ts'

/** §44 的九个动作事件 */
export type ActionEventType =
  | 'ACTION_REQUESTED'
  | 'ACTION_TARGET_RESOLVED'
  | 'ACTION_AUTHORIZED'
  | 'ACTION_REJECTED'
  | 'ACTION_STARTED'
  | 'ACTION_SUCCEEDED'
  | 'ACTION_FAILED'
  | 'ACTION_PARTIAL'
  | 'ACTION_CANCELLED'

export const ACTION_EVENT_TYPES: readonly ActionEventType[] = [
  'ACTION_REQUESTED',
  'ACTION_TARGET_RESOLVED',
  'ACTION_AUTHORIZED',
  'ACTION_REJECTED',
  'ACTION_STARTED',
  'ACTION_SUCCEEDED',
  'ACTION_FAILED',
  'ACTION_PARTIAL',
  'ACTION_CANCELLED',
]

export interface ActionLedgerEvent {
  actionId: ActionId
  traceId: TraceId
  characterId: CharacterId
  /** 同一 action 内的次序（由持久层原子分配） */
  sequence: number
  type: ActionEventType
  /** 终态事件才有；其它事件为 `undefined` */
  status?: ActionStatus
  capability: string
  operation: string
  idempotencyKey?: string
  payload: Record<string, unknown>
  createdAt: Timestamp
  /**
   * WP5（§WP5-8）：**RECORDED 行**回读出来的权威归因快照。
   *
   * 只在 `attribution_origin = 'RECORDED'` 时出现；历史行**不会**被凭空补一个信封
   * （"没有"本身就是要如实表达的读结果）。三态逐字解码，不做任何推断。
   */
  attribution?: {
    attributionOrigin: 'RECORDED'
    eventType: string
    family: AttributionEventFamily
    subject: PrincipalRef
    slots: Record<AttributionValueSlot, AttributionValue<unknown>>
  }
}

// ---------------------------------------------------------------------------
// 具名写入输入
// ---------------------------------------------------------------------------

interface Base {
  characterId: CharacterId
  request: ActionRequest
  /**
   * Gateway **实际使用**的幂等键。
   *
   * ⚠️ 它可能与 `request.idempotencyKey` 不同：请求方没有显式给键时，
   *    Gateway 会用"能力 + 操作 + 已解析目标 + 参数"推导一个。
   *    而 `ACTION_REQUESTED` 是在**目标解析之前**写的（那一步可能什么都不做），
   *    因此推导键只能挂在后面的事件上 —— 这是顺序的必然结果，
   *    不是遗漏（折叠会从任一事件上把它读出来）。
   */
  effectiveIdempotencyKey?: string
  /**
   * WP5（§WP5-7）：**这一阶段**的受信归因快照（只能由
   * `buildTrustedActionAttribution()` 产出）。
   *
   * 不传 ⇒ 本函数的 SQL 与今天逐字段相同（legacy 路径零影响）。
   * 传了但形状/族/必要性不对 ⇒ 持久层**拒绝**（不写半截）。
   *
   * ⚠️ 它是**阶段快照**，不是"整个生命周期共享的可变信封"（WP5-5）：
   *    每个事件各自构造一次，早期行永不因为后期事实而被改写。
   */
  attribution?: TrustedActionAttributionContext
}

export interface AppendActionRequestedInput extends Base {}

export interface AppendTargetResolvedInput extends Base {
  target: ActionTarget
  scopeViolation: boolean
}

export interface AppendAuthorizedInput extends Base {
  target: ActionTarget
  decision: PolicyDecision
}

export interface AppendRejectedInput extends Base {
  target: ActionTarget | undefined
  decision: PolicyDecision
  failure: ActionFailure
  status: ActionStatus
}

export interface AppendStartedInput extends Base {
  target: ActionTarget | undefined
}

export interface AppendSucceededInput extends Base {
  target: ActionTarget | undefined
  effect?: ActionEffect
  evidence: readonly ActionEvidence[]
  /** 幂等重放：命中了之前的终态，**没有**第二次副作用 */
  idempotentReplay?: boolean
}

export interface AppendPartialInput extends Base {
  target: ActionTarget | undefined
  effect?: ActionEffect
  evidence: readonly ActionEvidence[]
  progress: { completed: number; total: number; detail?: string }
}

export interface AppendFailedInput extends Base {
  target: ActionTarget | undefined
  failure: ActionFailure
  /**
   * 失败的具体状态：`failed` / `not_found` / `ambiguous` / `timeout` / `rejected`。
   * 由调用方传入而不是端口推导 —— 端口不认识业务语义（同 `conversation-store` 的纪律）。
   */
  status: ActionStatus
}

export interface AppendCancelledInput extends Base {
  target: ActionTarget | undefined
  failure?: ActionFailure
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export interface ActionLedgerQuery {
  characterId: CharacterId
  /**
   * 按**终态状态**过滤。这是 L0/Measurement 的核心参数：
   * 过滤必须发生在 SQL 里（`action-ledger-store.ts`），不是读回来再 filter。
   */
  status?: ActionStatus
  capability?: string
  limit: number
}

export interface ExecutionLedgerPort {
  appendRequested(input: AppendActionRequestedInput): Promise<ActionLedgerEvent>
  appendTargetResolved(input: AppendTargetResolvedInput): Promise<ActionLedgerEvent>
  appendAuthorized(input: AppendAuthorizedInput): Promise<ActionLedgerEvent>
  appendRejected(input: AppendRejectedInput): Promise<ActionLedgerEvent>
  appendStarted(input: AppendStartedInput): Promise<ActionLedgerEvent>
  appendSucceeded(input: AppendSucceededInput): Promise<ActionLedgerEvent>
  appendPartial(input: AppendPartialInput): Promise<ActionLedgerEvent>
  appendFailed(input: AppendFailedInput): Promise<ActionLedgerEvent>
  appendCancelled(input: AppendCancelledInput): Promise<ActionLedgerEvent>

  /** 一个 action 的全部事件（按 sequence 升序） */
  getEventsByActionId(characterId: CharacterId, actionId: ActionId): Promise<ActionLedgerEvent[]>
  /** 一条 trace 串起来的全部动作事件（§20 的反查方向之一） */
  getEventsByTraceId(traceId: TraceId): Promise<ActionLedgerEvent[]>
  /** 原始事件流（审计 / 重放用） */
  listEvents(characterId: CharacterId, limit: number): Promise<ActionLedgerEvent[]>
  /**
   * 最近的终态记录（按 status / capability 过滤）。
   *
   * 返回的是**折叠后的 `ExecutionRecord`**：调用方不该自己解释事件流 ——
   * 否则"CLI 与门各解释一遍"就又会分叉（ADR-035）。
   */
  listRecords(query: ActionLedgerQuery): Promise<ExecutionRecordView[]>
  findByIdempotencyKey(
    characterId: CharacterId,
    idempotencyKey: string
  ): Promise<ExecutionRecordView | undefined>
}

/**
 * 折叠后的执行记录视图。
 *
 * ⚠️ 它不是 `ExecutionRecord`（`execution-record.ts`），而是**持久层返回的
 * 最小投影**：`request / decision / result / timestamps` 都是已经折叠好的
 * 普通对象（没有 Live 引用、没有数据库句柄）。
 * 之所以不直接复用 `ExecutionRecord`：后者要读全字段，而列表视图不需要。
 */
export interface ExecutionRecordView {
  actionId: ActionId
  traceId: TraceId
  capability: string
  operation: string
  status: ActionStatus
  executed: boolean
  accepted: boolean
  /**
   * 能力声明的副作用等级（来自 `ACTION_REQUESTED`）。
   *
   * ⚠️ 审计不变量用的是**这个**，而不是适配器自报的 `effect.kind`：
   *    "我改变了世界"必须由**声明**决定（fail-closed），
   *    否则一个写能力只要返回 `{kind:'no_change'}` 就能绕过
   *    "有副作用必须有确定目标"（ADR-032 / INV-M45-03）。
   */
  sideEffect: SideEffectLevel
  idempotencyKey?: string
  /** 是否幂等重放（没有第二次副作用） */
  idempotentReplay: boolean
  target?: ActionTarget
  failure?: ActionFailure
  effect?: ActionEffect
  /** 部分成功时的进度（`status === 'partial'` 时才有） */
  progress?: { completed: number; total: number; detail?: string }
  evidence: ActionEvidence[]
  requestedAt: Timestamp
  startedAt?: Timestamp
  finishedAt?: Timestamp
}
