/** Offline, allowlisted source snapshots. Metadata describes a document, never live capability truth. */
import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveSandboxPath } from '../action/adapters/sandbox-filesystem.ts'

export const KNOWLEDGE_FORMAT = 'project-documents@1'
export const KNOWLEDGE_LIMITS = { documents: 200, fileBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, sectionChars: 12000 }
const KINDS = ['architecture', 'design', 'capability', 'acceptance', 'deployment', 'source'] as const
export interface SourceSpec {
  path: string
  kind: typeof KINDS[number]
  environment: string
  topics: string[]
  documentDate: string | null
  effectiveAt: string | null
  supersedes: string[]
}
export interface ImportManifest { version: 1; libraryId: string; sources: SourceSpec[] }
export interface DocumentSection {
  ordinal: number; headings: string[]; startLine: number; endLine: number
  startOffset: number; endOffset: number; text: string
}
export interface SourceDocument {
  source: SourceSpec; sourceHash: string; revision: string; sourceCommit: string | null
  body: string; sections: DocumentSection[]
}
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export function requireKnowledge(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`project_knowledge_${code}`)
}
function sourcePath(value: unknown): value is string {
  return typeof value === 'string' && /^(?:README\.md|docs\/[\p{L}\p{N}_. /-]+\.md|src\/[a-zA-Z0-9_./-]+\.ts)$/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
}
export function parseManifest(value: unknown): ImportManifest {
  requireKnowledge(value && typeof value === 'object' && !Array.isArray(value), 'manifest_invalid')
  const manifest = value as ImportManifest
  requireKnowledge(Object.keys(manifest).sort().join() === 'libraryId,sources,version'
    && manifest.version === 1 && /^[a-z][a-z0-9-]{0,63}$/.test(manifest.libraryId), 'manifest_invalid')
  requireKnowledge(Array.isArray(manifest.sources) && manifest.sources.length > 0
    && manifest.sources.length <= KNOWLEDGE_LIMITS.documents, 'manifest_size')
  const paths = new Set<string>()
  for (const source of manifest.sources) {
    requireKnowledge(source && Object.keys(source).sort().join() === 'documentDate,effectiveAt,environment,kind,path,supersedes,topics', 'source_invalid')
    requireKnowledge(sourcePath(source.path) && !paths.has(source.path), 'source_path')
    requireKnowledge(KINDS.includes(source.kind) && typeof source.environment === 'string'
      && source.environment.length > 0 && source.environment.length <= 100, 'source_metadata')
    requireKnowledge(Array.isArray(source.topics) && source.topics.length <= 30
      && source.topics.every(topic => typeof topic === 'string' && topic.length > 0 && topic.length <= 100), 'source_metadata')
    requireKnowledge(source.documentDate === null || (typeof source.documentDate === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(source.documentDate) && Number.isFinite(Date.parse(source.documentDate))
      && new Date(source.documentDate).toISOString().slice(0, 10) === source.documentDate), 'source_date')
    requireKnowledge(source.effectiveAt === null || (typeof source.effectiveAt === 'string'
      && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(source.effectiveAt)
      && Number.isFinite(Date.parse(source.effectiveAt))), 'source_date')
    requireKnowledge(Array.isArray(source.supersedes) && source.supersedes.length <= 30
      && source.supersedes.every(path => sourcePath(path) && path !== source.path), 'source_relation')
    paths.add(source.path)
  }
  return manifest
}

/** UTF-16 offsets and 1-based physical lines refer to the exact stored text, including CRLF. */
export function splitDocument(body: string, markdown = true): DocumentSection[] {
  const lines = body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)?.filter(line => line.length > 0) ?? []
  const sections: DocumentSection[] = []
  const headings: { depth: number; text: string }[] = []
  let offset = 0, start = 0, startLine = 1, lineNo = 0, fence: string | undefined
  let sectionHeadings: string[] = []
  function flush() {
    if (offset === start) return
    sections.push({ ordinal: sections.length, headings: [...sectionHeadings], startLine, endLine: lineNo,
      startOffset: start, endOffset: offset, text: body.slice(start, offset) })
    start = offset
    startLine = lineNo + 1
  }
  for (const line of lines) {
    requireKnowledge(line.length <= KNOWLEDGE_LIMITS.sectionChars, 'line_too_long')
    const structuralLine = lineNo === 0 ? line.replace(/^\uFEFF/, '') : line
    const marker = markdown ? /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n|\r)?$/.exec(structuralLine) : null
    const heading = markdown && !fence && !marker ? /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|\r)?$/.exec(structuralLine) : null
    if (heading) {
      flush()
      const depth = heading[1]!.length
      while (headings.length && headings[headings.length - 1]!.depth >= depth) headings.pop()
      headings.push({ depth, text: heading[2]!.trim() })
      sectionHeadings = headings.map(item => item.text)
    }
    if (offset - start + line.length > KNOWLEDGE_LIMITS.sectionChars) flush()
    offset += line.length
    lineNo++
    if (marker) {
      if (!fence) fence = marker[1]!
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && marker[2]!.trim() === '') fence = undefined
    }
  }
  flush()
  return sections
}
export function documentRevision(source: SourceSpec, hash: string): string {
  return sha256(JSON.stringify([KNOWLEDGE_FORMAT, hash, source.path, source.kind, source.environment,
    source.topics, source.documentDate, source.effectiveAt, source.supersedes]))
}
export async function loadDocuments(root: string, manifest: ImportManifest, sourceCommit: string | null = null): Promise<SourceDocument[]> {
  parseManifest(manifest)
  requireKnowledge(sourceCommit === null || /^[a-f0-9]{40,64}$/.test(sourceCommit), 'commit_invalid')
  const documents: SourceDocument[] = []
  let total = 0
  for (const source of manifest.sources) {
    const path = await resolveSandboxPath({ root }, source.path)
    let parent = root
    for (const part of source.path.split('/')) {
      parent = join(parent, part)
      requireKnowledge(!(await lstat(parent)).isSymbolicLink(), 'symlink')
    }
    const handle = await open(path, 'r')
    let bytes: Buffer
    try {
      const before = await handle.stat()
      requireKnowledge(before.isFile() && before.size <= KNOWLEDGE_LIMITS.fileBytes, 'file_size')
      const buffer = Buffer.alloc(KNOWLEDGE_LIMITS.fileBytes + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      const after = await handle.stat()
      requireKnowledge(length <= KNOWLEDGE_LIMITS.fileBytes && length === before.size
        && after.size === before.size && after.mtimeMs === before.mtimeMs, 'source_changed')
      bytes = buffer.subarray(0, length)
    } finally { await handle.close() }
    total += bytes.length
    requireKnowledge(total <= KNOWLEDGE_LIMITS.totalBytes, 'total_size')
    const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    requireKnowledge(body.trim().length > 0 && !body.includes('\0'), 'source_text')
    const sourceHash = sha256(bytes)
    documents.push({ source, body, sourceHash, revision: documentRevision(source, sourceHash), sourceCommit,
      sections: splitDocument(body, source.path.endsWith('.md')) })
  }
  return documents
}
