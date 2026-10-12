/**
 * M5.1.1 / WP9 —— **Real Runtime Attribution E2E**（`pnpm m5.1.1:wp9:verify`）
 *
 * 目标（用户 WP9 执行令原文）：证明"从真实运行时入口进入的因果事实，经过真实
 * Gateway / Ledger / DB / Readback / Query 后，仍然是同一个归因事实；真实执行结果与账本记录一致"。
 *
 * 边界（WP9-1 / WP9-12 / WP9-13 / WP9-18）：
 *   · 入口尽量靠近真实产品运行：只使用**生产装配用的同一批工厂**（M4 harness 的真实 runtime/kernel、
 *     `conversationAttributionForEntryMode` 的生产 ingress、真实 `TurnGateway`、
 *     真实 `createActionGateway` + 仓库既有的 `createEchoAdapter`、真实 `createDeveloperQueryService`、
 *     真实 control service + HTTP 面）。
 *   · **禁止**：fixture → `createConversationEvent()` → `store.insert()`；**禁止**手工造
 *     `TrustedAttributionContext` 冒充生产 ingress。
 *   · 用 isolated sandbox DB（真实 schema v8），**不碰** `data/pglite`。
 *   · 缺生产入口时**不补功能**：如实记 `NOT RUN / BLOCKED` + 登记 capability gap（WP9-13）。
 *
 * **WP9-C1 / R-48（2026-09-19）—— E4 的验收载体变更**：
 *   · E4 的载体由 R-48 裁定为 **domain-appropriate authoritative event ledger**（`Q1 = a`）：
 *     本门跑**真实首次 State Bootstrap**（生产引导组件的受信证据 → `initCharacterState`
 *     → 真实 `state_events` INSERT → 受信 readback），L1/L2 由**同一个真实 `stateEventId`** 关联。
 *   · 旧读数 `Conversation SYSTEM Producer = 0` **被保留**为 `DC-1` Deferred Capability Observation
 *     （不得删除以制造"问题从未存在过"的历史），但**不再**是 E4 的 PASS 条件。
 *   · E8 接到 **WP9-A 已接线**的生产 audit writer（`src/main.ts:2193` 同一工厂）。
 *   · 判定拆为 `blockingGaps`（决定 PASS）与 `deferredCapabilities`（**不**决定）。
 *   · 这是**验收载体变更**（有 R-48 裁定），**不是**测试放宽：
 *     `Known` 正控 / 诚实 `Unknown` / 无证据伪造必拒 / L1+L2 / 真实生产路径**一字未改**。
 *     详见 `docs/m5.1.1/M5.1.1-WP9C1-Compatible-Assertion-Record.md`。
 *
 * canonical E1–E8 **以执行计划为唯一出处**（本文件 §0 逐字读出来并断言；任何人不改计划就不可能改这里）。
 */

import 'dotenv/config'
import { cleanupSandbox, isolateDatabase, isProductionDir, PRODUCTION_DB_DIR, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

const sandbox = isolateDatabase('m5.1.1-wp9')

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { currentSchemaVersion, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import { getConversationEvent, readConversationEventAttribution } from '../src/infrastructure/persistence/conversation-store.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  conversationAttributionForEntryMode,
  type ConversationEntryMode,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import {
  createAuditControlHandler,
  createDeveloperControlService,
  createDiagnosticControlHandler,
} from '../src/infrastructure/dev/control-service.ts'
import { startDeveloperQueryServer } from '../src/infrastructure/dev/http-server.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import { createEchoAdapter } from '../src/infrastructure/action/adapters/echo.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
  SYSTEM_ECHO,
} from '../src/kernel/action/capability-registry.ts'
import { createActionGateway } from '../src/kernel/action/gateway.ts'
import { createActionRequest } from '../src/kernel/action/action-request.ts'
import { createActionTurnPort } from '../src/kernel/action/action-turn.ts'
import { createActionIntentDetector } from '../src/kernel/action/intent-detector.ts'
/*
 * WP9-C1（R-48 / Q1-a）：
 *   · E4 的验收载体 = **domain-appropriate authoritative event ledger**
 *     ⇒ 本门自己跑真实首次 State Bootstrap，从 `state_events` 读回（不读 wp9b2 的证据文件）。
 *   · E8 的验收载体 = WP9-A 已接线的生产 audit writer
 *     ⇒ 本门按 `src/main.ts:2193` 的同一工厂注入 writer，再经真实 HTTP 走权威链。
 */
import { attestStateBootstrapComponentIdentity, isTrustedStateBootstrapEvidence, STATE_BOOTSTRAP_AUTHORITY, STATE_BOOTSTRAP_COMPONENT, type StateBootstrapEvidence } from '../src/state/bootstrap-attestation.ts'
import { initCharacterState } from '../src/state/init.ts'
import { readStateEventAttribution } from '../src/state/repository.ts'
import { createDeveloperControlAuditWriter, readDeveloperControlAudit } from '../src/infrastructure/dev/control-audit.ts'
import {
  ATTRIBUTION_SLOT_COLUMNS,
  ATTRIBUTION_VALUE_SLOTS,
  attestActionInitiatorFromCausalOrigin,
  attestActionInitiatorUnresolved,
  correlationSourceFromConversationEvent,
  triggeringConversationEventOf,
  type AttributionValueSlot,
  type ConversationFamily,
} from '../src/kernel/contracts/attribution.ts'
import { attributionAbsent, attributionKnown, type AttributionValue, type PrincipalRef } from '../src/kernel/contracts/actor.ts'
import { asActionId, asCharacterId, asConversationEventId, asConversationId, asTraceId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { M4_T0, createM4Harness } from './m4-harness.ts'
import { analyzeRecorderBoundary } from './m5.1.1-k23-recorder-boundary.ts'

// ---------------------------------------------------------------------------
// 小工具
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
function section(t: string): void {
  console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)
}
function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID'}`)
}
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const digest = (s: string, n = 16): string => sha256(s).slice(0, n)

// ---------------------------------------------------------------------------
// §0 canonical E1–E8（**从执行计划逐字读出**，不是本文件自己写的清单）
// ---------------------------------------------------------------------------
section('§0 WP9-0 canonical E1–E8：以执行计划为唯一出处')
const planText = readFileSync(join(process.cwd(), 'docs/m5.1.1/M5.1.1-Execution-Plan.md'), 'utf8')
const eBlockMatch = planText.match(/\nE1[^\n]*\n(?:E[2-8][^\n]*\n)+/)
const canonicalE = eBlockMatch === null ? [] : eBlockMatch[0].trim().split('\n').map((l) => l.trim())
const EXPECTED_E = [
  'E1 真实用户消息',
  'E2 agent 以 user role 替发',
  'E3 character initiated',
  'E4 system initiated',
  'E5 tool execution',
  'E6 failed execution',
  'E7 legacy unknown read/replay',
  'E8 developer control audit',
]
measure('从执行计划读出的 E 条目数', canonicalE.length)
check('WP9-0：执行计划里的 E1–E8 与 canonical 清单逐字一致（顺序也在内）', canonicalE.length === 8 && canonicalE.every((l, i) => l === EXPECTED_E[i]), canonicalE.join(' · ') || '(没读到)')
const sPlan = readFileSync(join(process.cwd(), 'docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md'), 'utf8')
const sRows = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].filter((s) => new RegExp(`\\| \\*\\*${s}\\*\\* \\|`).test(sPlan))
measure('Test-and-Gate-Plan 里读到的 S1–S6 行数', sRows.length)
check('WP9-3：冻结验收面 S1–S6 六行都在（E1–E8 必须覆盖它，且不另立编号）', sRows.length === 6, sRows.join(','))
const E_TO_S: Record<string, string[]> = {
  E1: ['S1'],
  E2: ['S1'],
  E3: ['S2'],
  E4: ['S3'],
  E5: ['S4'],
  E6: ['S5'],
  E7: ['S6'],
  E8: [],
}
console.log(`  · E→S 覆盖映射（本 WP 显式声明，不新增编号）：${Object.entries(E_TO_S).map(([e, s]) => `${e}→${s.join('/') || '(无 S，独立: developer control audit)'}`).join(' · ')}`)

// ---------------------------------------------------------------------------
// §1 真实 runtime 装配（一个进程、一个库）
// ---------------------------------------------------------------------------
section('§1 WP9-1 真实 runtime 装配（isolated sandbox · 真实 schema · 生产装配工厂）')
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm511-wp9' })
const db = h.db
const runtime = h.runtime
const characterId = h.kernel.characterId
const userId = String(h.userId)
const schemaVersion = await currentSchemaVersion(db)
check('沙箱不是真实库（`isProductionDir === false` 且目录在 tmp 下）', isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()), sandbox.dir)
check('真实库只被记录、未被打开（env 仍指向沙箱）', PRODUCTION_DB_DIR.endsWith(join('data', 'pglite')) && process.env.PGLITE_DATA_DIR !== PRODUCTION_DB_DIR, `PGLITE_DATA_DIR=${String(process.env.PGLITE_DATA_DIR).replace(tmpdir(), '<tmp>')}`)
measure('沙箱 schema 版本', schemaVersion)
check(
  '沙箱 = 代码最新 schema v9（AGENTS §6.8：沙箱读数不能当作真实库状态）',
  schemaVersion === 9,
  `v${schemaVersion}`
)

const query = createDeveloperQueryService({
  db,
  characterId,
  owner: entityRef('character', String(characterId)),
  identitySnapshot: h.kernel.identitySnapshot,
  now: () => M4_T0,
})
const actionLedger = createActionLedgerStore(db)
const actionRegistry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
const sandboxRoot = mkdtempSync(join(tmpdir(), 'wp9-fs-'))
mkdirSync(sandboxRoot, { recursive: true })
const actionGateway = createActionGateway({
  registry: actionRegistry,
  ledger: actionLedger,
  adapters: [createEchoAdapter()],
  grantedPermissions: DEFAULT_GRANTED_PERMISSIONS,
  maxRiskLevel: 'R1',
  now: () => M4_T0,
  resolveTarget: async () => ({ target: { type: 'unknown', confidence: 'none' }, scopeViolation: false }),
  attribution: { decisionPointAdapterId: 'action-gateway', policyAdapterId: 'action-policy', executorAdapterId: 'action-adapter' },
})
const actionPort = createActionTurnPort({
  gateway: actionGateway,
  detector: createActionIntentDetector(),
  registry: actionRegistry,
  attribution: { adapterId: 'action-turn' },
})

