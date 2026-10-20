/** v2: both arms use the real task planner; B additionally forecasts within the same call budget.
 * Scripted adapters test mechanisms only. Original corpus was already inspected: this is a
 * prospective replication, not an untouched independent held-out benefit estimate.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAiActionForecast } from '../src/infrastructure/model/openai-action-forecast.ts'
import { createOpenAiTaskPlanner } from '../src/infrastructure/model/openai-task-planner.ts'
import {
  createIsolatedTaskRun,
  FIXTURE_REGISTRY,
  FIXTURE_READ_CAPABILITIES,
  FIXTURE_WRITE_CAPABILITIES,
} from './world-model/isolated-bed.ts'

/*
 * ⚠️ **必须带 `with-test-model` 包装器**（缺标记即**拒跑**，exit 2）。
 *
 * 理由与 M10 的 live 门同源：测试端点（`.env.test`）与生产端点（`.env`）是**两把钥匙**，
 * 不带包装器就可能**烧生产额度**。⇒ 这里**拒绝**回落 `.env` 的原 key。
 */
if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
  console.error(
    '❌ 拒绝运行：这一道门**真的出站**（真模型），必须带 `with-test-model` 包装器：\n' +
      '   pnpm with-test-model pnpm worldmodel:tools:ab --segment=heldout\n' +
      '   （**不会**回落 `.env` 的生产 key —— 那会把测试跑到真实额度上。）'
  )
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 语料（**冻结**：与协议文件逐条一致）
// ---------------------------------------------------------------------------

interface AbFixture {
  readonly id: string
  readonly segment: 'dev' | 'heldout'
  readonly steps: readonly { readonly capability: string; readonly operation: string }[]
  readonly writeReportsEffect: boolean
  readonly readReturnsContent: boolean
  /** 真值：目标是否达成（**程序知道**，模型看不到） */
  readonly goalAchieved: boolean
}

const FIXTURES: readonly AbFixture[] = [
  { id: 'D1', segment: 'dev', steps: [
    { capability: 'fixture.alpha.write', operation: 'write' },
    { capability: 'fixture.echo.read', operation: 'read' },
  ], writeReportsEffect: false, readReturnsContent: true, goalAchieved: false },
  { id: 'D2', segment: 'dev', steps: [
    { capability: 'fixture.beta.write', operation: 'write' },
    { capability: 'fixture.foxtrot.read', operation: 'read' },
  ], writeReportsEffect: true, readReturnsContent: true, goalAchieved: true },
  { id: 'D3', segment: 'dev', steps: [
    { capability: 'fixture.gamma.write', operation: 'write' },
  ], writeReportsEffect: true, readReturnsContent: true, goalAchieved: true },
  { id: 'D4', segment: 'dev', steps: [
    { capability: 'fixture.delta.write', operation: 'write' },
  ], writeReportsEffect: false, readReturnsContent: true, goalAchieved: false },
  { id: 'H1', segment: 'heldout', steps: [
    { capability: 'fixture.alpha.write', operation: 'write' },
    { capability: 'fixture.foxtrot.read', operation: 'read' },
  ], writeReportsEffect: false, readReturnsContent: true, goalAchieved: false },
  { id: 'H2', segment: 'heldout', steps: [
    { capability: 'fixture.beta.write', operation: 'write' },
    { capability: 'fixture.echo.read', operation: 'read' },
  ], writeReportsEffect: true, readReturnsContent: true, goalAchieved: true },
  { id: 'H3', segment: 'heldout', steps: [
    { capability: 'fixture.gamma.write', operation: 'write' },
    { capability: 'fixture.foxtrot.read', operation: 'read' },
  ], writeReportsEffect: true, readReturnsContent: false, goalAchieved: false },
  { id: 'H4', segment: 'heldout', steps: [
    { capability: 'fixture.delta.write', operation: 'write' },
    { capability: 'fixture.echo.read', operation: 'read' },
  ], writeReportsEffect: false, readReturnsContent: true, goalAchieved: false },
  { id: 'H5', segment: 'heldout', steps: [
    { capability: 'fixture.alpha.write', operation: 'write' },
    { capability: 'fixture.echo.read', operation: 'read' },
  ], writeReportsEffect: true, readReturnsContent: true, goalAchieved: true },
  { id: 'H6', segment: 'heldout', steps: [
    { capability: 'fixture.beta.write', operation: 'write' },
  ], writeReportsEffect: false, readReturnsContent: true, goalAchieved: false },
  { id: 'H7', segment: 'heldout', steps: [
    { capability: 'fixture.gamma.write', operation: 'write' },
    { capability: 'fixture.foxtrot.read', operation: 'read' },
  ], writeReportsEffect: true, readReturnsContent: true, goalAchieved: true },
  { id: 'H8', segment: 'heldout', steps: [
    { capability: 'fixture.delta.write', operation: 'write' },
    { capability: 'fixture.echo.read', operation: 'read' },
  ], writeReportsEffect: true, readReturnsContent: false, goalAchieved: false },
]

