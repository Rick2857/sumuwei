/**
 * 三域应用方案 §2 —— **行动预测**的隔离门（阶段 1 的机械面）。
 *
 * ============================================================================
 *  它测什么、不测什么
 * ============================================================================
 * ```text
 * 测：真 `runTask` + 真 `ActionGateway` + 真账本接口的**隔离链路**上，
 *      预测契约的**失败关闭**与**行为分叉**是否成立。
 * 不测：**收益**。
 *      这里的预测器与规划器都是**脚本固定件** ⇒ 它测的是"机制"，
 *      不是"真实模型会不会预测得更准"（§6："固定件只测机制"）。
 * ```
 *
 * ⚠️ 真实模型档与真人体验是**另一件事**（阶段 4），本门**不**声称任何收益。
 * ⚠️ 全程**不碰生产库**、**不发出站**、**不调模型**。
 *
 * ============================================================================
 *  门清单（每条都是正控或负控）
 * ============================================================================
 *  1. 关闭时**逐字相同**：不配预测 ⇒ 返回值里**根本没有**预测相关键。
 *  2. 预测**不授权**：预测里点名一个未授权能力 ⇒ 它**不会**被执行。
 *  3. 预算：预测调用**扣同一份规划预算** ⇒ 开着的代价是"能重新规划的次数变少"。
 *  4. 核对**不通过** ⇒ 依赖它的步骤**不执行**（依赖闸）。
 *  5. 核对**通过** ⇒ 依赖它的步骤照常执行（正控）。
 *  6. **误报完成**负控：规划器自报 `done` 但核对不通过 ⇒ 任务**不**报完成。
 *  7. **副作用**负控：预测**不**引发额外调用（不多执行一步、不少写一次）。
 *  8. **权限**负控：未授权能力被策略拒（`permission_denied`），预测改不了。
 *  9. 契约**严格解析**负控：未知字段 / 位置错位 / 枚举越界 / 带代码的规则 ⇒ 拒收。
 * 10. 同预算**留出 A/B**（固定件）：同一份计划、同一份预算，开/关预测两档对照。
 * 11. **接线**静态锁：开关真的被 `main.ts` 消费（不是惰性开关）。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createCapabilityRegistry } from '../src/kernel/action/capability-registry.ts'
import { createActionGateway } from '../src/kernel/action/gateway.ts'
import { createInMemoryPayloadStaging } from '../src/kernel/action/payload-staging.ts'
import { createTaskAuthorizationRegistry } from '../src/kernel/action/task-authorization.ts'
import { runTask, type TaskRunOutcome } from '../src/kernel/action/task-loop.ts'
import type { TaskPlan, TaskPlannerPort } from '../src/kernel/action/task-plan.ts'
import type { ActionForecastPort, ActionForecastInput } from '../src/kernel/action/action-forecast.ts'
import {
  parseActionForecast,
  toSafeActionForecastParseCode,
} from '../src/kernel/action/action-forecast.ts'
import {
  assertRestrictedRuleStatement,
  validateActionForecastStep,
  validateRuleCandidate,
  type ActionForecast,
} from '../src/kernel/contracts/world-model.ts'
import type {
  ActionLedgerEvent,
  ExecutionLedgerPort,
  ExecutionRecordView,
} from '../src/kernel/action/execution-ledger.ts'
import type { ActionRequest } from '../src/kernel/action/action-request.ts'
import type { ActionEffect, ActionEvidence, ActionTarget } from '../src/kernel/action/action-request.ts'
import type { ActionStatus } from '../src/kernel/action/action-result.ts'
import type { ActionFailure } from '../src/kernel/action/errors.ts'
import type { CapabilityAdapter } from '../src/kernel/action/executor-port.ts'
import type { TurnContent } from '../src/kernel/contracts/turn-content.ts'
import { asCharacterId, asTraceId, type CharacterId } from '../src/kernel/contracts/ids.ts'

const out = resolve('artifacts/post-lv2/local/world-model-action-forecast', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'verification.json'), JSON.stringify({ status: 'RUNNING' }) + '\n')

const checks: { id: string; lane: string }[] = []
const check = async (lane: string, id: string, run: () => void | Promise<void>) => {
  await run()
  checks.push({ id, lane })
  console.log(`PASS ${lane}/${id}`)
}

// ---------------------------------------------------------------------------
// 隔离台：真网关 + 真账本接口 + 内存实现
// ---------------------------------------------------------------------------

const CHARACTER = asCharacterId('fixture-character')

function createMemoryLedger(): ExecutionLedgerPort {
  const events: ActionLedgerEvent[] = []
  let sequence = 0
  const push = (
    type: ActionLedgerEvent['type'],
    request: ActionRequest,
    extra: Partial<ActionLedgerEvent> = {}
  ): ActionLedgerEvent => {
    sequence += 1
    const event: ActionLedgerEvent = {
      actionId: request.actionId,
      traceId: request.traceId,
      characterId: CHARACTER,
      sequence,
      type,
      capability: request.capability,
      operation: request.operation,
      ...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {}),
      payload: {},
      createdAt: 1_700_000_000_000 + sequence,
      ...extra,
    }
    events.push(event)
    return event
  }
  const base = (request: ActionRequest) => ({ characterId: CHARACTER, request })
  return {
    async appendRequested(input) {
      return push('ACTION_REQUESTED', input.request, { status: undefined })
    },
    async appendTargetResolved(input) {
      return push('ACTION_TARGET_RESOLVED', input.request)
    },
    async appendAuthorized(input) {
      return push('ACTION_AUTHORIZED', input.request)
    },
    async appendRejected(input) {
      return push('ACTION_REJECTED', input.request, { status: input.status })
    },
    async appendStarted(input) {
      return push('ACTION_STARTED', input.request)
    },
    async appendSucceeded(input) {
      return push('ACTION_SUCCEEDED', input.request, { status: 'success' })
    },
    async appendPartial(input) {
      return push('ACTION_PARTIAL', input.request, { status: 'partial' })
    },
    async appendFailed(input) {
      return push('ACTION_FAILED', input.request, { status: input.status })
    },
    async appendCancelled(input) {
      return push('ACTION_CANCELLED', input.request, { status: 'cancelled' })
    },
    async getEventsByActionId(_characterId, actionId) {
      return events.filter((event) => event.actionId === actionId)
    },
    async getEventsByTraceId(traceId) {
      return events.filter((event) => event.traceId === traceId)
    },
    async listEvents() {
      return [...events]
    },
    async listRecords() {
      return [] as ExecutionRecordView[]
    },
    async findByIdempotencyKey() {
      return undefined
    },
  }
}

const registry = createCapabilityRegistry([
  {
    id: 'fixture.write',
    version: 'fixture@1',
    description: '写一个夹具文件（可配置成"报告成功但没有效果"）',
    operations: [{ name: 'write', description: '写入', sideEffect: 'write', riskLevel: 'R1' }],
    sideEffectLevel: 'write',
    riskLevel: 'R1',
    permissions: ['fixture:write'],
    supportsDryRun: true,
    idempotency: 'none',
  },
  {
    id: 'fixture.read',
    version: 'fixture@1',
    description: '读回一个夹具文件',
    operations: [{ name: 'read', description: '读取', sideEffect: 'read', riskLevel: 'R0' }],
    sideEffectLevel: 'read',
    riskLevel: 'R0',
    permissions: ['fixture:read'],
    supportsDryRun: true,
    idempotency: 'none',
  },
  {
    id: 'fixture.secret',
    version: 'fixture@1',
    description: '**永远不授权**的能力（权限负控用）',
    operations: [{ name: 'run', description: '执行', sideEffect: 'read', riskLevel: 'R1' }],
    sideEffectLevel: 'read',
    riskLevel: 'R1',
    permissions: ['fixture:secret'],
    supportsDryRun: true,
    idempotency: 'none',
  },
])

interface AdapterControl {
  /** 写适配器是否自报效果（false ⇒ "报告成功但没有效果"） */
  writeReportsEffect: boolean
  /** 读适配器返回几份当轮内容 */
  readContentItems: number
  /** 适配器被调用了几次（按能力） */
  calls: Map<string, number>
}

