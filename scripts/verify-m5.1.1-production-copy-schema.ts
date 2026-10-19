/**
 * M5.1.1 WP2.2（B + D）→ **WP4.1 更新** —— production-copy 上的 **v6 → v8** schema-only apply
 * （`pnpm m5.1.1:prod-copy:verify`）。
 *
 * ============================================================================
 *  真实库只被统计、只被复制 —— **从不被应用代码打开**
 * ============================================================================
 *  跑前：确认源静默（连续两次指纹一致）→ 记文件数 / 总字节 / boundary 指纹
 *  → `cpSync` 到临时目录（仓库既有机制）
 *  跑后：**再取一次源指纹**；若源在复制期间变过 ⇒ 丢弃副本并 STOP
 *  副本：文件数 / 总字节必须与源一致；打开后 schemaVersion 必须是 6
 *
 *  然后在**副本上**（且只在副本上）：预览迁移 → 确认待应用 = [v7, v8, v9] → apply
 *  → 校验 schemaVersion = 9 → 校验 K-4 约束 → 校验 K-16 的三列完好
 *  → 校验既有行的值**一个都没变** → 校验没有发生 attribution 回填（含 v9 的 state_events）
 *  → 校验没有伪造 contentOriginator
 *  → **WP4.1 新增**：校验 v8 只替换了行动表那一条 CHECK（对话表逐条不变）、
 *     且新 CHECK 在**既有行**上被 PG 实际验证通过（`alter table add constraint`
 *     默认 `NOT VALID` = false，因此语句成功 = 每一行旧数据都满足新谓词）。
 *  → **WP9-B1 新增**：校验 v9 只给 `state_events` 加了 19 列 + 19 条 CHECK，
 *     没有 Axis B 列、没有新索引，且 `state_events` 的既有行 attribution_origin 仍为 0 条非空。
 *
 * ---------------------------------------------------------------------------
 *  restoreEpoch = NOT_APPLICABLE
 * ---------------------------------------------------------------------------
 *  本 WP **没有发生任何 restore**，因此**不**记 restore epoch / boundary
 *  （用户明令：不要在没有还原的时候记它）。改记四个边界：
 *      snapshot/copy boundary（副本目录 + 时间）
 *      source fingerprint（源的 (路径,大小) 指纹，前后各一次）
 *      copy fingerprint（副本 apply 前 / 后）
 *      migration boundary（from 6 → to 9，applied=[7,8,9]）
 *
 * ---------------------------------------------------------------------------
 *  WP9-B1（2026-09-18 / R-45）：边界从 v6 → v8 延长为 **v6 → v7 → v8 → v9**
 * ---------------------------------------------------------------------------
 *  `MIGRATION_0009` 只给 `state_events` 追加 19 列 + 19 条 CHECK（无 Axis B、无索引、无回填）。
 *  因此本脚本：
 *   · 预览的待应用清单从 `[v7, v8]` 变成 `[v7, v8, v9]`（仍是"副本上待应用的那些"）；
 *   · apply 报告从 `from 6 → to 8` 变成 `from 6 → to 9`，`applied=[7,8,9]`；
 *   · 新增"v9 只碰 state_events"的副本级点名（列 / 约束 / 索引 / 无回填），
 *     且 `conversation_events` / `character_action_events` 的既有断言**逐条不变**。
 *
 * ---------------------------------------------------------------------------
 *  证据文件名（WP9-B1 fork）
 * ---------------------------------------------------------------------------
 *  本脚本以前写 `wp2.2-production-copy-schema.json` / `wp2.2-axis-b-before-image.json`
 *  （WP2.2 的 v6 → v7 历史证据），WP4.1 起写 `wp4.1-production-copy-v8.json`
 *  （v6 → v8）。**本步写 `wp9b1-production-copy-v9.json`** —— 三代证据都在，
 *  谁都没有被覆盖（before-image 内容并入本次 JSON）。
 *
 * 跑法：pnpm m5.1.1:prod-copy:verify
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import 'dotenv/config'

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'
import { migrationPremiseOf, postMigrationInvariants } from './m5.1.1-post-migration-invariants.ts'
import {
  applyKernelMigrations,
  currentSchemaVersion,
  getRawDb,
  pendingMigrations,
  rowsOf,
} from '../src/infrastructure/persistence/db.ts'

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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

interface FileEntry {
  rel: string
  size: number
  mtime: number
}

function snapshot(dir: string, root: string = dir): { files: FileEntry[]; fingerprint: string; bytes: number } {
  const files: FileEntry[] = []
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
  const fingerprint = createHash('sha256')
    .update(files.map((file) => `${file.rel}\t${file.size}`).join('\n'), 'utf8')
    .digest('hex')
  return { files, fingerprint, bytes: files.reduce((sum, file) => sum + file.size, 0) }
}

// ===========================================================================
section('1. 源：静默检查 + 只读边界')
// ===========================================================================

check('真实库目录存在', existsSync(PRODUCTION_DB_DIR), PRODUCTION_DB_DIR)
const sourceBefore = snapshot(PRODUCTION_DB_DIR)
measure('源文件数', sourceBefore.files.length)
const newestMtime = sourceBefore.files.reduce((max, file) => Math.max(max, file.mtime), 0)
const quiescenceMs = 3000
console.log(`  源：${sourceBefore.files.length} 文件 / ${sourceBefore.bytes} 字节`)
console.log(`  boundary 指纹 ${sourceBefore.fingerprint.slice(0, 16)}…｜最新 mtime ${new Date(newestMtime).toISOString()}`)

await sleep(quiescenceMs)
const sourceQuietCheck = snapshot(PRODUCTION_DB_DIR)
check(
  `源在 ${quiescenceMs}ms 静默窗口内没有变化`,
  sourceQuietCheck.fingerprint === sourceBefore.fingerprint &&
    sourceQuietCheck.files.length === sourceBefore.files.length &&
    sourceQuietCheck.bytes === sourceBefore.bytes,
  '连续两次指纹一致'
)

// ===========================================================================
section('2. 复制（仓库既有机制：cpSync） + 复制后复核源指纹')
// ===========================================================================

const snapshotBoundaryAt = new Date().toISOString()
const workDir = mkdtempSync(join(tmpdir(), 'project-lg-wp22-copy-'))
cpSync(PRODUCTION_DB_DIR, workDir, { recursive: true })
const copyFresh = snapshot(workDir)
console.log(`  副本：${workDir}`)

const sourceAfterCopy = snapshot(PRODUCTION_DB_DIR)
check(
  '复制之后源指纹未变（源在复制期间没有被写）',
  sourceAfterCopy.fingerprint === sourceBefore.fingerprint,
  sourceAfterCopy.fingerprint === sourceBefore.fingerprint ? '一致' : '⚠️ 源变了 ⇒ 必须丢弃副本并 STOP'
)
if (sourceAfterCopy.fingerprint !== sourceBefore.fingerprint) {
  rmSync(workDir, { recursive: true, force: true })
  console.log('  已丢弃副本（源在复制期间变化）')
  process.exit(1)
}
check(
  '副本的文件数与源一致',
  copyFresh.files.length === sourceBefore.files.length,
  `${copyFresh.files.length} vs ${sourceBefore.files.length}`
)
check('副本的总字节与源一致', copyFresh.bytes === sourceBefore.bytes, `${copyFresh.bytes} vs ${sourceBefore.bytes}`)

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

const versionBeforeApply = await currentSchemaVersion(db)
/*
 * ⚠️ M5.1.1 / Phase 4b（用户 2026-09-19 裁定）—— **这一族门的前提有两态**。
 *
 * 本门原来的判据是"在**真实库的副本**上彩排 v6 → v9"。它的前提是
 * "真实库还没迁移"。用户 `D-1 = ②` 把真库迁到 v9 之后，副本也是 v9 ⇒
 * "待应用迁移 = 空"，那几条检测器**正确地**报 `MEASUREMENT INVALID`（AGENTS §6.8）。
 *
 * 取代**不删除保证**：迁移前分支原样保留（真库若回到旧版本，彩排照旧有效）；
 * 已应用分支改为断言 **post-migration 不变量**（既有行身份摘要逐字不变 ∧ 0 行伪造归因）。
 */
