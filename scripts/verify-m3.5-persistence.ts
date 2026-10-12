/**
 * M3.5 持久化验证 —— 迁移 0004 与"未来位置"的落库行为。
 *
 * ============================================================================
 *  这些是**契约测试**，不是功能测试
 * ============================================================================
 * M3.5 没有新增任何用户可见能力。它加的是 nullable 列与少量语义槽，
 * 因此本文件要证明的全部内容是：
 *
 *   1. 迁移 0004 真的应用了，而且**只加列**（旧行照常可读）
 *   2. `occurred_at ≠ recorded_at` 能落库并原样读回（FC-T06 的持久化半边）
 *   3. `trigger_kind` 的默认值与取值都正确（FC-T07 的持久化半边）
 *   4. Trace 的四个语义槽能落库并原样读回（计划书第 85 / 89 节）
 *   5. **append-only 没有被侵蚀**：新增的列一个都没出现在 UPDATE 语句里
 *
 * 第 5 条是这份文件里最重要的一条：M3 立下的规矩是
 * `delivery_status` 是 `conversation_events` 上**唯一**允许 UPDATE 的列。
 * 加列这件事最容易悄悄破掉它（"顺手把 occurred_at 也更新一下"）。
 *
 * ---------------------------------------------------------------------------
 *  全部在**沙箱库**上跑，绝不碰真实库
 * ---------------------------------------------------------------------------
 * 与 `verify-m3-persistence.ts` 同一个隔离机制（`isolateDatabase`）。
 * 真实库的升级是一个**显式动作**（`pnpm migrate:apply`），不在这里做。
 *
 * 跑法：pnpm m3.5:verify
 */

import 'dotenv/config'

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { AgentRuntime, stringToUuid, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import openaiPlugin from '@elizaos/plugin-openai'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import { currentSchemaVersion, exec } from '../src/infrastructure/persistence/db.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import { latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'
import { enqueueJob, findJobByIdempotencyKey } from '../src/infrastructure/persistence/job-store.ts'
import { createTraceWriter } from '../src/infrastructure/persistence/trace-store.ts'
import { latestConversationSequence, markDeliveryStatus } from '../src/infrastructure/persistence/conversation-store.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  asConversationId,
  conversationObservationFrom,
  createSpeechIntent,
  newTraceId,
  type CharacterRunTrace,
} from '../src/kernel/contracts/index.ts'
import { createConversationIntentResolver } from '../src/infrastructure/runtime/conversation-intent-resolver.ts'

// ---------------------------------------------------------------------------
// 极简检查器（与既有 verify-*.ts 风格一致）
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ---------------------------------------------------------------------------
// 隔离环境
// ---------------------------------------------------------------------------

const sandbox = isolateDatabase('m3.5-persistence-verify', { keep: true })
const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')

const runtime = new AgentRuntime({
  character: character as Character,
  plugins: [
    openaiPlugin,
    bootstrapPlugin,
    openAiCompatiblePlugin,
    createPersistentCharacterPlugin({ characterId, userId }),
  ] as Plugin[],
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
})

await initDatabase(runtime, sqlPlugin)
await runtime.initialize()

const db = getRawDb(runtime)

// ===========================================================================
section('1. 迁移 0004：只加列，且旧行照常可读')
// ===========================================================================

const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character as never),
})

const appliedVersions = (
  await exec(db, sql`select version from character_schema_migrations order by version asc`, '读取已应用迁移')
).map((r) => Number(r.version))

const schemaVersion = await currentSchemaVersion(db)
check(
  'schema 已到最新版本（精确断言由这里负责，M3 的脚本只断言 >= 3）',
  schemaVersion === latestSchemaVersion(),
  `version=${schemaVersion} latest=${latestSchemaVersion()}`
)
/*
 * ⚠️ 这条断言**改过一次写法**，值得记下来。
 *
 * 原来写的是 `schemaVersion === 4`，本意是"迁移 0004 已应用"。
 * 但"最大版本恰为 4"与"0004 在已应用集合里"不是同一句话 ——
 * 前者会在**每加一个新迁移**时失败（M4 的 0005 一加，它就红了），
 * 而它想守的那件事（0004 应用过）完全没有被破坏。
 *
 * 那是一条"看起来在守规矩、其实在随机失败"的断言：
 * 它没有测出任何真实缺陷，只会让下一个开发者去怀疑 0004。
 * 改成断**集合包含**之后，它守的还是同一件事，但不再对无关改动敏感。
 */
check(
  '迁移 0004 已应用（在已应用集合里，而不是"最大版本恰为 4"）',
  appliedVersions.includes(4),
  `已应用=[${appliedVersions.join(',')}]`
)
check(
  '迁移版本连续无空洞',
  appliedVersions.every((v, i) => v === i + 1),
  `已应用=[${appliedVersions.join(',')}]`
)

