/** Production scope is deliberately limited to an explicit, grounded file goal. */
import type { CapabilityRegistry } from '../../kernel/action/capability-registry.ts'
import type { TaskPlannerPort } from '../../kernel/action/task-plan.ts'
import { contentFingerprint } from '../action/adapters/sandbox-filesystem.ts'
import { createEblRuleSnapshotPort } from './ebl-rule-snapshot.ts'
import { selectUsableRules } from '../../kernel/contracts/cognitive-collaboration.ts'
import { EBL_TOOL_ENVIRONMENT } from '../persistence/epistemic-belief-source.ts'
import { createSimulationTaskPlanner, type SimulationPlanSelection, type SimulationPreconditionOptions } from './simulation-task-planner.ts'
import { evaluateCandidatePreconditionVeto } from './precondition-veto.ts'
import { applyPreconditionVeto, writePreconditionConditions, type WritePreconditionDeclaration } from '../../kernel/contracts/write-precondition.ts'
import { sandboxWriteFamilyScope } from '../../kernel/contracts/write-family.ts'
import { validateTaskPlan, type TaskPlan, type TaskPlannerInput, type TaskPlannerOutcome } from '../../kernel/action/task-plan.ts'
import type { RawDb } from '../persistence/db.ts'
import type { WriteSourcesForTarget } from '../persistence/write-source-read.ts'
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { ActionRequest } from '../../kernel/action/action-request.ts'
import type { ActionResult } from '../../kernel/action/action-result.ts'
import type { WorldModelForecastOptions } from './world-model-forecast.ts'
import { familyOfWriteTarget } from '../../kernel/contracts/write-family.ts'
import { parsePreconditionTaskEntry } from './precondition-entry.ts'
import { parseF2TaskEntry, sourceScopedPathsOf } from '../../kernel/contracts/f2-task-entry.ts'

/**
 * **F2 入口解析 → 范围 + 准备读路径**（纯函数 · 零 IO · 失败关闭）。
 *
 * 用户裁定 **A**：源正文不能由夹具预知 ⇒ 任务开始由**程序生成**单步读计划读**权威源**
 * （占 1 动作 / 1 规划轮、零模型调用），读回正文进规划上下文（`TaskPlannerInput.content`），
 * 其指纹成为本任务 `goal.expectedFingerprint`。
 *
 * ⚠️ 本函数**只解析与派生**：不发授权、不读文件、不调度 —— 装配/规划器接线是下一步。
 */
export function resolveF2EntryScope (options: { readonly enabled: boolean, readonly text: string }):
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'rejected', readonly reason: string }
  | {
    readonly kind: 'entry'
    readonly familyId: string
    readonly targetPath: string
    readonly cacheSource: string
    readonly authoritativeSource: string
    readonly familyMarker: string
    /** 受信准备读**唯一**要读的路径（权威源）。 */
    readonly prepReadPath: string
    readonly sourceScopedPaths: {
      readonly readOnly: readonly string[]
      readonly limitedReads: readonly { readonly path: string, readonly maxReads: number }[]
      readonly writable: readonly string[]
    }
  } {
  if (!options.enabled) return { kind: 'not_applicable' }
  const parsed = parseF2TaskEntry(options.text)
  if (parsed.status === 'rejected') return { kind: 'rejected', reason: `f2_${parsed.reason}` }
  if (parsed.status !== 'parsed') return { kind: 'not_applicable' }
  const entry = parsed.entry
  return {
    kind: 'entry',
    familyId: entry.familyId,
    targetPath: entry.paths.target,
    cacheSource: entry.paths.cacheSource,
    authoritativeSource: entry.paths.authoritativeSource,
    familyMarker: entry.paths.familyMarker,
    prepReadPath: entry.paths.authoritativeSource,
    sourceScopedPaths: sourceScopedPathsOf(entry),
  }
}

export function explicitFileGoal(text: string): { path: string; expectedFingerprint: string } | undefined {  const match = /^只操作相对路径 ([A-Za-z0-9_-]+\.txt)。写入以下 JSON 字符串解码后的精确内容，再读回核对：("(?:[^"\\]|\\.)*")。?$/u.exec(text)
  if (!match) return undefined
  try {
    const content: unknown = JSON.parse(match[2]!)
    return typeof content === 'string' ? { path: match[1]!, expectedFingerprint: contentFingerprint(content) } : undefined
  } catch { return undefined }
}

/** 入口种类（读数用；ADR-151 R1 §5）。 */
export type SimulationEntryKind = 'legacy_flat' | 'precondition_two_line' | 'f2_task_entry'

/**
 * 被拒绝的入口用的**占位规划器**（永远不会被调用：`entryRejected` 在场时任务环不启动）。
 * ⚠️ 它存在只是为了让装配返回值保持**单一形状**（不动既有调用点）。
 */
