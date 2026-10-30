/**
 * ActionTurnPort —— 轮次级的动作入口（M4.5 §36）。
 *
 * ============================================================================
 *  它是 `explicit-turn.ts` 的同构物，而不是另起一套
 * ============================================================================
 * M4 的显式记忆路径有一个"轮次级端口"：
 *
 * ```text
 * 文本 → 意图判定 → 内容抽取 → 目标解析 → 服务 → 事件 → 投影
 * ```
 *
 * M4.5 的动作路径形状完全一样：
 *
 * ```text
 * 文本 → 意图判定 → ActionRequest → Gateway（目标/策略/执行/账本）→ ActionResult
 * ```
 *
 * 两条链共享唯一的精神：**前置、同步、结果可观察**。区别只在
 * 前者改"她知道什么"，后者改**外部世界**。
 *
 * ⚠️ 端口不做 IO、不读盘、不判权限 —— 它只负责把一句话变成一次请求，
 *    然后让 Gateway 决定这件事能不能发生。
 */

import type { CharacterId, TraceId } from '../contracts/ids.ts'
import { newActionId } from '../contracts/ids.ts'
import type { ActionRequest, RiskLevel } from './action-request.ts'
import { createActionRequest } from './action-request.ts'
import type { ActionResult } from './action-result.ts'
import type { CapabilityRegistry, OperationDefinition } from './capability-registry.ts'
import type { ActionGateway, ActionInvocationContext, TargetResolution } from './gateway.ts'
import type { ActionIntent, ActionIntentDetector } from './intent-detector.ts'
import { applyBoundedObservation, applySourceScopedPaths, type TaskAuthorizationPort } from './task-authorization.ts'
import type { TaskPlan, TaskPlannerPort } from './task-plan.ts'
import type { ActionForecastPort } from './action-forecast.ts'
import type { PayloadStagingPort } from './payload-staging.ts'
import { runTask, type TaskRunOutcome } from './task-loop.ts'
import { looksLikeTask } from './task-intent.ts'
import {
  actionOfToolDecision,
  readToolDecision,
  validateToolDecisionProposal,
  type ToolDecisionPort,
} from './tool-decision.ts'
import {
  attestActionInitiatorFromCausalOrigin,
  attestActionInitiatorUnresolved,
  correlationSourceFromConversationEvent,
  type TriggeringConversationEvent,
} from '../contracts/attribution.ts'

export interface ActionTurnInput {
  semanticDecision?: unknown
  characterId: CharacterId
  /** 本轮 traceId（§20：动作必须挂在同一轮 trace 上） */
  traceId: TraceId
  /** 用户原话 */
  text: string
  /** 触发这一轮的用户事件（证据） */
  eventId: string
  /**
   * 第二批：**会话键**（把任务授权绑定到当前会话）。
   *
   * 缺省 ⇒ **不可能**有任何任务行为（`findOpen` / `issue` 都不发生）
   * ⇒ 既有调用点与全部旧断言逐字段不变。
   */
  conversationKey?: string
  /**
   * 触发这一轮的**呈现角色**。
   *
   * ⚠️ K-27 / WP5.1：它只支持 **legacy 行为 / 呈现 / 兼容 / 路由**
   *    （例如 payload 的 `requestedBy`）。
   *    它**不再**、也**不允许**用来构造权威 `initiator` ——
   *    "以谁的身份进来"不是"谁真的造成了这次动作"。
   */
  speaker: { kind: 'user' | 'character' | 'system' | 'tool'; id?: string }
  /**
   * K-27：触发这次动作的那条 conversation event 的**权威归因**（关联边界）。
   *
   * 由**受信读者**（turn-gateway 从账本读回的那一行）用
   * `triggeringConversationEventOf()` 产出。缺省 ⇒ initiator 如实记
   * `Unknown(RUNTIME_UNRESOLVED)`（**不**退回呈现角色）。
   */
  triggeringEvent?: TriggeringConversationEvent
  /**
   * WP1 / ADR-104 D08：**有界的最近对话行**（已过撤销遮蔽）。
   *
   * 决策阶段拿不到完整的 `ContextPacket`（那份在动作之后才编译），
   * 因此这里给它"角色上下文"里最必要的那一部分。缺省 ⇒ 空数组
   * （于是只配 `toolDecision` 而不传它时，决策只看得到本轮原话与工具目录）。
   */
  recentLines?: readonly string[]
}

export type ActionTurnKind = 'executed' | 'rejected' | 'not_applicable'

/**
 * M5.5.1：**异步意图解析**的返回（ADR-049 `R2` §11.2 的②③④步）。
 *
 * 它必须能表达"**这一轮不产生请求**"，而且能带一份**安全诊断**：
 * 因为"判定说 answer ⇒ 不搜"与"没有意图 ⇒ 不搜"对用户是同一件事，
 * 对排查却是完全不同的两件事，混在一起就永远查不出"为什么没搜"。
 */
