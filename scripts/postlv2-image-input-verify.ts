/** Real main.ts/QQ transport, isolated DB; --live uses only the test-model wrapper. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { imageInputShapeError } from '../src/kernel/contracts/image-input.ts'
import { checkImageInputs, ImageInputStore, qqImageUrl, downloadQqImage } from '../src/infrastructure/media/image-input.ts'
import { OneBotPrivateClient } from '../src/infrastructure/qq/onebot-private-client.ts'
import { readQqPrivateConfig } from '../src/infrastructure/qq/private-config.ts'
import { LgStdioClient } from '../src/infrastructure/qq/lg-stdio-client.ts'
import { EntryShell, startCoexistHost, type CoexistHost } from './coexist/harness.ts'
import { isolateDatabase, cleanupSandbox } from '../src/dev/sandbox.ts'
import { openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import { maskWithdrawnLines, type ConversationLine } from '../src/kernel/context/sections.ts'
import pg from 'pg'
import { pgTestTargetFromEnv } from './gates/pg-target.ts'

const live = process.argv.includes('--live')
if (live && process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Use pnpm with-test-model pnpm postlv2:image:live')
const root = resolve('.')
let head = 'UNAVAILABLE_NO_GIT'
try { head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim() } catch { /* Source hashes below bind exported server trees. */ }
const sourceHashes = Object.fromEntries([
  'src/main.ts', 'src/providers/openai-compatible.ts', 'src/kernel/app/turn-gateway.ts',
  'src/kernel/app/bridge/turn-bridge.ts', 'src/kernel/app/flags.ts', 'src/kernel/context/sections.ts',
  'src/kernel/contracts/context.ts', 'src/kernel/contracts/image-input.ts', 'src/infrastructure/media/image-input.ts',
  'src/infrastructure/runtime/adapters.ts', 'src/infrastructure/runtime/conversation-recorder.ts',
  'src/infrastructure/bridge/turn-bridge-transport.ts', 'src/infrastructure/qq/onebot-private-client.ts',
  'src/infrastructure/qq/lg-stdio-client.ts', 'scripts/postlv2_vtuber_runtime.py', 'scripts/postlv2-image-input-verify.ts',
].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]))
const one = { dataUrl: `data:image/png;base64,${readFileSync('evals/image-input/one.png').toString('base64')}` }
const two = { dataUrl: `data:image/png;base64,${readFileSync('evals/image-input/two.png').toString('base64')}` }
const readings: { name: string; passed: boolean }[] = []
function check(name: string, test: () => void) {
  try { test(); readings.push({ name, passed: true }); console.log(`PASS: ${name}`) }
  catch (error) { readings.push({ name, passed: false }); throw error }
}
const sandbox = isolateDatabase('image-input', { keep: true, ...pgTestTargetFromEnv() })
const calls: { images: string[]; prompt: string }[] = [] // Memory only, never written to evidence.
let failModel = false
let complete = false
const model = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return }
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  const content = body.messages.findLast((message: any) => message.role === 'user').content
  const images = Array.isArray(content) ? content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : []
  const prompt = Array.isArray(content) ? content.find(part => part.type === 'text').text : content
  calls.push({ images, prompt })
  response.writeHead(failModel ? 400 : 200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(failModel ? { error: { message: `fixture_rejected_image ${one.dataUrl}` } } :
    { choices: [{ message: { content: '<response><text>测试回复。</text></response>' } }] }))
})
await new Promise<void>(done => model.listen(0, '127.0.0.1', done))
let host: CoexistHost | undefined
let qq: EntryShell | undefined
let avatar: EntryShell | undefined
const testModelEnv = live ? Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_LARGE_MODEL', 'OPENAI_SMALL_MODEL']
  .map(key => [key, process.env[key]!])) : {}
