/**
 * M5.1.1 WP5 —— **Action & Execution Attribution**（`pnpm m5.1.1:wp5:verify`）
 *
 * ============================================================================
 *  它证明四件事
 * ============================================================================
 *  ① **写路径**：`character_action_events` 的新行真的带上权威归因列
 *     （六个槽位 + origin），而且 Axis B 三列**恒为 NULL**（K-22）。
 *  ② **读回路**：`attribution_origin='RECORDED'` 的行按物理列**逐字**解码；
 *     历史行**不**凭空补信封。写入时 == DB == 立即回读，逐字段。
 *  ③ **边界**：五个槽位各有**独立的**受信来源；payload / requestedBy / transport /
 *     metadata / 手写同形对象 / 结构克隆**都**不能自己变成权威归因（WP5-2）。
 *  ④ **执行真相不变**：归因的存在**不**升级 executed / accepted / status（WP5-9）。
 *
 * ⚠️ 它跑的是**真实 store**（`createActionLedgerStore`）与**真实 gateway**
 *    （`createActionGateway` + 真实 echo 适配器），不是纯函数自证。
 *
 * 跑法：pnpm m5.1.1:wp5:verify
 */

import 'dotenv/config'

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { PRODUCTION_DB_DIR, isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import {
  ACTION_ATTRIBUTION_FAMILY_BY_EVENT_TYPE,
  ACTION_BACKFILL_CLASSIFICATION,
  ATTRIBUTION_SLOT_COLUMNS,
  ATTRIBUTION_VALUE_SLOTS,
  NECESSITY_MATRIX,
  actionAttributionEnvelopeOf,
  actionAttributionFamilyOf,
  assertActionAttributionMatchesEvent,
  assertActionAxisBNotApplicable,
  assertAttributionNecessity,
  attestActionActorFromDecisionPoint,
  attestActionAuthorityFromPolicy,
  attestActionExecutorFromAdapter,
  attestActionInitiatorFromCausalOrigin,
  buildTrustedActionAttribution,
  correlationSourceFromConversationEvent,
  isTrustedActionAttributionContext,
  validateActionAxisB,
  validateAttributionNecessity,
  type ActionAxisBCells,
  type AttributionSlotCells,
  type AuthorityRef,
  type TrustedActionAttributionContext,
  type TrustedActionPrincipalEvidence,
} from '../src/kernel/contracts/attribution.ts'
import {
  attributionAbsent,
  attributionKnown,
  type AttributionValue,
  type PrincipalRef,
} from '../src/kernel/contracts/actor.ts'
import {
  asActionId,
  asCharacterId,
  asTraceId,
} from '../src/kernel/contracts/ids.ts'
import { ACTION_EVENT_TYPES, type ActionEventType } from '../src/kernel/action/execution-ledger.ts'
import type { ActionTarget } from '../src/kernel/action/action-request.ts'
import { createActionRequest } from '../src/kernel/action/action-request.ts'
import { actionFailure } from '../src/kernel/action/errors.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  SYSTEM_ECHO,
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
} from '../src/kernel/action/capability-registry.ts'
import { createActionGateway } from '../src/kernel/action/gateway.ts'
import { foldExecutionRecord } from '../src/kernel/action/execution-record.ts'
import type { PolicyDecision } from '../src/kernel/action/policy.ts'
import { createEchoAdapter } from '../src/infrastructure/action/adapters/echo.ts'
import { createActionLedgerStore, foldRecord } from '../src/infrastructure/action/action-ledger-store.ts'
import { currentSchemaVersion, getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'

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
const GATEWAY_PRINCIPAL: PrincipalRef = { kind: 'SERVICE', id: 'action-gateway' } as PrincipalRef
const EXECUTOR_PRINCIPAL: PrincipalRef = { kind: 'SERVICE', id: 'adapter:system.echo' } as PrincipalRef
const LEDGER: PrincipalRef = { kind: 'SYSTEM', id: 'kernel' } as PrincipalRef
const CAPABILITY: AuthorityRef = { kind: 'CAPABILITY', ref: SYSTEM_ECHO } as AuthorityRef

console.log('='.repeat(74))
console.log('M5.1.1 WP5 —— Action & Execution Attribution（真实 store + 真实 gateway）')
console.log('='.repeat(74))

// ---------------------------------------------------------------------------
// 三态比较（写入时 / DB / 回读）
// ---------------------------------------------------------------------------

interface Triple {
  state: string
  kind: string | null
  id: string | null
  reason: string | null
}
const ABSENT_TRIPLE: Triple = { state: 'ABSENT', kind: null, id: null, reason: null }
const NO_ENVELOPE: Triple = { state: 'NO_ENVELOPE', kind: null, id: null, reason: null }

function tripleOfValue(value: AttributionValue<unknown> | undefined): Triple {
  if (value === undefined) return NO_ENVELOPE
  if (value.state === 'KNOWN') {
    const ref = value.value as { kind?: string; id?: string; ref?: string }
    return { state: 'KNOWN', kind: ref.kind ?? null, id: ref.id ?? ref.ref ?? null, reason: null }
  }
  if (value.state === 'UNKNOWN') {
    return { state: 'UNKNOWN', kind: null, id: null, reason: value.reason }
  }
  return ABSENT_TRIPLE
}

function tripleOfRow(row: Record<string, unknown>, slot: string): Triple {
  const columns = ATTRIBUTION_SLOT_COLUMNS[slot as keyof typeof ATTRIBUTION_SLOT_COLUMNS]
  const kind = (row[columns.kind] ?? null) as string | null
  const id = (row[columns.id] ?? null) as string | null
  const reason = (row[columns.unknownReason] ?? null) as string | null
  if (kind === null && id === null && reason === null) return ABSENT_TRIPLE
  if (kind === null && id === null && reason !== null) {
    return { state: 'UNKNOWN', kind: null, id: null, reason }
  }
  if (kind !== null && id !== null && reason === null) return { state: 'KNOWN', kind, id, reason: null }
  return { state: 'INVALID_SHAPE', kind, id, reason }
}

const tripleKey = (triple: Triple): string =>
  `${triple.state}|${triple.kind ?? '-'}|${triple.id ?? '-'}|${triple.reason ?? '-'}`

// ===========================================================================
section('§0 沙箱 / schema 边界 / 真实库边界')
// ===========================================================================

const sandbox = isolateDatabase('m5.1.1-wp5')
check('沙箱不是真实库', isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()), sandbox.dir)
check(
  '真实库路径只被记录，从未被本脚本打开',
  PRODUCTION_DB_DIR.endsWith(join('data', 'pglite')) && process.env.PGLITE_DATA_DIR !== PRODUCTION_DB_DIR,
  PRODUCTION_DB_DIR
)

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
  '沙箱库 schema = v9（WP5 本身无 schema 变更；v9 是 WP9-B1 的 state_events 承载）',
  schemaVersion === 9,
  `v${schemaVersion}`
)

