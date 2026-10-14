import test from 'node:test';
import assert from 'node:assert/strict';
import { lgSession } from './lg-session.mjs';

test('LG gates generation, correction cancels old speech, cancellation blocks old completion', async () => {
  const events = [], sent = [], turns = [], cancelled = [];
  let finish, resets = 0;
  const session = lgSession({ send: e => events.push(e), sendProvider: e => sent.push(e), resetProvider: () => resets++,
    core: { submit: (text, id) => { turns.push({ text, id }); return new Promise(r => finish = r); }, cancel: async id => cancelled.push(id) } });
  session.command({ type: 'text', text: '请记住我的名字' });
  assert.equal(turns.length, 1);
  assert.equal(sent.some(e => e.type === 'response.create'), false);
  const request = { prompt: 'LG authoritative context', phase: 'generate' };
  const response = session.reply(request, new AbortController().signal);
  assert.equal(sent.at(-1).type, 'session.update');
  const instructions = sent.at(-1).session.instructions;
  session.event({ type: 'session.updated', session: { instructions } });
  assert.equal(sent.at(-1).type, 'response.create');
  session.event({ type: 'response.created', response: { id: 'r1' } });
  assert.equal(session.event({ type: 'response.audio.delta', response_id: 'old', delta: 'x' }), false);
  session.event({ type: 'response.audio_transcript.delta', response_id: 'r1', delta: '我记住了' });
  session.event({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  assert.equal((await response).text, '我记住了');
  const correction = session.reply({ ...request, phase: 'correct', checkedText: '未写入' }, new AbortController().signal);
  assert.equal(events.at(-1).type, 'prototype.correction');
  assert.equal(events.at(-1).response_id, 'r1');
  session.command({ type: 'interrupt' });
  await assert.rejects(correction, /cancelled/);
  assert.equal(resets, 1); assert.equal(cancelled[0], turns[0].id);
  assert.equal(session.event({ type: 'response.created', response: { id: 'late' } }), false);
  finish({ outcome: 'replied' }); await new Promise(r => setImmediate(r));
  assert.equal(events.some(e => e.type === 'lg.turn_result'), false);
});

test('manual audio ASR enters LG once, never bypasses context and tools', async () => {
  const sent = [], inputs = [];
  const session = lgSession({ send: () => {}, sendProvider: e => sent.push(e), resetProvider: () => {},
    core: { submit: async text => { inputs.push(text); return { outcome: 'replied' }; }, cancel: async () => {} } });
  session.command({ type: 'audio_commit' }); assert.equal(sent.length, 0);
  session.command({ type: 'audio', audio: Buffer.alloc(6400).toString('base64') });
  session.command({ type: 'audio_commit' }); session.command({ type: 'audio_commit' });
  assert.equal(sent.filter(e => e.type === 'input_audio_buffer.commit').length, 1);
  const asr = { type: 'conversation.item.input_audio_transcription.completed', transcript: '你好 GitHub' };
  session.event(asr); session.event(asr);
  assert.deepEqual(inputs, ['你好 GitHub']);
  assert.equal(sent.some(e => e.type === 'response.create'), false);
});
