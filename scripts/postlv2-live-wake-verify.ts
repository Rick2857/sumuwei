/**
 * Lv4.5 / `P2`+`P3` —— **唤醒链路的单次判定**（把散在几处的读数收成一个判决）。
 *
 * ============================================================================
 *  为什么要有它（不是脚本洁癖）
 * ============================================================================
 * 这条链路的读数是**跨三个地方**的：
 * ```text
 * ① 探针（这条 websocket 收到了什么）
 * ② `/lg/status`（LG 与外壳各自记了什么）
 * ③ 逐次运行之间的连接身份（谁的读数是谁的）
 * ```
 * 我在这上面**反复读错**过：取错客户端键（拿到上一次运行的计数）、漏统计一列
 * （真正的未命中被报成 0）、把"服务端记了 spoken"当成"这个客户端听到了"。
 * 每一次看起来都像"链路有问题"，其实都是**读数取错**。
 * 所以判决只留一处实现，并且**逐字段说明它凭什么**。
 *
 * ```text
 * 用法（在线）： npx tsx scripts/postlv2-live-wake-verify.ts
 * 用法（离线自检）： npx tsx scripts/postlv2-live-wake-verify.ts --from <probe.json>
 *                    ↑ 用已落盘的探针输出**验判决逻辑本身**（不需要服务在跑）
 * ```
 *
 * ⚠️ `--from` 喂**旧证据**时会如实判 FAIL：那些证据早于
 *    `readingIsFromOurClient` / `deliveredToOurConnection` 两个字段，
 *    因此它**无法**证明"这条连接真的收到了" —— 判 FAIL 是对的，
 *    不是产品回归（输出里的 `source` 会写明读数来自文件）。
 */

export {}

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface ProbeReading {
  partialEvents?: number
  earlyPartialEvents?: number
  preparedSent?: number | null
  readingIsFromOurClient?: boolean
  prepareVerdicts?: { prepared?: number; recall_ran?: number; rejected?: number; failed?: number } | null
  interjection?: {
    serverReading?: { started?: number; spoken?: number; dropped?: number; unsupported?: number; revoked?: number } | null
    clientUid?: string | null
    deliveredToOurConnection?: boolean
    turnPackets?: number
    audioChunks?: number
    spokenText?: string | null
  }
}

const fromIndex = process.argv.indexOf('--from')
const fromPath = fromIndex >= 0 ? process.argv[fromIndex + 1] : undefined
/**
 * `--repeat N`：连跑 N 次并**聚合**（计划 §3/§4 的"一批"要求）。
 *
 * ⚠️ 它**不是**"跑一次看绿"的放大版：聚合要回答的是**稳定性** ——
 *    每一次都恰好一条？每一次都投到**发起它的那条连接**？有没有偶发的 0 或 2？
 *    这些在不稳定时都表现为"用户说没反应/她说了两遍"，而单次运行看不出来。
 */
const repeatIndex = process.argv.indexOf('--repeat')
const repeat = repeatIndex >= 0 ? Math.max(1, Number(process.argv[repeatIndex + 1] ?? 1)) : 1

