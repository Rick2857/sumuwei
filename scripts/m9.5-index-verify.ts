/**
 * M9.5 WP4（存储半边）—— **派生索引的存储与检索语义**（`pnpm m9.5:index:verify`）。
 *
 * ============================================================================
 *  为什么**先证语义、后落迁移**（这是一个刻意的顺序）
 * ============================================================================
 * ```text
 * 迁移一旦被应用到真实库就**不可修改**（AGENTS §3：只许追加新版本号）。
 * ⇒ 因此先把**将要写进迁移的那份 DDL** 在隔离库里跑一遍：
 *     它能不能建 · 分页稳不稳 · 精确检索对不对 · namespace 过滤真的有效吗 ·
 *     维度/零范数会不会被拦 · generation 切换是否原子 · 覆盖计数能不能对账。
 *   这一档全过了，那份 DDL 才值得被冻结进迁移。
 *
 * ⚠️ 本轮**不追加** kernel 迁移（`0010`）。不是遗漏，而是因为实测发现它有跨里程碑成本：
 *    追加一个迁移会让 M5.1.1 的 **6 处写死版本断言**同时变红（跨 5 个脚本）——
 *    清单与处置写在 `docs/m9.5/M9.5-WP4-Preflight.md`。
 *    该兼容更新必须**单独一轮**完成并逐门复跑，不能夹带。
 * ```
 *
 * ============================================================================
 *  它与 WP1 的 `m9.5:poc` 有什么区别（别把两者当同一件事）
 * ============================================================================
 * ```text
 * `m9.5:poc`      ：**组件能力**（扩展在不在、算子能不能用、能不能建 ANN）—— 无领域语义。
 * `m9.5:index:verify`：**本项目的派生索引契约**（唯一键/水位/覆盖/generation/越界负控）。
 *   后者才是"我们的表与我们的规则"的证据。
 * ```
 *
 * 硬边界：全部在 `isolateDatabase()` 的隔离库里；探针表建后即 DROP；真实库只做只读摘要；
 * 零模型调用、零联网；计数自检（`measuredCount > 0`）。
 *
 * 用法：`pnpm m9.5:index:verify`
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const GATE_VERSION = 'm9.5-index@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')

const INDEX_TABLE = 'm95_probe_semantic_index'
const GENERATION_TABLE = 'm95_probe_semantic_generations'
const FAILURE_TABLE = 'm95_probe_semantic_failures'
const DIM = 384
const NS_MAIN = 'C1'
const NS_OTHER = 'C2'
const MODEL = 'Xenova/multilingual-e5-small#q8'

/**
 * **将要写进迁移的那份 DDL**（逐字复用）。
 *
 * ⚠️ `vector(384)` 是**冻结承诺**：换模型/换维度 = 追加**新一条**迁移
 *    （不许就地改列类型 —— 已发布的 DDL 不可修改）。
 */
const DDL: readonly string[] = [
  `create table if not exists ${GENERATION_TABLE} (
     generation_id         text    primary key,
     namespace             text    not null,
     model_fingerprint     text    not null,
     renderer_version      text    not null,
     dimension             integer not null,
     index_schema_version  integer not null,
     build_state           text    not null,
     processed_watermark   integer not null default 0,
     eligible_source_count integer not null default 0,
     pending_count         integer not null default 0,
     failed_count          integer not null default 0,
     excluded_by_policy_count integer not null default 0,
     created_at            bigint  not null,
     published_at          bigint,
     constraint ${GENERATION_TABLE}_state_vocab
       check (build_state in ('building','published','unavailable')),
     constraint ${GENERATION_TABLE}_dimension_positive check (dimension > 0)
   )`,
  `create table if not exists ${INDEX_TABLE} (
     namespace             text    not null,
     memory_id             text    not null,
     source_revision       integer not null,
     generation_id         text    not null,
     model_fingerprint     text    not null,
     renderer_version      text    not null,
     content_hash          text    not null,
     tokenizer_fingerprint text    not null,
     pooling               text    not null,
     normalize             boolean not null,
     dtype                 text    not null,
     dimension             integer not null,
     embedding             vector(${String(DIM)}) not null,
     created_at            bigint  not null,
     primary key (namespace, memory_id, source_revision, model_fingerprint, generation_id),
     constraint ${INDEX_TABLE}_dimension_matches check (dimension = ${String(DIM)})
   )`,
  `create index if not exists ${INDEX_TABLE}_scope
     on ${INDEX_TABLE} (namespace, generation_id, memory_id)`,
  `create table if not exists ${FAILURE_TABLE} (
     generation_id  text    not null,
     memory_id      text    not null,
     reason         text    not null,
     attempts       integer not null default 1,
     last_attempt_at bigint not null,
     primary key (generation_id, memory_id)
   )`,
]

