/** ADR-115：真实 main.ts --bridge；离线档含 L-S8-30 入口/消费缺席负控，--live 使用测试模型。 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'

const live = process.argv.includes('--live')
if (live && process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('--live 必须经 with-test-model，禁止生产 key 回落')
const root = process.cwd()
const before = digestTree(join(root, 'data/pglite')).treeSha256
const mainPath = resolve(root, 'src/main.ts')
const mainSource = readFileSync(mainPath, 'utf8')
const mainSha256 = createHash('sha256').update(mainSource).digest('hex')
const out = join(root, 'artifacts/post-lv2', `s8-daily-${live ? 'live' : 'e2e'}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`)
const local = join(root, 'artifacts/post-lv2/local', out.split(/[\\/]/).at(-1)!)
let sandbox = ''
let entryPath = mainPath
let controlPath: string | undefined
const cases = [
  { text: '今天晚饭吃什么？', related: false, choiceId: null, quote: null },
  { text: '我们聊聊极创二面的准备吧', related: true, choiceId: null, quote: '极创二面' },
  { text: '我们先把二面的范围问清楚', related: true, choiceId: 'ask_scope', quote: '范围问清楚' },
  { text: '继续做这次极创二面的准备', related: true, choiceId: 'go_prepare', quote: '继续做' },
  { text: '今天有点困，先聊聊晚饭', related: false, choiceId: null, quote: null },
] as const
const fixtureCalls: { daily: boolean; world: boolean; scope: boolean }[] = []
const fixture = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  if (body.trim() === '') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [] }))
    return
  }
  const parsed = JSON.parse(body) as { messages?: { content?: string }[] }
  const text = (parsed.messages ?? []).map(m => m.content ?? '').join('\n')
  const daily = text.includes('story-daily-draft@1')
  const world = text.includes('# 正在发生的事（你们共同故事里')
  fixtureCalls.push({ daily, world, scope: text.includes('# 本轮故事范围') })
  let content = '<response><text>我们按你这一轮说的来聊。</text></response>'
  if (daily) {
    const line = text.split('\n').find(row => row.startsWith('【用户本轮原话】'))
    const userText = JSON.parse(line!.slice('【用户本轮原话】'.length))
    const c = cases.find(item => item.text === userText)
    assert.ok(c, '夹具未定义的输入')
    content = JSON.stringify({ schemaVersion: 'story-daily-draft@1', related: c.related, choiceId: c.choiceId, quote: c.quote })
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content } }] }))
})

const features = Object.fromEntries([...readFileSync(join(root, 'src/kernel/app/flags.ts'), 'utf8')
  .matchAll(/env\.(CHARACTER_[A-Z_]+_ENABLED)/g)].map(match => [match[1]!, 'false']))
const results: Record<string, unknown>[] = []
const traces: { text: string; traceId: string; related: boolean }[] = []
const transcript: string[] = []
let child: ChildProcessWithoutNullStreams | undefined
let childExit: Promise<number | null> | undefined
const pending = new Map<string, { done: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>()
async function start() {
  const env: NodeJS.ProcessEnv = { ...process.env, ...features, PGLITE_DATA_DIR: sandbox,
    PROJECT_LG_SANDBOX: sandbox, USER_NAME: 's8-daily-fixture-owner',
    CHARACTER_KERNEL_ENABLED: 'true', CHARACTER_MEMORY_ENABLED: 'true', CHARACTER_RECALL_ENABLED: 'true',
    CHARACTER_STORY_COGNITION_ENABLED: 'true', CHARACTER_STORY_CHOICE_DECISION_ENABLED: 'true', CHARACTER_STORY_DAILY_ENABLED: 'true',
    CHARACTER_ENTRY_SCOPED_CONVERSATIONS: 'true', CHARACTER_MEMORY_SEMANTIC_MODE: 'off',
    CHARACTER_TOOL_DECISION_MODE: 'rules', CHARACTER_ROLLUP_TOKENS: '0', CHARACTER_EXPRESSIVE_SPEECH: 'false',
    CHARACTER_TEXT_STREAM_ENABLED: 'false', CHARACTER_AFFECT_SEMANTIC_MODE: 'rules', LOG_LEVEL: 'info',
    CHARACTER_STORY_CHOICE_DECISION_TIMEOUT_MS: live ? '8000' : '1000',
  }
  delete env.PROJECT_LG_ALLOW_PRODUCTION_DB
  if (!live) Object.assign(env, { OPENAI_API_KEY: 'offline-local-fixture', OPENAI_BASE_URL: `http://127.0.0.1:${(fixture.address() as { port: number }).port}`,
    OPENAI_LARGE_MODEL: 'offline-fixture', OPENAI_SMALL_MODEL: 'offline-fixture' })
  child = spawn(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), entryPath, '--bridge'],
    { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  childExit = new Promise(done => child!.once('close', code => {
    for (const wait of pending.values()) wait.reject(new Error(`child_exit:${code}`))
    pending.clear(); done(code)
  }))
  createInterface({ input: child.stderr }).on('line', line => transcript.push(line))
  createInterface({ input: child.stdout }).on('line', line => {
    transcript.push(line)
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      if (row.kind !== 'TURN_RESULT') return
      const waiter = pending.get(String(row.requestId))
      if (waiter) { pending.delete(String(row.requestId)); waiter.done(row) }
    } catch { /* 启动日志不是协议结果 */ }
  })
}
async function submit(index: number) {
  const c = cases[index]!
  const requestId = `daily-${index}`
  const row = await new Promise<Record<string, unknown>>((done, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`turn_timeout:${requestId}`)) }, live ? 120000 : 45000)
    pending.set(requestId, { done: r => { clearTimeout(timer); done(r) }, reject: e => { clearTimeout(timer); reject(e) } })
    child!.stdin.write(JSON.stringify({ kind: 'SUBMIT_TURN', requestId, userText: c.text }) + '\n')
  })
  assert.equal(row.outcome, 'replied', JSON.stringify(row))
  assert.ok(typeof row.replyText === 'string' && row.replyText.length > 0)
  if (live && index === 4) assert.doesNotMatch(row.replyText, /二面|极创|一起过去|面试|分工|搭档/, '闲聊轮不主动带回本故事')
  traces.push({ text: c.text, traceId: String(row.traceId), related: c.related })
  results.push({ requestId, outcome: row.outcome, traceId: row.traceId })
  console.log(`PASS ${requestId}: ${c.text}`)
}
async function stop() {
  child!.stdin.end()
  const code = await childExit
  assert.equal(code, 0, transcript.slice(-20).join('\n'))
  child = undefined
}
let status = 'FAIL'
let failure = ''
const stages: Record<string, unknown>[] = []
async function runChain(label: string): Promise<{ status: string; failure: string; ledgerCount?: number; watermarkCount?: number }> {
  sandbox = isolateDatabase(`s8-daily-${label}`, { keep: true }).dir
  results.length = 0; traces.length = 0; fixtureCalls.length = 0; transcript.length = 0
  let ledgerCount: number | undefined
  let watermarkCount: number | undefined
  let stageStatus = 'FAIL'
  let stageFailure = ''
  try {
    await start()
    await submit(0); await submit(1); await submit(2)
    await stop()
    await start()
    await submit(3); await submit(4)
    await stop()
    const db = await openRawPGlite(sandbox)
    try {
      const commits = (await db.query('select event_type, choice_id, interaction_ref, anchor_conversation_event_id, run_id, revision from storyline_commits order by revision')).rows as Record<string, unknown>[]
      const watermarks = (await db.query('select consumer, last_consumed_revision from storyline_consumer_watermarks order by consumer')).rows as Record<string, unknown>[]
      ledgerCount = commits.length
      watermarkCount = watermarks.length
      results.push({ ledger: commits, consumerWatermarks: watermarks })
      assert.equal(commits.length, 3, 'story_entry_commits_missing')
      assert.deepEqual(commits.map(c => c.event_type), ['STORY_STARTED', 'CHOICE_COMMITTED', 'CHOICE_COMMITTED'])
      assert.deepEqual(commits.map(c => c.choice_id), [null, 'ask_scope', 'go_prepare'])
      assert.equal(new Set(commits.map(c => c.run_id)).size, 1)
      for (const t of traces) {
        assert.match(t.traceId, /^trc:[0-9a-f-]+$/)
        const row = (await db.query(`select context_section_ids from character_traces where trace_id='${t.traceId}'`)).rows[0] as Record<string, unknown>
        assert.ok(row, `missing_trace:${t.traceId}`)
        assert.equal((row.context_section_ids as string[]).includes('world-observation'), t.related, t.text)
        assert.ok((row.context_section_ids as string[]).includes('story-turn-scope'), t.text)
      }
      const anchors = (await db.query("select id, conversation_id from conversation_events where type='user_message'")).rows as Record<string, unknown>[]
      for (const c of commits.slice(1)) {
        const anchor = anchors.find(a => a.id === c.anchor_conversation_event_id)
        assert.ok(anchor); assert.equal(c.interaction_ref, anchor.conversation_id)
      }
      assert.deepEqual(watermarks.map(w => w.consumer), ['affect', 'reflection', 'relationship'], 'story_consumer_watermarks_missing')
      assert.ok(watermarks.every(w => Number(w.last_consumed_revision) === commits.length), 'story_consumer_watermarks_stalled')
      results.push({ contextChecks: traces.length, restart: 'PASS', realConversationBinding: 'PASS' })
    } finally { await db.close() }
    if (!live) assert.ok(fixtureCalls.filter(c => !c.daily && c.scope).length >= cases.length)
    stageStatus = 'PASS'
  } catch (error) { stageFailure = String(error); console.error(stageFailure, transcript.slice(-12).join('\n')) }
  finally {
    if (child && child.exitCode === null) { child.stdin.end(); await childExit }
    child = undefined
    const reading = { label, status: stageStatus, expectedStatus: label.endsWith('absent') ? 'FAIL' : 'PASS',
      failure: stageFailure, turns: traces.length, results: [...results], fixtureCalls: [...fixtureCalls], sandbox }
    stages.push(reading)
    mkdirSync(local, { recursive: true })
    writeFileSync(join(local, `${label}-transcript.log`), transcript.join('\n'))
    console.log(`${label}: ${stageStatus}${stageFailure ? ` (${stageFailure})` : ''}`)
  }
  return { status: stageStatus, failure: stageFailure, ledgerCount, watermarkCount }
}

