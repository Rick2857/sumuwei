/**
 * M5 WP3 —— **Recall 应用服务**（查询翻译 + 命中 → 候选 + 接资格层）。
 *
 * ============================================================================
 *  它在整条链里的位置
 * ============================================================================
 *     RecallRequest（WP1 契约）
 *            ↓  translate()            ← AT3.1 查询翻译
 *     MemoryRetrievalQuery（后端无关）
 *            ↓  port.retrieve()        ← WP3 适配器（只读，宽召回）
 *     MemoryRetrievalHit[]
 *            ↓  toCandidate()          ← 记录 → RecallCandidate（渲染在 recall/render.ts）
 *     RecallCandidate[]
 *            ↓  filterEligible()       ← WP2 资格层（AT3.4）
 *     EligibilityBatch
 *
 * 它**不**排序、**不**裁剪预算、**不**改任何表（计划书 WP3 Forbidden）。
 *
 * ---------------------------------------------------------------------------
 *  为什么放在 kernel/app/（而不是 kernel/recall/）
 * ---------------------------------------------------------------------------
 * 纯判定（资格、渲染、端口形状）在 `kernel/recall/**`，它们只依赖契约。
 * 而"翻译 + 装配 + 调端口"是**应用层**的事 —— 与 `kernel/app/memory/**`
 * 同一层。这保持了那个目录的纪律：`kernel/recall/**` 里不许出现 IO 概念。
 *
 * ---------------------------------------------------------------------------
 *  一个必须写下来的交互（第三人目标）
 * ---------------------------------------------------------------------------
 * 如果 `target` 解析到了一个**第三人**（当前数据模型里几乎不可能：M4 的
 * subject 域只有 USER / CHARACTER），那么 WP2 的 `WRONG_USER` 闸（"subjects
 * 必须含本次请求的用户"）会让这一轮召回为空。用户 2026-09-17 的 G2 裁定正是
 * 接受这个结果（"不要硬造第三人；Scenario E 只验证 unresolved → 不召回"）。
 * 这里不为了"让第三人也能召回"而放宽资格层 —— 那需要先扩 Entity Model，
 * 属于独立里程碑。
 */

import type { MemoryRecord } from '../../contracts/memory.ts'
import { slotOfRecord } from '../../contracts/memory.ts'
import type { RecallCandidate, RecallChannel, RecallRequest } from '../../contracts/recall.ts'
import {
  COGNITIVE_QUALIFICATION_RULE_VERSION,
  type SourceQualification,
} from '../../contracts/attribution.ts'
import { memoryQualificationOf } from '../../recall/qualification.ts'
import {
  filterEligible,
  type EligibilityBatch,
  type RecallEligibilityPolicy,
} from '../../recall/eligibility.ts'
import {
  memoryDataText,
  memoryPredicateOf,
  memorySearchableText,
} from '../../recall/render.ts'
import type {
  MemoryRetrievalCapabilities,
  MemoryRetrievalHit,
  MemoryRetrievalPort,
  MemoryRetrievalQuery,
} from '../../recall/ports.ts'

export interface MemoryRecallServiceOptions {
  port: MemoryRetrievalPort
  /**
   * 观测钩子：每次取候选后回调一次（**不含正文**）。
   * WP7 会用它写 trace 的 candidate_count / channels / capabilities。
   */
  onRetrieved?: (info: {
    scanned: number
    candidateCount: number
    capabilities: MemoryRetrievalCapabilities
    brokenCount: number
  }) => void
}

export interface RecallCandidatesResult {
  candidates: readonly RecallCandidate[]
  capabilities: MemoryRetrievalCapabilities
  scanned: number
  /** **M9.5 / WP7**：本次真的拿到语义分数的 memoryId 列表（不可用 / 未启用时为空） */
  semanticScoredIds: readonly string[]
}

export interface MemoryRecallService {
  readonly portName: string
  /** AT3.1：RecallRequest → 后端无关的查询 */
  translate(request: RecallRequest): MemoryRetrievalQuery
  /** AT3.3：统一输出 RecallCandidate[] */
  retrieveCandidates(request: RecallRequest): Promise<RecallCandidatesResult>
  /** AT3.4：取候选 + 接资格层（一次调用拿到两段结果，便于链路测试） */
  recall(input: {
    request: RecallRequest
    policy?: RecallEligibilityPolicy
    withdrawnEventIds?: ReadonlySet<string>
  }): Promise<RecallCandidatesResult & { eligibility: EligibilityBatch }>
}

