/**
 * ExecutionRecord —— 事件流折叠成的"她做过什么"（M4.5 §19 / ADR-034）。
 *
 * ============================================================================
 *  §19 的形状在这里，而**数据库里没有这样一行**
 * ============================================================================
 * `ExecutionRecord` 是 `character_action_events` 折叠出来的视图：
 *
 * ```text
 * ACTION_REQUESTED → ACTION_TARGET_RESOLVED → ACTION_AUTHORIZED
 *   → ACTION_STARTED → ACTION_SUCCEEDED / ACTION_FAILED / ACTION_PARTIAL
 * ```
 *
 * 折叠是**纯函数**，因此可以离线对同一事件流跑两次比对
 * （"账本能自证"），也可以在 `--action-trace` 里直接重新算一遍 ——
 * 而不是相信某个缓存字段。
 *
 * ⚠️ 列表视图（`ExecutionRecordView`，见 `execution-ledger.ts`）是这个
 *    折叠的**投影**，由持久层实现（因为列表要能按 status 在 SQL 里过滤）。
 *    两者都是纯函数，L1 有一条断言锁住它们在共有字段上必须一致 ——
 *    这是"两份实现慢慢长歪"的唯一防线。
 */

import type { ActionId, TraceId, Timestamp } from '../contracts/ids.ts'
import type { ActionEffect, ActionEvidence, ActionRequest, ActionTarget } from './action-request.ts'
import type { ActionRequester } from './action-request.ts'
import type { ActionResult, ActionStatus } from './action-result.ts'
import type { ActionFailure } from './errors.ts'
import type { ActionLedgerEvent } from './execution-ledger.ts'

/** 账本里记录的策略结论（比 `PolicyDecision` 少一层类型引用，便于落库/回读） */
export interface PolicyDecisionSummary {
  allowed: boolean
  code: string
  message: string
  riskLevel?: string
  checks?: readonly string[]
}

/**
 * 折叠视图里的 `request`。
 *
 * ============================================================================
 *  WP5-3：与 `ActionRequest` 的**唯一**差别是 `requestedBy` 可以缺席
 * ============================================================================
 * 历史 / 兼容行可能在 payload 里**没有** `requestedBy`。过去这里会把它替换成
 * `{ kind: 'system' }` —— 那是一次**伪造**："没记"被写成了"系统发起的"。
 *
 * 现在：没记录就是**没有**（`undefined`）。要表达"未知"请用归因层的
 * `Unknown(LEGACY_UNRECORDED)`（那属于 `TrustedActionAttributionContext`，
 * 而**不是**这个兼容字段）。**绝不**把 missing 静默变成 system。
 */
export type FoldingActionRequest = Omit<ActionRequest, 'requestedBy'> & {
  requestedBy?: ActionRequester
}

export interface ExecutionRecord {
  actionId: ActionId
  traceId: TraceId
  capability: string
  operation: string
  request: FoldingActionRequest
  decision?: PolicyDecisionSummary
  result?: ActionResult
  timestamps: {
    requested: Timestamp
    started?: Timestamp
    finished?: Timestamp
  }
  evidence: ActionEvidence[]
}

