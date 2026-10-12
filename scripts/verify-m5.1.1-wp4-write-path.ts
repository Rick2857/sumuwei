/**
 * M5.1.1 WP4 step 3/3 —— **写路径门**（`pnpm m5.1.1:wp4:verify`）
 *
 * ============================================================================
 *  它证明的是"记录真相"，不是"行为变化"
 * ============================================================================
 * 走**真实 store**（`appendConversationEvent`）写、**立即回读**，回答：
 *   · 六个场景（AT-W4-6）能不能真的落库，且
 *     **写入时 == DB 存储 == 立即回读**（AT-W4-8，**逐槽位**比较，不是摘要相等）
 *   · **D01 回归**：`actor_type=user` + `actor=SERVICE/agent` +
 *     `contentOriginator=SERVICE/agent` + Axis B 成对 UNCONFIRMED 是否**原样**落库、
 *     **原样**回读（任何 USER 替换 = FAIL）
 *   · 不可信载荷 / 篡改（AT-W4-7）会不会变成权威归因（三段式：正控 / 负控 / 恢复）
 *   · legacy 兼容路径（`MIGRATED_LEGACY` / 无 origin）**不得覆盖** RECORDED 归因
 *   · 会话内序号的分配：**期望失败的负控不得消耗**后续恢复用例的序号
 *
 * ⚠️ AT-W4-9（行为冻结）：本门**不**检查 Fact Firewall / MemoryAuthority /
 *    extractor / Recall —— 那些本 WP 一个字都没改。
 *
 * 跑法：pnpm m5.1.1:wp4:verify
 */

import 'dotenv/config'

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import {
  ATTRIBUTION_SLOT_COLUMNS,
  ATTRIBUTION_VALUE_SLOTS,
  assertNoCallerSuppliedAttribution,
  assertNoUntrustedAttributionFields,
  attestActorFromDecisionPoint as attestActor,
  attestContentOriginatorFromIngress as attestOriginator,
  attestEpistemicConfirmation as attestEpistemic,
  attributionSlotsOfContext,
  buildTrustedAttributionContext,
  isTrustedAttributionContext,
  type AttributionValueSlot,
  type ConversationFamily,
  type EpistemicAttestationKind,
  type TrustedAttributionContext,
} from '../src/kernel/contracts/attribution.ts'
import type { AttributionValue, PrincipalRef } from '../src/kernel/contracts/actor.ts'
import { asCharacterId, asConversationId } from '../src/kernel/contracts/ids.ts'
import { deriveSourceForLegacyRow } from '../src/kernel/contracts/conversation-event.ts'
import {
  appendConversationEvent,
  findByConversationSequence,
} from '../src/infrastructure/persistence/conversation-store.ts'
import { classifyRecordedAxisB } from '../src/kernel/contracts/source-authority.ts'
import { currentSchemaVersion, getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'

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
const AGENT: PrincipalRef = { kind: 'SERVICE', id: 'agent' } as PrincipalRef
const TOOL: PrincipalRef = { kind: 'TOOL', id: 'weather' } as PrincipalRef
const SUMUWEI: PrincipalRef = { kind: 'CHARACTER', id: 'char_sumuwei' } as PrincipalRef
const LEDGER: PrincipalRef = { kind: 'SYSTEM', id: 'event-ledger' } as PrincipalRef

console.log('='.repeat(74))
console.log('M5.1.1 WP4 step 3/3 —— 写路径门（真实 store + 立即回读）')
console.log('='.repeat(74))

const sandbox = isolateDatabase('m5.1.1-wp4')
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
  '沙箱库 schema = v9（WP4.1 起：v8 只碰 character_action_events，本门判据不变；' +
    'v9 只碰 state_events，同样不影响本门）',
  schemaVersion === 9,
  `v${schemaVersion}`
)

const characterId = asCharacterId('char_sumuwei')
const MAIN = asConversationId('conv_wp4')
const NEG = asConversationId('conv_wp4_neg')
const LEGACY = asConversationId('conv_wp4_legacy_store')
const LEGACY_CHARACTER = asCharacterId('char_wp4_legacy')
const LEGACY_RAW = asConversationId('conv_wp4_legacy_raw')
/**
 * 会话内序号是**调用方给的**（`conversationSequence`）。期望失败的负控**不消耗**它 ——
 * 被拒的写入在库里没有行，那个号码仍然空着。下面的 `NEG_CANDIDATE` 同时被
 * "所有负控"与"恢复用例"使用，正是为了证明这一点（见 §6 序号审计）。
 */
const NEG_CANDIDATE = 2

// ---------------------------------------------------------------------------
// 三态比较（写入时 / DB / 回读 三份，逐字段）
// ---------------------------------------------------------------------------

interface CellTriple {
  state: string
  kind: string | null
  id: string | null
  reason: string | null
}
const ABSENT_TRIPLE: CellTriple = { state: 'ABSENT', kind: null, id: null, reason: null }
const NO_ENVELOPE: CellTriple = { state: 'NO_ENVELOPE', kind: null, id: null, reason: null }
const INVALID_SHAPE: CellTriple = { state: 'INVALID_SHAPE', kind: null, id: null, reason: null }

function tripleOfValue(value: AttributionValue<unknown> | undefined): CellTriple {
  if (value === undefined) return NO_ENVELOPE
  if (value.state === 'KNOWN') {
    const ref = value.value as { kind?: string; id?: string; ref?: string }
    return { state: 'KNOWN', kind: ref.kind ?? null, id: ref.id ?? ref.ref ?? null, reason: null }
  }
  if (value.state === 'UNKNOWN') return { state: 'UNKNOWN', kind: null, id: null, reason: value.reason }
  return ABSENT_TRIPLE
}

function tripleOfCells(
  row: Record<string, unknown>,
  slot: AttributionValueSlot
): CellTriple {
  const columns = ATTRIBUTION_SLOT_COLUMNS[slot]
  const kind = (row[columns.kind] ?? null) as string | null
  const id = (row[columns.id] ?? null) as string | null
  const reason = (row[columns.unknownReason] ?? null) as string | null
  if (kind === null && id === null && reason === null) return ABSENT_TRIPLE
  if (kind === null && id === null && reason !== null) return { state: 'UNKNOWN', kind: null, id: null, reason }
  if (kind !== null && id !== null && reason === null) return { state: 'KNOWN', kind, id, reason: null }
  return { state: 'INVALID_SHAPE', kind, id, reason }
}

