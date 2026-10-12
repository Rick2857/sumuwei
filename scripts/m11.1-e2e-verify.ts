import { isolateDatabase, cleanupSandbox } from '../src/dev/sandbox.ts'
isolateDatabase('m111-process-parent')
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'

async function worker(mode: string, id: string, flags?: string) {
  return new Promise<Record<string, any>>(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(process.cwd(), 'scripts/m11.1-process-worker.ts'), mode, id, ...(flags ? [flags] : [])],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let message: Record<string, any> = {}
    let killed = false
    const timeout = setTimeout(() => { child.kill('SIGKILL'); message = { error: 'worker_timeout' } }, 55_000)
    child.on('message', (value: any) => {
      message = value
      if (value.ready && (mode === 'crash' || mode === 'commit-crash')) { killed = child.kill('SIGKILL') }
    })
    child.on('error', error => { message = { error: String(error) } })
    child.on('exit', (code, signal) => { clearTimeout(timeout); resolve({ ...message, exitCode: code, signal, killed }) })
  })
}
async function main() {
  const started = new Date().toISOString()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const checks: { caseId: string; pass: boolean; observed: unknown }[] = []
  for (const flags of ['00', '10', '01', '11']) {
    const id = `flags-${flags}-${randomBytes(4).toString('hex')}`
    try {
      const observed = await worker('matrix', id, flags)
      checks.push({ caseId: `production-switches-${flags}`, pass: observed.exitCode === 0 && observed.cleanClose && observed.result?.pass, observed })
    } finally { cleanupSandbox(join(tmpdir(), `project-lg-exp-m111-process-${id}`)) }
    console.log(JSON.stringify({ caseId: checks.at(-1)!.caseId, pass: checks.at(-1)!.pass }))
  }
  const id = `restart-${randomBytes(4).toString('hex')}`
  try {
    const killed = await worker('crash', id)
    checks.push({ caseId: 'actual-process-kill', pass: killed.ready === true && killed.killed === true && killed.cleanClose !== true, observed: killed })
    const observed = await worker('recover', id)
    checks.push({ caseId: 'reopen-same-window-single-commit-rebuild', pass: observed.exitCode === 0 && observed.cleanClose && observed.result?.pass && observed.result.packet.refs.length > 0, observed })
  } finally { cleanupSandbox(join(tmpdir(), `project-lg-exp-m111-process-${id}`)) }
  const commitId = `commit-restart-${randomBytes(4).toString('hex')}`
  try {
    const killed = await worker('commit-crash', commitId)
    checks.push({ caseId: 'actual-kill-after-business-commit', pass: killed.ready === true && killed.afterBusinessCommit === true && killed.killed === true, observed: killed })
    const observed = await worker('recover-committed', commitId)
    checks.push({ caseId: 'committed-window-recovery-no-second-model-or-events', pass: observed.exitCode === 0 && observed.cleanClose && observed.result?.pass, observed })
  } finally { cleanupSandbox(join(tmpdir(), `project-lg-exp-m111-process-${commitId}`)) }
  const runId = createM11RunId({ wpId: 'm111-e2e', headShort: head })
  const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
  const paths = ['scripts/m11.1-e2e-verify.ts', 'scripts/m11.1-process-worker.ts', 'src/infrastructure/runtime/reflection-runtime.ts', 'src/infrastructure/runtime/reflection-scheduler.ts', 'src/infrastructure/runtime/reflection-runner.ts', 'src/infrastructure/persistence/reflection-source-read.ts', 'docs/m11.1/M11.1-Acceptance-Contract.md']
  writeM11Manifest(dir, { runId, wp: 'M11.1-WP3', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'production-runtime-process-controls', phases: ['positive', 'negative', 'recovery'], supersedes: null,
    started, ended: new Date().toISOString(), counts: { total: checks.length, passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length },
    environment: 'isolated-offline', cleanClose: checks.filter(c => !c.caseId.startsWith('actual-')).every(c => (c.observed as any).cleanClose === true),
    plannedRequests: 0, actualRequests: 0, capabilityImpact: 'NONE', sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  })
  console.log(JSON.stringify({ runId, checks: checks.map(c => ({ caseId: c.caseId, pass: c.pass })) }, null, 2))
  process.exit(checks.every(c => c.pass) ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