const fingerprint = (version: number): string => {
  const migration = MIGRATIONS.find((m) => m.version === version)!
  return createHash('sha256').update(migration.statements.join('\n'), 'utf8').digest('hex')
}
const FROZEN_0007 = '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613'
const FROZEN_0008 = '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29'
check('MIGRATION_0007 逐字未改（WP5 没有 schema 变更）', fingerprint(7) === FROZEN_0007, fingerprint(7).slice(0, 16))
check('MIGRATION_0008 逐字未改（WP5 没有 schema 变更）', fingerprint(8) === FROZEN_0008, fingerprint(8).slice(0, 16))
check(
  '代码里的迁移清单 = 1..9，且 0009 就是 WP9-B1 的 `state_events` 承载' +
    '（原判据"没有 MIGRATION_0009"按 R-45 的新事实改写，未放宽：清单仍被逐版本钉住）',
  MIGRATIONS.map((m) => m.version).join(',') === '1,2,3,4,5,6,7,8,9' &&
    MIGRATIONS.find((m) => m.version === 9)?.name === 'm5.1.1-state-events-attribution',
  MIGRATIONS.map((m) => m.version).join(',')
)

const characterId = asCharacterId('char_sumuwei')
const ledger = createActionLedgerStore(db)

/**
 * K-27（WP5.1）：initiator 只能来自**因果上下文**。
 *
 * 这个 helper 造一份"真正的受信人类输入"的因果来源
 * （RECORDED + actor 与 contentOriginator 都是 Known(USER/u-1)），
 * 供 WP5 的九个阶段与真实 gateway 用例复用 —— 它们要的正是
 * "established by causal evidence" 的 Known(USER)。
 */
function humanInitiatorEvidence(): TrustedActionPrincipalEvidence {
  return attestActionInitiatorFromCausalOrigin({
    adapterId: 'action-turn',
    causalSource: correlationSourceFromConversationEvent({
      adapterId: 'action-turn',
      triggeringEvent: {
        eventId: 'cev:wp5:human-1',
        type: 'user_message',
        attributionOrigin: 'RECORDED',
        actor: attributionKnown(USER),
        contentOriginator: attributionKnown(USER),
      },
    }),
  })
}

async function readActionRow(actionId: string, sequence: number): Promise<Record<string, unknown>> {
  const rows = rowsOf(
    await db.execute(
      sql`select * from character_action_events
          where character_id = ${String(characterId)} and action_id = ${actionId}
            and sequence = ${sequence}`
    )
  ) as Record<string, unknown>[]
  return rows[0] ?? {}
}

// ===========================================================================
section('§1 事件类型 → 必要性族：冻结的桥 + 与 §3.3 分类的机器交叉核对')
// ===========================================================================

const tableKeys = Object.keys(ACTION_ATTRIBUTION_FAMILY_BY_EVENT_TYPE)
measure('桥表覆盖的事件类型数', tableKeys.length)
check(
  '桥表与 `ACTION_EVENT_TYPES` **逐项相等**（多一个/少一个都红）',
  tableKeys.length === ACTION_EVENT_TYPES.length &&
    ACTION_EVENT_TYPES.every((type) => tableKeys.includes(type)),
  `${tableKeys.length} / ${ACTION_EVENT_TYPES.length}`
)

let crossChecked = 0
const crossMismatches: string[] = []
for (const type of ACTION_EVENT_TYPES) {
  const family = actionAttributionFamilyOf(type)
  const row = NECESSITY_MATRIX[family]
  const classification = ACTION_BACKFILL_CLASSIFICATION[type]
  if (classification === undefined) {
    crossMismatches.push(`${type}: 没有 §3.3 分类`)
    continue
  }
  for (const slot of ATTRIBUTION_VALUE_SLOTS) {
    const matrixAbsent = row[slot] === 'ABSENT'
    const classifiedN = classification[slot] === 'N'
    crossChecked += 1
    if (matrixAbsent !== classifiedN) {
      crossMismatches.push(`${type}.${slot}: matrix=${row[slot]} vs §3.3=${classification[slot]}`)
    }
  }
}
measure('与 §3.3 逐格交叉核对的格数', crossChecked)
check(
  '★ 桥表的每一条都与 §3.3 的 D/P/U/N 一致（`N ⟺ ABSENT` 全局成立）⇒ 它不是第二张矩阵',
  crossMismatches.length === 0,
  crossMismatches.slice(0, 3).join(' | ') || `${crossChecked} 格全一致`
)

// ===========================================================================
section('§2 真实 store：九个事件类型的归因写 + DB + 回读（逐字段）')
// ===========================================================================

function buildStageContext(input: {
  type: ActionEventType
  withAuthority: boolean
  withExecutor: boolean
  executorKnown: boolean
}): TrustedActionAttributionContext {
  return buildTrustedActionAttribution({
    eventType: input.type,
    characterId: String(characterId),
    initiatorEvidence: humanInitiatorEvidence(),
    actorEvidence: attestActionActorFromDecisionPoint({
      adapterId: 'action-gateway',
      principal: GATEWAY_PRINCIPAL,
    }),
    ...(input.withAuthority
      ? {
          authorityEvidence: attestActionAuthorityFromPolicy({
            adapterId: 'action-policy',
            authority: CAPABILITY,
          }),
        }
      : {}),
    ...(input.withExecutor
      ? {
          executorEvidence: attestActionExecutorFromAdapter({
            adapterId: 'action-adapter',
            principal: input.executorKnown ? EXECUTOR_PRINCIPAL : null,
            ...(input.executorKnown ? {} : { unresolvedReason: 'RUNTIME_UNRESOLVED' as const }),
          }),
        }
      : {}),
  })
}

const target: ActionTarget = { type: 'unknown', confidence: 'none' }
const allowedDecision: PolicyDecision = {
  allowed: true,
  code: 'allowed',
  message: 'ok',
  checks: [{ name: 'permissions_granted', ok: true, detail: '' }],
}
const deniedDecision: PolicyDecision = {
  allowed: false,
  code: 'missing_permission',
  message: '没有被授予',
  checks: [{ name: 'permissions_granted', ok: false, detail: '缺少权限' }],
}
const failure = actionFailure('execution_failed', '模拟失败')

