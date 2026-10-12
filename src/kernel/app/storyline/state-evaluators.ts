/**
 * Storyline —— **故事状态评价适配器与提案器**（kernel/app；后 Lv2 · S8 / WP4）。
 *
 * ============================================================================
 *  载体：ADR-093 `D08`（Affect）· `D09`（Relationship）· `R-2`（anchor）
 *       验收契约 `S8-A19` `S8-A20` `S8-A21` `S8-A22` `S8-A23` `S8-A24`
 * ============================================================================
 * 它把**已提交的世界账本行**翻译成两份**待审提案**（Affect / Relationship）。
 *
 * ---------------------------------------------------------------------------
 *  为什么它住在 `kernel/app/storyline/`（而不是 `app/affect/`）
 * ---------------------------------------------------------------------------
 * `FC-T04` 的模块边界锁规定：只有 `kernel/storyline`、`infrastructure/storyline`、
 * `kernel/app/storyline` 三个目录可以直接 import `storyline/**`。
 * 契约层的规则表（`contracts/story-appraisal.ts`）因此**不**认识 `StoryCommitRecord`；
 * 翻译只在这一处发生，于是"类型漂移"最多影响一个文件。
 *
 * ---------------------------------------------------------------------------
 *  四条纪律
 * ---------------------------------------------------------------------------
 * ```text
 * ① **只提案**：不落库、不折叠、不改状态（放行口在 policies/）
 * ② **证据资格**：`user_choice` + 有 anchor + 该提交引入了可见条目（`D08` 的四条资格）
 * ③ **不增加旧对话里程碑计数**：这里**不**碰任何 messages/days 计数（`S8-A22`）
 * ④ **可追来源**：提案带 `sourceStoryRefs`，且 `sourceEventId` = 真实触发对话事件（`R-2`）
 * ```
 *
 * ⚠️ 纯装配层：不 import SQL / 框架 / `node:*`。取数由调用方（调度端）完成。
 */

import type { CharacterId, ProcessorVersion } from '../../contracts/ids.ts'
import type { DomainProposal } from '../../contracts/proposal.ts'
import { createProposal } from '../../contracts/proposal.ts'
import { AFFECT_IMPACT, AFFECT_TOUCH, RELATIONSHIP_IMPACT } from '../../contracts/domain-event.ts'
import {
  AFFECT_IMPACT_PROPOSAL_TYPE,
  AFFECT_TOUCH_PROPOSAL_TYPE,
  type AffectDelta,
  type AffectImpactPayload,
  type AffectTouchPayload,
} from '../../contracts/affect.ts'
import { RELATIONSHIP_IMPACT_PROPOSAL_TYPE, type RelationshipImpactPayload } from '../../contracts/relationship.ts'
import { entityRef, type EntityRelationKey } from '../../contracts/entity.ts'
import { storySourceRefOf } from '../../contracts/source-authority.ts'
import {
  STORY_APPRAISAL_RULES_VERSION,
  STORY_APPRAISAL_RULE_DELTAS,
  STORY_RELATIONSHIP_RULES_VERSION,
  STORY_RELATIONSHIP_RULE_DELTAS,
  assertStoryRuleTablesWellFormed,
  storyAppraisalOf,
  storyRelationshipAppraisalOf,
  type StoryAppraisalInput,
} from '../../contracts/story-appraisal.ts'
import { storyCommitIdOf, type StoryCommitRecord } from '../../storyline/story-ledger.ts'

export const STORY_AFFECT_EVALUATOR_NAME = 'story-affect-evaluator'
export const STORY_AFFECT_EVALUATOR_VERSION = 'story-affect-evaluator@1' as ProcessorVersion
export const STORY_RELATIONSHIP_EVALUATOR_NAME = 'story-relationship-evaluator'
export const STORY_RELATIONSHIP_EVALUATOR_VERSION = 'story-relationship-evaluator@1' as ProcessorVersion

/**
 * 一条可以用来评价的提交 + 它的**触发对话事件序号**。
 *
 * ⚠️ `anchorSequence` 由调用方从**对话账本**读出（故事账本不存对话序号）：
 * 少了它，`AFFECT_TOUCH`/`AFFECT_IMPACT` 的 `sourceSequence` 就没有真实值可用，
 * 而"来源可追"这条判据正是靠它成立的。
 */
export interface StoryStateCandidate {
  readonly commit: StoryCommitRecord
  readonly anchorSequence: number
}

/**
 * 资格（`D08` ①–④ 的程序形态）。
 *
 * ```text
 * ① 提交身份自洽（规范形，能读回）
 * ② interaction_kind = user_choice（system 提交**不**产出任何状态增量）
 * ③ 有真实触发对话事件（anchor）——因果身份与 sourceEventId 都靠它
 * ④ 这一次提交**真的引入了可见条目**（没有可见条目的提交不构成"经历"）
 * ```
 * 任一条不满足 ⇒ 具名 `undefined`（调用方**不得**把它当成"评价为 0"）。
 */
