import type pg from 'pg'
import { listKnowledgeDocuments, openKnowledgeDatabase, readKnowledgeDocument } from './store.ts'
import { KNOWLEDGE_FORMAT, KNOWLEDGE_LIMITS, requireKnowledge } from './documents.ts'

/** The runtime deliberately rejects the importer/owner credentials, even in a test deployment. */
export async function openKnowledgeReader(url: string, database: string): Promise<pg.Pool> {
  const pool = await openKnowledgeDatabase(url, database)
  try {
    const access = (await pool.query(`select
      has_schema_privilege(current_user,'project_knowledge','CREATE') as create_schema,
      exists(select 1 from pg_tables where schemaname='project_knowledge' and
        has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')) as writes,
      exists(select 1 from pg_roles where rolname=current_user and (rolcreatedb or rolcreaterole or rolbypassrls)) as elevated,
      (select library_id from project_knowledge.library) as library_id,
      (select format from project_knowledge.library) as format`)).rows[0]
    requireKnowledge(!access.create_schema && !access.writes && !access.elevated && access.library_id === 'project-lg'
      && access.format === KNOWLEDGE_FORMAT, 'reader_permissions')
    await pool.query('set default_transaction_read_only=on')
    return pool
  } catch (error) { await pool.end(); throw error }
}
export interface ProjectPassage {
  path: string; revision: string; sourceHash: string; ordinal: number; headings: string[]
  metadata: unknown; startLine: number; endLine: number; startOffset: number; endOffset: number
  text: string; truncated: boolean
}
function passage(document: NonNullable<Awaited<ReturnType<typeof readKnowledgeDocument>>>, section: any, terms: string[]): ProjectPassage {
  const lower = section.body.toLocaleLowerCase()
  const positions = terms.map(term => lower.indexOf(term)).filter(position => position >= 0)
  let start = positions.length ? Math.max(0, Math.min(...positions) - 200) : 0
  let end = Math.min(section.body.length, start + 1600)
  if (start && /[\uDC00-\uDFFF]/.test(section.body[start])) start--
  if (end && /[\uD800-\uDBFF]/.test(section.body[end - 1])) end--
  const startOffset = section.start_offset + start, endOffset = section.start_offset + end
  let lastOffset = Math.max(startOffset, endOffset - 1)
  if (document.body[lastOffset] === '\n' && document.body[lastOffset - 1] === '\r') lastOffset--
  return { path: document.path, revision: document.revision, sourceHash: document.source_hash,
    ordinal: section.ordinal, headings: section.headings, metadata: document.metadata,
    startOffset, endOffset, startLine: document.body.slice(0, startOffset).split(/\r\n|\r|\n/).length,
    endLine: document.body.slice(0, lastOffset).split(/\r\n|\r|\n/).length,
    text: section.body.slice(start, end), truncated: start > 0 || end < section.body.length }
}
/** ponytail: bounded lexical baseline over at most 200 documents; compare semantic retrieval before expanding. */
export async function searchProjectKnowledge(pool: pg.Pool, query: string, limit = 3): Promise<ProjectPassage[]> {
  requireKnowledge(query.trim().length > 0 && query.length <= 200 && !query.includes('\0')
    && Number.isInteger(limit) && limit >= 1 && limit <= 3, 'query_invalid')
  const terms = [...new Set([...new Intl.Segmenter('zh', { granularity: 'word' }).segment(query.toLocaleLowerCase())]
    .filter(part => part.isWordLike).map(part => part.segment))].slice(0, 20)
  requireKnowledge(terms.length > 0, 'query_invalid')
  const listed = await listKnowledgeDocuments(pool)
  requireKnowledge(listed.length <= KNOWLEDGE_LIMITS.documents, 'query_scope')
  const ranked: { value: ProjectPassage; score: number }[] = []
  let bytes = 0
  for (const row of listed) {
    const doc = await readKnowledgeDocument(pool, row.path)
    if (!doc) continue // Revoked between the list and immutable-version read.
    bytes += Buffer.byteLength(doc.body)
    requireKnowledge(bytes <= KNOWLEDGE_LIMITS.totalBytes, 'query_scope')
    for (const section of doc.sections) {
      const body = section.body.toLocaleLowerCase(), heading = section.headings.join(' ').toLocaleLowerCase()
      const score = terms.reduce((sum, term) => sum + (body.includes(term) ? 1 : 0)
        + (heading.includes(term) ? 2 : 0) + (row.path.toLocaleLowerCase().includes(term) ? 2 : 0), 0)
      if (score) ranked.push({ value: passage(doc, section, terms), score })
    }
  }
  return ranked.sort((a, b) => b.score - a.score || a.value.path.localeCompare(b.value.path)
    || a.value.ordinal - b.value.ordinal).slice(0, limit).map(row => row.value)
}
export async function readProjectPassage(pool: pg.Pool, path: string, ordinal = 0, revision?: string): Promise<ProjectPassage[]> {
  requireKnowledge(typeof path === 'string' && path.length <= 300 && Number.isInteger(ordinal) && ordinal >= 0
    && (revision === undefined || /^[a-f0-9]{64}$/.test(revision)), 'query_invalid')
  const doc = await readKnowledgeDocument(pool, path, revision)
  const section = doc?.sections.find((item: { ordinal: number }) => item.ordinal === ordinal)
  return doc && section ? [passage(doc, section, [])] : []
}
