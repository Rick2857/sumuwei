/** Formal QQ entry; .env remains the sole production model and database configuration. */
import { config, parse } from 'dotenv'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertProductionAvatarEnvironment } from '../postlv2-production-env.ts'
import { readQqPrivateConfig } from '../../src/infrastructure/qq/private-config.ts'
import { OneBotPrivateClient } from '../../src/infrastructure/qq/onebot-private-client.ts'
import { openQqDeliveryJournal } from '../../src/infrastructure/qq/voice-delivery-journal.ts'
import { createHttpQqVoiceSynthesizer, readQqTtsConfig } from '../../src/infrastructure/qq/tts-executor.ts'
import { LgStdioClient } from '../../src/infrastructure/qq/lg-stdio-client.ts'
import { readWechatConfig, WechatGroupClient } from '../../src/infrastructure/wechat/group-client.ts'

const root = process.env.LG_3D_OPERATION_ROOT === undefined
  ? resolve(import.meta.dirname, '../..') : resolve(process.env.LG_3D_OPERATION_ROOT)
assertProductionAvatarEnvironment(process.env, root)
const production = config({ path: resolve(root, '.env'), override: true, quiet: true })
const qqEnv = parse(readFileSync(resolve(root, '.env.qq')))
for (const [key, value] of Object.entries(qqEnv)) if (key.startsWith('QQ_')) process.env[key] = value
const wechatFile = resolve(root, '.env.wechat')
if (existsSync(wechatFile)) {
  for (const [key, value] of Object.entries(parse(readFileSync(wechatFile)))) if (key.startsWith('WECHAT_')) process.env[key] = value
}
const wechatConfig = readWechatConfig(process.env)
assertProductionAvatarEnvironment(process.env, root)
const settings = readQqPrivateConfig(process.env)
/*
 * post-Lv2 / P2：QQ 语音输出的**唯一装配点**（缺省全关 ⇒ 与 P1 之前逐字相同）。
 *
 * ```text
 * CHARACTER_QQ_VOICE_REPLY      协议开关（核心只在它为真时给她"文字/语音"选择）
 * CHARACTER_QQ_VOICE_OUTPUT     能力声明（核心据此认为语音可用）
 * CHARACTER_QQ_TTS_*            真实 TTS 端点/密钥/模型/音色（四件齐全才装端口）
 * CHARACTER_QQ_DELIVERY_JOURNAL 投递日志路径（缺省 data/qq-reply-delivery.jsonl）
 * ```
 * ⚠️ **失败关闭**：日志打不开 / TTS 配置不全 ⇒ **不装**语音端口 ⇒ 她选语音时
 *    外壳如实回落到文字（核心会记 `voice_output_absent`、投递日志不会记录未发送的语音）。
 * ⚠️ 日志与端口的**装载条件在这里**，不在客户端里 —— 装配层才看得见配置。
 */
const enabledFlag = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test((value ?? '').trim())
const voiceProtocolEnabled = enabledFlag(process.env.CHARACTER_QQ_VOICE_REPLY)
const voiceOutputDeclared = voiceProtocolEnabled && enabledFlag(process.env.CHARACTER_QQ_VOICE_OUTPUT)
const journalPath = resolve(root, (process.env.CHARACTER_QQ_DELIVERY_JOURNAL ?? 'data/qq-reply-delivery.jsonl').trim())
const deliveryJournal = voiceProtocolEnabled ? openQqDeliveryJournal(journalPath) : undefined
const ttsConfig = voiceOutputDeclared ? readQqTtsConfig(process.env) : undefined
const voiceOutput = ttsConfig !== undefined && deliveryJournal?.journal !== undefined
  ? { synthesizer: createHttpQqVoiceSynthesizer(ttsConfig) }
  : undefined
