/** Zero-model calibration of the proposed eight-task schedules, not a three-arm benefit trial. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { isolateDatabase } from '../../src/dev/sandbox.ts'
import { createM4Harness } from '../m4-harness.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { createActionIntentDetector } from '../../src/kernel/action/intent-detector.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS, SANDBOX_FILE_WRITE } from '../../src/kernel/action/capability-registry.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { ActionFailureError, actionFailure } from '../../src/kernel/action/errors.ts'
import type { CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'
import type { TaskPlan, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import type { TaskRunOutcome } from '../../src/kernel/action/task-loop.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { createSimulationPlanning } from '../../src/infrastructure/runtime/simulation-planning.ts'
import type { SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { exec } from '../../src/infrastructure/persistence/db.ts'

const dataRoot = resolve('docs/architecture/f1-preregistration-20261024')
const load = (name: string) => JSON.parse(readFileSync(resolve(dataRoot, name), 'utf8'))
const worlds = load('worlds.json') as { worlds: { worldId: string; knownDirectories: string[]; declarations: { familyId: string; conditionPath: string; mustNotEqual: string }[] }[] }
if (process.argv.includes('--list-cases')) {
  console.log(worlds.worlds.map(world => world.worldId).join('\n'))
  process.exit(0)
}
assert.equal(process.platform, 'linux', 'linux_simulator_required')
assert.ok(existsSync('/opt/serversim/supervisor.mjs'), 'serversim_runtime_required')
assert.equal(new URL(process.env.LG_TEST_PG_URL ?? '').hostname, 'pgtest', 'isolated_simulator_pgtest_required')
const worldId = process.argv[process.argv.indexOf('--case') + 1]
const world = worlds.worlds.find(item => item.worldId === worldId)
assert.ok(world, 'unknown_world')
assert.equal(isolateDatabase(`f1-readiness-${worldId}`, { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } }).backend, 'postgres')
const tasks = (load('tasks.json') as { tasks: { worldId: string; taskId: string; ordinal: number; targetPath: string; conditionPath: string; content: string; requestText: string }[] }).tasks.filter(task => task.worldId === worldId)
const truth = (load('oracle.json') as { perWorld: { worldId: string; schedule: { taskId: string; markerValue: string; guardApplied: boolean }[] }[] }).perWorld.find(item => item.worldId === worldId)!
const output = resolve('artifacts/local/f1-readiness', worldId)
mkdirSync(output, { recursive: true })
const root = mkdtempSync(resolve(output, 'files-'))
for (const directory of world.knownDirectories) mkdirSync(resolve(root, directory), { recursive: true })
const h = await createM4Harness({ label: `f1-readiness-${worldId}`, userId: 'Alex' })
const rows: Record<string, unknown>[] = []
let firstJoint: number | null = null
let firstConsumption: number | null = null
try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const markerPaths = [...new Set(world.declarations.map(item => item.conditionPath))]
  const fileOptions = { root, staging, conditionPaths: markerPaths }
  const writeAdapter = createSandboxWriteAdapter(fileOptions)
  let guarded = false
  const guardedWrite: CapabilityAdapter = { capabilityId: SANDBOX_FILE_WRITE, async execute(input) {
    if (guarded && readFileSync(resolve(root, 'f1-guard.txt'), 'utf8') === 'locked') {
      throw new ActionFailureError(actionFailure('validation_failed', 'calibration_guard_locked'))
    }
    return await writeAdapter.execute(input)
  } }
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fileOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger: createActionLedgerStore(h.db), resolveTarget,
    adapters: [createSandboxReadAdapter(fileOptions), guardedWrite], grantedPermissions: DEFAULT_GRANTED_PERMISSIONS,
    maxRiskLevel: 'R1', attribution: { decisionPointAdapterId: 'f1-readiness', executorAdapterId: 'sandbox-filesystem' } })
  const authorizations = createTaskAuthorizationRegistry({ budget: { maxActions: 12, maxPlans: 6, deadlineMs: 120_000 } })
  const knownDirectories = () => world.knownDirectories
  const nativeObserver = createEblTaskObserver(h.db, h.userId, { knownDirectories, preconditions: world.declarations })
  const observerErrors: string[] = []
  const observeError = (phase: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    observerErrors.push(`${phase}:${message.slice(0, 300)}`)
    console.error(`native_observer:${phase}:${message.slice(0, 300)}`)
  }
  const observer: typeof nativeObserver = {
    async before(input) { try { return await nativeObserver.before(input) } catch (error) { observeError('before', error); throw error } },
    async after(input) { try { return await nativeObserver.after(input) } catch (error) { observeError('after', error); throw error } },
  }
  const snapshots = createEblRuleSnapshotPort(h.db, characterId, h.userId)
  const qualification = async () => {
    const rules = await snapshots.list()
    return { readback: rules.some(item => item.usable && item.predicate === 'readback_matches'),
      precondition: rules.some(item => item.usable && item.predicate === 'write_precondition_holds' && item.scope === 'sandbox_write_family:f1/a') }
  }
  assert.deepEqual(await qualification(), { readback: false, precondition: false }, 'no_gifted_qualification')
  for (const task of tasks) {
    const state = truth.schedule.find(item => item.taskId === task.taskId)!
    // Scenario setup is outside the planner; no truth file or marker value is passed to it.
    writeFileSync(resolve(root, task.conditionPath), state.markerValue)
    guarded = state.guardApplied
    const before = await qualification()
    const selections: SimulationPlanSelection[] = []
    let outcome: TaskRunOutcome | undefined
    let fallbackCalls = 0
    const steps: TaskPlan['steps'] = [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: task.targetPath, content: task.content } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: task.targetPath } },
    ]
    const fallback: TaskPlannerPort = { id: 'fixed-observing-calibration', endpointHost: 'offline', async plan(input) {
      fallbackCalls += 1
      if (input.failures.length > 0) return { ok: false, failure: 'call_failed', requestCount: 0 }
      return { ok: true, requestCount: 0, plan: { goal: 'calibration', done: true, steps: fallbackCalls === 1
        ? [{ capability: 'sandbox.file.read', operation: 'read', args: { path: task.conditionPath } }, ...steps] : [] } }
    } }
    const candidates: TaskPlannerPort = { id: 'fixed-candidates-calibration', endpointHost: 'offline', async plan(input) {
      if (input.executed.some(item => item.includes('sandbox.file.write') && item.includes('success'))) {
        return { ok: true, requestCount: 0, plan: { goal: 'calibration', done: true, steps: [] }, candidates: [{ goal: 'calibration', done: true, steps: [] }] }
      }
      // The existing simulation contract requires one declared candidate-generation unit.
      // This is an offline fixture, not a real model request or evidence of model cost.
      return { ok: true, requestCount: 1, plan: { goal: 'calibration', done: true, steps }, candidates: [{ goal: 'calibration', done: true, steps }] }
    } }
    const planning = createSimulationPlanning({ db: h.db, characterId, activeUserId: h.userId, registry,
      facts: { encoding: 'utf8' }, modelVersion: 'f1-readiness-calibration@1', candidatePlanner: candidates,
      precondition: { enabled: true, knownDirectories, declarations: world.declarations },
      onSelection: value => selections.push(value) })
    const turn = createActionTurnPort({ gateway, detector: createActionIntentDetector(), registry,
      attribution: { adapterId: 'f1-readiness' }, task: { authorizations, staging, resolveTarget,
        capabilitiesFor: () => ['sandbox.file.write', 'sandbox.file.read'], riskLevelFor: () => 'R1',
        planner: fallback, configurePlanning: text => planning(text, fallback), epistemic: observer,
        onTaskOutcome: value => { outcome = value } } })
    const evidence = await h.recordUserEvidence(task.requestText)
    const traceId = `f1-readiness-${task.taskId}`
    await turn.handleTurn({ characterId, traceId: asTraceId(traceId), text: task.requestText,
      eventId: String(evidence.event.id), conversationKey: String(evidence.event.conversationId),
      triggeringEvent: triggeringConversationEventOf(evidence.event), speaker: { kind: 'user', id: String(h.userId) } })
    assert.ok(outcome, 'actual_action_turn_must_enter_task_loop')
    if ((outcome.epistemicFailures ?? 0) !== 0) {
      rows.push({ taskId: task.taskId, observerErrors: [...observerErrors], results: outcome.results.map(item => ({ capability: item.request.capability, status: item.result.status })) })
    }
    assert.equal(outcome.epistemicFailures ?? 0, 0, 'native_observer_must_not_fail_silently')
    const after = await qualification()
    if (firstJoint === null && after.readback && after.precondition) firstJoint = task.ordinal
    const consumed = selections.some(item => item.preconditionVeto?.ruleStatus === 'qualified')
    if (firstConsumption === null && consumed) firstConsumption = task.ordinal
    const ledger = await exec(h.db, sql`select event_type, capability, operation, payload->'target'->>'canonicalId' as target
      from character_action_events where character_id = ${String(characterId)} and trace_id = ${traceId} order by sequence`, 'f1 readiness trace')
    rows.push({ taskId: task.taskId, ordinal: task.ordinal, marker: state.markerValue, before, after,
      consumed, selections, actions: outcome.actionsUsed, plans: outcome.plansUsed, stopped: outcome.stopped,
      actualResults: outcome.results.map(item => ({ capability: item.request.capability, status: item.result.status })), ledger })
    console.log(`${task.taskId}: readback=${Number(before.readback)}->${Number(after.readback)} precondition=${Number(before.precondition)}->${Number(after.precondition)} consumed=${consumed} stopped=${outcome.stopped}`)
  }
  assert.equal(rows.length, 8)
  assert.ok(firstJoint === null || firstJoint >= 6, 'design_joint_qualification_lower_bound')
  assert.ok(firstConsumption === null || firstConsumption >= 7, 'no_consumer_effect_in_original_first_six_window')
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ status: 'PASS', kind: 'fixed_planner_timing_calibration_not_model_or_three_arm_trial',
    worldId, firstJoint, firstConsumption, rows, modelRequests: 0, productionOpened: false,
    baselineParity: 'NOT_IMPLEMENTED' }, null, 2))
} catch (error) {
  writeFileSync(resolve(output, 'failed.json'), JSON.stringify({ status: 'FAIL', worldId, firstJoint, firstConsumption, rows,
    error: error instanceof Error ? error.message : String(error), modelRequests: 0 }, null, 2))
  throw error
} finally { await h.stop() }
