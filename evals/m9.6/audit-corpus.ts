/**
 * M9.6 WP4a —— **离线事实审计 dev/val/test 语料（90 条合成案例）**。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * ```text
 * 计划 §6.3：90 条合成案例（dev 30 / val 20 / test 40），test 的四种关系各 10 条。
 * 两层用法（**不许混用**）：
 *   第一层 ①：固定人工主张 + 证据 ⇒ 只测**主张—证据关系**（4 类闭集）
 *   第二层 ②：整段回复进（修复后的）原审计链 ⇒ 测**主张提取覆盖 / 漏主张 / 端到端关键错误**
 *
 * ⚠️ 计划逐字：**「人工主张只可作为第一层输入及第二层 oracle，不能偷偷补给第二层提取器」**
 *    ⇒ 第二层只吃 `reply` + `evidence`；`keyClaims` 仅用于**评分**。
 * ⚠️ 全部为**新编合成**中文案例；未读真实库、未使用真实对话或真实个人信息。
 * ```
 *
 * ⚠️ 导入时即校验；不合法就抛 —— 错语料根本进不了对照运行。
 */

import { createHash } from 'node:crypto'

import { AUDIT_DEV } from './audit-dev.ts'
import { AUDIT_TEST } from './audit-test.ts'
import { AUDIT_VAL } from './audit-val.ts'

export type AuditRelation = 'supports' | 'contradicts' | 'insufficient' | 'no_assertion'

export interface AuditCase {
  readonly caseId: string
  readonly split: 'dev' | 'val' | 'test'
  readonly reply: string
  readonly claim: string
  readonly evidence: string
  readonly expected: {
    readonly relation: AuditRelation
    readonly keyClaims: readonly string[]
  }
  readonly note: string
}

export const AUDIT_RELATIONS: readonly AuditRelation[] = ['supports', 'contradicts', 'insufficient', 'no_assertion']

/** `insufficient` 的"本轮没有可采信证据"标记（逐字，供第二层把它翻成空证据数组） */
export const EMPTY_EVIDENCE_MARKER = '（空 —— 本轮没有可采信证据）'

/**
 * ★ **归一：`no_assertion` 的 `claim` 必须是那句"非主张"的原话本身**，
 *   而不是「这只是一句问候」这类**对它的描述**。
 *
 * 理由：第一层要测的是「**这句话**算不算一条关于用户自身槽位具体取值的事实主张」——
 * 也就是 `M9.5-FMB-01` 的原始缺陷形态（把记忆状态自述 / 寒暄当成无依据断言）。
 * 若 `claim` 写成对原话的**描述**，被测对象就变成了"能不能认出元描述"，
 * **换了被测对象**（本仓最忌讳的"数字量的不是你以为的那个东西"）。
 */
function normalizeCase(item: AuditCase): AuditCase {
  return item.expected.relation === 'no_assertion' ? { ...item, claim: item.reply } : item
}

export const AUDIT_CORPUS: readonly AuditCase[] = [...AUDIT_DEV, ...AUDIT_VAL, ...AUDIT_TEST].map(normalizeCase)

export const AUDIT_EXPECTED_TOTAL = 90
export const AUDIT_EXPECTED_BY_SPLIT: Readonly<Record<'dev' | 'val' | 'test', number>> = { dev: 30, val: 20, test: 40 }

export interface AuditValidation {
  readonly ok: boolean
  readonly problems: readonly string[]
  readonly counts: {
    readonly total: number
    readonly bySplit: Readonly<Record<string, number>>
    readonly bySplitRelation: Readonly<Record<string, Readonly<Record<string, number>>>>
  }
}

