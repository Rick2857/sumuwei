/**
 * belief-memory-reconciler —— B-REPORTED 的产出者 + Memory 失效触发收集
 * （M9 WP5 / ADR-070 §6.3 / 计划 §8.3）。
 *
 * ============================================================================
 *  职责边界（两条产出路径各有其规则，不混用）
 * ============================================================================
 * · 形成路径：Memory 事件流里的 CREATED/RESTORED → 查当前 Memory 状态 →
 *   `isBeliefReportedEligible`（claim 家族 + EXPLICIT 权威档 + reported +
 *   active，D04 白名单）→ 构造 `BELIEF_FORMED(reported)` **提案**。
 *   本模块**不落库**——提案走 `validateBeliefProposal`（唯一放行口），
 *   由调用方（WP6 调度器 / 门）在事务里 append。
 * · 失效路径：RETRACTED/SUPERSEDED/MERGED(loser) → 收集失效的 memoryId，
 *   交给 `revision.ts` 的 `planMemoryInvalidation` 产出 RETRACTED 提案。
 *   **读侧不因事件直接改投影**——修订必须走合法提案链（§7.1 双保险的
 *   写侧半边；读侧半边是 `eligibility.ts` 的回查遮蔽）。
 *
 * ---------------------------------------------------------------------------
 *  幂等与去重（§8.4：两层幂等的领域操作键层）
 * ---------------------------------------------------------------------------
 * 同一 Memory 重复出现在不同窗口（重试 / catch-up / 尾部补消费）⇒
 * `beliefReportedFormationKeyOf([memoryId])` 相同 ⇒ beliefId 相同 ⇒
 * `belief-formed:<beliefId>` 幂等键相同 ⇒ 放行口撞 `duplicate_operation`。
 * 本模块**不自己记已处理清单**——水位（WP6）+ 幂等键就是去重面；
 * 这里只做一件减废提案的事：同槽位已有**同值** active ⇒ 不再提案
 * （那是 REINFORCED 的语义，reported v1 不做跨 Memory 强化）。
 *
 * ---------------------------------------------------------------------------
 *  不做清单（v1 边界，交接单登记）
 * ---------------------------------------------------------------------------
 * · 不从 Memory 正文猜命题——只用 claim 的结构化槽位（subject/predicate/
 *   value/qualifiers）；episode 家族不在白名单，永远不产提案。
 * · 不做跨 Memory 聚合（多条 Memory 合并成一个信念）——一条 Memory 一个
 *   依赖；`dependsOnMemoryIds` 的多元素形态留给未来版本。
 * · MEMORY_DISPUTED 不触发任何动作（争议中的 Memory 仍是 active；
 *   读侧回查会按当前资格处理，不抢写侧的裁定）。
 */
import {
  BELIEF_REPORTED_RULE_ID,
  BELIEF_REPORTED_RULE_VERSION,
  beliefReportedFormationKeyOf,
  beliefReportedDependencyTokenOf,
  beliefReportedScopeKeyOf,
  beliefSlotKeyOf,
  isBeliefReportedEligible,
  makeBeliefId,
  type BeliefFormedPayload,
  type BeliefState,
} from '../../contracts/belief.ts'
import {
  MEMORY_CREATED,
  MEMORY_MERGED,
  MEMORY_RETRACTED,
  MEMORY_RESTORED,
  MEMORY_SUPERSEDED,
  type DomainProposal,
} from '../../contracts/index.ts'
import type { MemoryId } from '../../contracts/ids.ts'
import { isClaimContent, type MemoryAuthority, type MemoryContent, type MemoryType } from '../../contracts/memory.ts'
import type { EntityRef } from '../../contracts/entity.ts'

// ---------------------------------------------------------------------------
// 端口（装配层注入；本层不认识 SQL）
// ---------------------------------------------------------------------------

/** Memory 当前状态视图（reconciler 需要的最小面） */
export interface ReconcilerMemoryView {
  id: MemoryId
  /** 拥有者（memory 子系统约定：owner.id 即 characterId） */
  ownerId: string
  type: MemoryType
  authority: MemoryAuthority
  epistemicStatus: string
  status: string
  content: MemoryContent
  /** 这条 Memory 的证据根（reported 信念的 evidenceRootIds 溯源面） */
  evidenceRootIds: string[]
  /**
   * 记录 revision（M9.1 WP8 / F-5）。`> 1` = 这条 Memory 被复活/改写过 ⇒
   * 再形成要并入身份分量，产出**新 beliefId**（ADR-072 `D13`）。
   *
   * ⚠️ 生产装配（`belief-scheduler.ts`）**必须**提供；缺省 `1` 只为测试假件与
   * M9 基线身份兼容（缺省 = 裸 id 分量，与基线逐字节同形）。
   */
  revision?: number
}

export interface BeliefReconcilerDeps {
  characterId: string
  /** processor 身份（幂等键分量；WP6 装配时 = 'belief-memory-reconciler'） */
  processor: string
  processorVersion: string
  /** 批量读 Memory 当前状态（按确切 id，不走检索排名——§7.2） */
  memory: {
    findMemories(ids: readonly MemoryId[]): Promise<ReconcilerMemoryView[]>
  }
  /** 同槽位 active 信念（减废提案的同值预检；真正的闸在放行口） */
  belief: {
    listActiveBeliefsForSlot(characterId: string, slotKey: string): Promise<BeliefState[]>
  }
}

/** Memory 事件窗口里的一条（最小触发面：什么变了、变的是哪条） */
export interface MemoryEventTrigger {
  type: string
  memoryId: string
  sequence: number
}