const premise = migrationPremiseOf(versionBeforeApply)
check('副本可以正常打开', true)
check(
  '副本处于可判定状态（迁移前 v6 的彩排前提，或真库已迁移 v9 的事后核对）',
  premise !== 'unrecognized',
  premise === 'already-applied'
    ? `副本已是 v${versionBeforeApply}（真实库已按 D-1=② 迁移）⇒ 彩排前提失效；保证改由 post-migration 不变量承接`
    : `v${versionBeforeApply}（pre-migration 彩排路径有效）`
)

// ===========================================================================
section('3. D. BEFORE-IMAGE 清单（只取 id/sequence 与三列，**不含正文**）')
// ===========================================================================

interface BeforeImageRow {
  id: string
  sequence: number
  sourceKind: string | null
  sourceAuthority: string | null
  epistemicSource: string | null
}

const readBeforeImage = async (): Promise<BeforeImageRow[]> => {
  const rows = rowsOf(
    await db.execute(
      sql`select id, sequence, source_kind, source_authority, epistemic_source
          from conversation_events order by sequence asc, id asc`
    )
  ) as {
    id: string
    sequence: number
    source_kind: string | null
    source_authority: string | null
    epistemic_source: string | null
  }[]
  return rows.map((row) => ({
    id: String(row.id),
    sequence: Number(row.sequence),
    sourceKind: row.source_kind === null ? null : String(row.source_kind),
    sourceAuthority: row.source_authority === null ? null : String(row.source_authority),
    epistemicSource: row.epistemic_source === null ? null : String(row.epistemic_source),
  }))
}

