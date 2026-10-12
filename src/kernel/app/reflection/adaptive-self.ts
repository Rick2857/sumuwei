/**
 * M11 WP5 —— **有限自适应自我的纯策略**（ADR-085 `D09`–`D11` · `D32` · §4.6）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 * 一条**已采纳**的反思 ＋ 程序解析的根 ＋ 会话数 ＋ 冲突读数 ＋ 槽位请求
 *        ↓  纯函数
 * planAdaptiveSelfChange()  ⇒  revise（baseline↔enhanced）| no_change（具名原因）
 * ```
 *
 * ============================================================================
 *  四条硬边界
 * ============================================================================
 * ① **只有通过的反思能改行为**：`reflectionStatus !== 'accepted'` ⇒ `no_change`
 *    （"候选已生成"或"解释被采纳"都**不是**"行为变了" —— `D23` 的分列）。
 * ② **门槛先冻结**（`D10`）：≥3 个**去重后**的有效独立根 · ≥2 个会话 · 无未解决冲突。
 * ③ **重复根不增信**（`D05`）：同一个根出现两次仍算 1 个 —— 这里再挡一次
 *    （纵深防御：WP2 已经去重过，本层不假设上游一定对）。
 * ④ **越界一律拒**（`D09`）：Seed / 人格数值轴 / 闭集外的槽位各自有具名码。
 *
 * ⚠️ 纯逻辑：没有 SQL、没有 `node:*`、不调模型。
 */

import {
  ADAPTIVE_SELF_SCOPE,
  baselineAdaptiveSelfState,
  outOfScopeReasonOf,
  type AdaptiveSelfLevel,
  type AdaptiveSelfSlot,
  type AdaptiveSelfState,
} from '../../contracts/adaptive-self.ts'
import type { AdaptiveSelfRevisedPayload } from '../../contracts/reflection-events.ts'
import type { DomainEventId } from '../../contracts/ids.ts'
import { meetsStabilityThreshold } from './inputs.ts'

export const ADAPTIVE_SELF_POLICY_VERSION = 'adaptive-self-policy@1'

/** 规划输入（**全部**是程序事实；没有"模型说它可靠"的位置） */
export interface AdaptiveSelfPlanInput {
  readonly slot: AdaptiveSelfSlot
  readonly current: AdaptiveSelfState
  /** 支持的反思：必须**已采纳** */
  readonly reflections: readonly { readonly reflectionId: string; readonly status: string }[]
  /** **去重后**的原始根（WP2 的产物） */
  readonly roots: readonly string[]
  readonly conversationCount: number
  readonly unresolvedConflict: boolean
  /** 本次想去的档位 */
  readonly targetLevel: AdaptiveSelfLevel
  /** 总开关（`D19`：关闭时**不调整**） */
  readonly adaptiveEnabled: boolean
  /** 具名原因（写进事件；由调用方给，**不是**自由文本指令） */
  readonly reason: string
}

export type AdaptiveSelfPlanReason =
  | 'adaptive_disabled'
  | 'reflection_not_accepted'
  | 'threshold_not_met'
  | 'single_root_only'
  | 'single_session_only'
  | 'conflicting_support'
  | 'slot_out_of_scope'
  | 'seed_change_requested'
  | 'personality_axis_requested'
  | 'no_level_change'
  | 'revision_conflict'

export type AdaptiveSelfPlan =
  | {
      readonly kind: 'revise'
      readonly slot: AdaptiveSelfSlot
      readonly level: AdaptiveSelfLevel
      readonly revision: number
      readonly roots: readonly string[]
      readonly sourceReflections: readonly string[]
      readonly reason: string
      readonly scope: typeof ADAPTIVE_SELF_SCOPE
    }
  | { readonly kind: 'no_change'; readonly reason: AdaptiveSelfPlanReason; readonly detail: string }

function noChange(reason: AdaptiveSelfPlanReason, detail: string): AdaptiveSelfPlan {
  return { kind: 'no_change', reason, detail }
}

/**
 * 规划一次行为调整（**纯函数**；顺序先到先拒）。
 *
 * 顺序：开关 → 越界 → 反思状态 → 冲突 → 门槛（根/会话）→ 档位是否真的变。
 */