export interface ResolvedActionIntent {
  /** 最终意图；`undefined` ⇒ 本轮不产生请求 */
  intent?: ActionIntent
  /** 安全诊断：**只允许**闭集码 / 枚举 / 计数（不含用户原文、不含模型输出） */
  diagnostics?: Record<string, string | number | boolean>
}

export interface ActionTurnResult {
  kind: ActionTurnKind
  /** Ephemeral reply context; never copy question text into diagnostics or ledger. */
  clarificationQuestion?: string
  request?: ActionRequest
  result?: ActionResult
  /** 意图命中的规则名（诊断用；没有请求时为 undefined） */
  rule?: string
  /** M5.5.1：解析器的安全诊断（不配 `resolveIntent` 时恒为 undefined） */
  diagnostics?: Record<string, string | number | boolean>
  /**
   * 第二批：**同一个任务里的后续步骤**。
   *
   * ⚠️ 它们**不是新轮次**：`traceId` / 归因 / 账本全部与 `result` 同源，
   *    只是同一个用户任务下的第 2…n 个动作（计划书 §2.2："不能靠后台循环
   *    伪造新轮次规避旧搜索额度"）。
   *    `turn-gateway` 已经把 `actionResults` 当数组收集，因此这里只需追加。
   */
  followUps?: readonly ActionTurnResult[]
  /** 任务执行的**闭集**读数（诊断用；不在任务路径上时 undefined） */
  task?: {
    taskId: string
    steps: number
    actionsUsed: number
    plansUsed: number
    stopped: string
    goal?: NonNullable<TaskRunOutcome['goal']> & { delivered?: boolean }
  }
}

export interface ActionTurnPort {
  handleTurn(input: ActionTurnInput): Promise<ActionTurnResult>
  semanticContext?: (conversationKey?: string) => import('../app/semantic-entry.ts').SemanticToolContext
}

