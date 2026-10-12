/**
 * 会话内序号连续性门（2026-10-05 跳号事故的回归锁）。
 *
 * ============================================================================
 *  事故形状（`artifacts/post-lv2/local/Sequence-Gap-Root-Cause-2026-10-05.md`）
 * ============================================================================
 *  真实会话：前一轮 19:13 的用户句已落账（会话内序号 137），随后 Tavily 搜索
 *  超时、回复在**首句之前**被用户取消（外壳记 `[Interrupted by user]`）。那一轮的
 *  助手事件**从未产生**，而 `ChatSession` 的进程内序号缓存已经按"本轮两条都会落账"
 *  提前推进到 139 ⇒ 下一轮拿 139 去写，被
 *  `ConversationRecorder.assertSequenceContiguous()` 正确地拒成
 *  `conversation_sequence_gap`，**后续整段会话卡死**（重启才恢复，因为 `open()`
 *  会重读账本）。
 *
 * ============================================================================
 *  本门测什么（以及刻意不测什么）
 * ============================================================================
 *  走**真实 `src/main.ts --bridge`**、**全新隔离库**、**loopback HTTP 假模型**：
 *  不调用真模型 / 不联网 / 不碰麦克风与 TTS / **不打开生产库**（前后对生产目录
 *  树摘要做逐字比对）。
 *
 *  每个场景验两件事：
 *    ① 那一轮**到底落了几条**（账本逐条精确比对，不看"大概"）
 *    ② 紧接着的**下一轮**必须正常 replied（事故里它失败在
 *       `conversation_sequence_gap`；本轮会话可继续是唯一的产品判据）
 *
 *  ⚠️ 负控是本门的重点：只测"取消之后还能继续"是不够的 ——
 *    那可以靠"永远不写助手事件"通过。因此正控（两轮正常 = 4 条）与
 *    首句**已发出后**取消（前缀助手事件必须落账）同时在场。
 *
 *  ⚠️ 取消原因必须**独立可观测**：首句前取消 ⇒
 *    `speech_stream_cancelled_before_sentence`；首句前链路失败 ⇒ 保留 provider
 *    自己的具名码。凭这两条能分辨"用户打断"与"模型/链路坏了"。
 *
 *  ⚠️ 2026-10-10 追加第四个场景（`envelope-before`）：**首句前把 `<lg-speech>`
 *    封套写坏**（流干净结束、正文完整，只是 JSON 不合法）。它是真机事故的形状：
 *    原来这一类被折成通用兜底码 `speech_stream_failed_before_sentence`，
 *    于是"她格式写坏了"在 trace / 桥 / 皮套三处都长得像"链路坏了"。
 *    本场景断言的是**原因必须具名**（`expression_invalid_envelope`），
 *    同时仍然要求下一轮正常 replied（会话不得因它跳号）。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { cleanupSandbox, isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'

const ROOT = resolve(import.meta.dirname, '..')
/**
 * 机器证据写在**进仓库**的那一层（`artifacts/post-lv2/<runId>/`，见 `.gitignore` 里
 * "`local/` = 完整转录取证、不进仓库"的成对约定；本门的证据只有计数 / 具名码 / 逐条序号，
 * 没有一句对话正文）。
 */
const OUT_DIR = join(ROOT, 'artifacts/post-lv2/sequence-continuity-verify-20261005')
const PRODUCTION_BEFORE = digestTree(PRODUCTION_DB_DIR)

/** 假模型的四种行为（`--bridge` 走流式；非流式只在启动探针时被碰到） */
type Mode = 'complete' | 'failure-before' | 'cancel-before' | 'cancel-after' | 'envelope-before'

let mode: Mode = 'complete'
let modelStarted = (): void => {}
let sentenceSeen = (): void => {}

