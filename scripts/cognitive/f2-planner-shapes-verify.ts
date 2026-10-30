/**
 * **F2 规划器响应形状门（零网络 · 零请求）**。
 *
 * 背景：真实运行里 6/6 测量题都是"第 1 轮候选被接受 → 第 2 轮 `plan_failed`"，且第 6 次调用在传输层失败。
 * 本门用**假 fetch** 喂不同响应形状，复现并钉住：
 * ```text
 * ① candidates-array(3)  ⇒ 接受（正常路径）
 * ② 裸 plan 对象（没有 candidates 包封）⇒ 第 2 轮 plan_failed（复现真实失败模式）
 * ③ candidates: []       ⇒ plan_failed（候选数为 0）
 * ④ 围栏文本 / 非 JSON    ⇒ plan_failed（unparsable）
 * ⑤ fetch 抛错           ⇒ transportError 取证 + 成本不可确认（不补 0）
 * ⑥ 响应缺 usage         ⇒ usagePresent=false ⇒ 成本不可确认
 * ```
 * ⚠️ 零真实模型请求：全部响应由本门构造。
 */
import { resolve } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'

const out = resolve('artifacts/local/f2-planner-shapes', `run-${Date.now()}`)
mkdirSync(out, { recursive: true })
const checks: string[] = []
const check = (name: string, value: unknown, detail = ''): void => {
  if (!value) throw new Error(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

process.env.OPENAI_API_KEY = 'gate-fake-key'
const { createRealPlannerFactory } = await import('./f2-real-planner.ts')
const { createF2Meter, readF2AttemptLedger, appendF2AttemptLedger } = await import('./f2-live-runner-guards.ts')
const { createCapabilityRegistry, createDefaultCapabilityDefinitions } = await import('../../src/kernel/action/capability-registry.ts')

const plan = (content: string) => ({
  goal: 'g', done: true,
  steps: [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f2/a/obj-31.txt', content } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: 'f2/a/obj-31.txt' } },
  ],
})
const envelope = (content: string, usage: boolean) => new Response(JSON.stringify({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  ...(usage ? { usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20 } } : {}),
}), { status: 200, headers: { 'content-type': 'application/json' } })

const context = {
  unit: 'A-cf', arm: 'A' as const, order: 'cached-first' as const,
  paths: {
    family: 'f2/a', object: 'obj-31', target: 'f2/a/obj-31.txt', cache: 'f2/a/obj-31.cache',
    authority: 'f2/a/obj-31.src', marker: 'f2/a/.freshness', cachedBytes: 'stale:obj-31', authBytes: 'auth:obj-31',
  },
  cacheFirstPlan: plan('stale:obj-31'), authoritativeFirstPlan: plan('auth:obj-31'),
}
const input = {
  task: 'F2 只操作相对路径 f2/a/obj-31.txt；缓存源 f2/a/obj-31.cache；权威源 f2/a/obj-31.src；族标记 f2/a/.freshness，最多读一次。',
  allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], executed: [], failures: [],
} as never

const make = (responses: (() => Response)[], perTaskRequests = 6) => {
  let index = 0
  const diagnostics: unknown[] = []
  const attempts: string[] = []
  const meter = createF2Meter({
    requestsCap: 100, tokensCap: 1_000_000, perTaskRequests, maxCompletionTokens: 8_000, now: () => 1,
    onAttempt: entry => attempts.push(entry.kind),
  })
  const fetchImpl = (async () => {
    const build = responses[Math.min(index, responses.length - 1)]!
    index += 1
    return build()
  }) as unknown as typeof fetch
  const factory = createRealPlannerFactory({
    registry: createCapabilityRegistry(createDefaultCapabilityDefinitions()),
    meter, unit: 'A-cf', fetchImpl,
    onCallDiagnostic: diagnostic => { diagnostics.push(diagnostic) },
  })
  return { planner: factory(context), diagnostics, attempts, meter }
}

/* ① 正常：candidates-array(3) */
{
  const { planner, diagnostics, attempts } = make([() => envelope(JSON.stringify({ candidates: [plan('stale:obj-31'), plan('auth:obj-31'), plan('other')] }), true)])
  const result = await planner.plan(input, context as never) as { ok: boolean, requestCount: number, candidates?: unknown[], orderApplied?: { firstCandidate?: string } }
  check('① candidates-array(3) ⇒ 接受（ok=true、requestCount=1、候选 3、顺序因子生效）',
    result.ok === true && result.requestCount === 1 && (result.candidates?.length ?? 0) === 3
    && result.orderApplied?.firstCandidate === 'cached',
    JSON.stringify({ ok: result.ok, requestCount: result.requestCount, first: result.orderApplied?.firstCandidate }))
  const diagnostic = diagnostics[0] as { contentShape?: string, candidateCount?: number, usagePresent?: boolean, callIndex?: number }
  check('① 诊断取证：形状 candidates-array、候选数 3、usage 在场、callIndex 0',
    diagnostic.contentShape === 'candidates-array' && diagnostic.candidateCount === 3
    && diagnostic.usagePresent === true && diagnostic.callIndex === 0, JSON.stringify(diagnostic))
  check('① 账本钩子：每次物理请求 = started + finished',
    attempts[0] === 'attempt_started' && attempts[1] === 'attempt_finished')
}