// 只改临时副本的实际调用表达式，保留名字/注释，不能靠文本检查捕获变异。
function withoutCalls(names: readonly string[], replacement: string, expectedCount: number): string {
  const source = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true)
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && names.includes(node.expression.name.text)) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(calls.length, expectedCount, 'story_control_call_shape_changed')
  let changed = mainSource
  for (const call of calls.sort((a, b) => b.pos - a.pos)) {
    changed = changed.slice(0, call.getStart(source)) + replacement + changed.slice(call.end)
  }
  assert.ok(/storyCognitionEnabled/.test(changed) && /consumeOnce/.test(changed), '负控必须仍能骗过旧文本锁')
  return changed
}

try {
  if (!live) await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done))
  assert.equal((await runChain('positive')).status, 'PASS', 'story_positive_failed')
  if (!live) {
    controlPath = join(root, 'src', `.s8-entry-control-${randomUUID()}.ts`)
    entryPath = controlPath
    writeFileSync(controlPath, withoutCalls(['resolveDailyTurn', 'resolveChoiceTurn'], "({ kind: 'unrelated', worldObservations: [] })", 2), 'utf8')
    const missingEntry = await runChain('entry-absent')
    assert.equal(missingEntry.status, 'FAIL')
    assert.match(missingEntry.failure, /story_entry_commits_missing/)
    assert.equal(missingEntry.ledgerCount, 0, '负控必须完成五轮对话并读到零提交，其他失败不得冒充')
    writeFileSync(controlPath, withoutCalls(['consumeOnce'], '({ progress: [] })', 2), 'utf8')
    const missingConsumer = await runChain('consumer-absent')
    assert.equal(missingConsumer.status, 'FAIL')
    assert.match(missingConsumer.failure, /story_consumer_watermarks_(missing|stalled)/)
    assert.equal(missingConsumer.ledgerCount, 3, '消费负控必须仍有三条真实提交')
    assert.equal(missingConsumer.watermarkCount, 0, '消费调用缺席必须读到零水位')
    unlinkSync(controlPath); controlPath = undefined
    entryPath = mainPath
    assert.equal((await runChain('restored')).status, 'PASS', 'story_restored_failed')
  }
  assert.equal(readFileSync(mainPath, 'utf8'), mainSource, 'production_main_source_changed')
  assert.equal(digestTree(join(root, 'data/pglite')).treeSha256, before, 'production_tree_changed')
  status = 'PASS'
} catch (error) { failure = String(error); console.error(failure) }
finally {
  if (controlPath !== undefined && existsSync(controlPath)) unlinkSync(controlPath)
  if (!live) { fixture.closeAllConnections(); await new Promise<void>(done => fixture.close(() => done())) }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'result.json'), JSON.stringify({ status, failure, live, results, fixtureCalls,
    stages, measuredCount: stages.reduce((sum, stage) => sum + Number(stage.turns), 0), mainSha256,
    sandbox, productionDatabaseOpened: false, productionSourceUnchanged: readFileSync(mainPath, 'utf8') === mainSource,
    productionTreeUnchanged: digestTree(join(root, 'data/pglite')).treeSha256 === before }, null, 2))
  console.log(`${status}: ${out}/result.json`)
}
process.exit(status === 'PASS' ? 0 : 1)