const refusalPlanner: TaskPlannerPort = {
  id: 'entry-rejected@1', endpointHost: 'none',
  async plan() { return { ok: false as const, failure: 'invalid_output' as const, requestCount: 0 } },
}

/** 规划装配的读数（调用方据此记录入口/范围前提）。 */
export interface SimulationPlanningConfiguration {
  /**
   * 规划器：通常是模拟规划器；**合法 F1 请求但没有合格读回规则**时是任务自己的
   * （`fallbackPlanner`）—— 范围约束仍然生效（修补 ①）；入口被拒绝时是占位（不会被调用）。
   */
  planner: TaskPlannerPort
  ruleSnapshot: ReturnType<typeof createEblRuleSnapshotPort>
  usableRuleIds: readonly string[]
  entryKind: SimulationEntryKind
  /** F2 逐路径范围（可选；只有 F2 入口才给）。 */
  sourceScopedPaths?: {
    readonly readOnly: readonly string[]
    readonly limitedReads: readonly { readonly path: string, readonly maxReads: number }[]
    readonly writable: readonly string[]
  }
  /**
   * **任务局部的有界观察范围**（ADR-151 R1 §3）：只在**新的两行入口**给出。
   * ⚠️ 它由程序从"原始请求 + 受信声明"生成 —— 模型与计划字段都**不能**授予它。
   * ⚠️ 它与**规则资格无关**（修补 ①）：没有合格读回规则时，范围**照样**挂上。
   */
  boundedObservation?: { readonly targetPath: string; readonly conditionPath: string; readonly maxReads: number }
  /**
   * **明确拒绝这个入口**（修补 ①）：请求自称 F1 但形状/辅助路径不合法。
   * ⚠️ 调用方必须**一个动作都不执行**，并且**不许**退回普通/单动作路径（那会截半执行）。
   */
  entryRejected?: string
  /**
   * **F2 的完成判定**（可选；只有 F2 入口才给）。
   *
   * ⚠️ 它只看**真实结果**：一次真实写入 + **最后**一次成功读回，且读回内容指纹 ==
   *    由**受信准备读**取得的权威源正文指纹（用户裁定 A：真值来自真实读取，不由夹具预知）。
   * ⚠️ 缺省不提供 ⇒ 任务环走原有判定（旧行为逐字不变）。
   */
  completion?: (input: {
    readonly results: readonly { readonly request: ActionRequest, readonly result: ActionResult, readonly rule: string }[]
    readonly visibleContentIds: readonly string[]
  }) => { achieved: boolean, contentIds: string[] }
}

/**
 * **把"入口 + 任务局部范围"解析成一份可复用的结果**（ADR-151 R1 §2/§3 的**单一事实源**）。
 *
 * ============================================================================
 *  为什么单独提出来
 * ============================================================================
 * 范围（目标路径 / 唯一标记 / 最多一次）**必须**由"原始请求 + 受信族声明"推导，
 * 而**不能**各自手抄一份：模拟规划器要用它，评测装配（共同三臂工厂）也要用它，
 * 两者若各写一遍就会**漂移**（一处改了另一处没改 ⇒ 基线与被测臂的权限不一样）。
 * ⇒ 这里导出**唯一**的解析口；`createSimulationPlanning` 内部也走它 ⇒ 行为不变。
 *
 * ⚠️ `enabled` 为 false ⇒ **恒 undefined**（旧入口逐字不变）。
 * ⚠️ 形状不合法 ⇒ `rejected`（**明确拒绝**，调用方零动作、不回退）。
 */
export type PreconditionEntryResolution =
  | { readonly kind: 'entry'; readonly targetPath: string; readonly conditionPath: string; readonly maxReads: 1; readonly expectedFingerprint: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'not_applicable' }

export function resolvePreconditionEntryScope(options: {
  readonly enabled: boolean
  readonly text: string
  readonly knownDirectories: () => readonly string[]
  readonly declarations: readonly WritePreconditionDeclaration[]
}): PreconditionEntryResolution {
  if (!options.enabled) return { kind: 'not_applicable' }
  const parsed = parsePreconditionTaskEntry(options.text)
  if (parsed.kind === 'rejected') return { kind: 'rejected', reason: parsed.reason }
  if (parsed.kind !== 'entry') return { kind: 'not_applicable' }
  const familyId = familyOfWriteTarget({ path: parsed.entry.targetPath, knownDirectories: options.knownDirectories() })
  const declaration = familyId === undefined
    ? undefined
    : options.declarations.find(item => item.familyId === familyId)
  if (declaration === undefined) return { kind: 'rejected', reason: 'entry_family_undeclared' }
  if (declaration.conditionPath !== parsed.entry.conditionPath) {
    return { kind: 'rejected', reason: 'entry_condition_not_declared' }
  }
  return { kind: 'entry', targetPath: parsed.entry.targetPath, conditionPath: parsed.entry.conditionPath,
    maxReads: 1, expectedFingerprint: parsed.entry.expectedFingerprint }
}

