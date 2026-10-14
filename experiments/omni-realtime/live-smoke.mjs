import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer, liveConfig, sessionConfig, MODEL } from './server.mjs';

try { loadEnvFile(fileURLToPath(new URL('.env.local', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const credentials = liveConfig(process.env);
const directory = new URL(`live-runs/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
await mkdir(directory, { recursive: true });
const result = { model: MODEL, requestedVoice: sessionConfig().session.audio.output.voice,
  mode: 'live_text_to_audio', database: 'not-connected', microphone: 'not-used',
  status: 'FAIL', submitted: false, audioBytes: 0, audioChunks: 0,
  firstAudioPacketMs: null, audibleLatency: 'NOT_MEASURED', pronunciation: 'NOT_REVIEWED' };
const app = await startServer({ port: 0, live: true, credentials });
const socket = new WebSocket(`ws://127.0.0.1:${app.port}/stream`, { origin: `http://127.0.0.1:${app.port}` });
const audio = [];
const started = performance.now();
let submittedAt, transcript = '';
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('live_smoke_timeout')), 45000);
    const finish = error => { clearTimeout(timeout); error ? reject(error) : resolve(); };
    socket.on('message', raw => {
      let event;
      try { event = JSON.parse(raw); } catch { finish(new Error('invalid_local_event')); return; }
      if (event.type === 'prototype.error') { finish(new Error(event.code)); return; }
      if (event.type === 'prototype.ready' && !result.submitted) {
        result.connectionReadyMs = Math.round(performance.now() - started);
        result.submitted = true; submittedAt = performance.now();
        socket.send(JSON.stringify({ type: 'text', text: '请只朗读这一句话，不要加解释：你好，GitHub Actions 的 CI 测试完成了。' }));
      } else if (event.type === 'session.updated') {
        result.sessionModel = event.session?.model ?? null;
        result.sessionVoice = event.session?.audio?.output?.voice ?? event.session?.voice ?? null;
      } else if (event.type === 'response.created') {
        result.responseVoice = event.response?.voice ?? null;
      } else if (event.type === 'response.audio_transcript.delta') transcript += event.delta ?? '';
      else if (event.type === 'response.audio.delta') {
        const bytes = Buffer.from(event.delta, 'base64');
        if (!bytes.length || bytes.length % 2) { finish(new Error('invalid_pcm_audio')); return; }
        if (result.firstAudioPacketMs === null) result.firstAudioPacketMs = Math.round(performance.now() - submittedAt);
        audio.push(bytes); result.audioBytes += bytes.length; result.audioChunks++;
        if (result.audioBytes > 24000 * 2 * 20) finish(new Error('unexpected_audio_length'));
      } else if (event.type === 'response.done') {
        result.responseStatus = event.response?.status;
        if (event.response?.status !== 'completed' || !result.audioBytes || !transcript) finish(new Error('response_incomplete_or_empty'));
        else finish();
      }
    });
    socket.once('error', () => finish(new Error('local_socket_failed')));
    socket.once('close', () => finish(new Error('local_socket_closed')));
  });
  if (result.sessionModel !== MODEL) throw new Error('model_not_confirmed');
  if (result.sessionVoice !== result.requestedVoice || result.responseVoice !== result.requestedVoice) {
    throw new Error('voice_not_confirmed');
  }
  const pcm = Buffer.concat(audio), wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  await writeFile(new URL('sample.wav', directory), wav);
  result.status = 'PASS'; result.transcript = transcript;
  result.audioDurationMs = Math.round(pcm.length / 48000 * 1000);
  result.samplePath = fileURLToPath(new URL('sample.wav', directory));
} catch (error) {
  // Only local fixed reason codes; no upstream error bodies, URLs, or credentials.
  result.reason = /^[a-z_]+$/.test(error.message) ? error.message : 'live_smoke_failed';
  process.exitCode = 1;
} finally {
  socket.terminate(); await app.close();
  result.totalMs = Math.round(performance.now() - started);
  await writeFile(new URL('result.json', directory), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ ...result, evidencePath: fileURLToPath(new URL('result.json', directory)) }));
