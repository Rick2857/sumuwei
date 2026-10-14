/** Private PG test entry. Installs a reply-only port before importing the existing main. */
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from 'node:process'
import { isolateDatabase } from '../../src/dev/sandbox.ts'
import { installNativeVoiceReplyPort, type NativeVoiceRequest } from '../../src/infrastructure/model/native-voice-reply.ts'
import { assertIsolatedPostgres, PG_CONTAINER, PG_HOST_PORT } from './isolated-pg.ts'
import { assertProductionPostgres, PRODUCTION_CONTAINER } from './production-pg.ts'
import { allowKernelMigration } from '../../src/db/index.ts'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const production = process.argv.includes('--production')
loadEnvFile(production && process.env.OMNI_PRODUCTION_ENV_FILE
  ? process.env.OMNI_PRODUCTION_ENV_FILE
  : fileURLToPath(new URL(production ? '../../.env' : '.lg-core.local.env', import.meta.url)))
if (process.env.CHARACTER_DB_BACKEND !== 'postgres') throw new Error('native_voice_pg_required')
const target = process.env.POSTGRES_URL
if (target === undefined) throw new Error('native_voice_database_required')
if (production) {
  assertProductionPostgres(target)
  process.env.LG_PG_CONTAINER = PRODUCTION_CONTAINER
  process.env.LG_PG_EXPECT_DATABASE = 'sumuwei'
  // Same defense as the PG cutover probe: a PG entry must never guard/open legacy PGlite.
  // Backend and actual database identity remain fail-closed; this is not a test marker.
  process.env.PGLITE_DATA_DIR = mkdtempSync(join(tmpdir(), 'lg-native-production-fallback-'))
} else {
  if (!/^\/lg_test_omni_[a-z0-9_]+$/.test(new URL(target).pathname)) throw new Error('native_voice_test_database_required')
  if (new URL(target).hostname !== '127.0.0.1' || new URL(target).port !== PG_HOST_PORT || process.env.LG_PG_CONTAINER !== PG_CONTAINER) throw new Error('native_voice_test_instance_required')
  assertIsolatedPostgres()
  isolateDatabase('omni-core', { keep: true, postgres: { url: target } })
  allowKernelMigration()
}
const endpoint = new URL(process.env.OMNI_CORE_REPLY_ENDPOINT ?? '')
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/native-reply') throw new Error('native_voice_endpoint_invalid')
const token = process.env.OMNI_CORE_REPLY_TOKEN
if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('native_voice_auth_missing')
process.env.CHARACTER_EXPRESSIVE_SPEECH = 'false'
process.env.DEBUG_CONTEXT = '0'

async function request(input: NativeVoiceRequest & { checkedText?: string }, phase: 'generate' | 'correct') {
  input.signal?.throwIfAborted()
  const response = await fetch(endpoint, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${token}`,
  }, body: JSON.stringify({ prompt: input.prompt, replyId: input.replyId, traceId: input.traceId,
    phase, ...(input.checkedText === undefined ? {} : { checkedText: input.checkedText }) }),
    signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(input.signal === undefined ? [] : [input.signal])]),
  })
  if (!response.ok) throw new Error('native_voice_transport_failed')
  const value = await response.json() as { text?: unknown; durationMs?: unknown }
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16000 || typeof value.durationMs !== 'number') throw new Error('native_voice_reply_invalid')
  return { text: value.text, durationMs: value.durationMs }
}
installNativeVoiceReplyPort({ model: 'qwen3.8-omni-flash-realtime', generate: input => request(input, 'generate'), correct: input => request(input, 'correct') })
process.argv = [process.argv[0]!, process.argv[1]!, '--bridge']
await import('../../src/main.ts')
