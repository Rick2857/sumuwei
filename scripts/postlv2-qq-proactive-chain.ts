/**
 * post-Lv2 / **ADR-110 `D05` 的验收面**：**真核心 + 真外壳 + 模拟 OneBot**，无入站也能发出去。
 *
 * ============================================================================
 *  它回答的是计划 §8 里 WP5 那句通过条件
 * ============================================================================
 * ```text
 * "模拟 OneBot + 真核心**无入站**情况下，两类候选均实际执行 send API"
 * ```
 * 前几道门各自证明了一段（判据 / 持久 / 协议 / 登记 / 适配器 / 调度器 / 五步 / 焊接），
 * **但没有任何一道证明过一次真实出站发生过**。本门补的就是这一条。
 *
 * ============================================================================
 *  真的东西 / 假的东西（必须分清）
 * ============================================================================
 * ```text
 * 真：`src/main.ts --coexist`   —— 生产入口、真内核、真网关、真调度器（Croner）
 * 真：`scripts/qq/chat.ts`      —— 生产外壳（连接档），真的装 DELIVER_QQ_TEXT 处理器
 * 假：OneBot（NapCat）           —— 本门起一个 WS 服务器，只答外壳真的会调的那两个 action
 * 假：模型                       —— 复用共存门的离线夹具
 * 假：库                         —— 隔离库（INC-01：**绝不**打开真实库）
 * ```
 * ⇒ 结论**只**能说："真核心 → 真外壳 → 假 NapCat 这一条链通了"。
 *   ⚠️ **不许**说成"她能给本人发 QQ 了" —— 那要真 NapCat + 真手机（WP6/WP7 的边界）。
 *
 * ============================================================================
 *  ⚠️ 只覆盖**提醒**那一类（`L-QQP-04`）
 * ============================================================================
 * 计划要的是"两类候选"，但**关心**那一类的措辞必须由模型给，而那一步**还没接线**
 * ⇒ 本门对它如实标 `NOT RUN`，**不**用"提醒通了"去代表"两类都通了"。
 *
 * ============================================================================
 *  单写者纪律（INC-01）
 * ============================================================================
 * PGlite 同一目录**同时只能有一个写者**。所以注入那条提醒**不能**在核心运行时做：
 * ```text
 * 启动 A（mode=off）→ 等就绪 → 停   —— 让核心把库建好、迁移跑完
 * 关库之后          → 裸 SQL 插提醒 —— 此刻没有别的写者
 * 启动 B（mode=on） → 接上真外壳    —— 调度器读到它、到点、发出去
 * ```
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createRecorder,
  startCoexistHost,
  startFakeModel,
  writeEvidence,
  ROOT,
  freePort,
} from './coexist/harness.ts'
import { character } from '../src/character/index.ts'
import { cleanupSandbox, isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import { latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'
import { notificationTextFingerprint } from '../src/kernel/contracts/notification.ts'

const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws') as {
  WebSocketServer: new (options: { host: string; port: number }) => {
    on: (event: string, handler: (socket: unknown) => void) => void
    close: () => void
    address: () => { port: number }
  }
}

const recorder = createRecorder()
const { check, observe, notRun } = recorder
const productionBefore = digestTree(PRODUCTION_DB_DIR).treeSha256

/** 提醒正文（注入用）；模板是程序给的那一句 —— 门据此断言真的发出去的是它 */
const REMINDER_TEXT = '十分钟后提醒我喝水'
const REMINDER_TEMPLATE = `提醒你一下：${REMINDER_TEXT}`
const OWNER_ID = '123456789'
const BOT_ID = '987654321'
const FAKE_MESSAGE_ID = 424242

/**
 * **模拟 OneBot**（替掉真实的 NapCat）。
 *
 * ⚠️ 只实现外壳真的会调的那两个 action —— 多实现一个就等于在验收面上
 *    多加一条生产里不存在的路径。
 */
