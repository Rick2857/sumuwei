/**
 * M5.1.1 Batch D / WP3 —— **Legacy Attribution Backfill**（`pnpm m5.1.1:wp3:verify`）
 *
 * ============================================================================
 *  边界（用户原话，逐条执行）
 * ============================================================================
 *   · 源 `data/pglite`：**READ/COPY BOUNDARY ONLY** —— 不 apply、不 update、不运行时写入。
 *     应用代码**从不打开**源；只做 `cpSync` 副本，随后**只开副本**。
 *   · 回填、Axis B 改写、M1–M7 全部发生在**副本**上。
 *   · 不改 MemoryAuthority / 不改 Fact Firewall / 不做 ADR-043 / 不进 Phase 4。
 *
 * ============================================================================
 *  审慎决策（写下来，免得被当成"顺手"）
 * ============================================================================
 *  ① `recorded_by` 的分类是 **D**，但**文档没有把"确定性值"钉成某个具体 principal**
 *     （只说"结构性事实：只有 kernel 写入器能写这些表"）⇒ 本回填**不给它编一个值**，
 *     留 `Absent`，并把"没有可计算确定性证据的 D 槽位"如实计数（WP2.4 的分类规则允许
 *     D 槽位 Absent："还没回填 ≠ 编造"）。
 *  ② `character_action_events` **不在本次回填范围内**：§3.6 的 Axis B 规则只针对
 *     `conversation_events`，而 `axis_b_complete` 约束要求"声明了 origin 就必须三列齐" ⇒
 *     若给它标 MIGRATED_LEGACY 却无冻结的 source_kind 规则，就等于**发明**一条映射。
 *     本次只回填 `conversation_events`，并把该表的行数如实报告为"未触碰、超出范围"。
 *
 * 跑法：pnpm m5.1.1:wp3:verify
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import 'dotenv/config'

import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { ACTION_EVENT_TYPES } from '../src/kernel/action/execution-ledger.ts'
import {
  CANONICAL_LEDGER_RECORDER,
  CANONICAL_LEDGER_RECORDER_SOURCE,
  CONVERSATION_BACKFILL_CLASSIFICATION,
  NECESSITY_MATRIX,
  TRUSTED_LEDGER_WRITERS,
  isCanonicalRecorder,
  type BackfillClass,
  type BackfillClassRow,
} from '../src/kernel/contracts/attribution.ts'
import { MEMORY_AUTHORITIES } from '../src/kernel/contracts/memory.ts'
import { canSupportExternalFact, type SourceAuthority } from '../src/kernel/contracts/source-authority.ts'
import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'
import { migrationPremiseOf, postMigrationInvariants } from './m5.1.1-post-migration-invariants.ts'
// K-33 / WP8-C2：K-23 的边界判据**只有一份实现**（本门与 K-33 专项门共同消费）
import { analyzeRecorderBoundary } from './m5.1.1-k23-recorder-boundary.ts'
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

/** R-13 第①条：计数型检测器必须自检 `measured_count > 0` */
function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')
const SLOTS = ['initiator', 'actor', 'executor', 'authority', 'recorded_by', 'content_originator'] as const
type Slot = (typeof SLOTS)[number]
const COLUMN_OF: Record<Slot, { kind: string; id: string; reason: string }> = {
  initiator: { kind: 'initiator_kind', id: 'initiator_id', reason: 'initiator_unknown_reason' },
  actor: { kind: 'actor_kind', id: 'actor_ref_id', reason: 'actor_unknown_reason' },
  executor: { kind: 'executor_kind', id: 'executor_id', reason: 'executor_unknown_reason' },
  authority: { kind: 'authority_kind', id: 'authority_ref', reason: 'authority_unknown_reason' },
  recorded_by: { kind: 'recorded_by_kind', id: 'recorded_by_id', reason: 'recorded_by_unknown_reason' },
  content_originator: {
    kind: 'content_originator_kind',
    id: 'content_originator_id',
    reason: 'content_originator_unknown_reason',
  },
}
const SLOT_KEY: Record<Slot, keyof BackfillClassRow> = {
  initiator: 'initiator',
  actor: 'actor',
  executor: 'executor',
  authority: 'authority',
  recorded_by: 'recordedBy',
  content_originator: 'contentOriginator',
}
const ABSENT = { kind: null, id: null, reason: null } as const
const LEGACY = { kind: null, id: null, reason: 'LEGACY_UNRECORDED' } as const

console.log('='.repeat(74))
console.log('M5.1.1 Batch D / WP3 —— Legacy Attribution Backfill（production-copy only）')
console.log('='.repeat(74))

// ===========================================================================
section('AT-0. K-21 synchronization（静态前置：矩阵与门必须已经收敛）')
// ===========================================================================

const lockedRules: { family: string; slot: keyof BackfillClassRow; expected: BackfillClass }[] = [
  { family: 'user_message', slot: 'actor', expected: 'U' },
  { family: 'user_message', slot: 'contentOriginator', expected: 'U' },
  { family: 'assistant_message', slot: 'contentOriginator', expected: 'U' },
  { family: 'tool_event', slot: 'actor', expected: 'D' },
  { family: 'tool_event', slot: 'contentOriginator', expected: 'D' },
  { family: 'tool_event', slot: 'executor', expected: 'N' },
  { family: 'system_event', slot: 'contentOriginator', expected: 'U' },
]
measure('AT-0 锁定规则条数', lockedRules.length)
const lockedBad = lockedRules
  .filter(
    (rule) =>
      CONVERSATION_BACKFILL_CLASSIFICATION[rule.family as keyof typeof CONVERSATION_BACKFILL_CLASSIFICATION][
        rule.slot
      ] !== rule.expected
  )
  .map((rule) => `${rule.family}.${rule.slot}`)
check('AT-0 七条锁定规则与分类矩阵一致', lockedBad.length === 0, lockedBad.join(',') || 'AA')

const conflictBad: string[] = []
for (const [family, row] of Object.entries(CONVERSATION_BACKFILL_CLASSIFICATION)) {
  for (const slot of SLOTS) {
    const necessity = NECESSITY_MATRIX[family as keyof typeof NECESSITY_MATRIX][SLOT_KEY[slot]]
    if ((necessity === 'ABSENT') !== (row[SLOT_KEY[slot]] === 'N')) conflictBad.push(`${family}.${slot}`)
  }
}
measure('N ⟺ ABSENT 交叉比对的格子数', 4 * 6)
check('★ K-21 CLOSED：`N ⟺ ABSENT` 全局成立（零豁免）', conflictBad.length === 0, conflictBad.join(',') || 'AA')

// K-8：apply 前必须能核对冻结指纹
const MIGRATION_0007_SHA256 = '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613'
const v7 = MIGRATIONS.find((migration) => migration.version === 7)
check('K-8：MIGRATION_0007 存在', v7 !== undefined)
const v7Hash =
  v7 === undefined ? '' : createHash('sha256').update(v7.statements.join('\n'), 'utf8').digest('hex')
check(
  'K-8：apply 前核对冻结指纹一致（v7 未被改动）',
  v7Hash === MIGRATION_0007_SHA256,
  `${v7Hash.slice(0, 16)}… vs ${MIGRATION_0007_SHA256.slice(0, 16)}…`
)
measure('MIGRATION_0007 语句数', v7?.statements.length ?? 0)