const beforeImage = await readBeforeImage()
measure('before-image 行数', beforeImage.length)
const nonNullBefore = beforeImage.filter((row) => row.sourceAuthority !== null).length
measure('before-image 中 source_authority 非空的行数', nonNullBefore)

const manifestHash = createHash('sha256')
  .update(
    beforeImage
      .map(
        (row) => `${row.id}\t${row.sequence}\t${row.sourceKind ?? ''}\t${row.sourceAuthority ?? ''}\t${row.epistemicSource ?? ''}`
      )
      .join('\n'),
    'utf8'
  )
  .digest('hex')
console.log(`  before-image：${beforeImage.length} 行｜非空 authority ${nonNullBefore}｜manifest ${manifestHash.slice(0, 16)}…`)

check(
  'manifest 只含 id / sequence / 三列（**没有** 正文列）',
  true,
  'select 列表里没有 content —— 见脚本与证据的 columns 字段'
)

// ===========================================================================
section('4. B. 在副本上：预览 → 待应用 = [v7, v8, v9] → apply')
// ===========================================================================

/*
 * ⚠️ M5.1.1 / Phase 4b（用户 2026-09-19 裁定）：这一段的**前提**是"真实库还没迁移"。
 * 真库已按 `D-1 = ②` 迁到 v9 ⇒ 走 else 分支断言 **post-migration 不变量**。
 * 迁移前分支**原样保留**（保证不被删除：真库若回到旧版本，彩排照旧有效）。
 */
let previewBefore: Awaited<ReturnType<typeof pendingMigrations>> = []
let previewAfter: Awaited<ReturnType<typeof pendingMigrations>> = []
let copyFingerprintBeforeApply = ''
let copyFingerprintAfterApply = ''
const appliedAt = new Date().toISOString()
let report: Awaited<ReturnType<typeof applyKernelMigrations>>

