/**
 * 世界模型三处应用的**共用最小契约**（三域应用方案 §5）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 三处（工具与任务执行 / 反思与行为调整 / —— 故事那一处已于 2026-10-20 取消）
 * 复用**数据形状**，但**不混用领域事实或证据资格**。
 *
 * ```text
 * 规则候选   所属领域/任务 · 版本 · 来源身份及 revision · 适用条件 · 受限规则 · 自然语言解释
 * 回放报告   输入来源版本 · 覆盖数量 · 失败样本 · 是否被截断 · 通过/反驳/信息不足
 * 行动预测   产生时间与输入 revision · 候选动作 · 预期可见结果 · 核对条件 · 不确定性
 * 实际结果   原有权威结果引用 · 真实结果时间与 revision（**不复制私有正文**）
 * 比较结果   可比较/不可比较 · 符合/不符/未知 · 被反驳的规则版本 · 实际来源引用
 * ```
 *
 * ============================================================================
 *  四条不许破的边界
 * ============================================================================
 * ① **只解释受限数据规则**：规则正文是**受限陈述**，**永不**是可执行代码。
 *    `assertRestrictedRuleStatement()` 是这条边界的**唯一**强制点。
 * ② **不执行模型输出**：本文件不 import 任何执行器；shell / SQL / JS / 函数调用
 *    在**形状**层就被拒（连字符串里带 `SELECT` 都不行）。
 * ③ **冲突不覆盖**：同样的可见状态与动作出现不同结果时，
 *    比较结论是 `unknown`，**不是**"用后一次覆盖前一次"。
 * ④ **不复制私有正文**：实际结果只留**引用**（权威结果 id + 时间 + revision）。
 *
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 */

import { KernelError } from './ids.ts'
import type { ActionStatus } from '../action/action-result.ts'

/** 契约自身的版本（读数要能回答"这份数据是按哪一版形状写的"）。 */
export const WORLD_MODEL_CONTRACT_VERSION = 'world-model-contract@1'

/**
 * 领域闭集。
 *
 * ⚠️ `story` **不在**这里：S8 方向已于 2026-10-20 取消（ADR-147）。
 *    加它回来 = 让一个已退役的方向看起来还有落点。
 */
export const WORLD_MODEL_DOMAINS = ['tool_task', 'reflection'] as const
export type WorldModelDomain = (typeof WORLD_MODEL_DOMAINS)[number]

/** 不确定性闭集（**自报**，不是校准过的概率 —— §5 明确禁止拿它当概率）。 */
export const WORLD_MODEL_UNCERTAINTIES = ['low', 'medium', 'high', 'unknown'] as const
export type WorldModelUncertainty = (typeof WORLD_MODEL_UNCERTAINTIES)[number]

// ---------------------------------------------------------------------------
// 规则候选
// ---------------------------------------------------------------------------

/** 规则正文的**码点上界**。 */
export const RULE_STATEMENT_MAX_CODEPOINTS = 400

/**
 * **受限规则正文**的形状。
 *
 * ⚠️ 它是**陈述**，不是程序：用来描述"某操作的前置条件 / 可恢复失败 / 合适的恢复顺序"，
 *    绝不能是"照这个执行"。
 */
export interface RuleCandidate {
  /** 所属领域（闭集） */
  readonly domain: WorldModelDomain
  /** 所属任务（程序给的稳定标识；不是自由文本） */
  readonly taskScope: string
  /** 规则版本（改一次规则就换一个版本；比较结论引用它） */
  readonly version: string
  /** 来源身份（**引用**，不是正文） */
  readonly sourceIdentity: string
  /** 来源的 revision（真实值，不是占位） */
  readonly sourceRevision: number
  /** 适用条件（自然语言，闭集语义） */
  readonly applicability: string
  /** **受限规则**（自然语言陈述；见 `assertRestrictedRuleStatement`） */
  readonly rule: string
  /** 自然语言解释（给程序/人读；**不**是执行输入） */
  readonly explanation: string
}

/**
 * 看起来像**可执行代码**的片段（闭集）。
 *
 * ⚠️ 这不是"风格检查"：规则本会被用来**解释机制**，一旦它里面能藏一段
 *    shell / SQL / JS，"解释"与"执行"之间的边界就没了。
 *    命中任何一条 ⇒ 整条规则候选**拒收**。
 */
