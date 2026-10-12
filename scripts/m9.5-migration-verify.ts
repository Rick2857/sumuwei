/**
 * M9.5 WP4 —— **派生 schema 的建/升门**（`pnpm m9.5:migration:verify`）。
 *
 * ============================================================================
 *  它验的是什么（与 kernel 迁移门**不是同一件事**）
 * ============================================================================
 * ```text
 * ADR-074 的 D31：语义召回的派生 schema 由 M9.5 按 `index_schema_version` **自己版本化**，
 * **不**追加 kernel 迁移链 —— 于是"迁移纪律"在这里的落点不是 `MIGRATIONS`，
 * 而是 `ensureSemanticIndexSchema()`。本门就是它的证据。
 *
 * 逐条判据（每条都对应一个真实风险）：
 *   ① fresh：空库上建出**全部**对象，且版本登记为 1
 *   ② 幂等：再跑一次 ⇒ `noop`，**零语句**（"每次都重跑 DDL"会让启动变慢且掩盖失败）
 *   ③ 失败关闭：记到的版本**比代码新** ⇒ `refuse-newer`，**一个对象都不动**
 *   ④ 无半成状态：中途注入失败 ⇒ 回滚，**对象集合与版本登记都不变**（T32 同族）
 *   ⑤ 半径：**只新增**派生对象；既有表的列集合**逐字段不变**；**零数据写入**
 *   ⑥ 真库/副本的保护：本门只在隔离库上跑；真实库只做只读树摘要（前后逐字相同）
 * ```
 *
 * 用法：`pnpm m9.5:migration:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import {
  SEMANTIC_INDEX_DDL,
  SEMANTIC_INDEX_DIMENSION,
  SEMANTIC_INDEX_SCHEMA_VERSION,
  SEMANTIC_META_ID,
  ensureSemanticIndexSchema,
  semanticIndexSchemaStatus,
  validateSemanticVector,
} from '../src/infrastructure/persistence/memory-semantic-index.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

import { sha256, type M4Harness } from './m4-harness.ts'
import { createM55Harness } from './m5.5-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  runIdFromM95OutPath,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-migration@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')

const DERIVED_TABLES = [
  'memory_semantic_meta',
  'memory_semantic_generations',
  'memory_semantic_index',
  'memory_semantic_failures',
] as const

interface Probe {
  readonly id: string
  readonly question: string
  readonly verdict: 'ok' | 'expected-failure' | 'unexpected'
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

async function probe(input: {
  readonly id: string
  readonly question: string
  readonly expectation: 'succeed' | 'fail'
  readonly run: () => Promise<Record<string, unknown>>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Promise<Probe> {
  try {
    const reading = await input.run()
    const problems = input.judge?.(reading) ?? []
    if (input.expectation === 'fail') {
      return { id: input.id, question: input.question, verdict: 'unexpected', reading, error: '应当失败却成功了' }
    }
    return {
      id: input.id,
      question: input.question,
      verdict: problems.length > 0 ? 'unexpected' : 'ok',
      reading,
      error: problems.length > 0 ? problems.join('; ') : null,
    }
  } catch (error) {
    return {
      id: input.id,
      question: input.question,
      verdict: input.expectation === 'fail' ? 'expected-failure' : 'unexpected',
      reading: {},
      error: (error as Error).message.replace(/\s+/g, ' ').slice(0, 200),
    }
  }
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function safeTreeDigest(): Record<string, unknown> | null {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return {
      dir: 'data/pglite',
      measuredCount: digest.measuredCount,
      totalBytes: digest.totalBytes,
      treeSha256: digest.treeSha256,
    }
  } catch (error) {
    return { dir: 'data/pglite', error: (error as Error).message }
  }
}

/** 派生对象 + 全部既有表的列集合（用来证明"半径只新增"）。 */
async function schemaFingerprint(db: M4Harness['db']): Promise<Record<string, string[]>> {
  const rows = rowsOf(
    await db.execute(
      sql`select table_name, column_name from information_schema.columns
          where table_schema = 'public' order by table_name, ordinal_position`
    )
  )
  const out: Record<string, string[]> = {}
  for (const row of rows) {
    const table = String(row.table_name)
    out[table] = out[table] ?? []
    out[table].push(String(row.column_name))
  }
  return out
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp4-migration', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()

  await resetPluginSqlConnection()
  isolateDatabase('m95-wp4-migration', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp4-migration' })
  const db = bed.h.db
  const probes: Probe[] = []

  /* ---- 半径基线：建表**之前**的既有表列集合 ---- */
  const beforeColumns = await schemaFingerprint(db)
  const derivedAbsentBefore = DERIVED_TABLES.every((table) => beforeColumns[table] === undefined)

  /* ---- ① fresh ---- */
  probes.push(
    await probe({
      id: 'fresh-create',
      question: '空库上建出全部派生对象，并把版本登记为代码认识的版本',
      expectation: 'succeed',
      run: async () => {
        /*
         * ⚠️ **2026-09-30：本场景先丢掉派生对象**（M10 的 `MIGRATION_0010` 之后必须这么做）。
         *
         * ```text
         * 原先的"fresh"= 内核迁移建完之后的**新库** —— 那时派生对象**必然不存在**，
         * 因为建它们的是 `ensureSemanticIndexSchema()`，而它不在迁移链里（`L-M10-66`）。
         * 用户 2026-09-30 裁定 **(a) 新增内核迁移** ⇒ `MIGRATION_0010` 现在**在新库上就建了它们**
         * ⇒ 原先的基线（"建表前就已存在派生对象"）**必然被破坏** —— 那不是回归，是**前提变了**。
         * ⇒ 修法：把"fresh"重新定义成"**ensure 路径还没跑过**"（先 drop 掉派生对象再测），
         *    于是本场景**照旧测 `ensureSemanticIndexSchema` 的 create 路径** ✓
         *    （它测的从来不是"迁移链里有没有"，而是"ensure 能不能从零建出来"）。
         * ```
         */
        for (const table of DERIVED_TABLES) {
          await db.execute(sql.raw(`drop table if exists ${table} cascade`))
        }
        let absentNow = true
        for (const table of DERIVED_TABLES) {
          const present = rowsOf(
            await db.execute(
              sql`select table_name from information_schema.tables
                  where table_schema = 'public' and table_name = ${table}`,
            ),
          ).length
          if (present > 0) absentNow = false
        }
        const statusBefore = await semanticIndexSchemaStatus(db)
        const result = await ensureSemanticIndexSchema(db, { now: 1_800_000_000_000 })
        const statusAfter = await semanticIndexSchemaStatus(db)
        const tables = rowsOf(
          await db.execute(
            sql`select table_name from information_schema.tables
                where table_schema = 'public' and table_name like 'memory_semantic%' order by table_name`
          )
        ).map((row) => String(row.table_name))
        const indexes = rowsOf(
          await db.execute(
            sql`select indexname from pg_indexes where tablename = 'memory_semantic_index' order by indexname`
          )
        ).map((row) => String(row.indexname))
        return {
          /* ⚠️ 用**当场重算**的值（场景自己 drop 过），而不是场景外的那个前置读数 */
          derivedAbsentBefore: absentNow,
          statusBefore,
          result,
          statusAfter,
          tables,
          indexes,
          metaRow: rowsOf(
            await db.execute(
              sql`select id, index_schema_version from memory_semantic_meta where id = ${SEMANTIC_META_ID}`
            )
          ).map((row) => ({ id: String(row.id), version: Number(row.index_schema_version) })),
          /*
           * ⚠️ **欠着的断言**（2026-10-01 补）：新建路径必须**把升级链也跑掉**。
           * 真缺陷：版本号被无条件写成当前值，而升级语句只在 `action === 'upgrade'` 时才跑
           * ⇒ 新建的库**自称 v2 却缺 v2 的那一列**，而且此后 `noop` 卡死、永远补不上。
           * ⚠️ 本门当时**是绿的** —— 它没有断言这件事，所以它没能拦住那个缺陷。
           */
          upgradedColumns: rowsOf(
            await db.execute(
              sql`select column_name from information_schema.columns
                   where table_name = 'memory_semantic_generations' order by column_name`
            )
          ).map((row) => String(row.column_name)),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.derivedAbsentBefore !== true) problems.push('基线：建表前就已存在派生对象（前提被破坏）')
        /*
         * ★ **本门曾经缺的那一条**：新建之后，**每一级升级带来的对象都必须在**。
         * 判据写成"升级语句里提到的列都在 `information_schema.columns` 里"（通用，不写死列名）。
         */
        const upgradedColumns = reading.upgradedColumns as string[]
        /*
         * ⚠️ 这份清单**跟着升级链走**：`SEMANTIC_INDEX_UPGRADES[1]` 加的是 `source_cursor`
         * ⇒ 加新升级时这里也要加（不然判据会漏掉新列）。
         */
        const requiredColumns = ['source_cursor']
        const missing = requiredColumns.filter((column) => !upgradedColumns.includes(column))
        if (missing.length > 0) {
          problems.push(
            `★ **新建路径没有跑升级链**：缺列 ${missing.join(', ')} —— 库会自称 v${String(SEMANTIC_INDEX_SCHEMA_VERSION)} 却缺对象（` +
              '而此后 noop 卡死、永远补不上）。这是 2026-10-01 实测过的真缺陷形状'
          )
        }
        const statusBefore = reading.statusBefore as { action?: string }
        if (statusBefore?.action !== 'create') problems.push(`建表前状态应为 create，实际 ${String(statusBefore?.action)}`)
        const result = reading.result as { action?: string; committed?: boolean }
        if (result?.action !== 'create' || result?.committed !== true) {
          problems.push(`建表结果应为 create+committed，实际 ${JSON.stringify(result)}`)
        }
        const tables = reading.tables as string[]
        if (tables.length !== DERIVED_TABLES.length) {
          problems.push(`派生表应为 ${String(DERIVED_TABLES.length)} 张，实际 ${String(tables.length)}：${tables.join(',')}`)
        }
        const indexes = reading.indexes as string[]
        if (!indexes.includes('memory_semantic_index_scope')) problems.push('缺 (namespace, generation_id, memory_id) 复合索引')
        const statusAfter = reading.statusAfter as { action?: string; recordedVersion?: number }
        if (statusAfter?.action !== 'noop' || statusAfter?.recordedVersion !== SEMANTIC_INDEX_SCHEMA_VERSION) {
          problems.push(`建完之后应为 noop@v${String(SEMANTIC_INDEX_SCHEMA_VERSION)}，实际 ${JSON.stringify(statusAfter)}`)
        }
        return problems
      },
    })
  )

  /* ---- ② 幂等 ---- */
  probes.push(
    await probe({
      id: 'idempotent-noop',
      question: '已是最新时再跑一次 ⇒ noop 且**零语句**（不重跑 DDL）',
      expectation: 'succeed',
      run: async () => {
        const result = await ensureSemanticIndexSchema(db, { now: 1_800_000_000_001 })
        return { action: result.action, statementsRun: result.statementsRun, committed: result.committed }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.action !== 'noop') problems.push(`应为 noop，实际 ${String(reading.action)}`)
        if (reading.statementsRun !== 0) problems.push(`应跑 0 条语句，实际 ${String(reading.statementsRun)}`)
        if (reading.committed !== false) problems.push('noop 不应开事务')
        return problems
      },
    })
  )

  /* ---- ③ 失败关闭：记到的版本比代码新 ---- */
  probes.push(
    await probe({
      id: 'refuse-newer-version',
      question: '记到的派生 schema 版本比代码新 ⇒ refuse-newer，**一个对象都不动**',
      expectation: 'succeed',
      run: async () => {
        await db.execute(
          sql`update memory_semantic_meta set index_schema_version = ${SEMANTIC_INDEX_SCHEMA_VERSION + 5}
              where id = ${SEMANTIC_META_ID}`
        )
        const tablesBefore = rowsOf(
          await db.execute(
            sql`select table_name from information_schema.tables
                where table_schema = 'public' and table_name like 'memory_semantic%' order by table_name`
          )
        ).map((row) => String(row.table_name))
        const status = await semanticIndexSchemaStatus(db)
        const result = await ensureSemanticIndexSchema(db, { now: 1_800_000_000_002 })
        const tablesAfter = rowsOf(
          await db.execute(
            sql`select table_name from information_schema.tables
                where table_schema = 'public' and table_name like 'memory_semantic%' order by table_name`
          )
        ).map((row) => String(row.table_name))
        const recorded = rowsOf(
          await db.execute(
            sql`select index_schema_version from memory_semantic_meta where id = ${SEMANTIC_META_ID}`
          )
        )[0]?.index_schema_version
        /* 还原，免得影响后续探针 */
        await db.execute(
          sql`update memory_semantic_meta set index_schema_version = ${SEMANTIC_INDEX_SCHEMA_VERSION}
              where id = ${SEMANTIC_META_ID}`
        )
        return {
          status,
          result: { action: result.action, statementsRun: result.statementsRun, committed: result.committed },
          tablesUnchanged: JSON.stringify(tablesBefore) === JSON.stringify(tablesAfter),
          recordedVersionUnchanged: Number(recorded) === SEMANTIC_INDEX_SCHEMA_VERSION + 5,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        const status = reading.status as { action?: string; detail?: string }
        if (status?.action !== 'refuse-newer') problems.push(`状态应为 refuse-newer，实际 ${String(status?.action)}`)
        const result = reading.result as { action?: string; statementsRun?: number; committed?: boolean }
        if (result?.action !== 'refuse-newer') problems.push(`结果应为 refuse-newer，实际 ${String(result?.action)}`)
        if (result?.statementsRun !== 0) problems.push('refuse-newer 不应跑任何语句')
        if (result?.committed !== false) problems.push('refuse-newer 不应开事务')
        if (reading.tablesUnchanged !== true) problems.push('refuse-newer 却改动了对象集合')
        if (reading.recordedVersionUnchanged !== true) problems.push('refuse-newer 却改了版本登记')
        return problems
      },
    })
  )

  /* ---- ④ 无半成状态（T32 同族）：中途注入失败 ---- */
  probes.push(
    await probe({
      id: 'mid-failure-no-half-state',
      question: '建表过程中途失败 ⇒ 回滚，对象集合与版本登记**都不变**（T32 同族）',
      expectation: 'succeed',
      run: async () => {
        /* 先在**另一个隔离库**上做，避免把本库的派生对象拆掉 —— 但同进程只有单例库，
           所以做法是：先删掉派生对象回到"未建"，注入失败，再验证"仍未建"，最后重建。 */
        for (const table of ['memory_semantic_failures', 'memory_semantic_index', 'memory_semantic_generations', 'memory_semantic_meta']) {
          await db.execute(sql.raw(`drop table if exists ${table}`))
        }
        const before = await semanticIndexSchemaStatus(db)
        let threw = false
        let errorText = ''
        try {
          await ensureSemanticIndexSchema(db, { now: 1, failAfterStatement: 3 })
        } catch (error) {
          threw = true
          errorText = (error as Error).message.slice(0, 120)
        }
        const afterFailure = await semanticIndexSchemaStatus(db)
        const tablesAfterFailure = rowsOf(
          await db.execute(
            sql`select table_name from information_schema.tables
                where table_schema = 'public' and table_name like 'memory_semantic%' order by table_name`
          )
        ).map((row) => String(row.table_name))
        /* 恢复：正常建起来，供后续探针使用 */
        const restored = await ensureSemanticIndexSchema(db, { now: 2 })
        return {
          statusBefore: before,
          threw,
          errorText,
          statusAfterFailure: afterFailure,
          tablesAfterFailure,
          restoredAction: restored.action,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.threw !== true) problems.push('注入失败没有抛错')
        const after = reading.statusAfterFailure as { action?: string; metaPresent?: boolean }
        if (after?.metaPresent !== false) problems.push('回滚后仍能看到 memory_semantic_meta ⇒ 有半成状态')
        const tables = reading.tablesAfterFailure as string[]
        if (tables.length !== 0) problems.push(`回滚后仍有派生对象：${tables.join(',')}`)
        if (reading.restoredAction !== 'create') problems.push(`恢复建表应回到 create，实际 ${String(reading.restoredAction)}`)
        return problems
      },
    })
  )

  /* ---- ⑤ 半径：只新增派生对象；既有表逐字段不变；零数据写入 ---- */
  probes.push(
    await probe({
      id: 'radius-only-additive',
      question: '半径最小：既有表的列集合逐字段不变，且**不写任何既有表的行**',
      expectation: 'succeed',
      run: async () => {
        const afterColumns = await schemaFingerprint(db)
        const existingTables = Object.keys(beforeColumns).filter(
          (table) => !DERIVED_TABLES.includes(table as (typeof DERIVED_TABLES)[number])
        )
        const columnDiffs: string[] = []
        for (const table of existingTables) {
          const before = (beforeColumns[table] ?? []).join(',')
          const after = (afterColumns[table] ?? []).join(',')
          if (before !== after) columnDiffs.push(`${table}: ${before} → ${after}`)
        }
        const newTables = Object.keys(afterColumns).filter((table) => beforeColumns[table] === undefined)
        const unexpectedNewTables = newTables.filter(
          (table) => !DERIVED_TABLES.includes(table as (typeof DERIVED_TABLES)[number])
        )
        /* DDL 里**不得**出现任何写既有数据的语句 */
        const ddlText = SEMANTIC_INDEX_DDL.join('\n').toLowerCase()
        const forbidden = ['insert into character_', 'update character_', 'delete from character_', 'alter table character_', 'truncate']
          .filter((needle) => ddlText.includes(needle))
        return {
          existingTableCount: existingTables.length,
          columnDiffs,
          newTables,
          unexpectedNewTables,
          forbiddenInDdl: forbidden,
          /** 计数型自检：0 张既有表可比 ≠ 半径正确 */
          comparedExistingTables: existingTables.length,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.comparedExistingTables) <= 0) problems.push('没比到任何既有表 ⇒ MEASUREMENT INVALID')
        if ((reading.columnDiffs as string[]).length > 0) {
          problems.push(`既有表列集合被改动：${(reading.columnDiffs as string[]).join(' | ')}`)
        }
        if ((reading.unexpectedNewTables as string[]).length > 0) {
          problems.push(`新增了非派生对象：${(reading.unexpectedNewTables as string[]).join(',')}`)
        }
        if ((reading.forbiddenInDdl as string[]).length > 0) {
          problems.push(`DDL 里出现对既有表的写操作：${(reading.forbiddenInDdl as string[]).join(',')}`)
        }
        return problems
      },
    })
  )

  /* ---- ⑥ 维度与向量校验（D28 单实现） ---- */
  probes.push(
    await probe({
      id: 'dimension-and-vector-validation',
      question: `表的维度承诺 ${String(SEMANTIC_INDEX_DIMENSION)}，且 validateSemanticVector 拒三类非法向量`,
      expectation: 'succeed',
      run: async () => {
        const zero = new Array(SEMANTIC_INDEX_DIMENSION).fill(0) as number[]
        const nan = new Array(SEMANTIC_INDEX_DIMENSION).fill(0.1) as number[]
        nan[0] = Number.NaN
        const denormalized = new Array(SEMANTIC_INDEX_DIMENSION).fill(0.5) as number[]
        const short = new Array(SEMANTIC_INDEX_DIMENSION - 1).fill(0.1) as number[]
        const unit = new Array(SEMANTIC_INDEX_DIMENSION).fill(0) as number[]
        unit[0] = 1
        const columnType = rowsOf(
          await db.execute(
            sql`select udt_name from information_schema.columns
                where table_name = 'memory_semantic_index' and column_name = 'embedding'`
          )
        )[0]?.udt_name
        /** 数据库侧：383 维必须被拒（第二道） */
        let dbRejectedShort = false
        try {
          await db.execute(
            sql`insert into memory_semantic_index
                (namespace, memory_id, source_revision, generation_id, model_fingerprint,
                 renderer_version, content_hash, tokenizer_fingerprint, pooling, normalize,
                 dtype, dimension, embedding, created_at)
                values ('C1','mem:short',1,'g','m','r','h','t','mean',true,'q8',${SEMANTIC_INDEX_DIMENSION},
                        ${`[${short.map((v) => v.toFixed(8)).join(',')}]`}::vector, 1)`
          )
          dbRejectedShort = false
        } catch {
          dbRejectedShort = true
        }
        return {
          columnType: String(columnType),
          dbRejectedShort,
          zeroNorm: validateSemanticVector(zero),
          nanComponent: validateSemanticVector(nan),
          notNormalized: validateSemanticVector(denormalized),
          wrongDimension: validateSemanticVector(short),
          unitVectorAccepted: validateSemanticVector(unit),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.columnType !== 'vector') problems.push(`embedding 列类型 ${String(reading.columnType)}`)
        if (reading.dbRejectedShort !== true) problems.push('数据库没有拒绝 383 维向量')
        if (reading.zeroNorm !== 'invalid_vector:zero_norm') problems.push(`零范数未被具名拒绝：${String(reading.zeroNorm)}`)
        if (reading.nanComponent !== 'invalid_vector:nan_or_inf') problems.push(`NaN 未被具名拒绝：${String(reading.nanComponent)}`)
        if (typeof reading.notNormalized !== 'string' || !reading.notNormalized.startsWith('invalid_vector:not_normalized')) {
          problems.push(`未归一化未被具名拒绝：${String(reading.notNormalized)}`)
        }
        if (typeof reading.wrongDimension !== 'string' || !reading.wrongDimension.startsWith('invalid_vector:dimension')) {
          problems.push(`维度不符未被具名拒绝：${String(reading.wrongDimension)}`)
        }
        if (reading.unitVectorAccepted !== null) problems.push(`单位向量被误拒：${String(reading.unitVectorAccepted)}`)
        return problems
      },
    })
  )

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })

  await bed.dispose()
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged =
    JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter) &&
    realDbBefore !== null &&
    typeof realDbBefore.treeSha256 === 'string'

  const payload = {
    schemaVersion: 'm9.5-migration@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      mechanism: 'M9.5 自有的派生 schema 版本化（ADR-074 的 D31；**不**追加 kernel 迁移链）',
      versionConstant: SEMANTIC_INDEX_SCHEMA_VERSION,
      notProves: '**不**证明 kernel 迁移链被改动（本设计刻意不动它，`latestSchemaVersion()` 保持 9）',
      applierFile: 'src/infrastructure/persistence/memory-semantic-index.ts',
    },
    ddl: SEMANTIC_INDEX_DDL,
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }

  const evidencePath = join(runDir, 'migration-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp4',
    lane: 'offline',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: GATE_VERSION,
    dbKind: 'synthetic',
    isolationProof: {
      sandboxIsolationUsed: true,
      realDbDigestBefore: realDbBefore,
      realDbDigestAfter: realDbAfter,
      realDbUnchanged,
      method: 'isolateDatabase() + digestTree() 前后比对（只读）',
    },
    configHash: { indexSchemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION, dimension: SEMANTIC_INDEX_DIMENSION },
    command: [{ cmd: 'pnpm m9.5:migration:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'migration-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP4 派生 schema 建/升门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
