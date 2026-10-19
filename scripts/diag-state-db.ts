/**
 * 直接查库核验 CharacterState 的持久化结果（不经过任何业务层）。
 *
 * 用途：证明状态**真的在数据库里**，而不是内存里的变量。
 * 跑法：node_modules/.bin/tsx scripts/diag-state-db.ts
 */
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

// ⚠️ 实验必须隔离：本脚本会建表（ensureStateTables），因此需要独立副本。
//    若要看**真实库**里的状态，用 `src/main.ts --inspect`（只读视图）。
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('diag-state-db')

import { stringToUuid } from '../src/kernel/contracts/uuid.ts'


import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { ensureStateTables } from '../src/state/repository.ts'

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await initDatabase(runtime)
await ensureStateTables(runtime)

const holder = runtime as unknown as {
  adapter?: { db?: { execute: (q: unknown) => Promise<unknown> } }
}
const db = holder.adapter?.db
if (!db) throw new Error('拿不到数据库句柄')

const rowsOf = (r: unknown) =>
  (((r as { rows?: unknown[] })?.rows ?? r) as Record<string, unknown>[]) ?? []

console.log('=== 1. 我们的两张表是否存在 ===')
const tables = rowsOf(
  await db.execute(
    sql`select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('character_states','state_events')
        order by table_name`
  )
)
console.log('  ' + tables.map((t) => String(t.table_name)).join(', '))

console.log('\n=== 2. character_states 表结构 ===')
const cols = rowsOf(
  await db.execute(
    sql`select column_name, data_type, is_nullable
        from information_schema.columns
        where table_name = 'character_states'
        order by ordinal_position`
  )
)
for (const c of cols) {
  console.log(`  ${String(c.column_name).padEnd(20)} ${String(c.data_type).padEnd(18)} null=${c.is_nullable}`)
}

console.log('\n=== 3. state_events 表结构 ===')
const cols2 = rowsOf(
  await db.execute(
    sql`select column_name, data_type
        from information_schema.columns
        where table_name = 'state_events'
        order by ordinal_position`
  )
)
for (const c of cols2) {
  console.log(`  ${String(c.column_name).padEnd(20)} ${String(c.data_type)}`)
}

console.log('\n=== 4. 实际存储的状态行 ===')
const states = rowsOf(await db.execute(sql`select * from character_states`))
const userId = stringToUuid(`user-${process.env.USER_NAME ?? 'Alex'}`)
for (const s of states) {
  console.log(
    `  character=${String(s.character_id).slice(0, 8)}… user=${String(s.user_id).slice(0, 8)}… | ` +
      `valence=${Number(s.valence).toFixed(3)} arousal=${Number(s.arousal).toFixed(3)} ` +
      `trust=${Number(s.trust).toFixed(3)} closeness=${Number(s.closeness).toFixed(3)} v${s.version}`
  )
  const last = Number(s.last_interaction_at)
  const mins = (Date.now() - last) / 60000
  console.log(`    last_interaction_at: ${new Date(last).toLocaleString('zh-CN', { hour12: false })}（${mins.toFixed(1)} 分钟前）`)
}
console.log(`  （预期 user_id = ${userId}）`)

console.log('\n=== 5. state_events 计数与最近 3 条 ===')
const count = rowsOf(await db.execute(sql`select count(*)::int as c from state_events`))
console.log(`  总事件数：${count[0]?.c}`)
const events = rowsOf(
  await db.execute(
    sql`select trigger, delta, reason, state_version, created_at
        from state_events order by created_at desc limit 3`
  )
)
for (const e of events) {
  console.log(`  [v${e.state_version}] [${e.trigger}] delta=${JSON.stringify(e.delta)}`)
  console.log(`      理由：${e.reason}`)
}

console.log('\n=== 6. 结论 ===')
console.log(
  `  character_states ${states.length} 行，state_events ${count[0]?.c} 行 —— ` +
    (states.length > 0 ? '✅ 状态确实持久化在数据库中' : '❌ 未找到状态行')
)

await runtime.stop()
process.exit(0)