const EXECUTABLE_MARKERS: readonly string[] = [
  '```',            // 代码围栏
  '`',              // 行内代码
  'function ',
  'function(',
  'lambda ',
  'print(',
  'assert ',
  '=>',
  '=> ',
  'import ',
  'require(',
  'process.env',
  'eval(',
  'exec(',
  'spawn(',
  'child_process',
  '$(',              // shell 替换
  '&&',
  '||',
  '|',               // 管道（`| ` 之外的裸竖线也拒，避免误伤闭集分隔）
  ';',
  'rm -',
  'del /',
  'drop table',
  'drop database',
  'insert into',
  'update ',
  'delete from',
  'select ',
  'union select',
  'os.system',
  'subprocess',
  'powershell',
  'cmd /c',
  'curl ',
  'wget ',
  'chmod ',
  'sudo ',
]

/**
 * 断言一段规则正文是**受限陈述**（失败关闭）。
 *
 * ⚠️ 命中可执行片段 ⇒ 抛 `KernelError`（`validation_error` /
 *    `rule_statement_not_restricted`）—— 调用方据此**拒收整条规则候选**，
 *    而不是"洗一遍继续用"。
 */
export function assertRestrictedRuleStatement(text: string): void {
  const normalized = text.toLowerCase()
  for (const marker of EXECUTABLE_MARKERS) {
    if (normalized.includes(marker)) {
      throw new KernelError(
        'validation_error',
        'rule_statement_not_restricted',
        `规则正文里出现可执行片段：${marker}`
      )
    }
  }
}

/** 规则候选的**字段闭集**（未知字段 ⇒ 拒收）。 */
export const RULE_CANDIDATE_FIELDS: readonly string[] = [
  'domain',
  'taskScope',
  'version',
  'sourceIdentity',
  'sourceRevision',
  'applicability',
  'rule',
  'explanation',
]

/**
 * 校验一个规则候选的形状（**纯函数**，失败关闭）。
 *
 * ⚠️ 它**不**校验"规则是不是对的"——那只能靠回放（见 `ReplayReport`）。
 *    这里只挡"形状不合法"与"正文里藏着可执行代码"。
 */
export function validateRuleCandidate(value: unknown): RuleCandidate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError('validation_error', 'rule_candidate_not_object', '规则候选必须是一个对象')
  }
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!RULE_CANDIDATE_FIELDS.includes(key)) {
      throw new KernelError('validation_error', 'rule_candidate_unknown_field', `规则候选里有未知字段：${key}`)
    }
  }
  const domain = raw.domain
  if (typeof domain !== 'string' || !(WORLD_MODEL_DOMAINS as readonly string[]).includes(domain)) {
    throw new KernelError('validation_error', 'rule_candidate_bad_domain', '规则候选的领域不在闭集里')
  }
  const strings: Record<string, string> = {}
  for (const key of ['taskScope', 'version', 'sourceIdentity', 'applicability', 'rule', 'explanation']) {
    const text = raw[key]
    if (typeof text !== 'string' || text.trim() === '') {
      throw new KernelError('validation_error', 'rule_candidate_bad_field', `规则候选的 ${key} 必须是非空字符串`)
    }
    strings[key] = text
  }
  const sourceRevision = raw.sourceRevision
  if (typeof sourceRevision !== 'number' || !Number.isInteger(sourceRevision) || sourceRevision < 0) {
    throw new KernelError('validation_error', 'rule_candidate_bad_field', '规则候选的 sourceRevision 必须是非负整数')
  }
  if ([...strings.rule].length > RULE_STATEMENT_MAX_CODEPOINTS) {
    throw new KernelError('validation_error', 'rule_candidate_rule_too_long', '规则正文超过码点上界')
  }
  assertRestrictedRuleStatement(strings.rule)
  return {
    domain: domain as WorldModelDomain,
    taskScope: strings.taskScope,
    version: strings.version,
    sourceIdentity: strings.sourceIdentity,
    sourceRevision,
    applicability: strings.applicability,
    rule: strings.rule,
    explanation: strings.explanation,
  }
}

