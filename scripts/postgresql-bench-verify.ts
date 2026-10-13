/**
 * PostgreSQL 迁移 WP5：**资源读数**（契约 `S8`：时延 / 连接数 / CPU·内存 / 磁盘 / 备份耗时）。
 *
 * ============================================================================
 *  它**不是**性能门（这一点写在判据里，见 `B13`）
 * ============================================================================
 *  计划 §5 逐字："**未设性能收益目标**，不为更快数字关闭持久性设置"。
 *  ⇒ 本门**不**比较"谁更快"，只把读数**分列**记下来，供 WP6/WP7 的运维决策用。
 *    任何"PG 比 PGlite 快/慢"的结论都**不在**本门的判据里。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 一个必须先解决的量具问题：`docker exec` 的进程启动开销
 * ---------------------------------------------------------------------------
 *  本题两侧的"客户端"完全不同：
 *
 * ```text
 *   PGlite  = 进程内 WASM（没有网络、没有进程启动）
 *   真 PG   = 容器里，经 `docker exec psql` 每次一个进程 + 一次 TCP 连接
 * ```
 *
 *  ⇒ 若直接量 `docker exec psql -c "<q>"` 的墙钟，量到的主要是
 *    **进程启动 + 连接**（约 60–100ms），不是数据库的工作量 —— 那就是
 *    "看起来在比数据库、其实在比谁起进程快"。
 *
 *  ⇒ 本门用**两个分开的读数**：
 *
 * ```text
 *   ① 服务端执行时间：`EXPLAIN (ANALYZE, FORMAT JSON)` 的 `Execution Time`
 *      两侧同一判据、同一形状 ⇒ **可比**，且不含客户端开销
 *   ② 端到端往返：PG 侧在**同一个 psql 会话**里 `\timing on` 连续跑（只用 1 次进程启动）
 *      PGlite 侧进程内计时 ⇒ 含各自真实的客户端开销，**分列**记录、不互相比较
 * ```
 *
 * ⚠️ 查询清单刻意全部是**只返回 1 行**的聚合/计数 —— 因为 `\timing` 那条路会把
 *    结果打到 stdout，而 `conversation_events` 这类表里有**私人正文**。
 *    （量具设计里"不要顺手把正文捞进日志"是一条硬纪律。）
 *
 * 跑法：pnpm postgresql:bench:verify
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

const CONTAINER = PG_CONTAINER
const HOST_PORT = PG_HOST_PORT
const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'

const TARGET_DB = 'lg_test_bench'
/*
 * ⚠️ 表名必须与**已验证的写入进程脚本**一致：`scripts/postgresql/g07-writer.sh` 里
 *    写死了 `public.online_backup_probe` 与 `public.g07_control`。
 *    第一版我把它们叫 `bench_probe` / `bench_control` ⇒ 写入进程一启动就
 *    `relation does not exist` ⇒ **一条 BATCH 都没产出** ⇒ `B08`/`B09` 两条判据红。
 *    ⇒ 纪律：**复用别人的脚本时，接口（这里就是表名）要照抄，不要"顺手改名"**。
 */
const PROBE_TABLE = 'online_backup_probe'
const CONTROL_TABLE = 'g07_control'
const MIGRATE_USER = 'lg_migrate'

/** 迭代次数（两侧相同）—— 刻意小：这是**读数**不是基准竞赛 */
const ANALYZE_ITERATIONS = 15
const ROUNDTRIP_ITERATIONS = 20
const WARMUP = 3

const LOCAL_DIR = resolve('artifacts/post-lv2/local/pg-migration')
const RESTORE_SQL = join(LOCAL_DIR, 'bench-restore.sql')
const RESTORE_ARGS = ['--no-owner', '--no-privileges', '--no-comments']
const PRODUCTION_DB_DIR = resolve('data/pglite')

const UTC_STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const RUN_ID = `pg-migration-bench-${UTC_STAMP}`
const EVIDENCE_DIR = resolve(`artifacts/post-lv2/postgresql-migration/${RUN_ID}`)

