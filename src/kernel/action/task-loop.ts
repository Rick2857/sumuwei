/**
 * TaskLoop —— **有限任务执行环**（第二批计划 §2.2）。
 *
 * ============================================================================
 *  它做的事只有一件：把"计划 → 执行 → 看结果 → 再计划"这条环**有界**地跑完
 * ============================================================================
 * ```text
 * ① 取一份**仍然有效**的任务授权（内存绑定当前会话；没有授权 = 一步都不做）
 * ② 问规划器要一份有限计划（扣一次规划预算）
 * ③ 程序校验（能力 ∈ 授权集合、参数 ∈ 白名单、暂存字段改写）—— 失败即整条作废
 * ④ 逐步走**既有** `ActionGateway`（注册表 / 策略 / 账本 / 适配器一个都不换）
 * ⑤ 预算用尽 / 时限到 / 规划器说 done ⇒ 停，并**如实**记下为什么停
 * ```
 *
 * ============================================================================
 *  三条不许破的边界
 * ============================================================================
 * ```text
 * ① **不伪造轮次**：所有步骤挂在**同一个** traceId 上，共享同一份任务的归因。
 *    计划书 §2.2 逐字："不能靠后台循环伪造新轮次规避旧搜索额度"。
 * ② **不扩大授权**：`ActionRequest` 的 capability 只能取自授权的集合；
 *    风险额度只能等于授权里那个值（**模型没有任何字段能改它**）。
 * ③ **不假报**：预算用尽时 `stopped` 如实写 `budget_*`；
 *    规划器失败时如实写 `plan_failed` 并保留**已经执行过的那几步**的结果
 *    （"如实返回已完成和未完成部分，不假报继续运行"）。
 * ```
 *
 * ============================================================================
 *  暂存字段的改写（`content` / `spec` → 引用）
 * ============================================================================
 * 计划里可以带 `content`（本机写入的正文）与 `spec`（Office 生成的结构化规格），
 * 但**它们不会进入 `ActionRequest.arguments`**：
 * ```text
 * content  → staging.put({kind:'text'})   → args.payloadRef + payloadBytes + payloadFingerprint
 * spec     → staging.put({kind:'json'})   → args.specRef    + specBytes    + specFingerprint
 * ```
 * ⇒ 账本的 `summarizeArguments()` 看到的永远是引用与指纹（正文不进账本 / trace / 开发者面）。
 */

import type { ActionId, CharacterId, Timestamp, TraceId } from '../contracts/ids.ts'
import { newActionId } from '../contracts/ids.ts'
import type { ActionRequest } from './action-request.ts'
import { createActionRequest, hasSideEffect } from './action-request.ts'
import type { ActionResult } from './action-result.ts'
import type { CapabilityRegistry } from './capability-registry.ts'
import type { ActionGateway, ActionInvocationContext, TargetResolution } from './gateway.ts'
import { fnv1a64Hex } from './idempotency.ts'
import type { PayloadStagingPort } from './payload-staging.ts'
import type { OperationDefinition } from './capability-registry.ts'
import {
  renderTurnContentEntry,
  selectTurnContentContext,
  turnContentIdentityOf,
  TURN_CONTENT_LIMITS,
  type TurnContent,
} from '../contracts/turn-content.ts'
import {
  renderExternalEvidenceEntry,
  selectExternalEvidenceContext,
  type ExternalEvidence,
} from '../contracts/external-evidence.ts'
import { applyReadRoots, pathWithinReadRoots, type TaskAuthorization, type TaskAuthorizationPort, type TaskCloseReason } from './task-authorization.ts'
import {
  compareForecastStep,
  forecastDependenciesSatisfied,
  parameterBindingDigestOf,
  type ActionForecastPort,
  type ActionForecastStateLine,
} from './action-forecast.ts'
import {
  verifyPlanRulesStillUsable,
  type PlanRuleDependency,
  type RuleSnapshotPort,
} from '../contracts/cognitive-collaboration.ts'
import type { ActionForecast } from '../contracts/world-model.ts'
import {
  TASK_STAGED_ARG_KEYS,
  taskStepReferenceIsExclusive,
  taskStepReferenceOf,
  validateTaskPlan,
  type TaskPlan,
  type TaskPlanStep,
  type TaskPlannerPort,
} from './task-plan.ts'

/**
 * 连续的"模型没按格式答"最多容忍几次（有界重试；见 `invalid_output` 分支）。
 *
 * ⚠️ 它与**规划预算**是两道不同的闸：预算管"一共能问几次"，这个管"同一个格式错误
 *    连续犯几次就别再问了"。两者都在 ⇒ 重试不会变成一次无界循环。
 */
export const MAX_INVALID_OUTPUT_STREAK = 3

/**
 * WP2：交给下一次规划的**内容份数**上限（防止"列 100 个目录"把内存与额度都占满）。
 *
 * ⚠️ 它与 token 额度是**两道**闸：这一道管"最多留几份"，token 额度管"这一次能带几份"。
 *    两者都在 ⇒ 收敛不依赖任何一个单点。
 */
export const MAX_GATHERED_CONTENT_ITEMS = TURN_CONTENT_LIMITS.maxItemsPerTurn

/** WP3：交给下一次规划的外部证据**条数**上限（与内容同一理由：防"搜一下把额度吃光"） */
export const MAX_GATHERED_EVIDENCE_ITEMS = 8

export interface EblTaskObserver {
  before(input: { request: ActionRequest; authorization: TaskAuthorization; characterId: CharacterId }): Promise<{ predictionChanged: boolean } | void>
  /**
   * 动作**执行之后**的观察口。
   *
   * ⚠️ `comparison`（2026-10-21 新增 · 计划 P2 第 4 步）：**这一轮**的预测核对结论。
   *    它是**可选**的：没有预测、没有核对 ⇒ 不给 ⇒ 观察方按"没有模型参与"处理。
   *    ⇒ 有了它，观察方才能把「比的是**哪一版模型 / 哪条规则 / 哪个对象**」
   *      一起落进账本（集成架构 §4 的「比较与结算」要求）。
   */
  after(input: {
    request: ActionRequest
    result: ActionResult
    authorization: TaskAuthorization
    characterId: CharacterId
    comparison?: {
      readonly verdict: 'match' | 'mismatch' | 'unknown'
      readonly modelVersion: string
      readonly ruleVersion: string
      readonly parameterBindingDigest?: string
      readonly predictionRef?: string
    }
  }): Promise<void>
}

export interface TaskLoopOptions {
  /** Trusted scoped goal check; model proposals cannot install it. Selected IDs use the existing planning budget. */
  completion?: (input: { results: TaskRunOutcome['results']; visibleContentIds: readonly string[] }) => { achieved: boolean; contentIds: string[] }
  /** Optional, default off. Observes already-authorized actions; never adds tools or steps. */
  epistemic?: EblTaskObserver
  /**
   * 规则快照读面（**可选**；计划 P2 第 5 步）。
   *
   * ⚠️ 给了它，任务环在**每一步执行前**复核「这一步依赖的规则**现在**还合格吗」——
   *    规则在计划执行**途中**失去资格（被反例挂起 / 被撤回 / 换了版本）⇒
   *    这一步**不执行**（具名拒用），计划就此停下。
   *
   * ⚠️ 不给 ⇒ 不做这个复核（**既有行为逐字不变**）。
   */
  ruleSnapshot?: RuleSnapshotPort
  /**
   * **P3-4：本轮已加载技能所声明的规则依赖**（可选；缺省不传 ⇒ 旧入口行为逐字不变）。
   *
   * ⚠️ 给了它（且给了 `ruleSnapshot`）⇒ 任务环在**每一步执行前**复核"这些依赖的规则
   *    还合格吗"。规则在加载之后、动作之前失效（被撤回 / 挂起 / 换了版本）⇒
   *    这一步**不执行**（`droppedReason: 'skill_rule_unusable'`），计划就此停下。
   *
   * ⚠️ 它**不**自己判断"哪些规则适用"：依赖由技能声明、资格由 P1/P2 判据算，
   *    任务环只做"执行前复核"这一件事。
   */
  skillRuleDependencies?: readonly PlanRuleDependency[]
  /**
   * **P3-5b · G5：任务局部读根**（可选；缺省不传 ⇒ 旧入口与普通文件任务行为逐字不变）。
   *
   * ⚠️ 触发条件：这一步**真的成功加载了** `skillId`（受管目录里的 personal-library）⇒
   *    程序把 `roots` 挂到**本次任务授权**上（只许收窄、不许扩大），
   *    之后**每一步读动作执行前**都按读根判：落在根外 ⇒ 这一步**不执行**
   *    （`droppedReason: 'read_outside_task_roots'`），计划停下。
   *
   * ⚠️ 为什么是"任务局部的读根"而不是"全局限制 `local.file.read`"：
   *    产品里同一个能力也被普通文件任务用；全局收窄会**改掉无关任务的行为**。
   *    这里只约束"受管 personal-library 参与的那一次任务"。
   * ⚠️ 读根来自**装配层**（真实资料根），模型给的路径绕不过去：闸在任务环，不在规划器闭包。
   */
  readRootScope?: {
    /** 参与后收窄读根的那个技能 id（当前 = `personal-library`）。 */
    readonly skillId: string
    /** 允许读取的根（真实路径）。 */
    readonly roots: readonly string[]
    /** 范围来源（诊断/审计用，例如 `main:p3-managed-personal-library`）。 */
    readonly source: string
  }