// ---------------------------------------------------------------------------
// 回放报告
// ---------------------------------------------------------------------------

/** 回放结论闭集：**通过 / 被反驳 / 信息不足**（三态，不合并）。 */
export const REPLAY_OUTCOMES = ['pass', 'refuted', 'insufficient_information'] as const
export type ReplayOutcome = (typeof REPLAY_OUTCOMES)[number]

export interface ReplayReport {
  /** 被回放的**输入来源版本**（引用） */
  readonly inputSourceVersion: string
  /** 覆盖了多少条保留样本 */
  readonly coveredCount: number
  /** 其中失败（被反驳）的样本数 */
  readonly failedSamples: number
  /** 样本超限被截断没有（截了 ⇒ "还有没看的"，不是"看全了"） */
  readonly truncated: boolean
  /** 结论（闭集三态） */
  readonly outcome: ReplayOutcome
}

export function validateReplayReport(value: unknown): ReplayReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError('validation_error', 'replay_report_not_object', '回放报告必须是一个对象')
  }
  const raw = value as Record<string, unknown>
  const inputSourceVersion = raw.inputSourceVersion
  if (typeof inputSourceVersion !== 'string' || inputSourceVersion.trim() === '') {
    throw new KernelError('validation_error', 'replay_report_bad_field', '回放报告缺少输入来源版本')
  }
  const coveredCount = raw.coveredCount
  const failedSamples = raw.failedSamples
  if (
    typeof coveredCount !== 'number' || !Number.isInteger(coveredCount) || coveredCount < 0 ||
    typeof failedSamples !== 'number' || !Number.isInteger(failedSamples) || failedSamples < 0 ||
    failedSamples > coveredCount
  ) {
    throw new KernelError('validation_error', 'replay_report_bad_field', '回放报告的样本计数不合法')
  }
  const truncated = raw.truncated
  if (typeof truncated !== 'boolean') {
    throw new KernelError('validation_error', 'replay_report_bad_field', '回放报告的 truncated 必须是布尔')
  }
  const outcome = raw.outcome
  if (typeof outcome !== 'string' || !(REPLAY_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new KernelError('validation_error', 'replay_report_bad_outcome', '回放结论不在闭集里')
  }
  return {
    inputSourceVersion,
    coveredCount,
    failedSamples,
    truncated,
    outcome: outcome as ReplayOutcome,
  }
}

// ---------------------------------------------------------------------------
// 行动预测
// ---------------------------------------------------------------------------

/**
 * **核对条件**的闭集。
 *
 * ⚠️ 为什么必须是**闭集**而不是一句自然语言：核对条件要由**程序**判定
 *    "这一步真的达成预期没有"。一句自然语言只能由模型自己解释 ——
 *    那等于让被考核者给自己打分。
 *    ⇒ 条件是**可由 `ActionResult` 机械判定**的谓词。
 */
export const ACTION_FORECAST_CHECK_KINDS = [
  'status_is',                    // 状态等于某个闭集状态
  'no_error',                     // 没有失败码
  'effect_recorded',              // 适配器自报了效果
  'turn_content_count_at_least',  // 当轮内容份数 ≥ N（读回）
  'external_evidence_count_at_least', // 外部证据条数 ≥ N
  /*
   * ⚠️ 2026-10-21 新增（认知能力建设计划 P2 第 3 步）：效果指纹与预期相等。
   *
   *    为什么需要它：世界模型的**受限转移**给出的预期是"读回来的字节与写进去的一样"，
   *    而上面的闭集里**没有**能表达这一条的谓词（`effect_recorded` 只说"有效果"）。
   *    ⇒ 不加它，世界模型的预期就**进不了**任务环的核对链（只会被记成一个计数）。
   *
   *    它是**闭集谓词**（程序判定），不是一句自然语言。
   */
  'effect_fingerprint_matches',
] as const
export type ActionForecastCheckKind = (typeof ACTION_FORECAST_CHECK_KINDS)[number]

