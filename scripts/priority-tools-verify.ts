import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { capabilityHealth } from '../src/infrastructure/action/capability-health.ts'
// @ts-expect-error standalone deployment CLI has no TS declarations
import { sourceManifest, verifySourceManifest } from './deploy/source-manifest.mjs'
const root = mkdtempSync(join(tmpdir(), 'lg-priority-tools-'))
const checks: string[] = []
assert.equal(capabilityHealth('library.search', { libraryRoot: join(root, 'missing'), fresh: true }).ready, false)
mkdirSync(join(root, 'library'))
assert.equal(capabilityHealth('library.search', { libraryRoot: join(root, 'library'), fresh: true }).ready, true)
assert.equal(capabilityHealth('sandbox.file.read', { sandboxRoot: join(root, 'missing'), fresh: true }).ready, false)
assert.equal(capabilityHealth('sandbox.file.write', { sandboxRoot: join(root, 'missing'), fresh: true }).reason, 'runtime_root_creatable')
writeFileSync(join(root, 'blocked'), 'fixture')
assert.equal(capabilityHealth('sandbox.file.write', { sandboxRoot: join(root, 'blocked'), fresh: true }).ready, false)
assert.equal(capabilityHealth('sandbox.file.write', { sandboxRoot: join(root, 'library'), fresh: true }).ready, true)
assert.equal(capabilityHealth('document.read', { pythonPath: join(root, 'missing-python'), fresh: true }).ready, false)
assert.equal(capabilityHealth('workflow.skill', { fresh: true }).ready, true)
assert.equal(capabilityHealth('math.calculate', { fresh: true }).ready, true)
checks.push('missing read roots refused; creatable write roots allowed; file-as-root refused', 'missing Python refused', 'real workflow hashes and math dependency resolution')
execFileSync('git', ['init', '-q', root])
function put(path: string, text: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
put('package.json', '{"name":"fixture","type":"module","dependencies":{}}')
put('src/main.ts', 'export const value=1\n')
put('src/infrastructure/qq/onebot-private-client.ts', 'export const bounded=true\n')
put('src/infrastructure/persistence/migrations.ts', 'const MIGRATION_0022: Migration = {}\n')
put('resources/workflow-skills/fixture/SKILL.md', 'bounded workflow instructions')
put('.gitattributes', 'scripts/deploy/*.sh text eol=lf\n')
put('.env', 'API_KEY=private-fixture-value')
const manifest = sourceManifest(root)
assert.equal(manifest.requiredSchema, 22)
assert.ok(manifest.files.some((f: { path: string }) => f.path.endsWith('/SKILL.md')))
assert.ok(manifest.files.some((f: { path: string }) => f.path === '.gitattributes'))
assert.ok(manifest.files.some((f: { path: string }) => f.path.endsWith('onebot-private-client.ts')))
assert.ok(!JSON.stringify(manifest).includes('private-fixture-value'))
assert.ok(!manifest.files.some((f: { path: string }) => f.path === '.env'))
assert.ok(verifySourceManifest(root, manifest))
put('src/main.ts', 'export const value=2\n')
assert.equal(verifySourceManifest(root, manifest), false)
put('src/main.ts', 'export const value=1\n')
assert.ok(verifySourceManifest(root, manifest))
put('.env', 'API_KEY=changed-secret')
assert.ok(verifySourceManifest(root, manifest))
const escaped = { ...manifest, files: [{ path: '../escape.ts', sha256: 'fixture' }] }
escaped.treeSha256 = createHash('sha256').update(JSON.stringify(escaped.files)).digest('hex')
assert.equal(verifySourceManifest(root, escaped), false)
put('src/unexpected.ts', 'export const unexpected=true')
assert.equal(verifySourceManifest(root, manifest), false)
checks.push('code content tamper refused and restoration accepted', 'added code refused', 'manifest path escape refused',
  'private-named source included; secret values and hashes excluded')
const out = 'artifacts/post-lv2/local/priority-three-20261018/tools-checks.json'
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ status: 'PASS', checks, modelCalls: 0, databaseOpened: false }, null, 2))
console.log(`PASS ${checks.length} tool/deployment check groups`)
