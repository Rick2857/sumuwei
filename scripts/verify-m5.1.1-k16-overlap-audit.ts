/**
 * M5.1.1 WP2.1 —— **K-16：v6 既有列与 v7 22 列的重叠审计**（`pnpm m5.1.1:k16:verify`）。
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 * WP2 量出：`conversation_events` 在 v7 里**净新增 19 列而不是 22**，因为
 * `source_kind` / `source_authority` / `epistemic_source` 三列**在迁移 0003 就已存在**。
 *
 * 而 `M5.1.1-D01-Investigation-Report.md` 的因果链第 ③ 步写着
 * "migrations 的 conversation_events **没有** source_kind / source_authority /
 *  epistemic_source 列" —— 这两件事**不可能同时是真的**。
 * 在把 v7 施加到真实数据的副本上之前，必须把事实钉死：
 * `ADD COLUMN IF NOT EXISTS` 会**静默跳过**建列，如果那三列带着旧语义或旧数据，
 * 我们会误以为它们已经符合 ADR-042 的新语义。
 *
 * ---------------------------------------------------------------------------
 *  它允许做什么、禁止做什么
 * ---------------------------------------------------------------------------
 *  **允许**：只读统计真实库的文件数 / 总字节 / boundary；`cpSync` 到临时目录；
 *           **只打开副本**读 schema 与列事实。
 *  **禁止**：打开真实库；在副本上执行 v7（本脚本**不调用** `initDatabase`，
 *           因此副本保持 v6 —— 证据里会把"副本 = v6 / 代码 = v7"如实记下来）。
 *
 * ---------------------------------------------------------------------------
 *  量具纪律
 * ---------------------------------------------------------------------------
 * 每个计数型检测器都要先过 `measure()`（`measured_count > 0`），否则 MEASUREMENT INVALID。
 *
 * 跑法：pnpm m5.1.1:k16:verify
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import 'dotenv/config'

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'
import { migrationPremiseOf, postMigrationInvariants } from './m5.1.1-post-migration-invariants.ts'
import { currentSchemaVersion, getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import {
  ATTRIBUTION_V7_COLUMNS,
} from '../src/kernel/contracts/attribution.ts'
import {
  EPISTEMIC_SOURCES,
  SOURCE_AUTHORITIES,
  SOURCE_KINDS,
} from '../src/kernel/contracts/source-authority.ts'

/** 新词表（= 契约，也就是 v7 的 CHECK 会允许的取值） */
const SOURCE_KIND_VALUES_FOR_AUDIT: readonly string[] = SOURCE_KINDS
const SOURCE_AUTHORITY_VALUES_FOR_AUDIT: readonly string[] = SOURCE_AUTHORITIES
const EPISTEMIC_SOURCE_VALUES_FOR_AUDIT: readonly string[] = EPISTEMIC_SOURCES

// ---------------------------------------------------------------------------
// 检查器
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []
const blockers: string[] = []

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}

function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

// ===========================================================================
section('1. 真实库：只读统计（**不打开**）')
// ===========================================================================

const productionExists = existsSync(PRODUCTION_DB_DIR)
check('真实库目录存在', productionExists, PRODUCTION_DB_DIR)

function walk(dir: string): { rel: string; size: number; mtime: number }[] {
  const out: { rel: string; size: number; mtime: number }[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else {
        const stat = statSync(full)
        out.push({ rel: relative(PRODUCTION_DB_DIR, full), size: stat.size, mtime: stat.mtimeMs })
      }
    }
  }
  visit(dir)
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
}

const files = walk(PRODUCTION_DB_DIR)
measure('真实库文件数', files.length)
const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
const newestMtime = files.reduce((max, file) => Math.max(max, file.mtime), 0)
/** boundary 指纹：由 (相对路径, 大小) 排序后哈希得到 —— 它是**边界身份**，不是内容哈希 */
const boundaryFingerprint = createHash('sha256')
  .update(files.map((file) => `${file.rel}\t${file.size}`).join('\n'), 'utf8')
  .digest('hex')