export function createSimulationPlanning(options: WorldModelForecastOptions & {
  registry: CapabilityRegistry; candidatePlanner: TaskPlannerPort
  /**
   * 前置条件**否决**的受信输入（**可选**、默认不接 ⇒ 行为逐字不变）。
   *
   * ⚠️ 开关在**里面**（`enabled`）：默认 `false` ⇒ 否决整段不跑。
   */
  precondition?: SimulationPreconditionOptions
  /**
   * 选路回调（**可选**、默认不接）⇒ 让调用方能读到**实际选中编号与理由**。
   *
   * ⚠️ 之前这个回调**没有**被转发 ⇒ 外部只能知道"进了模拟模式"，拿不到实际选择。
   * ⚠️ 本参数**默认关闭**：不传时行为与之前**逐字相同**。
   */
  onSelection?: (value: SimulationPlanSelection) => void
  /** **F2 入口**（可选、缺省不接 ⇒ 旧行为逐字不变）。 */
  f2?: { readonly enabled: boolean }
}) {
  const ruleSnapshot = createEblRuleSnapshotPort(options.db, options.characterId, options.activeUserId)
  /**
   * @param fallback 任务**自己的**规划器（装配层在调用时传进来）。
   *   ⚠️ 只在一个情形用到：**合法** F1 请求但**没有**合格读回规则 ⇒ 不给模拟规划器，
   *   但**范围照样挂上**（修补 ①：范围约束独立于规则资格）。
   */
  return async (text: string, fallback?: TaskPlannerPort): Promise<SimulationPlanningConfiguration | undefined> => {
    /*
     * ⚠️ **入口分流**（ADR-151 R1 §2）：
     *   · 开关关 ⇒ 只认旧扁平入口（行为逐字不变）；
     *   · 开关开 + 两行精确请求 ⇒ 新入口（目标在目录内 + 一个标记的一次只读）；
     *   · 自称 F1 但形状/路径不合法 ⇒ **明确拒绝新入口**（**不**截半执行）；
     *   · 不是 F1 请求 ⇒ 旧入口。
     */
    /*
     * **F2 入口分流**（最小接点 R4 · 用户裁定 A）：
     *  · 开关关 ⇒ `not_applicable`（旧行为逐字不变）；
     *  · 自称 F2 但形状不合法 ⇒ `entryRejected`（调用方零动作、不回退）；
     *  · 合法 ⇒ 挂**逐路径范围** + 用**受信准备读**（程序生成单步读权威源、零模型）再交回后续规划器；
     *    ⚠️ 目标真值由这次真实读取得，**不**由夹具预知。
     */
    const f2 = resolveF2EntryScope({ enabled: options.f2?.enabled === true, text })
    if (f2.kind === 'rejected') {
      return { entryRejected: f2.reason, planner: fallback ?? refusalPlanner, ruleSnapshot, usableRuleIds: [],
        entryKind: 'f2_task_entry' as const }
    }
    if (f2.kind === 'entry') {
      /*
       * **F2 链**（R4 §3.9 第 1 点 · 用户裁定 A）：
       *   ① 受信准备读（程序生成、零模型）取得**权威源正文** ⇒ 指纹成为本任务目标真值；
       *   ② 族级标记**每题重读一次**（只有存在当前合格的族规则才读 ⇒ 冷启动不预赠资格）；
       *   ③ 候选来自候选规划器，按**学到的族规则 + 来源归属**做逐候选否决；
       *   ④ `after` 的兜底是任务自己的规划器（无合格规则 ⇒ 普通规划，不假装有规则）。
       */
      const fallbackPlanner = fallback ?? refusalPlanner
      const goalState: { goalFingerprint?: string } = {}
      const after = createF2StrategyPlanner({
        ...options,
        entry: { familyId: f2.familyId, targetPath: f2.targetPath, cacheSource: f2.cacheSource,
          authoritativeSource: f2.authoritativeSource, familyMarker: f2.familyMarker },
        fallback: fallbackPlanner,
        onGoalFingerprint: value => { goalState.goalFingerprint = value },
      })
      const usableRuleIds = await f2QualifiedFamilyRuleIds({
        db: options.db, characterId: options.characterId, activeUserId: options.activeUserId,
        familyId: f2.familyId, declarations: options.precondition?.declarations ?? [],
        ...(options.precondition?.writeSources === undefined ? {} : { writeSources: options.precondition.writeSources }),
      })
      return { planner: createF2PrepReadPlanner({ prepReadPath: f2.prepReadPath, after }), ruleSnapshot,
        usableRuleIds, entryKind: 'f2_task_entry' as const, sourceScopedPaths: f2.sourceScopedPaths,
        completion: ({ results }) => f2GoalCompletion({ targetPath: f2.targetPath,
          goalFingerprint: goalState.goalFingerprint, results }) }
    }
    const preconditionEnabled = options.precondition?.enabled === true
    const resolved = resolvePreconditionEntryScope({
      enabled: preconditionEnabled, text,
      knownDirectories: options.precondition?.knownDirectories ?? ((): readonly string[] => []),
      declarations: options.precondition?.declarations ?? [],
    })
    /*
     * ⚠️ **"明确拒绝"与"不是本入口"必须分开**（修补 ①）：
     *    自称 F1 但形状/辅助路径不合法 ⇒ `entryRejected`（调用方**零动作**、**不**回退）；
     *    不是 F1 请求 ⇒ `undefined`（照旧走普通规划）。
     */
    if (resolved.kind === 'rejected') {
      return { entryRejected: resolved.reason, planner: fallback ?? refusalPlanner, ruleSnapshot, usableRuleIds: [],
        entryKind: 'precondition_two_line' as const }
    }
    let goal: { path: string; expectedFingerprint: string } | undefined
    let boundedObservation: SimulationPlanningConfiguration['boundedObservation']
    let entryKind: SimulationEntryKind = 'legacy_flat'
    if (resolved.kind === 'entry') {
      goal = { path: resolved.targetPath, expectedFingerprint: resolved.expectedFingerprint }
      boundedObservation = { targetPath: resolved.targetPath, conditionPath: resolved.conditionPath, maxReads: 1 }
      entryKind = 'precondition_two_line'
    } else {
      goal = explicitFileGoal(text)
      if (!goal) return undefined
    }
    /*
     * 规则资格只决定"用不用模拟规划器"，**不**决定范围是否存在（修补 ①）：
     * 没有合格读回规则 ⇒ 只给范围、不给规划器 ⇒ 任务用**自己的**规划器，但**仍受范围约束**。
     */
    const usable = selectUsableRules({ snapshots: await ruleSnapshot.list(), visible: {
      subjectId: options.activeUserId, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT,
      conditions: options.facts ?? {},
    } }).selected
    if (usable.length === 0) {
      /*
       * ⚠️ **没有合格读回规则 ≠ 这条请求不存在**（修补 ①）：
       *    合法 F1 请求仍要**带着范围**进入任务环（用任务自己的规划器）；
       *    没有 `fallback` 可用 ⇒ 如实返回 `undefined`（调用方走普通路径 —— 只可能发生在
       *    没有装配任务环的直接调用里；生产装配**总是**传 fallback）。
       */
      if (boundedObservation === undefined) return undefined
      if (fallback === undefined) return undefined
      return { planner: fallback, ruleSnapshot, usableRuleIds: [], entryKind, boundedObservation }
    }
    const planner: TaskPlannerPort = {
      id: 'production-simulation-planner@1', endpointHost: options.candidatePlanner.endpointHost,
      async plan(input) {
        const proposed = await options.candidatePlanner.plan({ ...input,
          allowedCapabilities: input.allowedCapabilities.filter(id => ['sandbox.file.write', 'sandbox.file.read'].includes(id)),
        })
        if (!proposed.ok) return proposed
        if (proposed.candidates?.every(plan => plan.done && plan.steps.length === 0) && input.executed.length > 0) return proposed
        if (!proposed.candidates) return { ok: false, failure: 'invalid_output', requestCount: proposed.requestCount }
        return await createSimulationTaskPlanner({ ...options, goal: goal!,
          candidateSource: { id: planner.id, endpointHost: planner.endpointHost,
            async propose() { return { candidates: proposed.candidates!, requestCount: proposed.requestCount } },
          },
          ...(options.onSelection === undefined ? {} : { onSelection: options.onSelection }),
        }).plan(input)
      },
    }
    // 当时的**规则资格快照**（哪些规则参与了这次选路）。
    return { planner, ruleSnapshot, usableRuleIds: usable.map(item => item.claimId), entryKind,
      ...(boundedObservation === undefined ? {} : { boundedObservation }) }
  }
}

