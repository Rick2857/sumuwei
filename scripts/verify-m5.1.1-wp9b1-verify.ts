/**
 * M5.1.1 / WP9-B1 —— **R-45 落地验证**（`pnpm m5.1.1:wp9b1:verify`）。
 *
 * ============================================================================
 *  这一 WP 要证明什么（用户裁定 R-45 = SELECTED B）
 * ============================================================================
 *  ① **契约**：必要性矩阵多出**恰好一个**新族（`state_transition`），它的六个单元格
 *     是冻结值；它**不在** Cognitive Axis B 里；它**在**契约层的"回填 U 分类未冻结"名单里；
 *     矩阵仍然**只有一份**（`NECESSITY_MATRIX` 只在契约里定义，消费者只 import）。
 *  ② **判据仍然双向**：`REQUIRED` 写成 `Absent` 必被拒；必须 `ABSENT` 的槽位被填必被拒
 *     —— 两半都走**既有**的 canonical validator（本脚本不写第二套判据）。
 *  ③ **DDL**：`MIGRATION_0009` 存在、**纯追加**、**只碰 `state_events`**、
 *     恰好 19 列 + 19 条 CHECK、**没有 Axis B 列**、**没有索引**、**没有数据语句**。
 *  ④ **round-trip**（隔离库）：带信封的行解码回逐字三态；**不带信封**的行读回
 *     "没有信封"（`undefined`，而不是"每格 Absent"）；`Unknown(reason)` 与 `Absent`
 *     **不塌缩**。
 *  ⑤ **负控**：(a) 违反三态 CHECK 的值被**数据库**拒绝；(b) `trigger='init'` 但不给
 *     受信信封 ⇒ **不产生**任何归因（不推断 SYSTEM）；(c) 调用方手写的
 *     `SYSTEM/<id>` 信封**到不了**权威槽位（B1 强制的那一半 = 受信标记 + 必要性矩阵；
 *     生产者的另一半 = WP9-B2）。
 *  ⑥ **不回填**：把隔离库回退到 v8、插一条"v9 之前形状"的 `trigger='init'` 行、
 *     再 apply v9 ⇒ 该行 11 个原列逐字段未变、`attribution_origin` 仍为 NULL、
 *     全表非空 origin 计数 = 0。
 *
 * ============================================================================
 *  量具纪律（AGENTS §6.2 / §6.7 / §6.8）
 * ============================================================================
 *  · 计数型检测器一律先过 `measure()`：`count === 0` ⇒ **MEASUREMENT INVALID**，不是 PASS。
 *  · 正控（合法信封必须能落库并逐字解码）/ 负控（三种伪造与越权必须响）/
 *    恢复（放回真实实现 ⇒ 重新安静且库无残留）三段式。
 *  · 只开隔离库（`isolateDatabase()` 在最前面）；真实库只被记录路径，从不被打开。
 *
 * 跑法：pnpm m5.1.1:wp9b1:verify
 */

import 'dotenv/config'

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import { PRODUCTION_DB_DIR, isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'
import { createInitialState } from '../src/state/types.ts'
import {
  readStateEventAttribution,
  recordStateEvent,
  stateEventAttributionOfRow,
} from '../src/state/repository.ts'
import {
  MIGRATIONS,
  latestSchemaVersion,
} from '../src/infrastructure/persistence/migrations.ts'
import {
  applyKernelMigrations,
  currentSchemaVersion,
  rowsOf,
} from '../src/infrastructure/persistence/db.ts'
import {
  ATTRIBUTION_EVENT_FAMILIES,
  ATTRIBUTION_NON_SLOT_COLUMNS,
  ATTRIBUTION_SLOT_COLUMNS,
  ATTRIBUTION_V7_COLUMNS,
  BACKFILL_CONTRACT_DEFERRED_FAMILIES,
  COGNITIVE_AXIS_B_FAMILIES,
  CONVERSATION_BACKFILL_CLASSIFICATION,
  NECESSITY_MATRIX,
  STATE_TRANSITION_SYSTEM_ORIGIN_RULE,
  assertAttributionNecessity,
  constructTrustedAttribution,
  isCognitiveAxisBApplicable,
  isTrustedAttribution,
  storedAttributionOfRow,
  validateAttributionNecessity,
  type AttributionEnvelope,
  type AuthorityRef,
  type TrustedAttribution,
} from '../src/kernel/contracts/attribution.ts'
import {
  attributionAbsent,
  attributionKnown,
  attributionUnknown,
  type PrincipalRef,
} from '../src/kernel/contracts/actor.ts'

// ---------------------------------------------------------------------------
// 检查器
// ---------------------------------------------------------------------------

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

/** 计数型检测器的**最低自检**：`measured_count > 0` 才允许谈 PASS */
function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) {
    check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  }
  return count
}

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')

// ---------------------------------------------------------------------------
// 沙箱（必须在碰数据库之前）
// ---------------------------------------------------------------------------

const sandbox = isolateDatabase('m5.1.1-wp9b1')

// ===========================================================================
section('0. 隔离与边界')
// ===========================================================================

console.log(`  [sandbox] ${sandbox.dir}`)
check(
  '本脚本跑在临时目录里，且该目录不是真实库（也不是它的父子目录）',
  isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()),
  sandbox.dir
)
check(
  '真实库路径只被记录、从未被打开',
  PRODUCTION_DB_DIR.endsWith(join('data', 'pglite')) && process.env.PGLITE_DATA_DIR !== PRODUCTION_DB_DIR,
  PRODUCTION_DB_DIR
)

// ===========================================================================
section('1. 契约：恰好一个新族 + 冻结单元格 + 非 Axis B + 回填分类未冻结 + 单一矩阵')
// ===========================================================================

/** B1 之前冻结的九个族（历史真相；新族必须是**差集里的唯一元素**） */
const FAMILIES_BEFORE_WP9B1 = [
  'user_message',
  'assistant_message',
  'system_event',
  'tool_event',
  'action_requested',
  'action_authorized',
  'action_side_effect_execution',
  'action_read_only_diagnostic',
  'developer_control',
] as const

