import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayback } from '../public/playback.js';

const meta = (extra = {}) => ({ version: 'lg-expression@1', replyId: 'reply', segmentId: 'reply#0', generation: 1, cue: 'reassuring', expression: 'smile', gesture: 'nod', ...extra });
const audio = () => ({ paused: false, ended: false, pauses: 0, pause() { this.paused = true; this.pauses++; } });
test('nothing performs until actual playing; legal metadata performs and then resets', () => {
  let clock = 0, resets = 0;
  const player = createPlayback({ now: () => clock, reset: () => resets++ });
  assert.equal(player.canPlay(meta()), false);
  assert.equal(player.begin(1), true);
  assert.deepEqual(player.sample(0.2), { mouth: 0, expression: 'neutral', nod: 0, tilt: 0 });
  const pending = audio(); pending.paused = true;
  assert.equal(player.start(meta(), pending), false);
  const playing = audio();
  assert.equal(player.start(meta(), playing), true);
  clock = 350;
  const pose = player.sample(0.15);
  assert.ok(pose.mouth > 0 && pose.mouth <= 1);
  assert.ok(Math.abs(pose.nod) > 0); assert.equal(pose.expression, 'smile');
  player.finish('reply#0');
  assert.equal(player.reading().state, 'idle');
  assert.deepEqual(player.sample(1), { mouth: 0, expression: 'neutral', nod: 0, tilt: 0 });
  assert.ok(resets > 0);
});
for (const extra of [
  { version: 'unknown' }, { generation: 0 }, { generation: 2 }, { replyId: 'different' },
  { segmentId: 'reply#garbage' }, { expression: 'unregistered' }, { cue: 'unregistered' }, { gesture: 'unregistered' },
]) test(`reject invalid identity/vocabulary ${JSON.stringify(extra)}`, () => {
  const player = createPlayback(); player.begin(1);
  const rejected = audio(); assert.equal(player.start(meta(extra), rejected), false);
  assert.equal(rejected.paused, true); assert.equal(player.reading().active, null);
});
for (const reason of ['interrupted', 'failed', 'disconnected']) test(`${reason} stops audio, resets and rejects late results; new generation recovers`, () => {
  const player = createPlayback(); player.begin(1);
  const first = audio(); player.start(meta(), first); player.sample(0.2); player.stop(reason);
  assert.equal(first.paused, true); assert.equal(player.reading().revoked, true);
  assert.equal(player.start(meta({ segmentId: 'reply#1' }), audio()), false);
  assert.deepEqual(player.sample(0.2), { mouth: 0, expression: 'neutral', nod: 0, tilt: 0 });
  assert.equal(player.begin(2), true);
  assert.equal(player.start(meta({ generation: 2, replyId: 'new', segmentId: 'new#0' }), audio()), true);
});
test('duplicate and old finish never interrupt a newer segment', () => {
  const player = createPlayback(); player.begin(1);
  const first = audio(); assert.equal(player.start(meta(), first), true);
  assert.equal(player.start(meta(), first), false); assert.equal(first.paused, false);
  const second = audio(); assert.equal(player.start(meta({ segmentId: 'reply#1', gesture: 'tilt' }), second), true);
  assert.equal(first.paused, true);
  player.finish('reply#0'); assert.equal(player.reading().active, 'reply#1');
  assert.equal(player.start(meta(), audio()), false); assert.equal(second.paused, false);
});
test('new generation stops previous playback and refuses late old packets', () => {
  const player = createPlayback(); player.begin(1);
  const first = audio(); player.start(meta(), first); player.begin(2);
  assert.equal(first.paused, true); assert.equal(player.start(meta(), audio()), false);
  for (const invalid of [0, 1, 2, 2.5, NaN, Infinity]) assert.equal(player.begin(invalid), false);
});
test('pause/end without explicit finish also stops mouth; amplitude is bounded', () => {
  const player = createPlayback(); player.begin(1);
  const first = audio(); player.start(meta(), first);
  for (const value of [NaN, Infinity, -1, 100, 0]) assert.ok(Number.isFinite(player.sample(value).mouth));
  first.paused = true; assert.equal(player.sample(0.3).mouth, 0); assert.equal(player.reading().revoked, true);
  player.begin(2); const second = audio(); player.start(meta({ generation: 2 }), second);
  second.ended = true; assert.equal(player.sample(0.3).mouth, 0); assert.equal(player.reading().state, 'idle');
});
test('gesture is bounded in time and neutral carries no happy expression', () => {
  let clock = 0;
  const player = createPlayback({ now: () => clock }); player.begin(1);
  player.start(meta({ expression: 'neutral', gesture: 'tilt' }), audio()); clock = 900;
  assert.ok(player.sample().tilt > 0); clock = 3000;
  assert.ok(Math.abs(player.sample().tilt) < 1e-10); assert.equal(player.sample().expression, 'neutral');
});
