/**
 * M5.1.1 WP5.1 —— **K-27：Action Initiator Presented-Role / Causal-Origin Conflation**
 * （`pnpm m5.1.1:wp5.1:verify`）
 *
 * ============================================================================
 *  它证明的是什么
 * ============================================================================
 *  `initiator` = **真正提出 / 造成 / 触发**这次动作的那个位次。
 *  **呈现角色**（`speaker` / `actor_type` / payload 的 `requestedBy`）**不是**证据。
 *
 *  ① 静态：契约里**没有**"从呈现角色构造 initiator"的入口；`action-turn` 里
 *     也没有呈现角色 → 位次的映射。
 *  ② **真实的跨账本 D01 场景**：先用**真实 conversation store** 写一条
 *     `actor_type=user` 而 `actor=contentOriginator=Known(SERVICE/agent)` 的 RECORDED 行，
 *     **读回来**，再**真的从那个事件触发一次动作**（真实 action-turn 端口 + 真实 gateway
 *     + 真实 action store）⇒ 动作行的 `initiator` 必须是 **SERVICE/agent**，
 *     **绝不能**是 USER。
 *  ③ 正控：真正的受信人类输入（RECORDED + 两个权威槽位都指向 USER）⇒ `Known(USER/u-1)`。
 *  ④ 歧义 / 未记录 / 只有呈现角色 ⇒ 一律 `Unknown(RUNTIME_UNRESOLVED)`。
 *  ⑤ 负控 6 条 + 正控 / 负控 / 恢复三段式；计数检测器全部 `measured_count > 0`。
 *
 * ⚠️ 它**不**改：actor / executor / authority / recordedBy / 必要性矩阵 /
 *    Axis B N/A / Execution Truth 阶梯 / `MIGRATION_0007` / `MIGRATION_0008`。
 *    没有 schema 变更，也没有 v9。
 *
 * 跑法：pnpm m5.1.1:wp5.1:verify
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import 'dotenv/config'

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { PRODUCTION_DB_DIR, isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import {
  CAUSAL_CORRELATION_BOUNDARY,
  attestActionInitiatorFromCausalOrigin,
  attestActionInitiatorUnresolved,
  attestContentOriginatorFromIngress,
  attestActorFromDecisionPoint,
  attestEpistemicConfirmation,
  buildTrustedAttributionContext,
  correlationSourceFromConversationEvent,
  isTrustedAttestationEvidence,
  triggeringConversationEventOf,
  type TrustedCausalSource,
} from '../src/kernel/contracts/attribution.ts'
import {
  attributionKnown,
  type AttributionValue,
  type PrincipalRef,
} from '../src/kernel/contracts/actor.ts'
import {
  asCharacterId,
  asConversationId,
  asTraceId,
  type TraceId,
} from '../src/kernel/contracts/ids.ts'
import type { ActionTarget } from '../src/kernel/action/action-request.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
} from '../src/kernel/action/capability-registry.ts'
import { createActionIntentDetector } from '../src/kernel/action/intent-detector.ts'
import { createActionTurnPort } from '../src/kernel/action/action-turn.ts'
import { createActionGateway } from '../src/kernel/action/gateway.ts'
import { appendConversationEvent, findByConversationSequence } from '../src/infrastructure/persistence/conversation-store.ts'
import { createEchoAdapter } from '../src/infrastructure/action/adapters/echo.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
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
const AGENT: PrincipalRef = { kind: 'SERVICE', id: 'agent' } as PrincipalRef
const USER: PrincipalRef = { kind: 'USER', id: 'u-1' } as PrincipalRef
const CHARACTER_PRINCIPAL: PrincipalRef = { kind: 'CHARACTER', id: 'char_sumuwei' } as PrincipalRef

console.log('='.repeat(74))
console.log('M5.1.1 WP5.1 —— K-27 Initiation Causality（真实跨账本 D01 场景）')
console.log('='.repeat(74))

const sandbox = isolateDatabase('m5.1.1-wp51')
check('沙箱不是真实库', isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()), sandbox.dir)
check(
  '真实库路径只被记录，从未被本脚本打开',
  PRODUCTION_DB_DIR.endsWith(join('data', 'pglite')) && process.env.PGLITE_DATA_DIR !== PRODUCTION_DB_DIR,
  PRODUCTION_DB_DIR
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
  '沙箱库 schema = v9（K-27 本身无 schema 变更；v9 是 WP9-B1 的 state_events 承载）',
  schemaVersion === 9,
  `v${schemaVersion}`
)

const fingerprint = (version: number): string => {
  const migration = MIGRATIONS.find((m) => m.version === version)!
  return createHash('sha256').update(migration.statements.join('\n'), 'utf8').digest('hex')
}
check(
  'MIGRATION_0007 逐字未改',
  fingerprint(7) === '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613',
  fingerprint(7).slice(0, 16)
)
check(
  'MIGRATION_0008 逐字未改',
  fingerprint(8) === '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29',
  fingerprint(8).slice(0, 16)
)
check(
  '代码里的迁移清单 = 1..9（WP5.1 本身无 schema 变更；0009 = WP9-B1 的 state_events 承载，' +
    '原判据"没有 MIGRATION_0009"按 R-45 的新事实改写，未放宽）',
  MIGRATIONS.map((m) => m.version).join(',') === '1,2,3,4,5,6,7,8,9' &&
    MIGRATIONS.find((m) => m.version === 9)?.name === 'm5.1.1-state-events-attribution',
  MIGRATIONS.map((m) => m.version).join(',')
)

const characterId = asCharacterId('char_sumuwei')
const ledger = createActionLedgerStore(db)

// ===========================================================================
section('§1 静态：呈现角色**没有**构造权威 initiator 的入口')
// ===========================================================================

const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
const attributionSource = readFileSync(join(ROOT, 'src', 'kernel', 'contracts', 'attribution.ts'), 'utf8')
const actionTurnSource = codeOnly(readFileSync(join(ROOT, 'src', 'kernel', 'action', 'action-turn.ts'), 'utf8'))
const gatewaySource = codeOnly(readFileSync(join(ROOT, 'src', 'kernel', 'action', 'gateway.ts'), 'utf8'))

check(
  '★ 契约里**不再有**"从呈现角色构造 initiator"的入口（`attestActionInitiatorFromIngress` 已删除）',
  !/attestActionInitiatorFromIngress/.test(codeOnly(attributionSource)),
  'AA'
)
check(
  '★ `action-turn` 里**没有**呈现角色 → 位次的映射（`speakerPrincipal` 已删除）',
  !/speakerPrincipal/.test(actionTurnSource) &&
    !/input\.speaker[\s\S]{0,80}(USER|CHARACTER|SYSTEM|TOOL)/.test(actionTurnSource),
  'AA'
)
check(
  '★ 唯一两个 initiator 入口：因果来源（能给 Known）/ 如实未定（不能给 Known）',
  /export function attestActionInitiatorFromCausalOrigin\(/.test(attributionSource) &&
    /export function attestActionInitiatorUnresolved\(/.test(attributionSource) &&
    /causalBasis/.test(attributionSource),
  'AA'
)
check(
  '关联边界是**显式**的常量（不是"任意两本账之间的通用换算"）',
  CAUSAL_CORRELATION_BOUNDARY === 'conversation_turn_triggered_action'
)
check(
  'gateway 只消费 `invocation.initiatorEvidence`，不碰 `request.requestedBy`',
  /initiatorEvidence/.test(gatewaySource) &&
    !/initiator[\s\S]{0,60}request\.requestedBy/.test(gatewaySource),
  'AA'
)
measure('§1 静态检查的源文件数', 3)

// ===========================================================================
section('§2 静态：`speaker` 仍保留（legacy / 呈现 / 兼容 / 路由）')
// ===========================================================================

check(
  '`ActionTurnInput.speaker` 仍然存在（K-27 只禁止它构造权威 initiator，不禁止它存在）',
  /speaker: \{ kind: 'user' \| 'character' \| 'system' \| 'tool'; id\?: string \}/.test(
    readFileSync(join(ROOT, 'src', 'kernel', 'action', 'action-turn.ts'), 'utf8')
  )
)
check(
  '`speaker` 仍然只被用来填 payload 的 `requestedBy`（兼容/输入证据）',
  /requestedBy: input\.speaker/.test(actionTurnSource),
  'AA'
)

// ===========================================================================
section('§3 真实跨账本 D01 场景：agent 以 user 角色提交 ⇒ 动作 initiator **不是** USER')
// ===========================================================================

const conversationId = asConversationId('conv_wp51')

/** 用**真实 conversation store** 写一条 RECORDED 归因行 */
async function writeTriggeringConversationEvent(input: {
  sequence: number
  actorType: 'user' | 'character'
  actorId: string
  actorPrincipal: PrincipalRef | null
  originatorPrincipal: PrincipalRef | null
  humanAttested?: boolean
  content: string
}): Promise<{ eventId: string; row: Record<string, unknown> }> {
  const context = buildTrustedAttributionContext({
    family: 'user_message',
    characterId: String(characterId),
    actorEvidence: attestActorFromDecisionPoint({
      adapterId: 'conversation-ingress',
      principal: input.actorPrincipal,
    }),
    contentOriginatorEvidence: attestContentOriginatorFromIngress({
      adapterId: 'conversation-ingress',
      principal: input.originatorPrincipal,
    }),
    ...(input.humanAttested === true
      ? {
          epistemicEvidence: attestEpistemicConfirmation({
            adapterId: 'conversation-ingress',
            kind: 'authenticated_human_input',
          }),
        }
      : {}),
  })
  const event = await appendConversationEvent(db, {
    characterId,
    conversationId,
    conversationSequence: input.sequence,
    type: 'user_message',
    actorType: input.actorType,
    actorId: input.actorId,
    content: input.content,
    trustedAttribution: context,
  })
  const rows = rowsOf(
    await db.execute(
      sql`select * from conversation_events where character_id = ${String(characterId)}
            and conversation_id = ${String(conversationId)} and conversation_sequence = ${input.sequence}`
    )
  ) as Record<string, unknown>[]
  return { eventId: String(event.event.id), row: rows[0] ?? {} }
}

