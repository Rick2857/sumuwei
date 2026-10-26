/** Real Gateway/files/EBL, synthetic character and caller-prepared isolated PostgreSQL only. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isolateDatabase, resetPluginSqlConnection } from '../../src/dev/sandbox.ts'
import { createM4Harness } from '../m4-harness.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import { createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries, contentFingerprint } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS } from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { runTask, type EblTaskObserver, type TaskRunOutcome } from '../../src/kernel/action/task-loop.ts'
import type { TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { actionFailure, ActionFailureError } from '../../src/kernel/action/errors.ts'

/** Physical goal and real readback are independent of the planner's completion hint. */
export function scoreFileTask(outcome: TaskRunOutcome, goal: { root: string; path: string; content: string }) {
  const lastRead = outcome.results.filter(item => item.request.capability === 'sandbox.file.read').at(-1)
  let bytesMatch = false
  try { bytesMatch = readFileSync(resolve(goal.root, goal.path), 'utf8') === goal.content } catch { /* not produced */ }
  const readMatched = lastRead?.result.status === 'success' && lastRead.request.arguments.path === goal.path
    && lastRead.result.effect?.fingerprint === contentFingerprint(goal.content)
  const achieved = bytesMatch && readMatched
  return { achieved, bytesMatch, readMatched, falseCompletion: outcome.stopped === 'done' && !achieved }
}

/**
 * @param guard **场景侧守卫**（只给 F1 用）：当标记文件的内容等于 `lockedValue` 时，
 *   对**除标记以外任何路径**的写入被拒绝（抛 `validation_failed`）。
 *   ⇒ 族内**多个对象**各自可作独立 binding（守卫保护"非标记写入"，不是单一路径）。
 * ⚠️ 这是**仿真装配**里注入的观测条件，**不是产品行为**：不设 `guard` 时床位行为一字不变。
 */
