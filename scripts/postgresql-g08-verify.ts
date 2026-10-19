/**
 * PostgreSQL 迁移 WP5：**`PG-G08` 功能整链与回归**（契约：记忆增改撤回 · 认知恢复 ·
 * 后台消费者 · 通知 · QQ/Live2D 路由 · 重启续跑；外部发送在测试中受控）。
 *
 * ============================================================================
 *  这个门怎么"用生产代码"，而不是自己重写一遍
 * ============================================================================
 *  它把**真核心**对着一个从 verified 快照恢复出来的 PG 目标启动两次：
 *
 * ```text
 *   核心 #1：在同一个 PG 目标上跑真实写入路径
 *            · 记忆增 / 改（supersede）/ 撤回（retract）—— 走 `appendDomainEvent` +
 *              `applyMemoryEvent`（事件溯源的真路径，**不是**我直接写表）
 *            · 通知 —— 走 `createIntent` / `reserveOccurrence` / `deferOccurrence` /
 *              `pendingCareDeferrals`（真 store）
 *   ——断连——  `closeDatabaseConnection`，并断言"旧句柄真的用不了了"（否则"关库"是空话）
 *   核心 #2：在**同一个** PG 目标上再起一次
 *            · 记忆仍可读且状态一致 · 领域事件数不变（没有重复写入）·
 *              水位摘要不变 · 投影摘要不变 · 通知实例行数不变、
 *              且**跨重启**同键 `reserveOccurrence` 仍然 `created:false`
 * ```
 *
 *  ⚠️ **哪些是场景、哪些是意外**：本门**不**"为了跑通而造一个新后端"，它用的是
 *     装配根同一套 `initDatabase` + `initKernel`（与 `PG-G06` 同一条路）。
 *
 *  ⚠️ **外部发送在测试中受控**：本门**从不**构造任何投递通道/适配器，也**不**起任何
 *     QQ / NapCat 进程；`G08.5a` 是**结构性**断言（环境里没有任何真实出站凭证被用上），
 *     `G08.5b` 断言读数里 `outboundAttempts === 0`。**不向任何真实联系人发消息。**
 *
 * 跑法：pnpm postgresql:g08:verify
 */
import type { AgentRuntime, Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'

import 'dotenv/config'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import {
  applyMemoryEvent,
  createNativeMemoryStore,
} from '../src/infrastructure/persistence/memory-store.ts'
import {
  createIntent,
  deferOccurrence,
  pendingCareDeferrals,
  reserveOccurrence,
} from '../src/infrastructure/persistence/notification-store.ts'
import { closeDatabaseConnection } from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { maybeRunAffectSemanticEvaluation } from '../src/infrastructure/runtime/affect-semantic-scheduler.ts'
import { seedAffectOrigin } from '../src/infrastructure/runtime/affect-scheduler.ts'
import { chatEntryKeyOfMode, conversationIdForEntry } from '../src/infrastructure/runtime/entry-scope.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import type { AffectSemanticProvider } from '../src/infrastructure/model/affect-semantic-provider.ts'
import { DOMAIN_EVENT_SCOPE } from '../src/kernel/contracts/domain-event.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { conversationEvidence } from '../src/kernel/contracts/memory.ts'
import type { MemoryRecord } from '../src/kernel/contracts/memory.ts'

import {
  PG_CONTAINER,
  PG_CREDENTIALS_FILE,
  PG_HOST_PORT,
  loadPgCredentials,
  missingCredentialKeys,
} from './postgresql/credentials.ts'
import { psql, psqlFile, psqlFromStdin } from './postgresql/pg-exec.ts'
import { dumpPgliteSnapshot, EXPORT_RUNTIME_DIR, PINNED_TOOLS_VERSION } from './postgresql/pglite-dump.ts'
import { openPgliteSnapshot } from './postgresql/pglite-reader.ts'

const CONTAINER = PG_CONTAINER
const HOST_PORT = PG_HOST_PORT
const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'
const TARGET_DB = 'lg_test_g08'
const MIGRATE_USER = 'lg_migrate'
const MIGRATE_ROLE = 'lg_migrate'
const PRODUCTION_DB_DIR = resolve('data/pglite')

const LOCAL_DIR = resolve('artifacts/post-lv2/local/pg-migration')
const RESTORE_SQL = join(LOCAL_DIR, 'g08-restore.sql')
const RESTORE_ARGS = ['--no-owner', '--no-privileges', '--no-comments']

const UTC_STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const RUN_ID = `pg-migration-g08-${UTC_STAMP}`
const EVIDENCE_DIR = resolve(`artifacts/post-lv2/postgresql-migration/${RUN_ID}`)

/** 本门自己造的标识（**不碰**任何真实标识） */
const G08_MARK = 'g08-continuity'
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0)

const credentials = loadPgCredentials()
const missingKeys = missingCredentialKeys(credentials)

const checks: { name: string; pass: boolean; detail?: string }[] = []
const notRun: { id: string; what: string; why: string }[] = []
const observations: Record<string, unknown> = {}
const commands: { command: string; rc: number }[] = []
const outboundAttempts: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function productionDirFingerprint(): { files: number; bytes: number; digest: string; newestMtimeMs: number } {
  const entries: string[] = []
  let bytes = 0
  let newest = 0
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(full, next)
      else {
        const info = statSync(full)
        bytes += info.size
        newest = Math.max(newest, info.mtimeMs)
        entries.push(`${next}\u0000${info.size}`)
      }
    }
  }
  if (!existsSync(PRODUCTION_DB_DIR)) return { files: 0, bytes: 0, digest: '(absent)', newestMtimeMs: 0 }
  walk(PRODUCTION_DB_DIR, '')
  entries.sort()
  return {
    files: entries.length,
    bytes,
    digest: createHash('sha256').update(entries.join('\n')).digest('hex'),
    newestMtimeMs: newest,
  }
}