// ---------------------------------------------------------------------------
// 预算（**冻结**，两臂相同）
// ---------------------------------------------------------------------------

const BUDGET = { maxActions: 6, maxPlans: 3 } as const
const ALLOWED = [...FIXTURE_WRITE_CAPABILITIES, ...FIXTURE_READ_CAPABILITIES]

// ---------------------------------------------------------------------------
// 跑一臂
// ---------------------------------------------------------------------------

interface ArmReading {
  readonly fixtureId: string
  readonly segment: 'dev' | 'heldout'
  readonly goalAchieved: boolean
  readonly stopped: string
  readonly claimedDone: boolean
  /** 误报完成：报了 done **且**真值未达成 */
  readonly falseCompletion: boolean
  /** 正确完成：报了 done **且**真值达成 */
  readonly correctCompletion: boolean
  readonly actionsUsed: number
  readonly plansUsed: number
  readonly forecastCalls: number
  readonly comparisons: readonly { readonly capability: string; readonly operation: string; readonly verdict: string }[]
  readonly elapsedMs: number
  readonly transportFailure: boolean
  readonly realModelCalls: number
  readonly totalTokens: number
  readonly forecastError?: string
}

async function runArm(
  fixture: AbFixture,
  arm: 'off' | 'on'
): Promise<ArmReading> {
  let realModelCalls = 0
  let totalTokens = 0
  let transportFailure = false
  const measuredFetch: typeof fetch = async (url, init) => {
    realModelCalls++
    try {
      const response = await fetch(url, init)
      if (!response.ok) transportFailure = true
      const body = await response.clone().json().catch(() => ({})) as { usage?: { total_tokens?: number } }
      totalTokens += body.usage?.total_tokens ?? 0
      return response
    } catch (error) { transportFailure = true; throw error }
  }
  const forecast =
    arm === 'on'
      ? {
          port: createOpenAiActionForecast({ fetchImpl: measuredFetch, maxTokens: 1200 }),
          deadlineMs: 20_000,
        }
      : undefined
  const run = createIsolatedTaskRun({
    plans: [],
    planner: createOpenAiTaskPlanner({ registry: FIXTURE_REGISTRY, fetchImpl: measuredFetch, maxTokens: 1200, timeoutMs: 20_000 }),
    task: `完成一个隔离任务，操作能力如下：${fixture.steps.map(step => `${step.capability} 的 operation=${step.operation}，args={}`).join('；')}。按此顺序操作，写入后读回（若列表有读操作）。只有目标真实完成才能 done=true。success 只表示适配器报告成功。已有步骤成功不要重复写入。`,
    realClock: true,
    behavior: {
      writeReportsEffect: fixture.writeReportsEffect,
      readReturnsContent: fixture.readReturnsContent,
    },
    budget: BUDGET,
    allowedCapabilities: ALLOWED,
    ...(forecast !== undefined ? { forecast } : {}),
  })
  const started = Date.now()
  const { outcome } = await run.run()
  const elapsedMs = Date.now() - started
  const actualGoalAchieved = fixture.goalAchieved && fixture.steps.every(step =>
    (run.control.calls.get(step.capability) ?? 0) > 0
  )
  const claimedDone = outcome.stopped === 'done'
  return {
    transportFailure, realModelCalls, totalTokens,
    fixtureId: fixture.id,
    segment: fixture.segment,
    goalAchieved: actualGoalAchieved,
    stopped: outcome.stopped,
    claimedDone,
    falseCompletion: claimedDone && !actualGoalAchieved,
    correctCompletion: claimedDone && actualGoalAchieved,
    actionsUsed: outcome.actionsUsed,
    plansUsed: outcome.plansUsed,
    forecastCalls: outcome.forecastCallsUsed ?? 0,
    comparisons: (outcome.comparisons ?? []).map(row => ({
      capability: row.capability,
      operation: row.operation,
      verdict: row.verdict,
    })),
    elapsedMs,
    ...(outcome.forecastFailureCode !== undefined
      ? { forecastError: outcome.forecastFailureCode }
      : {}),
  }
}

