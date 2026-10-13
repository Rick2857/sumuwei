/**
 * PostgreSQL 迁移 WP5：**有限真模型 smoke**（契约：`真 PG + 隔离 provider / 有限真模型`）。
 *
 * ============================================================================
 *  它是什么（以及**刻意不是什么**）
 * ============================================================================
 * ```text
 *   是   ：在**隔离 PG 目标**（从 verified 快照恢复）上起真核心，让**真模型**真的被调用
 *          **一次**，并把这一轮消费者 tick 的具名结局如实记下来。
 *   不是 ：接受性评测（不是"她答得好不好"）、不是长轨迹、不是语义质量读数。
 *          ⇒ 它**只**回答一件事：**"在 PG 后端上，真模型这条路真的通"**。
 * ```
 *
 *  ⚠️ 与 `PG-G08` 的关系：G08 的消费者场景用的是**隔离 provider**（`g08.invalid`，绝不出站）。
 *     本 smoke **只换 provider**，其余（建库、恢复、起核心、造合格来源、tick）**逐字相同** ——
 *     这样"通/不通"的差异就只可能来自真模型那一段。
 *
 *  ⚠️ **必须**通过 `pnpm with-test-model` 跑（它会把 `.env.test` 覆盖到进程环境）：
 *     `pnpm with-test-model pnpm postgresql:live:smoke`
 *     不带那个包装器 ⇒ 用 `DSH_TEST_MODEL_WRAPPER` 判出来并**拒绝**（失败关闭，绝不回落到生产 key）。
 *
 *  ⚠️ 外部发送在测试中受控：本程序**从不**构造投递通道、不起 QQ 进程。
 *
 * 跑法：pnpm with-test-model pnpm postgresql:live:smoke
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
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { closeDatabaseConnection } from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { maybeRunAffectSemanticEvaluation } from '../src/infrastructure/runtime/affect-semantic-scheduler.ts'
import { seedAffectOrigin } from '../src/infrastructure/runtime/affect-scheduler.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { createOpenAiAffectSemanticProvider } from '../src/infrastructure/model/affect-semantic-provider.ts'

import {
  PG_CONTAINER,
  PG_CREDENTIALS_FILE,
  PG_HOST_PORT,
  loadPgCredentials,
  missingCredentialKeys,
} from './postgresql/credentials.ts'
import { psql, psqlFile, psqlFromStdin } from './postgresql/pg-exec.ts'
import { dumpPgliteSnapshot, EXPORT_RUNTIME_DIR } from './postgresql/pglite-dump.ts'
import { productionDirFingerprint } from './postgresql/production-fingerprint.ts'
import { liveSmokeSource } from './live-smoke-source.ts'

const CONTAINER = PG_CONTAINER
const HOST_PORT = PG_HOST_PORT
const TARGET_DB = 'lg_test_livesmoke'
const MIGRATE_USER = 'lg_migrate'
const MIGRATE_ROLE = 'lg_migrate'
const MARK = 'pg-live-smoke'
const T0 = Date.UTC(2026, 9, 13, 13, 0, 0)

const LOCAL_DIR = resolve('artifacts/post-lv2/local/pg-migration')
const RESTORE_SQL = resolve(LOCAL_DIR, 'live-smoke-restore.sql')
const RESTORE_ARGS = ['--no-owner', '--no-privileges', '--no-comments']

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const RUN_ID = `pg-migration-live-smoke-${stamp}`
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

  /*
   * ① **必须**经由 `with-test-model` 包装器 ⇒ 否则拒绝（绝不回落到生产 key）。
   *    判据用包装器自己设的标记（`run-with-test-model.ts` 会设 `DSH_TEST_MODEL_WRAPPER=1`）。
   */
  const wrapped = process.env.DSH_TEST_MODEL_WRAPPER === '1'
  const credentials = loadPgCredentials()
  const missingKeys = credentials === undefined ? ['(凭据文件缺失)'] : missingCredentialKeys(credentials)
  const source = ((): ReturnType<typeof liveSmokeSource> | undefined => {
    try {
      return liveSmokeSource(process.argv)
    } catch (error) {
      observations.sourceError = error instanceof Error ? error.message : String(error)
      return undefined
    }
  })()

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
    !wrapped
      ? '没有经 `pnpm with-test-model` 跑（缺 DSH_TEST_MODEL_WRAPPER=1）⇒ 拒绝，绝不回落到生产 key'
      : credentials === undefined
        ? `凭据文件不存在：${PG_CREDENTIALS_FILE}`
        : missingKeys.length > 0
          ? `凭据文件缺这些 key：${missingKeys.join(', ')}`
          : !instanceUp
            ? `容器 ${CONTAINER} 不可达`
            : source === undefined
              ? `来源没选出来：${String(observations.sourceError ?? '?')}`
              : !exportRuntimeReady
                ? `导出工具运行时未就绪：${EXPORT_RUNTIME_DIR}`
                : undefined

  if (blocked !== undefined) {
    notRun.push({ id: 'live-smoke', what: '有限真模型 smoke（隔离 PG + 真模型一次调用）', why: blocked })
  } else {
    const password = credentials!.LG_PG_MIGRATE_PASSWORD
    const queryOf = (database: string, sqlText: string): string | undefined => {
      const r = psql({ container: CONTAINER, user: MIGRATE_USER, password, database, sql: sqlText, timeoutMs: 600_000 })
      return r.rc === 0 ? r.out : undefined
    }
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
      const dump = await dumpPgliteSnapshot({ sourceDir: source!.directory, args: RESTORE_ARGS, outFile: RESTORE_SQL })
      const restore = psqlFromStdin({
        container: CONTAINER,
        user: MIGRATE_USER,
        password,
        database: TARGET_DB,
        sql: dump.sql,
        timeoutMs: 900_000,
      })
      check('L01 前置：PG 目标从**已验证来源**恢复成功（exit 0 且无 ERROR）', () => {
        if (created.rc !== 0) throw new Error(created.err)
        if (restore.rc !== 0) throw new Error(restore.err.slice(0, 400))
        if (/^ERROR/m.test(restore.err)) throw new Error(`恢复日志里有 ERROR：${restore.err.slice(0, 400)}`)
      })

      const url = `postgresql://${MIGRATE_USER}:${encodeURIComponent(password)}@127.0.0.1:${HOST_PORT}/${TARGET_DB}`
      process.env.CHARACTER_DB_BACKEND = 'postgres'
      process.env.LG_PG_EXPECT_DATABASE = TARGET_DB
      process.env.LG_PG_EXPECT_DATABASE_PREFIX = 'lg_test_'
      const sandbox = isolateDatabase('postgresql-live-smoke', { postgres: { url } })
      const fallback = resolve(sandbox.dir, 'pglite-fallback')
      mkdirSync(fallback, { recursive: true })
      process.env.PGLITE_DATA_DIR = fallback

      const created2 = new AgentRuntime({
        character: character as Character,
        plugins: [],
        settings: { POSTGRES_URL: url },
      })
      runtime = created2
      await initDatabase(created2, sqlPlugin)
      await created2.initialize()
      const kernel = await initKernel(created2, { definition: characterDefinitionFromCharacter(character) })
      const db = kernel.stores.db as never
      const characterId = kernel.characterId as unknown as string

      check('L02 前置：真核心在隔离 PG 目标上起得来（且隔离判据给的是 postgres）', () => {
        if (sandbox.backend !== 'postgres') throw new Error(`隔离后端不是 postgres：${sandbox.backend}`)
      })

      await seedAffectOrigin(db, {
        characterId: characterId as never,
        activationId: `${MARK}-activate`,
        affectReducerVersion: 2,
        now: T0,
      })

      // 造**一条**合格来源（带受信归因）—— 与 `PG-G08` 的消费者场景同一形状
      const activeUserId =
        queryOf(
          TARGET_DB,
          "select actor_id from conversation_events where type = 'user_message' and actor_id is not null group by actor_id order by count(*) desc limit 1"
        ) ?? ''
      const last = queryOf(
        TARGET_DB,
        "select conversation_id||'|'||conversation_sequence::text from conversation_events order by sequence desc limit 1"
      ) ?? ''
      const [conversationId, seqText] = last.split('|')
      const ingress = createHumanConsoleUserTurnIngress()
      await appendConversationEvent(db, {
        characterId: characterId as never,
        conversationId: (conversationId ?? '') as never,
        conversationSequence: Number(seqText ?? '0') + 1,
        type: 'user_message' as never,
        actorType: 'user' as never,
        actorId: activeUserId,
        /* ⚠️ 内容是本程序自己的**夹具文本**（不含任何真实对话）—— 且刻意是"中性"的一句。 */
        content: '今天天气还行。',
        createdAt: T0 + 1_000,
        trustedAttribution: ingress.attest({
          characterId: String(characterId),
          presenterActorId: activeUserId,
          userId: activeUserId,
        }) as never,
      })

      // ★ 真模型：**唯一**与 `PG-G08` 不同的一处 —— provider 换成真的
      const provider = createOpenAiAffectSemanticProvider()
      observations.provider = { id: provider.id, endpointHost: provider.endpointHost }

      const eventsBefore = Number(queryOf(TARGET_DB, 'select count(*) from character_domain_events') ?? '0')
      const startedAt = Date.now()
      const tick = await maybeRunAffectSemanticEvaluation(db, {
        characterId: characterId as never,
        characterAlias: 'livesmoke',
        activeUserId,
        mode: 'semantic',
        provider,
        now: T0 + 2_000,
      })
      const elapsedMs = Date.now() - startedAt
      const eventsAfter = Number(queryOf(TARGET_DB, 'select count(*) from character_domain_events') ?? '0')

      const t = tick as Record<string, unknown>
      observations.tick = {
        kind: t.kind,
        scanned: t.scanned ?? null,
        skippedUnqualified: t.skippedUnqualified ?? null,
        processed: t.processed ?? null,
        committed: t.committed ?? null,
        noImpact: t.noImpact ?? null,
        rejectedByValidator: t.rejectedByValidator ?? null,
        terminalFailed: t.terminalFailed ?? null,
        retryableDeferred: t.retryableDeferred ?? null,
      }
      observations.elapsedMs = elapsedMs
      observations.events = { before: eventsBefore, after: eventsAfter }

      check('L03 ★ 真模型**真的被调用**了（tick 走到 `ran`，且处理了 1 条来源）', () => {
        const tick1 = observations.tick as Record<string, unknown>
        if (tick1.kind !== 'ran') throw new Error(`tick 结局不是 ran：${JSON.stringify(tick1)}`)
        if (Number(tick1.scanned) < 1) throw new Error(`扫描到 ${String(tick1.scanned)} 条 ⇒ 没走到真模型那一段`)
      })

      check('L04 ★ 真模型这一轮的结局是**具名的**（不是抛异常、也不是静默）', () => {
        const tick1 = observations.tick as Record<string, unknown>
        const named =
          Number(tick1.committed) + Number(tick1.noImpact) + Number(tick1.rejectedByValidator) + Number(tick1.terminalFailed) + Number(tick1.retryableDeferred)
        if (!(named >= 1)) {
          throw new Error(`这一轮没有任何具名结局（committed/noImpact/rejected/terminalFailed/retryableDeferred 全 0）：${JSON.stringify(tick1)}`)
        }
      })

      check('L05 ★ 外部发送在测试中受控：没有投递通道、没有 QQ 进程、也没有向真实联系人发消息', () => {
        const qq = spawnSync('docker', ['ps', '--filter', 'name=napcat', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 30_000 })
        observations.qqContainers = (qq.stdout ?? '').trim()
        if ((qq.stdout ?? '').trim() !== '') throw new Error(`有 NapCat 容器在跑：${(qq.stdout ?? '').trim()}`)
      })

      await closeDatabaseConnection(runtime)
      runtime = undefined
    } catch (error) {
      checks.push({ name: 'live.§ 意外中断', pass: false, detail: error instanceof Error ? (error.stack ?? error.message) : String(error) })
    } finally {
      if (runtime !== undefined) {
        try {
          await closeDatabaseConnection(runtime)
        } catch {
          /* 尽力关 */
        }
      }
      const dropped = manageTestDb('drop-test-db.sql')
      check('L09a 本 smoke 自建的测试库已清理', () => {
        if (dropped.rc !== 0) throw new Error(dropped.err)
      })
      const productionAfter = productionDirFingerprint()
      observations.productionDir = { before: productionBefore, after: productionAfter }
      check('L09z ★★ 真实库目录**逐字未动**', () => {
        if (productionAfter.digest !== productionBefore.digest) throw new Error('真实库 (路径,大小) 摘要变了')
        if (productionAfter.newestMtimeMs !== productionBefore.newestMtimeMs) throw new Error('真实库有文件被写过')
      })
    }
  }

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const evidence = {
    gate: 'postgresql:live:smoke',
    scope: 'WP5 有限真模型 smoke（隔离 PG + 真模型一次调用；**不是**接受性评测）',
    runId: RUN_ID,
    atUtc: new Date().toISOString(),
    atUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    head: (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim(),
    testModelWrapper: process.env.DSH_TEST_MODEL_WRAPPER === '1',
    model: process.env.OPENAI_SMALL_MODEL ?? '(unset)',
    source: source === undefined ? null : { kind: source.kind, directory: source.directory, snapshotId: source.snapshotId ?? null },
    targetDb: TARGET_DB,
    checks,
    notRun,
    observations,
    counts: { measured: checks.length, passed, failed, notRun: notRun.length },
  }
  writeFileSync(resolve(EVIDENCE_DIR, 'live-smoke-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  JSON.parse(readFileSync(resolve(EVIDENCE_DIR, 'live-smoke-evidence.json'), 'utf8'))

  console.log('')
  console.log('WP5 有限真模型 smoke（隔离 PG · 真模型一次调用）')
  console.log('─'.repeat(84))
  console.log(`  runId   : ${RUN_ID}`)
  console.log(`  来源    : ${evidence.source === null ? '(none)' : `${evidence.source.kind} · ${evidence.source.snapshotId ?? ''}`}`)
  console.log(`  模型    : ${String(evidence.model)}`)
  console.log(`  证据    : artifacts/post-lv2/postgresql-migration/${RUN_ID}/`)
  console.log('─'.repeat(84))
  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (!c.pass && c.detail !== undefined) console.log(`        └─ ${c.detail}`)
  }
  console.log('─'.repeat(84))
  console.log(`  provider : ${JSON.stringify(observations.provider ?? {})}`)
  console.log(`  tick     : ${JSON.stringify(observations.tick ?? {})}`)
  console.log(`  耗时     : ${String(observations.elapsedMs ?? '?')} ms`)
  console.log(`  断言     : ${passed}/${checks.length}`)
  console.log(`  未运行   : ${notRun.length}`)
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
    console.error(`\n${notRun.length} 项未运行 ⇒ 本 smoke **不报 PASS**。`)
    process.exitCode = 1
  }
}

await main()
