/**
 * P3-3 —— **受信修订发布器**（基础设施层；组合 kernel 纯判定与存储原子提交）。
 *
 * ============================================================================
 *  它是"谁有权改发布状态"的**唯一**落点
 * ============================================================================
 * ```text
 * 模型 / 动作 / 候选技能 / 历史证据 都没有任何路径调用本模块：
 *   · 它不在 `src/kernel/**`（kernel 不知道发布器存在）
 *   · 它不被任何能力适配器 import（结构锁由门 `p3:skill-revision:verify` 断言）
 *   · 它的输入是"资产 + 验证包 + 提议登记"，输出是"一次裁定 + 一次原子提交"
 * ```
 *
 * 三个入口（都只做**判定 + 存储**，不做 I/O 之外的事）：
 * ```text
 * publishCandidate  验证包 → 裁定（形状/权限/边界/完整性/开发/留出/状态）→ 原子发布
 * rollback          切回一个仍 published 的旧版本（旧版本保留 = 回退的前提）
 * retire            退役一个**非当前**版本（当前版本必须先被切走）
 * ```
 *
 * ⚠️ 边界（必须与读数一起读）：
 *  · 本模块**不能**证明验证包真的在冻结材料上跑过；它证明的是"包未被改、产者唯一、
 *    冻结摘要一致、结果内部自洽"。真实执行由 harness + 门负责。
 *  · 发布只改**实验目录的当前版本**；它不等同于生产接管（P3-6 另行裁定）。
 *  · 被拒绝的候选**也留痕**（裁定历史写拒绝码与留出集 id），不会因为失败就消失。
 */

import type { WorkflowSkillPublishedState } from '../../kernel/contracts/workflow-skill-catalog.ts'
import { loadedReleaseOf } from './workflow-skill-catalog.ts'
import {
  computeVerificationTasksDigest,
  decideRevisionPromotion,
  decideRevisionRetirement,
  decideRevisionRollback,
  type WorkflowSkillRevisionRejectCode,
  type WorkflowSkillVerificationBundle,
} from '../../kernel/contracts/workflow-skill-revision.ts'
import type {
  WorkflowSkillReleaseStore,
  WorkflowSkillRevisionDecisionRecord,
} from '../persistence/workflow-skill-release-store.ts'
import type {
  LoadedWorkflowSkillRevisionAssets,
} from './workflow-skill-revision-assets.ts'
import { proposalOf } from './workflow-skill-revision-assets.ts'

export type RevisionPublisherFailureCode =
  | WorkflowSkillRevisionRejectCode
  | 'revision_store_bundle_conflict'
  | 'revision_store_candidate_state'
  | 'revision_store_current_conflict'
  | 'revision_store_failed'

export type RevisionPublisherResult =
  | {
      readonly ok: true
      readonly skillId: string
      readonly version: number
      readonly bundleDigest: string
      readonly previousVersion: number | null
    }
  | {
      readonly ok: false
      readonly code: RevisionPublisherFailureCode
      readonly stage: 'proposal' | 'identity' | 'permission' | 'verification' | 'state' | 'decision' | 'store'
      readonly detail: string
    }

export interface WorkflowSkillRevisionPublisherOptions {
  readonly loaded: LoadedWorkflowSkillRevisionAssets
  readonly store: WorkflowSkillReleaseStore
  /** 时钟（注入以便测试固定时间；发布器不读 `Date.now()`） */
  readonly now?: () => number
}

export interface WorkflowSkillRevisionPublisher {
  /** 发布候选（唯一入口；失败也会写一条 rejected 裁定）。 */
  publishCandidate(input: {
    readonly skillId: string
    readonly version: number
    readonly bundle: WorkflowSkillVerificationBundle
    readonly reason?: string
  }): Promise<RevisionPublisherResult>
  /** 回退到仍 published 的旧版本。 */
  rollback(input: {
    readonly skillId: string
    readonly toVersion: number
    readonly reason?: string
  }): Promise<
    | { ok: true; skillId: string; toVersion: number; previousVersion: number | null }
    | { ok: false; code: RevisionPublisherFailureCode; stage: 'state' | 'store'; detail: string }
  >
  /** 退役一个非当前版本。 */
  retire(input: {
    readonly skillId: string
    readonly version: number
    readonly reason?: string
  }): Promise<
    | { ok: true; skillId: string; version: number }
    | { ok: false; code: RevisionPublisherFailureCode; stage: 'state' | 'store'; detail: string }
  >
  /** 迁移历史（发布事件 + 裁定）——"全部迁移历史可查"的读面。 */
  history(skillId: string, limit?: number): Promise<{
    readonly events: Awaited<ReturnType<WorkflowSkillReleaseStore['listEvents']>>
    readonly decisions: readonly WorkflowSkillRevisionDecisionRecord[]
  }>
}

