/** Read-only decision contracts and shared QQ transport priority; no real account/model/database. */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { assessGroupReply } from '../src/kernel/app/bridge/group-reply.ts'
import { TurnBridge, handleBridgeMessage, type BridgeSubmitRequest, type BridgeWireResponse } from '../src/kernel/app/bridge/turn-bridge.ts'
import { runBridgeTransport } from '../src/infrastructure/bridge/turn-bridge-transport.ts'

const request: BridgeSubmitRequest = { requestId: 'decision-test', userText: '今天心情很好', platformFacts: {
  transport: 'wechat', selfId: 'wxid_bot', senderUserId: 'wxid_alice', messageType: 'group', groupId: '111@chatroom', messageId: 'a'.repeat(64) },
  groupContext: [{ senderId: 'wxid_bob', text: '苏沐薇刚才说的挺有意思', at: Date.now() }] }
let checks = 0
for (const [raw, expected] of [['{"reply":true}', true], ['{"reply":false}', false], ['{"reply":"true"}', false],
  ['{"reply":true,"text":"绕过LG"}', false], ['[]', false], ['not JSON', false]] as const) {
  const decision = await assessGroupReply({ identity: '真实种子人格', request, model: { id: 'fixture', endpointHost: 'loopback',
    invoke: async input => { assert(input.instruction.startsWith('真实种子人格')); assert.equal(input.timeoutMs, 5000);
      assert.equal(JSON.parse(input.briefing).current.text, request.userText); return { ok: true, raw } } } })
  assert.equal(decision.reply, expected); checks++
}
const failed = await assessGroupReply({ identity: 'seed', request, model: { id: 'fixture', endpointHost: 'loopback', invoke: async () => ({ ok: false, failure: 'timeout' }) } })
assert.equal(failed.code, 'group_reply_timeout'); assert.equal(failed.reply, false); checks++

let formal = 0, assessed = 0
let release!: () => void
const slow = new Promise<void>(done => { release = done })
const bridge = new TurnBridge({ host: {
  characterId: 'char_decision', conversationId: 'decision-session',
  runTurn: async () => { formal++; return { replyText: 'checked QQ reply', replyId: 'reply-1', traceId: 'trace-1', domainEventIds: [] } },
  assessGroupReply: async () => { assessed++; await slow; return { reply: false, code: 'group_reply_silent' } },
} })
const malformed = await handleBridgeMessage(bridge, { kind: 'ASSESS_GROUP_REPLY', ...request, groupContext: [{ senderId: 'fake', text: 'x'.repeat(6001), at: Date.now() }] })
assert.equal(malformed.outcome, 'rejected'); assert.equal(assessed, 0); checks++
const out: BridgeWireResponse[] = []
const running = runBridgeTransport(bridge, {
  read: async function* () {
    yield JSON.stringify({ kind: 'ASSESS_GROUP_REPLY', ...request })
    yield JSON.stringify({ kind: 'ASSESS_GROUP_REPLY', ...request, requestId: 'second-decision' })
    yield JSON.stringify({ kind: 'SUBMIT_TURN', requestId: 'qq-foreground', userText: 'hello' })
    for (let i=0; i<100 && !out.some(r => r.requestId === 'qq-foreground'); i++) await delay(5)
    assert.equal(formal, 1); assert.equal(assessed, 1)
    assert(out.some(r => r.requestId === 'second-decision' && r.code === 'group_reply_busy'))
    assert(!out.some(r => r.requestId === request.requestId)); checks++
    release()
  }, write: line => { out.push(JSON.parse(line)) },
})
await running
assert(out.some(r => r.kind === 'GROUP_REPLY_DECISION' && r.groupReply?.reply === false))
assert.equal(formal, 1); checks++
console.log(`PASS ${checks} WeChat decision checks: strict JSON, no reply bypass, failure silence, bounded model, QQ foreground progresses during assessment`)
