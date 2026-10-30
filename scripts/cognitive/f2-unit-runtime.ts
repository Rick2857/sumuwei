/**
 * **F2 单元执行编排**（一个单元 = 3 臂 × 2 候选顺序之一；一次性 PostgreSQL + 独立文件根）。
 *
 * 同一条编排同时服务两种模式（**规划器注入不同，其余完全相同**）：
 * ```text
 * ① offline  —— 固定候选规划器（零模型请求），**只给门用**；报告标 evidenceKind='offline_mechanism'
 * ② real     —— 真实模型规划器（由 f2-live-runner 在**已授权**的封存下构造）；报告标 evidenceKind='real'
 * ```
 * ⚠️ 本模块**不**创建模型请求：请求由注入的规划器发出；这里只做**计量**（发出前计数、响应后按 usage 扣账）。
 * ⚠️ 调用方必须先 `isolateDatabase(...)`（本模块里的 db 相关模块都是**调用时**动态 import）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { F2FormalSequence } from './f2-live-runner-guards.ts'

export type F2Arm = 'A' | 'B' | 'C'
export type F2Order = 'cached-first' | 'authoritative-first'

/** 计量端口（与 `f2-live-runner-guards.ts` 的 `F2RequestMeter` 结构兼容；只列这里用到的成员）。 */
export interface F2UnitMeter {
  beforeRequest(taskId: string): { readonly ok: true } | { readonly ok: false, readonly code: string }
  charge(taskId: string, purpose: string, rawUsage: unknown): { readonly charged: number, readonly costConfirmed: boolean, readonly stopCode?: string }
  /** 客户端 abort 的有界未确认结算（政策 A）。 */
  chargeBoundedUnconfirmed(taskId: string, purpose: string, reason: string): { readonly charged: number, readonly costConfirmed: boolean, readonly stopCode?: string, readonly boundedAborts: number }
  state(): { readonly requests: number, readonly tokens: number, readonly costVerifiable: boolean, readonly stopCode?: string }
  readonly attempts: readonly { readonly taskId: string, readonly purpose: string, readonly charged: number, readonly costConfirmed: boolean, readonly bounded?: boolean }[]
}

export interface F2UnitObjectPaths {
  readonly family: string
  readonly object: string
  readonly target: string
  readonly cache: string
  readonly authority: string
  readonly marker: string
  readonly cachedBytes: string
  readonly authBytes: string
}

/** 规划器上下文（给注入的规划器：它要按候选顺序/臂/对象挑候选）。 */
export interface F2UnitPlannerContext {
  readonly unit: string
  readonly arm: F2Arm
  readonly order: F2Order
  readonly paths: F2UnitObjectPaths
  readonly cacheFirstPlan: unknown
  readonly authoritativeFirstPlan: unknown
}

export interface F2UnitPlanner {
  readonly id: string
  readonly endpointHost: string
  plan(input: unknown, context: F2UnitPlannerContext): Promise<{
    readonly ok: boolean
    readonly plan?: unknown
    readonly candidates?: readonly unknown[]
    readonly failure?: string
    readonly requestCount?: number
    /** 计量被拒（闭集码）：编排层记 `meterCode`，**不再**二次扣账。 */
    readonly refusal?: string
    /** 物理请求的 usage 缺失 ⇒ 成本不可确认（计量器置位，编排层如实上报）。 */
    readonly costUnverifiable?: boolean
    /** 候选顺序因子是否真的落地（第一候选来源桶 + 全部桶）。 */
    readonly orderApplied?: unknown
  }>
}

export interface F2UnitOptions {
  readonly unit: string
  readonly arm: F2Arm
  readonly order: F2Order
  readonly sequence: Pick<F2FormalSequence, 'family' | 'formation' | 'measurement'>
  /** 一次性库的 URL（调用方已 `isolateDatabase`；这里不再建库）。 */
  readonly dbUrl: string
  /** 独立文件根（每单元一个）。 */
  readonly root: string
  readonly out: string
  readonly evidenceKind: 'offline_mechanism' | 'gate_fake_fetch' | 'real'
  readonly plannerFactory: (context: F2UnitPlannerContext) => F2UnitPlanner
  readonly meter: F2UnitMeter
  readonly sequenceId: string
  /** 崩溃恢复：已完成题（来自任务账本）⇒ 原样取回、**不重跑**。 */
  readonly resume?: Readonly<Record<string, F2UnitTaskRow>>
  /** 任务账本钩子（只记测量题；形成题脚本固定、不参与恢复）。 */
  readonly onTaskStart?: (taskId: string) => void
  readonly onTaskFinish?: (taskId: string, row: F2UnitTaskRow) => void
  /** ⚠️ 门用：完成 N 题后**模拟崩溃**（在下一题的 task_started 之后抛错；真实路径不设）。 */
  readonly crashAfterTasks?: number
}