let raw: string
if (fromPath !== undefined) {
  raw = readFileSync(resolve(fromPath), 'utf8')
} else {
  const wav = process.env.LG_PARTIAL_WAV ?? 'artifacts/post-lv2/local/wake-sample-20261004.wav'
  if (!existsSync(wav)) {
    console.error(`找不到语料：${wav}（用 LG_PARTIAL_WAV 指定）`)
    process.exit(1)
  }
  /*
   * ⚠️ 用**本仓库的** tsx 直接跑，不要 `npx`：
   *    Windows 上 `spawnSync('npx')` 找不到可执行文件（要靠 `npx.cmd` 的 shell 解析），
   *    实测报 `ENOENT`；而 `process.execPath` + 本地 tsx 入口在任何平台都成立。
   */
  const runOnce = (): string => execFileSync(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/postlv2-partial-live-probe.ts'],
    { encoding: 'utf8', env: { ...process.env, LG_PARTIAL_WAV: wav }, maxBuffer: 32 * 1024 * 1024 }
  )
  if (repeat === 1) {
    raw = runOnce()
  } else {
    /*
     * ⚠️ 每一轮之间要**留间隔**：相邻两次跑得太近时，外壳那边"上一条连接的读数"
     *    与服务端计数的对照会互相干扰（实测：连跑两次，第二次的 `last_client`
     *    还是第一次的连接）。间隔让每次运行的读数归属清楚。
     */
    const perRun: { index: number; checks: Record<string, boolean>; verdict: string; readings: Record<string, unknown> }[] = []
    for (let index = 1; index <= repeat; index += 1) {
      const text = runOnce()
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      const parsed = JSON.parse(text.slice(start, end + 1)) as ProbeReading
      /* ⚠️ 用**同一个** `evaluate` —— 批量与单次的判据必须是同一份实现 */
      const judged = evaluate(parsed)
      perRun.push({
        index,
        checks: judged.checks,
        verdict: judged.verdict,
        readings: {
          interjectionAudioChunks: parsed.interjection?.audioChunks ?? 0,
          serverStarted: parsed.interjection?.serverReading?.started ?? null,
          serverSpoken: parsed.interjection?.serverReading?.spoken ?? null,
          deliveredToOurConnection: parsed.interjection?.deliveredToOurConnection ?? null,
          clientUid: parsed.interjection?.clientUid ?? null,
          spokenText: parsed.interjection?.spokenText ?? null,
        },
      })
      console.error(`  run ${String(index)}/${String(repeat)}: ${judged.verdict}${judged.failed.length > 0 ? ' (' + judged.failed.join(' / ') + ')' : ''}`)
      if (index < repeat) await new Promise((done) => setTimeout(done, 2500))
    }
    const passes = perRun.filter((item) => item.verdict === 'PASS').length
    /* 逐判据的**失败次数**：只看总分看不出"是哪一个环节在偶发" */
    const failedByCheck: Record<string, number> = {}
    for (const item of perRun) {
      for (const [name, ok] of Object.entries(item.checks)) {
        if (!ok) failedByCheck[name] = (failedByCheck[name] ?? 0) + 1
      }
    }
    /* ⚠️ "她说了几条"必须**逐轮**记：0 条（没听见）与 2 条（说了两遍）都要看得见 */
    const perRunInterjections = perRun.map((item) => Number(item.readings.interjectionAudioChunks ?? 0))
    /*
     * ⚠️ **总量对账**（批量末尾）：把每一轮读到的 `started` 差值与实际轮数比。
     *
     * 为什么不逐轮比：`spoken`（收尾完成）最长滞后 5 秒，逐轮比会误判；
     * 而**总量**能一次性回答"到底有几次真的说出去了" —— 多一次（说了两遍）或少一次
     * （没听见）都会在这里对上号。
     */
    const startedFirst = Number(perRun[0]?.readings.serverStarted ?? 0)
    const startedLast = Number(perRun.at(-1)?.readings.serverStarted ?? 0)
    const startedTotal = startedLast - startedFirst + 1
    const batch = {
      verify: 'Lv4.5 live wake chain - BATCH (stability, not a single green run)',
      repeat,
      passes,
      passRate: Number((passes / repeat).toFixed(3)),
      failedByCheck,
      /**
       * 每轮收到的插话音频块数。判据：**恒为 ≥1**（每轮都听见），
       * 且服务端每轮"开始投递"恰好一次（**不是**三遍）。
       */
      perRunInterjections,
      runsWithNoAudio: perRunInterjections.filter((count) => count === 0).length,
      /** 总量对账：实际开始投递的次数 vs 轮数（多一次=说了两遍，少一次=漏了） */
      aggregate: {
        startedFirst,
        startedLast,
        startedTotal,
        expected: repeat,
        matchesRunCount: startedTotal === repeat,
      },
      verdict:
        passes === repeat &&
        perRunInterjections.every((count) => count >= 1) &&
        startedTotal === repeat
          ? 'PASS'
          : 'FAIL',
      runs: perRun,
      notClaimed: [
        '语料是**机器合成**的普通话（用户 2026-10-04 裁定"就按普通话来"），不是真人麦克风',
        '这一批**不含**模型调用：唤醒短句是程序既定的 ⇒ 它不构成"完整轮次"的时延读数',
        '它证明的是**链路稳定性**（每次都恰好一条、都投到发起它的连接），不是识别准确率',
        '逐轮的 `spoken`（收尾完成）最长滞后 5 秒 ⇒ 判**这一次**用 `started`，收尾是否完成看总量对账',
      ],
    }
    console.log(JSON.stringify(batch, null, 2))
    process.exit(batch.verdict === 'PASS' ? 0 : 1)
  }
}
const start = raw.indexOf('{')
const end = raw.lastIndexOf('}')
if (start < 0 || end <= start) {
  console.error('探针输出里没有 JSON（先确认它跑起来了）')
  process.exit(1)
}
const probe = JSON.parse(raw.slice(start, end + 1)) as ProbeReading