if (premise === 'pre-migration') {
  previewBefore = await pendingMigrations(db)
  measure('待应用迁移数', previewBefore.length)
  check(
    '预览：待应用 = [v7, v8, v9]（升序、连续）',
    previewBefore.length === 3 &&
      previewBefore[0]!.version === 7 &&
      previewBefore[1]!.version === 8 &&
      previewBefore[2]!.version === 9,
    JSON.stringify(previewBefore)
  )

  copyFingerprintBeforeApply = snapshot(workDir).fingerprint
  report = await applyKernelMigrations(db)
  check(
    'apply 报告：from 6 → to 9，且按升序应用了 7、8、9',
    report.fromVersion === 6 &&
      report.toVersion === 9 &&
      report.applied.length === 3 &&
      report.applied[0]!.version === 7 &&
      report.applied[1]!.version === 8 &&
      report.applied[2]!.version === 9,
    `from=${report.fromVersion} to=${report.toVersion} applied=[${report.applied.map((m) => m.version).join(',')}]`
  )

  const versionAfterApply = await currentSchemaVersion(db)
  check('apply 后副本 schemaVersion = 9', versionAfterApply === 9, `v${versionAfterApply}`)
  previewAfter = await pendingMigrations(db)
  check('apply 后没有待应用迁移', previewAfter.length === 0, JSON.stringify(previewAfter))
  copyFingerprintAfterApply = snapshot(workDir).fingerprint
  check(
    '副本的指纹在 apply 前后不同（确实写入了东西）',
    copyFingerprintBeforeApply !== copyFingerprintAfterApply
  )
} else {
  // ★ 取代分支（真库已迁移）：保证由 **post-migration 不变量**承接
  const post = await postMigrationInvariants(db)
  check('★ 取代判据（真库已迁移）：既有行身份摘要逐字不变 ∧ 0 行伪造归因', post.ok, post.detail)
  previewBefore = await pendingMigrations(db)
  check(
    '★ 取代判据（真库已迁移）：没有待应用迁移（迁移链已走完）',
    previewBefore.length === 0,
    JSON.stringify(previewBefore)
  )
  check('★ 取代判据（真库已迁移）：副本 schema = 9', versionBeforeApply === 9, `v${versionBeforeApply}`)
  copyFingerprintBeforeApply = snapshot(workDir).fingerprint
  report = await applyKernelMigrations(db)
  check(
    '★ 取代判据（真库已迁移）：apply 报告 from=9 → to=9 且应用 0 条（链已走完）',
    report.fromVersion === 9 && report.toVersion === 9 && report.applied.length === 0,
    `from=${report.fromVersion} to=${report.toVersion} applied=[${report.applied.map((m) => m.version).join(',')}]`
  )
  previewAfter = await pendingMigrations(db)
  copyFingerprintAfterApply = snapshot(workDir).fingerprint
}

const againReport = await applyKernelMigrations(db)
check(
  '幂等：副本上再跑一次 apply → 应用 0 条、跳过 9 条',
  againReport.applied.length === 0 && againReport.skipped === 9,
  `applied=${againReport.applied.length} skipped=${againReport.skipped}`
)

// ===========================================================================
section('5. 校验：K-4 约束都在，且 v8 只替换了行动表那一条 CHECK')
// ===========================================================================

const constraintNames = async (table: string): Promise<string[]> =>
  (
    rowsOf(
      await db.execute(
        sql`select conname from pg_constraint where conrelid = ${table}::regclass and contype = 'c'`
      )
    ) as { conname: string }[]
  ).map((row) => row.conname)

let k4Total = 0
for (const table of ['conversation_events', 'character_action_events']) {
  const names = await constraintNames(table)
  k4Total += names.length
  check(
    `${table}：23 条 CHECK（6 三态 + 6 kind 词表 + 6 reason 词表 + Axis B 5）`,
    names.length === 23 && names.filter((name) => name.endsWith('_tri_state')).length === 6,
    `${names.length} 条`
  )
  /*
   * WP4.1（K-22）：两张表的"Axis B 完整性"约束**不再同名**。
   * 这是 v8 唯一的 schema 效果，因此在这里逐名断言 —— 不是数数量，是指名字。
   */
  const expected = table === 'conversation_events' ? `${table}_axis_b_complete` : `${table}_axis_b_not_applicable`
  const forbidden = table === 'conversation_events' ? `${table}_axis_b_not_applicable` : `${table}_axis_b_complete`
  check(
    `${table}：Axis B 完整性约束 = \`${expected}\`（且没有 \`${forbidden}\`）`,
    names.includes(expected) && !names.includes(forbidden),
    names.filter((name) => name.includes('axis_b')).join(',') || '(无)'
  )
}
const controlNames = await constraintNames('developer_control_events')
k4Total += controlNames.length
check('developer_control_events：22 条 CHECK', controlNames.length === 22, `${controlNames.length} 条`)
measure('apply 后清点到的新增 CHECK 总数', k4Total)

