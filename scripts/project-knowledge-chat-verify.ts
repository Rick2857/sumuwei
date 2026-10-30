/** Real main + separate PostgreSQL core/library, loopback model fixture; no real QQ or paid model. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { applyKernelMigrations } from '../src/infrastructure/persistence/db.ts'
import { withKnowledgeTestDatabase } from './project-knowledge-test-db.ts'
import { EntryShell, startCoexistHost } from './coexist/harness.ts'
import { initializeKnowledgeDatabase, syncKnowledgeDocuments } from '../src/infrastructure/project-knowledge/store.ts'
import { loadDocuments, type ImportManifest } from '../src/infrastructure/project-knowledge/documents.ts'
import { openKnowledgeReader, searchProjectKnowledge, readProjectPassage } from '../src/infrastructure/project-knowledge/reader.ts'
import { createProjectSearchAdapter, createSelfCapabilitiesAdapter } from '../src/infrastructure/project-knowledge/adapters.ts'
import { selfCapabilitySnapshot } from '../src/infrastructure/project-knowledge/self-capabilities.ts'
import { createCapabilityRegistry } from '../src/kernel/action/capability-registry.ts'
import { createProjectKnowledgeDefinitions, mayReadProjectKnowledge } from '../src/kernel/action/project-knowledge-capabilities.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import type { ScopeContext } from '../src/kernel/contracts/scope.ts'
import type { AdapterExecuteInput } from '../src/kernel/action/executor-port.ts'
import { OneBotPrivateClient } from '../src/infrastructure/qq/onebot-private-client.ts'
import { readQqPrivateConfig } from '../src/infrastructure/qq/private-config.ts'

const checks: string[] = []
async function check(name: string, run: () => unknown | Promise<unknown>) {
  await run(); checks.push(name); console.log(`PASS ${name}`)
}
const out = resolve('artifacts/local/project-knowledge-p2')
await mkdir(out, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'lg-knowledge-chat-'))
const adminUrl = process.env.LG_SIM_PGTEST_ADMIN_URL!
const live = process.argv.includes('--live')
if (live) {
  assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', 'test endpoint wrapper required')
  assert.ok(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL && process.env.OPENAI_LARGE_MODEL)
}
const projectOnly = live && process.argv.includes('--project-only')
const selfOnly = live && process.argv.includes('--self-only')
assert.ok(!(projectOnly && selfOnly))
const requests: { status: number; model: string; usage?: unknown; proposal?: unknown }[] = []
const input = (operation: string, args: Record<string, unknown>): AdapterExecuteInput => ({ actionId: 'knowledge-test' as never,
  operation, args, target: { type: 'internal_service', canonicalId: 'project-lg', confidence: 'exact' }, now: () => Date.now() as never })
const original = '# 语音回复\r\n合成夹具原文：青蓝海星 😀。旧报告称已启用，但没有当前连接证据。\r\n'
const manifest: ImportManifest = { version: 1, libraryId: 'project-lg', sources: [{ path: 'docs/voice.md', kind: 'acceptance',
  environment: 'synthetic-isolated', topics: ['语音'], documentDate: null, effectiveAt: null, supersedes: [] }] }
try {
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs/voice.md'), original)
  const owner: ScopeContext = { principal: { kind: 'owner', userId: 'owner', verifiedBy: 'config_binding' },
    purpose: 'external_query', room: { kind: 'private', userId: 'owner' } }
  await check('owner private only; group, nonowner, internal cognition and mismatched room refused', () => {
    assert.equal(mayReadProjectKnowledge(owner), true)
    assert.equal(mayReadProjectKnowledge(undefined), true, 'legacy single-owner entry')
    for (const scope of [{ ...owner, room: { kind: 'group', groupId: 'g' } },
      { ...owner, principal: { kind: 'user', userId: 'owner', verifiedBy: 'onebot_inbound' } },
      { ...owner, purpose: 'internal_cognition' }, { ...owner, room: { kind: 'private', userId: 'other' } }]) {
      assert.equal(mayReadProjectKnowledge(scope as ScopeContext), false)
    }
  })
  await check('runtime snapshot separates registration, switches, grants, candidates and unknown connection', () => {
    const flags = readKernelFlags({ CHARACTER_SELF_CAPABILITIES_ENABLED: 'true', CHARACTER_ACTION_ENABLED: 'true',
      CHARACTER_TASK_AUTONOMY_ENABLED: 'true' })
    const snapshot = selfCapabilitySnapshot({ registry: createCapabilityRegistry(createProjectKnowledgeDefinitions()), flags,
      gateway: { adapterIds: ['self.capabilities'], grantedPermissions: [], maxRiskLevel: 'R1', dryRun: false, lastResults: {} }, candidates: ['self.capabilities'], entry: 'qq_private', runtimeId: 'fixture', sandboxRoot: root,
      wechat: false, capability: 'self.capabilities', now: 123, probe: () => ({ ready: true, reason: 'no_local_dependency_probe', checkedAt: 123 }) })
    const self = snapshot.tools.find(row => row.id === 'self.capabilities')!
    assert.equal(snapshot.observedAt, 123); assert.equal(self.configured, true)
    assert.equal(self.permissionGranted, false); assert.equal(self.taskCandidate, true)
    assert.equal(self.dependency.state, 'unknown'); assert.equal(self.remoteConnection, 'unknown')
    assert.equal(self.executionResult, 'not_queried'); assert.equal(JSON.stringify(snapshot).includes(root), false)
    assert.equal(readKernelFlags({}).projectKnowledgeEnabled, false)
    assert.equal(readKernelFlags({}).selfCapabilitiesEnabled, false)
    const summary = selfCapabilitySnapshot({ registry: createCapabilityRegistry(createProjectKnowledgeDefinitions()), flags,
      gateway: { adapterIds: ['self.capabilities'], grantedPermissions: [], maxRiskLevel: 'R1', dryRun: false, lastResults: {} }, candidates: ['self.capabilities'], entry: 'qq_private', runtimeId: 'fixture', sandboxRoot: root,
      wechat: false, probe: () => { throw new Error('summary must not probe dependencies') } })
    assert.deepEqual(summary.tools, []); assert.equal(summary.summary.registered, 2)
    assert.ok(JSON.stringify(summary).length < 1800, 'summary fits existing content budget')
  })
  await check('loopback OneBot owner text delivery includes citation; nonowner cannot invoke query', async () => {
    // ws is the existing jsdom dependency, as in the repository's other OneBot fixtures.
    const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws')
    const server = createServer(), websocket = new WebSocketServer({ server })
    let peer: any, submitted = 0
    const sent: string[] = []
    websocket.on('connection', (socket: any) => {
      peer = socket
      socket.on('message', (raw: unknown) => {
        const packet = JSON.parse(String(raw))
        if (packet.action === 'send_private_msg') sent.push(JSON.stringify(packet.params.message))
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo,
          data: packet.action === 'get_login_info' ? { user_id: '987654321' } : { message_id: 1 } }))
      })
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const revision = 'a'.repeat(64)
    const client = new OneBotPrivateClient(readQqPrivateConfig({ QQ_OWNER_ID: '123456789', QQ_BOT_ID: '987654321',
      QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${(server.address() as { port: number }).port}/`,
      QQ_ONEBOT_ACCESS_TOKEN: 'knowledge-fixture-token-1234567890' }), async request => {
      submitted++
      return { kind: 'TURN_RESULT', requestId: request.requestId, outcome: 'replied', delivery: 'generated',
        replyText: '正文', knowledgeAppendix: `本轮查询出处：\n[C1] project-knowledge://project-lg/docs/voice.md?revision=${revision}` }
    }, () => undefined)
    try {
      await client.connect(); await client.drain()
      for (const userId of ['222222222', '123456789']) {
        peer.send(JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '987654321',
          user_id: userId, sender: { user_id: userId }, message_id: Number(userId), message: [{ type: 'text', data: { text: '查询项目' } }] }))
      }
      for (let i = 0; i < 400 && !sent.length; i++) await delay(10)
      await client.drain()
      assert.equal(submitted, 1); assert.equal(sent.length, 1)
      assert.ok(sent[0]!.includes(revision) && sent[0]!.includes('正文'))
    } finally {
      await client.close()
      await new Promise<void>(done => websocket.close(() => done()))
      await new Promise<void>(done => server.close(() => done()))
    }
  })
  await withKnowledgeTestDatabase(adminUrl, 'knowledge-library', async library => {
    await initializeKnowledgeDatabase(library.pool, 'project-lg')
    const docs = await loadDocuments(root, manifest)
    await syncKnowledgeDocuments(library.pool, 'project-lg', docs)
    const reader = `lg_test_reader_${randomBytes(6).toString('hex')}`, password = randomBytes(24).toString('hex')
    const readerUrl = new URL(library.url); readerUrl.username = reader; readerUrl.password = password
    await library.admin.query(`create role ${reader} login password '${password}' nosuperuser nocreatedb nocreaterole nobypassrls`)
    await library.pool.query(`grant usage on schema project_knowledge to ${reader}; grant select on all tables in schema project_knowledge to ${reader}`)
    try {
      await check('chat refuses importer credentials and readonly account cannot update library', async () => {
        await assert.rejects(openKnowledgeReader(library.url, library.database), /reader_permissions/)
        const pool = await openKnowledgeReader(readerUrl.href, library.database)
        try { await assert.rejects(pool.query('delete from project_knowledge.documents')) } finally { await pool.end() }
      })
      await check('Chinese retrieval returns exact source revision, UTF16 offsets, lines and environment', async () => {
        const pool = await openKnowledgeReader(readerUrl.href, library.database)
        try {
          const [hit] = await searchProjectKnowledge(pool, '语音 青蓝海星', 1)
          assert.ok(hit); assert.equal(hit.revision, docs[0]!.revision); assert.equal(hit.sourceHash, docs[0]!.sourceHash)
          assert.equal(original.slice(hit.startOffset, hit.endOffset), hit.text)
          assert.equal(hit.startLine, 1); assert.equal(hit.endLine, 2)
          assert.equal((hit.metadata as { environment: string }).environment, 'synthetic-isolated')
          assert.deepEqual(await searchProjectKnowledge(pool, 'unfindable_xyz'), [])
          await assert.rejects(searchProjectKnowledge(pool, '语音', 4))
        } finally { await pool.end() }
      })
      await check('adapters reject execution/SQL/secret arguments and return cited content separately from ledger', async () => {
        const adapter = createProjectSearchAdapter({ url: readerUrl.href, database: library.database })
        for (const args of [{ query: '语音', sql: 'delete' }, { query: '语音', limit: 4 }, { path: '.env', command: 'run' }]) {
          await assert.rejects(adapter.execute(input('search', args)))
        }
        const result = await adapter.execute(input('search', { query: '语音' }))
        assert.ok(result.turnContent?.[0]?.resourceRef?.includes(docs[0]!.revision))
        assert.ok(JSON.stringify(result.turnContent).includes('青蓝海星'))
        assert.equal(JSON.stringify(result.evidence).includes('青蓝海星'), false)
        assert.equal(JSON.stringify(result).includes(password), false)
        let count = 0
        const self = createSelfCapabilitiesAdapter(() => ({ observedAt: ++count }))
        assert.notDeepEqual((await self.execute(input('query', {}))).turnContent, (await self.execute(input('query', {}))).turnContent)
        await assert.rejects(self.execute(input('run', {})))
      })
      await withKnowledgeTestDatabase(adminUrl, 'knowledge-core', async core => {
        await applyKernelMigrations(drizzle(core.pool) as never)
        for (const mode of (live ? ['semantic', 'disabled'] : ['legacy', 'semantic', 'disabled']) as ('legacy' | 'semantic' | 'disabled')[]) {
          const prompts: string[] = [], catalogs: string[] = [], decisions: string[] = [], failures: string[] = []
          let protocolLeak = false
          const proposal = (capability: string) => ({ branch: 'tools', goal: '读取项目证据', done: true,
            steps: [{ capability, operation: capability === 'project.search' ? 'search' : 'query',
              args: capability === 'project.search' ? { query: '语音' } : { capability: 'project.search' } }] })
          const model = createServer(async (req, res) => {
            try {
              let raw = ''; for await (const part of req) raw += part
              const body = JSON.parse(raw), instruction = String(body.messages?.[0]?.content ?? '')
              if (instruction.includes('要不要用工具') || body.tools?.some((tool: any) => tool.function?.name === 'lg_tools')) {
                catalogs.push(JSON.stringify(body.messages))
              }
              if (live && mode !== 'disabled') {
                assert.ok(requests.length < 12, 'bounded smoke: at most 12 physical requests; no retries')
                const modelName = process.env.OPENAI_LARGE_MODEL!
                const record: typeof requests[number] = { status: 0, model: modelName }; requests.push(record)
                const response = await fetch(process.env.OPENAI_BASE_URL!.replace(/\/+$/, '') + '/chat/completions', {
                  method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
                  body: JSON.stringify({ ...body, model: modelName, stream: false }), signal: AbortSignal.timeout(45000),
                })
                const payload = await response.json() as any
                Object.assign(record, { status: response.status, usage: payload.usage })
                const choice = payload.choices?.[0]?.message
                record.proposal = choice?.tool_calls ?? (instruction.includes('要不要用工具') || instruction.includes('规划') ? choice?.content : undefined)
                if (body.tools?.some((tool: any) => tool.function?.name === 'lg_tools')) {
                  for (const call of choice?.tool_calls ?? []) if (call.function?.name === 'lg_tools') {
                    const plan = JSON.parse(call.function.arguments)
                    decisions.push(...(plan.steps ?? []).map((step: any) => step.capability))
                  }
                } else if (instruction.includes('要不要用工具')) {
                  const plan = JSON.parse(String(choice?.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, ''))
                  decisions.push(...(plan.steps ?? []).map((step: any) => step.capability))
                } else prompts.push(JSON.stringify(body.messages))
                res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); return
              }
              let message: unknown = { content: '<response><text>已依据本轮项目原文与程序事实回答。</text></response>' }
              if (body.tools?.some((tool: { function?: { name: string } }) => tool.function?.name === 'lg_tools')) {
                const request = JSON.parse(body.messages[1].content)
                const capability = request.current.text.includes('原文') ? 'project.search' : 'self.capabilities'
                if (!protocolLeak) decisions.push(capability)
                message = { content: null, tool_calls: protocolLeak ? [] : [{ id: 'knowledge-fixture', type: 'function',
                  function: { name: 'lg_tools', arguments: JSON.stringify(proposal(capability)) } }] }
              } else if (instruction.includes('要不要用工具')) {
                const capability = String(body.messages[1].content).split('\n')[0]!.includes('原文') ? 'project.search' : 'self.capabilities'
                if (mode !== 'disabled') assert.ok(instruction.includes('项目自查模式'))
                decisions.push(capability); message = { content: JSON.stringify(proposal(capability)) }
              } else {
                prompts.push(JSON.stringify(body.messages))
                if (protocolLeak) message = { content: `<lg-qq-media>${JSON.stringify({ version: 1, mode: 'text',
                  text: '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="self.capabilities"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>' })}</lg-qq-media>` }
              }
              res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }))
            } catch (error) { failures.push(String(error)); res.writeHead(500); res.end('{}') }
          })
          await new Promise<void>(done => model.listen(0, '127.0.0.1', done))
          const dir = join(root, mode)
          const host = await startCoexistHost({ dbDir: dir, modelPort: (model.address() as { port: number }).port, env: {
            CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: core.url, LG_TEST_PG_URL: core.url,
            LG_PG_EXPECT_DATABASE: core.database, LG_PG_EXPECT_USER: new URL(core.url).username,
            CHARACTER_THIN_HOST: 'on', PROJECT_LG_SANDBOX: '', DATABASE_URL: '',
            CHARACTER_TOOL_DECISION_MODE: 'role', CHARACTER_ACTION_ENABLED: 'true', CHARACTER_TASK_AUTONOMY_ENABLED: 'true',
            CHARACTER_ACTION_MAX_RISK: 'R1', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false', CHARACTER_RECALL_ENABLED: 'false',
            CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED: 'false', CHARACTER_TURN_CONTENT_TOKENS: '1200',
            CHARACTER_PROJECT_KNOWLEDGE_ENABLED: String(mode !== 'disabled'), CHARACTER_SELF_CAPABILITIES_ENABLED: String(mode !== 'disabled'),
            CHARACTER_SEMANTIC_ENTRY_ENABLED: String(mode === 'semantic'),
            CHARACTER_QQ_VOICE_REPLY: String(mode === 'semantic'), CHARACTER_QQ_VOICE_OUTPUT: String(mode === 'semantic'),
            LG_PROJECT_KNOWLEDGE_READ_URL: readerUrl.href, LG_PROJECT_KNOWLEDGE_DATABASE: library.database,
          } })
          let shell: EntryShell | undefined
          try {
            await host.ready; shell = new EntryShell(host.qqPort, host.qqToken); await shell.ready
            const selfReply = !projectOnly ? await shell.submit(`self-${mode}`, selfOnly
              ? '请查询 self.capabilities，告诉我当前装配、权限和未验证项。' : '问个问题，你现在能够决定自行往哪个群里发消息吗？') : undefined
            const projectReply = !selfOnly ? await shell.submit(`project-${mode}`, '查语音机制的原文出处') : undefined
            await check(`${mode}: real main receives actual tool content or keeps disabled context absent`, async () => {
              assert.deepEqual(failures, [])
              const text = prompts.join('\n')
              if (mode === 'disabled') {
                // Earlier owner replies remain legitimate conversation history; absence means no new query/context.
                const trace = (await core.pool.query('select context_section_ids from character_traces order by started_at desc limit 1')).rows[0]
                assert.equal(trace.context_section_ids.includes('project-self-knowledge'), false)
                assert.equal(trace.context_section_ids.includes('turn-content'), false)
                assert.equal(projectReply?.knowledgeAppendix, undefined)
                assert.equal(selfReply?.knowledgeAppendix, undefined)
              } else {
                if (!selfOnly) assert.ok(decisions.includes('project.search'))
                if (!projectOnly) {
                  assert.ok(decisions.includes('self.capabilities'))
                  assert.ok(text.includes('self-capabilities@2'), 'runtime snapshot reaches final compose')
                  assert.ok(JSON.stringify(selfReply).includes('runtime://self/capabilities'), 'runtime source reaches delivered reply')
                  assert.ok(text.includes('unknown'))
                  assert.ok(text.includes('runtime-gateway') && text.includes('assembled'))
                }
                if (!selfOnly) {
                  assert.ok(text.includes('青蓝海星'), 'retrieved original reaches final compose')
                  assert.ok(text.includes(docs[0]!.revision), 'actual version reaches final compose')
                  assert.ok(text.includes('synthetic-isolated'))
                  assert.ok(JSON.stringify(projectReply).includes(docs[0]!.revision), 'source revision reaches delivered reply')
                }
                if (!selfOnly && !projectOnly) assert.ok(catalogs.join('\n').includes('上次本进程回执=success/已调用适配器'),
                  'next decision reads fresh gateway result; catalogue is not frozen at construction')
              }
              assert.equal(text.includes(password), false)
              assert.equal((await core.pool.query('select count(*)::int n from memory_records')).rows[0].n, 0)
            })
            if (!live && mode === 'semantic') {
              await check('real main refuses leaked DSML inside QQ text envelope without persisting speech or executing it', async () => {
                protocolLeak = true
                const actionsBefore = (await core.pool.query('select count(*)::int n from character_action_events')).rows[0].n
                const outputBefore = (await core.pool.query("select count(*)::int n from conversation_events where actor_type='character'")).rows[0].n
                const result = await shell!.submit('dsml-negative-control', '问个问题，你现在能够决定自行往哪个群里发消息吗？')
                assert.notEqual(result.outcome, 'replied')
                assert.equal(JSON.stringify(result).includes('DSML'), false)
                assert.equal((await core.pool.query('select count(*)::int n from character_action_events')).rows[0].n, actionsBefore)
                assert.equal((await core.pool.query("select count(*)::int n from conversation_events where actor_type='character'")).rows[0].n, outputBefore)
                const trace = (await core.pool.query('select status,error from character_traces order by started_at desc limit 1')).rows[0]
                assert.equal(trace.status, 'failed')
                assert.ok(trace.error.includes('reply_contains_tool_protocol'))
              })
            }
          } catch (error) {
            await writeFile(join(out, `main-${mode}-failure.log`), [...host.stdout, ...host.stderr].join('\n'))
            throw error
          } finally { shell?.close(); await host.stop(); await new Promise<void>(done => model.close(() => done())) }
        }
      })
      await check('sync updates visible to next read; removal hides current, explicit historical revision remains citable', async () => {
        await writeFile(join(root, 'docs/voice.md'), '# 语音回复\n新版：绛紫海星。\n')
        await syncKnowledgeDocuments(library.pool, 'project-lg', await loadDocuments(root, manifest))
        const pool = await openKnowledgeReader(readerUrl.href, library.database)
        try {
          assert.ok((await searchProjectKnowledge(pool, '绛紫'))[0]!.text.includes('绛紫'))
          assert.equal((await searchProjectKnowledge(pool, '青蓝')).length, 0)
          // The sync API requires a nonempty manifest; revoke using a different allowlisted source.
          await writeFile(join(root, 'docs/other.md'), '# 其它\n保留资料。\n')
          await syncKnowledgeDocuments(library.pool, 'project-lg', await loadDocuments(root, { ...manifest,
            sources: [{ ...manifest.sources[0]!, path: 'docs/other.md' }] }))
          assert.equal((await readProjectPassage(pool, 'docs/voice.md')).length, 0)
          assert.equal((await readProjectPassage(pool, 'docs/voice.md', 0, docs[0]!.revision))[0]!.text, original)
        } finally { await pool.end() }
      })
    } finally {
      await library.pool.query(`revoke all on all tables in schema project_knowledge from ${reader}; revoke all on schema project_knowledge from ${reader}`)
      await library.admin.query(`drop role ${reader}`)
    }
  })
  await writeFile(join(out, 'verification.json'), JSON.stringify({ status: 'PASS', ranAt: new Date().toISOString(), checks,
    location: 'serversim/simhost', backend: 'two disposable PostgreSQL databases plus readonly role',
    model: live ? 'test endpoint via loopback proxy' : 'loopback deterministic fixture', realModelRequests: requests.length,
    requests, realQqMessages: 0, cleanup: 'verified by database harness' }, null, 2))
} catch (error) {
  await writeFile(join(out, 'verification.json'), JSON.stringify({ status: 'FAIL', checks, requests, error: String(error) }, null, 2)); throw error
} finally { await rm(root, { recursive: true, force: true }) }
console.log(`PASS ${checks.length} checks`)
