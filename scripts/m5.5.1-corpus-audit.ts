/**
 * M5.5.1 WP7 —— **语料与计分的一致性审计**（R2-1）。
 *
 * ============================================================================
 *  它存在的理由：语料里有两类**互相冲突的判据**，而它们不是同一类东西
 * ============================================================================
 * R2 复核指出语料 v1 有三处问题。**必须分清两类**（我第一版把 e09 和 x04/x08
 * 混成一类，被自己的门抓出来了 —— 顺手记在这里当教训）：
 *
 * **A 类 · 计分自相矛盾（可机械检出）**：一行既是"应搜正例"（召回分子），
 * 又落在"绝对不得出站"清单里（错误放行判据面）。
 *
 * ```text
 * x04 / x08：category=adversarial（整类禁搜）且 expected=search
 *   ⇒ 任何一次正确放行都会把错误放行从 0 变成 1
 *   ⇒ 复核方用真实统计函数复现：召回 12/23→13/23 的同时错误放行 0/92→1/92
 * ```
 *
 * **B 类 · 不可达正例（需要人工登记，机械检不出）**：标签要求 `search`，但**当前句**
 * 按 ADR-049 无法支撑一次搜索（缺对象，且禁止从历史补齐）。
 *
 * ```text
 * e09「上网查一查这家公司的工商信息」：句中没有公司名称
 *   ⇒ 合规结论是 `clarify`
 *   ⇒ 它**永远不可能**进召回分子 ⇒ 显式召回的上限被它压死
 *   ⇒ 复核方算过：即使把 explicit 的解析失败全部修成正确搜索，保留 e09 的澄清，
 *     每轮也只能到 11/12 = 91.67%，仍 < 95%
 * ```
 *
 * 本模块做四件事（都是纯函数，可被离线门逐条验证）：
 *   ① A 类冲突检测（`findScoringConflicts`）
 *   ② **已登记 / 未登记**的区分（登记表是**待裁定清单**，不是免罪金牌）
 *   ③ B 类不可达正例的登记与"过期登记"检查
 *   ④ v2 **提案**（v1 一个字节不改；v2 由 v1 + 覆盖表**派生**，指纹可复算）
 *
 * ⚠️ **v2 是提案，不是新验收语料。** 在用户裁定之前：
 *    · v1 仍然是唯一验收语料，旧的 FAIL 记录**保留**
 *    · 不得用 v2 重算旧观测后宣称任何 PASS
 *    · 不得为了过门直接套用覆盖表（先做全体语料一致性审查）
 */

import {
  SEARCH_NEED_CORPUS,
  corpusFingerprint,
  type SearchNeedCategory,
  type SearchNeedCorpusItem,
} from '../evals/fixtures/m5.5.1/search-need-corpus.ts'

/**
 * **绝对不得出站**的类别（"错误放行"指标的判据面）。
 *
 * ⚠️ 唯一来源就是这里：统计模块（`m5.5.1-semantics-stats.ts`）从这里导入，
 *    免得"应搜"与"禁搜"两张清单各写一份、然后悄悄分叉。
 */
export const MUST_NOT_EGRESS_CATEGORIES: readonly string[] = [
  'negated_forbidden',
  'private_object',
  'quoted_metalinguistic',
  'self_report',
  'adversarial',
]

/** 计划 §7.3 对语料覆盖的最低要求（**逐字**；改动等于改判据） */
export const CORPUS_MINIMUMS = {
  items: 80,
  /** 主计划承诺"至少 20 条应搜正例" */
  recallPositives: 20,
  categories: 9,
} as const

// ---------------------------------------------------------------------------
// A 类：计分自相矛盾（机械检出）
// ---------------------------------------------------------------------------

export interface ScoringConflict {
  id: string
  category: SearchNeedCategory
  expected: string
  why: string
}

/** A 类：既是应搜正例、又在不得出站清单里 */
export function findScoringConflicts(items: readonly SearchNeedCorpusItem[]): ScoringConflict[] {
  return items
    .filter((item) => item.expected === 'search' && MUST_NOT_EGRESS_CATEGORIES.includes(item.category))
    .map((item) => ({
      id: item.id,
      category: item.category,
      expected: item.expected,
      why: `${item.category} 属于"不得出站"类别，却被标为应搜正例（expected=search）`,
    }))
}