const tripleKey = (triple: CellTriple): string =>
  `${triple.state}|${triple.kind ?? '-'}|${triple.id ?? '-'}|${triple.reason ?? '-'}`

async function readRow(
  conversationId: string,
  seq: number,
  character: ReturnType<typeof asCharacterId> = characterId
): Promise<Record<string, unknown>> {
  const rows = rowsOf(
    await db.execute(
      sql`select * from conversation_events where character_id = ${String(character)}
            and conversation_id = ${conversationId} and conversation_sequence = ${seq}`
    )
  ) as Record<string, unknown>[]
  return rows[0] ?? {}
}

// ---------------------------------------------------------------------------
// 受信写入
// ---------------------------------------------------------------------------

interface WriteSpec {
  family: ConversationFamily
  actorType: 'user' | 'character' | 'system' | 'tool'
  actorId?: string
  actorPrincipal: PrincipalRef | null
  originatorPrincipal: PrincipalRef | null
  unresolvedReason?: 'RUNTIME_UNRESOLVED'
  attestKind?: EpistemicAttestationKind
}

function buildContext(spec: WriteSpec): TrustedAttributionContext {
  return buildTrustedAttributionContext({
    family: spec.family,
    characterId: 'char_sumuwei',
    /*
     * K-29（2026-09-18）：`unresolvedReason` 现在**同时**给 actor 与 contentOriginator。
     *
     * 旧写法只把它给 originator，于是 ⑥ 号场景（runtime-unresolved）的
     * `actor` 落成 **Absent** —— 而冻结矩阵里 `user_message.actor` 是 `REQUIRED`
     * （`REQUIRED` 允许 `Unknown(RUNTIME_UNRESOLVED)`、**不允许** `Absent`，裁定 U-04）。
     * 那是一条**非法 envelope**，K-29 把必要性判据接到构造器之后它**必须**变红。
     *
     * 这里**不是**放宽判据：⑥ 号场景仍然断言"运行时定不下来 ⇒ Unknown(RUNTIME_UNRESOLVED)
     * + unconfirmed"，只是那个"定不下来"现在按裁定的合法形态表达（Unknown 而不是 Absent）。
     * 见 `M5.1.1-K29-Compatible-Assertion-Record.md`。
     */
    actorEvidence: attestActor({
      adapterId: 'gateway',
      principal: spec.actorPrincipal,
      ...(spec.unresolvedReason ? { unresolvedReason: spec.unresolvedReason } : {}),
    }),
    contentOriginatorEvidence: attestOriginator({
      adapterId: 'ingress',
      principal: spec.originatorPrincipal,
      ...(spec.unresolvedReason ? { unresolvedReason: spec.unresolvedReason } : {}),
    }),
    ...(spec.attestKind
      ? { epistemicEvidence: attestEpistemic({ adapterId: 'attestation', kind: spec.attestKind }) }
      : {}),
  })
}

/** 每个会话自己的序号计数器（会话内序号由调用方给，见 `NEG_CANDIDATE` 的说明） */
const conversationSequenceOf = new Map<string, number>()
function nextSequence(conversationId: string): number {
  const next = (conversationSequenceOf.get(conversationId) ?? 0) + 1
  conversationSequenceOf.set(conversationId, next)
  return next
}

/** 落库尝试（成功 / 被拒都返回结果，不抛） */
async function attemptAppend(input: {
  conversationId: string
  conversationSequence: number
  family: ConversationFamily
  actorType: WriteSpec['actorType']
  actorId?: string
  content: string
  trustedAttribution?: TrustedAttributionContext
  trustedAttributionRaw?: unknown
}): Promise<{ ok: boolean; code: string | null; event: Awaited<ReturnType<typeof findByConversationSequence>> }> {
  try {
    const result = await appendConversationEvent(db, {
      characterId,
      conversationId: asConversationId(input.conversationId),
      conversationSequence: input.conversationSequence,
      type: input.family,
      actorType: input.actorType,
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      content: input.content,
      ...(input.trustedAttributionRaw !== undefined
        ? { trustedAttribution: input.trustedAttributionRaw as TrustedAttributionContext }
        : input.trustedAttribution !== undefined
          ? { trustedAttribution: input.trustedAttribution }
          : {}),
    })
    return { ok: true, code: null, event: result.event }
  } catch (error) {
    return {
      ok: false,
      code: (error as { code?: string }).code ?? (error as Error).name,
      event: undefined,
    }
  }
}

interface Scenario {
  label: string
  family: ConversationFamily
  actorType: 'user' | 'character' | 'system' | 'tool'
  actorId?: string
  actorPrincipal: PrincipalRef | null
  originatorPrincipal: PrincipalRef | null
  unresolvedReason?: 'RUNTIME_UNRESOLVED'
  attestKind?: EpistemicAttestationKind
  expectBranch: 'confirmed' | 'unconfirmed'
}

// ===========================================================================
section('AT-W4-6 六个场景：写入时 == DB 存储 == 立即回读（**逐槽位**）')
// ===========================================================================

const scenarios: Scenario[] = [
  {
    label: '① trusted human user message',
    family: 'user_message',
    actorType: 'user',
    actorId: 'u-1',
    actorPrincipal: USER,
    originatorPrincipal: USER,
    attestKind: 'authenticated_human_input',
    expectBranch: 'confirmed',
  },
  {
    label: '② agent/service 以 user 角色提交（**D01 回归**）',
    family: 'user_message',
    actorType: 'user',
    actorId: 'agent',
    actorPrincipal: AGENT,
    originatorPrincipal: AGENT,
    expectBranch: 'unconfirmed',
  },
  {
    label: '③ assistant message',
    family: 'assistant_message',
    actorType: 'character',
    actorId: 'char_sumuwei',
    actorPrincipal: SUMUWEI,
    originatorPrincipal: SUMUWEI,
    attestKind: 'character_self_generation',
    expectBranch: 'confirmed',
  },
  {
    label: '④ system event',
    family: 'system_event',
    actorType: 'system',
    actorId: 'event-ledger',
    actorPrincipal: LEDGER,
    originatorPrincipal: LEDGER,
    attestKind: 'system_instruction_source',
    expectBranch: 'confirmed',
  },
  {
    label: '⑤ tool observation event',
    family: 'tool_event',
    actorType: 'tool',
    actorId: 'weather',
    actorPrincipal: TOOL,
    originatorPrincipal: TOOL,
    attestKind: 'tool_observation_source',
    expectBranch: 'confirmed',
  },
  {
    label: '⑥ runtime-unresolved origin',
    family: 'user_message',
    actorType: 'user',
    actorPrincipal: null,
    originatorPrincipal: null,
    unresolvedReason: 'RUNTIME_UNRESOLVED',
    expectBranch: 'unconfirmed',
  },
]
measure('AT-W4-6 场景数', scenarios.length)

