/**
 * **F1 最小契约的核心（纯函数）** —— `f1-precondition@1`
 *
 * 契约见 [F1 最小契约](docs/architecture/Cognitive-Capability-F1-Minimal-Contract-2026-10-24.md)。
 * 本文件**不碰数据库、不碰文件系统、不发模型请求**：只做
 *   ① 规则形状与身份（族是身份的一部分）
 *   ② **候选假设**的形成（失败码分流：只有 `target_occupied` 算证据）
 *   ③ 资格判定（复用既有政策口径：≥2 个**不同 binding** + 一个对照）
 *   ④ 族匹配与**候选否决**（条件未知不得当"不成立"）
 *
 * ⚠️ **成功／失败对只产生候选假设**：本文件里没有"必要性证明"，只有**使用资格**。
 * ⚠️ 本文件**不是**产品契约：离线阶段只接仿真装配，生产入口行为不变。
 */

// ---------------------------------------------------------------------------
// 规则形状与身份
// ---------------------------------------------------------------------------

export const F1_ACTION = 'sandbox.file.write' as const
export const F1_TARGET = 'f1-target.txt' as const
export const F1_CONDITION_FILE = 'f1-guard.txt' as const
export const F1_CONDITION_LOCKED = 'locked' as const
export const F1_CONDITION_READY = 'ready' as const
/** 唯一被当作**前置条件证据**的失败码。 */
export const F1_EVIDENCE_FAILURE_CODE = 'validation_failed' as const
/** **一律不得**充当前置条件证据的失败码（失败码分流）。 */
export const F1_NON_EVIDENCE_FAILURE_CODES = ['permission_denied', 'timeout', 'cancelled', 'unsupported', 'partial_success', 'target_not_found', 'target_ambiguous', 'target_uncertain', 'execution_failed'] as const

/** 守卫标记的可观测状态。 */
export type GuardState = 'locked' | 'ready' | 'unknown'

/** 规则身份：**族是身份的一部分**（不是运行时再判断）。 */
export interface F1Rule {
  readonly ruleId: string
  readonly familyId: string
  readonly action: typeof F1_ACTION
  readonly condition: typeof F1_CONDITION_FILE
  readonly mustNotEqual: typeof F1_CONDITION_LOCKED
}

/** 规则身份：**族 + 动作 + 条件**（不钉单个对象 ⇒ 同族跨对象复用）。 */
export function ruleIdFor(familyId: string): string {
  return `${familyId}:${F1_ACTION}:${F1_CONDITION_FILE}`
}

export function makeRule(familyId: string): F1Rule {
  return {
    ruleId: ruleIdFor(familyId), familyId,
    action: F1_ACTION, condition: F1_CONDITION_FILE, mustNotEqual: F1_CONDITION_LOCKED,
  }
}

// ---------------------------------------------------------------------------
// 观测与候选假设
// ---------------------------------------------------------------------------

/** 一次**真实动作回执**（只含闭集字段：能力/操作/目标/失败码/绑定）。 */
export interface F1ActionReceipt {
  readonly capability: string
  readonly operation: string
  readonly target: string
  readonly status: 'success' | 'failure'
  /** 失败码（闭集；`target_occupied` 是唯一的前置条件证据）。 */
  readonly failureCode?: string
  /** **binding**：哪个对象（不同对象才算独立证据）。 */
  readonly binding: string
  /** 同一任务里**观测到的**守卫状态（读不到就是 unknown）。 */
  readonly guard: GuardState
  /** 该 receipt 属于哪个族（由**受信映射**给出）。 */
  readonly familyId: string
}

export interface F1HypothesisEvidence {
  /** 失败的 receipt（`target_occupied` 且 guard=locked） */
  readonly receipt: F1ActionReceipt
}

/**
 * 从回执里提出**候选假设**（只认 `target_occupied` + guard=locked；失败码分流）。
 *
 * ⚠️ 返回的是**候选证据**，不是"规则成立"；资格由 qualify() 按既有政策判定。
 */
export function proposeHypothesisEvidence(receipts: readonly F1ActionReceipt[]): F1HypothesisEvidence[] {
  return receipts.flatMap(receipt => {
    if (receipt.capability !== F1_ACTION || receipt.operation !== 'write') return []
    if (receipt.status !== 'failure') return []
    if (receipt.failureCode !== F1_EVIDENCE_FAILURE_CODE) return []
    if (receipt.guard !== 'locked') return []
    if ((F1_NON_EVIDENCE_FAILURE_CODES as readonly string[]).includes(String(receipt.failureCode))) return []
    return [{ receipt }]
  })
}

// ---------------------------------------------------------------------------
// 资格判定（复用既有政策口径）
// ---------------------------------------------------------------------------

export interface F1QualificationInput {
  /** 候选假设证据（来自 {@link proposeHypothesisEvidence}） */
  readonly evidence: readonly F1HypothesisEvidence[]
  /** **对照**：标记非 locked 时直接写**成功** */
  readonly controlSuccesses: readonly F1ActionReceipt[]
  /** 反例：`guard=locked` 时直接写**成功** ⇒ 规则被反例命中 */
  readonly counterexamples: readonly F1ActionReceipt[]
}

