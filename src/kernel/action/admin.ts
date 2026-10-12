/**
 * Action Admin CLI —— 最小 Inspector（M4.5 §31）。
 *
 * ============================================================================
 *  它可以回答的七个问题（计划书 §59）
 * ============================================================================
 * ```text
 * 做的是什么？       capability.operation
 * 目标是谁？         target.canonicalId / confidence / evidence
 * 为什么允许？       decision.checks（逐条判定留痕）
 * 哪个能力执行？     capability@version（来自登记表）
 * 什么时候执行？     timestamps.requested / started / finished
 * 结果如何？         status / executed / effect
 * 证据在哪里？       evidence + traceId
 * ```
 *
 * ⚠️ 与 `memory/admin.ts` 一样，**解析失败返回 usage 而不是抛栈**：
 *    一个写错的命令应当打印用法，而不是甩一个异常给用户。
 */

import type { ActionStatus } from './action-result.ts'
import { ACTION_STATUSES } from './action-result.ts'
import type { ExecutionRecordView } from './execution-ledger.ts'
import { checkActionAuditInvariants, renderAuditReport } from './audit-invariants.ts'
import type { ActionLedgerEvent } from './execution-ledger.ts'

export type ActionAdminCommand =
  | { kind: 'list'; status?: ActionStatus; capability?: string; limit: number }
  | { kind: 'show'; actionId: string }
  | { kind: 'trace'; traceId: string }
  | { kind: 'audit'; limit: number }
  | { kind: 'usage'; problem?: string }

const ALIASES: Record<string, string> = {
  '--action-list': 'list',
  '--action-show': 'show',
  '--action-trace': 'trace',
  '--action-audit': 'audit',
}

export function parseActionAdminArgs(args: readonly string[]): ActionAdminCommand {
  /*
   * 两种调用习惯都真实存在（与 `memory/admin.ts` 一致）：
   *   `pnpm action:list`            → `--action-list`
   *   `tsx src/main.ts action list` → 位置参数
   * 这里显式吃掉开头的 `action`，让**两种入口共用同一个解析器** ——
   * 否则"用 CLI 直接跑"与"用 pnpm 脚本跑"会走出两种行为。
   */
  const normalized = (args[0] === 'action' ? args.slice(1) : args).filter(
    (a) => a.trim() !== ''
  )

  let sub: string | undefined
  const rest: string[] = []
  for (const arg of normalized) {
    if (sub === undefined && ALIASES[arg] !== undefined) {
      sub = ALIASES[arg]
      continue
    }
    if (sub === undefined && !arg.startsWith('-')) {
      sub = arg
      continue
    }
    rest.push(arg)
  }

  if (sub === undefined) return { kind: 'usage' }

  const flag = (name: string): string | undefined => {
    const index = rest.indexOf(name)
    return index >= 0 ? rest[index + 1] : undefined
  }
  const positional = rest.filter((a, i) => {
    if (a.startsWith('-')) return false
    const prev = rest[i - 1]
    return !(prev !== undefined && prev.startsWith('-'))
  })
  const limitRaw = Number(flag('--limit') ?? '20')
  const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(500, limitRaw) : 20

  switch (sub) {
    case 'list': {
      const status = flag('--status')
      if (status !== undefined && !(ACTION_STATUSES as readonly string[]).includes(status)) {
        /*
         * ⚠️ 未知状态**报错**，绝不静默返回全部。
         *
         * M4.1 的量具事故是"函数名叫 active，实际量的是全部状态"。
         * 如果这里对未知 status 宽容处理，同一个错误会以另一种形状回来：
         * 用户以为过滤生效了，而输出其实没有被过滤。
         */
        return {
          kind: 'usage',
          problem: `--status 只能是 ${ACTION_STATUSES.join(' / ')} 之一，收到 ${status}`,
        }
      }
      return {
        kind: 'list',
        ...(status !== undefined ? { status: status as ActionStatus } : {}),
        ...(flag('--capability') !== undefined ? { capability: flag('--capability') } : {}),
        limit,
      }
    }

    case 'show': {
      const id = positional[0]
      if (id === undefined) return { kind: 'usage', problem: 'action show 需要 <actionId>' }
      return { kind: 'show', actionId: id }
    }

    case 'trace': {
      const id = positional[0]
      if (id === undefined) return { kind: 'usage', problem: 'action trace 需要 <traceId>' }
      return { kind: 'trace', traceId: id }
    }

    case 'audit':
      return { kind: 'audit', limit }

    default:
      return { kind: 'usage', problem: `未知子命令：${sub}` }
  }
}

export function actionAdminUsage(): string {
  return [
    'Action Admin（M4.5 §31）：她做过什么',
    '',
    '  action list  [--status <状态>] [--capability <id>] [--limit N]',
    '      列出动作记录。--status 的过滤发生在 SQL 里（不是读回来再筛）。',
    `      状态取值：${ACTION_STATUSES.join(' / ')}`,
    '',
    '  action show  <actionId>     一次动作的完整判定与结果',
    '  action trace <traceId>      一条 trace 串起来的全部动作',
    '  action audit [--limit N]    审计不变量（§32）',
    '',
    '也可以直接用 flag 形式：--action-list / --action-show / --action-trace / --action-audit',
  ].join('\n')
}

/**
 * 列表渲染。
 *
 * ⚠️ 行格式是**给机器读的**（L0 量具验证要解析它）：
 *    每行必须恰好一个 `act:` id 与一个 `status=` 字段，
 *    因此不允许把状态混进正文描述里。
 */