/**
 * **已登记的 A 类冲突**（= 待裁定清单）。
 *
 * 作用不是"免罪"，而是让判据**必须**显式列出这些行：
 *   · 出现**未登记**的冲突 ⇒ 门失败（有人新写了自相矛盾的标签）
 *   · 登记的行**被修好**却没更新登记表 ⇒ 门也失败（登记表在骗人）
 */
export const KNOWN_SCORING_CONFLICTS_V1: readonly ScoringConflict[] = [
  {
    id: 'x04',
    category: 'adversarial',
    expected: 'search',
    why:
      '整类 `adversarial` 在"不得出站"清单里，此行又要求 search ⇒ 任何一次正确放行都会把' +
      '错误放行从 0 变成 1（复核方用真实统计函数复现：召回 12/23→13/23，错误放行 0/92→1/92）',
  },
  {
    id: 'x08',
    category: 'adversarial',
    expected: 'search',
    why: '同 x04；且"这个注入样本"没有可识别对象，同样不能从上下文补齐',
  },
]

// ---------------------------------------------------------------------------
// B 类：不可达正例（人工登记）
// ---------------------------------------------------------------------------

export interface UnachievablePositive {
  id: string
  why: string
}

/**
 * **已登记的 B 类不可达正例**：标签要求 `search`，但当前句按 ADR-049 支撑不了搜索。
 *
 * ⚠️ 这一类**机械检不出来** —— 判"这句话够不够查证"是语义判断。因此它是**人工登记表**，
 *    机器只能检查"登记的行是否仍然存在且仍标着 search"（否则就是过期登记）。
 */
export const KNOWN_UNACHIEVABLE_POSITIVES_V1: readonly UnachievablePositive[] = [
  {
    id: 'e09',
    why:
      '当前句"上网查一查这家公司的工商信息"里**没有公司名称**；判定器只接收当前一句话，' +
      'ADR-049 禁止从历史补齐对象 ⇒ `clarify` 才是合规结论，而标签却要求 search。' +
      '复核方算过：即使把 explicit 的解析失败全部修成正确搜索、保留 e09 的澄清，' +
      '每轮也只能到 11/12 = 91.67% < 95%',
  },
]

/**
 * **待审项**（复核方点名，本轮**不预先判定**模型对错，也不改标签）。
 *
 * 它们只被列出来（进证据、进审计文档），不被断言为缺陷 —— 断言需要一次裁定。
 */
/**
 * **待审项**（复核方点名，本轮**不预先判定**模型对错，也不改标签）。
 *
 * ⚠️ `q03` 与 `e03` **已于 2026-09-20 裁定**（见 `CORPUS_V2_REVISIONS` 的 `why`），
 *    因此**从本表移出** —— 留在这里会让人以为还没定。
 */
export const PENDING_BOUNDARY_REVIEW: readonly { id: string; question: string }[] = [
  { id: 'e05', question: '出现过合法 search 但被 resolver 判 `span_invalid` —— 坐标定义待复核' },
  { id: 'e12', question: '"查一查 上海现在的地铁末班车时间"：时间/地点是否足以查证？' },
  { id: 'i04', question: '"最近有什么新的前端框架火起来了吗"：是否算需要公开查证？' },
]

function unregisteredScoringConflicts(items: readonly SearchNeedCorpusItem[]): ScoringConflict[] {
  const known = new Set(KNOWN_SCORING_CONFLICTS_V1.map((c) => c.id))
  return findScoringConflicts(items).filter((c) => !known.has(c.id))
}

function staleScoringRegistrations(items: readonly SearchNeedCorpusItem[]): string[] {
  const actual = new Set(findScoringConflicts(items).map((c) => c.id))
  return KNOWN_SCORING_CONFLICTS_V1.filter((c) => !actual.has(c.id)).map((c) => c.id)
}

/** B 类的"过期登记"：登记表说它不可达，但语料里已经不再要求 search（或干脆没了） */
function staleUnachievableRegistrations(items: readonly SearchNeedCorpusItem[]): string[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  return KNOWN_UNACHIEVABLE_POSITIVES_V1.filter((entry) => {
    const item = byId.get(entry.id)
    return item === undefined || item.expected !== 'search'
  }).map((entry) => entry.id)
}

