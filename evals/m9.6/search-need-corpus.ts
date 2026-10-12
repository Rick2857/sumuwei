/**
 * M9.6 WP4（试点）—— **搜索需求判定 dev 语料（100 条合成中文案例）**。
 *
 * ============================================================================
 *  它是怎么来的、以及它**不是**什么
 * ============================================================================
 * ```text
 * · 全部为**新编合成中文案例**；**未**读取真实库、**未**使用真实对话、**未**使用真实个人信息。
 * · 拆分 = `dev`（契约 §7）。**不含** val / test —— 那两个集合必须在 dev 冻结之后另行准备。
 * · ⚠️ **人审强度如实声明**：用户 2026-09-29 裁定「由用户抽查一部分、其余信任」。
 *   因此本语料**不**满足计划 §6.1 的"逐条人审"强度；这一点必须在报告里如实登记，
 *   不得把抽查说成逐条复核。抽查记录见 `docs/m9.6/M9.6-WP4-Pilot-Report.md`。
 * ```
 *
 * ⚠️ 本模块在**导入时**就跑一遍结构校验；不合法就抛 —— 让"错语料"根本进不了对照运行。
 */

import { createHash } from 'node:crypto'

import {
  SEARCH_NEED_DECISIONS,
  SEARCH_NEED_REASONS,
  type SearchNeedDecision,
  type SearchNeedReason,
} from '../../src/kernel/action/search-need.ts'
/*
 * ⚠️ 两个 part 文件各自声明了一份**结构完全相同**的 `SearchDevCase`（它们由不同的作者面独立产出）。
 *    这里只从 part1 取类型，避免同名类型重复导入；结构等价由 TS 的结构化类型保证。
 */
import { SEARCH_DEV_PART1, type SearchDevCase } from './search-dev-part1.ts'
import { SEARCH_DEV_PART2 } from './search-dev-part2.ts'

export type { SearchDevCase }

export type SearchDevStratum = SearchDevCase['stratum']

export const SEARCH_DEV_CORPUS: readonly SearchDevCase[] = [...SEARCH_DEV_PART1, ...SEARCH_DEV_PART2]

export const SEARCH_DEV_EXPECTED_TOTAL = 100

export interface CorpusValidation {
  readonly ok: boolean
  readonly problems: readonly string[]
  readonly counts: {
    readonly total: number
    readonly byStratum: Readonly<Record<string, number>>
    readonly byDecision: Readonly<Record<string, number>>
    readonly positives: number
    readonly explicitPositives: number
    readonly autoPositives: number
  }
}

/**
 * 结构校验（**纯函数**）。
 * 逐条检查**可机器判定的部分**；语义标签是否合理仍归人审（本模块不假装能判语义）。
 */