const familiesNow = [...ATTRIBUTION_EVENT_FAMILIES]
measure('契约里的事件族数', familiesNow.length)
const addedFamilies = familiesNow.filter(
  (family) => !(FAMILIES_BEFORE_WP9B1 as readonly string[]).includes(family)
)
const removedFamilies = (FAMILIES_BEFORE_WP9B1 as readonly string[]).filter(
  (family) => !(familiesNow as readonly string[]).includes(family)
)
check(
  '★ 恰好新增一个族，且是 `state_transition`（没有多、没有少、没有改名）',
  familiesNow.length === FAMILIES_BEFORE_WP9B1.length + 1 &&
    addedFamilies.length === 1 &&
    addedFamilies[0] === 'state_transition' &&
    removedFamilies.length === 0,
  `新增 [${addedFamilies.join(',')}] · 移除 [${removedFamilies.join(',')}]`
)

const STATE_FAMILY = 'state_transition' as const
const FROZEN_STATE_TRANSITION_ROW = {
  subject: 'DERIVED',
  initiator: 'REQUIRED',
  actor: 'REQUIRED',
  executor: 'ABSENT',
  authority: 'REQUIRED',
  recordedBy: 'REQUIRED',
  contentOriginator: 'ABSENT',
} as const
const stateRow = NECESSITY_MATRIX[STATE_FAMILY]
const stateRowCells = {
  subject: stateRow.subject,
  initiator: stateRow.initiator,
  actor: stateRow.actor,
  executor: stateRow.executor,
  authority: stateRow.authority,
  recordedBy: stateRow.recordedBy,
  contentOriginator: stateRow.contentOriginator,
}
const rowCellCount = measure('state_transition 矩阵行的单元格数', Object.keys(stateRowCells).length)
check(
  '★ state_transition 的矩阵行逐格 == 冻结值（系统发起 / 谁决定并施加 / 无独立执行者 / 真实系统规则 / 账本写入器 / 不是内容主张）',
  JSON.stringify(stateRowCells) === JSON.stringify(FROZEN_STATE_TRANSITION_ROW),
  JSON.stringify(stateRowCells)
)
check('state_transition 的 subject = DERIVED（派生语义，不落列）', stateRow.subject === 'DERIVED')
check('冻结单元格数自检 = 7（六个槽位 + subject）', rowCellCount === 7, `${rowCellCount}`)

check(
  '★ state_transition **不在** COGNITIVE_AXIS_B_FAMILIES 里，且 isCognitiveAxisBApplicable === false',
  !COGNITIVE_AXIS_B_FAMILIES.includes(STATE_FAMILY) &&
    isCognitiveAxisBApplicable(STATE_FAMILY) === false,
  `axisB 族 = ${COGNITIVE_AXIS_B_FAMILIES.join(',')}`
)
check(
  '★ state_transition **在** BACKFILL_CONTRACT_DEFERRED_FAMILIES 里，且**不在**对话回填分类表里',
  BACKFILL_CONTRACT_DEFERRED_FAMILIES.includes(STATE_FAMILY) &&
    !(STATE_FAMILY in CONVERSATION_BACKFILL_CLASSIFICATION),
  `deferred ${BACKFILL_CONTRACT_DEFERRED_FAMILIES.length} 个族`
)
check(
  'SYSTEM 溯源规则成文：只能来自组件自己的受信身份，且逐条点名禁止的推导来源',
  STATE_TRANSITION_SYSTEM_ORIGIN_RULE.includes('受信身份') &&
    ['trigger', 'payload', 'actor_type', 'requestedBy', 'transport'].every((needle) =>
      STATE_TRANSITION_SYSTEM_ORIGIN_RULE.includes(needle)
    ),
  STATE_TRANSITION_SYSTEM_ORIGIN_RULE.slice(0, 60) + '…'
)

/** K-29 的同型检查：矩阵只许有一份定义（消费者只能 import） */
function walkTs(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walkTs(abs, acc)
    else if (name.endsWith('.ts')) acc.push(abs)
  }
}
const srcFiles: string[] = []
walkTs(join(ROOT, 'src'), srcFiles)
measure('扫描的 src 源文件数', srcFiles.length)
const matrixDefiners = srcFiles.filter((file) =>
  /export\s+const\s+NECESSITY_MATRIX\s*[:=]/.test(readFileSync(file, 'utf8'))
)
measure('在 src 里"定义" NECESSITY_MATRIX 的文件数', matrixDefiners.length)
check(
  '★ NECESSITY_MATRIX 仍然**只有一份**定义（且位于契约 attribution.ts）',
  matrixDefiners.length === 1 &&
    matrixDefiners[0]!.replace(/\\/g, '/').endsWith('src/kernel/contracts/attribution.ts'),
  matrixDefiners.map((file) => file.replace(ROOT, '')).join(',')
)

// ===========================================================================
section('2. 必要性判据（**双向**，走 canonical validator）')
// ===========================================================================

const characterIdForEnvelope = 'char_wp9b1_contract'
const legalStateEnvelope = (): AttributionEnvelope => ({
  subject: { kind: 'CHARACTER', id: characterIdForEnvelope } as PrincipalRef,
  initiator: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: 'state-bootstrap' } as PrincipalRef),
  actor: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: 'state-bootstrap' } as PrincipalRef),
  executor: attributionAbsent<PrincipalRef>(),
  authority: attributionKnown<AuthorityRef>({ kind: 'SYSTEM_RULE', ref: 'state-bootstrap-rule' }),
  recordedBy: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: 'kernel' } as PrincipalRef),
  contentOriginator: attributionAbsent<PrincipalRef>(),
  attributionOrigin: 'RECORDED',
})

const requiredAbsentViolations = validateAttributionNecessity({
  family: STATE_FAMILY,
  envelope: legalStateEnvelope(),
})
check(
  '正控：冻结行对应的合法信封**零违规**（判据不是恒真的）',
  requiredAbsentViolations.length === 0,
  `${requiredAbsentViolations.length} 条违规`
)