/**
 * **F2 受信准备读调度**（用户裁定 A 的落实 · 零模型调用）。
 *
 * 第一次规划（本任务还没读过权威源）⇒ 输出**单步读权威源**的计划：
 *  · 由**程序生成**，`requestCount: 0`（**不**产生模型请求）；
 *  · 占 **1 次动作 / 1 次规划轮**（预算真实扣减，三臂同口径同付）；
 *  · 读回正文由任务环放进 `TaskPlannerInput.content`（受装配层内容预算约束）。
 * 之后（已读过）⇒ **交回**后续规划器（模拟规划器 / 任务自己的规划器）。
 *
 * ⚠️ 它**不预赠规则资格**：只提供"源正文"，规则仍须由失败证据形成。
 * ⚠️ 读的是**权威源**（真值来源）⇒ 归属可作为 `authoritative` 追溯；写缓存内容则归属 `cache`。
 */
/**
 * **由受信准备读派生本任务的目标真值指纹**（纯函数 · 失败关闭 · 零 IO）。
 *
 * 用户裁定 **A**：权威源正文**不能**由夹具预知 ⇒ 只有**本任务真实读过**权威源
 * （`trustedReads` 里的受信读回执）才有真值；没读过 ⇒ `undefined`（调用方**不许**猜内容）。
 */
