import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { ResponseGate, PCM16Resampler, decodePCM16, PCMPlayer } from './public/core.mjs';
import { startServer, validCommand, liveConfig, sessionConfig } from './server.mjs';
import { tonePCM } from './mock.mjs';

function event(type, id, sessionEpoch = 1) {
  return { type, sessionEpoch, response_id: id, response: { id, status: 'completed' } };
}
test('cancelled/duplicate/old-generation packets cannot restore playback or replace the new response', () => {
  const gate = new ResponseGate(); gate.reset(1);
  assert.equal(gate.accept(event('response.created', 'a')), true);
  assert.equal(gate.accept(event('response.audio.delta', 'a')), true);
  gate.interrupt();
  assert.equal(gate.accept(event('response.audio.delta', 'a')), false);
  assert.equal(gate.accept(event('response.created', 'a')), false);
  assert.equal(gate.accept(event('response.created', 'b')), true);
  assert.equal(gate.accept(event('response.done', 'a')), false);
  assert.equal(gate.current, 'b');
  assert.equal(gate.accept(event('response.audio.delta', 'b')), true);
  assert.equal(gate.accept(event('response.done', 'b')), true);
  assert.equal(gate.accept(event('response.audio.delta', 'b')), false);
  gate.reset(2);
  assert.equal(gate.accept(event('response.created', 'old-session', 1)), false);
  assert.equal(gate.accept(event('response.created', 'fresh', 2)), true);
});

test('streaming resampling is block-independent at 48/44.1 kHz, explicit LE, clipped and finite', () => {
  for (const rate of [48000, 44100, 16000]) {
    const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(i / 25) * 1.5);
    const whole = new PCM16Resampler(rate).push(input);
    const stream = new PCM16Resampler(rate);
    const chunks = [];
    for (let i = 0; i < input.length; i += 128) chunks.push(stream.push(input.slice(i, i + 128)));
    assert.equal(whole.length, 32000);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(whole));
    assert.ok([...decodePCM16(whole)].every(v => Number.isFinite(v) && v >= -1 && v <= 1));
  }
  assert.deepEqual([...new PCM16Resampler(16000).push([-1, 1])], [0, 128, 255, 127]);
  assert.throws(() => decodePCM16(new Uint8Array(3)), /invalid_pcm16_length/);
  assert.throws(() => new PCM16Resampler(8000), /unsupported_capture/);
});

test('local stop really stops all Web Audio nodes, clears queue and never reports played', () => {
  const nodes = [], reports = [];
  const context = { currentTime: 10, destination: {},
    createBuffer: () => ({ copyToChannel() {} }),
    createBufferSource: () => {
      const node = { connect() {}, disconnect() {}, start(at) { this.at = at; }, stop() { this.stopped = true; } };
      nodes.push(node); return node;
    } };
  const player = new PCMPlayer(context, (state, identity) => reports.push({ state, ...identity }));
  const samples = new Float32Array(2400);
  player.feed(samples, { responseId: 'a', generation: 1 });
  player.feed(samples, { responseId: 'a', generation: 1 });
  assert.ok(nodes[1].at >= nodes[0].at + .1);
  context.currentTime = 10.06;
  player.stop('user_button');
  assert.ok(nodes.every(node => node.stopped && node.onended === null));
  assert.equal(player.nodes.size, 0);
  assert.equal(player.nextTime, context.currentTime);
  assert.equal(reports.filter(r => r.state === 'cancelled').length, 2);
  assert.ok(reports.find(r => r.state === 'cancelled').playedMs > 0);
  assert.equal(reports.some(r => r.state === 'ended'), false);
  player.feed(samples, { responseId: 'b', generation: 2 });
  nodes[2].onended();
  assert.equal(reports.at(-1).state, 'ended');
  assert.equal(player.nodes.size, 0);
  context.currentTime = 0; player.nextTime = 10;
  player.feed(samples, { responseId: 'native', generation: 3 });
  player.stop('native_long_reply');
  player.nextTime = 31;
  assert.throws(() => player.feed(samples, {}), /playback_backlog/);
});

