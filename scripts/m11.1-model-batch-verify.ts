import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openM111ModelBatch } from './m11.1-model-batch.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'

const root = resolve('artifacts/m11.1/local', `batch-controls-${randomUUID()}`)
process.env.OPENAI_BASE_URL = 'https://offline-control.invalid/v1'
process.env.OPENAI_SMALL_MODEL = 'offline-control-small'
process.env.OPENAI_LARGE_MODEL = 'offline-control-large'
const fingerprints = { semantic: 'offline-oracle', behavior: 'offline-oracle' }
const checks: { id: string; pass: boolean }[] = []
const check = (id: string, pass: boolean) => checks.push({ id, pass })
const refused = (work: () => unknown) => { try { work(); return false } catch { return true } }
const started = new Date().toISOString()
try {
  const first = openM111ModelBatch(fingerprints, root)
  const complete = first.reserve('semantic', 'nonzero-control')
  check('reserve-before-outbound-counts', first.count() === 1)
  complete('transport_failed')
  const callPath = join(root, 'calls', readdirSync(join(root, 'calls'))[0]!)
  const failed = JSON.parse(readFileSync(callPath, 'utf8'))
  check('failure-keeps-denominator-and-start', first.count() === 1 && failed.status === 'transport_failed' && !!failed.reservedAt && !!failed.endedAt)
  const reopened = openM111ModelBatch(fingerprints, root)
  check('restart-duplicate-is-refused', refused(() => reopened.reserve('semantic', 'nonzero-control')) && reopened.count() === 1)
  check('corpus-drift-is-refused', refused(() => openM111ModelBatch({ ...fingerprints, semantic: 'changed' }, root)))
  const lockPath = join(root, 'reservation.lock')
  const lock = openSync(lockPath, 'wx')
  try { check('concurrent-reservation-fails-closed', refused(() => first.reserve('behavior', 'locked-control')) && first.count() === 1) }
  finally { closeSync(lock); unlinkSync(lockPath) }
  const temporaryLock = openSync(lockPath, 'wx')
  const waiting = first.reserveWhenAvailable('preparation', 'queued-control')
  setTimeout(() => { closeSync(temporaryLock); unlinkSync(lockPath) }, 30)
  const queued = await waiting
  queued('returned')
  check('bounded-lock-wait-reserves-once', first.count() === 2)
  let duplicateRefused = false
  try { await reopened.reserveWhenAvailable('preparation', 'queued-control') } catch { duplicateRefused = true }
  check('queued-replay-still-refused', duplicateRefused && first.count() === 2)
  const success = reopened.reserve('behavior', 'after-lock-control')
  success('returned')
  check('recovery-shared-count', first.count() === 3 && reopened.count() === 3)
  // Reserved-but-interrupted requests still consume the frozen limit. No model runs here.
  for (let i = 0; i < 1697; i++) writeFileSync(join(root, 'calls', `offline-reserved-${i}.json`), JSON.stringify({ phase: 'preparation', status: 'reserved', requestCount: 1 }), { flag: 'wx' })
  check('1700-cap-refuses-without-outbound', first.count() === 1700 && refused(() => first.reserve('dialogue', 'overflow')) && first.count() === 1700)
  const confirmationRoot = join(root, 'confirmation')
  const confirmation = openM111ModelBatch(fingerprints, confirmationRoot, 'offline-480-confirmation')
  confirmation.reserve('semantic', 'nonzero-control')('returned')
  check('confirmation-identity-is-separate-from-initial-batch', confirmation.count() === 1 && first.count() === 1700)
  check('confirmation-decision-drift-is-refused', refused(() => openM111ModelBatch(fingerprints, confirmationRoot, 'different-decision')))
  for (let i = 0; i < 479; i++) writeFileSync(join(confirmationRoot, 'calls', `offline-reserved-${i}.json`), JSON.stringify({ phase: 'semantic', status: 'reserved', requestCount: 1 }), { flag: 'wx' })
  check('480-confirmation-cap-refuses-without-outbound', confirmation.count() === 480 && refused(() => confirmation.reserve('semantic', 'overflow')) && first.count() === 1700)
} finally {
  const parent = resolve('artifacts/m11.1/local')
  if (!root.startsWith(parent + '\\') && !root.startsWith(parent + '/')) throw new Error('Control cleanup escaped local directory')
  rmSync(root, { recursive: true, force: true })
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm111-batch-controls', headShort: head })
const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
const paths = ['scripts/m11.1-model-batch.ts', 'scripts/m11.1-model-batch-verify.ts']
writeM11Manifest(dir, { runId, wp: 'M11.1-WP4', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'model-batch-offline-controls', phases: ['positive', 'negative', 'recovery'], supersedes: null,
  started, ended: new Date().toISOString(), counts: { total: checks.length, passed: checks.filter(row => row.pass).length, failed: checks.filter(row => !row.pass).length },
  cleanClose: true, environment: 'filesystem-offline-no-database', plannedRequests: 0, actualRequests: 0, capabilityImpact: 'NONE',
  sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
})
console.log(JSON.stringify({ runId, checks }, null, 2))
process.exit(checks.every(row => row.pass) ? 0 : 1)
