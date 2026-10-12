/**
 * M9.5 **启用计划 / WP3** —— 派生索引的**失效传播**（`N2`）。
 *
 * ============================================================================
 *  为什么它必须存在（两条，第二条是安全性质）
 * ============================================================================
 * ```text
 *  ① **取值改了**：`memory_records.revision` 一升，旧 revision 的行就是**过期**的
 *     （`memory_semantic_index` 的主键含 `source_revision` ⇒ 新 revision 是**新行**）
 *     ⇒ 旧行若留着，检索会拿到**两个版本**。
 *  ② **她忘掉了**：记忆被 `retracted`（或被取代 / 在审 / 归因链断）之后，
 *     它在索引里的行**必须消失** —— 否则语义通道会把一条"她已经忘掉的事"当成候选。
 *     ⚠️ 这是**遗忘的隐私边界**：只在投影层改状态、索引层留着向量，等于**没忘干净**。
 * ```
 *
 * ⚠️ **它不编码、不落盘新行**：那是 WP2 的事。本模块只做**减法** ——
 * 把"已经不该在索引里的行"删掉（按**当前**的资格读数，而不是按历史）。
 *
 * ⚠️ **幂等**：重复跑不会越删越多（第二次没有可删的）。**不碰**别的命名空间 / 别的代。
 */

import { sql } from 'drizzle-orm'

import type { RawDb } from './db.ts'
import { rowsOf } from './db.ts'
import { indexEligibility } from '../../kernel/app/recall/index-render.ts'

export interface ReconcileOptions {
  readonly db: RawDb
  readonly namespace: string
  readonly generationId: string
  /** 注入的完整性读数（与检索适配器同一个来源） */
  readonly integrityProblemsOf: (memoryId: string) => readonly string[]
  /**
   * ⚠️ **故障注入缝**（只给量具用）：在"删完行、还没更新计数"之间被调用。
   *
   * 它存在的理由：本模块的"删行 + 更新计数"是**两条语句**，而**崩溃在中间**这件事
   * 在门里原本**没有判据** —— 没有判据的改动只能"相信我"。有了这个缝，量具就能问出
   * "中间崩掉之后，计数是不是陈旧的"，从而把那条残留**量出来**（先量，再修）。
   */
  readonly onAfterDeletes?: () => Promise<void>
}

export interface ReconcileResult {
  /** 索引里出现过的不同 memory_id 数 */
  readonly scanned: number
  /** 因为**不再有资格**而被删掉的（她忘掉了 / 被取代 / 在审 / 链断 / 不可渲染） */
  readonly removedIneligible: number
  /** 因为**有新 revision** 而被删掉的过期行 */
  readonly removedStaleRevision: number
  /** 保留的行数 */
  readonly kept: number
  /** 被删的具名理由（可审计） */
  readonly removedByReason: Readonly<Record<string, number>>
}

