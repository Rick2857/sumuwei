/**
 * M5 WP7 —— **召回决策记录**（`RecallDecisionRecord`）。
 *
 * ============================================================================
 *  它要回答的问题是："为什么这一次想起了这些内容？"
 * ============================================================================
 * 计划书列的观察点，逐条落在这个结构里：
 *
 *     RecallRequest          → query / intent / timeScope / target / limits（**不含原话**）
 *     Candidate Query        → scanned（后端扫了多少行）
 *     Candidate IDs          → candidates[].memoryId
 *     Eligibility Decision   → decisions[].eligible + reason
 *     Exclusion Reasons      → decisions[].reason + metrics.exclusionHistogram
 *     Ranking                → decisions[].score（分项 breakdown，带 available）
 *     Selected IDs           → selectedIds（**实际进了 packet 的**，见下）
 *     Context Budget         → budget（四个数字）
 *     ContextBundle          → requestDigest + selectedFingerprints
 *     Model Invocation       → 由既有 trace 的 model_generate step 负责（M3 就有）
 *     Response               → 由既有 trace 的 output_validate / persist_output 负责
 *
 * ⚠️ **不造第二套 tracing**：这份记录是**既有 trace 的一个 step 的属性**
 *    （`memory_recall`），不是新表、不是新通道。
 *
 * ---------------------------------------------------------------------------
 *  两条纪律
 * ---------------------------------------------------------------------------
 * 1. **无正文**。记录里只有 id / 指纹 / 计数 / 分数 / 理由 / 配置量级 ——
 *    计划书 WP7 的隐私纪律（"audit 可以引用 memory id / hash / metadata，
 *    不要无必要复制完整敏感 Memory 内容到日志"）。
 *    这里**连 `dataText` 字段都不认识**（它根本不在输入类型里）。
 *
 * 2. **有界**。500 条候选的逐条记录会撑爆 trace 的一列，因此逐条部分
 *    只保留前 `maxPerCandidates` 条并标 `truncated: true`；
 *    **计数与直方图永远是全量的** —— 被截断的是"明细"，不是"事实"。
 */

import { entityLabel, type EntityRef } from '../contracts/entity.ts'
import type { MemoryAuthority, MemoryEpistemicStatus, MemoryStatus, MemoryType } from '../contracts/memory.ts'
import type { RecallBudgetAccount, RecallChannel, RecallExclusionReason, RecallRequest } from '../contracts/recall.ts'
import { recallRequestDigest } from '../contracts/recall.ts'
import type { RecallScoreBreakdown } from '../contracts/recall.ts'

/** 逐条明细最多记多少（计数与直方图不受它影响） */
export const RECALL_RECORD_MAX_CANDIDATES = 40

export interface RecallCandidateFact {
  memoryId: string
  channels: readonly RecallChannel[]
  type: MemoryType
  status: MemoryStatus
  authority: MemoryAuthority
  epistemicStatus: MemoryEpistemicStatus
  importance: number
  /** 是否通过 M5-PRE 的完整性探针（探针结论，不是重新判断） */
  integrityOk: boolean
  /** Claim 的槽位键（可回答"同一槽位上还有哪些"）；Episode 没有 → 不含此字段 */
  canonicalKey?: string
  /** 内容指纹（**可以进 trace**：它是 metadata，不是正文） */
  contentFingerprint: string
}

export interface RecallDecisionFact {
  memoryId: string
  eligible: boolean
  /** 未选中时必有（契约保证） */
  reason?: RecallExclusionReason
  selected: boolean
  /** 通过资格后的分数明细（**分项的 available 必须保留** —— 那是"不得伪造"的落地） */
  score?: RecallScoreBreakdown
}

export interface RecallQueryFact {
  source: 'user_message' | 'synthetic'
  intent: RecallRequest['intent']
  timeScopeKind: RecallRequest['timeScope']['kind']
  candidateLimit: number
  memoryKinds?: readonly MemoryType[]
  targetStatus: RecallRequest['target']['status']
  targetVia?: string
}

