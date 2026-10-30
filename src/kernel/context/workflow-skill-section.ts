import type { ActionTurnResult } from '../action/action-turn.ts'
import { WORKFLOW_SKILL, type WorkflowSkillDefinition } from '../action/learning-capabilities.ts'
import type { ContextSectionProvider } from '../contracts/context.ts'
import {
  parseWorkflowSkillReleaseRef,
  workflowSkillReleaseRef,
  workflowSkillSectionId,
  type WorkflowSkillPublishedState,
} from '../contracts/workflow-skill-catalog.ts'

/** Only a successful load of a matching packaged skill can supply instructions. */
export function createWorkflowSkillProvider(
  skills: readonly WorkflowSkillDefinition[],
  outcomes: readonly ActionTurnResult[] = []
): ContextSectionProvider {
  return {
    name: 'workflow-skills',
    async provide() {
      const selected = skills.filter((skill) => outcomes.some(({ request, result }) =>
        request?.capability === WORKFLOW_SKILL && request.operation === 'load' &&
        request.arguments.skill === skill.id && result?.accepted === true && result.executed &&
        result.status === 'success' && result.effect?.fingerprint === skill.fingerprint
      ))
      return selected.map((skill) => ({
        id: `workflow-skill:${skill.id}`, kind: 'instruction' as const, priority: 56,
        content: `# 本轮流程：${skill.id}\n\n${skill.instructions}`,
        sourceRefs: [`workflow-skill:${skill.id}@1#${skill.fingerprint}`], droppable: true,
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// P3：目录管理路径（`CHARACTER_WORKFLOW_SKILL_CATALOG_ENABLED`）
// ---------------------------------------------------------------------------

/** 受信说明的解析端口（由装配层从**已核对字节**的目录资产里取，kernel 不读文件系统）。 */
export interface ManagedWorkflowSkillInstructionsPort {
  /** 精确版本 + 精确内容指纹；缺失 ⇒ undefined（不猜、不回落到别的版本） */
  readonly instructionsFor: (
    skillId: string,
    version: number,
    contentFingerprint: string
  ) => { readonly instructions: string; readonly releaseDigest: string } | undefined
  /**
   * **消费边界复核**：注入之前再读一次当前发布状态。
   *
   * ⚠️ 这不是多余的：加载与编译之间可能隔了同轮评估 / 回复生成，
   *    而"挂起/退役"必须**立刻**阻断后续消费（plan P3-2 的边界复核要求）。
   *    不传 ⇒ 不复核（只允许门里的纯函数用法）。
   */
  readonly readCurrent?: (skillId: string) => Promise<WorkflowSkillPublishedState | undefined>
  /** 被挡下的读数（诊断；**不进 prompt**、不进 trace 正文） */
  readonly onWithheld?: (input: {
    readonly skillId: string
    readonly version: number
    readonly reason: 'release_not_in_catalog' | 'release_not_published_at_injection' | 'release_not_current_at_injection' | 'release_digest_mismatch_at_injection'
  }) => void
}

export interface ManagedWorkflowSkillProviderOptions {
  readonly managed: ManagedWorkflowSkillInstructionsPort
  /** 未迁入目录的技能（writing-collaboration）：与旧 provider **同一条**判据与同一个 section 形状 */
  readonly legacySkills: readonly WorkflowSkillDefinition[]
  /**
   * **受 P3 目录管理**的技能 id 集合（2026-10-28 复核 I6）。
   *
   * ⚠️ 为什么必须有它：旧分支只按"回执形状 + 内容指纹"匹配，而 `legacySkills`
   *    里**也**含 `personal-library`（其指纹与目录登记值相同）。若不给这个集合，
   *    "personal-library 的 legacy 形状回执"就能绕过发布状态复核直接注入 —— 那是一条
   *    纯靠"上游不会这么写"维持的边界。给了 ⇒ 受管技能的 legacy 回执一律**不注入**。
   */
  readonly managedSkillIds?: readonly string[]
  readonly outcomes?: readonly ActionTurnResult[]
}

/**
 * P3 管理的受信技能 section provider。
 *
 * ============================================================================
 *  它比旧 provider 多判两件事
 * ============================================================================
 * ```text
 * ① 精确版本：加载回执里的引用必须是 `workflow-skill:<id>@<version>#<内容指纹>`，
 *    且目录里真有这一版（旧 @1 引用在旧技能上仍然按指纹匹配 —— 兼容不破）
 * ② 消费时状态：注入前复核"当前版本 + published + 摘要一致"，
 *    否则**不注入**并留一条诊断（挂起/退役后不得继续消费旧资格）
 * ```
 * ⚠️ 没有加载成功 ⇒ 0 个 section（与旧行为逐字相同：普通对话的 prompt 不受影响）。
 * ⚠️ personal-library v1 的引用字符串与旧实现**逐字相同**
 *    （`workflow-skill:personal-library@1#<旧 sha256>`）⇒ 迁移后 prompt 逐字节不变。
 */
export function createManagedWorkflowSkillProvider(
  options: ManagedWorkflowSkillProviderOptions
): ContextSectionProvider {
  const outcomes = options.outcomes ?? []
  return {
    name: 'workflow-skills',
    async provide() {
      const sections: Awaited<ReturnType<ContextSectionProvider['provide']>> = []
      const seen = new Set<string>()

      for (const { request, result } of outcomes) {
        if (request?.capability !== WORKFLOW_SKILL || request.operation !== 'load') continue
        if (result === undefined || result.accepted !== true || !result.executed || result.status !== 'success') continue
        const skillId = typeof request.arguments.skill === 'string' ? request.arguments.skill : ''
        if (skillId === '' || seen.has(skillId)) continue

        const refs = (result.evidence ?? [])
          .map((evidence) => evidence.ref)
          .filter((ref): ref is string => typeof ref === 'string')
        const releaseRef = refs.map((ref) => parseWorkflowSkillReleaseRef(ref)).find((parsed) => parsed !== undefined)

        if (releaseRef === undefined) {
          /* ---- 未迁入目录的技能：旧判据 / 旧 section 形状 ---- */
          /*
           * ⚠️ 复核 I6：受管技能的 legacy 形状回执**不得**注入（否则可绕过状态复核）。
           *    这里按 skillId 判"是否受管"，而不是按回执形状判。
           */
          const managedSkillIds = options.managedSkillIds ?? []
          if (managedSkillIds.includes(skillId)) {
            options.managed.onWithheld?.({ skillId, version: 0, reason: 'release_not_in_catalog' })
            seen.add(skillId)
            continue
          }
          const skill = options.legacySkills.find((item) =>
            item.id === skillId && result.effect?.fingerprint === item.fingerprint)
          if (skill === undefined) continue
          seen.add(skillId)
          sections.push({
            id: workflowSkillSectionId(skill.id), kind: 'instruction', priority: 56,
            content: `# 本轮流程：${skill.id}\n\n${skill.instructions}`,
            sourceRefs: [`workflow-skill:${skill.id}@1#${skill.fingerprint}`], droppable: true,
          })
          continue
        }

        const expectedRef = workflowSkillReleaseRef(releaseRef.skillId, releaseRef.version, releaseRef.contentFingerprint)
        const instructions = options.managed.instructionsFor(
          releaseRef.skillId, releaseRef.version, releaseRef.contentFingerprint)
        if (instructions === undefined) {
          options.managed.onWithheld?.({ ...releaseRef, reason: 'release_not_in_catalog' })
          seen.add(skillId)
          continue
        }

        if (options.managed.readCurrent !== undefined) {
          const state = await options.managed.readCurrent(releaseRef.skillId)
          if (state === undefined || state.version !== releaseRef.version || !state.isCurrent) {
            options.managed.onWithheld?.({ ...releaseRef, reason: 'release_not_current_at_injection' })
            seen.add(skillId)
            continue
          }
          if (state.state !== 'published') {
            options.managed.onWithheld?.({ ...releaseRef, reason: 'release_not_published_at_injection' })
            seen.add(skillId)
            continue
          }
          if (state.releaseDigest !== instructions.releaseDigest) {
            options.managed.onWithheld?.({ ...releaseRef, reason: 'release_digest_mismatch_at_injection' })
            seen.add(skillId)
            continue
          }
        }

        seen.add(skillId)
        sections.push({
          id: workflowSkillSectionId(releaseRef.skillId), kind: 'instruction', priority: 56,
          content: `# 本轮流程：${releaseRef.skillId}\n\n${instructions.instructions}`,
          sourceRefs: [expectedRef], droppable: true,
        })
      }

      return sections
    },
  }
}