if (voiceProtocolEnabled && deliveryJournal?.error !== undefined) {
  console.log(JSON.stringify({ event: 'qq_delivery_journal_open_failed', reason: deliveryJournal.error, path: journalPath }))
}
if (voiceOutputDeclared && voiceOutput === undefined) {
  console.log(JSON.stringify({
    event: 'qq_voice_output_unavailable',
    reason: ttsConfig === undefined ? 'tts_not_configured' : deliveryJournal?.journal === undefined ? 'delivery_journal_unavailable' : 'unknown',
  }))
}
if (!production.parsed?.OPENAI_API_KEY?.trim()) throw new Error('QQ requires .env OPENAI_API_KEY')
/*
 * post-Lv2 / ADR-109：**共存连接档**（可选）。
 *
 * ```text
 * 两个变量都不给 ⇒ 旧形态：本外壳自己 spawn 一个 `--bridge --qq-private` 子进程
 * 两个都给       ⇒ 连到 `--coexist` 的 QQ 监听（一个核心、两条入口）
 * ```
 * ⚠️ 只给一个 ⇒ **拒绝**（半个配置比没有配置更危险：说不清它到底连哪儿）。
 */
const coexistPort = (process.env.QQ_COEXIST_CONNECT_PORT ?? '').trim()
const coexistToken = (process.env.QQ_COEXIST_CONNECT_TOKEN ?? '').trim()
if ((coexistPort === '') !== (coexistToken === '')) {
  throw new Error('QQ 共存连接档必须**同时**给 QQ_COEXIST_CONNECT_PORT 与 QQ_COEXIST_CONNECT_TOKEN')
}
const coexistConnect = coexistPort === ''
  ? undefined
  : { host: '127.0.0.1', port: Number(coexistPort), token: coexistToken }