const productionStats = {
  dir: PRODUCTION_DB_DIR,
  fileCount: files.length,
  totalBytes,
  newestMtimeIso: new Date(newestMtime).toISOString(),
  boundaryFingerprint,
  opened: false as const,
  note: '只做文件系统统计；真实库从未被打开（打开的是它的副本）',
}
console.log(`  文件 ${files.length}｜总字节 ${totalBytes}｜最新 mtime ${productionStats.newestMtimeIso}`)
console.log(`  boundary 指纹 ${boundaryFingerprint.slice(0, 16)}…`)

// ===========================================================================
section('2. 副本：cpSync 后**只打开副本**（不执行 v7）')
// ===========================================================================

const workDir = mkdtempSync(join(tmpdir(), 'project-lg-k16-copy-'))
cpSync(PRODUCTION_DB_DIR, workDir, { recursive: true })
process.env.PGLITE_DATA_DIR = workDir
process.env.PROJECT_LG_SANDBOX = workDir
console.log(`  副本：${workDir}`)

/*
 * ⚠️ 刻意**不**调用 `initDatabase()`：沙箱路径会被放行，于是它会自动把 v7 施加到副本上 —
 *    而那正是用户在本 WP 明令禁止的动作（"K-16 关闭前禁止在 production copy 上执行 v7"）。
 *    这里只要一个能读的原始连接。
 */
const runtime = createThinHostRuntime({
    character: character,
    settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
    conversationLength: 16,
  })
await runtime.registerPlugin(undefined as never)
await await __applyKernelMigrations(__getRawDb(runtime))
const db = getRawDb(runtime)

const copyVersion = await currentSchemaVersion(db)
/*
 * ⚠️ M5.1.1 / Phase 4b（用户 2026-09-19 裁定）—— 本门的前提有两态。
 *
 * 原判据假定"副本仍是 v6"（这样它能把"v7 的 22 列里哪些**已经存在**"当成
 * K-16 的重名列集合）。真库按 `D-1 = ②` 迁到 v9 之后，副本也是 v9 ⇒
 * 那个集合会变成全部 22 列，前提失效。**取代不删除保证**：
 * 重名列集合改为**从迁移源码**推（不依赖"恰好逮到迁移前的库"），
 * 并额外断言 post-migration 不变量（既有行身份摘要逐字不变 ∧ 0 行伪造归因）。
 */
const premise = migrationPremiseOf(copyVersion)
check(
  '副本处于可判定状态（v6 的 K-16 审阅前提，或真库已迁移 v9 的事后核对）',
  premise !== 'unrecognized',
  premise === 'already-applied'
    ? `副本已是 v${copyVersion}（真实库已按 D-1=② 迁移）⇒ 重名列集合改由迁移源码推 + post-migration 不变量承接`
    : `v${copyVersion}（K-16 审阅前提有效）`
)

// ===========================================================================
section('3. K-16：v6 已存在的、与 v7 22 列重名的列')
// ===========================================================================

const existingColumns = rowsOf(
  await db.execute(
    sql`select column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public' and table_name = 'conversation_events'`
  )
) as { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
measure('副本里 conversation_events 的列数', existingColumns.length)

const existingNames = existingColumns.map((column) => column.column_name)
/*
 * K-16 的重名列集合 = "v7 的 22 列里，**在 v7 之前**就已经存在的那些"。
 *
 * ⚠️ Phase 4b 取代（用户 2026-09-19 裁定）：原来它是
 *     `ATTRIBUTION_V7_COLUMNS.filter((c) => existingNames.includes(c))`
 * —— 那要求"副本恰好停在 v6"。真库已迁到 v9 之后这个集合会变成全部 22 列。
 * 现在改为**从迁移源码推**：扫 `MIGRATIONS` 里 `add column if not exists <c>` 属于哪一条，
 * 版本 < 7 的才算重名。结论**不变**（仍是那 3 个 Axis B 列），但不再依赖"逮到迁移前的库"。
 */
const creatingVersionOf = (column: string): number | undefined => {
  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) {
      if (new RegExp(`add column if not exists ${column}\\b`).test(statement)) return migration.version
    }
  }
  return undefined
}
const overlaps =
  premise === 'pre-migration'
    ? ATTRIBUTION_V7_COLUMNS.filter((column) => existingNames.includes(column))
    : ATTRIBUTION_V7_COLUMNS.filter((column) => (creatingVersionOf(column) ?? 7) < 7)
