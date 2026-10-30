/**
 * 认知能力建设 · P3-5b · **运行守卫零请求回归门**（`p3:5:runner:verify`）
 * ============================================================================
 *  这一道门回归两个**真跑出来的故障** + 一个**真跑出来的记账故障**，全部零请求、零数据库：
 *
 *  ```text
 *  ① 端点注入（2026-10-28 首轮试点）：仿真镜像自带 `.env`（`OPENAI_BASE_URL=http://127.0.0.1:18080/v1`）
 *     经 dotenv 补进 `process.env` ⇒ 规划器打到**仿真桩**（96 请求×2 token），只有最终答复走真端点。
 *     ⇒ 本门用**真实规划器 + 假 transport**：先把"基线环境"污染成桩端点，再断言真正发出的请求
 *        带的是**冻结端点**的 URL / model / apiKey / reasoning_effort=low / temperature=0。
 *  ② 空答复（2026-10-28 第二次尝试）：答复被 `turn_request_cap` 拒收 ⇒ 正文空 ⇒ 旧代码把空正文交给
 *     `completeTurn` ⇒ `empty_speech_intent` 崩掉整个序列。⇒ 本门断言：空/被拒 **不提交**、
 *     记 `answerMissing`/`aborted`、**成本照记**，且冻结判分器对这样的轮次判 `unknown`（**不误算达成**）。
 *  ③ 记账写面（2026-10-28 第二次尝试）：账目被 `docker cp` 写成 `root:root`，容器内运行用户只能读 ⇒
 *     第 1 轮**发完真实请求之后**才 `EACCES`。⇒ 本门断言写面预检**在首次请求之前**跑，且不可写时
 *     以具名码失败关闭（`ledger_unwritable` / `journal_unwritable`）。
 *  ```
 *
 *  ⚠️ 边界（必须与读数一起读）
 *   · **零真实模型请求、零网络、零数据库**：`globalThis.fetch` 在本门内被替换成"一调用就抛"，
 *     规划器只能用注入的假 transport（最后一条检查会核对"真 fetch 调用数 = 0"）。
 *   · **不是收益门**，也**不重跑试点**：试点读数留在已归档的有效封存里，本门只证明"故障不会再复发"。
 *   · **不替代** P3-6 的接线/迁移验收。
 *
 *  运行：
 *  ```bash
 *  pnpm p3:5:runner:verify
 *  ```
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  P3_5_GUARD_CODES,
  assertP35PlannerEndpoint,
  buildP35AccountingEntry,
  buildP35PlannerEnv,
  decideP35TurnAnswer,
  ensureP35WriteSurfaces,
} from './p3-5-live-runner-guards.ts'
import { scoreTurn } from './p3-5-score.ts'
import { createOpenAiTaskPlanner } from '../../src/infrastructure/model/openai-task-planner.ts'
import { createCapabilityRegistry } from '../../src/kernel/action/capability-registry.ts'
import {
  WORKFLOW_SKILL,
  createLearningCapabilityDefinitions,
} from '../../src/kernel/action/learning-capabilities.ts'

// ---------------------------------------------------------------------------
//  检查表（输出风格照抄 `scripts/cognitive/p3-5-scorer-verify.ts`）
// ---------------------------------------------------------------------------
interface CheckRow {
  readonly id: string
  readonly title: string
  readonly pass: boolean
  readonly detail: string
}
const checks: CheckRow[] = []
async function check(id: string, title: string, fn: () => string | Promise<string>): Promise<void> {
  try {
    const detail = await fn()
    checks.push({ id, title, pass: true, detail })
  } catch (error) {
    checks.push({ id, title, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}
const startedAt = Date.now()

/* ---- 冻结端点（与 `docs/architecture/p3-5-preregistration-20261028/task-spec.json` 一致） ---- */
const FROZEN_ENDPOINT = {
  baseUrl: 'https://api.minimax.cn/v1',
  model: 'MiniMax-M3.1-Flash-Preview',
  key: 'frozen-test-key-not-a-real-credential',
  host: 'api.minimax.cn',
} as const
/** 仿真镜像里那份 `.env` 的形态（桩端点）。**只用于证明"被污染也打不到它"**。 */
const STUB_BASE_URL = 'http://127.0.0.1:18080/v1'
const STUB_MODEL = 'deepseek-flash'