export function validateCorpus(corpus: readonly SearchDevCase[] = SEARCH_DEV_CORPUS): CorpusValidation {
  const problems: string[] = []
  const byStratum: Record<string, number> = {}
  const byDecision: Record<string, number> = {}
  const seenIds = new Set<string>()
  const seenRequests = new Map<string, string>()

  for (const item of corpus) {
    byStratum[item.stratum] = (byStratum[item.stratum] ?? 0) + 1
    byDecision[item.expected.decision] = (byDecision[item.expected.decision] ?? 0) + 1

    if (item.split !== 'dev') problems.push(`${item.caseId}: split 必须是 dev`)
    if (seenIds.has(item.caseId)) problems.push(`${item.caseId}: caseId 重复`)
    seenIds.add(item.caseId)

    if (!(SEARCH_NEED_DECISIONS as readonly string[]).includes(item.expected.decision)) {
      problems.push(`${item.caseId}: decision 不在闭集（${item.expected.decision}）`)
    }
    if (!(SEARCH_NEED_REASONS as readonly string[]).includes(item.expected.reason)) {
      problems.push(`${item.caseId}: reason 不在闭集（${item.expected.reason}）`)
    }

    const request = item.request
    if (request.trim().length < 4) problems.push(`${item.caseId}: request 过短`)
    if (request.length > 80) problems.push(`${item.caseId}: request 过长（${String(request.length)}）`)
    const previous = seenRequests.get(request)
    if (previous !== undefined) problems.push(`${item.caseId}: request 与 ${previous} 重复`)
    seenRequests.set(request, item.caseId)

    if (item.expected.decision === 'search') {
      const queryText = item.expected.queryText
      if (queryText === undefined || queryText.trim() === '') {
        problems.push(`${item.caseId}: decision=search 但没有 queryText（金标 span 无法导出）`)
      } else if (!request.includes(queryText)) {
        /* ★ 金标 span 必须能在原文里定位 —— 否则"精确率"根本无从计算 */
        problems.push(`${item.caseId}: queryText 不是 request 的连续子串`)
      }
    } else if (item.expected.queryText !== undefined) {
      problems.push(`${item.caseId}: 非 search 却带了 queryText`)
    }

    if (item.stratum === 'clear_positive' && item.expected.decision !== 'search') {
      problems.push(`${item.caseId}: clear_positive 必须期望 search`)
    }
    if (item.stratum === 'ordinary_negative' && item.expected.decision === 'search') {
      problems.push(`${item.caseId}: ordinary_negative 不得期望 search`)
    }
    if (item.note.trim() === '') problems.push(`${item.caseId}: 缺 note（人审需要理由）`)
  }

  if (corpus.length !== SEARCH_DEV_EXPECTED_TOTAL) {
    problems.push(`总数 ${String(corpus.length)} ≠ ${String(SEARCH_DEV_EXPECTED_TOTAL)}`)
  }
  const positives = corpus.filter((item) => item.expected.decision === 'search')
  const explicitPositives = positives.filter((item) => item.mode === 'explicit').length
  const autoPositives = positives.filter((item) => item.mode === 'auto_public').length
  if (positives.length !== 30) problems.push(`正例 ${String(positives.length)} ≠ 30`)
  if (explicitPositives !== 15) problems.push(`explicit 正例 ${String(explicitPositives)} ≠ 15`)
  if (autoPositives !== 15) problems.push(`auto_public 正例 ${String(autoPositives)} ≠ 15`)
  if ((byStratum.clear_positive ?? 0) !== 30) problems.push(`clear_positive ${String(byStratum.clear_positive ?? 0)} ≠ 30`)
  if ((byStratum.ordinary_negative ?? 0) !== 25) problems.push(`ordinary_negative ${String(byStratum.ordinary_negative ?? 0)} ≠ 25`)
  if ((byStratum.ambiguous_or_quoted_or_hypothetical ?? 0) !== 20) {
    problems.push(`ambiguous ${String(byStratum.ambiguous_or_quoted_or_hypothetical ?? 0)} ≠ 20`)
  }
  if ((byStratum.critical_boundary ?? 0) !== 25) problems.push(`critical_boundary ${String(byStratum.critical_boundary ?? 0)} ≠ 25`)

  /* 关键边界的子类覆盖：用**理由码**做可机器判定的近似（语义合理性仍归人审） */
  const boundary = corpus.filter((item) => item.stratum === 'critical_boundary')
  const countReason = (reason: SearchNeedReason): number => boundary.filter((item) => item.expected.reason === reason).length
  const coverage: readonly [string, number, number][] = [
    ['negated_or_forbidden', countReason('negated_or_forbidden'), 5],
    ['private_object', countReason('private_object'), 5],
    ['adversarial_input', countReason('adversarial_input'), 4],
    ['quoted_or_metalinguistic', countReason('quoted_or_metalinguistic'), 4],
  ]
  for (const [reason, actual, minimum] of coverage) {
    if (actual < minimum) problems.push(`关键边界覆盖不足：${reason} ${String(actual)} < ${String(minimum)}`)
  }

  return {
    ok: problems.length === 0,
    problems,
    counts: {
      total: corpus.length,
      byStratum,
      byDecision,
      positives: positives.length,
      explicitPositives,
      autoPositives,
    },
  }
}

/** 语料指纹（**冻结**用；规范化后取 SHA-256，与字段顺序无关） */
export function corpusFingerprint(corpus: readonly SearchDevCase[] = SEARCH_DEV_CORPUS): string {
  const canonical = corpus
    .map((item) => JSON.stringify([item.caseId, item.stratum, item.mode, item.request, item.expected]))
    .sort()
    .join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** 金标 span 由 `request.indexOf(queryText)` 导出（**只用于评分**，绝不用于生成候选） */
export function goldSpanOf(item: SearchDevCase): { readonly start: number; readonly end: number } | null {
  const queryText = item.expected.queryText
  if (queryText === undefined) return null
  const start = item.request.indexOf(queryText)
  if (start < 0) return null
  return { start, end: start + queryText.length }
}

/* 导入即校验：错语料不许进对照运行（失败关闭） */
const INITIAL_VALIDATION = validateCorpus()
if (!INITIAL_VALIDATION.ok) {
  throw new Error(
    `M9.6 搜索 dev 语料结构校验失败（${String(INITIAL_VALIDATION.problems.length)} 项）：\n  - ${INITIAL_VALIDATION.problems.join('\n  - ')}`
  )
}

export const SEARCH_DEV_DECISIONS = SEARCH_NEED_DECISIONS
export const SEARCH_DEV_REASONS = SEARCH_NEED_REASONS
export type { SearchNeedDecision, SearchNeedReason }