export function storyStateEligibilityOf(
  candidate: StoryStateCandidate
): { eligible: true } | { eligible: false; reason: string } {
  const { commit } = candidate
  try {
    storyCommitIdOf({
      storyId: commit.storyId,
      storyVersion: commit.storyVersion,
      runId: commit.runId,
      revision: commit.revision,
    })
  } catch {
    return { eligible: false, reason: 'story_commit_identity_invalid' }
  }
  if (commit.binding.interactionKind !== 'user_choice') {
    return { eligible: false, reason: 'story_feedback_not_real_interaction' }
  }
  const anchor = commit.binding.anchorConversationEventId
  if (anchor === undefined || anchor.trim() === '') {
    return { eligible: false, reason: 'story_binding_without_anchor' }
  }
  if (commit.newVisibleEvents.length === 0) {
    return { eligible: false, reason: 'story_root_invisible' }
  }
  return { eligible: true }
}

/** 把一条账本行翻成契约层的评价输入（**唯一**的翻译点） */
export function storyAppraisalInputOf(input: {
  commit: StoryCommitRecord
  variablesBefore: Readonly<Record<string, number | boolean | string>>
}): StoryAppraisalInput {
  const { commit } = input
  return {
    commitId: commit.commitId,
    revision: commit.revision,
    eventType: commit.eventType,
    stage: commit.stage,
    variablesBefore: input.variablesBefore,
    variablesAfter: commit.variablesAfter,
    ...(commit.ending !== undefined ? { ending: commit.ending } : {}),
    interactionKind: commit.binding.interactionKind,
    ...(commit.binding.anchorConversationEventId !== undefined
      ? { anchorConversationEventId: commit.binding.anchorConversationEventId }
      : {}),
    sourceStoryRefs: [
      storySourceRefOf({ sourceId: commit.commitId, experienceScope: 'story_experience' }),
    ],
  }
}

/** 按 revision 升序补出"每一步之前的变量" */
export function storyVariablesBeforeByRevision(
  commits: readonly StoryCommitRecord[]
): Map<number, Readonly<Record<string, number | boolean | string>>> {
  const ordered = [...commits].sort((a, b) => a.revision - b.revision)
  const out = new Map<number, Readonly<Record<string, number | boolean | string>>>()
  let previous: Readonly<Record<string, number | boolean | string>> = {}
  for (const commit of ordered) {
    out.set(commit.revision, previous)
    previous = commit.variablesAfter
  }
  return out
}

// ---------------------------------------------------------------------------
// Affect：TOUCH + IMPACT（两个独立提案；与 M8 的结构对称）
// ---------------------------------------------------------------------------

export interface StoryAffectProposalAudit {
  readonly kind: 'touch' | 'impact'
  readonly commitId: string
  readonly ruleId?: string
}

/**
 * 故事驱动的 Affect 提案（**确定性、无模型调用**）。
 *
 * ⚠️ 每个合格提交至多 1 TOUCH + 1 IMPACT（与 `M8-D08` 的"一次交互至多一次主导影响"对称）。
 * ⚠️ 规则表自检**每次都跑**：表被改坏 ⇒ 抛错，不产出任何提案（失败关闭优先）。
 * ⚠️ 必须传入 `commits`：`S-COOPERATION` / `S-CLARIFY` 判的是"**这一步**有没有让变量上升"，
 *    没有"每一步之前的变量"就判不出来（第一版少了它 ⇒ 这两条规则**不可达**）。
 */
export function buildStoryAffectProposals(input: {
  characterId: CharacterId
  candidates: readonly StoryStateCandidate[]
  commits: readonly StoryCommitRecord[]
}): DomainProposal<StoryAffectProposalAudit>[] {
  assertStoryRuleTablesWellFormed()
  const beforeByRevision = storyVariablesBeforeByRevision(input.commits)
  const proposals: DomainProposal<StoryAffectProposalAudit>[] = []
  for (const candidate of input.candidates) {
    const eligibility = storyStateEligibilityOf(candidate)
    if (!eligibility.eligible) continue
    const { commit } = candidate
    const anchor = commit.binding.anchorConversationEventId as string
    const sourceRefs = [
      storySourceRefOf({ sourceId: commit.commitId, experienceScope: 'story_experience' }),
    ]

    const touchPayload: AffectTouchPayload = {
      characterId: input.characterId,
      sourceEventId: anchor as never,
      sourceSequence: candidate.anchorSequence,
      originKind: 'STORY_DERIVED',
      evaluatorVersion: STORY_AFFECT_EVALUATOR_VERSION,
      proposalId: '',
    }
    const touch = createProposal<StoryAffectProposalAudit>({
      characterId: input.characterId,
      proposalType: AFFECT_TOUCH_PROPOSAL_TYPE,
      sourceConversationEventIds: [anchor as never],
      sourceStoryRefs: sourceRefs,
      payload: { kind: 'touch', commitId: commit.commitId },
      targetEvents: [{ type: AFFECT_TOUCH, operation: 'update', payload: touchPayload }],
      processor: STORY_AFFECT_EVALUATOR_NAME,
      processorVersion: STORY_AFFECT_EVALUATOR_VERSION,
    })
    ;(touchPayload as { proposalId: string }).proposalId = touch.proposalId
    proposals.push(touch)

    const ruleId = storyAppraisalOf(
      storyAppraisalInputOf({
        commit,
        variablesBefore: beforeByRevision.get(commit.revision) ?? {},
      })
    )
    if (ruleId === undefined) continue
    const delta: AffectDelta = STORY_APPRAISAL_RULE_DELTAS[ruleId]
    const impactPayload: AffectImpactPayload = {
      characterId: input.characterId,
      sourceEventId: anchor as never,
      sourceSequence: candidate.anchorSequence,
      ruleId,
      ruleVersion: STORY_APPRAISAL_RULES_VERSION,
      delta,
      originKind: 'STORY_DERIVED',
      evaluatorVersion: STORY_AFFECT_EVALUATOR_VERSION,
      proposalId: '',
    }
    const impact = createProposal<StoryAffectProposalAudit>({
      characterId: input.characterId,
      proposalType: AFFECT_IMPACT_PROPOSAL_TYPE,
      sourceConversationEventIds: [anchor as never],
      sourceStoryRefs: sourceRefs,
      payload: { kind: 'impact', commitId: commit.commitId, ruleId },
      targetEvents: [{ type: AFFECT_IMPACT, operation: 'update', payload: impactPayload }],
      processor: STORY_AFFECT_EVALUATOR_NAME,
      processorVersion: STORY_AFFECT_EVALUATOR_VERSION,
    })
    ;(impactPayload as { proposalId: string }).proposalId = impact.proposalId
    proposals.push(impact)
  }
  return proposals
}