export interface ActionTurnPortOptions {
  gateway: ActionGateway
  detector: ActionIntentDetector
  registry: CapabilityRegistry
  /** 观察钩子（trace）；不允许影响执行结果 */
  onRequest?: (request: ActionRequest) => void
  /**
   * WP5 / K-27：**受信 ingress 的自我标识**。
   *
   * 配置了它 ⇒ 本端口为每次 `handleTurn()` 产出 `initiator` 的受信证据
   * （**只能**由因果上下文或"如实未定"建立，见 `ActionTurnInput.triggeringEvent`），
   * 并把它作为 invocation 上下文交给 Gateway。
   *
   * **不配** ⇒ 不产出任何归因（legacy 路径逐字段不变）。
   */
  attribution?: { adapterId: string }
  /**
   * M5.5.1（ADR-049 `R2` §11.2）：**可选的异步意图解析器**。
   *
   * 它存在的理由是接口现实：`ActionIntentDetector.detect()` 是**同步**的，
   * 而新增路径必须问一次模型（异步）。把这个钩子放在**端口层**而不是把
   * `detect()` 改成异步，是为了让 M4.5 的那 135 条断言与所有既有装配
   * **一个字节都不用动**（不配 = 逐字段旧行为）。
   *
   * ⚠️ 契约：它拿到的是词形检测器的**基线意图**（可能 `undefined`），
   *    返回的是"最终要执行的那个意图"（可能被改写，也可能被**否决**）。
   *    **否决必须表现为 `intent: undefined`** —— 不允许"解析器说不行但基线照走"。
   */
  resolveIntent?: (input: {
    text: string
    baseline?: ActionIntent
  }) => Promise<ResolvedActionIntent>
  /**
   * 第二批：**有限任务执行环**（不配 = 逐字段旧行为）。
   *
   * 配了之后，`handleTurn()` 会先问一句"这一轮要不要走任务"：
   * ```text
   * ① 当前会话有一份**仍然有效**的任务授权 ⇒ 继续它（"原任务绑定"）
   * ② 没有，但这句话像任务形（`looksLikeTask`）且至少有一个能力被启用
   *    ⇒ 签发一份新授权并开始
   * ③ 都不是 ⇒ 走旧的单动作路径（**逐字段不变**）
   * ```
   * ⚠️ 任务真的产生了结果时，**不再**走单动作路径：一个用户任务只应有一份动作集合。
   *    任务一步都没做成（规划失败等）时**仍然**走旧路径 —— 于是"帮我算一下 0.1+0.2"
   *    这种被误判成任务的话照样能得到正确结果。
   */
  task?: {
    authorizations: TaskAuthorizationPort
    epistemic?: import('./task-loop.ts').EblTaskObserver
    planner: TaskPlannerPort
    /** Trusted scoped assembly; absent preserves the seeded planner and legacy forecast. */
    configurePlanning?: (text: string, fallbackPlanner?: TaskPlannerPort) => Promise<{
      planner: TaskPlannerPort
      ruleSnapshot: NonNullable<Parameters<typeof runTask>[0]['ruleSnapshot']>
      epistemic?: import('./task-loop.ts').EblTaskObserver
      completion?: NonNullable<Parameters<typeof runTask>[0]['completion']>
      /**
       * **任务局部的有界观察范围**（ADR-151 R1 §3；**可选**）。
       *
       * ⚠️ 它只能由**装配层**从"原始请求 + 受信声明"生成 —— 计划字段与 `enabled`
       *    布尔值都**不能**授予它。挂到本次任务授权上，任务环逐步校验。
       * ⚠️ 它与**规则资格无关**（修补 ①）：没有合格读回规则时，范围**照样**挂上 ——
       *    此时 `planner` 就是传进来的 `fallbackPlanner`（任务自己的规划器）。
       */
      boundedObservation?: { readonly targetPath: string; readonly conditionPath: string; readonly maxReads: number }
  /**
   * **F2 逐路径范围**（最小接点 R4 · 可选）：两个源只读、族标记限次只读、目标可写+读回、其它路径拒绝。
   * ⚠️ 只有**新的 F2 任务入口**才提供；缺省 ⇒ 旧行为逐字不变。
   */
  sourceScopedPaths?: {
    readonly readOnly: readonly string[]
    readonly limitedReads: readonly { readonly path: string, readonly maxReads: number }[]
    readonly writable: readonly string[]
  }
      /**
       * **明确拒绝这个任务入口**（ADR-151 R1 修补 ①）：**一个动作都不执行**，
       * 并且**不**退回普通/单动作路径（那会把不合法的两行请求截半执行）。
       * ⚠️ 这个字段在场时 `planner` / `ruleSnapshot` **不会被使用**。
       */
      entryRejected?: string
    } | undefined>
    staging: PayloadStagingPort
    /**
     * **P3-5b · G5：受管技能参与后的任务局部读根**（可选）。
     *
     * ⚠️ 缺省 ⇒ 不挂读根：旧入口与普通文件任务行为**逐字不变**。
     * ⚠️ 它只约束**本次任务**的读动作（不是全局能力定义）；挂载时机在"受管技能真的
     *    成功加载之后、后续动作执行之前"，越界读是**执行前拒绝**。
     */
    readRootScope?: {
      readonly skillId: string
      readonly roots: readonly string[]
      readonly source: string
    }
    /**
     * 本任务允许的能力集合（**装配层按开关算出** —— 模型不能扩大它）。
     * 返回空数组 ⇒ 不签发任何任务授权。
     */
    capabilitiesFor: () => readonly string[]
    /** 本任务允许的风险额度（浏览器 R2 只在这里被抬高） */
    riskLevelFor: () => RiskLevel
    /**
     * 目标解析函数（**与 Gateway 用的是同一个**）。
     *
     * ⚠️ 它必须由装配层同时交给 Gateway 与这里：任务步骤与单动作走同一套目标判定，
     *    否则"任务能碰什么"就成了第二个权威（ADR-031 的同一条理由）。
     */
    resolveTarget: (input: {
      request: ActionRequest
      operation: OperationDefinition | undefined
    }) => Promise<TargetResolution>
    now?: () => number
    onTaskOutcome?: (outcome: TaskRunOutcome) => void
    /**
     * WP2 / ADR-104 `D14`：**重新规划时**给规划器的程序事实与内容额度。
     *
     * ⚠️ 缺省 ⇒ 规划器输入逐字段不变（`rules` 档与全部既有门不受影响）。
     *    配了 ⇒ 每一次重新规划都带上"已经真的读到的内容"（额度内）与
     *    "程序给出的已知目录事实"。
     */
    replanContext?: {
      knownDirectories: () => readonly string[]
      contentTokens: number
      /** WP3：外部证据的独立额度（缺省 0 ⇒ 规划器看不到搜索命中） */
      evidenceTokens?: number
      quantifier?: (text: string) => number
    }
    /**
     * **行动预测**端口（三域应用方案 §2）。
     *
     * ⚠️ 缺省 ⇒ 这一层整段不跑（任务的输入、执行顺序与预算**逐字段**与旧档相同）。
     * ⚠️ 它**不授权**任何东西：预测只拿到闭集状态、具名失败码与既有预算内的读回事实。
     */
    forecast?: {
      port: ActionForecastPort
      deadlineMs: number
    }
  }
  /**
   * WP1 / ADR-104：**角色自行选择工具**的决策端口（配了它就进入 `role` 档）。
   *
   * ==========================================================================
   *  配与不配是两条**互斥**的资格判定路径（同一模式下只有一个入口）
   * ==========================================================================
   * ```text
   * 不配（缺省）  词形检测器决定"要不要动作" —— 今天的全部行为，**逐字节不变**
   * 配了          每轮至多一次决策调用；`answer` / `clarify` / 失败 ⇒ **零动作**；
   *               `tools` ⇒ 提案的 `{goal,steps,done}` 作为**首份计划**播种进
   *               既有任务执行环（预算 / 期限 / 进度闸 / 暂存 / 账本 / 归因一个不换）
   * ```
   * ⚠️ **关键词在本档一个都不参战**：`looksLikeTask` 与
   *    `options.detector.detect()` 在 role 路径上都不会被调用
   *    （D02："同一模式下只有一个工具选择入口"）。
   * ⚠️ `catalog` 是**程序生成**的目录文本（`renderToolCatalogForModel`）：
   *    它由装配层算，模型不能改它，也不能靠它扩大能力集合。
   */
  toolDecision?: {
    port: ToolDecisionPort
    catalog: string
  }
}

