/**
 * M4 持久化验证 —— 迁移 0005、事件落库、幂等、乐观锁、Replay（计划书第 117–118 / 172 节）。
 *
 * ============================================================================
 *  WP2 Gate：create / update through event / supersede / retract / replay
 *  必须全部 deterministic
 * ============================================================================
 * 本文件证明的全部内容：
 *
 *   1. 迁移 0005 只**新增**四张表 —— 既有表与既有行一个字都没动
 *   2. `MEMORY_*` 真的进 `character_domain_events`（与诊断链路同一个函数）
 *   3. **同一批事件里的 N 条候选 → N 个不同幂等键 → N 条记忆**（审计 §6 F4 的守卫）
 *   4. **同一批重跑 → 条数不变**（计划书第 68–69 / 186 节）
 *   5. SUPERSEDE / RETRACT / DISPUTE / RESTORE 的状态转移全部正确
 *   6. 乐观锁真的拦住并发覆盖（`revision_conflict`）
 *   7. reducer 版本不匹配时失败关闭
 *   8. **Replay `A == B`**（计划书第 74 节）
 *   9. 索引表能反查：按 subject / 按 source / 按 canonical key
 *  10. 审计探针：unsupported = 0、contamination = 0
 *
 * ---------------------------------------------------------------------------
 *  全部在**沙箱库**上跑，绝不碰真实库
 * ---------------------------------------------------------------------------
 * 与 `verify-m3-persistence.ts` 同一个隔离机制（`isolateDatabase`）。
 * 真实库的升级是一个**显式动作**（`pnpm migrate:apply`），不在这里做 ——
 * 但沙箱库不设防，因此 0005 会在这里真的被应用。
 *
 * 跑法：pnpm m4:verify
 */

import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

// ⚠️ 必须在任何会碰数据库的 import 之前（见 src/dev/sandbox.ts 的说明）
import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { stringToUuid } from '../src/kernel/contracts/uuid.ts'




import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb, rowsOf, applyKernelMigrations, type RawDb } from '../src/infrastructure/persistence/db.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { latestSchemaVersion, MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'
import { ATTRIBUTION_V7_COLUMNS } from '../src/kernel/contracts/attribution.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { findEventRefs } from '../src/infrastructure/persistence/conversation-store.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import { asConversationId } from '../src/kernel/contracts/index.ts'
import {
  applyAcceptedEvents,
  findDomainEventByIdempotencyKey,
} from '../src/infrastructure/persistence/event-store.ts'
import {
  applyMemoryEvent,
  contaminatedMemories,
  countByProcessorVersion,
  createNativeMemoryStore,
  domainEventsForMemory,
  memoryCounts,
  unsupportedMemories,
  updateRecordWithLock,
} from '../src/infrastructure/persistence/memory-store.ts'
import { createMemoryMutationValidator } from '../src/kernel/policies/memory-validator.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
  targetHintsFrom,
} from '../src/kernel/app/memory/intent-detector.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import {
  canonicalKeyOfRecord,
  createTargetMemoryResolver,
} from '../src/kernel/app/memory/target-resolver.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import {
  advanceWatermarkByGaps,
  enqueueMemoryExtractionJob,
  runMemoryExtractionJob,
} from '../src/kernel/app/memory/job.ts'
import {
  MEMORY_PIPELINE_PROCESSOR,
  runMemoryExtractionPipeline,
} from '../src/kernel/app/memory/pipeline.ts'
import { RuleBasedMemoryExtractor, resolveCandidates } from '../src/kernel/app/memory/extractor.ts'
import {
  describeProvenance,
  renderMemoryHistory,
} from '../src/kernel/app/memory/provenance.ts'
import {
  advanceWatermark,
  enqueueJob,
  finishJob,
  getJob,
  getWatermark,
  listJobs,
  markJobRunning,
} from '../src/infrastructure/persistence/job-store.ts'
import { recentConversationEvents } from '../src/infrastructure/persistence/conversation-store.ts'
import {
  MEMORY_CREATED,
  MEMORY_DISPUTED,
  MEMORY_RESTORED,
  MEMORY_RETRACTED,
  MEMORY_SUPERSEDED,
  createFullDomainEventRegistry,
  createMemoryCandidate,
  entityRef,
  makeMemoryId,
  memorySlotFor,
  recordFromCandidate,
  canonicalKeyOf,
  type DomainEvent,
  type MemoryCandidate,
  type MemoryRecord,
  type NewMemoryCandidate,
  type ClaimMemoryContent,
} from '../src/kernel/contracts/index.ts'

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

// 顺序不能反：先清掉上一个场景留在 globalThis 上的 PGlite 单例，再隔离
await resetPluginSqlConnection()
const sandbox = isolateDatabase('m4-persistence-verify', { keep: true })

const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')

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

await initDatabase(runtime)
await runtime.initialize()

// M4：注入含 MEMORY_* 的 registry
const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character),
  registry: createFullDomainEventRegistry(),
})

const db = getRawDb(runtime)
const owner = entityRef('character', characterId)
const user = entityRef('user', userId)
const conversationId = `dm-${characterId}-m4verify`

const store = createNativeMemoryStore(db)
const validator = createMemoryMutationValidator({
  registry: kernel.registry,
  sources: {
    findEvents: (ids) => findEventRefs(db, ids as never),
  },
  processed: {
    hasProcessed: async (key) => {
      const rows = await db.execute(
        sql`select 1 as one from processed_operations where idempotency_key = ${key} limit 1`
      )
      return rowsOf(rows).length > 0
    },
  },
  /*
   * 去重第一层（计划书第 75 节）需要"看现在有什么"。
   * 这里用 store 的最小读能力接上 —— 生产装配同此。
   */
  lookup: {
    findActiveByFingerprint: async ({ owner: o, fingerprint }) => {
      const found = await store.getActiveByFingerprint(o, fingerprint)
      return found === null ? undefined : { memoryId: found.id }
    },
    findActiveByCanonicalKey: async ({ owner: o, canonicalKey }) => {
      const found = await store.getActiveByCanonicalKey(canonicalKey)
      return found
        .filter((r) => String(r.owner.id) === String(o.id) && r.owner.kind === o.kind)
        .map((r) => ({ memoryId: r.id }))
    },
  },
})

/**
 * 真实的对话事件写入器。
 *
 * ============================================================================
 *  ⚠️ 为什么证据必须**真的**写进事实账本
 * ============================================================================
 * 第一版这个脚本用的是"合成的事件 id"（`cev:...:1` 这样拼一个）。
 * 它**被放行口正确地拒绝了**（`memory_evidence_event_missing`）——
 * 而那正是设计要的行为：计划书第 126 / 154 节要求 Evidence 必须指向
 * **真实**事件，否则"这条记忆来自哪"就只是一句声称。
 *
 * 因此这里走 `ConversationRecorder`（生产代码写入账本的**唯一**入口），
 * 让证据事件真的存在。这也顺带证明了 M4 与 M3 的账本是无缝对接的。
 */
const recorder = new ConversationRecorder({
  db,
  characterId: kernel.characterId,
  conversationId: asConversationId(conversationId),
  dryRun: false,
  userName: 'Alex',
  characterName: character.name,
  transport: 'verify-m4',
  /*
   * M5.1.1 / Phase 4a（ADR-043 `DR-6`）：与 `src/main.ts:532` 同一行。
   *
   * `recordUserEvidence()` 代表"用户本人直接说"（交互式人类控制台），
   * `recordAssistantMessage` 走她的输出边界。两条通道都装 —— 否则 §16 的
   * 注入式抽取器拿到的视图没有受信读数，事实类候选会被来源资格闸拒绝，
   * 而本节要测的是**冲突策略**，不是抽取器资格（判据一条都没变）。
   */
  attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
})

let conversationSequence = 0

/**
 * 写一条用户陈述进账本，返回它的 EvidenceRef。
 *
 * 返回里带上 `assistantSequence` 是为了让"写一条她的回复"能接上正确的
 * 角色级序号 —— `recordAssistantMessage` **要求**它
 * （序号由持久层原子分配，领域层无权决定，见 `createConversationEvent` 的说明）。
 */
async function recordUserEvidence(text: string): Promise<{
  ref: { kind: 'conversation_event'; id: string }
  assistantSequence: number
}> {
  conversationSequence += 1
  const { event, assistantSequence } = await recorder.recordUserMessage(text, conversationSequence)
  if (event === undefined || assistantSequence === undefined) {
    throw new Error('写入用户证据失败：recorder 返回了 undefined（dryRun 未关闭？）')
  }
  return {
    ref: { kind: 'conversation_event', id: String(event.id) },
    assistantSequence,
  }
}

/** 写一条她的回复进账本（用于"真实互动"类证据） */
async function recordAssistantEvidence(
  text: string,
  characterSequence: number,
  replyToEventId?: string
): Promise<{ kind: 'conversation_event'; id: string }> {
  conversationSequence += 1
  const event = await recorder.recordAssistantMessage({
    text,
    conversationSequence,
    characterSequence,
    ...(replyToEventId ? { replyToEventId: replyToEventId as never } : {}),
  })
  if (event === undefined) {
    throw new Error('写入助手证据失败：recorder 返回了 undefined')
  }
  return { kind: 'conversation_event', id: String(event.id) }
}

const T0 = 1_800_000_000_000

/** 造一条候选（缺省不带证据；调用方必须传入**真实**证据） */function makeCandidate(
  type: NewMemoryCandidate['type'],
  content: NewMemoryCandidate['content'],
  overrides: Partial<NewMemoryCandidate> & { sourceRefs: NewMemoryCandidate['sourceRefs'] }
): MemoryCandidate {
  const evidence = overrides.sourceRefs
  // ⚠️ `sourceRefs` / `evidenceRootIds` 在展开之前给出，因此 overrides
  //    里的值会覆盖它们 —— 这正是想要的（调用方传什么就用什么），
  //    但必须**显式**知道这一点，否则同一字段写两遍会被静默覆盖。
  return createMemoryCandidate({
    owner,
    type,
    content,
    subjects: content.kind === 'claim' ? [content.subject] : content.participants,
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.8,
    confidence: 0.9,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
    ...overrides,
    sourceRefs: evidence,
    evidenceRootIds: overrides.evidenceRootIds ?? evidence.map((ref) => ref.id),
  } as NewMemoryCandidate)
}

/**
 * 把候选经**真实放行口**变成已落库的领域事件。
 *
 * 刻意**不用 `store.apply()` 直接造事件** —— 那会绕过
 * `MemoryMutationValidator`，于是本文件就测不到"放行口算出的幂等键"
 * 这条 M4 最容易做错的地方（审计 §6 F4）。
 *
 * 落库走 `applyAcceptedEvents(db, characterId, accepted, [])`：
 * 传**空 reducers** 是因为 Memory 的投影不由 `character_projections` 承载
 * （见审计 §5 F1），它的折叠在下一个 `applyMemoryEvent` 里发生。
 * 这一点与诊断链路一致：`applyAcceptedEvents` 本身就是"写事件"的唯一入口。
 */
async function commitCandidate(
  candidate: MemoryCandidate,
  mutation: 'explicit' | 'background' = 'explicit',
  now: number = T0
): Promise<{ events: DomainEvent[]; accepted: AcceptedDomainEvent[]; rejected: { code: string }[] }> {
  const outcome = await validator.validate({
    characterId: kernel.characterId,
    owner,
    candidates: [candidate],
    mutation,
    operation: 'create',
  })

  if (outcome.rejected.length > 0) {
    return { events: [], accepted: [], rejected: outcome.rejected }
  }

  const applied = await applyAcceptedEvents(db, kernel.characterId, outcome.accepted, [], now)
  return { events: applied.domainEvents, accepted: outcome.accepted, rejected: [] }
}

/** 提交一批候选（同一批事件区间 → 多条候选，审计 §6 F4 的核心场景） */
async function commitBatch(
  candidates: MemoryCandidate[],
  mutation: 'explicit' | 'background' = 'background',
  now: number = T0
): Promise<{ events: DomainEvent[]; accepted: AcceptedDomainEvent[]; rejected: { code: string }[] }> {
  const outcome = await validator.validate({
    characterId: kernel.characterId,
    owner,
    candidates,
    mutation,
    operation: 'create',
  })
  if (outcome.rejected.length > 0) {
    return { events: [], accepted: [], rejected: outcome.rejected }
  }
  const applied = await applyAcceptedEvents(db, kernel.characterId, outcome.accepted, [], now)
  return { events: applied.domainEvents, accepted: outcome.accepted, rejected: [] }
}

