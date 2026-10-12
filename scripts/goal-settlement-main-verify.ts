import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EntryShell, startCoexistHost } from './coexist/harness.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import { GOAL_PROPOSAL_SCHEMA_VERSION } from '../src/kernel/contracts/goal-proposal.ts'

const live = process.argv.includes('--live')
if (live) assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', '真模型必须经过 with-test-model')
const sandbox = isolateDatabase('goal-settlement-main', { keep: true })
const calls: { instruction: string; input: string }[] = []
const turns: Record<string, unknown>[] = []
const checks: { name: string; pass: boolean }[] = []
const chasing = (reply: string): boolean => /哪[一两三几]条|结掉还是|结清还是|继续挂着[吗？?]|只改了数量|再确认一下|(?<!不)需要.{0,5}确认|请.{0,5}确认|等你.{0,5}确认|再说[清一]|说清楚(?:[。！？\n]|$)|没结上|落不了|确认.{0,5}不够/u.test(reply)
checks.push({ name: '量具正控：完成确认与无需再确认保持安静', pass: !chasing('三条都结清了，不用再确认，也不需要再确认。以这个为准，说清楚就行。') },
  { name: '量具负控：真实追加追问必须检出', pass: chasing('说清楚。这次没动。哪两条，我结掉。') },
  { name: '量具恢复：确认已完成保持安静', pass: !chasing('拔了就行，三条都结清了。') })
let seeding = false
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(200); response.end('{}'); return }
  let body = ''
  for await (const chunk of request) body += String(chunk)
  const data = JSON.parse(body)
  const instruction = String(data.messages?.[0]?.content ?? '')
  const input = String(data.messages?.[1]?.content ?? '')
  calls.push({ instruction, input })
  let content: string | undefined
  if (instruction.includes('目标提案')) {
    const current = /本轮原话：「([^\n]+)」/u.exec(input)?.[1] ?? ''
    if (current.startsWith('记录目标：')) {
      seeding = true
      const statement = current.slice(5)
      content = JSON.stringify({ schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'create',
        span: { start: 0, end: [...current].length }, statement, origin: 'user_requested',
        ...(statement.includes('拔插头') ? { commitment: { scope: statement, criterion: { kind: 'user_report' } } } : {}) })
    } else if (!live) {
      const ids = [...input.matchAll(/^- (\S+) · status=(\S+).*描述="([^"\n]+)"/gmu)]
        .filter(row => row[2] !== 'completed' && row[3]!.includes('拔插头')).map(row => row[1])
      content = JSON.stringify({ schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, span: { start: 0, end: [...current].length },
        ...(ids.length > 0 && current.includes('拔了') ? { operation: 'report_complete', targetGoalIds: ids } : { operation: 'none' }) })
    }
  } else if (!live && instruction.includes('提醒请求解析器')) {
    // 本门没有新增提醒；完成报告必须继续进入目标域。
    content = JSON.stringify({ kind: 'none' })
  } else if (seeding) { content = '目标与约定已记录。'; seeding = false }
  else if (!live) content = '明白，已按你的完成报告处理。'
  if (content !== undefined) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content } }] })); return
  }
  try {
    const upstream = await fetch(`${process.env.OPENAI_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!}`, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(30_000),
    })
    response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(await upstream.text())
  } catch { response.writeHead(502); response.end('{}') }
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const env: Record<string, string> = { CHARACTER_QQ_PROACTIVE_MODE: 'off', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false',
  CHARACTER_GOALS_ENABLED: 'true', CHARACTER_AGREEMENT_ENABLED: 'false', CHARACTER_GOAL_TOKENS: '300', CHARACTER_COMMITMENT_TOKENS: '300' }
if (live) for (const key of ['OPENAI_API_KEY', 'OPENAI_LARGE_MODEL', 'OPENAI_SMALL_MODEL']) if (process.env[key] !== undefined) env[key] = process.env[key]!
const host = await startCoexistHost({ dbDir: sandbox.dir, modelPort: (server.address() as { port: number }).port, env })
let client: EntryShell | undefined
let passed = false
let ledger: unknown
try {
  await host.ready
  client = new EntryShell(host.qqPort, host.qqToken); await client.ready
  const labels = ['凌晨六分钟那条，到点通知我拔插头', '后来分开记的那条，到点通知我拔插头', '到点发的那条，通知我拔插头', '以后通知默认从现在开始计时']
  for (const [index, label] of labels.entries()) {
    const result = await client.submit(`seed-${index}`, `记录目标：${label}`)
    assert.equal(result.outcome, 'replied', JSON.stringify(result))
  }
  const messages = ['收到了，Bug也修完了', '插头已经拔了', '两条都是，饭已经吃了', '搞错了，三条都是', '对，就是你刚刚列出的三条']
  for (const [index, message] of messages.entries()) {
    const turn = await client.submit(`settlement-${index}`, message); turns.push(turn)
    assert.equal(turn.outcome, 'replied', JSON.stringify(turn))
    const reply = String(turn.replyText)
    if (index >= 1) checks.push({ name: `第${index + 1}轮不重复要求结清确认`, pass: !chasing(reply) })
    if (index >= 2) checks.push({ name: `第${index + 1}轮不重复询问已回答的吃饭问题`, pass: !/饭吃了没|吃饭了吗|饭吃了吗/u.test(reply) })
    console.log(`第${index + 1}轮：${reply}`)
  }
  client.close(); client = undefined
  assert.equal(await host.stop(), 0)
  const db = await openRawPGlite(sandbox.dir)
  try {
    const events = (await db.query("select type, payload from character_domain_events where type in ('GOAL_CREATED','GOAL_COMPLETED','COMMITMENT_ACCEPTED','COMMITMENT_FULFILLED') order by sequence")).rows as { type: string; payload: Record<string, unknown> }[]
    const completedIds = new Set(events.filter(row => row.type === 'GOAL_COMPLETED').map(row => String(row.payload.goalId)))
    assert.equal(completedIds.size, 3, '三条完成事项都应结清，默认偏好不结清')
    assert.equal(events.filter(row => row.type === 'GOAL_COMPLETED').length, 3, '重复确认不重复写完成事件')
    assert.equal(events.filter(row => row.type === 'COMMITMENT_FULFILLED').length, 3, '三条承诺都兑现')
    assert.equal(events.filter(row => row.type === 'GOAL_CREATED').length, 4, '没有重建重复目标')
    ledger = events
  } finally { await db.close() }
  passed = checks.every(check => check.pass)
} finally {
  client?.close()
  if (host.child.exitCode === null) await host.stop()
  server.close()
  const output = resolve('artifacts/post-lv2', `goal-settlement-main-${live ? 'live' : 'offline'}-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, 'evidence.json'), JSON.stringify({ passed, live, sandbox: sandbox.dir, checks, turns, ledger, calls, stdout: host.stdout, stderr: host.stderr }, null, 2))
  console.log(output)
}
console.log(`结清主入口五轮读回：${passed ? 'PASS' : 'FAIL'}`)
process.exit(passed ? 0 : 1)
