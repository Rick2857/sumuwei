/**
 * P3-4 —— **技能 → P2 规则依赖**的适配层（基础设施，只读）。
 *
 * ============================================================================
 *  它做两件事（其余全在 kernel 的纯判据里）
 * ============================================================================
 * ```text
 * ① 读**测试技能资产**里的旁挂声明 `<root>/<skillId>/rule-dependencies.json`
 *    （产品目录里的技能没有这个文件 ⇒ 没有依赖 ⇒ 旧行为逐字不变）
 * ② 把"声明的 claimId"接到**真实资格读面**（P1/P2 的 `RuleSnapshotPort`，
 *    生产实现是 `createEblRuleSnapshotPort` ⇒ 读的是 EBL 的只读快照）
 * ```
 *
 * ⚠️ 本文件**不**判资格：合格与否由 P2 的判据（`selectUsableRules` /
 *    `verifyPlanRulesStillUsable`）算，本文件只提供输入与读面。
 * ⚠️ 本文件**不写**任何状态：不写 EBL、不写发布状态、不改技能目录。
 * ⚠️ 本文件**不认识** EBL 存储：它只依赖 `RuleSnapshotPort` 这个端口
 *    （EBL 侧的形状映射在 `infrastructure/runtime/ebl-rule-snapshot.ts`）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  decideSkillRuleDependenciesAtLoad,
  decideSkillRuleDependenciesBeforeAction,
  parseWorkflowSkillRuleDependencies,
  type WorkflowSkillRuleDependencyBlock,
  type WorkflowSkillRuleDependencyDeclaration,
  type WorkflowSkillRuleDependencyVerdict,
} from '../../kernel/contracts/workflow-skill-rule-dependency.ts'
import type {
  PlanRuleDependency,
  RuleSnapshotPort,
  UsableRuleSnapshot,
  VisibleRuleContext,
} from '../../kernel/contracts/cognitive-collaboration.ts'

/** 声明的文件名（固定；不扫描目录，避免"多个文件里挑一个"的歧义） */
export const WORKFLOW_SKILL_RULE_DEPENDENCY_FILE = 'rule-dependencies.json'

export type WorkflowSkillRuleDependencyAssetResult =
  | { readonly ok: true; readonly skillId: string; readonly declarations: readonly WorkflowSkillRuleDependencyDeclaration[] }
  | { readonly ok: false; readonly code: 'file_unreadable' | 'file_invalid'; readonly detail: string }

/**
 * 读一份技能的依赖声明。
 *
 * - **文件不存在** ⇒ 返回 `ok:true` + 空声明（"这个技能没有规则依赖"是合法状态，
 *   不是错误；产品目录里的技能都属于这一类）。
 * - **文件存在但坏** ⇒ `ok:false`（失败关闭：坏声明不能让技能"变成没有依赖"）。
 */
export function loadWorkflowSkillRuleDependencies(
  root: string,
  skillId: string
): WorkflowSkillRuleDependencyAssetResult {
  const path = join(root, skillId, WORKFLOW_SKILL_RULE_DEPENDENCY_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENOENT') return { ok: true, skillId, declarations: [] }
    return { ok: false, code: 'file_unreadable', detail: `读不到 ${path}：${(error as Error).message}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (error) {
    return { ok: false, code: 'file_invalid', detail: `${path} 不是合法 JSON：${(error as Error).message}` }
  }
  const parsed = parseWorkflowSkillRuleDependencies(raw)
  if (!parsed.ok) return { ok: false, code: 'file_invalid', detail: `${path}：${parsed.code} — ${parsed.detail}` }
  if (parsed.file.skillId !== skillId) {
    return {
      ok: false,
      code: 'file_invalid',
      detail: `${path} 的 skillId=${parsed.file.skillId} 与目录里的 ${skillId} 不一致`,
    }
  }
  return { ok: true, skillId, declarations: parsed.file.dependencies }
}

/** 依赖检查器（**按技能**一个；由装配层持有，加载成功后它记住基线） */
export interface WorkflowSkillRuleDependencyChecker {
  readonly skillId: string
  readonly declarations: readonly WorkflowSkillRuleDependencyDeclaration[]
  /** 加载时：声明的规则必须当前合格；成功 ⇒ 记住基线 */
  checkAtLoad: () => Promise<WorkflowSkillRuleDependencyVerdict>
  /** 动作前：基线必须仍然成立（不重新算"哪些规则适用"，只复核这一版还在不在） */
  checkBeforeAction: () => Promise<WorkflowSkillRuleDependencyVerdict>
  /** 加载成功后捕获的基线（未成功加载 ⇒ 空） */
  baselines: () => readonly PlanRuleDependency[]
}

/**
 * 建一个只读检查器。
 *
 * ⚠️ 读面按**声明逐条**取（`port.current`），不 `list()` 全库：
 *    依赖是**点名**的，全库枚举会让"读面里有没有别的东西"污染判据。
 */
export function createWorkflowSkillRuleDependencyChecker(options: {
  readonly skillId: string
  readonly declarations: readonly WorkflowSkillRuleDependencyDeclaration[]
  readonly snapshot: RuleSnapshotPort
  readonly visible: VisibleRuleContext
}): WorkflowSkillRuleDependencyChecker {
  let captured: readonly PlanRuleDependency[] = []
  return {
    skillId: options.skillId,
    declarations: options.declarations,
    baselines: () => captured,
    async checkAtLoad(): Promise<WorkflowSkillRuleDependencyVerdict> {
      if (options.declarations.length === 0) {
        captured = []
        return { ok: true, baselines: [] }
      }
      let snapshots: UsableRuleSnapshot[]
      try {
        snapshots = []
        for (const declaration of options.declarations) {
          const snapshot = await options.snapshot.current(declaration.claimId)
          if (snapshot !== undefined) snapshots.push(snapshot)
        }
      } catch {
        captured = []
        return decideSkillRuleDependenciesAtLoad({
          declarations: options.declarations,
          snapshots: [],
          visible: options.visible,
          snapshotUnreadable: true,
        })
      }
      const verdict = decideSkillRuleDependenciesAtLoad({
        declarations: options.declarations,
        snapshots,
        visible: options.visible,
      })
      captured = verdict.ok ? verdict.baselines : []
      return verdict
    },
    async checkBeforeAction(): Promise<WorkflowSkillRuleDependencyVerdict> {
      return decideSkillRuleDependenciesBeforeAction({ baselines: captured, snapshot: options.snapshot })
    },
  }
}

/** 供装配层把"阻断记录"塞进动作失败详情（保持闭集字段，不夹带正文） */
export function dependencyBlockDetails(block: WorkflowSkillRuleDependencyBlock): Record<string, string> {
  return {
    reason: block.code,
    phase: block.phase,
    detail: block.detail.slice(0, 300),
    ...(block.claimId !== undefined ? { claimId: block.claimId } : {}),
    ...(block.ruleStatus !== undefined ? { ruleStatus: block.ruleStatus } : {}),
    ...(block.ruleReason !== undefined ? { ruleReason: block.ruleReason } : {}),
    dependencyVersion: block.dependencyVersion,
  }
}
