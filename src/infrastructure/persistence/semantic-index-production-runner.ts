/**
 * M9.5 **启用计划 / WP4 · W1 的零件** —— **生产维护运行器**（一轮 = `runIndexMaintenance` + 钉死的上限）。
 *
 * ============================================================================
 *  为什么把它单独抽出来（而不是直接写在 `main.ts` 里）
 * ============================================================================
 * ```text
 * `main.ts` 的 `commitEvents`（:1604）那处改动**越薄越好** —— 它动的是**生产写路径**。
 * ⇒ 把"一轮维护到底做什么"收进这里（可离线、可测），`main.ts` 那边就只剩：
 *      const runOnce = createProductionMaintenanceRunner({ … })
 *      if (events.length > 0) void maintenance.trigger('event')      // ← 两行
 * ```
 *
 * ⚠️ **上限是钉死的**（`budget` / `batchLimit` / `pageLimit`）：用户裁定的形态是"**有工作上限**的
 *    异步维护"。有界的一轮**不会**谎称完整（`enumerated.exhausted` 已并入覆盖判定，见 builder）。
 * ⚠️ **owner 从数据里读**（不写死）—— 2026-10-01 的实测教训：写死的 owner 会让整轮"跑通但零读数"。
 * ⚠️ **它不投递触发、不决定时机**：那两件在调用方（`main.ts` 的 `commitEvents` / 启动补追赶）。
 */

import { sql } from 'drizzle-orm'

import type { RawDb } from './db.ts'
import { rowsOf } from './db.ts'
import type { MemoryIntegrityProblems } from './memory-integrity.ts'
import { SEMANTIC_INDEX_SCHEMA_VERSION } from './memory-semantic-index.ts'
import { runIndexMaintenance, type MaintenanceRun } from './semantic-index-maintenance.ts'
import type { IndexEncoderPort } from './semantic-index-builder.ts'
import { createEncoderIndexPort } from './semantic-index-encoder-port.ts'
import {
  createMaintenanceTrigger,
  type MaintenanceReason,
  type MaintenanceTrigger,
} from './semantic-index-trigger.ts'
import { RENDERER_VERSION } from '../../kernel/app/recall/index-render.ts'
import type { EncoderClient } from '../semantic/encoder-client.ts'
import {
  embeddingFingerprintOf,
  type EmbeddingManifest,
} from '../semantic/embedding-manifest.ts'

/** 一轮维护的**钉死上限**（写在一处，便于审阅与日后调整时只改这里） */
export const PRODUCTION_MAINTENANCE_LIMITS = {
  pageLimit: 200,
  budget: 200,
  batchLimit: 200,
  maxAttempts: 3,
} as const

/**
 * 维护**该写进哪一代**（计划 ⑥ 的增量形态）。
 *
 * ```text
 *   已有 `published` 代 ⇒ **复用它**（新记忆的行直接进已发布代 ⇒ 探针立刻能看到 ✓）
 *   没有               ⇒ 新建一个 `building` 代（由 builder 在覆盖完整时切 published）
 * ```
 *
 * ⚠️ **为什么复用而不是每轮换代**：换代是**全量重建**的语义（旧代置 unavailable、新代从头建）。
 *    增量维护要的是"同一代里继续补行" ⇒ 每轮换代会让索引**反复从零开始**，
 *    而 `D-3` 要的恰恰是"运行期间持续跟进"。
 * ⚠️ 一代只能有一个 `published`（builder 的换代逻辑守着）⇒ 这里取到的就是它。
 */
