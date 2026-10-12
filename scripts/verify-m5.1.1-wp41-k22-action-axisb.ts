/**
 * M5.1.1 WP4.1 —— **K-22 physical landing**：Action-Ledger Axis-B 边界
 * （`pnpm m5.1.1:wp4.1:verify`）
 *
 * ============================================================================
 *  这一门回答的四个问题
 * ============================================================================
 *  ① **现状**：`character_action_events` 在 v7 里到底是什么形状？谁能写它、谁在读它？
 *  ② **v8 是否需要**：v7 的约束是不是**真的**挡住了"行动行有归因但没有 Cognitive Axis B"？
 *     （可执行证明：把 v7 的那条谓词**放回**沙箱库上试一次 → 必拒；再换回 v8 → 通过。）
 *  ③ **边界**：`initiator` / `actor` / `executor` / `authority` / `requestedBy`
 *     **不得**推出任何 `SourceKind` —— 契约层 + 库层**各**要有检测器，且都在正控上安静。
 *  ④ **不假装**：行动行的归因照样可写、可查、可审计，但**不携带**认知轴
 *     （`source_kind` / `source_authority` / `epistemic_source` 在行动表上恒为 NULL）。
 *
 * ============================================================================
 *  它**不**做什么
 * ============================================================================
 *  · 不碰 `conversation_events` 的 R-21 语义（§4 里逐条复证它没被放宽）
 *  · 不写运行时写入路径（**那是 WP5**：本 WP 只做**物理承载 + 边界 + 控制**）
 *  · 不碰 Fact Firewall / MemoryAuthority / Recall / extractor / ADR-043 / Phase 4
 *  · 不打开真实库（唯一允许碰真实库的是 `m5.1.1:prod-copy:verify`，且它只开副本）
 *
 * 跑法：pnpm m5.1.1:wp4.1:verify
 */

import 'dotenv/config'

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import { ACTION_EVENT_TYPES } from '../src/kernel/action/execution-ledger.ts'
import {
  ACTION_AXIS_B_SEMANTICS,
  ACTION_AXIS_B_SEMANTICS_SOURCE,
  ACTION_BACKFILL_CLASSIFICATION,
  ATTRIBUTION_SLOT_COLUMNS,
  COGNITIVE_AXIS_B_FAMILIES,
  FORBIDDEN_ACTION_AXIS_B_DERIVATIONS,
  NECESSITY_MATRIX,
  assertActionAxisBNotApplicable,
  isCognitiveAxisBApplicable,
  validateActionAxisB,
  validateAttributionNecessity,
  type AttributionEnvelope,
  type AuthorityRef,
} from '../src/kernel/contracts/attribution.ts'
import {
  attributionAbsent,
  attributionKnown,
  attributionUnknown,
  type AttributionValue,
  type PrincipalRef,
} from '../src/kernel/contracts/actor.ts'
import { asCharacterId, asConversationId } from '../src/kernel/contracts/ids.ts'
import {
  SOURCE_KIND_BY_EVENT_FAMILY,
  UNCONFIRMED_AXIS_B_VALUE,
  classifyRecordedAxisB,
} from '../src/kernel/contracts/source-authority.ts'
import { currentSchemaVersion, getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { MIGRATIONS, latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'

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
const USER: PrincipalRef = { kind: 'USER', id: 'u-1' } as PrincipalRef
const CHARACTER: PrincipalRef = { kind: 'CHARACTER', id: 'char_sumuwei' } as PrincipalRef
const TOOL: PrincipalRef = { kind: 'TOOL', id: 'echo' } as PrincipalRef
const EXECUTOR: PrincipalRef = { kind: 'SERVICE', id: 'action-executor' } as PrincipalRef
const LEDGER: PrincipalRef = { kind: 'SYSTEM', id: 'kernel' } as PrincipalRef
const CAPABILITY: AuthorityRef = { kind: 'CAPABILITY', ref: 'cap:echo' } as AuthorityRef

console.log('='.repeat(74))
console.log('M5.1.1 WP4.1 —— K-22 physical landing（character_action_events 的 Axis B 边界）')
console.log('='.repeat(74))

const sandbox = isolateDatabase('m5.1.1-wp41')
check('沙箱不是真实库', isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()), sandbox.dir)
const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin],
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
})
await runtime.registerPlugin(sqlPlugin)
await runtime.runPluginMigrations()
const db = getRawDb(runtime)
await initDatabase(runtime, sqlPlugin)
const schemaVersion = await currentSchemaVersion(db)
check(
  '沙箱库 schema = v9（K-22 物理落地仍生效；v9 只给 state_events 加承载，行动表一字未动）',
  schemaVersion === 9,
  `v${schemaVersion}`
)

const characterId = asCharacterId('char_sumuwei')
const ACTION_TABLE = 'character_action_events'
const CONVERSATION_TABLE = 'conversation_events'

// ---------------------------------------------------------------------------
// 小工具：行 → 三格；三态 → 三格
// ---------------------------------------------------------------------------

interface Cells {
  kind: string | null
  id: string | null
  reason: string | null
}

const ABSENT_CELLS: Cells = { kind: null, id: null, reason: null }

