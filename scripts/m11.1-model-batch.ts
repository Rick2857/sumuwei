import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** D-02 initial batch, or a separately approved 480-call confirmation. Counts calls, not money. */
export function openM111ModelBatch(fingerprints: { semantic: string; behavior: string }, root = resolve('artifacts/m11.1/local/initial-model-batch'), confirmationDecisionId?: string) {
  execFileSync('git', ['check-ignore', '--quiet', root])
  mkdirSync(root, { recursive: true })
  const metaPath = join(root, 'batch.json')
  const model = { endpointHost: new URL(process.env.OPENAI_BASE_URL!).host,
    small: process.env.OPENAI_SMALL_MODEL, large: process.env.OPENAI_LARGE_MODEL }
  const maxRequests = confirmationDecisionId === undefined ? 1700 : 480
  const expected = confirmationDecisionId === undefined
    ? { version: 'm111-initial-model-batch@1', maxRequests, fingerprints, model }
    : { version: 'm111-confirmation-model-batch@1', maxRequests, fingerprints, model, confirmationDecisionId }
  if (existsSync(metaPath)) {
    if (JSON.stringify(JSON.parse(readFileSync(metaPath, 'utf8'))) !== JSON.stringify(expected)) throw new Error('Frozen model batch config/corpus changed; explicit new batch decision required')
  } else writeFileSync(metaPath, JSON.stringify(expected), { flag: 'wx' })
  const reservations = join(root, 'calls')
  mkdirSync(reservations, { recursive: true })
  const count = () => readdirSync(reservations).filter(n => n.endsWith('.json')).length
  const batch = {
    count,
    reserve(phase: 'semantic' | 'behavior' | 'preparation' | 'short' | 'dialogue' | 'joint', callId: string) {
      const key = createHash('sha256').update(`${phase}\0${callId}`).digest('hex')
      // Exclusive create also guards accidental replay across restarted processes.
      const path = join(reservations, `${key}.json`)
      const lockPath = join(root, 'reservation.lock')
      const lock = openSync(lockPath, 'wx') // Concurrent orchestrators fail closed instead of exceeding the cap.
      try {
        if (existsSync(path)) throw new Error('The batch already reserved this call identity; audit the existing result instead of silently repeating it')
        if (count() >= maxRequests) throw new Error('Frozen model batch limit reached; no additional request authorized in this batch')
        writeFileSync(path, JSON.stringify({ phase, callId, reservedAt: new Date().toISOString(), status: 'reserved', requestCount: 1 }), { flag: 'wx' })
      } finally { closeSync(lock); unlinkSync(lockPath) }
      return (status: 'returned' | 'transport_failed') => writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), endedAt: new Date().toISOString(), status }))
    },
    async reserveWhenAvailable(phase: 'semantic' | 'behavior' | 'preparation' | 'short' | 'dialogue' | 'joint', callId: string) {
      // Wait only for another writer's short reservation transaction, never retry a model request.
      const deadline = Date.now() + 5_000
      for (;;) {
        try { return batch.reserve(phase, callId) }
        catch (error) {
          const failure = error as NodeJS.ErrnoException
          if (failure.code !== 'EEXIST' || failure.path !== join(root, 'reservation.lock') || Date.now() >= deadline) throw error
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
    },
  }
  return batch
}
