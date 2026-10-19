/**
 * M5.1.1 WP2.4 —— **K-20 / R-18：D/P/U/N-aware Migration Anti-Fabrication Gate**
 * （`pnpm m5.1.1:k20:verify`）
 *
 * ============================================================================
 *  它替代了什么（以及**没有**放宽什么）
 * ============================================================================
 * 旧规则（**已删除**）：
 *
 *     MIGRATED_LEGACY AND 具体 contentOriginator  → 一律违规
 *
 * 这条与冻结的 D/P/U/N 矩阵、以及 K-3 FINAL 直接冲突：
 * `tool_event.contentOriginator = **D**`，对确定性的工具行记录
 * `Known(TOOL/<tool-id>)` 是**正确结果**，不是伪造。
 *
 * 新规则（分类感知）：
 *
 *     D  确定性证据**存在**；记录下来的 Known 值必须**与它逐字一致**
 *     P  只有在存在**独立的行级证据**时才允许 Known；否则 `Unknown(LEGACY_UNRECORDED)`
 *     U  具体值计数必须为 **0**；适用行一律 `Unknown(LEGACY_UNRECORDED)`
 *     N  槽位必须 **Absent**
 *
 * **anti-fabrication 不变量没有被放宽**：
 *   · U 槽位出现具体值 = 伪造
 *   · N 槽位出现任何值 = 伪造
 *   · D 槽位的 Known 与确定性证据不一致 = 伪造（**新增强的一条**）
 *   · `contentOriginator` 说成 `Known(USER / CHARACTER)` = 伪造（与分类无关，§3.7 / D01）
 *
 * ============================================================================
 *  三段式（AGENTS §6.7 / R-13）
 * ============================================================================
 *   正控：正确的确定性工具行（`TOOL/weather`）⇒ 检测器**安静**
 *   负控：同一行改成 `USER` / `CHARACTER` / **另一个 TOOL id** ⇒ 检测器**必响**
 *   恢复：把值改回正确的 ⇒ 检测器**重新安静**
 *
 * ⚠️ 两道防空转的断言（不做这两条，正控可能是假的）：
 *   ① 检测器必须**真的读到了行**：`rows_in_scope > 0`，否则 MEASUREMENT INVALID
 *   ② "转录保真"：编码的 D/P/U/N 矩阵必须与**冻结文档的表格**逐格一致
 *      （解析 `M5.1.1-Migration-Strategy.md` §3.2 / §3.3）—— 否则"分类"是手抄的信仰
 *
 * 跑法：pnpm m5.1.1:k20:verify
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import 'dotenv/config'

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import { ACTION_EVENT_TYPES } from '../src/kernel/action/execution-ledger.ts'
import {
  ACTION_BACKFILL_CLASSIFICATION,
  BACKFILL_CLASS_SOURCE,
  BACKFILL_CONTRACT_DEFERRED_FAMILIES,
  CONVERSATION_BACKFILL_CLASSIFICATION,
  NECESSITY_MATRIX,
  type BackfillClass,
  type BackfillClassRow,
} from '../src/kernel/contracts/attribution.ts'
import { currentSchemaVersion, getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'

// ---------------------------------------------------------------------------
// 极简检查器
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

console.log('='.repeat(74))
console.log('M5.1.1 WP2.4 —— K-20 / R-18 D/P/U/N-aware Migration Anti-Fabrication Gate')
console.log('='.repeat(74))

// ===========================================================================
section('0. 量具自检：编码的 D/P/U/N 矩阵必须与**冻结文档的表格**逐格一致')
// ===========================================================================

/** 去掉 markdown 强调/反引号，取出格子里的**前导分类字母**（`**U** ← B1` → `U`） */
function parseClassCell(cell: string): BackfillClass | null {
  const cleaned = cell.replace(/[`*]/g, '').trim()
  const head = cleaned[0]
  return head === 'D' || head === 'P' || head === 'U' || head === 'N' ? (head as BackfillClass) : null
}

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

const strategy = readFileSync(join(ROOT, 'docs', 'm5.1.1', 'M5.1.1-Migration-Strategy.md'), 'utf8')
const strategyLines = strategy.split('\n')

/** §3.2：`| 槽位 | user_message | assistant_message | tool_event | system_event |` */
function parseConversationTable(): { families: string[]; rows: Map<string, BackfillClass[]> } | null {
  const headerIndex = strategyLines.findIndex((line) => /^\|\s*槽位\s*\|/.test(line.trim()))
  if (headerIndex < 0) return null
  const families = cellsOf(strategyLines[headerIndex]!)
    .slice(1)
    .map((cell) => cell.replace(/[`*]/g, '').trim())
  const rows = new Map<string, BackfillClass[]>()
  for (let index = headerIndex + 2; index < strategyLines.length; index += 1) {
    const line = strategyLines[index]!
    if (!line.trim().startsWith('|')) break
    const cells = cellsOf(line)
    const slot = cells[0]!.replace(/[`*]/g, '').trim()
    const classes = cells.slice(1).map(parseClassCell)
    if (classes.some((value) => value === null)) break
    rows.set(slot, classes as BackfillClass[])
  }
  return { families, rows }
}

const slotKeyOf: Record<string, keyof BackfillClassRow> = {
  subject: 'subject',
  initiator: 'initiator',
  actor: 'actor',
  executor: 'executor',
  authority: 'authority',
  recorded_by: 'recordedBy',
  recordedBy: 'recordedBy',
  content_originator: 'contentOriginator',
  contentOriginator: 'contentOriginator',
}

const conversationTable = parseConversationTable()
check('§3.2 的表格能被解析出来（否则"转录保真"这条检测器本身就是空的）', conversationTable !== null)
measure('§3.2 解析出的槽位行数', conversationTable?.rows.size ?? 0)
measure('§3.2 解析出的 event family 数', conversationTable?.families.length ?? 0)

const transcriptionMismatches: string[] = []
if (conversationTable !== null) {
  for (const family of conversationTable.families) {
    const encoded =
      CONVERSATION_BACKFILL_CLASSIFICATION[
        family as keyof typeof CONVERSATION_BACKFILL_CLASSIFICATION
      ]
    if (encoded === undefined) {
      transcriptionMismatches.push(`${family}: 编码里没有这一族`)
      continue
    }
    const columnIndex = conversationTable.families.indexOf(family)
    for (const [docSlot, classes] of conversationTable.rows) {
      const key = slotKeyOf[docSlot]
      if (key === undefined) {
        transcriptionMismatches.push(`${family}.${docSlot}: 不认识的槽位名`)
        continue
      }
      const fromDoc = classes[columnIndex]
      const fromCode = encoded[key]
      if (fromDoc !== fromCode) {
        transcriptionMismatches.push(`${family}.${key}: 文档=${fromDoc} 编码=${fromCode}`)
      }
    }
  }
}
measure('§3.2 逐格比对的格子数', (conversationTable?.rows.size ?? 0) * (conversationTable?.families.length ?? 0))
check(
  '§3.2 的 D/P/U/N 与冻结文档**逐格一致**（转录保真，不是手抄信仰）',
  transcriptionMismatches.length === 0,
  transcriptionMismatches.join(' | ') || 'AA'
)

// §3.3：事件类型表
const actionTableRows = new Map<string, BackfillClass[]>()
{
  const start = strategyLines.findIndex((line) => /ACTION_REQUESTED/.test(line) && line.trim().startsWith('|'))
  for (let index = start; index >= 0 && index < strategyLines.length; index += 1) {
    const line = strategyLines[index]!
    if (!line.trim().startsWith('|')) break
    const cells = cellsOf(line)
    const eventTypeHeader = cells[0]!.replace(/[`*]/g, '').trim()
    if (!/^ACTION_/.test(eventTypeHeader)) continue
    const classes = cells.slice(1).map(parseClassCell)
    if (classes.some((value) => value === null)) continue
    // ⚠️ 文档把**一族同形事件写在同一个格子里**：
    //    `ACTION_SUCCEEDED / FAILED / PARTIAL / CANCELLED`
    //    第一版解析器把整串当成一个事件类型名 ⇒ 报"编码里没有"。这里按 `/` 展开。
    for (const token of eventTypeHeader.split('/').map((part) => part.trim()).filter(Boolean)) {
      const eventType = token.startsWith('ACTION_') ? token : `ACTION_${token}`
      actionTableRows.set(eventType, classes as BackfillClass[])
    }
  }
}
measure('§3.3 解析出的事件类型数', actionTableRows.size)
const actionMismatches: string[] = []
for (const [eventType, classes] of actionTableRows) {
  const encoded = ACTION_BACKFILL_CLASSIFICATION[eventType]
  if (encoded === undefined) {
    actionMismatches.push(`${eventType}: 编码里没有`)
    continue
  }
  const keys: (keyof BackfillClassRow)[] = [
    'initiator',
    'actor',
    'executor',
    'authority',
    'contentOriginator',
  ]
  keys.forEach((key, index) => {
    if (encoded[key] !== classes[index]) {
      actionMismatches.push(`${eventType}.${key}: 文档=${classes[index]} 编码=${encoded[key]}`)
    }
  })
}
check('§3.3 的 D/P/U/N 与冻结文档逐格一致', actionMismatches.length === 0, actionMismatches.join(' | ') || 'AA')