function createFixtureAdapters(control: AdapterControl): CapabilityAdapter[] {
  const bump = (id: string): void => {
    control.calls.set(id, (control.calls.get(id) ?? 0) + 1)
  }
  return [
    {
      capabilityId: 'fixture.write',
      async execute() {
        bump('fixture.write')
        const effect: ActionEffect | undefined = control.writeReportsEffect
          ? { kind: 'file_created', detail: '夹具写入', fingerprint: 'fx', bytes: 3 }
          : { kind: 'none', detail: '适配器报告成功，但没有效果' }
        const evidence: ActionEvidence[] = [{ kind: 'adapter', detail: '夹具写入' }]
        return { effect, evidence }
      },
    },
    {
      capabilityId: 'fixture.read',
      async execute() {
        bump('fixture.read')
        const turnContent: TurnContent[] = []
        for (let index = 0; index < control.readContentItems; index += 1) {
          turnContent.push({
            contentId: `fx-content-${String(index)}`,
            kind: 'document',
            capability: 'fixture.read',
            operation: 'read',
            sourceKind: 'local-file',
            resultFingerprint: `fx-fp-${String(index)}`,
            scope: { totalChars: 6, includedChars: 6, truncated: false },
            facts: [],
            text: `夹具正文 ${String(index)}`,
            mediaType: 'text/plain',
            structure: [],
          })
        }
        return {
          effect: { kind: 'content_read', detail: '夹具读取', fingerprint: 'fx', bytes: 3 },
          evidence: [{ kind: 'adapter', detail: '夹具读取' }],
          ...(turnContent.length > 0 ? { turnContent } : {}),
        }
      },
    },
  ]
}

const TARGET: ActionTarget = {
  type: 'fixture',
  canonicalId: 'fixture-target',
  displayName: '夹具目标',
  confidence: 'exact',
}