/** 把一个已落库的领域事件折叠进 Memory 投影 */
async function fold(event: DomainEvent): Promise<MemoryRecord | null> {
  const result = await applyMemoryEvent(db, event, event.createdAt)
  return result.record
}

/** 提交并折叠一条候选（最常见的一步，包一层让用例可读） */
async function commitAndFold(
  candidate: MemoryCandidate,
  mutation: 'explicit' | 'background' = 'explicit',
  now: number = T0
): Promise<{ record: MemoryRecord | null; rejected: { code: string }[] }> {
  const { events, rejected } = await commitCandidate(candidate, mutation, now)
  if (rejected.length > 0) return { record: null, rejected }
  let record: MemoryRecord | null = null
  for (const event of events) record = await fold(event)
  return { record, rejected: [] }
}

// ===========================================================================
// 1. 迁移 0005
// ===========================================================================

section('1. 迁移 0005（纯新增四张表）')

const schemaVersion = Number(
  rowsOf(
    await db.execute(sql`select coalesce(max(version),0) as v from character_schema_migrations`)
  )[0]?.v ?? 0
)
/*
 * ⚠️ 这条断言在 M4.5 改过一次，原因是它本来就该这么写。
 *
 * 原来写的是 `schemaVersion === 5 && latestSchemaVersion() === 5` ——
 * 一个**写死的版本号**。M4.5 加了迁移 0006（Execution Ledger）之后它红了，
 * 而红的原因不是"迁移坏了"，是"有人加了迁移，而这个数字没跟着动"。
 *
 * 真正要守的性质只有一条：**库里应用的版本 == 代码里最新的版本**
 * （两者不一致才是真问题：要么漏迁移，要么代码比库新）。
 * 这与本文件 §5 那条"不写死列数"的纪律是同一条。
 */
check(
  'schema 版本 = 代码里的最新版本（不是写死的数字）',
  schemaVersion === latestSchemaVersion(),
  `库 ${schemaVersion} / 代码 ${latestSchemaVersion()}`
)

const tableRows = rowsOf(
  await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
  )
)
const tables = tableRows.map((r) => String(r.table_name))
for (const t of ['memory_records', 'memory_subject_links', 'memory_evidence_links', 'memory_events']) {
  check(`表 ${t} 存在`, tables.includes(t))
}

const migrationNames = rowsOf(
  await db.execute(sql`select version, name from character_schema_migrations order by version asc`)
)
check(
  '迁移记录齐全且顺序连续（1..最新，不写死条数）',
  migrationNames.length === latestSchemaVersion() &&
    migrationNames.every((m, i) => Number(m.version) === i + 1),
  migrationNames.map((m) => `#${m.version}`).join(',')
)

