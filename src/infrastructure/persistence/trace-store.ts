/**
 * Trace / Receipt 的持久化。
 *
 * ============================================================================
 *  这是**业务数据**，不是遥测导出
 * ============================================================================
 * 即使 Phoenix 从未接入、即使观测后端整晚离线，这张表也必须完整——
 * 因为它是"刚才究竟发生了什么"的唯一权威记录。
 *
 * 反过来说：本表只存 **id 与元数据**，不存对话正文、不存完整 Prompt、
 * 不存任何密钥（plan 第 45 节）。要看正文就去 ConversationEvent，
 * 要看 Prompt 形状就看 section id 列表 —— 这已经足够定位问题。
 */

import { sql } from 'drizzle-orm'

import {
  KernelError,
  type CharacterId,
  type CharacterRunTrace,
  type DomainEventId,
  type JobId,
  type TraceId,
  type TraceStatus,
  type TraceStep,
  asCharacterId,
  asConversationEventId,
  asDomainEventId,
  asJobId,
  asTraceId,
} from '../../kernel/contracts/index.ts'
import type { TraceWriter } from '../../kernel/contracts/index.ts'
import { affectedRows, asRows, exec, firstRow, type RawDb } from './db.ts'

interface TraceRow {
  trace_id: string
  character_id: string
  input_event_id: string
  context_compiler_version: string | null
  context_section_ids: unknown
  dropped_section_ids: unknown
  source_conversation_event_ids: unknown
  selected_memory_ids: unknown
  projection_revisions_start: unknown
  projection_revisions_end: unknown
  domain_event_ids: unknown
  model_profile: string | null
  output_event_id: string | null
  post_turn_job_ids: unknown
  processor_versions: unknown
  steps: unknown
  status: string
  error: string | null
  started_at: number
  finished_at: number | null
  // --- M3（迁移 0003）：身份快照与参与者 --------------------------------
  seed_version?: number | null
  seed_hash?: string | null
  runtime_id?: string | null
  user_id?: string | null
  conversation_id?: string | null
  identity_source_refs?: unknown
  // --- M3.5（迁移 0004）：感知与意图的语义槽。旧行为 null -----------------
  observation_id?: string | null
  observation_type?: string | null
  intent_id?: string | null
  intent_type?: string | null
  // --- M4.5（迁移 0006）：这一轮她做了什么（ADR-034）---------------------
  action_ids?: unknown
}

const strArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])
const numRecord = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = Number(v)
  return out
}
const strRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = String(v)
  return out
}

function rowToTrace(row: TraceRow | undefined): CharacterRunTrace | undefined {
  if (!row) return undefined
  return {
    traceId: asTraceId(String(row.trace_id)),
    characterId: asCharacterId(String(row.character_id)),
    inputEventId: asConversationEventId(String(row.input_event_id)),
    contextCompilerVersion: row.context_compiler_version ?? undefined,
    contextSectionIds: strArray(row.context_section_ids),
    droppedSectionIds: strArray(row.dropped_section_ids),
    sourceConversationEventIds: strArray(row.source_conversation_event_ids),
    selectedMemoryIds: strArray(row.selected_memory_ids),
    projectionRevisionsAtStart: numRecord(row.projection_revisions_start),
    projectionRevisionsAtEnd: numRecord(row.projection_revisions_end),
    domainEventIds: strArray(row.domain_event_ids).map((id) => asDomainEventId(id)),
    modelProfile: row.model_profile ?? undefined,
    outputEventId: row.output_event_id
      ? asConversationEventId(String(row.output_event_id))
      : undefined,
    postTurnJobIds: strArray(row.post_turn_job_ids).map((id) => asJobId(id)),
    processorVersions: strRecord(row.processor_versions),
    steps: Array.isArray(row.steps) ? (row.steps as TraceStep[]) : [],
    status: String(row.status) as TraceStatus,
    error: row.error ?? undefined,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at ?? undefined,
    // --- M3：身份快照与参与者（旧行这些列为 null）------------------------
    ...(row.seed_version === null || row.seed_version === undefined
      ? {}
      : { seedVersion: Number(row.seed_version) }),
    ...(row.seed_hash ? { seedHash: String(row.seed_hash) } : {}),
    ...(row.runtime_id ? { runtimeId: String(row.runtime_id) } : {}),
    ...(row.user_id ? { userId: String(row.user_id) } : {}),
    ...(row.conversation_id ? { conversationId: String(row.conversation_id) } : {}),
    identitySourceRefs: strArray(row.identity_source_refs),
    // --- M3.5：感知与意图（合成轮次下这些列为 null → undefined）-----------
    ...(row.observation_id ? { observationId: String(row.observation_id) } : {}),
    ...(row.observation_type ? { observationType: String(row.observation_type) } : {}),
    ...(row.intent_id ? { intentId: String(row.intent_id) } : {}),
    ...(row.intent_type ? { intentType: String(row.intent_type) } : {}),
    // --- M4.5：动作（旧行 → 空数组，而不是 undefined）---------------------
    actionIds: strArray(row.action_ids),
  }
}