test('boundary rejects arbitrary provider commands, endpoints, invalid PCM and live-only mock', () => {
  for (const cmd of [null, [], {}, { type: 'session.update' }, { type: 'function_call_output' },
    { type: 'audio', audio: 'AA==' }, { type: 'audio', audio: 'not base64' },
    { type: 'text', text: ' ' }, { type: 'text', text: 'a'.repeat(2001) }, { type: 'demo', scenario: 'unknown' }]) {
    assert.equal(validCommand(cmd, false), false);
  }
  assert.equal(validCommand({ type: 'audio', audio: 'AAA=' }, false), true);
  assert.equal(validCommand({ type: 'text', text: 'GitHub 中文 3.8' }, true), true);
  assert.equal(validCommand({ type: 'demo', scenario: 'mixed' }, true), false);
  assert.throws(() => liveConfig({ POSTGRES_URL: 'unused', OPENAI_API_KEY: 'not-reusable' }), /credentials_missing/);
  assert.throws(() => liveConfig({ DASHSCOPE_API_KEY: 'secret', DASHSCOPE_WORKSPACE_ID: 'id', DASHSCOPE_REGION: 'evil.test' }), /region_invalid/);
  const config = liveConfig({ DASHSCOPE_API_KEY: 'secret', DASHSCOPE_WORKSPACE_ID: 'workspace', DASHSCOPE_REGION: 'cn-beijing' });
  assert.equal(new URL(config.url).hostname, 'workspace.cn-beijing.maas.aliyuncs.com');
  assert.equal(new URL(config.url).searchParams.get('model'), 'qwen3.8-omni-flash-realtime');
  assert.deepEqual(sessionConfig().session.tools, []);
  assert.equal(sessionConfig().session.enable_search, false);
});

async function client(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/stream`, { origin: `http://127.0.0.1:${port}` });
  const events = [], waiters = new Set();
  socket.on('message', raw => {
    const value = JSON.parse(raw); events.push(value);
    for (const waiter of [...waiters]) if (waiter.predicate(value)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(value); }
  });
  const wait = (predicate, from = 0) => {
    const existing = events.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error('event_timeout')); }, 3000) };
      waiters.add(waiter);
    });
  };
  await once(socket, 'open');
  await wait(e => e.type === 'prototype.ready');
  return { socket, events, wait, send: command => socket.send(JSON.stringify(command)),
    close: async () => { if (socket.readyState === WebSocket.CLOSED) return; const ended = once(socket, 'close'); socket.close(); await ended; } };
}

test('offline real HTTP/WebSocket transport: health, mixed text, stale cancellation, correction and microphone', async t => {
  let outbound = 0;
  const app = await startServer({ port: 0, connectProvider: () => { outbound++; throw new Error('offline_must_not_connect'); } });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(health, { mode: 'offline', model: 'qwen3.8-omni-flash-realtime', integrated: false, database: 'not-connected', production: false, avatar3d: false, tools: 'none' });
  assert.equal((await fetch(`${base}/.env.local`)).status, 404);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: app.port, headers: { Host: 'evil.test' } }, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  const html = await fetch(base);
  assert.ok(html.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.ok((await html.text()).includes('中英文混合'));
  const c = await client(app.port); t.after(() => c.close());
  c.send({ type: 'demo', scenario: 'mixed' });
  const first = await c.wait(e => e.type === 'response.audio.delta');
  assert.equal(Buffer.from(first.delta, 'base64').length, 8640);
  assert.ok(c.events.find(e => e.type === 'response.audio_transcript.delta').delta.includes('GitHub'));
  const gate = new ResponseGate();
  for (const e of c.events) { if (e.type === 'prototype.session') gate.reset(e.sessionEpoch); else if (e.type !== 'prototype.ready') gate.accept(e); }
  gate.interrupt();
  c.send({ type: 'interrupt' });
  await c.wait(e => e.type === 'response.done' && e.response.id === first.response_id);
  const late = await c.wait(e => e.type === 'response.audio.delta' && e.response_id === first.response_id, c.events.length);
  assert.equal(gate.accept(late), false);
  const index = c.events.length;
  c.send({ type: 'demo', scenario: 'correction' });
  const correction = await c.wait(e => e.type === 'prototype.correction', index);
  const corrected = await c.wait(e => e.type === 'response.audio_transcript.delta' && e.delta.includes('没有保存成功'), index);
  assert.notEqual(correction.response_id, corrected.response_id);
  const correctedGate = new ResponseGate(); correctedGate.reset(corrected.sessionEpoch);
  for (const e of c.events.slice(index)) {
    if (e.type === 'prototype.correction') correctedGate.interrupt(); else correctedGate.accept(e);
  }
  const delayed = await c.wait(e => e.type === 'response.audio.delta' && e.response_id === correction.response_id, c.events.length);
  assert.equal(correctedGate.accept(delayed), false);
  c.send({ type: 'interrupt' });
  await c.wait(e => e.type === 'response.done' && e.response.id === corrected.response_id);
  const micIndex = c.events.length;
  c.send({ type: 'audio', audio: tonePCM() });
  await c.wait(e => e.type === 'input_audio_buffer.speech_started', micIndex);
  c.send({ type: 'audio', audio: Buffer.alloc(16000).toString('base64') });
  await c.wait(e => e.type === 'conversation.item.input_audio_transcription.completed', micIndex);
  assert.equal(outbound, 0);
});

