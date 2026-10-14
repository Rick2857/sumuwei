import { createAvatar } from '/avatar3d/avatar.js';

const section = document.getElementById('avatar-section');
section.hidden = false;
const avatar = createAvatar(document.getElementById('viewport'));
let generation = -1, responseId, chunks = [], previous = performance.now();
const reset = () => { chunks = []; avatar.reset(); };
window.addEventListener('omni-audio', ({ detail: d }) => {
  if (d.generation < generation) return;
  if (d.generation !== generation || d.responseId !== responseId) { reset(); generation = d.generation; responseId = d.responseId; }
  chunks.push(d);
});
window.addEventListener('omni-playback', ({ detail: d }) => {
  if (d.generation !== generation || d.responseId !== responseId) return;
  if (d.state === 'cancelled') reset();
  if (d.state === 'ended') chunks = chunks.filter(c => c.chunkIndex !== d.chunkIndex);
});
window.addEventListener('pagehide', reset);
function animate(time) {
  chunks = chunks.filter(c => time < c.scheduledPerformanceTime + c.samples.length / c.sampleRate * 1000);
  const active = chunks.find(c => time >= c.scheduledPerformanceTime);
  let rms = 0;
  if (active) {
    const start = Math.floor((time - active.scheduledPerformanceTime) / 1000 * active.sampleRate);
    const end = Math.min(active.samples.length, start + 480);
    for (let i = start; i < end; i++) rms += active.samples[i] ** 2;
    rms = Math.sqrt(rms / Math.max(1, end - start));
  }
  avatar.update(Math.min(0.05, (time - previous) / 1000), time / 1000,
    { mouth: Math.min(1, rms * 8), expression: 'neutral', nod: 0, tilt: 0 });
  previous = time; requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
window.lgAvatar3d = { reading: () => ({ avatar: avatar.reading(), generation, responseId, queued: chunks.length }) };
try {
  const response = await fetch('/models/aoba.vrm');
  if (!response.ok) throw Error('model_missing');
  await avatar.load(await response.arrayBuffer());
  document.getElementById('avatar-status').textContent = 'Aoba';
} catch { document.getElementById('avatar-status').textContent = '本机 Aoba 模型未就绪'; }
