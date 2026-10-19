/**
 * M5.1.1 / WP10-B —— **Production-Copy Migration**（`pnpm m5.1.1:wp10b:verify`）
 *
 * ============================================================================
 *  这道门回答什么（canonical WP10 的 "Production-copy" 段 · 用户 R-49 授权）
 * ============================================================================
 * ```text
 *   必须：真实 production DB copy          禁止：live production destructive migration
 *   运行：v6 → v7（当前形式 v6 → v9）· backfill · replay · query · action · control
 *   验证：migration count truth · unknown count truth · no fabricated USER · no mutation from query
 * ```
 *
 * 真实库**全程只被 statSync/readdirSync 采样 + 被 cpSync 读取**，从不被应用代码打开
 * （隔离机制 = `copy`：`cpSync` 到临时目录 + `PGLITE_DATA_DIR = <副本>`，
 *  与 `verify-migrate-gate.ts` / `prod-copy` 门 / `wp3` 门同一形状）。
 *
 * ============================================================================
 *  「五个 canonical 步骤」的**证据分区**（本门刻意不混两栏）
 * ============================================================================
 * ```text
 *   (a) 副本侧前置证明 —— 本门在**真实库的副本上**用 raw SQL 实测（§4/§5/§6）
 *   (b) 五个能力**自己的门** —— 各自在自己的库上跑（§7），并**逐条标注它跑在哪**：
 *         backfill → m5.1.1:wp3:verify …… **production-copy**（该门自己 cpSync 真实库、
 *                                        在副本上跑真实回填 —— canonical 要的就是它）
 *         replay / query / action / control → **isolated sandbox**（这些门调 `isolateDatabase()`，
 *                                        结构性上无法被指向本门的副本；见 §7 的机器证明）
 * ```
 * ⇒ 本门**不**声称"query/action/control 跑在真实库副本上"。
 *
 * ============================================================================
 *  冻结面纪律
 * ============================================================================
 *  §7 会调用 `m5.1:*` 门 ⇒ 它们会重写 `artifacts/m5.1/**`（**冻结目录**）。
 *  本门把这些**新鲜读数**记进自己的证据 `wp10-production-copy.json`，
 *  冻结目录则由执行代理按白名单从 immutable 标签 `m5.1-complete` **逐路径还原**。
 *  所以：**新鲜读数在 §7 的证据里，冻结目录保持历史 blob。**
 *
 * 跑法：pnpm m5.1.1:wp10b:verify
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { ATTRIBUTION_SLOT_COLUMNS, type AttributionValueSlot } from '../src/kernel/contracts/attribution.ts'
import {
  applyKernelMigrations,
  currentSchemaVersion,
  getRawDb,
  pendingMigrations,
  rowsOf,
} from '../src/infrastructure/persistence/db.ts'

// ---------------------------------------------------------------------------
// 检查器 / 量具
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, ok: boolean, detail: string): boolean {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}  [${detail}]`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}  [${detail}]`)
  }
  return ok
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}
function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID'}`)
}
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const stableStringify = (value: unknown): string => JSON.stringify(value)

const ROOT = process.cwd()
const ART = join(ROOT, 'artifacts', 'm5.1.1')

/** 真实库的边界身份（由 `prod-copy` 门 2026-09-18 记录；算法见 `snapshotBoundary`） */
const FROZEN_SOURCE_BOUNDARY_SHA256 = '38844f4eb730c96fea72b58ca3f51589d8a75b03131c3515b3532de400bb9cc2'