export interface RecallMetrics {
  scanned: number
  candidateCount: number
  eligibleCount: number
  selectedCount: number
  exclusionHistogram: Record<string, number>
  /** 被预算裁掉（`BUDGET_EXHAUSTED`）的条数 */
  droppedByBudget: number
  /** 完整性损坏而被拦下的条数（`ORPHANED_EVIDENCE`） */
  orphanedCount: number
  /**
   * **选择器选中**的那些是否被上下文编译器整段丢掉了。
   *
   * 计划书 WP7 的 Measurement Truth 靠这两个字段可被机器判定：
   * 编译器是最终的裁剪者（记忆 section 是 `droppable: true`），
   * 它丢掉记忆块时，`selectedIds` 必须是 `[]`（**事实**），
   * 而 `intendedSelectedIds` 保留"我们本来选了谁"（**诊断**）。
   * 两者不一致本身就是一条可断言的信号 —— 而不是被掩盖成"选了"。
   */
  droppedByContextBudget: boolean
  budgetTokens: number
  selectedTokens: number
  /** 0..1（`selectedTokens / budgetTokens`；预算为 0 时为 0） */
  budgetUtilization: number
  topSelectedScore?: number
  meanSelectedScore?: number
  /**
   * 选择器选中的记忆是否**真的进了 packet**。
   *
   * 计划书 WP7 的 Measurement Truth 就在这里：
   * 上下文编译器是**最终**的裁剪者（记忆 section 是 `droppable: true`），
   * 它可以整段丢掉记忆块 —— 那时 trace 必须说"没进"，而不是"选了"。
   */
  reachedContext: boolean
}

export interface RecallDecisionRecord {
  traceId: string
  characterId: string
  /** `user:<id>` —— 进 trace 的形态用标签，不用对象 */
  user: string
  generatedAt: number
  /** 请求的稳定摘要（**不含原话**） */
  requestDigest: string
  query: RecallQueryFact
  candidates: RecallCandidateFact[]
  decisions: RecallDecisionFact[]
  /**
   * **实际进了 packet** 的记忆 id（事实）。
   *
   * ⚠️ 不是"选择器选中的"——如果上下文编译器因为总预算把记忆段整段裁掉，
   *    这里必须是 `[]`。计划书 WP7 的原话："要验证**模型实际获得了哪条 Memory**"。
   */
  selectedIds: string[]
  /** 选择器选中、但在上下文编译阶段被丢掉的记忆 id（诊断用） */
  intendedSelectedIds: string[]
  selectedFingerprints: string[]
  budget: RecallBudgetAccount
  metrics: RecallMetrics
  /** 逐条明细是否被截断（计数与直方图永远全量） */
  truncated: boolean
  /**
   * **M9.5 / `WP8`（甲-1）**：这一轮**语义通道**的读数 —— **无正文**，全是数/布尔/短枚举。
   *
   * ```text
   * 为什么必须有：`shadow` 期靠 `shadow?` 那份"新旧顺序对照"观察；
   * 切到 `on` 之后那份**不再产出** ⇒ **激活之后反而看不见这个通道了** ✗
   * ⇒ 于是把"语义到底有没有分、有没有参与排序"记成**与模式无关**的一行读数 ✓
   * ⚠️ 满足 `assertRecordShapeIsContentFree` 的两条：无正文类键 + 任何 `{name,value}` 的 value 是数字 ✓
   * ```
   */
  semantic?: {
    readonly mode: 'off' | 'shadow' | 'on'
    /** 本轮**真的拿到语义分数**的记忆条数（`ports.ts` 的 `semanticScoredIds` 长度） */
    readonly scoredCount: number
    /** 语义分数是否**参与了排序**（`off` 时必然 false） */
    readonly participated: boolean
  }
}

export interface BuildRecallDecisionRecordInput {
  traceId: string
  characterId: string
  user: EntityRef
  request: RecallRequest
  generatedAt: number
  candidates: readonly {
    memoryId: unknown
    channels: readonly RecallChannel[]
    type: MemoryType
    status: MemoryStatus
    authority: MemoryAuthority
    epistemicStatus: MemoryEpistemicStatus
    importance: number
    integrityOk: boolean
    canonicalKey?: string
    contentFingerprint: string
  }[]
  decisions: readonly RecallDecisionFact[]
  selectedIds: readonly string[]
  selectedFingerprints: readonly string[]
  budget: RecallBudgetAccount
  scored: readonly { memoryId: string; total: number }[]
  /** 记忆 section 是否真的出现在 packet 里（由**编译器之后**的事实决定） */
  reachedContext: boolean
  /** 选择器选中的（与 `selectedIds` 不同时，说明编译器丢掉了它们） */
  intendedSelectedIds?: readonly string[]
  maxPerCandidates?: number
  /** **M9.5 / `WP8`（甲-1）**：语义通道读数（见 `RecallDecisionRecord.semantic`） */
  semantic?: RecallDecisionRecord['semantic']
}