export function createTraceWriter(db: RawDb): TraceWriter {
  return {
    async start(trace: CharacterRunTrace): Promise<void> {
      await exec(
        db,
        sql`insert into character_traces
              (trace_id, character_id, input_event_id, context_compiler_version,
               context_section_ids, dropped_section_ids, source_conversation_event_ids,
               selected_memory_ids, projection_revisions_start, projection_revisions_end,
               domain_event_ids, model_profile, output_event_id, post_turn_job_ids,
               processor_versions, steps, status, error, started_at, finished_at,
               seed_version, seed_hash, runtime_id, user_id, conversation_id, identity_source_refs,
               observation_id, observation_type, intent_id, intent_type, action_ids)
            values (${trace.traceId}, ${trace.characterId}, ${trace.inputEventId},
                    ${trace.contextCompilerVersion ?? null},
                    ${JSON.stringify(trace.contextSectionIds)}::jsonb,
                    ${JSON.stringify(trace.droppedSectionIds)}::jsonb,
                    ${JSON.stringify(trace.sourceConversationEventIds)}::jsonb,
                    ${JSON.stringify(trace.selectedMemoryIds)}::jsonb,
                    ${JSON.stringify(trace.projectionRevisionsAtStart)}::jsonb,
                    ${JSON.stringify(trace.projectionRevisionsAtEnd)}::jsonb,
                    ${JSON.stringify(trace.domainEventIds)}::jsonb,
                    ${trace.modelProfile ?? null},
                    ${trace.outputEventId ?? null},
                    ${JSON.stringify(trace.postTurnJobIds)}::jsonb,
                    ${JSON.stringify(trace.processorVersions)}::jsonb,
                    ${JSON.stringify(trace.steps)}::jsonb,
                    ${trace.status}, ${trace.error ?? null},
                    ${trace.startedAt}, ${trace.finishedAt ?? null},
                    ${trace.seedVersion ?? null}, ${trace.seedHash ?? null},
                    ${trace.runtimeId ?? null}, ${trace.userId ?? null},
                    ${trace.conversationId ?? null},
                    ${JSON.stringify(trace.identitySourceRefs ?? [])}::jsonb,
                    ${trace.observationId ?? null}, ${trace.observationType ?? null},
                    ${trace.intentId ?? null}, ${trace.intentType ?? null},
                    ${JSON.stringify(trace.actionIds ?? [])}::jsonb)
            returning trace_id`,
        '写入 Trace'
      )
    },

    async finish(traceId, patch): Promise<void> {
      const sets = []
      if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`)
      if (patch.finishedAt !== undefined) sets.push(sql`finished_at = ${patch.finishedAt}`)
      if (patch.outputEventId !== undefined) sets.push(sql`output_event_id = ${patch.outputEventId}`)
      if (patch.error !== undefined) sets.push(sql`error = ${patch.error}`)
      if (patch.modelProfile !== undefined) sets.push(sql`model_profile = ${patch.modelProfile}`)
      if (patch.contextCompilerVersion !== undefined)
        sets.push(sql`context_compiler_version = ${patch.contextCompilerVersion}`)
      if (patch.contextSectionIds !== undefined)
        sets.push(sql`context_section_ids = ${JSON.stringify(patch.contextSectionIds)}::jsonb`)
      if (patch.droppedSectionIds !== undefined)
        sets.push(sql`dropped_section_ids = ${JSON.stringify(patch.droppedSectionIds)}::jsonb`)
      if (patch.sourceConversationEventIds !== undefined)
        sets.push(
          sql`source_conversation_event_ids = ${JSON.stringify(patch.sourceConversationEventIds)}::jsonb`
        )
      if (patch.selectedMemoryIds !== undefined)
        sets.push(sql`selected_memory_ids = ${JSON.stringify(patch.selectedMemoryIds)}::jsonb`)
      if (patch.projectionRevisionsAtEnd !== undefined)
        sets.push(
          sql`projection_revisions_end = ${JSON.stringify(patch.projectionRevisionsAtEnd)}::jsonb`
        )
      if (patch.domainEventIds !== undefined)
        sets.push(sql`domain_event_ids = ${JSON.stringify(patch.domainEventIds)}::jsonb`)
      if (patch.postTurnJobIds !== undefined)
        sets.push(sql`post_turn_job_ids = ${JSON.stringify(patch.postTurnJobIds)}::jsonb`)
      if (patch.processorVersions !== undefined)
        sets.push(sql`processor_versions = ${JSON.stringify(patch.processorVersions)}::jsonb`)
      if (patch.steps !== undefined) sets.push(sql`steps = ${JSON.stringify(patch.steps)}::jsonb`)
      // --- M3：身份快照（计划书第 122 节：每一轮都必须能查到用了哪版人格）----
      if (patch.seedVersion !== undefined) sets.push(sql`seed_version = ${patch.seedVersion}`)
      if (patch.seedHash !== undefined) sets.push(sql`seed_hash = ${patch.seedHash}`)
      if (patch.runtimeId !== undefined) sets.push(sql`runtime_id = ${patch.runtimeId}`)
      if (patch.userId !== undefined) sets.push(sql`user_id = ${patch.userId}`)
      if (patch.conversationId !== undefined)
        sets.push(sql`conversation_id = ${patch.conversationId}`)
      if (patch.identitySourceRefs !== undefined)
        sets.push(sql`identity_source_refs = ${JSON.stringify(patch.identitySourceRefs)}::jsonb`)
      // --- M3.5：感知与意图（计划书第 89 节）--------------------------------
      // 只写 id 与类型，**不写 payload / 正文** —— trace 的隐私原则与 M2.5 一致。
      if (patch.observationId !== undefined) sets.push(sql`observation_id = ${patch.observationId}`)
      if (patch.observationType !== undefined)
        sets.push(sql`observation_type = ${patch.observationType}`)
      if (patch.intentId !== undefined) sets.push(sql`intent_id = ${patch.intentId}`)
      if (patch.intentType !== undefined) sets.push(sql`intent_type = ${patch.intentType}`)
      // --- M4.5：动作 id（只记 id，不记参数内容）----------------------------
      if (patch.actionIds !== undefined)
        sets.push(sql`action_ids = ${JSON.stringify(patch.actionIds)}::jsonb`)

      if (sets.length === 0) return

      const affected = await affectedRows(
        db,
        sql`update character_traces set ${sql.join(sets, sql`, `)}
            where trace_id = ${traceId} returning trace_id`,
        '更新 Trace'
      )
      if (affected === 0) {
        throw new KernelError(
          'persistence_error',
          'trace_not_found',
          `Trace ${traceId} 不存在，无法更新（start 是否成功？）`
        )
      }
    },

    async get(traceId: TraceId): Promise<CharacterRunTrace | undefined> {
      const rows = await exec(
        db,
        sql`select * from character_traces where trace_id = ${traceId} limit 1`,
        '读取 Trace'
      )
      return rowToTrace(firstRow<TraceRow>(rows))
    },

    async recent(characterId: CharacterId, limit = 20): Promise<CharacterRunTrace[]> {
      const rows = await exec(
        db,
        sql`select * from character_traces where character_id = ${characterId}
            order by started_at desc limit ${Math.max(1, Math.min(200, limit))}`,
        '读取最近 Trace'
      )
      return asRows<TraceRow>(rows).map((r) => rowToTrace(r)!)
    },
  }
}

/** 便于测试与 turn-gateway 使用：直接按 id 取一条 Trace */
export async function getTrace(
  db: RawDb,
  traceId: TraceId
): Promise<CharacterRunTrace | undefined> {
  const rows = await exec(
    db,
    sql`select * from character_traces where trace_id = ${traceId} limit 1`,
    '读取 Trace'
  )
  return rowToTrace(firstRow<TraceRow>(rows))
}

/** 便于测试：某角色的 trace 条数 */
export async function countTraces(db: RawDb, characterId: CharacterId): Promise<number> {
  const rows = await exec(
    db,
    sql`select count(*)::int as c from character_traces where character_id = ${characterId}`,
    '统计 Trace'
  )
  return Number(rows[0]?.c ?? 0)
}

// ---------------------------------------------------------------------------
// M5.1 WP2：**有界**的 trace 分页读取（只读、追加）
// ---------------------------------------------------------------------------

/**
 * keyset 游标：只取 `(started_at, trace_id)` **严格小于**它的行。
 *
 * 为什么不是 offset：`offset 10000` 要先读出前 10000 行再丢掉，
 * 于是"有界"只是句空话；而 keyset 每次只走索引上的一个位置。
 */
export interface TracePageCursorKey {
  startedAt: number
  id: string
}

export interface TracePageQuery {
  characterId: CharacterId
  /** 只回这些终态（过滤**在 SQL 里**发生，不是读回来再 filter） */
  status?: TraceStatus
  /** 本页上限（调用方负责按 `DEVELOPER_QUERY_LIMITS` 校验；这里再夹一次是第二道防线） */
  limit: number
  after?: TracePageCursorKey
}

export interface TracePageResult {
  rows: CharacterRunTrace[]
  /** 还有没有下一页。**必须**由 `limit + 1` 探测得出，不靠"条数正好等于 limit"猜 */
  hasMore: boolean
}

/**
 * 读一页 trace。
 *
 * ============================================================================
 *  为什么它是**追加**而不是改 `recent()`
 * ============================================================================
 * `recent()`（上面 :247）无 cursor、无过滤、上限 200，而 `--inspect` 正在用它。
 * 改它的语义会让一条既有只读路径跟着变；因此这里**另开一个函数**，
 * 复用的是同一份 `rowToTrace`（行 → 领域对象**只有一处实现**）。
 *
 * 排序键 `(started_at desc, trace_id desc)` 与既有索引
 * `character_traces_recent (character_id, started_at desc)`（`migrations.ts:224`）
 * 对齐；`trace_id` 只是**同毫秒内的稳定次序**，不让分页在并列时重复或跳过。
 *
 * ⚠️ 只读：只有 `select`。M5.1 的 G-03 要求 Query 面**不可能**写。
 */
export async function listTracePage(
  db: RawDb,
  query: TracePageQuery
): Promise<TracePageResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(query.limit)))
  const conditions = [sql`character_id = ${query.characterId}`]
  if (query.status !== undefined) conditions.push(sql`status = ${query.status}`)
  if (query.after !== undefined) {
    conditions.push(
      sql`(started_at < ${query.after.startedAt}
           or (started_at = ${query.after.startedAt} and trace_id < ${query.after.id}))`
    )
  }

  const rows = await exec(
    db,
    sql`select * from character_traces
        where ${sql.join(conditions, sql` and `)}
        order by started_at desc, trace_id desc
        limit ${limit + 1}`,
    '读取 Trace 分页'
  )
  const all = asRows<TraceRow>(rows).map((row) => rowToTrace(row)!)
  const hasMore = all.length > limit
  return { rows: hasMore ? all.slice(0, limit) : all, hasMore }
}


export type { CharacterRunTrace, DomainEventId, JobId }