const requiredMissing = validateAttributionNecessity({
  family: STATE_FAMILY,
  envelope: { ...legalStateEnvelope(), initiator: attributionAbsent<PrincipalRef>() },
})
const requiredMissingCodes = requiredMissing.map((violation) => `${violation.slot}/${violation.code}`)
check(
  '★ 负控①：REQUIRED 的 initiator 写成 Absent ⇒ **被拒**（required_slot_absent）',
  requiredMissing.some(
    (violation) => violation.slot === 'initiator' && violation.code === 'required_slot_absent'
  ),
  requiredMissingCodes.join(' · ') || '(没有违规 —— 判据哑了)'
)

const mustAbsentFilled = validateAttributionNecessity({
  family: STATE_FAMILY,
  envelope: {
    ...legalStateEnvelope(),
    executor: attributionKnown<PrincipalRef>({ kind: 'TOOL', id: 'state-writer' } as PrincipalRef),
    contentOriginator: attributionKnown<PrincipalRef>({ kind: 'USER', id: 'u-1' } as PrincipalRef),
  },
})
const mustAbsentCodes = mustAbsentFilled.map((violation) => `${violation.slot}/${violation.code}`)
check(
  '★ 负控②：必须 ABSENT 的 executor / contentOriginator 被填 ⇒ **被拒**（absent_slot_filled_concrete，两格都响）',
  mustAbsentFilled.filter((violation) => violation.code === 'absent_slot_filled_concrete').length === 2,
  mustAbsentCodes.join(' · ') || '(没有违规 —— 判据哑了)'
)

let failClosedCode: string | undefined
let failClosedThrew = false
try {
  assertAttributionNecessity({
    family: STATE_FAMILY,
    envelope: { ...legalStateEnvelope(), actor: attributionAbsent<PrincipalRef>() },
  })
} catch (error) {
  failClosedThrew = true
  failClosedCode = (error as { code?: string }).code
}
check(
  '★ 失败关闭版本：assertAttributionNecessity 对违规信封必抛 `attribution_necessity_violation`',
  failClosedThrew && failClosedCode === 'attribution_necessity_violation',
  `code=${String(failClosedCode)}`
)

const judgeEvidence = {
  requiredSlotAbsentCodes: requiredMissingCodes,
  absentSlotFilledCodes: mustAbsentCodes,
  failClosedCode: String(failClosedCode),
}

// ===========================================================================
section('3. DDL：MIGRATION_0009 的半径（纯追加、只碰 state_events、无 Axis B、无索引）')
// ===========================================================================

const v9 = MIGRATIONS.find((migration) => migration.version === 9)
measure('版本 9 的迁移条数', v9 === undefined ? 0 : 1)
check('MIGRATION_0009 存在（R-45 的物理承载）', v9 !== undefined, v9?.name ?? '(缺)')
check('代码最新 schema = 9', latestSchemaVersion() === 9, `v${latestSchemaVersion()}`)

