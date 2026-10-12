/**
 * M10 WP7b —— **目标域的开发者只读面**（ADR-076 §6 · M5.1 的权威地图纪律 · M9 的 F-1 教训）。
 *
 * ============================================================================
 *  这个面存在的唯一理由
 * ============================================================================
 * 目标域有一整套内部结构（依赖三类、承诺、来源引用、禁用根、重放对账）。
 * 出问题时，"她为什么说没有这项目标"必须能被**查到**，而不是靠猜。
 *
 * ============================================================================
 *  三条硬性质
 * ============================================================================
 * ① **只读**：本文件与它的构造器**只有** `read*` / `build*` 这种形状，
 *    没有任何写入入口。开发者面**不是**第二条写路径（M5.1 的权威地图：
 *    `/dev/query/*` 只消费、只有两条受控命令）。
 *
 * ② **与聊天共用同一份遗忘资格**（M9 的 F-1 教训：呈现层不得成为泄漏面）：
 *    遮蔽判定**必须**调 `goalContentMustBeMasked()` —— **同一个函数**。
 *    本文件不重新实现它，也不接受"调用方已经过滤过"这种约定。
 *
 * ③ **遮蔽与内容在类型上互斥**：
 *    ```text
 *    masked: true   ⇒ 类型里**没有** statement / nextStep 这些内容字段
 *    masked: false  ⇒ 才有内容字段
 *    ```
 *    于是"遮蔽了但还是把正文带出去"是一个**类型错误**，而不是一次疏忽。
 *    ⚠️ 保留 `status` / `cancelReason` / 计数这类**结构性**字段：它们不是
 *    "被忘掉的取值"，而且"这项目标处于什么状态"正是排查最需要的事实。
 *    （`statement` 与 `nextStep` 才是内容 —— 它们是从用户原话来的。）
 *
 * ⚠️ 纯类型 + 纯函数：不 import SQL / 框架 / `node:*`。
 */

import {
  goalContentMustBeMasked,
  type GoalMaskingReason,
} from './invalidation.ts'
import type { GoalState } from '../../contracts/goal.ts'

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/** 两个分支共有的**结构性**字段（都**不是**从用户原话来的内容） */
interface DeveloperGoalStructuralFields {
  /** 投影行键（`goal:<goalId>`）—— 开发者面用它定位，不用正文 */
  readonly rowKey: string
  readonly goalId: string
  readonly status: string
  readonly priority: string
  readonly revision: number
  /** 来源事件 id（**只有 id**；它是"这项目标的依据是哪一轮"的可查形式） */
  readonly sourceEventIds: readonly string[]
  /** 依赖的三类计数（**只有计数**：三类依赖的处置不同，所以分开数） */
  readonly dependencyCounts: {
    readonly rootEvidence: number
    readonly necessaryPremise: number
    readonly optionalBackground: number
  }
}

export interface DeveloperGoalMaskedDto extends DeveloperGoalStructuralFields {
  readonly masked: true
  readonly maskingReason: GoalMaskingReason
  /** 命中的被撤来源事件 id（`withdrawn_source` 时非空；**只有 id**） */
  readonly withdrawnSourceEventIds: readonly string[]
  /*
   * ⚠️ 这里**刻意没有** statement / nextStep / successCriterion：
   *    遮蔽意味着"整项退出普通上下文与普通查询"，而开发者面**也是**一条查询路径。
   *    M9 的 F-1 泄漏正是从"开发者面比聊天少一道资格检查"开始的。
   */
}

export interface DeveloperGoalVisibleDto extends DeveloperGoalStructuralFields {
  readonly masked: false
  readonly statement: string
  readonly nextStep?: string
  /** 成功条件的 `kind`（**不含**参数值 —— 那可能带用户原话里的细节） */
  readonly successCriterionKind: string
}

export type DeveloperGoalDto = DeveloperGoalMaskedDto | DeveloperGoalVisibleDto

/** 查询形状（**只读**；与 `DeveloperPageRequest` 同构但不引它，避免跨文件耦合） */
export interface GoalsQuery {
  readonly characterId: string
  /** 可选的状态过滤（`active` / `paused` / …；缺省 = 全部**可见**的） */
  readonly status?: string
  readonly limit?: number
}

// ---------------------------------------------------------------------------
// 构造（**唯一**入口；遮蔽判定复用聊天那一个函数）
// ---------------------------------------------------------------------------

export interface BuildDeveloperGoalInput {
  readonly goal: GoalState
  /** **当前**撤销集（M9.1 的 `D16` 端口给出） */
  readonly withdrawnEventIds: ReadonlySet<string>
}

