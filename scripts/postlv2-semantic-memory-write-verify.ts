/** ADR-108: common main.ts writes, with fresh databases and no actual QQ traffic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import 'dotenv/config'
import { isolateDatabase, cleanupSandbox, isProductionDir, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import type { BridgeWireResponse } from '../src/kernel/app/bridge/turn-bridge.ts'

const root = process.cwd()
const live = process.argv.includes('--live')
if (live && process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Live verification requires with-test-model; never use the production model key for tests')
const before = digestTree(PRODUCTION_DB_DIR).treeSha256
const sourcePaths = ['src/main.ts', 'src/kernel/app/flags.ts', 'src/kernel/app/memory/intent-detector.ts', 'src/kernel/app/memory/content-extractor.ts']
const features = Object.fromEntries([...readFileSync(resolve(root, 'src/kernel/app/flags.ts'), 'utf8')
  .matchAll(/env\.(CHARACTER_[A-Z_]+_ENABLED)/g)].map((match) => [match[1]!, 'false']))
assert.equal(readKernelFlags({}).memoryLlmExtractorEnabled, false)
const broadRequest = '请长期记住，我目前在示科读书。'
assert.equal(await createRuleOnlyContentExtractor().extract({ text: broadRequest, owner: entityRef('character', 'fixture'), speaker: entityRef('user', 'fixture') }), undefined)
const fixtureCalls: { kind: string; label: string }[] = []
const deferred = new Set<ReturnType<typeof setTimeout>>()
const model = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.includes('/chat/completions')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [] }))
    return
  }
  let raw = ''
  for await (const chunk of request) raw += String(chunk)
  const body = JSON.parse(raw) as { messages: { content: string }[] }
  const prompt = String(body.messages.at(-1)?.content ?? '')
  let text = '<response><text>我已经记住了。</text></response>'
  if (prompt.includes('判断下面这句话里')) {
    const match = /句子：([^\n]+)$/u.exec(prompt)
    const input = match ? JSON.parse(match[1]!) as string : ''
    const label = input.includes('闭集负控') ? 'do not remember' : input.startsWith('请') ? 'remember' : 'none'
    fixtureCalls.push({ kind: 'intent', label })
    if (input.includes('分类失败')) { response.writeHead(500); response.end('fixture_failure'); return }
    text = label
    if (input.includes('分类超时')) {
      const timer = setTimeout(() => { deferred.delete(timer); response.end(JSON.stringify({ choices: [{ message: { content: text } }] })) }, 17_000)
      deferred.add(timer)
      response.on('close', () => { clearTimeout(timer); deferred.delete(timer) })
      return
    }
  } else if (prompt.includes('把下面这句话抽成')) {
    fixtureCalls.push({ kind: 'content', label: prompt.includes('循环暗号') ? 'invalid_json' : 'education.institution' })
    text = prompt.includes('循环暗号') ? 'not-json' : JSON.stringify({ predicate: 'education.institution', value: '示例工程科技大学', type: 'person_fact' })
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content: text } }] }))
})

type MemoryRow = { content: { predicate: string; value: unknown }; status: string; processor: string }
const checks: { id: string; pass: boolean; detail: unknown }[] = []
const run = async (id: string, args: string[], enabled: boolean, texts: string[]): Promise<{ rows: MemoryRow[]; replies: BridgeWireResponse[]; elapsedMs: number }> => {
  const dir = isolateDatabase(`semantic-write-${id}`, { keep: true }).dir
  assert.equal(isProductionDir(dir), false)
  const modelAddress = model.address()
  const modelEnv = live ? {} : {
    OPENAI_API_KEY: 'offline-local-fixture', OPENAI_BASE_URL: `http://127.0.0.1:${typeof modelAddress === 'object' && modelAddress ? modelAddress.port : 0}`,
    OPENAI_LARGE_MODEL: 'offline-fixture', OPENAI_SMALL_MODEL: 'offline-fixture',
  }
  const child = spawn(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, 'src/main.ts'), ...args], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: {
      ...process.env, ...features, ...modelEnv, PGLITE_DATA_DIR: dir, PROJECT_LG_SANDBOX: dir,
      USER_NAME: 'semantic-write-fixture', CHARACTER_KERNEL_ENABLED: 'true', CHARACTER_MEMORY_ENABLED: 'true', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'true',
      CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED: String(enabled), CHARACTER_TOOL_DECISION_MODE: 'rules',
      CHARACTER_MEMORY_SEMANTIC_MODE: 'off', CHARACTER_EXPRESSIVE_SPEECH: 'false', CHARACTER_ROLLUP_TOKENS: '0', LOG_LEVEL: 'fatal',
      QQ_OWNER_ID: '123456789', QQ_BOT_ID: '987654321', QQ_ONEBOT_WS_URL: 'ws://127.0.0.1:6701/', QQ_ONEBOT_ACCESS_TOKEN: 'offline-unused-qq-token-123456',
    },
  })
  const replies: BridgeWireResponse[] = []
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-1200) })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', (line) => { try { const packet = JSON.parse(line) as BridgeWireResponse; if (packet.kind === 'TURN_RESULT') replies.push(packet) } catch { /* ordinary startup/CLI output */ } })
  const started = Date.now()
  try {
    const closed = new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Isolated main deadline: ${id}`)) }, 180_000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('close', (code) => { clearTimeout(timer); done(code) })
    })
    if (args.includes('--bridge')) for (const [index, userText] of texts.entries()) child.stdin.write(JSON.stringify({ kind: 'SUBMIT_TURN', requestId: `${id}-${index}`, userText }) + '\n')
    child.stdin.end()
    assert.equal(await closed, 0, `${id}: ${stderr}`)
    if (args.includes('--bridge')) {
      assert.equal(replies.length, texts.length, id)
      assert(replies.every((reply) => reply.outcome === 'replied'), id)
    }
    const db = await openRawPGlite(dir)
    try {
      const rows = (await db.query('select content, status, processor from memory_records order by recorded_at')).rows as MemoryRow[]
      const events = (await db.query('select count(*) as count from conversation_events')).rows as { count: number }[]
      assert.equal(Number(events[0]!.count), texts.length * 2, id)
      return { rows, replies, elapsedMs: Date.now() - started }
    } finally { await db.close() }
  } finally { lines.close(); cleanupSandbox(dir) }
}

const positive = '请记住，我不吃香菜。'
const ordinary = '我的生日是五月六日。'
const out = resolve(root, 'artifacts/post-lv2', `semantic-memory-write-${live ? 'live' : 'offline'}-${new Date().toISOString().replace(/\D/g, '')}`)
try {
  if (!live) await new Promise<void>((done) => model.listen(0, '127.0.0.1', done))
  const off = await run('off', ['--bridge'], false, [positive])
  assert.equal(off.rows.length, 0)
  assert.equal(fixtureCalls.length, 0)
  checks.push({ id: 'off-preserves-rules', pass: true, detail: { memoryRows: 0 } })
  const on = await run('on', ['--bridge'], true, [positive, broadRequest, ordinary])
  assert.equal(on.rows.length, 2)
  assert(on.rows.some((row) => row.content.predicate === 'food.preference.cilantro' && row.content.value === 'dislike'))
  assert(on.rows.some((row) => row.content.predicate === 'education.institution' && /示科|示例工程科技大学/u.test(String(row.content.value))))
  assert(on.rows.every((row) => row.status === 'active' && row.processor === 'explicit-memory'))
  checks.push({ id: 'shared-bridge-semantic-intent-and-content', pass: true, detail: { memoryRows: 2, ordinaryFactNotStored: true, elapsedMs: on.elapsedMs } })
  const cli = await run('cli', [positive], true, [positive])
  assert.equal(cli.rows.length, 1)
  checks.push({ id: 'formal-cli-common-writer', pass: true, detail: { memoryRows: 1, elapsedMs: cli.elapsedMs } })
  if (!live) {
    const texts = [
      '文章里的角色说“请记住我不吃香菜”。', '我记住了。', '记住，我的生日是什么时候？',
      '这是闭集负控。', '请记住，分类失败，我不吃香菜。', '请记住，分类超时，我不吃香菜。',
      '记住：我的循环暗号是灯塔。', positive,
    ]
    const qq = await run('qq-recovery', ['--bridge', '--qq-private'], true, texts)
    assert.equal(qq.rows.length, 1)
    assert.equal(qq.rows[0]!.content.predicate, 'food.preference.cilantro')
    assert(qq.replies.slice(0, -1).every((reply) => !reply.replyText?.includes('我已经记住了。')))
    checks.push({ id: 'qq-negatives-and-same-process-recovery', pass: true, detail: { memoryRows: 1, negativeTurns: texts.length - 1, elapsedMs: qq.elapsedMs } })
    assert(fixtureCalls.some((call) => call.kind === 'content' && call.label === 'education.institution'))
    assert(fixtureCalls.some((call) => call.label === 'do not remember'))
  }
  assert.equal(digestTree(PRODUCTION_DB_DIR).treeSha256, before)
  mkdirSync(out, { recursive: true })
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ status: 'PASS', scope: live ? 'test-model endpoint + real common main.ts + fresh isolated databases' : 'local model fixture + real common main.ts + fresh isolated databases',
    productionDatabaseOpened: false, productionTreeUnchanged: true, actualQqTraffic: false,
    sourceHashes: Object.fromEntries(sourcePaths.map((path) => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
    checks, fixtureCalls: live ? undefined : fixtureCalls, naturalProductionFirstUse: 'NOT OBSERVED',
  }, null, 2) + '\n')
  console.log(`PASS: semantic memory writes / source controls / common chat entries\n${out}`)
} catch (error) {
  mkdirSync(out, { recursive: true })
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ status: 'FAIL', live, checks, error: error instanceof Error ? error.message : String(error), productionDatabaseOpened: false }, null, 2) + '\n')
  throw error
} finally {
  for (const timer of deferred) clearTimeout(timer)
  model.closeAllConnections()
  if (model.listening) await new Promise<void>((done) => model.close(() => done()))
}