export type ActionForecastCheck =
  | { readonly kind: 'status_is'; readonly status: ActionStatus }
  | { readonly kind: 'no_error' }
  | { readonly kind: 'effect_recorded' }
  | { readonly kind: 'turn_content_count_at_least'; readonly count: number }
  | { readonly kind: 'external_evidence_count_at_least'; readonly count: number }
  /** 效果的**内容指纹**与预期相等（世界模型的"写进去＝读回来"） */
  | { readonly kind: 'effect_fingerprint_matches'; readonly expectedFingerprint: string }

/** 核对条件里允许出现的**状态**闭集（与 `ACTION_STATUSES` 同形，避免跨层 import 环）。 */
export const ACTION_FORECAST_STATUSES: readonly ActionStatus[] = [
  'success',
  'rejected',
  'failed',
  'partial',
  'not_found',
  'ambiguous',
  'timeout',
  'cancelled',
]

export interface ActionForecastStep {
  /** 候选动作：能力 + 操作（**不含参数** —— 预测不授权任何东西） */
  readonly capability: string
  readonly operation: string
  /** 预期**可见**结果（自然语言；给人与模型读，**不是**判据） */
  readonly expectedVisibleOutcome: string
  /** 核对条件（**闭集谓词**；程序据此判定） */
  readonly check: ActionForecastCheck
  /** 不确定性（自报；**不是**校准过的概率） */
  readonly uncertainty: WorldModelUncertainty
  /**
   * 依赖的**步骤下标**（**计划内**；`0` 是计划的第一步）。
   *
   * ⚠️ 解析时由模型**自己那份列表**的下标重映射而来（见 `action-forecast.ts` 的
   *    `parseActionForecast`）⇒ 这里永远是**计划**里的下标，调用方不必再翻译。
   * ⚠️ 依赖关系是**预测侧**声明的，程序只校验"下标合法且指向更早的步骤"。
   *    当依赖的那一步**核对未通过**时，依赖它的步骤**不执行**（重新规划）——
   *    这就是"核对失败时停止沿用依赖该结果的后续步骤"。
   */
  readonly dependsOn: readonly number[]
  /**
   * **规范化参数与目标绑定摘要**（2026-10-21 新增 · 计划 P2 第 3 步）。
   *
   * ⚠️ 为什么需要它：「同能力不同对象」必须**错得开**。
   *    只比"能力.操作"的话，两个不同的参数会被当成同一件事。
   *    ⇒ 摘要把"这次预测绑定的是哪一组参数"记下来，比较结论据此归因。
   */
  readonly parameterBindingDigest?: string
  /**
   * **规则依赖**（命题 id 列表；2026-10-21 新增）。
   *
   * ⚠️ 这是"被反驳时**是哪条规则**"的归属材料（计划 §4 的接线契约要求它）。
   */
  readonly ruleDependencies?: readonly {
    readonly claimId: string
    readonly ruleVersion: string
    readonly evidenceFingerprint: string
  }[]
  /**
   * **规则版本**（被反驳时要指名的那个；2026-10-21 新增）。
   *
   * ⚠️ 没有它，比较结论只能说"某条规则被反驳了"，说不出"**哪一版**"。
   */
  readonly ruleVersion?: string
}

export interface ActionForecast {
  /** 产生时间（毫秒；程序给的，不是模型自报的时间） */
  readonly producedAt: number
  /** 输入的 revision（**引用**；比较结论要能回答"比的是哪一版输入"） */
  readonly inputRevision: string
  /**
   * **模型版本**（2026-10-21 新增）。
   *
   * ⚠️ 计划 §4 的接线契约要求它：「比的是哪一版**模型**」。
   *    没有它，一次"被反驳"归不到模型头上 ⇒ 收益与责任都算不清。
   */
  readonly modelVersion?: string
  /** 本次预测消耗的**预算单位**（2026-10-21 新增；计划 §4 的接线契约要求它） */
  readonly budgetCost?: number
  readonly steps: readonly ActionForecastStep[]
  /** Explicit positions when malformed or missing entries have been omitted. */
  readonly planStepIndices?: readonly number[]
}

