import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildBackupManifest, verifyBackupFile, type BackupManifest } from '../postgresql/backup.ts'
import { readTargetCatalog, readTargetTableRows } from '../postgresql/pg-target-reader.ts'
import { tableDigest } from '../postgresql/row-digest.ts'

interface Target { container: string; database: string; user: string }
const ident = (value: string): string => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value)) throw new Error('backup_invalid_identifier')
  return value
}
function command(target: Target, program: string, args: string[], input?: string, output?: number): string {
  const result = spawnSync('docker', ['exec', '-i', '-e', 'PGOPTIONS=-c lg.scope_mode=system', target.container, program,
    '-U', target.user, '-d', target.database, ...args], {
    input, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    ...(output === undefined ? {} : { stdio: ['pipe', output, 'pipe'] as const }),
  })
  // stderr may include SQL/data; expose a closed reason rather than its body.
  if (result.status !== 0 || result.error) throw new Error(`backup_${program}_failed`)
  return String(result.stdout ?? '').trim()
}
function query(target: Target, sql: string, snapshot?: string): string {
  if (snapshot && !/^[0-9A-Fa-f-]+$/.test(snapshot)) throw new Error('backup_bad_snapshot')
  return command(target, 'psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1'],
    `begin isolation level repeatable read read only; ${snapshot ? `set transaction snapshot '${snapshot}';` : ''}
     set local timezone='UTC'; set local extra_float_digits=3; ${sql}; commit;`)
}
async function holdSnapshot(target: Target): Promise<{ id: string; close: () => Promise<void> }> {
  const child = spawn('docker', ['exec', '-i', '-e', 'PGOPTIONS=-c lg.scope_mode=system', target.container, 'psql',
    '-U', target.user, '-d', target.database, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true })
  child.stderr.resume()
  child.stdin.on('error', () => undefined)
  const exited = new Promise<void>((done, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? done() : reject(new Error('backup_snapshot_holder_failed')))
  })
  void exited.catch(() => undefined)
  const id = await new Promise<string>((done, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('backup_snapshot_timeout')) }, 15_000)
    let text = ''
    child.stdout.on('data', data => {
      text += data.toString()
      const found = text.match(/^([0-9A-Fa-f-]+)\r?\n/m)
      if (found) { clearTimeout(timeout); done(found[1]) }
    })
    child.once('error', () => { clearTimeout(timeout); reject(new Error('backup_snapshot_spawn_failed')) })
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('backup_snapshot_holder_closed')) })
    child.stdin.write('begin isolation level repeatable read read only; select pg_export_snapshot();\n')
  })
  return { id, close: async () => { child.stdin.end('rollback;\n'); await exited } }
}
function digest(target: Target, snapshot?: string) {
  const run = (sql: string) => query(target, sql, snapshot)
  const schemas = JSON.parse(run(`select coalesce(json_agg(nspname order by nspname),'[]') from pg_namespace
    where nspname not like 'pg_%' and nspname <> 'information_schema'`)) as string[]
  const base = new Set<string>(JSON.parse(run(`select coalesce(json_agg(n.nspname||'.'||c.relname),'[]')
    from pg_class c join pg_namespace n on c.relnamespace=n.oid where c.relkind in ('r','p')
    and n.nspname not like 'pg_%' and n.nspname <> 'information_schema'`)))
  const catalog = readTargetCatalog(run, schemas)
  if (!catalog || base.size === 0) throw new Error('backup_catalog_empty')
  if ([...catalog.keys()].filter(name => base.has(name)).length !== base.size) throw new Error('backup_catalog_incomplete')
  return [...catalog.entries()].filter(([name]) => base.has(name)).sort(([a], [b]) => a.localeCompare(b)).map(([name, spec]) => {
    const [schema, table] = name.split('.')
    const rows = readTargetTableRows(run, schema, table, spec.columns)
    if (!rows) throw new Error('backup_table_read_failed')
    return { ...tableDigest({ table: name, rows, ...spec }), columns: spec.columns, primaryKey: spec.primaryKey }
  })
}
const dumpArgs = ['--format=plain', '--no-owner', '--no-privileges', '--no-comments', '--enable-row-security']
function dump(target: Target, file: string, snapshot?: string, schemaOnly = false): void {
  const fd = openSync(file, 'wx')
  try { command(target, 'pg_dump', [...dumpArgs, ...(snapshot ? [`--snapshot=${snapshot}`] : []),
    ...(schemaOnly ? ['--schema-only'] : [])], undefined, fd) } finally { closeSync(fd) }
}
function schemaHash(file: string): string {
  // pg_dump adds a fresh psql restrict key on every run; it is not schema state.
  const sql = readFileSync(file, 'utf8').replace(/^\\(?:un)?restrict .*\r?\n/gm, '')
  return createHash('sha256').update(sql).digest('hex')
}
function inspect(container: string): { Id: string; Image: string; Mounts: { Source: string; Destination: string }[] } {
  const r = spawnSync('docker', ['inspect', container], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (r.status !== 0) throw new Error('backup_container_inspect_failed')
  return JSON.parse(r.stdout)[0]
}
export async function backup(target: Target, out: string): Promise<void> {
  ident(target.database); ident(target.user)
  if (existsSync(join(out, 'manifest.json')) || existsSync(join(out, 'dump.sql'))) throw new Error('backup_output_exists')
  mkdirSync(out, { recursive: true })
  const instance = inspect(target.container)
  const snapshot = await holdSnapshot(target)
  let manifest
  try {
    const identity = JSON.parse(query(target, `select json_build_object('database',current_database(),'user',current_user,
      'serverVersion',current_setting('server_version'),'host',coalesce(inet_server_addr()::text,'local'),
      'port',current_setting('port'),'vectorVersion',(select extversion from pg_extension where extname='vector'))`, snapshot.id))
    dump(target, join(out, 'dump.sql'), snapshot.id)
    const tables = digest(target, snapshot.id)
    dump(target, join(out, 'schema.sql'), snapshot.id, true)
    manifest = { kind: 'project-lg/pg-verified-backup', version: 2,
      source: { ...target, instanceId: instance.Id, image: instance.Image,
        mounts: instance.Mounts.map(m => ({ source: m.Source, destination: m.Destination })) },
      snapshot: snapshot.id, capturedAt: new Date().toISOString(), tables, schemaSha256: schemaHash(join(out, 'schema.sql')),
      dump: buildBackupManifest({ file: join(out, 'dump.sql'), relativeFile: 'dump.sql', sourceIdentity: identity, dumpArgs }) }
    const valid = verifyBackupFile(join(out, 'dump.sql'), manifest.dump)
    if (!valid.ok) throw new Error(valid.reason)
  } finally { await snapshot.close() }
  // Manifest is the commit marker; a failed dump or unclosed snapshot cannot be promoted.
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
}
export async function verify(manifestFile: string, targetContainer: string, admin: string, keep = false): Promise<void> {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    kind: string; version: number; source: { instanceId: string; mounts: { source: string }[] };
    dump: BackupManifest; tables: ReturnType<typeof digest>; schemaSha256: string
  }
  if (manifest.kind !== 'project-lg/pg-verified-backup' || manifest.version !== 2) throw new Error('backup_manifest_version')
  const dir = dirname(resolve(manifestFile))
  if (manifest.dump.file !== 'dump.sql') throw new Error('backup_dump_path_invalid')
  const file = join(dir, manifest.dump.file)
  const check = verifyBackupFile(file, manifest.dump)
  if (!check.ok) throw new Error(check.reason)
  if (manifest.tables.length === 0) throw new Error('backup_catalog_empty')
  const targetInstance = inspect(targetContainer)
  if (targetInstance.Id === manifest.source.instanceId || targetInstance.Mounts.some(m =>
    manifest.source.mounts.some(s => s.source === m.Source))) throw new Error('backup_restore_target_not_isolated')
  const database = `lg_restore_verify_${randomUUID().replaceAll('-', '')}`
  const target = { container: targetContainer, database, user: ident(admin) }
  command({ ...target, database: 'postgres' }, 'psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1'],
    `create database "${database}" template template0;`)
  let passed = false
  const startedAt = Date.now()
  try {
    command(target, 'psql', ['-Xq', '-v', 'ON_ERROR_STOP=1', '--single-transaction'], readFileSync(file, 'utf8'))
    const tables = digest(target)
    if (JSON.stringify(tables) !== JSON.stringify(manifest.tables)) throw new Error('backup_restored_content_mismatch')
    const schemaFile = join(dir, `schema-${database}.sql`)
    dump(target, schemaFile, undefined, true)
    if (schemaHash(schemaFile) !== manifest.schemaSha256) throw new Error('backup_restored_schema_mismatch')
    writeFileSync(join(dir, 'restore-verification.json'), JSON.stringify({ status: 'PASS', verifiedAt: new Date().toISOString(),
      dumpSha256: check.sha256, targetInstance: targetInstance.Id, database, tableCount: tables.length,
      totalRows: tables.reduce((n, t) => n + t.rowCount, 0), restoreMs: Date.now() - startedAt,
      fieldsAndSchemaVerified: true, productionRestored: false }, null, 2) + '\n')
    passed = true
  } finally {
    if (!keep || !passed) command({ ...target, database: 'postgres' }, 'psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1'],
      `drop database "${database}";`)
  }
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('backup --out NEW_DIR [--container NAME --db NAME --user ROLE]\nverify --manifest FILE --target-container ISOLATED_CONTAINER [--admin ROLE --keep]')
    return
  }
  const opts: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keep') { opts.keep = 'true'; continue }
    if (!['--container', '--db', '--user', '--out', '--manifest', '--target-container', '--admin'].includes(args[i]) || !args[i + 1]) {
      throw new Error('backup_invalid_argument')
    }
    opts[args[i].slice(2)] = args[++i]
  }
  if (mode === 'backup') await backup({ container: opts.container ?? process.env.PG_CONTAINER ?? 'lg-postgresql-production',
    database: opts.db ?? process.env.PGDATABASE ?? 'sumuwei', user: opts.user ?? process.env.PGUSER ?? 'lg_migrate' }, resolve(opts.out ?? './out'))
  else if (mode === 'verify' && opts.manifest && opts['target-container']) await verify(opts.manifest,
    opts['target-container'], opts.admin ?? 'lg_bootstrap', opts.keep === 'true')
  else throw new Error('usage: backup --out DIR | verify --manifest FILE --target-container ISOLATED_CONTAINER [--admin ROLE]')
  console.log(`PASS postgresql ${mode}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