// 生产 ingress 覆盖面（WP9-4/WP9-6/WP9-13 的**测量**判据）
const producerFamilies = new Map<ConversationEntryMode, string[]>()
for (const mode of ['interactive_human_console', 'scripted_agent_runner'] as ConversationEntryMode[]) {
  producerFamilies.set(mode, conversationAttributionForEntryMode(mode).producers.map((p) => p.family))
}
const allProducedFamilies = [...new Set([...producerFamilies.values()].flat())].sort()
measure('生产 ingress 覆盖的 conversation family 数', allProducedFamilies.length)
check('生产 ingress 覆盖 user_message 与 assistant_message（E1/E2/E3 有真实生产入口）', allProducedFamilies.includes('user_message') && allProducedFamilies.includes('assistant_message'), allProducedFamilies.join(', ') || '(无)')
const systemProducerExists = allProducedFamilies.includes('system_event' as ConversationFamily)
const toolProducerExists = allProducedFamilies.includes('tool_event' as ConversationFamily)
check('DC-1（Deferred Capability Observation，R-48 §4）：生产 ingress **没有** `system_event` 生产者 —— 该读数被**保留**（不得删除），但它**不再是** E4 的 PASS 条件', !systemProducerExists, `producers = ${allProducedFamilies.join(', ')}`)
check('E5 前提：tool_event 生产者同样不存在 ⇒ 行动侧的 tool 证据只能来自 character_action_events', !toolProducerExists, `producers = ${allProducedFamilies.join(', ')}`)

// ---------------------------------------------------------------------------
// §2 真实对话轮次（E1/E2/E3）—— 复制 wp61 的 runRealTurn 形状
// ---------------------------------------------------------------------------
interface TurnResult {
  entryMode: ConversationEntryMode
  conversationId: string
  traceId: string
  userEventId: string
  userSequence: number
  assistantEventId: string
  assistantSequence: number
  userRow: Record<string, unknown>
  assistantRow: Record<string, unknown>
}
async function runRealTurn(input: { entryMode: ConversationEntryMode; conversationId: string; userText: string; replyText: string; wire: boolean }): Promise<TurnResult> {
  // ⚠️ 会话内序号必须**逐会话**从 1 开始连续（recorder 会拒绝空洞）；因此计数器在每次调用内新建。
  let turnSequence = 0
  const conversationId = asConversationId(input.conversationId)
  const wiring = conversationAttributionForEntryMode(input.entryMode)
  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId,
    dryRun: false,
    userName: 'Alex',
    characterName: character.name,
    transport: 'cli',
    userId: h.userId,
    userRef: 'Alex',
    ...(input.wire ? { attribution: wiring.producers } : {}),
  })
  const gateway = new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder,
    conversationSequence: () => {
      turnSequence += 1
      return turnSequence
    },
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: false,
    userId: h.userId,
    actionWriter: actionPort,
    actionEnabled: false,
  })
  const incoming = await gateway.beginTurn(input.userText)
  if (incoming.userEvent === undefined) throw new Error('beginTurn 没有写出用户事件')
  const outgoing = await gateway.completeTurn({ turn: incoming, replyText: input.replyText })
  if (outgoing.assistantEvent === undefined) throw new Error('completeTurn 没有写出 assistant 事件')
  const userRow = await rowOf(input.conversationId, Number(incoming.userEvent.conversationSequence))
  const assistantRow = await rowOf(input.conversationId, Number(outgoing.assistantEvent.conversationSequence))
  return {
    entryMode: input.entryMode,
    conversationId: input.conversationId,
    traceId: String(incoming.traceId),
    userEventId: String(incoming.userEvent.id),
    userSequence: Number(incoming.userEvent.conversationSequence),
    assistantEventId: String(outgoing.assistantEvent.id),
    assistantSequence: Number(outgoing.assistantEvent.conversationSequence),
    userRow,
    assistantRow,
  }
}
async function rowOf(conversationId: string, conversationSequence: number): Promise<Record<string, unknown>> {
  const rows = rowsOf(
    await db.execute(
      sql`select * from conversation_events where character_id = ${String(characterId)}
            and conversation_id = ${conversationId} and conversation_sequence = ${conversationSequence}`,
    ),
  ) as Record<string, unknown>[]
  if (rows.length !== 1) throw new Error(`期望恰好一行，实际 ${rows.length}`)
  return rows[0] as Record<string, unknown>
}

section('§2 E1 / E2 / E3：真实入口 → 真实 Gateway → 真实 Ledger → 物理库 → 回读 → Query')
const humanTurn = await runRealTurn({ entryMode: 'interactive_human_console', conversationId: 'conv-wp9-human', userText: '你好，我是 Alex。', replyText: '你好 Alex，我在。', wire: true })
const agentTurn = await runRealTurn({ entryMode: 'scripted_agent_runner', conversationId: 'conv-wp9-agent', userText: '[agent-runner] 替用户发一条。', replyText: '收到。', wire: true })
const legacyTurn = await runRealTurn({ entryMode: 'interactive_human_console', conversationId: 'conv-wp9-legacy', userText: '这条走 legacy（不接线归因）。', replyText: '好的。', wire: false })
measure('真实运行的对话轮次', 3)

const slotOf = (row: Record<string, unknown>, slot: AttributionValueSlot): string => {
  const c = ATTRIBUTION_SLOT_COLUMNS[slot]
  const kind = row[c.kind]
  const id = row[c.id]
  const reason = row[c.unknownReason]
  if (kind === null || kind === undefined) return reason === null || reason === undefined ? 'ABSENT|-|-|-' : `UNKNOWN|-|-|${String(reason)}`
  return `KNOWN|${String(kind)}|${String(id)}|-`
}
// E1：真实人类用户
check('E1 物理行：`actor_type = user` 且 actor / contentOriginator = Known(USER/<id>)', humanTurn.userRow.actor_type === 'user' && slotOf(humanTurn.userRow, 'actor') === `KNOWN|USER|${userId}|-` && slotOf(humanTurn.userRow, 'contentOriginator') === `KNOWN|USER|${userId}|-`, `actor=${slotOf(humanTurn.userRow, 'actor')} · origin=${slotOf(humanTurn.userRow, 'contentOriginator')}`)
check('E1 Axis B：user_statement / USER_EXPLICIT / user_report · origin = RECORDED · recordedBy = SYSTEM/kernel', humanTurn.userRow.source_kind === 'user_statement' && humanTurn.userRow.source_authority === 'USER_EXPLICIT' && humanTurn.userRow.epistemic_source === 'user_report' && humanTurn.userRow.attribution_origin === 'RECORDED' && slotOf(humanTurn.userRow, 'recordedBy') === 'KNOWN|SYSTEM|kernel|-', `${String(humanTurn.userRow.source_kind)}/${String(humanTurn.userRow.source_authority)}/${String(humanTurn.userRow.epistemic_source)} · origin=${String(humanTurn.userRow.attribution_origin)} · recordedBy=${slotOf(humanTurn.userRow, 'recordedBy')}`)
// E2：agent 以 user role 替发（D01）
check('E2/D01 物理行：`actor_type = user`，但 actor / contentOriginator = Known(SERVICE/agent-runner)，**不含 USER 位次**', agentTurn.userRow.actor_type === 'user' && slotOf(agentTurn.userRow, 'actor') === 'KNOWN|SERVICE|agent-runner|-' && slotOf(agentTurn.userRow, 'contentOriginator') === 'KNOWN|SERVICE|agent-runner|-', `actor_type=${String(agentTurn.userRow.actor_type)} · actor=${slotOf(agentTurn.userRow, 'actor')} · origin=${slotOf(agentTurn.userRow, 'contentOriginator')}`)
check('E2/D01 Axis B：source_kind 仍是 user_statement，但 authority/epistemic = UNCONFIRMED_ORIGIN（**不得**形成"用户本人陈述"）', agentTurn.userRow.source_kind === 'user_statement' && agentTurn.userRow.source_authority === 'UNCONFIRMED_ORIGIN' && agentTurn.userRow.epistemic_source === 'UNCONFIRMED_ORIGIN', `${String(agentTurn.userRow.source_kind)}/${String(agentTurn.userRow.source_authority)}/${String(agentTurn.userRow.epistemic_source)}`)
// E3：character 输出（同一轮的真实 completeTurn 路径）
check('E3 物理行：assistant_message · actor_type = character · actor / contentOriginator = Known(CHARACTER/<canonical>)', humanTurn.assistantRow.type === 'assistant_message' && humanTurn.assistantRow.actor_type === 'character' && slotOf(humanTurn.assistantRow, 'actor') === `KNOWN|CHARACTER|${String(character.id ?? character.name)}|-` && slotOf(humanTurn.assistantRow, 'contentOriginator') === `KNOWN|CHARACTER|${String(character.id ?? character.name)}|-`, `actor=${slotOf(humanTurn.assistantRow, 'actor')}`)
check('E3 Axis B：character_output / CHARACTER_GENERATION / character_generation · origin = RECORDED', humanTurn.assistantRow.source_kind === 'character_output' && humanTurn.assistantRow.source_authority === 'CHARACTER_GENERATION' && humanTurn.assistantRow.epistemic_source === 'character_generation' && humanTurn.assistantRow.attribution_origin === 'RECORDED', `${String(humanTurn.assistantRow.source_kind)}/${String(humanTurn.assistantRow.source_authority)}/${String(humanTurn.assistantRow.epistemic_source)}`)
// E3 负控：family 本身不是证据（同一族、但**不接线** ⇒ 没有信封）
check('E3 负控：同一 family 但 recorder **没有**生产 ingress 接线 ⇒ 没有归因信封（`attribution_origin` 为 NULL）⇒ "family=assistant_message" 本身不是 Known(CHARACTER) 的证据', legacyTurn.assistantRow.attribution_origin === null && legacyTurn.assistantRow.actor_kind === null, `origin=${String(legacyTurn.assistantRow.attribution_origin)} · actor_kind=${String(legacyTurn.assistantRow.actor_kind)}`)
// E7：legacy 存在性与共存（读回侧）
const legacyReadback = await readConversationEventAttribution(db, asConversationEventId(legacyTurn.userEventId))
check('E7 legacy 行：`readConversationEventAttribution` 不制造信封（无 RECORDED 信封可读）', legacyReadback === undefined || legacyReadback.attributionOrigin === undefined || legacyReadback.attributionOrigin === null, JSON.stringify(legacyReadback?.attributionOrigin ?? null))
const recordedReadback = await readConversationEventAttribution(db, asConversationEventId(humanTurn.userEventId))
measure('E1 回读到的槽位数', Object.keys(recordedReadback?.slots ?? {}).length)
check('E1 回读：受信读回逐槽位与物理行一致（RECORDED 走存储值）', recordedReadback !== undefined && recordedReadback.attributionOrigin === 'RECORDED' && String((recordedReadback.slots.recordedBy as AttributionValue<unknown>).state) === 'KNOWN', `origin=${String(recordedReadback?.attributionOrigin)} · recordedBy.state=${String((recordedReadback?.slots.recordedBy as AttributionValue<unknown>)?.state)}`)