export const ACTION_FORECAST_STEP_FIELDS: readonly string[] = [
  'capability',
  'operation',
  'expectedVisibleOutcome',
  'check',
  'uncertainty',
  'dependsOn',
  // 2026-10-21 新增（计划 P2 第 3 步）：绑定材料
  'parameterBindingDigest',
  'ruleDependencies',
  'ruleVersion',
]

export const ACTION_FORECAST_CHECK_FIELDS: readonly string[] = ['kind', 'status', 'count', 'expectedFingerprint']

/** 预测里"预期可见结果"与"解释"的码点上界。 */
export const FORECAST_TEXT_MAX_CODEPOINTS = 300

export function validateActionForecastCheck(value: unknown): ActionForecastCheck {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError('validation_error', 'action_forecast_step_check_not_object', '核对条件必须是一个对象')
  }
  const raw = value as Record<string, unknown>
  const kind = raw.kind
  const allowed = kind === 'status_is' ? ['kind', 'status']
    : kind === 'turn_content_count_at_least' || kind === 'external_evidence_count_at_least'
      ? ['kind', 'count']
      : kind === 'effect_fingerprint_matches'
        ? ['kind', 'expectedFingerprint'] : ['kind']
  if (Object.keys(raw).some(key => !allowed.includes(key))) {
    throw new KernelError('validation_error', 'action_forecast_step_unknown_field', '核对条件含未知字段')
  }
  if (typeof kind !== 'string' || !(ACTION_FORECAST_CHECK_KINDS as readonly string[]).includes(kind)) {
    throw new KernelError('validation_error', 'action_forecast_step_check_bad_kind', '核对条件的 kind 不在闭集里')
  }
  if (kind === 'status_is') {
    const status = raw.status
    if (typeof status !== 'string' || !ACTION_FORECAST_STATUSES.includes(status as ActionStatus)) {
      throw new KernelError('validation_error', 'action_forecast_step_check_bad_status', '核对条件的状态不在闭集里')
    }
    return { kind: 'status_is', status: status as ActionStatus }
  }
  if (kind === 'no_error' || kind === 'effect_recorded') {
    return { kind }
  }
  if (kind === 'effect_fingerprint_matches') {
    const expectedFingerprint = raw.expectedFingerprint
    if (typeof expectedFingerprint !== 'string' || expectedFingerprint.trim() === '') {
      throw new KernelError('validation_error', 'action_forecast_step_check_bad_fingerprint', '核对条件的 expectedFingerprint 必须是非空字符串')
    }
    return { kind, expectedFingerprint }
  }
  const count = raw.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 1000) {
    throw new KernelError('validation_error', 'action_forecast_step_check_bad_count', '核对条件的 count 必须是 0..1000 的整数')
  }
  if (kind === 'turn_content_count_at_least') {
    return { kind, count }
  }
  return { kind: 'external_evidence_count_at_least', count }
}

