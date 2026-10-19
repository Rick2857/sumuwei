/**
 * M2.5 Phase C 验收：持久化地基。
 *
 * 检查：
 *   1. 空库 → 最新 schema（迁移从 0 跑到最新）
 *   2. 迁移幂等（重跑不重复应用、不报错）
 *   3. Seed Identity 写入且可读回
 *   4. Seed 内容变了但版本没变 → 必须被拒（铁律 2）
 *   5. 序号原子分配：并发分配不撞号
 *   6. ConversationEvent append-only：同序号重复写 = 幂等命中，不是第二行
 *   7. DomainEvent + Projection 单事务：事件与投影版本同时前进
 *   8. 乐观锁：旧 revision 写入必须抛 revision_conflict
 *
 * ⚠️ 本脚本会写库，因此**必须**在独立副本上运行（src/dev/sandbox.ts 的三层防护）。
 *
 * 跑法：node_modules/.bin/tsx scripts/verify-phase-c.ts
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

// 必须在任何会碰数据库的 import 之前
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('verify-phase-c')


import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import {
  appendConversationEvent,
  countConversationEvents,
  recentConversationEvents,
} from '../src/infrastructure/persistence/conversation-store.ts'
import { applyAcceptedEvents, getProjection, saveProjection } from '../src/infrastructure/persistence/event-store.ts'
import { allocateSequenceRange } from '../src/infrastructure/persistence/sequence.ts'
import { SEED_VERSION } from '../src/kernel/identity/seed.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import {
  KernelError,
  asConversationId,
  createProposal,
} from '../src/kernel/contracts/index.ts'
import { DIAGNOSTIC_PROJECTION_TYPE } from '../src/kernel/projections/diagnostic.ts'
import { assertValidatorAccepted } from '../src/kernel/policies/validator.ts'

// ---------------------------------------------------------------------------
// mini 断言（与 scripts/run-tests.ts 风格一致，但不复用它的运行时装配）
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
const dbReady = await initDatabase(runtime)
const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character) })
const db = kernel.stores.db
const characterId = kernel.characterId

section('1. 空库 → 最新 schema')
check('迁移跑到最新版本', dbReady.kernelSchemaVersion >= 2, `version=${dbReady.kernelSchemaVersion}`)
check('Seed 首次建档', kernel.seedCreated === true)
check(
  'Seed 版本正确',
  kernel.definition.seedVersion === SEED_VERSION,
  `v${kernel.definition.seedVersion} / ${kernel.definition.name}`
)

const expectedTables = [
  'character_definitions',
  'conversation_events',
  'character_domain_events',
  'character_projections',
  'character_jobs',
  'character_traces',
  'character_sequence_counters',
  'processed_operations',
  'processor_watermarks',
  'character_schema_migrations',
]
const tableRows = (
  (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public'`
  )) as { rows?: { table_name: string }[] }
).rows ?? []
const tableNames = tableRows.map((r) => r.table_name)
const missing = expectedTables.filter((t) => !tableNames.includes(t))
check('九张新表 + 迁移表全部存在', missing.length === 0, missing.length ? `缺少 ${missing.join(', ')}` : `${tableNames.length} 张表`)

section('2. 迁移幂等')
const k2 = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character) })
check('重跑 initKernel 不新建 Seed', k2.seedCreated === false)
const definitionCount = (
  (await db.execute(sql`select count(*)::int as c from character_definitions`)) as {
    rows?: { c: number }[]
  }
).rows?.[0]?.c
check('Seed 只有一行', Number(definitionCount) === 1, `count=${definitionCount}`)

section('3. Seed 变更必须升版本')
let rejected = false
try {
  await initKernel(runtime, {
    definition: {
      ...characterDefinitionFromCharacter(character),
      identity: {
        selfDescription: '被偷偷改过的身份',
        roleDescription: '测试用：内容变了但版本没变',
      },
    },
  })
} catch (error) {
  rejected = error instanceof KernelError && error.code === 'seed_changed_without_version_bump'
}
check('内容变了但版本没变 → 被拒', rejected)

let regressionRejected = false
try {
  await initKernel(runtime, {
    definition: {
      ...characterDefinitionFromCharacter(character),
      seedVersion: 1,
      identity: { selfDescription: '旧版本的身份文本' },
    },
  })
} catch (error) {
  regressionRejected =
    error instanceof KernelError && error.code === 'seed_version_regression'
}
check('版本回退 → 被拒', regressionRejected)

section('4. 序号原子分配')
const range = await allocateSequenceRange(db, characterId, 3)
check('区间分配连续', range.end - range.start === 2, `[${range.start}, ${range.end}]`)

// 并发分配：PGlite 单连接，但 on-conflict do update 的原子性不依赖连接数
const concurrent = await Promise.all(
  Array.from({ length: 20 }, () => allocateSequenceRange(db, characterId, 1))
)
const sequences = concurrent.map((r) => r.start).sort((a, b) => a - b)
const uniqueSequences = new Set(sequences)
check(
  '20 次并发分配无重号',
  uniqueSequences.size === 20,
  `唯一 ${uniqueSequences.size} / 20`
)
check(
  '并发分配严格递增无空洞',
  sequences[19] - sequences[0] === 19,
  `[${sequences[0]}, ${sequences[19]}]`
)

section('5. ConversationEvent append-only + 幂等')
const conversationId = asConversationId(`dm:${String(characterId)}:test`)

const first = await appendConversationEvent(db, {
  characterId,
  conversationId,
  conversationSequence: 1,
  type: 'user_message',
  actorType: 'user',
  actorId: 'user-test',
  content: '你好，苏沐薇。',
})
check('首次写入成功', first.appended === true, `sequence=${first.event.sequence}`)

const duplicate = await appendConversationEvent(db, {
  characterId,
  conversationId,
  conversationSequence: 1,
  type: 'user_message',
  actorType: 'user',
  actorId: 'user-test',
  content: '你好，苏沐薇。',
})
check(
  '同会话序号重复写入 = 幂等命中',
  duplicate.appended === false && duplicate.event.id === first.event.id,
  `id=${duplicate.event.id}`
)

const second = await appendConversationEvent(db, {
  characterId,
  conversationId,
  conversationSequence: 2,
  type: 'assistant_message',
  actorType: 'character',
  actorId: String(characterId),
  content: '你来了。',
  replyToEventId: first.event.id,
})
check(
  '角色级序号严格递增',
  second.event.sequence === first.event.sequence + 1,
  `${first.event.sequence} → ${second.event.sequence}`
)

const total = await countConversationEvents(db, characterId)
check('事件总数 = 2（重复没有产生第三行）', total === 2, `count=${total}`)

const recent = await recentConversationEvents(db, { characterId, limit: 10 })
check(
  '最近事件按序号升序返回',
  recent.length === 2 && recent[0].sequence < recent[1].sequence,
  recent.map((e) => e.sequence).join(',')
)

section('6. 来源一致性：assistant 事件不能冒充 user')
let mismatchRejected = false
try {
  await appendConversationEvent(db, {
    characterId,
    conversationId,
    conversationSequence: 3,
    type: 'user_message',
    actorType: 'character', // 伪造来源
    content: '我猜你喜欢猫。',
  })
} catch (error) {
  mismatchRejected = error instanceof KernelError && error.code === 'actor_type_mismatch'
}
check('actorType 与 type 不符 → 被拒（铁律 5 第一道闸）', mismatchRejected)

section('7. 单事务：DomainEvent + Projection 同步前进')
const proposal = createProposal({
  characterId,
  proposalType: 'diagnostic-signal',
  sourceConversationEventIds: [first.event.id],
  payload: { note: '验证链路' },
  targetEvents: [{ type: 'TEST_CHARACTER_SIGNAL', operation: 'signal', payload: { counterDelta: 1 } }],
  processor: 'verify-phase-c',
  processorVersion: 'verify-phase-c@1',
})

const outcome = await kernel.validator.validate(proposal)
const accepted = assertValidatorAccepted(outcome)

const applied = await applyAcceptedEvents(db, characterId, accepted, kernel.reducers)
check('产生 1 个 DomainEvent', applied.createdCount === 1)
check('投影 revision 前进', applied.projectionChanges.length === 1, JSON.stringify(applied.projectionChanges))

const projection = await getProjection<{ counter: number }>(
  db,
  characterId,
  DIAGNOSTIC_PROJECTION_TYPE
)
check('投影状态正确', projection?.state.counter === 1, JSON.stringify(projection?.state))
check('投影记录了最后事件序号', (projection?.lastDomainEventSequence ?? 0) > 0)

section('8. 幂等：同一提案处理两次只有一次生效')
const applied2 = await applyAcceptedEvents(db, characterId, accepted, kernel.reducers)
check('第二次全部幂等命中', applied2.createdCount === 0 && applied2.deduplicatedCount === 1)

const projection2 = await getProjection<{ counter: number }>(
  db,
  characterId,
  DIAGNOSTIC_PROJECTION_TYPE
)
check('计数器没有变成 2（SC-004 的核心）', projection2?.state.counter === 1, `counter=${projection2?.state.counter}`)

section('9. 乐观锁：旧 revision 不允许覆盖新状态')
let conflictRejected = false
try {
  await saveProjection(
    db,
    {
      characterId,
      projectionType: DIAGNOSTIC_PROJECTION_TYPE,
      revision: (projection2?.revision ?? 0) + 5,
      reducerVersion: projection2!.reducerVersion,
      lastDomainEventId: projection2?.lastDomainEventId,
      lastDomainEventSequence: projection2?.lastDomainEventSequence,
      state: { counter: 999, payloadBytes: 0 },
      updatedAt: Date.now(),
    },
    0 // 故意用一个过期 revision
  )
} catch (error) {
  conflictRejected = error instanceof KernelError && error.kind === 'revision_conflict'
}
check('过期 revision 写入 → revision_conflict', conflictRejected)

const projection3 = await getProjection<{ counter: number }>(
  db,
  characterId,
  DIAGNOSTIC_PROJECTION_TYPE
)
check('冲突后状态未被污染', projection3?.state.counter === 1, `counter=${projection3?.state.counter}`)

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(64)}`)
console.log(`Phase C 结果：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
console.log('='.repeat(64))

await runtime.stop()
process.exit(failed === 0 ? 0 : 1)
