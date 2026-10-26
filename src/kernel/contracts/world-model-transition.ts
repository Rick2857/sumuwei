/**
 * 受限转移模型 · **契约**（2026-10-21 · 认知能力建设计划 P2 第 2 步）
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 *  计划 §3 P2 第 2 步逐字要求：
 *
 *      「先用**闭集数据规则**和**受信解释器**形成单步转移；**绑定规则版本与来源指纹**，
 *        **回放保留观察**。自然语言用于解释，**不执行模型生成的任意代码**。」
 *
 *  ⇒ 本文件给出三样东西：
 *    ① **闭集数据规则**（`RestrictedTransitionRule`）—— 规则是**数据**，不是程序；
 *    ② **受信解释器**（`interpretTransition`）—— **程序**按规则的 `kind` 求值；
 *    ③ **回放**（`replayTransition`）—— 用**保留的观察**检验模型是否忠实。
 *
 * ============================================================================
 *  四条不许破的边界
 * ============================================================================
 * ① **不执行模型生成的代码**：规则里**没有**任何可执行片段的位置 ——
 *    它只有闭集的 `kind` + 键值参数 + 闭集的条件。
 *    解释器是**我们自己写的程序**，按 `kind` 分派（不是"跑规则里的东西"）。
 * ② **自然语言只用于解释**：规则的**判定**全部由**闭集谓词**完成
 *    （`same_content_fingerprint`），不靠一句话解释。
 * ③ **未知就是未知**：条件未知 / 事实缺失 ⇒ `unknown`，
 *    **不**猜一个"最可能"的结果（那是"假装知道"）。
 * ④ **回放不全不能报全覆盖通过**：回放报告带**覆盖数**，缺失的部分单列。
 *
 * ⚠️ 纯类型 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 * ⚠️ 本文件**不认识 EBL**（规则与 EBL 命题的映射在**适配器**里）。
 */

import { KernelError } from './ids.ts'

/** 本契约自身的版本（读数要能回答"这份数据按哪一版形状写的"）。 */
export const WORLD_MODEL_TRANSITION_VERSION = 'world-model-transition@1'

// ---------------------------------------------------------------------------
// 观察到的状态
// ---------------------------------------------------------------------------

/**
 * 已发生动作的**具名**事实（**不含正文**）。
 *
 * ⚠️ "具名"是指：只有**闭集**的键（路径、内容指纹、编码……），
 *    绝不把文件内容复制进模型（隐私纪律：账本不存正文）。
 */
export interface ObservedActionFact {
  /** 动作 id（引用） */
  readonly actionId: string
  /** 能力（`能力.操作`） */
  readonly capability: string
  /** 操作 */
  readonly operation: string
  /** 终态（闭集状态码） */
  readonly status: string
  /** 具名效果（闭集键值；例：`contentFingerprint`） */
  readonly effects: Readonly<Record<string, string>>
}

