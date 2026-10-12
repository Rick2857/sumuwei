/**
 * Belief 修订生命周期规划器 —— WP5（ADR-070 §4.2/§5.4/§6.3；计划 §7）。
 *
 * ============================================================================
 *  铁律：规划器只产**提案**，永不直接写投影/事件
 * ============================================================================
 * 一切产出走 `validateBeliefProposal`（唯一放行口）→ 调用方事务内 append。
 * 读侧的即时遮蔽由 `eligibility.ts` 负责（§7.1 双保险的读侧半边）——
 * 本模块是写侧半边：**追加**撤回/取代/争议事件，推进收敛。
 * 修订任务失败时，读侧遮蔽仍然生效（零泄漏不依赖写侧成功）。
 *
 * ---------------------------------------------------------------------------
 *  区分五类变化（计划 WP5 任务 1；禁止 newest-wins 覆盖）
 * ---------------------------------------------------------------------------
 *   事实变化（state_change）     → SUPERSEDED（保留过去有效期）
 *   原话纠正（user_correction）  → SUPERSEDED old→new（新值须已由 reconciler
 *                                 从更正后的 Memory 形成；不能倒写旧源）
 *   观点改变 / 冲突（conflict）  → DISPUTED（保留两侧，不猜谁对）
 *   撤回（user_retract）         → RETRACTED(reason=user_correction)
 *   遗忘（user_forget_request）  → RETRACTED + forbiddenRootIds=全部根
 *                                 （§5.4：旧依据不能绕道复活，B28）
 * 依赖失效（dependency_invalidated）→ RETRACTED；**不**禁根——
 *   Memory 撤回 ≠ 对话根作废：新显式陈述 ⇒ 新 Memory ⇒ 新 belief identity
 *   （B31 的"遗忘后新授权重新记录"正是这条路径）。
 *
 * ---------------------------------------------------------------------------
 *  目标解析纪律（TD-09 同款；B29）
 * ---------------------------------------------------------------------------
 * 目标不唯一 / 不存在 ⇒ 返回 `clarify`，**零提案、零成功口吻**。
 * 调用方不得把 clarify 渲染成"已忘记/已更正"——那是 B29 的失败模式。
 */
import {
  BELIEF_REVISION_RULE_ID,
  BELIEF_REVISION_RULE_VERSION,
  type BeliefDisputedPayload,
  type BeliefRetractedPayload,
  type BeliefState,
  type BeliefSupersededPayload,
} from '../../contracts/belief.ts'
import type { DomainProposal } from '../../contracts/index.ts'
import type { DomainEventId, MemoryId } from '../../contracts/ids.ts'

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

export interface BeliefRevisionDeps {
  characterId: string
  processor: string
  processorVersion: string
  /** 时钟（SUPERSEDED 的 validTo；注入以便测试确定性） */
  now: () => number
  belief: {
    /** 全部 active 信念（依赖失效扫描） */
    listActiveBeliefs(characterId: string): Promise<BeliefState[]>
    /** 同槽位 active 信念（目标解析） */
    listActiveBeliefsForSlot(characterId: string, slotKey: string): Promise<BeliefState[]>
    getBelief(characterId: string, beliefId: string): Promise<BeliefState | undefined>
  }
}

/** 规划结果：要么有提案，要么要澄清——两者互斥，澄清永不带成功口吻 */
export type RevisionPlan =
  | { kind: 'proposals'; proposals: DomainProposal[] }
  | { kind: 'clarify'; reason: string; candidates: string[] }
  | { kind: 'noop'; reason: string }

// ---------------------------------------------------------------------------
// 提案构造（私有；reason/ruleVersion 与合同冻结值一致）
// ---------------------------------------------------------------------------

