/** Opt-in, single-file candidate selection. No executor or evidence writes. */
import { validateTaskPlan, type TaskPlan, type TaskPlannerInput, type TaskPlannerPort } from '../../kernel/action/task-plan.ts'
import type { CapabilityRegistry } from '../../kernel/action/capability-registry.ts'
import { parameterBindingDigestOf } from '../../kernel/action/action-forecast.ts'
import { selectUsableRules, type RuleSelection } from '../../kernel/contracts/cognitive-collaboration.ts'
import { simulateTransitionPaths, type SimulationAction, type SimulationReport } from '../../kernel/contracts/world-model-simulation.ts'
import type { ActionForecastStep } from '../../kernel/contracts/world-model.ts'
import { contentFingerprint } from '../action/adapters/sandbox-filesystem.ts'
import { createEblRuleSnapshotPort } from './ebl-rule-snapshot.ts'
import { buildTransitionRule } from './world-model-transition.ts'
import { readObservedState, type WorldModelForecastOptions } from './world-model-forecast.ts'
import { EBL_TOOL_ENVIRONMENT } from '../persistence/epistemic-belief-source.ts'
import { fnv1a64Hex } from '../../kernel/action/idempotency.ts'
import { evaluateCandidatePreconditionVeto } from './precondition-veto.ts'
import type { WriteSourcesForTarget } from '../persistence/write-source-read.ts'
import type { WriteSourceAttribution } from '../../kernel/contracts/write-source-attribution.ts'
import type { WriteSourceScope } from '../../kernel/contracts/world-model-transition.ts'
import { applyPreconditionVeto, type WritePreconditionDeclaration, type WritePreconditionVetoReason,
  writePreconditionConditions } from '../../kernel/contracts/write-precondition.ts'
import { familyOfWriteTarget, sandboxWriteFamilyScope } from '../../kernel/contracts/write-family.ts'

/** 前置条件**否决**的读数（ADR-151 步骤 D）：规则 id/版本 · 条件来源 · 被否决候选 · 回退理由。 */
export interface PreconditionVetoRecord {
  /** 翻译出来的规则 id（**当前合格**时才有）。 */
  readonly ruleId?: string
  readonly ruleVersion?: string
  /** 族的那条**前置条件命题** id（即使不合格也有 ⇒ 读数能答"是哪条命题"）。 */
  readonly claimId?: string
  /** 那条命题当前**为什么**不能被消费（'qualified' / 'not_usable' / 'scope_mismatch' / …）。 */
  readonly ruleStatus?: string
  readonly conditionPath: string
  /** 受信观测的来源（读动作 id）；未知时没有。 */
  readonly conditionSource?: string
  /** 受信观测到的条件值；未知时没有。 */
  readonly observedValue?: string
  readonly decision: 'veto' | 'no_veto'
  readonly reason: WritePreconditionVetoReason
  /** 被否决的候选（编号）。 */
  readonly vetoedCandidateIds: readonly string[]
  /** 回退：默认顺序 / 全部被否决（**不**记成目标达成）。 */
  readonly fallback: 'default_order' | 'goal_unproven'
  readonly sourceScope?: 'cache' | 'authoritative'
  readonly sourceAttributions?: readonly { candidateId: string; attribution: WriteSourceAttribution }[]
}

/** 前置条件否决的**受信输入**（缺省 ⇒ 整段不跑）。 */
export interface SimulationPreconditionOptions {
  /** 开关（**缺省 false**）。 */
  readonly enabled: boolean
  /** 受信已知目录事实（族只来自这里）。 */
  readonly knownDirectories: () => readonly string[]
  /** 受信族前置条件声明。 */
  readonly declarations: readonly WritePreconditionDeclaration[]
  readonly writeSources?: WriteSourcesForTarget
}

