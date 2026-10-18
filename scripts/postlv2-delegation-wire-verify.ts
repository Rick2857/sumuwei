/**
 * ADR-146 · 远程执行线上形状的门。
 *
 * 重点证**三件容易做错的事**：
 *   ① 额度类字段**一旦出现在线上就整条拒收**（不是"忽略它"）
 *   ② 未知 outcome 落 `unknown`，**绝不是 `completed`**
 *   ③ 理由码与读数里**不出现正文**
 */
import {
  ACTION_OUTCOMES,
  ACTION_RESULT,
  DELEGATE_ACTION,
  parseActionResult,
  parseDelegateAction,
  REMOTE_EXECUTION_PROTOCOL,
} from '../src/kernel/app/bridge/delegation-wire.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  ${detail}`) }
  else { fail += 1; console.log(`  FAIL  ${name}  ${detail}`) }
}

const goodDelegate = {
  kind: DELEGATE_ACTION,
  turnRequestId: 'turn-1',
  actionId: 'act-1',
  capability: 'desktop.operate',
  operation: 'desktop:operate',
  args: { action: 'click', window: '记事本', index: 3 },
  timeoutMs: 30_000,
}

console.log('=== M-01a 正控：形状合法的委派被采纳 ===')
{
  const r = parseDelegateAction(goodDelegate)
  check('合法委派被采纳', r.ok, JSON.stringify(r.ok ? r.value.actionId : r.rejection))
  check('字段逐字保留', r.ok && r.value.capability === 'desktop.operate' && r.value.timeoutMs === 30_000, JSON.stringify(r.ok ? r.value : r))
}

console.log('\n=== M-01b 负控：缺字段/坏形状逐条被拒 ===')
{
  const cases: Array<[string, unknown]> = [
    ['缺 turnRequestId', { ...goodDelegate, turnRequestId: '' }],
    ['缺 actionId', { ...goodDelegate, actionId: undefined }],
    ['缺 capability', { ...goodDelegate, capability: '' }],
    ['缺 operation', { ...goodDelegate, operation: 123 }],
    ['args 不是对象', { ...goodDelegate, args: [1, 2] }],
    ['args 为 null', { ...goodDelegate, args: null }],
    ['timeout 非整数', { ...goodDelegate, timeoutMs: 1.5 }],
    ['timeout 为 0', { ...goodDelegate, timeoutMs: 0 }],
    ['timeout 为负', { ...goodDelegate, timeoutMs: -1 }],
    ['timeout 过大', { ...goodDelegate, timeoutMs: 999_999_999 }],
    ['不是对象', 'LG_ENTRY abc'],
    ['是 null', null],
  ]
  for (const [name, input] of cases) {
    const r = parseDelegateAction(input)
    check(name, !r.ok, `rejection=${r.ok ? '(被采纳!)' : r.rejection}`)
  }
}

console.log('\n=== M-02 ★★★ 额度类字段出现在线上 ⇒ 整条拒收 ===')
{
  const forbidden = [
    'riskBudgetOverride', 'riskBudget', 'maxRiskLevel', 'risk',
    'riskLevel', 'grantedPermissions', 'permissions', 'allow', 'approved',
  ]
  for (const key of forbidden) {
    const r = parseDelegateAction({ ...goodDelegate, [key]: 'R2' })
    check(`顶层多出 \`${key}\` ⇒ 拒收`, !r.ok && !r.ok && r.rejection === 'delegate_forbidden_field_on_wire',
      `rejection=${r.ok ? '(被采纳!)' : r.rejection}`)
  }
}

console.log('\n=== M-02b 额度塞进 args 里也必须被发现吗？（**如实记边界**）===')
{
  // ⚠️ args 是**动作自己的参数空间**，由核心的网关在采纳前校验（task-plan.ts 的
  //    `TASK_STAGED_ARG_KEYS` / 参数名白名单）。这里**刻意不**再扫一遍 args：
  //    重复实现白名单会与网关那份**漂移**，而两份白名单不一致时没人知道听谁的。
  //    ⇒ 边界如实登记：顶层挡死，args 交给核心侧的白名单。
  const r = parseDelegateAction({ ...goodDelegate, args: { action: 'click', riskBudgetOverride: 'R2' } })
  check('args 里的怪字段**不在本层**拦截（如实登记为边界）', r.ok,
    '核心侧白名单负责；本层重复实现会与网关那份漂移')
  console.log('        ⇒ L-146-02 已登记：args 的白名单只有一份，在网关侧')
}

console.log('\n=== M-05 ★★★ 未知 outcome ⇒ unknown，绝不是 completed ===')
{
  const bogus = ['COMPLETED', 'ok', 'success', 'done', '', 0, 1, true, null, undefined, {}, []]
  for (const outcome of bogus) {
    const r = parseActionResult({ kind: ACTION_RESULT, actionId: 'act-1', outcome })
    const got = r.ok ? r.value.outcome : '(拒收)'
    check(`outcome=${JSON.stringify(outcome)} ⇒ unknown`, r.ok && got === 'unknown', `得到 ${got}`)
  }
}

console.log('\n=== M-05b 四个合法 outcome 逐个被原样保留 ===')
{
  for (const outcome of ACTION_OUTCOMES) {
    const r = parseActionResult({ kind: ACTION_RESULT, actionId: 'act-1', outcome })
    check(`${outcome} 原样保留`, r.ok && r.value.outcome === outcome, `得到 ${r.ok ? r.value.outcome : r.rejection}`)
  }
}

