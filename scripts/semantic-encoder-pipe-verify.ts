/** Reproduce a worker closing stdin while still alive: no unhandled EPIPE, no claimed reclamation before exit. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createEncoderClient } from '../src/infrastructure/semantic/encoder-client.ts'
import { loadEmbeddingManifest } from '../src/infrastructure/semantic/embedding-manifest.ts'
if (process.platform === 'win32') {
  console.log('SKIP Linux pipe-close reproduction: Windows retains a separate stdin handle; run this check on Linux')
  process.exit(0)
}
const root = mkdtempSync(join(tmpdir(), 'lg-encoder-pipe-'))
mkdirSync(join(root, 'src/infrastructure/semantic'), { recursive: true })
writeFileSync(join(root, 'src/infrastructure/semantic/encoder-worker-entry.ts'),
  `const { closeSync } = require('node:fs'); closeSync(0); console.log(JSON.stringify({type:'ready',fingerprint:'fixture'})); setInterval(()=>{},1000);`)
mkdirSync(join(root, 'node_modules/tsx/dist'), { recursive: true })
writeFileSync(join(root, 'node_modules/tsx/dist/loader.mjs'), '// direct worker fixture loader')
const encoder = createEncoderClient({ manifest: loadEmbeddingManifest(resolve('evals/m9.5/embedding-manifest.json')),
  repoRoot: root, localModelPath: root, deadlineMs: 3000, readyTimeoutMs: 5000 })
try {
  await encoder.fingerprintPromise
  const result = await encoder.encode(['query: pipe failure ' + 'x'.repeat(1_000_000)])
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.reason, 'worker_exited', JSON.stringify(result))
  assert(encoder.reclaimLog.kills.length > 0)
  assert(encoder.reclaimLog.exits.length > 0)
  await encoder.close(); assert.equal(encoder.pid(), null)
  console.log('PASS encoder EPIPE: no core crash; pending work settles after worker exit; no orphan')
} finally { await encoder.close(); rmSync(root, { recursive: true, force: true }) }
