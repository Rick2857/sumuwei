/**
 * M11 WP8 —— **反思与行为策略的开发者面 DTO**（ADR-085 §6.1 · §6.3 · `D21`）。
 *
 * ============================================================================
 *  三条硬边界（照 M10 的 `goal/developer-face.ts`）
 * ============================================================================
 * ① **遮蔽写进类型**：被遮蔽的那一支**类型里就没有** `focusQuestion` / `explanation`
 *    —— 于是"漏遮蔽"是**编译错误**，不是一次代码评审的注意力问题。
 * ② **遮蔽判定复用唯一那一份**（`reflectionContentMustBeMasked()`）：本文件**不**重写
 *    "什么算被忘掉"。
 * ③ **能力登记表只登记实际生产者**：`DEVELOPER_REFLECTION_CAPABILITY_FACTS` 的
 *    `authority` 写明读面来自哪里；`FORBIDDEN_EXPORT_PATTERNS` 挡住"顺手导出写原语"。
 *
 * ⚠️ 纯函数：没有 SQL、没有 `node:*`、不读时钟。
 */

import type { ReflectionRecordState } from '../../contracts/reflection-events.ts'
import type { AdaptiveSelfState } from '../../contracts/adaptive-self.ts'
import type { RootUsabilityReading } from '../../contracts/revision-intent.ts'
import {
  reflectionContentMustBeMasked,
  type ReflectionMaskingReason,
} from './masking.ts'

/** 两类对象共有的**结构字段**（不含正文） */
export interface DeveloperReflectionStructuralFields {
  readonly rowKey: string
  readonly reflectionId: string
  readonly status: string
  readonly rootCount: number
  readonly conversationCount: number
  readonly reviewReasons: readonly string[]
  readonly lifecycleEventCount: number
  readonly modelVersion: string
  readonly promptVersion: string
}

export interface DeveloperReflectionMaskedDto extends DeveloperReflectionStructuralFields {
  readonly masked: true
  readonly maskingReason: ReflectionMaskingReason
  /** 命中的被禁根 id（`withdrawn_source` 时非空；**只有 id**） */
  readonly withdrawnRootIds: readonly string[]
  /*
   * ⚠️ 这里**刻意没有** focusQuestion / explanation：
   *    遮蔽意味着"整项退出普通查询"，而开发者面**也是**一条查询路径。
   */
}

export interface DeveloperReflectionVisibleDto extends DeveloperReflectionStructuralFields {
  readonly masked: false
  readonly focusQuestion: string
  readonly explanation: string
  readonly suggestedSlot?: string
  /** 跨域待审意图（**只有**域 / 目标 / 期望版本 —— 没有提案正文） */
  readonly revisionIntent?: {
    readonly domain: string
    readonly targetId: string
    readonly expectedRevision: number
  }
}

export type DeveloperReflectionDto =
  | DeveloperReflectionMaskedDto
  | DeveloperReflectionVisibleDto

export interface BuildDeveloperReflectionListInput {
  readonly records: readonly ReflectionRecordState[]
  readonly rootVerdicts: readonly RootUsabilityReading[]
  readonly limit?: number
}

export interface DeveloperReflectionList {
  readonly items: readonly DeveloperReflectionDto[]
  readonly excluded: readonly { readonly rowKey: string; readonly reason: string }[]
  readonly truncated: boolean
}

