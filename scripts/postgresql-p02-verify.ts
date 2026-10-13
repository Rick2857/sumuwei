/**
 * PostgreSQL 迁移 **WP8 / `PG-P02` 生产使用**（真核心 · 真生产库 · 真配置路径）。
 *
 * 契约逐字：`真实往返、实际 trace/事件、在线只读和备份、正常重启；未观测的功能明确 NOT OBSERVED`
 *
 * ============================================================================
 *  它与 `PG-G04…G10` 的根本区别
 * ============================================================================
 * ```text
 * G 系列：对着**一次性隔离测试库**（lg_test_*）跑，判据是"迁移做对了没有"。
 * P02   ：对着**已经切过去的生产库**（`sumuwei`）跑，判据是"**切过去之后它真的能用**"：
 *          · 用 **`.env` 里那套真实配置**起核心（不是我另拼一个 URL）
 *          · 核心**附着**的同时做在线只读与在线备份
 *          · **重启核心**，而数据库**一次都没重启**（用 `pg_postmaster_start_time()` 证）
 * ```
 *
 *  ⚠️ **本门不主张"真实对话轮已验证"**：那需要 QQ / 皮套外壳或 TurnGateway 的完整装配。
 *     本门做到的是"**内核层真实往返**"（真事件真投影读写 + 真 trace 行），
 *     并把"真实对话轮"**明确记为 `NOT OBSERVED`** —— 计划逐字："未观测的功能明确 NOT OBSERVED"。
 *
 * 跑法：pnpm postgresql:p02:verify
 */
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Character } from '@elizaos/core'
import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { closeDatabaseConnection } from '../src/infrastructure/persistence/runtime-shutdown.ts'

import { PG_CONTAINER, PG_CREDENTIALS_FILE, loadPgCredentials, missingCredentialKeys } from './postgresql/credentials.ts'
import { psql } from './postgresql/pg-exec.ts'
import { productionDirFingerprint } from './postgresql/production-fingerprint.ts'

const CONTAINER = PG_CONTAINER
const LOCAL_DIR = resolve('artifacts/post-lv2/local/pg-migration')
const ONLINE_BACKUP = resolve(LOCAL_DIR, 'p02-online-backup.sql')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const OUT_DIR = resolve(`artifacts/post-lv2/postgresql-migration/pg-migration-p02-${stamp}`)

const checks: { name: string; pass: boolean; detail?: string }[] = []
const notObserved: { item: string; why: string; howToObserve: string }[] = []
const observations: Record<string, unknown> = {}

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

/** `.env` 里的真实配置（**不**另拼 URL —— 那正是本门要验的东西） */
function envConfig(): { backend: string; url: string; expectDb: string; pgliteDir: string } {
  const text = readFileSync(resolve('.env'), 'utf8')
  const get = (key: string): string => new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(text)?.[1]?.trim() ?? ''
  return {
    backend: get('CHARACTER_DB_BACKEND'),
    url: get('POSTGRES_URL'),
    expectDb: get('LG_PG_EXPECT_DATABASE'),
    pgliteDir: get('PGLITE_DATA_DIR'),
  }
}

const redact = (url: string): string => url.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@')

/**
 * ⚠️ **必须播种 settings**（本门第一版的缺陷，也是 `PG-ISO-01` 的第二次踩到）：
 *    plugin-sql 的适配器创建读的是 `runtime.getSetting('POSTGRES_URL')`，它**不回落** `process.env`
 *    ⇒ 传 `settings: runtimeSettings()` 会让它回退成 **PGlite 适配器**、去开 `PGLITE_DATA_DIR`（= **真实库**），
 *      然后被身份核对拒（`期望 sumuwei，实际 template1`）—— **在拒绝之前已经碰过真实库**。
 *
 *    ⇒ 这里**镜像 `src/main.ts` 的播种逻辑**（那几行是生产入口的唯一权威）。
 *      ⚠️ 本门因此**不能**替代"真外壳跑一轮"：它验的是"env→settings→插件→生产库"这条链，
 *      而"`main.ts` 自己的播种写得对不对"只能靠真跑 `pnpm chat`（那条**保留为 NOT OBSERVED**）。
 */