  gateway: ActionGateway
  registry: CapabilityRegistry
  authorizations: TaskAuthorizationPort
  planner: TaskPlannerPort
  staging: PayloadStagingPort
  resolveTarget: (input: {
    request: ActionRequest
    operation: OperationDefinition | undefined
  }) => Promise<TargetResolution>
  /** 受信 ingress 为**每一步**产出的 invocation（含任务级风险额度） */
  invocationFor: (input: {
    authorization: TaskAuthorization
    step: TaskPlanStep
  }) => ActionInvocationContext
  now?: () => number
  /** 新 actionId 生成器（注入以便测试固定值） */
  newActionIdFn?: () => ActionId
  /**
   * WP2 / ADR-104 `D14`：**重新规划时**给规划器的程序事实与内容额度。
   *
   * ```text
   * 不配（缺省） ⇒ 规划器输入与今天**逐字段相同**（旧档与全部既有门不受影响）
   * 配了         ⇒ 每一轮重新规划都带上：
   *                  · `knownDirectories`：程序给出的已知目录事实（渲染后）
   *                  · `content`：已经真的读到的那批内容（**额度内**，与注入 prompt
   *                    同一套选择器与渲染器）
   * ```
   * ⚠️ 额度是**装层给的数**（缺省 0 = 什么都不带）；kernel 不读开关。
   */
  replanContext?: {
    /** 已经渲染好的已知目录事实（由装配层用 `renderKnownDirectoriesForModel` 产出） */
    knownDirectories: () => readonly string[]
    /** 给规划器的内容额度（token；0 ⇒ 不带内容） */
    contentTokens: number
    /**
     * 给规划器的**外部证据额度**（token；缺省 0 ⇒ 不带证据）。
     *
     * ⚠️ 与 `contentTokens` **互相独立**：一条是"我读到的正文"，一条是"搜索命中的来源行"。
     *    合成一个额度会让"只想给正文"或"只想给来源"这两种真实配置都表达不出来。
     */
    evidenceTokens?: number
    /** token 估算器（缺省与上下文编译器同一套 `ceil(chars/2)`） */
    quantifier?: (text: string) => number
  }
  /**
   * **行动预测**端口（三域应用方案 §2）。
   *
   * ```text
   * 不配（缺省）⇒ 这一层整段不跑：输入、执行顺序与预算**逐字段**与旧档相同
   * 配了         ⇒ 每份计划在执行前要一次预测；执行后用**真实结果**核对；
   *               核对不通过 ⇒ 停止沿用该结果的后续步骤并重新规划
   * ```
   *
   * ⚠️ **模型调用计入同一份预算**：预测调用会**扣一次规划预算**
   *    （§2："不得借新模型调用绕过既有 `maxPlans`"）——
   *    ⇒ 开着它的时候，能重新规划的次数**真的变少**了。这是代价，不是细节。
   * ⚠️ 预测**不扩权**：端口拿不到授权集合、参数与执行器（见 `ActionForecastInput`）。
   */
  forecast?: {
    port: ActionForecastPort
    /** 预测调用的硬期限（毫秒；有界；不许超过剩余任务时限） */
    deadlineMs: number
  }
}

export interface TaskStepRecord {
  capability: string
  operation: string
  /** 只记**闭集**：状态、失败码、指纹、字节数 —— 不记参数内容 */
  status?: ActionResult['status']
  failureCode?: string
  /**
   * 适配器给的**闭集**原因（`error.details.reason`），只在它像一条短码时才收。
   *
   * ⚠️ 判据（`/^[a-z][a-z0-9_]{0,39}$/`）是**隐私边界**，不是格式洁癖：
   *    `details` 是 `Record<string, unknown>`，适配器理论上可以往里放任何东西。
   *    只收"像机器码"的值 ⇒ 用户正文不可能从这里进诊断面。
   */
  failureReason?: string
  actionId?: string
  /** 被程序**丢弃**的步骤（越权 / 参数不合法 / 预算不足） */
  droppedReason?: string
}

/** 一条"像机器码"的原因（长度与字符集都受限） */
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,39}$/

function closedSetReason(result: ActionResult): string | undefined {
  const reason = result.error?.details?.reason
  return typeof reason === 'string' && REASON_PATTERN.test(reason) ? reason : undefined
}

export type TaskStopReason = TaskCloseReason

/**
 * 一次**执行后核对**的读数（预测层开着时才有）。
 *
 * ⚠️ 它记的是**比较**，不是"谁对谁错"：模型自报的不确定性不参与判定，
 *    判定完全由**程序**拿真实结果与闭集核对条件做。
 */
export interface TaskForecastComparison {
  /** 计划里的第几步（0 基） */
  readonly planStepIndex: number
  readonly capability: string
  readonly operation: string
  readonly comparable: boolean
  readonly verdict: 'match' | 'mismatch' | 'unknown'
  /** 实际结果的引用（`ActionResult.actionId`；**不复制正文**） */
  readonly actualSourceRef: string
  /**
   * **模型版本**（2026-10-21 新增 · 计划 P2 第 3 步）。
   *
   * ⚠️ 比较结论要能回答"比的是哪一版**模型**" ⇒ 版本必须**跟着结论走**
   *    （只留在 forecast 里的话，结论落账后就查不到了）。
   */
  readonly modelVersion?: string
  /**
   * **被反驳的规则版本**（2026-10-21 新增）。
   *
   * ⚠️ 计划 §4 的接线契约要求「比较与结算」带上它：
   *    没有它，"被反驳"归不到**哪一条规则**头上。
   */
  readonly refutedRuleVersion?: string
  /** 规则依赖（命题 id + 版本 + 证据指纹） */
  readonly ruleDependencies?: readonly {
    readonly claimId: string
    readonly ruleVersion: string
    readonly evidenceFingerprint: string
  }[]
}

export interface TaskRunOutcome {
  /** Retrieval verified in the planning context; final answer delivery is checked after compilation. */
  goal?: { achieved: boolean; contentIds: string[] }
  epistemicPredictions?: number
  epistemicFailures?: number
  taskId: string
  /** 已经执行过的步骤（保序） */
  steps: readonly TaskStepRecord[]
  /** 每一次真的发生的动作结果，交给轮次（与单动作路径同一个形状） */
  results: readonly { request: ActionRequest; result: ActionResult; rule: string }[]
  plansUsed: number
  actionsUsed: number
  stopped: TaskStopReason
  /** 规划器失败时的**闭集**码（不含模型原文） */
  plannerFailureCode?: string
  /** 计划被程序丢弃时的**闭集**码（不含模型原文） */
  planRejectedCode?: string
  /**
   * 预测调用次数（**只在预测层配过时**出现；不配 ⇒ 这个键根本不存在）。
   *
   * ⚠️ 它**已经**扣在规划预算里（见 `TaskLoopOptions.forecast` 的说明），
   *    所以 `plansUsed` 里也含它 —— 这一栏只是把两件事分开记账。
   */
  forecastCallsUsed?: number
  /** 预测失败时的**闭集**码（不含模型原文） */
  forecastFailureCode?: string
  /** 执行后的核对读数（**只在预测层配过时**出现） */
  comparisons?: readonly TaskForecastComparison[]
  /** Pure simulations inside already-counted planning; no extra model calls. */
  simulationsUsed?: number
}

