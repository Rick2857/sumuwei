/** Local Cubism playback controller, informed by AIRI reset and AITuberOnAir speech lifecycle. */
export function createExpressionPlayback(getModel, getAdapter, now = () => performance.now()) {
  let generation = 0;
  let revoked = false;
  let active = null;
  const seen = new Set();
  const events = [];
  const cues = ['natural', 'reassuring', 'playful', 'firm', 'subdued', 'surprised'];
  const reading = () => ({ version: 'lg-expression@1', generation, revoked, active: active?.meta.segmentId || null, events: [...events] });
  const publish = () => {
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-lg-expression', JSON.stringify(reading()));
  };
  /*
   * Lv4.5 / P1 计时：事件带**同一个浏览器时钟**的时间戳（`performance.now()`）。
   *
   * ⚠️ 为什么在这里也要：`turn_start`（新一轮开始）是"输入已提交"在浏览器侧最能对得上的
   *    锚点，而"首段语音真的开始播"在 speech 客户端记。两边必须用**同一个时钟**，
   *    否则"提交 → 开播"这条延迟就只能靠两台机器的钟相减（契约 §3 禁止）。
   */
  const stamp = () => (typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now());
  const record = (meta, state, extra = {}) => {
    events.push({ segmentId: meta.segmentId, generation: meta.generation, cue: meta.cue, state, at: stamp(), ...extra });
    if (events.length > 64) events.shift();
    publish();
  };
  const valid = (meta) => meta?.version === 'lg-expression@1' && meta.generation === generation &&
    typeof meta.replyId === 'string' && typeof meta.segmentId === 'string' &&
    meta.segmentId.startsWith(`${meta.replyId}#`) && cues.includes(meta.cue) &&
    ['neutral', 'smile', 'surprised'].includes(meta.expression) && ['none', 'nod', 'tilt'].includes(meta.gesture);

  function stop(reason = 'interrupted') {
    if (['interrupted', 'failed', 'disconnected'].includes(reason)) revoked = true;
    publish();
    if (!active) return;
    const old = active;
    active = null;
    old.restore();
    getAdapter()?.setExpression('neutral');
    record(old.meta, reason, { gesture: old.meta.gesture, peakOffset: old.peakOffset });
    if (reason !== 'ended') {
      old.audio.pause();
      old.model?._wavFileHandler?.releasePcmData();
      old.audio.dispatchEvent(new Event('ended'));
    }
  }

  function begin(next) {
    if (!Number.isSafeInteger(next) || next <= generation) return false;
    stop('superseded');
    generation = next;
    revoked = false;
    seen.clear();
    /*
     * Lv4.5 / P1 计时锚点：新一轮开始。
     * ⚠️ 它对应服务端的 `lg-expression-turn`（她在开始处理这一轮），是浏览器侧
     *    最接近"输入已提交"的可观测时刻。**不**等于用户松开麦克风的时刻，也不等于
     *    服务端收到输入的时刻 —— 因此"首反馈"那条延迟在这里是**上界**（从"她开始处理"
     *    到"我们看见反馈"），而"提交 → 开播"必须注明锚点是什么。
     */
    events.push({ segmentId: null, generation, cue: null, state: 'turn_start', at: stamp() });
    if (events.length > 64) events.shift();
    publish();
    return true;
  }

  function canPlay(meta) {
    return valid(meta) && !revoked && !seen.has(meta.segmentId);
  }

  /** Called by the audio element's playing event, not by packet arrival or canplaythrough. */
  function start(meta, audio) {
    if (!canPlay(meta)) {
      record(meta || {}, 'rejected_stale_or_duplicate');
      audio.pause();
      audio.dispatchEvent(new Event('ended'));
      return false;
    }
    stop('superseded');
    const model = getModel();
    const adapter = getAdapter();
    seen.add(meta.segmentId);
    const started = now();
    active = { meta, audio, model, restore: () => {}, peakOffset: 0 };
    let expression = meta.expression;
    const names = Array.from({ length: adapter?.getExpressionCount() || 0 }, (_, i) => adapter.getExpressionName(i));
    if (!names.includes(expression)) expression = 'neutral';
    adapter?.setExpression(expression);

    const core = model?._model;
    const parameter = meta.gesture === 'nod' ? 'ParamAngleY' : meta.gesture === 'tilt' ? 'ParamAngleZ' : null;
    if (core && parameter) {
      let index = -1;
      for (let i = 0; i < core.getParameterCount(); i++) {
        if (core.getParameterId(i).getString().s === parameter) { index = i; break; }
      }
      if (index >= 0) {
        const original = core.update;
        const owner = active;
        const wrapped = function (...args) {
          const progress = Math.min(1, Math.max(0, (now() - started) / (meta.gesture === 'nod' ? 1400 : 1800)));
          const offset = meta.gesture === 'nod'
            ? 3 * Math.sin(2 * Math.PI * progress) * Math.sin(Math.PI * progress)
            : 4 * Math.sin(Math.PI * progress);
          const baseline = core.getParameterValueByIndex(index);
          const value = Math.max(core.getParameterMinimumValue(index), Math.min(core.getParameterMaximumValue(index), baseline + offset));
          owner.peakOffset = Math.max(owner.peakOffset, Math.abs(value - baseline));
          // Runs after ordinary motion/physics/lip sync, immediately before the Cubism core update.
          core.setParameterValueByIndex(index, value);
          try { return original.apply(this, args); }
          finally { core.setParameterValueByIndex(index, baseline); }
        };
        core.update = wrapped;
        owner.restore = () => { if (core.update === wrapped) core.update = original; };
      } else {
        record(meta, 'gesture_missing_parameter', { parameter });
      }
    }
    record(meta, 'playing', { expression, gesture: meta.gesture });
    return true;
  }

  function finish(segmentId, reason = 'ended') {
    if (active?.meta.segmentId === segmentId) stop(reason);
  }

  function disconnect() {
    stop('disconnected');
    generation = 0;
    seen.clear();
    publish();
  }

  publish();
  return { begin, canPlay, start, finish, stop, disconnect, reading };
}

export const expressionPlayback = typeof window === 'undefined' ? null : createExpressionPlayback(
  () => window.getLive2DManager?.()?.getModel(0),
  () => window.getLAppAdapter?.(),
);
if (typeof window !== 'undefined') window.lgExpressionReading = () => expressionPlayback.reading();