export async function resolveMaintenanceGenerationId(
  db: RawDb,
  namespace: string
): Promise<string> {
  const published = rowsOf(
    await db.execute(sql`
      select generation_id from memory_semantic_generations
       where namespace = ${namespace} and build_state = 'published'
         /* ⚠️ **只复用与当前派生 schema 版本一致的那一代**（2026-10-01 实测）：
            升到 v2 之后，v1 建出来的旧代**不能**继续写（builder 的跨代检查会如实拒绝：
            「generation_mismatch: …/1 vs …/2」）⇒ 此时应当**另起新一代**（旧代由换代逻辑置 unavailable）。 */
         and index_schema_version = ${SEMANTIC_INDEX_SCHEMA_VERSION}
         and renderer_version = ${RENDERER_VERSION}
       order by published_at desc nulls last, created_at desc limit 1`)
  )[0] as Record<string, unknown> | undefined
  if (published !== undefined) return String(published.generation_id)
  /* 没有已发布代 ⇒ 起一个新的 building 代（名字带时间戳，便于人读） */
  return `maint-${namespace}-${String(Date.now())}`
}

export interface ProductionRunnerOptions {
  readonly db: RawDb
  readonly namespace: string
  readonly encoder: IndexEncoderPort
  readonly rendererVersion: string
  readonly tokenizerFingerprint: string
  readonly pooling: string
  readonly normalize: boolean
  readonly dtype: string
  readonly dimension: number
  /** 当前代（`published` 有就复用；调用方决定） */
  readonly generationId: string
  /** 与检索适配器**同一个来源**的完整性读数 */
  readonly integrityProblemsOf: (memoryId: string) => readonly string[]
  readonly now?: () => number
}

/**
 * 造一个 `runOnce`（供 `createMaintenanceTrigger` 注入）。
 *
 * ⚠️ **owner 每次现读**：它可能在维护之间变化（例如将来多角色），写死会静默维护错对象。
 * ⚠️ **库里一条记忆都没有 ⇒ 什么都不做**（不是错误：新库就该是空的）。
 */
export function createProductionMaintenanceRunner(
  options: ProductionRunnerOptions
): () => Promise<MaintenanceRun | null> {
  return async () => {
    const owner = rowsOf(
      await options.db.execute(
        sql`select owner_kind, owner_id from memory_records order by created_at asc limit 1`
      )
    )[0] as Record<string, unknown> | undefined
    if (owner === undefined) return null
    return await runIndexMaintenance({
      db: options.db,
      namespace: options.namespace,
      ownerKind: String(owner.owner_kind),
      ownerId: String(owner.owner_id),
      generationId: options.generationId,
      rendererVersion: options.rendererVersion,
      encoder: options.encoder,
      tokenizerFingerprint: options.tokenizerFingerprint,
      pooling: options.pooling,
      normalize: options.normalize,
      dtype: options.dtype,
      dimension: options.dimension,
      now: options.now ?? (() => Date.now()),
      ...PRODUCTION_MAINTENANCE_LIMITS,
      integrityProblemsOf: options.integrityProblemsOf,
    })
  }
}

export interface ProductionTriggerOptions {
  readonly db: RawDb
  readonly namespace: string
  readonly encoderClient: EncoderClient
  readonly manifest: EmbeddingManifest
  /**
   * **每轮现读**的完整性读数（`memoryIntegrityProblems` 是 **async** 的，而且会变）。
   *
   * ⚠️ 传一个**快照**是不行的：`buildMemoryWriter()` 本身是**同步**的（返回端口，不是 Promise）
   * ⇒ 那里 `await` 不了 ⇒ 只能把"读法"传进来，由 `runOnce` **每轮**现读。
   */
  readonly readIntegrityProblems: () => Promise<MemoryIntegrityProblems>
}

/**
 * **把"按 owner 的完整性读数"适配成"按记忆的问题列表"**（M9.5 / WP4 · W1 的第三个坑）。
 *
 * ```text
 * 形状不同（实测）：
 *   `memoryIntegrityProblems(db, owner)` ⇒ `MemoryIntegrityProblems`（四个数组，每个元素带 memoryId）
 *   资格政策要的                        ⇒ `(memoryId) => readonly string[]`
 * ⇒ 这一层映射**必须有**：没有它就只能传空数组，而那等于**静默关掉**
 *   "链断 / 完整性不合格 ⇒ 不索引" —— 那是 `D-1` 修订后**仍然保留**的那一半政策。
 * ```
 *
 * ⚠️ 问题码**具名**（进 `excluded_by_policy_count` 的直方图，可审计）：
 *    `dangling_evidence_link` / `dangling_memory_event` / `no_live_evidence` / `no_live_events`
 * ⚠️ **纯函数**（无数据库）⇒ 可以在没有库的情况下把四种问题逐条测到。
 */
