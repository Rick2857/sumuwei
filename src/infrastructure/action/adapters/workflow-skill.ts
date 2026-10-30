import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { WORKFLOW_SKILL, WORKFLOW_SKILL_IDS, type WorkflowSkillDefinition } from '../../../kernel/action/learning-capabilities.ts'
import type { CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import {
  decideWorkflowSkillLoad,
  workflowSkillReleaseRef,
  type WorkflowSkillCatalogSkill,
  type WorkflowSkillLoadCode,
  type WorkflowSkillPublishedState,
  type WorkflowSkillRelease,
} from '../../../kernel/contracts/workflow-skill-catalog.ts'
import {
  currentLoadedRelease,
  loadedReleaseOf,
  type LoadedWorkflowSkillCatalog,
} from '../workflow-skill-catalog.ts'
import type { WorkflowSkillRuleDependencyVerdict } from '../../../kernel/contracts/workflow-skill-rule-dependency.ts'
import { dependencyBlockDetails } from '../workflow-skill-rule-dependency.ts'

const SKILL_ROOT = fileURLToPath(new URL('../../../../resources/workflow-skills/', import.meta.url))

export function loadWorkflowSkills(): readonly WorkflowSkillDefinition[] {
  const manifest = JSON.parse(readFileSync(resolve(SKILL_ROOT, 'manifest.json'), 'utf8')) as Record<string, string>
  return WORKFLOW_SKILL_IDS.map((id) => {
    const source = readFileSync(resolve(SKILL_ROOT, id, 'SKILL.md'), 'utf8')
    const fingerprint = createHash('sha256').update(source).digest('hex')
    if (manifest[id] !== fingerprint) throw new Error(`workflow_skill_assets_invalid:${id}`)
    const instructions = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
    if (instructions.length === 0 || instructions.length > 1800) throw new Error(`workflow_skill_size_invalid:${id}`)
    return { id, instructions, fingerprint }
  })
}

/** 旧路径（无 P3 目录）：**一个字节都不改**（`learning-skills-verify` 的 41 项断言守着它）。 */
export function createWorkflowSkillAdapter(skills: readonly WorkflowSkillDefinition[]): CapabilityAdapter {
  return {
    capabilityId: WORKFLOW_SKILL,
    async execute(input) {
      const skill = skills.find((item) => item.id === input.args.skill)
      if (input.operation !== 'load' || Object.keys(input.args).some((key) => key !== 'skill') || skill === undefined) {
        throw new ActionFailureError(actionFailure('validation_failed', '只能加载已登记的两个流程技能'))
      }
      return {
        effect: { kind: 'content_read', detail: `已加载流程 ${skill.id}；尚不代表用户任务完成`, fingerprint: skill.fingerprint },
        evidence: [{ kind: 'adapter', detail: '固定流程包指纹核对通过', ref: `workflow-skill:${skill.id}@1` }],
      }
    },
  }
}

// ---------------------------------------------------------------------------
// P3：目录管理路径（`CHARACTER_WORKFLOW_SKILL_CATALOG_ENABLED`）
// ---------------------------------------------------------------------------

/**
 * 加载时**失败码 → 动作失败码**的唯一映射。
 *
 * 为什么不是全部 `validation_failed`：门要能区分"这个版本不存在"（形状问题）
 * 与"这一版现在不允许被消费"（权限/状态问题）。两类混成一个码会让"挂起后不能加载"
 * 无法与"写错了版本号"分开断言。
 */
const LOAD_FAILURE_CODES: Readonly<Record<WorkflowSkillLoadCode, 'validation_failed' | 'permission_denied'>> = {
  skill_not_managed: 'validation_failed',
  skill_unknown: 'validation_failed',
  release_not_registered: 'validation_failed',
  release_digest_mismatch: 'validation_failed',
  content_fingerprint_mismatch: 'validation_failed',
  release_not_current: 'permission_denied',
  release_not_published: 'permission_denied',
  dependency_unauthorized: 'permission_denied',
  dependency_unregistered: 'permission_denied',
}

export interface ManagedWorkflowSkillAdapterOptions {
  /** 已加载并核对过字节的目录资产（`loadWorkflowSkillCatalog()` 的结果） */
  readonly loaded: LoadedWorkflowSkillCatalog
  /** 未迁入目录的技能（writing-collaboration）继续走旧行为 */
  readonly legacySkills: readonly WorkflowSkillDefinition[]
  /** 读某技能的全部版本状态（**每次加载都读**：状态可能在两轮之间变化） */
  readonly readStates: (skillId: string) => Promise<readonly WorkflowSkillPublishedState[]>
  /** 本任务实际授予的能力 id（技能声明的能力必须在此之内） */
  readonly grantedCapabilities: () => readonly string[]
  /** 已登记的能力 id（用于区分"未登记"与"未授权"；缺省不区分） */
  readonly registeredCapabilities?: () => readonly string[]
  /**
   * P3-4：**可选的规则依赖闸**（缺省不传 ⇒ 旧行为逐字不变）。
   *
   * ⚠️ 它只看"这个技能的依赖声明是否满足"，**不**替技能算资格：
   *    资格判据在 P1/P2（`selectUsableRules` / `verifyPlanRulesStillUsable`），
   *    由装配层用真实读面（`createEblRuleSnapshotPort`）组合后传进来。
   * ⚠️ 返回 `undefined` ⇒ 这个技能没有依赖声明（**不**注入"依赖通过"的假事实）。
   */
  readonly ruleDependency?: {
    readonly checkAtLoad: (skillId: string) => Promise<WorkflowSkillRuleDependencyVerdict | undefined>
  }
}

/** 受信指令引用（provider 只认这个引用，因此"加载成功"与"入模"是两个事实）。 */
function releaseRefOf(release: WorkflowSkillRelease): string {
  return workflowSkillReleaseRef(release.skillId, release.version, release.contentFingerprint)
}

/**
 * P3 管理的 `workflow.skill.load` 适配器。
 *
 * ============================================================================
 *  它比旧适配器多判三件事（顺序见 `decideWorkflowSkillLoad`）
 * ============================================================================
 * ```text
 * ① 身份：目录登记的内容指纹 == 已核对过的资产指纹 == 持久层登记的释放摘要
 * ② 状态：**当前版本**且 **published**（candidate/suspended/retired 一律拒绝）
 * ③ 依赖：技能声明的 requiredCapabilities ⊆ 本任务已授予能力（求交，不授予）
 * ```
 * ⚠️ 旧技能（未进目录）走**逐字节等价**的旧分支：`writing-collaboration` 不因 P3 改变行为。
 * ⚠️ 不做"关键词路由"：要不要加载仍由现有模型语义决策 + 目录说明决定。
 */
export function createManagedWorkflowSkillAdapter(
  options: ManagedWorkflowSkillAdapterOptions
): CapabilityAdapter {
  return {
    capabilityId: WORKFLOW_SKILL,
    async execute(input) {
      if (input.operation !== 'load' || Object.keys(input.args).some((key) => key !== 'skill') ||
          typeof input.args.skill !== 'string' || input.args.skill === '') {
        throw new ActionFailureError(actionFailure('validation_failed', '只能加载已登记的流程技能'))
      }
      const skillId = input.args.skill
      const catalogSkill: WorkflowSkillCatalogSkill | undefined =
        options.loaded.catalog.skills.find((skill) => skill.skillId === skillId)

      if (catalogSkill === undefined) {
        /* ---- 未迁入目录的技能：旧行为（逐字等价） ---- */
        const skill = options.legacySkills.find((item) => item.id === skillId)
        if (skill === undefined) {
          throw new ActionFailureError(actionFailure('validation_failed', '只能加载已登记的流程技能'))
        }
        return {
          effect: { kind: 'content_read', detail: `已加载流程 ${skill.id}；尚不代表用户任务完成`, fingerprint: skill.fingerprint },
          evidence: [{ kind: 'adapter', detail: '固定流程包指纹核对通过', ref: `workflow-skill:${skill.id}@1` }],
        }
      }

      /*
       * ⚠️ 目录里有这个技能、却没有当前版本资产 ⇒ **失败关闭**。
       *    这里绝不能退到旧分支：那会让"目录资产被删掉"变成"悄悄回到不受管理的加载"。
       *
       * ⚠️ 2026-10-28 实测修正：这里的"当前版本"必须按**持久层**解析，不能只看资产里的
       *    `currentVersion`（那只是登记种子）。否则 P3-3 发布 v2 之后，适配器仍拿 v1 的
       *    资产指纹去核对 v2 的身份 ⇒ 恒判 `content_fingerprint_mismatch`，新版本永远加载不到。
       */
      const states = await options.readStates(skillId)
      const currentFromStore = states.find((state) => state.isCurrent)
      const managed = currentFromStore === undefined
        ? currentLoadedRelease(options.loaded, skillId)
        : loadedReleaseOf(options.loaded, skillId, currentFromStore.version)
      if (managed === undefined) {
        throw new ActionFailureError(actionFailure('validation_failed', `${skillId} 的当前版本资产缺失`, {
          reason: 'release_asset_missing',
        }))
      }

      const decision = decideWorkflowSkillLoad({
        skill: catalogSkill,
        states,
        actualContentFingerprint: managed.release.contentFingerprint,
        grantedCapabilities: options.grantedCapabilities(),
        ...(options.registeredCapabilities !== undefined
          ? { registeredCapabilities: options.registeredCapabilities() }
          : {}),
      })
      if (!decision.ok) {
        throw new ActionFailureError(
          actionFailure(LOAD_FAILURE_CODES[decision.code], `技能 ${skillId} 当前不可加载：${decision.detail}`, {
            reason: decision.code,
            ...(decision.state !== undefined ? { state: decision.state } : {}),
            ...(decision.requiredCapabilities !== undefined
              ? { requiredCapabilities: decision.requiredCapabilities }
              : {}),
            ...(decision.missingCapabilities !== undefined
              ? { missingCapabilities: decision.missingCapabilities }
              : {}),
          })
        )
      }

      const release = decision.release
      /*
       * ------------------------------------------------------------------
       * P3-4 **规则依赖闸**（可选；缺省不挂 ⇒ 旧行为逐字不变）
       * ------------------------------------------------------------------
       * 顺序刻意放在状态/能力判定**之后**：先证明"这个技能现在可以加载"，
       * 再看"它声明的规则依赖是否仍然合格"——两类失败各有自己的码，不互相掩盖。
       * ⚠️ 依赖不满足 ⇒ **动作被拒**；技能没有依赖 ⇒ 这里什么都不做（不假装通过过）。
       */
      const dependency = await options.ruleDependency?.checkAtLoad(skillId)
      if (dependency !== undefined && !dependency.ok) {
        throw new ActionFailureError(
          actionFailure('permission_denied', `技能 ${skillId} 的规则依赖未满足：${dependency.block.detail}`,
            dependencyBlockDetails(dependency.block))
        )
      }
      return {
        effect: {
          kind: 'content_read',
          detail:
            `已加载流程 ${release.skillId}@${String(release.version)}（发布状态 ${decision.state}）；` +
            '尚不代表用户任务完成',
          fingerprint: release.contentFingerprint,
        },
        evidence: [
          {
            kind: 'adapter',
            detail:
              `P3 目录版本核对通过：${release.skillId}@${String(release.version)}` +
              ` · 所需能力 ${release.requiredCapabilities.join('/')}` +
              ` · 结果核验契约 ${release.resultVerificationContract}`,
            ref: releaseRefOf(release),
          },
        ],
      }
    },
  }
}