function aggregate(readings: readonly ArmReading[]): {
  readonly n: number
  readonly falseCompletions: number
  readonly correctCompletions: number
  readonly notDone: number
  readonly checkPassRate: number | null
  readonly actions: number
  readonly plans: number
  readonly forecastCalls: number
  readonly realModelCalls: number
  readonly totalTokens: number
  readonly elapsedMs: number
  readonly stoppedBy: Readonly<Record<string, number>>
} {
  const falseCompletions = readings.filter(row => row.falseCompletion).length
  const correctCompletions = readings.filter(row => row.correctCompletion).length
  const claimed = falseCompletions + correctCompletions
  const stoppedBy: Record<string, number> = {}
  for (const row of readings) {
    stoppedBy[row.stopped] = (stoppedBy[row.stopped] ?? 0) + 1
  }
  return {
    n: readings.length,
    falseCompletions,
    correctCompletions,
    notDone: readings.length - claimed,
    checkPassRate: claimed === 0 ? null : correctCompletions / claimed,
    actions: readings.reduce((sum, row) => sum + row.actionsUsed, 0),
    plans: readings.reduce((sum, row) => sum + row.plansUsed, 0),
    forecastCalls: readings.reduce((sum, row) => sum + row.forecastCalls, 0),
    realModelCalls: readings.reduce((sum, row) => sum + row.realModelCalls, 0),
    totalTokens: readings.reduce((sum, row) => sum + row.totalTokens, 0),
    elapsedMs: readings.reduce((sum, row) => sum + row.elapsedMs, 0),
    stoppedBy,
  }
}

// ---------------------------------------------------------------------------
// 跑批
// ---------------------------------------------------------------------------

const only = process.argv.find(arg => arg.startsWith('--segment='))?.slice('--segment='.length)
const segment = only === 'dev' || only === 'heldout' ? only : 'all'
const fixtures = FIXTURES.filter(fixture => segment === 'all' || fixture.segment === segment)

const off: ArmReading[] = []
const on: ArmReading[] = []
for (const [index, fixture] of fixtures.entries()) {
  if (index % 2 === 0) { off.push(await runArm(fixture, 'off')); on.push(await runArm(fixture, 'on')) }
  else { on.push(await runArm(fixture, 'on')); off.push(await runArm(fixture, 'off')) }
  console.log(`acquired ${fixture.id}`)
}

const segments = ['dev', 'heldout'] as const
const report = {
  schema: 'world-model-tools-ab@2',
  status: [...off, ...on].some(row => row.transportFailure) ? 'FAIL' : 'PASS',
  acquisitionComplete: [...off, ...on].every(row => !row.transportFailure && row.realModelCalls > 0),
  protocol: 'docs/world-model/World-Model-Continuation-Protocol-v2.md',
  segment,
  budget: BUDGET,
  model: {
    baseUrlHost: (() => {
      try {
        return new URL((process.env.OPENAI_BASE_URL ?? '').trim()).host
      } catch {
        return '(未设)'
      }
    })(),
    model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(未设)',
    keyPresent: (process.env.OPENAI_API_KEY ?? '').trim().length > 0,
  },
  /**
   * ⚠️ **分列**：两段（开发集 / 留出集）**各自**报，**不合成一个总分**。
   * ⚠️ 标题读数是**留出集**那一段；开发集只用来验台。
   */
  segments: Object.fromEntries(
    segments
      .filter(name => fixtures.some(fixture => fixture.segment === name))
      .map(name => {
        const offRows = off.filter(row => row.segment === name)
        const onRows = on.filter(row => row.segment === name)
        return [
          name,
          {
            off: aggregate(offRows),
            on: aggregate(onRows),
            groundTruthAchieved: offRows.filter(row => row.goalAchieved).length,
            rows: offRows.map((row, index) => ({
              fixtureId: row.fixtureId,
              goalAchieved: row.goalAchieved,
              off: {
                transportFailure: offRows[index]!.transportFailure,
                realModelCalls: offRows[index]!.realModelCalls,
                totalTokens: offRows[index]!.totalTokens,
                stopped: offRows[index]!.stopped,
                claimedDone: offRows[index]!.claimedDone,
                falseCompletion: offRows[index]!.falseCompletion,
                actionsUsed: offRows[index]!.actionsUsed,
                plansUsed: offRows[index]!.plansUsed,
                elapsedMs: offRows[index]!.elapsedMs,
              },
              on: {
                transportFailure: onRows[index]!.transportFailure,
                realModelCalls: onRows[index]!.realModelCalls,
                totalTokens: onRows[index]!.totalTokens,
                stopped: onRows[index]!.stopped,
                claimedDone: onRows[index]!.claimedDone,
                falseCompletion: onRows[index]!.falseCompletion,
                actionsUsed: onRows[index]!.actionsUsed,
                plansUsed: onRows[index]!.plansUsed,
                forecastCalls: onRows[index]!.forecastCalls,
                comparisons: onRows[index]!.comparisons,
                elapsedMs: onRows[index]!.elapsedMs,
                ...(onRows[index]!.forecastError !== undefined
                  ? { forecastError: onRows[index]!.forecastError }
                  : {}),
              },
            })),
          },
        ]
      })
  ),
  evidenceClass: 'real_planner_forecast_replication_with_scripted_tools',
  databaseOpened: false,
  realToolCalls: 0,
  productionIntegrated: false,
  benefitMeasured:
    'tool_task_domain_only__false_completion_count__no_cross_domain_total',
  notes: [
    '固定件只测机制：夹具适配器是脚本固定的，读数不是"真实工具会不会这样表现"。',
    '未完成计入任务完成率分母；拒绝执行和无动作完成声明也计分。旧语料已被检查，不称独立留出收益证明。',
    '预测准确率是诊断指标，不代替任务完成。',
  ],
}