export async function createFilePlanningBedImpl(label: string, train: boolean,
  guard?: { markerFile: string; lockedValue: string }) {
  assert.equal(isolateDatabase(label, { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } }).backend, 'postgres')
  const output = resolve('artifacts/local/file-planning', `${label}-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const root = mkdtempSync(resolve(output, 'files-'))
  const h = await createM4Harness({ label, userId: 'Alex' })
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const fileOptions = { root, staging }
  const ledger = createActionLedgerStore(h.db)
  const snapshots = createEblRuleSnapshotPort(h.db, h.kernel.characterId, h.userId)
  const store = createEblStore(h.db, h.kernel.characterId, createEblSourceReader(h.userId))
  const observer = createEblTaskObserver(h.db, h.userId)
  const authorizations = createTaskAuthorizationRegistry()
  const allowed = ['sandbox.file.write', 'sandbox.file.read']
  let adapterCalls = 0, sequence = 0
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fileOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger, grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'file-planning', executorAdapterId: 'sandbox-filesystem' },
    adapters: [createSandboxReadAdapter(fileOptions), createSandboxWriteAdapter(fileOptions)].map(adapter => ({ ...adapter,
      async execute(input: Parameters<typeof adapter.execute>[0]) {
        // ⚠️ **场景侧守卫**（F1 的前置条件）：标记=locked 时拒绝**除标记以外**的任何写入。
        //    它**只在仿真装配里**存在；不设 guard 时这段不生效。
        if (guard !== undefined && input.operation === 'write' && input.args.path !== guard.markerFile) {
          let marker = ''
          try { marker = readFileSync(resolve(root, guard.markerFile), 'utf8') } catch { marker = '' }
          if (marker === guard.lockedValue) throw new ActionFailureError(actionFailure('validation_failed', 'guard_locked'))
        }
        adapterCalls++
        return await adapter.execute(input)
      },
    })),
  })
  async function run(planner: TaskPlannerPort, options: {
    text?: string; observe?: boolean; snapshot?: boolean; before?: EblTaskObserver['before']; after?: EblTaskObserver['after']; maxActions?: number
  } = {}): Promise<TaskRunOutcome> {
    const text = options.text ?? '在自有测试文件写入指定内容，再真实读回核对。'
    const event = (await h.recordUserEvidence(text)).event
    const authorization = authorizations.issue({ conversationKey: String(event.conversationId), originalText: text,
      triggeringEventId: String(event.id), allowedCapabilities: allowed, maxRiskLevel: 'R1',
      budget: { maxActions: options.maxActions ?? 4, maxPlans: 1, deadlineMs: 120_000 } })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'file-planning',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'file-planning', triggeringEvent: triggeringConversationEventOf(event) }) })
    return await runTask({ gateway, registry, authorizations, staging, resolveTarget, planner,
      ...(options.snapshot === false ? {} : { ruleSnapshot: snapshots }),
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: { async before(input) { await options.before?.(input); if (options.observe) return await observer.before(input) },
        async after(input) { if (options.observe) await observer.after(input); await options.after?.(input) } },
    }, { characterId: h.kernel.characterId, traceId: asTraceId(`${label}-${++sequence}`), authorization, text })
  }
  /**
   * 一条**训练**写读轨迹（写 + 读），**开着原生观察** ⇒ 它会真的参与规则形成。
   *
   * ⚠️ 旧的自动赠送：床位创建时**无条件**跑三条这样的轨迹并断言"已形成合格规则"
   *    ⇒ 任何用它测量的序列**开局就带着规则**，"学习"是被赠送的、不是被观测的。
   *    ⇒ 现在可用 `train: false` 关闭自动赠送，改为在**被测序列里**自己积累。
   */
  async function trainingRun(index: number) {
    const path = `training-${index}.txt`
    const outcome = await run({ id: 'file-training', endpointHost: 'offline', async plan() {
      return { ok: true, requestCount: 1, plan: { goal: 'training', done: true, steps: [
        { capability: 'sandbox.file.write', operation: 'write', args: { path, content: `training-${index}` } },
        { capability: 'sandbox.file.read', operation: 'read', args: { path } },
      ] } }
    } }, { observe: true })
    assert.ok(outcome.results.length === 2 && outcome.results.every(item => item.result.status === 'success') && !outcome.epistemicFailures)
    return outcome
  }
  const autoTrain = train
  if (autoTrain) for (let index = 0; index < 3; index += 1) await trainingRun(index)
  const rule = (await snapshots.list()).find(item => item.usable)
  return { output, root, registry, snapshots, store, rule, allowed, run, trainingRun,
    /** 当前**合格**规则（没有就是没有；`train:false` 的序列在形成前恒为空）。 */
    async usableRules() { return (await snapshots.list()).filter(item => item.usable) },
    turnHarness: { h, gateway, authorizations, staging, resolveTarget },
    modelOptions: { db: h.db, characterId: h.kernel.characterId, activeUserId: h.userId,
      modelVersion: 'simulation-task-planner@1', facts: { encoding: 'utf8' } },
    async counts() {
      // ⚠️ 用**当前**的合格规则（建床时的那条在不赠送规则的床位里恒为 undefined）。
      const current = (await snapshots.list()).find(item => item.usable)
      return { adapterCalls, ledger: (await ledger.listRecords({ characterId: h.kernel.characterId, limit: 500 })).length,
        evidence: current === undefined ? 0 : (await store.get(current.claimId))!.evidence.length }
    },
    async stop() { await h.stop(); await resetPluginSqlConnection() },
  }
}

/**
 * 默认床位：开场**赠送**三条训练写读，并断言已形成合格规则。
 *
 * ⚠️ 旧行为保留（文件选择器协议依赖它）；但**凡是要测"学习"的序列都不该用它**
 *    —— 请用 {@link createObservingFilePlanningBed}。
 */
export async function createFilePlanningBed(label: string) {
  const bed = await createFilePlanningBedImpl(label, true)
  assert.ok(bed.rule, 'training_must_form_qualified_rule')
  return { ...bed, rule: bed.rule }
}

/**
 * **不赠送规则**的床位：序列**从没有合格规则开始**，
 * 规则**只能**由被测任务里的真实执行反馈（开着原生观察）形成。
 */
export async function createObservingFilePlanningBed(label: string, guard?: { markerFile: string; lockedValue: string }) {
  return createFilePlanningBedImpl(label, false, guard)
}
