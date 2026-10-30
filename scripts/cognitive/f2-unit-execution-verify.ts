/**
 * **F2 单元执行门（接线版）**：用**真实规划器工厂 + 假 fetch**（零网络）验证接线，而不是用夹具规划器绕过它。
 *
 * ```text
 * full   ：C-cf 正式序列 → 形成 4 + 测量 6 全达成；物理请求 == 规划器调用 == 计量次数（**只计一次**）
 * cost   ：假 fetch **不返回 usage** ⇒ 成本不可确认 ⇒ 第一题之后停止后续请求
 * cap    ：逐题上限=1 + 假 fetch 每次给错内容（必失败）⇒ 需要第二次请求的题被 task_request_cap 拒绝，
 *          但**整条序列继续**（逐题上限不是全局停止）
 * resume ：任务账本里已完成 1 题 ⇒ 原样取回、**不重跑**（物理请求 6→5）
 * order  ：候选顺序因子落地（缓存优先 / 权威优先 ⇒ 第一候选来源桶不同），纯函数 + 规划器返回的 orderApplied
 * ```
 * ⚠️ 全程零网络：`fetchImpl` 是假 fetch；`F2_GATE_FAKE_FETCH` 只在 CLI 子进程门里用，本门直接注入。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'

const SCRIPT = 'scripts/cognitive/f2-unit-execution-verify.ts'
const TASK_SPEC = 'docs/architecture/f2-preregistration-20261025/task-spec.json'
const SCENARIO = process.env.LG_F2_UNIT_SCENARIO

/** 假 fetch：从请求消息里认出对象，返回候选计划（零网络）。 */
function fakeFetchOf (mode: 'auth' | 'wrong' | 'no-usage' | 'claim-mix' | 'claim-only'): typeof fetch {
  /* 每个对象第几次调用：用于 claim-mix（第 1 次给写入+读回计划，第 2 次给完成声明）。 */
  const callsByObject = new Map<string, number>()
  return (async (_input: unknown, init?: unknown) => {
    const body = JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? '{}')) as { messages?: { content?: unknown }[] }
    const text = (body.messages ?? []).map(item => String(item.content ?? '')).join(' ')
    const object = /(obj-[a-z]?\d+)/.exec(text)?.[1] ?? 'obj-31'
    const family = /(f\d+\/a)/.exec(text)?.[1] ?? 'f2/a'
    const target = `${family}/${object}.txt`
    const plan = (content: string, done = true) => ({
      goal: 'gate', done, steps: [
        { capability: 'sandbox.file.write', operation: 'write', args: { path: target, content } },
        { capability: 'sandbox.file.read', operation: 'read', args: { path: target } },
      ],
    })
    const callIndex = (callsByObject.get(object) ?? 0) + 1
    callsByObject.set(object, callIndex)
    const claim = { goal: 'gate', done: true, steps: [] as unknown[] }
    const candidates = mode === 'claim-only'
      ? [claim]
      : mode === 'claim-mix'
        /* 第 1 轮：写入+读回但**不宣告完成**（done:false）⇒ 任务环必然再规划一次；第 2 轮才给完成声明。 */
        ? (callIndex === 1 ? [plan('auth:' + object, false)] : [claim])
        : mode === 'wrong' ? [plan('wrong:' + object)] : [plan('auth:' + object)]
    const payload = {
      choices: [{ message: { content: JSON.stringify({ candidates }) } }],
      ...(mode === 'no-usage' ? {} : { usage: { total_tokens: 120, prompt_tokens: 100, completion_tokens: 20 } }),
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response
  }) as unknown as typeof fetch
}