/** 某张表是否拥有某列（pglite 就是 postgres，因此 information_schema 可用） */
async function hasColumn(table: string, column: string): Promise<boolean> {
  const rows = (await exec(
    db,
    sql`select column_name from information_schema.columns
        where table_name = ${table} and column_name = ${column}`,
    '查询列是否存在'
  )) as unknown as { column_name?: string }[]
  return rows.some((row) => String(row.column_name) === column)
}

const addedColumns: [string, string][] = [
  ['conversation_events', 'occurred_at'],
  ['conversation_events', 'logical_time'],
  ['character_domain_events', 'occurred_at'],
  ['character_domain_events', 'logical_time'],
  ['character_jobs', 'trigger_kind'],
  ['character_traces', 'observation_id'],
  ['character_traces', 'observation_type'],
  ['character_traces', 'intent_id'],
  ['character_traces', 'intent_type'],
]
for (const [table, column] of addedColumns) {
  check(`${table}.${column} 存在`, await hasColumn(table, column))
}

// 旧行（迁移之前写入的行）在这四列上必须是 NULL，而不是被回填成某个值
const nullRows = (await exec(
  db,
  sql`select count(*)::int as c from conversation_events
      where occurred_at is not null or logical_time is not null`,
  '统计有发生时间的行'
)) as unknown as { c: number }[]
check(
  '新库里没有"被回填"的时间列（不重写历史行，计划书第 83 节）',
  Number(nullRows[0]?.c ?? 0) === 0,
  `非空行=${Number(nullRows[0]?.c ?? 0)}`
)

// ===========================================================================
section('2. 时间模型：occurred_at ≠ recorded_at 能落库并读回（FC-T06）')
// ===========================================================================

const ledger = createConversationLedger({ db, defaultTransport: 'cli' })
const conversationId = asConversationId('dm-m35-verify')
const recordedAt = 1_760_000_000_000
const occurredAt = 1_759_900_000_000

const userAppend = await ledger.appendUserStatement({
  characterId: kernel.characterId,
  conversationId,
  userId: 'user-m35',
  content: '这是很久以前说的。',
  conversationSequence: 1,
  transport: 'cli',
  createdAt: recordedAt,
  occurredAt,
})

check(
  '用户事件的两个时间都被落库',
  userAppend.event.createdAt === recordedAt && userAppend.event.occurredAt === occurredAt,
  `createdAt=${userAppend.event.createdAt} occurredAt=${userAppend.event.occurredAt}`
)

const readBack = await ledger.getById(userAppend.event.id)
check(
  '从库里读回来仍是两个不同的时间（不是只活在内存返回值里）',
  readBack?.createdAt === recordedAt && readBack?.occurredAt === occurredAt,
  `createdAt=${readBack?.createdAt} occurredAt=${readBack?.occurredAt}`
)
check('logical_time 落库为 NULL（M3.5 不建模拟时钟）', readBack?.logicalTime === undefined)

// 不传 occurredAt 时读回来必须是 undefined —— "不知道"不能被存成"就是现在"
const secondAppend = await ledger.appendSystemEvent({
  characterId: kernel.characterId,
  conversationId,
  source: 'scheduler',
  content: '系统通知（没有发生时间）。',
  conversationSequence: 2,
  createdAt: recordedAt,
})
const secondRead = await ledger.getById(secondAppend.event.id)
check(
  '不传 occurredAt → 读回来是 undefined（"不知道"必须能与"就是此刻"区分）',
  secondRead?.occurredAt === undefined,
  `occurredAt=${String(secondRead?.occurredAt)}`
)

// 写入非法的模拟时间必须被拒绝（契约层失败关闭，落库之前就挡住）
let logicalTimeRejected = false
try {
  await ledger.appendUserStatement({
    characterId: kernel.characterId,
    conversationId,
    userId: 'user-m35',
    content: '模拟时间不该能写进来。',
    conversationSequence: 3,
    logicalTime: '第 12 天清晨',
  })
} catch {
  logicalTimeRejected = true
}
check('写入 logicalTime → 被拒绝（不要建半个时钟）', logicalTimeRejected)

// ===========================================================================
section('3. 触发模型：trigger_kind（FC-T07）')
// ===========================================================================

const job = await enqueueJob(db, {
  characterId: kernel.characterId,
  processor: 'm35-verify',
  processorVersion: 'm35-verify@1',
  sourceFromSequence: 1,
  sourceToSequence: 2,
  idempotencyKey: 'idem:m35:verify:conversation',
})
check('缺省触发是 conversation', job.job.triggerKind === 'conversation', String(job.job.triggerKind))

