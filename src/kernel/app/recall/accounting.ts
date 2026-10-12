/**
 * M9.5 WP7 —— **逐层计数守恒与"每条候选的去向"**（纯函数）。
 *
 * ============================================================================
 *  它守的是什么
 * ============================================================================
 * ```text
 * 召回链的每一层都会**减人**：扫描 → 候选（截断）→ 资格 → 去重/冲突 → 排序 → 预算选择 → 入模。
 * 这条链最容易出的错**不是崩溃，而是数字不再自洽**：
 *   · "入模 5 条"但"只选中 3 条" —— 有东西绕过选择器进了 prompt
 *   · "语义没用上"却报"语义可用"     —— 伪启用（D25 第 ④ 条）
 *   · 某条候选**没有任何去向**        —— 它既没进上下文、也没被记为任何理由
 * 这些在日志里都长得像正常输出。⇒ 把它们变成**具名违规**。
 * ```
 *
 * ⚠️ 本模块是**纯函数**：不读数据库、不看 trace 对象 —— 调用方把数交进来。
 *    这样"数字自洽"这件事可以被穷举输入钉死，而不是靠某一次运行的运气。
 */

export interface RecallLayerCounts {
  /** 后端实际取回的行数 */
  readonly scanned: number
  /** 候选池（截断**之后**） */
  readonly candidates: number
  /** 资格过滤之后 */
  readonly eligible: number
  /** 预算内被选中的 */
  readonly selected: number
  /** **真的进了上下文**的（最终使用集合） */
  readonly injected: number
  /** 拿到真实语义分数的候选数 */
  readonly semanticScored: number
  /** 其中真的进了上下文的 */
  readonly semanticUsed: number
  /** 因预算被丢掉的 */
  readonly droppedByBudget: number
}

export interface AccountingVerdict {
  readonly ok: boolean
  /** 具名违规（空 = 自洽）。每条都能读出"哪一条不变式破了、差多少" */
  readonly violations: readonly string[]
}

/**
 * 检查逐层计数是否自洽。
 *
 * 十一条不变式，**每条都对应一个真实的失败形态**（见文件头）。
 */
export function checkRecallAccounting(counts: RecallLayerCounts): AccountingVerdict {
  const violations: string[] = []
  const entries = Object.entries(counts) as [keyof RecallLayerCounts, number][]

  for (const [name, value] of entries) {
    if (!Number.isInteger(value) || value < 0) {
      violations.push(`${name}=${String(value)} 必须是非负整数`)
    }
  }
  if (violations.length > 0) return { ok: false, violations }

  const ladder: [keyof RecallLayerCounts, keyof RecallLayerCounts][] = [
    ['scanned', 'candidates'],
    ['candidates', 'eligible'],
    ['eligible', 'selected'],
    ['selected', 'injected'],
  ]
  for (const [upper, lower] of ladder) {
    if (counts[upper] < counts[lower]) {
      violations.push(`${upper}(${String(counts[upper])}) < ${lower}(${String(counts[lower])}) ⇒ 下一层比上一层还多`)
    }
  }
  if (counts.semanticScored > counts.candidates) {
    violations.push(
      `semanticScored(${String(counts.semanticScored)}) > candidates(${String(counts.candidates)}) ⇒ 语义分数来自候选池之外`
    )
  }
  if (counts.semanticUsed > counts.semanticScored) {
    violations.push(
      `semanticUsed(${String(counts.semanticUsed)}) > semanticScored(${String(counts.semanticScored)}) ` +
        '⇒ 用了没算过分的候选（伪启用）'
    )
  }
  if (counts.semanticUsed > counts.selected) {
    violations.push(
      `semanticUsed(${String(counts.semanticUsed)}) > selected(${String(counts.selected)}) ⇒ 没被选中却入了模`
    )
  }
  if (counts.semanticUsed > 0 && counts.semanticScored === 0) {
    violations.push('semanticUsed > 0 而 semanticScored = 0 ⇒ 无法解释的语义用量')
  }
  if (counts.injected > 0 && counts.selected === 0) {
    violations.push('injected > 0 而 selected = 0 ⇒ 有东西绕过选择器进了上下文')
  }
  if (counts.droppedByBudget > counts.eligible - counts.selected) {
    violations.push(
      `droppedByBudget(${String(counts.droppedByBudget)}) > eligible − selected(${String(counts.eligible - counts.selected)}) ` +
        '⇒ 预算丢掉的比"没被选中的"还多'
    )
  }

  return { ok: violations.length === 0, violations }
}

// ---------------------------------------------------------------------------
// 每条候选的**去向**（WP7：不许有候选"没被记账"）
// ---------------------------------------------------------------------------

export type RecallDispositionLayer =
  /** 资格层出局 */
  | 'ineligible'
  /** 与另一条重复 / 冲突组内让位 */
  | 'duplicate'
  /** 排序之后被排在后面 */
  | 'outranked'
  /** 额度不够 */
  | 'budget'
  /** 真的进了上下文 */
  | 'injected'

export const RECALL_DISPOSITION_LAYERS: readonly RecallDispositionLayer[] = [
  'ineligible',
  'duplicate',
  'outranked',
  'budget',
  'injected',
]

export function isRecallDispositionLayer(value: unknown): value is RecallDispositionLayer {
  return typeof value === 'string' && (RECALL_DISPOSITION_LAYERS as readonly string[]).includes(value)
}

