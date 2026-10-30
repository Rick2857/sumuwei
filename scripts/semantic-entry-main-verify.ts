import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { semanticMemoryDisposition } from '../src/infrastructure/persistence/semantic-entry-memory.ts'
import { runPreparedPgGate } from './postgresql/test-harness.ts'
import { EntryShell, startCoexistHost } from './coexist/harness.ts'
import type { SemanticEntryInput } from '../src/kernel/app/semantic-entry.ts'

if (!process.env.LG_TEST_PG_URL) {
  await runPreparedPgGate('semantic-entry-main', 'scripts/semantic-entry-main-verify.ts')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'lg-semantic-entry-'))
  const pool = new pg.Pool({ connectionString: process.env.LG_TEST_PG_URL })
  let calls = 0
  let legacyCalls = 0
  const outcomes: string[] = []
  const model = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += String(part)
      const body = JSON.parse(raw)
      const instruction = String(body.messages?.[0]?.content ?? '')
      const toolCalls: { id: string; type: string; function: { name: string; arguments: string } }[] = []
      if (body.tools?.some((tool: any) => tool.function?.name.startsWith('lg_'))) {
        calls++
        const input: SemanticEntryInput = JSON.parse(body.messages[1].content)
        const add = (name: string, args: unknown) => toolCalls.push({ id: `call-${toolCalls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
        if (input.current.text === '算一下2+2，然后按结果分钟后提醒我喝水') {
          if (input.priorDomains) {
            assert.ok(input.priorDomains.includes('tools'))
            assert.ok(!input.enabledDomains.includes('tools') && !input.enabledDomains.includes('memory'))
            assert.ok(input.materials?.some(row => row.text.includes('4')), 'actual tool result reaches unified continuation')
            add('lg_reminder', { kind: 'batch', items: [{ operation: 'create', sourceId: input.materials![0].id, text: '喝水', timeText: '4分钟后' }] })
          } else add('lg_tools', { branch: 'tools', goal: '计算并安排喝水提醒', done: true,
            steps: [{ capability: 'math.calculate', operation: 'evaluate', args: { expression: '2+2' } }] })
        } else if (input.current.text === '以后请先给结论，少讲铺垫。') {
          add('lg_memory', { kind: 'remember', payload: input.current.text })
        } else if (input.current.text === '忘掉我关于讲解详略的偏好。') {
          add('lg_memory', { kind: 'forget', payload: input.current.text, targetId: input.memories.find(row => JSON.stringify(row.content).includes('explanation.style'))!.id })
        } else if (input.current.text === '查看提醒以及我们还没完成的长期目标') {
          add('lg_reminder', { kind: 'list' })
          add('lg_goal', { schemaVersion: 'goal-proposal@2', operation: 'query', span: { start: 0, end: [...input.current.text].length } })
        } else if (input.current.text === '先排两条提醒') {
          const dateText = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
          add('lg_reminder', { kind: 'batch', repeat: 'once', items: ['大学体育(I)', '高等数学A(I)'].map(eventText => ({ operation: 'create', sourceId: input.current.id,
            dateText, timeText: '15:50', eventText, text: `${eventText}课前签到` })) })
        } else if (input.current.text.startsWith('消掉体育课那条吧')) {
          assert.ok(input.recent.some(row => row.text === '先排两条提醒'))
          assert.equal(input.memories.length, 0)
          add('lg_reminder', { kind: 'cancel', targetIntentId: input.pending.find(row => row.text.includes('体育'))!.id })
        } else if (input.current.text.startsWith('取消高数那条')) {
          add('lg_reminder', { kind: 'cancel', targetIntentId: input.pending.find(row => row.text.includes('高等'))!.id })
          add('lg_memory', { kind: 'remember', payload: '我不吃香菜' })
        } else if (input.current.text === '删掉关于香菜的那条记忆') {
          assert.equal(input.memories.length, 1)
          add('lg_memory', { kind: 'forget', payload: input.current.text, targetId: input.memories[0].id })
        } else if (input.current.text === '非法整批探针') {
          add('lg_memory', { kind: 'remember', payload: input.current.text })
          add('lg_reminder', { kind: 'cancel', targetIntentId: 'foreign-id' })
        } else if (input.current.text === '消掉那条') add('lg_clarify', { question: '你指哪一条？' })
        else if (input.current.text === '传输故障探针') { res.writeHead(503); res.end('{}'); return }
        outcomes.push(input.current.text)
      } else if (/提醒请求解析器|记忆意图|目标理解|转告请求解析器/u.test(instruction)) legacyCalls++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: toolCalls.length ? { content: null, tool_calls: toolCalls }
        : { content: '<response><text>好的。</text></response>' }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }] }))
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }
  })
  await new Promise<void>(done => model.listen(0, '127.0.0.1', done))
  const host = await startCoexistHost({ dbDir: dir, modelPort: (model.address() as { port: number }).port, env: {
    CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: process.env.LG_TEST_PG_URL!, CHARACTER_THIN_HOST: 'on',
    PGLITE_DATA_DIR: dir, DATABASE_URL: '', PROJECT_LG_SANDBOX: '',
    CHARACTER_SEMANTIC_ENTRY_ENABLED: 'true', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'true', CHARACTER_RECALL_ENABLED: 'false',
    CHARACTER_QQ_PROACTIVE_MODE: 'on', CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED: 'false',
    CHARACTER_ACTION_ENABLED: 'true', CHARACTER_TASK_AUTONOMY_ENABLED: 'true', CHARACTER_ACTION_MAX_RISK: 'R1',
    CHARACTER_MATH_CALCULATE_ENABLED: 'true', CHARACTER_TURN_CONTENT_TOKENS: '2000',
    CHARACTER_GOALS_ENABLED: 'true',
    CHARACTER_EPISTEMIC_BELIEF_HUMAN_ENABLED: 'true',
  } })
  let shell: EntryShell | undefined
  try {
    await host.ready; shell = new EntryShell(host.qqPort, host.qqToken); await shell.ready
    await shell.submit('create', '先排两条提醒')
    assert.equal((await pool.query('select count(*)::int n from notification_intents')).rows[0].n, 2)
    await shell.submit('sports', '消掉体育课那条吧，反正那个时候我十有八九会往操场赶，也不太可能忘记签到')
    let reminders = (await pool.query('select * from notification_intents')).rows
    assert.equal(reminders.filter(row => row.status === 'cancelled').length, 1)
    assert.ok(reminders.find(row => row.text.includes('体育')).status === 'cancelled')
    assert.equal((await pool.query('select count(*)::int n from memory_records')).rows[0].n, 0)
    await shell.submit('mixed', '取消高数那条，另外记住我不吃香菜')
    reminders = (await pool.query('select * from notification_intents')).rows
    assert.ok(reminders.every(row => row.status === 'cancelled'))
    assert.equal((await pool.query("select count(*)::int n from memory_records where status='active'")).rows[0].n, 1)
    await shell.submit('forget', '删掉关于香菜的那条记忆')
    assert.equal((await pool.query("select count(*)::int n from memory_records where status='active'")).rows[0].n, 0)
    const counts = async () => (await pool.query('select (select count(*) from memory_records)::int memories, (select count(*) from notification_intents)::int reminders')).rows[0]
    const before = await counts()
    for (const [i, text] of ['非法整批探针', '消掉那条', '传输故障探针', '我不会忘记签到'].entries()) await shell.submit(`negative-${i}`, text)
    assert.deepEqual(await counts(), before)
    assert.equal(calls, 8); assert.equal(legacyCalls, 0)
    await shell.submit('read-first', '算一下2+2，然后按结果分钟后提醒我喝水')
    assert.equal(calls, 10, 'exactly one continuation after content becomes available')
    assert.equal((await pool.query('select count(*)::int n from notification_intents')).rows[0].n, 3)
    assert.equal(legacyCalls, 0)
    await shell.submit('goal-and-reminder', '查看提醒以及我们还没完成的长期目标')
    assert.equal(calls, 11)
    const lastTrace = (await pool.query('select context_section_ids from character_traces order by started_at desc limit 1')).rows[0]
    assert.ok(lastTrace.context_section_ids.includes('goal-fact') && lastTrace.context_section_ids.includes('reminder-result'))
    await shell.submit('technical-scene', '请解释一个算法。')
    await shell.submit('style-memory', '以后请先给结论，少讲铺垫。')
    const style = (await pool.query("select content from memory_records where status='active'")).rows
    assert.equal(style.length, 1)
    assert.equal(style[0].content.predicate, 'preferred.explanation.style', 'existing scoped EBL preference writer remains authoritative')
    await shell.submit('style-forget', '忘掉我关于讲解详略的偏好。')
    assert.equal((await pool.query("select count(*)::int n from memory_records where status='active'")).rows[0].n, 0)
    assert.equal(calls, 14)
    const events = (await pool.query("select id,character_id,content from conversation_events where actor_type='user'")).rows
    assert.equal(await semanticMemoryDisposition(drizzle(pool) as never, events[0].character_id, 'missing-event'), 'skip', 'missing entry evidence never revives background command interpretation')
    for (const event of events) {
      const disposition = await semanticMemoryDisposition(drizzle(pool) as never, event.character_id, event.id)
      const skip = ['取消高数那条，另外记住我不吃香菜', '删掉关于香菜的那条记忆', '非法整批探针', '消掉那条', '传输故障探针',
        '以后请先给结论，少讲铺垫。', '忘掉我关于讲解详略的偏好。'].includes(event.content)
      assert.equal(disposition, skip ? 'skip' : 'automatic', 'background writer respects entry ownership and preserves implicit learning')
    }
    const steps = (await pool.query('select steps from character_traces')).rows.flatMap(row => row.steps)
    assert.equal(steps.filter(row => row.kind === 'semantic_entry').length, 14)
    shell.close(); shell = undefined; assert.equal(await host.stop(), 0)
    const out = 'artifacts/post-lv2/local/semantic-entry-20261027'
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'main.json'), JSON.stringify({ status: 'PASS', nativeEntryCalls: calls, legacyCalls,
      cancellationAndNegation: true, multiDomain: true, explicitMemoryId: true, invalidBatchZeroEffects: true,
      clarificationAndTransportZeroEffects: true, productionAccess: false, realModelCalls: 0, realQqSends: 0 }, null, 2))
    console.log('PASS isolated PostgreSQL actual main: reminder/memory disambiguation, multi-domain, exact memory target, whole-batch validation, clarify/failure/no-op, zero legacy classifiers')
  } catch (error) {
    console.error(host.stdout.slice(-10).join('\n')); console.error(host.stderr.slice(-10).join('\n')); throw error
  } finally {
    shell?.close(); if (host.child.exitCode === null) { try { await host.stop() } catch { host.kill() } }
    await pool.end(); model.closeAllConnections(); await new Promise<void>(done => model.close(() => done()))
    assert.ok(dir.startsWith(join(tmpdir(), 'lg-semantic-entry-'))); rmSync(dir, { recursive: true, force: true })
  }
}
