import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSpeechPlayback } from './postlv2_speech_client.js';
import { createExpressionPlayback } from './postlv2_expression_client.js';

const checks = [];
/*
 * ⚠️ 播放回报的采集必须在**建播放器之前**装好：`createSpeechPlayback` 里的
 * `reportPlayback` 每次调用都现取 `fetch`，所以要在这里给出可控替身，
 * 同时给 `window` 一个最小形状（客户端在 Node 下靠它判断"是不是浏览器"）。
 */
const reports = [];
let holdReports = false;
const realFetch = globalThis.fetch;
const realWindow = globalThis.window;
globalThis.window = { location: { origin: 'http://127.0.0.1:12393' } };
globalThis.fetch = async (url, options) => {
  reports.push({ url, ...JSON.parse(options.body) });
  if (holdReports) throw new Error('simulated report transport failure');
  return { ok: true };
};

const handler = { getRms: () => 0, releasePcmData() {} };
const originalRms = handler.getRms;
const model = { _wavFileHandler: handler };
const adapter = { setExpression() {}, getExpressionCount: () => 2, getExpressionName: i => ['neutral', 'smile'][i] };
const expressions = createExpressionPlayback(() => model, () => adapter);
const sources = [];
const context = {
  currentTime: 0, state: 'running', resume: async () => {},
  createBuffer: (_channels, frames, rate) => ({ duration: frames / rate, copyToChannel() {} }),
  createAnalyser: () => ({ fftSize: 1024, connect() {}, disconnect() {}, getFloatTimeDomainData: a => a.fill(0.05) }),
  createBufferSource() {
    const source = { connect() {}, stop() { this.stopped = true; }, start(at) { this.at = at; } };
    sources.push(source);
    return source;
  },
};
const player = createSpeechPlayback(expressions, () => model, () => context);
const meta = (index, generation = 1) => ({ version: 'lg-expression@1', replyId: 'reply', segmentId: `reply#${index}`,
  requestId: 'request', generation, cue: 'natural', expression: 'neutral', gesture: 'none', text_sha256: 'a'.repeat(64) });
const packet = (metadata, index, seconds, final = false) => ({ actions: { lg_expression: metadata }, index, final,
  codec: 'pcm_f32le', sample_rate: 24000, audio: seconds ? Buffer.from(new Float32Array(seconds * 24000).fill(0.05).buffer).toString('base64') : '' });
const tick = () => new Promise(resolve => setTimeout(resolve, 30));

expressions.begin(1);
assert.equal(player.feed(packet(meta(0), 0, 1.5)), true);
let starts = 0;
const playing = player.play(meta(0), () => { starts += 1; }, () => () => {});
await tick();
assert.equal(sources.length, 0);
checks.push('first undersized chunk waits for startup buffer');
player.feed(packet(meta(0), 1, 2));
assert.equal(sources.length, 2);
assert.equal(sources[1].at, sources[0].at + sources[0].buffer.duration);
checks.push('chunks use contiguous start times on one clock');
assert.equal(starts, 0);
context.currentTime = 0.41;
await tick();
assert.equal(starts, 1);
assert.ok(handler.getRms() > 0);
checks.push('expression starts on playback and lip sync follows actual PCM');
player.feed(packet(meta(0), 2, 0, true));
context.currentTime = 4;
for (const source of [...sources]) source.onended?.();
await playing;
assert.equal(handler.getRms, originalRms);
assert.equal(player.reading().active.length, 0);
assert.equal(player.reading().events.find(e => e.state === 'ended').underruns, 0);
assert.equal(expressions.reading().events.filter(e => e.state === 'playing').length, 1);
assert.equal(player.feed(packet(meta(0), 0, 1, true)), false);
checks.push('one expression per sentence; end restores mouth callback and rejects duplicate');

player.feed(packet(meta(1), 0, 0.5, true));
const pending = player.play(meta(1), () => { starts += 1; }, () => () => {});
await tick();
expressions.stop('interrupted');
player.stop();
await pending;
assert.ok(sources.at(-1).stopped);
assert.equal(player.feed(packet(meta(1), 1, 0.5)), false);
checks.push('interrupt before playback stops scheduled nodes and rejects late chunks');

expressions.begin(2);
assert.equal(player.feed(packet(meta(2, 1), 0, 1)), false);
assert.equal(player.feed(packet(meta(2, 2), 0, 1)), true);
assert.equal(player.feed(packet({ ...meta(2, 2), text_sha256: 'b'.repeat(64) }, 1, 1)), false);
checks.push('generation and checked-text identity reject stale or mismatched chunks');

let resume;
const originalResume = context.resume;
context.resume = () => new Promise(resolve => { resume = resolve; });
player.feed(packet(meta(3, 2), 0, 0.5, true));
const waitingForGesture = player.play(meta(3, 2), () => { throw Error('cancelled autoplay must not start'); }, () => () => {});
player.stop();
await waitingForGesture;
resume();
await tick();
/* ⚠️ 必须**放回** resume：上一条用例把它换成了"等手势"的实现，
   留着会让后面每一次 unlock 都永远挂起（实测踩到：后续用例全部超时）。 */
context.resume = originalResume;
checks.push('cancel resolves a task even while browser autoplay is waiting');

// ===========================================================================
// Lv4.5 / P1：**播放事实回账**（浏览器侧那一半）
// ===========================================================================
/*
 * 判据打在"客户端**如实**报了什么"上，而不是"服务端账变对了"：
 *   · 收到真实音频 ⇒ 报 `synthesized`（交付账的迁移表不允许从 generated 直接跳）
 *   · 真的排上时钟 ⇒ 报 `playing`
 *   · 真的播完     ⇒ 报 `played`（并带客户端时钟上的区间）
 *   · 被顶掉/停止  ⇒ 报 `cancelled`（结局明确：没播完）
 *   · 出错/断连    ⇒ 报 `unknown`（**结局不明**，不等于没播）
 * 负控：回报通道坏掉时**播放照常**走完，且播放器**不抛**。
 */
