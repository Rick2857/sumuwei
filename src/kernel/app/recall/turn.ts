/**
 * M5 WP6 —— **轮次级召回端口**（把 WP3+WP2+WP4+WP5 串成一次调用）。
 *
 * ============================================================================
 *  它是那条链的胶水，而且只有这一处
 * ============================================================================
 *     RecallRequest（WP1）
 *       → service.recall()        WP3 适配器 + WP2 资格层
 *       → rankCandidates()        WP4 排序 / 冲突 / 去重
 *       → selectMemoryContext()   WP5 预算选择
 *       → MemoryContextSelection{ blockText, bundle, decisions }
 *
 * 为什么必须在**一处**做这个组合：上面四步各自的先后与参数
 * （哪些候选能进排序、预算从哪来、量化器是谁）如果散落在调用点，
 * 迟早会出现"某一轮漏了资格层"这种不报错的缺陷 ——
 * 而那正是 M5 最不能出的错（跨用户泄漏）。
 *
 * ⚠️ 端口只暴露**两样**给调用方（`turn-gateway`）：
 *    · `blockText` —— 原样注入的数据块（空串 = 这轮没有召回）
 *    · `trace`     —— 进 trace 的**安全形态**（id / 计数 / 理由分布，无正文）
 *    于是"忘了用安全形态"这件事在类型上就写不出来。
 */

import type { RecallBudgetAccount, RecallRequest } from '../../contracts/recall.ts'
import {
  DEFAULT_RETRIEVAL_POLICY_VERSION,
  RECALL_EXCLUSION_REASON_FACTS,
  defaultSemanticModeFor,
  type RecallExclusionReason,
  type RetrievalPolicyVersion,
  type SemanticMode,
} from '../../contracts/recall.ts'
import {
  dispositionsFromDecisions,
  type CandidateDisposition,
} from './accounting.ts'
import {
  serializeContextBundleForTrace,
  type ContextBundleTraceView,
} from '../../contracts/recall.ts'
import type { MemoryRecallService } from './retrieval.ts'
import {
  rankCandidates,
  DEFAULT_RECALL_RANKING_POLICY,
  type RecallRankingPolicy,
} from '../../recall/ranking.ts'
import {
  selectMemoryContext,
  type ContextBudget,
  type MemoryContextSelection,
  type TokenQuantifier,
} from '../../recall/selector.ts'
import {
  buildRecallDecisionRecord,
  withScanned,
  type RecallDecisionFact,
  type RecallDecisionRecord,
} from '../../recall/record.ts'

export interface RecallTurnTrace {
  /** 检索阶段扫描过的行数（"宽召回到底有多宽"） */
  scanned: number
  candidateCount: number
  eligibleCount: number
  selectedIds: string[]
  /** 每个排除理由命中的候选数（WP7 的 retrieval metrics 直接用它） */
  exclusionHistogram: Record<string, number>
  droppedByBudget: number
  account: RecallBudgetAccount
  /**
   * **M9.5 / WP7（D25 第 ④ 条的配套）**：本次**真的拿到语义分数**的候选条数。
   *
   * ```text
   * ⚠️ 它与 `semanticUsedIds` 一起，让"语义到底有没有参与"在 trace 里**可分辨**：
   *      `semanticScoredCount = 0`   ⇒ 这一轮根本没用到语义（未启用 / 不可用）
   *      `semanticScoredCount > 0`   ⇒ 真的算了分数；再看有几条**真的入了模**
   *    没有这两个数时，"available=true 却一条都没用"与"正常使用"长得一样（伪启用）。
   * ```
   */
  semanticScoredCount: number
  /** 其中**真的进了上下文**的那些 memoryId（最终使用集合里的语义子集） */
  semanticUsedIds: string[]
  /**
   * **M9.5 / WP7（N2）**：**每条候选的去向**（由链路自己的判定与决策产出）。
   *
   * ```text
   * 覆盖全部候选：资格层未通过的来自 `verdicts`（它们不进选择器），
   * 其余来自 `selection.decisions`。映射是**机械的**（理由已唯一决定阶段），
   * 这里不重新判一次 —— 重判就是"判断散落"。
   *
   * ⇒ `checkDispositions()` 因此在**真实链路**上有输入可判，而不是只在合成数据上跑。
   * ```
   */
  dispositions: CandidateDisposition[]
  /**
   * **M9.5 / WP7·WP8（计划 §4.4 第 1 条）**：本次**生效的**调用版本与模式。
   *
   * ```text
   * "调用版本"是交给 M10/M11 的稳定边界之一 —— 消费方必须能说出
   * "这次结果是用哪一套策略、哪一档模式得到的"，否则事后无法解释两次不同读数的差异。
   * 记录的是**生效值**（由缺省推导之后），不是请求里那个可选字段。
   * ⚠️ 只有枚举字符串，**不含**任何正文。
   * ```
   */
  retrievalPolicyVersion: RetrievalPolicyVersion
  semanticMode: SemanticMode
}

