/**
 * 诊断：Phoenix 里到底存了哪些 span 与属性名。
 *
 * 为什么需要它：M3 Phoenix 验证报"按 input event id 指纹匹配到 0 个 span"，
 * 而那个报错**不告诉你 Phoenix 里的属性名长什么样**。
 * 排查这类问题的正确第一步是把远端实际存的东西打出来 ——
 * 而不是继续猜我们发出去的属性名。
 *
 * M2.5 的验收里已经有一条同类教训：`session.id` 是 **resource 级**属性，
 * 而 spans 列表 API 只返回 **span 级** attributes，按它过滤会查到 0 条。
 *
 * 跑法：tsx scripts/diag-phoenix-spans.ts [name条件]
 */

import 'dotenv/config'

const PHOENIX = process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://127.0.0.1:6006'
const condition = process.argv[2] ?? "name == 'character.turn'"

const url = new URL(`${PHOENIX}/v1/projects/default/spans`)
url.searchParams.set('condition', condition)
url.searchParams.set('limit', '50')

console.log('='.repeat(78))
console.log(`Phoenix spans 诊断：${url.toString()}`)
console.log('='.repeat(78))

const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
console.log(`HTTP ${response.status}`)
if (!response.ok) {
  console.log(await response.text())
  process.exit(1)
}

const body = (await response.json()) as {
  data?: { name?: string; attributes?: Record<string, unknown> }[]
}
const rows = Array.isArray(body.data) ? body.data : []
console.log(`共 ${rows.length} 条 span\n`)

/** 收集所有出现过的属性名（这才是"我们能查什么"的真相） */
const names = new Map<string, number>()
for (const row of rows) {
  for (const key of Object.keys(row.attributes ?? {})) {
    names.set(key, (names.get(key) ?? 0) + 1)
  }
}

console.log('出现过的属性名（按出现次数）：')
for (const [key, count] of [...names.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${key}`)
}

console.log('\n最后 3 条 span 的完整内容：')
for (const row of rows.slice(-3)) {
  console.log(`\n--- ${row.name} ---`)
  console.log(JSON.stringify(row.attributes ?? {}, null, 2).slice(0, 2000))
}

process.exit(0)
