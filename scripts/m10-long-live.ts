/**
 * M10 WP10 —— **长轨迹真实链**（`pnpm m10:long:live`）。**真模型档**（计划 §16.1）。
 *
 * ============================================================================
 *  它量什么、不量什么
 * ============================================================================
 * ```text
 * 量    ：**N 轮真实连续轨迹**（缺省 200）—— 每一轮都真的过
 *         语义理解（真模型）→ 严格校验 → 放行口 → 写 → 投影；
 *         收尾做一次 **丢缓存 + 重读 + rebuild**，断言**不变量 ②**（投影是派生的）。
 * 不量  ：模型答得对不对（那是 `m10:semantic:eval`）；
 *         也不量跨进程重启（那是离线 `m10:long:verify` 的事 —— 它不需要模型，跑得更快更稳）。
 * ```
 *
 * ============================================================================
 *  四条硬纪律
 * ============================================================================
 * ```text
 * ① **守卫：绝不回落生产 key**（缺 `DSH_TEST_MODEL_WRAPPER` 标记 ⇒ 拒跑 exit 2）。
 * ② **只断言结构不变量，不断言模型的选择**（同 `m10:smoke:live`）：
 *      `outcome` ∈ 闭集 · 写类 ⇒ 事件 +1 · 不写类 ⇒ 事件 +0 · `trace` 五个读数在场。
 * ③ ⭐ **不变量 ②（投影是派生的）**：`rebuild` 之后的状态必须与 rebuild 之前**逐字段一致**，
 *    且 `appliedEvents > 0` —— 否则"重建"两个字没有被真的验证。
 * ④ ⭐ **`measured_count > 0`**：整条轨迹里**至少要有一轮真的走到写路径**。
 * ```
 *
 * ⚠️ 零出网的兄弟是 `m10:long:verify`（200/500 轮 + 跨进程重启 + 复活 + 迟到 + 重复）。
 *    两者**各有归属**：那一条证"时间维度的边"，这一条证"真模型下的长轨迹"。
 *
 * ⚠️ `isolateDatabase()` 一次性沙箱库（顶部）—— **真实库从不被打开**（`C1` 直接断言路径）。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-long-live', { keep: false })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { buildGoalCorpus } from '../evals/m10/goal-corpus.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import { rebuildGoalProjections } from '../src/infrastructure/persistence/goal-store.ts'
import { createOpenAiGoalUnderstandingProvider } from '../src/infrastructure/model/openai-goal-understanding.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'
import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { createM10TurnHarness } from './m10-harness.ts'
import { createRealGoalUnderstandingRuntime } from '../src/infrastructure/goal/understanding-runtime.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6-command-surface.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_longlive' as CharacterId
const USER_ID = 'm10-long-live-user'
const M10_T0 = 2_600_000_000_000
const DEFAULT_TURNS = 200

function argOf(name: string): string | undefined {
  const hit = process.argv.find((item) => item.startsWith(`${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 1)
}
const TURNS = Number(argOf('--turns') ?? String(DEFAULT_TURNS))

if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error(
    `[m10-long-live] 拒绝：缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ ` +
      '本门只跑**测试端点**（`pnpm with-test-model pnpm m10:long:live`），**绝不回落** `.env` 的原 key',
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
  console.error(`[m10-long-live] ${mark}`)
}

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

/**
 * 话轮流：**从冻结语料的 test split 取**（确定性循环）。
 *
 * ⚠️ 刻意**不**去比金标 —— 连续轨迹里状态是自己长出来的，逐条金标在这里**没有意义**
 *    （那是 `m10:semantic:eval` 的活）。这里要的是"真实输入下的长轨迹"。
 */
const stream = buildGoalCorpus()
  .items.filter((item) => item.split === 'test')
  .map((item) => item.sourceText)
if (stream.length === 0) {
  console.error('[m10-long-live] 语料 test split 为空 ⇒ 没有话轮可用')
  process.exit(1)
}

phase('booting isolated database')
const agentRuntime = new AgentRuntime({ character, plugins: [] })
await initDatabase(agentRuntime, sqlPlugin)
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

const outcomes: Record<string, number> = {}
const failures: Record<string, number> = {}
const latenciesMs: number[] = []
let traceOkTurns = 0
let eventMismatchTurns = 0
let wroteTurns = 0
let noOperationWithFact = 0