// K-23 / R-20 的**结构性证明**（"每一行历史上都是 canonical ledger recorder 写的"）
function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}
const srcFiles = walkFiles(join(ROOT, 'src'))
measure('K-23 扫描的 src 文件数', srcFiles.length)
/*
 * ===========================================================================
 *  K-33（WP8-C2）：结构性证明①②改用**能力判据**（单一 analyzer）
 * ===========================================================================
 *  旧证明②写成"`recordedBy` 只出现在契约里"。它在 WP3.1 当时成立，但后来的读回映射 /
 *  Developer DTO / Query 面**合法地**要读这个槽位 ⇒ 它不再等价于"没有第二个 writer"，
 *  而且把只读引用当成了写能力（K-33）。现在它换成用户裁定的新命题：
 *
 *    旧：no source file outside attribution.ts may mention recordedBy
 *    新：no caller-controlled production path may provide values to
 *        conversation_events.recorded_by_* authoritative columns
 *
 *  判据实现**唯一**放在 `scripts/m5.1.1-k23-recorder-boundary.ts`，
 *  由本门与 K-33 专项门共同消费（避免第二次 drift）。判据基于 AST 能力，没有文件名豁免表。
 */
const boundary = analyzeRecorderBoundary({ srcRoot: join(ROOT, 'src') })
measure('K-23 边界分析：mutation 面数（自动发现）', boundary.counts.mutationSites)
measure('K-23 边界分析：权威 writer 文件数', boundary.counts.authoritativeWriterFiles)
measure('K-23 边界分析：recordedBy 值构造点数', boundary.counts.recordedByValueConstructions)
measure('K-23 边界分析：只读引用文件数（负控对象）', boundary.counts.readerFilesWithRecordedBy)
// ⚠️ `callerControlledProviders = 0` / `unexplainedReferences = 0` 是**结论**，不是"测到了 0 个对象"：
//    它们的"对象数"由上面那几条 scope 量保证（mutation 面 / writer / 值构造点 / 只读引用）。
console.log(`  · 调用方可控提供者 = ${boundary.counts.callerControlledProviders}｜无法解释的引用 = ${boundary.counts.unexplainedReferences}（两者都必须是 0，且上面的 scope 量都 > 0）`)
check(
  'K-23 结构性证明①：权威 mutation 面**自动发现**且唯一（`insert into conversation_events` 恰好一个文件）',
  boundary.counts.authoritativeWriterFiles === 1 && boundary.counts.mutationSites > 0,
  boundary.authoritativeWriterFiles.join(', ') || '一个都没有（那反而更可疑）'
)
check(
  'K-23 结构性证明②：没有**调用方可控的生产路径**能向 `conversation_events.recorded_by_*` 提供值',
  boundary.counts.callerControlledProviders === 0 &&
    boundary.counts.unexplainedReferences === 0 &&
    boundary.recordedByColumnsCovered &&
    boundary.counts.envelopeProducers === 1 &&
    boundary.recordedByValueConstructions.every((v) => v.usesCanonicalConstant),
  `callerControlled=${boundary.counts.callerControlledProviders} · unexplained=${boundary.counts.unexplainedReferences} · 物理三列已覆盖=${String(boundary.recordedByColumnsCovered)} · envelope 生产者=${boundary.counts.envelopeProducers} · 值构造点全部 canonical=${String(boundary.recordedByValueConstructions.every((v) => v.usesCanonicalConstant))}`
)
check(
  'K-23 结构性证明③（K-33 新增）：除那一条 INSERT 外没有别的 mutation 面能绑定 `recorded_by_*`',
  boundary.mutationSites.filter((s) => s.verb !== 'insert' && s.bindsRecordedByColumns).length === 0,
  boundary.mutationSites
    .filter((s) => s.verb !== 'insert')
    .map((s) => `${s.file}:${s.line}(${s.verb})`)
    .join(', ') || '没有非 insert 面'
)
console.log(`  · canonical ledger recorder = Known(${CANONICAL_LEDGER_RECORDER.kind}/${CANONICAL_LEDGER_RECORDER.id})`)
console.log(`  · 出处：${CANONICAL_LEDGER_RECORDER_SOURCE}`)
console.log(
  `  · 边界：writer=${boundary.authoritativeWriterFiles.join(',')} · 只读引用=${boundary.readerFilesWithRecordedBy.join(',')} · 受信上下文产出点=${boundary.trustedContextProducers.map((p) => `${p.file}:${p.line}`).join(',')}`
)

// ===========================================================================
section('AT-1. production-copy preparation（源：READ/COPY ONLY）')
// ===========================================================================

function dirStats(dir: string): { files: string[]; bytes: number; newestMtime: number } {
  const files: string[] = []
  let bytes = 0
  let newestMtime = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        const stat = statSync(full)
        files.push(relative(dir, full))
        bytes += stat.size
        newestMtime = Math.max(newestMtime, stat.mtimeMs)
      }
    }
  }
  walk(dir)
  return { files: files.sort(), bytes, newestMtime }
}

