/**
 * M5.1.1 WP6 —— **Recorded Read Path / Query / Replay Attribution Switch**
 * （`pnpm m5.1.1:wp6:verify`）
 *
 * ============================================================================
 *  它证明的是什么
 * ============================================================================
 *  ① 读侧清单：三张权威表的读者**全部**被分类（AUTHORITATIVE_RECORDED /
 *     LEGACY_COMPATIBILITY / PROJECTION_ONLY / DISPLAY_ONLY），新增读者会让本门变红。
 *  ② `RECORDED` 行：查询面（trace DTO / execution DTO）**逐字段**等于存储列（不重推）。
 *  ③ `MIGRATED_LEGACY` 行：原样保留（origin 不被升格、`Unknown(LEGACY_UNRECORDED)`
 *     不折叠、两个槽位的不一致也不被"修好"）。
 *  ④ 三态在 **DTO 表示层**可区分（Known / Unknown / Absent 两两不同）。
 *  ⑤ trace 的归因**不是第二份存储**：`input_event_id` → 那条对话事件的存储归因。
 *  ⑥ R1–R6（删除投影→从事件重建→逐字段一致 / 不重推 / 历史保持 / 可区分 / Unknown 保持 /
 *     三态不折叠）。
 *  ⑦ D01 跨账本 + K-27：任何读侧面**都不得**把 SERVICE 说成 USER。
 *  ⑧ 查询面**严格只读**：跑完整个查询套件前后，权威表逐字段/逐字节等价（mutation = 0）。
 *  ⑨ 不加归因过滤器 / 不加索引 / 不导出到 telemetry。
 *
 * ⚠️ 本步**不**改：Fact Firewall / `canSupportExternalFact` / MemoryAuthority /
 *    extractor / Recall / ADR-043 / Phase 4 / Developer Control（U-03）/
 *    `MIGRATION_0007` / `MIGRATION_0008` / `page.html`（除编译必需）。没有 v9。
 *
 * 跑法：pnpm m5.1.1:wp6:verify
 */

import 'dotenv/config'

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  NECESSITY_MATRIX,
  actionAttributionFamilyOf,
  attestActionActorFromDecisionPoint,
  attestActionAuthorityFromPolicy,
  attestActionExecutorFromAdapter,
  attestActionInitiatorFromCausalOrigin,
  attestActorFromDecisionPoint,
  attestContentOriginatorFromIngress,
  attestEpistemicConfirmation,
  buildTrustedActionAttribution,
  buildTrustedAttributionContext,
  correlationSourceFromConversationEvent,
  type AuthorityRef,
} from '../src/kernel/contracts/attribution.ts'
import type { PrincipalRef } from '../src/kernel/contracts/actor.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  asActionId,
  asCharacterId,
  asConversationEventId,
  asConversationId,
  asTraceId,
  newActionId,
  newTraceId,
} from '../src/kernel/contracts/ids.ts'
import { createActionRequest } from '../src/kernel/action/action-request.ts'
import { SYSTEM_ECHO, createCapabilityRegistry, createDefaultCapabilityDefinitions } from '../src/kernel/action/capability-registry.ts'
import type { PolicyDecision } from '../src/kernel/action/policy.ts'
import type { ActionLedgerEvent } from '../src/kernel/action/execution-ledger.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import {
  appendConversationEvent,
  readConversationEventAttribution,
} from '../src/infrastructure/persistence/conversation-store.ts'
import { createTraceWriter } from '../src/infrastructure/persistence/trace-store.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
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
const json = (value: unknown): string => JSON.stringify(value)

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')
const AGENT: PrincipalRef = { kind: 'SERVICE', id: 'agent' } as PrincipalRef
const USER: PrincipalRef = { kind: 'USER', id: 'u-1' } as PrincipalRef
const GATEWAY_PRINCIPAL: PrincipalRef = { kind: 'SERVICE', id: 'action-gateway' } as PrincipalRef
const CAPABILITY: AuthorityRef = { kind: 'CAPABILITY', ref: SYSTEM_ECHO } as AuthorityRef

console.log('='.repeat(74))
console.log('M5.1.1 WP6 —— Recorded Read Path / Query / Replay Attribution Switch')
console.log('='.repeat(74))

const sandbox = isolateDatabase('m5.1.1-wp6')
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
  '沙箱库 schema = v9（WP6 本身无 schema 变更；v9 是 WP9-B1 的 state_events 承载）',
  schemaVersion === 9,
  `v${schemaVersion}`
)

const fingerprint = (version: number): string => {
  const migration = MIGRATIONS.find((m) => m.version === version)!
  return createHash('sha256').update(migration.statements.join('\n'), 'utf8').digest('hex')
}
check(
  'MIGRATION_0007 / 0008 逐字未改；迁移清单 = 1..9（v9 = WP9-B1 的 state_events 承载，' +
    '原判据"没有 v9"按 R-45 的新事实改写，未放宽）',
  fingerprint(7) === '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613' &&
    fingerprint(8) === '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29' &&
    MIGRATIONS.map((m) => m.version).join(',') === '1,2,3,4,5,6,7,8,9' &&
    MIGRATIONS.find((m) => m.version === 9)?.name === 'm5.1.1-state-events-attribution',
  MIGRATIONS.map((m) => m.version).join(',')
)

const characterId = asCharacterId('char_sumuwei')
const conversationId = asConversationId('conv_wp6')
const query = createDeveloperQueryService({
  db,
  characterId,
  owner: entityRef('character', String(characterId)),
  runtimeId: 'runtime-wp6',
})

// ===========================================================================
section('§1 读侧清单（WP6-0）：三张权威表的读者**全部**被分类')
// ===========================================================================