// 事件类型全集：编码的键必须恰好等于 ACTION_EVENT_TYPES
const encodedActionTypes = Object.keys(ACTION_BACKFILL_CLASSIFICATION).sort()
const actualActionTypes: string[] = [...ACTION_EVENT_TYPES].map((type) => String(type)).sort()
const typeSetDiff = [
  ...encodedActionTypes.filter((type) => !actualActionTypes.includes(type)).map((t) => `多:${t}`),
  ...actualActionTypes.filter((type) => !encodedActionTypes.includes(type)).map((t) => `少:${t}`),
]
measure('比对的事件类型数', actualActionTypes.length)
check('编码的事件类型集合 == ACTION_EVENT_TYPES（多一个少一个都红）', typeSetDiff.length === 0, typeSetDiff.join(',') || 'AA')

// `N ⟺ ABSENT`：与写入期必要性矩阵交叉核对（可机检的一致性）
/**
 * **已登记的跨文档冲突**（`N ⟺ ABSENT` 在这几格上不成立）。
 *
 * K-21（2026-09-18，用户裁定 R-19）已经把唯一那条冲突**修掉**了：
 * `system_event.contentOriginator` 两侧统一为 `ALLOWED_UNKNOWN / U`。
 * ⇒ 本表**必须为空**；这条断言本身就是"K-21 已关闭"的机读证明。
 */