async function appendStage(input: {
  type: ActionEventType
  attribution: TrustedActionAttributionContext
}): Promise<{ ok: boolean; error?: string; code?: string; sequence?: number }> {
  const actionId = asActionId(`wp5-${input.type}`)
  const request = createActionRequest({
    actionId,
    traceId: asTraceId('trc:wp5'),
    capability: SYSTEM_ECHO,
    operation: 'echo',
    requestedBy: { kind: 'user', id: 'u-1' },
    arguments: { text: 'wp5' },
    sideEffect: 'none',
  })
  try {
    const event =
      input.type === 'ACTION_REQUESTED'
        ? await ledger.appendRequested({ characterId, request, attribution: input.attribution })
        : input.type === 'ACTION_TARGET_RESOLVED'
          ? await ledger.appendTargetResolved({
              characterId,
              request,
              target,
              scopeViolation: false,
              attribution: input.attribution,
            })
          : input.type === 'ACTION_AUTHORIZED'
            ? await ledger.appendAuthorized({
                characterId,
                request,
                target,
                decision: allowedDecision,
                attribution: input.attribution,
              })
            : input.type === 'ACTION_REJECTED'
              ? await ledger.appendRejected({
                  characterId,
                  request,
                  target,
                  decision: deniedDecision,
                  failure,
                  status: 'rejected',
                  attribution: input.attribution,
                })
              : input.type === 'ACTION_STARTED'
                ? await ledger.appendStarted({ characterId, request, target, attribution: input.attribution })
                : input.type === 'ACTION_SUCCEEDED'
                  ? await ledger.appendSucceeded({
                      characterId,
                      request,
                      target,
                      evidence: [],
                      attribution: input.attribution,
                    })
                  : input.type === 'ACTION_FAILED'
                    ? await ledger.appendFailed({
                        characterId,
                        request,
                        target,
                        failure,
                        status: 'failed',
                        attribution: input.attribution,
                      })
                    : input.type === 'ACTION_PARTIAL'
                      ? await ledger.appendPartial({
                          characterId,
                          request,
                          target,
                          evidence: [],
                          progress: { completed: 1, total: 2 },
                          attribution: input.attribution,
                        })
                      : await ledger.appendCancelled({
                          characterId,
                          request,
                          target,
                          failure,
                          attribution: input.attribution,
                        })
    return { ok: true, sequence: event.sequence }
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message.slice(0, 200),
      code: (error as { code?: string }).code,
    }
  }
}

const stageReadings: Record<string, unknown>[] = []
let slotComparisons = 0
const stageTime = new Map<string, Triple[]>()

for (const type of ACTION_EVENT_TYPES) {
  const family = actionAttributionFamilyOf(type)
  const row = NECESSITY_MATRIX[family]
  // 输入按**冻结矩阵**给：该有的槽位才给证据（不给第二张矩阵）
  const context = buildStageContext({
    type,
    withAuthority: row.authority !== 'ABSENT',
    withExecutor: row.executor !== 'ABSENT',
    executorKnown: type !== 'ACTION_FAILED',
  })
  const written = await appendStage({ type, attribution: context })
  const dbRow = written.sequence === undefined ? {} : await readActionRow(`wp5-${type}`, written.sequence)
  const events = await ledger.getEventsByActionId(characterId, asActionId(`wp5-${type}`))
  const readback = events.find((event) => event.type === type)

  const writeSlots: Record<string, string> = {}
  const dbSlots: Record<string, string> = {}
  const readSlots: Record<string, string> = {}
  const mismatches: string[] = []
  for (const slot of ATTRIBUTION_VALUE_SLOTS) {
    const writeTriple = tripleOfValue(context[slot] as AttributionValue<unknown>)
    const dbTriple = tripleOfRow(dbRow, slot)
    const readTriple = tripleOfValue(
      readback?.attribution?.slots[slot] as AttributionValue<unknown> | undefined
    )
    writeSlots[slot] = tripleKey(writeTriple)
    dbSlots[slot] = tripleKey(dbTriple)
    readSlots[slot] = tripleKey(readTriple)
    slotComparisons += 1
    if (tripleKey(writeTriple) !== tripleKey(dbTriple) || tripleKey(dbTriple) !== tripleKey(readTriple)) {
      mismatches.push(`${slot}: 写=${tripleKey(writeTriple)} 库=${tripleKey(dbTriple)} 读=${tripleKey(readTriple)}`)
    }
  }

  // 矩阵驱动的期望：不该有的槽位必须是 Absent（正控的反面）
  const matrixMismatches: string[] = []
  for (const slot of ATTRIBUTION_VALUE_SLOTS) {
    if (row[slot] === 'ABSENT' && dbSlots[slot] !== tripleKey(ABSENT_TRIPLE)) {
      matrixMismatches.push(`${slot} 该 Absent，实际 ${dbSlots[slot]}`)
    }
    if (row[slot] !== 'ABSENT' && dbSlots[slot] === tripleKey(ABSENT_TRIPLE)) {
      matrixMismatches.push(`${slot} 该表态，实际 Absent`)
    }
  }

  const axisBNull =
    dbRow.source_kind === null && dbRow.source_authority === null && dbRow.epistemic_source === null
  const originOk = dbRow.attribution_origin === 'RECORDED'
  const recordedByOk = dbSlots.recordedBy === tripleKey(tripleOfValue(attributionKnown(LEDGER)))
  const contentOriginatorOk = dbSlots.contentOriginator === tripleKey(ABSENT_TRIPLE)

  stageReadings.push({
    type,
    family,
    matrixRow: { initiator: row.initiator, actor: row.actor, executor: row.executor, authority: row.authority, recordedBy: row.recordedBy, contentOriginator: row.contentOriginator },
    sequence: written.sequence ?? null,
    writeSlots,
    dbSlots,
    readSlots,
    axisBNull,
    origin: dbRow.attribution_origin ?? null,
    mismatches,
    matrixMismatches,
  })
  check(
    `§2 ${type}（family=${family}）：写 = 库 = 回读，逐槽位一致`,
    written.ok && mismatches.length === 0 && matrixMismatches.length === 0,
    `${mismatches.length + matrixMismatches.length} 处不符` +
      `${mismatches.length > 0 ? ` ${mismatches[0]}` : ''}` +
      `${matrixMismatches.length > 0 ? ` ${matrixMismatches[0]}` : ''}` +
      `${written.error ? ` 写入错误=${written.error}` : ''}`
  )
  check(
    `§2 ${type}：Axis B 三列全 NULL · origin=RECORDED · recordedBy=SYSTEM/kernel · contentOriginator=Absent`,
    written.ok && axisBNull && originOk && recordedByOk && contentOriginatorOk,
    `axisB=${String(axisBNull)} origin=${String(dbRow.attribution_origin)}`
  )
  stageTime.set(type, ATTRIBUTION_VALUE_SLOTS.map((slot) => tripleOfRow(dbRow, slot)))
}
measure('§2 槽位三方比较次数', slotComparisons)
measure('§2 覆盖的事件类型数', stageReadings.length)