phase(`running ${String(TURNS)} live turns against ${endpointHost}`)
for (let index = 0; index < TURNS; index += 1) {
  const input = stream[index % stream.length]!
  const beforeEvents = await harness.countEvents()
  const startedMs = Date.now()
  let outcome = 'THREW'
  let traceKeys = 0
  let hasFact = false
  try {
    const result = await harness.turn({
      currentInput: input,
      sourceEventId: `conv:m10-long-live-${String(index)}`,
      provider,
      now: M10_T0 + index * 1_000,
      runtime: createRealGoalUnderstandingRuntime(),
    })
    outcome = result.outcome
    traceKeys = Object.keys(result.trace).length
    hasFact = result.fact !== undefined
  } catch (error) {
    failures.threw = (failures.threw ?? 0) + 1
    phase(`turn ${String(index)} 抛错：${error instanceof Error ? error.message : String(error)}`)
  }
  latenciesMs.push(Date.now() - startedMs)
  const eventsDelta = (await harness.countEvents()) - beforeEvents
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  if (!CLOSED_OUTCOMES.has(outcome)) eventMismatchTurns += 1
  if (traceKeys === 5) traceOkTurns += 1
  if (outcome === 'no_operation' && hasFact) noOperationWithFact += 1
  const writes = WRITING_OUTCOMES.has(outcome)
  if (writes && eventsDelta < 1) eventMismatchTurns += 1
  if (!writes && eventsDelta !== 0) eventMismatchTurns += 1
  if (eventsDelta > 0) wroteTurns += 1
  if ((index + 1) % 25 === 0) {
    phase(`  … ${String(index + 1)}/${String(TURNS)} 轮（写路径命中 ${String(wroteTurns)}）`)
  }
}

/* ---------------------------------------------------------------------------
 * ⭐ 不变量 ②：丢缓存 + 重读 + rebuild ⇒ 逐字段一致
 * ------------------------------------------------------------------------- */
phase('rebuild: drop caches, reread, rebuild')
const beforeRebuild = JSON.stringify(await harness.listStates())
const rebuild = await rebuildGoalProjections(db, CHARACTER, M10_T0 + TURNS * 1_000 + 900_000)
const afterRebuild = JSON.stringify(await harness.listStates())
const rebuildIdentical = beforeRebuild === afterRebuild

/* ---------------------------------------------------------------------------
 * 判据
 * ------------------------------------------------------------------------- */
phase('checks')
record(
  'A',
  'A1',
  '**每轮的 `outcome` 都在闭集里**（未知取值说明链把结论说成了别的东西）',
  '0 轮出界',
  `${String(TURNS)} 轮 · 分布：${Object.entries(outcomes).map(([key, value]) => `${key}×${String(value)}`).join(' · ')}`,
  Object.keys(outcomes).every((key) => CLOSED_OUTCOMES.has(key)),
)
record(
  'A',
  'A2',
  '⭐ **"她说做了"与"真的写了"分开**（写类 ⇒ 事件 +1；不写类 ⇒ 事件 +0）**且 trace 五个读数在场**',
  '0 轮不一致 · 每轮 5 个',
  `事件/trace 不一致 ${String(eventMismatchTurns)} 轮 · trace 满 5 的有 ${String(traceOkTurns)}/${String(TURNS)} 轮`,
  eventMismatchTurns === 0 && traceOkTurns === TURNS,
)
record(
  'A',
  'A3',
  '⭐ **不变量 ②（投影是派生的）**：`rebuild` 之后状态与之前**逐字段一致**，且 `appliedEvents > 0`'
    + ' —— 否则"重建"两个字没有被真的验证',
  '逐字相同 · appliedEvents > 0',
  `逐字相同=${String(rebuildIdentical)} · 重放事件=${String(rebuild.appliedEvents)} · 行数=${String((await harness.countRows()).valueOf())}`,
  rebuildIdentical && rebuild.appliedEvents > 0,
)
record(
  'A',
  'A4',
  '⭐ **`measured_count > 0`**：整条轨迹里**至少有一轮真的走到写路径**',
  '≥1 轮写了事件',
  `写路径命中 ${String(wroteTurns)}/${String(TURNS)} 轮`,
  wroteTurns > 0,
)
record(
  'B',
  'B1',
  '**事实块纪律（`D29`）**：`outcome = no_operation` 的轮次**不许有**事实块',
  '0 轮违反',
  `${String(noOperationWithFact)} 轮违反`,
  noOperationWithFact === 0,
)
const sorted = [...latenciesMs].sort((a, b) => a - b)
record(
  'B',
  'B2',
  '**时延分布在场**（长轨迹的延迟预算是可读的）',
  '样本 > 0',
  `样本 ${String(sorted.length)} · min=${String(sorted[0] ?? 'N/A')}ms` +
    ` · mean=${String(sorted.length === 0 ? 'N/A' : Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length))}ms` +
    ` · max=${String(sorted[sorted.length - 1] ?? 'N/A')}ms`,
  sorted.length > 0,
)
const dataDir = process.env.PGLITE_DATA_DIR ?? ''
record(
  'C',
  'C1',
  '**真实库从不被打开**：库路径必须落在临时目录下（断言的是**路径**，不是"我记得调了它"）',
  '库路径在 %TEMP% 下',
  dataDir === '' ? '**PGLITE_DATA_DIR 为空**' : dataDir,
  dataDir !== '' && resolve(dataDir).startsWith(resolve(tmpdir())),
)
record(
  'C',
  'C2',
  '**跑在测试端点上**（守卫标记在场；本门**绝不**回落 `.env` 的原 key）',
  `${TEST_MODEL_WRAPPER_MARKER} = 1`,
  `标记在场 · endpoint=${endpointHost}`,
  process.env[TEST_MODEL_WRAPPER_MARKER] === '1',
)

