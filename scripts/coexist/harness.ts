/**
 * post-Lv2 / ADR-109 —— **双入口共存验收的共用夹具**（只给 `scripts/` 里的门用）。
 *
 * ============================================================================
 *  为什么要有这个模块
 * ============================================================================
 * `postlv2:coexist:verify`（WP2/WP3 的整链门）与 `postlv2:coexist:matrix`
 * （WP4 的场景矩阵 + 性能）需要**同一套**机器：真 `src/main.ts --coexist`、
 * 两条模拟外壳、一个本机固定回复夹具、隔离库。
 *
 * ⚠️ 两处各写一份必然漂开（本仓库已经为这条付过代价）⇒ 夹具只此一份。
 * ⚠️ 它**不**碰生产库、**不**连真实 QQ/皮套、**不**调外部模型。
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, connect as connectNet, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const ROOT = resolve(import.meta.dirname, '..', '..')
export { delay }

// ---------------------------------------------------------------------------
// 读数记录器
// ---------------------------------------------------------------------------

export type Verdict = 'PASS' | 'FAIL' | 'OBSERVED' | 'NOT RUN' | 'N/A'

export interface Recorder {
  readonly results: { id: string; verdict: Verdict; detail: string }[]
  /** 判据：不通过**立即抛**（门是失败关闭的） */
  check(id: string, ok: boolean, detail: string): void
  /** 只记读数、不做判据 */
  observe(id: string, detail: string): void
  /** 如实登记"没跑"（不是 PASS，也不是 FAIL） */
  notRun(id: string, detail: string): void
  /** 如实登记"不适用" */
  notApplicable(id: string, detail: string): void
}

export function createRecorder(): Recorder {
  const results: { id: string; verdict: Verdict; detail: string }[] = []
  const push = (id: string, verdict: Verdict, detail: string): void => {
    results.push({ id, verdict, detail })
    console.log(`[${verdict}] ${id} :: ${detail}`)
  }
  return {
    results,
    check(id, ok, detail) {
      push(id, ok ? 'PASS' : 'FAIL', detail)
      if (!ok) throw new Error(`${id} 未通过：${detail}`)
    },
    observe(id, detail) {
      push(id, 'OBSERVED', detail)
    },
    notRun(id, detail) {
      push(id, 'NOT RUN', detail)
    },
    notApplicable(id, detail) {
      push(id, 'N/A', detail)
    },
  }
}

// ---------------------------------------------------------------------------
// 按行读一个 socket（与 `main.ts` 的 `SocketLineReader` 同形；脚本不能 import 那个文件）
// ---------------------------------------------------------------------------