/** 全部 RECORDED 行的 recordedBy 是否都恰好是 canonical ledger writer */
const dbSlotsAllRecordedByCanonical = stageReadings.every(
  (reading) => (reading.dbSlots as Record<string, string>).recordedBy === 'KNOWN|SYSTEM|kernel|-'
)
check(
  '★ 每一行的 recordedBy 都恰好是 SYSTEM/kernel（canonical ledger writer；调用方给不了）',
  dbSlotsAllRecordedByCanonical,
  dbSlotsAllRecordedByCanonical ? 'AA' : '存在非 canonical recorder'
)
/*
 * 显式把 store 在 INSERT 前调用的那两个判据再走一遍 —— 证明"门测的就是写入路径用的判据"。
 */
const enforcementProbe = buildStageContext({
  type: 'ACTION_REQUESTED',
  withAuthority: false,
  withExecutor: false,
  executorKnown: false,
})
assertAttributionNecessity({
  family: enforcementProbe.family,
  envelope: actionAttributionEnvelopeOf(enforcementProbe),
})
assertActionAxisBNotApplicable({ sourceKind: null, sourceAuthority: null, epistemicSource: null })
check(
  '写入路径使用的判据本身可执行（`assertAttributionNecessity` + `assertActionAxisBNotApplicable` 在合法输入上安静）',
  validateAttributionNecessity({
    family: enforcementProbe.family,
    envelope: actionAttributionEnvelopeOf(enforcementProbe),
  }).length === 0
)

// ===========================================================================
section('§3 阶段不可变（WP5-5）：早期行**不**因为后期事实被改写')
// ===========================================================================

const chainActionId = 'wp5-chain'
const chainRequest = createActionRequest({
  actionId: asActionId(chainActionId),
  traceId: asTraceId('trc:wp5-chain'),
  capability: SYSTEM_ECHO,
  operation: 'echo',
  requestedBy: { kind: 'user', id: 'u-1' },
  arguments: { text: 'chain' },
  sideEffect: 'none',
})
const chainStages: { type: ActionEventType; run: () => Promise<{ sequence: number }> }[] = [
  {
    type: 'ACTION_REQUESTED',
    run: async () => {
      const event = await ledger.appendRequested({
        characterId,
        request: chainRequest,
        attribution: buildStageContext({
          type: 'ACTION_REQUESTED',
          withAuthority: false,
          withExecutor: false,
          executorKnown: false,
        }),
      })
      return { sequence: event.sequence }
    },
  },
  {
    type: 'ACTION_TARGET_RESOLVED',
    run: async () => {
      const event = await ledger.appendTargetResolved({
        characterId,
        request: chainRequest,
        target,
        scopeViolation: false,
        attribution: buildStageContext({
          type: 'ACTION_TARGET_RESOLVED',
          withAuthority: false,
          withExecutor: false,
          executorKnown: false,
        }),
      })
      return { sequence: event.sequence }
    },
  },
  {
    type: 'ACTION_AUTHORIZED',
    run: async () => {
      const event = await ledger.appendAuthorized({
        characterId,
        request: chainRequest,
        target,
        decision: allowedDecision,
        attribution: buildStageContext({
          type: 'ACTION_AUTHORIZED',
          withAuthority: true,
          withExecutor: false,
          executorKnown: false,
        }),
      })
      return { sequence: event.sequence }
    },
  },
  {
    type: 'ACTION_STARTED',
    run: async () => {
      const event = await ledger.appendStarted({
        characterId,
        request: chainRequest,
        target,
        attribution: buildStageContext({
          type: 'ACTION_STARTED',
          withAuthority: true,
          withExecutor: true,
          executorKnown: true,
        }),
      })
      return { sequence: event.sequence }
    },
  },
  {
    type: 'ACTION_SUCCEEDED',
    run: async () => {
      const event = await ledger.appendSucceeded({
        characterId,
        request: chainRequest,
        target,
        evidence: [],
        attribution: buildStageContext({
          type: 'ACTION_SUCCEEDED',
          withAuthority: true,
          withExecutor: true,
          executorKnown: true,
        }),
      })
      return { sequence: event.sequence }
    },
  },
]
const chainSequences: number[] = []
for (const stage of chainStages) chainSequences.push((await stage.run()).sequence)
measure('§3 单条 action 链的阶段数', chainSequences.length)

const requestedRowAfterChain = await readActionRow(chainActionId, chainSequences[0]!)
const authorizedRowAfterChain = await readActionRow(chainActionId, chainSequences[2]!)
check(
  '★ ACTION_REQUESTED 行**没有**被后来的授权/执行事实回溯填充（authority / executor 仍 Absent）',
  (requestedRowAfterChain.authority_kind ?? null) === null &&
    (requestedRowAfterChain.executor_kind ?? null) === null,
  `authority=${String(requestedRowAfterChain.authority_kind)} executor=${String(requestedRowAfterChain.executor_kind)}`
)
check(
  '★ ACTION_AUTHORIZED 行只有 authority（executor 仍 Absent —— 那时还没执行）',
  (authorizedRowAfterChain.authority_kind ?? null) === 'CAPABILITY' &&
    (authorizedRowAfterChain.executor_kind ?? null) === null,
  `authority=${String(authorizedRowAfterChain.authority_kind)} executor=${String(authorizedRowAfterChain.executor_kind)}`
)
const chainEvents = await ledger.getEventsByActionId(characterId, asActionId(chainActionId))
check(
  '★ 同一条 action 的五条事件各自携带**当时**的快照（correlation ≠ inference）',
  chainEvents.length === 5 &&
    chainEvents[0]!.attribution !== undefined &&
    chainEvents[4]!.attribution !== undefined &&
    tripleKey(tripleOfValue(chainEvents[0]!.attribution!.slots.executor as AttributionValue<unknown>)) ===
      tripleKey(ABSENT_TRIPLE) &&
    tripleKey(tripleOfValue(chainEvents[4]!.attribution!.slots.executor as AttributionValue<unknown>)) !==
      tripleKey(ABSENT_TRIPLE),
  `${chainEvents.length} 条`
)

