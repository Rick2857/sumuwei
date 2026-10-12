/** Run the frozen M5.1 reader against an immutable snapshot of current inherited evidence. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLv2RunId, openLv2RunDir, validateLv2Manifest, writeLv2Manifest } from './lv2-evidence.ts'
import { readLatestLv2Regression } from './lv2-regression-evidence.ts'

export function readM51Inherited(root: string) {
  const candidate = readLatestLv2Regression(root)
  if (!candidate?.valid) return { verdict: 'NOT PASS', sourceRunId: candidate?.runId, problems: candidate?.problems ?? ['完整回归缺失'] }
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const sources = ['scripts/lv2-m51-inherited.ts', 'scripts/m5.1-gate-results.ts', 'scripts/m4.5-gate-results.ts', 'scripts/m5-gate-results.ts']
  // Reuse the latest reading for this exact candidate and reader version, regardless of verdict.
  // Restoring historical stable artifacts must not make the current immutable reading disappear.
  const parent = join(root, 'artifacts/lv2')
  const cached = readdirSync(parent).filter(name => name.startsWith('lv2-wp6-m51-inherited-')).flatMap(name => {
    try { const manifest = JSON.parse(readFileSync(join(parent, name, 'manifest.json'), 'utf8'))
      return manifest.config?.sourceRunId === candidate.runId && sources.every(path => manifest.sourceFingerprints?.[path] === sha(join(root, path))) ? [{ name, manifest }] : []
    } catch { return [] }
  }).sort((a, b) => String(b.manifest.ended).localeCompare(String(a.manifest.ended)))[0]
  if (cached) {
    const problems = validateLv2Manifest(cached.manifest).map(row => `${row.field}: ${row.problem}`)
    try {
      const reading = JSON.parse(readFileSync(join(parent, cached.name, 'reading.json'), 'utf8'))
      const privateRoot = join(root, 'artifacts/lv2/local', cached.name)
      if (reading.runId !== cached.name || reading.sourceRunId !== candidate.runId || cached.manifest.verdict !== 'PASS' ||
        reading.checks.length !== 4 || reading.checks.some((row: any) => !row.pass)) problems.push('M5.1 原生读数或四项自证未通过')
      const declaredFiles = new Set([...readFileSync(join(root, 'scripts/m5.1-gate-results.ts'), 'utf8').matchAll(/file: '([^']+\.json)'/g)].map(match => `artifacts/${match[1]}`))
      if (reading.snapshotFiles.length !== 13 || new Set(reading.snapshotFiles.map((file: any) => file.path)).size !== 13) problems.push('M5.1 输入副本不完整')
      for (const file of reading.snapshotFiles) {
        if (!declaredFiles.has(file.path)) problems.push('M5.1 输入副本路径未声明')
        else if (sha(join(privateRoot, file.path)) !== file.sha256) problems.push(`M5.1 输入副本变化：${file.path}`)
      }
      const original = JSON.parse(readFileSync(join(privateRoot, 'artifacts/m5.1/gate-results.json'), 'utf8'))
      if (sha(join(privateRoot, 'artifacts/m5.1/gate-results.json')) !== reading.nativeOutputSha256 || original.hardGateVerdict !== 'PASS' ||
        original.hardGates.length === 0 || JSON.stringify(original.hardGates) !== JSON.stringify(reading.recovered.hardGates)) problems.push('M5.1 原始输出不一致')
      return { verdict: problems.length ? 'NOT PASS' : 'PASS', runId: cached.name, sourceRunId: candidate.runId, problems,
        hardGates: reading.recovered.hardGates, checks: reading.checks }
    } catch { return { verdict: 'NOT PASS', runId: cached.name, sourceRunId: candidate.runId, problems: ['M5.1 私有原始副本缺失或损坏'] } }
  }
  const started = new Date().toISOString()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const runId = createLv2RunId({ wpId: 'wp6-m51-inherited', headShort: head })
  const directory = openLv2RunDir(root, runId)
  const snapshot = join(root, 'artifacts/lv2/local', runId)
  // These native readers open no database and perform no model calls.
  for (const command of ['m5:gates', 'm4.5:gates']) execFileSync('pnpm', [command], { cwd: root, shell: true, stdio: 'ignore' })
  const m45 = JSON.parse(readFileSync(join(root, 'artifacts/m4.5/gate-results.json'), 'utf8'))
  const g14 = m45.gates.find((row: any) => row.gate === 'G14')
  if (g14?.status !== 'PASS' || g14.passed !== candidate.g14.checks.passed || g14.failed !== 0) {
    return { verdict: 'NOT PASS', sourceRunId: candidate.runId, problems: ['M4.5 聚合与本候选原始 Smoke 不一致'] }
  }
  const reader = join(root, 'scripts/m5.1-gate-results.ts')
  // Missing files remain missing in the snapshot; the frozen reader decides whether they are required.
  const paths = [...readFileSync(reader, 'utf8').matchAll(/file: '([^']+\.json)'/g)]
    .map(match => `artifacts/${match[1]}`).filter(path => existsSync(join(root, path)))
  for (const path of paths) { mkdirSync(dirname(join(snapshot, path)), { recursive: true }); cpSync(join(root, path), join(snapshot, path)) }
  const run = () => {
    let exitCode = 0
    try { execFileSync(process.execPath, ['--import', 'tsx', reader], { cwd: snapshot, stdio: 'ignore' }) }
    catch (error) { exitCode = (error as { status?: number }).status ?? 1 }
    const result = JSON.parse(readFileSync(join(snapshot, 'artifacts/m5.1/gate-results.json'), 'utf8'))
    return { exitCode, hardGates: result.hardGates, verdict: result.hardGateVerdict, selfCheck: result.selfCheck }
  }
  const positive = run()
  const checks = [{ id: 'frozen-native-reader-positive', pass: positive.exitCode === 0 && positive.verdict === 'PASS' && positive.hardGates.length > 0 }]
  for (const [path, alter] of [
    ['artifacts/m5.1/measurement-negative-controls.json', (value: any) => { value.measurementVerdict = 'FAIL' }],
    ['artifacts/m4.5/gate-results.json', (value: any) => { value.hardGates.find((row: any) => row.gate === 'G14').status = 'FAIL' }],
  ] as const) {
    const target = join(snapshot, path), original = readFileSync(target, 'utf8'), changed = JSON.parse(original)
    alter(changed); writeFileSync(target, JSON.stringify(changed))
    const rejected = run()
    checks.push({ id: `reject-${path}`, pass: rejected.exitCode !== 0 && rejected.verdict === 'FAIL' })
    writeFileSync(target, original)
  }
  const recovered = run()
  checks.push({ id: 'recovery', pass: recovered.exitCode === 0 && recovered.verdict === 'PASS' })
  const verdict = checks.every(row => row.pass) ? 'PASS' : 'FAIL'
  writeFileSync(join(directory, 'reading.json'), JSON.stringify({ runId, sourceRunId: candidate.runId,
    positive, recovered, checks, nativeOutputSha256: sha(join(snapshot, 'artifacts/m5.1/gate-results.json')),
    snapshotFiles: paths.map(path => ({ path, sha256: sha(join(snapshot, path)) })) }, null, 2) + '\n')
  writeLv2Manifest(directory, { runId, wp: 'wp6-m51-inherited', head, headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), date: started.slice(0, 10).replaceAll('-', ''),
    toolVersions: { node: process.version }, testType: 'frozen-m51-native-reader-current-inheritance', phases: ['positive', 'negative', 'recovery'], supersedes: null,
    started, ended: new Date().toISOString(), counts: { total: checks.length, passed: checks.filter(row => row.pass).length, failed: checks.filter(row => !row.pass).length },
    worktree: { clean: false, note: 'Versioned evidence in progress; M5.1 reader and original acceptance files are unchanged.' },
    sourceFingerprints: Object.fromEntries(sources.map(path => [path, sha(join(root, path))])),
    config: { sourceRunId: candidate.runId, snapshot: snapshot.replace(root + '\\', '').replaceAll('\\', '/') },
    model: { providerKind: 'none' }, requests: { planned: 0, actual: 0, note: 'Original read-only aggregators; zero model calls.' },
    denominators: { frozenHardGates: positive.hardGates.length }, correlations: { cases: 0, conversations: 0, requests: 0, traces: 0 },
    faultInjection: 'private copied measurement FAIL;private copied G14 FAIL', cleanClose: true,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: 'Read-only evidence snapshots; no database opened.' }, verdict })
  return { verdict, runId, sourceRunId: candidate.runId, hardGates: positive.hardGates, checks }
}
