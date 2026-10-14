import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createMock, DEMO_TEXT } from './mock.mjs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { lgSession } from './lg-session.mjs';

export const MODEL = 'qwen3.8-omni-flash-realtime';
export function liveConfig(env) {
  if (!env.DASHSCOPE_API_KEY?.trim() || !/^[a-zA-Z0-9_-]+$/.test(env.DASHSCOPE_WORKSPACE_ID ?? '')) {
    throw new Error('omni_credentials_missing');
  }
  const region = env.DASHSCOPE_REGION || 'cn-beijing';
  if (!['cn-beijing', 'ap-southeast-1'].includes(region)) throw new Error('omni_region_invalid');
  return { key: env.DASHSCOPE_API_KEY,
    url: `wss://${env.DASHSCOPE_WORKSPACE_ID}.${region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${MODEL}` };
}

export function sessionConfig() {
  return { type: 'session.update', session: {
    modalities: ['text', 'audio'],
    instructions: '你正在进行一个独立语音测试。请用自然、简短的中文回答，英文术语保留并正确发音。不要声称具备长期记忆、电脑操作或其他未接入的工具。',
    audio: { input: { format: { type: 'pcm', sample_rate: 16000, sample_format: 's16le', channels: 1,
      packing: 'interleaved', channel_layout: 'mono' } },
      output: { voice: 'Liora Mira', format: { type: 'pcm', sample_rate: 24000 } } },
    input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
    turn_detection: { type: 'semantic_vad', threshold: 0.5, silence_duration_ms: 600 },
    enable_search: false, tools: [],
  } };
}

export function validCommand(command, live, integrated = false) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
  if (command.type === 'interrupt' || command.type === 'microphone_off') return true;
  if (command.type === 'audio_commit') return integrated;
  if (command.type === 'text') return typeof command.text === 'string' && command.text.trim().length > 0 && command.text.length <= 2000;
  if (command.type === 'demo') return !live && Object.hasOwn(DEMO_TEXT, command.scenario);
  if (command.type === 'audio') {
    if (typeof command.audio !== 'string' || command.audio.length > 48000 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(command.audio)) return false;
    const bytes = Buffer.from(command.audio, 'base64');
    return bytes.length > 0 && bytes.length % 2 === 0 && bytes.toString('base64') === command.audio;
  }
  return false;
}

