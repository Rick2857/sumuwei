/**
 * ADR-131 · **整链门**：真核心 + 真 socket + 真握手 ⇒ 机会报文走完整条 LG 侧链路。
 *
 * ============================================================================
 *  它回答什么（`L-APO-10`：整条链**一次都没真跑过**）
 * ============================================================================
 * ```text
 * 此前所有读数都来自**离线**（假端口 / 纯函数）。本门补的是：
 *   "真 `src/main.ts --coexist` + 真 TCP + 真 `LG_ENTRY` 握手 ⇒
 *    机会报文进去 ⇒ `OPPORTUNITY_RESULT` 出来 ⇒ 而且具名"
 * ```
 *
 * ============================================================================
 *  真的东西 / 假的东西（必须分清）
 * ============================================================================
 * ```text
 * 真：`src/main.ts --coexist`  —— 生产入口、真内核、真桥、真入口服务器
 * 真：TCP + `LG_ENTRY <token>`  —— 真握手、真换行分隔 JSON（本门自己写的最小外壳）
 * 真：机会报文与回执             —— 真 `PROACTIVE_OPPORTUNITY` / `OPPORTUNITY_RESULT`
 * 假：模型                       —— `startFakeModel` 的离线夹具（本门用它**数调用次数**）
 * 假：库                         —— 隔离库（INC-01：**绝不**打开真实库）
 * ```
 * ⇒ 结论**只**能说："真核心 → 真 socket 这一条链通了，且那条具名拒绝是对的"。
 *   ⚠️ **不许**说成"她能主动开口了" —— 那要**非空依据**（见 §5 未取读数）。
 *
 * ============================================================================
 *  ⚠️ 判据**顺序**决定了本门能观察到什么（不是"我没想到"）
 * ============================================================================
 * 预检的顺序是：形状 → 幂等 → 暂停/入口/在途/时段 → 空闲/冷却/额度 → **依据集** → 她/用户/活客户端。
 * 而隔离库是**空**的 ⇒ 依据集必空 ⇒ 在真链上：
 * ```text
 * 可观察：`opening_without_evidence`（依据集那条，**且零模型调用**）
 *         `opening_packet_shape_invalid`（形状那条）
 * **不可观察**：`opening_no_live_client`（它在依据集**之后**，空库走不到）
 *         `opening_opportunity_already_handled`（幂等也在**记额之前** ⇒ 从没记过额）
 * ⇒ 这两条**如实标 NOT RUN**，不拿"别的拒发生了"去代表它们。
 * ```
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { createRecorder, freePort, startFakeModel, writeEvidence, ROOT } from './coexist/harness.ts'
import { cleanupSandbox, isolateDatabase } from '../src/dev/sandbox.ts'
import { latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'
import { ENTRY_PROTOCOL_VERSION } from '../src/infrastructure/qq/entry-handshake.ts'

const recorder = createRecorder()
const { check, observe, notRun } = recorder

/* ---------------------------------------------------------------------------
 * 最小真实外壳（**只有本门用它**）
 * ---------------------------------------------------------------------------
 * ⚠️ 它不是生产外壳（`scripts/postlv2_vtuber_runtime.py` 要 VTuber 依赖与模型资产）。
 *    它只做三件事：真 TCP、真 `LG_ENTRY` 握手、真换行分隔 JSON。
 * ⚠️ 这正是 `postlv2:qq-proactive:chain` 那条"门用外壳"的先例，
 *    区别只是：那边的外壳是生产类，这边的最小到只剩协议。
 */
class MinimalOpeningShell {
  private readonly socket: Socket
  private buffer = ''
  private readonly lines: string[] = []
  private resumers: (() => void)[] = []

  private constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let index = this.buffer.indexOf('\n')
      while (index >= 0) {
        this.lines.push(this.buffer.slice(0, index))
        this.buffer = this.buffer.slice(index + 1)
        index = this.buffer.indexOf('\n')
      }
      for (const resume of this.resumers.splice(0)) resume()
    })
  }

  static async connect(port: number, token: string): Promise<{ shell: MinimalOpeningShell; conversationId: string }> {
    const socket = connect({ host: '127.0.0.1', port })
    await new Promise<void>((done, fail) => {
      socket.once('connect', () => done())
      socket.once('error', fail)
    })
    const shell = new MinimalOpeningShell(socket)
    shell.write(`LG_ENTRY ${token} v${ENTRY_PROTOCOL_VERSION}`)
    const hello = await shell.nextLine(10_000)
    if (hello === undefined || !hello.startsWith('LG_ENTRY_READY')) {
      throw new Error(`handshake_failed:${hello ?? 'timeout'}`)
    }
    return { shell, conversationId: hello.split(' ')[2] ?? '' }
  }

  write(line: string): void {
    this.socket.write(`${line}\n`)
  }

  send(packet: Record<string, unknown>): void {
    this.write(JSON.stringify(packet))
  }

  async nextLine(timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs
    while (this.lines.length === 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return undefined
      await Promise.race([
        new Promise<void>((resume) => this.resumers.push(resume)),
        delay(remaining),
      ])
    }
    return this.lines.shift()
  }

  /** 等到一条**指定 kind** 的报文（跳过别的；<=64 条为界） */
  async awaitKind(kind: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    const deadline = Date.now() + timeoutMs
    for (let seen = 0; seen < 64; seen += 1) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return undefined
      const line = await this.nextLine(remaining)
      if (line === undefined) return undefined
      if (line.trim() === '') continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (parsed.kind === kind) return parsed
    }
    return undefined
  }

  close(): void {
    this.socket.destroy()
  }
}

