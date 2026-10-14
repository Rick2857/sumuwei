import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { beforeDatabaseClose, createRuntimeShutdown } = await import(pathToFileURL(resolve(process.env.AVATAR3D_RUNTIME_ROOT, 'src/infrastructure/persistence/runtime-shutdown.ts')));
const events = [];
let held = true, ended = false;
const runtime = { stop: async () => { assert.equal(held, false, 'runtime.stop can close the pool too'); events.push('stop'); }, adapter: { manager: { getConnection: () => ({ get ended() { return ended; } }) },
  close: async () => { assert.equal(held, false, 'pool.end must never wait for the still-held qualification client'); ended = true; events.push('close'); } } };
beforeDatabaseClose(runtime, async () => { held = false; events.push('release'); });
const owner = createRuntimeShutdown(runtime), anotherCaller = createRuntimeShutdown(runtime);
assert.equal((await owner.shutdown()).closed, true);
await owner.shutdown();
assert.deepEqual(events, ['release', 'stop', 'close']);
await anotherCaller.shutdown();
assert.equal(events.filter(e => e === 'release').length, 1, 'different session close handles must not release twice');
let closedDespiteFailure = false;
const broken = { stop: async () => {}, adapter: { close: async () => { closedDespiteFailure = true; }, closed: true } };
beforeDatabaseClose(broken, async () => { throw Error('prepare injected failure'); });
const failed = await createRuntimeShutdown(broken).shutdown();
assert.ok(closedDespiteFailure); assert.equal(failed.stopFailed, true);
let fallbackClosed = false;
const fallback = { stop: async () => {}, adapter: { close: async () => { throw Error('adapter close fixture'); },
  manager: { getConnection: () => ({ close: async () => { fallbackClosed = true; }, get closed() { return fallbackClosed; } }) } } };
const recovered = await createRuntimeShutdown(fallback).shutdown();
assert.equal(recovered.closed, true); assert.equal(recovered.closeFailed, false, 'existing adapter-to-client fallback must still recover');
console.log('PASS shutdown ordering, idempotence across handles, and preparation failure still closes adapter');