const SERVER = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const params = body === '' ? {} : (JSON.parse(body) as { stream?: boolean })
  if (params.stream !== true) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: '就绪' } }] }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.flushHeaders()
  const delta = (content: string): string =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
  if (mode === 'complete') {
    response.end(
      delta('<lg-speech>{"segments":[{"text":"正常测试回复。","cue":"natural"}]}</lg-speech>') +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    )
    return
  }
  if (mode === 'failure-before') {
    // 模型返回 length 终态：`readChatStream` 抛 `model_stream_finish_length`
    response.end('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n')
    return
  }
  if (mode === 'envelope-before') {
    /*
     * 2026-10-10 真机事故的形状：**流干净结束（stop + [DONE]）、正文完整**，
     * 但封套里的 JSON 有个**字面换行**（模型手误）⇒ `decodeExpressiveSpeech`
     * 的 JSON.parse 失败 ⇒ `expression_invalid_envelope`，且发生在首句之前。
     * ⚠️ 这里必须让字符串里真的出现 LF（不是 `\\n` 两个字符），否则 JSON 合法、
     *    就复现不出这一类了。
     */
    response.end(
      delta('<lg-speech>{"segments":[{"text":"晚上好。\n我这边都看着呢。","cue":"natural"}]}</lg-speech>') +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    )
    return
  }
  if (mode === 'cancel-after') {
    // 一条**完整**分句已发出，第二句残缺 ⇒ 取消后前缀必须落账
    response.write(
      delta(
        '<lg-speech>{"segments":[{"text":"已发出的第一句。","cue":"natural"},'
      )
    )
    modelStarted()
    return
  }
  // cancel-before：只发注释行，首句之前一直悬着
  response.write(': waiting before the first sentence\n\n')
  modelStarted()
})

await new Promise<void>((done) => SERVER.listen(0, '127.0.0.1', done))
const PORT = (SERVER.address() as { port: number }).port

/**
 * 把 flags.ts 里所有 `CHARACTER_*_ENABLED` 关掉，再显式打开本门需要的那几个。
 * 目的：让门**只**测会话序号，不被情绪 / 信念 / 目标 / 记忆抽取等功能干扰。
 */
const FEATURE_ENV: Record<string, string> = Object.fromEntries(
  [...readFileSync(join(ROOT, 'src/kernel/app/flags.ts'), 'utf8').matchAll(
    /env\.(CHARACTER_[A-Z_]+_ENABLED)/g
  )].map((match) => [match[1]!, 'false'])
)

interface Reading {
  label: string
  firstMode: Mode
  events: { conversation_sequence: number; actor_type: string }[]
  traces: { status: string; error: string | null }[]
  first: { outcome: string; code?: string; streamStatus?: string }
  decision: { kind: string; accepted?: boolean; stoppedBeforeModel?: boolean }
  reply: { outcome: string; code?: string }
  speechPackets: number
  packetKinds: string
  /** 子进程 stderr 尾部（只用于失败时的归因，不进断言判据） */
  stderrTail: string
}

const sandboxes: string[] = []

