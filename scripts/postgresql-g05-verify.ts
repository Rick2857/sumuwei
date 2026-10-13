/**
 * PG-G05 迁移完整性（WP5）—— **全库逐表内容比较**。
 *
 * ============================================================================
 *  这道门要回答什么（契约 §3 / `G05.1…G05.9`）
 * ============================================================================
 * ```text
 *   G05.1  完整表清单一致（来源 51 张 public 基表 → 目标同集合；缺一张即 FAIL）
 *   G05.2  主键集合一致
 *   G05.3  规定字段摘要一致（规范化 JSON / 时间 / 数字编码）
 *   G05.4  来源 / 归因 / 更正撤回链完整（不忽略 retracted / corrected 历史）
 *   G05.5  记忆生命周期字段完整（不物理丢弃）
 *   G05.6  消费者水位与序号完整（**不**推进水位来跳过问题）
 *   G05.7  插件历史（agents / memories / rooms / participants / entities / worlds / embeddings）完整
 *   G05.8  无主键表用**稳定行多重集**比较（不只比总数）
 *   G05.9  迁移登记表 character_schema_migrations 的行集合与来源一致（18 行）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  它与 `PG-G09` 的分工（很重要，别混）
 * ---------------------------------------------------------------------------
 * ```text
 *   PG-G09  量具**自身**有效吗？  ⇒ 纯函数真值表 + 一张 18 行真表的跨驱动正控 + 四条具名负控
 *   PG-G05  用那个量具比**整个库** ⇒ 54 张表（4261 行）逐表规范化摘要 + 主题面 + 真数据负控
 * ```
 *
 * ---------------------------------------------------------------------------
 *  两侧怎么读（这是本门的技术核心）
 * ---------------------------------------------------------------------------
 *  源 = verified 快照的**一次性副本**（`openPgliteSnapshot`：复制一次、打开一次、读多表）。
 *  目标 = 从**同一份快照导出**的 SQL 恢复出来的真 PG。
 *
 *  两侧必须**拿到同一段文本**才能比 —— 见 `column-encoding.ts`（判据只写那一处）。
 *  这道门第一次跑就验证了这条不变式的必要性：
 *
 * ```text
 *   源（PGlite）把无时区的 timestamp 给成 **Date**（解释里带上了时区），
 *   而目标给的是**无时区文本** ⇒ 直接比会**假不等**；
 *   vector 一侧是数组、一侧是 pgvector 文本；bigint 一侧 number、一侧 JSON 数字（>2^53 丢精度）。
 * ```
 *
 * ---------------------------------------------------------------------------
 *  负控为什么用"改一处 + 前置证明改动真的发生了"
 * ---------------------------------------------------------------------------
 *  六条真数据负控各自**只改一处**，且每条都先证明"这次改动确实生效了"
 *  （`before !== after`）。否则一条**没生效**的改动会让门报"比较器没抓到" ——
 *  那是**假红**，而假红会把人引去修一个没坏的东西。
 *
 * 跑法：pnpm postgresql:g05:verify
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  PG_CONTAINER,
  PG_CREDENTIALS_FILE,
  PG_HOST_PORT,
  loadPgCredentials,
  missingCredentialKeys,
} from './postgresql/credentials.ts'
import { psql, psqlFile, psqlFromStdin } from './postgresql/pg-exec.ts'
import { requiresTextEncoding, textEncodingReason } from './postgresql/column-encoding.ts'
import {
  canonicalDecimal,
  compareTableDigests,
  normalizeByType,
  tableDigest,
  type TableDigest,
} from './postgresql/row-digest.ts'
import { openPgliteSnapshot, type SnapshotTable } from './postgresql/pglite-reader.ts'
import { listTargetTables, parseRowJson, readTargetCatalog, readTargetTableRows } from './postgresql/pg-target-reader.ts'
import { dumpPgliteSnapshot, EXPORT_RUNTIME_DIR, PINNED_TOOLS_VERSION } from './postgresql/pglite-dump.ts'

// ===========================================================================
// 配置
// ===========================================================================
const CONTAINER = PG_CONTAINER
const HOST_PORT = PG_HOST_PORT
const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'

const TARGET_DB = 'lg_test_g05'
const MIGRATE_USER = 'lg_migrate'

const LOCAL_DIR = resolve('artifacts/post-lv2/local/pg-migration')
const RESTORE_SQL = join(LOCAL_DIR, 'g05-src-restore.sql')
/** 与 WP4 同一套排除集（**逐条原因见 WP4 Handoff §3.2**） */
const RESTORE_ARGS = ['--no-owner', '--no-privileges', '--no-comments']

const UTC_STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const RUN_ID = `pg-migration-g05-${UTC_STAMP}`
const EVIDENCE_DIR = resolve(`artifacts/post-lv2/postgresql-migration/${RUN_ID}`)

