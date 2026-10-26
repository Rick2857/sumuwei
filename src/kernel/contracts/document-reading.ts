/** Closed PDF-reading observations and a bounded route interpreter; no IO or model text. */
import type { CapabilityDefinition } from '../action/capability-registry.ts'
import type { UsableRuleSnapshot, PlanRuleDependency } from './cognitive-collaboration.ts'
import { createDocumentProfileDefinition, PDF_PROFILE_READING_VERSION } from './document-profile.ts'
import { createDocumentPagesDefinition } from './document-pages.ts'

export const DOCUMENT_EXTRACT = 'document.extract'
export const DOCUMENT_READING_VERSION = 'pdf-text@1'
export const PDF_READERS = ['markitdown', 'pdfminer'] as const
export type PdfReader = typeof PDF_READERS[number]
export type PdfReadingKind = 'nonempty' | 'empty' | 'timeout' | 'failed'
export interface PdfReadingReceipt {
  protocol: typeof DOCUMENT_READING_VERSION
  reader: PdfReader
  inputFingerprint: string
  outcome: PdfReadingKind
}
export const PDF_RECEIPT_PREFIX = 'pdf-reading:'
export function readPdfReceipt(value: unknown): PdfReadingReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'inputFingerprint,outcome,protocol,reader' || v.protocol !== DOCUMENT_READING_VERSION
    || !PDF_READERS.includes(v.reader as PdfReader) || !['nonempty','empty','timeout','failed'].includes(String(v.outcome))
    || typeof v.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.inputFingerprint)) return undefined
  return v as unknown as PdfReadingReceipt
}
export function createDocumentExtractionDefinitions(): readonly CapabilityDefinition[] {
  return [{ id: DOCUMENT_EXTRACT, version: `${DOCUMENT_EXTRACT}@1`, description: '只读提取一个明确 PDF 的正文；reader 为 markitdown 或 pdfminer；正文只供当轮使用。',
    operations: [{ name: 'read', description: '读取 path 指向的 PDF，采用指定 reader', sideEffect: 'read', riskLevel: 'R0' }],
    sideEffectLevel: 'read', riskLevel: 'R0', permissions: ['document:read'], supportsDryRun: true, idempotency: 'none' }, createDocumentProfileDefinition(), createDocumentPagesDefinition()]
}
export function documentRule(reader: PdfReader, snapshots: readonly UsableRuleSnapshot[], textLayer?: 'present' | 'absent'): UsableRuleSnapshot | undefined {
  return snapshots.find(s => s.usable && s.predicate === 'document_extracts' && s.expected === true
    && s.scope === 'pdf_text' && s.environment === (textLayer ? PDF_PROFILE_READING_VERSION : DOCUMENT_READING_VERSION) && s.conditions.reader === reader
    && s.conditions.format === 'pdf' && Object.keys(s.conditions).length === (textLayer ? 3 : 2)
    && (!textLayer || s.conditions.text_layer === textLayer))
}
export function simulateDocumentRoutes(snapshots: readonly UsableRuleSnapshot[], textLayer?: 'present' | 'absent') {
  return PDF_READERS.map(reader => {
    const rule = documentRule(reader, snapshots, textLayer)
    return { reader, expectation: rule ? 'nonempty' as const : 'unknown' as const,
      ...(rule ? { dependency: { claimId: rule.claimId, ruleVersion: rule.ruleVersion, evidenceFingerprint: rule.evidenceFingerprint } satisfies PlanRuleDependency } : {}) }
  })
}