function createFixtureGateway(control: AdapterControl) {
  return createActionGateway({
    registry,
    ledger: createMemoryLedger(),
    adapters: createFixtureAdapters(control),
    grantedPermissions: ['fixture:write', 'fixture:read'],
    maxRiskLevel: 'R1',
    dryRun: false,
    now: () => 1_700_000_000_000,
    resolveTarget: async () => ({ target: TARGET, scopeViolation: false }),
  })
}

// ---------------------------------------------------------------------------
// 脚本固定件：规划器 / 预测器
// ---------------------------------------------------------------------------

function scriptedPlanner(scripts: readonly TaskPlan[]): TaskPlannerPort {
  let index = 0
  return {
    id: 'fixture-scripted-planner',
    endpointHost: 'fixture.local',
    async plan() {
      const script = scripts[Math.min(index, scripts.length - 1)]
      index += 1
      return { ok: true, plan: script, requestCount: 0 }
    },
  }
}

interface ScriptedForecast {
  readonly steps: readonly {
    readonly capability: string
    readonly operation: string
    readonly expectedVisibleOutcome: string
    readonly check: ActionForecast['steps'][number]['check']
    readonly uncertainty: ActionForecast['steps'][number]['uncertainty']
    readonly dependsOn?: readonly number[]
  }[]
  readonly producedAt?: number
  readonly inputRevision?: string
}

/**
 * 脚本固定件的预测端口。
 *
 * ⚠️ 它**走与生产同一条解析路径**（`parseActionForecast`）——
 *    否则"固定件"就会绕过严格校验，量到的是**夹具的宽松**，不是生产形状。
 *    这一条与 `scriptedPlanner` 的纪律相同（它也走 `runTask` 里的校验）。
 */
function scriptedForecastPort(
  scripts: readonly ScriptedForecast[]
): ActionForecastPort & { calls: number } {
  let index = 0
  let calls = 0
  return {
    id: 'fixture-scripted-forecast',
    endpointHost: 'fixture.local',
    get calls() {
      return calls
    },
    async forecast(input: ActionForecastInput) {
      calls += 1
      const script = scripts[Math.min(index, scripts.length - 1)]
      index += 1
      if (script === undefined) return { ok: false, failure: 'invalid_output', requestCount: 1 }
      const raw = JSON.stringify({
        schemaVersion: 'action-forecast@1',
        steps: script.steps.map((step) => ({
          capability: step.capability,
          operation: step.operation,
          expectedVisibleOutcome: step.expectedVisibleOutcome,
          check: step.check,
          uncertainty: step.uncertainty,
          dependsOn: [...(step.dependsOn ?? [])],
        })),
      })
      try {
        const forecast = parseActionForecast(raw, {
          planSignature: input.candidateSteps.map((step) => `${step.capability}.${step.operation}`),
          producedAt: script.producedAt ?? input.producedAt,
          inputRevision: script.inputRevision ?? input.inputRevision,
        })
        return { ok: true, forecast, requestCount: 1 }
      } catch (error) {
        return {
          ok: false,
          failure: 'invalid_output',
          requestCount: 1,
          parseFailureCode: toSafeActionForecastParseCode(error),
        }
      }
    },
  }
}

const WRITE_STEP = { capability: 'fixture.write', operation: 'write' }
const READ_STEP = { capability: 'fixture.read', operation: 'read' }

async function runFixtureTask(input: {
  plans: readonly TaskPlan[]
  forecasts?: readonly ScriptedForecast[]
  budget?: { maxActions: number; maxPlans: number }
  control?: Partial<AdapterControl>
  allowedCapabilities?: readonly string[]
  grantSecret?: boolean
}): Promise<{ outcome: TaskRunOutcome; control: AdapterControl; forecastCalls: number }> {
  const control: AdapterControl = {
    writeReportsEffect: input.control?.writeReportsEffect ?? true,
    readContentItems: input.control?.readContentItems ?? 1,
    calls: new Map(),
  }
  const gateway = createFixtureGateway(control)
  const authorizations = createTaskAuthorizationRegistry({
    budget: {
      maxActions: input.budget?.maxActions ?? 30,
      maxPlans: input.budget?.maxPlans ?? 6,
      deadlineMs: 10 * 60 * 1000,
    },
  })
  const allowed = input.allowedCapabilities ?? ['fixture.write', 'fixture.read']
  const authorization = authorizations.issue({
    conversationKey: 'fixture-conversation',
    originalText: '把夹具写好再读回来',
    triggeringEventId: 'cev:fixture',
    allowedCapabilities: allowed,
    maxRiskLevel: 'R1',
  })
  const forecastPort =
    input.forecasts === undefined ? undefined : scriptedForecastPort(input.forecasts)
  const outcome = await runTask(
    {
      gateway,
      registry,
      authorizations,
      planner: scriptedPlanner(input.plans),
      staging: createInMemoryPayloadStaging(),
      resolveTarget: async () => ({ target: TARGET, scopeViolation: false }),
      invocationFor: () => ({}) as never,
      now: () => 1_700_000_000_000,
      ...(forecastPort !== undefined
        ? { forecast: { port: forecastPort, deadlineMs: 20_000 } }
        : {}),
    },
    {
      characterId: CHARACTER,
      traceId: asTraceId('trc:fixture'),
      authorization,
      text: '把夹具写好再读回来',
    }
  )
  return { outcome, control, forecastCalls: forecastPort?.calls ?? 0 }
}