// ===========================================================================
section('§4 真实 gateway 端到端：生产写路径 + 执行真相不变（WP5-9）')
// ===========================================================================

const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
const gateway = createActionGateway({
  registry,
  ledger,
  adapters: [createEchoAdapter()],
  grantedPermissions: DEFAULT_GRANTED_PERMISSIONS,
  maxRiskLevel: 'R1',
  now: () => Date.now(),
  resolveTarget: async () => ({ target, scopeViolation: false }),
  attribution: {
    decisionPointAdapterId: 'action-gateway',
    policyAdapterId: 'action-policy',
    executorAdapterId: 'action-adapter',
  },
})
const initiatorEvidence = humanInitiatorEvidence()

const allowedRequest = createActionRequest({
  actionId: asActionId('wp5-gw-allowed'),
  traceId: asTraceId('trc:wp5-gw'),
  capability: SYSTEM_ECHO,
  operation: 'echo',
  requestedBy: { kind: 'user', id: 'u-1' },
  arguments: { text: 'hello' },
  sideEffect: 'none',
})
const allowedResult = await gateway.execute(characterId, allowedRequest, { initiatorEvidence })
const deniedRequest = createActionRequest({
  actionId: asActionId('wp5-gw-denied'),
  traceId: asTraceId('trc:wp5-gw2'),
  capability: 'not.registered',
  operation: 'write',
  requestedBy: { kind: 'user', id: 'u-1' },
  arguments: { path: 'x.txt' },
  sideEffect: 'write',
})
const deniedResult = await gateway.execute(characterId, deniedRequest, { initiatorEvidence })