export function foldExecutionRecord(
  events: readonly ActionLedgerEvent[]
): ExecutionRecord | undefined {
  if (events.length === 0) return undefined
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)
  const requested = ordered.find((e) => e.type === 'ACTION_REQUESTED')
  const first = requested ?? ordered[0]!
  const payloadOf = (event: ActionLedgerEvent | undefined): Record<string, unknown> =>
    event === undefined ? {} : event.payload

  const requestPayload = payloadOf(requested)
  const request: FoldingActionRequest = {
    actionId: first.actionId,
    traceId: first.traceId,
    capability: first.capability,
    operation: first.operation,
    /*
     * WP5-3：**没有** `?? { kind: 'system' }`。
     *
     * "payload 里没写 requestedBy" 不等于 "系统发起的" —— 那是把缺失洗成一条断言
     * （与 D01 同一种错误形状，只不过这里被伪造的是 SYSTEM 而不是 USER）。
     * 折叠视图如实留空；权威层要表达"不知道"时用 `Unknown(LEGACY_UNRECORDED)`。
     */
    ...(requestPayload.requestedBy !== undefined
      ? { requestedBy: requestPayload.requestedBy as ActionRequester }
      : {}),
    arguments: (requestPayload.arguments as Record<string, unknown>) ?? {},
    sideEffect:
      (requestPayload.sideEffect as ActionRequest['sideEffect'] | undefined) ??
      (first.operation === 'read' ? 'read' : 'none'),
    ...(first.idempotencyKey !== undefined ? { idempotencyKey: first.idempotencyKey } : {}),
    createdAt: requested?.createdAt ?? first.createdAt,
    ...(requestPayload.declaredTarget !== undefined
      ? { target: requestPayload.declaredTarget as ActionTarget }
      : {}),
  }

  let decision: PolicyDecisionSummary | undefined
  let target: ActionTarget | undefined
  let status: ActionStatus | undefined
  let failure: ActionFailure | undefined
  let effect: ActionEffect | undefined
  let progress: { completed: number; total: number; detail?: string } | undefined
  let evidence: ActionEvidence[] = []
  let executed = false
  let startedAt: Timestamp | undefined
  let finishedAt: Timestamp | undefined
  let idempotentReplay = false

  for (const event of ordered) {
    const payload = event.payload
    switch (event.type) {
      case 'ACTION_TARGET_RESOLVED':
        if (payload.target !== undefined) target = payload.target as ActionTarget
        break
      case 'ACTION_AUTHORIZED':
        if (payload.target !== undefined) target = payload.target as ActionTarget
        if (payload.decision !== undefined) decision = payload.decision as PolicyDecisionSummary
        break
      case 'ACTION_REJECTED':
        if (payload.decision !== undefined) decision = payload.decision as PolicyDecisionSummary
        break
      case 'ACTION_STARTED':
        executed = true
        startedAt = event.createdAt
        break
    }

    if (
      event.type === 'ACTION_REJECTED' ||
      event.type === 'ACTION_FAILED' ||
      event.type === 'ACTION_SUCCEEDED' ||
      event.type === 'ACTION_PARTIAL' ||
      event.type === 'ACTION_CANCELLED'
    ) {
      status = (event.status ?? status) as ActionStatus
      finishedAt = event.createdAt
      if (payload.failure !== undefined) failure = payload.failure as ActionFailure
      if (payload.effect !== undefined) effect = payload.effect as ActionEffect
      if (payload.progress !== undefined) {
        progress = payload.progress as { completed: number; total: number; detail?: string }
      }
      if (Array.isArray(payload.evidence)) evidence = payload.evidence as ActionEvidence[]
      if (payload.idempotentReplay === true) idempotentReplay = true
    }
  }

  if (status === undefined) return undefined

  return {
    actionId: first.actionId,
    traceId: first.traceId,
    capability: first.capability,
    operation: first.operation,
    request: { ...request, ...(target !== undefined ? { target } : {}) },
    ...(decision !== undefined ? { decision } : {}),
    result: {
      actionId: first.actionId,
      traceId: first.traceId,
      capability: first.capability,
      operation: first.operation,
      accepted: decision?.allowed === true,
      executed,
      status,
      ...(effect !== undefined ? { effect } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(failure !== undefined ? { error: failure } : {}),
      ...(idempotentReplay ? { idempotentReplay: true } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(finishedAt !== undefined ? { finishedAt } : {}),
    },
    timestamps: {
      requested: requested?.createdAt ?? first.createdAt,
      ...(startedAt !== undefined ? { started: startedAt } : {}),
      ...(finishedAt !== undefined ? { finished: finishedAt } : {}),
    },
    evidence,
  }
}

/** 一行式审计摘要（`--action-list` / `--action-trace` 用） */
export function describeExecutionRecord(record: ExecutionRecord): string {
  const when = new Date(record.timestamps.requested).toLocaleString('zh-CN', { hour12: false })
  const target =
    record.request.target === undefined
      ? '(无目标)'
      : `${record.request.target.type}:${record.request.target.canonicalId ?? '(未解析)'}`
  const result = record.result
  return (
    `${when} ${record.actionId} ${record.capability}.${record.operation} ` +
    `target=${target} → ${result?.status ?? '(未完成)'}` +
    `${result?.executed === false ? ' (未执行)' : ''}` +
    `${result?.idempotentReplay === true ? ' [replay]' : ''}`
  )
}