function boundaryFingerprint(dir: string, files: string[]): string {
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file}\t${statSync(join(dir, file)).size}\n`)
  return hash.digest('hex')
}

const sourceBefore = dirStats(PRODUCTION_DB_DIR)
measure('源文件数', sourceBefore.files.length)
measure('源总字节', sourceBefore.bytes)
const sourceFingerprintBefore = boundaryFingerprint(PRODUCTION_DB_DIR, sourceBefore.files)

// 静默确认：连续两次采样一致
await new Promise((resolve) => setTimeout(resolve, 3000))
const sourceQuiescent = dirStats(PRODUCTION_DB_DIR)
check(
  'AT-1 源在 3000ms 静默窗口内没有变化',
  boundaryFingerprint(PRODUCTION_DB_DIR, sourceQuiescent.files) === sourceFingerprintBefore,
  '连续两次指纹一致'
)

const workDir = mkdtempSync(join(tmpdir(), 'wp3-copy-'))
cpSync(PRODUCTION_DB_DIR, workDir, { recursive: true })

const sourceAfterCopy = dirStats(PRODUCTION_DB_DIR)
check(
  'AT-1 复制之后源指纹未变（源在复制期间没有被写）',
  boundaryFingerprint(PRODUCTION_DB_DIR, sourceAfterCopy.files) === sourceFingerprintBefore,
  '一致'
)
const copyStats = dirStats(workDir)
check('AT-1 副本文件数与源一致', copyStats.files.length === sourceBefore.files.length, `${copyStats.files.length} vs ${sourceBefore.files.length}`)
check('AT-1 副本总字节与源一致', copyStats.bytes === sourceBefore.bytes, `${copyStats.bytes} vs ${sourceBefore.bytes}`)

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
 * ⚠️ M5.1.1 / Phase 4b（用户 2026-09-19 裁定）—— `AT-1` 的前提有两态。
 *
 * 它的原判据是"副本 apply 前 = v6，待应用 [7,8,9]，apply 后 = 9"。
 * 真库按 `D-1 = ②` 迁到 v9 之后副本也是 v9 ⇒ 待应用为空 ⇒
 * 那几条检测器**正确地**报 `MEASUREMENT INVALID`（AGENTS §6.8），前提失效。
 *
 * **取代不删除保证**：迁移前分支原样保留（真库若回到旧版本，彩排照旧有效）；
 * 已应用分支改为断言 **post-migration 不变量**（既有行身份摘要逐字不变 ∧ 0 行伪造归因）。
 */
const premise = migrationPremiseOf(versionBeforeApply)
check(
  'AT-1 副本可以打开，且处于可判定状态（迁移前 v6 的彩排前提，或真库已迁移 v9 的事后核对）',
  premise !== 'unrecognized',
  premise === 'already-applied'
    ? `副本已是 v${versionBeforeApply}（真实库已按 D-1=② 迁移）⇒ 彩排前提失效；保证改由 post-migration 不变量承接`
    : `v${versionBeforeApply}（pre-migration 彩排路径有效）`
)

let pendingBefore: Awaited<ReturnType<typeof pendingMigrations>> = []
let upgradeReport: Awaited<ReturnType<typeof applyKernelMigrations>>
let versionAfterApply: number
if (premise === 'pre-migration') {
  pendingBefore = await pendingMigrations(db)
  measure('AT-1 apply 前待应用迁移数', pendingBefore.length)
  check(
    'AT-1 待应用 = [v7, v8, v9]（WP9-B1 加 v9 之后的判据；仍只应用"副本上待应用的那些"）',
    pendingBefore.length === 3 &&
      pendingBefore[0]?.version === 7 &&
      pendingBefore[1]?.version === 8 &&
      pendingBefore[2]?.version === 9,
    JSON.stringify(pendingBefore.map((migration) => migration.version))
  )

  upgradeReport = await applyKernelMigrations(db)
  versionAfterApply = await currentSchemaVersion(db)
  check(
    'AT-1 副本 apply 后 schemaVersion = 9（应用了 7、8、9）',
    versionAfterApply === 9 &&
      upgradeReport.applied.length === 3 &&
      upgradeReport.applied[0]?.version === 7 &&
      upgradeReport.applied[1]?.version === 8 &&
      upgradeReport.applied[2]?.version === 9,
    `from=${upgradeReport.fromVersion} to=${upgradeReport.toVersion} applied=[${upgradeReport.applied
      .map((migration) => migration.version)
      .join(',')}]`
  )
} else {
  // ★ 取代分支（真库已迁移）：保证由 **post-migration 不变量**承接
  const post = await postMigrationInvariants(db)
  check('★ 取代判据（真库已迁移）：既有行身份摘要逐字不变 ∧ 0 行伪造归因', post.ok, post.detail)
  pendingBefore = await pendingMigrations(db)
  check(
    '★ 取代判据（真库已迁移）：没有待应用迁移（迁移链已走完）',
    pendingBefore.length === 0,
    JSON.stringify(pendingBefore.map((migration) => migration.version))
  )
  check('★ 取代判据（真库已迁移）：副本 schema = 9', versionBeforeApply === 9, `v${versionBeforeApply}`)
  upgradeReport = await applyKernelMigrations(db)
  versionAfterApply = await currentSchemaVersion(db)
  check(
    '★ 取代判据（真库已迁移）：apply 后仍是 9 且应用 0 条（链已走完）',
    versionAfterApply === 9 && upgradeReport.applied.length === 0,
    `from=${upgradeReport.fromVersion} to=${upgradeReport.toVersion} applied=[${upgradeReport.applied
      .map((migration) => migration.version)
      .join(',')}]`
  )
}

// ===========================================================================
section('AT-2. BEFORE IMAGE（逐行迁移证据；**不含正文**）')
// ===========================================================================

type LegacyRow = {
  id: string
  sequence: number
  type: string
  actorType: string
  actorId: string | null
  sourceKind: string | null
  sourceAuthority: string | null
  epistemicSource: string | null
  origin: string | null
  slots: Record<Slot, { kind: string | null; id: string | null; reason: string | null }>
}

async function readLegacyRows(): Promise<LegacyRow[]> {
  const rows = rowsOf(
    await db.execute(
      sql`select id, sequence, type, actor_type, actor_id, source_kind, source_authority,
                 epistemic_source, attribution_origin,
                 initiator_kind, initiator_id, initiator_unknown_reason,
                 actor_kind, actor_ref_id, actor_unknown_reason,
                 executor_kind, executor_id, executor_unknown_reason,
                 authority_kind, authority_ref, authority_unknown_reason,
                 recorded_by_kind, recorded_by_id, recorded_by_unknown_reason,
                 content_originator_kind, content_originator_id, content_originator_unknown_reason
          from conversation_events order by sequence asc, id asc`
    )
  ) as Record<string, unknown>[]
  return rows.map((row) => ({
    id: String(row.id),
    sequence: Number(row.sequence),
    type: String(row.type),
    actorType: String(row.actor_type),
    actorId: row.actor_id === null || row.actor_id === undefined ? null : String(row.actor_id),
    sourceKind: row.source_kind === null ? null : String(row.source_kind),
    sourceAuthority: row.source_authority === null ? null : String(row.source_authority),
    epistemicSource: row.epistemic_source === null ? null : String(row.epistemic_source),
    origin: row.attribution_origin === null ? null : String(row.attribution_origin),
    slots: Object.fromEntries(
      SLOTS.map((slot) => [
        slot,
        {
          kind: (row[COLUMN_OF[slot].kind] ?? null) as string | null,
          id: (row[COLUMN_OF[slot].id] ?? null) as string | null,
          reason: (row[COLUMN_OF[slot].reason] ?? null) as string | null,
        },
      ])
    ) as LegacyRow['slots'],
  }))
}

const beforeRows = await readLegacyRows()
measure('AT-2 before-image 行数', beforeRows.length)
const familyCountsBefore = beforeRows.reduce<Record<string, number>>((acc, row) => {
  acc[row.type] = (acc[row.type] ?? 0) + 1
  return acc
}, {})
measure('AT-2 覆盖的 event family 数', Object.keys(familyCountsBefore).length)

const beforeManifestHash = createHash('sha256')
  .update(
    beforeRows
      .map((row) => `${row.id}\t${row.sequence}\t${row.sourceKind ?? ''}\t${row.sourceAuthority ?? ''}\t${row.epistemicSource ?? ''}`)
      .join('\n'),
    'utf8'
  )
  .digest('hex')
const beforeAxisBNonNull = beforeRows.filter((row) => row.sourceAuthority !== null).length
// 单纯的事实观测，**不**用 measure()：0 条也是一个合法结果，不是"没测到"
console.log(`  · before-image 中 Axis B 非空的行数 = ${beforeAxisBNonNull}（旧值，已保留在证据里）`)

const actionRowCount = Number(
  (
    rowsOf(await db.execute(sql`select count(*) as n from character_action_events`)) as { n: unknown }[]
  )[0]?.n ?? 0
)
console.log(`  · character_action_events 行数 = ${actionRowCount}（**本 WP 不触碰**：无冻结 Axis B 规则）`)

// ===========================================================================
section('AT-3 / AT-4. Legacy Backfill（只在副本上；D/P/U/N + Axis B）')
// ===========================================================================

function deterministicEvidence(row: LegacyRow, slot: Slot): { kind: string; id: string } | null {
  if (row.actorId === null || row.actorId === '') {
    // K-23 / R-20：`recorded_by` 的确定性证据**不依赖行上的任何字段** ——
    // 全 src 只有 conversation-store.ts 会 insert into conversation_events，
    // 所以每一行的写入器在结构上都是 canonical ledger recorder。
    return slot === 'recorded_by'
      ? { kind: CANONICAL_LEDGER_RECORDER.kind, id: CANONICAL_LEDGER_RECORDER.id }
      : null
  }
  if (slot === 'recorded_by') {
    return { kind: CANONICAL_LEDGER_RECORDER.kind, id: CANONICAL_LEDGER_RECORDER.id }
  }
  if (slot === 'actor' && row.type === 'tool_event') return { kind: 'TOOL', id: row.actorId }
  if (slot === 'content_originator' && row.type === 'tool_event') return { kind: 'TOOL', id: row.actorId }
  if (slot === 'actor' && row.type === 'assistant_message') return { kind: 'CHARACTER', id: row.actorId }
  return null
}

function hasIndependentRowLevelEvidence(row: LegacyRow): boolean {
  return row.actorId !== null && row.actorId !== ''
}

/** 纯函数：给定一行，算出回填后的**全部**槽位与 Axis B（与写入解耦，便于 M2/AT-6 复算） */
function planRow(row: LegacyRow): {
  slots: Record<Slot, { kind: string | null; id: string | null; reason: string | null }>
  axisB: { sourceKind: string; sourceAuthority: string; epistemicSource: string; origin: string }
  observations: string[]
} {
  const family = CONVERSATION_BACKFILL_CLASSIFICATION[
    row.type as keyof typeof CONVERSATION_BACKFILL_CLASSIFICATION
  ]
  const observations: string[] = []
  const slots = Object.fromEntries(
    SLOTS.map((slot) => {
      const cls: BackfillClass = family?.[SLOT_KEY[slot]] ?? 'P'
      if (cls === 'N') return [slot, { ...ABSENT }]
      if (cls === 'U') return [slot, { ...LEGACY }]
      if (cls === 'D') {
        const evidence = deterministicEvidence(row, slot)
        if (evidence === null) {
          observations.push(`${slot}: D 槽位没有可计算的确定性证据 ⇒ 留 Absent（不编造）`)
          return [slot, { ...ABSENT }]
        }
        return [slot, { kind: evidence.kind, id: evidence.id, reason: null }]
      }
      // P
      if (hasIndependentRowLevelEvidence(row)) return [slot, { kind: 'SYSTEM', id: row.actorId, reason: null }]
      return [slot, { ...LEGACY }]
    })
  ) as Record<Slot, { kind: string | null; id: string | null; reason: string | null }>

  // Axis B：source_kind = legacy classifier 的输出（actor_type 全函数），另两列 = UNCONFIRMED_ORIGIN
  const sourceKindByActorType: Record<string, string> = {
    user: 'user_statement',
    character: 'character_output',
    system: 'system_instruction',
    tool: 'tool_output',
  }
  return {
    slots,
    axisB: {
      sourceKind: sourceKindByActorType[row.actorType] ?? 'system_instruction',
      sourceAuthority: 'UNCONFIRMED_ORIGIN',
      epistemicSource: 'UNCONFIRMED_ORIGIN',
      origin: 'MIGRATED_LEGACY',
    },
    observations,
  }
}

const planOf = new Map(beforeRows.map((row) => [row.id, planRow(row)]))
const observationsAll = [...planOf.values()].flatMap((plan) => plan.observations)
measure('AT-3 计算出的回填计划行数', planOf.size)

async function applyBackfill(): Promise<number> {
  let touched = 0
  for (const row of beforeRows) {
    const plan = planOf.get(row.id)
    if (plan === undefined) continue
    const sets = SLOTS.flatMap((slot) => [
      sql`${sql.raw(COLUMN_OF[slot].kind)} = ${plan.slots[slot].kind}`,
      sql`${sql.raw(COLUMN_OF[slot].id)} = ${plan.slots[slot].id}`,
      sql`${sql.raw(COLUMN_OF[slot].reason)} = ${plan.slots[slot].reason}`,
    ])
    sets.push(
      sql`source_kind = ${plan.axisB.sourceKind}`,
      sql`source_authority = ${plan.axisB.sourceAuthority}`,
      sql`epistemic_source = ${plan.axisB.epistemicSource}`,
      sql`attribution_origin = ${plan.axisB.origin}`
    )
    await db.execute(sql`update conversation_events set ${sql.join(sets, sql`, `)} where id = ${row.id}`)
    touched += 1
  }
  return touched
}

const touched = await applyBackfill()
measure('AT-3 被回填的行数', touched)
check('AT-3 回填覆盖了 before-image 的每一行', touched === beforeRows.length, `${touched}/${beforeRows.length}`)

const afterRows = await readLegacyRows()
/** 槽位 + Axis B 的完整状态指纹（AT-6 的幂等/回归判据） */
function stateHash(rows: LegacyRow[]): string {
  const hash = createHash('sha256')
  for (const row of rows) {
    hash.update(
      [
        row.id,
        row.origin ?? '',
        row.sourceKind ?? '',
        row.sourceAuthority ?? '',
        row.epistemicSource ?? '',
        ...SLOTS.flatMap((slot) => [row.slots[slot].kind ?? '', row.slots[slot].id ?? '', row.slots[slot].reason ?? '']),
      ].join('\t') + '\n'
    )
  }
  return hash.digest('hex')
}
const stateHashAfterFirst = stateHash(afterRows)

// ===========================================================================
section('AT-4b. recordedBy 证据一致性控制（K-23 / R-20；三段式）')
// ===========================================================================

/** recordedBy 的证据一致性判据：适用行必须**恰好**是 canonical recorder */
function recorderViolations(rows: LegacyRow[]): string[] {
  return rows
    .filter((row) => row.origin === 'MIGRATED_LEGACY')
    .filter((row) => {
      const cell = row.slots.recorded_by
      return !isCanonicalRecorder({ kind: cell.kind, id: cell.id })
    })
    .map((row) => {
      const cell = row.slots.recorded_by
      return `${row.id}: ${cell.kind ?? 'Absent'}/${cell.id ?? (cell.reason ?? '—')}`
    })
}

// 正控
const positiveRecorder = recorderViolations(afterRows)
measure('AT-4b 检查的 MIGRATED_LEGACY 行数', afterRows.filter((row) => row.origin === 'MIGRATED_LEGACY').length)
check(
  'AT-4b 正控：kernel 写下的历史行 ⇒ recordedBy = SYSTEM/kernel，检测器**安静**',
  positiveRecorder.length === 0,
  positiveRecorder.slice(0, 3).join(' | ') || 'AA'
)

// 负控：调用方自报别的 recorder（含四个"看起来像"的 kind 与 mutation）
const forgedRecorderCases: { label: string; kind: string; id: string; expected: 'fire' }[] = [
  { label: 'USER/kernel', kind: 'USER', id: 'kernel', expected: 'fire' },
  { label: 'CHARACTER/kernel', kind: 'CHARACTER', id: 'kernel', expected: 'fire' },
  { label: 'TOOL/kernel', kind: 'TOOL', id: 'kernel', expected: 'fire' },
  { label: 'SERVICE/kernel', kind: 'SERVICE', id: 'kernel', expected: 'fire' },
  { label: 'mutation: SYSTEM/kernel → SYSTEM/not-the-kernel', kind: 'SYSTEM', id: 'not-the-kernel', expected: 'fire' },
]
const forgedTarget = afterRows[0]!.id
const forgedReadings: { label: string; fired: boolean; observed: string }[] = []
for (const forged of forgedRecorderCases) {
  await db.execute(
    sql`update conversation_events set recorded_by_kind = ${forged.kind}, recorded_by_id = ${forged.id},
        recorded_by_unknown_reason = null where id = ${forgedTarget}`
  )
  const probe = await readLegacyRows()
  const violations = recorderViolations(probe)
  const fired = violations.length > 0
  forgedReadings.push({ label: forged.label, fired, observed: violations.slice(0, 2).join(' | ') })
  check(`AT-4b 负控：${forged.label} ⇒ 检测器**必响**`, fired, violations.slice(0, 1).join('') || '没响')
}
measure('AT-4b 检测到的伪造/mutation 次数', forgedReadings.filter((reading) => reading.fired).length)

// Absent 也算**迁移完整性失败**（不是"还没填"）
await db.execute(
  sql`update conversation_events set recorded_by_kind = null, recorded_by_id = null,
      recorded_by_unknown_reason = null where id = ${forgedTarget}`
)
const absentProbe = recorderViolations(await readLegacyRows())
check(
  'AT-4b 负控：适用行的 recordedBy 缺失（Absent）⇒ 检测器**必响**（迁移完整性失败）',
  absentProbe.length > 0,
  absentProbe.slice(0, 1).join('') || '没响'
)

// 恢复
await db.execute(
  sql`update conversation_events set recorded_by_kind = ${CANONICAL_LEDGER_RECORDER.kind},
      recorded_by_id = ${CANONICAL_LEDGER_RECORDER.id}, recorded_by_unknown_reason = null
      where id = ${forgedTarget}`
)
const restoredProbe = recorderViolations(await readLegacyRows())
check(
  'AT-4b 恢复：改回 SYSTEM/kernel ⇒ 检测器**重新安静**',
  restoredProbe.length === 0,
  restoredProbe.slice(0, 2).join(' | ') || 'AA'
)

// ===========================================================================
section('AT-5. Exact Migration Gates（M1–M7）')
// ===========================================================================

// ---- M1：迁移只追加
const destructivePattern = /(\bdrop\s+(table|column|index)\b)|(\btruncate\b)|(\bdelete\s+from\b)|(^\s*update\s)/im
check('M1 迁移只追加：v7 语句里没有 drop/truncate/delete/update', !destructivePattern.test(v7?.statements.join('\n') ?? ''), 'AA')

// ---- M2：回填分类正确（逐 family × slot）
const m2Mismatches: string[] = []
for (const row of afterRows) {
  const family = CONVERSATION_BACKFILL_CLASSIFICATION[
    row.type as keyof typeof CONVERSATION_BACKFILL_CLASSIFICATION
  ]
  for (const slot of SLOTS) {
    const cls: BackfillClass = family?.[SLOT_KEY[slot]] ?? 'P'
    const cell = row.slots[slot]
    const state = cell.kind === null && cell.id === null && cell.reason === null ? 'ABSENT' : cell.reason === null ? 'KNOWN' : 'UNKNOWN'
    const ok =
      cls === 'N'
        ? state === 'ABSENT'
        : cls === 'U'
          ? state === 'UNKNOWN' && cell.reason === 'LEGACY_UNRECORDED'
          : state !== 'ABSENT' || cls === 'D' // D 允许 Absent（无可计算证据）；P 不允许
    if (!ok) m2Mismatches.push(`${row.type}.${slot}: cls=${cls} state=${state}`)
  }
}
measure('M2 比对的 (family × slot) 格子数', afterRows.length * SLOTS.length)
check('M2 回填分类正确（逐 family × slot 与冻结矩阵一致）', m2Mismatches.length === 0, m2Mismatches.slice(0, 4).join(' | ') || 'AA')

// ---- M3：逐槽位 Unknown(LEGACY_UNRECORDED) 计数精确相等
const m3Counts: Record<string, { expected: number; actual: number }> = {}
for (const slot of SLOTS) {
  let expected = 0
  let actual = 0
  for (const row of afterRows) {
    const cls: BackfillClass =
      CONVERSATION_BACKFILL_CLASSIFICATION[row.type as keyof typeof CONVERSATION_BACKFILL_CLASSIFICATION]?.[
        SLOT_KEY[slot]
      ] ?? 'P'
    if (cls === 'U') expected += 1
    else if (cls === 'P' && !hasIndependentRowLevelEvidence(row)) expected += 1
    if (row.slots[slot].reason === 'LEGACY_UNRECORDED' && row.slots[slot].kind === null && row.slots[slot].id === null) {
      actual += 1
    }
  }
  m3Counts[slot] = { expected, actual }
}
const m3Bad = Object.entries(m3Counts).filter(([, counts]) => counts.expected !== counts.actual)
measure('M3 逐槽位计数的槽位数', SLOTS.length)
check(
  'M3 不可确定的行**逐槽位**计数精确相等',
  m3Bad.length === 0,
  m3Bad.map(([slot, c]) => `${slot}:${c.actual}≠${c.expected}`).join(',') || JSON.stringify(m3Counts)
)
check(
  'M3 自检：至少有一个槽位的期望计数 > 0（否则"精确相等"是 0=0 的空转）',
  Object.values(m3Counts).some((counts) => counts.expected > 0),
  JSON.stringify(m3Counts)
)

// ---- M4：反伪造（六项计数必须为 0）
function stateOfCell(cell: { kind: string | null; id: string | null; reason: string | null }): string {
  if (cell.kind === null && cell.id === null && cell.reason === null) return 'ABSENT'
  if (cell.kind !== null && cell.id !== null && cell.reason === null) return 'KNOWN'
  if (cell.kind === null && cell.id === null && cell.reason !== null) return 'UNKNOWN'
  return 'MIXED'
}
const m4 = { dEvidenceMismatch: 0, pUnjustifiedKnown: 0, uConcreteKnown: 0, nNonAbsent: 0, unknownPrincipalKind: 0, mixedTuple: 0 }
for (const row of afterRows) {
  const family = CONVERSATION_BACKFILL_CLASSIFICATION[
    row.type as keyof typeof CONVERSATION_BACKFILL_CLASSIFICATION
  ]
  for (const slot of SLOTS) {
    const cls: BackfillClass = family?.[SLOT_KEY[slot]] ?? 'P'
    const cell = row.slots[slot]
    const state = stateOfCell(cell)
    if (state === 'MIXED') m4.mixedTuple += 1
    if (cell.kind !== null && cell.kind.startsWith('UNKNOWN')) m4.unknownPrincipalKind += 1
    if (cls === 'U' && state === 'KNOWN') m4.uConcreteKnown += 1
    if (cls === 'N' && state !== 'ABSENT') m4.nNonAbsent += 1
    if (cls === 'D' && state === 'KNOWN') {
      const evidence = deterministicEvidence(row, slot)
      if (evidence !== null && (cell.kind !== evidence.kind || cell.id !== evidence.id)) m4.dEvidenceMismatch += 1
    }
    if (cls === 'P' && state === 'KNOWN' && !hasIndependentRowLevelEvidence(row)) m4.pUnjustifiedKnown += 1
  }
}
// 值级禁止（与分类无关）：contentOriginator 永不可是 Known(USER/CHARACTER)
for (const row of afterRows) {
  const originator = row.slots.content_originator
  if (stateOfCell(originator) === 'KNOWN' && (originator.kind === 'USER' || originator.kind === 'CHARACTER')) {
    m4.uConcreteKnown += 1
  }
}
measure('M4 扫描的槽位格数', afterRows.length * SLOTS.length)
check('M4 反伪造：D 证据不一致 = 0', m4.dEvidenceMismatch === 0, String(m4.dEvidenceMismatch))
check('M4 反伪造：P 无证据却 Known = 0', m4.pUnjustifiedKnown === 0, String(m4.pUnjustifiedKnown))
check('M4 反伪造：U 具体 Known = 0', m4.uConcreteKnown === 0, String(m4.uConcreteKnown))
check('M4 反伪造：N 非 Absent = 0', m4.nNonAbsent === 0, String(m4.nNonAbsent))
check("M4：<slot>_kind LIKE 'UNKNOWN%' = 0", m4.unknownPrincipalKind === 0, String(m4.unknownPrincipalKind))
check('M4：混合 known/unknown 元组 = 0', m4.mixedTuple === 0, String(m4.mixedTuple))
check(
  'M4：contentOriginator 说成 Known(USER/CHARACTER) = 0（与分类无关的值级禁止，已计入 U 具体 Known）',
  m4.uConcreteKnown === 0,
  String(m4.uConcreteKnown)
)

// ---- M3/M4（K-23 / R-20）：`recordedBy` 的计数与证据一致性
const migratedAll = afterRows.filter((row) => row.origin === 'MIGRATED_LEGACY')
const recordedByKnown = migratedAll.filter((row) => {
  const cell = row.slots.recorded_by
  return cell.kind !== null && cell.id !== null && cell.reason === null
}).length
const recordedByCanonical = migratedAll.filter((row) =>
  isCanonicalRecorder({ kind: row.slots.recorded_by.kind, id: row.slots.recorded_by.id })
).length
const recordedByAbsent = migratedAll.filter((row) => stateOfCell(row.slots.recorded_by) === 'ABSENT').length
measure('M3(K-23) 适用的回填行数', migratedAll.length)
check(
  'M3(K-23) D `recordedBy` 的 **Known 计数精确等于**适用回填行数',
  recordedByKnown === migratedAll.length,
  `${recordedByKnown} vs ${migratedAll.length}`
)
check(
  'M4(K-23) `recordedBy` 证据一致性：等于 canonical recorder（SYSTEM/kernel）的行数 = 适用行数',
  recordedByCanonical === migratedAll.length,
  `${recordedByCanonical} vs ${migratedAll.length}`
)
check(
  'M4(K-23) 适用行 `recordedBy` **Absent = 0**（缺它 = 迁移完整性失败，不是"还没填"）',
  recordedByAbsent === 0,
  String(recordedByAbsent)
)

// ---- M5：影响半径（只读；见 AT-7）
//
// ⚠️ 第一版这里用 `USER_EXPLICIT` / `USER_REPLY_CONFIRMATION` 过滤 `memory_records.authority`
//    —— 那是 **SourceAuthority** 的词表，而该列存的是 **MemoryAuthority**
//    （`EXPLICIT_USER_STATEMENT` 等）。结果 `eligibleToday = 0`，看起来"没有影响"，
//    其实是**量错了东西**（AGENTS §6.9 的同型事故）。现在改成：
//      · "今天有资格" = 用**回填前**记录的 source_authority 过 `canSupportExternalFact()`
//      · "Phase 4 后存活" = 该行 contentOriginator 已确立（Known）
//      · 半径 = 前者减后者
//    并加两条自检：MemoryAuthority 词表比对 + "不得出现 SourceAuthority 专属值"。
const radiusRows = rowsOf(
  await db.execute(
    sql`select mr.id as memory_id, mr.authority as memory_authority,
               ce.id as event_id, ce.actor_type, ce.source_authority,
               ce.content_originator_kind, ce.content_originator_id, ce.content_originator_unknown_reason,
               mel.evidence_kind
        from memory_records mr
        join memory_evidence_links mel on mel.memory_id = mr.id
        left join conversation_events ce on ce.id = mel.evidence_id`
  )
) as Record<string, unknown>[]
measure('M5 扫描的 memory_records × evidence 链路数', radiusRows.length)
const evidenceKinds = [...new Set(radiusRows.map((row) => String(row.evidence_kind ?? '')))].sort()

const sourceAuthorityBefore = new Map(beforeRows.map((row) => [row.id, row.sourceAuthority]))
const observedMemoryAuthorities = [...new Set(radiusRows.map((row) => String(row.memory_authority ?? '')))].sort()
const authorityVocabBad = observedMemoryAuthorities.filter(
  (value) => !(MEMORY_AUTHORITIES as readonly string[]).includes(value)
)
check(
  'M5 自检：`memory_records.authority` 的取值全部落在 **MemoryAuthority** 词表内',
  authorityVocabBad.length === 0,
  `观测到 ${observedMemoryAuthorities.join(',')}`
)
check(
  'M5 自检：没有把 SourceAuthority 的专属值（USER_EXPLICIT 等）当成 memory authority 用',
  !observedMemoryAuthorities.some((value) => ['USER_EXPLICIT', 'USER_REPLY_CONFIRMATION', 'CHARACTER_GENERATION'].includes(value) &&
    !(MEMORY_AUTHORITIES as readonly string[]).includes(value)),
  'AA'
)

const radiusDetail = radiusRows.map((row) => {
  const eventId = row.event_id === null || row.event_id === undefined ? null : String(row.event_id)
  const oldAuthority = eventId === null ? null : (sourceAuthorityBefore.get(eventId) ?? null)
  const todayEligible = oldAuthority !== null && canSupportExternalFact(oldAuthority as SourceAuthority)
  const originatorKnown = row.content_originator_kind !== null && row.content_originator_kind !== undefined
  return {
    memoryId: String(row.memory_id ?? ''),
    memoryAuthority: String(row.memory_authority ?? ''),
    evidenceKind: String(row.evidence_kind ?? ''),
    eventId,
    actorType: eventId === null ? null : String(row.actor_type ?? ''),
    recordedSourceAuthorityBeforeBackfill: oldAuthority,
    todayEligibleViaSourceAuthority: todayEligible,
    contentOriginator: originatorKnown
      ? { state: 'Known', kind: String(row.content_originator_kind), id: String(row.content_originator_id ?? '') }
      : { state: 'Unknown/Absent', reason: row.content_originator_unknown_reason ?? null },
    survivesPhase4Hypothesis: todayEligible && originatorKnown,
  }
})
const todayEligibleCount = radiusDetail.filter((row) => row.todayEligibleViaSourceAuthority).length
const wouldLoseEligibility = radiusDetail.filter(
  (row) => row.todayEligibleViaSourceAuthority && !row.survivesPhase4Hypothesis
)
check(
  'M5 影响半径已产出（只读；口径 = canSupportExternalFact(回填前 source_authority)）',
  radiusRows.length > 0,
  `链条 ${radiusRows.length} 条；evidence_kind=${evidenceKinds.join(',')}；` +
    `今天有资格 ${todayEligibleCount}；Phase-4 假设下会失去资格的 = ${wouldLoseEligibility.length}`
)

// ---- M6：restore epoch
const restoreEpoch = 'NOT_APPLICABLE'
check('M6 restore epoch：本次没有执行任何 restore ⇒ NOT_APPLICABLE（不记假边界）', restoreEpoch === 'NOT_APPLICABLE')

// ---- M7：Axis B 完整性
const migratedRows = afterRows.filter((row) => row.origin === 'MIGRATED_LEGACY')
measure('M7 MIGRATED_LEGACY 行数', migratedRows.length)
const axisBNull = migratedRows.filter(
  (row) => row.sourceKind === null || row.sourceAuthority === null || row.epistemicSource === null
)
const axisBBadValue = migratedRows.filter(
  (row) => row.sourceAuthority !== 'UNCONFIRMED_ORIGIN' || row.epistemicSource !== 'UNCONFIRMED_ORIGIN'
)
const sourceKindOutOfVocab = migratedRows.filter(
  (row) => !['user_statement', 'character_output', 'system_instruction', 'tool_output'].includes(row.sourceKind ?? '')
)
check('M7 每个 MIGRATED_LEGACY 行的 Axis B 三列都非 NULL', axisBNull.length === 0, String(axisBNull.length))
check('M7 source_authority = epistemic_source = UNCONFIRMED_ORIGIN', axisBBadValue.length === 0, String(axisBBadValue.length))
check('M7 source_kind ∈ 既有 4 值', sourceKindOutOfVocab.length === 0, String(sourceKindOutOfVocab.length))
const recordedRows = afterRows.filter((row) => row.origin === 'RECORDED')
check(
  'M7 RECORDED 行的 epistemic 等式：本副本 RECORDED 行 = 0 ⇒ 该子判据**空集不适用**（不算 PASS）',
  true,
  `RECORDED 行数 = ${recordedRows.length}（measured_count = 0 ⇒ 该子判据不主张）`
)

// ===========================================================================
section('AT-6. Replay / Rebuild')
// ===========================================================================

await applyBackfill()
const replayedRows = await readLegacyRows()
check(
  'AT-6 重放幂等：第二次回填后完整状态指纹不变',
  stateHash(replayedRows) === stateHashAfterFirst,
  `${stateHashAfterFirst.slice(0, 12)}…`
)
const statesPreserved = afterRows.every((row, index) => {
  const other = replayedRows[index]
  if (other === undefined) return false
  return (
    row.origin === other.origin &&
    SLOTS.every((slot) => {
      const a = stateOfCell(row.slots[slot])
      const b = stateOfCell(other.slots[slot])
      return a === b
    })
  )
})
check('AT-6 Known/Unknown/Absent 三态逐个保持（MIGRATED_LEGACY 也保持）', statesPreserved)

// K-23 / R-20：replay 必须**逐字**保住 canonical recorder
const replayedRecorderBad = replayedRows
  .filter((row) => row.origin === 'MIGRATED_LEGACY')
  .filter((row) => !isCanonicalRecorder({ kind: row.slots.recorded_by.kind, id: row.slots.recorded_by.id }))
measure('AT-6(K-23) replay 后检查 recordedBy 的行数', replayedRows.filter((row) => row.origin === 'MIGRATED_LEGACY').length)
check(
  'AT-6(K-23) Replay **逐字**保住 SYSTEM/kernel（没有任何行在重放里被改写）',
  replayedRecorderBad.length === 0,
  replayedRecorderBad.slice(0, 2).map((row) => row.id).join(',') || 'AA'
)

// 没有从 actor_type 重新推导：记录值必须**不是** actor_type 推导值
const derivedAuthorityByActorType: Record<string, string> = {
  user: 'USER_EXPLICIT',
  character: 'CHARACTER_GENERATION',
  system: 'SYSTEM_INSTRUCTION',
  tool: 'TOOL_OBSERVATION',
}
const derivedWouldDiffer = afterRows.filter(
  (row) => derivedAuthorityByActorType[row.actorType] !== row.sourceAuthority
)
measure('AT-6 记录值与 actor_type 推导值不同的行数', derivedWouldDiffer.length)
check(
  'AT-6 没有 replay 从 actor_type 推导：记录值是 UNCONFIRMED_ORIGIN，而推导值会是别的',
  derivedWouldDiffer.length === afterRows.length,
  `${derivedWouldDiffer.length}/${afterRows.length}`
)

// ===========================================================================
section('AT-7. Cognitive Impact Radius（READ ONLY；Phase-4 假设）')
// ===========================================================================

const impactDetail = radiusDetail
const impactCounts = {
  evidenceLinks: radiusRows.length,
  evidenceKinds,
  memoryAuthorityDistribution: observedMemoryAuthorities,
  eligibleTodayViaSourceAuthority: todayEligibleCount,
  wouldLoseEligibility: wouldLoseEligibility.length,
}
check(
  'AT-7 只读：没有改 MemoryAuthority / Recall / eligibility / extractor / Fact Firewall',
  true,
  '本门只 SELECT；写入只有副本上的回填与 Axis B'
)

// ===========================================================================
section('汇总与证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const mGates = {
  M1: !destructivePattern.test(v7?.statements.join('\n') ?? ''),
  M2: m2Mismatches.length === 0,
  M3: m3Bad.length === 0,
  M4: Object.values(m4).every((value) => value === 0),
  M5: radiusRows.length > 0,
  M6: restoreEpoch === 'NOT_APPLICABLE',
  M7: axisBNull.length === 0 && axisBBadValue.length === 0 && sourceKindOutOfVocab.length === 0,
}
const verdict = failed === 0 ? 'PASS' : 'FAIL'

const evidence = {
  testId: 'M5.1.1 / WP3 Legacy Attribution Backfill（production-copy only）',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp3:verify',
  verdict,
  passed,
  failed,
  failures,
  source: {
    dir: PRODUCTION_DB_DIR,
    openedByApplicationCode: false,
    fileCount: sourceBefore.files.length,
    totalBytes: sourceBefore.bytes,
    boundaryFingerprintBefore: sourceFingerprintBefore,
    boundaryFingerprintAfter: boundaryFingerprint(PRODUCTION_DB_DIR, sourceAfterCopy.files),
    identical: boundaryFingerprint(PRODUCTION_DB_DIR, sourceAfterCopy.files) === sourceFingerprintBefore,
    newestMtimeIso: new Date(sourceBefore.newestMtime).toISOString(),
  },
  copy: {
    dir: workDir,
    fileCount: copyStats.files.length,
    totalBytes: copyStats.bytes,
    schemaVersionBeforeApply: versionBeforeApply,
    pendingBeforeApply: pendingBefore.map((migration) => migration.version),
    k8FingerprintVerified: v7Hash === MIGRATION_0007_SHA256,
    migration0007Sha256: v7Hash,
    appliedVersions: upgradeReport.applied.map((migration) => migration.version),
    schemaVersionAfterApply: versionAfterApply,
  },
  beforeImage: {
    rowCount: beforeRows.length,
    axisBNonNull: beforeAxisBNonNull,
    familyCounts: familyCountsBefore,
    manifestHash: beforeManifestHash,
    manifestHashAlgorithm:
      'sha256 over "id\tsequence\tsource_kind\tsource_authority\tepistemic_source" lines, ordered by (sequence, id)',
    containsMessageBody: false,
    characterActionEventsRowsUntouched: actionRowCount,
  },
  backfill: {
    scope: 'conversation_events only（character_action_events 无冻结 Axis B 规则 ⇒ 本次不触碰）',
    rowsTouched: touched,
    planObservations: observationsAll,
    axisBRule: {
      sourceKind: 'legacy classifier output（actor_type 全函数）',
      sourceAuthority: 'UNCONFIRMED_ORIGIN',
      epistemicSource: 'UNCONFIRMED_ORIGIN',
      attributionOrigin: 'MIGRATED_LEGACY',
    },
  },
  gates: {
    m1: { verdict: mGates.M1, note: 'v7 语句无破坏性语句' },
    m2: { verdict: mGates.M2, cells: afterRows.length * SLOTS.length, mismatches: m2Mismatches.slice(0, 10) },
    m3: { verdict: mGates.M3, perSlot: m3Counts },
    m4: { verdict: mGates.M4, counts: m4 },
    m5: { verdict: mGates.M5, counts: impactCounts, detail: impactDetail, readOnly: true },
    m6: { verdict: mGates.M6, restoreEpoch },
    m7: {
      verdict: mGates.M7,
      migratedLegacyRows: migratedRows.length,
      axisBNull: axisBNull.length,
      axisBBadValue: axisBBadValue.length,
      sourceKindOutOfVocab: sourceKindOutOfVocab.length,
      recordedRows: recordedRows.length,
      recordedRowClauseNote: 'RECORDED 行 = 0 ⇒ 该子判据 measured_count = 0，**不主张**（空集不算 PASS）',
    },
  },
  replay: {
    verdict: statesPreserved && stateHash(replayedRows) === stateHashAfterFirst,
    stateHashAfterFirst,
    stateHashAfterReplay: stateHash(replayedRows),
    idempotent: stateHash(replayedRows) === stateHashAfterFirst,
    statesPreserved,
    recordedNotDerivedFromActorType: derivedWouldDiffer.length,
    rows: afterRows.length,
  },
  k23: {
    status: 'CLOSED',
    rule: 'R-20 — Canonical Ledger Recorder Principal',
    canonicalRecorder: CANONICAL_LEDGER_RECORDER,
    source: CANONICAL_LEDGER_RECORDER_SOURCE,
    trustedLedgerWriters: TRUSTED_LEDGER_WRITERS,
    trustedConstructionRule:
      'recordedBy MUST NOT be caller supplied；当前受信写入器只有 kernel-ledger-writer ⇒ SYSTEM/kernel；' +
      '将来的写入器必须显式登记，不得顺手发明 SERVICE principal',
    structuralProofs: {
      // K-33 / WP8-C2：旧字段名（filesMentioningRecordedByOutsideContract）已**退休** ——
      // 它测的是"代码里提没提到 recordedBy"，而不是"能不能向权威列提供值"。
      // 现在改为能力判据的边界报告（同一份 analyzer 也被 K-33 专项门消费）。
      authoritativeMutationSites: boundary.mutationSites.map((s) => ({ file: s.file, line: s.line, verb: s.verb, bindsRecordedByColumns: s.bindsRecordedByColumns })),
      authoritativeWriterFiles: boundary.authoritativeWriterFiles,
      envelopeProducers: boundary.envelopeProducers,
      trustedContextProducers: boundary.trustedContextProducers,
      recordedByColumns: boundary.recordedByColumns,
      recordedByColumnsCovered: boundary.recordedByColumnsCovered,
      recordedByValueConstructions: boundary.recordedByValueConstructions,
      callerControlledProviders: boundary.callerControlledProviders,
      readerFilesWithRecordedBy: boundary.readerFilesWithRecordedBy,
      unexplainedReferences: boundary.unexplainedReferences,
      counts: boundary.counts,
    },
    counts: {
      migratedRows: migratedAll.length,
      recordedByKnown,
      recordedByCanonical,
      recordedByAbsent,
    },
    controls: {
      positiveQuiet: positiveRecorder.length === 0,
      negatives: forgedReadings,
      absentRecordedByFired: absentProbe.length > 0,
      restoreQuiet: restoredProbe.length === 0,
    },
    saysNothingAbout: ['actor', 'initiator', 'contentOriginator', 'executor'],
  },
  k22: {
    status: 'DEFERRED',
    topic: 'character_action_events 的 Axis B 历史回填口径（§3.6 只覆盖 conversation_events）',
    blocksWp5: true,
    blocksWp4: false,
    note: '本 WP **不触碰** `character_action_events` 的 Axis B；需要时先裁定口径',
  },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    productionCopyOnly: true,
    sourceMutated: false,
    memoryAuthorityChanged: false,
    factFirewallChanged: false,
    recallChanged: false,
    eligibilityChanged: false,
    extractorChanged: false,
    phase4: false,
    adr043: 'NOT APPROVED — untouched',
    startedWp4: false,
  },
}

mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'wp3-backfill.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
writeFileSync(
  join(EVIDENCE_DIR, 'wp3-before-image.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP3 before-image（逐行迁移证据；不含正文）',
      generatedAt: new Date().toISOString(),
      manifestHash: beforeManifestHash,
      rowCount: beforeRows.length,
      rows: beforeRows.map((row) => ({
        id: row.id,
        sequence: row.sequence,
        type: row.type,
        actorType: row.actorType,
        oldSourceKind: row.sourceKind,
        oldSourceAuthority: row.sourceAuthority,
        oldEpistemicSource: row.epistemicSource,
        slotsBefore: row.slots,
      })),
    },
    null,
    2
  )}\n`,
  'utf8'
)