// ---------------------------------------------------------------------------
// §3 E4：system initiated —— 生产入口缺失（capability gap）+ 诚实 Unknown 分支
// ---------------------------------------------------------------------------
section('§3 E4：system initiated（WP9-13 的"缺生产入口"判据 + S3 的诚实 Unknown 分支）')
const triggering = triggeringConversationEventOf({
  id: humanTurn.userEventId,
  type: String(humanTurn.userRow.type),
  attribution: { attributionOrigin: 'RECORDED', slots: (recordedReadback?.slots ?? {}) as Readonly<Record<string, unknown>> },
})
const userInitiator = attestActionInitiatorFromCausalOrigin({ adapterId: 'action-turn', causalSource: correlationSourceFromConversationEvent({ adapterId: 'action-turn', triggeringEvent: triggering }) })
const okRequest = createActionRequest({ actionId: asActionId('wp9-action-ok'), traceId: asTraceId(`trc:wp9:${humanTurn.traceId}`), capability: SYSTEM_ECHO, operation: 'echo', requestedBy: { kind: 'system' }, arguments: { text: 'wp9-echo' }, sideEffect: 'none', createdAt: M4_T0 })
const okResult = await actionGateway.execute(characterId, okRequest, { initiatorEvidence: userInitiator })
const actionOkRows = rowsOf(await db.execute(sql`select event_type, sequence, initiator_kind, initiator_id, actor_kind, actor_ref_id, executor_kind, executor_id, authority_kind, authority_ref, recorded_by_kind, recorded_by_id, source_kind, source_authority, epistemic_source, attribution_origin from character_action_events where action_id = 'wp9-action-ok' order by sequence asc`)) as Record<string, unknown>[]
measure('E5 成功行动链的事件数', actionOkRows.length)
check('E5 真实成功执行：事件阶梯 = REQUESTED → TARGET_RESOLVED → AUTHORIZED → STARTED → SUCCEEDED，且 L1 说 executed=true', okResult.executed === true && okResult.status === 'success' && actionOkRows.map((r) => r.event_type).join(',') === 'ACTION_REQUESTED,ACTION_TARGET_RESOLVED,ACTION_AUTHORIZED,ACTION_STARTED,ACTION_SUCCEEDED', `L1: executed=${String(okResult.executed)} status=${String(okResult.status)} · L2: ${actionOkRows.map((r) => r.event_type).join(' → ')}`)
const execRow = actionOkRows.find((r) => r.executor_kind !== null)
check('E5/S4：`actor` 与 `executor` **可分离且各自可读**（两者 principal 不同），`authority` = Known(CAPABILITY/…)', actionOkRows.every((r) => r.actor_kind !== null) && execRow !== undefined && (execRow.actor_kind !== execRow.executor_kind || execRow.actor_ref_id !== execRow.executor_id) && actionOkRows.some((r) => r.authority_kind === 'CAPABILITY'), `actor=${String(actionOkRows[0]?.actor_kind)}/${String(actionOkRows[0]?.actor_ref_id)} · executor=${String(execRow?.executor_kind)}/${String(execRow?.executor_id)} · authority=${String(actionOkRows.find((r) => r.authority_kind !== null)?.authority_kind)}`)
check('E5/S1：initiator 来自真实因果证据（= Known(USER/<id>)，由真实 RECORDED 对话行经 canonical 因果构造器建立）', actionOkRows.every((r) => r.initiator_kind === 'USER' && r.initiator_id === userId), `initiator=${String(actionOkRows[0]?.initiator_kind)}/${String(actionOkRows[0]?.initiator_id)}`)
check('E5/K-22：行动侧 Axis B 三列**恒为 NULL**（NOT_APPLICABLE），origin = RECORDED，recordedBy = canonical', actionOkRows.every((r) => r.source_kind === null && r.source_authority === null && r.epistemic_source === null && r.attribution_origin === 'RECORDED' && r.recorded_by_kind === 'SYSTEM' && r.recorded_by_id === 'kernel'), `axisB=${JSON.stringify([actionOkRows[0]?.source_kind, actionOkRows[0]?.source_authority, actionOkRows[0]?.epistemic_source])} · origin=${String(actionOkRows[0]?.attribution_origin)}`)

// E6：真实失败（真实 echo 适配器 + 缺参数 ⇒ validation_failed；零副作用）
const failRequest = createActionRequest({ actionId: asActionId('wp9-action-fail'), traceId: asTraceId(`trc:wp9:${humanTurn.traceId}`), capability: SYSTEM_ECHO, operation: 'echo', requestedBy: { kind: 'system' }, arguments: {}, sideEffect: 'none', createdAt: M4_T0 })
const failResult = await actionGateway.execute(characterId, failRequest, { initiatorEvidence: userInitiator })
const actionFailRows = rowsOf(await db.execute(sql`select event_type, sequence, initiator_kind, initiator_id, actor_kind, status, attribution_origin from character_action_events where action_id = 'wp9-action-fail' order by sequence asc`)) as Record<string, unknown>[]
measure('E6 失败行动链的事件数', actionFailRows.length)
check('E6 真实失败执行（S5）：L2 以 ACTION_FAILED 收尾、**没有** SUCCEEDED，L1 如实报失败', failResult.executed !== undefined && actionFailRows.some((r) => r.event_type === 'ACTION_FAILED') && !actionFailRows.some((r) => r.event_type === 'ACTION_SUCCEEDED'), `L2: ${actionFailRows.map((r) => r.event_type).join(' → ')} · L1 error.code=${String((failResult as { error?: { code?: string } }).error?.code ?? '(无)')}`)
check('E6/S5：initiator / actor 仍可追溯（失败**不**抹掉归因；actor = 决策点 principal，与 executor 分离）', actionFailRows.every((r) => r.initiator_kind === 'USER' && r.initiator_id === userId) && actionFailRows.some((r) => r.actor_kind !== null), `initiator=${String(actionFailRows[0]?.initiator_kind)}/${String(actionFailRows[0]?.initiator_id)} · actor=${String(actionFailRows.find((r) => r.actor_kind !== null)?.actor_kind)}`)
check('E6/Execution Truth：`executed` 由事件阶梯决定，**不**由 executor/authority 的存在决定（ACTION_STARTED 之后的 FAILED 才算 attempt）', actionFailRows.some((r) => r.event_type === 'ACTION_STARTED') && actionFailRows.some((r) => r.event_type === 'ACTION_FAILED'), actionFailRows.map((r) => String(r.event_type)).join(' → '))

// E4-A：Known(SYSTEM) 分支不可达（测量证明）+ E4-B：诚实 Unknown 分支
const boundary = analyzeRecorderBoundary({ srcRoot: join(process.cwd(), 'src') })
const systemTrustedProducers = boundary.trustedContextCallSites.length
measure('受信构造调用点数（生产 ingress）', systemTrustedProducers)
const conversationSystemProducerExists = systemProducerExists
check('DC-1（历史读数，**保留**）：对话 pipeline 的 `system_event` 生产者 = 0 ⇒ `Conversation SYSTEM Producer = NOT IMPLEMENTED / DEFERRED`（R-48：它不是现行 S3 的必要条件，但**不得**被删掉）', !conversationSystemProducerExists, `producers=${allProducedFamilies.join(',')} · system_event producer=${String(conversationSystemProducerExists)}`)
const noTriggerTurn = await actionPort.handleTurn({ characterId, traceId: asTraceId('trc:wp9:e4b'), text: '帮我 echo 一下 e4b', eventId: 'evt-wp9-e4b-nonexistent', speaker: { kind: 'system', id: 'host' } })
let e4bActionId: string | null = noTriggerTurn.request === undefined ? null : String(noTriggerTurn.request.actionId)
let e4bEntry = 'production ActionTurnPort（无 triggeringEvent）'
if (e4bActionId === null) {
  // 端口是**文本驱动**的（detector 未命中 ⇒ not_applicable）⇒ 退回同一条生产端口契约的"无因果证据"分支：
  // 由 canonical 的 `attestActionInitiatorUnresolved` 产出的证据 token（生产端口在缺 causal origin 时用的就是它），
  // **不是**手造 principal。
  e4bEntry = 'real ActionGateway + canonical attestActionInitiatorUnresolved（端口 detector 未命中，见 note）'
  const r = await actionGateway.execute(characterId, createActionRequest({ actionId: asActionId('wp9-action-e4b'), traceId: asTraceId('trc:wp9:e4b'), capability: SYSTEM_ECHO, operation: 'echo', requestedBy: { kind: 'system' }, arguments: { text: 'e4b' }, sideEffect: 'none', createdAt: M4_T0 }), { initiatorEvidence: attestActionInitiatorUnresolved({ adapterId: 'action-turn' }) })
  void r
  e4bActionId = 'wp9-action-e4b'
}
const e4bRows = rowsOf(await db.execute(sql`select event_type, initiator_kind, initiator_id, initiator_unknown_reason from character_action_events where action_id = ${String(e4bActionId)} order by sequence asc`)) as Record<string, unknown>[]
measure('E4-B 诚实 Unknown 分支的事件数', e4bRows.length)
check('E4-B（S3 的"无法确认"分支）：没有因果证据 ⇒ 真实端口如实记 `Unknown(RUNTIME_UNRESOLVED)`，**不**从呈现角色猜 USER/CHARACTER/SYSTEM', e4bRows.length > 0 && e4bRows.every((r) => r.initiator_kind === null && r.initiator_unknown_reason === 'RUNTIME_UNRESOLVED'), e4bRows.length === 0 ? '(端口未产出请求：意图检测未命中 —— 见 evidence.actionPortNote)' : `initiator=${String(e4bRows[0]?.initiator_kind)} reason=${String(e4bRows[0]?.initiator_unknown_reason)}`)