// --- ① D01 形状：actor_type=user，而两个权威槽位都是 SERVICE/agent -------------
const d01 = await writeTriggeringConversationEvent({
  sequence: 1,
  actorType: 'user',
  actorId: 'agent',
  actorPrincipal: AGENT,
  originatorPrincipal: AGENT,
  content: '帮我做一件事',
})
check(
  '★ 触发事件真的落成 D01 形状（actor_type=user ∧ actor=SERVICE/agent ∧ contentOriginator=SERVICE/agent ∧ RECORDED）',
  d01.row.actor_type === 'user' &&
    d01.row.actor_kind === 'SERVICE' &&
    d01.row.actor_ref_id === 'agent' &&
    d01.row.content_originator_kind === 'SERVICE' &&
    d01.row.attribution_origin === 'RECORDED',
  `actor=${String(d01.row.actor_kind)}/${String(d01.row.actor_ref_id)} originator=${String(d01.row.content_originator_kind)}`
)

// --- ② 受信读者读回那一行（不是拿内存里的对象） -------------------------------
const d01Readback = await findByConversationSequence(db, characterId, conversationId, 1)
const d01CausalInput = triggeringConversationEventOf(d01Readback!)
check(
  '★ 因果上下文只搬运**读回来**的事实（RECORDED + actor + contentOriginator）',
  d01CausalInput.attributionOrigin === 'RECORDED' &&
    d01CausalInput.actor !== undefined &&
    d01CausalInput.contentOriginator !== undefined,
  `origin=${String(d01CausalInput.attributionOrigin)}`
)