/** 一个窗口的 reconcile 结果：形成提案 + 失效触发（交给 revision 规划器） */
export interface ReconcileWindowResult {
  formedProposals: DomainProposal[]
  /** 本窗口失效的 Memory id（RETRACTED / SUPERSEDED / MERGED loser） */
  invalidatedMemoryIds: string[]
  /** 跳过统计（审计面；不进提案） */
  skipped: { reason: string; memoryId: string }[]
}

// ---------------------------------------------------------------------------
// 窗口 reconcile（纯编排；不落库、不写投影）
// ---------------------------------------------------------------------------

/** 事件类型 → 它使哪些 memoryId 失效、使哪些成为形成候选 */
function triggersOf(event: MemoryEventTrigger): {
  candidates: string[]
  invalidated: string[]
} {
  switch (event.type) {
    case MEMORY_CREATED:
    case MEMORY_RESTORED:
      return { candidates: [event.memoryId], invalidated: [] }
    case MEMORY_RETRACTED:
    case MEMORY_SUPERSEDED:
      return { candidates: [], invalidated: [event.memoryId] }
    case MEMORY_MERGED:
      // MERGED 的 memoryId 字段是 winnerId（payload 契约）；本触发面已由
      // 调用方展平成 (type, memoryId) 对——loser 侧以 MEMORY_RETRACTED 语义
      // 进入（M4 合并 = loser 生命终止）。winner 不触发（它自己的 CREATED
      // 已处理过；合并不改其内容）。
      return { candidates: [], invalidated: [event.memoryId] }
    default:
      return { candidates: [], invalidated: [] }
  }
}

export async function reconcileMemoryWindow(
  deps: BeliefReconcilerDeps,
  window: readonly MemoryEventTrigger[],
): Promise<ReconcileWindowResult> {
  const candidateIds: string[] = []
  const invalidated = new Set<string>()
  const skipped: { reason: string; memoryId: string }[] = []

  for (const event of window) {
    const { candidates, invalidated: inv } = triggersOf(event)
    for (const id of candidates) candidateIds.push(id)
    for (const id of inv) invalidated.add(id)
  }

  // 形成候选：批量读当前状态（§7.2 去重批量，不逐条 N+1）
  const formedProposals: DomainProposal[] = []
  const dedupedCandidates = [...new Set(candidateIds)]
  if (dedupedCandidates.length > 0) {
    const memories = await deps.memory.findMemories(dedupedCandidates as MemoryId[])
    const byId = new Map(memories.map((m) => [String(m.id), m]))
    for (const memoryId of dedupedCandidates) {
      const memory = byId.get(memoryId)
      if (memory === undefined) {
        skipped.push({ reason: 'memory_missing', memoryId })
        continue
      }
      if (String(memory.ownerId) !== String(deps.characterId)) {
        skipped.push({ reason: 'memory_foreign', memoryId })
        continue
      }
      if (!isBeliefReportedEligible(memory)) {
        skipped.push({ reason: 'not_eligible', memoryId })
        continue
      }
      if (!isClaimContent(memory.content)) {
        skipped.push({ reason: 'not_claim_content', memoryId })
        continue
      }
      const claim = memory.content
      const slotKey = beliefSlotKeyOf({
        perspectiveOwnerId: deps.characterId as EntityRef['id'],
        subject: claim.subject,
        predicate: claim.predicate,
        scopeKey: beliefReportedScopeKeyOf(claim.qualifiers),
      })
      // 同值现存 ⇒ 不提案（REINFORCED 语义；reported v1 不做跨 Memory 强化）
      const active = await deps.belief.listActiveBeliefsForSlot(deps.characterId, slotKey)
      const sameValue = active.some(
        (b) => String(b.proposition.value) === String(claim.value),
      )
      if (sameValue) {
        skipped.push({ reason: 'slot_same_value_active', memoryId })
        continue
      }
      const beliefId = makeBeliefId(
        deps.characterId as never,
        slotKey,
        /*
         * M9.1 WP8 / F-5（ADR-072 D13「新信念身份」）：身份分量并入 Memory 的
         * revision——复活沿用同 id，只取裸 id 会让再形成撞首次形成的幂等键。
         * revision = 1 时分量与裸 id 相同 ⇒ M9 基线身份逐字节不变。
         */
        beliefReportedFormationKeyOf([
          beliefReportedDependencyTokenOf({ memoryId: memoryId as MemoryId, revision: memory.revision ?? 1 }),
        ]),
      )
      const payload: BeliefFormedPayload = {
        characterId: deps.characterId as never,
        beliefId,
        perspectiveOwnerId: deps.characterId as never,
        subject: claim.subject,
        proposition: {
          predicate: claim.predicate,
          value: claim.value as BeliefFormedPayload['proposition']['value'],
          scopeKey: beliefReportedScopeKeyOf(claim.qualifiers),
        },
        epistemicKind: 'reported',
        supportLevel: 'tentative',
        // 溯源面 = Memory 的证据根（历史陈述；放行口对 reported 不施切换后
        // 条件，但存在性/归属照查——断链失败关闭，§7.5）
        evidenceRootIds: [...memory.evidenceRootIds] as never[],
        dependsOnMemoryIds: [memoryId as MemoryId],
        ruleId: BELIEF_REPORTED_RULE_ID,
        ruleVersion: BELIEF_REPORTED_RULE_VERSION,
      }
      formedProposals.push({
        proposalId: `belief-reconcile:${memoryId}`,
        characterId: deps.characterId as never,
        processor: deps.processor,
        processorVersion: deps.processorVersion,
        sourceConversationEventIds: [],
        targetEvents: [{ type: 'BELIEF_FORMED', operation: 'create', payload }],
      } as unknown as DomainProposal)
    }
  }

  return {
    formedProposals,
    invalidatedMemoryIds: [...invalidated],
    skipped,
  }
}