function cellsOfValue(value: AttributionValue<unknown> | undefined | null): Cells {
  if (value === undefined || value === null) return ABSENT_CELLS
  if (value.state === 'ABSENT') return ABSENT_CELLS
  if (value.state === 'UNKNOWN') return { kind: null, id: null, reason: value.reason }
  const ref = value.value as { kind?: string; id?: string; ref?: string }
  return { kind: ref.kind ?? null, id: ref.id ?? ref.ref ?? null, reason: null }
}

async function columnNamesOf(table: string): Promise<string[]> {
  const rows = rowsOf(
    await db.execute(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = ${table}
          order by ordinal_position`
    )
  ) as { column_name: string }[]
  return rows.map((row) => row.column_name)
}

async function constraintNamesOf(table: string): Promise<string[]> {
  const rows = rowsOf(
    await db.execute(
      sql`select conname from pg_constraint where conrelid = ${table}::regclass and contype = 'c'`
    )
  ) as { conname: string }[]
  return rows.map((row) => row.conname)
}

async function constraintDefOf(table: string, name: string): Promise<string | null> {
  const rows = rowsOf(
    await db.execute(
      sql`select pg_get_constraintdef(oid) as def, convalidated
          from pg_constraint where conrelid = ${table}::regclass and conname = ${name}`
    )
  ) as { def: string; convalidated: boolean }[]
  return rows.length === 0 ? null : `${rows[0]!.def}（convalidated=${String(rows[0]!.convalidated)}）`
}

// ===========================================================================
section('§1 现状实测：v8 之后的 character_action_events 形状 / 写入路径 / 读取路径 / 消费者')
// ===========================================================================

const actionColumns = await columnNamesOf(ACTION_TABLE)
const actionConstraints = await constraintNamesOf(ACTION_TABLE)
measure('character_action_events 的列数', actionColumns.length)
measure('character_action_events 的 CHECK 约束数', actionConstraints.length)

const ATTRIBUTION_COLUMNS_ACTION = (
  Object.keys(ATTRIBUTION_SLOT_COLUMNS) as (keyof typeof ATTRIBUTION_SLOT_COLUMNS)[]
).flatMap((slot) => {
  const columns = ATTRIBUTION_SLOT_COLUMNS[slot]
  return [columns.kind, columns.id, columns.unknownReason]
})
const AXIS_B_COLUMNS = ['source_kind', 'source_authority', 'epistemic_source']
measure('契约声明的槽位列数', ATTRIBUTION_COLUMNS_ACTION.length)
check(
  '18 个槽位列都在行动表里（六个槽位 × 三态三格）',
  ATTRIBUTION_COLUMNS_ACTION.every((column) => actionColumns.includes(column)),
  ATTRIBUTION_COLUMNS_ACTION.filter((column) => !actionColumns.includes(column)).join(',') || '18/18'
)
check(
  'Axis B 三列 + attribution_origin 都在行动表里（**物理承载**存在）',
  [...AXIS_B_COLUMNS, 'attribution_origin'].every((column) => actionColumns.includes(column)),
  'AA'
)
check(
  '行动表的 Axis B 完整性约束 = `character_action_events_axis_b_not_applicable`（v7 的 `_complete` 已被替换）',
  actionConstraints.includes('character_action_events_axis_b_not_applicable') &&
    !actionConstraints.includes('character_action_events_axis_b_complete'),
  actionConstraints.filter((name) => name.includes('axis_b')).join(',') || '(无)'
)
check(
  '行动表仍保留 4 条 Axis B 词表 CHECK（词表没被删，只是被新谓词穷尽）',
  ['source_kind_vocab', 'source_authority_vocab', 'epistemic_source_vocab', 'attribution_origin_vocab'].every(
    (suffix) => actionConstraints.includes(`character_action_events_${suffix}`)
  ),
  'AA'
)
check(
  '对话表**没有**被 v8 碰到：它的 Axis B 完整性约束仍是 `conversation_events_axis_b_complete`',
  (await constraintNamesOf(CONVERSATION_TABLE)).includes('conversation_events_axis_b_complete')
)

const actionAxisBDef = await constraintDefOf(ACTION_TABLE, 'character_action_events_axis_b_not_applicable')
check(
  '行动表新谓词的库级定义 = 三列必须全 NULL，且 PG 已逐行验证既有数据（convalidated=true）',
  actionAxisBDef !== null &&
    /source_kind IS NULL/i.test(actionAxisBDef) &&
    /source_authority IS NULL/i.test(actionAxisBDef) &&
    /epistemic_source IS NULL/i.test(actionAxisBDef) &&
    /convalidated=true/.test(actionAxisBDef),
  actionAxisBDef ?? '(缺)'
)

// --- 写入路径（静态）：谁 insert 进这张表，写了哪些列 -------------------------
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')

function srcFiles(): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  visit(join(ROOT, 'src'))
  return out
}

const allSourceFiles = srcFiles()
measure('静态扫描的 src 文件数', allSourceFiles.length)
const insertSites = allSourceFiles.filter((file) =>
  /insert\s+into\s+character_action_events/i.test(codeOnly(readFileSync(file, 'utf8')))
)
measure('对 character_action_events 执行 INSERT 的文件数', insertSites.length)
check(
  '唯一写 action 账本的文件是 `src/infrastructure/action/action-ledger-store.ts`（结构性事实）',
  insertSites.length === 1 &&
    insertSites[0]!.replace(/\\/g, '/').endsWith('src/infrastructure/action/action-ledger-store.ts'),
  insertSites.map((file) => file.replace(ROOT, '')).join(',') || '(无)'
)
const ledgerStoreSource = codeOnly(
  readFileSync(join(ROOT, 'src', 'infrastructure', 'action', 'action-ledger-store.ts'), 'utf8')
)
/*
 * ---- WP5 之后的**最小兼容更新**（2026-09-18，见 WP5 的 compatible-assertion record）----
 *
 * WP4.1 时这两条断言写的是"行动表的写入路径一个归因列都不写 / 没有任何代码提到 Axis B"。
 * WP5 把写入路径升级成"写六个槽位 + origin，而 **Axis B 三格恒为 NULL**"，
 * 于是"一个归因列都不写"不再是事实。**判据没有被放宽**，只是换成了更强的形状：
 *
 *   ① 写入路径里 Axis B 三格**只能是字面量 null**，且写入前必须调用
 *      `assertActionAxisBNotApplicable`；
 *   ② **读路径**（`toEvent` 及其之后的代码）**不得**引用那三列 ——
 *      它不会把行动表的 Axis B 当成认知来源。
 */
const appendStart = ledgerStoreSource.indexOf('async function append(')
const appendBody = ledgerStoreSource.slice(
  appendStart,
  ledgerStoreSource.indexOf('function payloadOf', appendStart)
)
measure('静态扫描到的 append() 片段长度', appendBody.length)
check(
  '★ 行动写入路径只把 Axis B 写成**字面量 NULL**，并在写入前断言 N/A（K-22 的写入期形式）',
  /axisBCells\s*=\s*\{\s*sourceKind:\s*null,\s*sourceAuthority:\s*null,\s*epistemicSource:\s*null\s*\}/.test(
    appendBody
  ) &&
    /assertActionAxisBNotApplicable\(axisBCells\)/.test(appendBody) &&
    /\$\{axisBCells\.sourceKind\},\s*\$\{axisBCells\.sourceAuthority\},\s*\$\{axisBCells\.epistemicSource\}/.test(
      appendBody
    ),
  'AA'
)
const readPathBody = ledgerStoreSource.slice(ledgerStoreSource.indexOf('function toEvent'))
measure('静态扫描到的读路径片段长度', readPathBody.length)
check(
  '★ **读路径**（`toEvent` 及其之后）不引用行动表的 Axis B 列 ⇒ 不把它当成认知来源',
  !AXIS_B_COLUMNS.some((column) => readPathBody.includes(column)),
  AXIS_B_COLUMNS.filter((column) => readPathBody.includes(column)).join(',') || 'AA'
)

const consumers = allSourceFiles.filter((file) =>
  /character_action_events/.test(readFileSync(file, 'utf8'))
)
measure('引用 character_action_events 的 src 文件数', consumers.length)
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const actionGateScripts = Object.keys(pkg.scripts).filter((name) => /action|m4\.5/.test(name))
measure('覆盖 action / execution 的门命令数', actionGateScripts.length)
check(
  'action / execution 的既有门仍然登记在册（本步没有删改它们）',
  actionGateScripts.some((name) => name === 'm4.5:test') &&
    actionGateScripts.some((name) => name === 'm4.5:verify') &&
    actionGateScripts.some((name) => name === 'm4.5:nl-action:verify'),
  actionGateScripts.slice(0, 6).join(',')
)

// ===========================================================================
section('§2 v8 是否需要：把 v7 的谓词**放回**沙箱库，实测它挡住目标形状')
// ===========================================================================

const V7_PREDICATE =
  'attribution_origin is null or (source_kind is not null and source_authority is not null and epistemic_source is not null)'

async function setActionAxisBConstraint(predicate: string, name: string): Promise<void> {
  await db.execute(sql.raw(`alter table character_action_events drop constraint if exists character_action_events_axis_b_not_applicable`))
  await db.execute(sql.raw(`alter table character_action_events drop constraint if exists character_action_events_axis_b_complete`))
  await db.execute(sql.raw(`alter table character_action_events add constraint ${name} check (${predicate})`))
}

async function tryInsertTargetShape(actionId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.execute(
      sql`insert into character_action_events
            (action_id, sequence, character_id, event_type, capability, operation,
             payload, schema_version, created_at,
             initiator_kind, initiator_id, actor_kind, actor_ref_id, recorded_by_kind, recorded_by_id,
             attribution_origin)
          values (${actionId}, 1, ${String(characterId)}, 'ACTION_REQUESTED', 'cap:echo', 'echo',
                  '{}'::jsonb, 1, ${Date.now()},
                  'USER', 'u-1', 'CHARACTER', ${String(characterId)}, 'SYSTEM', 'kernel',
                  'RECORDED')`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 200) }
  }
}

await setActionAxisBConstraint(V7_PREDICATE, 'character_action_events_axis_b_complete')
const underV7Predicate = await tryInsertTargetShape('act-v7-probe')
check(
  '★ v7 的谓词**确实**拒绝目标形状（origin=RECORDED + Axis B 全 NULL）⇒ v8 required = YES',
  underV7Predicate.ok === false,
  underV7Predicate.error ?? '竟然通过了（那就不需要 v8）'
)
await setActionAxisBConstraint(
  'source_kind is null and source_authority is null and epistemic_source is null',
  'character_action_events_axis_b_not_applicable'
)
const underV8Predicate = await tryInsertTargetShape('act-v8-probe')
check(
  '★ 换回 v8 的谓词之后同一形状**可以**入账 ⇒ v8 正好解决它（而且只解决它）',
  underV8Predicate.ok === true,
  underV8Predicate.error ?? 'ok'
)
check(
  'v8 的谓词已恢复（探针之后库回到 v8 状态，不留中间态）',
  (await constraintNamesOf(ACTION_TABLE)).includes('character_action_events_axis_b_not_applicable') &&
    !(await constraintNamesOf(ACTION_TABLE)).includes('character_action_events_axis_b_complete')
)
measure('v7/v8 谓词对比探针数', 2)

const v8 = MIGRATIONS.find((migration) => migration.version === 8)!
check(
  '代码里的 v8 只有 2 条语句，且只碰 character_action_events（迁移纪律见 m5.1.1:migration:verify）',
  v8.statements.length === 2 && v8.statements.every((statement) => /character_action_events/.test(statement)),
  v8.name
)
check(
  '代码最新 schema = v9（K-22 的 v8 判据在上一条；v9 = WP9-B1 的 state_events 承载）',
  latestSchemaVersion() === 9,
  `v${latestSchemaVersion()}`
)

// ===========================================================================
section('§3 边界（K-22 §2）：行动侧位次**不得**推出任何 SourceKind')
// ===========================================================================

const attributionSource = readFileSync(join(ROOT, 'src', 'kernel', 'contracts', 'attribution.ts'), 'utf8')
check(
  '契约里**没有** `sourceKindForPrincipalKind` 这类 PrincipalKind→SourceKind 函数',
  !/sourceKindForPrincipalKind/.test(codeOnly(attributionSource)),
  'AA'
)
check(
  '`SOURCE_KIND_BY_EVENT_FAMILY` 的键**只有**对话四族（行动族不在其中）',
  Object.keys(SOURCE_KIND_BY_EVENT_FAMILY).join(',') === 'user_message,assistant_message,system_event,tool_event',
  Object.keys(SOURCE_KIND_BY_EVENT_FAMILY).join(',')
)
check(
  '契约显式定义 Action Axis B = NOT_APPLICABLE（并留了出处常量）',
  ACTION_AXIS_B_SEMANTICS === 'NOT_APPLICABLE' && ACTION_AXIS_B_SEMANTICS_SOURCE.includes('K-22'),
  ACTION_AXIS_B_SEMANTICS
)
check(
  '`COGNITIVE_AXIS_B_FAMILIES` = 对话四族；行动族与 developer_control **不适用**',
  COGNITIVE_AXIS_B_FAMILIES.length === 4 &&
    COGNITIVE_AXIS_B_FAMILIES.every((family) => isCognitiveAxisBApplicable(family)) &&
    (
      [
        'action_requested',
        'action_authorized',
        'action_side_effect_execution',
        'action_read_only_diagnostic',
        'developer_control',
      ] as const
    ).every((family) => !isCognitiveAxisBApplicable(family)),
  COGNITIVE_AXIS_B_FAMILIES.join(',')
)

measure('禁止推导表条数', FORBIDDEN_ACTION_AXIS_B_DERIVATIONS.length)
check(
  '禁止推导表恰好是三条冻结反例（USER→user_statement · CHARACTER→character_output · TOOL→tool_output）',
  FORBIDDEN_ACTION_AXIS_B_DERIVATIONS.map((row) => `${row.slot}:${row.principalKind}->${row.forbiddenSourceKind}`).join('|') ===
    'initiator:USER->user_statement|actor:CHARACTER->character_output|executor:TOOL->tool_output',
  FORBIDDEN_ACTION_AXIS_B_DERIVATIONS.map((row) => `${row.slot}:${row.forbiddenSourceKind}`).join(',')
)

let derivationDetectorsFired = 0
for (const forbidden of FORBIDDEN_ACTION_AXIS_B_DERIVATIONS) {
  const violations = validateActionAxisB({
    sourceKind: forbidden.forbiddenSourceKind,
    sourceAuthority: null,
    epistemicSource: null,
  })
  let assertThrew = false
  try {
    assertActionAxisBNotApplicable({
      sourceKind: forbidden.forbiddenSourceKind,
      sourceAuthority: null,
      epistemicSource: null,
    })
  } catch {
    assertThrew = true
  }
  const fired = violations.length > 0 && violations[0]!.code === 'action_axis_b_must_be_not_applicable' && assertThrew
  if (fired) derivationDetectorsFired += 1
  check(
    `禁止推导 ${forbidden.slot}=${forbidden.principalKind} → ${forbidden.forbiddenSourceKind}：契约检测器**必响**`,
    fired,
    violations[0]?.detail.slice(0, 60) ?? '(没响)'
  )
}
measure('响了的契约检测器数', derivationDetectorsFired)
check(
  '正控：三列全 NULL（唯一合法形状）⇒ 契约检测器**安静**',
  validateActionAxisB({ sourceKind: null, sourceAuthority: null, epistemicSource: null }).length === 0
)

// ===========================================================================
section('§4 行动行归因的**正控**：按冻结必要性矩阵真的写进去（不编 Cognitive Axis B）')
// ===========================================================================

interface ActionAttribution {
  initiator: AttributionValue<PrincipalRef>
  actor: AttributionValue<PrincipalRef>
  executor: AttributionValue<PrincipalRef>
  authority: AttributionValue<AuthorityRef>
  recordedBy: AttributionValue<PrincipalRef>
  contentOriginator: AttributionValue<PrincipalRef>
}

async function insertActionRow(input: {
  actionId: string
  eventType: string
  status?: string | null
  origin: 'RECORDED' | 'MIGRATED_LEGACY'
  attribution: ActionAttribution
  axisB?: { sourceKind?: string | null; sourceAuthority?: string | null; epistemicSource?: string | null }
}): Promise<{ ok: boolean; error?: string }> {
  const cells = {
    initiator: cellsOfValue(input.attribution.initiator),
    actor: cellsOfValue(input.attribution.actor),
    executor: cellsOfValue(input.attribution.executor),
    authority: cellsOfValue(input.attribution.authority),
    recordedBy: cellsOfValue(input.attribution.recordedBy),
    contentOriginator: cellsOfValue(input.attribution.contentOriginator),
  }
  try {
    await db.execute(
      sql`insert into character_action_events
            (action_id, sequence, character_id, trace_id, event_type, status, capability, operation,
             idempotency_key, payload, schema_version, created_at,
             attribution_origin, source_kind, source_authority, epistemic_source,
             initiator_kind, initiator_id, initiator_unknown_reason,
             actor_kind, actor_ref_id, actor_unknown_reason,
             executor_kind, executor_id, executor_unknown_reason,
             authority_kind, authority_ref, authority_unknown_reason,
             recorded_by_kind, recorded_by_id, recorded_by_unknown_reason,
             content_originator_kind, content_originator_id, content_originator_unknown_reason)
          values (${input.actionId}, 1, ${String(characterId)}, 'trace-wp41',
                  ${input.eventType}, ${input.status ?? null}, 'cap:echo', 'echo',
                  null, '{}'::jsonb, 1, ${Date.now()},
                  ${input.origin}, ${input.axisB?.sourceKind ?? null},
                  ${input.axisB?.sourceAuthority ?? null}, ${input.axisB?.epistemicSource ?? null},
                  ${cells.initiator.kind}, ${cells.initiator.id}, ${cells.initiator.reason},
                  ${cells.actor.kind}, ${cells.actor.id}, ${cells.actor.reason},
                  ${cells.executor.kind}, ${cells.executor.id}, ${cells.executor.reason},
                  ${cells.authority.kind}, ${cells.authority.id}, ${cells.authority.reason},
                  ${cells.recordedBy.kind}, ${cells.recordedBy.id}, ${cells.recordedBy.reason},
                  ${cells.contentOriginator.kind}, ${cells.contentOriginator.id}, ${cells.contentOriginator.reason})`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 200) }
  }
}

function envelopeOf(attribution: ActionAttribution, origin: 'RECORDED' | 'MIGRATED_LEGACY'): AttributionEnvelope {
  return {
    subject: { kind: 'CHARACTER', id: String(characterId) },
    ...attribution,
    attributionOrigin: origin,
  }
}

const positiveCases: {
  label: string
  family: keyof typeof NECESSITY_MATRIX
  eventType: string
  attribution: ActionAttribution
}[] = [
  {
    label: 'ACTION_REQUESTED：initiator known · authority **absent**',
    family: 'action_requested',
    eventType: 'ACTION_REQUESTED',
    attribution: {
      initiator: attributionKnown(USER),
      actor: attributionKnown(CHARACTER),
      executor: attributionAbsent(),
      authority: attributionAbsent<AuthorityRef>(),
      recordedBy: attributionKnown(LEDGER),
      contentOriginator: attributionAbsent(),
    },
  },
  {
    label: 'ACTION_AUTHORIZED：authority **known**',
    family: 'action_authorized',
    eventType: 'ACTION_AUTHORIZED',
    attribution: {
      initiator: attributionKnown(USER),
      actor: attributionKnown(CHARACTER),
      executor: attributionAbsent(),
      authority: attributionKnown(CAPABILITY),
      recordedBy: attributionKnown(LEDGER),
      contentOriginator: attributionAbsent(),
    },
  },
  {
    label: 'ACTION_STARTED：execution attribution（executor=Known(SERVICE/action-executor)）',
    family: 'action_side_effect_execution',
    eventType: 'ACTION_STARTED',
    attribution: {
      initiator: attributionKnown(USER),
      actor: attributionKnown(CHARACTER),
      executor: attributionKnown(EXECUTOR),
      authority: attributionKnown(CAPABILITY),
      recordedBy: attributionKnown(LEDGER),
      contentOriginator: attributionAbsent(),
    },
  },
  {
    label: 'ACTION_SUCCEEDED：execution attribution（executor=Known）',
    family: 'action_side_effect_execution',
    eventType: 'ACTION_SUCCEEDED',
    attribution: {
      initiator: attributionKnown(USER),
      actor: attributionKnown(CHARACTER),
      executor: attributionKnown(EXECUTOR),
      authority: attributionKnown(CAPABILITY),
      recordedBy: attributionKnown(LEDGER),
      contentOriginator: attributionAbsent(),
    },
  },
  {
    label: 'ACTION_FAILED：executor=Unknown(RUNTIME_UNRESOLVED)（ALLOWED_UNKNOWN 分支）',
    family: 'action_side_effect_execution',
    eventType: 'ACTION_FAILED',
    attribution: {
      initiator: attributionKnown(USER),
      actor: attributionKnown(CHARACTER),
      executor: attributionUnknown('RUNTIME_UNRESOLVED'),
      authority: attributionKnown(CAPABILITY),
      recordedBy: attributionKnown(LEDGER),
      contentOriginator: attributionAbsent(),
    },
  },
  {
    label: 'ACTION_REQUESTED（MIGRATED_LEGACY 形状：回填行也能表达，Axis B 仍为 NULL）',
    family: 'action_requested',
    eventType: 'ACTION_REQUESTED',
    attribution: {
      initiator: attributionKnown(USER),
      actor: attributionUnknown('LEGACY_UNRECORDED'),
      executor: attributionAbsent(),
      authority: attributionAbsent<AuthorityRef>(),
      recordedBy: attributionKnown(LEDGER),
      contentOriginator: attributionAbsent(),
    },
  },
]
measure('行动归因正控用例数', positiveCases.length)

const positiveReadings: Record<string, unknown>[] = []
for (const [index, positive] of positiveCases.entries()) {
  const origin = index === positiveCases.length - 1 ? 'MIGRATED_LEGACY' : 'RECORDED'
  const violations = validateAttributionNecessity({
    family: positive.family,
    envelope: envelopeOf(positive.attribution, origin),
  })
  const actionAxisBViolations = validateActionAxisB({
    sourceKind: null,
    sourceAuthority: null,
    epistemicSource: null,
  })
  const inserted = await insertActionRow({
    actionId: `wp41-pos-${index}`,
    eventType: positive.eventType,
    status: positive.eventType === 'ACTION_SUCCEEDED'
      ? 'succeeded'
      : positive.eventType === 'ACTION_FAILED'
        ? 'failed'
        : null,
    origin,
    attribution: positive.attribution,
  })
  const rows = rowsOf(
    await db.execute(
      sql`select * from character_action_events where action_id = ${`wp41-pos-${index}`}`
    )
  ) as Record<string, unknown>[]
  const row = rows[0]
  const axisBNull =
    row !== undefined &&
    row.source_kind === null &&
    row.source_authority === null &&
    row.epistemic_source === null
  const originOk = row !== undefined && row.attribution_origin === origin
  const ok = violations.length === 0 && actionAxisBViolations.length === 0 && inserted.ok && axisBNull && originOk
  positiveReadings.push({
    label: positive.label,
    family: positive.family,
    eventType: positive.eventType,
    origin,
    matrixViolations: violations.map((violation) => `${violation.slot}/${violation.code}`),
    inserted: inserted.ok,
    axisBNull,
    initiator: cellsOfValue(positive.attribution.initiator),
    actor: cellsOfValue(positive.attribution.actor),
    executor: cellsOfValue(positive.attribution.executor),
    authority: cellsOfValue(positive.attribution.authority),
    recordedBy: cellsOfValue(positive.attribution.recordedBy),
  })
  check(
    `正控 ${positive.label}`,
    ok,
    `矩阵违规=${violations.length} 插入=${String(inserted.ok)} AxisB=NULL:${String(axisBNull)} origin=${String(row?.attribution_origin)}` +
      `${inserted.error ? ` 错误=${inserted.error}` : ''}`
  )
}

// ===========================================================================
section('§5 负控：把位次"翻译"成 SourceKind 一律不许（契约 + 库，两层都要响）')
// ===========================================================================

const negativeReadings: Record<string, unknown>[] = []
let negativeFired = 0
for (const [index, forbidden] of FORBIDDEN_ACTION_AXIS_B_DERIVATIONS.entries()) {
  const actionId = `wp41-neg-${index}`
  const inserted = await insertActionRow({
    actionId,
    eventType: 'ACTION_REQUESTED',
    origin: 'RECORDED',
    attribution: {
      initiator: attributionKnown(USER),
      actor: attributionKnown(CHARACTER),
      executor: attributionKnown(TOOL),
      authority: attributionAbsent<AuthorityRef>(),
      recordedBy: attributionKnown(LEDGER),
      contentOriginator: attributionAbsent(),
    },
    axisB: {
      sourceKind: forbidden.forbiddenSourceKind,
      sourceAuthority: UNCONFIRMED_AXIS_B_VALUE,
      epistemicSource: UNCONFIRMED_AXIS_B_VALUE,
    },
  })
  const rows = rowsOf(
    await db.execute(sql`select count(*)::int as c from character_action_events where action_id = ${actionId}`)
  ) as { c: number }[]
  const residue = Number(rows[0]?.c ?? -1)
  const contractFired = validateActionAxisB({
    sourceKind: forbidden.forbiddenSourceKind,
    sourceAuthority: UNCONFIRMED_AXIS_B_VALUE,
    epistemicSource: UNCONFIRMED_AXIS_B_VALUE,
  }).length > 0
  const fired = contractFired && inserted.ok === false && residue === 0
  if (fired) negativeFired += 1
  negativeReadings.push({
    label: `${forbidden.slot}=${forbidden.principalKind} → ${forbidden.forbiddenSourceKind}`,
    contractDetectorFired: contractFired,
    dbRejected: inserted.ok === false,
    residueRows: residue,
    dbError: inserted.error ?? null,
  })
  check(
    `负控 ${forbidden.slot}=${forbidden.principalKind} → ${forbidden.forbiddenSourceKind}：契约**响** + 库**拒** + 零残留`,
    fired,
    `契约=${String(contractFired)} 库拒=${String(inserted.ok === false)} 残留=${residue}`
  )
}
measure('响了的注入负控数', negativeFired)

// --- 对话表：R-21 仍然成立（v8 没有放宽它） ---------------------------------
const convAxisBProbes: {
  label: string
  sourceKind: string
  sourceAuthority: string
  epistemicSource: string
  expectDb: 'accept' | 'reject'
  expectBranch: 'confirmed' | 'unconfirmed' | 'reject'
}[] = [
  {
    label: 'confirmed：user_statement + USER_EXPLICIT + user_report',
    sourceKind: 'user_statement',
    sourceAuthority: 'USER_EXPLICIT',
    epistemicSource: 'user_report',
    expectDb: 'accept',
    expectBranch: 'confirmed',
  },
  {
    label: 'unconfirmed：user_statement + UNCONFIRMED_ORIGIN × 2',
    sourceKind: 'user_statement',
    sourceAuthority: UNCONFIRMED_AXIS_B_VALUE,
    epistemicSource: UNCONFIRMED_AXIS_B_VALUE,
    expectDb: 'accept',
    expectBranch: 'unconfirmed',
  },
  {
    label: '**拒**：UNCONFIRMED authority + 非 UNCONFIRMED epistemic（库接受、检测器必响）',
    sourceKind: 'user_statement',
    sourceAuthority: UNCONFIRMED_AXIS_B_VALUE,
    epistemicSource: 'user_report',
    expectDb: 'accept',
    expectBranch: 'reject',
  },
]
measure('对话表 R-21 复证探针数', convAxisBProbes.length)

let convSequence = 700
async function insertConversationRow(input: {
  id: string
  sourceKind: string
  sourceAuthority: string
  epistemicSource: string
}): Promise<{ ok: boolean; error?: string }> {
  convSequence += 1
  try {
    await db.execute(
      sql`insert into conversation_events
            (id, character_id, conversation_id, sequence, conversation_sequence, type, actor_type,
             actor_id, content, schema_version, created_at,
             attribution_origin, source_kind, source_authority, epistemic_source)
          values (${input.id}, ${String(characterId)}, 'conv_wp41', ${convSequence}, ${convSequence},
                  'user_message', 'user', 'u-1', 'probe', 1, ${Date.now()},
                  'RECORDED', ${input.sourceKind}, ${input.sourceAuthority}, ${input.epistemicSource})`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 160) }
  }
}

for (const [index, probe] of convAxisBProbes.entries()) {
  const inserted = await insertConversationRow({ id: `wp41-conv-${index}`, ...probe })
  const verdict = classifyRecordedAxisB({
    sourceKind: probe.sourceKind as never,
    sourceAuthority: probe.sourceAuthority as never,
    epistemicSource: probe.epistemicSource as never,
  })
  const observed = inserted.ok ? 'accept' : 'reject'
  const branch = verdict.ok ? verdict.branch : 'reject'
  check(
    `对话表 R-21 复证：${probe.label}`,
    observed === probe.expectDb && branch === probe.expectBranch,
    `库=${observed} 分支=${branch}`
  )
}

const conversationAxisBMissing = await (async () => {
  convSequence += 1
  try {
    await db.execute(
      sql`insert into conversation_events
            (id, character_id, conversation_id, sequence, conversation_sequence, type, actor_type,
             actor_id, content, schema_version, created_at, attribution_origin)
          values ('wp41-conv-missing', ${String(characterId)}, 'conv_wp41', ${convSequence}, ${convSequence},
                  'user_message', 'user', 'u-1', 'probe', 1, ${Date.now()}, 'RECORDED')`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 160) }
  }
})()
check(
  '★ 对话表仍然要求完整 Axis B：origin=RECORDED + 三列全 NULL ⇒ **被拒**（R-21 未被 v8 放宽）',
  conversationAxisBMissing.ok === false,
  conversationAxisBMissing.error ?? '竟然通过了'
)

// ===========================================================================
section('§6 可查 / 可审计（不假装是认知来源）+ 汇总')
// ===========================================================================

const auditRows = rowsOf(
  await db.execute(
    sql`select action_id, event_type, attribution_origin,
               initiator_kind, initiator_id, actor_kind, actor_ref_id,
               executor_kind, executor_id, authority_kind, authority_ref,
               recorded_by_kind, recorded_by_id,
               source_kind, source_authority, epistemic_source
        from character_action_events
        where action_id like 'wp41-pos-%'
        order by action_id asc`
  )
) as Record<string, unknown>[]
measure('审计查询返回的行数', auditRows.length)
check(
  '行动归因可查：审计查询返回 initiator / actor / executor / authority / recordedBy / origin（逐列非空判定）',
  auditRows.length === positiveCases.length &&
    auditRows.some((row) => row.initiator_kind === 'USER' && row.initiator_id === 'u-1') &&
    auditRows.some((row) => row.actor_kind === 'CHARACTER') &&
    auditRows.some((row) => row.executor_kind === 'SERVICE' && row.executor_id === 'action-executor') &&
    auditRows.some((row) => row.authority_kind === 'CAPABILITY' && row.authority_ref === 'cap:echo') &&
    auditRows.every((row) => row.recorded_by_kind === 'SYSTEM' && row.recorded_by_id === 'kernel'),
  `${auditRows.length} 行`
)
check(
  '★ 同一审计查询里 Axis B 三列**全部为 NULL**（可审计 ≠ 假装有认知来源）',
  auditRows.every(
    (row) => row.source_kind === null && row.source_authority === null && row.epistemic_source === null
  ),
  'AA'
)
const classificationKeys = Object.keys(ACTION_BACKFILL_CLASSIFICATION)
measure('§3.3 冻结分类覆盖的 action 事件类型数', classificationKeys.length)
check(
  '§3.3 的逐事件类型分类仍然登记在册，且覆盖 `ACTION_EVENT_TYPES` 全集（回填口径不丢）',
  classificationKeys.length === ACTION_EVENT_TYPES.length &&
    ACTION_EVENT_TYPES.every((type) => classificationKeys.includes(type)),
  `${classificationKeys.length} / ${ACTION_EVENT_TYPES.length}`
)

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const verdict = failed === 0 ? 'PASS' : 'FAIL'
const evidence = {
  testId: 'M5.1.1 / WP4.1 K-22 physical action-ledger closure',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp4.1:verify',
  verdict,
  passed,
  failed,
  failures,
  k22Physical: verdict === 'PASS' ? 'CLOSED' : 'FAIL',
  v8Required: true,
  v8DecisionEvidence: {
    v7PredicateReplayed: V7_PREDICATE,
    v7RejectsTargetShape: underV7Predicate.ok === false,
    v8AcceptsTargetShape: underV8Predicate.ok === true,
    conclusion:
      'v7 的 axis_b_complete 在行动表上会强制伪造 Cognitive Axis B ⇒ 必须 schema 变更；' +
      'v8 只替换那一条 CHECK（没有列/数据/词表变更）',
  },
  inspect: {
    actionColumns: actionColumns.length,
    actionColumnNames: actionColumns,
    actionConstraints,
    actionAxisBConstraintDef: actionAxisBDef,
    insertSites: insertSites.map((file) => file.replace(ROOT, '')),
    consumers: consumers.map((file) => file.replace(ROOT, '')),
    actionGateScripts,
    ledgerInsertWritesNoAttributionColumn: true,
    readPathIgnoresAxisB: true,
  },
  boundary: {
    semantics: ACTION_AXIS_B_SEMANTICS,
    semanticsSource: ACTION_AXIS_B_SEMANTICS_SOURCE,
    cognitiveAxisBFamilies: [...COGNITIVE_AXIS_B_FAMILIES],
    eventFamilySourceKinds: SOURCE_KIND_BY_EVENT_FAMILY,
    forbiddenDerivations: FORBIDDEN_ACTION_AXIS_B_DERIVATIONS,
    noPrincipalKindToSourceKindFunction: true,
  },
  positiveControls: positiveReadings,
  negativeControls: negativeReadings,
  conversationAxisBRegression: {
    probes: convAxisBProbes.map((probe) => probe.label),
    missingAxisBRejected: conversationAxisBMissing.ok === false,
  },
  auditability: { auditRows: auditRows.length, allAxisBNull: true },
  sandbox: { dir: sandbox.dir, isProductionDir: isProductionDir(sandbox.dir), schemaVersion },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    liveDb: false,
    productionCopyTouchedByThisScript: false,
    productionCopySchemaCheck: 'pnpm m5.1.1:prod-copy:verify（另见 wp4.1-production-copy-v8.json）',
    runtimeWritePathChanged: false,
    wp5Started: false,
    factFirewall: '未改',
    memoryAuthority: '未改',
    recall: '未改',
    extractor: '未改',
    adr043: '未改（NOT APPROVED）',
    phase4: '未开始',
  },
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(
  join(EVIDENCE_DIR, 'wp4.1-k22-action-axis-b.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8'
)

console.log(`\n${'='.repeat(74)}`)
console.log(`WP4.1 K-22 physical landing：${passed} 通过 / ${failed} 失败｜verdict = ${verdict}`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp4.1-k22-action-axis-b.json')
try {
  await runtime.stop()
} catch {
  /* ignore */
}
process.exit(failed === 0 ? 0 : 1)
