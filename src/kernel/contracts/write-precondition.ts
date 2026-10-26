/**
 * **写前置条件的证据分类**（ADR-151 步骤 C，纯函数、无 IO）。
 *
 * 契约（[ADR-151](../../../docs/adr/ADR-151-f1-precondition-rule-productization.md) §D-C）：
 * ① **唯一证据码** = `validation_failed`（失败码是闭集，**不得发明新码**）；
 * ② **失败码分流**：9 个排除码（权限/超时/取消/不支持/部分成功/目标不存在/歧义/不确定/执行失败）**一律不算**证据；
 * ③ 失败只有在**同一 episode 里观测到条件被违反**时才是证据（否则归因不了）；
 * ④ **成功/失败对只产生候选假设**（没有"必要性证明"，只有**使用资格**）；
 * ⑤ **对照**：条件**未**被违反时的成功（证明失败是**有条件的**，不是无条件的）；
 * ⑥ **反例**：条件被违反时却成功 ⇒ 规则被反驳；
 * ⑦ **资格口径复用既有政策**（`eblMeetsPolicy` 的工具域口径）：
 *    ≥2 独立支持 / ≥2 episode / ≥2 binding / ≥2 design，且**必须有一个对照**。
 */
import { validateFamilyId, familyIdOfScope } from './write-family.ts'
import { WRITE_SOURCE_SCOPES, type WriteSourceScope } from './world-model-transition.ts'

/** 唯一的前置条件证据失败码。 */
export const WRITE_PRECONDITION_EVIDENCE_FAILURE_CODE = 'validation_failed' as const

/**
 * **条件标记回执**的前缀（闭集）：受信读面把观测到的**条件值**记在读动作的证据里。
 *
 * ⚠️ 值必须是**机器码**（`[A-Za-z0-9_.-]{1,64}`）—— 不是任意正文。
 * ⚠️ 不满足字符集 ⇒ **不出回执** ⇒ 条件**未知** ⇒ 归因不了（不猜）。
 */
export const SANDBOX_CONDITION_RECEIPT_PREFIX = 'sandbox-condition@1:' as const

/** 条件值的字符集（**闭集**：机器码，不是自由文本）。 */
export const CONDITION_VALUE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

/** 命题条件里的两个键（**闭集**，与 EBL 的 `conditions` 形状一致）。 */
export const WRITE_PRECONDITION_CONDITION_KEYS = {
  path: 'condition_path',
  forbidden: 'must_not_equal',
} as const

/**
 * **受信的"族 → 前置条件"声明**。
 *
 * ⚠️ 它**只能**来自受信侧（装配层给的族映射表）——
 *    **不**来自模型输出、任务文本、文件名启发式。
 * ⚠️ 没有声明 ⇒ 该族**没有**前置条件 ⇒ 不形成任何命题（不是"任意条件都行"）。
 */
export interface WritePreconditionDeclaration {
  readonly familyId: string
  /** 条件标记的路径（相对沙箱根）。 */
  readonly conditionPath: string
  /** 被违反时写会失败的那个值。 */
  readonly mustNotEqual: string
}

/** 校验受信声明（**失败关闭**：不合法就抛，不静默降级）。 */
export function validateWritePreconditionDeclaration(input: unknown): WritePreconditionDeclaration {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('write_precondition_bad_declaration')
  }
  const value = input as Record<string, unknown>
  const keys = Object.keys(value).sort()
  if (keys.length !== 3 || keys.join(',') !== 'conditionPath,familyId,mustNotEqual') {
    throw new Error('write_precondition_bad_declaration')
  }
  const familyId = validateFamilyId(String(value.familyId))
  const conditionPath = String(value.conditionPath)
  const mustNotEqual = String(value.mustNotEqual)
  if (!CONDITION_VALUE_PATTERN.test(mustNotEqual)) throw new Error('write_precondition_bad_declaration')
  if (conditionPath === '' || conditionPath.length > 256 || /[\x00-\x1f]/.test(conditionPath)) {
    throw new Error('write_precondition_bad_declaration')
  }
  if (conditionPath.includes('..') || conditionPath.startsWith('/')) throw new Error('write_precondition_bad_declaration')
  return { familyId, conditionPath, mustNotEqual }
}