/**
 * K-27 / WP5.1：受信 initiator **只能**从**因果上下文**建立。
 *
 *   · 有触发事件（受信读者读回来的那一行）⇒ 走关联边界：
 *       RECORDED + `actor` 与 `contentOriginator` 都 Known 且同一位次
 *         ⇒ Known(那位次)
 *       否则（没记 / 有歧义 / 不是 Known）⇒ Unknown(RUNTIME_UNRESOLVED)
 *   · 没有触发事件 ⇒ ingress 如实说"没有因果上下文"⇒ Unknown
 *
 * `input.speaker` **一个字节都没有参与**这里 —— 它只去过 payload 的
 * `requestedBy`（兼容/输入证据，见下面 createActionRequest 的调用）。
 *
 * ⚠️ 第二批把这段抽成函数**只是**为了让它同时被单动作路径与任务执行环使用：
 *    两条路必须挂上**同一个**归因（计划书 §2.2："不能通过伪造 user 消息绕过入口"）。
 */
function initiatorEvidenceOf(
  options: ActionTurnPortOptions,
  input: ActionTurnInput
): ActionInvocationContext['initiatorEvidence'] {
  const adapterId = options.attribution?.adapterId ?? 'action-turn'
  if (input.triggeringEvent === undefined) {
    return attestActionInitiatorUnresolved({ adapterId })
  }
  return attestActionInitiatorFromCausalOrigin({
    adapterId,
    causalSource: correlationSourceFromConversationEvent({
      adapterId,
      triggeringEvent: input.triggeringEvent,
    }),
  })
}

