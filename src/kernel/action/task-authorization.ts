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

/**
 * **任务局部的有界观察范围**（ADR-151 R1 §3）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * ```text
 * 原任务只授权"一个目标的写入与读回"
 * 前置条件观察需要**另一个文件**的一次只读 —— 那是**额外**权限
 *   ⇒ 它必须由**程序**从"原始请求 + 受信声明"生成，**不能**由模型 plan 字段、
 *     也不能由一个 `enabled` 布尔值授予。
 * ```
 * ⚠️ `attempts` 是**任务局部**的可变计数：在读**真的执行之前**就 +1 ⇒ 重入/并发/重规划
 *    都**不会**产生第二次读（ADR-151 R1 §4）。
 * ⚠️ 缺省不提供 ⇒ 旧行为逐字不变。
 */
/**
 * **F2 逐路径授权**（最小接点 R4 · 可选）：一个任务里**哪些路径能读、哪些能写、哪些只能限次读**。
 *
 * ⚠️ 只有"**新的 F2 任务入口**"才挂；缺省 ⇒ 无额外限制，**旧入口行为逐字不变**。
 * ⚠️ 由装配层**挂上**（同一任务对象），任务环**逐步**校验；模型给的路径绕不过去。
 * ⚠️ 计数**在执行前** +1（重入/重试不会多读）；重挂**不能**扩大范围、**不能**重置计数。
 */
export interface TaskSourceScopedPaths {
  /** 只读路径（本对象的缓存源与权威源）。 */
  readonly readOnly: readonly string[]
  /** 限次只读路径（族级条件标记；通常 maxReads = 1）。 */
  readonly limitedReads: readonly { readonly path: string; readonly maxReads: number }[]
  /** 可写路径（目标；写后允许**读回**）。 */
  readonly writable: readonly string[]
  /** 限次读的已用次数（稳定标识 === 路径；程序计数）。 */
  attempts: Record<string, number>
}
export interface TaskBoundedObservation {
  /** 本任务唯一的目标路径（写 + 读回）。 */
  readonly targetPath: string
  /** 唯一允许额外**只读**一次的条件标记路径。 */
  readonly conditionPath: string
  /** 只读次数上限（当前恒为 1）。 */
  readonly maxReads: number
  /** 已经尝试过的次数（程序计数）。 */
  attempts: number
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
  /**
   * **任务局部的有界观察范围**（ADR-151 R1 · **可选**）。
   *
   * ⚠️ 只有"明确的两行请求 + 受信声明"才给；缺省 ⇒ 无额外权限。
   * ⚠️ 由装配层在规划装配完成后**挂上**（同一任务对象），任务环对每一步校验。
   */
  boundedObservation?: TaskBoundedObservation
  /**
   * **F2 逐路径范围**（最小接点 R4 · 可选）。
   * 缺省 ⇒ 无额外限制（旧入口行为逐字不变）。
   */
  sourceScopedPaths?: TaskSourceScopedPaths
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
  /**
   * **任务入口被明确拒绝**（ADR-151 R1 修补 ①）。
   *
   * ⚠️ 它与 `plan_failed` 分开：这不是"模型没给出计划"，而是**程序**判定
   *    "这条请求自称 F1 但形状/辅助路径不合法" ⇒ **一个动作都不许执行**
   *    （也**不许**退回单动作路径 —— 那会截半执行）。
   */
  | 'entry_rejected'
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
  /**
   * **记一次条件只读尝试**（ADR-151 R1 §4）。
   *
   * ⚠️ 调它**就**表示"这次读算数了"—— 调用方必须在**执行之前**调用（这样重入也不会读第二次）。
   * 返回 `false` ⇒ 没有范围 / 已经用满 ⇒ **不许**执行这次读。
   */
  noteConditionRead(taskId: string): boolean
  /** R4：族级标记的限次读；**计数在执行前** +1；超限或路径不在范围内 ⇒ false。 */
  noteSourceScopedRead(taskId: string, path: string): boolean
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
    noteSourceScopedRead(taskId, path) {
    const task = byId.get(taskId)
    if (task === undefined) return false
    const scope = task.sourceScopedPaths
    if (scope === undefined) return false
    const entry = scope.limitedReads.find(item => item.path === path)
    if (entry === undefined) return false
    const used = scope.attempts[path] ?? 0
    if (used >= entry.maxReads) return false
    scope.attempts[path] = used + 1
    return true
  },
  noteConditionRead(taskId) {
      const task = byId.get(taskId)
      if (task === undefined) return false
      const scope = task.boundedObservation
      if (scope === undefined) return false
      if (scope.attempts >= scope.maxReads) return false
      scope.attempts += 1
      return true
    },
    list() {
      return [...byId.values()]
    },
  }
}

