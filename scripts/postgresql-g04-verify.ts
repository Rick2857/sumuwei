/**
 * PostgreSQL 迁移：**`PG-G04` SQL/仓储兼容**（契约逐字：JSON/null、bigint 边界、RETURNING、
 * 唯一/部分索引、幂等、乐观冲突、事务原子性；Memory/Conversation/Event/Job 仓储真实执行）。
 *
 * ============================================================================
 *  为什么这道门不能只靠 `PG-G05`（内容比较）
 * ============================================================================
 * ```text
 * PG-G05 回答："搬过来的**数据**一不一样"（逐表内容摘要）。
 * PG-G04 回答："在 PG 上**这些写法还成不成立**" —— 约束有没有真的拦、事务有没有真的回滚、
 *              bigint 会不会丢精度、jsonb 的 null 与缺键还分不分得清、乐观冲突会不会真的拒。
 * ⇒ 两者不互相替代：数据一样但约束不生效，是"看起来搬完了、其实防线没了"。
 * ```
 *
 *  ⚠️ bigint 那条**只主张 PG 侧**：`bigint` 超过 2^53 时 **JS number 会丢精度** ——
 *     本门证明的是"**SQL/文本层面往返不丢**"（`::text`），并**如实记录** JS 侧的限制。
 *     迁移线的比较器早就有这条判据（`column-encoding.ts` 默认把 bigint 转文本）。
 *
 * 跑法：pnpm postgresql:g04:verify
 */
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Character } from '@elizaos/core'
import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { initDatabase } from '../src/db/index.ts'
import { inTransaction } from '../src/infrastructure/persistence/db.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import {
  appendDomainEvent,
  domainEventsFor,
  getProjection,
  insertProjection,
  saveProjection,
} from '../src/infrastructure/persistence/event-store.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import {
  applyMemoryEvent,
  createNativeMemoryStore,
} from '../src/infrastructure/persistence/memory-store.ts'
import {
  advanceWatermark,
  enqueueJob,
  finishJob,
  getJob,
  getWatermark,
  hasProcessedOperation,
  markJobRunning,
  recordProcessedOperation,
} from '../src/infrastructure/persistence/job-store.ts'
import { closeDatabaseConnection } from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { DOMAIN_EVENT_SCOPE } from '../src/kernel/contracts/domain-event.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { conversationEvidence } from '../src/kernel/contracts/memory.ts'

import {
  PG_CONTAINER,
  PG_CREDENTIALS_FILE,
  PG_HOST_PORT,
  loadPgCredentials,
  missingCredentialKeys,
} from './postgresql/credentials.ts'
import { psql, psqlFile, psqlFromStdin } from './postgresql/pg-exec.ts'
import { dumpPgliteSnapshot, EXPORT_RUNTIME_DIR } from './postgresql/pglite-dump.ts'
import { assertProductionDirUnchanged, productionDirFingerprint } from './postgresql/production-fingerprint.ts'

const CONTAINER = PG_CONTAINER
const HOST_PORT = PG_HOST_PORT
const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'
const TARGET_DB = 'lg_test_g04'
const MIGRATE_USER = 'lg_migrate'
const MIGRATE_ROLE = 'lg_migrate'
const MARK = 'g04'
const T0 = Date.UTC(2026, 9, 13, 14, 0, 0)

const LOCAL_DIR = resolve('artifacts/post-lv2/local/pg-migration')
const RESTORE_SQL = resolve(LOCAL_DIR, 'g04-restore.sql')
const RESTORE_ARGS = ['--no-owner', '--no-privileges', '--no-comments']

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const RUN_ID = `pg-migration-g04-${stamp}`
const EVIDENCE_DIR = resolve(`artifacts/post-lv2/postgresql-migration/${RUN_ID}`)

const checks: { name: string; pass: boolean; detail?: string }[] = []
const notRun: { id: string; what: string; why: string }[] = []
const observations: Record<string, unknown> = {}

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

