/**
 * EBL → 受限转移模型的**适配器**（2026-10-21 · 计划 P2 第 2 步）
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 *  把一条**当前合格的 EBL 命题**（`UsableRuleSnapshot`）翻译成一条
 *  **受限转移规则**（`RestrictedTransitionRule`）—— 也就是"模型构造"那一步：
 *
 *    EBL 命题（证据资格 · 政策 · 独立根都在那边）
 *      └─ **这里**（唯一知道两边形状的地方）
 *           └─ 受限规则（**闭集数据** + 绑定的版本与指纹）
 *                └─ 受信解释器（`interpretTransition`）⇒ 预期 / 未知 / 冲突
 *
 * ============================================================================
 *  三条不许破的边界
 * ============================================================================
 * ① **只翻译"已有解释器"的命题**：翻译不出来就**不翻译**（返回 `undefined` + 原因）——
 *    **不猜**一条规则出来（"猜出来的规则"会让"模型有依据"这句话变成假的）。
 * ② **绑定必须完整**：命题 id + 规则版本 + 证据指纹，**一个都不能少**
 *    （少了就答不出"比的是哪一版"）。
 * ③ **不重算证据资格**：合格与否由 EBL 判（快照里的 `usable`），这里只做形状映射。
 */

import {
  transitionRuleId,
  type RestrictedTransitionRule,
  type TransitionRuleBinding,
} from '../../kernel/contracts/world-model-transition.ts'
import { selectUsableRules, type RuleSnapshotPort, type UsableRuleSnapshot, type VisibleRuleContext } from '../../kernel/contracts/cognitive-collaboration.ts'
import { simulateTransitionPaths, type SimulationInput, type SimulationReport } from '../../kernel/contracts/world-model-simulation.ts'
import { familyIdOfScope } from '../../kernel/contracts/write-family.ts'
import { readWritePreconditionConditions } from '../../kernel/contracts/write-precondition.ts'

/** EBL 命题 → 受限规则的翻译结果 */
export type TransitionRuleTranslation =
  | { readonly rule: RestrictedTransitionRule }
  | { readonly reason: string }

/**
 * 把一条 EBL 命题翻译成受限规则。
 *
 * ⚠️ 目前**只有两种**规则有受信解释器/判定：
 *    ① `readback_matches` × `sandbox_readback` ⇒「写进去的字节，读回来一样」；
 *    ② `write_precondition_holds` × `sandbox_write_family:<族键>` ⇒
 *       「写这个族之前，条件标记**不得**等于某个值」（**否决**语义；
 *       判定见 `decideWritePreconditionVeto`，**不**走解释器的期望/冲突三态）。
 *    其余命题（人际域、`explanation_detail` …）**不翻译** ——
 *    没有解释器就没有"预期"，硬造一个就是假装知道。
 */
export function buildTransitionRule (snapshot: UsableRuleSnapshot): TransitionRuleTranslation {
  if (!snapshot.usable) {
    return { reason: `命题当前不合格（${snapshot.status}）⇒ 不构造规则` }
  }
  if (snapshot.predicate === 'write_precondition_holds' && snapshot.expected === true) {
    return buildWritePreconditionRule(snapshot)
  }
  if (snapshot.predicate !== 'readback_matches' || snapshot.expected !== true) {
    return { reason: '该命题内容没有受信解释器 ⇒ 不构造规则' }
  }
  if (snapshot.scope !== 'sandbox_readback') {
    return { reason: `范围 ${snapshot.scope} 还没有受信解释器 ⇒ 不构造规则` }
  }
  const encoding = snapshot.conditions.encoding
  if (encoding !== 'utf8') {
    return { reason: `编码条件 ${String(encoding)} 没有受信解释器 ⇒ 不构造规则` }
  }
  const binding: TransitionRuleBinding = {
    claimId: snapshot.claimId,
    ruleVersion: snapshot.ruleVersion,
    evidenceFingerprint: snapshot.evidenceFingerprint,
  }
  const base = {
    kind: 'write_then_read_same_bytes' as const,
    action: { capability: 'sandbox.file.read', operation: 'read' },
    conditions: { ...snapshot.conditions },
    binding,
    version: snapshot.ruleVersion,
  }
  return { rule: { id: transitionRuleId(base), ...base } }
}

/**
 * **写前置条件**命题 → 受限规则（ADR-151 步骤 D）。
 *
 * ⚠️ 族是**身份的一部分**：`scope` 必须是 `sandbox_write_family:<族键>`。
 * ⚠️ 规则**不带**额外条件（`conditions` 为空）—— 条件形状在 `requires` 里，
 *    "条件**值**"来自**本任务**的受信观测，不来自规则本身。
 */
function buildWritePreconditionRule (snapshot: UsableRuleSnapshot): TransitionRuleTranslation {
  if (familyIdOfScope(snapshot.scope) === undefined) {
    return { reason: `范围 ${snapshot.scope} 不是族作用域 ⇒ 不构造规则` }
  }
  const shape = readWritePreconditionConditions(snapshot.conditions)
  if (!shape) {
    return { reason: '条件形状不是闭集两个键 ⇒ 不构造规则' }
  }
  const binding: TransitionRuleBinding = {
    claimId: snapshot.claimId,
    ruleVersion: snapshot.ruleVersion,
    evidenceFingerprint: snapshot.evidenceFingerprint,
  }
  const base = {
    kind: 'write_requires_condition' as const,
    action: { capability: 'sandbox.file.write', operation: 'write' },
    conditions: {},
    requires: { conditionPath: shape.conditionPath, mustNotEqual: shape.mustNotEqual },
    ...(shape.sourceScope === undefined ? {} : { sourceScope: shape.sourceScope }),
    binding,
    version: snapshot.ruleVersion,
  }
  return { rule: { id: transitionRuleId(base), ...base } }
}

/** 每次模拟重新读当前资格；报告只是推演，不能代替行动前的依赖检查。 */
export async function simulateCurrentTransition (input: Omit<SimulationInput, 'rule'> & {
  readonly snapshot: RuleSnapshotPort
  readonly claimId: string
  readonly visible: Omit<VisibleRuleContext, 'conditions'>
}): Promise<{ readonly ok: true; readonly report: SimulationReport } | { readonly ok: false; readonly reason: string }> {
  const current = await input.snapshot.current(input.claimId)
  const selection = selectUsableRules({ snapshots: current === undefined ? [] : [current],
    visible: { ...input.visible, conditions: input.initialState.facts } })
  const selected = selection.selected[0]
  if (selected === undefined) return { ok: false, reason: selection.skipped[0]?.reason ?? 'rule_missing' }
  const translated = buildTransitionRule(selected)
  if (!('rule' in translated)) return { ok: false, reason: translated.reason }
  return { ok: true, report: simulateTransitionPaths({ ...input, rule: translated.rule }) }
}
