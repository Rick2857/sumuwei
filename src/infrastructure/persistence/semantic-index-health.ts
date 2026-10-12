/**
 * M9.5 **启用计划 / WP5**（其余）—— 派生索引的**健康读回**（只读）。
 *
 * ```text
 * 为什么需要它：WP7 的运维者（以及任何"索引到底怎么样"的问题）需要的**不是**一句
 * "PASS"，而是可核对的**硬数字**：哪些代、各代状态、计数、覆盖是否完整、
 * 有没有**落后于源**的条目、已发布代的指纹是否还与冻结清单一致。
 * ⇒ 本模块只**读**，给出一份结构化读数；它**不修**任何东西（修是 WP2/WP3 的事）。
 * ```
 *
 * ⚠️ **只读**：全 `select`；不写、不建表、不打开别的库（调用方决定在哪个库上问）。
 * ⚠️ **它不主张召回质量**：健康 ≠ 有用（见 `TD-22` 末段：收益受记忆体量限制）。
 */

import { sql } from 'drizzle-orm'

import type { RawDb } from './db.ts'
import { rowsOf } from './db.ts'

export interface GenerationHealth {
  readonly generationId: string
  readonly buildState: string
  readonly modelFingerprint: string
  readonly rendererVersion: string
  readonly processedWatermark: number
  readonly eligible: number
  readonly indexed: number
  readonly pending: number
  readonly failed: number
  readonly excludedByPolicy: number
  /** 覆盖完整 = `pending = 0` **且** `failed = 0`（**不是** `indexed == eligible`） */
  readonly coverageComplete: boolean
}

export interface IndexHealth {
  readonly namespace: string
  readonly generations: readonly GenerationHealth[]
  /** 已发布代的 id（`null` = 一个都没有 ⇒ 探针会逐轮 `not_indexed`） */
  readonly publishedGenerationId: string | null
  /**
   * **落后于源**的条目数：索引里有行、但源已经走到更新的 revision（或源行已消失）。
   *
   * ⚠️ 这个数**不是**"错误"：它正是 **WP3 失效传播**要处理的队列。> 0 表示
   * "该跑一次 `reconcileSemanticIndex()` 了"。
   */
  readonly staleOrOrphaned: number
  /** 已发布代的指纹（用于与冻结清单比对）；无已发布代时为 `null` */
  readonly publishedFingerprint: string | null
  readonly publishedRendererVersion: string | null
}

export async function readSemanticIndexHealth(db: RawDb, namespace: string): Promise<IndexHealth> {
  const generations = rowsOf(
    await db.execute(sql`
      select generation_id, build_state, model_fingerprint, renderer_version, processed_watermark,
             eligible_source_count, pending_count, failed_count, excluded_by_policy_count
        from memory_semantic_generations
       where namespace = ${namespace}
       order by created_at asc, generation_id asc`)
  ).map((raw) => {
    const row = raw as Record<string, unknown>
    const pending = Number(row.pending_count)
    const failed = Number(row.failed_count)
    return {
      generationId: String(row.generation_id),
      buildState: String(row.build_state),
      modelFingerprint: String(row.model_fingerprint),
      rendererVersion: String(row.renderer_version),
      processedWatermark: Number(row.processed_watermark),
      eligible: Number(row.eligible_source_count),
      indexed: 0,
      pending,
      failed,
      excludedByPolicy: Number(row.excluded_by_policy_count),
      coverageComplete: pending === 0 && failed === 0,
    } satisfies GenerationHealth
  })

  /* 逐代的行数（`memory_semantic_index` 里没有计数列 ⇒ 现算） */
  const counts = rowsOf(
    await db.execute(sql`
      select generation_id, count(*)::int as c from memory_semantic_index
       where namespace = ${namespace} group by generation_id`)
  ).map((raw) => {
    const row = raw as Record<string, unknown>
    return { generationId: String(row.generation_id), count: Number(row.c) }
  })
  const byGeneration = new Map(counts.map((entry) => [entry.generationId, entry.count]))
  const withCounts = generations.map((generation) => ({
    ...generation,
    indexed: byGeneration.get(generation.generationId) ?? 0,
  }))

  const published = withCounts.find((generation) => generation.buildState === 'published') ?? null

  /*
   * 落后/孤儿：索引里每个 (memory_id, 该代最大 revision) 与源的当前 revision 比。
   * 源行没了 ⇒ 也算（那是孤儿行）。
   */
  const stale = rowsOf(
    await db.execute(sql`
      select i.memory_id, max(i.source_revision)::int as indexed_revision,
             r.revision as live_revision
        from memory_semantic_index i
        left join memory_records r on r.id = i.memory_id
       where i.namespace = ${namespace}
       group by i.memory_id, r.revision`)
  ).filter((raw) => {
    const row = raw as Record<string, unknown>
    if (row.live_revision === null || row.live_revision === undefined) return true
    return Number(row.live_revision) > Number(row.indexed_revision)
  })

  return {
    namespace,
    generations: withCounts,
    publishedGenerationId: published?.generationId ?? null,
    staleOrOrphaned: stale.length,
    publishedFingerprint: published?.modelFingerprint ?? null,
    publishedRendererVersion: published?.rendererVersion ?? null,
  }
}