export function buildRecallDecisionRecord(
  input: BuildRecallDecisionRecordInput
): RecallDecisionRecord {
  const max = input.maxPerCandidates ?? RECALL_RECORD_MAX_CANDIDATES
  const decisions = [...input.decisions]
  const candidates = [...input.candidates]

  const exclusionHistogram: Record<string, number> = {}
  let droppedByBudget = 0
  let orphanedCount = 0
  for (const decision of decisions) {
    if (decision.reason === undefined) continue
    exclusionHistogram[decision.reason] = (exclusionHistogram[decision.reason] ?? 0) + 1
    if (decision.reason === 'BUDGET_EXHAUSTED') droppedByBudget += 1
    if (decision.reason === 'ORPHANED_EVIDENCE') orphanedCount += 1
  }

  const selectedSet = new Set(input.selectedIds.map(String))
  const selectedScores = input.scored
    .filter((item) => selectedSet.has(String(item.memoryId)))
    .map((item) => item.total)
  const budgetTokens = input.budget.budgetTokens
  const selectedTokens = input.budget.memoryTokens

  const target = input.request.target

  return {
    traceId: input.traceId,
    /* ⚠️ 与模式无关的一行读数（`WP8` 甲-1）：`undefined` 时该键不出现（可选） */
    ...(input.semantic !== undefined ? { semantic: input.semantic } : {}),
    characterId: input.characterId,
    user: entityLabel(input.user),
    generatedAt: input.generatedAt,
    requestDigest: recallRequestDigest(input.request),
    query: {
      source: input.request.query.source,
      intent: input.request.intent,
      timeScopeKind: input.request.timeScope.kind,
      candidateLimit: input.request.candidateLimit,
      ...(input.request.memoryKinds !== undefined ? { memoryKinds: input.request.memoryKinds } : {}),
      targetStatus: target.status,
      ...(target.status === 'resolved' ? { targetVia: target.via } : {}),
    },
    candidates: candidates.slice(0, max).map((candidate) => ({
      memoryId: String(candidate.memoryId),
      channels: [...candidate.channels],
      type: candidate.type,
      status: candidate.status,
      authority: candidate.authority,
      epistemicStatus: candidate.epistemicStatus,
      importance: candidate.importance,
      integrityOk: candidate.integrityOk,
      ...(candidate.canonicalKey !== undefined ? { canonicalKey: candidate.canonicalKey } : {}),
      contentFingerprint: candidate.contentFingerprint,
    })),
    decisions: decisions.slice(0, max),
    selectedIds: input.selectedIds.map(String),
    intendedSelectedIds: (input.intendedSelectedIds ?? input.selectedIds).map(String),
    selectedFingerprints: [...input.selectedFingerprints],
    budget: input.budget,
    metrics: {
      scanned: 0, // 由调用方在 build 之后再补（它来自检索阶段，不在候选里）
      candidateCount: candidates.length,
      eligibleCount: decisions.filter((d) => d.eligible).length,
      selectedCount: input.selectedIds.length,
      exclusionHistogram,
      droppedByBudget,
      orphanedCount,
      budgetTokens,
      selectedTokens,
      budgetUtilization: budgetTokens === 0 ? 0 : Number((selectedTokens / budgetTokens).toFixed(4)),
      droppedByContextBudget:
        input.intendedSelectedIds !== undefined &&
        input.intendedSelectedIds.length > 0 &&
        input.selectedIds.length === 0,
      ...(selectedScores.length > 0 ? { topSelectedScore: Math.max(...selectedScores) } : {}),
      ...(selectedScores.length > 0
        ? {
            meanSelectedScore: Number(
              (selectedScores.reduce((sum, value) => sum + value, 0) / selectedScores.length).toFixed(4)
            ),
          }
        : {}),
      reachedContext: input.reachedContext,
    },
    truncated: candidates.length > max || decisions.length > max,
  }
}

/** 补 `scanned`（它来自检索阶段，不属于候选本身） */
export function withScanned(record: RecallDecisionRecord, scanned: number): RecallDecisionRecord {
  return { ...record, metrics: { ...record.metrics, scanned } }
}

