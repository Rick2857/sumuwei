/**
 * M11 **反思投影**（ADR-085 §4.3 · `D11` · `D18`）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 把五条反思事件折叠成**当前记录**（`ReflectionRecordState`）。
 * 与 `goal.ts` / `belief.ts` 的折叠层逐字同构：
 *
 * ```text
 * · **纯**：不读时钟、不查库、不调模型；同一个事件序列折叠两次结果逐字段一致（D18）
 * · **只前进**：非法边（例如 rejected → accepted）**不**折叠，也不会抛 ——
 *   非法边的拒绝发生在放行口（`policies/reflection-validator.ts`），
 *   折叠层只忠实重放**已经被接受过**的事件
 * · **不覆盖历史**：失效是 `retracted` 状态 + 事件留痕，不删记录（INV-CI-05）
 * ```
 */

import type { DomainEvent } from '../contracts/domain-event.ts'
import {
  ADAPTIVE_SELF_REVISED,
  REFLECTION_INVALIDATED,
  REFLECTION_ORIGIN,
  REFLECTION_PROPOSED,
  REFLECTION_RECORD_SCHEMA_VERSION,
  REFLECTION_REVIEWED,
  reflectionTransitionAllowed,
  type AdaptiveSelfRevisedPayload,
  type ReflectionInvalidatedPayload,
  type ReflectionOriginPayload,
  type ReflectionProposedPayload,
  type ReflectionRecordState,
  type ReflectionReviewedPayload,
} from '../contracts/reflection-events.ts'
import type { CharacterProjection } from '../contracts/projection.ts'
import type { DomainEventId } from '../contracts/ids.ts'

/** 折叠器版本（写进投影行；升版本 = 需要重放） */
export const REFLECTION_REDUCER_VERSION = 'reflection-fold@1'

/** 反思域的投影类型前缀（一条记录一行） */
export const REFLECTION_RECORD_PROJECTION_PREFIX = 'reflection:'

export function reflectionRecordProjectionTypeOf(reflectionId: string): string {
  return `${REFLECTION_RECORD_PROJECTION_PREFIX}${reflectionId}`
}

/** 本折叠器处理的事件类型（**只**处理这些） */
export const REFLECTION_HANDLED_EVENT_TYPES: readonly string[] = [
  REFLECTION_PROPOSED,
  REFLECTION_REVIEWED,
  REFLECTION_INVALIDATED,
]

/** 投影行 state 的容器（与目标域 `GoalRowState` 同一形状：一行一条记录） */
export interface ReflectionRowState {
  readonly record: ReflectionRecordState
}

export interface ReflectionRowCacheEntry {
  readonly projectionType: string
  revision: number
  state: ReflectionRowState
  lastDomainEventId?: DomainEventId
  lastDomainEventSequence?: number
  changed: boolean
}

/** 一条事件的 payload 是否是本域关心的形状（宽容读：形状不对就**不折**，不抛） */
function payloadOf<T>(event: DomainEvent): T | undefined {
  const payload = (event as { payload?: unknown }).payload
  if (typeof payload !== 'object' || payload === null) return undefined
  return payload as T
}

/**
 * 折叠一批事件（**就地**改 cache）。
 *
 * `origin` 事件不产生记录行（它是**首次建立**的边界标记，只有一个 cutover 读数）；
 * 它由调用方在别处消费（激活/存档），因此这里显式跳过并留下注释。
 */
