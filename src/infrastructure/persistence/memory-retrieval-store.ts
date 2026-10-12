/**
 * M5 WP3 —— **Retrieval Adapter**（现有 Memory Backend 的只读适配器）。
 *
 * ============================================================================
 *  它做什么 / 不做什么
 * ============================================================================
 *   做：`MemoryRetrievalQuery`（后端无关） → 现有 `MemoryStorePort` 的只读方法
 *       → `MemoryRetrievalHit[]`（带"被哪几条通道找到"）
 *
 *   不做：**资格过滤**（那是 WP2）、排序（WP4）、预算（WP5）、写任何表
 *
 * ---------------------------------------------------------------------------
 *  为什么刻意"宽召回"（这一条决定了 WP2 的可测性）
 * ---------------------------------------------------------------------------
 * 计划书 WP3 的测试要求：
 *
 *     Candidate Retrieval 可以宽召回；但 Eligibility 后非法候选全部消失。
 *
 * 因此这里**不做** status 过滤、**不做** subject 隔离判定。
 * 在适配器里顺手滤掉 retracted / 别人的记忆，会让 WP2 的三个零泄漏判据
 * 永远返回 0 —— 而那些非法候选根本到不了资格层。**"永远是 0"与"真的没有泄漏"
 * 在输出上完全一样**，这正是本项目反复记录的那类假绿。
 *
 * 隔离由 `kernel/recall/eligibility.ts` 负责（768 例矩阵 + 泄漏计数守着）。
 *
 * ---------------------------------------------------------------------------
 *  复用而不是重写（三处关键决定）
 * ---------------------------------------------------------------------------
 * 1. **词面匹配只有一处实现**：M4.1 的 `lexicalOverlapHits`（含登记表中文说明
 *    与 CJK bigram）。本文件**不**自己写切片/包含逻辑 ——
 *    M4.1 的教训写在那个函数的注释里："'什么算词面命中'有两个实现，
 *    而两个实现迟早会漂移"。
 * 2. **时间过滤只有一处实现**：`isWithinTimeScope()`（在 `recall/ports.ts`，
 *    纯函数）。适配器与测试共用同一份，避免"边界上的一小时"两处不一致。
 * 3. **完整性只有一处实现**：注入的 `memoryIntegrityProblems()`（M5-PRE 的探针）。
 *
 * 方向性：`infrastructure → kernel` 是允许的方向（本文件 import kernel 的
 * 契约与 M4.1 的纯函数；反向是禁止的，见 `pnpm kernel:test` 的依赖方向锁）。
 */

import { entityRef, type EntityRef } from '../../kernel/contracts/entity.ts'
import type { MemoryRecord, MemoryType } from '../../kernel/contracts/memory.ts'
import type { MemoryStorePort } from './memory-store.ts'
import type { TrustedOriginReading } from '../../kernel/contracts/attribution.ts'
import type { MemoryIntegrityProblems } from './memory-integrity.ts'
import { lexicalOverlapHits, lexicalOverlapStrength } from '../../kernel/app/memory/target-resolver.ts'
/* M9.5 / WP6：排序策略是**单一实现**（版本化），店只负责选行、不自己写比较器 */
import { orderCandidates, type HybridRelevancePolicy } from '../../kernel/app/recall/hybrid-candidates.ts'
import {
  DEFAULT_RETRIEVAL_POLICY_VERSION,
  defaultSemanticModeFor,
  type RetrievalPolicyVersion,
  type SemanticUnavailableReason,
} from '../../kernel/contracts/recall.ts'
import {
  SEMANTIC_UNAVAILABLE_REASON,
  isWithinTimeScope,
  type MemoryRetrievalCapabilities,
  type MemoryRetrievalDimension,
  type MemoryRetrievalHit,
  type MemoryRetrievalPort,
  type MemoryRetrievalQuery,
  type MemoryRetrievalResult,
  type MemorySemanticProbe,
} from '../../kernel/recall/ports.ts'

