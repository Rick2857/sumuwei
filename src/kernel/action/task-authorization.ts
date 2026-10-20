/**
 * TaskAuthorization —— **任务授权**（第二批计划 §2.2）。
 *
 * ============================================================================
 *  它是"为达到任务目标自行决定"这句话的**唯一**合法来源
 * ============================================================================
 * 计划书 §2.2 逐字给出这条链路：
 * ```text
 * 用户任务 → 任务授权（原 user event / taskId / 能力 / 文件范围 / 预算）
 *          → 模型提出有限动作计划 → 程序校验
 *          → 逐步 ActionRequest → 既有 Registry / Policy / Gateway / Adapter
 *          → 实际结果 → 必要时修正后续步骤 → 检查后的任务回复
 * ```
 * 三条硬性质：
 * ```text
 * ① **程序签发，模型不能扩大**：`allowedCapabilities` 由装配层的开关决定；
 *    模型给出的计划只能落在这一集合里（超出的步骤被丢弃并如实记）。
 * ② **绑原任务**：「每次动作仍有确定目标、actionId、traceId、**原始任务归因**和结果，
 *    不能通过伪造 user 消息绕过入口。」⇒ 授权里存着原话与触发事件，每次动作的
 *    initiator 都从那条**因果上下文**建立（不新造一条 user 事件）。
 * ③ **内存绑定当前会话**：「此任务授权先在内存中绑定当前会话和原任务，
 *    **不增加数据库迁移**或新的长期记忆/目标来源。」⇒ 本文件是一个进程内的 Map，
 *    没有任何持久化（进程重启后任务如实消失，不"继续运行"）。
 *
 * ============================================================================
 *  预算（计划书 §2.2 的候选值，逐字）
 * ============================================================================
 * ```text
 * 每任务 30 次行动 · 6 次规划调用 · 10 分钟总时限
 * ```
 * 超限、取消、断线与重启后**如实返回已完成和未完成部分，不假报继续运行**。
 */

import type { RiskLevel } from './action-request.ts'

export interface TaskBudget {
  maxActions: number
  maxPlans: number
  deadlineMs: number
}

/** 计划书 §2.2 的候选预算（装配层可覆盖；缺省就是这三个数） */
export const DEFAULT_TASK_BUDGET: TaskBudget = {
  maxActions: 30,
  maxPlans: 6,
  deadlineMs: 10 * 60 * 1000,
}

export interface NewTaskAuthorization {
  /** 会话键（当前会话绑定；不新增数据库表） */
  conversationKey: string
  /** 原始任务原话（**逐字**；用于归因与"不能伪造新指令"的对照） */
  originalText: string
  /** 触发这一轮的用户事件 id（因果上下文的锚点） */
  triggeringEventId: string
  /** 本任务允许的能力 id 集合（由装配层按开关算出） */
  allowedCapabilities: readonly string[]
  /** 本任务允许的风险额度（浏览器 R2 只在这里被抬高，见 `browser-capability.ts`） */
  maxRiskLevel: RiskLevel
  budget?: TaskBudget
}

export interface TaskAuthorization {
  taskId: string
  conversationKey: string
  originalText: string
  triggeringEventId: string
  allowedCapabilities: readonly string[]
  maxRiskLevel: RiskLevel
  budget: TaskBudget
  createdAt: number
  expiresAt: number
  /** 已经用掉的行动次数 */
  actionsUsed: number
  /** 已经用掉的规划调用次数 */
  plansUsed: number
  /** 关闭原因（关闭后不再复用） */
  closedReason?: TaskCloseReason
}

export type TaskCloseReason =
  | 'done'
  | 'budget_actions'
  | 'budget_plans'
  | 'deadline'
  | 'plan_failed'
  /**
   * 计划**原地打转**（整份计划都是"已经成功过的引用 + 同一个操作"）。
   *
   * ⚠️ 它必须与 `done` 分开：任务**没有**做完，只是"再问一次也不会有新东西"。
   *    把它记成 `done` 就是一次假报（她会以为事情办完了）。
   *    2026-10-05 的真实事故：规划器看不到内容 ⇒ 同一个目录列了 6 次，
   *    12 次行动预算烧光，最后整轮因为当轮内容超上限而失败。
   */
  | 'no_progress'
  /**
   * **核对被反驳**（三域应用方案 §2）。
   *
   * ⚠️ 任务**不能**在这里报完成：程序知道有一个核对条件**没通过**
   *    （例如"写成功"但适配器没有留下任何效果），此时"完成"是一句假话。
   *    ⇒ 停止原因与 `done` **分开**，如实告诉调用方"没做完，且原因是什么"。
   */
  | 'check_refuted'
  | 'cancelled'
  | 'superseded'

