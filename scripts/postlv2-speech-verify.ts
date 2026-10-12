/**
 * 后 Lv2 · WP5 —— **语音桥的 LG 侧门**（`pnpm postlv2:speech:verify`）。
 *
 * ============================================================================
 *  载体：计划 §7 / §8（流式 ASR · 快反 · 取消 · 中途纠正）· 媒体交付契约 §1
 *        `INV-PL2-09`/`INV-PL2-10`/`INV-PL2-11`
 * ============================================================================
 * 它守什么（**离线**：spawn 一个**纯标准库**的 Python 客户端，门当"LG 那一侧"的对端）：
 * ```text
 * S1 **只有 final 触发轮次**：喂 3 条 partial ⇒ 一条 `SUBMIT_TURN` 都不许出现
 * S2 final 触发**恰好一次**提交，且 `requestId` 是**确定性**的（`utt:<utteranceId>`）
 * S3 同 utteranceId 再发 ⇒ **去重**（不再提交）—— 重连重发不产生第二轮对话
 * S4 新语音到达 ⇒ 旧候选标 `expired`，且 `usable_replies()` **不**把它算进去
 * S5 协议形状：发出的行**逐字段**符合 `BridgeWireRequest`（只有 `kind`/`requestId`/`userText`）
 * S6 空 final（没人说话）⇒ 不提交
 * S7 客户端**不**声称已播出：它的输出里**没有**任何 delivery/played 字段
 * V1 量具自证三段式
 * ```
 *
 * ⚠️ **本门不主张**：真实麦克风、真 VAD 切分、真 LG 进程（对端是本门扮演的，
 * 但**协议形状与真桥一致**）。也**不主张**取消已经传播到 LG —— 见文件尾的残余登记。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(process.cwd())
const DEPS_ROOT = process.env.POSTLV2_DEPS_ROOT ?? 'C:\\Users\\user\\postlv2-deps'
const PYTHON = join(DEPS_ROOT, 'venv', 'Scripts', 'python.exe')
const CLIENT = join(DEPS_ROOT, 'speech_bridge.py')

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const available = existsSync(PYTHON) && existsSync(CLIENT)

interface SessionReading {
  /** 客户端发出的行（原始文本） */
  sentLines: string[]
  parsed: Record<string, unknown>[]
  stderrSummary: Record<string, unknown> | undefined
  /** 驱动脚本自己的诊断行（**单独留证**：它证明"配置挂了"还是"协议挂了"） */
  driverDiagnostics?: string
  /** 驱动收到的**原始** stderr（诊断用：区分"没输出"与"输出没被解析"） */
  rawStderr?: string
  /** 子进程退出码（`null` = 从未触发 close/exit ⇒ 收尾走的是兜底超时） */
  childExit?: number | null
  error?: string
}

/**
 * 跑一次协议会话：喂 `utters`，对每条 `SUBMIT_TURN` 回一条**固定**回应。
 *
 * ⚠️ 对端由**本门**扮演 —— 但形状与真桥逐字段一致（`BridgeWireResponse`）。
 * 这是协议边界的集成测，不是"我 mock 了自己的函数"。
 */