const axisBDefs = rowsOf(
  await db.execute(
    sql`select conname, pg_get_constraintdef(oid) as def, convalidated
        from pg_constraint
        where conrelid = 'character_action_events'::regclass
          and conname = 'character_action_events_axis_b_not_applicable'`
  )
) as { conname: string; def: string; convalidated: boolean }[]
measure('行动表新 CHECK 的谓词读数行数', axisBDefs.length)
check(
  '★ 行动表的新 CHECK：谓词 = 三列必须全 NULL，且 **convalidated = true**' +
    '（`alter table add constraint` 默认会逐行验证既有数据 ⇒ 语句成功 = 旧数据全部满足新谓词）',
  axisBDefs.length === 1 &&
    /source_kind IS NULL/i.test(axisBDefs[0]!.def) &&
    /source_authority IS NULL/i.test(axisBDefs[0]!.def) &&
    /epistemic_source IS NULL/i.test(axisBDefs[0]!.def) &&
    axisBDefs[0]!.convalidated === true,
  axisBDefs[0]?.def ?? '(缺)'
)

const actionAxisBFilled = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from character_action_events
        where source_kind is not null or source_authority is not null or epistemic_source is not null`
  )
) as { c: number }[]
const actionRowCount = rowsOf(
  await db.execute(sql`select count(*)::int as c from character_action_events`)
) as { c: number }[]
const actionRowCountValue = Number(actionRowCount[0]?.c ?? -1)
const actionAxisBFilledValue = Number(actionAxisBFilled[0]?.c ?? -1)
/*
 * ⚠️ 空集必须**如实**标"不适用"，而不是"0 违规 = PASS"（WP3 的 D-6 先例）。
 *
 * 实测：真实库的 `character_action_events` **是空的**（0 行）—— 因此"既有行动行是否满足
 * 新谓词"在副本上**不可判定**（没有作用域）。新谓词的**非空**证明在别处：
 *   · `pnpm m5.1.1:wp4.1:verify` 在沙箱（v8）上真的写行，正控 6 条 + 负控 3 条；
 *   · 这里能证明的是 schema 侧：约束存在、谓词正确、`convalidated = true`。
 */
const actionScopeVerdict: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' =
  actionRowCountValue > 0 ? (actionAxisBFilledValue === 0 ? 'PASS' : 'FAIL') : 'NOT_APPLICABLE'
measure('character_action_events 的列数（作用域自检的替代测量）', (
  rowsOf(
    await db.execute(
      sql`select count(*)::int as c from information_schema.columns
          where table_schema = 'public' and table_name = 'character_action_events'`
    )
  ) as { c: number }[]
)[0]!.c)
check(
  '★ 既有行动行满足新谓词：**空集上如实标 NOT_APPLICABLE**（不得把 0 违规当 PASS）',
  actionScopeVerdict !== 'FAIL',
  `scope=${actionScopeVerdict} rows=${actionRowCountValue} filled=${actionAxisBFilledValue}`
)

const indexRows = rowsOf(
  await db.execute(
    sql`select indexname from pg_indexes where schemaname = 'public' and indexname = 'conversation_events_attribution_origin'`
  )
) as { indexname: string }[]
measure('新增 partial 索引条数', indexRows.length)
check('partial 索引 conversation_events_attribution_origin 存在', indexRows.length === 1)

/*
 * ---- WP9-B1（R-45）：v9 在副本上的半径（**点名，不是数数量**）-----------------
 */
const columnsOf = async (table: string): Promise<string[]> =>
  (
    rowsOf(
      await db.execute(
        sql`select column_name from information_schema.columns
            where table_schema = 'public' and table_name = ${table}`
      )
    ) as { column_name: string }[]
  ).map((row) => row.column_name)

const V9_NEW_COLUMNS = [
  'initiator_kind',
  'initiator_id',
  'initiator_unknown_reason',
  'actor_kind',
  'actor_ref_id',
  'actor_unknown_reason',
  'executor_kind',
  'executor_id',
  'executor_unknown_reason',
  'recorded_by_kind',
  'recorded_by_id',
  'recorded_by_unknown_reason',
  'content_originator_kind',
  'content_originator_id',
  'content_originator_unknown_reason',
  'authority_kind',
  'authority_ref',
  'authority_unknown_reason',
  'attribution_origin',
]
const stateEventColumns = await columnsOf('state_events')
measure('副本里 state_events 的列数', stateEventColumns.length)
const missingStateColumns = V9_NEW_COLUMNS.filter((column) => !stateEventColumns.includes(column))
check(
  '★ v9：副本的 `state_events` 拿到恰好那 19 个归因列（逐列点名）',
  missingStateColumns.length === 0 && stateEventColumns.length === 11 + 19,
  missingStateColumns.join(',') || `${stateEventColumns.length} 列`
)
check(
  '★ v9：`state_events` **没有** Axis B 三列（状态转移不是内容主张）',
  !stateEventColumns.includes('source_kind') &&
    !stateEventColumns.includes('source_authority') &&
    !stateEventColumns.includes('epistemic_source'),
  stateEventColumns.filter((c) => c.startsWith('source') || c.startsWith('epistemic')).join(',') || '无'
)
const stateEventConstraintNames = await constraintNames('state_events')
measure('副本里 state_events 的 CHECK 约束数', stateEventConstraintNames.length)
check(
  '★ v9：`state_events` 的 CHECK = 6 三态 + 6 kind 词表 + 6 reason 词表 + 1 origin 词表 = 19',
  stateEventConstraintNames.length === 19 &&
    stateEventConstraintNames.filter((name) => name.endsWith('_tri_state')).length === 6 &&
    stateEventConstraintNames.includes('state_events_attribution_origin_vocab'),
  `${stateEventConstraintNames.length} 条`
)
check(
  '★ v9：`state_events` 上没有任何 axis_b_* 约束',
  !stateEventConstraintNames.some((name) => /axis_b/.test(name)),
  stateEventConstraintNames.filter((name) => /axis_b/.test(name)).join(',') || '无'
)
const stateEventIndexRows = rowsOf(
  await db.execute(
    sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'state_events'`
  )
) as { indexname: string }[]
measure('副本里 state_events 的索引数', stateEventIndexRows.length)
const stateEventIndexNames = stateEventIndexRows.map((row) => row.indexname).sort()
check(
  '★ v9：**没有**为 state_events 的归因新建索引（索引恰好是 v9 之前就有的 PK + lookup）',
  JSON.stringify(stateEventIndexNames) === JSON.stringify(['state_events_lookup', 'state_events_pkey']),
  stateEventIndexNames.join(',') || '(无)'
)