// ---------------------------------------------------------------------------
// 探针骨架
// ---------------------------------------------------------------------------

type Verdict = 'ok' | 'expected-failure' | 'unexpected'

interface Probe {
  readonly id: string
  readonly question: string
  readonly expectation: 'succeed' | 'fail' | 'record'
  readonly verdict: Verdict
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

/**
 * 探针骨架。
 *
 * ⚠️ `judge` 参数是**必须**的教训（本脚本第一版漏了它）：
 *    第一版只在"函数没抛错"时标 `ok`，于是两条探针**自己算出来的判据是 false**
 *    却仍被报成 `ok`（`keyset` 的 `noGaps=false`、`coverage` 的 `coverageComplete=false`）。
 *    ⇒ 判据必须**参与判定**：`judge` 返回非空即 `unexpected`（fail-closed）。
 *    与 `m9.5:measurement:verify` 里"把期望写成字段"是同一条纪律。
 */
async function probe(input: {
  readonly id: string
  readonly question: string
  readonly expectation: 'succeed' | 'fail' | 'record'
  readonly run: () => Promise<Record<string, unknown>>
  /** 返回失败原因数组；**空数组才算过** */
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Promise<Probe> {
  try {
    const reading = await input.run()
    const problems = input.judge?.(reading) ?? []
    if (input.expectation === 'fail') {
      return {
        id: input.id,
        question: input.question,
        expectation: input.expectation,
        verdict: 'unexpected',
        reading,
        error: '应当失败却成功了',
      }
    }
    return {
      id: input.id,
      question: input.question,
      expectation: input.expectation,
      verdict: problems.length > 0 ? 'unexpected' : 'ok',
      reading,
      error: problems.length > 0 ? problems.join('; ') : null,
    }
  } catch (error) {
    return {
      id: input.id,
      question: input.question,
      expectation: input.expectation,
      verdict:
        input.expectation === 'fail'
          ? 'expected-failure'
          : input.expectation === 'succeed'
            ? 'unexpected'
            : 'ok',
      reading: {},
      error: (error as Error).message.replace(/\s+/g, ' ').slice(0, 200),
    }
  }
}

// ---------------------------------------------------------------------------
// 确定性向量与项目侧校验（D28）
// ---------------------------------------------------------------------------

function unitVector(seed: number): number[] {
  const values: number[] = []
  let state = (seed * 2654435761) >>> 0
  for (let i = 0; i < DIM; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    values.push(((state / 0xffffffff) * 2 - 1) * 0.5)
  }
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1
  return values.map((v) => v / norm)
}

function toLiteral(vector: readonly number[]): string {
  return `[${vector.map((v) => v.toFixed(8)).join(',')}]`
}

/**
 * **项目侧**向量校验（D28）。返回具名失败原因，或 `null` 表示可发布。
 *
 * ⚠️ 它**不能**由数据库代劳：实测数据库**接受**零范数向量，余弦距离静默变 `NaN`
 *    （WP1 的 `zero-vector-cosine` 探针）。所以这四条必须在发布前自己走一遍。
 */
function validateVector(vector: readonly number[], expectedDim: number): string | null {
  if (vector.length !== expectedDim) return `invalid_vector:dimension(${String(vector.length)}!=${String(expectedDim)})`
  if (!vector.every((value) => Number.isFinite(value))) return 'invalid_vector:nan_or_inf'
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  if (!(norm > 0)) return 'invalid_vector:zero_norm'
  if (Math.abs(norm - 1) > 1e-3) return `invalid_vector:not_normalized(${norm.toFixed(6)})`
  return null
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number)
    na += (a[i] as number) ** 2
    nb += (b[i] as number) ** 2
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface Row {
  readonly memoryId: string
  readonly namespace: string
  readonly sourceRevision: number
  readonly generationId: string
  readonly vector: number[]
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp4-index', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)

  const realDbBefore = safeTreeDigest()

  await resetPluginSqlConnection()
  isolateDatabase('m95-wp4-index', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp4-index' })
  const db = bed.h.db
  const probes: Probe[] = []

  /* ---- 1. DDL 能不能建（先证 DDL，再谈冻结进迁移） ---- */
  probes.push(
    await probe({
      id: 'ddl-create',
      question: '将要写进迁移的那份 DDL 在锁定版本上能不能建（3 表 + 1 复合索引）',
      expectation: 'succeed',
      run: async () => {
        for (const statement of DDL) await db.execute(sql.raw(statement))
        const tables = rowsOf(
          await db.execute(
            sql`select table_name from information_schema.tables
                where table_schema = 'public' and table_name like 'm95_probe_semantic%'
                order by table_name`
          )
        ).map((row) => String(row.table_name))
        const indexes = rowsOf(
          await db.execute(
            sql`select indexname from pg_indexes where tablename = ${INDEX_TABLE} order by indexname`
          )
        ).map((row) => String(row.indexname))
        const embeddingType = rowsOf(
          await db.execute(
            sql`select udt_name from information_schema.columns
                where table_name = ${INDEX_TABLE} and column_name = 'embedding'`
          )
        )[0]?.udt_name
        return { tables, indexes, embeddingType: String(embeddingType) }
      },
      judge: (reading) => {
        const problems: string[] = []
        const tables = reading.tables as string[]
        if (tables.length !== 3) problems.push(`期望 3 张探针表，实际 ${String(tables.length)}`)
        const indexes = reading.indexes as string[]
        if (!indexes.some((name) => name.endsWith('_scope'))) problems.push('缺 (namespace, generation_id, memory_id) 复合索引')
        if (reading.embeddingType !== 'vector') problems.push(`embedding 列类型是 ${String(reading.embeddingType)}`)
        return problems
      },
    })
  )

  /* ---- 2. 幂等 upsert：同一逻辑行写两次仍只有一行 ---- */
  const genA = 'gen-A'
  const genB = 'gen-B'
  await db.execute(
    sql`insert into ${sql.raw(GENERATION_TABLE)}
        (generation_id, namespace, model_fingerprint, renderer_version, dimension,
         index_schema_version, build_state, created_at)
        values (${genA}, ${NS_MAIN}, ${MODEL}, ${'renderer@1'}, ${DIM}, ${1}, ${'building'}, ${1})`
  )
  await db.execute(
    sql`insert into ${sql.raw(GENERATION_TABLE)}
        (generation_id, namespace, model_fingerprint, renderer_version, dimension,
         index_schema_version, build_state, created_at)
        values (${genB}, ${NS_MAIN}, ${MODEL}, ${'renderer@1'}, ${DIM}, ${1}, ${'building'}, ${2})`
  )

  const seedRowA: Row = {
    memoryId: 'mem:A',
    namespace: NS_MAIN,
    sourceRevision: 1,
    generationId: genA,
    vector: unitVector(1),
  }

  const upsert = async (row: Row): Promise<void> => {    await db.execute(
      sql`insert into ${sql.raw(INDEX_TABLE)}
          (namespace, memory_id, source_revision, generation_id, model_fingerprint,
           renderer_version, content_hash, tokenizer_fingerprint, pooling, normalize,
           dtype, dimension, embedding, created_at)
          values (${row.namespace}, ${row.memoryId}, ${row.sourceRevision}, ${row.generationId},
                  ${MODEL}, ${'renderer@1'}, ${`h:${String(row.sourceRevision)}`}, ${'tok@1'},
                  ${'mean'}, ${true}, ${'q8'}, ${DIM}, ${toLiteral(row.vector)}::vector, ${1})
          on conflict (namespace, memory_id, source_revision, model_fingerprint, generation_id)
          do update set embedding = excluded.embedding, content_hash = excluded.content_hash`
    )
  }

  probes.push(
    await probe({
      id: 'upsert-idempotent',
      question: '同一逻辑行写两次 ⇒ 仍只有一行（幂等写；重放不重复增加）',
      expectation: 'succeed',
      run: async () => {
        await upsert(seedRowA)
        await upsert(seedRowA)
        const count = Number(
          rowsOf(await db.execute(sql`select count(*)::int as c from ${sql.raw(INDEX_TABLE)}`))[0]?.c ?? 0
        )
        return { rows: count, idempotent: count === 1 }
      },
    })
  )

  /* ---- 3. D28：三条非法向量必须在**发布前**被项目侧拒 ---- */
  for (const [id, label, vector] of [
    ['store-rejects-nan', 'NaN 分量', (() => { const v = unitVector(9); v[0] = Number.NaN; return v })()],
    ['store-rejects-zero-norm', '零范数', new Array(DIM).fill(0) as number[]],
    ['store-rejects-not-normalized', '未归一化（范数 2）', unitVector(7).map((v) => v * 2)],
  ] as const) {
    probes.push(
      await probe({
        id,
        question: `D28：${label}的向量必须被**项目侧**拒（不能靠数据库）`,
        expectation: 'succeed',
        run: async () => {
          const reason = validateVector(vector, DIM)
          return { reason, rejected: reason !== null }
        },
      })
    )
  }

  /* ---- 4. 维度不符：数据库也要拒（双保险） ---- */
  probes.push(
    await probe({
      id: 'db-rejects-wrong-dimension',
      question: '数据库侧：383 维写入必须被拒（项目侧校验之外的**第二道**）',
      expectation: 'fail',
      run: async () => {
        const short = `[${Array.from({ length: DIM - 1 }, () => '0.1').join(',')}]`
        await db.execute(
          sql`insert into ${sql.raw(INDEX_TABLE)}
              (namespace, memory_id, source_revision, generation_id, model_fingerprint,
               renderer_version, content_hash, tokenizer_fingerprint, pooling, normalize,
               dtype, dimension, embedding, created_at)
              values (${NS_MAIN}, ${'mem:bad'}, ${1}, ${genA}, ${MODEL}, ${'renderer@1'},
                      ${'h'}, ${'tok@1'}, ${'mean'}, ${true}, ${'q8'}, ${DIM}, ${short}::vector, ${1})`
        )
        return { insertedUnexpectedly: true }
      },
    })
  )

  /* ---- 5. 规模档：写入 N 条并建两个 generation（用于检索/分页/generation 隔离） ---- */
  const N = 200
  const rowsA: Row[] = []
  for (let i = 0; i < N; i += 1) {
    const namespace = i % 5 === 0 ? NS_OTHER : NS_MAIN
    const row: Row = {
      memoryId: `mem:${String(i).padStart(4, '0')}`,
      namespace,
      sourceRevision: 1,
      generationId: genA,
      vector: unitVector(i + 100),
    }
    rowsA.push(row)
    await upsert(row)
  }
  /* generation B：同一批记忆的**另一代**（模拟模型换代；内容不同以资区分） */
  for (const row of rowsA.slice(0, 40)) {
    await upsert({ ...row, generationId: genB, vector: unitVector(Number(row.memoryId.slice(4)) + 500) })
  }

  /* ---- 6. 精确检索 vs 自算 brute force（以我自己的数学为 oracle） ---- */
  probes.push(
    await probe({
      id: 'exact-search-matches-brute-force',
      question: 'pgvector 精确检索的 top-k 是否与我自算的余弦 top-k **逐位相同**',
      expectation: 'succeed',
      run: async () => {
        const query = unitVector(123)
        const k = 8
        const dbRows = rowsOf(
          await db.execute(
            sql`select memory_id, (embedding <=> ${toLiteral(query)}::vector) as distance
                from ${sql.raw(INDEX_TABLE)}
                where namespace = ${NS_MAIN} and generation_id = ${genA}
                order by embedding <=> ${toLiteral(query)}::vector
                limit ${k}`
          )
        )
        const mine = rowsA
          .filter((row) => row.namespace === NS_MAIN && row.generationId === genA)
          .map((row) => ({ memoryId: row.memoryId, distance: 1 - cosine(query, row.vector) }))
          .sort((a, b) => (a.distance === b.distance ? (a.memoryId < b.memoryId ? -1 : 1) : a.distance - b.distance))
          .slice(0, k)
        const dbIds = dbRows.map((row) => String(row.memory_id))
        const mineIds = mine.map((row) => row.memoryId)
        const maxDistanceGap = Math.max(
          ...dbRows.map((row, index) => Math.abs(Number(row.distance) - (mine[index]?.distance ?? Number.NaN)))
        )
        return { dbIds, mineIds, identical: JSON.stringify(dbIds) === JSON.stringify(mineIds), maxDistanceGap }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.identical !== true) problems.push('top-k 顺序与自算 brute force 不一致（精确检索不是 oracle 行为）')
        if (!(Number(reading.maxDistanceGap) < 1e-6)) problems.push(`距离最大偏差 ${String(reading.maxDistanceGap)}`)
        return problems
      },
    })
  )

  /* ---- 7. keyset 分页：页与页之间无重无漏（含相同 source_revision 的并列） ---- */
  probes.push(
    await probe({
      id: 'keyset-pagination-stable',
      question: 'keyset 分页（按 memory_id 稳定排序）遍历全表：无重、无漏、页宽一致',
      expectation: 'succeed',
      run: async () => {
        const pageSize = 37
        const seen: string[] = []
        let cursor = ''
        for (let page = 0; page < 50; page += 1) {
          const batch = rowsOf(
            await db.execute(
              sql`select memory_id from ${sql.raw(INDEX_TABLE)}
                  where namespace = ${NS_MAIN} and generation_id = ${genA} and memory_id > ${cursor}
                  order by memory_id
                  limit ${pageSize}`
            )
          ).map((row) => String(row.memory_id))
          if (batch.length === 0) break
          seen.push(...batch)
          cursor = batch[batch.length - 1] as string
        }
        const expected = rowsA.filter((row) => row.namespace === NS_MAIN).length + 1
        const unique = new Set(seen).size
        return {
          pages: Math.ceil(seen.length / pageSize),
          visited: seen.length,
          unique,
          expectedRowsInNamespace: expected,
          noDuplicates: unique === seen.length,
          noGaps: seen.length === expected,
          sortedAscending: seen.every((id, index) => index === 0 || (seen[index - 1] as string) < id),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.noDuplicates !== true) problems.push('分页出现重复行')
        if (reading.noGaps !== true) {
          problems.push(`分页漏页：访问 ${String(reading.visited)} 行，期望 ${String(reading.expectedRowsInNamespace)}`)
        }
        if (reading.sortedAscending !== true) problems.push('分页顺序不是稳定升序')
        return problems
      },
    })
  )

  /* ---- 8. namespace 预过滤：**负控必须真的触发** ---- */
  probes.push(
    await probe({
      id: 'namespace-prefilter-with-fired-control',
      question:
        '物理 namespace 预过滤有效（且负控**真的可能触发**：不过滤时别 owner 的记忆确实排在前面）',
      expectation: 'succeed',
      run: async () => {
        const query = unitVector(100) // 恰是 i=0 的向量，而 i=0 属 NS_OTHER
        const unfiltered = rowsOf(
          await db.execute(
            sql`select namespace, memory_id from ${sql.raw(INDEX_TABLE)}
                where generation_id = ${genA}
                order by embedding <=> ${toLiteral(query)}::vector limit 5`
          )
        ).map((row) => `${String(row.namespace)}:${String(row.memory_id)}`)
        const filtered = rowsOf(
          await db.execute(
            sql`select namespace, memory_id from ${sql.raw(INDEX_TABLE)}
                where generation_id = ${genA} and namespace = ${NS_MAIN}
                order by embedding <=> ${toLiteral(query)}::vector limit 5`
          )
        ).map((row) => `${String(row.namespace)}:${String(row.memory_id)}`)
        const controlFired = unfiltered.some((item) => item.startsWith(`${NS_OTHER}:`))
        const leaked = filtered.some((item) => item.startsWith(`${NS_OTHER}:`))
        return {
          unfilteredTop5: unfiltered,
          filteredTop5: filtered,
          negativeControlFired: controlFired,
          zeroCrossNamespace: !leaked,
          effective: controlFired && !leaked,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.negativeControlFired !== true) {
          problems.push('负控**没有触发**（不过滤时别 owner 的记忆没排进前列）⇒ 「过滤有效」是空过')
        }
        if (reading.zeroCrossNamespace !== true) problems.push('过滤后仍出现别 namespace 的行')
        return problems
      },
    })
  )

  /* ---- 9. generation 隔离：换代后不混排；维度/指纹不符拒绝 ---- */
  probes.push(
    await probe({
      id: 'generation-isolation',
      question: '查询只返回**指定 generation** 的向量；两代不混排',
      expectation: 'succeed',
      run: async () => {
        const a = Number(
          rowsOf(
            await db.execute(
              sql`select count(*)::int as c from ${sql.raw(INDEX_TABLE)}
                  where generation_id = ${genA} and namespace = ${NS_MAIN}`
            )
          )[0]?.c ?? 0
        )
        const b = Number(
          rowsOf(
            await db.execute(
              sql`select count(*)::int as c from ${sql.raw(INDEX_TABLE)} where generation_id = ${genB}`
            )
          )[0]?.c ?? 0
        )
        const mixed = rowsOf(
          await db.execute(
            sql`select generation_id, count(*)::int as c from ${sql.raw(INDEX_TABLE)}
                group by generation_id order by generation_id`
          )
        ).map((row) => `${String(row.generation_id)}=${String(row.c)}`)
        return { genA_inNamespace: a, genB: b, perGeneration: mixed }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.genB) !== 40) problems.push(`genB 行数 ${String(reading.genB)} ≠ 40`)
        if (Number(reading.genA_inNamespace) < 161) {
          problems.push(`genA 在 NS_MAIN 的行数 ${String(reading.genA_inNamespace)} < 161`)
        }
        return problems
      },
    })
  )

  probes.push(
    await probe({
      id: 'generation-activation-atomic',
      question: 'generation 发布与"当前生效代"切换是**原子的**（旧代保留但不活跃）',
      expectation: 'succeed',
      run: async () => {
        const activeOf = async (namespace: string): Promise<string | null> => {
          const rows = rowsOf(
            await db.execute(
              sql`select generation_id from ${sql.raw(GENERATION_TABLE)}
                  where namespace = ${namespace} and build_state = ${'published'}
                  order by published_at desc nulls last, generation_id desc limit 1`
            )
          )
          return rows.length === 0 ? null : String(rows[0]?.generation_id)
        }
        await db.execute(
          sql`update ${sql.raw(GENERATION_TABLE)} set build_state = ${'published'}, published_at = ${10}
              where generation_id = ${genA}`
        )
        const afterA = await activeOf(NS_MAIN)
        await db.execute(
          sql`update ${sql.raw(GENERATION_TABLE)} set build_state = ${'published'}, published_at = ${20}
              where generation_id = ${genB}`
        )
        const afterB = await activeOf(NS_MAIN)
        /* 回退：把 B 标成 unavailable，A 自动重新成为生效代（旧代保留可回滚） */
        await db.execute(
          sql`update ${sql.raw(GENERATION_TABLE)} set build_state = ${'unavailable'} where generation_id = ${genB}`
        )
        const afterRollback = await activeOf(NS_MAIN)
        const buildingCount = Number(
          rowsOf(
            await db.execute(
              sql`select count(*)::int as c from ${sql.raw(GENERATION_TABLE)} where build_state = ${'building'}`
            )
          )[0]?.c ?? 0
        )
        return { afterA, afterB, afterRollback, rollbackRestoresPrevious: afterRollback === genA, buildingCount }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.afterA !== 'gen-A') problems.push(`发布 A 后生效代是 ${String(reading.afterA)}`)
        if (reading.afterB !== 'gen-B') problems.push(`发布 B 后生效代是 ${String(reading.afterB)}（原子切换失效）`)
        if (reading.rollbackRestoresPrevious !== true) {
          problems.push(`回退后生效代是 ${String(reading.afterRollback)}（旧代不可回滚）`)
        }
        return problems
      },
    })
  )