const v9Statements = v9?.statements ?? []
const v9Sql = v9Statements.join('\n')
measure('v9 语句数', v9Statements.length)
const v9AddColumns = v9Statements.filter((statement) =>
  /^alter table state_events add column if not exists \w+ text$/.test(statement)
)
const v9AddConstraints = v9Statements.filter((statement) =>
  /^alter table state_events add constraint \w+ check \(/.test(statement)
)
measure('v9 的追加列语句数', v9AddColumns.length)
measure('v9 的追加约束语句数', v9AddConstraints.length)
check(
  '★ v9 的每一条语句都是 `add column if not exists` 或 `add constraint`（**纯追加**）',
  v9AddColumns.length + v9AddConstraints.length === v9Statements.length,
  `${v9AddColumns.length} + ${v9AddConstraints.length} vs ${v9Statements.length}`
)
check(
  '★ v9 只碰 `state_events`（每一条语句的目标表都是它）',
  v9Statements.every((statement) => /^alter table state_events /.test(statement)),
  'AA'
)
check(
  '★ v9 恰好追加 19 列（18 槽位列 + `attribution_origin`）',
  v9AddColumns.length === 19,
  `${v9AddColumns.length} 列`
)
const AXIS_B_COLUMNS = ATTRIBUTION_NON_SLOT_COLUMNS.slice(0, 3)
const v9ColumnNames = v9AddColumns.map((statement) =>
  statement.replace('alter table state_events add column if not exists ', '').replace(/ text$/, '')
)
check(
  '★ v9 **没有** Axis B 列（`source_kind` / `source_authority` / `epistemic_source` 一个都不加）',
  !AXIS_B_COLUMNS.some((column) => v9ColumnNames.includes(column)),
  AXIS_B_COLUMNS.filter((column) => v9ColumnNames.includes(column)).join(',') || '无'
)
const v9ExpectedColumns = ATTRIBUTION_V7_COLUMNS.filter(
  (column) => !AXIS_B_COLUMNS.includes(column)
)
check(
  'v9 的 19 列 == 契约的 22 列去掉 Axis B 三列（ATOMIC，逐列点名）',
  JSON.stringify([...v9ColumnNames].sort()) === JSON.stringify([...v9ExpectedColumns].sort()),
  `${v9ColumnNames.length} 列`
)
const v9ExpectedConstraints = [
  ...Object.values(ATTRIBUTION_SLOT_COLUMNS)
    .flatMap((columns) => columns.kind.replace(/_kind$/, ''))
    .flatMap((prefix) => [
      `state_events_${prefix}_tri_state`,
      `state_events_${prefix}_kind_vocab`,
      `state_events_${prefix}_reason_vocab`,
    ]),
  'state_events_attribution_origin_vocab',
]
const v9ConstraintNames = v9AddConstraints.map(
  (statement) => /add constraint (\w+) check/.exec(statement)?.[1] ?? '(解析失败)'
)
check(
  '★ v9 的 19 条约束名 == 6 槽 × (tri_state/kind_vocab/reason_vocab) + attribution_origin_vocab',
  JSON.stringify([...v9ConstraintNames].sort()) ===
    JSON.stringify([...v9ExpectedConstraints].sort()),
  v9ConstraintNames.join(',')
)
check(
  '★ v9 **没有**索引、**没有**数据语句（不回填、不删改既有行）',
  !/create\s+index/i.test(v9Sql) &&
    !/\b(insert|update|delete|truncate)\b/i.test(v9Sql) &&
    !/drop\s+(column|table|constraint|index)/i.test(v9Sql),
  '0 条'
)
const v9Fingerprint = createHash('sha256').update(v9Sql, 'utf8').digest('hex')
/*
 * v9 的**内容指纹**：与 `pnpm m5.1.1:migration:verify` 的 `FROZEN_MIGRATION_FINGERPRINTS[9]`
 * 是同一个值。锁定的触发点是"副本上第一次成功的 v6 → v9 apply"
 * （`pnpm m5.1.1:prod-copy:verify`，evidence = `wp9b1-production-copy-v9.json`）。
 * 两处独立读数一致 ⇒ "锁住的那份 DDL"与"本门实测的那份 DDL"是同一份。
 */
const FROZEN_0009 = '5a007003b773351fc870865e541e8d3e2a9e00ccf8e227f3c2b41eb1d5a8c27c'
check(
  '★ v9 语句指纹 == 冻结值（与 migration 门的 FROZEN_MIGRATION_FINGERPRINTS[9] 同值）',
  v9Fingerprint === FROZEN_0009,
  `${v9Fingerprint.slice(0, 16)}…`
)
const pc = (() => {
  try {
    return JSON.parse(
      readFileSync(join(EVIDENCE_DIR, 'wp9b1-production-copy-v9.json'), 'utf8')
    ) as { verdict?: string; boundaries?: { migrationBoundary?: { appliedVersions?: number[] } } }
  } catch {
    return {}
  }
})()
check(
  'v9 的锁有真实触发点：production-copy 副本上 v6 → v9 的 apply 记录存在且 = PASS（applied=[7,8,9]）',
  pc.verdict === 'PASS' &&
    JSON.stringify(pc.boundaries?.migrationBoundary?.appliedVersions) === JSON.stringify([7, 8, 9]),
  `verdict=${String(pc.verdict)} applied=${JSON.stringify(pc.boundaries?.migrationBoundary?.appliedVersions)}`
)

// ===========================================================================
section('4. 隔离库：round-trip（带信封 / 不带信封 / Unknown ≠ Absent）')
// ===========================================================================

const h = await createM4Harness({ label: 'wp9b1' })
const db = h.db
const runtime = h.runtime
const schemaVersion = await currentSchemaVersion(db)
measure('沙箱 schema 版本', schemaVersion)
check('沙箱库 = 代码最新 schema v9', schemaVersion === 9, `v${schemaVersion}`)

const characterId = String(h.kernel.characterId)
const userId = String(h.userId)
const T0 = 1_800_000_000_000

const baseState = createInitialState(characterId, userId, T0)
const stateAfter = (version: number) => ({ ...baseState, version, updatedAt: T0 + version })

async function attributionColumnsOfRow(id: string): Promise<Record<string, unknown> | undefined> {
  const columns = [
    'attribution_origin',
    ...Object.values(ATTRIBUTION_SLOT_COLUMNS).flatMap((names) => [
      names.kind,
      names.id,
      names.unknownReason,
    ]),
  ]
  const rows = rowsOf(
    await db.execute(
      sql`select ${sql.raw(columns.join(', '))} from state_events where id = ${id} limit 1`
    )
  ) as Record<string, unknown>[]
  return rows[0]
}

/** ① 带信封（Actor = Known(SYSTEM/state-bootstrap)） */
const legalEnvelope = legalStateEnvelope()
const trustedEnvelope = constructTrustedAttribution({
  family: STATE_FAMILY,
  envelope: { ...legalEnvelope, subject: { kind: 'CHARACTER', id: characterId } as PrincipalRef },
})
check(
  '受信构造器返回带 `TRUSTED_INGRESS_MARK` 的信封（isTrustedAttribution === true）',
  isTrustedAttribution(trustedEnvelope),
  'trustedIngress 标记存在'
)
const withEnvelope = await recordStateEvent(runtime, {
  before: baseState,
  delta: { trust: 0.05 },
  after: stateAfter(1),
  reason: 'WP9-B1 round-trip：带受信信封',
  trigger: 'init',
  attribution: trustedEnvelope,
})
const withEnvelopeReadback = await readStateEventAttribution(runtime, withEnvelope.id)
check(
  '★ round-trip①：带信封的行 `found = true` 且 origin = RECORDED',
  withEnvelopeReadback.found === true &&
    withEnvelopeReadback.attribution?.attributionOrigin === 'RECORDED',
  `origin=${String(withEnvelopeReadback.attribution?.attributionOrigin)}`
)
const decoded = withEnvelopeReadback.attribution
const decodeCell = (slot: keyof typeof ATTRIBUTION_SLOT_COLUMNS): string => {
  const value = decoded?.slots[slot]
  if (value === undefined) return '(缺)'
  if (value.state === 'KNOWN') {
    const ref = value.value as { kind?: string; id?: string; ref?: string }
    return `KNOWN|${ref.kind}|${ref.id ?? ref.ref}`
  }
  if (value.state === 'UNKNOWN') return `UNKNOWN|${value.reason}`
  return 'ABSENT'
}
const decodedCells = {
  initiator: decodeCell('initiator'),
  actor: decodeCell('actor'),
  executor: decodeCell('executor'),
  authority: decodeCell('authority'),
  recordedBy: decodeCell('recordedBy'),
  contentOriginator: decodeCell('contentOriginator'),
}
measure('round-trip① 解码出的槽位数', Object.keys(decodedCells).length)
check(
  '★ round-trip①：六个槽位逐字解码回写入时的三态（SYSTEM 没有被折叠成 Absent）',
  decodedCells.initiator === 'KNOWN|SYSTEM|state-bootstrap' &&
    decodedCells.actor === 'KNOWN|SYSTEM|state-bootstrap' &&
    decodedCells.executor === 'ABSENT' &&
    decodedCells.authority === 'KNOWN|SYSTEM_RULE|state-bootstrap-rule' &&
    decodedCells.recordedBy === 'KNOWN|SYSTEM|kernel' &&
    decodedCells.contentOriginator === 'ABSENT',
  JSON.stringify(decodedCells)
)

/** ② 带信封但 actor = Unknown(RUNTIME_UNRESOLVED) ⇒ 必须与 Absent 区分开 */
const unknownEnvelope = constructTrustedAttribution({
  family: STATE_FAMILY,
  envelope: {
    ...legalEnvelope,
    subject: { kind: 'CHARACTER', id: characterId } as PrincipalRef,
    actor: attributionUnknown<PrincipalRef>('RUNTIME_UNRESOLVED'),
    executor: attributionAbsent<PrincipalRef>(),
  },
})
const withUnknown = await recordStateEvent(runtime, {
  before: baseState,
  delta: {},
  after: stateAfter(2),
  reason: 'WP9-B1 round-trip：Unknown vs Absent',
  trigger: 'init',
  attribution: unknownEnvelope,
})
const withUnknownReadback = await readStateEventAttribution(runtime, withUnknown.id)
const unknownCells = {
  actor: withUnknownReadback.attribution
    ? (() => {
        const value = withUnknownReadback.attribution.slots.actor
        return value.state === 'UNKNOWN' ? `UNKNOWN|${value.reason}` : value.state
      })()
    : '(缺)',
  executor: withUnknownReadback.attribution
    ? (() => {
        const value = withUnknownReadback.attribution.slots.executor
        return value.state === 'ABSENT' ? 'ABSENT' : value.state
      })()
    : '(缺)',
}
check(
  '★ round-trip②：`Unknown(RUNTIME_UNRESOLVED)` 与 `Absent` **不塌缩**（同一行的两格各自逐字还原）',
  unknownCells.actor === 'UNKNOWN|RUNTIME_UNRESOLVED' && unknownCells.executor === 'ABSENT',
  JSON.stringify(unknownCells)
)

/** ③ 不带信封 ⇒ 读回"没有信封"（不是"每格 Absent"） */
const withoutEnvelope = await recordStateEvent(runtime, {
  before: baseState,
  delta: {},
  after: stateAfter(3),
  reason: 'WP9-B1 round-trip：不带信封',
  trigger: 'manual',
})
const withoutEnvelopeReadback = await readStateEventAttribution(runtime, withoutEnvelope.id)
check(
  '★ round-trip③：不带信封的行 `found = true` 但 `attribution === undefined`（"从未记录过归因"）',
  withoutEnvelopeReadback.found === true && withoutEnvelopeReadback.attribution === undefined,
  `found=${String(withoutEnvelopeReadback.found)} attribution=${String(withoutEnvelopeReadback.attribution)}`
)
const withoutEnvelopeCells = await attributionColumnsOfRow(withoutEnvelope.id)
const nonNullWithoutEnvelope = Object.entries(withoutEnvelopeCells ?? {}).filter(
  ([, value]) => value !== null && value !== undefined
)
check(
  '★ round-trip③：不带信封的行 19 个归因列**全为 NULL**（没有偷偷写默认值）',
  nonNullWithoutEnvelope.length === 0,
  nonNullWithoutEnvelope.map(([key]) => key).join(',') || '19/19 全 NULL'
)
/*
 * 行级读取器（`stateEventAttributionOfRow`）是 `storedAttributionOfRow` 的转调：
 * 同一份原始行在两条路径上必须给出**同一个**读数（否则就是又长出了第二个解码器）。
 */
const rowLevelReadback = stateEventAttributionOfRow((await attributionColumnsOfRow(withEnvelope.id)) ?? {})
check(
  '★ round-trip③b：行级读取器与按 id 回读给出**同一个**读数（没有第二个解码器）',
  JSON.stringify(rowLevelReadback) === JSON.stringify(withEnvelopeReadback.attribution),
  `rowLevel=${rowLevelReadback?.attributionOrigin ?? '(无)'} byId=${String(withEnvelopeReadback.attribution?.attributionOrigin)}`
)

/** ④ 读取器不是恒真：坏形状 / 坏 origin 必须抛（纯函数负控），真实行再读一次恢复安静 */
let badOriginThrew = false
let badOriginCode: string | undefined
try {
  storedAttributionOfRow({ attribution_origin: 'NOPE' })
} catch (error) {
  badOriginThrew = true
  badOriginCode = (error as { code?: string }).code
}
let mixedStateThrew = false
let mixedStateCode: string | undefined
try {
  storedAttributionOfRow({
    attribution_origin: 'RECORDED',
    actor_kind: 'SYSTEM',
    actor_ref_id: null,
    actor_unknown_reason: null,
  })
} catch (error) {
  mixedStateThrew = true
  mixedStateCode = (error as { code?: string }).code
}
let badVocabThrew = false
let badVocabCode: string | undefined
try {
  storedAttributionOfRow({
    attribution_origin: 'RECORDED',
    actor_kind: 'HACKER',
    actor_ref_id: 'x',
    actor_unknown_reason: null,
  })
} catch (error) {
  badVocabThrew = true
  badVocabCode = (error as { code?: string }).code
}
check(
  '★ 读取器负控：坏 `attribution_origin` 抛 `attribution_origin_invalid`',
  badOriginThrew && badOriginCode === 'attribution_origin_invalid',
  `code=${String(badOriginCode)}`
)
check(
  '★ 读取器负控：半填槽位（kind 有、id 无、reason 无）抛 `attribution_slot_shape_invalid`（fail closed，不猜三态）',
  mixedStateThrew && mixedStateCode === 'attribution_slot_shape_invalid',
  `code=${String(mixedStateCode)}`
)
check(
  '★ 读取器负控：形状合法但词汇越界（actor_kind=HACKER）抛 `attribution_slot_value_invalid`',
  badVocabThrew && badVocabCode === 'attribution_slot_value_invalid',
  `code=${String(badVocabCode)}`
)
const restored = await readStateEventAttribution(runtime, withEnvelope.id)
check(
  '恢复：放回真实行 ⇒ 读取器重新安静（同一行仍逐字解码成 RECORDED 信封）',
  restored.attribution?.attributionOrigin === 'RECORDED' &&
    restored.attribution.slots.actor.state === 'KNOWN',
  `origin=${String(restored.attribution?.attributionOrigin)}`
)

// ===========================================================================
section('5. 负控：(a) 库拒绝非法三态 / (b) trigger=init 不推断 SYSTEM / (c) 手写 SYSTEM 到不了权威槽位')
// ===========================================================================

/** (a) **数据库**必须拒绝违反三态 CHECK 的值（不是靠 TS 类型） */
async function rawStateEventInsert(fields: {
  id: string
  attributionOrigin?: string | null
  kind?: string | null
  refId?: string | null
  reason?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.execute(
      sql`insert into state_events
            (id, character_id, user_id, before_state, delta, after_state, reason, trigger,
             state_version, created_at, attribution_origin, actor_kind, actor_ref_id, actor_unknown_reason)
          values (${fields.id}, ${characterId}, ${userId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                  'wp9b1 raw', 'manual', 99, ${T0},
                  ${fields.attributionOrigin ?? null}, ${fields.kind ?? null},
                  ${fields.refId ?? null}, ${fields.reason ?? null})`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 200) }
  }
}
const dbProbes = [
  { label: 'kind=SYSTEM / id=NULL / reason=NULL（半填）', kind: 'SYSTEM', refId: null, reason: null },
  { label: 'kind=NULL / id=actor-1 / reason=NULL（只给 id）', kind: null, refId: 'actor-1', reason: null },
  { label: "kind='HACKER' / id 有（词表外）", kind: 'HACKER', refId: 'x', reason: null },
  {
    label: "attribution_origin='WHATEVER'（origin 词表外）",
    kind: 'SYSTEM',
    refId: 'state-bootstrap',
    reason: null,
    attributionOrigin: 'WHATEVER',
  },
]
measure('数据库三态/origin 探针数', dbProbes.length)
for (const probe of dbProbes) {
  const result = await rawStateEventInsert({ id: `probe-${probe.label}`, ...probe })
  check(
    `★ 负控 (a)：库拒绝 ${probe.label} ⇒ 被拒（而不是静默存下）`,
    result.ok === false,
    result.ok ? '竟然通过了（DB 没有在裁判）' : (result.error ?? '').slice(0, 90)
  )
}
const legalProbeRow = await rawStateEventInsert({
  id: 'probe-legal-tri-state',
  kind: 'SYSTEM',
  refId: 'state-bootstrap',
  reason: null,
  attributionOrigin: 'RECORDED',
})
check(
  '★ 负控 (a) 的正控：合法三态元组可以入账（探针不是靠"全都拒绝"通过）',
  legalProbeRow.ok === true,
  legalProbeRow.error ?? 'ok'
)