export function createActionTurnPort(options: ActionTurnPortOptions): ActionTurnPort {
  /** 单动作路径的 invocation（不配归因 ⇒ undefined = legacy 逐字段不变） */
  const invocationOf = (input: ActionTurnInput): ActionInvocationContext | undefined =>
    options.attribution === undefined
      ? undefined
      : { initiatorEvidence: initiatorEvidenceOf(options, input) }

  return {
    semanticContext: conversationKey => {
      const open = conversationKey ? options.task?.authorizations.findOpen(conversationKey) : undefined
      return { catalog: options.toolDecision?.catalog ?? '', capabilities: options.task?.capabilitiesFor() ?? [],
        knownDirectories: options.task?.replanContext?.knownDirectories(),
        openTask: open ? { originalText: open.originalText } : undefined,
        validate: raw => { validateToolDecisionProposal(raw, { registry: options.registry,
          allowedCapabilities: options.task?.capabilitiesFor() ?? [] }) } }
    },
    async handleTurn(input: ActionTurnInput): Promise<ActionTurnResult> {
      /*
       * ======================================================================
       *  ⓘ WP1 / ADR-104：**role 档**（配了 `toolDecision` 就整段走这里）
       * ======================================================================
       * 顺序与旧的单动作路径**刻意不同**，但执行面完全相同：
       * ```text
       * ① 至多一次决策调用（`answer` / `clarify` / 失败 ⇒ 零动作）
       * ② 提案的 `tools` 分支作为**首份计划**播种进既有任务执行环
       * ③ 走到这里就结束 —— **不**再跑单动作的关键词路径（D02：只有一个入口）
       * ```
       * ⚠️ `toolDecision` 不配时本函数**逐字节**还是旧实现（M4.5 的 135 条断言走那一支）。
       */
      if (input.semanticDecision !== undefined && options.toolDecision === undefined) {
        return { kind: 'not_applicable', diagnostics: { semantic_entry: 'task_loop_unavailable' } }
      }
      if (options.toolDecision !== undefined) {
        return await handleRoleTurn(options, input)
      }

      /*
       * ======================================================================
       *  ⓪ 第二批：**任务执行环**（先于单动作路径）
       * ======================================================================
       * 计划书 §2.2 的链路要求"一个用户任务 → 有限计划 → 分步执行"，
       * 而单动作入口一次只能表达一件事。顺序是刻意的：
       * 任务路径**先**跑，真的产生了结果就不再跑单动作（一个任务一份动作集合）。
       * 一步都没做成时**落回**单动作路径 —— 于是被误判成任务的话照样能正常动作。
       */
      const taskOutcome = await maybeRunTask(options, input, { keywordEntry: true })
      // ⚠️ **入口被明确拒绝** ⇒ 这一轮**零动作**，不许退回单动作路径（ADR-151 R1 修补 ①）。
      if (taskOutcome?.stopped === 'entry_rejected') {
        return { kind: 'not_applicable', rule: `entry_rejected:${taskOutcome.planRejectedCode ?? 'unknown'}` }
      }
      if (taskOutcome !== undefined && taskOutcome.results.length > 0) {
        return shapeTaskOutcome(taskOutcome)
      }

      const baseline = options.detector.detect(input.text)
      /*
       * M5.5.1：不配 `resolveIntent` ⇒ 逐字段旧行为（M4.5 的所有断言走这一支）。
       * 配了 ⇒ 由解析器决定最终意图与是否产生请求。
       */
      const resolved: ResolvedActionIntent =
        options.resolveIntent === undefined
          ? { intent: baseline }
          : await options.resolveIntent({
              text: input.text,
              ...(baseline !== undefined ? { baseline } : {}),
            })
      const intent = resolved.intent
      if (intent === undefined) {
        return {
          kind: 'not_applicable',
          ...(resolved.diagnostics !== undefined ? { diagnostics: resolved.diagnostics } : {}),
        }
      }

      const definition = options.registry.get(intent.capability)
      const operation = options.registry.getOperation(intent.capability, intent.operation)
      if (definition === undefined || operation === undefined) {
        /*
         * 检测器指向了一个没登记的能力 = 接线错误。
         * 刻意**不**退回"没有意图"：那会让用户看到"她装作没听懂"，
         * 而真实情况是系统少装了一块。如实报 rejected。
         */
        return { kind: 'not_applicable', rule: `${intent.rule}:unregistered` }
      }

      const request = createActionRequest({
        actionId: newActionId(),
        traceId: input.traceId,
        capability: intent.capability,
        operation: intent.operation,
        requestedBy: input.speaker,
        arguments: intent.args,
        sideEffect: operation.sideEffect,
      })
      options.onRequest?.(request)

      /*
       * K-27 / WP5.1：受信 initiator **只能**从**因果上下文**建立。
       *
       *   · 有触发事件（受信读者读回来的那一行）⇒ 走关联边界：
       *       RECORDED + `actor` 与 `contentOriginator` 都 Known 且同一位次
       *         ⇒ Known(那位次)
       *       否则（没记 / 有歧义 / 不是 Known）⇒ Unknown(RUNTIME_UNRESOLVED)
       *   · 没有触发事件 ⇒ ingress 如实说"没有因果上下文"⇒ Unknown
       *
       * `input.speaker` **一个字节都没有参与**这里 —— 它只去过 payload 的
       * `requestedBy`（兼容/输入证据，见下面 createActionRequest 的调用）。
       */
      const invocation: ActionInvocationContext | undefined = invocationOf(input)

      const result = await options.gateway.execute(input.characterId, request, invocation)
      return {
        // `executed` 与 `rejected` 的分界线是**适配器有没有真的被调用过**
        // （而不是"成功没成功"）：failed 与 partial 都属于"执行过"。
        kind: result.executed ? 'executed' : 'rejected',
        request,
        result,
        rule: intent.rule,
        ...(resolved.diagnostics !== undefined ? { diagnostics: resolved.diagnostics } : {}),
      }
    },
  }
}

/**
 * WP1 / ADR-104 D14：把**提案的计划**当首份计划，之后交给原规划器。
 *
 * ```text
 * 第 1 次 plan() ⇒ 提案的计划（已经过 validateTaskPlan，且能力 ∈ 同一份授权集合）
 * 第 2 次起      ⇒ 原规划器（于是"看结果再决定下一步"仍是既有执行环的形状）
 * ```
 * ⚠️ 它**不**新增一次模型调用：提案本身就是那次决策调用的产物。
 *    不这样做的话，同一轮里会"决策一次 + 规划一次"，两次都从零想同一个问题。
 */
function seededPlanner(seed: TaskPlan, fallback: TaskPlannerPort): TaskPlannerPort {
  let used = false
  return {
    id: `${fallback.id}+role-seed`,
    endpointHost: fallback.endpointHost,
    async plan(input) {
      if (!used) {
        used = true
        return { ok: true, plan: seed, requestCount: 0 }
      }
      return await fallback.plan(input)
    },
  }
}