export interface RecallTurnOutcome {
  selection: MemoryContextSelection
  /** 进 trace 的形态（`serializeContextBundleForTrace` 保证不含正文） */
  bundleTrace: ContextBundleTraceView
  /**
   * WP7 的 `RecallDecisionRecord`（**无正文、有界**）。
   *
   * ⚠️ `selectedIds` 在**这一步**表示"选择器选中的"；真正进 packet 的结果
   *    由网关在编译器之后用 `applyContextReality()` 修正 ——
   *    因为记忆 section 是可裁的，编译器才是最终的裁剪者。
   */
  record: RecallDecisionRecord
  trace: RecallTurnTrace
}

export interface RecallTurnPort {
  /** 这一轮想起了什么。**只读**：端口契约要求实现不得写任何表 */
  run(request: RecallRequest, withdrawnEventIds?: ReadonlySet<string>): Promise<RecallTurnOutcome>
}

export interface RecallTurnPortOptions {
  service: MemoryRecallService
  budget: ContextBudget
  policy?: RecallRankingPolicy
  quantifier?: TokenQuantifier
  injectionLimit?: number
  /** 注入时钟（排序器与 bundle 都不读时钟，否则不可复现） */
  now: () => number
  semanticOnly?: boolean
}

export function createRecallTurnPort(options: RecallTurnPortOptions): RecallTurnPort {
  return {
    async run(incomingRequest: RecallRequest, withdrawnEventIds?: ReadonlySet<string>): Promise<RecallTurnOutcome> {
      const request = options.semanticOnly ? { ...incomingRequest, semanticMode: 'on' as const } : incomingRequest
      const recalled = await options.service.recall({
        request,
        ...(withdrawnEventIds !== undefined ? { withdrawnEventIds } : {}),
        // 预算同时进请求（WP3 的候选上限与它无关，但记录意图）与选择器（真正的约束）
      })

      const ranked = rankCandidates({
        request,
        candidates: recalled.eligibility.eligible,
        capabilities: recalled.capabilities,
        now: options.now(),
        ...(options.semanticOnly ? { policy: { ...(options.policy ?? DEFAULT_RECALL_RANKING_POLICY), semanticOnly: true,
          sharedExperienceRecall: false, minTotal: 0, weights: { lexical: 0, semantic: 1, entity: 0, temporal: 0, salience: 0, authority: 0, intentFit: 0 } } }
          : options.policy !== undefined ? { policy: options.policy } : {}),
      })

      const selection = selectMemoryContext({
        request,
        ranked: ranked.ranked,
        budget: options.budget,
        ...(options.injectionLimit !== undefined ? { injectionLimit: options.injectionLimit } : {}),
        ...(options.quantifier !== undefined ? { quantifier: options.quantifier } : {}),
        now: options.now(),
      })

      const bundleTrace = serializeContextBundleForTrace(selection.bundle)
      const exclusionHistogram: Record<string, number> = { ...bundleTrace.exclusionHistogram }
      for (const decision of ranked.decisions) {
        if (decision.reason === undefined) continue
        exclusionHistogram[decision.reason] = (exclusionHistogram[decision.reason] ?? 0) + 1
      }

      /*
       * 决策全集：**每一条候选恰好出现一次**。
       *   ① 资格层被拒的（不在 ranked 里）
       *   ② 排序/去重淘汰的（在 ranked.decisions 里）
       *   ③ 通过资格的那些：选中的 或 被预算裁掉的（在 ranked.ranked 里）
       * 少了任何一支，trace 就会回答不了"剩下的那些去哪了"。
       */
      const selectedIds = selection.entries.map((entry) => entry.memoryId)
      const selectedSet = new Set(selectedIds)
      const scoreByMemoryId = new Map(
        ranked.ranked.map((item) => [String(item.candidate.memoryId), item.score])
      )
      const budgetReasonById = new Map(
        selection.decisions.map((decision) => [String(decision.memoryId), decision.reason])
      )

      const decisions: RecallDecisionFact[] = []
      for (const item of recalled.eligibility.verdicts) {
        if (item.verdict.eligible) continue
        decisions.push({
          memoryId: String(item.candidate.memoryId),
          eligible: false,
          ...(item.verdict.reason !== undefined ? { reason: item.verdict.reason } : {}),
          selected: false,
        })
      }
      for (const decision of ranked.decisions) {
        const memoryId = String(decision.memoryId)
        decisions.push({
          memoryId,
          eligible: true,
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
          selected: false,
          ...(scoreByMemoryId.get(memoryId) !== undefined ? { score: scoreByMemoryId.get(memoryId)! } : {}),
        })
      }
      for (const item of ranked.ranked) {
        const memoryId = String(item.candidate.memoryId)
        const selected = selectedSet.has(memoryId)
        decisions.push({
          memoryId,
          eligible: true,
          selected,
          ...(selected ? {} : { reason: budgetReasonById.get(memoryId) ?? 'BUDGET_EXHAUSTED' }),
          score: item.score,
        })
      }

      const record = withScanned(
        buildRecallDecisionRecord({
          traceId: String(request.traceId),
          characterId: String(request.characterId),
          user: request.user,
          request,
          generatedAt: options.now(),
          candidates: recalled.candidates.map((candidate) => ({
            memoryId: candidate.memoryId,
            channels: candidate.retrievedBy,
            type: candidate.type,
            status: candidate.status,
            authority: candidate.authority,
            epistemicStatus: candidate.epistemicStatus,
            importance: candidate.importance,
            integrityOk: candidate.integrityOk,
            ...(candidate.canonicalKey !== undefined ? { canonicalKey: candidate.canonicalKey } : {}),
            contentFingerprint: candidate.contentFingerprint,
          })),
          decisions,
          selectedIds,
          selectedFingerprints: selection.bundle.selected.map((item) => item.contentFingerprint),
          budget: selection.bundle.budget,
          scored: ranked.ranked.map((item) => ({
            memoryId: String(item.candidate.memoryId),
            total: item.score.total,
          })),
          /*
           * 这里只能声明"**选择器产出了非空块**" —— 它是否真的进了 packet
           * 由网关在编译器之后用 `applyContextReality()` 修正。
           * 这一步不做假声明，是因为编译器才是最终裁剪者。
           */
          reachedContext: selectedIds.length > 0,
          /*
           * **M9.5 / `WP8`（甲-1）**：与模式**无关**的语义读数 ⇒ 进记录 ⇒ 进 trace ✓
           *
           * ⚠️ 为什么必须与模式无关：`shadow` 期靠 `shadow?` 那份对照观察这个通道，
           *    而切到 `on` 之后那份**不再产出** ⇒ **激活反而让通道看不见了** ✗
           * ⚠️ 这两个值**召回路本来就算过**（见下方 `semanticScored` / `effectiveSemanticMode`），
           *    只是没进记录 ⇒ 这里**内联**算一次（避免把 `:253-256` 上移造成的无关 diff ✓）
           * ⚠️ `participated`：**真的算了分**且**模式是 `on`**（`shadow` 只算不用 ⇒ false ✓）
           */
          semantic: (() => {
            const mode =
              request.semanticMode ??
              defaultSemanticModeFor(request.retrievalPolicyVersion ?? DEFAULT_RETRIEVAL_POLICY_VERSION)
            const scoredCount = recalled.semanticScoredIds.length
            return { mode, scoredCount, participated: scoredCount > 0 && mode === 'on' }
          })(),
        }),
        recalled.scanned
      )

      const semanticScored = new Set(recalled.semanticScoredIds)
      /* 生效值：缺省由策略版本推导（与 `memory-retrieval-store` 同一处定义） */
      const effectivePolicyVersion = request.retrievalPolicyVersion ?? DEFAULT_RETRIEVAL_POLICY_VERSION
      const effectiveSemanticMode = request.semanticMode ?? defaultSemanticModeFor(effectivePolicyVersion)
      return {
        selection,
        bundleTrace,
        record,
        trace: {
          scanned: recalled.scanned,
          candidateCount: recalled.candidates.length,
          eligibleCount: recalled.eligibility.eligible.length,
          selectedIds,
          exclusionHistogram,
          droppedByBudget: selection.decisions.filter((d) => d.reason === 'BUDGET_EXHAUSTED').length,
          account: selection.bundle.budget,
          /*
           * M9.5 / WP7：语义用量。计数由名单长度派生（一份事实、两处投影）。
           * `semanticUsedIds` = 算了分**且**真的进了上下文 —— 这就是
           * 「最终使用集合」里的语义子集（对齐 WP7 的"语义候选参与了但没有入模"必须可见）。
           */
          semanticScoredCount: semanticScored.size,
          semanticUsedIds: selectedIds.filter((id) => semanticScored.has(id)),
          /*
           * M9.5 / WP7·WP8：**生效的**版本与模式（由缺省推导之后）。
           * 与检索店用的是同一个 `defaultSemanticModeFor()` —— 一处定义、两处消费。
           */
          retrievalPolicyVersion: effectivePolicyVersion,
          semanticMode: effectiveSemanticMode,
          /*
           * M9.5 / WP7（N2）：去向表由**链路自己**的判定与决策产出。
           * `stageOf` 直接读契约的理由事实表 —— 不在这里重判阶段
           * （重判会让"资格拒绝"与"排序淘汰"漂移，而两者修法完全不同）。
           */
          dispositions: [
            ...dispositionsFromDecisions({
              /* ★ 复用装配层那张**完整**的决策表（不另造一份，免得两张表漂移） */
              decisions,
              stageOf: (reason) =>
                RECALL_EXCLUSION_REASON_FACTS[reason as RecallExclusionReason].stage,
            }),
          ],
        },
      }
    },
  }
}
