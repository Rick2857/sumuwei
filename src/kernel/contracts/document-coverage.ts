/**
 * 覆盖质量命题（2026-10-23 · P2.1 第四批）
 *
 * ⚠️ **旧语义一字未动**：`document_extracts` + `pdf_text` 仍然只表示
 *    "该 reader 取得了非空文本"。本模块是**显式语义版本**：新的 scope +
 *    environment + 条件 ⇒ 内容寻址的**新身份**，**不继承**旧命题的任何资格
 *    （EBL 的身份由签名决定，见 `eblSignature`）。
 *
 * ⚠️ **它不是"全文正确"**：覆盖度只对**参照集声明的范围**成立
 *    （哪几页、哪几个单元、什么归一化视图），范围之外仍然是未验证状态。
 *
 * ⚠️ **参照与提取管线必须独立**：参照来自页面图像的人工标注，
 *    不许用另一条读取路线的输出来定义"应该有什么"。
 *    ⇒ 跨路线 5-gram 包含度**不是**覆盖判据（见 `document-coverage-metrics.ts`
 *    的负控结论：它既不独立，也会被纯格式重排改变）。
 */
import type { PdfReader } from './document-reading.ts'

/** 覆盖命题的**范围**：与旧的 `pdf_text`（"非空"）分列，互不转义。 */
export const DOCUMENT_COVERAGE_SCOPE = 'pdf_text_coverage'
/** 覆盖命题的**环境版本**：进入覆盖语义 ⇒ 身份改变 ⇒ 资格重新取得。 */
export const DOCUMENT_COVERAGE_ENVIRONMENT = 'pdf-text-coverage@1'
/** 覆盖**政策**版本：范围内每个单元都被定位才算达成（没有阈值可调）。 */
export const DOCUMENT_COVERAGE_POLICY = 'unit-presence@1'
/** 求值所用的**匹配视图**版本（归一化政策）。 */
export const DOCUMENT_COVERAGE_VIEW = 'nfkc-line-hyphen-whitespace-markdown@1'
/** 覆盖回执协议（**不含正文**）。 */
export const DOCUMENT_COVERAGE_PROTOCOL = 'pdf-coverage@1'
export const DOCUMENT_COVERAGE_PREFIX = 'pdf-coverage:'

export const DOCUMENT_COVERAGE_REVIEW_STATUSES = ['APPROVED', 'PENDING', 'REJECTED'] as const
export type DocumentCoverageReviewStatus = typeof DOCUMENT_COVERAGE_REVIEW_STATUSES[number]

export interface DocumentCoverageUnit {
  readonly id: string
  readonly page: number
  readonly region: string
  readonly kind: 'fragments' | 'row'
  readonly needles: readonly string[]
  readonly columns?: readonly string[]
}

export interface DocumentCoverageReference {
  readonly version: string
  /** 参照所对应的**文档字节指纹**；字节变了就不成立。 */
  readonly documentSha256: string
  /** 真人复核状态：只有 `APPROVED` 能充当覆盖证据。 */
  readonly humanReview: DocumentCoverageReviewStatus
  readonly units: readonly DocumentCoverageUnit[]
}

export type DocumentCoverageOutcome = 'met' | 'not_met' | 'unknown'

export interface DocumentCoverageReceipt {
  readonly protocol: typeof DOCUMENT_COVERAGE_PROTOCOL
  readonly inputFingerprint: string
  readonly referenceVersion: string
  readonly policy: typeof DOCUMENT_COVERAGE_POLICY
  readonly view: typeof DOCUMENT_COVERAGE_VIEW
  readonly outcome: DocumentCoverageOutcome
  /** 范围内锚点**全部到位**的单元数（覆盖政策的唯一判据）。 */
  readonly observed: number
  readonly total: number
  /**
   * **结构读数**：表格行"同线有序"没能确认的单元数。
   *
   * ⚠️ 它**不是**"缺失单元数"：缺失单元已经计入 `total - observed`。
   *    两者混用会让回执自相矛盾（曾真实发生过一次：回执因此被校验拒绝）。
   */
  readonly associationUnknown: number
}

/**
 * 匹配视图：NFKC → 小写 → 行末英文断词接合 → 去空白与少量 Markdown 标记。
 *
 * ⚠️ 它**不是**无损视图：`x²/x2`、`①/1` 在 NFKC 下会碰撞。
 *    ⇒ 覆盖判定只声称"在匹配视图里定位到了"，不声称"原文逐字无损"。
 */
