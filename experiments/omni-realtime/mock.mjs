export const DEMO_TEXT = {
  mixed: '请用中文解释 GitHub Actions 和 CI，再读出 Qwen、API、WebSocket、2026 年与 3.8。',
  correction: '好，我记住了。接下来我继续说明这次记录。',
  late: '这是一段长回复。请在提示音播放时打断，检查旧音频是否重新出现。',
};

/** Deliberate sine audio: exercises transport/playback, never pretends to be speech. */
export function tonePCM(index = 0) {
  const buffer = Buffer.alloc(24000 * 0.18 * 2);
  for (let i = 0; i < buffer.length / 2; i++) {
    const envelope = Math.min(1, i / 120, (buffer.length / 2 - i) / 120);
    buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * (330 + index % 3 * 55) / 24000) * 1800 * envelope), i * 2);
  }
  return buffer.toString('base64');
}

export function createMock(emit) {
  let sequence = 0, active = null, speaking = false, quietSamples = 0, voicedSamples = 0;
  let plan = 'mixed';
  const timers = new Set();
  const later = (fn, delay) => { const t = setTimeout(() => { timers.delete(t); fn(); }, delay); timers.add(t); };
  function reply(text, correction = false) {
    const id = `mock-response-${++sequence}`;
    active = id;
    emit({ type: 'response.created', response: { id, status: 'in_progress' } });
    emit({ type: 'response.audio_transcript.delta', response_id: id, delta: text });
    let chunk = 0;
    function next() {
      if (active !== id) return;
      emit({ type: 'response.audio.delta', response_id: id, delta: tonePCM(chunk++) });
      if (chunk < 16) later(next, 100);
      else {
        emit({ type: 'response.audio.done', response_id: id });
        emit({ type: 'response.done', response: { id, status: 'completed' } });
        active = null;
      }
    }
    next();
    if (correction) later(() => {
      if (active !== id) return;
      emit({ type: 'prototype.correction', response_id: id, code: 'simulated_memory_write_failed' });
      active = null;
      emit({ type: 'response.done', response: { id, status: 'cancelled' } });
      reply('刚才我说早了，这次没有保存成功。（离线模拟，不存在记忆写入）');
      // Negative control: cancelled speech arrives after the correction begins.
      later(() => emit({ type: 'response.audio.delta', response_id: id, delta: tonePCM() }), 80);
    }, 480);
  }
  function submit(text, correction = false) {
    if (active) return;
    emit({ type: 'input_audio_buffer.speech_stopped', item_id: `mock-user-${sequence + 1}` });
    later(() => reply(text, correction), 45);
  }
  return {
    send(event) {
      if (event.type === 'input_audio_buffer.clear') {
        speaking = false; quietSamples = voicedSamples = 0;
      } else if (event.type === 'prototype.demo') {
        plan = event.scenario;
        submit(DEMO_TEXT[plan], plan === 'correction');
      } else if (event.type === 'conversation.item.create') {
        submit(event.item.content[0].text);
      } else if (event.type === 'response.cancel') {
        if (!active) return;
        const id = active;
        active = null;
        emit({ type: 'response.done', response: { id, status: 'cancelled' } });
        later(() => emit({ type: 'response.audio.delta', response_id: id, delta: tonePCM() }), 120);
      } else if (event.type === 'input_audio_buffer.append') {
        const pcm = Buffer.from(event.audio, 'base64');
        let energy = 0;
        for (let i = 0; i < pcm.length; i += 2) energy += (pcm.readInt16LE(i) / 32768) ** 2;
        const voiced = pcm.length > 0 && Math.sqrt(energy / (pcm.length / 2)) > 0.025;
        if (voiced) {
          voicedSamples += pcm.length / 2;
          quietSamples = 0;
          if (!speaking && voicedSamples >= 1600) {
            speaking = true;
            emit({ type: 'input_audio_buffer.speech_started' });
          }
        } else {
          voicedSamples = 0;
          quietSamples += pcm.length / 2;
          if (speaking && quietSamples >= 8000) {
            speaking = false;
            emit({ type: 'conversation.item.input_audio_transcription.completed',
              transcript: '离线麦克风输入（未进行语音识别）' });
            submit(DEMO_TEXT[plan], plan === 'correction');
          }
        }
      }
    },
    close() { active = null; for (const timer of timers) clearTimeout(timer); timers.clear(); },
  };
}