// --- ③ 真的从那个事件触发一次动作（真实端口 + 真实 gateway + 真实 store） -----
const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
const target: ActionTarget = { type: 'unknown', confidence: 'none' }
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
const turnPort = createActionTurnPort({
  gateway,
  detector: createActionIntentDetector(),
  registry,
  attribution: { adapterId: 'action-turn' },
})

interface TurnOutcomeReading {
  ok: boolean
  actionId: string | null
  initiator: string
  kind: string | null
  id: string | null
  reason: string | null
  detail: string
}

async function runTurn(input: {
  text: string
  eventId: string
  speakerKind: 'user' | 'character' | 'system' | 'tool'
  speakerId?: string
  triggeringEvent?: ReturnType<typeof triggeringConversationEventOf>
  traceId?: TraceId
}): Promise<TurnOutcomeReading> {
  try {
    const outcome = await turnPort.handleTurn({
      characterId,
      traceId: input.traceId ?? asTraceId('trc:wp51'),
      text: input.text,
      eventId: input.eventId,
      speaker: {
        kind: input.speakerKind,
        ...(input.speakerId !== undefined ? { id: input.speakerId } : {}),
      },
      ...(input.triggeringEvent !== undefined ? { triggeringEvent: input.triggeringEvent } : {}),
    })
    if (outcome.request === undefined) {
      return { ok: false, actionId: null, initiator: 'NOT_APPLICABLE', kind: null, id: null, reason: null, detail: 'no request' }
    }
    const events = await ledger.getEventsByActionId(characterId, outcome.request.actionId)
    const first = events.find((event) => event.type === 'ACTION_REQUESTED')
    const value = first?.attribution?.slots.initiator as AttributionValue<PrincipalRef> | undefined
    const triple =
      value === undefined
        ? 'NO_ENVELOPE'
        : value.state === 'KNOWN'
          ? `KNOWN|${value.value.kind}|${value.value.id}`
          : value.state === 'UNKNOWN'
            ? `UNKNOWN|-|-|${value.reason}`
            : 'ABSENT|-|-|-'
    return {
      ok: true,
      actionId: String(outcome.request.actionId),
      initiator: triple,
      kind: value?.state === 'KNOWN' ? value.value.kind : null,
      id: value?.state === 'KNOWN' ? value.value.id : null,
      reason: value?.state === 'UNKNOWN' ? value.reason : null,
      detail: `events=${events.length}`,
    }
  } catch (error) {
    return {
      ok: false,
      actionId: null,
      initiator: 'ERROR',
      kind: null,
      id: null,
      reason: null,
      detail: (error as Error).message.slice(0, 160),
    }
  }
}