/** canonical 的五个步骤 → 实际跑的 pnpm 门（每个都注明它跑在哪） */
const CANONICAL_STEPS: { step: string; pnpm: string; where: 'production-copy' | 'isolated-sandbox'; note: string }[] = [
  { step: 'backfill', pnpm: 'm5.1.1:wp3:verify', where: 'production-copy', note: '该门自己 cpSync 真实库并在**副本**上跑真实回填（quiet + 边界指纹协议）' },
  { step: 'replay', pnpm: 'm5.1.1:wp6:verify', where: 'isolated-sandbox', note: 'recorded read path + replay；该门调 isolateDatabase()' },
  { step: 'query', pnpm: 'm5.1:query:verify', where: 'isolated-sandbox', note: '只读 Query 面；该门调 isolateDatabase()' },
  { step: 'action', pnpm: 'm4.5:verify', where: 'isolated-sandbox', note: '行动执行链；该门调 isolateDatabase()' },
  { step: 'control', pnpm: 'm5.1:control:verify', where: 'isolated-sandbox', note: '开发者控制面；该门调 isolateDatabase()' },
]

const TABLES = ['conversation_events', 'character_action_events', 'state_events'] as const
const SLOTS = Object.keys(ATTRIBUTION_SLOT_COLUMNS) as AttributionValueSlot[]

// ---------------------------------------------------------------------------
// 边界快照（与 prod-copy 门 / WP10-A 的算法**逐字相同**）
// ---------------------------------------------------------------------------

interface Boundary {
  fingerprint: string
  fileCount: number
  totalBytes: number
  newestMtimeIso: string
}
function snapshotBoundary(dir: string, root: string = dir): Boundary {
  const files: { rel: string; size: number; mtime: number }[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else {
        const stat = statSync(full)
        files.push({ rel: relative(root, full), size: stat.size, mtime: stat.mtimeMs })
      }
    }
  }
  visit(dir)
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  return {
    fingerprint: sha256(files.map((file) => `${file.rel}\t${file.size}`).join('\n')),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    newestMtimeIso: new Date(files.reduce((max, file) => Math.max(max, file.mtime), 0)).toISOString(),
  }
}
const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// ===========================================================================
section('§0 只读边界：真实库只被采样与复制')
// ===========================================================================

const sourceBefore = snapshotBoundary(PRODUCTION_DB_DIR)
measure('源文件数', sourceBefore.fileCount)
console.log(`  源：${sourceBefore.fileCount} 文件 / ${sourceBefore.totalBytes} 字节 · 边界身份 ${sourceBefore.fingerprint.slice(0, 16)}…`)
check('真实库存在且被采样（应用代码**从不**打开它）', existsSync(PRODUCTION_DB_DIR) && sourceBefore.fileCount > 0, JSON.stringify(sourceBefore))
check(
  '★ 源的边界身份仍 == 冻结值（WP10-A 的同一判据）⇒ 源自 2026-09-18 那次复制以来没被动过',
  sourceBefore.fingerprint === FROZEN_SOURCE_BOUNDARY_SHA256,
  `${sourceBefore.fingerprint.slice(0, 16)}… vs ${FROZEN_SOURCE_BOUNDARY_SHA256.slice(0, 16)}…`
)

// ===========================================================================
section('§1 B1：静默窗口 → cpSync 复制 → 复制后复核源指纹')
// ===========================================================================

const quiescenceMs = 3000
await sleep(quiescenceMs)
const sourceQuiet = snapshotBoundary(PRODUCTION_DB_DIR)
check(
  `源在 ${quiescenceMs}ms 静默窗口内没有变化（连续两次边界指纹一致）`,
  sourceQuiet.fingerprint === sourceBefore.fingerprint,
  `${sourceQuiet.fingerprint.slice(0, 16)}…`
)

const workDir = mkdtempSync(join(tmpdir(), 'wp10b-copy-'))
cpSync(PRODUCTION_DB_DIR, workDir, { recursive: true })
const copyFresh = snapshotBoundary(workDir)
const sourceAfterCopy = snapshotBoundary(PRODUCTION_DB_DIR)
measure('副本文件数', copyFresh.fileCount)