function retractedProposal(
  deps: BeliefRevisionDeps,
  belief: BeliefState,
  reason: BeliefRetractedPayload['reason'],
  forbiddenRootIds: string[],
  causeRef?: DomainEventId,
): DomainProposal {
  const payload: BeliefRetractedPayload = {
    characterId: deps.characterId as never,
    beliefId: belief.beliefId,
    reason,
    ...(causeRef !== undefined ? { causeRef } : {}),
    // 空集合用 undefined（合同：省略 ≠ 空数组——校验器对存在但空失败关闭）
    ...(forbiddenRootIds.length > 0
      ? { forbiddenRootIds: forbiddenRootIds as never[] }
      : {}),
    ruleId: BELIEF_REVISION_RULE_ID,
    ruleVersion: BELIEF_REVISION_RULE_VERSION,
  }
  return {
    proposalId: `belief-revision:retract:${String(belief.beliefId)}:${reason}`,
    characterId: deps.characterId as never,
    processor: deps.processor,
    processorVersion: deps.processorVersion,
    sourceConversationEventIds: [],
    targetEvents: [{ type: 'BELIEF_RETRACTED', operation: 'create', payload }],
  } as unknown as DomainProposal
}

function supersededProposal(
  deps: BeliefRevisionDeps,
  oldBeliefId: string,
  newBeliefId: string,
): DomainProposal {
  const payload: BeliefSupersededPayload = {
    characterId: deps.characterId as never,
    oldBeliefId: oldBeliefId as never,
    newBeliefId: newBeliefId as never,
    reason: 'user_correction',
    validTo: deps.now() as never,
    ruleId: BELIEF_REVISION_RULE_ID,
    ruleVersion: BELIEF_REVISION_RULE_VERSION,
  }
  return {
    proposalId: `belief-revision:supersede:${oldBeliefId}:${newBeliefId}`,
    characterId: deps.characterId as never,
    processor: deps.processor,
    processorVersion: deps.processorVersion,
    sourceConversationEventIds: [],
    targetEvents: [{ type: 'BELIEF_SUPERSEDED', operation: 'create', payload }],
  } as unknown as DomainProposal
}

function disputedProposal(
  deps: BeliefRevisionDeps,
  belief: BeliefState,
  conflictingBeliefId: string,
): DomainProposal {
  const payload: BeliefDisputedPayload = {
    characterId: deps.characterId as never,
    beliefId: belief.beliefId,
    conflictingBeliefId: conflictingBeliefId as never,
    reason: 'slot_conflict',
    ruleId: BELIEF_REVISION_RULE_ID,
    ruleVersion: BELIEF_REVISION_RULE_VERSION,
  }
  return {
    proposalId: `belief-revision:dispute:${String(belief.beliefId)}`,
    characterId: deps.characterId as never,
    processor: deps.processor,
    processorVersion: deps.processorVersion,
    sourceConversationEventIds: [],
    targetEvents: [{ type: 'BELIEF_DISPUTED', operation: 'create', payload }],
  } as unknown as DomainProposal
}

// ---------------------------------------------------------------------------
// 依赖失效（§7.1 写侧半边；reconciler 收集触发 → 这里规划）
// ---------------------------------------------------------------------------

/**
 * Memory 依赖失效：撤回/降档的 Memory 不能继续背书 B-REPORTED。
 *
 * 扫描全部 active 信念的 `dependsOnMemoryIds`；命中 ⇒ RETRACTED
 * (dependency_invalidated)。**不禁根**（见文件头五类变化表）。
 */
export async function planMemoryInvalidation(
  deps: BeliefRevisionDeps,
  trigger: { memoryId: MemoryId | string; causeRef?: DomainEventId },
): Promise<RevisionPlan> {
  const actives = await deps.belief.listActiveBeliefs(deps.characterId)
  const affected = actives.filter((b) =>
    (b.dependsOnMemoryIds ?? []).some((id) => String(id) === String(trigger.memoryId)),
  )
  if (affected.length === 0) return { kind: 'noop', reason: 'no_active_belief_depends' }
  return {
    kind: 'proposals',
    proposals: affected.map((b) =>
      retractedProposal(deps, b, 'dependency_invalidated', [], trigger.causeRef),
    ),
  }
}

/**
 * 根证据失效（qualified→unqualified：归因重读降档 / 事件消失）。
 *
 * 命中 active 信念的 `evidenceRootIds` ⇒ RETRACTED(dependency_invalidated)
 * + forbiddenRootIds=[该根]——失效的根不得再喂任何新形成（§5.4 失败关闭）。
 */