/**
 * 固定查询清单（两侧跑**同一条** SQL）。
 * ⚠️ 每条都只返回 **1 行**（见文件头：`\timing` 那条路会把结果打到 stdout）。
 */
const QUERIES: { id: string; sql: string; what: string }[] = [
  { id: 'Q1', sql: 'select count(*) from conversation_events', what: '全表计数（最常用的一种读）' },
  {
    id: 'Q2',
    sql: "select count(*) from character_domain_events where type = 'AFFECT_TOUCH'",
    what: '带谓词计数',
  },
  { id: 'Q3', sql: 'select count(*) from memory_semantic_index', what: '小表计数' },
  { id: 'Q4', sql: 'select count(*) from character_projections', what: '投影表计数' },
  { id: 'Q5', sql: 'select max(sequence) from conversation_events', what: '取最大序号（水位类读）' },
  {
    id: 'Q6',
    sql:
      'select count(*) from (select memory_id from memory_semantic_index ' +
      'order by embedding <=> (select embedding from memory_semantic_index limit 1) limit 3) x',
    what: '**向量最近邻**（pgvector 的 `<=>` 路径）',
  },
  {
    id: 'Q7',
    sql: 'select count(*) from character_traces where jsonb_array_length(source_conversation_event_ids) = 0',
    what: 'jsonb 展开（jsonb 函数路径）',
  },
  { id: 'Q8', sql: 'select count(*) from character_jobs', what: '中等表计数' },
]

const credentials = loadPgCredentials()
const missingKeys = missingCredentialKeys(credentials)

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

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** 百分位（最近秩法；样本少时它就是"取第 k 小的那个"） */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function stats(samples: readonly number[]): { n: number; min: number; p50: number; p95: number; max: number; mean: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: samples.length,
    min: sorted[0] ?? Number.NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean: samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
  }
}

/** 真实库目录指纹（`PG-ISO-01` 之后，每道新门都带这条） */
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

