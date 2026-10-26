/** Public source checks; database acceptance awaits the isolated PostgreSQL harness. */
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import nodeModule from 'node:module'
const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
if (!process.argv.includes('--source-only')) {
  console.error('NOT RUN: legacy PGlite database regression awaits isolated PostgreSQL migration. Use pnpm ci:source for the explicitly limited no-database checks.')
  process.exit(2)
}
for (const name of ['.env', '.env.local', '.env.qq', '.env.wechat', '.env.test', 'data']) {
  if (existsSync(name)) throw new Error(`Public CI requires a fresh checkout without ${name}`)
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && !/^(OPENAI_|CHARACTER_|QQ_|WECHAT_|M55_|PGLITE_|PROJECT_LG_|TEST_|LG_PG_|LG_TEST_|LG_PRODUCTION_)/.test(key)
  && !['POSTGRES_URL', 'DATABASE_URL', 'USER_NAME'].includes(key)))
Object.assign(env, { CI: 'true', NO_COLOR: '1', PROMPTFOO_DISABLE_TELEMETRY: '1',
  POSTGRES_URL: '', DATABASE_URL: '', USER_NAME: 'Alex',
  OPENAI_API_KEY: 'offline', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
  OPENAI_LARGE_MODEL: 'public-offline-fixture', OPENAI_SMALL_MODEL: 'public-offline-fixture' })
const marker = '# public-ci empty environment\n'
writeFileSync('.env', marker, { flag: 'wx' })
try {
  if (typeof nodeModule.registerHooks !== 'function') console.log('NOT RUN: lv25 import-graph probe needs registerHooks; use the pinned CI Node version for this check.')
  const commands = [['typecheck'], ['scripts:catalog:verify'],
    ['xidian:verify'], ['worldmodel:forecast:verify'], ['worldmodel:reflection:verify'], ['worldmodel:gates', '--verify'],
    ...(typeof nodeModule.registerHooks === 'function' ? [['lv25:optional:verify']] : []), ['thinhost:wiring:verify'],
    ['thinhost:surface:verify'], ['thinhost:retirement:verify'], ['thinhost:uuid:parity'],
    ['exec', 'tsx', 'scripts/priority-tools-verify.ts'], ['deploy:verify'],
    ['postlv2:entry-handshake:verify'], ['postlv2:entry-cancel:verify'], ['postlv2:entry-reconnect:verify'],
    ['postlv2:executor-server:verify'], ['postlv2:executor-client:verify']]
  for (const command of commands) {
    const runner = process.env.npm_execpath
    const javascript = runner && /\.[cm]?js$/i.test(runner)
    const program = javascript ? process.execPath : runner ?? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    const result = spawnSync(program, javascript ? [runner, ...command] : command,
      { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(program) })
    if (result.error || result.status !== 0) { process.exitCode = result.status || 1; break }
  }
} finally {
  if (existsSync('.env') && readFileSync('.env', 'utf8') === marker) unlinkSync('.env')
}
if (!process.exitCode) console.log('PASS source checks only; database/full regression and live gates NOT RUN.')
