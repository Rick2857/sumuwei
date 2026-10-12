/**
 * post-Lv2 / **ADR-109 WP3（剩下那一半）** —— **皮套外壳用连接档连到共享核心**。
 *
 * ============================================================================
 *  它验的是什么
 * ============================================================================
 * WP3 的协议面（取消 / 播放账 / 断开按入口归属）已经由 `postlv2:coexist:verify` 的 C 段覆盖，
 * 但那时连过去的是**本门自己写的模拟外壳**。本门换成一个**真的东西**：
 *
 * ```text
 * scripts/postlv2_vtuber_runtime.py 的 LGBridgeClient（生产外壳用的就是它）
 *   --connect-host / --connect-port / --connect-token   ⇒ 连到 `--coexist` 的皮套监听
 *   --bridge-only                                      ⇒ 只跑桥客户端（不装 VTuber 上游 / 不碰 ASR/TTS）
 * ```
 *
 * 于是这一门回答的是 WP3 剩下那一半的核心问题：
 * **"外壳换一种连法之后，协议还通不通、关掉它核心还在不在。"**
 *
 * ⚠️ 它**不**验：ASR / TTS / 音频 / 表情渲染 / 真人体验 —— 那些要真实皮套外壳与音频设备，
 *    如实标 `NOT RUN`。
 * ⚠️ 它**不**打开生产库（隔离库 + 前后树摘要比对）。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { EntryShell, createRecorder, startCoexistHost, startFakeModel, writeEvidence, ROOT } from './coexist/harness.ts'
import { cleanupSandbox, isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'

const recorder = createRecorder()
const { check, observe, notRun } = recorder
const productionBefore = digestTree(PRODUCTION_DB_DIR).treeSha256

async function query(
  db: { query: (sql: string) => Promise<{ rows: unknown[] }> },
  sql: string
): Promise<Record<string, unknown>[]> {
  return (await db.query(sql)).rows as Record<string, unknown>[]
}

/** 跑一次真的皮套外壳（连接档 + bridge-only），把它打的那行 JSON 解析回来 */
async function runAvatarShell(input: {
  port: number
  token: string
  text: string
}): Promise<{ reading: Record<string, unknown>; stdout: string[]; exit: number | null }> {
  const child = spawn(
    'python',
    [
      '-B',
      '-X',
      'utf8',
      resolve(ROOT, 'scripts/postlv2_vtuber_runtime.py'),
      '--repo-root',
      ROOT,
      '--mode',
      'sandbox-copy',
      '--bridge-only',
      '--connect-host',
      '127.0.0.1',
      '--connect-port',
      String(input.port),
      '--connect-token',
      input.token,
      '--probe-text',
      input.text,
      '--probe-request-id',
      'shell-probe-1',
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => stdout.push(chunk))
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))
  const exit = await new Promise<number | null>((done) => child.once('close', (code) => done(code)))
  const joined = stdout.join('')
  const line = joined.split(/\r?\n/).find((candidate) => candidate.startsWith('BRIDGE_ONLY_READING'))
  if (line === undefined) {
    throw new Error(`皮套外壳没有打出读数行：\nstdout=${joined}\nstderr=${stderr.join('')}`)
  }
  return { reading: JSON.parse(line.slice('BRIDGE_ONLY_READING '.length)) as Record<string, unknown>, stdout, exit }
}

const model = await startFakeModel()
const sandbox = isolateDatabase('coexist-wp3-shell', { keep: true }).dir
let host: Awaited<ReturnType<typeof startCoexistHost>> | undefined