const allowedEvents = await ledger.getEventsByActionId(characterId, asActionId('wp5-gw-allowed'))
const deniedEvents = await ledger.getEventsByActionId(characterId, asActionId('wp5-gw-denied'))
measure('§4 真实 gateway 产生的账本事件数', allowedEvents.length + deniedEvents.length)
check(
  '★ 真实 gateway 的成功路径：五条事件全部带 RECORDED 归因（REQUESTED/TARGET_RESOLVED/AUTHORIZED/STARTED/SUCCEEDED）',
  allowedEvents.length === 5 &&
    allowedEvents.every((event) => event.attribution?.attributionOrigin === 'RECORDED'),
  allowedEvents.map((event) => event.type).join(',')
)
check(
  '★ 真实 gateway 的拒绝路径：REQUESTED + REJECTED 两条都带归因，且 REJECTED 的 authority **Absent**',
  deniedEvents.length === 2 &&
    deniedEvents.every((event) => event.attribution?.attributionOrigin === 'RECORDED') &&
    tripleKey(
      tripleOfValue(deniedEvents[1]!.attribution!.slots.authority as AttributionValue<unknown>)
    ) === tripleKey(ABSENT_TRIPLE),
  deniedEvents.map((event) => event.type).join(',')
)
check(
  '★ 执行真相由**事件类型**决定：成功路径 executed=true / 拒绝路径 executed=false（归因没有升级它）',
  allowedResult.executed === true && deniedResult.executed === false,
  `allowed.executed=${String(allowedResult.executed)} denied.executed=${String(deniedResult.executed)}`
)
check(
  '★ 拒绝路径里 `initiator=Known(USER/u-1)`、`authority=Absent`：**被拒 ≠ 获授权**',
  tripleKey(tripleOfValue(deniedEvents[0]!.attribution!.slots.initiator as AttributionValue<unknown>)) ===
    `KNOWN|USER|u-1|-`,
  tripleKey(tripleOfValue(deniedEvents[0]!.attribution!.slots.initiator as AttributionValue<unknown>))
)
const allowedDbRows = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from character_action_events
        where action_id = 'wp5-gw-allowed' and attribution_origin = 'RECORDED'
          and source_kind is null and source_authority is null and epistemic_source is null`
  )
) as { c: number }[]
check('★ 真实 gateway 写的行 Axis B 三列全 NULL（K-22）', Number(allowedDbRows[0]?.c ?? -1) === 5, `${allowedDbRows[0]?.c}/5`)

// ===========================================================================
section('§5 负控（10 条，正控 / 负控 / 恢复三段式）')
// ===========================================================================

let negativeFired = 0
function fired(label: string, ok: boolean, detail?: string): void {
  if (ok) negativeFired += 1
  check(`负控 ${label}`, ok, detail)
}

// ① missing requestedBy becoming SYSTEM → MUST NEVER occur
const legacyActionId = asActionId('wp5-legacy-norequester')
await db.execute(
  sql`insert into character_action_events
        (action_id, sequence, character_id, event_type, status, capability, operation, payload,
         schema_version, created_at)
      values (${String(legacyActionId)}, 900, ${String(characterId)}, 'ACTION_REQUESTED', null,
              'system.echo', 'echo', '{"declaredTarget":null}'::jsonb, 1, ${Date.now()})`
)
await db.execute(
  sql`insert into character_action_events
        (action_id, sequence, character_id, event_type, status, capability, operation, payload,
         schema_version, created_at)
      values (${String(legacyActionId)}, 901, ${String(characterId)}, 'ACTION_SUCCEEDED', 'success',
              'system.echo', 'echo', '{}'::jsonb, 1, ${Date.now()})`
)
const legacyEvents = await ledger.getEventsByActionId(characterId, legacyActionId)
const legacyFolded = foldExecutionRecord(legacyEvents)
fired(
  'missing requestedBy **不会**变成 SYSTEM（折叠视图如实缺席）',
  legacyFolded !== undefined && legacyFolded.request.requestedBy === undefined,
  `requestedBy=${JSON.stringify(legacyFolded?.request.requestedBy ?? null)}`
)
check(
  '同一条历史行**没有** RECORDED 信封（不凭空补）',
  legacyEvents.every((event) => event.attribution === undefined)
)

// ② subject/character_id → actor without independent evidence → detector fires
let subjectToActorFired = false
try {
  buildTrustedActionAttribution({
    eventType: 'ACTION_REQUESTED',
    characterId: String(characterId),
    initiatorEvidence: humanInitiatorEvidence(),
    actorEvidence: attestActionActorFromDecisionPoint({ adapterId: 'action-gateway', principal: null }),
  })
} catch {
  subjectToActorFired = true
}
fired('subject/character_id 不能顶替 actor（缺独立证据 ⇒ 必要性矩阵必响）', subjectToActorFired)

// ③ initiator → actor without evidence → detector fires
const clonedInitiatorEvidence = {
  ...humanInitiatorEvidence(),
} as never
let initiatorToActorFired = false
try {
  buildTrustedActionAttribution({
    eventType: 'ACTION_REQUESTED',
    characterId: String(characterId),
    initiatorEvidence: humanInitiatorEvidence(),
    actorEvidence: clonedInitiatorEvidence,
  })
} catch {
  initiatorToActorFired = true
}
fired('initiator 的证据被克隆去当 actor ⇒ 必响（不是受信证据）', initiatorToActorFired)

// ④ actor → executor without actual executor evidence → detector fires
let actorToExecutorFired = false
try {
  buildTrustedActionAttribution({
    eventType: 'ACTION_STARTED',
    characterId: String(characterId),
    initiatorEvidence: humanInitiatorEvidence(),
    actorEvidence: attestActionActorFromDecisionPoint({
      adapterId: 'action-gateway',
      principal: GATEWAY_PRINCIPAL,
    }),
    authorityEvidence: attestActionAuthorityFromPolicy({ adapterId: 'action-policy', authority: CAPABILITY }),
  })
} catch {
  actorToExecutorFired = true
}
fired('executor 缺执行阶段证据（ACTION_STARTED 不给 executor）⇒ 必响', actorToExecutorFired)

// ⑤ initiator/actor/executor → SourceKind → contract and/or DB rejects
const axisBInjections = [
  { label: 'USER initiator → user_statement', sourceKind: 'user_statement' },
  { label: 'CHARACTER actor → character_output', sourceKind: 'character_output' },
  { label: 'TOOL executor → tool_output', sourceKind: 'tool_output' },
]
let axisBFired = 0
let forbiddenAxisBRejected = 0
for (const injection of axisBInjections) {
  const contractFires = validateActionAxisB({
    sourceKind: injection.sourceKind,
    sourceAuthority: null,
    epistemicSource: null,
  }).length > 0
  const dbRejected = await (async () => {
    try {
      await db.execute(
        sql`insert into character_action_events
              (action_id, sequence, character_id, event_type, capability, operation, payload,
               schema_version, created_at, attribution_origin, source_kind)
            values (${`wp5-axisb-${injection.sourceKind}`}, 950, ${String(characterId)}, 'ACTION_REQUESTED',
                    'system.echo', 'echo', '{}'::jsonb, 1, ${Date.now()}, 'RECORDED', ${injection.sourceKind})`
      )
      return false
    } catch {
      forbiddenAxisBRejected += 1
      return true
    }
  })()
  const residue = rowsOf(
    await db.execute(
      sql`select count(*)::int as c from character_action_events where action_id = ${`wp5-axisb-${injection.sourceKind}`}`
    )
  ) as { c: number }[]
  if (contractFires && dbRejected && Number(residue[0]?.c ?? -1) === 0) axisBFired += 1
}
measure('§5 ⑤ 位次→SourceKind 注入条数', axisBInjections.length)
fired(`位次→SourceKind 三条注入全部：契约响 + 库拒 + 零残留`, axisBFired === axisBInjections.length)

// ⑥ ACTION_REQUESTED with authority filled → reject
let requestedAuthorityFired = false
try {
  buildTrustedActionAttribution({
    eventType: 'ACTION_REQUESTED',
    characterId: String(characterId),
    initiatorEvidence: humanInitiatorEvidence(),
    actorEvidence: attestActionActorFromDecisionPoint({
      adapterId: 'action-gateway',
      principal: GATEWAY_PRINCIPAL,
    }),
    authorityEvidence: attestActionAuthorityFromPolicy({ adapterId: 'action-policy', authority: CAPABILITY }),
  })
} catch {
  requestedAuthorityFired = true
}
fired('ACTION_REQUESTED 带上 authority ⇒ 必响（请求 ≠ 已授权）', requestedAuthorityFired)

// ⑦ ACTION_AUTHORIZED with missing required authority → reject
let authorizedMissingAuthorityFired = false
try {
  buildTrustedActionAttribution({
    eventType: 'ACTION_AUTHORIZED',
    characterId: String(characterId),
    initiatorEvidence: humanInitiatorEvidence(),
    actorEvidence: attestActionActorFromDecisionPoint({
      adapterId: 'action-gateway',
      principal: GATEWAY_PRINCIPAL,
    }),
  })
} catch {
  authorizedMissingAuthorityFired = true
}
fired('ACTION_AUTHORIZED 缺必需 authority ⇒ 必响', authorizedMissingAuthorityFired)

// ⑧ caller-supplied recordedBy → reject / cannot become authoritative
const forgedRecordedByContext = {
  eventType: 'ACTION_REQUESTED',
  family: 'action_requested',
  subject: { kind: 'CHARACTER', id: String(characterId) },
  initiator: attributionKnown(USER),
  actor: attributionKnown(GATEWAY_PRINCIPAL),
  executor: attributionAbsent(),
  authority: attributionAbsent(),
  recordedBy: attributionKnown(USER),
  contentOriginator: attributionAbsent(),
  attributionOrigin: 'RECORDED',
  evidence: {
    initiatorAdapterId: 'forged',
    actorAdapterId: 'forged',
    executorAdapterId: null,
    authorityAdapterId: null,
  },
} as unknown as TrustedActionAttributionContext
const forgedAppend = await appendStage({
  type: 'ACTION_REQUESTED',
  attribution: forgedRecordedByContext,
})
fired(
  'caller 自报 recordedBy 的手写上下文 ⇒ 写入路径拒绝（untrusted_action_attribution_context）',
  forgedAppend.ok === false && forgedAppend.code === 'untrusted_action_attribution_context',
  `code=${String(forgedAppend.code)}`
)
check(
  '★ caller 自报的 recordedBy **不可能**成为权威值：受信路径写出来的 recordedBy 恒为 SYSTEM/kernel',
  dbSlotsAllRecordedByCanonical,
  dbSlotsAllRecordedByCanonical ? 'AA' : '存在非 canonical recorder'
)

// ⑨ hand-crafted clone of a real trusted context → reject
const realContext = buildStageContext({
  type: 'ACTION_REQUESTED',
  withAuthority: false,
  withExecutor: false,
  executorKnown: false,
})
const cloneProbes = [
  { label: '结构克隆（展开）', value: { ...realContext } as unknown },
  { label: 'JSON 往返', value: JSON.parse(JSON.stringify(realContext)) as unknown },
]
let cloneFired = 0
for (const clone of cloneProbes) {
  const rejected = !isTrustedActionAttributionContext(clone.value) && (() => {
    try {
      assertActionAttributionMatchesEvent(clone.value as TrustedActionAttributionContext, {
        eventType: 'ACTION_REQUESTED',
        characterId: String(characterId),
      })
      return false
    } catch {
      return true
    }
  })()
  if (rejected) cloneFired += 1
}
measure('§5 ⑨ 上下文克隆形态数', cloneProbes.length)
fired(`受信上下文的克隆（${cloneProbes.length} 种）一律不算证据`, cloneFired === cloneProbes.length)

// ⑩ Cognitive Axis B on an action row → reject and zero residue（见 ⑤ 的库级读数）
const axisBCells: ActionAxisBCells = {
  sourceKind: null,
  sourceAuthority: null,
  epistemicSource: null,
}
fired(
  'Cognitive Axis B 在行动行上唯一合法形状 = 三列全 NULL（契约安静）；任何非空 ⇒ 库拒 + 零残留',
  validateActionAxisB(axisBCells).length === 0 && axisBFired === axisBInjections.length && forbiddenAxisBRejected > 0,
  `契约对全 NULL 安静；注入被拒 ${forbiddenAxisBRejected} 次`
)

// --- 恢复：放回合法受信路径 ⇒ 重新安静 -------------------------------------
const restoreContext = buildStageContext({
  type: 'ACTION_REQUESTED',
  withAuthority: false,
  withExecutor: false,
  executorKnown: false,
})
const restoreActionId = asActionId('wp5-restore')
const restoreRequest = createActionRequest({
  actionId: restoreActionId,
  traceId: asTraceId('trc:wp5-restore'),
  capability: SYSTEM_ECHO,
  operation: 'echo',
  requestedBy: { kind: 'user', id: 'u-1' },
  arguments: { text: 'restore' },
  sideEffect: 'none',
})
let restoreOk = false
let restoreDetail = ''
try {
  const event = await ledger.appendRequested({
    characterId,
    request: restoreRequest,
    attribution: restoreContext,
  })
  const events = await ledger.getEventsByActionId(characterId, restoreActionId)
  const readback = events.find((candidate) => candidate.sequence === event.sequence)
  restoreOk =
    readback?.attribution?.attributionOrigin === 'RECORDED' &&
    ATTRIBUTION_VALUE_SLOTS.every(
      (slot) =>
        tripleKey(tripleOfValue(readback.attribution!.slots[slot] as AttributionValue<unknown>)) ===
        tripleKey(tripleOfValue(restoreContext[slot] as AttributionValue<unknown>))
    )
  restoreDetail = `sequence=${event.sequence}`
} catch (error) {
  restoreDetail = (error as Error).message.slice(0, 120)
}
check('恢复：放回合法受信路径 ⇒ 重新安静（写入并逐槽位回读一致）', restoreOk, restoreDetail)

const rejectedResidue = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from character_action_events
        where action_id like 'wp5-axisb-%' or action_id = 'wp5-forged-%'`
  )
) as { c: number }[]
check(
  '所有被拒的注入尝试**零残留**',
  Number(rejectedResidue[0]?.c ?? -1) === 0,
  `${rejectedResidue[0]?.c} 行`
)
measure('§5 响了的负控数', negativeFired)

