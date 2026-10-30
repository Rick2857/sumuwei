/** A separately provisioned PostgreSQL database; no Kernel migrations, model, or character-memory writes. */
import pg from 'pg'
import { documentRevision, KNOWLEDGE_FORMAT, parseManifest, requireKnowledge, sha256, splitDocument, type SourceDocument } from './documents.ts'

export function validateKnowledgeTarget(url: string, expectedDatabase: string): URL {
  const parsed = new URL(url)
  requireKnowledge(['postgres:', 'postgresql:'].includes(parsed.protocol) && !!parsed.hostname && !!parsed.username
    && parsed.search === '' && parsed.hash === ''
    && /^(?:lg_knowledge_|lg_test_)[a-z0-9_]+$/.test(expectedDatabase)
    && decodeURIComponent(parsed.pathname.slice(1)) === expectedDatabase, 'database_target')
  return parsed
}
export async function openKnowledgeDatabase(url: string, expectedDatabase: string): Promise<pg.Pool> {
  const target = validateKnowledgeTarget(url, expectedDatabase)
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30000 })
  try {
    const identity = (await pool.query(`select current_database() as db, current_user as usr,
      (select rolsuper from pg_roles where rolname=current_user) as superuser,
      exists(select 1 from pg_tables where schemaname='public') as public_tables`)).rows[0]
    requireKnowledge(identity.db === expectedDatabase && identity.usr === decodeURIComponent(target.username)
      && identity.superuser === false && identity.public_tables === false, 'database_identity')
    return pool
  } catch (error) { await pool.end(); throw error }
}

export async function initializeKnowledgeDatabase(pool: pg.Pool, libraryId: string): Promise<void> {
  requireKnowledge(/^[a-z][a-z0-9-]{0,63}$/.test(libraryId), 'library_id')
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtext('project-knowledge-sync'))")
    await client.query(`create schema if not exists project_knowledge;
      create table if not exists project_knowledge.library (
        singleton boolean primary key default true check(singleton), library_id text not null, format text not null);
      create table if not exists project_knowledge.documents (
        path text primary key, current_revision text, removed_at timestamptz);
      create table if not exists project_knowledge.revisions (
        path text not null references project_knowledge.documents(path), revision text not null,
        source_hash text not null, source_commit text, metadata jsonb not null, body text not null,
        imported_at timestamptz not null default now(), primary key(path, revision));
      create table if not exists project_knowledge.sections (
        path text not null, revision text not null, ordinal integer not null, headings jsonb not null,
        start_line integer not null, end_line integer not null, start_offset integer not null, end_offset integer not null,
        body text not null, primary key(path, revision, ordinal),
        foreign key(path, revision) references project_knowledge.revisions(path, revision));`)
    await client.query('insert into project_knowledge.library(singleton,library_id,format) values(true,$1,$2) on conflict do nothing', [libraryId, KNOWLEDGE_FORMAT])
    await assertLibrary(client, libraryId)
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error }
  finally { client.release() }
}
async function assertLibrary(pool: pg.Pool | pg.PoolClient, libraryId: string): Promise<void> {
  const row = (await pool.query('select library_id,format from project_knowledge.library')).rows[0]
  requireKnowledge(row?.library_id === libraryId && row?.format === KNOWLEDGE_FORMAT, 'library_mismatch')
}