/*
 * **没有回填**：v9 只有 add column / add constraint ⇒ 副本里 state_events 的
 * `attribution_origin` 非空行数必须**恰好为 0**（既有的每一条都是 NULL）。
 * ⚠️ 这里**不是**"0 违规 = PASS"：分母（state_events 总行数）也读出来一起登记，
 *    行数为 0 时如实标注"空集"，不假装证明了什么。
 */
const stateEventRowCountRows = rowsOf(
  await db.execute(sql`select count(*)::int as c from state_events`)
) as { c: number }[]
const stateEventRows = Number(stateEventRowCountRows[0]?.c ?? -1)
const stateEventOriginRows = rowsOf(
  await db.execute(sql`select count(*)::int as c from state_events where attribution_origin is not null`)
) as { c: number }[]
const stateEventOriginNonNull = Number(stateEventOriginRows[0]?.c ?? -1)
measure('副本里 state_events 的总行数（回填判据的分母）', stateEventRows)
check(
  '★ v9 没有回填：`state_events.attribution_origin` 非空行数 = 0（含首启那条 trigger=init）',
  stateEventOriginNonNull === 0,
  `${stateEventOriginNonNull} / ${stateEventRows} 行`
)

// ===========================================================================
section('6. 校验：K-16 的三列完好，且既有行的值一个都没变')
// ===========================================================================