// ===========================================================================
section('§6 执行真相防火墙（WP5-9）：归因**不**升级执行状态')
// ===========================================================================

const succeededWithoutStart = foldRecord([
  {
    actionId: asActionId('wp5-noH-start'),
    traceId: asTraceId('trc:wp5-noH-start'),
    characterId,
    sequence: 1,
    type: 'ACTION_SUCCEEDED',
    status: 'success',
    capability: SYSTEM_ECHO,
    operation: 'echo',
    payload: {},
    createdAt: Date.now(),
    attribution: {
      attributionOrigin: 'RECORDED',
      eventType: 'ACTION_SUCCEEDED',
      family: 'action_side_effect_execution',
      subject: { kind: 'CHARACTER', id: String(characterId) },
      slots: {
        initiator: attributionKnown(USER),
        actor: attributionKnown(GATEWAY_PRINCIPAL),
        executor: attributionKnown(EXECUTOR_PRINCIPAL),
        authority: attributionKnown(CAPABILITY),
        recordedBy: attributionKnown(LEDGER),
        contentOriginator: attributionAbsent(),
      },
    },
  },
])
check(
  '★ Known executor **不**蕴含 executed（没有 ACTION_STARTED ⇒ executed=false）',
  succeededWithoutStart !== undefined && succeededWithoutStart.executed === false,
  `executed=${String(succeededWithoutStart?.executed)}`
)
const requestedWithAuthority = foldRecord([
  {
    actionId: asActionId('wp5-noH-auth'),
    traceId: asTraceId('trc:wp5-noH-auth'),
    characterId,
    sequence: 1,
    type: 'ACTION_REQUESTED',
    capability: SYSTEM_ECHO,
    operation: 'echo',
    payload: {},
    createdAt: Date.now(),
    attribution: {
      attributionOrigin: 'RECORDED',
      eventType: 'ACTION_REQUESTED',
      family: 'action_requested',
      subject: { kind: 'CHARACTER', id: String(characterId) },
      slots: {
        initiator: attributionKnown(USER),
        actor: attributionKnown(GATEWAY_PRINCIPAL),
        executor: attributionAbsent(),
        /*
         * 这是**故意造出来的探针**：一条 REQUESTED 行带着 Known authority。
         * 折叠视图**仍然**必须 accepted=false —— 授权只由 ACTION_AUTHORIZED 建立。
         */
        authority: attributionKnown(CAPABILITY),
        recordedBy: attributionKnown(LEDGER),
        contentOriginator: attributionAbsent(),
      },
    },
  },
  {
    actionId: asActionId('wp5-noH-auth'),
    traceId: asTraceId('trc:wp5-noH-auth'),
    characterId,
    sequence: 2,
    type: 'ACTION_REJECTED',
    status: 'rejected',
    capability: SYSTEM_ECHO,
    operation: 'echo',
    payload: {},
    createdAt: Date.now(),
  },
])
check(
  '★ Known authority **不**蕴含 authorized（没有 ACTION_AUTHORIZED ⇒ accepted=false）',
  requestedWithAuthority !== undefined && requestedWithAuthority.accepted === false,
  `accepted=${String(requestedWithAuthority?.accepted)}`
)
const affectedDbRows = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from character_action_events
        where attribution_origin = 'RECORDED' and (source_kind is not null or source_authority is not null or epistemic_source is not null)`
  )
) as { c: number }[]
measure('§6 扫描的 RECORDED 行动行数', Number((
  rowsOf(
    await db.execute(
      sql`select count(*)::int as c from character_action_events where attribution_origin = 'RECORDED'`
    )
  ) as { c: number }[]
)[0]!.c))
check(
  '★ 全库：RECORDED 行动行里**没有**任何一行携带 Cognitive Axis B（假装认知来源）',
  Number(affectedDbRows[0]?.c ?? -1) === 0,
  `${affectedDbRows[0]?.c} 行`
)
const succeededFold = foldRecord(allowedEvents)
check(
  '★ ACTION_SUCCEEDED 的 verified 语义不存在于执行真相阶梯里（success ≠ 独立核验）',
  succeededFold !== undefined &&
    succeededFold.status === 'success' &&
    !Object.prototype.hasOwnProperty.call(succeededFold, 'verified'),
  `status=${String(succeededFold?.status)}`
)

// ===========================================================================
section('§7 历史边界（WP5-12）：不制造历史回填工作')
// ===========================================================================

let prodCopyReading: { verdict?: string; actionRows?: number } = {}
try {
  const artifact = JSON.parse(
    readFileSync(join(EVIDENCE_DIR, 'wp9b1-production-copy-v9.json'), 'utf8')
  ) as { verdict?: string; k22?: { existingActionRows?: number } }
  prodCopyReading = { verdict: artifact.verdict, actionRows: artifact.k22?.existingActionRows }
} catch {
  prodCopyReading = {}
}
check(
  'production-copy 读数存在且 = PASS（本步据此判定"历史行动行为空"；WP9-B1 起读 v6 → v9 那一份）',
  prodCopyReading.verdict === 'PASS',
  `verdict=${String(prodCopyReading.verdict)}`
)
check(
  '★ 真实库副本里的 `character_action_events` 行数 = 0 ⇒ 本步**不**制造回填工作（也不需要）' +
    '；若它变成非 0，本条会红并触发 STOP',
  prodCopyReading.actionRows === 0,
  `rows=${String(prodCopyReading.actionRows)}`
)
const migratedRows = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from character_action_events where attribution_origin = 'MIGRATED_LEGACY'`
  )
) as { c: number }[]
check(
  '本步**没有**写任何 MIGRATED_LEGACY 行动行（不把历史静默判成 RECORDED，也不伪造回填）',
  Number(migratedRows[0]?.c ?? -1) === 0,
  `${migratedRows[0]?.c} 行`
)