/* ---- 零真实网络：本门内真 fetch 一调用就抛 ---- */
const realFetch = globalThis.fetch
let realFetchCalls = 0
globalThis.fetch = (async () => {
  realFetchCalls += 1
  throw new Error('p3-5b_gate_forbids_real_network')
}) as typeof fetch

/* ---- 假 transport：记录每一次物理请求，返回一个可解析的合法计划 ---- */
interface FakeCall {
  readonly url: string
  readonly body: Record<string, unknown>
  readonly authorization: string
}
const fakeCalls: FakeCall[] = []
const fakeFetch = (async (input: unknown, init?: { body?: unknown, headers?: Record<string, string> }) => {
  const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input)
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
  const authorization = init?.headers?.Authorization ?? (init?.headers as Record<string, string> | undefined)?.authorization ?? ''
  fakeCalls.push({ url, body, authorization })
  const plan = {
    goal: '读资料并回答',
    steps: [{ capability: 'workflow.skill', operation: 'load', args: { skill: 'personal-library' } }],
    done: false,
  }
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(plan) } }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

const registry = createCapabilityRegistry([...createLearningCapabilityDefinitions()])
const plannerInput = {
  task: '在我的资料夹里找一下关于「注意力」的两条做法，并告诉我分别出自哪份文件。',
  executed: [] as string[],
  failures: [] as string[],
  remainingActions: 5,
  allowedCapabilities: [WORKFLOW_SKILL],
}

const runnerSource = readFileSync(new URL('./p3-5-live-runner.ts', import.meta.url), 'utf8')
const guardsSource = readFileSync(new URL('./p3-5-live-runner-guards.ts', import.meta.url), 'utf8')
const frozenSpec = JSON.parse(readFileSync(
  new URL('../../docs/architecture/p3-5-preregistration-20261028/task-spec.json', import.meta.url),
  'utf8',
)) as { readonly tasks: readonly { readonly taskId: string, readonly kind: string, readonly expect: { readonly files: readonly string[], readonly keywordsAnyOf: readonly string[], readonly minKeywords: number }, readonly goalApplicable?: boolean }[] }
const t1 = frozenSpec.tasks.find(task => task.taskId === 'T1')
if (t1 === undefined) throw new Error('冻结 task-spec 里没有 T1')

// ---------------------------------------------------------------------------
//  ① 端点注入：被污染的基线环境也不影响实际请求
// ---------------------------------------------------------------------------

await check('01', '端点注入：基线环境被仿真桩污染时，注入的三件仍然是冻结值', () => {
  const pollutedBase = {
    ...process.env,
    OPENAI_BASE_URL: STUB_BASE_URL,
    OPENAI_SMALL_MODEL: STUB_MODEL,
    OPENAI_API_KEY: 'stub-key',
  }
  const env = buildP35PlannerEnv({ endpoint: FROZEN_ENDPOINT, base: pollutedBase })
  assert.equal(env.OPENAI_BASE_URL, FROZEN_ENDPOINT.baseUrl)
  assert.equal(env.OPENAI_SMALL_MODEL, FROZEN_ENDPOINT.model)
  assert.equal(env.OPENAI_API_KEY, FROZEN_ENDPOINT.key)
  assert.notEqual(env.OPENAI_BASE_URL, STUB_BASE_URL)
  return `baseUrl=${String(env.OPENAI_BASE_URL)} model=${String(env.OPENAI_SMALL_MODEL)}`
})

await check('02', '实际请求打到冻结端点：URL / model / apiKey / reasoning_effort=low / temperature=0', async () => {
  const before = fakeCalls.length
  const planner = createOpenAiTaskPlanner({
    registry,
    env: buildP35PlannerEnv({
      endpoint: FROZEN_ENDPOINT,
      base: { ...process.env, OPENAI_BASE_URL: STUB_BASE_URL, OPENAI_SMALL_MODEL: STUB_MODEL },
    }),
    fetchImpl: fakeFetch,
    maxTokens: 4_000,
    timeoutMs: 5_000,
    reasoningEffort: 'low',
  })
  const outcome = await planner.plan(plannerInput)
  assert.equal(outcome.ok, true, `规划器没有成功（${JSON.stringify(outcome)}）`)
  assert.equal(fakeCalls.length - before, 1, '应当恰好发出 1 次物理请求')
  const call = fakeCalls[fakeCalls.length - 1]!
  assert.equal(call.url, `${FROZEN_ENDPOINT.baseUrl}/chat/completions`)
  assert.equal(call.body.model, FROZEN_ENDPOINT.model)
  assert.equal(call.body.reasoning_effort, 'low')
  assert.equal(call.body.temperature, 0)
  assert.equal(call.authorization, `Bearer ${FROZEN_ENDPOINT.key}`)
  assert.ok(!call.url.includes('127.0.0.1'), '请求不许打到回环桩端点')
  return `url=${call.url} model=${String(call.body.model)} reasoning_effort=${String(call.body.reasoning_effort)}`
})

