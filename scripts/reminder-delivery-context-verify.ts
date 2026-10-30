import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { createIntent, reserveOccurrence, advanceOccurrence, recentReminderDeliveries } from '../src/infrastructure/persistence/notification-store.ts'
import { readReminderDeliveryContext } from '../src/infrastructure/runtime/reminder-delivery-context.ts'
import { withReadScope, type ReadScope } from '../src/infrastructure/persistence/read-scope.ts'
import { reminderOccurrenceKey } from '../src/kernel/contracts/notification.ts'
import type { NotificationIntentId } from '../src/kernel/contracts/ids.ts'
import type { ChatChannel } from '../src/kernel/contracts/chat-channel.ts'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'

assert.equal(process.env.CHARACTER_DB_BACKEND, 'postgres', 'requires isolated PostgreSQL in serversim')
assert.match(new URL(process.env.LG_TEST_PG_URL!).pathname, /^\/lg_test_/)
isolateDatabase('reminder-delivery-context')
const h = await createM4Harness({ label: 'reminder-delivery-context' })
const now = Date.now()
const scope: ReadScope = { ownerUserId: h.userId, roomAuthorized: true, context: {
  principal: { kind: 'owner', userId: h.userId, verifiedBy: 'config_binding' },
  purpose: 'external_query', room: { kind: 'private', userId: h.userId },
} }
const input = { characterId: h.kernel.characterId, ownerRef: 'fixture-owner',
  conversationRef: String(h.recorder.conversationId), channel: 'qq_private' as ChatChannel, now }
