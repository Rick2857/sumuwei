import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { runPreparedPgGate } from './postgresql/test-harness.ts'
import { startCoexistHost, EntryShell, delay } from './coexist/harness.ts'

// Fresh resources: no production-copy history, external model, Windows worker or mouse action.
if (!process.env.LG_TEST_PG_URL) {
  await runPreparedPgGate('main', 'scripts/priority-main-pg-verify.ts')
} else {
const workDir = mkdtempSync(join(tmpdir(), 'lg-priority-main-'))
const clarifyMode = process.argv.includes('--clarify')
const question = '你要操作哪个窗口（clarification-canary）？'
const finalPrompts: string[] = []
let decisionCalls = 0
let modelCalls = 0
let modelSawPcReady = false
const model = httpServer(async (req, res) => {
  let body = ''; for await (const part of req) body += String(part)
  if (!body) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return }
  const value = JSON.parse(body); modelCalls++
  if (value.response_format) decisionCalls++
  else if (body.includes('当前聊天入口')) finalPrompts.push(body)
  if (!value.response_format && body.includes('桌面操作使用 PC 执行端：已连接')) modelSawPcReady = true
  const content = clarifyMode ? (value.response_format
    ? JSON.stringify(decisionCalls === 1 ? { branch: 'clarify', question } : { branch: 'answer' })
    : '<response><text>' + (body.includes('clarification-canary') ? '你要操作哪个窗口？' : '我们继续聊。') + '</text></response>')
    : value.response_format ? JSON.stringify({ branch: 'tools', goal: 'fixture click',
    steps: [{ capability: 'desktop.operate', operation: 'act', args: { action: 'click', window: 'fixture', index: 1, name: 'button' }, purpose: 'fixture' }], done: true })
    : '<response><text>我已经完成了操作。</text></response>'
  if (value.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n')
  } else {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content } }] }))
  }
})
await new Promise<void>(done => model.listen(0, '127.0.0.1', done))
const actions: { actionId: string }[] = []
let peer: Socket | undefined
const executor = createServer(socket => {
  peer = socket; let text = ''
  socket.on('data', bytes => {
    text += bytes.toString()
    while (text.includes('\n')) {
      const i = text.indexOf('\n'), line = text.slice(0, i); text = text.slice(i + 1)
      if (line.startsWith('LG_ENTRY ')) socket.write('LG_ENTRY_READY v1\n')
      else actions.push(JSON.parse(line))
    }
  })
})
await new Promise<void>(done => executor.listen(0, '127.0.0.1', done))
const host = await startCoexistHost({ dbDir: workDir, modelPort: (model.address() as { port: number }).port,
  env: { CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: process.env.LG_TEST_PG_URL!, CHARACTER_THIN_HOST: 'on',
    PGLITE_DATA_DIR: '', PROJECT_LG_SANDBOX: '', DATABASE_URL: '',
    CHARACTER_ACTION_ENABLED: 'true', CHARACTER_TASK_AUTONOMY_ENABLED: 'true', CHARACTER_DESKTOP_OPERATE_ENABLED: 'true',
    CHARACTER_ACTION_MAX_RISK: 'R2', CHARACTER_TOOL_DECISION_MODE: 'role', CHARACTER_RECALL_ENABLED: 'false',
    CHARACTER_EXECUTOR_ENABLED: 'true', CHARACTER_EXECUTOR_HOST: '127.0.0.1',
    CHARACTER_EXECUTOR_PORT: String((executor.address() as { port: number }).port), CHARACTER_EXECUTOR_TOKEN: 'fixture-token-0123456789' } })
let entry: EntryShell | undefined
try {
  await host.ready
  for (let i = 0; i < 100 && !host.stdout.some(line => line.includes('执行端已连上')); i++) await delay(50)
  assert.ok(host.stdout.some(line => line.includes('执行端已连上')), 'main must authenticate executor')
  entry = new EntryShell(host.avatarPort, host.avatarToken); await entry.ready
  if (clarifyMode) {
    const clarified = await entry.submit('clarification-first', '请帮我操作一下窗口。')
    assert.ok(JSON.stringify(clarified).includes('窗口'), JSON.stringify(clarified))
    assert.ok(finalPrompts[0]?.includes('clarification-canary'))
    assert.equal(actions.length, 0)
    const second = await entry.submit('clarification-second', '我们聊点别的。')
    assert.ok(JSON.stringify(second).includes('继续聊'))
    assert.ok(!finalPrompts[1]?.includes('clarification-canary'))
    const pool = new pg.Pool({ connectionString: process.env.LG_TEST_PG_URL })
    try {
      assert.equal((await pool.query("select count(*)::int as n from character_traces t where row_to_json(t)::text like '%clarification-canary%'")).rows[0].n, 0)
      assert.equal((await pool.query('select count(*)::int as n from character_action_events')).rows[0].n, 0)
    } finally { await pool.end() }
  } else {
  let settled = false
  const reply = entry.submit('priority-main-click', '请点击 fixture 窗口中的 button 按钮，序号 1。').then(value => { settled = true; return value })
  for (let i = 0; i < 1200 && !actions.length && !settled; i++) await delay(50)
  assert.equal(actions.length, 1, 'real main must dispatch exactly one action')
  await delay(100); assert.equal(settled, false, 'main must not finish the turn before receipt')
  peer!.write(JSON.stringify({ kind: 'ACTION_RESULT', actionId: actions[0].actionId, outcome: 'completed' }) + '\n')
  const result = await reply
  assert.ok(JSON.stringify(result).includes('完成'), 'completed receipt permits completion reply')
  assert.ok(modelSawPcReady, 'final model must receive current PC readiness rather than startup state')
  assert.equal(actions.length, 1)
  }
  entry.close(); entry = undefined
  assert.equal(await host.stop(), 0)
  const out = 'artifacts/post-lv2/local/debt-repair-20261019'
  mkdirSync(out, { recursive: true })
  writeFileSync(`${out}/${clarifyMode ? 'clarification' : 'main'}-checks.json`, JSON.stringify({ status: 'PASS', backend: 'postgres', modelCalls, dispatched: actions.length,
    waitedForReceipt: true, isolatedDatabase: true, realDesktopActions: 0, productionOpened: false }, null, 2))
  console.log(clarifyMode ? 'PASS main clarification: question in final model, zero actions, no trace leak or next-turn residue' : 'PASS actual main + role decision + Gateway + TCP receipt + final turn response')
} catch (error) {
  console.error(host.stdout.slice(-30).join('\n')); console.error(host.stderr.slice(-15).join('\n'))
  throw error
} finally {
  entry?.close(); host.kill(); peer?.destroy()
  await new Promise<void>(done => executor.close(() => done()))
  model.closeAllConnections(); await new Promise<void>(done => model.close(() => done()))
  assert.ok(workDir.startsWith(join(tmpdir(), 'lg-priority-main-')))
  rmSync(workDir, { recursive: true, force: true })
}
}
