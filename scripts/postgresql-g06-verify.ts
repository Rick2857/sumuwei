/**
 * PG-G06 投影与语义召回（WP5）。
 *
 * ============================================================================
 *  这道门要回答什么（契约 §3 / `G06.1…G06.5`）
 * ============================================================================
 * ```text
 *   G06.1  领域投影重建 A == B（先记录恢复后投影，再在**另一个**一次性目标重建并比较）
 *   G06.2  向量代 / 维度 / 数量一致（含 vector 扩展版本差异的**显式记录**：来源 0.8.0 → 目标 0.8.7）
 *   G06.3  相同向量 ⇒ 固定查询 ID / 距离核对
 *   G06.4  等距结果按**集合**比较（不比顺序）
 *   G06.5  不重新编码凑一致（编码器指纹不变）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  §G06.1 的设计（本门的技术核心）
 * ---------------------------------------------------------------------------
 *  用**生产代码里的 store 级重建函数**，不是我自己重写一遍折叠：
 *
 * ```text
 *   rebuildAffectProjectionV2 · rebuildRelationshipProjection · rebuildBeliefProjections ·
 *   rebuildReflectionProjections · rebuildGoalProjections · rebuildAdaptiveSelfProjections
 * ```
 *
 *  三个数据库角色分工（这是"先记录、再重建、不覆盖首次发现"的可执行形式）：
 *
 * ```text
 *   A  = 恢复出来的目标（**只读**：本门只对它做 SELECT）
 *   B  = **另一个**一次性目标，恢复**同一份导出**
 *        B_before_boot  在启动核心**之前**读一次 ⇒ 与 A 比较（**恢复确定性**）
 *        然后启动核心 → 六个 store 级重建 → B_after
 *        B_after 与 A 比较 ⇒ **G06.1**
 * ```
 *
 *  ⇒ 核心**只**在 B 上启动。A 从头到尾只被 SELECT 过 —— 这条由 `A` 库上"没有任何
 *    写语句"的命令记录 + `updated_at` 未变来证明（见 `G06.1j` 的正控）。
 *
 *  ⚠️ **`updated_at` 是唯一被排除的字段**，理由：`rebuildProjection` 系函数把
 *     `now = Date.now()` 写进去，它是**重建时刻**，不是数据。排除必须**具名**，
 *     而且要有正控证明"重建真的写了"（否则 A == B 可能只是因为重建是空操作）。
 *
 * ---------------------------------------------------------------------------
 *  §G06.4 的设计：为什么必须按**集合**比
 * ---------------------------------------------------------------------------
 *  等距（tie）时 `order by embedding <=> p` 的顺序是**未定义**的 ⇒
 *  按顺序比会得到一个**随机的红**。门里用一个**合成夹具**把这件事做成可判定的：
 *  `[1,0]` 与 `[0,1]` 到 `[1,1]` 的距离**精确相等**，两种 tie-break 给出**顺序不同、
 *  集合相同**的结果 ⇒ 集合判据通过、顺序判据会失败。
 *
 * 跑法：pnpm postgresql:g06:verify
 */
import 'dotenv/config'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { rowToDomainEvent } from '../src/infrastructure/persistence/event-store.ts'
import { GOAL_HANDLED_EVENT_TYPES, foldGoalRowsInMemory, goalEventTargets } from '../src/kernel/projections/goal.ts'
import { rebuildAffectProjectionV2 } from '../src/infrastructure/persistence/affect-store.ts'
import { rebuildRelationshipProjection } from '../src/infrastructure/persistence/relationship-store.ts'
import { rebuildBeliefProjections } from '../src/infrastructure/persistence/belief-store.ts'
import { rebuildReflectionProjections } from '../src/infrastructure/persistence/reflection-store.ts'
import { rebuildGoalProjections } from '../src/infrastructure/persistence/goal-store.ts'
import { rebuildAdaptiveSelfProjections } from '../src/infrastructure/persistence/adaptive-self-store.ts'
import { closeDatabaseConnection } from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { parseRelationshipProjectionType, relationshipProjectionType } from '../src/kernel/contracts/relationship.ts'

import {
  PG_CONTAINER,
  PG_CREDENTIALS_FILE,
  PG_HOST_PORT,
  loadPgCredentials,
  missingCredentialKeys,
} from './postgresql/credentials.ts'
import { psql, psqlFile, psqlFromStdin } from './postgresql/pg-exec.ts'
import { openPgliteSnapshot } from './postgresql/pglite-reader.ts'
import { dumpPgliteSnapshot, EXPORT_RUNTIME_DIR, PINNED_TOOLS_VERSION } from './postgresql/pglite-dump.ts'

// ===========================================================================
// 配置
// ===========================================================================
const CONTAINER = PG_CONTAINER
const HOST_PORT = PG_HOST_PORT
const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'

const DB_A = 'lg_test_g06_a'
const DB_B = 'lg_test_g06_b'
const MIGRATE_USER = 'lg_migrate'
/** 期望的投影家族（与 `projection-probe.ts` 实测一致；少一个就要**具名**报出来） */
const EXPECTED_FAMILIES: Record<string, number> = {
  'diagnostic-counter': 1,
  affect: 1,
  belief: 5,
  goal: 19,
  reflection: 2,
  relationship: 1,
}

const LOCAL_DIR = resolve('artifacts/post-lv2/local/pg-migration')
const RESTORE_SQL = join(LOCAL_DIR, 'g06-restore.sql')
const RESTORE_ARGS = ['--no-owner', '--no-privileges', '--no-comments']

const UTC_STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const RUN_ID = `pg-migration-g06-${UTC_STAMP}`
const EVIDENCE_DIR = resolve(`artifacts/post-lv2/postgresql-migration/${RUN_ID}`)

const credentials = loadPgCredentials()
const missingKeys = missingCredentialKeys(credentials)

/** 真实库目录（**本门绝不允许碰它** —— 见 §真实库自证） */
const PRODUCTION_DB_DIR = resolve('data/pglite')

/**
 * 真实库目录的**轻量指纹**（只 `readdir` + `stat`，**不读内容、不打开库**）。
 *
 * ⚠️ 这是本门从一次**真实事故**里长出来的判据（见 `F-WP5-06`）：核心启动时
 *    如果**静默**回退成 PGlite 适配器，它会打开 `.env` 里的 `PGLITE_DATA_DIR`
 *    —— 也就是**真实库** —— 并写 `pg_control`/WAL 等集群文件。
 *    只看 mtime 不够（见 `production-touch-assessment.ts` 的说明），所以这里记
 *    "文件数 + (路径,大小) 摘要 + 最新 mtime"三项，前后比对。
 */
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

