import { AsyncLocalStorage } from 'node:async_hooks'
import type { ActionRequest } from '../../kernel/action/action-request.ts'
import type { AdapterDelegator } from '../../kernel/action/gateway.ts'
import { ActionFailureError, actionFailure } from '../../kernel/action/errors.ts'
import type { PolicyDecision } from '../../kernel/action/policy.ts'
import { ActionDelegation } from '../../kernel/app/bridge/action-delegation.ts'
import { ACTION_RESULT, type ActionOutcome } from '../../kernel/app/bridge/delegation-wire.ts'
import type { PayloadStagingPort } from '../../kernel/action/payload-staging.ts'
import { DESKTOP_TYPE_MAX_CHARS } from '../../kernel/action/desktop-capability.ts'

export interface ExecutorLink {
  send(payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ outcome: ActionOutcome; code?: string }>
  isCancelled(turnRequestId: string): boolean
}
const turnSignals = new AsyncLocalStorage<AbortSignal | undefined>()
export function withExecutorTurnSignal<T>(signal: AbortSignal | undefined, run: () => T): T {
  return turnSignals.run(signal, run)
}

/** Await the result before Gateway appends its terminal event. No ledger rewriting. */
export function executorDelegator(
  link: ExecutorLink | undefined, request: ActionRequest, decision: PolicyDecision, staging?: PayloadStagingPort,
  remoteRequired = false,
): AdapterDelegator | undefined {
  if (request.capability !== 'desktop.operate') return undefined
  if (!link) return remoteRequired ? { send: async () => {
    throw new ActionFailureError(actionFailure('execution_failed', 'PC 执行端未连接，未派发动作；请恢复连接后再发起新请求'))
  } } : undefined
  return { send: async (req, admission) => {
    const signal = turnSignals.getStore()
    const turnRequestId = String(req.traceId)
    if (signal?.aborted) throw new ActionFailureError(actionFailure('cancelled', '本轮已取消，未派发动作'))
    let payload: Record<string, unknown> | undefined
    const dispatcher = new ActionDelegation({ emit: value => { payload = value },
      isCancelled: id => signal?.aborted === true || link.isCancelled(id),
      delegatableCapabilities: ['desktop.operate'], timeoutMs: 30_000 })
    const sent = dispatcher.delegate({ turnRequestId, actionId: String(req.actionId), request: req, admission })
    if (!sent.ok || !payload) throw new ActionFailureError(actionFailure('permission_denied', '委派被拒绝，未派发动作'))
    try {
      if (req.arguments.action === 'type') {
        const ref = req.arguments.payloadRef
        const value = typeof ref === 'string' ? staging?.read(ref) : undefined
        if (value?.kind !== 'text' || value.text.length > DESKTOP_TYPE_MAX_CHARS) {
          throw new ActionFailureError(actionFailure('validation_failed', 'PC 输入正文的私有暂存不存在或超过限额，未派发'))
        }
        // Only the encrypted executor transport receives the body. Original request/ledger keeps the reference.
        const { payloadRef, payloadBytes, payloadFingerprint, ...args } = req.arguments
        payload.args = { ...args, content: value.text }
      }
      const result = await link.send(payload, signal)
      const accepted = dispatcher.acceptResult({ kind: ACTION_RESULT, actionId: String(req.actionId), ...result })
      const outcome = accepted.outcome
      if (outcome !== 'completed') {
        const code = outcome === 'unknown' ? 'timeout' : outcome === 'rejected' ? 'permission_denied' : 'execution_failed'
        throw new ActionFailureError(actionFailure(code,
          outcome === 'unknown' ? 'PC 执行结果不明，不能确认完成；请核验，不可自动重试' : 'PC 执行端未完成动作',
          { executorOutcome: outcome, executorCode: /^[a-z][a-z0-9_]{0,100}$/.test(result.code ?? '') ? result.code : 'executor_no_code' }))
      }
      return { effect: { kind: 'action_completed_remote', detail: 'PC 执行端已确认完成动作' },
        evidence: [{ kind: 'adapter' as const, detail: 'executor_completed' }] }
    } finally { dispatcher.abortTurn(turnRequestId) }
  } }
}
