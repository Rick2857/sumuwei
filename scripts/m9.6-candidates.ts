/**
 * M9.6 WP2 —— **有界候选片段生成与 span 还原**（计划 §5 / 契约 §6.1）。
 *
 * ============================================================================
 *  它为什么必须存在
 * ============================================================================
 * ```text
 * 现行情绪契约要求 `target` + 最多 3 个 `family + span`，搜索在 search 时要求合法 `querySpan`。
 * **Jev 返回分类 ≠ 能填满这些契约** —— 它不能凭空猜字符位置。
 * ⇒ 唯一允许的方案（计划 §5 逐字）：
 *     ① 程序从**当前消息**生成**有界**候选片段（各带自己的 UTF-16 `[start,end)`）
 *     ② Jev 只回答**候选 ID**
 *     ③ 程序按 ID **还原**原文位置
 * ```
 *
 * **明令禁止**（计划 §5 逐字，本文件一条都不做）：
 * ```text
 * · 用金标生成候选         · 默认整条消息为证据
 * · 让 Jev 凭空猜字符位置  · 截断候选文本（截断会制造原文里不存在的 span）
 * ```
 * ⇒ 超出上限的做法是"**不纳入候选表**"并**记录被丢弃的数量**，不是把文本砍短。
 */

import { isValidAffectSemanticSpan } from '../src/kernel/contracts/affect-semantic.ts'

/** 候选个数上限（契约 §6.1 冻结值） */
export const MAX_CANDIDATES = 12
/** 候选文本总长上限（UTF-16 单元；契约 §6.1 冻结值） */
export const MAX_CANDIDATE_UNITS = 512
/** 窗口最小长度：短于此不值当一个候选 */
export const MIN_WINDOW_UNITS = 4
/** 窗口最大长度 */
export const MAX_WINDOW_UNITS = 24
/** 句读符（契约 §6.1 冻结的切分集合） */
export const SENTENCE_TERMINATORS = ['。', '！', '？', '；', '\n', '!', '?'] as const

/** 显式的"没有/不确定"选项 id —— 与真实候选 id 永不冲突 */
export const NO_CANDIDATE_OPTION = '__none__'

/**
 * 候选**策略**版本（dev 阶段允许最多两轮候选策略修订；两轮都必须可复现）。
 *
 * ```text
 * v1 = 整句 → 按**长度升序**的滑窗
 *      实测缺陷（WP4 试点第 1 轮）：长度升序会把 12 个名额先花在 4 字窗口上，
 *      于是**更长的金标区间根本进不了候选表** ⇒ 覆盖率为 0 ⇒ span 精确率被结构性地钉死在 0。
 *      **那不是模型答错，是候选表没给出那个选项。**
 *
 * v2 = 整句 → 句/小句边界 → **以边界为锚的尾窗与首窗**（长度由长到短）→ 其余滑窗（长度由长到短）
 *      依据：检索对象通常是请求里**靠后的那个宾语**（"帮我查一下`明天北京的天气`"），
 *      所以"以句尾/小句尾为终点、由长到短的窗口"是一个有理由的候选族；
 *      同时保留首窗族以覆盖"对象在前"的句式。
 * ```
 */
export type CandidateStrategy = 'v1-length-asc' | 'v2-boundary-anchored'

export const DEFAULT_CANDIDATE_STRATEGY: CandidateStrategy = 'v2-boundary-anchored'