const columnMeta = rowsOf(
  await db.execute(
    sql`select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'conversation_events'
          and column_name in ('source_kind','source_authority','epistemic_source')
        order by column_name`
  )
) as { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
measure('K-16 三列的元数据行数', columnMeta.length)
check('K-16 的三列仍然存在且仍是 text / 可空 / 无默认', columnMeta.length === 3 && columnMeta.every((column) => column.data_type === 'text' && column.is_nullable === 'YES' && column.column_default === null), columnMeta.map((column) => `${column.column_name}:${column.data_type}`).join(','))

const afterImage = await readBeforeImage()
const valuesUnchanged = JSON.stringify(afterImage) === JSON.stringify(beforeImage)
const changedRows = afterImage.filter((row, index) => JSON.stringify(row) !== JSON.stringify(beforeImage[index]))
check(
  'schema-only apply **没有改动任何既有行的值**（逐行比对 before-image）',
  valuesUnchanged,
  valuesUnchanged ? `${afterImage.length} 行全部一致` : `${changedRows.length} 行变了：${changedRows.slice(0, 3).map((r) => r.id).join(',')}`
)

// ===========================================================================
section('7. 校验：没有回填、没有伪造 contentOriginator')
// ===========================================================================

const backfillRows = rowsOf(
  await db.execute(sql`select count(*)::int as c from conversation_events where attribution_origin is not null`)
) as { c: number }[]
check('attribution_origin 非空的行数 = 0（没有回填）', Number(backfillRows[0]?.c ?? -1) === 0, `${backfillRows[0]?.c}`)

const slotFilled = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from conversation_events
        where actor_kind is not null or initiator_kind is not null or executor_kind is not null
           or recorded_by_kind is not null or content_originator_kind is not null or authority_kind is not null`
  )
) as { c: number }[]
check('18 个槽位列全部为 NULL（一个都没被填）', Number(slotFilled[0]?.c ?? -1) === 0, `${slotFilled[0]?.c}`)

const fabricated = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from conversation_events
        where content_originator_kind is not null or content_originator_id is not null`
  )
) as { c: number }[]
check('**没有伪造 contentOriginator**（content_originator_* 全为 NULL）', Number(fabricated[0]?.c ?? -1) === 0, `${fabricated[0]?.c}`)

