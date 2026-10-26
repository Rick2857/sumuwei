/** 对三个实际聚合入口注入复制时间倒置 / 新 FAIL / 并列冲突，不访问真实证据。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sealManifest } from './m6.1-evidence.ts'

const repo = resolve(import.meta.dirname, '..')
const loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href
let checks = 0
for (const gate of ['m8', 'm8.5', 's8'] as const) {
  const root = mkdtempSync(join(tmpdir(), 'lg-debt-selectors-'))
  const parent = join(root, 'artifacts', gate === 's8' ? 'post-lv2' : gate)
  mkdirSync(parent, { recursive: true })
  const write = (suffix: string, time: string, verdict: string, mtime: Date, wp = 'wp3-verify', supersedes: string | null = null): string => {
    const id = gate === 'm8' ? `m8-${wp}-20261019-000000000000-${suffix}`
      : gate === 'm8.5' ? `test-${suffix}` : `postlv2-s8-wp0-${suffix}`
    const dir = join(parent, id)
    mkdirSync(dir, { recursive: true })
    const payload = gate === 'm8' ? 'checks.json' : gate === 'm8.5' ? 'test.json' : 's8-wp0-baseline.json'
    writeFileSync(join(dir, payload), JSON.stringify({ verdict, generatedAt: time, measuredCount: 1 }))
    if (gate === 'm8') {
      const manifest = sealManifest({
        schemaVersion: 'm8-manifest@1', runId: id, wp,
        head: '0'.repeat(40), headShort: '0'.repeat(12), branch: 'fixture',
        date: '2026-10-19', generatedAt: time, toolVersions: { node: process.version },
        testType: 'verify', counts: { total: 1, passed: verdict === 'PASS' ? 1 : 0, failed: verdict === 'PASS' ? 0 : 1 },
        phases: ['after'], supersedes,
      })
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
      utimesSync(join(dir, 'manifest.json'), mtime, mtime)
    }
    utimesSync(join(dir, payload), mtime, mtime)
    utimesSync(dir, mtime, mtime)
    return id
  }
  const run = (): { status: string; id?: string | null } => {
    const script = gate === 's8' ? 'postlv2-s8-gates.ts' : `${gate}-gates.ts`
    const child = spawnSync(process.execPath, ['--import', loader, join(repo, 'scripts', script), `--root=${root}`, '--json'], { cwd: repo, encoding: 'utf8', timeout: 30000 })
    assert.equal(child.signal, null, child.stderr)
    assert.ok(child.status === 0 || child.status === 1, child.stderr)
    if (gate === 's8') {
      const output = readdirSync(parent).filter((name) => name.startsWith('postlv2-s8-gates-')).sort().at(-1)!
      const result = JSON.parse(readFileSync(join(parent, output, 's8-gates.json'), 'utf8'))
      return result.slots.find((slot: { id: string }) => slot.id === 'S8-A-baseline')
    }
    assert.ok(existsSync(join(parent, 'gate-results.json')), child.stderr)
    const result = JSON.parse(readFileSync(join(parent, 'gate-results.json'), 'utf8'))
    const row = result.gates.find((entry: { gate: string }) => entry.gate === (gate === 'm8' ? 'm8:wp3:verify' : 'm8.5:test'))
    return { status: row.status, id: row.authoritativeRun }
  }
  try {
    const old = write('a001', '2026-10-19T01:00:00Z', 'FAIL', new Date('2030-01-01'))
    const latest = write('a002', '2026-10-19T02:00:00Z', 'PASS', new Date('2000-01-01'))
    assert.equal(run().status, 'PASS')
    console.log(`PASS ${gate}: copied mtime cannot replace latest evidence`); checks++
    if (gate === 'm8') {
      write('a003', '2026-10-19T03:00:00Z', 'PASS', new Date(), 'wp4-verify', latest)
      assert.equal(run().id, latest, `cross-WP supersedes must not retire ${latest} (old ${old})`)
      console.log('PASS m8: supersedes is scoped to its WP'); checks++
    }
    write('a004', '2026-10-19T03:00:00Z', 'FAIL', new Date('1999-01-01'))
    assert.equal(run().status, 'FAIL')
    console.log(`PASS ${gate}: latest FAIL stays FAIL`); checks++
    write('a005', '2026-10-19T03:00:00Z', 'PASS', new Date('2040-01-01'))
    assert.equal(run().status, gate === 's8' ? 'MISSING EVIDENCE' : 'REFUSED')
    console.log(`PASS ${gate}: conflicting tied evidence fails closed`); checks++
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'lg-debt-selectors-')))
    rmSync(root, { recursive: true, force: true })
  }
}
console.log(`PASS debt selectors: ${checks}/${checks}`)