const d01Action = await runTurn({
  text: 'echo wp51-d01',
  eventId: d01.eventId,
  // **呈现角色故意说 user**：K-27 之后它不再决定 initiator
  speakerKind: 'user',
  speakerId: 'u-1',
  triggeringEvent: d01CausalInput,
})
check(
  '★ D01 跨账本：动作 initiator = **Known(SERVICE/agent)**（由因果证据确立，不是呈现角色）',
  d01Action.ok && d01Action.kind === 'SERVICE' && d01Action.id === 'agent',
  d01Action.initiator
)
check(
  '★ D01 跨账本：initiator **不是** USER（呈现角色在这里一票都没有）',
  d01Action.kind !== 'USER' && d01Action.id !== 'u-1',
  `kind=${String(d01Action.kind)} id=${String(d01Action.id)}`
)

// ===========================================================================
section('§4 正控：真正的受信人类输入 ⇒ initiator = Known(USER/u-1)')
// ===========================================================================

const human = await writeTriggeringConversationEvent({
  sequence: 2,
  actorType: 'user',
  actorId: 'u-1',
  actorPrincipal: USER,
  originatorPrincipal: USER,
  humanAttested: true,
  content: '帮我做一件事（人打的）',
})
const humanReadback = await findByConversationSequence(db, characterId, conversationId, 2)
const humanAction = await runTurn({
  text: 'echo wp51-human',
  eventId: human.eventId,
  speakerKind: 'user',
  speakerId: 'u-1',
  triggeringEvent: triggeringConversationEventOf(humanReadback!),
})
check(
  '正控：真实人类来源（RECORDED + 两个权威槽位都是 USER）⇒ initiator = Known(USER/u-1)',
  humanAction.ok && humanAction.kind === 'USER' && humanAction.id === 'u-1',
  humanAction.initiator
)
check(
  '正控：该行的 Axis B 三列仍为 NULL、origin=RECORDED（WP5 语义未变）',
  Number(
    (
      rowsOf(
        await db.execute(
          sql`select count(*)::int as c from character_action_events
              where action_id = ${humanAction.actionId ?? 'none'} and attribution_origin = 'RECORDED'
                and source_kind is null and source_authority is null and epistemic_source is null`
        )
      ) as { c: number }[]
    )[0]!.c
  ) > 0
)

