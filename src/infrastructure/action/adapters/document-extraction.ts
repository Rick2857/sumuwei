import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { ActionFailureError, actionFailure } from '../../../kernel/action/errors.ts'
import { DOCUMENT_EXTRACT, DOCUMENT_READING_VERSION, PDF_READERS, PDF_RECEIPT_PREFIX, type PdfReader, type PdfReadingReceipt } from '../../../kernel/contracts/document-reading.ts'
import {
  DOCUMENT_COVERAGE_POLICY, DOCUMENT_COVERAGE_PREFIX, DOCUMENT_COVERAGE_PROTOCOL, DOCUMENT_COVERAGE_VIEW,
  documentCoverageReferenceUsable, evaluateDocumentCoverage, type DocumentCoverageReceipt,
} from '../../../kernel/contracts/document-coverage.ts'
import { createDocumentReadAdapter, runConverter, DEFAULT_DOC_PYTHON, DEFAULT_DOC_RUNNER, DOCUMENT_LIMITS, type DocumentReadOptions } from './document-read.ts'

/** New explicit capability; the original document.read adapter and default output are untouched. */
export function createDocumentExtractionAdapter(options: DocumentReadOptions): CapabilityAdapter {
  return { capabilityId: DOCUMENT_EXTRACT, async execute(input) {
    const reader = (input.args.reader ?? 'markitdown') as PdfReader
    if (input.operation !== 'read' || !PDF_READERS.includes(reader) || typeof input.args.path !== 'string'
      || Object.keys(input.args).some(k => !['path','reader','expectedInputFingerprint'].includes(k))
      || (input.args.expectedInputFingerprint !== undefined && (typeof input.args.expectedInputFingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(input.args.expectedInputFingerprint)))) throw new ActionFailureError(actionFailure('validation_failed', 'PDF 提取只接受 path、闭集 reader 与可选输入指纹'))
    let receipt: PdfReadingReceipt | undefined
    const delegate = createDocumentReadAdapter({ ...options, async convert(request) {
      if (request.format !== 'pdf') throw new ActionFailureError(actionFailure('unsupported', '此读取路线只支持 PDF'))
      receipt = { protocol: DOCUMENT_READING_VERSION, reader,
        inputFingerprint: createHash('sha256').update(request.bytes).digest('hex'), outcome: 'failed' }
      if (input.args.expectedInputFingerprint !== undefined && input.args.expectedInputFingerprint !== receipt.inputFingerprint)
        throw new ActionFailureError(actionFailure('validation_failed', 'PDF 字节已变化，旧结构观察不可用于本次提取', { profileBinding: 'source_changed' }))
      const result = options.convert ? await options.convert(request) : await runConverter({ ...request,
        pythonPath: options.pythonPath ?? DEFAULT_DOC_PYTHON,
        runnerPath: reader === 'markitdown' ? options.runnerPath ?? DEFAULT_DOC_RUNNER
          : fileURLToPath(new URL('../../../../scripts/cognitive/pdfminer-runner.py', import.meta.url)),
        timeoutMs: options.timeoutMs ?? DOCUMENT_LIMITS.timeoutMs,
      })
      /*
       * ⚠️ **NFKC 归一**（2026-10-23 用户裁定 · 自然语料轮实测）：
       *   很多真实 PDF 的文本层把汉字映射到**康熙部首**码位（电⼦ / U+2F66 而不是 电子 / U+7535）。
       *   人眼看到的是同一个字，码位却不同 ⇒ 任何按精确字符串判定"读到了没有"的下游
       *   都会把**读得很完美**的文档误判成"没读到"。
       *   ⇒ 提取正文统一做 NFKC 归一。
       * ⚠️ 范围：**只**改 `document.extract` 的输出；旧 `document.read` 的正文与默认输出**一字未动**。
       */
      if (typeof result.markdown === 'string') result.markdown = result.markdown.normalize('NFKC')
      receipt.outcome = result.timedOut ? 'timeout' : !result.ok ? 'failed' : result.markdown?.trim() ? 'nonempty' : 'empty'
      return result
    } })
    try {
      const outcome = await delegate.execute({ ...input, args: { path: input.args.path } })
      /*
       * ⚠️ **覆盖回执**（2026-10-23 · P2.1 第四批）：
       *   只有**真人复核通过**的参照、且**当前字节**与参照指纹一致时才产出。
       *   它评价的是**正式交付的正文**（含 60000 字符截断后的实际内容），
       *   并且**只**写计数与状态，**不写正文**。
       *   ⇒ 旧 `document_extracts`（非空）语义完全不受影响。
       */
      const reference = options.coverageReferenceFor?.(input.args.path)
      let coverageReceipt: DocumentCoverageReceipt | undefined
      if (documentCoverageReferenceUsable(reference) && receipt?.inputFingerprint === reference.documentSha256) {
        const delivered = outcome.turnContent?.[0]?.text ?? ''
        const reading = evaluateDocumentCoverage(delivered, reference.units)
        coverageReceipt = { protocol: DOCUMENT_COVERAGE_PROTOCOL, inputFingerprint: receipt.inputFingerprint,
          referenceVersion: reference.version, policy: DOCUMENT_COVERAGE_POLICY, view: DOCUMENT_COVERAGE_VIEW,
          outcome: reading.policyMet ? 'met' : 'not_met', observed: reading.observed, total: reading.total,
          associationUnknown: reading.associationUnknown }
      }
      return { ...outcome, evidence: [...(outcome.evidence ?? []), { kind: 'adapter' as const, detail: '有界 PDF 提取回执；无正文', ref: PDF_RECEIPT_PREFIX + JSON.stringify(receipt) },
        ...(coverageReceipt ? [{ kind: 'adapter' as const, detail: '覆盖度回执（无正文）', ref: DOCUMENT_COVERAGE_PREFIX + JSON.stringify(coverageReceipt) }] : [])],
        turnContent: outcome.turnContent?.map(item => ({ ...item, capability: DOCUMENT_EXTRACT,
          facts: [...item.facts.filter(s => !s.startsWith('转换器：')), `转换管线：${reader} / ${DOCUMENT_READING_VERSION}`] })),
      }
    } catch (error) {
      if (error instanceof ActionFailureError && receipt) throw new ActionFailureError(actionFailure(error.failure.code,
        error.failure.message, { ...error.failure.details, documentReading: receipt }))
      throw error
    }
  } }
}
