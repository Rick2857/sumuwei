/**
 * Lv4.5 / P1 —— **同钟计时探针**（浏览器侧时钟，走真实皮套服务）。
 *
 * ============================================================================
 *  它回答计划 §3 第二步里那些**可判定的**计时问题
 * ============================================================================
 * ```text
 * ① 输入提交 → 首个可感知反馈          （协议侧：`lg-expression-turn`）
 * ② 输入提交 → 首段实质语音**实际开始播**（`lg-audio-chunk` 的第一块）
 * ③ 明确停止信号 → 停播                （发送 stop → 我们停止排程的时刻）
 * ```
 *
 * ⚠️ 三条**边界**（写进读数，不许外推）：
 * ```text
 * · 本探针**不是浏览器**：它是 Node 里的 WebSocket 客户端。因此它量的是
 *   "协议与合成"那一段，**不含**真实声卡播放、浏览器 Web Audio 排程、
 *   也不含真人打字/说话的耗时。它与 `postlv2-playback-chain-probe.ts` 分列。
 * · 全部时间戳取**同一个时钟**（本进程的 `performance.now()`）；服务端时间只做对账，
 *   因此不存在"两台机器的时钟相减"。
 * · **冷启动单列**：第一轮包含模型预热与首包冷启动，不混进热轮次的读数。
 *   （计划 §3 第二步要求"冷启动单列，不混入普通热轮次"。）
 * ```
 */

export {}

import { execFileSync } from 'node:child_process'

