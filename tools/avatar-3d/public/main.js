import { createAvatar } from './avatar.js';
import { createPlayback } from './playback.js';

const $ = id => document.getElementById(id);
const presets = { natural: ['neutral', 'none'], reassuring: ['smile', 'nod'], playful: ['smile', 'tilt'], firm: ['neutral', 'none'], subdued: ['neutral', 'none'], surprised: ['surprised', 'none'] };
let avatar, controller, live, audioContext, analyser, samples, source, audioUrl, generation = 0, cue = 'natural', loading = false, loadSequence = 0;
const audio = new Audio();
const status = (text, playing = false) => { $('status-text').textContent = text; $('status-dot').classList.toggle('playing', playing); };
const interrupt = reason => { if (live) live.stop(reason); else controller?.stop(reason); $('interrupt').disabled = true; };
function testTone() {
  const rate = 24000, count = rate * 4, bytes = new ArrayBuffer(44 + count * 2), view = new DataView(bytes);
  const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const t = i / rate, pulse = Math.max(0, Math.sin(t * Math.PI * 4));
    const fade = Math.min(1, t * 15, (4 - t) * 15);
    view.setInt16(44 + i * 2, Math.sin(t * Math.PI * 2 * 180) * pulse * fade * 7000, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
async function loadModel(input, label) {
  const sequence = ++loadSequence;
  loading = true; interrupt('interrupted'); $('play').disabled = true; $('model-select').disabled = true; status('正在加载模型…');
  try {
    const bytes = await input;
    const capabilities = await avatar.load(bytes);
    if (sequence !== loadSequence) return;
    $('model-label').textContent = label;
    window.lgAvatar3d.capabilities = capabilities;
    status(!capabilities.expressions.includes('aa') ? '模型就绪 · 缺少口型表情' :
      !capabilities.expressions.includes('surprised') ? '模型就绪 · 无惊讶表情，使用中性替代' : '模型就绪');
  } catch (error) { status(`模型加载失败：${error.message}`); }
  finally { loading = false; $('play').disabled = !avatar.reading().loaded; $('model-select').disabled = false; }
}
const fetchModel = file => fetch(`/models/${encodeURIComponent(file)}`).then(response => {
  if (!response.ok) throw new Error('本机模型文件不存在');
  return response.arrayBuffer();
});
try {
  avatar = createAvatar($('viewport'));
  controller = createPlayback({ reset: () => avatar.reset() });
  // Local diagnostics contain playback facts, never core credentials.
  window.lgAvatar3d = { controller, capabilities: null, reading: () => ({ playback: controller.reading(), avatar: avatar.reading(),
    live: live?.reading(), audio: { paused: audio.paused, ended: audio.ended, currentTime: audio.currentTime } }) };
  let previous = performance.now();
  const animate = time => {
    let rms = live?.rms() || 0;
    if (analyser) { analyser.getFloatTimeDomainData(samples); rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length); }
    avatar.update(Math.min(0.05, (time - previous) / 1000), time / 1000, controller.sample(rms));
    previous = time; requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
  const response = await fetch('/models/local.json');
  const models = response.ok ? await response.json() : [{ file: 'sample.vrm', label: 'pixiv 示例模型 · 非苏沐薇正式形象' }];
  for (const model of models) {
    if (/^[^/\\]+\.vrm$/.test(model.file)) $('model-select').add(new Option(model.label, model.file));
  }
  const first = $('model-select').selectedOptions[0];
  if (first) await loadModel(fetchModel(first.value), first.textContent);
  else status('请选择本地 VRM 模型');
  const session = await fetch('/session.json').then(r => r.json());
  if (session.live) {
    const { connectLive } = await import('./live.js');
    live = await connectLive({ expressions: controller, status, ready: () => avatar.reading().loaded && !loading,
      log: (speaker, text) => { const row = document.createElement('p'); row.textContent = `${speaker}：${text}`; $('chat-log').append(row); $('chat-log').scrollTop = $('chat-log').scrollHeight; },
      onBusy: () => { $('interrupt').disabled = false; }, onStopped: () => { $('interrupt').disabled = true; },
      onRecording: recording => { $('microphone').textContent = recording ? '结束录音并发送' : '点击说话'; $('microphone').setAttribute('aria-pressed', String(recording)); $('interrupt').disabled = !recording; } });
    for (const group of document.querySelectorAll('[data-preview]')) group.hidden = true;
    $('chat-group').hidden = false;
    document.querySelector('.badge').textContent = live.mode === 'production' ? '正式聊天 · 写入正式记忆' : '隔离聊天 · 不写正式记忆';
    document.querySelector('.footnote').textContent = live.mode === 'production' ? '对话会写入正式记忆。' : '本次对话只写入专用测试库。';
    $('chat-form').addEventListener('submit', async event => {
      event.preventDefault();
      try { await live.send($('chat-input').value); $('chat-input').value = ''; $('interrupt').disabled = false; }
      catch (error) { status(error.message); }
    });
    $('microphone').addEventListener('click', async () => {
      try { await live.toggleMicrophone(); } catch (error) { status(`录音失败：${error.message}`); }
    });
  }
} catch (error) { status(`预览初始化失败：${error.message}`); }

$('model-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file || loading || !avatar) return;
  try { await loadModel(file.arrayBuffer(), file.name); } catch (error) { status(error.message); }
  event.target.value = '';
});
$('model-select').addEventListener('change', async event => {
  if (loading || !avatar) return;
  const option = event.target.selectedOptions[0];
  if (option) await loadModel(fetchModel(option.value), option.textContent);
});
$('audio-file').addEventListener('change', event => {
  interrupt('interrupted');
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  const file = event.target.files[0];
  audioUrl = file ? URL.createObjectURL(file) : undefined;
  $('audio-label').textContent = file ? file.name : '未选择语音时，播放一段口型测试音。';
});
for (const button of document.querySelectorAll('[data-cue]')) button.addEventListener('click', () => {
  cue = button.dataset.cue;
  for (const other of document.querySelectorAll('[data-cue]')) other.setAttribute('aria-pressed', String(other === button));
});
$('play').addEventListener('click', async () => {
  if (!avatar?.reading().loaded || loading) return;
  interrupt('superseded');
  const next = ++generation;
  controller.begin(next);
  const [expression, gesture] = presets[cue];
  const meta = { version: 'lg-expression@1', replyId: `preview-${next}`, segmentId: `preview-${next}#0`, generation: next, cue, expression, gesture };
  try {
    if (!audioContext) {
      audioContext = new AudioContext(); analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
      samples = new Float32Array(analyser.fftSize);
      source = audioContext.createMediaElementSource(audio); source.connect(analyser); analyser.connect(audioContext.destination);
    }
    await audioContext.resume();
    if (generation !== next || controller.reading().revoked) return;
    if (!audioUrl) audioUrl = URL.createObjectURL(testTone());
    audio.onplaying = () => {
      if (controller.start(meta, audio)) {
        const expressionKey = expression === 'smile' ? 'happy' : expression;
        const missing = expression !== 'neutral' && !window.lgAvatar3d.capabilities.expressions.includes(expressionKey);
        status(missing ? '播放中 · 缺少此表情，使用中性替代' : '播放中', true); $('interrupt').disabled = false;
      }
    };
    audio.onended = () => { controller.finish(meta.segmentId); if (!controller.reading().active) { status('播放结束 · 已复位'); $('interrupt').disabled = true; } };
    audio.onerror = () => { controller.finish(meta.segmentId, 'failed'); status('音频无法播放'); $('interrupt').disabled = true; };
    audio.src = audioUrl;
    status('准备播放…');
    await audio.play();
  } catch (error) {
    if (generation !== next) return;
    controller.finish(meta.segmentId, 'failed'); controller.stop('failed'); status(`播放失败：${error.message}`);
  }
});
$('interrupt').addEventListener('click', () => { interrupt('interrupted'); status('已打断 · 口型与动作已复位'); });
audio.addEventListener('pause', () => {
  if (audio.ended) return; // Natural completion also emits pause, before ended.
  if (controller?.reading().active) { interrupt('interrupted'); status('播放已暂停 · 已复位'); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { interrupt('interrupted'); status('预览已暂停'); } });
window.addEventListener('pagehide', () => { interrupt('disconnected'); if (audioUrl) URL.revokeObjectURL(audioUrl); });