export class LineReader {
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

// ---------------------------------------------------------------------------
// 一条入口的模拟外壳（TCP + 传输层握手 + NDJSON 桥协议）
// ---------------------------------------------------------------------------

export class EntryShell {
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
      this.socket.write(`LG_ENTRY ${token}\n`)
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
      /*
       * ⚠️ 等待者按 **`<kind>|<requestId>`** 登记（不是只按 requestId）：
       *    同一个 requestId 上可能同时有两种回复在等（`TURN_RESULT` 与 `CANCEL_RESULT`），
       *    只按 requestId 会让后登记的**顶掉**先登记的 ⇒ 前一个永远等不到（假超时）。
       */
      const waiter = this.pending.get(`${String(parsed.kind)}|${requestId}`)
      if (waiter !== undefined) {
        this.pending.delete(`${String(parsed.kind)}|${requestId}`)
        waiter(parsed)
      }
    }
  }

  get protocolLines(): readonly string[] {
    return this.seen.filter((line) => line.startsWith('{'))
  }

  private async exchange(
    requestId: string,
    payload: Record<string, unknown>,
    expectKind: string | undefined,
    timeoutMs = 180_000
  ): Promise<Record<string, unknown>> {
    const key = `${expectKind ?? ''}|${requestId}`
    const answer = new Promise<Record<string, unknown>>((done) => this.pending.set(key, done))
    this.socket.write(`${JSON.stringify(payload)}\n`)
    let timer: ReturnType<typeof setTimeout> | undefined
    let result: Record<string, unknown>
    try {
      result = await Promise.race([answer, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`entry_exchange_timeout: ${requestId}`)), timeoutMs)
      })])
    } finally { clearTimeout(timer); this.pending.delete(key) }
    if (expectKind !== undefined) {
      assert.equal(result.kind, expectKind, `${requestId} 期望 ${expectKind}，收到 ${String(result.kind)}`)
    }
    return result
  }

  async submit(requestId: string, userText: string): Promise<Record<string, unknown>> {
    return await this.exchange(requestId, { kind: 'SUBMIT_TURN', requestId, userText }, 'TURN_RESULT')
  }

  /**
   * 提交时**额外塞字段**（只给"伪造载荷"的负控用）。
   *
   * ⚠️ 它存在的理由就是证明那些字段**不起作用**：入口由监听端口绑定，
   *    载荷里的 `entry` / `conversationId` / `userId` / `characterId` 都改不了落点。
   */
  async submitWithForgedFields(
    requestId: string,
    userText: string,
    forged: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return await this.exchange(
      requestId,
      { kind: 'SUBMIT_TURN', requestId, userText, ...forged },
      'TURN_RESULT'
    )
  }

  /** 只发不等（用于"取消一条**正在排队**的请求"这种需要真并发的形状） */
  fire(requestId: string, userText: string): void {
    this.socket.write(`${JSON.stringify({ kind: 'SUBMIT_TURN', requestId, userText })}\n`)
  }

  /** 等某条已 `fire` 的轮次的结果 */
  async awaitTurn(requestId: string, timeoutMs = 180_000): Promise<Record<string, unknown>> {
    const key = `TURN_RESULT|${requestId}`
    const answer = new Promise<Record<string, unknown>>((done) => this.pending.set(key, done))
    return await Promise.race([
      answer,
      delay(timeoutMs).then(() => {
        throw new Error(`entry_turn_timeout: ${requestId}`)
      }),
    ])
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

// ---------------------------------------------------------------------------
// 本机固定回复夹具（**不调外部模型**）
// ---------------------------------------------------------------------------

export interface FakeModel {
  readonly port: number
  readonly calls: { markers: string[]; slowMs: number }[]
  close(): Promise<void>
}

/**
 * 把 prompt 里出现过的标记**原样回显**。
 *
 * ⚠️ 回显是刻意的：它就是"她看到的窗口里有什么"的**目击者** ——
 *    另一条入口的标记若混进了这一轮的 prompt，就会出现在回复里。
 * ⚠️ `SLOW<ms>`：慢轮次开关（有界，最多 5s）。
 * ⚠️ `failMarker`：命中它的请求回 500 —— **要连回 `failAttempts` 次**才真的让一轮失败，
 *    因为生产模型调用本身有**有界重试**（`MODEL_CALL_MAX_ATTEMPTS = 3`，`src/providers/model-retry.ts`）。
 *    ⚠️ 这条是实测踩出来的：只回一次 500 时，重试的那次成功了 ⇒ 轮次照常 `replied`，
 *    于是"模型失败后恢复"这条判据会**假绿**（测的不是它以为的那件事）。
 */
export async function startFakeModel(
  options: { failMarker?: string; failAttempts?: number } = {}
): Promise<FakeModel> {
  const calls: { markers: string[]; slowMs: number }[] = []
  const failAttempts = options.failAttempts ?? 3
  let failuresServed = 0
  const server: HttpServer = createHttpServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const markers = [...body.matchAll(/MARK-[AB]\d+/g)].map((match) => match[0])
    const slow = /SLOW(\d+)/.exec(body)
    const slowMs = slow === null ? 0 : Math.min(5_000, Number(slow[1]))
    calls.push({ markers, slowMs })
    if (slowMs > 0) await delay(slowMs)
    if (
      options.failMarker !== undefined &&
      failuresServed < failAttempts &&
      body.includes(options.failMarker)
    ) {
      failuresServed += 1
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'fixture-model-failed' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [
          { message: { content: `<response><text>echo:${markers.join('|') || 'none'}</text></response>` } },
        ],
      })
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const port = (server.address() as { port: number }).port
  return {
    port,
    calls,
    async close() {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

export const markersOf = (text: string, side: 'A' | 'B'): string[] =>
  [...text.matchAll(new RegExp(`MARK-${side}\\d+`, 'g'))].map((match) => match[0])

// ---------------------------------------------------------------------------
// 起一个真 `src/main.ts --coexist`
// ---------------------------------------------------------------------------

export async function freePort(): Promise<number> {
  return await new Promise<number>((done) => {
    const probe = createNetServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => done(port))
    })
  })
}

/** 所有 `CHARACTER_*_ENABLED` 一律先关（本机夹具只该看到它该看的域） */
export function allFeatureSwitchesOff(): Record<string, string> {
  return Object.fromEntries(
    [...readFileSync(resolve(ROOT, 'src/kernel/app/flags.ts'), 'utf8').matchAll(
      /env\.(CHARACTER_[A-Z_]+_ENABLED)/g
    )].map((match) => [match[1]!, 'false'])
  )
}

export interface CoexistHost {
  readonly child: ChildProcessWithoutNullStreams
  readonly stdout: string[]
  readonly stderr: string[]
  readonly qqPort: number
  readonly avatarPort: number
  readonly qqToken: string
  readonly avatarToken: string
  /** 等 `COEXIST_READY` */
  readonly ready: Promise<string>
  /** 关 stdin（有序停机）并等退出码 */
  stop(): Promise<number | null>
  /** 调度读数（从收尾日志里解析；**不含正文**） */
  schedulerReadings(): { entry: string; waitMs: number; runMs: number; outcome: string }[]
  kill(): void
}

