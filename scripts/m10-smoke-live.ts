/**
 * M10 WP10 —— **小批真实链**（`pnpm m10:smoke:live`）。**真模型档**（计划 §16.1）。
 *
 * ============================================================================
 *  它量什么、不量什么
 * ============================================================================
 * ```text
 * 量    ：**目标域这条链在真模型下能不能跑通** —— 一条**有状态的脚本轨迹**
 *         （建目标 → 问清单 → 无关话 → 报完成 → 取消 → 再建 → 暂停），
 *         每一轮都真的过：语义理解（真模型）→ 严格校验 → 放行口 → 写 → 投影。
 * 不量  ：**模型答得对不对**（那是 `m10:semantic:eval` 的逐案读数）；
 *         也不量回复正文（那是 M3/M5 的 live 门）。
 * ```
 *
 * ============================================================================
 *  三条硬纪律
 * ============================================================================
 * ```text
 * ① **守卫：绝不回落生产 key**（缺 `DSH_TEST_MODEL_WRAPPER` 标记 ⇒ 拒跑 exit 2）。
 * ② **只断言结构不变量，不断言模型的选择**：
 *      · `outcome` ∈ 闭集
 *      · **写类 outcome ⇒ 事件 +1**；**不写类 ⇒ 事件 +0**（这条把"她说做了"与"真的写了"分开）
 *      · `trace` 五个读数在场
 *    ⚠️ 断言"模型一定会建目标"会让这道门**看运气**（且那是"为绿而抽样"的近亲）。
 * ③ ⭐ **`measured_count > 0`**：整条轨迹里**至少要有一轮真的走到写路径**
 *    —— 否则"链跑通了"这句话**没覆盖写入**，那种读数不该报 PASS。
 * ```
 *
 * ⚠️ `isolateDatabase()` 一次性沙箱库（顶部）—— **真实库从不被打开**（另有机器判据）。
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-smoke-live', { keep: false })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'




import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import { createOpenAiGoalUnderstandingProvider } from '../src/infrastructure/model/openai-goal-understanding.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'
import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { createM10TurnHarness } from './m10-harness.ts'
import { createRealGoalUnderstandingRuntime } from '../src/infrastructure/goal/understanding-runtime.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6-command-surface.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_smokelive' as CharacterId
const USER_ID = 'm10-smoke-live-user'
const M10_T0 = 2_500_000_000_000

/* ---------------------------------------------------------------------------
 * 守卫（纪律 ①）
 * ------------------------------------------------------------------------- */
if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error(
    `[m10-smoke-live] 拒绝：缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ ` +
      '本门只跑**测试端点**（`pnpm with-test-model pnpm m10:smoke:live`），**绝不回落** `.env` 的原 key',
  )
  process.exit(2)
}

interface Check {
  group: 'A' | 'B' | 'C'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group, id, label, expected, actual, pass })
}
function phase(mark: string): void {
  console.error(`[m10-smoke-live] ${mark}`)
}

/**
 * 脚本轨迹（**有状态**：后面的轮次依赖前面写下的目标 ⇒ 候选来自**真库**而不是手工给）。
 *
 * ⚠️ 每一条都是"目标域的真实输入"，覆盖五态里的几种：写 / 问 / 不写 / 完成 / 取消 / 暂停。
 */
const SCRIPT: readonly { readonly input: string; readonly writes: boolean; readonly what: string }[] = [
  { input: '把写完论文提纲设成我们接下来的目标', writes: true, what: '建目标' },
  { input: '我们都有哪些目标来着', writes: false, what: '问清单（不写）' },
  { input: '今天天气怎么样', writes: false, what: '无关话（不写、且**不产事实块**）' },
  { input: '我写完提纲了', writes: true, what: '报完成' },
  { input: '这个目标取消吧', writes: true, what: '取消' },
  { input: '记一下，我的目标是投论文', writes: true, what: '再建一个目标' },
  { input: '论文的事先暂停', writes: true, what: '暂停' },
]

const WRITING_OUTCOMES = new Set(['accepted', 'rejected', 'commit_failed'])
const CLOSED_OUTCOMES = new Set([
  'no_operation',
  'query',
  'clarify',
  'accepted',
  'rejected',
  'invalid_output',
  'transport_failed',
  'source_unusable',
  'not_invoked',
  'commit_failed',
])

/* ---------------------------------------------------------------------------
 * 跑
 * ------------------------------------------------------------------------- */
phase('booting isolated database')
const agentRuntime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await initDatabase(agentRuntime)
const db = getRawDb(agentRuntime)
const harness = createM10TurnHarness({ db, characterId: CHARACTER, userId: USER_ID })
const provider = createOpenAiGoalUnderstandingProvider()

