/** Execute the real player against a controlled Web Audio clock and PCM arrivals. No speaker claim. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

const source = readFileSync('scripts/postlv2_speech_client.js', 'utf8').replace(/^import .*;\r?\n/m, '');
assert.ok(source.includes('stream.bufferedSeconds < 3.0'));
const candidates = [
  { name: 'current', source },
  { name: 'shorter-buffer', source: source.replace('stream.bufferedSeconds < 3.0', 'stream.bufferedSeconds < 1.5').replace('if (!stream.nextStart) stream.nextStart = context.currentTime + 0.4', 'if (!stream.nextStart) stream.nextStart = context.currentTime + 0.2') },
];
const traces = [
  { name: 'steady', chunks: Array.from({ length: 10 }, (_, index) => ({ at: index * 0.18, seconds: 0.5, final: index === 9 })) },
  { name: 'short-final', chunks: [{ at: 0, seconds: 0.5 }, { at: 0.2, seconds: 0.5, final: true }] },
  // Deliberate 2.4s pause: a faster startup may run dry before this late chunk.
  { name: 'jitter-negative', chunks: [{ at: 0, seconds: 0.5 }, { at: 0.1, seconds: 0.5 }, { at: 0.2, seconds: 0.5 }, { at: 2.6, seconds: 0.5 }, { at: 2.7, seconds: 0.5 }, { at: 2.8, seconds: 0.5 }, { at: 2.9, seconds: 0.5, final: true }] },
];
const rows = [];
for (const candidate of candidates) {
  const { createSpeechPlayback } = await import('data:text/javascript;base64,' + Buffer.from(candidate.source).toString('base64'));
  for (const trace of traces) {
    const nodes = [];
    const context = { currentTime: 0, state: 'running', resume: async () => {},
      createBuffer: (_, length, sampleRate) => ({ duration: length / sampleRate, copyToChannel() {} }),
      createBufferSource: () => {
        const node = { connect() {}, stop() { this.stopped = true; }, start(at) { this.at = at; }, onended: null };
        nodes.push(node); return node;
      },
      createAnalyser: () => ({ connect() {}, disconnect() {} }),
    };
    let revoked = false;
    const expressions = { reading: () => ({ generation: 1, revoked }), canPlay: () => !revoked, start: () => !revoked, finish() {} };
    const player = createSpeechPlayback(expressions, () => undefined, () => context);
    const meta = { segmentId: `segment:${trace.name}`, generation: 1, requestId: 'buffer-probe', text_sha256: 'fixture' };
    const packet = (index, chunk) => ({ actions: { lg_expression: meta }, codec: 'pcm_f32le', sample_rate: 24000, index,
      audio: Buffer.from(new Float32Array(Math.round(chunk.seconds * 24000)).fill(0.05).buffer).toString('base64'), final: Boolean(chunk.final), failed: false });
    assert.equal(player.feed(packet(0, trace.chunks[0])), true);
    const completion = player.play(meta, () => {}, () => () => {});
    await delay(2);
    for (let index = 1; index < trace.chunks.length; index += 1) {
      context.currentTime = trace.chunks[index].at;
      for (const node of nodes) if (!node.ended && node.at + node.buffer.duration <= context.currentTime) { node.ended = true; node.onended?.(); }
      await delay(25);
      assert.equal(player.feed(packet(index, trace.chunks[index])), true);
    }
    context.currentTime = 20;
    await delay(25);
    for (const node of nodes) if (!node.ended) { node.ended = true; node.onended?.(); }
    await completion;
    const events = player.reading().events;
    rows.push({ candidate: candidate.name, trace: trace.name, firstScheduledSeconds: nodes[0]?.at,
      underruns: events.filter(event => event.state === 'underrun').length,
      playedNodes: nodes.length, ended: events.some(event => event.state === 'ended') });
    assert.equal(nodes.length, trace.chunks.length);
    assert.ok(events.some(event => event.state === 'ended'));
    // Real player continues to reject duplicate/obsolete chunks after stop.
    revoked = true;
    player.stop();
    assert.equal(player.feed(packet(trace.chunks.length, { seconds: 0.5 })), false);
  }
}
const steadyOld = rows.find(row => row.candidate === 'current' && row.trace === 'steady');
const steadyNew = rows.find(row => row.candidate === 'shorter-buffer' && row.trace === 'steady');
assert.ok(steadyNew.firstScheduledSeconds < steadyOld.firstScheduledSeconds);
const jitterOld = rows.find(row => row.candidate === 'current' && row.trace === 'jitter-negative');
const jitterNew = rows.find(row => row.candidate === 'shorter-buffer' && row.trace === 'jitter-negative');
assert.ok(jitterNew.underruns > jitterOld.underruns);
const reading = { rows, selected: 'current', verdict: 'KEEP_CURRENT_BUFFER', reason: 'Shorter startup increased underruns in injected jitter; real acoustic/jitter acceptance not performed', scope: 'Real player, simulated AudioContext and synthetic chunk arrivals; no browser/speaker/production latency claim' };
const dir = join('artifacts', 'post-lv2', `playback-buffer-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'reading.json'), JSON.stringify(reading, null, 2));
console.log(JSON.stringify({ dir, ...reading }, null, 2));