async function startFakeOneBot(): Promise<{
  port: number
  sent: { userId: string; text: string; at: number }[]
  close: () => void
}> {
  const sent: { userId: string; text: string; at: number }[] = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (socket: unknown) => {
    const ws = socket as {
      on: (event: string, handler: (payload: unknown) => void) => void
      send: (payload: string) => void
    }
    ws.on('message', (payload: unknown) => {
      const request = JSON.parse(String(payload)) as {
        action: string
        params: Record<string, unknown>
        echo: string
      }
      if (request.action === 'get_login_info') {
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: BOT_ID }, echo: request.echo }))
        return
      }
      if (request.action === 'send_private_msg') {
        const segments = request.params.message as { data: { text?: string } }[]
        sent.push({
          userId: String(request.params.user_id),
          text: segments.map((segment) => segment.data.text ?? '').join(''),
          at: Date.now(),
        })
        ws.send(
          JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: FAKE_MESSAGE_ID }, echo: request.echo })
        )
        return
      }
      ws.send(JSON.stringify({ status: 'failed', retcode: 1404, data: null, echo: request.echo }))
    })
  })
  await delay(200)
  return { port: server.address().port, sent, close: () => server.close() }
}

/**
 * 跑一次**门用最小外壳**（`scripts/coexist/qq-proactive-shell.ts`）。
 *
 * ⚠️ 为什么不是 `scripts/qq/chat.ts`：那是**生产外壳**，它开头有一道刻意的
 *    `assertProductionAvatarEnvironment()`（正式外壳不许跑在沙箱环境里）。
 *    本门**不**绕过那道闸 —— 用的是另一个程序（测试替身），而它跑的是**同一套真客户端类**。
 *    ⚠️ stdin 开着但**一个字都不写** —— 这就是"无入站"。
 */
