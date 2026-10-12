/**
 * M9.5 **启用计划 / WP2-A** —— 派生索引的**源枚举**（写侧的入口那一半）。
 *
 * ============================================================================
 *  为什么单独把它做成一个可测单元（计划 §1 WP2 的第 ① 条）
 * ============================================================================
 * ```text
 * 计划 §8.2 **逐字**禁止：「复用 `list(limit<=500)` 然后假称全量」。
 * 而在这之前，全仓**没有任何生产代码枚举过索引源**（`index-maintenance.ts` 的 `seq`
 * 一直是**测试夹具**喂的合成整数）⇒ "全量"这件事从来没有人证明过。
 * ```
 *
 * 本模块只做两件事，两件都做成**纯查询 + 纯函数**（不编码、不落盘、不换代）：
 *
 * ```text
 *   ① enumerateIndexSources()  稳定排序 + **keyset 分页** + 每页上限 + 整轮预算 + 可持久游标
 *   ② classifyIndexSources()   套 WP1 的**资格政策**（`indexEligibility`）⇒ 可分列计数
 * ```
 *
 * ⚠️ **为什么必须是 keyset 而不是 `offset`**（本模块的负控就是拿这条做的）：
 * `offset` 分页在"翻页之间有新行插进来"时会**漏行或重复行**（插入点之前的行会把后面的整体后移）
 * ⇒ 那正好是"假称全量"的另一种形态。keyset（`(created_at, id) > (上一页最后一行)`）不受插入影响。
 *
 * ============================================================================
 *  两条如实登记的设计边界
 * ============================================================================
 * ```text
 *  ① `seq` = `created_at`（毫秒）—— 它是**记录版本的稳定单调位置**，也是水位单位
 *     （`memory_semantic_generations.processed_watermark` 就是个整数）。
 *     ⚠️ **同毫秒的两条会共享 seq** ⇒ 水位在那一点**保守停住**（不会漏写、只会晚推进）
 *     —— 这是刻意的取舍：宁可保守，不要一个会"跳过失败项"的水位。
 *  ② **同一条记忆的 revision 更新不改变 seq** ⇒ 本模块**不会**因为"内容改了"而重新枚举到它。
 *     那是**失效传播**（计划 §1 的 `N2` / 本计划的 WP3）的职责，**不是**本模块的
 *     —— 本轮不假装覆盖它（换代时的全量重建是今天唯一能拿到更新的路径）。
 * ```
 */

import { sql } from 'drizzle-orm'

import type { RawDb } from './db.ts'
import { rowsOf } from './db.ts'
import { indexEligibility, type IndexExclusionReason } from '../../kernel/app/recall/index-render.ts'
import type { MemoryRecord } from '../../kernel/contracts/memory.ts'

/** 游标 = **上一页最后一行的稳定位置**（keyset 分页的锚点） */
export interface SourceCursor {
  readonly createdAt: number
  readonly id: string
}

/** 一条枚举出来的源记录（**未经资格判定**） */
export interface IndexSourceRow {
  /**
   * 水位单位 —— **秒**（`floor(created_at / 1000)`）。
   *
   * ⚠️ **为什么是秒而不是毫秒**（2026-10-01 **生产副本预演实测**的缺陷）：
   * 第一版用**毫秒**，而水位列 `memory_semantic_generations.processed_watermark` 声明的是
   * **`integer`** ⇒ 真数据一上来就
   * `value "1789576995336" is out of range for type integer`。
   * ⚠️ 而**50 项隔离检查全部通过** —— 因为夹具的 `created_at` 是 1000..12000（毫秒），塞得下。
   * ⇒ 换成**秒**：`1789576995 < 2^31`，到 2038 都不会溢出，且**不碰任何冻结列**（`D-31` 的零迁移仍然成立）。
   * ⚠️ 代价如实登记：**同一秒内的多条共享 seq** ⇒ 水位在那一点**保守停住**（不漏写、只晚推进）。
   */
  readonly seq: number
  readonly memoryId: string
  /** ⚠️ **真实** revision（不许写死 1 —— M10 的 `缺口 ①` 记的就是 M9.5 fixture 那个固定值） */
  readonly sourceRevision: number
  readonly status: string
  readonly contentKind: string
  readonly content: unknown
  readonly createdAt: number
}

export interface EnumerateOptions {
  readonly ownerKind: string
  readonly ownerId: string
  /** 从哪一行**之后**继续（`null` = 从头开始）。**持久游标**就存它 */
  readonly after: SourceCursor | null
  /** 每页上限（有界） */
  readonly pageLimit: number
  /** **整轮工作预算**：这一次调用最多取多少条（有界；不是"总共只有这么多条"） */
  readonly budget: number
}

export interface EnumerateResult {
  readonly rows: readonly IndexSourceRow[]
  /** 下一页从这里继续；`null` = 源已走完 */
  readonly nextCursor: SourceCursor | null
  /** 是否**真的**走到源尾（`false` = 还有没取的） */
  readonly exhausted: boolean
  /** 取了几页（诊断用；也是"分页真的在翻"的证据） */
  readonly pages: number
}

/**
 * 稳定排序 + keyset 分页 + 预算。
 *
 * 排序键 `(created_at asc, id asc)`：`created_at` 是主序（与 `seq` 同一个量），
 * `id` 只用于**打破同毫秒的平局** ⇒ 全序是确定的，与插入顺序无关。
 */
