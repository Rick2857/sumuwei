import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { runPreparedPgGate } from './postgresql/test-harness.ts'
import { EntryShell, startCoexistHost } from './coexist/harness.ts'
import { recentConversationEvents } from '../src/infrastructure/persistence/conversation-store.ts'
import { asCharacterId, asConversationId } from '../src/kernel/contracts/ids.ts'
import type { ReminderResolutionInput } from '../src/kernel/app/reminder-turn.ts'

if (!process.env.LG_TEST_PG_URL) {
  await runPreparedPgGate('reminder-followup', 'scripts/reminder-followup-pg-verify.ts')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'lg-reminder-followup-'))
  const pool = new pg.Pool({ connectionString: process.env.LG_TEST_PG_URL })
  const dateText = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(Date.now() + 86_400_000).replace(/(\d+)\/(\d+)\/(\d+)/u, '$1年$2月$3日')
  let parserCalls = 0
  let finalSawOldImage = false
  let requestId = ''
  const model = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += String(part)
      const body = JSON.parse(raw || '{}')
      const instruction = String(body.messages?.[0]?.content ?? '')
      let content = '<response><text>普通聊天回复。</text></response>'
      if (instruction.includes('提醒请求解析器')) {
        parserCalls++
        const message = body.messages[1].content
        const input = JSON.parse(typeof message === 'string' ? message : message[0].text) as ReminderResolutionInput
        if (input.current.text.includes('稍后')) { requestId = input.current.id; content = JSON.stringify({ kind: 'clarify', question: '请发课表图片。' }) }
        else if (/虚假排期探针|之前的课表图片/u.test(input.current.text)) content = JSON.stringify({ kind: 'none' })
        else if (input.current.text.includes('不用管')) content = JSON.stringify({ kind: 'batch', repeat: 'once', items: input.pending.map(row => ({ operation: 'confirm', targetIntentId: row.id })) })
        else if (input.current.text.includes('必须回复')) content = JSON.stringify({ kind: 'batch', repeat: 'until_reply', items: input.pending.map(row => ({ operation: 'confirm', targetIntentId: row.id })) })
        else {
          const source = input.materials?.find(row => (row as unknown as { image: boolean }).image)
          assert.ok(source, 'image-only follow-up reaches resolver with original image')
          content = JSON.stringify({ kind: 'batch', repeat: 'until_reply', requestSourceId: requestId, items: [
            { operation: 'create', sourceId: source.id, dateText, timeText: '10:25', eventText: '高数', leadMinutes: 5, text: '记得签到。' },
            { operation: 'create', sourceId: source.id, dateText, timeText: '15:00', eventText: '会议', leadMinutes: 5, text: '记得签到。' },
          ] })
        }
      } else {
        if (raw.includes('之前的课表图片')) {
          finalSawOldImage = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))
          content = '<response><text>看到历史课表图片。</text></response>'
        }
        if (raw.includes('虚假排期探针')) content = '<response><text>课表的提醒已经排上了，13:55我发你。</text></response>'
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }))
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }
  })
  await new Promise<void>(done => model.listen(0, '127.0.0.1', done))
  const start = () => startCoexistHost({ dbDir: dir, modelPort: (model.address() as { port: number }).port, env: {
    CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: process.env.LG_TEST_PG_URL!, CHARACTER_THIN_HOST: 'on',
    PGLITE_DATA_DIR: dir, PROJECT_LG_SANDBOX: '', DATABASE_URL: '', CONVERSATION_LENGTH: '64',
    CHARACTER_QQ_PROACTIVE_MODE: 'on', CHARACTER_IMAGE_INPUT_ENABLED: 'true', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false',
    CHARACTER_RECALL_ENABLED: 'false',
  } })
  let host: Awaited<ReturnType<typeof start>> | undefined
  let shell: EntryShell | undefined
  try {
    host = await start(); await host.ready
    shell = new EntryShell(host.qqPort, host.qqToken); await shell.ready
    await shell.submit('request', '稍后给你发课表，每节课前5分钟QQ提醒我签到，我必须回复')
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
    const created = await shell.submitWithForgedFields('image-only', '[用户发送了图片]', { images: [{ dataUrl: png }] })
    assert.equal(created.replyText, '普通聊天回复。', 'main preserves the model response; saved reminders are checked below')

    let rows = (await pool.query("select * from notification_intents where kind='reminder' order by scheduled_at")).rows
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.repeat_mode === 'until_reply' && row.source_refs.includes(requestId)))
    const localTime = (time: string) => new Date(`${dateText.replace(/年|月/g, '-').replace(/日/g, '')}T${time}:00+08:00`).getTime()
    assert.equal(Number(rows[0].scheduled_at), localTime('10:20'))
    assert.equal(Number(rows[1].scheduled_at), localTime('14:55'))
    await shell.submit('confirm', '确认没问题')
    assert.equal((await pool.query('select count(*)::int as n from notification_intents')).rows[0].n, 2)
    const beforeRetries = parserCalls
    for (const text of ['再试一遍', '指第8周那张', '重新进行一次']) await shell.submit(`retry-${parserCalls}`, text)
    assert.equal(parserCalls, beforeRetries + 3, 'all keyword-free continuations reach the model through actual main')
    assert.equal((await pool.query('select count(*)::int as n from notification_intents')).rows[0].n, 2, 'model retry remains deduplicated')
    await shell.submit('once', '这些提醒不用管我有没有回复，发一次即可')
    assert.ok((await pool.query('select repeat_mode from notification_intents')).rows.every(row => row.repeat_mode === 'once'))
    await shell.submit('repeat', '这些提醒我必须回复，直到我回一句再停止')
    assert.ok((await pool.query('select repeat_mode from notification_intents')).rows.every(row => row.repeat_mode === 'until_reply'))
    const unexecuted = await shell.submit('no-write', '虚假排期探针')
    assert.equal(unexecuted.replyText, '课表的提醒已经排上了，13:55我发你。', 'no keyword rewrite when the resolver chooses none')
    assert.equal((await pool.query('select count(*)::int as n from notification_intents')).rows[0].n, 2, 'model wording cannot create a reminder')
    for (let i = 0; i < 34; i++) await shell.submit(`ordinary-${i}`, `普通消息${i}`)
    const latest = (await pool.query("select * from conversation_events where actor_type='user' order by sequence desc limit 1")).rows[0]
    const db = drizzle(pool) as never
    const images = await recentConversationEvents(db, { characterId: asCharacterId(latest.character_id), conversationId: asConversationId(latest.conversation_id), limit: 8, imagesOnly: true })
    assert.equal(images.length, 1, 'attachment lookup survives more than 64 text events')
    assert.equal((await recentConversationEvents(db, { characterId: asCharacterId(latest.character_id), conversationId: asConversationId('other-room'), limit: 8, imagesOnly: true })).length, 0)
    assert.equal((await recentConversationEvents(db, { characterId: asCharacterId(latest.character_id), limit: 8, imagesOnly: true })).length, 0)
    await shell.submit('old-image', '看看之前的课表图片里有什么')
    assert.ok(finalSawOldImage, 'real main model request includes image outside the 64-message text window')
    shell.close(); shell = undefined; assert.equal(await host.stop(), 0)
    host = await start(); await host.ready
    shell = new EntryShell(host.qqPort, host.qqToken); await shell.ready
    await shell.submit('restart-image', '看看之前的课表图片里有什么')
    assert.ok(finalSawOldImage)
    rows = (await pool.query('select * from notification_intents')).rows
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.repeat_mode === 'until_reply'))
    shell.close(); shell = undefined; assert.equal(await host.stop(), 0)
    const out = 'artifacts/post-lv2/local/qq-reminder-repair-20261020'
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'postgres-main.json'), JSON.stringify({ status: 'PASS', backend: 'postgres', parserCalls,
      reminders: rows.length, leadMinutes: 5, repeatMode: 'until_reply', textWindow: 64, imageBeyondTextWindow: true,
      restartReadback: true, crossConversationRejected: true, unexecutedClaimRejected: true,
      productionAccess: false, realModelCalls: 0, realQqSends: 0 }, null, 2))
    console.log('PASS PostgreSQL actual main: image-only continuation, inherited lead, repeat update, dedupe, model-owned wording, >64-message image reload, scoped lookup and restart')
  } catch (error) {
    console.error(host?.stdout.slice(-15).join('\n')); console.error(host?.stderr.slice(-15).join('\n')); throw error
  } finally {
    shell?.close(); if (host?.child.exitCode === null) { try { await host.stop() } catch { host.kill() } }
    await pool.end(); model.closeAllConnections(); await new Promise<void>(done => model.close(() => done()))
    assert.ok(dir.startsWith(join(tmpdir(), 'lg-reminder-followup-'))); rmSync(dir, { recursive: true, force: true })
  }
}