await check('03', '规划器自报端点 == 冻结端点，且桩端点会被判为漂移并给出 endpoint_invalid', () => {
  const planner = createOpenAiTaskPlanner({
    registry,
    env: buildP35PlannerEnv({ endpoint: FROZEN_ENDPOINT, base: { OPENAI_BASE_URL: STUB_BASE_URL } }),
    fetchImpl: fakeFetch,
  })
  const ok = assertP35PlannerEndpoint({ plannerEndpointHost: planner.endpointHost, expectedHost: FROZEN_ENDPOINT.host })
  assert.equal(ok.ok, true, `冻结端点被判成漂移：${JSON.stringify(ok)}`)
  const drifted = assertP35PlannerEndpoint({ plannerEndpointHost: '127.0.0.1:18080', expectedHost: FROZEN_ENDPOINT.host })
  assert.equal(drifted.ok, false, '桩端点没有被判成漂移')
  if (drifted.ok) throw new Error('unreachable')
  assert.equal(drifted.code, 'endpoint_invalid')
  const empty = assertP35PlannerEndpoint({ plannerEndpointHost: '', expectedHost: FROZEN_ENDPOINT.host })
  assert.equal(empty.ok, false)
  return `planner=${planner.endpointHost} drift=${drifted.code}`
})

// ---------------------------------------------------------------------------
//  ② 空答复 / 被拒答复：不提交、不误算达成、成本照记
// ---------------------------------------------------------------------------

await check('04', '答复决策真值表：空 / 被拒 / 有正文 三种情形逐条断言', () => {
  const normal = decideP35TurnAnswer({ answerText: ' 收到  ' })
  assert.deepEqual(normal, { submitReply: true, answerMissing: false, aborted: false })
  const empty = decideP35TurnAnswer({ answerText: '   ' })
  assert.equal(empty.submitReply, false)
  assert.equal(empty.answerMissing, true)
  assert.equal(empty.aborted, true)
  assert.equal(empty.reason, 'answer_empty')
  const refused = decideP35TurnAnswer({ answerText: '', refusal: 'turn_request_cap' })
  assert.equal(refused.submitReply, false)
  assert.equal(refused.answerMissing, true)
  assert.equal(refused.reason, 'answer_refused')
  const stopped = decideP35TurnAnswer({ answerText: '有正文', meterStopCode: 'cost_unverifiable' })
  assert.equal(stopped.submitReply, true)
  assert.equal(stopped.aborted, true)
  return `empty=${String(empty.reason)} refused=${String(refused.reason)} stopped.aborted=${String(stopped.aborted)}`
})

await check('05', '空答复的轮次**不误算达成**：冻结判分器给出 unknown（不是 achieved）', () => {
  const report = {
    turnId: 'A-T1-r1',
    arm: 'A' as const,
    taskId: 'T1',
    repeat: 1,
    finalText: '',
    readPaths: [],
    citedPaths: [],
    skillLoadSucceeded: false,
    deniedActionCount: 0,
    outOfBoundaryReadCount: 0,
    snapshotPaths: [...t1.expect.files],
    injectedSkillFingerprints: [],
    requests: 5,
    tokens: 9_000,
    elapsedMs: 1_000,
    answerMissing: true,
    aborted: true,
  }
  const score = scoreTurn(report, t1)
  assert.equal(score.goal, 'unknown', `空答复被判成 ${score.goal}（必须 unknown）`)
  assert.notEqual(score.goal, 'achieved')
  assert.ok(score.unknownReasons.length > 0, 'unknown 必须带原因')
  return `goal=${score.goal} reasons=${String(score.unknownReasons.length)}`
})

