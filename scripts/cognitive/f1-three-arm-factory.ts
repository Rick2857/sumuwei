/** F1 offline shared A/B/C assembly. Real Kernel/ContextCompiler/recall/reflection ports,
 * ActionTurn/Gateway and isolated persistent history; injected offline model responses.
 * Not a live runner, sealed experiment, or evidence of model behavior/benefit.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { M4Harness } from '../m4-harness.ts'
import { PostTurnModelMemoryConsumer, deferredMemoryTurnPort } from '../../src/infrastructure/runtime/post-turn-model-memory.ts'
import { TurnGateway } from '../../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../../src/kernel/recall/selector.ts'
import { createRecallTurnPort } from '../../src/kernel/app/recall/turn.ts'
import { createMemoryRecallService } from '../../src/kernel/app/recall/retrieval.ts'
import { createMemoryRetrievalStore } from '../../src/infrastructure/persistence/memory-retrieval-store.ts'
import { memoryIntegrityProblems } from '../../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../../src/infrastructure/persistence/qualification-read.ts'
import { recentConversationEvents } from '../../src/infrastructure/persistence/conversation-store.ts'
import { readCurrentReflectionFactPack } from '../../src/infrastructure/runtime/reflection-current-state.ts'
import { runConfiguredReflectionTail } from '../../src/infrastructure/runtime/reflection-runtime.ts'
import { createLateWriteFence } from '../../src/kernel/app/reflection/late-write-fence.ts'
import { createOpenAiTaskPlanner } from '../../src/infrastructure/model/openai-task-planner.ts'
import type { ReflectionDraftProvider } from '../../src/kernel/app/reflection/draft-port.ts'
import { contentFingerprint } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { sql } from 'drizzle-orm'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionTurnPort, type ActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { createActionIntentDetector } from '../../src/kernel/action/intent-detector.ts'
import { createTaskAuthorizationRegistry, type TaskAuthorizationPort } from '../../src/kernel/action/task-authorization.ts'
import { createInMemoryPayloadStaging, type PayloadStagingPort } from '../../src/kernel/action/payload-staging.ts'
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
import { createSimulationPlanning, resolvePreconditionEntryScope } from '../../src/infrastructure/runtime/simulation-planning.ts'
import type { SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { exec } from '../../src/infrastructure/persistence/db.ts'
import type { WritePreconditionDeclaration } from '../../src/kernel/contracts/write-precondition.ts'

export type F1Arm = 'A' | 'B' | 'C'

export interface F1WorldConfig {
  worldId: string
  knownDirectories: readonly string[]
  declarations: readonly WritePreconditionDeclaration[]
}

export interface F1TaskSpec {
  worldId: string
  taskId: string
  ordinal: number
  targetPath: string
  conditionPath: string
  content: string
  requestText: string
}

export interface F1OracleEntry {
  taskId: string
  markerValue: string
  guardApplied: boolean
}

/** 一次**规划调用**的输入快照**（同形性核对的原始材料）。 */
export interface PlannerInputSnapshot {
  arm: F1Arm
  worldId: string
  taskId: string
  ordinal: number
  /** 轮次（第几次规划调用）。 */
  round: number
  task: string
  allowedCapabilities: readonly string[]
  knownDirectories: readonly string[]
  executed: readonly string[]
  failures: readonly string[]
  remainingActions: number
  traceId?: string
  /** 本任务的有界观察范围（C 有自动观察；A/B 也有**同一份**许可）。 */
  observation?: { targetPath: string; conditionPath: string; attempted: boolean }
  /** 规划端口看见的**可见规则**（按族/谓词）。 */
  visibleRules: { readback: boolean; precondition: boolean }
  messages: { role: string; content: string }[]
  contextSections: string[]
}

export interface ArmTaskRow {
  taskId: string
  ordinal: number
  marker: string
  guardApplied: boolean
  before: { readback: boolean; precondition: boolean }
  after: { readback: boolean; precondition: boolean }
  consumed: boolean
  actions: number
  plans: number
  stopped: string
  goalAchieved: boolean
  veto?: { decision: string; reason: string; observedValue?: string; fallback?: string }
  observationScheduled: boolean
  results: { capability: string; status: string }[]
  epistemicFailures: number
}