export function integrityProblemsByMemory(
  problems: MemoryIntegrityProblems
): (memoryId: string) => readonly string[] {
  const byMemory = new Map<string, string[]>()
  const add = (memoryId: string, code: string): void => {
    const list = byMemory.get(memoryId)
    if (list === undefined) byMemory.set(memoryId, [code])
    else list.push(code)
  }
  for (const entry of problems.danglingEvidenceLinks) add(entry.memoryId, 'dangling_evidence_link')
  for (const entry of problems.danglingMemoryEvents) add(entry.memoryId, 'dangling_memory_event')
  for (const entry of problems.memoriesWithoutLiveEvidence) add(entry.memoryId, 'no_live_evidence')
  for (const entry of problems.memoriesWithoutLiveEvents) add(entry.memoryId, 'no_live_events')
  return (memoryId) => byMemory.get(memoryId) ?? []
}

/**
 * **把触发器整个装配出来**（M9.5 / WP4 · W1 的接线就只剩一行投递）。
 *
 * ```text
 * main.ts 那边因此只需要：
 *     const maintenance = createProductionMaintenanceTrigger({ db, namespace:'production',
 *       encoderClient: semanticEncoderShared({…}), manifest: embeddingManifestShared(),
 *       integrityProblemsOf })
 *     … if (events.length > 0 && this.semanticRecallEncoder !== undefined) void maintenance.trigger('event')
 * ```
 *
 * ⚠️ **代**在**每轮**现算（`resolveMaintenanceGenerationId`）⇒ 换代之后自动跟上新一代，
 *    不需要调用方在换代时重建触发器。
 * ⚠️ 所有指纹字段来自**冻结清单**（`manifest`）—— 不在这里另写一份。
 */
export function createProductionMaintenanceTrigger(
  options: ProductionTriggerOptions
): MaintenanceTrigger {
  const encoder: IndexEncoderPort = createEncoderIndexPort(options.encoderClient, {
    modelFingerprint: embeddingFingerprintOf(options.manifest),
  })
  /** 每一轮都**现算代**（换代之后自动跟上新一代，调用方不需要重建触发器） */
  const runWith = (generationId: string, integrityProblemsOf: (memoryId: string) => readonly string[]) =>
    createProductionMaintenanceRunner({
      db: options.db,
      namespace: options.namespace,
      encoder,
      rendererVersion: RENDERER_VERSION,
      tokenizerFingerprint: 'tokenizer@frozen-manifest',
      pooling: options.manifest.pooling,
      normalize: options.manifest.normalize,
      dtype: options.manifest.dtype,
      dimension: options.manifest.dimension,
      generationId,
      integrityProblemsOf,
    })
  return createMaintenanceTrigger({
    runOnce: async (_reason: MaintenanceReason) => {
      const generationId = await resolveMaintenanceGenerationId(options.db, options.namespace)
      /* ⚠️ 完整性**每轮现读**（它会变；而且 `memoryIntegrityProblems` 是 async 的） */
      const integrityProblemsOf = integrityProblemsByMemory(await options.readIntegrityProblems())
      await runWith(generationId, integrityProblemsOf)()
    },
    onError: (error) => {
      /* ⚠️ **不抛给用户轮次**：索引是派生结构，维护失败**不能**让"她记住了"变成失败 */
      console.warn(
        `[m95-maintain] 一轮索引维护失败（如实记录，不影响本轮对话）：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    },
  })
}