export interface RunTaskInput {
  characterId: CharacterId
  traceId: TraceId
  authorization: TaskAuthorization
  /** 用户原话（**逐字**；规划器看到的就是它） */
  text: string
}

/**
 * 跑完一个任务的执行环。
 *
 * ⚠️ 它**只**在拿到一份仍然有效的任务授权时才会执行任何东西；
 *    没有授权 ⇒ 调用方**根本不该调它**（`main.ts` 在检测层就决定了）。
 */
export async function runTask(
  options: TaskLoopOptions,
  input: RunTaskInput
): Promise<TaskRunOutcome> {
  const now = options.now ?? (() => Date.now())
  const newId = options.newActionIdFn ?? (() => newActionId())
  const steps: TaskStepRecord[] = []
  const results: { request: ActionRequest; result: ActionResult; rule: string }[] = []
  const executedSummary: string[] = []
  const failureSummary: string[] = []
  let epistemicPredictions = 0
  let epistemicFailures = 0
  /*
   * 已经**成功过**的"引用步骤"（`能力.操作 引用`）。
   *
   * ⚠️ 三条安全边界（少一条就会误判"这一步做过了"）：
   * ```text
   * ① 只收 `taskStepReferenceIsExclusive()` 的步骤 —— 带载荷（content/spec）的写步骤
   *    **永不**进这里：同一个路径 + 不同正文是两件事，误判会让那一写根本不发生
   * ② 只收 `success` 的（失败/拒绝的步骤本来就该换做法）
   * ③ **有副作用的步骤会作废同一条引用上的记录**：写完再读回来核对是**合理**的重复
   * ```
   */
  const succeededReferenceSteps = new Set<string>()
  /**
   * WP2 / ADR-104 `D14`：**已经真的读到的内容**（保序去重后交给下一次规划）。
   *
   * ⚠️ 只有配了 `replanContext` 才会被用；不配 ⇒ 一次都不读（旧档零开销）。
   * ⚠️ 它**不含**要写出去的载荷：`content` / `spec` 在这一层已经被换成暂存引用
   *    （见 `stagePayloadArgs`），因此这里收集到的只可能是**读回来的东西**。
   */
  const gatheredContent: TurnContent[] = []
  /**
   * F2 准备读 · **本任务已成功的受信读回执**（沙箱相对路径 + 内容指纹）。
   *
   * ⚠️ 只从**真实成功的读动作**的效果里取（`effect.kind === 'content_read'` 且带指纹）。
   *    候选自述、模型标签、夹具预知都进不来。
   * ⚠️ 没有读过任何东西时**为空** ⇒ 规划器输入逐字段与旧档相同。
   */
  const trustedReads: { path: string, fingerprint: string }[] = []
  /**
   * WP3：**已经拿到的外部证据**（搜索命中；同样只在配了 `replanContext` 时才被消费）。
   *
   * ⚠️ 按 `evidence.id` 去重：同一条命中被两次搜索带回来时不该占两份额度。
   */
  const gatheredEvidence: ExternalEvidence[] = []

  let stopped: TaskStopReason = 'done'
  const stopIfClosed = (): boolean => {
    if (authorization.closedReason === undefined) return false
    stopped = authorization.closedReason
    return true
  }
  let plannerFailureCode: string | undefined
  let planRejectedCode: string | undefined
  /** 连续多少次"模型没按格式答"（有界重试；见下面的 `invalid_output` 分支） */
  let invalidOutputStreak = 0
  /** 预测层开着时：已经用掉的预测调用次数（**已扣在规划预算里**） */
  let forecastCalls = 0
  let simulationsUsed = 0
  /** 预测层开着时：预测失败的闭集码 */
  let forecastFailureCode: string | undefined
  /** 预测层开着时：执行后的核对读数 */
  const comparisons: TaskForecastComparison[] = []
  /**
   * **被反驳**的步骤键（`能力.操作`）。
   *
   * ⚠️ 依赖闸读它：依赖了某个被反驳的步骤 ⇒ 那一步**不执行**（重新规划）。
   *    "被反驳"与"没观测到"是**两件事**：后者（`unknown`）**不**进这个集合 ——
   *    把"没观测到"当成"失败"会让一条正常链路凭空断掉。
   * ⚠️ 它**跨迭代**保留：一次被反驳的核对，直到同一件事**被再次核对通过**才清除。
   *    否则会出现这种假完成：第一次核对被反驳 → 重新规划 → 预算用完 → 没有第二次核对
   *    → "写成功"被当成"写成了" ⇒ 任务报完成（**这正是本机制要消灭的误报**）。
   */
  const refutedSteps = new Set<number>()
  /**
   * **被反驳**的步骤键（跨迭代；键 = `能力.操作`）。
   *
   * ⚠️ 它与 `refutedSteps` 分开：前者是**本份计划内**的下标（依赖闸用），
   *    后者是**任务级**的键（完成声明闸用）。键相同但含义不同 ⇒ 不合成一个集合。
   */
  const refutedKeys = new Set<string>()
  let goal: TaskRunOutcome['goal']
  const goalAccepted = (): boolean => {
    if (!options.completion) return true
    const visibleContentIds = options.replanContext ? selectTurnContentContext({items:gatheredContent,
      budgetTokens:options.replanContext.contentTokens,quantifier:options.replanContext.quantifier}).selected.map(e=>e.item.contentId) : []
    goal = options.completion({results,visibleContentIds})
    return goal.achieved
  }

  const authorization = input.authorization

  /*
   * WP2/WP3：**已经真的读到的内容**与**外部证据**的渲染行。
   *
   * ⚠️ 抽成两个局部函数是为了让**规划器**与**预测器**看到**同一份**渲染
   *    （同一套选择器 + 同一套渲染器）—— 否则"预测依据的读回"与"规划依据的读回"
   *    会是两套东西，而比较结论就失去了参照系。
   * ⚠️ 键的**存在条件**逐字保留旧样（只有真的有内容时那个键才出现），
   *    因此规划器输入在旧档下**逐字段不变**。
   */
  const renderedContentLines = (): string[] => {
    if (options.replanContext === undefined || gatheredContent.length === 0) return []
    return selectTurnContentContext({
      items: gatheredContent,
      budgetTokens: options.replanContext.contentTokens,
      ...(options.replanContext.quantifier !== undefined
        ? { quantifier: options.replanContext.quantifier }
        : {}),
    }).selected.map((entry) => renderTurnContentEntry(entry.item, entry.label))
  }
  const renderedEvidenceLines = (): string[] => {
    if (options.replanContext === undefined || gatheredEvidence.length === 0) return []
    return selectExternalEvidenceContext({
      evidence: gatheredEvidence,
      budgetTokens: options.replanContext.evidenceTokens ?? 0,
      ...(options.replanContext.quantifier !== undefined
        ? { quantifier: options.replanContext.quantifier }
        : {}),
    }).selected.map((item) => renderExternalEvidenceEntry(item))
  }

  for (;;) {
    if (stopIfClosed()) break
    // ⓪ 时限
    if (now() >= authorization.expiresAt) {
      options.authorizations.close(authorization.taskId, 'deadline')
      stopped = 'deadline'
      break
    }
    // ① 规划预算
    if (!options.authorizations.consumePlan(authorization.taskId)) {
      options.authorizations.close(authorization.taskId, 'budget_plans')
      stopped = 'budget_plans'
      break
    }

    const remainingActions =
      authorization.budget.maxActions - authorization.actionsUsed

    const planned = await options.planner.plan({
      task: input.text,
      // ⚠️ **本任务的 trace id**（ADR-151 步骤 D）：让消费方只读**这一次任务**的受信观察。
      traceId: input.traceId,
      /*
       * ⚠️ **有界条件观察**（ADR-151 R1 §3）：只有本次授权带了局部范围才出现。
       *    缺省不出现在规划器输入里 ⇒ 旧行为逐字段不变。
       */
      ...(authorization.boundedObservation === undefined
        ? {}
        : {
          observation: {
            targetPath: authorization.boundedObservation.targetPath,
            conditionPath: authorization.boundedObservation.conditionPath,
            attempted: authorization.boundedObservation.attempts > 0,
          },
        }),
      executed: executedSummary,
      failures: failureSummary,
      remainingActions,
      allowedCapabilities: authorization.allowedCapabilities,
      /*
       * WP2：把**实际内容**与**程序事实**交给规划器（不配 `replanContext` ⇒ 都不出现）。
       * ⚠️ 内容走的是**既有**选择器与渲染器（`selectTurnContentContext` /
       *    `renderTurnContentEntry`）：与"注入 prompt 的那一份"同源 ⇒ 估算的就是注入的。
       */
      ...(options.replanContext !== undefined && gatheredContent.length > 0
        ? { content: renderedContentLines() }
        : {}),
      /*
       * F2 准备读 / 真值派生：**受信读回执**（路径 + 内容指纹）。
       * ⚠️ 只在真的读到过时才出现 ⇒ 旧档的规划器输入逐字段不变。
       */
      ...(trustedReads.length === 0 ? {} : { trustedReads }),
      ...(options.replanContext !== undefined && gatheredEvidence.length > 0
        ? { evidence: renderedEvidenceLines() }
        : {}),
      ...(options.replanContext !== undefined
        ? { knownDirectories: options.replanContext.knownDirectories() }
        : {}),
    })

    // Authorization can close while planning is awaited; its returned proposal has no execution authority.
    if (stopIfClosed()) break

    if (!planned.ok) {
      /*
       * ======================================================================
       *  **形状失败 ⇒ 再问一次**（2026-10-04 真模型 live 逼出来的分叉）
       * ======================================================================
       * ```text
       * timeout / call_failed / empty_task   ⇒ 传输或环境问题，再问也是白问 ⇒ 停
       * invalid_output                        ⇒ **模型自己没按格式答**
       *                                        （实测：它把 `content` 用在了
       *                                          `office.generate` 上，而那张表只收 `spec`）
       * ```
       * 后者是**可恢复**的：把闭集失败码喂回下一轮规划，模型换个写法就行 ——
       * 这正是计划书 §2.2 的"必要时修正后续步骤"。第一版把两者一起停了，
       * 于是"模型多写了一个参数名"直接终结整个任务。
       *
       * ⚠️ 它**不放松**任何校验：整条计划照样被 `validateTaskPlan` 拒收；
       *    变的只是"拒收之后还问不问"。重试次数由两道闸限住：
       *    规划预算（6 次）与连续的 `invalid_output` 计数（≤3）。
       */
      if (planned.failure === 'invalid_output' && invalidOutputStreak < MAX_INVALID_OUTPUT_STREAK) {
        invalidOutputStreak += 1
        plannerFailureCode = planned.parseFailureCode ?? planned.failure
        failureSummary.push(`planner=invalid_output:${planned.parseFailureCode ?? 'unknown'}`)
        continue
      }
      /*
       * ⚠️ 规划器失败**不推翻已经做过的事**：`steps` 与 `results` 原样保留，
       *    `stopped` 如实写 `plan_failed`。这正是计划书要的
       *    "如实返回已完成和未完成部分，不假报继续运行"。
       */
      plannerFailureCode = planned.parseFailureCode ?? planned.failure
      options.authorizations.close(authorization.taskId, 'plan_failed')
      stopped = 'plan_failed'
      break
    }
    // 成功拿到一份能用的计划 ⇒ 连续计数清零（否则一次坏格式会永久拖累后续）
    invalidOutputStreak = 0

    /*
     * ⚠️ **执行环自己也校验一遍**（2026-10-04 的真模型 live 逼出来的）。
     *
     * ```text
     * 第一版只让**规划器**调 `parseTaskPlan`（离线的脚本化规划器直接返回形状，
     * 从不经过校验器）⇒ "spec 里的嵌套对象"那条缺陷在 28 组离线验收里
     * **一个断言都没碰到**，却让真模型的一次办公计划整条作废。
     * ```
     * 两处调的是**同一个** `validateTaskPlan`（不是两份判据），因此不存在
     * "两份校验会分叉"的问题 —— 它只是让"计划能不能被执行"这件事在
     * **消费点**也有一个权威答案，而不是依赖上游自觉。
     */
    let plan: TaskPlan
    try {
      plan = validateTaskPlan(planned.plan, {
        registry: options.registry,
        allowedCapabilities: authorization.allowedCapabilities,
      })
    } catch (error) {
      planRejectedCode = String((error as { code?: unknown }).code ?? 'task_plan_unusable')
      options.authorizations.close(authorization.taskId, 'plan_failed')
      stopped = 'plan_failed'
      break
    }

    if (planned.simulation !== undefined) {
      if (options.ruleSnapshot === undefined || options.forecast !== undefined) {
        planRejectedCode = options.ruleSnapshot === undefined ? 'simulation_rule_unusable' : 'simulation_forecast_conflict'
        options.authorizations.close(authorization.taskId, 'plan_failed')
        stopped = 'plan_failed'
        break
      }
      simulationsUsed++
    }

    if (plan.steps.length === 0) {
      if (options.completion && (!plan.done || !goalAccepted())) {
        options.authorizations.close(authorization.taskId, 'plan_failed'); stopped='plan_failed'; planRejectedCode='task_goal_unmet'; break
      }
      if (plan.done && refutedKeys.size > 0 && !goal?.achieved) {
        options.authorizations.close(authorization.taskId, 'check_refuted')
        planRejectedCode = 'task_check_refuted'
        stopped = 'check_refuted'
        break
      }
      options.authorizations.close(authorization.taskId, 'done')
      stopped = 'done'
      break
    }

    /*
     * ========================================================================
     *  ⓪ 进度闸（**2026-10-05 真实事故**逼出来的）
     * ========================================================================
     * ```text
     * 规划器看不到内容（它只看到"已经执行过的步骤"摘要），于是它会把
     * **同一个引用**反复列出来；而摘要里连路径都没有 ⇒ 靠模型自己是收敛不了的。
     * 实测：一个 trace 里 12 次 local.file.list，10 次成功、同一个目录列了 6 次，
     *       浪费 25 秒与 12 次行动预算，最后还因为"当轮内容超单轮上限"把整轮打死。
     * ```
     * 判据是**整份计划**（不是单步）全都"已经成功过的引用 + 同一个操作":
     * ```text
     * 全中 ⇒ 再执行一遍不会产生任何新事实 ⇒ 如实停止（`no_progress`）
     * 只要有一小步是新的 ⇒ 照常执行（宁可多跑一步，不可少做一件事）
     * ```
     * ⚠️ 两条**保守**边界（见 `succeededReferenceSteps` 的三条）：
     *    没有引用的步骤（`browser.read` 的空参数）与**带载荷的**步骤
     *    （`local.file.write` 的 `content`）**都不进**这条判据 ——
     *    它们的"重做"可能是**有意义**的（世界变了 / 正文换了）。
     */
    const planIsAllRedundant =
      plan.steps.length > 0 &&
      plan.steps.every((step) => {
        if (!taskStepReferenceIsExclusive(step.args)) return false
        const reference = taskStepReferenceOf(step.args)
        return (
          reference !== undefined &&
          succeededReferenceSteps.has(`${step.capability}.${step.operation} ${reference}`)
        )
      })
    if (planIsAllRedundant) {
      options.authorizations.close(authorization.taskId, 'no_progress')
      planRejectedCode = 'task_plan_no_progress'
      stopped = 'no_progress'
      break
    }

    /*
     * ========================================================================
     *  ⓪½ 行动预测（三域应用方案 §2）：**执行前**拿预测，**执行后**核对
     * ========================================================================
     * ```text
     * 预算检查   没有行动预算 ⇒ 不再花一次模型调用去预测（纯浪费）
     * 预算记账   预测调用**扣一次规划预算** ⇒ 不得借新模型调用绕过既有 maxPlans
     * 预测失败   ⇒ 这一轮**没有**预测（任务行为回到旧档），如实记闭集码
     * ```
     * ⚠️ 预测**不授权**任何东西：它拿不到授权集合、参数与执行器。
     * ⚠️ 预测**不延长**任务、不重试副作用、不探索：它只是一次**只读**的诊断调用。
     */
    refutedSteps.clear() // Indices belong to this plan only.
    let forecast: ActionForecast | undefined = planned.simulation?.forecast
    if (options.forecast !== undefined) {
      const remainingActionsNow = authorization.budget.maxActions - authorization.actionsUsed
      if (remainingActionsNow > 0 && options.authorizations.consumePlan(authorization.taskId)) {
        forecastCalls += 1
        const producedAt = now()
        const planSignature = plan.steps.map((step) => `${step.capability}.${step.operation}`)
        const stateLines: ActionForecastStateLine[] = steps.map((step) => ({
          step: `${step.capability}.${step.operation}`,
          status: step.status ?? step.droppedReason ?? 'dropped',
          ...(step.failureCode !== undefined ? { failureCode: step.failureCode } : {}),
        }))
        const inputRevision = `task-forecast@1:${fnv1a64Hex(
          JSON.stringify({ goal: plan.goal, steps: plan.steps, state: stateLines })
        )}`
        const readback = [...renderedContentLines(), ...renderedEvidenceLines()]
        const deadlineMs = Math.max(
          1,
          Math.min(options.forecast.deadlineMs, Math.max(1, authorization.expiresAt - now()))
        )
        const outcome = await options.forecast.port.forecast({
          goal: plan.goal,
          candidateSteps: plan.steps.map((step) => ({
            capability: step.capability,
            operation: step.operation,
            ...(step.purpose !== undefined ? { purpose: step.purpose } : {}),
          })),
          /*
           * ⚠️ **参数绑定摘要**（2026-10-21 新增 · 计划 P2 第 3 步）：
           *    预测端口分不清"这次读的是哪个文件"⇒ 它的预期会套到别的对象上（错绑）。
           *    ⇒ 这里给**摘要**（哈希，不是参数）⇒ 端口能对齐对象，又拿不到参数原文。
           */
          targetBindings: plan.steps.map((step) => {
            const reference = taskStepReferenceOf(step.args)
            return {
              capability: step.capability,
              operation: step.operation,
              bindingDigest: reference === undefined
                ? parameterBindingDigestOf(step.capability, step.operation, '')
                : parameterBindingDigestOf(step.capability, step.operation, reference),
            }
          }),
          state: stateLines,
          remainingActions: remainingActionsNow,
          remainingModelCalls: Math.max(
            0,
            authorization.budget.maxPlans - authorization.plansUsed
          ),
          ...(readback.length > 0 ? { readback } : {}),
          producedAt,
          inputRevision,
          deadlineMs,
        })
        if (outcome.ok) {
          forecast = outcome.forecast
        } else {
          forecastFailureCode = outcome.parseFailureCode ?? outcome.failure
        }
      }
    }

    // 任务编排：本批执行失败后不能沿用尚未观察结果的后续步骤，即使模型自报 done。
    let batchFailed = false
    for (const [planStepIndex, step] of plan.steps.entries()) {
      if (stopIfClosed()) break
      if (now() >= authorization.expiresAt) {
        options.authorizations.close(authorization.taskId, 'deadline')
        stopped = 'deadline'
        break
      }
      if (!options.authorizations.consumeAction(authorization.taskId)) {
        options.authorizations.close(authorization.taskId, 'budget_actions')
        stopped = 'budget_actions'
        break
      }

      const definition = options.registry.get(step.capability)
      const operation = options.registry.getOperation(step.capability, step.operation)
      if (definition === undefined || operation === undefined) {
        // 校验阶段已经挡过一次；这里是第二道（"计划"可能被直接构造出来）
        steps.push({
          capability: step.capability,
          operation: step.operation,
          droppedReason: 'unregistered',
        })
        failureSummary.push(`${step.capability}.${step.operation}=unregistered`)
        batchFailed = true
        break
      }

      /*
       * ------------------------------------------------------------------
       * **有界观察范围闸**（ADR-151 R1 §3）
       * ------------------------------------------------------------------
       * 本次授权带了局部范围（只有"新的两行入口"才有）⇒ **每一步**都必须落在里面：
       * ```text
       * 写/读回   ⇒ 只许目标路径
       * 条件读    ⇒ 只许那个受信标记、只许 read、**只许一次**（计数在**执行前**就 +1）
       * 其它路径  ⇒ 越界 ⇒ 这一步不执行
       * ```
       * ⚠️ 这道闸在**任务环**里（不在规划器闭包里）⇒ 模型换路径、重复读都绕不过去。
       * ⚠️ 缺省没有范围 ⇒ 整段不跑（旧行为逐字不变）。
       */
      const bounded = authorization.boundedObservation
      if (bounded !== undefined) {
        const path = typeof step.args.path === 'string' ? step.args.path : undefined
        const isTarget = path !== undefined && path === bounded.targetPath
        const isConditionRead = path !== undefined && path === bounded.conditionPath
          && step.capability === 'sandbox.file.read' && step.operation === 'read'
        if (!isTarget && !isConditionRead) {
          steps.push({ capability: step.capability, operation: step.operation, droppedReason: 'observation_out_of_scope' })
          failureSummary.push(`${step.capability}.${step.operation}=observation_out_of_scope`)
          batchFailed = true
          break
        }
        // ⚠️ 条件读：计数必须在**执行前**完成（⇒ 重入/重试都不会读第二次）。
        if (isConditionRead && !options.authorizations.noteConditionRead(authorization.taskId)) {
          steps.push({ capability: step.capability, operation: step.operation, droppedReason: 'observation_limit' })
          failureSummary.push(`${step.capability}.${step.operation}=observation_limit`)
          batchFailed = true
          break
        }
      }

      /*
       * ------------------------------------------------------------------
       * **F2 逐路径授权闸**（最小接点 R4）
       * ------------------------------------------------------------------
       * 本任务带 F2 范围（只有**新 F2 入口**才有）⇒ **每一步**都必须落在里面：
       * ```text
       * 读   ⇒ 只读路径（缓存源 / 权威源）｜限次读（族级标记，**执行前**计数，超限即拒）｜可写路径（读回）
       * 写   ⇒ 只许可写路径（目标）
       * 其它 ⇒ 越界 ⇒ 这一步不执行
       * ```
       * ⚠️ 闸在**任务环**（不在规划器闭包）⇒ 换路径、写源文件、写标记、重复读标记都绕不过去。
       * ⚠️ 计数在**执行前** +1 且挂在任务对象上 ⇒ 重规划/重挂**不会重置**。
       * ⚠️ 缺省没有范围 ⇒ 整段不跑（旧入口行为逐字不变）。
       */
      const sourceScoped = authorization.sourceScopedPaths
      if (sourceScoped !== undefined) {
        const scopedPath = typeof step.args.path === 'string' ? step.args.path : undefined
        const isRead = step.capability === 'sandbox.file.read' && step.operation === 'read'
        const isWrite = step.capability === 'sandbox.file.write' && step.operation === 'write'
        const inReadOnly = scopedPath !== undefined && sourceScoped.readOnly.includes(scopedPath)
        const inLimited = scopedPath !== undefined && sourceScoped.limitedReads.some(item => item.path === scopedPath)
        const inWritable = scopedPath !== undefined && sourceScoped.writable.includes(scopedPath)
        const allowed = isWrite
          ? inWritable
          : isRead
            ? (inReadOnly || inWritable || inLimited)
            : false
        if (!allowed) {
          steps.push({ capability: step.capability, operation: step.operation, droppedReason: 'source_scope_denied' })
          failureSummary.push(`${step.capability}.${step.operation}=source_scope_denied`)
          batchFailed = true
          break
        }
        // ⚠️ 限次读：**执行前**计数（重入/重试都不会多读一次）。
        if (isRead && inLimited && !inReadOnly && !inWritable) {
          if (!options.authorizations.noteSourceScopedRead(authorization.taskId, scopedPath!)) {
            steps.push({ capability: step.capability, operation: step.operation, droppedReason: 'source_scope_read_limit' })
            failureSummary.push(`${step.capability}.${step.operation}=source_scope_read_limit`)
            batchFailed = true
            break
          }
        }
      }
      /*
       * ------------------------------------------------------------------
       * **P3-5b · G5：任务局部读根闸**（可选；缺省 `authorization.readRoots === undefined`
       * ⇒ 整段不跑，旧入口与普通文件任务行为逐字不变）
       * ------------------------------------------------------------------
       * ```text
       * 只有**受管 personal-library 真的参与过这个任务**之后，装配层才会把它挂上；
       * 挂上之后：读类动作（local.file.read / sandbox.file.read / document.read）
       * 的路径参数落在读根之外 ⇒ **这一步不执行**（不是在执行后标记，而是执行前拒绝）。
       * ```
       * ⚠️ 闸在任务环 ⇒ 换路径、换规划、换计划都绕不过去；模型看不到第二个权威。
       */
      const taskReadRoots = authorization.readRoots
      if (taskReadRoots !== undefined) {
        const targetPath = typeof step.args.path === 'string' ? step.args.path : undefined
        const readCapabilities = new Set(['local.file.read', 'sandbox.file.read', 'document.read'])
        if (readCapabilities.has(step.capability) && targetPath !== undefined &&
          !pathWithinReadRoots(targetPath, taskReadRoots.roots)) {
          steps.push({ capability: step.capability, operation: step.operation, droppedReason: 'read_outside_task_roots' })
          failureSummary.push(`${step.capability}.${step.operation}=read_outside_task_roots`)
          batchFailed = true
          break
        }
      }
      /*
       * ------------------------------------------------------------------
       * **P3-4 技能规则依赖闸**（可选；缺省不挂 ⇒ 旧入口行为逐字不变）
       * ------------------------------------------------------------------
       * 本轮已加载的技能声明了规则依赖 ⇒ 它后续的**每一步**执行前都复核
       * "这些规则**现在**还合格吗"。规则在加载之后、动作之前失效
       * （被撤回 / 挂起 / 换了版本）⇒ 这一步**不执行**（具名拒用），计划停下。
       *
       * ⚠️ 与上面的 `simulation` / `forecast` 两处**不重叠**：那两处判的是"模型预测的依赖"，
       *    这里判的是"**技能声明的**依赖"。三类来源各有各的具名拒绝原因。
       */
      if (options.skillRuleDependencies !== undefined && options.skillRuleDependencies.length > 0) {
        /*
         * ⚠️ 声明了依赖却**没有读面** ⇒ 失败关闭（与下面 `simulation_rule_unusable` 闸同口径）。
         *    装配漏传 `ruleSnapshot` 不能让"依赖不合格就停"这条安全属性**无声消失**。
         */
        const verdict = options.ruleSnapshot === undefined
          ? undefined
          : await verifyPlanRulesStillUsable({
              dependencies: options.skillRuleDependencies,
              snapshot: options.ruleSnapshot,
            }).catch(() => undefined)
        if (verdict === undefined || !verdict.ok) {
          steps.push({ capability: step.capability, operation: step.operation, droppedReason: 'skill_rule_unusable' })
          failureSummary.push(`${step.capability}.${step.operation}=skill_rule_unusable`)
          batchFailed = true
          break
        }
      }


      // Selection depends on this rule even for a write without its own readback forecast.
      if (planned.simulation !== undefined && options.ruleSnapshot !== undefined) {
        const verdict = await verifyPlanRulesStillUsable({ snapshot: options.ruleSnapshot,
          dependencies: [planned.simulation.dependency],
        }).catch(() => ({ ok: false }))
        if (!verdict.ok) {
          steps.push({ capability: step.capability, operation: step.operation, droppedReason: 'simulation_rule_unusable' })
          failureSummary.push(`${step.capability}.${step.operation}=simulation_rule_unusable`)
          batchFailed = true
          break
        }
      }

      /*
       * ------------------------------------------------------------------
       * **依赖闸**（三域应用方案 §2："在执行前检查依赖关系"）
       * ------------------------------------------------------------------
       * 预测声明了这一步依赖哪几步；那些步的**核对结论是 `mismatch`**
       * ⇒ 这一步**不执行**（它会沿用一个被反驳的结果）。
       *
       * ⚠️ 判据是"**被反驳**"，不是"**没核对过**"：
       *    `unknown`（没观测到）**不**挡路 —— 把"没观测到"当成"失败"，
       *    会让一条本来正常的链路凭空断掉（§5：未观测 / 超时 / 部分成功各自保留）。
       */
      const forecastStep = forecast?.steps.find((candidate, index) =>
        (forecast.planStepIndices?.[index] ?? index) === planStepIndex &&
        candidate.capability === step.capability && candidate.operation === step.operation
      )
      if (
        forecastStep !== undefined &&
        !forecastDependenciesSatisfied(forecastStep, refutedSteps)
      ) {
        steps.push({
          capability: step.capability,
          operation: step.operation,
          droppedReason: 'forecast_dependency_unverified',
        })
        failureSummary.push(`${step.capability}.${step.operation}=forecast_dependency_unverified`)
        batchFailed = true
        break
      }

      /*
       * ------------------------------------------------------------------
       * **规则资格闸**（计划 P2 第 5 步）
       * ------------------------------------------------------------------
       * 这一步的预测**依赖**哪几条规则（`ruleDependencies`）⇒
       * 那些规则**现在**还合格吗？
       *
       * ⚠️ 为什么要在**每一步**前查（而不是只在计划开始时查一次）：
       *    规则可能在**计划执行途中**失去资格（被真实反例挂起 / 被撤回 / 换了版本）。
       *    那时还照着原计划往下走 = 沿用一个**已经失效**的判断。
       *
       * ⚠️ 判据是"**依赖的规则不可用**"，不是"**没查到**"：
       *    查不到（没有快照）也按不可用处理（失败关闭）。
       */
      if (
        options.ruleSnapshot !== undefined &&
        forecastStep?.ruleDependencies !== undefined &&
        forecastStep.ruleDependencies.length > 0
      ) {
        const verdict = await verifyPlanRulesStillUsable({
          dependencies: forecastStep.ruleDependencies,
          snapshot: options.ruleSnapshot,
        })
        if (!verdict.ok) {
          steps.push({
            capability: step.capability,
            operation: step.operation,
            droppedReason: 'forecast_rule_unusable',
          })
          failureSummary.push(`${step.capability}.${step.operation}=forecast_rule_unusable`)
          batchFailed = true
          break
        }
      }

      const args = stagePayloadArgs(step, options.staging)
      if (args.problem !== undefined) {
        steps.push({
          capability: step.capability,
          operation: step.operation,
          droppedReason: args.problem,
        })
        failureSummary.push(`${step.capability}.${step.operation}=${args.problem}`)
        batchFailed = true
        break
      }

      const request = createActionRequest({
        actionId: newId(),
        traceId: input.traceId,
        capability: step.capability,
        operation: step.operation,
        requestedBy: { kind: 'user' },
        arguments: args.args,
        sideEffect: operation.sideEffect,
      })

      if (options.epistemic) {
        try {
          const observed = await options.epistemic.before({ request, authorization, characterId: input.characterId })
          if (observed?.predictionChanged) epistemicPredictions++
        } catch { epistemicFailures++ }
        if (now() >= authorization.expiresAt) {
          options.authorizations.close(authorization.taskId, 'deadline'); stopped = 'deadline'; break
        }
      }
      // Async source checks and observer hooks may also outlive cancellation or supersession.
      if (stopIfClosed()) break
      let result: ActionResult
      try {
        result = await options.gateway.execute(
          input.characterId,
          request,
          options.invocationFor({ authorization, step })
        )
      } catch (error) {
        /*
         * 异常**不吞成"没有这一步"**：它是一条明确的失败事实
         * （与 `turn-gateway` 的动作分发同一条纪律）。
         */
        steps.push({
          capability: step.capability,
          operation: step.operation,
          actionId: String(request.actionId),
          status: 'failed',
          failureCode: 'execution_failed',
        })
        failureSummary.push(`${step.capability}.${step.operation}=execution_failed`)
        void error
        batchFailed = true
        break
      }

      /*
       * ⚠️ **先算核对结论，再叫观察方**（2026-10-21 · 计划 P2 第 4 步）：
       *    观察方要把「比的是**哪一版模型 / 哪条规则 / 哪个对象**」一起落进账本
       *    ⇒ 核对结论必须在**观察方被叫之前**就算好。
       *    ⚠️ 判定本身**不变**：它只用真实结果（`result`），与算在哪儿无关。
       */
      const stepComparison = forecastStep === undefined
        ? undefined
        : compareForecastStep(forecastStep, result, {
          actualSourceRef: String(request.actionId),
          ...(forecastStep.ruleVersion === undefined ? {} : { ruleVersion: forecastStep.ruleVersion }),
        })
      /*
       * 模型绑定：**模型版本**与**规则版本**都在才给（缺一个就不给 ⇒ 不编版本）。
       * ⇒ 观察方拿到的就是"这次结算比的是哪一版"。
       */
      const comparisonBinding = stepComparison === undefined ||
        forecast?.modelVersion === undefined || forecastStep?.ruleVersion === undefined
        ? undefined
        : {
          verdict: stepComparison.verdict,
          modelVersion: forecast.modelVersion,
          ruleVersion: forecastStep.ruleVersion,
          ...(forecastStep.parameterBindingDigest === undefined ? {} : { parameterBindingDigest: forecastStep.parameterBindingDigest }),
          ...(stepComparison.actualSourceRef === '' ? {} : { predictionRef: stepComparison.actualSourceRef }),
        }

      if (options.epistemic) {
        try {
          await options.epistemic.after({
            request, result, authorization, characterId: input.characterId,
            ...(comparisonBinding === undefined ? {} : { comparison: comparisonBinding }),
          })
        }
        catch { epistemicFailures++ }
      }
      const reason = closedSetReason(result)
      steps.push({
        capability: step.capability,
        operation: step.operation,
        actionId: String(request.actionId),
        status: result.status,
        ...(result.error !== undefined ? { failureCode: result.error.code } : {}),
        ...(reason !== undefined ? { failureReason: reason } : {}),
      })
      /*
       * 回给规划器的摘要**带上引用**（路径 / URL / 查询词）。
       *
       * ⚠️ 这是修复的关键一半：没有引用，模型无法判断"这一步我是不是已经做过"，
       *    于是同一个目录会被列 6 次（2026-10-05 实测）。
       * ⚠️ 带的是**引用**，不是正文：`content` / `spec` 在这一层已经变成了暂存引用
       *    （见 `stagePayloadArgs`），所以这里不可能把用户要写的正文带回 prompt。
       */
      const stepReference = taskStepReferenceOf(args.args)
      executedSummary.push(
        `${step.capability}.${step.operation}` +
          `${stepReference !== undefined ? ` ${stepReference}` : ''}=${result.status}`
      )
      if (result.status === 'success') {
        if (hasSideEffect(operation.sideEffect)) {
          /*
           * ③ **世界被改过了** ⇒ 同一条引用上的"已经成功过"作废。
           *    否则"写完之后再读回来核对"会被进度闸误判成打转，而那一读是有意义的。
           */
          if (stepReference !== undefined) {
            for (const key of [...succeededReferenceSteps]) {
              if (key.endsWith(` ${stepReference}`)) succeededReferenceSteps.delete(key)
            }
          }
        } else if (stepReference !== undefined && taskStepReferenceIsExclusive(args.args)) {
          succeededReferenceSteps.add(`${step.capability}.${step.operation} ${stepReference}`)
        }
      }
      if (result.error !== undefined) {
        failureSummary.push(`${step.capability}.${step.operation}=${result.error.code}`)
      }
      /*
       * WP2：把这一步**真的读到的内容**收起来（只在装了 `replanContext` 时才被消费）。
       * ⚠️ 收集 **≠** 注入：额度为 0 时下一次规划一份都带不上（那是一个真实配置）。
       * ⚠️ 同源 + 同指纹的重复只留一份（`turnContentIdentityOf`），否则"同一个目录列了
       *    两次"会把下一次规划的额度吃光 —— 那正是要修的病（重复列举）的另一种形态。
       */
      if (options.replanContext !== undefined && result.turnContent !== undefined) {
        for (const item of result.turnContent) {
          const identity = turnContentIdentityOf(item)
          if (gatheredContent.some((existing) => turnContentIdentityOf(existing) === identity)) continue
          gatheredContent.push(item)
          if (gatheredContent.length > MAX_GATHERED_CONTENT_ITEMS) gatheredContent.shift()
        }
      }
      /* WP3：外部证据同理（按 id 去重，保留最新的若干条） */
      if (options.replanContext !== undefined && result.externalEvidence !== undefined) {
        for (const item of result.externalEvidence) {
          if (gatheredEvidence.some((existing) => String(existing.id) === String(item.id))) continue
          gatheredEvidence.push(item)
          if (gatheredEvidence.length > MAX_GATHERED_EVIDENCE_ITEMS) gatheredEvidence.shift()
        }
      }
      results.push({ request, result, rule: 'task_plan_step' })
      /*
       * ------------------------------------------------------------------
       * **P3-5b · G5：受管技能参与 ⇒ 把读根挂到本次任务授权上**
       * ------------------------------------------------------------------
       * 条件全部为真才挂：装配层给了 `readRootScope`、这一步**真的成功加载**了那个技能、
       * 且这一次加载的**回执**指向受管发布引用（`workflow-skill:<id>@<v>#<指纹>`）。
       * 挂载是**任务局部**的：之后的读动作才受约束，之前已完成的动作不受追溯影响；
       * 缺省不给 `readRootScope` ⇒ 整段不跑（旧路径逐字不变）。
       */
      if (options.readRootScope !== undefined &&
        request.capability === 'workflow.skill' && request.operation === 'load' &&
        result.status === 'success' && request.arguments.skill === options.readRootScope.skillId) {
        const managedRef = (result.evidence ?? []).some((evidence) =>
          typeof evidence.ref === 'string' && evidence.ref.startsWith(`workflow-skill:${options.readRootScope!.skillId}@`))
        if (managedRef) {
          applyReadRoots(authorization, {
            roots: options.readRootScope.roots,
            source: options.readRootScope.source,
          })
        }
      }
      /*

       * F2 准备读：把**这一次真实成功的读**记成受信回执（路径 + 内容指纹）。
       * ⚠️ 写动作**不**产生回执；失败的读**不**产生回执；指纹来自 Gateway 产出的效果。
       */
      if (result.status === 'success' && result.effect?.kind === 'content_read' &&
        typeof result.effect.fingerprint === 'string' && result.effect.fingerprint !== '') {
        const readPath = request.arguments.path
        if (typeof readPath === 'string' &&
          !trustedReads.some(item => item.path === readPath && item.fingerprint === result.effect?.fingerprint)) {
          trustedReads.push({ path: readPath, fingerprint: result.effect.fingerprint })
        }
      }
      /*
       * ------------------------------------------------------------------
       * **执行后核对**（三域应用方案 §2："执行后只用真实结果更新判断"）
       * ------------------------------------------------------------------
       * 判定**完全由程序**做：闭集核对条件 vs. `ActionResult`。
       * 模型自报的不确定性**不参与**判定（它不是校准过的概率）。
       *
       * ⚠️ `mismatch` ⇒ 这一步的核对**没通过** ⇒
       *    ① 它进 `refutedSteps`（依赖它的后续步骤**不执行**）；
       *    ② 本批**就此打住**（重新规划）—— 因为"世界不是预测的那样"时，
       *       继续照着同一份计划往下走 = 沿用一个已经被证伪的判断。
       * ⚠️ `unknown`（没观测到 / 不可判定）**不**算失败：照常继续，如实记读数。
       */
      if (forecastStep !== undefined) {
        const refutationKey = fnv1a64Hex(JSON.stringify([
          step.capability, step.operation, step.args, forecastStep.check,
        ]))
        const comparison = stepComparison!
        comparisons.push({
          planStepIndex,
          capability: step.capability,
          operation: step.operation,
          comparable: comparison.comparable,
          verdict: comparison.verdict,
          actualSourceRef: comparison.actualSourceRef,
          ...(forecast === undefined || forecast.modelVersion === undefined ? {} : { modelVersion: forecast.modelVersion }),
          ...(comparison.refutedRuleVersion === undefined ? {} : { refutedRuleVersion: comparison.refutedRuleVersion }),
          ...(forecastStep.ruleDependencies === undefined ? {} : { ruleDependencies: forecastStep.ruleDependencies }),
        })
        if (comparison.verdict === 'mismatch') {
          refutedSteps.add(planStepIndex)
          refutedKeys.add(refutationKey)
          failureSummary.push(`${step.capability}.${step.operation}=forecast_check_refuted`)
          batchFailed = true
          break
        }
        if (comparison.verdict === 'match') {
          // 同一件事**再**次核对通过 ⇒ 撤掉它先前的"被反驳"（不推翻历史读数，只改当前判断）
          refutedKeys.delete(refutationKey)
        }
      }
      if (result.status !== 'success') {
        batchFailed = true
        break
      }
    }

    if (stopIfClosed()) break
    if (stopped !== 'done') break
    if (plan.done && !batchFailed) {
      if (!goalAccepted()) {
        options.authorizations.close(authorization.taskId, 'plan_failed'); stopped='plan_failed'; planRejectedCode='task_goal_unmet'; break
      }
      /*
       * ⚠️ **完成声明闸**（三域应用方案 §2 的"误报完成数"）。
       *
       * ```text
       * 规划器说"做完了" ∧ 程序知道有核对**被反驳** ⇒ **不能**报完成。
       * ```
       * 否则就会出现这条假完成链：
       * ```text
       * 第一次核对被反驳 → 重新规划 → 预算用完 → 没有第二次核对
       *   → "写成功"（适配器自报）被当成"写成了" → 任务报 done
       * ```
       * ⇒ 停止原因**另立** `check_refuted`，与 `done` 分开（如实说"没做完"）。
       * ⚠️ 被反驳的键**在再次核对通过时**才清除（见 `refutedKeys`）。
       */
      if (refutedKeys.size > 0 && !goal?.achieved) {
        options.authorizations.close(authorization.taskId, 'check_refuted')
        planRejectedCode = 'task_check_refuted'
        stopped = 'check_refuted'
        break
      }
      options.authorizations.close(authorization.taskId, 'done')
      stopped = 'done'
      break
    }
  }

  return {
    taskId: authorization.taskId,
    ...(options.completion ? {goal:goal??{achieved:false,contentIds:[]}} : {}),
    steps,
    results,
    plansUsed: authorization.plansUsed,
    actionsUsed: authorization.actionsUsed,
    stopped,
    ...(plannerFailureCode !== undefined ? { plannerFailureCode } : {}),
    ...(planRejectedCode !== undefined ? { planRejectedCode } : {}),
    /*
     * ⚠️ 预测相关的键**只在预测层配过时**出现 ⇒ 旧档下这个返回值**逐字段不变**
     *    （"关闭时输入、执行顺序与预算逐字段保持原行为"是可被断言的）。
     */
    ...(options.forecast !== undefined ? { forecastCallsUsed: forecastCalls } : {}),
    ...(forecastFailureCode !== undefined ? { forecastFailureCode } : {}),
    ...(options.forecast !== undefined || simulationsUsed > 0 ? { comparisons } : {}),
    ...(simulationsUsed > 0 ? { simulationsUsed } : {}),
    ...(options.epistemic ? { epistemicPredictions, epistemicFailures } : {}),
  }
}

