/**
 * 三域应用方案 §4 —— **反思域的比较材料**（"当时预测什么 / 实际发生什么 / 哪条假设被反驳"）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 对**已经具备反思资格**的实际结果（目标结果 / 承诺结果），附加一段**辅助解释**：
 * ```text
 * 原定意图       目标/承诺成立时的**原始声明**（程序给的既有文本，逐字）
 * 实际发生什么   结局事件的**程序事实**（闭集码）
 * 待复核的判据   失败结局的原成功判据；意图未达成不等于假设被反驳
 * ```
 *
 * ============================================================================
 *  五条不许破的边界
 * ============================================================================
 * ① **它不是证据**：比较材料**不产生** handle、**不产生**独立根、**不触发**反思。
 *    门槛（≥3 根 / ≥2 会话 / 无未解决冲突）**只**看既有来源。
 * ② **它不能自己成立**：被比较的两个面都必须是**程序事实**
 *    （声明来自领域事件，结局来自领域事件），**没有**模型生成的成分。
 * ③ **遗忘遮蔽先于注入**：比较引用的来源里**任何一条**已被遗忘/撤回/越权
 *    ⇒ 整条比较**作废**（不是"洗一遍继续用"）。
 * ④ **成功不是"假设被证实"**：结局是成功时**没有**"被反驳的假设"这一栏
 *    —— 成功只意味着"没有矛盾"，把它写成"证实"就是过度解读。
 * ⑤ **有界**：份数与总码点都有上界（计入既有输入预算，见
 *    `REFLECTION_COMPARISON_LIMITS`）。
 *
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 */

import type { ReflectionTrigger } from '../../contracts/reflection-input.ts'

// ---------------------------------------------------------------------------
// 结局闭集
// ---------------------------------------------------------------------------

/** 结局种类闭集（**只有已获资格的既有来源**进得来）。 */
export const REFLECTION_OUTCOME_KINDS = ['goal', 'commitment'] as const
export type ReflectionOutcomeKind = (typeof REFLECTION_OUTCOME_KINDS)[number]

/** 结局结论闭集。 */
export const REFLECTION_OUTCOME_CODES = [
  'completed',
  'blocked',
  'cancelled',
  'fulfilled',
  'broken',
] as const
export type ReflectionOutcomeCode = (typeof REFLECTION_OUTCOME_CODES)[number]

/** 领域事件类型 → 结局（**不在表里的类型不产生任何比较**）。 */
export const REFLECTION_OUTCOME_BY_EVENT_TYPE: Readonly<Record<string, ReflectionOutcomeCode>> = {
  GOAL_COMPLETED: 'completed',
  GOAL_BLOCKED: 'blocked',
  GOAL_CANCELLED: 'cancelled',
  COMMITMENT_FULFILLED: 'fulfilled',
  COMMITMENT_BROKEN: 'broken',
  COMMITMENT_CANCELLED: 'cancelled',
}

/** 触发种类 → 结局种类（只有这两类触发**可以**带比较材料）。 */
export const REFLECTION_OUTCOME_BY_TRIGGER_KIND: Readonly<Record<string, ReflectionOutcomeKind>> = {
  goal_outcome: 'goal',
  commitment_outcome: 'commitment',
}

/** **失败**的结局（只有它们才谈得上"哪条假设被反驳"）。 */
const FAILED_OUTCOME_CODES: ReadonlySet<ReflectionOutcomeCode> = new Set<ReflectionOutcomeCode>([
  'blocked',
  'cancelled',
  'broken',
])

// ---------------------------------------------------------------------------
// 上界（计入既有输入预算）
// ---------------------------------------------------------------------------

export const REFLECTION_COMPARISON_LIMITS = {
  /** 一次反思最多带几份比较材料 */
  maxItems: 3,
  /** 单份比较材料的**总**码点上界（预测 + 判据 + 实际） */
  maxTextCodepoints: 300,
  /** 全部比较材料的**总**码点上界（⇒ 它确实吃掉了既有输入预算） */
  maxTotalCodepoints: 900,
} as const

