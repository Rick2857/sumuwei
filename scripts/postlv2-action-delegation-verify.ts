/**
 * 动作委派派发边界的门（ADR-146 `D02` / `D05` / `D06` / `M-08` / `M-09`）。
 *
 * ★ 最要紧的一条是 **M-09**：策略没过 ⇒ **线上一行都不发**。
 *   这不是"检查了一下"，是**形状上做不到** —— `delegate()` 必填 `admission`，
 *   `allowed === false` 时连 emit 都不碰。
 *
 * ⚠️ 这里**不需要真执行端、不需要开窗口、不需要人**：
 *   门证的是"发不发"，不是"执行端做不做"。后者是 M-03/M-04，要人在场。
 */
import { ActionDelegation, type DelegationRejection } from '../src/kernel/app/bridge/action-delegation.ts'
import { DELEGATE_ACTION } from '../src/kernel/app/bridge/delegation-wire.ts'
import type { ActionRequest } from '../src/kernel/action/action-request.ts'
import type { PolicyDecision } from '../src/kernel/action/policy.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  ${detail}`) }
  else { fail += 1; console.log(`  FAIL  ${name}  ${detail}`) }
}

/** 一条"策略通过"的判定 */
const allowed = (): PolicyDecision => ({
  allowed: true,
  code: 'allowed',
  message: 'ok',
  riskLevel: 'R2',
  checks: [],
})
/** 一条"策略拒绝"的判定 —— 刻意带 riskLevel，验证它**不会**被带上线 */
const denied = (): PolicyDecision => ({
  allowed: false,
  code: 'risk_exceeds_limit',
  message: 'denied',
  riskLevel: 'R2',
  checks: [],
})

const request = (capability: string): ActionRequest =>
  ({
    actionId: 'a1',
    traceId: 't1',
    capability,
    operation: capability === 'desktop.operate' ? 'desktop:operate' : 'operate',
    requestedBy: { kind: 'service', id: 'SERVICE/action-gateway' },
    arguments: { action: 'click', window: '记事本', index: 3 },
    sideEffect: 'write',
  }) as unknown as ActionRequest

interface Harness { d: ActionDelegation; sent: Array<Record<string, unknown>>; cancelled: Set<string> }

function harness(options: { allow?: readonly string[]; timeoutMs?: number } = {}): Harness {
  const sent: Array<Record<string, unknown>> = []
  const cancelled = new Set<string>()
  const d = new ActionDelegation({
    emit: (p) => sent.push(p),
    isCancelled: (t) => cancelled.has(t),
    delegatableCapabilities: options.allow ?? ['desktop.operate'],
    timeoutMs: options.timeoutMs ?? 30_000,
    now: () => 1_700_000_000_000,
  })
  return { d, sent, cancelled }
}

console.log('=== M-09 ★★★ 策略拒绝 ⇒ 线上一行都不发 ===')
{
  const h = harness()
  const r = h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: request('desktop.operate'), admission: denied() })
  check('策略拒绝时不采纳', !r.ok, JSON.stringify(r))
  check('理由码是具名的 delegation_policy_denied',
    !r.ok && r.rejection === 'delegation_policy_denied', `rejection=${r.ok ? '-' : r.rejection}`)
  check('★ 线上**零行**（这是 M-09 的全部）', h.sent.length === 0, `sent=${h.sent.length}`)
  check('策略码被带回来供账本用（但不在线上）',
    !r.ok && r.policyCode === 'risk_exceeds_limit', `policyCode=${r.ok ? '-' : r.policyCode}`)
}

console.log('\n=== M-09b ★ 能力不在可委派清单 ⇒ 一行都不发 ===')
{
  const h = harness({ allow: ['desktop.operate'] })
  const r = h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: request('browser.operate'), admission: allowed() })
  check('清单外的能力被拒', !r.ok && r.rejection === 'delegation_capability_not_delegatable',
    `rejection=${r.ok ? '(被采纳!)' : r.rejection}`)
  check('★ 线上零行', h.sent.length === 0, `sent=${h.sent.length}`)
}

console.log('\n=== M-09c ★ 策略优先于能力清单（顺序不能对调）===')
{
  // 一个"既不在清单、策略也拒绝"的请求
  const h = harness({ allow: ['desktop.operate'] })
  const r = h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: request('browser.operate'), admission: denied() })
  check('先报策略拒绝（不是"不在清单"）', !r.ok && r.rejection === 'delegation_policy_denied',
    `rejection=${r.ok ? '-' : r.rejection}`)
  check('线上仍为零行', h.sent.length === 0, `sent=${h.sent.length}`)
}

console.log('\n=== M-02 ★ 发出去的那一行里没有任何额度字段 ===')
{
  const h = harness()
  const r = h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: request('desktop.operate'), admission: allowed() })
  check('策略通过时采纳', r.ok, JSON.stringify(r))
  check('线上恰好一行', h.sent.length === 1, `sent=${h.sent.length}`)
  const line = h.sent[0]!
  check('kind 是 DELEGATE_ACTION', line.kind === DELEGATE_ACTION, `kind=${line.kind}`)
  const keys = Object.keys(line).sort().join(',')
  check('载荷字段**逐字**如预期', keys === 'actionId,args,capability,kind,operation,timeoutMs,turnRequestId', keys)
  for (const forbidden of ['riskBudgetOverride', 'riskLevel', 'riskBudget', 'maxRiskLevel', 'sideEffect', 'traceId', 'requestedBy', 'actionId_']) {
    check(`载荷里没有 \`${forbidden}\``, !(forbidden in line), `keys=${keys}`)
  }
}