const jobRead = await findJobByIdempotencyKey(db, 'idem:m35:verify:conversation')
check(
  'trigger_kind 落库并读回（不是只活在内存对象里）',
  jobRead?.triggerKind === 'conversation',
  String(jobRead?.triggerKind)
)

const systemJob = await enqueueJob(db, {
  characterId: kernel.characterId,
  processor: 'm35-verify',
  processorVersion: 'm35-verify@1',
  sourceFromSequence: 0,
  sourceToSequence: 0,
  idempotencyKey: 'idem:m35:verify:system',
  triggerKind: 'system',
})
check(
  'triggerKind=system 可落库（Job 契约不依赖 Conversation Event）',
  systemJob.job.triggerKind === 'system',
  String(systemJob.job.triggerKind)
)

let reservedRejected = false
try {
  await enqueueJob(db, {
    characterId: kernel.characterId,
    processor: 'm35-verify',
    processorVersion: 'm35-verify@1',
    sourceFromSequence: 0,
    sourceToSequence: 0,
    idempotencyKey: 'idem:m35:verify:schedule',
    triggerKind: 'schedule',
  })
} catch {
  reservedRejected = true
}
check('triggerKind=schedule → 被拒绝（M3.5 没有调度器能产出它）', reservedRejected)

// ===========================================================================
section('4. Trace 的感知与意图语义槽（计划书第 85 / 89 节）')
// ===========================================================================

const traceWriter = createTraceWriter(db)
const traceId = newTraceId()
const startedAt = Date.now()

const trace: CharacterRunTrace = {
  traceId,
  characterId: kernel.characterId,
  inputEventId: userAppend.event.id,
  observationId: `obs:${String(userAppend.event.id)}`,
  observationType: 'CONVERSATION_OBSERVATION',
  intentId: 'int:m35-verify',
  intentType: 'SPEECH',
  contextCompilerVersion: 'context-compiler@2',
  contextSectionIds: ['identity-core'],
  droppedSectionIds: [],
  sourceConversationEventIds: [String(userAppend.event.id)],
  selectedMemoryIds: [],
  projectionRevisionsAtStart: {},
  projectionRevisionsAtEnd: {},
  domainEventIds: [],
  actionIds: [],
  postTurnJobIds: [],
  processorVersions: {},
  identitySourceRefs: ['character-definition:sumuwei@3'],
  steps: [],
  status: 'running',
  startedAt,
}
await traceWriter.start(trace)
await traceWriter.finish(traceId, { status: 'completed', finishedAt: Date.now() })

const storedTrace = await traceWriter.get(traceId)
check(
  '四个语义槽都能落库并读回',
  storedTrace?.observationId === `obs:${String(userAppend.event.id)}` &&
    storedTrace?.observationType === 'CONVERSATION_OBSERVATION' &&
    storedTrace?.intentId === 'int:m35-verify' &&
    storedTrace?.intentType === 'SPEECH',
  `obs=${storedTrace?.observationType} intent=${storedTrace?.intentType}`
)

// 没有感知/意图的轮次（合成轮次）必须是 undefined，而不是空字符串
const bareTraceId = newTraceId()
await traceWriter.start({
  ...trace,
  traceId: bareTraceId,
  observationId: undefined,
  observationType: undefined,
  intentId: undefined,
  intentType: undefined,
  status: 'running',
})
const bareTrace = await traceWriter.get(bareTraceId)
check(
  '合成轮次的四个槽是 undefined（不是空字符串，也不是编造的值）',
  bareTrace?.observationId === undefined &&
    bareTrace?.observationType === undefined &&
    bareTrace?.intentId === undefined &&
    bareTrace?.intentType === undefined
)

// ===========================================================================
section('5. append-only 未被侵蚀：新列不出现在任何 UPDATE 里')
// ===========================================================================

/*
 * M3 的规矩：`conversation_events` 上**唯一**允许 UPDATE 的列是 `delivery_status`
 * （它是投递状态，不是内容）。M3.5 加了六列，必须证明一个都没进 UPDATE。
 *
 * 做法是**只检查 `update conversation_events` 那一条语句体**，而不是
 * "整个持久层里不许出现 `occurred_at =`"。后者会把 `character_traces` 的
 * 正常更新判成违规 —— trace 本来就是可写的（`finish()` 会更新它），
 * 第一版守卫真的这么误报过。
 *
 * append-only 保护的是**事实账本**，不是所有表。守卫必须和它要保护的东西
 * 一样精确，否则它会退化成一个"需要被绕过"的噪声。
 */
