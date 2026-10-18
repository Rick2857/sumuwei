/**
 * M9.5 WP6 —— **语义探针的真实实现**（`MemorySemanticProbe` 的适配器）。
 *
 * ============================================================================
 *  它是"派生索引 + 本地编码器"与"召回端口"之间**唯一**的那段接线
 * ============================================================================
 * ```text
 * 一次 score() 做五件事，每一步都能**具名**失败（不许笼统地"不可用"）：
 *   ① 找**已发布**的代：`memory_semantic_generations.build_state = 'published'`
 *        没有 ⇒ `not_indexed`（**不加载模型** —— 没索引时白加载 134 MiB 是浪费）
 *   ② 代的维度与模型清单不符 ⇒ `dimension_mismatch`
 *   ③ 代的模型指纹与当前清单不符 ⇒ `generation_mismatch`（禁止跨代混排）
 *   ④ 编码查询句（本地子进程；超时/模型缺失 ⇒ `timeout` / `model_missing`）
 *   ⑤ 在 namespace + 代上做**精确检索**，只保留调用方要的那些 memoryId
 *        一条都没算出来 ⇒ `missing_score`（R3：**不是**"分数都是 0"）
 * ```
 *
 * ============================================================================
 *  两条设计纪律
 * ============================================================================
 * ```text
 * ① **只服务已发布的代**。`building` / `unavailable` 的代一律不参与 ——
 *    半建好的索引被查询会让"她记得什么"随构建时机漂移，那是 M9.5 明令禁止的
 *    （计划 §8.3：`published` 才是可用于回答的状态）。
 * ② **不发明分数**：数据库返回什么就是什么；缺的键表示"这条没有向量"，
 *    绝不用 0 或平均值补齐。
 * ```
 *
 * ⚠️ 本模块**不打开**数据库（`db` 由调用方给）、**不联网**（编码器 `allowRemoteModels=false`）。
 */

import { sql } from 'drizzle-orm'

import type { RawDb } from '../persistence/db.ts'
import { rowsOf } from '../persistence/db.ts'
import { authorizedMemoryIds } from '../persistence/read-scope.ts'
import type { EmbeddingManifest } from './embedding-manifest.ts'
import { embeddingFingerprintOf } from './embedding-manifest.ts'
import type { SemanticUnavailableReason } from '../../kernel/contracts/recall.ts'
import { SEMANTIC_UNAVAILABLE_REASONS } from '../../kernel/contracts/recall.ts'
import type { MemorySemanticProbe } from '../../kernel/recall/ports.ts'

/**
 * 编码器的最小形状。
 *
 * ⚠️ 失败原因用 `string` 而不是窄联合：真实的 `EncoderClient` 会给出更细的原因
 *    （`encode_timeout` / `worker_error` / `worker_exited` / `assets_missing` / …），
 *    而契约的 `SemanticUnavailableReason` 只有 7 个冻结值。
 *    ⇒ 由 `semanticReasonOf()` **显式映射**，不靠结构兼容（靠结构兼容会在
 *      编码器多一个原因时**静默编译失败**或悄悄错分类）。
 */
export interface SemanticQueryEncoder {
  encode: (texts: readonly string[]) => Promise<
    | { readonly ok: true; readonly vectors: readonly (readonly number[])[]; readonly dimension: number }
    | { readonly ok: false; readonly reason: string; readonly detail: string }
  >
}

/**
 * 把编码器的失败原因映射成契约里的**具名**原因。
 *
 * ```text
 * ① 已经是契约词汇（`SEMANTIC_UNAVAILABLE_REASONS` 之一）⇒ **原样透传**
 *    —— 编码器的实现可能直接给契约级原因（注入的假编码器就这样），
 *       再映射一次会把 `timeout` 错翻成 `model_missing`（**真实踩过**）。
 * ② `encode_timeout`（真实的 `EncoderClient` 用这个名字）⇒ `timeout`
 * ③ 其余（模型缺失 / 资产不符 / worker 起不来或中途死掉 / 后台被禁）⇒ `model_missing`
 * ```
 *
 * ⚠️ 为什么 ③ 都归到 `model_missing`：对**召回**而言它们说的是同一件事 ——
 *    「本机的语义编码能力这次不可用」，调用方要做的动作也一样（如实降级成
 *    `degraded_lexical` 并写进 trace）。worker 层的细节进 `detail`，不进契约词汇。
 */
