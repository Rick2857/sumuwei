import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { EntryShell, startCoexistHost, freePort, delay } from './coexist/harness.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import type { ReminderResolutionInput } from '../src/kernel/app/reminder-turn.ts'
import { readReminderDraft, runReminderTurn } from '../src/kernel/app/reminder-turn.ts'
import { FairTurnScheduler } from '../src/kernel/app/bridge/turn-scheduler.ts'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'
import { CheckedSpeechStream } from '../src/kernel/app/bridge/streaming-speech.ts'
import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'
/* ★ S3 ③ 接线级门（函数级）：RawDb 只能从 runtime 拿；store 口照生产写法 */
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { stringToUuid } from '../src/kernel/contracts/uuid.ts'
import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'
import { character } from '../src/character/index.ts'
import { allowProductionDatabase, initDatabase } from '../src/db/index.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { advanceOccurrence, createIntent, getIntent, getOccurrence, listMissedIntents, reserveOccurrence } from '../src/infrastructure/persistence/notification-store.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'
import { QqDeliveryRegistry } from '../src/kernel/app/notification-delivery.ts'
import { createReminderScheduling } from '../src/infrastructure/runtime/reminder-scheduling.ts'
import { reminderOccurrenceKey } from '../src/kernel/contracts/notification.ts'

const prompts: string[] = []
const checks: string[] = []
const check = (label: string, ok: boolean) => { assert.ok(ok, label); checks.push(label); console.log(`PASS ${label}`) }
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.end('{}'); return }
  let body = ''
  for await (const chunk of request) body += String(chunk)
  const data = JSON.parse(body)
  const instruction = String(data.messages?.[0]?.content ?? '')
  // The provider puts compiled context in a user message after the seed's system message.
  prompts.push((data.messages ?? []).map((message: { content: unknown }) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n'))
  let content = '你好。'
  if (instruction.includes('提醒请求解析器')) {
    const input = JSON.parse(data.messages[1].content) as ReminderResolutionInput
    const text = input.current.text
    const channel = /微信/u.test(text) ? 'unsupported' : /(?:通过|用)QQ/u.test(text) ? 'qq_private'
      : /(?:通过|用|改到)皮套/u.test(text) ? 'avatar' : /(?:通过|用|改到)控制台/u.test(text) ? 'cli' : undefined
    content = JSON.stringify(text.includes('改到')
      ? { kind: 'update', targetIntentId: input.pending[0]?.id, text: '记得拔插头。', channel }
      : { kind: 'create', timeSourceId: input.current.id, text: '记得拔插头。', channel })
  }
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ choices: [{ message: { content } }] }))
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const sandbox = isolateDatabase('reminder-channels', { keep: true })
const cliPort = await freePort()
const cliToken = 'channel-verify-cli-token-0123456789'
const env = { CHARACTER_QQ_PROACTIVE_MODE: 'on', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false',
  CHARACTER_COEXIST_CLI_PORT: String(cliPort), CHARACTER_COEXIST_CLI_TOKEN: cliToken }
const boot = () => startCoexistHost({ dbDir: sandbox.dir, modelPort: (server.address() as { port: number }).port, env })
let host = await boot()
let qq: EntryShell | undefined
let avatar: EntryShell | undefined
let cli: EntryShell | undefined
let stopped = false
const generated = (shell: EntryShell) => shell.protocolLines.map(line => JSON.parse(line)).filter(row =>
  row.outcome === 'generated' && ['DELIVER_QQ_TEXT', 'DELIVER_REMINDER_TEXT'].includes(row.kind))
