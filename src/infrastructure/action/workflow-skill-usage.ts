/**
 * P3 —— **真实入口的按轮使用记录**（基础设施层薄适配）。
 *
 * ============================================================================
 *  它回答的问题与 trace 不同
 * ============================================================================
 * ```text
 * trace        "这一轮的上下文里有哪些 section id、执行了哪些动作"
 * 本模块        "这个技能**哪一版**、被**选中/加载/入模/读资料**了没、**结果核验**是什么"
 * ```
 * 二者不互相替代：`contextSectionIds` 能证明"某段叫人话的 section 进过上下文"，
 * 但回答不了"它是哪个技能版本、那一版当时是不是 published"。
 *
 * ⚠️ 纪律：
 *  · 只由**装配层**在轮次结束后调用（模型与动作都没有路径写使用记录）。
 *  · `outcome` 缺省从**任务环自己的闭集读数**推导（`task.goal.achieved`）；
 *    没有任务读数 ⇒ `unknown`（**不**因为"加载成功"就记 done）。
 *  · 记账失败**不**改写用户已经得到的回复；失败会以 `[p3-skill-usage]` 前缀
 *    如实打到 stderr（边界见批记录 §局限）。
 */

import type { ActionTurnResult } from '../../kernel/action/action-turn.ts'
import type { ContextPacket } from '../../kernel/contracts/context.ts'
import {
  deriveWorkflowSkillUsageRecord,
  packetSkillUsageView,
  type WorkflowSkillPublishedState,
  type WorkflowSkillTaskOutcome,
  type WorkflowSkillUsageRecord,
} from '../../kernel/contracts/workflow-skill-catalog.ts'
import type { LoadedWorkflowSkillCatalog } from './workflow-skill-catalog.ts'
import { loadedReleaseOf, currentLoadedRelease } from './workflow-skill-catalog.ts'
import type { WorkflowSkillReleaseStore } from '../persistence/workflow-skill-release-store.ts'
import { parseWorkflowSkillReleaseRef } from '../../kernel/contracts/workflow-skill-catalog.ts'

/** 本轮被**选中**（发出过加载请求）的技能 id，按出现顺序去重。 */
export function selectedSkillIds(actionResults: readonly ActionTurnResult[]): readonly string[] {
  const ids: string[] = []
  const visit = (item: ActionTurnResult): void => {
    const request = item.request
    if (request?.capability === 'workflow.skill' && request.operation === 'load' &&
        typeof request.arguments.skill === 'string' && item.result !== undefined &&
        !ids.includes(request.arguments.skill)) {
      ids.push(request.arguments.skill)
    }
    for (const followUp of item.followUps ?? []) visit(followUp)
  }
  for (const item of actionResults) visit(item)
  return ids
}

/** 从任务环读数推导结果（缺省路径）：没有任务读数 ⇒ `unknown`。 */
export function outcomeFromActionResults(actionResults: readonly ActionTurnResult[]): {
  readonly outcome: WorkflowSkillTaskOutcome
  readonly stopReason?: string
  readonly taskId?: string
} {
  const tasks: NonNullable<ActionTurnResult['task']>[] = []
  const visit = (item: ActionTurnResult): void => {
    if (item.task !== undefined) tasks.push(item.task)
    for (const followUp of item.followUps ?? []) visit(followUp)
  }
  for (const item of actionResults) visit(item)
  if (tasks.length === 0) {
    return { outcome: { kind: 'unknown', evidence: { reason: 'no_task_reading' } } }
  }
  const achieved = tasks.some((task) => task.goal?.achieved === true && task.stopped === 'done')
  const stopped = tasks[tasks.length - 1]!.stopped
  const taskId = tasks[tasks.length - 1]!.taskId
  return {
    outcome: {
      kind: achieved ? 'done' : 'not_done',
      evidence: {
        taskCount: tasks.length,
        achieved,
        stopped,
        ...(tasks[0]!.goal !== undefined ? { goalDelivered: tasks[0]!.goal.delivered === true } : {}),
      },
    },
    stopReason: stopped,
    taskId,
  }
}