// ===========================================================================
// 报告骨架
// ===========================================================================
const checks: { name: string; pass: boolean; detail?: string }[] = []
const notRun: { id: string; what: string; why: string }[] = []
const observations: Record<string, unknown> = {}
const commands: { command: string; rc: number }[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function note(entry: { command: string; rc: number }): void {
  commands.push(entry)
}

// ===========================================================================
// §1 纯函数层：判据形状
// ===========================================================================
check('G06.0a 关系投影键可往返（`relationship:<kind>:<id>`），坏形状 ⇒ undefined（不猜）', () => {
  const ref = entityRef('user', 'u-1')
  const type = relationshipProjectionType(ref)
  assert.equal(type, 'relationship:user:u-1')
  const parsed = parseRelationshipProjectionType(type)
  assert.ok(parsed !== undefined)
  assert.equal(String(parsed!.id), 'u-1')
  assert.equal(parsed!.kind, 'user')
  for (const bad of ['relationship:user', 'relationship::x', 'belief:user:x', 'relationship:user:']) {
    assert.equal(parseRelationshipProjectionType(bad), undefined, `坏形状没有被拒绝：${bad}`)
  }
})

check('G06.0b ★ 「等距按集合比较」的判据形状：顺序不同但集合相同 ⇒ 相等；集合不同 ⇒ 不等', () => {
  const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && [...a].sort().join('\u0001') === [...b].sort().join('\u0001')
  assert.equal(sameSet(['a', 'b'], ['b', 'a']), true, '顺序不同、集合相同 ⇒ 应当判相等')
  assert.equal(sameSet(['a', 'b'], ['a', 'c']), false, '集合不同 ⇒ 应当判不等')
  assert.equal(sameSet(['a'], ['a', 'b']), false)
})

check('G06.0c 距离比较用**容差**（浮点不按字符串相等比）', () => {
  const close = (a: number, b: number, tolerance = 1e-6): boolean => Math.abs(a - b) <= tolerance
  assert.equal(close(0, 1e-12), true)
  assert.equal(close(0, 1e-3), false)
  assert.equal(close(1.4142135, Math.SQRT2, 1e-6), true)
})

check('G06.0d 编码器指纹字段是**闭集**（少比一个字段就等于没比）', () => {
  const fingerprintFields = [
    'model_fingerprint',
    'renderer_version',
    'tokenizer_fingerprint',
    'pooling',
    'normalize',
    'dtype',
    'dimension',
    'content_hash',
  ] as const
  assert.equal(new Set(fingerprintFields).size, 8)
  assert.ok(fingerprintFields.includes('renderer_version'), 'renderer_version 必须在指纹里')
})

// ===========================================================================
// §2 真实例
// ===========================================================================
interface PsqlResult {
  rc: number
  out: string
  err: string
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
        ? `凭据文件缺这些 key：${missingKeys.join(', ')}（文件：${PG_CREDENTIALS_FILE}）`
        : !instanceUp
          ? `容器 ${CONTAINER} 不可达`
          : !snapshotExists
            ? `来源快照不存在：${SOURCE_SNAPSHOT}（可用 LG_PG_SOURCE_SNAPSHOT 指定）`
            : !exportRuntimeReady
              ? `导出工具运行时未就绪：${EXPORT_RUNTIME_DIR}（见 WP4 Handoff）`
              : undefined

  if (blocked !== undefined) {
    notRun.push({
      id: 'projection-and-vector',
      what: '投影重建 A==B 与向量/编码器读数（G06.1–G06.5 的真实例部分）',
      why: blocked,
    })
  } else {
    const password = credentials!.LG_PG_MIGRATE_PASSWORD
    const queryOf = (database: string) => (sql: string): PsqlResult => {
      const r = psql({ container: CONTAINER, user: MIGRATE_USER, password, database, sql, timeoutMs: 600_000 })
      note({ command: r.command, rc: r.rc })
      return r
    }
    const manageTestDb = (script: 'create-test-db.sql' | 'drop-test-db.sql', database: string): PsqlResult => {
      const r = psqlFile({
        container: CONTAINER,
        user: credentials!.LG_PG_BOOTSTRAP_USER,
        password: credentials!.LG_PG_BOOTSTRAP_PASSWORD,
        database: credentials!.LG_PG_BOOTSTRAP_DB,
        file: `/opt/lg/${script}`,
        variables: { LG_TEST_DB_NAME: database, LG_PG_MIGRATE_USER: MIGRATE_USER },
      })
      note({ command: r.command, rc: r.rc })
      return r
    }

    /** 投影读数：**不含 `updated_at`**（它是重建时刻，不是数据 —— 见文件头） */
    const readProjections = (database: string): string[] =>
      queryOf(database)(
        "select projection_type||'|'||revision||'|'||reducer_version||'|'||" +
          "coalesce(last_domain_event_sequence::text,'-')||'|'||coalesce(last_domain_event_id,'-')||'|'||" +
          'md5(state::text) from character_projections order by projection_type'
      )
        .out.split('\n')
        .filter((line) => line.trim() !== '')
    const readProjectionUpdatedAt = (database: string): string[] =>
      queryOf(database)(
        "select projection_type||'='||updated_at from character_projections order by projection_type"
      )
        .out.split('\n')
        .filter((line) => line.trim() !== '')
    const readEventCount = (database: string): number =>
      Number(queryOf(database)('select count(*) from character_domain_events').out)
    const readVectorVersion = (database: string): string =>
      queryOf(database)("select coalesce((select extversion from pg_extension where extname='vector'),'(none)')").out
    const readSemanticIndex = (database: string): string[] =>
      queryOf(database)(
        "select namespace||'|'||memory_id||'|'||source_revision||'|'||generation_id||'|'||" +
          "model_fingerprint||'|'||renderer_version||'|'||tokenizer_fingerprint||'|'||pooling||'|'||" +
          "normalize::text||'|'||dtype||'|'||dimension||'|'||content_hash||'|'||" +
          'md5(embedding::text)||\'|\'||vector_dims(embedding) ' +
          'from memory_semantic_index order by memory_id, source_revision, generation_id'
      )
        .out.split('\n')
        .filter((line) => line.trim() !== '')

    let runtime: AgentRuntime | undefined
    try {
      // ---------------------------------------------------------------------
      // 1) A：恢复出来，只读
      // ---------------------------------------------------------------------
      /*
       * ⚠️ **源侧的 vector 版本必须从源读**（PGlite 快照副本），不是从目标读。
       *
       * 本轮第一次跑就是把 `readVectorVersion(DB_A)` 当成了"源"—— 而 DB_A 是
       * **恢复出来的 PG 目标**（它由 `create-test-db.sql` 装了 0.8.7）⇒ 那一步实际是
       * "目标 vs 目标"的**同义反复**，契约要的"来源 0.8.0 → 目标 0.8.7"根本没被量到。
       * 门当时报 `源侧 vector 版本应为 0.8.0，实读 0.8.7` —— 判据是对的，**量错了对象**。
       */
      const sourceSession = await openPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT })
      let vectorVersionSource = '(read failed)'
      let goalRevisionOnSource: {
        relevantEvents: number
        rows: number
        storedGreater: number
        storedSmaller: number
        deltaSum: number
        stateEqual: number
      } | undefined
      try {
        const extensions = await sourceSession.readTable('pg_catalog', 'pg_extension')
        vectorVersionSource = String(extensions.rows.find((row) => row.extname === 'vector')?.extversion ?? '(none)')

        /*
         * ★ **归因判据**：把"存的 revision vs 从事件全量折叠出来的 revision"这件事
         *    **在源快照上**独立复现 —— 不经 PG、不经迁移、不经本次恢复。
         *    若同一差异在源上就已经存在 ⇒ 它是**产品缺陷**，不是迁移造成的。
         *    用**真实代码**：`rowToDomainEvent` + `GOAL_HANDLED_EVENT_TYPES` +
         *    `goalEventTargets` + `foldGoalRowsInMemory`（与重建路径同一判据）。
         */
        const eventRows = await sourceSession.readTable('public', 'character_domain_events')
        const projectionRows = await sourceSession.readTable('public', 'character_projections')
        const events = eventRows.rows
          .map((row) => rowToDomainEvent(row as never))
          .filter((event): event is NonNullable<typeof event> => event !== undefined)
        const characterIdOfEvents = [...new Set(events.map((event) => String(event.characterId)))][0] ?? ''
        const relevant = events.filter(
          (event) =>
            (GOAL_HANDLED_EVENT_TYPES as readonly string[]).includes(event.type) &&
            goalEventTargets(event as never, characterIdOfEvents)
        )
        const cache = new Map<string, unknown>()
        foldGoalRowsInMemory(cache as never, relevant as never)
        const folded = cache as unknown as Map<string, { revision?: number; state?: unknown }>
        const stored = new Map(
          projectionRows.rows
            .filter((row) => String(row.projection_type).startsWith('goal:'))
            .map((row) => [String(row.projection_type), { revision: Number(row.revision), state: row.state }])
        )
        let storedGreater = 0
        let storedSmaller = 0
        let deltaSum = 0
        let stateEqual = 0
        /* ⚠️ 比 state 要**规范化**（键排序）：直接把 `JSON.stringify` 拿来比会量到**键序**，
         *    而不是内容 —— 第一版这里得到 11/19，而用规范化摘要的独立探针得到 18/19。 */
        const canonical = (value: unknown): string => {
          if (value === null || value === undefined) return 'null'
          if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
          if (typeof value === 'object') {
            return `{${Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
              .join(',')}}`
          }
          return JSON.stringify(value)
        }
        for (const [key, a] of stored) {
          const b = folded.get(key)
          const delta = a.revision - (b?.revision ?? 0)
          if (delta > 0) storedGreater += 1
          if (delta < 0) storedSmaller += 1
          deltaSum += delta
          if (canonical(a.state) === canonical(b?.state)) stateEqual += 1
        }
        goalRevisionOnSource = {
          relevantEvents: relevant.length,
          rows: stored.size,
          storedGreater,
          storedSmaller,
          deltaSum,
          stateEqual,
        }
        observations.goalRevisionOnSource = goalRevisionOnSource
      } finally {
        observations.sourceAttestation = await sourceSession.close()
      }

      check('G06.1m ★ **源侧已修**：源快照上"存的 revision"与"从事件折叠出来的"**逐行相等**', () => {
        /*
         * ⚠️ 这条判据**换过方向**（2026-10-13，用户裁定 ⓓ 之后）：
         *   它原来是**归因**用的 —— 断言"同一差异在**源**上就已经存在"（`storedGreater >= 15`
         *   且 `deltaSum > 100`），用来证明那个差异是**产品缺陷**、不是迁移造成的。
         *   裁定 ⓓ（真实库上受控重建 `goal:%` + 取新快照）执行之后，**源已经干净了**
         *   ⇒ 那组断言按定义不再成立。
         *   ⇒ 现在它守的是**修复的回归**：源上"存的"必须与"折叠出来的"逐行相等。
         *     历史归因不丢：见 `docs/Tech-Debt-Register.md`（追加③）与 WP5 Handoff §3.7.2b。
         */
        const reading = goalRevisionOnSource
        assert.ok(reading !== undefined, '源侧折叠读数没拿到')
        assert.equal(reading!.rows, 19, `源侧 goal 行数应为 19，实为 ${reading!.rows}`)
        assert.ok(reading!.relevantEvents > 0, '前置：源上目标域事件数为 0 ⇒ 这条判据没量到东西')
        assert.equal(
          reading!.storedGreater,
          0,
          `源上仍有 ${reading!.storedGreater} 行的 revision **大于**折叠值 ⇒ 膨胀又回来了`
        )
        assert.equal(reading!.storedSmaller, 0, `源上有 ${reading!.storedSmaller} 行的 revision 小于折叠值`)
        assert.equal(reading!.deltaSum, 0, `源上 revision 与折叠值仍有合计 ${reading!.deltaSum} 的差 ⇒ 源没修干净`)
        assert.equal(reading!.stateEqual, 19, `源上只有 ${reading!.stateEqual}/19 行的 state 与折叠一致`)
      })

      manageTestDb('drop-test-db.sql', DB_A)
      const createdA = manageTestDb('create-test-db.sql', DB_A)
      check('G06.1a 前置：A（只读的那一份）从零建立', () => {
        assert.equal(createdA.rc, 0, createdA.err)
      })

      const sourceDump = await dumpPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT, args: RESTORE_ARGS, outFile: RESTORE_SQL })
      observations.sourceExport = {
        tool: `${sourceDump.tool.toolsVersion}(pglite ${sourceDump.tool.pgliteVersion})`,
        pinnedTools: PINNED_TOOLS_VERSION,
        args: RESTORE_ARGS,
        bytes: sourceDump.bytes,
        sqlDigest: sourceDump.sqlDigest,
        sourceUnchanged: sourceDump.sourceUnchanged,
        copyMatchesSource: sourceDump.copyMatchesSource,
        closedClean: sourceDump.closedClean,
      }
      const restoreA = psqlFromStdin({
        container: CONTAINER,
        user: MIGRATE_USER,
        password,
        database: DB_A,
        sql: sourceDump.sql,
        timeoutMs: 900_000,
      })
      note({ command: restoreA.command, rc: restoreA.rc })
      check('G06.1b 前置：A 恢复成功（exit 0 且无 ERROR）', () => {
        assert.equal(restoreA.rc, 0, restoreA.err.slice(0, 500))
        assert.ok(!/^ERROR/m.test(restoreA.err), `恢复日志里有 ERROR：${restoreA.err.slice(0, 500)}`)
      })

      const projectionsA = readProjections(DB_A)
      const updatedAtA = readProjectionUpdatedAt(DB_A)
      const eventsA = readEventCount(DB_A)
      const semanticA = readSemanticIndex(DB_A)
      const vectorVersionA = readVectorVersion(DB_A)
      const familyCounts: Record<string, number> = {}
      for (const line of projectionsA) {
        const family = line.split('|')[0].split(':')[0]
        familyCounts[family] = (familyCounts[family] ?? 0) + 1
      }
      observations.A = {
        projections: projectionsA.length,
        families: familyCounts,
        domainEvents: eventsA,
        targetVectorVersion: vectorVersionA,
        semanticIndexRows: semanticA.length,
      }

      check('G06.1c 前置：A 的 29 行投影覆盖 6 个家族（少一个就具名报出来）', () => {
        assert.equal(projectionsA.length, 29, `投影行数应为 29，实为 ${projectionsA.length}`)
        assert.deepEqual(familyCounts, EXPECTED_FAMILIES, `家族分布不符：${JSON.stringify(familyCounts)}`)
      })

      // ---------------------------------------------------------------------
      // 2) B：**另一个**一次性目标，恢复**同一份导出**
      // ---------------------------------------------------------------------
      manageTestDb('drop-test-db.sql', DB_B)
      const createdB = manageTestDb('create-test-db.sql', DB_B)
      const restoreB = psqlFromStdin({
        container: CONTAINER,
        user: MIGRATE_USER,
        password,
        database: DB_B,
        sql: sourceDump.sql,
        timeoutMs: 900_000,
      })
      note({ command: restoreB.command, rc: restoreB.rc })
      const projectionsBBefore = readProjections(DB_B)
      const eventsBBefore = readEventCount(DB_B)
      observations.B_beforeBoot = { projections: projectionsBBefore.length, domainEvents: eventsBBefore }

      check('G06.1d 前置：B 恢复成功，且**同一份导出恢复两次的结果逐行相同**（恢复确定性）', () => {
        assert.equal(createdB.rc, 0, createdB.err)
        assert.equal(restoreB.rc, 0, restoreB.err.slice(0, 500))
        assert.deepEqual(
          projectionsBBefore,
          projectionsA,
          `两次恢复的投影不同：${projectionsBBefore.filter((line, i) => line !== projectionsA[i]).slice(0, 3).join(' / ')}`
        )
        assert.equal(eventsBBefore, eventsA, `两次恢复的领域事件数不同：${eventsA} vs ${eventsBBefore}`)
      })

      // ---------------------------------------------------------------------
      // 3) ★ 在 B 上启动核心并调用**生产代码里的**六个 store 级重建
      // ---------------------------------------------------------------------
      /*
       * ==========================================================================
       *  ⚠️⚠️ 这一段是**一次真实事故**之后重写的（`F-WP5-06`，2026-10-13）
       * ==========================================================================
       *  第一版只设了 `process.env.POSTGRES_URL`（由 `isolateDatabase` 设）+ `CHARACTER_DB_BACKEND`，
       *  然后 `new AgentRuntime({ ..., settings: {} })`。结果：
       *
       * ```text
       *   插件从 `runtime.getSetting("POSTGRES_URL")` 取连接串 —— 而 `settings: {}` 里没有它，
       *   `getSetting` **不回落**到 process.env ⇒ postgresUrl = undefined
       *   ⇒ `createDatabaseAdapter({ postgresUrl: undefined, dataDir: runtime.getSetting("PGLITE_DATA_DIR") })`
       *   ⇒ 它建了一个 **PGlite** 适配器，而 `.env` 的 PGLITE_DATA_DIR = `./data/pglite`
       *   ⇒ **真实库被打开并被写入集群文件**（pg_control / WAL / pg_xact / postmaster.pid …）
       * ```
       *
       *  门当时报的是 `连上的数据库身份与期望不符：实际 template1` —— 那个 `template1`
       *  正是 **PGlite 内嵌实例的库名**，不是一个 PG 目标。（身份核对发生在任何迁移与
       *  业务写入之前，所以**用户数据一字未动**：内容评估见 `production-touch-assessment.ts`，
       *  54 张表逐表摘要与参照快照**完全相同**。）
       *
       *  ⇒ 现在的三道防线（缺一不可）：
       *    ① 连接串走 **`runtime.settings`**（`getSetting` 真正看到它的地方）；
       *    ② **`PGLITE_DATA_DIR` 指到一个临时目录**（就算适配器又回退成 PGlite，
       *       它也只能开那个临时目录 —— 纵深防御）；
       *    ③ 启动前后各读一次**真实库目录指纹**，并要求逐字不变（自证）。
       */
      process.env.CHARACTER_DB_BACKEND = 'postgres'
      /*
       * ⚠️ **必须声明期望的数据库身份**，否则核心会**失败关闭**（这是 WP1 建好的判据）：
       *
       * ```text
       *   拒绝：后端是 postgres，但没有给出期望的数据库身份（身份核对没有东西可核）。
       * ```
       *
       * 它是对的：没有期望值 ⇒ "身份核对"变成一句空话。这里给**两项**：库名（精确）+ 前缀。
       */
      process.env.LG_PG_EXPECT_DATABASE = DB_B
      process.env.LG_PG_EXPECT_DATABASE_PREFIX = 'lg_test_'
      const url =
        `postgresql://${MIGRATE_USER}:${encodeURIComponent(password)}@127.0.0.1:${HOST_PORT}/${DB_B}`
      const sandbox = isolateDatabase('pg-g06-verify', { postgres: { url } })
      // 防线 ②：把 PGlite 的回落目录挪到本次实验的独占目录里
      const fallbackDataDir = join(sandbox.dir, 'pglite-fallback')
      mkdirSync(fallbackDataDir, { recursive: true })
      process.env.PGLITE_DATA_DIR = fallbackDataDir
      const productionBefore = productionDirFingerprint()
      observations.sandbox = {
        backend: sandbox.backend,
        target: sandbox.postgresTarget,
        expectDatabase: DB_B,
        expectDatabasePrefix: 'lg_test_',
        pgliteFallbackDataDir: fallbackDataDir,
        productionDbDir: PRODUCTION_DB_DIR,
      }
      observations.productionDirBefore = productionBefore

      check('G06.1j 前置（事故防线）：PGlite 的回落目录**不是**真实库，且真实库指纹已记录', () => {
        assert.notEqual(
          resolve(process.env.PGLITE_DATA_DIR!),
          PRODUCTION_DB_DIR,
          'PGLITE_DATA_DIR 仍指向真实库 ⇒ 一旦适配器回退成 PGlite，真实库就会被打开'
        )
        assert.ok(productionBefore.files > 1_000, `真实库目录指纹没量到东西（${productionBefore.files} 文件）`)
      })

      const declaredCharacterId = String(character.id ?? '')
      const rebuildResults: Record<string, unknown> = {}
      let bootError: string | undefined
      try {
        // ⚠️ 防线 ①：连接串走 **settings**（`runtime.getSetting` 真正看的地方）。
        //    只设 `process.env.POSTGRES_URL` **不够** —— 第一版就是这么写然后静默回退的。
        runtime = new AgentRuntime({
          character: character as Character,
          plugins: [],
          settings: { POSTGRES_URL: url },
        })
        await initDatabase(runtime, sqlPlugin)
        await runtime.initialize()
        const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character) })
        const db = kernel.stores.db
        // ⚠️ 用**核心解析出来的** characterId（不是常量）：这条链本身也要被核对
        const characterId = kernel.characterId
        assert.equal(
          String(characterId),
          declaredCharacterId,
          `核心解析出的 characterId (${String(characterId)}) 与定义里的 (${declaredCharacterId}) 不同`
        )
        const events = await domainEventsFor(db, characterId)

        const affect = await rebuildAffectProjectionV2(db, characterId)
        rebuildResults.affect = { appliedEvents: affect.appliedEvents, previousRevision: affect.previousRevision }

        const targetRef = parseRelationshipProjectionType(
          projectionsA.find((line) => line.startsWith('relationship:'))!.split('|')[0]
        )
        assert.ok(targetRef !== undefined, 'A 里的 relationship 投影键解析不出来')
        const ownerRef = entityRef('character', characterId)
        const relationship = await rebuildRelationshipProjection(db, characterId, ownerRef, targetRef!)
        rebuildResults.relationship = {
          appliedEvents: relationship.appliedEvents,
          previousRevision: relationship.previousRevision,
        }

        const belief = await rebuildBeliefProjections(db, characterId)
        rebuildResults.belief = { ...belief }
        const reflection = await rebuildReflectionProjections(db, characterId, events)
        rebuildResults.reflection = { ...reflection }
        const goal = await rebuildGoalProjections(db, characterId)
        rebuildResults.goal = { ...goal }
        const adaptiveSelf = await rebuildAdaptiveSelfProjections(db, characterId, events)
        rebuildResults.adaptiveSelf = { ...adaptiveSelf }
        observations.rebuildResults = rebuildResults
      } catch (error) {
        bootError = error instanceof Error ? `${error.message}` : String(error)
        observations.bootError = bootError
      }

      check('G06.1e ★ 核心在 B 上启动成功，六个 store 级重建全部返回（用**生产代码**，不是我重写折叠）', () => {
        assert.equal(bootError, undefined, `核心启动/重建失败：${bootError ?? ''}`)
        assert.deepEqual(
          Object.keys(rebuildResults).sort(),
          ['adaptiveSelf', 'affect', 'belief', 'goal', 'reflection', 'relationship'],
          `重建家族不全：${Object.keys(rebuildResults).join(',')}`
        )
      })

      // ---------------------------------------------------------------------
      // 3b) ★★ 真实库自证（`F-WP5-06` 的判据）
      // ---------------------------------------------------------------------
      const productionAfter = productionDirFingerprint()
      observations.productionDirAfter = productionAfter
      check('G06.1k ★★ 真实库目录**逐字未动**（启动核心前后：文件数 / (路径,大小) 摘要 / 最新 mtime）', () => {
        assert.equal(
          productionAfter.files,
          productionBefore.files,
          `真实库文件数变了：${productionBefore.files} → ${productionAfter.files}`
        )
        assert.equal(
          productionAfter.digest,
          productionBefore.digest,
          '真实库的 (路径,大小) 摘要变了 ⇒ 本门动了真实库'
        )
        assert.equal(
          productionAfter.newestMtimeMs,
          productionBefore.newestMtimeMs,
          `真实库里有文件被写过（最新 mtime 变了）：${new Date(productionBefore.newestMtimeMs).toISOString()} → ${new Date(productionAfter.newestMtimeMs).toISOString()}`
        )
      })

      // ---------------------------------------------------------------------
      // 4) ★★ G06.1：投影重建 A == B
      // ---------------------------------------------------------------------
      const projectionsBAfter = readProjections(DB_B)
      const updatedAtBAfter = readProjectionUpdatedAt(DB_B)
      const eventsBAfter = readEventCount(DB_B)
      const differing = projectionsA.filter((line, index) => line !== projectionsBAfter[index])
      /*
       * 差异的**字段级刻画**（一层深）：把两侧 `state` 取回来，只比**顶层键**
       * 与每个键的**值摘要**。⚠️ 只输出**键名与类型**，**绝不输出值**
       * （投影 state 可能含私人正文）。
       */
      const stateTextOf = (database: string, projectionType: string): string => {
        const raw = queryOf(database)(
          `select coalesce(state::text,'null') from character_projections where projection_type = '${projectionType.replace(/'/g, "''")}'`
        ).out
        return raw.trim()
      }
      const digestOf = (value: unknown): string =>
        createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 12)
      const typeOf = (value: unknown): string =>
        value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      const stateDiff = differing.slice(0, 20).map((line) => {
        const projectionType = line.split('|')[0]
        let a: Record<string, unknown> = {}
        let b: Record<string, unknown> = {}
        try {
          a = JSON.parse(stateTextOf(DB_A, projectionType)) as Record<string, unknown>
          b = JSON.parse(stateTextOf(DB_B, projectionType)) as Record<string, unknown>
        } catch {
          return { projectionType, parseError: true }
        }
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
        const differingKeys = keys
          .filter((key) => digestOf(a[key]) !== digestOf(b[key]))
          .map((key) => ({ key, typeInA: typeOf(a[key]), typeInB: typeOf(b[key]) }))
        return {
          projectionType,
          topLevelKeys: keys.length,
          differingKeys,
        }
      })
      const differingKeyHistogram: Record<string, number> = {}
      for (const entry of stateDiff) {
        for (const key of entry.differingKeys ?? []) {
          differingKeyHistogram[key.key] = (differingKeyHistogram[key.key] ?? 0) + 1
        }
      }
      /*
       * ⚠️ 还要回答"差别在**哪一列**"：整行是 6 段拼的
       * `projection_type|revision|reducer_version|seq|lastId|md5(state)`。
       * 只报"摘要不同"会把"状态变了"与"只是最后事件 id 变了"混成一件事。
       */
      const COMPONENTS = ['projection_type', 'revision', 'reducer_version', 'sequence', 'last_domain_event_id', 'state_md5'] as const
      const differingComponentHistogram: Record<string, number> = {}
      const componentDiff = differing.map((line, index) => {
        const a = line.split('|')
        const b = (projectionsBAfter[projectionsA.indexOf(line)] ?? '').split('|')
        const components = COMPONENTS.filter((_, i) => a[i] !== b[i])
        for (const component of components) {
          differingComponentHistogram[component] = (differingComponentHistogram[component] ?? 0) + 1
        }
        void index
        return { projectionType: a[0], differingComponents: components }
      })
      observations.rebuild = {
        ...(observations.rebuild as Record<string, unknown>),
        componentDiff,
        differingComponentHistogram,
      }
      const familyOfDiffering: Record<string, number> = {}
      for (const line of differing) {
        const family = line.split('|')[0].split(':')[0]
        familyOfDiffering[family] = (familyOfDiffering[family] ?? 0) + 1
      }
      observations.rebuild = {
        projectionsA: projectionsA.length,
        projectionsBAfter: projectionsBAfter.length,
        differing: differing.length,
        differingFamilies: familyOfDiffering,
        differingSample: differing.slice(0, 5),
        stateDiff,
        differingKeyHistogram,
        componentDiff,
        differingComponentHistogram,
        updatedAtChanged: updatedAtA.filter((line, index) => line !== updatedAtBAfter[index]).length,
        updatedAtUnchanged: updatedAtA
          .filter((line, index) => line === updatedAtBAfter[index])
          .map((line) => line.split('=')[0]),
      }

      check('G06.1f ★ **投影重建 A == B**（逐行比 `projection_type|revision|reducer_version|seq|lastId|md5(state)`）', () => {
        assert.equal(projectionsBAfter.length, projectionsA.length, '重建后的行数与 A 不同')
        assert.deepEqual(
          differing,
          [],
          `重建后有 ${differing.length} 行与 A 不同（家族分布 ${JSON.stringify(familyOfDiffering)}）；` +
            `字段级差异见证据里的 observations.rebuild.stateDiff`
        )
      })

      check('G06.1g ★ `updated_at` 的**排除范围**精确：被重建的 28 行全变，"没有 store 级重建"的那 1 行不变', () => {
        const unchanged = updatedAtA
          .filter((line, index) => line === updatedAtBAfter[index])
          .map((line) => line.split('=')[0])
        assert.deepEqual(
          unchanged,
          ['diagnostic-counter'],
          `updated_at 未变的行应当**恰好**是 diagnostic-counter（它没有 store 级重建函数），实为 ${JSON.stringify(unchanged)}`
        )
        assert.equal(
          updatedAtA.length - unchanged.length,
          28,
          `被重建的行数应为 28，实为 ${updatedAtA.length - unchanged.length}`
        )
      })

      check('G06.1h ★ 重建**没有**写领域事件（"投影是缓存、不是事实本体"）', () => {
        assert.equal(eventsBAfter, eventsA, `重建前后领域事件数变了：${eventsA} → ${eventsBAfter}`)
      })

      // ---------------------------------------------------------------------
      // 5) G06.2 向量代 / 维度 / 数量 + 扩展版本差异
      // ---------------------------------------------------------------------
      const semanticB = readSemanticIndex(DB_B)
      const vectorVersionB = readVectorVersion(DB_B)
      const vectorVersionTarget = vectorVersionB
      const parseSemantic = (lines: readonly string[]) =>
        lines.map((line) => {
          const [namespace, memoryId, sourceRevision, generationId, model, renderer, tokenizer, pooling, normalize, dtype, dimension, contentHash, embeddingDigest, dims] =
            line.split('|')
          return {
            namespace,
            memoryId,
            sourceRevision: Number(sourceRevision),
            generationId,
            model,
            renderer,
            tokenizer,
            pooling,
            normalize,
            dtype,
            dimension: Number(dimension),
            contentHash,
            embeddingDigest,
            dims: Number(dims),
          }
        })
      const semanticRows = parseSemantic(semanticB)
      const generations = [...new Set(semanticRows.map((row) => row.generationId))]
      const memoryIds = [...new Set(semanticRows.map((row) => row.memoryId))]
      const renderers = [...new Set(semanticRows.map((row) => row.renderer))].sort()
      observations.vector = {
        sourceVectorVersion: vectorVersionSource,
        targetVectorVersion: vectorVersionTarget,
        targetVectorVersionA: vectorVersionA,
        targetVectorVersionB: vectorVersionB,
        rows: semanticRows.length,
        generations,
        memoryIds: memoryIds.length,
        renderers,
        dimensions: [...new Set(semanticRows.map((row) => row.dimension))],
        actualDims: [...new Set(semanticRows.map((row) => row.dims))],
        dtype: [...new Set(semanticRows.map((row) => row.dtype))],
        pooling: [...new Set(semanticRows.map((row) => row.pooling))],
        normalize: [...new Set(semanticRows.map((row) => row.normalize))],
      }

      check('G06.2a ★ vector 扩展版本差异**显式记录**：源 0.8.0 → 目标 0.8.7（源读自**源快照**，目标读自**目标库**）', () => {
        assert.equal(vectorVersionSource, '0.8.0', `源侧 vector 版本应为 0.8.0，实读 ${vectorVersionSource}`)
        assert.equal(vectorVersionTarget, '0.8.7', `目标侧 vector 版本应为 0.8.7，实读 ${vectorVersionTarget}`)
        assert.notEqual(vectorVersionSource, vectorVersionTarget, '两侧版本相同 ⇒ 这条"差异记录"没量到东西')
        // 两个目标（A/B）是从**同一份导出**恢复的 ⇒ 它们的扩展版本必须相同（否则是本门量错了）
        assert.equal(vectorVersionA, vectorVersionTarget, 'A/B 两个目标的 vector 版本不同 ⇒ 本门量错了对象')
      })

      check('G06.2b 向量**代 / 维度 / 数量**一致（3 代 · 3 条记忆 · 5 行 · dim 384）', () => {
        assert.equal(semanticRows.length, 5, `索引行数应为 5，实为 ${semanticRows.length}`)
        assert.equal(generations.length, 3, `向量代应为 3，实为 ${generations.length}`)
        assert.equal(memoryIds.length, 3, `不同记忆应为 3，实为 ${memoryIds.length}`)
        assert.deepEqual([...new Set(semanticRows.map((row) => row.dimension))], [384])
      })

      check('G06.2c 声明的维度 == **实读**维度（逐行 `vector_dims(embedding)`）', () => {
        const wrong = semanticRows.filter((row) => row.dims !== row.dimension)
        assert.deepEqual(wrong, [], `声明维度与实读维度不符：${JSON.stringify(wrong.slice(0, 3))}`)
      })

      // ---------------------------------------------------------------------
      // 6) G06.3 相同向量 ⇒ 固定查询 ID / 距离
      // ---------------------------------------------------------------------
      const probeRow = semanticRows.find((row) => row.memoryId.endsWith('preference-8c3de15b237d749b'))
      check('G06.3a 前置：挑到一条**内容哈希唯一**的探针（否则距离 0 处会有并列）', () => {
        assert.ok(probeRow !== undefined, '没找到 preference 那条探针')
        const sameHash = semanticRows.filter((row) => row.contentHash === probeRow!.contentHash)
        assert.equal(sameHash.length, 1, `同哈希行数应为 1，实为 ${sameHash.length} ⇒ 探针不唯一，这条判据会量到并列`)
      })

      const nearest = queryOf(DB_B)(
        'with p as (select embedding from memory_semantic_index ' +
          `where memory_id = '${probeRow!.memoryId}' and generation_id = '${probeRow!.generationId}') ` +
          'select memory_id||\'|\'||generation_id||\'|\'||(embedding <=> (select embedding from p)) ' +
          'from memory_semantic_index order by embedding <=> (select embedding from p) limit 3'
      )
      const nearestRows = nearest.out.split('\n').filter((line) => line.trim() !== '')
      observations.nearest = nearestRows
      check('G06.3b ★ 相同向量 ⇒ 固定查询 ID：最近邻就是**它自己**，距离 ≈ 0', () => {
        assert.equal(nearest.rc, 0, nearest.err.slice(0, 300))
        assert.ok(nearestRows.length > 0, '最近邻查询没有返回任何行')
        const [memoryId, generationId, distance] = nearestRows[0].split('|')
        assert.equal(memoryId, probeRow!.memoryId, `最近邻不是探针自己：${memoryId}`)
        assert.equal(generationId, probeRow!.generationId, `最近邻的向量代不对：${generationId}`)
        assert.ok(Math.abs(Number(distance)) <= 1e-6, `自身距离应为 0，实读 ${distance}`)
      })

      check('G06.3c 距离为 0 的那一组按**集合**恰好是 {探针}（不是"第一条恰好是它"）', () => {
        const zeroDistance = queryOf(DB_B)(
          'with p as (select embedding from memory_semantic_index ' +
            `where memory_id = '${probeRow!.memoryId}' and generation_id = '${probeRow!.generationId}') ` +
            "select memory_id||':'||generation_id from memory_semantic_index " +
            'where (embedding <=> (select embedding from p)) <= 1e-6 order by 1'
        )
        const zeroRows = zeroDistance.out.split('\n').filter((line) => line.trim() !== '')
        assert.deepEqual(
          zeroRows,
          [`${probeRow!.memoryId}:${probeRow!.generationId}`],
          `距离 0 的集合不是单元素：${zeroRows.join(', ')}`
        )
      })

      // ---------------------------------------------------------------------
      // 7) G06.4 等距按**集合**比较
      // ---------------------------------------------------------------------
      const tieFixture = queryOf(DB_B)(
        'drop table if exists public.g06_tie_probe; ' +
          'create table public.g06_tie_probe (id text primary key, embedding vector(2)); ' +
          "insert into public.g06_tie_probe values ('a','[1,0]'),('b','[0,1]'),('c','[-1,0]')"
      )
      check('G06.4a 前置：等距夹具已建（`[1,0]` 与 `[0,1]` 到 `[1,1]` 的距离**精确相等**）', () => {
        assert.equal(tieFixture.rc, 0, tieFixture.err.slice(0, 300))
      })

      const tieAsc = queryOf(DB_B)(
        "select id from public.g06_tie_probe order by embedding <=> '[1,1]'::vector, id asc"
      )
      const tieDesc = queryOf(DB_B)(
        "select id from public.g06_tie_probe order by embedding <=> '[1,1]'::vector, id desc"
      )
      const idsAsc = tieAsc.out.split('\n').filter((line) => line.trim() !== '')
      const idsDesc = tieDesc.out.split('\n').filter((line) => line.trim() !== '')
      const distances = queryOf(DB_B)(
        "select id||'='||(embedding <=> '[1,1]'::vector)::text from public.g06_tie_probe order by id"
      )
        .out.split('\n')
        .filter((line) => line.trim() !== '')
      observations.tie = { idsAsc, idsDesc, distances }

      check('G06.4b ★ 等距时两种 tie-break 给出**顺序不同、集合相同**的结果', () => {
        assert.equal(idsAsc.length, 3)
        assert.notDeepEqual(idsAsc, idsDesc, '两种 tie-break 的顺序相同 ⇒ 这个夹具没有造出并列')
        assert.deepEqual(
          [...idsAsc].sort(),
          [...idsDesc].sort(),
          `集合不同：${idsAsc.join(',')} vs ${idsDesc.join(',')}`
        )
        // 并列确实在最近的两个上
        assert.deepEqual(idsAsc.slice(0, 2).sort(), ['a', 'b'])
        assert.deepEqual(idsDesc.slice(0, 2).sort(), ['a', 'b'])
      })

      check('G06.4c 并列的两个距离**精确相等**（不是"差不多"）—— 这条支撑上面那条判据', () => {
        const byId = new Map(distances.map((line) => [line.split('=')[0], Number(line.split('=')[1])]))
        const a = byId.get('a')
        const b = byId.get('b')
        assert.ok(a !== undefined && b !== undefined, `距离读数不齐：${distances.join(', ')}`)
        assert.ok(Math.abs(a! - b!) <= 1e-6, `a 与 b 的距离不等：${a} vs ${b}`)
        assert.ok(a! > 0, '探针与 a 重合 ⇒ 不是并列场景')
      })

      check('G06.4d 集合判据在这组读数上通过（而顺序判据会失败）—— 所以必须按集合比', () => {
        const sameSet = (x: readonly string[], y: readonly string[]): boolean =>
          x.length === y.length && [...x].sort().join('\u0001') === [...y].sort().join('\u0001')
        assert.equal(sameSet(idsAsc, idsDesc), true)
        assert.equal(idsAsc.join(',') === idsDesc.join(','), false, '顺序判据竟然通过了 ⇒ 这条判据没量到东西')
      })

      // ---------------------------------------------------------------------
      // 8) G06.5 不重新编码凑一致
      // ---------------------------------------------------------------------
      check('G06.5a ★ 编码器指纹 8 个字段 A == B 逐字相同（含 `renderer_version` 的**两个版本共存**）', () => {
        const fingerprintOf = (lines: readonly string[]): string[] =>
          lines.map((line) => line.split('|').slice(4, 12).join('|'))
        assert.deepEqual(
          fingerprintOf(semanticB),
          fingerprintOf(semanticA),
          '编码器指纹在迁移前后不同'
        )
        assert.deepEqual(renderers, ['semantic-render@1', 'semantic-render@2'], `renderer 版本集变了：${renderers.join(',')}`)
      })

      check('G06.5b ★ 向量本身逐字未变（`md5(embedding::text)` A == B）—— 没有"重新编码凑一致"', () => {
        const vectorsOf = (lines: readonly string[]): string[] =>
          lines.map((line) => `${line.split('|')[1]}:${line.split('|')[3]}=${line.split('|')[12]}`)
        assert.deepEqual(vectorsOf(semanticB), vectorsOf(semanticA), '向量内容在迁移前后不同')
      })

      check('G06.5c 语义索引元数据（`memory_semantic_meta.index_schema_version`）两侧相同', () => {
        const metaOf = (database: string): string =>
          queryOf(database)('select id||\'|\'||index_schema_version from memory_semantic_meta order by id').out
        assert.equal(metaOf(DB_B), metaOf(DB_A))
      })

      // ---------------------------------------------------------------------
      // 9) A 全程只读（本门的自证）
      // ---------------------------------------------------------------------
      check('G06.1i ★ A 库上的命令**全是 SELECT**（核心只在 B 上启动过）', () => {
        // ⚠️ 判据只落在 `-tAc` 的命令上：`psqlFromStdin`（小写 `-q`，走 stdin 灌 SQL）
        //    的命令串里也含 `-d <A>`，但它是**建库/恢复**这一步，不是"A 上的写"。
        //    第一版没排除它 ⇒ 判据在**靠运气**通过（恰好那些关键词没出现在命令串里）。
        const aCommands = commands.filter(
          (entry) => entry.command.includes(`-d ${DB_A}`) && entry.command.includes('-tAc')
        )
        const writes = aCommands.filter((entry) =>
          /\b(insert|update|delete|create|drop|alter|truncate)\b/i.test(
            entry.command.slice(entry.command.indexOf('-tAc') + 4)
          )
        )
        const aRestores = commands.filter(
          (entry) => entry.command.includes(`-d ${DB_A}`) && !entry.command.includes('-tAc')
        )
        assert.ok(aCommands.length > 3, `A 库上的 SELECT 命令太少（${aCommands.length}）⇒ 这条自证没量到东西`)
        assert.equal(aRestores.length, 1, `A 库上"非 -tAc"的命令应恰好是那一次恢复，实为 ${aRestores.length}`)
        assert.deepEqual(
          writes.map((entry) => entry.command.slice(0, 80)),
          [],
          'A 库上出现了写语句'
        )
      })
    } catch (error) {
      checks.push({
        name: 'G06.§2 意外中断',
        pass: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      })
    } finally {
      if (runtime !== undefined) {
        try {
          await closeDatabaseConnection(runtime)
        } catch {
          /* 关不上由上面的断言报；这里不掩盖 */
        }
      }
      // ⚠️ 无论成败都要**把实例带回来**：两个测试库都必须清掉。
      const dropA = manageTestDb('drop-test-db.sql', DB_A)
      const dropB = manageTestDb('drop-test-db.sql', DB_B)
      check('G06.9z 本门自建的两个测试库已清理', () => {
        assert.equal(dropA.rc, 0, dropA.err)
        assert.equal(dropB.rc, 0, dropB.err)
      })
    }
  }

  // =========================================================================
  // 证据落盘
  // =========================================================================
  const passed = checks.filter((entry) => entry.pass).length
  const failed = checks.length - passed
  const evidence = {
    gate: 'PG-G06',
    runId: RUN_ID,
    startedAtUtc: new Date().toISOString(),
    startedAtUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    head: (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim(),
    container: CONTAINER,
    hostPort: HOST_PORT,
    sourceSnapshot: SOURCE_SNAPSHOT,
    checks,
    notRun,
    observations,
    counts: { measured: checks.length, passed, failed, notRun: notRun.length },
    commands,
  }
  writeFileSync(join(EVIDENCE_DIR, 'g06-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  JSON.parse(readFileSync(join(EVIDENCE_DIR, 'g06-evidence.json'), 'utf8'))

  console.log('')
  console.log('PG-G06 投影与语义召回（WP5）')
  console.log('─'.repeat(78))
  console.log(`  runId      : ${RUN_ID}`)
  console.log(`  实例       : ${CONTAINER}（宿主 ${HOST_PORT}）`)
  console.log(`  来源快照   : ${SOURCE_SNAPSHOT}`)
  console.log(`  证据       : artifacts/post-lv2/postgresql-migration/${RUN_ID}/`)
  console.log('─'.repeat(78))
  for (const entry of checks) {
    console.log(`  ${entry.pass ? 'PASS' : 'FAIL'}  ${entry.name}`)
    if (!entry.pass && entry.detail !== undefined) console.log(`        └─ ${entry.detail}`)
  }
  console.log('─'.repeat(78))
  console.log(`  断言        : ${passed}/${checks.length}`)
  console.log(`  未运行      : ${notRun.length}`)
  for (const entry of notRun) console.log(`      · ${entry.id} —— ${entry.what}（${entry.why}）`)
  console.log(`  measured_count = ${checks.length}`)
  console.log(`  失败总数 = ${failed}`)
  console.log('')
  const rebuild = observations.rebuild as { differing: number; updatedAtChanged: number } | undefined
  console.log('  关键读数：')
  console.log(`    · 投影行数 / 家族         : 29 / ${JSON.stringify((observations.A as { families?: unknown } | undefined)?.families ?? null)}`)
  console.log(`    · 重建后与 A 不同的行数   : ${rebuild?.differing ?? 'NOT RUN'}`)
  console.log(`    · updated_at 变化行数     : ${rebuild?.updatedAtChanged ?? 'NOT RUN'}（唯一被排除的字段）`)
  console.log(`    · vector 版本 源/目标     : ${String((observations.vector as { sourceVectorVersion?: string } | undefined)?.sourceVectorVersion ?? '?')} → ${String((observations.vector as { targetVectorVersion?: string } | undefined)?.targetVectorVersion ?? '?')}`)
  console.log('')

  if (checks.length === 0) {
    console.error('measured_count = 0 ⇒ INVALID（不得当绿用）')
    process.exitCode = 1
  } else if (failed > 0) {
    process.exitCode = 1
  } else if (notRun.length > 0) {
    console.error(`\n${notRun.length} 项未运行 ⇒ 本门**不报 PASS**（关键证据缺失 ⇒ 拒收）。`)
    process.exitCode = 1
  }
}

await main()