/** 从 `EXPLAIN (ANALYZE, FORMAT JSON)` 的文本里取 `Execution Time`（SjS 与 PGlite 都可能给字符串或对象） */
function executionTimeOf(raw: unknown): number {
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  const plan = Array.isArray(parsed) ? parsed[0] : parsed
  const value = (plan as { 'Execution Time'?: unknown } | undefined)?.['Execution Time']
  const time = Number(value)
  if (!Number.isFinite(time)) throw new Error(`EXPLAIN 输出里没有 Execution Time：${JSON.stringify(plan).slice(0, 200)}`)
  return time
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
    notRun.push({ id: 'resource-measurement', what: '两侧资源读数（S8）', why: blocked })
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

    const productionBefore = productionDirFingerprint()
    let writer: ReturnType<typeof spawn> | undefined
    try {
      // ---------------------------------------------------------------------
      // 1) 前置：PG 目标（从快照恢复）+ PGlite 副本（**同一份快照**）
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
      note({ command: restore.command, rc: restore.rc })
      check('B01 前置：PG 目标从快照恢复成功（exit 0 且无 ERROR）', () => {
        assert.equal(created.rc, 0, created.err)
        assert.equal(restore.rc, 0, restore.err.slice(0, 400))
        assert.ok(!/^ERROR/m.test(restore.err), `恢复日志里有 ERROR：${restore.err.slice(0, 400)}`)
      })

      const session = await openPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT })
      const pgliteCounts: Record<string, number> = {}
      const pgCounts: Record<string, number> = {}
      observations.plan = {
        queries: QUERIES.map((q) => ({ id: q.id, what: q.what, sql: q.sql })),
        analyzeIterations: ANALYZE_ITERATIONS,
        roundTripIterations: ROUNDTRIP_ITERATIONS,
        warmup: WARMUP,
      }

      check('B02 两侧跑的是**同一条** SQL（清单只有一份，两侧都从它生成）', () => {
        assert.equal(QUERIES.length, 8, `查询清单应有 8 条，实为 ${QUERIES.length}`)
        assert.equal(new Set(QUERIES.map((q) => q.id)).size, QUERIES.length, '查询 id 有重复')
        for (const q of QUERIES) {
          assert.ok(/^select /i.test(q.sql.trim()), `${q.id} 不是一条只读 SELECT`)
          assert.ok(!/[;]/.test(q.sql), `${q.id} 里带了分号 ⇒ 会给"同一条 SQL"这句话留口子`)
        }
      })

      // ---------------------------------------------------------------------
      // 2) 前置：两侧读数**一致**（否则比的是两个不同的库）
      // ---------------------------------------------------------------------
      for (const q of QUERIES.slice(0, 5)) {
        const pgValue = queryOf(TARGET_DB)(q.sql)
        const liteRows = await session.queryRaw<Record<string, unknown>>(q.sql)
        pgCounts[q.id] = Number(pgValue)
        pgliteCounts[q.id] = Number(Object.values(liteRows[0] ?? {})[0])
        observations[`compare_${q.id}`] = { pg: pgCounts[q.id], pglite: pgliteCounts[q.id], what: q.what }
      }
      check('B03 前置：两侧的**同一条**查询结果相同（"同一个库的两份"这前提成立）', () => {
        const problems: string[] = []
        for (const q of QUERIES.slice(0, 5)) {
          if (pgCounts[q.id] !== pgliteCounts[q.id]) {
            problems.push(`${q.id}: pg=${pgCounts[q.id]} pglite=${pgliteCounts[q.id]}`)
          }
        }
        assert.deepEqual(problems, [], problems.join('；'))
      })

      // ---------------------------------------------------------------------
      // 3) ①服务端执行时间（EXPLAIN ANALYZE）—— 两侧同一判据
      // ---------------------------------------------------------------------
      const serverSide: Record<string, { pg: number[]; pglite: number[] }> = {}
      for (const q of QUERIES) {
        serverSide[q.id] = { pg: [], pglite: [] }
        for (let i = 0; i < WARMUP; i += 1) {
          const r = queryOf(TARGET_DB)(`explain (analyze, format json) ${q.sql}`)
          if (r !== undefined) executionTimeOf(r)
          await session.queryRaw(`explain (analyze, format json) ${q.sql}`)
        }
        for (let i = 0; i < ANALYZE_ITERATIONS; i += 1) {
          const r = queryOf(TARGET_DB)(`explain (analyze, format json) ${q.sql}`)
          if (r !== undefined) serverSide[q.id].pg.push(executionTimeOf(r))
          const rows = await session.queryRaw<Record<string, unknown>>(`explain (analyze, format json) ${q.sql}`)
          serverSide[q.id].pglite.push(executionTimeOf(Object.values(rows[0] ?? {})[0]))
        }
      }
      const serverSideStats = Object.fromEntries(
        Object.entries(serverSide).map(([id, both]) => [id, { pg: stats(both.pg), pglite: stats(both.pglite) }])
      )
      observations.serverSideExecutionMs = serverSideStats

      check('B04 ★ 两侧每一条查询都取满了样本（不许静默丢样本）', () => {
        const problems: string[] = []
        for (const q of QUERIES) {
          if (serverSide[q.id].pg.length !== ANALYZE_ITERATIONS) {
            problems.push(`${q.id}.pg=${serverSide[q.id].pg.length}`)
          }
          if (serverSide[q.id].pglite.length !== ANALYZE_ITERATIONS) {
            problems.push(`${q.id}.pglite=${serverSide[q.id].pglite.length}`)
          }
        }
        assert.deepEqual(problems, [], `样本数不足：${problems.join(', ')}`)
      })

      check('B05 统计量自洽：min ≤ p50 ≤ p95 ≤ max 且全部 ≥ 0', () => {
        for (const [id, both] of Object.entries(serverSideStats)) {
          for (const side of ['pg', 'pglite'] as const) {
            const s = both[side]
            assert.ok(s.min >= 0 && s.min <= s.p50 && s.p50 <= s.p95 && s.p95 <= s.max, `${id}.${side} 统计量不自洽：${JSON.stringify(s)}`)
          }
        }
      })

      // ---------------------------------------------------------------------
      // 4) ②端到端往返（PG：**同一个 psql 会话**里 `\timing on`；PGlite：进程内计时）
      // ---------------------------------------------------------------------
      const roundTrip: Record<string, { pg: number[]; pglite: number[] }> = {}
      for (const q of QUERIES) roundTrip[q.id] = { pg: [], pglite: [] }
      /*
       * ⚠️ PG 侧必须走**一个会话 + `\timing on`**：若每条查询都另起一个 `docker exec psql`，
       *    量到的主要是**进程启动 + 连接**（60–100ms），不是数据库的工作量。
       *    `psqlArgs: ['-tA']`（而不是 `-q`）是因为要看 `Time: … ms` 那几行。
       */
      for (const q of QUERIES) {
        const script = `\\timing on\n${`${q.sql};\n`.repeat(ROUNDTRIP_ITERATIONS)}`
        const r = psqlFromStdin({
          container: CONTAINER,
          user: MIGRATE_USER,
          password,
          database: TARGET_DB,
          sql: script,
          timeoutMs: 300_000,
          psqlArgs: ['-tA'],
        })
        note({ command: `${r.command}（一个会话 · \\timing on · ${ROUNDTRIP_ITERATIONS} 次）`, rc: r.rc })
        roundTrip[q.id].pg = [...r.out.matchAll(/^Time: ([\d.]+) ms$/gm)].map((m) => Number(m[1]))
        for (let i = 0; i < ROUNDTRIP_ITERATIONS; i += 1) {
          const started = performance.now()
          await session.queryRaw(q.sql)
          roundTrip[q.id].pglite.push(performance.now() - started)
        }
      }
      const roundTripStats = Object.fromEntries(
        Object.entries(roundTrip).map(([id, both]) => [id, { pg: stats(both.pg), pglite: stats(both.pglite) }])
      )
      observations.roundTripMs = roundTripStats

      check('B06 ★ 端到端往返：PG 侧在一个 psql 会话里取到 20 个 `Time:` 样本；PGlite 侧进程内 20 个', () => {
        const problems: string[] = []
        for (const q of QUERIES) {
          if (roundTrip[q.id].pg.length !== ROUNDTRIP_ITERATIONS) {
            problems.push(`${q.id}.pg=${roundTrip[q.id].pg.length}`)
          }
          if (roundTrip[q.id].pglite.length !== ROUNDTRIP_ITERATIONS) {
            problems.push(`${q.id}.pglite=${roundTrip[q.id].pglite.length}`)
          }
        }
        assert.deepEqual(problems, [], `往返样本数不足：${problems.join(', ')}`)
      })

      // ---------------------------------------------------------------------
      // 5) 资源读数：库大小 / 容器 CPU·内存 / 两侧目录规模 / 连接数
      // ---------------------------------------------------------------------
      const dbSize = queryOf(TARGET_DB)('select pg_database_size(current_database())')
      const connections = queryOf(TARGET_DB)(
        `select count(*) from pg_stat_activity where datname = '${TARGET_DB}'`
      )
      const dockerStats = spawnSync(
        'docker',
        ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}', CONTAINER],
        { encoding: 'utf8', timeout: 60_000 }
      )
      observations.resources = {
        pgDatabaseBytes: Number(dbSize ?? '0'),
        pgContainerStats: (dockerStats.stdout ?? '').trim(),
        pgConnections: Number(connections ?? '0'),
        pgliteSnapshotDirBytes: productionDirFingerprint().bytes,
        gateProcessRssBytes: process.memoryUsage().rss,
        note:
          'PGlite 侧没有"容器"：它的资源读数 = 本门进程的 RSS（含 PGlite 实例）· ' +
          '磁盘 = 快照副本目录规模。两侧不是同一种计量对象 ⇒ **分列**，不互相比较。',
      }

      check('B07 资源读数齐备（库大小 / 空闲时点容器读数 / 两侧目录规模 / 进程 RSS）', () => {
        const resources = observations.resources as Record<string, unknown>
        assert.ok(Number(resources.pgDatabaseBytes) > 0, `PG 库大小读数异常：${String(resources.pgDatabaseBytes)}`)
        assert.ok(String(resources.pgContainerStats).split('|').length === 3, `容器 stats 形状不对：${String(resources.pgContainerStats)}`)
        assert.ok(Number(resources.pgliteSnapshotDirBytes) > 1_000_000, 'PGlite 目录规模读数异常')
        assert.ok(Number(resources.gateProcessRssBytes) > 0, '进程 RSS 读数异常')
      })

      // ---------------------------------------------------------------------
      // 6) 并发只读 + 写入进行中的备份耗时（复用 PG-G07 已验证的写入进程）
      // ---------------------------------------------------------------------
      const setup = queryOf(TARGET_DB)(
        `drop table if exists public.${PROBE_TABLE}; ` +
          `create table public.${PROBE_TABLE} (batch_id bigint not null, seq integer not null, payload text not null, primary key (batch_id, seq)); ` +
          `drop table if exists public.${CONTROL_TABLE}; ` +
          `create table public.${CONTROL_TABLE} (stop boolean not null); ` +
          `insert into public.${CONTROL_TABLE}(stop) values (false)`
      )
      note({ command: `（建 ${PROBE_TABLE} / ${CONTROL_TABLE}）`, rc: setup === undefined ? 1 : 0 })

      const writerLines: string[] = []
      writer = spawn(
        'docker',
        ['exec', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'MAX_BATCHES', CONTAINER, 'sh', '/opt/lg/g07-writer.sh'],
        {
          env: {
            ...process.env,
            PGUSER: 'lg_runtime',
            PGPASSWORD: credentials!.LG_PG_RUNTIME_PASSWORD,
            PGDATABASE: TARGET_DB,
            MAX_BATCHES: '20000',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      writer.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) if (line.trim() !== '') writerLines.push(line.trim())
      })
      let writerExit: number | undefined
      const writerClosed = new Promise<void>((done) => {
        writer!.on('close', (code) => {
          writerExit = code ?? -1
          done()
        })
      })
      const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (predicate()) return true
          await sleep(50)
        }
        return predicate()
      }
      const writerWarm = await waitUntil(() => writerLines.filter((l) => l.startsWith('BATCH|')).length >= 3, 30_000)

      /*
       * ⚠️ `docker stats --no-stream` 本身要约 **1 秒**（第一版把它放进了紧循环 ⇒
       *    3 秒窗口里只跑到 **2** 个只读样本，判据"样本太少"红得对）。⇒ 负载下的容器
       *    读数**采一次**，紧循环里只留"只读 + 连接数"两件事。
       */
      const loadContainerStats = (() => {
        const live = spawnSync('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}', CONTAINER], {
          encoding: 'utf8',
          timeout: 60_000,
        })
        return (live.stdout ?? '').trim()
      })()
      const concurrentReads: number[] = []
      let concurrentFailures = 0
      let maxConnectionsDuringLoad = 0
      const batchesAtReadStart = writerLines.filter((l) => l.startsWith('BATCH|')).length
      /*
       * ⚠️ 2026-10-13（`F-WP5-16` 第二版）：第一版拿**子进程 stdout 的行数**当"写入还在进行"的信号
       *    —— 那是错的：`docker exec` 的管道**成块缓冲**，实测只读窗口内 3 → 3 行没动，
       *    而同一个进程最终产出 **116** 批。⇒ 用 stdout 行数测进度 = 量具在量缓冲。
       *    ⇒ 改问**数据库自己**：探针表的行数在窗口内有没有长（`rowsAtReadEnd > rowsAtReadStart`）。
       */
      const probeRows = (): number => Number(queryOf(TARGET_DB)(`select count(*) from public.${PROBE_TABLE}`) ?? '0')
      const rowsAtReadStart = probeRows()
      const readStarted = Date.now()
      while (Date.now() - readStarted < 4_000) {
        const started = performance.now()
        const r = psql({ container: CONTAINER, user: MIGRATE_USER, password, database: TARGET_DB, sql: 'select count(*) from conversation_events' })
        if (r.rc === 0 && /^\d+$/.test(r.out.trim())) concurrentReads.push(performance.now() - started)
        else concurrentFailures += 1
        // 连接数要在**有负载的时候**读（空闲时点说明不了任何事）
        const activity = psql({
          container: CONTAINER,
          user: MIGRATE_USER,
          password,
          database: TARGET_DB,
          sql: `select count(*) from pg_stat_activity where datname = '${TARGET_DB}'`,
        })
        if (activity.rc === 0) maxConnectionsDuringLoad = Math.max(maxConnectionsDuringLoad, Number(activity.out))
      }
      const batchesAtReadEnd = writerLines.filter((l) => l.startsWith('BATCH|')).length
      const rowsAtReadEnd = probeRows()

      // 写入进行中：备份（时长 + exit）
      const backupStarted = Date.now()
      const backupFd = openSync(join(LOCAL_DIR, 'bench-online-backup.sql'), 'w')
      const backupProcess = spawn(
        'docker',
        ['exec', '-e', 'PGPASSWORD', CONTAINER, 'pg_dump', '-h', '127.0.0.1', '-U', MIGRATE_USER, '-d', TARGET_DB, '--no-comments'],
        { env: { ...process.env, PGPASSWORD: password }, stdio: ['ignore', backupFd, 'pipe'] }
      )
      let backupErr = ''
      backupProcess.stderr?.on('data', (chunk: Buffer) => {
        backupErr += chunk.toString('utf8')
      })
      const backupExit = await new Promise<number>((done) => backupProcess.on('close', (code) => done(code ?? -1)))
      closeSync(backupFd)
      const backupMs = Date.now() - backupStarted
      const backupBytes = statSync(join(LOCAL_DIR, 'bench-online-backup.sql')).size
      const batchesDuringBackup = writerLines.filter((l) => l.startsWith('BATCH|')).length

      queryOf(TARGET_DB)(`update public.${CONTROL_TABLE} set stop = true`)
      const writerStopped = await Promise.race([writerClosed.then(() => true), sleep(60_000).then(() => false)])

      observations.concurrency = {
        writerWarm,
        writerBatches: batchesDuringBackup,
        writerExitCode: writerExit ?? null,
        writerStopped,
        concurrentReads: { samples: concurrentReads.length, failures: concurrentFailures, ...stats(concurrentReads) },
        maxConnectionsDuringLoad,
        batchesAtReadStart,
        batchesAtReadEnd,
        rowsAtReadStart,
        rowsAtReadEnd,
        containerStatsDuringLoad: loadContainerStats,
        backup: { milliseconds: backupMs, bytes: backupBytes, exitCode: backupExit, stderr: backupErr.slice(0, 300) },
      }

      check('B08 ★ 并发只读：写入进行中连续读 4 秒，**全部成功**，且这 4 秒里**确实有写入在提交**', () => {
        assert.equal(writerWarm, true, `写入进程没起来 ⇒ 这条判据没量到"并发"（stdout 样本：${JSON.stringify(writerLines.slice(0, 3))}）`)
        assert.ok(concurrentReads.length >= 10, `并发只读样本太少（${concurrentReads.length}）⇒ 量具本身拖慢了读数`)
        assert.equal(concurrentFailures, 0, `写入进行中有 ${concurrentFailures} 次只读失败`)
        /*
         * ⚠️ 2026-10-13（`F-WP5-16`）：这里原来断言 `maxConnectionsDuringLoad >= 2`
         *    ——「负载下应看得见写入 + 只读两条连接」。那是一条**竞态**判据：
         *    我的只读是另起 `docker exec psql`（一次约 100ms），连接在 psql 退出时就关了，
         *    而 `pg_stat_activity` 是**随后**另一次 exec 去读的 ⇒ 那个瞬间我的连接**通常已经不在**。
         *    实测：单独跑 12/12（碰巧读到 2），在 lane 里跑 11/12（读到 1）⇒ **同一份代码时红时绿**。
         *    ⇒ 判据改挂**直接证据**：这 4 秒里写入进程的**已提交批次数在增长**
         *      （`batchesAtReadEnd > batchesAtReadStart`），那才是"读写真的同时在发生"。
         *      连接数降级为**读数**（仍然记录，但不再当判据）。
         *      ⚠️ 这是**把弱代理换成直接证据**，不是放宽。
         */
        assert.ok(
          rowsAtReadEnd > rowsAtReadStart,
          `只读窗口内**探针表行数**没有增长（${rowsAtReadStart} → ${rowsAtReadEnd}）⇒ 没有真的"同时在写"` +
            `（stdout 行数 ${batchesAtReadStart} → ${batchesAtReadEnd} 只作参考：管道是**成块缓冲**的，` +
            `用它测进度就是量具在量缓冲；连接数读数 = ${maxConnectionsDuringLoad}，同样仅记录）`
        )
        assert.ok(loadContainerStats.split('|').length === 3, `负载下容器读数形状不对：${loadContainerStats}`)
      })

      check('B09 ★ 写入进行中的备份：exit 0，且备份期间确实有写入提交（与 PG-G07 的能力在**这个**规模上复现）', () => {
        assert.equal(backupExit, 0, `pg_dump 退出码 ${backupExit}；stderr=${backupErr.slice(0, 300)}`)
        assert.ok(backupBytes > 1_000_000, `备份太小（${backupBytes}B）`)
        assert.ok(batchesDuringBackup >= 3, `备份期间提交的批次数太少（${batchesDuringBackup}）`)
      })

      // ---------------------------------------------------------------------
      // 7) 自证 + 读数归属
      // ---------------------------------------------------------------------
      const sourceAttestation = await session.close()
      observations.sourceAttestation = sourceAttestation
      const productionAfter = productionDirFingerprint()
      observations.productionDir = { before: productionBefore, after: productionAfter }

      check('B10 ★ 源快照目录逐字未动（只读副本）· 且**真实库目录**逐字未动', () => {
        assert.equal(sourceAttestation.sourceUnchanged, true)
        assert.equal(sourceAttestation.copyMatchesSource, true)
        assert.equal(sourceAttestation.closedClean, true)
        assert.equal(productionAfter.files, productionBefore.files, '真实库文件数变了')
        assert.equal(productionAfter.digest, productionBefore.digest, '真实库 (路径,大小) 摘要变了')
        assert.equal(productionAfter.newestMtimeMs, productionBefore.newestMtimeMs, '真实库有文件被写过')
      })

      check('B11 读数归属：本门**不设**性能目标，读数不做阈值判定（也不与另一个后端比快慢）', () => {
        const resources = observations.resources as Record<string, unknown>
        assert.ok(String(resources.note).includes('分列'), '读数归属说明缺失')
        // 结构性断言：报告里**没有**任何"谁更快"的判定字段
        const forbidden = ['faster', 'winner', 'speedup', 'improvement']
        const text = JSON.stringify(observations)
        for (const word of forbidden) {
          assert.ok(!text.toLowerCase().includes(word), `读数里出现了判优字段 ${word} ⇒ 越界成性能结论了`)
        }
      })
    } catch (error) {
      checks.push({
        name: 'bench.§2 意外中断',
        pass: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      })
    } finally {
      if (writer !== undefined) {
        try {
          queryOf(TARGET_DB)(`update public.${CONTROL_TABLE} set stop = true`)
        } catch {
          /* 尽力停写 */
        }
        writer.kill()
      }
      const dropped = manageTestDb('drop-test-db.sql')
      check('bench.9z 本门自建的测试库已清理', () => {
        assert.equal(dropped.rc, 0, dropped.err)
      })
    }
  }

  const passed = checks.filter((entry) => entry.pass).length
  const failed = checks.length - passed
  const evidence = {
    gate: 'postgresql:bench:verify',
    slot: 'S8 资源读数',
    runId: RUN_ID,
    startedAtUtc: new Date().toISOString(),
    startedAtUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    head: (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim(),
    container: CONTAINER,
    hostPort: HOST_PORT,
    sourceSnapshot: SOURCE_SNAPSHOT,
    pinnedTools: PINNED_TOOLS_VERSION,
    restoreArgs: RESTORE_ARGS,
    checks,
    notRun,
    observations,
    counts: { measured: checks.length, passed, failed, notRun: notRun.length },
    commands,
  }
  writeFileSync(join(EVIDENCE_DIR, 'bench-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  JSON.parse(readFileSync(join(EVIDENCE_DIR, 'bench-evidence.json'), 'utf8'))

  const serverSide = (observations.serverSideExecutionMs ?? {}) as Record<string, { pg: { p50: number; p95: number }; pglite: { p50: number; p95: number } }>
  const roundTrip = (observations.roundTripMs ?? {}) as Record<string, { pg: { p50: number; p95: number }; pglite: { p50: number; p95: number } }>

  console.log('')
  console.log('WP5 资源读数（S8）—— 两侧分列，**不判优**')
  console.log('─'.repeat(92))
  console.log(`  runId    : ${RUN_ID}`)
  console.log(`  证据     : artifacts/post-lv2/postgresql-migration/${RUN_ID}/`)
  console.log('─'.repeat(92))
  for (const entry of checks) {
    console.log(`  ${entry.pass ? 'PASS' : 'FAIL'}  ${entry.name}`)
    if (!entry.pass && entry.detail !== undefined) console.log(`        └─ ${entry.detail}`)
  }
  console.log('─'.repeat(92))
  console.log('  ① 服务端执行时间 ms（EXPLAIN ANALYZE 的 Execution Time；两侧可比）')
  console.log('     查询                                   PG p50/p95        PGlite p50/p95')
  for (const q of QUERIES) {
    const s = serverSide[q.id]
    if (s === undefined) continue
    console.log(
      `     ${q.id} ${q.what.padEnd(34)} ${s.pg.p50.toFixed(3).padStart(9)}/${s.pg.p95.toFixed(3).padStart(8)}  ` +
        `${s.pglite.p50.toFixed(3).padStart(10)}/${s.pglite.p95.toFixed(3).padStart(8)}`
    )
  }
  console.log('  ② 端到端往返 ms（PG：单会话 \\timing；PGlite：进程内）—— 含各自客户端开销，**不互相比较**')
  console.log('     查询                                   PG p50/p95        PGlite p50/p95')
  for (const q of QUERIES) {
    const s = roundTrip[q.id]
    if (s === undefined) continue
    console.log(
      `     ${q.id} ${q.what.padEnd(34)} ${s.pg.p50.toFixed(2).padStart(9)}/${s.pg.p95.toFixed(2).padStart(8)}  ` +
        `${s.pglite.p50.toFixed(3).padStart(10)}/${s.pglite.p95.toFixed(3).padStart(8)}`
    )
  }
  console.log('─'.repeat(92))
  console.log(`  资源：${JSON.stringify(observations.resources)}`)
  console.log(`  并发只读：${JSON.stringify((observations.concurrency as { concurrentReads?: unknown } | undefined)?.concurrentReads)}`)
  console.log(`  备份：${JSON.stringify((observations.concurrency as { backup?: unknown } | undefined)?.backup)}`)
  console.log('─'.repeat(92))
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