/** role 路径的**闭集诊断**（不许出现用户原文 / 模型原文） */
function roleDiagnostics(
  extra: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  return { tool_decision: 'role', ...extra }
}

/**
 * role 档的完整轮次（ADR-104：同一模式下**只有一个**工具选择入口）。
 *
 * ```text
 * ① 已有开场授权 ⇒ 直接继续那份任务（**不再问决策器**：一个用户任务问一次"要不要工具"）
 * ② 没有 ⇒ 问一次决策器（至多一次模型调用，有硬期限）
 *      · 失败 / answer / clarify ⇒ **零动作**，如实记闭集诊断
 *      · tools                  ⇒ 以提案为首份计划，签发授权并跑**既有**执行环
 * ③ 无论走哪一支，都**不**落到单动作的关键词路径（D02）
 * ```
 * ⚠️ 每一步都复用 `maybeRunTask` / `runTask` / `gateway.execute`：本函数**不**执行任何东西。
 */
async function handleRoleTurn(
  options: ActionTurnPortOptions,
  input: ActionTurnInput
): Promise<ActionTurnResult> {
  const decision = options.toolDecision!
  const task = options.task

  /*
   * ① 开场授权还在 ⇒ 继续它。
   *    ⚠️ 决策**不是**每轮都问：任务一旦开场，后续轮的"怎么做"由执行环自己的规划回答。
   */
  const openAuthorization =
    task !== undefined && input.conversationKey !== undefined && input.conversationKey !== ''
      ? task.authorizations.findOpen(input.conversationKey)
      : undefined
  if (openAuthorization !== undefined) {
    const continued = await maybeRunTask(options, input, { keywordEntry: false })
    if (continued?.stopped === 'entry_rejected') {
      return { kind: 'not_applicable', rule: `entry_rejected:${continued.planRejectedCode ?? 'unknown'}`,
        diagnostics: roleDiagnostics({ branch: 'continue', result: 'entry_rejected' }) }
    }
    if (continued !== undefined && continued.results.length > 0) {
      return shapeTaskOutcome(continued, roleDiagnostics({ branch: 'continue' }))
    }
    return {
      kind: 'not_applicable',
      diagnostics: roleDiagnostics({ branch: 'continue', result: 'no_action' }),
    }
  }

  /*
   * ② 没有开场授权 ⇒ 问一次决策器。
   *    ⚠️ 装配层没接任务环（或这一轮一个能力都没启用）⇒ **不问**：
   *       问了也执行不了，而"问了却不做"比"没问"更难排查。
   */
  const capabilities = task?.capabilitiesFor() ?? []
  if (task === undefined || capabilities.length === 0) {
    return {
      kind: 'not_applicable',
      diagnostics: roleDiagnostics({ branch: 'skipped', reason: 'no_task_loop' }),
    }
  }

  const expectedEvent = input.eventId
  void expectedEvent
  let reading
  try {
    reading = await readToolDecision(input.semanticDecision === undefined ? decision.port : {
      ...decision.port, decide: async () => ({ ok: true as const, raw: input.semanticDecision, requestCount: 0 }),
    }, {
      text: input.text,
      recentLines: input.recentLines ?? [],
      catalog: decision.catalog,
      /*
       * WP2：程序给出的已知目录事实（没接 `replanContext` ⇒ 这一项不出现）。
       * ⚠️ 与规划器看的是**同一份**渲染文本（一处产出、两处消费）。
       */
      ...(task.replanContext !== undefined
        ? { knownDirectories: task.replanContext.knownDirectories() }
        : {}),
      allowedCapabilities: capabilities,
      hasOpenTask: false,
      taskBudgetAvailable: true,
    }, { registry: options.registry, allowedCapabilities: capabilities })
  } catch (error) {
    /*
     * 兜底：`readToolDecision` 自己不抛（它把端口异常翻译成 `call_failed`），
     * 因此这条分支只有在**它自己**出错时才可达 —— 如实记，绝不静默。
     */
    return {
      kind: 'not_applicable',
      diagnostics: roleDiagnostics({
        branch: 'failed',
        failure: 'call_failed',
        errorName: error instanceof Error ? error.name : 'unknown',
      }),
    }
  }
  if (!reading.ok) {
    return {
      kind: 'not_applicable',
      diagnostics: roleDiagnostics({
        branch: 'failed',
        failure: reading.failure,
        ...(reading.parseFailureCode !== undefined ? { parseFailure: reading.parseFailureCode } : {}),
      }),
    }
  }

  const action = actionOfToolDecision(reading.proposal)
  if (action.kind === 'no_action') {
    return {
      kind: 'not_applicable',
      ...(reading.proposal.branch === 'clarify' ? { clarificationQuestion: reading.proposal.question } : {}),
      diagnostics: roleDiagnostics({ branch: reading.proposal.branch, result: action.reason }),
    }
  }

  /*
   * ③ tools ⇒ 以提案为首份计划，走**既有**执行环（签发授权的那一步在 `maybeRunTask` 里，
   *    与旧档是**同一段代码** —— 于是"授权怎么签发"只有一个实现）。
   */
  const ran = await maybeRunTask(options, input, { keywordEntry: false, seedPlan: action.plan })
  if (ran?.stopped === 'entry_rejected') {
    return { kind: 'not_applicable', rule: `entry_rejected:${ran.planRejectedCode ?? 'unknown'}`,
      diagnostics: roleDiagnostics({ branch: 'tools', result: 'entry_rejected' }) }
  }
  if (ran === undefined) {
    return {
      kind: 'not_applicable',
      diagnostics: roleDiagnostics({ branch: 'tools', result: 'not_authorized' }),
    }
  }
  /*
   * ==========================================================================
   *  ⚠️ **空结果的收尾**（WP3 的全工具组合门逮到的一处真缺陷）
   * ==========================================================================
   * ```text
   * 执行环可能**一步都没执行**就结束（计划被程序丢弃 / 规划失败 / 一开始就判无进展）。
   * 第一版直接走 `shapeTaskOutcome()`，而它假定 `results[0]` 存在
   * ⇒ 抛 TypeError ⇒ 被 `turn-gateway` 的动作分发 catch 吞成
   *   "动作分发抛异常（没有执行）"，**停止原因整个丢掉**（`planRejectedCode` 一起消失）。
   * 这与"没成功就没成功口吻"是同一条纪律：**没有结果也要如实说为什么没有**。
   * ```
   */
  if (ran.results.length === 0) {
    return {
      kind: 'not_applicable',
      diagnostics: roleDiagnostics({
        branch: 'tools',
        result: 'no_action',
        stopped: ran.stopped,
        ...(ran.planRejectedCode !== undefined ? { planRejected: ran.planRejectedCode } : {}),
        ...(ran.plannerFailureCode !== undefined ? { plannerFailure: ran.plannerFailureCode } : {}),
      }),
    }
  }
  return shapeTaskOutcome(ran, roleDiagnostics({ branch: 'tools' }))
}

