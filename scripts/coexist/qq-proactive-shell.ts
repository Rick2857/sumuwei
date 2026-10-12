/**
 * **门用的最小 QQ 外壳**（post-Lv2 / ADR-110 `D06` 的整链用）。
 *
 * ============================================================================
 *  它与 `scripts/qq/chat.ts` 的关系（必须说清楚，否则这就是"测了个假件"）
 * ============================================================================
 * ```text
 * 同一套**真**客户端类：`LgStdioClient`（连接档）+ `OneBotPrivateClient`（真 OneBot 协议）
 * 同一条处理器：`lg.setQqDeliveryHandler` ⇒ `client.deliverProactiveText(text)`
 * 同一条读数：打完 `{event:'qq_proactive_delivery', status, code}` 就走
 * ```
 * **少了什么**：`chat.ts` 开头的 `assertProductionAvatarEnvironment()`
 * —— 那是一道**刻意的生产闸**（正式外壳不许跑在沙箱/测试模型环境里）。
 * ⚠️ 本文件**不**绕过它、也**不**改它：本文件是**另一个**程序（门用外壳），
 *    名字上就写着是测试替身；而 `chat.ts` 那道闸原样留在生产外壳里。
 *    本文件**也不开数据库**（`chat.ts` 同样不开）⇒ 闸要防的那件事在这里不存在。
 *
 * ⚠️ 结论的边界：这一门证明的是"**真核心 + 真协议 + 真客户端类** 到 假 NapCat 通了"，
 *    **不是**"生产外壳在真机上跑通了"（那要真 NapCat + 真手机）。
 */
import { setTimeout as delay } from 'node:timers/promises'
import { readQqPrivateConfig } from '../../src/infrastructure/qq/private-config.ts'
import { OneBotPrivateClient } from '../../src/infrastructure/qq/onebot-private-client.ts'
import { LgStdioClient } from '../../src/infrastructure/qq/lg-stdio-client.ts'

const port = Number(process.env.QQ_COEXIST_CONNECT_PORT ?? '')
const token = (process.env.QQ_COEXIST_CONNECT_TOKEN ?? '').trim()
if (!Number.isSafeInteger(port) || port <= 0 || token === '') {
  throw new Error('门用外壳需要 QQ_COEXIST_CONNECT_PORT 与 QQ_COEXIST_CONNECT_TOKEN')
}
const settings = readQqPrivateConfig(process.env)
const root = process.env.PROJECT_LG_ROOT ?? process.cwd()

const lg = new LgStdioClient(root, process.env, {
  connect: { host: '127.0.0.1', port, token },
})
const client = new OneBotPrivateClient(
  settings,
  (request) => lg.submit(request),
  (reading) => console.log(JSON.stringify(reading))
)

/* 核心主动发来的投递 ⇒ 交给本外壳的发送面（与 `chat.ts` 逐字同一条路） */
lg.setQqDeliveryHandler(async (input) => {
  const reading = await client.deliverProactiveText(input.text)
  console.log(
    JSON.stringify({
      event: 'qq_proactive_delivery',
      deliveryId: input.deliveryId,
      status: reading.status,
      code: reading.reason,
    })
  )
  return reading
})

let stopped = false
process.once('SIGINT', () => (stopped = true))
process.once('SIGTERM', () => (stopped = true))
lg.process?.once('close', () => (stopped = true))

try {
  await lg.ready
  console.log(JSON.stringify({ event: 'shell_ready', port }))
  while (!stopped) {
    if (!client.connected) {
      try {
        await client.connect()
      } catch (error) {
        console.log(
          JSON.stringify({
            event: error instanceof Error ? error.message : 'onebot_connect_failed',
          })
        )
      }
    }
    await delay(1_000)
  }
} finally {
  await client.close()
  await lg.close()
}