/** 观察到的状态（动作事实 + 当前已知的环境事实） */
export interface ObservedTransitionState {
  /** 已发生动作的事实（按发生顺序） */
  readonly actions: readonly ObservedActionFact[]
  /**
   * 当前**已知**的环境事实。
   *
   * ⚠️ 键的**集合**就是"我们知道什么"；值是取值。
   *    ⇒ 规则要一个**我们不知道**的事实 ⇒ `unknown`（不是"没有"）。
   */
  readonly facts: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// 受限规则
// ---------------------------------------------------------------------------

/** 规则种类（**闭集**；每一种有一个**受信解释器**分支）。 */
export const TRANSITION_RULE_KINDS = ['write_then_read_same_bytes', 'write_requires_condition'] as const
export type TransitionRuleKind = (typeof TRANSITION_RULE_KINDS)[number]

/**
 * **前置条件**的枚举形状（ADR-151 步骤 A）。
 *
 * ⚠️ 只允许这两个字段：**不做表达式**、不做多条件组合、不允许模型可写。
 * ⚠️ 只对 `write_requires_condition` 有效；`write_then_read_same_bytes` **不得**带它。
 */
export interface WriteConditionRequirement {
  /** 条件对象的路径（它的**已观测内容**是条件值） */
  readonly conditionPath: string
  /** 条件**不得**等于这个值（等于 ⇒ 该写入会被拒绝） */
  readonly mustNotEqual: string
}

/** `requires` 的**唯一**允许字段（闭集；多一个就拒）。 */
export const WRITE_REQUIREMENT_KEYS = ['conditionPath', 'mustNotEqual'] as const
/**
 * **来源作用域闭集**（F2 最小接点 R1）：只区分"缓存源派生"与"权威源派生"。
 * 缺省（undefined）= 不限来源（等价于现状：约束该族所有写）。
 */
export const WRITE_SOURCE_SCOPES = ['cache', 'authoritative'] as const
export type WriteSourceScope = (typeof WRITE_SOURCE_SCOPES)[number]

/** 规则绑定的来源（**版本 + 指纹**都要，否则"比的是哪一版"答不出来）。 */
export interface TransitionRuleBinding {
  /** 命题 id（引用） */
  readonly claimId: string
  /** 规则版本 */
  readonly ruleVersion: string
  /** 证据指纹（证据动过就会变） */
  readonly evidenceFingerprint: string
}

/**
 * 一条**受限转移规则**（数据，不是程序）。
 *
 * ⚠️ 它**不能**包含任何可执行片段：形状里没有"代码"这个位置。
 */
export interface RestrictedTransitionRule {
  /** 规则 id */
  readonly id: string
  /** 规则版本（改一次规则就换一个） */
  readonly version: string
  /** 规则种类（闭集） */
  readonly kind: TransitionRuleKind
  /** 规则适用的动作（能力 + 操作） */
  readonly action: { readonly capability: string; readonly operation: string }
  /**
   * 规则成立**需要**的条件（闭集键值）。
   *
   * ⚠️ 这些条件必须在**可见状态里已知且相符**；未知 ⇒ `unknown`（不是"不适用"）。
   */
  readonly conditions: Readonly<Record<string, string>>
  /**
   * **前置条件**（只有 `write_requires_condition` 才有；其它种类的规则**不得**携带）。
   *
   * ⚠️ 解释器在**步骤 D** 接入；本字段在步骤 A 只做**形状与校验**。
   */
  readonly requires?: WriteConditionRequirement
  /**
   * **来源作用域**（F2 最小接点 R1）：
   * 只约束"**从该来源派生**的写"（来源由受信读回执**追溯**得出，不是模型声明）；缺省 = 约束该族所有写（与现状等价）。
   */
  readonly sourceScope?: WriteSourceScope
  /** 绑定的来源 */
  readonly binding: TransitionRuleBinding
}

/** 规则 id 的**内容寻址**（同一条规则 ⇒ 同一个 id；内容变了 ⇒ id 变了）。 */
export function transitionRuleId (rule: Omit<RestrictedTransitionRule, 'id'>): string {
  const material = JSON.stringify([
    rule.kind,
    rule.action.capability,
    rule.action.operation,
    Object.entries(rule.conditions).sort(([a], [b]) => (a < b ? -1 : 1)),
    // ⚠️ **前置条件进内容寻址**：条件动过 ⇒ id 必须变（否则"比的是哪一版"答不出来）。
    rule.requires === undefined ? null : [rule.requires.conditionPath, rule.requires.mustNotEqual],
    // ⚠️ **来源作用域进内容寻址**：只差来源的两条规则必须是**不同的 id**。
    ...(rule.sourceScope === undefined ? [] : [['sourceScope', rule.sourceScope]]),
    rule.binding.claimId,
    rule.binding.ruleVersion,
    rule.binding.evidenceFingerprint,
  ])
  return `wmt:${hashOf(material)}`
}

/** 一个**小**的确定性哈希（FNV-1a 64，十六进制；与仓库既有 `fnv1a64Hex` 同族）。 */
function hashOf (material: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < material.length; index += 1) {
    hash ^= BigInt(material.charCodeAt(index))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

// ---------------------------------------------------------------------------
// 预期结果（**闭集谓词**，程序判定）
// ---------------------------------------------------------------------------

/** 预期谓词（闭集）。 */
export const TRANSITION_PREDICATES = ['same_content_fingerprint'] as const
export type TransitionPredicate = (typeof TRANSITION_PREDICATES)[number]

/** 一个**可检查**的预期（不是一句自然语言）。 */
export interface TransitionExpectation {
  /** 谓词（闭集） */
  readonly predicate: TransitionPredicate
  /** 预期成立的路径 */
  readonly path: string
  /** 预期相等的内容指纹 */
  readonly expectedFingerprint: string
}

/** 结论三态（**不合并**）。 */
export const TRANSITION_OUTCOME_KINDS = ['expected', 'unknown', 'conflict'] as const
export type TransitionOutcomeKind = (typeof TRANSITION_OUTCOME_KINDS)[number]

/** 未知/冲突的**具名**原因（闭集；机器判定，不是自由文本）。 */
export const TRANSITION_OUTCOME_REASONS = [
  'condition_unknown',        // 规则要的条件**我们不知道**
  'condition_mismatch',       // 条件已知但对不上
  'action_not_applicable',    // 这条规则不适用于这个动作
  'subject_mismatch',         // 动作的主体与规则不符
  'prior_effect_unknown',     // 缺少"上一次写入"的效果事实
  'readback_mismatch',        // 读回的内容与预期**不一致**
  'readback_unknown',         // 读回的结果**不可判**（超时 / 传输失败 / 未完成）
  'conflict',                 // 同一状态下出现**互相矛盾**的观察
] as const
export type TransitionOutcomeReason = (typeof TRANSITION_OUTCOME_REASONS)[number]

export interface TransitionOutcome {
  readonly kind: TransitionOutcomeKind
  /** 预期（`kind === 'expected'` 时有） */
  readonly expectation?: TransitionExpectation
  /** 具名原因（`kind !== 'expected'` 时有） */
  readonly reason?: TransitionOutcomeReason
  /** 人读说明（**不参与判定**） */
  readonly detail?: string
}

// ---------------------------------------------------------------------------
// 受信解释器
// ---------------------------------------------------------------------------

/** 待解释的动作 */
export interface TransitionAction {
  readonly capability: string
  readonly operation: string
  /** 参数（**只读**闭集键；解释器自己认得哪几个键） */
  readonly arguments: Readonly<Record<string, unknown>>
  /** 执行主体（引用） */
  readonly subjectId: string
}

/**
 * **受信解释器**：按规则的 `kind` 求值。
 *
 * ⚠️ 它**只**做三件事：认规则的种类、按闭集谓词求值、认不得就说 `unknown`。
 *    它**不**执行规则里的任何东西（规则里也没有可执行的东西）。
 *
 * ⚠️ **"读回不符"与"读回不可判"是两件事**：
 *    前者说明规则被**反驳**（内容真的不一样），后者只说明**这一次没读成**
 *    （超时 / 传输失败）⇒ **不能**把"没读成"算成"规则被反驳"。
 */
export function interpretTransition (input: {
  readonly rule: RestrictedTransitionRule
  readonly observed: ObservedTransitionState
  readonly action: TransitionAction
  /** 这次动作的**结果**（读回时才有；写时没有） */
  readonly result?: {
    readonly status: string
    readonly effects: Readonly<Record<string, string>>
  }
}): TransitionOutcome {
  const { rule, observed, action, result } = input

  if (action.capability !== rule.action.capability || action.operation !== rule.action.operation) {
    return {
      kind: 'unknown',
      reason: 'action_not_applicable',
      detail: `规则适用于 ${rule.action.capability}.${rule.action.operation}，本次是 ${action.capability}.${action.operation}`,
    }
  }

  // 条件：**未知** 与 **不匹配** 分开
  for (const [key, value] of Object.entries(rule.conditions)) {
    const actual = observed.facts[key]
    if (actual === undefined) {
      return { kind: 'unknown', reason: 'condition_unknown', detail: `条件 ${key} **未知**（不是"不适用"）` }
    }
    if (actual !== value) {
      return { kind: 'unknown', reason: 'condition_mismatch', detail: `条件 ${key}=${actual} ≠ ${value}` }
    }
  }

  if (rule.kind !== 'write_then_read_same_bytes') {
    // ⚠️ **前置条件规则**（ADR-151 步骤 D）**不走**解释器的"预期/冲突"三态：
    //    它的判定是**否决**（见 `decideWritePreconditionVeto` 的真值表）。
    return {
      kind: 'unknown',
      reason: 'action_not_applicable',
      detail: rule.kind === 'write_requires_condition'
        ? `前置条件规则由**否决真值表**判定（不在解释器里）`
        : `没有这种规则的解释器：${rule.kind}`,
    }
  }

  // 目标路径：来自动作参数；**认不得**就未知（不许从别处猜）
  const rawPath = action.arguments.path
  const path = typeof rawPath === 'string' ? rawPath : undefined
  if (path === undefined) {
    return { kind: 'unknown', reason: 'prior_effect_unknown', detail: '动作没有可认的 path' }
  }

  // 上一次**同路径**的写入效果
  const priorWrite = [...observed.actions]
    .reverse()
    .find(fact => fact.capability === 'sandbox.file.write' && fact.operation === 'write' && fact.status === 'success' && fact.effects.path === path)
  const expectedFingerprint = priorWrite?.effects.contentFingerprint
  if (expectedFingerprint === undefined) {
    return {
      kind: 'unknown',
      reason: 'prior_effect_unknown',
      detail: `路径 ${path} 上没有已知的写入内容指纹（**不猜**）`,
    }
  }

  const expectation: TransitionExpectation = {
    predicate: 'same_content_fingerprint',
    path,
    expectedFingerprint,
  }

  // 本次读回的结果：**不符** 与 **不可判** 分开
  if (result === undefined) return { kind: 'expected', expectation }
  if (result.status !== 'success') {
    return {
      kind: 'unknown',
      reason: 'readback_unknown',
      detail: `这次读回没有成功（status=${result.status}）—— **不可判**，不是"被反驳"`,
    }
  }
  const actualFingerprint = result.effects.contentFingerprint
  if (actualFingerprint === undefined) {
    return { kind: 'unknown', reason: 'readback_unknown', detail: '读回没有内容指纹（不可判）' }
  }
  if (actualFingerprint !== expectedFingerprint) {
    return {
      kind: 'conflict',
      reason: 'readback_mismatch',
      detail: `读回指纹 ${actualFingerprint.slice(0, 12)} ≠ 预期 ${expectedFingerprint.slice(0, 12)}`,
    }
  }
  return { kind: 'expected', expectation }
}

// ---------------------------------------------------------------------------
// 回放
// ---------------------------------------------------------------------------

/** 保留的一条观察（读回的结果）。 */
export interface RetainedObservation {
  /** 路径 */
  readonly path: string
  /** 读回的内容指纹 */
  readonly contentFingerprint: string
}

/** 回放报告（**覆盖数**在里面 ⇒ "回放不全"看得见）。 */
export interface TransitionReplayReport {
  /** 被回放的观察条数 */
  readonly coveredCount: number
  /** 与模型一致（复现）的条数 */
  readonly reproducedCount: number
  /** 与模型**不一致**的条数 */
  readonly mismatchedCount: number
  /** **不可判**的条数（不算反驳） */
  readonly unknownCount: number
  /** 样本超限被截断没有（截了 ⇒ "还有没看的"） */
  readonly truncated: boolean
  /** 结论（闭集三态） */
  readonly outcome: 'pass' | 'refuted' | 'insufficient_information'
}

/**
 * 回放：用**保留的观察**检验模型是否忠实。
 *
 * ⚠️ 三态与 `ReplayReport` 同形：`pass` / `refuted` / `insufficient_information`。
 *    ⚠️ "不可判"**不算**反驳 —— 否则一次超时就会把一条好规则判死。
 */
export function replayTransition (input: {
  readonly rule: RestrictedTransitionRule
  readonly observed: ObservedTransitionState
  readonly retained: readonly RetainedObservation[]
  /** 样本上限（超了 ⇒ 截断） */
  readonly limit?: number
}): TransitionReplayReport {
  const limit = input.limit ?? 200
  const retained = input.retained
  const truncated = retained.length > limit
  const sample = truncated ? retained.slice(0, limit) : retained
  let reproduced = 0
  let mismatched = 0
  let unknown = 0
  for (const observation of sample) {
    const outcome = interpretTransition({
      rule: input.rule,
      observed: input.observed,
      action: {
        capability: input.rule.action.capability,
        operation: input.rule.action.operation,
        arguments: { path: observation.path },
        subjectId: '',
      },
      result: { status: 'success', effects: { contentFingerprint: observation.contentFingerprint } },
    })
    if (outcome.kind === 'expected') reproduced += 1
    else if (outcome.kind === 'conflict') mismatched += 1
    else unknown += 1
  }
  const outcome: TransitionReplayReport['outcome'] =
    mismatched > 0 ? 'refuted' : (reproduced > 0 ? 'pass' : 'insufficient_information')
  return {
    coveredCount: sample.length,
    reproducedCount: reproduced,
    mismatchedCount: mismatched,
    unknownCount: unknown,
    truncated,
    outcome,
  }
}

/** 构造一条规则（失败关闭：形状不合法就抛） */
export function validateRestrictedTransitionRule (value: unknown): RestrictedTransitionRule {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError('validation_error', 'transition_rule_not_object', '受限规则必须是一个对象')
  }
  const raw = value as Record<string, unknown>
  const kind = raw.kind
  if (typeof kind !== 'string' || !(TRANSITION_RULE_KINDS as readonly string[]).includes(kind)) {
    throw new KernelError('validation_error', 'transition_rule_bad_kind', '规则种类不在闭集里')
  }
  const action = raw.action as { capability?: unknown; operation?: unknown } | undefined
  if (typeof action?.capability !== 'string' || typeof action?.operation !== 'string') {
    throw new KernelError('validation_error', 'transition_rule_bad_action', '规则缺少适用的动作')
  }
  const binding = raw.binding as { claimId?: unknown; ruleVersion?: unknown; evidenceFingerprint?: unknown } | undefined
  if (
    typeof binding?.claimId !== 'string' || binding.claimId === '' ||
    typeof binding.ruleVersion !== 'string' || binding.ruleVersion === '' ||
    typeof binding.evidenceFingerprint !== 'string' || binding.evidenceFingerprint === ''
  ) {
    throw new KernelError('validation_error', 'transition_rule_bad_binding', '规则必须绑定来源（命题 id / 规则版本 / 证据指纹）')
  }
  const version = raw.version
  if (typeof version !== 'string' || version === '') {
    throw new KernelError('validation_error', 'transition_rule_bad_version', '规则缺少版本')
  }
  const conditions = raw.conditions
  if (conditions === null || typeof conditions !== 'object' || Array.isArray(conditions)) {
    throw new KernelError('validation_error', 'transition_rule_bad_conditions', '规则条件必须是键值对象')
  }
  // ⚠️ **来源作用域的形状**（F2 最小接点 R1）：闭集、失败关闭；缺省 = 不限来源。
  const sourceScopeRaw = raw.sourceScope
  let sourceScope: WriteSourceScope | undefined
  if (sourceScopeRaw !== undefined) {
    if (typeof sourceScopeRaw !== 'string' || !(WRITE_SOURCE_SCOPES as readonly string[]).includes(sourceScopeRaw)) {
      throw new KernelError('validation_error', 'transition_rule_bad_source_scope', '来源作用域不在闭集里')
    }
    sourceScope = sourceScopeRaw as WriteSourceScope
  }
  // ⚠️ **前置条件的形状**（ADR-151 步骤 A）：枚举、失败关闭、**不做表达式**。
  const requires = validateWriteRequirement(kind as TransitionRuleKind, raw.requires)
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : transitionRuleId({
      kind: kind as TransitionRuleKind,
      action: { capability: action.capability, operation: action.operation },
      conditions: conditions as Record<string, string>,
      ...(requires === undefined ? {} : { requires }),
      ...(sourceScope === undefined ? {} : { sourceScope }),
      binding: {
        claimId: binding.claimId,
        ruleVersion: binding.ruleVersion,
        evidenceFingerprint: binding.evidenceFingerprint,
      },
      version,
    }),
    version,
    kind: kind as TransitionRuleKind,
    action: { capability: action.capability, operation: action.operation },
    conditions: conditions as Record<string, string>,
    ...(requires === undefined ? {} : { requires }),
    ...(sourceScope === undefined ? {} : { sourceScope }),
    binding: {
      claimId: binding.claimId,
      ruleVersion: binding.ruleVersion,
      evidenceFingerprint: binding.evidenceFingerprint,
    },
  }
}