console.log('\n=== M-06 结果缺失 / kind 不对 ⇒ 拒收 ===')
{
  const cases: Array<[string, unknown]> = [
    ['不是对象', 42],
    ['kind 错', { kind: 'TURN_RESULT', actionId: 'a', outcome: 'completed' }],
    ['缺 actionId', { kind: ACTION_RESULT, outcome: 'completed' }],
    ['actionId 为空', { kind: ACTION_RESULT, actionId: '', outcome: 'completed' }],
  ]
  for (const [name, input] of cases) {
    const r = parseActionResult(input)
    check(name, !r.ok, `rejection=${r.ok ? '(被采纳!)' : r.rejection}`)
  }
}

console.log('\n=== M-06b ★ 缺 outcome 字段 ⇒ unknown，不是 completed ===')
{
  const r = parseActionResult({ kind: ACTION_RESULT, actionId: 'act-1' })
  check('**整个 outcome 字段都没有**时仍是 unknown', r.ok && r.value.outcome === 'unknown', `得到 ${r.ok ? r.value.outcome : r.rejection}`)
}

console.log('\n=== M-07 协议版本是主号 ===')
{
  check('REMOTE_EXECUTION_PROTOCOL = 1', REMOTE_EXECUTION_PROTOCOL === 1, `实际=${REMOTE_EXECUTION_PROTOCOL}`)
}

console.log('\n=== M-10 理由码里不含正文 ===')
{
  const r = parseDelegateAction({ ...goodDelegate, turnRequestId: '', args: { content: '这是用户的私密内容' } })
  const text = r.ok ? '' : JSON.stringify(r.rejection)
  check('拒收理由里查不到正文', !text.includes('私密内容'), `rejection=${text}`)
  const r2 = parseActionResult({ kind: ACTION_RESULT, actionId: '', content: '这是用户的私密内容' })
  const text2 = r2.ok ? '' : JSON.stringify(r2.rejection)
  check('结果拒收理由里也查不到正文', !text2.includes('私密内容'), `rejection=${text2}`)
}

console.log('\n=== 附带：正文能在线上，但只能是 contentRef ===')
{
  const r = parseActionResult({ kind: ACTION_RESULT, actionId: 'act-1', outcome: 'completed', contentRef: 'tc:123', content: '不该出现的正文' })
  check('只把 contentRef 收进结果', r.ok && r.value.contentRef === 'tc:123' && !('content' in r.value),
    `keys=${r.ok ? Object.keys(r.value).join(',') : r.rejection}`)
}

console.log('\n=== M-01 ★ 闭集登记：进的是登记表，不是"到处都能用" ===')
{
  const { BRIDGE_MESSAGE_KINDS } = await import('../src/kernel/app/bridge/turn-bridge.ts')
  check('ACTION_RESULT 在入站闭集里', BRIDGE_MESSAGE_KINDS.includes('ACTION_RESULT' as never),
    `闭集 = ${BRIDGE_MESSAGE_KINDS.join(',')}`)
  check('DELEGATE_ACTION **不**在入站闭集里（它是核心→执行端，属出站）',
    !BRIDGE_MESSAGE_KINDS.includes('DELEGATE_ACTION' as never),
    '入站闭集只收"外壳发给核心"的那些')
  check('闭集里没有多出第三个新 kind',
    BRIDGE_MESSAGE_KINDS.filter((k) => String(k).includes('ACTION') || String(k).includes('DELEGATE')).length === 1,
    `匹配 = ${BRIDGE_MESSAGE_KINDS.filter((k) => String(k).includes('ACTION') || String(k).includes('DELEGATE')).join(',')}`)
}

console.log('\n=== M-01b ★★ 登记了但**没接线** ⇒ 必须失败关闭，不是静默丢弃 ===')
{
  const { handleBridgeMessage } = await import('../src/kernel/app/bridge/turn-bridge.ts')
  // 造一个**没有任何 host 能力**的桥：`actionResult` 不装
  const bare = { runTurn: async () => { throw new Error('不应被调用') } } as never
  const reply = await handleBridgeMessage(bare, { kind: 'ACTION_RESULT', actionId: 'act-1', outcome: 'completed' })
  check('回的是 ACTION_RESULT（**不是** TURN_RESULT）', reply.kind === 'ACTION_RESULT', `kind=${reply.kind}`)
  check('outcome 是 unknown（**不是** completed）', reply.outcome === 'unknown', `outcome=${reply.outcome}`)
  check('理由码具名 action_executor_absent', reply.code === 'action_executor_absent', `code=${reply.code}`)
  check('requestId 为空（它带的是 actionId，不是轮次 id）', reply.requestId === '', `requestId=${JSON.stringify(reply.requestId)}`)
}

console.log('\n=== M-01c 形状不合法的结果 ⇒ 仍然 unknown，**不**回 rejected ===')
{
  const { handleBridgeMessage } = await import('../src/kernel/app/bridge/turn-bridge.ts')
  const bare = { runTurn: async () => { throw new Error('不应被调用') } } as never
  const reply = await handleBridgeMessage(bare, { kind: 'ACTION_RESULT' })
  check('缺 actionId 与 outcome 时仍是 unknown', reply.outcome === 'unknown', `outcome=${reply.outcome}`)
  check('理由码具名（非空）', typeof reply.code === 'string' && reply.code !== '', `code=${reply.code}`)
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
