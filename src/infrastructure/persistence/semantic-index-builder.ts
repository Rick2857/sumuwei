/**
 * M9.5 **启用计划 / WP2-B** —— 派生索引的**落盘侧**（编码 → 校验 → 落盘 → 水位 → 换代）。
 *
 * ```text
 *   ② 编码     注入的 encoder 端口（生产接 `createEncoderClient`；门接夹具）
 *   ③ 校验     `validateSemanticVector()` —— 零范数/非法值/维度不符 **一律不发布**
 *   ④ 落盘     `memory_semantic_index` 行（含 content_hash / renderer_version / 各指纹字段）
 *   ⑤ 水位     **复用** `planIndexMaintenance()`（纯函数；缺口之后仍写、终态仍挡水位）
 *   ⑥ 换代     `building` → 追平 ⇒ **原子切换**（同命名空间旧 `published` 置 `unavailable`）
 *   ⑦ 计数     eligible / indexed / pending / failed / excluded + `coverageComplete`（不完整就如实 false）
 *   ⑧ 失败关闭 维度 / schema 版本不符 **一律拒**（返回 `refused`，一个字节都不写）
 * ```
 *
 * ⚠️ **如实登记的一处未完成**：计划要的是"**持久游标**"，而本轮**没有**把它持久化
 * （`memory_semantic_generations` 没有游标列，而 `D-31` 定的是**零迁移**）⇒ 续跑靠
 * **水位**（规划器跳过 `seq <= processed_watermark`）—— 功能正确，但每轮会**重扫**一遍源。
 * 要真持久化得加列（新迁移）或另立存储 ⇒ 属**未完成**，不假装做到。
 *
 * ⚠️ 本模块**只**碰 SQL（`src/infrastructure/**` 是唯一允许的层）；渲染与政策来自 WP1，
 * 分页来自 WP2-A —— **都不在这里重写**。
 */

import { sql } from 'drizzle-orm'

import type { RawDb } from './db.ts'
import { rowsOf } from './db.ts'
import {
  SEMANTIC_INDEX_DIMENSION,
  SEMANTIC_INDEX_SCHEMA_VERSION,
  semanticIndexSchemaStatus,
  validateSemanticVector,
} from './memory-semantic-index.ts'
import {
  classifyIndexSources,
  enumerateIndexSources,
  type SourceCursor,
  type IndexSourceRow,
} from './semantic-index-source.ts'
import { renderMemoryForIndex } from '../../kernel/app/recall/index-render.ts'
import {
  planIndexMaintenance,
  type Attempt,
  type FailureRecord,
  type MaintenanceState,
  type SourceItem,
} from '../../kernel/app/recall/index-maintenance.ts'

export interface IndexEncoderPort {
  /** 模型指纹（列 `model_fingerprint`；与冻结清单的 `embeddingFingerprintOf()` 同源） */
  readonly modelFingerprint: string
  encode(texts: readonly string[]): Promise<
    | { readonly ok: true; readonly dimension: number; readonly vectors: readonly (readonly number[])[] }
    | { readonly ok: false; readonly reason: string }
  >
}

export interface BuildOptions {
  readonly db: RawDb
  readonly namespace: string
  readonly ownerKind: string
  readonly ownerId: string
  readonly generationId: string
  readonly rendererVersion: string
  readonly encoder: IndexEncoderPort
  readonly tokenizerFingerprint: string
  readonly pooling: string
  readonly normalize: boolean
  readonly dtype: string
  readonly dimension: number
  readonly now: () => number
  readonly pageLimit: number
  readonly budget: number
  readonly batchLimit: number
  readonly maxAttempts: number
  readonly integrityProblemsOf: (memoryId: string) => readonly string[]
  /**
   * **换代断电点注入**（`N4` 的判据用；照 `semantic-index-reconcile.ts` 的 `onAfterDeletes` 范式）。
   *
   * ⚠️ 它在"**旧代已降、新代未发**"之间被调用 ⇒ 抛异常即模拟 `N4` 断电 ⇒
   *    断言"**旧代仍是 published**"（那才证明事务回滚，而不是只证明代码里有 `transaction`）。
   * ⚠️ 只在**测试**里传；生产路径不传。
   */
  readonly onAfterSwapDemote?: () => Promise<void>
}