/** 把执行环的结果摊平成一个 `ActionTurnResult`（**唯一**一份摊平实现，两支共用） */
function shapeTaskOutcome(
  outcome: TaskRunOutcome,
  diagnostics?: Record<string, string | number | boolean>
): ActionTurnResult {
  const [first, ...rest] = outcome.results
  const primary = first!
  return {
    // `executed` 与 `rejected` 的分界线仍是"适配器有没有真的被调用过"
    kind: 'executed',
    request: primary.request,
    result: primary.result,
    rule: primary.rule,
    followUps: rest.map((entry) => ({
      kind: 'executed' as const,
      request: entry.request,
      result: entry.result,
      rule: entry.rule,
    })),
    task: {
      taskId: outcome.taskId,
      steps: outcome.steps.length,
      actionsUsed: outcome.actionsUsed,
      plansUsed: outcome.plansUsed,
      stopped: outcome.stopped,
      ...(outcome.goal ? {goal:{...outcome.goal,delivered:false}} : {}),
    },
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  }
}

/**
 * 任务路径的入口闸（**不配 `options.task` 或没有会话键 ⇒ 恒 `undefined`**）。
 *
 * 三件事，顺序就是它们的优先关系：
 * ```text
 * ① 有仍然有效的任务授权 ⇒ 继续它（"原任务绑定"，计划书 §2.2 逐字）
 * ② 没有 + 这句话像任务形 + 至少一个能力被启用 ⇒ 签发新授权
 * ③ 都不是 ⇒ undefined（调用方走旧的单动作路径）
 * ```
 * WP1 起多了两样，都是**加法**（不传 ⇒ 逐字段旧行为）：
 * ```text
 * gate.keywordEntry  false ⇒ ②**不许**由词形签发授权（role 档：只有一个入口）
 * gate.seedPlan      给了 ⇒ ②直接签一份授权，并把这份计划当**首份计划**
 * ```
 */
