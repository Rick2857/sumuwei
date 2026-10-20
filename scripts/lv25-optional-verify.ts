/** No-database optional-feature checks. Does not start main, tools, or models. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { readKernelFlags } from '../src/kernel/app/flags.ts'

const flags = readKernelFlags({})
assert.equal(flags.storyCognitionEnabled, false)
assert.equal(flags.storyChoiceDecisionEnabled, false)
assert.equal(flags.storyDailyEnabled, false)
const enabled = readKernelFlags({ CHARACTER_STORY_COGNITION_ENABLED: 'true',
  CHARACTER_STORY_CHOICE_DECISION_ENABLED: 'true', CHARACTER_STORY_DAILY_ENABLED: 'true' })
assert(enabled.storyCognitionEnabled && enabled.storyChoiceDecisionEnabled && enabled.storyDailyEnabled)

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && !/^(OPENAI_|CHARACTER_|QQ_|WECHAT_|M55_|PGLITE_|PROJECT_LG_|TEST_|LG_PG_|LG_TEST_|LG_PRODUCTION_)/.test(key) &&
  !['POSTGRES_URL', 'DATABASE_URL', 'USER_NAME'].includes(key)))
const probes = []
for (const mode of ['default', 'enabled', 'injected', 'default']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lv25-import-probe.ts', mode],
    { encoding: 'utf8', env, timeout: 45_000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.split(/\r?\n/).filter(line => line.startsWith('{'))
  assert(lines.length > 0, 'a missing reading cannot pass')
  const reading = JSON.parse(lines.at(-1)!)
  assert(reading.mainSuppressed)
  assert.equal(reading.connectionAttempts, 0)
  if (mode === 'default') assert.equal(reading.featureModulesLoaded, 0)
  else assert(reading.featureModulesLoaded > 0)
  if (mode === 'enabled') assert.equal(reading.defaultLoaded, 0)
  probes.push(reading)
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
assert(pkg.scripts['story:start'] && pkg.scripts['story:withdraw'])
for (const file of ['src/kernel/storyline/world-machine.ts', 'src/kernel/app/storyline/commit-service.ts',
  'src/infrastructure/runtime/story-cognition.ts', 'src/content/storyline/jichuang-interview-two/story-pack.ts']) assert(existsSync(file))
console.log(JSON.stringify({ status: 'PASS', checks: ['default-off', 'explicit-opt-in', 'default-import-graph',
  'enabled-import-graph', 'eager-import-negative-control', 'restored-default', 'original-feature-preserved'],
  probes, databaseIntegration: 'NOT RUN', realModelCalls: 0, runtimeActivated: false }))