const credentials = loadPgCredentials()
const missingKeys = missingCredentialKeys(credentials)

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
// §1 纯函数层：两侧编码判据 + 精确十进制
// ===========================================================================
check('G05.0a `requiresTextEncoding` 真值表：**歧义类型必须转文本**，无歧义类型保持原生', () => {
  for (const t of [
    'bigint',
    'int8',
    'numeric',
    'decimal',
    'real',
    'double precision',
    'vector',
    'ARRAY',
    'timestamp without time zone',
    'date',
    'time without time zone',
  ]) {
    assert.equal(requiresTextEncoding(t), true, `${t} 应当转文本（${textEncodingReason(t)}）`)
  }
  for (const t of ['text', 'character varying', 'uuid', 'boolean', 'jsonb', 'json', 'integer', 'timestamp with time zone']) {
    assert.equal(requiresTextEncoding(t), false, `${t} 应当保持原生`)
  }
  // ⚠️ 默认方向是**转文本**（不认识就选不丢信息的那条路）
  assert.equal(requiresTextEncoding('some_future_type'), true)
})

check('G05.0b ★ `canonicalDecimal`：`1.50` ≡ `1.5`，但 `1.00000000000000001` ≠ `1`（第 18 位不许被抹平）', () => {
  assert.equal(canonicalDecimal('1.50'), canonicalDecimal('1.5'))
  assert.equal(canonicalDecimal('1e3'), '1000')
  assert.equal(canonicalDecimal('0.1'), canonicalDecimal('.1'))
  assert.equal(canonicalDecimal('-0'), '0')
  assert.equal(canonicalDecimal('007'), '7')
  // ★ 这条才是这个函数存在的理由：`Number()` 会把两者都变成 1
  assert.notEqual(
    canonicalDecimal('1.00000000000000001'),
    canonicalDecimal('1'),
    '第 18 位有效数字被抹平了 ⇒ numeric 会造出假相等'
  )
  assert.notEqual(canonicalDecimal('9007199254740993'), canonicalDecimal('9007199254740992'))
})

check('G05.0c `numeric` 走精确路径（不是 `Number`）：`normalizeByType` 也保得住第 18 位', () => {
  assert.notEqual(
    normalizeByType('1.00000000000000001', 'numeric'),
    normalizeByType('1', 'numeric'),
    'numeric 归一化把两个不同的值压成了同一个'
  )
  assert.equal(normalizeByType('1.50', 'numeric'), normalizeByType(1.5, 'numeric'))
  // 对照：`double precision` **刻意**是"15 位有效数字"口径（二进制浮点本来就没有精确十进制表示）
  assert.equal(normalizeByType(0.1, 'double precision'), normalizeByType('0.1', 'double precision'))
})

check('G05.0d 不变式①：**两侧拿到同一段文本 ⇒ 规范化结果必然相同**（文本路径的全部理由）', () => {
  const samples: [string, string][] = [
    ['vector', '[0.1,0.2,0.30000001]'],
    ['timestamp without time zone', '2026-09-15 07:39:50.155'],
    ['bigint', '1789486790281'],
    ['double precision', '0.85'],
    ['ARRAY', '{a,b,c}'],
  ]
  for (const [type, text] of samples) {
    assert.equal(normalizeByType(text, type), normalizeByType(text, type), `${type} 对同一段文本给出了不同结果`)
  }
})

check('G05.0e `parseRowJson` 对坏输入**具名拒绝**（不静默返回空数组）', () => {
  assert.deepEqual(parseRowJson('[]', 'x'), [])
  assert.deepEqual(parseRowJson('[{"a":1}]', 'x'), [{ a: 1 }])
  for (const bad of ['not json', '{"a":1}', '']) {
    assert.throws(() => parseRowJson(bad, 'x'), /不是 JSON|不是数组/, `坏输入没有被拒绝：${JSON.stringify(bad)}`)
  }
})

check('G05.0f 编码判据与读取器**同源**（改一处就同时改两侧，不会漂）', () => {
  // 结构性断言：两个读取器都必须 import 同一个判据模块。
  // ⚠️ 它**只**证明"两处都引用了它"，不证明"用对了"—— 用对了由 §2 的全库比较证明。
  const source = readFileSync(resolve('scripts/postgresql/pglite-reader.ts'), 'utf8')
  const target = readFileSync(resolve('scripts/postgresql/pg-target-reader.ts'), 'utf8')
  assert.match(source, /from '\.\/column-encoding\.ts'/)
  assert.match(target, /from '\.\/column-encoding\.ts'/)
})