export function renderActionList(
  records: readonly ExecutionRecordView[],
  title: string
): string {
  const lines = [title, `共 ${records.length} 条`]
  if (records.length === 0) {
    lines.push('（没有匹配的记录）')
    return lines.join('\n')
  }
  for (const record of records) {
    const target =
      record.target === undefined
        ? '-'
        : `${record.target.type}:${record.target.canonicalId ?? record.target.displayName ?? '-'}`
    const when = new Date(record.requestedAt).toLocaleString('zh-CN', { hour12: false })
    lines.push(
      `  · ${String(record.actionId)}  status=${record.status}` +
        `  executed=${record.executed}` +
        `${record.idempotentReplay ? '  replay=true' : ''}` +
        `  capability=${record.capability}` +
        `  op=${record.operation}` +
        `  target=${target}` +
        `  confidence=${record.target?.confidence ?? '-'}` +
        `  at=${when}`
    )
  }
  return lines.join('\n')
}

export function renderActionDetail(record: ExecutionRecordView): string {
  const lines: string[] = []
  lines.push(`动作 ${String(record.actionId)}`)
  lines.push(`  traceId      : ${String(record.traceId)}`)
  lines.push(`  能力         : ${record.capability}.${record.operation}`)
  lines.push(`  状态         : ${record.status}（executed=${record.executed}, accepted=${record.accepted}）`)
  if (record.idempotencyKey !== undefined) {
    lines.push(`  幂等键       : ${record.idempotencyKey}`)
  }
  if (record.idempotentReplay) {
    lines.push('  ⚠️ 幂等重放   : 这次**没有**产生新的副作用')
  }
  if (record.target !== undefined) {
    lines.push(
      `  目标         : ${record.target.type}:` +
        `${record.target.canonicalId ?? record.target.displayName ?? '(未解析)'}` +
        `（确定性 ${record.target.confidence}）`
    )
    for (const evidence of record.target.evidence ?? []) {
      lines.push(`      · ${evidence.kind}：${evidence.detail}`)
    }
  } else {
    lines.push('  目标         : (无)')
  }
  if (record.effect !== undefined) {
    lines.push(`  副作用       : ${record.effect.kind}${record.effect.detail ? ` — ${record.effect.detail}` : ''}`)
  }
  if (record.progress !== undefined) {
    lines.push(`  进度         : ${record.progress.completed}/${record.progress.total}`)
  }
  if (record.failure !== undefined) {
    lines.push(`  失败         : ${record.failure.code} — ${record.failure.message}`)
  }
  lines.push(
    `  时间         : requested=${new Date(record.requestedAt).toISOString()}` +
      `${record.startedAt !== undefined ? ` started=${new Date(record.startedAt).toISOString()}` : ''}` +
      `${record.finishedAt !== undefined ? ` finished=${new Date(record.finishedAt).toISOString()}` : ''}`
  )
  if (record.evidence.length > 0) {
    lines.push('  证据         :')
    for (const evidence of record.evidence) {
      lines.push(`      · ${evidence.kind}：${evidence.detail}${evidence.ref ? ` (${evidence.ref})` : ''}`)
    }
  }
  return lines.join('\n')
}

/** 一条 trace 串起来的动作链（§20 的反查方向之一） */
export function renderActionTrace(events: readonly ActionLedgerEvent[]): string {
  if (events.length === 0) return '（这条 trace 下没有任何动作）'
  const lines = [`trace ${String(events[0]!.traceId)} 下的动作事件 ${events.length} 条`]
  for (const event of events) {
    lines.push(
      `  #${event.sequence} ${event.type}` +
        `${event.status !== undefined ? ` (${event.status})` : ''}` +
        ` ${String(event.actionId)}`
    )
    if (event.type === 'ACTION_REQUESTED') {
      const requestedBy = event.payload.requestedBy as { kind?: string } | undefined
      lines.push(`      请求方：${requestedBy?.kind ?? '(未知)'}`)
      const args = event.payload.arguments
      if (args !== undefined && typeof args === 'object') {
        lines.push(`      参数摘要：${JSON.stringify(args)}`)
      }
    }
    if (event.type === 'ACTION_TARGET_RESOLVED') {
      const target = event.payload.target as { canonicalId?: string; confidence?: string } | undefined
      lines.push(
        `      目标：${target?.canonicalId ?? '(未解析)'}（${target?.confidence ?? '-'}）` +
          `${event.payload.scopeViolation === true ? ' ⚠️ 越界' : ''}`
      )
    }
    if (event.type === 'ACTION_AUTHORIZED' || event.type === 'ACTION_REJECTED') {
      const decision = event.payload.decision as
        | { code?: string; message?: string; checks?: string[] }
        | undefined
      lines.push(`      判定：${decision?.code ?? '-'} — ${decision?.message ?? ''}`)
      if (Array.isArray(decision?.checks)) {
        lines.push(`      逐条：${decision.checks.join(', ')}`)
      }
    }
    const failure = event.payload.failure as { code?: string; message?: string } | undefined
    if (failure !== undefined) {
      lines.push(`      失败：${failure.code} — ${failure.message}`)
    }
    const effect = event.payload.effect as { kind?: string; detail?: string } | undefined
    if (effect !== undefined) {
      lines.push(`      效果：${effect.kind}${effect.detail ? ` — ${effect.detail}` : ''}`)
    }
  }
  return lines.join('\n')
}

export function renderActionAudit(records: readonly ExecutionRecordView[]): string {
  const violations = checkActionAuditInvariants(records)
  const lines = [renderAuditReport(records)]
  if (violations.length === 0 && records.length > 0) {
    const sample = records[0]!
    lines.push(`  抽样：${String(sample.actionId)} → ${renderActionDetail(sample).split('\n')[1] ?? ''}`)
  }
  return lines.join('\n')
}
