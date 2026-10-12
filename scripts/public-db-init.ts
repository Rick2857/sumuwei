/** Create a new, empty schema for this public checkout. Never import existing data. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { parse } from 'dotenv'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { closeDatabaseConnection, isDatabaseClosed } from '../src/infrastructure/persistence/runtime-shutdown.ts'

if (!existsSync(resolve('.env'))) throw new Error('db:init requires a local .env (copy .env.example first)')
const target = resolve('data')
if (existsSync(target)) throw new Error('db:init requires a fresh checkout without data/')
const localConfig = parse(readFileSync(resolve('.env')))
if (process.env.POSTGRES_URL || localConfig.POSTGRES_URL || process.env.DATABASE_URL || localConfig.DATABASE_URL
  || process.env.PGLITE_DATA_DIR
  || (localConfig.PGLITE_DATA_DIR && resolve(localConfig.PGLITE_DATA_DIR) !== join(target, 'pglite'))
  || process.env.PROJECT_LG_SANDBOX || localConfig.PROJECT_LG_SANDBOX) {
  throw new Error('db:init refuses externally configured database paths')
}
const fixtureRoot = resolve('artifacts/public-db-init')
mkdirSync(fixtureRoot, { recursive: true })
const fixture = mkdtempSync(join(fixtureRoot, 'empty-'))
process.env.PGLITE_DATA_DIR = fixture
process.env.PROJECT_LG_SANDBOX = fixture
const runtime = new AgentRuntime({ character, plugins: [sqlPlugin] })
try {
  await initDatabase(runtime, sqlPlugin)
} finally {
  await closeDatabaseConnection(runtime)
}
if (!isDatabaseClosed(runtime)) throw new Error('db:init database close was not verified')
if (existsSync(target)) throw new Error('db:init target appeared during initialization')
cpSync(fixture, join(target, 'pglite'), { recursive: true })
console.log('Created new schema-only data/pglite. No messages or user records were imported.')
