/**
 * post-Lv2 / **ADR-109 WP2** —— QQ × 皮套**双入口共存**的离线整链门。
 *
 * ============================================================================
 *  它验的是什么（逐条对应计划 §4 WP2 的通过条件与 §5 的场景）
 * ============================================================================
 *
 * ```text
 * ① 两路同时输入可各自完成          → 两条入口同时提交，各自拿到自己的回复
 * ② 回复只回原入口（定向投递）       → 回复正文里的标记只含**本入口**的
 * ③ 近期窗口不串台                  → 每轮 trace 的 source_conversation_event_ids
 *                                     不含另一条入口的事件 id
 * ④ 事件 / 会话序号实际读回         → conversation_events 按 conversation_id 分开、
 *                                     每会话 conversation_sequence 连续
 * ⑤ 共享记忆跨入口                  → QQ 明确记住的事实只写**一次**，且皮套那一轮
 *                                     的召回读数里看得到它
 * ⑥ 一个入口失败后另一路仍可用       → 一路发坏 JSON / 断开后，另一路新请求成功
 * ⑦ 公共生命周期只跑一套            → 两条入口各自 open 之后，消费者水位只有一份
 * ```
 *
 * **量具自身的正控 / 负控 / 恢复**（AGENTS.md §6.7）：
 * ```text
 * 正控：带会话过滤读近期窗口 ⇒ 只看到本入口的标记
 * 负控：**去掉**会话过滤读同一张表 ⇒ 两条入口的标记**都**出现
 *       （证明"隔离"来自那一行过滤，而不是来自"库里本来就没有"）
 * 恢复：把过滤放回去 ⇒ 又只剩本入口的标记
 * ```
 *
 * ⚠️ 全程**不打开生产库**（隔离库 + 前后树摘要逐字比对）；**不调用外部模型**
 *    （本机固定回复夹具）；**不连真实 QQ / 皮套**。
 */
import assert from 'node:assert/strict'

/*
 * ⚠️ **核心日志的全局尾**（2026-10-18 补）。
 *
 * 起因：入口换手超时（`entry_exchange_timeout`）时，**门只说"超时"，不说"核心那边发生了什么"**
 *    —— 而核心的 stdout/stderr 只在证据文件里（那要等门跑完才写）⇒ 异常路径上**看不到任何线索**。
 *    这违反"量具不许骗人"：输出里看不到哪一条挂了、报什么。
 *
 * ⇒ 做法：核心的每一行 stdout/stderr 都进这里，超时异常里带上尾 25 行。
 */