// ---------------------------------------------------------------------------
// 1. 关闭时逐字相同
// ---------------------------------------------------------------------------
await check('tools', 'closed-forecast-has-no-keys', async () => {
  const { outcome } = await runFixtureTask({
    plans: [{ goal: '写', steps: [{ ...WRITE_STEP, args: {} }], done: true }],
  })
  assert.equal('forecastCallsUsed' in outcome, false)
  assert.equal('comparisons' in outcome, false)
  assert.equal(outcome.forecastCallsUsed, undefined)
  // 规划预算**只**被规划调用消耗
  assert.equal(outcome.plansUsed, 1)
  assert.equal(outcome.actionsUsed, 1)
  assert.equal(outcome.stopped, 'done')
})

// ---------------------------------------------------------------------------
// 2. 预测不授权
// ---------------------------------------------------------------------------
await check('tools', 'forecast-does-not-authorize', async () => {
  const { outcome, control } = await runFixtureTask({
    plans: [{ goal: '写', steps: [{ ...WRITE_STEP, args: {} }], done: true }],
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.secret',
            operation: 'run',
            expectedVisibleOutcome: '预测它能跑',
            check: { kind: 'status_is', status: 'success' },
            uncertainty: 'low',
          },
        ],
      },
    ],
    allowedCapabilities: ['fixture.write'],
  })
  // 预测里点名的 `fixture.secret` **一次都没有被执行**
  assert.equal(control.calls.get('fixture.secret'), undefined)
  assert.equal(control.calls.get('fixture.write'), 1)
  // 身份对不上（说的不是计划里的这一步）⇒ **这一条不绑定**（不致命、也无闸）
  assert.equal(outcome.forecastFailureCode, undefined)
  assert.equal(outcome.comparisons?.length, 0)
})

// ---------------------------------------------------------------------------
// 3. 预算：预测调用扣同一份规划预算
// ---------------------------------------------------------------------------
await check('tools', 'forecast-consumes-plan-budget', async () => {
  const { outcome, forecastCalls } = await runFixtureTask({
    plans: [{ goal: '写', steps: [{ ...WRITE_STEP, args: {} }], done: true }],
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.write',
            operation: 'write',
            expectedVisibleOutcome: '写成功',
            check: { kind: 'status_is', status: 'success' },
            uncertainty: 'low',
          },
        ],
      },
    ],
    budget: { maxActions: 30, maxPlans: 2 },
  })
  assert.equal(forecastCalls, 1)
  // 规划 1 次 + 预测 1 次 = 预算 2 ⇒ 两次都**用掉了同一份规划预算**
  assert.equal(outcome.plansUsed, 2)
  assert.equal(outcome.forecastCallsUsed, 1)
  assert.equal(outcome.actionsUsed, 1)
  assert.equal(outcome.comparisons?.[0]?.verdict, 'match')
})

await check('tools', 'plan-slot-wins-over-forecast', async () => {
  // 预算只剩 1 次模型调用时：**规划**先占（没有计划就一步都做不了），
  // 预测**不抢**那个位置 ⇒ 这一轮没有预测，任务行为回到旧档。
  const { outcome, forecastCalls } = await runFixtureTask({
    plans: [{ goal: '写', steps: [{ ...WRITE_STEP, args: {} }], done: true }],
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.write',
            operation: 'write',
            expectedVisibleOutcome: '写成功',
            check: { kind: 'status_is', status: 'success' },
            uncertainty: 'low',
          },
        ],
      },
    ],
    budget: { maxActions: 30, maxPlans: 1 },
  })
  assert.equal(forecastCalls, 0)
  assert.equal(outcome.forecastCallsUsed, 0)
  assert.equal(outcome.plansUsed, 1)
  assert.equal(outcome.actionsUsed, 1)
  assert.equal(outcome.stopped, 'done')
})

// ---------------------------------------------------------------------------
// 4. 核对不通过 ⇒ 依赖步骤不执行
// ---------------------------------------------------------------------------
await check('tools', 'mismatch-blocks-dependent-step', async () => {
  const { outcome, control } = await runFixtureTask({
    plans: [
      {
        goal: '写后读回',
        steps: [{ ...WRITE_STEP, args: {} }, { ...READ_STEP, args: {} }],
        done: true,
      },
    ],
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.write',
            operation: 'write',
            expectedVisibleOutcome: '写下去了',
            check: { kind: 'effect_recorded' },
            uncertainty: 'low',
          },
          {
            capability: 'fixture.read',
            operation: 'read',
            expectedVisibleOutcome: '读回正文',
            check: { kind: 'turn_content_count_at_least', count: 1 },
            uncertainty: 'low',
            dependsOn: [0],
          },
        ],
      },
    ],
    // 写适配器"报告成功但没有效果" ⇒ 核对不通过
    control: { writeReportsEffect: false },
  })
  // ⚠️ 依赖它的读回**一次都没有执行**
  assert.equal(control.calls.get('fixture.read'), undefined)
  // 写步骤被反复尝试，但**次数由既有规划预算封顶**（不是无界重试）
  const writeCalls = control.calls.get('fixture.write') ?? 0
  assert(writeCalls >= 1)
  assert(writeCalls <= 3)
  assert(outcome.comparisons !== undefined)
  assert(outcome.comparisons.length === writeCalls)
  assert(outcome.comparisons.every((row) => row.verdict === 'mismatch'))
  // ⚠️ 不报完成（这一档是"预算用尽"停下；完成声明闸见下面那条）
  assert.notEqual(outcome.stopped, 'done')
})

