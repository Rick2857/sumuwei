/**
 * Belief 上下文渲染器（M9 WP7 / ADR-070 §7 · D17；计划 §9.1–§9.3）。
 *
 * ============================================================================
 *  它是什么：`belief` section 的**纯函数**内容生成器
 * ============================================================================
 * 与 `renderAffectGuidance` 同一条纪律：契约层只做确定性渲染，
 * 数据由装配层（adapters）从投影 + 资格回查准备好传进来；
 * 排序（priority 50）、预算裁剪、trace 由 ContextCompiler / 网关统一管。
 *
 * 冻结值（ADR-070 D17，先冻后测）：
 *   · 每轮 ≤ `BELIEF_CONTEXT_MAX_ITEMS`(4) 条（disputed 两侧算**一**条原子组）；
 *   · 合计 ≤ `BELIEF_CONTEXT_TOKEN_BUDGET`(400) token（由既有 quantifier 计算，
 *     含标题行与限制行——"合计"指整个 section）；
 *   · 零预算 / 零候选 ⇒ 不产 section（调用方拿到 undefined）。
 *
 * 原子条目（§9.1）：命题 + 当前状态 + 来源类别 + 限制**整组进出**；
 * 空间不足整组裁掉——绝不裁掉"暂定"却留下命题正文。
 *
 * Memory 去重（§9.3）：**选择层**去重，不造全文语义合并器。
 * 本轮记忆已载入同根陈述时，reported 条目只渲染**认知限定**（资格 + 状态 +
 * 限制），正文由 Memory 权威承载；inferred 不参与去重（推断内容与记忆正文
 * 是两回事，限定行会丢掉推断本身）。
 *
 * ⚠️ 模型可见文本里**没有**内部数值、数据库 id、调试信息（§9.2）；
 *    belief id 只进 section 的 `sourceRefs`（trace 面）。
 */
import {
  BELIEF_INFERRED_PREDICATE,
  BELIEF_INFERRED_SCOPE,
  beliefReportedScopeKeyOf,
  type BeliefState,
} from './belief.ts'

// ---------------------------------------------------------------------------
// 冻结常量（D17）
// ---------------------------------------------------------------------------

/** 每轮最多条目数（disputed 两侧 = 1 条原子组） */
export const BELIEF_CONTEXT_MAX_ITEMS = 4 as const

/** section 合计 token 预算（含标题与限制行；由注入的 quantifier 计算） */
export const BELIEF_CONTEXT_TOKEN_BUDGET = 400 as const
export function isEblReplacedInference(belief: BeliefState): boolean {
  return belief.epistemicKind === 'inferred' && belief.proposition.predicate === BELIEF_INFERRED_PREDICATE
    && belief.proposition.scopeKey === BELIEF_INFERRED_SCOPE
}

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

/** 渲染器输入：一条**已通过资格回查**的信念（active 或 disputed） */
export interface BeliefContextCandidate {
  belief: BeliefState
  /**
   * 本轮 Memory 已载入的证据根（去重判据：reported 条目的全部根 ⊆ 该集合
   * ⇒ 只渲染认知限定行）。装配层从本轮召回选中的 Memory sourceRefs 汇出。
   */
  memoryCoveredRootIds?: readonly string[]
}

export interface BeliefContextRenderInput {
  /** 候选（调用方已做资格回查 + 同轮遮蔽；渲染器只做相关性/去重/预算） */
  candidates: readonly BeliefContextCandidate[]
  /**
   * 主体相关性过滤（§9.1 "subject/主题相关后才入选"）。
   * v1 唯一主体 = active user；不匹配的候选**不进** section。
   */
  subject: { kind: string; id: string }
  /** token 量化器（与 ContextCompiler 同一注入纪律） */
  quantifier: (text: string) => number
  /** 覆盖预算（缺省 = D17 冻结值 400；≤0 = 不产 section） */
  tokenBudget?: number
  /** EBL takeover is explicit; absent preserves the frozen M9 renderer. */
  epistemic?: {
    currentOverride: boolean
    technicalContext: boolean
    candidate?: { claimId: string; subjectId: string; value: 'concise' | 'detailed' }
  }
}

export interface BeliefContextRenderResult {
  /** section 正文（标题 + 分列条目 + 限制行） */
  text: string
  /** 进 trace 的 sourceRefs = 实际入模的 belief id（不含被裁条目） */
  sourceRefs: string[]
  /** 实际入模的 belief id（§10.2：必须来自最终结果，被裁的不许标已使用） */
  usedBeliefIds: string[]
  /** 被预算裁掉的 belief id（审计面：候选了但没进） */
  droppedBeliefIds: string[]
  /** 入模条目数（disputed 组算 1） */
  itemCount: number
}

// ---------------------------------------------------------------------------
// 措辞（冻结词形；byte/结构基线的对象就是它们）
// ---------------------------------------------------------------------------

const HEADER_LINE = '【当前可用判断；内部参考，来源强度不等于客观真值】'
const REPORTED_COLUMN = '明确陈述：'
const INFERRED_COLUMN = '暂定推断：'
const LIMIT_LINE = '限制：这是互动推断与明确陈述的当前采信面；新更正优先；推断不得说成"你说过"；来源强度不等于客观真值。'

