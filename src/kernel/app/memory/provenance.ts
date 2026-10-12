/**
 * Provenance & Timeline —— **"这条记忆来自哪里、它什么时候有效、它的历史长什么样"**
 * （计划书第 34–41、85、131–132 节）。
 *
 * ============================================================================
 *  WP6 Gate（计划书第 132 节）要的就是这个文件的输出
 * ============================================================================
 *     能够完整展示 Memory History：
 *       2026-09-01 喜欢咖啡
 *       2026-09-16 戒咖啡
 *       Current: 戒咖啡
 *     同时历史不丢失。
 *
 * 注意那个 Gate 有两个半边，缺一不可：
 *   · **当前状态**要说得出（"Current: 戒咖啡"）
 *   · **历史**也要说得出（"2026-09-01 喜欢咖啡"仍在）
 *
 * 只有前一半 → "覆盖"（丢历史）；只有后一半 → 无法回答"现在到底算哪个"。
 * M4 的 `SUPERSEDED` 设计同时满足两者，而本文件负责把它**展示**出来。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 计划书第 41 节的证据继承：这是为 M11 防"自我强化"预埋的那一条
 * ---------------------------------------------------------------------------
 *     如果 Memory A 来自 Event #100，后来 Memory B 是基于 A 总结产生，
 *     那么 B 的根 Evidence 仍然应该包含 Event #100，
 *     不能伪造成新的独立证据。
 *
 * M4 还没有 A→B 的派生链（那是 M11 的 Reflection），但
 * **函数现在就写好并测试** —— 这样 M11 不能"顺手"把它写松。
 * 这是 M3.5 那条老教训的直接应用：
 * **"声明了字段"不等于"字段会被用到"**，而"以后会用到"通常等于"永远不写"。
 */

import {
  KernelError,
  isClaimContent,
  type MemoryRecord,
  type MemoryStatus,
  type Timestamp,
} from '../../contracts/index.ts'

// ---------------------------------------------------------------------------
// 证据继承（计划书第 41 节）
// ---------------------------------------------------------------------------

/**
 * 新记忆从被派生的那几条记忆那里继承的根证据。
 *
 * **派生**是"基于 A 总结出 B"，而 B 的证据根必须是 A 的证据根 ——
 * 不是 A 本身。原因是"经过一次总结"不产生新的独立证据：
 * 若 B 把 A 当成自己的根，那么未来数"有几条独立证据支持某个结论"时，
 * A 与 B 会被算成两份，而它们其实来自同一次对话（#100）。
 *
 * 那个缺陷的形状就是计划书第 41 节说的**自我强化**：
 * 每次 Reflection 都把上一次的结论当新证据，于是置信度越来越高，
 * 而外部世界没有提供任何新信息。
 */
export function inheritedEvidenceRoots(
  derivedFrom: readonly MemoryRecord[]
): string[] {
  const roots = new Set<string>()
  for (const record of derivedFrom) {
    for (const root of record.evidenceRootIds) roots.add(root)
  }
  return [...roots]
}

/**
 * 断言派生记忆**真的**继承了根证据（计划书第 41 节的强形式）。
 *
 * 与 `assertMemoryEvidence` 的关系：
 *   · 那个是**弱形式**（MI-03 的基础检查）：`evidenceRootIds ⊆ sourceRefs`
 *   · 这个是**强形式**：B 的根必须**包含**它所派生自的每一条的根
 *
 * 两者都要有。弱形式保证"根不是凭空造的"，强形式保证"派生不切断溯源链"。
 *
 * ⚠️ 参数里的 `derivedFrom` 是**事实来源**：调用方必须真的把被派生的记忆
 * 传进来。若传空数组，这个函数会放行一切 —— 因此
 * `derivedFrom` 为空时它**要求调用方显式声明**"这不是派生记忆"
 * （见 `isDerivation` 参数）。那个显式声明让"忘了传"变成一次失败，
 * 而不是一次静默放行。
 */
