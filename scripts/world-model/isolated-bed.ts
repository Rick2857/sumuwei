/**
 * 三域应用方案 —— **隔离动作台**（阶段 1 的门与阶段 4 的 A/B 共用）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 一个**完全隔离**的 `ActionGateway` 床：
 * ```text
 * 真 `createActionGateway` + 真能力登记表 + 真策略 + 真目标解析
 * + 内存账本（九个具名写入口） + 内存载荷暂存 + 夹具适配器
 * ```
 * ⚠️ **零数据库、零出站、零真实工具**：夹具适配器只改内存里的一个 Map。
 * ⚠️ 阶段 1 的门与阶段 4 的 A/B **共用这一份床** ⇒ 两者的读数同源，
 *    不会出现"门里是一种行为、A/B 里是另一种行为"。
 *
 * ⚠️ 夹具适配器的**行为是脚本固定的**（§6："固定件只测机制"）：
 *    它测的是"机制分叉"，**不**测"真实工具会不会这样表现"。
 */

import { createCapabilityRegistry } from '../../src/kernel/action/capability-registry.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import type { ActionRequest } from '../../src/kernel/action/action-request.ts'
import type { ActionEffect, ActionEvidence, ActionTarget } from '../../src/kernel/action/action-request.ts'
import type { ActionResult } from '../../src/kernel/action/action-result.ts'
import type {
  ActionLedgerEvent,
  ExecutionLedgerPort,
  ExecutionRecordView,
} from '../../src/kernel/action/execution-ledger.ts'
import type { CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'
import type { TurnContent } from '../../src/kernel/contracts/turn-content.ts'
import { asCharacterId, asTraceId, type CharacterId } from '../../src/kernel/contracts/ids.ts'
import type { TaskPlan, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'

export const FIXTURE_CHARACTER: CharacterId = asCharacterId('fixture-character')

export const FIXTURE_TARGET: ActionTarget = {
  type: 'fixture',
  canonicalId: 'fixture-target',
  displayName: '夹具目标',
  confidence: 'exact',
}

/** 夹具能力：若干个"写"与若干个"读"（**不同名字** ⇒ 模型不能只背一个能力名）。 */
export const FIXTURE_WRITE_CAPABILITIES = [
  'fixture.alpha.write',
  'fixture.beta.write',
  'fixture.gamma.write',
  'fixture.delta.write',
] as const
export const FIXTURE_READ_CAPABILITIES = [
  'fixture.echo.read',
  'fixture.foxtrot.read',
] as const

function capabilityDefinition(
  id: string,
  sideEffect: 'write' | 'read',
  riskLevel: 'R0' | 'R1'
): {
  id: string
  version: string
  description: string
  operations: readonly { name: string; description: string; sideEffect: 'write' | 'read'; riskLevel: 'R0' | 'R1' }[]
  sideEffectLevel: 'write' | 'read'
  riskLevel: 'R0' | 'R1'
  permissions: readonly string[]
  supportsDryRun: boolean
  idempotency: 'none'
} {
  return {
    id,
    version: 'fixture@1',
    description: `夹具能力 ${id}`,
    operations: [
      {
        name: sideEffect === 'write' ? 'write' : 'read',
        description: sideEffect === 'write' ? '写入夹具' : '读回夹具',
        sideEffect,
        riskLevel,
      },
    ],
    sideEffectLevel: sideEffect,
    riskLevel,
    permissions: [`fixture:${id}`],
    supportsDryRun: true,
    idempotency: 'none',
  }
}

export const FIXTURE_REGISTRY = createCapabilityRegistry([
  ...FIXTURE_WRITE_CAPABILITIES.map(id => capabilityDefinition(id, 'write', 'R1')),
  ...FIXTURE_READ_CAPABILITIES.map(id => capabilityDefinition(id, 'read', 'R0')),
])

export const FIXTURE_GRANTED_PERMISSIONS = [
  ...FIXTURE_WRITE_CAPABILITIES.map(id => `fixture:${id}`),
  ...FIXTURE_READ_CAPABILITIES.map(id => `fixture:${id}`),
]

// ---------------------------------------------------------------------------
// 内存账本
// ---------------------------------------------------------------------------

export function createMemoryLedger(): ExecutionLedgerPort {
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
      characterId: FIXTURE_CHARACTER,
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
  return {
    async appendRequested(input) {
      return push('ACTION_REQUESTED', input.request)
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

// ---------------------------------------------------------------------------
// 夹具适配器
// ---------------------------------------------------------------------------

export interface FixtureBehavior {
  /** 写适配器是否自报效果（false ⇒ "报告成功但什么都没发生"） */
  readonly writeReportsEffect: boolean
  /** 读回是否真的返回内容 */
  readonly readReturnsContent: boolean
}

export interface FixtureControl {
  readonly behavior: FixtureBehavior
  /** 每个能力被调用了几次 */
  readonly calls: Map<string, number>
}

export function createFixtureControl(behavior: FixtureBehavior): FixtureControl {
  return { behavior, calls: new Map() }
}

export function createFixtureAdapters(control: FixtureControl): CapabilityAdapter[] {
  const bump = (id: string): void => {
    control.calls.set(id, (control.calls.get(id) ?? 0) + 1)
  }
  const adapters: CapabilityAdapter[] = []
  for (const id of FIXTURE_WRITE_CAPABILITIES) {
    adapters.push({
      capabilityId: id,
      async execute() {
        bump(id)
        const effect: ActionEffect = control.behavior.writeReportsEffect
          ? { kind: 'file_created', detail: '夹具写入', fingerprint: 'fx', bytes: 3 }
          : { kind: 'none', detail: '适配器报告成功，但没有效果' }
        const evidence: ActionEvidence[] = [{ kind: 'adapter', detail: '夹具写入' }]
        return { effect, evidence }
      },
    })
  }
  for (const id of FIXTURE_READ_CAPABILITIES) {
    adapters.push({
      capabilityId: id,
      async execute() {
        bump(id)
        const turnContent: TurnContent[] = []
        if (control.behavior.readReturnsContent) {
          turnContent.push({
            contentId: `fx-content-${id}`,
            kind: 'document',
            capability: id,
            operation: 'read',
            sourceKind: 'local-file',
            resultFingerprint: `fx-fp-${id}`,
            scope: { totalChars: 6, includedChars: 6, truncated: false },
            facts: [],
            text: '夹具正文',
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
    })
  }
  return adapters
}

export function createFixtureGateway(control: FixtureControl) {
  return createActionGateway({
    registry: FIXTURE_REGISTRY,
    ledger: createMemoryLedger(),
    adapters: createFixtureAdapters(control),
    grantedPermissions: FIXTURE_GRANTED_PERMISSIONS,
    maxRiskLevel: 'R1',
    dryRun: false,
    now: () => 1_700_000_000_000,
    resolveTarget: async () => ({ target: FIXTURE_TARGET, scopeViolation: false }),
  })
}

// ---------------------------------------------------------------------------
// 脚本规划器
// ---------------------------------------------------------------------------

export function scriptedPlanner(scripts: readonly TaskPlan[]): TaskPlannerPort {
  let index = 0
  return {
    id: 'fixture-scripted-planner',
    endpointHost: 'fixture.local',
    async plan() {
      const script = scripts[Math.min(index, scripts.length - 1)]
      index += 1
      if (script === undefined) {
        return { ok: true, plan: { goal: '（没有更多计划）', steps: [], done: true }, requestCount: 0 }
      }
      return { ok: true, plan: script, requestCount: 0 }
    },
  }
}

/** 跑一个隔离任务的完整装配（**只**用这里的零件）。 */
export function createIsolatedTaskRun(input: {
  plans: readonly TaskPlan[]
  planner?: TaskPlannerPort
  task?: string
  realClock?: boolean
  behavior: FixtureBehavior
  budget?: { maxActions: number; maxPlans: number }
  allowedCapabilities?: readonly string[]
  forecast?: Parameters<typeof import('../../src/kernel/action/task-loop.ts').runTask>[0]['forecast']
}) {
  const control = createFixtureControl(input.behavior)
  const gateway = createFixtureGateway(control)
  const authorizations = createTaskAuthorizationRegistry({
    budget: {
      maxActions: input.budget?.maxActions ?? 6,
      maxPlans: input.budget?.maxPlans ?? 3,
      deadlineMs: 10 * 60 * 1000,
    },
  })
  const authorization = authorizations.issue({
    conversationKey: 'fixture-conversation',
    originalText: '夹具任务',
    triggeringEventId: 'cev:fixture',
    allowedCapabilities: input.allowedCapabilities ?? [
      ...FIXTURE_WRITE_CAPABILITIES,
      ...FIXTURE_READ_CAPABILITIES,
    ],
    maxRiskLevel: 'R1',
  })
  const options = {
    gateway,
    registry: FIXTURE_REGISTRY,
    authorizations,
    planner: input.planner ?? scriptedPlanner(input.plans),
    staging: createInMemoryPayloadStaging(),
    resolveTarget: async () => ({ target: FIXTURE_TARGET, scopeViolation: false }),
    invocationFor: () => ({}) as never,
    now: input.realClock ? Date.now : () => 1_700_000_000_000,
    ...(input.forecast !== undefined ? { forecast: input.forecast } : {}),
  }
  const run = async (): Promise<{ outcome: import('../../src/kernel/action/task-loop.ts').TaskRunOutcome; control: FixtureControl }> => {
    const { runTask } = await import('../../src/kernel/action/task-loop.ts')
    const outcome = await runTask(options, {
      characterId: FIXTURE_CHARACTER,
      traceId: asTraceId('trc:fixture'),
      authorization,
      text: input.task ?? '夹具任务',
    })
    return { outcome, control }
  }
  return { run, control, authorization }
}

export type { ActionResult }
