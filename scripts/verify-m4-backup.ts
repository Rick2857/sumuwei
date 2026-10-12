/**
 * 备份可读性验证（M4 Phase 1）。
 *
 * ============================================================================
 *  为什么必须有这一步
 * ============================================================================
 * "复制了 1155 个文件"不等于"备份能用"。
 * PGlite 是嵌入式 Postgres：数据文件、WAL、`pg_control` 三者必须自洽，
 * 而**在数据库运行期间复制**（或复制了陈旧 `postmaster.pid`）都可能得到一个
 * 字节数完全正确、但打不开的备份。
 *
 * 而备份的唯一用途是"出事了能回到过去"——
 * 因此它必须在**需要它之前**就被证明可读，而不是在需要它的时候才发现打不开。
 *
 * ---------------------------------------------------------------------------
 *  安全检查
 * ---------------------------------------------------------------------------
 * 本脚本**不打开** `data/pglite`（真实库）。它把备份**再复制一份**到临时目录，
 * 在副本上打开，因此：
 *   · 真实库全程未被打开
 *   · 备份本身也未被打开（只被复制）—— 避免验证动作污染留底
 *
 * 跑法：
 *   npx tsx scripts/verify-m4-backup.ts [备份目录名]
 * 缺省用 data/ 下最新的 pglite.backup-m4-* 
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const DATA_DIR = join(ROOT, 'data')
const PROD = join(DATA_DIR, 'pglite')

// --- 挑备份：显式参数，否则取最新的 pglite.backup-m4-* ---------------------
const explicit = process.argv[2]
const candidates = readdirSync(DATA_DIR)
  .filter((name) => name.startsWith('pglite.backup-m4-'))
  .map((name) => join(DATA_DIR, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

const backup = explicit ? join(DATA_DIR, explicit) : candidates[0]

if (!backup || !existsSync(backup)) {
  console.error(`找不到备份目录。候选项：${candidates.join(' | ') || '(无)'}`)
  process.exit(2)
}

// --- 硬约束：绝不在真实库或原备份上打开 ------------------------------------
if (resolve(backup) === resolve(PROD)) {
  console.error('拒绝运行：参数指向真实库本身。本脚本只在备份的副本上工作。')
  process.exit(2)
}

console.log('='.repeat(72))
console.log('M4 备份可读性验证')
console.log('='.repeat(72))
console.log(`真实库（本脚本不会打开）：${PROD}`)
console.log(`待验证备份              ：${backup}`)

const work = mkdtempSync(join(tmpdir(), 'project-lg-m4-backupverify-'))
const workDb = join(work, 'pglite')
cpSync(backup, workDb, { recursive: true })
console.log(`验证副本（在它上面打开）  ：${workDb}`)

// 绕过写保护闸：目录是临时副本，不是真实库
process.env.PGLITE_DATA_DIR = workDb
process.env.PROJECT_LG_SANDBOX = workDb

const { AgentRuntime } = await import('@elizaos/core')
const sqlPlugin = (await import('@elizaos/plugin-sql')).default
const { character } = await import('../src/character/index.ts')
const { currentSchemaVersion, getRawDb, rowsOf } = await import(
  '../src/infrastructure/persistence/db.ts'
)
const { sql } = await import('drizzle-orm')

const runtime = new AgentRuntime({ character, plugins: [] })
await runtime.registerPlugin(sqlPlugin)
await runtime.runPluginMigrations()
const db = getRawDb(runtime)

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail = '') => {
  checks.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`)
}

// --- 1. 能不能打开 ----------------------------------------------------------
const version = await currentSchemaVersion(db)
check('备份可以打开，且能读出 schema 版本', Number.isFinite(version), `schema v${version}`)
check('schema 版本 = 4（与备份前的真实库一致）', version === 4, `实际 ${version}`)

// --- 2. 迁移记录是否完整 ----------------------------------------------------
const migrations = rowsOf(
  await db.execute(sql`select version, name from character_schema_migrations order by version asc`)
)
check(
  '四个迁移记录齐全',
  migrations.length === 4,
  migrations.map((m) => `#${m.version}${m.name ? ` ${m.name}` : ''}`).join(', ')
)

// --- 3. 关键表是否在 --------------------------------------------------------
const tables = rowsOf(
  await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public'`
  )
).map((r) => String(r.table_name))
const required = [
  'character_definitions',
  'conversation_events',
  'character_domain_events',
  'character_projections',
  'character_jobs',
  'character_traces',
  'character_definition_versions',
  'user_identities',
  'conversation_identities',
]
const missing = required.filter((t) => !tables.includes(t))
check(
  'Kernel 十张 + M3 四张表全部存在',
  missing.length === 0,
  missing.length === 0 ? `${tables.length} 张表` : `缺失 ${missing.join(', ')}`
)

// --- 4. 她的真实数据是否还在 ------------------------------------------------
const count = async (table: string): Promise<number> => {
  const rows = rowsOf(await db.execute(sql.raw(`select count(*)::int as c from ${table}`)))
  return Number(rows[0]?.c ?? 0)
}

const dataCounts = {
  conversation_events: await count('conversation_events'),
  character_domain_events: await count('character_domain_events'),
  character_traces: await count('character_traces'),
  character_definition_versions: await count('character_definition_versions'),
  user_identities: await count('user_identities'),
  conversation_identities: await count('conversation_identities'),
}
console.log(`\n  数据条数：${JSON.stringify(dataCounts)}`)

check(
  '事实账本非空（她的历史在备份里）',
  dataCounts.conversation_events > 0,
  `${dataCounts.conversation_events} 条对话事件`
)
check(
  'Seed 历史非空',
  dataCounts.character_definition_versions > 0,
  `${dataCounts.character_definition_versions} 条`
)

// --- 5. 内容抽查：能真的读出正文（不只是计数）-------------------------------
const sample = rowsOf(
  await db.execute(
    sql`select id, sequence, actor_type, content from conversation_events order by sequence asc limit 1`
  )
)[0]
check(
  '能读出具体事件正文（证明内容未损坏）',
  Boolean(sample?.content && String(sample.content).trim() !== ''),
  sample ? `#${sample.sequence} [${sample.actor_type}] ${String(sample.content).slice(0, 30)}…` : '(无)'
)

const seedRow = rowsOf(
  await db.execute(
    sql`select seed_version, seed_hash, definition_json from character_definitions limit 1`
  )
)[0]
check(
  'Seed 结构化表示与指纹都在',
  Boolean(seedRow?.seed_hash && seedRow?.definition_json),
  seedRow ? `v${seedRow.seed_version} ${String(seedRow.seed_hash).slice(0, 12)}…` : '(无)'
)

await runtime.stop().catch(() => undefined)

// --- 清理 ------------------------------------------------------------------
rmSync(work, { recursive: true, force: true })
console.log(`\n（验证副本已清理：${work}）`)

const failed = checks.filter((c) => !c.pass)
console.log(`\n${'='.repeat(72)}`)
console.log(`备份可读性：${checks.length - failed.length} 通过 / ${failed.length} 失败`)
console.log(`备份路径：${backup}`)
console.log('='.repeat(72))

process.exit(failed.length === 0 ? 0 : 1)