const endpointHost = ((): string => {
  try {
    return new URL(process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com').host
  } catch {
    return '(无法解析)'
  }
})()

interface TurnReading {
  readonly index: number
  readonly input: string
  readonly what: string
  readonly writes: boolean
  readonly outcome: string
  readonly eventsDelta: number
  readonly rowsDelta: number
  readonly traceKeys: readonly string[]
  /** ⚠️ 只记**有没有**事实块（`GoalFactView` 的字段形状与本门无关） */
  readonly hasFact: boolean
  readonly latencyMs: number
}
const turns: TurnReading[] = []

phase(`running ${String(SCRIPT.length)} scripted turns against ${endpointHost}`)
for (const [index, step] of SCRIPT.entries()) {
  const beforeEvents = await harness.countEvents()
  const beforeRows = await harness.countRows()
  const startedMs = Date.now()
  let outcome = 'THREW'
  let traceKeys: readonly string[] = []
  let hasFact = false
  try {
    const result = await harness.turn({
      currentInput: step.input,
      sourceEventId: `conv:m10-smoke-live-${String(index)}`,
      provider,
      now: M10_T0 + index * 1_000,
      runtime: createRealGoalUnderstandingRuntime(),
    })
    outcome = result.outcome
    traceKeys = Object.keys(result.trace)
    hasFact = result.fact !== undefined
  } catch (error) {
    phase(`turn ${String(index)} 抛错：${error instanceof Error ? error.message : String(error)}`)
  }
  const latencyMs = Date.now() - startedMs
  const eventsDelta = (await harness.countEvents()) - beforeEvents
  const rowsDelta = (await harness.countRows()) - beforeRows
  turns.push({
    index,
    input: step.input,
    what: step.what,
    writes: step.writes,
    outcome,
    eventsDelta,
    rowsDelta,
    traceKeys,
    hasFact,
    latencyMs,
  })
  console.log(
    `  · ${String(index + 1)}. ${step.what}：「${step.input}」⇒ ${outcome}` +
      `（事件 +${String(eventsDelta)} · 行 +${String(rowsDelta)} · trace ${String(traceKeys.length)} · ${String(latencyMs)}ms）`,
  )
}

/* ---------------------------------------------------------------------------
 * 判据（只断结构不变量）
 * ------------------------------------------------------------------------- */
phase('checks')
const outsideClosed = turns.filter((turn) => !CLOSED_OUTCOMES.has(turn.outcome))
record(
  'A',
  'A1',
  '**每轮的 `outcome` 都在闭集里**（未知取值说明链把结论说成了别的东西）',
  '0 轮出界',
  `${String(turns.length)} 轮 · 出界 ${String(outsideClosed.length)}` +
    `${outsideClosed.length > 0 ? `：${outsideClosed.map((turn) => `${String(turn.index)}→${turn.outcome}`).join(', ')}` : ''}`,
  outsideClosed.length === 0 && turns.length > 0,
)

const eventMismatch = turns.filter((turn) => {
  const writes = WRITING_OUTCOMES.has(turn.outcome)
  return writes ? turn.eventsDelta < 1 : turn.eventsDelta !== 0
})
record(
  'A',
  'A2',
  '⭐ **"她说做了"与"真的写了"分开**：写类 outcome ⇒ 事件 **+1**；不写类 ⇒ 事件 **+0**'
    + '（这条把回复口吻与领域事件解耦，是本仓库的硬性质之一）',
  '0 轮不一致',
  `${String(turns.length)} 轮 · 不一致 ${String(eventMismatch.length)}` +
    `${eventMismatch.length > 0 ? `：${eventMismatch.map((turn) => `${String(turn.index)}(${turn.outcome}→+${String(turn.eventsDelta)})`).join(', ')}` : ''}`,
  eventMismatch.length === 0,
)

const shortTrace = turns.filter((turn) => turn.traceKeys.length !== 5)
record(
  'A',
  'A3',
  '**`trace` 五个读数在场**（理解 / 校验 / 放行 / 写 / 投影）',
  '每轮 5 个',
  `5 个的有 ${String(turns.length - shortTrace.length)}/${String(turns.length)} 轮`,
  shortTrace.length === 0,
)

const wroteAny = turns.some((turn) => WRITING_OUTCOMES.has(turn.outcome) && turn.eventsDelta > 0)
record(
  'A',
  'A4',
  '⭐ **`measured_count > 0`**：整条轨迹里**至少有一轮真的走到写路径**'
    + ' —— 否则"链跑通了"没覆盖写入，那种读数**不该报 PASS**',
  '≥1 轮写了事件',
  `写了事件的轮次：${turns.filter((turn) => turn.eventsDelta > 0).map((turn) => String(turn.index + 1)).join(', ') || '（无）'}`,
  wroteAny,
)

/*
 * ⚠️ **第一版这条判据写错了**（实测当场红）：我把"不写类"当成了"没有事实块"，
 *    而 `D29` 的原话是「**无操作时**为 `undefined`」—— "无操作"是**具名 outcome
 *    `no_operation`**；`query` / `clarify` **按设计就带事实块**（它们是有话要说的结论）。
 * ⇒ 判据改成两条：`no_operation` ⇒ **不许有**事实块；且**至少有一轮真的带了**
 *    （否则"事实块这条路"根本没被这次读数覆盖 ⇒ 不该报 PASS）。
 */
const noOperationWithFact = turns.filter((turn) => turn.outcome === 'no_operation' && turn.hasFact)
record(
  'B',
  'B1',
  '**事实块纪律（`D29`）**：`outcome = no_operation` 的轮次**不许有**事实块'
    + '（"没操作"不是"一次没写成的操作"）；`query` / `clarify` **按设计带**事实块',
  '0 轮违反',
  `no_operation 轮次：${turns.filter((turn) => turn.outcome === 'no_operation').map((turn) => `${String(turn.index + 1)}:${turn.hasFact ? '**有**' : '（无）'}`).join(' · ') || '（无）'}`,
  noOperationWithFact.length === 0,
)
const withFact = turns.filter((turn) => turn.hasFact)
record(
  'B',
  'B2',
  '⭐ **`measured_count > 0`（事实块那条路）**：至少有一轮**真的产出了事实块**'
    + ' —— 否则"事实块纪律通过"是**空过**（0 个样本的合规与"没有检查"在输出上长得一样）',
  '≥1 轮带事实块',
  `带事实块的轮次：${withFact.map((turn) => `${String(turn.index + 1)}(${turn.outcome})`).join(', ') || '（无）'}`,
  withFact.length > 0,
)

/* ⚠️ **真库没被打开**：本门在**沙箱**里跑 —— 直接断言库路径在临时目录下（不靠"我记得调了 isolate"） */
const dataDir = process.env.PGLITE_DATA_DIR ?? ''
const underTmp = dataDir !== '' && resolve(dataDir).startsWith(resolve(tmpdir()))
record(
  'C',
  'C1',
  '**真实库从不被打开**：库路径必须落在临时目录下（`isolateDatabase()` 的一次性沙箱）'
    + ' —— 断言的是**路径**，不是"我记得调了它"',
  '库路径在 %TEMP% 下',
  dataDir === '' ? '**PGLITE_DATA_DIR 为空**' : dataDir,
  underTmp,
)
record(
  'C',
  'C2',
  '**跑在测试端点上**（守卫标记在场；本门**绝不**回落 `.env` 的原 key）',
  `${TEST_MODEL_WRAPPER_MARKER} = 1`,
  `标记在场 · endpoint=${endpointHost}`,
  process.env[TEST_MODEL_WRAPPER_MARKER] === '1',
)

const latencies = turns.map((turn) => turn.latencyMs).sort((a, b) => a - b)
const passed = checks.filter((check) => check.pass).length
const failedChecks = checks.length - passed
const verdict: 'PASS' | 'FAIL' = failedChecks === 0 ? 'PASS' : 'FAIL'

/* ---------------------------------------------------------------------------
 * 落盘
 * ------------------------------------------------------------------------- */
phase('done')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM10RunId({ wpId: 'wp10-smokelive', headShort: head })
const dir = openM10RunDir(REPO_ROOT, runId)

const payload = {
  schema: 'm10-smoke-live@1',
  runId,
  head,
  semanticClaim: 'real_model' as const,
  model: { endpointHost, model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(缺省)' },
  turns,
  latency: {
    samples: latencies.length,
    min: latencies[0] ?? null,
    max: latencies[latencies.length - 1] ?? null,
    mean:
      latencies.length === 0 ? null : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
  },
  checks,
  summary: { total: checks.length, passed, failed: failedChecks, verdict },
}
try {
  writeFileSync(join(dir, 'smoke-live.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp10-smokelive',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'smoke-live',
    counts: { total: checks.length, passed, failed: failedChecks },
    phases: ['guard', 'boot', 'turns', 'checks'],
    supersedes: null,
    notes:
      `真模型小批真实链（${String(turns.length)} 轮脚本轨迹）· ` +
      `写路径命中 ${String(turns.filter((turn) => turn.eventsDelta > 0).length)} 轮 · ` +
      `时延 mean=${String(payload.latency.mean)}ms max=${String(payload.latency.max)}ms`,
  })
} catch (error) {
  try {
    const { rmSync } = await import('node:fs')
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 删不掉也要把原因印出来 */
  }
  console.error(`[m10-smoke-live] 证据写入失败 ⇒ 已删除半成品目录：${String(error)}`)
  process.exit(1)
}

for (const check of checks) {
  console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label.slice(0, 90)}`)
  console.log(`        期望 ${check.expected} · 实测 ${check.actual}`)
}
console.log(
  `\nverdict: ${verdict}（断言 ${String(passed)}/${String(checks.length)}）` +
    `\n  脚本轨迹 ${String(turns.length)} 轮 · 写路径命中 ${String(turns.filter((turn) => turn.eventsDelta > 0).length)} 轮` +
    `\n  时延 min/mean/max=${String(payload.latency.min)}/${String(payload.latency.mean)}/${String(payload.latency.max)}ms`,
)
console.log(`证据：${join(dir, 'smoke-live.json')}`)
if (verdict === 'FAIL') process.exitCode = 1