// ---------------------------------------------------------------------------
// 5. 核对通过 ⇒ 依赖步骤照常执行（正控）
// ---------------------------------------------------------------------------
await check('tools', 'match-allows-dependent-step', async () => {
  const { outcome, control } = await runFixtureTask({
    plans: [
      {
        goal: '写后读回',
        steps: [{ ...WRITE_STEP, args: {} }, { ...READ_STEP, args: {} }],
        done: true,
      },
    ],
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.write',
            operation: 'write',
            expectedVisibleOutcome: '写下去了',
            check: { kind: 'effect_recorded' },
            uncertainty: 'low',
          },
          {
            capability: 'fixture.read',
            operation: 'read',
            expectedVisibleOutcome: '读回正文',
            check: { kind: 'turn_content_count_at_least', count: 1 },
            uncertainty: 'low',
            dependsOn: [0],
          },
        ],
      },
    ],
  })
  assert.equal(control.calls.get('fixture.write'), 1)
  assert.equal(control.calls.get('fixture.read'), 1)
  assert.equal(outcome.comparisons?.[0]?.verdict, 'match')
  assert.equal(outcome.comparisons?.[1]?.verdict, 'match')
  assert.equal(outcome.stopped, 'done')
})

// ---------------------------------------------------------------------------
// 6. 误报完成负控
// ---------------------------------------------------------------------------
await check('tools', 'false-completion-is-not-reported-done', async () => {
  const { outcome } = await runFixtureTask({
    plans: [
      {
        goal: '写',
        steps: [{ ...WRITE_STEP, args: {} }],
        done: true, // 规划器自报"做完了"
      },
    ],
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.write',
            operation: 'write',
            expectedVisibleOutcome: '写下去了',
            check: { kind: 'effect_recorded' },
            uncertainty: 'low',
          },
        ],
      },
    ],
    control: { writeReportsEffect: false },
  })
  assert.equal(outcome.comparisons?.[0]?.verdict, 'mismatch')
  // ⚠️ **不报完成**：程序知道核对被反驳 ⇒ "完成"是一句假话
  assert.notEqual(outcome.stopped, 'done')
})

// ---------------------------------------------------------------------------
// 6b. 完成声明闸：被反驳的键会挡住"完成"，再次核对通过才清除
// ---------------------------------------------------------------------------
await check('tools', 'refuted-key-blocks-completion', async () => {
  /*
   * ⚠️ 预算取值 `maxPlans = 3` 是**有意的**：
   * ```text
   * iter1  规划(1) + 预测(2) ⇒ 核对被反驳 ⇒ 重新规划
   * iter2  规划(3) ⇒ **预测被预算挡住**（没有第二次核对）
   *        ⇒ 这一轮"写成功"看起来像成功 —— 但程序**记得**上一次核对被反驳
   *        ⇒ 完成声明闸挡住 ⇒ 停止原因 = `check_refuted`（**不是** `done`）
   * ```
   * 这正是"没有完成声明闸就会出现假完成"的那条链。
   */
  const blocked = await runFixtureTask({
    plans: [{ goal: '写', steps: [{ ...WRITE_STEP, args: {} }], done: true }],
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.write',
            operation: 'write',
            expectedVisibleOutcome: '写下去了',
            check: { kind: 'effect_recorded' },
            uncertainty: 'low',
          },
        ],
      },
    ],
    control: { writeReportsEffect: false },
    budget: { maxActions: 30, maxPlans: 3 },
  })
  assert.equal(blocked.outcome.stopped, 'check_refuted')
  assert.equal(blocked.outcome.planRejectedCode, 'task_check_refuted')
  assert.notEqual(blocked.outcome.stopped, 'done')

  // 同样的一份计划，**写适配器真的留下了效果** ⇒ 核对通过 ⇒ 正常完成
  const allowed = await runFixtureTask({
    plans: [{ goal: '写', steps: [{ ...WRITE_STEP, args: {} }], done: true }],
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.write',
            operation: 'write',
            expectedVisibleOutcome: '写下去了',
            check: { kind: 'effect_recorded' },
            uncertainty: 'low',
          },
        ],
      },
    ],
    control: { writeReportsEffect: true },
    budget: { maxActions: 30, maxPlans: 3 },
  })
  assert.equal(allowed.outcome.stopped, 'done')
})