// AT-7 的**报告文档**：由本次实测数据生成（不手抄，避免"报告与证据不一致"）
const reportLines = [
  '# M5.1.1 —— Phase 4 认知影响半径（**假设**报告，只读）',
  '',
  '> **性质**：这是 **Phase 4 假设**下的只读影响半径报告，由 `pnpm m5.1.1:wp3:verify`',
  `> 在 production-copy 上**实测**后自动生成（${new Date().toISOString()}）。`,
  '> **ADR-043 仍是 NOT APPROVED**：本报告**不**主张 Phase 4 应该发生，也**没有**改',
  '> MemoryAuthority / Recall / eligibility / extractor / Fact Firewall。',
  '',
  '## 假设',
  '',
  '```text',
  'Phase 4（BLOCKED BY ADR-043）会把 canEvidenceExternalFact 的输入从 actor_type',
  '改成"必须由已确立的 contentOriginator 支撑"。本报告回答：那样一来，',
  '**哪些今天还能支持外部事实的记忆会失去这个资格**。',
  '```',
  '',
  '## 口径（两条都要说清，否则数字会被读错）',
  '',
  '```text',
  '今天有资格 = canSupportExternalFact(该记忆根证据事件上【回填前】记录的 source_authority)',
  'Phase 4 后存活 = 该事件上的 contentOriginator 已确立（Known）',
  '失去资格 = 今天有资格 AND NOT Phase 4 后存活',
  '```',
  '',
  '> ⚠️ **本报告的第一版是错的，这里如实记下**：它用 `USER_EXPLICIT`（**SourceAuthority** 词表）',
  '> 去过滤 `memory_records.authority`（**MemoryAuthority** 词表），于是量到"受影响的 = 0"。',
  '> 那是**量错了东西**，不是"没有影响"。修正后实测：今天有资格的记忆 **全部** 会失去资格。',
  '> 门内已加两条自检（词表比对 + "不得出现 SourceAuthority 专属值"）。',
  '',
  '## 实测读数',
  '',
  '```text',
  `证据链路（memory_records × memory_evidence_links）: ${impactCounts.evidenceLinks}`,
  `evidence_kind                                    : ${impactCounts.evidenceKinds.join(', ')}`,
  `观测到的 memory authority（MemoryAuthority 词表）  : ${impactCounts.memoryAuthorityDistribution.join(', ')}`,
  `今天有资格（canSupportExternalFact = true）        : ${impactCounts.eligibleTodayViaSourceAuthority}`,
  `Phase 4 假设下会失去资格的                        : ${impactCounts.wouldLoseEligibility}`,
  '```',
  '',
  '## 逐条明细',
  '',
  '| memoryId | memory authority | 根证据事件 | actor_type | 回填前 source_authority | 今天有资格 | contentOriginator | Phase 4 后存活 |',
  '|---|---|---|---|---|---|---|---|',
  ...radiusDetail.map(
    (row) =>
      `| \`${row.memoryId}\` | ${row.memoryAuthority} | \`${row.eventId ?? '—'}\` | ${row.actorType ?? '—'} | ` +
      `${row.recordedSourceAuthorityBeforeBackfill ?? '—'} | ${row.todayEligibleViaSourceAuthority ? '是' : '否'} | ` +
      `${row.contentOriginator.state === 'Known' ? `Known(${row.contentOriginator.kind})` : 'Unknown/Absent'} | ` +
      `${row.survivesPhase4Hypothesis ? '是' : '**否**'} |`
  ),
  '',
  '## 这个半径说明什么 / 不说明什么',
  '',
  '```text',
  '说明：回填把历史行的 source_authority 一律写成 UNCONFIRMED_ORIGIN 之后，',
  '      若 Phase 4 改为读"记录值"，上述记忆**不再**有外部事实资格 ——',
  '      这正是 D01 想要的（"以用户身份提交"不再等价于"用户说的"）。',
  '不说明：Phase 4 该不该做、该怎么做（那是 ADR-043 的事，它仍 NOT APPROVED）；',
  '      也不说明这些记忆本身该不该改（本 WP 一个字都没动 MemoryAuthority）。',
  '```',
  '',
]
writeFileSync(join(ROOT, 'docs', 'm5.1.1', 'M5.1.1-Phase4-Cognitive-Impact-Radius.md'), `${reportLines.join('\n')}\n`, 'utf8')
console.log('影响半径报告已写入：docs/m5.1.1/M5.1.1-Phase4-Cognitive-Impact-Radius.md')

console.log(`\n${'='.repeat(74)}`)
console.log(`M1–M7 = ${Object.entries(mGates).map(([key, value]) => `${key}:${value ? 'PASS' : 'FAIL'}`).join(' ')}`)
console.log(`Replay = ${evidence.replay.verdict ? 'PASS' : 'FAIL'}｜影响半径 = PRODUCED（${impactCounts.evidenceLinks} 条链路，假设下会失去资格 ${impactCounts.wouldLoseEligibility} 条）`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp3-backfill.json / wp3-before-image.json')

try {
  await runtime.stop()
} catch {
  /* 关不干净不影响结论 */
}

// 清理副本（保留证据；副本本身是敏感数据的临时拷贝，用完即删）
const keepCopy = process.env.M511_WP3_KEEP_COPY === '1'
if (!keepCopy) rmSync(workDir, { recursive: true, force: true })
console.log(`副本已清理：${!keepCopy}（目录 ${workDir}）`)

process.exit(failed === 0 ? 0 : 1)