export async function startServer({ port = 12410, live = false, credentials,
  // Test injection is in-process only; clients cannot supply an endpoint.
  connectProvider, onClientEvent = () => {}, coreFactory, avatar3d = false, production = false } = {}) {
  if (live && !connectProvider) credentials ??= liveConfig(process.env);
  const files = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
    ['/core.mjs', ['core.mjs', 'text/javascript; charset=utf-8']],
    ['/capture-worklet.js', ['capture-worklet.js', 'text/javascript; charset=utf-8']],
    ['/omni-avatar.mjs', ['omni-avatar.mjs', 'text/javascript; charset=utf-8']],
  ]);
  const importMap = '{"imports":{"three":"/vendor/three/build/three.module.js","three/addons/":"/vendor/three/examples/jsm/","@pixiv/three-vrm":"/vendor/vrm.js"}}';
  const mapHash = createHash('sha256').update(importMap).digest('base64');
  let client = null;
  let core, nativeSession;
  const replyToken = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host) { res.writeHead(403).end(); return; }
    if (coreFactory && req.url === '/native-reply' && req.method === 'POST') {
      const authorization = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${replyToken}`);
      if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected) || req.headers.origin || !nativeSession) { res.writeHead(403).end(); return; }
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        const chunks = []; let size = 0;
        for await (const bytes of req) { chunks.push(bytes); size += bytes.length; if (size > 512000) throw new Error(); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!['generate', 'correct'].includes(input.phase) || typeof input.prompt !== 'string' || input.prompt.length > 200000 ||
            typeof input.replyId !== 'string' || typeof input.traceId !== 'string' ||
            (input.phase === 'correct' && (typeof input.checkedText !== 'string' || input.checkedText.length > 16000))) throw new Error();
        const result = await nativeSession.reply(input, controller.signal);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
      } catch { controller.abort(); if (!res.destroyed) res.writeHead(502).end('native_voice_failed'); }
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'sha256-${mapHash}'; style-src 'unsafe-inline'; connect-src 'self' blob:; img-src 'self' blob: data:; frame-ancestors 'none'`);
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ mode: live ? 'live' : 'offline', model: MODEL, integrated: Boolean(coreFactory),
        database: coreFactory ? (production ? 'production-postgres' : 'isolated-postgres') : 'not-connected',
        production, avatar3d, tools: coreFactory ? 'LG-gateway' : 'none' }));
      return;
    }
    if (avatar3d) {
      let asset;
      if (req.url === '/avatar3d/avatar.js') asset = ['public/avatar.js', 'text/javascript'];
      else if (req.url === '/vendor/vrm.js') asset = ['node_modules/@pixiv/three-vrm/lib/three-vrm.module.min.js', 'text/javascript'];
      else if (/^\/vendor\/three\/(?:build|examples\/jsm)\/[A-Za-z0-9_./-]+\.js$/.test(req.url) && !req.url.split('/').includes('..')) asset = ['node_modules/three/' + req.url.slice('/vendor/three/'.length), 'text/javascript'];
      else if (['/models/local.json', '/models/aoba.vrm', '/models/aoba-hatless.vrm'].includes(req.url)) asset = ['public' + req.url, req.url.endsWith('.json') ? 'application/json' : 'application/octet-stream'];
      if (asset) {
        try { res.setHeader('Content-Type', asset[1]); res.end(await readFile(new URL('../../tools/avatar-3d/' + asset[0], import.meta.url))); }
        catch { res.writeHead(404).end(); }
        return;
      }
    }
    const file = files.get(req.url);
    if (!file) { res.writeHead(404).end(); return; }
    try {
      res.setHeader('Content-Type', file[1]);
      const content = await readFile(new URL(`public/${file[0]}`, import.meta.url));
      res.end(req.url === '/' && avatar3d ? content.toString().replace('<script type="module"', `<script type="importmap">${importMap}</script><script type="module"`) : content);
    }
    catch { res.writeHead(500).end('asset_read_failed'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.url !== '/stream' || req.headers.host !== origin.slice(7) || req.headers.origin !== origin || client || (coreFactory && !core)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    client = ws;
    let provider, epoch = 0, active = null, pending = false, ready = false, closed = false;
    let queuedAudio = [], queuedAudioBytes = 0;
    const send = event => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, 'client_backlog'); return; }
      ws.send(JSON.stringify(event));
    };
    const fail = code => { send({ type: 'prototype.error', code }); ws.close(1011, code); };
    const session = coreFactory ? lgSession({ core, send: event => send({ ...event, sessionEpoch: epoch }),
      sendProvider: event => provider.send(event), resetProvider: () => openProvider() }) : undefined;
    nativeSession = session;
    function openProvider() {
      const token = ++epoch;
      ready = false; active = null; pending = false;
      queuedAudio = []; queuedAudioBytes = 0;
      provider?.close();
      send({ type: 'prototype.session', mode: live ? 'live' : 'offline', sessionEpoch: token });
      const emit = event => {
        if (closed || token !== epoch) return;
        if (event.type === 'input_audio_buffer.speech_stopped') pending = true;
        if (event.type === 'response.created') { active = event.response.id; pending = false; }
        if (event.type === 'response.done' && event.response.id === active) active = null;
        // Never forward arbitrary provider error bodies or credentials to the page.
        if (event.type === 'error') { fail('provider_error'); return; }
        if (session && !session.event(event)) return;
        send({ ...event, ...(session && event.type === 'session.updated' ? { session: {
          model: event.session?.model, audio: event.session?.audio, turn_detection: event.session?.turn_detection,
        } } : {}), sessionEpoch: token });
      };
      const markReady = () => {
        if (closed || token !== epoch) return;
        ready = true;
        send({ type: 'prototype.ready', sessionEpoch: token });
        for (const command of queuedAudio) session?.command(command);
        queuedAudio = []; queuedAudioBytes = 0;
      };
      if (!live) { provider = createMock(emit); markReady(); return; }
      if (connectProvider) { provider = connectProvider(emit, markReady); return; }
      const upstream = new WebSocket(credentials.url, { headers: { Authorization: `Bearer ${credentials.key}` },
        handshakeTimeout: 10000, maxPayload: 2 * 1024 * 1024 });
      const timeout = setTimeout(() => { if (token === epoch && !ready) fail('provider_session_timeout'); }, 15000);
      provider = {
        send(event) {
          if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 1024 * 1024) {
            fail('provider_backlog_or_closed'); return;
          }
          upstream.send(JSON.stringify(event));
        },
        close() { clearTimeout(timeout); upstream.terminate(); },
      };
      upstream.on('open', () => {
        const config = sessionConfig();
        if (session) config.session.turn_detection = null;
        upstream.send(JSON.stringify(config));
      });
      upstream.on('message', data => {
        if (closed || token !== epoch) return;
        let event;
        try { event = JSON.parse(data); } catch { fail('provider_json_invalid'); return; }
        if (event.type === 'session.updated') { clearTimeout(timeout); markReady(); }
        emit(event);
      });
      upstream.on('error', () => { if (!closed && token === epoch) fail('provider_connection_failed'); });
      upstream.on('close', () => { if (!closed && token === epoch) fail('provider_disconnected'); });
    }
    openProvider();
    // ponytail: one session, ten-minute ceiling; reconnect for longer prototype runs.
    const lifetime = setTimeout(() => ws.close(1000, 'prototype_session_limit'), 10 * 60 * 1000);
    ws.on('message', (bytes, binary) => {
      let command;
      try { if (binary) throw new Error(); command = JSON.parse(bytes); }
      catch { fail('command_json_invalid'); return; }
      if (!validCommand(command, live, Boolean(session))) { fail('command_rejected'); return; }
      if (!ready) {
        if (session && ['audio', 'audio_commit'].includes(command.type)) {
          queuedAudioBytes += command.audio ? Buffer.from(command.audio, 'base64').length : 0;
          if (queuedAudioBytes > 32000 || queuedAudio.length > 500) { fail('reconnect_audio_backlog'); return; }
          queuedAudio.push(command); return;
        }
        send({ type: 'prototype.error', code: 'provider_not_ready' }); return;
      }
      onClientEvent(command.type);
      if (session) { session.command(command); return; }
      if (command.type === 'interrupt') {
        // No response ID yet: reset the provider session instead of guessing which late response to cancel.
        if (pending) { openProvider(); return; }
        if (active) provider.send({ type: 'response.cancel' });
        return;
      }
      if (command.type === 'microphone_off') { provider.send({ type: 'input_audio_buffer.clear' }); return; }
      if (command.type === 'audio') provider.send({ type: 'input_audio_buffer.append', audio: command.audio });
      else if (active || pending) send({ type: 'prototype.error', code: 'response_busy' });
      else if (command.type === 'demo') provider.send({ type: 'prototype.demo', scenario: command.scenario });
      else {
        pending = true;
        provider.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user',
          content: [{ type: 'input_text', text: command.text }] } });
        provider.send({ type: 'response.create' });
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => { closed = true; session?.cancel(false); epoch++; provider?.close(); clearTimeout(lifetime); if (client === ws) { client = null; nativeSession = undefined; } });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  if (coreFactory) {
    try { core = await coreFactory({ endpoint: `http://127.0.0.1:${server.address().port}/native-reply`, token: replyToken }); }
    catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  }
  return { port: server.address().port, close: async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    return core?.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const live = process.argv.includes('--live');
  if (live) {
    try { loadEnvFile(fileURLToPath(new URL('.env.local', import.meta.url))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const app = await startServer({ live });
  console.log(`OMNI_PROTOTYPE_READY mode=${live ? 'live' : 'offline'} url=http://127.0.0.1:${app.port} database=none`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