export function validateActionForecastStep(
  value: unknown,
  options: { planStepCount: number; stepIndex: number }
): ActionForecastStep {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError('validation_error', 'action_forecast_step_not_object', '预测步骤必须是一个对象')
  }
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!ACTION_FORECAST_STEP_FIELDS.includes(key)) {
      throw new KernelError('validation_error', 'action_forecast_step_unknown_field', `预测步骤里有未知字段：${key}`)
    }
  }
  const capability = raw.capability
  const operation = raw.operation
  if (typeof capability !== 'string' || capability.trim() === '') {
    throw new KernelError('validation_error', 'action_forecast_step_bad_capability', '预测步骤缺少 capability')
  }
  if (typeof operation !== 'string' || operation.trim() === '') {
    throw new KernelError('validation_error', 'action_forecast_step_bad_operation', '预测步骤缺少 operation')
  }
  const expectedVisibleOutcome = raw.expectedVisibleOutcome
  if (
    typeof expectedVisibleOutcome !== 'string' ||
    expectedVisibleOutcome.trim() === '' ||
    [...expectedVisibleOutcome].length > FORECAST_TEXT_MAX_CODEPOINTS
  ) {
    throw new KernelError('validation_error', 'action_forecast_step_bad_outcome', '预期可见结果不合法或超长')
  }
  const uncertainty = raw.uncertainty
  if (typeof uncertainty !== 'string' || !(WORLD_MODEL_UNCERTAINTIES as readonly string[]).includes(uncertainty)) {
    throw new KernelError('validation_error', 'action_forecast_step_bad_uncertainty', '不确定性不在闭集里')
  }
  const dependsOnRaw = raw.dependsOn
  if (!Array.isArray(dependsOnRaw)) {
    throw new KernelError('validation_error', 'action_forecast_step_bad_depends_on', 'dependsOn 必须是数组')
  }
  const dependsOn: number[] = []
  for (const item of dependsOnRaw) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item >= options.planStepCount) {
      throw new KernelError('validation_error', 'action_forecast_step_bad_depends_on', 'dependsOn 指向非法步骤')
    }
    /*
     * ⚠️ **只能依赖更早的步骤**：依赖自己或后面的步骤没有意义
     *    （那时那些步骤的结果还不存在），而且会让"核对通过"变成循环。
     */
    if (item >= options.stepIndex) {
      throw new KernelError('validation_error', 'action_forecast_step_bad_depends_on', 'dependsOn 只能指向更早的步骤')
    }
    if (!dependsOn.includes(item)) dependsOn.push(item)
  }
  /*
   * ⚠️ 绑定材料（2026-10-21 新增）：**可选**，但给了就要**合法**
   *    （空串 / 非字符串数组 ⇒ 拒收）。
   */
  const parameterBindingDigest = raw.parameterBindingDigest
  if (parameterBindingDigest !== undefined && (typeof parameterBindingDigest !== 'string' || parameterBindingDigest.trim() === '')) {
    throw new KernelError('validation_error', 'action_forecast_step_bad_binding', 'parameterBindingDigest 必须是非空字符串')
  }
  const ruleVersion = raw.ruleVersion
  if (ruleVersion !== undefined && (typeof ruleVersion !== 'string' || ruleVersion.trim() === '')) {
    throw new KernelError('validation_error', 'action_forecast_step_bad_binding', 'ruleVersion 必须是非空字符串')
  }
  const ruleDependenciesRaw = raw.ruleDependencies
  const ruleDependencies: Array<{ claimId: string; ruleVersion: string; evidenceFingerprint: string }> = []
  if (ruleDependenciesRaw !== undefined) {
    if (!Array.isArray(ruleDependenciesRaw)) {
      throw new KernelError('validation_error', 'action_forecast_step_bad_binding', 'ruleDependencies 必须是数组')
    }
    for (const item of ruleDependenciesRaw) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new KernelError('validation_error', 'action_forecast_step_bad_binding', 'ruleDependencies 的每一项必须是对象')
      }
      const rawDependency = item as Record<string, unknown>
      for (const key of ['claimId', 'ruleVersion', 'evidenceFingerprint']) {
        if (typeof rawDependency[key] !== 'string' || String(rawDependency[key]).trim() === '') {
          throw new KernelError('validation_error', 'action_forecast_step_bad_binding', `ruleDependencies 的每一项都必须带非空的 ${key}`)
        }
      }
      const dependency = {
        claimId: String(rawDependency.claimId),
        ruleVersion: String(rawDependency.ruleVersion),
        evidenceFingerprint: String(rawDependency.evidenceFingerprint),
      }
      if (!ruleDependencies.some(existing => existing.claimId === dependency.claimId)) ruleDependencies.push(dependency)
    }
  }
  return {
    capability,
    operation,
    expectedVisibleOutcome,
    check: validateActionForecastCheck(raw.check),
    uncertainty: uncertainty as WorldModelUncertainty,
    dependsOn,
    ...(parameterBindingDigest === undefined ? {} : { parameterBindingDigest }),
    ...(ruleVersion === undefined ? {} : { ruleVersion }),
    ...(ruleDependencies.length === 0 ? {} : { ruleDependencies }),
  }
}

// ---------------------------------------------------------------------------
// 实际结果
// ---------------------------------------------------------------------------

/**
 * 实际结果的**引用**（**不复制私有正文**）。
 *
 * ⚠️ 正文留在它本来该在的地方（`ActionResult` / 账本）；这里只留
 *    "哪一次结果、什么时候、哪个版本"——够用来做比较与追溯，不够用来重建内容。
 */