export function semanticReasonOf(reason: string): SemanticUnavailableReason {
  if ((SEMANTIC_UNAVAILABLE_REASONS as readonly string[]).includes(reason)) {
    return reason as SemanticUnavailableReason
  }
  return reason === 'encode_timeout' ? 'timeout' : 'model_missing'
}

export interface SemanticProbeOptions {
  readonly db: RawDb
  readonly manifest: EmbeddingManifest
  readonly encoder: SemanticQueryEncoder
  /** 一次检索返回的上限（有界；缺省 = 候选上限由调用方保证） */
  readonly maxResults?: number
}

interface PublishedGeneration {
  readonly generationId: string
  readonly dimension: number
  readonly modelFingerprint: string
}

/**
 * 分代读取**已发布**的代（只读 SELECT；不写任何东西）。
 *
 * ⚠️ **本函数是 `L-M10-61` 根因的落点**（用户 2026-09-30 裁定后修）。原写法直接把查询的
 *    失败**抛出去**，而 `score()` 的契约是"**返回具名失败**"（`SemanticUnavailableReason`
 *    五档 + `failed()`）—— "这张表不存在"**恰好就是 `not_indexed` 那一档存在的理由**：
 *
 * ```text
 * `memory_semantic_generations` **不在任何内核迁移里**（0001–0009 都没有）；
 * 建它的是 `ensureSemanticIndexSchema()`，而它**只被 M9.5 自己的实验室脚本调用**，
 * **没有任何启动路径调用它** ⇒ 没建过索引的库上这张表**不存在**。
 * ⇒ 原写法：SELECT 抛 `relation ... does not exist`（实测 0 ms）⇒ 调用点**没有 try/catch**
 *   ⇒ rejection 逃逸 ⇒ 聊天轮次**静默挂住**（跨过 180s 就绪超时）。
 * ```
 *
 * ⇒ 现在：**只**把"表/关系不存在"这一种失败映射成**空数组**（由 `score()` 走它既有的
 *    `not_indexed` 路径）；**其余**查询失败（库真的坏了、权限、连接断）**照旧抛出** ——
 *    把它们也说成 `not_indexed` 会掩盖真正的问题。
 */
async function publishedGenerations(db: RawDb, characterId: string): Promise<PublishedGeneration[]> {
  let raw: unknown
  try {
    raw = await db.execute(
      sql`select generation_id, dimension, model_fingerprint
          from memory_semantic_generations
          where namespace = ${characterId} and build_state = 'published'
          order by generation_id`
    )
  } catch (error) {
    if (isMissingRelationError(error)) return []
    throw error
  }
  const rows = rowsOf(raw)
  return rows.map((row) => ({
    generationId: String(row.generation_id),
    dimension: Number(row.dimension),
    modelFingerprint: String(row.model_fingerprint),
  }))
}

/**
 * "表/关系不存在"的识别（Postgres 家族；PGlite 走同一套错误文本与 SQLSTATE）。
 *
 * ⚠️ 刻意**只认这两种**：`42P01`（undefined_table）与错误文本里的 `does not exist`。
 *    宁可漏判（那会走调用点的兜底降级）也不**误判**（把库坏了说成"没索引"）。
 */
function isMissingRelationError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  if (code === '42P01') return true
  const message = error instanceof Error ? error.message : String(error)
  return /relation .* does not exist|no such table|does not exist/i.test(message)
}

function toLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => value.toFixed(8)).join(',')}]`
}

/** 供 trace 用的失败原因（与契约的 `SemanticUnavailableReason` 同源） */
function failed(reason: SemanticUnavailableReason): { readonly ok: false; readonly reason: SemanticUnavailableReason } {
  return { ok: false, reason }
}

export function createSemanticProbe(options: SemanticProbeOptions): MemorySemanticProbe {
  const dimension = options.manifest.dimension
  const fingerprint = embeddingFingerprintOf(options.manifest)

  /*
   * ⚠️ **`L-M10-61` 的诊断插桩**（用户已授权；`M95_ENCODER_DEBUG=1` 时开）。
   *
   * 编码器侧的读数已经排除了整条 worker 链（233 ms 就绪、`encode` **从未被调用**）
   * ⇒ 卡点在**这里**。必须分开的三种情形：
   * ```text
   * 没有 `score 进入`              ⇒ 卡点在**更上游**（召回路径根本没调探针）
   * 有 `score 进入`、没有 `代读回`  ⇒ 卡在 `publishedGenerations` 那条 SELECT
   * 有 `代读回`、没有 `encode 前`   ⇒ 卡在代校验/早退（不该卡，但有读数才算数）
   * ```
   */
  const debugEnabled = process.env.M95_ENCODER_DEBUG === '1'
  const t0 = Date.now()
  const debug = (mark: string): void => {
    if (!debugEnabled) return
    console.error(`[m95-probe-debug +${String(Date.now() - t0)}ms] ${mark}`)
  }

  return {
    name: 'derived-index-semantic-probe',

    async score(input) {
      debug(`score 进入（text 长度 ${String(input.text.length)} · memoryIds ${String(input.memoryIds.length)}）`)
      /* ① 已发布的代（**先于**加载模型：没索引就不该付 134 MiB 的代价） */
      const generations = await publishedGenerations(options.db, input.characterId)
      debug(`代读回（${String(generations.length)} 代）`)
      if (generations.length === 0) return failed('not_indexed')

      /* ②③ 维度与模型指纹都必须与当前清单一致（禁止跨代/跨模型混排） */
      for (const generation of generations) {
        if (generation.dimension !== dimension) return failed('dimension_mismatch')
      }
      const matching = generations.filter((generation) => generation.modelFingerprint === fingerprint)
      if (matching.length === 0) return failed('generation_mismatch')
      /*
       * ★ **代的身份必须唯一**（M9.5 / WP9 的 recovery 门逼出来的一处修正）：
       *
       * 切换是**原子**的（旧的转 `unavailable`、新的转 `published`）。若同指纹下有
       * **多于一个** published，说明原子性被破坏 —— 此时无论"取新"还是"取旧"都是在**猜**，
       * 而"猜"的表现是"她记得什么"随切换时机漂移（正是 M9.5 要防的）。
       * ⇒ 失败关闭：拒绝服务，理由记为 `generation_mismatch`（代的身份不唯一）。
       *
       * 修前的写法是把多个代的分数**取最大值** —— 那会在切换半途静默继续服务，
       * 并把"两代混用"伪装成"一切正常"（本门的第一版就是这样被探针抓到的）。
       */
      if (matching.length > 1) return failed('generation_mismatch')
      const serving = matching[0] as PublishedGeneration

      // With no eligible candidates there can be no score; preserve index diagnostics without encoding a query.
      if (input.memoryIds.length === 0) return failed('missing_score')

      /* ④ 编码查询句（用清单里的 `query:` 前缀 —— E5 的约定，写错会静默降质） */
      const encoded = await options.encoder.encode([`${options.manifest.queryPrefix}${input.text}`])
      if (!encoded.ok) return failed(semanticReasonOf(encoded.reason))
      const queryVector = encoded.vectors[0]
      if (queryVector === undefined || queryVector.length !== dimension) return failed('dimension_mismatch')

      /* ⑤ 精确检索：namespace 与**那一代**双重预过滤（这就是"派生索引可重建"的检索面） */
      const wanted = await authorizedMemoryIds(options.db, input.memoryIds.map(String))
      if (wanted.size === 0) return failed('missing_score')
      const scores = new Map<string, number>()
      const limit = options.maxResults ?? Math.max(wanted.size, 1)
      {
        const rows = rowsOf(
          await options.db.execute(
            sql`select memory_id, (embedding <=> ${toLiteral(queryVector)}::vector) as distance
                from memory_semantic_index
                where namespace = ${input.characterId} and generation_id = ${serving.generationId}
                  and memory_id in (${sql.join([...wanted].map(id => sql`${id}`), sql`, `)})
                limit ${limit}`
          )
        )
        for (const row of rows) {
          const memoryId = String(row.memory_id)
          if (!wanted.has(memoryId)) continue
          const distance = Number(row.distance)
          if (!Number.isFinite(distance)) continue
          /* 余弦距离 → 相似度；`<=>` 对归一化向量即 1 − cos */
          scores.set(memoryId, 1 - distance)
        }
      }

      /* R3：一条都没算出来 ⇒ `missing_score`（**不是**"都是 0 分"） */
      if (scores.size === 0) return failed('missing_score')
      return { ok: true, scores }
    },
  }
}