export interface MemoryRetrievalStoreOptions {
  store: MemoryStorePort
  /**
   * **可选**：混合召回的**权重策略**覆写（M9.5 `L-M95-18` 的有限词面权重校准用）。
   *
   * ```text
   * 缺省 = `PROVISIONAL_HYBRID_POLICY`（等权），即**生产行为不变**。
   * 只有显式传入时才生效 ⇒ 校准门可以在**真实管道**上对照候选权重，
   * 而不必自己造分（那会变成"量自己的假设"）。
   * ⚠️ 覆写**只改权重**，不引入任何"字面命中置顶"的规则分支（`L-M95-18` 的裁定要求）。
   * ```
   */
  hybridPolicy?: HybridRelevancePolicy
  /**
   * 完整性探针。**必填**（不是可选）。
   *
   * 它的类型签名就是"M5-PRE 的探针"（`memoryIntegrityProblems`），
   * 因此**不可能**在这里另写一套"证据还在不在"的判断：
   * 装配层必须把同一个 DB 上的那个探针接进来。
   * 让它可选等于允许忘记接线，而后果是"证据已不存在的记忆"静默通过资格层。
   */
  integrity: (owner: EntityRef) => Promise<MemoryIntegrityProblems>
  /**
   * **M5.1.1 / Phase 4b（ADR-043 §3.2）**：根证据受信读数的读取口。**必填**。
   *
   * 与 `integrity` **同一个理由**：让它可选等于允许忘记接线，而后果不是报错，
   * 是**每一条事实都被标成"来源未确立"** —— 一个看起来合理、实际全错的标签。
   * 必填之后"忘记接线"变成**编译错误**（`tsc` 就是这条链的枚举器）。
   *
   * 装配层只需传 `(ids) => rootReadingsByMemory(db, ids)`（`qualification-read.ts`）。
   */
  rootReadings: (
    memoryIds: readonly string[]
  ) => Promise<Map<string, (TrustedOriginReading | undefined)[]>>
  /** 单次检索最多扫描多少行（有界；默认跟随 store 的 500 上限） */
  scanCeiling?: number
  /**
   * **M9.5 / WP6（D26-④ + R3）**：语义探针（**可选**）。
   *
   * ```text
   * 与 `integrity` / `rootReadings` 相反，这里**故意可选** —— 因为"没有语义能力"
   * 是一个**合法状态**（计划 §9.3 的 `degraded_lexical`），而不是接线遗漏。
   * 不传 ⇒ 语义一律不可用（与今天的行为一字不变）。
   * ```
   *
   * ⚠️ 只有在 `retrievalPolicyVersion === 'hybrid-relevance@1'` 时才会调用它
   *    —— `off` 路径**不产生**语义调用（计划 S46：off 模式语义调用数 = 0）。
   */
  semanticProbe?: MemorySemanticProbe
  /** Semantic failure returns no hits; no lexical fallback or lexical ordering. */
  semanticOnly?: boolean
}

/** `store.list()` 自己的上限是 500（见 memory-store.ts），这里如实跟随 */
const STORE_MAX_LIMIT = 500