export function planAdaptiveSelfChange(input: AdaptiveSelfPlanInput): AdaptiveSelfPlan {
  if (!input.adaptiveEnabled) {
    return noChange('adaptive_disabled', '总开关关闭 ⇒ 不调整（关闭不删历史，只是不消费）')
  }

  const outOfScope = outOfScopeReasonOf({ requestedSlot: input.slot })
  if (outOfScope !== undefined) return noChange(outOfScope, `越界请求：${outOfScope}`)

  const accepted = input.reflections.filter((reflection) => reflection.status === 'accepted')
  if (accepted.length === 0) {
    return noChange(
      'reflection_not_accepted',
      '没有**已采纳**的反思 ⇒ 不调整（候选 ≠ 采纳 ≠ 行为变化）'
    )
  }

  // 纵深防御：本层自己再去重一次（不假设上游一定去重过）
  const dedupedRoots = [...new Set(input.roots)].filter((root) => root.trim() !== '')

  const stability = meetsStabilityThreshold({
    rootCount: dedupedRoots.length,
    conversationCount: input.conversationCount,
    unresolvedConflict: input.unresolvedConflict,
  })
  if (!stability.met) return noChange(stability.reason, stability.detail)

  if (input.current.level === input.targetLevel) {
    return noChange('no_level_change', `当前已经是 ${input.targetLevel} ⇒ 不产生新 revision`)
  }

  return {
    kind: 'revise',
    slot: input.slot,
    level: input.targetLevel,
    revision: input.current.revision + 1,
    roots: dedupedRoots,
    sourceReflections: accepted.map((reflection) => reflection.reflectionId),
    reason: input.reason,
    scope: ADAPTIVE_SELF_SCOPE,
  }
}

// ---------------------------------------------------------------------------
// 折叠（纯）
// ---------------------------------------------------------------------------

export interface AdaptiveSelfRowCacheEntry {
  readonly projectionType: string
  revision: number
  state: AdaptiveSelfState
  lastDomainEventId?: DomainEventId
  lastDomainEventSequence?: number
  changed: boolean
}

/** 折叠器版本（写进投影行；升版本 = 需要重放） */
export const ADAPTIVE_SELF_REDUCER_VERSION = 'adaptive-self-fold@1'

/**
 * 折叠一批 `ADAPTIVE_SELF_REVISED` 事件（**就地**改 cache）。
 *
 * ⚠️ 非法边（例如 revision 跳跃、槽位不匹配）**不折叠、也不抛** ——
 *    与反思折叠层同一条纪律：折叠层只忠实重放**已经被放行过**的事件。
 */
export function foldAdaptiveSelfRows(
  cache: Map<string, AdaptiveSelfRowCacheEntry>,
  events: readonly {
    type: string
    id: DomainEventId
    sequence: number
    createdAt: number
    payload?: unknown
  }[],
  projectionTypeOf: (slot: AdaptiveSelfSlot) => string
): void {
  for (const event of events) {
    if (String(event.type) !== 'ADAPTIVE_SELF_REVISED') continue
    const payload = event.payload as AdaptiveSelfRevisedPayload | undefined
    if (payload === undefined) continue
    const slot = payload.slot
    const key = projectionTypeOf(slot)
    const entry =
      cache.get(key) ??
      ({
        projectionType: key,
        revision: 0,
        state: baselineAdaptiveSelfState(slot),
        changed: false,
      } satisfies AdaptiveSelfRowCacheEntry)

    // 只接受**恰好 +1** 的版本（跳跃 = 非法边）
    if (payload.revision !== entry.state.revision + 1) continue

    const nextState: AdaptiveSelfState = {
      slot,
      level: payload.level,
      revision: payload.revision,
      scope: ADAPTIVE_SELF_SCOPE,
      sourceReflections: [...entry.state.sourceReflections],
      roots: [...payload.roots],
      changedReason: payload.reason,
      ...(payload.level === 'baseline'
        ? { invalidatedReason: payload.reason }
        : entry.state.invalidatedReason === undefined
          ? {}
          : { invalidatedReason: entry.state.invalidatedReason }),
      lastEventAt: event.createdAt,
    }

    cache.set(key, {
      ...entry,
      revision: entry.revision + 1,
      state: nextState,
      lastDomainEventId: event.id,
      lastDomainEventSequence: event.sequence,
      changed: true,
    })
  }
}
