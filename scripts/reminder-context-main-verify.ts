import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EntryShell, startCoexistHost } from './coexist/harness.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import type { ReminderResolutionInput } from '../src/kernel/app/reminder-turn.ts'

const live = process.argv.includes('--live')
if (live) assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', '真模型必须经过 with-test-model')

const sandbox = isolateDatabase('reminder-context-main', { keep: true })
const calls: { instruction: string; input: string }[] = []
const turns: Record<string, unknown>[] = []
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(200); response.end('{}'); return }
  let body = ''
  for await (const chunk of request) body += String(chunk)
  const data = JSON.parse(body)
  const instruction = String(data.messages?.[0]?.content ?? '')
  const input = String(data.messages?.[1]?.content ?? '')
  calls.push({ instruction, input })
  if (live) {
    try {
      const upstream = await fetch(`${process.env.OPENAI_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!}`, 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(30_000),
      })
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' })
      response.end(await upstream.text())
    } catch { response.writeHead(502); response.end('{}') }
    return
  }
  let content = '这条我没记。提醒什么？'
  if (instruction.includes('把这件事记成一句提醒')) content = JSON.stringify({ text: '记得拔插头。' })
  if (instruction.includes('提醒请求解析器')) {
    const parsed = JSON.parse(input) as ReminderResolutionInput
    const target = parsed.pending.at(-1)
    let draft: unknown
    if (parsed.current.text.includes('再提醒')) draft = { kind: 'create', timeSourceId: parsed.current.id, text: '记得看手机是否充满了。' }
    else if (parsed.current.text.includes('拔插头') && parsed.current.text.startsWith('对')) draft = { kind: 'update', targetIntentId: target?.id, text: '记得拔插头。' }
    else if (parsed.current.text.includes('默认')) draft = { kind: 'create', timeSourceId: parsed.recent.find(line => line.text.includes('6min'))?.id, text: '记得拔插头。' }
    else if (target !== undefined) draft = { kind: 'confirm', targetIntentId: target.id, text: target.text }
    else draft = { kind: 'create', timeSourceId: parsed.current.id, text: '记得拔插头。' }
    content = JSON.stringify(draft)
  }
  if (instruction.includes('目标提案')) content = JSON.stringify({ operation: 'none' })
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content } }] }))
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const env: Record<string, string> = { CHARACTER_QQ_PROACTIVE_MODE: 'on', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false', CHARACTER_GOALS_ENABLED: 'true', CHARACTER_AGREEMENT_ENABLED: 'true' }
if (live) for (const key of ['OPENAI_API_KEY', 'OPENAI_LARGE_MODEL', 'OPENAI_SMALL_MODEL']) {
  if (process.env[key] !== undefined) env[key] = process.env[key]!
}
const host = await startCoexistHost({ dbDir: sandbox.dir, modelPort: (server.address() as { port: number }).port, env })
let client: EntryShell | undefined
let passed = false
let ledger: unknown
try {
  await host.ready
  client = new EntryShell(host.qqPort, host.qqToken)
  await client.ready
  const messages = [
    '记得提醒我6min后手机将会充好电，给我发消息叫我拔一下插头', '默认吧',
    '记得提醒我6min后手机将会充好电，给我发消息叫我拔一下插头',
    '好吧，手机还没充满，6min后再提醒我', '不是一回事', '对，拔插头',
  ]
  for (const [index, message] of messages.entries()) {
    const turn = await client.submit(`reminder-${index}`, message)
    turns.push(turn)
    assert.equal(turn.outcome, 'replied')
    assert.ok(!/没记|说清|再说一遍|发消息还是|你来找我/u.test(String(turn.replyText)), JSON.stringify(turn))
    if (index !== 3 && index !== 4) assert.ok(/拔[^。！？\n]{0,12}(?:插头|充电器)/u.test(String(turn.replyText)), JSON.stringify(turn))
    console.log(`第${index + 1}轮：${String(turn.replyText)}`)
  }
  client.close(); client = undefined
  assert.equal(await host.stop(), 0)
  const db = await openRawPGlite(sandbox.dir)
  try {
    const reminders = (await db.query('select id, text, scheduled_at, plan_version, source_refs from notification_intents order by created_at')).rows as { text: string; scheduled_at: number; plan_version: number; source_refs: string[] }[]
    const events = (await db.query("select id, created_at, content from conversation_events where actor_type = 'user' order by sequence")).rows as { id: string; created_at: number; content: string }[]
    const goals = (await db.query("select count(*)::int as count from character_domain_events where type in ('GOAL_CREATED', 'COMMITMENT_ACCEPTED')")).rows
    assert.equal(reminders.length, 2, '确认和重复交代不产生额外排期')
    assert.ok(reminders.every(row => /拔[^。！？\n]{0,12}(?:插头|充电器)/u.test(row.text)), '内容补充必须落到通知正文')
    assert.equal(Number(reminders[0]!.scheduled_at), Number(events[0]!.created_at) + 360_000, '原排期不因默认或重复确认而重置')
    assert.equal(Number(reminders[1]!.scheduled_at), Number(events[3]!.created_at) + 360_000, '再提醒使用本轮真实事件时刻')
    assert.equal((goals[0] as { count: number }).count, 0, '提醒不在约定桥重复写目标')
    if (!live) {
      assert.equal(Number(reminders[1]!.plan_version), 2, '补充内容递增计划版本')
      assert.equal(calls.filter(call => call.instruction.includes('提醒处理结果')).length, 6, '六轮主回复均得到通知事实')
    }
    ledger = { reminders, events, goals }
  } finally { await db.close() }
  passed = true
} finally {
  client?.close()
  if (host.child.exitCode === null) await host.stop()
  server.close()
  const output = resolve('artifacts/post-lv2/reminder-context-repair', `${live ? 'main-live' : 'main-current'}-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, 'evidence.json'), JSON.stringify({ passed, live, sandbox: sandbox.dir, turns, ledger, calls, stdout: host.stdout, stderr: host.stderr }, null, 2))
}
console.log(`提醒主入口六轮读回：${passed ? 'PASS' : 'FAIL'}`)
process.exit(passed ? 0 : 1)
