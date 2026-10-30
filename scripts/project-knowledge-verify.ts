/** Real PostgreSQL in serversim's dedicated pgtest instance; zero model/channel requests. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { withKnowledgeTestDatabase as withPgTestInInstance } from './project-knowledge-test-db.ts'
import { KNOWLEDGE_LIMITS, loadDocuments, parseManifest, splitDocument, type ImportManifest, type SourceSpec } from '../src/infrastructure/project-knowledge/documents.ts'
import { initializeKnowledgeDatabase, listKnowledgeDocuments, openKnowledgeDatabase, readKnowledgeDocument,
  syncKnowledgeDocuments, validateKnowledgeTarget } from '../src/infrastructure/project-knowledge/store.ts'

const checks: string[] = []
async function check(name: string, run: () => unknown | Promise<unknown>) {
  await run(); checks.push(name); console.log(`PASS ${name}`)
}
const out = resolve('artifacts/local/project-knowledge-p1')
await mkdir(out, { recursive: true })
await writeFile(join(out, 'verification.json'), JSON.stringify({ status: 'RUNNING', ranAt: new Date().toISOString() }))
const adminUrl = process.env.LG_SIM_PGTEST_ADMIN_URL ?? ''
assert.equal(new URL(adminUrl).hostname, 'pgtest', 'serversim dedicated pgtest required; no fallback')
const root = await mkdtemp(join(tmpdir(), 'lg-knowledge-'))
await mkdir(join(root, 'docs'), { recursive: true })
const spec = (path: string): SourceSpec => ({ path, kind: 'acceptance', environment: 'synthetic', topics: ['fixture'],
  documentDate: null, effectiveAt: null, supersedes: [] })
const manifest: ImportManifest = { version: 1, libraryId: 'project-lg', sources: [spec('docs/a.md'), spec('docs/b.md')] }
const original = '\uFEFF# A\r\n原文 😀\r\n```ts\r\n# 代码不是标题\r\n```\r\n## 子节\r\n尚未观察。\r\n'
const manifestPath = join(root, 'manifest.json')
await writeFile(manifestPath, JSON.stringify(manifest))
await writeFile(join(root, 'docs/a.md'), original)
await writeFile(join(root, 'docs/b.md'), '# B\n旧报告。\n')
let identity: { database: string; role: string } | undefined
let corpus: unknown
const admin = new pg.Pool({ connectionString: adminUrl, max: 1 })
try {
  await check('manifest rejects traversal, secret paths, duplicate sources, unknown fields and empty imports', () => {
    for (const path of ['docs/../.env.md', 'C:/secrets.md', '.env', 'docs/.secret.md', 'src/config.env']) {
      assert.throws(() => parseManifest({ ...manifest, sources: [spec(path)] }))
    }
    assert.throws(() => parseManifest({ ...manifest, sources: [spec('docs/a.md'), spec('docs/a.md')] }))
    assert.throws(() => parseManifest({ ...manifest, sources: [] }))
    assert.throws(() => parseManifest({ ...manifest, sources: [{ ...spec('docs/a.md'), enabled: true }] }))
  })
  await check('invalid dates rejected; dates and file names never infer effective capability status', () => {
    assert.throws(() => parseManifest({ ...manifest, sources: [{ ...spec('docs/a.md'), documentDate: '2026-02-30' }] }))
    const source = parseManifest(manifest).sources[0]!
    assert.equal(source.effectiveAt, null)
    assert.equal('available' in source, false)
  })
  await check('sections preserve BOM, CRLF, Unicode, exact coverage, nested headings and fenced code', () => {
    const sections = splitDocument(original)
    assert.equal(sections.length, 2)
    assert.deepEqual(sections[1]!.headings, ['A', '子节'])
    assert.equal(sections[1]!.startLine, 6)
    assert.equal(sections.map(s => s.text).join(''), original)
    for (const s of sections) assert.equal(original.slice(s.startOffset, s.endOffset), s.text)
  })
  await check('large sections split without losing bytes; overlong lines fail instead of truncating', () => {
    const text = '# 大节\n' + '内容\n'.repeat(10000)
    const sections = splitDocument(text)
    assert.ok(sections.length > 1)
    assert.ok(sections.every(s => s.text.length <= KNOWLEDGE_LIMITS.sectionChars))
    assert.equal(sections.map(s => s.text).join(''), text)
    assert.throws(() => splitDocument('x'.repeat(KNOWLEDGE_LIMITS.sectionChars + 1)), /line_too_long/)
  })
  await check('symlinks rejected, including an inside-root link to a secret file', async () => {
    await writeFile(join(root, '.env'), 'do-not-import')
    await symlink(join(root, '.env'), join(root, 'docs/link.md'))
    await assert.rejects(loadDocuments(root, { ...manifest, sources: [spec('docs/link.md')] }), /symlink/)
  })
  await check('invalid UTF-8 and oversized files rejected before publishing', async () => {
    await writeFile(join(root, 'docs/invalid.md'), Buffer.from([255]))
    await assert.rejects(loadDocuments(root, { ...manifest, sources: [spec('docs/invalid.md')] }))
    await writeFile(join(root, 'docs/large.md'), Buffer.alloc(KNOWLEDGE_LIMITS.fileBytes + 1, 65))
    await assert.rejects(loadDocuments(root, { ...manifest, sources: [spec('docs/large.md')] }), /file_size/)
  })
  await check('database names and expected identity checked before connection', () => {
    assert.throws(() => validateKnowledgeTarget('postgresql://u:p@pgtest/sumuwei', 'sumuwei'), /database_target/)
    assert.throws(() => validateKnowledgeTarget('postgresql://u:p@pgtest/lg_test_a', 'lg_test_b'), /database_target/)
    assert.throws(() => validateKnowledgeTarget('postgresql://u:p@pgtest/lg_test_a?database=sumuwei', 'lg_test_a'), /database_target/)
  })
  await withPgTestInInstance(adminUrl, 'knowledge', async test => {
    identity = { database: test.database, role: decodeURIComponent(new URL(test.url).username) }
    const pool = await openKnowledgeDatabase(test.url, test.database)
    const second = await openKnowledgeDatabase(test.url, test.database)
    const load = () => loadDocuments(root, manifest)
    const revisionCount = async () => Number((await pool.query('select count(*)::int as n from project_knowledge.revisions')).rows[0].n)
    try {
      await check('opening a database is read-only; initialization is explicit and idempotent', async () => {
        assert.equal((await pool.query("select to_regnamespace('project_knowledge') as s")).rows[0].s, null)
        await initializeKnowledgeDatabase(pool, manifest.libraryId)
        await initializeKnowledgeDatabase(pool, manifest.libraryId)
      })
      await check('initial import stores exact source, sections and content fingerprints', async () => {
        const result = await syncKnowledgeDocuments(pool, manifest.libraryId, await load())
        assert.equal(result.added, 2)
        const row = await readKnowledgeDocument(pool, 'docs/a.md')
        assert.equal(row.body, original)
        assert.equal(row.sections.map((s: { body: string }) => s.body).join(''), original)
        assert.equal(row.metadata.effectiveAt, null)
      })
      await check('unchanged reimport adds zero revisions and preserves import timestamps', async () => {
        const before = await listKnowledgeDocuments(pool)
        const result = await syncKnowledgeDocuments(pool, manifest.libraryId, await load())
        assert.equal(result.unchanged, 2)
        assert.equal(await revisionCount(), 2)
        assert.deepEqual(await listKnowledgeDocuments(pool), before)
      })
      const oldRevision = (await readKnowledgeDocument(pool, 'docs/a.md')).revision as string
      await check('changed source creates a new revision; old original remains readable', async () => {
        await writeFile(join(root, 'docs/a.md'), '# A\n新版本，生产仍未验证。\n')
        const result = await syncKnowledgeDocuments(pool, manifest.libraryId, await load())
        assert.equal(result.updated, 1)
        assert.equal(result.unchanged, 1)
        assert.equal((await readKnowledgeDocument(pool, 'docs/a.md', oldRevision)).body, original)
        assert.notEqual((await readKnowledgeDocument(pool, 'docs/a.md')).revision, oldRevision)
      })
      await check('metadata-only changes version correctly; supersedes relation is explicit', async () => {
        manifest.sources[0]!.supersedes = ['docs/earlier.md']
        assert.equal((await syncKnowledgeDocuments(pool, manifest.libraryId, await load())).updated, 1)
        assert.deepEqual((await readKnowledgeDocument(pool, 'docs/a.md')).metadata.supersedes, ['docs/earlier.md'])
      })
      await check('manifest removal revokes current visibility; historical revision remains available', async () => {
        const b = await readKnowledgeDocument(pool, 'docs/b.md')
        assert.equal((await syncKnowledgeDocuments(pool, manifest.libraryId, (await load()).slice(0, 1))).removed, 1)
        assert.equal(await readKnowledgeDocument(pool, 'docs/b.md'), null)
        assert.ok(await readKnowledgeDocument(pool, 'docs/b.md', b.revision))
        assert.equal((await listKnowledgeDocuments(pool)).length, 1)
        const before = await revisionCount()
        await syncKnowledgeDocuments(pool, manifest.libraryId, await load())
        assert.equal(await revisionCount(), before)
      })
      await check('a declared missing file fails the complete import without revoking existing documents', async () => {
        const before = await listKnowledgeDocuments(pool)
        await assert.rejects(loadDocuments(root, { ...manifest, sources: [...manifest.sources, spec('docs/missing.md')] }))
        assert.deepEqual(await listKnowledgeDocuments(pool), before)
      })
      await check('library identity and corrupted candidate snapshots fail closed', async () => {
        await assert.rejects(initializeKnowledgeDatabase(pool, 'wrong-library'), /library_mismatch/)
        const documents = await load()
        documents[0]!.sections[0]!.text = 'forged'
        await assert.rejects(syncKnowledgeDocuments(pool, manifest.libraryId, documents), /snapshot_invalid/)
      })
      await check('mid-import SQL failure rolls back newly inserted revisions and current pointers', async () => {
        const before = await listKnowledgeDocuments(pool), count = await revisionCount()
        await pool.query(`create function project_knowledge.fail_import() returns trigger language plpgsql as $$
          begin if new.path='docs/b.md' then raise exception 'injected'; end if; return new; end $$;
          create trigger reject_b before insert on project_knowledge.revisions
          for each row execute function project_knowledge.fail_import()`)
        await writeFile(join(root, 'docs/a.md'), '# A\n回滚候选。\n')
        await writeFile(join(root, 'docs/b.md'), '# B\n故障候选。\n')
        await assert.rejects(syncKnowledgeDocuments(pool, manifest.libraryId, await load()), /injected/)
        assert.deepEqual(await listKnowledgeDocuments(pool), before)
        assert.equal(await revisionCount(), count)
        await pool.query('drop trigger reject_b on project_knowledge.revisions; drop function project_knowledge.fail_import()')
        assert.equal((await syncKnowledgeDocuments(pool, manifest.libraryId, await load())).updated, 2)
      })
      await check('concurrent publishers commit one complete snapshot at a time', async () => {
        const a = await load()
        await writeFile(join(root, 'docs/a.md'), '# A\n并发版本。\n')
        await writeFile(join(root, 'docs/b.md'), '# B\n并发版本。\n')
        const b = await load()
        await Promise.all([syncKnowledgeDocuments(pool, manifest.libraryId, a), syncKnowledgeDocuments(second, manifest.libraryId, b)])
        const actual = (await listKnowledgeDocuments(pool)).map(row => row.revision)
        assert.ok([a, b].some(snapshot => JSON.stringify(snapshot.map(doc => doc.revision)) === JSON.stringify(actual)))
      })
      await check('stored content corruption is detected; restoring real content restores readback', async () => {
        const row = await readKnowledgeDocument(pool, 'docs/a.md')
        await pool.query("update project_knowledge.sections set body='forged' where path=$1 and revision=$2 and ordinal=0", [row.path, row.revision])
        await assert.rejects(readKnowledgeDocument(pool, row.path), /stored_snapshot_invalid/)
        await pool.query('update project_knowledge.sections set body=$3 where path=$1 and revision=$2 and ordinal=0', [row.path, row.revision, row.sections[0].body])
        assert.equal((await readKnowledgeDocument(pool, row.path)).body, row.body)
      })
      await check('databases containing public application tables are refused before DDL', async () => {
        await pool.query('create table public.conversation_events(id int)')
        await assert.rejects(openKnowledgeDatabase(test.url, test.database), /database_identity/)
        await pool.query('drop table public.conversation_events')
      })
      await check('real CLI sync/list/read works; no POSTGRES_URL fallback and no secret in failures', () => {
        const cli = (args: string[], configured = true) => spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs', 'scripts/project-knowledge.ts', ...args], {
          encoding: 'utf8', timeout: 30000, env: { ...process.env, POSTGRES_URL: test.url,
            LG_PROJECT_KNOWLEDGE_URL: configured ? test.url : '', LG_PROJECT_KNOWLEDGE_DATABASE: test.database },
        })
        const result = cli(['sync', '--manifest', manifestPath, '--root', root])
        assert.equal(result.status, 0, result.stderr)
        assert.equal(JSON.parse(result.stdout).documents, 2)
        assert.equal(JSON.parse(cli(['sync', '--manifest', manifestPath, '--root', root]).stdout).unchanged, 2)
        assert.equal(cli(['list']).status, 0)
        assert.ok(JSON.parse(cli(['history', '--path', 'docs/a.md']).stdout).length > 1)
        assert.equal(JSON.parse(cli(['read', '--path', 'docs/a.md']).stdout).body, '# A\n并发版本。\n')
        const denied = cli(['list'], false)
        assert.notEqual(denied.status, 0)
        assert.match(denied.stderr, /database_configuration/)
        assert.equal((denied.stdout + denied.stderr).includes(new URL(test.url).password), false)
      })
      await check('first real LG corpus imports, every revision and section reads back, second import is unchanged', async () => {
        const realManifest = parseManifest(JSON.parse(await readFile('docs/project-knowledge/import-manifest.json', 'utf8')))
        const documents = await loadDocuments(process.cwd(), realManifest)
        const first = await syncKnowledgeDocuments(pool, realManifest.libraryId, documents)
        for (const doc of documents) assert.equal((await readKnowledgeDocument(pool, doc.source.path)).source_hash, doc.sourceHash)
        const repeated = await syncKnowledgeDocuments(pool, realManifest.libraryId, documents)
        assert.equal(repeated.unchanged, documents.length)
        assert.ok(documents.length > 0 && repeated.sections > 0)
        corpus = { first, repeated, sources: documents.map(doc => ({ path: doc.source.path, revision: doc.revision, sourceHash: doc.sourceHash, sections: doc.sections.length })) }
      })
    } finally { await second.end(); await pool.end() }
  })
  await check('disposable database and its unique role are actually removed', async () => {
    assert.ok(identity)
    assert.equal((await admin.query('select count(*)::int as n from pg_database where datname=$1', [identity.database])).rows[0].n, 0)
    assert.equal((await admin.query('select count(*)::int as n from pg_roles where rolname=$1', [identity.role])).rows[0].n, 0)
  })
} catch (error) {
  await writeFile(join(out, 'verification.json'), JSON.stringify({ status: 'FAIL', checks, identity }))
  throw error
} finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
await writeFile(join(out, 'verification.json'), JSON.stringify({ status: 'PASS', ranAt: new Date().toISOString(),
    location: 'serversim/simhost', backend: 'isolated-postgresql/pgtest', modelRequests: 0,
    identity, cleanup: { database: 0, role: 0 }, checks, corpus }, null, 2))
console.log(`PASS ${checks.length} checks; evidence=${out}`)