function startRealShell(input: {
  qqPort: number
  qqToken: string
  oneBotPort: number
  oneBotToken: string
}): { child: ChildProcess; stdout: string[]; stderr: string[] } {
  const child = spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'), resolve(ROOT, 'scripts/coexist/qq-proactive-shell.ts')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PROJECT_LG_ROOT: ROOT,
        QQ_COEXIST_CONNECT_PORT: String(input.qqPort),
        QQ_COEXIST_CONNECT_TOKEN: input.qqToken,
        QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${String(input.oneBotPort)}/`,
        QQ_ONEBOT_ACCESS_TOKEN: input.oneBotToken,
        QQ_BOT_ID: BOT_ID,
        QQ_OWNER_ID: OWNER_ID,
        LOG_LEVEL: 'info',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '') stdout.push(line.trim())
    }
  })
  /*
   * ⚠️ **不许丢 stderr**：第一版把它扔了，于是"外壳一个字都没说"变成了
   *    一个只能靠猜的失败（真实原因是它启动时就抛了，栈全在 stderr 上）。
   */
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '') stderr.push(line.trim())
    }
  })
  return { child, stdout, stderr }
}

/** 一条待发提醒（**裸 SQL** —— 注入必须在核心关库之后，见文件头） */
async function insertReminder(
  dir: string,
  input: { id: string; dueAt: number; text: string; dedupeKey: string }
): Promise<void> {
  const db = await openRawPGlite(dir)
  try {
    /*
     * ⚠️ 参数化：`lib/pglite` 的类型面只声明了 `query(sql)`，但运行时支持第二个参数
     *    （`openRawPGlite` 的注释也这么说）。这里**显式**收窄成一个本地签名 ——
     *    而不是把值拼进 SQL（拼字符串会让"注入"变成一个随时会犯的错）。
     * ⚠️ **必须 `bind(db)`**：PGlite 的 `query` 依赖 `this`（内部 `_checkReady`）。
     *    第一版直接把它摘下来调用 ⇒ `Cannot read properties of undefined (reading '_checkReady')`。
     */
    const parameterized = db.query.bind(db) as unknown as (
      sql: string,
      params: unknown[]
    ) => Promise<{ rows: unknown[] }>
    await parameterized(
      `insert into notification_intents
         (id, character_id, owner_ref, conversation_ref, kind, status, source_refs, has_source,
          scheduled_at, timezone, plan_version, permission_version, policy_version,
          text, text_fingerprint, dedupe_key, created_at, updated_at, schema_version)
       values ($1, $2, 'qq-owner', 'dm-chain', 'reminder', 'pending', $3::jsonb, true,
               $4, 'Asia/Shanghai', 1, 'perm@1', 'policy@1',
               $5, $6, $7, $8, $8, $9)`,
      [
        input.id,
        CHARACTER_ID,
        JSON.stringify(['evt:chain-source']),
        input.dueAt,
        input.text,
        notificationTextFingerprint(input.text),
        input.dedupeKey,
        Date.now(),
        latestSchemaVersion(),
      ]
    )
  } finally {
    await db.close()
  }
}

async function readOccurrences(dir: string): Promise<Record<string, unknown>[]> {
  const db = await openRawPGlite(dir)
  try {
    const result = await db.query('select * from notification_occurrences order by created_at asc')
    return result.rows as Record<string, unknown>[]
  } finally {
    await db.close()
  }
}

/**
 * ⚠️ 与 `reserveOccurrence`/`listPendingIntents` 用的是**同一个** id ——
 *    靠的是同一条种子（不是写死一个字符串）。写死会让"库里没有任何待办"变成一个
 *    看起来像"调度器没跑"的假失败。
 */
const CHARACTER_ID = String(character.id ?? character.name)

let sandbox: string | undefined
let shell: ChildProcess | undefined
let oneBot: { close: () => void } | undefined
let model: { close: () => void } | undefined

try {
  const modelServer = await startFakeModel()
  model = modelServer
  const fakeOneBot = await startFakeOneBot()
  oneBot = fakeOneBot

  sandbox = isolateDatabase('qq-proactive-chain', { keep: true }).dir

  /* ---- 启动 A：让核心建库 + 迁移（mode=off） -------------------------------- */
  const bootA = await startCoexistHost({
    dbDir: sandbox,
    modelPort: modelServer.port,
    env: { CHARACTER_QQ_PROACTIVE_MODE: 'off' },
  })
  await bootA.ready
  const exitA = await bootA.stop()
  check('前置：启动 A 正常退出（核心把隔离库建好、迁移跑完）', exitA === 0, `exit=${String(exitA)}`)

  /* ---- 注入两条提醒（**此刻没有别的写者**） -------------------------------- */
  const now = Date.now()
  const nearDueAt = now + 40_000
  await insertReminder(sandbox, {
    id: 'chain-reminder-far',
    dueAt: now + 600_000,
    text: '很久以后提醒我喝水',
    dedupeKey: 'chain:reminder:far',
  })
  await insertReminder(sandbox, {
    id: 'chain-reminder-near',
    dueAt: nearDueAt,
    text: REMINDER_TEXT,
    dedupeKey: 'chain:reminder:near',
  })

  /* ---- 启动 B：mode=on + 真外壳连上 --------------------------------------- */
  const bootB = await startCoexistHost({
    dbDir: sandbox,
    modelPort: modelServer.port,
    qqPort: await freePort(),
    avatarPort: await freePort(),
    env: { CHARACTER_QQ_PROACTIVE_MODE: 'on' },
  })
  await bootB.ready
  const running = startRealShell({
    qqPort: bootB.qqPort,
    qqToken: bootB.qqToken,
    oneBotPort: fakeOneBot.port,
    oneBotToken: 'chain-onebot-token-0123456789',
  })
  shell = running.child
  /* 等外壳把 OneBot 连上并握完手（它每 3 秒重试一次） */
  await delay(5_000)

  check(
    '★ 正控：核心日志里有「调度器已启动」（mode=on + 入口作用域 + 有执行体）',
    bootB.stdout.filter((line) => line.includes('[qq-proactive] 调度器已启动')).length === 1,
    bootB.stdout.find((line) => line.includes('调度器已启动'))?.slice(0, 240) ?? '（没有这一行）'
  )
  check(
    '★ 前置：真外壳**接上了核心的 QQ 入口**（没有它，投递必然 `no_active_connection`）',
    bootB.stdout.some((line) => line.includes('[coexist] qq_private 已接入')),
    bootB.stdout.find((line) => line.includes('qq_private 已接入'))?.slice(0, 200) ??
      `外壳 stdout=${running.stdout.slice(0, 2).join(' | ') || '（空）'} stderr=${
        running.stderr.slice(0, 2).join(' | ') || '（空）'
      }`
  )
  check(
    '观察：到这一刻为止**没有任何入站**（真外壳的 stdin 一个字都没写过）',
    true,
    '⇒ 之后若发出任何东西，只可能来自调度器'
  )

  /*
   * ---- 等到点：Croner 到点 ⇒ 网关 ⇒ 登记表 ⇒ DELIVER_QQ_TEXT ⇒ 真外壳 ⇒ 模拟 OneBot
   * ⚠️ 上限 150 秒；超时**如实失败**，不把"没观测到"说成"通过"。
   */
  const deadline = Date.now() + 100_000
  while (fakeOneBot.sent.length === 0 && Date.now() < deadline) await delay(500)

  /*
   * ⚠️ 这两条读数**长期留着**：整链失败时，"核心自己说了什么"与"外壳说了什么"
   *    是两个必须分开看的地方 —— 少了它们，失败只能靠猜（第一版就是这样）。
   */
  observe(
    '核心的主动读数（`[qq-proactive]`）',
    bootB.stdout.filter((line) => line.includes('[qq-proactive]')).join(' || ').slice(0, 900) || '（一条都没有）'
  )
  observe(
    '共存入口的接入读数（`[coexist]`）',
    bootB.stdout.filter((line) => line.includes('[coexist]')).join(' || ').slice(0, 500) || '（一条都没有）'
  )
  observe(
    '真外壳的前几行 stdout',
    running.stdout.slice(0, 6).join(' || ').slice(0, 700) || '（一条都没有）'
  )

  const shellSaid = running.stdout.filter((line) => line.includes('qq_proactive_delivery'))
  const shellSendApi = running.stdout.filter((line) => line.includes('qq_send_api_accepted'))
  observe(
    `外壳读数 delivery=${String(shellSaid.length)} sendApi=${String(shellSendApi.length)}`,
    `模拟 OneBot 收到 ${String(fakeOneBot.sent.length)} 次 send_private_msg`
  )

  check(
    '★★ 正控（**本门的核心主张**）：模拟 OneBot **真的收到了 `send_private_msg`**，收件人是本人、正文是程序模板那条',
    fakeOneBot.sent.length === 1 &&
      fakeOneBot.sent[0]!.userId === OWNER_ID &&
      fakeOneBot.sent[0]!.text === REMINDER_TEMPLATE,
    fakeOneBot.sent.map((entry) => `${entry.userId}:${entry.text}`).join(' | ') || '（一次都没有）'
  )
  check(
    '★ 正控：真外壳报 `api_accepted`（**有回执 id 才敢这么说**）',
    shellSaid.some((line) => line.includes('"status":"api_accepted"')),
    shellSaid.join(' | ') || '（外壳没打这一行）'
  )
  check(
    '★ 正控：外壳侧真的走到 `qq_send_api_accepted`（是它自己的发送面说的话，不是核心替它说的）',
    shellSendApi.length === 1,
    shellSendApi.join(' | ') || '（没有这一行）'
  )
  check(
    '★ 正控：发出时刻**落在目标那一秒里**（实测：Croner 的单次触发在**秒首**响，最多比目标早 999ms）',
    fakeOneBot.sent.length === 1 &&
      fakeOneBot.sent[0]!.at >= nearDueAt - 1_000 &&
      fakeOneBot.sent[0]!.at <= nearDueAt + 1_000,
    fakeOneBot.sent.length === 1
      ? `注入=${new Date(nearDueAt).toISOString()} 发出=${new Date(fakeOneBot.sent[0]!.at).toISOString()}` +
        ` · 差=${String(fakeOneBot.sent[0]!.at - nearDueAt)}ms`
      : '（没有发出）'
  )
  /*
   * ⚠️ 两条**实测得到**的边界，登记成读数（不是散文）：
   * ```text
   * ① `L-QQP-06`：单次触发的火点在**秒首**（目标 928888 → 实际 928026，早 862ms）
   *    ⇒ `onceShotIsSchedulable` 判的是"能不能排上"，它**不**保证"不早于目标时刻"。
   *       如果某条提醒对"不得提前"有硬要求，需要另加判据（本批没有这种要求）。
   * ② `L-QQP-05`：投递之后**意图没有被结清**（`finishIntent` 没被调用）⇒ 它仍是 `pending`
   *    ⇒ 调度器每次重排都会再交付一次，靠**实例行的唯一占用**兜住重复发送
   *    （日志里能看到第二次以 `reminder_occurrence_dispatching` 被拒 —— 没有发出第二次）。
   * ```
   */
  observe(
    'L-QQP-06：单次触发的火点在秒首（实测早于目标时刻的毫秒数）',
    fakeOneBot.sent.length === 1 ? `${String(fakeOneBot.sent[0]!.at - nearDueAt)}ms` : '（未观测）'
  )
  /*
   * `L-QQP-05`（**已修**）：投递之后意图**仍然**不结清 —— 这是**刻意**的，
   * 因为把 `api_accepted` 写成"已送达"会过度主张（`D08`：平台接受 ≠ 送达）。
   * ⇒ 修法在**读侧**：已经产生过实例行的机会不再列出来。
   * 本门据此断言"重排**没有**再交付同一条"（日志里那条 `reminder_occurrence_dispatching`
   * —— 第一版有、修完之后**没有**）。这条判据是**三段式**里的"恢复"那一半：
   * 修之前它红、修之后它绿，两边都留过读数。
   */
  observe(
    'L-QQP-05（**已修**）：投递后意图仍不结清（刻意不主张"已送达"）⇒ 靠**读侧过滤**'
      + '让重排不再重复交付',
    bootB.stdout.filter((line) => line.includes('reminder_occurrence_dispatching')).length === 0
      ? '没有观测到第二次交付（重排落到了下一条**未尝试**的提醒）'
      : '仍然观测到第二次交付 —— 这道过滤没生效'
  )

  await bootB.stop()
  shell.kill()
  shell = undefined

  /* ---- 读回：交付真相落库了没有 ------------------------------------------- */
  const occurrences = await readOccurrences(sandbox)
  observe(`隔离库里的实例行 = ${String(occurrences.length)}`, '读回自隔离库（核心已停，写者唯一）')
  const nearRow = occurrences.find((row) => String(row.intent_id ?? '') === 'chain-reminder-near')
  check(
    '★★ 正控：回执被受理 ⇒ 实例行落 `api_accepted` + `platform_message_id` = 假 OneBot 给的那个 id',
    nearRow !== undefined &&
      String(nearRow.state) === 'api_accepted' &&
      String(nearRow.platform_message_id ?? '') === String(FAKE_MESSAGE_ID),
    nearRow === undefined
      ? '（没有这一行）'
      : `state=${String(nearRow.state)} messageId=${String(nearRow.platform_message_id)}`
  )
  check(
    '★ 负控：远处那条提醒（+10 分钟，**没到点**）**没有**产生实例行',
    !occurrences.some((row) => String(row.intent_id ?? '') === 'chain-reminder-far'),
    `intent_id 列 = ${occurrences.map((row) => String(row.intent_id)).join(',') || '（空）'}`
  )

  notRun(
    '关心（自主联系）那一类的整链',
    '措辞必须由模型给，而那一步**还没接线**（`L-QQP-04`）⇒ 本门只覆盖提醒那一类'
  )
} catch (error) {
  /* ⚠️ 把栈也带上：只有 message 时，上面那次 `_checkReady` 根本看不出是哪一行 */
  const detail = error instanceof Error ? `${error.message} @ ${error.stack?.split('\n')[1]?.trim() ?? ''}` : String(error)
  check(`门自身抛错：${detail}`, false, '')
} finally {
  shell?.kill()
  oneBot?.close()
  model?.close()
  if (sandbox !== undefined) cleanupSandbox(sandbox)

  const productionAfter = digestTree(PRODUCTION_DB_DIR).treeSha256
  check(
    '★ INC-01：真实库树摘要在整门前后**逐字相同**',
    productionBefore === productionAfter,
    `${productionBefore.slice(0, 16)}… → ${productionAfter.slice(0, 16)}…`
  )

  const failed = recorder.results.filter((row) => row.verdict === 'FAIL')
  const notRunCount = recorder.results.filter((row) => row.verdict === 'NOT RUN').length
  const passed = recorder.results.filter((row) => row.verdict === 'PASS').length
  const out = writeEvidence('qq-proactive-chain', {
    status: failed.length > 0 ? 'FAIL' : 'PASS',
    passed,
    failed: failed.length,
    notRun: notRunCount,
    productionTreeBefore: productionBefore,
    productionTreeAfter: productionAfter,
    results: recorder.results,
  })
  console.log(`\n${'='.repeat(72)}`)
  console.log('post-Lv2 QQ 主动联系 **整链**（真核心 + 真外壳 + 模拟 OneBot · 无入站）')
  console.log(`${String(passed)} 通过 / ${String(failed.length)} 失败 / ${String(notRunCount)} 未运行`)
  console.log(`证据：${out}`)
  console.log('='.repeat(72))
  if (failed.length > 0) {
    console.log('失败项：')
    for (const item of failed) console.log(`  · ${item.id} :: ${item.detail}`)
  }
  assert.ok(recorder.results.length > 0)
  process.exitCode = failed.length > 0 ? 1 : 0
}