try {
  const { event: request } = await h.recordUserEvidence('13:55提醒我签到')
  const seed = async (index: number, state: string, change: Partial<typeof input> = {}, at = now - 1000, repeatMode?: string) => {
    const data = { ...input, ...change }
    const { intent } = await createIntent(h.db, { id: `fixture-intent-${index}` as NotificationIntentId,
      characterId: data.characterId, ownerRef: data.ownerRef,
      conversationRef: data.conversationRef, deliveryChannel: data.channel, kind: 'reminder',
      sourceRefs: [String(request.id)], scheduledAt: at, timezone: 'Asia/Shanghai',
      permissionVersion: 'fixture', policyVersion: 'fixture', text: `fixture-reminder-${index}`,
      dedupeKey: `fixture-${index}`, now: at, repeatMode })
    assert.ok(intent)
    const key = reminderOccurrenceKey({ intentId: String(intent.id), planVersion: 1, dueAt: at })
    await reserveOccurrence(h.db, { occurrenceKey: key, intentId: intent.id, characterId: data.characterId,
      kind: 'reminder', dueAt: at, permissionVersion: 'fixture', policyVersion: 'fixture', now: at })
    const steps = ['evaluating', 'prepared', ...(state === 'prepared' ? [] : ['dispatching']),
      ...(['prepared', 'dispatching'].includes(state) ? [] : [state])]
    for (const to of steps) {
      assert.ok((await advanceOccurrence(h.db, key, { to: to as never, now: at,
        ...(to === 'prepared' ? { text: `fixture-reminder-${index}` } : {}),
        ...(to === 'api_accepted' ? { platformMessageId: `fixture-platform-${index}` } : {}) })).ok)
    }
  }
  await seed(1, 'api_accepted')
  await seed(2, 'failed_confirmed')
  await seed(3, 'delivery_unknown')
  await seed(4, 'prepared')
  await seed(5, 'api_accepted', { conversationRef: 'other-room' })
  await seed(6, 'api_accepted', { ownerRef: 'other-owner' })
  await seed(7, 'api_accepted', { channel: 'avatar' })
  await seed(8, 'api_accepted', {}, now - 86_400_001)
  await seed(9, 'dispatching')
  const read = () => readReminderDeliveryContext(h.db, input)
  assert.equal(await read(), undefined, 'missing scope cannot expose owner reminders')
  const facts = await withReadScope(scope, read)
  assert.ok(facts)
  for (const index of [1, 2, 3, 9]) assert.ok(facts.text.includes(`fixture-reminder-${index}`))
  for (const index of [4, 5, 6, 7, 8]) assert.ok(!facts.text.includes(`fixture-reminder-${index}`))
  for (const label of ['平台已接受发送', '确定发送失败', '发送结果不明', '正在投递', '不等于本人已读']) assert.ok(facts.text.includes(label))
  assert.equal(await withReadScope({ ...scope, context: { ...scope.context, room: { kind: 'group', groupId: 'fixture-group' } } }, read), undefined)
  assert.equal(await withReadScope({ ...scope, context: { ...scope.context,
    principal: { kind: 'user', userId: 'guest', verifiedBy: 'onebot_inbound' } } }, read), undefined)
  assert.equal(await withReadScope(scope, () => readReminderDeliveryContext(h.db, { ...input,
    withdrawn: { ok: true, withdrawnEventIds: [String(request.id)] } })), undefined)
  const denied = await withReadScope(scope, () => readReminderDeliveryContext(h.db, { ...input,
    withdrawn: { ok: false, withdrawnEventIds: [] } }))
  assert.ok(denied?.text.includes('不可用') && !denied.text.includes('fixture-reminder'))
  for (let index = 100; index < 112; index++) await seed(index, 'api_accepted', { conversationRef: 'limit-room' }, now - 10_000 + index)
  const bounded = await withReadScope(scope, () => readReminderDeliveryContext(h.db, { ...input, conversationRef: 'limit-room' }))
  assert.equal(bounded?.sourceRefs.length, 10, 'delivery view is bounded before entering the prompt')

  const sentAt = Date.now()
  await seed(20, 'api_accepted', {}, sentAt, 'until_reply')
  await seed(21, 'api_accepted', { conversationRef: 'other-room-ack' }, sentAt, 'until_reply')
  await seed(22, 'failed_confirmed', {}, sentAt, 'until_reply')
  const ackRows = (at: number, conversationRef = input.conversationRef) => recentReminderDeliveries(h.db, {
    ...input, now: at, conversationRef, withdrawnEventIds: [],
  })
  assert.ok((await ackRows(Date.now())).every(row => !row.stoppedByMessage), 'pre-delivery messages cannot confirm reminders')
  const { event: ack } = await h.recordUserEvidence('ok')
  const afterAck = await ackRows(Date.now())
  assert.equal(afterAck.find(row => row.text === 'fixture-reminder-20')?.stoppedByMessage, true,
    'any current owner reply confirms before the background scheduler updates the intent')
  assert.ok(afterAck.filter(row => row.text !== 'fixture-reminder-20').every(row => !row.stoppedByMessage),
    'once and failed deliveries cannot acquire until_reply confirmation')
  assert.ok((await ackRows(Number(ack.createdAt) - 1)).every(row => !row.stoppedByMessage), 'future messages cannot confirm')
  assert.ok((await ackRows(Date.now(), 'other-room-ack')).every(row => !row.stoppedByMessage), 'other-conversation messages cannot confirm')

  const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot, recorder: h.recorder, conversationSequence: h.nextTurnSequence,
    slowPathEnabled: false, userId: h.userId })
  const turn = await gateway.beginTurn('你不是刚刚发了吗？')
  const baseline = await gateway.compileTurn({ turn, currentInput: '你不是刚刚发了吗？', recentLines: [] })
  assert.ok(!baseline.sections.some(section => section.id === 'reminder-delivery'), 'negative control: the old chat-only path has no delivery facts')
  const packet = await withReadScope(scope, () => gateway.compileTurn({ turn,
    currentInput: '你不是刚刚发了吗？', recentLines: [],
    loadReminderDeliveryContext: () => readReminderDeliveryContext(h.db, input),
  } as Parameters<TurnGateway['compileTurn']>[0]))
  assert.ok(packet.sections.some(section => section.id === 'reminder-delivery'
    && section.content.includes('fixture-reminder-1')), 'actual compiled prompt must contain the sent reminder')
  const unavailable = await gateway.compileTurn({ turn, currentInput: '你不是刚刚发了吗？', recentLines: [],
    loadReminderDeliveryContext: async () => { throw new Error('fixture read failure') } })
  assert.ok(unavailable.sections.some(section => section.id === 'reminder-delivery' && section.content.includes('读取失败')))
  for (const text of ['那条提醒我发了，平台已接受发送。', '那条提醒我发过了，平台已接受发送。']) {
    assert.equal(runReplyGuardChain({ reminderResult: { kind: 'none' }, replyText: text }).replyText, text)
  }
  assert.equal(runReplyGuardChain({ reminderResult: { kind: 'none' }, replyText: '这条提醒我会发你，到点提醒你。' }).replyText, '这条提醒我会发你，到点提醒你。')
  if (process.argv.includes('--live')) {
    assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', 'only the explicit test endpoint is allowed')
    for (const [index, expected] of [[1, /平台|回执|受理|接受/u], [2, /失败|没发|未发|没能/u], [3, /不明|不确定|无法确认|不能确认|未知/u]] as const) {
      const response = await fetch(`${process.env.OPENAI_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.OPENAI_LARGE_MODEL, messages: [
          { role: 'system', content: packet.text }, { role: 'user', content: `fixture-reminder-${index} 那条，刚才到底发了吗？只依据投递记录回答。` },
        ], max_tokens: 600 }), signal: AbortSignal.timeout(90_000),
      })
      assert.ok(response.ok, `test model HTTP ${response.status}`)
      const data = await response.json() as { choices: { message: { content: string } }[] }
      const reply = data.choices[0]!.message.content
      console.log(JSON.stringify({ liveCase: index, reply }))
      assert.match(reply, expected, `live receipt-state case ${index}`)
      assert.doesNotMatch(reply, /(?:你|用户|本人)(?:已经|已)(?:读|查看)/u, 'no invented read receipt')
    }
  }
  await gateway.completeTurn({ turn, replyText: 'fixture reply' })
  const main = readFileSync('src/main.ts', 'utf8')
  assert.ok(main.includes('loadReminderDeliveryContext:') && main.includes('readReminderDeliveryContext('), 'main must wire the real reader')
  console.log(`PASS reminder delivery: scoped PostgreSQL read, receipt states, source masking and compiled prompt; model calls=${process.argv.includes('--live') ? 3 : 0}`)
} finally { await h.stop(); await resetPluginSqlConnection() }