export async function enumerateIndexSources(
  db: RawDb,
  options: EnumerateOptions
): Promise<EnumerateResult> {
  if (!Number.isInteger(options.pageLimit) || options.pageLimit <= 0) {
    throw new Error(`pageLimit 必须是正整数（收到 ${String(options.pageLimit)}）`)
  }
  if (!Number.isInteger(options.budget) || options.budget <= 0) {
    throw new Error(`budget 必须是正整数（收到 ${String(options.budget)}）`)
  }

  const rows: IndexSourceRow[] = []
  let cursor = options.after
  let pages = 0
  let exhausted = false

  while (rows.length < options.budget) {
    const remaining = options.budget - rows.length
    const limit = Math.min(options.pageLimit, remaining)

    const page = cursor === null
      ? rowsOf(
          await db.execute(sql`
            select id, status, revision, content_kind, content, created_at
              from memory_records
             where owner_kind = ${options.ownerKind} and owner_id = ${options.ownerId}
             order by created_at asc, id asc
             limit ${limit}`)
        )
      : rowsOf(
          await db.execute(sql`
            select id, status, revision, content_kind, content, created_at
              from memory_records
             where owner_kind = ${options.ownerKind} and owner_id = ${options.ownerId}
               and (created_at > ${cursor.createdAt}
                    or (created_at = ${cursor.createdAt} and id > ${cursor.id}))
             order by created_at asc, id asc
             limit ${limit}`)
        )
    pages += 1

    for (const raw of page) {
      const row = raw as Record<string, unknown>
      rows.push({
        /* ⚠️ 秒（不是毫秒）—— 见 `IndexSourceRow.seq` 的注释：毫秒会撑爆 `integer` 水位列 */
        seq: Math.floor(Number(row.created_at) / 1000),
        memoryId: String(row.id),
        sourceRevision: Number(row.revision),
        status: String(row.status),
        contentKind: String(row.content_kind),
        content: row.content,
        createdAt: Number(row.created_at),
      })
    }

    const last = page[page.length - 1] as Record<string, unknown> | undefined
    if (last === undefined) {
      /* 这一页是空的 ⇒ 源真的走完了 */
      exhausted = true
      break
    }
    cursor = { createdAt: Number(last.created_at), id: String(last.id) }

    if (page.length < limit) {
      /* 页没满 ⇒ 后面没有了 */
      exhausted = true
      break
    }
  }

  return { rows, nextCursor: exhausted ? null : cursor, exhausted, pages }
}

/** 资格判定的结果（**可分列计数**，计划 §1 WP2 的第 ⑦ 条要的就是这个） */
export interface ClassifiedSources {
  readonly eligible: readonly IndexSourceRow[]
  readonly excluded: readonly { readonly memoryId: string; readonly reason: IndexExclusionReason }[]
  /** 理由直方图（`excluded_by_policy_count` 的可审计形态） */
  readonly excludedByReason: Readonly<Record<string, number>>
}

/**
 * 把枚举出来的行套上 WP1 的**资格政策**。
 *
 * ⚠️ 这里**不重新实现**政策：`indexEligibility()` 是唯一实现（`ADR-081`）。
 * 本函数只负责把"投影记录"的形状拼出来 + 分列计数。
 *
 * `integrityProblemsOf` 是**注入**读数（与检索适配器注入的是同一个来源）
 * —— 本模块不读 `memory_evidence_links`，那是接线方的事。
 */
export function classifyIndexSources(
  rows: readonly IndexSourceRow[],
  integrityProblemsOf: (memoryId: string) => readonly string[]
): ClassifiedSources {
  const eligible: IndexSourceRow[] = []
  const excluded: { memoryId: string; reason: IndexExclusionReason }[] = []
  const histogram: Record<string, number> = {}

  for (const row of rows) {
    const verdict = indexEligibility({
      record: projectionShim(row),
      integrityProblems: integrityProblemsOf(row.memoryId),
    })
    if (verdict.eligible) {
      eligible.push(row)
      continue
    }
    excluded.push({ memoryId: row.memoryId, reason: verdict.reason })
    histogram[verdict.reason] = (histogram[verdict.reason] ?? 0) + 1
  }

  return {
    eligible,
    excluded,
    excludedByReason: Object.fromEntries(Object.entries(histogram).sort(([a], [b]) => (a < b ? -1 : 1))),
  }
}

/**
 * 把一行源记录拼成 `indexEligibility()` 要的**最小投影形状**。
 *
 * ⚠️ **只填政策真的会读的三个字段**（`status` / `content.kind` / `content.predicate` /
 * `content.value`）；其余字段**不假装存在** —— 本模块是只读的枚举层，
 * 不构造完整 `MemoryRecord`（那需要事件、证据、指纹等一堆本层拿不到的东西）。
 */
function projectionShim(row: IndexSourceRow): MemoryRecord {
  const content = (row.content ?? {}) as Record<string, unknown>
  return {
    status: row.status,
    content: {
      kind: row.contentKind,
      predicate: typeof content.predicate === 'string' ? content.predicate : '',
      value: content.value,
      summary: content.summary,
    },
  } as never
}