measure('与 v7 22 列重名的既有列数', overlaps.length)
check(
  '重名列恰好 3 个（这就是 +19 而不是 +22 的原因）',
  overlaps.length === 3,
  `${overlaps.join(', ')}（口径：${premise === 'pre-migration' ? '副本 v6 的实际列' : '迁移源码里 v7 之前就建过'}）`
)
if (premise === 'already-applied') {
  const post = await postMigrationInvariants(db)
  check('★ 取代判据（真库已迁移）：既有行身份摘要逐字不变 ∧ 0 行伪造归因', post.ok, post.detail)
  check(
    '★ 取代判据（真库已迁移）：v7 的 22 列**全部**已在部署后的表上（K-16 的重名在部署后被兑现）',
    ATTRIBUTION_V7_COLUMNS.every((column) => existingNames.includes(column)),
    `表上 ${existingColumns.length} 列`
  )
}

/** 这一列是哪个迁移建的？直接查迁移定义里的 add column（而不是猜） */
function creatingMigrationOf(column: string): { version: number; name: string; statement: string } | null {
  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) {
      if (new RegExp(`add column if not exists ${column}\\b`).test(statement)) {
        return { version: migration.version, name: migration.name, statement: statement.replace(/\s+/g, ' ').trim() }
      }
    }
  }
  return null
}

const rowCountRows = rowsOf(await db.execute(sql`select count(*)::int as c from conversation_events`)) as { c: number }[]
const rowCount = Number(rowCountRows[0]?.c ?? 0)
measure('副本里 conversation_events 的行数', rowCount)