export function deriveF2GoalFingerprint (options: {
  readonly targetPath: string
  readonly authoritativeSource: string
  readonly trustedReads?: readonly { readonly path: string, readonly fingerprint: string }[]
}): { readonly goalFingerprint: string } | undefined {
  void options.targetPath
  const read = options.trustedReads?.find(item => item.path === options.authoritativeSource)
  return read === undefined ? undefined : { goalFingerprint: read.fingerprint }
}

/**
 * **F2 链的规划器**（准备读之后的那一段）。
 *
 * | 轮次 | 行为 |
 * | --- | --- |
 * | 真值未取得 | **失败关闭**（不发计划；准备读规划器本应先读权威源） |
 * | 本任务还没读过族标记，且该族**有受信声明** | **程序生成**单步读族标记（占 1 动作 / 1 规划轮、零模型请求；**每题重读一次**） |
 * | 其余 | 候选来自候选规划器 ⇒ 按**学到的族规则 + 受信来源归属**逐候选否决 ⇒ 取**默认顺序**第一个未被否决的 |
 *
 * ⚠️ 标记**每族每题读一次**（冻结任务规格）；读它**不预赠资格**（资格仍由 C2 在观察者侧判）。没有声明 ⇒ 不读。
 * ⚠️ **条件未知**（本任务没读过标记）⇒ **不否决**（不猜）。
 * ⚠️ **全部候选被否决** ⇒ 如实失败（**不**挑一个被否决的候选、**不**记成目标达成）。
 * ⚠️ 缺省 `precondition.enabled=false` ⇒ 否决整段不跑（旧行为不变）。
 */