await check('06', '反例（防真空断言）：同样的判分器对"有正文 + 命中关键词 + 引用期望文件"必须判 achieved', () => {
  const control = {
    turnId: 'A-T1-r1',
    arm: 'A' as const,
    taskId: 'T1',
    repeat: 1,
    finalText: `${t1.expect.keywordsAnyOf[0]!}：把工作切成小段。出处：${t1.expect.files[0]!}`,
    readPaths: [...t1.expect.files],
    citedPaths: [...t1.expect.files],
    skillLoadSucceeded: false,
    deniedActionCount: 0,
    outOfBoundaryReadCount: 0,
    snapshotPaths: [...t1.expect.files],
    injectedSkillFingerprints: [],
    requests: 5,
    tokens: 9_000,
    elapsedMs: 1_000,
  }
  const score = scoreTurn(control, t1)
  assert.equal(score.goal, 'achieved', `反例没有被判成 achieved（${score.goal}）`)
  assert.equal(score.sourceSupport, true)
  return `goal=${score.goal} sourceSupport=${String(score.sourceSupport)}`
})

await check('07', '成本照记：答复缺失/中止的轮次，账目行仍然带请求数与 token（不被清零）', () => {
  const entry = buildP35AccountingEntry({
    at: 1_793_202_000_000,
    startMarker: 'deadbeefdeadbeef',
    turnId: 'A-T1-r1',
    requests: 6,
    tokens: 11_113,
    unconfirmed: 0,
    aborted: true,
  })
  assert.equal(entry.requests, 6)
  assert.equal(entry.tokens, 11_113)
  assert.equal(entry.aborted, true)
  const negative = buildP35AccountingEntry({ at: 0, startMarker: '', turnId: 'x', requests: -1, tokens: -5, unconfirmed: -2, aborted: false })
  assert.equal(negative.requests, 0)
  assert.equal(negative.tokens, 0)
  assert.equal(negative.unconfirmed, 0)
  return `requests=${String(entry.requests)} tokens=${String(entry.tokens)} aborted=${String(entry.aborted)}`
})

await check('08', '接线结构：空答复**不**提交 `completeTurn`；账目追加**无条件**（不在答复分支里）', () => {
  assert.ok(
    runnerSource.includes('if (answerDecision.submitReply) await turnGateway.completeTurn'),
    '运行器没有按 submitReply 守卫 completeTurn',
  )
  assert.ok(
    !runnerSource.includes('await turnGateway.completeTurn({ turn, replyText: answerText })\n    }'),
    '运行器里仍有"无条件提交空正文"的旧写法',
  )
  assert.ok(
    runnerSource.includes('appendP35Accounting(ACCOUNTING_PATH, buildP35AccountingEntry('),
    '账目没有走 buildP35AccountingEntry（成本口径可能被绕过）',
  )
  return 'submitReply 守卫 + 无条件记账'
})

// ---------------------------------------------------------------------------
//  ③ 写面预检：首次请求之前、不可写就失败关闭
// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), 'p3-5b-write-surface-'))

await check('09', '写面预检（正向）：可写目录下三处都能追加，且文件被创建', () => {
  const dir = join(tempRoot, 'ok')
  const result = ensureP35WriteSurfaces({
    accountingPath: join(dir, 'accounting.jsonl'),
    ledgerPath: join(dir, 'requests.jsonl'),
    journalPath: join(dir, 'tasks.jsonl'),
  })
  assert.equal(result.ok, true, `可写目录被判成不可写：${JSON.stringify(result)}`)
  return 'accounting/ledger/journal 均可追加'
})

await check('10', '写面预检（负向）：账目不可追加 ⇒ 具名 ledger_unwritable 失败关闭', () => {
  const dir = join(tempRoot, 'bad-accounting')
  const result = ensureP35WriteSurfaces({
    /* 把"文件路径"指向一个**目录**：append 打开必然失败（模拟 root:root + 只读）。 */
    accountingPath: dir,
    ledgerPath: join(dir, 'requests.jsonl'),
    journalPath: join(dir, 'tasks.jsonl'),
  })
  assert.equal(result.ok, false, '不可写的账目没有被拦住')
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.code, 'ledger_unwritable')
  return `${result.code}：${result.detail.slice(0, 80)}`
})