/** (b) `trigger='init'` **不给**受信信封 ⇒ 不产生任何归因（绝不从 trigger 推断 SYSTEM） */
const initWithoutEnvelope = await recordStateEvent(runtime, {
  before: baseState,
  delta: { valence: 0.01 },
  after: stateAfter(4),
  reason: 'WP9-B1 负控：init 但没有受信信封',
  trigger: 'init',
})
const initWithoutEnvelopeReadback = await readStateEventAttribution(runtime, initWithoutEnvelope.id)
const initCells = await attributionColumnsOfRow(initWithoutEnvelope.id)
check(
  "★ 负控 (b)：`trigger='init'` + 无信封 ⇒ `attribution === undefined`，19 个归因列全 NULL（**不推断** SYSTEM）",
  initWithoutEnvelopeReadback.attribution === undefined &&
    Object.values(initCells ?? {}).every((value) => value === null || value === undefined),
  `origin=${String(initCells?.attribution_origin)}`
)

/** (c) 调用方手写 `SYSTEM/<id>` ⇒ 到不了权威槽位（B1 强制的那一半） */
const countRows = async (): Promise<number> =>
  Number(
    (rowsOf(await db.execute(sql`select count(*)::int as c from state_events`)) as { c: number }[])[0]
      ?.c ?? -1
  )
