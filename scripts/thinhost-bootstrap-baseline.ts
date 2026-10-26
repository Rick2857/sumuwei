/** W0b: upstream schema on a fresh, owned PostgreSQL instance; no production source. */
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { withPgTest } from './postgresql/test-harness.ts'
import { closeDatabaseConnection } from '../src/infrastructure/persistence/runtime-shutdown.ts'

await withPgTest('baseline', async test => {
  const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
  const { character } = await import('../src/character/index.ts')
  const runtime = createThinHostRuntime({
    character: character,
    settings: { POSTGRES_URL: test.url },
  })
  try {
    await runtime.registerPlugin(undefined as never)
    await await __applyKernelMigrations(__getRawDb(runtime))
    const names = ['agents', 'entities', 'worlds', 'rooms', 'participants', 'memories']
    const tables = []
    for (const name of names) {
      const columns = (await test.pool.query(`select a.attname as name, format_type(a.atttypid,a.atttypmod) as type,
        a.attnotnull as not_null, pg_get_expr(d.adbin,d.adrelid) as default
        from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
        left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
        where n.nspname='public' and c.relname=$1 and a.attnum>0 and not a.attisdropped order by a.attnum`, [name])).rows
      const constraints = (await test.pool.query(`select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid=$1::regclass order by conname`, [`public.${name}`])).rows
      const indexes = (await test.pool.query('select indexname as name,indexdef as definition from pg_indexes where schemaname=\'public\' and tablename=$1 order by indexname', [name])).rows
      tables.push({ name, columns, constraints, indexes })
    }
    const dump = spawnSync('docker', ['exec', test.container, 'pg_dump', '-U', 'postgres', '-d', test.database,
      '--schema-only', '--no-owner', '--no-privileges', ...names.map(name => `--table=public.${name}`)], { encoding: 'utf8', windowsHide: true })
    if (dump.status !== 0) throw new Error('baseline schema dump failed')
    const out = 'artifacts/post-lv2/local/debt-repair-20261019'
    mkdirSync(out, { recursive: true })
    writeFileSync(`${out}/compatibility-baseline.json`, JSON.stringify({ upstream: '@elizaos/plugin-sql@1.7.2', backend: 'postgres', tables }, null, 2)+'\n')
    writeFileSync(`${out}/compatibility-baseline.sql`, dump.stdout)
    console.log(`PASS upstream PostgreSQL baseline: ${tables.length} tables`)
  } finally { await closeDatabaseConnection(runtime) }
})