let slotComparisons = 0
const scenarioReadings: Record<string, unknown>[] = []

for (const scenario of scenarios) {
  const context = buildContext(scenario)
  const conversationSequence = nextSequence(MAIN)
  const attempt = await attemptAppend({
    conversationId: MAIN,
    conversationSequence,
    family: scenario.family,
    actorType: scenario.actorType,
    ...(scenario.actorId !== undefined ? { actorId: scenario.actorId } : {}),
    content: scenario.label,
    trustedAttribution: context,
  })
  const row = await readRow(MAIN, conversationSequence)
  const readback = await findByConversationSequence(db, characterId, MAIN, conversationSequence)

  // --- 六个槽位：写入时（context） vs DB 列 vs 回读信封 ---
  const writeSlots = attributionSlotsOfContext(context)
  const writeReadings: Record<string, string> = {}
  const dbReadings: Record<string, string> = {}
  const readbackReadings: Record<string, string> = {}
  const slotMismatches: string[] = []
  for (const slot of ATTRIBUTION_VALUE_SLOTS) {
    const write = tripleOfValue(writeSlots[slot])
    const stored = tripleOfCells(row, slot)
    const read = tripleOfValue(readback?.attribution?.slots[slot])
    writeReadings[slot] = tripleKey(write)
    dbReadings[slot] = tripleKey(stored)
    readbackReadings[slot] = tripleKey(read)
    slotComparisons += 1
    if (tripleKey(write) !== tripleKey(stored) || tripleKey(stored) !== tripleKey(read)) {
      slotMismatches.push(`${slot}(写=${tripleKey(write)} 库=${tripleKey(stored)} 读=${tripleKey(read)})`)
    }
  }

  // --- Axis B：写入时 vs DB vs 回读（**逐列**） ---
  const axisBMismatches: string[] = []
  for (const [key, written] of [
    ['source_kind', context.axisB.sourceKind],
    ['source_authority', context.axisB.sourceAuthority],
    ['epistemic_source', context.axisB.epistemicSource],
  ] as const) {
    const stored = row[key] ?? null
    const read = (readback as unknown as Record<string, unknown> | undefined)?.[
      key === 'source_kind' ? 'sourceKind' : key === 'source_authority' ? 'sourceAuthority' : 'epistemicSource'
    ]
    slotComparisons += 1
    if (written !== stored || stored !== read) {
      axisBMismatches.push(`${key}(写=${String(written)} 库=${String(stored)} 读=${String(read)})`)
    }
  }

  const originOk =
    row.attribution_origin === 'RECORDED' && readback?.attribution?.attributionOrigin === 'RECORDED'
  const actorTypeOk =
    row.actor_type === context.presenterActorType &&
    readback?.actorType === context.presenterActorType &&
    context.presenterActorType === scenario.actorType
  const branch = row.source_authority === 'UNCONFIRMED_ORIGIN' ? 'unconfirmed' : 'confirmed'
  const branchOk = branch === scenario.expectBranch && context.axisB.branch === scenario.expectBranch

  const ok =
    attempt.ok &&
    attempt.event?.attribution !== undefined &&
    slotMismatches.length === 0 &&
    axisBMismatches.length === 0 &&
    originOk &&
    actorTypeOk &&
    branchOk

  scenarioReadings.push({
    label: scenario.label,
    conversation: MAIN,
    conversationSequence,
    actorType: row.actor_type,
    presenterActorType: context.presenterActorType,
    branch,
    expectedBranch: scenario.expectBranch,
    attributionOrigin: row.attribution_origin,
    recordedBy: `${String(row.recorded_by_kind)}/${String(row.recorded_by_id)}`,
    axisB: {
      write: {
        sourceKind: context.axisB.sourceKind,
        sourceAuthority: context.axisB.sourceAuthority,
        epistemicSource: context.axisB.epistemicSource,
      },
      db: {
        sourceKind: row.source_kind,
        sourceAuthority: row.source_authority,
        epistemicSource: row.epistemic_source,
      },
      readback: {
        sourceKind: readback?.sourceKind,
        sourceAuthority: readback?.sourceAuthority,
        epistemicSource: readback?.epistemicSource,
      },
    },
    slots: { write: writeReadings, db: dbReadings, readback: readbackReadings },
    slotMismatches,
    axisBMismatches,
  })
  check(
    `AT-W4-6 ${scenario.label}`,
    ok,
    `写=库=读 逐槽位一致${slotMismatches.length > 0 ? ` 槽位不符：${slotMismatches.join(' ')}` : ''}` +
      `${axisBMismatches.length > 0 ? ` AxisB 不符：${axisBMismatches.join(' ')}` : ''}` +
      `${originOk ? '' : ` origin=${String(row.attribution_origin)}/${String(readback?.attribution?.attributionOrigin)}`}`
  )
}
measure('§1 槽位/AxisB 三方比较次数', slotComparisons)

// ===========================================================================
section('AT-W4-8 D01 回归硬断言（任何 USER 替换 = FAIL）')
// ===========================================================================

const d01Row = await readRow(MAIN, 2)
const d01Readback = await findByConversationSequence(db, characterId, MAIN, 2)
const d01Actor = tripleOfValue(d01Readback?.attribution?.slots.actor)
const d01Originator = tripleOfValue(d01Readback?.attribution?.slots.contentOriginator)
const d01RecordedBy = tripleOfValue(d01Readback?.attribution?.slots.recordedBy)