export interface F2UnitTaskRow {
  readonly phase: 'formation' | 'measurement'
  readonly role: string
  readonly object: string
  readonly condition: string
  readonly achieved: boolean
  readonly stopped: string
  readonly actions: number
  readonly plans: number
  readonly failedWrites: number
  readonly candidateCalls: number
  /** 本次任务里**真实发出**的物理请求数（B=0；与 candidateCalls 分开统计）。 */
  readonly physicalRequests: number
  readonly recovered?: boolean
  readonly orderFirstCandidate?: string
  readonly fileTruth: boolean
  readonly vetoed: boolean
  readonly vetoReason?: string
  readonly observedValue?: unknown
  readonly attributions: readonly string[]
  readonly meterCode?: string
  /** task-loop 的失败码（如 task_goal_unmet / task_check_refuted / task_plan_no_progress），失败关闭时不丢。 */
  readonly rejectedCode?: string
  /** 完整选择轨迹（所有轮次，不只是最后一次）。 */
  readonly selectionTrace?: readonly {
    readonly phase: string
    readonly vetoed: boolean
    readonly reason?: string
    readonly observedValue?: unknown
    readonly attributions: readonly string[]
    /** 规则身份与来源作用域（"规则确实改变选择"必须可核对，而不只是字段存在）。 */
    readonly ruleId?: string
    readonly claimId?: string
    readonly ruleStatus?: string
    readonly sourceScope?: string
    readonly conditionPath?: string
    readonly conditionSource?: string
    readonly vetoedCandidateIds?: readonly string[]
    readonly selectedCandidateId?: string
  }[]
  readonly selectionRounds?: number
  readonly vetoRounds?: number
  readonly vetoReasonCounts?: Readonly<Record<string, number>>
  readonly selectionPhases?: Readonly<Record<string, number>>
  readonly usageConfirmedTokens?: number
  readonly provisionalTokens?: number
  readonly unconfirmedEvents?: number
  readonly boundedAbortEvents?: number
}

export interface F2UnitReport {
  readonly schema: 'f2-unit-report@1'
  readonly unit: string
  readonly arm: F2Arm
  readonly order: F2Order
  readonly evidenceKind: 'offline_mechanism' | 'gate_fake_fetch' | 'real'
  readonly sequenceId: string
  readonly realModelRequests: number
  readonly costConfirmed: boolean
  readonly stopCode?: string
  readonly formation: {
    readonly tasks: readonly F2UnitTaskRow[]
    readonly qualified: boolean
    readonly evidence: readonly { readonly verdict: string, readonly independent?: boolean }[]
    readonly hasControl: boolean
  }
  readonly measurement: readonly F2UnitTaskRow[]
  readonly totals: {
    readonly formationActions: number
    readonly measurementActions: number
    readonly failedWrites: number
    readonly candidateCalls: number
    readonly physicalRequests: number
    readonly achieved: number
    readonly tasks: number
    readonly requests: number
    readonly tokens: number
    /** 成本三分类：已确认 / 暂扣（有界 abort） / 未确认事件。 */
    readonly usageConfirmedTokens: number
    readonly provisionalTokens: number
    readonly unconfirmedEvents: number
    readonly boundedAbortEvents: number
  }
  readonly db: { readonly name: string, readonly user: string }
  readonly recoveredTaskIds: readonly string[]
  /** **本次运行**实际发生的量（不含从账本取回的历史行）。 */
  readonly thisRun: { readonly physicalRequests: number, readonly plannerCalls: number }
  readonly meter: { readonly requests: number, readonly tokens: number, readonly costVerifiable: boolean, readonly stopCode?: string, readonly attempts: number }
  readonly boundaries: readonly string[]
}