const rowsBeforeForgery = await countRows()
const forgedEnvelope: AttributionEnvelope = {
  subject: { kind: 'CHARACTER', id: characterId } as PrincipalRef,
  initiator: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: 'state-bootstrap' } as PrincipalRef),
  actor: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: 'attacker-controlled' } as PrincipalRef),
  executor: attributionAbsent<PrincipalRef>(),
  authority: attributionKnown<AuthorityRef>({ kind: 'SYSTEM_RULE', ref: 'whatever-i-say' }),
  recordedBy: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: 'kernel' } as PrincipalRef),
  contentOriginator: attributionAbsent<PrincipalRef>(),
  attributionOrigin: 'RECORDED',
}
let forgeryCode: string | undefined
let forgeryThrew = false
try {
  await recordStateEvent(runtime, {
    before: baseState,
    delta: {},
    after: stateAfter(5),
    reason: 'WP9-B1 负控：手写 SYSTEM 信封',
    trigger: 'init',
    // 手写同形对象（没有 TRUSTED_INGRESS_MARK）—— 这正是"调用方自报权威槽位"的形状
    attribution: forgedEnvelope as unknown as TrustedAttribution,
  })
} catch (error) {
  forgeryThrew = true
  forgeryCode = (error as { code?: string }).code
}
const rowsAfterForgery = await countRows()
check(
  '★ 负控 (c)：调用方手写的 `SYSTEM/attacker-controlled` 信封 ⇒ `recordStateEvent` 抛 `untrusted_state_event_attribution`',
  forgeryThrew && forgeryCode === 'untrusted_state_event_attribution',
  `code=${String(forgeryCode)}`
)
check(
  '★ 负控 (c)：拒绝是**失败关闭**的 —— 库里的行数一个都没多（没有残留的伪造行）',
  rowsAfterForgery === rowsBeforeForgery,
  `${rowsBeforeForgery} → ${rowsAfterForgery}`
)
let callerSuppliedCode: string | undefined
let callerSuppliedThrew = false
try {
  constructTrustedAttribution({
    family: STATE_FAMILY,
    envelope: forgedEnvelope,
    callerSuppliedFields: ['actor', 'authority'],
  })
} catch (error) {
  callerSuppliedThrew = true
  callerSuppliedCode = (error as { code?: string }).code
}
check(
  '★ 负控 (c)：受信构造器拒绝"调用方自报 actor/authority"（`untrusted_attribution_field`）',
  callerSuppliedThrew && callerSuppliedCode === 'untrusted_attribution_field',
  `code=${String(callerSuppliedCode)}`
)
let untrustedDtoCode: string | undefined
let untrustedDtoThrew = false
try {
  constructTrustedAttribution({
    family: STATE_FAMILY,
    envelope: legalStateEnvelope(),
    untrustedDto: { contentOriginator: 'USER' },
  })
} catch (error) {
  untrustedDtoThrew = true
  untrustedDtoCode = (error as { code?: string }).code
}
check(
  '★ 负控 (c)：不可信 DTO 夹带 `contentOriginator` ⇒ 被拒（`untrusted_attribution_field`）',
  untrustedDtoThrew && untrustedDtoCode === 'untrusted_attribution_field',
  `code=${String(untrustedDtoCode)}`
)
check(
  '恢复：真实受信信封仍然可以落库并解码（拒绝伪造没有把正常路径一起堵死）',
  (await readStateEventAttribution(runtime, withEnvelope.id)).attribution?.attributionOrigin ===
    'RECORDED',
  'ok'
)