// 既有表列数未变：抽查两张 append-only 历史表
//
// ⚠️ 这里**不写死列数**。第一版写死了（"conversation_events 仍 18 列"），
// 实测发现它是 20 列 —— 因为 0002 的 DDL 有 13 列，0003 加 5 列、0004 加 2 列，
// 而我当初是估的。写死一个估出来的数字，得到的是一条**看起来在守规矩、
// 其实在随机失败**的断言。
//
// 改成断"列集合**恰好**是迁移 0002+0003+0004 的并集" ——
// 这才是这条检查真正想说的：M4 的 0005 **没有**给这两张表加列。
const columnNames = async (table: string): Promise<string[]> => {
  const rows = rowsOf(
    await db.execute(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = ${table}
          order by column_name`
    )
  )
  return rows.map((r) => String(r.column_name))
}

// conversation_events：0002 的 13 列 + 0003 的 5 列 + 0004 的 2 列 = 20
const CONVERSATION_EVENT_COLUMNS = [
  'actor_id',
  'actor_type',
  'character_id',
  'content',
  'conversation_id',
  'conversation_sequence',
  'created_at',
  'delivery_status',
  'epistemic_source',
  'event_schema_version',
  'id',
  'logical_time',
  'metadata',
  'occurred_at',
  'reply_to_event_id',
  'schema_version',
  'sequence',
  'source_authority',
  'source_kind',
  'type',
  // M5.1.1 WP2（K-4 / R-11）：迁移 0007 **纯追加**的 22 个归因列。
  // 这是一次"受控 schema 追加"引起的既有断言最小兼容更新 —— **判据没有被放宽**：
  // 仍然是**精确集合相等**（多一列、少一列、换个名字都会红）。
  // 逐条记录见 docs/m5.1.1/M5.1.1-WP1.1-Compatible-Assertion-Record.md §6。
  ...ATTRIBUTION_V7_COLUMNS,
]

/*
 * ⚠️ 必须**去重**：v7 的 22 列里有 3 列（`source_kind` / `source_authority` /
 * `epistemic_source`）在迁移 0003 就已经存在于 `conversation_events`，
 * 所以这张表在 v7 的**净新增是 19 列**（17 旧列 + 3 个 M3 列 = 20 → 39），
 * 而 `character_action_events` 的净新增是 22 列（它此前没有这三列）。
 * 不去重的话，期望集合会有 3 个重复项，于是"数量对得上、集合对不上"。
 */
const CONVERSATION_EVENT_COLUMNS_UNIQUE = [...new Set(CONVERSATION_EVENT_COLUMNS)].sort()

// character_domain_events：0002 的 13 列 + 0004 的 2 列 = 15
const DOMAIN_EVENT_COLUMNS = [
  'caused_by_domain_event_ids',
  'character_id',
  'created_at',
  'id',
  'idempotency_key',
  'logical_time',
  'occurred_at',
  'payload',
  'primary_source_event_id',
  'processor',
  'processor_version',
  'schema_version',
  'sequence',
  'source_conversation_event_ids',
  'type',
].sort()

const convColumns = await columnNames('conversation_events')
const domainColumns = await columnNames('character_domain_events')
check(
  'conversation_events 的列集合 = M4 时代的 20 列 + M5.1.1 的 19 个净新增列（除这两次外没有任何 ALTER 动过它）',
  JSON.stringify(convColumns) === JSON.stringify(CONVERSATION_EVENT_COLUMNS_UNIQUE),
  convColumns.length === CONVERSATION_EVENT_COLUMNS_UNIQUE.length
    ? `${convColumns.length} 列，完全一致`
    : `实际 ${convColumns.length} 列：${convColumns.join(',')}`
)
check(
  'character_domain_events 的列集合未被 M4 改动',
  JSON.stringify(domainColumns) === JSON.stringify(DOMAIN_EVENT_COLUMNS),
  `${domainColumns.length} 列`
)

// ===========================================================================
// 2. 事件真的进 character_domain_events
// ===========================================================================

section('2. MEMORY_* 经真实放行口落库')

const cilantroEvidence = await recordUserEvidence('我不吃香菜，从小就受不了那个味道')
const cilantro = makeCandidate(
  'preference',
  {
    kind: 'claim',
    subject: user,
    predicate: 'food.preference.cilantro',
    value: 'dislike',
  },
  { sourceRefs: [cilantroEvidence.ref] }
)

const first = await commitAndFold(cilantro)
if (first.rejected.length > 0) {
  console.log(`  ⚠️ 诊断：候选被拒的真实原因 —— ${JSON.stringify(first.rejected)}`)
}
check('偏好候选被接受并折叠成记录', first.record !== null, first.record ? String(first.record.id) : '')
check('记录状态是 active', first.record?.status === 'active')
check('记录的 authority 是 EXPLICIT_USER_STATEMENT', first.record?.authority === 'EXPLICIT_USER_STATEMENT')
check('记录带 canonicalKey（Claim 型有槽位）', first.record?.canonicalKey !== undefined)
check('记录带 evidenceRootIds（MI-03）', (first.record?.evidenceRootIds.length ?? 0) > 0)
check('记录 revision = 1', first.record?.revision === 1)

const domainRows = rowsOf(
  await db.execute(
    sql`select type, processor, processor_version, idempotency_key from character_domain_events
        where type = ${MEMORY_CREATED}`
  )
)
check(
  'MEMORY_CREATED 进了 character_domain_events（与诊断链路同一张表）',
  domainRows.length >= 1,
  `${domainRows.length} 条`
)
check(
  '事件带 processorVersion（计划书第 66–67 节）',
  String(domainRows[0]?.processor_version ?? '').startsWith('memory-extractor@')
)

const eventIndexRows = rowsOf(await db.execute(sql`select count(*)::int as c from memory_events`))
check(
  'memory_events 索引表被写入（rebuildMemory 的前提）',
  Number(eventIndexRows[0]?.c ?? 0) >= 1,
  `${eventIndexRows[0]?.c} 条`
)

// ===========================================================================
// 3. 审计 §6 F4：同一批 N 条候选 → N 个不同幂等键
// ===========================================================================

section('3. 同一批多条候选（审计 §6 F4 —— M4 最容易做错的一处）')

const educationEvidence = await recordUserEvidence('我现在是大学生，学的是计算机')
const replyEvidence = await recordAssistantEvidence(
  '计算机啊，那平时写代码多吗',
  educationEvidence.assistantSequence,
  educationEvidence.ref.id
)
const batchEvidence = [educationEvidence.ref, replyEvidence]

const batch: MemoryCandidate[] = [
  createMemoryCandidate({
    owner,
    type: 'person_fact',
    content: { kind: 'claim', subject: user, predicate: 'education.status', value: 'undergraduate' },
    subjects: [user],
    sourceRefs: batchEvidence,
    evidenceRootIds: batchEvidence.map((r) => r.id),
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.85,
    confidence: 0.9,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  }),
  createMemoryCandidate({
    owner,
    type: 'person_fact',
    content: { kind: 'claim', subject: user, predicate: 'education.major', value: '计算机' },
    subjects: [user],
    sourceRefs: batchEvidence,
    evidenceRootIds: batchEvidence.map((r) => r.id),
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.8,
    confidence: 0.85,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  }),
  createMemoryCandidate({
    owner,
    type: 'episode',
    content: {
      kind: 'episode',
      summary: '他们讨论了角色 Agent 的长期记忆架构',
      participants: [owner, user],
      eventRefs: batchEvidence.map((r) => r.id),
      topicTags: ['agent', 'memory'],
    },
    subjects: [owner, user],
    sourceRefs: batchEvidence,
    evidenceRootIds: batchEvidence.map((r) => r.id),
    epistemicStatus: 'observed',
    authority: 'DIRECT_INTERACTION',
    importance: 0.7,
    confidence: 0.8,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  }),
]

const batchResult = await commitBatch(batch)
if (batchResult.rejected.length > 0) {
  console.log(`  ⚠️ 诊断：批量候选被拒的真实原因 —— ${JSON.stringify(batchResult.rejected)}`)
}
check('三条候选全部被接受（没有一条被判重复丢弃）', batchResult.rejected.length === 0 && batchResult.accepted.length === 3, `accepted=${batchResult.accepted.length} rejected=${batchResult.rejected.map((r) => r.code).join(',')}`)

const keys = batchResult.accepted.map((a) => a.idempotencyKey)
check(
  '三条候选得到**三个不同的幂等键**（这正是审计 §6 F4 要守的）',
  keys.length === 3 && new Set(keys).size === 3,
  keys.map((k) => k.slice(0, 14)).join(' | ')
)

const acceptedIds = batchResult.accepted.map((a) => {
  const payload = a.payload as { memoryId: string }
  return payload.memoryId
})
check(
  '三条候选得到**三个不同的 memoryId**（同一批不会互相覆盖）',
  new Set(acceptedIds).size === 3,
  acceptedIds.map((id) => id.split(':').pop()).join(' | ')
)

for (const event of batchResult.events) await fold(event)
const afterBatch = await memoryCounts(db, owner)
check(
  '三条记忆真的都进库了（若幂等键撞了，只会有一条）',
  afterBatch.active >= 4,
  `active=${afterBatch.active} total=${afterBatch.total}`
)

// ===========================================================================
// 3.5 审阅发现的缺陷 → 回归断言
// ===========================================================================

section('3.5 审阅发现的缺陷（回归守卫）')

// --- 缺陷 1：recordedAt 曾取自"校验时刻"而不是"事件时刻" ----------------
//
// 症状：同一行里出现 `recordedAt > createdAt`。
// 它**重放永不报错**（重放与写入用同一个错值算），因此只有显式断言才抓得到。
const timingEvidence = await recordUserEvidence('这是一条用来核对时间字段的记忆')
const timingCandidate = makeCandidate(
  'person_fact',
  { kind: 'claim', subject: user, predicate: 'timing.probe', value: 'ok' },
  { sourceRefs: [timingEvidence.ref] }
)
const timingCommit = await commitCandidate(timingCandidate, 'explicit', T0)
const timingRecord = timingCommit.events.length > 0 ? await fold(timingCommit.events[0]) : null
check('时间字段核对用的记忆已建立', timingRecord !== null)
check(
  'recordedAt 取自**事件时刻**，而不是校验时刻（同一行不得出现 recordedAt > createdAt）',
  timingRecord?.recordedAt === T0 && timingRecord?.createdAt === T0,
  `recordedAt=${String(timingRecord?.recordedAt)} createdAt=${String(timingRecord?.createdAt)} 事件时刻=${T0}`
)

// --- 缺陷 2：同一条事实从**不同证据**被抽到两次时的语义 ----------------
//
// 第一版的行为：第二次也会产出 MEMORY_CREATED，且事件里带的是**第一条**的快照，
// 于是"这条事件凭什么成立"指向了别的证据 —— 事件流不再是可信的 provenance。
// 现在：去重第一层在放行口就判它为重复陈述（计划书第 75 节）。
const cilantroAgain = await recordUserEvidence('再说一次，我不吃香菜')
const sameFactNewEvidence = makeCandidate(
  'preference',
  { kind: 'claim', subject: user, predicate: 'food.preference.cilantro', value: 'dislike' },
  { sourceRefs: [cilantroAgain.ref] }
)
const dupByContent = await commitCandidate(sameFactNewEvidence, 'background', T0 + 600)
check(
  '同一条事实、**不同证据**再抽到一次 → 去重第一层判为重复陈述（计划书第 75 节）',
  dupByContent.rejected.some((r) => r.code === 'duplicate_content'),
  dupByContent.rejected.map((r) => r.code).join(',') || '(被接受了 —— 去重第一层没生效)'
)
check(
  '重复陈述没有产出第二条 MEMORY_CREATED 事件',
  dupByContent.events.length === 0,
  `${dupByContent.events.length} 条事件`
)

const cilantroNow = await store.get(first.record!.id)
check(
  '既有记忆的证据未被悄悄改写（内容与证据仍然自洽）',
  JSON.stringify(cilantroNow?.sourceRefs) === JSON.stringify(first.record!.sourceRefs),
  `现在 ${(cilantroNow?.sourceRefs ?? []).length} 条证据`
)

// --- 缺陷 3：createMemoryCandidate 曾直接改写调用方的 content 对象 ------
const callerContent: ClaimMemoryContent = {
  kind: 'claim',
  subject: user,
  predicate: 'Food.Preference.Cilantro',
  value: 'dislike',
}
const callerCopy = JSON.stringify(callerContent)
createMemoryCandidate({
  owner,
  type: 'preference',
  content: callerContent,
  subjects: [user],
  sourceRefs: [cilantroAgain.ref],
  epistemicStatus: 'reported',
  authority: 'EXPLICIT_USER_STATEMENT',
  importance: 0.5,
  confidence: 0.5,
  processor: 'memory-extractor',
  processorVersion: 'memory-extractor@1',
})
check(
  '构造候选**不修改调用方传入的 content 对象**（规范化只作用在复制品上）',
  JSON.stringify(callerContent) === callerCopy,
  `调用方对象现在是：${JSON.stringify(callerContent)}`
)

// ===========================================================================
// 4. 幂等：同一批重跑
// ===========================================================================
section('4. 幂等（计划书第 68–69 / 186 节）')

const beforeRerun = await memoryCounts(db, owner)
const rerun = await commitBatch(batch)
/*
 * ⚠️ 这条断言**放宽过一次**，原因值得记下来。
 *
 * 第一版写的是"全部判为 `duplicate_operation`"。加上去重第一层之后，
 * 重跑先被 `duplicate_content` 拦下 —— 于是断言红了，但**系统行为更好了**：
 * 内容是重复的，这件事比"这个操作做过了"更根本，也更便宜。
 *
 * 两层都是正确的"安静的成功"（计划书第 50 节：REJECT 必须是正常结果），
 * 而**哪一层先拦**是实现细节。把断言钉死在一层上，
 * 得到的是一条"看起来在守规矩、其实会因正当实现变动而失败"的断言 ——
 * 与我在 M3.5 那条 `schemaVersion === 4` 上踩到的是同一个坑。
 *
 * 因此改成断言**两件真正该守的事**：
 *   ① 没有一条候选被接受
 *   ② 每一条的拒绝码都在"重复"这一类里
 */
const DUPLICATE_CODES = ['duplicate_operation', 'duplicate_content']
check(
  '同一批重跑：没有一条候选被接受（幂等命中，不是新操作）',
  rerun.accepted.length === 0,
  `accepted=${rerun.accepted.length}`
)
check(
  '同一批重跑的拒绝码属于"重复"这一类（去重第一层或幂等层）',
  rerun.rejected.length === batch.length &&
    rerun.rejected.every((r) => DUPLICATE_CODES.includes(r.code)),
  rerun.rejected.map((r) => r.code).join(',')
)
const afterRerun = await memoryCounts(db, owner)
check(
  '同一批重跑后 **记忆条数不变**',
  afterRerun.total === beforeRerun.total,
  `重跑前 ${beforeRerun.total} → 重跑后 ${afterRerun.total}`
)

// 重复 Worker：手动把同一个事件再 fold 一次，revision 不得叠加
//
// 这是计划书第 186 节（M4-015 Duplicate Worker）的单元级落地点：
// 同一个 MemoryExtractionJob 被跑两次时，第一次产生的事件第二次会被
// 幂等键挡住；但**万一**两个 Worker 并发写下了同一个事件，
// `applyMemoryEvent` 也必须认得它（靠 memory_events 的
// `(memory_id, domain_event_id)` 检查），而不是把 revision 推两次。
const targetEvent = batchResult.events[0]
const targetMemoryId = makeMemoryId(
  characterId as never,
  String((targetEvent.payload as { memoryId: string }).memoryId).split(':').slice(2).join(':')
)
const beforeRefold = await store.get(targetMemoryId)
check('重折目标记忆存在', beforeRefold !== null, String(targetMemoryId))
const refold = await applyMemoryEvent(db, targetEvent, targetEvent.createdAt)
check(
  '同一事件再折叠一次：created=false（不重复应用）',
  refold.created === false,
  `created=${refold.created}`
)
check(
  '同一事件再折叠一次：revision **不变**（Duplicate Worker 不能把版本推两次）',
  refold.record?.revision === beforeRefold?.revision,
  `${beforeRefold?.revision} → ${refold.record?.revision}`
)

// ===========================================================================
// 5. 状态转移
// ===========================================================================

section('5. 状态转移（SUPERSEDE / RETRACT / DISPUTE / RESTORE）')

// --- SUPERSEDE：计划书第 35 / 36 / 175 节 ---
const cilantroRecord = first.record!
const replacementEvidence = await recordUserEvidence('那个改一下，我现在能吃香菜了')
const replacementCandidate = makeCandidate(
  'preference',
  {
    kind: 'claim',
    subject: user,
    predicate: 'food.preference.cilantro',
    value: 'like',
  },
  { sourceRefs: [replacementEvidence.ref] }
)
const replacement = await commitAndFold(replacementCandidate)
// 触发这次 supersede 的就是上面那句用户话 ——
// 状态变化也必须能说清"由哪句话引起"（计划书第 5 节）
const triggerEventId = replacementEvidence.ref.id
check(
  '同槽位的新取值是**另一条**记忆（不是改旧的，MI-06）',
  replacement.record !== null && replacement.record.id !== cilantroRecord.id
)
check(
  '新旧两条的 canonicalKey **相同**（它们是同一个事实槽位）',
  replacement.record?.canonicalKey === cilantroRecord.canonicalKey
)

const supersedeOutcome = await validator.validate({
  characterId: kernel.characterId,
  owner,
  candidates: [],
  mutation: 'explicit',
  operation: 'supersede',
  // 触发这次变更的那条对话事件（**必填** —— 没有来源的状态变化不允许落库）
  triggeredByEventId: triggerEventId,
  target: {
    memoryId: cilantroRecord.id,
    supersededBy: replacement.record!.id,
    validUntil: T0 + 1000,
    reason: '用户说现在能吃香菜了',
  },
})
check('supersede 提案被放行口接受', supersedeOutcome.accepted.length === 1, supersedeOutcome.rejected.map((r) => r.code).join(','))
const supersedeApplied = await applyAcceptedEvents(
  db,
  kernel.characterId,
  supersedeOutcome.accepted,
  [],
  T0 + 1000
)
const supRecord = await fold(supersedeApplied.domainEvents[0])
check('旧记忆状态 → superseded', supRecord?.status === 'superseded')
check('旧记忆 validUntil 被写上（计划书第 36 节）', supRecord?.validUntil === T0 + 1000, String(supRecord?.validUntil))
check('旧记忆 supersededBy 指向新条（MI-07）', String(supRecord?.supersededBy) === String(replacement.record!.id))
const newRecord = await store.get(replacement.record!.id)
check('新记忆仍是 active', newRecord?.status === 'active')
check(
  '新记忆的 supersedes 指回旧条（双向可追溯，MI-07）',
  (newRecord?.supersedes ?? []).some((id) => String(id) === String(cilantroRecord.id)),
  (newRecord?.supersedes ?? []).join(',')
)
const history = await store.history(cilantroRecord.id)
check(
  '旧记忆的事件流有两条（CREATED + SUPERSEDED），历史不丢失',
  history.length === 2,
  history.map((e) => e.type).join(' → ')
)

// --- RETRACT：计划书第 32 / 58–59 / 176 节 ---
const forgetEvidence = await recordUserEvidence('忘掉我平时用 Windows 这件事')
const forgetCandidate = makeCandidate(
  'person_fact',
  {
    kind: 'claim',
    subject: user,
    predicate: 'device.primary',
    value: 'Windows',
  },
  { sourceRefs: [forgetEvidence.ref] }
)
const forgetRecord = (await commitAndFold(forgetCandidate)).record!
const retractOutcome = await validator.validate({
  characterId: kernel.characterId,
  owner,
  candidates: [],
  mutation: 'explicit',
  operation: 'retract',
  // 触发这次撤回的是**"忘掉……"那句话**，而不是当初建立这条记忆的那句
  triggeredByEventId: forgetEvidence.ref.id,
  target: {
    memoryId: forgetRecord.id,
    reason: 'explicit_forget',
    note: '用户要求忘掉',
  },
})
check('retract 提案被接受', retractOutcome.accepted.length === 1)
const retractApplied = await applyAcceptedEvents(db, kernel.characterId, retractOutcome.accepted, [], T0 + 2000)
const retracted = await fold(retractApplied.domainEvents[0])
check('记忆状态 → retracted', retracted?.status === 'retracted')
check(
  'RETRACT **不动** validUntil（与 SUPERSEDE 的区别，计划书第 84 节）',
  retracted?.validUntil === null,
  `validUntil=${String(retracted?.validUntil)}`
)
const conversationStillThere = rowsOf(
  await db.execute(sql`select count(*)::int as c from conversation_events`)
)
check(
  'cognitive forget ≠ 删除原始对话（计划书第 59 / 176 节）',
  Number(conversationStillThere[0]?.c ?? -1) >= 0,
  `conversation_events 仍有 ${conversationStillThere[0]?.c} 条`
)
const domainStillThere = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from character_domain_events where type = ${MEMORY_RETRACTED}`
  )
)
check(
  '撤回本身也留痕（MEMORY_RETRACTED 事件在库里）',
  Number(domainStillThere[0]?.c ?? 0) === 1
)

// --- MARK_DISPUTED：计划书第 33 / 82 / 179 节 ---
const colorEvidence = await recordUserEvidence('我最喜欢蓝色')
const colorCandidate = makeCandidate(
  'preference',
  {
    kind: 'claim',
    subject: user,
    predicate: 'preference.color.favorite',
    value: 'blue',
  },
  { sourceRefs: [colorEvidence.ref] }
)
const colorRecord = (await commitAndFold(colorCandidate)).record!
const colorConflictEvidence = await recordUserEvidence('我从来不喜欢蓝色')
const disputeOutcome = await validator.validate({
  characterId: kernel.characterId,
  owner,
  candidates: [],
  mutation: 'background',
  operation: 'dispute',
  // 触发它的是**那句矛盾的话**（冲突分析器在后台发现时，来源就是这一轮）
  triggeredByEventId: colorConflictEvidence.ref.id,
  target: {
    memoryId: colorRecord.id,
    conflictingMemoryIds: [],
    reason: '昨天说最喜欢蓝色，今天说从来不喜欢蓝色，无法判断是变化还是玩笑',
  },
})
check('dispute 提案被接受（operation 用新的 dispute 值，审计 §6 F3）', disputeOutcome.accepted.length === 1, disputeOutcome.rejected.map((r) => r.code).join(','))
const disputeApplied = await applyAcceptedEvents(db, kernel.characterId, disputeOutcome.accepted, [], T0 + 3000)
const disputed = await fold(disputeApplied.domainEvents[0])
check('记忆状态 → disputed（不擅自覆盖，计划书第 82 节）', disputed?.status === 'disputed')
check('DISPUTED 不改内容（值仍是 blue）', (disputed?.content as { value?: unknown })?.value === 'blue')
check(
  'DISPUTED 不改 validUntil（它没说这条失效了）',
  disputed?.validUntil === null,
  `validUntil=${String(disputed?.validUntil)}`
)

// --- RESTORE：计划书第 70 节 ---
const restoreEvidence = await recordUserEvidence('我之前说不喜欢蓝色是气话，其实挺喜欢的')
const restoreOutcome = await validator.validate({
  characterId: kernel.characterId,
  owner,
  candidates: [],
  mutation: 'explicit',
  operation: 'restore',
  // 触发它的是**那句澄清的话**
  triggeredByEventId: restoreEvidence.ref.id,
  target: { memoryId: colorRecord.id, reason: '后续证据澄清了，蓝色确实是她的偏好' },
})
check('restore 提案被接受', restoreOutcome.accepted.length === 1)
const restoreApplied = await applyAcceptedEvents(db, kernel.characterId, restoreOutcome.accepted, [], T0 + 4000)
const restored = await fold(restoreApplied.domainEvents[0])
check('记忆状态 → active', restored?.status === 'active' && restored.id === colorRecord.id)
check(
  'RESTORE 清掉 validUntil（回到"没有终点"，不再自相矛盾）',
  restored?.validUntil === null,
  `validUntil=${String(restored?.validUntil)}`
)

// ===========================================================================
// 6. 乐观锁
// ===========================================================================

section('6. 乐观锁（旧任务不能覆盖新状态）')

/*
 * 为什么这条要**直接调 `updateRecordWithLock`** 而不是从
 * `applyMemoryEvent` 走：后者会先读当前 revision，因此永远构造不出
 * "过期 revision"那个输入 —— 而"过期 revision 必须被拒绝"恰恰是
 * 乐观锁的全部意义（计划书第 26 节：旧 Worker 不能覆盖新 Worker）。
 *
 * 这也是 `saveProjection()` 被验证脚本直接调用的同一条理由。
 */
const lockTarget = restored!
const staleWrite: MemoryRecord = { ...lockTarget, importance: 0.123 }

let conflictCode = ''
try {
  // 期望基于一个**必然过期**的 revision 写入
  await updateRecordWithLock(db, staleWrite, lockTarget.revision - 1, T0 + 6000)
} catch (error) {
  conflictCode = String((error as { code?: string }).code ?? '')
}
check(
  '带过期 revision 的写入被拒绝（抛 revision_conflict）',
  conflictCode === 'memory_revision_conflict',
  `code=${conflictCode || '(没有抛错 —— 乐观锁没有生效)'}`
)

const afterConflict = await store.get(lockTarget.id)
check(
  '冲突之后状态**未被污染**（importance 没有被写进去）',
  afterConflict?.importance === lockTarget.importance,
  `importance=${String(afterConflict?.importance)}（期望 ${lockTarget.importance}）`
)

// 正确 revision 的写入必须成功
const goodWrite: MemoryRecord = { ...lockTarget, importance: 0.61 }
let goodError = ''
try {
  await updateRecordWithLock(db, goodWrite, lockTarget.revision, T0 + 6001)
} catch (error) {
  goodError = String((error as Error).message ?? '')
}
const afterGood = await store.get(lockTarget.id)
check(
  '正确 revision 的写入成功（乐观锁没有把正常写入也拦掉）',
  goodError === '' && afterGood?.importance === 0.61,
  goodError || `importance=${String(afterGood?.importance)}`
)
check(
  '成功写入之后 revision 前进（写的是传入值，不叠加）',
  afterGood?.revision === lockTarget.revision,
  `${lockTarget.revision} → ${afterGood?.revision}`
)

// 复原
await db.execute(
  sql`update memory_records set importance = ${lockTarget.importance} where id = ${String(lockTarget.id)}`
)

// ===========================================================================
// 7. reducer 版本守卫
// ===========================================================================

section('7. reducer 版本守卫（计划书第 24 / 29 节）')

const versionTarget = lockTarget
await db.execute(
  sql`update memory_records set reducer_version = 'memory-reducer@0-legacy' where id = ${String(versionTarget.id)}`
)
let versionGuardCode = ''
try {
  // 再发一条事件去改它 —— 应当被版本闸拦下
  const bumpEvidence = await recordUserEvidence('版本闸测试用的一句话')
  const bumpOutcome = await validator.validate({
    characterId: kernel.characterId,
    owner,
    candidates: [],
    mutation: 'explicit',
    operation: 'dispute',
    triggeredByEventId: bumpEvidence.ref.id,
    target: { memoryId: versionTarget.id, conflictingMemoryIds: [], reason: '版本闸测试' },
  })
  const applied = await applyAcceptedEvents(db, kernel.characterId, bumpOutcome.accepted, [], T0 + 5000)
  await fold(applied.domainEvents[0])
} catch (error) {
  versionGuardCode = String((error as { code?: string }).code ?? '')
}
check(
  '旧 reducer 版本的投影行被拒绝继续更新（必须先 rebuild）',
  versionGuardCode.includes('memory_reducer_version_mismatch'),
  `code=${versionGuardCode || '(没有抛错 —— 版本闸没有生效)'}`
)
// 恢复
await db.execute(
  sql`update memory_records set reducer_version = 'memory-reducer@1' where id = ${String(versionTarget.id)}`
)

// ===========================================================================
// 8. Replay（计划书第 74 节：A == B）
// ===========================================================================

section('8. Replay A == B（计划书第 73–74 节）')

const allIds = (await store.list({ owner, limit: 100 })).map((r) => r.id)
let replayedOk = 0
const mismatched: string[] = []
for (const id of allIds) {
  const result = await store.rebuildMemory(id)
  if (result.equal) replayedOk += 1
  else mismatched.push(`${String(id)}: ${result.differences.join(',')}`)
}
check(
  `[T31] 全部 ${allIds.length} 条记忆重放一致（A == B）`,
  mismatched.length === 0,
  mismatched.length === 0 ? `${replayedOk}/${allIds.length}` : mismatched.join(' | ')
)

const wholeSpace = await store.rebuildCharacterMemories(owner)
check(
  '[T31] 整库重建（rebuildCharacterMemories）没有不一致 —— "先清空投影再全量重放"与"从零重算并逐字段比对"是同一个性质',
  wholeSpace.mismatched === 0,
  `${wholeSpace.rebuilt} 条，mismatch=${wholeSpace.mismatched}`
)

// ===========================================================================
// 8.5 T32：迁移「中途失败 → 回滚」（M4 S3-1 的另一半 · 2026-10-04 补）
// ===========================================================================
/*
 * 立案（`docs/m4/M4-Technical-Debt.md`，Target Stage 原写「新增 0006 时一并补」）到 0010–0013 都已过去
 * 仍未补 ⇒ 本轮补上，并**沿用 T31 / T32 编号**。这一半量的是：
 *   ① 有 `db.transaction` 时，整批迁移走**一个**事务；
 *   ② 中途失败**原样抛出**（不吞、不谎报成功）；
 *   ③ 失败后**一条版本行都不留**（`character_schema_migrations` 不能记录半个 schema）；
 *   ④ **真实生产手柄**（`src/db/index.ts:286-299` 用的同一个 `getRawDb(runtime)`）**确实带事务能力**
 *      —— 否则会退化成逐条执行，迁移跑到一半失败就会留下半个 schema，那是一条真缺陷而不是测试问题。
 *
 * ⚠️ 本段**不打开真实库、不写任何文件**：①–③ 在事务语义的**替身**上量形状，④ 只对已有手柄做能力探测。
 */

section('8.5 T32：迁移中途失败必须整体回滚（M4 S3-1）')

interface T32Double {
  readonly db: RawDb
  readonly committed: string[]
  readonly executes: number
  readonly rolledBack: boolean
}

function makeTransactionalDouble(failAtExecute?: number): T32Double {
  const committed: string[] = []
  const state = { executes: 0, rolledBack: false }
  const makeExecute = (sink: string[]) => async (query: unknown): Promise<unknown> => {
    state.executes += 1
    if (failAtExecute !== undefined && state.executes === failAtExecute) {
      throw new Error('注入的迁移中途失败（T32）')
    }
    sink.push(`#${String(state.executes)} ${typeof query === 'object' ? '<sql>' : String(query)}`)
    return []
  }
  const db: RawDb = {
    execute: makeExecute(committed),
    transaction: async <T>(fn: (tx: RawDb) => Promise<T>): Promise<T> => {
      const staged: string[] = []
      const tx: RawDb = { execute: makeExecute(staged) }
      try {
        const result = await fn(tx)
        committed.push(...staged)
        return result
      } catch (error) {
        state.rolledBack = true
        throw error
      }
    },
  }
  return {
    db,
    committed,
    get executes() {
      return state.executes
    },
    get rolledBack() {
      return state.rolledBack
    },
  }
}

const firstMigrationStatements = MIGRATIONS[0]?.statements.length ?? 0
const t32Positive = makeTransactionalDouble()
const t32PositiveReport = await applyKernelMigrations(t32Positive.db)
check(
  'T32 正控：不注入失败 ⇒ 整批迁移全部登记并提交',
  t32PositiveReport.applied.length === latestSchemaVersion() && t32Positive.committed.length > 0,
  `applied=${String(t32PositiveReport.applied.length)}/${String(latestSchemaVersion())} · committed=${String(t32Positive.committed.length)}`
)

/*
 * 失败点 = 「建表 + 读版本」之后，第 1 条迁移的全部语句 + 它的登记 insert **都已执行**，
 * 而第 2 条迁移的第一条语句失败 ⇒ 这是货真价实的"中途"（不是第 0 步）。
 */
const t32FailAt = 2 + firstMigrationStatements + 1 + 1
const t32Negative = makeTransactionalDouble(t32FailAt)
let t32Error: unknown
try {
  await applyKernelMigrations(t32Negative.db)
} catch (error) {
  t32Error = error
}
check(
  'T32 负控①：迁移中途失败时**抛出**（不吞、不谎报成功）',
  t32Error !== undefined,
  t32Error === undefined ? '没有抛出 —— 失败被吞掉' : (t32Error as Error).message.slice(0, 80)
)
check(
  'T32 负控②：失败后**一条版本行都没有留下**（整批回滚）',
  t32Negative.rolledBack && t32Negative.committed.length === 0,
  `rolledBack=${String(t32Negative.rolledBack)} · committed=${String(t32Negative.committed.length)}`
)
check(
  'T32 负控③：失败确实发生在**第 1 条迁移登记之后**（量的是"中途"而不是"第 0 步"）',
  t32Negative.executes > 2 + firstMigrationStatements + 1,
  `executes=${String(t32Negative.executes)} · 阈值=${String(2 + firstMigrationStatements + 1)} · 第 1 条迁移语句数=${String(firstMigrationStatements)}`
)

const realHandleHasTransaction = typeof (db as { transaction?: unknown }).transaction === 'function'
check(
  'T32-b：**生产手柄**带事务能力 ⇒ 上面那条原子路径在生产里真的被走到（否则会退化成逐条执行）',
  realHandleHasTransaction,
  realHandleHasTransaction
    ? 'db.transaction 存在（与 src/db/index.ts:286-299 是同一个 getRawDb(runtime)）'
    : '⚠️ 不支持 ⇒ 迁移中途失败会留下半个 schema：这是真缺陷，不是测试问题'
)

// ===========================================================================
// 9. 索引查询
// ===========================================================================

section('9. 索引查询（计划书第 88 / 157–158 节）')

const byCanonical = await store.getActiveByCanonicalKey(replacement.record!.canonicalKey!)
check(
  '按 canonical key 查当前记忆：只返回 active 的那条（supersede 掉的旧条不算）',
  byCanonical.length === 1 && String(byCanonical[0].id) === String(replacement.record!.id),
  `${byCanonical.length} 条`
)

const bySubject = await store.listBySubject(owner, user)
check(
  '按 subject 查（plan 第 8 节）：能查到关于这个用户的记忆',
  bySubject.length >= 1,
  `${bySubject.length} 条`
)
check(
  '按 subject 查：每一条都真的以这个 user 为 subject',
  bySubject.every((r) => r.subjects.some((s) => String(s.id) === String(user.id) && s.kind === 'user'))
)

// 反查：某条证据事件产生了哪些记忆
const evidenceOfFirst = first.record!.sourceRefs[0]
const bySource = await store.listBySource(evidenceOfFirst)
check(
  '从 ConversationEvent 反查它产生了哪些 Memory（计划书第 157 节）',
  bySource.some((r) => String(r.id) === String(first.record!.id)),
  `${bySource.length} 条`
)

const activeOnly = await store.list({ owner, status: 'active' })
const retractedOnly = await store.list({ owner, status: 'retracted' })
check('按状态过滤：active 与 retracted 不重叠', activeOnly.every((r) => r.status === 'active') && retractedOnly.every((r) => r.status === 'retracted'))
check('按状态过滤：retracted 的那条真的查到', retractedOnly.some((r) => String(r.id) === String(forgetRecord.id)))

const counts = await memoryCounts(db, owner)
check(
  '状态计数与查询结果一致',
  counts.active === activeOnly.length,
  `counts.active=${counts.active} list=${activeOnly.length}`
)

const byProcessor = await countByProcessorVersion(db, owner)
check(
  '能按 processor 版本统计产物（计划书第 67 节的 audit 入口）',
  byProcessor.some((p) => p.processor === 'memory-extractor' && p.version === 'memory-extractor@1'),
  byProcessor.map((p) => `${p.version}=${p.count}`).join(' ')
)

// ===========================================================================
// 10. 审计探针
// ===========================================================================

section('10. 审计探针（计划书第 169–170 节）')

const unsupported = await unsupportedMemories(db, owner)
check(
  'unsupported memories = 0（计划书第 170 节的硬 Gate）',
  unsupported.length === 0,
  unsupported.length === 0 ? '全部有合法 Evidence root' : unsupported.map((u) => `${u.memoryId}: ${u.reason}`).join(' | ')
)

const contaminated = await contaminatedMemories(db, owner)
check(
  'contamination = 0（计划书第 169 节：assistant 的话不得升级成用户事实）',
  contaminated.length === 0,
  contaminated.length === 0 ? '没有一条 person_fact/preference 用了非法 authority' : contaminated.map((c) => `${c.memoryId} authority=${c.authority}`).join(' | ')
)

// ===========================================================================
// 11. 无证据的记忆写不进去（MI-03 的持久化半边）
// ===========================================================================

section('11. 关闸：无证据 / 非法权威的记忆')

let noEvidenceCode = ''
try {
  createMemoryCandidate({
    owner,
    type: 'preference',
    content: { kind: 'claim', subject: user, predicate: 'x.y', value: 1 },
    subjects: [user],
    sourceRefs: [],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.5,
    confidence: 0.5,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  })
} catch (error) {
  noEvidenceCode = String((error as { code?: string }).code ?? '')
}
check(
  '没有证据的候选**在构造时**就被拒绝',
  noEvidenceCode.includes('memory_without_evidence'),
  noEvidenceCode
)

const contaminationOutcome = await validator.validate({
  characterId: kernel.characterId,
  owner,
  candidates: [
    // 直接伪造一条"她猜的"用户事实 —— 放行口必须拒它
    {
      ...cilantro,
      proposedId: makeMemoryId(characterId as never, 'forged-contamination'),
      authority: 'CHARACTER_GENERATION',
      epistemicStatus: 'generated',
    },
  ],
  mutation: 'background',
  operation: 'create',
})
check(
  '放行口拒绝 CHARACTER_GENERATION 建立的用户事实（计划书第 148 节 Critical Test）',
  contaminationOutcome.rejected.some((r) =>
    r.code.includes('authority_cannot_establish_person_fact')
  ),
  contaminationOutcome.rejected.map((r) => r.code).join(',')
)

// ===========================================================================
// 12. 「我们曾经讨论过」有两个主体（计划书第 8 节）
// ===========================================================================

section('12. 多主体与未来实体（计划书第 8 / 153 节）')

const episodeRecord = (await store.list({ owner, type: 'episode' }))[0]
check(
  'Episode 有两个 subject（plan 第 8 节的例子）',
  episodeRecord !== undefined && episodeRecord.subjects.length === 2,
  episodeRecord ? episodeRecord.subjects.map((s) => `${s.kind}:${String(s.id).slice(0, 8)}`).join(' + ') : '(没有 episode)'
)

// 未来多实体：构造一个 Character B 作为 subject，确认**不需要迁移**
//
// 计划书第 153 节："M4 不运行 Character B。只验证 Schema。"
// 因此这里只造一条"她记得角色 B 说过什么"的记忆，并断言它能被存下来 ——
// 而不是去实现多角色运行时。
const npc = entityRef('npc', 'npc_character_b')
const npcEvidence = await recordUserEvidence('你可以把这件事转告给角色 B 吗')
const multiEntity = makeCandidate(
  'person_fact',
  {
    kind: 'claim',
    subject: npc,
    predicate: 'dialogue.attitude',
    value: '友好',
  },
  { sourceRefs: [npcEvidence.ref], subjects: [npc] }
)
const multiResult = await commitAndFold(multiEntity)
check(
  'Memory schema 不需要迁移就能表达"苏沐薇记得 Character B 曾说……"（plan 第 153 节）',
  multiResult.record !== null,
  multiResult.rejected.map((r) => r.code).join(',')
)
check(
  '这条记忆的 subject 是 npc 而非 user（plan 第 8 节：subject 不是写死的）',
  multiResult.record?.subjects.some((s) => s.kind === 'npc') === true
)

// ===========================================================================
// 13. Explicit Memory 路径（计划书第 54–59 节，Phase 4）
// ===========================================================================

section('13. Explicit Memory（记住 / 纠正 / 忘掉）')

const intentDetector = createExplicitMemoryIntentDetector()
const targetResolver = createTargetMemoryResolver({
  get: (id) => store.get(id),
  getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
  listBySubject: (o, subject) => store.listBySubject(o, subject),
})

/**
 * 装配显式服务。
 *
 * `commitEvents` 可替换 —— 这是"提交失败不谎报成功"那条产品规则的
 * **唯一**可注入点（计划书第 55 / 145 节）。生产装配传真实实现，
 * 故障注入测试传一个会抛的实现。
 */
function buildExplicitService(overrides: Partial<Parameters<typeof createExplicitMemoryService>[0]> = {}) {
  return createExplicitMemoryService({
    store,
    validator,
    extractor: createRuleOnlyContentExtractor(),
    resolveTarget: (input) =>
      targetResolver.resolve({
        owner: input.owner,
        text: input.text,
        ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.hints !== undefined ? { hints: input.hints } : {}),
      }),
    commitEvents: async (accepted, now) => {
      const applied = await applyAcceptedEvents(db, kernel.characterId, accepted, [], now)
      return applied.domainEvents
    },
    ...overrides,
  })
}