export async function planRootInvalidation(
  deps: BeliefRevisionDeps,
  trigger: { rootId: string; causeRef?: DomainEventId },
): Promise<RevisionPlan> {
  const actives = await deps.belief.listActiveBeliefs(deps.characterId)
  const affected = actives.filter((b) =>
    (b.evidenceRootIds ?? []).some((id) => String(id) === String(trigger.rootId)),
  )
  if (affected.length === 0) return { kind: 'noop', reason: 'no_active_belief_uses_root' }
  return {
    kind: 'proposals',
    proposals: affected.map((b) =>
      retractedProposal(deps, b, 'dependency_invalidated', [trigger.rootId], trigger.causeRef),
    ),
  }
}

// ---------------------------------------------------------------------------
// 用户显式遗忘 / 纠正（NL 目标解析后的规划面；B28/B29/B31）
// ---------------------------------------------------------------------------

/** 显式遗忘：目标唯一 ⇒ RETRACTED(user_forget_request) + 禁全部根（B28） */
export async function planBeliefForget(
  deps: BeliefRevisionDeps,
  target: { slotKey: string } | { beliefId: string },
): Promise<RevisionPlan> {
  let belief: BeliefState | undefined
  if ('beliefId' in target) {
    const found = await deps.belief.getBelief(deps.characterId, target.beliefId)
    if (found === undefined || found.status !== 'active') {
      return {
        kind: 'clarify',
        reason: 'belief_not_active',
        candidates: found === undefined ? [] : [String(found.beliefId)],
      }
    }
    belief = found
  } else {
    const actives = await deps.belief.listActiveBeliefsForSlot(deps.characterId, target.slotKey)
    if (actives.length === 0) {
      return { kind: 'clarify', reason: 'nothing_active_in_slot', candidates: [] }
    }
    if (actives.length > 1) {
      return {
        kind: 'clarify',
        reason: 'ambiguous_target',
        candidates: actives.map((b) => String(b.beliefId)),
      }
    }
    belief = actives[0]
  }
  return {
    kind: 'proposals',
    proposals: [
      retractedProposal(
        deps,
        belief,
        'user_forget_request',
        (belief.evidenceRootIds ?? []).map(String),
      ),
    ],
  }
}

/**
 * 显式纠正：old→new 的 SUPERSEDED（事实变化/原话纠正共用；不倒写旧源）。
 *
 * 前提：新值信念**已由 reconciler 从更正后的 Memory 形成**（active）——
 * 纠正先走 Memory 管线，Belief 只做因果链登记。新值未形成 ⇒ clarify
 * （不猜、不抢跑）；同槽位多条旧 active ⇒ clarify（目标不唯一）。
 */
export async function planBeliefCorrection(
  deps: BeliefRevisionDeps,
  input: { slotKey: string; newBeliefId: string },
): Promise<RevisionPlan> {
  const next = await deps.belief.getBelief(deps.characterId, input.newBeliefId)
  if (next === undefined || next.status !== 'active') {
    return {
      kind: 'clarify',
      reason: 'new_belief_not_formed',
      candidates: [],
    }
  }
  const actives = await deps.belief.listActiveBeliefsForSlot(deps.characterId, input.slotKey)
  const olds = actives.filter((b) => String(b.beliefId) !== String(input.newBeliefId))
  if (olds.length === 0) return { kind: 'noop', reason: 'nothing_to_supersede' }
  if (olds.length > 1) {
    return {
      kind: 'clarify',
      reason: 'ambiguous_target',
      candidates: olds.map((b) => String(b.beliefId)),
    }
  }
  return {
    kind: 'proposals',
    proposals: [supersededProposal(deps, String(olds[0].beliefId), input.newBeliefId)],
  }
}

/**
 * 显式争议登记：同槽位互斥值并存 ⇒ 全部标 disputed（保留两侧，§6.3）。
 * 谁对由后续的解决依据决定——本规划器不猜。
 */
export async function planBeliefDispute(
  deps: BeliefRevisionDeps,
  input: { slotKey: string },
): Promise<RevisionPlan> {
  const actives = await deps.belief.listActiveBeliefsForSlot(deps.characterId, input.slotKey)
  if (actives.length < 2) {
    return { kind: 'noop', reason: 'no_conflict_to_register' }
  }
  const proposals: DomainProposal[] = []
  for (const belief of actives) {
    const others = actives.filter((b) => String(b.beliefId) !== String(belief.beliefId))
    proposals.push(disputedProposal(deps, belief, String(others[0].beliefId)))
  }
  return { kind: 'proposals', proposals }
}