// ===========================================================================
section('6. 不回填：v8 → v9 之后，既有 `trigger=init` 行逐字段未变、origin 仍为 NULL')
// ===========================================================================

const rollbackColumns = v9ColumnNames
for (const column of rollbackColumns) {
  await db.execute(sql.raw(`alter table state_events drop column if exists ${column}`))
}
await db.execute(sql`delete from character_schema_migrations where version = 9`)
const rolledBackVersion = await currentSchemaVersion(db)
check('把 v9 的对象与登记回退掉 ⇒ 库看起来就是 v8', rolledBackVersion === 8, `v${rolledBackVersion}`)

const LEGACY_ID = 'legacy-init-v8-shaped'
await db.execute(
  sql`insert into state_events
        (id, character_id, user_id, before_state, delta, after_state, reason, trigger,
         state_version, message_id, created_at)
      values (${LEGACY_ID}, ${characterId}, ${userId},
              '{"valence":0,"arousal":0,"trust":0.85,"closeness":0.6,"version":0}'::jsonb,
              '{}'::jsonb,
              '{"valence":0,"arousal":0,"trust":0.85,"closeness":0.6,"version":0}'::jsonb,
              '首次见面：按初始状态建档', 'init', 0, ${null}, ${T0})`
)
const legacySnapshot = async (): Promise<Record<string, unknown> | undefined> => {
  const rows = rowsOf(
    await db.execute(
      sql`select id, character_id, user_id, before_state, delta, after_state, reason, trigger,
                 state_version, message_id, created_at
          from state_events where id = ${LEGACY_ID}`
    )
  ) as Record<string, unknown>[]
  return rows[0]
}
const legacyBefore = await legacySnapshot()
check(
  'v8 形状的 `trigger=init` 行已插入（11 列，没有任何归因列）',
  legacyBefore !== undefined && Object.keys(legacyBefore).length === 11,
  `${Object.keys(legacyBefore ?? {}).length} 列`
)
const totalRowsBeforeApply = await countRows()
measure('apply v9 之前 state_events 的总行数', totalRowsBeforeApply)