const forbiddenInLedgerUpdate = ['occurred_at =', 'logical_time =', 'trigger_kind =']
const ledgerUpdateStatements: string[] = []

const walk = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full)
      continue
    }
    if (!entry.endsWith('.ts')) continue
    const text = readFileSync(full, 'utf8')
    // 抓取每条 `update conversation_events ... (where|returning)` 的语句体
    for (const match of text.matchAll(/update\s+conversation_events([\s\S]{0,400}?)(?:where|returning)/g)) {
      ledgerUpdateStatements.push(`${full.replace(process.cwd(), '')}::${match[1]}`)
    }
  }
}
walk(join(process.cwd(), 'src'))

check(
  '确实存在 conversation_events 的 UPDATE 语句（否则下面的守卫是空断言）',
  ledgerUpdateStatements.length > 0,
  `${ledgerUpdateStatements.length} 条`
)
const updateOffenders = ledgerUpdateStatements.flatMap((statement) =>
  forbiddenInLedgerUpdate
    .filter((column) => statement.includes(column))
    .map((column) => `${statement.split('::')[0]} → ${column}`)
)
check(
  'conversation_events 的 UPDATE 里没有 M3.5 新增的时间 / 触发列',
  updateOffenders.length === 0,
  updateOffenders.length ? `发现：${updateOffenders.join(', ')}` : '新增列零 UPDATE'
)

// delivery_status 本身确实还是可更新的（否则上面那条就成了"谁都不能更新"的假保证）
// 序号 3 才是下一条：第 2 条是系统事件，而被拒的那次写入没有占用序号
const delivered = await ledger.appendCharacterOutput({
  characterId: kernel.characterId,
  conversationId,
  characterIdAsActor: kernel.characterId,
  content: '投递状态仍然可以更新。',
  conversationSequence: 3,
  replyToEventId: userAppend.event.id,
})
const marked = await markDeliveryStatus(db, delivered.event.id, 'delivered')
const afterDeliver = await ledger.getById(delivered.event.id)
check(
  'delivery_status 仍可更新，且正文没有被改动（append-only 语义不变）',
  marked && afterDeliver?.deliveryStatus === 'delivered' && afterDeliver?.content === delivered.event.content,
  `status=${afterDeliver?.deliveryStatus}`
)

// ===========================================================================
section('6. 端到端：一轮真实对话走新链路（Observation → Intent → 事件）')
// ===========================================================================

const e2eConversationId = asConversationId('dm-m35-e2e')
const recorder = new ConversationRecorder({
  db,
  characterId: kernel.characterId,
  conversationId: e2eConversationId,
  dryRun: false,
  userName: 'Alex',
  characterName: kernel.definition.name,
  transport: 'cli',
  userId: 'user-m35-e2e',
  userRef: 'm3.5-e2e',
})
const seq = (await latestConversationSequence(db, kernel.characterId, e2eConversationId)) + 1
const recorded = await recorder.recordUserMessage('M3.5 端到端：这一轮要能落进新链路。', seq)
check('用户事件写入成功（经账本端口）', recorded.event !== undefined, String(recorded.event?.id))

const observation = conversationObservationFrom(recorded.event!)
check(
  '事件可以派生出一条对话观测',
  observation.type === 'CONVERSATION_OBSERVATION' &&
    observation.sourceEventIds[0] === String(recorded.event!.id),
  `id=${String(observation.id)}`
)

const intent = createSpeechIntent({
  characterId: kernel.characterId,
  text: '（M3.5 端到端）在的。',
  sourceObservationIds: [observation.id],
})
const resolver = createConversationIntentResolver({
  recorder,
  conversationSequence: seq + 1,
  characterSequence: recorded.assistantSequence ?? seq + 1,
  replyToEventId: recorded.event!.id,
  traceId: 'trc:m35-verify',
})
const resolved = await resolver.resolveWithEvent(intent)
check(
  'SpeechIntent 落成一条 assistant 事件，并给出引用',
  resolved.resolution.status === 'accepted' &&
    resolved.event !== undefined &&
    resolved.resolution.resultRefs?.[0] === String(resolved.event.id),
  `status=${resolved.resolution.status} ref=${resolved.resolution.resultRefs?.[0]}`
)
check(
  '事件正文来自 intent 的 payload（不是第二份文本）',
  resolved.event?.content === '（M3.5 端到端）在的。',
  resolved.event?.content
)

// ===========================================================================
console.log(`\n${'='.repeat(74)}`)
console.log(`M3.5 持久化验证：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log(`实验库：${sandbox.dir}`)
console.log('='.repeat(74))

try {
  await runtime.stop()
} catch {
  /* 关不干净不影响结论 */
}

process.exit(failed === 0 ? 0 : 1)
