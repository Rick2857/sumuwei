import { randomUUID } from 'node:crypto';

/** One browser and one native response; LG owns formal turns and all tool execution. */
export function lgSession({ core, send, sendProvider, resetProvider }) {
  let turn, native, responseId, lastResponseId, audioBytes = 0, awaitingASR = false, generation = 0, asrTimer;
  function rejectNative(code) {
    if (!native) return;
    clearTimeout(native.timer); native.reject(new Error(code)); native = undefined;
  }
  function cancel(reset = true) {
    generation++; awaitingASR = false; audioBytes = 0;
    clearTimeout(asrTimer);
    rejectNative('native_voice_cancelled');
    if (turn) void core.cancel(turn.id).then(result => send({ type: 'lg.cancel_result', requestId: result.requestId,
      outcome: result.outcome, cancel: result.cancel })).catch(() => {});
    turn = undefined; responseId = undefined; lastResponseId = undefined;
    if (reset) resetProvider();
  }
  async function submit(text) {
    if (turn || awaitingASR) { send({ type: 'prototype.error', code: 'lg_turn_busy' }); return; }
    const current = { id: `omni-${randomUUID()}`, generation, text }; turn = current;
    send({ type: 'lg.turn_started', requestId: current.id });
    try {
      const result = await core.submit(text, current.id);
      if (turn !== current) return;
      send({ type: 'lg.turn_result', requestId: current.id, outcome: result.outcome, code: result.code,
        replyId: result.replyId, traceId: result.traceId, domainEventCount: result.domainEventIds?.length ?? 0,
        timings: result.timings });
      if (result.outcome !== 'replied') {
        send({ type: 'prototype.stop', reason: 'lg_turn_failed' });
        rejectNative('lg_turn_failed');
      }
    } catch {
      if (turn === current) { send({ type: 'prototype.stop', reason: 'lg_transport_failed' }); send({ type: 'prototype.error', code: 'lg_transport_failed' }); }
    } finally { if (turn === current) turn = undefined; }
  }
  return {
    cancel,
    command(command) {
      if (command.type === 'interrupt') { cancel(); return; }
      if (command.type === 'microphone_off') { audioBytes = 0; sendProvider({ type: 'input_audio_buffer.clear' }); return; }
      if (command.type === 'audio') {
        if (turn || native || awaitingASR) return; // Manual-mode input resumes after response or cancellation.
        audioBytes += Buffer.from(command.audio, 'base64').length;
        if (audioBytes > 16000 * 2 * 60) { cancel(); send({ type: 'prototype.error', code: 'utterance_too_long' }); return; }
        sendProvider({ type: 'input_audio_buffer.append', audio: command.audio }); return;
      }
      if (command.type === 'audio_commit') {
        if (turn || awaitingASR || audioBytes < 3200) return;
        awaitingASR = true; audioBytes = 0;
        asrTimer = setTimeout(() => { cancel(); send({ type: 'prototype.error', code: 'transcription_timeout' }); }, 30000);
        sendProvider({ type: 'input_audio_buffer.commit' }); return;
      }
      if (command.type === 'text') {
        if (turn || awaitingASR) { send({ type: 'prototype.error', code: 'lg_turn_busy' }); return; }
        sendProvider({ type: 'input_audio_buffer.clear' }); audioBytes = 0;
        void submit(command.text);
      }
    },
    event(event) {
      if (event.type === 'conversation.item.input_audio_transcription.completed' && awaitingASR) {
        awaitingASR = false;
        clearTimeout(asrTimer);
        if (typeof event.transcript === 'string' && event.transcript.trim() && event.transcript.length <= 2000) void submit(event.transcript);
        else send({ type: 'prototype.error', code: 'transcription_empty_or_too_long' });
      }
      if (!native) return !event.type.startsWith('response.');
      if (event.type === 'session.updated' && native.awaitingContext) {
        if (event.session?.instructions !== native.instructions) return true;
        native.awaitingContext = false;
        send({ type: 'lg.context_applied', replyId: native.replyId, promptChars: native.instructions.length });
        sendProvider({ type: 'conversation.item.create', item: { type: 'message', role: 'user',
          content: [{ type: 'input_text', text: native.phase === 'correct' ? '请按照系统给出的已检查文本，更正刚才的回复。' : turn.text }] } });
        sendProvider({ type: 'response.create' });
      }
      if (event.type === 'response.created') { responseId = event.response.id; lastResponseId = responseId; }
      if (event.type.startsWith('response.') && (event.response_id ?? event.response?.id) && (event.response_id ?? event.response?.id) !== responseId) return false;
      if (event.type === 'response.audio_transcript.delta' || event.type === 'response.text.delta') {
        native.text += event.delta;
        if (native.text.length > 16000) { cancel(); return false; }
      }
      if (event.type === 'response.done') {
        const value = native; native = undefined; responseId = undefined; clearTimeout(value.timer);
        if (event.response.status !== 'completed' || !value.text.trim()) value.reject(new Error('native_voice_incomplete'));
        else value.resolve({ text: value.text, durationMs: Date.now() - value.started });
      }
      return true;
    },
    reply(input, signal) {
      if (!turn || native || signal.aborted) return Promise.reject(new Error('native_voice_no_turn'));
      if (input.phase === 'correct') send({ type: 'prototype.correction', response_id: lastResponseId, reason: 'LG 回复检查触发更正，已撤销原发言余段。' });
      return new Promise((resolve, reject) => {
        const value = { text: '', started: Date.now(), resolve, reject,
          timer: setTimeout(() => { if (native === value) cancel(); }, 85000) };
        native = value;
        signal.addEventListener('abort', () => { if (native === value) cancel(); }, { once: true });
        // LG's compiled context is authoritative; native session history is temporary audio context only.
        const instructions = input.phase === 'correct'
          ? `${input.prompt}\n程序已发现上一段回复需要更正。现在立即简短说明更正，只能依据以下已经检查的文本，不能再声称未完成的动作已经完成：\n${input.checkedText}\n直接说自然语言，不朗读 XML、JSON、标签或来源附录。`
          : `${input.prompt}\n这是语音回复。以以上 LG 正式上下文为准；直接说自然语言，不输出或朗读 XML、JSON、response 标签或来源附录。`;
        Object.assign(value, { instructions, awaitingContext: true, replyId: input.replyId, phase: input.phase });
        sendProvider({ type: 'session.update', session: { instructions, turn_detection: null, tools: [], enable_search: false } });
      });
    },
  };
}