/* ---------------------------------------------------------------------------
 * 起一个真核心（按 `qqProactiveMode` 分档）
 * ---------------------------------------------------------------------------
 * ⚠️ 本门**不用** `harness.startCoexistHost`：它把能开的开关都关了，
 *    而**皮套入口的出站口**依赖 `qqProactiveMode !== 'off'`（那是我在 WP5b-1 登记的
 *    真实耦合）⇒ 这里自己 spawn，好把那一档显式写出来。
 */
async function startCore(input: {
  dbDir: string
  modelPort: number
  qqProactiveMode: 'on' | 'off'
  /** ★ ADR-131 的开关（代码缺省 `off`）——本门用它验证"off ⇒ 端口不注入" */
  avatarOpeningMode: 'on' | 'off'
  avatarPort: number
}): Promise<{ child: ChildProcess; ready: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGLITE_DATA_DIR: input.dbDir,
    PROJECT_LG_SANDBOX: input.dbDir,
    USER_NAME: 'opening-chain-owner',
    OPENAI_API_KEY: 'offline-local-fixture',
    OPENAI_BASE_URL: `http://127.0.0.1:${String(input.modelPort)}`,
    OPENAI_LARGE_MODEL: 'offline-fixture',
    OPENAI_SMALL_MODEL: 'offline-fixture',
    CHARACTER_KERNEL_ENABLED: 'true',
    CHARACTER_ENTRY_SCOPED_CONVERSATIONS: 'true',
    /* ★ 这一行就是那条耦合：皮套的出站口靠它才绑得上 */
    CHARACTER_QQ_PROACTIVE_MODE: input.qqProactiveMode,
    /* ★ 本 ADR 自己的开关（代码缺省 off） */
    CHARACTER_AVATAR_OPENING_MODE: input.avatarOpeningMode,
    CHARACTER_COEXIST_QQ_PORT: String(await freePort()),
    CHARACTER_COEXIST_AVATAR_PORT: String(input.avatarPort),
    CHARACTER_COEXIST_QQ_TOKEN: 'opening-chain-qq-token-0123456789',
    CHARACTER_COEXIST_AVATAR_TOKEN: 'opening-chain-avatar-token-0123456789',
    QQ_OWNER_ID: '123456789',
    QQ_BOT_ID: '987654321',
    QQ_ONEBOT_WS_URL: 'ws://127.0.0.1:6701/',
    QQ_ONEBOT_ACCESS_TOKEN: 'offline-opening-chain-token-1234567890',
    LOG_LEVEL: 'info',
  }
  const child = spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'), resolve(ROOT, 'src/main.ts'), '--coexist'],
    { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const stdout: string[] = []
  let ready = ''
  const readyPromise = new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('coexist_ready_timeout')), 120_000)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout.push(chunk)
      if (ready === '' && chunk.includes('COEXIST_READY')) {
        ready = chunk
        clearTimeout(timer)
        done()
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => stdout.push(chunk))
    child.once('exit', (code) => {
      if (ready === '') {
        clearTimeout(timer)
        fail(new Error(`core_exited_before_ready:${String(code)}`))
      }
    })
  })
  await readyPromise
  return { child, ready }
}

async function stopCore(child: ChildProcess, verbose: string[]): Promise<void> {
  child.stdin?.end()
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill()
      done()
    }, 30_000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
  })
  void verbose
}

/* ---------------------------------------------------------------------------
 * main
 * ---------------------------------------------------------------------------
 * ⚠️ 单写者纪律（INC-01）：两个档**串行**跑，每档自己的隔离库。
 */
const AVATAR_TOKEN = 'opening-chain-avatar-token-0123456789'
const model = await startFakeModel()
const log: string[] = []
let exitCode = 0