const PORT = Number(process.env.LG_AVATAR_PORT ?? 12393)
const BASE = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/client-ws`
const TURNS = Number(process.env.LG_TIMING_TURNS ?? 5)
const TIMEOUT_MS = 180_000

interface AudioChunk {
  type: string
  audio?: string
  final?: boolean
  actions?: { lg_expression?: { segmentId?: string; requestId?: string } }
}

const now = (): number => performance.now()

interface TurnTiming {
  turn: number
  cold: boolean
  userText: string
  /** 输入提交 → 首个可感知反馈（协议侧） */
  firstFeedbackMs: number | null
  /** 输入提交 → 首段实质语音的开始（第一块带音频的包） */
  firstSpeechStartMs: number | null
  /** 输入提交 → 全部片段收尾 */
  completedMs: number | null
  /** 收到几个片段 / 几个音频块 */
  segments: number
  audioChunks: number
  /** 明确停止信号 → 我们真的停下来的时刻 */
  stopAfterSignalMs: number | null
}

/** 跑一轮并量时延；返回后客户端会**停**（用于停播计时） */
async function runTurn(userText: string, turn: number, cold: boolean): Promise<TurnTiming> {
  const timing: TurnTiming = {
    turn,
    cold,
    userText,
    firstFeedbackMs: null,
    firstSpeechStartMs: null,
    completedMs: null,
    segments: 0,
    audioChunks: 0,
    stopAfterSignalMs: null,
  }
  const seen = new Set<string>()
  const finished = new Set<string>()
  const socket = new WebSocket(WS_URL)
  return await new Promise((resolve, reject) => {
    let submittedAt = 0
    let stopSignalAt: number | null = null
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* 收尾 */ }
      reject(new Error(`计时探针超时（${TIMEOUT_MS}ms）`))
    }, TIMEOUT_MS)
    /** 首段语音开始播之后，等一个明确停止信号（模拟用户抢话），用于量停播 */
    const maybeStop = (): void => {
      if (stopSignalAt !== null) return
      if (timing.firstSpeechStartMs === null) return
      stopSignalAt = now()
      socket.send(JSON.stringify({ type: 'interrupt' }))
    }
    const maybeDone = (): void => {
      if (finished.size === 0 || finished.size < timing.segments) return
      timing.completedMs = now() - submittedAt
      if (stopSignalAt !== null) timing.stopAfterSignalMs = now() - stopSignalAt
      clearTimeout(timer)
      try { socket.close() } catch { /* 收尾 */ }
      resolve(timing)
    }
    socket.addEventListener('open', () => {
      submittedAt = now()
      socket.send(JSON.stringify({ type: 'text-input', text: userText }))
    })
    socket.addEventListener('message', (event) => {
      let packet: AudioChunk
      try {
        packet = JSON.parse(String(event.data)) as AudioChunk
      } catch {
        return
      }
      if (packet.type === 'lg-expression-turn' && timing.firstFeedbackMs === null) {
        timing.firstFeedbackMs = now() - submittedAt
        return
      }
      if (packet.type !== 'lg-audio-chunk') return
      const segmentId = packet.actions?.lg_expression?.segmentId
      if (typeof segmentId !== 'string') return
      if (!seen.has(segmentId)) {
        seen.add(segmentId)
        timing.segments += 1
      }
      if (packet.audio) {
        timing.audioChunks += 1
        if (timing.firstSpeechStartMs === null) timing.firstSpeechStartMs = now() - submittedAt
      }
      if (packet.final === true) finished.add(segmentId)
      /* 首段开始播之后立刻给停止信号（模拟抢话），再让收尾自然发生 */
      maybeStop()
      maybeDone()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('连不上皮套服务的 /client-ws'))
    })
  })
}

/* ===========================================================================
 *  **负载闸**（必须在**任何服务交互之前**执行）
 * ===========================================================================
 * 计划 §4.6：进入 CPU/GPU 测试前要按用户关于游戏占用的安排先约时段，不后台抢占算力。
 *
 * ⚠️ **第一版把它挂在文件末尾** ⇒ 轮次早就跑完了，闸形同虚设：
 *    实测"拒绝跑"的用例反而**跑了整整一批**（还把 600 秒的等待读成"闸没生效"）。
 *    闸的位置与闸的判据一样重要 —— 放在测量之后，它只是在**事后**盖个章。
 * ⚠️ 定义在下方（函数声明会被提升），**调用点在这里**。
 * ===========================================================================
 */
const load = checkLoad()
const allowLoad = process.argv.includes('--allow-load')
/** `--load-check`：只报负载判决、**不跑**任何一轮（用来验证这条闸自己） */
const loadCheckOnly = process.argv.includes('--load-check')
if (loadCheckOnly) {
  console.log(
    JSON.stringify(
      {
        loadState: load.state,
        found: load.found,
        ...(load.detail !== undefined ? { detail: load.detail } : {}),
        wouldRun: !(load.state === 'busy' && !allowLoad),
        /** 受污染时的处置：拒绝跑，或（`--allow-load`）跑但**盖戳** */
        verdict:
          load.state === 'busy'
            ? allowLoad
              ? 'WOULD RUN, STAMPED CONTAMINATED'
              : 'REFUSED（有人在用 GPU/CPU；用 --allow-load 强行跑会把读数盖戳）'
            : load.state === 'unavailable'
              ? 'WOULD RUN（负载**未查成** ⇒ 读数会记 loadCheck=unavailable，不当成干净窗口）'
              : 'WOULD RUN（查过、干净）',
      },
      null,
      2
    )
  )
  process.exit(0)
}
if (load.state === 'busy' && !allowLoad) {
  console.error(
    `\n⛔ 拒绝跑时序批次：检测到重负载进程 ${load.found.join(', ')}\n` +
      '   计划 §4.6：进入 CPU/GPU 测试前要先与用户约可测试时段，不后台抢占算力。\n' +
      '   在有人打游戏的窗口里量出来的时延**不是她的性能**（实测踩过：p50 14.4s 全是争抢造成的）。\n' +
      '   · 想等干净窗口：等它退出再跑\n' +
      '   · 确有理由现在跑：加 `--allow-load`（读数会被盖上"受污染"的戳）\n'
  )
  process.exit(2)
}
if (load.state === 'busy') {
  console.error(`⚠️ 负载闸：检测到 ${load.found.join(', ')}，但给了 --allow-load ⇒ 读数将盖戳为**受污染**`)
}

const readStatus = async (): Promise<any> => (await fetch(`${BASE}/lg/status`)).json()
const before = await readStatus()
console.log(`[timing] 服务 mode=${before.mode} lg_alive=${before.lg_process_alive}`)

const timings: TurnTiming[] = []
for (let turn = 1; turn <= TURNS; turn += 1) {
  /* 每轮换一句，避免幂等/缓存把它变成同一轮 */
  const userText = `计时第 ${String(turn)} 轮：用一句话回我。`
  const timing = await runTurn(userText, turn, turn === 1)
  timings.push(timing)
  console.log(
    `  · 轮 ${String(turn)}${timing.cold ? '（冷启动）' : ''} 首反馈=${String(timing.firstFeedbackMs)}ms ` +
      `首段语音=${String(timing.firstSpeechStartMs)}ms 完成=${String(timing.completedMs)}ms ` +
      `片段=${String(timing.segments)} 音频块=${String(timing.audioChunks)} 停播=${String(timing.stopAfterSignalMs)}ms`
  )
  /* 轮与轮之间留一点间隔：让"冷"只出现在第一轮 */
  await new Promise((resolve) => setTimeout(resolve, 500))
}

/**
 * ============================================================================
 *  **负载闸**：时序读数不许在"有人正在用 GPU"的窗口里悄悄产生
 * ============================================================================
 * 计划 §4.6 的原话是"进入 CPU/GPU 测试前，**按用户关于游戏占用的安排先联系用户**，
 * 等可测试时段，**不后台抢占算力**"。而这条纪律**曾经只活在我脑子里**：
 * 实测跑过一次 10 轮批次，读数 p50 14.4s / max 21.5s，看着像"她慢得离谱" ——
 * 其实是**用户在打游戏**（FarCry6 13,967 CPU 秒 + 4.3GB），而我的服务还在跟它抢。
 * 那批读数**不能**用来对 §3 阈值下任何结论。
 *
 * ⇒ 把纪律变成**机器判据**：
 * ```text
 * 发现已知的重负载进程 ⇒ **拒绝跑**（exit 2），并说明原因与出路
 * 显式 --allow-load    ⇒ 跑，但**每一行读数都盖上"受污染"的戳**
 * 检查本身跑不了      ⇒ **照跑**，但读数里记 `loadCheck: "unavailable"`
 *                       （"不知道"必须与"干净"分得开，不许默认干净）
 * ```
 * ⚠️ 名单可以用 `LG_HEAVY_PROCESSES` 覆盖（逗号分隔，不含 `.exe`）—— 那也让这条
 *    闸自己可以被**三段式**验证（换一个不存在的名字 ⇒ 必然"干净"）。
 */
/**
 * 重负载进程名单（**函数**而不是 `const`：负载闸要在文件顶部就调用，
 * 而 `const` 不提升 ⇒ 写成 `const` 会在调用点抛 TDZ ReferenceError）。
 */
function heavyProcessNames(): readonly string[] {
  return (process.env.LG_HEAVY_PROCESSES ??
    'FarCry6,FarCry5,FarCry4,Cyberpunk2077,eldenring,Starfield,bg3,RDR2,GTA5,genshinimpact,YuanShen'
  ).split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== '')
}

interface LoadVerdict {
  /** `clean` = 查过且没有；`busy` = 查到；`unavailable` = **没查成**（不许当成 clean） */
  state: 'clean' | 'busy' | 'unavailable'
  found: string[]
  detail?: string
}

function checkLoad(): LoadVerdict {
  try {
    /*
     * ⚠️ 只问"这些名字在不在"，不去采 CPU —— 要防的是"有人在用 GPU/在玩游戏"，
     *    按名字问就够了，而且不会因为采样本身引入噪声。
     */
    const output = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 15_000 })
    const running = new Set<string>()
    for (const line of output.split(/\r?\n/)) {
      const match = /^"([^"]+)"/.exec(line.trim())
      if (match?.[1] !== undefined) running.add(match[1].toLowerCase())
    }
    const found = heavyProcessNames().filter((name) => running.has(`${name}.exe`) || running.has(name))
    return { state: found.length > 0 ? 'busy' : 'clean', found }
  } catch (error) {
    /* ⚠️ **不**把"查不了"当成"没问题"（那就是假绿） */
    return {
      state: 'unavailable',
      found: [],
      detail: error instanceof Error ? error.name : 'unknown',
    }
  }
}

/* ⚠️ 判决块**已移到文件顶部**（那里才是"任何服务交互之前"）。
   放在测量之后，闸只是在**事后**盖个章 —— 实测"拒绝跑"的用例反而跑了一整批。 */

const percentile = (values: number[], p: number): number | null => {  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}

const hot = timings.filter((item) => !item.cold)
const cold = timings.filter((item) => item.cold)
const firstFeedback = hot.map((item) => item.firstFeedbackMs).filter((v): v is number => v !== null)
const firstSpeech = hot.map((item) => item.firstSpeechStartMs).filter((v): v is number => v !== null)
const stops = timings.map((item) => item.stopAfterSignalMs).filter((v): v is number => v !== null)

const reading = {
  probe: 'Lv4.5 P1 same-clock timing (Node WebSocket client against the real service)',
  port: PORT,
  /*
   * ⚠️ **负载戳**：读数必须自带"这是在什么机器状态下量的"。
   *    没有它，一批在打游戏时量出来的数会被当成她的性能（实测踩过）。
   */
  load: {
    state: load.state,
    found: load.found,
    ...(load.detail !== undefined ? { detail: load.detail } : {}),
    contaminated: load.state === 'busy',
    ...(load.state === 'unavailable' ? { note: '负载**未查成** ⇒ 本读数**不**代表干净窗口' } : {}),
  },
  turnsRequested: TURNS,
  coldTurn: cold[0] ?? null,
  hotTurns: hot.length,
  /** 计划 §3 阈值 ①：输入后首个可感知反馈每次 ≤ 10 000 ms */
  firstFeedbackMs: {
    values: firstFeedback,
    max: firstFeedback.length > 0 ? Math.max(...firstFeedback) : null,
    p50: percentile(firstFeedback, 50),
    p95: percentile(firstFeedback, 95),
    over10000ms: firstFeedback.filter((value) => value > 10_000).length,
  },
  /** 计划 §3 阈值 ②：有意义语音延迟（普通短轮）目标 p95 ≤ 5 000 ms */
  firstSpeechStartMs: {
    values: firstSpeech,
    max: firstSpeech.length > 0 ? Math.max(...firstSpeech) : null,
    p50: percentile(firstSpeech, 50),
    p95: percentile(firstSpeech, 95),
    over5000ms: firstSpeech.filter((value) => value > 5_000).length,
  },
  /** 计划 §3 阈值 ③：本地确认有效停止后停播 ≤ 250 ms（本探针量的是**协议侧**收到停止后停止排程） */
  stopAfterSignalMs: {
    values: stops,
    max: stops.length > 0 ? Math.max(...stops) : null,
    p95: percentile(stops, 95),
    over250ms: stops.filter((value) => value > 250).length,
  },
  /**
   * 计划 §3 三条阈值的**判决**（把读数变成判据，免得每次人眼看数字）。
   *
   * ⚠️ **样本量不足时不许判 PASS**：`n < 20` 时 p95 只是"这一批的最大值附近"，
   *    说"p95 达标"是把小样本当成结论。因此样本不足一律 `NOT ENOUGH SAMPLES`，
   *    而不是 PASS —— 这与仓库"缺证据不等于通过"是同一条纪律。
   * ⚠️ `firstFeedback` **不是**"她出声了"：它只说明"新的一轮开始了"
   *    （`lg-expression-turn` 到达）。真正可感知的是 `firstSpeechStartMs`，
   *    所以两条分别判、**不合并**成一句"首反馈达标"。
   */
  thresholds: (() => {
    const enough = hot.length >= 19
    const judge = (label: string, measured: number | null, limit: number): string => {
      if (!enough) return 'NOT ENOUGH SAMPLES'
      if (measured === null) return 'NO READING'
      return measured <= limit ? 'PASS' : 'FAIL'
    }
    return {
      samples: hot.length,
      samplesEnoughForP95: enough,
      '首反馈（轮次开始）p95 ≤ 10000ms': judge('firstFeedback', percentile(firstFeedback, 95), 10_000),
      '首段语音 p95 ≤ 5000ms': judge('firstSpeech', percentile(firstSpeech, 95), 5_000),
      '停播 p95 ≤ 250ms（协议侧）': judge('stop', percentile(stops, 95), 250),
    }
  })(),
  readings: timings,
  notClaimed: [
    '不是浏览器：量的是协议与合成那一段，不含真实声卡播放、Web Audio 排程与真人输入耗时',
    '停播那一列量的是"收到停止信号 → 探针停止排程"，不是声卡实际静音时刻',
    '样本量很小（个位数），只能作为本批读数，不能证明稳定 p95（计划 §3 第二步原话）',
    '没有检索/任务类轮次，也没有故障/断线轮次',
  ],
}
console.log('')
console.log(JSON.stringify(reading, null, 2))
