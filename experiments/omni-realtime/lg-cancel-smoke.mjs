import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from './server.mjs';
import { startLG } from './lg-process.mjs';

loadEnvFile(fileURLToPath(new URL('.env.local', import.meta.url)));
const directory = new URL(`live-runs/cancel-${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
await mkdir(directory, { recursive: true });
const result = { schema: 'omni-lg-cancel@1', status: 'FAIL', physicalPlayback: 'NOT_MEASURED', productionUsed: false };
let app, socket;
try {
  app = await startServer({ port: 0, live: true, coreFactory: options => startLG({ ...options,
    onDiagnostic: text => { void appendFile(new URL('core.local.log', directory), text + '\n'); } }) });
  socket = new WebSocket(`ws://127.0.0.1:${app.port}/stream`, { origin: `http://127.0.0.1:${app.port}` });
  const events = [], waiters = new Set();
  socket.on('message', raw => {
    const event = JSON.parse(raw);
    events.push({ type: event.type, sessionEpoch: event.sessionEpoch, responseId: event.response_id ?? event.response?.id });
    for (const waiter of [...waiters]) if (waiter.match(event)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(event); }
  });
  const wait = match => new Promise((resolve, reject) => {
    const waiter = { match, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error('cancel_smoke_timeout')); }, 45000) };
    waiters.add(waiter);
  });
  const initial = await wait(e => e.type === 'prototype.ready');
  const firstAudio = wait(e => e.type === 'response.audio.delta');
  socket.send(JSON.stringify({ type: 'text', text: '请从一数到一百，逐个数字念出来，慢一点。' }));
  const packet = await firstAudio;
  const sentAt = performance.now();
  const ack = wait(e => e.type === 'lg.cancel_result');
  const ready = wait(e => e.type === 'prototype.ready' && e.sessionEpoch > initial.sessionEpoch);
  socket.send(JSON.stringify({ type: 'interrupt' }));
  result.cancel = await ack; result.coreCancelAckMs = Math.round(performance.now() - sentAt);
  const next = await ready;
  result.providerReconnectedMs = Math.round(performance.now() - sentAt);
  assert.equal(result.cancel.outcome, 'cancelled');
  assert.equal(result.cancel.cancel.requested, true);
  assert.equal(result.cancel.cancel.alreadyCommitted, false);
  await new Promise(resolve => setTimeout(resolve, 500));
  const resetAt = events.findIndex(e => e.type === 'prototype.session' && e.sessionEpoch === next.sessionEpoch);
  result.oldAudioAfterReset = events.slice(resetAt).filter(e => e.type === 'response.audio.delta' && e.responseId === packet.response_id).length;
  assert.equal(result.oldAudioAfterReset, 0);
  const resumed = wait(e => e.type === 'lg.turn_result');
  socket.send(JSON.stringify({ type: 'text', text: '请只说：现在可以继续了。' }));
  result.resumed = await resumed;
  assert.equal(result.resumed.outcome, 'replied');
  result.status = 'PASS';
} catch (error) { result.reason = /^[a-z_]+$/.test(error.message) ? error.message : 'cancel_smoke_failed'; process.exitCode = 1; }
finally {
  socket?.terminate(); if (app) result.shutdown = await app.close();
  if (app && result.shutdown?.code !== 0) { result.status = 'FAIL'; result.reason = 'lg_shutdown_failed'; process.exitCode = 1; }
  await writeFile(new URL('result.json', directory), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ ...result, evidencePath: fileURLToPath(new URL('result.json', directory)) }));