export interface ArmRun {
  arm: F1Arm
  worldId: string
  rows: ArmTaskRow[]
  plannerInputs: PlannerInputSnapshot[]
  firstJointQualification: number | null
  firstConsumption: number | null
  totalActions: number
  totalPlans: number
  achieved: number
  memoryPrompts: string[]
  memoryReadings: { status: string; throughSequence: number; created: number }[]
  reflectionRuns: unknown[]
  baseline: { contextCompiler: string; recall: boolean; reflection: boolean; candidateCount: number; budget: unknown }
  /** 预算/时限停止的原因（G8 记账；缺省不出现）。 */
  budgetStop?: string
  /** 因停止而**未运行**的任务（保留，不隐藏）。 */
  unrunTasks?: string[]
}

export interface ArmBedOptions {
  arm: F1Arm
  h: M4Harness
  world: F1WorldConfig
  tasks: readonly F1TaskSpec[]
  oracle: readonly F1OracleEntry[]
  db: unknown
  characterId: string
  userId: string
  root: string
  budget?: { maxActions: number; maxPlans: number; deadlineMs: number }
  /** 零模型**候选端口**：给出固定候选（离线夹具，不是真实模型请求）。 */
  candidatePlans: (task: F1TaskSpec) => TaskPlan[]
  /** Injected providers are offline in the parity gate; the same messages reach a live provider later. */
  fetchImpl?: typeof fetch
  memoryInvoke?: (prompt: string) => Promise<string>
  reflectionProvider?: ReflectionDraftProvider
  /** G8 正式运行器的**记账接点**（缺省不传 ⇒ 既有行为逐字不变）。 */
  onTaskStart?: (task: F1TaskSpec) => void
  /** 每个任务结束（成功或失败）都回调一次；只给记账用，不改任何判定。 */
  onTaskEnd?: (task: F1TaskSpec, row: ArmTaskRow) => void
  /** 返回非空原因 ⇒ **停止后续任务并保留未运行清单**（G8 的预算停止语义）。 */
  shouldStop?: () => string | undefined
  /**
   * 评测侧规划器超时（毫秒）。缺省 ⇒ 用产品默认（45 s）。
   * ⚠️ 真实试点实测提供方个别请求会超过 45 s，需要评测侧放宽（不改产品默认值）。
   */
  plannerTimeoutMs?: number

}

export interface ArmBed {
  arm: F1Arm
  authorizations: TaskAuthorizationPort
  staging: PayloadStagingPort
  turn: ActionTurnPort
  resolveTarget: (input: { request: { arguments: Record<string, unknown> }; operation: { sideEffect: 'none' | 'read' | 'write' | 'destructive' } | undefined }) => Promise<unknown>
  observerErrors: string[]
  plannerInputs: PlannerInputSnapshot[]
  selections: SimulationPlanSelection[]
  run: () => Promise<ArmRun>
}

/**
 * 造一个臂的**完整床位**：真实 Gateway、真实任务环、真实观察者、真实预算。
 * ⚠️ **三臂共用同一段代码** ⇒ 差异只可能来自 `arm` 这个参数。
 */