/** 对象路径（与协议 `objectPathTemplate` 一致）。 */
export function f2UnitPaths(family: string, object: string, condition: 'fresh' | 'stale'): F2UnitObjectPaths {
  const stem = `${family}/${object}`
  const authBytes = `auth:${object}`
  return {
    family, object,
    target: `${stem}.txt`, cache: `${stem}.cache`, authority: `${stem}.src`, marker: `${family}/.freshness`,
    cachedBytes: condition === 'stale' ? `stale:${object}` : authBytes, authBytes,
  }
}

/**
 * 跑一个单元：形成 4 题（脚本固定、零模型）→ 测量 6 题（注入规划器、逐次计量）。
 * 计量纪律：
 * - `beforeRequest` 在**发出前**调用；被拒 ⇒ 该题不再调用规划器（`meterCode` 记在行上）；
 * - 规划器返回后 `charge` 扣账；`costConfirmed=false` ⇒ 置 `stopCode='cost_unverifiable'` 并**停后续请求**；
 * - 逐题上限只拒该题（不钉死整条序列）。
 */
export async function runF2Unit (options: F2UnitOptions): Promise<F2UnitReport> {
  const { createM4Harness } = await import('../m4-harness.ts')
  const { createActionGateway } = await import('../../src/kernel/action/gateway.ts')
  const { createActionLedgerStore } = await import('../../src/infrastructure/action/action-ledger-store.ts')
  const fsAdapters = await import('../../src/infrastructure/action/adapters/sandbox-filesystem.ts')
  const { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS, SANDBOX_FILE_WRITE } = await import('../../src/kernel/action/capability-registry.ts')
  const { createInMemoryPayloadStaging } = await import('../../src/kernel/action/payload-staging.ts')
  const { resolveActionTarget } = await import('../../src/kernel/action/target-resolver.ts')
  const { hasSideEffect } = await import('../../src/kernel/action/action-request.ts')
  const { createTaskAuthorizationRegistry } = await import('../../src/kernel/action/task-authorization.ts')
  const { asTraceId } = await import('../../src/kernel/contracts/ids.ts')
  const { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } =
    await import('../../src/kernel/contracts/attribution.ts')
  const { createEblTaskObserver } = await import('../../src/infrastructure/runtime/epistemic-belief-runtime.ts')
  const { createEblStore } = await import('../../src/infrastructure/persistence/epistemic-belief-store.ts')
  const { createEblSourceReader, EBL_TOOL_ENVIRONMENT } = await import('../../src/infrastructure/persistence/epistemic-belief-source.ts')
  const { makeEblClaim } = await import('../../src/kernel/contracts/epistemic-belief.ts')
  const { sandboxWriteFamilyScope } = await import('../../src/kernel/contracts/write-family.ts')
  const { writePreconditionConditions } = await import('../../src/kernel/contracts/write-precondition.ts')
  const { createSimulationPlanning, f2QualifiedFamilyRuleIds } = await import('../../src/infrastructure/runtime/simulation-planning.ts')
  const { createActionTurnPort } = await import('../../src/kernel/action/action-turn.ts')
  const { createActionIntentDetector } = await import('../../src/kernel/action/intent-detector.ts')
  const { runTask } = await import('../../src/kernel/action/task-loop.ts')
  const { actionFailure, ActionFailureError } = await import('../../src/kernel/action/errors.ts')
  const { exec } = await import('../../src/infrastructure/persistence/db.ts')
  const { sql } = await import('drizzle-orm')

  const { unit, arm, order, sequence, root, out, evidenceKind, meter } = options
  const family = sequence.family
  const wrongFamily = 'f4/a'
  const marker = `${family}/.freshness`
  const declaration = { familyId: family, conditionPath: marker, mustNotEqual: 'stale' }
  mkdirSync(root, { recursive: true })
  mkdirSync(out, { recursive: true })
  const h = await createM4Harness({ label: `f2-unit-${unit}`, userId: 'Alex' })
  try {
    /* 数据库身份：库名必须带 `lg_test_` 前缀（隔离判据）；否则**拒绝**跑（不猜）。 */
    const dbRows = await exec(h.db, sql`select current_database() as name, current_user as name2`, 'f2unit identity')
    const db = {
      name: String((dbRows[0] as { name?: unknown } | undefined)?.name ?? ''),
      user: String((dbRows[0] as { name2?: unknown } | undefined)?.name2 ?? ''),
    }
    if (!db.name.startsWith('lg_test_')) throw new Error(`f2_unit_db_not_isolated:${db.name}`)
    const characterId = h.kernel.characterId
    const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
    const staging = createInMemoryPayloadStaging()
    const conditionPaths = [marker]
    const fsOptions = { root, staging, conditionPaths, exposeReadContent: true }
    const guardedWrite = {
      capabilityId: SANDBOX_FILE_WRITE,
      async execute (input: unknown): Promise<unknown> {
        const args = (input as { args: Record<string, unknown> }).args
        const path = String(args.path)
        if (path.endsWith('.txt')) {
          const raw = typeof args.content === 'string' ? args.content : staging.read(String(args.payloadRef))
          const content = typeof raw === 'string' ? raw : raw?.kind === 'text' ? raw.text : undefined
          if (content !== readFileSync(resolve(root, path.replace(/\.txt$/, '.src')), 'utf8')) {
            throw new ActionFailureError(actionFailure('validation_failed', '内容与权威源不一致'))
          }
        }
        return fsAdapters.createSandboxWriteAdapter({ root, staging, conditionPaths }).execute(input as never)
      },
    }
    const resolveTarget = async (input: unknown) => {
      const request = (input as { request: { arguments: Record<string, unknown> } }).request
      const operation = (input as { operation?: { sideEffect?: string } }).operation
      return resolveActionTarget({
        targetType: 'sandbox_file',
        hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
        listEntries: () => fsAdapters.listSandboxEntries(fsOptions),
        allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect as never),
      })
    }
    const gateway = createActionGateway({
      registry, ledger: createActionLedgerStore(h.db),
      adapters: [fsAdapters.createSandboxReadAdapter(fsOptions), guardedWrite as never],
      grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
      attribution: { decisionPointAdapterId: 'f2-unit', executorAdapterId: 'sandbox-filesystem' },
    })
    const authorizations = createTaskAuthorizationRegistry()
    const knownDirectories = () => [family, wrongFamily]
    const writeSources = (path: string) => [
      { kind: 'cache' as const, path: path.replace(/\.txt$/, '.cache') },
      { kind: 'authoritative' as const, path: path.replace(/\.txt$/, '.src') },
    ]
    const observer = createEblTaskObserver(h.db, h.userId, { knownDirectories, writeSources, preconditions: [declaration] })
    const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
    const initiatorFor = (event: { id: string }) => attestActionInitiatorFromCausalOrigin({
      adapterId: 'f2-unit',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'f2-unit', triggeringEvent: triggeringConversationEventOf(event as never) }),
    })
    const prepare = (item: { object: string, condition: string }): F2UnitObjectPaths => {
      const paths = f2UnitPaths(family, item.object, item.condition as 'fresh' | 'stale')
      mkdirSync(resolve(root, family), { recursive: true })
      writeFileSync(resolve(root, paths.authority), paths.authBytes)
      writeFileSync(resolve(root, paths.cache), paths.cachedBytes)
      writeFileSync(resolve(root, paths.marker), item.condition)
      writeFileSync(resolve(root, paths.target), `unset:${item.object}`)
      return paths
    }
    const read = (path: string) => ({ capability: 'sandbox.file.read', operation: 'read', args: { path } })
    const write = (path: string, content: string) => ({ capability: 'sandbox.file.write', operation: 'write', args: { path, content } })
    const planOf = (steps: readonly unknown[], done = false) => ({ goal: 'f2', done, steps })
    const entryText = (object: string): string => {
      const stem = `${family}/${object}`
      return `F2 只操作相对路径 ${stem}.txt；缓存源 ${stem}.cache；权威源 ${stem}.src；族标记 ${family}/.freshness，最多读一次。`
    }
    const actionsOf = async (traceId: string): Promise<{ reads: number, failures: number }> => {
      const readRows = await exec(h.db, sql`select count(distinct action_id)::int as count from character_action_events
        where character_id = ${String(characterId)} and trace_id = ${traceId} and capability = 'sandbox.file.read'
        and event_type = 'ACTION_SUCCEEDED'`, 'f2unit reads')
      const failRows = await exec(h.db, sql`select count(distinct action_id)::int as count from character_action_events
        where character_id = ${String(characterId)} and trace_id = ${traceId} and capability = 'sandbox.file.write'
        and event_type = 'ACTION_FAILED'`, 'f2unit failures')
      return { reads: Number(readRows[0]?.count ?? 0), failures: Number(failRows[0]?.count ?? 0) }
    }
    const stopCodeRef = { code: undefined as string | undefined }
    const taskRows: F2UnitTaskRow[] = []
    const formationRows: F2UnitTaskRow[] = []
    const record = (phase: 'formation' | 'measurement', role: string, paths: F2UnitObjectPaths, condition: string,
      result: { recorded: boolean, stopped: string, actions: number, plans: number, achieved: boolean },
      extra: { failedWrites: number, candidateCalls: number, physicalRequests?: number, meterCode?: string, vetoed?: boolean, vetoReason?: string,
        observedValue?: unknown, attributions?: readonly string[] }): void => {
      let fileTruth = false
      try { fileTruth = readFileSync(resolve(root, paths.target), 'utf8') === paths.authBytes } catch { fileTruth = false }
      const row: F2UnitTaskRow = {
        phase, role, object: paths.object, condition,
        achieved: result.achieved, stopped: result.stopped, actions: result.actions, plans: result.plans,
        failedWrites: extra.failedWrites, candidateCalls: extra.candidateCalls,
        physicalRequests: extra.physicalRequests ?? 0, fileTruth,
        vetoed: extra.vetoed === true, vetoReason: extra.vetoReason, observedValue: extra.observedValue,
        attributions: extra.attributions ?? [], meterCode: extra.meterCode,
      }
      taskRows.push(row)
      if (phase === 'formation') formationRows.push(row)
    }

    // ---------------- ① 形成阶段：脚本固定 4 题（零模型请求） ----------------
    for (const [index, item] of (sequence.formation as readonly { object: string, condition: string, role: string }[]).entries()) {
      const paths = prepare(item)
      const evidence = await h.recordUserEvidence(`形成 ${unit} #${String(index)}`)
      const authorization = authorizations.issue({
        conversationKey: String(evidence.event.conversationId), originalText: `形成 ${unit} ${item.object}`,
        triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'],
        maxRiskLevel: 'R1', budget: { maxActions: 8, maxPlans: 3, deadlineMs: 600_000 },
      })
      const scripted = planOf([read(paths.marker), read(paths.cache), write(paths.target, paths.cachedBytes), read(paths.target)], true)
      let planned = false
      const planner = {
        id: `f2-unit-formation-${unit}`, endpointHost: 'offline',
        async plan () {
          if (planned) return { ok: true, requestCount: 0, plan: planOf([], true) }
          planned = true
          return { ok: true, requestCount: 0, plan: scripted }
        },
      }
      const formationTraceId = `f2unit-train-${unit}-${String(index)}`
      const outcome = await runTask({
        gateway, registry, authorizations, staging, resolveTarget, epistemic: observer,
        invocationFor: () => ({ initiatorEvidence: initiatorFor(evidence.event), riskBudgetOverride: 'R1' }), planner: planner as never,
      }, { characterId, traceId: asTraceId(formationTraceId), authorization, text: `形成 ${item.object}` })
      /* ⚠️ 形成阶段的失败写**真实计数**（此前固定填 0，属已知缺陷）。 */
      const formationCounts = await actionsOf(formationTraceId)
      record('formation', item.role, paths, item.condition,
        { recorded: true, stopped: String(outcome.stopped ?? 'none'), actions: outcome.actionsUsed, plans: outcome.plansUsed, achieved: false },
        { failedWrites: formationCounts.failures, candidateCalls: 0 })
    }
    const formationClaim = makeEblClaim({
      characterId: String(characterId), subjectId: h.userId, domain: 'tool',
      predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(family),
      environment: EBL_TOOL_ENVIRONMENT,
      conditions: writePreconditionConditions({ familyId: family, conditionPath: marker, mustNotEqual: 'stale' }, 'cache'),
      formation: { kind: 'action', id: 'shape' },
    }).id
    const formationState = await store.get(formationClaim) as unknown as {
      tests?: readonly { id: string }[]
      evidence?: readonly { testId: string, verdict: string, independent?: boolean, observation?: { witnessed?: boolean, executed?: boolean, complete?: boolean, value?: unknown } }[]
    } | undefined
    const formationEvidence = (formationState?.evidence ?? []).map(item => ({ test: item.testId, verdict: item.verdict, independent: item.independent,
      witnessed: item.observation?.witnessed, executed: item.observation?.executed, complete: item.observation?.complete,
      value: item.observation?.value }))
    const hasControl = (formationState?.evidence ?? []).some(item => item.verdict === 'inconclusive' && item.observation?.witnessed
      && item.observation?.executed && item.observation?.complete && item.observation?.value === undefined)
    const qualifiedIds = await f2QualifiedFamilyRuleIds({
      db: h.db, characterId, activeUserId: h.userId, familyId: family, declarations: [declaration], writeSources,
    })
    const qualified = qualifiedIds.length > 0

    // ---------------- ② 测量阶段：6 题（注入规划器；逐次计量） ----------------
    const measurementRows: F2UnitTaskRow[] = []
    const recoveredTaskIds: string[] = []
    for (const item of (sequence.measurement as readonly { object: string, condition: string }[])) {
      const taskId = `${unit}:${item.object}`
      /* 崩溃恢复：账本里已完成的题**原样取回**（不重跑、不补采）。 */
      const recoveredRow = options.resume?.[taskId]
      if (recoveredRow !== undefined) {
        recoveredTaskIds.push(taskId)
        measurementRows.push(recoveredRow)
        taskRows.push(recoveredRow)
        continue
      }
      options.onTaskStart?.(taskId)
      if (options.crashAfterTasks !== undefined && measurementRows.length >= options.crashAfterTasks) {
        throw new Error('f2_gate_crash_simulated')
      }
      const paths = prepare(item)
      const cachePlan = planOf([write(paths.target, paths.cachedBytes), read(paths.target)], true)
      const authPlan = planOf([write(paths.target, paths.authBytes), read(paths.target)], true)
      const context: F2UnitPlannerContext = { unit, arm, order, paths, cacheFirstPlan: cachePlan, authoritativeFirstPlan: authPlan }
      const injected = options.plannerFactory(context)
      const selections: {
        phase: string, vetoed: boolean, reason?: string, observedValue?: unknown, attributions: string[]
        ruleId?: string, claimId?: string, ruleStatus?: string, sourceScope?: string, conditionPath?: string
        conditionSource?: string, vetoedCandidateIds?: readonly string[], selectedCandidateId?: string
      }[] = []
      const attemptsBefore = meter.attempts.length
      let plannerCalls = 0
      let physicalRequests = 0
      let meterCode: string | undefined
      let orderFirst: string | undefined
      /*
       * ⚠️ **本层不计量**：物理请求的计量在真实规划器的 fetch 边界（`beforeRequest` + `charge`）。
       *    这里只统计"规划器被调用几次"（candidateCalls）与"真实发出几次"（physicalRequests），
       *    并如实转述计量器的拒绝码/成本不可确认 —— 避免同一请求被计两次。
       */
      const planner = {
        id: injected.id, endpointHost: injected.endpointHost,
        async plan (input: unknown) {
          const state = meter.state()
          if (state.stopCode !== undefined) {
            stopCodeRef.code = state.stopCode
            return { ok: false as const, requestCount: 0, failure: 'call_failed' as const }
          }
          plannerCalls += 1
          const result = await injected.plan(input, context)
          physicalRequests += Number(result.requestCount ?? 0)
          if (result.refusal !== undefined) {
            meterCode = result.refusal
            if (result.refusal !== 'task_request_cap') stopCodeRef.code = result.refusal
          }
          if (result.costUnverifiable === true) stopCodeRef.code = 'cost_unverifiable'
          if (meter.state().stopCode !== undefined) stopCodeRef.code = meter.state().stopCode
          if (meter.state().costVerifiable === false) stopCodeRef.code = 'cost_unverifiable'
          const applied = result.orderApplied as { firstCandidate?: string } | undefined
          if (applied?.firstCandidate !== undefined) orderFirst = applied.firstCandidate
          return {
            ok: result.ok, plan: result.plan, candidates: result.candidates,
            requestCount: Number(result.requestCount ?? 0), failure: result.failure,
          } as never
        },
      }
      const evidence = await h.recordUserEvidence(`测量 ${unit} ${item.object}`)
      const conversationKey = String(evidence.event.conversationId)
      const traceId = `f2unit-measure-${unit}-${item.object}`
      authorizations.issue({ conversationKey, originalText: entryText(item.object), triggeringEventId: String(evidence.event.id),
        allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], maxRiskLevel: 'R1',
        budget: { maxActions: 12, maxPlans: 8, deadlineMs: 600_000 } })
      const turn = createActionTurnPort({
        gateway, detector: createActionIntentDetector(), registry, attribution: { adapterId: 'f2-unit' },
        task: {
          authorizations, staging, resolveTarget, epistemic: observer,
          capabilitiesFor: () => ['sandbox.file.read', 'sandbox.file.write'], riskLevelFor: () => 'R1' as const,
          planner: planner as never, replanContext: { knownDirectories, contentTokens: 4000 },
          configurePlanning: ((text: string, fallback?: never) => createSimulationPlanning({
            db: h.db, characterId, activeUserId: h.userId, registry, facts: { encoding: 'utf8' },
            modelVersion: 'f2-unit@1', candidatePlanner: planner as never,
            precondition: { enabled: arm === 'C', knownDirectories, declarations: [declaration], writeSources },
            onSelection: (value: {
      f2?: {
        phase?: string, vetoedCandidateIds?: readonly string[], selectedCandidateId?: string
        veto?: {
          reason?: string, observedValue?: unknown, ruleId?: string, claimId?: string, ruleStatus?: string,
          sourceScope?: string, conditionPath?: string, conditionSource?: string
        }
        sourceAttributions?: readonly { attribution: string }[]
      }
    }) => {
              /* ⚠️ **全部轮次**都要留：只取最后一次无法排除更早发生的否决。 */
              const phase = String(value.f2?.phase ?? (value as { reason?: string }).reason ?? 'unknown')
              const veto = value.f2?.veto
              selections.push({
                phase,
                vetoed: (value.f2?.vetoedCandidateIds ?? []).length > 0,
                reason: veto?.reason, observedValue: veto?.observedValue,
                attributions: (value.f2?.sourceAttributions ?? []).map(entry => entry.attribution),
                ruleId: veto?.ruleId, claimId: veto?.claimId, ruleStatus: veto?.ruleStatus,
                sourceScope: veto?.sourceScope, conditionPath: veto?.conditionPath, conditionSource: veto?.conditionSource,
                vetoedCandidateIds: value.f2?.vetoedCandidateIds,
                selectedCandidateId: (value.f2 as { selectedCandidateId?: string }).selectedCandidateId,
              })
            },
            f2: { enabled: true },
          })(text, fallback)) as never,
        },
      })
      const result = await turn.handleTurn({ characterId, traceId: asTraceId(traceId), text: entryText(item.object),
        eventId: String(evidence.event.id), conversationKey, speaker: { kind: 'user', id: String(h.userId) },
        triggeringEvent: triggeringConversationEventOf(evidence.event) })
      const counts = await actionsOf(traceId)
      const decisive = selections.at(-1)
      const attemptsThisTask = meter.attempts.slice(attemptsBefore)
      const costClass = {
        usageConfirmedTokens: attemptsThisTask.filter(item => item.costConfirmed).reduce((sum, item) => sum + item.charged, 0),
        provisionalTokens: attemptsThisTask.filter(item => !item.costConfirmed && item.bounded === true).reduce((sum, item) => sum + item.charged, 0),
        unconfirmedEvents: attemptsThisTask.filter(item => !item.costConfirmed && item.bounded !== true).length,
        boundedAbortEvents: attemptsThisTask.filter(item => item.bounded === true).length,
      }
      const vetoReasonCounts: Record<string, number> = {}
      for (const item of selections) if (item.vetoed) vetoReasonCounts[String(item.reason ?? 'unknown')] = (vetoReasonCounts[String(item.reason ?? 'unknown')] ?? 0) + 1
      const selectionPhases: Record<string, number> = {}
      for (const item of selections) selectionPhases[item.phase] = (selectionPhases[item.phase] ?? 0) + 1
      const row: F2UnitTaskRow = {
        phase: 'measurement', role: 'measurement', object: item.object, condition: item.condition,
        achieved: result.task?.goal?.achieved === true, stopped: String(result.task?.stopped ?? 'none'),
        actions: Number(result.task?.actionsUsed ?? 0), plans: Number(result.task?.plansUsed ?? 0),
        failedWrites: counts.failures, candidateCalls: plannerCalls, physicalRequests,
        orderFirstCandidate: orderFirst,
        fileTruth: (() => { try { return readFileSync(resolve(root, paths.target), 'utf8') === paths.authBytes } catch { return false } })(),
        vetoed: selections.some(item => item.vetoed),
        vetoReason: (selections.find(item => item.vetoed) ?? decisive)?.reason,
        observedValue: (selections.find(item => item.vetoed) ?? decisive)?.observedValue,
        attributions: (selections.find(item => item.vetoed) ?? decisive)?.attributions ?? [],
        meterCode,
        rejectedCode: String((result.task as { planRejectedCode?: unknown } | undefined)?.planRejectedCode ?? '') || undefined,
        selectionTrace: selections.map(item => ({
          phase: item.phase, vetoed: item.vetoed, reason: item.reason, observedValue: item.observedValue,
          attributions: item.attributions, ruleId: item.ruleId, claimId: item.claimId, ruleStatus: item.ruleStatus,
          sourceScope: item.sourceScope, conditionPath: item.conditionPath, conditionSource: item.conditionSource,
          vetoedCandidateIds: item.vetoedCandidateIds, selectedCandidateId: item.selectedCandidateId,
        })),
        selectionRounds: selections.length,
        vetoRounds: selections.filter(item => item.vetoed).length,
        vetoReasonCounts,
        selectionPhases,
        ...costClass,
      }
      taskRows.push(row)
      measurementRows.push(row)
      options.onTaskFinish?.(taskId, row)
      if (stopCodeRef.code === 'cost_unverifiable') break
      if (stopCodeRef.code === 'budget_requests' || stopCodeRef.code === 'budget_tokens') break
    }

    const report: F2UnitReport = {
      schema: 'f2-unit-report@1',
      unit, arm, order, evidenceKind, sequenceId: options.sequenceId,
      realModelRequests: taskRows.reduce((total, row) => total + row.physicalRequests, 0),
      costConfirmed: meter.state().costVerifiable,
      stopCode: stopCodeRef.code ?? meter.state().stopCode,
      formation: {
        tasks: formationRows,
        qualified,
        evidence: formationEvidence,
        hasControl,
      },
      measurement: measurementRows,
      totals: {
        formationActions: formationRows.reduce((total, row) => total + row.actions, 0),
        measurementActions: measurementRows.reduce((total, row) => total + row.actions, 0),
        failedWrites: taskRows.reduce((total, row) => total + row.failedWrites, 0),
      usageConfirmedTokens: meter.attempts.filter(item => item.costConfirmed).reduce((sum, item) => sum + item.charged, 0),
      provisionalTokens: meter.attempts.filter(item => !item.costConfirmed && item.bounded === true).reduce((sum, item) => sum + item.charged, 0),
      unconfirmedEvents: meter.attempts.filter(item => !item.costConfirmed && item.bounded !== true).length,
      boundedAbortEvents: meter.attempts.filter(item => item.bounded === true).length,
        candidateCalls: taskRows.reduce((total, row) => total + row.candidateCalls, 0),
        physicalRequests: taskRows.reduce((total, row) => total + row.physicalRequests, 0),
        achieved: measurementRows.filter(row => row.achieved && row.fileTruth).length,
        tasks: measurementRows.length,
        requests: meter.state().requests,
        tokens: meter.state().tokens,
      },
      meter: { ...meter.state(), attempts: meter.attempts.length },
      db,
      recoveredTaskIds,
      thisRun: {
        physicalRequests: measurementRows.filter(row => row.recovered !== true)
          .reduce((total, row) => total + row.physicalRequests, 0),
        plannerCalls: measurementRows.filter(row => row.recovered !== true)
          .reduce((total, row) => total + row.candidateCalls, 0),
      },
      boundaries: [
        '一个单元 = 一次性 PostgreSQL + 独立文件根（调用方负责隔离）',
        '形成阶段脚本固定、零模型请求；测量阶段**物理请求只在真实规划器的 fetch 边界计量**（发出前计数、响应后按 usage 只结算一次），脚本规划单独计数、不充请求',
        'usage 缺失 ⇒ 成本不可确认 ⇒ 停止后续请求（不补 0、不猜）',
        evidenceKind === 'offline_mechanism'
          ? '⚠️ 离线夹具模式：固定候选规划器 + 零模型请求 ⇒ 只证明编排与计量，**不构成收益读数**'
          : '⚠️ 真实模式：读数只在**已授权**运行下有效，且 token 只能事后按账本对账',
      ],
    }
    writeFileSync(resolve(out, `unit-${unit}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8')
    return report
  } finally {
    await (h as { close?: () => Promise<void> }).close?.()
  }
}