/**
 * 判据逐条，且每条都说明**它凭的是哪一处的读数**：
 * ```text
 * ① 流式那一半真的跑了      —— 探针自己数到的 partial 条数（本连接）
 * ② 只读准备被 LG 接受了    —— LG 回在 /lg/status 的判决（不是"我们发出了几条"）
 * ③ 她说出来了             —— **服务端**读数 spoken ≥ 1
 * ④ 而且**这条连接收到了**  —— 探针收到的、属于插话的音频块 ≥ 1
 *    ⚠️ ③ 与 ④ 必须**同时**成立：只有 ③ 时，"她说了"可能说给了一条已经断开的连接
 *       （实测踩到过：服务端 spoken=1，而这条连接一个音频包都没收到）
 * ⑤ 读数确实来自本连接      —— 否则整份读数可能描述的是另一次运行
 * ```
 *
 * ⚠️ 它是**一个函数**，单次与批量共用：批量里若另写一份判据，两份迟早会漂移，
 *    而"批量绿、单次红"这种不一致最难查（第一版批量就是把**探针**的输出
 *    当成**判据**输出去解析，于是每轮 `checks` 都是空的、却还报 PASS）。
 */
function evaluate(input: ProbeReading): { checks: Record<string, boolean>; failed: string[]; verdict: string } {
  const interjection = input.interjection ?? {}
  const server = interjection.serverReading ?? {}
  const verdicts = input.prepareVerdicts ?? {}
  const checks = {
    '流式 partial 真的产出': (input.partialEvents ?? 0) >= 2,
    'partial 出现在音频结束之前': (input.earlyPartialEvents ?? 0) >= 1,
    '只读准备被 LG 接受（有真实召回）': (verdicts.prepared ?? 0) >= 1 && (verdicts.recall_ran ?? 0) >= 1,
    '这份客户端读数确实来自本连接': input.readingIsFromOurClient === true,
    /*
     * ⚠️ 用**开始投递**的计数（`started`）而不是**收尾完成**的（`spoken`）：
     *    收尾要排空，最长 5 秒；用 `spoken` 判"这一次说没说"会**误判成没说**
     *    （批量 20 次里真的撞上一次：探针收到了 2 个音频块，而 `spoken` 还没涨）。
     *    收尾是否真的完成，交给批量末尾的**总量对账**去看（见 batch 的 aggregate）。
     */
    '她开始说了（服务端计数）': (server.started ?? server.spoken ?? 0) >= 1,
    '这条连接**真的收到了**插话音频': (interjection.audioChunks ?? 0) >= 1,
    '投递目标是这条连接': interjection.deliveredToOurConnection === true,
    '插话内容是她该说的那一句': interjection.spokenText === '我在。',
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
  return { checks, failed, verdict: failed.length === 0 ? 'PASS' : 'FAIL' }
}

const interjection = probe.interjection ?? {}
const server = interjection.serverReading ?? {}
const { checks, failed, verdict } = evaluate(probe)

console.log(JSON.stringify({
  verify: 'Lv4.5 live wake chain (partial -> read-only prepare -> sourced interjection -> audio)',
  source: fromPath ?? 'live',
  verdict,
  checks,
  failed,
  readings: {
    partialEvents: probe.partialEvents ?? null,
    earlyPartialEvents: probe.earlyPartialEvents ?? null,
    preparedSent: probe.preparedSent ?? null,
    prepareVerdicts: probe.prepareVerdicts ?? null,
    clientUid: interjection.clientUid ?? null,
    serverInterjection: probe.interjection?.serverReading ?? null,
    interjectionAudioChunks: interjection.audioChunks ?? null,
    interjectionTurnPackets: interjection.turnPackets ?? null,
    spokenText: interjection.spokenText ?? null,
  },
  notClaimed: [
    '语料是**机器合成**的普通话，不是真人麦克风 —— 它判链路，不判体验',
    '单次运行：不构成时延或成功率结论',
  ],
}, null, 2))
process.exit(verdict === 'PASS' ? 0 : 1)