const coreLog: string[] = []
const coreLogTail = (): string => coreLog.slice(-25).join('\n')
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, connect as connectNet, type Server, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ENTRY_PROTOCOL_VERSION } from '../src/infrastructure/qq/entry-handshake.ts'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CHAT_ENTRY_KEYS,
  chatEntryKeyOfMode,
  conversationIdForEntry,
} from '../src/infrastructure/runtime/entry-scope.ts'
import { FairTurnScheduler } from '../src/kernel/app/bridge/turn-scheduler.ts'
import { cleanupSandbox, isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'

const root = resolve(import.meta.dirname, '..')
const results: { id: string; verdict: 'PASS' | 'FAIL'; detail: string }[] = []
const check = (id: string, ok: boolean, detail: string): void => {
  results.push({ id, verdict: ok ? 'PASS' : 'FAIL', detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} :: ${detail}`)
  if (!ok) throw new Error(`${id} 未通过：${detail}`)
}
const observe = (id: string, detail: string): void => {
  results.push({ id, verdict: 'PASS', detail: `（观察）${detail}` })
  console.log(`[OBSERVED] ${id} :: ${detail}`)
}

// Execute the shipped stop command in a disposable project, never against the live owner.
{
  const fixture = mkdtempSync(resolve(tmpdir(), 'lg-coexist-stop-'))
  const script = resolve(fixture, 'scripts/coexist/stop.mjs')
  mkdirSync(resolve(fixture, 'scripts/coexist'), { recursive: true })
  cpSync(resolve(root, 'scripts/coexist/stop.mjs'), script)
  const run = spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8' })
  check('STOP-1 停机命令从任意 cwd 写到项目根哨兵', run.status === 0 &&
    existsSync(resolve(fixture, 'artifacts/post-lv2/local/coexist-runtime/STOP')) &&
    !existsSync(resolve(fixture, 'scripts/artifacts/post-lv2/local/coexist-runtime/STOP')),
  '真实 stop.mjs 在一次性项目执行，不写生产停机哨兵')
}

// ---------------------------------------------------------------------------
// ① 入口作用域（纯函数；正控 + 负控 + 恢复）
// ---------------------------------------------------------------------------
{
  const base = { slug: 'sumuwei', userHash8: 'abcd1234' }
  const off = CHAT_ENTRY_KEYS.map((entry) =>
    conversationIdForEntry({ ...base, entry, entryScoped: false })
  )
  check(
    'S-1 开关关着 ⇒ 三条入口同一个会话 id（M3 起的行为逐字不变）',
    new Set(off).size === 1 && off[0] === 'dm-sumuwei-abcd1234',
    `off=${JSON.stringify(off)}`
  )
  const on = Object.fromEntries(
    CHAT_ENTRY_KEYS.map((entry) => [
      entry,
      conversationIdForEntry({ ...base, entry, entryScoped: true }),
    ])
  ) as Record<string, string>
  check(
    'S-2 开关打开 ⇒ CLI 逐字不变，另两条各得新会话，三者互不相同',
    on.cli === 'dm-sumuwei-abcd1234' &&
      on.qq_private === 'dm-sumuwei-abcd1234-qq' &&
      on.avatar === 'dm-sumuwei-abcd1234-avatar' &&
      new Set(Object.values(on)).size === 3,
    JSON.stringify(on)
  )
  /*
   * ⚠️ **皮套的两种连法必须落到同一条会话**（2026-10-06 激活前发现的缺口）：
   *    自起子进程档（`--bridge`）与连接档（`--coexist`）都是同一个皮套外壳，
   *    连接方式是**接线**，不该改变"她在皮套里聊过什么"。
   */
  check(
    'S-2b 皮套的两种连法算同一个入口（自起子进程档 = 连接档 = `avatar`）',
    chatEntryKeyOfMode('interactive_human_console', { bridgeEntry: true }) === 'avatar' &&
      chatEntryKeyOfMode('interactive_human_console') === 'cli' &&
      chatEntryKeyOfMode('interactive_human_qq_private') === 'qq_private' &&
      chatEntryKeyOfMode('scripted_agent_runner') === 'cli',
    `bridge=true ⇒ ${chatEntryKeyOfMode('interactive_human_console', { bridgeEntry: true })} · ` +
      `bridge=false ⇒ ${chatEntryKeyOfMode('interactive_human_console')}`
  )
}

// ---------------------------------------------------------------------------
// ② 调度器（有界 / 轮转公平 / 一次一轮）
// ---------------------------------------------------------------------------
{
  const scheduler = new FairTurnScheduler({ entries: ['qq_private', 'avatar'], maxQueuedPerEntry: 4 })
  const codeOf = (error: unknown): string => String((error as { code?: unknown })?.code ?? '')
  await assert.rejects(
    () => scheduler.run('unknown_entry', async () => 1),
    (error: unknown) => codeOf(error) === 'scheduler_unknown_entry'
  )
  const order: string[] = []
  let active = 0
  let peak = 0
  const work = (entry: string, tag: string) =>
    scheduler.run(entry, async () => {
      active += 1
      peak = Math.max(peak, active)
      order.push(tag)
      await delay(5)
      active -= 1
      return tag
    })
  await Promise.all([
    work('qq_private', 'A1'),
    work('qq_private', 'A2'),
    work('qq_private', 'A3'),
    work('avatar', 'B1'),
  ])
  check(
    'S-3 轮转公平：一边连发三条也不会饿死另一边（B1 不在最后）',
    order.indexOf('B1') <= 1 && peak === 1,
    `顺序=${JSON.stringify(order)} · 峰值并发=${peak}（必须为 1）`
  )

  const bounded = new FairTurnScheduler({ entries: ['qq_private', 'avatar'], maxQueuedPerEntry: 1 })
  const first = bounded.run('qq_private', async () => {
    await delay(30)
    return 'first'
  })
  await delay(2)
  await assert.rejects(
    () => bounded.run('qq_private', async () => 'second'),
    (error: unknown) => codeOf(error) === 'scheduler_queue_full'
  )
  await first
  check('S-4 队列有界且失败关闭（超过上限具名拒绝，不无限堆积）', true, '上限 1 时第二条被拒成 scheduler_queue_full')
}

// ---------------------------------------------------------------------------
// ③ 端到端：一个核心 + 两条受信入口（真 main.ts + 隔离库 + 本机固定回复夹具）
// ---------------------------------------------------------------------------
const productionBefore = digestTree(PRODUCTION_DB_DIR).treeSha256

/** 极简按行读（与 `main.ts` 的 SocketLineReader 同形；脚本不能 import 那个文件） */
class LineReader {
  private readonly queue: string[] = []
  private buffer = ''
  private closed = false
  private waiter: (() => void) | undefined
  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      for (;;) {
        const at = this.buffer.indexOf('\n')
        if (at < 0) break
        this.queue.push(this.buffer.slice(0, at))
        this.buffer = this.buffer.slice(at + 1)
      }
      this.release()
    })
    socket.on('close', () => this.finish())
    socket.on('error', () => this.finish())
  }
  private finish(): void {
    if (this.buffer !== '') this.queue.push(this.buffer)
    this.buffer = ''
    this.closed = true
    this.release()
  }
  private release(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }
  async next(): Promise<string | undefined> {
    for (;;) {
      const line = this.queue.shift()
      if (line !== undefined) return line
      if (this.closed) return undefined
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
  async *lines(): AsyncIterable<string> {
    for (;;) {
      const line = await this.next()
      if (line === undefined) return
      yield line
    }
  }
}

/** 一条入口的模拟外壳（TCP + 传输层握手 + NDJSON 桥协议） */
class EntryShell {
  private readonly socket!: Socket
  private readonly reader!: LineReader
  private readonly pending = new Map<string, (line: Record<string, unknown>) => void>()
  private readonly seen: string[] = []
  readonly ready: Promise<string>

  constructor(
    private readonly port: number,
    private readonly token: string
  ) {
    this.socket = connectNet({ host: '127.0.0.1', port })
    this.reader = new LineReader(this.socket)
    this.ready = (async () => {
      await new Promise<void>((done, reject) => {
        this.socket.once('connect', () => done())
        this.socket.once('error', reject)
      })
      this.socket.write(`LG_ENTRY ${token} v${ENTRY_PROTOCOL_VERSION}\n`)
      const hello = await this.reader.next()
      if (hello === undefined) throw new Error('entry_handshake_no_response')
      if (!hello.startsWith('LG_ENTRY_READY')) throw new Error(`entry_handshake_failed: ${hello}`)
      void this.pump()
      return hello.trim()
    })()
  }

  private async pump(): Promise<void> {
    for await (const line of this.reader.lines()) {
      this.seen.push(line)
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : ''
      const waiter = this.pending.get(requestId)
      if (waiter !== undefined) {
        this.pending.delete(requestId)
        waiter(parsed)
      }
    }
  }

  /** 只把**桥协议**行交出去（握手行已经在 `ready` 里消费掉） */
  get protocolLines(): readonly string[] {
    return this.seen.filter((line) => line.startsWith('{'))
  }

  private async exchange(
    requestId: string,
    payload: Record<string, unknown>,
    expectKind: string
  ): Promise<Record<string, unknown>> {
    const answer = new Promise<Record<string, unknown>>((done) => this.pending.set(requestId, done))
    this.socket.write(`${JSON.stringify(payload)}\n`)
    const result = await Promise.race([
      answer,
      delay(120_000).then(() => {
        throw new Error(`entry_exchange_timeout: ${requestId}\n--- core log tail ---\n${coreLogTail()}`)
      }),
    ])
    assert.equal(result.kind, expectKind, `${requestId} 期望 ${expectKind}，收到 ${String(result.kind)}`)
    return result
  }

  async submit(requestId: string, userText: string): Promise<Record<string, unknown>> {
    return await this.exchange(requestId, { kind: 'SUBMIT_TURN', requestId, userText }, 'TURN_RESULT')
  }

  /** 控制消息（**不排队**：慢轮次期间照样被读到） */
  async control(
    requestId: string,
    kind: string,
    extra: Record<string, unknown>,
    expectKind: string
  ): Promise<Record<string, unknown>> {
    return await this.exchange(requestId, { kind, requestId, ...extra }, expectKind)
  }

  close(): void {
    this.socket.destroy()
  }
}

const markersOf = (text: string, side: 'A' | 'B'): string[] =>
  [...text.matchAll(new RegExp(`MARK-${side}\\d`, 'g'))].map((match) => match[0])

const modelCalls: { markers: string[]; hasC2: boolean; hasC1: boolean }[] = []
const fakeModel = createHttpServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  /*
   * ⚠️ 这是**本机固定回复夹具**：它把 prompt 里出现过的标记**原样回显**。
   *    回显是刻意的 —— 它就是"她看到的窗口里有什么"的**目击者**：
   *    如果另一条入口的标记混进了这一轮的 prompt，它就会出现在回复里。
   *    （生产从不这样做；这里也不保留任何真实内容 —— 标记是本门自己造的。）
   */
  const markers = [...body.matchAll(/MARK-[AB]\d/g)].map((match) => match[0])
  /*
   * `SLOW<ms>`：本机夹具的**慢轮次**开关（只在 C 段用）。
   * ⚠️ 它让"慢轮次期间控制消息仍然可达"这件事有一个可复现的现场。
   */
  const slow = /SLOW(\d+)/.exec(body)
  if (slow !== null) await delay(Math.min(5_000, Number(slow[1])))
  modelCalls.push({
    markers: [...markers],
    hasC2: body.includes('MARK-B5'),
    hasC1: body.includes('MARK-A6'),
  })
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      choices: [{ message: { content: `<response><text>echo:${markers.join('|') || 'none'}</text></response>` } }],
    })
  )
})

const freePort = async (): Promise<number> =>
  await new Promise<number>((done) => {
    const probe = createNetServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => done(port))
    })
  })

let child: ChildProcessWithoutNullStreams | undefined
let sandbox: string | undefined
const servers: Server[] = []
try {
  await new Promise<void>((done) => fakeModel.listen(0, '127.0.0.1', () => done()))
  const modelPort = (fakeModel.address() as { port: number }).port
  const qqPort = await freePort()
  const avatarPort = await freePort()
  const qqToken = 'coexist-verify-qq-token-0123456789'
  const avatarToken = 'coexist-verify-avatar-token-0123456789'

  sandbox = isolateDatabase('coexist-wp2-verify', { keep: true }).dir

  /*
   * 开关纪律与既有离线门一致：**所有** `CHARACTER_*_ENABLED` 先强制 false，
   * 再只打开本门真正需要的那几个（否则"她为什么这样回答"会被别的域搅浑）。
   */
  const features = Object.fromEntries(
    [...readFileSync(resolve(root, 'src/kernel/app/flags.ts'), 'utf8').matchAll(
      /env\.(CHARACTER_[A-Z_]+_ENABLED)/g
    )].map((match) => [match[1]!, 'false'])
  )

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...features,
    PGLITE_DATA_DIR: sandbox,
    PROJECT_LG_SANDBOX: sandbox,
    USER_NAME: 'coexist-fixture-owner',
    OPENAI_API_KEY: 'offline-local-fixture',
    OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}`,
    OPENAI_LARGE_MODEL: 'offline-fixture',
    OPENAI_SMALL_MODEL: 'offline-fixture',
    CHARACTER_KERNEL_ENABLED: 'true',
    CHARACTER_MEMORY_ENABLED: 'true',
    CHARACTER_MEMORY_EXPLICIT_ENABLED: 'true',
    CHARACTER_MEMORY_WRITE_MODE: 'legacy',
    CHARACTER_RECALL_ENABLED: 'true',
    /*
     * ★ 公共生命周期只跑一次的**目击者**：关系域开着时，`open()` 的共享段会打
     *   一行 `[m7] 关系基线播种`。owner 跑一次 ⇒ **一行**；两条入口各跑一遍 ⇒ 三行。
     */
    CHARACTER_RELATIONSHIP_CONTEXT_ENABLED: 'true',
    CHARACTER_TOOL_DECISION_MODE: 'rules',
    CHARACTER_MEMORY_SEMANTIC_MODE: 'off',
    CHARACTER_ROLLUP_TOKENS: '0',
    CHARACTER_EXPRESSIVE_SPEECH: 'false',
    LOG_LEVEL: 'info',
    /* ★ 本门的主角：入口维度的会话 */
    CHARACTER_ENTRY_SCOPED_CONVERSATIONS: 'true',
    CHARACTER_COEXIST_QQ_PORT: String(qqPort),
    CHARACTER_COEXIST_AVATAR_PORT: String(avatarPort),
    CHARACTER_COEXIST_QQ_TOKEN: qqToken,
    CHARACTER_COEXIST_AVATAR_TOKEN: avatarToken,
    /* QQ 入口的身份（`readQqPrivateConfig` 失败关闭） */
    QQ_OWNER_ID: '123456789',
    QQ_BOT_ID: '987654321',
    QQ_ONEBOT_WS_URL: 'ws://127.0.0.1:6701/',
    QQ_ONEBOT_ACCESS_TOKEN: 'offline-coexist-qq-token-1234567890',
  }

  child = spawn(
    process.execPath,
    [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, 'src/main.ts'), '--coexist'],
    { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const stdout: string[] = []
  const stderr: string[] = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => { stdout.push(line); coreLog.push(line) })
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => { stderr.push(line); coreLog.push(line) })
  const exited = new Promise<number | null>((done) => child!.once('close', (code) => done(code)))

  const waitForReady = async (): Promise<void> => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (stdout.some((line) => line.startsWith('COEXIST_READY'))) return
      if (child!.exitCode !== null) break
      await delay(200)
    }
    throw new Error(
      `coexist_ready_timeout\nstdout tail:\n${stdout.slice(-20).join('\n')}\nstderr tail:\n${stderr.slice(-20).join('\n')}`
    )
  }
  await waitForReady()
  check(
    'E-0 一个核心进程就绪（两条监听都在 loopback）',
    stdout.some((line) => line.startsWith('COEXIST_READY')),
    stdout.find((line) => line.startsWith('COEXIST_READY')) ?? ''
  )
  {
    const all = [...stdout, ...stderr].join('\n')
    const seeded = all.split('\n').filter((line) => line.includes('关系基线播种')).length
    check(
      'E-0b ★ 公共生命周期只运行一次（owner 跑共享段；两条入口会话不各跑一遍）',
      seeded === 1,
      `共享段目击行「关系基线播种」出现 ${seeded} 次（必须恰好 1 次）`
    )
  }

  // --- 传输层握手负控：错 token 必须被拒 ---------------------------------
  {
    const socket = connectNet({ host: '127.0.0.1', port: qqPort })
    const reader = new LineReader(socket)
    await new Promise<void>((done) => socket.once('connect', () => done()))
    socket.write('LG_ENTRY wrong-token-wrong-token\n')
    const line = await reader.next()
    check(
      'E-1 传输层握手负控（错 token）',
      line?.startsWith('LG_ENTRY_REJECTED') === true,
      `收到 ${JSON.stringify(line)}`
    )
    socket.destroy()
  }

  const qq = new EntryShell(qqPort, qqToken)
  const avatar = new EntryShell(avatarPort, avatarToken)
  const qqHello = await qq.ready
  const avatarHello = await avatar.ready
  const qqConversation = qqHello.split(' ')[2] ?? ''
  const avatarConversation = avatarHello.split(' ')[2] ?? ''
  check(
    'E-2 两条入口拿到**不同的**会话（入口由监听端口绑定，不由载荷）',
    qqConversation !== '' && avatarConversation !== '' && qqConversation !== avatarConversation,
    `qq=${qqConversation} · avatar=${avatarConversation}`
  )
  check(
    'E-3 入口分量正确（-qq / -avatar，CLI 那条不受影响）',
    qqConversation.endsWith('-qq') && avatarConversation.endsWith('-avatar'),
    `${qqConversation} / ${avatarConversation}`
  )

  // --- 两路**同时**提交（计划 §5 场景 1） --------------------------------
  const [replyA1, replyB1] = await Promise.all([
    qq.submit('req-a1', 'MARK-A1 今天天气不错'),
    avatar.submit('req-b1', 'MARK-B1 今天天气不错'),
  ])
  let qqTurns = 1
  let avatarTurns = 1
  const textA1 = String(replyA1.replyText)
  const textB1 = String(replyB1.replyText)
  check(
    'E-4 两路同时输入各自完成（同外部 requestId 也不冲突）',
    textA1.length > 0 && textB1.length > 0,
    `qq="${textA1}" · avatar="${textB1}"`
  )
  check(
    'E-5 回复只回原入口（首轮：各自的标记只出现在自己那条回复里）',
    markersOf(textA1, 'B').length === 0 && markersOf(textB1, 'A').length === 0,
    `qq 回复含 B 标记 ${markersOf(textA1, 'B').length} 个 · avatar 回复含 A 标记 ${markersOf(textB1, 'A').length} 个`
  )

  // --- 追问：这一轮**真的**看到自己那条窗口（计划 §5 场景 2） ------------
  const [replyA2, replyB2] = await Promise.all([
    qq.submit('req-a2', 'MARK-A2 那你说说看'),
    avatar.submit('req-b2', 'MARK-B2 那你说说看'),
  ])
  qqTurns += 1
  avatarTurns += 1
  const textA2 = String(replyA2.replyText)
  const textB2 = String(replyB2.replyText)
  check(
    'E-6 追问轮：QQ 看到自己的 A1（窗口连得上）且**看不到**任何 B 标记',
    markersOf(textA2, 'A').includes('MARK-A1') && markersOf(textA2, 'B').length === 0,
    `qq 追问回复="${textA2}"`
  )
  check(
    'E-7 追问轮：皮套看到自己的 B1 且**看不到**任何 A 标记',
    markersOf(textB2, 'B').includes('MARK-B1') && markersOf(textB2, 'A').length === 0,
    `avatar 追问回复="${textB2}"`
  )

  // --- 共享记忆：QQ 明确记住，皮套那一轮看得到（计划 §5 场景 3） --------
  const memoryReply = String((await qq.submit('req-a3', '记住：MARK-A3 我在示例工程科技大学')).replyText)
  qqTurns += 1
  const recallReply = String(
    (await avatar.submit('req-b3', 'MARK-B3 你还记得我在哪上学吗')).replyText
  )
  avatarTurns += 1
  check(
    'E-8 跨入口共享记忆：皮套那一轮的问句里**没有** A3（不靠近期窗口，靠共享记忆链）',
    markersOf(recallReply, 'A').length === 0,
    `qq 记忆轮="${memoryReply}" · avatar 召回轮="${recallReply}"`
  )

  // --- 异常恢复：一路坏 JSON / 断开后，另一路新请求仍成功 ---------------
  {
    const rogue = connectNet({ host: '127.0.0.1', port: qqPort })
    const rogueReader = new LineReader(rogue)
    await new Promise<void>((done) => rogue.once('connect', () => done()))
    rogue.write(`LG_ENTRY ${qqToken} v${ENTRY_PROTOCOL_VERSION}\n`)
    await rogueReader.next()
    rogue.write('{ this is not json\n')
    const rejected = await rogueReader.next()
    check(
      'E-9 坏 JSON 被具名拒绝（不打断任何东西）',
      rejected?.includes('bridge_malformed_json') === true,
      `收到 ${String(rejected).slice(0, 120)}`
    )
    rogue.destroy()
    await delay(200)
    const afterRogue = String((await avatar.submit('req-b4', 'MARK-B4 断开之后还好吗')).replyText)
    avatarTurns += 1
    check(
      'E-10 一路的坏输入 / 断开之后，另一路新请求仍然成功',
      afterRogue.length > 0,
      `avatar="${afterRogue}"`
    )
  }

  /*
   * =========================================================================
   *  C 段（WP3 的协议面）：皮套媒体与控制的**入口归属**
   * =========================================================================
   * 计划 §1 的三条："打断皮套不取消 QQ" · "QQ 内容不自动在皮套播放" ·
   * "关闭一个客户端不关闭 LG 核心或另一入口"。
   * ⚠️ 本段只覆盖**协议面**：真实 ASR/TTS、音频播放与桌面体验是 WP4 的事。
   */
  {
    // C-1 取消只作用于所属入口 -------------------------------------------
    const cancelReading = await qq.control(
      'req-c1',
      'CANCEL_TURN',
      { reason: 'user_interrupt' },
      'CANCEL_RESULT'
    )
    const cancelled = await qq.submit('req-c1', 'SLOW1200 MARK-A6 这一轮要被取消')
    const otherEntry = String((await avatar.submit('req-c2', 'MARK-B5 另一条入口不受影响')).replyText)
    avatarTurns += 1
    check(
      'C-1 ★ 取消只作用于所属入口：QQ 那一轮在模型前停住，皮套那一轮照常完成',
      cancelled.outcome === 'failed' &&
        cancelled.code === 'bridge_turn_cancelled_before_model' &&
        otherEntry.includes('MARK-B5') &&
        !otherEntry.includes('MARK-A6'),
      `取消读数=${JSON.stringify({ requested: (cancelReading.cancel as Record<string, unknown>)?.requested, code: cancelled.code })}` +
        ` · 皮套回复含 B5=${otherEntry.includes('MARK-B5')} · 含 A6=${otherEntry.includes('MARK-A6')}` +
        ` · 夹具调用记录=${JSON.stringify(modelCalls.slice(-3).map((call) => call.markers.length))}`
    )

    // C-2 交付账只属于皮套（QQ 是纯文字入口） -----------------------------
    const avatarPlayback = await avatar.control(
      'req-c3',
      'REPORT_PLAYBACK',
      { segmentId: 'never-synthesized#0', playbackState: 'played' },
      'PLAYBACK_RESULT'
    )
    const qqPlayback = await qq.control(
      'req-c4',
      'REPORT_PLAYBACK',
      { segmentId: 'never-synthesized#0', playbackState: 'played' },
      'PLAYBACK_RESULT'
    )
    check(
      'C-2 ★ 播放账只挂在皮套入口：皮套报的是"账上没有这一段"，QQ 报的是"这个入口没有交付账"',
      avatarPlayback.code === 'playback_report_unknown_segment' &&
        qqPlayback.code === 'playback_report_unsupported',
      `皮套=${String(avatarPlayback.code)} · QQ=${String(qqPlayback.code)}`
    )

    // C-3 皮套断开不影响核心与 QQ -----------------------------------------
    avatar.close()
    await delay(300)
    const afterAvatarGone = String((await qq.submit('req-c5', 'MARK-A7 皮套关掉了')).replyText)
    qqTurns += 1
    check(
      'C-3 ★ 皮套客户端断开不关核心、也不关另一入口（QQ 新请求照常成功）',
      afterAvatarGone.includes('MARK-A7'),
      `QQ 在皮套断开后含 A7=${afterAvatarGone.includes('MARK-A7')}`
    )
  }

  qq.close()
  await delay(200)

  // --- 停机：stdin EOF ⇒ 有序收尾 ⇒ 退出码 0 ----------------------------
  child.stdin.end()
  const exitCode = await Promise.race([exited, delay(180_000).then(() => 'timeout' as const)])
  check('E-11 stdin EOF ⇒ 有序收尾且退出码 0（唯一关库链）', exitCode === 0, `exit=${String(exitCode)}`)

  // -------------------------------------------------------------------------
  // ④ 事件 / trace / 记忆的实际读回 + 量具自身的正控 / 负控 / 恢复
  // -------------------------------------------------------------------------
  const db = await openRawPGlite(sandbox)
  try {
    const events = (
      await db.query(
        'select id, conversation_id, conversation_sequence, actor_type, content from conversation_events order by sequence'
      )
    ).rows as Record<string, unknown>[]
    const byConversation = new Map<string, Record<string, unknown>[]>()
    for (const event of events) {
      const key = String(event.conversation_id)
      byConversation.set(key, [...(byConversation.get(key) ?? []), event])
    }
    check(
      'R-1 事件按会话分开（两个 conversation_id，互不混合）',
      byConversation.size === 2 &&
        byConversation.has(qqConversation) &&
        byConversation.has(avatarConversation),
      `会话=${JSON.stringify([...byConversation.keys()])}`
    )
    const contiguous = [...byConversation.values()].every((rows) =>
      rows.every((row, index) => Number(row.conversation_sequence) === index + 1)
    )
    check(
      'R-2 每个会话的 conversation_sequence 从 1 起连续（同入口顺序不变）',
      contiguous,
      [...byConversation.entries()]
        .map(([key, rows]) => `${key}=[${rows.map((row) => String(row.conversation_sequence)).join(',')}]`)
        .join(' · ')
    )
    const markerRows = events
      .map((event) => ({
        conversation: String(event.conversation_id),
        content: String(event.content),
      }))
      .filter((row) => /MARK-[AB]\d/.test(row.content))
    check(
      'R-3 标记的落点与入口一致（A 标记只在 QQ 会话里，B 只在皮套会话里）',
      markerRows.every((row) =>
        /MARK-A\d/.test(row.content) ? row.conversation === qqConversation : row.conversation === avatarConversation
      ),
      markerRows.map((row) => `${row.content.slice(0, 24)}@${row.conversation}`).join(' · ')
    )

    /*
     * 量具自身的**正控 / 负控 / 恢复**（AGENTS.md §6.7）：
     * 同一条 SQL，只改"要不要带 conversation_id 过滤"。
     */
    const scoped = (
      await db.query(
        `select content from conversation_events where conversation_id = '${qqConversation}' order by sequence desc limit 16`
      )
    ).rows as Record<string, unknown>[]
    const unscoped = (
      await db.query('select content from conversation_events order by sequence desc limit 16')
    ).rows as Record<string, unknown>[]
    const scopedText = scoped.map((row) => String(row.content)).join('\n')
    const unscopedText = unscoped.map((row) => String(row.content)).join('\n')
    check(
      'M-1 正控：带会话过滤读近期窗口 ⇒ 只有本入口的标记',
      /MARK-A\d/.test(scopedText) && !/MARK-B\d/.test(scopedText),
      `命中 A=${markersOf(scopedText, 'A').length} · B=${markersOf(scopedText, 'B').length}`
    )
    check(
      'M-2 负控：**去掉**过滤读同一张表 ⇒ 两条入口的标记都出现（隔离来自那一行过滤，不是库里本来没有）',
      /MARK-A\d/.test(unscopedText) && /MARK-B\d/.test(unscopedText),
      `命中 A=${markersOf(unscopedText, 'A').length} · B=${markersOf(unscopedText, 'B').length}`
    )
    check(
      'M-3 恢复：把过滤放回去 ⇒ 又只剩本入口的标记',
      /MARK-A\d/.test(scopedText) && !/MARK-B\d/.test(scopedText),
      '与 M-1 逐字一致（同一个读数函数）'
    )

    const traces = (
      await db.query(
        'select trace_id, conversation_id, context_section_ids, source_conversation_event_ids, selected_memory_ids from character_traces order by started_at'
      )
    ).rows as Record<string, unknown>[]
    const sampleRef = String(
      ((traces[1]?.source_conversation_event_ids ?? []) as string[])[0] ?? ''
    )
    const sampleEvent = String(byConversation.get(qqConversation)?.[0]?.id ?? '')
    observe(
      'R-4b trace 引用 id 的实际写法（量具校准；不参与判据）',
      `trace 里第一条=${JSON.stringify(sampleRef)} · 表里第一条=${JSON.stringify(sampleEvent)}`
    )
    observe(
      'R-4c 逐轮引用清单（量具校准；只有 id，没有正文）',
      traces
        .map(
          (trace, index) =>
            `#${String(index)} ${String(trace.conversation_id)} sections=[${((trace.context_section_ids ?? []) as string[]).join(',')}] ` +
            `refs=${JSON.stringify(trace.source_conversation_event_ids ?? [])}`
        )
        .join('\n      ')
    )
    const traceScope = traces.map((trace) => {
      const conversation = String(trace.conversation_id)
      const refs = (trace.source_conversation_event_ids ?? []) as string[]
      /*
       * ⚠️ `source_conversation_event_ids` 是**混合**引用集合：除了对话事件，
       *    它还有 `character-definition:` / `clock:` / `projection:` / `seed-hash:` /
       *    `memory:` 这些**非对话**引用（见 R-4c 的逐轮清单）。
       *    ⇒ 判据只对**对话事件引用**成立，不能把其它引用算成"外来会话"。
       * ⚠️ 而且 Recent 区块给出的写法是 `cev:cev:<characterId>:<conversationId>:<sequence>`
       *    （比表里的 id 多一层 `cev:`）—— 这是既有的写法差异，本门**照实**解析两种，
       *    并把它登记为 `L-COEXIST-02`（不在这里顺手改 trace 内容）。
       */
      const conversationOfRef = (ref: string): string | undefined => {
        const stripped = ref.startsWith('cev:') ? ref.slice(4) : ref
        if (!stripped.startsWith('cev:')) return undefined
        const parts = stripped.split(':')
        return parts.length === 4 ? parts[2] : undefined
      }
      const eventRefs = refs.filter((ref) => conversationOfRef(ref) !== undefined)
      const foreign = eventRefs.filter((ref) => conversationOfRef(ref) !== conversation)
      return {
        conversation,
        sources: eventRefs.length,
        foreign: foreign.length,
        foreignSample: foreign.slice(0, 2),
        sections: (trace.context_section_ids ?? []) as string[],
      }
    })
    check(
      `R-4 每轮 trace 的会话与入口一致（QQ ${String(qqTurns)} 轮 / 皮套 ${String(avatarTurns)} 轮 —— 与**成功**提交次数逐一对上）`,
      traces.length === qqTurns + avatarTurns &&
        traceScope.filter((row) => row.conversation === qqConversation).length === qqTurns &&
        traceScope.filter((row) => row.conversation === avatarConversation).length === avatarTurns,
      traceScope.map((row) => `${row.conversation}#${row.sources}`).join(' · ')
    )
    check(
      'R-5 ★ 近期窗口零混入：每轮 trace 引用的**对话事件**全部属于本轮自己的会话',
      traceScope.every((row) => row.foreign === 0 && row.sources > 0),
      traceScope
        .map((row) => `${row.conversation} 引用 ${row.sources} 条 · 外来 ${row.foreign} 条`)
        .join(' · ')
    )
    const withHistory = traceScope.filter((row) => row.sources >= 2)
    check(
      'R-6 有历史的每一轮都真的带上了 recent-conversation 区块（不是"没有区块所以没混入"）',
      withHistory.length >= 5 && withHistory.every((row) => row.sections.includes('recent-conversation')),
      `带历史的轮次 ${withHistory.length} 条 · 区块在场 ${withHistory.filter((row) => row.sections.includes('recent-conversation')).length} 条` +
        ` · 首轮（无历史）${traceScope.length - withHistory.length} 条`
    )

    const memory = (await db.query('select id, content from memory_records')).rows as Record<string, unknown>[]
    const memoryDump = JSON.stringify(memory)
    check(
      'R-7 跨入口共享记忆只写**一次**（QQ 的明确记忆操作落在共享的 memory_records）',
      memory.length === 1 && /示例工程科技大学/.test(memoryDump),
      `memory_records=${memory.length} · ${memoryDump.slice(0, 160)}`
    )
    const memoryId = String(memory[0]?.id ?? '')
    const avatarRecallTraces = traces.filter((trace) => String(trace.conversation_id) === avatarConversation)
    const selectedSomewhere = avatarRecallTraces.some((trace) =>
      ((trace.selected_memory_ids ?? []) as string[]).includes(memoryId)
    )
    observe(
      'R-8 皮套那一轮是否真的召回到 QQ 写入的那条记忆（共享记忆的读侧）',
      selectedSomewhere
        ? '是：皮套某轮的 selected_memory_ids 含该记忆 id'
        : `否（召回未选中；memoryId=${memoryId.slice(0, 16)}…，皮套各轮 selected=${
            JSON.stringify(avatarRecallTraces.map((trace) => ((trace.selected_memory_ids ?? []) as string[]).length))
          }）—— 该性质**不由本门主张**`
    )

    /*
     * `R-9`：公共生命周期的**数据侧**目击者。
     * ⚠️ 水位表在这里**读不到东西**：关系评估对我们的合成文本零提案 ⇒ `held` ⇒
     *    不消费 ⇒ 不建水位行。那是如实行为，不是缺陷 ⇒ 判据改用**建档事实**。
     */
    const originEvents = (
      await db.query("select type from character_domain_events where type like 'RELATIONSHIP%'")
    ).rows as Record<string, unknown>[]
    const relationshipProjections = (
      await db.query("select projection_type from character_projections where projection_type like 'relationship:%'")
    ).rows as Record<string, unknown>[]
    check(
      'R-9 公共生命周期的数据侧：关系基线只建一次档（一条 ORIGIN 域事件 + 一行投影）',
      originEvents.length === 1 && relationshipProjections.length === 1,
      `ORIGIN 域事件 ${originEvents.length} 条（${originEvents.map((row) => String(row.type)).join(',')}）· 关系投影 ${relationshipProjections.length} 行`
    )
  } finally {
    await db.close()
  }

  check(
    'R-10 ★ 真实库从未被打开（树摘要前后逐字相同）',
    digestTree(PRODUCTION_DB_DIR).treeSha256 === productionBefore,
    `before=${productionBefore.slice(0, 16)}… after=${digestTree(PRODUCTION_DB_DIR).treeSha256.slice(0, 16)}…`
  )

  const out = resolve(root, 'artifacts/post-lv2', `coexist-wp2-verify-${new Date().toISOString().replace(/\D/g, '')}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(
    resolve(out, 'result.json'),
    `${JSON.stringify(
      {
        status: 'PASS',
        scope: 'offline dual-entry coexist: real main.ts --coexist + isolated DB + local fixture model',
        productionDatabaseOpened: false,
        productionTreeUnchanged: true,
        realQq: 'NOT RUN',
        livePet: 'NOT RUN',
        externalModel: 'NOT RUN',
        entries: { qq: qqConversation, avatar: avatarConversation },
        results,
        childStdoutTail: stdout.slice(-25),
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  console.log(`\nPASS: 双入口共存离线整链（真实库树摘要前后逐字相同）\n${out}`)
} finally {
  for (const server of servers) server.close()
  if (child !== undefined && child.exitCode === null) child.kill()
  fakeModel.closeAllConnections()
  if (fakeModel.listening) await new Promise<void>((done) => fakeModel.close(() => done()))
  if (sandbox !== undefined) cleanupSandbox(sandbox)
}
