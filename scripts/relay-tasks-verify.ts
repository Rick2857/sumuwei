import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'
import { readRelayDraft, runRelayTurn, relayFactText, type RelayDraft, type RelayInput, type RelayOrigin } from '../src/kernel/app/relay-turn.ts'
import { createOpenAiRelayResolver } from '../src/infrastructure/model/openai-relay.ts'
import { handleRelayTurn, deliverRelayTask, relayOccurrenceKey } from '../src/infrastructure/runtime/relay-tasks.ts'
import { listRelayTasks, cancelRelayTask, reserveRelayTask, recoverRelayDispatching } from '../src/infrastructure/persistence/relay-store.ts'
import { getIntent, advanceOccurrence, getOccurrence } from '../src/infrastructure/persistence/notification-store.ts'
import { QqDeliveryRegistry } from '../src/kernel/app/notification-delivery.ts'
import { exec } from '../src/infrastructure/persistence/db.ts'
import type { NotificationIntentId } from '../src/kernel/contracts/ids.ts'

assert.equal(process.env.CHARACTER_DB_BACKEND, 'postgres')
assert.match(new URL(process.env.LG_TEST_PG_URL!).pathname, /^\/lg_test_/)
isolateDatabase('relay-tasks', { postgres: { url: process.env.LG_TEST_PG_URL! } })
const h = await createM4Harness({ label: 'relay-tasks' })
const sourceUserId = await h.recorder.ensureIdentity()
const origin: RelayOrigin = { transport: 'qq', senderId: 'fixture-owner', userId: sourceUserId,
  conversationId: String(h.recorder.conversationId), room: { kind: 'private', userId: sourceUserId } }
