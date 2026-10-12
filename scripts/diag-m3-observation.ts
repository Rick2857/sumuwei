/**
 * 诊断：M3 评测的观测到底装了什么。
 *
 * 为什么需要它：三条 M3 用例（M3-SRC-001/002、M3-NEW-001）报的是
 * "装置没有成功写入…" / "账本里只有 1 个会话"，而那两句报错**不告诉你**
 * 实际上装进观测的是什么。排查这类问题的正确第一步是把观测结构打出来，
 * 而不是去猜断言为什么失败。
 *
 * 本脚本完全在一次性副本库上跑（沿用 eval-m3 的隔离），真实库碰不到。
 *
 * 跑法：tsx scripts/diag-m3-observation.ts M3-SRC-001
 */

import { isolateDatabase } from '../src/dev/sandbox.ts'

import { M3_SUITES } from '../evals/m3/index.ts'
import { runCase } from '../evals/m3/runtime/engine.ts'

isolateDatabase('diag-m3-observation')

const wanted = process.argv[2] ?? 'M3-SRC-001'

const found: { suiteId: string; item: (typeof M3_SUITES)[number]['cases'][number] } | undefined =
  (() => {
    for (const suite of M3_SUITES) {
      for (const item of suite.cases) {
        if (item.id === wanted) return { suiteId: suite.id, item }
      }
    }
    return undefined
  })()

if (!found) {
  console.error(`找不到用例 ${wanted}。可用的：`)
  for (const suite of M3_SUITES) {
    for (const item of suite.cases) console.error(`  ${item.id}  (${suite.id}) — ${item.description}`)
  }
  process.exit(1)
}

console.log(`用例：${found.item.id}（${found.suiteId}）`)
console.log(`  装置：${found.item.fixture ? '有' : '无'}｜轮次 ${found.item.turns.length}｜检查 ${found.item.checks.length}`)

const outcome = await runCase(
  M3_SUITES.find((s) => s.id === found.suiteId)!,
  found.item,
  {
    // 不注入模型 = echo 模式（离线档）。其余字段在这条诊断路径上用不到，
    // 但类型要求给全 —— 刻意用空值而不是编造，让"这只是一条诊断脚本"一眼可见。
    suites: M3_SUITES,
    live: false,
    modelProfile: 'echo',
    thresholds: { hardZero: [], minimums: {} },
  }
)

console.log(`\n观测条数：${outcome.observations.length}`)
outcome.observations.forEach((observation, index) => {
  console.log(`\n--- 观测 #${index + 1} ---`)
  console.log(`  reply             : ${observation.reply.slice(0, 90)}`)
  console.log(`  conversationSeq   : ${observation.conversationSequence}`)
  console.log(`  newEvents (${observation.newEvents.length}):`)
  for (const event of observation.newEvents) {
    console.log(
      `      #${event.sequence} cs=${event.conversationSequence} ` +
        `[${event.actorType}/${event.type}] kind=${event.sourceKind} ` +
        `auth=${event.sourceAuthority} conv=${event.conversationId}`
    )
    console.log(`          content: ${event.content.slice(0, 60)}`)
  }
  const attrs = observation.attributes ?? {}
  console.log(`  attributes keys   : ${Object.keys(attrs).join(', ')}`)
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('__')) {
      console.log(`      ${key}: <运行环境句柄>`)
      continue
    }
    const text = Array.isArray(value) ? JSON.stringify(value) : String(value)
    console.log(`      ${key}: ${text.slice(0, 140)}`)
  }
})

console.log(`\n--- 检查结论 ---`)
for (const entry of outcome.result.deterministic) {
  console.log(`  [${entry.pass ? '✅' : '❌'}] ${entry.id}`)
  if (entry.detail) console.log(`        ${entry.detail}`)
  if (entry.measured) console.log(`        measured: ${entry.measured}`)
}

// ---------------------------------------------------------------------------
// 额外诊断：把"装置交出来的账本"完整摊开
//
// 有些断言是拿装置在 attributes 里留下的**聚合结论**做判定的
// （例如 NEW-001 的 `conversationsInLedger`）。那类断言失败时，
// 光看单条观测的 newEvents 查不出来 —— 必须看装置当时**真的**读到了什么。
// ---------------------------------------------------------------------------
const allEvents = outcome.observations.flatMap((o) => o.newEvents)

console.log(`\n--- 装置读到的账本（汇总 ${allEvents.length} 条）---`)
for (const event of allEvents) {
  console.log(
    `  #${event.sequence} cs=${event.conversationSequence} conv=${event.conversationId} ` +
      `[${event.actorType}] ${event.content.slice(0, 40)}`
  )
}
console.log(
  `  会话分布：${JSON.stringify(
    allEvents.reduce<Record<string, number>>((acc, e) => {
      const key = String(e.conversationId)
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {})
  )}`
)

process.exit(0)