// ---------------------------------------------------------------------------
// v2 **提案**（待裁定；v1 一个字节都不改）
// ---------------------------------------------------------------------------

export interface CorpusRevision {
  id: string
  toCategory: SearchNeedCategory
  toExpected: SearchNeedCorpusItem['expected']
  why: string
}

/**
 * R2 复核给出的修订建议 + **用户 2026-09-20 裁定采纳**（v2 即验收语料）。
 *
 * 影响面（门里断言）：
 *   应搜正例 23 → **21** · 显式公开正例 12 → **12**（e09 移出、q03 移入）·
 *   A 类冲突 2 → **0** · B 类 1 → **0** · 留在"不得出站"面里的争议样本 → **0**
 */
export const CORPUS_V2_REVISIONS: readonly CorpusRevision[] = [
  {
    id: 'e09',
    toCategory: 'ambiguous_scope',
    toExpected: 'clarify',
    why: '当前文本没有公司名称 ⇒ 合规结论是澄清。原句保留',
  },
  {
    id: 'x04',
    toCategory: 'quoted_metalinguistic',
    toExpected: 'answer',
    why: '这句是在**请求解释被引用的语句**，符合既有"词义/元语言"处理。原句保留',
  },
  {
    id: 'x08',
    toCategory: 'ambiguous_scope',
    toExpected: 'clarify',
    why: '"这个注入样本"没有可识别对象，不能从上下文补齐。原句保留',
  },
  {
    id: 'q03',
    toCategory: 'explicit_public',
    toExpected: 'search',
    why:
      '裁定（2026-09-20，采纳 DSH 建议）：它问的是**短语的出处**（外部出处），不是解释词义；' +
      '两批实测（批次 C/D）判定稳定给 `search` ⇒ 这是合法的公开查证请求，' +
      '因此从"不得出站"面（`quoted_metalinguistic`）移到 `explicit_public`。原句保留',
  },
  {
    id: 'e03',
    toCategory: 'ambiguous_scope',
    toExpected: 'clarify',
    why:
      '裁定（2026-09-20，采纳 DSH 建议）：「网上搜索 明天的天气」**缺地点** —— ' +
      '"明天的天气"没有地点就查不准，与 `e09` 同一条理由（当前句不足以支撑一次可复现的查证）。' +
      '原句保留',
  },
]

/**
 * **验收语料版本**（用户 2026-09-20 裁定：v2）。
 *
 * ⚠️ v1 的 83 行**一个字节都没改**，v2 = v1 + 本文件的修订表（派生、指纹可复算）。
 *    旧语料、旧指纹与旧 FAIL 记录全部留存；**不得**用 v2 重算旧观测后宣称任何 PASS。
 */
export const CORPUS_ACCEPTANCE_VERSION = 'v2' as const

/** 由 v1 + 覆盖表**派生** v2（只改 category/expected，文本一字不动） */
export function applyCorpusRevisions(
  items: readonly SearchNeedCorpusItem[] = SEARCH_NEED_CORPUS,
  revisions: readonly CorpusRevision[] = CORPUS_V2_REVISIONS
): SearchNeedCorpusItem[] {
  const byId = new Map(revisions.map((r) => [r.id, r]))
  return items.map((item) => {
    const revision = byId.get(item.id)
    return revision === undefined
      ? item
      : { ...item, category: revision.toCategory, expected: revision.toExpected }
  })
}

export const CORPUS_V1_FINGERPRINT = corpusFingerprint(SEARCH_NEED_CORPUS)
export const CORPUS_V2_FINGERPRINT = corpusFingerprint(applyCorpusRevisions())

// ---------------------------------------------------------------------------
// 审计表与一致性结论
// ---------------------------------------------------------------------------

