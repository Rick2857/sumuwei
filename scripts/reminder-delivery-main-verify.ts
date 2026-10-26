import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { EntryShell, startCoexistHost } from './coexist/harness.ts'
import { createIntent, reserveOccurrence, advanceOccurrence } from '../src/infrastructure/persistence/notification-store.ts'
import { reminderOccurrenceKey } from '../src/kernel/contracts/notification.ts'
import { asCharacterId, type NotificationIntentId } from '../src/kernel/contracts/ids.ts'

assert.equal(process.env.CHARACTER_DB_BACKEND, 'postgres')
const sandbox = isolateDatabase('reminder-delivery-main')
const prompts: string[] = []
const reminderText = 'fixture-main-reminder：军事理论：上课前记得签到；提醒发出后，发任意消息即可确认并停止本次续发。'
const server = createServer(async (request, response) => {
  let body = ''
  for await (const part of request) body += String(part)
  prompts.push(body)
  response.writeHead(200, { 'Content-Type': 'application/json' })
  const text = body.includes('fixture-main-reminder')
    ? '那条提醒我发了，平台已接受发送；是否已读还不能确认。' : '嗯，知道了。'
  response.end(JSON.stringify({ choices: [{ message: { content: `<response><text>${text}</text></response>` } }] }))
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const pool = new pg.Pool({ connectionString: process.env.LG_TEST_PG_URL })
const db = drizzle(pool) as never
const host = await startCoexistHost({ dbDir: sandbox.dir, modelPort: (server.address() as { port: number }).port,
  env: { CHARACTER_QQ_PROACTIVE_MODE: 'off', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false' } })
let qq: EntryShell | undefined
let avatar: EntryShell | undefined
try {
  await host.ready
  qq = new EntryShell(host.qqPort, host.qqToken)
  await qq.ready
  assert.equal((await qq.submit('baseline', '在吗')).outcome, 'replied')
  const source = (await pool.query("select id,character_id,conversation_id from conversation_events where actor_type='user' order by sequence desc limit 1")).rows[0]
  assert.ok(source)
  const at = Date.now() - 10
  const { intent } = await createIntent(db, { id: 'fixture-main-delivery' as NotificationIntentId,
    characterId: asCharacterId(source.character_id), ownerRef: '123456789', conversationRef: source.conversation_id,
    deliveryChannel: 'qq_private', kind: 'reminder', repeatMode: 'until_reply', sourceRefs: [source.id], scheduledAt: at,
    timezone: 'Asia/Shanghai', permissionVersion: 'fixture', policyVersion: 'fixture',
    dedupeKey: 'fixture-main-delivery', text: reminderText, now: at })
  assert.ok(intent)
  const key = reminderOccurrenceKey({ intentId: String(intent.id), planVersion: 1, dueAt: at })
  await reserveOccurrence(db, { occurrenceKey: key, intentId: intent.id, characterId: intent.characterId,
    kind: 'reminder', dueAt: at, permissionVersion: 'fixture', policyVersion: 'fixture', now: at })
  for (const to of ['evaluating', 'prepared', 'dispatching', 'api_accepted'] as const) assert.ok((await advanceOccurrence(db, key, {
    to, now: at, ...(to === 'prepared' ? { text: reminderText } : {}),
    ...(to === 'api_accepted' ? { platformMessageId: 'fixture-main-platform' } : {}),
  })).ok)
  prompts.length = 0
  const reply = await qq.submit('after-receipt', 'ok')
  assert.equal(reply.outcome, 'replied')
  assert.ok(String(reply.replyText).includes('平台已接受发送'), 'past reminder report must survive the ordinary reply guards')
  assert.ok(prompts.some(text => text.includes('fixture-main-reminder') && text.includes('平台已接受发送')), 'real main prompt must include the accepted reminder')
  assert.ok(prompts.some(text => text.includes('本次提醒已确认、无需再回复')), 'the current owner message must confirm until_reply before the scheduler updates the intent')
  assert.equal((await pool.query('select status from notification_intents where id=$1', [intent.id])).rows[0].status,
    'pending', 'confirmation context must not depend on or mutate the scheduler status')
  if (process.env.DSH_TEST_MODEL_WRAPPER === '1') {
    const actual = JSON.parse(prompts.find(text => text.includes('fixture-main-reminder'))!)
    const response = await fetch(`${process.env.OPENAI_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_LARGE_MODEL, messages: actual.messages, max_tokens: 1200 }),
      signal: AbortSignal.timeout(60_000),
    })
    assert.ok(response.ok, `test model HTTP ${response.status}`)
    const data = await response.json() as { choices: { message: { content: string } }[] }
    const text = data.choices[0]!.message.content
    console.log(JSON.stringify({ liveCase: 'owner-ok-before-scheduler', reply: text }))
    assert.doesNotMatch(text, /(?:看到|收到|收到了|看到了|看见|看见了|到了)[^。！？\n]{0,12}(?:回一句|回一声|再回|回复|告诉我)|(?:确认|回一句|回一声)[^。！？\n]{0,12}(?:收到|收到了|看到了)|别让我不知道你收没收到/u)
    assert.doesNotMatch(text, /(?:你|用户|本人)(?:已经|已)(?:签到|完成签到)/u)
  }
  prompts.length = 0
  avatar = new EntryShell(host.avatarPort, host.avatarToken)
  await avatar.ready
  assert.equal((await avatar.submit('other-channel', '在吗')).outcome, 'replied')
  assert.ok(prompts.length > 0 && prompts.every(text => !text.includes('fixture-main-reminder')), 'avatar must not inherit the QQ receipt')
  const persisted = (await pool.query("select count(*)::int as n from conversation_events where content like '%fixture-main-reminder%'")).rows[0].n
  assert.equal(persisted, 0, 'delivery context must not create fabricated chat/cognition events')
  console.log('PASS real main: QQ prompt sees platform receipt and reminder text; avatar isolation; no fabricated chat history')
} catch (error) {
  console.error(host.stdout.slice(-12).join('\n'), host.stderr.slice(-12).join('\n'))
  throw error
} finally {
  qq?.close(); avatar?.close()
  if (host.child.exitCode === null) await host.stop()
  await pool.end()
  server.closeAllConnections(); server.close()
}