export function createF2StrategyPlanner (options: WorldModelForecastOptions & {
  readonly entry: {
    readonly familyId: string
    readonly targetPath: string
    readonly cacheSource: string
    readonly authoritativeSource: string
    readonly familyMarker: string
  }
  readonly fallback: TaskPlannerPort
  readonly registry: CapabilityRegistry
  readonly candidatePlanner: TaskPlannerPort
  readonly precondition?: SimulationPreconditionOptions
  readonly onSelection?: (value: SimulationPlanSelection) => void
  /** 派生出的目标真值指纹（给装配层的完成判定用；不产生任何模型请求）。 */
  readonly onGoalFingerprint?: (value: string) => void
}): TaskPlannerPort {
  const { entry } = options
  const fail = (phase: 'candidates_evaluated' | 'goal_fingerprint_unknown', input: TaskPlannerInput,
    reading: Omit<import('./simulation-task-planner.ts').F2PlanReading, 'phase'> | undefined, requestCount = 0): TaskPlannerOutcome => {
    options.onSelection?.({ reason: 'no_rule', f2: { ...(reading ?? {}), phase } })
    void input
    /*
     * ⚠️ 失败码只能是既有闭集（`empty_task` / `timeout` / `call_failed` / `invalid_output`）：
     *    全部候选被否决 ⇒ 用 `invalid_output`（与 F1 否决全清空时同一条路，重试有界，
     *    之后任务环如实停下 ⇒ **不假完成**）。**不**发明新失败码。
     */
    return { ok: false as const, failure: 'invalid_output' as const, requestCount }
  }
  return {
    id: 'f2-strategy@1', endpointHost: options.candidatePlanner.endpointHost,
    async plan (input) {
      const derived = deriveF2GoalFingerprint({ targetPath: entry.targetPath,
        authoritativeSource: entry.authoritativeSource, trustedReads: input.trustedReads })
      if (derived === undefined) return fail('goal_fingerprint_unknown', input, undefined)
      options.onGoalFingerprint?.(derived.goalFingerprint)
      /*
       * ①' **没有合格规则 ⇒ 普通规划**（"无资格普通规划"）：F2 入口**不**因为自称 F2 就获得规则资格。
       *    ⚠️ 范围（两源只读 / 标记限次 / 目标可写）**照样**挂在本任务授权上（由装配层挂）——
       *       范围约束独立于规则资格。
       *    ⚠️ 兜底是**任务自己的**规划器（生产里就是普通规划器），不是我们伪造一份计划。
       */
      const rulesEnabled = options.precondition?.enabled === true
      const declarations = options.precondition?.declarations ?? []
      /*
       * ② 族级标记：**每题重读一次**（冻结任务规格：族级标记"限次只读一次 / 每题重读 / 不沿用上一题"）。
       *
       * ⚠️ 判据是"**该族有受信声明**"，**不是**"已经有合格规则"：
       *    规则资格必须来自**失败证据**（C2：失败回执 + 条件同现 + ≥2 绑定 + 对照）
       *    ⇒ 若只在"已有合格规则"时才读标记，**形成阶段的失败永远带不上条件** ⇒ 规则**永远形不成**
       *      （本轮配对校准的真实链实测：C 的 12 题全是"没失败就直接恢复"，一次否决都没有）。
       * ⚠️ 读标记**不等于**预赠资格：它只提供"这一刻的条件值"，资格仍由 C2 在观察者侧判。
       * ⚠️ 没有声明（例如 f1/a 这种"无前置条件族"）⇒ **不读**（旧入口/无族场景一行不变）。
       */
      if (rulesEnabled && declarations.some(item => item.familyId === entry.familyId) &&
        !executedReadOf(input.executed, entry.familyMarker).attempted && input.remainingActions >= 1) {
        options.onSelection?.({ reason: 'selected', f2: { phase: 'marker_read_scheduled',
          goalFingerprint: derived.goalFingerprint } })
        return { ok: true as const, requestCount: 0, plan: {
          goal: '读取族级条件标记（程序安排的一次只读；每题重读，不沿用上一题）',
          done: false,
          steps: [{ capability: 'sandbox.file.read', operation: 'read', args: { path: entry.familyMarker } }],
        } }
      }
      /*
       * ①' **没有合格规则 ⇒ 普通规划**（"无资格普通规划"）：F2 入口**不**因为自称 F2 就获得规则资格。
       *    ⚠️ 范围（两源只读 / 标记限次 / 目标可写）**照样**挂在本任务授权上（由装配层挂）——
       *       范围约束独立于规则资格。
       *    ⚠️ 兜底是**任务自己的**规划器（生产里就是普通规划器），不是我们伪造一份计划。
       */
      const qualified = rulesEnabled
        ? await f2QualifiedFamilyRuleIds({ db: options.db, characterId: options.characterId,
          activeUserId: options.activeUserId, familyId: entry.familyId, declarations,
          ...(options.precondition?.writeSources === undefined ? {} : { writeSources: options.precondition.writeSources }) })
        : []
      if (qualified.length === 0) {
        options.onSelection?.({ reason: 'no_rule', f2: { phase: 'ordinary_planning_no_rule',
          goalFingerprint: derived.goalFingerprint, qualifiedRuleIds: [] } })
        return options.fallback.plan(input)
      }
      // ③ 候选：只接受本域闭集形状（读目标/两个源，写目标）。
      const proposed = await options.candidatePlanner.plan({ ...input,
        allowedCapabilities: input.allowedCapabilities.filter(id => ['sandbox.file.read', 'sandbox.file.write'].includes(id)),
      })
      if (!proposed.ok) return proposed
      const raw: readonly TaskPlan[] = proposed.candidates ?? [proposed.plan]
      let plans: TaskPlan[]
      try {
        plans = raw.map(plan => validateTaskPlan(plan, { registry: options.registry, allowedCapabilities: input.allowedCapabilities }))
      } catch { return fail('candidates_evaluated', input, { fallback: 'goal_unproven' }, proposed.requestCount) }
      for (const plan of plans) {
        /*
         * ⚠️ **完成声明**（`done:true, steps:[]`）必须放行到任务环的完成校验：
         *    由"真实写入 + 最终读回 == 权威源"判定是否达成，**不**凭声明或字节自证。
         *    `steps:[]` 但 `done:false`、或步骤数超限 ⇒ 仍按非法候选拒绝。
         */
        const completionClaim = plan.steps.length === 0 && plan.done === true
        if ((!completionClaim && plan.steps.length === 0) || plan.steps.length > 4 || plan.steps.length > input.remainingActions) {
          return fail('candidates_evaluated', input, { fallback: 'goal_unproven' }, proposed.requestCount)
        }
        for (const step of plan.steps) {
          const path = step.args.path
          if (step.capability === 'sandbox.file.write') {
            if (step.operation !== 'write' || path !== entry.targetPath || typeof step.args.content !== 'string') {
              return fail('candidates_evaluated', input, { fallback: 'goal_unproven' }, proposed.requestCount)
            }
            continue
          }
          if (step.capability === 'sandbox.file.read') {
            if (step.operation !== 'read' ||
              (path !== entry.targetPath && path !== entry.cacheSource && path !== entry.authoritativeSource)) {
              return fail('candidates_evaluated', input, { fallback: 'goal_unproven' }, proposed.requestCount)
            }
            continue
          }
          return fail('candidates_evaluated', input, { fallback: 'goal_unproven' }, proposed.requestCount)
        }
      }
      /*
       * ④ **逐候选来源限定否决**（R2 已接的同一读面）：内容指纹由**候选实际要写的字节**算，
       *    来源归属只由**本任务**的受信读回执追溯（`unknown` ⇒ 不套用来源限定规则）。
       */
      const vetoed = await evaluateCandidatePreconditionVeto({
        enabled: options.precondition?.enabled === true,
        db: options.db, characterId: options.characterId, activeUserId: options.activeUserId,
        targetPath: entry.targetPath,
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        knownDirectories: options.precondition?.knownDirectories ?? ((): readonly string[] => []),
        declarations: options.precondition?.declarations ?? [],
        writeSources: options.precondition?.writeSources,
      }, plans.map((plan, index) => ({ id: String(index), writeFingerprints: plan.steps
        .filter(step => step.capability === 'sandbox.file.write')
        .map(step => contentFingerprint(step.args.content as string)) })))
      const indexed = plans.map((plan, index) => ({ id: String(index), plan }))
      const filtered = applyPreconditionVeto({ decision: { ...vetoed.evaluation.decision,
          veto: vetoed.vetoedIds.length > 0 },
        candidates: indexed, writesIntoFamily: item => vetoed.vetoedIds.includes(item.id) })
      const evaluation = vetoed.evaluation
      const reading: SimulationPlanSelection['f2'] = {
        phase: 'candidates_evaluated',
        goalFingerprint: derived.goalFingerprint,
        vetoedCandidateIds: filtered.vetoed.map(item => item.id),
        sourceAttributions: vetoed.attributions,
        veto: { decision: evaluation.decision.veto ? 'veto' : 'no_veto', reason: evaluation.decision.reason,
          ...(evaluation.decision.ruleId === undefined ? {} : { ruleId: evaluation.decision.ruleId }),
          ...(evaluation.claimId === undefined ? {} : { claimId: evaluation.claimId }),
          ...(evaluation.ruleStatus === undefined ? {} : { ruleStatus: evaluation.ruleStatus }),
          ...(evaluation.decision.conditionPath === undefined ? {} : { conditionPath: evaluation.decision.conditionPath }),
          ...(evaluation.decision.observedValue === undefined ? {} : { observedValue: evaluation.decision.observedValue }),
          ...(evaluation.decision.conditionSource === undefined ? {} : { conditionSource: evaluation.decision.conditionSource }),
          ...(evaluation.sourceScope === undefined ? {} : { sourceScope: evaluation.sourceScope }),
          fallback: filtered.eligible.length === 0 ? 'goal_unproven' : 'default_order' },
      }
      if (filtered.eligible.length === 0) return fail('candidates_evaluated', input, { ...reading, fallback: 'goal_unproven' }, proposed.requestCount)
      const choice = filtered.eligible[0]!.plan
      options.onSelection?.({ reason: 'selected', selectedIndex: Number(filtered.eligible[0]!.id),
        f2: { ...reading, selectedCandidateId: filtered.eligible[0]!.id } })
      return { ok: true as const, requestCount: proposed.requestCount, plan: choice }
    },
  }
}