export async function startCoexistHost(input: {
  /** 隔离库目录（`PGLITE_DATA_DIR` / `PROJECT_LG_SANDBOX`） */
  dbDir: string
  modelPort: number
  /** 覆盖/追加的 env（在"全关"之上） */
  env?: Record<string, string>
  userName?: string
  qqPort?: number
  avatarPort?: number
  queueBound?: number
}): Promise<CoexistHost> {
  const qqPort = input.qqPort ?? (await freePort())
  const avatarPort = input.avatarPort ?? (await freePort())
  const qqToken = 'coexist-harness-qq-token-0123456789'
  const avatarToken = 'coexist-harness-avatar-token-0123456789'
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...allFeatureSwitchesOff(),
    PGLITE_DATA_DIR: input.dbDir,
    PROJECT_LG_SANDBOX: input.dbDir,
    USER_NAME: input.userName ?? 'coexist-fixture-owner',
    OPENAI_API_KEY: 'offline-local-fixture',
    OPENAI_BASE_URL: `http://127.0.0.1:${String(input.modelPort)}`,
    OPENAI_LARGE_MODEL: 'offline-fixture',
    OPENAI_SMALL_MODEL: 'offline-fixture',
    CHARACTER_KERNEL_ENABLED: 'true',
    CHARACTER_MEMORY_ENABLED: 'true',
    CHARACTER_MEMORY_EXPLICIT_ENABLED: 'true',
    CHARACTER_TOOL_DECISION_MODE: 'rules',
    CHARACTER_MEMORY_SEMANTIC_MODE: 'off',
    CHARACTER_MEMORY_WRITE_MODE: 'legacy',
    CHARACTER_ROLLUP_TOKENS: '0',
    CHARACTER_EXPRESSIVE_SPEECH: 'false',
    CHARACTER_ENTRY_SCOPED_CONVERSATIONS: 'true',
    CHARACTER_COEXIST_QQ_PORT: String(qqPort),
    CHARACTER_COEXIST_AVATAR_PORT: String(avatarPort),
    CHARACTER_COEXIST_QQ_TOKEN: qqToken,
    CHARACTER_COEXIST_AVATAR_TOKEN: avatarToken,
    ...(input.queueBound === undefined ? {} : { CHARACTER_COEXIST_QUEUE_BOUND: String(input.queueBound) }),
    QQ_OWNER_ID: '123456789',
    QQ_BOT_ID: '987654321',
    QQ_ONEBOT_WS_URL: 'ws://127.0.0.1:6701/',
    QQ_ONEBOT_ACCESS_TOKEN: 'offline-coexist-qq-token-1234567890',
    LOG_LEVEL: 'info',
    ...(input.env ?? {}),
  }
  const child = spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'), resolve(ROOT, 'src/main.ts'), '--coexist'],
    { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const stdout: string[] = []
  const stderr: string[] = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => stdout.push(line))
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => stderr.push(line))
  const exited = new Promise<number | null>((done) => child.once('close', (code) => done(code)))
  const ready = (async () => {
    for (let attempt = 0; attempt < 900; attempt += 1) {
      const line = stdout.find((candidate) => candidate.startsWith('COEXIST_READY'))
      if (line !== undefined) return line
      if (child.exitCode !== null) break
      await delay(200)
    }
    throw new Error(
      `coexist_ready_timeout\nstdout tail:\n${stdout.slice(-25).join('\n')}\nstderr tail:\n${stderr.slice(-25).join('\n')}`
    )
  })()
  return {
    child,
    stdout,
    stderr,
    qqPort,
    avatarPort,
    qqToken,
    avatarToken,
    ready,
    async stop() {
      child.stdin.end()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('coexist_stop_timeout')), 180_000)
        })])
      } finally { clearTimeout(timer) }
    },
    schedulerReadings() {
      const line = [...stdout, ...stderr].find((candidate) => candidate.includes('调度读数'))
      if (line === undefined) return []
      /*
       * ⚠️ 用**最后**一个 `[`：日志前缀本身带方括号（`[coexist]`），
       *    取第一个会把前缀也切进 JSON ⇒ 解析失败 ⇒ 读数看起来"是 0 条"（假空）。
       */
      const start = line.lastIndexOf('[')
      const end = line.lastIndexOf(']')
      if (start < 0 || end < 0 || end < start) return []
      try {
        return JSON.parse(line.slice(start, end + 1)) as {
          entry: string
          waitMs: number
          runMs: number
          outcome: string
        }[]
      } catch {
        return []
      }
    },
    kill() {
      if (child.exitCode === null) child.kill()
    },
  }
}

/** 一次跑完的落盘（证据） */
export function writeEvidence(label: string, payload: Record<string, unknown>): string {
  const out = resolve(ROOT, 'artifacts/post-lv2', `${label}-${new Date().toISOString().replace(/\D/g, '')}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(resolve(out, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return out
}
