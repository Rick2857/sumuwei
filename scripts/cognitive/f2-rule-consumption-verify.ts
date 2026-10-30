/**
 * **F2 消费链诊断门 v2（零网络 · 当前单元执行器 · 夹具前提已修正）**。
 *
 * 用户裁定：上一版把"夹具知道缓存内容"误当成"任务有缓存读回执" ⇒ `unknown` 可能完全正确。
 * 本版**先修夹具**，只验证四条契约（不降归属要求、不改产品）：
 * ```text
 * ① unread-cache ：未读缓存源 ⇒ 缓存字节候选必须 `unknown`（不得强行 cache）
 * ② read-both    ：经 Gateway 真实读两个不同内容的源后 ⇒ 写候选分别 cache / authoritative
 * ③ stale-close  ：stale + 合格规则 ⇒ **只否决缓存候选**；权威路径真实写入+读回，再由**完成声明**收尾
 * ④ same-content ：两源同内容 ⇒ 仍为 unknown；false-claim ⇒ 假完成被拒（task_goal_unmet）
 * ```
 * ⚠️ 零真实模型请求；本门只回答"契约是否成立"，不回答收益，也不追求 C 优于 A。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCRIPT = 'scripts/cognitive/f2-rule-consumption-verify.ts'
const TASK_SPEC = 'docs/architecture/f2-preregistration-20261025/task-spec.json'
const SCENARIO = process.env.LG_F2_RULE_SCENARIO
const SCENARIOS = ['unread-cache', 'read-both', 'stale-close', 'same-content', 'false-claim'] as const

type Spec = {
  formalSequence: {
    id: string, family: string
    formation: { object: string, condition: string, role: string }[]
    measurement: { object: string, condition: string }[]
  }
}

/* ------------------------------------------------------------------ 子进程：一个场景一个单元 */
if (SCENARIO !== undefined) {
  const { isolateDatabase } = await import('../../src/dev/sandbox.ts')
  isolateDatabase(`f2-rule-${SCENARIO}`, { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
  const out = String(process.env.LG_F2_RULE_OUT)
  const spec = JSON.parse(readFileSync(TASK_SPEC, 'utf8')) as Spec
  const sequence = spec.formalSequence
  const conditionOf = new Map(sequence.measurement.map(item => [item.object, item.condition]))
  const { createF2Meter } = await import('./f2-live-runner-guards.ts')
  const { createRealPlannerFactory } = await import('./f2-real-planner.ts')
  const { runF2Unit } = await import('./f2-unit-runtime.ts')
  const { createCapabilityRegistry, createDefaultCapabilityDefinitions } = await import('../../src/kernel/action/capability-registry.ts')

  const callsByObject = new Map<string, number>()
  const fetchImpl = (async (_input: unknown, init?: unknown) => {
    const body = JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? '{}')) as { messages?: { content?: unknown }[] }
    const text = (body.messages ?? []).map(item => String(item.content ?? '')).join(' ')
    const object = /(obj-f?\d+)/.exec(text)?.[1] ?? 'obj-31'
    const family = /(f\d+\/a)/.exec(text)?.[1] ?? sequence.family
    const condition = conditionOf.get(object) ?? 'fresh'
    const target = `${family}/${object}.txt`
    const cachePath = `${family}/${object}.cache`
    const authPath = `${family}/${object}.src`
    const authContent = `auth:${object}`
    const cacheContent = condition === 'stale' ? `stale:${object}` : authContent
    const callIndex = (callsByObject.get(object) ?? 0) + 1
    callsByObject.set(object, callIndex)
    const readStep = (path: string) => ({ capability: 'sandbox.file.read' as const, operation: 'read' as const, args: { path } })
    const writeStep = (content: string) => ({ capability: 'sandbox.file.write' as const, operation: 'write' as const, args: { path: target, content } })
    const readBack = readStep(target)
    const plan = (contents: string[], done = false) => ({
      goal: 'gate', done, steps: [...contents.map(content => writeStep(content)), readBack],
    })
    const readsBoth = { goal: 'gate', done: false, steps: [readStep(cachePath), readStep(authPath), readBack] }
    const claim = { goal: 'gate', done: true, steps: [] as unknown[] }

    let candidates: unknown[]
    switch (SCENARIO) {
      case 'unread-cache':
        /* ① 不读缓存源：候选里虽有缓存字节，但任务**没有**缓存读回执 ⇒ 期望 unknown。 */
        candidates = [plan([cacheContent]), plan([authContent])]
        break
      case 'read-both':
        /* ② 第 1 轮真实读两个源（经 Gateway），第 2 轮才给写候选。 */
        candidates = callIndex === 1 ? [] : [plan([cacheContent]), plan([authContent])]
        break
      case 'stale-close':
        /* ③ 读两源 → 写候选（规则否决缓存）→ **完成声明**收尾。 */
        candidates = callIndex === 1 ? [] : callIndex === 2 ? [plan([cacheContent]), plan([authContent])] : [claim]
        break
      case 'same-content':
        /* ④ 两源同内容（fresh：cache==auth）⇒ 归属仍 unknown。 */
        candidates = callIndex === 1 ? [] : [plan([authContent]), plan([authContent])]
        break
      default:
        /* ④b 假完成：没写就声称完成。 */
        candidates = [claim]
        break
    }
    const message = callIndex === 1 && (SCENARIO === 'read-both' || SCENARIO === 'stale-close' || SCENARIO === 'same-content')
      ? JSON.stringify({ candidates: [] })
      : JSON.stringify({ candidates })
    /* 第 1 轮"读两源"：用**读计划**装进候选池（单候选，done:false）。 */
    const content = message
    const payload = SCENARIO !== 'unread-cache' && callIndex === 1 && candidates.length === 0
      ? { choices: [{ message: { content: JSON.stringify({ candidates: [readsBoth] }) } }], usage: { total_tokens: 120, prompt_tokens: 100, completion_tokens: 20 } }
      : { choices: [{ message: { content } }], usage: { total_tokens: 120, prompt_tokens: 100, completion_tokens: 20 } }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response
  }) as unknown as typeof fetch

  const meter = createF2Meter({ requestsCap: 64, tokensCap: 400_000, perTaskRequests: 8, maxCompletionTokens: 8_000, now: () => Date.now() })
  const plannerFactory = createRealPlannerFactory({
    registry: createCapabilityRegistry(createDefaultCapabilityDefinitions()), meter, unit: 'C-cf', fetchImpl,
  })
  const report = await runF2Unit({
    unit: 'C-cf', arm: 'C', order: 'cached-first',
    sequence: { family: sequence.family, formation: sequence.formation, measurement: sequence.measurement },
    sequenceId: sequence.id,
    dbUrl: String(process.env.LG_TEST_PG_URL ?? ''), root: resolve(out, `files-${SCENARIO}`), out,
    evidenceKind: 'gate_fake_fetch', plannerFactory, meter,
  })
  writeFileSync(resolve(out, `scenario-${SCENARIO}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8')
  process.exit(0)
}

/* ------------------------------------------------------------------ 父进程：编排与断言 */
const { runPreparedPgGate, runPreparedPgGateInInstance } = await import('../postgresql/test-harness.ts')
const out = resolve('artifacts/local/f2-rule-consumption', `run-${Date.now()}`)
mkdirSync(out, { recursive: true })
const checks: string[] = []
const check = (name: string, value: unknown, detail = ''): void => {
  if (!value) throw new Error(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
const adminUrl = (process.env.LG_F2_ADMIN_URL ?? process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
const spawnScenario = async (scenario: string): Promise<void> => {
  process.env.LG_F2_RULE_SCENARIO = scenario
  process.env.LG_F2_RULE_OUT = out
  if (adminUrl !== '') await runPreparedPgGateInInstance(adminUrl, `f2-rule-${scenario}`, SCRIPT)
  else await runPreparedPgGate(`f2-rule-${scenario}`, SCRIPT)
  delete process.env.LG_F2_RULE_SCENARIO
  delete process.env.LG_F2_RULE_OUT
}

type Trace = {
  phase: string, vetoed: boolean, reason?: string, attributions: readonly string[]
  ruleId?: string, claimId?: string, vetoedCandidateIds?: readonly string[]
}
type Row = {
  object: string, condition: string, achieved: boolean, fileTruth: boolean, stopped: string,
  vetoed: boolean, vetoReason?: string, rejectedCode?: string, selectionTrace?: readonly Trace[]
}
type Report = {
  measurement: readonly Row[]
  formation: { qualified: boolean, tasks: readonly unknown[] }
  totals: { achieved: number }
}

try {
  for (const scenario of SCENARIOS) await spawnScenario(scenario)
  const reportOf = (scenario: string) => JSON.parse(readFileSync(resolve(out, `scenario-${scenario}.json`), 'utf8').replace(/^\uFEFF/, '')) as Report
  const attributionOf = (row: Row): readonly string[] => (row.selectionTrace ?? []).filter(t => t.phase === 'candidates_evaluated' && t.attributions.length > 0).at(-1)?.attributions ?? []
  const staleOf = (report: Report) => report.measurement.filter(row => row.condition === 'stale')
  const freshOf = (report: Report) => report.measurement.filter(row => row.condition === 'fresh')

  /* ① 未读缓存源 ⇒ 缓存字节候选 unknown */
  const unread = reportOf('unread-cache')
  check('① 前提：未读缓存源时，形成阶段仍取得资格（否则本条无法判定归属）', unread.formation.qualified === true)
  check('① **未读缓存源**：缓存字节候选归为 `unknown`（不得强行 cache），权威字节候选为 `authoritative`',
    staleOf(unread).every(row => { const a = attributionOf(row); return a[0] === 'unknown' && a[1] === 'authoritative' }),
    JSON.stringify(staleOf(unread).map(row => [row.object, attributionOf(row)])))
  check('① 前提成立时**不产生规则否决**（规则作用域不可用 ⇒ 零否决是正确结果）',
    unread.measurement.every(row => row.vetoed === false))

  /* ② 真实读两个不同内容的源 ⇒ 写候选分别 cache / authoritative */
  const readBoth = reportOf('read-both')
  check('② **经 Gateway 真实读两个不同内容的源**后：写候选分别归为 `cache` / `authoritative`',
    staleOf(readBoth).every(row => { const a = attributionOf(row); return a[0] === 'cache' && a[1] === 'authoritative' }),
    JSON.stringify(staleOf(readBoth).map(row => [row.object, attributionOf(row)])))

  /* ③ stale + 合格规则 ⇒ 只否决缓存候选；权威路径写入读回；完成声明收尾 */
  const close = reportOf('stale-close')
  const staleClose = staleOf(close)
  check('③ stale + 合格规则：**只否决缓存候选**（否决对象恰好 1 个，且为第 0 号缓存候选）',
    staleClose.every(row => {
      const event = (row.selectionTrace ?? []).find(t => t.vetoed === true)
      return row.vetoed === true && row.vetoReason === 'precondition_violated'
        && (event?.vetoedCandidateIds ?? []).length === 1 && (event?.vetoedCandidateIds ?? [])[0] === '0'
    }), JSON.stringify(staleClose.map(row => [row.object, (row.selectionTrace ?? []).filter(t => t.vetoed).map(t => t.vetoedCandidateIds)])))
  check('③ 否决记录带**规则身份**（ruleId/claimId）', staleClose.every(row => {
    const event = (row.selectionTrace ?? []).find(t => t.vetoed === true)
    return typeof event?.ruleId === 'string' && event.ruleId.length > 0 && typeof event?.claimId === 'string' && event.claimId.length > 0
  }))
  check('③ 权威路径**真实写入+读回**并用**完成声明**收尾 ⇒ 达成、文件字节 == 权威源',
    staleClose.every(row => row.achieved === true && row.fileTruth === true && row.stopped === 'done')
    && close.totals.achieved === 6,
    `achieved=${String(close.totals.achieved)} rows=${JSON.stringify(staleClose.map(row => [row.achieved, row.fileTruth, row.stopped]))}`)

  /* ④ 反控：两源同内容 ⇒ unknown；假完成被拒 */
  const same = reportOf('same-content')
  check('④ 反控：**两源同内容**仍为 `unknown`（不因内容相同就认成 cache 或 authoritative）',
    freshOf(same).every(row => attributionOf(row).every(a => a === 'unknown')),
    JSON.stringify(freshOf(same).map(row => [row.object, attributionOf(row)])))
  const falseClaim = reportOf('false-claim')
  check('④ 反控：**假完成**（没写就声称完成）被拒 ⇒ 达成 0、全部以 plan_failed 结束',
    falseClaim.totals.achieved === 0
    && falseClaim.measurement.every(row => row.achieved === false)
    && falseClaim.measurement.every(row => row.stopped === 'plan_failed'),
    `achieved=${String(falseClaim.totals.achieved)} stops=${JSON.stringify(falseClaim.measurement.map(row => row.stopped))}`)
  check('④ 已知缺口：该路径的 planRejectedCode 未出现在 handleTurn().task 上（如实记录，不在本批修产品）',
    falseClaim.measurement.every(row => row.rejectedCode === undefined || row.rejectedCode === null || row.rejectedCode === ''))

  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'PASS', schema: 'f2-rule-consumption@2', measuredAt: new Date().toISOString(), checks,
    scenarios: [...SCENARIOS],
    boundary: [
      '零真实模型请求：候选池与读步骤由夹具构造',
      '只验证四条契约；不新增策略/世界；不追求 C 优于 A',
      '第 2 项若失败才修最小产品接点（回执读取→指纹匹配→逐候选判定）',
    ],
  }, null, 2) + '\n', 'utf8')
  console.log(`F2 消费链诊断门 v2：${String(checks.length)}/${String(checks.length)}；${out}`)
} catch (error) {
  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'FAIL', schema: 'f2-rule-consumption@2', measuredAt: new Date().toISOString(), checks,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2) + '\n', 'utf8')
  throw error
}