/**
 * 把**程序生成的有界观察范围**挂到一份任务授权上（ADR-151 R1 §3）。
 *
 * ⚠️ **同任务重复挂载是幂等的**（ADR-151 R1 修补 ②）：已有范围时
 *    - 范围**完全相同** ⇒ **保留原计数**（`attempts` 不重置 ⇒ 不会因为重新配置又多一次读）；
 *    - 范围**不同** ⇒ **拒绝更换**（第一次挂上的那份才是这次任务的；不许借重新配置换范围）。
 * ⚠️ 只有**装配层**（从原始请求 + 受信声明）与**测试夹具**该调它；
 *    模型与计划字段**没有**路径能到这里。
 * ⚠️ 传 `undefined` ⇒ 什么都不做（旧行为）。
 * @returns 这次挂载**是否被接受**（已有不同范围 ⇒ `false`）。
 */
/**
 * **挂载 F2 逐路径范围**（最小接点 R4）。
 *
 * ⚠️ **幂等且不可扩**：
 *  · 没挂过 ⇒ 挂上（计数从 0 开始）；
 *  · 已挂过 ⇒ 只有**完全相同**的范围才返回 true（保留已用计数）；
 *    **任何扩大/改变**（多一个可读路径、多一个可写路径、把 maxReads 变大）⇒ 返回 false 且**不改原范围**。
 *  · 计数**不会**因重挂而重置。
 */
export function applySourceScopedPaths(
  task: TaskAuthorization,
  scope: { readonly readOnly: readonly string[], readonly limitedReads: readonly { readonly path: string, readonly maxReads: number }[], readonly writable: readonly string[] } | undefined
): boolean {
  if (scope === undefined) return false
  const normalize = (value: { readOnly: readonly string[], limitedReads: readonly { path: string, maxReads: number }[], writable: readonly string[] }): string =>
    JSON.stringify({
      readOnly: [...value.readOnly].sort(),
      limitedReads: [...value.limitedReads].map(item => `${item.path}:${String(item.maxReads)}`).sort(),
      writable: [...value.writable].sort(),
    })
  const existing = task.sourceScopedPaths
  if (existing !== undefined) {
    // 已挂过：只接受**完全相同**（计数保留）；任何扩大 ⇒ false 且不改
    return normalize({ readOnly: existing.readOnly, limitedReads: existing.limitedReads, writable: existing.writable })
      === normalize(scope)
  }
  task.sourceScopedPaths = {
    readOnly: [...scope.readOnly],
    limitedReads: scope.limitedReads.map(item => ({ path: item.path, maxReads: item.maxReads })),
    writable: [...scope.writable],
    attempts: {},
  }
  return true
}
export function applyBoundedObservation(
  task: TaskAuthorization,
  scope: { readonly targetPath: string; readonly conditionPath: string; readonly maxReads: number } | undefined
): boolean {
  if (scope === undefined) return false
  const existing = task.boundedObservation
  if (existing !== undefined) {
    return existing.targetPath === scope.targetPath
      && existing.conditionPath === scope.conditionPath
      && existing.maxReads === scope.maxReads
  }
  task.boundedObservation = {
    targetPath: scope.targetPath,
    conditionPath: scope.conditionPath,
    maxReads: scope.maxReads,
    attempts: 0,
  }
  return true
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