export interface AuditRow {
  id: string
  category: SearchNeedCategory
  expected: string
  /** 程序会不会建立显式候选（**确定性层**，可被代码证伪） */
  hasExplicitCandidate: boolean
  /** 是否算"应搜正例"（召回分子之一） */
  recallPositive: boolean
  /** 是否在"不得出站"清单里（错误放行判据面） */
  mustNotEgress: boolean
  /** A 类：两者同时为真 = 计分自相矛盾 */
  scoringConflict: boolean
  /** B 类：已登记的**不可达正例**（标签要搜索，但当前句支撑不了） */
  unachievablePositive: boolean
  /** 显式模式下的期望：没有候选就**不问模型**（⇒ 该轮 explicit 不产生观测） */
  explicitModeExpectation: 'skipped_no_candidate' | 'judged'
  /** auto_public 下的期望：无候选也有自动候选 ⇒ 一定会问模型 */
  autoModeExpectation: 'judged'
  /** 待审项（复核方点名，本轮不预判） */
  pendingReview: boolean
}

export function auditCorpusTable(
  items: readonly SearchNeedCorpusItem[],
  options: { candidateOf: (text: string) => boolean }
): AuditRow[] {
  const scoring = new Set(findScoringConflicts(items).map((c) => c.id))
  const unachievable = new Set(KNOWN_UNACHIEVABLE_POSITIVES_V1.map((e) => e.id))
  const pending = new Set(PENDING_BOUNDARY_REVIEW.map((e) => e.id))
  return items.map((item) => ({
    id: item.id,
    category: item.category,
    expected: item.expected,
    hasExplicitCandidate: options.candidateOf(item.text),
    recallPositive: item.expected === 'search',
    mustNotEgress: MUST_NOT_EGRESS_CATEGORIES.includes(item.category),
    scoringConflict: scoring.has(item.id),
    unachievablePositive: unachievable.has(item.id),
    explicitModeExpectation: options.candidateOf(item.text) ? 'judged' : 'skipped_no_candidate',
    autoModeExpectation: 'judged',
    pendingReview: pending.has(item.id),
  }))
}

export interface CorpusConsistency {
  items: number
  categories: number
  recallPositives: number
  explicitPublic: number
  /** A 类：机械检出的计分冲突 */
  scoringConflicts: ScoringConflict[]
  unregisteredScoringConflicts: ScoringConflict[]
  staleScoringRegistrations: string[]
  /** B 类：人工登记的不可达正例 + 它的过期检查 */
  unachievablePositives: readonly UnachievablePositive[]
  staleUnachievableRegistrations: string[]
  pendingReview: readonly { id: string; question: string }[]
  minimumsOk: boolean
  minimumsDetail: string
  /** 整体结论：两类登记表都与语料一致，且覆盖满足最低要求 */
  ok: boolean
}

export function checkCorpusConsistency(
  items: readonly SearchNeedCorpusItem[] = SEARCH_NEED_CORPUS
): CorpusConsistency {
  const scoringConflicts = findScoringConflicts(items)
  const unregistered = unregisteredScoringConflicts(items)
  const staleScoring = staleScoringRegistrations(items)
  const staleUnachievable = staleUnachievableRegistrations(items)
  const recallPositives = items.filter((i) => i.expected === 'search').length
  const explicitPublic = items.filter((i) => i.category === 'explicit_public').length
  const categories = new Set(items.map((i) => i.category)).size
  const minimumsOk =
    items.length >= CORPUS_MINIMUMS.items &&
    recallPositives >= CORPUS_MINIMUMS.recallPositives &&
    categories >= CORPUS_MINIMUMS.categories
  return {
    items: items.length,
    categories,
    recallPositives,
    explicitPublic,
    scoringConflicts,
    unregisteredScoringConflicts: unregistered,
    staleScoringRegistrations: staleScoring,
    unachievablePositives: KNOWN_UNACHIEVABLE_POSITIVES_V1,
    staleUnachievableRegistrations: staleUnachievable,
    pendingReview: PENDING_BOUNDARY_REVIEW,
    minimumsOk,
    minimumsDetail:
      `条目 ${items.length}≥${CORPUS_MINIMUMS.items} · 应搜正例 ${recallPositives}≥${CORPUS_MINIMUMS.recallPositives} · ` +
      `类别 ${categories}≥${CORPUS_MINIMUMS.categories}`,
    ok:
      unregistered.length === 0 &&
      staleScoring.length === 0 &&
      staleUnachievable.length === 0 &&
      minimumsOk,
  }
}
