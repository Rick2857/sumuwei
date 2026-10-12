/**
 * AuditInvariants —— §32 的四条审计不变量（+ 两条可执行补充）。
 *
 * ============================================================================
 *  为什么它必须是**一份**实现
 * ============================================================================
 * 计划书 §31 要求一个最小 Inspector（`action:list / show / trace / audit`），
 * §32 要求四条不变量。如果 CLI 自己写一份检查、验收门再写一份，
 * 那么"`action:audit` 说没问题"就只说明**其中一份**没问题 ——
 * 而 M4.1 的量具事故正是这么发生的（函数名与实现不是一回事）。
 *
 * 因此：本文件是唯一的检查实现，
 *   · `pnpm action:audit`            → 调它
 *   · `m4.5:verify` / L4 Live Smoke  → 也调它
 *
 * 检查对象是与持久层无关的 `ExecutionRecordView`（普通对象），
 * 因此本文件保持纯净（`src/kernel/**` 不 import 基础设施）。
 */

import type { ExecutionRecordView } from './execution-ledger.ts'

export type AuditInvariant =
  | 'executed_action_has_result'
  | 'result_has_trace_id'
  | 'success_implies_executed'
  | 'side_effect_requires_certain_target'
  | 'failure_carries_code'
  | 'requested_action_reached_terminal_state'
  | 'replay_only_of_success'

export interface AuditViolation {
  invariant: AuditInvariant
  actionId: string
  detail: string
}

/**
 * 这次执行属于"会改变世界的那一类"吗？
 *
 * ⚠️ 判据是**能力声明的 sideEffect**，不是适配器自报的 `effect.kind`：
 *    如果让适配器自己说"我没改世界"，它就获得了绕过
 *    "有副作用必须有确定目标"的能力（fail-closed 的反面）。
 *
 * 幂等重放也算"这一类" —— 世界确实已经是那样了，
 * 因此它同样要求目标在当时是确定的。
 */
export function changedWorld(record: ExecutionRecordView): boolean {
  if (!record.executed && !record.idempotentReplay) return false
  if (record.status !== 'success' && record.status !== 'partial') return false
  return record.sideEffect === 'write' || record.sideEffect === 'destructive'
}

/**
 * 检查一批执行记录。
 *
 * 返回**全部**违规（而不是第一个）：验收报告要能一次看清所有问题。
 */
export function checkActionAuditInvariants(
  records: readonly ExecutionRecordView[]
): AuditViolation[] {
  const violations: AuditViolation[] = []

  for (const record of records) {
    const actionId = String(record.actionId)

    // §32 ①：每个 executed Action 必须有 Result
    if (record.executed && record.finishedAt === undefined) {
      violations.push({
        invariant: 'executed_action_has_result',
        actionId,
        detail: '执行过（STARTED）但没有终态（没有 finishedAt）',
      })
    }

    // §32 ②：每个 Result 必须有 traceId
    if (record.finishedAt !== undefined && String(record.traceId).trim() === '') {
      violations.push({
        invariant: 'result_has_trace_id',
        actionId,
        detail: '有终态结果但没有 traceId —— 追溯链断在这里',
      })
    }

    /*
     * §32 ③ 的前置：success 必须是**真的执行过**的。
     *
     * 唯一的例外是**幂等重放**：那次没有调用适配器（`executed=false`），
     * 但世界确实已经由**之前那次**执行变成了这个状态。
     * 例外必须有名字（`idempotentReplay`），否则它就不是例外而是漏洞。
     */
    if (record.status === 'success' && !record.executed && !record.idempotentReplay) {
      violations.push({
        invariant: 'success_implies_executed',
        actionId,
        detail: 'status=success 但适配器从未被调用，而且这不是幂等重放 —— 假的成功',
      })
    }

    // 幂等重放只允许出现在"成功过"的状态上（与 Gateway 的 replayable 一致）
    if (record.idempotentReplay && record.status !== 'success' && record.status !== 'partial') {
      violations.push({
        invariant: 'replay_only_of_success',
        actionId,
        detail: `幂等重放出现在了 ${record.status} 上 —— 没做成的操作不该被"重放"成做过`,
      })
    }

    // §32 ④：有副作用的执行必须有确定的目标证据（ADR-032）
    if (changedWorld(record)) {
      const confidence = record.target?.confidence
      if (record.target === undefined || (confidence !== 'exact' && confidence !== 'strong')) {
        violations.push({
          invariant: 'side_effect_requires_certain_target',
          actionId,
          detail: `声明了 ${record.sideEffect} 副作用并且真的成功了，但目标确定性是 ${confidence ?? '(无目标)'} —— 违反 No Target Certainty → No Mutation`,
        })
      }
    }

    // 补充：失败必须带归一码（否则"失败率"无法统计，见 errors.ts）
    if (
      (record.status === 'failed' ||
        record.status === 'rejected' ||
        record.status === 'not_found' ||
        record.status === 'ambiguous' ||
        record.status === 'timeout') &&
      record.failure === undefined
    ) {
      violations.push({
        invariant: 'failure_carries_code',
        actionId,
        detail: `status=${record.status} 但没有归一失败码`,
      })
    }

    // 补充：记录必须有终态（没有终态的 action 是悬挂的请求）
    if (record.status === undefined) {
      violations.push({
        invariant: 'requested_action_reached_terminal_state',
        actionId,
        detail: '只有请求、没有终态',
      })
    }
  }

  return violations
}

/**
 * §15 的 OutgoingTurn / 回复层入口：这批记录里**允许**出现成功口吻吗？
 *
 * 与 `claim-guard.ts` 的判据一致（有 success 的 ActionResult 才允许），
 * 但这里是从账本侧回答同一个问题 —— 两条路必须给出同一个答案。
 */
export function ledgerAllowsSuccessClaim(records: readonly ExecutionRecordView[]): boolean {
  return records.some((r) => r.executed && r.status === 'success')
}

/** 人可读的审计报告（CLI 与证据文件共用） */
export function renderAuditReport(records: readonly ExecutionRecordView[]): string {
  const violations = checkActionAuditInvariants(records)
  const physical = records.filter((r) => r.executed && !r.idempotentReplay).length
  const replays = records.filter((r) => r.idempotentReplay).length
  const lines = [
    `动作记录 ${records.length} 条（物理执行 ${physical} 次，幂等重放 ${replays} 次）`,
    `审计不变量：${violations.length === 0 ? '✅ 全部通过' : `❌ ${violations.length} 项违规`}`,
  ]
  for (const v of violations) {
    lines.push(`  ❌ ${v.invariant} @ ${v.actionId}：${v.detail}`)
  }
  return lines.join('\n')
}