export function assertDerivedEvidenceInherits(input: {
  /** 新记忆的根证据 */
  evidenceRootIds: readonly string[]
  /** 它派生自哪些记忆 */
  derivedFrom: readonly MemoryRecord[]
  /** 调用方是否声明"这是一条派生记忆" */
  isDerivation: boolean
}): void {
  if (!input.isDerivation) return

  if (input.derivedFrom.length === 0) {
    throw new KernelError(
      'validation_error',
      'derivation_without_source',
      '声明了这是一条派生记忆，但没有给出它派生自哪些记忆。' +
        '空数组会放行一切 —— 那让"忘了传"看起来像"检查通过"',
      {}
    )
  }

  const required = inheritedEvidenceRoots(input.derivedFrom)
  const have = new Set(input.evidenceRootIds)
  const missing = required.filter((root) => !have.has(root))

  if (missing.length > 0) {
    throw new KernelError(
      'validation_error',
      'derived_evidence_root_missing',
      `派生记忆的根证据没有包含被派生记忆的根：缺少 ${missing.join(', ')}。` +
        '计划书第 41 节：经过一次总结**不产生新的独立证据** —— ' +
        '若把上一层的结论当成新证据，未来数"有几份独立支持"时会重复计票，' +
        '而那正是 M11 Reflection 的自我强化（每轮都更相信，而世界没提供新信息）',
      { required, have: [...have], missing }
    )
  }
}

// ---------------------------------------------------------------------------
// 时间语义（计划书第 34–38 / 85 节）
// ---------------------------------------------------------------------------

/**
 * `validUntil` 的**三种**状态（M4 在契约里就区分它们）。
 *
 * 数据库用 `NULL` / `'none'` / 数字串承载它们
 * （见 `memory-store.ts` 的 `VALID_UNTIL_OPEN_SENTINEL` 说明）。
 * 这个类型是那个区分在**展示层**的对应物。
 */
export type ValidityState =
  /** 不知道它什么时候失效（或这个槽位不适用） */
  | 'unknown'
  /** 明确地"没有终点"：当前有效，且预期继续有效 */
  | 'open'
  /** 已失效于某个时刻 */
  | 'ended'

export interface ValidityView {
  state: ValidityState
  validFrom?: Timestamp
  validUntil?: Timestamp
  /** 人类可读（进 CLI 与审计报告） */
  label: string
}

export function describeValidity(record: MemoryRecord): ValidityView {
  const validFrom = record.validFrom
  const validUntil = record.validUntil

  if (validUntil === null) {
    return {
      state: 'open',
      ...(validFrom !== undefined ? { validFrom } : {}),
      label: `${fmt(validFrom)} → （当前有效）`,
    }
  }
  if (validUntil === undefined) {
    return {
      state: 'unknown',
      ...(validFrom !== undefined ? { validFrom } : {}),
      label: `${fmt(validFrom)} → （不知道何时失效）`,
    }
  }
  return {
    state: 'ended',
    ...(validFrom !== undefined ? { validFrom } : {}),
    validUntil,
    label: `${fmt(validFrom)} → ${fmt(validUntil)}`,
  }
}

// ---------------------------------------------------------------------------
// 时间线（计划书第 132 节的 Gate）
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  memoryId: string
  status: MemoryStatus
  /** 这条描述的事实的有效区间 */
  validity: ValidityView
  /** 这条记忆是系统什么时候记下的（计划书第 37 节：recordedAt） */
  recordedAt: Timestamp
  /** 内容摘要（Claim → 取值；Episode → 摘要） */
  content: string
  /** 它取代了哪些（MI-07） */
  supersedes?: string[]
  /** 它被谁取代 */
  supersededBy?: string
  /** 是否**当前**有效的那一条 */
  isCurrent: boolean
}

/**
 * 把同一槽位的全部记录整理成时间线。
 *
 * **纯函数**、不查库：调用方把 `listByCanonicalKey()` 的结果传进来。
 * 这样"时间线长什么样"可以在内存里穷举测试（各种状态组合）。
 *
 * 排序用 `recordedAt`（**不是** `validFrom`）：时间线回答的是
 * "她**依次**知道了什么"，而不是"事情按什么顺序发生"。
 * 两者在导入旧对话时会分家（计划书第 30 节的场景一），
 * 而那时人想知道的是前者 —— 后者由每条自己的 `validFrom` 表达。
 */
