/**
 * WP7 的**核心探针**：在**生产 PG 库**上起一次真核心，验证"单一后端切换"真的成立。
 *
 * 它**只读**：起核心 → 读几个真实读数（事件数 / 投影数 / 记忆数）→ 关库 → 退出。
 * **不跑对话、不写任何东西**（除了内核启动自身可能写的水位/投影 —— 见下）。
 *
 * ⚠️ 为什么要有它：`.env` 改完不算"切换成功"。**切换成功的判据是"核心真的能连上它、
 *    身份核对真的通过、真的读得到迁移过来的数据"** —— 这三件事只有起一次核心才知道。
 *
 * ⚠️ 身份核对是硬闸：`LG_PG_EXPECT_DATABASE` 不匹配 ⇒ 核心**失败关闭**（这是保护）。
 *
 * 跑法（由 `postgresql:cutover:apply --switch-config` 调用）：
 *   pnpm tsx scripts/postgresql-cutover-probe.ts --db lg_prod
 */
import 'dotenv/config'

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Character } from '@elizaos/core'
import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { closeDatabaseConnection } from '../src/infrastructure/persistence/runtime-shutdown.ts'

import { PG_HOST_PORT, loadPgCredentials } from './postgresql/credentials.ts'
import { psql } from './postgresql/pg-exec.ts'

const dbArgIndex = process.argv.indexOf('--db')
const targetDb = dbArgIndex >= 0 ? (process.argv[dbArgIndex + 1] ?? '') : ''
if (targetDb === '') {
  console.error('拒绝：必须给 --db <生产库名>')
  process.exit(2)
}

const credentials = loadPgCredentials()
if (credentials === undefined) {
  console.error('拒绝：凭据文件不存在')
  process.exit(2)
}
/*
 * ⓑ（用户 2026-10-13 裁定）：核心以 **`lg_migrate`** 运行 —— 与十道门起核心时同一个账号。
 * 理由：plugin-sql 的启动期 DDL 级联（CREATE SCHEMA → CREATE TABLE → SELECT 迁移账本 →
 * kernel 的 `create table character_schema_migrations`）在受限运行账号上**无有限最小授权集**。
 */
const password = credentials.LG_PG_MIGRATE_PASSWORD
const url = `postgresql://lg_migrate:${encodeURIComponent(password)}@127.0.0.1:${PG_HOST_PORT}/${targetDb}`

/*
 * ⚠️ 生产库**不是** `lg_test_*` ⇒ 不能用 `isolateDatabase`（它的判据要求测试前缀）。
 *    但**纵深防御照旧**：把 `PGLITE_DATA_DIR` 指到一个临时目录 —— 万一适配器回退成 PGlite，
 *    它也只能开那个空目录，**碰不到真实库**（`PG-ISO-01` 的教训）。
 */
process.env.CHARACTER_DB_BACKEND = 'postgres'
process.env.LG_PG_EXPECT_DATABASE = targetDb
const fallbackDir = resolve(process.env.TEMP ?? '.', `lg-cutover-probe-fallback-${Date.now().toString(36)}`)
mkdirSync(fallbackDir, { recursive: true })
process.env.PGLITE_DATA_DIR = fallbackDir

const runtime = new AgentRuntime({
  character: character as Character,
  plugins: [],
  settings: { POSTGRES_URL: url },
})

let ok = false
let reason: string | undefined
const readings: Record<string, unknown> = {}

try {
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character) })
  const characterId = kernel.characterId
  const events = await domainEventsFor(kernel.stores.db, characterId)

  const raw = (sqlText: string): string =>
    psql({ container: 'lg-postgresql-trial', user: 'lg_migrate', password: credentials.LG_PG_MIGRATE_PASSWORD, database: targetDb, sql: sqlText }).out

  readings.characterId = String(characterId)
  readings.domainEventsViaKernel = events.length
  readings.conversationEvents = Number(raw('select count(*) from conversation_events'))
  readings.characterProjections = Number(raw('select count(*) from character_projections'))
  readings.memoryRecords = Number(raw('select count(*) from memory_records'))
  readings.currentDatabase = raw('select current_database()')

  ok =
    Number(readings.conversationEvents) > 0 &&
    Number(readings.characterProjections) > 0 &&
    readings.currentDatabase === targetDb
  reason = ok ? undefined : `读数不满足：${JSON.stringify(readings)}`

  await closeDatabaseConnection(runtime)
} catch (error) {
  reason = error instanceof Error ? error.message : String(error)
}

console.log(JSON.stringify({ ok, reason, targetDb, readings }, null, 2))
process.exit(ok ? 0 : 1)