check(
  '★ D01-a 库：actor_type=user 而 actor=SERVICE/agent（未被改写成 USER）',
  d01Row.actor_type === 'user' &&
    d01Row.actor_kind === 'SERVICE' &&
    d01Row.actor_ref_id === 'agent',
  `actor_type=${String(d01Row.actor_type)} actor=${String(d01Row.actor_kind)}/${String(d01Row.actor_ref_id)}`
)
check(
  '★ D01-b 库：contentOriginator=SERVICE/agent（未被改写成 USER）',
  d01Row.content_originator_kind === 'SERVICE' &&
    d01Row.content_originator_id === 'agent' &&
    d01Row.content_originator_unknown_reason === null,
  `contentOriginator=${String(d01Row.content_originator_kind)}/${String(d01Row.content_originator_id)}`
)
check(
  '★ D01-c 库：source_kind=user_statement · source_authority=UNCONFIRMED_ORIGIN · epistemic_source=UNCONFIRMED_ORIGIN',
  d01Row.source_kind === 'user_statement' &&
    d01Row.source_authority === 'UNCONFIRMED_ORIGIN' &&
    d01Row.epistemic_source === 'UNCONFIRMED_ORIGIN',
  `${String(d01Row.source_kind)} · ${String(d01Row.source_authority)} / ${String(d01Row.epistemic_source)}`
)
check(
  '★ D01-d 库：attribution_origin=RECORDED（受信写入，不是回填）',
  d01Row.attribution_origin === 'RECORDED',
  String(d01Row.attribution_origin)
)
check(
  '★ D01-e 回读：actorType=user 且 attribution.actor=Known(SERVICE/agent)',
  d01Readback?.actorType === 'user' &&
    d01Actor.state === 'KNOWN' &&
    d01Actor.kind === 'SERVICE' &&
    d01Actor.id === 'agent',
  `actorType=${String(d01Readback?.actorType)} actor=${tripleKey(d01Actor)}`
)
check(
  '★ D01-f 回读：attribution.contentOriginator=Known(SERVICE/agent)',
  d01Originator.state === 'KNOWN' && d01Originator.kind === 'SERVICE' && d01Originator.id === 'agent',
  tripleKey(d01Originator)
)
check(
  '★ D01-g 回读：attribution.recordedBy=Known(SYSTEM/kernel)（canonical ledger writer）',
  d01RecordedBy.state === 'KNOWN' && d01RecordedBy.kind === 'SYSTEM' && d01RecordedBy.id === 'kernel',
  tripleKey(d01RecordedBy)
)
check(
  '★ D01-h 回读：source_kind=user_statement · Axis B 成对 UNCONFIRMED · origin=RECORDED',
  d01Readback?.sourceKind === 'user_statement' &&
    d01Readback?.sourceAuthority === 'UNCONFIRMED_ORIGIN' &&
    d01Readback?.epistemicSource === 'UNCONFIRMED_ORIGIN' &&
    d01Readback?.attribution?.attributionOrigin === 'RECORDED',
  `${String(d01Readback?.sourceKind)} · ${String(d01Readback?.sourceAuthority)}/${String(d01Readback?.epistemicSource)} · ${String(d01Readback?.attribution?.attributionOrigin)}`
)
check(
  '★ D01-i **任何 USER 替换 = FAIL**：库与回读的 actor / contentOriginator 两处都不是 USER',
  ![d01Row.actor_kind, d01Row.content_originator_kind, d01Actor.kind, d01Originator.kind].some(
    (kind) => kind === 'USER'
  ),
  `dbActor=${String(d01Row.actor_kind)} dbOriginator=${String(d01Row.content_originator_kind)} ` +
    `readActor=${String(d01Actor.kind)} readOriginator=${String(d01Originator.kind)}`
)
measure('D01 硬断言字段组数', 9)

// ===========================================================================
section('AT-W4-7 三段式：正控 / 负控（caller 注入 + 篡改）/ 恢复')
// ===========================================================================

let allocationConsumingRejections = 0

// --- 正控：合法受信写入 + 立即回读 -----------------------------------------
const positiveContext = buildContext({
  family: 'user_message',
  actorType: 'user',
  actorId: 'u-1',
  actorPrincipal: USER,
  originatorPrincipal: USER,
  attestKind: 'authenticated_human_input',
})
const positiveSeq = nextSequence(NEG)
const positiveAttempt = await attemptAppend({
  conversationId: NEG,
  conversationSequence: positiveSeq,
  family: 'user_message',
  actorType: 'user',
  actorId: 'u-1',
  content: '正控：合法受信写入',
  trustedAttribution: positiveContext,
})
const positiveReadback = await findByConversationSequence(db, characterId, NEG, positiveSeq)
const positiveQuiet =
  positiveAttempt.ok &&
  positiveReadback?.attribution?.attributionOrigin === 'RECORDED' &&
  tripleKey(tripleOfValue(positiveReadback.attribution.slots.actor)) ===
    tripleKey(tripleOfValue(attributionSlotsOfContext(positiveContext).actor)) &&
  positiveReadback.sourceAuthority === positiveContext.axisB.sourceAuthority
check('正控：合法受信写入 + 立即回读 ⇒ 检测器**安静**', positiveQuiet, 'AA')

/*
 * --- 负控①：**caller attribution injection**（手写同形上下文）----------------
 *
 * 伪造的形状正是 D01 的伪造本身：`actor=SERVICE/agent`（说明是服务提交的），
 * 却自称 `contentOriginator=Known(USER/u-1)` + `sourceAuthority=USER_EXPLICIT`
 * + `branch=confirmed`。它满足写入路径的**其它每一条**判据
 * （族对得上、呈现角色对得上、subject 对得上、Axis B 本身是合法 confirmed 分支）。
 */
const forgedContext = {
  attributionOrigin: 'RECORDED',
  family: 'user_message',
  presenterActorType: 'user',
  subject: { kind: 'CHARACTER', id: 'char_sumuwei' },
  actor: { state: 'KNOWN', value: { kind: 'SERVICE', id: 'agent' } },
  contentOriginator: { state: 'KNOWN', value: { kind: 'USER', id: 'u-1' } },
  recordedBy: { state: 'KNOWN', value: { kind: 'USER', id: 'u-1' } },
  axisB: {
    sourceKind: 'user_statement',
    sourceAuthority: 'USER_EXPLICIT',
    epistemicSource: 'user_report',
    branch: 'confirmed',
    attestedBy: 'authenticated_human_input',
  },
  evidence: { actorAdapterId: 'forged', originatorAdapterId: 'forged', epistemicAdapterId: 'forged' },
} as unknown as TrustedAttributionContext

const forgeryShapePassesOtherChecks =
  forgedContext.family === 'user_message' &&
  forgedContext.presenterActorType === 'user' &&
  forgedContext.subject.id === 'char_sumuwei' &&
  forgedContext.axisB.branch === 'confirmed' &&
  forgedContext.axisB.sourceAuthority === 'USER_EXPLICIT'