/** v1 推断槽位的冻结词形（扩槽位 = 新映射 + 新基线，不许运行期拼凑） */
const INFERRED_PHRASES: Record<string, string> = {
  [`${BELIEF_INFERRED_PREDICATE}|detailed`]: '在技术讲解这一范围，对方可能更需要步骤展开',
  [`${BELIEF_INFERRED_PREDICATE}|concise`]: '在技术讲解这一范围，对方可能更需要简短结论',
}

function valuePhrase(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value !== null && typeof value === 'object' && 'id' in value) {
    return `${String((value as { kind?: unknown }).kind)}:${String((value as { id: unknown }).id)}`
  }
  return String(value)
}

/** reported 命题的通用词形（Memory 才是正文权威；这里只给可读的最小命题） */
function reportedPhrase(belief: BeliefState): string {
  return `关于 ${belief.proposition.scopeKey}：${belief.proposition.predicate} 为 ${valuePhrase(belief.proposition.value)}`
}

function inferredPhrase(belief: BeliefState): string {
  const key = `${String(belief.proposition.predicate)}|${valuePhrase(belief.proposition.value)}`
  const phrase = INFERRED_PHRASES[key]
  if (phrase !== undefined) return phrase
  // 未登记槽位：如实降档为最小命题（不猜词形——猜错比朴素更糟）
  return `关于 ${belief.proposition.scopeKey}：${belief.proposition.predicate} 为 ${valuePhrase(belief.proposition.value)}`
}

// ---------------------------------------------------------------------------
// 原子条目
// ---------------------------------------------------------------------------

interface RenderedItem {
  /** 条目正文（含前缀「· 」；disputed 组两侧 + 不确定标签在同一行） */
  line: string
  /** 该条目覆盖的 belief id（disputed 组 = 两个） */
  beliefIds: string[]
  /** 归属分列（reported / inferred 按主信念归类） */
  column: 'reported' | 'inferred'
  /** 去重降档：只渲染了认知限定行（Memory 承载正文） */
  qualifierOnly: boolean
}

function renderItem(
  belief: BeliefState,
  disputedMate: BeliefState | undefined,
  memoryCoveredRoots: ReadonlySet<string>,
): RenderedItem {
  const id = String(belief.beliefId)
  if (disputedMate !== undefined) {
    // §9.1：disputed 两侧与"不确定"标签**原子**呈现（一行 = 一个不可分组）
    return {
      line:
        `· 有争议：${inferredOrReportedPhrase(belief)} ↔ ${inferredOrReportedPhrase(disputedMate)}` +
        '（两侧并存，不确定；以新更正为准）',
      beliefIds: [id, String(disputedMate.beliefId)],
      column: belief.epistemicKind,
      qualifierOnly: false,
    }
  }
  // §9.3 去重：reported 且全部根已被本轮 Memory 载入 ⇒ 只给认知限定
  const roots = (belief.evidenceRootIds ?? []).map(String)
  const covered =
    belief.epistemicKind === 'reported' &&
    roots.length > 0 &&
    roots.every((r) => memoryCoveredRoots.has(r))
  if (covered) {
    return {
      line: '· 认知限定（正文见本轮记忆）：用户明确陈述；当前仍有效；新更正优先',
      beliefIds: [id],
      column: 'reported',
      qualifierOnly: true,
    }
  }
  if (belief.epistemicKind === 'reported') {
    return {
      line: `· ${reportedPhrase(belief)}（用户明确陈述；当前仍有效）`,
      beliefIds: [id],
      column: 'reported',
      qualifierOnly: false,
    }
  }
  return {
    line: `· ${inferredPhrase(belief)}（互动推断；暂定，不是用户明确承诺）`,
    beliefIds: [id],
    column: 'inferred',
    qualifierOnly: false,
  }
}

function inferredOrReportedPhrase(belief: BeliefState): string {
  return belief.epistemicKind === 'reported' ? reportedPhrase(belief) : inferredPhrase(belief)
}

// ---------------------------------------------------------------------------
// 主渲染
// ---------------------------------------------------------------------------

/**
 * 渲染 belief section 内容。
 *
 * 返回 `undefined` = 不产 section（零候选 / 预算 ≤0 / 一条都放不下）。
 * 确定性：同输入同输出——排序键全部来自数据（kind → 槽位 → beliefId），
 * 无挂钟、无随机。
 */