const reportStates = (segmentId) => reports.filter(r => r.segmentId === segmentId).map(r => r.state);
await tick();
assert.deepEqual(reportStates('reply#0'), ['synthesized', 'playing', 'played']);
const playedReport = reports.find(r => r.segmentId === 'reply#0' && r.state === 'played');
assert.ok(playedReport.playedTo > playedReport.playedFrom);
assert.equal(playedReport.url, '/lg/playback');
checks.push('P1 playback facts: synthesized -> playing -> played reported with a client-clock interval');

/*
 * ⚠️ 这一段**从来没有开始播**（stop 在 `firstStart` 之前）：因此它只报
 * `synthesized` + `cancelled`，**没有** `playing` —— 这正是要的性质：
 * "包收到了"不等于"出声了"，而"没出声"报的是 cancelled（确定没播完），
 * 不是 played。
 */
assert.deepEqual(reportStates('reply#1'), ['synthesized', 'cancelled']);
checks.push('P1 playback facts: a sentence stopped before it ever sounded is cancelled, never played');

const beforeFailure = reports.length;
holdReports = true;
expressions.begin(3);
assert.equal(player.feed(packet(meta(4, 3), 0, 1, true)), true);
const failing = player.play(meta(4, 3), () => {}, () => () => {});
/* 先让音源真的被排上（`schedule` 在 play 之后的 tick 里才跑），再让它播完 */
await tick();
context.currentTime = 30;
for (const source of [...sources]) source.onended?.();
await failing;
holdReports = false;
assert.equal(player.reading().active.length, 0);
checks.push('P1 negative control: a broken report channel never blocks or breaks playback');

expressions.begin(4);
assert.equal(player.feed(packet(meta(5, 4), 0, 1, true)), true);
const late = player.play(meta(5, 4), () => {}, () => () => {});
await tick();
assert.equal(player.feed(packet(meta(5, 4), 0, 1, true)), false);
player.stop('disconnected');
await late;
assert.equal(reportStates('reply#5').at(-1), 'unknown');
checks.push('P1 playback facts: a disconnect reports unknown, never played');

// ===========================================================================
// Lv4.5 / P1 同钟计时：客户端真的把**数字读数**报上去了（且不含任何正文）
// ===========================================================================
/*
 * ⚠️ 为什么这条也算判据：2026-10-04 那次真实运行里"浏览器同钟读数一行都没有"，
 *    原因是客户端**从来没上报过** —— 而端点在服务端一直好着。于是整条链看起来
 *    "有接口、没数据"，很容易被误读成"浏览器没触发"。这一条把那个缺口锁住。
 */
const timingPosts = reports.filter(r => r.url === '/lg/client-timing');
assert.ok(timingPosts.length >= 1, 'expected at least one client-timing post');
const timingFields = timingPosts.at(-1).fields;
const timingKeys = Object.keys(timingFields);
const forbidden = timingKeys.filter(k => /text|reply|transcript|content/i.test(k));
assert.deepEqual(forbidden, []);
assert.ok(typeof timingFields.segmentCount === 'number' && timingFields.segmentCount >= 1);
assert.ok(typeof timingFields.playedCount === 'number');
assert.ok(typeof timingFields.cancelledCount === 'number');
assert.ok(typeof timingFields.turnIndex === 'number');
checks.push('P1 same-clock timing: numeric whitelist only, no text fields, and it is actually posted');

const stoppedTurnReport = (() => {
  /*
   * ⚠️ 专用场景（自己的 generation）：**停止确实落在一个活着的流上**。
   *    之前那几段之所以量不到"停止信号"，是因为它们的流在 `stop()` 之前就已经
   *    被重复包/失败**结束**了 —— 那时已经没有任何东西可停，客户端不记停止信号
   *    是**对的**（那不是缺陷，是"没有可停的对象"）。判据因此必须打在真正
   *    有活流的场景上，而不是"随便找一个 cancelled 的轮次"。
   */
  expressions.begin(9);
  assert.equal(player.feed(packet(meta(9, 9), 0, 1, true)), true);
  const pendingStop = player.play(meta(9, 9), () => {}, () => () => {});
  return (async () => {
    await tick();
    player.stop('interrupted');
    await pendingStop;
    await tick();
    return reports.filter(r => r.url === '/lg/client-timing').at(-1)?.fields;
  })();
})();
const stoppedFields = await stoppedTurnReport;
assert.ok(stoppedFields, 'expected the dedicated stop scenario to post client timing');
assert.equal(typeof stoppedFields.stopSignalMs, 'number');
assert.equal(typeof stoppedFields.stopObservedMs, 'number');
assert.ok(stoppedFields.stopSignalMs >= 0 && stoppedFields.stopObservedMs >= 0);
assert.equal(stoppedFields.cancelledCount >= 1, true);
checks.push('P1 same-clock timing: a turn stopped while audio was live records both the stop signal and when audio actually stopped');

globalThis.fetch = realFetch;
globalThis.window = realWindow;

const out = 'artifacts/post-lv2/asr-tts-selection-20261004';
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/streaming-client-offline.json`, JSON.stringify({ kind: 'real player with a simulated Web Audio clock', checks,
  playbackReports: reports.map(({ segmentId, state, playedFrom, playedTo }) => ({ segmentId, state, playedFrom, playedTo })),
  pass: checks.length, fail: 0, browser_playback: 'NOT RUN by this test' }, null, 2));
console.log(JSON.stringify({ pass: checks.length, fail: 0 }));