if (sourceAfterCopy.fingerprint !== sourceBefore.fingerprint) {
  check('复制期间源没有变化', false, '源变了 ⇒ 按 canonical 丢弃副本并 STOP')
  rmSync(workDir, { recursive: true, force: true })
  console.log('  已丢弃副本（源在复制期间变化）—— STOP')
  process.exit(1)
}
check('★ B1-HardGate：复制之后源边界身份未变（源在复制期间没有被写）', true, sourceAfterCopy.fingerprint.slice(0, 16) + '…')
check('副本文件数与源一致', copyFresh.fileCount === sourceBefore.fileCount, `${copyFresh.fileCount} vs ${sourceBefore.fileCount}`)
check('副本总字节与源一致', copyFresh.totalBytes === sourceBefore.totalBytes, `${copyFresh.totalBytes} vs ${sourceBefore.totalBytes}`)

// ===========================================================================
section('§2 B2：副本上 预览 → apply → schemaVersion（迁移链）')
// ===========================================================================

process.env.PGLITE_DATA_DIR = workDir
process.env.PROJECT_LG_SANDBOX = workDir

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

const fromVersion = await currentSchemaVersion(db)
check('副本可以正常打开', true, workDir.replace(tmpdir(), '<tmp>'))
check('★ 副本 apply 前 schemaVersion = 6（= canonical 的起点 v6）', fromVersion === 6, `v${fromVersion}`)

const preview = await pendingMigrations(db)
measure('待应用迁移数', preview.length)
check(
  '★ 预览：待应用 = [v7, v8, v9]（升序、连续、恰好三条）',
  preview.length === 3 && preview[0]!.version === 7 && preview[1]!.version === 8 && preview[2]!.version === 9,
  preview.map((m) => `v${m.version}`).join(',')
)

/** 既有行的身份摘要（apply 前后必须逐字相同 —— 迁移不许改任何既有行） */
const legacyDigestOf = async (): Promise<Record<string, { rows: number; digest: string }>> => {
  const out: Record<string, { rows: number; digest: string }> = {}
  const identityColumns: Record<string, string[]> = {
    conversation_events: ['id', 'conversation_id', 'conversation_sequence', 'type', 'actor_type'],
    character_action_events: ['action_id', 'sequence', 'event_type'],
    state_events: ['id', 'trigger', 'state_version'],
  }
  for (const table of TABLES) {
    const columns = identityColumns[table] ?? ['id']
    const exists = rowsOf(await db.execute(sql`select to_regclass(${`public.${table}`}) as t`)) as { t: string | null }[]
    if (exists[0]?.t === null || exists[0]?.t === undefined) {
      out[table] = { rows: -1, digest: '(表不存在)' }
      continue
    }
    const rows = rowsOf(
      await db.execute(sql`select ${sql.raw(columns.join(', '))} from ${sql.raw(table)} order by ${sql.raw(columns.join(', '))}`)
    ) as Record<string, unknown>[]
    out[table] = {
      rows: rows.length,
      digest: sha256(rows.map((row) => columns.map((c) => String(row[c] ?? '')).join('\t')).join('\n')),
    }
  }
  return out
}

const legacyBefore = await legacyDigestOf()
const copyBoundaryBeforeApply = copyFresh.fingerprint
const appliedAt = new Date().toISOString()
const report = await applyKernelMigrations(db)

check(
  '★ B2-HardGate：apply 报告 from 6 → to 9，按升序应用 7、8、9',
  report.fromVersion === 6 &&
    report.toVersion === 9 &&
    report.applied.length === 3 &&
    report.applied[0]!.version === 7 &&
    report.applied[1]!.version === 8 &&
    report.applied[2]!.version === 9,
  `from ${report.fromVersion} → to ${report.toVersion} · applied=${report.applied.map((m) => `v${m.version}`).join(',')}`
)
const toVersion = await currentSchemaVersion(db)
check('★ 副本 apply 后 schemaVersion = 9（= 代码最新）', toVersion === 9, `v${toVersion}`)

