import { createHash } from 'node:crypto'
import { lstat, readdir, open } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import { PERSONAL_LIBRARY_SEARCH } from '../../../kernel/action/learning-capabilities.ts'
import type { LocalTextTurnContent } from '../../../kernel/contracts/turn-content.ts'
import { resolveSandboxPath } from './sandbox-filesystem.ts'

export const PERSONAL_LIBRARY_ROOT = resolve('data', 'personal-library')
export const LIBRARY_LIMITS = { files: 100, entries: 300, depth: 3, fileBytes: 128 * 1024, totalBytes: 1024 * 1024, hits: 8 } as const
const TEXT_FORMATS = ['.txt', '.md', '.csv', '.json']
const FORMATS = [...TEXT_FORMATS, '.pdf', '.docx', '.pptx', '.xlsx']

export function createPersonalLibraryAdapter(root = PERSONAL_LIBRARY_ROOT): CapabilityAdapter {
  const rootAbs = resolve(root)
  return {
    capabilityId: PERSONAL_LIBRARY_SEARCH,
    async execute(input) {
      if (input.operation !== 'search' || typeof input.args.query !== 'string' || input.args.query.length > 200 ||
          Object.keys(input.args).some((key) => key !== 'query')) {
        throw new ActionFailureError(actionFailure('validation_failed', '资料检索只接受 ≤200 字符的 query'))
      }
      const terms = input.args.query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean).slice(0, 5)
      const hits: { path: string; excerpt: string; score: number }[] = []
      let files = 0, entries = 0, bytes = 0, truncated = false
      async function walk(relative: string, depth: number): Promise<void> {
        const dir = await resolveSandboxPath({ root: rootAbs }, relative || '.')
        if ((await lstat(dir)).isSymbolicLink()) return
        const items = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
        for (const item of items) {
          if (entries >= LIBRARY_LIMITS.entries || files >= LIBRARY_LIMITS.files) { truncated = true; break }
          entries++
          if (item.name.startsWith('.') || item.isSymbolicLink()) continue
          const rel = join(relative, item.name)
          if (item.isDirectory()) {
            if (depth < LIBRARY_LIMITS.depth) await walk(rel, depth + 1)
            else truncated = true
            continue
          }
          if (!item.isFile() || !FORMATS.includes(extname(item.name).toLowerCase())) continue
          const path = await resolveSandboxPath({ root: rootAbs }, rel)
          files++
          let text = ''
          if (terms.length > 0 && TEXT_FORMATS.includes(extname(path).toLowerCase())) {
            const stat = await lstat(path)
            if (stat.size <= LIBRARY_LIMITS.fileBytes && bytes + stat.size <= LIBRARY_LIMITS.totalBytes) {
              const handle = await open(path, 'r')
              try {
                const buffer = Buffer.alloc(Math.min(LIBRARY_LIMITS.fileBytes, LIBRARY_LIMITS.totalBytes - bytes) + 1)
                const read = await handle.read(buffer, 0, buffer.length, 0)
                if (read.bytesRead >= buffer.length) truncated = true
                const data = buffer.subarray(0, Math.min(read.bytesRead, buffer.length - 1))
                bytes += data.length
                text = data.toString('utf8')
              } finally { await handle.close() }
            } else truncated = true
          }
          const lower = text.toLocaleLowerCase()
          const score = terms.length === 0 ? 1 : terms.reduce((n, term) => n +
            (rel.toLocaleLowerCase().includes(term) ? 2 : 0) + (lower.includes(term) ? 1 : 0), 0)
          if (score === 0) continue
          const offset = Math.max(0, ...terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0).slice(0, 1))
          hits.push({ path, score, excerpt: text === '' ? '仅文件名命中；正文尚未读取' : text.slice(Math.max(0, offset - 80), offset + 320) })
        }
      }
      try { await walk('', 0) } catch (error) {
        if (error instanceof ActionFailureError) throw error
        throw new ActionFailureError(actionFailure('execution_failed', '专用资料夹不存在或无法读取'))
      }
      hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      const selected = hits.slice(0, LIBRARY_LIMITS.hits)
      truncated ||= hits.length > selected.length
      const text = [`资料夹：${rootAbs}`, `扫描 ${files} 个支持格式文件；返回 ${selected.length}/${hits.length} 条命中。`,
        ...(selected.length === 0 ? ['本次有界检索没有命中。'] : selected.map((hit) => `文件：${hit.path}\n摘录：${hit.excerpt}`))].join('\n\n')
      const fingerprint = createHash('sha256').update(text).digest('hex')
      const content: LocalTextTurnContent = {
        contentId: `library:${input.actionId}`, kind: 'local-text', capability: PERSONAL_LIBRARY_SEARCH,
        operation: 'search', sourceKind: 'local-disk', resourceRef: rootAbs, resultFingerprint: fingerprint,
        scope: { totalChars: text.length, includedChars: text.length, truncated: false },
        facts: [`只读专用资料夹；最多 ${LIBRARY_LIMITS.files} 个文件 / 深度 ${LIBRARY_LIMITS.depth}`, `正文累计读取 ${bytes} 字节；检索截断=${truncated}`],
        text, mediaType: 'text/plain', lineCount: text.split('\n').length, sourceBytes: bytes,
      }
      return {
        effect: { kind: 'content_read', detail: `资料夹检索：扫描 ${files} 个文件，返回 ${selected.length} 条命中`, fingerprint },
        evidence: [{ kind: 'adapter', detail: '有界只读检索；仅引用和范围入账', ref: rootAbs }],
        turnContent: [content],
      }
    },
  }
}