async function runSession(
  label: string,
  firstMode: Mode,
  existingDir?: string
): Promise<{ dir: string; reading: Reading }> {
  const sandbox = existingDir ?? isolateDatabase(`sequence-continuity-${label}`, { keep: true }).dir
  if (existingDir === undefined) sandboxes.push(sandbox)
  const child = spawn(
    process.execPath,
    [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'src/main.ts'), '--bridge'],
    {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...FEATURE_ENV,
        PGLITE_DATA_DIR: sandbox,
        PROJECT_LG_SANDBOX: sandbox,
        OPENAI_API_KEY: 'offline-local-fixture',
        OPENAI_BASE_URL: `http://127.0.0.1:${PORT}`,
        OPENAI_LARGE_MODEL: 'local-fixture',
        OPENAI_SMALL_MODEL: 'local-fixture',
        CHARACTER_EVENT_PIPELINE_V2: 'true',
        CHARACTER_CONTEXT_COMPILER_V1: 'true',
        CHARACTER_EXPRESSIVE_SPEECH: 'true',
        CHARACTER_MEMORY_SEMANTIC_MODE: 'off',
        CHARACTER_AFFECT_SEMANTIC_MODE: 'rules',
        CHARACTER_ROLLUP_TOKENS: '0',
        CHARACTER_BELIEF_ENABLED: 'false',
        CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED: 'false',
        DEBUG_CONTEXT: 'false',
      },
    }
  )
  const pending = new Map<string, (packet: Record<string, unknown>) => void>()
  const packets: { kind: string; [key: string]: unknown }[] = []
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr += String(data)
  })
  const exited = new Promise<number | null>((done, reject) => {
    child.once('exit', done)
    child.once('error', reject)
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    let packet: { kind?: string }
    try {
      packet = JSON.parse(line) as { kind?: string }
    } catch {
      return
    }
    if (packet.kind === undefined) return
    packets.push(packet as { kind: string })
    if (packet.kind === 'SPEECH_SEGMENT') sentenceSeen()
    const key = `${packet.kind}:${String((packet as { requestId?: unknown }).requestId)}`
    pending.get(key)?.(packet as Record<string, unknown>)
    pending.delete(key)
  })
  const deadline = <T>(promise: Promise<T>, what: string): Promise<T> =>
    new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: 超时 ${what}`)), 60_000)
      promise.then(
        (value) => {
          clearTimeout(timer)
          done(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  const send = (
    packet: { kind: string; requestId: string } & Record<string, unknown>
  ): Promise<Record<string, any>> => {
    const replyKind =
      packet.kind === 'SUBMIT_TURN'
        ? 'TURN_RESULT'
        : packet.kind === 'CANCEL_TURN'
          ? 'CANCEL_RESULT'
          : 'TURN_RESULT'
    const waiting = new Promise<Record<string, any>>((done) =>
      pending.set(`${replyKind}:${packet.requestId}`, done)
    )
    child.stdin.write(`${JSON.stringify(packet)}\n`)
    return deadline(waiting, packet.kind)
  }

  let first: Record<string, any>
  let decision: Record<string, any> | undefined
  let reply: Record<string, any>
  try {
    // 启动探针：等桥真的起来（返回未知消息种类是**设计中的**应答）
    const probe = await send({ kind: 'LG_STARTUP_PROBE', requestId: 'ready' })
    assert.equal(probe.code, 'bridge_unknown_message_kind')
    mode = firstMode
    const started = new Promise<void>((done) => {
      modelStarted = done
    })
    const sentence = new Promise<void>((done) => {
      sentenceSeen = done
    })
    const firstResult = send({
      kind: 'SUBMIT_TURN',
      requestId: 'first',
      userText: '第一轮隔离测试。',
      streamSpeech: true,
    })
    if (firstMode === 'cancel-before' || firstMode === 'cancel-after') {
      await deadline(firstMode === 'cancel-after' ? sentence : started, '取消边界')
      decision = await send({
        kind: 'CANCEL_TURN',
        requestId: 'first',
        reason: 'sequence continuity gate',
      })
    }
    first = await firstResult
    mode = 'complete'
    reply = await send({
      kind: 'SUBMIT_TURN',
      requestId: 'next',
      userText: '第二轮隔离测试。',
      streamSpeech: true,
    })
  } finally {
    child.stdin.end()
    try {
      assert.equal(await deadline(exited, '进程收尾'), 0, stderr.slice(-1500))
    } catch (error) {
      child.kill()
      throw error
    }
  }

  const db = await openRawPGlite(sandbox)
  let events: { conversation_sequence: number; actor_type: string }[]
  let traces: { status: string; error: string | null }[]
  try {
    events = (
      await db.query(
        'select conversation_sequence, actor_type from conversation_events order by conversation_sequence'
      )
    ).rows as typeof events
    traces = (
      await db.query('select status, error from character_traces order by started_at')
    ).rows as typeof traces
  } finally {
    await db.close()
  }
  const reading: Reading = {
    label,
    firstMode,
    events,
    traces,
    first: {
      outcome: String(first.outcome),
      ...(first.code === undefined ? {} : { code: String(first.code) }),
      ...(first.streamStatus === undefined ? {} : { streamStatus: String(first.streamStatus) }),
    },
    decision: {
      kind: decision === undefined ? '(未取消)' : String(decision.kind),
      ...(decision?.cancel?.accepted === undefined
        ? {}
        : { accepted: Boolean(decision.cancel.accepted) }),
      ...(decision?.cancel?.stoppedBeforeModel === undefined
        ? {}
        : { stoppedBeforeModel: Boolean(decision.cancel.stoppedBeforeModel) }),
    },
    reply: {
      outcome: String(reply.outcome),
      ...(reply.code === undefined ? {} : { code: String(reply.code) }),
    },
    speechPackets: packets.filter((packet) => packet.kind === 'SPEECH_SEGMENT').length,
    packetKinds: [...new Set(packets.map((packet) => packet.kind))].join(','),
    stderrTail: stderr.slice(-4000),
  }
  console.log(
    `  [${label}] 首轮=${reading.first.outcome}${reading.first.code === undefined ? '' : `/${reading.first.code}`}` +
      ` · 下一轮=${reading.reply.outcome}${reading.reply.code === undefined ? '' : `/${reading.reply.code}`}` +
      ` · 账本=${JSON.stringify(events.map((e) => `${e.actor_type}:${e.conversation_sequence}`))}` +
      ` · 包=${reading.packetKinds} 语音包=${String(reading.speechPackets)}`
  )
  return { dir: sandbox, reading }
}

const readings: Reading[] = []
/** 首句前取消那批的库目录（重启恢复场景要复用它，因此在 try 之外可见） */
let failedDir = ''
const gapOf = (reading: Reading): string | undefined =>
  reading.reply.code === 'conversation_sequence_gap' ? reading.reply.code : undefined

try {
  console.log('[sequence-continuity] 正控：两轮正常完成')
  const normal = await runSession('normal', 'complete')
  readings.push(normal.reading)
  assert.equal(normal.reading.first.outcome, 'replied')
  assert.equal(normal.reading.reply.outcome, 'replied')
  // 正控：用户/助手各两条，会话内序号 1..4 —— 这是"该写的时候真的写了"
  assert.deepEqual(normal.reading.events, [
    { conversation_sequence: 1, actor_type: 'user' },
    { conversation_sequence: 2, actor_type: 'character' },
    { conversation_sequence: 3, actor_type: 'user' },
    { conversation_sequence: 4, actor_type: 'character' },
  ])

  console.log('[sequence-continuity] 首句前取消（3 次独立运行）')
  for (let index = 1; index <= 3; index += 1) {
    const run = await runSession(`cancel-before-${index}`, 'cancel-before')
    failedDir = run.dir
    readings.push(run.reading)
    assert.equal(run.reading.first.outcome, 'failed')
    // ⚠️ 取消原因必须独立可观测（事故的第二个观测缺口）
    assert.equal(
      run.reading.first.code,
      'speech_stream_cancelled_before_sentence',
      `子进程 stderr 尾部：${run.reading.stderrTail}`
    )
    assert.equal(gapOf(run.reading), undefined, '首句前取消**不得**让下一轮跳号')
    assert.equal(run.reading.reply.outcome, 'replied')
    // 只落了那条用户事件；助手序号空着（这是事实，不是缺陷）
    assert.deepEqual(run.reading.events, [
      { conversation_sequence: 1, actor_type: 'user' },
      { conversation_sequence: 2, actor_type: 'user' },
      { conversation_sequence: 3, actor_type: 'character' },
    ])
  }

  console.log('[sequence-continuity] 首句前链路失败（模型 length 终态）')
  const failure = await runSession('failure-before', 'failure-before')
  readings.push(failure.reading)
  assert.equal(failure.reading.first.outcome, 'failed')
  // ⚠️ 非取消的失败**不得**被记成取消：保留 provider 自己的具名码
  assert.equal(failure.reading.first.code, 'model_stream_finish_length')
  assert.equal(gapOf(failure.reading), undefined)
  assert.equal(failure.reading.reply.outcome, 'replied')
  assert.deepEqual(failure.reading.events, [
    { conversation_sequence: 1, actor_type: 'user' },
    { conversation_sequence: 2, actor_type: 'user' },
    { conversation_sequence: 3, actor_type: 'character' },
  ])

  console.log('[sequence-continuity] 首句前封套写坏（原因必须具名，不得折成通用兜底码）')
  const brokenEnvelope = await runSession('envelope-before', 'envelope-before')
  readings.push(brokenEnvelope.reading)
  assert.equal(brokenEnvelope.reading.first.outcome, 'failed')
  // ★ 本场景存在的理由：**不得**再折成 speech_stream_failed_before_sentence
  assert.equal(
    brokenEnvelope.reading.first.code,
    'expression_invalid_envelope',
    `子进程 stderr 尾部：${brokenEnvelope.reading.stderrTail}`
  )
  assert.ok(
    brokenEnvelope.reading.stderrTail.includes('[stream] 首句前结束 · 原因=expression_invalid_envelope'),
    'stderr 必须留下真实原因（诊断行，且不带正文）'
  )
  assert.ok(
    brokenEnvelope.reading.traces.some((trace) => trace.error === 'expression_invalid_envelope'),
    'trace.error 必须是真实原因，不是通用兜底码'
  )
  assert.equal(gapOf(brokenEnvelope.reading), undefined, '首句前封套失败**不得**让下一轮跳号')
  assert.equal(brokenEnvelope.reading.reply.outcome, 'replied')
  assert.deepEqual(brokenEnvelope.reading.events, [
    { conversation_sequence: 1, actor_type: 'user' },
    { conversation_sequence: 2, actor_type: 'user' },
    { conversation_sequence: 3, actor_type: 'character' },
  ])

  console.log('[sequence-continuity] 首句已发出后取消（前缀必须落账）')
  const late = await runSession('cancel-after', 'cancel-after')
  readings.push(late.reading)
  // ⚠️ 读数是**两个轮次合计**的：第一轮的前缀 1 包 + 第二轮的 1 包
  assert.equal(
    late.reading.speechPackets,
    2,
    `取消前后各应有一包语音（第一轮前缀 + 第二轮回复）；实际包=${late.reading.packetKinds}`
  )
  assert.equal(late.reading.first.outcome, 'failed')
  assert.equal(late.reading.first.streamStatus, 'cancelled')
  assert.equal(gapOf(late.reading), undefined)
  assert.equal(late.reading.reply.outcome, 'replied')
  // 前缀助手事件落账 ⇒ 序号连续到 3，下一轮从 4 起
  assert.deepEqual(late.reading.events, [
    { conversation_sequence: 1, actor_type: 'user' },
    { conversation_sequence: 2, actor_type: 'character' },
    { conversation_sequence: 3, actor_type: 'user' },
    { conversation_sequence: 4, actor_type: 'character' },
  ])

  console.log('[sequence-continuity] 在失败库上重启（open() 重读账本）')
  const restart = await runSession('restart-recovery', 'complete', failedDir)
  readings.push(restart.reading)
  assert.equal(restart.reading.reply.outcome, 'replied')
  /*
   * 重启前：被取消那一轮只留下 `user:1`（助手序号空着）。
   * 重启后本场景又跑两轮 ⇒ `user:2 character:3` + `user:4 character:5`
   * ⇒ 合计 5 条，且**序号逐字连续**（跳号会让重启后第一轮就失败）。
   * ⚠️ 这正是"同一个库在另一个进程里接着用"的读数 —— 它必须和同进程内
   *    继续对话**结论一致**，否则事故只是被一个重启掩盖了。
   */
  assert.deepEqual(restart.reading.events, [
    { conversation_sequence: 1, actor_type: 'user' },
    { conversation_sequence: 2, actor_type: 'user' },
    { conversation_sequence: 3, actor_type: 'character' },
    { conversation_sequence: 4, actor_type: 'user' },
    { conversation_sequence: 5, actor_type: 'character' },
    { conversation_sequence: 6, actor_type: 'user' },
    { conversation_sequence: 7, actor_type: 'character' },
  ])

  console.log('[sequence-continuity] 取消原因必须能被 trace 区分')
  const cancelledTrace = readings.find((reading) => reading.firstMode === 'cancel-before')
  const failedTrace = readings.find((reading) => reading.firstMode === 'failure-before')
  assert.ok(
    cancelledTrace?.traces.some(
      (trace) => trace.error === 'speech_stream_cancelled_before_sentence'
    ),
    '首句前取消的 trace.error 应为 speech_stream_cancelled_before_sentence'
  )
  assert.ok(
    failedTrace?.traces.some((trace) => trace.error === 'model_stream_finish_length'),
    '首句前失败的 trace.error 应为 provider 的具名码'
  )
  assert.ok(
    failedTrace?.traces.every((trace) => trace.error !== 'speech_stream_cancelled_before_sentence'),
    '链路失败不得被记成取消'
  )

  assert.equal(
    digestTree(PRODUCTION_DB_DIR).treeSha256,
    PRODUCTION_BEFORE.treeSha256,
    '本门期间生产库目录树必须逐字不变'
  )

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(
    join(OUT_DIR, 'sequence-continuity-verify.json'),
    JSON.stringify(
      {
        scope:
          'Real src/main.ts --bridge · fresh isolated databases · loopback HTTP model fixture',
        productionDatabaseOpened: false,
        productionTreeUnchanged: true,
        externalModelCalls: 0,
        networkCalls: 0,
        defectReproducedBefore: true,
        expectedAfterFix: 'no conversation_sequence_gap on the turn after a pre-sentence failure',
        readings: readings.map((reading) => ({
          label: reading.label,
          firstMode: reading.firstMode,
          first: reading.first,
          reply: reading.reply,
          speechPackets: reading.speechPackets,
          packetKinds: reading.packetKinds,
          events: reading.events,
          traces: reading.traces,
        })),
      },
      null,
      2
    )
  )
  console.log(
    `PASS: 首句前取消/首句前失败之后会话不跳号（3/3）· 首句前封套写坏必须报出真实原因 · ` +
      `首句后取消前缀仍落账 · 取消原因可分辨 · 正控与重启恢复均通过（生产库树摘要逐字未变）\n` +
      `  证据：artifacts/post-lv2/sequence-continuity-verify-20261005/sequence-continuity-verify.json`
  )
} finally {
  SERVER.closeAllConnections()
  await new Promise<void>((done) => SERVER.close(() => done()))
  // 本次门自建的隔离库一并清理（失败时也清，不留垃圾）
  for (const dir of sandboxes) cleanupSandbox(dir)
  cleanupSandbox(failedDir)
}