export function createMemoryRetrievalStore(
  options: MemoryRetrievalStoreOptions
): MemoryRetrievalPort {
  const integrity = options.integrity
  const readRoots = options.rootReadings
  const scanCeiling = options.scanCeiling ?? STORE_MAX_LIMIT
  /** ⚠️ 缺省 `undefined` ⇒ `orderCandidates` 用 `PROVISIONAL_HYBRID_POLICY`（生产行为不变） */
  const hybridPolicy = options.hybridPolicy

  return {
    name: 'native-memory-retrieval-store',

    async retrieve(query: MemoryRetrievalQuery): Promise<MemoryRetrievalResult> {
      const owner = entityRef('character', String(query.characterId))
      const scanLimit = Math.max(1, Math.min(scanCeiling, query.limit * 5))
      const byId = new Map<string, { record: MemoryRecord; channels: Set<string> }>()

      const add = (record: MemoryRecord, channel: string): void => {
        const key = String(record.id)
        const existing = byId.get(key)
        if (existing === undefined) {
          byId.set(key, { record, channels: new Set([channel]) })
          return
        }
        existing.channels.add(channel)
      }

      // --- 通道 ①subject：这个用户相关的记忆（宽召回主通道）-------------------
      const subject = query.targetSubject ?? query.user
      for (const record of await options.store.listBySubject(owner, subject)) {
        add(record, 'subject')
      }

      // --- 通道 ②recency：最近记住的 --------------------------------------
      // `explicitIds` 今天没有生产者（RECALL_CHANNEL_FACTS.explicit_id），
      // 但接口留着：它一旦有生产者，这条分支就是实现处。
      if (query.explicitIds !== undefined && query.explicitIds.length > 0) {
        for (const id of query.explicitIds) {
          const record = await options.store.get(id)
          if (record !== null) add(record, 'explicit_id')
        }
      }

      const kinds: readonly (MemoryType | undefined)[] =
        query.memoryKinds !== undefined ? [...query.memoryKinds] : [undefined]
      for (const kind of kinds) {
        const records = await options.store.list({
          owner,
          ...(kind !== undefined ? { type: kind } : {}),
          limit: scanLimit,
        })
        for (const record of records) add(record, 'recency')
      }

      // --- 通道 ③lexical：复用 M4.1 的实现（含登记表中文说明）----------------
      const scannedRecords = [...byId.values()].map((item) => item.record)
      const lexicalHits = options.semanticOnly ? [] : lexicalOverlapHits(query.text, scannedRecords)
      for (const record of lexicalHits) {
        add(record, 'lexical')
      }

      // --- 后置过滤：种类 / 时间（都只用公共纯函数）-------------------------
      const filtered = [...byId.values()].filter((item) => {
        if (query.memoryKinds !== undefined && !query.memoryKinds.includes(item.record.type)) {
          return false
        }
        return isWithinTimeScope({
          timeScope: query.timeScope,
          recordedAt: item.record.recordedAt,
          ...(item.record.occurredAt !== undefined ? { occurredAt: item.record.occurredAt } : {}),
        })
      })

      /*
       * ======================================================================
       *  M9.5 / WP6（ADR-074 的 D25）—— **排序之后才截断**
       * ======================================================================
       * ```text
       * 现状（WP0 实测的层④缺口）：候选按 `recordedAt` 降序 → `slice(0, limit)`，
       *   而 lexical 命中**只加通道标签、不参与排序** ⇒ 一条完美的词面命中，
       *   只要比最新的 limit 条旧，就在**资格层之前**被丢掉。
       *
       * 现在由**版本化的策略**决定顺序（`orderCandidates`，单一实现）：
       *   `lexical-recency@1`（**缺省**）= 新近度降序 + id 升序 —— 与改动前的比较元组**逐字相同**
       *   `hybrid-relevance@1`          = 相关性降序（词面命中优先）→ 新近度 → id
       * ⇒ 不传 `retrievalPolicyVersion` 时行为**一字不变**（D25 第 ③ 条）。
       * ```
       *
       * ⚠️ `semantic: null` 是**如实**的：派生索引与查询期编码尚未接线（WP6 的 N1/N2），
       *    因此**本次没有得到真实语义分数**。按 D26-④/R3，它不得被当成 0 分参与
       *    （那会让"伪启用"看起来像"分数很低"）。
       */
      const policyVersion = query.retrievalPolicyVersion ?? DEFAULT_RETRIEVAL_POLICY_VERSION
      /*
       * M9.5 / WP8：模式决定"算不算"与"能不能影响排序"**两件不同的事**。
       * 缺省由策略版本推导 ⇒ 不传 mode 的调用方行为一字不变。
       */
      const semanticMode = options.semanticOnly ? 'on' : query.semanticMode ?? defaultSemanticModeFor(policyVersion)
      /** 只有 `on` 才让语义分数**影响**排序；`shadow` 算了但不用（S47：prompt 输入不变） */
      const orderingPolicy: RetrievalPolicyVersion = semanticMode === 'on' ? 'hybrid-relevance@1' : 'lexical-recency@1'
      const lexicalHitSet = new Set(lexicalHits.map((record) => String(record.id)))

      /*
       * ======================================================================
       *  M9.5 / WP6（D26-④ + R3）—— 语义分数**只有真的拿到才算可用**
       * ======================================================================
       * ```text
       * · 只在 `hybrid-relevance@1` 下调用探针（`off` 的语义调用数必须 = 0）。
       * · 探针**具名失败**（timeout / model_missing / …）⇒ 记下原因，本轮**如实降级**，
       *   能力报告**仍然**把 semantic 列进 `unavailable`（`degraded_lexical`）。
       * · 探针成功但**一条分数都没有** ⇒ 按 R3 判 `missing_score`（**不是**"都是 0 分"）。
       *   ⇒ 这是"伪启用"的机器防线：没有分数就**不许**说可用。
       * ```
       */
      let semanticScores: ReadonlyMap<string, number> | null = null
      let semanticFailure: SemanticUnavailableReason | null = null
      if (semanticMode !== 'off' && options.semanticProbe !== undefined) {
        /*
         * ⚠️ **这段 try/catch 是 `L-M10-61` 的修法之一**（用户 2026-09-30 裁定）。
         *
         * 上面那段注释逐字写着设计意图：「探针**具名失败**（timeout / model_missing / …）
         * ⇒ 记下原因，本轮**如实降级**」。而**修前**这里只处理了 `probe.ok === false`，
         * **没处理"探针直接抛错"** —— 于是探针一抛（实测：缺表时 SELECT 抛，
         * 0 ms 返回），rejection 就从这里逃逸出去，聊天轮次**静默挂住**
         * （跨过 180s 就绪超时；`L-M10-61` 的根因链见交接单 §6.13）。
         *
         * ⇒ 现在：**抛错也走同一条降级路**。理由不是"防御式编程"，而是
         *   **它本来就该如此**：抛错与具名失败在调用点眼里是同一件事 ——
         *   "本轮拿不到语义分数"。契约要求探针**返回**具名失败，
         *   但调用点的义务是**如实降级**，不是"假设对方永远守约"。
         *
         * ⚠️ **一处词表局限（如实登记，不静默）**：`SemanticUnavailableReason` 五档
         *   （`not_indexed` / `model_missing` / `dimension_mismatch` / `timeout` /
         *   `generation_mismatch`）里**没有"探针内部错误"这一档**。
         *   兜底只能选最接近的 `not_indexed`（"没有可用的索引"—— 探针挂了确实等于没有）。
         *   ⇒ 要精确区分"没索引"与"探针坏了"就得动**契约词汇表**，
         *     那属 `L-M10-61` 的第三层（与"索引表该不该进迁移"同一类裁定），**不顺手改**。
         */
        try {
          const probe = await options.semanticProbe.score({
            characterId: query.characterId,
            text: query.text,
            memoryIds: filtered.map((item) => item.record.id),
          })
          if (probe.ok) {
            semanticScores = probe.scores.size > 0 ? probe.scores : null
            if (semanticScores === null) semanticFailure = 'missing_score'
          } else {
            semanticFailure = probe.reason
          }
        } catch (error) {
          /*
           * ⚠️ **不静默**：把原始错误留在日志里（否则下一个人只看得到 `not_indexed`，
           *    会以为"只是没建索引"，而真实原因可能是探针的另一个 bug）。
           */
          console.warn(
            `[recall] 语义探针抛错（契约要求它返回具名失败）⇒ 本轮如实降级：` +
              `${error instanceof Error ? error.message : String(error)}`
          )
          semanticFailure = 'not_indexed'
        }
      } else if (semanticMode !== 'off') {
        /* 没接探针 ⇒ 与"探针报 model_missing"区分开：这是**未启用** */
        semanticFailure = 'not_indexed'
      }

      const asOrderables = (): { memoryId: string; recency: number; lexical: number; semantic: number | null }[] =>
        filtered.map((item) => ({
          memoryId: String(item.record.id),
          recency: item.record.recordedAt,
          /*
           * M9.5 / `D-5`（`ADR-083` 第 ② 步）：**词面强度**，不再二值。
           *
           * ⚠️ 选项**刻意与命中判定同一份**（`:177` 的 `lexicalOverlapHits(query.text, …)` 用缺省
           *    `includeRegistrySurfaceForms = true`）⇒ "判为命中"与"强度 > 0"必然一致 ✓
           * ⚠️ 为什么改：二值下"精确命中"与"偶然弱重叠"同分 ⇒ 提高词面权重会同时抬高两者 ⇒
           *    `A1`（压过语义 0.99 诱饵）与 `A5`（改述不被弱重叠压过）**无交集**；
           *    带强度后两者可分（实测最小达标权重 **1.5**，A5 不再牺牲）。
           */
          lexical: options.semanticOnly ? 0 : lexicalOverlapStrength(query.text, item.record),
          semantic: semanticScores?.get(String(item.record.id)) ?? null,
        }))

      const orderedIds = options.semanticOnly ? asOrderables()
        .filter((item) => item.semantic !== null && Number.isFinite(item.semantic))
        .sort((a, b) => b.semantic! - a.semantic! || a.memoryId.localeCompare(b.memoryId)) : orderCandidates({
        candidates: asOrderables(),
        policyVersion: orderingPolicy,
        ...(hybridPolicy !== undefined ? { hybridPolicy } : {}),
      })
      /*
       * `shadow`：把"如果开启会是什么顺序"也**算出来**（计划的"比较新旧检索"），
       * 但**不用它** —— 实际使用的是上面那条 `orderingPolicy` 的结果。
       * 只记 id 与计数，不记任何正文（隐私边界）。
       */
      const shadow =
        semanticMode === 'shadow' && semanticScores !== null
          ? (() => {
              const legacy = orderCandidates({ candidates: asOrderables(), policyVersion: 'lexical-recency@1' })
              const hybrid = orderCandidates({
                candidates: asOrderables(),
                policyVersion: 'hybrid-relevance@1',
                ...(hybridPolicy !== undefined ? { hybridPolicy } : {}),
              })
              return {
                legacyOrderIds: legacy.map((item) => item.memoryId),
                hybridOrderIds: hybrid.map((item) => item.memoryId),
                topChanged: (legacy[0]?.memoryId ?? null) !== (hybrid[0]?.memoryId ?? null),
              }
            })()
          : null
      const byMemoryId = new Map(filtered.map((item) => [String(item.record.id), item]))

      /*
       * M5.1.1 / Phase 4b（ADR-043 §3.2）：把命中行的**根证据受信读数**取上来。
       *
       * 只对**这一批命中**取（有界：`query.limit`），而且是**纯 SELECT**。
       * 读数只由 `qualification-read.ts` 组装（那里复用 4a 的
       * `trustedOriginReadingOf()`），本适配器**不**自己判"什么算已确立"。
       *
       * ⚠️ 取不到就**不编**：读数缺失 ⇒ 下游派生为"来源未确立"（`DR-7` 失败关闭）。
       */
      const selected = orderedIds
        .slice(0, query.limit)
        .map((item) => byMemoryId.get(item.memoryId))
        .filter((item): item is NonNullable<typeof item> => item !== undefined)
      const readings = await readRoots(selected.map((item) => String(item.record.id)))
      const hits: MemoryRetrievalHit[] = selected.map((item) => {
        const memoryId = String(item.record.id)
        const channels = new Set<string>(options.semanticOnly ? [] : item.channels)
        /*
         * **只有真的拿到这一条的语义分数**才加 `semantic` 通道标签。
         * 加标签的条件与"能力报告说可用"共用同一个事实（下面 `semanticScores`）——
         * 两处若各判一次，就会出现"报告说可用、候选却没打标签"的伪启用（D25 第 ④ 条）。
         */
        if (semanticScores?.has(memoryId) === true) channels.add('semantic')
        const semanticScore = semanticScores?.get(memoryId)
        return {
          record: item.record,
          channels: [...channels].sort() as MemoryRetrievalHit['channels'],
          rootReadings: readings.get(memoryId) ?? [],
          /* ⚠️ 分数与标签**同源**：都由 `semanticScores` 决定（D25 第 ④ 条） */
          ...(semanticScore !== undefined ? { semanticScore } : {}),
        }
      })

      const problems = await integrity(owner)
      const brokenMemoryIds = [
        ...new Set([
          ...problems.memoriesWithoutLiveEvidence.map((item) => item.memoryId),
          ...problems.memoriesWithoutLiveEvents.map((item) => item.memoryId),
        ]),
      ]

      return {
        hits,
        /* R3：`semantic` 进不进 `available` **只由"本次是否真拿到分数"决定** */
        capabilities: buildCapabilities(
          semanticScores !== null ? { available: true } : { available: false, reason: semanticFailure }, options.semanticOnly
        ),
        /*
         * M9.5 / WP7：把"这一轮真的拿到分数的是哪几条"如实报上去。
         * ⚠️ 它与 `capabilities.available` 是本轮**同一次**只读事实的两个投影 ——
         *    所以"说可用却 0 条参与"在 trace 里立刻看得见。
         */
        semanticScoredIds: semanticScores === null ? [] : [...semanticScores.keys()],
        /* M9.5 / WP8：`shadow` 的对照读数（**只记 id 与计数，不记正文**） */
        ...(shadow !== null ? { shadow } : {}),
        scanned: byId.size,
        brokenMemoryIds,
      }
    },
  }
}