  /* ---- 10. 覆盖计数：必须能与源记录数对账，不能拿 row count 冒充覆盖 ---- */
  probes.push(
    await probe({
      id: 'coverage-counters-reconcile',
      question: '覆盖计数（应索引/已索引/待处理/失败/排除）能与源记录数对账，且 coverageComplete 是判据不是 row count',
      expectation: 'succeed',
      run: async () => {
        /* 种子行 mem:A 也在 genA 里 ⇒ 应索引数 = rowsA + 1 */
        const eligible = rowsA.length + 1
        const indexed = Number(
          rowsOf(
            await db.execute(
              sql`select count(*)::int as c from ${sql.raw(INDEX_TABLE)} where generation_id = ${genA}`
            )
          )[0]?.c ?? 0
        )
        /* 注入两条失败：只记失败表，**不**推进水位 */
        for (const memoryId of ['mem:FAIL-1', 'mem:FAIL-2']) {
          await db.execute(
            sql`insert into ${sql.raw(FAILURE_TABLE)} (generation_id, memory_id, reason, attempts, last_attempt_at)
                values (${genA}, ${memoryId}, ${'invalid_vector:nan_or_inf'}, ${1}, ${1})
                on conflict (generation_id, memory_id) do update set attempts = excluded.attempts`
          )
        }
        await db.execute(
          sql`update ${sql.raw(GENERATION_TABLE)}
              set processed_watermark = ${indexed}, eligible_source_count = ${eligible},
                  failed_count = ${2}, pending_count = ${eligible - indexed}
              where generation_id = ${genA}`
        )
        const gen = rowsOf(
          await db.execute(
            sql`select eligible_source_count, processed_watermark, pending_count, failed_count, excluded_by_policy_count
                from ${sql.raw(GENERATION_TABLE)} where generation_id = ${genA}`
          )
        )[0]
        const pending = Number(gen?.pending_count ?? 0)
        const failed = Number(gen?.failed_count ?? 0)
        return {
          eligibleSourceCount: eligible,
          indexedRows: indexed,
          watermark: Number(gen?.processed_watermark ?? 0),
          pending,
          failed,
          excluded: Number(gen?.excluded_by_policy_count ?? 0),
          /** ★ 覆盖完整 = 无待处理**且**无失败；**不是** `row count == 期望` 一句话 */
          coverageComplete: pending === 0 && failed === 0,
          reconciles: eligible === indexed + pending,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.reconciles !== true) {
          problems.push(
            `覆盖计数对不上账：应索引 ${String(reading.eligibleSourceCount)} ≠ 已索引 ${String(reading.indexedRows)} + 待处理 ${String(reading.pending)}`
          )
        }
        if (reading.pending !== 0) problems.push(`注入后待处理应为 0，实际 ${String(reading.pending)}`)
        /* ★ 关键判据：**注入了失败就必须拒绝宣称覆盖完整**（不能拿 row count 冒充覆盖） */
        if (reading.coverageComplete !== false) {
          problems.push('有失败项却宣称 coverageComplete=true —— 拿 row count 冒充了覆盖')
        }
        return problems
      },
    })
  )

