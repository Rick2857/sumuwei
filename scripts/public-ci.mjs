/** Fresh public-copy regression; never use a deployment's environment or data. */
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
for (const name of ['.env', '.env.local', '.env.qq', '.env.wechat', '.env.test', 'data']) {
  if (existsSync(name)) throw new Error(`Public CI requires a fresh checkout without ${name}`)
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && !/^(OPENAI_|CHARACTER_|QQ_|WECHAT_|M55_|PGLITE_|PROJECT_LG_|TEST_|LG_PG_|LG_TEST_|LG_PRODUCTION_)/.test(key)
  && !['POSTGRES_URL', 'DATABASE_URL', 'USER_NAME'].includes(key)))
Object.assign(env, { CI: 'true', NO_COLOR: '1', PROMPTFOO_DISABLE_TELEMETRY: '1',
  CHARACTER_DB_BACKEND: 'pglite', POSTGRES_URL: '', DATABASE_URL: '', USER_NAME: 'Alex',
  OPENAI_API_KEY: 'offline', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
  OPENAI_LARGE_MODEL: 'public-offline-fixture', OPENAI_SMALL_MODEL: 'public-offline-fixture' })
const marker = '# public-ci empty environment\n'
writeFileSync('.env', marker, { flag: 'wx' })
try {
  for (const command of ['db:init', 'migrate:apply', 'm4.5:ci']) {
    const runner = process.env.npm_execpath
    const javascript = runner && /\.[cm]?js$/i.test(runner)
    const program = javascript ? process.execPath : runner ?? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    const result = spawnSync(program, javascript ? [runner, command] : [command],
      { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(program) })
    if (result.error || result.status !== 0) { process.exitCode = result.status || 1; break }
  }
} finally {
  if (existsSync('.env') && readFileSync('.env', 'utf8') === marker) unlinkSync('.env')
}