// ===========================================================================
section('§8 汇总与证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const verdict = failed === 0 ? 'PASS' : 'FAIL'
const evidence = {
  testId: 'M5.1.1 / WP5 action & execution attribution',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp5:verify',
  verdict,
  passed,
  failed,
  failures,
  storeWritePathReadback: {
    warning: '见 stages：每个类型的三份读数（writeSlots / dbSlots / readSlots）都已落盘',
  },
  bridge: {
    table: ACTION_ATTRIBUTION_FAMILY_BY_EVENT_TYPE,
    source: 'WP5 §WP5-6 + Migration-Strategy §3.3（机器交叉核对）',
    crossCheckedCells: crossChecked,
    mismatches: crossMismatches,
  },
  stages: stageReadings,
  stageImmutability: {
    actionId: chainActionId,
    sequences: chainSequences,
    requestedRowAfterChain: {
      authority: requestedRowAfterChain.authority_kind ?? null,
      executor: requestedRowAfterChain.executor_kind ?? null,
    },
    authorizedRowAfterChain: {
      authority: authorizedRowAfterChain.authority_kind ?? null,
      executor: authorizedRowAfterChain.executor_kind ?? null,
    },
  },
  realGateway: {
    allowedEvents: allowedEvents.map((event) => event.type),
    deniedEvents: deniedEvents.map((event) => event.type),
    allowedExecuted: allowedResult.executed,
    deniedExecuted: deniedResult.executed,
    attributedAxisBNullRows: Number(allowedDbRows[0]?.c ?? -1),
  },
  negatives: {
    fired: negativeFired,
    requestedByLegacyFold: legacyFolded?.request.requestedBy ?? null,
    axisBInjections: axisBInjections.map((injection) => injection.label),
    cloneProbes: cloneProbes.map((clone) => clone.label),
    restoreOk,
  },
  executionTruthFirewall: {
    knownExecutorImpliesExecuted: succeededWithoutStart?.executed,
    knownAuthorityImpliesAccepted: requestedWithAuthority?.accepted,
    recordedRowsWithAxisB: Number(affectedDbRows[0]?.c ?? -1),
    succeededHasNoVerifiedField: succeededFold !== undefined &&
      !Object.prototype.hasOwnProperty.call(succeededFold, 'verified'),
  },
  historicalBoundary: {
    prodCopyVerdict: prodCopyReading.verdict ?? null,
    prodCopyActionRows: prodCopyReading.actionRows ?? null,
    migratedLegacyRowsWrittenInSandbox: Number(migratedRows[0]?.c ?? -1),
    backfillManufactured: false,
  },
  schemaBoundary: {
    latestSchemaVersion: schemaVersion,
    migration0007Sha256: fingerprint(7),
    migration0008Sha256: fingerprint(8),
    schemaChangeRequired: false,
  },
  sandbox: { dir: sandbox.dir, isProductionDir: isProductionDir(sandbox.dir), schemaVersion },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    liveDb: false,
    wp6Started: false,
    factFirewall: '未改',
    memoryAuthority: '未改',
    recall: '未改',
    extractor: '未改',
    adr043: '未改（NOT APPROVED）',
    phase4: '未开始',
    developerControl: '未触碰（U-03 仍是一个独立的未决物理面）',
  },
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
/*
 * 计划书（`M5.1.1-Execution-Plan.md` 的 WP5「Evidence」）登记的名字是
 * `wp5-execution-attribution.json`；本门把它与 `wp5-action-attribution.json`
 * 写成**同一份内容**（两个名字，免得下游按登记名找不到证据）。
 */
const evidenceJson = `${JSON.stringify({ ...evidence, evidenceNames: ['wp5-execution-attribution.json', 'wp5-action-attribution.json'] }, null, 2)}\n`
writeFileSync(join(EVIDENCE_DIR, 'wp5-action-attribution.json'), evidenceJson, 'utf8')
writeFileSync(join(EVIDENCE_DIR, 'wp5-execution-attribution.json'), evidenceJson, 'utf8')

console.log(`\n${'='.repeat(74)}`)
console.log(`WP5 Action & Execution Attribution：${passed} 通过 / ${failed} 失败｜verdict = ${verdict}`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp5-execution-attribution.json ・ wp5-action-attribution.json')
try {
  await runtime.stop()
} catch {
  /* ignore */
}
process.exit(failed === 0 ? 0 : 1)
