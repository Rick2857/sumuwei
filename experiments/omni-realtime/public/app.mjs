import { ResponseGate, PCM16Resampler, decodePCM16, PCMPlayer } from './core.mjs';

const $ = id => document.getElementById(id);
const gate = new ResponseGate();
const records = [], measurements = [], replies = new Map();
let ws, context, player, media, capture, source, mutedOutput;
let mode = 'offline', ready = false, closed = true, utteranceAt = null, micStarting = false;
let integrated = false, committedAudio = false;
let production = false;
let preRoll = [], preRollLength = 0;
let pendingBytes = [], pendingLength = 0, voicedMs = 0, quietMs = 0, talking = false;
const now = () => performance.now();
function record(type, detail = {}) {
  records.push({ type, at: Math.round(now()), ...detail });
  if (records.length > 400) records.shift();
  $('log').textContent = records.slice(-35).map(row => JSON.stringify(row)).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}
function controls() {
  $('connect').disabled = !closed;
  $('disconnect').disabled = closed;
  for (const id of ['mic', 'interrupt', 'submit']) $(id).disabled = !ready;
  for (const button of document.querySelectorAll('[data-demo]')) button.disabled = !ready || mode !== 'offline';
}
function send(command) {
  if (!ready || ws?.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > 128000) { disconnect('microphone_backlog'); return false; }
  ws.send(JSON.stringify(command));
  return true;
}
function transcript(text) {
  const row = document.createElement('p');
  row.textContent = text;
  $('transcript').append(row);
  while ($('transcript').children.length > 60) $('transcript').firstChild.remove();
  $('transcript').scrollTop = $('transcript').scrollHeight;
  return row;
}
function interrupt(reason, notify = true) {
  const started = now(), id = gate.interrupt();
  player?.stop(reason);
  const tookMs = now() - started;
  record('local_stop', { responseId: id, generation: gate.generation, tookMs: +tookMs.toFixed(3), reason });
  $('status').textContent = '已停播';
  if (notify) send({ type: 'interrupt' });
}
function stopMic() {
  if (media) send({ type: 'microphone_off' });
  media?.getTracks().forEach(track => track.stop());
  capture?.disconnect(); source?.disconnect(); mutedOutput?.disconnect();
  if (capture) capture.port.onmessage = null;
  media = capture = source = mutedOutput = null;
  pendingBytes = []; pendingLength = voicedMs = quietMs = 0; talking = false;
  preRoll = []; preRollLength = 0; committedAudio = true;
  $('meter').value = 0; $('mic').textContent = '开启麦克风';
}
function disconnect(reason = 'user_disconnected') {
  closed = true; ready = false;
  interrupt(reason, false); stopMic();
  ws?.close(); ws = null;
  context?.close().catch(() => {}); context = player = null;
  gate.reset(gate.epoch + 1);
  $('status').textContent = '已断开'; controls();
}
function handle(event) {
  if (event.type === 'prototype.session') {
    player.stop('session_reset'); gate.reset(event.sessionEpoch);
    utteranceAt = null; mode = event.mode; ready = false; controls();
    record('session', { mode, epoch: event.sessionEpoch }); return;
  }
  if (event.type === 'prototype.ready') {
    if (event.sessionEpoch !== gate.epoch) return;
    ready = true; $('status').textContent = '已连接'; controls(); return;
  }
  if (event.type === 'prototype.error') { record('error', { code: event.code }); $('status').textContent = `错误：${event.code}`; return; }
  if (event.sessionEpoch !== gate.epoch) { record('stale_session_dropped'); return; }
  if (event.type === 'prototype.stop') { interrupt(event.reason, false); return; }
  if (event.type === 'lg.turn_started') { $('status').textContent = 'LG 正在装配上下文与处理动作'; record('lg_turn_started'); return; }
  if (event.type === 'lg.turn_result') { record('lg_turn_result', { outcome: event.outcome, code: event.code, replyId: event.replyId, traceId: event.traceId, domainEventCount: event.domainEventCount, timings: event.timings }); return; }
  if (event.type === 'prototype.correction') {
    if (event.response_id !== gate.current) { record('stale_correction_dropped'); return; }
    interrupt('program_correction', false);
    transcript(event.reason || '程序纠正：模拟写入失败，撤销旧发言余段。'); return;
  }
  if (event.type === 'input_audio_buffer.speech_started') {
    // Server detection can arrive after local VAD; avoid cancelling the new turn twice.
    if (gate.current || gate.awaiting || player.nodes.size) interrupt('server_speech_started');
    record('speech_started'); return;
  }
  if (!gate.accept(event)) { record('stale_packet_dropped', { event: event.type, responseId: event.response_id ?? event.response?.id }); return; }
  if (event.type === 'input_audio_buffer.speech_stopped') {
    utteranceAt = now(); record('speech_stopped_received');
  } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
    transcript(`你：${event.transcript}`);
  } else if (event.type === 'conversation.item.input_audio_transcription.delta') {
    $('status').textContent = `听取中：${(event.text || '') + (event.stash || '')}`;
  } else if (event.type === 'response.created') {
    player.stop('superseded');
    const row = transcript(`${mode === 'offline' ? '模拟回复' : 'Omni'}：`);
    replies.set(gate.current, { row, text: '', generation: gate.generation, started: utteranceAt ?? now(), first: false, chunks: 0 });
    if (replies.size > 60) replies.delete(replies.keys().next().value);
    record('response_created', { responseId: gate.current, generation: gate.generation });
  } else if (['response.audio_transcript.delta', 'response.text.delta'].includes(event.type)) {
    const reply = replies.get(gate.current);
    if (reply) { reply.text += event.delta; reply.row.textContent = `${mode === 'offline' ? '模拟回复' : 'Omni'}：${reply.text}`; }
  } else if (event.type === 'response.audio.delta') {
    try {
      const reply = replies.get(gate.current);
      const samples = decodePCM16(Uint8Array.from(atob(event.delta), char => char.charCodeAt(0)));
      const identity = { responseId: gate.current, generation: gate.generation, chunkIndex: reply.chunks++ };
      const scheduled = player.feed(samples, identity);
      window.dispatchEvent(new CustomEvent('omni-audio', { detail: { ...identity, ...scheduled, samples, sampleRate: 24000,
        scheduledPerformanceTime: now() + (scheduled.scheduledAudioTime - context.currentTime) * 1000 } }));
      if (reply && !reply.first) {
        reply.first = true;
        const measurement = { mode, responseId: gate.current,
          firstAudioReceivedMs: Math.round(now() - reply.started),
          firstScheduledMs: Math.round(now() - reply.started + Math.max(0, player.nextTime - samples.length / 24000 - context.currentTime) * 1000),
          reference: 'browser_received_speech_stopped_or_text_submit', actualAudibleLatency: 'NOT_MEASURED' };
        measurements.push(measurement); if (measurements.length > 200) measurements.shift();
        $('metrics').textContent = `首音频包 ${measurement.firstAudioReceivedMs} ms；首段计划播放 ${measurement.firstScheduledMs} ms。${mode === 'offline' ? '离线提示音，不能作为模型时延。' : '不含服务端端点检测等待，需另测真人感知。'}`;
        record('first_audio', measurement);
      }
      $('status').textContent = mode === 'offline' ? '播放模拟提示音' : '播放语音';
    } catch { interrupt('invalid_audio_or_backlog'); record('error', { code: 'invalid_audio_or_backlog' }); }
  } else if (event.type === 'response.done') {
    record('response_done', { responseId: event.response.id, status: event.response.status });
    if (event.response.status !== 'completed') interrupt('response_incomplete', false);
  }
}
async function connect() {
  closed = false; controls(); $('status').textContent = '连接中…';
  try {
    const ownerContext = new AudioContext(); context = ownerContext; await context.resume();
    if (closed || context !== ownerContext) return;
    player = new PCMPlayer(context, (state, identity) => {
      record(`playback_${state}`, identity);
      window.dispatchEvent(new CustomEvent('omni-playback', { detail: { state, ...identity } }));
      if (state === 'ended' && !gate.generating && player.nodes.size === 0) $('status').textContent = '已连接';
    });
    const socket = new WebSocket(`ws://${location.host}/stream`); ws = socket;
    socket.onmessage = ({ data }) => { if (socket === ws) { try { handle(JSON.parse(data)); } catch { disconnect('invalid_server_event'); } } };
    socket.onerror = () => { if (socket === ws) record('error', { code: 'local_connection_failed' }); };
    socket.onclose = () => { if (socket === ws) disconnect('socket_closed'); };
  } catch { disconnect('audio_context_failed'); }
}
async function startMic() {
  if (micStarting) return;
  if (media) { stopMic(); return; }
  micStarting = true;
  const ownerContext = context;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (closed || context !== ownerContext) { stream.getTracks().forEach(t => t.stop()); return; }
    media = stream;
    await context.audioWorklet.addModule('/capture-worklet.js');
    if (closed || context !== ownerContext) { stopMic(); return; }
    const resampler = new PCM16Resampler(context.sampleRate);
    committedAudio = true;
    source = context.createMediaStreamSource(media);
    capture = new AudioWorkletNode(context, 'omni-capture');
    mutedOutput = context.createGain(); mutedOutput.gain.value = 0;
    source.connect(capture); capture.connect(mutedOutput); mutedOutput.connect(context.destination);
    capture.port.onmessage = ({ data }) => {
      if (!media || (!ready && !integrated)) return;
      const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
      $('meter').value = rms;
      const ms = data.length / context.sampleRate * 1000;
      if (rms > 0.025) { voicedMs += ms; quietMs = 0; }
      else { voicedMs = 0; quietMs += ms; if (quietMs > 600) talking = false; }
      if (!talking && voicedMs >= 120) {
        talking = true;
        committedAudio = false;
        if (gate.current || gate.awaiting || player.nodes.size) interrupt('local_vad');
        if (integrated) { pendingBytes = [...preRoll]; pendingLength = preRollLength; }
      }
      const bytes = resampler.push(data);
      preRoll.push(bytes); preRollLength += bytes.length;
      while (preRollLength > 5120 && preRoll.length > 1) preRollLength -= preRoll.shift().length;
      if (integrated && committedAudio) return;
      pendingBytes.push(bytes); pendingLength += bytes.length;
      if (pendingLength > 32000) { disconnect('capture_backlog'); return; }
      const commitNow = integrated && !talking && quietMs > 600 && !committedAudio;
      if (ready && (pendingLength >= 2560 || commitNow)) {
        const packet = new Uint8Array(pendingLength); let offset = 0;
        for (const chunk of pendingBytes) { packet.set(chunk, offset); offset += chunk.length; }
        pendingBytes = []; pendingLength = 0;
        send({ type: 'audio', audio: btoa(String.fromCharCode(...packet)) });
        if (commitNow) { committedAudio = true; utteranceAt = now(); send({ type: 'audio_commit' }); }
      }
    };
    $('mic').textContent = '关闭麦克风'; record('microphone_started', { inputRate: context.sampleRate, outputRate: 16000 });
  } catch { stopMic(); record('error', { code: 'microphone_unavailable' }); $('status').textContent = '麦克风未就绪'; }
  finally { micStarting = false; }
}
$('connect').onclick = connect;
$('disconnect').onclick = () => disconnect();
$('interrupt').onclick = () => interrupt('user_button');
$('mic').onclick = startMic;
for (const button of document.querySelectorAll('[data-demo]')) button.onclick = () => send({ type: 'demo', scenario: button.dataset.demo });
$('text-form').onsubmit = event => { event.preventDefault(); utteranceAt = now(); send({ type: 'text', text: $('text').value }); };
$('export').onclick = () => {
  const evidence = { schema: 'omni-prototype-diagnostics@1', mode, model: 'qwen3.8-omni-flash-realtime',
    database: integrated ? (production ? 'production-postgres' : 'isolated-postgres') : 'not-connected', tools: integrated ? 'LG-gateway' : 'none', liveModelVerified: false,
    humanPronunciation: 'NOT_MEASURED', measurements, events: records };
  const url = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'omni-evidence.local.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('pagehide', () => disconnect('page_closed'));
fetch('/health').then(r => r.json()).then(health => {
  mode = health.mode;
  integrated = health.integrated === true;
  production = health.production === true;
  if (health.avatar3d) import('./omni-avatar.mjs').catch(() => { $('avatar-status').textContent = '3D 加载失败'; });
  if (production) {
    document.title = '苏沐薇 · 3D 语音';
    document.querySelector('h1').textContent = '苏沐薇';
    document.querySelector('h1 + p').textContent = 'Aoba · Liora Mira';
    $('connect').textContent = '开始聊天';
    document.querySelector('h2').textContent = '聊天';
    document.querySelectorAll('[data-demo]').forEach(button => button.hidden = true);
    $('text').value = ''; $('text').placeholder = '和她说句话…';
    $('text-form label').textContent = '文字消息'; $('submit').textContent = '发送';
    $('text-form + p').hidden = true;
    $('mode').textContent = '正式聊天';
    $('scope').textContent = '语音会发送到百炼。聊天接入苏沐薇的真实记忆与工具；麦克风由你手动开启。';
    return;
  }
  $('mode').textContent = integrated ? 'LG 隔离语音测试 · PostgreSQL 测试库 · LG 工具网关' : `${mode === 'offline' ? '离线模拟' : '真实模型测试'} · 无数据库 · 无工具`;
  if (mode === 'live') $('scope').textContent = integrated ? '隔离联调：音频发送到百炼；LG 装配人格与上下文、处理记忆和工具。原生语音先播出，回复检查发现问题时主动停播并更正。' : '真实模型测试：音频会发送到百炼；当前尚未接入 LG 人格、记忆、工具和真实纠错检测。';
}).catch(() => { $('mode').textContent = '本地服务不可用'; });