export function buildSlotTimeline(records: readonly MemoryRecord[]): TimelineEntry[] {
  const ordered = [...records].sort((a, b) => a.recordedAt - b.recordedAt)

  return ordered.map((record) => ({
    memoryId: String(record.id),
    status: record.status,
    validity: describeValidity(record),
    recordedAt: record.recordedAt,
    content: summarizeContent(record),
    ...(record.supersedes !== undefined && record.supersedes.length > 0
      ? { supersedes: record.supersedes.map(String) }
      : {}),
    ...(record.supersededBy !== undefined ? { supersededBy: String(record.supersededBy) } : {}),
    isCurrent: record.status === 'active',
  }))
}

/**
 * 渲染成 plan 第 132 节那种人类可读的形式。
 *
 * 输出形状刻意与计划书里的例子一致：
 *
 *     2026-09-01  喜欢咖啡            [superseded]
 *     2026-09-16  戒咖啡              [active] ← Current
 *     Current: 戒咖啡
 *
 * 最后那一行 `Current:` 是**必须**的：只有历史而没有"当前是哪个"
 * 会让读者自己去推断，而推断会出错（尤其在有 DISPUTED 的时候）。
 */
export function renderMemoryHistory(
  records: readonly MemoryRecord[],
  options: { title?: string } = {}
): string {
  const timeline = buildSlotTimeline(records)
  const lines: string[] = []

  if (options.title !== undefined) lines.push(options.title)

  if (timeline.length === 0) {
    lines.push('（这个槽位没有任何记忆）')
    return lines.join('\n')
  }

  const width = Math.max(...timeline.map((e) => fmtDate(e.recordedAt).length))
  for (const entry of timeline) {
    const when = fmtDate(entry.recordedAt).padEnd(width, ' ')
    const marker = entry.isCurrent ? '  ← Current' : ''
    lines.push(`${when}  ${entry.content}  [${entry.status}]${marker}`)
  }

  const current = timeline.filter((e) => e.isCurrent)
  const currentText =
    current.length === 0
      ? '（当前没有有效记忆 —— 全部被取代、撤回或存疑）'
      : current.map((e) => e.content).join(' / ')
  lines.push(`Current: ${currentText}`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 溯源（计划书第 157 节的展示半边）
// ---------------------------------------------------------------------------

export interface ProvenanceView {
  memoryId: string
  /** 这条记忆凭什么成立（证据） */
  sourceRefs: { kind: string; id: string }[]
  /** 哪些是**根**证据（计划书第 40 节） */
  evidenceRootIds: string[]
  /** 处理它的组件与版本（计划书第 66–67 节：能找出所有 @1 的产物） */
  processor?: string
  processorVersion?: string
  /** 它取代了谁、被谁取代（MI-07） */
  supersedes: string[]
  supersededBy?: string
}

export function describeProvenance(record: MemoryRecord): ProvenanceView {
  return {
    memoryId: String(record.id),
    sourceRefs: record.sourceRefs.map((ref) => ({ kind: ref.kind, id: ref.id })),
    evidenceRootIds: [...record.evidenceRootIds],
    ...(record.processor !== undefined ? { processor: record.processor } : {}),
    ...(record.processorVersion !== undefined
      ? { processorVersion: record.processorVersion }
      : {}),
    supersedes: (record.supersedes ?? []).map(String),
    ...(record.supersededBy !== undefined ? { supersededBy: String(record.supersededBy) } : {}),
  }
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function summarizeContent(record: MemoryRecord): string {
  if (isClaimContent(record.content)) {
    return `${record.content.predicate} = ${stringifyValue(record.content.value)}`
  }
  return record.content.summary
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function fmtDate(ts: Timestamp | undefined): string {
  if (ts === undefined) return '(未知时间)'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return `(非法时间戳 ${ts})`
  // 用本地日期（人看的是"哪天"），固定 ISO 形状便于跨平台比对
  return d.toISOString().slice(0, 10)
}

function fmt(ts: Timestamp | undefined): string {
  return ts === undefined ? '(未知)' : fmtDate(ts)
}