/**
 * **前置条件的形状校验**（失败关闭）。
 *
 * 规则：新种类**必须**带 `requires`；旧种类**不得**带；`requires` **只**允许两个字符串字段；
 * 任何额外字段 / 任何非字符串 / 任何"表达式形态"一律拒。
 */
export function validateWriteRequirement (kind: TransitionRuleKind, value: unknown): WriteConditionRequirement | undefined {
  if (kind !== 'write_requires_condition') {
    if (value !== undefined) {
      throw new KernelError('validation_error', 'transition_rule_unexpected_requires',
        `只有 write_requires_condition 才允许带前置条件（收到 ${kind}）`)
    }
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError('validation_error', 'transition_rule_missing_requires', 'write_requires_condition 必须带前置条件')
  }
  const raw = value as Record<string, unknown>
  const extra = Object.keys(raw).filter(key => !(WRITE_REQUIREMENT_KEYS as readonly string[]).includes(key))
  if (extra.length > 0) {
    // ⚠️ "表达式"会从这个口子溜进来 ⇒ 这里**硬拒**。
    throw new KernelError('validation_error', 'transition_rule_requires_extra_keys',
      `前置条件只允许 ${WRITE_REQUIREMENT_KEYS.join('/')}（收到额外字段：${extra.join(',')}）`)
  }
  if (typeof raw.conditionPath !== 'string' || raw.conditionPath === '') {
    throw new KernelError('validation_error', 'transition_rule_requires_bad_path', '前置条件缺少 conditionPath')
  }
  if (typeof raw.mustNotEqual !== 'string' || raw.mustNotEqual === '') {
    throw new KernelError('validation_error', 'transition_rule_requires_bad_value', '前置条件缺少 mustNotEqual')
  }
  return { conditionPath: raw.conditionPath, mustNotEqual: raw.mustNotEqual }
}