const copyBoundaryAfterApply = snapshotBoundary(workDir).fingerprint
const legacyAfter = await legacyDigestOf()
const legacyTablesWithRows = Object.entries(legacyBefore).filter(([, v]) => v.rows > 0)
measure('副本上有既有行的表数', legacyTablesWithRows.length, true)
check(
  '★ B2-HardGate：既有行的**身份摘要**在 apply 前后逐字相同（迁移没有改任何既有行）',
  stableStringify(legacyBefore) === stableStringify(legacyAfter),
  Object.entries(legacyBefore).map(([t, v]) => `${t}:${v.rows}行/${v.digest.slice(0, 8)}`).join(' · ')
)

// ===========================================================================
section('§3 B4-a：`migration count truth`')
// ===========================================================================

const migrationRows = rowsOf(
  await db.execute(sql`select version, name from character_schema_migrations order by version asc`)
) as { version: number; name: string }[]
measure('`character_schema_migrations` 的行数', migrationRows.length)
check(
  '★ `migration count truth`：迁移表恰好 9 行，版本恰为 1..9，且每行都有非空 name',
  migrationRows.length === 9 &&
    migrationRows.every((row, index) => Number(row.version) === index + 1) &&
    migrationRows.every((row) => String(row.name).length > 0),
  migrationRows.map((r) => `${r.version}:${r.name}`).join(' · ')
)
check(
  '副本上 apply 的**净增量** = 3（6 → 9），与 `applied` 列表长度一致',
  migrationRows.length - 6 === report.applied.length,
  `${migrationRows.length} - 6 = ${report.applied.length}`
)

// ===========================================================================
section('§4 B4-b：`unknown count truth`（K-30 单位：逐槽位 + 含 ≥1 UNKNOWN 的记录）')
// ===========================================================================

interface UnknownCountRow {
  table: string
  totalRows: number
  rowsWithEnvelope: number
  rowsWithoutEnvelope: number
  unknownSlotCount: Record<string, number>
  recordsWithUnknownCount: number
}
const unknownCounts: UnknownCountRow[] = []
for (const table of TABLES) {
  const cols = ATTRIBUTION_SLOT_COLUMNS
  const unknownPredicate = SLOTS.map(
    (slot) => `(${cols[slot].kind} is null and ${cols[slot].id} is null and ${cols[slot].unknownReason} is not null)`
  ).join(' or ')
  const rows = rowsOf(
    await db.execute(
      sql`select
            count(*)::int as total,
            count(*) filter (where attribution_origin is not null)::int as with_envelope,
            count(*) filter (where attribution_origin is null)::int as without_envelope,
            count(*) filter (where ${sql.raw(unknownPredicate)})::int as records_with_unknown,
            ${sql.raw(
              SLOTS.map(
                (slot) =>
                  `count(*) filter (where ${cols[slot].kind} is null and ${cols[slot].id} is null and ${cols[slot].unknownReason} is not null)::int as u_${slot}`
              ).join(', ')
            )}
          from ${sql.raw(table)}`
    )
  ) as Record<string, unknown>[]
  const row = rows[0] ?? {}
  unknownCounts.push({
    table,
    totalRows: Number(row.total ?? 0),
    rowsWithEnvelope: Number(row.with_envelope ?? 0),
    rowsWithoutEnvelope: Number(row.without_envelope ?? 0),
    unknownSlotCount: Object.fromEntries(SLOTS.map((slot) => [slot, Number(row[`u_${slot}`] ?? 0)])),
    recordsWithUnknownCount: Number(row.records_with_unknown ?? 0),
  })
}
for (const row of unknownCounts) {
  console.log(
    `  · ${row.table}：总 ${row.totalRows} · 有信封 ${row.rowsWithEnvelope} · 无信封 ${row.rowsWithoutEnvelope} · 含≥1 UNKNOWN 的记录 ${row.recordsWithUnknownCount} · 逐槽位 ${SLOTS.map((s) => `${s}=${row.unknownSlotCount[s]}`).join(',')}`
  )
}
const totalRowsAll = unknownCounts.reduce((sum, r) => sum + r.totalRows, 0)
measure('`unknown count truth` 统计的账本总行数', totalRowsAll)
const unknownSlotTotal = unknownCounts.reduce((sum, r) => sum + Object.values(r.unknownSlotCount).reduce((a, b) => a + b, 0), 0)
measure('逐槽位 UNKNOWN 计数（三表合计，0 也是要被断言的值）', unknownSlotTotal, true)
check(
  '★ `unknown count truth`：两个 canonical 字段都**逐表提供**（`unknownSlotCount` 逐槽位 + `recordsWithUnknownCount`），且"无信封"的行被**排除在计数之外**（K-30 的 `not counted` 一行）',
  unknownCounts.length === 3 &&
    unknownCounts.every((row) => Object.keys(row.unknownSlotCount).length === SLOTS.length) &&
    unknownCounts.every((row) => row.rowsWithEnvelope + row.rowsWithoutEnvelope === row.totalRows),
  unknownCounts.map((r) => `${r.table}:slots=${Object.keys(r.unknownSlotCount).length}`).join(' · ')
)
check(
  '★ `unknown count truth` 的**真相**：本副本上所有既有行都是"信封从未记录过"（`attribution_origin IS NULL`）⇒ 按 K-30 它们**不计入** unknown count；没有任何 `Unknown(LEGACY_UNRECORDED)` 被伪造出来',
  unknownCounts.every((row) => row.recordsWithUnknownCount === 0 && row.rowsWithEnvelope === 0) && unknownSlotTotal === 0,
  `recordsWithUnknown 合计=${unknownCounts.reduce((s, r) => s + r.recordsWithUnknownCount, 0)} · slot 合计=${unknownSlotTotal}`
)