/** R-21 的判据（`classifyRecordedAxisB`）**也**会把它当成合法的 confirmed 分支 */
const forgedAxisBIsValidRecordedBranch = classifyRecordedAxisB({
  sourceKind: forgedContext.axisB.sourceKind,
  sourceAuthority: forgedContext.axisB.sourceAuthority,
  epistemicSource: forgedContext.axisB.epistemicSource,
})
measure('负控① 伪造上下文满足的其它写入期判据数', 6)
check(
  '负控①-a 伪造上下文满足**其它每一条**写入期判据（含 R-21 判据）⇒ 只有受信登记能挡住它',
  forgeryShapePassesOtherChecks &&
    forgedAxisBIsValidRecordedBranch.ok &&
    forgedAxisBIsValidRecordedBranch.branch === 'confirmed' &&
    !isTrustedAttributionContext(forgedContext),
  `r21=${forgedAxisBIsValidRecordedBranch.ok ? forgedAxisBIsValidRecordedBranch.branch : 'reject'}`
)
const injectionAttempt = await attemptAppend({
  conversationId: NEG,
  conversationSequence: NEG_CANDIDATE,
  family: 'user_message',
  actorType: 'user',
  actorId: 'agent',
  content: '负控①：caller attribution injection',
  trustedAttributionRaw: forgedContext,
})
if (!injectionAttempt.ok) allocationConsumingRejections += 1
const injectionResidue = await readRow(NEG, NEG_CANDIDATE)
check(
  '负控①-b caller 注入 ⇒ 写入路径**必响**（untrusted_attribution_context）',
  injectionAttempt.ok === false && injectionAttempt.code === 'untrusted_attribution_context',
  `code=${String(injectionAttempt.code)}`
)
check(
  '负控①-c caller 注入**没有**在库里留下任何行（权威存储未被污染）',
  injectionResidue.id === undefined,
  injectionResidue.id === undefined ? '0 行' : String(injectionResidue.id)
)
/*
 * 量具自检（AGENTS.md §6.8）：先证明"扫描范围非零"，再报"违规数 = 0"——
 * 否则"一行都没扫到"与"全部干净"在输出上长得一样。
 */
const forgeryScan = rowsOf(
  await db.execute(
    sql`select count(*)::int as scanned,
               count(*) filter (
                 where actor_kind = 'SERVICE' and source_authority = 'USER_EXPLICIT'
               )::int as forged
        from conversation_events where attribution_origin = 'RECORDED'`
  )
) as { scanned: number; forged: number }[]
const forgedRowsScanned = Number(forgeryScan[0]?.scanned ?? 0)
const forgedRowsInDb = Number(forgeryScan[0]?.forged ?? -1)
measure('负控①-d 扫描的 RECORDED 行数（扫描范围自检）', forgedRowsScanned)
check(
  '负控①-d 全库扫描：**没有任何**"actor=SERVICE 却 source_authority=USER_EXPLICIT"的行',
  forgedRowsInDb === 0,
  `${forgedRowsInDb} 行 / 扫描 ${forgedRowsScanned} 行`
)

// --- 负控②：不可信载荷自带权威承载字段（ADR-042 §3.3 / G-AT-4） -------------
const untrustedPayloads: { label: string; probe: () => void }[] = [
  {
    label: 'contentOriginator',
    probe: () => assertNoCallerSuppliedAttribution({ content: '你好', contentOriginator: 'USER/u-1' }),
  },
  { label: 'actor', probe: () => assertNoCallerSuppliedAttribution({ actor: 'USER/u-1' }) },
  { label: 'recordedBy', probe: () => assertNoCallerSuppliedAttribution({ recordedBy: 'USER/u-1' }) },
  {
    label: 'sourceAuthority',
    probe: () => assertNoCallerSuppliedAttribution({ sourceAuthority: 'USER_EXPLICIT' }),
  },
  {
    label: 'epistemicSource',
    probe: () => assertNoCallerSuppliedAttribution({ epistemicSource: 'user_report' }),
  },
  {
    label: 'attributionOrigin',
    probe: () => assertNoCallerSuppliedAttribution({ attributionOrigin: 'RECORDED' }),
  },
  { label: 'ingress', probe: () => assertNoCallerSuppliedAttribution({ ingress: 'human_console' }) },
  {
    label: 'ingressRef',
    probe: () => assertNoCallerSuppliedAttribution({ ingressRef: 'u-1' }),
  },
  {
    label: 'trustedAttribution',
    probe: () => assertNoCallerSuppliedAttribution({ trustedAttribution: {} }),
  },
]
measure('负控② 不可信载荷字段数', untrustedPayloads.length)
let payloadRejections = 0
for (const payload of untrustedPayloads) {
  let rejected = false
  try {
    payload.probe()
  } catch {
    rejected = true
  }
  if (rejected) payloadRejections += 1
  check(`负控② 不可信载荷夹带 ${payload.label} ⇒ 必被拒`, rejected, 'AA')
}
check(
  '负控②-b 外部 DTO 的 G-AT-4 三字段（contentOriginator / authority / executor）⇒ 必被拒',
  (() => {
    let all = true
    for (const field of ['contentOriginator', 'authority', 'executor']) {
      try {
        assertNoUntrustedAttributionFields({ content: '你好', [field]: 'x' })
        all = false
      } catch {
        /* 期望被拒 */
      }
    }
    return all
  })(),
  'AA'
)

// --- 负控③：**trusted attribution mutation**（构造后篡改） -------------------
const mutationTarget = buildContext({
  family: 'user_message',
  actorType: 'user',
  actorId: 'u-1',
  actorPrincipal: USER,
  originatorPrincipal: USER,
  attestKind: 'authenticated_human_input',
})
const beforeMutation = tripleKey(tripleOfValue(attributionSlotsOfContext(mutationTarget).contentOriginator))
let mutationThrew = false
try {
  ;(mutationTarget as unknown as { contentOriginator: AttributionValue<unknown> }).contentOriginator = {
    state: 'KNOWN',
    value: { kind: 'SERVICE', id: 'agent' },
  }
} catch {
  mutationThrew = true
}
const afterMutation = tripleKey(tripleOfValue(attributionSlotsOfContext(mutationTarget).contentOriginator))
measure('负控③ 篡改探测次数', 1)
check(
  '负控③ 构造后篡改受信 contentOriginator ⇒ 检测器**必响**（抛 / 值不变，两条路都不成立）',
  afterMutation === beforeMutation,
  `threw=${String(mutationThrew)} before=${beforeMutation} after=${afterMutation}`
)