export function documentCoverageView(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/-\r?\n(?=[a-z])/g, '').replace(/[\s|*_`]/g, '')
}

export type DocumentCoverageVerdict = 'observed' | 'not_observed' | 'association_unknown'

export interface DocumentCoverageUnitReading {
  readonly id: string
  readonly kind: 'fragments' | 'row'
  readonly needles: readonly boolean[]
  /** **内容存在性**：这个词片段的锚点是否都在。 */
  readonly present: boolean
  /** **结构读数**：表格行是否仍能按同线有序绑定（fragments 不适用）。 */
  readonly association: 'associated' | 'unassociated' | 'not_applicable'
}

export interface DocumentCoverageReading {
  /** 内容存在：范围内被定位到的单元数。 */
  readonly observed: number
  readonly notObserved: number
  /** 结构读数：表格行里同线有序仍成立的行数。 */
  readonly associated: number
  readonly associationUnknown: number
  readonly total: number
  /** `unit-presence@1`：范围内每个单元的锚点都在。 */
  readonly policyMet: boolean
  readonly units: readonly DocumentCoverageUnitReading[]
}

/**
 * 逐单元定位（**只**回答"有没有"和"是否仍能按同线有序绑定"，不回答语义正确性）。
 *
 * ⚠️ **内容存在与结构关系分列**（2026-10-23 第四批的负控结论）：
 *    纯格式重排会把一行的锚点拆到多行 ⇒ "同线有序"这条**结构**读数对排版敏感。
 *    ⇒ 覆盖政策 `unit-presence@1` 只用**内容存在性**；
 *      结构读数单独报告，**不进入**覆盖政策，也不被当成内容缺失。
 */
export function evaluateDocumentCoverage(text: string, units: readonly DocumentCoverageUnit[]): DocumentCoverageReading {
  const flat = documentCoverageView(text)
  const lines = text.split(/\r?\n/).map(documentCoverageView)
  const readings = units.map(unit => {
    const needles = unit.needles.map(documentCoverageView)
    const present = needles.map(needle => flat.includes(needle))
    const allPresent = present.every(Boolean)
    let association: DocumentCoverageUnitReading['association'] = 'not_applicable'
    if (unit.kind === 'row' && allPresent) {
      const sameLine = lines.some(line => {
        let offset = 0
        for (const needle of needles) {
          const index = line.indexOf(needle, offset)
          if (index < 0) return false
          offset = index + needle.length
        }
        return true
      })
      association = sameLine ? 'associated' : 'unassociated'
    }
    return { id: unit.id, kind: unit.kind, needles: present, present: allPresent, association }
  })
  const observed = readings.filter(reading => reading.present).length
  const rows = readings.filter(reading => reading.kind === 'row')
  const associated = rows.filter(reading => reading.association === 'associated').length
  const total = units.length
  return { observed, notObserved: readings.filter(reading => !reading.present).length, associated,
    associationUnknown: rows.filter(reading => reading.association === 'unassociated').length, total,
    policyMet: total > 0 && observed === total, units: readings }
}

export function readDocumentCoverageReceipt(value: unknown): DocumentCoverageReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'associationUnknown,inputFingerprint,observed,outcome,policy,protocol,referenceVersion,total,view'
    || v.protocol !== DOCUMENT_COVERAGE_PROTOCOL || v.policy !== DOCUMENT_COVERAGE_POLICY || v.view !== DOCUMENT_COVERAGE_VIEW
    || !['met', 'not_met', 'unknown'].includes(String(v.outcome))
    || typeof v.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.inputFingerprint)
    || typeof v.referenceVersion !== 'string' || v.referenceVersion.length === 0 || v.referenceVersion.length > 128
    || !Number.isSafeInteger(v.observed) || Number(v.observed) < 0
    || !Number.isSafeInteger(v.total) || Number(v.total) < 0
    || !Number.isSafeInteger(v.associationUnknown) || Number(v.associationUnknown) < 0) return undefined
  if (Number(v.observed) > Number(v.total) || Number(v.associationUnknown) > Number(v.total)) return undefined
  if (v.outcome === 'met' && !(Number(v.observed) === Number(v.total))) return undefined
  if (v.outcome === 'not_met' && Number(v.observed) === Number(v.total)) return undefined
  return v as unknown as DocumentCoverageReceipt
}

export function readDocumentCoverageReference(value: unknown): DocumentCoverageReference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.version !== 'string' || v.version.length === 0 || v.version.length > 128
    || typeof v.documentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.documentSha256)
    || !DOCUMENT_COVERAGE_REVIEW_STATUSES.includes(v.humanReview as DocumentCoverageReviewStatus)
    || !Array.isArray(v.units) || v.units.length === 0 || v.units.length > 512) return undefined
  const units: DocumentCoverageUnit[] = []
  for (const raw of v.units) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const unit = raw as Record<string, unknown>
    if (typeof unit.id !== 'string' || unit.id.length === 0 || unit.id.length > 64
      || !Number.isSafeInteger(unit.page) || Number(unit.page) < 1
      || typeof unit.region !== 'string' || unit.region.length > 128
      || (unit.kind !== 'fragments' && unit.kind !== 'row')
      || !Array.isArray(unit.needles) || unit.needles.length === 0 || unit.needles.length > 32
      || unit.needles.some(needle => typeof needle !== 'string' || needle.length === 0 || needle.length > 256)) return undefined
    units.push({ id: unit.id, page: Number(unit.page), region: unit.region, kind: unit.kind,
      needles: unit.needles as string[], ...(Array.isArray(unit.columns) ? { columns: unit.columns as string[] } : {}) })
  }
  return { version: v.version, documentSha256: v.documentSha256, humanReview: v.humanReview as DocumentCoverageReviewStatus, units }
}

/** 只有真人复核通过的参照才允许充当覆盖证据。 */
export function documentCoverageReferenceUsable(reference: DocumentCoverageReference | undefined): reference is DocumentCoverageReference {
  return reference !== undefined && reference.humanReview === 'APPROVED'
}

/** 覆盖命题的条件（**闭集**；条件键符合 EBL 约束）。 */
export function documentCoverageConditions(reader: PdfReader, referenceVersion: string): Record<string, string> {
  return { format: 'pdf', reader, reference: referenceVersion, policy: DOCUMENT_COVERAGE_POLICY }
}