/**
 * **用编译器之后的事实修正记录**（WP7 Measurement Truth 的落地点）。
 *
 * 记忆 section 是 `droppable: true` —— 上下文编译器可以在总预算不足时
 * 把它**整段**丢掉。那时：
 *
 *     intendedSelectedIds  我们还留着（诊断：选择器本来选了谁）
 *     selectedIds          **必须清空**（事实：模型一条都没拿到）
 *     reachedContext       false
 *     droppedByContextBudget true
 *
 * 不做这一步的后果，正是计划书点名要防的那件事：
 * trace 说"她想起了生日"，而模型实际收到的 prompt 里没有它 ——
 * 于是"她忘了"与"系统漏了"在事后无法区分，Measurement Truth 失效。
 */
export function applyContextReality(
  record: RecallDecisionRecord,
  input: { memorySectionSurvived: boolean }
): RecallDecisionRecord {
  if (input.memorySectionSurvived) {
    return {
      ...record,
      metrics: { ...record.metrics, reachedContext: record.selectedIds.length > 0 },
    }
  }
  /*
   * 被整段丢掉：**metrics 描述事实**（什么都没到），
   * 而"本来选了多少 token"留在 `budget`（那是选择阶段的账）。
   * 两者分开，才能让"她本来该想起这些、但上下文没放下"成为一条可断言的事实。
   */
  return {
    ...record,
    selectedIds: [],
    selectedFingerprints: [],
    metrics: {
      ...record.metrics,
      selectedCount: 0,
      selectedTokens: 0,
      budgetUtilization: 0,
      topSelectedScore: undefined,
      meanSelectedScore: undefined,
      reachedContext: false,
      droppedByContextBudget: record.intendedSelectedIds.length > 0,
    },
  }
}

/**
 * 记录 → trace 的属性（**扁平标量**）。
 *
 * `TraceStep.attributes` 只接受 `string | number | boolean`，因此逐条明细
 * 以 JSON 字符串形式塞进一个属性；而**指标**摊平成一等标量 ——
 * 于是"这一轮的召回量级"在 trace 面板上不用解析 JSON 就能看见。
 */
export function recordToTraceAttributes(record: RecallDecisionRecord): Record<string, string | number | boolean> {
  return {
    candidates: record.metrics.candidateCount,
    eligible: record.metrics.eligibleCount,
    selected: record.metrics.selectedCount,
    droppedByBudget: record.metrics.droppedByBudget,
    orphaned: record.metrics.orphanedCount,
    scanned: record.metrics.scanned,
    memoryTokens: record.metrics.selectedTokens,
    budgetTokens: record.metrics.budgetTokens,
    budgetUtilization: record.metrics.budgetUtilization,
    reachedContext: record.metrics.reachedContext,
    truncated: record.truncated,
    exclusions: JSON.stringify(record.metrics.exclusionHistogram),
    /** 逐条明细（有界、无正文） */
    decisionRecord: JSON.stringify(record),
  }
}

/**
 * 逐字段确认"这份记录里没有正文"的**结构前提**。
 *
 * 它不能代替"拿真实正文去搜一遍"（那需要正文，而这里刻意没有），
 * 但能挡住最危险的一种改动：**有人给记录加了 content / dataText 之类的字段**。
 * 契约测试会同时做两件事：跑这个函数 + 用 fixture 的真实正文搜一遍。
 */
