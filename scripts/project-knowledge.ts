/** Explicit offline administration. Never loads .env or falls back to POSTGRES_URL. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadDocuments, parseManifest, requireKnowledge } from '../src/infrastructure/project-knowledge/documents.ts'
import { initializeKnowledgeDatabase, listKnowledgeDocuments, listKnowledgeRevisions, openKnowledgeDatabase, readKnowledgeDocument, syncKnowledgeDocuments } from '../src/infrastructure/project-knowledge/store.ts'

export async function runProjectKnowledge(args: string[], env = process.env): Promise<void> {
  const [command, ...options] = args
  requireKnowledge(['init', 'sync', 'list', 'history', 'read'].includes(command ?? ''), 'command')
  const allowed = command === 'init' || command === 'sync' ? ['--manifest', '--root', '--source-commit']
    : command === 'read' ? ['--path', '--revision'] : command === 'history' ? ['--path'] : []
  const values = new Map<string, string>()
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i]!, value = options[i + 1]
    requireKnowledge(allowed.includes(key) && value && !value.startsWith('--') && !values.has(key), 'arguments')
    values.set(key, value)
  }
  let manifest, documents
  if (command === 'init' || command === 'sync') {
    const path = values.get('--manifest')
    requireKnowledge(path, 'manifest_required')
    manifest = parseManifest(JSON.parse(await readFile(path, 'utf8')))
    // Read the complete allowlist before connecting: a missing source never becomes a deletion.
    if (command === 'sync') documents = await loadDocuments(resolve(values.get('--root') ?? '.'), manifest, values.get('--source-commit') ?? null)
  }
  if (command === 'read' || command === 'history') requireKnowledge(values.get('--path'), 'path_required')
  const url = env.LG_PROJECT_KNOWLEDGE_URL, database = env.LG_PROJECT_KNOWLEDGE_DATABASE
  requireKnowledge(url && database, 'database_configuration')
  const pool = await openKnowledgeDatabase(url, database)
  try {
    let result: unknown
    if (command === 'init') { await initializeKnowledgeDatabase(pool, manifest!.libraryId); result = { initialized: true, database } }
    else if (command === 'sync') result = await syncKnowledgeDocuments(pool, manifest!.libraryId, documents!)
    else if (command === 'list') result = await listKnowledgeDocuments(pool)
    else if (command === 'history') result = await listKnowledgeRevisions(pool, values.get('--path')!)
    else result = await readKnowledgeDocument(pool, values.get('--path')!, values.get('--revision'))
    console.log(JSON.stringify(result, null, 2))
  } finally { await pool.end() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProjectKnowledge(process.argv.slice(2)).catch(error => {
    const message = error instanceof Error && error.message.startsWith('project_knowledge_') ? error.message : 'project_knowledge_failed'
    console.error(message) // No connection strings, source body, or pg error detail.
    process.exitCode = 1
  })
}
