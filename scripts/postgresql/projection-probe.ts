/**
 * PostgreSQL 迁移 WP5：**投影与向量**的形状探针（只读，快）。
 *
 * ============================================================================
 *  它回答什么（`PG-G06` 的设计必须先看清这些）
 * ============================================================================
 * ```text
 *   · `character_projections` 里到底有**哪些** projection_type（各多少 revision）
 *     ⇒ 决定 `G06.1`（投影重建 A == B）要重建哪几种 reducer
 *   · `character_domain_events` 按 type 的计数 ⇒ 重建时"有没有事件可放"
 *   · `memory_semantic_index` 的**编码器指纹**（model_fingerprint / renderer_version /
 *     tokenizer_fingerprint / dtype / normalize / pooling / dimension）
 *     ⇒ `G06.5`（不重新编码凑一致）
 *   · **源侧的 vector 扩展版本** ⇒ `G06.2` 要"显式记录 0.8.0 → 0.8.7 的差异"
 * ```
 *
 * ⚠️ **隐私边界**：投影 `state` 与语义索引的正文**可能含私人内容** ⇒
 *    本探针只打印**计数、长度、指纹**，不打印正文；
 *    完整读数写进 `artifacts/post-lv2/local/`（**gitignore**）。
 *
 * 跑法：pnpm tsx scripts/postgresql/projection-probe.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { openPgliteSnapshot } from './pglite-reader.ts'

const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'

const OUT_FILE = resolve('artifacts/post-lv2/local/pg-migration/projection-shape.json')

async function main(): Promise<void> {
  const session = await openPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT })

  const extensions = await session.readTable('pg_catalog', 'pg_extension').catch(() => undefined)
  const vectorVersion =
    extensions === undefined
      ? '(读不到 pg_extension：readTable 只接受 public/migrations —— 见下)'
      : String((extensions.rows.find((row) => row.extname === 'vector') ?? {}).extversion ?? '(none)')

  const projections = await session.readTable('public', 'character_projections')
  const domainEvents = await session.readTable('public', 'character_domain_events')
  const semanticIndex = await session.readTable('public', 'memory_semantic_index')
  const semanticGenerations = await session.readTable('public', 'memory_semantic_generations')
  const semanticMeta = await session.readTable('public', 'memory_semantic_meta')

  const countBy = (rows: readonly Record<string, unknown>[], column: string): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const row of rows) {
      const key = String(row[column] ?? '(null)')
      out[key] = (out[key] ?? 0) + 1
    }
    return out
  }

  const projectionRows = projections.rows.map((row) => ({
    characterId: String(row.character_id),
    projectionType: String(row.projection_type),
    revision: Number(row.revision),
    reducerVersion: String(row.reducer_version ?? '(null)'),
    lastDomainEventSequence: row.last_domain_event_sequence === null ? null : Number(row.last_domain_event_sequence),
    updatedAt: String(row.updated_at ?? '(null)'),
    /** ⚠️ 只记**长度**与**键名**，不记正文 */
    stateBytes: JSON.stringify(row.state ?? null).length,
    stateKeys: row.state !== null && typeof row.state === 'object' ? Object.keys(row.state as object).sort() : [],
  }))

  const report = {
    source: SOURCE_SNAPSHOT,
    vectorVersion,
    projectionColumns: projections.columns,
    projections: projectionRows,
    domainEventTypes: countBy(domainEvents.rows, 'type'),
    domainEventCount: domainEvents.rows.length,
    semanticIndexColumns: semanticIndex.columns,
    semanticIndexRows: semanticIndex.rows.map((row) => ({
      namespace: String(row.namespace),
      memoryId: String(row.memory_id),
      sourceRevision: Number(row.source_revision),
      generationId: String(row.generation_id),
      modelFingerprint: String(row.model_fingerprint),
      rendererVersion: String(row.renderer_version),
      tokenizerFingerprint: String(row.tokenizer_fingerprint),
      pooling: String(row.pooling),
      normalize: row.normalize,
      dtype: String(row.dtype),
      dimension: Number(row.dimension),
      contentHash: String(row.content_hash),
      embeddingDims: (() => {
        const text = String(row.embedding ?? '')
        if (!text.startsWith('[')) return null
        return text.slice(1, -1).split(',').filter((x) => x !== '').length
      })(),
      embeddingBytes: String(row.embedding ?? '').length,
    })),
    semanticGenerations: semanticGenerations.rows.map((row) => ({
      generationId: String(row.generation_id),
      namespace: String(row.namespace ?? '(null)'),
      modelFingerprint: String(row.model_fingerprint ?? '(null)'),
      dimension: row.dimension === undefined ? null : Number(row.dimension),
      rowCount: Object.keys(row).length,
    })),
    semanticMeta: semanticMeta.rows.map((row) => ({ ...row })),
  }

  const attestation = await session.close()
  mkdirSync(resolve(OUT_FILE, '..'), { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify({ ...report, attestation }, null, 2), 'utf8')

  console.log(`vector 扩展版本（源）= ${vectorVersion}`)
  console.log(`character_projections 列 = ${projections.columns.map((c) => `${c.name}:${c.dataType}`).join(' | ')}`)
  console.log(`投影行数 = ${projectionRows.length}`)
  for (const row of projectionRows) {
    console.log(
      `  ${row.projectionType.padEnd(46)} rev=${String(row.revision).padStart(5)} ` +
        `reducer=${row.reducerVersion} seq=${row.lastDomainEventSequence} stateBytes=${row.stateBytes}`
    )
  }
  console.log(`domain_events = ${domainEvents.rows.length}`)
  console.log(`  按类型 = ${JSON.stringify(report.domainEventTypes)}`)
  console.log(`memory_semantic_index = ${report.semanticIndexRows.length} 行`)
  for (const row of report.semanticIndexRows) {
    console.log(
      `  ${row.memoryId} dim=${row.dimension} 实读维度=${row.embeddingDims} dtype=${row.dtype} ` +
        `pooling=${row.pooling} normalize=${row.normalize} model=${row.modelFingerprint.slice(0, 16)}…`
    )
  }
  console.log(`自证 = ${JSON.stringify(attestation)}`)
  console.log(`报告：${OUT_FILE}`)
}

await main()