export function createMemoryRecallService(
  options: MemoryRecallServiceOptions
): MemoryRecallService {
  const translate = (request: RecallRequest): MemoryRetrievalQuery => {
    const target = request.target
    return {
      traceId: request.traceId,
      characterId: request.characterId,
      user: request.user,
      ...(target.status === 'resolved' ? { targetSubject: target.subject } : {}),
      text: request.query.text,
      ...(request.memoryKinds !== undefined ? { memoryKinds: request.memoryKinds } : {}),
      timeScope: request.timeScope,
      /* U1 / ADR-138：作用域三元组透传（缺省 ⇒ 字段不出现 ⇒ 行为一字不变） */
      ...(request.scope !== undefined ? { scope: request.scope } : {}),
      limit: request.candidateLimit,
      /* M9.5 / WP6（D25）：策略版本透传给适配器；缺省 ⇒ 字段不出现 ⇒ 现状不变 */
      ...(request.retrievalPolicyVersion !== undefined
        ? { retrievalPolicyVersion: request.retrievalPolicyVersion }
        : {}),
      /* M9.5 / WP8：模式同样透传（缺省 ⇒ 字段不出现 ⇒ 由策略版本推导） */
      ...(request.semanticMode !== undefined ? { semanticMode: request.semanticMode } : {}),
    }
  }

  const retrieveCandidates = async (request: RecallRequest): Promise<RecallCandidatesResult> => {
    const result = await options.port.retrieve(translate(request))
    const broken = new Set(result.brokenMemoryIds.map(String))
    const candidates = result.hits.map((hit) => toCandidate(hit, broken))

    options.onRetrieved?.({
      scanned: result.scanned,
      candidateCount: candidates.length,
      capabilities: result.capabilities,
      brokenCount: broken.size,
    })

    return {
      candidates,
      capabilities: result.capabilities,
      scanned: result.scanned,
      /* M9.5 / WP7：语义用量如实透传（不可用时端口给空数组） */
      semanticScoredIds: result.semanticScoredIds,
    }
  }

  return {
    portName: options.port.name,
    translate,
    retrieveCandidates,
    async recall(input) {
      const retrieved = await retrieveCandidates(input.request)
      const eligibility = filterEligible({
        request: input.request,
        candidates: retrieved.candidates,
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
        ...(input.withdrawnEventIds !== undefined ? { withdrawnEventIds: input.withdrawnEventIds } : {}),
      })
      return { ...retrieved, eligibility }
    },
  }
}

/**
 * 命中 → 候选（**唯一**的映射处）。
 *
 * ⚠️ `integrityOk` **只**来自适配器带回的 M5-PRE 探针结论，
 *    这里不许再判一次"证据还在不在"。
 */
function toCandidate(hit: MemoryRetrievalHit, broken: ReadonlySet<string>): RecallCandidate {
  const record: MemoryRecord = hit.record
  const predicate = memoryPredicateOf(record)
  /*
   * 槽位（canonicalKey + 取值指纹）在这里算一次，用的是 **M4 的 `slotOfRecord`**：
   * "两条记忆是不是同一个槽位"只能有这一处定义。WP4 只拿到渲染后的文本，
   * 自己凑指纹会让去重与 M4 的冲突检测漂移。
   */
  const slot = slotOfRecord(record)
  return {
    memoryId: record.id,
    ...(hit.authorization === undefined ? {} : { authorization: hit.authorization }),
    owner: record.owner,
    type: record.type,
    status: record.status,
    authority: record.authority,
    epistemicStatus: record.epistemicStatus,
    subjects: record.subjects,
    importance: record.importance,
    confidence: record.confidence,
    recordedAt: record.recordedAt,
    ...(record.occurredAt !== undefined ? { occurredAt: record.occurredAt } : {}),
    ...(record.validFrom !== undefined ? { validFrom: record.validFrom } : {}),
    ...(record.validUntil !== undefined ? { validUntil: record.validUntil } : {}),
    ...(slot !== undefined
      ? { canonicalKey: slot.canonicalKey, slotFingerprint: slot.slotFingerprint }
      : {}),
    contentFingerprint: record.contentFingerprint,
    ...(predicate !== undefined ? { predicate } : {}),
    searchable: memorySearchableText(record),
    dataText: memoryDataText(record),
    sourceRefs: record.sourceRefs,
    retrievedBy: hit.channels as readonly RecallChannel[],
    integrityOk: !broken.has(String(record.id)),
    /*
     * 后 Lv2 · 用户 2026-10-03（选项 a 步骤 2）：把**真实语义分数**带给排序器。
     * ⚠️ 只有真的拿到分数才有这个字段 ⇒ 排序器可以做**数值判断**，
     *    而不是靠 `retrievedBy` 里的标签（标签只说明"有分数"，不说明"有关系"）。
     */
    ...(hit.semanticScore !== undefined ? { semanticScore: hit.semanticScore } : {}),
    /*
     * M5.1.1 / Phase 4b（ADR-043 §3.2）：**当前资格**在这里派生一次。
     *
     * 派生函数住在 `kernel/recall/qualification.ts`（纯函数），它的输入只有
     * "记忆类型 + 各根证据的受信读数 + 规则版本" —— 适配器负责取读数，
     * 这里负责判定，**两件事不分家也不重复**。
     *
     * ⚠️ Episode 面返回 `undefined`（DR-5：不进本规则）⇒ 排序与 prompt 标签
     *    都不会因为它而变化。
     */
    ...((): { qualification?: SourceQualification } => {
      const qualification = memoryQualificationOf({
        memoryType: record.type,
        rootReadings: hit.rootReadings,
        ruleVersion: COGNITIVE_QUALIFICATION_RULE_VERSION,
      })
      return qualification !== undefined ? { qualification } : {}
    })(),
  }
}