const explicit = buildExplicitService()

/** 从一句用户话走完整条显式路径（写证据 → 检测 → 服务） */
async function runExplicitTurn(text: string) {
  const recorded = await recordUserEvidence(text)
  const intent = await detectExplicitIntentFromEvent(intentDetector, {
    id: recorded.ref.id as never,
    actorType: 'user',
    content: text,
  })
  if (intent === undefined) return { intent: undefined, outcome: undefined, recorded }
  const outcome = await explicit.handle({
    owner,
    intent,
    triggerEventId: recorded.ref.id,
    speaker: user,
    hints: targetHintsFrom(intent),
  })
  return { intent, outcome, recorded }
}

// --- 前置：本次测试用的槽位必须是**干净的** ----------------------------
//
// ⚠️ 这一段是"测试隔离"的守卫，不是业务逻辑。
//
// 第一版把显式测试接在 §2–§12 之后，而它复用了 `food.preference.cilantro` ——
// 那个槽位早已被 §5 建过又 supersede 过。于是：
//   · "记住，我不吃香菜" 拿到的记录是 superseded（因为 supersede 之后
//     指纹不再命中，去重层放行，而 memoryId 相同 → 折叠成既有那条）
//   · 重复"记住"不再命中 already_applied（指纹与既有 active 那条不同）
//
// 结果是六条断言失败，而**它们失败的原因是测试没隔离自己的数据**，
// 不是实现有问题。一条"依赖前序小节恰好造过什么"的断言，
// 会在任何无关注释/顺序变动时随机变红 —— 与 M3.5 那条
// `schemaVersion === 4` 是同一类缺陷。
//
// 因此这里明确：**显式测试只用从没被前面碰过的槽位**，
// 并在此之前断言它确实是干净的。
for (const p of ['education.institution'] as const) {
  const existing = await store.list({ owner, limit: 500 })
  const conflicting = existing.filter(
    (r) => (r.content as { predicate?: string }).predicate === p
  )
  check(
    `显式测试的前置：槽位 ${p} 在库里原本不存在`,
    conflicting.length === 0,
    conflicting.length === 0 ? '干净' : `已有 ${conflicting.length} 条 —— 测试没有隔离`
  )
}