// --- 负控④：受信证据被结构克隆 / JSON 往返 / 手写同形 ⇒ 不算证据 ------------
const realEvidence = attestActor({ adapterId: 'gateway', principal: USER })
const evidenceClones: { label: string; value: unknown }[] = [
  { label: '结构克隆（展开运算符）', value: { ...realEvidence } },
  { label: 'JSON 往返', value: JSON.parse(JSON.stringify(realEvidence)) as unknown },
  { label: '手写同形对象', value: { adapterId: 'gateway', principal: USER } },
]
measure('负控④ mutation 形态数', evidenceClones.length)
let mutationRejected = 0
for (const clone of evidenceClones) {
  let rejected = false
  try {
    buildTrustedAttributionContext({
      family: 'user_message',
      characterId: 'char_sumuwei',
      actorEvidence: clone.value as never,
      contentOriginatorEvidence: attestOriginator({ adapterId: 'ingress', principal: USER }),
    })
  } catch {
    rejected = true
  }
  if (rejected) mutationRejected += 1
  check(`负控④ mutation：${clone.label} ⇒ 构建**必响**（不算证据）`, rejected, 'AA')
}

// --- 负控⑤：受信上下文的事件族 ≠ 事件 type ⇒ 必响（族不符） -----------------
const familyMismatchAttempt = await attemptAppend({
  conversationId: NEG,
  conversationSequence: NEG_CANDIDATE,
  family: 'assistant_message',
  actorType: 'character',
  actorId: 'char_sumuwei',
  content: '负控⑤：族不符',
  trustedAttribution: buildContext({
    family: 'user_message',
    actorType: 'user',
    actorId: 'u-1',
    actorPrincipal: USER,
    originatorPrincipal: USER,
    attestKind: 'authenticated_human_input',
  }),
})
if (!familyMismatchAttempt.ok) allocationConsumingRejections += 1
check(
  '负控⑤ 受信上下文的事件族 ≠ 事件 type ⇒ **必响**（族不符）',
  familyMismatchAttempt.ok === false &&
    familyMismatchAttempt.code === 'trusted_attribution_family_mismatch',
  `code=${String(familyMismatchAttempt.code)}`
)

// --- 恢复：合法写入重新安静（**复用负控用过的会话内序号**） -----------------
const restoreContext = buildContext({
  family: 'user_message',
  actorType: 'user',
  actorId: 'u-1',
  actorPrincipal: USER,
  originatorPrincipal: USER,
  attestKind: 'authenticated_human_input',
})
const restoreAttempt = await attemptAppend({
  conversationId: NEG,
  conversationSequence: NEG_CANDIDATE,
  family: 'user_message',
  actorType: 'user',
  actorId: 'u-1',
  content: '恢复：放回合法受信路径',
  trustedAttribution: restoreContext,
})
const restoreReadback = await findByConversationSequence(db, characterId, NEG, NEG_CANDIDATE)
const restoreSlotsMatch = ATTRIBUTION_VALUE_SLOTS.every(
  (slot) =>
    tripleKey(tripleOfValue(restoreReadback?.attribution?.slots[slot])) ===
    tripleKey(tripleOfValue(attributionSlotsOfContext(restoreContext)[slot]))
)
const restoreOk =
  restoreAttempt.ok &&
  restoreReadback?.attribution?.attributionOrigin === 'RECORDED' &&
  restoreSlotsMatch &&
  restoreReadback.sourceAuthority === restoreContext.axisB.sourceAuthority
check(
  '恢复：放回合法受信路径 ⇒ 重新安静（且**复用**负控未消耗的那个会话内序号）',
  restoreOk,
  `sequence=${NEG_CANDIDATE} origin=${String(restoreReadback?.attribution?.attributionOrigin)}`
)
measure('§3 负控探测数', 1 + untrustedPayloads.length + 1 + evidenceClones.length + 1)
measure('§3 真实受信证据 token 数', 1)

const recordedRowCount = rowsOf(
  await db.execute(sql`select count(*)::int as n from conversation_events where attribution_origin = 'RECORDED'`)
) as { n: number }[]
measure('落库的 RECORDED 行数', Number(recordedRowCount[0]?.n ?? 0))

// ===========================================================================
section('legacy 兼容：MIGRATED_LEGACY / 无 origin **不得覆盖** RECORDED')
// ===========================================================================

// --- 正控 a：走 store 的 legacy 写入（不传 trustedAttribution） --------------
const legacyStoreSeq = nextSequence(LEGACY)
const legacyStoreAttempt = await attemptAppend({
  conversationId: LEGACY,
  conversationSequence: legacyStoreSeq,
  family: 'user_message',
  actorType: 'user',
  actorId: 'u-1',
  content: 'legacy：不带受信归因的写入',
})
const legacyStoreReadback = await findByConversationSequence(db, characterId, LEGACY, legacyStoreSeq)
const legacyStoreDerived = deriveSourceForLegacyRow('user')
check(
  '正控① 不带受信归因的写入仍可读（历史行为保留：没有信封、Axis B 由 actor_type 推导）',
  legacyStoreAttempt.ok &&
    legacyStoreReadback?.attribution === undefined &&
    legacyStoreReadback?.sourceKind === legacyStoreDerived.sourceKind &&
    legacyStoreReadback?.sourceAuthority === legacyStoreDerived.sourceAuthority,
  `attribution=${String(legacyStoreReadback?.attribution)} authority=${String(legacyStoreReadback?.sourceAuthority)}`
)

// --- 正控 b：迁移 0003 **之前**的行（Axis B 三列全 NULL）仍然可读 ------------
await db.execute(
  sql`insert into conversation_events
        (id, character_id, conversation_id, sequence, conversation_sequence, type, actor_type,
         actor_id, content, schema_version, created_at)
      values ('wp4-pre0003', ${String(LEGACY_CHARACTER)}, ${String(LEGACY_RAW)}, 1, 1,
              'user_message', 'user', 'u-1', 'pre-0003 行（三列全 NULL）', 1, ${Date.now()})`
)
const preLegacyReadback = await findByConversationSequence(db, LEGACY_CHARACTER, LEGACY_RAW, 1)
check(
  '正控② 迁移前旧行（Axis B 全 NULL / 无 origin）**不会**因为"没有 RECORDED 归因"而读失败',
  preLegacyReadback !== undefined &&
    preLegacyReadback.attribution === undefined &&
    preLegacyReadback.sourceAuthority === legacyStoreDerived.sourceAuthority &&
    preLegacyReadback.epistemicSource === legacyStoreDerived.epistemicSource,
  `authority=${String(preLegacyReadback?.sourceAuthority)} epistemic=${String(preLegacyReadback?.epistemicSource)}`
)