/** **F2 链**的规划读数（只有 F2 分支才有；只读、**不参与**判定）。 */
export interface F2PlanReading {
  readonly phase: 'prep_read_pending' | 'goal_fingerprint_unknown' | 'marker_read_scheduled' | 'candidates_evaluated'
  | 'ordinary_planning_no_rule'
  /** 由**受信准备读**派生出的本任务目标真值指纹。 */
  readonly goalFingerprint?: string
  /** 当前合格、可被消费的族前置条件规则 id。 */
  readonly qualifiedRuleIds?: readonly string[]
  readonly vetoedCandidateIds?: readonly string[]
  readonly selectedCandidateId?: string
  /** 每个候选的**受信来源归属**（`cache` / `authoritative` / `unknown`）。 */
  readonly sourceAttributions?: readonly { readonly candidateId: string; readonly attribution: string }[]
  readonly veto?: {
    readonly decision: 'veto' | 'no_veto'
    readonly reason: string
    readonly ruleId?: string
    readonly claimId?: string
    readonly ruleStatus?: string
    readonly conditionPath?: string
    readonly observedValue?: string
    readonly conditionSource?: string
    readonly sourceScope?: 'cache' | 'authoritative'
    readonly fallback: 'default_order' | 'goal_unproven'
  }
  readonly fallback?: 'default_order' | 'goal_unproven'
}

export interface SimulationPlanSelection {
  reason: 'selected' | 'no_rule' | 'invalid_candidates' | 'budget' | 'goal_unproven'
  selectedIndex?: number
  report?: SimulationReport
  /** Optional observation of the actual selection snapshot, not a later re-query. */
  ruleSelection?: RuleSelection
  /** 前置条件**否决**的读数（ADR-151 步骤 D）。 */
  preconditionVeto?: PreconditionVetoRecord
  /** **有界条件观察**的调度读数（ADR-151 R1 §5）：这一轮安排了一次条件读。 */
  conditionObservation?: { readonly path: string; readonly claimId: string }
  /** **F2 链**的规划读数（只有 F2 分支才有）。 */
  f2?: F2PlanReading
}

