/**
 * ★ 往返门：真实派发器 emit 出来的 → 真实解析器解析 → 必须**逐字一致**
 *
 * ============================================================================
 *  为什么单独一道门
 * ============================================================================
 *
 * 2026-10-17 真踩到过一次：`desktop-executor-adapter` 里我**凭想象**定了
 * windows-mcp worker 的输出形状（`activeWindow: string` / `windows[].elements[]` /
 * `actionable`），真机只读探针一跑，三条**全错**。
 *
 * ⚠️ 而我当时所有的门**一片绿** —— 因为它们喂的是**我自己注入的假件**，
 *    形状自洽当然绿。
 *
 * ⇒ 这一类盲区叫"**两端都错**"：生产者与消费者一起按同一个错误假设写，
 *    自测互相印证，永远发现不了。
 *
 * ⚠️ 所以这道门的形状**不是**"我构造一个对象再解析它" —— 那样它会和
 *    `delegation-wire:verify` 一样自证。
 *    这里**发射端是真正的 `ActionDelegation`**（生产代码路径），
 *    接收端是真正的 `parseDelegateAction`。
 *    两端分属**不同的判定链**，一致性才有意义。
 */
import { ActionDelegation } from '../src/kernel/app/bridge/action-delegation.ts'
import { parseDelegateAction, DELEGATE_ACTION } from '../src/kernel/app/bridge/delegation-wire.ts'
import type { ActionRequest } from '../src/kernel/action/action-request.ts'
import type { PolicyDecision } from '../src/kernel/action/policy.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  ${detail}`) }
  else { fail += 1; console.log(`  FAIL  ${name}  ${detail}`) }
}

const allowed = (): PolicyDecision => ({
  allowed: true, code: 'allowed', message: 'ok', riskLevel: 'R2', checks: [],
})

/** 一个**贴着真实字段名**的请求：注意是 `arguments` 不是 `args` */
const realRequest = (): ActionRequest => ({
  actionId: 'a-real-1',
  traceId: 't-real-1',
  capability: 'desktop.operate',
  operation: 'desktop:operate',
  requestedBy: { kind: 'service', id: 'SERVICE/action-gateway' },
  arguments: { action: 'type', window: '记事本', index: 3, name: '编辑', content: '晚上八点开会' },
  sideEffect: 'write',
} as unknown as ActionRequest)

/** 真派发器 → 真线上行（一行 NDJSON） */
function emitThroughRealDispatcher(): { line: string; payload: Record<string, unknown> } {
  const wire: Record<string, unknown>[] = []
  const d = new ActionDelegation({
    emit: (p) => wire.push(p),
    isCancelled: () => false,
    delegatableCapabilities: ['desktop.operate'],
    timeoutMs: 30_000,
  })
  const r = d.delegate({ turnRequestId: 'turn-real-1', actionId: 'act-real-1', request: realRequest(), admission: allowed() })
  if (!r.ok) throw new Error(`派发本该成功，却得到 ${JSON.stringify(r)}`)
  return { line: JSON.stringify(wire[0]), payload: wire[0]! }
}

console.log('=== RT-1 真派发器 → 真解析器 → 逐字一致 ===')
{
  const { line, payload } = emitThroughRealDispatcher()
  const parsed = parseDelegateAction(JSON.parse(line))
  check('解析成功', parsed.ok, parsed.ok ? '' : parsed.rejection)
  if (!parsed.ok) { console.log(`\n合计：${pass} 通过 / ${fail} 失败`); process.exit(1) }
  const v = parsed.value
  check('kind 保持', v.kind === DELEGATE_ACTION, `kind=${v.kind}`)
  check('turnRequestId 逐字', v.turnRequestId === 'turn-real-1', v.turnRequestId)
  check('actionId 逐字', v.actionId === 'act-real-1', v.actionId)
  check('capability 逐字', v.capability === 'desktop.operate', v.capability)
  check('operation 逐字', v.operation === 'desktop:operate', v.operation)
  check('timeoutMs 逐字', v.timeoutMs === 30_000, String(v.timeoutMs))
  check('args 逐字（CJK 正文不丢）',
    JSON.stringify(v.args) === JSON.stringify({ action: 'type', window: '记事本', index: 3, name: '编辑', content: '晚上八点开会' }),
    JSON.stringify(v.args))
}