// ---------------------------------------------------------------------------
// 7. 副作用负控：预测不引发额外调用
// ---------------------------------------------------------------------------
await check('tools', 'forecast-causes-no-extra-side-effects', async () => {
  const { outcome, control } = await runFixtureTask({
    plans: [
      {
        goal: '写后读回',
        steps: [{ ...WRITE_STEP, args: {} }, { ...READ_STEP, args: {} }],
        done: true,
      },
    ],
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.write',
            operation: 'write',
            expectedVisibleOutcome: '写下去了',
            check: { kind: 'status_is', status: 'success' },
            uncertainty: 'low',
          },
          {
            capability: 'fixture.read',
            operation: 'read',
            expectedVisibleOutcome: '读回正文',
            check: { kind: 'status_is', status: 'success' },
            uncertainty: 'low',
          },
        ],
      },
    ],
  })
  assert.equal(control.calls.get('fixture.write'), 1)
  assert.equal(control.calls.get('fixture.read'), 1)
  assert.equal(outcome.actionsUsed, 2)
})

// ---------------------------------------------------------------------------
// 8. 权限负控
// ---------------------------------------------------------------------------
await check('tools', 'permission-negative-control', async () => {
  const { outcome, control } = await runFixtureTask({
    plans: [
      {
        goal: '跑未授权能力',
        steps: [{ capability: 'fixture.secret', operation: 'run', args: {} }],
        done: true,
      },
    ],
    allowedCapabilities: ['fixture.secret'],
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.secret',
            operation: 'run',
            expectedVisibleOutcome: '会成功',
            check: { kind: 'status_is', status: 'success' },
            uncertainty: 'low',
          },
        ],
      },
    ],
  })
  // 能力在**授权集合**里，但**权限没授予** ⇒ 策略拒
  assert.equal(control.calls.get('fixture.secret'), undefined)
  assert.equal(outcome.results[0]?.result.status, 'rejected')
  assert.equal(outcome.results[0]?.result.error?.code, 'permission_denied')
  // 预测**不能**把它变成"成功"
  assert.notEqual(outcome.comparisons?.[0]?.verdict, 'match')
})

// ---------------------------------------------------------------------------
// 9. 契约严格解析负控
// ---------------------------------------------------------------------------
await check('contract', 'strict-parse-negative-controls', async () => {
  const planSignature = ['fixture.write.write', 'fixture.read.read']
  const base = {
    schemaVersion: 'action-forecast@1',
    steps: [
      {
        capability: 'fixture.write',
        operation: 'write',
        expectedVisibleOutcome: '写下去了',
        check: { kind: 'status_is', status: 'success' },
        uncertainty: 'low',
        dependsOn: [],
      },
    ],
  }
  const parse = (value: unknown) =>
    parseActionForecast(JSON.stringify(value), {
      planSignature,
      producedAt: 1,
      inputRevision: 'r1',
    })
  // 顶层未知字段
  assert.throws(() => parse({ ...base, extra: 1 }))
  // 步骤未知字段
  assert.throws(() =>
    parse({ ...base, steps: [{ ...base.steps[0], extra: 1 }] })
  )
  // 枚举越界
  assert.throws(() =>
    parse({ ...base, steps: [{ ...base.steps[0], uncertainty: 'certain' }] })
  )
  // 核对条件的 kind 不在闭集
  assert.throws(() =>
    parse({ ...base, steps: [{ ...base.steps[0], check: { kind: 'vibes' } }] })
  )
  // 身份对不上（说的不是计划里的这一步）⇒ **这一条不绑定**（不致命、也无闸）
  const unmatched = parse({
    ...base,
    steps: [{ ...base.steps[0], capability: 'fixture.read' }],
  })
  assert.equal(unmatched.steps.length, 0)
  // 依赖指向自己 / 后面 / 不存在的项 ⇒ 这一条**不绑定**（不致命）
  assert.equal(parse({ ...base, steps: [{ ...base.steps[0], dependsOn: [1] }] }).steps.length, 0)
  assert.equal(parse({ ...base, steps: [{ ...base.steps[0], dependsOn: [0] }] }).steps.length, 0)
  // 依赖形状不合法（不是整数）⇒ **致命**（整份拒收）
  assert.throws(() => parse({ ...base, steps: [{ ...base.steps[0], dependsOn: ['x'] }] }))
  // schema 版本不符
  assert.throws(() => parse({ ...base, schemaVersion: 'action-forecast@2' }))
  // 解析失败码在白名单里（**具体**码，不是笼统的 unknown）
  const code = toSafeActionForecastParseCode(
    (() => {
      try {
        parse({ ...base, extra: 1 })
        return undefined
      } catch (error) {
        return error
      }
    })()
  )
  assert.equal(code, 'action_forecast_unknown_field')
  // 白名单外的码 ⇒ 归一到 `unknown_parse_failure`（绝不把任意字符串当读数）
  assert.equal(
    toSafeActionForecastParseCode({ code: 'rm -rf /' }),
    'unknown_parse_failure'
  )
})

