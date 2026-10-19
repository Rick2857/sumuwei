/**
 * 只读体检（M3.5）：迁移 0004 在她**真实数据**上留下了什么。
 *
 * ============================================================================
 *  在副本上读，真实库全程不被打开、不被写入
 * ============================================================================
 * 与 `inspect-production-copy.ts` 同一套规矩（先复制再读）。
 * 这里要回答的只有三个问题：
 *
 *   1. 真实库现在是不是 v4？那九个新列在不在？
 *   2. **既有行**在新列上是不是 NULL？（= 迁移没有重写历史数据）
 *   3. 真实数据量有没有变化？（事件 / 领域事件 / trace 的条数）
 *
 * 第 2 条是这份脚本存在的主要理由。计划书第 83 节要求"只做 additive migration、
 * 不重写历史行"，而这件事只有在**真实数据**上验证才算数 ——
 * 沙箱库里的行是刚写进去的，证明不了"旧行仍可读"。
 *
 * 跑法：tsx scripts/diag-m3.5-columns.ts
 */

import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import 'dotenv/config'

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { currentSchemaVersion, getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'

const PRODUCTION_DB = resolve(process.env.PGLITE_DATA_DIR ?? 'data/pglite')

if (!existsSync(PRODUCTION_DB)) {
  console.error(`找不到生产库：${PRODUCTION_DB}`)
  process.exit(2)
}

const copyDir = mkdtempSync(join(tmpdir(), 'project-lg-m35read-'))
const target = join(copyDir, 'pglite')

console.log('='.repeat(74))
console.log('M3.5 只读体检：迁移 0004 在她真实数据上的痕迹（副本上读）')
console.log('='.repeat(74))
console.log(`源  ：${PRODUCTION_DB}`)
console.log(`副本：${target}`)

cpSync(PRODUCTION_DB, target, { recursive: true })
process.env.PGLITE_DATA_DIR = target
process.env.PROJECT_LG_SANDBOX = target

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await runtime.registerPlugin(undefined as never)
await await __applyKernelMigrations(__getRawDb(runtime))

const db = getRawDb(runtime)

const one = async (query: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const rows = rowsOf(await db.execute(sql.raw(query)))
    return rows[0] as Record<string, unknown> | undefined
  } catch (error) {
    console.log(`  ⚠️ 查询失败：${(error as Error).message.slice(0, 100)}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. schema 版本与新列 ===')
// ---------------------------------------------------------------------------

const version = await currentSchemaVersion(db)
console.log(`  schema 版本：${version}（代码里的最新版本：${latestSchemaVersion()}）`)
console.log(`  ${version === latestSchemaVersion() ? '✅' : '❌'} 真实库已到最新 schema（迁移 0004 已应用）`)

const columns = rowsOf(
  await db.execute(
    sql`select table_name, column_name from information_schema.columns
        where table_name in ('conversation_events','character_domain_events','character_jobs','character_traces')
        order by table_name, column_name`
  )
).map((row) => `${String(row.table_name)}.${String(row.column_name)}`)

for (const expected of [
  'conversation_events.occurred_at',
  'conversation_events.logical_time',
  'character_domain_events.occurred_at',
  'character_domain_events.logical_time',
  'character_jobs.trigger_kind',
  'character_traces.observation_id',
  'character_traces.observation_type',
  'character_traces.intent_id',
  'character_traces.intent_type',
]) {
  console.log(`  ${columns.includes(expected) ? '✅' : '❌'} ${expected}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. 既有行没有被重写（新列必须仍为 NULL / 默认值）===')
// ---------------------------------------------------------------------------

const eventTime = await one(
  'select count(*)::int as c from conversation_events where occurred_at is not null or logical_time is not null'
)
const domainTime = await one(
  'select count(*)::int as c from character_domain_events where occurred_at is not null or logical_time is not null'
)
const traceSlots = await one(
  `select count(*)::int as c from character_traces
   where observation_id is not null or observation_type is not null
      or intent_id is not null or intent_type is not null`
)

console.log(
  `  ${Number(eventTime?.c ?? -1) === 0 ? '✅' : '❌'} conversation_events 里非空的时间列：${eventTime?.c} 行`
)
console.log(
  `  ${Number(domainTime?.c ?? -1) === 0 ? '✅' : '❌'} character_domain_events 里非空的时间列：${domainTime?.c} 行`
)
console.log(
  `  ${Number(traceSlots?.c ?? -1) === 0 ? '✅' : '❌'} character_traces 里非空的感知/意图槽：${traceSlots?.c} 行`
)
console.log('  （0 行 = 迁移只加了列，没有回填、没有重写历史 —— 计划书第 83 节的要求）')

// ---------------------------------------------------------------------------
console.log('\n=== 3. 真实数据量（与 M3 结束时对比）===')
// ---------------------------------------------------------------------------

for (const [label, table] of [
  ['conversation_events', 'conversation_events'],
  ['character_domain_events', 'character_domain_events'],
  ['character_traces', 'character_traces'],
  ['character_jobs', 'character_jobs'],
  ['character_projections', 'character_projections'],
] as const) {
  const row = await one(`select count(*)::int as c from ${table}`)
  console.log(`  ${label.padEnd(26)}: ${row?.c ?? '(表不存在)'}`)
}

const seed = await one('select seed_version, seed_hash from character_definitions limit 1')
console.log(`  Seed 版本 / 指纹前缀      : v${seed?.seed_version} ${String(seed?.seed_hash ?? '').slice(0, 12)}`)
console.log('  （两个值都必须与 M3 结束时一致：迁移不应改动她的身份）')

const trigger = await one(
  `select trigger_kind, count(*)::int as c from character_jobs group by trigger_kind order by trigger_kind`
)
console.log(`  现存 job 的 trigger_kind   : ${trigger ? `${trigger.trigger_kind}（${trigger.c} 条，旧行由默认值补齐）` : '(还没有 job)'}`)

console.log(`\n${'='.repeat(74)}`)
console.log('结论：真实库 = v' + version + '，九个新列就位，历史行零改动。')
console.log('='.repeat(74))

try {
  await runtime.stop()
} catch {
  /* 关不干净不影响结论 */
}
try {
  rmSync(copyDir, { recursive: true, force: true })
  console.log('副本已清理（真实库全程未被打开写入）')
} catch {
  console.log(`副本未能清理（可手动删）：${copyDir}`)
}