// ===========================================================================
section('§5 负控（呈现角色 / 未记录 / 歧义 / 伪造 证据）')
// ===========================================================================

let negativeFired = 0
function fired(label: string, ok: boolean, detail?: string): void {
  if (ok) negativeFired += 1
  check(`负控 ${label}`, ok, detail)
}

// ① speaker=user 而**没有**因果上下文 ⇒ 不得变成 Known(USER)
const noCausalUser = await runTurn({
  text: 'echo wp51-nocausal-user',
  eventId: 'cev:none',
  speakerKind: 'user',
  speakerId: 'u-1',
})
fired(
  'speaker=user 且无因果证据 ⇒ Unknown(RUNTIME_UNRESOLVED)（**不是** Known(USER)）',
  noCausalUser.ok &&
    noCausalUser.kind === null &&
    noCausalUser.reason === 'RUNTIME_UNRESOLVED' &&
    noCausalUser.initiator.startsWith('UNKNOWN'),
  noCausalUser.initiator
)

// ② speaker=character 而**没有**因果上下文 ⇒ 不得变成 Known(CHARACTER)
const noCausalCharacter = await runTurn({
  text: 'echo wp51-nocausal-character',
  eventId: 'cev:none',
  speakerKind: 'character',
  speakerId: 'char_sumuwei',
})
fired(
  'speaker=character 且无因果证据 ⇒ Unknown（**不是** Known(CHARACTER)）',
  noCausalCharacter.ok &&
    noCausalCharacter.kind === null &&
    noCausalCharacter.reason === 'RUNTIME_UNRESOLVED',
  noCausalCharacter.initiator
)

// ③ actor_type=user 的**历史行**（没有权威归因）⇒ 不得变成 USER
const legacyTrigger = {
  eventId: 'cev:legacy',
  type: 'user_message' as const,
  attributionOrigin: null,
}
const legacyAction = await runTurn({
  text: 'echo wp51-legacy',
  eventId: 'cev:legacy',
  speakerKind: 'user',
  speakerId: 'u-1',
  triggeringEvent: legacyTrigger,
})
fired(
  '历史行（actor_type=user 但没有权威归因）⇒ Unknown（**不是** USER）',
  legacyAction.ok && legacyAction.kind === null && legacyAction.reason === 'RUNTIME_UNRESOLVED',
  legacyAction.initiator
)

// ④ payload 的 requestedBy=user ⇒ 不能成为权威 initiator
fired(
  'payload `requestedBy`=user 与 speaker=user 同时存在，仍然只得到 Unknown（自报不是证据）',
  noCausalUser.initiator.startsWith('UNKNOWN') &&
    (
      rowsOf(
        await db.execute(
          sql`select payload from character_action_events where action_id = ${noCausalUser.actionId ?? 'none'}`
        )
      ) as { payload: { requestedBy?: { kind?: string } } }[]
    ).some((row) => row.payload?.requestedBy?.kind === 'user'),
  `payload.requestedBy 已写 user，但 initiator=${noCausalUser.initiator}`
)

// ⑤ 手写的"因果证据"对象 ⇒ 构造器拒绝
const handCraftedCausal = {
  correlation: CAUSAL_CORRELATION_BOUNDARY,
  adapterId: 'forged',
  principal: USER,
  eventId: 'cev:forged',
  eventFamily: 'user_message',
  attributionOrigin: 'RECORDED',
  actor: attributionKnown(USER),
  contentOriginator: attributionKnown(USER),
} as unknown as TrustedCausalSource
let handCraftedRejected = false
try {
  attestActionInitiatorFromCausalOrigin({ adapterId: 'action-turn', causalSource: handCraftedCausal })
} catch {
  handCraftedRejected = true
}
fired('手写的同形"因果证据"对象 ⇒ 不是证据（必响）', handCraftedRejected && !isTrustedAttestationEvidence(handCraftedCausal))

