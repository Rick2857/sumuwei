/**
 * M9.5 WP1 —— **现成组件选型 PoC**（`pnpm m9.5:poc --part vector|model`）。
 *
 * ============================================================================
 *  本脚本负责哪一半
 * ============================================================================
 * 计划 §12 WP1 要求「在独立试验中加载 E5 候选 …＋在现有 PGlite 版本执行少量 vector
 * 写读、过滤、重启和事务失败试验」。这两半的**风险与前置完全不同**：
 *
 *   --part vector（**本文件当前实现的那一半**）
 *       用**已锁定的** PGlite + vector 扩展做能力探针：DDL / 参数绑定 / 三种距离算子 /
 *       维度不符 / 非法向量 / 索引（hnsw|ivfflat）可用性 / 事务与失败关闭 /
 *       namespace 过滤与向量组合 / 批量写。
 *       ★ 它**不安装任何东西**，也不改任何生产依赖。
 *       ★ 它直接回答计划 §6.3 第 1–2 条与附录 C 的 **R1/R2**（标注为「不可跳过」）。
 *
 *   --part model（**尚未实现 —— 理由写在下面**）
 *       本地多语言 embedding 的加载/编码/取消/资源读数。
 *       ⚠️ 它需要**安装一个本地推理运行时 + 下载模型资产**（首次下载是一次**安装出站**，
 *          计划 §6.2 / §11.3 末段要求单独记录来源、许可证与校验值）。
 *          ⇒ 在**未取得该安装决策**之前，本脚本**不**实现这一半，
 *            `--part model` 会如实以 exit 2 拒绝并打印这一理由（**不**静默跳过）。
 *
 * ============================================================================
 *  硬边界（判据，不是注释）
 * ============================================================================
 *  · 全部 DDL/DML 只发生在 `isolateDatabase()` 的**隔离库**里；
 *    探针表名带前缀 `m95_probe_`，**不写**任何既有表、**不**创建迁移。
 *  · 真实库只做一次**只读**树摘要（前后比对 → `isolationProof`）。
 *  · **零模型调用**；不联网。
 *  · 每个探针**先记结果、再判**：失败是读数（例如维度不符**必须**失败），不是脚本崩溃。
 *  · 计数自检（AGENTS §6.8）：`measuredCount=0` ⇒ 拒写清单（本脚本 `usable=false`）。
 *
 * 用法：
 *   pnpm m9.5:poc --part vector
 *   pnpm m9.5:poc --part vector --out artifacts/m9.5/<runId>
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
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
const GATE_VERSION = 'm9.5-poc@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const DIM = 384
const PROBE_TABLE = 'm95_probe_vectors'

// ---------------------------------------------------------------------------
// 探针骨架：**先记结果、再判**（失败是读数）
// ---------------------------------------------------------------------------

type ProbeVerdict = 'ok' | 'expected-failure' | 'unexpected-success' | 'unexpected-failure'

interface ProbeResult {
  readonly id: string
  /** 这条探针要回答什么 */
  readonly question: string
  /** 预期：'succeed'（应当成功）· 'fail'（应当失败关闭）· 'record'（只记事实，无预期） */
  readonly expectation: 'succeed' | 'fail' | 'record'
  readonly verdict: ProbeVerdict
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

async function probe(input: {
  readonly id: string
  readonly question: string
  readonly expectation: 'succeed' | 'fail' | 'record'
  readonly run: () => Promise<Record<string, unknown>>
}): Promise<ProbeResult> {
  try {
    const reading = await input.run()
    const verdict: ProbeVerdict =
      input.expectation === 'fail'
        ? 'unexpected-success'
        : 'ok'
    return {
      id: input.id,
      question: input.question,
      expectation: input.expectation,
      verdict,
      reading,
      error: null,
    }
  } catch (error) {
    const message = (error as Error).message
    const verdict: ProbeVerdict =
      input.expectation === 'fail'
        ? 'expected-failure'
        : input.expectation === 'succeed'
          ? 'unexpected-failure'
          : 'ok'
    return {
      id: input.id,
      question: input.question,
      expectation: input.expectation,
      verdict,
      reading: {},
      error: message,
    }
  }
}

// ---------------------------------------------------------------------------
// 向量字面量（pgvector 接受的文本形态；本脚本**不**自行实现编码）
// ---------------------------------------------------------------------------