// ---------------------------------------------------------------------------
// Relationship：只对**服务端绑定的真实用户**交互产出
// ---------------------------------------------------------------------------

export interface StoryRelationshipProposalAudit {
  readonly commitId: string
  readonly ruleId: string
}

/**
 * 故事驱动的 Relationship 提案。
 *
 * ⚠️ 三件**必须**成立的事（`D09`）：
 * ```text
 * ① 该提交是 `user_choice`（纯后台推进 / NPC 评价不合格）
 * ② 它绑定到**当前真实用户**（targetUserId 由服务端给，不是 payload 自报）
 * ③ 规则表自检通过，且 delta 落在既有单事件上限内
 * ```
 * ⚠️ 它**不**碰任何 messages/days 里程碑计数（`S8-A22`）：故事来源**不得**让
 * "用户消息总数"或"活跃天数" +1 —— 那些计数只由真实对话写入。
 */
export function buildStoryRelationshipProposals(input: {
  characterId: CharacterId
  targetUserId: string
  candidates: readonly StoryStateCandidate[]
  commits: readonly StoryCommitRecord[]
}): DomainProposal<StoryRelationshipProposalAudit>[] {
  assertStoryRuleTablesWellFormed()
  const beforeByRevision = storyVariablesBeforeByRevision(input.commits)
  const key: EntityRelationKey = {
    owner: input.characterId as never,
    target: entityRef('user', input.targetUserId).id,
  }
  const proposals: DomainProposal<StoryRelationshipProposalAudit>[] = []
  for (const candidate of input.candidates) {
    const eligibility = storyStateEligibilityOf(candidate)
    if (!eligibility.eligible) continue
    const { commit } = candidate
    const anchor = commit.binding.anchorConversationEventId as string
    if (commit.binding.interactionRef === undefined) continue

    const ruleId = storyRelationshipAppraisalOf(
      storyAppraisalInputOf({
        commit,
        variablesBefore: beforeByRevision.get(commit.revision) ?? {},
      })
    )
    if (ruleId === undefined) continue
    const delta = STORY_RELATIONSHIP_RULE_DELTAS[ruleId]
    const payload: RelationshipImpactPayload = {
      key,
      targetKind: 'user',
      delta: { trust: delta.deltaTrust, closeness: delta.deltaCloseness },
      ruleId,
      /*
       * 幂等单元 = **提交身份**：同一 (operation, ruleId, unit) 的重复提案撞键，
       * 于是"每个合格提交对每个规则至多一次影响"由既有幂等机制保证（`D13`）。
       */
      unit: commit.commitId,
      originKind: 'STORY_DERIVED',
      ruleVersion: STORY_RELATIONSHIP_RULES_VERSION,
    }
    const proposal = createProposal<StoryRelationshipProposalAudit>({
      characterId: input.characterId,
      proposalType: RELATIONSHIP_IMPACT_PROPOSAL_TYPE,
      sourceConversationEventIds: [anchor as never],
      sourceStoryRefs: [
        storySourceRefOf({ sourceId: commit.commitId, experienceScope: 'story_experience' }),
      ],
      payload: { commitId: commit.commitId, ruleId },
      targetEvents: [{ type: RELATIONSHIP_IMPACT, operation: 'update', payload }],
      processor: STORY_RELATIONSHIP_EVALUATOR_NAME,
      processorVersion: STORY_RELATIONSHIP_EVALUATOR_VERSION,
    })
    proposals.push(proposal)
  }
  return proposals
}