// ===========================================================================
// §2 真实例：源副本 ↔ 从同一快照恢复的真 PG
// ===========================================================================
interface SideReading {
  columns: { name: string; dataType: string }[]
  primaryKey: string[]
  rows: Record<string, unknown>[]
}

function keyOf(table: SnapshotTable): string {
  return `${table.schema}.${table.name}`
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
      id: 'full-table-comparison',
      what: '全库逐表内容比较（G05.1–G05.9 的真实例部分）',
      why: blocked,
    })
  } else {
    const password = credentials!.LG_PG_MIGRATE_PASSWORD
    const queryOf = (database: string) => (sql: string): string | undefined => {
      const r = psql({ container: CONTAINER, user: MIGRATE_USER, password, database, sql, timeoutMs: 600_000 })
      note({ command: r.command, rc: r.rc })
      return r.rc === 0 ? r.out : undefined
    }
    const manageTestDb = (script: 'create-test-db.sql' | 'drop-test-db.sql'): ReturnType<typeof psqlFile> => {
      const r = psqlFile({
        container: CONTAINER,
        user: credentials!.LG_PG_BOOTSTRAP_USER,
        password: credentials!.LG_PG_BOOTSTRAP_PASSWORD,
        database: credentials!.LG_PG_BOOTSTRAP_DB,
        file: `/opt/lg/${script}`,
        variables: { LG_TEST_DB_NAME: TARGET_DB, LG_PG_MIGRATE_USER: MIGRATE_USER },
      })
      note({ command: r.command, rc: r.rc })
      return r
    }
    const scalar = (sql: string): string => queryOf(TARGET_DB)(sql) ?? '(read failed)'
    const mutate = (sql: string): { rc: number; err: string } => {
      const r = psql({ container: CONTAINER, user: MIGRATE_USER, password, database: TARGET_DB, sql })
      note({ command: r.command, rc: r.rc })
      return { rc: r.rc, err: r.err }
    }

    let session: Awaited<ReturnType<typeof openPgliteSnapshot>> | undefined
    try {
      // ---------------------------------------------------------------------
      // 1) 读源（**一次复制、一次打开、读多表**）
      // ---------------------------------------------------------------------
      session = await openPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT })
      const sourceTables = await session.listTables()
      const sourceReadings = new Map<string, SideReading>()
      const sourceDigests = new Map<string, TableDigest>()
      for (const table of sourceTables) {
        const reading = await session.readTable(table.schema, table.name)
        sourceReadings.set(keyOf(table), {
          columns: reading.columns,
          primaryKey: reading.primaryKey,
          rows: reading.rows,
        })
        sourceDigests.set(
          keyOf(table),
          tableDigest({
            table: keyOf(table),
            rows: reading.rows,
            columns: reading.columns,
            primaryKey: reading.primaryKey,
          })
        )
      }
      const sourceRowTotal = [...sourceReadings.values()].reduce((sum, r) => sum + r.rows.length, 0)
      const sourcePublic = sourceTables.filter((t) => t.schema === 'public')
      const sourceMigrations = sourceTables.filter((t) => t.schema === 'migrations')
      observations.source = {
        tables: sourceTables.length,
        publicTables: sourcePublic.length,
        migrationsTables: sourceMigrations.length,
        rows: sourceRowTotal,
        tablesWithoutPrimaryKey: [...sourceReadings.entries()]
          .filter(([, r]) => r.primaryKey.length === 0)
          .map(([k]) => k),
      }

      check('G05.1a 前置：源快照读出来了，且**源目录逐字未动**（只读副本）', () => {
        assert.equal(sourcePublic.length, 51, `来源 public 基表应为 51 张，实读 ${sourcePublic.length}`)
        assert.equal(sourceMigrations.length, 3, `migrations schema 应为 3 张，实读 ${sourceMigrations.length}`)
        assert.ok(sourceRowTotal > 4_000, `源总行数太少（${sourceRowTotal}）⇒ 这条比较没量到东西`)
      })

      // ---------------------------------------------------------------------
      // 2) 目标：从**同一份快照**导出并恢复到空库
      // ---------------------------------------------------------------------
      manageTestDb('drop-test-db.sql')
      const created = manageTestDb('create-test-db.sql')
      check('G05.1b 前置：目标测试库从零建立', () => {
        assert.equal(created.rc, 0, created.err)
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
      const restore = psqlFromStdin({
        container: CONTAINER,
        user: MIGRATE_USER,
        password,
        database: TARGET_DB,
        sql: sourceDump.sql,
        timeoutMs: 900_000,
      })
      note({ command: restore.command, rc: restore.rc })
      check('G05.1c 前置：快照已恢复进目标（exit 0，且日志里没有 ERROR）', () => {
        assert.equal(restore.rc, 0, restore.err.slice(0, 500))
        assert.ok(!/^ERROR/m.test(restore.err), `恢复日志里有 ERROR：${restore.err.slice(0, 500)}`)
      })

      const query = queryOf(TARGET_DB)
      const targetTables = listTargetTables(query)
      const catalog = readTargetCatalog(query)
      check('G05.1d 前置：目标侧的清单与列规格读出来了', () => {
        assert.ok(targetTables !== undefined, '目标表清单读不出来')
        assert.ok(catalog !== undefined, '目标列规格读不出来')
      })

      // ---------------------------------------------------------------------
      // 3) G05.1 表清单 / G05.2 主键集合 / 列规格
      // ---------------------------------------------------------------------
      const targetKeys = (targetTables ?? []).map(keyOf).sort()
      const sourceKeys = sourceTables.map(keyOf).sort()
      check('G05.1 ★ 完整表清单一致（**双向**差集都为空）', () => {
        assert.deepEqual(
          sourceKeys.filter((k) => !targetKeys.includes(k)),
          [],
          '目标缺表'
        )
        assert.deepEqual(
          targetKeys.filter((k) => !sourceKeys.includes(k)),
          [],
          '目标多表'
        )
        assert.equal(targetKeys.length, 54, `目标表数应为 54，实读 ${targetKeys.length}`)
        assert.equal(
          targetKeys.filter((k) => k.startsWith('public.')).length,
          51,
          '目标 public 基表应为 51 张'
        )
      })

      check('G05.2 ★ 主键集合逐表一致（列规格也一致）', () => {
        const problems: string[] = []
        for (const key of sourceKeys) {
          const source = sourceReadings.get(key)!
          const target = catalog?.get(key)
          if (target === undefined) {
            problems.push(`${key}: 目标没有这张表的列规格`)
            continue
          }
          if (source.primaryKey.join(',') !== target.primaryKey.join(',')) {
            problems.push(`${key}: 主键 [${source.primaryKey.join(',')}] ≠ [${target.primaryKey.join(',')}]`)
          }
          const sourceColumns = source.columns.map((c) => `${c.name}:${c.dataType}`).join(',')
          const targetColumns = target.columns.map((c) => `${c.name}:${c.dataType}`).join(',')
          if (sourceColumns !== targetColumns) {
            problems.push(`${key}: 列规格不同`)
          }
        }
        assert.deepEqual(problems, [], problems.join('；'))
      })

      // ---------------------------------------------------------------------
      // 4) 逐表读目标 + 摘要比较（G05.3 的主体）
      // ---------------------------------------------------------------------
      const targetDigests = new Map<string, TableDigest>()
      const readTarget = (key: string): TableDigest | undefined => {
        const [schema, table] = key.split('.')
        const entry = catalog?.get(key)
        if (entry === undefined) return undefined
        const rows = readTargetTableRows(query, schema, table, entry.columns)
        if (rows === undefined) return undefined
        const digest = tableDigest({ table: key, rows, columns: entry.columns, primaryKey: entry.primaryKey })
        targetDigests.set(key, digest)
        return digest
      }

      const comparisons: { key: string; match: boolean; reason?: string; sourceRows: number; targetRows: number }[] = []
      for (const key of sourceKeys) {
        const targetDigest = readTarget(key)
        if (targetDigest === undefined) {
          comparisons.push({ key, match: false, reason: 'target_unreadable', sourceRows: 0, targetRows: 0 })
          continue
        }
        const sourceDigest = sourceDigests.get(key)!
        const result = compareTableDigests(sourceDigest, targetDigest)
        comparisons.push({
          key,
          match: result.match,
          reason: result.reason,
          sourceRows: sourceDigest.rowCount,
          targetRows: targetDigest.rowCount,
        })
      }
      const mismatched = comparisons.filter((c) => !c.match)
      observations.tableComparison = {
        tables: comparisons.length,
        matched: comparisons.length - mismatched.length,
        mismatched: mismatched.map((c) => `${c.key}:${c.reason ?? '?'}`),
        strategies: {
          primaryKey: [...sourceDigests.values()].filter((d) => d.strategy === 'primary-key').length,
          multiset: [...sourceDigests.values()].filter((d) => d.strategy === 'multiset').length,
        },
        perTable: comparisons.map((c) => ({
          table: c.key,
          rows: c.sourceRows,
          match: c.match,
          reason: c.reason ?? null,
          digest: sourceDigests.get(c.key)?.digest.slice(0, 16) ?? null,
        })),
      }

      check('G05.3 ★ 全部 54 张表的**规范化内容摘要**逐表一致（G05.1 表清单 + G05.3 字段摘要）', () => {
        assert.equal(comparisons.length, 54, `参与比较的表数应为 54，实为 ${comparisons.length}`)
        assert.deepEqual(
          mismatched.map((c) => `${c.key}:${c.reason ?? '?'}`),
          [],
          `逐表摘要不一致：${mismatched.map((c) => `${c.key}:${c.reason}`).join('；')}`
        )
      })

      check('G05.8 ★ 无主键表用**稳定行多重集**比较（不只比总数）', () => {
        const noPk = [...sourceReadings.entries()].filter(([, r]) => r.primaryKey.length === 0).map(([k]) => k)
        assert.deepEqual(noPk, ['public.logs'], `无主键的表应只有 public.logs，实为 ${noPk.join(', ')}`)
        assert.equal(sourceDigests.get('public.logs')?.strategy, 'multiset')
        assert.equal(targetDigests.get('public.logs')?.strategy, 'multiset')
        assert.ok((sourceDigests.get('public.logs')?.rowCount ?? 0) > 100, '这张表行数太少 ⇒ 多重集判据没量到东西')
      })

      // ---------------------------------------------------------------------
      // 5) 主题面（G05.4 / G05.5 / G05.6 / G05.7 / G05.9）
      // ---------------------------------------------------------------------
      // ⚠️ 目标侧的行**留一份缓存**：54 张表 4261 行，内存代价可忽略，
      //    而主题面（分布 / 非空计数）要在**同一批读数**上算 —— 不然每断言一次就重读一遍。
      const targetRowsCache = new Map<string, Record<string, unknown>[]>()
      const targetRowsOf = (key: string): Record<string, unknown>[] | undefined => {
        const cached = targetRowsCache.get(key)
        if (cached !== undefined) return cached
        const [schema, table] = key.split('.')
        const entry = catalog?.get(key)
        if (entry === undefined) return undefined
        const rows = readTargetTableRows(query, schema, table, entry.columns)
        if (rows === undefined) return undefined
        targetRowsCache.set(key, rows)
        return rows
      }

      const countBy = (rows: readonly Record<string, unknown>[], column: string): Record<string, number> => {
        const counts: Record<string, number> = {}
        for (const row of rows) {
          const value = row[column] === null || row[column] === undefined ? '(null)' : String(row[column])
          counts[value] = (counts[value] ?? 0) + 1
        }
        return counts
      }
      const nonNullCount = (rows: readonly Record<string, unknown>[], column: string): number =>
        rows.filter((row) => row[column] !== null && row[column] !== undefined).length

      check('G05.4 ★ 来源 / 归因 / 更正撤回链完整（`memory_records` 的三个取值面两侧逐项相同）', () => {
        const key = 'public.memory_records'
        const source = sourceReadings.get(key)!.rows
        const target = targetRowsOf(key)
        assert.ok(target !== undefined, '目标侧 memory_records 读不出来')
        assert.ok(source.length > 0, '前置：源里这张表是空的 ⇒ 判据没量到东西')
        for (const column of ['status', 'epistemic_status', 'authority', 'content_kind', 'memory_type']) {
          assert.deepEqual(
            countBy(target!, column),
            countBy(source, column),
            `${column} 的取值分布两侧不同`
          )
        }
        observations.sourceChain = {
          rows: source.length,
          status: countBy(source, 'status'),
          epistemicStatus: countBy(source, 'epistemic_status'),
          authority: countBy(source, 'authority'),
          supersededByNonNull: nonNullCount(source, 'superseded_by'),
          validUntilNonNull: nonNullCount(source, 'valid_until'),
        }
      })

      check('G05.5 ★ 记忆生命周期字段完整（字段**在**、取值面**同**、历史**没被物理丢弃**）', () => {
        const key = 'public.memory_records'
        const source = sourceReadings.get(key)!.rows
        const target = targetRowsOf(key)!
        const lifecycle = ['valid_from', 'valid_until', 'occurred_at', 'recorded_at', 'superseded_by', 'revision', 'schema_version']
        const present = new Set(sourceReadings.get(key)!.columns.map((c) => c.name))
        for (const column of lifecycle) {
          assert.ok(present.has(column), `生命周期字段 ${column} 在源里不存在（schema 变了？）`)
          assert.equal(
            nonNullCount(target, column),
            nonNullCount(source, column),
            `生命周期字段 ${column} 的非空计数两侧不同`
          )
        }
        for (const [table, expected] of [
          ['public.memories', 146],
          ['public.memory_records', 5],
          ['public.memory_events', 7],
        ] as const) {
          const rows = targetRowsOf(table)
          assert.ok(rows !== undefined, `${table} 读不出来`)
          assert.equal(rows!.length, expected, `${table} 行数与源不同（历史可能被物理丢弃）`)
        }
        observations.memoryLifecycle = {
          lifecycleFields: lifecycle.map((column) => ({ column, nonNull: nonNullCount(source, column) })),
          memoryEventsKinds: countBy(sourceReadings.get('public.memory_events')!.rows, 'kind'),
        }
      })

      check('G05.6 ★ 消费者水位与序号完整（**不推进**水位来跳过问题）', () => {
        const watermarkOf = (rows: readonly Record<string, unknown>[], keyColumn: string, valueColumn: string): Record<string, number> => {
          const map: Record<string, number> = {}
          for (const row of rows) map[String(row[keyColumn])] = Number(row[valueColumn])
          return map
        }
        const pairs: [string, string, string][] = [
          ['public.processor_watermarks', 'processor', 'processed_through_sequence'],
          ['public.storyline_consumer_watermarks', 'consumer', 'last_consumed_revision'],
        ]
        for (const [table, keyColumn, valueColumn] of pairs) {
          const source = sourceReadings.get(table)!.rows
          const target = targetRowsOf(table)
          assert.ok(target !== undefined, `${table} 读不出来`)
          assert.ok(source.length > 0, `前置：${table} 是空的 ⇒ 判据没量到东西`)
          assert.deepEqual(
            watermarkOf(target!, keyColumn, valueColumn),
            watermarkOf(source, keyColumn, valueColumn),
            `${table} 的水位两侧不同`
          )
        }
        for (const table of ['public.character_sequence_counters', 'public.character_action_sequence_counters']) {
          const source = sourceReadings.get(table)!.rows
          const target = targetRowsOf(table)!
          assert.deepEqual(
            source.map((row) => Number(row.next_sequence)),
            target.map((row) => Number(row.next_sequence)),
            `${table} 的 next_sequence 两侧不同`
          )
        }
        observations.watermarks = {
          processorWatermarks: watermarkOf(sourceReadings.get('public.processor_watermarks')!.rows, 'processor', 'processed_through_sequence'),
          storylineWatermarks: watermarkOf(
            sourceReadings.get('public.storyline_consumer_watermarks')!.rows,
            'consumer',
            'last_consumed_revision'
          ),
          sequenceCounters: {
            character: sourceReadings.get('public.character_sequence_counters')!.rows.map((r) => r.next_sequence),
            action: sourceReadings.get('public.character_action_sequence_counters')!.rows.map((r) => r.next_sequence),
          },
        }
      })

      check('G05.7 ★ 插件历史七张表完整（agents / memories / rooms / participants / entities / worlds / embeddings）', () => {
        const pluginTables = [
          'public.agents',
          'public.memories',
          'public.rooms',
          'public.participants',
          'public.entities',
          'public.worlds',
          'public.embeddings',
        ]
        const problems: string[] = []
        for (const table of pluginTables) {
          const source = sourceReadings.get(table)
          const target = targetRowsOf(table)
          if (source === undefined) problems.push(`${table}: 源里没有这张表`)
          else if (target === undefined) problems.push(`${table}: 目标读不出来`)
          else if (target.length !== source.rows.length) {
            problems.push(`${table}: ${source.rows.length} → ${target.length} 行`)
          }
        }
        assert.deepEqual(problems, [], problems.join('；'))
        assert.ok(sourceReadings.get('public.agents')!.rows.length > 0, '前置：agents 是空的 ⇒ 判据没量到东西')
        observations.pluginHistory = pluginTables.map((table) => ({
          table,
          rows: sourceReadings.get(table)?.rows.length ?? null,
        }))
      })

      check('G05.9 ★ 迁移登记表 `character_schema_migrations` 与来源一致（18 行 · 版本集合相同）', () => {
        const key = 'public.character_schema_migrations'
        const source = sourceReadings.get(key)!.rows
        const target = targetRowsOf(key)!
        assert.equal(source.length, 18, `来源应为 18 行，实为 ${source.length}`)
        assert.equal(target.length, 18, `目标应为 18 行，实为 ${target.length}`)
        assert.deepEqual(
          target.map((row) => Number(row.version)).sort((a, b) => a - b),
          source.map((row) => Number(row.version)).sort((a, b) => a - b),
          '版本集合两侧不同'
        )
        assert.deepEqual(targetDigests.get(key)?.digest, sourceDigests.get(key)?.digest, '整表摘要不同')
        observations.migrationRegistry = {
          rows: source.length,
          versions: source.map((row) => Number(row.version)),
          latestName: source.find((row) => Number(row.version) === 18)?.name ?? null,
        }
      })

      // ---------------------------------------------------------------------
      // 6) 真数据负控（每条**只改一处**，且先证明改动生效）
      // ---------------------------------------------------------------------
      const controls: {
        id: string
        table: string
        what: string
        mutation: string
        probe: string
        expected: 'row_count_differs' | 'primary_key_set_differs' | 'content_digest_differs' | 'multiset_differs'
      }[] = [
        {
          id: 'G05.N1',
          table: 'public.character_jobs',
          what: '删一行',
          mutation:
            'delete from public.character_jobs where ctid = (select ctid from public.character_jobs order by ctid limit 1)',
          probe: 'select count(*) from public.character_jobs',
          expected: 'row_count_differs',
        },
        {
          id: 'G05.N2',
          table: 'public.memories',
          what: '改一个**主键**值（行数不变）',
          mutation:
            'update public.memories set id = gen_random_uuid() where ctid = (select ctid from public.memories order by ctid limit 1)',
          probe: "select md5(string_agg(id::text, ',' order by id::text)) from public.memories",
          expected: 'primary_key_set_differs',
        },
        {
          id: 'G05.N3',
          table: 'public.memory_records',
          what: '改一个**归因**字段（来源链的一部分）',
          mutation:
            "update public.memory_records set authority = authority || '-tampered' where ctid = (select ctid from public.memory_records order by ctid limit 1)",
          probe: "select md5(string_agg(authority, ',' order by authority)) from public.memory_records",
          expected: 'content_digest_differs',
        },
        {
          id: 'G05.N4',
          table: 'public.memory_semantic_index',
          what: '改一个**向量**（逐分量 +0.001，维度不变）',
          mutation:
            'update public.memory_semantic_index set embedding = embedding + ' +
            "(('[' || repeat('0.001,', (select dimension from public.memory_semantic_index limit 1) - 1) || '0.001]')::vector) " +
            'where embedding is not null and ctid = (select ctid from public.memory_semantic_index where embedding is not null order by ctid limit 1)',
          probe: "select md5(string_agg(embedding::text, ',' order by embedding::text)) from public.memory_semantic_index",
          expected: 'content_digest_differs',
        },
        {
          id: 'G05.N5',
          table: 'public.processor_watermarks',
          what: '**回退**一个消费者水位',
          mutation:
            'update public.processor_watermarks set processed_through_sequence = processed_through_sequence - 1 ' +
            'where ctid = (select ctid from public.processor_watermarks order by ctid limit 1)',
          probe: 'select sum(processed_through_sequence) from public.processor_watermarks',
          expected: 'content_digest_differs',
        },
        {
          id: 'G05.N6',
          table: 'public.logs',
          what: '无主键表改**一行内容**（总行数不变 ⇒ 只有多重集能抓到）',
          mutation:
            "update public.logs set type = type || '-tampered' where ctid = (select ctid from public.logs order by ctid limit 1)",
          probe: "select md5(string_agg(type, ',' order by type)) from public.logs",
          expected: 'multiset_differs',
        },
      ]

      for (const control of controls) {
        const before = scalar(control.probe)
        const rowsBefore = Number(scalar(`select count(*) from ${control.table}`))
        const mutation = mutate(control.mutation)
        const after = scalar(control.probe)
        const rowsAfter = Number(scalar(`select count(*) from ${control.table}`))
        const digest = readTarget(control.table)
        const sourceDigest = sourceDigests.get(control.table)!
        const result = digest === undefined ? undefined : compareTableDigests(sourceDigest, digest)
        observations[`control_${control.id}`] = {
          table: control.table,
          what: control.what,
          mutationRc: mutation.rc,
          probeBefore: before.slice(0, 40),
          probeAfter: after.slice(0, 40),
          rowsBefore,
          rowsAfter,
          reason: result?.reason ?? null,
          match: result?.match ?? null,
        }
        check(`${control.id}-负控 ${control.what} ⇒ ${control.expected}`, () => {
          assert.equal(mutation.rc, 0, `改动没执行成功：${mutation.err.slice(0, 300)}`)
          assert.notEqual(before, after, '前置：探针读数没有变化 ⇒ 这次改动**没生效**（假红陷阱）')
          assert.ok(result !== undefined, '目标侧读不回来')
          assert.equal(result!.match, false, '改了一处却判成"一致" ⇒ 比较器漏了这种差异')
          assert.equal(result!.reason, control.expected, `原因不是预期的那一个：${JSON.stringify(result!.reason)}`)
        })
        if (control.id === 'G05.N6') {
          check('G05.N6b-负控 该表**总行数没变**（所以原因只能是 multiset，不能是 row_count）', () => {
            assert.equal(rowsAfter, rowsBefore, `行数变了（${rowsBefore} → ${rowsAfter}）⇒ 这条负控量错了东西`)
          })
        }
      }

      // ---------------------------------------------------------------------
      // 7) 恢复：**重新恢复一次**，全部又一致
      // ---------------------------------------------------------------------
      const targetDropped = manageTestDb('drop-test-db.sql')
      const targetRecreated = manageTestDb('create-test-db.sql')
      const reRestore = psqlFromStdin({
        container: CONTAINER,
        user: MIGRATE_USER,
        password,
        database: TARGET_DB,
        sql: sourceDump.sql,
        timeoutMs: 900_000,
      })
      note({ command: reRestore.command, rc: reRestore.rc })

      const restoredComparisons: string[] = []
      for (const key of sourceKeys) {
        const digest = readTarget(key)
        if (digest === undefined) {
          restoredComparisons.push(`${key}:unreadable`)
          continue
        }
        const result = compareTableDigests(sourceDigests.get(key)!, digest)
        if (!result.match) restoredComparisons.push(`${key}:${result.reason ?? '?'}`)
      }
      observations.restoreSegment = {
        dropRc: targetDropped.rc,
        createRc: targetRecreated.rc,
        restoreRc: reRestore.rc,
        mismatched: restoredComparisons,
      }
      check('G05.R 恢复：重新从同一份导出恢复一次 ⇒ **全部 54 张表又一致**', () => {
        assert.equal(targetDropped.rc, 0, targetDropped.err)
        assert.equal(targetRecreated.rc, 0, targetRecreated.err)
        assert.equal(reRestore.rc, 0, reRestore.err.slice(0, 400))
        assert.ok(!/^ERROR/m.test(reRestore.err), `恢复日志里有 ERROR：${reRestore.err.slice(0, 400)}`)
        assert.deepEqual(restoredComparisons, [], `恢复后仍不一致：${restoredComparisons.join('；')}`)
      })

      const attestation = await session.close()
      observations.sourceAttestation = attestation
      check('G05.S 自证：整个会话前后**源目录逐字未动**，副本与源相同，关闭干净', () => {
        assert.equal(attestation.sourceUnchanged, true, '源目录在会话前后不同 ⇒ 我们动了不该动的东西')
        assert.equal(attestation.copyMatchesSource, true, '副本与源不一致')
        assert.equal(attestation.closedClean, true)
        assert.ok(attestation.files > 1_000, `源目录文件数异常（${attestation.files}）`)
      })
    } catch (error) {
      checks.push({
        name: 'G05.§2 意外中断',
        pass: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      })
    } finally {
      if (session !== undefined) {
        try {
          await session.close()
        } catch {
          /* 已经关过就算了；真正的问题由上面的断言报 */
        }
      }
      // ⚠️ 无论成败都要**把实例带回来**：测试库必须清掉，否则下一道门会撞名。
      const dropped = manageTestDb('drop-test-db.sql')
      check('G05.9z 本门自建的测试库已清理', () => {
        assert.equal(dropped.rc, 0, dropped.err)
      })
    }
  }

  // =========================================================================
  // 证据落盘
  // =========================================================================
  const passed = checks.filter((entry) => entry.pass).length
  const failed = checks.length - passed
  const evidence = {
    gate: 'PG-G05',
    runId: RUN_ID,
    startedAtUtc: new Date().toISOString(),
    startedAtUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    head: (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim(),
    container: CONTAINER,
    hostPort: HOST_PORT,
    sourceSnapshot: SOURCE_SNAPSHOT,
    restoreArgs: RESTORE_ARGS,
    checks,
    notRun,
    observations,
    counts: { measured: checks.length, passed, failed, notRun: notRun.length },
    commands,
  }
  writeFileSync(join(EVIDENCE_DIR, 'g05-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  // ⚠️ 写完立刻解一次：本仓库历史上出现过 3 份不可解析的"证据 JSON"。
  JSON.parse(readFileSync(join(EVIDENCE_DIR, 'g05-evidence.json'), 'utf8'))

  console.log('')
  console.log('PG-G05 迁移完整性（全库逐表内容比较）')
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
  const comparison = observations.tableComparison as { tables: number; matched: number; mismatched: string[] } | undefined
  console.log('  关键读数：')
  console.log(`    · 参与比较的表            : ${comparison?.tables ?? 'NOT RUN'}`)
  console.log(`    · 一致 / 不一致           : ${comparison?.matched ?? 'NOT RUN'} / ${comparison?.mismatched.length ?? 'NOT RUN'}`)
  console.log(`    · 源总行数                : ${String((observations.source as { rows?: number } | undefined)?.rows ?? 'NOT RUN')}`)
  console.log('')

  if (checks.length === 0) {
    console.error('measured_count = 0 ⇒ INVALID（不得当绿用）')
    process.exitCode = 1
  } else if (failed > 0) {
    process.exitCode = 1
  } else if (notRun.length > 0) {
    console.error(
      `\n${notRun.length} 项未运行 ⇒ 本门**不报 PASS**（关键断言缺证据 ⇒ 拒收）。\n` +
        '  这不是"通过"，也不是"失败"—— 它是"没量到"。'
    )
    process.exitCode = 1
  }
}

await main()