export interface CandidateDisposition {
  readonly memoryId: string
  readonly layer: RecallDispositionLayer
  /**
   * 未入模时**必须**具名（契约 §2.4 的理由码）；入模时必须是 `null`。
   * "没有理由"与"理由为空串"是两件事：后者说明调用方在糊弄。
   */
  readonly reason: string | null
}

export interface DispositionVerdict {
  readonly ok: boolean
  readonly violations: readonly string[]
  /** 入模集合（由去向推导；应与 trace 的 selected/injected 集合一致） */
  readonly injectedIds: readonly string[]
}

/**
 * 由链路**已经产出的**决策表生成去向表（N2）。
 *
 * ```text
 * ⚠️ 为什么复用装配层那张表、而不是另建一份：
 *     `turn.ts` 里已经有一张**完整**的决策表（资格层未通过的来自 `verdicts`、
 *     排序层淘汰的来自 `ranked.decisions`、其余来自 `ranked.ranked`）。
 *     另造一份的后果是"两张表会漂移"，而漂移的表现是 trace 里两个数字互相矛盾
 *     —— 那正是本模块要消除的东西。
 *     ⇒ 本函数只做**机械映射**：`RecallExclusionReason` 的阶段已由
 *       `RECALL_EXCLUSION_REASON_FACTS[reason].stage` 唯一决定，这里**不重判**。
 * ```
 */
export function dispositionsFromDecisions(input: {
  readonly decisions: readonly {
    readonly memoryId: string
    readonly eligible: boolean
    readonly reason?: string
    readonly selected: boolean
  }[]
  readonly stageOf: (reason: string) => 'eligibility' | 'ranking' | 'budget'
}): readonly CandidateDisposition[] {
  const out: CandidateDisposition[] = []
  for (const decision of input.decisions) {
    if (decision.selected) {
      out.push({ memoryId: decision.memoryId, layer: 'injected', reason: null })
      continue
    }
    if (!decision.eligible) {
      out.push({ memoryId: decision.memoryId, layer: 'ineligible', reason: decision.reason ?? null })
      continue
    }
    const reason = decision.reason ?? null
    if (reason === null) {
      /* 未选中却没有理由 —— **不**替它编一个；交给 `checkDispositions` 报出来 */
      out.push({ memoryId: decision.memoryId, layer: 'outranked', reason: null })
      continue
    }
    const stage = input.stageOf(reason)
    const layer: RecallDispositionLayer =
      stage === 'budget' ? 'budget' : stage === 'ranking' && reason === 'DUPLICATE' ? 'duplicate' : 'outranked'
    out.push({ memoryId: decision.memoryId, layer, reason })
  }
  return out
}

/**
 * 检查"每条候选恰好一个去向、未入模的都有具名理由"。
 *
 * ⚠️ 三个**必须同时**成立的性质：
 * ```text
 * ① 候选集合与去向集合**一一对应**（少一条 = 有条候选没被记账；多一条 = 凭空多出一个去向）
 * ② `layer === 'injected'` ⟺ `memoryId ∈ selectedIds`（去向与选中集**不得各说各话**）
 * ③ 未入模 ⇒ `reason` 必须是非空字符串；入模 ⇒ `reason` 必须是 `null`
 * ```
 */
export function checkDispositions(input: {
  readonly candidateIds: readonly string[]
  readonly selectedIds: readonly string[]
  readonly dispositions: readonly CandidateDisposition[]
}): DispositionVerdict {
  const violations: string[] = []
  const selected = new Set(input.selectedIds)
  const candidates = new Set(input.candidateIds)

  const seen = new Map<string, number>()
  for (const disposition of input.dispositions) {
    seen.set(disposition.memoryId, (seen.get(disposition.memoryId) ?? 0) + 1)
    if (!candidates.has(disposition.memoryId)) {
      violations.push(`去向 ${disposition.memoryId} 不在候选集合里 ⇒ 凭空多出一个去向`)
    }
    if (!isRecallDispositionLayer(disposition.layer)) {
      violations.push(`去向 ${disposition.memoryId} 的 layer 非法：${String(disposition.layer)}`)
      continue
    }
    const isInjected = disposition.layer === 'injected'
    if (isInjected !== selected.has(disposition.memoryId)) {
      violations.push(
        `去向与选中集矛盾：${disposition.memoryId} layer=${disposition.layer} 但 ` +
          `${selected.has(disposition.memoryId) ? '在' : '不在'}选中集`
      )
    }
    if (!isInjected && (disposition.reason === null || disposition.reason.trim() === '')) {
      violations.push(`未入模的候选 ${disposition.memoryId} 没有具名理由（layer=${disposition.layer}）`)
    }
    if (isInjected && disposition.reason !== null) {
      violations.push(`入模的候选 ${disposition.memoryId} 不应带理由码（带了 ${JSON.stringify(disposition.reason)}）`)
    }
  }

  for (const id of candidates) {
    const times = seen.get(id) ?? 0
    if (times === 0) violations.push(`候选 ${id} 没有任何去向 ⇒ 它既没进上下文、也没被记为任何理由`)
    if (times > 1) violations.push(`候选 ${id} 有 ${String(times)} 个去向 ⇒ 去向不唯一`)
  }

  return {
    ok: violations.length === 0,
    violations,
    injectedIds: input.dispositions.filter((item) => item.layer === 'injected').map((item) => item.memoryId),
  }
}