function runtimeSettings(): Record<string, string> {
  return {
    ...(process.env.POSTGRES_URL ? { POSTGRES_URL: process.env.POSTGRES_URL } : {}),
    ...(process.env.CHARACTER_DB_BACKEND ? { CHARACTER_DB_BACKEND: process.env.CHARACTER_DB_BACKEND } : {}),
    ...(process.env.PGLITE_DATA_DIR ? { PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR } : {}),
    ...(process.env.PGLITE_SNAPSHOT_DIR ? { PGLITE_SNAPSHOT_DIR: process.env.PGLITE_SNAPSHOT_DIR } : {}),
    ...(process.env.LG_PG_EXPECT_DATABASE ? { LG_PG_EXPECT_DATABASE: process.env.LG_PG_EXPECT_DATABASE } : {}),
    ...(process.env.LG_PG_EXPECT_DATABASE_PREFIX
      ? { LG_PG_EXPECT_DATABASE_PREFIX: process.env.LG_PG_EXPECT_DATABASE_PREFIX }
      : {}),
  }
}

async function main(): Promise<void> {
  mkdirSync(LOCAL_DIR, { recursive: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const productionBefore = productionDirFingerprint()

  const config = envConfig()
  const dbName = ((): string => {
    try {
      return new URL(config.url).pathname.replace(/^\//, '')
    } catch {
      return ''
    }
  })()
  observations.envConfig = { backend: config.backend, url: redact(config.url), expectDb: config.expectDb, pgliteDir: config.pgliteDir, parsedDb: dbName }

  check('P02.1 ★ 生产配置在 `.env` 里：后端 = postgres，且 URL 指向生产库', () => {
    if (config.backend !== 'postgres') throw new Error(`CHARACTER_DB_BACKEND = ${config.backend || '(空)'}`)
    if (dbName === '') throw new Error(`POSTGRES_URL 解析不出库名：${redact(config.url)}`)
    if (dbName.startsWith('lg_test_')) throw new Error(`指向的是测试库：${dbName}`)
    if (config.expectDb !== dbName) throw new Error(`LG_PG_EXPECT_DATABASE(${config.expectDb}) ≠ URL 里的库(${dbName})`)
    if (config.pgliteDir === '') throw new Error('PGLITE_DATA_DIR 不见了 ⇒ 回滚锚点丢了')
  })

  const credentials = loadPgCredentials()
  if (credentials === undefined || missingCredentialKeys(credentials).length > 0) {
    notObserved.push({
      item: 'PG-P02 全部判据',
      why: `凭据不可用（${PG_CREDENTIALS_FILE}）`,
      howToObserve: '修好凭据文件后重跑本门',
    })
  } else {
    const readOnly = (sqlText: string): { rc: number; out: string } => {
      const r = psql({
        container: CONTAINER,
        user: 'lg_readonly',
        password: credentials.LG_PG_READONLY_PASSWORD,
        database: dbName,
        sql: sqlText,
        timeoutMs: 300_000,
      })
      return { rc: r.rc, out: r.out }
    }
    const asMigrate = (sqlText: string): string =>
      psql({ container: CONTAINER, user: 'lg_migrate', password: credentials.LG_PG_MIGRATE_PASSWORD, database: dbName, sql: sqlText, timeoutMs: 300_000 }).out

    const startTimeBefore = asMigrate('select pg_postmaster_start_time()::text')
    const containerBefore = spawnSync('docker', ['ps', '--filter', `name=${CONTAINER}`, '--format', '{{.Status}}'], { encoding: 'utf8', timeout: 30_000 }).stdout?.trim() ?? ''
    observations.postmasterStartTimeBefore = startTimeBefore
    observations.containerBefore = containerBefore

    let runtime: AgentRuntime | undefined
    let kernelReadings: Record<string, unknown> = {}
    try {
      // ---- 起真核心：**用 .env 里那套配置**（`initDatabase` 自己会读它）----
      const created = new AgentRuntime({ character: character as Character, plugins: [], settings: runtimeSettings() })
      runtime = created
      await initDatabase(created, sqlPlugin)
      await created.initialize()
      const kernel = await initKernel(created, { definition: characterDefinitionFromCharacter(character) })

      check('P02.2 ★ 用 `.env` 的真实配置起得来（后端 postgres · 身份核对通过）', () => {
        if (kernel.characterId === undefined) throw new Error('内核没有 characterId')
      })

      // ---- 核心**附着**的同时：在线只读 ----
      const onlineRead = readOnly('select count(*) from conversation_events')
      const projections = readOnly('select count(*) from character_projections')

      check('P02.3 ★ 在线只读（核心附着时，`lg_readonly` 账号读得到）：会话事件与投影', () => {
        if (onlineRead.rc !== 0) throw new Error(`只读账号查询失败：${onlineRead.out.slice(0, 200)}`)
        if (Number(onlineRead.out) <= 0) throw new Error(`会话事件数为 ${onlineRead.out}`)
        if (projections.rc !== 0 || Number(projections.out) <= 0) throw new Error(`投影读数异常：${projections.out}`)
      })

      // ---- 内核层**真实往返**：用真 store 读事件（真 trace 面的载体）----
      const events = await domainEventsFor(kernel.stores.db, kernel.characterId)
      kernelReadings = {
        characterId: String(kernel.characterId),
        domainEventsViaKernel: events.length,
        conversationEvents: Number(onlineRead.out),
        characterProjections: Number(projections.out),
        newestEventType: events.length > 0 ? String(events[events.length - 1]?.type ?? '') : null,
      }
      observations.kernel = kernelReadings

      check('P02.4 ★ 实际事件（内核层真实往返）：真 store 读得到事件，且条数 > 0', () => {
        if (events.length <= 0) throw new Error('内核一条事件都没读到')
      })

      // ---- 核心**附着**的同时：在线备份 ----
      const backupStarted = Date.now()
      const dump = spawnSync(
        'docker',
        ['exec', '-e', 'PGPASSWORD', CONTAINER, 'pg_dump', '-h', '127.0.0.1', '-U', 'lg_migrate', '-d', dbName, '--no-comments'],
        { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout: 900_000 }
      )
      const backupMs = Date.now() - backupStarted
      const backupBytes = (dump.stdout as Buffer | null)?.length ?? 0
      if (dump.status === 0 && backupBytes > 0) writeFileSync(ONLINE_BACKUP, dump.stdout as Buffer)
      observations.onlineBackup = {
        exitCode: dump.status ?? -1,
        bytes: backupBytes,
        milliseconds: backupMs,
        file: ONLINE_BACKUP,
        stderr: (dump.stderr as Buffer | null)?.toString('utf8').slice(0, 200) ?? '',
      }

      check('P02.5 ★ 在线备份（核心附着时 `pg_dump` exit 0 且非空）', () => {
        if ((dump.status ?? -1) !== 0) throw new Error(`pg_dump 退出码 ${String(dump.status)}`)
        if (backupBytes < 1_000_000) throw new Error(`备份只有 ${backupBytes} B`)
      })

      // ---- 正常重启：关核心 ----
      await closeDatabaseConnection(created)
      runtime = undefined
    } catch (error) {
      checks.push({ name: 'P02.§ 起核心/在线段意外中断', pass: false, detail: error instanceof Error ? (error.stack ?? error.message) : String(error) })
    } finally {
      if (runtime !== undefined) {
        try {
          await closeDatabaseConnection(runtime)
        } catch {
          /* 尽力关 */
        }
      }
    }

    // ---- **重启核心**：数据库一次都没重启 ----
    let secondBootFailed: string | undefined
    try {
      const again = new AgentRuntime({ character: character as Character, plugins: [], settings: runtimeSettings() })
      runtime = again
      await initDatabase(again, sqlPlugin)
      await again.initialize()
      const kernel2 = await initKernel(again, { definition: characterDefinitionFromCharacter(character) })
      const events2 = await domainEventsFor(kernel2.stores.db, kernel2.characterId)
      observations.secondBoot = { characterId: String(kernel2.characterId), domainEventsViaKernel: events2.length }
      await closeDatabaseConnection(again)
      runtime = undefined
    } catch (error) {
      secondBootFailed = error instanceof Error ? error.message : String(error)
    }

    const startTimeAfter = asMigrate('select pg_postmaster_start_time()::text')
    const containerAfter = spawnSync('docker', ['ps', '--filter', `name=${CONTAINER}`, '--format', '{{.Status}}'], { encoding: 'utf8', timeout: 30_000 }).stdout?.trim() ?? ''
    observations.postmasterStartTimeAfter = startTimeAfter
    observations.containerAfter = containerAfter

    check('P02.6 ★ 正常重启：核心**重启后**仍能连上并读到事件', () => {
      if (secondBootFailed !== undefined) throw new Error(`第二次起核心失败：${secondBootFailed}`)
    })

    check('P02.7 ★★ 核心重启**没有停止数据库**：`pg_postmaster_start_time()` 前后**逐字相同**', () => {
      if (startTimeAfter.trim() === '' || startTimeBefore.trim() === '') throw new Error('没读到 postmaster 启动时刻')
      if (startTimeAfter.trim() !== startTimeBefore.trim()) {
        throw new Error(`数据库被重启过：${startTimeBefore.trim()} → ${startTimeAfter.trim()}`)
      }
      if (!/healthy/.test(containerAfter)) throw new Error(`容器重启后不是 healthy：${containerAfter}`)
    })

    const productionAfter = productionDirFingerprint()
    observations.productionDir = { before: productionBefore, after: productionAfter }
    check('P02.8 ★★ 真实库目录**逐字未动**（生产用 PG，PGlite 那份只是回滚锚点）', () => {
      if (productionAfter.files !== productionBefore.files) throw new Error('真实库文件数变了')
      if (productionAfter.digest !== productionBefore.digest) throw new Error('真实库 (路径,大小) 摘要变了')
      if (productionAfter.newestMtimeMs !== productionBefore.newestMtimeMs) throw new Error('真实库有文件被写过')
    })
  }

  // ---------------------------------------------------------------------
  // **未观测项**（计划逐字：未观测的功能明确 NOT OBSERVED）
  // ---------------------------------------------------------------------
  notObserved.push({
    item: '真实对话轮（QQ / 皮套外壳走一轮真实聊天）',
    why:
      '本门只做**内核层**的真实往返（真事件/真投影/真 trace 行）；' +
      '真实对话轮需要 QQ 或皮套外壳（`pnpm chat` / `pnpm coexist:start`）的完整装配，本门不起外壳',
    howToObserve: '起外壳（`pnpm chat` 或 `pnpm coexist:start`）说一句，再看 PG 里新增的会话事件与 trace',
  })
  notObserved.push({
    item: '在线备份期间的真实并发写入',
    why: '本门只证"核心附着时备份能成功"；没有制造并发写入（那需要外壳持续产生轮次）',
    howToObserve: '外壳跑着的时候做一次 `pg_dump`，比对备份内的行数与备份后读数的关系',
  })
  notObserved.push({
    item: '补丁升级操作（PG 小版本升级 / 扩展升级）',
    why: '计划把 PITR/WAL 与异地备份划到第二阶段；小版本升级与扩展升级的操作未演练',
    howToObserve: '在隔离实例上演练一次镜像升级 + 数据读回，再写进维护手册',
  })

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const record = {
    gate: 'postgresql:p02:verify',
    scope: 'PG-P02 生产使用（真核心 · 真生产库 · 真配置路径：在线只读/备份 · 内核真实往返 · 正常重启）',
    atUtc: new Date().toISOString(),
    atUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    head: (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim(),
    productionDb: observations.envConfig,
    checks,
    notObserved,
    observations,
    counts: { measured: checks.length, passed, failed, notObserved: notObserved.length },
  }
  writeFileSync(resolve(OUT_DIR, 'p02-evidence.json'), JSON.stringify(record, null, 2), 'utf8')
  JSON.parse(readFileSync(resolve(OUT_DIR, 'p02-evidence.json'), 'utf8'))

  console.log('')
  console.log('PG-P02 生产使用（真核心 · 真生产库 · 真配置路径）')
  console.log('─'.repeat(86))
  console.log(`  配置   : ${JSON.stringify(observations.envConfig)}`)
  console.log(`  证据   : ${OUT_DIR.replace(`${process.cwd()}\\`, '')}`)
  console.log('─'.repeat(86))
  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (!c.pass && c.detail !== undefined) console.log(`        └─ ${c.detail}`)
  }
  console.log('─'.repeat(86))
  console.log(`  内核读数 : ${JSON.stringify(observations.kernel ?? {})}`)
  console.log(`  在线备份 : ${JSON.stringify(observations.onlineBackup ?? {})}`)
  console.log(`  DB 启动时刻 : ${String(observations.postmasterStartTimeBefore)} → ${String(observations.postmasterStartTimeAfter)}`)
  console.log('─'.repeat(86))
  console.log(`  断言        : ${passed}/${checks.length}`)
  console.log(`  NOT OBSERVED: ${notObserved.length}`)
  for (const n of notObserved) console.log(`      · ${n.item}（${n.howToObserve}）`)
  console.log(`  measured_count = ${checks.length}`)
  console.log(`  失败总数 = ${failed}`)
  console.log('')

  if (checks.length === 0) {
    console.error('measured_count = 0 ⇒ INVALID（不得当绿用）')
    process.exitCode = 1
  } else if (failed > 0) {
    process.exitCode = 1
  } else if (notObserved.length > 0) {
    // ⚠️ 与其它门不同：NOT OBSERVED **不**让本门非零退出 —— 计划逐字要求"未观测项保留"，
    //    而不是"没观测到就不许过"。但报告里必须**醒目**列出来（上面已列）。
    console.log(`ℹ️ ${notObserved.length} 项 NOT OBSERVED（计划逐字：保留，不当作已验证）—— 已列在上方与证据里。`)
  }
}

await main()