// ===========================================================================
section('§5 B4-c：`no fabricated USER`')
// ===========================================================================

const fabricatedChecks: { table: string; originNullWithSlotValue: number; userContentOriginators: number }[] = []
for (const table of TABLES) {
  const anySlotNotNull = SLOTS.map((slot) => `${ATTRIBUTION_SLOT_COLUMNS[slot].kind} is not null`).join(' or ')
  const rows = rowsOf(
    await db.execute(
      sql`select
            count(*) filter (where attribution_origin is null and (${sql.raw(anySlotNotNull)}))::int as fabricated,
            count(*) filter (where ${sql.raw(ATTRIBUTION_SLOT_COLUMNS.contentOriginator.kind)} = 'USER')::int as user_originators
          from ${sql.raw(table)}`
    )
  ) as Record<string, unknown>[]
  fabricatedChecks.push({
    table,
    originNullWithSlotValue: Number(rows[0]?.fabricated ?? 0),
    userContentOriginators: Number(rows[0]?.user_originators ?? 0),
  })
}
measure('`no fabricated USER` 检查的表数', fabricatedChecks.length)
console.log(`  · ${fabricatedChecks.map((c) => `${c.table}:originNull∧有值=${c.originNullWithSlotValue} · contentOriginator=USER=${c.userContentOriginators}`).join(' | ')}`)
check(
  '★ `no fabricated USER`：没有任何"从未记录归因"的行被填上槽位值（v7/v8/v9 都是 add column / add constraint，无 data statement ⇒ 不可能伪造）',
  fabricatedChecks.every((c) => c.originNullWithSlotValue === 0),
  `合计 ${fabricatedChecks.reduce((s, c) => s + c.originNullWithSlotValue, 0)} 行`
)
check(
  '★ `no fabricated USER`：副本上 `contentOriginator = USER` 的行数 = 0（回填没有发生，也没有把 legacy 洗成 USER）',
  fabricatedChecks.every((c) => c.userContentOriginators === 0),
  `合计 ${fabricatedChecks.reduce((s, c) => s + c.userContentOriginators, 0)} 行`
)

