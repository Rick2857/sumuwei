import assert from 'node:assert/strict'
import { installNativeVoiceReplyPort, nativeVoiceReplyPortFor } from '../../src/infrastructure/model/native-voice-reply.ts'
import { createRuntimeShutdown } from '../../src/infrastructure/persistence/runtime-shutdown.ts'
import { assertIsolatedPostgresState } from './isolated-pg.ts'

const uninstall = installNativeVoiceReplyPort({ model: 'test', generate: async () => ({ text: 'test', durationMs: 1 }), correct: async () => ({ text: 'correction' }) })
assert.equal(nativeVoiceReplyPortFor('cli'), undefined)
assert.equal(nativeVoiceReplyPortFor('qq_private'), undefined)
assert.equal(nativeVoiceReplyPortFor('avatar')?.model, 'test')
assert.throws(() => installNativeVoiceReplyPort(nativeVoiceReplyPortFor('avatar')!), /already_installed/)
uninstall(); assert.equal(nativeVoiceReplyPortFor('avatar'), undefined)

// Regression: runtime.stop() itself may close the pool. A checked-out lock client
// returned only after close would deadlock; it must be returned before stop begins.
let released = false, closed = false
const order: string[] = []
const shutdown = createRuntimeShutdown({ stop: async () => { assert.equal(released, true); order.push('stop'); closed = true },
  adapter: { manager: { getConnection: () => ({ get ended() { return closed } }) }, close: async () => { order.push('close') } },
}, { beforeStop: async () => { released = true; order.push('release') } })
const first = shutdown.shutdown()
assert.equal(shutdown.shutdown(), first)
assert.equal((await first).closed, true)
assert.deepEqual(order, ['release', 'stop', 'close'])
console.log('PASS: native port entry isolation and PostgreSQL lock/pool shutdown order')
const isolated = { Mounts: [{ Destination: '/var/lib/postgresql/data', Name: 'lg-omni-isolated-data', RW: true }],
  HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55434' }] } }, State: { Running: true } }
assertIsolatedPostgresState(isolated)
assert.throws(() => assertIsolatedPostgresState({ ...isolated, Mounts: [{ ...isolated.Mounts[0]!, Name: 'lg-postgresql-data' }] }), /actual_mount/)
assert.throws(() => assertIsolatedPostgresState({ ...isolated, HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '55434' }] } } }), /actual_mount/)
assert.throws(() => assertIsolatedPostgresState({ ...isolated, State: { Running: false } }), /actual_mount/)
assertIsolatedPostgresState({ ...isolated, State: { Running: false } }, false)
assertIsolatedPostgresState(isolated)
console.log('PASS: shared production volume and non-loopback binding rejected; restored isolation passes')