export function createArmBed(options: ArmBedOptions): ArmBed {
  const { arm, world, tasks, oracle, h } = options
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const markerPaths = [...new Set(world.declarations.map(item => item.conditionPath))]
  const fileOptions = { root: options.root, staging, conditionPaths: markerPaths }
  const writeAdapter = createSandboxWriteAdapter(fileOptions)
  let guarded = false
  const guardedWrite: CapabilityAdapter = {
    capabilityId: SANDBOX_FILE_WRITE,
    async execute(input) {
      if (guarded) {
        const marker = readFileSync(resolve(options.root, markerPaths[0]!), 'utf8').trim()
        if (marker === 'locked') throw new ActionFailureError(actionFailure('validation_failed', 'scenario_guard_locked'))
      }
      return await writeAdapter.execute(input)
    },
  }
  const resolveTarget = async ({ request, operation }: { request: { arguments: Record<string, unknown> }; operation: { sideEffect: 'none' | 'read' | 'write' | 'destructive' } | undefined }) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fileOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger: createActionLedgerStore(options.db as never), resolveTarget: resolveTarget as never,
    adapters: [createSandboxReadAdapter(fileOptions), guardedWrite], grantedPermissions: DEFAULT_GRANTED_PERMISSIONS,
    maxRiskLevel: 'R1', attribution: { decisionPointAdapterId: `f1-three-arm-${arm}`, executorAdapterId: 'sandbox-filesystem' } })
  const authorizations = createTaskAuthorizationRegistry({ budget: options.budget ?? { maxActions: 12, maxPlans: 6, deadlineMs: 120_000 } })
  const knownDirectories = () => world.knownDirectories
  const nativeObserver = createEblTaskObserver(options.db as never, options.userId, { knownDirectories, preconditions: world.declarations })
  const observerErrors: string[] = []
  const observer = {
    async before(input: Parameters<typeof nativeObserver.before>[0]) {
      try { return await nativeObserver.before(input) } catch (error) { observerErrors.push(`before:${error instanceof Error ? error.message : String(error)}`); throw error }
    },
    async after(input: Parameters<typeof nativeObserver.after>[0]) {
      try { return await nativeObserver.after(input) } catch (error) { observerErrors.push(`after:${error instanceof Error ? error.message : String(error)}`); throw error }
    },
  }
  const snapshots = createEblRuleSnapshotPort(options.db as never, options.characterId as never, options.userId)
  const plannerInputs: PlannerInputSnapshot[] = []
  const selections: SimulationPlanSelection[] = []
  let lastOutcome: TaskRunOutcome | undefined

  let candidateMode: 'ordinary' | 'simulation' = 'ordinary'
  let compiledText = ''
  let contextSections: string[] = []
  let activeTask: F1TaskSpec | undefined
  let activeInput: Parameters<TaskPlannerPort['plan']>[0] | undefined
  const qualification = async () => {
    const rules = await snapshots.list()
    return { readback: rules.some(item => item.usable && item.predicate === 'readback_matches'),
      precondition: rules.some(item => item.usable && item.predicate === 'write_precondition_holds' && item.scope === 'sandbox_write_family:f1/a') }
  }
  const planner = createOpenAiTaskPlanner({ registry, candidateCount: 3, maxTokens: 4096,
    /*
     * ⚠️ **评测侧**规划器超时（不是产品默认 45 s）：
     *    首次真实试点实测：提供方个别请求会在 45 s 边界被产品默认超时 abort（`This operation was aborted`），
     *    且没有 usage ⇒ 成本无法确认 ⇒ 按冻结政策整条序列停止。
     *    ⇒ 评测侧显式放宽到 90 s（产品默认值不变），配合单题时限 600 s（6 次 × 90 s + 余量）。
     */
    ...(options.plannerTimeoutMs === undefined ? {} : { timeoutMs: options.plannerTimeoutMs }),
    env: { OPENAI_API_KEY: 'offline-fixture', OPENAI_BASE_URL: 'https://offline.invalid/v1', OPENAI_SMALL_MODEL: 'offline-fixture' },
    async fetchImpl(url, init) {
      assert.ok(activeTask && activeInput, 'planner_call_scope_required')
      const body = JSON.parse(String(init?.body))
      body.messages.splice(1, 0, { role: 'user', content: compiledText + '\n受信候选条件声明（仅为待验证假设形状，不表示规律成立）：\n' + JSON.stringify(world.declarations) })
      if (candidateMode === 'simulation') body.messages[0].content += '\n当前为受限模拟候选：候选每一步只能操作请求中的目标文件；条件标记的观察由受信程序另行安排，不放进候选。'
      plannerInputs.push({ arm, worldId: world.worldId, taskId: activeTask.taskId, ordinal: activeTask.ordinal,
        round: plannerInputs.filter(item => item.taskId === activeTask!.taskId).length + 1,
        task: activeInput.task, allowedCapabilities: [...activeInput.allowedCapabilities], knownDirectories: [...knownDirectories()],
        executed: [...activeInput.executed], failures: [...activeInput.failures], remainingActions: activeInput.remainingActions,
        ...(activeInput.traceId === undefined ? {} : { traceId: activeInput.traceId }),
        ...(activeInput.observation === undefined ? {} : { observation: { ...activeInput.observation } }),
        visibleRules: await qualification(), messages: body.messages, contextSections: [...contextSections] })
      if (options.fetchImpl !== undefined) return options.fetchImpl(url, { ...init, body: JSON.stringify(body) })
      // Offline transport exercises the production request builder and strict parser, without networking.
      const completed = activeInput.executed.some(item => item.includes('sandbox.file.write') && item.includes('success'))
        && activeInput.executed.some(item => item.includes(activeTask!.targetPath) && item.includes('sandbox.file.read') && item.includes('success'))
      const plans = completed ? [{ goal: 'done', done: true, steps: [] }] : options.candidatePlans(activeTask).map(plan => ({ ...plan,
        steps: plan.steps.filter(step => !(step.capability === 'sandbox.file.read' && step.args.path === activeTask!.conditionPath && (candidateMode === 'simulation' || activeInput!.observation?.attempted))) }))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: plans }) } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const candidatePlanner: TaskPlannerPort = { ...planner, async plan(input) {
    activeInput = input
    candidateMode = 'simulation'
    return planner.plan(input)
  } }
  const ordinaryPlanner: TaskPlannerPort = { ...candidatePlanner, async plan(input) {
    activeInput = input
    candidateMode = 'ordinary'
    const outcome = await planner.plan(input)
    if (!outcome.ok || arm !== 'B' || activeTask === undefined) return outcome
    // B uses only target/content/readback checks, never the condition value or oracle.
    const matching = outcome.candidates?.find(plan => plan.steps.filter(step => step.capability === 'sandbox.file.write'
      && step.args.path === activeTask!.targetPath).at(-1)?.args.content === activeTask!.content
      && plan.steps.at(-1)?.capability === 'sandbox.file.read' && plan.steps.at(-1)?.args.path === activeTask!.targetPath)
    return matching === undefined ? outcome : { ...outcome, plan: matching }
  } }

  const planning = createSimulationPlanning({ db: options.db as never, characterId: options.characterId as never,
    activeUserId: options.userId, registry, facts: { encoding: 'utf8' }, modelVersion: 'f1-three-arm@1',
    candidatePlanner, precondition: { enabled: true, knownDirectories, declarations: world.declarations },
    onSelection: value => selections.push(value) })

  /**
   * A/B 的装配：**只**给入口与范围，不给模拟规划器（不消费族规则、无自动观察）。
   * ⚠️ 范围来自**产品同一份解析口**（`resolvePreconditionEntryScope`）⇒ 不手抄。
   */
  const baselineConfigurePlanning = (text: string, fallback?: TaskPlannerPort) => {
    const resolved = resolvePreconditionEntryScope({ enabled: true, text, knownDirectories, declarations: world.declarations })
    if (resolved.kind === 'rejected') {
      return { entryRejected: resolved.reason, planner: fallback ?? ordinaryPlanner, ruleSnapshot: snapshots, usableRuleIds: [] }
    }
    if (resolved.kind !== 'entry') return undefined
    const planner = fallback ?? ordinaryPlanner
    return { planner, ruleSnapshot: snapshots, usableRuleIds: [], entryKind: 'precondition_two_line' as const,
      boundedObservation: { targetPath: resolved.targetPath, conditionPath: resolved.conditionPath, maxReads: 1 } }
  }

  const turn = createActionTurnPort({ gateway, detector: createActionIntentDetector(), registry,
    attribution: { adapterId: `f1-three-arm-${arm}` },
    task: { authorizations, staging, resolveTarget: resolveTarget as never,
      capabilitiesFor: () => ['sandbox.file.write', 'sandbox.file.read'], riskLevelFor: () => 'R1',
      planner: ordinaryPlanner,
      configurePlanning: async (text: string, fallback?: TaskPlannerPort) => arm === 'C'
        ? await planning(text, fallback)
        : await baselineConfigurePlanning(text, fallback),
      epistemic: observer,
      replanContext: { knownDirectories, contentTokens: 1200, evidenceTokens: 0 },
      onTaskOutcome: value => { lastOutcome = value } } })

  const recall = createRecallTurnPort({ service: createMemoryRecallService({ port: createMemoryRetrievalStore({
    store: h.store, integrity: owner => memoryIntegrityProblems(h.db, owner), rootReadings: ids => rootReadingsByMemory(h.db, ids),
  }) }), budget: DEFAULT_CONTEXT_BUDGET, injectionLimit: 3, now: () => Date.now() })
  const turnGateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
    recorder: h.recorder, conversationSequence: h.nextTurnSequence, userId: h.userId, slowPathEnabled: false,
    actionEnabled: false, recall, recallEnabled: true, tokenBudget: 4000, recallBudget: DEFAULT_CONTEXT_BUDGET,
    memoryExplicitEnabled: true, memoryWriter: deferredMemoryTurnPort() })
  const memoryPrompts: string[] = []
  const memoryReadings: ArmRun['memoryReadings'] = []
  const automaticMemory = new PostTurnModelMemoryConsumer({ db: h.db, characterId: h.kernel.characterId,
    speaker: h.user, registry: h.kernel.registry, invoke: async prompt => { memoryPrompts.push(prompt)
      return options.memoryInvoke === undefined ? '{"destination":"none","decisions":[]}' : options.memoryInvoke(prompt) },
    onReading: reading => memoryReadings.push(reading) })
  const reflectionRuns: unknown[] = []
  const fence = createLateWriteFence()
  const reflectionProvider = options.reflectionProvider ?? { name: 'offline-fixture', version: '1', async call() { return {} } }

  const run = async (): Promise<ArmRun> => {
    const rows: ArmTaskRow[] = []
    const unrunTasks: string[] = []
    let budgetStop: string | undefined
    let firstJoint: number | null = null
    let firstConsumption: number | null = null
    await automaticMemory.open()
    await automaticMemory.drain()
    try {
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex]!
      const stopReason = options.shouldStop?.()
      if (stopReason !== undefined) {
        budgetStop = stopReason
        unrunTasks.push(...tasks.slice(taskIndex).map(item => item.taskId))
        break
      }
      options.onTaskStart?.(task)
      const state = oracle.find(item => item.taskId === task.taskId)!
      // 受信场景执行器在**任务前**设置条件（模型看不见，也不许写）。
      writeFileSync(resolve(options.root, task.conditionPath), state.markerValue)
      guarded = state.guardApplied
      const before = await qualification()
      lastOutcome = undefined
      const before_ = selections.length
      activeTask = task
      const incoming = await turnGateway.beginTurn(task.requestText)
      assert.ok(incoming.userEvent, 'recorded_user_event_required')
      const recent = await recentConversationEvents(h.db, { characterId: h.kernel.characterId, conversationId: incoming.userEvent.conversationId, limit: 16 })
      const packet = await turnGateway.compileTurn({ turn: incoming, currentInput: task.requestText,
        recentLines: recent.filter(event => event.id !== incoming.userEvent!.id).map(event => ({ id: event.id, sequence: event.sequence,
          speaker: event.actorId ?? event.actorType, actorType: event.actorType, text: event.content, sourceKind: event.sourceKind })),
        buildReflectionFactPack: () => readCurrentReflectionFactPack(h.db, h.kernel.characterId, h.userId) })
      compiledText = packet.text
      contextSections = packet.sections.map(section => section.id)
      const evidence = { event: incoming.userEvent }
      const traceId = `f1-arm-${arm}-${task.taskId}`
      await turn.handleTurn({ characterId: options.characterId as never, traceId: asTraceId(traceId), text: task.requestText,
        eventId: String(evidence.event.id), conversationKey: String(evidence.event.conversationId),
        triggeringEvent: triggeringConversationEventOf(evidence.event as never), speaker: { kind: 'user', id: options.userId } })
      // ⚠️ 用断言读取：TypeScript 看不到闭包里的赋值，会把 `lastOutcome` 收窄成 `undefined`。
      const outcome = lastOutcome as TaskRunOutcome | undefined
      const after = await qualification()
      const armSelections = selections.slice(before_)
      const veto = armSelections.find(item => item.preconditionVeto !== undefined)?.preconditionVeto
      const consumed = armSelections.some(item => item.preconditionVeto?.ruleStatus === 'qualified')
      if (firstJoint === null && after.readback && after.precondition) firstJoint = task.ordinal
      if (firstConsumption === null && consumed) firstConsumption = task.ordinal
      const ledger = await exec(options.db as never, sql`select event_type, capability, operation,
        payload->'target'->>'canonicalId' as target from character_action_events
        where character_id = ${options.characterId} and trace_id = ${traceId} order by sequence`, 'f1 three arm trace')
      const targetWrites = ledger.filter(item => item.capability === 'sandbox.file.write'
        && item.operation === 'write' && item.target === task.targetPath && item.event_type === 'ACTION_SUCCEEDED')
      assert.ok(outcome, 'actual_task_outcome_required')
      rows.push({ taskId: task.taskId, ordinal: task.ordinal, marker: state.markerValue, guardApplied: state.guardApplied,
        before, after, consumed, actions: outcome?.actionsUsed ?? 0, plans: outcome?.plansUsed ?? 0, stopped: outcome?.stopped ?? 'no_outcome',
        goalAchieved: targetWrites.length > 0 && existsSync(resolve(options.root, task.targetPath))
          && contentFingerprint(readFileSync(resolve(options.root, task.targetPath), 'utf8')) === contentFingerprint(task.content)
          && outcome.results.at(-1)?.request.capability === 'sandbox.file.read'
          && outcome.results.at(-1)?.request.arguments.path === task.targetPath && outcome.results.at(-1)?.result.status === 'success',
        ...(veto === undefined ? {} : { veto: { decision: veto.decision, reason: veto.reason,
          ...(veto.observedValue === undefined ? {} : { observedValue: veto.observedValue }),
          ...(veto.fallback === undefined ? {} : { fallback: veto.fallback }) } }),
        observationScheduled: armSelections.some(item => item.conditionObservation !== undefined),
        results: outcome?.results.map(item => ({ capability: item.request.capability, status: item.result.status })) ?? [],
        epistemicFailures: outcome.epistemicFailures ?? 0 })
      await turnGateway.completeTurn({ turn: incoming, replyText: JSON.stringify({ stopped: outcome.stopped,
        results: outcome.results.map(item => ({ capability: item.request.capability, status: item.result.status })) }) })
      await automaticMemory.drain()
      reflectionRuns.push(await runConfiguredReflectionTail(h.db, { characterId: h.kernel.characterId, activeUserId: h.userId,
        reflectionEnabled: true, adaptiveEnabled: false, provider: reflectionProvider, fence, signal: new AbortController().signal }))
      options.onTaskEnd?.(task, rows[rows.length - 1]!)
    }
    return { arm, worldId: world.worldId, rows, plannerInputs,
      firstJointQualification: firstJoint, firstConsumption,
      totalActions: rows.reduce((sum, row) => sum + row.actions, 0),
      totalPlans: rows.reduce((sum, row) => sum + row.plans, 0),
      achieved: rows.filter(row => row.goalAchieved).length, reflectionRuns, memoryPrompts, memoryReadings,
      ...(budgetStop === undefined ? {} : { budgetStop }),
      ...(unrunTasks.length === 0 ? {} : { unrunTasks }),
      baseline: { contextCompiler: 'TurnGateway/ContextCompilerV2', recall: true, reflection: true, candidateCount: 3,
        budget: options.budget ?? { maxActions: 12, maxPlans: 6, deadlineMs: 120_000 } } }
    } finally { await automaticMemory.close() }
  }

  return { arm, authorizations, staging, turn, resolveTarget: resolveTarget as never, observerErrors, plannerInputs, selections, run }
}

/** 装载预注册的数据（世界 / 任务 / 真值）。 */
export function loadPreregData(dataRoot = resolve('docs/architecture/f1-preregistration-20261024')) {
  const load = (name: string) => JSON.parse(readFileSync(resolve(dataRoot, name), 'utf8'))
  const worlds = (load('worlds.json') as { worlds: { worldId: string; knownDirectories: string[]; declarations: WritePreconditionDeclaration[] }[] }).worlds
  const tasks = (load('tasks.json') as { tasks: F1TaskSpec[] }).tasks
  const oracle = (load('oracle.json') as { perWorld: { worldId: string; schedule: F1OracleEntry[] }[] }).perWorld
  return { worlds, tasks, oracle }
}

export function ensureWorldDirectories(root: string, directories: readonly string[]): void {
  for (const directory of directories) mkdirSync(resolve(root, directory), { recursive: true })
}

export function simulatorPreconditions(): boolean {
  return process.platform === 'linux' && existsSync('/opt/serversim/supervisor.mjs')
}
