import { loadEnvFile } from 'node:process';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer, MODEL } from './server.mjs';
import { startLG } from './lg-process.mjs';
import { tonePCM } from './mock.mjs';
import { PCM16Resampler, decodePCM16 } from './public/core.mjs';

const fake = process.argv.includes('--fake');
const fault = process.argv.includes('--fault');
if (fault && !fake) throw new Error('fault_requires_fake_provider');
loadEnvFile(fileURLToPath(new URL('.env.local', import.meta.url)));
const directory = new URL(`live-runs/lg-${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
await mkdir(directory, { recursive: true });
const result = { schema: 'omni-lg-smoke@1', status: 'FAIL', model: MODEL, voice: 'Liora Mira',
  provider: fake ? 'offline-injected' : 'real', database: 'isolated-postgres', turns: [], productionUsed: false };
let app, socket, sequence = 0;
try {
  app = await startServer({ port: 0, live: true,
    coreFactory: options => startLG({ ...options, onDiagnostic: text => { void appendFile(new URL('core.local.log', directory), text + '\n'); } }),
    ...(fake ? { connectProvider: (emit, ready) => {
      let closed = false, instructions = ''; queueMicrotask(ready);
      return { close() { closed = true; }, send(event) {
        if (event.type === 'session.update') { instructions = event.session.instructions; queueMicrotask(() => emit({ type: 'session.updated', session: event.session })); return; }
        if (event.type !== 'response.create') return;
        const id = `injected-${++sequence}`;
        const checked = instructions.split('不能再声称未完成的动作已经完成：\n')[1]?.split('\n直接说自然语言')[0];
        const text = checked ? `刚才我说早了。${checked}` : fault ? '好，我记住了。' : sequence === 1 ? '好，我记住了，你在江城大学读书。' : sequence === 2 ? '你在江城大学读书。' : '结果是四百零八。';
        queueMicrotask(() => { if (closed) return;
          emit({ type: 'response.created', response: { id, voice: 'Liora Mira' } });
          emit({ type: 'response.audio_transcript.delta', response_id: id, delta: text });
          emit({ type: 'response.audio.delta', response_id: id, delta: tonePCM() });
          emit({ type: 'response.done', response: { id, status: 'completed' } });
        });
      } };
    } } : {}),
  });
  const inputs = fault ? ['记住，我叫语音联调小岚。'] : ['记住，我在江城大学读书。', '我的毕业院校记录是什么？', '请计算 17 * 24。'];
  if (process.argv.includes('--audio')) inputs.push(null);
  for (const text of inputs) {
    // Reconnect upstream before recall: Omni's ephemeral history cannot answer this for LG.
    socket = new WebSocket(`ws://127.0.0.1:${app.port}/stream`, { origin: `http://127.0.0.1:${app.port}` });
    const turn = { outcome: 'FAIL', inputKind: text === null ? 'synthetic-audio' : 'text', audioBytes: 0, transcript: '', firstAudioPacketMs: null, corrections: 0, contextApplied: 0 };
    let started;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lg_smoke_timeout')), 120000);
      const fail = code => { clearTimeout(timer); reject(new Error(code)); };
      socket.on('message', async raw => {
        const event = JSON.parse(raw);
        if (event.type === 'prototype.ready' && started === undefined) {
          started = performance.now();
          if (text !== null) socket.send(JSON.stringify({ type: 'text', text }));
          else {
            try {
              const wav = await readFile(new URL('live-runs/2026-10-13T10-02-54-976Z/sample.wav', import.meta.url));
              if (wav.readUInt32LE(24) !== 24000 || wav.readUInt16LE(22) !== 1) throw new Error();
              const pcm = new PCM16Resampler(24000).push(decodePCM16(wav.subarray(44)));
              for (let offset = 0; offset < pcm.length; offset += 2560) {
                socket.send(JSON.stringify({ type: 'audio', audio: Buffer.from(pcm.subarray(offset, offset + 2560)).toString('base64') }));
                await new Promise(r => setTimeout(r, 80));
              }
              socket.send(JSON.stringify({ type: 'audio_commit' }));
            } catch { fail('synthetic_audio_input_failed'); }
          }
        }
        if (event.type === 'lg.context_applied') turn.contextApplied++;
        if (event.type === 'response.created') turn.responseVoice = event.response.voice;
        if (event.type === 'session.updated' && event.session?.model) turn.sessionModel = event.session.model;
        if (event.type === 'conversation.item.input_audio_transcription.completed') turn.inputTranscript = event.transcript;
        if (event.type === 'prototype.error') fail(event.code);
        if (event.type === 'prototype.correction') turn.corrections++;
        if (event.type === 'response.audio_transcript.delta') turn.transcript += event.delta;
        if (event.type === 'response.audio.delta') {
          turn.audioBytes += Buffer.from(event.delta, 'base64').length;
          turn.firstAudioPacketMs ??= Math.round(performance.now() - started);
        }
        if (event.type === 'lg.turn_result') {
          Object.assign(turn, { outcome: event.outcome, code: event.code, replyId: event.replyId, traceId: event.traceId,
            domainEventCount: event.domainEventCount, timings: event.timings });
          clearTimeout(timer); resolve();
        }
      });
      socket.once('error', () => fail('lg_socket_failed'));
    });
    result.turns.push(turn);
    if (turn.outcome !== 'replied' || !turn.audioBytes || !turn.transcript || !turn.contextApplied) throw new Error('lg_turn_failed');
    if (!fake && (turn.sessionModel !== MODEL || turn.responseVoice !== 'Liora Mira')) throw new Error('lg_model_or_voice_unconfirmed');
    await new Promise(resolve => { socket.once('close', resolve); socket.close(); });
    // Server has processed socket close before the next handshake.
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!fake && !result.turns[1].transcript.includes('江城大学')) throw new Error('lg_memory_recall_not_observed');
  if (fault && (result.turns[0].corrections !== 1 || !result.turns[0].transcript.includes('刚才我说早了'))) throw new Error('lg_guard_correction_not_observed');
  if (!fake && !/408|四百零八/.test(result.turns[2].transcript)) throw new Error('lg_calculation_reply_incorrect');
  if (process.argv.includes('--audio') && !result.turns.at(-1).inputTranscript?.includes('测试')) throw new Error('lg_audio_transcription_not_observed');
  result.status = 'PASS';
} catch (error) {
  result.reason = /^[a-z_]+$/.test(error.message) ? error.message : 'lg_smoke_failed'; process.exitCode = 1;
} finally {
  socket?.terminate();
  if (app) result.shutdown = await app.close();
  if (app && result.shutdown?.code !== 0) { result.status = 'FAIL'; result.reason = 'lg_shutdown_failed'; process.exitCode = 1; }
  if (result.shutdown?.code === 0) {
    const readback = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'experiments/omni-realtime/lg-readback.ts'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', windowsHide: true });
    try {
      if (readback.status !== 0) throw new Error();
      result.readback = JSON.parse(readback.stdout);
      const recallTrace = result.readback.traces.find(trace => trace.traceId === result.turns[1]?.traceId);
      if (result.readback.connections !== 1 || (!fault && (result.readback.memoryRecords < 1 || result.readback.actionEvents < 5 || !recallTrace?.selectedMemoryCount))) throw new Error();
    } catch { result.status = 'FAIL'; result.reason = 'lg_memory_action_or_shutdown_readback_failed'; process.exitCode = 1; }
  }
  await writeFile(new URL('result.json', directory), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ ...result, evidencePath: fileURLToPath(new URL('result.json', directory)) }));