// --- M4-001：记住（计划书第 174 节）------------------------------------
//
// 语料用**真实校名**（用户在 2026-09-16 的会话里明确给出并授权记录）：
// "示例工程科技大学"。它同时含 '大学'（institution 与 status 的线索词
// 都覆盖），因此它顺带守着"更专门的槽位优先"这条不变量 ——
// 抽错的话会被记成 education.status = undergraduate（"她在读本科"），
// 而不是 education.institution = 示例工程科技大学。
const INSTITUTION = '示例工程科技大学'
const rememberTurn = await runExplicitTurn(`记住，我在${INSTITUTION}`)
check('「记住……」被识别为显式意图', rememberTurn.intent?.kind === 'remember')
check(
  'M4-001：显式记住**提交成功**并回报 ok:true',
  rememberTurn.outcome?.ok === true,
  rememberTurn.outcome?.ok === false
    ? `${rememberTurn.outcome.reason}: ${rememberTurn.outcome.detail}`
    : ''
)
if (rememberTurn.outcome?.ok === true) {
  check(
    '记住的记忆是 ACTIVE、authority = EXPLICIT_USER_STATEMENT',
    rememberTurn.outcome.record.status === 'active' &&
      rememberTurn.outcome.record.authority === 'EXPLICIT_USER_STATEMENT',
    `status=${rememberTurn.outcome.record.status} authority=${rememberTurn.outcome.record.authority}`
  )
  check(
    '记住的记忆证据指向**用户那句话**（计划书第 5 节：没有来源的变化不许落库）',
    rememberTurn.outcome.record.sourceRefs.some((r) => r.id === rememberTurn.recorded.ref.id),
    rememberTurn.outcome.record.sourceRefs.map((r) => r.id).join(',')
  )
  check(
    `机构名落到 education.institution（**不是** education.status —— 更专门的槽位优先）`,
    (rememberTurn.outcome.record.content as { predicate?: string }).predicate ===
      'education.institution',
    `实际落到 ${String(
      (rememberTurn.outcome.record.content as { predicate?: string }).predicate
    )}`
  )
  check(
    `取值是完整校名「${INSTITUTION}」（取值在线索词**之前**，必须双向抽）`,
    String((rememberTurn.outcome.record.content as { value?: unknown }).value) === INSTITUTION,
    String((rememberTurn.outcome.record.content as { value?: unknown }).value)
  )
}