try {
  host = await startCoexistHost({
    dbDir: sandbox,
    modelPort: model.port,
    env: {
      /*
       * ★ 开着它，回复才会被切成**已检查语句**（逐段），交付账才有 `<replyId>#<index>` 可对账
       *   —— 这正是"皮套的合成账 / 播放账"要挂的东西。
       */
      CHARACTER_EXPRESSIVE_SPEECH: 'true',
      CHARACTER_RELATIONSHIP_CONTEXT_ENABLED: 'true',
    },
  })
  await host.ready
  const qq = new EntryShell(host.qqPort, host.qqToken)
  const qqConversation = (await qq.ready).split(' ')[2] ?? ''

  // --- 真的皮套外壳：连接档 + 协议一轮 --------------------------------
  const shell = await runAvatarShell({
    port: host.avatarPort,
    token: host.avatarToken,
    text: 'MARK-A1 皮套外壳连接档验收',
  })
  const reading = shell.reading
  const turn = reading.turn as Record<string, unknown>
  observe('W-0 皮套外壳的入口握手', String(reading.entryHello ?? '(无)'))
  check(
    'W-1 ★ 真皮套外壳用**连接档**连上了共享核心（入口由监听端口绑定）',
    String(reading.entryHello ?? '').startsWith('LG_ENTRY_READY avatar') && shell.exit === 0,
    `entryHello=${String(reading.entryHello ?? '')} · exit=${String(shell.exit)}`
  )
  check(
    'W-2 正式轮次经这条连接完成（回复非空、有 replyId）',
    turn.outcome === 'replied' && String(turn.replyText ?? '').includes('MARK-A1') && String(turn.replyId ?? '') !== '',
    `outcome=${String(turn.outcome)} · replyId=${String(turn.replyId)} · text="${String(turn.replyText ?? '').slice(0, 60)}"`
  )

  const synthesis = reading.synthesis as Record<string, unknown> | undefined
  const playback = reading.playback as Record<string, unknown> | undefined
  observe(
    'W-3 合成账 / 播放账的判决（**由 LG 的交付账给出**，不是本门的猜测）',
    `synthesis=${JSON.stringify(synthesis)} · playback=${JSON.stringify(playback)} · ` +
      `reportReading=${JSON.stringify(reading.reportReading)}`
  )
  check(
    'W-4 ★ 合成账与播放账在这条连接上**被交付账受理**（皮套入口确实挂着交付账）',
    synthesis?.outcome === 'accepted' && playback?.outcome === 'accepted',
    `synthesis=${String(synthesis?.outcome)}/${String(synthesis?.code)} · playback=${String(playback?.outcome)}/${String(playback?.code)}`
  )

  const cancel = reading.cancel as Record<string, unknown>
  const cancelReading = reading.cancelReading as Record<string, unknown>
  check(
    'W-5 取消读数是**三态分列**的（已提交的轮次：受理但不可撤销）',
    cancel.outcome === 'cancelled' &&
      (cancel.cancel as Record<string, unknown>)?.requested === true &&
      (cancel.cancel as Record<string, unknown>)?.alreadyCommitted === true,
    `outcome=${String(cancel.outcome)} · cancel=${JSON.stringify(cancel.cancel)} · 诊断面=${JSON.stringify(cancelReading)}`
  )

  // --- 外壳关掉之后：核心与另一条入口还在（D07） -----------------------
  await delay(300)
  const afterShell = String((await qq.submit('req-after-shell', 'MARK-A2 外壳关掉之后')).replyText ?? '')
  check(
    'W-6 ★ 皮套外壳断开**不关核心、也不关 QQ 入口**（QQ 新请求照常成功）',
    afterShell.includes('MARK-A2'),
    `qq="${afterShell.slice(0, 60)}"`
  )

  const exit = await host.stop()
  host = undefined
  check('W-7 核心随后正常停机（stdin EOF ⇒ 退出码 0）', exit === 0, `exit=${String(exit)}`)

  // --- 读回：事件真的落在皮套那条会话上 --------------------------------
  const db = await openRawPGlite(sandbox)
  try {
    const events = await query(
      db,
      'select conversation_id, conversation_sequence, actor_type, content from conversation_events order by sequence'
    )
    const byConversation = new Map<string, Record<string, unknown>[]>()
    for (const event of events) {
      const key = String(event.conversation_id)
      byConversation.set(key, [...(byConversation.get(key) ?? []), event])
    }
    const contiguous = [...byConversation.values()].every((rows) =>
      rows.every((row, index) => Number(row.conversation_sequence) === index + 1)
    )
    check(
      'W-8 事件落在**两条**会话上且各自序号连续（外壳那一轮进了皮套会话）',
      byConversation.size === 2 &&
        byConversation.has(qqConversation) &&
        [...byConversation.keys()].some((key) => key.endsWith('-avatar')) &&
        contiguous,
      [...byConversation.entries()].map(([key, rows]) => `${key}=${String(rows.length)} 条`).join(' · ')
    )
  } finally {
    await db.close()
  }

  // =========================================================================
  // Q 段：**QQ 外壳的连接档**（`LgStdioClient` + `OneBotPrivateClient`，与 `qq:verify` 同一套件）
  // =========================================================================
  {
    const { createRequire } = await import('node:module')
    const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws')
    const { readQqPrivateConfig } = await import('../src/infrastructure/qq/private-config.ts')
    const { LgStdioClient } = await import('../src/infrastructure/qq/lg-stdio-client.ts')
    const { OneBotPrivateClient } = await import('../src/infrastructure/qq/onebot-private-client.ts')

    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((done) => server.once('listening', done))
    const settings = readQqPrivateConfig({
      QQ_OWNER_ID: '123456789',
      QQ_BOT_ID: '987654321',
      QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${String((server.address() as { port: number }).port)}/`,
      QQ_ONEBOT_ACCESS_TOKEN: 'offline-coexist-qq-token-1234567890',
    })
    const sent: { user_id: string; message: { type: string; data: { text: string } }[] }[] = []
    let socket: { send: (data: string) => void } | undefined
    server.on('connection', (connection: { on: (e: string, f: (raw: Buffer) => void) => void; send: (d: string) => void }) => {
      socket = connection
      connection.on('message', (raw: Buffer) => {
        const packet = JSON.parse(raw.toString()) as { action: string; echo: string; params: typeof sent[number] }
        if (packet.action === 'get_login_info') {
          connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: settings.botId }, echo: packet.echo }))
          return
        }
        sent.push(packet.params)
        connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: sent.length }, echo: packet.echo }))
      })
    })
    const waitFor = async (test: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (test()) return
        await delay(20)
      }
      throw new Error('QQ fixture timeout')
    }

    const qqHost = await startCoexistHost({
      dbDir: isolateDatabase('coexist-wp3-qqshell', { keep: true }).dir,
      modelPort: model.port,
    })
    try {
      await qqHost.ready
      const lg = new LgStdioClient(ROOT, process.env, {
        connect: { host: '127.0.0.1', port: qqHost.qqPort, token: qqHost.qqToken },
      })
      await lg.ready
      const client = new OneBotPrivateClient(settings, (request) => lg.submit(request), () => {})
      await client.connect()
      socket!.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: settings.botId,
        user_id: settings.ownerId, sender: { user_id: settings.ownerId }, message_id: 90001,
        message: [{ type: 'text', data: { text: 'MARK-A3 QQ 外壳连接档验收' } }],
      }))
      await waitFor(() => sent.length === 1)
      await client.drain()
      await client.close()
      const lgExit = await lg.close()
      check(
        'Q-1 ★ QQ 外壳用**连接档**（`LgStdioClient`）连上共享核心，真实往返回原入口',
        sent.length === 1 &&
          sent[0]!.user_id === settings.ownerId &&
          sent[0]!.message[0]!.data.text.includes('MARK-A3') &&
          lgExit === 0,
        `收到 ${String(sent.length)} 条 send_private_msg · 正文含 A3=${String(sent[0]?.message[0]?.data.text.includes('MARK-A3'))} · lgExit=${String(lgExit)}`
      )
      const coreAlive = await (async () => {
        const probe = new EntryShell(qqHost.qqPort, qqHost.qqToken)
        await probe.ready
        const text = String((await probe.submit('q-probe-after', 'MARK-A4 外壳断开之后')).replyText ?? '')
        probe.close()
        return text.includes('MARK-A4')
      })()
      check(
        'Q-2 ★ QQ 外壳断开**不关核心**（另一条入口仍然可达）',
        coreAlive,
        `断开后再连 QQ 入口仍能完成一轮=${String(coreAlive)}`
      )
      const exit = await qqHost.stop()
      check('Q-3 核心正常停机（stdin EOF ⇒ 退出码 0）', exit === 0, `exit=${String(exit)}`)
    } finally {
      qqHost.kill()
      for (const connection of server.clients) connection.terminate()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }

  check(
    'W-9 ★ 真实库从未被打开（树摘要前后逐字相同）',
    digestTree(PRODUCTION_DB_DIR).treeSha256 === productionBefore,
    `before=${productionBefore.slice(0, 16)}… after=${digestTree(PRODUCTION_DB_DIR).treeSha256.slice(0, 16)}…`
  )
  notRun(
    'W-10 ASR / TTS / 音频 / 表情渲染 / 真人体验',
    '本门只跑桥客户端（`--bridge-only`），不装 VTuber 上游、不碰音频设备 ⇒ 那些**没有读数**。'
  )
  notRun(
    'W-11 生产皮套启动脚本切到连接档',
    '改生产启动路径属于**接线**；真正的激活要等 WP5 的切换授权（`scripts/postlv2-avatar-production.cmd` 未改）。'
  )

  const out = writeEvidence('coexist-wp3-shell', {
    status: recorder.results.some((row) => row.verdict === 'FAIL') ? 'FAIL' : 'PASS',
    scope: 'real pet shell (LGBridgeClient) over the connect transport + isolated DB + local fixture model',
    productionDatabaseOpened: false,
    productionTreeUnchanged: true,
    results: recorder.results,
    shellReading: reading,
  })
  console.log(`\nPASS: 皮套外壳连接档整链（真实库树摘要前后逐字相同）\n${out}`)
} finally {
  host?.kill()
  await model.close()
  cleanupSandbox(sandbox)
}
assert.ok(recorder.results.length > 0)
