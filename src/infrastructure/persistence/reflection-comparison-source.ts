/**
 * 三域应用方案 §4 —— **比较材料的取数适配**（只读）。
 *
 * ============================================================================
 *  它读两样东西
 * ============================================================================
 * ```text
 * originsOf     结局事件 + 它的**原始声明**事件
 *               （"当时预测什么" = 目标/承诺成立时的逐字声明 + 成功判据）
 * usabilityOf   这些来源现在还可用吗（遗忘 / 撤回 / 越权 / 不存在）
 * ```
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * ① **只读**：没有 insert / update / delete / 事务。
 * ② **比较材料不进反思窗口**：它有自己的取数面，**不**经 `ReflectionInputSource`
 *    ⇒ 比较**不会**变成 handle、不会变成根、不会触发反思（§4 的第一条边界）。
 * ③ **遗忘遮蔽先于注入**：来源被忘掉/撤回 ⇒ 整条比较作废（由内核装配层判）。
 *
 * ⚠️ SQL **只**出现在这里；内核那一侧是纯的（`kernel/app/reflection/outcome-comparison.ts`）。
 */

import { sql } from 'drizzle-orm'

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import {
  REFLECTION_OUTCOME_BY_EVENT_TYPE,
  renderCriterion,
  type ReflectionComparisonSource,
  type ReflectionOutcomeKind,
  type ReflectionOutcomeOrigin,
} from '../../kernel/app/reflection/outcome-comparison.ts'
import { exec, type RawDb } from './db.ts'
import { domainEventsFor } from './event-store.ts'
import { readReflectionSourceSnapshot } from './reflection-source-read.ts'

/** 结局事件类型 → 结局种类。 */
function outcomeKindOf(eventType: string): ReflectionOutcomeKind | undefined {
  if (eventType.startsWith('GOAL_')) return 'goal'
  if (eventType.startsWith('COMMITMENT_')) return 'commitment'
  return undefined
}

function literalList(ids: readonly string[]): string {
  return ids.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ')
}

interface OutcomeEventRow {
  readonly id: string
  readonly type: string
  readonly payload: unknown
  readonly created_at: unknown
}

interface OriginCandidate {
  readonly subjectId: string
  readonly statement: string
  readonly criterion: unknown
  readonly revision: number
  readonly sourceEventIds: readonly string[]
}

function readOrigin(
  payload: unknown,
  field: 'goal' | 'commitment'
): OriginCandidate | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const outer = payload as Record<string, unknown>
  const inner = outer[field]
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return undefined
  const state = inner as Record<string, unknown>
  const subjectId = state[field === 'goal' ? 'goalId' : 'commitmentId']
  const statement = state[field === 'goal' ? 'statement' : 'scope']
  if (typeof subjectId !== 'string' || subjectId === '') return undefined
  if (typeof statement !== 'string' || statement === '') return undefined
  const revision = state.revision
  const refs = state[field === 'goal' ? 'sourceRefs' : 'acceptanceRefs']
  const sourceEventIds: string[] = []
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) continue
      const id = (ref as Record<string, unknown>).conversationEventId
      if (typeof id === 'string' && id !== '') sourceEventIds.push(id)
    }
  }
  return {
    subjectId,
    statement,
    criterion: state[field === 'goal' ? 'successCriterion' : 'criterion'],
    revision: typeof revision === 'number' && Number.isInteger(revision) ? revision : 0,
    sourceEventIds,
  }
}

export function createReflectionComparisonSource(
  db: RawDb,
  options: { readonly characterId: CharacterId; readonly activeUserId?: string }
): ReflectionComparisonSource {
  const characterId = String(options.characterId)

  return {
    async originsOf(outcomeEventIds: readonly string[]): Promise<readonly ReflectionOutcomeOrigin[]> {
      if (outcomeEventIds.length === 0) return []
      const rows = await exec(
        db,
        sql.raw(
          `select id, type, payload, created_at from character_domain_events
             where character_id = '${characterId.replace(/'/g, "''")}'
               and id in (${literalList(outcomeEventIds)})`
        ),
        'M11 比较材料：读结局事件（只读）'
      )
      const outcomeRows = rows as unknown as OutcomeEventRow[]
      if (outcomeRows.length === 0) return []

      // 原始声明事件：目标与承诺各读一次（**按类型过滤**，不扫全量事件面）
      const goalOrigins = await domainEventsFor(db, options.characterId, { type: 'GOAL_CREATED' })
      const commitmentOrigins = await domainEventsFor(db, options.characterId, { type: 'COMMITMENT_ACCEPTED' })
      const goalById = new Map<string, OriginCandidate>()
      for (const event of goalOrigins) {
        const origin = readOrigin(event.payload, 'goal')
        if (origin !== undefined) goalById.set(origin.subjectId, origin)
      }
      const commitmentById = new Map<string, OriginCandidate>()
      for (const event of commitmentOrigins) {
        const origin = readOrigin(event.payload, 'commitment')
        if (origin !== undefined) commitmentById.set(origin.subjectId, origin)
      }

      const origins: ReflectionOutcomeOrigin[] = []
      for (const row of outcomeRows) {
        const kind = outcomeKindOf(String(row.type))
        const outcomeCode = REFLECTION_OUTCOME_BY_EVENT_TYPE[String(row.type)]
        if (kind === undefined || outcomeCode === undefined) continue
        const payload = row.payload
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue
        const subjectId = (payload as Record<string, unknown>)[kind === 'goal' ? 'goalId' : 'commitmentId']
        if (typeof subjectId !== 'string' || subjectId === '') continue
        const origin = kind === 'goal' ? goalById.get(subjectId) : commitmentById.get(subjectId)
        if (origin === undefined) continue
        const createdAt = Number(row.created_at)
        origins.push({
          outcomeEventId: String(row.id),
          kind,
          outcomeCode,
          subjectId: origin.subjectId,
          statement: origin.statement,
          ...(renderCriterion(origin.criterion) === undefined
            ? {}
            : { criterion: renderCriterion(origin.criterion) as string }),
          revision: origin.revision,
          occurredAt: Number.isFinite(createdAt) ? createdAt : 0,
          sourceEventIds: [...origin.sourceEventIds],
        })
      }
      return origins
    },

    async usabilityOf(sourceEventIds, checkOptions) {
      if (sourceEventIds.length === 0) return []
      // Reuse current provenance, scope, withdrawal and commit-lock checks.
      const snapshot = await readReflectionSourceSnapshot(db, options.characterId,
        sourceEventIds.map(id => ({ id, kind: 'conversation_event' as const })),
        { activeUserId: options.activeUserId, lock: checkOptions?.lock === true })
      return sourceEventIds.map(id => {
        const verdict = snapshot.sourceVerdicts.find(row => row.handleId === id)
        return { sourceEventId: id, usable: snapshot.usable && verdict?.usable === true,
          ...(snapshot.usable && verdict?.usable === true ? {} : { reason: 'source_unavailable' as const }) }
      })
    },
  }
}