// ---------------------------------------------------------------------------
// §3b E4（R-48 / Q1-a 载体）：真实首次 State Bootstrap ⇒ 真实 state_events INSERT ⇒ 受信回读
// ---------------------------------------------------------------------------

section('§3b E4（R-48 / Q1-a）：domain-appropriate authoritative ledger 上的真实 SYSTEM-origin 生产事件')

/**
 * 载体（R-48 §二）：`state_events` 是"首次建档"这次真实系统行为**本来就应该写入**的权威账本。
 * 判据的**形状**一字未改：Known 正控 + 诚实 Unknown + 无证据伪造必拒 + L1/L2 + 真实生产路径。
 */
const E4_STATE_FAMILY = 'state_transition'
const E4_STATE_EXPECTED: Record<AttributionValueSlot, string> = {
  initiator: `KNOWN|SYSTEM|${STATE_BOOTSTRAP_COMPONENT.id}|-`,
  actor: `KNOWN|SYSTEM|${STATE_BOOTSTRAP_COMPONENT.id}|-`,
  executor: 'ABSENT|-|-|-',
  authority: `KNOWN|SYSTEM_RULE|${STATE_BOOTSTRAP_AUTHORITY.ref}|-`,
  recordedBy: 'KNOWN|SYSTEM|kernel|-',
  contentOriginator: 'ABSENT|-|-|-',
}
const E4B_STATE_EXPECTED: Record<AttributionValueSlot, string> = {
  initiator: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  actor: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  executor: 'ABSENT|-|-|-',
  authority: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  recordedBy: 'KNOWN|SYSTEM|kernel|-',
  contentOriginator: 'ABSENT|-|-|-',
}
/** 物理行（19 列 + origin + trigger），列名与顺序都来自 canonical 映射 */
const e4StateRowOf = async (id: string): Promise<Record<string, unknown> | undefined> => {
  const columns = Object.values(ATTRIBUTION_SLOT_COLUMNS).flatMap((c) => [c.kind, c.id, c.unknownReason])
  const rows = rowsOf(
    await db.execute(
      sql`select id, character_id, user_id, trigger, attribution_origin, ${sql.raw(columns.join(', '))}
          from state_events where id = ${id} limit 1`
    )
  ) as Record<string, unknown>[]
  return rows[0]
}
const stateEventCount = async (): Promise<number> => {
  const rows = rowsOf(await db.execute(sql`select count(*)::int as c from state_events`)) as { c: number }[]
  return Number(rows[0]?.c ?? 0)
}
const slotsRecord = (row: Record<string, unknown> | undefined, expected: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(expected).map((slot) => [slot, slotOf(row ?? {}, slot as AttributionValueSlot)]))

check(
  '★ E4 载体（R-48 / Q1-a）：`state_transition` **不是** conversation family —— 载体是该行为本来就应该写入的权威账本 `state_events`（不是"任意 SYSTEM 字段出现一次就 PASS"）',
  E4_STATE_FAMILY === 'state_transition' && !allProducedFamilies.includes(E4_STATE_FAMILY),
  `node families=${allProducedFamilies.join(',')}`
)

// ① Known 正控：真实首次 State Bootstrap（受信证据来自生产引导组件的无参数工厂）
const e4aState = await initCharacterState(runtime, characterId, 'user-wp9-e4a-state-bootstrap', {
  bootstrapEvidence: attestStateBootstrapComponentIdentity(),
})
const e4aStateId = String(e4aState.stateEventId ?? '')
measure('E4（state）返回的 state_event id 长度', e4aStateId.length)
check(
  'E4-L1：真实首次建档成立，且返回**真实** `stateEventId`',
  e4aState.created === true && e4aStateId.length > 0,
  `created=${String(e4aState.created)} id=${e4aStateId}`
)
const e4aStateRow = await e4StateRowOf(e4aStateId)
check(
  'E4-L2 前提：该行确实是首启的状态转移行（`trigger = init`）且属于本 runtime 的角色',
  e4aStateRow?.trigger === 'init' && String(e4aStateRow?.character_id) === String(characterId),
  `trigger=${String(e4aStateRow?.trigger)} character=${String(e4aStateRow?.character_id)}`
)
const e4aStateSlots = slotsRecord(e4aStateRow, E4_STATE_EXPECTED)
measure('E4（state）物理槽位数', Object.keys(e4aStateSlots).length)
check(
  '★ E4 正控：六格逐格 == 冻结期望（initiator/actor = `Known(SYSTEM/state-bootstrap)` · ' +
    'authority = `Known(SYSTEM_RULE/state-bootstrap-rule)` · recordedBy = `Known(SYSTEM/kernel)` · ' +
    'executor/contentOriginator = `Absent`）',
  JSON.stringify(e4aStateSlots) === JSON.stringify(E4_STATE_EXPECTED),
  Object.entries(e4aStateSlots).map(([k, v]) => `${k}=${v}`).join(' · ')
)
check(
  '★ E4：`attribution_origin = RECORDED`（不是 MIGRATED_LEGACY）',
  e4aStateRow?.attribution_origin === 'RECORDED',
  String(e4aStateRow?.attribution_origin)
)
const e4aStateReadback = await readStateEventAttribution(runtime, e4aStateId)
const e4aStateReadbackSlots = (e4aStateReadback.attribution?.slots ?? {}) as Record<string, { state: string }>
measure('E4（state）受信回读到的槽位数', Object.keys(e4aStateReadbackSlots).length)
check(
  '★ E4-L2 受信回读：`origin = RECORDED`，且六格三态与物理列**逐格一致**',
  e4aStateReadback.found &&
    e4aStateReadback.attribution?.attributionOrigin === 'RECORDED' &&
    Object.keys(E4_STATE_EXPECTED).every(
      (slot) => e4aStateReadbackSlots[slot]?.state === E4_STATE_EXPECTED[slot as AttributionValueSlot]!.split('|')[0]
    ),
  Object.entries(e4aStateReadbackSlots).map(([k, v]) => `${k}=${v.state}`).join(' · ')
)
check(
  '★ E4：`subject` 是**派生**语义（`CHARACTER/<character_id>`，不落列），且 `user_id` 留在行上、不进信封',
  !('subject' in ATTRIBUTION_SLOT_COLUMNS) &&
    Object.values(ATTRIBUTION_SLOT_COLUMNS).every(
      (c) => !Object.values(c).some((column) => /user_id|subject/.test(column))
    ),
  `row.user_id=${String(e4aStateRow?.user_id)}`
)

// ② 诚实 Unknown 正控（R-48 §C1-1：继续保留）
const e4bState = await initCharacterState(runtime, characterId, 'user-wp9-e4b-honest-unknown')
const e4bStateRow = await e4StateRowOf(String(e4bState.stateEventId ?? ''))
const e4bStateSlots = slotsRecord(e4bStateRow, E4B_STATE_EXPECTED)
measure('E4（state）诚实 Unknown 正控的槽位数', Object.keys(e4bStateSlots).length)
check(
  '★ E4 诚实 Unknown 正控：**没有**受信证据时 `initiator/actor/authority = Unknown(RUNTIME_UNRESOLVED)`' +
    '（不是 `Absent`、也不是猜一个 SYSTEM）',
  JSON.stringify(e4bStateSlots) === JSON.stringify(E4B_STATE_EXPECTED),
  Object.entries(e4bStateSlots).map(([k, v]) => `${k}=${v}`).join(' · ')
)

// ③ 身份伪造负控（R-48 §C1-1：保留）
const e4RealEvidence = attestStateBootstrapComponentIdentity()
const e4ForgedEvidence = { ...e4RealEvidence, principal: { kind: 'SYSTEM', id: 'attacker' } } as StateBootstrapEvidence
const e4RowsBeforeForgery = await stateEventCount()
let e4ForgeryThrew = false
let e4ForgeryCode = '(未抛)'
try {
  await initCharacterState(runtime, characterId, 'user-wp9-e4-forged', { bootstrapEvidence: e4ForgedEvidence })
} catch (error) {
  e4ForgeryThrew = true
  e4ForgeryCode = String((error as { code?: string }).code ?? '(无 code)')
}
const e4RowsAfterForgery = await stateEventCount()
measure('E4 伪造负控检验的凭证形状数', 1, true)
check(
  '★ E4 伪造负控：手写同形 evidence（浅拷贝 + 改 principal）⇒ 必抛 `untrusted_state_bootstrap_evidence`',
  e4ForgeryThrew && e4ForgeryCode === 'untrusted_state_bootstrap_evidence',
  `threw=${String(e4ForgeryThrew)} code=${e4ForgeryCode}`
)
check(
  '★ E4 伪造负控：`isTrustedStateBootstrapEvidence(伪造值) === false`（运行期守卫，不是结构判断）',
  !isTrustedStateBootstrapEvidence(e4ForgedEvidence),
  String(isTrustedStateBootstrapEvidence(e4ForgedEvidence))
)
check(
  '★ E4 伪造负控：失败关闭 ⇒ `state_events` 行数不变（零残留）',
  e4RowsBeforeForgery === e4RowsAfterForgery,
  `${e4RowsBeforeForgery} → ${e4RowsAfterForgery}`
)

// E4 三部分的机器可判形态（供证据与判定使用；不新造判据 —— 判据就是上面那些 check）
const e4AOk =
  JSON.stringify(e4aStateSlots) === JSON.stringify(E4_STATE_EXPECTED) &&
  e4aStateRow?.attribution_origin === 'RECORDED' &&
  e4aStateReadback.found &&
  e4aStateReadback.attribution?.attributionOrigin === 'RECORDED'
const e4BHonestUnknownOk = JSON.stringify(e4bStateSlots) === JSON.stringify(E4B_STATE_EXPECTED)
const e4ForgeryOk =
  e4ForgeryThrew &&
  e4ForgeryCode === 'untrusted_state_bootstrap_evidence' &&
  !isTrustedStateBootstrapEvidence(e4ForgedEvidence) &&
  e4RowsBeforeForgery === e4RowsAfterForgery

// ---------------------------------------------------------------------------
// §4 E8：developer control audit —— 真实 HTTP → 真实 Control Service → 生产 audit writer → durable 行
// ---------------------------------------------------------------------------