/**
 * 把计划里的**载荷字段**改写成私有暂存引用。
 *
 * 返回的 `args` 是**唯一**会进 `ActionRequest.arguments` 的形状 ——
 * 它里面不可能有 `content` / `spec`（那两个键在这里被消费掉了）。
 */
export function stagePayloadArgs(
  step: TaskPlanStep,
  staging: PayloadStagingPort
): { args: Record<string, unknown>; problem?: string } {
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(step.args)) {
    if (!TASK_STAGED_ARG_KEYS.includes(key)) {
      args[key] = value
      continue
    }
    if (key === 'content') {
      if (typeof value !== 'string') return { args: {}, problem: 'content_not_string' }
      const bytes = utf8Bytes(value)
      if (bytes > 10 * 1024 * 1024) return { args: {}, problem: 'content_too_large' }
      const staged = staging.put({
        value: { kind: 'text', text: value },
        label: 'task:step:content',
        fingerprint: sha256Like(value),
        bytes,
      })
      args.payloadRef = staged.payloadRef
      args.payloadBytes = staged.bytes
      args.payloadFingerprint = staged.fingerprint
      continue
    }
    // key === 'spec'
    const json = JSON.stringify(value)
    if (json === undefined) return { args: {}, problem: 'spec_not_serializable' }
    const bytes = utf8Bytes(json)
    if (bytes > 10 * 1024 * 1024) return { args: {}, problem: 'spec_too_large' }
    const staged = staging.put({
      value: { kind: 'json', json },
      label: 'task:step:spec',
      fingerprint: sha256Like(json),
      bytes,
    })
    args.specRef = staged.payloadRef
    args.specBytes = staged.bytes
    args.specFingerprint = staged.fingerprint
  }
  return { args }
}

