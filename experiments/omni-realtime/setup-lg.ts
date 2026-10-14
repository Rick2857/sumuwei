import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import { loadPgCredentials, missingCredentialKeys } from '../../scripts/postgresql/credentials.ts'
import { psqlFile, readIdentity } from '../../scripts/postgresql/pg-exec.ts'
import { assertIsolatedPostgres, PG_CONTAINER, PG_HOST_PORT } from './isolated-pg.ts'

// Explicit sources, no default root .env and no production connection string.
const [credentialFile, testModelFile] = process.argv.slice(2)
if (!credentialFile || !testModelFile) throw new Error('usage: setup-lg.ts <pg-trial.env> <.env.test>')
assertIsolatedPostgres()
const credentials = loadPgCredentials(resolve(credentialFile))
if (missingCredentialKeys(credentials).length) throw new Error('pg_test_credentials_missing')
const test = parse(readFileSync(resolve(testModelFile)))
for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_LARGE_MODEL']) if (!test[key]) throw new Error('test_model_config_missing')
const database = `lg_test_omni_${Date.now()}`
const created = psqlFile({ container: PG_CONTAINER, user: credentials!.LG_PG_BOOTSTRAP_USER,
  password: credentials!.LG_PG_BOOTSTRAP_PASSWORD, database: credentials!.LG_PG_BOOTSTRAP_DB,
  file: '/opt/lg/create-test-db.sql', variables: { LG_TEST_DB_NAME: database, LG_PG_MIGRATE_USER: 'lg_migrate' } })
if (created.rc !== 0) throw new Error('omni_test_database_create_failed')
const identity = readIdentity({ container: PG_CONTAINER, user: 'lg_migrate', password: credentials!.LG_PG_MIGRATE_PASSWORD, database })
if (identity?.database !== database || identity.user !== 'lg_migrate') throw new Error('omni_test_database_identity_failed')
const target = new URL(`postgresql://127.0.0.1:${PG_HOST_PORT}/${database}`)
target.username = 'lg_migrate'; target.password = credentials!.LG_PG_MIGRATE_PASSWORD
const config: Record<string, string> = {
  ...Object.fromEntries(Object.entries(test).filter(([key]) => /^OPENAI_/.test(key))),
  CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: target.href,
  LG_PG_EXPECT_DATABASE: database, LG_PG_EXPECT_DATABASE_PREFIX: 'lg_test_omni_',
  LG_PG_CONTAINER: PG_CONTAINER,
  CHARACTER_MEMORY_SEMANTIC_MODE: 'off', CHARACTER_SLOW_PATH_ENABLED: 'false',
  CHARACTER_MEMORY_AUTOMATIC_ENABLED: 'false', CHARACTER_WEB_SEARCH_ENABLED: 'false',
  CHARACTER_EXPRESSIVE_SPEECH: 'false', DEBUG_CONTEXT: '0', DSH_TEST_MODEL_WRAPPER: '1',
  CHARACTER_MATH_CALCULATE_ENABLED: 'true',
  CONVERSATION_LENGTH: '1',
}
writeFileSync(new URL('.lg-core.local.env', import.meta.url), Object.entries(config).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n')
console.log(JSON.stringify({ database, backend: 'postgres', owner: identity.user, vector: identity.vectorVersion, productionDatabaseUsed: false }))
