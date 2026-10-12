/** CosyVoice PCM chunks share one Web Audio clock; expressions belong to the sentence. */
import { expressionPlayback } from './postlv2_expression_client.js';

async function notifyCoreInterrupt(requestIds) {
  if (typeof fetch !== 'function' || typeof window === 'undefined') return { status: 'failed', code: 'interrupt_transport_absent' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch('/lg/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestIds }), signal: controller.signal });
    const result = await response.json();
    return response.ok && ['acknowledged', 'failed'].includes(result.status)
      ? result : { status: 'failed', code: 'interrupt_verdict_invalid' };
  } catch { return { status: 'failed', code: 'interrupt_transport_failed' }; }
  finally { clearTimeout(timeout); }
}

export function createSpeechPlayback(expressions, getModel, createContext, notifyInterrupt = notifyCoreInterrupt) {
  let context;
  const streams = new Map();
  const events = [];
  const terminalSegments = new Set();
  const interruptions = [];
  /*
   * Lv4.5 / P1 计时：所有事件都带**同一个浏览器时钟**的时间戳（`performance.now()`）。
   *
   * ⚠️ 为什么必须在这里打：计划 §3 第二步要求"浏览器/播放端**同一时钟**"，
   *    而"首段实质语音实际播放"这个时刻**只有这里知道**（它是音频节点真的排上
   *    Web Audio 时钟的那一刻）。服务端时间只用于对账，不能与它相减。
   */
  const stamp = () => (typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now());
  const record = (stream, state, extra = {}) => {
    events.push({ segmentId: stream.meta.segmentId, generation: stream.meta.generation, state, at: stamp(), ...extra });
    if (events.length > 64) events.shift();
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-lg-speech', JSON.stringify(reading()));
  };
  const reading = () => ({ active: [...streams.keys()], events: [...events], interruptions: interruptions.map(item => ({ ...item })) });
  /*
   * Lv4.5 / P1：**播放事实回账**（媒体交付契约 §1 的交付账）。
   *
   * 只有这个客户端知道"声音真的从声卡出来了"；服务端**不能**替它推断。
   * 因此每一次真正发生状态变化时，都如实报一条（含客户端时钟上的区间）：
   *   playing   —— 首个音频节点真的排到了 Web Audio 时钟上
   *   played    —— 这一段的最后一个节点真的播完
   *   cancelled —— 被打断 / 被顶掉 / 被停止（结局明确：没播完）
   *   unknown   —— 出错或断连（**结局不明**；契约明令断线不得算已播放）
   *
   * ⚠️ 失败一律**吞掉**：报不出去**不能**影响播放本身，也不能让页面抛错。
   *    服务端那边 `accepted: false` 同样是常态（重复包 / 乱序包 / 重启过）。
   * ⚠️ 合成账（`synthesized`）也由这里报：本客户端就是**观察到那段音频**的一方，
   *    而交付账的迁移表不允许从 `generated` 直接跳到 `queued`。
   */
  const reportPlayback = (meta, state, extra = {}) => {
    if (typeof fetch !== 'function' || typeof window === 'undefined' || !meta?.segmentId) return;
    const at = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const body = { segmentId: meta.segmentId, replyId: meta.replyId, requestId: meta.requestId,
      generation: meta.generation, state, at: Math.round(at),
      ...(extra.playedFrom !== undefined ? { playedFrom: Math.round(extra.playedFrom) } : {}),
      ...(extra.playedTo !== undefined ? { playedTo: Math.round(extra.playedTo) } : {}),
      ...(extra.detail ? { detail: String(extra.detail) } : {}) };
    fetch('/lg/playback', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), keepalive: true }).catch(() => {});
  };
  const unlock = async () => {
    context ||= createContext();
    await context.resume();
  };

  /*
   * Lv4.5 / P1 —— **同钟计时**（计划 §3 第二步：浏览器同钟记录输入提交 / 首反馈 /
   * 首段实质语音实际播放 / 有效停止确认 / 停播）。
   *
   * ⚠️ 为什么在**客户端**记：那些时刻只有这里知道 —— 尤其"第一段音频真的排上
   *    Web Audio 时钟"与"声音真的停了"。服务端时间只能对账，不能与它相减。
   * ⚠️ 只上报**白名单里的数字**（服务端会再筛一次）：没有正文、没有转录、没有回复。
   * ⚠️ 失败一律吞掉：计时上报坏掉绝不能影响播放。
   */
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let turnTiming = null;
  /**
   * Lv4.5 / `P1`：**用户提交输入的同钟时刻**（页面在发 `text-input` / `mic-audio-end`
   * 的那一刻调 {@link markSubmit}）。
   *
   * ============================================================================
   *  为什么必须有它（这是计划 §3 要的那个数）
   * ============================================================================
   * ```text
   * 没有它：`firstSpeechStartMs` 只能以"第一块音频到达"为锚
   *        ⇒ 量到的是**播放排程延迟**（实测 406–516 ms）
   * 有它：  锚点移到**用户提交**那一刻 ⇒ 量到的是**端到端**
   *        （协议侧同类读数在 11 s 量级）—— 两者基线不同，**绝不能混着比**
   * ```
   * ⚠️ 没有提交事件时（例如页面被顶掉、或老包）**如实报"没有锚"**，
   *    而不是拿包到达当锚冒名顶替。
   */
  let submitAtMs = null;
  const markSubmit = () => { submitAtMs = nowMs(); };
  const beginTurnTiming = (generation) => {
    turnTiming = { generation, index: (turnTiming?.index ?? 0) + 1, startedAt: nowMs(),
      firstSpeechStartMs: null, firstSpeechFromPacketMs: null, stopSignalMs: null, stopObservedMs: null,
      segmentCount: 0, playedCount: 0, cancelledCount: 0 };
  };
  const reportTurnTiming = () => {
    if (!turnTiming || typeof fetch !== 'function' || typeof window === 'undefined') return;
    const t = turnTiming;
    /*
     * ⚠️ 两个锚**都留**，但只发**白名单里的两个字段**，于是不需要改协议：
     * ```text
     * submitMs            —— 提交 → 本轮计时开始（= 她的第一块包到达）的那一段
     * firstSpeechStartMs  —— 有提交锚时：**提交 → 真的出声**（端到端，计划 §3 要的那个）
     *                        没有提交锚时：退回"包到达 → 出声"，并在下面注明
     * ```
     * 无锚时的值可从 `firstSpeechStartMs - submitMs`... **不**成立（见下），
     * 所以无锚时 `submitMs` 记 0、并在字段里如实说明这是**退化的**读数。
     */
    const anchoredAtSubmit = submitAtMs !== null;
    const submitMs = anchoredAtSubmit ? Math.max(0, Math.round(t.startedAt - submitAtMs)) : 0;
    const firstSpeech = t.firstSpeechFromPacketMs === null
      ? null
      : anchoredAtSubmit ? t.firstSpeechFromPacketMs + submitMs : t.firstSpeechFromPacketMs;
    const fields = {
      turnIndex: t.index, generation: Number(t.generation) || 0,
      submitMs,
      ...(firstSpeech !== null ? { firstSpeechStartMs: Math.round(firstSpeech) } : {}),
      ...(t.stopSignalMs !== null ? { stopSignalMs: Math.round(t.stopSignalMs) } : {}),
      ...(t.stopObservedMs !== null ? { stopObservedMs: Math.round(t.stopObservedMs) } : {}),
      segmentCount: t.segmentCount, playedCount: t.playedCount, cancelledCount: t.cancelledCount,
    };
    /* 上报后不再重复（同一轮只发一条），避免刷屏 */
    turnTiming = { ...t, reported: true };
    submitAtMs = null;
    fetch('/lg/client-timing', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields }), keepalive: true }).catch(() => {});
  };
  const observeStop = (reason) => {
    if (!turnTiming || turnTiming.reported) return;
    if (reason === 'ended') return;
    /* 三个字段统一是"相对本轮开始"的偏移，避免把不同基准混在一起 */
    if (turnTiming.stopSignalMs === null) turnTiming.stopSignalMs = Math.round(nowMs() - turnTiming.startedAt);
  };

  function finish(stream, reason) {
    if (stream.finished) return;
    stream.finished = true;
    terminalSegments.add(stream.meta.segmentId);
    if (terminalSegments.size > 128) terminalSegments.delete(terminalSegments.values().next().value);
    clearInterval(stream.timer);
    for (const source of stream.sources) { source.onended = null; source.stop(); }
    stream.sources.clear();
    stream.pending.length = 0;
    stream.analyser?.disconnect();
    stream.restore?.();
    stream.cleanup?.();
    expressions.finish(stream.meta.segmentId, reason);
    streams.delete(stream.meta.segmentId);
    record(stream, reason, { underruns: stream.underruns, peakRms: stream.peakRms || 0 });
    /*
     * 交付事实：**结局明确**的没播完算 `cancelled`；出错与断连算 `unknown`
     * （"不知道播没播"与"确定没播"是两件事，合并会让契约 §2 M11 无法区分）。
     */
    if (reason === 'ended') {
      reportPlayback(stream.meta, 'played',
        { ...(stream.firstStart !== undefined ? { playedFrom: stream.firstStart * 1000 } : {}),
          ...(stream.nextStart !== undefined ? { playedTo: stream.nextStart * 1000 } : {}) });
    } else if (reason === 'failed' || reason === 'disconnected') {
      reportPlayback(stream.meta, 'unknown', { detail: reason });
    } else {
      reportPlayback(stream.meta, 'cancelled', { detail: reason });
    }
    /*
     * 同钟计时：这一段收尾 ⇒ 计入本轮；本轮**全部**片段结束 ⇒ 上报一次。
     * ⚠️ `stopObservedMs` 只在"确实发生过停止"时才有值（否则它会把正常播完也记成停播）。
     */
    if (turnTiming) {
      if (reason === 'ended') turnTiming.playedCount += 1;
      else turnTiming.cancelledCount += 1;
      if (streams.size === 0 && turnTiming.segmentCount > 0) {
        if (turnTiming.stopSignalMs !== null && turnTiming.stopObservedMs === null) {
          turnTiming.stopObservedMs = nowMs() - turnTiming.startedAt - turnTiming.stopSignalMs;
        }
        if (!turnTiming.reported) reportTurnTiming();
      }
    }
    stream.resolve?.();
  }

  function schedule(stream) {
    if (!stream.playRequested || stream.finished || !context || context.state !== 'running') return;
    if (!stream.started && !stream.final && stream.bufferedSeconds < 3.0) return;
    if (stream.failed) { finish(stream, 'failed'); return; }
    while (stream.pending.length) {
      const samples = stream.pending.shift();
      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(stream.analyser);
      if (!stream.nextStart) stream.nextStart = context.currentTime + 0.4;
      else if (stream.nextStart < context.currentTime + 0.01) {
        stream.underruns += 1;
        record(stream, 'underrun');
        stream.nextStart = context.currentTime + 0.4;
      }
      stream.firstStart ||= stream.nextStart;
      source.start(stream.nextStart);
      stream.nextStart += buffer.duration;
      stream.sources.add(source);
      source.onended = () => {
        stream.sources.delete(source);
        if (stream.final && !stream.pending.length && !stream.sources.size) finish(stream, 'ended');
      };
    }
    if (stream.final && !stream.sources.size) finish(stream, 'ended');
  }

  function feed(packet) {
    const meta = packet.actions?.lg_expression;
    const state = expressions.reading();
    if (!meta || terminalSegments.has(meta.segmentId) || meta.generation !== state.generation || state.revoked || packet.codec !== 'pcm_f32le' || packet.sample_rate !== 24000) return false;
    /* 同钟计时：generation 变了 = 新一轮 ⇒ 重开一份计时（上一轮若没上报过，这里不重复上报） */
    if (!turnTiming || turnTiming.generation !== meta.generation) beginTurnTiming(meta.generation);
    let stream = streams.get(meta.segmentId);
    if (!stream) {
      if (packet.index !== 0 || !expressions.canPlay(meta)) return false;
      stream = { meta, pending: [], sources: new Set(), nextIndex: 0, bufferedSeconds: 0, underruns: 0 };
      stream.completion = new Promise(resolve => { stream.resolve = resolve; });
      streams.set(meta.segmentId, stream);
      if (turnTiming) turnTiming.segmentCount += 1;
    }
    if (packet.index !== stream.nextIndex || meta.requestId !== stream.meta.requestId || meta.text_sha256 !== stream.meta.text_sha256) {
      finish(stream, 'failed');
      return false;
    }
    stream.nextIndex += 1;
    if (packet.audio) {
      const bytes = Uint8Array.from(atob(packet.audio), char => char.charCodeAt(0));
      if (bytes.length % 4) { finish(stream, 'failed'); return false; }
      const view = new DataView(bytes.buffer);
      const samples = Float32Array.from({ length: bytes.length / 4 }, (_, i) => view.getFloat32(i * 4, true));
      if (!samples.length || !samples.every(Number.isFinite)) { finish(stream, 'failed'); return false; }
      stream.pending.push(samples);
      stream.bufferedSeconds += samples.length / 24000;
    }
    stream.final = packet.final;
    stream.failed = packet.failed;
    schedule(stream);
    /*
     * 合成账：本客户端收到**真实音频**就算"这一段合成完成"（带 audioId）。
     * ⚠️ 它不声称"已播出" —— 播出由下面 `playing` / `played` 两条事实报告。
     * 每个片段只报一次（重复报在服务端是幂等吸收，但没必要白发）。
     */
    if (!stream.synthesizedReported && packet.audio) {
      stream.synthesizedReported = true;
      reportPlayback(meta, 'synthesized', { audioId: `${meta.segmentId}@${meta.text_sha256?.slice(0, 12) || 'audio'}` });
    }
    return true;
  }

  function play(meta, onStart, registerAudio) {
    const stream = streams.get(meta.segmentId);
    if (!stream || !expressions.canPlay(meta)) return Promise.resolve();
    if (stream.playRequested) return stream.completion;
    stream.playRequested = true;
      unlock().then(() => {
      if (stream.finished || !expressions.canPlay(meta)) { finish(stream, 'interrupted'); return; }
      stream.analyser = context.createAnalyser();
      stream.analyser.fftSize = 1024;
      stream.analyser.connect(context.destination);
      const audio = new EventTarget();
      audio.pause = () => finish(stream, 'interrupted');
      audio.load = () => {};
      audio.addEventListener('ended', () => finish(stream, 'interrupted'));
      const model = getModel();
      stream.timer = setInterval(() => {
        if (!stream.started && stream.firstStart && context.state === 'running' && context.currentTime >= stream.firstStart) {
          stream.started = true;
          stream.cleanup = registerAudio(audio, model);
          if (!expressions.start(meta, audio)) { finish(stream, 'interrupted'); return; }
          const handler = model?._wavFileHandler;
          if (handler) {
            const original = handler.getRms;
            const values = new Float32Array(stream.analyser.fftSize);
            const rms = () => {
              stream.analyser.getFloatTimeDomainData(values);
              const value = Math.min(2, 2 * Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length));
              stream.peakRms = Math.max(stream.peakRms || 0, value);
              return value;
            };
            handler.getRms = rms;
            stream.restore = () => { if (handler.getRms === rms) handler.getRms = original; };
          }
          onStart();
          record(stream, 'playing');
          /* 交付事实：**真的排上时钟并开始播**（不是"包收到了"） */
          reportPlayback(meta, 'playing');
          /*
           * 同钟计时：**第一段真的开播**的时刻（相对本轮计时开始）。
           *
           * ⚠️ 这个字段是**包锚**（相对第一块音频到达）。上报时会按"有没有提交锚"
           *    换算成端到端或原样发出 —— 换算与两个锚的说明见 `reportTurnTiming`。
           */
          if (turnTiming && turnTiming.firstSpeechFromPacketMs === null) {
            turnTiming.firstSpeechFromPacketMs = Math.round(nowMs() - turnTiming.startedAt);
          }
        }
        schedule(stream);
      }, 20);
      schedule(stream);
      }).catch(() => finish(stream, 'failed'));
    return stream.completion;
  }

  function stop(reason = 'interrupted') {
    /* 同钟计时：**用户确认有效停止**的时刻（本地就地生效，不等 LG 回话） */
    observeStop(reason);
    const active = [...streams.values()];
    const requestIds = [...new Set(active.map(stream => stream.meta.requestId).filter(id => id && id !== 'interjection'))];
    for (const stream of active) finish(stream, reason);
    return { status: 'silent', stoppedSegments: active.length, requestIds };
  }
  function interrupt(reason = 'interrupted') {
    const local = stop(reason);
    const state = { generation: expressions.reading().generation, stoppedSegments: local.stoppedSegments,
      silenced: local.status, core: local.requestIds.length ? 'pending' : 'not_requested' };
    interruptions.push(state);
    if (interruptions.length > 16) interruptions.shift();
    const done = local.requestIds.length
      ? Promise.resolve().then(() => notifyInterrupt(local.requestIds)).catch(() => ({ status: 'failed', code: 'interrupt_transport_failed' }))
      : Promise.resolve({ status: 'not_requested' });
    done.then(result => { state.core = result.status; });
    return { silenced: Promise.resolve(local), done };
  }
  return { feed, play, stop, interrupt, unlock, reading, markSubmit };
}

export const speechPlayback = typeof window === 'undefined' ? null : createSpeechPlayback(
  expressionPlayback, () => window.getLive2DManager?.()?.getModel(0), () => new AudioContext());
if (typeof document !== 'undefined') {
  for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, () => speechPlayback.unlock().catch(() => {}), { passive: true });
}