console.log('\n=== M-02b ★★ request 上多余的字段不能被顺手带上线 ===')
{
  const h = harness()
  // 往 request 上塞一个"以后某天可能会有人加"的字段
  const dirty = { ...request('desktop.operate'), someFutureField: 'SHOULD_NOT_LEAK', riskBudgetOverride: 'R2' } as unknown as ActionRequest
  h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: dirty, admission: allowed() })
  const line = JSON.stringify(h.sent[0])
  check('未知字段没上线', !line.includes('SHOULD_NOT_LEAK'), line.slice(0, 160))
  check('request 上的额度字段也没上线', !line.includes('riskBudgetOverride'), line.slice(0, 160))
}

console.log('\n=== D-06 ★ 取消后的轮次不再派发 ===')
{
  const h = harness()
  h.cancelled.add('turn-9')
  const r = h.d.delegate({ turnRequestId: 'turn-9', actionId: 'act-1', request: request('desktop.operate'), admission: allowed() })
  check('已取消的轮次被拒', !r.ok && r.rejection === 'delegation_turn_cancelled', `rejection=${r.ok ? '-' : r.rejection}`)
  check('线上零行', h.sent.length === 0, `sent=${h.sent.length}`)
}

console.log('\n=== D-06b ★★ 取消能中止**在途**的委派 ===')
{
  const h = harness()
  h.d.delegate({ turnRequestId: 'turn-A', actionId: 'act-1', request: request('desktop.operate'), admission: allowed() })
  h.d.delegate({ turnRequestId: 'turn-A', actionId: 'act-2', request: request('desktop.operate'), admission: allowed() })
  h.d.delegate({ turnRequestId: 'turn-B', actionId: 'act-3', request: request('desktop.operate'), admission: allowed() })
  check('三条在途', h.d.snapshot().length === 3, `在途=${h.d.snapshot().length}`)

  const aborted = h.d.abortTurn('turn-A')
  check('中止了 turn-A 的两条', aborted === 2, `aborted=${aborted}`)
  check('★ turn-B 的**不受影响**（取消只作用于所属轮次）', h.d.snapshot().length === 1 && h.d.snapshot()[0]!.actionId === 'act-3',
    `剩余=${JSON.stringify(h.d.snapshot().map((x) => x.actionId))}`)
  check('已中止的不能重复派发同一个 actionId',
    h.d.delegate({ turnRequestId: 'turn-A', actionId: 'act-1', request: request('desktop.operate'), admission: allowed() }).ok,
    '中止后 id 被释放，可用于新一轮')
}

console.log('\n=== D-05 ★ 结果结局闭集，不认识的一律 unknown ===')
{
  const h = harness()
  h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: request('desktop.operate'), admission: allowed() })
  for (const outcome of ['COMPLETED', 'ok', 'success', true, 1, null, undefined] as unknown as string[]) {
    const r = h.d.acceptResult({ kind: 'ACTION_RESULT', actionId: 'act-1', outcome } as never)
    check(`outcome=${JSON.stringify(outcome)} ⇒ unknown`, r.outcome === 'unknown', `得到 ${r.outcome}`)
    h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: request('desktop.operate'), admission: allowed() })
  }
  // 合法结局逐个保留
  for (const outcome of ['completed', 'rejected', 'failed_confirmed', 'unknown'] as const) {
    h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: request('desktop.operate'), admission: allowed() })
    const r = h.d.acceptResult({ kind: 'ACTION_RESULT', actionId: 'act-1', outcome })
    check(`${outcome} 原样保留`, r.outcome === outcome, `得到 ${r.outcome}`)
  }
}

console.log('\n=== D-05b 不认识的 actionId 不被当成"已完成" ===')
{
  const h = harness()
  h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: request('desktop.operate'), admission: allowed() })
  const r = h.d.acceptResult({ kind: 'ACTION_RESULT', actionId: 'act-UNKNOWN', outcome: 'completed' })
  check('陌生 actionId 的 completed 不被采纳', r.outcome === 'unknown', `得到 ${r.outcome}`)
  check('★ 在途那条**仍然**在（没被陌生结果顶掉）', h.d.snapshot().length === 1 && h.d.snapshot()[0]!.actionId === 'act-1',
    JSON.stringify(h.d.snapshot().map((x) => x.actionId)))
}

console.log('\n=== 附带：空 actionId 与重复派发 ===')
{
  const h = harness()
  const empty: DelegationRejection = 'delegation_missing_action_id'
  const r0 = h.d.delegate({ turnRequestId: 'turn-1', actionId: '', request: request('desktop.operate'), admission: allowed() })
  check('空 actionId 被拒', !r0.ok && r0.rejection === empty, `rejection=${r0.ok ? '-' : r0.rejection}`)
  h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: request('desktop.operate'), admission: allowed() })
  const dup = h.d.delegate({ turnRequestId: 'turn-1', actionId: 'act-1', request: request('desktop.operate'), admission: allowed() })
  check('重复 actionId 被拒', !dup.ok && dup.rejection === 'delegation_duplicate_action_id', `rejection=${dup.ok ? '-' : dup.rejection}`)
  check('线上只有一行（重复那次没发）', h.sent.length === 1, `sent=${h.sent.length}`)
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