export interface RecordSkillUsageForTurnInput {
  readonly characterId: string
  readonly traceId: string
  readonly actionResults: readonly ActionTurnResult[]
  readonly packet: ContextPacket
  readonly store: WorkflowSkillReleaseStore
  readonly loaded: LoadedWorkflowSkillCatalog
  /** 每个技能的**独立核验**结果（缺省用任务环读数） */
  readonly outcomes?: Readonly<Record<string, WorkflowSkillTaskOutcome>>
  /** 资料根（**绝对路径**）：越界读取按它判；缺省不判越界 */
  readonly libraryRoots?: readonly string[]
  readonly stopReason?: string
  readonly instructionWithheldReasons?: Readonly<Record<string, string>>
  readonly now: number
}

/**
 * 为本轮**所有被选中的技能**各写一条使用记录。
 *
 * ⚠️ 返回的记录与写入的行是同一份内容（门可以直接断言内存值与读回值一致）。
 */
export async function recordWorkflowSkillUsageForTurn(
  input: RecordSkillUsageForTurnInput
): Promise<WorkflowSkillUsageRecord[]> {
  const skillIds = selectedSkillIds(input.actionResults)
  if (skillIds.length === 0) return []
  const derived = outcomeFromActionResults(input.actionResults)
  const packetView = packetSkillUsageView(input.packet)
  const records: WorkflowSkillUsageRecord[] = []

  for (const skillId of skillIds) {
    /* 优先用**加载回执里的精确版本**（而不是"现在的当前版本"） */
    const receiptVersion = (() => {
      for (const item of input.actionResults) {
        const request = item.request
        if (request?.capability !== 'workflow.skill' || request.operation !== 'load' ||
            request.arguments.skill !== skillId || item.result === undefined) continue
        for (const evidence of item.result.evidence ?? []) {
          if (typeof evidence.ref !== 'string') continue
          const parsed = parseWorkflowSkillReleaseRef(evidence.ref)
          if (parsed !== undefined && parsed.skillId === skillId) return parsed.version
        }
      }
      return undefined
    })()
    /*
     * 版本解析顺序（2026-10-28 独立复核指出后修）：
     *   ① **加载回执里的精确版本** —— "这一轮真的加载了哪一版"；
     *   ② **持久层当前版本**（`isCurrent`）—— 发布/回退后生效的那一版；
     *   ③ 资产登记种子 —— **只在持久层读不到时**兜底（与加载判定同一条纪律）。
     * ⚠️ 原来缺 ②：发布 v2 后若某轮加载失败（没有回执引用），使用记录会记到 v1 上，
     *    把"用错了版本"这件事记成事实。
     */
    const states = await input.store.readStates(skillId)
    const storeCurrentVersion = states.find((state) => state.isCurrent)?.version
    const loadedRelease = receiptVersion !== undefined
      ? loadedReleaseOf(input.loaded, skillId, receiptVersion)
      : storeCurrentVersion !== undefined
        ? loadedReleaseOf(input.loaded, skillId, storeCurrentVersion)
        : currentLoadedRelease(input.loaded, skillId)
    if (loadedRelease === undefined) continue

    const stateOfVersion: WorkflowSkillPublishedState | undefined =
      states.find((state) => state.version === loadedRelease.release.version)
    const outcome = input.outcomes?.[skillId] ?? derived.outcome
    const stopReason = input.outcomes?.[skillId] !== undefined ? input.stopReason : (input.stopReason ?? derived.stopReason)
    const taskId = derived.taskId

    const record = deriveWorkflowSkillUsageRecord({
      characterId: input.characterId,
      traceId: input.traceId,
      ...(taskId !== undefined ? { taskId } : {}),
      skillId,
      release: loadedRelease.release,
      managed: true,
      actionResults: input.actionResults,
      packet: packetView,
      outcome,
      stateAtCommit: stateOfVersion?.state ?? 'unavailable',
      ...(input.libraryRoots !== undefined ? { maxReadBoundaryRoots: input.libraryRoots } : {}),
      ...(input.instructionWithheldReasons?.[skillId] !== undefined
        ? { instructionWithheldReason: input.instructionWithheldReasons[skillId] }
        : {}),
      ...(stopReason !== undefined ? { stopReason } : {}),
      createdAt: input.now,
    })
    await input.store.appendUsage(record)
    records.push(record)
  }
  return records
}
