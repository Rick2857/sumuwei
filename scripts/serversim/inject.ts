/**
 * 服务器仿真环境 · 驱动一条 QQ 私聊（2026-10-20）
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 *  往假 OneBot 注入一条入站消息，然后**等**核心把回复送回来，并把回复读出来。
 *  这是"整机仿真"最有价值的一条动作：它把
 *  **外壳 → WS → 核心 → 模型 → 投递 → 回执** 整条链在 Linux 上真跑一遍。
 *
 *  ```bash
 *  pnpm serversim:inject -- --text "你在吗"
 *  pnpm serversim:inject -- --text "记住我喜欢柠檬茶" --wait 90
 *  ```
 *
 * ============================================================================
 *  ⚠️ 读数怎么解释
 * ============================================================================
 *  · 拿到回复 ⇒ **链路通了**（QQ 入口、核心、库、投递、回执都通了）。
 *  · 没拿到回复 ⇒ **不说明**哪里坏了 —— 可能是模型、可能是库、可能是入口。
 *    接着看 `pnpm serversim:logs -- simhost` 的日志。
 *  · 回复**内容本身不说明任何事**：仿真接的是**假模型端点**，它对任何输入
 *    都回同一句固定文本。内容断言必须切真实测试端点。
 * ============================================================================
 */

export {} // 顶层 await 需要本文件是一个模块

const args = process.argv.slice(2)
function arg (name: string): string | undefined {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}

const TEXT = arg('text') ?? '你在吗'
const WAIT_SEC = Number(arg('wait') ?? 60)
const CONTROL = 'http://127.0.0.1:6102'

async function json (path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  try {
    const response = await fetch(CONTROL + path, { ...init, signal: AbortSignal.timeout(10_000) })
    const text = await response.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* 不是 JSON 就留原文 */ }
    return { status: response.status, body }
  } catch (error) {
    return { status: 0, body: (error as Error).message }
  }
}

const health = await json('/health')
if (health.status !== 200) {
  console.error(`❌ 假 OneBot 控制面不通（${CONTROL}/health → ${String(health.status)}）`)
  console.error('   仿真栈没起来？先跑：pnpm serversim:up')
  process.exit(1)
}

/*
 * ⚠️ 先等**外壳连上**再注入。
 *    刚跑完 `serversim:migrate`（或刚重启）时核心还在启动，
 *    这时注入的消息会落进"没人接收"的窗口 ⇒ 看起来像"链路坏了"。
 *    判据：假 OneBot 的 `clients` ≥ 1（= 有一个 WS 客户端连上并握过手）。
 */
const CONNECT_WAIT_SEC = Number(arg('connect-wait') ?? 120)
const connectDeadline = Date.now() + CONNECT_WAIT_SEC * 1000
let clients = 0
while (Date.now() < connectDeadline) {
  const probe = await json('/health')
  clients = Number((probe.body as { clients?: number }).clients ?? 0)
  if (clients > 0) break
  await new Promise(done => setTimeout(done, 1000))
}
if (clients === 0) {
  console.error(`❌ ${CONNECT_WAIT_SEC}s 内没有任何 OneBot 客户端连上（核心/外壳没起来）`)
  console.error('   先看：pnpm serversim:logs -- simhost')
  process.exit(1)
}
console.log(`▸ 外壳已连接（clients=${clients}）`)

/*
 * ⚠️ 基线要取 `/sent` 的**数组长度**，不能取 `/health` 的 `sent` 字段 ——
 *    后者是**计数**（数字），当数组用会得到 `undefined`
 *    ⇒ `slice(undefined)` = 整个数组 ⇒ 读回来的是**上一次**的回复
 *    （实测踩过，2026-10-20：注入第 2 条却显示第 1 条的 messageId）。
 */
const baseline = await json('/sent')
const before = ((baseline.body as { sent?: Array<{ messageId: number }> }).sent ?? []).length

console.log(`▸ 注入一条 QQ 私聊：${TEXT}`)
const injected = await json('/inject', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: TEXT }),
})
if (injected.status !== 200) {
  console.error(`❌ 注入失败：${JSON.stringify(injected.body)}`)
  process.exit(1)
}
console.log(`  messageId = ${String((injected.body as { messageId?: number }).messageId)}`)

const deadline = Date.now() + WAIT_SEC * 1000
let sent: Array<{ messageId: number; text: string; at: string }> = []
while (Date.now() < deadline) {
  const read = await json('/sent')
  const all = ((read.body as { sent?: Array<{ messageId: number; text: string; at: string }> }).sent ?? [])
  sent = all.slice(before)
  if (sent.length > 0) break
  await new Promise(done => setTimeout(done, 1000))
}

console.log('')
if (sent.length === 0) {
  console.log(`⚠️ ${WAIT_SEC}s 内核心没有送回任何东西。`)
  console.log('   这**不说明**哪里坏了。按顺序看：')
  console.log('     1. pnpm serversim:logs -- simhost     （核心起没起、报什么错）')
  console.log('     2. pnpm serversim:logs -- onebot      （外壳连上没）')
  console.log('     3. pnpm serversim:logs -- model       （假端点有没有被调用）')
  process.exit(1)
}

for (const message of sent) {
  console.log(`── 核心送回（messageId=${String(message.messageId)}）──`)
  console.log(message.text)
  console.log('──────────────────────────────────────────')
}
console.log(`\n✅ 链路通了：入站 → 核心 → 投递 → 回执（${sent.length} 条）`)
console.log('   ⚠️ 仿真接的是**假模型端点**，回复内容恒定 —— 内容断言要切真实测试端点。')