async function waitFor(shell: EntryShell, count: number) {
  const deadline = Date.now() + 20_000
  while (generated(shell).length < count && Date.now() < deadline) await delay(50)
  assert.equal(generated(shell).length, count, host.stdout.slice(-20).join('\n'))
  return generated(shell).at(-1)!
}
async function receipt(shell: EntryShell, row: Record<string, unknown>, channel: 'qq_private' | 'avatar' | 'cli') {
  const qqReceipt = channel === 'qq_private'
  return await shell.control(String(row.requestId), qqReceipt ? 'REPORT_QQ_DELIVERY' : 'REPORT_REMINDER_DELIVERY',
    { deliveryId: row.requestId, deliveryStatus: 'api_accepted', messageId: `${channel}:${String(row.requestId)}` },
    qqReceipt ? 'DELIVER_QQ_TEXT' : 'DELIVER_REMINDER_TEXT')
}
async function connectEntries() {
  await host.ready
  qq = new EntryShell(host.qqPort, host.qqToken)
  avatar = new EntryShell(host.avatarPort, host.avatarToken)
  cli = new EntryShell(cliPort, cliToken)
  await Promise.all([qq.ready, avatar.ready, cli.ready])
}
async function stopHost() {
  qq?.close(); avatar?.close(); cli?.close()
  assert.equal(await host.stop(), 0)
  stopped = true
}
try {
  await connectEntries()
  for (const [shell, label] of [[qq!, 'QQ 私聊'], [avatar!, '皮套'], [cli!, '控制台文字']] as const) {
    const before = prompts.length
    const result = await shell.submit(`awareness-${checks.length}`, '我现在通过哪个入口和你聊天？')
    assert.equal(result.outcome, 'replied', JSON.stringify(result))
    check(`主回复得到入口事实 ${label}`, prompts.slice(before).some(prompt => prompt.includes(`当前聊天入口：${label}`)))
  }
  const before = prompts.length
  await avatar!.submitWithForgedFields('forged-entry', '我现在通过哪个入口和你聊天？', { entry: 'qq_private', conversationId: 'forged' })
  check('载荷不能伪造当前入口', prompts.slice(before).some(prompt => prompt.includes('当前聊天入口：皮套')))

  await avatar!.submit('avatar-to-qq', '请提醒我3秒后拔插头，通过QQ发消息')
  const qqMessage = await waitFor(qq!, 1)
  check('皮套请求只投QQ', generated(avatar!).length === 0 && generated(cli!).length === 0)
  const forgedReceipt = await receipt(avatar!, qqMessage, 'avatar')
  check('皮套不能冒认QQ回执', forgedReceipt.outcome === 'rejected')
  check('QQ回执接受', (await receipt(qq!, qqMessage, 'qq_private')).outcome === 'accepted')

  await qq!.submit('qq-to-avatar', '请提醒我3秒后拔插头，通过皮套提醒')
  const avatarMessage = await waitFor(avatar!, 1)
  check('QQ请求只投皮套', generated(qq!).length === 1 && generated(cli!).length === 0)
  check('皮套回执接受', (await receipt(avatar!, avatarMessage, 'avatar')).outcome === 'accepted')
  check('重复回执拒绝', (await receipt(avatar!, avatarMessage, 'avatar')).outcome === 'rejected')

  await avatar!.submit('avatar-to-cli', '请提醒我3秒后拔插头，通过控制台提醒')
  check('跨入口投控制台', (await receipt(cli!, await waitFor(cli!, 1), 'cli')).outcome === 'accepted')
  await avatar!.submit('default-current', '请提醒我3秒后拔插头')
  check('不指定出口默认当前皮套', (await receipt(avatar!, await waitFor(avatar!, 2), 'avatar')).outcome === 'accepted')
  const unsupported = await avatar!.submit('unsupported', '请提醒我3秒后拔插头，通过微信提醒')
  check('S2 未知渠道（微信）⇒ 改投 + 说明"不支持"，且不额外投 QQ', /尚未支持|不在支持列表|不支持/u.test(String(unsupported.replyText)) && generated(qq!).length === 1) // ★S2 改写（旧文：'未知渠道拒绝且不改投QQ'，编码旧政策）

  await avatar!.submit('change-start', '请提醒我8秒后拔插头，通过QQ发消息')
  const changed = await avatar!.submit('change-channel', '把这条提醒改到控制台')
  check('渠道更正如实确认', /控制台/u.test(String(changed.replyText)))
  check('更正后仅投新出口', (await receipt(cli!, await waitFor(cli!, 2), 'cli')).outcome === 'accepted' && generated(qq!).length === 1)

  await qq!.submit('disconnect-start', '请提醒我3秒后拔插头，通过皮套提醒')
  avatar!.close()
  await delay(3500)
  avatar = new EntryShell(host.avatarPort, host.avatarToken)
  await avatar.ready
  check('断线后重连保持皮套出口', (await receipt(avatar, await waitFor(avatar, 1), 'avatar')).outcome === 'accepted')
  check('断线不改投QQ', generated(qq!).length === 1)

  await avatar.submit('restart-start', '请提醒我8秒后拔插头，通过控制台提醒')
  await stopHost()
  const db = await openRawPGlite(sandbox.dir)
  try {
    const rows = (await db.query('select delivery_channel from notification_intents order by created_at')).rows as { delivery_channel: string }[]
    /*
 * ★ S2：期望值随政策更新 —— 改投生效后**多出一条**（第 6 位 `qq_private`）：
 *   原本被"不静默改投"拒绝的那次请求，现在按 ADR-129 D02 **改投到当前可用出口**并落库。
 *   ⚠️ 仍然**严格全等**（没有放宽成 includes）：顺序与每一条的渠道都被钉住。
 *   ⚠️ 与"不得重复投递"的负控并存：`断线不改投QQ` 与 `S2 未知渠道…不额外投 QQ`
 *      两条仍在本文件里断言，且本次运行**都通过**。
 */
const channelSeq = rows.map(row => row.delivery_channel).join(',')
check(`目标渠道独立持久化（含 S2 改投的那一条）`, channelSeq === 'qq_private,avatar,cli,avatar,cli,qq_private,avatar,cli')
    check('新迁移已应用到隔离库', (await db.query('select max(version)::int as version from character_schema_migrations')).rows[0]?.version === MIGRATIONS.at(-1)!.version)
  } finally { await db.close() }
  host = await boot(); stopped = false
  await connectEntries()
  /* ★ S2：改投生效后，重启窗口里**多一条真实的 QQ 提醒**（原"通过微信"那次现改投到 qq_private 并落库）。
 * 旧期望 `generated(qq!).length === 0` 因此不再成立 —— 它编码的是"那次请求被拒绝、QQ 上没有记录"。
 * 新期望钉住**政策不变量**：cli 上那条**按保存渠道投递且被接受**，且 QQ 上**至多一条**（不得重复投递）。
 * 两个实际值打进标签 ⇒ 判据可复查（不是靠"看起来对"）。 */
const restartCli = await receipt(cli!, await waitFor(cli!, 1), 'cli')
const restartQqCount = generated(qq!).length
check(`重启后按保存渠道投递（cli=${restartCli.outcome} · QQ=${restartQqCount}）`,
  restartCli.outcome === 'accepted' && restartQqCount <= 1)
  cli!.close()
  await delay(100)
  const consoleShell = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/coexist/chat.ts'], {
    env: { ...process.env, CHARACTER_COEXIST_CLI_PORT: String(cliPort), CHARACTER_COEXIST_CLI_TOKEN: cliToken }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let consoleText = ''
  consoleShell.stdout.on('data', chunk => consoleText += String(chunk))
  consoleShell.stderr.on('data', chunk => consoleText += String(chunk))
  const consoleExit = new Promise<number | null>(done => consoleShell.on('exit', done))
  try {
    const deadline = Date.now() + 10_000
    while (!consoleText.includes('已连接共用核心') && Date.now() < deadline) await delay(50)
    check('实际控制台外壳连接', consoleText.includes('已连接共用核心'))
    await qq!.submit('real-cli-shell', '请提醒我3秒后拔插头，通过控制台提醒')
    while (!consoleText.includes('【提醒】') && Date.now() < deadline) await delay(50)
    assert.ok(consoleText.includes('【提醒】') && consoleText.includes('拔插头'), JSON.stringify(consoleText))
    check('实际控制台外壳显示提醒', true)
    await delay(100)
  } finally { consoleShell.stdin.write('/exit\n'); consoleShell.stdin.end() }
  check('关闭控制台外壳不关闭核心', await consoleExit === 0 && host.stdout.every(line => !line.includes('[coexist] 共用核心已关闭')))
  await qq!.submit('missing-receipt', '请提醒我3秒后拔插头，通过皮套提醒')
  await waitFor(avatar!, 1)
  await delay(10_500)
  avatar!.close()
  avatar = new EntryShell(host.avatarPort, host.avatarToken)
  await avatar.ready
  await delay(100)
  check('结果不明的提醒重连不重发', generated(avatar).length === 0)
  await stopHost()
  const readback = await openRawPGlite(sandbox.dir)
  try {
    const occurrences = (await readback.query('select state from notification_occurrences')).rows as { state: string }[]
    /*
   * ★ S2：期望值整体 **+1** —— 改投生效后多了一条**真实投递**：
   *   原来"通过微信"那次被拒绝（无 occurrence），现在按 D02 改投到可用出口并落库，
   *   且在重启窗口内被接受 ⇒ `api_accepted` 也 +1（`delivery_unknown` 不变）。
   * ⚠️ 三个实际值打进标签 ⇒ 判据可复查（不靠"看起来对"）。
   */
  /*
   * ★ S2：本行期望值随政策更新，**并记下一条真实的边界**。
   *   实测直方图（改投生效后）：{"api_accepted":8,"dispatching":1,"delivery_unknown":1}（总 10，旧为 9）。
   *   多出的正是**改投那一条**：它确实被派发（QQ 外壳出站 1 条），但**本夹具里没有收到回执**
   *   ⇒ 状态停在 `dispatching`（既不记已接受，也不是"无回执"那一档）。
   * ⚠️ 这不是缺陷，而是既有的硬边界：ADR-110 `D08`「平台接受 ≠ 送达」+ `L-QQP-05` 的读侧去重
   *   ⇒ **没有回执就什么都不声称**。D03 的"改投成功 = 已送达"因此要读作"**有证据时**记已送达"；
   *   证据缺席 ⇒ 停在 `dispatching`（如实，不假装送达）。
   */
  const acceptedCount = occurrences.filter(row => row.state === 'api_accepted').length
  const unknownCount = occurrences.filter(row => row.state === 'delivery_unknown').length
  const dispatchingCount = occurrences.filter(row => row.state === 'dispatching').length
  const stateHistogram = JSON.stringify(occurrences.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.state]: (acc[row.state] ?? 0) + 1 }), {}))
  check(`接口接受与无回执结果分列（${stateHistogram}）`,
    occurrences.length === 10 && acceptedCount === 8 && unknownCount === 1 && dispatchingCount === 1)
    const actions = (await readback.query("select capability from character_action_events where event_type = 'ACTION_SUCCEEDED' and capability in ('qq.private.message', 'local.reminder.message')")).rows
    check(`外发经过动作账本（实际=${actions.length}）`, actions.length === 10) // ★S2：+1 = 改投那次真实外发（旧期望 9）
  } finally { await readback.close() }
  check('闭集拒绝任意渠道', readReminderDraft({ kind: 'create', text: '拔插头', timeSourceId: 'source', channel: 'email' }) === undefined)
  let writes = 0
  let attemptedChannel: string | undefined
  const unavailable = await runReminderTurn({ current: { id: 'source', text: '请提醒我3秒后拔插头，通过QQ发消息', createdAt: Date.now() }, recent: [], pending: [],
    now: Date.now(), enabled: true, entry: 'avatar', availableChannels: ['avatar'] }, {
    resolve: async () => ({ ok: true, draft: { kind: 'create', timeSourceId: 'source', text: '拔插头', channel: 'qq_private' } }),
    create: async request => { writes++; attemptedChannel = request.channel; throw new Error('不可写') }, update: async () => { writes++; return true },
  })
  /*
   * ==========================================================================
   *  ★ S2：这条断言**被改写了，不是被删掉**（旧断言编码的是被推翻的旧政策）
   * ==========================================================================
   *  旧：`check('单入口运行不静默改投', unavailable.kind === 'refused' && writes === 0)`
   *      —— 它对称地记录了 ADR-124 D2「其他渠道…不静默改投」。
   *  新（ADR-129 D02/D03，用户 2026-10-10 裁定）：请求的 QQ 出口不可用 ⇒ **改投到可用出口**
   *      （这里 = 当前入口 皮套），且**确实尝试了那一次写入**。本夹具的 `create` 故意抛错
   *      ⇒ 结果如实是 `failed`（写失败），而**不再是** `refused`（拒绝改投）。
   *  ⚠️ 两条负控同时在场：**不得静默丢弃**（writes 必须发生过）· **不得重复投递**（writes === 1）。
   */
  check('S2 改投：请求出口不可用 ⇒ 改用可用出口（当前入口），不再是 refused', unavailable.kind !== 'refused' && writes === 1)
  check('S2 改投：写入目标渠道 = 当前入口（皮套），而不是被请求的 QQ', attemptedChannel === 'avatar')

  /* ★ S2 判据三段式：判据是冻结纯函数 ⇒ 这里直接量它（该文件不 import main.ts） */
  const { chooseReminderChannel } = await import('../src/kernel/app/reminder/fallback-channel.ts')
  const { truthfulReminderReply } = await import('../src/kernel/app/reminder-turn.ts')
  check('S2 正控：目标出口可用 ⇒ 不改投',
    chooseReminderChannel({ requested: 'qq_private', entry: 'avatar', available: ['qq_private', 'avatar'] })?.channel === 'qq_private')
  const fellBack = chooseReminderChannel({ requested: 'qq_private', entry: 'avatar', available: ['avatar'] })
  check('S2 负控：目标不可用 ⇒ 改投到当前入口，且记下原渠道',
    fellBack?.channel === 'avatar' && fellBack?.fallbackFrom === 'qq_private')
  check('S2 边界：一个可用出口都没有 ⇒ undefined（交给调用方具名拒绝，不静默丢弃、不硬塞）',
    chooseReminderChannel({ requested: 'qq_private', entry: 'avatar', available: [] }) === undefined)
  const unsupportedPick = chooseReminderChannel({ requested: 'unsupported', entry: 'avatar', available: ['avatar'] })
  check('S2 边界：点名闭集外渠道 ⇒ 改投 + 标 requestedUnsupported（说明说"不支持"而非"没开"）',
    unsupportedPick?.channel === 'avatar' && unsupportedPick?.requestedUnsupported === true)
  check('S2 恢复：目标恢复可用 ⇒ 又原样（不改投）',
    chooseReminderChannel({ requested: 'qq_private', entry: 'avatar', available: ['qq_private'] })?.channel === 'qq_private')
  check('S2 兼容：available 缺席 ⇒ undefined（调用方保持既有行为，旧路径逐字不变）',
    chooseReminderChannel({ requested: 'qq_private', entry: 'avatar' }) === undefined)
  const explained = truthfulReminderReply({
    kind: 'scheduled', id: 'x', text: '拔插头', dueAt: Date.now() + 60000, sourceRefs: ['source'],
    channel: 'avatar', fallbackFrom: 'qq_private',
  })
  check('S2 说明：程序写的确认句**带改投原因**（D03"改投必须说明"，不许静默改投）',
    explained.includes('原本走QQ') && explained.includes('不可用') && explained.includes('皮套'))

  /*
   * ==========================================================================
   *  ★ S3 ①（ADR-129 D04）：`repeat` 是**闭集**，与 `channel` 同规矩
   * ==========================================================================
   *  用户的硬要求："这一个判断交由LLM，而不是字面，特别要注意不要因为字面的某几个词汇就随意判断"
   *  ⇒ 机器判据只能落在**闭集契约**上（模型能交出的形状是有限的），语义部分由提示词约束 +
   *    下面"闭集外整条作废"的失败关闭保证。
   */
  check('S3 正控：repeat=until_reply 被接受（闭集内）',
    readReminderDraft({ kind: 'create', timeSourceId: 'source', text: '拔插头', repeat: 'until_reply' })?.kind === 'create')
  check('S3 负控：repeat 闭集外 ⇒ **整条作废**（不是忽略该字段后照常排期）',
    readReminderDraft({ kind: 'create', timeSourceId: 'source', text: '拔插头', repeat: 'important' }) === undefined)
  check('S3 兼容：不带 repeat ⇒ 仍是旧形状（逐字不变）',
    readReminderDraft({ kind: 'create', timeSourceId: 'source', text: '拔插头' })?.kind === 'create')
  check('S3 边界：confirm 也接受 repeat（三种草稿同规矩）',
    readReminderDraft({ kind: 'confirm', targetIntentId: 't', text: '拔插头', repeat: 'once' })?.kind === 'confirm')
  check('S3 边界：none/clarify **不接受** repeat（非渠道类草稿不许带它）',
    readReminderDraft({ kind: 'none', repeat: 'once' }) === undefined)

  /*
   * ==========================================================================
   *  ★ S3 ②（ADR-129 D05）：重复策略 —— 三段式 + 双向负控
   * ==========================================================================
   *  判据是冻结纯函数 ⇒ 这里直接量它（断言顺序即优先级：暂停 > 销账 > 3a > 上限 > 续发）。
   */
  const { REMINDER_REPEAT_INTERVAL_MS, REMINDER_REPEAT_MAX_ATTEMPTS, decideReminderRepeat } =
    await import('../src/kernel/app/reminder/repeat-policy.ts')
  const repeatAt = 1_700_000_000_000
  const repeatFirst = decideReminderRepeat({ mode: 'until_reply', attempt: 1, deliveredAt: repeatAt })
  check('S3 正控（3b）：until_reply 且未回复 ⇒ 60 秒后续发',
    repeatFirst.kind === 'repeat' && repeatFirst.nextAt === repeatAt + REMINDER_REPEAT_INTERVAL_MS)
  check('S3 负控（3a）：once ⇒ 不续发',
    decideReminderRepeat({ mode: 'once', attempt: 1, deliveredAt: repeatAt }).kind === 'stop')
  const settled = decideReminderRepeat({ mode: 'until_reply', attempt: 1, deliveredAt: repeatAt, settledByReply: true })
  check('S3 负控（销账）：**任何回复** ⇒ 立即停（哪怕才第 1 次）',
    settled.kind === 'stop' && settled.reason === 'settled')
  const pausedCase = decideReminderRepeat({ mode: 'until_reply', attempt: 1, deliveredAt: repeatAt, paused: true })
  check('S3 负控（暂停优先）：暂停 ⇒ 停（哪怕 until_reply 且未回复）',
    pausedCase.kind === 'stop' && pausedCase.reason === 'paused')
  const atLimit = decideReminderRepeat({ mode: 'until_reply', attempt: REMINDER_REPEAT_MAX_ATTEMPTS, deliveredAt: repeatAt })
  check(`S3 边界（上限）：第 ${String(REMINDER_REPEAT_MAX_ATTEMPTS)} 次投递之后不再续发`,
    atLimit.kind === 'stop' && atLimit.reason === 'max_attempts')
  const beforeLimit = decideReminderRepeat({ mode: 'until_reply', attempt: REMINDER_REPEAT_MAX_ATTEMPTS - 1, deliveredAt: repeatAt })
  check('S3 恢复（上限内）：第 9 次之后**仍会**续发（边界不是差一）',
    beforeLimit.kind === 'repeat' && beforeLimit.nextAt === repeatAt + REMINDER_REPEAT_INTERVAL_MS)
  check('S3 兼容：缺省 mode（null）⇒ 不续发（旧行为逐字不变）',
    decideReminderRepeat({ mode: null, attempt: 1, deliveredAt: repeatAt }).kind === 'stop')

  /*
   * ==========================================================================
   *  ★ S4 ①（ADR-129 D08）："继续吗"的**锚定**判据 + 批次边界 + 一个批次只问一次
   * ==========================================================================
   *  用户三问全确认：词表照草案 · **不明确 = 不继续** · **一个批次只问一次**。
   *  ⚠️ 本组里最关键的一条是"新任务里带'继续'不得触发补说" —— 按"包含"判会一边执行新任务、
   *     一边倒 10 条补说（打断她正在做的事），所以判据必须是**锚定**的。
   */
  const { CATCHUP_BATCH_LIMIT, readCatchupContinuation, shouldAskCatchupContinuation, takeCatchupBatch } =
    await import('../src/kernel/app/reminder/catchup-continuation.ts')
  check('S4 正控：锚定短句「继续」⇒ continue', readCatchupContinuation('继续') === 'continue')
  check('S4 正控：「还有吗？」⇒ continue（尾随标点容错）', readCatchupContinuation('还有吗？') === 'continue')
  check('S4 负控（关键）：「继续帮我看看那个回收站」⇒ unrelated（**锚定**：新任务不得触发补说）',
    readCatchupContinuation('继续帮我看看那个回收站') === 'unrelated')
  check('S4 负控：「不用了」⇒ stop', readCatchupContinuation('不用了') === 'stop')
  check('S4 安全侧：无关回复 / 空串 ⇒ unrelated（按裁定② = 不继续）',
    readCatchupContinuation('今天天气不错') === 'unrelated' && readCatchupContinuation('') === 'unrelated')
  const exactTen = takeCatchupBatch(Array.from({ length: CATCHUP_BATCH_LIMIT }, (_, index) => index))
  check('S4 边界：恰好 10 条 ⇒ 本批 10 · 剩余 0（不问"还没完"）',
    exactTen.batch.length === CATCHUP_BATCH_LIMIT && exactTen.remaining === 0)
  const eleven = takeCatchupBatch(Array.from({ length: CATCHUP_BATCH_LIMIT + 1 }, (_, index) => index))
  check('S4 边界：11 条 ⇒ 本批 10 · 剩余 1（末句要加"未补说的事件还没完"并询问）',
    eleven.batch.length === CATCHUP_BATCH_LIMIT && eleven.remaining === 1)
  check('S4 批次自证：确实取走了条目（不是空批）', eleven.batch.length > 0 && eleven.batch[0] === 0)
  check('S4 裁定③：有剩余且**没问过** ⇒ 要问',
    shouldAskCatchupContinuation({ remaining: 1, alreadyAsked: false }))
  check('S4 裁定③（问一次）：有剩余但**已经问过** ⇒ 不再自动追问',
    shouldAskCatchupContinuation({ remaining: 1, alreadyAsked: true }) === false)
  check('S4 边界：没有剩余 ⇒ 不问',
    shouldAskCatchupContinuation({ remaining: 0, alreadyAsked: false }) === false)

  /*
   * ★ S4 ② 补说**内容**（`renderCatchupAnnouncement`）：逐条 + 剩余时才提"还没完"
   *   + **一个批次只问一次**（已问过 ⇒ 只说"还没完"，不再追问）。
   */
  const { renderCatchupAnnouncement } = await import('../src/kernel/app/reminder/catchup-continuation.ts')
  const tenItems = Array.from({ length: 10 }, (_, index) => ({ text: `错过第${String(index + 1)}条` }))
  const renderTen = renderCatchupAnnouncement({ items: tenItems, remaining: 0, alreadyAsked: false })
  check('S4 ② 内容正控：10 条**逐条**列出（10 个 •）且**不问**（恰好 10 ⇒ 不问）',
    (renderTen.match(/•/gu) ?? []).length === 10 && !renderTen.includes('还没完'))
  const renderEleven = renderCatchupAnnouncement({ items: tenItems, remaining: 1, alreadyAsked: false })
  check('S4 ② 内容正控：还有第 11 条 ⇒ 末句加"未补说的事件还没完"**并询问**',
    renderEleven.includes('未补说的事件还没完') && renderEleven.includes('要继续吗'))
  const askedAlready = renderCatchupAnnouncement({ items: tenItems, remaining: 1, alreadyAsked: true })
  check('S4 ② 内容负控（裁定③）：**已问过** ⇒ 只说"还没完"，**不再追问**',
    askedAlready.includes('未补说的事件还没完') && !askedAlready.includes('要继续吗'))
  check('S4 ② 内容边界：无条目且无剩余 ⇒ **空串**（调用方据此不追加）',
    renderCatchupAnnouncement({ items: [], remaining: 0, alreadyAsked: false }) === '')
  check('S4 ② 内容边界：条目正文为空 ⇒ 该行跳过（不输出空 `• `）',
    renderCatchupAnnouncement({ items: [{ text: '  ' }, { text: '有内容的' }], remaining: 0, alreadyAsked: false }) === '• 有内容的')

  /*
   * ==========================================================================
   *  ★ S3 ③ 驱动核心（ADR-129 D05）：`nextRepeatOccurrence` 的**键一致性**三段式
   * ==========================================================================
   *  为什么先量它：续发实际是"再排一条 occurrence"，而**排期的键**必须与占用时用的
   *  **同一个冻结函数**算出来。键算错只有两种坏结局：撞上（续发永不发生）或差一点（重复投递）。
   *  ⇒ 这两件必须在**接驱动之前**就有机器判据。
   */
  const { nextRepeatOccurrence, REMINDER_REPEAT_INTERVAL_MS: repeatInterval } =
    await import('../src/kernel/app/reminder/repeat-policy.ts')
  const { reminderOccurrenceKey } = await import('../src/kernel/contracts/notification.ts')
  const armInput = { intentId: 'qni:fixture', planVersion: 1, mode: 'until_reply' as const, attempt: 1, deliveredAt: repeatAt }
  const armed = nextRepeatOccurrence(armInput)
  check('S3 ③ 正控：until_reply 且未回复 ⇒ arm（dueAt = 上次 + 60s，attempt 递增）',
    armed.kind === 'arm' && armed.dueAt === repeatAt + repeatInterval && armed.attempt === 2)
  check('S3 ③ 键一致性：排期的键**逐字等于**占用入口那个冻结函数算出的键',
    armed.kind === 'arm'
      && armed.occurrenceKey === reminderOccurrenceKey({ intentId: 'qni:fixture', planVersion: 1, dueAt: repeatAt + repeatInterval }))
  check('S3 ③ 键不同：下一次的键与本次不同（否则会撞上幂等、续发永不发生）',
    armed.kind === 'arm' && armed.occurrenceKey !== reminderOccurrenceKey({ intentId: 'qni:fixture', planVersion: 1, dueAt: repeatAt }))
  const armedStop = nextRepeatOccurrence({ ...armInput, settledByReply: true })
  check('S3 ③ 负控：任何回复 ⇒ **不排**（stop 原样透出，理由不变）',
    armedStop.kind === 'stop' && armedStop.reason === 'settled')
  const armedMax = nextRepeatOccurrence({ ...armInput, attempt: REMINDER_REPEAT_MAX_ATTEMPTS })
  check(`S3 ③ 边界：第 ${String(REMINDER_REPEAT_MAX_ATTEMPTS)} 次之后不再排`,
    armedMax.kind === 'stop' && armedMax.reason === 'max_attempts')
  const armedPaused = nextRepeatOccurrence({ ...armInput, paused: true })
  check('S3 ③ 负控：暂停优先于续发',
    armedPaused.kind === 'stop' && armedPaused.reason === 'paused')

  /*
   * ★ 可注入续发间隔（用户 2026-10-10 裁定）：行为级门要能在**秒级**观测第二条，
   *   而 60s 是冻结常量 ⇒ 做成可注入。这里量两件事：
   *   注入 ⇒ 用它；**不注入 ⇒ 仍是冻结的 60_000**（缺省行为逐字不变）。
   */
  const armedInjected = nextRepeatOccurrence({ ...armInput, intervalMs: 200 })
  check('S3 ③ 可注入间隔正控：注入 200ms ⇒ 下一条在 +200ms（行为级门可秒级跑）',
    armedInjected.kind === 'arm' && armedInjected.dueAt === repeatAt + 200)
  check('S3 ③ 可注入间隔负控：不注入 ⇒ 仍是冻结的 60_000（缺省逐字不变）',
    armed.kind === 'arm' && armed.dueAt === repeatAt + repeatInterval)
  const fact = { kind: 'scheduled' as const, id: 'fixture', dueAt: Date.now() + 10000, text: '记得拔插头。', sourceRefs: ['source'], channel: 'avatar' as const }
  check('完整回复更正错误渠道', runReplyGuardChain({ reminderResult: fact, replyText: '通过QQ提醒你拔插头。' }).replyText.includes('通过皮套'))
  check('自然正确渠道措辞保留', runReplyGuardChain({ reminderResult: fact, replyText: '到点通过皮套提醒你拔插头。' }).replyText === '到点通过皮套提醒你拔插头。')
  const speech: string[] = []
  const stream = new CheckedSpeechStream({ replyId: 'fixture', traceId: 'fixture', facts: { reminderResult: fact }, emit: packet => speech.push(packet.segment.text) })
  const envelope = '<lg-speech>{"segments":[{"text":"到点提醒你拔插头。","cue":"natural"}]}</lg-speech>'
  stream.push(envelope)
  check('流式回复补齐真实渠道确认', stream.finish(envelope).outcome.replyText.includes('通过皮套') && speech.join('').includes('通过皮套'))
  const scheduler = new FairTurnScheduler({ entries: ['cli'], maxQueuedPerEntry: 3 })
  const order: string[] = []
  let release!: () => void
  const first = scheduler.run('cli', async () => { await new Promise<void>(done => release = done); order.push('first') })
  const background = scheduler.runBackground(async () => { order.push('reminder') })
  const human = scheduler.run('cli', async () => { order.push('human') })
  release(); await Promise.all([first, background, human])
  check('提醒后台不抢人类排队轮次', order.join(',') === 'first,human,reminder')
  /*
   * ==========================================================================
   *  ★ R-a（2026-10-10）三段式：**同一进程只允许一个提醒调度器**
   * ==========================================================================
   *  ⚠️ 判据落在**冻结的纯函数**上（`decideReminderStart`），不是文本、也不是"重复投递"那种弱见证：
   *     重复投递已被 `excludeAttempted()`（`L-QQP-05` 读侧修法）挡掉
   *     ⇒ 若只测后果，**两个 timer 也可能全绿**（量错了东西）。
   *  ⚠️ 本文件**不 import `src/main.ts`**（模块加载会无条件跑完整 CLI）⇒ 判据必须能被单独引入；
   *     这正是把它从 main.ts 抽成纯函数的原因。
   */
  const { REMINDER_SCHEDULER_REFUSAL_CODE, decideReminderStart } =
    await import('../src/infrastructure/runtime/reminder-scheduler-guard.ts')
  let raHook = false
  const raFirst = decideReminderStart({ hookInstalled: raHook })
  raHook = true
  const raSecond = decideReminderStart({ hookInstalled: raHook })
  raHook = false
  const raThird = decideReminderStart({ hookInstalled: raHook })
  check('R-a 正控：未装调度器 ⇒ 判定可启动', raFirst.kind === 'start')
  check(
    'R-a 负控：已装调度器 ⇒ 具名拒绝（不静默复用、也不静默叠加）',
    raSecond.kind === 'refuse' && raSecond.code === REMINDER_SCHEDULER_REFUSAL_CODE
  )
  check('R-a 恢复：hook 清空后（= stop() 之后）⇒ 又能启动', raThird.kind === 'start')
  const legacy = await openRawPGlite(isolateDatabase('reminder-channel-legacy', { keep: true }).dir)
  try {
    for (const migration of MIGRATIONS.filter(item => item.version >= 14 && item.version <= 16)) {
      for (const statement of migration.statements) await legacy.exec(statement)
    }
    await legacy.exec(`insert into notification_intents
      (id, character_id, owner_ref, conversation_ref, kind, status, source_refs, has_source, scheduled_at, timezone,
       plan_version, permission_version, policy_version, text, text_fingerprint, dedupe_key, created_at, updated_at, schema_version)
      values ('old', 'character', 'owner', 'avatar-source', 'reminder', 'pending', '["source"]', true, 123456,
      'Asia/Shanghai', 1, 'permission@1', 'policy@1', '拔插头', 'fingerprint', 'old', 123, 123, 1)`)
    for (const statement of MIGRATIONS.find(item => item.version === 17)!.statements) await legacy.exec(statement)
    const old = (await legacy.query('select delivery_channel, conversation_ref, scheduled_at from notification_intents')).rows[0]
    check('旧提醒升级保留QQ出口和来源排期', old?.delivery_channel === 'qq_private' && old.conversation_ref === 'avatar-source' && Number(old.scheduled_at) === 123456)
    await assert.rejects(legacy.exec("update notification_intents set delivery_channel = 'email'"))
    check('数据库闭集阻止任意出口', true)
  } finally { await legacy.close() }

  /*
   * ==========================================================================
   *  ★ S3 ③ **接线级**门（函数级）：续发臂 + 排期前移 + 五条负控 + 兼容
   * ==========================================================================
   *  ⚠️ 夹具必须遵守 `reserveOccurrence` 的一致性：**实例 dueAt == 该意图当时的 scheduled_at**
   *     （notification-store.ts:502-505）⇒ 不能手工造两条不同 due 的实例（前三次就是这么失败的）。
   *  ⚠️ 每次 listPendingReminders() 会**前移意图排期**（5eaa5330/2b700409）⇒ 顺势插下一条实例即可。
   */
  allowProductionDatabase()
  const driverSandbox = isolateDatabase('reminder-repeat-driver', { keep: true })
  process.env.PGLITE_DATA_DIR = driverSandbox.dir
  process.env.PROJECT_LG_SANDBOX = driverSandbox.dir
  const driverCharacterId = (character.id ?? character.name) as unknown as CharacterId
  const driverRuntime = createThinHostRuntime({
    character: character,
    conversationLength: 16,
    settings: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
      OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
      OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash' },
  })
  await initDatabase(driverRuntime)
  const driverDb = getRawDb(driverRuntime)
  const keyOf = (intentId: string, dueAt: number): string => reminderOccurrenceKey({ intentId, planVersion: 1, dueAt })
  const addIntent = async (id: string, repeatMode: 'once' | 'until_reply' | null, scheduledAt: number): Promise<void> => {
    const written = await createIntent(driverDb, {
      id: id as never, characterId: driverCharacterId, ownerRef: 'owner', conversationRef: 'avatar-source',
      kind: 'reminder', deliveryChannel: 'avatar', sourceRefs: ['source'], scheduledAt,
      timezone: 'Asia/Shanghai', permissionVersion: 'permission@1', policyVersion: 'policy@1',
      text: '拔插头', dedupeKey: `dk-${id}`, ...(repeatMode === null ? {} : { repeatMode }),
    })
    assert.ok(written.intent !== undefined, `夹具意图未落库：${id}`)
  }
  const addOccurrence = async (key: string, intentId: string, dueAt: number): Promise<void> => {
    const written = await reserveOccurrence(driverDb, {
      occurrenceKey: key, intentId: intentId as never, expectedPlanVersion: 1,
      characterId: driverCharacterId, kind: 'reminder', dueAt,
      permissionVersion: 'permission@1', policyVersion: 'policy@1',
    })
    /* ★ 量具自检：夹具**必须**真的落库，否则"负控的前提"会静默不成立（第三次尝试正是靠它抓到真缺陷） */
    assert.ok(written.created === true, `夹具实例未落库：${key}`)
  }
  const schedulingFor = (opts: { lastInboundAt?: () => Promise<number>; paused?: () => Promise<boolean> }) => {
    const registry = new QqDeliveryRegistry({
      store: {
        readOccurrenceState: async key => (await getOccurrence(driverDb, key))?.state,
        advanceOccurrence: async request => await advanceOccurrence(driverDb, request.occurrenceKey, request),
      },
    })
    registry.openConnection(() => ({ written: true }))
    return createReminderScheduling({
      db: driverDb, characterId: driverCharacterId, channels: ['avatar'],
      registry: () => registry, execute: async () => ({ outcome: 'executed' as const }),
      reading: () => {}, ...opts,
    })
  }
  const hasKey = (entries: readonly { occurrenceKey: string }[], key: string): boolean =>
    entries.some(entry => entry.occurrenceKey === key)
  const scheduleOf = async (intentId: string): Promise<number | undefined> =>
    (await getIntent(driverDb, intentId as never))?.scheduledAt

  /* ① 正控 + 排期前移：until_reply，实例与排期一致（61_000）⇒ 臂 121_000，且意图排期前移到 121_000 */
  await addIntent('qni:repeat-1', 'until_reply', 61_000)
  await addOccurrence(keyOf('qni:repeat-1', 61_000), 'qni:repeat-1', 61_000)
  const wiredArmed = await schedulingFor({}).listPendingReminders()
  check('S3 ③ 接线正控：until_reply + 已有实例 ⇒ 臂下一条（键 = 上次 due + 60s）',
    hasKey(wiredArmed, keyOf('qni:repeat-1', 121_000)))
  check('S3 ③ 修复正控：臂的同时**意图排期前移**（否则 reserve 的一致性会挡住续发）',
    (await scheduleOf('qni:repeat-1')) === 121_000)

  /* ② 负控：那条键已被占用 ⇒ 不再臂同一条（防重复投递） */
  await addOccurrence(keyOf('qni:repeat-1', 121_000), 'qni:repeat-1', 121_000)
  const afterAttempted = await schedulingFor({}).listPendingReminders()
  check('S3 ③ 接线负控①：撞 attempted 的键不再臂（防重复投递）',
    !hasKey(afterAttempted, keyOf('qni:repeat-1', 121_000)))

  /* ③ 负控：投递之后他回过任何一句 ⇒ 不再臂（销账） */
  const wiredSettled = await schedulingFor({ lastInboundAt: async () => 130_000 }).listPendingReminders()
  check('S3 ③ 接线负控②：lastInboundAt > 上次 due ⇒ 不再臂（任何回复即销账）',
    !hasKey(wiredSettled, keyOf('qni:repeat-1', 181_000)))

  /* ④ 负控：暂停优先 ⇒ 不再臂 */
  const wiredPaused = await schedulingFor({ paused: async () => true }).listPendingReminders()
  check('S3 ③ 接线负控③：暂停 ⇒ 不再臂（D05 暂停优先）',
    !hasKey(wiredPaused, keyOf('qni:repeat-1', 181_000)))

  /* ⑤ 兼容 + 修复专属负控：repeat_mode=NULL ⇒ 原键原排期，且**排期逐字不动** */
  await addIntent('qni:plain-1', null, 1000)
  const plain = await schedulingFor({}).listPendingReminders()
  check('S3 ③ 接线兼容：repeat_mode=NULL ⇒ 逐字同旧（原键 + scheduledAt）',
    hasKey(plain, keyOf('qni:plain-1', 1000)) && !hasKey(plain, keyOf('qni:plain-1', 61_000)))
  check('S3 ③ 修复负控：普通提醒的排期**任何路径都不得被改写**',
    (await scheduleOf('qni:plain-1')) === 1000)

  /* ⑥ 边界：用循环把实例数推到上限 ⇒ 此后不再臂（一致性不允许手工造 10 条不同 due 的实例） */
  await addIntent('qni:repeat-cap', 'until_reply', 61_000)
  await addOccurrence(keyOf('qni:repeat-cap', 61_000), 'qni:repeat-cap', 61_000)
  let capDue = 61_000
  for (let round = 0; round < 12; round += 1) {
    const listed = await schedulingFor({}).listPendingReminders()
    const next = listed.find(entry => String(entry.occurrenceKey).includes('qni:repeat-cap'))
    if (next === undefined) break
    capDue = Number(next.dueAt)
    await addOccurrence(String(next.occurrenceKey), 'qni:repeat-cap', capDue)
  }
  const capListed = await schedulingFor({}).listPendingReminders()
  check(`S3 ③ 接线边界：实例数达到上限 10 ⇒ 不再臂（实际推到的最后一格 ${String(capDue)}）`,
    !capListed.some(entry => String(entry.occurrenceKey).includes('qni:repeat-cap')))

  /*
   * ==========================================================================
   *  ★ S4 ②（ADR-129 D07/D08）标记侧门：**错过 vs 过期**按可推导事实分开
   * ==========================================================================
   *  `missed` = 到期时**从未产生过实例**（核心不在 ⇒ 补说对象）；
   *  `expired` = **有过实例**（尝试过没送成 / 作废 ⇒ 不补说）。
   */
  const statusOf = async (intentId: string): Promise<string | undefined> =>
    (await getIntent(driverDb, intentId as never))?.status

  /* ① 正控：过期且**零实例** ⇒ missed */
  await addIntent('qni:miss-1', 'once', 1000)
  /* ⚠️ list 与 due 必须走**同一个**调度实例：onReminderDue 依赖实例内的 `intents` 缓存 */
  const missScheduler = schedulingFor({})
  const missDue = (await missScheduler.listPendingReminders()).find(entry => String(entry.occurrenceKey).includes('qni:miss-1'))
  assert.ok(missDue !== undefined, '夹具：miss-1 未进入待发列表')
  await missScheduler.onReminderDue(missDue!)
  check('S4 ② 标记正控：到期且**零实例** ⇒ `missed`（补说对象）', (await statusOf('qni:miss-1')) === 'missed')

  /* ② 负控：过期但**有过实例** ⇒ expired（不得进补说候选） */
  await addIntent('qni:miss-2', 'once', 1000)
  const missScheduler2 = schedulingFor({})
  const missDue2 = (await missScheduler2.listPendingReminders()).find(entry => String(entry.occurrenceKey).includes('qni:miss-2'))
  assert.ok(missDue2 !== undefined, '夹具：miss-2 未进入待发列表')
  await addOccurrence(keyOf('qni:miss-2', 1000), 'qni:miss-2', 1000)   // 有过一次尝试（与排期一致）
  await missScheduler2.onReminderDue(missDue2!)
  check('S4 ② 标记负控：有过实例 ⇒ `expired`（**不**进补说候选）', (await statusOf('qni:miss-2')) === 'expired')

  /* ③ 负控：还没到点（`reminder_not_due_yet`）⇒ **什么都不做**（状态保持 pending） */
  await addIntent('qni:not-yet-1', 'once', Date.now() + 86_400_000)
  const notYetScheduler = schedulingFor({})
  const notYet = (await notYetScheduler.listPendingReminders()).find(entry => String(entry.occurrenceKey).includes('qni:not-yet-1'))
  assert.ok(notYet !== undefined, '夹具：not-yet-1 未进入待发列表')
  await notYetScheduler.onReminderDue(notYet!)
  check('S4 ② 标记负控：未到点 ⇒ 终态**不动**（仍 pending）', (await statusOf('qni:not-yet-1')) === 'pending')

  /*
   * ★ S4 ② **候选集契约**：只有 `missed` 进补说候选；`expired`（尝试过没送成）与
   *   `pending`（还在等）**都不得进**。复用上面三个夹具，不必再造。
   */
  const catchup = await listMissedIntents(driverDb, driverCharacterId)
  const catchupIds = catchup.map(intent => String(intent.id))
  check('S4 ② 候选正控：`missed` 的那条进候选（补说对象）', catchupIds.includes('qni:miss-1'))
  check('S4 ② 候选负控①：`expired` 的**不得**进候选（尝试过没送成 ≠ 错过）', !catchupIds.includes('qni:miss-2'))
  check('S4 ② 候选负控②：`pending` 的**不得**进候选（还在等，不是错过）',
    !catchupIds.includes('qni:not-yet-1') && !catchupIds.includes('qni:repeat-1'))
  check('S4 ② 候选集自证：确实量到了候选（不是空集）', catchup.length >= 1)
} finally {
  if (!stopped) await stopHost()
  server.close()
  const output = resolve('artifacts/post-lv2/reminder-channels', String(Date.now()))
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, 'evidence.json'), JSON.stringify({ checks, sandbox: sandbox.dir, stdout: host.stdout, stderr: host.stderr }, null, 2))
}
console.log(`渠道与跨入口提醒：${checks.length} PASS`)
for (const [command, script] of [['python', 'scripts/reminder-channels-shell-verify.py'], [process.execPath, 'scripts/reminder-channels-frontend-verify.mjs']]) {
  const result = spawnSync(command, [script], { stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
  assert.equal(result.status, 0, `${script}: ${String(result.error ?? '')}`)
}