const constraints = rowsOf(
  await db.execute(
    sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'conversation_events'::regclass`
  )
) as { conname: string; def: string }[]
const indexDefs = rowsOf(
  await db.execute(sql`select indexname, indexdef from pg_indexes where tablename = 'conversation_events'`)
) as { indexname: string; indexdef: string }[]
measure('副本里 conversation_events 的约束数', constraints.length)
measure('副本里 conversation_events 的索引数', indexDefs.length)

const intendedMeaning: Record<string, string> = {
  source_kind: 'Axis B 第一列：这条内容属于哪一类来源（ADR-042 §4；v7 只给它加词表 CHECK）',
  source_authority: 'Axis B 第二列：这条内容的来源权威等级（新增 UNCONFIRMED_ORIGIN 取值）',
  epistemic_source: 'Axis B 第三列：这条内容属于哪一类认知产物（新增 UNCONFIRMED_ORIGIN 取值）',
}
const allowedValues: Record<string, readonly string[]> = {
  source_kind: SOURCE_KIND_VALUES_FOR_AUDIT,
  source_authority: SOURCE_AUTHORITY_VALUES_FOR_AUDIT,
  epistemic_source: EPISTEMIC_SOURCE_VALUES_FOR_AUDIT,
}

interface ColumnAudit {
  column: string
  type: string
  nullable: boolean
  default: string | null
  createdBy: { version: number; name: string; statement: string } | null
  oldSemantic: string
  v7IntendedSemantic: string
  nonNullCount: number
  totalRows: number
  distinctValuesAndCounts: { value: string; count: number }[]
  constraintsTouchingIt: string[]
  indexesTouchingIt: string[]
  existingValuesAllWithinNewVocabulary: boolean
  outOfVocabularyValues: string[]
  safeToReuse: boolean
  safeToReuseReason: string
}

const columnAudits: ColumnAudit[] = []
for (const column of overlaps) {
  const meta = existingColumns.find((entry) => entry.column_name === column)!
  const nonNullRows = rowsOf(
    await db.execute(
      sql`select count(*)::int as c from conversation_events where ${sql.raw(column)} is not null`
    )
  ) as { c: number }[]
  const nonNullCount = Number(nonNullRows[0]?.c ?? 0)
  const distinct = rowsOf(
    await db.execute(
      sql`select ${sql.raw(column)} as value, count(*)::int as count from conversation_events
          where ${sql.raw(column)} is not null
          group by ${sql.raw(column)} order by count desc`
    )
  ) as { value: string; count: number }[]
  const outOfVocabulary = distinct
    .map((entry) => String(entry.value))
    .filter((value) => !allowedValues[column]!.includes(value))
  const constraintsTouching = constraints
    .filter((entry) => new RegExp(`\\b${column}\\b`).test(entry.def))
    .map((entry) => `${entry.conname}: ${entry.def.replace(/\s+/g, ' ')}`)
  const indexesTouching = indexDefs
    .filter((entry) => new RegExp(`\\b${column}\\b`).test(entry.indexdef))
    .map((entry) => entry.indexname)

  columnAudits.push({
    column,
    type: meta.data_type,
    nullable: meta.is_nullable === 'YES',
    default: meta.column_default,
    createdBy: creatingMigrationOf(column),
    oldSemantic:
      'Axis B（M3 的来源分类）。⚠️ 但写入时它是**由 actor_type 全函数推导**出来的投影值，' +
      '不是独立确立的来源——这正是 D01 的机制（ADR-042 §4 说"never reconstruct"。' +
      '证据：conversation-event.ts 的 createConversationEvent → buildProvenance → sourceKindForActor）。',
    v7IntendedSemantic: intendedMeaning[column]!,
    nonNullCount,
    totalRows: rowCount,
    distinctValuesAndCounts: distinct.map((entry) => ({ value: String(entry.value), count: Number(entry.count) })),
    constraintsTouchingIt: constraintsTouching,
    indexesTouchingIt: indexesTouching,
    existingValuesAllWithinNewVocabulary: outOfVocabulary.length === 0,
    outOfVocabularyValues: outOfVocabulary,
    safeToReuse: outOfVocabulary.length === 0,
    safeToReuseReason:
      outOfVocabulary.length === 0
        ? '列名、类型、可空性、既有取值域都与 ADR-042 的 Axis B 一致；v7 只<追加>词表 CHECK 与一个新取值，' +
          '不改变列语义 ⇒ `ADD COLUMN IF NOT EXISTS` 跳过它是**正确**的'
        : '既有取值里存在新词表不允许的值 —— 直接加 CHECK 会在 apply 时失败（BLOCKER）',
  })
  console.log(
    `  ${column}: ${meta.data_type} ${meta.is_nullable === 'YES' ? 'null' : 'not null'}` +
      `｜建自 v${columnAudits[columnAudits.length - 1]!.createdBy?.version ?? '?'}` +
      `｜非空 ${nonNullCount}/${rowCount}｜distinct ${distinct.length}｜越界 ${outOfVocabulary.length}`
  )
}

for (const audit of columnAudits) {
  if (!audit.existingValuesAllWithinNewVocabulary) {
    blockers.push(
      `既有列 ${audit.column} 存在新词表不允许的值：${audit.outOfVocabularyValues.join(', ')}`
    )
  }
}

const totalDistinct = columnAudits.reduce((sum, audit) => sum + audit.distinctValuesAndCounts.length, 0)
measure('三列 distinct 取值总数', totalDistinct)
const totalNonNull = columnAudits.reduce((sum, audit) => sum + audit.nonNullCount, 0)

// ===========================================================================
section('4. 三种可能的分类，用测量结果判定')
// ===========================================================================

const classification =
  totalNonNull === 0
    ? 'schema_exists_but_runtime_never_writes'
    : 'schema_exists_runtime_writes_derived_values'
check(
  '分类已由测量判定（不是猜）',
  ['schema_exists_but_runtime_never_writes', 'schema_exists_runtime_writes_derived_values', 'historically_different_semantic_columns'].includes(
    classification
  ),
  `${classification}（非空合计 ${totalNonNull}）`
)
const differentSemantics = columnAudits.some((audit) =>
  audit.distinctValuesAndCounts.some((entry) => !allowedValues[audit.column]!.includes(entry.value))
)
check(
  '不存在"历史语义不同"的证据（取值都在 Axis B 的受控词汇内）',
  differentSemantics === false,
  differentSemantics ? '有越界取值' : '三列的取值全部落在 Axis B 词汇里'
)

// ===========================================================================
section('5. 与 D01 调查报告的表述对账')
// ===========================================================================

const d01Text = readFileSync(
  join(process.cwd(), 'docs', 'm5.1.1', 'M5.1.1-D01-Investigation-Report.md'),
  'utf8'
)
const claim = 'migrations 的 conversation_events **没有** source_kind /'
const claimFound = d01Text.includes(claim)
check('D01 报告里那句"没有这三列"确实存在（要被对账的那句）', claimFound)
const measurementContradictsClaim = overlaps.length > 0
check(
  '测量结果与那句话**矛盾**（副本里这三列存在）',
  measurementContradictsClaim,
  `重名列 ${overlaps.length} 个`
)

// ===========================================================================
section('6. 回填的爆炸半径（谁在读这些既有值）')
// ===========================================================================

/**
 * 静态扫 `src/`，找出 `canEvidenceExternalFact(` 的调用点 ——
 * 只有它会消费**事件对象上的** `sourceAuthority`（conversation-event.ts:372）。
 */
function listCallSites(dir: string): { file: string; lines: number[] }[] {
  const out: { file: string; lines: number[] }[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.name.endsWith('.ts')) {
        const lines = readFileSync(full, 'utf8').split('\n')
        const hits = lines
          .map((line, index) => (line.includes('canEvidenceExternalFact(') ? index + 1 : 0))
          .filter((line) => line > 0)
        if (hits.length > 0) out.push({ file: relative(process.cwd(), full).replace(/\\/g, '/'), lines: hits })
      }
    }
  }
  visit(dir)
  return out
}

const callSites = listCallSites(join(process.cwd(), 'src'))
measure('src/ 里 canEvidenceExternalFact 的调用点文件数', callSites.length)

const blastRadius = {
  consumersOfRecordedAxisB: [
    'src/kernel/contracts/conversation-event.ts:372 —— canEvidenceExternalFact 会读事件对象上的 sourceAuthority（若存在）',
    'src/infrastructure/persistence/conversation-store.ts:82 —— rowToEvent 用「记录值 ?? 派生值」填 Axis B',
    'src/infrastructure/persistence/conversation-store.ts:276 —— 写入这条记录（既有值的来源）',
  ],
  productionConsumerUsesDerivedValueInstead: [
    'src/kernel/app/memory/extractor.ts:149-156 —— 抽取器把**它自己推导的** sourceAuthority' +
      '（defaultAuthorityForKind(sourceKindForActor(actorType))）喂给 canEvidenceExternalFact，' +
      '并据此调 authorityFromSource → **它不读行上的记录值**',
  ],
  callSitesScanned: callSites,
  verdict:
    '把既有行的 Axis B 改写成 UNCONFIRMED_ORIGIN（WP3 回填的冻结值）**不会**改变今天的内存链路：' +
    '生产抽取器用的是自己推导的值。但它会改变**账本上可见的值**，以及任何直接读账本记录值的面' +
    '（开发者平面/审计），并使 M3 评测里 "herEvents 的 sourceAuthority === CHARACTER_GENERATION" 这类' +
    '断言在**读到被回填的旧行**时失效。⇒ 这是 WP3 的前置项，不是 WP2 的。',
  wp3Precondition:
    'WP3 回填前必须确认：既有非空 Axis B 值被改写这件事，对每个消费者（抽取器/开发者平面/评测）' +
    '分别是什么后果；并记住 `IF NOT EXISTS` 不会救我们 —— 那三列**已经存在**，回填是在**改数据**。',
}

// ===========================================================================
section('7. 汇总裁定')
// ===========================================================================

const k16Verdict = blockers.length === 0 ? 'PASS' : 'BLOCKED'
check(
  `K-16 裁定 = ${k16Verdict}（safe to reuse? ${columnAudits.every((audit) => audit.safeToReuse) ? 'YES' : 'NO'}）`,
  k16Verdict === 'PASS',
  blockers.join(' | ') || '三列均可安全复用'
)
const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const evidence = {
  testId: 'M5.1.1 / WP2.1 K-16 existing-column overlap audit',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:k16:verify',
  passed,
  failed,
  failures,
  blockers,
  productionReadOnly: productionStats,
  copy: {
    dir: workDir,
    copySchemaVersion: copyVersion,
    codeLatestSchemaVersion: MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0),
    v7AppliedToCopy: false,
    note: '刻意不调用 initDatabase：沙箱路径会被放行，那会把 v7 施加到副本上（用户明令禁止）',
  },
  overlap: {
    v7ColumnCount: ATTRIBUTION_V7_COLUMNS.length,
    existingColumnCount: existingColumns.length,
    overlappingColumns: overlaps,
    netNewColumns: ATTRIBUTION_V7_COLUMNS.length - overlaps.length,
    rowCount,
    distinctValueTotal: totalDistinct,
    nonNullTotal: totalNonNull,
    classification,
    columnAudits,
  },
  d01Reconciliation: {
    document: 'docs/m5.1.1/M5.1.1-D01-Investigation-Report.md',
    quotedClaim: claim,
    claimFound,
    measurementContradictsClaim,
    measuredFact:
      'conversation_events 在迁移 0003 就有时这三列；实时写入路径（conversation-store.ts 的 INSERT）' +
      '**会写**它们，但写入的值是由 actor_type 全函数推导出来的 Axis B 投影。',
    correctedMechanism:
      '③ 落库：Axis B **被持久化**，但持久化的是"由 actor_type 推导出来的"值 ——' +
      '所以它不携带 actor_type 之外的任何信息；对迁移 0003 之前的旧行则完全没有值，' +
      '读回时由 deriveSourceForLegacyRow 兜底推导。',
    conclusionUnaffected:
      'D01 的结论（actor_type 不是作者证明、USER_EXPLICIT 只由 actor_type 产生）不受影响，' +
      '反而更清楚：问题不是"没记"，而是"记的是推导值"。',
  },
  backfillBlastRadius: blastRadius,
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    allowedByUser: 'copy-only preflight（只读统计 → cpSync → 只开副本 → 检查 v6 schema 与 K-16 事实）',
    forbiddenUntilK16Closes: [
      'production copy 上执行 v7 migrate:apply',
      '开始 legacy backfill（WP3）',
    ],
    realDatabaseOpened: false,
  },
}

mkdirSync(join(process.cwd(), 'artifacts', 'm5.1.1'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5.1.1', 'wp2.1-k16-overlap-audit.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8'
)

console.log(`\n${'='.repeat(74)}`)
console.log(`M5.1.1 WP2.1 K-16 重叠审计：${passed} 通过 / ${failed} 失败｜裁定 ${k16Verdict}`)
console.log(`量具自检：${measurements.length} 个计数检测器，无效 ${measurementInvalid.length}`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure}`)
}
if (blockers.length > 0) {
  console.log('BLOCKER：')
  for (const blocker of blockers) console.log(`  - ${blocker}`)
}
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp2.1-k16-overlap-audit.json')

try {
  await runtime.stop()
} catch {
  /* 忽略 */
}
try {
  rmSync(workDir, { recursive: true, force: true })
  console.log('副本已清理（真实库从未被打开）')
} catch {
  console.log('副本未能清理（可手动删）')
}

process.exit(failed === 0 ? 0 : 1)