export interface TaskAuthorizationPort {
  /** 签发一份新授权；同一会话的旧授权被 `superseded`（**不并存**两份任务） */
  issue(input: NewTaskAuthorization): TaskAuthorization
  find(taskId: string): TaskAuthorization | undefined
  /** 找当前会话**仍然有效**的那一份（过期/关闭/超预算 ⇒ `undefined`） */
  findOpen(conversationKey: string, now?: number): TaskAuthorization | undefined
  /** 扣一次行动预算；超限返回 `false`（**不扣**） */
  consumeAction(taskId: string): boolean
  /** 扣一次规划预算；超限返回 `false` */
  consumePlan(taskId: string): boolean
  /** 时限到了没有（到点即视为关闭，但**如实**留下原因） */
  expired(taskId: string, now?: number): boolean
  close(taskId: string, reason: TaskCloseReason): void
  list(): readonly TaskAuthorization[]
}

export interface TaskAuthorizationOptions {
  now?: () => number
  budget?: TaskBudget
  /** taskId 生成器（注入以便测试固定值；缺省用时间 + 计数器） */
  nextTaskId?: () => string
}

export function createTaskAuthorizationRegistry(
  options: TaskAuthorizationOptions = {}
): TaskAuthorizationPort {
  const now = options.now ?? (() => Date.now())
  const budget = options.budget ?? DEFAULT_TASK_BUDGET
  const byId = new Map<string, TaskAuthorization>()
  const openByConversation = new Map<string, string>()
  let counter = 0
  const nextTaskId =
    options.nextTaskId ??
    ((): string => {
      counter += 1
      return `task_${now().toString(36)}_${counter.toString(36)}`
    })

  function isOpen(task: TaskAuthorization, at: number): boolean {
    if (task.closedReason !== undefined) return false
    if (at >= task.expiresAt) return false
    if (task.actionsUsed >= task.budget.maxActions) return false
    if (task.plansUsed >= task.budget.maxPlans) return false
    return true
  }

  return {
    issue(input) {
      const at = now()
      const taskBudget = input.budget ?? budget
      const previousId = openByConversation.get(input.conversationKey)
      if (previousId !== undefined) {
        const previous = byId.get(previousId)
        if (previous !== undefined && previous.closedReason === undefined) {
          previous.closedReason = 'superseded'
        }
      }
      const task: TaskAuthorization = {
        taskId: nextTaskId(),
        conversationKey: input.conversationKey,
        originalText: input.originalText,
        triggeringEventId: input.triggeringEventId,
        allowedCapabilities: [...input.allowedCapabilities],
        maxRiskLevel: input.maxRiskLevel,
        budget: { ...taskBudget },
        createdAt: at,
        expiresAt: at + taskBudget.deadlineMs,
        actionsUsed: 0,
        plansUsed: 0,
      }
      byId.set(task.taskId, task)
      openByConversation.set(input.conversationKey, task.taskId)
      return task
    },
    find(taskId) {
      return byId.get(taskId)
    },
    findOpen(conversationKey, at) {
      const taskId = openByConversation.get(conversationKey)
      if (taskId === undefined) return undefined
      const task = byId.get(taskId)
      if (task === undefined) return undefined
      const stamp = at ?? now()
      if (!isOpen(task, stamp)) {
        /*
         * ⚠️ 这里**如实**落一个关闭原因（而不是静默返回 undefined）：
         *    "任务为什么停了"必须是可查的 —— 计划书要求超限/时限后
         *    "如实返回已完成和未完成部分"。
         *    ⚠️ 但**不覆盖**已有的关闭原因（第一次的原因才是真的原因）。
         */
        if (task.closedReason === undefined) {
          if (stamp >= task.expiresAt) task.closedReason = 'deadline'
          else if (task.actionsUsed >= task.budget.maxActions) task.closedReason = 'budget_actions'
          else if (task.plansUsed >= task.budget.maxPlans) task.closedReason = 'budget_plans'
        }
        return undefined
      }
      return task
    },
    consumeAction(taskId) {
      const task = byId.get(taskId)
      if (task === undefined) return false
      if (task.actionsUsed >= task.budget.maxActions) return false
      task.actionsUsed += 1
      return true
    },
    consumePlan(taskId) {
      const task = byId.get(taskId)
      if (task === undefined) return false
      if (task.plansUsed >= task.budget.maxPlans) return false
      task.plansUsed += 1
      return true
    },
    expired(taskId, at) {
      const task = byId.get(taskId)
      if (task === undefined) return true
      return (at ?? now()) >= task.expiresAt
    },
    close(taskId, reason) {
      const task = byId.get(taskId)
      if (task === undefined) return
      if (task.closedReason === undefined) task.closedReason = reason
    },
    list() {
      return [...byId.values()]
    },
  }
}

/**
 * 任务授权的一行摘要（**只含闭集与计数**：不含原话、不含模型输出）。
 *
 * 计划书 §2.2 的隐私纪律与 ADR-049 §5 的禁止清单同源：
 * 诊断面只允许闭集码与计数。
 */
export function describeTaskAuthorization(task: TaskAuthorization): string {
  return (
    `task=${task.taskId} 能力=${String(task.allowedCapabilities.length)} 个 ` +
    `预算=${String(task.actionsUsed)}/${String(task.budget.maxActions)} 行动 · ` +
    `${String(task.plansUsed)}/${String(task.budget.maxPlans)} 规划 · ` +
    `额度=${task.maxRiskLevel}` +
    `${task.closedReason !== undefined ? ` · 关闭=${task.closedReason}` : ''}`
  )
}