/** 把受信声明变成 EBL `conditions`（**闭集两个键**）。 */
export function writePreconditionConditions(declaration: WritePreconditionDeclaration, sourceScope?: WriteSourceScope): Record<string, string> {
  return {
    [WRITE_PRECONDITION_CONDITION_KEYS.path]: declaration.conditionPath,
    [WRITE_PRECONDITION_CONDITION_KEYS.forbidden]: declaration.mustNotEqual,
    ...(sourceScope === undefined ? {} : { source_scope: sourceScope }),
  }
}

/** 解析 EBL `conditions`（只认闭集两个键；不合法 ⇒ `undefined`）。 */
export function readWritePreconditionConditions(
  conditions: Record<string, string>,
): { conditionPath: string; mustNotEqual: string; sourceScope?: WriteSourceScope } | undefined {
  const keys = Object.keys(conditions).sort()
  const expected: string[] = [WRITE_PRECONDITION_CONDITION_KEYS.path, WRITE_PRECONDITION_CONDITION_KEYS.forbidden].sort()
  const sourceScope = conditions.source_scope
  if (sourceScope !== undefined) {
    if (!(WRITE_SOURCE_SCOPES as readonly string[]).includes(sourceScope)) return undefined
    expected.push('source_scope'); expected.sort()
  }
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return undefined
  const conditionPath = conditions[WRITE_PRECONDITION_CONDITION_KEYS.path]
  const mustNotEqual = conditions[WRITE_PRECONDITION_CONDITION_KEYS.forbidden]
  if (typeof conditionPath !== 'string' || typeof mustNotEqual !== 'string') return undefined
  if (!CONDITION_VALUE_PATTERN.test(mustNotEqual)) return undefined
  if (conditionPath === '' || conditionPath.length > 256 || /[\x00-\x1f]/.test(conditionPath)) return undefined
  return { conditionPath, mustNotEqual, ...(sourceScope === undefined ? {} : { sourceScope: sourceScope as WriteSourceScope }) }
}

/** 受信读面的**条件值**回执：写进证据 ref 的一段（闭集前缀 + 机器码）。 */
export function encodeSandboxConditionReceipt(value: string): string | undefined {
  if (!CONDITION_VALUE_PATTERN.test(value)) return undefined
  return `${SANDBOX_CONDITION_RECEIPT_PREFIX}${value}`
}