/**
 * **当前合格**的族前置条件规则 id（只用于读数与"要不要读族标记"的调度）。
 *
 * ⚠️ 与 F1 §4 的调度同一条判据：按来源作用域（不限 / 缓存 / 权威）分别查合格规则；
 *    查不到 ⇒ **不读标记**（冷启动不预赠资格）。
 */
export async function f2QualifiedFamilyRuleIds (options: {
  readonly db: RawDb
  readonly characterId: CharacterId
  readonly activeUserId: string
  readonly familyId: string
  readonly declarations: readonly WritePreconditionDeclaration[]
  /**
   * **来源读面**：来源限定命题（`conditions.source_scope`）的**资格**来自它。
   * ⚠️ 不传 ⇒ 来源限定命题不会被当成"可用"（这是 R2 的既有口径，不是本模块发明的）。
   */
  readonly writeSources?: WriteSourcesForTarget
}): Promise<string[]> {
  const declaration = options.declarations.find(item => item.familyId === options.familyId)
  if (declaration === undefined) return []
  const snapshots = await createEblRuleSnapshotPort(options.db, options.characterId, options.activeUserId,
    options.writeSources === undefined ? {} : { writeSources: options.writeSources }).list()
  const scope = sandboxWriteFamilyScope(options.familyId)
  const ids: string[] = []
  for (const sourceScope of [undefined, 'cache', 'authoritative'] as const) {
    const selected = selectUsableRules({ snapshots, visible: { subjectId: options.activeUserId, scope,
      environment: EBL_TOOL_ENVIRONMENT, conditions: writePreconditionConditions(declaration, sourceScope) } }).selected
    for (const item of selected) {
      if (item.predicate === 'write_precondition_holds' && item.usable && !ids.includes(item.claimId)) ids.push(item.claimId)
    }
  }
  return ids
}

/**
 * **F2 完成判定**（只按真实结果）：一次真实写入 + **最后**一次成功读回，且读回指纹 == 真值。
 *
 * ⚠️ 真值来自**受信准备读**（权威源正文指纹）；没有真值 ⇒ 一律 `achieved: false`（不猜）。
 * ⚠️ 写入那次的效果指纹也必须是真值（写错内容的"完成"不成立；守卫本来也会拒它）。
 * ⚠️ 模型自述的 `done` **不**参与 ⇒ 假完成判废。
 */