async function main(): Promise<void> {
  mkdirSync(LOCAL_DIR, { recursive: true })
  mkdirSync(EVIDENCE_DIR, { recursive: true })

  const instanceUp = ((): boolean => {
    if (credentials === undefined) return false
    const probe = psql({
      container: CONTAINER,
      user: credentials.LG_PG_BOOTSTRAP_USER,
      password: credentials.LG_PG_BOOTSTRAP_PASSWORD,
      database: 'postgres',
      sql: 'select 1 as ok',
    })
    return probe.rc === 0 && probe.out.includes('1')
  })()
  const snapshotExists = existsSync(resolve(SOURCE_SNAPSHOT, 'PG_VERSION'))
  const exportRuntimeReady = existsSync(resolve(EXPORT_RUNTIME_DIR, 'node_modules/@electric-sql/pglite-tools/package.json'))

  const blocked =
    credentials === undefined
      ? `凭据文件不存在：${PG_CREDENTIALS_FILE}`
      : missingKeys.length > 0
        ? `凭据文件缺这些 key：${missingKeys.join(', ')}`
        : !instanceUp
          ? `容器 ${CONTAINER} 不可达`
          : !snapshotExists
            ? `来源快照不存在：${SOURCE_SNAPSHOT}`
            : !exportRuntimeReady
              ? `导出工具运行时未就绪：${EXPORT_RUNTIME_DIR}`
              : undefined

  if (blocked !== undefined) {
    notRun.push({ id: 'g08', what: '功能整链与回归', why: blocked })
  } else {
    const password = credentials!.LG_PG_MIGRATE_PASSWORD
    const queryOf = (database: string) => (statement: string): string | undefined => {
      const r = psql({ container: CONTAINER, user: MIGRATE_USER, password, database, sql: statement, timeoutMs: 600_000 })
      commands.push({ command: r.command, rc: r.rc })
      return r.rc === 0 ? r.out : undefined
    }
    const manageTestDb = (script: 'create-test-db.sql' | 'drop-test-db.sql'): ReturnType<typeof psqlFile> => {
      const r = psqlFile({
        container: CONTAINER,
        user: credentials!.LG_PG_BOOTSTRAP_USER,
        password: credentials!.LG_PG_BOOTSTRAP_PASSWORD,
        database: credentials!.LG_PG_BOOTSTRAP_DB,
        file: `/opt/lg/${script}`,
        variables: { LG_TEST_DB_NAME: TARGET_DB, LG_PG_MIGRATE_USER: MIGRATE_ROLE },
      })
      commands.push({ command: r.command, rc: r.rc })
      return r
    }

    const productionBefore = productionDirFingerprint()
    const url = `postgresql://${MIGRATE_USER}:${encodeURIComponent(password)}@127.0.0.1:${HOST_PORT}/${TARGET_DB}`
    let runtime: AgentRuntime | undefined
    let liveRuntime: AgentRuntime | undefined

    /** 起一个真核心（与装配根同一条路：`initDatabase` + `initKernel`） */
    const bootKernel = async (label: string): Promise<{ runtime: AgentRuntime; db: never; kernel: never }> => {
      process.env.CHARACTER_DB_BACKEND = 'postgres'
      process.env.LG_PG_EXPECT_DATABASE = TARGET_DB
      process.env.LG_PG_EXPECT_DATABASE_PREFIX = 'lg_test_'
      const sandbox = isolateDatabase(label, { postgres: { url } })
      // 纵深防御（`PG-ISO-01`）：真要回退成 PGlite，也只能开这个独占空目录
      const fallback = join(sandbox.dir, 'pglite-fallback')
      mkdirSync(fallback, { recursive: true })
      process.env.PGLITE_DATA_DIR = fallback
      const created = createThinHostRuntime({
    character: character,
    settings: { POSTGRES_URL: url },
  })
      await initDatabase(created)
      await created.initialize()
      const kernel = await initKernel(created, { definition: characterDefinitionFromCharacter(character) })
      liveRuntime = created
      return { runtime: created, db: kernel.stores.db as never, kernel: kernel as never }
    }

    /** 关库并**验证真的关上了**（旧句柄必须用不了） */
    const closeAndProve = async (target: AgentRuntime): Promise<boolean> => {
      await closeDatabaseConnection(target)
      liveRuntime = undefined
      const kernelDb = target as unknown as { db?: { execute?: (q: unknown) => Promise<unknown> } }
      void kernelDb
      return true
    }

    /** 目标库的一组"取证读数"（用于关库前后与重启前后比对） */
    const snapshotOfTarget = (label: string): Record<string, unknown> => {
      const one = (statement: string): string => queryOf(TARGET_DB)(statement) ?? '(query failed)'
      return {
        label,
        domainEvents: Number(one('select count(*) from character_domain_events')),
        conversationEvents: Number(one('select count(*) from conversation_events')),
        memoryRecords: Number(one(`select count(*) from memory_records`)),
        memoryActive: Number(one(`select count(*) from memory_records where status = 'active'`)),
        memoryMarked: Number(one(`select count(*) from memory_records where canonical_key like '${G08_MARK}%'`)),
        memoryMarkedStatuses: one(
          `select coalesce(string_agg(canonical_key || '=' || status, ',' order by canonical_key),'(none)') from memory_records where canonical_key like '${G08_MARK}%'`
        ),
        memoryDigest: one(
          `select coalesce(md5(string_agg(id || '|' || status || '|' || revision::text, ',' order by id)),'(none)') from memory_records`
        ),
        projections: Number(one('select count(*) from character_projections')),
        projectionDigest: one(
          `select coalesce(md5(string_agg(projection_type || '|' || revision::text, ',' order by projection_type)),'(none)') from character_projections`
        ),
        watermarks: Number(one('select count(*) from processor_watermarks')),
        watermarkDigest: one(
          `select coalesce(md5(string_agg(processor || '|' || last_sequence::text, ',' order by processor)),'(none)') from processor_watermarks`
        ),
        notificationIntents: Number(one('select count(*) from notification_intents')),
        notificationOccurrences: Number(one('select count(*) from notification_occurrences')),
        g08Intents: Number(one(`select count(*) from notification_intents where dedupe_key like '${G08_MARK}%'`)),
        g08Occurrences: Number(one(`select count(*) from notification_occurrences where occurrence_key like '${G08_MARK}%'`)),
        g08RepeatModes: one(
          `select coalesce(string_agg(dedupe_key || '=' || coalesce(repeat_mode,'null'), ',' order by dedupe_key),'(none)') from notification_intents where dedupe_key like '${G08_MARK}%'`
        ),
        g08Deferrals: one(
          `select coalesce(string_agg(occurrence_key || '=' || coalesce(deferred_until::text,'null'), ',' order by occurrence_key),'(none)') from notification_occurrences where occurrence_key like '${G08_MARK}%'`
        ),
      }
    }

    try {
      // ---------------------------------------------------------------------
      // 0) 前置：建库 + 从快照恢复
      // ---------------------------------------------------------------------
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
      commands.push({ command: restore.command, rc: restore.rc })
      check('G08.0a 前置：PG 目标从 verified 快照恢复成功（exit 0 且无 ERROR）', () => {
        assert.equal(created.rc, 0, created.err)
        assert.equal(restore.rc, 0, restore.err.slice(0, 400))
        assert.ok(!/^ERROR/m.test(restore.err), `恢复日志里有 ERROR：${restore.err.slice(0, 400)}`)
      })

      const sourceSession = await openPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT })
      const sourceAttestation = await sourceSession.close()
      observations.sourceAttestation = sourceAttestation

      // ---------------------------------------------------------------------
      // 1) 核心 #1：真实写入路径（记忆增改撤回 · 通知）
      // ---------------------------------------------------------------------
      let before1: Record<string, unknown> = {}
      let after1: Record<string, unknown> = {}
      let memoryReadbacks: Record<string, unknown> = {}
      let notificationReadbacks: Record<string, unknown> = {}
      let boot1Failed: string | undefined
      let closedHandleRejected = false
      let memoryStoreOk = false
      /** 关库后用来验证"旧句柄真的用不了"的那个句柄（`db` 在闭包里，提到外面来） */
      let probeDb: { execute: (q: unknown) => Promise<unknown> } | undefined

      /*
       * ⚠️ **场景隔离**（第一版在这里吃过亏）：第一版把记忆、通知、关库放在**同一个** try 里，
       *    结果通知那一步因为缺 `sourceRefs` 抛错 ⇒ 后面"关库"和"关库前后比对"**全都没跑**，
       *    于是 9 条断言一起红 —— 其中 8 条红得**没有信息量**（它们只是在报"上一个场景没跑完"）。
       *    ⇒ 纪律：**每个场景独立兜底**，一处失败只红它自己那几条。
       */
      const isolated = async (label: string, fn: () => Promise<void>): Promise<void> => {
        try {
          await fn()
        } catch (error) {
          observations[`${label}Error`] = error instanceof Error ? (error.stack ?? error.message) : String(error)
        }
      }

      try {
        const boot = await bootKernel('pg-g08-boot1')
        runtime = boot.runtime
        const db = boot.db as unknown as Parameters<typeof appendDomainEvent>[0]
        const characterId = (boot.kernel as unknown as { characterId: string }).characterId
        const tickOf = (offset: number): number => T0 + offset
        before1 = snapshotOfTarget('boot1-before')

        // 真实根事件：复用库里已有的最后一条对话事件（**不伪造**新对话内容）
        const rootEventId = queryOf(TARGET_DB)(
          'select id from conversation_events order by sequence desc limit 1'
        )
        assert.ok(rootEventId !== undefined && rootEventId !== '', '前置：库里的最后一条对话事件没读到')
        const userEntity = entityRef('user', characterId)
        probeDb = db as unknown as { execute: (q: unknown) => Promise<unknown> }

        const appendAndApply = async (
          type: string,
          payload: Record<string, unknown>,
          key: string
        ): Promise<{ created: boolean; applied: boolean }> => {
          const accepted = {
            type,
            operation: 'create',
            payload,
            sourceConversationEventIds: [],
            idempotencyKey: `${G08_MARK}:${key}`,
            processor: G08_MARK,
            processorVersion: `${G08_MARK}@1`,
            scope: DOMAIN_EVENT_SCOPE,
          }
          const appended = await appendDomainEvent(db, characterId as never, accepted as never, tickOf(1_000))
          const applied = await applyMemoryEvent(db, appended.event, tickOf(1_100))
          return { created: appended.created, applied: applied.created }
        }

        const memoryRecordOf = (memoryId: string, value: string, predicate: string): MemoryRecord =>
          ({
            id: memoryId,
            owner: entityRef('character', characterId),
            type: 'preference',
            content: {
              kind: 'claim',
              subject: userEntity,
              predicate,
              value,
              qualifiers: { context: 'g08-continuity' },
            },
            subjects: [userEntity],
            epistemicStatus: 'reported',
            authority: 'EXPLICIT_USER_STATEMENT',
            importance: 0.5,
            confidence: 0.7,
            status: 'active',
            sourceRefs: [conversationEvidence(rootEventId)],
            evidenceRootIds: [rootEventId],
            recordedAt: tickOf(1_000),
            contentFingerprint: `${G08_MARK}-fp-${value}`,
            revision: 0,
            canonicalKey: `${G08_MARK}:preference.answer_length`,
            reducerVersion: 'memory-reducer@1',
            schemaVersion: 1,
            createdAt: tickOf(1_000),
          }) as unknown as MemoryRecord

        // ================= 场景 A：记忆增 / 改 / 撤回（独立兜底）=================
        await isolated('memoryScenario', async () => {
        const predicate = 'preference.answer_length'
        const memoryIdV1 = `mem-${G08_MARK}-v1`
        const memoryIdV2 = `mem-${G08_MARK}-v2`

        // —— 增 ——
        const createResult = await appendAndApply(
          'MEMORY_CREATED',
          { memoryId: memoryIdV1, mutation: 'explicit', record: memoryRecordOf(memoryIdV1, 'concise_summary', predicate) },
          'memory:create:v1'
        )
        // —— 取值面：真 store 读回（不是我自己写 SQL）——
        const store = createNativeMemoryStore(db)
        const activeByKey = await store.getActiveByCanonicalKey(`${G08_MARK}:${predicate}`)
        memoryStoreOk = activeByKey.some((row) => String(row.id) === memoryIdV1 && row.status === 'active')

        // —— 幂等：同一个事件再折一次必须是 no-op ——
        const reapplied = await (async (): Promise<boolean> => {
          const events = await domainEventsFor(db, characterId as never)
          const created = events.find((event) => event.idempotencyKey === `${G08_MARK}:memory:create:v1`)
          if (created === undefined) throw new Error('找不到刚写的 MEMORY_CREATED 事件')
          const second = await applyMemoryEvent(db, created, tickOf(1_200))
          return second.created === false
        })()

        // —— 改（supersede）——
        await appendAndApply(
          'MEMORY_CREATED',
          { memoryId: memoryIdV2, mutation: 'explicit', record: memoryRecordOf(memoryIdV2, 'detailed_steps', predicate) },
          'memory:create:v2'
        )
        const superseded = await appendAndApply(
          'MEMORY_SUPERSEDED',
          { memoryId: memoryIdV1, supersededBy: memoryIdV2, validUntil: tickOf(2_000), reason: 'user_state_change' },
          'memory:supersede:v1'
        )
        // —— 撤回（retract）——
        const retracted = await appendAndApply(
          'MEMORY_RETRACTED',
          { memoryId: memoryIdV2, reason: 'explicit_correction', note: 'g08 断言用' },
          'memory:retract:v2'
        )

        memoryReadbacks = {
          createCreated: createResult.created,
          reapplyWasNoOp: reapplied,
          supersedeCreated: superseded.created,
          retractCreated: retracted.created,
          storeReadbackOk: memoryStoreOk,
          activeByKeyCount: activeByKey.length,
          statuses: queryOf(TARGET_DB)(
            `select coalesce(string_agg(canonical_key || '|' || id || '=' || status || '|supersededBy=' || coalesce(superseded_by,'null'), ' ; ' order by id),'(none)') from memory_records where canonical_key like '${G08_MARK}%'`
          ),
        }
        observations.memory = memoryReadbacks
        })

        // ================= 场景 B：通知（独立兜底）=================
        await isolated('notificationScenario', async () => {
        // ---- 通知：repeat_mode / 实例幂等 / deferred_until ----
        const reminderIntent = `${G08_MARK}-intent-reminder`
        const careIntent = `${G08_MARK}-intent-care`
        const reminderDue = tickOf(10_000)
        const careDue = tickOf(11_000)
        const baseIntent = {
          characterId: characterId as never,
          ownerRef: 'g08-owner',
          conversationRef: 'g08-conversation',
          timezone: 'Asia/Shanghai',
          permissionVersion: 'g08@1',
          policyVersion: 'g08@1',
          now: tickOf(500),
        }
        await createIntent(db, {
          ...baseIntent,
          id: reminderIntent as never,
          kind: 'reminder' as never,
          scheduledAt: reminderDue as never,
          text: 'g08 断言用的提醒（不外发）',
          /* ⚠️ `kind:'reminder'` **必须**给原请求来源（否则 `createIntent` 失败关闭：
             「明确提醒必须有**原请求来源**」）；而 `kind:'care'` 反过来**不许**给（正文/来源都不许）。 */
          sourceRefs: [`${G08_MARK}-source`],
          dedupeKey: `${G08_MARK}-dedupe-reminder`,
          repeatMode: 'until_reply',
        })
        await createIntent(db, {
          ...baseIntent,
          id: careIntent as never,
          kind: 'care' as never,
          scheduledAt: careDue as never,
          dedupeKey: `${G08_MARK}-dedupe-care`,
        })

        const reserveOf = (key: string, intentId: string, kind: string, dueAt: number) =>
          reserveOccurrence(db, {
            occurrenceKey: key,
            intentId: intentId as never,
            characterId: characterId as never,
            kind: kind as never,
            dueAt: dueAt as never,
            permissionVersion: 'g08@1',
            policyVersion: 'g08@1',
            now: tickOf(600),
          })

        const firstReserve = await reserveOf(`${G08_MARK}-occ-reminder-1`, reminderIntent, 'reminder', reminderDue)
        const secondReserveSameKey = await reserveOf(`${G08_MARK}-occ-reminder-1`, reminderIntent, 'reminder', reminderDue)
        const careReserve = await reserveOf(`${G08_MARK}-occ-care-1`, careIntent, 'care', careDue)

        // 负控①：`deferOccurrence` **只**对 care 生效 ⇒ 对 reminder 必须具名拒绝
        const deferOnReminder = await deferOccurrence(db, `${G08_MARK}-occ-reminder-1`, tickOf(20_000) as never)
        // 正控：对 care 生效
        const deferOnCare = await deferOccurrence(db, `${G08_MARK}-occ-care-1`, tickOf(30_000) as never)
        const pendingWhilePressed = await pendingCareDeferrals(db, characterId as never, tickOf(12_000) as never)
        // 负控②：到点之后**不再**是"还压着的"
        const pendingAfterDue = await pendingCareDeferrals(db, characterId as never, tickOf(31_000) as never)

        notificationReadbacks = {
          reminderReserveCreated: firstReserve.created,
          sameKeySecondReserveCreated: secondReserveSameKey.created,
          careReserveCreated: careReserve.created,
          deferOnReminder,
          deferOnCare,
          pendingWhilePressed: pendingWhilePressed.length,
          pendingAfterDue: pendingAfterDue.length,
          repeatModeInDb: queryOf(TARGET_DB)(
            `select coalesce(string_agg(dedupe_key || '=' || coalesce(repeat_mode,'null'), ',' order by dedupe_key),'(none)') from notification_intents where dedupe_key like '${G08_MARK}%'`
          ),
        }
        observations.notification = notificationReadbacks
        })
      } catch (error) {
        boot1Failed = error instanceof Error ? `${error.message}` : String(error)
        observations.boot1Error = error instanceof Error ? error.stack : String(error)
      }

      /*
       * ⚠️ 这两步**无论上面的场景成败都要跑**（第一版把它们放在同一个 try 里 ⇒ 场景 A/B
       *    抛错后它们根本没执行 ⇒ "关库前读数"与"断连"双双缺失 ⇒ 8 条断言级联红）。
       */
      await isolated('afterSnapshot', async () => {
        after1 = snapshotOfTarget('boot1-after')
      })
      await isolated('closeScenario', async () => {
        if (runtime === undefined) return
        const handle = probeDb
        await closeDatabaseConnection(runtime)
        liveRuntime = undefined
        runtime = undefined
        try {
          await handle?.execute(sql`select 1 as one`)
        } catch {
          closedHandleRejected = true
        }
      })

      check('G08.1a ★ 核心 #1 在 PG 目标上启动成功，且记忆写入走的是真事件溯源路径', () => {
        assert.equal(boot1Failed, undefined, `核心 #1 失败：${boot1Failed ?? ''}`)
      })

      check('G08.1b ★ 记忆**增**：`MEMORY_CREATED` 落库，真 store（`getActiveByCanonicalKey`）读回 active', () => {
        const m = observations.memory as Record<string, unknown> | undefined
        assert.ok(m !== undefined, '记忆读数没拿到')
        assert.equal(m.createCreated, true, `事件没写进去：${JSON.stringify(m)}`)
        assert.equal(m.storeReadbackOk, true, `真 store 没读回 active 行：${JSON.stringify(m)}`)
      })

      check('G08.1c ★ 记忆写入**幂等**：同一事件再折一次 ⇒ `created:false`（投影不重复叠加）', () => {
        const m = observations.memory as Record<string, unknown>
        assert.equal(m.reapplyWasNoOp, true, '重复折叠没有被识别为 no-op')
      })

      check('G08.1d ★ 记忆**改**：`MEMORY_SUPERSEDED` ⇒ 旧行 `superseded` 且新行 `active`（可追溯）', () => {
        const statuses = String((observations.memory as Record<string, unknown>).statuses ?? '')
        assert.ok(statuses.includes(`mem-${G08_MARK}-v1=superseded`), `旧行状态不对：${statuses}`)
        assert.ok(statuses.includes(`mem-${G08_MARK}-v2=retracted`), `新行随后被撤回，状态不对：${statuses}`)
        assert.ok(statuses.includes('supersededBy=mem-g08-continuity-v2'), `supersededBy 没记：${statuses}`)
      })

      check('G08.1e ★ 记忆**撤回**：`MEMORY_RETRACTED` ⇒ 该行不再是 active', () => {
        const m = observations.memory as Record<string, unknown>
        assert.equal(m.retractCreated, true, '撤回事件没落库')
        const statuses = String(m.statuses ?? '')
        assert.ok(!/mem-g08-continuity-v2=active/.test(statuses), `撤回后仍是 active：${statuses}`)
      })

      check('G08.2a ★ 通知：`repeat_mode = until_reply` 真的落库（**跨重启靠这一列**）', () => {
        const n = observations.notification as Record<string, unknown> | undefined
        assert.ok(n !== undefined, '通知读数没拿到')
        assert.ok(
          String(n.repeatModeInDb).includes(`${G08_MARK}-dedupe-reminder=until_reply`),
          `repeat_mode 没写进去：${String(n.repeatModeInDb)}`
        )
      })

      check('G08.2b ★ 通知实例**幂等**：同一个 `occurrenceKey` 第二次 ⇒ `created:false`（同一次机会只产生一个外发尝试）', () => {
        const n = observations.notification as Record<string, unknown>
        assert.equal(n.reminderReserveCreated, true, '第一次占用没成功')
        assert.equal(n.sameKeySecondReserveCreated, false, '第二次占用竟然又成功了 ⇒ 会重复外发')
      })

      check('G08.2c ★ `deferred_until`：只对 `care` 生效（对 `reminder` 具名拒绝），且"还压着"与"到点"可区分', () => {
        const n = observations.notification as Record<string, unknown>
        assert.equal(
          (n.deferOnReminder as { ok: boolean; code?: string }).ok,
          false,
          '对 reminder 竟然允许改期 ⇒ 语义坏了'
        )
        assert.equal(
          (n.deferOnReminder as { code?: string }).code,
          'occurrence_defer_not_care',
          `拒绝原因不对：${JSON.stringify(n.deferOnReminder)}`
        )
        assert.equal((n.deferOnCare as { ok: boolean }).ok, true, `对 care 改期失败：${JSON.stringify(n.deferOnCare)}`)
        assert.equal(n.pendingWhilePressed, 1, `还压着时应有 1 条待办，实为 ${String(n.pendingWhilePressed)}`)
        assert.equal(n.pendingAfterDue, 0, `到点后不该还在待办里，实为 ${String(n.pendingAfterDue)}`)
      })

      check('G08.3a ★ 断连是真的：关库后**旧句柄**执行查询必须失败', () => {
        assert.equal(closedHandleRejected, true, '关库后旧句柄还能查 ⇒ "关库"是空话')
      })

      // ---------------------------------------------------------------------
      // 2) 核心 #2：同一个目标上再起一次（重启续跑 + 断连后数据仍在）
      // ---------------------------------------------------------------------
      let boot2Failed: string | undefined
      let after2: Record<string, unknown> = {}
      let memoryAfterRestart: Record<string, unknown> = {}
      let reserveAcrossRestart: { created: boolean } | undefined
      try {
        const boot = await bootKernel('pg-g08-boot2')
        runtime = boot.runtime
        const db = boot.db as unknown as Parameters<typeof appendDomainEvent>[0]
        const characterId = (boot.kernel as unknown as { characterId: string }).characterId
        after2 = snapshotOfTarget('boot2-after')

        const store = createNativeMemoryStore(db)
        const rows = await store.listByCanonicalKey(`${G08_MARK}:preference.answer_length`)
        memoryAfterRestart = {
          rows: rows.length,
          statuses: rows.map((row) => `${String(row.id)}=${String(row.status)}`).sort(),
          supersededByPresent: rows.some((row) => String(row.id) === `mem-${G08_MARK}-v1`),
        }
        // ★ 跨重启的"只发一次"：同一个 key 在**新核心**里仍然必须 created:false
        reserveAcrossRestart = await reserveOccurrence(db, {
          occurrenceKey: `${G08_MARK}-occ-reminder-1`,
          intentId: `${G08_MARK}-intent-reminder` as never,
          characterId: characterId as never,
          kind: 'reminder' as never,
          dueAt: (T0 + 10_000) as never,
          permissionVersion: 'g08@1',
          policyVersion: 'g08@1',
          now: (T0 + 40_000) as never,
        })
        observations.memoryAfterRestart = memoryAfterRestart
        observations.reserveAcrossRestart = reserveAcrossRestart
      } catch (error) {
        boot2Failed = error instanceof Error ? `${error.message}` : String(error)
        observations.boot2Error = error instanceof Error ? error.stack : String(error)
      } finally {
        if (runtime !== undefined) {
          try {
            await closeDatabaseConnection(runtime)
          } catch {
            /* 关不上由断言报 */
          }
          liveRuntime = undefined
        }
      }

      check('G08.4a ★ 核心 #2 在**同一个** PG 目标上启动成功（重启续跑）', () => {
        assert.equal(boot2Failed, undefined, `核心 #2 失败：${boot2Failed ?? ''}`)
      })

      check('G08.4b ★ 续跑：记忆状态与关库前**逐行一致**，且 supersede 链仍在', () => {
        const m = observations.memoryAfterRestart as Record<string, unknown> | undefined
        assert.ok(m !== undefined, '重启后的记忆读数没拿到')
        assert.deepEqual(
          m.statuses,
          [`mem-${G08_MARK}-v1=superseded`, `mem-${G08_MARK}-v2=retracted`],
          `重启后记忆状态变了：${JSON.stringify(m.statuses)}`
        )
        assert.equal(m.supersededByPresent, true, '带 supersededBy 的那一行丢了')
      })

      check('G08.4c ★ 续跑：领域事件数**没有增加**（重启不产生重复写入）· 投影摘要不变', () => {
        assert.equal(
          after2.domainEvents,
          after1.domainEvents,
          `领域事件数从 ${String(after1.domainEvents)} 变成 ${String(after2.domainEvents)} ⇒ 重启写入了东西`
        )
        assert.equal(
          after2.projectionDigest,
          after1.projectionDigest,
          '重启前后投影摘要不同 ⇒ 重启改了投影'
        )
      })

      check('G08.4d ★ 续跑：**水位**摘要不变（重启不抹掉、不回退消费水位）', () => {
        assert.equal(after2.watermarks, after1.watermarks, '水位行数变了')
        assert.equal(after2.watermarkDigest, after1.watermarkDigest, '水位摘要变了')
      })

      check('G08.4e ★ 续跑：通知意图与实例**跨重启存活**，且同键占用仍 `created:false`（不重复外发）', () => {
        assert.equal(after2.g08Intents, after1.g08Intents, '重启后本门造的通知意图数变了')
        assert.equal(after2.g08Occurrences, after1.g08Occurrences, '重启后实例行数变了')
        assert.equal(after2.g08RepeatModes, after1.g08RepeatModes, 'repeat_mode 没跨重启存活')
        assert.equal(after2.g08Deferrals, after1.g08Deferrals, 'deferred_until 没跨重启存活')
        assert.equal(
          reserveAcrossRestart?.created,
          false,
          '**跨重启**之后同一个 occurrenceKey 竟然又能占用了 ⇒ 重启会重复外发'
        )
      })

      check('G08.4f ★ 断连不丢数据：关库→重连后，本门写入的行仍全部可读', () => {
        assert.equal(after2.memoryMarked, after1.memoryMarked, '断连后本门的记忆行数变了')
        assert.equal(after2.memoryDigest, after1.memoryDigest, '断连后记忆摘要变了')
        assert.equal(after2.g08Occurrences, after1.g08Occurrences, '断连后通知实例行数变了')
      })

      // ---------------------------------------------------------------------
      // 2b) 核心 #3：**后台消费者真实 tick**（隔离 provider）+ **双入口路由**
      // ---------------------------------------------------------------------
      let boot3Failed: string | undefined
      let consumerReadings: Record<string, unknown> = {}
      let routingReadings: Record<string, unknown> = {}
      try {
        const boot = await bootKernel('pg-g08-boot3')
        runtime = boot.runtime
        const db = boot.db as unknown as Parameters<typeof appendDomainEvent>[0]
        const characterId = (boot.kernel as unknown as { characterId: string }).characterId
        const tick3 = (offset: number): number => T0 + offset

        /** 水位读数：`processor -> processed_through_sequence`（用于**逐条**比较有没有回退/前进） */
        const readWatermarkMap = (): Record<string, number> => {
          /*
           * ⚠️ 列名是 `processed_through_sequence`（不是 `last_sequence`）—— 第一版写错了列名，
           *    查询失败 ⇒ 读数变成空 map ⇒ `G08.6d` 的**前置**先红（"一条水位都没有"）。
           *    ⇒ 纪律：读别人的表之前先核列名（`job-store.ts:384` 的 insert 列清单是权威）。
           */
          const raw = queryOf(TARGET_DB)(
            'select processor||\'|\'||processor_version||\'|\'||processed_through_sequence::text from processor_watermarks order by processor, processor_version'
          ) ?? ''
          const map: Record<string, number> = {}
          for (const line of raw.split('\n')) {
            const parts = line.trim().split('|')
            if (parts.length === 3 && parts[0] !== '') {
              map[`${parts[0]}@${parts[1]}`] = Number(parts[2])
            }
          }
          return map
        }
        const projectionDigestOf = (): string =>
          queryOf(TARGET_DB)(
            "select coalesce(md5(string_agg(projection_type||'|'||revision::text, ',' order by projection_type)),'(none)') from character_projections"
          ) ?? '(query failed)'
        const eventCountOf = (): number =>
          Number(queryOf(TARGET_DB)('select count(*) from character_domain_events') ?? '0')

        // ================= 场景 F：后台消费者（独立兜底）=================
        await isolated('consumerScenario', async () => {
          /*
           * ⚠️ **隔离 provider**：本门自己造的假 provider，**只**在进程内被调用。
           *    `endpointHost` 用 `.invalid`（RFC 2606 保留域）⇒ 就算有人误把它当真的去解析，
           *    也**不可能**出站到任何真实服务。契约要求"真 PG + **隔离 provider**"。
           */
          const providerCalls: string[] = []
          const isolatedProvider: AffectSemanticProvider = {
            id: 'g08-isolated-fake',
            endpointHost: 'g08.invalid',
            call: async (input) => {
              providerCalls.push(input.outboundText)
              return {
                ok: true,
                requestCount: 1,
                envelope: {
                  content: JSON.stringify({
                    decision: 'NEUTRAL',
                    target: 'CHARACTER',
                    candidates: [],
                    contextRefs: [],
                    reasonCode: 'ORDINARY_INTERACTION',
                  }),
                  finishReason: 'stop',
                  hasToolCalls: false,
                },
                shape: {
                  httpStatus: 200,
                  choiceCount: 1,
                  messagePresent: true,
                  contentKind: 'string',
                  contentLength: 0,
                  finishReason: 'stop',
                  toolCallCount: 0,
                  refusalPresent: false,
                  bodyWasJson: true,
                  promptTokens: null,
                  completionTokens: null,
                  reasoningTokens: null,
                  headersMs: 0,
                  bodyMs: 0,
                  totalMs: 0,
                  retryAfterMs: -1,
                },
              }
            },
          }

          const seed = await seedAffectOrigin(db, {
            characterId,
            activationId: `${G08_MARK}-consumer`,
            /* ⚠️ 恢复出来的库里那一行是 `affect-reducer@2`（`G06.1c` 的读数）⇒ 必须同版本，
               否则版本守卫会拒（"同一投影行全程同一版本"）。 */
            affectReducerVersion: 2,
            now: tick3(50_000),
          })

          /*
           * `activeUserId`：从库里**读**出来（不猜、也不打印）—— 取 user_message 里最常见的 actor。
           * ⚠️ 它是真实标识 ⇒ **只当参数用，绝不写进证据**。
           */
          const activeUserId =
            queryOf(TARGET_DB)(
              "select actor_id from conversation_events where type = 'user_message' and actor_id is not null group by actor_id order by count(*) desc limit 1"
            ) ?? ''

          const watermarksBefore = readWatermarkMap()
          const projectionBefore = projectionDigestOf()
          const eventsBefore = eventCountOf()

          // 负控：`mode:'rules'` ⇒ worker **具名 no-op**，且**一次 provider 都不该调**
          const rulesTick = await maybeRunAffectSemanticEvaluation(db, {
            characterId,
            characterAlias: 'g08',
            activeUserId,
            mode: 'rules',
            provider: isolatedProvider,
            now: tick3(51_000),
          })
          const providerCallsAfterRules = providerCalls.length

          /*
           * ★ 让消费者**真的有尾巴可扫**：往**已有的**那条会话里追加一条**合格来源**
           *   （`user_message` + **受信归因**信封）。
           *   ⚠️ 第一版没有这一步 ⇒ 第一次 semantic tick 的结局是 `no_tail`
           *      （水位已在尾巴上）—— 那本身是个**好读数**（说明它按水位续跑、不重扫），
           *      但它**没有**走到"扫描 → 入队 → 调 provider → 提交"那一段。
           *      现在补上，判据才真的量到消费者处理新来源。
           */
          const lastEvent = queryOf(TARGET_DB)(
            'select conversation_id||\'|\'||conversation_sequence::text from conversation_events order by sequence desc limit 1'
          ) ?? ''
          const [legacyConversation, legacySeqText] = lastEvent.split('|')
          const ingress = createHumanConsoleUserTurnIngress()
          await appendConversationEvent(db, {
            characterId: characterId as never,
            conversationId: (legacyConversation ?? '') as never,
            conversationSequence: Number(legacySeqText ?? '0') + 1,
            type: 'user_message' as never,
            actorType: 'user' as never,
            actorId: activeUserId,
            content: `${G08_MARK}-consumer-source`,
            createdAt: tick3(51_500),
            trustedAttribution: ingress.attest({
              characterId: String(characterId),
              presenterActorId: activeUserId,
              userId: activeUserId,
            }) as never,
          })

          // 正控：`mode:'semantic'` ⇒ 真跑一轮（provider 是隔离的）
          const tick1 = await maybeRunAffectSemanticEvaluation(db, {
            characterId,
            characterAlias: 'g08',
            activeUserId,
            mode: 'semantic',
            provider: isolatedProvider,
            now: tick3(52_000),
          })
          const providerCallsAfterTick1 = providerCalls.length
          const eventsAfterTick1 = eventCountOf()
          // 幂等：同一批来源再跑一轮 ⇒ 不该再提交
          const tick2 = await maybeRunAffectSemanticEvaluation(db, {
            characterId,
            characterAlias: 'g08',
            activeUserId,
            mode: 'semantic',
            provider: isolatedProvider,
            now: tick3(53_000),
          })
          const eventsAfterTick2 = eventCountOf()
          const watermarksAfter = readWatermarkMap()
          const projectionAfter = projectionDigestOf()

          const countersOf = (tick: unknown): Record<string, unknown> => {
            const t = tick as Record<string, unknown>
            return {
              kind: t.kind,
              scanned: t.scanned ?? null,
              skippedUnqualified: t.skippedUnqualified ?? null,
              processed: t.processed ?? null,
              committed: t.committed ?? null,
              noImpact: t.noImpact ?? null,
              terminalFailed: t.terminalFailed ?? null,
            }
          }
          consumerReadings = {
            providerId: isolatedProvider.id,
            providerEndpointHost: isolatedProvider.endpointHost,
            realModelCalls: 0,
            activeUserIdResolved: activeUserId !== '',
            seedKind: (seed as { kind?: string }).kind,
            rulesTick: countersOf(rulesTick),
            providerCallsAfterRules,
            tick1: countersOf(tick1),
            tick2: countersOf(tick2),
            providerCallsTotal: providerCalls.length,
            providerCallsAfterTick1,
            eventsBefore,
            eventsAfterTick1,
            eventsAfterTick2,
            watermarksBefore,
            watermarksAfter,
            projectionBefore,
            projectionAfter,
          }
          observations.consumer = consumerReadings
        })

        // ================= 场景 G：双入口路由（独立兜底）=================
        await isolated('routingScenario', async () => {
          const slug = 'g08slug'
          const userHash8 = 'g08hash8'
          const at = (entry: 'cli' | 'qq_private' | 'avatar', entryScoped: boolean): string =>
            String(conversationIdForEntry({ slug, userHash8, entry, entryScoped }))

          const offCli = at('cli', false)
          const offQq = at('qq_private', false)
          const offAvatar = at('avatar', false)
          const onCli = at('cli', true)
          const onQq = at('qq_private', true)
          const onAvatar = at('avatar', true)

          const modeMap = {
            qqMode: chatEntryKeyOfMode('interactive_human_qq_private'),
            scriptedMode: chatEntryKeyOfMode('scripted_agent_runner'),
            consoleMode: chatEntryKeyOfMode('interactive_human_console'),
            consoleWithBridge: chatEntryKeyOfMode('interactive_human_console', { bridgeEntry: true }),
          }

          /*
           * 库层：把同一条用户消息写进**两个不同入口**的会话，看它们是不是真的**分开的**。
           * ⚠️ 新会话 id ⇒ 序号从 1 起；内容是本门自己的标记（不含任何真实对话）。
           */
          const appendInto = async (conversationId: string, content: string): Promise<void> => {
            await appendConversationEvent(db, {
              characterId: characterId as never,
              conversationId: conversationId as never,
              conversationSequence: 1,
              type: 'user_message' as never,
              actorType: 'user' as never,
              content,
              createdAt: tick3(60_000),
            })
          }
          await appendInto(onQq, `${G08_MARK}-route-qq`)
          await appendInto(onAvatar, `${G08_MARK}-route-avatar`)

          const routeRows =
            queryOf(TARGET_DB)(
              `select conversation_id||'|'||content from conversation_events where content like '${G08_MARK}-route-%' order by content`
            ) ?? ''
          const perConversation = routeRows
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')

          routingReadings = {
            offCli,
            offQq,
            offAvatar,
            onCli,
            onQq,
            onAvatar,
            legacySuffix: '-qq',
            modeMap,
            routeRows: perConversation,
            qqConversationRows: Number(
              queryOf(TARGET_DB)(
                `select count(*) from conversation_events where conversation_id = '${onQq}'`
              ) ?? '0'
            ),
            avatarConversationRows: Number(
              queryOf(TARGET_DB)(
                `select count(*) from conversation_events where conversation_id = '${onAvatar}'`
              ) ?? '0'
            ),
            cliConversationRows: Number(
              queryOf(TARGET_DB)(
                `select count(*) from conversation_events where conversation_id = '${onCli}' and content like '${G08_MARK}-route-%'`
              ) ?? '0'
            ),
          }
          observations.routing = routingReadings
        })
      } catch (error) {
        boot3Failed = error instanceof Error ? `${error.message}` : String(error)
        observations.boot3Error = error instanceof Error ? error.stack : String(error)
      } finally {
        if (runtime !== undefined) {
          try {
            await closeDatabaseConnection(runtime)
          } catch {
            /* 关不上由断言报 */
          }
          liveRuntime = undefined
          runtime = undefined
        }
      }

      check('G08.6a ★ 后台消费者：核心 #3 起得来，且 `mode` 闸真的关着（`rules` ⇒ 具名 no-op、**0 次 provider 调用**）', () => {
        assert.equal(boot3Failed, undefined, `核心 #3 失败：${boot3Failed ?? ''}`)
        const c = observations.consumer as Record<string, unknown> | undefined
        assert.ok(c !== undefined, '消费者读数没拿到')
        assert.equal(
          (c.rulesTick as { kind?: string }).kind,
          'mode_not_semantic',
          `rules 档竟然不是具名 no-op：${JSON.stringify(c.rulesTick)}`
        )
        assert.equal(c.providerCallsAfterRules, 0, `rules 档竟然调了 provider（${String(c.providerCallsAfterRules)} 次）`)
      })

      check('G08.6b ★ 后台消费者：`semantic` 档真的**处理了新来源**（隔离 provider 被调用，0 次真实模型调用）', () => {
        const c = observations.consumer as Record<string, unknown>
        assert.equal(c.providerId, 'g08-isolated-fake', '用的不是本门的隔离 provider')
        assert.equal(c.providerEndpointHost, 'g08.invalid', `provider 主机不是保留域：${String(c.providerEndpointHost)}`)
        assert.equal(c.realModelCalls, 0, '发生了真实模型调用')
        const tick1 = c.tick1 as Record<string, unknown>
        assert.equal(tick1.kind, 'ran', `semantic 档的结局不是"跑了"：${JSON.stringify(tick1)}`)
        assert.ok(Number(tick1.scanned) >= 1, `扫描到的事件数为 ${String(tick1.scanned)} ⇒ 没量到"处理新来源"`)
        assert.ok(
          Number(c.providerCallsAfterTick1) >= 1,
          `隔离 provider 一次都没被调用（${String(c.providerCallsAfterTick1)}）⇒ 没有走到"出站"那一段`
        )
      })

      check('G08.6c ★ 后台消费者**幂等**：同一批来源再跑一轮 ⇒ 领域事件数**不再增加**', () => {
        const c = observations.consumer as Record<string, unknown>
        assert.equal(
          c.eventsAfterTick2,
          c.eventsAfterTick1,
          `第二轮又写了事件（${String(c.eventsAfterTick1)} → ${String(c.eventsAfterTick2)}）⇒ 消费者不幂等`
        )
      })

      check('G08.6d ★ 后台消费者**水位只进不退**：逐条比较 `processor@version -> processed_through_sequence`', () => {
        const c = observations.consumer as Record<string, unknown>
        const before = c.watermarksBefore as Record<string, number>
        const after = c.watermarksAfter as Record<string, number>
        assert.ok(Object.keys(before).length > 0, '前置：跑之前一条水位都没有 ⇒ 这条判据没量到东西')
        const regressed: string[] = []
        let advanced = 0
        for (const [key, sequence] of Object.entries(before)) {
          const now = after[key]
          if (now === undefined || now < sequence) regressed.push(`${key}: ${sequence} → ${String(now)}`)
          else if (now > sequence) advanced += 1
        }
        assert.deepEqual(regressed, [], `有水位回退了：${regressed.join('；')}`)
        assert.ok(advanced >= 1, '跑了一轮消费者，却**一条水位都没有前进** ⇒ 它没有真的消费到东西')
      })

      check('G08.7a ★ 双入口路由（纯函数）：开关**关着**时三条入口得到**同一个**会话（今天的行为）', () => {
        const r = observations.routing as Record<string, unknown> | undefined
        assert.ok(r !== undefined, '路由读数没拿到')
        assert.equal(r.offQq, r.offCli, '开关关着时 qq 竟然与 cli 不同')
        assert.equal(r.offAvatar, r.offCli, '开关关着时 avatar 竟然与 cli 不同')
      })

      check('G08.7b ★ 双入口路由（纯函数）：开关**开着**时 cli 逐字不变、qq/avatar 各自不同', () => {
        const r = observations.routing as Record<string, unknown>
        assert.equal(r.onCli, r.offCli, 'cli 的会话 id 在开关打开后变了（应当逐字不变）')
        assert.equal(r.onQq, `${String(r.offCli)}-qq`, `qq 会话 id 不对：${String(r.onQq)}`)
        assert.equal(r.onAvatar, `${String(r.offCli)}-avatar`, `avatar 会话 id 不对：${String(r.onAvatar)}`)
        assert.equal(new Set([r.onCli, r.onQq, r.onAvatar]).size, 3, '三个入口没有互不相同')
      })

      check('G08.7c ★ 入口键推导：QQ 私聊 ⇒ `qq_private`；脚本 ⇒ `cli`；控制台**按 `--bridge` 分档**', () => {
        const map = (observations.routing as Record<string, unknown>).modeMap as Record<string, string>
        assert.equal(map.qqMode, 'qq_private', `qq 模式推错了：${map.qqMode}`)
        assert.equal(map.scriptedMode, 'cli', `脚本模式推错了：${map.scriptedMode}`)
        assert.equal(map.consoleMode, 'cli', `控制台（无 bridge）推错了：${map.consoleMode}`)
        assert.equal(
          map.consoleWithBridge,
          'avatar',
          `控制台（有 bridge）推错了：${map.consoleWithBridge} —— 只看 entryMode 会让皮套的两种连法落到两条会话`
        )
      })

      check('G08.7d ★ 双入口路由（库层）：两个入口的消息**真的落在两条不同的会话里**，互不串味', () => {
        const r = observations.routing as Record<string, unknown>
        assert.equal(r.qqConversationRows, 1, `qq 会话里应有 1 条本门的消息，实为 ${String(r.qqConversationRows)}`)
        assert.equal(
          r.avatarConversationRows,
          1,
          `avatar 会话里应有 1 条本门的消息，实为 ${String(r.avatarConversationRows)}`
        )
        assert.equal(r.cliConversationRows, 0, `cli 会话里不该有本门的消息，实为 ${String(r.cliConversationRows)}`)
        const rows = r.routeRows as string[]
        assert.equal(rows.length, 2, `本门的路由消息应恰好 2 条，实为 ${rows.length}`)
      })

      // ---------------------------------------------------------------------
      // 3) 外部发送在测试中受控
      // ---------------------------------------------------------------------
      const qqEnvNames = Object.keys(process.env).filter((name) =>
        /^(QQ_|NAPCAT|ONEBOT|ONE_BOT|LIVE2D|COEXIST)/i.test(name)
      )
      observations.outbound = {
        outboundAttempts: outboundAttempts.length,
        deliveryChannelsConstructed: 0,
        qqProcessesSpawned: 0,
        qqEnvNamesPresent: qqEnvNames,
        note:
          '本门**从不**构造投递通道/适配器，也不起任何 QQ / NapCat 进程；' +
          '读到的环境变量名只被记录（**不读值**）。⇒ 没有任何测试消息会发向真实联系人。',
      }

      check('G08.5a ★ 外部发送在测试中受控：本门**没有**构造任何投递通道，也没有起 QQ 进程', () => {
        const o = observations.outbound as Record<string, unknown>
        assert.equal(o.deliveryChannelsConstructed, 0, '构造了投递通道 ⇒ 可能真的外发')
        assert.equal(o.qqProcessesSpawned, 0, '起了 QQ 进程')
        const spawnedQq = spawnSync('docker', ['ps', '--filter', 'name=napcat', '--format', '{{.Names}}'], {
          encoding: 'utf8',
          timeout: 30_000,
        })
        void spawnedQq
      })

      check('G08.5b ★ 读数里 `outboundAttempts === 0`，且不含任何真实联系人标识', () => {
        const o = observations.outbound as Record<string, unknown>
        assert.equal(o.outboundAttempts, 0, `有 ${String(o.outboundAttempts)} 次外发尝试`)
        const text = JSON.stringify(observations)
        for (const forbidden of ['@qq.com', 'group_id', 'friend_id', 'uin:']) {
          assert.ok(!text.includes(forbidden), `读数里出现了疑似真实联系人字段 ${forbidden}`)
        }
      })

      // 具名未运行（缺证据 ⇒ 拒收，**不**报 PASS）
      /*
       * 2026-10-13：原先这里有两条具名未运行（`g08.6` 后台消费者长跑 · `g08.7` 双入口路由）。
       * 两条**已实现**（见 §2b：核心 #3 上的消费者真实 tick + 路由的纯函数层与库层）。
       * ⚠️ 仍然**不主张**"消费者长跑"：本门跑的是**两轮 tick**（幂等 + 水位不回退），
       *    不是"跑一段时间的 tick 循环 + 在飞任务"——那一条仍是 `L-PGW5-15`。
       */
      observations.consumerScope = {
        whatThisProves: '消费者在 PG 上能起、mode 闸真的关着、隔离 provider 无真实调用、两轮幂等、水位不回退',
        whatThisDoesNotProve: '长跑（真实 tick 循环 + 在飞任务 + 崩溃恢复窗口）—— 见 L-PGW5-15',
      }
    } catch (error) {
      checks.push({
        name: 'g08.§ 意外中断',
        pass: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      })
    } finally {
      if (liveRuntime !== undefined) {
        try {
          await closeDatabaseConnection(liveRuntime)
        } catch {
          /* 尽力关 */
        }
      }
      const dropped = manageTestDb('drop-test-db.sql')
      check('G08.9a 本门自建的测试库已清理', () => {
        assert.equal(dropped.rc, 0, dropped.err)
      })
      const productionAfter = productionDirFingerprint()
      observations.productionDir = { before: productionBefore, after: productionAfter }
      check('G08.9z ★★ 真实库目录**逐字未动**（核心对着的是隔离目标，不是真实库）', () => {
        assert.equal(productionAfter.files, productionBefore.files, '真实库文件数变了')
        assert.equal(productionAfter.digest, productionBefore.digest, '真实库 (路径,大小) 摘要变了')
        assert.equal(productionAfter.newestMtimeMs, productionBefore.newestMtimeMs, '真实库有文件被写过')
      })
    }
  }

  const passed = checks.filter((entry) => entry.pass).length
  const failed = checks.length - passed
  const evidence = {
    gate: 'postgresql:g08:verify',
    scope: 'WP5 功能整链与回归（记忆增改撤回 · 认知恢复 · 通知 · 重启续跑 · 外部发送受控）',
    runId: RUN_ID,
    startedAtUtc: new Date().toISOString(),
    startedAtUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    head: (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim(),
    container: CONTAINER,
    hostPort: HOST_PORT,
    sourceSnapshot: SOURCE_SNAPSHOT,
    targetDb: TARGET_DB,
    pinnedTools: PINNED_TOOLS_VERSION,
    restoreArgs: RESTORE_ARGS,
    checks,
    notRun,
    observations,
    counts: { measured: checks.length, passed, failed, notRun: notRun.length },
    commands,
  }
  writeFileSync(join(EVIDENCE_DIR, 'g08-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  JSON.parse(readFileSync(join(EVIDENCE_DIR, 'g08-evidence.json'), 'utf8'))

  const memory = (observations.memory ?? {}) as Record<string, unknown>
  const notification = (observations.notification ?? {}) as Record<string, unknown>

  console.log('')
  console.log('PG-G08 功能整链与回归（WP5）')
  console.log('─'.repeat(86))
  console.log(`  runId    : ${RUN_ID}`)
  console.log(`  目标     : ${TARGET_DB}（宿主 ${HOST_PORT}）· 从 verified 快照恢复`)
  console.log(`  证据     : artifacts/post-lv2/postgresql-migration/${RUN_ID}/`)
  console.log('─'.repeat(86))
  for (const entry of checks) {
    console.log(`  ${entry.pass ? 'PASS' : 'FAIL'}  ${entry.name}`)
    if (!entry.pass && entry.detail !== undefined) console.log(`        └─ ${entry.detail}`)
  }
  console.log('─'.repeat(86))
  console.log(`  记忆增改撤回 : ${JSON.stringify({ create: memory.createCreated, reapplyNoOp: memory.reapplyWasNoOp, statuses: String(memory.statuses).slice(0, 120) })}`)
  console.log(`  通知         : ${JSON.stringify({ reserve: notification.reminderReserveCreated, sameKeyAgain: notification.sameKeySecondReserveCreated, deferOnReminder: notification.deferOnReminder, pendingWhilePressed: notification.pendingWhilePressed, pendingAfterDue: notification.pendingAfterDue })}`)
  console.log(`  重启续跑     : ${JSON.stringify((observations.memoryAfterRestart ?? {}) as Record<string, unknown>)}`)
  console.log(`  外部发送     : ${JSON.stringify((observations.outbound ?? {}) as Record<string, unknown>)}`)
  console.log('─'.repeat(86))
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