export function assertRecordShapeIsContentFree(record: RecallDecisionRecord): void {
  /*
   * ⚠️ 禁止键列表只放"会承载记忆正文"的字段名。
   *
   * 第一版把 `value` 也放进去了 —— 于是每个 `score.components[].value`
   * （一个分数）都被判成"疑似正文"。那是把**通用字段名**当成了内容标记。
   * 现在的判据是两条：
   *   ① 记录里不许出现正文类键（dataText / content / summary / …）
   *   ② 任何 `{name, value}` 形状的对象，`value` 必须是**数字**（分数）
   *      —— 这样即使有人把正文塞进 `value`，它也会被抓住
   */
  const forbiddenKeys = ['dataText', 'memoryText', 'searchable', 'content', 'summary', 'rawText', 'body']
  const seen: string[] = []
  const nonNumericScore: string[] = []

  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    const recordLike = value as Record<string, unknown>
    for (const [key, item] of Object.entries(recordLike)) {
      if (forbiddenKeys.includes(key)) seen.push(`${path}.${key}`)
      walk(item, `${path}.${key}`)
    }
    if (typeof recordLike.name === 'string' && 'value' in recordLike && typeof recordLike.value !== 'number') {
      nonNumericScore.push(`${path}.value`)
    }
  }
  walk(record, 'record')

  if (seen.length > 0) {
    throw new Error(
      `RecallDecisionRecord 里出现了疑似正文的字段：${seen.join(', ')}。` +
        '记录只允许 id / 指纹 / 计数 / 分数 / 理由 —— 计划书 WP7 的隐私纪律'
    )
  }
  if (nonNumericScore.length > 0) {
    throw new Error(
      `分数项里的 value 必须是数字（分数），但收到非数字：${nonNumericScore.join(', ')}。` +
        '把正文塞进 value 会让这条结构检查失效'
    )
  }
}

/** 便于日志/证据：一行摘要（**不含正文**） */
export function describeDecisionRecord(record: RecallDecisionRecord): string {
  return (
    `trace=${record.traceId} scanned=${record.metrics.scanned} ` +
    `candidates=${record.metrics.candidateCount} eligible=${record.metrics.eligibleCount} ` +
    `selected=${record.metrics.selectedCount} tokens=${record.metrics.selectedTokens}/${record.metrics.budgetTokens} ` +
    `reachedContext=${record.metrics.reachedContext}`
  )
}

/**
 * 多轮指标聚合（AT7.7：retrieval metrics）。
 *
 * 它回答的是"这套召回在**一批**问题上表现如何"，与单轮的
 * `RecallDecisionRecord.metrics` 互补。四个数字是刻意选的：
 *
 *   meanCandidates     宽召回平均有多宽（太窄 = 漏；太宽 = 排序压力大）
 *   meanSelected       每轮平均进几条（太小 = 白跑；太大 = 挤上下文）
 *   budgetUtilization  预算利用率的均值（长期接近 0 说明预算过大或召回太窄）
 *   reachedContextRate **声称选了、实际进了 prompt** 的比例
 *                      —— 它低于 1 就说明"被上下文预算丢掉"在真实发生，
 *                      而那正是 Measurement Truth 要暴露的事实
 */
export interface RecallMetricsAggregate {
  turns: number
  meanCandidates: number
  meanEligible: number
  meanSelected: number
  meanBudgetUtilization: number
  /** 声称选了、实际进了 prompt 的比例（1 = 从没被上下文预算丢掉） */
  reachedContextRate: number
  /** 所有轮次里各排除理由的合计 */
  exclusionTotals: Record<string, number>
}

export function aggregateRecallMetrics(
  records: readonly RecallDecisionRecord[]
): RecallMetricsAggregate {
  const turns = records.length
  if (turns === 0) {
    return {
      turns: 0,
      meanCandidates: 0,
      meanEligible: 0,
      meanSelected: 0,
      meanBudgetUtilization: 0,
      reachedContextRate: 0,
      exclusionTotals: {},
    }
  }
  const exclusionTotals: Record<string, number> = {}
  for (const record of records) {
    for (const [reason, count] of Object.entries(record.metrics.exclusionHistogram)) {
      exclusionTotals[reason] = (exclusionTotals[reason] ?? 0) + count
    }
  }
  const withSelection = records.filter((record) => record.intendedSelectedIds.length > 0)
  return {
    turns,
    meanCandidates: round4(
      records.reduce((sum, record) => sum + record.metrics.candidateCount, 0) / turns
    ),
    meanEligible: round4(
      records.reduce((sum, record) => sum + record.metrics.eligibleCount, 0) / turns
    ),
    meanSelected: round4(
      records.reduce((sum, record) => sum + record.metrics.selectedCount, 0) / turns
    ),
    meanBudgetUtilization: round4(
      records.reduce((sum, record) => sum + record.metrics.budgetUtilization, 0) / turns
    ),
    reachedContextRate:
      withSelection.length === 0
        ? 1
        : round4(
            withSelection.filter((record) => record.metrics.reachedContext).length /
              withSelection.length
          ),
    exclusionTotals,
  }
}

function round4(value: number): number {
  return Number(value.toFixed(4))
}