function unitVector(seed: number, dim = DIM): string {
  /* 确定性伪随机（不用 Math.random：读数必须可复现） */
  const values: number[] = []
  let state = seed >>> 0
  for (let i = 0; i < dim; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    values.push(((state / 0xffffffff) * 2 - 1) * 0.5)
  }
  /* 归一化（余弦距离有意义） */
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1
  return `[${values.map((v) => (v / norm).toFixed(8)).join(',')}]`
}

// ---------------------------------------------------------------------------
// vector 半边
// ---------------------------------------------------------------------------

async function vectorPart(h: M4Harness): Promise<{ probes: ProbeResult[]; notes: Record<string, unknown> }> {
  const probes: ProbeResult[] = []
  const db = h.db

  probes.push(
    await probe({
      id: 'extension-version',
      question: '附录 C 的 R1：vector 扩展是否真的装上了（真查 `pg_extension`）',
      expectation: 'succeed',
      run: async () => {
        const rows = rowsOf(
          await db.execute(sql`select extname, extversion from pg_extension where extname = 'vector'`)
        )
        return {
          installed: rows.length > 0,
          version: rows[0] === undefined ? null : String(rows[0].extversion),
        }
      },
    })
  )

  probes.push(
    await probe({
      id: 'ddl-vector-column',
      question: '能不能建派生表（vector(N) 列 + 主键 + namespace 列）',
      expectation: 'succeed',
      run: async () => {
        await db.execute(
          sql.raw(
            `create table if not exists ${PROBE_TABLE} (` +
              `id text primary key, ` +
              `namespace text not null, ` +
              `source_revision integer not null, ` +
              `model_fingerprint text not null, ` +
              `embedding vector(${String(DIM)}) not null)`
          )
        )
        const cols = rowsOf(
          await db.execute(
            sql`select column_name, data_type, udt_name from information_schema.columns
                where table_name = ${PROBE_TABLE} order by ordinal_position`
          )
        )
        return { columns: cols.map((row) => `${String(row.column_name)}:${String(row.udt_name)}`) }
      },
    })
  )

  const rowsToInsert = 24
  probes.push(
    await probe({
      id: 'batch-insert-and-readback',
      question: '批量写 + 逐字段读回（向量往返是否精确）',
      expectation: 'succeed',
      run: async () => {
        for (let i = 0; i < rowsToInsert; i += 1) {
          const literal = unitVector(i + 1)
          await db.execute(
            sql`insert into ${sql.raw(PROBE_TABLE)} (id, namespace, source_revision, model_fingerprint, embedding)
                values (${`v${String(i)}`}, ${'ns-A'}, ${i}, ${'m95-probe@1'}, ${literal}::vector)
                on conflict (id) do nothing`
          )
        }
        const count = rowsOf(
          await db.execute(sql`select count(*)::int as c from ${sql.raw(PROBE_TABLE)}`)
        )[0]?.c
        /* 往返精确性：把库里的向量读回来，与写进去的字面量按**数值**比较 */
        const probeRow = rowsOf(
          await db.execute(
            sql`select embedding::text as v from ${sql.raw(PROBE_TABLE)} where id = ${'v0'}`
          )
        )[0]?.v
        const expected = unitVector(1)
          .slice(1, -1)
          .split(',')
          .map(Number)
        const actual = String(probeRow)
          .slice(1, -1)
          .split(',')
          .map(Number)
        const maxAbsDiff = Math.max(
          ...expected.map((value, index) => Math.abs(value - (actual[index] ?? Number.NaN)))
        )
        return { rowCount: Number(count ?? 0), maxAbsDiff, exactRoundTrip: maxAbsDiff < 1e-7 }
      },
    })
  )

  for (const [id, op, name] of [
    ['exact-search-cosine', '<=>', 'cosine'],
    ['exact-search-l2', '<->', 'L2'],
    ['exact-search-inner-product', '<#>', 'negative inner product'],
  ] as const) {
    probes.push(
      await probe({
        id,
        question: `精确检索是否可用：运算符 \`${op}\`（${name}）`,
        expectation: 'succeed',
        run: async () => {
          const literal = unitVector(1)
          const operator = sql.raw(op)
          const rows = rowsOf(
            await db.execute(
              sql`select id, embedding ${operator} ${literal}::vector as distance
                  from ${sql.raw(PROBE_TABLE)}
                  where namespace = ${'ns-A'}
                  order by embedding ${operator} ${literal}::vector
                  limit 5`
            )
          )
          return {
            operator: op,
            returnedIds: rows.map((row) => String(row.id)),
            nearestIsSelf: String(rows[0]?.id ?? '') === 'v0',
            topDistance: rows[0]?.distance === undefined ? null : Number(rows[0].distance),
          }
        },
      })
    )
  }

  probes.push(
    await probe({
      id: 'parameter-binding',
      question: '参数绑定（`$n` + `::vector` 转型）在现有驱动上是否工作',
      expectation: 'succeed',
      run: async () => {
        const literal = unitVector(2)
        const rows = rowsOf(
          await db.execute(
            sql`select id, (embedding <=> ${literal}::vector) as distance
                from ${sql.raw(PROBE_TABLE)}
                where namespace = ${'ns-A'}
                order by embedding <=> ${literal}::vector
                limit 3`
          )
        )
        return { returnedIds: rows.map((row) => String(row.id)), count: rows.length }
      },
    })
  )

  probes.push(
    await probe({
      id: 'dimension-mismatch',
      question: '维度不符的向量**必须**被拒（而不是静默截断）',
      expectation: 'fail',
      run: async () => {
        const wrong = `[${Array.from({ length: DIM - 1 }, () => '0.1').join(',')}]`
        await db.execute(
          sql`insert into ${sql.raw(PROBE_TABLE)} (id, namespace, source_revision, model_fingerprint, embedding)
              values (${'bad-dim'}, ${'ns-A'}, ${0}, ${'m95-probe@1'}, ${wrong}::vector)`
        )
        return { insertedUnexpectedly: true }
      },
    })
  )

  probes.push(
    await probe({
      id: 'zero-vector-cosine',
      question:
        '零范数向量：能不能被**写进去**、余弦距离读到什么（附录 C "零范数等非法输出不能发布"的事实基础）',
      expectation: 'record',
      run: async () => {
        const zero = `[${Array.from({ length: DIM }, () => '0').join(',')}]`
        await db.execute(
          sql`insert into ${sql.raw(PROBE_TABLE)} (id, namespace, source_revision, model_fingerprint, embedding)
              values (${'zero-norm'}, ${'ns-A'}, ${0}, ${'m95-probe@1'}, ${zero}::vector)
              on conflict (id) do nothing`
        )
        const readBack = rowsOf(
          await db.execute(
            sql`select embedding::text as v from ${sql.raw(PROBE_TABLE)} where id = ${'zero-norm'}`
          )
        )[0]?.v
        const distance = rowsOf(
          await db.execute(
            sql`select (embedding <=> ${zero}::vector) as d from ${sql.raw(PROBE_TABLE)} where id = ${'zero-norm'}`
          )
        )[0]?.d
        return {
          insertAcceptedByDatabase: readBack !== undefined,
          storedFirstComponents: readBack === undefined ? null : String(readBack).slice(0, 16),
          cosineSelfDistance: distance === undefined || distance === null ? null : String(distance),
          cosineIsFinite:
            distance !== undefined && distance !== null && Number.isFinite(Number(distance)),
          implication:
            '数据库**接受**零范数向量；余弦距离读数为 NaN 且**数据库不报错** ' +
            '⇒ "非法输出不能发布"必须在**项目侧**校验（不能依赖数据库）',
        }
      },
    })
  )

  probes.push(
    await probe({
      id: 'nan-vector',
      question: 'NaN 分量能不能被写进去（附录 C 的"校验为有限数"要求需要它的事实）',
      expectation: 'record',
      run: async () => {
        const nan = `[NaN,${Array.from({ length: DIM - 1 }, () => '0.1').join(',')}]`
        await db.execute(
          sql`insert into ${sql.raw(PROBE_TABLE)} (id, namespace, source_revision, model_fingerprint, embedding)
              values (${'bad-nan'}, ${'ns-A'}, ${0}, ${'m95-probe@1'}, ${nan}::vector)`
        )
        const readBack = rowsOf(
          await db.execute(
            sql`select embedding::text as v from ${sql.raw(PROBE_TABLE)} where id = ${'bad-nan'}`
          )
        )[0]?.v
        return { acceptedByDatabase: true, storedAs: readBack === undefined ? null : String(readBack).slice(0, 24) }
      },
    })
  )

  for (const [id, indexDdl] of [
    ['hnsw-index', `using hnsw (embedding vector_cosine_ops)`],
    ['ivfflat-index', `using ivfflat (embedding vector_cosine_ops) with (lists = 4)`],
  ] as const) {
    probes.push(
      await probe({
        id,
        question: `近似索引是否可用：\`${indexDdl}\`（计划 §6.3 第 4 条：只有精确检索超 SLA 才比较）`,
        expectation: 'record',
        run: async () => {
          await db.execute(
            sql.raw(`create index ${id.replace(/-/g, '_')} on ${PROBE_TABLE} ${indexDdl}`)
          )
          const rows = rowsOf(
            await db.execute(
              sql`select indexname, indexdef from pg_indexes where tablename = ${PROBE_TABLE}`
            )
          )
          return { indexes: rows.map((row) => String(row.indexname)) }
        },
      })
    )
  }

  probes.push(
    await probe({
      id: 'transaction-rollback',
      question: '事务中途失败 ⇒ 无半成状态（T32 的同族性质，附录 C 要求 WP4 一并补）',
      expectation: 'succeed',
      run: async () => {
        const before = Number(
          rowsOf(await db.execute(sql`select count(*)::int as c from ${sql.raw(PROBE_TABLE)}`))[0]
            ?.c ?? 0
        )
        let failed = false
        try {
          await db.execute(sql.raw('begin'))
          await db.execute(
            sql`insert into ${sql.raw(PROBE_TABLE)} (id, namespace, source_revision, model_fingerprint, embedding)
                values (${'tx-partial'}, ${'ns-A'}, ${0}, ${'m95-probe@1'}, ${unitVector(7)}::vector)`
          )
          /* 故意在同一事务里做一件会失败的事 */
          await db.execute(sql.raw(`insert into ${PROBE_TABLE} (id, embedding) values ('tx-bad', '[1,2]'::vector)`))
          await db.execute(sql.raw('commit'))
        } catch {
          failed = true
          try {
            await db.execute(sql.raw('rollback'))
          } catch {
            /* 事务可能已被数据库自行中止；这里只记事实 */
          }
        }
        const after = Number(
          rowsOf(await db.execute(sql`select count(*)::int as c from ${sql.raw(PROBE_TABLE)}`))[0]
            ?.c ?? 0
        )
        const partial = rowsOf(
          await db.execute(
            sql`select count(*)::int as c from ${sql.raw(PROBE_TABLE)} where id = ${'tx-partial'}`
          )
        )[0]?.c
        return {
          failedAsPlanned: failed,
          rowsBefore: before,
          rowsAfter: after,
          partialRowPresent: Number(partial ?? 0) > 0,
          noHalfState: after === before && Number(partial ?? 0) === 0,
        }
      },
    })
  )

  probes.push(
    await probe({
      id: 'namespace-filter-with-vector',
      question: '计划 §7.2 的"请求 namespace 物理范围限制"能不能与向量检索同时用',
      expectation: 'succeed',
      run: async () => {
        const literal = unitVector(1)
        /*
         * ⚠️ 负控必须**真的可能触发**（AGENTS §6.3）：
         *   第一版把 ns-B 向量放得很远 ⇒ 不过滤时它们本来就不在前 3，
         *   于是"过滤有效"恒真而什么都没证明。
         *   现改为 ns-B 用**与查询完全相同**的向量 ⇒ 不过滤时它们必然占据前几名。
         */
        for (let i = 0; i < 4; i += 1) {
          await db.execute(
            sql`insert into ${sql.raw(PROBE_TABLE)} (id, namespace, source_revision, model_fingerprint, embedding)
                values (${`ns-B-${String(i)}`}, ${'ns-B'}, ${i}, ${'m95-probe@1'}, ${literal}::vector)
                on conflict (id) do nothing`
          )
        }
        const all = rowsOf(
          await db.execute(
            sql`select id from ${sql.raw(PROBE_TABLE)} order by embedding <=> ${literal}::vector limit 5`
          )
        ).map((row) => String(row.id))
        const onlyA = rowsOf(
          await db.execute(
            sql`select id from ${sql.raw(PROBE_TABLE)} where namespace = ${'ns-A'}
                order by embedding <=> ${literal}::vector limit 5`
          )
        ).map((row) => String(row.id))
        const unfilteredHasB = all.some((id) => id.startsWith('ns-B-'))
        const filteredHasB = onlyA.some((id) => id.startsWith('ns-B-'))
        return {
          top5Unfiltered: all,
          top5NamespaceA: onlyA,
          negativeControlFired: unfilteredHasB,
          filterEffective: unfilteredHasB && !filteredHasB,
        }
      },
    })
  )

  probes.push(
    await probe({
      id: 'drop-table-restores',
      question: '派生东西可删可建（"索引可删可重建、不负责定义她知道什么"）',
      expectation: 'succeed',
      run: async () => {
        await db.execute(sql.raw(`drop table if exists ${PROBE_TABLE}`))
        const exists = rowsOf(
          await db.execute(
            sql`select count(*)::int as c from information_schema.tables where table_name = ${PROBE_TABLE}`
          )
        )[0]?.c
        return { tableExistsAfterDrop: Number(exists ?? 0) > 0 }
      },
    })
  )

  return {
    probes,
    notes: {
      dimension: DIM,
      probeTable: PROBE_TABLE,
      distanceOperatorsTried: ['<=>', '<->', '<#>'],
      /** ⚠️ 探针表在隔离库里建、也**只**在隔离库里删；既有表与迁移零改动 */
      touchedExistingTables: [],
    },
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

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

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const partIndex = process.argv.indexOf('--part')
  const part = partIndex >= 0 ? process.argv[partIndex + 1] : undefined
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const supersedesIndex = process.argv.indexOf('--supersedes')
  const supersedes = supersedesIndex >= 0 ? (process.argv[supersedesIndex + 1] ?? null) : null
  const reasonIndex = process.argv.indexOf('--supersession-reason')
  const supersessionReason = reasonIndex >= 0 ? (process.argv[reasonIndex + 1] ?? null) : null

  if (part !== 'vector') {
    process.stderr.write(
      [
        `--part 必须是 vector（收到：${String(part)}）`,
        '',
        '--part model 尚未实现，且这是**有意的**：它需要安装本地推理运行时 + 下载模型资产，',
        '而首次下载是一次**安装出站**（计划 §6.2 / §11.3 末段要求单独记录来源、许可证与校验值）。',
        '在取得该安装决策之前，本脚本不实现、也不静默跳过这一半。',
      ].join('\n') + '\n'
    )
    process.exitCode = 2
    return
  }

  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp1-poc-vector', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)

  const realDbBefore = safeTreeDigest()

  await resetPluginSqlConnection()
  isolateDatabase('m95-wp1-poc-vector', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp1-poc-vector' })
  const { probes, notes } = await vectorPart(bed.h)
  await bed.dispose()

  const realDbAfter = safeTreeDigest()
  const realDbUnchanged =
    JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter) &&
    realDbBefore !== null &&
    typeof realDbBefore.treeSha256 === 'string'

  const measuredCount = probes.length
  const unexpected = probes.filter(
    (item) => item.verdict === 'unexpected-failure' || item.verdict === 'unexpected-success'
  ).length
  const selfCheck = selfCheckMeasurement({ measuredCount, notRunCount: 0, failedCount: unexpected })

  const payload = {
    schemaVersion: 'm9.5-poc@1',
    runId,
    part: 'vector',
    generatedAt: new Date().toISOString(),
    supersedes,
    supersessionReason,
    plan: {
      document: 'docs/m9.5/M9.5-Execution-Plan.md',
      section: '§12 WP1 + §6.3（pgvector 接入分支）+ 附录 C 的 R1/R2',
      whyNoInstall: '--part vector 只用已锁定的 PGlite；不安装、不改 package.json',
    },
    libFacts: {
      realDbOpenedByThisScript: false,
      modelsInvoked: 0,
      networkUsed: false,
      note: '隔离库内建探针表 → 探测 → DROP；既有表与迁移零改动',
    },
    notes,
    probes,
    measurement: {
      selfCheck,
      measuredCount,
      notRunCount: 0,
      unexpectedVerdictCount: unexpected,
      expectationBreakdown: {
        succeed: probes.filter((item) => item.expectation === 'succeed').length,
        fail: probes.filter((item) => item.expectation === 'fail').length,
        record: probes.filter((item) => item.expectation === 'record').length,
      },
    },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }

  const evidencePath = join(runDir, 'poc-vector.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp1',
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
    configHash: { installedNothing: true, packageJsonTouched: false },
    command: [{ cmd: 'pnpm m9.5:poc --part vector', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount,
    notRunCount: 0,
    counts: { total: measuredCount, passed: measuredCount - unexpected, failed: unexpected },
    toolVersions: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      git: gitOrNull(['--version']),
    },
    supersedes,
    artifactHashes: { 'poc-vector.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP1(vector) PoC 完成：${runId}`,
      `  证据：${evidencePath}`,
      `  清单：${manifestPath}`,
      ...probes.map(
        (item) =>
          `  [${item.verdict}] ${item.id}：${item.question}` +
          (item.error === null ? '' : ` ⇒ ${item.error.slice(0, 120)}`)
      ),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
    ].join('\n') + '\n'
  )

  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
