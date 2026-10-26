import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EntryShell, startCoexistHost, delay } from './coexist/harness.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import type { ReminderResolutionInput } from '../src/kernel/app/reminder-turn.ts'
import { drizzle } from 'drizzle-orm/pglite'
import { getIntent, revisePendingReminder } from '../src/infrastructure/persistence/notification-store.ts'
import type { RawDb } from '../src/infrastructure/persistence/db.ts'

// The fixture must never inherit production PostgreSQL settings from dotenv in its child.
process.env.CHARACTER_DB_BACKEND = 'pglite'
process.env.POSTGRES_URL = ''
for (const key of ['LG_PG_EXPECT_DATABASE', 'LG_PG_EXPECT_USER', 'LG_PG_EXPECT_DATABASE_PREFIX', 'LG_PG_EXPECT_USER_PREFIX', 'LG_PG_EXPECT_ADDR', 'LG_PG_EXPECT_PORT']) process.env[key] = ''
const sandbox = isolateDatabase('reminder-planning-main', { keep: true })
const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now() + 86_400_000)
const dateText = date.replace(/(\d+)\/(\d+)\/(\d+)/u, '$1年$2月$3日')
let imageCalls = 0
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  const data = JSON.parse(body || '{}')
  const instruction = String(data.messages?.[0]?.content ?? '')
  let content = '你好。'
  if (instruction.includes('提醒请求解析器')) {
    const message = data.messages[1].content
    const parsed = JSON.parse(typeof message === 'string' ? message : message[0].text) as ReminderResolutionInput
    const text = parsed.current.text
    let draft: unknown
    if (text.includes('查看')) draft = { kind: 'list' }
    else if (text.includes('取消第二')) draft = { kind: 'batch', items: [{ operation: 'cancel', targetIntentId: parsed.pending.at(-1)?.id }] }
    else if (text.includes('改到')) draft = { kind: 'batch', items: [{ operation: 'reschedule', targetIntentId: parsed.pending[0]?.id, sourceId: parsed.current.id, timeText: '12秒后' }] }
    else {
      assert.ok(Array.isArray(message) && message.some((item: { type: string }) => item.type === 'image_url'), '原图必须进入提醒解析请求')
      const sourceId = parsed.materials?.find(item => (item as unknown as { image: boolean }).image)?.id
      assert.ok(sourceId); imageCalls++
      draft = { kind: 'batch', items: [
        { operation: 'create', sourceId, timeText: `${dateText} 10:00`, leadMinutes: 5, text: '英语课签到。' },
        { operation: 'create', sourceId, timeText: `${dateText} 15:00`, leadMinutes: 5, text: '会议签到。' },
      ] }
    }
    content = JSON.stringify(draft)
  }
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content } }] }))
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const env = { CHARACTER_QQ_PROACTIVE_MODE: 'on', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false', CHARACTER_IMAGE_INPUT_ENABLED: 'true',
  CHARACTER_DB_BACKEND: 'pglite', POSTGRES_URL: '', LG_PG_EXPECT_DATABASE: '', LG_PG_EXPECT_USER: '', LG_PG_EXPECT_DATABASE_PREFIX: '', LG_PG_EXPECT_USER_PREFIX: '' }
