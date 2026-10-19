/**
 * 只读体检：把生产库**复制一份**到临时目录再读，因此绝不碰真实对话库。
 *
 * 目的（M2.5 → M3 交接前）：
 *   · 生产库的 kernel schema 到底迁移到位没有？
 *   · 她现在的真实数据有多少（消息 / 事件 / 领域事件 / 投影 / trace）？
 *   · M3 接手时是"从零开始"还是"已有历史"？
 *
 * 跑法：node_modules/.bin/tsx scripts/inspect-production-copy.ts
 */

import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import 'dotenv/config'

import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { currentSchemaVersion, getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'

const PRODUCTION_DB = resolve(process.env.PGLITE_DATA_DIR ?? 'data/pglite')

if (!existsSync(PRODUCTION_DB)) {
  console.error(`找不到生产库：${PRODUCTION_DB}`)
  process.exit(2)
}

const copyDir = mkdtempSync(join(tmpdir(), 'project-lg-prodread-'))
const target = join(copyDir, 'pglite')
console.log('='.repeat(72))
console.log('生产库只读体检（在副本上读，真实库不被打开、不被写入）')
console.log('='.repeat(72))
console.log(`源：${PRODUCTION_DB}`)
console.log(`副本：${target}`)

cpSync(PRODUCTION_DB, target, { recursive: true })

// 让 pglite 适配器指向副本
process.env.PGLITE_DATA_DIR = target
process.env.PROJECT_LG_SANDBOX = target // 绕过写保护闸（仍然只读）

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await runtime.registerPlugin(undefined as never)
await await __applyKernelMigrations(__getRawDb(runtime))

const db = getRawDb(runtime)

const count = async (label: string, query: string): Promise<number | null> => {
  try {
    const rows = rowsOf(await db.execute(sql.raw(query)))
    return Number(rows[0]?.c ?? 0)
  } catch (error) {
    console.log(`  ⚠️ ${label}: ${(error as Error).message.slice(0, 80)}`)
    return null
  }
}

const tables = rowsOf(
  await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  ),
).map((r) => String(r.table_name))

/**
 * kernel 的表清单。
 *
 * ⚠️ 分两组，因为**生产库当前只在第一组里**：
 *
 *   M2.5 建的表（迁移 0002）—— 生产库现在有这些
 *   M3 新增的表（迁移 0003）—— 生产库要等**下一次跑主程序**才会建
 *
 * 第一版把所有表平铺成一个清单，于是 M3 实施期间跑这个体检脚本会报
 * "❌ 缺少 character_definition_versions…（说明主程序从未运行过 M2.5 代码）" ——
 * 那句提示是**错的**（M2.5 早跑过了），而且会让人以为生产库坏了。
 *
 * 分成"缺了就是真问题"与"缺了只是还没迁移"两组之后，
 * 这个脚本才真的能回答它本来要回答的问题：**生产库是不是健康的**。
 */
const kernelTablesM25 = [
  'character_definitions',
  'conversation_events',
  'character_domain_events',
  'character_projections',
  'character_jobs',
  'character_traces',
  'character_sequence_counters',
  'processed_operations',
  'processor_watermarks',
  'character_schema_migrations',
]

/** M3（迁移 0003）新增的表：等主程序跑一次就会建出来 */
const kernelTablesM3 = [
  'character_definition_versions',
  'user_identities',
  'user_identity_mappings',
  'conversation_identities',
]

const schemaVersion = await currentSchemaVersion(db)

console.log(`\n=== 1. schema ===`)
console.log(`总表数：${tables.length}`)
const missing = kernelTablesM25.filter((t) => !tables.includes(t))
console.log(
  missing.length === 0
    ? `✅ M2.5 的十张表全部存在`
    : `❌ 缺少：${missing.join(', ')}（说明主程序从未运行过 M2.5 代码）`,
)

const missingM3 = kernelTablesM3.filter((t) => !tables.includes(t))
console.log(
  missingM3.length === 0
    ? `✅ M3 的四张新表也都在（迁移 0003 已应用）`
    : `⏳ M3 的新表尚未建立（迁移 0003 未应用）：${missingM3.join(', ')}` +
      `\n   这不是问题 —— 迁移在**下一次跑主程序**时自动应用（生产库平时不被脚本触碰）。`,
)
console.log(`迁移版本：${schemaVersion}`)

if (missing.length === 0) {
  const applied = rowsOf(
    await db.execute(sql`select version, name, applied_at from character_schema_migrations order by version`),
  )
  for (const row of applied) {
    console.log(
      `  #${row.version} ${String(row.name)}  @ ${new Date(Number(row.applied_at)).toLocaleString('zh-CN', { hour12: false })}`,
    )
  }
}