/**
 * 把一行目标变成开发者面 DTO。
 *
 * ⚠️ 遮蔽判定的**唯一**来源是 `goalContentMustBeMasked()`。本函数**不**再写一遍
 *    "什么算被忘掉" —— 两份判定迟早漂移，而漂移的那一侧就是泄漏的那一侧。
 */
export function buildDeveloperGoalDto(input: BuildDeveloperGoalInput): DeveloperGoalDto {
  const goal = input.goal
  const masking = goalContentMustBeMasked({
    goal,
    withdrawnEventIds: input.withdrawnEventIds,
  })
  const structural: DeveloperGoalStructuralFields = {
    rowKey: `goal:${String(goal.goalId)}`,
    goalId: String(goal.goalId),
    status: goal.status,
    priority: goal.priority,
    revision: goal.revision,
    sourceEventIds: goal.sourceRefs.map((ref) => String(ref.conversationEventId)),
    dependencyCounts: {
      rootEvidence: goal.dependencies.filter((d) => d.class === 'root_evidence').length,
      necessaryPremise: goal.dependencies.filter((d) => d.class === 'necessary_premise').length,
      optionalBackground: goal.dependencies.filter((d) => d.class === 'optional_background')
        .length,
    },
  }

  if (masking.mask) {
    return {
      ...structural,
      masked: true,
      maskingReason: masking.reason,
      withdrawnSourceEventIds: masking.hits,
    }
  }
  return {
    ...structural,
    masked: false,
    statement: goal.statement,
    ...(goal.nextStep !== undefined ? { nextStep: goal.nextStep } : {}),
    successCriterionKind: goal.successCriterion.kind,
  }
}

/**
 * 一次列表读取的结果。
 *
 * ⚠️ `excluded` **如实报出被排除的项与原因**（只有 id 与原因，没有内容）——
 *    "查不到"与"被排除了"必须分得开，否则排查时会把遮蔽误读成数据缺失。
 */
export interface DeveloperGoalListResult {
  readonly goals: readonly DeveloperGoalDto[]
  readonly excluded: readonly {
    readonly rowKey: string
    readonly reason: 'masked' | 'status_filter'
  }[]
  /** 因 `limit` 未返回的条数（如实报出，不静默截断） */
  readonly truncated: number
}

export function buildDeveloperGoalList(input: {
  readonly goals: readonly GoalState[]
  readonly withdrawnEventIds: ReadonlySet<string>
  readonly status?: string
  readonly limit?: number
}): DeveloperGoalListResult {
  const dtos: DeveloperGoalDto[] = []
  const excluded: { rowKey: string; reason: 'masked' | 'status_filter' }[] = []

  for (const goal of input.goals) {
    const dto = buildDeveloperGoalDto({ goal, withdrawnEventIds: input.withdrawnEventIds })
    /* 遮蔽的项**不进**列表本体，但**出现在 excluded 里**（可查，只是不含内容） */
    if (dto.masked) {
      excluded.push({ rowKey: dto.rowKey, reason: 'masked' })
      continue
    }
    if (input.status !== undefined && dto.status !== input.status) {
      excluded.push({ rowKey: dto.rowKey, reason: 'status_filter' })
      continue
    }
    dtos.push(dto)
  }

  const limit = input.limit ?? dtos.length
  const ordered = [...dtos].sort((a, b) => (a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0))
  return {
    goals: ordered.slice(0, Math.max(0, limit)),
    excluded,
    truncated: Math.max(0, ordered.length - Math.max(0, limit)),
  }
}

// ---------------------------------------------------------------------------
// 能力登记（沿用 `DEVELOPER_QUERY_CAPABILITY_FACTS` 的既有模式）
// ---------------------------------------------------------------------------

/** 目标域在开发者面登记的**读能力**（每一条都必须说清"谁产出的"） */
export const DEVELOPER_GOAL_CAPABILITY_FACTS = {
  goals: {
    id: 'goals',
    kind: 'goal' as const,
    authority:
      'character_projections（`goal:<goalId>` 行）+ buildDeveloperGoalList()；' +
      '遮蔽复用 kernel/app/goal/invalidation.ts 的 goalContentMustBeMasked()',
    availability: 'AVAILABLE' as const,
  },
} as const

/** 只读面**不许**出现的导出名（结构性检查用；见门 `D4`） */
export const DEVELOPER_GOAL_FORBIDDEN_EXPORT_PATTERNS: readonly RegExp[] = [
  /^write/,
  /^create/,
  /^update/,
  /^delete/,
  /^cancel/,
  /^accept/,
  /^fulfill/,
  /^pause/,
  /^resume/,
  /^forget/,
]