const passed = checks.filter((check) => check.pass).length
const failedChecks = checks.length - passed
const verdict: 'PASS' | 'FAIL' = failedChecks === 0 ? 'PASS' : 'FAIL'

/* ---------------------------------------------------------------------------
 * 落盘
 * ------------------------------------------------------------------------- */
phase('done')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM10RunId({ wpId: 'wp10-longlive', headShort: head })
const dir = openM10RunDir(REPO_ROOT, runId)
const payload = {
  schema: 'm10-long-live@1',
  runId,
  head,
  semanticClaim: 'real_model' as const,
  model: { endpointHost, model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(缺省)' },
  turns: TURNS,
  outcomes,
  failures,
  wroteTurns,
  traceOkTurns,
  eventMismatchTurns,
  noOperationWithFact,
  rebuild: { identical: rebuildIdentical, appliedEvents: rebuild.appliedEvents },
  latency: {
    samples: sorted.length,
    min: sorted[0] ?? null,
    mean: sorted.length === 0 ? null : Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    max: sorted[sorted.length - 1] ?? null,
  },
  checks,
  summary: { total: checks.length, passed, failed: failedChecks, verdict },
}
try {
  writeFileSync(join(dir, 'long-live.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp10-longlive',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'long-live',
    counts: { total: checks.length, passed, failed: failedChecks },
    phases: ['guard', 'boot', 'turns', 'rebuild', 'checks'],
    supersedes: null,
    notes:
      `真模型长轨迹（${String(TURNS)} 轮）· 写路径命中 ${String(wroteTurns)} 轮 · ` +
      `rebuild 逐字相同=${String(rebuildIdentical)}（重放 ${String(rebuild.appliedEvents)} 事件）· ` +
      `时延 mean=${String(payload.latency.mean)}ms max=${String(payload.latency.max)}ms`,
  })
} catch (error) {
  try {
    const { rmSync } = await import('node:fs')
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 删不掉也要把原因印出来 */
  }
  console.error(`[m10-long-live] 证据写入失败 ⇒ 已删除半成品目录：${String(error)}`)
  process.exit(1)
}

for (const check of checks) {
  console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label.slice(0, 88)}`)
  console.log(`        期望 ${check.expected} · 实测 ${check.actual}`)
}
console.log(
  `\nverdict: ${verdict}（断言 ${String(passed)}/${String(checks.length)}）` +
    `\n  ${String(TURNS)} 轮 · 写路径命中 ${String(wroteTurns)} · rebuild 逐字相同=${String(rebuildIdentical)}` +
    `\n  时延 min/mean/max=${String(payload.latency.min)}/${String(payload.latency.mean)}/${String(payload.latency.max)}ms`,
)
console.log(`证据：${join(dir, 'long-live.json')}`)
if (verdict === 'FAIL') process.exitCode = 1