// ===========================================================================
//  子进程：跑一个场景
// ===========================================================================
if (SCENARIO !== undefined) {
  const { isolateDatabase } = await import('../../src/dev/sandbox.ts')
  isolateDatabase(`f2-unit-gate-${SCENARIO}`, { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
  const out = String(process.env.LG_F2_UNIT_OUT)
  const spec = JSON.parse(readFileSync(TASK_SPEC, 'utf8')) as {
    formalSequence: { id: string, family: string, formation: unknown[], measurement: unknown[] }
  }
  const sequence = spec.formalSequence
  const { createF2Meter } = await import('./f2-live-runner-guards.ts')
  const { createCapabilityRegistry, createDefaultCapabilityDefinitions } = await import('../../src/kernel/action/capability-registry.ts')
  const { createRealPlannerFactory } = await import('./f2-real-planner.ts')
  const { runF2Unit } = await import('./f2-unit-runtime.ts')
  const meter = createF2Meter({
    requestsCap: 216, tokensCap: 302_400,
    perTaskRequests: SCENARIO === 'cap' ? 1 : 6, maxCompletionTokens: 1_200, now: () => Date.now(),
  })
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const fetchImpl = fakeFetchOf(
    SCENARIO === 'cost' ? 'no-usage'
      : SCENARIO === 'cap' ? 'wrong'
        : SCENARIO === 'claim-mix' ? 'claim-mix'
          : SCENARIO === 'claim-only' ? 'claim-only' : 'auth')
  const unit = SCENARIO === 'full' ? 'C-cf' : SCENARIO === 'b-arm' ? 'B-cf' : 'A-cf'
  const arm = SCENARIO === 'full' ? 'C' : SCENARIO === 'b-arm' ? 'B' : 'A'
  const plannerFactory = createRealPlannerFactory({ registry, meter, unit, fetchImpl })
  const resume = SCENARIO === 'resume'
    ? {
        'A-cf:obj-31': {
          phase: 'measurement', role: 'measurement', object: 'obj-31', condition: 'fresh',
          achieved: true, stopped: 'none', actions: 3, plans: 1, failedWrites: 0,
          candidateCalls: 1, physicalRequests: 1, fileTruth: true, vetoed: false,
          attributions: [], recovered: true,
        },
      }
    : undefined
  const report = await runF2Unit({
    unit, arm, order: 'cached-first',
    sequence: { family: sequence.family, formation: sequence.formation, measurement: sequence.measurement },
    sequenceId: sequence.id,
    dbUrl: String(process.env.LG_TEST_PG_URL ?? ''), root: resolve(out, `files-${SCENARIO}`),
    out, evidenceKind: 'gate_fake_fetch', plannerFactory, meter,
    ...(resume === undefined ? {} : { resume: resume as never }),
  })
  writeFileSync(resolve(out, `scenario-${SCENARIO}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8')
  process.exit(0)
}

// ===========================================================================
//  父进程：编排场景 + 纯函数顺序检查 + 断言
// ===========================================================================
const out = resolve('artifacts/local/f2-unit-execution', `run-${Date.now()}`)
mkdirSync(out, { recursive: true })
const checks: string[] = []
const check = (name: string, value: unknown, detail = ''): void => {
  if (!value) throw new Error(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
const adminUrl = (process.env.LG_F2_ADMIN_URL ?? process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
const spawnScenario = async (scenario: string): Promise<void> => {
  process.env.LG_F2_UNIT_SCENARIO = scenario
  process.env.LG_F2_UNIT_OUT = out
  if (adminUrl !== '') await runPreparedPgGateInInstance(adminUrl, `f2-unit-wire-${scenario}`, SCRIPT)
  else await runPreparedPgGate(`f2-unit-wire-${scenario}`, SCRIPT)
}
try {
  for (const scenario of ['full', 'cost', 'resume', 'b-arm', 'claim-mix', 'claim-only']) await spawnScenario(scenario)
  delete process.env.LG_F2_UNIT_SCENARIO
  delete process.env.LG_F2_UNIT_OUT

  const reportOf = (scenario: string) => JSON.parse(readFileSync(resolve(out, `scenario-${scenario}.json`), 'utf8').replace(/^\uFEFF/, '')) as {
    unit: string
    evidenceKind: string
    db: { name: string, user: string }
    costConfirmed: boolean
    stopCode?: string
    realModelRequests: number
    recoveredTaskIds: readonly string[]
    formation: { tasks: readonly unknown[], qualified: boolean, hasControl: boolean }
    measurement: readonly {
      object: string, condition: string, achieved: boolean, fileTruth: boolean, candidateCalls: number,
      physicalRequests: number, meterCode?: string, orderFirstCandidate?: string
    }[]
    totals: { achieved: number, tasks: number, requests: number, tokens: number, candidateCalls: number, physicalRequests: number }
    meter: { requests: number, tokens: number, costVerifiable: boolean }
    thisRun: { physicalRequests: number, plannerCalls: number }
  }

  const full = reportOf('full')
  check('full：形成 4 题 + 测量 6 题逐题达成（真实规划器 + 假 fetch）',
    full.formation.tasks.length === 4 && full.measurement.length === 6 && full.totals.achieved === 6
    && full.measurement.every(row => row.achieved && row.fileTruth))
  check('full：数据库身份核对通过（库名 lg_test_ 前缀）', full.db.name.startsWith('lg_test_'), full.db.name)
  check('full：**计量只结算一次**（物理请求 == 规划器调用 == 计量次数 == realModelRequests）',
    full.totals.physicalRequests === 6 && full.totals.candidateCalls === 6
    && full.meter.requests === 6 && full.realModelRequests === 6
    && full.measurement.every(row => row.physicalRequests === 1 && row.candidateCalls === 1),
    `physical=${String(full.totals.physicalRequests)} calls=${String(full.totals.candidateCalls)} meter=${String(full.meter.requests)}`)
  check('full：成本可确认、无停止码；证据类型明确标记为 gate_fake_fetch（零网络）',
    full.costConfirmed === true && full.stopCode === undefined && full.evidenceKind === 'gate_fake_fetch')

  /* 完成协议（本批修补）：`done:true, steps:[]` 完成声明要进入**真实写入+最终读回**校验。 */
  const claimMix = reportOf('claim-mix')
  check('claim-mix：先写+读回、再给完成声明 ⇒ **达成 6/6**（由读回校验判定，不凭声明）',
    claimMix.totals.achieved === 6 && claimMix.measurement.every(row => row.achieved && row.fileTruth)
    && claimMix.measurement.every(row => row.candidateCalls === 2),
    `achieved=${String(claimMix.totals.achieved)} calls=${claimMix.measurement.map(row => row.candidateCalls).join(',')}`)
  check('claim-mix：完成声明被接受（无 plan_failed），物理请求 = 2/题',
    claimMix.stopCode === undefined && claimMix.totals.physicalRequests === 12,
    `physical=${String(claimMix.totals.physicalRequests)} stop=${String(claimMix.stopCode)}`)

  const claimOnly = reportOf('claim-only')
  check('claim-only：**假完成**（没写就声称完成）⇒ 达成 0、全部被拒（task_goal_unmet）',
    claimOnly.totals.achieved === 0 && claimOnly.measurement.length === 6
    && claimOnly.measurement.every(row => row.achieved === false),
    `achieved=${String(claimOnly.totals.achieved)} stops=${claimOnly.measurement.map(row => (row as { stopped?: string }).stopped).join(',')}`)

  const traceRows = (claimMix.measurement as readonly { selectionTrace?: readonly unknown[], selectionRounds?: number, vetoRounds?: number }[])
  check('claim-mix：**完整选择轨迹**落盘（每行有 selectionTrace/轮次/veto 轮数）',
    traceRows.every(row => Array.isArray(row.selectionTrace) && typeof row.selectionRounds === 'number' && typeof row.vetoRounds === 'number'))

  const costClass = claimMix.totals as unknown as { usageConfirmedTokens?: number, provisionalTokens?: number, unconfirmedEvents?: number }
  check('cost 分类：报告分列 usage 确认量 / 暂扣量 / 未确认事件（不把暂扣当确认）',
    typeof costClass.usageConfirmedTokens === 'number' && typeof costClass.provisionalTokens === 'number'
    && typeof costClass.unconfirmedEvents === 'number' && costClass.unconfirmedEvents === 0)

  const cost = reportOf('cost')
  check('cost：假 fetch 不返回 usage ⇒ 第一题之后**停止后续请求**（只 1 行测量）',
    cost.measurement.length === 1, `${String(cost.measurement.length)} 行`)
  check('cost：判为 cost_unverifiable、costVerifiable=false、成本不可确认',
    cost.stopCode === 'cost_unverifiable' && cost.meter.costVerifiable === false && cost.costConfirmed === false)

  const resume = reportOf('resume')
  check('resume：任务账本里已完成的题**原样取回、不重跑**（本次物理请求 6 → 5）',
    resume.recoveredTaskIds.length === 1 && resume.totals.physicalRequests === 6
    && resume.thisRun.physicalRequests === 5 && resume.measurement.length === 6,
    `recovered=${String(resume.recoveredTaskIds.length)} thisRun=${String(resume.thisRun.physicalRequests)} total=${String(resume.totals.physicalRequests)}`)

  const bArm = reportOf('b-arm')
  check('B 臂：脚本恒定权威 ⇒ **物理请求 0**、计量 0，但规划器调用仍如实计数（脚本不冒充请求）',
    bArm.totals.physicalRequests === 0 && bArm.meter.requests === 0 && bArm.totals.candidateCalls === 6
    && bArm.totals.achieved === 6, `physical=${String(bArm.totals.physicalRequests)} calls=${String(bArm.totals.candidateCalls)}`)

  /* 网络抛错：必须在账本里"先 started 后 finished（成本不可确认）"，并停止后续请求。 */
  {
    const previousKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'gate-fake-key'
    const { createF2Meter: makeMeter } = await import('./f2-live-runner-guards.ts')
    const { createCapabilityRegistry: makeRegistry, createDefaultCapabilityDefinitions: makeDefs } =
      await import('../../src/kernel/action/capability-registry.ts')
    const attempts: string[] = []
    const meter = makeMeter({
      requestsCap: 10, tokensCap: 100_000, perTaskRequests: 6, maxCompletionTokens: 1_200, now: () => 1,
      onAttempt: entry => attempts.push(entry.kind),
    })
    const throwing: typeof fetch = async () => { throw new Error('network down') }
    const probeContext = {
      unit: 'net-probe', arm: 'A' as const, order: 'cached-first' as const,
      paths: {
        family: 'f2/a', object: 'obj-31', target: 'f2/a/obj-31.txt', cache: 'f2/a/obj-31.cache',
        authority: 'f2/a/obj-31.src', marker: 'f2/a/.freshness', cachedBytes: 'stale:obj-31', authBytes: 'auth:obj-31',
      },
      cacheFirstPlan: {}, authoritativeFirstPlan: {},
    }
    const probe = (await import('./f2-real-planner.ts')).createRealPlannerFactory({
      registry: makeRegistry(makeDefs()), meter, unit: 'net-probe', fetchImpl: throwing,
    })(probeContext)
    const probeInput = {
      task: 'F2 只操作相对路径 f2/a/obj-31.txt；缓存源 f2/a/obj-31.cache；权威源 f2/a/obj-31.src；族标记 f2/a/.freshness，最多读一次。',
      allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], executed: [], failures: [],
    }
    await probe.plan(probeInput as never, probeContext as never)
    check('network：假 fetch 抛错 ⇒ 账本先 started 后 finished（成本不可确认），并判 cost_unverifiable',
      attempts[0] === 'attempt_started' && attempts[1] === 'attempt_finished'
      && meter.state().stopCode === 'cost_unverifiable',
      attempts.join(',') + ' stop=' + String(meter.state().stopCode))
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  }

  /* 顺序因子：纯函数 + 规划器返回的 orderApplied（缓存桶 vs 权威桶）。 */
  const { orderCandidatesByPrior, candidateBucketOf, createRealPlannerFactory: probeFactory } = await import('./f2-real-planner.ts')
  /* 逐题上限：**真实规划器 + 假 fetch** 直接验证"第 2 次物理请求被拒、且不置全局停止"。 */
  {
    /* ⚠️ 真实规划器构造时读 `OPENAI_API_KEY`（空 ⇒ 直接 call_failed、不发请求）⇒ 门内给假 key。 */
    const previousKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'gate-fake-key'
    const { createF2Meter: makeMeter } = await import('./f2-live-runner-guards.ts')
    const { createCapabilityRegistry: makeRegistry, createDefaultCapabilityDefinitions: makeDefs } =
      await import('../../src/kernel/action/capability-registry.ts')
    const probeMeter = makeMeter({ requestsCap: 10, tokensCap: 100_000, perTaskRequests: 1, maxCompletionTokens: 1_200, now: () => Date.now() })
    const probeContext = {
      unit: 'cap-probe', arm: 'A' as const, order: 'cached-first' as const,
      paths: {
        family: 'f2/a', object: 'obj-31', target: 'f2/a/obj-31.txt', cache: 'f2/a/obj-31.cache',
        authority: 'f2/a/obj-31.src', marker: 'f2/a/.freshness', cachedBytes: 'stale:obj-31', authBytes: 'auth:obj-31',
      },
      cacheFirstPlan: {}, authoritativeFirstPlan: {},
    }
    const probe = probeFactory({ registry: makeRegistry(makeDefs()), meter: probeMeter, unit: 'cap-probe', fetchImpl: fakeFetchOf('auth') })(probeContext)
    const probeInput = {
      task: 'F2 只操作相对路径 f2/a/obj-31.txt；缓存源 f2/a/obj-31.cache；权威源 f2/a/obj-31.src；族标记 f2/a/.freshness，最多读一次。',
      allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], executed: [], failures: [],
    }
    const firstCall = await probe.plan(probeInput as never, probeContext as never)
    const secondCall = await probe.plan(probeInput as never, probeContext as never)
    check('cap：同一题第 2 次物理请求被 `task_request_cap` 拒绝（逐题上限；**不**置全局停止）',
      firstCall.ok === true && firstCall.requestCount === 1
      && secondCall.ok === false && secondCall.refusal === 'task_request_cap'
      && probeMeter.state().stopCode === undefined,
      `first=${String(firstCall.requestCount)} refusal=${String(secondCall.refusal)} stop=${String(probeMeter.state().stopCode)}`)
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  }
  const paths = { cachedBytes: 'stale:obj-32', authBytes: 'auth:obj-32' }
  const plan = (content: string) => ({ goal: 'x', done: true, steps: [{ args: { content } }] })
  const cached = plan('stale:obj-32')
  const auth = plan('auth:obj-32')
  const cf = orderCandidatesByPrior([auth, cached], 'cached-first', paths)
  const af = orderCandidatesByPrior([cached, auth], 'authoritative-first', paths)
  check('order：`cached-first` ⇒ 缓存桶候选排第一；`authoritative-first` ⇒ 权威桶排第一',
    candidateBucketOf(cf[0], paths) === 'cached' && candidateBucketOf(af[0], paths) === 'authoritative')
  check('order：`orderApplied` 逐题如实报告第一候选来源桶（fresh 上 cache==auth ⇒ 记 cached；stale 上记 authoritative）',
    full.measurement.every(row => row.condition === 'fresh'
      ? row.orderFirstCandidate === 'cached'
      : row.orderFirstCandidate === 'authoritative'),
    full.measurement.map(row => `${row.object}:${row.orderFirstCandidate ?? '?'}`).join(','))

  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'PASS', schema: 'f2-unit-execution-wiring@1', measuredAt: new Date().toISOString(), checks,
    scenarios: ['full', 'cost', 'resume', 'b-arm', 'cap-probe', 'order'],
    boundary: [
      '本门零真实模型请求：真实规划器工厂 + **假 fetch**（零网络）',
      '物理请求只在规划器 fetch 边界计量；脚本规划（B）不冒充请求',
      'gate_fake_fetch 只证明接线与计量，**不构成**收益读数',
    ],
  }, null, 2))
  console.log(`F2 单元接线门：${String(checks.length)}/${String(checks.length)}；${out}`)
} catch (error) {
  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'FAIL', schema: 'f2-unit-execution-wiring@1', measuredAt: new Date().toISOString(), checks,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  throw error
}