// --- 正控 c：MIGRATED_LEGACY 行走兼容路径（不制造权威信封） -----------------
await db.execute(
  sql`insert into conversation_events
        (id, character_id, conversation_id, sequence, conversation_sequence, type, actor_type,
         actor_id, content, schema_version, created_at,
         attribution_origin, source_kind, source_authority, epistemic_source,
         actor_kind, actor_ref_id, recorded_by_kind, recorded_by_id,
         content_originator_kind, content_originator_id, content_originator_unknown_reason)
      values ('wp4-migrated', ${String(LEGACY_CHARACTER)}, ${String(LEGACY_RAW)}, 2, 2,
              'user_message', 'user', 'u-1', 'MIGRATED_LEGACY 行', 1, ${Date.now()},
              'MIGRATED_LEGACY', 'user_statement', 'UNCONFIRMED_ORIGIN', 'UNCONFIRMED_ORIGIN',
              'SERVICE', 'agent', 'SYSTEM', 'kernel',
              null, null, 'LEGACY_UNRECORDED')`
)
const migratedReadback = await findByConversationSequence(db, LEGACY_CHARACTER, LEGACY_RAW, 2)
const migratedRow = await readRow(LEGACY_RAW, 2, LEGACY_CHARACTER)
check(
  '正控③ MIGRATED_LEGACY 行：兼容路径读**存储的** Axis B、**不**制造权威信封（槽位不被当成权威归因暴露）',
  migratedReadback !== undefined &&
    migratedReadback.attribution === undefined &&
    migratedReadback.sourceAuthority === migratedRow.source_authority &&
    migratedReadback.epistemicSource === migratedRow.epistemic_source,
  `attribution=${String(migratedReadback?.attribution)} authority=${String(migratedReadback?.sourceAuthority)}`
)

// --- 负控：RECORDED 行（D01）**不得**被 actor_type 推导覆盖 ----------------
const d01Derived = deriveSourceForLegacyRow('user')
check(
  '★ 负控 legacy 路径不得覆盖 RECORDED：D01 行回读仍是 UNCONFIRMED 成对，而 actor_type 推导值会是其它',
  d01Readback?.sourceAuthority === 'UNCONFIRMED_ORIGIN' &&
    d01Readback.epistemicSource === 'UNCONFIRMED_ORIGIN' &&
    d01Readback.sourceAuthority !== d01Derived.sourceAuthority &&
    d01Derived.sourceAuthority === 'USER_EXPLICIT',
  `读=${String(d01Readback?.sourceAuthority)}/${String(d01Readback?.epistemicSource)} ` +
    `推导=${d01Derived.sourceAuthority}/${d01Derived.epistemicSource}`
)
measure(
  '§4 legacy 正控 + 负控数',
  4
)

// ===========================================================================
section('§5 序号审计：期望失败的负控**不得消耗**恢复用例的会话内序号')
// ===========================================================================

const mainChain = (
  rowsOf(
    await db.execute(
      sql`select conversation_sequence from conversation_events
          where character_id = ${String(characterId)} and conversation_id = ${String(MAIN)}
          order by conversation_sequence asc`
    )
  ) as { conversation_sequence: number }[]
).map((row) => Number(row.conversation_sequence))
const mainChainContiguous =
  mainChain.length === scenarios.length && mainChain.every((value, index) => value === index + 1)
measure('主链会话内序号行数', mainChain.length)
check(
  '主链 conv_wp4 的会话内序号 = 1..N 连续（**没有**被负控啃掉一个号）',
  mainChainContiguous,
  mainChain.join(',')
)

const negChain = (
  rowsOf(
    await db.execute(
      sql`select conversation_sequence from conversation_events
          where character_id = ${String(characterId)} and conversation_id = ${String(NEG)}
          order by conversation_sequence asc`
    )
  ) as { conversation_sequence: number }[]
).map((row) => Number(row.conversation_sequence))
check(
  '负控会话 conv_wp4_neg：只有正控(1) 与恢复(2) 两行，被拒的尝试**零残留**',
  negChain.length === 2 && negChain[0] === 1 && negChain[1] === NEG_CANDIDATE,
  negChain.join(',')
)

const charSequences = (
  rowsOf(
    await db.execute(
      sql`select sequence from conversation_events where character_id = ${String(characterId)}
          order by sequence asc`
    )
  ) as { sequence: number }[]
).map((row) => Number(row.sequence))
const charSequenceMonotonic = charSequences.every(
  (value, index) => index === 0 || value > charSequences[index - 1]!
)
const charSequenceUnique = new Set(charSequences).size === charSequences.length
measure('角色级序号行数', charSequences.length)
check(
  '角色级序号：严格单调且唯一（被拒的写入**没有**留下重复 / 倒退的号）',
  charSequenceMonotonic && charSequenceUnique,
  `${charSequences.length} 行，${charSequences[0]}..${charSequences[charSequences.length - 1]}`
)

