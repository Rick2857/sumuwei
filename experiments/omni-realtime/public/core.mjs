/** Provider response identities and local playback are separate from LG state. */
export class ResponseGate {
  epoch = 0;
  generation = 0;
  current = null;
  generating = false;
  awaiting = false;
  seen = new Set();
  blocked = new Set();

  reset(epoch) {
    this.epoch = epoch;
    this.generation++;
    this.current = null;
    this.generating = this.awaiting = false;
    this.seen.clear();
    this.blocked.clear();
  }

  interrupt() {
    const responseId = this.current;
    if (responseId) this.blocked.add(responseId);
    this.current = null;
    this.generating = this.awaiting = false;
    this.generation++;
    return responseId;
  }

  accept(event) {
    if (event.sessionEpoch !== this.epoch) return false;
    if (event.type === 'input_audio_buffer.speech_stopped') this.awaiting = true;
    if (event.type === 'response.created') {
      const id = event.response?.id;
      if (!id || this.seen.has(id) || this.blocked.has(id)) return false;
      this.seen.add(id);
      this.current = id;
      this.generating = true;
      this.awaiting = false;
      this.generation++;
    }
    if (event.type.startsWith('response.') && event.type !== 'response.created') {
      const id = event.response_id ?? event.response?.id;
      if (!id || id !== this.current || this.blocked.has(id)) return false;
      if (event.type === 'response.done') this.generating = false;
      else if (!this.generating) return false;
    }
    return true;
  }
}

/** Streaming area resampling preserves phase across AudioWorklet blocks. */
export class PCM16Resampler {
  constructor(inputRate, outputRate = 16000) {
    if (!(inputRate >= outputRate)) throw new Error('unsupported_capture_sample_rate');
    this.ratio = inputRate / outputRate;
    this.remaining = this.ratio;
    this.sum = 0;
  }
  push(input) {
    const out = [];
    for (const sample of input) {
      let width = 1;
      while (width > 1e-10) {
        const take = Math.min(width, this.remaining);
        this.sum += sample * take;
        this.remaining -= take;
        width -= take;
        if (this.remaining < 1e-10) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          out.push(Math.round(value * (value < 0 ? 32768 : 32767)));
          this.remaining = this.ratio;
          this.sum = 0;
        }
      }
    }
    const bytes = new Uint8Array(out.length * 2);
    const view = new DataView(bytes.buffer);
    out.forEach((value, i) => view.setInt16(i * 2, value, true));
    return bytes;
  }
}

export function decodePCM16(bytes) {
  if (bytes.length % 2) throw new Error('invalid_pcm16_length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

/** Injectable Web Audio context also lets the offline check test real queue logic. */
export class PCMPlayer {
  nodes = new Set();
  nextTime = 0;
  constructor(context, notify = () => {}) { this.context = context; this.notify = notify; }
  feed(samples, identity) {
    if (!samples.length) return;
    const c = this.context;
    const start = Math.max(c.currentTime + 0.025, this.nextTime);
    // Native audio can be generated faster than playback; ordinary 10s replies must fit.
    if (start + samples.length / 24000 - c.currentTime > 30) throw new Error('playback_backlog');
    const buffer = c.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(samples, 0);
    const node = c.createBufferSource();
    node.buffer = buffer;
    node.connect(c.destination);
    this.nextTime = start + samples.length / 24000;
    const record = { node, identity, start, end: this.nextTime };
    this.nodes.add(record);
    node.onended = () => {
      if (this.nodes.delete(record)) this.notify('ended', identity);
      node.disconnect();
    };
    node.start(start);
    this.notify('scheduled', { ...identity, scheduledAudioTime: start });
    return { scheduledAudioTime: start, endAudioTime: this.nextTime };
  }
  stop(reason = 'interrupted') {
    const c = this.context;
    for (const record of this.nodes) {
      this.nodes.delete(record);
      record.node.onended = null;
      record.node.stop();
      record.node.disconnect();
      this.notify('cancelled', { ...record.identity, reason,
        playedMs: Math.max(0, Math.min(c.currentTime, record.end) - record.start) * 1000 });
    }
    this.nextTime = c.currentTime;
  }
}