console.log('\n=== RT-2 ★ 往返后**没有任何字段被静默丢弃或改名** ===')
{
  const { payload } = emitThroughRealDispatcher()
  const parsed = parseDelegateAction(payload)
  const before = Object.keys(payload).sort()
  const after = parsed.ok ? Object.keys(parsed.value).sort() : []
  check('顶层字段集合相同', before.join(',') === after.join(','), `emit=${before.join(',')}  parse=${after.join(',')}`)
  const beforeArgs = Object.keys((payload['args'] ?? {}) as object).sort()
  const afterArgs = parsed.ok ? Object.keys(parsed.value.args).sort() : []
  check('args 字段集合相同', beforeArgs.join(',') === afterArgs.join(','), `${beforeArgs.join(',')} → ${afterArgs.join(',')}`)
}

console.log('\n=== RT-3 ★ 往返后仍然**没有额度字段**（D02 在两端都成立）===')
{
  const { line } = emitThroughRealDispatcher()
  for (const forbidden of ['riskBudgetOverride', 'riskLevel', 'riskBudget', 'maxRiskLevel', 'sideEffect', 'traceId', 'requestedBy']) {
    check(`线上无 \`${forbidden}\``, !line.includes(forbidden), '往返后仍无')
  }
  // 往返之后再塞一个额度字段 ⇒ 解析器必须**整条拒**
  const tampered = { ...JSON.parse(line), riskBudgetOverride: 'R2' }
  const r = parseDelegateAction(tampered)
  check('★ 篡改加额度字段 ⇒ 整条被拒', !r.ok && !r.ok && r.rejection === 'delegate_forbidden_field_on_wire',
    `rejection=${r.ok ? '(被采纳!)' : r.rejection}`)
}

console.log('\n=== RT-4 ★ 往返是**幂等**的（再往返一次，内容不变）===')
{
  const { payload } = emitThroughRealDispatcher()
  const once = parseDelegateAction(payload)
  if (once.ok) {
    // 把解析结果原样再喂回去（模拟"线上被原样转发一次"）
    const twice = parseDelegateAction({ ...once.value })
    check('二次解析结果与一次相同',
      twice.ok && JSON.stringify(twice.value) === JSON.stringify(once.value),
      twice.ok ? '一致' : `rejection=${twice.rejection}`)
  }
}

console.log('\n=== RT-5 策略拒绝时，往返**根本不发生**（线上零行）===')
{
  const wire: Record<string, unknown>[] = []
  const d = new ActionDelegation({
    emit: (p) => wire.push(p),
    isCancelled: () => false,
    delegatableCapabilities: ['desktop.operate'],
    timeoutMs: 30_000,
  })
  const denied: PolicyDecision = { allowed: false, code: 'risk_exceeds_limit', message: 'denied', riskLevel: 'R2', checks: [] }
  d.delegate({ turnRequestId: 'turn-x', actionId: 'act-x', request: realRequest(), admission: denied })
  check('★ 线上一行都没有 ⇒ 没有任何东西可往返', wire.length === 0, `emitted=${wire.length}`)
  // 于是"解析器会不会误接受一个不存在的行"这件事**不成立** —— 无行即无解析
  check('无行 ⇒ 解析器无从接受', wire.length === 0, '（这一条是 RT-5 的全部）')
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
console.log('⚠️ 这道门堵的是"两端都错"这一类盲区；它**不能**替代对着真生产者跑的探针。')
process.exit(fail === 0 ? 0 : 1)