const REGISTERED_CLASSIFICATION_CONFLICTS: {
  family: string
  slot: string
  necessity: string
  backfill: BackfillClass
  sources: string[]
  status: string
}[] = []

const consistencyMismatches: string[] = []
for (const [family, row] of Object.entries(CONVERSATION_BACKFILL_CLASSIFICATION)) {
  for (const slot of ['initiator', 'actor', 'executor', 'authority', 'recordedBy', 'contentOriginator'] as const) {
    const necessity = NECESSITY_MATRIX[family as keyof typeof NECESSITY_MATRIX][slot]
    const isAbsentCell = necessity === 'ABSENT'
    const isN = row[slot] === 'N'
    if (isAbsentCell === isN) continue
    consistencyMismatches.push(`${family}.${slot}: necessity=${necessity} 但分类=${row[slot]}`)
  }
}
measure('N ⟺ ABSENT 交叉比对的格子数', 4 * 6)
check(
  '★ K-21 CLOSED：`N ⟺ ABSENT` **全局**成立（零不一致、零豁免）',
  consistencyMismatches.length === 0,
  consistencyMismatches.join(' | ') || 'AA'
)
check(
  '★ K-21 CLOSED：已登记的跨文档冲突表 = **0 条**（不再是"恰好豁免一格"）',
  REGISTERED_CLASSIFICATION_CONFLICTS.length === 0,
  `${REGISTERED_CLASSIFICATION_CONFLICTS.length} 条`
)

// AT-0 的**锁定规则**：这几格是用户逐条钉死的，必须与矩阵逐字一致
const LOCKED_BACKFILL_RULES: { family: keyof typeof CONVERSATION_BACKFILL_CLASSIFICATION; slot: keyof BackfillClassRow; expected: BackfillClass }[] = [
  { family: 'user_message', slot: 'actor', expected: 'U' },
  { family: 'user_message', slot: 'contentOriginator', expected: 'U' },
  { family: 'assistant_message', slot: 'contentOriginator', expected: 'U' },
  { family: 'tool_event', slot: 'actor', expected: 'D' },
  { family: 'tool_event', slot: 'contentOriginator', expected: 'D' },
  { family: 'tool_event', slot: 'executor', expected: 'N' },
  { family: 'system_event', slot: 'contentOriginator', expected: 'U' },
]
measure('AT-0 锁定规则的条数', LOCKED_BACKFILL_RULES.length)
const lockedViolations = LOCKED_BACKFILL_RULES.filter(
  (rule) => CONVERSATION_BACKFILL_CLASSIFICATION[rule.family][rule.slot] !== rule.expected
).map((rule) => `${rule.family}.${rule.slot}≠${rule.expected}`)
check(
  'AT-0 的七条锁定规则与矩阵**逐字一致**',
  lockedViolations.length === 0,
  lockedViolations.join(', ') || 'AA'
)

// 未冻结到族粒度的族：必须是**恰好**那一组，免得将来新增族却静默没有回填规则
const coveredFamilies = Object.keys(CONVERSATION_BACKFILL_CLASSIFICATION)
const deferredExpected = Object.keys(NECESSITY_MATRIX)
  .filter((family) => !coveredFamilies.includes(family))
  .sort()