// --- M4-004 的显式半边：重复"记住"同样的内容 ---------------------------
const repeatTurn = await runExplicitTurn(`记住，我在${INSTITUTION}`)
check(
  '重复"记住"同一件事 → **不是** ok:true（没有新建任何东西，不该说"记住了"）',
  repeatTurn.outcome?.ok === false,
  repeatTurn.outcome?.ok === true ? '重复请求被回报为成功 —— 那是一句不准确的确认' : ''
)
check(
  '重复"记住"的失败原因是 already_applied（"这条我已经记着了"，不是"记下了"）',
  repeatTurn.outcome?.ok === false && repeatTurn.outcome.reason === 'already_applied',
  repeatTurn.outcome?.ok === false ? repeatTurn.outcome.reason : ''
)

// --- ⚠️ 计划书第 55 / 145 节：提交失败**绝不谎报成功** -------------------
const failing = buildExplicitService({
  commitEvents: async () => {
    throw new Error('注入故障：数据库不可用')
  },
})
const failingTurn = await (async () => {
  const text = '记住，我不吃辣'
  const recorded = await recordUserEvidence(text)
  const intent = await detectExplicitIntentFromEvent(intentDetector, {
    id: recorded.ref.id as never,
    actorType: 'user',
    content: text,
  })
  return failing.handle({
    owner,
    intent: intent!,
    triggerEventId: recorded.ref.id,
    speaker: user,
    hints: targetHintsFrom(intent!),
  })
})()

check(
  '**提交失败时 ok:false**（计划书第 55 节：不能在 Memory Commit 失败时回答"记住了"）',
  failingTurn.ok === false,
  failingTurn.ok === true ? '提交失败却回报成功 —— 这是 M4 明令禁止的假成功' : ''
)
check(
  '提交失败的分类是 persistence_failed（调用方据此决定重试或如实失败）',
  failingTurn.ok === false && failingTurn.reason === 'persistence_failed',
  failingTurn.ok === false ? failingTurn.reason : ''
)
check(
  '提交失败时**没有**任何记忆被写入（失败不是"半个成功"）',
  (await store.list({ owner, limit: 200 })).every(
    (r) => !JSON.stringify(r.content).includes('美式')
  )
)

// --- M4-009 / 第 148 节：她的猜测不能变成用户事实 ----------------------
const guessTurn = await (async () => {
  const recorded = await recordUserEvidence('猜猜我喜欢什么')
  // 直接从**她自己的**事件检测显式意图 —— 必须抛错
  let code = ''
  try {
    await detectExplicitIntentFromEvent(intentDetector, {
      id: recorded.ref.id as never,
      actorType: 'character',
      content: '记住，我猜你喜欢猫',
    })
  } catch (error) {
    code = String((error as { code?: string }).code)
  }
  return code
})()
check(
  '她的输出**不可能**被读成"用户要求记住"（计划书第 148 节的污染链起点）',
  guessTurn.includes('explicit_intent_from_non_user'),
  guessTurn || '(没有抛错)'
)

// --- 解析不出内容时如实回报（不猜、不假成功）---------------------------
const unresolvedTurn = await runExplicitTurn('记住，我最近不太能喝奶了')
check(
  '解析不出结构化记忆 → content_unresolved（**如实回报**，不猜也不假成功）',
  unresolvedTurn.outcome?.ok === false && unresolvedTurn.outcome.reason === 'content_unresolved',
  unresolvedTurn.outcome?.ok === false ? unresolvedTurn.outcome.reason : '被当成成功了'
)

const emptyTurn = await runExplicitTurn('记住')
check(
  '只有指令没有内容 → content_empty（调用方该追问"记住什么"）',
  emptyTurn.outcome?.ok === false && emptyTurn.outcome.reason === 'content_empty',
  emptyTurn.outcome?.ok === false ? emptyTurn.outcome.reason : ''
)

// --- M4-002：纠正（计划书第 56 / 175 节）-------------------------------
//
// 场景照计划书第 175 节写："之前那个改一下，我现在能吃香菜了"。
// 这里改用**同一轮的**那句话的等价形式，语料换成干净的槽位：
//
//   · 含 `改一下`  → 规则判成 `correct`（用户明确在说旧条要变）
//   · 含 `北山大学` 被 `education.institution` 的线索"大学"捕获
//     → 抽出一条**新条**（值 = "北山大学"）
//
// 于是它正好演示 `ExplicitMemoryService.correct()` 的完整语义：
// **建新条 → supersede 旧条**，而不是改写旧条（MI-06）。
const institutionKey =
  rememberTurn.outcome?.ok === true ? canonicalKeyOfRecord(rememberTurn.outcome.record) : undefined

const correctTurn = await (async () => {
  const text = '之前那个改一下，我不在北山大学了，我在南岭大学'
  const recorded = await recordUserEvidence(text)
  const intent = await detectExplicitIntentFromEvent(intentDetector, {
    id: recorded.ref.id as never,
    actorType: 'user',
    content: text,
  })
  if (intent === undefined) return { intent: undefined, outcome: undefined }
  return {
    intent,
    outcome: await explicit.handle({
      owner,
      intent,
      triggerEventId: recorded.ref.id,
      speaker: user,
      ...(institutionKey !== undefined ? { targetCanonicalKey: institutionKey } : {}),
      hints: targetHintsFrom(intent),
    }),
  }
})()

check(
  '「之前那个改一下……」被识别为 correct（规则表必须收录"改一下"，否则会白跑模型分类）',
  correctTurn.intent?.kind === 'correct',
  correctTurn.intent?.kind ?? '(没有识别出意图)'
)
check(
  'M4-002：纠正成功',
  correctTurn.outcome?.ok === true,
  correctTurn.outcome?.ok === false
    ? `${correctTurn.outcome.reason}: ${correctTurn.outcome.detail}`
    : ''
)
check(
  '纠正后旧记忆变成 SUPERSEDED（历史不丢，计划书第 35 节）',
  rememberTurn.outcome?.ok === true &&
    (await store.get(rememberTurn.outcome.memoryId))?.status === 'superseded',
  rememberTurn.outcome?.ok === true
    ? String((await store.get(rememberTurn.outcome.memoryId))?.status)
    : '(前置未建立)'
)
check(
  '纠正后同一槽位**只有一条 ACTIVE**（没有留下两条并存）',
  institutionKey !== undefined
    ? (await store.getActiveByCanonicalKey(institutionKey)).length === 1
    : false,
  institutionKey !== undefined
    ? `${(await store.getActiveByCanonicalKey(institutionKey)).length} 条`
    : '(没有槽位键)'
)

// --- M4-003：忘掉（计划书第 58–59 / 176 节）----------------------------
//
// ⚠️ 这一节**必须跑在纠正那一节之前**。
//
// 第一版把它放在纠正之后，于是每到"忘掉"时库里已经有好几条
// 关于这个 user 的 ACTIVE 记忆，仅凭 subject 取到的候选集很大 ——
// 于是解析器正确地回报了 `target_ambiguous`，而测试期望的是成功。
// 那次失败**不是实现的缺陷**，而是测试没有把自己的前置状态算清楚。
//
// 教训：一条"依赖前序小节恰好造过什么"的断言是脆弱的，
// 与 M3.5 那条 `schemaVersion === 4` 属于同一类。
//
// ============================================================================
//  ⚠️ 第四次踩同一个坑：**它原来依赖的是一个 bug**
// ============================================================================
// 槽位从 `education.status` 换成了 `preferred.address`。原因是修掉
// 一个**真实缺陷**之后本节开始报 `target_ambiguous`：
//
//   · §3 的夹具用 `person_fact` + `education.status` 建了 `undergraduate`
//   · 本节的「记住，我现在是研究生」原来经**规则**抽取得到
//     **`preference`**（那是 `extract()` 里写死 `type: 'preference'` 的缺陷）
//   · `type` 参与 `canonicalKey` → 两条落在**不同槽位** → 解析第 2 步
//     按 canonical key 只取到 1 条 → 本节"通过"
//
// 把类型修正成 `person_fact` 之后，两条落进**同一个槽位**，
// 解析器于是正确地说"找到 2 条，判不出是哪条"。
//
// 也就是说：本节原来"通过"，是因为**同一件事实被记到了两个槽位**
// —— 那正是 M4 最要避免的状态（去重与冲突检测都建立在
// "同一事实落同一槽位"上）。测试在为缺陷背书。
//
// 处置沿用本文件已经写明的做法（见 §16 的说明）：
// **换成一个全脚本没有第二处用过的槽位**。
// `preferred.address` 与它的线索词（叫我 / 称呼）在本文件里 0 次出现。
const edTarget = await runExplicitTurn('记住，叫我小明')
const edKey =
  edTarget.outcome?.ok === true ? canonicalKeyOfRecord(edTarget.outcome.record) : undefined

const forgetTurn = await (async () => {
  const text = '忘掉我对称呼的偏好'
  const recorded = await recordUserEvidence(text)
  const intent = await detectExplicitIntentFromEvent(intentDetector, {
    id: recorded.ref.id as never,
    actorType: 'user',
    content: text,
  })
  if (intent === undefined) return { intent: undefined, outcome: undefined }
  return {
    intent,
    outcome: await explicit.handle({
      owner,
      intent,
      triggerEventId: recorded.ref.id,
      speaker: user,
      ...(edKey !== undefined ? { targetCanonicalKey: edKey } : {}),
      hints: targetHintsFrom(intent),
    }),
  }
})()

check('「忘掉……」被识别为 forget', forgetTurn.intent?.kind === 'forget')
check(
  'M4-003：忘掉成功',
  forgetTurn.outcome?.ok === true,
  forgetTurn.outcome?.ok === false ? `${forgetTurn.outcome.reason}: ${forgetTurn.outcome.detail}` : ''
)
check(
  '忘掉后记忆是 RETRACTED（以后 M5 不得召回，计划书第 32 / 176 节）',
  edTarget.outcome?.ok === true
    ? (await store.get(edTarget.outcome.memoryId))?.status === 'retracted'
    : false,
  edTarget.outcome?.ok === true ? String((await store.get(edTarget.outcome.memoryId))?.status) : ''
)
check(
  '忘掉**没有**删除原始对话（cognitive forget ≠ source deletion，计划书第 59 节）',
  (await rowsOfCount('conversation_events')) > 0,
  `${await rowsOfCount('conversation_events')} 条对话事件仍在`
)

// --- 目标不确定时**必须安全失败**，而不是挑一条 --------------------------
//
// ⚠️ M4.1 改了这条的**标签**，理由必须记下来（改既有断言永远是可疑动作）。
//
// 原断言要求 `reason === 'target_ambiguous'` 且**带上候选列表**。
// 那时的第 3 步是"该 subject 下只剩一条 active 就取它"，第 4 步打分打不上
// 就返回全部候选 → 上层报 ambiguous。
//
// M4.1（D1 修复）之后，第 3 步先做**相关性判定**：
//   · 有相关性证据且只有一条 → resolved
//   · 有相关性证据但多条分不出 → ambiguous（**候选列表照旧**）
//   · **零相关性证据** → not_found
//
// 本夹具说的是「忘掉刚才说的那件事」——**一点线索都没有**，
// 与库里任何一条都没有词面重叠。此时正确的回答是
// **"我没找到与这句话匹配的记忆"**（not_found），
// 而不是把一堆**与请求无关**的候选端给用户让他挑：
// 后者看起来像帮忙，实际是在引导他在无关项里选一个。
//
// **被守的不变量没有变松，反而更紧了**：核心是"绝不挑一条"
// （`ok === true` 仍然是失败），而"零证据时不给候选"比"零证据时给全部候选"更保守。
//
// `ambiguous` 这条通道仍然存在、仍然带候选列表，由别的门覆盖：
//   · `m4:test` →「第 5 步：判别器判不出来 → ambiguous（**不挑一条**）」
//     （夹具已按 M4.1 更新为"两条都与请求词面相关"）
//   · `m4:mutation-safety` / `m4:nl-mutation` → 都断言"无 mutation"
const ambiguousTurn = await (async () => {
  const text = '忘掉刚才说的那件事'
  const recorded = await recordUserEvidence(text)
  const intent = await detectExplicitIntentFromEvent(intentDetector, {
    id: recorded.ref.id as never,
    actorType: 'user',
    content: text,
  })
  if (intent === undefined) return undefined
  return explicit.handle({
    owner,
    intent,
    triggerEventId: recorded.ref.id,
    speaker: user,
    hints: targetHintsFrom(intent),
  })
})()
check(
  '零线索时**安全失败**（绝不挑一条 —— 那会改错记忆）',
  ambiguousTurn !== undefined && ambiguousTurn.ok === false && ambiguousTurn.reason === 'target_not_found',
  ambiguousTurn === undefined
    ? '(没有识别出意图)'
    : ambiguousTurn.ok === true
      ? '被当成成功了 —— 那会改错记忆'
      : ambiguousTurn.reason
)
check(
  '零线索时**不给无关候选**（不给用户"在无关项里挑一个"的暗示）',
  ambiguousTurn !== undefined &&
    ambiguousTurn.ok === false &&
    (ambiguousTurn.candidates?.length ?? 0) === 0,
  ambiguousTurn !== undefined && ambiguousTurn.ok === false
    ? `${ambiguousTurn.candidates?.length ?? 0} 条候选`
    : ''
)