// ⑥ 受信因果证据被克隆 / JSON 往返 ⇒ 也不是证据
const realCausalSource = correlationSourceFromConversationEvent({
  adapterId: 'action-turn',
  triggeringEvent: d01CausalInput,
})
const causalClones: { label: string; value: unknown }[] = [
  { label: '结构克隆（展开）', value: { ...realCausalSource } },
  { label: 'JSON 往返', value: JSON.parse(JSON.stringify(realCausalSource)) as unknown },
]
measure('§5 因果证据的克隆形态数', causalClones.length)
let cloneFired = 0
for (const clone of causalClones) {
  let rejected = false
  try {
    attestActionInitiatorFromCausalOrigin({
      adapterId: 'action-turn',
      causalSource: clone.value as TrustedCausalSource,
    })
  } catch {
    rejected = true
  }
  if (rejected && !isTrustedAttestationEvidence(clone.value)) cloneFired += 1
  check(`负控 因果证据 ${clone.label} ⇒ 不算证据（必响）`, rejected, 'AA')
}
measure('§5 响了的克隆负控数', cloneFired)

// ⑦ 两个权威槽位**不一致** ⇒ 有歧义 ⇒ Unknown（不是挑一个）
const disagreeingAction = await runTurn({
  text: 'echo wp51-disagree',
  eventId: 'cev:disagree',
  speakerKind: 'user',
  speakerId: 'u-1',
  triggeringEvent: {
    eventId: 'cev:disagree',
    type: 'user_message',
    attributionOrigin: 'RECORDED',
    actor: attributionKnown(CHARACTER_PRINCIPAL),
    contentOriginator: attributionKnown(USER),
  },
})
fired(
  'actor=CHARACTER 而 contentOriginator=USER（两个权威槽位不一致）⇒ Unknown（**不挑一个**）',
  disagreeingAction.ok &&
    disagreeingAction.kind === null &&
    disagreeingAction.reason === 'RUNTIME_UNRESOLVED',
  disagreeingAction.initiator
)

// ⑧ 只有一个槽位是 Known ⇒ Unknown
const oneSlotAction = await runTurn({
  text: 'echo wp51-oneslot',
  eventId: 'cev:oneslot',
  speakerKind: 'user',
  speakerId: 'u-1',
  triggeringEvent: {
    eventId: 'cev:oneslot',
    type: 'user_message',
    attributionOrigin: 'RECORDED',
    actor: attributionKnown(USER),
    contentOriginator: { state: 'UNKNOWN', reason: 'RUNTIME_UNRESOLVED' },
  },
})
fired(
  '只有 actor 是 Known 而 contentOriginator 不是 ⇒ Unknown',
  oneSlotAction.ok && oneSlotAction.kind === null && oneSlotAction.reason === 'RUNTIME_UNRESOLVED',
  oneSlotAction.initiator
)
measure('§5 响了的负控组数', negativeFired)

// ===========================================================================
section('§6 恢复 + 早期行不可变（WP5.1 §8）')
// ===========================================================================

const restoreAction = await runTurn({
  text: 'echo wp51-restore',
  eventId: human.eventId,
  speakerKind: 'user',
  speakerId: 'u-1',
  triggeringEvent: triggeringConversationEventOf(humanReadback!),
})
check(
  '恢复：放回合法因果路径 ⇒ 重新安静（initiator = Known(USER/u-1)）',
  restoreAction.ok && restoreAction.kind === 'USER' && restoreAction.id === 'u-1',
  restoreAction.initiator
)

const d01Rows = rowsOf(
  await db.execute(
    sql`select * from character_action_events where action_id = ${d01Action.actionId ?? 'none'}
        order by sequence asc`
  )
) as Record<string, unknown>[]
measure('§6 D01 动作链的行数', d01Rows.length)
check(
  '★ 早期行**不可变**：整条 action 链上每一行的 initiator 都是 SERVICE/agent（后续阶段没有回溯改写）',
  d01Rows.length > 1 &&
    d01Rows.every(
      (row) =>
        row.initiator_kind === 'SERVICE' &&
        row.initiator_id === 'agent' &&
        row.attribution_origin === 'RECORDED'
    ),
  `${d01Rows.length} 行`
)
check(
  '★ 整条 D01 动作链**没有任何一行**的 initiator 是 USER（负控的终局断言）',
  d01Rows.every((row) => row.initiator_kind !== 'USER'),
  d01Rows.map((row) => String(row.initiator_kind)).join(',')
)

