/** Structural observations only; parser counts never certify reading quality. */
import type { CapabilityDefinition } from '../action/capability-registry.ts'

export const DOCUMENT_PROFILE = 'document.profile'
export const PDF_PROFILE_VERSION = 'pdf-profile@1'
export const PDF_PROFILE_READING_VERSION = 'pdf-text-profile@1'
export const PDF_PROFILE_PREFIX = 'pdf-profile:'
export const PDF_PROFILE_MAX_PAGES = 64
export interface PdfProfile {
  protocol: typeof PDF_PROFILE_VERSION
  inputFingerprint: string
  outcome: 'complete' | 'partial' | 'failed' | 'timeout'
  reason: 'none' | 'page_limit' | 'parse_failed' | 'encrypted' | 'extraction_disallowed' | 'runtime_missing' | 'timeout' | 'invalid_output'
  pages: number | null
  inspectedPages: number
  textLayer: 'present' | 'absent' | 'unknown'
  chars: number | null
  images: number | null
  tables: number | null
  extractionAllowed: boolean | null
}
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
export function readPdfProfile(value: unknown): PdfProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'chars,extractionAllowed,images,inputFingerprint,inspectedPages,outcome,pages,protocol,reason,tables,textLayer'
    || v.protocol !== PDF_PROFILE_VERSION || typeof v.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.inputFingerprint)
    || !['complete','partial','failed','timeout'].includes(String(v.outcome))
    || !['none','page_limit','parse_failed','encrypted','extraction_disallowed','runtime_missing','timeout','invalid_output'].includes(String(v.reason))
    || !count(v.inspectedPages) || v.inspectedPages > PDF_PROFILE_MAX_PAGES
    || !(v.pages === null || count(v.pages)) || (typeof v.pages === 'number' && v.inspectedPages > v.pages)
    || ![v.chars,v.images,v.tables].every(n => n === null || count(n))
    || !(v.extractionAllowed === null || typeof v.extractionAllowed === 'boolean')) return undefined
  if (v.outcome === 'complete') {
    if (v.reason !== 'none' || v.pages !== v.inspectedPages || ![v.chars,v.images,v.tables].every(count)
      || v.extractionAllowed !== true || v.textLayer !== (Number(v.chars) > 0 ? 'present' : 'absent')) return undefined
  } else {
    if (v.textLayer !== 'unknown' || v.reason === 'none') return undefined
    if (v.outcome === 'partial') {
      if (!['page_limit','parse_failed'].includes(String(v.reason)) || !count(v.pages) || ![v.chars,v.images,v.tables].every(count)
        || v.extractionAllowed !== true || (v.reason === 'page_limit' && v.inspectedPages >= v.pages)) return undefined
    } else if (v.inspectedPages !== 0 || [v.pages,v.chars,v.images,v.tables].some(n => n !== null)
      || (v.outcome === 'timeout') !== (v.reason === 'timeout') || v.reason === 'page_limit') return undefined
  }
  return v as unknown as PdfProfile
}
export function unknownPdfProfile(inputFingerprint: string, reason: 'timeout' | 'invalid_output'): PdfProfile {
  return { protocol: PDF_PROFILE_VERSION, inputFingerprint, outcome: reason === 'timeout' ? 'timeout' : 'failed', reason,
    pages: null, inspectedPages: 0, textLayer: 'unknown', chars: null, images: null, tables: null, extractionAllowed: null }
}
export function createDocumentProfileDefinition(): CapabilityDefinition {
  return { id: DOCUMENT_PROFILE, version: `${DOCUMENT_PROFILE}@1`, description: '只读检查明确 PDF 的结构，最多前 64 页；返回结构统计和范围，不含正文，不证明提取质量。',
    operations: [{ name: 'inspect', description: '检查 path 的 PDF 结构', sideEffect: 'read', riskLevel: 'R0' }],
    sideEffectLevel: 'read', riskLevel: 'R0', permissions: ['document:read'], supportsDryRun: true, idempotency: 'none' }
}