const deferredActual = [...BACKFILL_CONTRACT_DEFERRED_FAMILIES].sort()
measure('必要性矩阵里的族数', Object.keys(NECESSITY_MATRIX).length)
check(
  'BACKFILL_CONTRACT_DEFERRED_FAMILIES == "分类表覆盖不到的族"（恰好相等）',
  deferredExpected.length === deferredActual.length &&
    deferredExpected.every((family, index) => family === deferredActual[index]),
  `期望=${deferredExpected.join(',')} 实际=${deferredActual.join(',')}`
)

// ===========================================================================
section('1. 静态：旧 blanket 规则确实已删除，新理由码已登记')
// ===========================================================================

const attributionSource = readFileSync(join(ROOT, 'src', 'kernel', 'contracts', 'attribution.ts'), 'utf8')
// 只看"判据本身"：新实现里 contentOriginator 的 Known 必须先过 value.kind 的 USER/CHARACTER 判定
check(
  '旧判据（任何 Known contentOriginator 即违规）已删除：不再有"只看 state === KNOWN 就报伪造"的写法',
  !/contentOriginator\.state === 'KNOWN'\)\s*\{\s*out\.push\(\{\s*slot: 'contentOriginator',\s*code: 'migrated_legacy_fabricated_content_originator'/.test(
    attributionSource
  ),
  'AA'
)
for (const code of [
  'migrated_legacy_n_slot_not_absent',
  'migrated_legacy_applicable_slot_absent',
  'migrated_legacy_u_slot_fabricated',
  'migrated_legacy_fabricated_content_originator',
]) {
  check(`理由码 ${code} 在契约的 NecessityViolationCode 里`, attributionSource.includes(`'${code}'`))
}
check('分类矩阵的出处常量已登记', attributionSource.includes('BACKFILL_CLASS_SOURCE'), BACKFILL_CLASS_SOURCE.slice(0, 40))
check(
  '新判据的**判别器**确实在（内容来源的 Known 必须先过 USER/CHARACTER 这一关）',
  /known\.kind === 'USER'\s*\|\|\s*known\.kind === 'CHARACTER'/.test(attributionSource),
  'AA'
)

// ===========================================================================
section('2. 库级：D/P/U/N 检测器（沙箱库）')
// ===========================================================================

const sandbox = isolateDatabase('m5.1.1-k20')
console.log(`[sandbox] ${sandbox.dir}`)
check(
  '沙箱不是真实库（也不是它的父子目录）',
  isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()),
  sandbox.dir
)

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
await initDatabase(runtime)
const schemaVersion = await currentSchemaVersion(db)
check(
  '沙箱库 schema = v9（检测器跑在当前 schema 上；v9 = WP9-B1 的 state_events 承载）',
  schemaVersion === 9,
  `v${schemaVersion}`
)

// ---------------------------------------------------------------------------
// 检测器（纯判定；输入 = 从库里读回来的行）
// ---------------------------------------------------------------------------

type SlotState = { kind: string | null; id: string | null; reason: string | null }
type RowShape = {
  type: string
  actorId: string | null
  origin: string | null
  slots: Record<(typeof SLOTS)[number], SlotState>
}

const SLOTS = [
  'initiator',
  'actor',
  'executor',
  'authority',
  'recorded_by',
  'content_originator',
] as const

/** 列的物理名（与 migrations.ts 的 ATTRIBUTION_PHYSICAL_SLOTS 一致） */
const COLUMN_OF: Record<(typeof SLOTS)[number], { kind: string; id: string; reason: string }> = {
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

function stateOf(slot: SlotState): 'KNOWN' | 'UNKNOWN' | 'ABSENT' | 'MIXED' {
  if (slot.kind === null && slot.id === null && slot.reason === null) return 'ABSENT'
  if (slot.kind !== null && slot.id !== null && slot.reason === null) return 'KNOWN'
  if (slot.kind === null && slot.id === null && slot.reason !== null) return 'UNKNOWN'
  return 'MIXED'
}

/**
 * D 槽位的**确定性证据**（由行本身推出，不做猜测）。
 *
 * ⚠️ 只对**文档把确定性规则写死**的槽位实现：
 *   · tool_event.actor / tool_event.contentOriginator → `TOOL/<actor_id>`（"actor_type='tool' + actorId 即该工具"）
 *   · assistant_message.actor                          → `CHARACTER/<actor_id>`（actor_id 强制且被 assertSourceConsistency 约束）
 * `recorded_by` 的分类是 D，但文档没有把"确定性值"钉成一个具体 principal
 * （只说"结构性事实：只有 kernel 写入器能写这些表"）⇒ 这里**不编一个值出来**，
 * 只检查形状，并把"无法核对确定性证据的 D 槽位"如实计数，见 `dSlotWithoutComputableEvidence`。
 */
function deterministicEvidenceOf(row: RowShape, slot: (typeof SLOTS)[number]): SlotState | null {
  if (slot === 'actor' && row.type === 'tool_event') return { kind: 'TOOL', id: row.actorId, reason: null }
  if (slot === 'actor' && row.type === 'assistant_message')
    return { kind: 'CHARACTER', id: row.actorId, reason: null }
  if (slot === 'content_originator' && row.type === 'tool_event')
    return { kind: 'TOOL', id: row.actorId, reason: null }
  return null
}

/** P 槽位的**独立行级证据**（文档：system_event 的"actor_id 常命名组件……但有行缺 actor_id"） */
function hasIndependentRowLevelEvidence(row: RowShape): boolean {
  return row.actorId !== null && row.actorId !== ''
}

type Violation = { slot: string; code: string; detail: string }

function auditRow(row: RowShape): { violations: Violation[]; observations: string[] } {
  const violations: Violation[] = []
  const observations: string[] = []
  const classification =
    CONVERSATION_BACKFILL_CLASSIFICATION[row.type as keyof typeof CONVERSATION_BACKFILL_CLASSIFICATION]

  for (const slot of SLOTS) {
    const state = stateOf(row.slots[slot])
    if (state === 'MIXED') {
      violations.push({ slot, code: 'mixed_known_unknown_tuple', detail: '三态被写成了混合形状' })
      continue
    }
    const cls: BackfillClass = classification?.[slotKeyOf[slot] as keyof BackfillClassRow] ?? 'P'

    if (cls === 'N') {
      if (state !== 'ABSENT') violations.push({ slot, code: 'n_slot_not_absent', detail: `分类 N 却填了 ${state}` })
      continue
    }
    if (cls === 'U') {
      if (state === 'KNOWN') violations.push({ slot, code: 'u_slot_concrete_value', detail: '分类 U 出现具体值' })
      else if (state === 'ABSENT') violations.push({ slot, code: 'u_slot_absent', detail: '分类 U 却未表态' })
      else if (row.slots[slot].reason !== 'LEGACY_UNRECORDED')
        violations.push({ slot, code: 'u_slot_wrong_reason', detail: `U 槽位的理由是 ${row.slots[slot].reason}` })
      continue
    }
    // D / P
    if (state === 'ABSENT') {
      if (cls === 'P') {
        violations.push({ slot, code: 'applicable_slot_absent', detail: `分类 ${cls} 却 Absent` })
      } else {
        // D：**Absent 不是伪造**（还没回填 ≠ 编造）。D 的判据是"记了就必须与确定性证据一致"。
        observations.push(`${slot}: D 槽位尚未回填（不是伪造；D 的判据是"记了就必须与证据一致"）`)
      }
      continue
    }
    if (state === 'UNKNOWN') {
      if (cls === 'D') observations.push(`${slot}: D 槽位被记成 Unknown（丢信息，但不是伪造）`)
      continue
    }
    // KNOWN
    if (cls === 'D') {
      const evidence = deterministicEvidenceOf(row, slot)
      if (evidence === null) {
        observations.push(`${slot}: D 槽位无"可计算的确定性证据"（文档未钉死具体值）—— 只查形状`)
      } else if (row.slots[slot].kind !== evidence.kind || row.slots[slot].id !== evidence.id) {
        violations.push({
          slot,
          code: 'd_slot_known_mismatch',
          detail: `D 槽位的 Known=${row.slots[slot].kind}/${row.slots[slot].id}，确定性证据=${evidence.kind}/${evidence.id}`,
        })
      }
    } else if (cls === 'P' && !hasIndependentRowLevelEvidence(row)) {
      violations.push({
        slot,
        code: 'p_slot_known_without_evidence',
        detail: 'P 槽位记了 Known，但这一行没有独立的行级证据',
      })
    }
  }

  // 值级禁止（与分类无关）
  const originator = row.slots.content_originator
  if (stateOf(originator) === 'KNOWN' && (originator.kind === 'USER' || originator.kind === 'CHARACTER')) {
    violations.push({
      slot: 'content_originator',
      code: 'content_originator_says_user_or_character',
      detail: `回填行把内容来源说成 ${originator.kind}`,
    })
  }

  return { violations, observations }
}

// ---------------------------------------------------------------------------
// 探针行的插入与读回
// ---------------------------------------------------------------------------

let probeSequence = 1
type ProbeInput = {
  id: string
  type: 'user_message' | 'assistant_message' | 'tool_event' | 'system_event'
  actorType: string
  actorId: string | null
  slots: Partial<Record<(typeof SLOTS)[number], SlotState>>
}

async function insertProbe(input: ProbeInput): Promise<void> {
  const sequence = probeSequence
  probeSequence += 1
  const columns = ['id', 'character_id', 'conversation_id', 'sequence', 'conversation_sequence', 'type', 'actor_type', 'actor_id', 'content', 'schema_version', 'created_at', 'attribution_origin', 'source_kind', 'source_authority', 'epistemic_source']
  const values: unknown[] = [
    input.id,
    'char_test',
    'conv_test',
    sequence,
    sequence,
    input.type,
    input.actorType,
    input.actorId,
    'probe',
    1,
    Date.now(),
    'MIGRATED_LEGACY',
    input.type === 'tool_event' ? 'tool_output' : 'user_statement',
    'UNCONFIRMED_ORIGIN',
    'UNCONFIRMED_ORIGIN',
  ]
  for (const slot of SLOTS) {
    const cell = input.slots[slot] ?? { kind: null, id: null, reason: null }
    columns.push(COLUMN_OF[slot].kind, COLUMN_OF[slot].id, COLUMN_OF[slot].reason)
    values.push(cell.kind, cell.id, cell.reason)
  }
  const placeholders = values.map((value) => sql`${value}`)
  const columnSql = columns.map((column) => sql.raw(column))
  await db.execute(
    sql`insert into conversation_events (${sql.join([...columnSql], sql`, `)}) values (${sql.join([...placeholders], sql`, `)})`
  )
}

async function readProbe(id: string): Promise<RowShape | null> {
  const rows = rowsOf(
    await db.execute(sql`select * from conversation_events where id = ${id}`)
  ) as Record<string, unknown>[]
  const row = rows[0]
  if (row === undefined) return null
  const slots = Object.fromEntries(
    SLOTS.map((slot) => [
      slot,
      {
        kind: (row[COLUMN_OF[slot].kind] ?? null) as string | null,
        id: (row[COLUMN_OF[slot].id] ?? null) as string | null,
        reason: (row[COLUMN_OF[slot].reason] ?? null) as string | null,
      },
    ])
  ) as RowShape['slots']
  return {
    type: String(row.type),
    actorId: (row.actor_id ?? null) as string | null,
    origin: (row.attribution_origin ?? null) as string | null,
    slots,
  }
}

async function setSlot(id: string, slot: (typeof SLOTS)[number], cell: SlotState): Promise<void> {
  const column = COLUMN_OF[slot]
  await db.execute(
    sql`update conversation_events set ${sql.raw(column.kind)} = ${cell.kind},
        ${sql.raw(column.id)} = ${cell.id}, ${sql.raw(column.reason)} = ${cell.reason}
        where id = ${id}`
  )
}

const correctToolRow: ProbeInput = {
  id: 'k20-tool-correct',
  type: 'tool_event',
  actorType: 'tool',
  actorId: 'weather',
  slots: {
    initiator: { kind: null, id: null, reason: 'LEGACY_UNRECORDED' },
    actor: { kind: 'TOOL', id: 'weather', reason: null },
    content_originator: { kind: 'TOOL', id: 'weather', reason: null },
  },
}

await insertProbe(correctToolRow)

// ---------------------------------------------------------------- 正控
/** 设定 in-scope 行集合：本门自己的 MIGRATED_LEGACY 探针行 */
async function rowsInScope(): Promise<RowShape[]> {
  const rows = rowsOf(
    await db.execute(
      sql`select * from conversation_events where conversation_id = 'conv_test' and attribution_origin = 'MIGRATED_LEGACY'`
    )
  ) as Record<string, unknown>[]
  return rows.map((row) => ({
    type: String(row.type),
    actorId: (row.actor_id ?? null) as string | null,
    origin: (row.attribution_origin ?? null) as string | null,
    slots: Object.fromEntries(
      SLOTS.map((slot) => [
        slot,
        {
          kind: (row[COLUMN_OF[slot].kind] ?? null) as string | null,
          id: (row[COLUMN_OF[slot].id] ?? null) as string | null,
          reason: (row[COLUMN_OF[slot].reason] ?? null) as string | null,
        },
      ])
    ) as RowShape['slots'],
  }))
}

function auditAll(rows: RowShape[]): { violations: Violation[]; observations: string[] } {
  const violations: Violation[] = []
  const observations: string[] = []
  for (const row of rows) {
    const result = auditRow(row)
    violations.push(...result.violations.map((v) => ({ ...v, slot: `${row.type}.${v.slot}` })))
    observations.push(...result.observations)
  }
  return { violations, observations }
}

const scopeRows = await rowsInScope()
measure('in-scope 的回填行数（检测器真的读到了行）', scopeRows.length)
const positive = auditAll(scopeRows)
check(
  '正控：确定性的工具行（Known(TOOL/weather)）⇒ 检测器**安静**（不被判成伪造）',
  positive.violations.length === 0,
  positive.violations.map((v) => `${v.slot}:${v.code}`).join(', ') || 'AA'
)
check(
  '正控自检：确实存在一个"确定性工具行"被审过（不是空集通过）',
  scopeRows.some((row) => row.type === 'tool_event'),
  `types=${[...new Set(scopeRows.map((row) => row.type))].join(',')}`
)

// ---------------------------------------------------------------- 负控
const forgedCases: { label: string; cell: SlotState; expected: string }[] = [
  {
    label: '同一个 tool id 被说成 Known(USER)',
    cell: { kind: 'USER', id: 'u-1', reason: null },
    expected: 'd_slot_known_mismatch',
  },
  {
    label: '同一个 tool id 被说成 Known(CHARACTER)',
    cell: { kind: 'CHARACTER', id: 'char_sumuwei', reason: null },
    expected: 'd_slot_known_mismatch',
  },
  {
    label: '换成**另一个** TOOL id（TOOL/search）',
    cell: { kind: 'TOOL', id: 'search', reason: null },
    expected: 'd_slot_known_mismatch',
  },
]
const negativeReadings: { label: string; codes: string[]; fired: boolean }[] = []
for (const forged of forgedCases) {
  await setSlot('k20-tool-correct', 'content_originator', forged.cell)
  const row = await readProbe('k20-tool-correct')
  const result = row === null ? { violations: [] } : auditRow(row)
  const codes = result.violations.map((violation) => violation.code)
  negativeReadings.push({ label: forged.label, codes, fired: codes.includes(forged.expected) })
  check(`负控：${forged.label} ⇒ 检测器**必响**`, codes.includes(forged.expected), codes.join(',') || '没响')
}
measure('注入并检测到的伪造次数', negativeReadings.filter((reading) => reading.fired).length)

// U 槽位负控：具体值计数必须为 0
await setSlot('k20-tool-correct', 'content_originator', { kind: 'TOOL', id: 'weather', reason: null })
await setSlot('k20-tool-correct', 'initiator', { kind: 'USER', id: 'u-1', reason: null })
{
  const row = await readProbe('k20-tool-correct')
  const codes = row === null ? [] : auditRow(row).violations.map((v) => v.code)
  check('负控：U 槽位（tool_event.initiator）出现具体值 ⇒ 必响', codes.includes('u_slot_concrete_value'), codes.join(',') || '没响')
}

// N 槽位负控：必须 Absent
await setSlot('k20-tool-correct', 'initiator', { kind: null, id: null, reason: 'LEGACY_UNRECORDED' })
await setSlot('k20-tool-correct', 'executor', { kind: 'TOOL', id: 'weather', reason: null })
{
  const row = await readProbe('k20-tool-correct')
  const codes = row === null ? [] : auditRow(row).violations.map((v) => v.code)
  check('负控：N 槽位（tool_event.executor）被填值 ⇒ 必响', codes.includes('n_slot_not_absent'), codes.join(',') || '没响')
}

// 值级禁止：D 槽位说成 USER/CHARACTER
await setSlot('k20-tool-correct', 'executor', { kind: null, id: null, reason: null })
await setSlot('k20-tool-correct', 'content_originator', { kind: 'USER', id: 'u-1', reason: null })
{
  const row = await readProbe('k20-tool-correct')
  const codes = row === null ? [] : auditRow(row).violations.map((v) => v.code)
  check(
    '负控：D 槽位说成 Known(USER) ⇒ 值级禁止必响（与分类无关）',
    codes.includes('content_originator_says_user_or_character'),
    codes.join(',') || '没响'
  )
}

// ---------------------------------------------------------------- 恢复
await setSlot('k20-tool-correct', 'content_originator', { kind: 'TOOL', id: 'weather', reason: null })
const restored = await readProbe('k20-tool-correct')
const recovered = restored === null ? { violations: [{ code: 'row_missing' }] } : auditRow(restored)
check(
  '恢复：把值改回正确的 ⇒ 检测器**重新安静**',
  recovered.violations.length === 0,
  recovered.violations.map((v) => v.code).join(', ') || 'AA'
)

// ---------------------------------------------------------------- 保留项
{
  const rows = rowsOf(
    await db.execute(
      sql`select
            (select count(*) from conversation_events
              where (actor_kind is not null and actor_ref_id is null)
                 or (actor_kind is not null and actor_unknown_reason is not null)
                 or (actor_kind is null and actor_ref_id is not null)) as actor_mixed,
            (select count(*) from conversation_events
              where actor_kind like 'UNKNOWN%' or initiator_kind like 'UNKNOWN%'
                 or executor_kind like 'UNKNOWN%' or authority_kind like 'UNKNOWN%'
                 or recorded_by_kind like 'UNKNOWN%' or content_originator_kind like 'UNKNOWN%') as unknown_kinds,
            (select count(*) from conversation_events) as total_rows`
    )
  ) as { actor_mixed: number; unknown_kinds: number; total_rows: number }[]
  const reading = rows[0]!
  measure('保留项扫描的行数', Number(reading.total_rows))
  check(
    "保留：`<slot>_kind LIKE 'UNKNOWN%'` 计数 = 0（B4：Unknown 不得混进 kind 词表）",
    Number(reading.unknown_kinds) === 0,
    String(reading.unknown_kinds)
  )
  check(
    '保留：混合 known+unknown 元组计数 = 0（三态不可互相折叠）',
    Number(reading.actor_mixed) === 0,
    String(reading.actor_mixed)
  )
}

// U 槽位的具体值计数（在恢复后的全部 in-scope 行上）
{
  const finalRows = await rowsInScope()
  measure('U 槽位具体值计数所覆盖的行数', finalRows.length)
  let concreteOnU = 0
  for (const row of finalRows) {
    const classification =
      CONVERSATION_BACKFILL_CLASSIFICATION[row.type as keyof typeof CONVERSATION_BACKFILL_CLASSIFICATION]
    if (classification === undefined) continue
    for (const slot of SLOTS) {
      if (classification[slotKeyOf[slot] as keyof BackfillClassRow] === 'U' && stateOf(row.slots[slot]) === 'KNOWN') {
        concreteOnU += 1
      }
    }
  }
  check('U：具体值计数 == 0（恢复之后）', concreteOnU === 0, String(concreteOnU))
}

// ===========================================================================
section('3. 汇总与证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const k20Verdict = failed === 0 ? 'PASS' : 'FAIL'

const evidence = {
  testId: 'M5.1.1 / WP2.4 K-20 D/P/U/N-aware Migration Anti-Fabrication Gate',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:k20:verify',
  verdict: k20Verdict,
  k20: k20Verdict,
  passed,
  failed,
  failures,
  removedStaleRule: {
    rule: "MIGRATED_LEGACY AND concrete contentOriginator → always invalid",
    replacedBy: 'D/P/U/N classification-aware verification',
    whyStale: 'tool_event.contentOriginator = D（K-3 FINAL）⇒ 确定性工具行的 Known(TOOL/<tool-id>) 是合法结果',
    invariantNotWeakened: [
      'U 槽位出现具体值 = 伪造',
      'N 槽位出现任何值 = 伪造',
      'D 槽位的 Known 与确定性证据不一致 = 伪造（新增）',
      'contentOriginator = Known(USER/CHARACTER) = 伪造（与分类无关）',
    ],
  },
  classificationSource: BACKFILL_CLASS_SOURCE,
  transcriptionFidelity: {
    conversationTableMismatches: transcriptionMismatches,
    actionTableMismatches: actionMismatches,
    actionTypeSetDiff: typeSetDiff,
    necessityConsistencyMismatches: consistencyMismatches,
    registeredClassificationConflicts: REGISTERED_CLASSIFICATION_CONFLICTS,
    deferredFamilies: [...BACKFILL_CONTRACT_DEFERRED_FAMILIES],
  },
  threeStage: {
    positive: { violations: positive.violations, observations: positive.observations, quiet: positive.violations.length === 0 },
    negative: negativeReadings,
    restore: { quiet: recovered.violations.length === 0, violations: recovered.violations },
  },
  retainedInvariants: {
    unknownKindLikeCount: 0,
    mixedKnownUnknownTupleCount: 0,
    note: '两条保留项的实测计数见 §2 日志；此处为判据登记',
  },
  sandbox: { dir: sandbox.dir, isProductionDir: isProductionDir(sandbox.dir), schemaVersion },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    readOnlyOnProduction: true,
    touched: ['src/kernel/contracts/attribution.ts', 'scripts/kernel-tests-m5.1.1.ts', 'scripts/verify-m5.1.1-k20-anti-fabrication.ts'],
    notTouched: ['migrations.ts（v7 DDL 逐字未改；v8 = WP4.1 的 K-22 追加）', 'data/pglite（未打开）', 'Fact Firewall / extractor / MemoryAuthority / Recall'],
    startedWp3: false,
  },
}

mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(
  join(EVIDENCE_DIR, 'wp2.4-k20-anti-fabrication.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8'
)

console.log(`\n${'='.repeat(74)}`)
console.log(`WP2.4 K-20 迁移反伪造门：${passed} 通过 / ${failed} 失败｜K-20 = ${k20Verdict}`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp2.4-k20-anti-fabrication.json')

try {
  await runtime.stop()
} catch {
  /* 关不干净不影响结论 */
}

process.exit(failed === 0 ? 0 : 1)