export function renderBeliefSection(
  input: BeliefContextRenderInput,
): BeliefContextRenderResult | undefined {
  const budget = input.tokenBudget ?? BELIEF_CONTEXT_TOKEN_BUDGET
  if (budget <= 0) return undefined

  // ---- ① 相关性过滤（subject 不匹配 = 不入选）---------------------------
  let relevant = input.candidates.filter(
    (c) =>
      String(c.belief.subject.kind) === String(input.subject.kind) &&
      String(c.belief.subject.id) === String(input.subject.id),
  )
  const technicalScope = beliefReportedScopeKeyOf({ context: 'technical' })
  const styleReport = (belief: BeliefState) => belief.epistemicKind === 'reported'
    && belief.proposition.predicate === 'preferred.explanation.style'
    && ['general', technicalScope].includes(belief.proposition.scopeKey)
  if (input.epistemic) {
    const scoped = input.epistemic.technicalContext && relevant.some(({ belief }) => styleReport(belief) && belief.proposition.scopeKey === technicalScope)
    relevant = relevant.filter(({ belief }) => !isEblReplacedInference(belief)
      && !(styleReport(belief) && (input.epistemic!.currentOverride || (scoped && belief.proposition.scopeKey === 'general'))))
    if (!input.epistemic.technicalContext) relevant = relevant.filter(({ belief }) => !(styleReport(belief) && belief.proposition.scopeKey === technicalScope))
  }
  const epistemic = input.epistemic?.candidate
  const includeEpistemic = epistemic && input.epistemic?.technicalContext && !input.epistemic.currentOverride && input.subject.kind === 'user'
    && epistemic.subjectId === input.subject.id && !relevant.some(({ belief }) => styleReport(belief))
  if (relevant.length === 0 && !includeEpistemic) return undefined

  // ---- ② 槽位分组：active + 同槽 disputed 配对成原子组 -------------------
  // 槽位键 = predicate|scopeKey（**不含 value**——disputed 两侧正是同槽不同值：
  // 旧值被新值争议；含 value 会让两侧永远配不上对）。主体已由①过滤。
  const bySlot = new Map<string, BeliefState[]>()
  for (const c of relevant) {
    const b = c.belief
    const slot = `${String(b.proposition.predicate)}|${String(b.proposition.scopeKey)}`
    const list = bySlot.get(slot) ?? []
    list.push(b)
    bySlot.set(slot, list)
  }
  // disputed 配对：同槽内 active 为主、disputed 为侧（其余状态不进上下文）
  const items: RenderedItem[] = []
  const coveredRoots = new Set<string>()
  for (const c of relevant) {
    for (const r of c.memoryCoveredRootIds ?? []) coveredRoots.add(String(r))
  }
  // 确定性排序：reported 先于 inferred，槽位字典序
  const slotOrder = [...bySlot.keys()].sort()
  for (const slot of slotOrder) {
    const group = bySlot.get(slot) ?? []
    const active = group.find((b) => b.status === 'active')
    const disputed = group.find((b) => b.status === 'disputed')
    if (active === undefined) continue
    items.push(renderItem(active, disputed, coveredRoots))
  }
  if (includeEpistemic) items.push({
    line: `· 在技术讲解这一范围，对方可能更需要${epistemic.value === 'concise' ? '简短结论' : '步骤展开'}（经独立后续反馈检验的推断；有范围，新明确说明优先）`,
    beliefIds: [epistemic.claimId], column: 'inferred', qualifierOnly: false,
  })
  if (items.length === 0) return undefined

  // ---- ③ 条目上限（≤4 组）----------------------------------------------
  const capped = items.slice(0, BELIEF_CONTEXT_MAX_ITEMS)
  const overflow = items.slice(BELIEF_CONTEXT_MAX_ITEMS)

  // ---- ④ 预算（整组进出；标题/限制行计入合计）---------------------------
  const usedBeliefIds: string[] = []
  const droppedBeliefIds: string[] = []
  const reportedLines: string[] = []
  const inferredLines: string[] = []
  let used = 0

  const headerCost = input.quantifier(HEADER_LINE)
  const limitCost = input.quantifier(LIMIT_LINE)
  // 标题 + 限制行都放不下 ⇒ 一条都不进（零预算语义）
  if (headerCost + limitCost > budget) return undefined
  used += headerCost + limitCost

  let fitAny = false
  for (const item of capped) {
    const cost = input.quantifier(item.line)
    if (used + cost > budget) {
      for (const id of item.beliefIds) droppedBeliefIds.push(id)
      continue
    }
    used += cost
    fitAny = true
    usedBeliefIds.push(...item.beliefIds)
    if (item.column === 'reported') reportedLines.push(item.line)
    else inferredLines.push(item.line)
  }
  for (const item of overflow) {
    for (const id of item.beliefIds) droppedBeliefIds.push(id)
  }
  if (!fitAny) return undefined

  // ---- ⑤ 拼装（分列顺序冻结：明确陈述在前，暂定推断在后）----------------
  const parts: string[] = [HEADER_LINE]
  if (reportedLines.length > 0) {
    parts.push(REPORTED_COLUMN)
    parts.push(...reportedLines)
  }
  if (inferredLines.length > 0) {
    parts.push(INFERRED_COLUMN)
    parts.push(...inferredLines)
  }
  parts.push(LIMIT_LINE)

  return {
    text: parts.join('\n'),
    sourceRefs: [...usedBeliefIds],
    usedBeliefIds,
    droppedBeliefIds,
    itemCount: usedBeliefIds.length > 0 ? reportedLines.length + inferredLines.length : 0,
  }
}