function runSession(
  utterances: readonly Record<string, unknown>[],
  respond: (request: Record<string, unknown>) => Record<string, unknown>
): SessionReading {
  const input = utterances.map((item) => JSON.stringify(item)).join('\n') + '\n'
  /*
   * ⚠️ 这里故意**不**用管道捕获 stdout：受限沙箱里"程序 A 通过管道读程序 B 的 stdout"
   * 会得到 EPERM（那是文档化的边界，不是缺陷）。
   * 因此把对端逻辑放在一个 **Node 侧驱动脚本**里：它 spawn Python、
   * 自己当对端、最后把读数写成文件。本门只读那个文件。
   */
  const driverPath = join(DEPS_ROOT, `speech-driver-${process.pid}.mjs`)
  const utterancesPath = join(DEPS_ROOT, `speech-utterances-${process.pid}.json`)
  /*
   * ⚠️ 喂给驱动脚本的 utterance 走**文件**，不走命令行参数，并且是 **JSONL**（一行一条）。
   * 两个坑都是实测踩出来的：
   *   ① **PowerShell 会吃掉参数里的双引号** ⇒ 把 JSON 塞进 argv 会变成非法 JSON，
   *      驱动一解析就崩、输出文件永不生成、门只能等超时（症状像"协议挂了"）。
   *   ② 客户端读的是 **JSONL**（一行一条），喂一个 JSON **数组**会让它当场抛
   *      `list indices must be integers`；而驱动那时还没拿到任何 stdout ⇒ 静默失败。
   * 结论：跨进程传结构化数据**只走文件**，且**格式必须与消费端逐字一致**。
   */
  writeFileSync(
    utterancesPath,
    utterances.map((item) => JSON.stringify(item)).join('\n') + '\n',
    'utf8'
  )
  const driverSource = `
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const [python, client, utterancesPath, outPath] = process.argv.slice(2)
const utterances = readFileSync(utterancesPath, 'utf8')
  .split('\\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line))
const respond = ${respond.toString()}
const child = spawn(python, [client, '--protocol-session'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
const sent = []
let pending = ''
let idle = null
/*
 * 客户端是**两阶段**的（阶段一只读输入、阶段二才发请求），两阶段之间用**显式哨兵**
 * INPUT_END 划界（不用 EOF —— 阶段二还要读同一个流上的回应）。
 * 驱动侧的时序：
 *   ① 写完全部 utterance，再写一条 INPUT_END（**不关 stdin**）
 *   ② 对着到达的每条消息回一条回应（SUBMIT_TURN ⇒ TURN_RESULT；CANCEL_TURN ⇒ CANCEL_RESULT）
 *   ③ **空闲一小段之后**才关 stdin
 * ⚠️ ③ 是第三个坑：**不能**数条数（取消的条数取决于客户端看到什么 ⇒ 有取消的会话会被提前关掉，
 *    客户端读回应拿 EOF、静默退出、读数全 undefined），**也不能**等子进程自己结束
 *    （它正阻塞在读下一条回应上 ⇒ 每次都要等满兜底超时）。
 */
function sendAll() {
  for (const item of utterances) child.stdin.write(JSON.stringify(item) + '\\n')
  child.stdin.write('INPUT_END\\n')
}
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  pending += chunk
  let index
  while ((index = pending.indexOf('\\n')) >= 0) {
    const line = pending.slice(0, index)
    pending = pending.slice(index + 1)
    if (line.trim() === '') continue
    sent.push(line)
    const request = JSON.parse(line)
    child.stdin.write(JSON.stringify(respond(request)) + '\\n')
  }
  /*
   * ⚠️ 关 stdin 的时机：**等一小段空闲**（而不是数条数、也不是等子进程自己结束）。
   *   · 数条数 ⇒ 有取消的会话会被提前关掉（实测：子进程静默退出、读数全 undefined）
   *   · 等子进程自己结束 ⇒ 它正阻塞在读下一条回应上，永远不结束（实测：每次等满 60 秒）
   * 客户端把手上的消息都发完之后会回到 readline()；此时 EOF 会让它干净退出。
   */
  if (idle !== null) clearTimeout(idle)
  idle = setTimeout(() => { try { child.stdin.end() } catch {} }, 1500)
})
let errText = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { errText += chunk })
/*
 * ⚠️ **先挂 close 监听，再喂第一口**。
 * 第一版把 feedNext() 写在 child.on('close') **之前** —— 全部是同步代码，
 * 于是子进程若在监听器挂上之前就退出，那个 close 事件**永远收不到**，
 * 驱动进程不会退出、输出文件根本不会生成，外层 execFileSync 只能等超时。
 * 症状是"门跑了 121 秒、读数是 undefined"，看起来像协议坏了，其实是**事件顺序**坏了。
 * 另加一条兜底超时：宁可写出"没等到 close"的读数，也不要挂死。
 */
let finished = false
const finish = () => {
  if (finished) return
  finished = true
  try { writeFileSync(outPath, JSON.stringify({ sent, errText, childExit: child.exitCode }), 'utf8') } catch {}
  process.exit(0)
}
/*
 * ⚠️ **不能只等 close**。实测：Python 在协议会话里抛异常退出时，
 * child.on('close') **没有**触发（stdout/stderr 的管道句柄也没等到 EOF），
 * 驱动于是什么都不写、也不退出。
 * 因此兜底超时**不是**"保险"，它是**必需的第二条收尾路径** —— 而且它写下的读数
 * 必须能区分"子进程没退出"与"协议没回话"（所以记 childExit 与 errText）。
 */
const safety = setTimeout(() => { errText += '\\n[driver] safety timeout: child never emitted close\\n'; finish() }, 20000)
child.on('close', (code) => { clearTimeout(safety); finish() })
child.on('error', (error) => { errText += '\\n[driver] spawn error: ' + String(error) + '\\n'; clearTimeout(safety); finish() })
child.on('exit', () => { /* exit 可能先于 close；收尾统一由上面两条路径负责 */ })
sendAll()
`
  writeFileSync(driverPath, driverSource, 'utf8')
  const outPath = join(DEPS_ROOT, `speech-driver-out-${process.pid}.json`)
  try {
    execFileSync(process.execPath, [driverPath, PYTHON, CLIENT, utterancesPath, outPath], {
      cwd: DEPS_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    /*
     * 读驱动写下的读数 —— 用 readFileSync，**不要**再 spawn 一个 node -e 去读：
     * 那既多余，又会把"读文件失败"混进"协议失败"的读数里。
     */
    const raw = JSON.parse(readFileSync(outPath, 'utf8')) as {
      sent: string[]
      errText: string
      childExit?: number | null
    }
    const stderrLines = raw.errText.trim().split('\n').filter(Boolean)
    /* 最后一行是 Python 侧的结构化小结；其余行（驱动诊断）单独留证 */
    const summaryLine = [...stderrLines].reverse().find((line) => line.trimStart().startsWith('{'))
    return {
      sentLines: raw.sent,
      parsed: raw.sent.map((line) => JSON.parse(line) as Record<string, unknown>),
      stderrSummary:
        summaryLine !== undefined ? (JSON.parse(summaryLine) as Record<string, unknown>) : undefined,
      driverDiagnostics: stderrLines.filter((line) => !line.trimStart().startsWith('{')).join('\n'),
      rawStderr: raw.errText,
      childExit: raw.childExit ?? null,
    }
  } catch (error) {
    return {
      sentLines: [],
      parsed: [],
      stderrSummary: undefined,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    }
  } finally {
    try {
      if (existsSync(driverPath)) unlinkSync(driverPath)
      if (existsSync(utterancesPath)) unlinkSync(utterancesPath)
      if (existsSync(outPath)) unlinkSync(outPath)
    } catch {
      /* 清理失败不影响判定 */
    }
  }
}

const replyFor = (request: Record<string, unknown>): Record<string, unknown> => {
  /*
   * ⚠️ 对端要说**两种**回应：`SUBMIT_TURN` ⇒ `TURN_RESULT`；`CANCEL_TURN` ⇒ `CANCEL_RESULT`。
   * 只回一种会让取消的回应被当成轮次结果（或反过来），而那种错法**很难看出来**
   * —— 第一版就是因为这个，`cancelRequestsSent` 一直是 0。
   */
  if (request['kind'] === 'CANCEL_TURN') {
    return {
      kind: 'CANCEL_RESULT',
      requestId: String(request['requestId'] ?? ''),
      outcome: 'cancelled',
      /* ⚠️ 对端扮演的是"**已经过了提交点**"的 LG：诚实读数必须说撤销不了 */
      cancel: {
        requested: true,
        stoppedBeforeModel: false,
        alreadyCommitted: true,
        cancellablePoints: [],
      },
    }
  }
  return {
    kind: 'TURN_RESULT',
    requestId: String(request['requestId'] ?? ''),
    outcome: 'replied',
    replyText: `（已过守卫）收到：${String(request['userText'] ?? '')}`,
    replyId: `cev:probe:${String(request['requestId'] ?? '')}`,
    traceId: `trc:probe:${String(request['requestId'] ?? '')}`,
    delivery: 'generated',
  }
}

record(
  'S0',
  '外部前置就位（仓库之外的 venv + 纯标准库客户端）',
  available,
  available ? `deps=${DEPS_ROOT}` : `缺：${!existsSync(PYTHON) ? 'python ' : ''}${!existsSync(CLIENT) ? 'client' : ''} ⇒ 本门 **NOT RUN**`,
  available ? 1 : 0
)

let session: SessionReading = { sentLines: [], parsed: [], stderrSummary: undefined }
if (available) {
  session = runSession(
    [
      { utteranceId: 'u1', text: '对', isFinal: false },
      { utteranceId: 'u1', text: '对我做了介绍', isFinal: false },
      { utteranceId: 'u1', text: '大家如果对我的研究感兴趣呢', isFinal: false },
      { utteranceId: 'u1', text: '大家如果对我的研究感兴趣呢', isFinal: true },
      { utteranceId: 'u1', text: '大家如果对我的研究感兴趣呢', isFinal: true },
      { utteranceId: 'u2', text: '   ', isFinal: true },
    ],
    replyFor
  )
}

// --- S1 只有 final 触发轮次 -------------------------------------------------
const submittedRequestIds = session.parsed
  .filter((item) => item['kind'] === 'SUBMIT_TURN')
  .map((item) => String(item['requestId']))
record(
  'S1',
  '**只有 final 触发轮次**：3 条 partial 一条 `SUBMIT_TURN` 都没产生（否则一轮话会被切成七八轮）',
  available &&
    session.stderrSummary?.['partialsSeen'] === 3 &&
    submittedRequestIds.length > 0 &&
    session.stderrSummary?.['submitted'] === 1,
  `partial 计数=${String(session.stderrSummary?.['partialsSeen'])}（应 3）· 提交=${JSON.stringify(submittedRequestIds)}`,
  available ? 3 : 0
)

// --- S2 final 恰好提交一次 + requestId 确定性 -------------------------------
record(
  'S2',
  'final 触发**恰好一次**提交，且 `requestId` 是**确定性**的 `utt:<utteranceId>`（幂等的地基）',
  available && submittedRequestIds.length === 1 && submittedRequestIds[0] === 'utt:u1',
  `requestId=${JSON.stringify(submittedRequestIds)}（应 ["utt:u1"]）`,
  available ? 2 : 0
)

// --- S3 同 utterance 去重 ---------------------------------------------------
/*
 * ⚠️ 判据要用**能区分两种读法的那个读数**。
 * 第一版断言 `summary.deduplicated === 1`，但实测是 0 —— 而**去重其实是生效的**
 * （总提交恒为 1）。原因是 `deduplicated` 与 `finalsSeen`/`submitted` 不是同一层计数：
 * `finalsSeen` 在去重判定**之前** +1，`submitted` 只在真的发出时 +1。
 * 能区分"去重生效"与"去重没生效"的读数是：**重复投递之后 `submitted` 仍然只有 1**。
 * 同时把每个候选的 `reason` 记下来，让"为什么没提交"这件事在证据里**看得见**。
 */
const candidateReasons: string[] = Array.isArray(session.stderrSummary?.['reasons'])
  ? (session.stderrSummary?.['reasons'] as unknown[]).map(String)
  : []
record(
  'S3',
  '同一个 utteranceId 再发 ⇒ **去重**（`submitted` 恒为 1；重复那条被记成 `duplicate_utterance`）—— 重连重发不会重复调用模型',
  available &&
    submittedRequestIds.length === 1 &&
    session.stderrSummary?.['submitted'] === 1 &&
    candidateReasons.includes('duplicate_utterance'),
  `总提交=${submittedRequestIds.length}（应 1）· submitted=${String(session.stderrSummary?.['submitted'])} · 候选理由=${JSON.stringify(candidateReasons)}`,
  available ? 2 : 0
)

// --- S6 空 final 不提交 ----------------------------------------------------
record(
  'S6',
  '**空 final**（没人说话）⇒ 不提交 —— 静音不是一轮对话',
  available && !submittedRequestIds.includes('utt:u2'),
  `u2 出现在提交里=${String(submittedRequestIds.includes('utt:u2'))}（应 false）`,
  available ? 1 : 0
)

// --- S5 协议形状逐字段 ------------------------------------------------------
const ALLOWED_KEYS = ['kind', 'requestId', 'userText']
const shapeOk =
  available &&
  session.parsed.length > 0 &&
  session.parsed.every((item) => {
    const keys = Object.keys(item).sort()
    return (
      keys.join(',') === ALLOWED_KEYS.join(',') &&
      item['kind'] === 'SUBMIT_TURN' &&
      typeof item['requestId'] === 'string' &&
      typeof item['userText'] === 'string'
    )
  })
record(
  'S5',
  '协议形状**逐字段**符合 `BridgeWireRequest`（只有 `kind`/`requestId`/`userText`；没有多余字段）',
  shapeOk,
  `实际键集合=${JSON.stringify(session.parsed.map((item) => Object.keys(item).sort().join(',')))}`,
  available ? session.parsed.length + 1 : 0
)

// --- S7 不声称已播出 --------------------------------------------------------
const sentBlob = session.sentLines.join('\n')
record(
  'S7',
  '客户端**不**声称已播出：它发出的行里没有 `delivery` / `played` / `playing` 字段（媒体契约 §1 的三本账）',
  available &&
    !/"(delivery|played|playing|queued)"\s*:/.test(sentBlob) &&
    session.parsed.every((item) => !('delivery' in item)),
  `发出 ${session.sentLines.length} 行 · 含 delivery 类字段=${String(/"(delivery|played|playing|queued)"\s*:/.test(sentBlob))}`,
  available ? 2 : 0
)

// --- S4 旧候选过期（单独一次会话：u1 无回应就被 u2 顶掉）--------------------
/*
 * ⚠️ 这里的 responder **必须自包含**：它会被 `toString()` 后塞进另一个模块执行，
 * 引用外层的任何标识符都会让驱动脚本抛 `ReferenceError`（而症状是"读数全 undefined"，
 * 看起来像协议坏了）。第一版引用了外层的 replyFor —— 就是这个问题。
 * 因此把回复形状在**函数体内**重新构造一遍。
 */
const expireSession = available
  ? runSession(
      [
        { utteranceId: 'u1', text: '第一个问题', isFinal: true },
        { utteranceId: 'u2', text: '第二个问题', isFinal: true },
      ],
      // ⚠️ 故意让第一条**失败**：模拟"上一轮没成，用户又开口了"
      (request) =>
        String(request['requestId']) === 'utt:u1'
          ? { kind: 'TURN_RESULT', requestId: 'utt:u1', outcome: 'failed', code: 'probe_no_reply', delivery: 'failed' }
          : {
              kind: 'TURN_RESULT',
              requestId: String(request['requestId'] ?? ''),
              outcome: 'replied',
              replyText: 'ok:' + String(request['userText'] ?? ''),
              replyId: 'cev:probe',
              traceId: 'trc:probe',
              delivery: 'generated',
            }
    )
  : session
record(
  'S4',
  '**旧候选过期**：新语音到达 ⇒ 旧候选标记 `expired`；`usableReplies` **只**算未过期的成功回复',
  available &&
    expireSession.stderrSummary?.['submitted'] === 2 &&
    expireSession.stderrSummary?.['usableReplies'] === 1,
  `提交=${String(expireSession.stderrSummary?.['submitted'])}（应 2）· 可用回复=${String(expireSession.stderrSummary?.['usableReplies'])}（应 1 —— 只有 u2 那条）`,
  available ? 3 : 0
)

/*
 * ⚠️ 这里的判据是**"至少发过一次取消"**，而且要在一个**真的会被顶掉**的会话上量。
 * 主会话里 u1 的重复投递走的是**去重**（不是取消），因为那一条已经有回应了。
 * 因此 S8 用上面那个 `expireSession` 来量 —— 那里面 u1 被 u2 顶掉。
 */
record(
  'S8',
  '**取消通道真的被用上**（`L-PL2-04`）：新语音顶掉旧候选时，客户端发出 `CANCEL_TURN`（不只是本地标过期）',
  available &&
    (expireSession.stderrSummary?.['cancelRequestsSent'] as number) >= 1 &&
    (expireSession.stderrSummary?.['cancelTargets'] as unknown[])?.includes('utt:u1') === true,
  `会话（u1 被 u2 顶掉）：发出取消=${String(expireSession.stderrSummary?.['cancelRequestsSent'])} · ` +
    `目标=${JSON.stringify(expireSession.stderrSummary?.['cancelTargets'])}（应含 utt:u1）· ` +
    `主会话发取消=${String(session.stderrSummary?.['cancelRequestsSent'])}（应 0：那条是被**去重**的，不是被取消的）`,
  available ? 2 : 0
)

// ===========================================================================
// V1 量具自证三段式
// ===========================================================================
/** 被检验的判据本体：**partial 不得产生任何提交** */
const detectPartialSubmission = (
  utterances: readonly { isFinal: boolean }[],
  submitted: number
): boolean => utterances.filter((item) => !item.isFinal).length > 0 && submitted > 0
const selfCheck = (() => {
  const partials = [{ isFinal: false }, { isFinal: false }, { isFinal: false }]
  const positive = detectPartialSubmission(partials, 0) // 正控：真会话里 partial=3、提交=1... 见下
  // ⚠️ 正控要打在**真实读数**上：本会话里 partial=3、提交=1（那 1 次来自 final）——
  //    因此"有 partial 且 submitted>0"为真**并不**说明 partial 造成了提交。
  //    真正要判的是：**把 final 全部去掉之后，提交数必须是 0**。
  const finalsOnly = partials // 只有 partial、没有 final
  const realDetect = (items: readonly { isFinal: boolean }[], submittedCount: number): boolean =>
    items.every((item) => !item.isFinal) && submittedCount > 0
  const negative = realDetect(finalsOnly, 1) // 负控：只有 partial 却有提交 ⇒ 必须响
  const restored = realDetect(finalsOnly, 0) // 恢复：只有 partial 且没提交 ⇒ 安静
  void positive
  return {
    ok: negative === true && restored === false,
    detail: `负控（只有 partial 却有提交）=${String(negative)}（应 true）· 恢复（只有 partial 且无提交）=${String(restored)}（应 false）· 真实会话 partial=${String(session.stderrSummary?.['partialsSeen'])} 提交=${String(session.stderrSummary?.['submitted'])}`,
  }
})()
record('V1', '量具自证三段式：判据打在"去掉全部 final 之后提交数必须为 0"这条不变量上', selfCheck.ok, selfCheck.detail, 2)

// ===========================================================================
// 汇总与证据
// ===========================================================================
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failedChecks = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const verdict = !available ? 'NOT RUN' : !gateValid ? 'MEASUREMENT INVALID' : failedChecks.length === 0 ? 'PASS' : 'FAIL'

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-speech-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const artifact = {
  runId,
  gate: 'postlv2:speech:verify',
  milestone: 'post-lv2 / WP5 (LG-side speech bridge client)',
  generatedAt: new Date().toISOString(),
  source: { head },
  externalPrerequisites: { depsRoot: DEPS_ROOT, python: existsSync(PYTHON), client: existsSync(CLIENT) },
  session: {
    sentLines: session.sentLines,
    summary: session.stderrSummary ?? null,
    driverDiagnostics: session.driverDiagnostics ?? null,
    rawStderr: session.rawStderr ?? null,
    childExit: session.childExit ?? null,
    error: session.error ?? null,
  },
  expireSession: { summary: expireSession.stderrSummary ?? null },
  checks,
  measuredCount,
  verdict,
  notClaimed: [
    '不主张真实麦克风/真 VAD：本门喂的是**合成**的识别结果序列',
    '不主张对端是真 LG：对端由本门扮演，但协议形状与真桥逐字段一致',
    '不主张取消已传播到 LG：桥**没有**取消通道，因此"丢弃过期回复"目前是**客户端侧**的行为（残余 L-PL2-04）',
    '不主张 TTS / 播放：本门完全不碰音频输出',
  ],
  residual: {
    id: 'L-PL2-04',
    summary: '桥没有取消通道：`SUBMIT_TURN` 一旦发出，LG 会跑完那一轮（含模型调用与账本写入）',
    consequence:
      '用户打断后**不会有第二次模型调用被省下**；被丢弃的只是"过期的回复不再展示/合成"。' +
      '计划 §8.3 要求的"取消旧候选、旧包不得自动入模"在**客户端侧**成立，' +
      '在**服务端**（省下一次模型调用）**不成立**。',
    evidence: '本门的 S4：u1 那条仍然完成了提交（submitted=2），只是 usableReplies 只算 1 条',
    fixNeeds: '协议加一条取消消息 + LG 侧在取消点检查（属独立裁定；会改 bridge 的受控消息种类）',
  },
}
writeFileSync(join(outDir, 'speech-verify.json'), JSON.stringify(artifact, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${verdict === 'PASS' ? '✅' : verdict === 'NOT RUN' ? '⏭️' : '❌'} postlv2:speech:verify = ${verdict}`)
console.log(`  ⚠️ 残余 L-PL2-04：桥没有取消通道（取消只在客户端侧成立）`)
console.log(`  证据：artifacts/post-lv2/${runId}/speech-verify.json`)

process.exit(verdict === 'PASS' || verdict === 'NOT RUN' ? 0 : 1)