/** 结构校验（纯函数）：只判**可机器判定**的部分；语义合理性仍归人审 */
export function validateAuditCorpus(corpus: readonly AuditCase[] = AUDIT_CORPUS): AuditValidation {
  const problems: string[] = []
  const bySplit: Record<string, number> = {}
  const bySplitRelation: Record<string, Record<string, number>> = {
    dev: {},
    val: {},
    test: {},
  }
  const seenIds = new Set<string>()
  const seenReplies = new Map<string, string>()

  for (const item of corpus) {
    bySplit[item.split] = (bySplit[item.split] ?? 0) + 1
    const bucket = bySplitRelation[item.split] ?? {}
    bucket[item.expected.relation] = (bucket[item.expected.relation] ?? 0) + 1
    bySplitRelation[item.split] = bucket

    if (seenIds.has(item.caseId)) problems.push(`${item.caseId}: caseId 重复`)
    seenIds.add(item.caseId)
    if (!item.caseId.startsWith(`aud-${item.split}-`)) problems.push(`${item.caseId}: caseId 与 split 不一致`)

    if (!AUDIT_RELATIONS.includes(item.expected.relation)) {
      problems.push(`${item.caseId}: relation 不在闭集（${item.expected.relation}）`)
    }

    const reply = item.reply
    if (reply.trim().length < 6) problems.push(`${item.caseId}: reply 过短`)
    if (reply.length > 60) problems.push(`${item.caseId}: reply 过长（${String(reply.length)}）`)
    const previous = seenReplies.get(reply)
    if (previous !== undefined) problems.push(`${item.caseId}: reply 与 ${previous} 重复`)
    seenReplies.set(reply, item.caseId)

    if (item.claim.trim() === '') problems.push(`${item.caseId}: claim 为空`)
    if (item.evidence.trim() === '') problems.push(`${item.caseId}: evidence 为空（空证据要用标记串）`)
    if (item.note.trim() === '') problems.push(`${item.caseId}: 缺 note`)

    /*
     * ★ 第二层的覆盖测量要求 `keyClaims` 是 `reply` 的**逐字连续子串** ——
     *   否则"提取到了没有"无从判定（与 WP4 里金标 span 同理）。
     */
    for (const keyClaim of item.expected.keyClaims) {
      if (keyClaim.length < 2) problems.push(`${item.caseId}: keyClaim 过短（${keyClaim}）`)
      if (!reply.includes(keyClaim)) problems.push(`${item.caseId}: keyClaim「${keyClaim}」不是 reply 的逐字子串`)
    }

    /*
     * ★ `no_assertion` 是**假阳性探针**：这类案例里回复**不含**任何关于用户槽位具体取值的主张
     *   ⇒ keyClaims 必须为空，否则这条探针自相矛盾。
     */
    if (item.expected.relation === 'no_assertion' && item.expected.keyClaims.length !== 0) {
      problems.push(`${item.caseId}: no_assertion 的 keyClaims 必须为空`)
    }
    if (item.expected.relation !== 'no_assertion' && item.expected.keyClaims.length === 0) {
      problems.push(`${item.caseId}: 非 no_assertion 必须给出至少一条 keyClaim`)
    }
  }

  if (corpus.length !== AUDIT_EXPECTED_TOTAL) problems.push(`总数 ${String(corpus.length)} ≠ ${String(AUDIT_EXPECTED_TOTAL)}`)
  for (const [split, expected] of Object.entries(AUDIT_EXPECTED_BY_SPLIT)) {
    if ((bySplit[split] ?? 0) !== expected) problems.push(`${split} 计数 ${String(bySplit[split] ?? 0)} ≠ ${String(expected)}`)
  }
  /* test 的四种关系必须各 10 条（计划 §6.3 冻结值） */
  for (const relation of AUDIT_RELATIONS) {
    const actual = bySplitRelation.test?.[relation] ?? 0
    if (actual !== 10) problems.push(`test 的 ${relation} 计数 ${String(actual)} ≠ 10`)
  }

  return { ok: problems.length === 0, problems, counts: { total: corpus.length, bySplit, bySplitRelation } }
}

/** 语料指纹（**冻结**用；规范化后 SHA-256，与字段顺序无关） */
export function auditCorpusFingerprint(corpus: readonly AuditCase[] = AUDIT_CORPUS): string {
  const canonical = corpus
    .map((item) => JSON.stringify([item.caseId, item.split, item.reply, item.claim, item.evidence, item.expected]))
    .sort()
    .join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** 第二层用的**可采信证据数组**：空证据标记 ⇒ 空数组（与 WP0a 的判据面一致） */
export function admissibleEvidenceOf(item: AuditCase): readonly string[] {
  const evidence = item.evidence.trim()
  return evidence === EMPTY_EVIDENCE_MARKER ? [] : [evidence]
}

export function selectAuditCases(split: 'dev' | 'val' | 'test'): readonly AuditCase[] {
  return AUDIT_CORPUS.filter((item) => item.split === split)
}

/* 导入即校验：错语料不许进对照运行 */
const INITIAL = validateAuditCorpus()
if (!INITIAL.ok) {
  throw new Error(
    `M9.6 审计语料结构校验失败（${String(INITIAL.problems.length)} 项）：\n  - ${INITIAL.problems.join('\n  - ')}`
  )
}