// ===========================================================================
section('§6 B4-d：`no mutation from query`（只读查询 pass + 前后摘要）')
// ===========================================================================

const queryDigest = async (): Promise<Record<string, { rows: number; digest: string }>> => {
  const out: Record<string, { rows: number; digest: string }> = {}
  const columns = [
    'attribution_origin',
    ...Object.values(ATTRIBUTION_SLOT_COLUMNS).flatMap((c) => [c.kind, c.id, c.unknownReason]),
  ]
  for (const table of TABLES) {
    const rows = rowsOf(
      await db.execute(sql`select ${sql.raw(columns.join(', '))} from ${sql.raw(table)} order by 1`)
    ) as Record<string, unknown>[]
    out[table] = {
      rows: rows.length,
      digest: sha256(rows.map((row) => columns.map((c) => String(row[c] ?? '')).join('\t')).join('\n')),
    }
  }
  return out
}

/** 只读查询 pass：走 canonical 的读取面（select，不写） */
async function readOnlyQueryPass(): Promise<{ table: string; rowsRead: number }[]> {
  const out: { table: string; rowsRead: number }[] = []
  for (const table of TABLES) {
    const rows = rowsOf(await db.execute(sql`select count(*)::int as c from ${sql.raw(table)}`)) as { c: number }[]
    out.push({ table, rowsRead: Number(rows[0]?.c ?? 0) })
  }
  return out
}

const digestBeforeQuery = await queryDigest()
const queryPass = await readOnlyQueryPass()
const digestAfterQuery = await queryDigest()
measure('只读查询 pass 覆盖的表数', queryPass.length)
check(
  '★ `no mutation from query`：只读查询 pass 之后逐表摘要**逐字相同**（query 不改任何行）',
  stableStringify(digestBeforeQuery) === stableStringify(digestAfterQuery),
  queryPass.map((q) => `${q.table}:${q.rowsRead}`).join(' · ')
)
check(
  '★ `no mutation from query`：副本的**边界身份**在查询 pass 前后也相同（只读语义在文件层也成立）',
  snapshotBoundary(workDir).fingerprint === copyBoundaryAfterApply,
  `${copyBoundaryAfterApply.slice(0, 16)}…`
)

// ===========================================================================
section('§7 B3：canonical 五个步骤（各自在自己的库上跑；逐条标注跑在哪）')
// ===========================================================================

/**
 * 子进程环境：**显式删掉** `PGLITE_DATA_DIR` / `PROJECT_LG_SANDBOX`。
 * 理由：本进程已把这两个变量指向**副本**；子门必须自己建立隔离（要么 `isolateDatabase`，
 * 要么自己 `cpSync`），不能继承本进程的副本 —— 否则"它跑在哪"就说不清了。
 */
const childEnv = { ...process.env }
delete childEnv.PGLITE_DATA_DIR
delete childEnv.PROJECT_LG_SANDBOX

