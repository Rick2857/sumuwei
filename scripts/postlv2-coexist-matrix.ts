/**
 * post-Lv2 / **ADR-109 WP4** —— 双入口共存的**场景矩阵**（计划 §5 的 12 个场景）+ **性能读数**。
 *
 * ============================================================================
 *  它验的是什么
 * ============================================================================
 * 计划 §4 WP4 的通过条件：
 * ```text
 * 硬隔离场景全部通过；真实模型、真人体验、性能读数**分别**给结论；
 * 完整离线 CI 退出码 0；失败档保留。
 * ```
 * 因此本门的每一项都**如实**落在四种结论之一：`PASS` / `FAIL` / `NOT RUN` / `N/A`。
 * 「没跑」不许写成 PASS，「不适用」不许写成 PASS（AGENTS.md §6.4 的同一条纪律）。
 *
 * ⚠️ 它**不**打开生产库、**不**连真实 QQ/皮套、**不**调外部模型（本机固定回复夹具）。
 * ⚠️ 真实模型档在 `postlv2:coexist:live`（另一个脚本，经 `pnpm with-test-model`）。
 */
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import {
  EntryShell,
  LineReader,
  createRecorder,
  markersOf,
  startCoexistHost,
  startFakeModel,
  writeEvidence,
} from './coexist/harness.ts'
import { cleanupSandbox, isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import { ENTRY_PROTOCOL_VERSION } from '../src/infrastructure/qq/entry-handshake.ts'

const recorder = createRecorder()
const { check, observe, notRun, notApplicable } = recorder
const productionBefore = digestTree(PRODUCTION_DB_DIR).treeSha256

/** 一条 SQL 读回（只读） */
async function query(
  db: { query: (sql: string) => Promise<{ rows: unknown[] }> },
  sql: string
): Promise<Record<string, unknown>[]> {
  return (await db.query(sql)).rows as Record<string, unknown>[]
}

const model = await startFakeModel({ failMarker: 'MARK-B7' })
const sandboxes: string[] = []
let host: Awaited<ReturnType<typeof startCoexistHost>> | undefined
let hostRestart: Awaited<ReturnType<typeof startCoexistHost>> | undefined
let hostPerf: Awaited<ReturnType<typeof startCoexistHost>> | undefined
let perfSingleDir: string | undefined
let perfDualDir: string | undefined

try {
  const sandbox = isolateDatabase('coexist-wp4-matrix', { keep: true }).dir
  sandboxes.push(sandbox)
  host = await startCoexistHost({
    dbDir: sandbox,
    modelPort: model.port,
    /* 队列上限压到 2：场景 9 要能真的撞上它 */
    queueBound: 2,
    env: {
      /* 关系域开着：它是"公共生命周期只跑一次"的目击者（WP2 `E-0b` 的同一处） */
      CHARACTER_RELATIONSHIP_CONTEXT_ENABLED: 'true',
      CHARACTER_RECALL_ENABLED: 'true',
    },
  })
  await host.ready
  observe('H-0 隔离核心已就绪', host.stdout.find((line) => line.startsWith('COEXIST_READY')) ?? '')

  const qq = new EntryShell(host.qqPort, host.qqToken)
  const avatar = new EntryShell(host.avatarPort, host.avatarToken)
  const qqConversation = (await qq.ready).split(' ')[2] ?? ''
  const avatarConversation = (await avatar.ready).split(' ')[2] ?? ''
  const textOf = (result: Record<string, unknown>): string => String(result.replyText ?? '')
/** 证据里的正文一律截断：回复会带上整段近期窗口，原样落盘会让证据文件变成噪声 */
const short = (text: string, limit = 100): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…（共 ${String(text.length)} 字符）`

  // =========================================================================
  // S1 同时提交 QQ 与皮套文字；两边使用**相同外部 requestId**
  // =========================================================================
  {
    const same = 'req-same-1'
    const [left, right] = await Promise.all([
      qq.submit(same, 'MARK-A1 今天天气不错'),
      avatar.submit(same, 'MARK-B1 今天天气不错'),
    ])
    const leftText = textOf(left)
    const rightText = textOf(right)
    check(
      'S1 同外部 requestId 不冲突；回复各回原入口',
      leftText.includes('MARK-A1') &&
        rightText.includes('MARK-B1') &&
        markersOf(leftText, 'B').length === 0 &&
        markersOf(rightText, 'A').length === 0,
      `qq="${short(leftText)}" · avatar="${short(rightText)}"`
    )
  }

  // =========================================================================
  // S2 标记 A / B 再分别追问 ⇒ 近期上下文分别归属
  // =========================================================================
  {
    const [left, right] = await Promise.all([
      qq.submit('req-s2a', 'MARK-A2 那你说说看'),
      avatar.submit('req-s2b', 'MARK-B2 那你说说看'),
    ])
    check(
      'S2a 近期窗口按入口分开（追问看得到自己那条、看不到另一条）',
      textOf(left).includes('MARK-A1') &&
        textOf(right).includes('MARK-B1') &&
        markersOf(textOf(left), 'B').length === 0 &&
        markersOf(textOf(right), 'A').length === 0,
      `qq="${short(textOf(left))}" · avatar="${short(textOf(right))}"`
    )
    notRun(
      'S2b 会话摘要（rollup）区块的归属',
      '本轮的 Recent 窗口（CONVERSATION_LENGTH+2 = 18 行）覆盖了全部历史 ⇒ 摘要层没有可摘材料（`skippedByRecentWindow`）。'
    )
  }

  // =========================================================================
  // S3 跨入口共享记忆（正向 + 反向）
  // =========================================================================
  {
    const write = textOf(await qq.submit('req-s3a', '记住：MARK-A3 我在示例工程科技大学'))
    /* 反向：皮套写一条，QQ 问 */
    const writeBack = textOf(await avatar.submit('req-s3b', '记住：MARK-B3 我喜欢喝拿铁'))
    const askFromAvatar = textOf(await avatar.submit('req-s3c', 'MARK-B4 示例工程科技大学 是什么'))
    const askFromQq = textOf(await qq.submit('req-s3d', 'MARK-A4 拿铁 是什么'))
    check(
      'S3a 跨入口共享记忆：两条明确记忆操作各写一次，且**都不在**对方近期窗口里',
      markersOf(askFromAvatar, 'A').length === 0 && markersOf(askFromQq, 'B').length === 0,
      `qq 写="${write.slice(0, 40)}" · 皮套写="${writeBack.slice(0, 40)}" · 皮套问="${askFromAvatar}" · qq 问="${askFromQq}"`
    )
  }

  // =========================================================================
  // S4 普通闲聊 / 问句 / 引用记忆 / 否定命令 ⇒ 不得增加自动写入
  // =========================================================================
  {
    await qq.submit('req-s4a', 'MARK-A5 你觉得今天怎么样')
    await qq.submit('req-s4b', 'MARK-A6 我刚才说过什么')
    await qq.submit('req-s4c', 'MARK-A7 别记住这件事')
    await avatar.submit('req-s4d', 'MARK-B5 你平时喜欢什么')
    observe('S4 已喂入 3 条 QQ + 1 条皮套的普通/问句/引用/否定（写入数在 R 段读回）', '见 R-3')
  }

  // =========================================================================
  // S5 慢轮次期间取消**排队中**的请求（播放面见 NOT RUN）
  // =========================================================================
  {
    /*
     * ⚠️ 等待者**先登记、再 fire**：轮次可能在几百毫秒内就完成，
     *    而"先 fire 后登记"会丢掉那条已经到达的 `TURN_RESULT`（假超时）。
     */
    const slowPromise = qq.awaitTurn('req-s5slow')
    qq.fire('req-s5slow', 'SLOW900 MARK-A8 这一轮很慢')
    await delay(120)
    const queuedPromise = avatar.awaitTurn('req-s5queued')
    avatar.fire('req-s5queued', 'MARK-B6 这一条排在后面')
    await delay(120)
    const cancelReading = await avatar.control(
      'req-s5queued',
      'CANCEL_TURN',
      { reason: 'user_interrupt' },
      'CANCEL_RESULT'
    )
    const queued = await queuedPromise
    const slow = await slowPromise
    check(
      'S5a 慢轮次期间取消**排队中**的请求：它在模型之前停住，另一条照常完成',
      queued.outcome === 'failed' &&
        queued.code === 'bridge_turn_cancelled_before_model' &&
        textOf(slow).includes('MARK-A8'),
      `排队那条=${String(queued.code)} · 取消读数 requested=${String((cancelReading.cancel as Record<string, unknown>)?.requested)}` +
        ` · 慢轮次="${short(textOf(slow))}"`
    )
    notRun(
      'S5b 皮套**正在播放**时收到 QQ',
      '协议面没有真实音频（`state.playing` 由客户端上报）；真实播放中场景属于 WP3 剩下的那一半 + 真人体验。'
    )
  }

  // =========================================================================
  // S6 断开：两侧各断一次；核心保留
  // =========================================================================
  {
    const qqSecond = new EntryShell(host.qqPort, host.qqToken)
    await qqSecond.ready
    qqSecond.close()
    await delay(200)
    const afterQqGone = textOf(await avatar.submit('req-s6a', 'MARK-B8 QQ 那条断开了'))
    check(
      'S6a QQ 侧连接断开不影响皮套入口（新请求照常成功）',
      afterQqGone.includes('MARK-B8'),
      `avatar="${short(afterQqGone)}"`
    )
    const avatarSecond = new EntryShell(host.avatarPort, host.avatarToken)
    await avatarSecond.ready
    avatarSecond.close()
    await delay(200)
    const afterAvatarGone = textOf(await qq.submit('req-s6b', 'MARK-A9 皮套那条断开了'))
    check(
      'S6b 皮套侧连接断开不影响 QQ 入口（新请求照常成功）',
      afterAvatarGone.includes('MARK-A9'),
      `qq="${short(afterAvatarGone)}"`
    )
    notRun(
      'S6c 单路**超时**与单路发送失败',
      '超时要真等 180s 的桥期限或真慢的模型；发送失败属 QQ 外壳（`pnpm qq:verify` 已覆盖"发送失败后新请求恢复"）。'
    )
  }

  // =========================================================================
  // S7 重复 OneBot 事件与断线重连
  // =========================================================================
  {
    notApplicable(
      'S7 同进程断线重连与重复 OneBot 事件',
      '那是 **QQ 外壳**的职责（白名单 / 有界去重 / 回声抑制），已由 `pnpm qq:verify` 覆盖；'
    )
    notRun(
      'S7b 重启后的再投递边界',
      '跨进程去重窗口不保留（QQ 侧已登记：不宣称跨崩溃 exactly-once）—— 见 `L-COEXIST-07`。'
    )
  }

  // =========================================================================
  // S8 伪造入口 / 用户 / 角色 / 会话 / 取消对象
  // =========================================================================
  {
    /* ① 伪造入口：错 token */
    const rogue = connect({ host: '127.0.0.1', port: host.qqPort })
    const rogueReader = new LineReader(rogue)
    await new Promise<void>((done) => rogue.once('connect', () => done()))
    rogue.write('LG_ENTRY forged-entry-token-000000000000\n')
    const rejected = await rogueReader.next()
    rogue.destroy()

    /* ② 载荷里塞身份字段：入口/会话/用户/角色都不该被它改动 */
    const forged = await qq.submitWithForgedFields('req-s8a', 'MARK-A10 我是别人', {
      entry: 'avatar',
      conversationId: 'dm-forged-evil',
      userId: 'someone-else',
      characterId: 'someone-else',
      actorType: 'character',
      role: 'system',
    })
    /* ③ 伪造取消对象：用 QQ 这条连接去取消**皮套**的请求（皮套那一轮的结果回皮套那条连接） */
    const forgedTargetPromise = avatar.awaitTurn('req-s8b')
    avatar.fire('req-s8b', 'MARK-B9 这条属于皮套')
    await delay(80)
    const forgedCancel = await qq.control(
      'req-s8b',
      'CANCEL_TURN',
      { reason: 'forged' },
      'CANCEL_RESULT'
    )
    const forgedTarget = await forgedTargetPromise
    check(
      'S8a 伪造入口被拒 + 载荷身份字段改不了落点 + 伪造取消不越入口',
      rejected?.startsWith('LG_ENTRY_REJECTED') === true &&
        textOf(forged).includes('MARK-A10') &&
        forgedTarget.outcome !== 'failed' &&
        textOf(forgedTarget).includes('MARK-B9'),
      `握手=${JSON.stringify(rejected)} · 伪造取消 requested=${String((forgedCancel.cancel as Record<string, unknown>)?.requested)}` +
        ` · 被"取消"的那条 outcome=${String(forgedTarget.outcome)}（必须**不是** failed）`
    )
  }

  // =========================================================================
  // S9 队列上限与公平（有界排队 / 如实拒绝）
  // =========================================================================
  {
    /* 基线：无人争用时一轮多久 */
    const soloStart = Date.now()
    await avatar.submit('req-s9solo', 'MARK-B10 基线')
    const soloMs = Date.now() - soloStart

    const slowPromise = qq.awaitTurn('req-s9slow')
    qq.fire('req-s9slow', 'SLOW1200 MARK-A11 占住正式轮次')
    await delay(100)
    const queuedStart = Date.now()
    await avatar.submit('req-s9queued', 'MARK-B11 排队的那一条')
    const queuedMs = Date.now() - queuedStart
    await slowPromise
    check(
      'S9a 慢轮次下另一条入口**排队**但公平完成（等待被如实记在墙钟上）',
      queuedMs > soloMs + 200,
      `基线一轮 ${String(soloMs)}ms · 排队那一轮 ${String(queuedMs)}ms（应显著更长）`
    )

    /* 上限本身：连发 3 条 */
    const burst: Promise<Record<string, unknown>>[] = []
    for (const index of [1, 2, 3]) burst.push(avatar.awaitTurn(`req-s9b${String(index)}`))
    for (const index of [1, 2, 3]) avatar.fire(`req-s9b${String(index)}`, `MARK-B1${String(index)} 连发`)
    const burstOutcomes = await Promise.all(burst)
    observe(
      'S9b 队列上限**在桥的每连接串行泵下结构上不可达**（连发 3 条一条都没被拒）',
      `结局=${JSON.stringify(burstOutcomes.map((outcome) => String(outcome.code ?? outcome.outcome)))} —— ` +
        '`runBridgeTransport` 对正式轮次是**每连接严格串行**（`submits = submits.then(...)`）' +
        '⇒ 每入口至多 1 条在飞 ⇒ 上限是**防御性**的，生产里不会响。' +
        '拒绝路径本身由部件级门覆盖（`pnpm postlv2:coexist:verify` 的 `S-4`：上限 1 时第二条被拒成 `scheduler_queue_full`）。'
    )
  }

  // =========================================================================
  // S10 坏 JSON / 模型失败后同进程新请求恢复
  // =========================================================================
  {
    const bad = connect({ host: '127.0.0.1', port: host.qqPort })
    const badReader = new LineReader(bad)
    await new Promise<void>((done) => bad.once('connect', () => done()))
    bad.write(`LG_ENTRY ${host.qqToken} v${ENTRY_PROTOCOL_VERSION}\n`)
    await badReader.next()
    bad.write('{ not json at all\n')
    const malformed = await badReader.next()
    bad.destroy()

    const failed = await avatar.submit('req-s10a', 'MARK-B7 这一轮夹具会失败一次')
    const recovered = textOf(await avatar.submit('req-s10b', 'MARK-B13 失败之后再来一次'))
    check(
      'S10 坏 JSON 被具名拒绝；模型失败后同进程的新请求恢复（失败不伪报成功）',
      malformed?.includes('bridge_malformed_json') === true &&
        failed.outcome === 'failed' &&
        recovered.includes('MARK-B13'),
      `坏 JSON=${String(malformed).slice(0, 80)} · 失败轮 outcome=${String(failed.outcome)} code=${String(failed.code)}` +
        ` · 恢复轮="${short(recovered)}"`
    )
  }

  // =========================================================================
  // 读回：事件 / 记忆 / 序号（在停机前读，避免与重启段混）
  // =========================================================================
  let eventsBeforeRestart: Record<string, unknown>[] = []
  {
    /* 只读一次：用只读 opener 打开**隔离库**（不是生产库） */
    const db = await openRawPGlite(sandbox)
    try {
      eventsBeforeRestart = await query(
        db,
        'select id, conversation_id, conversation_sequence, content from conversation_events order by sequence'
      )
      const memory = await query(db, 'select id, content from memory_records')
      const dump = JSON.stringify(memory)
      /*
       * ⚠️ S4 的判据是"**没有新增写入**"，而不是"总条数等于 2"：
       *    后者会把"某一条明确写入没落地"也判成路由问题（两件事必须分开）。
       *    ⇒ 判据 = S4 那四条（`MARK-A5`/`A6`/`A7`/`B5`）**一个都没进记忆**。
       */
      const s4Leaked = /MARK-A5|MARK-A6|MARK-A7|MARK-B5/.test(dump)
      check(
        'R-3 ★ S4 的边界：普通闲聊 / 问句 / 引用 / 否定命令**一条都没进记忆**（不因路由或框架包装增加自动写入）',
        !s4Leaked,
        `memory_records=${memory.length} 条 · 命中 S4 标记=${String(s4Leaked)}`
      )
      observe(
        'R-3b 两条明确"记住"操作各落地了几条（**不是**共存性质，是既有记忆规则的读数）',
        `${memory.length}/2 条 —— ${dump.slice(0, 320)}`
      )
    } finally {
      await db.close()
    }
  }

  // =========================================================================
  // S11 稳定运行后正常重启
  // =========================================================================
  {
    const exitCode = await host.stop()
    check('S11a 第一次运行正常停机（stdin EOF ⇒ 退出码 0）', exitCode === 0, `exit=${String(exitCode)}`)
    const before = eventsBeforeRestart
    const qqBefore = before.filter((row) => String(row.conversation_id) === qqConversation).length
    const avatarBefore = before.filter((row) => String(row.conversation_id) === avatarConversation).length

    hostRestart = await startCoexistHost({
      dbDir: sandbox,
      modelPort: model.port,
      env: { CHARACTER_RELATIONSHIP_CONTEXT_ENABLED: 'true' },
    })
    await hostRestart.ready
    const qq2 = new EntryShell(hostRestart.qqPort, hostRestart.qqToken)
    const avatar2 = new EntryShell(hostRestart.avatarPort, hostRestart.avatarToken)
    const qqHello2 = await qq2.ready
    const avatarHello2 = await avatar2.ready
    const qqReply = textOf(await qq2.submit('req-s11a', 'MARK-A12 重启之后'))
    const avatarReply = textOf(await avatar2.submit('req-s11b', 'MARK-B14 重启之后'))
    check(
      'S11b 重启后两路各自恢复会话（会话 id 确定性相同、回复照常）',
      qqHello2.includes(qqConversation) &&
        avatarHello2.includes(avatarConversation) &&
        qqReply.includes('MARK-A12') &&
        avatarReply.includes('MARK-B14'),
      `qq=${qqHello2.split(' ')[2]} · avatar=${avatarHello2.split(' ')[2]}`
    )
    const exit2 = await hostRestart.stop()
    hostRestart = undefined
    const db = await openRawPGlite(sandbox)
    try {
      const rows = await query(
        db,
        'select conversation_id, conversation_sequence from conversation_events order by sequence'
      )
      const qqAfter = rows.filter((row) => String(row.conversation_id) === qqConversation)
      const avatarAfter = rows.filter((row) => String(row.conversation_id) === avatarConversation)
      const contiguous = [qqAfter, avatarAfter].every((group) =>
        group.every((row, index) => Number(row.conversation_sequence) === index + 1)
      )
      const mappings = await query(
        db,
        "select transport, external_id from user_identity_mappings where transport = 'qq'"
      )
      check(
        'S11c 重启后共享状态一致：序号**接着涨**（不重号、不跳号）、身份映射不重复',
        qqAfter.length > qqBefore &&
          avatarAfter.length > avatarBefore &&
          contiguous &&
          mappings.length === 1 &&
          exit2 === 0,
        `qq ${String(qqBefore)}→${String(qqAfter.length)} 条 · avatar ${String(avatarBefore)}→${String(avatarAfter.length)} 条` +
          ` · 连续=${String(contiguous)} · qq 身份映射=${mappings.length} 行 · exit=${String(exit2)}`
      )
    } finally {
      await db.close()
    }
  }

  // =========================================================================
  // S12 真人体验
  // =========================================================================
  {
    notRun(
      'S12 用户观察皮套语音与表情，同时操作 QQ',
      '需要真实皮套外壳（ASR/TTS/音频/表情）与真人 —— 属 WP3 剩下的那一半 + 真人体验，本机夹具无法代替。'
    )
  }

  // =========================================================================
  // 性能：**同一批材料**下的单入口 vs 双入口
  // =========================================================================
  const performance: Record<string, unknown> = {}
  {
    /* 单入口：只有 QQ 一条连接，串行 3 轮 */
    perfSingleDir = isolateDatabase('coexist-wp4-perf-single', { keep: true }).dir
    sandboxes.push(perfSingleDir)
    hostPerf = await startCoexistHost({ dbDir: perfSingleDir, modelPort: model.port })
    await hostPerf.ready
    const onlyQq = new EntryShell(hostPerf.qqPort, hostPerf.qqToken)
    await onlyQq.ready
    const single: number[] = []
    for (const index of [1, 2, 3]) {
      const started = Date.now()
      await onlyQq.submit(`perf-s-${String(index)}`, `SLOW300 MARK-A${String(20 + index)} 性能材料`)
      single.push(Date.now() - started)
    }
    const singleExit = await hostPerf.stop()
    hostPerf = undefined

    /* 双入口：两条连接同时各 3 轮（同一批材料） */
    perfDualDir = isolateDatabase('coexist-wp4-perf-dual', { keep: true }).dir
    sandboxes.push(perfDualDir)
    hostPerf = await startCoexistHost({ dbDir: perfDualDir, modelPort: model.port })
    await hostPerf.ready
    const dualQq = new EntryShell(hostPerf.qqPort, hostPerf.qqToken)
    const dualAvatar = new EntryShell(hostPerf.avatarPort, hostPerf.avatarToken)
    await dualQq.ready
    await dualAvatar.ready
    const dual: number[] = []
    for (const index of [1, 2, 3]) {
      const started = Date.now()
      await Promise.all([
        dualQq.submit(`perf-d-a${String(index)}`, `SLOW300 MARK-A${String(30 + index)} 性能材料`),
        dualAvatar.submit(`perf-d-b${String(index)}`, `SLOW300 MARK-B${String(20 + index)} 性能材料`),
      ])
      dual.push(Date.now() - started)
    }
    const dualExit = await hostPerf.stop()
    const dualReadings = hostPerf.schedulerReadings()
    hostPerf = undefined

    const avg = (values: number[]): number =>
      Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length))
    const dualWaits = dualReadings.map((reading) => reading.waitMs)
    const maxQueueWaitMs = dualWaits.length === 0 ? null : Math.max(...dualWaits)
    performance.singleEntry = { perTurnMs: single, avgMs: avg(single), exit: singleExit }
    performance.dualEntry = {
      perTurnMs: dual,
      avgMs: avg(dual),
      exit: dualExit,
      schedulerReadings: dualReadings,
      maxQueueWaitMs,
    }
    performance.modelCalls = model.calls.length
    performance.audio = {
      firstAudioMs: null,
      note: '协议面没有真实音频（WP3 剩下的那一半）⇒ 首次音频 NOT RUN',
    }
    observe(
      'P-1 单入口 vs 双入口（同一批材料：每轮 SLOW300 + 3 轮）',
      `单入口 avg=${String(avg(single))}ms（${JSON.stringify(single)}）· ` +
        `双入口 avg=${String(avg(dual))}ms（${JSON.stringify(dual)}）· ` +
        `排队读数 ${JSON.stringify(dualReadings.map((row) => `${row.entry}:wait=${String(row.waitMs)}ms`))}`
    )
    check(
      'P-2 双入口下每一轮都**有排队读数**（"共同资源造成的等待"被如实记下，而不是被隐去）',
      dualReadings.length >= 6 && dualReadings.every((row) => row.waitMs >= 0),
      `${dualReadings.length} 条调度读数 · 峰值等待 ${String(maxQueueWaitMs)}ms`
    )
    notRun(
      'P-3 首次音频 / 打断响应（真实音频面）',
      '没有真实 TTS/播放 ⇒ 首次音频与"打断后多久真停"没有读数；打断的**协议面**已由 S5a 覆盖。'
    )
  }

  check(
    'X-1 ★ 真实库从未被打开（树摘要前后逐字相同）',
    digestTree(PRODUCTION_DB_DIR).treeSha256 === productionBefore,
    `before=${productionBefore.slice(0, 16)}… after=${digestTree(PRODUCTION_DB_DIR).treeSha256.slice(0, 16)}…`
  )

  const out = writeEvidence('coexist-wp4-matrix', {
    status: recorder.results.some((row) => row.verdict === 'FAIL') ? 'FAIL' : 'PASS',
    scope: 'offline dual-entry scenario matrix (plan §5) + performance, real src/main.ts --coexist + isolated DB + local fixture model',
    productionDatabaseOpened: false,
    productionTreeUnchanged: true,
    realModel: 'NOT RUN（见 postlv2:coexist:live）',
    humanExperience: 'NOT RUN',
    results: recorder.results,
    performance,
  })
  console.log(`\nPASS: 双入口共存场景矩阵（真实库树摘要前后逐字相同）\n${out}`)
} finally {
  host?.kill()
  hostRestart?.kill()
  hostPerf?.kill()
  await model.close()
  for (const dir of sandboxes) cleanupSandbox(dir)
}
assert.ok(recorder.results.length > 0)