await check('contract', 'rule-statement-is-not-executable', async () => {
  // 规则正文里带可执行片段 ⇒ 拒收
  for (const bad of [
    'rm -rf /',
    'select * from users',
    'function(){ return 1 }',
    '`whoami`',
    '$(id)',
    'curl http://x',
  ]) {
    assert.throws(() => assertRestrictedRuleStatement(bad))
  }
  // 正常的受限陈述可以通过
  assert.doesNotThrow(() =>
    assertRestrictedRuleStatement('当目标文件已存在时，先备份再覆盖；失败时按原路径重试一次。')
  )
  // 规则候选：未知字段 / 领域越界 都要拒
  assert.throws(() =>
    validateRuleCandidate({
      domain: 'tool_task',
      taskScope: 'file-write',
      version: 'r1',
      sourceIdentity: 'src:1',
      sourceRevision: 1,
      applicability: '写本机文件时',
      rule: '先备份再覆盖',
      explanation: '避免覆盖丢内容',
      extra: 1,
    })
  )
  assert.throws(() =>
    validateRuleCandidate({
      domain: 'story',
      taskScope: 'file-write',
      version: 'r1',
      sourceIdentity: 'src:1',
      sourceRevision: 1,
      applicability: '写本机文件时',
      rule: '先备份再覆盖',
      explanation: '避免覆盖丢内容',
    })
  )
  // 依赖下标越界
  assert.throws(() =>
    validateActionForecastStep(
      {
        capability: 'fixture.write',
        operation: 'write',
        expectedVisibleOutcome: '写下去了',
        check: { kind: 'status_is', status: 'success' },
        uncertainty: 'low',
        dependsOn: [5],
      },
      { planStepCount: 2, stepIndex: 1 }
    )
  )
})

await check('contract', 'identity-binding-not-positional', async () => {
  /*
   * ⚠️ 2026-10-20 dev 段**实测**得到的修法：真实模型**会把步骤重排**。
   *    第一版按"位置"绑定 ⇒ 整份预测被拒 ⇒ 机制**根本没生效**。
   *    ⇒ 现在按**身份**（`能力.操作` 逐字）绑定；身份对不上 ⇒ 那一条**不绑定**。
   */
  const planSignature = ['fixture.write.write', 'fixture.read.read']
  const raw = (steps: unknown[]): string =>
    JSON.stringify({ schemaVersion: 'action-forecast@1', steps })
  const step = (
    capability: string,
    operation: string,
    dependsOn: number[] = []
  ): Record<string, unknown> => ({
    capability,
    operation,
    expectedVisibleOutcome: '预期',
    check: { kind: 'status_is', status: 'success' },
    uncertainty: 'low',
    dependsOn,
  })
  // 重排（先写读、再写写）⇒ 仍能按身份绑上，且**顺序**被换算回计划顺序
  const reordered = parseActionForecast(
    raw([step('fixture.read', 'read'), step('fixture.write', 'write')]),
    { planSignature, producedAt: 1, inputRevision: 'r1' }
  )
  assert.equal(reordered.steps.length, 2)
  assert.equal(reordered.steps[0]!.capability, 'fixture.write')
  assert.equal(reordered.steps[1]!.capability, 'fixture.read')
  // 依赖：**模型自己列表里的**下标 ⇒ 重映射成计划下标
  const withDependency = parseActionForecast(
    raw([step('fixture.write', 'write'), step('fixture.read', 'read', [0])]),
    { planSignature, producedAt: 1, inputRevision: 'r1' }
  )
  assert.deepEqual(withDependency.steps[1]!.dependsOn, [0])
  // 身份对不上 ⇒ **不绑定**（不致命）
  const unknown = parseActionForecast(raw([step('fixture.other', 'write')]), {
    planSignature,
    producedAt: 1,
    inputRevision: 'r1',
  })
  assert.equal(unknown.steps.length, 0)
})

// ---------------------------------------------------------------------------
// 9b. 契约严格解析负控（续）
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 10. 同预算留出 A/B（**固定件**，只测机制）
// ---------------------------------------------------------------------------
await check('ab', 'same-budget-heldout-ab', async () => {
  const plans: TaskPlan[] = [
    {
      goal: '写后读回',
      steps: [{ ...WRITE_STEP, args: {} }, { ...READ_STEP, args: {} }],
      done: true,
    },
  ]
  const off = await runFixtureTask({ plans, budget: { maxActions: 4, maxPlans: 2 } })
  const on = await runFixtureTask({
    plans,
    budget: { maxActions: 4, maxPlans: 2 },
    forecasts: [
      {
        steps: [
          {
            capability: 'fixture.write',
            operation: 'write',
            expectedVisibleOutcome: '写下去了',
            check: { kind: 'status_is', status: 'success' },
            uncertainty: 'low',
          },
          {
            capability: 'fixture.read',
            operation: 'read',
            expectedVisibleOutcome: '读回正文',
            check: { kind: 'status_is', status: 'success' },
            uncertainty: 'low',
          },
        ],
      },
    ],
  })
  // 同一份预算下：开预测**多花一次模型调用**（规划预算），行动数与完成度**相同**
  assert.equal(off.outcome.actionsUsed, on.outcome.actionsUsed)
  assert.equal(off.outcome.stopped, on.outcome.stopped)
  assert.equal(on.outcome.plansUsed, off.outcome.plansUsed + 1)
  assert.equal(on.outcome.forecastCallsUsed, 1)
})

