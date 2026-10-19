/**
 * 诊断：确认 plugin-sql 是否真的建了表、迁移是否跑过。
 */
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'
import { logger } from '../src/infrastructure/telemetry/logger.ts'


import { character } from '../src/character/index.ts'

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })

console.log('--- registerPlugin(sql) ---')
await runtime.registerPlugin(undefined as never)
console.log('adapter =', (runtime.adapter as { constructor?: { name?: string } })?.constructor?.name)

// pglite 原始查询：看 schema 里到底有什么表
const adapter = runtime.adapter as unknown as {
  db?: { execute?: (q: unknown) => Promise<unknown> }
  getDatabase?: () => unknown
}
console.log('adapter keys =', Object.keys(adapter ?? {}).join(', '))

const db = (adapter.db ?? (typeof adapter.getDatabase === 'function' ? adapter.getDatabase() : undefined)) as
  | { execute: (q: unknown) => Promise<unknown> }
  | undefined

if (db?.execute) {
  try {
    const { sql } = await import('drizzle-orm')
    const rows = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
    )
    const list = (rows as { rows?: unknown[] })?.rows ?? rows
    console.log('--- public schema 表 ---')
    console.log(JSON.stringify(list))
  } catch (e) {
    console.log('查询 information_schema 失败: ' + (e instanceof Error ? e.message : String(e)))
  }
} else {
  console.log('拿不到底层 db handle（这本身也是线索）')
}

console.log('--- initialize() ---')
try {
  await runtime.initialize({ skipMigrations: false })
  console.log('initialize 成功')
} catch (e) {
  console.log('initialize 失败: ' + (e instanceof Error ? e.message : String(e)))
}

// 再查一次
if (db?.execute) {
  try {
    const { sql } = await import('drizzle-orm')
    const rows = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
    )
    const list = (rows as { rows?: unknown[] })?.rows ?? rows
    console.log('--- initialize 之后的表 ---')
    console.log(JSON.stringify(list))
  } catch (e) {
    console.log('二次查询失败: ' + (e instanceof Error ? e.message : String(e)))
  }
}

await runtime.stop()
logger.info('诊断结束')