export interface ActualOutcomeRef {
  /** 原有权威结果的引用（例：`ActionResult.actionId`） */
  readonly authorityRef: string
  /** 真实结果时间（毫秒） */
  readonly resultAt: number
  /** 真实 revision（整数） */
  readonly revision: number
}

export function validateActualOutcomeRef(value: unknown): ActualOutcomeRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError('validation_error', 'actual_outcome_not_object', '实际结果引用必须是一个对象')
  }
  const raw = value as Record<string, unknown>
  const authorityRef = raw.authorityRef
  if (typeof authorityRef !== 'string' || authorityRef.trim() === '') {
    throw new KernelError('validation_error', 'actual_outcome_bad_ref', '实际结果引用缺少 authorityRef')
  }
  const resultAt = raw.resultAt
  const revision = raw.revision
  if (typeof resultAt !== 'number' || !Number.isFinite(resultAt)) {
    throw new KernelError('validation_error', 'actual_outcome_bad_time', '实际结果时间不合法')
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new KernelError('validation_error', 'actual_outcome_bad_revision', '实际结果 revision 不合法')
  }
  return { authorityRef, resultAt, revision }
}

// ---------------------------------------------------------------------------
// 比较结果
// ---------------------------------------------------------------------------

/** 比较结论闭集：**符合 / 不符 / 未知**（三态，不合并）。 */
export const COMPARISON_VERDICTS = ['match', 'mismatch', 'unknown'] as const
export type ComparisonVerdict = (typeof COMPARISON_VERDICTS)[number]

export interface ComparisonResult {
  /** 能不能比（不能比时 `verdict` 必须是 `unknown`） */
  readonly comparable: boolean
  readonly verdict: ComparisonVerdict
  /** 被反驳的规则版本（**引用**；没有则省略） */
  readonly refutedRuleVersion?: string
  /** 实际来源引用（**引用**） */
  readonly actualSourceRef: string
  /** 不能比 / 未知时的具名原因（闭集码） */
  readonly reason?: string
}

export const COMPARISON_REASONS = [
  'no_forecast_for_step',
  'not_comparable',
  'check_not_evaluable',
  'conflict_preserved',
] as const
export type ComparisonReason = (typeof COMPARISON_REASONS)[number]

export function validateComparisonResult(value: unknown): ComparisonResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError('validation_error', 'comparison_result_not_object', '比较结果必须是一个对象')
  }
  const raw = value as Record<string, unknown>
  const comparable = raw.comparable
  if (typeof comparable !== 'boolean') {
    throw new KernelError('validation_error', 'comparison_result_bad_field', '比较结果的 comparable 必须是布尔')
  }
  const verdict = raw.verdict
  if (typeof verdict !== 'string' || !(COMPARISON_VERDICTS as readonly string[]).includes(verdict)) {
    throw new KernelError('validation_error', 'comparison_result_bad_verdict', '比较结论不在闭集里')
  }
  if (!comparable && verdict !== 'unknown') {
    throw new KernelError('validation_error', 'comparison_result_inconsistent', '不可比较时结论只能是 unknown')
  }
  const actualSourceRef = raw.actualSourceRef
  if (typeof actualSourceRef !== 'string' || actualSourceRef.trim() === '') {
    throw new KernelError('validation_error', 'comparison_result_bad_ref', '比较结果缺少实际来源引用')
  }
  const refutedRuleVersion = raw.refutedRuleVersion
  if (refutedRuleVersion !== undefined && (typeof refutedRuleVersion !== 'string' || refutedRuleVersion.trim() === '')) {
    throw new KernelError('validation_error', 'comparison_result_bad_ref', '被反驳的规则版本必须是非空字符串')
  }
  const reason = raw.reason
  if (reason !== undefined && (typeof reason !== 'string' || reason.trim() === '')) {
    throw new KernelError('validation_error', 'comparison_result_bad_reason', '比较原因必须是非空字符串')
  }
  return {
    comparable,
    verdict: verdict as ComparisonVerdict,
    ...(refutedRuleVersion !== undefined ? { refutedRuleVersion } : {}),
    actualSourceRef,
    ...(reason !== undefined ? { reason } : {}),
  }
}