async function maybeRunTask(
  options: ActionTurnPortOptions,
  input: ActionTurnInput,
  gate: { keywordEntry: boolean; seedPlan?: TaskPlan }
): Promise<TaskRunOutcome | undefined> {
  const task = options.task
  if (task === undefined) return undefined
  if (input.conversationKey === undefined || input.conversationKey === '') return undefined

  let authorization = task.authorizations.findOpen(input.conversationKey)
  if (authorization === undefined) {
    /*
     * ⚠️ 顺序**逐字保留**（词形判据先、能力清单后）：旧档的行为必须一模一样 ——
     *    连"哪一步先被调用"也不改（避免"某个函数的副作用顺序变了"这类隐形漂移）。
     */
    if (gate.seedPlan === undefined) {
      // ② 只有**旧档**才允许由词形签发授权（role 档的资格由决策端口回答）
      if (!gate.keywordEntry) return undefined
      if (!looksLikeTask(input.text)) return undefined
    }
    const capabilities = task.capabilitiesFor()
    if (capabilities.length === 0) return undefined
    authorization = task.authorizations.issue({
      conversationKey: input.conversationKey,
      originalText: input.text,
      triggeringEventId: input.eventId,
      allowedCapabilities: capabilities,
      maxRiskLevel: task.riskLevelFor(),
    })
  }

  const defaultPlanner = gate.seedPlan === undefined ? task.planner : seededPlanner(gate.seedPlan, task.planner)
  const configured = await task.configurePlanning?.(input.text, defaultPlanner)
  /*
   * ⚠️ **明确拒绝 ⇒ 零动作**（ADR-151 R1 修补 ①）：
   *    自称 F1 但形状/辅助路径不合法的请求，**不许**退回普通规划（那会截半执行），
   *    也**不许**退回单动作路径（那是同一件错事的另一条路）。
   *    ⇒ 这里直接收尾成一个"零结果、具名原因"的任务结局；调用方据此**不**走单动作。
   */
  if (configured?.entryRejected !== undefined) {
    task.authorizations.close(authorization.taskId, 'entry_rejected')
    return {
      taskId: authorization.taskId,
      steps: [],
      results: [],
      plansUsed: authorization.plansUsed,
      actionsUsed: authorization.actionsUsed,
      stopped: 'entry_rejected',
      planRejectedCode: configured.entryRejected,
    }
  }
  /*
   * ⚠️ **有界观察范围只挂到"本次任务授权"上**（ADR-151 R1 §3）：
   *    它不是新权限表、不是第二套执行器 —— 只是这一份授权多了一个"只读某个标记一次"的局部范围。
   *    缺省不提供 ⇒ 旧行为逐字不变。
   *    ⚠️ 同任务**重复挂载是幂等的**（修补 ②：计数不重置、范围不许换）。
   */
  if (configured?.boundedObservation !== undefined) {
    applyBoundedObservation(authorization, configured.boundedObservation)
  }
  /*
   * ⚠️ **F2 逐路径范围**（R4）：同样只挂到"本次任务授权"上；幂等且**不可扩**
   *    （同范围保留已用计数；任何扩大 ⇒ 拒绝且不改原范围）。缺省不提供 ⇒ 旧行为逐字不变。
   */
  if (configured?.sourceScopedPaths !== undefined) {
    applySourceScopedPaths(authorization, configured.sourceScopedPaths)
  }
  const outcome = await runTask(
    {
      gateway: options.gateway,
      registry: options.registry,
      authorizations: task.authorizations,
      planner: configured?.planner ?? (gate.seedPlan === undefined ? task.planner : seededPlanner(gate.seedPlan, task.planner)),
      ...(configured?.ruleSnapshot === undefined ? {} : { ruleSnapshot: configured.ruleSnapshot }),
      ...(configured?.completion ? {completion:configured.completion} : {}),
      staging: task.staging,
      /*
       * 目标解析**复用**装配层那一份（`options.gateway` 里的同一个函数）：
       * 任务步骤与单动作必须走同一套目标判定，否则"任务能碰的东西"就成了第二个权威。
       * ⚠️ Gateway 的 `resolveTarget` 不在公开接口上，因此这里用网关自己的
       *    `evaluate()` 拿不到目标 —— 改为让 gateway 暴露的解析结果由下面的
       *    `resolveTarget` 委托实现提供（装配层把同一个函数同时交给两处）。
       */
      resolveTarget: task.resolveTarget,
      ...(task.replanContext !== undefined ? { replanContext: task.replanContext } : {}),
      /* P3-5b · G5：受管技能参与后的任务局部读根（缺省不传 ⇒ 旧行为逐字不变）。 */
      ...(task.readRootScope === undefined ? {} : { readRootScope: task.readRootScope }),

      ...(configured === undefined && task.forecast !== undefined ? { forecast: task.forecast } : {}),
      ...(configured?.epistemic !== undefined ? { epistemic: configured.epistemic }
        : task.epistemic !== undefined ? { epistemic: task.epistemic } : {}),
      invocationFor: ({ authorization: active }) => ({
        initiatorEvidence: initiatorEvidenceOf(options, input),
        ...(active.maxRiskLevel !== undefined ? { riskBudgetOverride: active.maxRiskLevel } : {}),
      }),
      now: task.now,
    },
    {
      characterId: input.characterId,
      traceId: input.traceId,
      authorization,
      text: input.text,
    }
  )
  options.task?.onTaskOutcome?.(outcome)
  return outcome
}