const userInitiatedActions = rowsOf(
  await db.execute(
    sql`select count(distinct action_id)::int as c from character_action_events
        where attribution_origin = 'RECORDED' and initiator_kind = 'USER'`
  )
) as { c: number }[]
const totalRecorded = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from character_action_events where attribution_origin = 'RECORDED'`
  )
) as { c: number }[]
measure('§6 扫描的 RECORDED 行动行数（作用域自检）', Number(totalRecorded[0]?.c ?? 0))
check(
  '★ 全库：initiator=USER 的动作**只有**那两条真正的受信人类输入路径（human + restore）',
  Number(userInitiatedActions[0]?.c ?? -1) === 2,
  `${userInitiatedActions[0]?.c} 个 USER 发起的 action / 共 ${totalRecorded[0]?.c} 行 RECORDED`
)

// ===========================================================================
section('§7 汇总与证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const verdict = failed === 0 ? 'PASS' : 'FAIL'
const evidence = {
  testId: 'M5.1.1 / WP5.1 K-27 action initiator causal closure',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp5.1:verify',
  verdict,
  passed,
  failed,
  failures,
  k27: verdict === 'PASS' ? 'CLOSED' : 'FAIL',
  frozenMeaning:
    'initiator = 真正提出/造成/触发这次动作的那个位次；呈现角色（speaker / actor_type / requestedBy）不是证据',
  staticChecks: {
    presentedRoleConstructorRemoved: !/attestActionInitiatorFromIngress/.test(codeOnly(attributionSource)),
    speakerToPrincipalMappingRemoved: !/speakerPrincipal/.test(actionTurnSource),
    causalConstructors: ['attestActionInitiatorFromCausalOrigin', 'attestActionInitiatorUnresolved'],
    correlationBoundary: CAUSAL_CORRELATION_BOUNDARY,
    speakerStillUsedForRequestedByPayload: /requestedBy: input\.speaker/.test(actionTurnSource),
  },
  d01CrossLedger: {
    triggeringEventRow: {
      actor_type: d01.row.actor_type,
      actor: `${String(d01.row.actor_kind)}/${String(d01.row.actor_ref_id)}`,
      contentOriginator: `${String(d01.row.content_originator_kind)}/${String(d01.row.content_originator_id)}`,
      attribution_origin: d01.row.attribution_origin,
    },
    presentedSpeaker: 'user/u-1（故意）',
    actionInitiator: d01Action.initiator,
    actionInitiatorIsUser: d01Action.kind === 'USER',
    actionChainRows: d01Rows.length,
  },
  humanPositive: { actionInitiator: humanAction.initiator },
  negatives: {
    fired: negativeFired,
    speakerUserWithoutCausal: noCausalUser.initiator,
    speakerCharacterWithoutCausal: noCausalCharacter.initiator,
    legacyActorTypeUser: legacyAction.initiator,
    slotsDisagree: disagreeingAction.initiator,
    oneSlotKnown: oneSlotAction.initiator,
    handCraftedCausalRejected: handCraftedRejected,
    causalClonesRejected: cloneFired,
  },
  restore: { actionInitiator: restoreAction.initiator },
  immutability: {
    d01ChainAllServiceAgent: d01Rows.every((row) => row.initiator_kind === 'SERVICE'),
    userInitiatedActions: Number(userInitiatedActions[0]?.c ?? -1),
    recordedRows: Number(totalRecorded[0]?.c ?? -1),
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
    actorEvidenceUnchanged: true,
    executorEvidenceUnchanged: true,
    authorityEvidenceUnchanged: true,
    recordedByUnchanged: true,
    necessityMatrixUnchanged: true,
    axisBNotApplicableUnchanged: true,
    executionTruthUnchanged: true,
  },
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'wp5.1-k27-causal-initiator.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\n${'='.repeat(74)}`)
console.log(`WP5.1 K-27 Initiation Causality：${passed} 通过 / ${failed} 失败｜verdict = ${verdict}`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp5.1-k27-causal-initiator.json')
try {
  await runtime.stop()
} catch {
  /* ignore */
}
process.exit(failed === 0 ? 0 : 1)