export async function syncKnowledgeDocuments(pool: pg.Pool, libraryId: string, documents: SourceDocument[]) {
  parseManifest({ version: 1, libraryId, sources: documents.map(doc => doc.source) })
  for (const doc of documents) {
    requireKnowledge(sha256(doc.body) === doc.sourceHash && documentRevision(doc.source, doc.sourceHash) === doc.revision
      && JSON.stringify(splitDocument(doc.body, doc.source.path.endsWith('.md'))) === JSON.stringify(doc.sections), 'snapshot_invalid')
  }
  const counts = { added: 0, updated: 0, unchanged: 0, removed: 0, documents: documents.length, sections: 0 }
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtext('project-knowledge-sync'))")
    await assertLibrary(client, libraryId)
    for (const doc of documents) {
      const old = (await client.query('select current_revision,removed_at from project_knowledge.documents where path=$1', [doc.source.path])).rows[0]
      counts.sections += doc.sections.length
      if (old?.current_revision === doc.revision && old.removed_at === null) { counts.unchanged++; continue }
      if (!old) counts.added++; else counts.updated++
      await client.query('insert into project_knowledge.documents(path) values($1) on conflict do nothing', [doc.source.path])
      const inserted = await client.query(`insert into project_knowledge.revisions(path,revision,source_hash,source_commit,metadata,body)
        values($1,$2,$3,$4,$5,$6) on conflict do nothing returning revision`,
      [doc.source.path, doc.revision, doc.sourceHash, doc.sourceCommit, JSON.stringify(doc.source), doc.body])
      if (inserted.rowCount) for (const section of doc.sections) {
        await client.query(`insert into project_knowledge.sections
          (path,revision,ordinal,headings,start_line,end_line,start_offset,end_offset,body) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [doc.source.path, doc.revision, section.ordinal, JSON.stringify(section.headings), section.startLine, section.endLine,
          section.startOffset, section.endOffset, section.text])
      }
      await client.query('update project_knowledge.documents set current_revision=$2,removed_at=null where path=$1', [doc.source.path, doc.revision])
    }
    counts.removed = (await client.query(`update project_knowledge.documents set removed_at=now()
      where removed_at is null and not(path=any($1::text[]))`, [documents.map(doc => doc.source.path)])).rowCount ?? 0
    await client.query('commit')
    return counts
  } catch (error) { await client.query('rollback'); throw error }
  finally { client.release() }
}
export async function listKnowledgeDocuments(pool: pg.Pool) {
  return (await pool.query(`select d.path,d.current_revision as revision,r.source_hash,r.source_commit,r.metadata,r.imported_at,
    (select count(*)::int from project_knowledge.sections s where s.path=d.path and s.revision=d.current_revision) as sections
    from project_knowledge.documents d join project_knowledge.revisions r on r.path=d.path and r.revision=d.current_revision
    where d.removed_at is null order by d.path`)).rows
}
export async function listKnowledgeRevisions(pool: pg.Pool, path: string) {
  return (await pool.query(`select r.revision,r.source_hash,r.source_commit,r.metadata,r.imported_at,
    (d.removed_at is null and d.current_revision=r.revision) as is_current
    from project_knowledge.revisions r join project_knowledge.documents d on d.path=r.path
    where r.path=$1 order by r.imported_at,r.revision`, [path])).rows
}
export async function readKnowledgeDocument(pool: pg.Pool, path: string, revision?: string) {
  const row = (await pool.query(`select r.* from project_knowledge.revisions r
    join project_knowledge.documents d on d.path=r.path where r.path=$1 and
    (($2::text is null and d.removed_at is null and r.revision=d.current_revision) or r.revision=$2::text)`, [path, revision ?? null])).rows[0]
  if (!row) return null
  const sections = (await pool.query(`select ordinal,headings,start_line,end_line,start_offset,end_offset,body
    from project_knowledge.sections where path=$1 and revision=$2 order by ordinal`, [path, row.revision])).rows
  const expected = splitDocument(row.body, path.endsWith('.md'))
  requireKnowledge(sha256(row.body) === row.source_hash && documentRevision(row.metadata, row.source_hash) === row.revision
    && sections.length === expected.length && sections.every((section, index) => {
      const e = expected[index]!
      return section.ordinal === e.ordinal && JSON.stringify(section.headings) === JSON.stringify(e.headings)
        && section.start_line === e.startLine && section.end_line === e.endLine
        && section.start_offset === e.startOffset && section.end_offset === e.endOffset && section.body === e.text
    }), 'stored_snapshot_invalid')
  return { ...row, sections }
}