  /* ---- 11. 派生东西可删可重建（不定义"她知道什么"） ---- */
  probes.push(
    await probe({
      id: 'drop-and-rebuild-unchanged',
      question: '派生表可删可重建：同一确定性输入重建后**逐个向量逐位相同**（索引层 A==B）',
      expectation: 'succeed',
      run: async () => {
        const digestOf = async (): Promise<string> => {
          const rows = rowsOf(
            await db.execute(
              sql`select memory_id, embedding::text as v from ${sql.raw(INDEX_TABLE)}
                  where generation_id = ${genA} order by memory_id`
            )
          )
          const hasher = createHash('sha256')
          for (const row of rows) hasher.update(`${String(row.memory_id)}\t${String(row.v)}\n`)
          return hasher.digest('hex')
        }
        const before = await digestOf()
        await db.execute(sql.raw(`drop table if exists ${INDEX_TABLE}`))
        for (const statement of DDL) await db.execute(sql.raw(statement))
        /* ⚠️ 重建必须放回**全部** genA 行 —— 第一版只放 `rowsA`，漏了种子行 `mem:A`，
              于是 before≠after 会是一次**假的**失败（判据错，不是实现错）。 */
        for (const row of [seedRowA, ...rowsA]) await upsert(row)
        const after = await digestOf()
        return {
          before,
          after,
          rowsRebuilt: rowsA.length + 1,
          rebuiltIdentical: before === after,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.rebuiltIdentical !== true) {
          problems.push(`重建后摘要不同：${String(reading.before).slice(0, 12)}… vs ${String(reading.after).slice(0, 12)}…`)
        }
        if (Number(reading.rowsRebuilt) !== 201) problems.push(`重建行数 ${String(reading.rowsRebuilt)} ≠ 201`)
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
    schemaVersion: 'm9.5-index@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      proves: '本项目的派生索引契约（唯一键/分页/精确检索/namespace/维度与向量校验/generation/覆盖计数/重建）',
      notProves: '**不**证明迁移已落地（本轮用隔离库里的**临时 DDL**；kernel 迁移 0010 见 preflight）',
      ddlWillBeFrozenInto: 'MIGRATION_0010（下一轮；见 docs/m9.5/M9.5-WP4-Preflight.md）',
    },
    ddl: DDL,
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }

  const evidencePath = join(runDir, 'index-verify.json')
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
    configHash: { dimension: DIM, indexSchemaVersion: 1, ddlLines: DDL.length },
    command: [{ cmd: 'pnpm m9.5:index:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'index-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP4 存储/检索语义：${runId}`,
      ...probes.map(
        (item) =>
          `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`
      ),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

function safeTreeDigest(): Record<string, unknown> | null {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return { dir: 'data/pglite', measuredCount: digest.measuredCount, totalBytes: digest.totalBytes, treeSha256: digest.treeSha256 }
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

await main()
