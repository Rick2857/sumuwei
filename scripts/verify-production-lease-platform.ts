/** Cross-process lease regression; only temporary text fixtures, never opens a database. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  acquireProductionLease, bindLeasePipe, isLeaseHeld, leasePipeName,
  ownerRecordPath, ProductionDbInUseError, ProductionDbLeaseError, readOwnerRecord,
} from '../src/infrastructure/persistence/production-db-safety.ts'

if (process.argv[2] === '--holder') {
  const lease = await acquireProductionLease({ dataDir: process.argv[3]!, ownerRecordDir: process.argv[4]!, operationKind: 'manual_snapshot' })
  process.on('message', () => { void lease.release({ cleanClose: true }).then(() => process.exit(0)) })
  console.log('ACQUIRED')
} else {
  const root = mkdtempSync(join(tmpdir(), 'lg-lease-platform-'))
  const dataDir = join(root, 'data')
  const otherDir = join(root, 'other')
  const ownerRecordDir = join(root, 'owners')
  const cwdA = join(root, 'cwd-a')
  const cwdB = join(root, 'cwd-b')
  for (const dir of [dataDir, otherDir, cwdA, cwdB]) mkdirSync(dir)
  writeFileSync(join(dataDir, 'sentinel'), 'must stay unchanged')
  const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href
  const script = fileURLToPath(import.meta.url)
  const children: ChildProcess[] = []
  async function holder(dir: string, cwd: string): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['--import', loader, script, '--holder', dir, ownerRecordDir], {
      cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    children.push(child)
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Holder readiness timeout')), 15000)
      child.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ACQUIRED')) { clearTimeout(timer); resolveReady() }
      })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Holder exited before ready: ${code}`)) })
    })
    return child
  }
  async function stop(child: ChildProcess, hard = false): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    if (hard) child.kill('SIGKILL')
    else child.send('release')
    await exited
  }
  try {
    const a = await holder(dataDir, cwdA)
    // A different cwd must not create a second lock for the same absolute data path.
    await assert.rejects(async () => {
      const unexpected = await acquireProductionLease({ dataDir, ownerRecordDir, operationKind: 'manual_snapshot' })
      await unexpected.release({ cleanClose: true })
    }, ProductionDbInUseError)
    console.log('PASS same data path rejected across process/cwd boundaries')
    assert.equal(await isLeaseHeld(dataDir), true)
    const b = await holder(otherDir, cwdB)
    await stop(b)
    console.log('PASS different data paths can be held concurrently')
    await stop(a, true)
    const next = await acquireProductionLease({ dataDir, ownerRecordDir, operationKind: 'manual_snapshot' })
    assert.ok(next.previousUncleanExit)
    assert.notEqual(next.previousUncleanExit.cleanClose, true)
    await next.release({ cleanClose: true })
    assert.equal(await isLeaseHeld(dataDir), false)
    assert.equal(readOwnerRecord(ownerRecordPath(dataDir, ownerRecordDir))?.cleanClose, true)
    console.log('PASS forced exit releases lease without deleting sockets; unclean owner evidence retained')
    const badName = process.platform === 'win32' ? `\\\\.\\pipe\\${'x'.repeat(300)}` : join(root, 'missing', 'lease.sock')
    await assert.rejects(async () => {
      const unexpected = await bindLeasePipe(badName)
      await new Promise<void>((done) => unexpected.close(() => done()))
    }, ProductionDbLeaseError)
    console.log('PASS invalid endpoint fails closed')
    assert.equal(readFileSync(join(dataDir, 'sentinel'), 'utf8'), 'must stay unchanged')
    if (process.platform === 'win32') assert.ok(leasePipeName(dataDir).startsWith('\\\\.\\pipe\\'))
    console.log(`PASS data fixture unchanged; platform=${process.platform}`)
  } finally {
    for (const child of children) await stop(child, true)
    rmSync(root, { recursive: true, force: true })
  }
}