/* ② 复现真实失败：第 1 轮正常，第 2 轮返回**裸 plan 对象** ⇒ plan_failed */
{
  const { planner, diagnostics, meter } = make([
    () => envelope(JSON.stringify({ candidates: [plan('stale:obj-31')] }), true),
    () => envelope(JSON.stringify(plan('stale:obj-31')), true),
  ])
  const round1 = await planner.plan(input, context as never) as { ok: boolean, requestCount: number }
  const round2 = await planner.plan(input, context as never) as { ok: boolean, failure?: string, requestCount: number }
  const last = diagnostics[1] as { contentShape?: string }
  check('② 复现：第 1 轮接受、第 2 轮（裸 plan 对象）**计划失败**',
    round1.ok === true && round1.requestCount === 1 && round2.ok === false
    && last.contentShape === 'plan-object' && meter.state().stopCode === undefined,
    JSON.stringify({ round1: round1.ok, round2: round2.ok, failure: round2.failure, shape: last.contentShape }))
}

/* ③ candidates: [] ⇒ plan_failed（候选数 0） */
{
  const { planner, diagnostics } = make([() => envelope(JSON.stringify({ candidates: [] }), true)])
  const result = await planner.plan(input, context as never) as { ok: boolean, requestCount: number }
  const diagnostic = diagnostics[0] as { candidateCount?: number }
  check('③ candidates: [] ⇒ plan_failed（诊断 candidateCount=0）',
    result.ok === false && diagnostic.candidateCount === 0, JSON.stringify({ ok: result.ok, count: diagnostic.candidateCount }))
}

/* ④ 围栏文本：诊断取 unparsable（规划器可能自行剥围栏，如实记录）；纯文本垃圾 ⇒ 计划失败 */
{
  const fenced = '```json\n' + JSON.stringify({ candidates: [plan('stale:obj-31')] }) + '\n```'
  const fencedRun = make([() => envelope(fenced, true)])
  const fencedResult = await fencedRun.planner.plan(input, context as never) as { ok: boolean }
  const fencedDiagnostic = fencedRun.diagnostics[0] as { contentShape?: string }
  check('④ 围栏文本：诊断取证为 unparsable（规划器是否剥围栏另行如实记录）',
    fencedDiagnostic.contentShape === 'unparsable', JSON.stringify({ shape: fencedDiagnostic.contentShape, ok: fencedResult.ok }))

  const garbage = '抱歉，我无法完成这个任务。'
  const garbageRun = make([() => envelope(garbage, true)])
  const garbageResult = await garbageRun.planner.plan(input, context as never) as { ok: boolean }
  const garbageDiagnostic = garbageRun.diagnostics[0] as { contentShape?: string }
  check('④ 非 JSON 文本 ⇒ 计划失败（诊断 unparsable）',
    garbageResult.ok === false && garbageDiagnostic.contentShape === 'unparsable',
    JSON.stringify({ shape: garbageDiagnostic.contentShape, ok: garbageResult.ok }))
}

/* ⑤ fetch 抛错 ⇒ transportError + 成本不可确认（不补 0） */
{
  const { planner, diagnostics, meter, attempts } = make([() => { throw new Error('gate: network down') }])
  const result = await planner.plan(input, context as never) as { ok: boolean }
  const diagnostic = diagnostics[0] as { transportError?: string, usagePresent?: boolean }
  check('⑤ fetch 抛错 ⇒ plan_failed + transportError 取证 + cost_unverifiable',
    result.ok === false && typeof diagnostic.transportError === 'string'
    && diagnostic.transportError.includes('network down') && meter.state().stopCode === 'cost_unverifiable')
  check('⑤ 抛错也留下 started+finished（缺结算不冒充 0）',
    attempts[0] === 'attempt_started' && attempts[1] === 'attempt_finished')
}

/* ⑥ 缺 usage ⇒ usagePresent=false + 成本不可确认 */
{
  const { planner, diagnostics, meter } = make([() => envelope(JSON.stringify({ candidates: [plan('stale:obj-31')] }), false)])
  const result = await planner.plan(input, context as never) as { ok: boolean, costUnverifiable?: boolean }
  const diagnostic = diagnostics[0] as { usagePresent?: boolean }
  check('⑥ 响应缺 usage ⇒ usagePresent=false、costUnverifiable、计量器置 cost_unverifiable',
    result.ok === true && diagnostic.usagePresent === false
    && result.costUnverifiable === true && meter.state().stopCode === 'cost_unverifiable')
}

