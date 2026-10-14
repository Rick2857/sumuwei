// Presentation only: consume the existing lg-expression@1 vocabulary; never generate replies.
const cues = ['natural', 'reassuring', 'playful', 'firm', 'subdued', 'surprised'];
export function createPlayback({ now = () => performance.now(), reset = () => {} } = {}) {
  let generation = 0, revoked = true, active = null, mouth = 0, state = 'idle';
  const seen = new Set();
  const events = [];
  const record = (type, segmentId = null) => { events.push({ type, segmentId, generation, at: now() }); if (events.length > 64) events.shift(); };
  function stop(reason = 'interrupted') {
    if (['interrupted', 'failed', 'disconnected'].includes(reason)) revoked = true;
    const previous = active;
    active = null;
    mouth = 0;
    state = reason === 'ended' || reason === 'superseded' ? 'idle' : reason;
    if (previous && reason !== 'ended') previous.audio.pause();
    reset();
    record(reason, previous?.meta.segmentId);
  }
  function begin(next) {
    if (!Number.isSafeInteger(next) || next <= generation) return false;
    stop('superseded'); generation = next; revoked = false; seen.clear();
    record('turn_start'); return true;
  }
  function canPlay(meta) {
    return !!meta && meta.version === 'lg-expression@1' && meta.generation === generation && !revoked &&
      typeof meta.replyId === 'string' && meta.replyId.length > 0 && typeof meta.segmentId === 'string' &&
      meta.segmentId.startsWith(meta.replyId + '#') && /^\d+$/.test(meta.segmentId.slice(meta.replyId.length + 1)) &&
      cues.includes(meta.cue) && ['neutral', 'smile', 'surprised'].includes(meta.expression) &&
      ['none', 'nod', 'tilt'].includes(meta.gesture) && !seen.has(meta.segmentId);
  }
  // Call from HTMLAudioElement's playing event, never from packet arrival or play() invocation.
  function start(meta, audio) {
    if (!canPlay(meta) || audio.paused || audio.ended) {
      if (active?.audio !== audio) audio.pause();
      record('rejected', meta?.segmentId); return false;
    }
    stop('superseded'); seen.add(meta.segmentId);
    active = { meta: { ...meta }, audio, started: now() }; state = 'playing';
    record('playing', meta.segmentId); return true;
  }
  function finish(segmentId, reason = 'ended') { if (active?.meta.segmentId === segmentId) stop(reason); }
  function sample(rms = 0) {
    if (active?.audio.ended) stop('ended');
    else if (active?.audio.paused) stop('interrupted');
    if (!active) return { mouth: 0, expression: 'neutral', nod: 0, tilt: 0 };
    // ponytail: amplitude-driven aa mouth; phoneme alignment requires timed TTS visemes later.
    mouth = mouth * 0.65 + Math.min(1, Math.max(0, Number.isFinite(rms) ? rms * 6 : 0)) * 0.35;
    const elapsed = now() - active.started;
    const progress = Math.min(1, Math.max(0, elapsed / (active.meta.gesture === 'nod' ? 1400 : 1800)));
    const envelope = Math.sin(Math.PI * progress);
    return { mouth, expression: active.meta.expression,
      nod: active.meta.gesture === 'nod' ? 0.08 * Math.sin(2 * Math.PI * progress) * envelope : 0,
      tilt: active.meta.gesture === 'tilt' ? 0.1 * envelope : 0 };
  }
  const reading = () => ({ generation, revoked, state, active: active?.meta.segmentId || null, events: [...events] });
  return { begin, canPlay, start, finish, stop, sample, reading };
}