// ---------------------------------------------------------------------------
// 11. 接线静态锁
// ---------------------------------------------------------------------------
await check('wiring', 'main-consumes-the-flag', async () => {
  const main = readFileSync('src/main.ts', 'utf8')
  assert(main.includes('createOpenAiActionForecast('))
  assert(main.includes('this.flags.actionForecastEnabled'))
  const flags = readFileSync('src/kernel/app/flags.ts', 'utf8')
  assert(flags.includes('CHARACTER_ACTION_FORECAST_ENABLED'))
  assert(flags.includes('actionForecastEnabled: truthy(env.CHARACTER_ACTION_FORECAST_ENABLED, false)'))
  // 默认**关闭**
  const defaultRead = /actionForecastEnabled: truthy\(env\.CHARACTER_ACTION_FORECAST_ENABLED, false\)/.exec(flags)
  assert(defaultRead !== null)
})

// ---------------------------------------------------------------------------
await check('regression', 'partial-forecast-keeps-step-identity', async () => {
  const { outcome, control } = await runFixtureTask({
    plans: [{ goal: '写后读', steps: [{ ...WRITE_STEP, args: {} }, { ...READ_STEP, args: {} }], done: true }],
    forecasts: [{ steps: [{ ...READ_STEP, expectedVisibleOutcome: '读到正文',
      check: { kind: 'turn_content_count_at_least', count: 1 }, uncertainty: 'low' }] }],
  })
  assert.equal(control.calls.get('fixture.read'), 1)
  assert.deepEqual(outcome.comparisons?.map(row => row.capability), ['fixture.read'])
})

await check('regression', 'empty-done-cannot-clear-refutation', async () => {
  const { outcome } = await runFixtureTask({
    plans: [
      { goal: '写', steps: [{ ...WRITE_STEP, args: {} }], done: false },
      { goal: '完成', steps: [], done: true },
    ],
    forecasts: [{ steps: [{ ...WRITE_STEP, expectedVisibleOutcome: '有效果',
      check: { kind: 'effect_recorded' }, uncertainty: 'low' }] }],
    control: { writeReportsEffect: false },
  })
  assert.equal(outcome.stopped, 'check_refuted')
})

await check('regression', 'weaker-check-cannot-clear-original-refutation', async () => {
  const { outcome } = await runFixtureTask({
    plans: [
      { goal: '写', steps: [{ ...WRITE_STEP, args: {} }], done: false },
      { goal: '再核对', steps: [{ ...WRITE_STEP, args: {} }], done: true },
    ],
    forecasts: [
      { steps: [{ ...WRITE_STEP, expectedVisibleOutcome: '有效果', check: { kind: 'effect_recorded' }, uncertainty: 'low' }] },
      { steps: [{ ...WRITE_STEP, expectedVisibleOutcome: '报告成功', check: { kind: 'status_is', status: 'success' }, uncertainty: 'low' }] },
    ],
    control: { writeReportsEffect: false },
  })
  assert.equal(outcome.stopped, 'check_refuted')
})

await check('regression', 'check-unknown-fields-are-rejected', async () => {
  assert.throws(() => parseActionForecast(JSON.stringify({ schemaVersion: 'action-forecast@1', steps: [{
    ...WRITE_STEP, expectedVisibleOutcome: '写入', uncertainty: 'low', dependsOn: [],
    check: { kind: 'no_error', executable: 'ignored payload' },
  }] }), { planSignature: ['fixture.write.write'], producedAt: 1, inputRevision: 'r' }))
})

// 证据
// ---------------------------------------------------------------------------
const files = [
  'scripts/world-model-action-forecast-verify.ts',
  'src/kernel/contracts/world-model.ts',
  'src/kernel/action/action-forecast.ts',
  'src/kernel/action/task-loop.ts',
  'src/kernel/action/action-turn.ts',
  'src/infrastructure/model/openai-action-forecast.ts',
  'src/kernel/app/flags.ts',
  'src/main.ts',
]
writeFileSync(
  resolve(out, 'verification.json'),
  JSON.stringify(
    {
      schema: 'world-model-action-forecast@1',
      status: 'PASS',
      checks,
      evidenceClass: 'offline_isolated_mechanism_only',
      realModelCalls: 0,
      realToolCalls: 0,
      databaseOpened: false,
      productionIntegrated: false,
      benefitMeasured: false,
      storyFeatureStatus: 'cancelled_2026-10-20',
      sourceHashes: Object.fromEntries(
        files.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])
      ),
    },
    null,
    2
  ) + '\n'
)
console.log(
  JSON.stringify({
    status: 'PASS',
    checks: checks.length,
    evidenceClass: 'offline_isolated_mechanism_only',
    output: out,
  })
)
