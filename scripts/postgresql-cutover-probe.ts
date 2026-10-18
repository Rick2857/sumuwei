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

import { spawnSync } from 'node:child_process'
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

/**
 * ⚠️ **容器名不许硬编码**（2026-10-14 实测修）。
 *
 * ```text
 * 事实：生产端口 55432 今天由 `lg-postgresql-production`（卷 `lg-postgresql-production-20261014`）持有；
 *      而 WP7 记录当时的目标容器是 `lg-postgresql-trial`（卷 `lg-postgresql-data`，现为**停止**状态）。
 * 症状：硬编码 trial ⇒ 本探针的三个 `raw()` 读数落在**另一个实例**上
 *      （实测 `conversationEvents=0` / `characterProjections=0` / `currentDatabase=""`）
 *      ⇒ `ok:false` 是**读数打错实例**，**不是**数据缺失：
 *      同一时刻在端口持有者上直接 SQL 读到 conversation_events=550 / character_projections=29 /
 *      character_domain_events=473，且内核经适配器读到 **473** 条领域事件。
 * ⇒ 判据改为"**谁发布这个端口就用谁**"，并留 `LG_PG_CONTAINER` 显式覆盖口。
 * ```
 */
const resolvePgContainer = (): string => {
  const explicit = process.env.LG_PG_CONTAINER?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const listed = spawnSync('docker', ['ps', '--filter', `publish=${PG_HOST_PORT}`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  const name = (listed.stdout ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')[0]
  if (name === undefined) {
    console.error(
      `拒绝：没有任何运行中的容器发布端口 ${PG_HOST_PORT}（生产 PG 没起来，或它跑在别处）。\n` +
        '  显式指定：设 LG_PG_CONTAINER=<容器名> 再跑。'
    )
    process.exit(2)
  }
  return name
}
const pgContainer = resolvePgContainer()

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
    psql({ container: pgContainer, user: 'lg_migrate', password: credentials.LG_PG_MIGRATE_PASSWORD, database: targetDb, sql: sqlText }).out

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