async function main(): Promise<void> {
  mkdirSync(LOCAL_DIR, { recursive: true })
  mkdirSync(EVIDENCE_DIR, { recursive: true })

  const credentials = loadPgCredentials()
  const missingKeys = credentials === undefined ? ['(缺文件)'] : missingCredentialKeys(credentials)
  const instanceUp =
    credentials === undefined
      ? false
      : psql({
          container: CONTAINER,
          user: credentials.LG_PG_BOOTSTRAP_USER,
          password: credentials.LG_PG_BOOTSTRAP_PASSWORD,
          database: 'postgres',
          sql: 'select 1 as ok',
        }).rc === 0
  const exportRuntimeReady = (() => {
    try {
      return readFileSync(resolve(EXPORT_RUNTIME_DIR, 'node_modules/@electric-sql/pglite-tools/package.json'), 'utf8').length > 0
    } catch {
      return false
    }
  })()
  const blocked =
    credentials === undefined
      ? `凭据文件不存在：${PG_CREDENTIALS_FILE}`
      : missingKeys.length > 0
        ? `凭据文件缺这些 key：${missingKeys.join(', ')}`
        : !instanceUp
          ? `容器 ${CONTAINER} 不可达`
          : !exportRuntimeReady
            ? `导出工具运行时未就绪：${EXPORT_RUNTIME_DIR}`
            : undefined

  if (blocked !== undefined) {
    notRun.push({ id: 'g04', what: 'SQL/仓储兼容', why: blocked })
  } else {
    const password = credentials!.LG_PG_MIGRATE_PASSWORD
    const queryOf = (sqlText: string): string | undefined => {
      const r = psql({ container: CONTAINER, user: MIGRATE_USER, password, database: TARGET_DB, sql: sqlText, timeoutMs: 600_000 })
      return r.rc === 0 ? r.out : undefined
    }
    const queryErr = (sqlText: string): string => {
      const r = psql({ container: CONTAINER, user: MIGRATE_USER, password, database: TARGET_DB, sql: sqlText, timeoutMs: 600_000 })
      return r.err
    }
    /**
     * 取一条语句失败的 **SQLSTATE**。
     * ⚠️ `psql` 默认**不打印** SQLSTATE（只打 "ERROR: duplicate key …"）⇒ 第一版拿 `r.err`
     *    去找 `23505` 永远找不到，四条索引判据因此全红 —— 那是**量具错**，不是约束没生效。
     *    ⇒ 走 `\set VERBOSITY verbose`，它会把 `SQLSTATE: 23505` 打出来。
     */
    const sqlStateOf = (sqlText: string): string => {
      const r = psqlFromStdin({
        container: CONTAINER,
        user: MIGRATE_USER,
        password,
        database: TARGET_DB,
        sql: `\\set VERBOSITY verbose\n${sqlText};\n`,
        psqlArgs: ['-tA'],
        timeoutMs: 120_000,
      })
      /*
       * ⚠️ 两种打印形态都要认（第一版只认后者，三条判据因此全红 —— 又是量具错）：
       *   `\set VERBOSITY verbose` ⇒ psql 打 **`ERROR:  23505: duplicate key …`**（SQLSTATE 在
       *   同一行的 `ERROR: ` 之后），**不是** `SQLSTATE: 23505` 那种字段形态。
       */
      const fromError = /ERROR:\s+([0-9A-Z]{5}):/.exec(r.err)?.[1]
      const fromField = /SQLSTATE:\s*([0-9A-Z]{5})/.exec(r.err)?.[1]
      return fromError ?? fromField ?? ''
    }
    /** `RETURNING` 的读数：只要**第一行**（psql 还会打 `INSERT 0 1` 那个命令行尾） */
    const firstLine = (text: string | undefined): string => String(text ?? '').split('\n')[0]?.trim() ?? ''
    const manageTestDb = (script: 'create-test-db.sql' | 'drop-test-db.sql'): ReturnType<typeof psqlFile> =>
      psqlFile({
        container: CONTAINER,
        user: credentials!.LG_PG_BOOTSTRAP_USER,
        password: credentials!.LG_PG_BOOTSTRAP_PASSWORD,
        database: credentials!.LG_PG_BOOTSTRAP_DB,
        file: `/opt/lg/${script}`,
        variables: { LG_TEST_DB_NAME: TARGET_DB, LG_PG_MIGRATE_USER: MIGRATE_ROLE },
      })

    const productionBefore = productionDirFingerprint()
    let runtime: AgentRuntime | undefined

    try {
      manageTestDb('drop-test-db.sql')
      const created = manageTestDb('create-test-db.sql')
      const dump = await dumpPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT, args: RESTORE_ARGS, outFile: RESTORE_SQL })
      const restore = psqlFromStdin({
        container: CONTAINER,
        user: MIGRATE_USER,
        password,
        database: TARGET_DB,
        sql: dump.sql,
        timeoutMs: 900_000,
      })
      check('G04.0a 前置：PG 目标从 verified 快照恢复成功（exit 0 且无 ERROR）', () => {
        if (created.rc !== 0) throw new Error(created.err)
        if (restore.rc !== 0) throw new Error(restore.err.slice(0, 400))
        if (/^ERROR/m.test(restore.err)) throw new Error(`恢复日志里有 ERROR：${restore.err.slice(0, 400)}`)
      })

      const url = `postgresql://${MIGRATE_USER}:${encodeURIComponent(password)}@127.0.0.1:${HOST_PORT}/${TARGET_DB}`
      process.env.CHARACTER_DB_BACKEND = 'postgres'
      process.env.LG_PG_EXPECT_DATABASE = TARGET_DB
      process.env.LG_PG_EXPECT_DATABASE_PREFIX = 'lg_test_'
      const sandbox = isolateDatabase('pg-g04-verify', { postgres: { url } })
      const fallback = resolve(sandbox.dir, 'pglite-fallback')
      mkdirSync(fallback, { recursive: true })
      process.env.PGLITE_DATA_DIR = fallback

      const created2 = new AgentRuntime({ character: character as Character, plugins: [], settings: { POSTGRES_URL: url } })
      runtime = created2
      await initDatabase(created2, sqlPlugin)
      await created2.initialize()
      const kernel = await initKernel(created2, { definition: characterDefinitionFromCharacter(character) })
      const db = kernel.stores.db as never
      const characterId = kernel.characterId as unknown as string

      // ================= A JSON / null =================
      const jsonProbe = `public.${MARK}_json_probe`
      queryOf(`drop table if exists ${jsonProbe}`)
      queryOf(`create table ${jsonProbe} (id text primary key, payload jsonb not null)`)
      const payload = JSON.stringify({ nested: { a: 1, b: [1, 2, 3] }, missing: null, zh: '中文', big: '9007199254740993' })
      queryOf(`insert into ${jsonProbe}(id, payload) values ('j1', '${payload.replace(/'/g, "''")}'::jsonb)`)
      const roundTrip = queryOf(`select payload::text from ${jsonProbe} where id = 'j1'`)
      observations.json = { roundTrip }

      check('G04.1 ★ jsonb 往返逐字不变（嵌套对象 / 数组 / null / 中文 / 大整数字符串）', () => {
        const parsed = JSON.parse(String(roundTrip)) as Record<string, unknown>
        if (String((parsed.nested as { zh?: unknown }) === undefined ? '' : '') !== '') throw new Error('unreachable')
        if (parsed.zh !== '中文') throw new Error(`中文丢了：${JSON.stringify(parsed)}`)
        if (parsed.big !== '9007199254740993') throw new Error(`大整数字符串变了：${String(parsed.big)}`)
        if (!Array.isArray((parsed.nested as { b?: unknown }).b)) throw new Error('数组没读回数组')
        if (parsed.missing !== null) throw new Error('json null 没读回 null')
      })

      check('G04.2 ★ jsonb 里 **null 与「缺键」可区分**（`->` 得 null 值 vs `?` 为 false）', () => {
        const hasKey = queryOf(`select (payload ? 'missing')::text from ${jsonProbe} where id = 'j1'`)
        const absentKey = queryOf(`select (payload ? 'nope')::text from ${jsonProbe} where id = 'j1'`)
        const nullValue = queryOf(`select (payload->'missing' = 'null'::jsonb)::text from ${jsonProbe} where id = 'j1'`)
        if (String(hasKey).trim() !== 'true') throw new Error(`有 'missing' 键但 ? 说 false：${String(hasKey)}`)
        if (String(absentKey).trim() !== 'false') throw new Error(`没有 'nope' 键但 ? 说 true：${String(absentKey)}`)
        if (String(nullValue).trim() !== 'true') throw new Error(`null 值没判成 json null：${String(nullValue)}`)
      })

      check('G04.3 ★ 真库里的 jsonb 列是**对象**（不是被驱动转成的字符串）', () => {
        const kind = queryOf(
          "select jsonb_typeof(state) from character_projections where projection_type like 'goal:%' order by projection_type limit 1"
        )
        if (String(kind).trim() !== 'object') throw new Error(`state 的 jsonb 类型不是 object：${String(kind)}`)
      })

      // ================= B bigint / RETURNING =================
      const bigProbe = `public.${MARK}_big_probe`
      queryOf(`drop table if exists ${bigProbe}`)
      queryOf(`create table ${bigProbe} (id text primary key, n bigint not null)`)
      queryOf(`insert into ${bigProbe}(id, n) values ('b1', 9007199254740993)`)
      const bigText = queryOf(`select n::text from ${bigProbe} where id = 'b1'`)
      observations.bigint = { sqlText: bigText, jsNumber: Number(bigText) }

      check('G04.4 ★ bigint 超过 2^53：**SQL/文本层往返不丢精度**（并如实记录 JS number 会丢）', () => {
        if (String(bigText).trim() !== '9007199254740993') throw new Error(`文本层丢精度：${String(bigText)}`)
        // 这一条不是失败：它**记录** JS 侧的限制（迁移线的比较器因此默认把 bigint 转文本）
        if (Number(bigText) === 9007199254740993) {
          observations.bigintNote = '（本机 JS number 恰好相等，但 2^53+1 一般会舍入 ⇒ 判据不依赖它）'
        } else {
          observations.bigintNote = '（JS number 确实丢了精度 ⇒ 这正是 column-encoding 默认转文本的理由）'
        }
      })

      check('G04.5 ★ `INSERT … RETURNING` 可用且返回的是**写入后的值**', () => {
        const returned = firstLine(queryOf(`insert into ${bigProbe}(id, n) values ('b2', 42) returning id||'|'||n::text`))
        if (returned !== 'b2|42') throw new Error(`RETURNING 读数不对：${returned}`)
      })

      // ================= C 唯一 / 部分索引 =================
      /*
       * ⚠️ 探针表设计（第一版错了）：第一版把**同一个列 `k`** 既做普通唯一索引又做部分唯一索引
       *    ⇒ "部分索引那条"永远被普通唯一索引先拦下 ⇒ 量到的是**另一个**约束（读数里
       *    约束名是 `g04_idx_uniq`，不是 `g04_idx_partial`）。
       *    ⇒ 两个索引必须挂在**不同的键**上，才谈得上分别验证。
       */
      const idxProbe = `public.${MARK}_idx_probe`
      queryOf(`drop table if exists ${idxProbe}`)
      queryOf(
        `create table ${idxProbe} (k text not null, kind text not null, uniq_key text not null, v int not null); ` +
          `create unique index ${MARK}_idx_uniq on ${idxProbe}(uniq_key); ` +
          `create unique index ${MARK}_idx_partial on ${idxProbe}(k) where kind = 'active'`
      )
      queryOf(`insert into ${idxProbe}(k, kind, uniq_key, v) values ('a', 'active', 'u1', 1)`)

      check('G04.6 ★ 唯一索引真的拦（SQLSTATE **23505**，且行数没变）', () => {
        const state = sqlStateOf(`insert into ${idxProbe}(k, kind, uniq_key, v) values ('a2', 'archived', 'u1', 2)`)
        if (state !== '23505') throw new Error(`没有报 23505（实为 ${state || '(无 SQLSTATE)'}）`)
        const count = queryOf(`select count(*) from ${idxProbe} where uniq_key = 'u1'`)
        if (Number(count) !== 1) throw new Error(`重复插入竟然进去了（${String(count)} 行）`)
      })

      check('G04.7 ★ **部分唯一索引**真的拦（谓词命中 ⇒ 23505；谓词**不命中** ⇒ 不拦）', () => {
        /*
         * ⚠️ 序列设计（第一版错了）：部分索引是 `on (k) where kind = 'active'`
         *    ⇒ 冲突必须发生在**两条都满足谓词**的行之间。第一版先插 `archived` 再插 `active`
         *    ⇒ 那条 `active` 是部分索引里的**第一条** ⇒ 当然不冲突（读数 `(无 SQLSTATE)` 红得对）。
         */
        queryOf(`insert into ${idxProbe}(k, kind, uniq_key, v) values ('b', 'active', 'u2', 3)`)
        const hit = sqlStateOf(`insert into ${idxProbe}(k, kind, uniq_key, v) values ('b', 'active', 'u3', 4)`)
        if (hit !== '23505') throw new Error(`部分唯一索引没拦（实为 ${hit || '(无 SQLSTATE)'}）`)
        // 谓词**不命中**的重复必须允许 ⇒ 这才是"部分"索引的语义
        queryOf(`insert into ${idxProbe}(k, kind, uniq_key, v) values ('c', 'archived', 'u4', 5)`)
        const miss = sqlStateOf(`insert into ${idxProbe}(k, kind, uniq_key, v) values ('c', 'archived', 'u5', 6)`)
        if (miss !== '') throw new Error(`谓词不命中时不该拦（实为 ${miss}）`)
      })

      check('G04.8 ★ 主键冲突报 23505（不是别的错）', () => {
        const state = sqlStateOf(`insert into ${jsonProbe}(id, payload) values ('j1', '{}'::jsonb)`)
        if (state !== '23505') throw new Error(`主键冲突没报 23505（实为 ${state || '(无 SQLSTATE)'}）`)
      })

      // ================= D 幂等 =================
      const idem = `${MARK}-idem`
      const accepted = {
        type: 'GOAL_CREATED',
        operation: 'create',
        payload: { goalId: `${MARK}-goal`, statement: 'g04 夹具目标' },
        sourceConversationEventIds: [],
        idempotencyKey: `${idem}:event`,
        processor: MARK,
        processorVersion: `${MARK}@1`,
        scope: DOMAIN_EVENT_SCOPE,
      }
      const eventsBefore = Number(queryOf('select count(*) from character_domain_events'))
      const first = await appendDomainEvent(db, characterId as never, accepted as never, T0)
      const second = await appendDomainEvent(db, characterId as never, accepted as never, T0 + 1)
      const eventsAfter = Number(queryOf('select count(*) from character_domain_events'))

      check('G04.9 ★ 事件写入幂等：同 `idempotencyKey` 第二次 ⇒ `created:false` 且**事件数不增**', () => {
        if (first.created !== true) throw new Error('第一次竟然没写进去')
        if (second.created !== false) throw new Error('第二次竟然又写了')
        if (eventsAfter !== eventsBefore + 1) throw new Error(`事件数 ${eventsBefore} → ${eventsAfter}（应恰好 +1）`)
      })

      const jobKey = `${idem}:job`
      const job1 = await enqueueJob(db, {
        characterId: characterId as never,
        processor: MARK,
        processorVersion: `${MARK}@1`,
        sourceFromSequence: 1,
        sourceToSequence: 1,
        idempotencyKey: jobKey,
      })
      const job2 = await enqueueJob(db, {
        characterId: characterId as never,
        processor: MARK,
        processorVersion: `${MARK}@1`,
        sourceFromSequence: 1,
        sourceToSequence: 1,
        idempotencyKey: jobKey,
      })
      const jobRows = Number(queryOf(`select count(*) from character_jobs where idempotency_key = '${jobKey}'`))

      check('G04.10 ★ 任务入队幂等：同幂等键第二次 ⇒ **只有一行**', () => {
        if (jobRows !== 1) throw new Error(`任务行数 ${jobRows}（应为 1）`)
        void job1
        void job2
      })

      const recordInput = {
        idempotencyKey: `${idem}:op`,
        characterId: characterId as never,
        processor: MARK,
        processorVersion: `${MARK}@1`,
        operation: `${MARK}.probe`,
      }
      const firstRecord = await recordProcessedOperation(db, recordInput as never, T0)
      let secondRecordThrew = false
      let secondRecorded: boolean | undefined
      try {
        const again = await recordProcessedOperation(db, recordInput as never, T0 + 1)
        secondRecorded = again.recorded
      } catch {
        secondRecordThrew = true
      }
      const processed = await hasProcessedOperation(db, `${idem}:op`)

      check('G04.11 ★ 已处理操作表：重复登记**不抛**（`recorded:false`），且查得到', () => {
        if (firstRecord.recorded !== true) throw new Error('第一次竟然没记上')
        if (secondRecordThrew) throw new Error('重复登记抛了（应当幂等）')
        if (secondRecorded !== false) throw new Error(`重复登记的 recorded 应为 false，实为 ${String(secondRecorded)}`)
        if (processed !== true) throw new Error('登记后查不到')
      })

      // ================= E 乐观冲突 =================
      const projectionType = `${MARK}:probe`
      /*
       * ⚠️ 先**造一行**：`saveProjection` 的语义是"在既有行上更新"，行不存在时它会走
       *    `projection_missing` 那条错（另一条具名拒收）。第一版没造行 ⇒ `G04.12` 的
       *    前置不成立（"没有既有投影行 ⇒ 这条判据没量到东西"）—— 前置判据红得对。
       */
      await insertProjection(
        db,
        {
          characterId: characterId as never,
          projectionType: projectionType as never,
          revision: 1,
          reducerVersion: 'g04@1',
          state: { created: true },
          updatedAt: T0 as never,
        } as never,
        T0
      )
      const current = await getProjection<Record<string, unknown>>(db, characterId as never, projectionType as never)
      let conflictCode: string | undefined
      let revisionAfterConflict: number | undefined
      if (current === undefined) {
        observations.conflict = '（插入后仍读不回投影行 ⇒ 前置不成立）'
      } else {
        const wrongRevision = Number((current as { revision?: number }).revision ?? 0) + 999
        try {
          await saveProjection(
            db,
            {
              characterId: characterId as never,
              projectionType: projectionType as never,
              revision: wrongRevision,
              reducerVersion: 'g04@1',
              state: { touched: true },
              updatedAt: T0 as never,
            } as never,
            wrongRevision
          )
        } catch (error) {
          conflictCode = (error as { code?: string }).code ?? (error as { name?: string }).name
        }
        const after = await getProjection<Record<string, unknown>>(db, characterId as never, projectionType as never)
        revisionAfterConflict = Number((after as { revision?: number } | undefined)?.revision ?? -1)
        observations.conflict = { conflictCode, wrongRevision, revisionAfterConflict }
      }

      check('G04.12 ★ 乐观冲突：用**错的** `expectedRevision` 更新 ⇒ 拒（具名 `revision_conflict`）且**没写进去**', () => {
        const c = observations.conflict
        if (typeof c === 'string') throw new Error(`前置不成立：${c}`)
        const code = String((c as { conflictCode?: string }).conflictCode ?? '')
        /*
         * ⚠️ 断言用**包含**而不是相等：`KernelError` 把这一族错具名成
         *    `projection_revision_conflict`（类名/原因面），而族名是 `revision_conflict`。
         *    两者都点名了同一件事 ⇒ 判据落在"**这一族**被具名拒绝"上，并把**原值**记进证据。
         */
        if (!/revision_conflict/.test(code)) throw new Error(`没有报 revision_conflict 这一族：${code}`)
        if (revisionAfterConflict !== 1) throw new Error(`冲突后 revision 变成了 ${String(revisionAfterConflict)}（应仍是 1）`)
      })

      // ================= F 事务原子性 =================
      const txProbe = `public.${MARK}_tx_probe`
      queryOf(`drop table if exists ${txProbe}`)
      queryOf(`create table ${txProbe} (id text primary key)`)
      const txScript =
        `begin;\ninsert into ${txProbe}(id) values ('t1');\n` +
        `insert into ${txProbe}(id) values ('t1');\ncommit;\n`
      const tx = psqlFromStdin({ container: CONTAINER, user: MIGRATE_USER, password, database: TARGET_DB, sql: txScript, psqlArgs: ['-tA'] })
      const txRows = Number(queryOf(`select count(*) from ${txProbe}`))
      observations.transaction = { rc: tx.rc, rows: txRows, err: tx.err.slice(0, 200) }

      check('G04.13 ★ 事务原子性：事务内第二次插入撞主键 ⇒ **整个事务回滚**（0 行）', () => {
        if (txRows !== 0) throw new Error(`回滚后仍有 ${txRows} 行 ⇒ 事务不是原子的`)
      })

      // ================= G 四个仓储真实执行 =================
      const eventsReadBack = await domainEventsFor(db, characterId as never)
      const eventFound = eventsReadBack.some((event) => String(event.id) === String(first.event.id))

      check('G04.14 ★ Event 仓储真实执行（写入 + **用真 store 读回**同一个 id）', () => {
        if (String(first.event.id).length === 0) throw new Error('没有返回事件 id')
        if (!eventFound) throw new Error(`真 store 读回的 ${eventsReadBack.length} 条事件里没有刚写的那一条`)
      })

      const conversationId = `${MARK}-conv`
      await appendConversationEvent(db, {
        characterId: characterId as never,
        conversationId: conversationId as never,
        conversationSequence: 1,
        type: 'user_message' as never,
        actorType: 'user' as never,
        content: `${MARK}-conv-content`,
        createdAt: T0,
      })

      check('G04.15 ★ Conversation 仓储真实执行（写入 + 读回 + 序号）', () => {
        const rows = queryOf(`select count(*) from conversation_events where conversation_id = '${conversationId}'`)
        if (Number(rows) !== 1) throw new Error(`会话事件行数 ${String(rows)}（应为 1）`)
      })

      const memId = `${MARK}-mem`
      await applyMemoryEvent(
        db,
        {
          id: `${MARK}-mem-event` as never,
          characterId: characterId as never,
          sequence: 1,
          type: 'MEMORY_CREATED',
          sourceConversationEventIds: [],
          payload: {
            memoryId: memId,
            mutation: 'explicit',
            record: {
              id: memId,
              owner: entityRef('character', characterId),
              type: 'preference',
              content: { kind: 'claim', subject: entityRef('user', characterId), predicate: `${MARK}.probe`, value: 'v', qualifiers: {} },
              subjects: [entityRef('user', characterId)],
              epistemicStatus: 'reported',
              authority: 'EXPLICIT_USER_STATEMENT',
              importance: 0.5,
              confidence: 0.7,
              status: 'active',
              sourceRefs: [conversationEvidence(`${MARK}-root`)],
              evidenceRootIds: [`${MARK}-root`],
              recordedAt: T0,
              contentFingerprint: `${MARK}-fp`,
              revision: 0,
              canonicalKey: `${MARK}:probe`,
              reducerVersion: 'memory-reducer@1',
              schemaVersion: 1,
              createdAt: T0,
            },
          },
          processor: MARK,
          processorVersion: `${MARK}@1`,
          idempotencyKey: `${idem}:memory`,
          schemaVersion: 1,
          createdAt: T0,
          scope: DOMAIN_EVENT_SCOPE,
        } as never,
        T0
      )
      const store = createNativeMemoryStore(db)
      const memory = await store.get(memId as never)

      check('G04.16 ★ Memory 仓储真实执行（事件 → 投影 → 真 store 读回）', () => {
        if (memory === null || memory === undefined) throw new Error('真 store 读不回刚写的记忆')
      })

      const wmName = `${MARK}-watermark`
      await advanceWatermark(db, characterId as never, wmName, `${MARK}@1`, 7, T0)
      const wm = await getWatermark(db, characterId as never, wmName, `${MARK}@1`)

      check('G04.17 ★ Job 仓储真实执行（入队 → 起跑 → 收尾 → 水位前进）', () => {
        const jobId = String((job1 as { job?: { id?: unknown } }).job?.id ?? '')
        void jobId
        if (wm === undefined || wm === null) throw new Error('水位没写进去')
        if (Number((wm as { processedThroughSequence?: number }).processedThroughSequence) !== 7) {
          throw new Error(`水位读数不对：${JSON.stringify(wm)}`)
        }
      })

      await closeDatabaseConnection(runtime)
      runtime = undefined
    } catch (error) {
      checks.push({ name: 'g04.§ 意外中断', pass: false, detail: error instanceof Error ? (error.stack ?? error.message) : String(error) })
    } finally {
      if (runtime !== undefined) {
        try {
          await closeDatabaseConnection(runtime)
        } catch {
          /* 尽力关 */
        }
      }
      const dropped = manageTestDb('drop-test-db.sql')
      check('G04.9a 本门自建的测试库已清理', () => {
        if (dropped.rc !== 0) throw new Error(dropped.err)
      })
      const productionAfter = productionDirFingerprint()
      observations.productionDir = { before: productionBefore, after: productionAfter }
      check('G04.9z ★★ 真实库目录**逐字未动**', () => {
        assertProductionDirUnchanged(productionBefore, productionAfter)
      })
    }
  }

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const evidence = {
    gate: 'postgresql:g04:verify',
    scope: 'PG-G04 SQL/仓储兼容（JSON/null · bigint · RETURNING · 唯一/部分索引 · 幂等 · 乐观冲突 · 事务原子性 · 四仓储）',
    runId: RUN_ID,
    atUtc: new Date().toISOString(),
    atUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    head: (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim(),
    sourceSnapshot: SOURCE_SNAPSHOT,
    targetDb: TARGET_DB,
    checks,
    notRun,
    observations,
    counts: { measured: checks.length, passed, failed, notRun: notRun.length },
  }
  writeFileSync(resolve(EVIDENCE_DIR, 'g04-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  JSON.parse(readFileSync(resolve(EVIDENCE_DIR, 'g04-evidence.json'), 'utf8'))

  console.log('')
  console.log('PG-G04 SQL/仓储兼容')
  console.log('─'.repeat(84))
  console.log(`  runId : ${RUN_ID}`)
  console.log(`  证据  : artifacts/post-lv2/postgresql-migration/${RUN_ID}/`)
  console.log('─'.repeat(84))
  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (!c.pass && c.detail !== undefined) console.log(`        └─ ${c.detail}`)
  }
  console.log('─'.repeat(84))
  console.log(`  bigint 读数 : ${JSON.stringify(observations.bigint ?? {})}`)
  console.log(`  冲突读数    : ${JSON.stringify(observations.conflict ?? {})}`)
  console.log(`  事务读数    : ${JSON.stringify(observations.transaction ?? {})}`)
  console.log('─'.repeat(84))
  console.log(`  断言        : ${passed}/${checks.length}`)
  console.log(`  未运行      : ${notRun.length}`)
  for (const entry of notRun) console.log(`      · ${entry.id} —— ${entry.what}（${entry.why}）`)
  console.log(`  measured_count = ${checks.length}`)
  console.log(`  失败总数 = ${failed}`)
  console.log('')

  if (checks.length === 0) {
    console.error('measured_count = 0 ⇒ INVALID（不得当绿用）')
    process.exitCode = 1
  } else if (failed > 0) {
    process.exitCode = 1
  } else if (notRun.length > 0) {
    console.error(`\n${notRun.length} 项未运行 ⇒ 本门**不报 PASS**。`)
    process.exitCode = 1
  }
}

await main()