export interface BuildResult {
  readonly generationId: string
  readonly buildState: 'building' | 'published'
  /** 失败关闭：非 null ⇒ **一个字节都没写** */
  readonly refused: string | null
  readonly counts: {
    readonly eligible: number
    readonly indexed: number
    readonly pending: number
    readonly failed: number
    readonly excluded: number
  }
  readonly coverageComplete: boolean
  readonly watermark: number
  readonly gapAtSeq: number | null
  readonly writtenAboveGap: number
  readonly rowsWritten: number
}

/** 失败关闭的两条判据（维度 / schema 版本）—— 都**先于**任何写操作 */
async function preflight(db: RawDb, options: BuildOptions): Promise<string | null> {
  if (options.dimension !== SEMANTIC_INDEX_DIMENSION) {
    return `dimension_mismatch: 清单声明 ${String(options.dimension)}，列约束是 ${String(SEMANTIC_INDEX_DIMENSION)}`
  }
  const status = await semanticIndexSchemaStatus(db)
  if (status.recordedVersion !== SEMANTIC_INDEX_SCHEMA_VERSION) {
    return `schema_version_mismatch: 库记到 ${String(status.recordedVersion)}，代码认识 ${String(SEMANTIC_INDEX_SCHEMA_VERSION)}`
  }
  return null
}

/** 建（或确认）本代的行；`building` 是唯一入口状态 */
async function ensureGeneration(db: RawDb, options: BuildOptions): Promise<void> {
  await db.execute(sql`
    insert into memory_semantic_generations (
      generation_id, namespace, model_fingerprint, renderer_version, dimension,
      index_schema_version, build_state, created_at
    ) values (
      ${options.generationId}, ${options.namespace}, ${options.encoder.modelFingerprint},
      ${options.rendererVersion}, ${options.dimension}, ${SEMANTIC_INDEX_SCHEMA_VERSION},
      'building', ${options.now()}
    ) on conflict (generation_id) do nothing`)
}

async function readState(db: RawDb, options: BuildOptions): Promise<MaintenanceState> {
  const generation = rowsOf(
    await db.execute(sql`
      select processed_watermark, model_fingerprint, renderer_version, index_schema_version
        from memory_semantic_generations where generation_id = ${options.generationId}`)
  )[0] as Record<string, unknown> | undefined
  if (generation === undefined) {
    throw new Error(`本代不存在：${options.generationId}`)
  }
  /*
   * ⚠️ **换代拒混排**（计划 ⑥）：本代的行必须与**本代自己的**指纹/渲染器/schema 一致；
   * 不一致说明有人把两代的东西混在一起了 ⇒ 拒（不"顺手修一下"）。
   */
  if (
    String(generation.model_fingerprint) !== options.encoder.modelFingerprint ||
    String(generation.renderer_version) !== options.rendererVersion ||
    Number(generation.index_schema_version) !== SEMANTIC_INDEX_SCHEMA_VERSION
  ) {
    throw new Error(
      `generation_mismatch: 本代记的是 ${String(generation.model_fingerprint)}/${String(generation.renderer_version)}/` +
        `${String(generation.index_schema_version)}，而本次要写的是 ` +
        `${options.encoder.modelFingerprint}/${options.rendererVersion}/${String(SEMANTIC_INDEX_SCHEMA_VERSION)}`
    )
  }
  const failures = rowsOf(
    await db.execute(sql`
      select memory_id, reason, attempts from memory_semantic_failures
       where generation_id = ${options.generationId} order by memory_id asc`)
  ).map((raw) => {
    const row = raw as Record<string, unknown>
    return {
      memoryId: String(row.memory_id),
      seq: 0,
      reason: String(row.reason),
      attempts: Number(row.attempts),
      terminal: Number(row.attempts) >= options.maxAttempts,
    } satisfies FailureRecord
  })
  return {
    processedWatermark: Number(generation.processed_watermark),
    /* ⚠️ 失败行的 `seq` 不在表里（列只有 generation/memory/reason/attempts/last_attempt_at）
       ⇒ 从**本批枚举**里补（见 `plan()`），这里先给 0 占位（规划器只按 seq 排序，占位会被覆盖） */
    failures,
    generationId: options.generationId,
    modelFingerprint: options.encoder.modelFingerprint,
    indexSchemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
  }
}