export interface CandidateSpan {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface CandidateSet {
  readonly candidates: readonly CandidateSpan[]
  /** 因**个数上限**被丢弃的量（必须记录，不许静默） */
  readonly droppedByCap: number
  /** 因**文本总长预算**被丢弃的量（必须记录） */
  readonly droppedByBudget: number
  /**
   * ★ 因**span 非法**（越界，或切在一对 surrogate 中间）被丢弃的量。
   * ⚠️ 生成器**不得**产出非法 span —— 让一个拆开 emoji 的候选进表，
   *    下游还原时才发现，等于把量具缺陷伪装成模型答错。
   */
  readonly droppedUnsafeSpan: number
  readonly reason: 'ok' | 'no_candidate'
}

interface Sentence {
  readonly start: number
  readonly end: number
}

function splitSentences(message: string): Sentence[] {
  const out: Sentence[] = []
  let start = 0
  for (let index = 0; index < message.length; index += 1) {
    if ((SENTENCE_TERMINATORS as readonly string[]).includes(message[index] as string)) {
      out.push({ start, end: index + 1 })
      start = index + 1
    }
  }
  if (start < message.length) out.push({ start, end: message.length })
  return out.filter((sentence) => message.slice(sentence.start, sentence.end).trim() !== '')
}

/** 小句边界（顿号/逗号/分号/括号/破折号）——**只在这些位置**切，不切字 */
const CLAUSE_DELIMITERS = ['，', '、', ',', '；', ';', '（', '）', '(', ')', '——', '：', ':'] as const

function splitClauses(message: string): Sentence[] {
  const out: Sentence[] = []
  let start = 0
  for (let index = 0; index < message.length; index += 1) {
    const char = message[index] as string
    if ((CLAUSE_DELIMITERS as readonly string[]).includes(char)) {
      if (index + 1 > start) out.push({ start, end: index + 1 })
      start = index + 1
    }
  }
  if (start < message.length) out.push({ start, end: message.length })
  return out.filter((clause) => message.slice(clause.start, clause.end).trim() !== '')
}

/** v2 的候选顺序（**长度由长到短**地铺满，而不是先花在短窗口上） */
function orderedSpansV2(message: string): { start: number; end: number }[] {
  const ordered: { start: number; end: number }[] = []
  const length = message.length

  /* ① 整条消息 */
  if (length >= MIN_WINDOW_UNITS) ordered.push({ start: 0, end: Math.min(length, MAX_WINDOW_UNITS) })
  /* ② 句 / ③ 小句边界 */
  for (const boundary of [...splitSentences(message), ...splitClauses(message)]) {
    if (boundary.end - boundary.start >= MIN_WINDOW_UNITS) {
      ordered.push({ start: boundary.start, end: Math.min(boundary.end, boundary.start + MAX_WINDOW_UNITS) })
    }
  }

  /*
   * ④ 以每个边界为锚的**尾窗**（终点在边界上，起点由近及远）与**首窗**（起点在边界上，终点由远及近）。
   *    长度由长到短：这样 12 个名额先给"更长、更完整的宾语"。
   */
  const anchors = new Set<number>([0, length])
  for (const boundary of [...splitSentences(message), ...splitClauses(message)]) {
    anchors.add(boundary.start)
    anchors.add(boundary.end)
  }
  for (let window = MAX_WINDOW_UNITS; window >= MIN_WINDOW_UNITS; window -= 1) {
    for (const anchor of [...anchors].sort((a, b) => a - b)) {
      /* 尾窗：[anchor-window, anchor) */
      if (anchor - window >= 0) ordered.push({ start: anchor - window, end: anchor })
      /* 首窗：[anchor, anchor+window) */
      if (anchor + window <= length) ordered.push({ start: anchor, end: anchor + window })
    }
  }

  /* ⑤ 其余滑窗（兜底；长度仍由长到短） */
  for (let window = MAX_WINDOW_UNITS; window >= MIN_WINDOW_UNITS; window -= 1) {
    for (let start = 0; start + window <= length; start += 1) ordered.push({ start, end: start + window })
  }
  return ordered
}

/** v1 的候选顺序（保留以便第 1 轮可复现） */
function orderedSpansV1(message: string): { start: number; end: number }[] {
  const ordered: { start: number; end: number }[] = []
  for (const sentence of splitSentences(message)) {
    const sentenceLength = sentence.end - sentence.start
    if (sentenceLength < MIN_WINDOW_UNITS) continue
    ordered.push({ start: sentence.start, end: sentence.start + Math.min(sentenceLength, MAX_WINDOW_UNITS) })
  }
  for (const sentence of splitSentences(message)) {
    const sentenceLength = sentence.end - sentence.start
    for (let window = MIN_WINDOW_UNITS; window <= Math.min(MAX_WINDOW_UNITS, sentenceLength); window += 1) {
      for (let start = sentence.start; start + window <= sentence.end; start += 1) ordered.push({ start, end: start + window })
    }
  }
  return ordered
}

/**
 * 有界、确定性（无随机、无时钟）的候选生成。
 *
 * 顺序：**先整句**（对 `target`/`querySpan` 最有信息量），再按 `MIN..MAX` 长度的滑窗。
 * 去重按 `(start,end)`；空白窗口丢弃。
 */
export function buildCandidates(
  message: string,
  options: {
    readonly maxCandidates?: number
    readonly maxUnits?: number
    readonly strategy?: CandidateStrategy
  } = {}
): CandidateSet {
  const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES
  const maxUnits = options.maxUnits ?? MAX_CANDIDATE_UNITS
  const strategy = options.strategy ?? DEFAULT_CANDIDATE_STRATEGY

  const raw = strategy === 'v1-length-asc' ? orderedSpansV1(message) : orderedSpansV2(message)

  const seen = new Set<string>()
  const candidates: CandidateSpan[] = []
  let droppedByCap = 0
  let droppedByBudget = 0
  let droppedUnsafeSpan = 0
  let usedUnits = 0
  for (const span of raw) {
    const key = `${String(span.start)}:${String(span.end)}`
    if (seen.has(key)) continue
    seen.add(key)
    /*
     * ★ 先用**冻结契约**的 span 校验器筛一遍：越界、空区间、**拆开 surrogate** 的窗口
     *   根本不许进候选表。含 emoji 的消息上会出现这种窗口（非 BMP 字符占 2 个单元），
     *   把筛除量记进 `droppedUnsafeSpan`，不静默。
     */
    if (!isValidAffectSemanticSpan({ start: span.start, end: span.end }, message)) {
      droppedUnsafeSpan += 1
      continue
    }
    const text = message.slice(span.start, span.end)
    if (text.trim() === '') continue
    if (candidates.length >= maxCandidates) {
      droppedByCap += 1
      continue
    }
    if (usedUnits + text.length > maxUnits) {
      droppedByBudget += 1
      continue
    }
    usedUnits += text.length
    candidates.push({ id: `C${String(candidates.length)}`, start: span.start, end: span.end, text })
  }

  return {
    candidates,
    droppedByCap,
    droppedByBudget,
    droppedUnsafeSpan,
    reason: candidates.length === 0 ? 'no_candidate' : 'ok',
  }
}

/**
 * ★ 候选 ID → 原文 span。**Jev 只回答 ID，位置由程序给**。
 * 复用**冻结契约**的 span 校验器（UTF-16 半开区间 + 不拆 surrogate），不另写一份判据。
 */
export function candidateIdToSpan(
  candidateId: string,
  set: CandidateSet,
  message: string
): { readonly ok: true; readonly span: { readonly start: number; readonly end: number } } | { readonly ok: false; readonly code: 'not_a_candidate' | 'span_invalid' | 'no_candidate' } {
  if (set.reason === 'no_candidate') return { ok: false, code: 'no_candidate' }
  const found = set.candidates.find((candidate) => candidate.id === candidateId)
  if (found === undefined) return { ok: false, code: 'not_a_candidate' }
  const span = { start: found.start, end: found.end }
  if (!isValidAffectSemanticSpan(span, message)) return { ok: false, code: 'span_invalid' }
  return { ok: true, span }
}

/**
 * Choice 的 `criteria`：候选 id → 候选原文，外加一个**显式**的"没有/不确定"选项。
 * ⚠️ 官方允许 `criteria` 的值为 `null`；这里给"没有"选项一个 `null` 描述，
 *    这样模型不会因为缺少该选项而被逼着选一个存在的候选。
 */
export function buildCandidateCriteria(set: CandidateSet): Record<string, string | null> {
  const criteria: Record<string, string | null> = {}
  for (const candidate of set.candidates) criteria[candidate.id] = candidate.text
  criteria[NO_CANDIDATE_OPTION] = null
  return criteria
}