const counterRows = rowsOf(
  await db.execute(
    sql`select next_sequence from character_sequence_counters where character_id = ${String(characterId)}`
  )
) as { next_sequence: number }[]
const counter = Number(counterRows[0]?.next_sequence ?? -1)
const consumedUnused = counter - charSequences.length
check(
  '★ 角色级"分配了但没落行"的号数 == 走到分配器后被拒的写入数（原因见 evidence 的 productionObservation）',
  consumedUnused === allocationConsumingRejections,
  `消耗未落行=${consumedUnused} 分配后被拒=${allocationConsumingRejections} 计数器=${counter} 行数=${charSequences.length}`
)
check(
  '★ 旧的会话内序号空洞**只存在于 harness**：主链连续 + 负控零残留 + 恢复复用了负控的号码',
  mainChainContiguous && negChain.length === 2 && restoreOk,
  `conv_wp4=[${mainChain.join(',')}] conv_wp4_neg=[${negChain.join(',')}]`
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
const verdict = failed === 0 ? 'PASS' : 'FAIL'
const evidence = {
  testId: 'M5.1.1 / WP4 step 3/3 write-path verification',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp4:verify',
  verdict,
  passed,
  failed,
  failures,
  readbackAttribution: {
    authorityPath: "attribution_origin='RECORDED' ⇒ 六个槽位按 18 个物理列逐字重建 + Axis B 用存储值",
    legacyPath: "MIGRATED_LEGACY / 无 origin ⇒ 既有 legacy 行为（推导兜底），**不**制造信封，**不**覆盖 RECORDED",
    neverRewritesStoredValue: true,
  },
  scenarios: scenarioReadings,
  d01Regression: {
    db: {
      actor_type: d01Row.actor_type,
      actor_kind: d01Row.actor_kind,
      actor_ref_id: d01Row.actor_ref_id,
      content_originator_kind: d01Row.content_originator_kind,
      content_originator_id: d01Row.content_originator_id,
      source_kind: d01Row.source_kind,
      source_authority: d01Row.source_authority,
      epistemic_source: d01Row.epistemic_source,
      attribution_origin: d01Row.attribution_origin,
    },
    readback: {
      actorType: d01Readback?.actorType,
      actor: tripleKey(d01Actor),
      contentOriginator: tripleKey(d01Originator),
      recordedBy: tripleKey(d01RecordedBy),
      sourceKind: d01Readback?.sourceKind,
      sourceAuthority: d01Readback?.sourceAuthority,
      epistemicSource: d01Readback?.epistemicSource,
      attributionOrigin: d01Readback?.attribution?.attributionOrigin,
    },
  },
  attestation: {
    positiveQuiet,
    callerInjection: {
      rejectedCode: injectionAttempt.code,
      residueRows: injectionResidue.id === undefined ? 0 : 1,
      forgeryFingerprintRows: forgedRowsInDb,
      forgedShapePassesOtherWriteChecks: forgeryShapePassesOtherChecks,
      forgedAxisBAcceptedAsConfirmed: forgedAxisBIsValidRecordedBranch.ok,
      locatedGap:
        'WP4 step 3/3 实测到的边界缺口：证据 token 的守卫只挡构造函数的**入参**；' +
        '上下文本身是普通对象 ⇒ 调用方**手写一份同形对象**就能把 ' +
        'contentOriginator=Known(USER) + USER_EXPLICIT 直接写进账本。' +
        '本步以**受信上下文运行期登记**（isTrustedAttributionContext）关掉它。',
    },
    untrustedPayloadFieldsTested: untrustedPayloads.map((payload) => payload.label),
    payloadRejections,
    mutation: {
      trustedContextMutationDetected: afterMutation === beforeMutation,
      mutationThrew,
      evidenceClonesRejected: mutationRejected,
      evidenceCloneCount: evidenceClones.length,
    },
    familyMismatchCode: familyMismatchAttempt.code,
    restoreOk,
    restoreSequence: NEG_CANDIDATE,
  },
  legacyRegression: {
    storeLegacyRow: {
      readable: legacyStoreAttempt.ok,
      hasEnvelope: legacyStoreReadback?.attribution !== undefined,
      sourceAuthority: legacyStoreReadback?.sourceAuthority,
      derivedSourceAuthority: legacyStoreDerived.sourceAuthority,
    },
    pre0003RowReadable: preLegacyReadback !== undefined,
    migratedLegacyRow: {
      hasEnvelope: migratedReadback?.attribution !== undefined,
      readSourceAuthority: migratedReadback?.sourceAuthority,
      storedSourceAuthority: migratedRow.source_authority,
    },
    recordedNotOverwritten: {
      readSourceAuthority: d01Readback?.sourceAuthority,
      derivedFromActorType: d01Derived.sourceAuthority,
    },
  },
  sequenceAudit: {
    mainChainConversationSequence: mainChain,
    mainChainContiguous,
    negativeConversationSequence: negChain,
    negativeResidueRows: negChain.length - 2,
    candidateSequenceReusedByRestore: NEG_CANDIDATE,
    charSequenceAllocated: counter,
    charSequenceRows: charSequences.length,
    charSequenceConsumedUnused: consumedUnused,
    allocationConsumingRejections,
    conclusion:
      '旧的会话内序号空洞**只存在于 harness**：那条 `conversation_sequence_gap` 是执行脚本自己' +
      '把序号计数器 +1 了、却在被拒后没有落行造成的（9 > 7+1）。生产侧没有持久化任何非法序号：' +
      '被拒的写入在 conversation_events 里零残留，主链 1..N 连续，角色级序号严格单调且唯一。',
    productionObservation:
      '如实登记（**不是**缺陷）：appendConversationEvent 在 createConversationEvent 校验**之前**' +
      '就调用 nextCharacterSequence，因此一次"走到分配器后被拒"的写入会消耗一个**合法但未使用**的' +
      '角色级序号（本门实测 = ' +
      String(consumedUnused) +
      ' 个）。这不是"持久化了非法序号"：分配器只承诺单调 + 唯一（sequence.ts 的契约），' +
      '号码本身合法、无重复、无倒退，且事件行不存在；会话内序号由调用方给出、被拒时不落行。' +
      '该顺序（先分配后校验）是 M2.5/M3 既有形状，本步**没有**改动它。',
  },
  sandbox: { dir: sandbox.dir, isProductionDir: isProductionDir(sandbox.dir), schemaVersion },
  measurements,
  measurementInvalid: measurementInvalid.length,
  evidenceNames: ['wp4.1-wp4-attestation.json', 'wp4.1-wp4-write-path.json'],
  scope: {
    behavioralFreeze: 'Fact Firewall / MemoryAuthority / extractor / Recall **未改**（AT-W4-9）',
    liveDb: false,
    migration0007Edited: false,
    startedWp5: false,
    k22: 'character_action_events 的内容**本门不写**；它的 Axis B 物理形状由 pnpm m5.1.1:wp4.1:verify 负责（WP4.1）',
  },
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
const payload = `${JSON.stringify(evidence, null, 2)}\n`
/*
 * ⚠️ 证据文件名（WP4.1 起）：本脚本以前写 `wp4-write-path.json` / `wp4-attestation.json`
 * （WP4 的历史证据，已随 WP4 = PASS 冻结）。WP4.1 起写 **`wp4.1-wp4-*.json`**，
 * 历史那两份**不再被覆盖**（与 migration / prod-copy 两个继承门同一处理）。
 */
writeFileSync(join(EVIDENCE_DIR, 'wp4.1-wp4-write-path.json'), payload, 'utf8')
writeFileSync(join(EVIDENCE_DIR, 'wp4.1-wp4-attestation.json'), payload, 'utf8')

console.log(`\n${'='.repeat(74)}`)
console.log(`WP4 写路径门：${passed} 通过 / ${failed} 失败｜WP4 step 2/3+3/3 = ${verdict}`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp4.1-wp4-attestation.json ・ wp4.1-wp4-write-path.json')
try {
  await runtime.stop()
} catch {
  /* ignore */
}
process.exit(failed === 0 ? 0 : 1)
