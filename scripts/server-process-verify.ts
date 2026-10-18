/** Verify the encoder PID is the real worker, not a CLI forwarding process. No model, DB or network. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createEncoderClient } from '../src/infrastructure/semantic/encoder-client.ts'
import { loadEmbeddingManifest } from '../src/infrastructure/semantic/embedding-manifest.ts'
const root = mkdtempSync(join(tmpdir(), 'lg-worker-pid-'))
mkdirSync(join(root, 'src/infrastructure/semantic'), { recursive: true })
symlinkSync(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(join(root, 'src/infrastructure/semantic/encoder-worker-entry.ts'), `
import { createInterface } from 'node:readline';
console.log(JSON.stringify({type:'ready',fingerprint:String(process.pid)}));
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{if(JSON.parse(line).kind==='exit')process.exit(0)});
lines.on('close',()=>process.exit(0));
`)
const encoder = createEncoderClient({ manifest: loadEmbeddingManifest(resolve('evals/m9.5/embedding-manifest.json')),
  repoRoot: root, localModelPath: root, deadlineMs: 1000, readyTimeoutMs: 5000 })
let actual: number | undefined
try {
  actual = Number(await encoder.fingerprintPromise)
  assert.equal(encoder.pid(), actual, 'kill/close must target the real worker PID')
  await encoder.close()
  assert.equal(encoder.pid(), null)
  assert.throws(()=>process.kill(actual!, 0))
  console.log('PASS direct worker PID, graceful close, no forwarding process or orphan')
} finally {
  await encoder.close()
  if (actual && Number.isSafeInteger(actual)) { try { process.kill(actual, 'SIGKILL') } catch {} }
  rmSync(root, { recursive: true, force: true })
}