test('interrupt before response ID resets session and discards late callbacks across epochs', async t => {
  const providers = [];
  const app = await startServer({ port: 0, live: true, connectProvider: (emit, ready) => {
    const provider = { emit, closed: false, sent: [], send(event) {
      this.sent.push(event);
      if (event.type === 'response.create') emit({ type: 'prototype.fixture.command_forwarded' });
      if (event.type === 'input_audio_buffer.clear') emit({ type: 'prototype.fixture.microphone_cleared' });
    }, close() { this.closed = true; } };
    providers.push(provider); ready(); return provider;
  } });
  t.after(() => app.close());
  const c = await client(app.port); t.after(() => c.close());
  c.send({ type: 'microphone_off' });
  await c.wait(e => e.type === 'prototype.fixture.microphone_cleared');
  c.send({ type: 'text', text: '测试待响应取消' });
  await c.wait(e => e.type === 'prototype.fixture.command_forwarded');
  assert.equal(providers[0].sent.find(e => e.type === 'conversation.item.create').item.content[0].text, '测试待响应取消');
  // Wait for processing through another observable event, avoiding a timing guess.
  providers[0].emit({ type: 'input_audio_buffer.speech_stopped' });
  await c.wait(e => e.type === 'input_audio_buffer.speech_stopped');
  c.send({ type: 'interrupt' });
  await c.wait(e => e.type === 'prototype.ready' && e.sessionEpoch === 2);
  assert.equal(providers[0].closed, true);
  providers[0].emit({ type: 'response.created', response: { id: 'stale' } });
  providers[0].emit({ type: 'response.audio.delta', response_id: 'stale', delta: tonePCM() });
  providers[1].emit({ type: 'response.created', response: { id: 'fresh' } });
  await c.wait(e => e.type === 'response.created' && e.response.id === 'fresh');
  assert.equal(c.events.some(e => e.response?.id === 'stale' || e.response_id === 'stale'), false);
  assert.equal(c.events.at(-1).sessionEpoch, 2);
});

test('cross-origin and second browser sessions are rejected; malformed command fails closed', async t => {
  const app = await startServer({ port: 0 }); t.after(() => app.close());
  const attempt = async origin => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/stream`, { origin });
    const [error] = await once(ws, 'error');
    assert.match(error.message, /403/);
  };
  await attempt('https://evil.example');
  const c = await client(app.port);
  await attempt(`http://127.0.0.1:${app.port}`);
  const ended = once(c.socket, 'close');
  c.send({ type: 'session.update', session: { tools: [{ type: 'mcp' }] } });
  const error = await c.wait(e => e.type === 'prototype.error');
  assert.equal(error.code, 'command_rejected');
  await ended;
});

test('native HTTP requires private auth, preserves split UTF-8 context, and redacts prompt from browser', async t => {
  let endpoint, token, received;
  const prompt = '中文人格与事实。'.repeat(1500);
  const app = await startServer({ port: 0, live: true,
    coreFactory: async options => {
      ({ endpoint, token } = options);
      return { close: async () => ({ code: 0 }), cancel: async () => ({}), submit: async () => {
        const body = Buffer.from(JSON.stringify({ prompt, replyId: 'r', traceId: 't', phase: 'generate' }));
        const text = await new Promise((resolve, reject) => {
          const request = http.request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}` } }, response => {
            let value = ''; response.on('data', bytes => value += bytes); response.on('end', () => resolve(value));
          });
          request.on('error', reject);
          // Flush one byte at a time so Chinese codepoints cross HTTP chunks.
          for (const byte of body) request.write(Buffer.of(byte));
          request.end();
        });
        assert.equal(JSON.parse(text).text, '已收到');
        return { outcome: 'replied', replyId: 'r', traceId: 't' };
      } };
    },
    connectProvider: (emit, ready) => {
      queueMicrotask(ready);
      return { close() {}, send(event) {
        if (event.type === 'session.update') { received = event.session.instructions; queueMicrotask(() => emit({ type: 'session.updated', session: event.session })); }
        if (event.type === 'response.create') queueMicrotask(() => {
          emit({ type: 'response.created', response: { id: 'native-r' } });
          emit({ type: 'response.audio_transcript.delta', response_id: 'native-r', delta: '已收到' });
          emit({ type: 'response.done', response: { id: 'native-r', status: 'completed' } });
        });
      } };
    },
  }); t.after(() => app.close());
  const c = await client(app.port); t.after(() => c.close());
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  c.send({ type: 'text', text: '你好' });
  await c.wait(e => e.type === 'lg.turn_result');
  assert.ok(received.startsWith(prompt));
  assert.equal(c.events.some(e => e.session?.instructions), false);
});
