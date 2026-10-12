import 'dotenv/config'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isolateDatabase, cleanupSandbox } from '../src/dev/sandbox.ts'
import { openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'

const evidence = resolve(`artifacts/post-lv2/model-memory/main-${Date.now()}`)
mkdirSync(evidence, { recursive: true })
const sandbox = isolateDatabase('model-memory-main', { keep: true })
let decisionCalls = 0
let replyReceived = false
let release: (() => void) | undefined
let rawReply = ''
const server = createServer(async (request, response) => {
  let bytes = ''
  for await (const chunk of request) bytes += String(chunk)
  const body = bytes ? JSON.parse(bytes) as { messages?: { content: string }[] } : {}
  const prompt = body.messages?.at(-1)?.content ?? ''
  let content = '<response><text>我已经记住了。</text></response>'
  if (prompt.includes('你是 LG 每轮回复结束后的长期记忆决策器')) {
    decisionCalls++
    // The background provider deliberately cannot finish before the visible reply.
    if (!replyReceived) await new Promise<void>(done => { release = done })
    const text = JSON.parse(prompt.split('\n').at(-1)!).current.text as string
    content = JSON.stringify({ destination: 'long_term', decisions: [{ operation: 'create', quote: text, explicit: true,
      memory: { type: 'person_fact', predicate: 'education.institution', value: '南京大学', importance: 0.7, confidence: 0.96 } }] })
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], data: [] }))
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const port = (server.address() as { port: number }).port
const disabled = Object.fromEntries([...readFileSync('src/kernel/app/flags.ts', 'utf8').matchAll(/env\.(CHARACTER_[A-Z_]+_ENABLED)/g)].map(match => [match[1]!, 'false']))
const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--bridge'], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...disabled,
    CHARACTER_MEMORY_ENABLED: 'true', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'true', CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED: 'true',
    CHARACTER_MEMORY_AUTOMATIC_ENABLED: 'true', CHARACTER_MEMORY_AUTOMATIC_PYTHON: '',
    CHARACTER_MEMORY_WRITE_MODE: 'post_turn_model', CHARACTER_MEMORY_RECALL_MODE: 'legacy',
    CHARACTER_MEMORY_SEMANTIC_MODE: 'off', CHARACTER_AFFECT_SEMANTIC_MODE: 'rules',
    CHARACTER_ROLLUP_TOKENS: '0', CHARACTER_GOAL_TOKENS: '0', CHARACTER_COMMITMENT_TOKENS: '0',
    CHARACTER_EXPRESSIVE_MODULATION: 'false', PGLITE_DATA_DIR: sandbox.dir, PROJECT_LG_SANDBOX: sandbox.dir,
    OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_LARGE_MODEL: 'fixture', OPENAI_SMALL_MODEL: 'fixture',
    USER_NAME: 'PostTurnModelMainFixture', LOG_LEVEL: 'info',
  },
})
const lines = createInterface({ input: child.stdout })
let writes = false
let tail = ''
let timedOut = false
const ended = new Promise<number | null>(done => child.once('close', done))
const timeout = setTimeout(() => { timedOut = true; child.kill() }, 90_000)
const inspect = (line: string) => {
  tail = (tail + '\n' + line).slice(-8000)
  if (line.includes('TURN_RESULT')) { replyReceived = true; rawReply = line; release?.() }
  if (line.includes('[automatic-memory]') && /"created":\s*1/u.test(line)) writes = true
  if (replyReceived && writes) child.stdin.end()
}
lines.on('line', inspect)
child.stderr.on('data', chunk => inspect(String(chunk)))
child.stdin.write(JSON.stringify({ kind: 'SUBMIT_TURN', requestId: 'model-main-1', userText: '请长期记住，我在南京大学读书。' }) + '\n')
let passed = false
try {
  assert.equal(await ended, 0, tail)
  assert.ok(!timedOut && replyReceived && writes)
  assert.equal(decisionCalls, 1, 'one model decision; legacy extractor/consumer never writes')
  assert.ok(!rawReply.includes('我已经记住了'), 'pre-reply completion claim is guarded')
  const reopened = await openRawPGlite(sandbox.dir)
  try {
    const records = (await reopened.query("select processor, confidence, status from memory_records")).rows
    assert.equal(records.length, 1)
    assert.equal(records[0]!.processor, 'post-turn-model-memory')
    assert.equal(records[0]!.confidence, 0.96, 'model score is preserved, not hardcoded .80')
    assert.equal((await reopened.query("select * from processor_watermarks where processor = 'automatic-memory-langmem'")).rows.length, 0)
    assert.equal((await reopened.query("select * from character_jobs where processor = 'post-turn-model-memory' and status = 'failed'")).rows.length, 0)
  } finally { await reopened.close() }
  const status = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--automatic-memory-status'], {
    windowsHide: true, env: { ...process.env, ...disabled, CHARACTER_MEMORY_ENABLED: 'true',
      CHARACTER_MEMORY_WRITE_MODE: 'post_turn_model', PGLITE_DATA_DIR: sandbox.dir, PROJECT_LG_SANDBOX: sandbox.dir,
      OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_LARGE_MODEL: 'fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let statusText = ''
  status.stdout.on('data', chunk => { statusText += String(chunk) })
  status.stderr.on('data', chunk => { statusText += String(chunk) })
  assert.equal(await new Promise(done => status.once('close', done)), 0, statusText)
  assert.ok(statusText.includes('"status": "ready"') && statusText.includes('"pendingEvents": 0'), 'status selects new durable processor')
  assert.equal(decisionCalls, 1, 'status causes no model decision')
  passed = true
  console.log('PASS real main: reply precedes model completion; new writer owns the single commit')
} catch (error) { console.error(error); process.exitCode = 1 }
finally {
  clearTimeout(timeout); lines.close(); release?.(); server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
  writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({ passed, decisionCalls, replyReceived, writes, timedOut,
    productionDbOpened: false, rawReply, tail }, null, 2))
  cleanupSandbox(sandbox.dir)
}