const start = () => startCoexistHost({ dbDir: sandbox.dir, modelPort: (server.address() as { port: number }).port, env })
let host: Awaited<ReturnType<typeof start>> | undefined
let shell: EntryShell | undefined
let stopped = true
let dispatchAt = 0
const turns: unknown[] = []
let readback: unknown
try {
  host = await start(); stopped = false; await host.ready
  shell = new EntryShell(host.qqPort, host.qqToken); await shell.ready
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  await shell.submitWithForgedFields('image', '这是我的本周安排。', { images: [{ dataUrl: png }] })
  const result = await shell.submit('batch', '按这张安排中所有事件，分别提前5分钟通过QQ提醒我签到')
  turns.push(result); assert.match(JSON.stringify(result), /英语课签到.*已设置[\s\S]*会议签到.*已设置/u); assert.equal(imageCalls, 1)
  const repeated = await shell.submit('duplicate', '按这张安排中所有事件，分别提前5分钟通过QQ提醒我签到')
  turns.push(repeated); assert.match(JSON.stringify(repeated), /英语课签到.*已存在[\s\S]*会议签到.*已存在/u)
  turns.push(await shell.submit('move', '把第一条提醒改到12秒后'))
  turns.push(await shell.submit('cancel', '取消第二条提醒'))
  turns.push(await shell.submit('list', '查看提醒'))
  assert.match(JSON.stringify(turns.at(-1)), /待发送提醒共1条/u)
  shell.close(); shell = undefined; assert.equal(await host.stop(), 0); stopped = true

  const before = await openRawPGlite(sandbox.dir)
  try {
    const rows = (await before.query('select id, status, scheduled_at, source_refs, plan_version from notification_intents order by created_at')).rows as Record<string, any>[]
    assert.equal(rows.length, 2); assert.equal(rows.filter(row => row.status === 'cancelled').length, 1)
    const active = rows.find(row => row.status === 'pending')!
    dispatchAt = Number(active.scheduled_at)
    assert.equal(Number(active.plan_version), 2)
    const store = drizzle(before as never) as unknown as RawDb
    const target = await getIntent(store, active.id)
    assert.ok(target)
    assert.equal(await revisePendingReminder(store, { ...target, planVersion: target.planVersion - 1 }, { dueAt: dispatchAt + 60_000 }), false, '旧版本不能覆盖新排期')
    assert.equal(await revisePendingReminder(store, { ...target, ownerRef: 'other-user' }, { cancel: true }), false, '其他用户不能取消')
    assert.equal(await revisePendingReminder(store, { ...target, conversationRef: 'other-room' }, { cancel: true }), false, '其他会话不能取消')
    assert.equal(Number((await getIntent(store, active.id))!.scheduledAt), dispatchAt, '负控不得修改排期')
    assert.ok(rows.every(row => JSON.stringify(row.source_refs).includes('image:sha256:')), '每条建单必须保留真实原图引用')
    assert.ok(rows.every(row => row.source_refs.length >= 3), '改期和取消须保留后续授权消息引用')
  } finally { await before.close() }

  host = await start(); stopped = false; await host.ready
  shell = new EntryShell(host.qqPort, host.qqToken); await shell.ready
  const deadline = Date.now() + 20_000
  const delivered = () => shell!.protocolLines.map(line => JSON.parse(line)).filter(row => row.kind === 'DELIVER_QQ_TEXT' && row.outcome === 'generated')
  while (!delivered().length && Date.now() < deadline) await delay(50)
  assert.equal(delivered().length, 1, host.stdout.slice(-15).join('\n'))
  assert.ok(Date.now() >= dispatchAt, '不得提前投递')
  const message = delivered()[0]!
  await shell.control(String(message.requestId), 'REPORT_QQ_DELIVERY', { deliveryId: message.requestId, deliveryStatus: 'api_accepted', messageId: 'fixture-accepted' }, 'DELIVER_QQ_TEXT')
  await delay(300); assert.equal(delivered().length, 1)
  shell.close(); shell = undefined; assert.equal(await host.stop(), 0); stopped = true
  const db = await openRawPGlite(sandbox.dir)
  try {
    const rows = (await db.query('select state from notification_occurrences')).rows
    assert.equal(rows.length, 1); assert.equal(rows[0]?.state, 'api_accepted')
    readback = rows
  } finally { await db.close() }
} finally {
  shell?.close()
  if (host && !stopped) await host.stop()
  await new Promise<void>(done => server.close(() => done()))
  const out = resolve('artifacts/post-lv2/reminder-planning', `main-${Date.now()}`)
  mkdirSync(out, { recursive: true }); writeFileSync(resolve(out, 'evidence.json'), JSON.stringify({ turns, imageCalls, readback,
    database: sandbox.dir, model: 'offline fixture', delivery: 'simulated QQ API acceptance; real receipt NOT RUN' }, null, 2))
}
console.log('Reminder planning main: image continuity, batch, dedupe, scoped edits, restart and due delivery PASS')