await check('11', '写面预检（负向）：任务账本不可追加 ⇒ 具名 journal_unwritable 失败关闭', () => {
  const dir = join(tempRoot, 'bad-journal')
  mkdirSync(dir, { recursive: true })
  const marker = join(dir, 'not-a-directory')
  writeFileSync(marker, 'x', 'utf8')
  const result = ensureP35WriteSurfaces({
    accountingPath: join(dir, 'accounting.jsonl'),
    ledgerPath: join(dir, 'requests.jsonl'),
    /* 父路径是个普通文件 ⇒ mkdir/append 必然失败。 */
    journalPath: join(marker, 'tasks.jsonl'),
  })
  assert.equal(result.ok, false, '不可写的任务账本没有被拦住')
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.code, 'journal_unwritable')
  return `${result.code}：${result.detail.slice(0, 80)}`
})

await check('12', '预检发生在**首次请求之前**：结构上先于 PG 自举 / 建模 / 计量器', () => {
  const precheck = runnerSource.indexOf('ensureP35WriteSurfaces(')
  const harness = runnerSource.indexOf('createM4Harness(')
  const planner = runnerSource.indexOf('createOpenAiTaskPlanner(')
  const meter = runnerSource.indexOf('const meter = createF2Meter(')
  assert.ok(precheck > 0, '运行器没有调用写面预检')
  for (const [name, index] of [['createM4Harness', harness], ['createOpenAiTaskPlanner', planner], ['createF2Meter', meter]] as const) {
    assert.ok(index > 0, `找不到 ${name} 的装配点`)
    assert.ok(precheck < index, `写面预检没有先于 ${name} 执行（precheck=${String(precheck)} ${name}=${String(index)}）`)
  }
  return `precheck<harness<planner<meter（${String(precheck)}<${String(harness)}<${String(planner)}<${String(meter)}）`
})

await check('13', '闭集：两个新码必须在 `P3_5_GUARD_CODES` 里（不发明新码）', () => {
  const codes = new Set<string>(P3_5_GUARD_CODES)
  assert.ok(codes.has('ledger_unwritable'))
  assert.ok(codes.has('journal_unwritable'))
  return `closed-set=${String(P3_5_GUARD_CODES.length)} codes`
})

await check('14', '助手恰好各被引用一次（防"写了没用"或"用了两份实现"）', () => {
  for (const helper of ['buildP35PlannerEnv(', 'assertP35PlannerEndpoint(', 'decideP35TurnAnswer(', 'ensureP35WriteSurfaces(', 'buildP35AccountingEntry(']) {
    const occurrences = runnerSource.split(helper).length - 1
    assert.equal(occurrences, 1, `${helper} 在运行器里出现 ${String(occurrences)} 次（应为 1）`)
  }
  return '5 个助手各 1 处引用'
})

await check('15', '零真实网络自证：真 `fetch` 调用次数 = 0，假 transport 调用次数 > 0', () => {
  assert.equal(realFetchCalls, 0, `本门内发生了 ${String(realFetchCalls)} 次真网络调用`)
  assert.ok(fakeCalls.length > 0, '假 transport 一次都没被调用（检查 02 可能没有真跑）')
  return `realFetch=0 fakeFetch=${String(fakeCalls.length)}`
})

await check('16', '守卫实现不被"顺手放宽"：端点断言只看 host，不读凭据字段', () => {
  const start = guardsSource.indexOf('export function assertP35PlannerEndpoint')
  assert.ok(start > 0, '找不到 assertP35PlannerEndpoint 定义')
  const nextExport = guardsSource.indexOf('export function', start + 10)
  const body = guardsSource.slice(start, nextExport === -1 ? undefined : nextExport)
  assert.ok(body.includes('expectedHost'), '端点断言没有比较 expectedHost')
  assert.ok(!body.includes('.key'), '端点断言函数体里出现了凭据字段')
  return 'assertP35PlannerEndpoint 只看 host'
})

// ---------------------------------------------------------------------------
//  收尾
// ---------------------------------------------------------------------------
globalThis.fetch = realFetch
rmSync(tempRoot, { recursive: true, force: true })

const passed = checks.filter(row => row.pass).length
const failed = checks.length - passed
const elapsedMs = Date.now() - startedAt
for (const row of checks) {
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${row.id} ${row.title}${row.pass ? `（${row.detail}）` : `\n     ↳ ${row.detail}`}`)
}
console.log(`\nP3-5b 运行守卫零请求回归门：${String(passed)} PASS / ${String(failed)} FAIL / ${String(checks.length)} total（${String(elapsedMs)} ms）`)
process.exitCode = failed === 0 && checks.length > 0 ? 0 : 1