export function createWorkflowSkillRevisionPublisher(
  options: WorkflowSkillRevisionPublisherOptions
): WorkflowSkillRevisionPublisher {
  const now = options.now ?? (() => Date.now())

  /**
   * 历史里"已经失败过"的留出材料签名：`setId`（兼容历史行）**与**任务签名
   * （`computeVerificationTasksDigest`，把判据绑到题面材料上，改名不放过）。
   */
  async function failedHoldoutSignatures(skillId: string): Promise<string[]> {
    const decisions = await options.store.listRevisionDecisions(skillId, 200)
    const signatures: string[] = []
    for (const decision of decisions) {
      if (decision.decision !== 'rejected' || decision.rejectCode !== 'revision_holdout_failed') continue
      if (decision.holdoutSetId !== null) signatures.push(decision.holdoutSetId)
      const tasksDigest = decision.detail['holdoutTasksDigest']
      if (typeof tasksDigest === 'string' && tasksDigest !== '') signatures.push(tasksDigest)
    }
    return [...new Set(signatures)]
  }

  return {
    async publishCandidate(input) {
      const stamp = now()
      const loaded = options.loaded
      const proposal = proposalOf(loaded, input.skillId, input.version)
      const catalogSkill = loaded.catalog.catalog.skills.find((skill) => skill.skillId === input.skillId)
      const candidate = loadedReleaseOf(loaded.catalog, input.skillId, input.version)
      const parentVersion = proposal?.parentVersion ?? (candidate?.release.predecessorVersion ?? 0)
      const parent = parentVersion >= 1 ? loadedReleaseOf(loaded.catalog, input.skillId, parentVersion) : undefined
      const states = await options.store.readStates(input.skillId)
      const candidateState = states.find((state) => state.version === input.version)
      const parentState = states.find((state) => state.version === parentVersion)
      const frozenDev = proposal === undefined ? undefined : loaded.sets.get(proposal.devSetId)
      const frozenHoldout = proposal === undefined ? undefined : loaded.sets.get(proposal.holdoutSetId)

      if (frozenDev === undefined || frozenHoldout === undefined) {
        const code: WorkflowSkillRevisionRejectCode = 'revision_proposal_missing'
        /* 冻结集缺失是资产错误（加载器已拦）；这里仍失败关闭并留痕 */
        await options.store.appendRevisionDecision({
          skillId: input.skillId,
          version: input.version,
          parentVersion,
          bundleDigest: input.bundle.bundleDigest,
          decision: 'rejected',
          rejectCode: code,
          holdoutSetId: input.bundle.holdout.setId,
          detail: { stage: 'proposal', detail: '候选提议或冻结验证集缺失' },
          decidedAt: stamp,
        })
        return { ok: false, code, stage: 'proposal', detail: '候选提议或冻结验证集缺失' }
      }

      /*
       * 留出材料的**任务签名**：失败裁定会把它一起落库，后续候选若复用同一份题面材料
       * （哪怕换了 setId）也会被 `revision_holdout_reuse` 拦住。
       */
      const holdoutTasksDigest = computeVerificationTasksDigest(frozenHoldout.tasks)
      const decision = decideRevisionPromotion({
        proposal,
        catalogSkill,
        candidateState,
        parentState,
        parentRelease: parent?.release,
        candidateRelease: candidate?.release,
        actualCandidateContentFingerprint: candidate?.release.contentFingerprint ?? '',
        bundle: input.bundle,
        frozen: { dev: frozenDev, holdout: frozenHoldout },
        failedHoldoutSignatures: await failedHoldoutSignatures(input.skillId),
        holdoutTasksDigest,
      })

      if (!decision.ok) {
        await options.store.appendRevisionDecision({
          skillId: input.skillId,
          version: input.version,
          parentVersion,
          bundleDigest: input.bundle.bundleDigest,
          decision: 'rejected',
          rejectCode: decision.code,
          holdoutSetId: input.bundle.holdout.setId,
          detail: { stage: decision.stage, detail: decision.detail, holdoutTasksDigest },
          decidedAt: stamp,
        })
        return { ok: false, code: decision.code, stage: decision.stage, detail: decision.detail }
      }

      const commit = await options.store.commitPromotion({
        skillId: input.skillId,
        version: input.version,
        bundle: input.bundle,
        reason: input.reason ?? `P3-3 发布候选 ${input.skillId}@${String(input.version)}`,
        now: stamp,
        proposalDetail: {
          triggerDefectRef: proposal!.triggerDefectRef,
          proposedBy: proposal!.proposedBy,
          devSetId: proposal!.devSetId,
          holdoutSetId: proposal!.holdoutSetId,
          proposalDigest: proposal!.proposalDigest,
        },
      })
      if (!commit.ok) {
        const code: RevisionPublisherFailureCode = commit.code === 'bundle_conflict'
          ? 'revision_store_bundle_conflict'
          : commit.code === 'candidate_state_conflict'
            ? 'revision_store_candidate_state'
            : commit.code === 'current_conflict'
              ? 'revision_store_current_conflict'
              : 'revision_store_failed'
        await options.store.appendRevisionDecision({
          skillId: input.skillId,
          version: input.version,
          parentVersion,
          bundleDigest: input.bundle.bundleDigest,
          decision: 'rejected',
          rejectCode: code,
          holdoutSetId: input.bundle.holdout.setId,
          detail: { stage: 'store', detail: commit.detail },
          decidedAt: stamp,
        })
        return { ok: false, code, stage: 'store', detail: commit.detail }
      }
      return {
        ok: true,
        skillId: input.skillId,
        version: input.version,
        bundleDigest: input.bundle.bundleDigest,
        previousVersion: commit.previousVersion,
      }
    },

    async rollback(input) {
      const stamp = now()
      const states = await options.store.readStates(input.skillId)
      const target = states.find((state) => state.version === input.toVersion)
      const decision = decideRevisionRollback({
        skillId: input.skillId,
        toVersion: input.toVersion,
        targetState: target as WorkflowSkillPublishedState | undefined,
      })
      if (!decision.ok) {
        return { ok: false, code: decision.code, stage: 'state', detail: decision.detail }
      }
      const result = await options.store.setCurrent({
        skillId: input.skillId,
        version: input.toVersion,
        reason: input.reason ?? `P3-3 回退到 @${String(input.toVersion)}`,
        now: stamp,
      })
      if (!result.ok) {
        return {
          ok: false,
          code: result.code === 'target_not_published' ? 'revision_rollback_target_not_published' : 'revision_store_failed',
          stage: 'store',
          detail: result.detail,
        }
      }
      return { ok: true, skillId: input.skillId, toVersion: input.toVersion, previousVersion: result.previousVersion }
    },

    async retire(input) {
      const stamp = now()
      const states = await options.store.readStates(input.skillId)
      const target = states.find((state) => state.version === input.version)
      const decision = decideRevisionRetirement({
        version: input.version,
        state: target as WorkflowSkillPublishedState | undefined,
        isCurrent: target?.isCurrent === true,
      })
      if (!decision.ok) {
        return { ok: false, code: decision.code, stage: 'state', detail: decision.detail }
      }
      const result = await options.store.transition({
        skillId: input.skillId,
        version: input.version,
        to: 'retired',
        reason: input.reason ?? `P3-3 退役 @${String(input.version)}`,
        now: stamp,
      })
      if (!result.ok) {
        return { ok: false, code: 'revision_store_failed', stage: 'store', detail: result.detail }
      }
      return { ok: true, skillId: input.skillId, version: input.version }
    },

    async history(skillId, limit = 50) {
      const [events, decisions] = await Promise.all([
        options.store.listEvents(skillId, limit),
        options.store.listRevisionDecisions(skillId, limit),
      ])
      return { events, decisions }
    },
  }
}

/** 便于门：把一条裁定压成一行可 grep 的读数（不含正文）。 */
export function describeRevisionDecision(decision: WorkflowSkillRevisionDecisionRecord): string {
  return `${decision.skillId}@${String(decision.version)} ${decision.decision}` +
    `${decision.rejectCode === null ? '' : `(${decision.rejectCode})`}` +
    `${decision.holdoutSetId === null ? '' : ` holdout=${decision.holdoutSetId}`}`
}

export type { WorkflowSkillRevisionDecisionRecord }