function utf8Bytes(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * 载荷指纹（kernel 侧没有 crypto）。
 *
 * ⚠️ 它是 `fnv1a64`，**不是**密码学摘要 —— 对"这次要写的字节与写下去的是不是同一份"
 *    这个问题它够用（内核去重与幂等键一直用的就是它）。
 *    适配器在真正写盘时会**再算一次 sha256** 作为落盘指纹，
 *    因此 `payloadFingerprint` 与 `effect.fingerprint` 是**两个不同的算法**，
 *    这一点必须在报告里说清（两者不可直接比较）。
 */
function sha256Like(text: string): string {
  return fnv1a64Hex(text)
}

/**
 * 一行摘要（**只含闭集与计数**）。
 *
 * ⚠️ 逐步骤的 `能力.操作=状态[/失败码]` 也打出来（2026-10-04 加）：真模型跑办公任务时
 *    结果是"8 步都 executed、没有产物"，而**日志里看不到任何失败码** ⇒
 *    只能靠猜。闭集码不是正文，打成一行不越隐私边界，却让"为什么没成"变成可读的。
 */
export function describeTaskRun(outcome: TaskRunOutcome): string {
  const steps = outcome.steps
    .map(
      (step) =>
        `${step.capability}.${step.operation}=${step.status ?? step.droppedReason ?? 'dropped'}` +
        `${step.failureCode !== undefined ? `/${step.failureCode}` : ''}` +
        `${step.failureReason !== undefined ? `:${step.failureReason}` : ''}`
    )
    .join(' ')
  return (
    `task=${outcome.taskId} 步骤=${String(outcome.steps.length)} ` +
    `已执行=${String(outcome.results.length)} 规划=${String(outcome.plansUsed)} ` +
    `行动=${String(outcome.actionsUsed)} 停止=${outcome.stopped}` +
    `${outcome.plannerFailureCode !== undefined ? ` 规划失败=${outcome.plannerFailureCode}` : ''}` +
    `${outcome.planRejectedCode !== undefined ? ` 计划被拒=${outcome.planRejectedCode}` : ''}` +
    `${outcome.epistemicPredictions !== undefined ? ` 信念预测=${outcome.epistemicPredictions} 信念失败=${outcome.epistemicFailures ?? 0}` : ''}` +
    // ⚠️ 预测那一栏**只在预测层开过时**出现（旧档逐字不变）。
    `${outcome.forecastCallsUsed !== undefined && outcome.forecastCallsUsed > 0
      ? ` 预测=${String(outcome.forecastCallsUsed)}`
      : ''}` +
    `${outcome.forecastFailureCode !== undefined ? ` 预测失败=${outcome.forecastFailureCode}` : ''}` +
    `${outcome.comparisons !== undefined && outcome.comparisons.length > 0
      ? ` 核对=${outcome.comparisons
          .map((row) => `${row.capability}.${row.operation}:${row.verdict}`)
          .join(' ')}`
      : ''}` +
    `${steps === '' ? '' : ` · ${steps}`}`
  )
}

export type { Timestamp }