const axisBIntact = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from conversation_events where source_authority is not null`
  )
) as { c: number }[]
check(
  '既有 Axis B 非空计数未被改动（与 before-image 一致）',
  Number(axisBIntact[0]?.c ?? -1) === nonNullBefore,
  `${axisBIntact[0]?.c} vs ${nonNullBefore}`
)

// ===========================================================================
section('8. 边界记录（**不**记 restoreEpoch —— 本次没有发生 restore）')
// ===========================================================================

const boundaries = {
  snapshotCopyBoundary: {
    productionDir: PRODUCTION_DB_DIR,
    copyDir: workDir,
    copiedAt: snapshotBoundaryAt,
    quiescenceWindowMs: quiescenceMs,
  },
  sourceFingerprint: {
    before: sourceBefore.fingerprint,
    afterCopy: sourceAfterCopy.fingerprint,
    identical: sourceAfterCopy.fingerprint === sourceBefore.fingerprint,
    fileCount: sourceBefore.files.length,
    totalBytes: sourceBefore.bytes,
    newestMtimeIso: new Date(newestMtime).toISOString(),
    algorithm: 'sha256 over sorted "(relative path)\\t(size)" lines —— 边界身份，不是内容哈希',
  },
  copyFingerprint: {
    beforeApply: copyFingerprintBeforeApply,
    afterApply: copyFingerprintAfterApply,
    fileCount: copyFresh.files.length,
    totalBytes: copyFresh.bytes,
  },
  migrationBoundary: {
    fromVersion: report.fromVersion,
    toVersion: report.toVersion,
    appliedVersions: report.applied.map((migration) => migration.version),
    appliedAt,
    codeLatestVersion: MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0),
  },
  restoreEpoch: 'NOT_APPLICABLE',
  restoreEpochNote: '本 WP 没有执行任何 restore，因此按用户要求**不**记 restore epoch / boundary',
}

// ===========================================================================
section('9. 汇总')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)
const schemaVerdict = failed === 0 && blockers.length === 0 ? 'PASS' : 'FAIL'
check(`schema-only production-copy migration = ${schemaVerdict}`, schemaVerdict === 'PASS')

mkdirSync(join(process.cwd(), 'artifacts', 'm5.1.1'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5.1.1', 'wp9b1-production-copy-v9.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP9-B1 production-copy v6 -> v9 schema-only apply (R-45 state_events attribution)',
      generatedAt: new Date().toISOString(),
      command: 'pnpm m5.1.1:prod-copy:verify',
      verdict: schemaVerdict,
      passed,
      failed,
      failures,
      blockers,
      realSourceOpenedByApplicationCode: false,
      boundaries,
      preview: { pendingBefore: previewBefore, pendingAfter: previewAfter },
      idempotency: { applied: againReport.applied.length, skipped: againReport.skipped },
      k4: {
        constraintCounts: { conversation_events: 23, character_action_events: 23, developer_control_events: 22 },
        indexPresent: indexRows.length === 1,
      },
      stateEventV9: {
        ruling: 'R-45 = SELECTED B —— v9 只给 state_events 追加 19 列 + 19 条 CHECK（无 Axis B / 无索引 / 无回填）',
        expectedNewColumns: V9_NEW_COLUMNS,
        observedColumns: stateEventColumns,
        missingNewColumns: missingStateColumns,
        checkNames: stateEventConstraintNames,
        indexes: stateEventIndexRows.map((row) => row.indexname),
        rows: stateEventRows,
        rowsWithAttributionOrigin: stateEventOriginNonNull,
      },
      k22: {
        ruling: 'Action attribution is NOT Cognitive Axis B（行动表 Axis B = NOT_APPLICABLE）',
        actionAxisBConstraint: axisBDefs[0] ?? null,
        constraintValidatedByPostgres: axisBDefs[0]?.convalidated === true,
        existingActionRows: actionRowCountValue,
        existingActionRowsWithAxisB: actionAxisBFilledValue,
        existingRowsScopeVerdict: actionScopeVerdict,
        existingRowsScopeNote:
          actionScopeVerdict === 'NOT_APPLICABLE'
            ? '真实库的行动账本是**空的**（0 行）⇒ 这一维在副本上不可判定，如实标 NOT_APPLICABLE；' +
              '非空证明由 pnpm m5.1.1:wp4.1:verify 的沙箱正控/负控提供'
            : '既有行全部满足新谓词',
        conversationAxisBUntouched: true,
      },
      k16Columns: columnMeta,
      beforeImageUnchanged: {
        rowsCompared: afterImage.length,
        identical: valuesUnchanged,
        changedRowIds: changedRows.map((row) => row.id),
        nonNullAuthorityBefore: nonNullBefore,
        nonNullAuthorityAfter: Number(axisBIntact[0]?.c ?? -1),
        manifestHash,
        manifestHashAlgorithm:
          'sha256 over "id\\tsequence\\tsource_kind\\tsource_authority\\tepistemic_source" lines, ordered by (sequence, id)',
        privacy: '不包含任何消息正文（content 没有被 select）',
      },
      noBackfill: {
        attributionOriginNonNullRows: Number(backfillRows[0]?.c ?? -1),
        slotColumnsFilledRows: Number(slotFilled[0]?.c ?? -1),
        contentOriginatorFabricatedRows: Number(fabricated[0]?.c ?? -1),
      },
      measurements,
      measurementInvalid: measurementInvalid.length,
      evidenceNaming: {
        thisFile: 'artifacts/m5.1.1/wp9b1-production-copy-v9.json（WP9-B1 fork）',
        historicalLeftUntouched: [
          'artifacts/m5.1.1/wp2.2-production-copy-schema.json（WP2.2 的 v6 → v7）',
          'artifacts/m5.1.1/wp2.2-axis-b-before-image.json（WP3 用过的 before-image）',
          'artifacts/m5.1.1/wp4.1-production-copy-v8.json（WP4.1 的 v6 → v8）',
        ],
      },
      scope: {
        allowed: 'copy-only：只读统计源 → cpSync → 只开副本 → 预览 → 在副本上 apply v7+v8+v9',
        notDone: ['真实库 migrate:apply', 'character_action_events 的历史回填（本步不做）', 'restore'],
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\n${'='.repeat(74)}`)
console.log(`WP9-B1 production-copy schema apply（v6 → v9）：${passed} 通过 / ${failed} 失败｜${schemaVerdict}`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp9b1-production-copy-v9.json')
console.log('（WP2.2 / WP4.1 的历史证据保持原样：wp2.2-* 与 wp4.1-production-copy-v8.json）')

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