/*
 * Seed 的结构化表示是否已装载。
 *
 * 这是"迁移 0003 之后能不能启动"的直接判据：旧行的 `definition_json` 是 null，
 * 而 `rowToDefinition` 拒绝凭旧自由文本反推一份 Seed ——
 * 也就是说这一列为空时，**任何命令都会在启动时失败**（实测踩到过）。
 *
 * 因此它必须在体检里可见，而不是等启动报错才发现。
 */
if (tables.includes('character_definitions')) {
  const seedRows = rowsOf(
    await db.execute(sql`select
      count(*)::int as total,
      count(*) filter (where definition_json is null)::int as unloaded,
      max(seed_version)::int as version
      from character_definitions`),
  )
  const unloaded = Number(seedRows[0]?.unloaded ?? 0)
  console.log(
    unloaded === 0
      ? `✅ Seed 结构化表示已装载（v${String(seedRows[0]?.version ?? '?')}）`
      : `❌ Seed 有 ${unloaded} 行缺 definition_json → **启动会失败**；` +
        `\n   跑一次主程序会自动装载（迁移 0003 之后的旧行需要一次装载）。`,
  )
}

console.log(`\n=== 2. 她的真实数据 ===`)
const messages = await count('messages', `select count(*)::int as c from memories where type = 'messages'`)
const events = await count('conversation_events', `select count(*)::int as c from conversation_events`)
const domainEvents = await count('character_domain_events', `select count(*)::int as c from character_domain_events`)
const projections = await count('character_projections', `select count(*)::int as c from character_projections`)
const traces = await count('character_traces', `select count(*)::int as c from character_traces`)
const states = await count('character_states', `select count(*)::int as c from character_states`)

// --- M3 的身份表：回答"谁是谁"在数据上到底有没有落地 ----------------------
if (missingM3.length === 0) {
  const users = await count('user_identities', `select count(*)::int as c from user_identities`)
  const bindings = await count(
    'user_identity_mappings',
    `select count(*)::int as c from user_identity_mappings`,
  )
  const conversations = await count(
    'conversation_identities',
    `select count(*)::int as c from conversation_identities`,
  )
  const versions = await count(
    'character_definition_versions',
    `select count(*)::int as c from character_definition_versions`,
  )
  console.log('')
  console.log('  M3 身份与 Seed 历史：')
  console.log(`    user_identities             : ${users}`)
  console.log(`    user_identity_mappings      : ${bindings}`)
  console.log(`    conversation_identities     : ${conversations}`)
  console.log(`    character_definition_versions: ${versions}`)
  console.log(
    users === 0 && conversations === 0
      ? '    （都还是 0 —— 身份由**第一件真实发生的事**带出来：跟她聊一轮就会写入）'
      : '    （身份已落地：换会话/换平台仍是同一个人这件事有数据依据）',
  )
}

console.log(`  memories(type=messages)      : ${messages ?? '(无表)'}   ← 她能"记得"的原文（M1/M2 路径）`)
console.log(`  character_states             : ${states ?? '(无表)'}   ← 情绪/关系快照（M2 路径）`)
console.log(`  conversation_events          : ${events ?? '(无表)'}   ← M2.5 事实账本`)
console.log(`  character_domain_events      : ${domainEvents ?? '(无表)'}   ← M2.5 变化历史`)
console.log(`  character_projections        : ${projections ?? '(无表)'}`)
console.log(`  character_traces             : ${traces ?? '(无表)'}`)

if ((messages ?? 0) > 0) {
  const recent = rowsOf(
    await db.execute(
      sql`select content, created_at from memories where type = 'messages' order by created_at desc limit 3`,
    ),
  )
  console.log(`\n  最近 3 条消息（时间 + 前 40 字）：`)
  for (const row of recent.reverse()) {
    const text = String((row.content as { text?: string })?.text ?? '').replace(/\n/g, ' / ')
    console.log(
      `    [${new Date(Number(row.created_at)).toLocaleString('zh-CN', { hour12: false })}] ${text.slice(0, 40)}`,
    )
  }
}

console.log(`\n=== 3. 结论 ===`)
if (missing.length > 0) {
  console.log('  生产库还没有 kernel 表 → M3 开始时需要先运行一次主程序完成迁移。')
} else if ((events ?? 0) === 0) {
  console.log('  ✅ schema 已就位，但事实账本为空 → M2.5 之后还没有真实对话写过账本。')
  console.log('     进入 M3 前建议先正常聊几轮，让新链路产生真实数据。')
} else {
  console.log('  ✅ schema 就位且有真实数据 → M3 可以直接在已有历史上工作。')
}

await runtime.stop()
rmSync(copyDir, { recursive: true, force: true })
console.log(`\n（副本已清理：${copyDir}）`)
process.exit(0)

void statSync