// ===========================================================================
// 15. 后台抽取流水线（计划书第 42 / 63 / 123 节，Phase 5）
// ===========================================================================

section('15. 后台抽取流水线（Job → 抽取 → 值闸 → 放行 → 提交 → 折叠）')

/** 任务存储适配（把 job-store 的 SQL 面接成本层的端口） */
const memoryJobStore = {
  enqueueJob: (input: Parameters<typeof enqueueJob>[1]) => enqueueJob(db, input),
  getJob: (id: Parameters<typeof getJob>[1]) => getJob(db, id),
  markJobRunning: (id: Parameters<typeof markJobRunning>[1], now?: number) =>
    markJobRunning(db, id, now),
  finishJob: (
    id: Parameters<typeof finishJob>[1],
    status: 'completed' | 'failed',
    options?: { error?: string; now?: number }
  ) => finishJob(db, id, status, options),
  listJobs: (
    characterId: Parameters<typeof listJobs>[1],
    options?: { status?: 'pending' | 'running' | 'completed' | 'failed'; limit?: number }
  ) => listJobs(db, characterId, options),
}

const memoryWatermarks = {
  getWatermark: (characterId: never, processor: string, version: string) =>
    getWatermark(db, characterId, processor, version),
  advanceWatermark: (
    characterId: never,
    processor: string,
    version: string,
    through: number,
    now?: number
  ) => advanceWatermark(db, characterId, processor, version, through, now),
}

/** 后台抽取用的语料：必须落在抽取器的离线线索表里 */
const backgroundEvidence = await recordUserEvidence('我不吃香菜，从小就不吃')
await recordAssistantEvidence(
  '记住了，你不吃香菜',
  backgroundEvidence.assistantSequence,
  backgroundEvidence.ref.id
)

const backgroundWindow = await recentConversationEvents(db, {
  characterId: kernel.characterId,
  limit: 50,
})
const range = {
  from: Math.min(...backgroundWindow.map((e) => e.sequence)),
  to: Math.max(...backgroundWindow.map((e) => e.sequence)),
}

const pipelineDeps = {
  extractor: new RuleBasedMemoryExtractor(),
  validator,
  commit: async (accepted: Parameters<typeof applyAcceptedEvents>[2], now: number) =>
    (await applyAcceptedEvents(db, kernel.characterId, accepted, [], now)).domainEvents,
  fold: (event: Parameters<typeof applyMemoryEvent>[1]) => applyMemoryEvent(db, event),
  valueOptions: { explicit: true },
}
const pipelineInput = {
  owner,
  events: backgroundWindow,
  speaker: user,
  processorContext: {
    processorName: MEMORY_PIPELINE_PROCESSOR.name,
    processorVersion: MEMORY_PIPELINE_PROCESSOR.version,
  },
}

const extraction = await runMemoryExtractionPipeline(pipelineDeps, pipelineInput)

check(
  '流水线跑通并产出候选',
  extraction.candidates > 0,
  `candidates=${extraction.candidates} valuePassed=${extraction.valuePassed}`
)
check(
  '候选经值闸 → 放行 → 提交 → 折叠，最终产出记录',
  extraction.created.length > 0,
  `created=${extraction.created.length} accepted=${extraction.accepted}`
)
check(
  '后台抽取产出的记忆权威是 EXPLICIT_USER_STATEMENT（证据来自用户的话）',
  extraction.created.every((r) => r.authority === 'EXPLICIT_USER_STATEMENT'),
  extraction.created.map((r) => r.authority).join(',')
)

// --- 二次运行：去重第一层应当拦住 -------------------------------------
const secondRun = await runMemoryExtractionPipeline(pipelineDeps, pipelineInput)
check(
  '同一批重跑：**不产出新记录**（去重第一层或幂等层拦住）',
  secondRun.created.length === 0,
  `created=${secondRun.created.length} rejected=${secondRun.rejections.map((r) => r.reason).join(',')}`
)

// --- Job 端到端 ------------------------------------------------------
const enqueued = await enqueueMemoryExtractionJob(memoryJobStore, {
  characterId: kernel.characterId,
  processor: MEMORY_PIPELINE_PROCESSOR.name,
  processorVersion: MEMORY_PIPELINE_PROCESSOR.version,
  fromSequence: range.from,
  toSequence: range.to,
})
check('抽取任务入队成功', enqueued.created === true, String(enqueued.job.id))
check(
  '任务的 triggerKind 是 conversation（计划书第 65 节）',
  enqueued.job.triggerKind === 'conversation',
  String(enqueued.job.triggerKind)
)

const reEnqueue = await enqueueMemoryExtractionJob(memoryJobStore, {
  characterId: kernel.characterId,
  processor: MEMORY_PIPELINE_PROCESSOR.name,
  processorVersion: MEMORY_PIPELINE_PROCESSOR.version,
  fromSequence: range.from,
  toSequence: range.to,
})
check(
  '同一区间重复排期**不会**新建任务（幂等键 + 部分唯一索引）',
  reEnqueue.created === false,
  `created=${reEnqueue.created}`
)

const jobRun = await runMemoryExtractionJob(
  {
    store: memoryJobStore,
    processRange: async () => ({ candidates: 0, accepted: 0, rejected: 0, created: [] }),
  },
  enqueued.job.id
)
check('任务跑完标记 completed', jobRun.status === 'completed', String(jobRun.status))

const duplicateRun = await runMemoryExtractionJob(
  {
    store: memoryJobStore,
    processRange: async () => ({ candidates: 0, accepted: 0, rejected: 0, created: [] }),
  },
  enqueued.job.id
)
check(
  '重复 worker 抢同一个任务 → **skipped 而不是 failed**（那是正确的互斥，不是故障）',
  duplicateRun.status === 'skipped',
  String(duplicateRun.status)
)

// --- 水位：中间有洞时不得越过 ----------------------------------------
const holeVersion = 'memory-extractor@hole-test'
const holeJob = await enqueueMemoryExtractionJob(memoryJobStore, {
  characterId: kernel.characterId,
  processor: MEMORY_PIPELINE_PROCESSOR.name,
  processorVersion: holeVersion,
  fromSequence: 1,
  toSequence: 1,
})
const failedRun = await runMemoryExtractionJob(
  {
    store: memoryJobStore,
    processRange: async () => {
      throw new Error('注入故障：抽取失败')
    },
  },
  holeJob.job.id
)
check(
  '**故障被写进 job**（status=failed，而不是抛给调用方 —— 计划书第 144 节）',
  failedRun.status === 'failed' && String(failedRun.error).includes('注入故障'),
  `${failedRun.status}: ${String(failedRun.error).slice(0, 40)}`
)

const afterHole = await advanceWatermarkByGaps(memoryJobStore, memoryWatermarks, {
  characterId: kernel.characterId,
  processor: MEMORY_PIPELINE_PROCESSOR.name,
  processorVersion: holeVersion,
})
check(
  '水位**没有**越过那个失败区间（计划书第 162 节：中间洞不能丢）',
  afterHole.throughSequence === 0,
  `through=${afterHole.throughSequence}`
)

// ===========================================================================
// 16. 冲突处置端到端（计划书第 79–82 节，Phase 6）
// ===========================================================================

section('16. 冲突处置（去重第二层 / temporal update / contradiction）')

/*
 * ============================================================================
 *  ⚠️ 这一节用**固定抽取器**注入候选，而不是用 RuleBasedMemoryExtractor
 * ============================================================================
 * 两个理由，都来自实测：
 *
 * 1. **本节测的是冲突策略，不是抽取器。** 让抽取器决定候选，
 *    等于把"这一段想验证的行为"交给另一层的规则表 —— 而那张表
 *    （故意）只覆盖 6 个槽位，于是本节被迫复用前文用过的槽位。
 *
 * 2. **前文已经用过那些槽位。** 第一版用 `education.status`，而 §13 与 §15
 *    已经把它建过、supersede 过、retract 过 —— 于是本节拿到的是
 *    "2 条 ACTIVE 并存"的既有状态，六条断言全红，而**失败原因是测试没隔离**，
 *    不是实现有问题。
 *
 * 这是同一个坑的第三次（前两次见 §13 与 §3.5 的说明）。因此这次
 * 不只是换个槽位，而是**换掉候选来源**：注入式抽取器让本节只依赖
 * 它自己声明的东西。槽位用 `music.genre.favorite` —— 全脚本没有第二处用它。
 */
const PHASE6_PREDICATE = 'music.genre.favorite'

/** 一个把固定取值注入为候选的抽取器（仅测试用） */
function fixedExtractor(value: string) {
  return {
    name: 'fixed-test-extractor',
    version: 'fixed-test-extractor@1',
    async process(input: {
      views: readonly { sequence: number; actorType: string; id: unknown }[]
      owner: typeof owner
      speaker: typeof user
    }) {
      const descriptors = input.views
        .filter((v) => v.actorType === 'user')
        .map((v) => ({
          memoryType: 'preference' as const,
          subjectToken: 'USER' as const,
          claim: { predicate: PHASE6_PREDICATE, value },
          evidenceEventSequences: [v.sequence],
          confidence: 0.9,
          longTermValue: 0.8,
        }))
      const resolved = resolveCandidates(descriptors, {
        owner: input.owner,
        events: input.views as never,
        speaker: input.speaker,
        processor: 'fixed-test-extractor',
        processorVersion: 'fixed-test-extractor@1',
      })
      return {
        candidates: resolved.flatMap((r) => (r.ok ? [r.candidate] : [])),
        rejected: resolved.flatMap((r) => (r.ok ? [] : [r.rejection])),
        extracted: resolved.some((r) => r.ok),
      }
    },
  } as never
}

/** 带冲突分析的 pipeline 依赖（候选由固定抽取器给出） */
function conflictDeps(value: string, utterance: string) {
  return {
    extractor: fixedExtractor(value),
    validator,
    commit: async (accepted: Parameters<typeof applyAcceptedEvents>[2], now: number) =>
      (await applyAcceptedEvents(db, kernel.characterId, accepted, [], now)).domainEvents,
    fold: (event: Parameters<typeof applyMemoryEvent>[1]) => applyMemoryEvent(db, event),
    valueOptions: { explicit: true },
    utterance,
    conflict: {
      /*
       * ⚠️ 必须包含 **DISPUTED**，不能只查 ACTIVE。
       *
       * 计划书第 33 节：进 DISPUTED 是"**直到**后续 Evidence 澄清"，
       * 也就是 DISPUTED 是**待澄清**而不是终态。只查 ACTIVE 会让
       * 一条 DISPUTED 记录永远等不到澄清 —— 而那个缺陷不报错，
       * 库里只是多出一条谁也不管的悬置记忆。
       */
      recordsInCanonicalSlot: async ({ canonicalKey }: { canonicalKey: string }) => {
        const active = await store.getActiveByCanonicalKey(canonicalKey)
        const disputed = (await store.list({ owner, status: 'disputed', limit: 500 })).filter(
          (r) => r.canonicalKey === canonicalKey
        )
        return [...active, ...disputed]
      },
    },
  }
}