// ---------------------------------------------------------------------------
// 数据形状
// ---------------------------------------------------------------------------

/** 一份比较材料（**辅助解释**，不是证据）。 */
export interface ReflectionOutcomeComparison {
  /** 稳定 id（`cmp:<结局事件 id>`） */
  readonly comparisonId: string
  readonly outcomeKind: ReflectionOutcomeKind
  /** 权威结果引用（结局事件 id） */
  readonly outcomeRef: string
  /** 真实结果时间（毫秒；程序读的，不是模型自报的） */
  readonly outcomeAt: number
  /** 结局结论（闭集） */
  readonly outcomeCode: ReflectionOutcomeCode
  /** 当时预测什么（程序给的既有文本，逐字） */
  readonly predictedText: string
  /** 实际发生什么（程序渲染的**闭集**描述） */
  readonly actualText: string
  /** 哪条假设被反驳（**仅失败结局有**；引用，不是自由文本） */
  readonly reviewCriterion?: string
  /** 关联的来源 id（**不产生新 handle**；遮蔽判据读它） */
  readonly sourceEventIds: readonly string[]
}

/** 一个结局的**原始声明**（"当时预测什么"的来源；程序读出来的事实）。 */
export interface ReflectionOutcomeOrigin {
  /** 结局事件 id */
  readonly outcomeEventId: string
  readonly kind: ReflectionOutcomeKind
  /** 结局结论（**由读面**按事件类型给出；闭集） */
  readonly outcomeCode: ReflectionOutcomeCode
  /** 声明 id（目标 id / 承诺 id） */
  readonly subjectId: string
  /** 原始声明文本（逐字；程序给的） */
  readonly statement: string
  /** 成功判据（"哪条假设"；可能没有） */
  readonly criterion?: string
  /** 声明的真实 revision */
  readonly revision: number
  /** 结局的真实时间 */
  readonly occurredAt: number
  /** 声明引用的来源 id（遮蔽判据读它） */
  readonly sourceEventIds: readonly string[]
}

/** 来源可用性读数（闭集原因码）。 */
export const REFLECTION_COMPARISON_SOURCE_REASONS = [
  'source_forgotten',
  'source_retracted',
  'source_unavailable',
] as const
export type ReflectionComparisonSourceReason = (typeof REFLECTION_COMPARISON_SOURCE_REASONS)[number]

export interface ReflectionComparisonSourceVerdict {
  readonly sourceEventId: string
  readonly usable: boolean
  readonly reason?: ReflectionComparisonSourceReason
}

/**
 * 比较材料的**取数端口**（实现里有 SQL；内核只拿结果）。
 *
 * ⚠️ 它与 `ReflectionInputSource` **分开**（"先分别接入"）：
 *    比较材料**不进入**反思窗口、**不进入** handle 集合、**不进入**根的计算。
 */