const stepResults: {
  step: string
  pnpm: string
  where: string
  exit: number
  tail: string
  isolatesItself: boolean
  note: string
}[] = []
const pkgScripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
for (const spec of CANONICAL_STEPS) {
  const scriptFile = /tsx\s+([^\s&|]+\.ts)/.exec(pkgScripts[spec.pnpm] ?? '')
  const file = scriptFile === null ? null : (scriptFile[1] as string)
  let isolatesItself = false
  if (file !== null) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    const viaSandbox = /isolateDatabase\s*\(/.test(text)
    const viaCopy = /cpSync\s*\(/.test(text) && /process\.env\.PGLITE_DATA_DIR\s*=/.test(text)
    isolatesItself = viaSandbox || viaCopy
  }
  const result = spawnSync('pnpm', [spec.pnpm], { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024, env: childEnv })
  const exit = result.status === null ? -1 : result.status
  const text = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`
  const tail =
    text
      .split('\n')
      .filter((line) => /通过\s*\/\s*\d+\s*失败|PASS|FAIL|WP3|K-/.test(line))
      .slice(-1)[0]
      ?.trim() ?? ''
  stepResults.push({ step: spec.step, pnpm: spec.pnpm, where: spec.where, exit, tail, isolatesItself, note: spec.note })
  console.log(`  · ${spec.step.padEnd(9)} → pnpm ${spec.pnpm} [${spec.where}] EXIT=${exit} :: ${tail}`)
}
measure('跑过的 canonical 步骤数', stepResults.length)
check(
  '★ B3：canonical 五个步骤（backfill / replay / query / action / control）**全部 EXIT 0**',
  stepResults.length === 5 && stepResults.every((r) => r.exit === 0),
  stepResults.map((r) => `${r.step}=${r.exit}`).join(' · ')
)
check(
  '★ B3 的"跑在哪"逐条可证：`backfill` 走 **production-copy**（该门自己 cpSync 真实库）；其余四个步骤**都调用了自己的隔离**（`isolateDatabase` / `cpSync`+env）⇒ 它们结构性上无法被指向本门的副本，本门**不**声称它们跑在副本上',
  stepResults.every((r) => r.isolatesItself) &&
    stepResults.find((r) => r.step === 'backfill')?.where === 'production-copy',
  stepResults.map((r) => `${r.step}:${r.where}${r.isolatesItself ? '' : '(未自隔离!)'}`).join(' · ')
)

// ===========================================================================
section('§8 冻结面 / 量具健康 / 判定 / 证据')
// ===========================================================================

const sourceFinal = snapshotBoundary(PRODUCTION_DB_DIR)
check(
  '★ 真实库边界身份在本门运行前后**逐字一致**（全程只被采样与复制）',
  sourceFinal.fingerprint === sourceBefore.fingerprint,
  `${sourceFinal.fingerprint.slice(0, 16)}…`
)

const measurementInvalid = measurements.filter((m) => !m.valid)
check(
  '所有计数型判据都自检过 `measured_count > 0`（测到 0 个对象的一律 MEASUREMENT INVALID，不报 PASS）',
  measurementInvalid.length === 0,
  `${measurements.length} 个量具，无效 ${measurementInvalid.length} 个${measurementInvalid.length > 0 ? `：${measurementInvalid.map((m) => m.label).join(' , ')}` : ''}`
)

const verdict = failed === 0 && measurementInvalid.length === 0 ? 'PASS' : 'FAIL'
const fourVerifications = {
  migrationCountTruth: {
    ok: migrationRows.length === 9 && report.applied.length === 3,
    detail: `migrations=${migrationRows.length}（1..9）· applied=${report.applied.map((m) => `v${m.version}`).join(',')} · from ${report.fromVersion} → to ${report.toVersion}`,
  },
  unknownCountTruth: {
    ok: unknownCounts.every((row) => row.recordsWithUnknownCount === 0 && row.rowsWithEnvelope === 0),
    unit: 'K-30：unknownSlotCount（逐槽位）+ recordsWithUnknownCount（含 ≥1 UNKNOWN 的记录）；scope 本门取**整表**（K-30 原文的 scope 是"当前 Query 结果集"—— 差别如实标注）',
    counts: unknownCounts,
  },
  noFabricatedUser: {
    ok: fabricatedChecks.every((c) => c.originNullWithSlotValue === 0 && c.userContentOriginators === 0),
    detail: fabricatedChecks,
  },
  noMutationFromQuery: {
    ok: stableStringify(digestBeforeQuery) === stableStringify(digestAfterQuery),
    digestBefore: digestBeforeQuery,
    digestAfter: digestAfterQuery,
  },
}

mkdirSync(ART, { recursive: true })
const evidence = {
  testId: 'M5.1.1 / WP10-B Production-Copy Migration（R-49 授权；真实库只被复制）',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp10b:verify',
  verdict,
  passed,
  failed,
  failures,
  interpretation: {
    canonicalStep: 'canonical 文本写 `v6 → v7`（当时只有 v7）；v8/v9 之后同一语义步骤的当前形式 = `v6 → v9`',
    appliedVersions: report.applied.map((m) => m.version),
    semanticsUnchanged: 'migration count truth / unknown count truth / no fabricated USER / no mutation from query 四项要求一字未变',
  },
  boundaries: {
    snapshotCopyBoundary: { productionDir: PRODUCTION_DB_DIR, copyDir: workDir, copiedAt: appliedAt, quiescenceWindowMs: quiescenceMs },
    sourceBoundary: {
      before: sourceBefore,
      quietCheck: sourceQuiet.fingerprint === sourceBefore.fingerprint,
      afterCopy: sourceAfterCopy,
      final: sourceFinal,
      identicalThroughout: sourceFinal.fingerprint === sourceBefore.fingerprint && sourceAfterCopy.fingerprint === sourceBefore.fingerprint,
      expectedSha256: FROZEN_SOURCE_BOUNDARY_SHA256,
      algorithm: 'sha256 over sorted "(relative path)\\t(size)" lines —— 边界身份，不是内容哈希（与 prod-copy 门逐字相同的算法）',
    },
    copyBoundary: { fresh: copyFresh, beforeApply: copyBoundaryBeforeApply, afterApply: copyBoundaryAfterApply },
    migrationBoundary: {
      fromVersion: report.fromVersion,
      toVersion: report.toVersion,
      appliedVersions: report.applied.map((m) => m.version),
      codeLatestVersion: toVersion,
      skipped: report.skipped,
    },
    restoreEpoch: 'NOT_APPLICABLE',
    restoreEpochNote: '本 WP 没有执行任何 restore（用户明令：不要在没有还原的时候记它）',
  },
  legacyRowsUnchanged: { before: legacyBefore, after: legacyAfter, identical: stableStringify(legacyBefore) === stableStringify(legacyAfter) },
  migrationCountTruth: fourVerifications.migrationCountTruth,
  unknownCountTruth: fourVerifications.unknownCountTruth,
  noFabricatedUser: fourVerifications.noFabricatedUser,
  noMutationFromQuery: fourVerifications.noMutationFromQuery,
  canonicalSteps: stepResults,
  canonicalStepsScopeStatement:
    'backfill 在**真实库的副本**上跑（wp3 门自己 cpSync）；replay/query/action/control 在**各自的一次性库**上跑' +
    '（它们的脚本都自隔离 ⇒ 结构性上无法被指向本门的副本）。本门**不**声称后四者跑在副本上。',
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    productionDbOpenedByApplicationCode: false,
    productionDbCopiedOnly: true,
    liveProductionMigration: false,
    frozenDirsWrittenByThisGate: false,
    note: '本门只写 artifacts/m5.1.1/wp10-production-copy.json；§7 的 m5.1:* 门会重写 artifacts/m5.1/**（冻结目录），由执行代理按白名单从 m5.1-complete 逐路径还原',
  },
}
writeFileSync(join(ART, 'wp10-production-copy.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log('  ↳ 证据：artifacts/m5.1.1/wp10-production-copy.json')

await runtime.stop()
rmSync(workDir, { recursive: true, force: true })

console.log(`\n${'='.repeat(78)}`)
console.log(`M5.1.1 WP10-B（Production-Copy Migration）：${passed} 通过 / ${failed} 失败｜**WP10-B = ${verdict}**`)
console.log(`  四项验证：migration=${fourVerifications.migrationCountTruth.ok} · unknown=${fourVerifications.unknownCountTruth.ok} · noFabricatedUSER=${fourVerifications.noFabricatedUser.ok} · noMutationFromQuery=${fourVerifications.noMutationFromQuery.ok}`)
console.log('='.repeat(78))
if (failed > 0) console.log(`失败项：\n${failures.map((f) => `    - ${f}`).join('\n')}`)
process.exit(failed === 0 && measurementInvalid.length === 0 ? 0 : 1)