const v9Report = await applyKernelMigrations(db)
check(
  '在 v8 形状的库上 apply ⇒ 只应用 v9（from 8 → to 9）',
  v9Report.fromVersion === 8 &&
    v9Report.toVersion === 9 &&
    v9Report.applied.length === 1 &&
    v9Report.applied[0]!.version === 9,
  `from=${v9Report.fromVersion} to=${v9Report.toVersion} applied=[${v9Report.applied.map((m) => m.version).join(',')}]`
)
const legacyAfter = await legacySnapshot()
check(
  '★ 不回填：既有行（含首启那条）的 11 个原列**逐字段未变**',
  JSON.stringify(legacyAfter) === JSON.stringify(legacyBefore),
  JSON.stringify(legacyAfter) === JSON.stringify(legacyBefore) ? '逐字段一致' : '有字段被改了'
)
const legacyAttribution = await readStateEventAttribution(runtime, LEGACY_ID)
check(
  '★ 不回填：该行读回 `attribution === undefined`（"从未记录过归因"，不是"每格 Absent"）',
  legacyAttribution.found === true && legacyAttribution.attribution === undefined,
  `found=${String(legacyAttribution.found)} attribution=${String(legacyAttribution.attribution)}`
)
const nonNullOriginRows = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from state_events where attribution_origin is not null`
  )
) as { c: number }[]
const nonNullOriginCount = Number(nonNullOriginRows[0]?.c ?? -1)
check(
  '★ 不回填：apply v9 之后全表 `attribution_origin` 非空行数 = 0',
  nonNullOriginCount === 0,
  `${nonNullOriginCount} / ${totalRowsBeforeApply + ' 行（apply 前）'}`
)
const totalRowsAfterApply = await countRows()
check(
  '★ 不回填：v9 没有插入任何行（总行数与 apply 前一致）',
  totalRowsAfterApply === totalRowsBeforeApply,
  `${totalRowsBeforeApply} → ${totalRowsAfterApply}`
)

// ===========================================================================
section('7. 汇总与证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

mkdirSync(EVIDENCE_DIR, { recursive: true })

const fingerprintReadings = [7, 8, 9].map((version) => {
  const migration = MIGRATIONS.find((item) => item.version === version)
  return {
    version,
    name: migration?.name ?? '(缺)',
    statements: migration?.statements.length ?? 0,
    sha256:
      migration === undefined
        ? '(缺)'
        : createHash('sha256').update(migration.statements.join('\n'), 'utf8').digest('hex'),
  }
})
writeFileSync(
  join(EVIDENCE_DIR, 'wp9b1-schema.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP9-B1 schema landing (R-45: state_events attribution carrier)',
      generatedAt: new Date().toISOString(),
      command: 'pnpm m5.1.1:wp9b1:verify',
      sandbox: { dir: sandbox.dir, isProductionDir: isProductionDir(sandbox.dir) },
      productionDirRecorded: PRODUCTION_DB_DIR,
      latestSchemaVersion: latestSchemaVersion(),
      fingerprints: fingerprintReadings,
      v9: {
        name: v9?.name ?? '(缺)',
        statements: v9Statements,
        statementCount: v9Statements.length,
        sha256: v9Fingerprint,
        columns: v9ColumnNames,
        expectedColumns: [...v9ExpectedColumns],
        constraints: v9ConstraintNames,
        expectedConstraints: [...v9ExpectedConstraints],
        hasAxisBColumns: AXIS_B_COLUMNS.some((column) => v9ColumnNames.includes(column)),
        createsIndex: /create\s+index/i.test(v9Sql),
        hasDataStatements: /\b(insert|update|delete|truncate)\b/i.test(v9Sql),
      },
      contract: {
        familiesBefore: [...FAMILIES_BEFORE_WP9B1],
        familiesNow,
        addedFamilies,
        frozenRow: FROZEN_STATE_TRANSITION_ROW,
        observedRow: stateRowCells,
        axisBFamilies: [...COGNITIVE_AXIS_B_FAMILIES],
        isCognitiveAxisBApplicable: isCognitiveAxisBApplicable(STATE_FAMILY),
        inDeferredBackfillFamilies: BACKFILL_CONTRACT_DEFERRED_FAMILIES.includes(STATE_FAMILY),
        inConversationBackfillClassification: STATE_FAMILY in CONVERSATION_BACKFILL_CLASSIFICATION,
        systemOriginRule: STATE_TRANSITION_SYSTEM_ORIGIN_RULE,
        necessityMatrixDefiners: matrixDefiners.map((file) => file.replace(ROOT, '').replace(/\\/g, '/')),
      },
      judge: judgeEvidence,
      measurements,
      measurementInvalid: measurementInvalid.length,
      boundaryStatement: {
        enforcedInB1:
          '写入路径只接受 `TrustedAttribution`（带 TRUSTED_INGRESS_MARK）+' +
          '受信构造器过 canonical 必要性矩阵；手写同形对象被失败关闭拒绝',
        deferredToB2:
          '把状态引导组件**自己的受信身份**装进信封、并在生产调用点（src/state/init.ts）接线 —— ' +
          '本步**没有**改 init.ts，因此今天生产里仍然没有任何一条 state_events 带信封',
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

writeFileSync(
  join(EVIDENCE_DIR, 'wp9b1-roundtrip.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP9-B1 state_events attribution round-trip + negatives (isolated DB)',
      generatedAt: new Date().toISOString(),
      command: 'pnpm m5.1.1:wp9b1:verify',
      sandbox: { dir: sandbox.dir, isProductionDir: isProductionDir(sandbox.dir) },
      roundTrip: {
        withEnvelope: {
          id: withEnvelope.id,
          origin: withEnvelopeReadback.attribution?.attributionOrigin ?? null,
          decodedCells,
        },
        unknownVsAbsent: { id: withUnknown.id, cells: unknownCells },
        withoutEnvelope: {
          id: withoutEnvelope.id,
          found: withoutEnvelopeReadback.found,
          attribution: withoutEnvelopeReadback.attribution ?? null,
          nonNullAttributionColumns: nonNullWithoutEnvelope.map(([key]) => key),
        },
        readerNegativeControls: {
          badOrigin: { threw: badOriginThrew, code: String(badOriginCode) },
          mixedStateShape: { threw: mixedStateThrew, code: String(mixedStateCode) },
          outOfVocabulary: { threw: badVocabThrew, code: String(badVocabCode) },
          restoredQuiet: restored.attribution?.attributionOrigin === 'RECORDED',
        },
      },
      negatives: {
        dbRejects: dbProbes.map((probe) => ({ label: probe.label })),
        dbLegalPositiveControl: legalProbeRow.ok,
        triggerInitWithoutEnvelope: {
          id: initWithoutEnvelope.id,
          attribution: initWithoutEnvelopeReadback.attribution ?? null,
          attributionColumns: initCells ?? null,
        },
        callerSuppliedSystemEnvelope: {
          rejected: forgeryThrew,
          code: String(forgeryCode),
          rowsBefore: rowsBeforeForgery,
          rowsAfter: rowsAfterForgery,
        },
        callerSuppliedFields: { rejected: callerSuppliedThrew, code: String(callerSuppliedCode) },
        untrustedDtoCarryingAuthorityField: {
          rejected: untrustedDtoThrew,
          code: String(untrustedDtoCode),
        },
      },
      noBackfill: {
        rolledBackVersion,
        legacyRowId: LEGACY_ID,
        legacyRowColumns: Object.keys(legacyBefore ?? {}),
        legacyRowUnchanged: JSON.stringify(legacyAfter) === JSON.stringify(legacyBefore),
        legacyRowAttribution: legacyAttribution.attribution ?? null,
        rowsBeforeApply: totalRowsBeforeApply,
        rowsAfterApply: totalRowsAfterApply,
        nonNullAttributionOriginRows: nonNullOriginCount,
        applyReport: {
          fromVersion: v9Report.fromVersion,
          toVersion: v9Report.toVersion,
          applied: v9Report.applied.map((migration) => migration.version),
        },
      },
      measurements,
      measurementInvalid: measurementInvalid.length,
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\n${'='.repeat(74)}`)
console.log(`M5.1.1 WP9-B1（R-45 state_events 归因承载）：${passed} 通过 / ${failed} 失败`)
console.log(`量具自检：${measurements.length} 个计数检测器，无效 ${measurementInvalid.length}`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure}`)
}
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp9b1-schema.json / wp9b1-roundtrip.json')

try {
  await h.stop()
} catch {
  /* 关不干净不影响结论 */
}

process.exit(failed === 0 ? 0 : 1)