export interface ReflectionComparisonSource {
  /** 读一批结局事件的原始声明（"当时预测什么"） */
  originsOf(outcomeEventIds: readonly string[]): Promise<readonly ReflectionOutcomeOrigin[]>
  /** 这些来源现在还可用吗（遗忘 / 撤回 / 越权） */
  usabilityOf(sourceEventIds: readonly string[], options?: { lock?: boolean }): Promise<readonly ReflectionComparisonSourceVerdict[]>
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

function boundedText(text: string, limit: number): string {
  return [...text].slice(0, limit).join('')
}

/**
 * 装配一次反思的比较材料（**纯函数** + 一次只读端口调用）。
 *
 * @param triggers 既有触发（**只**取 `goal_outcome` / `commitment_outcome`）
 * @param source   取数端口
 */
export async function buildOutcomeComparisons(input: {
  readonly triggers: readonly ReflectionTrigger[]
  readonly source: ReflectionComparisonSource
  readonly maxItems?: number
}): Promise<readonly ReflectionOutcomeComparison[]> {
  const maxItems = input.maxItems ?? REFLECTION_COMPARISON_LIMITS.maxItems
  const candidates: { trigger: ReflectionTrigger; origin: ReflectionOutcomeOrigin }[] = []
  for (const trigger of input.triggers) {
    const kind = REFLECTION_OUTCOME_BY_TRIGGER_KIND[trigger.kind]
    if (kind === undefined) continue
    candidates.push({ trigger, origin: { outcomeEventId: trigger.eventId, kind } as ReflectionOutcomeOrigin })
  }
  if (candidates.length === 0) return []

  const origins = await input.source.originsOf(candidates.map((row) => row.trigger.eventId))
  const byEventId = new Map(origins.map((origin) => [origin.outcomeEventId, origin]))

  const resolved: { trigger: ReflectionTrigger; origin: ReflectionOutcomeOrigin }[] = []
  for (const candidate of candidates) {
    const origin = byEventId.get(candidate.trigger.eventId)
    if (origin === undefined) continue
    if (origin.kind !== candidate.origin.kind) continue
    if (!REFLECTION_OUTCOME_CODES.includes(origin.outcomeCode)) continue
    resolved.push({ trigger: candidate.trigger, origin })
  }
  if (resolved.length === 0) return []

  /*
   * ⚠️ **遮蔽先于注入**：比较引用的来源里**任何一条**不可用 ⇒ 整条比较作废。
   *    （不是"去掉那一条继续用"—— 少了预测面或少了实际面的比较没有意义。）
   */
  const allSourceIds = [...new Set(resolved.flatMap((row) => row.origin.sourceEventIds))]
  const verdicts = allSourceIds.length === 0
    ? []
    : await input.source.usabilityOf(allSourceIds)
  const usable = new Set(
    verdicts.filter((verdict) => verdict.usable).map((verdict) => verdict.sourceEventId)
  )
  const allUsable = (sourceEventIds: readonly string[]): boolean =>
    sourceEventIds.every((id) => usable.has(id))

  const comparisons: ReflectionOutcomeComparison[] = []
  let totalCodepoints = 0
  for (const row of resolved) {
    if (comparisons.length >= maxItems) break
    if (row.origin.sourceEventIds.length === 0 || !allUsable(row.origin.sourceEventIds)) continue
    const predictedText = boundedText(row.origin.statement, REFLECTION_COMPARISON_LIMITS.maxTextCodepoints)
    const criterion = row.origin.criterion === undefined
      ? undefined
      : boundedText(row.origin.criterion, REFLECTION_COMPARISON_LIMITS.maxTextCodepoints)
    const actualText = actualTextOf(row.origin.kind, row.origin.outcomeCode)
    const cost = [...predictedText].length + [...actualText].length + (criterion === undefined ? 0 : [...criterion].length)
    if (totalCodepoints + cost > REFLECTION_COMPARISON_LIMITS.maxTotalCodepoints) break
    totalCodepoints += cost
    const failed = FAILED_OUTCOME_CODES.has(row.origin.outcomeCode)
    comparisons.push({
      comparisonId: `cmp:${row.trigger.eventId}`,
      outcomeKind: row.origin.kind,
      outcomeRef: row.trigger.eventId,
      outcomeAt: row.origin.occurredAt,
      outcomeCode: row.origin.outcomeCode,
      predictedText,
      actualText,
      ...(failed && criterion !== undefined ? { reviewCriterion: criterion } : {}),
      sourceEventIds: [...row.origin.sourceEventIds],
    })
  }
  return comparisons
}

/** 结局的程序渲染（**闭集**，不含任何私有正文）。 */
export function actualTextOf(kind: ReflectionOutcomeKind, code: ReflectionOutcomeCode): string {
  if (kind === 'goal') {
    if (code === 'completed') return '（程序事实：目标已完成）'
    if (code === 'blocked') return '（程序事实：目标受阻）'
    return '（程序事实：目标已取消）'
  }
  if (code === 'fulfilled') return '（程序事实：承诺已履行）'
  if (code === 'broken') return '（程序事实：承诺已违背）'
  return '（程序事实：承诺已取消）'
}

/**
 * 把**成功判据**渲染成一句程序文本（闭集；**不是**模型生成的）。
 *
 * ⚠️ 判据本身是**结构化**的（`GoalSuccessCriterion`），不是自由文本 ——
 *    渲染出来的句子只是给人与模型读的**说明**，
 *    真正的判定仍然由目标域自己按结构做。
 */
export function renderCriterion(criterion: unknown): string | undefined {
  if (criterion === null || typeof criterion !== 'object' || Array.isArray(criterion)) return undefined
  const raw = criterion as Record<string, unknown>
  const kind = raw.kind
  if (kind === 'user_report') return '（成功判据：由用户报告确认）'
  if (kind === 'conversation_output') {
    const structure = raw.structure
    if (structure === null || typeof structure !== 'object' || Array.isArray(structure)) return undefined
    const spec = structure as Record<string, unknown>
    if (spec.kind === 'item_count' && typeof spec.count === 'number') {
      return `（成功判据：本次回复里至少 ${String(spec.count)} 项）`
    }
    if (spec.kind === 'marker_set' && Array.isArray(spec.markers)) {
      return '（成功判据：本次回复里出现指定标记）'
    }
    return undefined
  }
  if (kind === 'action_result') {
    const capability = typeof raw.capability === 'string' ? raw.capability : ''
    const operation = typeof raw.operation === 'string' ? raw.operation : ''
    if (capability === '' || operation === '') return undefined
    return `（成功判据：${capability}.${operation} 执行成功）`
  }
  return undefined
}

/**
 * 比较材料的**身份指纹**（幂等身份的一部分）。
 *
 * ⚠️ 它必须进 `inputWindowFingerprint` 的输入：否则"窗口没变但比较变了"
 *    会被当成同一份输入跳过（先例：M11 的 `inputFingerprint`）。
 */
export function comparisonFingerprint(comparisons: readonly ReflectionOutcomeComparison[]): string {
  return JSON.stringify(
    comparisons.map((row) => [
      row.comparisonId,
      row.outcomeKind,
      row.outcomeCode,
      row.outcomeAt,
      row.predictedText,
      row.actualText,
      row.reviewCriterion ?? '',
      [...row.sourceEventIds].sort(),
    ])
  )
}

/** 比较材料引用的**全部**来源 id（二次来源复核读它）。 */
export function comparisonSourceIdsOf(
  comparisons: readonly ReflectionOutcomeComparison[]
): readonly string[] {
  return [...new Set(comparisons.flatMap((row) => row.sourceEventIds))]
}

/**
 * 反思输入指纹的**载荷**（纯函数；runner 拿它去算 sha256）。
 *
 * ⚠️ **没有比较材料时逐字等于旧格式**（窗口行的 JSON 数组）：
 *    换了格式会让**既有**反思记录的"同一输入"判不出来 ⇒ 同一窗口被当成新输入
 *    再问一次模型（幂等退化）。有比较材料时才用**带比较**的新格式。
 */
export function reflectionInputFingerprintPayload(
  windowRows: readonly (readonly [string, string, number, string])[],
  comparisons: readonly ReflectionOutcomeComparison[]
): string {
  return JSON.stringify(
    comparisons.length === 0
      ? windowRows
      : { window: windowRows, comparisons: comparisonFingerprint(comparisons) }
  )
}

/**
 * 比较材料的来源**现在**还可用吗（二次来源复核；纯函数）。
 *
 * ⚠️ **空集合 ⇒ 不可用**：没有来源的比较**没有**可复核的东西 ⇒ 不提交。
 */
export function comparisonsStillUsable(
  verdicts: readonly ReflectionComparisonSourceVerdict[],
  expectedIds: readonly string[] = verdicts.map(row => row.sourceEventId)
): boolean {
  return expectedIds.length > 0 && expectedIds.every(id =>
    verdicts.some(row => row.sourceEventId === id && row.usable)
  )
}