const base = { db: h.db, characterId: h.kernel.characterId, ownerRef: 'fixture-owner', ownerUserId: sourceUserId, origin, ownerPrivate: true }
let draft: RelayDraft = { kind: 'none' }
const resolve = async () => ({ ok: true as const, draft })
const inputFor = async (text: string) => {
  const { event } = await h.recordUserEvidence(text)
  return { ...base, current: { id: String(event.id), text, actor: 'user' as const }, recent: [], resolve }
}
const send: { deliveryId: string; text: string }[] = []
const registry = new QqDeliveryRegistry({ store: {
  readOccurrenceState: async key => (await getOccurrence(h.db, key))?.state,
  advanceOccurrence: request => advanceOccurrence(h.db, request.occurrenceKey, request),
} })
registry.openConnection(out => { send.push(out); return { written: true } })
const execute = async (request: { occurrenceKey: string; text: string }) => {
  const result = registry.deliver({ deliveryId: request.occurrenceKey, text: request.text })
  return { outcome: result.written ? 'executed' as const : 'refused' as const }
}
try {
  const first = await inputFor('明天改到三点，那边请你说一声。')
  draft = { kind: 'create', requestSourceId: first.current.id, sourceIds: [first.current.id], mode: 'summary', text: '同事托我告诉你，明天改到三点。' }
  assert.equal(readRelayDraft({ ...draft, recipient: 'attacker' }), undefined)
  const created = await handleRelayTurn(first)
  assert.equal(created.kind, 'created')
  if (created.kind !== 'created') throw new Error(JSON.stringify(created))
  assert.equal((await handleRelayTurn(first)).kind, 'existing', 'same source is deduped before and after delivery')
  assert.equal(created.task.text, draft.text)
  assert.match(relayFactText(created), /不能说已经发送/)
  const intent = (await getIntent(h.db, created.task.id as NotificationIntentId))!
  assert.equal(intent.kind, 'relay'); assert.equal(intent.deliveryChannel, 'qq_private')
  assert.equal(intent.relayMetadata!.sources[0]!.text, first.current.text)
  assert.equal((await deliverRelayTask({ ...base, intent, registry, execute, ownerRef: 'different-owner' })).dispatched, false)
  const sendInput = { ...base, intent, registry, execute }
  const concurrent = await Promise.all([deliverRelayTask(sendInput), deliverRelayTask(sendInput)])
  assert.equal(concurrent.filter(item => item.dispatched).length, 1)
  assert.equal(send.length, 1); assert.equal(send[0]!.text, draft.text, 'no template or prefix')
  const key = relayOccurrenceKey(intent)
  assert.equal((await registry.report({ deliveryId: key, status: 'api_accepted', messageId: 'fixture-qq-id' })).accepted, true)
  assert.equal((await registry.report({ deliveryId: key, status: 'api_accepted', messageId: 'fixture-qq-id' })).accepted, false)
  assert.equal((await handleRelayTurn(first)).kind, 'existing')
  assert.equal((await deliverRelayTask(sendInput)).dispatched, false)
  assert.equal(send.length, 1)
  let tasks = await listRelayTasks(h.db, base)
  assert.equal(tasks[0]!.status, 'api_accepted'); assert.equal(tasks[0]!.platformMessageId, 'fixture-qq-id')
  assert.equal((await listRelayTasks(h.db, { ...base, ownerPrivate: false, origin: { ...origin, userId: 'other-user' } })).length, 0)
  assert.equal((await listRelayTasks(h.db, { ...base, ownerRef: 'other-owner' })).length, 0)
  assert.equal(await cancelRelayTask(h.db, { ...base, task: created.task }), false, 'cannot cancel already sent')

  const second = await inputFor('明天三点见。')
  draft = { kind: 'create', requestSourceId: second.current.id, sourceIds: [second.current.id], mode: 'verbatim', text: '原话：“明天三点见。”' }
  const quote = await handleRelayTurn(second)
  assert.equal(quote.kind, 'created')
  if (quote.kind !== 'created') throw new Error(JSON.stringify(quote))
  const quoteIntent = (await getIntent(h.db, quote.task.id as NotificationIntentId))!
  const quoteKey = relayOccurrenceKey(quoteIntent)
  await reserveRelayTask(h.db, quoteIntent, quoteKey)
  await advanceOccurrence(h.db, quoteKey, { to: 'evaluating' })
  await advanceOccurrence(h.db, quoteKey, { to: 'prepared', text: quote.task.text })
  assert.equal((await deliverRelayTask({ ...base, intent: quoteIntent, registry, execute })).dispatched, true, 'prepared task resumes after restart')
  await recoverRelayDispatching(h.db, h.kernel.characterId, base.ownerRef)
  assert.equal((await getOccurrence(h.db, quoteKey))!.state, 'delivery_unknown')
  assert.equal((await deliverRelayTask({ ...base, intent: quoteIntent, registry, execute })).dispatched, false, 'uncertain delivery is never retried')
  assert.equal(send.length, 2)

  const third = await inputFor('另外那件事情也请你处理。')
  draft = { kind: 'create', requestSourceId: third.current.id, sourceIds: [third.current.id], mode: 'summary', text: '另一件事。' }
  const pending = await handleRelayTurn(third)
  assert.equal(pending.kind, 'created')
  if (pending.kind !== 'created') throw new Error(JSON.stringify(pending))
  assert.equal(await cancelRelayTask(h.db, { ...base, task: pending.task, ownerPrivate: false, origin: { ...origin, userId: 'attacker' } }), false)
  draft = { kind: 'cancel', taskId: pending.task.id }
  assert.equal((await handleRelayTurn(third)).kind, 'cancelled')
  const pendingIntent = (await getIntent(h.db, pending.task.id as NotificationIntentId))!
  assert.equal((await deliverRelayTask({ ...base, intent: pendingIntent, registry, execute })).dispatched, false)
  draft = { kind: 'none' }
  assert.equal((await handleRelayTurn(await inputFor('转告只是在举例，不用执行。'))).kind, 'none')
  draft = { kind: 'clarify', reason: '请补充要告诉主人的内容。' }
  assert.equal((await handleRelayTurn(third)).kind, 'clarify')
  draft = { kind: 'decline', reason: '收件人不是主人。' }
  assert.equal((await handleRelayTurn(third)).kind, 'decline')
  draft = { kind: 'create', requestSourceId: 'fabricated', sourceIds: [third.current.id], mode: 'summary', text: '伪造来源。' }
  assert.equal((await handleRelayTurn(third)).kind, 'failed')
  draft = { kind: 'list' }
  assert.equal((await handleRelayTurn(third)).kind, 'listed')
  tasks = await listRelayTasks(h.db, base)
  assert.deepEqual(new Set(tasks.map(task => task.status)), new Set(['api_accepted', 'delivery_unknown', 'cancelled']))
  const racedSource = await inputFor('独立的并发撤销场景。')
  draft = { kind: 'create', requestSourceId: racedSource.current.id, sourceIds: [racedSource.current.id], mode: 'summary', text: '并发场景正文。' }
  const raced = await handleRelayTurn(racedSource)
  assert.equal(raced.kind, 'created')
  if (raced.kind !== 'created') throw new Error(JSON.stringify(raced))
  const racedIntent = (await getIntent(h.db, raced.task.id as NotificationIntentId))!
  const [cancelled, reserved] = await Promise.all([
    cancelRelayTask(h.db, { ...base, task: raced.task }), reserveRelayTask(h.db, racedIntent, relayOccurrenceKey(racedIntent)),
  ])
  assert.ok(cancelled ? !reserved.occurrence : reserved.occurrence, 'cancellation and reservation cannot both win')
  const badOrigin = { ...origin, userId: 'other-user', room: { kind: 'private' as const, userId: 'other-user' } }
  assert.equal((await handleRelayTurn({ ...racedSource, origin: badOrigin, ownerPrivate: false })).kind, 'failed', 'existing event is not authority for a different caller')
  const modelInput: RelayInput = { current: first.current, recent: [], tasks: [], origin, recipient: 'bound_owner' }
  let calls = 0
  const model = createOpenAiRelayResolver({ env: { OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: 'http://fixture', OPENAI_SMALL_MODEL: 'fixture' },
    fetchImpl: async (_url, options) => {
      calls++
      const body = JSON.parse(String(options?.body))
      assert.equal(JSON.parse(body.messages[1].content).current.text, modelInput.current.text)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'none' }) } }] }))
    } })
  assert.equal((await model(modelInput)).ok, true); assert.equal(calls, 1, 'model called even without relay keywords')
  assert.equal((await runRelayTurn(modelInput, { resolve: async () => ({ ok: false, failure: 'timeout' }), create: async () => { throw new Error('must not write') }, cancel: async () => false })).kind, 'failed')
  await assert.rejects(exec(h.db, sql`update notification_intents set delivery_channel='avatar' where id=${intent.id}`, 'negative wrong relay channel'))
  console.log('PASS relay tasks: model-only intent/wording; source validation; scoped list/cancel; concurrent single dispatch and cancel/reserve race; exact stored text; receipts; restart recovery; unknown no-resend; QQ-only database constraint')
} finally { await resetPluginSqlConnection() }