/** **唯一**入口：把记录变成开发者面 DTO 列表 */
export function buildDeveloperReflectionList(
  input: BuildDeveloperReflectionListInput
): DeveloperReflectionList {
  const limit = input.limit ?? 20
  const items: DeveloperReflectionDto[] = []
  const excluded: { rowKey: string; reason: string }[] = []
  let truncated = false

  for (const record of input.records) {
    const rowKey = `reflection:${record.reflectionId}`
    const masking = reflectionContentMustBeMasked({
      status: record.status,
      roots: record.roots,
      rootVerdicts: input.rootVerdicts,
    })
    const structural: DeveloperReflectionStructuralFields = {
      rowKey,
      reflectionId: record.reflectionId,
      status: record.status,
      rootCount: record.rootCount,
      conversationCount: record.conversationCount,
      reviewReasons: [...record.reviewReasons],
      lifecycleEventCount: record.lifecycleEventIds.length,
      modelVersion: record.generatedBy.modelVersion,
      promptVersion: record.generatedBy.promptVersion,
    }
    if (items.length >= limit) {
      truncated = true
      continue
    }
    if (masking.mask) {
      items.push({
        ...structural,
        masked: true,
        maskingReason: masking.reason,
        withdrawnRootIds: [...masking.hits],
      })
      excluded.push({ rowKey, reason: masking.reason })
      continue
    }
    items.push({
      ...structural,
      masked: false,
      focusQuestion: record.focusQuestion,
      explanation: record.explanation,
      ...(record.suggestedSlot === undefined ? {} : { suggestedSlot: String(record.suggestedSlot) }),
      ...(record.revisionIntent === undefined
        ? {}
        : {
            revisionIntent: {
              domain: String(record.revisionIntent.domain),
              targetId: String(record.revisionIntent.targetId),
              expectedRevision: record.revisionIntent.expectedRevision,
            },
          }),
    })
  }

  return { items, excluded, truncated }
}

// ---------------------------------------------------------------------------
// 行为策略（自适应自我）的开发者面
// ---------------------------------------------------------------------------

/**
 * 行为策略**没有正文**（正文只来自程序模板），因此这里只有一支形状 ——
 * 但**根被禁用**时仍然要如实标出来（`maskedRootIds`）。
 */
export interface DeveloperAdaptiveSelfDto {
  readonly slot: string
  readonly level: string
  readonly revision: number
  readonly scope: string
  readonly rootCount: number
  readonly changedReason: string
  readonly invalidatedReason?: string
  /** 被禁用的根（**只有 id**）；非空 ⇒ 这一项**当前不可用** */
  readonly maskedRootIds: readonly string[]
  /** 程序渲染的那一句话（**只**来自封闭模板，不是模型输出） */
  readonly renderedLine: string
}

export function buildDeveloperAdaptiveSelfList(input: {
  readonly states: readonly AdaptiveSelfState[]
  readonly rootVerdicts: readonly RootUsabilityReading[]
  readonly renderLine: (slot: AdaptiveSelfState['slot']) => string
}): readonly DeveloperAdaptiveSelfDto[] {
  const byId = new Map(input.rootVerdicts.map((reading) => [reading.rootId, reading]))
  return input.states.map((state) => ({
    slot: String(state.slot),
    level: String(state.level),
    revision: state.revision,
    scope: String(state.scope),
    rootCount: state.roots.length,
    changedReason: state.changedReason,
    ...(state.invalidatedReason === undefined ? {} : { invalidatedReason: state.invalidatedReason }),
    maskedRootIds: state.roots
      .filter((root) => {
        const reading = byId.get(root)
        return reading !== undefined && !reading.usable
      })
      .sort(),
    renderedLine: input.renderLine(state.slot),
  }))
}

// ---------------------------------------------------------------------------
// 能力登记表（**只登记实际生产者**）
// ---------------------------------------------------------------------------

export const DEVELOPER_REFLECTION_CAPABILITY_FACTS = {
  reflections: {
    id: 'reflections',
    kind: 'reflection' as const,
    authority:
      'character_projections（`reflection:<reflectionId>` 行）+ buildDeveloperReflectionList()；' +
      '遮蔽复用 app/reflection/masking.ts 的 reflectionContentMustBeMasked()',
    availability: 'AVAILABLE' as const,
  },
  adaptive_self: {
    id: 'adaptive_self',
    kind: 'adaptive_self' as const,
    authority:
      'character_projections（`adaptive-self:<slot>` 行）+ buildDeveloperAdaptiveSelfList()；' +
      '正文只由 context/adaptive-self-sections.ts 的封闭模板渲染',
    availability: 'AVAILABLE' as const,
  },
} as const

/**
 * 禁止导出的名字形状（挡住"顺手把写入口暴露到开发者面"）。
 *
 * ⚠️ 与 M10 同一条纪律：这不是"暂时没实现"，而是**禁止**。
 */
export const DEVELOPER_REFLECTION_FORBIDDEN_EXPORT_PATTERNS: readonly RegExp[] = [
  /^write/,
  /^create/,
  /^update/,
  /^delete/,
  /^accept/,
  /^reject/,
  /^retract/,
  /^invalidate/,
  /^revise/,
]