export async function reconcileSemanticIndex(options: ReconcileOptions): Promise<ReconcileResult> {
  const db = options.db
  const indexed = rowsOf(
    await db.execute(sql`
      select memory_id, source_revision from memory_semantic_index
       where namespace = ${options.namespace} and generation_id = ${options.generationId}`)
  ).map((raw) => {
    const row = raw as Record<string, unknown>
    return { memoryId: String(row.memory_id), sourceRevision: Number(row.source_revision) }
  })

  const currentRevision = new Map<string, number>()
  for (const entry of indexed) {
    currentRevision.set(entry.memoryId, Math.max(currentRevision.get(entry.memoryId) ?? 0, entry.sourceRevision))
  }

  const histogram: Record<string, number> = {}
  let removedIneligible = 0
  let removedStaleRevision = 0
  let kept = 0
  /* ⚠️ 计数列的单位是**记忆**，不是**行**（一条记忆可能有多个 revision 的行） */
  let ineligibleMemories = 0
  let staleMemories = 0

  /*
   * ⚠️ **写阶段整体跑在一个事务里**（2026-10-01 修）：删行与更新计数必须**原子**，
   * 否则崩在中间会留下"行已删、计数陈旧"的状态，而重跑修不回来（第二次没有可删的 ⇒ 增量为 0）。
   *
   * ⚠️ 形状沿用 `db.ts:203-204` 的既定写法：**有事务就用，没有就直跑**
   * （`RawDb.transaction` 是可选的）。
   */
  const writePhase = async (writer: RawDb): Promise<void> => {
    for (const [memoryId, indexedRevision] of currentRevision) {
      /* 读**当前**的权威投影行（只读本模块要用的四列） */
      const live = rowsOf(
        await writer.execute(sql`
          select status, revision, content_kind, content from memory_records where id = ${memoryId}`)
      )[0] as Record<string, unknown> | undefined

      /* 源行都没了（不该发生）⇒ 按"不再有资格"处理：索引里不该留孤儿行 */
      if (live === undefined) {
        const deleted = await deleteRows(writer, options, memoryId, null)
        removedIneligible += deleted
        ineligibleMemories += 1
        histogram['source_missing'] = (histogram['source_missing'] ?? 0) + 1
        continue
      }

      const verdict = indexEligibility({
        record: {
          status: String(live.status),
          content: {
            kind: String(live.content_kind),
            predicate: String((live.content as Record<string, unknown>)?.predicate ?? ''),
            value: (live.content as Record<string, unknown>)?.value,
            summary: (live.content as Record<string, unknown>)?.summary,
          },
        } as never,
        integrityProblems: options.integrityProblemsOf(memoryId),
      })

      if (!verdict.eligible) {
        const deleted = await deleteRows(writer, options, memoryId, null)
        removedIneligible += deleted
        ineligibleMemories += 1
        histogram[verdict.reason] = (histogram[verdict.reason] ?? 0) + 1
        continue
      }

      /* 仍有资格，但源已经往前走了一版 ⇒ 删**过期**的那些行（新版本由 WP2 重新索引） */
      const liveRevision = Number(live.revision)
      if (liveRevision > indexedRevision) {
        const deleted = await deleteRows(writer, options, memoryId, indexedRevision)
        removedStaleRevision += deleted
        staleMemories += 1
        histogram['stale_revision'] = (histogram['stale_revision'] ?? 0) + 1
        continue
      }

      kept += 1
    }

  /*
   * ⚠️ **必须回头更新本代的计数列**（2026-10-01 实测发现的缺口）：
   * 只删行不改计数 ⇒ `pending_count` / `excluded_by_policy_count` / `eligible_source_count`
   * 会**陈旧**，于是 `coverageComplete`（= pending 0 且 failed 0）会在
   * `indexed < eligible` 时**仍然读作 true** —— 那是"开发者面/健康读回说没事、而其实少了行"。
   *
   * ⚠️ **两步、必须在同一事务里**（2026-10-01 修）：删行 → 更新计数。
   *    崩在中间会留下陈旧计数，而重跑本函数**修不回来**（第二次没有可删的 ⇒ 增量为 0）。
   *    ⇒ 两条都在 `writePhase` 里，由调用方的事务包住（见下）。
   */
  /* ⚠️ **故障注入点**：删完行、还没更新计数 —— 见 `ReconcileOptions.onAfterDeletes` */
  if (options.onAfterDeletes !== undefined) await options.onAfterDeletes()

  if (ineligibleMemories > 0 || staleMemories > 0) {
    await writer.execute(sql`
      update memory_semantic_generations set
        eligible_source_count = greatest(0, eligible_source_count - ${ineligibleMemories}),
        excluded_by_policy_count = excluded_by_policy_count + ${ineligibleMemories},
        pending_count = pending_count + ${staleMemories}
       where namespace = ${options.namespace} and generation_id = ${options.generationId}`)
  }
  }

  /* 有事务就用（原子），没有就直跑（与 `db.ts:203-204` 同形） */
  if (typeof db.transaction === 'function') {
    await db.transaction(writePhase)
  } else {
    await writePhase(db)
  }

  return {
    scanned: currentRevision.size,
    removedIneligible,
    removedStaleRevision,
    kept,
    removedByReason: Object.fromEntries(Object.entries(histogram).sort(([a], [b]) => (a < b ? -1 : 1))),
  }
}

/** 删一行/若干行；`onlyRevision` 非 null ⇒ 只删那一版（保留更新的） */
async function deleteRows(
  db: RawDb,
  options: ReconcileOptions,
  memoryId: string,
  onlyRevision: number | null
): Promise<number> {
  const before = rowsOf(
    await db.execute(sql`
      select count(*)::int as c from memory_semantic_index
       where namespace = ${options.namespace} and generation_id = ${options.generationId}
         and memory_id = ${memoryId}
         ${onlyRevision === null ? sql`` : sql`and source_revision <= ${onlyRevision}`}`)
  )[0] as { c?: number } | undefined
  await db.execute(sql`
    delete from memory_semantic_index
     where namespace = ${options.namespace} and generation_id = ${options.generationId}
       and memory_id = ${memoryId}
       ${onlyRevision === null ? sql`` : sql`and source_revision <= ${onlyRevision}`}`)
  return Number(before?.c ?? 0)
}
