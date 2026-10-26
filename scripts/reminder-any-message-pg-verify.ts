import assert from 'node:assert/strict'
import { drizzle } from 'drizzle-orm/node-postgres'
import { withPgTest, withPgTestInInstance, type PgInstanceTest } from './postgresql/test-harness.ts'
import { applyKernelMigrations } from '../src/infrastructure/persistence/db.ts'
import { createIntent, reserveOccurrence, advanceOccurrence, getIntent, lastInboundAt } from '../src/infrastructure/persistence/notification-store.ts'
import { createReminderScheduling } from '../src/infrastructure/runtime/reminder-scheduling.ts'
import { reminderOccurrenceKey } from '../src/kernel/contracts/notification.ts'
import { asCharacterId, type NotificationIntentId } from '../src/kernel/contracts/ids.ts'

const verify = async (test: PgInstanceTest) => {
  const db = drizzle(test.pool) as never
  await applyKernelMigrations(db)
  const characterId = asCharacterId('fixture-character')
  const base = Date.now() - 500
  let sequence = 0
  const message = async (conversation: string, content: string, at: number) => {
    sequence++
    await test.pool.query(`insert into conversation_events(id,character_id,conversation_id,sequence,conversation_sequence,type,actor_type,actor_id,content,schema_version,created_at)
      values($1,$2,$3,$4,$4,'user_message','user','fixture-owner',$5,1,$6)`, [`event-${sequence}`,characterId,conversation,sequence,content,at])
  }
  for (const [index, mode] of ['ok', '普通聊天', '[用户发送了图片]', 'before', 'foreign', 'none'].entries()) {
    const id = `intent-${index}` as NotificationIntentId
    const conversation = `room-${index}`
    await createIntent(db, { id, characterId, ownerRef: 'fixture-owner', conversationRef: conversation, kind: 'reminder',
      sourceRefs: ['fixture-request'], scheduledAt: base, timezone: 'Asia/Shanghai', permissionVersion: 'fixture', policyVersion: 'fixture',
      text: '课程签到', dedupeKey: `key-${index}`, deliveryChannel: 'qq_private', repeatMode: 'until_reply' })
    const key = reminderOccurrenceKey({ intentId: id, planVersion: 1, dueAt: base })
    assert.ok((await reserveOccurrence(db, { occurrenceKey: key, intentId: id, characterId, kind: 'reminder', dueAt: base,
      permissionVersion: 'fixture', policyVersion: 'fixture', now: base })).created)
    for (const to of ['evaluating','prepared','dispatching','api_accepted'] as const) {
      assert.ok((await advanceOccurrence(db,key,{to,...(to==='prepared'?{text:'课程签到'}:{}),...(to==='api_accepted'?{platformMessageId:'fixture-message'}:{}),now:base+100})).ok)
    }
    const scheduling = createReminderScheduling({ db, characterId, channels:['qq_private'],
      registry: () => ({currentGeneration:()=>1}) as never, execute:async()=>{throw new Error('acknowledged reminder must not dispatch')}, reading:()=>{},
      lastInboundAt: async intent => (await lastInboundAt(db,characterId,intent?.conversationRef)) ?? 0 })
    const armed = (await scheduling.listPendingReminders()).find(row=>row.occurrenceKey.includes(id))!
    assert.ok(armed,'next repeat is armed before the owner replies')
    if(mode!=='none') await message(mode==='foreign'?'other-room':conversation,mode,mode==='before'?base-100:base+200)
    if(index<3) {
      // A timer was already queued before this arbitrary inbound message.
      await scheduling.onReminderDue(armed)
      assert.equal((await getIntent(db,id))?.status,'delivered',mode)
      assert.ok(!(await scheduling.listPendingReminders()).some(row=>row.occurrenceKey.includes(id)),mode)
    } else {
      await scheduling.listPendingReminders()
      assert.equal((await getIntent(db,id))?.status,'pending',mode)
    }
  }
  console.log('PASS PostgreSQL: arbitrary text/image acknowledges already-armed repeat; pre-delivery, foreign-room and missing messages do not acknowledge')
}

const adminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
if (adminUrl) await withPgTestInInstance(adminUrl, 'any-message', verify)
else await withPgTest('any-message', verify)