if (coexistConnect !== undefined && !Number.isSafeInteger(coexistConnect.port)) {
  throw new Error('QQ_COEXIST_CONNECT_PORT 不是合法端口')
}
if (process.argv.includes('--check')) {
  console.log('PASS: QQ owner/bot are distinct; loopback token configured; production entry uses existing main.ts')
  console.log(
    coexistConnect === undefined
      ? '模式：旧形态（本外壳自 spawn 一个 LG 子进程）'
      : `模式：共存连接档（连 127.0.0.1:${String(coexistConnect.port)} 的 QQ 入口）`
  )
} else {
  const lg = new LgStdioClient(root, process.env, coexistConnect === undefined ? {} : { connect: coexistConnect })
  /*
   * ADR-156 / P3-B：**群入站准入下沉给核心**（只有群任务开关打开时才下放）。
   *
   * ⚠️ 关着 ⇒ 外壳仍按静态群名单过滤（旧行为逐字不变）。
   * ⚠️ 打开 ⇒ 外壳只做结构校验，准入由核心的 `decideGroupAdmission` /
   *    `decideInboundRouting` 判（"先看生效任务，再看旧名单"）。
   * ⚠️ 出站不放宽：旧回复路径仍查静态名单，任务发送仍只走窄路径。
   */
  const groupTasksEnabled = (process.env.CHARACTER_QQ_GROUP_TASKS_ENABLED ?? '').trim() === 'true'
  const deferGroupAdmissionToCore = groupTasksEnabled
  const client = new OneBotPrivateClient(settings, (request) => lg.submit(request), (reading) => console.log(JSON.stringify(reading)),
    voiceOutput, deliveryJournal?.journal, undefined, deferGroupAdmissionToCore)
  /*
   * post-Lv2 / ADR-110 `D06`：**核心主动发来的投递**交给本外壳的发送面。
   *
   * ```text
   * 核心 → 外壳  DELIVER_QQ_TEXT
   * 外壳 → 核心  REPORT_QQ_DELIVERY（三态：api_accepted / failed_confirmed / delivery_unknown）
   * ```
   * ⚠️ 投递走 `client.deliverProactiveText()` —— 它与普通回复**共用同一条串行队列**，
   *    并且**普通回复优先**（外壳侧的让让逻辑在 `deliverOnQueue` 里）。
   * ⚠️ 外壳**仍然不打开数据库**：这里只是把一行文字转给已鉴权的 OneBot 连接。
   */
  lg.setQqDeliveryHandler(async (input) => {
    const reading = await client.deliverProactiveText(input.text)
    console.log(JSON.stringify({ event: 'qq_proactive_delivery', deliveryId: input.deliveryId, status: reading.status, code: reading.reason }))
    return reading
  })
  /*
   * ADR-156 / P3-G：**核心派发来的群任务消息**交给本外壳的发送面。
   *
   * ```text
   * 核心 → 外壳  DELIVER_GROUP_TASK
   * 外壳 → 核心  REPORT_GROUP_TASK_DELIVERY（三态：api_accepted / failed_confirmed / delivery_unknown）
   * ```
   * ⚠️ 只在群任务开关打开时装：关着 ⇒ **不装** ⇒ 那条指令如实回报
   *    `group_task_delivery_handler_absent`（**不会**假装发过；核心按回执结算额度）。
   * ⚠️ 落地走 `client.deliverGroupTaskFromCore()`：**同一条串行队列**（普通回复优先）、
   *    策略 A 四条检查（形状 / 目标绑定 / 有效期 / 发送幂等），外壳**仍然不打开数据库**——
   *    授权是核心在派发之前按持久层任务判完的。
   */
  if (groupTasksEnabled) {
    lg.setGroupTaskDeliveryHandler(async (groupTask) => await client.deliverGroupTaskFromCore(groupTask))
  }
  /*
   * ADR-156 / P3-I：**核心发来的只读群列表查询**（`LIST_GROUPS`）交给本外壳那条 OneBot 连接。
   *
   * ```text
   * 核心 → 外壳  LIST_GROUPS
   * 外壳 → 核心  LIST_GROUPS_RESULT（有列表就带 groups，失败就带具名 code）
   * ```
   * ⚠️ 只在群任务开关打开时装：关着 ⇒ **不装** ⇒ 核心收到
   *    `group_task_group_list_handler_absent`（**不会**拿到一个假的空列表）。
   * ⚠️ `client.listGroups()` **只读**：一个 `get_group_list`，不发消息、不占发送队列、
   *    不做任何放行决定 —— 核心拿它做**群目标消歧**，能不能发仍由任务授权判。
   * ⚠️ 顺带的意义：核心不再为了读群列表而**自建第二条 ws 连接**（P3-I 的 W1）。
   */
  if (groupTasksEnabled) {
    lg.setGroupListHandler(async () => await client.listGroups())
  }
  let stopped = false
  const wechat = wechatConfig === undefined ? undefined : new WechatGroupClient(wechatConfig,
    request => lg.submit(request), reading => console.log(JSON.stringify(reading)), request => lg.assessGroupReply(request))
  const stop = (): void => { stopped = true; wechat?.stop() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // The shared production supervisor closes this pipe before draining the core.
  if (coexistConnect !== undefined && !process.stdin.isTTY) {
    process.stdin.resume()
    process.stdin.once('end', stop)
  }
  lg.process?.once('close', stop)
  let wechatLoop: Promise<void> | undefined
  try {
    await lg.ready
    if (wechat) wechatLoop = (async () => {
      while (!stopped) {
        try { await wechat.poll() }
        catch { console.log(JSON.stringify({ event: 'wechat_poll_unavailable' })) }
        if (!stopped) await delay(3000)
      }
    })()
    console.log(
      coexistConnect === undefined
        ? 'LG 已就绪，等待独立 QQ 机器人连接。'
        : `LG 已就绪（共存连接档 127.0.0.1:${String(coexistConnect.port)}），等待独立 QQ 机器人连接。`
    )
    while (!stopped) {
      if (!client.connected) {
        try { await client.connect() }
        catch (error) {
          const code = error instanceof Error ? error.message : 'onebot_connect_failed'
          console.log(JSON.stringify({ event: code }))
          if (code === 'onebot_bot_account_mismatch') throw error
        }
      }
      await delay(3000)
    }
  } finally {
    stop()
    await client.close()
    await wechatLoop
    const code = await lg.close()
    if (code !== 0) process.exitCode = 1
  }
}