/**
 * 跑一轮构建。
 *
 * ⚠️ **先 preflight 再写**（失败关闭）；**先写行再推水位**（顺序反了会出现"水位过了但行没写"）。
 */
export async function buildSemanticIndex(options: BuildOptions): Promise<BuildResult> {
  const db = options.db
  const refused = await preflight(db, options)
  if (refused !== null) {
    return {
      generationId: options.generationId,
      buildState: 'building',
      refused,
      counts: { eligible: 0, indexed: 0, pending: 0, failed: 0, excluded: 0 },
      coverageComplete: false,
      watermark: 0,
      gapAtSeq: null,
      writtenAboveGap: 0,
      rowsWritten: 0,
    }
  }

  await ensureGeneration(db, options)
  const state = await readState(db, options)

  /* ---- ① 枚举（WP2-A） + WP1 资格分列 ---- */
  /*
   * ⚠️ **持久游标续跑**（计划 §1 WP2 第 ① 条的读回一半，2026-10-01）：
   * 读回上一次枚举到的位置（`"<createdAt>:<id>"`），从那里接着走，而不是每轮从头扫。
   *
   * ⚠️ **脏值如实降级成 `null`（从头发起）并记日志** —— 不抛。
   *    否则"游标坏了"会表现为"每轮都从头扫"（看起来像性能问题），而没人知道为什么。
   */
  const cursorRow = rowsOf(
    await db.execute(
      sql`select source_cursor from memory_semantic_generations where generation_id = ${options.generationId}`
    )
  )[0] as Record<string, unknown> | undefined
  const rawCursor = cursorRow?.source_cursor === null || cursorRow?.source_cursor === undefined
    ? ''
    : String(cursorRow.source_cursor)
  const separator = rawCursor.indexOf(':')
  const after: SourceCursor | null =
    separator > 0 && Number.isFinite(Number(rawCursor.slice(0, separator)))
      ? { createdAt: Number(rawCursor.slice(0, separator)), id: rawCursor.slice(separator + 1) }
      : null
  if (rawCursor !== '' && after === null) {
    console.warn(`[m95-index] source_cursor 无法解析 ⇒ 如实从头发起：${rawCursor}`)
  }

  const enumerated = await enumerateIndexSources(db, {
    ownerKind: options.ownerKind,
    ownerId: options.ownerId,
    after,
    pageLimit: options.pageLimit,
    budget: options.budget,
  })
  const classified = classifyIndexSources(enumerated.rows, options.integrityProblemsOf)
  const eligible = classified.eligible

  /* ---- ②③ 渲染 → 编码 → 校验 ---- */
  const rendered: { row: IndexSourceRow; text: string; contentHash: string }[] = []
  const attempts: Attempt[] = []
  const vectors = new Map<string, readonly number[]>()
  for (const row of eligible) {
    const item: SourceItem = { seq: row.seq, memoryId: row.memoryId, sourceRevision: row.sourceRevision }
    const outcome = renderMemoryForIndex({
      status: row.status,
      content: {
        kind: row.contentKind,
        predicate: String((row.content as Record<string, unknown>)?.predicate ?? ''),
        value: (row.content as Record<string, unknown>)?.value,
        summary: (row.content as Record<string, unknown>)?.summary,
      },
    } as never)
    if (!outcome.ok) {
      attempts.push({ item, ok: false, reason: outcome.reason })
      continue
    }
    rendered.push({ row, text: outcome.rendered.text, contentHash: outcome.rendered.contentHash })
    attempts.push({ item, ok: true })
  }

  if (rendered.length > 0) {
    const encoded = await options.encoder.encode(rendered.map((entry) => entry.text))
    if (!encoded.ok) {
      for (const entry of rendered) {
        attempts[attempts.findIndex((a) => a.item.memoryId === entry.row.memoryId)] = {
          item: { seq: entry.row.seq, memoryId: entry.row.memoryId, sourceRevision: entry.row.sourceRevision },
          ok: false,
          reason: `encode_failed:${encoded.reason}`,
        }
      }
    } else if (encoded.dimension !== options.dimension) {
      for (const entry of rendered) {
        attempts[attempts.findIndex((a) => a.item.memoryId === entry.row.memoryId)] = {
          item: { seq: entry.row.seq, memoryId: entry.row.memoryId, sourceRevision: entry.row.sourceRevision },
          ok: false,
          reason: `dimension_mismatch:${String(encoded.dimension)}`,
        }
      }
    } else {
      rendered.forEach((entry, index) => {
        const vector = encoded.vectors[index]
        const problem = vector === undefined ? 'missing_vector' : validateSemanticVector(vector)
        if (problem !== null || vector === undefined) {
          attempts[attempts.findIndex((a) => a.item.memoryId === entry.row.memoryId)] = {
            item: { seq: entry.row.seq, memoryId: entry.row.memoryId, sourceRevision: entry.row.sourceRevision },
            ok: false,
            reason: `invalid_vector:${problem ?? 'missing'}`,
          }
          return
        }
        vectors.set(entry.row.memoryId, vector)
      })
    }
  }

  /* ---- ⑤ 水位（复用纯函数规划器） ---- */
  const plan = planIndexMaintenance({
    state,
    attempts,
    batchLimit: options.batchLimit,
    maxAttempts: options.maxAttempts,
    sourceTotal: eligible.length,
  })

  /* ---- ④ 落盘：行 → 失败 → 计数/水位（顺序不能反） ---- */
  let rowsWritten = 0
  const byId = new Map(rendered.map((entry) => [entry.row.memoryId, entry]))
  for (const item of plan.rowsToWrite) {
    const entry = byId.get(item.memoryId)
    const vector = vectors.get(item.memoryId)
    if (entry === undefined || vector === undefined) continue
    await db.execute(sql`
      insert into memory_semantic_index (
        namespace, memory_id, source_revision, generation_id, model_fingerprint, renderer_version,
        content_hash, tokenizer_fingerprint, pooling, normalize, dtype, dimension, embedding, created_at
      ) values (
        ${options.namespace}, ${item.memoryId}, ${item.sourceRevision}, ${options.generationId},
        ${options.encoder.modelFingerprint}, ${options.rendererVersion}, ${entry.contentHash},
        ${options.tokenizerFingerprint}, ${options.pooling}, ${options.normalize}, ${options.dtype},
        ${options.dimension}, ${JSON.stringify(vector)}::vector, ${options.now()}
      ) on conflict do nothing`)
    rowsWritten += 1
  }
  for (const failure of plan.failures) {
    await db.execute(sql`
      insert into memory_semantic_failures (generation_id, memory_id, reason, attempts, last_attempt_at)
      values (${options.generationId}, ${failure.memoryId}, ${failure.reason}, ${failure.attempts}, ${options.now()})
      on conflict (generation_id, memory_id) do update
        set reason = ${failure.reason}, attempts = ${failure.attempts}, last_attempt_at = ${options.now()}`)
  }

  const indexed = rowsOf(
    await db.execute(sql`
      select count(*)::int as c from memory_semantic_index
       where namespace = ${options.namespace} and generation_id = ${options.generationId}`)
  )[0] as { c?: number } | undefined
  const indexedCount = Number(indexed?.c ?? 0)
  const pendingCount = Math.max(0, eligible.length - indexedCount - plan.failedCount)

  /*
   * M9.5 —— **持久游标**（计划 §1 WP2 的第 ① 条）：把"本轮枚举到哪一行"记下来。
   *
   * ⚠️ 形状 = `"<createdAt>:<id>"`（与 `SourceCursor` 同源）。
   * ⚠️ 只有**真的枚举到了行**才写；空枚举（新库）保持原值（不把游标清成 null）。
   * ⚠️ **本轮只做"存"这一半**：读回并作为 `after` 续跑是下一步（那是行为变更，要有自己的判据）。
   */
  const lastRow = enumerated.rows[enumerated.rows.length - 1]
  const cursorText =
    lastRow === undefined ? null : `${String(lastRow.createdAt)}:${lastRow.memoryId}`

  await db.execute(sql`
    update memory_semantic_generations set
      processed_watermark = ${plan.nextWatermark},
      eligible_source_count = ${eligible.length},
      pending_count = ${pendingCount},
      failed_count = ${plan.failedCount},
      excluded_by_policy_count = ${classified.excluded.length},
      source_cursor = ${cursorText === null ? sql`source_cursor` : cursorText}
     where generation_id = ${options.generationId}`)

  /*
   * ⚠️ **一轮有界 ⇒ 覆盖不可能完整**（2026-10-01 实测发现的缺陷）：
   * `budget` 同时**限制了枚举**，于是"没枚举到的那部分"根本不在 `eligible` 里 ⇒
   * 规划器会如实算出 `coverageComplete = true`，而**源其实还没走完**。
   * 那正是用户裁定的"有工作上限的异步维护"最危险的形状：**每轮都自称完整**。
   * ⇒ 必须把"枚举是否走到源尾"（`enumerated.exhausted`）并入判定。
   */
  const coverageComplete = plan.coverageComplete && enumerated.exhausted

  /* ---- ⑥ 换代：**只有**覆盖完整才切换；切换时同命名空间的旧代置 unavailable ---- */
  let buildState: 'building' | 'published' = 'building'
  if (coverageComplete && indexedCount > 0) {
    /*
     * ⚠️ **必须是一个事务**（2026-10-01 修的真缺陷）：
     *
     * ```text
     * 原来是两条**独立**的 `db.execute`（先降旧代、再发新代），**没有事务** ——
     * 而文件头 `:9` 的注释却写着「⑥ 换代 … **原子切换**」⇒ **注释在说谎** ✗
     * ⇒ 崩在两条之间 ⇒ 命名空间里**一代 published 都没有** ⇒ 探针 `not_indexed`
     *    ⇒ **她突然什么都想不起来**，而索引行其实都在（可重建，但没人会知道要重建）✓ 这就是 `N4`。
     * ```
     * ⚠️ 顺序**保持**"先降旧、再发新" —— 正因如此 `N5`（两代同时 published）**结构上不可能** ✓
     *    （反过来的顺序会短暂出现两代 published ⇒ 探针可能读到旧代）。
     * ⚠️ 与 `semantic-index-reconcile.ts` 的写阶段同一个范式：`db.transaction` 存在就用它。
     */
    const swap = async (writer: RawDb): Promise<void> => {
      await writer.execute(sql`
        update memory_semantic_generations set build_state = 'unavailable'
         where namespace = ${options.namespace} and build_state = 'published'
           and generation_id <> ${options.generationId}`)
      /* ⚠️ **断电点注入**（`N4` 判据）：抛在这里 ⇒ 事务应回滚 ⇒ 旧代仍是 published */
      if (options.onAfterSwapDemote !== undefined) await options.onAfterSwapDemote()
      await writer.execute(sql`
        update memory_semantic_generations
           set build_state = 'published', published_at = ${options.now()}
         where generation_id = ${options.generationId}`)
    }
    if (typeof db.transaction === 'function') await db.transaction(swap)
    else await swap(db)
    buildState = 'published'
  }

  return {
    generationId: options.generationId,
    buildState,
    refused: null,
    counts: {
      eligible: eligible.length,
      indexed: indexedCount,
      pending: pendingCount,
      failed: plan.failedCount,
      excluded: classified.excluded.length,
    },
    coverageComplete,
    watermark: plan.nextWatermark,
    gapAtSeq: plan.gapAtSeq,
    writtenAboveGap: plan.writtenAboveGap,
    rowsWritten,
  }
}