async function start(enabled = true) {
  host = await startCoexistHost({ dbDir: sandbox.dir, modelPort: (model.address() as { port: number }).port,
    env: { ...testModelEnv, CONVERSATION_LENGTH: '16', CHARACTER_IMAGE_INPUT_ENABLED: String(enabled),
      ...(process.argv.includes('--role') ? { CHARACTER_TOOL_DECISION_MODE: 'role' } : {}) } })
  try { await host.ready } catch (error) { console.error(host.stderr.slice(-15).join('\n')); await stop(false); throw error }
  qq = new EntryShell(host.qqPort, host.qqToken)
  avatar = new EntryShell(host.avatarPort, host.avatarToken)
  await Promise.all([qq.ready, avatar.ready])
}
async function stop(verifyExit = true) {
  qq?.close(); avatar?.close()
  if (host) { const current = host; host = undefined; const code = await current.stop(); if (verifyExit) assert.equal(code, 0) }
}
async function turn(id: string, text: string, images?: readonly typeof one[]) {
  const result = await qq!.submitWithForgedFields(id, text, images ? { images } : {})
  assert.equal(result.outcome, 'replied', `${id}: ${String(result.code ?? '')}`)
  return String(result.replyText)
}
const waitFor = async (predicate: () => boolean) => {
  for (let n = 0; n < 1000; n++) { if (predicate()) return; await delay(10) }
  throw new Error('fixture_timeout')
}
try {
  check('valid input / malformed / URL / count / MIME gates', () => {
    assert.equal(imageInputShapeError([one]), undefined)
    assert.equal(checkImageInputs([one]).length, 1)
    assert(imageInputShapeError([{ dataUrl: 'https://example.com/a.png' }]))
    assert(imageInputShapeError(Array(5).fill(one)))
    assert.throws(() => checkImageInputs([{ dataUrl: one.dataUrl.replace('image/png', 'image/jpeg') }]))
    assert.throws(() => checkImageInputs([{ dataUrl: 'data:image/png;base64,YWJjZA==' }]))
    for (const url of ['http://127.0.0.1/a', 'file:///secret', 'https://qpic.cn.evil.test/a', 'https://user:pass@gchat.qpic.cn/a']) assert.throws(() => qqImageUrl(url))
  })
  const unitImageDir = mkdtempSync(join(tmpdir(), 'project-lg-image-store-unit-'))
  const store = new ImageInputStore(unitImageDir)
  await store.save(checkImageInputs([one]))
  check('persistent content-addressed original / invalid reference refused', () => {
    assert.equal(readdirSync(join(unitImageDir, 'image-inputs')).filter(name => name.endsWith('.bin')).length, 1)
  })
  assert.deepEqual(await new ImageInputStore(unitImageDir).load(checkImageInputs([one])[0].sourceRef), checkImageInputs([one])[0])
  assert.equal(await store.load('../../outside'), undefined)
  writeFileSync(join(unitImageDir, 'image-inputs', checkImageInputs([one])[0].sourceRef.slice('image:sha256:'.length) + '.bin'), 'corrupt')
  const corrupt = await store.load(checkImageInputs([one])[0].sourceRef)
  check('corrupt persisted original cannot be loaded', () => assert.equal(corrupt, undefined))
  check('withdrawn conversation lines cannot reintroduce their images', () => {
    const id = '00000000-0000-4000-8000-000000000001' as ConversationLine['id']
    const masked = maskWithdrawnLines([{ id, sequence: 1, speaker: 'user', text: '图片', actorType: 'user', imageRefs: [checkImageInputs([one])[0].sourceRef] }], new Set([id]))
    assert.equal(masked.lines[0].imageRefs, undefined)
  })
  if (!live) {
    await start(false)
    const beforeDisabled = calls.length
    const disabled = await qq!.submitWithForgedFields('disabled', '图片', { images: [one] })
    check('disabled gate before model and ledger', () => { assert.equal(disabled.code, 'image_input_disabled'); assert.equal(calls.length, beforeDisabled) })
    await stop()
  }
  await start()
  await turn('text-instruction', '接下来发来的图片只读取 ID 后面的数字，直接回答数字。')
  const first = await turn('first-image', '[用户发送了图片]', [one])
  check('text before image keeps the same conversational context', () => {
    if (live) assert.match(first, /31427/)
    else { assert.deepEqual(calls.at(-1)!.images, [one.dataUrl]); assert(calls.at(-1)!.prompt.includes('只读取 ID')) }
  })
  const follow = await turn('follow-image', '刚才图片中的物体是什么颜色和形状？')
  check('text follow-up resends the original image', () => {
    if (live) { assert.match(follow, /红|red/i); assert.match(follow, /三角|triangle/i) }
    else assert.deepEqual(calls.at(-1)!.images, [one.dataUrl])
  })
  const compare = await turn('compare-image', '比较现在与刚才的图片，分别告诉我两张图片上的 ID 数字。', [two])
  check('consecutive images can be compared in order', () => {
    if (live) { assert.match(compare, /31427/); assert.match(compare, /86519/) }
    else assert.deepEqual(calls.at(-1)!.images, [one.dataUrl, two.dataUrl])
  })
  await avatar!.submit('other-entry', '上个入口发来的图片是什么？')
  if (!live) check('avatar cannot inherit QQ images', () => assert.deepEqual(calls.at(-1)!.images, []))
  const imageFirst = await avatar!.submitWithForgedFields('image-first', '[用户发送了图片]', { images: [one] })
  check('image can arrive before any instruction', () => {
    assert.equal(imageFirst.outcome, 'replied')
    if (!live) assert.deepEqual(calls.at(-1)!.images, [one.dataUrl])
  })
  const laterInstruction = await avatar!.submit('instruction-after', '读取上一张图片中 ID 后的数字，直接回答数字。')
  check('instruction after image can still read the original', () => {
    assert.equal(laterInstruction.outcome, 'replied')
    if (live) assert.match(String(laterInstruction.replyText), /31427/)
    else assert.deepEqual(calls.at(-1)!.images, [one.dataUrl])
  })
  const sameMessage = await avatar!.submitWithForgedFields('same-message', '读取这条消息附带图片中 ID 后的数字，直接回答数字。', { images: [two] })
  check('image and instruction can arrive together', () => {
    assert.equal(sameMessage.outcome, 'replied')
    if (live) assert.match(String(sameMessage.replyText), /86519/)
    else assert.deepEqual(calls.at(-1)!.images, [one.dataUrl, two.dataUrl])
  })
  if (!live) {
    const sent: string[] = []
    const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws')
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(done => server.once('listening', done))
    let socket: any
    server.on('connection', (connection: any) => {
      socket = connection
      connection.on('message', (raw: Buffer) => {
        const packet = JSON.parse(raw.toString())
        if (packet.action === 'send_private_msg') sent.push(packet.params.message[0].data.text)
        connection.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data:
          packet.action === 'get_login_info' ? { user_id: '987654321' } : packet.action === 'get_image' ? { url: 'https://gchat.qpic.cn/two' } : { message_id: sent.length } }))
      })
    })
    const lg = new LgStdioClient(root, process.env, { connect: { host: '127.0.0.1', port: host!.qqPort, token: host!.qqToken } })
    const client = new OneBotPrivateClient(readQqPrivateConfig({ QQ_OWNER_ID: '123456789', QQ_BOT_ID: '987654321',
      QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${server.address().port}/`, QQ_ONEBOT_ACCESS_TOKEN: 'image-input-fixture-token' }), request => lg.submit(request), () => {})
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === 'https://gchat.qpic.cn/one' || url === 'https://gchat.qpic.cn/two') return new Response(Buffer.from((url.endsWith('one') ? one : two).dataUrl.split(',')[1], 'base64'))
      if (url === 'https://gchat.qpic.cn/redirect') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
      if (url === 'https://gchat.qpic.cn/oversize') return new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } })
      throw new Error('fixture_forbids_unexpected_network')
    }
    try {
      await assert.rejects(downloadQqImage('https://gchat.qpic.cn/redirect'))
      await assert.rejects(downloadQqImage('https://gchat.qpic.cn/oversize'))
      await lg.ready; await client.connect()
      const message = (id: number, parts: unknown[], user = '123456789') => socket.send(JSON.stringify({ post_type: 'message', message_type: 'private',
        sub_type: 'friend', self_id: '987654321', user_id: user, sender: { user_id: user }, message_id: id, message: parts }))
      const before = calls.length
      message(1, [{ type: 'image', data: { url: 'https://gchat.qpic.cn/one' } }], '111111111')
      message(2, [{ type: 'image', data: { url: 'http://127.0.0.1/secret' } }])
      await waitFor(() => sent.length === 1)
      check('wrong sender and forbidden URL never reach LG', () => assert.equal(calls.length, before))
      message(3, [{ type: 'image', data: { url: 'https://gchat.qpic.cn/one' } }])
      await waitFor(() => sent.length === 2); await client.drain()
      check('real OneBot -> stdio client -> main -> model image chain', () => assert(calls.at(-1)!.images.includes(one.dataUrl)))
      message(3, [{ type: 'image', data: { url: 'https://gchat.qpic.cn/one' } }])
      message(4, [{ type: 'text', data: { text: '读取这张图' } }, { type: 'image', data: { file: 'image-two.png' } }])
      await waitFor(() => sent.length === 3); await client.drain()
      check('get_image URL fallback and duplicate suppression', () => assert(calls.at(-1)!.images.includes(two.dataUrl)))
    } finally { globalThis.fetch = originalFetch; await client.close(); await lg.close(); await new Promise<void>(done => server.close(done)) }
    const bad = await avatar!.submitWithForgedFields('bad-bytes', '图片', { images: [{ dataUrl: 'data:image/png;base64,YWJjZA==' }] })
    check('corrupt image refused without pretending it was seen', () => assert.equal(bad.code, 'image_input_invalid_bytes'))
    failModel = true
    const failed = await avatar!.submitWithForgedFields('model-failed', '图片', { images: [two] })
    check('model rejection remains a failed turn', () => assert.equal(failed.outcome, 'failed'))
    failModel = false
    await avatar!.submitWithForgedFields('avatar-image', '看看这张图', { images: [two], streamSpeech: true })
    check('avatar bridge carries image input to the same main provider', () => assert.deepEqual(calls.at(-1)!.images, [one.dataUrl, two.dataUrl]))
    const large = { dataUrl: `data:image/png;base64,${Buffer.concat([readFileSync('evals/image-input/one.png'), Buffer.alloc(80_000)]).toString('base64')}` }
    await avatar!.submitWithForgedFields('large-line', '大于 64 KiB 的图片', { images: [large] })
    check('real NDJSON image packet is not truncated at 64 KiB', () => assert(calls.at(-1)!.images.includes(large.dataUrl)))
    check('protocol and logs never return raw image data', () => {
      assert(![...host!.stdout, ...host!.stderr, ...qq!.protocolLines, ...avatar!.protocolLines].join('\n').includes(one.dataUrl.split(',')[1].slice(0, 96)))
    })
  }
  await stop()
  const db = process.env.LG_TEST_PG_URL
    ? (() => { const pool = new pg.Pool({ connectionString: process.env.LG_TEST_PG_URL }); return {
      query: (sql: string) => pool.query(sql), close: () => pool.end(),
    } })() : await openRawPGlite(sandbox.dir)
  try {
    const rows = await db.query('SELECT metadata, content FROM conversation_events')
    check('ledger stores references, not base64 payload or model guesses', () => {
      assert(rows.rows.some(row => (row.metadata as any)?.imageRefs?.length))
      assert(!JSON.stringify(rows.rows).includes(one.dataUrl.split(',')[1]))
    })
  } finally { await db.close() }
  await start()
  const restarted = await turn('restart-follow', '我们刚才比较的两张图片分别是什么 ID？')
  check('restart preserves previous image context', () => {
    if (live) { assert.match(restarted, /31427/); assert.match(restarted, /86519/) }
    else assert.deepEqual(calls.at(-1)!.images, [one.dataUrl, two.dataUrl])
  })
  await stop()
  if (!live) {
    unlinkSync(join(sandbox.dir, 'image-inputs', checkImageInputs([two])[0].sourceRef.slice('image:sha256:'.length) + '.bin'))
    await start()
    await turn('missing-image', '刚才两张图能继续读取吗？')
    check('missing historical original is explicitly reported in context', () => {
      assert.deepEqual(calls.at(-1)!.images, [one.dataUrl])
      assert(calls.at(-1)!.prompt.includes('另有 1 张近期原图未提供'))
    })
    for (let n = 0; n < 10; n++) await turn(`window-${n}`, '普通文字聊天。')
    // QQ-Reminder-Followup-Repair-2026-10-20: eight same-room image events survive the text window.
    check('bounded same-room image history survives the text window without inventing missing originals', () => {
      assert.deepEqual(calls.at(-1)!.images, [one.dataUrl])
      assert(calls.at(-1)!.prompt.includes('另有 1 张近期原图未提供'))
    })
    await stop()
  }
  console.log(`Image input ${live ? 'live' : 'offline'}: ${readings.length} checks passed`)
  complete = true
} finally {
  await stop(false)
  model.closeAllConnections(); await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done()))
  const dir = resolve('artifacts/post-lv2/image-input')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${live ? 'live' : 'offline'}-${Date.now()}.json`), JSON.stringify({ at: new Date().toISOString(), live, complete, head, sourceHashes,
    model: live ? process.env.OPENAI_LARGE_MODEL : 'local-fixture', readings, productionDatabaseOpened: false, actualQqReceipt: 'NOT RUN' }, null, 2))
  cleanupSandbox(sandbox.dir)
}
process.exit(0)