export function createSimulationTaskPlanner(options: WorldModelForecastOptions & {
  registry: CapabilityRegistry
  /** Derived from the explicit task, not from a candidate's self-reported goal/done. */
  goal: { path: string; expectedFingerprint: string }
  candidateSource: {
    id: string; endpointHost: string
    propose(input: TaskPlannerInput): Promise<{ candidates: readonly TaskPlan[]; requestCount: number }>
  }
  /** 前置条件**否决**的受信输入（**缺省 ⇒ 整段不跑**，行为逐字不变）。 */
  precondition?: SimulationPreconditionOptions
  onSelection?: (selection: SimulationPlanSelection) => void
}): TaskPlannerPort {
  return {
    id: `simulation:${options.candidateSource.id}`, endpointHost: options.candidateSource.endpointHost,
    async plan(input) {
      const proposed = await options.candidateSource.propose(input)
      let ruleSelection: RuleSelection | undefined
      let preconditionVeto: PreconditionVetoRecord | undefined
      const fail = (reason: SimulationPlanSelection['reason'], report?: SimulationReport) => {
        options.onSelection?.({ reason, ...(report ? { report } : {}), ...(ruleSelection ? { ruleSelection } : {}),
          ...(preconditionVeto ? { preconditionVeto } : {}) })
        return { ok: false as const, failure: 'invalid_output' as const, requestCount: proposed.requestCount }
      }
      // One candidate-generation call uses the task loop's single consumed planning unit.
      if (proposed.requestCount !== 1 || proposed.candidates.length === 0) return fail('invalid_candidates')
      if (proposed.candidates.length > 8) return fail('budget')
      let plans: TaskPlan[]
      const actions: SimulationAction[][] = []
      try {
        plans = proposed.candidates.map(plan => validateTaskPlan(plan, {
          registry: options.registry, allowedCapabilities: input.allowedCapabilities,
        }))
        for (const plan of plans) {
          if (plan.steps.length === 0 || plan.steps.length > 4 || plan.steps.length > input.remainingActions) return fail('budget')
          actions.push(plan.steps.map(step => {
            if (step.args.path !== options.goal.path ||
              (step.capability !== 'sandbox.file.read' && step.capability !== 'sandbox.file.write') ||
              (step.capability === 'sandbox.file.read' ? step.operation !== 'read' : step.operation !== 'write') ||
              Object.keys(step.args).some(key => !['path', 'content'].includes(key)) ||
              (step.operation === 'write' && typeof step.args.content !== 'string') ||
              (step.operation === 'read' && step.args.content !== undefined)) throw new Error('unsupported_candidate')
            return { capability: step.capability, operation: step.operation, arguments: {
              path: options.goal.path,
              ...(step.operation === 'write' ? { contentFingerprint: contentFingerprint(step.args.content as string) } : {}),
            } }
          }))
        }
      } catch { return fail('invalid_candidates') }
      const snapshot = createEblRuleSnapshotPort(options.db, options.characterId, options.activeUserId, { writeSources: options.precondition?.writeSources })
      /*
       * ⚠️ **有界条件观察的调度**（ADR-151 R1 §4）：
       *   条件**还没观测到**（本任务没读过标记）而**已经有适用且合格的族规则** ⇒
       *   本轮输出**一个单步的条件读计划**（程序生成、占 1 次行动 / 1 次规划轮），
       *   下一轮再判否决。
       *   ⚠️ 读**还没发生** ⇒ 本轮**不否决**（没有回执 ⇒ 未知 ⇒ 不猜）。
       *   ⚠️ 只有"当前合格"的族规则才主动读（冷启动时**不**预赠资格）。
       *   ⚠️ 缺省没有 `observation`（旧入口）⇒ 整段不跑 ⇒ 旧行为逐字不变。
       */
      if (options.precondition?.enabled === true && input.observation !== undefined && !input.observation.attempted) {
        const observation = input.observation
        const familyId = familyOfWriteTarget({ path: observation.targetPath,
          knownDirectories: options.precondition.knownDirectories() })
        const declaration = familyId === undefined
          ? undefined
          : options.precondition.declarations.find(item => item.familyId === familyId)
        if (declaration !== undefined && declaration.conditionPath === observation.conditionPath) {
          const snapshots = await snapshot.list()
          const scopes: (WriteSourceScope | undefined)[] = options.precondition.writeSources === undefined
            ? [undefined] : [undefined, 'cache', 'authoritative']
          const scheduling = scopes.flatMap(sourceScope => selectUsableRules({ snapshots, visible: {
            subjectId: options.activeUserId,
            scope: sandboxWriteFamilyScope(familyId!),
            environment: EBL_TOOL_ENVIRONMENT,
            conditions: writePreconditionConditions(declaration, sourceScope),
          } }).selected)
          const qualified = scheduling.find(item => item.predicate === 'write_precondition_holds' && item.usable)
          if (qualified && input.remainingActions >= 1) {
            const observationPlan: TaskPlan = {
              goal: '读取受信条件标记（程序安排的一次只读；下一轮再决定是否否决）',
              done: false,
              steps: [{ capability: 'sandbox.file.read', operation: 'read', args: { path: observation.conditionPath } }],
            }
            const validated = validateTaskPlan(observationPlan, {
              registry: options.registry, allowedCapabilities: input.allowedCapabilities,
            })
            options.onSelection?.({ reason: 'selected', selectedIndex: 0, ruleSelection,
              conditionObservation: { path: observation.conditionPath, claimId: qualified.claimId } })
            return { ok: true, requestCount: proposed.requestCount, plan: validated }
          }
        }
      }
      ruleSelection = selectUsableRules({ snapshots: await snapshot.list(), visible: {
        subjectId: options.activeUserId, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT,
        conditions: options.facts ?? {},
      } })
      const selected = ruleSelection.selected
      const translated = selected.map(buildTransitionRule).find(item => 'rule' in item)
      if (!translated || !('rule' in translated)) return fail('no_rule')
      const rule = translated.rule
      const observed = await readObservedState(options.db, options.characterId, options.maxFacts ?? 50)
      const report = simulateTransitionPaths({ rule,
        initialState: { actions: observed.actions, facts: options.facts ?? {} },
        candidates: actions.map((items, index) => ({ id: String(index), actions: items })), maxSteps: 4, maxPaths: 8,
      })
      if (report.truncated) return fail('budget', report)
      // Only complete paths ending in the goal's read expectation qualify. Unknown alternatives stay unknown.
      const eligible = report.traces.filter(trace => trace.outcome === 'completed' &&
        trace.steps.at(-1)?.expectation?.path === options.goal.path &&
        trace.steps.at(-1)?.expectation?.expectedFingerprint === options.goal.expectedFingerprint)
        .sort((a, b) => a.steps.length - b.steps.length || Number(a.id) - Number(b.id))
      /*
       * ⚠️ **前置条件否决**（ADR-151 步骤 D）：
       *   条件**被违反**（观测值 == mustNotEqual）⇒ 那次写会被拒绝 ⇒ **否决**该候选。
       *   ⚠️ 只否决**执行写**的候选（只读的候选不受影响）。
       *   ⚠️ 条件未知 / 条件成立 / 族不匹配 / 规则不合格 ⇒ **不否决**（回默认顺序）。
       */
      const candidateVeto = await evaluateCandidatePreconditionVeto({
        enabled: options.precondition?.enabled === true,
        db: options.db, characterId: options.characterId, activeUserId: options.activeUserId,
        targetPath: options.goal.path,
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        knownDirectories: options.precondition?.knownDirectories ?? ((): readonly string[] => []),
        declarations: options.precondition?.declarations ?? [],
        writeSources: options.precondition?.writeSources,
      }, eligible.map(trace => ({ id: trace.id, writeFingerprints: plans[Number(trace.id)]!.steps
        .filter(step => step.capability === 'sandbox.file.write').map(step => contentFingerprint(step.args.content as string)) })))
      const evaluation = candidateVeto.evaluation
      const filtered = applyPreconditionVeto({
        decision: { ...evaluation.decision, veto: candidateVeto.vetoedIds.length > 0 },
        candidates: eligible,
        writesIntoFamily: trace => candidateVeto.vetoedIds.includes(trace.id),
      })
      const vetoedIds = filtered.vetoed.map(trace => trace.id)
      const remaining = filtered.eligible
      if (evaluation.decision.ruleId !== undefined || evaluation.claimId !== undefined) {
        preconditionVeto = {
          ...(evaluation.decision.ruleId === undefined ? {} : { ruleId: evaluation.decision.ruleId }),
          ...(evaluation.decision.ruleVersion === undefined ? {} : { ruleVersion: evaluation.decision.ruleVersion }),
          ...(evaluation.claimId === undefined ? {} : { claimId: evaluation.claimId }),
          ...(evaluation.ruleStatus === undefined ? {} : { ruleStatus: evaluation.ruleStatus }),
          conditionPath: evaluation.conditionPath ?? evaluation.decision.conditionPath ?? '',
          ...(evaluation.decision.conditionSource === undefined ? {} : { conditionSource: evaluation.decision.conditionSource }),
          ...(evaluation.decision.observedValue === undefined ? {} : { observedValue: evaluation.decision.observedValue }),
          decision: evaluation.decision.veto ? 'veto' : 'no_veto',
          reason: evaluation.decision.reason,
          vetoedCandidateIds: vetoedIds,
          fallback: remaining.length === 0 ? 'goal_unproven' : 'default_order',
          ...(options.precondition?.writeSources === undefined ? {} : {
            sourceAttributions: candidateVeto.attributions,
            ...(evaluation.sourceScope === undefined ? {} : { sourceScope: evaluation.sourceScope }),
          }),
        }
      }
      // ⚠️ 全部候选被否决 ⇒ **不能**记成目标达成（如实失败；外层回默认/普通规划）。
      if (remaining.length === 0) return fail('goal_unproven', report)
      const choice = remaining[0]
      const index = Number(choice.id)
      const dependency = { ...rule.binding }
      const forecastSteps: ActionForecastStep[] = []
      const planStepIndices: number[] = []
      for (const step of choice.steps) if (step.expectation) {
        forecastSteps.push({ capability: step.action.capability, operation: step.action.operation,
          expectedVisibleOutcome: '模拟预期；必须以真实读回核对',
          check: { kind: 'effect_fingerprint_matches', expectedFingerprint: step.expectation.expectedFingerprint },
          uncertainty: 'unknown', dependsOn: [], ruleDependencies: [dependency], ruleVersion: rule.version,
          parameterBindingDigest: parameterBindingDigestOf(step.action.capability, step.action.operation, `path=${options.goal.path}`),
        })
        planStepIndices.push(step.index)
      }
      options.onSelection?.({ reason: 'selected', selectedIndex: index, report, ruleSelection,
        ...(preconditionVeto ? { preconditionVeto } : {}) })
      return { ok: true, requestCount: proposed.requestCount, plan: plans[index]!, simulation: {
        dependency,
        forecast: { producedAt: Date.now(), inputRevision: `simulation:${fnv1a64Hex(JSON.stringify([rule.binding, actions[index]]))}`,
          modelVersion: options.modelVersion, budgetCost: 0, steps: forecastSteps, planStepIndices },
      } }
    },
  }
}