try {
  /* ======================= 档一：`qqProactiveMode = on`（正控） ======================= */
  {
    const sandbox = isolateDatabase('opening-chain-on')
    const dbDir = sandbox.dir
    const avatarPort = await freePort()
    const core = await startCore({ dbDir, modelPort: model.port, qqProactiveMode: 'on', avatarOpeningMode: 'on', avatarPort })
    observe('档一：真核心已就绪（在真 socket 上用真协议）', `schema v${String(latestSchemaVersion())} · mode=on`)
    let shell: MinimalOpeningShell | undefined
    try {
      const connected = await MinimalOpeningShell.connect(avatarPort, AVATAR_TOKEN)
      shell = connected.shell
      check('真握手：`LG_ENTRY` ⇒ `LG_ENTRY_READY`（拿到会话 id）', connected.conversationId !== '', `conversationId=${connected.conversationId.slice(0, 8)}…`)

      /* ---- 正控①：机会报文能进去、回执能出来 ---- */
      const callsBefore = model.calls.length
      shell.send({ kind: 'PROACTIVE_OPPORTUNITY', requestId: 'opening-chain-1', entry: 'avatar', idleMs: 600_000 })
      const result = await shell.awaitKind('OPPORTUNITY_RESULT', 30_000)
      check('正控：机会报文 ⇒ 收到 `OPPORTUNITY_RESULT`', result !== undefined, result === undefined ? '（超时）' : '收到')
      check(
        '正控：回执 `requestId` 与请求一致（不是别的东西冒充的）',
        result?.requestId === 'opening-chain-1',
        String(result?.requestId ?? '—')
      )
      const reading = (result?.opening ?? {}) as Record<string, unknown>
      check(
        '★ 正控：空依据库 ⇒ `decision=silenced` + `code=opening_without_evidence`（S06 在真链上成立）',
        reading.decision === 'silenced' && reading.code === 'opening_without_evidence',
        `decision=${String(reading.decision)} code=${String(reading.code)}`
      )
      check(
        '★ 正控：**零模型调用**（"不花模型"不是文档里的话，是计数）',
        model.calls.length === callsBefore,
        `calls ${String(callsBefore)} → ${String(model.calls.length)}`
      )
      check(
        '★ `D18`：回执里**没有正文**（`text` 字段不存在）',
        !('text' in reading),
        Object.keys(reading).join(',') || '（空读数）'
      )

      /* ---- 负控①：形状 ---- */
      shell.send({ kind: 'PROACTIVE_OPPORTUNITY', requestId: 'opening-chain-2', entry: 'qq_private', idleMs: 600_000 })
      const bad = await shell.awaitKind('OPPORTUNITY_RESULT', 15_000)
      const badReading = (bad?.opening ?? {}) as Record<string, unknown>
      check(
        '负控：入口不是皮套 ⇒ `opening_packet_shape_invalid`（**不接管**别的入口的报文）',
        bad?.code === 'opening_packet_shape_invalid' || badReading.code === 'opening_packet_shape_invalid',
        `code=${String(bad?.code ?? badReading.code ?? '—')}`
      )
      check('负控：形状那条也**零模型调用**', model.calls.length === callsBefore, `calls=${String(model.calls.length)}`)

      /* ---- 负控②：`idleMs` 非法 ---- */
      shell.send({ kind: 'PROACTIVE_OPPORTUNITY', requestId: 'opening-chain-3', entry: 'avatar', idleMs: -1 })
      const badIdle = await shell.awaitKind('OPPORTUNITY_RESULT', 15_000)
      check(
        '负控：`idleMs` 负数 ⇒ `opening_packet_shape_invalid`',
        badIdle?.code === 'opening_packet_shape_invalid',
        `code=${String(badIdle?.code ?? '—')}`
      )
      check('负控：它同样**零模型调用**', model.calls.length === callsBefore, `calls=${String(model.calls.length)}`)
    } finally {
      shell?.close()
      const before = avatarPort
      await stopCore(core.child, log)
      cleanupSandbox(sandbox.dir)
      observe('档一收尾', `端口 ${String(before)} 已释放、隔离库已清理`)
    }
  }

  /* ======================= 档二：`avatarOpeningMode = off`（本 ADR 自己的开关） ======================= */
  {
    const sandbox = isolateDatabase('opening-chain-mode-off')
    const dbDir = sandbox.dir
    const avatarPort = await freePort()
    const core = await startCore({ dbDir, modelPort: model.port, qqProactiveMode: 'on', avatarOpeningMode: 'off', avatarPort })
    let shell: MinimalOpeningShell | undefined
    try {
      const connected = await MinimalOpeningShell.connect(avatarPort, AVATAR_TOKEN)
      shell = connected.shell
      const callsBefore = model.calls.length
      shell.send({ kind: 'PROACTIVE_OPPORTUNITY', requestId: 'opening-chain-mode-off-1', entry: 'avatar', idleMs: 600_000 })
      const result = await shell.awaitKind('OPPORTUNITY_RESULT', 30_000)
      check(
        '★ 开关生效：`avatarOpeningMode=off` ⇒ 端口**不注入** ⇒ `opening_capability_absent`（**不假装**评估过）',
        result?.code === 'opening_capability_absent',
        `code=${String(result?.code ?? '—')} · outcome=${String(result?.outcome ?? '—')}`
      )
      check(
        '★ 开关生效：off 档**零模型调用**（不是"跑了再丢"）',
        model.calls.length === callsBefore,
        `calls ${String(callsBefore)} → ${String(model.calls.length)}`
      )
      observe('档二收尾', '模式 off 的真链路读数已取（端口不注入）')
    } finally {
      shell?.close()
      await stopCore(core.child, log)
      cleanupSandbox(sandbox.dir)
    }
  }

  /* ======================= 档三：`qqProactiveMode = off`（登记的耦合） ======================= */
  {
    const sandbox = isolateDatabase('opening-chain-off')
    const dbDir = sandbox.dir
    const avatarPort = await freePort()
    const core = await startCore({ dbDir, modelPort: model.port, qqProactiveMode: 'off', avatarOpeningMode: 'on', avatarPort })
    let shell: MinimalOpeningShell | undefined
    try {
      const connected = await MinimalOpeningShell.connect(avatarPort, AVATAR_TOKEN)
      shell = connected.shell
      shell.send({ kind: 'PROACTIVE_OPPORTUNITY', requestId: 'opening-chain-off-1', entry: 'avatar', idleMs: 600_000 })
      const result = await shell.awaitKind('OPPORTUNITY_RESULT', 30_000)
      const reading = (result?.opening ?? {}) as Record<string, unknown>
      /*
       * ★ 这一档要证的是**那条真实耦合**（WP5b-1 §3.1 ②）：
       *   出站口靠 `qqProactiveMode !== 'off'` 才绑得上 ⇒ 关着时 `hasLiveClient=false`。
       * ⚠️ 但判据**顺序**说：依据集那条在活客户端**之前** ⇒ 空库走不到 `opening_no_live_client`。
       *    ⇒ 所以这里只能**如实记观察**，并把它单列为**未取读数**，不假装测到了。
       */
      observe(
        '档二（mode=off）的观察',
        `回执 code=${String(reading.code ?? result?.code ?? '—')} · ` +
          '⚠️ 空依据库使预检停在「依据集」那一条 ⇒ **观察不到** `opening_no_live_client`'
      )
      notRun('★ 耦合判据：`qqProactiveMode=off` ⇒ `opening_no_live_client`', '需要**非空依据**才走得到那一条')
    } finally {
      shell?.close()
      await stopCore(core.child, log)
      cleanupSandbox(sandbox.dir)
    }
  }

  /* ======================= 未取读数（如实分列） ======================= */
  notRun('★ 正控 `decision=spoken` + `CHARACTER_OUTPUT` 真的出站', '需要**非空依据**：库里得有信念/目标/记忆')
  notRun('幂等：同一小时第二次 ⇒ `opening_opportunity_already_handled`', '幂等在**记额之前** ⇒ 空库从没记过额')
  notRun('`opening_no_live_client`', '见档二：它在依据集**之后**，空库走不到')
  notRun('真模型', '本门用离线夹具，它回 XML 而不是 JSON ⇒ 走不到"生成成功"那一段')

  assert.ok(true)
} catch (error) {
  check(`整链门自己抛错（**不是**被测系统）: ${error instanceof Error ? error.message : String(error)}`, false, '')
  exitCode = 1
} finally {
  await model.close()
}

const results = recorder.results
const verdict = {
  total: results.length,
  passed: results.filter((row) => row.verdict === 'PASS').length,
  failed: results.filter((row) => row.verdict === 'FAIL').length,
  notRun: results.filter((row) => row.verdict === 'NOT RUN').length,
  observed: results.filter((row) => row.verdict === 'OBSERVED').length,
}
const evidence = writeEvidence('postlv2-avatar-opening-chain', {
  runId: 'avatar-opening-chain-20261011',
  schemaVersion: latestSchemaVersion(),
  observed: true,
  verdict,
  log,
})
process.stdout.write(`\n  证据：${evidence}\n`)
process.exitCode = exitCode !== 0 || verdict.failed > 0 ? 1 : 0