export function foldReflectionRows(
  cache: Map<string, ReflectionRowCacheEntry>,
  events: readonly DomainEvent[]
): void {
  for (const event of events) {
    const type = String(event.type)

    if (type === REFLECTION_ORIGIN) {
      /*
       * ⚠️ 刻意**不**建记录行：`REFLECTION_ORIGIN` 表达的是"从哪个序号起开始看"，
       *    它是 cutover 载体（D33），不是某条反思的状态。把它折成记录行会让
       *    "有几条反思"这个读数永远至少是 1。
       */
      const origin = payloadOf<ReflectionOriginPayload>(event)
      if (origin === undefined) continue
      continue
    }

    if (type === ADAPTIVE_SELF_REVISED) {
      // WP5 的槽位状态**不在**本投影里（它有自己的一行：`adaptive-self:<slot>`）
      const _ignored = payloadOf<AdaptiveSelfRevisedPayload>(event)
      void _ignored
      continue
    }

    if (type === REFLECTION_PROPOSED) {
      const payload = payloadOf<ReflectionProposedPayload>(event)
      if (payload === undefined) continue
      const key = reflectionRecordProjectionTypeOf(String(payload.reflectionId))
      const existing = cache.get(key)
      if (existing !== undefined) continue // 同一记录不许二次提案（非法边由放行口挡）
      cache.set(key, {
        projectionType: key,
        revision: 1,
        state: {
          record: {
            reflectionId: String(payload.reflectionId),
            schemaVersion: REFLECTION_RECORD_SCHEMA_VERSION,
            status: 'pending',
            focusQuestion: String(payload.focusQuestion),
            explanation: String(payload.explanation),
            supportHandles: [...payload.supportHandles],
            counterHandles: [...payload.counterHandles],
            scope: String(payload.scope),
            ...(payload.suggestedSlot === undefined ? {} : { suggestedSlot: payload.suggestedSlot }),
            ...(payload.revisionIntent === undefined ? {} : { revisionIntent: payload.revisionIntent }),
            roots: [...payload.roots],
            rootCount: payload.rootCount,
            conversationCount: payload.conversationCount,
            reviewReasons: [],
            generatedBy: {
              modelVersion: String(payload.modelVersion),
              promptVersion: String(payload.promptVersion),
              inputWindowFingerprint: String(payload.inputWindowFingerprint),
            },
            lifecycleEventIds: [String(event.id)],
          },
        },
        lastDomainEventId: event.id,
        lastDomainEventSequence: event.sequence,
        changed: true,
      })
      continue
    }

    if (type === REFLECTION_REVIEWED) {
      const payload = payloadOf<ReflectionReviewedPayload>(event)
      if (payload === undefined) continue
      const key = reflectionRecordProjectionTypeOf(String(payload.reflectionId))
      const entry = cache.get(key)
      if (entry === undefined) continue // 孤儿审查：没有候选就不该有结论
      const next = payload.decision === 'accepted' ? 'accepted' : 'rejected'
      if (!reflectionTransitionAllowed(entry.state.record.status, next)) continue
      entry.state = {
        record: {
          ...entry.state.record,
          status: next,
          reviewReasons: [...payload.reasons],
          lifecycleEventIds: [...entry.state.record.lifecycleEventIds, String(event.id)],
          lastEventAt: event.createdAt,
        },
      }
      entry.revision += 1
      entry.lastDomainEventId = event.id
      entry.lastDomainEventSequence = event.sequence
      entry.changed = true
      continue
    }

    if (type === REFLECTION_INVALIDATED) {
      const payload = payloadOf<ReflectionInvalidatedPayload>(event)
      if (payload === undefined) continue
      const key = reflectionRecordProjectionTypeOf(String(payload.reflectionId))
      const entry = cache.get(key)
      if (entry === undefined) continue
      if (!reflectionTransitionAllowed(entry.state.record.status, 'retracted')) continue
      entry.state = {
        record: {
          ...entry.state.record,
          status: 'retracted',
          reviewReasons: [...entry.state.record.reviewReasons, payload.cause],
          lifecycleEventIds: [...entry.state.record.lifecycleEventIds, String(event.id)],
          lastEventAt: event.createdAt,
        },
      }
      entry.revision += 1
      entry.lastDomainEventId = event.id
      entry.lastDomainEventSequence = event.sequence
      entry.changed = true
    }
  }
}

/** 从投影行还原记录（供 store 与门复用） */
export function recordOfProjection(row: CharacterProjection<unknown>): ReflectionRecordState | undefined {
  const state = row.state as ReflectionRowState | undefined
  return state?.record
}