export type F1Qualification =
  | { readonly usable: true; readonly bindings: number; readonly rule: F1Rule; readonly reason: 'qualified' }
  | { readonly usable: false; readonly bindings: number; readonly reason: 'insufficient_bindings' | 'no_control' | 'counterexample' }

/**
 * 资格判定。**口径与既有政策一致**：≥2 个**不同 binding** 的独立证据 + 一个对照；
 * 有反例 ⇒ **不可用**（并触发失效）。
 */
export function qualify(input: F1QualificationInput, rule: F1Rule): F1Qualification {
  const bindings = new Set(input.evidence.map(item => item.receipt.binding)).size
  if (input.counterexamples.length > 0) return { usable: false, bindings, reason: 'counterexample' }
  if (bindings < 2) return { usable: false, bindings, reason: 'insufficient_bindings' }
  const controls = input.controlSuccesses.filter(item => item.status === 'success' && item.guard !== 'locked'
    && item.capability === F1_ACTION && item.operation === 'write')
  if (controls.length === 0) return { usable: false, bindings, reason: 'no_control' }
  return { usable: true, bindings, rule, reason: 'qualified' }
}

// ---------------------------------------------------------------------------
// 候选与选路（否决 / 回退）
// ---------------------------------------------------------------------------

export interface F1Step { readonly capability: string; readonly operation: string; readonly args: Readonly<Record<string, string>> }
export interface F1Candidate { readonly id: 'direct' | 'prepare'; readonly steps: readonly F1Step[] }

export function directCandidate(target: string, content: string): F1Candidate {
  return { id: 'direct', steps: [
    { capability: F1_ACTION, operation: 'write', args: { path: target, content } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: target } },
  ] }
}

export function prepareCandidate(target: string, content: string, guardFile: string): F1Candidate {
  return { id: 'prepare', steps: [
    { capability: F1_ACTION, operation: 'write', args: { path: guardFile, content: F1_CONDITION_READY } },
    { capability: F1_ACTION, operation: 'write', args: { path: target, content } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: target } },
  ] }
}

export type F1SelectionReason =
  | 'rule_qualified_veto_direct'      // 规则合格 + 族匹配 + guard=locked ⇒ 否决直接候选
  | 'default_order'                    // 其余一律回默认顺序
  | 'unknown_condition_no_veto'        // 条件未知 ⇒ **不得**否决
  | 'family_mismatch'                  // 异族 ⇒ 拒用
  | 'rule_withdrawn'                   // 已撤回 ⇒ 停止消费
  | 'not_qualified'                    // 未取得资格

export interface F1Selection {
  readonly selected: 'direct' | 'prepare'
  readonly reason: F1SelectionReason
  readonly vetoed: readonly ('direct')[]
}

/**
 * 选路：**只有**"规则合格 + 族匹配 + guard=locked"才否决直接候选；
 * 条件 `unknown` **不得**被当作"不成立"（N2），异族拒用（N3），撤回即停（N4）。
 *
 * `candidates` 是**顺序可置换**的（N1）：选择跟规则走，不跟位置走。
 */
export function selectCandidate(input: {
  readonly candidates: readonly F1Candidate[]
  readonly rule: F1Rule | undefined
  readonly qualification: F1Qualification
  readonly objectFamilyId: string
  readonly guard: GuardState
  readonly withdrawn: boolean
}): F1Selection {
  const fallback: F1Selection = { selected: input.candidates[0]!.id, reason: 'default_order', vetoed: [] }
  if (input.rule === undefined) return { ...fallback, reason: 'not_qualified' }
  if (input.withdrawn) return { ...fallback, reason: 'rule_withdrawn' }
  if (input.rule.familyId !== input.objectFamilyId) return { ...fallback, reason: 'family_mismatch' }
  if (!input.qualification.usable) return { ...fallback, reason: 'not_qualified' }
  if (input.guard === 'unknown') return { ...fallback, reason: 'unknown_condition_no_veto' }
  if (input.guard !== F1_CONDITION_LOCKED) return fallback
  const prepare = input.candidates.find(item => item.id === 'prepare')
  if (prepare === undefined) return { ...fallback, reason: 'default_order' }
  return { selected: 'prepare', reason: 'rule_qualified_veto_direct', vetoed: ['direct'] }
}

// ---------------------------------------------------------------------------
// 真值泄漏检查（N8）
// ---------------------------------------------------------------------------

/** 规划器**允许**看到的字段（闭集）。任何额外字段都算泄漏。 */
export const F1_PLANNER_INPUT_ALLOWED_KEYS = ['text', 'executed', 'allowedCapabilities', 'knownDirectories', 'facts'] as const

/** 检查一份"规划器输入"里是否混入了守卫实现、真值表或规则原文。 */
export function plannerInputLeaks(input: Readonly<Record<string, unknown>>): string[] {
  const allowed = new Set<string>(F1_PLANNER_INPUT_ALLOWED_KEYS)
  const leaks = Object.keys(input).filter(key => !allowed.has(key))
  const text = JSON.stringify(input)
  for (const needle of [F1_EVIDENCE_FAILURE_CODE, F1_CONDITION_FILE, 'mustNotEqual', 'ruleId']) {
    if (text.includes(needle)) leaks.push(`contains:${needle}`)
  }
  return leaks
}