export function f2GoalCompletion (options: {
  readonly targetPath: string
  readonly goalFingerprint: string | undefined
  readonly results: readonly { readonly request: ActionRequest, readonly result: ActionResult, readonly rule: string }[]
}): { achieved: boolean, contentIds: string[] } {
  const goal = options.goalFingerprint
  if (goal === undefined) return { achieved: false, contentIds: [] }
  let lastWrite = -1
  let lastRead = -1
  let writeFingerprint: string | undefined
  let readFingerprint: string | undefined
  options.results.forEach((item, index) => {
    if (item.result.status !== 'success') return
    const path = item.request.arguments.path
    if (typeof path !== 'string' || path !== options.targetPath) return
    const effect = item.result.effect
    if (effect === undefined) return
    if (effect.kind === 'file_created' || effect.kind === 'file_overwritten') {
      lastWrite = index
      writeFingerprint = effect.fingerprint
      return
    }
    if (effect.kind === 'content_read') {
      lastRead = index
      readFingerprint = effect.fingerprint
    }
  })
  const achieved = lastWrite >= 0 && writeFingerprint === goal && lastRead > lastWrite && readFingerprint === goal
  return { achieved, contentIds: [] }
}

/**
 * **执行环 `executed` 摘要行的真实格式**（唯一事实源：`task-loop.ts` 的 `executedSummary.push`）。
 *
 * ```text
 * `${capability}.${operation}${stepReference !== undefined ? ` ${stepReference}` : ''}=${status}`
 * ⇒ 沙箱读：`sandbox.file.read.read path=f1/a/obj-10.src=success`
 *    （⚠️ 是**两个点**：能力 id 本身含点 + 再拼操作；`path=<路径>=<状态>` 在行尾。）
 * ```
 *
 * ⚠️ **这是本轮真实链查出来的**：上一批 `f2-prep-read-verify` 的夹具用的是
 *    `sandbox.file.read path=…=success`（**单点、缺操作**）—— 那个格式**从不出现**在真实环里，
 *    ⇒ 纯函数门绿、真实链第一步之后**永远认不出"已经读过"**（实测停在 `no_progress`）。
 *    ⇒ 现在两边都用**行尾 `path=<路径>=<状态>`** 判，不再依赖"前缀"。
 */
function executedReadOf (executed: readonly string[], path: string): { attempted: boolean; succeeded: boolean } {
  /*
   * ⚠️ 判据刻意是**「能力.操作 + 空格」前缀 + `path=<路径>=<状态>` 行尾**：
   *    只认真实格式；**单点/缺操作**的假行（`sandbox.file.read path=…`）**不算**读过（失败关闭）。
   */
  const prefix = 'sandbox.file.read.read '
  const suffix = `path=${path}=`
  const matches = executed.filter(item => item.startsWith(prefix) && item.includes(suffix))
  return { attempted: matches.length > 0, succeeded: matches.some(item => item.includes(`${suffix}success`)) }
}

/**
 * **F2 受信准备读调度**（用户裁定 A 的落实 · 零模型调用）。
 *
 * 第一次规划（本任务还没读过权威源）⇒ 输出**单步读权威源**的计划：
 *  · 由**程序生成**，`requestCount: 0`（**不**产生模型请求）；
 *  · 占 **1 次动作 / 1 次规划轮**（预算真实扣减，三臂同口径同付）；
 *  · 读回正文进 `TaskPlannerInput.content`（受装配层内容预算约束），其指纹由
 *    `deriveF2GoalFingerprint` 从**受信读回执**派生（`trustedReads`）。
 * 之后（已读过）⇒ **交回**后续规划器（`createF2StrategyPlanner` / 任务自己的规划器）。
 *
 * ⚠️ 它**不预赠规则资格**：只提供"源正文 + 真值指纹"，规则仍须由失败证据形成。
 * ⚠️ 读的是**权威源**（真值来源）⇒ 归属可作为 `authoritative` 追溯；写缓存内容则归属 `cache`。
 */
export function createF2PrepReadPlanner (options: {
  readonly prepReadPath: string
  readonly after: TaskPlannerPort
}): TaskPlannerPort {
  return {
    id: 'f2-prep-read@1',
    endpointHost: 'none',
    async plan (input) {
      const read = executedReadOf(input.executed, options.prepReadPath)
      if (!read.succeeded) {
        return {
          ok: true as const,
          requestCount: 0,
          plan: {
            goal: '只读一次权威源（受信准备读：取得真值正文，不采信夹具预知）',
            done: false,
            steps: [{ capability: 'sandbox.file.read', operation: 'read', args: { path: options.prepReadPath } }],
          },
        }
      }
      return options.after.plan(input)
    },
  }
}