/** 从证据 ref 里读回条件值（不是条件回执 ⇒ `undefined`）。 */
export function readSandboxConditionReceipt(ref: unknown): string | undefined {
  if (typeof ref !== 'string' || !ref.startsWith(SANDBOX_CONDITION_RECEIPT_PREFIX)) return undefined
  const value = ref.slice(SANDBOX_CONDITION_RECEIPT_PREFIX.length)
  return CONDITION_VALUE_PATTERN.test(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// **否决真值表**（ADR-151 步骤 D）
// ---------------------------------------------------------------------------

/**
 * 否决的**具名原因**（闭集；机器判定，不是自由文本）。
 *
 * ⚠️ 方向**不许写反**：**观测值等于 `mustNotEqual`** 才意味着"前置条件被违反"
 *    （那次写会被拒绝）⇒ **才**否决。值**不等于**它 ⇒ 前置条件成立 ⇒ 写**可以**做
 *    ⇒ **不否决**。条件**未知** ⇒ 也**不否决**（不猜）。
 */
export const WRITE_PRECONDITION_VETO_REASONS = [
  'switch_off',              // 开关关闭 ⇒ 这条能力整段没开
  'rule_not_qualified',      // 没有**当前合格**的规则（未合格 / 被挂起 / 已撤回）
  'family_mismatch',         // 规则属于**另一个族** ⇒ 拒用（不是"不适用"）
  'condition_unknown',       // 条件**未知**（本任务没有受信观测）⇒ 不猜
  'condition_not_violated',  // 条件**成立**（观测值 ≠ mustNotEqual）⇒ 写可以做
  'precondition_violated',   // ⚠️ **观测值 == mustNotEqual** ⇒ 前置条件被违反 ⇒ **否决**
] as const
export type WritePreconditionVetoReason = (typeof WRITE_PRECONDITION_VETO_REASONS)[number]

export interface WritePreconditionVetoDecision {
  /** 是否**否决**这个写动作。 */
  readonly veto: boolean
  readonly reason: WritePreconditionVetoReason
  /** 规则 id（内容寻址）。 */
  readonly ruleId?: string
  /** 规则版本（= 命题 id；改了就是另一条规则）。 */
  readonly ruleVersion?: string
  readonly conditionPath?: string
  /** 受信观测的**来源**（读动作 id）—— 条件值从哪儿来的。 */
  readonly conditionSource?: string
  /** 受信观测到的条件值。 */
  readonly observedValue?: string
}

/** 一条**可用于否决**的规则（**当前合格**的才有资格进来）。 */
export interface WritePreconditionVetoRule {
  readonly id: string
  readonly version: string
  /** 族作用域（`sandbox_write_family:<族键>`）。 */
  readonly scope: string
  readonly requires: { readonly conditionPath: string; readonly mustNotEqual: string }
}

/**
 * **否决真值表**（纯函数、零 IO）。
 *
 * ```text
 * 开关关            ⇒ 不否决（switch_off）
 * 没有当前合格的规则 ⇒ 不否决（rule_not_qualified）
 * 族不匹配          ⇒ 不否决（family_mismatch）
 * 条件未知          ⇒ 不否决（condition_unknown）   ← **不猜**
 * 观测值 ≠ mustNotEqual ⇒ 不否决（condition_not_violated）← 条件**成立**，写可以做
 * 观测值 = mustNotEqual ⇒ **否决**（precondition_violated）← 前置条件被违反
 * ```
 *
 * ⚠️ 只有**最后一行**否决；其余一律**不否决**（回默认顺序）。
 */
export function decideWritePreconditionVeto(input: {
  readonly enabled: boolean
  /** **当前合格**的规则；没有 ⇒ `rule_not_qualified`。 */
  readonly rule?: WritePreconditionVetoRule
  /** 这次写的目标**属于哪个族**（受信目录事实算出来的）。 */
  readonly targetFamilyId?: string
  /** **本任务**受信观测到的条件值；没有 ⇒ 未知。 */
  readonly conditionValue?: string
  /** 受信观测的来源（读动作 id）。 */
  readonly conditionSource?: string
}): WritePreconditionVetoDecision {
  if (!input.enabled) return { veto: false, reason: 'switch_off' }
  const rule = input.rule
  if (rule === undefined) return { veto: false, reason: 'rule_not_qualified' }
  const familyId = familyIdOfScope(rule.scope)
  if (familyId === undefined) return { veto: false, reason: 'rule_not_qualified', ruleId: rule.id, ruleVersion: rule.version }
  if (input.targetFamilyId === undefined || input.targetFamilyId !== familyId) {
    return { veto: false, reason: 'family_mismatch', ruleId: rule.id, ruleVersion: rule.version }
  }
  if (input.conditionValue === undefined) {
    return {
      veto: false, reason: 'condition_unknown', ruleId: rule.id, ruleVersion: rule.version, conditionPath: rule.requires.conditionPath,
      ...(input.conditionSource === undefined ? {} : { conditionSource: input.conditionSource }),
    }
  }
  const observed = {
    ruleId: rule.id, ruleVersion: rule.version, conditionPath: rule.requires.conditionPath,
    conditionSource: input.conditionSource, observedValue: input.conditionValue,
  }
  if (input.conditionValue !== rule.requires.mustNotEqual) {
    return { veto: false, reason: 'condition_not_violated', ...observed }
  }
  return { veto: true, reason: 'precondition_violated', ...observed }
}

/**
 * 把**否决**套到候选上（纯函数）。
 *
 * ⚠️ 只否决**执行写**的候选（只读的候选不受影响）。
 * ⚠️ **全部**候选被否决 ⇒ `eligible` 为空 ⇒ 调用方**不许**记成目标达成
 *    （回退是"如实失败"，不是"挑一个被否决的候选"）。
 * ⚠️ 否决**与候选顺序无关**（置换候选池不改变判定）。
 */
export function applyPreconditionVeto<T extends { readonly id: string }>(input: {
  readonly decision: WritePreconditionVetoDecision
  readonly candidates: readonly T[]
  /** 这个候选**会不会写进那个族**。 */
  readonly writesIntoFamily: (candidate: T) => boolean
}): { readonly eligible: readonly T[]; readonly vetoed: readonly T[] } {
  if (!input.decision.veto) return { eligible: [...input.candidates], vetoed: [] }
  const eligible: T[] = []
  const vetoed: T[] = []
  for (const candidate of input.candidates) {
    if (input.writesIntoFamily(candidate)) vetoed.push(candidate)
    else eligible.push(candidate)
  }
  return { eligible, vetoed }
}

/** **一律不算**证据的失败码（失败码分流）。 */
export const WRITE_PRECONDITION_EXCLUDED_FAILURE_CODES = [
  'permission_denied', 'timeout', 'cancelled', 'unsupported', 'partial_success',
  'target_not_found', 'target_ambiguous', 'target_uncertain', 'execution_failed',
] as const

/** 工具域的写能力（唯一可被前置条件约束的动作）。 */
export const WRITE_PRECONDITION_ACTION = { capability: 'sandbox.file.write', operation: 'write' } as const

/** 一次**真实动作回执**加上**受信读面**观测到的条件值。 */
export interface WritePreconditionReceipt {
  readonly capability: string
  readonly operation: string
  /** 对象（**binding**：不同对象才算独立证据）。 */
  readonly target: string
  /** episode（独立上下文）。 */
  readonly episodeId: string
  /** design（独立设计/写入动作）。 */
  readonly designId: string
  readonly status: 'success' | 'failure'
  /** 失败码（闭集）。 */
  readonly failureCode?: string
  /** **受信读面**观测到的条件（条件文件路径 + 其内容）。没有 ⇒ 条件未知。 */
  readonly conditionObserved?: { readonly conditionPath: string; readonly value: string }
}

/** 候选假设（**只是候选**）。 */
export interface WritePreconditionHypothesis {
  readonly familyId: string
  readonly action: { readonly capability: string; readonly operation: string }
  readonly conditionPath: string
  readonly mustNotEqual: string
}

export type WritePreconditionVerdict =
  | {
    readonly kind: 'candidate'
    readonly hypothesis: WritePreconditionHypothesis
    readonly evidenceBindings: readonly string[]
    readonly controlBindings: readonly string[]
    readonly independentSupports: number
  }
  | {
    readonly kind: 'insufficient_independence'
    readonly evidenceBindings: readonly string[]
    readonly controlBindings: readonly string[]
    readonly independentSupports: number
    readonly missing: readonly ('bindings' | 'episodes' | 'designs' | 'control')[]
  }
  | { readonly kind: 'refuted'; readonly counterexampleBindings: readonly string[] }
  | { readonly kind: 'no_evidence' }

/**
 * **一次回执的观测读数**（C1 的判定与产品接线**共用**这一份 ⇒ 两边不会各自漂移）。
 *
 * ⚠️ `kind` 与 EBL 的结算结论一一对应：
 * `evidence` ⇒ 支持 · `control` ⇒ 对照（inconclusive 但计入对照口径）·
 * `counterexample` ⇒ 反例 · `excluded` ⇒ 排除（失败码分流）· `unknown` ⇒ 归因不了。
 */
export interface WritePreconditionObservationReading {
  readonly kind: 'evidence' | 'control' | 'counterexample' | 'excluded' | 'unknown'
  /** 条件**确实被观测到**（且由受信侧拥有）⇒ 才能当证据或对照。 */
  readonly witnessed: boolean
  /** 这次观察**完整**（失败/排除/未知 ⇒ 不完整 ⇒ 不进对照口径）。 */
  readonly complete: boolean
  readonly value?: boolean
  readonly excluded?: 'interface_failure' | 'transport_failure' | 'permission_denied' | 'cancelled'
}

/**
 * 把**一次回执**读成一次观测（纯函数，零 IO）。
 *
 * ⚠️ 规则（与 ADR §D-C 一一对应）：
 * ① 条件**未知**（没观测到，或标记不是受信侧拥有）⇒ `unknown`（归因不了，不猜）；
 * ② 写**成功** ⇒ 条件被违反是 `counterexample`，否则是 `control`；
 * ③ 写**失败** ⇒ 只有证据码（`validation_failed`）**且**条件被违反**且**真的执行了才是 `evidence`；
 * ④ 其余失败（别的失败码 / 闭集之外的码 / 被拒 / 取消）⇒ `excluded`（一律不算证据）。
 */
export function classifyWritePreconditionObservation(input: {
  readonly status: 'success' | 'failure' | 'rejected' | 'cancelled'
  readonly failureCode?: string
  readonly conditionObserved?: { readonly conditionPath: string; readonly value: string }
  readonly conditionPath: string
  readonly mustNotEqual: string
  readonly executed: boolean
  /** 条件标记**是不是由受信侧拥有**（代理写过 ⇒ 不是）。 */
  readonly conditionTrusted: boolean
}): WritePreconditionObservationReading {
  const observed = input.conditionObserved
  const witnessed = input.conditionTrusted && observed !== undefined && observed.conditionPath === input.conditionPath
  const violated = witnessed && observed!.value === input.mustNotEqual
  if (!witnessed) return { kind: 'unknown', witnessed: false, complete: false }
  if (input.status === 'success') {
    return violated
      ? { kind: 'counterexample', witnessed: true, complete: true, value: false }
      : { kind: 'control', witnessed: true, complete: true }
  }
  if (input.status === 'failure' && input.failureCode === WRITE_PRECONDITION_EVIDENCE_FAILURE_CODE) {
    if (violated && input.executed) return { kind: 'evidence', witnessed: true, complete: true, value: true }
    return { kind: 'excluded', witnessed: true, complete: false, excluded: 'interface_failure' }
  }
  const excluded = (WRITE_PRECONDITION_EXCLUDED_FAILURE_CODES as readonly string[]).includes(String(input.failureCode))
    ? input.failureCode === 'permission_denied' ? 'permission_denied' as const
      : input.failureCode === 'timeout' ? 'transport_failure' as const
        : input.failureCode === 'cancelled' ? 'cancelled' as const : 'interface_failure' as const
    : 'interface_failure' as const
  return { kind: 'excluded', witnessed: true, complete: false, excluded }
}

const distinct = (values: readonly string[]): number => new Set(values).size

/**
 * 把回执分类成**候选假设 / 不足 / 被反驳 / 无证据**。
 *
 * ⚠️ **只**给候选假设：这里**没有**"必要条件"的证明，也没有"相关性升级"的路径。
 */
export function classifyWritePreconditionEvidence(input: {
  readonly receipts: readonly WritePreconditionReceipt[]
  readonly familyId: string
  readonly conditionPath: string
  readonly mustNotEqual: string
}): WritePreconditionVerdict {
  const familyId = validateFamilyId(input.familyId)
  const evidence: WritePreconditionReceipt[] = []
  const controls: WritePreconditionReceipt[] = []
  const counterexamples: WritePreconditionReceipt[] = []

  for (const receipt of input.receipts) {
    if (receipt.capability !== WRITE_PRECONDITION_ACTION.capability || receipt.operation !== WRITE_PRECONDITION_ACTION.operation) continue
    const observed = receipt.conditionObserved
    const conditionKnown = observed !== undefined && observed.conditionPath === input.conditionPath
    const violated = conditionKnown && observed.value === input.mustNotEqual
    if (receipt.status === 'failure') {
      // ⚠️ **失败码分流**：只有证据码算数；排除码**一律不算**。
      if (receipt.failureCode === undefined) continue
      if (receipt.failureCode !== WRITE_PRECONDITION_EVIDENCE_FAILURE_CODE) continue
      if ((WRITE_PRECONDITION_EXCLUDED_FAILURE_CODES as readonly string[]).includes(receipt.failureCode)) continue
      // ⚠️ **条件未知 ⇒ 归因不了**（不猜）。
      if (!violated) continue
      evidence.push(receipt)
      continue
    }
    // 成功：条件被违反却成功 ⇒ **反例**；否则是**对照**。
    if (violated) counterexamples.push(receipt)
    else controls.push(receipt)
  }

  if (counterexamples.length > 0) {
    return { kind: 'refuted', counterexampleBindings: [...new Set(counterexamples.map(item => item.target))].sort() }
  }
  if (evidence.length === 0) return { kind: 'no_evidence' }

  const evidenceBindings = [...new Set(evidence.map(item => item.target))].sort()
  const controlBindings = [...new Set(controls.map(item => item.target))].sort()
  const independentSupports = distinct(evidence.map(item => item.episodeId))
  const missing: Array<'bindings' | 'episodes' | 'designs' | 'control'> = []
  if (evidenceBindings.length < 2) missing.push('bindings')
  if (independentSupports < 2) missing.push('episodes')
  if (distinct(evidence.map(item => item.designId)) < 2) missing.push('designs')
  if (controlBindings.length < 1) missing.push('control')
  if (missing.length > 0) {
    return { kind: 'insufficient_independence', evidenceBindings, controlBindings, independentSupports, missing }
  }
  return {
    kind: 'candidate',
    hypothesis: {
      familyId,
      action: { capability: WRITE_PRECONDITION_ACTION.capability, operation: WRITE_PRECONDITION_ACTION.operation },
      conditionPath: input.conditionPath,
      mustNotEqual: input.mustNotEqual,
    },
    evidenceBindings,
    controlBindings,
    independentSupports,
  }
}
