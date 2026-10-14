import { createSpeechPlayback } from '/lg-adapter/speech.js';

export async function connectLive({ expressions, status, log, ready, onBusy, onStopped, onRecording }) {
  const backend = await fetch('/lg/status').then(r => { if (!r.ok) throw new Error('语音外壳不可达'); return r.json(); });
  if (!['sandbox-copy', 'production'].includes(backend.mode) || !backend.lg_process_alive) throw new Error('LG 核心未就绪');
  const meter = { _wavFileHandler: { getRms: () => 0 } };
  const speech = createSpeechPlayback(expressions, () => meter, () => new AudioContext());
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/client-ws`);
  let queue = Promise.resolve(), closed = false, running = false, capture = null, captureEpoch = 0;
  const queued = new Set(), shown = new Set(), acknowledgements = [];
  const stop = (reason = 'interrupted') => {
    discardCapture();
    const result = speech.interrupt(reason);
    expressions.stop(reason);
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'interrupt-signal', text: '' }));
    result.done.then(ack => { acknowledgements.push({ status: ack.status }); if (acknowledgements.length > 16) acknowledgements.shift(); });
    running = false; onStopped(); return result;
  };
  socket.onopen = () => status(backend.mode === 'production' ? '正式聊天已连接 · 对话写入真实记忆' : '隔离聊天已连接 · 不写真实记忆');
  socket.onmessage = event => {
    if (closed) return;
    let packet;
    try { packet = JSON.parse(event.data); } catch { stop('failed'); status('收到无效语音报文'); return; }
    if (packet.type === 'lg-expression-turn') {
      speech.stop('superseded');
      if (expressions.begin(packet.generation)) { queued.clear(); shown.clear(); queue = Promise.resolve(); running = true; onBusy(); status('苏沐薇正在思考…'); }
    } else if (packet.type === 'lg-audio-chunk') {
      const meta = packet.actions?.lg_expression;
      if (!speech.feed(packet)) return;
      if (packet.display_text?.text && !shown.has(meta.segmentId)) { shown.add(meta.segmentId); log('苏沐薇', packet.display_text.text); }
      if (!queued.has(meta.segmentId)) {
        queued.add(meta.segmentId);
        const generation = meta.generation;
        queue = queue.then(async () => {
          if (closed || expressions.reading().generation !== generation || expressions.reading().revoked) return;
          await speech.play(meta, () => { socket.send(JSON.stringify({ type: 'audio-play-start' })); status('苏沐薇正在说话', true); onBusy(); }, () => () => {});
          if (!speech.reading().active.length && expressions.reading().generation === generation) status('分段播放结束 · 等待后续语音');
        }).catch(() => { if (expressions.reading().generation === generation) { stop('failed'); status('语音播放失败'); } });
      }
    } else if (packet.type === 'lg-speech-stream-failed' || packet.type === 'error') {
      stop('failed'); status('LG 本轮失败，已停止播放');
    } else if (packet.type === 'backend-synth-complete') {
      const generation = expressions.reading().generation;
      queue.then(() => {
        if (!speech.reading().active.length && expressions.reading().generation === generation) {
          running = false; onStopped(); status('语音结束 · 已复位');
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'frontend-playback-complete' }));
        }
      });
    } else if (packet.type === 'user-input-transcription') {
      log('语音识别', String(packet.text || ''));
    }
  };
  socket.onclose = () => { closed = true; discardCapture(); speech.stop('disconnected'); expressions.stop('disconnected'); running = false; onStopped(); status('连接已断开 · 播放结果按未知处理'); };
  socket.onerror = () => status('连接失败');
  const send = async text => {
    if (!ready() || socket.readyState !== WebSocket.OPEN) throw new Error('模型或 LG 连接尚未就绪');
    if (!text.trim() || text.length > 4000) throw new Error('请输入 1—4000 字的消息');
    discardCapture();
    await speech.unlock();
    if (running || speech.reading().active.length) await stop('interrupted').done;
    speech.markSubmit(); log('你', text); running = true; onBusy(); status('消息已提交…');
    socket.send(JSON.stringify({ type: 'text-input', text }));
  };
  function discardCapture() {
    captureEpoch++;
    if (!capture) return;
    const old = capture; capture = null; clearTimeout(old.timeout);
    old.processor.disconnect(); old.input.disconnect(); old.stream.getTracks().forEach(track => track.stop());
    void old.context.close(); onRecording(false);
  }
  const toggleMicrophone = async () => {
    if (capture) {
      const chunks = capture.chunks;
      discardCapture(); speech.markSubmit(); running = true; onBusy(); status('正在识别语音…');
      for (const audio of chunks) socket.send(JSON.stringify({ type: 'mic-audio-data', audio: Array.from(audio) }));
      socket.send(JSON.stringify({ type: 'mic-audio-end' })); return;
    }
    if (!ready() || socket.readyState !== WebSocket.OPEN) throw new Error('模型或 LG 连接尚未就绪');
    await speech.unlock();
    if (running || speech.reading().active.length) await stop('interrupted').done;
    const epoch = ++captureEpoch;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
    if (closed || epoch !== captureEpoch) { stream.getTracks().forEach(track => track.stop()); return; }
    const context = new AudioContext({ sampleRate: 16000 });
    try {
      await context.resume();
      if (closed || epoch !== captureEpoch) { stream.getTracks().forEach(track => track.stop()); await context.close(); return; }
      if (context.sampleRate !== 16000) throw new Error('设备不支持 16kHz 语音采集');
      const input = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1);
      capture = { context, stream, input, processor, chunks: [], timeout: setTimeout(() => void toggleMicrophone(), 60000) };
      processor.onaudioprocess = event => {
        if (capture?.processor === processor && socket.readyState === WebSocket.OPEN)
          capture.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      input.connect(processor); processor.connect(context.destination);
      onRecording(true); status('录音中 · 再次点击发送，最多 60 秒');
    } catch (error) { stream.getTracks().forEach(track => track.stop()); await context.close(); throw error; }
  };
  return { send, stop, toggleMicrophone, rms: () => meter._wavFileHandler.getRms(), mode: backend.mode,
    reading: () => ({ connected: socket.readyState === WebSocket.OPEN, running, recording: !!capture, speech: speech.reading(), acknowledgements: [...acknowledgements] }) };
}
