import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { ActionFailureError, actionFailure } from '../../../kernel/action/errors.ts'
import { DOCUMENT_PROFILE, PDF_PROFILE_PREFIX, readPdfProfile, unknownPdfProfile, type PdfProfile } from '../../../kernel/contracts/document-profile.ts'
import { createDocumentReadAdapter, runConverter, DEFAULT_DOC_PYTHON, type DocumentReadOptions } from './document-read.ts'

/** Reuse the existing authorized byte read, size/magic checks and process-tree timeout. */
export function createDocumentProfileAdapter(options: DocumentReadOptions): CapabilityAdapter {
  return { capabilityId: DOCUMENT_PROFILE, async execute(input) {
    if (input.operation !== 'inspect' || typeof input.args.path !== 'string' || Object.keys(input.args).some(k => k !== 'path'))
      throw new ActionFailureError(actionFailure('validation_failed', 'PDF 结构检查只接受 path'))
    let profile: PdfProfile | undefined
    const delegate = createDocumentReadAdapter({ ...options, async convert(request) {
      if (request.format !== 'pdf') throw new ActionFailureError(actionFailure('unsupported', '结构检查只支持 PDF'))
      const fingerprint = createHash('sha256').update(request.bytes).digest('hex')
      const raw = options.convert ? await options.convert(request) : await runConverter({ ...request,
        pythonPath: options.pythonPath ?? DEFAULT_DOC_PYTHON,
        runnerPath: fileURLToPath(new URL('../../../../scripts/utility-skills/pdf-profile-runner.py', import.meta.url)) })
      let value: unknown
      try { value = JSON.parse(raw.markdown ?? '') } catch { /* invalid output stays unknown */ }
      profile = !raw.timedOut && raw.ok && (raw.exitCode === undefined || raw.exitCode === 0) ? readPdfProfile({ ...(value as object), inputFingerprint: fingerprint }) : undefined
      profile ??= unknownPdfProfile(fingerprint, raw.timedOut ? 'timeout' : 'invalid_output')
      if (profile.outcome === 'failed' || profile.outcome === 'timeout') throw new ActionFailureError(actionFailure(
        profile.outcome === 'timeout' ? 'timeout' : 'execution_failed', `PDF 结构检查未完成：${profile.reason}`, { documentProfile: profile }))
      return { ok: true, timedOut: false, markdown: JSON.stringify(profile) }
    } })
    const outcome = await delegate.execute({ ...input, args: { path: input.args.path } })
    return { effect: { ...outcome.effect!, detail: 'PDF 结构检查；未提取正文' },
      evidence: [{ kind: 'adapter', detail: '有界结构回执；无正文', ref: PDF_PROFILE_PREFIX + JSON.stringify(profile) }],
      turnContent: outcome.turnContent?.map(item => ({ ...item, capability: DOCUMENT_PROFILE, operation: 'inspect',
        facts: [`PDF 结构检查：${profile!.outcome} / ${profile!.reason}`, '统计只覆盖 inspectedPages；字符范围为结构 JSON，不是 PDF 正文覆盖率'], structure: [] })),
      ...(profile!.outcome === 'partial' ? { partial: { completed: profile!.inspectedPages, total: profile!.pages!, detail: '结构仅检查部分页面，文本层未知' } } : {}),
    }
  } }
}