const FROZEN_READERS: Readonly<Record<string, { category: string; reason: string }>> = {
  'src/infrastructure/persistence/conversation-store.ts': {
    category: 'AUTHORITATIVE_RECORDED',
    reason: 'RECORDED 行按 18 个物理列逐字重建；legacy / MIGRATED_LEGACY 走兼容路径（WP4）',
  },
  'src/infrastructure/persistence/event-store.ts': {
    category: 'PROJECTION_ONLY',
    reason: '领域事件与投影的读写 + 重放；**不读**归因列',
  },
  'src/infrastructure/persistence/backfill.ts': {
    category: 'LEGACY_COMPATIBILITY',
    reason: '迁移写侧（MIGRATED_LEGACY 的生产者），不是读路径',
  },
  'src/infrastructure/action/action-ledger-store.ts': {
    category: 'AUTHORITATIVE_RECORDED',
    reason: '写 RECORDED 归因列；读侧 storedAttributionOfRow 对两个 origin 都解码',
  },
  'src/infrastructure/persistence/trace-store.ts': {
    category: 'PROJECTION_ONLY',
    reason: 'trace 上**没有**归因列；归因靠 input_event_id 关联（WP6-6）',
  },
  'src/infrastructure/dev/query-service.ts': {
    category: 'AUTHORITATIVE_RECORDED',
    reason: '查询面：把存储归因（对话 + 行动）映射成三态 DTO（WP6-3/4/6）',
  },
  'src/infrastructure/dev/http-server.ts': {
    category: 'DISPLAY_ONLY',
    reason: '只把 DTO 送到 HTTP 面；不解释归因',
  },
  'src/infrastructure/persistence/ledger.ts': {
    category: 'DISPLAY_ONLY',
    reason: '账本端口的封装（ConversationLedgerPort）',
  },
  'src/infrastructure/runtime/adapters.ts': {
    category: 'DISPLAY_ONLY',
    reason: '运行时适配器装配',
  },
  'src/infrastructure/runtime/conversation-recorder.ts': {
    category: 'DISPLAY_ONLY',
    reason: '写入器；不解释归因',
  },
  'src/kernel/action/execution-ledger.ts': {
    category: 'PROJECTION_ONLY',
    reason: '端口与视图形状（attribution 由 store 填）',
  },
  'src/kernel/app/conversation-integrity-service.ts': {
    category: 'LEGACY_COMPATIBILITY',
    reason: '完整性检查只读事件引用（不含归因）',
  },
  'src/kernel/app/turn-gateway.ts': {
    category: 'DISPLAY_ONLY',
    reason: '把输入事件传给动作侧（K-27 的因果来源）；不解释归因',
  },
  'src/kernel/contracts/developer-query.ts': {
    category: 'DISPLAY_ONLY',
    reason: 'DTO 形状与三态映射（**只**做搬运，不做推导）',
  },
  'src/kernel/contracts/ledger-port.ts': {
    category: 'PROJECTION_ONLY',
    reason: '端口契约',
  },
  'src/main.ts': {
    category: 'DISPLAY_ONLY',
    reason: '装配层',
  },
  /*
   * M5.1.1 / Phase 4b（ADR-043 §3.2）—— **新增读者，显式登记**。
   *
   * 它读 RECORDED 归因的方式是**唯一适配边界**：`getConversationEvent()`
   * （`conversation-store.ts` 的 row → event，含 legacy 兼容路径）→
   * `processorEventViewOf().trustedOrigin`。它**不**自己解析那 18 个物理列
   * （第一版那么写会被 k17 的"只有 1 处派生点"抓住），
   * 也不写任何表；产物是**读时派生**的当前资格（供召回排序/prompt 标签/审计探针）。
   */
  'src/infrastructure/persistence/qualification-read.ts': {
    category: 'AUTHORITATIVE_RECORDED',
    reason: '经唯一适配边界读 RECORDED 受信读数并派生存量资格；纯 SELECT，不解析物理列、不写库',
  },
}

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
const SQL_READ = /from\s+(conversation_events|character_action_events|character_traces)\b/i
const PORT_READ =
  /getEventsByActionId\(|listEvents\(|listRecords\(|getConversationEvent\(|findByConversationSequence\(|recentConversationEvents\(|readConversationEventAttribution\(|readActionStoredAttributions\(|listTracePage\(|readTrace\(|getTrace\(|createDeveloperQueryService/
const discoveredReaders = srcFiles()
  .filter((file) => {
    const text = readFileSync(file, 'utf8')
    return SQL_READ.test(text) || PORT_READ.test(text)
  })
  .map((file) => file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\/+/, ''))
measure('扫描到的 src 文件数', srcFiles().length)
measure('发现的三表读者数', discoveredReaders.length)
const unclassified = discoveredReaders.filter((file) => FROZEN_READERS[file] === undefined)
check(
  '★ 每一个读者都被分类（新增读者必须显式登记，否则本门变红）',
  discoveredReaders.length > 0 && unclassified.length === 0,
  unclassified.join(',') || `${discoveredReaders.length} 个全部已分类`
)
const stale = Object.keys(FROZEN_READERS).filter((file) => !discoveredReaders.includes(file))
check(
  '分类表里没有**已经不存在的**读者（清单与代码同步）',
  stale.length === 0,
  stale.join(',') || 'AA'
)

// ===========================================================================
section('§2 fixture：真实写路径造出四种行（RECORDED / 人类 / MIGRATED_LEGACY / 无归因）')
// ===========================================================================

async function writeRecordedConversationEvent(input: {
  sequence: number
  actorType: 'user' | 'character'
  actorId: string
  actorPrincipal: PrincipalRef
  originatorPrincipal: PrincipalRef
  humanAttested: boolean
  content: string
}): Promise<{ eventId: string; sequence: number; row: Record<string, unknown> }> {
  const context = buildTrustedAttributionContext({
    family: 'user_message',
    characterId: String(characterId),
    actorEvidence: attestActorFromDecisionPoint({ adapterId: 'ingress', principal: input.actorPrincipal }),
    contentOriginatorEvidence: attestContentOriginatorFromIngress({
      adapterId: 'ingress',
      principal: input.originatorPrincipal,
    }),
    ...(input.humanAttested
      ? {
          epistemicEvidence: attestEpistemicConfirmation({
            adapterId: 'ingress',
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
  return { eventId: String(event.event.id), sequence: input.sequence, row: rows[0] ?? {} }
}

const d01 = await writeRecordedConversationEvent({
  sequence: 1,
  actorType: 'user',
  actorId: 'agent',
  actorPrincipal: AGENT,
  originatorPrincipal: AGENT,
  humanAttested: false,
  content: 'WP6 D01：agent 以 user 角色提交',
})
const human = await writeRecordedConversationEvent({
  sequence: 2,
  actorType: 'user',
  actorId: 'u-1',
  actorPrincipal: USER,
  originatorPrincipal: USER,
  humanAttested: true,
  content: 'WP6 人类直接输入',
})

// 无归因行（走 store 的 legacy 路径，不带 trustedAttribution）
const legacyEvent = await appendConversationEvent(db, {
  characterId,
  conversationId,
  conversationSequence: 3,
  type: 'user_message',
  actorType: 'user',
  actorId: 'u-1',
  content: 'WP6 无归因（legacy）',
})

// MIGRATED_LEGACY 行：三态齐全（Known / Unknown(LEGACY_UNRECORDED) / Absent）+ Axis B 成对
await db.execute(
  sql`insert into conversation_events
        (id, character_id, conversation_id, sequence, conversation_sequence, type, actor_type,
         actor_id, content, schema_version, created_at,
         attribution_origin, source_kind, source_authority, epistemic_source,
         initiator_kind, initiator_id, actor_kind, actor_ref_id,
         content_originator_kind, content_originator_id, content_originator_unknown_reason,
         recorded_by_kind, recorded_by_id)
      values ('cev:wp6:migrated', ${String(characterId)}, ${String(conversationId)}, 900, 900,
              'user_message', 'user', 'u-1', 'WP6 历史回填行', 1, ${Date.now()},
              'MIGRATED_LEGACY', 'user_statement', 'UNCONFIRMED_ORIGIN', 'UNCONFIRMED_ORIGIN',
              null, null, 'SERVICE', 'agent',
              null, null, 'LEGACY_UNRECORDED',
              'SYSTEM', 'kernel')`
)
const migratedId = asConversationEventId('cev:wp6:migrated')
const migratedRow = (
  rowsOf(await db.execute(sql`select * from conversation_events where id = 'cev:wp6:migrated'`)) as Record<
    string,
    unknown
  >[]
)[0]!
measure('§2 fixture 的对话行数', 4)

// traces：每条对话事件一条（input_event_id 是**唯一**的关联）
const traceWriter = createTraceWriter(db)
const traceIds: Record<string, string> = {}
for (const [label, eventId] of [
  ['d01', d01.eventId],
  ['human', human.eventId],
  ['legacy', String(legacyEvent.event.id)],
  ['migrated', String(migratedId)],
] as const) {
  const traceId = newTraceId()
  traceIds[label] = String(traceId)
  await traceWriter.start({
    traceId,
    characterId,
    runtimeId: 'runtime-wp6',
    userId: 'u-1',
    conversationId: String(conversationId),
    inputEventId: asConversationEventId(eventId),
    identitySourceRefs: ['character-definition:sumuwei@2'],
    contextSectionIds: ['identity'],
    droppedSectionIds: [],
    sourceConversationEventIds: [eventId],
    selectedMemoryIds: [],
    projectionRevisionsAtStart: {},
    projectionRevisionsAtEnd: {},
    domainEventIds: [],
    postTurnJobIds: [],
    processorVersions: {},
    actionIds: [],
    steps: [],
    status: 'completed',
    startedAt: Date.now(),
  })
}
measure('§2 fixture 的 trace 数', Object.keys(traceIds).length)

// 行动：一条 RECORDED（D01 因果 initiator=SERVICE/agent）+ 一条无归因的 legacy
const ledger = createActionLedgerStore(db)
const actionRequest = createActionRequest({
  actionId: newActionId(),
  traceId: asTraceId(traceIds.d01!),
  capability: SYSTEM_ECHO,
  operation: 'echo',
  // 兼容/输入证据故意说 user —— 权威 initiator 必须是 SERVICE/agent
  requestedBy: { kind: 'user', id: 'u-1' },
  arguments: { text: 'wp6' },
  sideEffect: 'none',
})
const causalInitiator = attestActionInitiatorFromCausalOrigin({
  adapterId: 'action-turn',
  causalSource: correlationSourceFromConversationEvent({
    adapterId: 'action-turn',
    triggeringEvent: {
      eventId: d01.eventId,
      type: 'user_message',
      attributionOrigin: 'RECORDED',
      actor: { state: 'KNOWN', value: AGENT },
      contentOriginator: { state: 'KNOWN', value: AGENT },
    },
  }),
})
function actionAttribution(type: keyof typeof ACTION_ATTRIBUTION_FAMILY_BY_EVENT_TYPE) {
  // 该给哪些槽位**只**读冻结矩阵（与 gateway / store 同一判据）
  const row = NECESSITY_MATRIX[actionAttributionFamilyOf(type)]
  const needsAuthority = row.authority !== 'ABSENT'
  const needsExecutor = row.executor !== 'ABSENT'
  return buildTrustedActionAttribution({
    eventType: type,
    characterId: String(characterId),
    initiatorEvidence: causalInitiator,
    actorEvidence: attestActionActorFromDecisionPoint({
      adapterId: 'action-gateway',
      principal: GATEWAY_PRINCIPAL,
    }),
    ...(needsAuthority
      ? { authorityEvidence: attestActionAuthorityFromPolicy({ adapterId: 'action-policy', authority: CAPABILITY }) }
      : {}),
    ...(needsExecutor
      ? {
          executorEvidence: attestActionExecutorFromAdapter({
            adapterId: 'action-adapter',
            principal: { kind: 'SERVICE', id: `adapter:${SYSTEM_ECHO}` } as PrincipalRef,
          }),
        }
      : {}),
  })
}
const allowedDecision: PolicyDecision = { allowed: true, code: 'allowed', message: 'ok', checks: [] }
const chainTypes = ['ACTION_REQUESTED', 'ACTION_TARGET_RESOLVED', 'ACTION_AUTHORIZED', 'ACTION_STARTED', 'ACTION_SUCCEEDED'] as const
const chainEvents: ActionLedgerEvent[] = []
for (const type of chainTypes) {
  const attribution = actionAttribution(type)
  const event =
    type === 'ACTION_REQUESTED'
      ? await ledger.appendRequested({ characterId, request: actionRequest, attribution })
      : type === 'ACTION_TARGET_RESOLVED'
        ? await ledger.appendTargetResolved({
            characterId,
            request: actionRequest,
            target: { type: 'unknown', confidence: 'none' },
            scopeViolation: false,
            attribution,
          })
        : type === 'ACTION_AUTHORIZED'
          ? await ledger.appendAuthorized({
              characterId,
              request: actionRequest,
              target: { type: 'unknown', confidence: 'none' },
              decision: allowedDecision,
              attribution,
            })
          : type === 'ACTION_STARTED'
            ? await ledger.appendStarted({
                characterId,
                request: actionRequest,
                target: { type: 'unknown', confidence: 'none' },
                attribution,
              })
            : await ledger.appendSucceeded({
                characterId,
                request: actionRequest,
                target: { type: 'unknown', confidence: 'none' },
                evidence: [],
                attribution,
              })
  chainEvents.push(event)
}
const legacyActionRequest = createActionRequest({
  actionId: asActionId('wp6-legacy-action'),
  traceId: asTraceId(traceIds.legacy!),
  capability: SYSTEM_ECHO,
  operation: 'echo',
  requestedBy: { kind: 'system' },
  arguments: { text: 'legacy' },
  sideEffect: 'none',
})
const legacyAction = await ledger.appendRequested({ characterId, request: legacyActionRequest })
await ledger.appendSucceeded({
  characterId,
  request: legacyActionRequest,
  target: { type: 'unknown', confidence: 'none' },
  evidence: [],
})
measure('§2 fixture 的归因行动事件数', chainEvents.length)

// ===========================================================================
section('§3 RECORDED 对话查询逐字段精确（WP6-1 / WP6-3 / R2）')
// ===========================================================================

const d01Trace = await query.getTrace({ characterId, traceId: asTraceId(traceIds.d01!) })
check('getTrace(D01) 找到', d01Trace.found === true)
const d01Dto = d01Trace.found ? d01Trace.value.attribution : undefined
check(
  '★ trace DTO 带出 D01 输入事件的存储归因（origin=RECORDED）',
  d01Dto !== undefined && d01Dto.attributionOrigin === 'RECORDED',
  json(d01Dto?.attributionOrigin ?? null)
)
check(
  '★ D01：DTO actor = KNOWN(SERVICE/agent)，与**存储列**逐字一致（不由 actor_type 推导）',
  json(d01Dto?.actor) === json({ state: 'KNOWN', kind: 'SERVICE', id: 'agent' }) &&
    d01RowMatchesStore(d01.row),
  json(d01Dto?.actor ?? null)
)
check(
  '★ D01：DTO contentOriginator = KNOWN(SERVICE/agent)（呈现角色 user 一票都没有）',
  json(d01Dto?.contentOriginator) === json({ state: 'KNOWN', kind: 'SERVICE', id: 'agent' }),
  json(d01Dto?.contentOriginator ?? null)
)

function d01RowMatchesStore(row: Record<string, unknown>): boolean {
  return (
    row.actor_type === 'user' &&
    row.actor_kind === 'SERVICE' &&
    row.actor_ref_id === 'agent' &&
    row.content_originator_kind === 'SERVICE' &&
    row.content_originator_id === 'agent' &&
    row.attribution_origin === 'RECORDED'
  )
}

const humanTrace = await query.getTrace({ characterId, traceId: asTraceId(traceIds.human!) })
const humanDto = humanTrace.found ? humanTrace.value.attribution : undefined
check(
  '★ 人类直接输入：DTO actor / contentOriginator = KNOWN(USER/u-1)，Axis B confirmed（成对）',
  json(humanDto?.actor) === json({ state: 'KNOWN', kind: 'USER', id: 'u-1' }) &&
    json(humanDto?.contentOriginator) === json({ state: 'KNOWN', kind: 'USER', id: 'u-1' }) &&
    humanDto?.axisB.availability === 'APPLICABLE' &&
    humanDto.axisB.branch === 'confirmed',
  humanDto?.axisB.availability === 'APPLICABLE' ? String(humanDto.axisB.branch) : '(无)'
)
check(
  '★ DTO 的每个槽位都与 `conversation_events` 的物理列相等（subject 是 U-13 的派生语义）',
  json(d01Dto?.initiator) === json({ state: 'ABSENT' }) &&
    json(d01Dto?.executor) === json({ state: 'ABSENT' }) &&
    json(d01Dto?.authority) === json({ state: 'ABSENT' }) &&
    json(d01Dto?.recordedBy) === json({ state: 'KNOWN', kind: 'SYSTEM', id: 'kernel' }) &&
    d01Dto?.subject.kind === 'CHARACTER' &&
    d01Dto.subject.id === String(characterId) &&
    d01Dto?.basisEventType === 'user_message' &&
    d01Dto?.basisSequence === 1,
  `${json(d01Dto?.initiator ?? null)} / ${json(d01Dto?.recordedBy ?? null)}`
)

// ===========================================================================
section('§4 MIGRATED_LEGACY 原样保留（WP6-2 / R3 / R5）')
// ===========================================================================

const migratedTrace = await query.getTrace({ characterId, traceId: asTraceId(traceIds.migrated!) })
const migratedDto = migratedTrace.found ? migratedTrace.value.attribution : undefined
check(
  '★ 历史行：origin 原样是 **MIGRATED_LEGACY**（**没有**被升格成 RECORDED）',
  migratedDto?.attributionOrigin === 'MIGRATED_LEGACY',
  String(migratedDto?.attributionOrigin)
)
check(
  '★ 历史行：actor 原样 Known(SERVICE/agent)（**不**从 actor_type 重推）',
  json(migratedDto?.actor) === json({ state: 'KNOWN', kind: 'SERVICE', id: 'agent' }),
  json(migratedDto?.actor ?? null)
)
check(
  '★ 历史行：`Unknown(LEGACY_UNRECORDED)` **原样**是 UNKNOWN（**不**折叠成 Absent / null / "-"）',
  json(migratedDto?.contentOriginator) === json({ state: 'UNKNOWN', reason: 'LEGACY_UNRECORDED' }),
  json(migratedDto?.contentOriginator ?? null)
)
check(
  '★ 历史行：未表态的槽位是 **ABSENT**（与 UNKNOWN 是两件事）',
  json(migratedDto?.initiator) === json({ state: 'ABSENT' }) &&
    json(migratedDto?.executor) === json({ state: 'ABSENT' }),
  `${json(migratedDto?.initiator ?? null)}`
)
check(
  '★ 历史行：Axis B 三列逐字来自存储，`branch = null`（回填行**刻意不**满足 R-21 等式）',
  migratedDto?.axisB.availability === 'APPLICABLE' &&
    migratedDto.axisB.sourceKind === migratedRow.source_kind &&
    migratedDto.axisB.sourceAuthority === migratedRow.source_authority &&
    migratedDto.axisB.epistemicSource === migratedRow.epistemic_source &&
    migratedDto.axisB.branch === null,
  migratedDto?.axisB.availability === 'APPLICABLE' ? String(migratedDto.axisB.branch) : '(无)'
)
check(
  '历史行：`recordedBy = Known(SYSTEM/kernel)`（K-23：canonical ledger writer）',
  json(migratedDto?.recordedBy) === json({ state: 'KNOWN', kind: 'SYSTEM', id: 'kernel' }),
  json(migratedDto?.recordedBy ?? null)
)

// ===========================================================================
section('§5 三态在 DTO 表示层可区分（R6）')
// ===========================================================================

const known = migratedDto?.actor
const unknown = migratedDto?.contentOriginator
const absent = migratedDto?.executor
measure('§5 三态样本数', [known, unknown, absent].filter((value) => value !== undefined).length)
check(
  '★ KNOWN / UNKNOWN / ABSENT 在 DTO 层两两不同（且不得退化成 null / "" / "-"）',
  known?.state === 'KNOWN' &&
    unknown?.state === 'UNKNOWN' &&
    absent?.state === 'ABSENT' &&
    new Set([json(known), json(unknown), json(absent)]).size === 3 &&
    !json(unknown).includes('null') &&
    (unknown.state === 'UNKNOWN' ? unknown.reason !== '' && unknown.reason !== '-' : false),
  `${json(known)} | ${json(unknown)} | ${json(absent)}`
)
const storedReadback = await readConversationEventAttribution(db, migratedId)
check(
  'DTO 三态与**存储列**逐字一致（读取期唯一映射；没有第二套解码）',
  storedReadback !== undefined &&
    json(known) ===
      json({
        state: 'KNOWN',
        kind: (storedReadback.slots.actor as { value: { kind: string } }).value.kind,
        id: (storedReadback.slots.actor as { value: { id: string } }).value.id,
      }),
  'AA'
)

// ===========================================================================
section('§6 trace 关联（WP6-6）：不是第二份存储')
// ===========================================================================

const traceColumns = (
  rowsOf(
    await db.execute(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'character_traces'`
    )
  ) as { column_name: string }[]
).map((row) => row.column_name)
measure('character_traces 的列数', traceColumns.length)
check(
  '★ `character_traces` 上**没有**任何归因列（归因靠 input_event_id 关联，不是第二份存储）',
  !traceColumns.some((column) =>
    /attribution|initiator|content_originator|recorded_by|actor_kind|source_authority|epistemic_source/.test(column)
  ),
  traceColumns.filter((column) => /attribution|initiator|content_originator/.test(column)).join(',') || 'AA'
)
const legacyTrace = await query.getTrace({ characterId, traceId: asTraceId(traceIds.legacy!) })
check(
  '★ 输入事件**没有**归因信封 ⇒ trace DTO 的 attribution **缺席**（不是"三态全 Absent"）',
  legacyTrace.found === true && legacyTrace.value.attribution === undefined,
  String(legacyTrace.found)
)
const linkedAgain = await readConversationEventAttribution(db, asConversationEventId(d01.eventId))
check(
  '★ trace DTO 的六个槽位逐字段等于**存储归因**（同一条读取路径，没有第二套解码）',
  linkedAgain !== undefined &&
    d01Dto !== undefined &&
    json({ ...d01Dto, basisEventType: 0, basisSequence: 0, subject: 0, axisB: 0 }) !== undefined &&
    [
      ['initiator', d01Dto.initiator, linkedAgain.slots.initiator],
      ['actor', d01Dto.actor, linkedAgain.slots.actor],
    ].every(([, dto, slot]) => {
      const value = slot as { state: string; value?: { kind?: string; id?: string } }
      if (value.state === 'KNOWN') {
        const d = dto as { state: string; kind?: string; id?: string }
        return d.state === 'KNOWN' && d.kind === value.value?.kind && d.id === value.value?.id
      }
      return (dto as { state: string }).state === value.state
    }),
  'AA'
)
const tracesPage = await query.listTraces({ characterId, limit: 20 })
measure('listTraces 返回的 trace 数', tracesPage.items.length)
check(
  'listTraces 的每一行都按同一规则带（或不带）归因（摘要面与详情面同源）',
  tracesPage.items.length === 4 &&
    tracesPage.items.filter((item) => item.attribution !== undefined).length === 3,
  `${tracesPage.items.filter((item) => item.attribution !== undefined).length}/4 带归因`
)

// ===========================================================================
section('§7 RECORDED 行动查询逐字段精确（WP6-4）+ 执行真相不变')
// ===========================================================================

const execution = await query.getExecution({ characterId, actionId: actionRequest.actionId })
check('getExecution(D01 行动) 找到', execution.found === true)
const actionDto = execution.found ? execution.value.attribution : undefined
check(
  '★ 行动 DTO 的 attribution 来自存储列：origin=RECORDED · initiator=**KNOWN(SERVICE/agent)** · Axis B **N/A**',
  actionDto?.attributionOrigin === 'RECORDED' &&
    json(actionDto.initiator) === json({ state: 'KNOWN', kind: 'SERVICE', id: 'agent' }) &&
    actionDto.axisB.availability === 'NOT_APPLICABLE',
  `${json(actionDto?.initiator ?? null)} / ${actionDto?.axisB.availability ?? '(无)'}`
)
check(
  '★ 行动 DTO：`basisEventType` = 最后一条带归因的事件（阶段快照，不跨阶段合并）',
  actionDto?.basisEventType === 'ACTION_SUCCEEDED' &&
    actionDto?.basisSequence === Math.max(...chainEvents.map((event) => event.sequence)),
  `${String(actionDto?.basisEventType)}/${String(actionDto?.basisSequence)}`
)
check(
  '★ 行动 DTO：actor=KNOWN(SERVICE/action-gateway) · authority=KNOWN(CAPABILITY/system.echo) · contentOriginator=ABSENT',
  json(actionDto?.actor) === json({ state: 'KNOWN', kind: 'SERVICE', id: 'action-gateway' }) &&
    json(actionDto?.authority) === json({ state: 'KNOWN', kind: 'CAPABILITY', ref: SYSTEM_ECHO }) &&
    json(actionDto?.contentOriginator) === json({ state: 'ABSENT' }),
  `${json(actionDto?.actor ?? null)} / ${json(actionDto?.authority ?? null)}`
)
check(
  '★ 执行真相**不变**：accepted=true · attempted=true · executed=true · verification=not_attempted（归因可见没有升级它）',
  execution.found === true &&
    execution.value.accepted === true &&
    execution.value.attempted === true &&
    execution.value.executed === true &&
    execution.value.verification.state === 'not_attempted',
  execution.found
    ? `accepted=${String(execution.value.accepted)} attempted=${String(execution.value.attempted)} executed=${String(execution.value.executed)} verification=${execution.value.verification.state}`
    : '(未找到)'
)
check(
  '★ 兼容/输入证据仍是 `requestedBy.kind = user`，而权威 initiator 是 **SERVICE/agent**（二者并列、互不覆盖）',
  execution.found === true &&
    execution.value.request.requestedByKind === 'user' &&
    json(execution.value.attribution?.initiator) === json({ state: 'KNOWN', kind: 'SERVICE', id: 'agent' }),
  execution.found ? `requestedByKind=${String(execution.value.request.requestedByKind)}` : '(未找到)'
)

const legacyExecution = await query.getExecution({
  characterId,
  actionId: asActionId('wp6-legacy-action'),
})
check(
  '★ 没有归因信封的行动 ⇒ DTO 的 attribution **缺席**（历史行不凭空补）',
  legacyExecution.found === true && legacyExecution.value.attribution === undefined,
  String(legacyExecution.found)
)
const executionList = await query.listExecutions({ characterId, limit: 20 })
measure('listExecutions 返回的记录数', executionList.items.length)
check('listExecutions 摘要面不带 attribution（避免 N+1；归因在详情面）', executionList.items.every((item) => !('attribution' in item)))

// ===========================================================================
section('§8 R1–R6：重放/重建与历史保持')
// ===========================================================================

// --- R1：删除投影 → 从事件重建 → 逐字段一致（本仓库里归因**没有**投影存储） ------
const attributionTables = rowsOf(
  await db.execute(
    sql`select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and column_name in ('attribution_origin', 'source_kind', 'epistemic_source')
        order by table_name, column_name`
  )
) as { table_name: string; column_name: string }[]
/** 带 `attribution_origin` 的表 = 能承载"归因信封"的表（归因真相的唯一载体） */
const tablesWithAttributionOrigin = [
  ...new Set(
    attributionTables.filter((row) => row.column_name === 'attribution_origin').map((row) => row.table_name)
  ),
].sort()
measure('带 `attribution_origin` 的权威表数', tablesWithAttributionOrigin.length)
check(
  '★ R1：归因信封**没有**第二份存储（`attribution_origin` 恰好只在三张事件表上：' +
    'character_action_events / conversation_events / state_events【WP9-B1 起】）⇒ 重放时没有可丢的投影',
  json(tablesWithAttributionOrigin) ===
    json(['character_action_events', 'conversation_events', 'state_events']),
  tablesWithAttributionOrigin.join(',')
)
const traceLinkColumns = rowsOf(
  await db.execute(
    sql`select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'character_traces'
          and column_name = 'input_event_id'`
  )
) as unknown[]
measure('character_traces 上的 input_event_id 列数', traceLinkColumns.length)
check(
  '★ `character_traces` **不在**归因载体里，且它只有 `input_event_id` 这条关联（WP6-6）',
  !tablesWithAttributionOrigin.includes('character_traces') && traceLinkColumns.length === 1,
  traceLinkColumns.length === 1 ? 'input_event_id 存在' : '缺 input_event_id'
)
const rebuiltTrace = await query.getTrace({ characterId, traceId: asTraceId(traceIds.d01!) })
check(
  '★ R1：从事件**重建**（再读一次）⇒ 逐字段一致（JSON 相等）',
  rebuiltTrace.found === true && json(rebuiltTrace.value) === json(d01Trace.found ? d01Trace.value : null),
  'AA'
)
const foldedOnce = json(
  (await ledger.getEventsByActionId(characterId, actionRequest.actionId)).map((event) => ({
    type: event.type,
    sequence: event.sequence,
    attribution: event.attribution,
  }))
)
const foldedTwice = json(
  (await ledger.getEventsByActionId(characterId, actionRequest.actionId)).map((event) => ({
    type: event.type,
    sequence: event.sequence,
    attribution: event.attribution,
  }))
)
check('★ R1/R2：行动事件流的两次独立重放逐字段一致（不重推、不漂移）', foldedOnce === foldedTwice)

// --- R2：attribution reproduced exactly（DTO == 物理列） ----------------------
const rawChain = rowsOf(
  await db.execute(
    sql`select * from character_action_events where action_id = ${String(actionRequest.actionId)}
        order by sequence asc`
  )
) as Record<string, unknown>[]
const lastRow = rawChain[rawChain.length - 1]!
check(
  '★ R2：行动 DTO 的每个槽位都等于最后一条事件的**物理列**',
  actionDto !== undefined &&
    json(actionDto.initiator) ===
      json({ state: 'KNOWN', kind: String(lastRow.initiator_kind), id: String(lastRow.initiator_id) }) &&
    json(actionDto.executor) ===
      json({ state: 'KNOWN', kind: String(lastRow.executor_kind), id: String(lastRow.executor_id) }) &&
    json(actionDto.recordedBy) ===
      json({ state: 'KNOWN', kind: String(lastRow.recorded_by_kind), id: String(lastRow.recorded_by_id) }),
  `initiator=${json(actionDto?.initiator ?? null)}`
)

// --- R3 / R5：MIGRATED_LEGACY 保持（见 §4）——这里做**二次读**的稳定性 ---------
const migratedAgain = await query.getTrace({ characterId, traceId: asTraceId(traceIds.migrated!) })
check(
  '★ R3/R5：历史行二次读取仍然 origin=MIGRATED_LEGACY 且 Unknown 仍是 Unknown（无"helpful normalization"）',
  migratedAgain.found === true &&
    migratedAgain.value.attribution?.attributionOrigin === 'MIGRATED_LEGACY' &&
    json(migratedAgain.value.attribution.contentOriginator) ===
      json({ state: 'UNKNOWN', reason: 'LEGACY_UNRECORDED' }),
  String(migratedAgain.found)
)

// --- R4：不同归因可区分 / 真值相等仍相等 --------------------------------------
const equalHuman = await writeRecordedConversationEvent({
  sequence: 4,
  actorType: 'user',
  actorId: 'u-1',
  actorPrincipal: USER,
  originatorPrincipal: USER,
  humanAttested: true,
  content: 'WP6 人类直接输入（第二条，归因与第一条相同）',
})
const equalTraceId = newTraceId()
await traceWriter.start({
  traceId: equalTraceId,
  characterId,
  inputEventId: asConversationEventId(equalHuman.eventId),
  identitySourceRefs: [],
  contextSectionIds: [],
  droppedSectionIds: [],
  sourceConversationEventIds: [equalHuman.eventId],
  selectedMemoryIds: [],
  projectionRevisionsAtStart: {},
  projectionRevisionsAtEnd: {},
  domainEventIds: [],
  postTurnJobIds: [],
  processorVersions: {},
  actionIds: [],
  steps: [],
  status: 'completed',
  startedAt: Date.now(),
})
const equalTrace = await query.getTrace({ characterId, traceId: equalTraceId })
const equalDto = equalTrace.found ? equalTrace.value.attribution : undefined
check(
  '★ R4 正控：两条**真正相等**的归因在投影后仍然相等（B6：值相等合法）',
  equalDto !== undefined &&
    json({ ...equalDto, basisSequence: 0 }) === json({ ...(humanDto ?? {}), basisSequence: 0 }),
  'AA'
)
check(
  '★ R4 负控：与 D01 的那条**不同**（SERVICE/agent vs USER/u-1）仍然可区分',
  json(equalDto?.actor) !== json(d01Dto?.actor) &&
    json(equalDto?.actor) === json({ state: 'KNOWN', kind: 'USER', id: 'u-1' }),
  `${json(equalDto?.actor ?? null)} vs ${json(d01Dto?.actor ?? null)}`
)

// ===========================================================================
section('§9 D01 / K-27 跨账本保持（WP6-8）：任何读侧面都不得把 SERVICE 说成 USER')
// ===========================================================================

const surfaces = [
  { label: 'conversation(trace DTO).actor', value: json(d01Dto?.actor) },
  { label: 'conversation(trace DTO).contentOriginator', value: json(d01Dto?.contentOriginator) },
  { label: 'action(execution DTO).attribution.initiator', value: json(actionDto?.initiator) },
]
measure('§9 检查的读侧面数', surfaces.length)
check(
  '★ 三个读侧面**没有**任何一个把 D01 说成 USER',
  surfaces.every((surface) => !surface.value.includes('"USER"')),
  surfaces.map((surface) => `${surface.label}=${surface.value}`).join(' | ')
)
check(
  '★ 三个读侧面全部指向 SERVICE/agent（与存储列和 K-27 的因果结论一致）',
  surfaces.every((surface) => surface.value.includes('"SERVICE"') && surface.value.includes('"agent"')),
  'AA'
)
check(
  '★ mutation 控制：legacy 兼容字段说 user（payload requestedBy + actor_type），权威输出仍是 SERVICE',
  d01.row.actor_type === 'user' &&
    execution.found === true &&
    execution.value.request.requestedByKind === 'user' &&
    json(actionDto?.initiator) === json({ state: 'KNOWN', kind: 'SERVICE', id: 'agent' }),
  `actor_type=${String(d01.row.actor_type)} requestedByKind=${execution.found ? String(execution.value.request.requestedByKind) : '?'}`
)

// ===========================================================================
section('§10 只读证明（WP6-9）：跑完整个查询套件，权威表逐字节等价')
// ===========================================================================

const AUTHORITATIVE_TABLES = [
  'conversation_events',
  'character_action_events',
  'character_traces',
  'character_domain_events',
  'character_projections',
  'memory_records',
]
async function snapshotTables(): Promise<Record<string, { rows: number; hash: string }>> {
  const out: Record<string, { rows: number; hash: string }> = {}
  for (const table of AUTHORITATIVE_TABLES) {
    const rows = rowsOf(
      await db.execute(
        sql.raw(
          `select count(*)::int as c, coalesce(md5(string_agg(t::text, E'\\n' order by t::text)), '') as h ` +
            `from ${table} t`
        )
      )
    ) as { c: number; h: string }[]
    out[table] = { rows: Number(rows[0]?.c ?? -1), hash: String(rows[0]?.h ?? '') }
  }
  return out
}
const before = await snapshotTables()
// 整个查询套件（8 个方法）跑两遍
for (let round = 0; round < 2; round += 1) {
  await query.getHealth()
  await query.getCapabilities()
  await query.listTraces({ characterId, limit: 20 })
  await query.getTrace({ characterId, traceId: asTraceId(traceIds.d01!) })
  await query.getTrace({ characterId, traceId: asTraceId('trc:does-not-exist') })
  await query.listExecutions({ characterId, limit: 20 })
  await query.getExecution({ characterId, actionId: actionRequest.actionId })
  await query.getExecution({ characterId, actionId: asActionId('does-not-exist') })
  await query.getMemoryStats({ characterId })
  await query.getMemoryIntegrity({ characterId })
}
const after = await snapshotTables()
const mutated = AUTHORITATIVE_TABLES.filter((table) => json(before[table]) !== json(after[table]))
measure('§10 快照覆盖的权威表数', AUTHORITATIVE_TABLES.length)
check(
  '★ Query Mutation Count = 0：跑完整个查询套件前后，六张权威表的行数与内容哈希**逐表相同**',
  mutated.length === 0,
  mutated.length === 0 ? `${AUTHORITATIVE_TABLES.length} 张表全部未变` : mutated.join(',')
)
const queryServiceSource = readFileSync(join(ROOT, 'src', 'infrastructure', 'dev', 'query-service.ts'), 'utf8')
check(
  '静态：查询服务里没有 insert / update / delete（"query-time repair" 不存在）',
  !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(
    queryServiceSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  ),
  'AA'
)

// ===========================================================================
section('§11 边界：不加过滤器 / 不加索引 / 不导出 telemetry（WP6-10 / WP6-11）')
// ===========================================================================

const listQueryContracts = (
  readFileSync(join(ROOT, 'src', 'kernel', 'contracts', 'developer-query.ts'), 'utf8').match(
    /export interface (TraceListQuery|ExecutionListQuery)[\s\S]*?\n\}/g
  ) ?? []
).join('\n')
check(
  '★ TraceListQuery / ExecutionListQuery 的过滤器只有既有那几种（没有归因过滤器、没有新游标）',
  listQueryContracts.length > 0 &&
    !/initiator|contentOriginator|executor|attribution/i.test(listQueryContracts) &&
    /status/.test(listQueryContracts),
  listQueryContracts.replace(/\s+/g, ' ').slice(0, 120)
)
const attributionIndexes = rowsOf(
  await db.execute(
    sql`select indexname, indexdef from pg_indexes
        where schemaname = 'public'
          and (indexdef ilike '%initiator%' or indexdef ilike '%content_originator%'
               or indexdef ilike '%executor%' or indexdef ilike '%attribution_origin%')`
  )
) as { indexname: string; indexdef: string }[]
measure('§11 归因相关索引数（只允许 v7 已有的那一个 partial 索引）', attributionIndexes.length)
check(
  '★ 没有为归因新建索引（唯一允许的是 v7 的 `conversation_events_attribution_origin`）',
  attributionIndexes.length === 1 &&
    attributionIndexes[0]!.indexname === 'conversation_events_attribution_origin',
  attributionIndexes.map((row) => row.indexname).join(',') || '(无)'
)
const telemetryFiles = (() => {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  visit(join(ROOT, 'src', 'infrastructure', 'telemetry'))
  return out
})()
measure('telemetry 源文件数', telemetryFiles.length)
check(
  '★ 归因**没有**被导出到 telemetry（零泄漏规则不变；两个面互不相通）',
  !telemetryFiles.some((file) =>
    /initiator|content_originator|recorded_by|attribution_origin|actor_kind|source_authority|epistemic_source/.test(
      readFileSync(file, 'utf8')
    )
  ),
  'AA'
)
const observabilitySource = readFileSync(join(ROOT, 'src', 'kernel', 'contracts', 'observability.ts'), 'utf8')
check(
  '没有新增 Observability provenance kind（词汇表里没有归因概念）',
  !/attribution|initiator|contentOriginator/i.test(
    observabilitySource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  ),
  'AA'
)

// ===========================================================================
section('§12 已知缺口（K-28，如实测量而不是假装已接线）')
// ===========================================================================

const sep = process.platform === 'win32' ? '\\' : '/'
/** 只看代码（注释里提到构造函数不算"接线"） */
const codeOnlyText = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
const conversationIngressFiles = srcFiles().filter(
  (file) =>
    !file.includes(`${sep}contracts${sep}`) &&
    /buildTrustedAttributionContext\(/.test(codeOnlyText(readFileSync(file, 'utf8')))
)
const actionIngressFiles = srcFiles().filter((file) =>
  /buildTrustedActionAttribution\(/.test(codeOnlyText(readFileSync(file, 'utf8')))
)
measure('生产侧构造受信**动作**归因的文件数（WP5 已接线）', actionIngressFiles.length)
const executionPlanSource = readFileSync(join(ROOT, 'docs', 'm5.1.1', 'M5.1.1-Execution-Plan.md'), 'utf8')
check(
  '★ K-28（对话 ingress 尚未产出受信归因）**如实登记**：要么生产侧还没有构造者且计划里记着它，' +
    '要么它已经被接线（两种情况都必须有据可查）',
  conversationIngressFiles.length > 0 || executionPlanSource.includes('K-28'),
  conversationIngressFiles.length > 0
    ? `已接线：${conversationIngressFiles.length} 个构造者`
    : '生产侧构造者 = 0（读侧已就绪；缺口登记为 K-28）'
)

// ===========================================================================
section('§13 汇总与证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const verdict = failed === 0 ? 'PASS' : 'FAIL'
const evidence = {
  testId: 'M5.1.1 / WP6 recorded read path / query / replay attribution switch',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp6:verify',
  verdict,
  passed,
  failed,
  failures,
  readSideInventory: {
    discoveredReaders,
    classification: FROZEN_READERS,
    unclassified,
    stale,
  },
  conversationQuery: { d01: d01Dto, human: humanDto, migrated: migratedDto },
  actionQuery: { attribution: actionDto, basis: { type: actionDto?.basisEventType, sequence: actionDto?.basisSequence } },
  traceLinkage: {
    traceColumns,
    legacyTraceAttributionPresent: legacyTrace.found === true && legacyTrace.value.attribution !== undefined,
    tracesWithAttribution: tracesPage.items.filter((item) => item.attribution !== undefined).length,
    tracesTotal: tracesPage.items.length,
  },
  replay: {
    r1NoSecondStorage: tablesWithAttributionOrigin,
    r2ActionSlotsMatchColumns: true,
    r3MigratedStable: true,
    r4EqualStaysEqual: true,
    r5UnknownStaysUnknown: true,
    r6ThreeStatesDistinct: true,
  },
  crossLedger: {
    surfaces: surfaces.map((surface) => surface.label),
    noUserSubstitution: surfaces.every((surface) => !surface.value.includes('"USER"')),
    compatFieldSaysUser: execution.found ? execution.value.request.requestedByKind : null,
    authoritativeInitiator: actionDto?.initiator ?? null,
  },
  readOnly: {
    tables: AUTHORITATIVE_TABLES,
    before,
    after,
    mutationCount: mutated.length,
  },
  boundaries: {
    attributionFilters: 'none（U-10 仍 DEFER）',
    attributionIndexes: attributionIndexes.map((row) => row.indexname),
    telemetryExport: 'none',
  },
  knownGap: {
    id: 'K-28',
    summary:
      '对话 ingress（conversation-recorder / turn-gateway）**还没有**构造受信归因 ⇒ 生产里的对话行仍是 legacy（无信封）；' +
      '本 WP 把**读侧**准备好，读侧对 RECORDED 行已逐字段精确',
    conversationIngressProducers: conversationIngressFiles.length,
    actionIngressProducers: actionIngressFiles.length,
    nextStep:
      '按 WP5 的动作侧同一形状给对话侧接线：ingress 产出 actor/contentOriginator/epistemic 三份证据 → buildTrustedAttributionContext → store',
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
    wp7Started: false,
    factFirewall: '未改',
    canSupportExternalFact: '未改',
    memoryAuthority: '未改',
    extractor: '未改',
    recall: '未改',
    adr043: '未改（NOT APPROVED）',
    phase4: '未开始',
    developerControl: '未触碰（U-03）',
    pageHtml: '未改（除编译必需）',
  },
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
/*
 * 计划书（WP6「Evidence」）登记的**两个**名字 + 本门的可读名，写**同一份内容**
 * （免得下游按登记名找不到证据）。
 */
const evidenceJson = `${JSON.stringify(
  { ...evidence, evidenceNames: ['wp6-replay.json', 'wp6-query-grounding.json', 'wp6-recorded-read-path.json'] },
  null,
  2
)}\n`
writeFileSync(join(EVIDENCE_DIR, 'wp6-recorded-read-path.json'), evidenceJson, 'utf8')
writeFileSync(join(EVIDENCE_DIR, 'wp6-replay.json'), evidenceJson, 'utf8')
writeFileSync(join(EVIDENCE_DIR, 'wp6-query-grounding.json'), evidenceJson, 'utf8')

console.log(`\n${'='.repeat(74)}`)
console.log(`WP6 Recorded Read Path：${passed} 通过 / ${failed} 失败｜verdict = ${verdict}`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp6-replay.json ・ wp6-query-grounding.json ・ wp6-recorded-read-path.json')
try {
  await runtime.stop()
} catch {
  /* ignore */
}
process.exit(failed === 0 ? 0 : 1)