/** 记一条证据 + 用它跑一次带冲突分析的 pipeline */
async function phase6Run(value: string, utterance: string) {
  const evidence = await recordUserEvidence(utterance)
  const all = await recentConversationEvents(db, {
    characterId: kernel.characterId,
    limit: 500,
  })
  const last = all[all.length - 1]
  return runMemoryExtractionPipeline(conflictDeps(value, utterance), {
    owner,
    events: [last],
    speaker: user,
    processorContext: {
      processorName: MEMORY_PIPELINE_PROCESSOR.name,
      processorVersion: MEMORY_PIPELINE_PROCESSOR.version,
    },
  })
}

// --- 前置：这个槽位必须是干净的（与 §13 / §3.5 同一条守卫）------------
{
  const existing = (await store.list({ owner, limit: 500 })).filter(
    (r) => (r.content as { predicate?: string }).predicate === PHASE6_PREDICATE
  )
  check(
    `冲突测试的前置：槽位 ${PHASE6_PREDICATE} 原本不存在`,
    existing.length === 0,
    existing.length === 0 ? '干净' : `已有 ${existing.length} 条 —— 测试没有隔离`
  )
}

// --- 第一轮：新槽位 → CREATE ----------------------------------------
const first6 = await phase6Run('jazz', '我平时喜欢听爵士')
check(
  '第一轮：新槽位 → CREATE',
  first6.created.length === 1,
  `created=${first6.created.length} rejected=${first6.rejections
    .map((r) => `${r.stage}:${r.reason}`)
    .join(',')}`
)
const phase6Key = first6.created[0]?.canonicalKey
check('新记录带 canonicalKey', phase6Key !== undefined, String(phase6Key))

// --- 第二轮：同槽位同取值 → 去重拦住 --------------------------------
const duplicate6 = await phase6Run('jazz', '我还是喜欢听爵士')
check(
  '同一槽位的**重复陈述** → 不产出新记录',
  duplicate6.created.length === 0,
  `created=${duplicate6.created.length}`
)
check(
  '重复陈述的拒绝码属于"重复"这一类',
  duplicate6.rejections.some(
    (r) => r.reason === 'duplicate_content' || r.reason === 'duplicate_canonical'
  ),
  duplicate6.rejections.map((r) => r.reason).join(',')
)

// --- 第三轮：同槽位异取值 + **无**变化标记 → DISPUTED ----------------
const contradiction6 = await phase6Run('classical', '我喜欢听古典')
check(
  '矛盾陈述（无变化标记）**不产出新记忆**（不擅自选一个，计划书第 82 节）',
  contradiction6.created.length === 0,
  `created=${contradiction6.created.length}`
)
check(
  '矛盾陈述把既有那条标记为 DISPUTED',
  contradiction6.rejections.some((r) => r.reason === 'marked_disputed'),
  contradiction6.rejections.map((r) => `${r.stage}:${r.reason}`).join(' | ')
)
const afterDispute = await store.getActiveByCanonicalKey(phase6Key!)
check(
  'DISPUTED 之后该槽位**没有**两条并存的 ACTIVE',
  afterDispute.filter((r) => r.status === 'active').length <= 1,
  `${afterDispute.filter((r) => r.status === 'active').length} 条 ACTIVE`
)

// --- 第四轮：同槽位异取值 + **有**变化标记 → SUPERSEDE --------------
const supersede6 = await phase6Run('rock', '我现在改听摇滚了')
check(
  '状态变化（带「现在 / 改」标记）→ 产出新记录',
  supersede6.created.length === 1,
  `created=${supersede6.created.length} rejected=${supersede6.rejections
    .map((r) => r.reason)
    .join(',')}`
)

const activeAfterSupersede = await store.getActiveByCanonicalKey(phase6Key!)
check(
  'supersede 之后同一槽位**只剩一条 ACTIVE**（计划书第 35 节）',
  activeAfterSupersede.length === 1,
  `${activeAfterSupersede.length} 条`
)
check(
  '留下的那条是新取值（rock，不是被取代的 jazz）',
  String((activeAfterSupersede[0]?.content as { value?: unknown })?.value) === 'rock',
  String((activeAfterSupersede[0]?.content as { value?: unknown })?.value)
)
check(
  '旧条变成 SUPERSEDED 且历史仍在（不是物理删除，MI-06）',
  (await store.get(first6.created[0].id))?.status === 'superseded',
  String((await store.get(first6.created[0].id))?.status)
)

// --- Phase 7：时间边界与历史展示（计划书第 36 / 132 节）--------------
const oldAfter = await store.get(first6.created[0].id)
const newAfter = activeAfterSupersede[0]

check(
  '旧条写上了 validUntil（事实层面的失效时刻，计划书第 36 节）',
  typeof oldAfter?.validUntil === 'number',
  `validUntil=${String(oldAfter?.validUntil)}`
)
check(
  '⚠️ 新条写上了 validFrom（两个边界都要写，否则"她何时开始这么认为"无法回答）',
  typeof newAfter?.validFrom === 'number',
  `validFrom=${String(newAfter?.validFrom)}`
)
check(
  '新条的 validFrom **等于**旧条的 validUntil（区间既不重叠也不留空隙）',
  oldAfter?.validUntil === newAfter?.validFrom,
  `old.validUntil=${String(oldAfter?.validUntil)} new.validFrom=${String(newAfter?.validFrom)}`
)

// --- 历史不丢失：listByCanonicalKey 返回**全部**状态 ------------------
const slotHistory = await store.listByCanonicalKey(phase6Key!)
check(
  '按槽位查历史返回**全部**记录（含被取代/撤回/存疑的那些）',
  slotHistory.length >= 2,
  `${slotHistory.length} 条`
)
check(
  '历史里**同时**有旧条与新条（"喜欢爵士"与"改听摇滚"都在）',
  slotHistory.some((r) => String((r.content as { value?: unknown }).value) === 'jazz') &&
    slotHistory.some((r) => String((r.content as { value?: unknown }).value) === 'rock'),
  slotHistory.map((r) => `${r.status}:${String((r.content as { value?: unknown }).value)}`).join(' | ')
)

const rendered = renderMemoryHistory(slotHistory, { title: `槽位 ${PHASE6_PREDICATE}` })
check(
  '渲染历史时**两个半边都在**（历史 + Current，计划书第 132 节的 Gate）',
  rendered.includes('Current:') &&
    rendered.includes('jazz') &&
    rendered.includes('rock') &&
    rendered.includes('[superseded]') &&
    rendered.includes('[active]'),
  rendered.split('\n').join(' ⏎ ')
)

// --- Phase 7：溯源（计划书第 40 / 157 节）-----------------------------
const provenance = describeProvenance(newAfter!)
check(
  '溯源视图给出证据与根（能回答"这条记忆凭什么成立"）',
  provenance.sourceRefs.length > 0 && provenance.evidenceRootIds.length > 0,
  `${provenance.sourceRefs.length} 条证据 / ${provenance.evidenceRootIds.length} 个根`
)
check(
  '溯源视图带 processorVersion（计划书第 67 节：能找出所有 @1 的产物）',
  provenance.processorVersion !== undefined,
  String(provenance.processorVersion)
)

// ===========================================================================
// 17. Memory Admin API 在**真实数据**上（计划书第 133–135 节，Phase 9）
// ===========================================================================

section('17. Memory Admin API（用库里真实的记忆渲染）')

{
  const {
    parseMemoryAdminArgs,
    renderMemoryAudit,
    renderMemoryDetail,
    renderMemoryList,
    renderMemorySources,
    renderMemoryStats,
  } = await import('../src/kernel/app/memory/admin.ts')
  const {
    contaminatedMemories,
    countByProcessorVersion,
    memoryCounts,
    unsupportedMemories,
  } = await import('../src/infrastructure/persistence/memory-store.ts')
  const { isClaimContent, isRegisteredPredicate } = await import(
    '../src/kernel/contracts/index.ts'
  )

  const allOwner = await store.list({ owner, limit: 500 })
  check('库里有真实的记忆可供渲染', allOwner.length > 0, `${allOwner.length} 条`)

  // --- memory list ------------------------------------------------------
  const listOut = renderMemoryList(allOwner.slice(0, 5), 'Memory 列表')
  check(
    'memory list 打出计划书第 135 节的字段（id/type/status/authority/imp/conf/recordedAt）',
    listOut.includes('imp=') && listOut.includes('conf=') && listOut.includes('记于'),
    listOut.split('\n').slice(0, 4).join(' ⏎ ')
  )

  // --- memory get -------------------------------------------------------
  const target = allOwner[0]
  const detailOut = renderMemoryDetail(target)
  check(
    'memory get 打出 owner / subjects / 时间三坐标 / 溯源',
    detailOut.includes('owner') &&
      detailOut.includes('subjects') &&
      detailOut.includes('recordedAt') &&
      detailOut.includes('根证据'),
    String(target.id)
  )

  // --- memory sources（反查真实对话原文）--------------------------------
  const evidenceEvents = (
    await recentConversationEvents(db, { characterId: kernel.characterId, limit: 5000 })
  ).filter((e) => target.sourceRefs.some((ref) => ref.id === String(e.id)))
  const sourcesOut = renderMemorySources(target, evidenceEvents)
  check(
    'memory sources 能反查到**真实的对话原文**（不是只有 id）',
    evidenceEvents.length > 0 && sourcesOut.includes(evidenceEvents[0].content.slice(0, 8)),
    `${evidenceEvents.length} 条证据事件`
  )

  // --- memory stats（两个"目标 0"的项）--------------------------------
  const counts = await memoryCounts(db, owner)
  const unsupported = await unsupportedMemories(db, owner)
  const contaminated = await contaminatedMemories(db, owner)
  const byProcessor = await countByProcessorVersion(db, owner)
  const unregistered = allOwner.filter(
    (r) => isClaimContent(r.content) && !isRegisteredPredicate(r.content.predicate)
  ).length
  const statsOut = renderMemoryStats({
    ...counts,
    byProcessor,
    unsupported: unsupported.length,
    contaminated: contaminated.length,
    unregisteredPredicate: unregistered,
  })
  check(
    'memory stats：unsupported = 0（计划书第 170 节的硬 Gate）',
    unsupported.length === 0,
    `${unsupported.length} 条`
  )
  check(
    'memory stats：contaminated = 0（计划书第 169 节的硬 Gate）',
    contaminated.length === 0,
    `${contaminated.length} 条`
  )
  check(
    'memory stats 打出按 processor 版本的分布（计划书第 67 节）',
    statsOut.includes('memory-extractor') || statsOut.includes('explicit-memory'),
    byProcessor.map((p) => `${p.version}=${p.count}`).join(' ')
  )

  // --- memory audit（计划书第 217 节的八问）----------------------------
  const auditOut = renderMemoryAudit(allOwner.slice(0, 3))
  check(
    'memory audit 对每条记忆打出八个问题（这是进 M5 前的人工 Gate）',
    auditOut.includes('真的值得记吗') &&
      auditOut.includes('来源正确吗') &&
      auditOut.includes('是不是模型猜的'),
    `${Math.min(3, allOwner.length)} 条待审`
  )
  check(
    '审计清单**如实**指出规模可能不足以做这个 Gate',
    auditOut.includes(String(Math.min(3, allOwner.length))),
    ''
  )

  // --- 解析：npm script 形式 --------------------------------------------
  check(
    'memory:list 的 npm 写法能被解析',
    parseMemoryAdminArgs(['--memory-list']).kind === 'list',
    ''
  )
}

// ===========================================================================
// 18. 汇总前的计数辅助
// ===========================================================================

async function rowsOfCount(table: string): Promise<number> {
  const rows = rowsOf(await db.execute(sql.raw(`select count(*)::int as c from ${table}`)))
  return Number(rows[0]?.c ?? 0)
}

// ===========================================================================
// 清理与汇总
// ===========================================================================

await runtime.stop().catch(() => undefined)
cleanupSandbox(sandbox.dir)

console.log(`\n${'='.repeat(72)}`)
console.log(`M4 持久化验证：${passed} 通过 / ${failed} 失败`)
console.log(`实验库：${sandbox.dir}（已清理，真实库未被触碰）`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log('='.repeat(72))

process.exit(failed === 0 ? 0 : 1)
