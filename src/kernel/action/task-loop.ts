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
import type { TaskAuthorization, TaskAuthorizationPort, TaskCloseReason } from './task-authorization.ts'
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

export interface TaskLoopOptions {
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

export interface TaskRunOutcome {
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
   * WP3：**已经拿到的外部证据**（搜索命中；同样只在配了 `replanContext` 时才被消费）。
   *
   * ⚠️ 按 `evidence.id` 去重：同一条命中被两次搜索带回来时不该占两份额度。
   */
  const gatheredEvidence: ExternalEvidence[] = []

  let stopped: TaskStopReason = 'done'
  let plannerFailureCode: string | undefined
  let planRejectedCode: string | undefined
  /** 连续多少次"模型没按格式答"（有界重试；见下面的 `invalid_output` 分支） */
  let invalidOutputStreak = 0

  const authorization = input.authorization

  for (;;) {
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
        ? {
            content: selectTurnContentContext({
              items: gatheredContent,
              budgetTokens: options.replanContext.contentTokens,
              ...(options.replanContext.quantifier !== undefined
                ? { quantifier: options.replanContext.quantifier }
                : {}),
            }).selected.map((entry) => renderTurnContentEntry(entry.item, entry.label)),
          }
        : {}),
      ...(options.replanContext !== undefined && gatheredEvidence.length > 0
        ? {
            evidence: selectExternalEvidenceContext({
              evidence: gatheredEvidence,
              budgetTokens: options.replanContext.evidenceTokens ?? 0,
              ...(options.replanContext.quantifier !== undefined
                ? { quantifier: options.replanContext.quantifier }
                : {}),
            }).selected.map((item) => renderExternalEvidenceEntry(item)),
          }
        : {}),
      ...(options.replanContext !== undefined
        ? { knownDirectories: options.replanContext.knownDirectories() }
        : {}),
    })

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

    if (plan.steps.length === 0) {
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

    // 任务编排：本批执行失败后不能沿用尚未观察结果的后续步骤，即使模型自报 done。
    let batchFailed = false
    for (const step of plan.steps) {
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
      if (result.status !== 'success') {
        batchFailed = true
        break
      }
    }

    if (stopped !== 'done') break
    if (plan.done && !batchFailed) {
      options.authorizations.close(authorization.taskId, 'done')
      stopped = 'done'
      break
    }
  }

  return {
    taskId: authorization.taskId,
    steps,
    results,
    plansUsed: authorization.plansUsed,
    actionsUsed: authorization.actionsUsed,
    stopped,
    ...(plannerFailureCode !== undefined ? { plannerFailureCode } : {}),
    ...(planRejectedCode !== undefined ? { planRejectedCode } : {}),
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
    `${steps === '' ? '' : ` · ${steps}`}`
  )
}

export type { Timestamp }
