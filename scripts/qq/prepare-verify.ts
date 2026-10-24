/** Isolated configuration migration checks; no QQ, model, or database connection. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'

const root = resolve(import.meta.dirname, '../..')
const parent = resolve(root, 'artifacts/post-lv2/local')
mkdirSync(parent, { recursive: true })
const bed = mkdtempSync(resolve(parent, 'qq-prepare-'))
const webuiFixture = 'w'.repeat(32)
function run(name: string, initial?: string, sameAccount = false) {
  const dir = resolve(bed, name)
  for (const path of ['scripts/qq/prepare.ts', 'src/infrastructure/qq/private-config.ts']) {
    mkdirSync(resolve(dir, path, '..'), { recursive: true })
    cpSync(resolve(root, path), resolve(dir, path))
  }
  if (initial !== undefined) writeFileSync(resolve(dir, '.env.qq'), initial)
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(dir, 'scripts/qq/prepare.ts'),
    '--owner=123456789', `--bot=${sameAccount ? '123456789' : '987654321'}`], { cwd: dir, encoding: 'utf8' })
  return { dir, result }
}
try {
  const invalid = run('invalid', undefined, true)
  assert.notEqual(invalid.result.status, 0)
  assert.equal(existsSync(resolve(invalid.dir, '.env.qq')), false)
  assert.equal(existsSync(resolve(invalid.dir, 'data')), false)

  const fresh = run('fresh')
  assert.equal(fresh.result.status, 0, fresh.result.stderr)
  const envPath = resolve(fresh.dir, '.env.qq')
  const env = parse(readFileSync(envPath))
  assert.equal(env.QQ_ONEBOT_WS_URL, 'ws://127.0.0.1:13001/')
  assert.equal(env.PMHQ_AUTH_TOKEN, '')
  assert.equal(existsSync(resolve(fresh.dir, 'data/qq-private')), false)
  assert.equal(env.QQ_ONEBOT_ACCESS_TOKEN === env.LLBOT_WEBUI_TOKEN, false)
  if (process.platform !== 'win32') assert.equal(statSync(envPath).mode & 0o777, 0o600)
  const repeat = spawnSync(process.execPath, ['--import', 'tsx', resolve(fresh.dir, 'scripts/qq/prepare.ts')], { encoding: 'utf8' })
  assert.equal(repeat.status, 0, repeat.stderr)
  assert.deepEqual(parse(readFileSync(envPath)), env)

  const legacy = run('legacy', [
    'QQ_OWNER_ID=123456789', 'QQ_BOT_ID=987654321', 'QQ_ONEBOT_WS_URL=ws://127.0.0.1:6701/',
    'QQ_ONEBOT_ACCESS_TOKEN=fixture_token_keep_0123456789', 'QQ_MULTI_USER_ENABLED=true', 'QQ_ALLOWED_GROUP_IDS=12345678,23456789',
    'QQ_NAPCAT_IMAGE=retired-image', 'QQ_NAPCAT_WEBUI_TOKEN=retired-token',
    'PMHQ_AUTH_TOKEN="fixture-auth # retain"', `LLBOT_WEBUI_TOKEN=${webuiFixture}`,
  ].join('\n'))
  assert.equal(legacy.result.status, 0, legacy.result.stderr)
  const migrated = parse(readFileSync(resolve(legacy.dir, '.env.qq')))
  assert.equal(migrated.QQ_ONEBOT_PORT, '6701')
  assert.equal(migrated.QQ_ONEBOT_ACCESS_TOKEN, 'fixture_token_keep_0123456789')
  assert.equal(migrated.QQ_ALLOWED_GROUP_IDS, '12345678,23456789')
  assert.equal(migrated.QQ_MULTI_USER_ENABLED, 'true')
  assert.equal(migrated.PMHQ_AUTH_TOKEN, 'fixture-auth # retain')
  assert.equal(migrated.LLBOT_WEBUI_TOKEN, webuiFixture)
  assert.equal(Object.keys(migrated).some(key => key.startsWith('QQ_NAPCAT_')), false)
  const config = JSON.parse(readFileSync(resolve(legacy.dir, 'data/qq-llbot/data/config_987654321.json'), 'utf8'))
  assert.equal(config.ob11.connect[0].token, migrated.QQ_ONEBOT_ACCESS_TOKEN)
  assert.equal(config.ob11.connect[0].messageFormat, 'array')
  assert.equal(config.ob11.connect[0].reportSelfMessage, false)
  assert.equal(config.ob11.connect[0].reportOfflineMessage, false)
  assert.equal(config.milky.enable, false)
  assert.equal(config.satori.enable, false)
  assert.equal(readFileSync(resolve(legacy.dir, 'data/qq-llbot/data/webui_token.txt'), 'utf8'), migrated.LLBOT_WEBUI_TOKEN)
  const blank = run('example', 'QQ_OWNER_ID=123456789\nQQ_BOT_ID=987654321\nQQ_ONEBOT_ACCESS_TOKEN=\n')
  assert.equal(blank.result.status, 0, blank.result.stderr)
  console.log('PASS QQ preparation: invalid identity has no writes; fresh/example defaults; repeat preserves credentials; legacy migration preserves identity, token and groups')
} finally {
  rmSync(bed, { recursive: true, force: true })
}