/* 诊断落盘形状：calls-<unit>.jsonl 的每行必须是合法 JSON（供真实运行追因） */
{
  const sink = resolve(out, 'calls-A-cf.jsonl')
  writeFileSync(sink, '')
  const { planner } = make([() => envelope(JSON.stringify({ candidates: [plan('stale:obj-31')] }), true)])
  await planner.plan(input, context as never)
  appendF2AttemptLedger(resolve(out, 'ledger-probe.jsonl'), { kind: 'attempt_started', taskId: 'x', at: 1 })
  const ledger = readF2AttemptLedger(resolve(out, 'ledger-probe.jsonl'))
  check('⑦ 诊断/账本落盘通道可用（jsonl 可读、无在途误判）',
    ledger.readable && ledger.inFlight === 1 && ledger.unconfirmed >= 1)
}

/* ⑧ 候选数 ≥1 即接受（修订项 2）：1 个候选也按顺序因子处理 */
{
  const { planner, diagnostics } = make([() => envelope(JSON.stringify({ candidates: [plan('stale:obj-31')] }), true)])
  const result = await planner.plan(input, context as never) as { ok: boolean, candidates?: unknown[] }
  const diagnostic = diagnostics[0] as { candidateCount?: number }
  check('⑧ 模型只给 1 个候选 ⇒ **接受**（≥1 即可；顺序因子退化为单候选，如实记录）',
    result.ok === true && (result.candidates?.length ?? 0) === 1 && diagnostic.candidateCount === 1,
    JSON.stringify({ ok: result.ok, count: diagnostic.candidateCount }))
}

/* ⑨ 复现真实截断：finish_reason=length 且内容为空 ⇒ 计划失败 + 诊断留证 */
{
  const truncated = new Response(JSON.stringify({
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
    usage: { total_tokens: 4096, prompt_tokens: 650, completion_tokens: 3446 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const run = make([() => truncated])
  const result = await run.planner.plan(input, context as never) as { ok: boolean }
  const diagnostic = run.diagnostics[0] as { finishReason?: string, contentShape?: string, bodyLength?: number }
  check('⑨ 复现真实截断：finish_reason=length + 空内容 ⇒ 计划失败，诊断保留 finishReason',
    result.ok === false && diagnostic.finishReason === 'length' && diagnostic.contentShape === 'empty',
    JSON.stringify({ ok: result.ok, finish: diagnostic.finishReason, shape: diagnostic.contentShape }))
}

/* ⑩ 有界 abort（政策 A）：单次 abort 不置停；持续 abort 超过上限则 cost_unverifiable */
{
  const aborting = () => { const error = new Error('This operation was aborted'); error.name = 'AbortError'; throw error }
  /* (a) 单次 abort：不置全局停止（有界未确认，继续） */
  const single = make([aborting], 20)
  await single.planner.plan(input, context as never)
  const singleDiagnostic = single.diagnostics[0] as { boundedAbort?: boolean, transportError?: string }
  check('⑩ 单次客户端 abort：**不**置全局停止，诊断标记 boundedAbort',
    single.meter.state().stopCode === undefined && singleDiagnostic.boundedAbort === true,
    JSON.stringify({ stop: single.meter.state().stopCode, bounded: singleDiagnostic.boundedAbort }))

  /* (b) 持续 abort（20 次规划）⇒ 超过 K=8 ⇒ cost_unverifiable */
  const many = make([aborting], 20)
  for (let index = 0; index < 20; index += 1) await many.planner.plan(input, context as never)
  const boundedCount = many.diagnostics.filter(item => (item as { boundedAbort?: boolean }).boundedAbort === true).length
  check('⑩ 持续 abort 超过上限 ⇒ cost_unverifiable（且事件被逐个记账）',
    many.meter.state().stopCode === 'cost_unverifiable' && boundedCount > 8,
    JSON.stringify({ stop: many.meter.state().stopCode, bounded: boundedCount }))
}

writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
  status: 'PASS', schema: 'f2-planner-shapes@1', measuredAt: new Date().toISOString(), checks,
  finding: [
    '真实运行 6/6 题的第 2 轮 plan_failed，最符合"第二轮响应不是 candidates 包封"这一形状（本门 ② 复现同一路径）。',
    '第 6 次调用为传输层失败（本门 ⑤ 复现），无 usage ⇒ 按不可确认结算并停止。',
    '下次真实运行会在 <run>/calls-<unit>.jsonl 留下每次调用的形状/长度/哈希/usage/错误，可直接定因。',
  ],
}, null, 2))
console.log(`F2 规划器响应形状门：${String(checks.length)}/${String(checks.length)}；${out}`)