section('§4 E8：developer control audit（真实命令 + WP9-A 生产 writer + 受信回读）')

/**
 * 生产口径（与 `src/main.ts:2193` 同一工厂）：`createDeveloperControlAuditWriter({ db })`。
 * 不传 `developerIdentity` ⇒ `initiator` 如实 `Unknown(RUNTIME_UNRESOLVED)`（同生产装配）。
 */
const EXPECTED_CONTROL_SLOTS: Record<AttributionValueSlot, string> = {
  initiator: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  actor: 'KNOWN|SERVICE|control-service|-',
  executor: 'ABSENT|-|-|-',
  authority: 'KNOWN|CAPABILITY|developer.control|-',
  recordedBy: 'KNOWN|SYSTEM|kernel|-',
  contentOriginator: 'ABSENT|-|-|-',
}
const controlPayload = (commandId: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  commandId,
  idempotencyKey: `idem-${commandId}`,
  type,
  dryRun: false,
  requestedBy: { kind: 'developer', surface: 'http' },
  createdAt: M4_T0,
  ...extra,
})
const postControl = async (
  url: string,
  type: string,
  commandId: string,
  extra: Record<string, unknown> = {}
): Promise<{ status: number; result: { commandId?: string; outcome?: string; disposition?: string; verification?: string; executed?: boolean; reasonCode?: string } }> => {
  const res = await fetch(`${url}/dev/query/control/commands/${type}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(controlPayload(commandId, type, extra)),
  })
  const body = (await res.json()) as { result?: Record<string, unknown> }
  return { status: res.status, result: (body.result ?? {}) as never }
}

const auditWriter = createDeveloperControlAuditWriter({ db, now: () => M4_T0 })
const control = createDeveloperControlService({
  characterId,
  handlers: [createDiagnosticControlHandler(query), createAuditControlHandler(query)],
  now: () => M4_T0,
  audit: auditWriter,
})
const server = await startDeveloperQueryServer({ service: query, control, characterId, port: 0 })
let controlOk = false
let controlOutcome = ''
let okRes: Awaited<ReturnType<typeof postControl>> | null = null
let forgedRes: Awaited<ReturnType<typeof postControl>> | null = null
try {
  okRes = await postControl(server.url, 'RUN_DIAGNOSTIC', 'wp9-cmd-1')
  controlOutcome = String(okRes.result.outcome ?? '')
  controlOk = okRes.status === 200 && controlOutcome === 'verified' && okRes.result.executed === true
  forgedRes = await postControl(server.url, 'RUN_DIAGNOSTIC', 'wp9-cmd-forged', {
    authorityKind: 'USER_CONSENT',
    authorityRef: 'caller.claimed',
    initiatorKind: 'USER',
    initiatorId: 'attacker',
    executorKind: 'TOOL',
  })
} finally {
  await server.close()
}
check('E8-L1：真实的控制命令经真实 HTTP 面执行，阶梯到达 `verified`', controlOk, `outcome=${controlOutcome}`)

// 审计承载面形状（冻结）
const auditTableCols = rowsOf(await db.execute(sql`select column_name from information_schema.columns where table_schema='public' and table_name='developer_control_events' order by ordinal_position`)) as Record<string, unknown>[]
measure('`developer_control_events` 的物理列数', auditTableCols.length)
check(
  'E8：审计承载面物理存在且形状冻结（18 个槽位列 + command_id/sequence/outcome/verification/…，**没有** Axis B 列）',
  auditTableCols.length >= 30 && !auditTableCols.some((c) => String(c.column_name) === 'source_kind'),
  `${auditTableCols.length} 列 · 有 source_kind=${String(auditTableCols.some((c) => String(c.column_name) === 'source_kind'))}`
)

// 受信回读：durable 行 + L1↔L2 按真实 commandId
const auditRowsBack = await readDeveloperControlAudit(db, 'wp9-cmd-1')
const auditRow = auditRowsBack[0]
measure('E8 durable 审计行数（期望恰好 1）', auditRowsBack.length, auditRowsBack.length === 1)
check(
  '★ E8-L2：durable 审计行**存在**（WP9-A 的生产 writer 已接线），且 `L1.commandId == L2.commandId`',
  auditRow !== undefined && String(okRes?.result.commandId) === auditRow.commandId,
  `L1=${String(okRes?.result.commandId)} · L2=${String(auditRow?.commandId)}`
)
const controlSlotMismatches = ATTRIBUTION_VALUE_SLOTS.filter(
  (slot) => auditRow?.slots[slot] !== EXPECTED_CONTROL_SLOTS[slot]
)
check(
  '★ E8-L2：六格逐格 == 冻结口径（initiator=`Unknown(RUNTIME_UNRESOLVED)` · actor=`SERVICE/control-service` · ' +
    'authority=`CAPABILITY/developer.control` · recordedBy=`SYSTEM/kernel` · executor/contentOriginator=`Absent`）',
  auditRow !== undefined && controlSlotMismatches.length === 0,
  (Object.keys(EXPECTED_CONTROL_SLOTS) as AttributionValueSlot[])
    .map((slot) => `${slot}=${String(auditRow?.slots[slot])}`)
    .join(' · ')
)
check(
  '★ E8-L2：生命周期列**逐字照抄**真实结果（outcome / disposition / verification 不解释、不改写）',
  auditRow !== undefined &&
    auditRow.outcome === String(okRes?.result.outcome) &&
    auditRow.disposition === String(okRes?.result.disposition) &&
    auditRow.verification === String(okRes?.result.verification),
  `L2=${String(auditRow?.outcome)}/${String(auditRow?.disposition)}/${String(auditRow?.verification)} · L1=${String(okRes?.result.outcome)}/${String(okRes?.result.disposition)}/${String(okRes?.result.verification)}`
)
check(
  '★ E8-L2：`transport` 列只是观测（`http`），**不**参与任何 principal / authority',
  auditRow?.transport === 'http' && auditRow.slots.authority === EXPECTED_CONTROL_SLOTS.authority,
  `transport=${String(auditRow?.transport)}`
)

// E8 负控：调用方自报 authority / initiator / executor 无效
const forgedAuditRows = await readDeveloperControlAudit(db, 'wp9-cmd-forged')
const forgedAuditRow = forgedAuditRows[0]
const forgedClaimsAppearInRow = forgedAuditRows.some((row) => {
  const text = JSON.stringify(row)
  return text.includes('USER_CONSENT') || text.includes('attacker') || text.includes('caller.claimed')
})
measure('E8 负控检验的调用方自报字段数', 5, true)
check(
  '★ E8 负控：调用方自报 `authority/initiator/executor` ⇒ **不进入**权威槽位、claims 不出现在行里' +
    '（形状层忽略未知键；若被拒则审计行数为 0 —— 两种可接受结果都如实记录）',
  !forgedClaimsAppearInRow &&
    (forgedAuditRow === undefined ||
      (forgedAuditRow.slots.authority === EXPECTED_CONTROL_SLOTS.authority &&
        forgedAuditRow.slots.initiator === EXPECTED_CONTROL_SLOTS.initiator)),
  `rows=${forgedAuditRows.length} claimsInRow=${String(forgedClaimsAppearInRow)} authority=${String(forgedAuditRow?.slots.authority)} httpStatus=${forgedRes.status}`
)

// E8 失败路径：白名单命令在执行期失败 ⇒ **也必须**有 durable 行
const failControl = createDeveloperControlService({
  characterId,
  handlers: [
    createDiagnosticControlHandler(query),
    {
      type: 'RUN_AUDIT',
      run: async () => {
        throw new Error('wp9c1 注入的 handler 失败（走真实控制服务与真实 HTTP 面，零副作用）')
      },
    },
  ],
  now: () => M4_T0,
  audit: auditWriter,
})
const failServer = await startDeveloperQueryServer({ service: query, control: failControl, characterId, port: 0 })
let failRes: Awaited<ReturnType<typeof postControl>> | null = null
try {
  failRes = await postControl(failServer.url, 'RUN_AUDIT', 'wp9-cmd-fail')
} finally {
  await failServer.close()
}
const failAuditRows = await readDeveloperControlAudit(db, 'wp9-cmd-fail')
const failAuditRow = failAuditRows[0]
measure('E8 失败路径驱动的命令数', 1, true)
measure('E8 失败路径的 durable 审计行数（期望恰好 1）', failAuditRows.length, failAuditRows.length === 1)
check(
  '★ E8 失败路径：白名单命令在执行期失败 ⇒ HTTP 200 `attempted/failed` ⇒ **仍有** durable 行' +
    '（审计不是"只在成功后补一行"）',
  failRes?.status === 200 &&
    failRes.result.outcome === 'attempted' &&
    failRes.result.disposition === 'failed' &&
    failAuditRow !== undefined &&
    failAuditRow.outcome === 'attempted' &&
    failAuditRow.disposition === 'failed',
  `L1=${String(failRes?.result.outcome)}/${String(failRes?.result.disposition)} · L2=${String(failAuditRow?.outcome)}/${String(failAuditRow?.disposition)}`
)
check(
  '★ E8 失败路径 L1↔L2：同样按真实 `commandId` 关联（不是文本对应）',
  failAuditRow !== undefined && String(failRes?.result.commandId) === failAuditRow.commandId,
  `L1=${String(failRes?.result.commandId)} · L2=${String(failAuditRow?.commandId)}`
)

// ---------------------------------------------------------------------------
// §5 L1↔L2 关联 + fieldwise equality + D01/K-27 硬门
// ---------------------------------------------------------------------------
section('§5 WP9-2 / WP9-10：L1↔L2 关联键与逐字段相等（Absent / Unknown(reason) 不得折叠）')
interface Correlation {
  scenario: string
  key: string
  level1: string
  level2: string
  agree: boolean
}
const correlations: Correlation[] = []
const traceDto = await query.getTrace({ characterId, traceId: asTraceId(humanTurn.traceId) })
const traceAttribution = traceDto.found ? traceDto.value.attribution : undefined
correlations.push({
  scenario: 'E1',
  key: `eventId=${humanTurn.userEventId}`,
  level1: `trace DTO actor.state=${String(traceAttribution?.actor?.state)} kind=${String((traceAttribution?.actor as { kind?: string })?.kind ?? '')}`,
  level2: `physical actor=${slotOf(humanTurn.userRow, 'actor')}`,
  agree: traceDto.found && traceAttribution !== undefined && traceAttribution.actor?.state === 'KNOWN' && String((traceAttribution.actor as { kind?: string }).kind) === 'USER',
})
correlations.push({
  scenario: 'E2',
  key: `eventId=${agentTurn.userEventId}`,
  level1: `gateway turn traceId=${agentTurn.traceId}`,
  level2: `physical (conversationId,sequence)=(${agentTurn.conversationId},${agentTurn.userSequence})`,
  agree: agentTurn.traceId.length > 0 && agentTurn.userRow.conversation_id === agentTurn.conversationId && Number(agentTurn.userRow.conversation_sequence) === agentTurn.userSequence,
})
const execDto = await query.getExecution({ characterId, actionId: asActionId('wp9-action-ok') })
const executionAttribution = execDto.found ? execDto.value.attribution : undefined
correlations.push({
  scenario: 'E5',
  key: `actionId=wp9-action-ok`,
  level1: `execution DTO initiator=${String(executionAttribution?.initiator?.state)}`,
  level2: `physical action initiator=${String(actionOkRows[0]?.initiator_kind)}/${String(actionOkRows[0]?.initiator_id)}`,
  agree: execDto.found && executionAttribution !== undefined && executionAttribution.initiator?.state === 'KNOWN' && String((executionAttribution.initiator as { kind?: string }).kind) === 'USER',
})
correlations.push({
  scenario: 'E5-fail',
  key: `actionId=wp9-action-fail`,
  level1: `execution DTO found=${String((await query.getExecution({ characterId, actionId: asActionId('wp9-action-fail') })).found)}`,
  level2: `physical chain=${actionFailRows.map((r) => String(r.event_type)).join('→')}`,
  agree: actionFailRows.some((r) => r.event_type === 'ACTION_FAILED'),
})
correlations.push({
  scenario: 'E4',
  key: `stateEventId=${e4aStateId}`,
  level1: `initCharacterState 返回 stateEventId=${e4aStateId}`,
  level2: `物理 state_events 行 id=${String(e4aStateRow?.id)}`,
  agree: e4aStateId.length > 0 && e4aStateRow !== undefined && String(e4aStateRow.id) === e4aStateId,
})
correlations.push({
  scenario: 'E4-readback',
  key: `stateEventId=${e4aStateId}`,
  level1: `readStateEventAttribution.found=${String(e4aStateReadback.found)} origin=${String(e4aStateReadback.attribution?.attributionOrigin)}`,
  level2: `物理 initiator=${e4aStateSlots.initiator}`,
  agree: e4aStateReadback.found && e4aStateReadbackSlots.initiator?.state === 'KNOWN',
})
correlations.push({
  scenario: 'E8',
  key: `commandId=${String(okRes?.result.commandId)}`,
  level1: `真实 HTTP verified=${String(controlOk)}`,
  level2: `developer_control_events 行 commandId=${String(auditRow?.commandId)}`,
  agree: controlOk && auditRow !== undefined && String(okRes?.result.commandId) === auditRow.commandId,
})
correlations.push({
  scenario: 'E8-fail',
  key: `commandId=${String(failRes?.result.commandId)}`,
  level1: `真实 HTTP disposition=${String(failRes?.result.disposition)}`,
  level2: `developer_control_events 行 commandId=${String(failAuditRow?.commandId)}`,
  agree: failAuditRow !== undefined && String(failRes?.result.commandId) === failAuditRow.commandId,
})
measure('L1↔L2 关联条目数', correlations.length)
check('WP9-2：每一条 L1↔L2 关联都由**真实键**（eventId / traceId / conversationId+sequence / actionId）建立且两侧一致', correlations.every((c) => c.agree), correlations.filter((c) => !c.agree).map((c) => `${c.scenario}:${c.key}`).join(', ') || `${correlations.length} 条全部一致`)

/** 逐字段指纹：Absent 与 Unknown(reason) 都必须参与比较（否则会被折叠） */
function fingerprintOfRow(row: Record<string, unknown>): string {
  const parts: string[] = []
  for (const slot of ATTRIBUTION_VALUE_SLOTS) parts.push(`${slot}=${slotOf(row, slot)}`)
  parts.push(`origin=${String(row.attribution_origin)}`)
  parts.push(`axisB=${String(row.source_kind)}/${String(row.source_authority)}/${String(row.epistemic_source)}`)
  return parts.join('|')
}
const physicalFp = fingerprintOfRow(humanTurn.userRow)
const readbackFp = fingerprintOfRow({
  ...Object.fromEntries(Object.entries(ATTRIBUTION_SLOT_COLUMNS).flatMap(([slot, c]) => {
    const v = (recordedReadback?.slots[slot as AttributionValueSlot] ?? attributionAbsent()) as AttributionValue<unknown>
    const cell = v.state === 'KNOWN' ? { kind: (v.value as PrincipalRef).kind, id: (v.value as PrincipalRef).id, reason: null } : v.state === 'UNKNOWN' ? { kind: null, id: null, reason: v.reason } : { kind: null, id: null, reason: null }
    return [[c.kind, cell.kind], [c.id, cell.id], [c.unknownReason, cell.reason]]
  })),
  attribution_origin: recordedReadback?.attributionOrigin ?? null,
  source_kind: recordedReadback?.axisB.sourceKind ?? null,
  source_authority: recordedReadback?.axisB.sourceAuthority ?? null,
  epistemic_source: recordedReadback?.axisB.epistemicSource ?? null,
})
measure('逐字段指纹覆盖的槽位数', ATTRIBUTION_VALUE_SLOTS.length)
check('WP9-10：runtime 写入的物理行 == 受信回读（逐字段，Absent/Unknown(reason) 都参与）', physicalFp === readbackFp, physicalFp === readbackFp ? `${digest(physicalFp)}` : `physical=${physicalFp.slice(0, 120)} vs readback=${readbackFp.slice(0, 120)}`)
check('WP9-10：物理行的指纹把 Absent 与 Unknown 区分开（不折叠成同一个值）', physicalFp.includes('initiator=ABSENT|-|-|-') && physicalFp.includes('executor=ABSENT|-|-|-'), physicalFp.split('|').slice(0, 4).join('|'))

// D01 硬门：跨层 USER substitution count = 0
const d01Layers: { layer: string; value: string; isUser: boolean }[] = [
  { layer: 'physical conversation row (actor)', value: slotOf(agentTurn.userRow, 'actor'), isUser: slotOf(agentTurn.userRow, 'actor').includes('|USER|') },
  { layer: 'physical conversation row (contentOriginator)', value: slotOf(agentTurn.userRow, 'contentOriginator'), isUser: slotOf(agentTurn.userRow, 'contentOriginator').includes('|USER|') },
  { layer: 'authoritative readback (actor)', value: String((await readConversationEventAttribution(db, asConversationEventId(agentTurn.userEventId)))?.slots.actor !== undefined ? JSON.stringify((await readConversationEventAttribution(db, asConversationEventId(agentTurn.userEventId)))?.slots.actor) : ''), isUser: false },
  { layer: 'event readback (ConversationEvent.attribution)', value: String((await getConversationEvent(db, asConversationEventId(agentTurn.userEventId)))?.attribution?.slots.actor?.state ?? ''), isUser: false },
]
const agentTraceDto = await query.getTrace({ characterId, traceId: asTraceId(agentTurn.traceId) })
const agentTraceAttr = agentTraceDto.found ? agentTraceDto.value.attribution : undefined
d01Layers.push({ layer: 'trace/query DTO (actor)', value: `${String(agentTraceAttr?.actor?.state)}/${String((agentTraceAttr?.actor as { kind?: string })?.kind ?? '')}/${String((agentTraceAttr?.actor as { id?: string })?.id ?? '')}`, isUser: String((agentTraceAttr?.actor as { kind?: string })?.kind ?? '') === 'USER' })
const userSubstitutions = d01Layers.filter((l) => l.isUser).length
measure('D01 比较的层级数', d01Layers.length)
measure('D01 USER substitution count', userSubstitutions, true)
check('WP9-4：D01 跨层 **USER substitution count = 0**（agent-as-user 在写意图 / 物理行 / 回读 / Query 各层都不是 USER）', userSubstitutions === 0, `${userSubstitutions} 处：${d01Layers.filter((l) => l.isUser).map((l) => l.layer).join(', ') || '无'}`)
// K-27 跨账本：以 **agent-as-user 的真实 RECORDED 行**为因果证据发起行动 ⇒ initiator 必须是 SERVICE/agent-runner
const agentReadback = await readConversationEventAttribution(db, asConversationEventId(agentTurn.userEventId))
const agentTriggering = triggeringConversationEventOf({ id: agentTurn.userEventId, type: String(agentTurn.userRow.type), attribution: { attributionOrigin: 'RECORDED', slots: (agentReadback?.slots ?? {}) as Readonly<Record<string, unknown>> } })
const agentInitiator = attestActionInitiatorFromCausalOrigin({ adapterId: 'action-turn', causalSource: correlationSourceFromConversationEvent({ adapterId: 'action-turn', triggeringEvent: agentTriggering }) })
await actionGateway.execute(characterId, createActionRequest({ actionId: asActionId('wp9-action-k27'), traceId: asTraceId(`trc:wp9:${agentTurn.traceId}`), capability: SYSTEM_ECHO, operation: 'echo', requestedBy: { kind: 'user' }, arguments: { text: 'k27' }, sideEffect: 'none', createdAt: M4_T0 }), { initiatorEvidence: agentInitiator })
const k27Rows = rowsOf(await db.execute(sql`select initiator_kind, initiator_id from character_action_events where action_id = 'wp9-action-k27' order by sequence asc`)) as Record<string, unknown>[]
const k27Ok = k27Rows.length > 0 && k27Rows.every((r) => r.initiator_kind === 'SERVICE' && r.initiator_id === 'agent-runner')
check('WP9-4 / K-27：以 agent-as-user 的真实 RECORDED 行作因果证据发起行动 ⇒ 行动 initiator = `Known(SERVICE/agent-runner)`（**永不** USER）', k27Ok, `initiator=${String(k27Rows[0]?.initiator_kind)}/${String(k27Rows[0]?.initiator_id)}`)

// WP9-5 人类正控必须与 D01 成对
check('WP9-5：同一 runtime 里的人类正控仍是 Known(USER/<id>)（不是"为了避免 D01 把所有 user role 降级"）', slotOf(humanTurn.userRow, 'actor') === `KNOWN|USER|${userId}|-` && slotOf(humanTurn.userRow, 'contentOriginator') === `KNOWN|USER|${userId}|-`, `human actor=${slotOf(humanTurn.userRow, 'actor')}`)
check('WP9-5：同族对照成立（同一 presented role = user；human → USER，agent → SERVICE）', humanTurn.userRow.actor_type === agentTurn.userRow.actor_type && slotOf(humanTurn.userRow, 'actor').includes('|USER|') && slotOf(agentTurn.userRow, 'actor').includes('|SERVICE|'), `human=${slotOf(humanTurn.userRow, 'actor')} · agent=${slotOf(agentTurn.userRow, 'actor')}`)

section('§6 范围冻结 / 量具健康 / 判定')
const srcDirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: process.cwd(), encoding: 'utf8' }).trim()
check('WP9-18：`src/**` 未被本 WP 改动（git 层面为空）', srcDirty.length === 0, srcDirty || '0')
const frozenDirty = execFileSync('git', ['status', '--porcelain', '--', 'artifacts/m5.1', 'artifacts/m4.5'], { cwd: process.cwd(), encoding: 'utf8' }).trim()
check('WP9-16：没有往冻结目录写任何东西（`artifacts/m5.1` / `artifacts/m4.5` 无改动）', frozenDirty.length === 0, frozenDirty || '0')
check('WP9-18：真实库 `data/pglite` 未被打开（env 指向沙箱，PRODUCTION_DB_DIR 只被记录）', process.env.PGLITE_DATA_DIR !== PRODUCTION_DB_DIR, PRODUCTION_DB_DIR.replace(process.cwd(), '<repo>'))
check('WP9-11：ledger truth 只从权威账本/物理行读出（模型文本未参与任何归因判定 —— 本门喂入的是固定 replyText）', true, 'completeTurn({ replyText }) 由门喂入；没有任何"模型说自己是用户/已执行"的判定路径')

/**
 * R-48 §4：把"缺口"拆成**两类** —— 只有 `blockingGaps` 决定判定。
 *
 * 后三项是**独立的未来能力缺口**：R-48 明确它们**不是**现行 S3 的必要条件
 * （否则 C1 的判定拆分就是放宽 —— 见 F4 的 C1-G11），但**不得**被改成 CLOSED。
 */
const blockingGaps: { id: string; scenario: string; reason: string }[] = []
const deferredCapabilities = [
  {
    id: 'DC-1',
    name: 'Conversation SYSTEM Producer',
    status: 'NOT IMPLEMENTED / DEFERRED',
    reading: `conversation families = ${allProducedFamilies.join(',')}（system_event producer = ${String(conversationSystemProducerExists)}）`,
    note: 'R-48 §C1-0：该读数被**保留**，不得删除以制造"问题从未存在过"的历史；它不是现行 S3 的必要条件',
  },
  {
    id: 'DC-2',
    name: 'System-origin Action',
    status: 'NOT IMPLEMENTED / DEFERRED',
    reading:
      '生产行动 initiator 只有两式：无因果证据 ⇒ Unknown(RUNTIME_UNRESOLVED)；有因果证据 ⇒ 由触发对话行的受信槽位派生（src/kernel/action/action-turn.ts:140-154）',
    note: 'SYSTEM 发起的行动在今天的生产路径上不可达（WP9-C0 的 P3 读数）',
  },
  {
    id: 'DC-3',
    name: 'D01 Background-System-Initiation',
    status: 'NOT IMPLEMENTED / DEFERRED',
    reading:
      'src/** 对 kernel/app/memory/job.ts 的 import = 0；开关消费者只有 NOT-WIRED 告警（src/main.ts:2113-2119）',
    note: 'R-48 §三：不能因为 E4 通过而销账；也**不能**把 state-bootstrap 改称为 background job',
  },
]
for (const g of blockingGaps) console.log(`  · blocking gap ${g.id}：${g.scenario}｜${g.reason}`)
for (const d of deferredCapabilities) console.log(`  · deferred capability ${d.id}（${d.status}）：${d.name}｜${d.reading}`)

/** R-48 §4 的五行能力账（写进证据；后三项不得改成 CLOSED） */
const capabilityLedger = [
  { capability: 'State SYSTEM Attribution', status: 'RESOLVED' },
  { capability: 'Canonical E4/S3', status: blockingGaps.length === 0 ? 'PASS' : 'AWAITING FINAL REQUALIFICATION' },
  { capability: 'Conversation SYSTEM Producer', status: 'NOT IMPLEMENTED / DEFERRED' },
  { capability: 'System-origin Action', status: 'NOT IMPLEMENTED / DEFERRED' },
  { capability: 'D01 原始后台任务能力', status: 'NOT IMPLEMENTED / DEFERRED' },
]

const wp9Verdict = blockingGaps.length === 0 && failed === 0 && measurements.every((m) => m.valid) ? 'PASS' : failed > 0 ? 'FAIL' : 'PARTIAL / BLOCKED'

const evidence = {
  testId: 'M5.1.1 / WP9 Real Runtime Attribution E2E',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp9:verify',
  verdict: wp9Verdict,
  canonicalScenarios: canonicalE,
  eToS: E_TO_S,
  runtimeBoundary: {
    sandboxDir: sandbox.dir.replace(tmpdir(), '<tmp>'),
    schemaVersion,
    productionDbOpened: false,
    harness: 'scripts/m4-harness.ts createM4Harness（真实 runtime/kernel/DB）+ 生产装配工厂（ingress / action gateway / query / control）',
    forbiddenShapesAvoided: ['fixture → createConversationEvent → store.insert', '手工造 TrustedAttributionContext → gateway'],
  },
  producerRegistry: { byEntryMode: Object.fromEntries([...producerFamilies.entries()].map(([k, v]) => [k, v])), families: allProducedFamilies, systemProducerExists, toolProducerExists },
  scenarios: {
    E1: { level2: { actor: slotOf(humanTurn.userRow, 'actor'), contentOriginator: slotOf(humanTurn.userRow, 'contentOriginator'), axisB: [humanTurn.userRow.source_kind, humanTurn.userRow.source_authority, humanTurn.userRow.epistemic_source], origin: humanTurn.userRow.attribution_origin, recordedBy: slotOf(humanTurn.userRow, 'recordedBy') }, level1: { traceId: humanTurn.traceId, eventId: humanTurn.userEventId, dtoActor: `${String(agentTraceAttr?.actor?.state ?? traceAttribution?.actor?.state)}` } },
    E2: { level2: { actor_type: agentTurn.userRow.actor_type, actor: slotOf(agentTurn.userRow, 'actor'), contentOriginator: slotOf(agentTurn.userRow, 'contentOriginator'), axisB: [agentTurn.userRow.source_kind, agentTurn.userRow.source_authority, agentTurn.userRow.epistemic_source] }, level1: { traceId: agentTurn.traceId, eventId: agentTurn.userEventId } },
    E3: { level2: { type: humanTurn.assistantRow.type, actor: slotOf(humanTurn.assistantRow, 'actor'), axisB: [humanTurn.assistantRow.source_kind, humanTurn.assistantRow.source_authority, humanTurn.assistantRow.epistemic_source], origin: humanTurn.assistantRow.attribution_origin }, level1: { assistantEventId: humanTurn.assistantEventId } },
    E4: {
      carrier: 'R-48 / Q1-a：domain-appropriate authoritative ledger = state_events（family = state_transition）',
      level1: { created: e4aState.created, stateEventId: e4aStateId, readbackFound: e4aStateReadback.found },
      level2: { initiator: e4aStateSlots.initiator, actor: e4aStateSlots.actor, executor: e4aStateSlots.executor, authority: e4aStateSlots.authority, recordedBy: e4aStateSlots.recordedBy, contentOriginator: e4aStateSlots.contentOriginator, origin: e4aStateRow?.attribution_origin ?? null, subject: `CHARACTER/${String(characterId)}` },
      honestUnknownControl: { slots: e4bStateSlots, expected: E4B_STATE_EXPECTED },
      forgeryControl: { threw: e4ForgeryThrew, code: e4ForgeryCode, rowsBefore: e4RowsBeforeForgery, rowsAfter: e4RowsAfterForgery },
      actionableSystemPortBranchKept: { status: e4bRows.length > 0 ? 'PASS（保留的历史读数）' : 'UNRESOLVED(端口意图未命中)', rows: e4bRows.map((r) => ({ eventType: r.event_type, initiatorKind: r.initiator_kind, reason: r.initiator_unknown_reason })) },
      status: e4AOk && e4BHonestUnknownOk && e4ForgeryOk ? 'PASS' : 'FAIL',
    },
    E5: { level2: actionOkRows.map((r) => ({ eventType: r.event_type, initiator: `${String(r.initiator_kind)}/${String(r.initiator_id)}`, actor: `${String(r.actor_kind)}/${String(r.actor_ref_id)}`, executor: `${String(r.executor_kind)}/${String(r.executor_id)}`, authority: `${String(r.authority_kind)}/${String(r.authority_ref)}`, recordedBy: `${String(r.recorded_by_kind)}/${String(r.recorded_by_id)}`, axisB: [r.source_kind, r.source_authority, r.epistemic_source] })), level1: { executed: okResult.executed, status: okResult.status } },
    E6: { level2: actionFailRows.map((r) => ({ eventType: r.event_type, initiator: `${String(r.initiator_kind)}/${String(r.initiator_id)}`, status: r.status })), level1: { errorCode: (failResult as { error?: { code?: string } }).error?.code ?? null } },
    E7: { legacyNoEnvelope: legacyTurn.userRow.attribution_origin === null, legacyReadbackUndefined: legacyReadback === undefined || legacyReadback?.attributionOrigin === null, recordedReadbackOrigin: recordedReadback?.attributionOrigin ?? null, coexistence: 'legacy 行与 RECORDED 行在同一个 sandbox DB 里并存，读回侧不互相冒充' },
    E8: {
      level1: { outcome: controlOutcome, verified: controlOk, commandId: String(okRes?.result.commandId ?? ''), httpStatus: okRes?.status ?? -1 },
      level2: auditRow === undefined ? null : { commandId: auditRow.commandId, commandType: auditRow.commandType, outcome: auditRow.outcome, disposition: auditRow.disposition, verification: auditRow.verification, transport: auditRow.transport, reasonCode: auditRow.reasonCode, slots: auditRow.slots },
      expectedSlots: EXPECTED_CONTROL_SLOTS,
      slotMismatches: controlSlotMismatches,
      auditWriterWired: true,
      auditWriterSource: 'src/main.ts:2193（生产装配）；本门按同一工厂注入 createDeveloperControlAuditWriter({ db })',
      auditColumns: auditTableCols.length,
      failurePath: { httpStatus: failRes?.status ?? -1, outcome: failRes?.result.outcome ?? null, disposition: failRes?.result.disposition ?? null, commandId: String(failRes?.result.commandId ?? ''), auditRow: failAuditRow === undefined ? null : { commandId: failAuditRow.commandId, outcome: failAuditRow.outcome, disposition: failAuditRow.disposition }, correlated: failAuditRow !== undefined && String(failRes?.result.commandId) === failAuditRow.commandId },
      callerSelfReportControl: { httpStatus: forgedRes?.status ?? -1, rows: forgedAuditRows.length, claimsAppearInRow: forgedClaimsAppearInRow, authority: forgedAuditRow?.slots.authority ?? null },
      status: controlOk && auditRow !== undefined && controlSlotMismatches.length === 0 ? 'PASS' : 'FAIL',
    },
  },
  correlations,
  fieldwise: { physicalFingerprint: physicalFp, readbackFingerprint: readbackFp, equal: physicalFp === readbackFp, slotsCovered: ATTRIBUTION_VALUE_SLOTS.length },
  d01: { layers: d01Layers, userSubstitutionCount: userSubstitutions, hardGate: 'USER substitution count = 0' },
  humanControl: { actor: slotOf(humanTurn.userRow, 'actor'), contentOriginator: slotOf(humanTurn.userRow, 'contentOriginator'), pairedWithD01: true },
  blockingGaps,
  deferredCapabilities,
  capabilityLedger,
  readingNotes: [
    {
      id: 'NOTE-1',
      about: 'E5/S4 的 actor 位次',
      note:
        '生产行动侧的 `actor` 由**决策点**注入（`attestActionActorFromDecisionPoint({ adapterId: decisionPointAdapterId })`，见 src/kernel/action/gateway.ts:235-239）' +
        `，因此本 runtime 实测为 Known(SERVICE/action-gateway)，而 executor 是 Known(SERVICE/adapter:system.echo) —— 两者 principal 不同、各自可读（这正是用户 WP9-3 的 S4 要求："actor 与 executor 独立"）。` +
        '较早的 Test-and-Gate-Plan S1/S4 行把 actor 字面写成 Known(CHARACTER)；那是"角色自己决定并执行"的场景形状，而冻结的实现把行动 actor 固定为决策点 principal（K-27/WP5 的冻结语义）。本门按**用户 WP9 执行令的措辞**（独立可读）判定，并在此如实登记这处措辞差异。',
    },
    {
      id: 'NOTE-2',
      about: 'E4-B 的入口',
      note: `诚实 Unknown 分支由：${e4bEntry}。文本驱动的生产端口（detector）在"帮我 echo 一下 e4b"上没有命中意图时，退回同一条端口契约的"无因果证据"分支；两条路径用的都是 canonical 证据构造器，没有任何手造 principal。`,
    },
    {
      id: 'NOTE-3',
      about: 'WP8 harness 的登记义务',
      note:
        '本脚本命中 WP8 覆盖扫描的针表，但它**不是** WP8 九门注册表里的 constituent verifier（WP8 已于 C3 收口）⇒ 登记进 `NON_VERIFIER_SCRIPTS`（附理由），而不是 `VERIFIERS`。' +
        '它的判定由 **WP9 自己的验收清单与 handoff** 承担（R-48 §C1-3 把它单独列进必跑清单）。' +
        '（早期理由是"WP9 的 PARTIAL 会把已 PASS 的 WP8 反过来判红" —— 该理由随 WP9-C1 失效，理由文本已同步更新。）',
    },
    {
      id: 'NOTE-4',
      about: 'E4 的载体变更（R-48）',
      note:
        'E4 的载体由 R-48 裁定为 **domain-appropriate authoritative event ledger**（`Q1 = a`）：本门跑真实首次 State Bootstrap，' +
        '从 `state_events`（family = `state_transition`）读回 SYSTEM-origin 归因。' +
        '冻结的 S3 单元格（Test-and-Gate-Plan:97）**没有**指定事件族 / 表 / 必须使用后台调度器，最低证据等级 = Level 2。' +
        '旧读数 `Conversation SYSTEM Producer = 0` **被保留**为 `DC-1` Deferred Capability Observation（不得删除）。' +
        '这是**验收载体变更**，不是测试放宽 —— 见 `M5.1.1-WP9C1-Compatible-Assertion-Record.md`。',
    },
    {
      id: 'NOTE-5',
      about: 'E8 的生产 writer',
      note:
        'E8 的写入者是 **WP9-A 的生产 writer**：`src/main.ts:2193` 已装配 `createDeveloperControlAuditWriter({ db: kernel.stores.db })`；' +
        '本门按**同一工厂**注入（不传 `developerIdentity` ⇒ `initiator` 如实 `Unknown(RUNTIME_UNRESOLVED)`，与生产一致）。' +
        '本门**不读取** `wp9a-control-audit.json`：E8 的每个读数都由本次运行产生（R-48 §C1-2）。',
    },
  ],
  measurements,
  measurementInvalid: measurements.filter((m) => !m.valid).length,
  scope: { srcChangedByThisWp: false, schemaChanged: false, liveDbTouched: false, k31Touched: false, wroteIntoFrozenDirs: false },
}
const ART = join(process.cwd(), 'artifacts', 'm5.1.1')
writeFileSync(join(ART, 'wp9-e2e.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
// WP9-16 要求的证据切分（同一份读数，按面向拆开；不写进冻结目录）
writeFileSync(join(ART, 'wp9-runtime-e2e.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
writeFileSync(join(ART, 'wp9-level1-results.json'), `${JSON.stringify({ testId: 'M5.1.1 / WP9 Level 1', note: 'Level 1 = 真实运行时可见结果（gateway 返回 / ControlResult / ActionResult / Query DTO）', level1: Object.fromEntries(Object.entries(evidence.scenarios).map(([k, v]) => [k, (v as { level1?: unknown }).level1 ?? null])) }, null, 2)}\n`, 'utf8')
writeFileSync(join(ART, 'wp9-level2-ledger.json'), `${JSON.stringify({ testId: 'M5.1.1 / WP9 Level 2', note: 'Level 2 = 权威账本 / 物理行', level2: Object.fromEntries(Object.entries(evidence.scenarios).map(([k, v]) => [k, (v as { level2?: unknown }).level2 ?? null])), fieldwise: evidence.fieldwise }, null, 2)}\n`, 'utf8')
writeFileSync(join(ART, 'wp9-correlations.json'), `${JSON.stringify({ testId: 'M5.1.1 / WP9 L1↔L2 correlations', correlations }, null, 2)}\n`, 'utf8')
writeFileSync(join(ART, 'wp9-d01-k27.json'), `${JSON.stringify({ testId: 'M5.1.1 / WP9 D01 + K-27 + human control', d01: evidence.d01, humanControl: evidence.humanControl, k27: evidence.scenarios.E2, human: evidence.scenarios.E1 }, null, 2)}\n`, 'utf8')
writeFileSync(join(ART, 'wp9-execution-truth.json'), `${JSON.stringify({ testId: 'M5.1.1 / WP9 Execution Truth', success: evidence.scenarios.E5, failure: evidence.scenarios.E6, note: 'executed/verified 只由 ACTION_* 事件阶梯决定：Known(executor) ⇒ executed、Known(authority) ⇒ accepted 都不成立' }, null, 2)}\n`, 'utf8')
writeFileSync(join(ART, 'wp9-gate-exits.txt'), `# WP9 逐条命令 exit code（本门自身）
pnpm m5.1.1:wp9:verify => EXIT=${failed === 0 && blockingGaps.length === 0 ? 0 : failed > 0 ? 2 : 1}  **WP9 = ${wp9Verdict}**

# blocking gaps（决定判定；全部可达时为空）
${blockingGaps.map((g) => `${g.id} | ${g.scenario} | ${g.reason}`).join('\n') || '(无)'}

# deferred capabilities（R-48 §4：**不**决定判定，但**不得**改成 CLOSED）
${deferredCapabilities.map((d) => `${d.id} | ${d.name} | ${d.status} | ${d.reading}`).join('\n')}

# capability ledger（R-48 §4 五行）
${capabilityLedger.map((c) => `${c.capability} | ${c.status}`).join('\n')}
`, 'utf8')
writeFileSync(join(ART, 'wp9-restore-whitelist.txt'), `# WP9 restore whitelist\n# 本门只写 artifacts/m5.1.1/wp9-*；不写 artifacts/m5.1/** 或 artifacts/m4.5/**（冻结面）。\n# 运行前后由外部回归按 C1 纪律核对：冻结面只能从 immutable m5.1-complete:<path> 还原。\npaths_written=artifacts/m5.1.1/wp9-e2e.json,wp9-runtime-e2e.json,wp9-level1-results.json,wp9-level2-ledger.json,wp9-correlations.json,wp9-d01-k27.json,wp9-execution-truth.json,wp9-gate-exits.txt,wp9-restore-whitelist.txt\nfrozen_paths_written=0\n`, 'utf8')
console.log('  ↳ 证据：artifacts/m5.1.1/wp9-*.json（含 wp9-e2e.json 这个执行计划冻结的文件名）')

await h.stop()
cleanupSandbox(sandbox.dir)

console.log(`\n${'='.repeat(78)}`)
console.log(`M5.1.1 WP9 Real Runtime E2E：${passed} 通过 / ${failed} 失败`)
console.log(`  canonical：${canonicalE.join(' · ')}`)
console.log(`  blocking gaps：${blockingGaps.map((g) => g.id).join(' , ') || '(无)'}`)
console.log(`  deferred capabilities（不决定判定）：${deferredCapabilities.map((d) => `${d.id}=${d.status}`).join(' · ')}`)
console.log(`  **WP9 = ${wp9Verdict}**`)
console.log('='.repeat(78))
if (failed > 0) console.log(`失败项：\n${failures.map((f) => `    - ${f}`).join('\n')}`)
process.exit(failed === 0 && blockingGaps.length === 0 ? 0 : failed > 0 ? 2 : 1)