/**
 * 能力报告 —— AT3.2 要求"支持现有项目**能够可靠提供**的检索维度"。
 *
 * ⚠️ **M9.5 / WP6 的改动（D26-④ + R3）**：`semantic` 不再无条件写死成不可用。
 *    它现在**由本次是否真的拿到分数决定**：
 *
 * ```text
 * scoresAvailable = true  ⇒ `semantic` 进 `available`（且候选上已有 semantic 通道标签）
 * scoresAvailable = false ⇒ 进 `unavailable`，并带上**具名原因**
 *                           （timeout / model_missing / missing_score / …）
 * ```
 *
 * 为什么必须这样：附录 C 的 R3 说得直白 —— 只把能力标志改成 available 会得到一个
 * **永不参与、却在 trace 里看起来已启用**的通道，而那种伪启用**正负控都测不出来**。
 * 把"标志"与"分数"绑成同一件事之后，伪启用就变成**不可能**（不是"不推荐"）。
 */
function buildCapabilities(
  semantic: { readonly available: true } | { readonly available: false; readonly reason: SemanticUnavailableReason | null },
  semanticOnly = false
): MemoryRetrievalCapabilities {
  const base: MemoryRetrievalDimension[] = semanticOnly ? ['time', 'kind'] : ['subject', 'recency', 'lexical', 'time', 'kind']
  if (semantic.available) {
    return { available: [...base, 'semantic'], unavailable: [] }
  }
  return {
    available: base,
    unavailable: [
      { dimension: 'semantic', reason: semantic.reason ?? SEMANTIC_UNAVAILABLE_REASON },
    ],
  }
}