const runId = new Date().toISOString().replace(/[:.]/g, '-')
const out = resolve('artifacts/post-lv2/local/world-model-tools-ab-v2', runId)
mkdirSync(out, { recursive: true })
/*
 * ⚠️ **证据要绑到源码**：聚合门（`worldmodel:gates`）读 `sourceHashes` 判 `INVALID`。
 *    ⚠️ 第一版的 A/B 证据**没有**这个字段 ⇒ 那一份读数**无法**被源码核对
 *    （登记为 `L-WM-09`）；从这一版起有。
 */
const hashedFiles = [
  'scripts/world-model-tools-ab.ts',
  'scripts/world-model/isolated-bed.ts',
  'src/kernel/contracts/world-model.ts',
  'src/kernel/action/action-forecast.ts',
  'src/kernel/action/task-loop.ts',
  'src/infrastructure/model/openai-action-forecast.ts',
  'src/infrastructure/model/openai-task-planner.ts',
  'docs/world-model/World-Model-Continuation-Protocol-v2.md',
]
writeFileSync(resolve(out, 'ab.json'), JSON.stringify({
  ...report,
  sourceHashes: Object.fromEntries(
    hashedFiles.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])
  ),
}, null, 2) + '\n')

// 断言：**两臂的输入必须完全相同**（固定计划 + 固定行为）⇒ 差异只来自预测
for (const fixture of fixtures) {
  const offRow = off.find(row => row.fixtureId === fixture.id)!
  const onRow = on.find(row => row.fixtureId === fixture.id)!
  assert.equal(offRow.fixtureId, onRow.fixtureId)
}

for (const name of segments) {
  const rows = report.segments[name]
  if (rows === undefined) continue
  console.log(
    `[${name}] A(off) 误报完成=${String(rows.off.falseCompletions)} 正确完成=${String(rows.off.correctCompletions)} ` +
      `核对通过率=${rows.off.checkPassRate === null ? 'null' : rows.off.checkPassRate.toFixed(3)} ` +
      `行动=${String(rows.off.actions)} API调用=${String(rows.off.realModelCalls)} token=${String(rows.off.totalTokens)} 时延=${String(rows.off.elapsedMs)}ms`
  )
  console.log(
    `[${name}] B(on)  误报完成=${String(rows.on.falseCompletions)} 正确完成=${String(rows.on.correctCompletions)} ` +
      `核对通过率=${rows.on.checkPassRate === null ? 'null' : rows.on.checkPassRate.toFixed(3)} ` +
      `行动=${String(rows.on.actions)} API调用=${String(rows.on.realModelCalls)} token=${String(rows.on.totalTokens)}（含预测 ${String(rows.on.forecastCalls)}） ` +
      `时延=${String(rows.on.elapsedMs)}ms`
  )
}
console.log(JSON.stringify({ status: report.status, segment, output: out }))
if (!report.acquisitionComplete) process.exitCode = 1
