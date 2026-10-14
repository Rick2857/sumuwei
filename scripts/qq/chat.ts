/** Formal QQ entry; .env remains the sole production model and database configuration. */
import { config, parse } from 'dotenv'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertProductionAvatarEnvironment } from '../postlv2-production-env.ts'
import { readQqPrivateConfig } from '../../src/infrastructure/qq/private-config.ts'
import { OneBotPrivateClient } from '../../src/infrastructure/qq/onebot-private-client.ts'
import { LgStdioClient } from '../../src/infrastructure/qq/lg-stdio-client.ts'

const root = process.env.LG_3D_OPERATION_ROOT === undefined
  ? resolve(import.meta.dirname, '../..') : resolve(process.env.LG_3D_OPERATION_ROOT)
assertProductionAvatarEnvironment(process.env, root)
const production = config({ path: resolve(root, '.env'), override: true, quiet: true })
const qqEnv = parse(readFileSync(resolve(root, '.env.qq')))
for (const [key, value] of Object.entries(qqEnv)) if (key.startsWith('QQ_')) process.env[key] = value
assertProductionAvatarEnvironment(process.env, root)
const settings = readQqPrivateConfig(process.env)
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
  const client = new OneBotPrivateClient(settings, (request) => lg.submit(request), (reading) => console.log(JSON.stringify(reading)))
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
  let stopped = false
  const stop = (): void => { stopped = true }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // The shared production supervisor closes this pipe before draining the core.
  if (coexistConnect !== undefined && !process.stdin.isTTY) {
    process.stdin.resume()
    process.stdin.once('end', stop)
  }
  lg.process?.once('close', stop)
  try {
    await lg.ready
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
    await client.close()
    const code = await lg.close()
    if (code !== 0) process.exitCode = 1
  }
}
